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
  // 异步完成，这里只能是"先入队再返回"。所有 await 都在内部，不阻塞调用方。
  (async () => {
    const item = await lfFindItem(id);
    if (!item || !item.mediaProxy) return;      // 非站点条目：交给原路径
    if (item.local === true) return;            // 已在本地
    const label = String(item.title || id);
    if (LF_STATE.inflight.has(id)) { lfSay(`正在下载到本地：${label}`, true); return; }
    let job = null;
    try {
      const resp = await apiPostJson("/downloads/add", { items: [{ kind: "wallpaper", url: item.media, priority: "low" }] }, { parse: "always" });
      const items = (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items : [];
      job = items[0] && items[0].job ? items[0].job : null;
    } catch { /* 入队失败：下面回退直连 */ }
    if (!job || !job.id) return;   // 下载链路不可用（老宿主 / 路由没注册）⇒ 静默跳过，播放照旧
    lfSay(`正在下载到本地：${label}`, true);
    lfPoll(job.id, item, label);
  })();
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
    let next = null;
    for (let k = at + 1; k < pool.length && k <= at + 6; k += 1) {
      const cand = pool[k];
      if (!cand || !cand.mediaProxy || cand.local === true) continue;
      if (playingId && String(cand.id) === playingId) continue;
      next = cand;
      break;
    }
    if (!next) return;
    const nextId = String(next.id);
    if (LF_PREFETCH.seen.has(nextId)) return;
    // 已有 job（排队/在跑/已完成）⇒ 宿主侧本来就会去重，这里先问一次列表是为了
    // **不白占一次"预取名额"**，也让 `seen` 只在真的发出去时才记账。
    try {
      const resp = await apiJson("/downloads/list");
      const doc = (resp && resp.data) || resp || {};
      const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
      if (jobs.some((j) => j && j.url === next.media && j.status !== "failed" && j.status !== "cancelled")) return;
    } catch { return; }
    LF_PREFETCH.seen.add(nextId);
    await apiPostJson("/downloads/add", { items: [{ kind: "wallpaper", url: next.media, priority: "low" }] }, { parse: "always" });
  } finally {
    LF_PREFETCH.busy = false;
  }
}

