/**
 * media-state.js（浏览器半边）—— **播放源选择的客户端唯一入口**。
 *
 * 与宿主 `lib/media-state.js` 同一套判据（同一个函数名 `resolvePlaySrc`、同一组字段），
 * 但浏览器里没有 fs：`fileExists` / `fileValid` 只能**采信宿主的结论**（inventory 的
 * `mediaState`、`/downloads/list` 每行的 `fileExists`/`fileValid`）。
 *
 * 它存在的理由（2026-11-04）：
 *   · 客户端曾经用 `w.mediaProxy || w.media` 直接播 —— 而 `mediaProxy` 可能是**缓存里的旧
 *     本地地址**（站点清单 60s + 落盘缓存），文件早被清掉了 ⇒ `<video>` 404 ⇒ 界面写
 *     "浏览器无法解码这段视频"（错因）。现在这个函数是唯一出口，且**任何本地地址都要先过
 *     "宿主说它完整且有效"这一关**。
 *   · `<video>` 报错后要把"这条不可用"记下来（`msMarkUnavailable`），否则下一次重渲染又
 *     拿到同一个 404 地址，形成"点一次错一次"的观感。
 *
 * 不变量：**返回 `source === "local"` 时，url 必定是 `/folia/local-media/<jobId>` 且
 * `mediaState.localReady === true`**；其余一切返回 proxy（且 proxy 候选里跳过所有本地地址）。
 */

/** key → state（本会话内观察到的"这条 URL 现在能不能播"）。 */
const MS_STATES = new Map();

/** 状态键（与宿主同口径：URL 去空白）。 */
function msKeyOf(url) {
  return String(url == null ? "" : url).trim();
}

/** `/folia/local-media/<jobId>` 的唯一拼法（与宿主 `localMediaUrl` 逐字一致）。 */
function msLocalMediaUrl(jobId) {
  return "/folia/local-media/" + encodeURIComponent(String(jobId || ""));
}

/** 这个地址是不是本地副本地址。 */
function msIsLocalMediaUrl(url) {
  return /\/local-media\//.test(String(url || ""));
}

/** 从本地地址里取 jobId（不是本地地址 ⇒ 空串）。 */
function msLocalMediaJobId(url) {
  const m = /\/local-media\/([^/?#]+)/.exec(String(url || ""));
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** 空状态（与宿主 `emptyState` 同形）。 */
function msEmptyState(jobId, key) {
  return {
    key: String(key || ""), jobId: String(jobId || ""), kind: "",
    jobStatus: "", fileExists: false, fileValid: false,
    localReady: false, source: "proxy", reason: "",
  };
}

/**
 * 清单条目 → 状态。**优先采信宿主给的 `mediaState`**；老宿主没有该字段时退回
 * `localReady` / `local` 两枚布尔（行为与 4.23.18 等价，只用于升级期不崩）。
 */
function msStateFromEntry(entry) {
  const e = entry || {};
  const raw = e.mediaState && typeof e.mediaState === "object" ? e.mediaState : null;
  if (raw) {
    const jobId = String(raw.jobId || msLocalMediaJobId(e.mediaProxy) || msLocalMediaJobId(e.localDownload && e.localDownload.url) || "");
    return Object.assign(msEmptyState(jobId, msKeyOf(e.media) || msKeyOf(raw.key)), raw, { jobId });
  }
  const jobId = msLocalMediaJobId(e.mediaProxy) || msLocalMediaJobId(e.localDownload && e.localDownload.url);
  const ready = e.localReady === true || e.local === true;
  return Object.assign(msEmptyState(jobId, msKeyOf(e.media)), {
    jobStatus: ready ? "done" : "",
    fileExists: ready,
    fileValid: ready,
    localReady: ready,
    source: ready ? "local" : "proxy",
  });
}

/** 把一份状态记进会话表（按 URL 与 jobId 两个键都能查到）。 */
function msRemember(state) {
  if (!state || !state.key) return state;
  MS_STATES.set(state.key, state);
  return state;
}

/** 从会话表里找一条（按 URL / jobId / 本地地址里的 jobId 任一）。 */
function msLookup(keyOrJobId) {
  const k = String(keyOrJobId || "");
  if (!k) return null;
  if (MS_STATES.has(k)) return MS_STATES.get(k);
  for (const st of MS_STATES.values()) if (st.jobId && st.jobId === k) return st;
  for (const st of MS_STATES.values()) if (st.key && msLocalMediaJobId(st.key) === k) return st;
  return null;
}

/**
 * **这一条该用哪种渲染器**（4.23.19 P1，最简版）。
 *
 *   image  ⇒ `<img>`
 *   video  ⇒ 视频池（现有）
 *   poster ⇒ 静态封面垫底（视频没有可播源 / 将来 live 不可用时）
 *   live   ⇒ **预留**：WebWallGL / 网页壁纸将来接；本次按 poster 处理，不改现有渲染。
 */
function msPlayMode(entry, url) {
  const t = String((entry && entry.type) || "");
  if (t === "image") return "image";
  if (t === "scene" || t === "web" || t === "live") return "poster";   // 预留分支
  if (!String(url || "")) return "poster";
  return "video";
}

/**
 * **播哪个地址 —— 客户端唯一出口**（与宿主同名函数同一套判据）。
 *
 * @param {any} entry 清单条目（`media` / `mediaProxy` / `localDownload` / `mediaState` / `type`）
 * @returns {{ source: "local"|"proxy", url: string, jobId: string, mode: "video"|"image"|"poster" }}
 */
function resolvePlaySrc(entry) {
  const e = entry || {};
  const remembered = msLookup(msKeyOf(e.media)) || msLookup(msLocalMediaJobId(e.mediaProxy));
  const state = remembered || msStateFromEntry(e);
  const jobId = String(state.jobId || "");
  // ⚠️ 四个条件缺一不可：宿主说 done、文件在、文件有效、有 jobId。
  //    负数对照见 test/verify-media-state.mjs（去掉 fileExists 后 2/6/8 必须红）。
  const ready = Boolean(state
    && state.jobStatus === "done"
    && state.fileExists === true
    && state.fileValid === true
    && jobId);
  if (ready) return { source: "local", url: msLocalMediaUrl(jobId), jobId, mode: msPlayMode(e, "local") };
  const candidates = [e.mediaProxy, e.proxyUrl, e.media, e.originUrl];
  for (const cand of candidates) {
    const s = String(cand == null ? "" : cand).trim();
    if (!s || msIsLocalMediaUrl(s)) continue;
    return { source: "proxy", url: s, jobId, mode: msPlayMode(e, s) };
  }
  return { source: "proxy", url: "", jobId, mode: msPlayMode(e, "") };
}

/**
 * `/downloads/list` 的一行 → 状态（下载完成/失败/暂停都能立刻反映到播放源判断）。
 * `fileExists` / `fileValid` 缺省（老宿主）时**按不可播处理** —— 宁可多走一次站点流，
 * 也不要把 `<video>` 指到一个可能是 404 的本地地址。
 */
function msNoteJob(job) {
  if (!job || !job.url) return null;
  const jobId = String(job.id || "");
  const done = String(job.status || "") === "done";
  const state = {
    key: msKeyOf(job.url), jobId, kind: String(job.kind || ""),
    jobStatus: String(job.status || ""),
    fileExists: job.fileExists === true,
    fileValid: job.fileValid === true,
    localReady: done && job.fileExists === true && job.fileValid === true,
    source: done && job.fileExists === true && job.fileValid === true ? "local" : "proxy",
    reason: String(job.status || ""),
  };
  return msRemember(state);
}

/**
 * **标记一条本地副本不可用**（404 / `<video>` error / sha 不符）。
 * 只影响本会话：宿主下一次对账会给出权威结论，本表只是"别再拿这个地址试"。
 */
function msMarkUnavailable(urlOrJobId, reason) {
  const key = msKeyOf(urlOrJobId);
  const jobId = msLocalMediaJobId(urlOrJobId) || (msLookup(key) ? msLookup(key).jobId : "");
  const hit = msLookup(key) || (jobId ? msLookup(jobId) : null);
  // key 用**输入地址**（本地地址也要留一条），这样下一次同一个 404 地址进来会命中"不可用"。
  const next = Object.assign(msEmptyState(jobId, (hit && hit.key) || key), hit || {}, {
    jobStatus: "pending", fileExists: false, fileValid: false, localReady: false,
    source: "proxy", reason: String(reason || "unavailable"),
  });
  if (next.key) msRemember(next);
  // jobId 索引：同一条 job 的 URL 键也要一起失效（列表里可能既有 job.url 又有本地地址）。
  if (jobId) {
    for (const st of MS_STATES.values()) {
      if (st.jobId === jobId) Object.assign(st, {
        jobStatus: "pending", fileExists: false, fileValid: false, localReady: false, source: "proxy",
        reason: next.reason,
      });
    }
  }
  return next;
}

/** 会话读数（诊断/面板摘要用；`localReady` 只统计**当前**已确认可播的条目）。 */
function msSummary() {
  let localReady = 0;
  let downloading = 0;
  let pending = 0;
  for (const st of MS_STATES.values()) {
    if (st.localReady === true) localReady += 1;
    else if (st.jobStatus === "running" || st.jobStatus === "queued") downloading += 1;
    else if (st.jobStatus === "pending") pending += 1;
  }
  return { total: MS_STATES.size, localReady, downloading, pending };
}

// 构建期会被剥掉（内联后同作用域）；保留是为了 `test/verify-media-state.mjs` 能直接
// import **真实现**做纯判据 —— 与 settings-schema / variant-pick 的同一做法。
export {
  msKeyOf, msLocalMediaUrl, msIsLocalMediaUrl, msLocalMediaJobId,
  resolvePlaySrc, msNoteJob, msMarkUnavailable, msSummary, msStateFromEntry, MS_STATES,
};
