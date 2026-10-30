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

/** 从 inventory 里找这条（`/folia/inventory` 的 items）。 */
async function lfFindItem(id) {
  try {
    const resp = await apiJson("/inventory");
    const items = (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items
      : (Array.isArray(resp && resp.items) ? resp.items : []);
    return items.find((x) => x && x.id === id) || null;
  } catch { return null; }
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
      const resp = await apiPostJson("/downloads/add", { items: [{ kind: "wallpaper", url: item.media }] }, { parse: "always" });
      const items = (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items : [];
      job = items[0] && items[0].job ? items[0].job : null;
    } catch { /* 入队失败：下面回退直连 */ }
    if (!job || !job.id) return;   // 下载链路不可用（老宿主 / 路由没注册）⇒ 静默跳过，播放照旧
    lfSay(`正在下载到本地：${label}`, true);
    lfPoll(job.id, item, label);
  })();
  return true;
}
