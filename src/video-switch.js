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
// 缓冲提示阈值：1.5s 内没进到可播状态就出「正在缓冲 x%」，而不是留一块空白/旧壁纸
// 让人以为"点了没反应"。
const WE_SWITCH_BUFFER_HINT_MS = 1500;
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
const WE_SWITCH_HARD_MS = 60000;

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
  const t0 = weSwitchNow();
  if (el && el.classList && typeof el.classList.add === "function") {
    try { el.classList.add("we-qp__item--pressed"); } catch { /* ignore */ }
  }
  if (el && typeof el.setAttribute === "function") {
    try { el.setAttribute("aria-busy", "true"); } catch { /* ignore */ }
  }
  const feedbackMs = Math.max(0, weSwitchNow() - t0);
  const ctx = {
    startedAt: t0, feedbackMs, state: "priming",
    cardEl: el || null, pendingEl: null, bufferTimer: 0, pressTimer: 0, hardTimer: 0,
    slug: "-", cacheFamilyHit: false, is1080p: false, settled: false,
  };
  weSwitchCtx = ctx;
  if (typeof setTimeout === "function") {
    // 视觉兜底：只摘 pressed / aria-busy，**不结算**（见 WE_SWITCH_PRESS_MS 的注释）。
    ctx.pressTimer = setTimeout(() => { weSwitchResetCard(ctx); }, WE_SWITCH_PRESS_MS);
    // 缓冲提示：1.5s 还没进到可播状态 ⇒ 转 buffering 并发事件（面板画「正在缓冲 x%」）。
    ctx.bufferTimer = setTimeout(() => {
      if (ctx.settled || weSwitchCtx !== ctx) return;
      if (ctx.state === "priming" || ctx.state === "preloading") {
        weSwitchSetState(ctx, "buffering");
        weSwitchListens(ctx);
      }
    }, WE_SWITCH_BUFFER_HINT_MS);
    // 硬上限：真正的"永远等不到"收口。
    ctx.hardTimer = setTimeout(() => {
      if (ctx.settled || weSwitchCtx !== ctx) return;
      weSwitchFail("timeout");
    }, WE_SWITCH_HARD_MS);
  }
  return ctx;
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
    percent: Number(ctx.percent) || 0,
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
  if (!ctx.settled) weSwitchSetState(ctx, "preloading");
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
  if (ctx && !ctx.settled) {
    weSwitchSetState(ctx, "swapping");
    if (o.fadeMs && typeof setTimeout === "function") {
      const at = ctx;
      setTimeout(() => { weSwitchFinish(at, true, ""); }, Math.max(0, Number(o.fadeMs) || WE_SWITCH_FADE_MS));
      return ctx;
    }
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
  }
  ctx.pressTimer = 0;
  ctx.bufferTimer = 0;
  ctx.hardTimer = 0;
  weSwitchSetState(ctx, ok ? "playing" : "failed");
  // 卡片复位：pressed 摘掉、aria-busy 放下（需求 H14 / G4）。
  weSwitchResetCard(ctx);
  weSwitchRecord({
    slug: ctx.slug,
    cacheFamilyHit: ctx.cacheFamilyHit === true,
    is1080p: ctx.is1080p === true,
    switchLatencyMs: Math.round(ctx.latencyMs),
    clickFeedbackMs: Math.round(ctx.feedbackMs || 0),
    ok: ok === true,
    reason: ok ? "" : String(reason || ctx.reason || ""),
  });
  weSwitchListens(ctx);
  if (weSwitchCtx === ctx) weSwitchCtx = null;
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

export {
  WE_SWITCH_FADE_MS, WE_SWITCH_BUFFER_HINT_MS, WE_SWITCH_STATS_MAX,
  WE_SWITCH_JANK_FPS, WE_SWITCH_POOL_SIZE,
  weSwitchPoolPick, weSwitchArm, weSwitchAttachPlayer, weSwitchPublish,
  weSwitchPlayed, weSwitchFail, weSwitchBegin, weSwitchBusy, weSwitchState,
  weSwitchStatsSnapshot, weSwitchStatSummary, weSwitchSubscribe,
  weSwitchJankState, weSwitchSlugOf, weSwitchIs1080p, weSwitchNewPlayer,
  weSwitchQueuePick, weSwitchFlushPick, weSwitchIsVisible,
  weSwitchClickPlayer, weSwitchDetachedPlayer,
};
