/**
 * download-first.js — **站点壁纸「先完整下载 + 校验，再从本地文件播」**（4.23.23）。
 *
 * 用户口径（本次明确拍板）：
 *   ① 点一张未缓存壁纸 ⇒ 卡片立刻 pressed、**封面/海报立刻上屏**（绝不黑屏）；
 *   ② 进度行必须说清「正在缓存 x%（a/b MB · 约剩 N 秒）」；
 *   ③ **等整份下载完、并通过宿主的校验（`job.verified`）后，才从 `/folia/local-media/<jobId>`
 *      开始播放** —— 默认**不走** CDN 边下边播；
 *   ④ 等太久（预计 > 12 秒，或 > 40 MB 且速率 < 1 MB/s）⇒ 进度行下方出现
 *      「改用边下边播」按钮，**用户点了才走 CDN 流**（绝不自动降级）；
 *   ⑤ 用户切走 ⇒ 这条只**降为 low 继续下载**（不暂停/不取消、已下字节不归零）；
 *      再点回来 ⇒ 立刻升回 high；已完成 ⇒ 直接播本地。
 *
 * 与既有模块的分工：
 *   · 队列 / job 形态 / 校验是宿主的事（`lib/download-queue.js` 4.23.22 起在完成那一刻
 *     按**当前清单**解析期望值；`job.verified` 是那次校验的结果）。
 *   · 本文件只做**客户端状态机 + 文案 + 策略判定**，不自己造第二条下载/轮询实现：
 *     轮询由调用方注入 `listJobs()`（生产走 `/folia/downloads/list`），
 *     入队由调用方注入 `enqueue()`（生产走 `/folia/downloads/add` 的 high）。
 *   · 纯函数（`dfProgressText` / `dfLongWait` / `dfShouldCache` …）可直接被
 *     `test/verify-download-first.mjs` import 断言；状态机零 DOM / 零网络。
 *
 * 不变量：
 *   · `state === "caching"` 时**绝不允许** `<video>` 指向站点媒体地址（`playMode = "poster"`）；
 *   · `state === "playing"` 只由「`done` + `verified` + 本地地址」这一条路径写入；
 *   · `dfLeaveSelection()` **不发** cancel/pause 请求，只发 low 提权请求（队列继续）；
 *   · 预取张数只有一处（`src/local-first.js` 的 `lfPrefetchCount()`），本文件只答"是不是
 *     download-first"。
 */

/** 默认策略。缺省 / 非法值一律落到它（旧存档没有这个键 ⇒ 新默认）。 */
const DF_POLICY_DEFAULT = "download-first";
/** 旧行为：点击即播站点代理流（回滚档）。 */
const DF_POLICY_STREAM = "stream-first";
/** 长等待保护：预计剩余**大于**该秒数 ⇒ 显示「改用边下边播」。 */
const DF_LONG_WAIT_ETA_SEC = 12;
/** 长等待保护：文件大于 40 MB 且速率低于 1 MB/s ⇒ 显示按钮。 */
const DF_LONG_WAIT_BYTES = 40 * 1024 * 1024;
const DF_LONG_WAIT_SPEED_BPS = 1024 * 1024;
/** 进度轮询间隔（与 4.23.17 的卡片进度同一条 1.5s 口径；这里更短一点让 ETA 更快出现）。 */
const DF_POLL_MS = 1000;
/** 「job 从列表里消失」连续次数上限：宿主重启 / 清队列之后不再无限等。 */
const DF_JOB_MISS_LIMIT = 5;
/** ETA 的观测窗口：只认最近 4 秒的增量（整段平均会被起跑阶段拖低）。 */
const DF_ETA_WINDOW_MS = 4000;
/** 样本跨度/最低速度：样本不足或没往前走 ⇒ 不给「约剩」（绝不编数字）。 */
const DF_ETA_MIN_SPAN_MS = 600;
const DF_ETA_MIN_SPEED_BPS = 1024;
/** 本地副本地址的唯一拼法由 src/media-state.js 提供；本文件只按名调用（运行时才有）。 */
const DF_STATE = {
  state: "idle",       // idle | caching | playing | failed
  id: "", url: "", title: "", poster: "",
  jobId: "", localUrl: "", verified: "",
  received: 0, total: 0, percent: 0, etaSec: 0, bps: 0,
  canStream: false, streaming: false, error: "",
  text: "", startedAt: 0, token: 0, timer: 0, last: null,
  samples: [],
};

/** 策略值规范化：只有 `stream-first` 是旧行为，其余（含缺省/脏值）一律新默认。 */
function dfNormalizePolicy(v) {
  return String(v == null ? "" : v) === DF_POLICY_STREAM ? DF_POLICY_STREAM : DF_POLICY_DEFAULT;
}

/** 当前 store → 策略。`selection` 是内联作用域里的单例；单独 import 时由调用方显式传入。 */
function dfPolicyOf(sel) {
  const s = sel && typeof sel === "object" ? sel : null;
  if (s) return dfNormalizePolicy(s.playbackPolicy);
  try { return dfNormalizePolicy(selection && selection.playbackPolicy); } catch { return DF_POLICY_DEFAULT; }
}

/** 这张壁纸该不该走「先下载完再播」：只认**未缓存的站点视频**。 */
function dfShouldCache(item, sel, opts) {
  const o = opts || {};
  if (o.forceStream === true || o.fromDownloadFirst === true) return false;
  if (dfPolicyOf(sel) !== DF_POLICY_DEFAULT) return false;
  const w = item || {};
  if (String(w.type || "") !== "video") return false;
  if (!w.mediaProxy) return false;                    // 本机条目没有站点代理
  if (w.localReady === true || w.local === true) return false;
  if (typeof resolvePlaySrc === "function") {
    try { if (resolvePlaySrc(w).source === "local") return false; } catch { /* 解析失败按未缓存处理 */ }
  }
  return true;
}

/** 海报地址：优先条目预览图（站点缩略图），其次宿主抽帧；空串 = 没有海报。 */
function dfPosterOf(item) {
  const w = item || {};
  return String(w.preview || w.thumbUrl || w.poster || "");
}

/** 「正在缓存 x%（a/b MB · 约剩 N 秒）」的唯一格式化口。 */
function dfProgressText(recv, total, etaSec) {
  const r = Math.max(0, Number(recv) || 0);
  const t = Math.max(0, Number(total) || 0);
  if (!(t > 0)) return weT("正在缓存…");
  const pct = Math.max(0, Math.min(100, Math.round((r / t) * 100)));
  const a = (r / 1048576).toFixed(1);
  const b = (t / 1048576).toFixed(1);
  const s = Math.max(0, Math.round(Number(etaSec) || 0));
  return s > 0
    ? weT("正在缓存 {p}%（{a}/{b} MB · 约剩 {s} 秒）", { p: pct, a, b, s })
    : weT("正在缓存 {p}%（{a}/{b} MB）", { p: pct, a, b });
}

/**
 * 长等待保护（纯函数）：预计剩余 > 12 秒 **或** 文件 > 40 MB 且速率 < 1 MB/s。
 * 速率未知（0）时只看 ETA；两条都不满足 ⇒ 不显示按钮（不打扰）。
 */
function dfLongWait(o) {
  const x = o || {};
  const eta = Number(x.etaSec) || 0;
  if (eta > DF_LONG_WAIT_ETA_SEC) return true;
  const total = Number(x.total) || 0;
  const bps = Number(x.bps) || 0;
  return total > DF_LONG_WAIT_BYTES && bps > 0 && bps < DF_LONG_WAIT_SPEED_BPS;
}

/** `done` 是否算"通过校验"：4.23.22 起宿主机每行都带 `verified`；旧宿主缺省按通过。 */
function dfVerifiedOf(job) {
  const v = job && job.verified;
  if (v == null || v === "") return true;            // 旧宿主：没有该字段，保持升级期兼容
  return Boolean(v);
}

/** 一次 job 快照 → 状态机迁移（纯函数给测试；`nowMs` 可注入）。 */
function dfApplyJob(job, nowMs) {
  const st = DF_STATE;
  if (!job) return dfSnapshot();
  const now = Number(nowMs) || Date.now();
  st.jobId = String(job.id || st.jobId || "");
  st.received = Math.max(0, Number(job.received) || 0);
  st.total = Math.max(0, Number(job.total) || 0);
  st.percent = st.total > 0 ? Math.max(0, Math.min(100, Math.round((st.received / st.total) * 100)))
    : (job.status === "done" ? 100 : 0);
  // 速度样本：只留最近 4 秒；样本不足 ⇒ ETA 0。
  if (job.status === "running") {
    st.samples.push({ at: now, got: st.received });
    while (st.samples.length > 2 && now - st.samples[0].at > DF_ETA_WINDOW_MS) st.samples.shift();
    const first = st.samples[0];
    const span = now - (first ? first.at : now);
    const delta = first ? st.received - first.got : 0;
    st.bps = (span >= DF_ETA_MIN_SPAN_MS && delta > 0) ? (delta / (span / 1000)) : 0;
    st.etaSec = (st.bps > DF_ETA_MIN_SPEED_BPS && st.total > st.received)
      ? Math.max(1, Math.round((st.total - st.received) / st.bps)) : 0;
  } else if (job.status === "queued") {
    st.bps = 0;
    st.etaSec = 0;
  }
  if (job.status === "done") {
    if (job.fileValid === false) {
      st.state = "failed";
      st.error = weT("下载完成但本地文件校验没通过，请重试");
      st.canStream = true;
      st.text = "";
      return dfSnapshot();
    }
    if (!dfVerifiedOf(job)) {
      st.state = "failed";
      st.error = weT("下载完成但内容校验没通过，请重试");
      st.canStream = true;
      st.text = "";
      return dfSnapshot();
    }
    st.verified = String(job.verified || "");
    st.localUrl = typeof msLocalMediaUrl === "function"
      ? msLocalMediaUrl(job.id) : "/folia/local-media/" + encodeURIComponent(String(job.id || ""));
    st.state = "playing";
    st.text = "";
    st.canStream = false;
    st.error = "";
    return dfSnapshot();
  }
  if (job.status === "failed" || job.status === "cancelled") {
    st.state = "failed";
    st.error = (typeof dlFailReason === "function")
      ? dlFailReason(job.error || job.status)
      : String(job.error || job.status || "failed");
    st.canStream = true;
    st.text = "";
    return dfSnapshot();
  }
  st.state = "caching";
  st.text = job.status === "queued"
    ? weT("正在缓存…（排队中）")
    : dfProgressText(st.received, st.total, st.etaSec);
  st.canStream = dfLongWait({ etaSec: st.etaSec, total: st.total, bps: st.bps });
  st.error = "";
  return dfSnapshot();
}

/** 只读快照（UI / 判据读它；返回浅拷贝，不允许外部改状态）。 */
function dfSnapshot() {
  const st = DF_STATE;
  return {
    state: st.state, id: st.id, url: st.url, title: st.title, poster: st.poster,
    jobId: st.jobId, localUrl: st.localUrl, verified: st.verified,
    received: st.received, total: st.total, percent: st.percent,
    etaSec: st.etaSec, bps: st.bps, canStream: st.canStream, streaming: st.streaming,
    error: st.error, text: st.text, startedAt: st.startedAt,
    showStream: st.state === "failed" || (st.state === "caching" && st.canStream),
    showRetry: st.state === "failed",
  };
}

/** 点击未缓存壁纸 ⇒ 进入 caching（**同步**，先于任何网络）。 */
function dfBegin(item) {
  const st = DF_STATE;
  const w = item || {};
  st.token += 1;
  dfStopTimer();
  const same = st.last && String(st.last.id) === String(w.id || "");
  st.state = "caching";
  st.id = String(w.id || "");
  st.url = String(w.media || "");
  st.title = String(w.title || w.id || "");
  st.poster = dfPosterOf(w);
  st.jobId = same ? String(st.last.jobId || "") : "";
  st.localUrl = "";
  st.verified = "";
  st.received = same ? Math.max(0, Number(st.last.received) || 0) : 0;
  st.total = same ? Math.max(0, Number(st.last.total) || 0) : 0;
  st.percent = st.total > 0 ? Math.round((st.received / st.total) * 100) : 0;
  st.etaSec = 0;
  st.bps = 0;
  st.samples = [];
  st.canStream = same ? Boolean(st.last.canStream) : false;
  st.streaming = false;
  st.error = "";
  st.text = dfProgressText(st.received, st.total, 0);
  st.startedAt = Date.now();
  return dfSnapshot();
}

/** 状态机离开当前条目（切走）⇒ 只发 **low**（不取消/不暂停），并停掉显示轮询。 */
function dfLeaveSelection(nextId, hooks) {
  const st = DF_STATE;
  if (st.state !== "caching" || !st.id || String(st.id) === String(nextId || "")) return null;
  const rec = {
    id: st.id, jobId: st.jobId, url: st.url, title: st.title,
    received: st.received, total: st.total, priority: "low", demoted: true,
  };
  st.last = {
    id: st.id, jobId: st.jobId, received: st.received, total: st.total,
    canStream: st.canStream,
  };
  st.token += 1;
  dfStopTimer();
  st.state = "idle";
  st.text = "";
  st.error = "";
  st.id = "";
  st.jobId = "";
  st.localUrl = "";
  if (hooks && typeof hooks.demote === "function") {
    try { hooks.demote({ id: rec.jobId, url: rec.url, kind: "wallpaper", priority: "low" }); } catch { /* 降级失败不阻塞切走 */ }
  }
  return rec;
}

/** 用户点「改用边下边播」：只改状态，不自动发生（调用方随后按 forceStream 重挂播放）。 */
function dfUseStream() {
  const st = DF_STATE;
  if (st.state !== "caching" && st.state !== "failed") return null;
  st.state = "idle";
  st.streaming = true;
  st.text = "";
  st.canStream = false;
  dfStopTimer();
  return dfSnapshot();
}

/** 结算为 playing（只在本地地址真的上屏之后由调用方写入）。 */
function dfMarkPlaying(localUrl) {
  const st = DF_STATE;
  st.state = "playing";
  st.localUrl = String(localUrl || st.localUrl || "");
  st.streaming = false;
  st.text = "";
  st.canStream = false;
  st.error = "";
  dfStopTimer();
  return dfSnapshot();
}

/** 失败：原因 + 两个按钮（重试 / 改用边下边播），绝不静默。 */
function dfFail(reason) {
  const st = DF_STATE;
  st.state = "failed";
  st.error = String(reason || "").trim()
    || dlFailReason("failed");
  st.text = "";
  st.canStream = true;
  dfStopTimer();
  return dfSnapshot();
}

/** 轮询计时器（模块级；离开/完成/失败都停）。 */
function dfStopTimer() {
  const st = DF_STATE;
  if (!st.timer) return;
  try { clearInterval(st.timer); } catch { /* ignore */ }
  st.timer = 0;
}

/**
 * 启动一条下载并轮询到终态。
 *
 * @param {object} item 站点壁纸条目
 * @param {object} hooks
 *   · `enqueue(item)` → `Promise<job|null>`（生产：`/downloads/add` high）
 *   · `listJobs()` → `Promise<jobs[]>`
 *   · `onUpdate(snap)` / `onDone(snap, job)` / `onFail(snap)` / `onGone(reason)`
 *   · `timers` 注入（测试用）；缺省全局计时器
 * @returns {Promise<object>} 最终快照
 */
function dfAttachJob(job, h, token) {
  const st = DF_STATE;
  st.jobId = String(job.id);
  const snap = dfApplyJob(job);
  if (snap.state === "playing") {
    if (typeof h.onUpdate === "function") h.onUpdate(snap);
    if (typeof h.onDone === "function") h.onDone(snap, job);
    return snap;
  }
  if (snap.state === "failed") {
    if (typeof h.onUpdate === "function") h.onUpdate(snap);
    if (typeof h.onFail === "function") h.onFail(snap);
    return snap;
  }
  if (typeof h.onUpdate === "function") h.onUpdate(snap);
  const timers = h.timers || {};
  const setIv = typeof timers.setInterval === "function" ? timers.setInterval : setInterval;
  const misses = { n: 0 };
  const afterList = (jobs) => {
    if (st.token !== token || !Array.isArray(jobs)) return;   // 拉不到就等下一拍（不算"查不到"）
    const hit = jobs.find((j) => j && String(j.id) === String(st.jobId)) || null;
    if (!hit) {
      misses.n += 1;
      if (misses.n >= DF_JOB_MISS_LIMIT) {
        const gone = dfFail(weT("下载任务已丢失（宿主重启或队列被清空），请重试"));
        if (typeof h.onGone === "function") h.onGone(gone);
        else if (typeof h.onFail === "function") h.onFail(gone);
      }
      return;
    }
    misses.n = 0;
    const next = dfApplyJob(hit);
    if (next.state === "playing") {
      if (typeof h.onUpdate === "function") h.onUpdate(next);
      if (typeof h.onDone === "function") h.onDone(next, hit);
      return;
    }
    if (next.state === "failed") {
      if (typeof h.onUpdate === "function") h.onUpdate(next);
      if (typeof h.onFail === "function") h.onFail(next);
      return;
    }
    if (typeof h.onUpdate === "function") h.onUpdate(next);
  };
  const tick = () => {
    if (st.token !== token || typeof h.listJobs !== "function") return;
    let p;
    try { p = h.listJobs(); } catch { return; }
    Promise.resolve(p).then(afterList).catch(() => { /* 网络抖动：下一拍再试 */ });
  };
  st.timer = setIv(tick, Number(h.intervalMs) || DF_POLL_MS);
  try { if (st.timer && typeof st.timer.unref === "function") st.timer.unref(); } catch { /* ignore */ }
  tick();
  return dfSnapshot();
}

async function dfLoad(item, hooks) {
  const h = hooks || {};
  const st = DF_STATE;
  const token = ++st.token;
  dfStopTimer();
  let job = null;
  try {
    job = typeof h.enqueue === "function" ? await h.enqueue(item) : null;
  } catch { /* 队列不可用：下面按失败给出原因 + 流回退 */ }
  if (st.token !== token) return dfSnapshot();
  if (!job || !job.id) {
    const snap = dfFail(weT("下载队列不可用（宿主没响应），可改用边下边播"));
    if (typeof h.onFail === "function") h.onFail(snap);
    return snap;
  }
  return dfAttachJob(job, h, token);
}

/** 纯函数：download-first 下点未缓存壁纸时，层里该放什么（poster ⇒ 不建 video）。 */
function dfLayerPlan(item, sel, snap) {
  const s = snap || dfSnapshot();
  if (s.state === "caching" || s.state === "failed") {
    return { mode: "poster", src: dfPosterOf(item), state: s.state };
  }
  if (s.state === "playing" && s.localUrl) return { mode: "video", src: s.localUrl, state: "playing" };
  const policy = dfPolicyOf(sel);
  const proxy = String((item && (item.mediaProxy || item.media)) || "");
  return { mode: "video", src: proxy, state: policy === DF_POLICY_STREAM ? "streaming" : "idle" };
}

/** 面板两档的文案（键给渲染器查表，避免在 UI 里再写一份中文）。 */
function dfPolicyLabel(policy) {
  return dfNormalizePolicy(policy) === DF_POLICY_STREAM
    ? weT("边下边播（秒开）")
    : weT("下载完再播（省流量）");
}

export {
  dfNormalizePolicy, dfPolicyOf, dfPolicyLabel, dfShouldCache,
  dfProgressText, dfLongWait, dfApplyJob, dfSnapshot, dfBegin,
  dfLeaveSelection, dfUseStream, dfMarkPlaying, dfFail, dfLoad, dfLayerPlan,
};
