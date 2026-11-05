/*
 * video-switch.js — **已缓存壁纸的切换手感**：常驻双元素池 / 首帧预热 / 点击反馈 / 切换度量。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────────────
 * 用户实测：「点已下载好的壁纸会卡一下才播，Wallpaper Engine 切换很流畅」。
 * 实测把这条主观描述拆成**两条独立的成本**，它们必须在同一处被量出来，否则改一处
 * 就会被另一处盖掉：
 *
 *   ① **元素重建**（恒在）：`src/live-layer.js` 的 `layerWantKey()` 把 `selection.url`
 *      算进层键 ⇒ 换一张视频壁纸键必变 ⇒ 旧层让出 `LAYER_ID` ⇒ `obtainLayerNode()`
 *      新建 div ⇒ `buildVideoMedia()` 新建 `<video>`。于是**资源选择 → 取 moov →
 *      解复用器初始化 → 首帧解码**整段都压在点击的关键路径上。
 *      （`src/media-prep.js` 对视频档**故意**不跑准备链，所以 `consumePreparedMedia`
 *       在手动点击时恒为 null —— 这条后门对视频档实际是关着的。）
 *
 *   ② **缓存族不命中**（条件性，但离群最大）：`lib/routes/downloads.js` 的
 *      `libraryDest()` 拿**最终 URL 的 basename** 做散列，原画 `x.mp4` 与 1080p
 *      `x-1080p.mp4` 是两条独立缓存。于是「已经下好了」的壁纸可能仍然 `local:false`
 *      ⇒ `mediaProxy` 回落到 `/folia/site-media/` 代理 ⇒ 走一次 客户端→宿主→上游
 *      的 HTTP 中继，甚至重新入队。
 *
 * ── 本文件拥有的东西 ──────────────────────────────────────────────────────────
 *   · **常驻双元素池**：一对长生命周期的 `<video>`（`we-pool-1` / `we-pool-2`），
 *     **永不再 `createElement("video")`**。可见的那个在屏上，另一个预热下一张的
 *     **首帧**（不是只到 metadata —— 那正是 `video-layer.js` 预热槽位止步的地方）。
 *     切换时把预热好的元素**整体搬进新层**：同文档内 reparent `<video>` 不重载
 *     （iframe 才会），元素身份不变、解码器连续、首帧已在 ⇒ `play()` 即出画。
 *   · **切换状态机**：`idle → priming → preloading → swapping → playing`
 *     （超时进 `buffering`，失败进 `failed`）。键盘 / 滚轮 / 「下一张」全部走**同一条**
 *     `weSwitchBegin()`，不另写一套。
 *   · **点击反馈**：按下即同步置 pressed / `aria-busy`，并记录 `clickFeedbackMs`。
 *   · **度量**：`switchLatencyMs` / `clickFeedbackMs` / `cacheFamilyHit` / `is1080p`
 *     四字段的环形缓冲（最近 20 次），同时打 console 与上报
 *     `POST /folia/diag/switch-stats`（宿主侧 `/folia/diag/switch-stats` 读回）。
 *   · **掉帧提示**：`requestVideoFrameCallback` 统计出 < 24fps 且持续 2s ⇒ 置
 *     `weSwitchJank`，面板据此提示「建议切换 1080p」。
 *
 * ── 不变量（改动前先读，都是踩过的坑）─────────────────────────────────────────
 *   ① **绝不在"已上屏"的元素上换 src**。换源会清掉当前帧 ⇒ 屏上只剩层底色（纯色帧）。
 *      `src/video-layer.js` 的 `layerStillPending()` 与
 *      `test/verify-transcode-state.mjs` 都在盯着这条。本文件的做法是：
 *      换 src 只发生在**不在屏上**的池元素上（它此刻在预热）。
 *   ② **同一 src 已加载就绝不重复 `load()`**：同值重启资源选择等于白跑一次取数。
 *      判据在 `weSwitchArm()`：`el.__weUrl === url && readyState >= 1` ⇒ 直接复用。
 *   ③ **池容量恒为 2**：第三个解码器一律不建（`test/verify-switch-smooth.mjs` 数
 *      `createElement("video")` 的调用次数）。旧元素在淡出**之后**才回到池里复用。
 *   ④ **本文件零顶层可执行语句**：它会被 `scripts/build-client.mjs` 内联到 bundle
 *      顶部，顶层读别的模块的 `const` 会撞 TDZ（见 docs/CODE-STRUCTURE.md §5）。
 *      所有跨模块调用（`apiPostJson` / `liveLog`）都只在**函数体里**发生。
 */

// ── 常量（全部是用户感知口径，不是内部实现细节）──────────────────────────────
// 交叉淡入时长：150–250ms 是需求区间，取中值。短于此观感是"跳变"，长于此会被
// 当成"又卡了一下"——两个方向都坏。
const WE_SWITCH_FADE_MS = 200;
// 缓冲提示阈值（4.23.12：1500 → **300**）。
// 用户口径改了：**300ms 没出帧就算"慢"**，必须当场告诉他"在缓冲，别以为没点上"。
// 1.5s 的旧值意味着一次 8 秒的首帧里有 1.5 秒是**完全静默**的 —— 那正是"点了没反应"。
const WE_SWITCH_BUFFER_HINT_MS = 300;
// 缓冲进度的轮询间隔（读 `/folia/downloads/list` 的 received/total）。
// 500ms：既能让"x%（a/b MB）"看起来在动，又不会把宿主的列表接口打成热点。
const WE_SWITCH_PROGRESS_POLL_MS = 500;
// **终态保证**（4.23.12）：点击后这么久还停在 priming/preloading 且**没有装上任何播放器**
// ⇒ 说明这条分支根本没有结算腿（最典型：场景/网页壁纸走了 `applySelection` 的早退，
// 而非视频的结算点就写在早退之后）。这时必须自己收口，否则 `weSwitchBusy()` 恒真，
// **之后每一次点击都被连点防护吞掉** —— 用户看到的就是"场景壁纸点了完全没反应"。
const WE_SWITCH_SETTLE_GUARD_MS = 2500;
// 度量环形缓冲：只留最近 20 次（需求 D9）。
const WE_SWITCH_STATS_MAX = 20;
// 掉帧判定：< 24fps 且持续 2s（需求 D10）。
const WE_SWITCH_JANK_FPS = 24;
const WE_SWITCH_JANK_HOLD_MS = 2000;
// 池容量：恒为 2（可见 + 预热）。绝不再大 —— 每个元素是一个解码器。
const WE_SWITCH_POOL_SIZE = 2;
// pressed 态的**视觉兜底**复位：切换失败/没人收尾时别让卡片永久"按着"。
// ⚠️ 它只复位**视觉**，不结算状态机 —— 慢切换是合法的（未缓存的源本来就慢），
//    到点就把上下文结算掉会让「正在缓冲 x%」这条提示**永远来不及出现**
//   （1.2s 的视觉兜底 < 1.5s 的缓冲阈值，实测就是这么互相打架的）。
const WE_SWITCH_PRESS_MS = 1200;
// 状态机硬上限：真正的"永远等不到"必须收口，否则连点会被永久挡住。
// 取值远大于缓冲阈值，让缓冲提示有充分的展示窗口。
// 状态机硬上限（4.23.12：15000 → **5000**）。
// 为什么收短：这是"结算腿断了"的最后一道兜底，而 `weSwitchBusy()` 在这段时间里会挡住/影响
// 后续点击的观感。15s 的上限意味着一次漏结算 = 用户 15 秒内点哪都没反应；
// 5s 与实测的慢首帧（4K60 ≈ 6–9s）仍然同量级，但**不会**把"点了没反应"放大成一个半屏的沉默。
// 收口记 `reason:'busy-timeout'`，便于在 `/folia/diag/switch-stats` 里一眼认出这一类。
const WE_SWITCH_HARD_MS = 5000;

/**
 * 4.23.23：**download-first 的「海报 → 本地视频」交叉淡入**标记。
 *
 * 那条路径上在屏的是静态海报 `<img>`、没有可对齐的 `<video>`，用不了 `weSwitchHandoverLocal`
 * 的时间对齐；但"新层有首帧才放行"的内容闸门仍然有效 —— 只需把这次内部重建强制走 **fade**
 * （用户的过场设置可能是"硬切"，而那张海报与首帧之间硬切会闪一下）。
 * `syncLayers` 消费一次即清（见 live-layer.js），不改变用户的持久化设置。
 */
let weSwitchPendingFade = false;
function weSwitchRequestFade() { weSwitchPendingFade = true; }
function weSwitchConsumeFade() {
  const v = weSwitchPendingFade;
  weSwitchPendingFade = false;
  return v;
}

// ── 池与状态 ──────────────────────────────────────────────────────────────────
const weSwitchPool = [];          // [{ id, el }] 长度恒 ≤ WE_SWITCH_POOL_SIZE
let weSwitchVisibleEl = null;   // 此刻在屏上的那个池元素（== LAYER_ID 层里的 video）
let weSwitchCtx = null;         // 本次切换的上下文（状态机 / 计时）
const weSwitchStats = [];         // 最近 20 条度量
let weSwitchJank = null;        // { fps, at } 掉帧结论（空 = 无结论）
let weSwitchJankSeen = { fps: 0, since: 0 };

/** 池元素 → "它在不在屏上"。测试与回收都用它。 */
function weSwitchIsVisible(el) {
  return Boolean(el) && el === weSwitchVisibleEl;
}

/**
 * 造一个池元素。**这是本仓库唯一允许 `createElement("video")` 的壁纸播放器入口**
 *（`video-layer.js` 的 `buildVideoMedia` 已改为向池申请，不再自建）。
 */
function weSwitchNewPlayer(slot) {
  let el;
  try { el = document.createElement("video"); } catch { return null; }
  if (!el) return null;
  const id = "we-pool-" + String(slot + 1);
  try { el.dataset.wePlayerId = id; } catch { /* 精简 DOM 没有 dataset */ }
  // preload=auto 与 `video-layer.js` 的建层口径一致：moov 在文件尾部，缺省会取完
  // moov 就停，真正取帧要等 play()。
  try { el.preload = "auto"; } catch { /* ignore */ }
  try { el.muted = true; } catch { /* ignore */ }
  try { el.loop = true; } catch { /* ignore */ }
  try { el.autoplay = false; } catch { /* ignore */ }
  try { el.setAttribute("playsinline", ""); } catch { /* ignore */ }
  if (!el.__wePlayers) { try { el.__wePlayers = []; } catch { /* ignore */ } }
  return el;
}

/** 池惰性初始化：第一次申请时才建，最多两个。 */
function weSwitchPoolEnsure() {
  if (weSwitchPool.length >= WE_SWITCH_POOL_SIZE) return weSwitchPool;
  if (typeof document === "undefined" || typeof document.createElement !== "function") return weSwitchPool;
  for (let slot = weSwitchPool.length; slot < WE_SWITCH_POOL_SIZE; slot += 1) {
    const el = weSwitchNewPlayer(slot);
    if (el) weSwitchPool.push({ id: "we-pool-" + String(slot + 1), slot, el });
  }
  return weSwitchPool;
}

/**
 * 给某个 URL 挑一个池元素。
 *
 * 优先级（顺序即"切换能有多快"的顺序）：
 *   ① 已经预热好这个 URL 且**首帧已解**的 ⇒ 直接命中（最快：只剩 play）；
 *   ② 已经带着这个 URL（metadata 到位）的 ⇒ 续用，不重设 src；
 *   ③ **还没装任何 URL** 的空闲元素（第一次用池时的常态）；
 *   ④ 不在屏上、但装着**别的** URL 的（拿它换源 —— 它不在屏上，换源安全）。
 *   ⑤ 全都占着且都在屏上（只可能是"旧层还没淡完"）⇒ 仍返回一个不在屏上的：
 *      宁可复用也不能新建（不变量 ③）。
 *
 * ⚠️ ③ 必须排在 ④ 前面：否则连着为两张不同的壁纸申请时，第二张会拿到**刚被第一张
 * 占用的那个元素**，两次申请返回同一个节点（H11「同一玩家实例不被替换」直接失效，
 * 而且第一张的预热白做）。这条是实测出来的缺陷，别按"反正都是池元素"糊过去。
 */
function weSwitchPoolPick(url) {
  const pool = weSwitchPoolEnsure();
  const u = String(url || "");
  const visible = weSwitchVisibleEl;
  // ①②：同一个 URL 的元素
  let sameMeta = null;
  for (const p of pool) {
    if (!p || !p.el) continue;
    if (String(p.el.__weUrl || "") === u) {
      if (Number(p.el.readyState) >= 2) return p.el;       // ①
      if (!sameMeta) sameMeta = p.el;                       // ②
    }
  }
  if (sameMeta) return sameMeta;
  // ③：空元素（从未装过 URL），且不在屏上。
  //    选中即**登记 URL 占位**：否则连着为两张不同壁纸申请时会两次都返回同一个空元素
  //    （两次申请之间没有 arm 的话，第二个元素永远"看起来还是空的"）—— 那会让第一张的
  //    预热白做，也让 H11「同一玩家实例不被替换」失效。arm 会把它真正装上（`__weUrl`
  //    赋值 + `src` + `load()`），这里的登记只是"这一格有主了"。
  for (const p of pool) {
    if (p && p.el && p.el !== visible && !String(p.el.__weUrl || "")) {
      try { p.el.__weUrl = u; } catch { /* ignore */ }
      return p.el;
    }
  }
  // ④：装着别的 URL、不在屏上的
  for (const p of pool) {
    if (p && p.el && p.el !== visible) {
      try { p.el.__weUrl = u; } catch { /* ignore */ }
      return p.el;
    }
  }
  // ⑤：兜底（不该走到）
  return pool.length ? pool[0].el : null;
}

/**
 * 把一个池元素装到指定 URL 上，并把它推到"首帧已解"。
 *
 * ⚠️ 三条不变量在这里落地：
 *   · 同 URL 已加载 ⇒ **不重设 src、不 load()**（不变量 ②）；
 *   · 换 src 只发生在不在屏上的元素上（不变量 ①）—— 在屏的那个由调用方在
 *     `weSwitchPublish()` 之后才被换下来；
 *   · 装车即播（muted）：只有播起来 `requestVideoFrameCallback` 才会报首帧，
 *     隐藏态静音播放不产生声音，池容量 2 保证解码器数量与既有交叉淡化时相同。
 */
function weSwitchArm(el, url, posterUrl) {
  if (!el) return null;
  const u = String(url || "");
  if (!u) return el;
  // poster 幂等：同值不重设（重设会重新拉一次缩略图）。
  if (posterUrl && String(el.poster || "") !== String(posterUrl)) {
    try { el.poster = posterUrl; } catch { /* ignore */ }
  }
  // 这条地址**已经装在这个元素上**了吗？两种来源都算"已装"：
  //   · 池自己装的（`__weUrl`）；
  //   · 调用方刚赋过 `media.src`（`el.src`）—— `buildVideoMedia` 走的就是这条路。
  // 已装 ⇒ **绝不重复赋 src / load()**（需求 A5：同值重启资源选择等于白跑一次取数）。
  const same = String(el.__weUrl || "") === u || String(el.src || "") === u;
  if (!same) {
    // 不变量 ①：换源只允许发生在**不在屏上**的元素上（在屏换源 = 清掉当前帧 = 纯色帧）。
    if (weSwitchIsVisible(el)) return el;
    try {
      el.__weUrl = u;
      el.__weReady = false;
      el.src = u;
    } catch { return el; }
    /**
     * 4.24.0（P0-B）：**新源不继承上一条的播放判决**。池元素是复用的，`wePlayRefused`
     * （"浏览器拒绝了播放请求"）与 `wePlayAbortRetried`（AbortError 只重载一次）都是**元素级**
     * 标记；不在这里清，B 会背着 A 的失败文案上屏（用户实测的"换了壁纸还显示上一张的错误"）。
     */
    try {
      if (el.dataset) { delete el.dataset.wePlayRefused; delete el.dataset.wePlayAbortRetried; }
    } catch { /* ignore */ }
    try { if (typeof el.load === "function") el.load(); } catch { /* ignore */ }
  }
  try { el.__weUrl = u; } catch { /* ignore */ }
  // 首帧预热：已可播就直接标记；否则只为**还没排过**的元素排监听（`weSwitchArmFirstFrame`
  // 内部按 readyState 判，重复调用是幂等的 —— 它不会堆监听）。
  if (Number(el.readyState) >= 2) { try { el.__weReady = true; } catch { /* ignore */ } }
  else weSwitchArmFirstFrame(el);
  try { el.preload = "auto"; } catch { /* ignore */ }
  try { el.muted = true; } catch { /* ignore */ }
  // 隐藏态先播起来：首帧解码要发生，就必须有播放推进（rVFC 只在出帧时回调）。
  try {
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* 可见后 syncLayers 会补 play */ });
  } catch { /* ignore */ }
  return el;
}

/** 等"首帧真的解出来了"：rVFC 优先；退化到 loadeddata/canplay（readyState ≥ 2）。 */
function weSwitchArmFirstFrame(el) {
  if (!el) return;
  if (Number(el.readyState) >= 2) { try { el.__weReady = true; } catch { /* ignore */ } return; }
  // 幂等：同一个元素只排一次首帧监听。`syncLayers` 每次 emit 都会重新走建层/同步，
  // 不设这道闸就会越挂越多监听（每个都指向同一个回调，白白放大一次切换的开销）。
  if (el.__weArming) return;
  try { el.__weArming = true; } catch { /* ignore */ }
  const done = (extra) => {
    try { el.__weReady = true; el.__weArming = false; } catch { /* ignore */ }
    if (typeof extra === "function") extra();
    weSwitchOnFirstFrame(el);
  };
  if (typeof el.requestVideoFrameCallback === "function") {
    try {
      el.__weRaf = el.requestVideoFrameCallback(() => {
        try { el.__weRaf = 0; } catch { /* ignore */ }
        done();
      });
      return;
    } catch { /* 退化到事件 */ }
  }
  if (typeof el.addEventListener === "function") {
    const onData = () => done();
    try { el.addEventListener("loadeddata", onData, { once: true }); } catch { /* ignore */ }
    try { el.addEventListener("canplay", onData, { once: true }); } catch { /* ignore */ }
    return;
  }
  // 既无 rVFC 也无事件设施（精简 DOM / 挂载台）：直接当"已有一帧"，不拦切换。
  done();
}

/**
 * 首帧到了：如果它就是本次切换等待的那个元素，推进状态机。
 * Edge 兼容那条腿（镜像画布）另有画布首笔的判据，不在这里。
 */
function weSwitchOnFirstFrame(el) {
  const ctx = weSwitchCtx;
  if (!ctx) return;
  if (ctx.pendingEl && ctx.pendingEl === el) {
    weSwitchSetState(ctx, "swapping");
  }
}

function weSwitchSetState(ctx, next) {
  if (!ctx) return ctx;
  ctx.state = next;
  return ctx;
}

/**
 * **用户点击驱动**的切换才池化。
 *
 * 为什么只认点击：轮换（`beginRotationPrepare` → `commitRotationSwitch`）、启动恢复、
 * revalidate 这三条路径各有**自己的就绪判据与 smoke 判据**
 *（`rotation-live-smoke` / `rotation-prepared-leak-smoke` / `rotation-smoke`），
 * 它们的既有契约是"视频档每层新建一个 `<video>`、且**不预热**"—— 那条契约当初是为了
 * 避开双解码与「GIF→静图→正片」的观感，不是疏漏。用户这次报的"点已缓存壁纸卡一下"
 * 走的是**点击**这条路，所以池化只接这条路：既修好报告的场景，又不改轮换的判据与观感。
 *
 * 返回 null = 这一趟不池化，调用方走它原来的建元素路径。
 */
function weSwitchClickPlayer(url) {
  const ctx = weSwitchCtx;
  if (!ctx || ctx.settled) return null;   // 没有点击上下文 ⇒ 轮换/恢复 ⇒ 不池化
  return weSwitchPoolPick(url);
}

/**
 * 非点击路径（轮换/恢复/revalidate）用的**一次性**播放器。
 *
 * 存在的唯一理由是"创生点只有一处"：`document.createElement("video")` 住在池里，
 * 别处不许再造 —— 否则"谁建了解码器"又散开了，成因 ① 的构造点会悄悄长回来。
 * 它**不进池、不复用**，语义与建层前的旧实现逐字等价。
 */
function weSwitchDetachedPlayer() {
  const el = weSwitchNewPlayer(-1);
  if (el) { try { el.dataset.wePlayerId = "we-detached"; } catch { /* ignore */ } }
  return el;
}
// ── 缓冲提示：文案（纯函数）+ 覆盖层 ──────────────────────────────────────────
/**
 * 缓冲提示文案。**纯函数**（判据直接喂数字断言，不碰 DOM）。
 *
 * 格式（需求 B）：`缓冲中 x%（a/b MB · 约剩 N 秒）`
 *   · 总量未知 ⇒ 只给「缓冲中…」（**绝不编数字**）；
 *   · 没有速度样本（`etaSec <= 0`）⇒ 省掉"约剩 N 秒"那一截（同上）。
 */
function weSwitchBufferHintText(recv, total, etaSec) {
  const r = Math.max(0, Number(recv) || 0);
  const t = Math.max(0, Number(total) || 0);
  const pct = t > 0 ? Math.max(0, Math.min(100, Math.round((r / t) * 100))) : 0;
  if (!(total > 0)) return "缓冲中…";
  const a = (r / 1048576).toFixed(1);
  const b = (t / 1048576).toFixed(1);
  const s = Math.max(0, Math.round(Number(etaSec) || 0));
  return s > 0
    ? "缓冲中 " + pct + "%（" + a + "/" + b + " MB · 约剩 " + s + " 秒）"
    : "缓冲中 " + pct + "%（" + a + "/" + b + " MB）";
}

/**
 * **4.24.0（P0-A）：居中浮层已退役**。
 *
 * 用户实测：点壁纸后屏幕中间弹出一块「正在缓存 27%（12.9/48.5 MB · 约剩 6 秒）」，
 * 压在壁纸画面正中，像报错浮层。要求是**缓存进度只出现在标题栏的元信息区**（与
 * 「缓存命中 / 首次下载 / 平均速度」同一行），卡片角标照旧带小进度条。
 *
 * 因此这里**不再创建任何 DOM**（判据：页面里不存在 `.we-switch-hint`、不存在
 * `position:fixed` 的居中提示节点）。进度文案仍由 `weSwitchBufferHintText()` 产出、
 * 由状态机写进 `selection.mediaNote`（面板当前壁纸那一行）与 `wpTitleRender()`
 * （快捷面板标题栏的元信息行）—— 两处都是**行内**布局。
 *
 * 保留这两个函数名是为了不破坏既有调用点（它们现在是纯状态写入，零 DOM、零布局影响）。
 */
let weSwitchHintLast = "";

/** 记录最近一次缓冲提示（排障/测试读；**不建节点、不显示**）。 */
function weSwitchOverlaySet(text) {
  weSwitchHintLast = String(text || "");
}

/** 清掉最近一次提示（幂等）。 */
function weSwitchOverlayHide() {
  weSwitchHintLast = "";
}

/** 最近一次缓冲提示（"" = 没有）。诊断读数，纯读。 */
function weSwitchHintTextOf() {
  return weSwitchHintLast;
}

// ── 切换度量 ──────────────────────────────────────────────────────────────────

function weSwitchNow() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  } catch { /* ignore */ }
  return Date.now();
}

/**
 * 记一条切换度量：console + 宿主环形缓冲。
 *
 * 字段口径（需求 D9 + I）：
 *   slug           这张壁纸的身份（用 URL 末段，排障要对得上）
 *   cacheFamilyHit 是否走了缓存族命中（原画/1080p 任一已落地）—— **区分成因 ① 与 ② 的唯一字段**
 *   is1080p        播放的是不是 1080p 变体
 *   switchLatencyMs 点击 → 首帧可见
 *   clickFeedbackMs 点击 → 第一处视觉变化
 */
function weSwitchRecord(entry) {
  const rec = Object.assign({ at: Date.now() }, entry || {});
  weSwitchStats.push(rec);
  while (weSwitchStats.length > WE_SWITCH_STATS_MAX) weSwitchStats.shift();
  try {
    console.log("[folia-switch] " + JSON.stringify(rec));
  } catch { /* 控制台不可用不影响切换 */ }
  try {
    // 宿主侧环形缓冲（`GET /folia/diag/switch-stats` 读回）。失败静默：度量是增强。
    const p = apiPostJson("/diag/switch-stats", rec);
    if (p && typeof p.catch === "function") p.catch(() => { /* ignore */ });
  } catch { /* ignore */ }
  return rec;
}

/** 最近 20 条度量的只读快照（面板 / 守卫读它）。 */
function weSwitchStatsSnapshot() {
  return weSwitchStats.map((r) => Object.assign({}, r));
}

/** 均值 / 最大值（需求 I：clickFeedbackMs 均值 + 最大值）。 */
function weSwitchStatSummary() {
  const agg = (key) => {
    const xs = weSwitchStats.map((r) => Number(r[key])).filter((n) => Number.isFinite(n) && n >= 0);
    if (!xs.length) return { n: 0, avg: 0, max: 0 };
    const sum = xs.reduce((a, b) => a + b, 0);
    return { n: xs.length, avg: Math.round(sum / xs.length), max: Math.round(Math.max.apply(null, xs)) };
  };
  return {
    switchLatencyMs: agg("switchLatencyMs"),
    clickFeedbackMs: agg("clickFeedbackMs"),
    total: weSwitchStats.length,
  };
}

function weSwitchSlugOf(url) {
  const s = String(url || "");
  const at = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return (at >= 0 ? s.slice(at + 1) : s).split("?")[0].slice(-48) || "-";
}

/** 这条播放地址是不是 1080p 变体（站点变体 URL 通常带 `-1080p` 段）。 */
function weSwitchIs1080p(url) {
  return /(?:^|[-_.])(?:1080p?|fhd)(?:[-_.]|$)/i.test(String(url || ""));
}

// ── 点击反馈（需求 G1–G7：按下即响应，不等任何请求）─────────────────────────

/**
 * 点击瞬间的同步反馈。**必须在 `applySelection()` 之前**调用。
 *
 * 为什么必须同步：任何 `await` / 任何 fetch 都会把第一处视觉变化推到下一帧之后，
 * 用户就开始怀疑"点没点上"。这里只做三件纯 DOM 的事（无网络、无状态推断）：
 *   · 卡片加 `we-qp__item--pressed`（缩放/高亮由 CSS 给）；
 *   · 卡片置 `aria-busy="true"`（无障碍：读屏软件会播报"忙碌"）；
 *   · 记 `clickFeedbackMs` = 到"第一处视觉变化"的耗时（同步 ⇒ 实测 < 1ms）。
 */
function weSwitchBegin(el) {
  // **last-click-wins（4.23.12，P0 的关键那一半）**：上一次切换还没结算时又来一次点击，
  // 说明用户已经不想等前一张了 —— **立刻把它收口**（记 `superseded`），然后开新的一轮。
  //
  // 为什么不是"忽略这一次"（旧实现）：忽略的前提是"前一次必然会在可接受的时间内结算"。
  // 实测否证了这个前提 —— 慢视频的首帧要 6–9 秒，而这一段时间里用户去点「本机」里的场景壁纸
  // 就被判成"正在切换，请稍候"而**完全没反应**。用户的结论是"连本机都不能点了"。
  // 取消式没有死锁风险：旧上下文被置为 failed/settled 之后，busy 立刻变假。
  const prev = weSwitchCtx;
  if (prev && !prev.settled) {
    try { weSwitchFail("superseded"); } catch { /* 收口失败也要继续开新的 */ }
  }
  if (weSwitchPending) weSwitchPending = null;   // 旧实现的"补切最后一个"不再参与（取消式取代）
  // 新一轮切换开始：上一张的"等本地副本"到此为止（它已经不在屏上了）。
  weSwitchStopLocalWatch();
  // 复用 ptrdown 那一枪的视觉反馈（如果有）：同一次点击只该量一段"点击 → 第一处视觉变化"。
  const pressed = weSwitchConsumePress();
  const t0 = (pressed && pressed.at) || weSwitchNow();
  const target = el || (pressed && pressed.el) || null;
  if (target && target.classList && typeof target.classList.add === "function") {
    try { target.classList.add("we-qp__item--pressed"); } catch { /* ignore */ }
  }
  if (target && typeof target.setAttribute === "function") {
    try { target.setAttribute("aria-busy", "true"); } catch { /* ignore */ }
  }
  const feedbackMs = (pressed && pressed.ms) || 0;
  const ctx = {
    startedAt: t0, feedbackMs: (pressed && pressed.ms) || 0, state: "priming",
    cardEl: target, pendingEl: null, bufferTimer: 0, pressTimer: 0, hardTimer: 0, settleGuard: 0,
    slug: "-", cacheFamilyHit: false, is1080p: false, settled: false,
    // 4.23.12：这次点的是哪一类（video / scene / web / image）。度量与排障都要它 ——
    // "某一类点了没反应"在延迟直方图上只表现为"恰好 15s"，没有 kind 就分不出是谁。
    kind: "unknown",
    // 4.23.12：本条壁纸的**站点原始地址**（下载/进度都用它，不是播放代理地址）。
    originUrl: "", bytesRecv: 0, bytesTotal: 0, etaSec: 0, progressPoll: 0, progressLast: null,
  };
  weSwitchCtx = ctx;
  if (typeof setTimeout === "function") {
    // 视觉兜底：只摘 pressed / aria-busy，**不结算**（见 WE_SWITCH_PRESS_MS 的注释）。
    ctx.pressTimer = setTimeout(() => { weSwitchResetCard(ctx); }, WE_SWITCH_PRESS_MS);
    // 缓冲提示：**300ms** 还没进到可播状态 ⇒ 转 buffering、出「缓冲中 x%」并开始取进度。
    ctx.bufferTimer = setTimeout(() => {
      if (ctx.settled || weSwitchCtx !== ctx) return;
      if (ctx.state === "priming" || ctx.state === "preloading") {
        weSwitchSetState(ctx, "buffering");
        weSwitchOverlaySet(weSwitchBufferHintText(ctx.bytesRecv, ctx.bytesTotal, ctx.etaSec));
        weSwitchStartProgressPoll(ctx);
        weSwitchListens(ctx);
      }
    }, WE_SWITCH_BUFFER_HINT_MS);
    // **终态保证**（4.23.12，P0）：到点仍停在 priming 且**没有任何播放器被装上** ⇒
    // 这条分支没有结算腿（早退 / 异常 / 未知类型）。自己收口，绝不让"切换中"永久为真。
    // 已经有播放器（`pendingEl`）时不动它：视频档由首帧结算，最差由 15s 硬上限兜底。
    ctx.settleGuard = setTimeout(() => {
      if (ctx.settled || weSwitchCtx !== ctx) return;
      if (ctx.pendingEl) return;
      // priming（还没装）/ preloading（装了但没有元素）/ buffering（300ms 后转过来的那个）
      // 三种"没有任何播放器在等"的形态都必须收口。有元素时交给首帧与 5s 硬上限。
      if (ctx.state !== "priming" && ctx.state !== "preloading" && ctx.state !== "buffering") return;
      weSwitchSetState(ctx, "playing");
      weSwitchFinish(ctx, true, "no-media-branch");
    }, WE_SWITCH_SETTLE_GUARD_MS);
    // 硬上限：真正的"永远等不到"收口。
    ctx.hardTimer = setTimeout(() => {
      if (ctx.settled || weSwitchCtx !== ctx) return;
      weSwitchFail("busy-timeout");
    }, WE_SWITCH_HARD_MS);
  }
  return ctx;
}

/**
 * 缓冲期间的进度来源：`/folia/downloads/list` 里与 `originUrl` 匹配的那条 job。
 *
 * 为什么读队列而不是读 `<video>.buffered`：`buffered` 只回答"解码器手上有什么"，
 * 用户问的是"还要多久"——那是**下载**的事实（received / total），只有队列知道。
 * 取不到就保持"缓冲中…"（绝不编百分比）。
 */
function weSwitchStartProgressPoll(ctx) {
  if (!ctx || ctx.progressPoll) return;
  if (typeof setInterval !== "function") return;
  if (typeof apiJson !== "function") return;
  const tick = () => {
    if (ctx.settled || weSwitchCtx !== ctx) { weSwitchStopProgressPoll(ctx); return; }
    if (!ctx.originUrl) return;
    Promise.resolve()
      .then(() => apiJson("/downloads/list"))
      .then((res) => {
        const doc = (res && res.data) || res || {};
        const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
        const job = jobs.find((j) => j && String(j.url || "") === String(ctx.originUrl)) || null;
        if (!job) return;
        const recv = Math.max(0, Number(job.received) || 0);
        const total = Math.max(0, Number(job.total) || 0);
        // 速度样本：两次采样的字节差 / 时间差 ⇒ 约剩秒数（样本不足就不给）。
        const now = Date.now();
        const last = ctx.progressLast;
        if (last && now > last.at && recv > last.recv) {
          const bps = (recv - last.recv) / ((now - last.at) / 1000);
          if (bps > 0 && total > recv) ctx.etaSec = Math.round((total - recv) / bps);
        }
        ctx.progressLast = { at: now, recv };
        ctx.bytesRecv = recv;
        ctx.bytesTotal = total;
        weSwitchOverlaySet(weSwitchBufferHintText(recv, total, ctx.etaSec));
        weSwitchListens(ctx);
      })
      .catch(() => { /* 进度是增强：拿不到就保持上一帧文案 */ });
  };
  ctx.progressPoll = setInterval(tick, WE_SWITCH_PROGRESS_POLL_MS);
  try { if (ctx.progressPoll && typeof ctx.progressPoll.unref === "function") ctx.progressPoll.unref(); } catch { /* ignore */ }
  tick();
}

/** 停进度轮询（幂等：结算、失败、离开 buffering 都调）。 */
function weSwitchStopProgressPoll(ctx) {
  if (!ctx || !ctx.progressPoll) return;
  if (typeof clearInterval === "function") { try { clearInterval(ctx.progressPoll); } catch { /* ignore */ } }
  ctx.progressPoll = 0;
}

/** 摘掉卡片的 pressed / aria-busy（视觉复位；幂等，结算与兜底都调它）。 */
function weSwitchResetCard(ctx) {
  if (!ctx || !ctx.cardEl) return;
  try { if (ctx.cardEl.classList && ctx.cardEl.classList.remove) ctx.cardEl.classList.remove("we-qp__item--pressed"); } catch { /* ignore */ }
  try { if (ctx.cardEl.removeAttribute) ctx.cardEl.removeAttribute("aria-busy"); } catch { /* ignore */ }
}

/**
 * 缓冲提示 / 成功 / 失败的对外通知口：只**发事件**，不直接改 React 树
 *（客户端是单向 emit 重渲染，本文件不碰组件结构）。面板订阅它来画
 * 「正在缓冲 x%」/「已切换」toast / 失败原因 + 重试。
 */
const weSwitchListeners = [];

function weSwitchSubscribe(fn) {
  if (typeof fn !== "function") return () => {};
  weSwitchListeners.push(fn);
  return () => {
    const i = weSwitchListeners.indexOf(fn);
    if (i >= 0) weSwitchListeners.splice(i, 1);
  };
}

function weSwitchListens(ctx) {
  const ev = {
    state: ctx.state,
    slug: ctx.slug,
    kind: ctx.kind || "unknown",
    percent: ctx.bytesTotal > 0 ? Math.min(100, Math.round((ctx.bytesRecv / ctx.bytesTotal) * 100)) : 0,
    recvBytes: Math.max(0, Number(ctx.bytesRecv) || 0),
    totalBytes: Math.max(0, Number(ctx.bytesTotal) || 0),
    etaSec: Math.max(0, Number(ctx.etaSec) || 0),
    // 覆盖层上正在显示的那一行（面板若要自己画，直接用它，别各写一份格式化）。
    hint: weSwitchBufferHintText(ctx.bytesRecv, ctx.bytesTotal, ctx.etaSec),
    reason: ctx.reason || "",
    latencyMs: Number(ctx.latencyMs) || 0,
    feedbackMs: Number(ctx.feedbackMs) || 0,
  };
  for (const fn of weSwitchListeners.slice()) {
    try { fn(ev); } catch { /* 订阅者异常不许影响切换 */ }
  }
}

/** 让调用方把"这次要播哪个元素/哪条地址"告诉状态机（`buildVideoMedia` 调）。 */
function weSwitchAttachPlayer(el, url, opts) {
  const ctx = weSwitchCtx;
  const o = opts || {};
  if (!ctx) return null;
  ctx.pendingEl = el || null;
  ctx.slug = weSwitchSlugOf(url);
  ctx.is1080p = o.is1080p === true || weSwitchIs1080p(url);
  ctx.cacheFamilyHit = o.cacheFamilyHit === true;
  // 4.23.12：类型与站点原始地址（进度/切本地都要它）。
  if (o.kind) ctx.kind = String(o.kind);
  if (o.originUrl) ctx.originUrl = String(o.originUrl);
  if (!ctx.settled) weSwitchSetState(ctx, "preloading");
  // 已经进入 buffering 的上下文，装上播放器后进度轮询要能跟上（幂等）。
  if (ctx.state === "buffering") weSwitchStartProgressPoll(ctx);
  return ctx;
}

/** 元素上屏（`syncLayers` 把它挂进新层之后调）：推进到 swapping。 */
function weSwitchPublish(el, opts) {
  const o = opts || {};
  const ctx = weSwitchCtx;
  if (el) {
    weSwitchVisibleEl = el;
    weSwitchStartJankProbe(el);
  }
  // 首帧已上屏 ⇒ 缓冲提示立刻收掉（交叉淡入期间还挂着"缓冲中"是自相矛盾的观感）。
  weSwitchOverlayHide();
  if (ctx && !ctx.settled) {
    weSwitchStopProgressPoll(ctx);
    weSwitchSetState(ctx, "swapping");
    // **结算点前移**（4.23.12 / P0）：层一旦上屏（poster 或首帧已经挂进 DOM、交叉淡入开始），
    // 这一次切换对用户来说就"已经生效"了 —— 到此结算，**不等第一帧解码完成**。
    //
    // 旧行为：`o.fadeMs` 只在极少数调用点给过，`{}` 传来的那一次**根本不排结算**，于是
    // 状态机要一直等到 `weSwitchPlayed()` —— 而那条腿只在 `syncLayers` 里、`readyState >= 2`
    // 时才被调用，`syncLayers` 又要等一次 emit。实测结果就是 busy 窗口 = 首帧耗时 = 6–9 秒，
    // 这期间点别的（尤其"本机"里的场景壁纸）全部被连点防护吞掉 = 用户说的"点了没反应"。
    const at = ctx;
    const fade = Math.max(0, Number(o.fadeMs) || WE_SWITCH_FADE_MS);
    if (typeof setTimeout === "function") {
      setTimeout(() => { weSwitchFinish(at, true, ""); }, fade);
      return ctx;
    }
    weSwitchFinish(at, true, "");
    return ctx;
  }
  return ctx;
}

/** 首帧可见 ⇒ 收尾（成功走这里；失败走 `weSwitchFail`）。 */
function weSwitchPlayed(el) {
  const ctx = weSwitchCtx;
  if (!ctx || ctx.settled) return ctx;
  if (ctx.pendingEl && el && ctx.pendingEl !== el) return ctx;
  weSwitchSetState(ctx, "playing");
  weSwitchFinish(ctx, true, "");
  return ctx;
}

function weSwitchFail(reason) {
  const ctx = weSwitchCtx;
  if (!ctx) return null;
  weSwitchSetState(ctx, "failed");
  ctx.reason = String(reason || "unknown");
  weSwitchFinish(ctx, false, ctx.reason);
  return ctx;
}

/**
 * 收尾：清计时器、复位卡片、算 switchLatencyMs、记一条度量。
 * 幂等（连点/超时/失败都可能走到这里）。
 */
function weSwitchFinish(ctx, ok, reason) {
  if (!ctx || ctx.settled) return;
  ctx.settled = true;
  ctx.latencyMs = Math.max(0, weSwitchNow() - ctx.startedAt);
  if (typeof clearTimeout === "function") {
    if (ctx.pressTimer) { try { clearTimeout(ctx.pressTimer); } catch { /* ignore */ } }
    if (ctx.bufferTimer) { try { clearTimeout(ctx.bufferTimer); } catch { /* ignore */ } }
    if (ctx.hardTimer) { try { clearTimeout(ctx.hardTimer); } catch { /* ignore */ } }
    if (ctx.settleGuard) { try { clearTimeout(ctx.settleGuard); } catch { /* ignore */ } }
  }
  ctx.pressTimer = 0;
  ctx.bufferTimer = 0;
  ctx.hardTimer = 0;
  ctx.settleGuard = 0;
  weSwitchStopProgressPoll(ctx);
  // 结算即收提示：屏上要么已经有真画面，要么就有失败文案 —— 都不该再挂着"缓冲中"。
  weSwitchOverlayHide();
  weSwitchSetState(ctx, ok ? "playing" : "failed");
  // 卡片复位：pressed 摘掉、aria-busy 放下（需求 H14 / G4）。
  weSwitchResetCard(ctx);
  weSwitchRecord({
    slug: ctx.slug,
    kind: ctx.kind || "unknown",
    cacheFamilyHit: ctx.cacheFamilyHit === true,
    is1080p: ctx.is1080p === true,
    switchLatencyMs: Math.round(ctx.latencyMs),
    clickFeedbackMs: Math.round(ctx.feedbackMs || 0),
    ok: ok === true,
    reason: ok ? "" : String(reason || ctx.reason || ""),
  });
  weSwitchListens(ctx);
  if (weSwitchCtx === ctx) weSwitchCtx = null;
  // 视频档：首帧已上屏后开始等**本地副本**（下载完成就无缝切过去，需求 C）。
  // 非视频档没有 `<video>`，这条链自然不启动（`pendingEl` 为空）。
  if (ok === true && ctx.pendingEl) { try { weSwitchBeginLocalWatch(ctx); } catch { /* 增强 */ } }
  // 连点防护：上一轮结束了，补切"最后点的那个"（需求 G7）。放在清空上下文之后 ——
  // 补切会开启新的一轮，必须在 `weSwitchCtx` 已为空时进行，否则新上下文会被这里覆盖。
  weSwitchFlushPick();
}

// ── 掉帧探测（需求 D10：< 24fps 持续 2s ⇒ 建议切 1080p）──────────────────────

function weSwitchStartJankProbe(el) {
  if (!el || typeof el.requestVideoFrameCallback !== "function") return;
  weSwitchJankSeen = { fps: 0, since: 0, frames: 0, at: weSwitchNow() };
  const tick = () => {
    if (!el || el !== weSwitchVisibleEl) return;   // 换人了就停
    const now = weSwitchNow();
    const stat = weSwitchJankSeen;
    stat.frames += 1;
    const dt = now - stat.at;
    if (dt >= 1000) {
      const fps = Math.round((stat.frames * 1000) / dt);
      stat.frames = 0;
      stat.at = now;
      stat.fps = fps;
      if (fps > 0 && fps < WE_SWITCH_JANK_FPS) {
        if (!stat.since) stat.since = now;
        else if (now - stat.since >= WE_SWITCH_JANK_HOLD_MS) {
          weSwitchJank = { fps, at: Date.now() };
        }
      } else {
        stat.since = 0;
        weSwitchJank = null;
      }
    }
    try { el.requestVideoFrameCallback(tick); } catch { /* ignore */ }
  };
  try { el.requestVideoFrameCallback(tick); } catch { /* ignore */ }
}

/** 掉帧结论（空 = 正常）。面板据此出「建议切换 1080p」+ 按钮。 */
function weSwitchJankState() {
  return weSwitchJank ? Object.assign({}, weSwitchJank) : null;
}

/** 当前状态机状态（测试与面板读它）。 */
function weSwitchState() {
  return weSwitchCtx ? weSwitchCtx.state : "idle";
}

/** 切换进行中吗（连点防护与缓冲提示共用这一条判据）。 */
function weSwitchBusy() {
  return Boolean(weSwitchCtx) && !weSwitchCtx.settled;
}

/*
 * 连点防护（需求 G7 / H13）：切换进行中再点别的卡 **只保留最后一个**。
 *
 * 为什么是"保留最后一个"而不是"全部忽略"：用户的意图很明确 —— 他最后点的就是
 * 他想看的。全部忽略等于让最后那一下白点（还得再点一次）；而全部排队会让连点 3 下
 * 变成 3 次切换、连闪 3 下。**队列化最后一个**同时满足"不闪"与"最终落在用户想要的那张"。
 *
 * 规则对外可断言：连点 3 次 ⇒ 只多切 1 张（最后那张），且出现一句 toast
 *「正在切换，请稍候」（由调用方在 `weSwitchQueuePick` 返回 true 时发）。
 */
let weSwitchPending = null; // { id, fn }

function weSwitchQueuePick(id, fn) {
  if (!weSwitchBusy()) return false;
  weSwitchPending = { id: String(id == null ? "" : id), fn: typeof fn === "function" ? fn : null };
  return true;
}

/** 上一轮收尾后补切"最后点的那个"（`weSwitchFinish` 末尾调用）。 */
function weSwitchFlushPick() {
  const p = weSwitchPending;
  weSwitchPending = null;
  if (!p) return null;
  if (p.fn) { try { p.fn(); } catch { /* 调用方自己的异常不许影响下一轮 */ } }
  return p.id;
}

/**
 * **纯视觉**的按下反馈（4.23.9 起 onClick 才建切换上下文）。
 *
 * 为什么要把"视觉"与"状态机"分开：4.23.8 把两者都塞进 `weSwitchBegin`，于是
 * **只要按下去就已经"有一个切换在飞"** ⇒ 紧接着的 `onClick` 被连点防护判成"切换中"
 * 而直接 return ⇒ `applySelection` 从来没被调用 ⇒ 点一下**什么都不会发生**（P0）。
 * 现在 ptrdown 只负责"看得见的变化"，`weSwitchBegin()` 挪到 onClick，
 * 与 `applySelection` 同生共死。
 *
 * 仍然同步：第一处视觉变化 < 1ms（`clickFeedbackMs` 就量这一段）。
 */
function weSwitchPressFeedback(el) {
  const t0 = weSwitchNow();
  if (el && el.classList && typeof el.classList.add === "function") {
    try { el.classList.add("we-qp__item--pressed"); } catch { /* ignore */ }
  }
  if (el && typeof el.setAttribute === "function") {
    try { el.setAttribute("aria-busy", "true"); } catch { /* ignore */ }
  }
  const ms = Math.max(0, weSwitchNow() - t0);
  weSwitchLastPress = { at: t0, ms, el: el || null };
  return ms;
}
let weSwitchLastPress = null;

/** 上一次按下的视觉反馈（`weSwitchBegin` 用它把 pressed 与上下文绑到同一个元素上）。 */
function weSwitchConsumePress() {
  const p = weSwitchLastPress;
  weSwitchLastPress = null;
  return p;
}

/**
 * 结算当前切换（成功）。给**非视频**壁纸用：它们没有 `weSwitchPlayed()` 这条腿
 *（那条腿挂在 `<video>` 上），不结算的话"切换在飞"会一直为真 ⇒ 后续点击全被连点防护挡住。
 * 幂等；没有上下文时是 no-op。
 */
function weSwitchSettle() {
  const ctx = weSwitchCtx;
  if (!ctx || ctx.settled) return null;
  weSwitchSetState(ctx, "playing");
  weSwitchFinish(ctx, true, "");
  return ctx;
}

/**
 * 非视频类型（scene / web / image / 本机文件）的结算入口 —— **带类型**。
 *
 * 为什么要有它而不是直接 `weSwitchSettle()`：`kind` 是排障时区分"哪一类卡住"的唯一字段
 * （4.23.12 加进 `/folia/diag/switch-stats`）。调用点知道类型，状态机不该去猜。
 */
function weSwitchSettleAs(kind) {
  const ctx = weSwitchCtx;
  if (!ctx) return null;
  if (kind) ctx.kind = String(kind);
  return weSwitchSettle();
}

// ── 后台下载完成 ⇒ 无缝切到本地文件（需求 C）────────────────────────────────
/**
 * 「播放中」的这张壁纸，本地那一份什么时候到？到了就切过去。
 *
 * 为什么要切：代理流是**边下边播**，它的字节来自网络，用户拖动进度条、暂停再播都在打网络；
 * 而队列下完之后 `/folia/local-media/<job>` 是磁盘直出（实测 TTFB 1–5ms、45 MB 全量 97ms）。
 * 切过去之后，同一张再点一次就是 200ms 级（需求 D「之后重复点 = 直接用本地」）。
 *
 * 不变量：
 *   · **不在在屏元素上换源**（那会清掉当前帧）：本地这份装进**池里不在屏上的另一个元素**，
 *     首帧就绪后交叉淡入、旧元素淡出后才移除；
 *   · 切换前把本地元素的 `currentTime` 对齐到在屏元素的当前时间，**差 > 0.3s 就放弃**
 *     （宁可不切，也不要画面"跳一下"）；
 *   · 整条链失败全部静默（代理流继续播，功能不受影响）。
 */
let weSwitchLocalWatch = null;   // { timer, slug }

function weSwitchStopLocalWatch() {
  const w = weSwitchLocalWatch;
  weSwitchLocalWatch = null;
  if (w && w.timer && typeof clearInterval === "function") {
    try { clearInterval(w.timer); } catch { /* ignore */ }
  }
}

/** 池里"不在屏上"的那个元素（切换/换源只许动它）。 */
function weSwitchPoolPickHidden(except) {
  const pool = weSwitchPoolEnsure();
  for (const p of pool) {
    if (p && p.el && p.el !== except && p.el !== weSwitchVisibleEl) return p.el;
  }
  return null;
}

/** 开始等这张壁纸的本地副本（幂等；没有 originUrl / 已命中族 就不必等）。 */
function weSwitchBeginLocalWatch(ctx) {
  const o = ctx || {};
  if (!o.originUrl || o.cacheFamilyHit === true) return null;
  const slug = String(o.slug || "");
  if (weSwitchLocalWatch && weSwitchLocalWatch.slug === slug) return weSwitchLocalWatch;
  weSwitchStopLocalWatch();
  if (typeof setInterval !== "function" || typeof apiJson !== "function") return null;
  const rec = { timer: 0, slug };
  const tick = () => {
    if (weSwitchLocalWatch !== rec) return;
    Promise.resolve()
      .then(() => apiJson("/downloads/list"))
      .then((res) => {
        const doc = (res && res.data) || res || {};
        const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
        // 4.23.19：**只有"完整且有效"的本地副本才切**。`done` 只说明落盘动作结束，
        // 盘上那份可能已被外部清掉（4.23.18 的 done-缺失）⇒ 切过去就是一次 404。
        // 宿主 `/downloads/list` 每行现在带 `fileExists` / `fileValid`（来自对账器）。
        const job = jobs.find((j) => j && String(j.url || "") === String(o.originUrl)
          && String(j.status || "") === "done" && j.fileValid !== false);
        if (!job || !job.id) return;
        weSwitchStopLocalWatch();
        // 4.23.19：本地播放地址的唯一拼法在 `src/media-state.js`（`msLocalMediaUrl`）。
        weSwitchHandoverLocal(msLocalMediaUrl(job.id));
      })
      .catch(() => { /* 网络抖动：下一拍再试 */ });
  };
  rec.timer = setInterval(tick, 1000);
  try { if (rec.timer && typeof rec.timer.unref === "function") rec.timer.unref(); } catch { /* ignore */ }
  weSwitchLocalWatch = rec;
  return rec;
}

/**
 * 把播放切到本地副本：预热（不在屏上的池元素）→ 对齐时间 → 交叉淡入。
 * 返回 true 表示**已开始**淡入（首帧在本元素上就位）；false = 放弃（继续播代理流）。
 */
function weSwitchHandoverLocal(localUrl) {
  const from = weSwitchVisibleEl;
  const u = String(localUrl || "");
  if (!from || !u) return false;
  if (String(from.__weUrl || "") === u) return false;   // 已经在本地那份上了
  const to = weSwitchPoolPickHidden(from);
  if (!to) return false;
  const fromTime = Number(from.currentTime) || 0;
  try {
    to.__weUrl = u;
    to.muted = true;
    to.src = u;
    if (typeof to.load === "function") to.load();
  } catch { return false; }
  // 先播起来（rVFC 只在出帧时回调），再把时间对齐 —— 顺序不能反：
  // 未起播时 `currentTime` 的赋值会被随后的资源选择覆盖掉。
  try {
    const p = to.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* 静音元素被策略拒绝：等 loadeddata 再说 */ });
  } catch { /* ignore */ }
  try { if (fromTime > 0) to.currentTime = fromTime; } catch { /* ignore */ }

  let done = false;
  const settleToLocal = () => {
    if (done) return;
    done = true;
    const nowTime = Number(from.currentTime) || 0;
    const toTime = Number(to.currentTime) || 0;
    // **对齐判据**：差 > 0.3s 就不切（画面跳一下比继续走网络更糟）。
    if (Math.abs(toTime - nowTime) > 0.3) return;
    try { if (Number(from.playbackRate) > 0) to.playbackRate = from.playbackRate; } catch { /* ignore */ }
    try { to.loop = from.loop === true; } catch { /* ignore */ }
    weSwitchCrossfadeTo(to, from);
  };
  if (typeof to.requestVideoFrameCallback === "function") {
    try { to.requestVideoFrameCallback(() => settleToLocal()); return true; } catch { /* 退化到事件 */ }
  }
  if (typeof to.addEventListener === "function") {
    const onData = () => settleToLocal();
    try { to.addEventListener("loadeddata", onData, { once: true }); } catch { /* ignore */ }
    try { to.addEventListener("canplay", onData, { once: true }); } catch { /* ignore */ }
    return true;
  }
  settleToLocal();
  return true;
}

/**
 * 交叉淡入到 `to`，旧元素淡出**之后**才从 DOM 移除（任何时刻都有一帧在屏上 = 不黑屏）。
 * `to` 插在 `from` **之前**：`layer.querySelector("video")` 因此会返回新的那个。
 */
function weSwitchCrossfadeTo(to, from) {
  if (!to || !from) return false;
  const parent = from.parentElement;
  if (!parent) return false;
  try { parent.insertBefore(to, from); } catch { return false; }
  try {
    to.style.opacity = "0";
    to.style.transition = "opacity " + WE_SWITCH_FADE_MS + "ms linear";
  } catch { /* 精简 DOM：直接当已切换 */ }
  const reveal = () => {
    try { to.style.opacity = "1"; } catch { /* ignore */ }
    if (typeof setTimeout !== "function") { weSwitchFinishLocalSwap(to, from, parent); return; }
    setTimeout(() => { weSwitchFinishLocalSwap(to, from, parent); }, WE_SWITCH_FADE_MS);
  };
  // 强制一次样式读取，确保上面的 opacity:0 真的被应用（否则过渡不会发生）。
  try { void (parent && parent.offsetWidth); } catch { /* ignore */ }
  if (typeof setTimeout === "function") setTimeout(reveal, 0); else reveal();
  return true;
}

/**
 * 4.24.0：**静态封面的唯一口径** —— 站点 v1 的 `posterUrl`（首帧海报）优先，回退预览图
 * （宿主 inventory 的 `preview`，它自己已按 `posterUrl → thumbUrl` 排过序）。
 *
 * 为什么住在切换域：`<video>.poster` 的写入点就在本文件的 `weSwitchArm()`，而池预热/点击
 * 两条路都要在"首帧之前"先在屏上放一张图。站点 v1 的 `posterUrl` 是 1280 宽 webp 的
 * **真正的首帧**（`folia-admin` 的 `POSTER_WIDTH`），比 0.5s 处的封面帧更接近起播后的画面；
 * 而且它比缩略图更省一次"看起来换了张图"的闪动。
 *
 * ⚠️ 空对象/缺字段 ⇒ 空串（调用方 `if (posterUrl)` 自行跳过，绝不设一个 undefined 到
 * `<video>.poster` 上——那会把上一次的海报留在元素上）。
 *
 * @param {any} sel selection 或 inventory 条目（两者字段同名）
 * @returns {string}
 */
function weSwitchStillOf(sel) {
  const s = sel || {};
  return String(s.posterUrl || s.previewUrl || s.preview || s.thumbUrl || "");
}

/** 淡入结束：移除旧元素、把"在屏元素"换成新的。 */
function weSwitchFinishLocalSwap(to, from, parent) {
  try { if (parent && from && from.parentElement === parent) parent.removeChild(from); } catch { /* ignore */ }
  try { if (from && typeof from.pause === "function") from.pause(); } catch { /* ignore */ }
  if (to) {
    weSwitchVisibleEl = to;
    weSwitchStartJankProbe(to);
  }
  // 切到本地 = 这一张从此"已缓存"：复用缓存族标记，面板角标与度量同一口径。
  try { liveLog("local-handover", "已切到本地副本（后续切换走磁盘）"); } catch { /* ignore */ }
  // 4.23.19：把播放源写回 selection（面板「当前播放源」与诊断读它；切换已完成，不再是 proxy）。
  try { if (selection && typeof selection === "object") { selection.playSrc = "local"; selection.url = String((to && to.__weUrl) || selection.url || ""); } } catch { /* ignore */ }
}
export {
  WE_SWITCH_FADE_MS, WE_SWITCH_BUFFER_HINT_MS, WE_SWITCH_STATS_MAX,
  WE_SWITCH_JANK_FPS, WE_SWITCH_POOL_SIZE, WE_SWITCH_SETTLE_GUARD_MS, WE_SWITCH_PROGRESS_POLL_MS,
  weSwitchPoolPick, weSwitchArm, weSwitchAttachPlayer, weSwitchPublish,
  weSwitchPlayed, weSwitchFail, weSwitchBegin, weSwitchBusy, weSwitchState,
  weSwitchStatsSnapshot, weSwitchStatSummary, weSwitchSubscribe,
  weSwitchJankState, weSwitchSlugOf, weSwitchIs1080p, weSwitchNewPlayer,
  weSwitchQueuePick, weSwitchFlushPick, weSwitchIsVisible,
  weSwitchPressFeedback, weSwitchConsumePress, weSwitchSettle, weSwitchSettleAs,
  weSwitchClickPlayer, weSwitchDetachedPlayer,
  weSwitchRequestFade, weSwitchConsumeFade,
  weSwitchBufferHintText, weSwitchOverlaySet, weSwitchOverlayHide,
  weSwitchHandoverLocal, weSwitchBeginLocalWatch, weSwitchStopLocalWatch,
  // 4.24.0：静态封面口径（posterUrl 优先，回退预览图/缩略图）—— 点击、预热与视频通道共用。
  weSwitchStillOf,
  // 4.24.0（P0-A）：最近一次缓冲提示（纯状态读数；居中浮层已退役，进度只进标题栏）。
  weSwitchHintTextOf,
};
