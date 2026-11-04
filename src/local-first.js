/**
 * local-first.js — **站点资源先下载到本地，再从本地播放**（点击即下载，连点即并发）。
 *
 * 为什么要有这一层：站点壁纸原本是"边下边播"（浏览器直接从远端流），于是
 * 弱网机器的首播要等，且每次切回来都要重新缓冲。用户的规则很明确：
 *   **用户点哪一条就下载哪一条；连点多条就同时下载；渲染只读本地。**
 *
 * 行为：
 *   · 点击站点条目（inventory 里带 `mediaProxy` 且 `local !== true`）
 *     ⇒ `POST /folia/downloads/add` 入队（宿主队列并发 3，重复点击幂等）
 *     ⇒ 面板显示"正在下载到本地 …%"，**立刻返回**（不阻塞其它点击）
 *     ⇒ 下载完成后自动重新应用一次（走本地文件，不再触网）
 *   · 已在本地（`local === true`）⇒ 返回 false，交回原来的直连/本地播放路径
 *   · 非站点条目（本机壁纸）⇒ 返回 false
 *
 * 失败不吞：显示失败原因，并**回退**到原来的直连路径（用户至少还能看）。
 */
const LF_STATE = {
  inflight: new Map(),   // id → { timer }
  note: null,            // (text, ok) => void，由 client.js 注入
  // 4.23.18：非点击的"当前在播提权"节流（id → 上次 promote 的毫秒时间戳）。
  promoteAt: new Map(),
};

/** client.js 注入：把提示写进面板（与其它页签同一条提示位）。 */
function setLocalFirstNote(fn) { LF_STATE.note = typeof fn === "function" ? fn : null; }

function lfSay(text, ok) {
  try { if (LF_STATE.note) LF_STATE.note(text, ok !== false); } catch { /* 提示失败不影响下载 */ }
}

/** 从 inventory 里找这条。
 *
 * ⚠️ 老实现只认 `items` / `data.items`，而 `/folia/inventory` 实际把壁纸放在 **`wallpapers`** 里
 * ⇒ 永远找不到 ⇒ 静默不入队 ⇒ 代理侧也拿不到可复用的 job ⇒ 壁纸退化为"远端流式 + 被播放器背压"
 *（实测 0.6 MB/s、且缓存永远补不满）。现在按"任何一个对象数组里找 id"兜底，不依赖具体键名。
 */
async function lfPools() {
  try {
    const resp = await apiJson("/inventory");
    const doc = (resp && resp.data && typeof resp.data === 'object') ? resp.data : (resp || {});
    return [doc.items, doc.wallpapers, doc.list, doc.entries].filter(Array.isArray);
  } catch { return []; }
}

async function lfFindItem(id) {
  const pools = await lfPools();
  for (const pool of pools) {
    const hit = pool.find((x) => x && x.id === id);
    if (hit) return hit;
  }
  return null;
}

function lfStopPolling(id) {
  const rec = LF_STATE.inflight.get(id);
  if (!rec) return;
  if (rec.timer) { try { clearInterval(rec.timer); } catch { /* ignore */ } }
  LF_STATE.inflight.delete(id);
}

/** 轮询 job，直到 done / failed / cancelled。 */
function lfPoll(jobId, item, label) {
  const id = item.id;
  lfStopPolling(id);
  const started = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - started > 30 * 60 * 1000) { lfStopPolling(id); lfSay(`下载超时：${label}`, false); return; }
    let jobs;
    try {
      const resp = await apiJson("/downloads/list");
      jobs = (resp && resp.data && Array.isArray(resp.data.jobs)) ? resp.data.jobs
        : (Array.isArray(resp && resp.jobs) ? resp.jobs : []);
    } catch { return; }
    const job = jobs.find((j) => j && j.id === jobId);
    if (!job) return;
    if (job.status === "done") {
      lfStopPolling(id);
      // 不在这里重放 applySelection：本次播放早已起播（边下边播），重放会让画面重新切一次。
      // 下次点同一条时 inventory 会给 `local: true`，直接读本地文件。
      lfSay(`已下载到本地，下次点它就是本地播放：${label}`, true);
      return;
    }
    if (job.status === "failed" || job.status === "cancelled") {
      lfStopPolling(id);
      lfSay(`下载失败（${job.error || job.status}）：${label}`, false);
      return;
    }
    const pct = Number(job.percent) || 0;
    lfSay(`正在下载到本地 ${pct}%：${label}`, true);
  }, 1200);
  try { if (timer && typeof timer.unref === "function") timer.unref(); } catch { /* ignore */ }
  LF_STATE.inflight.set(id, { timer });
}

/**
 * 返回 true ⇒ **本次不播放**（已入队下载，完成后会自动播放）。
 * 返回 false ⇒ 交回原路径（非站点条目 / 已在本地 / 下载链路不可用）。
 */
function localFirstApply(id, opts) {
  if (opts && opts.skipLocalFirst) return false;
  if (!id) return false;
  /**
   * `opts.silent`（4.23.18）：**非点击**路径（启动恢复 / 轮播 / revalidate）的"当前在播 = high"。
   * 与点击路径共用同一段入队逻辑，但不写提示、不挂进度轮询 —— 否则每次 revalidate 都会
   * 刷一行「正在下载到本地」。
   */
  const silent = Boolean(opts && opts.silent);
  // 异步完成，这里只能是"先入队再返回"。所有 await 都在内部，不阻塞调用方。
  (async () => {
    // 调用方已经拿着 inventory 条目时（`opts.item`）直接用 —— 不再打一次 `/inventory`。
    // 这条对"上传成功 → 自动选中新条目"很关键：上传 handler 自己已经重拉过一次库存，
    // 这里再查一次会让「恰好一次重拉」变成两次（test/verify-picker-upload 的实测判据）。
    const provided = opts && opts.item && typeof opts.item === "object" ? opts.item : null;
    const item = provided || await lfFindItem(id);
    if (!item || !item.mediaProxy) return;      // 非站点条目：交给原路径
    // **族级命中就够**（4.23.8 / 成因 ⑤）：原画或 1080p 任一档已落地 ⇒ 播放走
    // `/folia/local-media/`，不必再入队。只认 `local`（精确）会让「下的是 1080p、
    // 播的是原画」这一族每次都白排一次下载 —— 那正是用户说的"已下载好还卡"。
    if (item.localReady === true || item.local === true) return;
    const label = String(item.title || id);
    if (LF_STATE.inflight.has(id)) {
      if (!silent) lfSay(`正在下载到本地：${label}`, true);
      return;
    }
    // 非点击的"当前在播"：同一张 5 秒内只提一次（启动恢复 + revalidate 常连着来）。
    if (silent) {
      const now = Date.now();
      const last = Number(LF_STATE.promoteAt.get(id)) || 0;
      if (now - last < 5000) return;
      LF_STATE.promoteAt.set(id, now);
    }
    let job = null;
    try {
      // 4.23.18：**用户点击 = 最高优先级**。此前这里是 "low"，于是用户点的那张排在
      // 31 个后台预取后面（标题栏"前面还有 50 个"的直接体感）。点击是唯一"我就要现在看"
      // 的信号 ⇒ high + 宿主侧提权到队首（见 lib/download-queue.js 的 boostSeq）。
      const resp = await apiPostJson("/downloads/add", {
        items: [lfAddItem(item, item.media, "high")],
      }, { parse: "always" });
      const items = (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items : [];
      job = items[0] && items[0].job ? items[0].job : null;
      // 4.23.4：宿主可能**替我们选了 1080p 变体**（清单/设置/慢链路）。这不是失败 ——
      // 但要让人看得见：小标 + 一句说明（`chosenVariant` 来自宿主的同一个纯函数）。
      if (!silent && job && items[0] && items[0].chosenVariant === "1080p") {
        lfSay(`已按 1080p 变体下载：${label}（省流量；可在面板点「用原画」改回）`, true);
      }
    } catch { /* 入队失败：下面回退直连 */ }
    if (!job || !job.id) return;   // 下载链路不可用（老宿主 / 路由没注册）⇒ 静默跳过，播放照旧
    if (silent) return;            // 在播提权只要"入队/high"，进度由卡片的订阅负责
    lfSay(`正在下载到本地：${label}`, true);
    lfPoll(job.id, item, label);
  })();
  return true;
}

/* ── 1080p 变体（4.23.4）：客户端这一半 ───────────────────────────────────── */

/** `localStorage` 里"这张我要原画"的覆盖（按条目 id；跨页签/重开都在）。 */
const LF_VARIANT_KEY = "wePreferOriginal";

function lfPreferOriginalMap() {
  try {
    const raw = localStorage.getItem(LF_VARIANT_KEY);
    const doc = raw ? JSON.parse(raw) : null;
    return doc && typeof doc === "object" ? doc : {};
  } catch { return {}; }
}

/** 这张条目是否被用户明确要求「用原画」。 */
function lfPreferOriginal(id) {
  const k = String(id || "");
  return k ? Boolean(lfPreferOriginalMap()[k]) : false;
}

/**
 * 屏幕高度：**只有客户端知道**（宿主拿不到）。
 * 1080p 选档的"原画 > 20 MB 且屏幕 ≤ 1440"那一半判据靠它；取不到就传 0
 * ⇒ 宿主只按速度判（要求里写明：取不到就只按速度判定，绝不猜）。
 */
function lfScreenHeight() {
  try {
    const s = typeof window !== "undefined" ? window.screen : null;
    return Number((s && (s.height || s.availHeight)) || 0) || 0;
  } catch { return 0; }
}

/** 一条站点条目 → `/downloads/add` 的入队条目（带上变体数组/体积/屏幕高度/画质覆盖）。 */
function lfAddItem(item, url, priority) {
  const it = item || {};
  const entry = {
    kind: "wallpaper",
    url: String(url || it.media || ""),
    priority: priority || "normal",
    // 选档的判据全部随条目带过去 —— 决策只在宿主那一处（lib/variant-pick.js）。
    bytes: Number(it.bytes) || 0,
    screenHeight: lfScreenHeight(),
  };
  if (Array.isArray(it.variants) && it.variants.length) entry.variants = it.variants;
  // 4.23.15：原画的宽/高/帧率也带上 —— 宿主选档要按**解码上限**判（4K@60 与 5916×2530
  // 都是"链路再快也解不出来"的那一类）。缺就不发，宿主按兜底口径判。
  if (Number(it.width) > 0) entry.width = Number(it.width);
  if (Number(it.height) > 0) entry.height = Number(it.height);
  if (Number(it.fps) > 0) entry.fps = Number(it.fps);
  // 4.23.17（P0-6）：清单给的哈希**不是**"这一条要用的哈希"，只是**清单事实**。
  // 真正决定校验用哪个哈希的是宿主那一处 `resolveMediaExpectation(item, chosen)`（选原画用原画
  // 的、选 1080p 用变体的）。所以字段名故意不叫 `sha256`：客户端不参与校验来源的决策，
  // 只把清单原样带过去（`variants[]` 里的 sha256 也一起带）。旧宿主也认 `sha256`，升级期不崩。
  const sha = String(it.sha256 || "").trim().toLowerCase();
  if (/^[0-9a-f]{64}$/.test(sha)) entry.manifestSha256 = sha;
  if (lfPreferOriginal(it.id)) entry.quality = "original";
  return entry;
}

/**
 * 「用原画」：写本地覆盖 + **重新入队原画**。
 *
 * 为什么写本地覆盖而不只发一次请求：宿主侧的选择是"每次入队"重算的（慢链路/体积/设置），
 * 只在这一次请求上带 `quality:'original'` 的话，下一次点同一张又会被自动降档 ——
 * 用户的意图必须**记住**。「恢复自动」再把这条覆盖删掉。
 */
async function lfUseOriginal(item, on) {
  const id = String((item && item.id) || "");
  if (!id) return false;
  const want = on !== false;
  try {
    const map = lfPreferOriginalMap();
    if (want) map[id] = true; else delete map[id];
    localStorage.setItem(LF_VARIANT_KEY, JSON.stringify(map));
  } catch { /* 记不住也不影响这次入队 */ }
  const label = String((item && item.title) || id);
  if (!want) { lfSay(`已改回自动选档：${label}`, true); return true; }
  try {
    const resp = await apiPostJson("/downloads/add", {
      items: [lfAddItem(item, (item && item.media) || "", "high")],
    }, { parse: "always" });
    const items = (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items : [];
    const job = items[0] && items[0].job ? items[0].job : null;
    if (!job || !job.id) { lfSay(`已设为用原画（下载链路不可用，下次点这张会直连原画）：${label}`, true); return true; }
    lfSay(`已设为用原画，正在下载原画：${label}`, true);
    lfPoll(job.id, item, label);
  } catch {
    lfSay(`已设为用原画（入队失败，下次点这张会直连原画）：${label}`, true);
  }
  return true;
}

/* ── 预取（hover 300ms 预下"下一张"）───────────────────────────────────────── */
/**
 * 为什么预取**必须是最低优先级 + 限量**：它是"替用户提前赌一张"的投机行为。
 * 一旦它抢到用户真正需要的那条下载（安装皮肤 / 桌宠）的带宽，就会重现
 * 「看壁纸时点安装，卡片一直「安装中…」」这类故障。所以：
 *   · kind = wallpaper（自己那 2 个并发槽，见 lib/download-queue.js 的 KIND_LIMITS）
 *   · priority = low（同 kind 内排在用户点击后面）
 *   · 同一时刻**最多 1 个**预取在飞；已经入队/已落地的不重复发。
 */
const LF_PREFETCH = {
  timer: null,      // hover 计时器（300ms）
  sig: "",          // 当前悬停的卡片 id（同一张重复触发不叠计时器）
  busy: false,      // 是否有预取请求在飞
  seen: new Set(),  // 已预取过的 id（避免来回 hover 反复打宿主的 downloads/add）
};
/**
 * 每次预取的张数（4.23.8 / 需求 C8）。**2** 而不是 1：
 * 之前只预取 1 张，于是"下一张 → 再点一下下一张"的第二下必然落在冷源上；
 * 取 2 张把这条链也盖住，代价只是多一个 low 优先级任务（不抢用户点击的槽）。
 * 顺序即优先级：第 1 张是**紧邻的下一张**，第 2 张才是再下一张。
 */
const LF_PREFETCH_COUNT = 2;

function lfCancelPrefetch() {
  if (LF_PREFETCH.timer) { try { clearTimeout(LF_PREFETCH.timer); } catch { /* ignore */ } }
  LF_PREFETCH.timer = null;
}

/** 悬停某张卡片 ⇒ 300ms 后预取它后面第一张站点条目。`playingId` 是此刻在播的那张。 */
function lfSchedulePrefetch(id, playingId) {
  if (!id) return;
  if (id === playingId) return;                 // 正在播的那张不预取（它本来就已经在本地/在下了）
  if (LF_PREFETCH.sig === String(id) && LF_PREFETCH.timer) return;
  lfCancelPrefetch();
  LF_PREFETCH.sig = String(id);
  LF_PREFETCH.timer = setTimeout(() => {
    LF_PREFETCH.timer = null;
    lfPrefetchNext(String(id), playingId ? String(playingId) : "").catch(() => { /* 预取失败静默 */ });
  }, 300);
  try { if (LF_PREFETCH.timer && typeof LF_PREFETCH.timer.unref === "function") LF_PREFETCH.timer.unref(); } catch { /* ignore */ }
}

/** 预取 `afterId` 之后的下一张站点壁纸（只看后面 6 条，避免翻遍整份清单）。 */
async function lfPrefetchNext(afterId, playingId) {
  if (LF_PREFETCH.busy) return;                  // 同一时刻最多 1 个预取
  LF_PREFETCH.busy = true;
  try {
    const pools = await lfPools();
    let pool = null;
    let at = -1;
    for (const p of pools) {
      const i = p.findIndex((x) => x && String(x.id) === afterId);
      if (i >= 0) { pool = p; at = i; break; }
    }
    if (!pool) return;
    // **按列表顺序取前 2 张**（4.23.8 / 需求 C8）：顺序即优先级 —— 第 1 张就是"下一张"。
    // 跳过：非站点条目 / 族级已落地（`localReady`，已缓存的不必预取）/ 正在播的那张 /
    // 本次会话已经预取过的。
    const picks = [];
    for (let k = at + 1; k < pool.length && k <= at + 8 && picks.length < LF_PREFETCH_COUNT; k += 1) {
      const cand = pool[k];
      if (!cand || !cand.mediaProxy) continue;
      if (cand.localReady === true || cand.local === true) continue;
      if (playingId && String(cand.id) === playingId) continue;
      if (LF_PREFETCH.seen.has(String(cand.id))) continue;
      picks.push(cand);
    }
    if (!picks.length) return;
    // 已有 job（排队/在跑/已完成）⇒ 宿主侧本来就会去重，这里先问一次列表是为了
    // **不白占预取名额**，也让 `seen` 只在真的发出去时才记账。
    let jobs = [];
    try {
      const resp = await apiJson("/downloads/list");
      const doc = (resp && resp.data) || resp || {};
      jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
    } catch { return; }
    // 4.23.18：`pending`（启动时未缓存、没自动入队）**不算已在队列**——预取正是允许把
    // 它变回 low 的三条路径之一。queued / running / done 才算"已经有了"，不白占预取名额。
    const taken = new Set(["queued", "running", "done"]);
    const fresh = picks.filter((c) => !jobs.some((j) => j
      && j.url === c.media && taken.has(String(j.status || ""))));
    if (!fresh.length) return;
    for (const c of fresh) LF_PREFETCH.seen.add(String(c.id));
    // 第 1 张就是"**下一张**"（顺序即优先级）。单张走既有那条口径（priority=low，
    // 不抢用户点击的 high）；只有真的取到 2 张时才批量发一次 —— 宿主 `/downloads/add`
    // 本来就收数组，2 张 = 2 个 low 任务，不会变成 high。
    const next = fresh[0];
    if (fresh.length === 1) {
      await apiPostJson("/downloads/add", { items: [{ kind: "wallpaper", url: next.media, priority: "low" }] }, { parse: "always" });
      return;
    }
    await apiPostJson("/downloads/add", {
      items: fresh.map((c) => ({ kind: "wallpaper", url: c.media, priority: "low" })),
    }, { parse: "always" });
  } finally {
    LF_PREFETCH.busy = false;
  }
}

/* ── 下载状态：以 `/folia/downloads/list` 为唯一真源（4.23.3）─────────────────
 *
 * 真实故障（用户实测）：「开机动画」页点某条下载 → 切到壁纸/皮肤页签 → 再切回来，
 * 进度消失、按钮回到「下载」，用户以为没在下 —— 其实宿主队列里还在跑。
 * 根因：卡片的"下载中"只存在组件本地 state，页签切换 = 重新挂载 = state 归零。
 *
 * 现在的口径（三个页签共用，boot / pet / skin）：
 *   ① 挂载/刷新时先拉一次 list，按 (kind, url) 匹配到卡片；
 *   ② 只要还有 queued|running 就每 1.5s 拉一次，直到全部结束；
 *   ③ 全部结束（或组件卸载/切走）立刻停表，不空转、不泄漏。
 * 卡片文案统一 `下载中… x%`；多连接时就地补 ` · 多连接(n)`，不新增行、不挤既有文案。
 */
const DL_POLL_MS = 1500;

/** job 还没结束吗（queued / running）—— 轮询与卡片状态都用它。 */
function dlJobActive(job) {
  return Boolean(job) && (job.status === "queued" || job.status === "running");
}

/** list 里还有没结束的 job 吗 ⇒ 决定要不要继续每 1.5s 拉一次（全结束 ⇒ 停表）。 */
function dlHasActive(jobs) {
  return (jobs || []).some((j) => dlJobActive(j));
}

/**
 * 卡片 ↔ job：按 (kind, url) 匹配（url 归一：去首尾空白）。
 * 同一 URL 历史里可能有多条（失败重下），优先"未结束的"，否则取最后一条。
 */
function dlJobForCard(jobs, kind, url) {
  const k = String(kind || "").trim().toLowerCase();
  const u = String(url || "").trim();
  if (!u) return null;
  let best = null;
  for (const j of (jobs || [])) {
    if (!j || String(j.url || "").trim() !== u) continue;
    if (k && String(j.kind || "").trim().toLowerCase() !== k) continue;
    if (!best || (dlJobActive(j) && !dlJobActive(best))) best = j;
  }
  return best;
}

/* ── 挂载自愈：把「下载已完成但没落地」补装一次（4.23.6）──────────────────────
 *
 * 真实故障（用户实测，已确诊）：「助手皮肤」的鲸鱼娘·雨夜，17,509,106 B 全部下完、
 * 缓存 zip 完好、能解压、里面有 skin.json —— 但 `skins/rainy-night` 不存在，卡片停在
 * 「解压/落位中…」。原因在宿主：收尾那一步（`scheduleFinishInstall()`）只是进程内存里的
 * `setTimeout`，DSH 重启就没了，而 `jobs.json` 里 `status=done` 是落了盘的 ⇒ 没人再推进落地。
 *
 * 解药有两条，缺一不可：
 *   ① **挂载即自愈**（这里）：看到「job 完成 + 本机未落地」就自己补打一次安装请求。
 *      三个模块的收尾接口本来都是**幂等**的（走本地缓存，不再下载）：
 *        · 皮肤 `/folia/skins/install` —— 目标目录已有 skin.json 时直接回 `exists:true`；
 *          否则读 `cache/skins-zip/<sha256(url)>.zip` 解压落位（队列里那条 job 已 done ⇒ 不会重下）。
 *        · 开机动画 `/folia/boot/download` —— 本地文件已存在时只做"验头 + 写 meta"的收尾。
 *        · 桌宠 `/folia/pets/install` —— 本地目录已装好直接回 `exists:true`；否则读
 *          `cache/pets-zip/<id>.zip` 解压（同样不重新下载）。
 *   ② **超时兜底**（`dlCardState` ③）：自愈没成（或没机会跑）时，90 秒后卡片自己变 failed +「重试」。
 *
 * 防抖：同一 id **每次会话只自动尝试一次**（`LF_HEAL_TRIED`，页面级、跨页签挂载持续）。
 * 为什么要按 id 而不是按卡片实例：切页签 = 重新挂载，按实例记账等于"每切一次就重试一次"，
 * 而宿主那边是幂等的、失败原因也不会变 ⇒ 那是空转，还会把用户的手动「重试」状态冲掉。
 * 在页面级记一次账，用户真要重试时仍可以点卡片上的「重试」—— 那走的是**用户意图**，
 * 不受这里的自动防抖限制。
 */

/** 会话级防抖表：`<kind>:<id>` → 已自动尝试过。 */
const LF_HEAL_TRIED = new Set();

/** 这个 `kind:id` 还要不要自动补装？返回 true 时**同时记账**（所以调用方不必再防重）。 */
function dlHealOnce(key) {
  const k = String(key == null ? "" : key).trim();
  if (!k) return false;
  if (LF_HEAL_TRIED.has(k)) return false;
  LF_HEAL_TRIED.add(k);
  return true;
}

/**
 * 从"卡片列表 + 队列快照"里挑出**该自愈**的那些条目。
 *
 * @param {object[]} jobs   `/downloads/list` 的 jobs
 * @param {string} kind     `skin` / `boot` / `pet`
 * @param {object[]} items  该页签的卡片（至少要有 `id` 与 `url`）
 * @param {(it:object)=>boolean} doneOf  本机是否已经落地（已落地的不需要自愈）
 * @returns {object[]} 待自愈的条目（保持原顺序）
 */
function dlHealTargets(jobs, kind, items, doneOf) {
  const out = [];
  const isDone = typeof doneOf === "function" ? doneOf : () => false;
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || !it.id) continue;
    try { if (isDone(it)) continue; } catch { continue; }
    const job = dlJobForCard(jobs, kind, it.url);
    if (!job || job.status !== "done") continue;
    out.push(it);
  }
  return out;
}

/**
 * 挂载自愈**执行体**：对 `dlHealTargets()` 挑出来的条目各补打一次收尾请求。
 *
 * 约定（四个回调都由页签提供，本函数不认识组件、也不认识 React）：
 *   · `path` / `body(it)`   打哪个宿主接口、带什么体（三个模块各一条，都是幂等的）；
 *   · `onTry(it)`           发出前（用来写"正在自动补装…"的提示与卡片 submitting）；
 *   · `onOk(it)`            宿主明确回 2xx（页签据此 `cards.markOk()` + 重拉清单）；
 *   · `onFail(it, code)`    失败（页签据此 `cards.fail()` **把原因写在卡片上**，不许静默）。
 *
 * 绝不抛：任何一个模块/一张卡片失败都不该让别的卡片或整页挂掉。
 *
 * @returns {Promise<object[]>} 本次真的发过请求的条目
 */
async function dlHealStuck(opts) {
  const o = opts || {};
  const kind = String(o.kind || "");
  const tried = [];
  const targets = (() => {
    try { return dlHealTargets(o.jobs, kind, o.items, o.doneOf); } catch { return []; }
  })();
  for (const it of targets) {
    if (!dlHealOnce(kind + ":" + it.id)) continue;
    tried.push(it);
    try { if (typeof o.onTry === "function") o.onTry(it); } catch { /* 提示失败不影响补装 */ }
    /** 空串 = 成功；非空 = 宿主给的错误码（或兜底码）。 */
    let code;
    try {
      const resp = await apiPostJson(String(o.path || ""), typeof o.body === "function" ? o.body(it) : (o.body || {}), { parse: "always" });
      const data = (resp && resp.data) || null;
      // 宿主回 `{ ok:false, error }` 时把**它的**错误码带出去（比 `http-500` 有信息量）。
      if (resp && resp.ok && data && data.ok === false) code = String(data.error || "failed");
      else if (!(resp && resp.ok)) code = String((data && data.error) || ("http-" + ((resp && resp.status) || 0)));
      else code = "";
    } catch (e) {
      code = /timeout|超时/i.test(String((e && e.message) || "")) ? "submit-timeout" : "network";
    }
    try {
      if (code) { if (typeof o.onFail === "function") o.onFail(it, code); }
      else if (typeof o.onOk === "function") o.onOk(it);
    } catch { /* 回调失败不影响下一张卡片 */ }
  }
  return tried;
}

/* ── 「job 不存在了」的判定（4.23.6，另一台机器的实测故障）────────────────────
 *
 * 真实故障（Lenovo 实测）：卡片「鲸鱼娘·雨夜」永远显示「解压/落位中…」，但
 *   · `/folia/skins/list` 的 `installed` 里没有 rainy-night；
 *   · `/folia/downloads/list` 里**根本没有那条 job**（连 url 里的 sha 都搜不到）。
 * ⇒ 前端在等一个**不存在的 jobId**：`POST /skins/install` 当年回的 202 jobId，在宿主重启 /
 *   队列被重置 / job 被清理之后就查不到了。旧实现只在"列表里找不到这条 job"时**静默继续转圈**，
 *   一路转到 30 分钟上界才报超时 —— 用户看到的就是永久 installing。
 *
 * 判据（三件事一起做，缺一条就会留下一种"永久转圈"）：
 *   ① `DL_JOB_MISS_LIMIT` 次**连续**查不到 ⇒ 判 `lost`（不再无限轮询）；
 *   ② 判 `lost` / 超时之前，先回列表核一次 `installed` —— 也许它其实早就装好了（列表是唯一真源）；
 *   ③ 本地没有对应 job 的卡片，把残留的"进行中"痕迹清掉 ⇒ **回落 idle、可点安装**。
 */
const DL_JOB_MISS_LIMIT = 5;

/**
 * 「本地没有对应 job」的卡片：找不到 job = 那些"本地还显示在进行中、但队列里已经没人推进"
 * 的残留（宿主重启后队列被重置、job 被清理）。
 *
 * @param {object[]} jobs   `/downloads/list` 的 jobs
 * @param {string} kind     `skin` / `boot` / `pet`
 * @param {object[]} items  该页签的卡片（要有 `id` 与 `url`）
 * @param {(it:object)=>boolean} doneOf 本机是否已落地（已落地的不算残留）
 * @returns {object[]} 残留条目（页签据此调 `cards.settle(id)` 回落 idle）
 */
function dlStaleCards(jobs, kind, items, doneOf) {
  const out = [];
  const isDone = typeof doneOf === "function" ? doneOf : () => false;
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || !it.id) continue;
    try { if (isDone(it)) continue; } catch { continue; }
    if (dlJobForCard(jobs, kind, it.url)) continue;   // 有 job ⇒ 不是残留
    out.push(it);
  }
  return out;
}

/** 下载中按钮文案：`下载中… x%`（多连接时补 ` · 多连接(n)`，同一行、不加行高）。 */
function dlBusyLabel(job) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(job && job.percent) || 0)));
  const m = /^ranged:(\d+)$/.exec(String((job && job.mode) || ""));
  const n = m ? Number(m[1]) : 0;
  if (n > 1) return weT("下载中… {p}% · 多连接({n})", { p: pct, n });
  return weT("下载中… {p}%", { p: pct });
}

/* ── 统一卡片状态机（4.23.4）：四个模块共用一份 ───────────────────────────────
 *
 * 真实故障（用户实测，4.23.3）：「助手皮肤」页签里 14 MB 的包点下去能看到「安装中…」，
 * 16.6 MB 那个点下去**毫无反应** —— 不置灰、不显示进度、也不报错；开机动画 / 桌宠 / 皮肤
 * 三个页签的"进度"覆盖度不一致；失败时卡片静默回到「安装」，用户不知道发生了什么。
 *
 * 根因（可判定的三条）：
 *   ① 卡片"忙"用的是**页面级 busy**，且 install 按钮的 disabled 绑 `busyIsStructural`
 *      —— **任何**结构操作开始 ⇒ 所有安装按钮一起灰 ⇒ 点另一张卡片等于点在 disabled 按钮上，
 *      请求不发、提示不写，界面上什么都不发生（这就是"点了没反应"）。
 *   ② 点击到响应之间没有任何状态：弱网下这段可以是一两分钟，卡片看起来就是死的。
 *   ③ 失败原因只写在**页面提示行**（还常被下一次刷新冲掉），卡片本身回到「安装」。
 *
 * 所以卡片状态改成**按卡片**的、并且从**点击那一刻**就可见：
 *   idle → submitting（立刻置灰 +「正在提交…」）→ queued（前面还有 N 个）
 *        → running（x% + a/b MB + 约剩 N 秒 [+ 多连接]）→ installing（解压/落位）→ done
 *   任何一步失败 ⇒ failed（具体原因）+「重试」（可点，立刻重新提交）。
 * 本段只放**判断**（纯函数）；每张卡片"是谁、装没装"由四个页签自己给。
 */
const DL_PHASES = {
  IDLE: "idle", SUBMITTING: "submitting", QUEUED: "queued",
  RUNNING: "running", INSTALLING: "installing", DONE: "done", FAILED: "failed",
};

/** 提交请求的宽容窗口：超过它还没返回 ⇒ 按「提交超时」失败并给「重试」，不让卡片永远停在提交中。
 *  必须**大于**宿主侧 install 自己那条 120 秒的等待上界，否则会在请求还在飞的时候误判失败。 */
const DL_SUBMIT_TIMEOUT_MS = 150000;

/* ── 「下完但没落地」的宽容窗口（4.23.6）──────────────────────────────────────
 *
 * 真实故障（用户实测，已确诊）：`/folia/downloads/list` 里 job.status 已经是 `done`
 * （17,509,106 B 全下完、缓存 zip 完好、能解压、里面确实有 skin.json），但 `skins/rainy-night`
 * **不存在**；而卡片在这一格上被映射成「解压/落位中…」（disabled、retry=false、**没有超时**）
 * ⇒ 界面永久卡住，用户既没有进度、也没有可点的按钮。
 *
 * 为什么它会永远卡住：当初的"收尾"（`lib/routes/skins.js` 的 `scheduleFinishInstall()`）只是
 * 宿主进程内存里的一个 `setTimeout`。DSH 一重启，那条定时器就消失了，而 jobs.json 里的
 * `status=done` 是落过盘的 ⇒ 重启之后**没有任何人**会再去推进"落地"这一步。
 *
 * 所以这一格必须**有上界**：超过窗口就判 failed +「重试」（把决定权交回用户），
 * 并且在面板挂载时先做一次自愈（`dlHealStuck()`，幂等、走缓存、不重新下载）。
 *
 * 窗口默认 90 秒，`DSH_FOLIA_INSTALL_STALL_MS` 可覆盖（夹取 5s..30min，非法/缺省回落默认）。
 * 浏览器里没有 `process.env` ⇒ 真源在宿主：`/folia/downloads/list` 把同一个环境变量解析成
 * 数字随列表一起下发，客户端只是收一个 `installStallMs`（见 `useDownloadJobs`）。
 */
const DL_INSTALL_STALL_MS = 90000;
const DL_INSTALL_STALL_MIN_MS = 5000;
const DL_INSTALL_STALL_MAX_MS = 30 * 60 * 1000;

/** 解析「下完但没落地」的宽容窗口。默认 90 秒；`globalThis.__weEnv` 里可注入覆盖（一律夹取）。
 *
 *  ⚠️ 客户端**不许**出现 `process.*`（`scripts/build-client.mjs` 的浏览器安全判据会红）。
 *  所以这里只读宿主注入的全局袋；真正解析环境变量的是宿主 `lib/routes/downloads.js` 的
 *  `installStallMs()` —— 它随 `/folia/downloads/list` 把数字下发下来（见 useDownloadJobs）。 */
function dlInstallStallMs() {
  const raw = (() => {
    try {
      // 用 JSDoc 断言拿全局袋：`globalThis.__weEnv` 是宿主注入的非标准字段，
      // 直接点会报 TS2339（而静态棘轮只许变好）。
      const g = /** @type {any} */ (globalThis);
      const env = g && g.__weEnv;
      if (env && env.DSH_FOLIA_INSTALL_STALL_MS != null) return env.DSH_FOLIA_INSTALL_STALL_MS;
    } catch { /* 读不到全局不是错误：回落默认 */ }
    return null;
  })();
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DL_INSTALL_STALL_MS;
  return Math.min(DL_INSTALL_STALL_MAX_MS, Math.max(DL_INSTALL_STALL_MIN_MS, n));
}

/**
 * 「本机已装」判定（4.23.6 的归一口径）：**目录名 / skin.json 里的 id / 站点 catalog 的 id**
 * 三者任意一个对上就算已安装。
 *
 * 为什么必须三个都比：站点 slug 与本机目录名不总相同（撞名时上传工具会加 `skin-` 前缀；
 * 包里 skin.json 的 id 又可能被规范化过）。实测「雨夜」就是这样 ——
 * `installed` 里没有 `rainy-night` 这个名字，但皮肤其实已经躺在 `skins/<别的 id>/` 里，
 * 于是客户端一直判"没装"，安装成功的响应也被当成没完成（第二次装完仍停在「解压/落位中…」）。
 *
 * @param {object[]} list `/skins/list` 的 `installed`
 * @param {string} rawId 站点 slug / 目录名 / 皮肤 id（任意一种）
 */
function skinInstalledMatch(list, rawId) {
  const want = String(rawId == null ? "" : rawId).trim();
  if (!want) return false;
  const norm = (v) => {
    const s = String(v == null ? "" : v).trim().toLowerCase();
    return s.startsWith("skin-") ? s.slice(5) : s;
  };
  const wantNorm = norm(want);
  for (const s of (Array.isArray(list) ? list : [])) {
    if (!s || typeof s !== "object") continue;
    for (const k of ["id", "dirId", "dir"]) {
      const v = s[k];
      if (v == null || v === "") continue;
      if (String(v).trim() === want || norm(v) === wantNorm) return true;
    }
  }
  return false;
}

/**
 * 失败原因 → 人说得出的一句话（四模块共用一张表）。
 *
 * 为什么必须是表而不是 `job.error` 原样贴：用户看到的是 `failed` / `http-404` / `bad-zip`
 * 这种**只有作者看得懂**的串，等于什么都没说。要求的那五类（连不上站点 / 404 / 超时 /
 * 校验失败 / 包结构不对）在这里各有独立词条；未登记的错误码也会带出码本身，
 * **绝不回落成裸 `failed`**（RELEASE-GUARD §5.5 的既有口径）。
 */
function dlFailReason(code) {
  const c = String(code == null ? "" : code).trim();
  const map = {
    // 包结构 / 校验（"装不上"里最容易被误当成网络问题的两类）
    'no-skin-json': weT("包结构不对：这个包里没有 skin.json，不是皮肤包"),
    'bad-zip': weT("包结构不对：这个 zip 已损坏（多半是上次没下完留下的缓存，已清掉），点「重试」会重新下载"),
    'not-a-zip': weT("这个文件不是 zip"),
    'unsafe-entry': weT("包里有非法路径（已整包拒绝）"),
    'too-large': weT("包太大了（上限 200 MB）"),
    'bad-skin-json': weT("包结构不对：skin.json 不是合法 JSON"),
    'bad-skin-id': weT("包结构不对：皮肤 id 不合法"),
    'unsafe-id': weT("包结构不对：皮肤 id 不合法"),
    'extract-failed': weT("包解不开（解压阶段失败），点「重试」重新下载"),
    'empty-body': weT("校验失败（站点返回了空文件），请重试"),
    // 站点 / 网络
    'fetch failed': weT("连不上站点（网络中断或 DNS/TLS 失败），已自动重试一次；再点一次「安装」即可续传"),
    'network': weT("连不上站点（网络层失败），请重试"),
    'timeout': weT("站点响应超时，请重试"),
    'submit-timeout': weT("超时：请求 150 秒没有返回，点「重试」再发一次"),
    // 4.23.6：包已经**下完**了，但"落地"（解压 / 规范化清单 / 写目录）没有发生、也没人再推进它。
    // 这就是用户遇到的死锁形态（job=done、skins/<id> 不存在、卡片永远「解压/落位中…」）。
    // 文案必须同时说清三件事：① 下载本身是成功的（别让人以为白下了）；② 失败的是落地；
    // ③ 下一步动作就是点「重试」（走本地缓存，不会重下 17 MB）。
    'install-stalled': weT("下载已完成但安装未落地，点「重试」"),
    // 4.23.6：宿主曾经回过一个 jobId（202 pending），但它**从列表里消失了** —— 宿主重启、
    // 队列被重置、job 被清理都会这样。旧实现把它当成"继续等"，于是永久转圈到 30 分钟上界。
    // 现在连续 5 次查不到就判这个码，并且**先回列表核一次 installed**（也许早装好了）。
    'job-lost': weT("下载任务已丢失，点「重试」"),
    'download-failed': weT("下载失败（站点未返回文件），请稍后重试"),
    'download-timeout': weT("下载超时（已下部分会保留，再点「安装」可续传）"),
    // 4.23.17：本地临时/成品文件被外部清理（缓存管理器 / 手工删）——连续两次都这样才报这个。
    // 文案必须说清"不是站点的问题、重试会重新下"：否则用户会以为站点挂了。
    'file-vanished': weT("下载途中本地文件被清理掉了（连续两次），点「重试」会重新下载"),
    // 4.23.17（P0-6）：期望值与 URL 不自洽（变体 URL 却拿了原画哈希）。这是**我们自己的**
    // 哈希来源错配，不是"传输传坏了"——必须与 hash-mismatch 分开说，否则排障方向就是错的。
    'hash-source-mismatch': weT("下载地址与校验哈希不是同一个文件（原画/变体的哈希搞混了），点「重试」会按正确的那一档重新下载"),
    'http-404': weT("站点上没有这个文件（404，可能正在补传/已被删除）"),
    'http-403': weT("站点拒绝访问这个文件（403，权限或签名问题）"),
    'http-500': weT("站点服务器错误（HTTP 500），不是本地问题，请稍后重试"),
    'http-502': weT("站点网关错误（HTTP 502），请稍后重试"),
    'http-503': weT("站点暂时不可用（HTTP 503），请稍后重试"),
    'host-not-allowed': weT("下载地址不在白名单里"),
    'site-off': weT("站点被关闭了（DSH_FOLIA_SITE=off）"),
    'queue-failed': weT("下载队列起不来（宿主侧异常），重启 DSH 后再试"),
    // 其它
    'not-installed': weT("这个皮肤不在本机（先安装）"),
    'skin-center-missing': weT("装皮肤中心后才能切换皮肤（见下面的安装命令）"),
    'bad-id': weT("皮肤 id 不合法"),
    'aborted': weT("已取消"),
    'cancelled': weT("已取消"),
  };
  if (Object.prototype.hasOwnProperty.call(map, c)) return map[c];
  // `size-mismatch:123/456` 这类带参数的码：按前缀归到"校验失败"
  if (/^(size|range-size)-mismatch/i.test(c)) return weT("校验失败（下到的字节数与站点声明的长度不一致，点「重试」会续传）");
  if (/^http-\d+$/i.test(c)) return weT("站点返回错误（{code}），请稍后重试", { code: c });
  if (!c || c === 'failed' || c === 'unknown') return weT("下载/安装失败（没拿到具体原因），请重试");
  // 未登记：把码本身给出来（有码总比没有强），仍然是人话句式。
  return weT("下载/安装失败：{code}", { code: c });
}

/**
 * job 的排队位置 ⇒「前面还有 N 个」。
 *
 * 4.23.18：优先读 `queuedAhead`（0 基，**只数同 kind + 同优先级档**）。旧宿主 / 合成夹具
 * 没有这个字段时才回落 `queuePos`（全局 1 基）—— 两种宿主都能显示，不会因为升级期字段
 * 缺席而变成"排队中"三个字。
 */
function dlQueueDetail(job) {
  const ahead = job && job.queuedAhead;
  if (ahead != null && Number.isFinite(Number(ahead)) && Number(ahead) >= 0) {
    return weT("排队中：前面还有 {n} 个任务", { n: Number(ahead) });
  }
  const pos = Number(job && job.queuePos) || 0;
  if (pos > 0) return weT("排队中：前面还有 {n} 个任务", { n: pos - 1 });
  return weT("排队中");
}

/** 进度明细：`a/b MB`（+ `约剩 N 秒`，只在真有速度样本时给，绝不编数字）。 */
function dlProgressDetail(job, etaSec) {
  const recv = Math.max(0, Number(job && job.received) || 0);
  const total = Math.max(0, Number(job && job.total) || 0);
  const a = (recv / 1048576).toFixed(1);
  const b = total > 0 ? (total / 1048576).toFixed(1) : "?";
  const s = Math.max(0, Math.round(Number(etaSec) || 0));
  return s > 0 ? weT("{a}/{b} MB · 约剩 {s} 秒", { a, b, s }) : weT("{a}/{b} MB", { a, b });
}

/**
 * **卡片状态机（纯函数，四个模块共用这一个判断）**。
 *
 * @param {object} [inp]
 * @param {string} [inp.id]        卡片 id（与 `inp.sub.id` 对齐）
 * @param {{id:string, at:number}|null} [inp.sub]   "正在提交"记录（点击瞬间写入，返回/超时清掉）
 * @param {object|null} [inp.job]  `dlJobForCard()` 匹配到的队列 job
 * @param {{code:string}|null} [inp.err]            本卡片最近一次失败
 * @param {boolean} [inp.done]     本机已完成（已安装 / 已下载 / 使用中）
 * @param {number} [inp.etaSec]    预计剩余秒数（0 = 不显示）
 * @param {{idle?:string, done?:string, failed?:string}} [inp.labels] 各模块自己的词
 * @param {number} [inp.nowMs]
 * @param {number} [inp.submitTimeoutMs]
 * @param {number} [inp.installStallMs]   「done 但未落地」的宽容窗口（缺省：`dlInstallStallMs()`）
 * @param {number} [inp.installingSince]  本卡片第一次被观察到「done 但未落地」的时刻（ms，0 = 无样本）
 * @returns {{phase:string,label:string,detail:string,disabled:boolean,retry:boolean,reason:string}}
 *   `label` 是按钮文案、`detail` 是卡片上的明细行；`disabled` / `retry` 直接驱动按钮。
 */
function dlCardState(inp) {
  const o = inp || {};
  const labels = o.labels || {};
  const job = (o.job && typeof o.job === 'object') ? o.job : null;
  const now = Number(o.nowMs) || Date.now();
  const timeout = Number(o.submitTimeoutMs) || DL_SUBMIT_TIMEOUT_MS;
  const make = (phase, label, detail, disabled, retry, reason) => ({
    phase,
    label: String(label || ""),
    detail: String(detail || ""),
    disabled: Boolean(disabled),
    retry: Boolean(retry),
    reason: String(reason || ""),
  });
  const fail = (code) => {
    const why = dlFailReason(code);
    return make(DL_PHASES.FAILED, labels.failed || weT("重试"), weT("原因：{why}", { why }), false, true, why);
  };

  // ① 队列里已经在排/在下 ⇒ **先报真进度**（哪怕"提交"这个 HTTP 请求还挂在那里）。
  //
  //    为什么要排在 submitting 前面：宿主侧 `POST /folia/skins/install` 会**同步等下载**
  //    （4.23.4 起最多 8 秒才开始回 202），真实带宽下这 8 秒里 job 已经在跑。若此时仍显示
  //    「正在提交…」，真正百分比的来源被盖住 —— 那正是"点了半天没有任何进度"的旧观感。
  //    提交状态只在"还没有 job 可看"的那一小段里出现（点下去立刻有反应），两者不冲突。
  if (job && job.status === 'queued') {
    const q = dlQueueDetail(job);
    return make(DL_PHASES.QUEUED, q, q, true, false, "");
  }
  if (job && job.status === 'running') {
    return make(DL_PHASES.RUNNING, dlBusyLabel(job), dlProgressDetail(job, o.etaSec), true, false, "");
  }
  // ② 点了、请求还没回来、也还没有 job 可看 ⇒ 立刻置灰 +「正在提交…」。
  //    这一格是"点了没反应"的直接解药：它出现在点击的同一帧。
  if (o.sub && String(o.sub.id || "") === String(o.id || "")) {
    const elapsed = Math.max(0, now - (Number(o.sub.at) || now));
    const waited = Math.round(elapsed / 1000);
    if (elapsed >= timeout) return fail('submit-timeout');
    // 4.23.14：首帧反馈之后 **300ms** 还没有 queued/running ⇒ 出「提交中…（正在准备）」占位。
    // 为什么必须有：预检查/请求在冷启动或弱网下可以是几百毫秒到几秒，而旧实现这一格只有空
    // 明细行（`已等待 N 秒` 要等到 3 秒才出现）⇒ 用户看到的就是"点了没反应"。
    const detail = waited >= 3
      ? weT("已等待 {s} 秒", { s: waited })
      : (elapsed >= DL_FIRST_CLICK_PLACEHOLDER_MS ? weT("提交中…（正在准备）") : "");
    return make(DL_PHASES.SUBMITTING, weT("正在提交…"), detail, true, false, "");
  }
  // ②b 本卡片有一次**明确的失败**（提交失败 / 自动补装失败）⇒ 立刻给原因 +「重试」。
  //
  //     ⚠️ 4.23.6：这一格必须排在 ③（done 但没落地）**之前**。否则"挂载自愈打了一次安装、
  //     宿主回了 `no-skin-json` / `extract-failed`"会被 ③ 盖住 —— 卡片继续显示「解压/落位中…」，
  //     失败原因只出现在提示行（还会被下一次刷新冲掉）。用户要求"失败要显示原因（不要静默）"，
  //     而"我们刚试过、宿主明确回了错"比"队列说 done"更具体，所以它优先。
  //     它不盖正常路径：`begin()`（用户点下去）会清掉这条失败，`markOk()` 让卡片直接变 done。
  if (o.err && o.err.code) return fail(o.err.code);
  // ③ 包下完了、还没落地：宿主正在解压 / 规范化清单 / 写目录。
  //
  // ⚠️ 4.23.6：这一格**必须有上界**（老实现无条件映射成 installing：disabled、retry=false、
  //    无超时 ⇒ 永久卡住）。口径：
  //      · `installingSince` = 本卡片**第一次被观察到"done 但未落地"**的时刻（useDlCards 记的），
  //        或宿主给的时间锚；缺省 0 = 还没有观察样本 ⇒ 仍显示 installing（不无端判失败）。
  //      · 超过 `installStallMs`（默认 90 秒，见 dlInstallStallMs）⇒ failed +「重试」。
  //    为什么用"观察起点"而不是 job 的完成时间：jobs.json 里只有 `at`（入队时间），没有完成时间；
  //    而重开面板这一动作本身就说明"上一轮收尾没了"——秒表从这一刻起算足够，也不会把一个
  //    真在解压的大家伙（3 秒内）误判成失败。
  if (job && job.status === 'done' && !o.done) {
    const stallMs = Number(o.installStallMs) || dlInstallStallMs();
    const since = Number(o.installingSince) || 0;
    if (since > 0 && now - since >= stallMs) return fail('install-stalled');
    return make(DL_PHASES.INSTALLING, weT("解压/落位中…"), "", true, false, "");
  }
  // ④ 已经装好（或已下载）：按钮不再可点。
  if (o.done) return make(DL_PHASES.DONE, labels.done || weT("已安装"), "", true, false, "");
  // ⑤ 失败：队列里那条 job 自己失败了（`o.err` 已在 ②b 处理，不再重复）。
  if (job && (job.status === 'failed' || job.status === 'cancelled')) return fail(job.error || job.status);
  // ⑥ 什么也没发生。
  return make(DL_PHASES.IDLE, labels.idle || weT("下载"), "", false, false, "");
}

/** 入队（幂等：同一 URL 宿主只有一个 job）。返回 job 快照；链路不可用返回 null。 */
async function dlEnqueue(kind, url, priority) {
  try {
    const resp = await apiPostJson("/downloads/add", { items: [{ kind, url, priority: priority || "high" }] }, { parse: "always" });
    const items = (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items : [];
    return (items[0] && items[0].job) || null;
  } catch { return null; }
}

/**
 * 等一个 job 结束（done / failed / cancelled / timeout / **lost**）。
 * 只读 list，所以**页面切走也不影响**：换成别的页签时这个等待仍在跑，回来时状态照样正确。
 *
 * `lost`（4.23.6）= **列表里连续 `DL_JOB_MISS_LIMIT` 次都查不到这条 jobId**。这必须当成失败，
 * 不能当成"再等等"：宿主重启 / 队列被重置 / job 被清理之后，那条 jobId 再也不会回来，
 * 旧实现会一路静默转圈到 30 分钟上界（用户看到的就是"卡片永远在解压/落位中…"）。
 * 计数只在**成功拿到列表**时累加：`/downloads/list` 自己请求失败不算"查不到"（那不是证据）。
 */
function dlAwaitJob(jobId, timeoutMs) {
  const limit = Number(timeoutMs) || 30 * 60 * 1000;
  const started = Date.now();
  return new Promise((resolve) => {
    let misses = 0;
    const tick = async () => {
      if (Date.now() - started > limit) { resolve({ status: "timeout" }); return; }
      let job = null;
      let listed = false;
      try {
        const resp = await apiJson("/downloads/list");
        const doc = (resp && resp.data) || resp || {};
        const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
        job = jobs.find((j) => j && j.id === jobId) || null;
        listed = true;
      } catch { /* 拉不到就再等一拍（不算"查不到"） */ }
      if (job && (job.status === "done" || job.status === "failed" || job.status === "cancelled")) { resolve(job); return; }
      if (listed) {
        if (!job) {
          misses += 1;
          if (misses >= DL_JOB_MISS_LIMIT) { resolve({ status: "lost", jobId }); return; }
        } else {
          misses = 0;   // 查到了（哪怕还在跑）⇒ 连续计数清零
        }
      }
      setTimeout(tick, DL_POLL_MS);
    };
    tick();
  });
}

/* ── 「第一下就必须有反应」（4.23.14）────────────────────────────────────────
 *
 * 真实故障（用户实测）：皮肤卡片的「安装」**第一下点击没有任何反馈**，第二下才有反应。
 *
 * 定因（三条，都能测）：
 *   ① 旧顺序是 `cards.begin(id)` 后**立刻** `await skinInstalledNow(id)` —— 一次
 *      `/folia/skins/list` 往返。本机实测：冷启动 **555.7 ms**、热态 **41.9–44.0 ms**
 *      （5 次采样，见交付报告）。可这期间用户能看到的**唯一**变化是 React 的一次提交。
 *   ② 那一次提交不是"同一 tick"的 DOM 变化：`begin()` 只是排了 `setSub` / `setNonce`，
 *      要等 React 在事件回调让出后重渲染、浏览器再画一帧。请求再慢一点（冷启动/弱网），
 *      用户的第一印象就是"我点了，但屏幕没动"。
 *   ③ 300ms 后仍没有 queued/running 时，卡片明细行本来就是空的（`已等待 N 秒` 要到 3 秒
 *      才出现）⇒ 慢请求 = 完全静默。
 *
 * 三条修法（四类入口共用，见下面三个函数 + `dlInstallClick`）：
 *   · `dlFirstClickFeedback()`：点击的**第一行**就改 DOM（卡片 pressed / `aria-busy` /
 *     按钮文案「正在提交…」），不 await、不发网络、不依赖 React 提交；
 *   · `dlInstallPrecheckPlan()`：预检查**只在清单说已 installed===true** 时才做（其余情况
 *     直接发安装请求）；真做时也走 `dlPrecheckWithTimeout()`，**1.5s 超时后照常发请求**；
 *   · `DL_FIRST_CLICK_PLACEHOLDER_MS`（300ms）后仍未进入队列 ⇒ 出「提交中…（正在准备）」。
 */
const DL_PRECHECK_TIMEOUT_MS = 1500;
const DL_FIRST_CLICK_PLACEHOLDER_MS = 300;

/**
 * 点击瞬间的**纯视觉**反馈：卡片 pressed + `aria-busy` + 按钮文案（可选）。
 *
 * 只碰 DOM：没有 await、没有网络、没有 React 提交 —— 所以第一处视觉变化与点击同一个 tick。
 * 返回 `restore()`（幂等）：撤掉本次加上的 class / aria-busy。**不撤文案与 disabled**：
 * 那两项随后由 React 的重渲染接管（若在这里恢复，会把 React 刚写上的新文案/新禁用态盖回去）。
 *
 * @param {any} el   被点的元素（事件里的 `currentTarget` 即可；也可以是卡片本身）
 * @param {string} [text] 按钮要立即变成的文案（不传就只做 pressed / aria-busy）
 * @returns {null | (() => void)}
 */
function dlFirstClickFeedback(el, text) {
  const node = (el && typeof el === "object") ? el : null;
  if (!node) return null;
  const saved = { node, card: null, cardCls: false, aria: null, hasAria: false, btn: null, btnCls: false, btnTextNode: null, btnText: null, btnDisabled: false };
  try {
    // 卡片级 pressed：从按钮往上找**这张卡**（皮肤/开机动画/桌宠卡带 we-dl-card；
    // 壁纸库/快捷面板是 we-picker__card / we-qp__item / we-qp__card）。
    let card = null;
    try {
      if (typeof node.closest === "function") card = node.closest(".we-dl-card, .we-picker__card, .we-qp__item, .we-qp__card");
    } catch { card = null; }
    if (!card && node.classList && typeof node.classList.contains === "function") {
      for (const cls of ["we-dl-card", "we-picker__card", "we-qp__item", "we-qp__card"]) {
        if (node.classList.contains(cls)) { card = node; break; }
      }
    }
    const target = card || node;
    if (target.classList && typeof target.classList.add === "function") {
      target.classList.add("we-first-click");
      saved.card = target;
      saved.cardCls = true;
    }
    if (typeof node.setAttribute === "function") {
      saved.hasAria = true;
      saved.aria = typeof node.getAttribute === "function" ? node.getAttribute("aria-busy") : null;
      node.setAttribute("aria-busy", "true");
    }
    // 按钮：如果被点的就是按钮，直接用它；否则在卡片里找第一颗按钮。
    let btn = null;
    try {
      if (String(node.tagName || "").toUpperCase() === "BUTTON") btn = node;
      else if (typeof node.querySelector === "function") btn = node.querySelector("button");
    } catch { btn = null; }
    if (btn) {
      saved.btn = btn;
      saved.btnDisabled = Boolean(btn.disabled);
      if (typeof text === "string" && text) {
        const first = btn.firstChild;
        // ⚠️ 必须改**React 持有的那个文本节点**（firstChild.nodeValue），不能用 textContent：
        // 后者会把整颗文本节点换掉，React 之后更新的是旧节点 ⇒ 文案会永远卡在「正在提交…」。
        if (first && first.nodeType === 3 && typeof first.nodeValue === "string") {
          saved.btnTextNode = first;
          saved.btnText = first.nodeValue;
          first.nodeValue = text;
        } else if (typeof btn.textContent === "string") {
          btn.textContent = text;
        }
      }
      if (btn.classList && typeof btn.classList.add === "function") {
        btn.classList.add("we-first-click-btn");
        saved.btnCls = true;
      }
      btn.disabled = true;
    }
  } catch { return null; }
  let restored = false;
  return function restore() {
    if (restored) return;
    restored = true;
    try { if (saved.card && saved.cardCls && saved.card.classList && saved.card.classList.remove) saved.card.classList.remove("we-first-click"); } catch { /* ignore */ }
    try {
      if (saved.hasAria) {
        if (saved.aria == null) { if (typeof saved.node.removeAttribute === "function") saved.node.removeAttribute("aria-busy"); }
        else if (typeof saved.node.setAttribute === "function") saved.node.setAttribute("aria-busy", saved.aria);
      }
    } catch { /* ignore */ }
    try { if (saved.btn && saved.btnCls && saved.btn.classList && saved.btn.classList.remove) saved.btn.classList.remove("we-first-click-btn"); } catch { /* ignore */ }
    // 不恢复 `btnTextNode.nodeValue` / `btn.disabled`：React 随后会用真实状态覆盖它们，
    // 在这里抢着写回去反而会盖掉「已安装 / 重试 / 已禁用」这些新事实。
  };
}

/**
 * 预检查**要不要做**（纯函数，负对照直接喂）。
 *
 * 口径（4.23.14）：只有清单已经说这套 **installed === true** 时才做 —— 那种情况下"再发一次
 * 安装请求"确实可能把刚装好的目录删了重写。清单说没装（绝大多数首次点击）时**不做**：
 * 那一次 `/skins/list` 往返正是第一击"没反应"的来源，而宿主 `/skins/install` 自己对
 * `exists` 是幂等的（目录已有 skin.json 直接回 `exists:true`），没有必须前置查的理由。
 *
 * @param {boolean} installed
 * @returns {{ precheck: boolean }}
 */
function dlInstallPrecheckPlan(installed) {
  return { precheck: installed === true };
}

/**
 * 带**硬超时**的预检查。返回 `'hit' | 'miss' | 'timeout'`（timeout 之后调用方**照常发请求**）。
 * `timers` 只为测试注入（默认全局 setTimeout/clearTimeout）；生产路径不传。
 */
function dlPrecheckWithTimeout(fn, timeoutMs, timers) {
  const ms = Math.max(0, Number(timeoutMs) || DL_PRECHECK_TIMEOUT_MS);
  if (typeof fn !== "function") return Promise.resolve("miss");
  const t = timers || {};
  const setT = typeof t.setTimeout === "function" ? t.setTimeout : setTimeout;
  const clearT = typeof t.clearTimeout === "function" ? t.clearTimeout : clearTimeout;
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (verdict) => {
      if (done) return;
      done = true;
      if (timer !== null) { try { clearT(timer); } catch { /* ignore */ } }
      resolve(verdict);
    };
    try { timer = setT(() => finish("timeout"), ms); } catch { timer = null; }
    Promise.resolve()
      .then(() => fn())
      .then((v) => finish(v === true ? "hit" : "miss"))
      .catch(() => finish("miss"));
  });
}

/**
 * 「提交中…（正在准备）」占位的**唯一判断**：首帧反馈后 300ms，仍没有 queued/running ⇒ 出这句。
 * @param {{waitedMs?:number, jobActive?:boolean}} [o]
 * @returns {string} 占位文案（空串 = 不显示）
 */
function dlPreparingHint(o) {
  const x = o || {};
  if (x.jobActive === true) return "";
  const waited = Math.max(0, Number(x.waitedMs) || 0);
  if (waited < DL_FIRST_CLICK_PLACEHOLDER_MS) return "";
  return weT("提交中…（正在准备）");
}

/**
 * **安装/下载按钮的统一点击流程**（皮肤 / 开机动画 / 桌宠共用一个实现）。
 *
 * 顺序是判据，不是风格：**先同步视觉反馈** → 再交给卡片状态机（submitting）→ 再预检查
 * （只在 `installed === true` 时）→ 最后才发请求。把"先 await 预检查再反馈"写回来，第一击
 * 就又会静默（`test/verify-first-click-feedback.mjs` 的负对照钉着这一点）。
 *
 * @param {object} o
 * @param {any} [o.el]        被点的元素（`ev.currentTarget`）
 * @param {string} [o.btnText] 按钮立即变成的文案（缺省「正在提交…」）
 * @param {boolean} [o.installed] 清单里是否已装（决定要不要预检查）
 * @param {() => void} [o.begin]  卡片状态机入口（`cards.begin(id)`）
 * @param {() => void} [o.onSubmitting] 立即写一句提示（可选）
 * @param {(text:string) => void} [o.onPreparing] 300ms 占位（可选）
 * @param {() => boolean} [o.jobActive]  300ms 时队列里已有本卡片的 queued/running 吗
 * @param {() => Promise<boolean>} [o.precheck] 预检查（只在 installed===true 时调用）
 * @param {number} [o.precheckMs] 预检查超时（默认 1.5s）
 * @param {() => Promise<any>} [o.submit] 真正的安装/下载请求
 * @param {object} [o.timers] 测试注入的定时器
 * @returns {Promise<{precheck:string, skipped:boolean, resp:any, placeholder:string, startedAt:number}>}
 */
async function dlInstallClick(o) {
  const x = o || {};
  const timers = x.timers || {};
  const setT = typeof timers.setTimeout === "function" ? timers.setTimeout : setTimeout;
  const clearT = typeof timers.clearTimeout === "function" ? timers.clearTimeout : clearTimeout;
  const startedAt = Date.now();
  // ① **同步**视觉反馈：第一行，纯 DOM，不 await、不网络。
  const restore = dlFirstClickFeedback(x.el, typeof x.btnText === "string" ? x.btnText : weT("正在提交…"));
  // ② 卡片状态机：submitting（React 的提交在下一次让出时，晚于上面那一行）。
  if (typeof x.begin === "function") { try { x.begin(); } catch { /* 状态层失败不挡住提交 */ } }
  if (typeof x.onSubmitting === "function") { try { x.onSubmitting(); } catch { /* 提示失败不影响提交 */ } }
  let settled = false;
  let placeholderText = "";
  let timer = null;
  try {
    // ③ 300ms 还没进入 queued/running ⇒ 出占位（慢请求不许静默）。
    try {
      timer = setT(() => {
        if (settled) return;
        let jobActive;
        try { jobActive = typeof x.jobActive === "function" ? x.jobActive() === true : false; } catch { jobActive = false; }
        // 这一枪本来就是 300ms 那一拍 ⇒ 用「至少 300ms」参与判断：测试换可控定时器时时间不会真的走，
        // 而生产路径上 Date.now()-startedAt 也必然 ≥ 300（定时器不会提前触发）。
        const hint = dlPreparingHint({ waitedMs: Math.max(Date.now() - startedAt, DL_FIRST_CLICK_PLACEHOLDER_MS), jobActive });
        if (!hint) return;
        placeholderText = hint;
        try { if (typeof x.onPreparing === "function") x.onPreparing(hint); } catch { /* ignore */ }
      }, DL_FIRST_CLICK_PLACEHOLDER_MS);
    } catch { timer = null; }
    // ④ 预检查（只有清单说已装才做；1.5s 超时后照常发请求）。
    const plan = dlInstallPrecheckPlan(x.installed);
    let precheck = "skipped";
    if (plan.precheck) {
      precheck = await dlPrecheckWithTimeout(x.precheck, x.precheckMs, timers);
      if (precheck === "hit") {
        return { precheck, skipped: true, resp: null, placeholder: placeholderText, startedAt };
      }
    }
    // ⑤ 真正的请求。
    const resp = typeof x.submit === "function" ? await x.submit() : null;
    return { precheck, skipped: false, resp, placeholder: placeholderText, startedAt };
  } finally {
    settled = true;
    if (timer !== null) { try { clearT(timer); } catch { /* ignore */ } }
    try { if (typeof restore === "function") restore(); } catch { /* ignore */ }
  }
}

/* ── 播放失败自愈（4.23.15）：本地副本坏了吗？还是本机解不了？ ──────────────────
 *
 * 真实故障（另一台机器）：壁纸显示「视频解码失败（文件可能已损坏）」/「浏览器无法解码这段
 * 视频」，而面板同时说"缓存命中 4/5"。播放路径直接读本地文件、**没有任何自检** ——
 * 4.23.6 之前 ranged 静默损坏遗留的坏成品会永久留在 library 里，每次点都是那句错误。
 *
 * 这一族只做客户端这一半：**判"要不要惊动宿主"** + **把宿主结论翻成人话**。
 * 真正的取证（sha256 / 结构 / 重下 / 换档 / 转码）在宿主 `lib/media-selfheal.js`，
 * 因为浏览器没有磁盘、也没有站点清单。
 *
 * 为什么客户端能判断"要不要惊动宿主"：只有**本地副本**才值得验。远端字节我们既不能证明
 * 坏、也不能替站点重下（那只会让用户白等一次同样的解码失败）。
 */

/** 每条壁纸最多自愈几次。超过就只提示 —— 防"每次 error 都重下"的死循环。 */
const LF_HEAL_MAX_TRIES = 2;
/** 轮询救援产物/重下的间隔与上限（转码是几十秒级的，给 3 分钟）。 */
const LF_HEAL_POLL_MS = 1500;
const LF_HEAL_POLL_MAX_MS = 3 * 60 * 1000;

/** 每个壁纸 id 已经自愈过几次（会话内；刷新页面重新计数是合理的）。 */
const LF_HEAL_TRIES = new Map();

/** 自愈要用到的两个宿主动作：提示位（面板那一行）与"重挂播放"（把新地址装回 <video>）。 */
const LF_HEAL_HOOKS = { note: null, mount: null };

/**
 * client.js 注入：`note(text, ok)` 写面板提示；`mount(url)` 把播放器重挂到新地址（返回是否成功）。
 *
 * 为什么是注入而不是直接调：`local-first.js` 是**内联进同一个工厂作用域**的片段，
 * 但"提示位"与"哪个 <video> 在屏上"都只有 `src/client.js` 的正文知道；
 * 硬编码调用会把这条依赖变成隐式的循环（client.js ← local-first.js ← client.js）。
 */
function setSelfHealHooks(note, mount) {
  LF_HEAL_HOOKS.note = typeof note === "function" ? note : null;
  LF_HEAL_HOOKS.mount = typeof mount === "function" ? mount : null;
}

function lfHealSay(text, ok) {
  try { if (LF_HEAL_HOOKS.note) LF_HEAL_HOOKS.note(text, ok !== false); } catch { /* 提示失败不影响自愈 */ }
}

/**
 * 这个播放地址是不是**本地副本**（`/folia/local-media/<id>` 或 library 目录直出）。
 *
 * 只认本地：远端 URL 的自愈没有意义（见上面那段"为什么客户端能判断"）。
 */
function lfIsLocalMediaUrl(url) {
  const s = String(url || "");
  if (!s) return false;
  if (/\/folia\/local-media\//.test(s)) return true;
  // 直出形态（旧宿主 / 排障时手工拼的地址）：`.../library/<kind>/<hash>.mp4`
  return /\/library\/[^/]+\/[0-9a-f]{16,}\./i.test(s);
}

/**
 * **要不要惊动宿主**（纯函数；判据见 `test/verify-media-selfheal.mjs`）。
 *
 * 只处理两件事都成立的那一格：① 播的是**本地副本**；② 错误码是**解码/源不支持**
 * （3 = DECODE，4 = SRC_NOT_SUPPORTED）。网络类（2 NETWORK）与中断类（1 ABORTED）
 * **不走自愈** —— 它们是"这一下没传完"，重下只会把一份好文件换掉。
 *
 * 返回 `'heal'`（去验）/ `'skip'`（不动）。
 * @param {{ isVideo?: boolean, url?: string, code?: number, tries?: number, maxTries?: number }} [inp]
 * @returns {'heal' | 'skip'}
 */
function dlHealPlan(inp) {
  const o = inp || {};
  if (o.isVideo === false) return "skip";
  if (!lfIsLocalMediaUrl(o.url)) return "skip";
  const code = Number(o.code) || 0;
  if (code !== 3 && code !== 4) return "skip";
  const max = Number(o.maxTries) > 0 ? Number(o.maxTries) : LF_HEAL_MAX_TRIES;
  if ((Number(o.tries) || 0) >= max) return "skip";
  return "heal";
}

/**
 * 宿主的处置结论 → 一句**具体**的人话（纯函数）。
 *
 * 为什么每个结论一句不同的话：用户看到的三种情况看起来一模一样（都停在首帧/报错），
 * 但该做的事完全不同 —— 「已重新下载」是等它，「已切换 1080p」是等它，「本机不支持该编码」
 * 是**换一张**。用同一句"视频无法播放"会让用户反复点同一张。
 *
 * @param {string} verdict
 * @returns {string}
 */
function dlHealNote(verdict) {
  const v = String(verdict || "");
  if (v === "corrupt") return weT("文件已损坏，已重新下载");
  if (v === "variant") return weT("已切换到 1080p（原画超出本机解码上限）");
  if (v === "transcoded") return weT("已切换到 1080p（原画超出本机解码上限）");
  if (v === "transcoding") return weT("正在生成可播放副本…");
  if (v === "undecodable") return weT("本机不支持该编码（可换一张跳过此壁纸）");
  if (v === "undecodable-no-variant") return weT("该壁纸分辨率/编码超出本机解码能力（可换一张跳过此壁纸）");
  return "";
}

/** 这个结论是不是"还在路上"（要轮询），还是已经到达终态。 */
function dlHealPending(verdict) {
  const v = String(verdict || "");
  return v === "corrupt" || v === "variant" || v === "transcoding";
}

/**
 * 转码进度 → 一句**带数字**的话（用户明确要求：「转码期间必须有可见进度，不许静默」）。
 *
 * 为什么必须有 percent：整片重编码是几十秒到几分钟级，而此刻屏上是黑的 ——
 * **没有数字的等待与卡死没有区别**。eta 拿不到就只说百分比（不编数字）。
 * 也绝不报 100%：最后那一下是 rename + 校验，说满了却还没出画会让人更不信。
 *
 * @param {{ percent?: number, eta?: number | null } | null} [progress]
 * @returns {string}
 */
function dlHealProgressNote(progress) {
  const pct = Math.max(0, Math.min(99, Math.round(Number(progress && progress.percent) || 0)));
  const eta = Number(progress && progress.eta);
  if (eta > 0 && isFinite(eta)) {
    return weT("正在生成本机可播放副本 {percent}%（约剩 {eta} 秒）", { percent: pct, eta: Math.max(1, Math.round(eta)) });
  }
  return weT("正在生成本机可播放副本 {percent}%", { percent: pct });
}

/**
 * **"这张壁纸最终怎么上屏"的最后一级**（纯函数）：转码也救不回来时，静态帧兜底。
 *
 * 需求原文（用户最终目标）：**任何一张壁纸，只要站点上有可用文件，最终都必须能上屏** ——
 * 「只有连静态帧都没有，才允许显示无法显示」。所以这里是两级，不是一级：
 *   `static-frame`    —— 有缩略图/首帧 ⇒ 拿它当静态壁纸（画面是那张图，能看见）
 *   `cannot-display`  —— 连图都没有 ⇒ 这时才允许说"无法显示"
 *   `''`              —— 这个结论不归它管（corrupt/variant/transcoded 都还有得救）
 *
 * @param {{ verdict?: string, hasPreview?: boolean }} [inp]
 * @returns {'' | 'static-frame' | 'cannot-display'}
 */
function dlHealFallbackPlan(inp) {
  const o = inp || {};
  const v = String(o.verdict || "");
  if (v !== "undecodable" && v !== "undecodable-no-variant") return "";
  return o.hasPreview === true ? "static-frame" : "cannot-display";
}

/**
 * 等一条 job 落地（**只回答"盘上有这份成品了吗"**）。
 * 复用 `dlAwaitJob` 的轮询口径：done ⇒ true；failed/cancelled/消失 ⇒ false。
 * @param {string} jobId
 * @param {(n: number) => void} [onTick] 每次轮询回调（界面显示进度用）
 * @returns {Promise<boolean>}
 */
async function lfAwaitHealJobP(jobId, onTick) {
  const id = String(jobId || "");
  if (!id) return false;
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > LF_HEAL_POLL_MAX_MS) return false;
    let job = null;
    try {
      const resp = await apiJson("/downloads/list");
      const jobs = (resp && resp.data && Array.isArray(resp.data.jobs)) ? resp.data.jobs
        : (Array.isArray(resp && resp.jobs) ? resp.jobs : []);
      job = jobs.find((j) => j && j.id === id) || null;
    } catch { /* 网络抖动：下一拍再试 */ }
    if (job) {
      if (job.status === "done") return true;
      if (job.status === "failed" || job.status === "cancelled") return false;
      if (typeof onTick === "function") { try { onTick(Number(job.percent) || 0); } catch { /* ignore */ } }
    }
    await new Promise((r) => { const t = setTimeout(r, LF_HEAL_POLL_MS); try { if (t && t.unref) t.unref(); } catch { /* ignore */ } });
  }
}

/**
 * **播放失败自愈的客户端入口**（`<video>` 报 error → 这里）。
 *
 * 流程：判要不要去 → `POST /folia/local-heal` → 按结论：
 *   corrupt / variant ⇒ 拿新 jobId 等它落地 ⇒ 重挂播放（同一张壁纸的下一次播就是好的）
 *   transcoding      ⇒ 轮询同一个接口直到出片（宿主在后台转，重复调用会命中同一份在途任务）
 *   transcoded       ⇒ 立刻重挂到 `?playable=1`
 *   undecodable*     ⇒ 只提示（+ 建议换一张），不再重试
 *
 * 返回最终结论（供调用点写 `selection.videoError`）。**不抛**：自愈失败也只是一句提示，
 * 绝不把"播放已经坏了"的现场升级成"连界面都炸了"。
 *
 * @param {{ id?: string, url?: string, code?: number, isVideo?: boolean,
 *   originUrl?: string, sha256?: string, variants?: any[], base?: string,
 *   title?: string, playing1080p?: boolean }} [fail]
 * @returns {Promise<{ verdict: string, message: string, mounted: boolean }>}
 */
async function lfHealPlayback(fail) {
  const f = fail || {};
  const key = String(f.id || f.url || "");
  const tried = Number(LF_HEAL_TRIES.get(key) || 0);
  const plan = dlHealPlan({ isVideo: f.isVideo !== false, url: f.url, code: f.code, tries: tried });
  if (plan === "skip") return { verdict: "skip", message: "", mounted: false };
  LF_HEAL_TRIES.set(key, tried + 1);
  const label = String(f.title || f.id || "");
  const mount = LF_HEAL_HOOKS.mount;
  /**
   * 结论 + 这张壁纸的标题（一句整话，交给词表插值）。
   * ⚠️ 不能写成 `text + "：" + label`：那会被 i18n 门禁判成"半句话"（模板/拼接），
   * 而且英文语序里那个全角冒号本来就是错的。
   */
  const withLabel = (text) => (label ? weT("{text} · {label}", { text: String(text || ""), label }) : String(text || ""));
  /** 把本体结论写成人话并试着重挂。 */
  const finish = async (res) => {
    const verdict = String((res && res.verdict) || "");
    if (verdict === "transcoding") {
      // 带数字的那一句（percent/eta 由宿主的 `transcodePlayableProgress` 给）。
      lfHealSay(withLabel(dlHealProgressNote(res && res.progress)), true);
      return { verdict, message: dlHealNote(verdict), mounted: false };
    }
    const message = dlHealNote(verdict);
    if (verdict === "corrupt" || verdict === "variant") {
      // 等它（单流重下 / 1080p 变体）落地，再重挂播放。
      const ok = await lfAwaitHealJobP(res.jobId);
      if (!ok) {
        const t = weT("重新获取失败（可稍后再点一次这张）");
        lfHealSay(t, false);
        return { verdict: "failed", message: t, mounted: false };
      }
      const url = res.url || (res.jobId ? "/folia/local-media/" + encodeURIComponent(String(res.jobId)) : "");
      const done = Boolean(url && mount && mount(url));
      lfHealSay(withLabel(message), true);
      return { verdict, message: (res && res.mode === "fps") ? weT("已切换到 30fps 副本（原画 60fps 超出本机解码能力，分辨率不变）") : message, mounted: done };
    }
    if (verdict === "transcoded") {
      // 降帧档与缩分辨率档的文案不同（用户要能看懂"为什么降"）。
      const msg = (res && res.mode === "fps")
        ? weT("已切换到 30fps 副本（原画 60fps 超出本机解码能力，分辨率不变）")
        : message;
      const done = Boolean(res.url && mount && mount(res.url));
      lfHealSay(withLabel(msg), true);
      return { verdict, message: (res && res.mode === "fps") ? weT("已切换到 30fps 副本（原画 60fps 超出本机解码能力，分辨率不变）") : message, mounted: done };
    }
    lfHealSay(withLabel(message), false);
    return { verdict: verdict || "error", message, mounted: false };
  };
  try {
    let res = await apiPostJson("/local-heal", {
      id: String(f.id || ""),
      localUrl: String(f.url || ""),
      originUrl: String(f.originUrl || ""),
      sha256: String(f.sha256 || ""),
      variants: Array.isArray(f.variants) ? f.variants : [],
      base: String(f.base || ""),
      title: label,
      playing1080p: f.playing1080p === true,
    }, { parse: "always" });
    let doc = (res && res.data) || res || {};
    let out = await finish(doc);
    // 转码是几十秒级的：宿主先回 `transcoding`，这里按它给的间隔继续问同一个接口，
    // 直到出片或超过上限。每次调用都命中宿主那份**在途**任务，不会重复起 ffmpeg。
    let waited = 0;
    while (out.verdict === "transcoding" && waited < LF_HEAL_POLL_MAX_MS) {
      const step = Math.max(500, Number(doc && doc.retryAfterMs) || LF_HEAL_POLL_MS);
      await new Promise((r) => { const t = setTimeout(r, step); try { if (t && t.unref) t.unref(); } catch { /* ignore */ } });
      waited += step;
      res = await apiPostJson("/local-heal", {
        id: String(f.id || ""), localUrl: String(f.url || ""), sha256: String(f.sha256 || ""),
        variants: Array.isArray(f.variants) ? f.variants : [], base: String(f.base || ""),
        title: label, playing1080p: f.playing1080p === true,
      }, { parse: "always" });
      doc = (res && res.data) || res || {};
      out = await finish(doc);
    }
    if (out.verdict === "transcoding") {
      const t = weT("转码超时（可稍后再点一次这张，宿主会接着上次的进度）");
      lfHealSay(t, false);
      return { verdict: "timeout", message: t, mounted: false };
    }
    return out;
  } catch (err) {
    // 老宿主没有这条路由 / 网络问题：只说一句，播放器照旧留着那句原始错误。
    return { verdict: "error", message: String((err && err.message) || err || ""), mounted: false };
  }
}

/**
 * React：订阅下载队列（三个页签共用）。
 * 挂载先拉一次；有未结束 job 才每 1.5s 拉；**卸载即清定时器**（切页签不泄漏）。
 * `refresh()` 用于"刚点了下载"——立刻重新起表，不必等下个 1.5s。
 */
function useDownloadJobs() {
  const [jobs, setJobs] = React.useState([]);
  // 4.23.6：「done 但没落地」的宽容窗口由**宿主**解析（浏览器里没有 process.env），
  // 随列表一起下发；拿不到就用 dlInstallStallMs() 的本地默认（同一个 90 秒）。
  const [installStallMs, setInstallStallMs] = React.useState(0);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    let timer = null;
    const stop = () => {
      if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; }
    };
    const pull = async () => {
      let list;
      let stall = 0;
      try {
        const resp = await apiJson("/downloads/list");
        const doc = (resp && resp.data) || resp || {};
        list = Array.isArray(doc.jobs) ? doc.jobs : [];
        stall = Number(doc.installStallMs) || 0;
      } catch { list = []; }
      if (!alive) return;
      setJobs(list);
      if (stall > 0) setInstallStallMs(stall);
      if (!dlHasActive(list)) stop();      // 全部结束 ⇒ 停表
    };
    pull();
    timer = setInterval(pull, DL_POLL_MS);
    try { if (timer && typeof timer.unref === "function") timer.unref(); } catch { /* ignore */ }
    return () => { alive = false; stop(); };
  }, [nonce]);
  return { jobs, installStallMs, refresh: () => setNonce((n) => n + 1) };
}

/**
 * React：**卡片级**状态层（4.23.4，四个页签共用）。
 *
 * 与 `useDownloadJobs()` 的分工：那个只回答"队列里现在有哪些 job"（真源）；
 * 这个回答"**这张卡片**此刻处在哪一格"—— 它额外记住三件只有组件才知道的事：
 *   ① 「正在提交」：点击瞬间写入（`begin`），请求返回/超时清掉（`end`）⇒ 请求在飞也不静默；
 *   ② 「本卡片的失败原因」：`fail(id, code)` 写的，卡片上带原因 +「重试」；
 *   ③ 「预计剩余秒数」：按最近 4 秒的字节增量估，样本不足就不给数字。
 *
 * 为什么"提交中要自己拉表"：`useDownloadJobs` 在列表里没有 queued|running 时会**停表**
 * （省电、不空转）。而"刚点下去、job 还没入队"正好落在这个停表窗口里 ⇒ 卡片会卡在
 * 「正在提交…」。所以提交期间由本 hook 负责每 1.5s 调一次 `dl.refresh()`。
 */
function useDlCards(dl) {
  const [sub, setSub] = React.useState(null);
  const [errs, setErrs] = React.useState({});
  const [okIds, setOkIds] = React.useState({});
  const [eta, setEta] = React.useState({});
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const samplesRef = React.useRef(new Map());
  /**
   * 4.23.6：「done 但没落地」的**观察锚**。`id → { sig, at, expired }`
   *   · `sig`      这张卡片当前匹配到的那条 job 的标识（换 job = 重新起表）；
   *   · `at`       第一次被观察到"下完没落地"的时刻（超时就是 now - at）；
   *   · `expired`  已经判过超时（ticker 据此停表，不空转；卡片仍停在 failed +「重试」）。
   * 为什么必须记在**组件里**而不是读宿主的完成时间：jobs.json 只存 `at`（入队时刻），
   * 没有完成时刻；而"面板重新挂载"本身就是上一轮收尾没了的信号。
   */
  const stallRef = React.useRef(new Map());
  const refreshRef = React.useRef(null);
  refreshRef.current = dl && typeof dl.refresh === "function" ? dl.refresh : null;

  // ① 提交中每秒走一格：「已等待 N 秒」与"到点即失败"都要它。只有提交中才开表。
  React.useEffect(() => {
    if (!sub || !sub.id) return undefined;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    try { if (t && typeof t.unref === "function") t.unref(); } catch { /* ignore */ }
    return () => { try { clearInterval(t); } catch { /* ignore */ } };
  }, [sub]);

  // ①b 「下完但没落地」的秒表（4.23.6）：超时判 failed 需要**时间在走**。
  //
  //    ⚠️ 不能指望 `useDownloadJobs` 的 1.5s 表：它在列表里没有 queued|running 时会**停表**，
  //    而"done 但没落地"正好落在这个停表窗口里 —— 没有重渲染，90 秒的超时永远不会触发
  //    （那是"永久卡在解压/落位中…"的另一种写法，等价于没修）。
  //    这条秒表只在**本页确实有停滞卡片**时才 setState；没有停滞卡片时它什么也不做
  //    （不重渲染、不耗电），所以可以常驻。
  React.useEffect(() => {
    const t = setInterval(() => {
      let live = false;
      for (const e of stallRef.current.values()) { if (e && !e.expired) { live = true; break; } }
      if (live) setNowMs(Date.now());
    }, 1000);
    try { if (t && typeof t.unref === "function") t.unref(); } catch { /* ignore */ }
    return () => { try { clearInterval(t); } catch { /* ignore */ } };
  }, []);

  // ② 提交期间自己把队列列表拉起来（见上面"停表窗口"的说明），避免卡在「正在提交…」。
  React.useEffect(() => {
    if (!sub || !sub.id) return undefined;
    const t = setInterval(() => { try { if (refreshRef.current) refreshRef.current(); } catch { /* ignore */ } }, DL_POLL_MS);
    try { if (t && typeof t.unref === "function") t.unref(); } catch { /* ignore */ }
    return () => { try { clearInterval(t); } catch { /* ignore */ } };
  }, [sub]);

  // ③ ETA：只用**最近 4 秒**的增量（整段平均会被起跑阶段拖低，越下越离谱）。
  //    样本 < 2 条、或这几秒没往前走 ⇒ 0（只显示百分比与 MB，绝不编一个假秒数）。
  const jobs = (dl && Array.isArray(dl.jobs)) ? dl.jobs : [];
  React.useEffect(() => {
    const now = Date.now();
    const next = {};
    const alive = new Set();
    for (const j of jobs) {
      if (!j || !j.id) continue;
      alive.add(j.id);
      if (j.status !== 'running') continue;
      const arr = samplesRef.current.get(j.id) || [];
      arr.push({ at: now, got: Number(j.received) || 0 });
      while (arr.length > 2 && now - arr[0].at > 4000) arr.shift();
      samplesRef.current.set(j.id, arr);
      const first = arr[0];
      const span = now - first.at;
      const got = Number(j.received) || 0;
      const total = Number(j.total) || 0;
      const speed = span > 600 ? (got - first.got) / (span / 1000) : 0;
      next[j.id] = (speed > 1024 && total > got) ? Math.max(1, Math.round((total - got) / speed)) : 0;
    }
    for (const k of [...samplesRef.current.keys()]) if (!alive.has(k)) samplesRef.current.delete(k);
    setEta(next);
  }, [dl && dl.jobs]);

  const key = (id) => String(id == null ? "" : id);

  /**
   * 这张卡片当前处在「done 但未落地」吗？在 ⇒ 返回**观察锚**（同一 job 期间稳定、跨渲染不变）。
   * 不在了（落地了 / job 换了 / 还没下完）⇒ 清掉锚并返回 0（状态机据此不启用超时）。
   */
  const stallOf = (id, job, done) => {
    const k = key(id);
    const sig = job && job.id ? String(job.id) : "";
    const pending = Boolean(job) && job.status === "done" && !done && Boolean(sig);
    if (!pending) {
      if (stallRef.current.has(k)) stallRef.current.delete(k);
      return 0;
    }
    const cur = stallRef.current.get(k);
    if (cur && cur.sig === sig) return cur.at;
    stallRef.current.set(k, { sig, at: Date.now(), expired: false });
    return stallRef.current.get(k).at;
  };

  const api = {
    jobs,
    /** 立刻重拉一次队列（"刚点了"用；不必等下个 1.5s）。 */
    refresh: () => { try { if (refreshRef.current) refreshRef.current(); } catch { /* ignore */ } },
    /** 点击瞬间：这张卡片进入 submitting（立刻置灰 +「正在提交…」），并清掉它的旧失败。 */
    begin: (id) => {
      const k = key(id);
      // 用户点了「重试」= 新的一轮安装 ⇒ 停滞秒表重新起算（否则会立刻又判一次超时）。
      try { stallRef.current.delete(k); } catch { /* ignore */ }
      setErrs((m) => {
        if (!Object.prototype.hasOwnProperty.call(m, k)) return m;
        const n = { ...m };
        delete n[k];
        return n;
      });
      setSub({ id: k, at: Date.now() });
      // 4.23.14：让「提交中…（正在准备）」在**300ms**准时出现。常驻秒表是 1 秒一拍，
      // 单靠它最快也要 ~1s；这里补一拍，与 `dlInstallClick` 的占位是同一个常量、同一句话。
      setNowMs(Date.now());
      try {
        const timer = setTimeout(() => setNowMs(Date.now()), DL_FIRST_CLICK_PLACEHOLDER_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
      } catch { /* 定时器失败不影响提交 */ }
      api.refresh();
    },
    /** 请求返回（成功/失败/超时）：退出 submitting。 */
    end: (id) => {
      const k = key(id);
      setSub((s) => (s && key(s.id) === k ? null : s));
    },
    /** 记下这张卡片的失败原因（卡片上显示人话 + 「重试」）。 */
    fail: (id, code) => { setErrs((m) => ({ ...m, [key(id)]: { code: String(code == null ? "failed" : code) } })); },
    /**
     * 本地**没有对应 job** 的卡片：清掉残留的"进行中"痕迹，让它**回落到 idle、可点安装**。
     *
     * 为什么需要它（4.23.6，Lenovo 实测）：宿主重启后队列被重置，卡片上残留的 submitting /
     * 停滞锚没有任何 job 会来推进 ⇒ 界面看起来"还在干活"，可点却是灰的（或点下去也不对）。
     * 队列里没有它，那它就不在发生 —— 界面的默认格必须是 idle（可点「安装」）。
     * ⚠️ 故意**不动** `errs`：已记录的原因（失败原因）是用户要看的，清掉等于把失败变静默。
     */
    settle: (id) => {
      const k = key(id);
      try { if (stallRef.current.has(k)) stallRef.current.delete(k); } catch { /* ignore */ }
      setSub((s) => (s && key(s.id) === k ? null : s));
    },
    /**
     * 宿主已经明确回"装好了"⇒ 这张卡片**立刻**按完成显示。
     *
     * 为什么不能只依赖下一次 `/skins/list`：站点 slug 与本机 `skin.json` 里的 id 不总相同
     * （为避撞名会加 `skin-` 前缀），归一对不上时列表里的 `installed` 会一直是 false ⇒
     * 卡片永远停在「安装」。用户点了、宿主也回了 ok，卡片就必须给出"已完成"这个结果，
     * 而不是静默回到「安装」——那正是"点了没反应"的另一种样子。
     */
    markOk: (id) => { setOkIds((m) => (m[key(id)] ? m : { ...m, [key(id)]: true })); },
    okOf: (id) => Boolean(okIds[key(id)]),
    subOf: (id) => (sub && key(sub.id) === key(id) ? sub : null),
    errOf: (id) => errs[key(id)] || null,
    etaOf: (job) => (job && job.id ? (eta[job.id] || 0) : 0),
    /** 一张卡片 → 状态。四个页签都只用这一个入口（别名 `cards.stateOf`）。 */
    stateOf: (o) => {
      const x = o || {};
      // 4.23.6：把「下完但没落地」的观察锚与宽容窗口一起交给状态机 —— 超时判 failed 的口径
      // 只写在 `dlCardState` ③ 那一处，页签不必各写一遍。
      const stallMs = Number(dl && dl.installStallMs) || dlInstallStallMs();
      const since = stallOf(x.id, x.job, x.done);
      const st = dlCardState({
        id: x.id, job: x.job, done: x.done, labels: x.labels,
        sub: api.subOf(x.id), err: api.errOf(x.id), etaSec: api.etaOf(x.job), nowMs,
        installStallMs: stallMs, installingSince: since,
      });
      // 已经判过超时 ⇒ 标记 expired：秒表停转（不空转），卡片保持 failed +「重试」。
      if (since > 0 && nowMs - since >= stallMs) {
        const e = stallRef.current.get(key(x.id));
        if (e && e.at === since) e.expired = true;
      }
      return st;
    },
  };
  return api;
}

