/**
 * wallpaper-progress.js — **壁纸缓存进度**（4.23.17）：首次点击后「缓存中 62%」，下完变
 * 「已缓存」，切走再切回**接着显示真实进度**。
 *
 * ══ 为什么要有这一层（用户口径，原样）══════════════════════════════════════════════
 *   ① 点了一张没缓存的壁纸，卡片/标题栏要立刻看得见"在缓存"（有百分比，不是静默）；
 *   ② 下完 ⇒ 百分比消失；卡片只说「已缓存」（再点它不必等网络）；
 *   ③ 点 A 再点 B：B 显示自己的进度，**A 的仍留在卡片上**（宿主队列还在下 A）；
 *   ④ 切走（关掉库视图 / 换页签）再切回 A：已下好 ⇒ 只说「已缓存」；没下好 ⇒
 *      **接着显示当前进度**（从 `/folia/downloads/list` 读真实值，绝不是从 0 重来）；
 *   ⑤ 原画与 1080p 变体是**同一族**：任一下好即算已缓存（判据复用 inventory 的
 *      `localReady`，它由宿主 `lib/switch-cache-family.js` 的族键算出）。
 *
 * ══ 真源与分工（不许出现第二套轮询）════════════════════════════════════════════════
 *   · 唯一的进度真源是 `/folia/downloads/list`（job.status / percent / received / total /
 *     queuePos / error）。本文件**不自己发这个请求**：`WpJobsBridge` 调既有的
 *     `useDownloadJobs()`（src/local-first.js，1.5s、无活跃 job 自动停表），把快照推进来。
 *   · 存储 `WP_STORE` 只做两件事：留一份最新快照 + 按**订阅的卡**逐个通知。于是
 *     "进度更新 = 只重渲染那一张卡"，列表（上百条）不因为一次轮询整片重渲染。
 *   · 视图是**纯函数**（`wpViewOf`）：给 item + jobs 就答"该显示什么"，没有组件状态、
 *     没有本地计时器 ⇒ 切回来第一次渲染就是 `/downloads/list` 里的真实值。
 *
 * ══ 契约 ═══════════════════════════════════════════════════════════════════════════
 *   · 浏览器安全（无 import / require / Node API），由 scripts/build-client.mjs 内联进
 *     客户端 bundle 的工厂作用域；名字一律 `wp` / `Wp` 前缀，避免与既有 prelude 撞名。
 *   · 文案全部走 `weT(...)`（中文原文为键，英文词表在 src/i18n-copy-panel.js）。
 *   · 不改既有断言：本文件只**新增**节点（无内容时返回 null），模态框标记等价 golden 不变。
 */

/** 队列快照 + 每张卡的最新视图通知。 */
const WP_STORE = {
  /** 最近一次 `/downloads/list` 的 jobs（真源快照，组件卸载/切走都不清）。 */
  jobs: [],
  /** itemKey → { item, fns:Set<(view:object|null)=>void>, sig:string }（只留当前挂着的卡）。 */
  subs: new Map(),
  /** `useDownloadJobs().refresh`（点「重试」后立刻重拉一次，不必等下一拍）。 */
  refresh: null,
};

/** jobId → ETA 秒数（0 = 不显示；由最近 4 秒的字节增量估，与 useDlCards ③ 同一条口径）。 */
const WP_ETA = new Map();
/** jobId → [{ at, got }]，只留最近 4 秒的样本。 */
const WP_SAMPLES = new Map();
/** ETA 的观测窗口（与 src/local-first.js 的 useDlCards ③ 一致）。 */
const WP_ETA_WINDOW_MS = 4000;
/** ETA 的最小样本跨度：短于它不估（1.5s 轮询下两次样本就够，60ms 内的抖动不算证据）。 */
const WP_ETA_MIN_SPAN_MS = 600;
/** ETA 的最低"有速度"门槛：低于 1 KB/s 视为没往前走（别报一个几百秒的假数字）。 */
const WP_ETA_MIN_SPEED_BPS = 1024;

/** 卡片键（item.id；没有 id 的条目不该出现在库里，这里只做防御）。 */
function wpItemKey(item) {
  return String((item && item.id) == null ? "" : item.id);
}

/**
 * 这张卡的**全部 URL**（原画 + 站点 1080p 变体 + 本地副本地址）。
 *
 * 为什么不是"只比 media"：宿主选档之后下的是**变体** URL（`/downloads/add` 的 finalUrl），
 * 而卡片代表的是这个条目（原画 URL）。两个 URL 属于同一条卡 ⇒ 用集合比，天然把"族"
 * 覆盖进来；`localReady` 那一半（已缓存）由 inventory 用同一个族键给出，两处不各算一套。
 */
function wpItemUrls(item) {
  const w = item || {};
  const out = Object.create(null);
  const add = (u) => {
    const s = String(u == null ? "" : u).trim();
    if (s) out[s] = true;
  };
  add(w.media);
  add(w.variantUrl);
  add(w.mediaProxy);
  const local = w.localDownload;
  if (local && typeof local === "object") add(local.url);
  const variants = Array.isArray(w.variants) ? w.variants : [];
  for (const v of variants) if (v && typeof v === "object") add(v.url);
  return out;
}

/**
 * 这条卡对应的 job（`/downloads/list` 里 kind=wallpaper 的那条）。
 * 同一 URL 可能有多条历史（失败重下）⇒ 优先未结束的，否则取最后一条（snapshot 已按 at 倒序）。
 */
function wpJobForItem(jobs, item) {
  const urls = wpItemUrls(item);
  const list = Array.isArray(jobs) ? jobs : [];
  let best = null;
  for (const j of list) {
    if (!j) continue;
    // kind 缺省（旧数据 / 测试夹具）按 wallpaper 认：URL 本身就是身份。
    if (j.kind && String(j.kind) !== "wallpaper") continue;
    const u = String(j.url == null ? "" : j.url).trim();
    if (!u || !urls[u]) continue;
    if (!best || (dlJobActive(j) && !dlJobActive(best))) best = j;
  }
  return best;
}

/** job.percent（0..100 整数）。**只读列表里的数**，绝不按时间自己涨。 */
function wpPercentOf(job) {
  const n = Number(job && job.percent);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 卡片状态机（纯函数）：
 *   running / queued（队列里还有活） ⇒ 进度
 *   cached（`localReady` 族命中，或这条 job 已经 done） ⇒ 「已缓存」
 *   failed（job 明确失败且这张卡还没缓存） ⇒ 原因 +「重试」
 *   none（没有 job 且没缓存） ⇒ 什么都不画（避免噪音）
 */
function wpStateOf(item, jobs) {
  const w = item || {};
  // `localReady` = 族级已缓存（宿主 familyKeyOf：原画 / 1080p 任一下好）。
  const cached = w.localReady === true || w.local === true;
  const job = wpJobForItem(jobs, w);
  const status = String((job && job.status) || "");
  if (status === "running") return { phase: "running", job, percent: wpPercentOf(job), cached };
  if (status === "queued") return { phase: "queued", job, percent: 0, cached };
  // 已缓存优先于 done/failed：族里另一档已经落地 ⇒ 不再报"这条失败"的噪音。
  if (cached) return { phase: "cached", job: null, percent: 100 };
  if (status === "done") return { phase: "cached", job, percent: 100 };
  if (status === "failed") return { phase: "failed", job, percent: 0, code: String(job.error || "failed") };
  return { phase: "none", job: null, percent: 0 };
}

/** 一次 job 快照的字节样本 → ETA 秒（样本不足 / 没往前走 ⇒ 0，绝不编数字）。 */
function wpSampleEta(jobs, nowMs) {
  const now = Number(nowMs) || 0;
  const alive = new Set();
  for (const j of (Array.isArray(jobs) ? jobs : [])) {
    if (!j || !j.id || j.status !== "running") continue;
    alive.add(String(j.id));
    const arr = WP_SAMPLES.get(String(j.id)) || [];
    arr.push({ at: now, got: Math.max(0, Number(j.received) || 0) });
    while (arr.length > 2 && now - arr[0].at > WP_ETA_WINDOW_MS) arr.shift();
    WP_SAMPLES.set(String(j.id), arr);
    const first = arr[0];
    const span = now - first.at;
    const got = Math.max(0, Number(j.received) || 0);
    const total = Math.max(0, Number(j.total) || 0);
    const speed = span > WP_ETA_MIN_SPAN_MS ? (got - first.got) / (span / 1000) : 0;
    if (speed > WP_ETA_MIN_SPEED_BPS && total > got) WP_ETA.set(String(j.id), Math.max(1, Math.round((total - got) / speed)));
    else WP_ETA.delete(String(j.id));
  }
  for (const k of [...WP_SAMPLES.keys()]) if (!alive.has(k)) { WP_SAMPLES.delete(k); WP_ETA.delete(k); }
}

/** 这条卡的 ETA（秒；0 = 不说"约剩"）。 */
function wpEtaOfItem(item, jobs) {
  const job = wpJobForItem(jobs, item);
  if (!job || job.status !== "running" || !job.id) return 0;
  return Number(WP_ETA.get(String(job.id)) || 0) || 0;
}

/**
 * **唯一的视图函数**（纯函数）：item + 队列快照 ⇒ 卡片/标题栏该显示的文案与形态。
 *
 * 返回 null = 这一格什么都不该画（没有 job 且没缓存）。
 * `card`（卡片：短）/ `title`（标题栏：带已下/总量与约剩）/ `phase` / `percent` / `reason`。
 * 文案全部来自既有的 `dlQueueDetail` / `dlProgressDetail` / `dlFailReason`（四模块共用一张表），
 * 本文件不另造数字、不另写失败原因。
 */
function wpViewOf(item, jobs, etaSec) {
  const s = wpStateOf(item, jobs);
  if (s.phase === "running") {
    const p = s.percent;
    const detail = dlProgressDetail(s.job, Number(etaSec) || 0);
    return {
      phase: "running",
      percent: p,
      card: weT("缓存中 {p}%", { p }),
      title: weT("缓存中 {p}%（{detail}）", { p, detail }),
    };
  }
  if (s.phase === "queued") {
    const text = dlQueueDetail(s.job);
    return { phase: "queued", percent: 0, card: text, title: text };
  }
  if (s.phase === "cached") {
    return { phase: "cached", percent: 100, card: weT("已缓存"), title: null };
  }
  if (s.phase === "failed") {
    const why = dlFailReason(s.code);
    return { phase: "failed", percent: 0, card: weT("重试"), title: why, reason: why };
  }
  return null;
}

/** 当前快照下的视图（订阅回调用它：切回来第一帧就是 `/downloads/list` 的真实值）。 */
function wpSnapshotOf(item) {
  const jobs = WP_STORE.jobs;
  return wpViewOf(item, jobs, wpEtaOfItem(item, jobs));
}

/** 视图签名：只有**显示内容**变了才通知订阅者（同一百分比重复推送不触发渲染）。 */
function wpSigOf(view) {
  return view ? [view.phase, view.percent, view.card, view.title, view.reason || ""].join("\u0001") : "";
}

/**
 * 队列快照变了（`WpJobsBridge` 每次轮询后调）⇒ 只通知**显示内容真的变了**的卡。
 * `nowMs` 可注入（测试用固定时钟；生产调用不传 = Date.now()）。
 */
function wpPushJobs(jobs, nowMs) {
  const list = Array.isArray(jobs) ? jobs : [];
  WP_STORE.jobs = list;
  wpSampleEta(list, Number(nowMs) || Date.now());
  for (const rec of [...WP_STORE.subs.values()]) {
    const view = wpViewOf(rec.item, list, wpEtaOfItem(rec.item, list));
    const sig = wpSigOf(view);
    if (sig === rec.sig) continue;
    rec.sig = sig;
    for (const fn of [...rec.fns]) {
      try { fn(view); } catch { /* 单张卡出错不影响其它卡 */ }
    }
  }
}

/** 订阅这张卡（立刻回一次当前视图；返回退订函数）。 */
function wpSubscribe(item, fn) {
  const key = wpItemKey(item);
  if (!key || typeof fn !== "function") return () => {};
  let rec = WP_STORE.subs.get(key);
  if (!rec) {
    rec = { item, fns: new Set(), sig: "" };
    WP_STORE.subs.set(key, rec);
  }
  rec.item = item;
  rec.fns.add(fn);
  // 立刻给一次：切回库视图时不必等下一拍轮询才看见进度。
  try { fn(wpSnapshotOf(item)); } catch { /* 组件已卸载：忽略 */ }
  return () => { wpUnsubscribe(key, fn); };
}

/** 退订（**只摘监听**：不清队列快照 —— 切走再回来必须还能算出真实进度）。 */
function wpUnsubscribe(key, fn) {
  const rec = WP_STORE.subs.get(key);
  if (!rec) return;
  rec.fns.delete(fn);
  if (!rec.fns.size) WP_STORE.subs.delete(key);
}

/**
 * React：订阅一条壁纸的缓存进度（卡片 / 标题栏各一枚）。
 *
 * 依赖 `item` 身份：清单刷新会换对象 ⇒ 重新订阅（拿到新的 `localReady` 与 URL 集合）。
 * 注意这里**没有** "切走就归零" 的本地状态：视图每次都由 `wpSnapshotOf` 现算。
 */
function useWallpaperProgress(item) {
  const [view, setView] = React.useState(() => wpSnapshotOf(item));
  React.useEffect(() => {
    let alive = true;
    setView(wpSnapshotOf(item));
    const off = wpSubscribe(item, (v) => { if (alive) setView(v); });
    return () => { alive = false; off(); };
  }, [item]);
  return view;
}

/**
 * 队列 → 进度存储的**桥**（无 DOM、返回 null）。
 *
 * 轮询**复用** `useDownloadJobs()`（src/local-first.js：1.5s 间隔、列表里没有 queued|running
 * 就停表、卸载即清定时器都在那里）—— 这里只是把快照分发出去，**不新建第二套轮询**。
 */
function WpJobsBridge() {
  const dl = useDownloadJobs();
  React.useEffect(() => {
    WP_STORE.refresh = (dl && typeof dl.refresh === "function") ? dl.refresh : null;
    wpPushJobs(dl && dl.jobs);
  }, [dl && dl.jobs]);
  return null;
}

/**
 * 「重试」：按用户点击（high 优先级）重新入队同一条壁纸，然后立刻重拉一次队列。
 * 失败不抛（重试按钮不该把面板弄坏）；下一拍轮询仍会给出真实状态。
 */
async function wpRetryDownload(item) {
  const w = item || {};
  if (!w.media) return false;
  try {
    await apiPostJson("/downloads/add", {
      items: [lfAddItem(w, w.media, "high")],
    }, { parse: "always" });
  } catch (e) {
    // 不静默：重试失败要能在控制台看到原因（界面下一次轮询仍会回到 failed +「重试」）。
    try { console.warn("[folia] 壁纸重新入队失败：", (e && e.message) || e); } catch { /* 控制台不可用 */ }
    return false;
  }
  try { if (typeof WP_STORE.refresh === "function") WP_STORE.refresh(); } catch { /* 下一拍轮询会补上 */ }
  return true;
}

/** 卡片上的缓存进度/角标（返回 null = 这个格子什么都不画）。 */
function wpCardRender(view, item) {
  if (!view) return null;
  const stop = (e) => { if (e && typeof e.stopPropagation === "function") e.stopPropagation(); };
  if (view.phase === "running") {
    return React.createElement("div", {
      className: "we-wp-progress",
      "data-we-wp": "running",
      title: view.title || view.card,
    },
      React.createElement("span", { className: "we-wp-progress__label" }, view.card),
      React.createElement("span", { className: "we-wp-progress__rail" },
        React.createElement("span", {
          className: "we-wp-progress__fill",
          style: { width: view.percent + "%" },
        })));
  }
  if (view.phase === "queued") {
    return React.createElement("span", {
      className: "we-wp-queued", "data-we-wp": "queued", title: view.card,
    }, view.card);
  }
  if (view.phase === "cached") {
    return React.createElement("span", {
      className: "we-wp-cached", "data-we-wp": "cached",
      title: weT("已在本地缓存（原画或 1080p 任一档已落地），点它不必等网络"),
    }, view.card);
  }
  if (view.phase === "failed") {
    return React.createElement("div", {
      className: "we-wp-failed", "data-we-wp": "failed", title: view.reason,
    },
      React.createElement("span", { className: "we-wp-failed__why" }, view.reason),
      React.createElement("button", {
        className: "we-wp-failed__retry", type: "button", title: weT("重试"),
        onClick: (e) => { stop(e); wpRetryDownload(item); },
      }, view.card));
  }
  return null;
}

/** 卡片组件：只重渲染自己（进度更新不碰整张列表）。 */
function WpCardProgress(props) {
  const item = props && props.item;
  const view = useWallpaperProgress(item);
  return wpCardRender(view, item);
}

/** 标题栏（当前壁纸那一行）：只画"进度/排队/失败"，已缓存/无 job 时返回 null。 */
function wpTitleRender(view, item) {
  if (!view) return null;
  if (view.phase === "running" || view.phase === "queued") {
    return React.createElement("div", {
      className: "we-picker__hint we-wp-title",
      "data-we-wp": view.phase,
      title: view.title || view.card,
    }, view.title || view.card);
  }
  if (view.phase === "failed") {
    return React.createElement("div", {
      className: "we-picker__hint we-wp-title we-wp-title--failed",
      "data-we-wp": "failed",
      title: view.reason,
    },
      React.createElement("span", { className: "we-wp-title__why" }, view.reason),
      React.createElement("button", {
        className: "we-wp-failed__retry", type: "button", title: weT("重试"),
        onClick: (e) => { if (e && typeof e.stopPropagation === "function") e.stopPropagation(); wpRetryDownload(item); },
      }, view.card));
  }
  return null;
}

export {
  WP_STORE,
  wpItemKey,
  wpItemUrls,
  wpJobForItem,
  wpPercentOf,
  wpStateOf,
  wpViewOf,
  wpSnapshotOf,
  wpPushJobs,
  wpSubscribe,
  wpUnsubscribe,
  wpCardRender,
  wpTitleRender,
  wpRetryDownload,
  useWallpaperProgress,
  WpJobsBridge,
  WpCardProgress,
};
