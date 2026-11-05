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
 *
 * ══ 4.25.5（用户核心诉求）═══════════════════════════════════════════════════════════
 *   标题栏的状态**只能**由服务端事实派生（inventory 的 `mediaState.jobStatus` +
 *   `/downloads/list` 的进度数字）。客户端的乐观状态（`selection.playbackState`）不进这里。
 *   映射（`wpViewOf`）：pending ⇒「未缓存（点击继续）」· queued ⇒「排队中：前面还有 N 个任务」·
 *   running+total>0 ⇒「缓存中 x%（a/b MB · 约剩 N 秒）」· running+total=0 ⇒「正在连接…（已等待 N 秒）」·
 *   failed ⇒「下载失败：<原因>（点击重试）」· done+localReady ⇒ 不占标题栏（角标「已缓存」）。
 *   `src/download-first.js` 的 1s 轮询与 `/downloads/add` 回执经 `wpNoteJob()` 并进快照 ——
 *   不是第二套轮询，只是让标题栏早 1.5 秒说真话。
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

/** 卡片键（item.id；没有 id 的条目不该出现在库里，这里只做防御）。
 *
 * 4.25.1：与宿主 `job.itemKey` **同一个拼法**（`wallpaper:<id>`）。进度按条目绑，
 * 不再按 URL / jobId —— 原画与 1080p/30fps 变体 URL 只是同一条目的不同落点。
 */
function wpItemKey(item) {
  const id = String((item && item.id) == null ? "" : item.id);
  return id ? "wallpaper:" + id : "";
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
 * 媒体族键（4.25.1，老数据兼容）：忽略变体后缀与查询串。
 *
 * 新 job 都带 itemKey，正常路径不需要它；但 4.25.0 留下的 pending 记录没有 itemKey，
 * 其 URL 可能是 `.1080p.mp4` / `.30fps.mp4`，而清单条目的 `media` 是原始 URL。
 * 没有这层兜底，那些记录仍然"点了没进度/启动看不出未缓存"。
 */
function wpFamilyKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    const parts = u.pathname.split('/');
    const file = parts.pop() || '';
    let stem = file.replace(/\.(?:mp4|webm|mov|m4v|mkv|avi|jpg|jpeg|png|webp|gif|avif|zip)$/i, '');
    stem = stem.replace(/(?:[._-](?:1080p|1440p|2160p|4k30|4k|30fps|60fps|h264|hevc|av1|transcoded))+$/i, '');
    return u.origin + '/' + (parts.filter(Boolean).length ? parts.filter(Boolean).join('/') + '/' : '') + stem;
  } catch { return ''; }
}

/** 这条 job 是不是这张卡（itemKey 优先；老数据按 URL / 媒体族兜底）。 */
function wpItemMatchesJob(item, job) {
  if (!job) return false;
  if (job.kind && String(job.kind) !== "wallpaper") return false;
  const key = wpItemKey(item);
  if (key && String(job.itemKey || "") === key) return true;
  const u = String(job.url == null ? "" : job.url).trim();
  if (u && wpItemUrls(item)[u]) return true;
  const fam = wpFamilyKey(item && (item.media || item.variantUrl));
  return Boolean(fam && wpFamilyKey(u) === fam);
}


/**
 * 这条卡对应的 job（`/downloads/list` 里 kind=wallpaper 的那条）。
 *
 * 4.25.1：**先认 itemKey**（条目级），URL / 媒体族只做老数据的兜底。用户实测的根因正是这里：
 * 宿主下的可能是 `.1080p.mp4` / `.30fps.mp4` 变体，而卡片只拿 `item.media`（原始 URL）
 * 去比 ⇒ 找不到 job ⇒ 「缓存中」没有百分比、只剩一个按钮。
 *
 * 同一 URL 可能有多条历史（失败重下）⇒ 优先未结束的，否则取最后一条（snapshot 已按 at 倒序）。
 */
function wpJobForItem(jobs, item) {
  const key = wpItemKey(item);
  const urls = wpItemUrls(item);
  const list = Array.isArray(jobs) ? jobs : [];
  const groups = { key: [], url: [], family: [] };
  for (const j of list) {
    if (!j) continue;
    // kind 缺省（旧数据 / 测试夹具）按 wallpaper 认：URL 本身就是身份。
    if (j.kind && String(j.kind) !== "wallpaper") continue;
    if (key && String(j.itemKey || "") === key) { groups.key.push(j); continue; }
    const u = String(j.url == null ? "" : j.url).trim();
    if (u && urls[u]) { groups.url.push(j); continue; }
    if (wpItemMatchesJob(item, j)) groups.family.push(j);
  }
  const pick = (arr) => arr.find(dlJobActive) || arr[0] || null;
  return pick(groups.key) || pick(groups.url) || pick(groups.family);
}

/** job.percent（0..100 整数）。**只读列表里的数**，绝不按时间自己涨。
 *
 * 4.25.5：`/downloads/add` 的回执是队列内部的 job 对象（没有 snapshot 时算出来的
 * `percent`）⇒ 缺这一个字段时按 `received / total` 现算 —— 仍然是服务端的字节数，
 * 不是本地计时器推出来的估计值。
 */
function wpPercentOf(job) {
  const total = Math.max(0, Number(job && job.total) || 0);
  const recv = Math.max(0, Number(job && job.received) || 0);
  const raw = Number(job && job.percent);
  const n = Number.isFinite(raw) ? raw : (total > 0 ? Math.round((recv / total) * 100) : 0);
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * **服务端**的条目级 job 状态（`pending` / `queued` / `running` / `done` / `failed`）。
 *
 * 唯一来源是宿主随清单下发的两个字段（同一件事的两种读法）：
 *   · `item.mediaState.jobStatus`（对账器的状态表，`lib/routes/inventory.js` 的 `refreshLocalFields`）；
 *   · `item.jobStatus`（`jobFieldsOf()` 的扁平字段，老清单/夹具只给这个）。
 *
 * ⚠️ **客户端的乐观状态（`selection.playbackState`）永远不参与标题栏判断** ——
 * 4.25.5 的用户实测就是它造成的：「点了明日方舟 ⇒ job 被 burst 上限挤回 pending，
 * 界面却停在点击那一刻的 caching ⇒「缓存中」永远没有百分比」。
 */
function wpServerJobStatusOf(item) {
  const w = item || {};
  const ms = (w.mediaState && typeof w.mediaState === "object") ? w.mediaState : null;
  return String((ms && ms.jobStatus) || w.jobStatus || "").trim();
}

/**
 * **「已缓存」角标的唯一判据**（4.24.1，P0-5）：就看 inventory 条目的 `localReady`。
 *
 * ## 为什么必须收成一条
 *
 * 真实故障（用户实测 + 截图）：`/folia/inventory` 说 46 条里 **45 条 `localReady:true`**、
 * `library` 里 47 个文件、`jobs` 里 done=61 且 dest 全在（missing=0）—— 数据层完全一致，
 * 可卡片上「天空之城」「原神 绫华」**没有**「已缓存」角标。
 *
 * 根因是判据有**两份**：角标先读 `localReady`，但同一函数后面还在看"这条 URL 有没有 job"。
 * 于是"族里另一档刚下完、原画那条 job 还挂着 queued/running"时，卡片显示的是「缓存中 x%」
 * 而不是「已缓存」；job 一旦从列表里消失（宿主重启 / 队列被清），又退回到"没有 job ⇒ 不画"。
 *
 * 现在只有一条：**inventory 的 `localReady`（族级，宿主 `lib/switch-cache-family.js` 的族键算出）**。
 * 不看 job 状态、不看 URL 精确匹配、不看本地快照的其它字段 —— 那些都是"另一份会漂的判据"。
 * `local`（精确命中）也不再用：族级 `localReady` 已经覆盖它，两个都读就又是一份二义性。
 *
 * @param {any} item inventory 条目
 * @returns {boolean}
 */
function wpCachedOf(item) {
  return Boolean(item) && typeof item === "object" && item.localReady === true;
}

/**
 * 卡片状态机（纯函数）：
 *   cached（`localReady` 族命中） ⇒ 「已缓存」——**最高优先级**，压过任何 job 状态
 *   running / queued（队列里还有活） ⇒ 进度
 *   pending（任务在、但不在排队） ⇒ 「未缓存（点击继续）」
 *   failed（明确失败且这张卡还没缓存） ⇒ 原因 +「重试」
 *   none（没有 job 且没缓存） ⇒ 什么都不画（避免噪音）
 *
 * 4.25.5：`status` 的**兜底**来自服务端（`item.mediaState.jobStatus` / `item.jobStatus`），
 * 不再只看 `/downloads/list` 里"能不能按 URL 找到那条 job" —— 宿主把条目折成 pending、
 * 或 job 刚从列表里消失时，标题栏也要说得出「未缓存（点击继续）」。
 */
function wpStateOf(item, jobs) {
  const w = item || {};
  // ⚠️ 4.24.1（P0-5）：**先判缓存，再判 job**。旧顺序把 running/queued 放在前面 ⇒
  // "已经缓存了却显示缓存中/排队中"（用户截图里那两张卡就是这个形态）。
  if (wpCachedOf(w)) return { phase: "cached", job: null, percent: 100, cached: true };
  const job = wpJobForItem(jobs, w);
  // 队列行（更实时）优先；没有行时才读清单里的服务端事实。
  const status = String((job && job.status) || "") || wpServerJobStatusOf(w);
  if (status === "running") return { phase: "running", job, percent: job ? wpPercentOf(job) : 0, cached: false };
  if (status === "queued") return { phase: "queued", job, percent: 0, cached: false };
  // 4.23.18：`pending` = 记录在、成品不在、**没有排队**（启动时不再批量入队）。
  // 4.25.5：UI 必须说清「未缓存（点击继续）」—— 只剩一个按钮、没有文字是用户实测的故障。
  if (status === "pending") return { phase: "pending", job, percent: 0, cached: false };
  if (status === "failed") {
    return {
      phase: "failed", job, percent: 0,
      // 失败原因：队列行有 `error` 用它；只有清单事实时退回 `mediaState.reason`（宿主给的码）。
      code: String((job && job.error) || (w.mediaState && w.mediaState.reason) || "failed"),
    };
  }
  // ⚠️ `done` **不**等于已缓存（4.24.1 的判据收紧）：`done` 是"字节下完了"，`localReady` 是
  // "对账后确认可播"。两者在稳态下同时为真，但把 `done` 当成已缓存就又造了第二份判据 ——
  // 用户实测里正是这种"另一份判据"让角标与 localReady 分叉。
  // 这一格（done 但清单还没说 cached）只等 `wpRequestInventoryRefresh()` 把清单拉新；
  // 期间**不画角标**，也不谎称已缓存。
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

/** 4.25.1：`total` 未知时的阶段文案（绝不显示「缓存中 0%」/空白）。 */
function wpStageText(job) {
  const got = Math.max(0, Number(job && job.received) || 0);
  if (got > 0) return weT("已下载 {mb} MB", { mb: (got / 1048576).toFixed(1) });
  return weT("正在连接…");
}

/**
 * `running` 但**总量未知**时的标题文案（4.25.5）：「正在连接…（已等待 N 秒）」。
 *
 * 秒数**只读服务端 `job.at`**（入队时间戳）—— 客户端不自己起表：
 *   · 宿主没给 `at` / 时钟倒挂 ⇒ 只报「正在连接…」，不编数字；
 *   · 一旦 `total` 到手，`wpViewOf` 立刻切成百分比（同一个快照里就有，不必等下一拍）。
 */
function wpWaitingText(job, nowMs) {
  const at = Number(job && job.at) || 0;
  const now = Number(nowMs) || Date.now();
  const wait = (at > 0 && at <= now) ? Math.max(0, Math.round((now - at) / 1000)) : 0;
  return wait > 0 ? weT("正在连接…（已等待 {n} 秒）", { n: wait }) : weT("正在连接…");
}

/** 失败标题："下载失败：<原因>（点击重试）" —— 原因复用 `dlFailReason` 那张表，不另写一句。 */
function wpFailTitle(why) {
  return weT("下载失败：{why}（点击重试）", { why: String(why || "") });
}

/**
 * **唯一的视图函数**（纯函数）：item + 队列快照 ⇒ 卡片/标题栏该显示的文案与形态。
 *
 * 返回 null = 这一格什么都不该画（没有 job 且没缓存）。
 * `card`（卡片：短）/ `title`（标题栏：带已下/总量与约剩）/ `phase` / `percent` / `reason`。
 * 文案全部来自既有的 `dlQueueDetail` / `dlProgressDetail` / `dlFailReason`（四模块共用一张表），
 * 本文件不另造数字、不另写失败原因。
 *
 * 4.25.5 的状态机映射（标题栏，**全部由服务端事实派生**）：
 *
 *   pending              → 「未缓存（点击继续）」
 *   queued               → 「排队中：前面还有 N 个任务」
 *   running + total > 0  → 「缓存中 x%（a/b MB · 约剩 N 秒）」
 *   running + total = 0  → 「正在连接…（已等待 N 秒）」
 *   failed               → 「下载失败：<原因>（点击重试）」
 *   done + localReady    → 不画标题栏（卡片角标「已缓存」已经是明确状态）
 *
 * `nowMs` 只用于「已等待 N 秒」（可注入；缺省 Date.now()）。
 */
function wpViewOf(item, jobs, etaSec, nowMs) {
  const s = wpStateOf(item, jobs);
  if (s.phase === "running") {
    // 4.25.1：总量未知 ⇒ 阶段文案（正在连接… / 已下载 X MB），拿到 total 才切百分比。
    if (!(Number(s.job && s.job.total) > 0)) {
      return {
        phase: "running", percent: 0,
        card: wpStageText(s.job),
        title: wpWaitingText(s.job, nowMs),
      };
    }
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
  // 4.23.18：未缓存（pending）—— 卡片只给一个静态小标，**不画进度条、不报排队位置**。
  // 4.25.1：其中 pending + high = 上次点击没下完（启动/清队列留下）⇒ 明说「点击继续」，
  // 但**仍然不自动下载**（B1）。
  // 4.25.5（P0）：**标题栏也必须说话**。旧实现这里 `title: null` ⇒ 用户点完只剩一个按钮、
  // 一行字都没有（"缓存中"还是客户端乐观状态残留的）。现在标题栏给出服务端判定的那一句。
  if (s.phase === "pending") {
    const title = weT("未缓存（点击继续）");
    const high = Boolean(s.job && String(s.job.priority || "") === "high");
    return { phase: "pending", percent: 0, card: high ? title : weT("未缓存"), title };
  }
  if (s.phase === "cached") {
    return { phase: "cached", percent: 100, card: weT("已缓存"), title: null };
  }
  if (s.phase === "failed") {
    const why = dlFailReason(s.code);
    return { phase: "failed", percent: 0, card: weT("重试"), title: wpFailTitle(why), reason: why };
  }
  return null;
}

/** 当前快照下的视图（订阅回调用它：切回来第一帧就是 `/downloads/list` 的真实值）。 */
function wpSnapshotOf(item) {
  const jobs = WP_STORE.jobs;
  return wpViewOf(item, jobs, wpEtaOfItem(item, jobs), Date.now());
}

/** 视图签名：只有**显示内容**变了才通知订阅者（同一百分比重复推送不触发渲染）。 */
function wpSigOf(view) {
  return view ? [view.phase, view.percent, view.card, view.title, view.reason || ""].join("\u0001") : "";
}

/**
 * 已经为哪条 job 请求过"清单拉新"（每个 job 一次，避免在 1.5s 轮询里反复打 `/inventory`）。
 * 超过上限就整表清掉：这张表只是"别重复问"，丢一次最多多重问一次，不会出错。
 */
const WP_INV_ASKED = new Set();
const WP_INV_ASKED_MAX = 256;

/**
 * **下载完成后把角标拉新**（4.24.1，P0-5 第二条：不依赖用户手动刷新）。
 *
 * 角标读的是 inventory 的 `localReady`，而 inventory 带 30s 级别的清单缓存 —— 一条 job 刚
 * `done` 时，手上那份快照可能还是 `localReady:false`。不主动拉新的话，用户要等"下一次点开库 /
 * 换页签"才看得到角标（用户实测就是"已经缓存了但不显示"）。
 *
 * 口径：
 *   · 只在"有 job 变成 done、且它对应的卡片还说未缓存"时拉**一次**（按 jobId 记账，不重复问）；
 *   · 走 `loadInventory`（同一个入口，不另造清单请求）；拿不到（老宿主 / 测试作用域）就静默跳过；
 *   · 失败**不影响**已显示的角标 —— 下一拍轮询 / 用户操作仍会重试。
 *
 * @param {any[]} jobs `/downloads/list` 的 jobs
 * @returns {boolean} 是否真的请求了一次刷新
 */
function wpRequestInventoryRefresh(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  let want = false;
  for (const j of list) {
    if (!j || j.status !== "done" || !j.id) continue;
    const id = String(j.id);
    if (WP_INV_ASKED.has(id)) continue;
    let seenCard = false;
    let needs = false;
    for (const rec of WP_STORE.subs.values()) {
      if (!wpItemMatchesJob(rec.item, j)) continue;
      seenCard = true;
      if (!wpCachedOf(rec.item)) needs = true;
    }
    WP_INV_ASKED.add(id);
    // 只记卡没显示缓存的那些；已经显示缓存的（或没有卡订阅它）记下来不再问。
    if (seenCard && needs) want = true;
  }
  if (WP_INV_ASKED.size > WP_INV_ASKED_MAX) WP_INV_ASKED.clear();
  if (!want) return false;
  try {
    if (typeof WP_STORE.refreshInventory === "function") { WP_STORE.refreshInventory(); return true; }
    // 内联后同一个工厂作用域里就有 `loadInventory`（与 `weT` / `dlJobActive` 同一条"按名调用"口径）。
    // 用 typeof 守卫：本文件也被 `test/verify-wallpaper-progress.mjs` 在裸 Function 里真跑。
    if (typeof loadInventory === "function") { loadInventory(); return true; }
  } catch { /* 刷新失败不影响已显示的角标 */ }
  return false;
}

/** 注入清单刷新入口（测试/宿主可覆盖；缺省按名调 `loadInventory`）。 */
function setWpInventoryRefresher(fn) {
  WP_STORE.refreshInventory = typeof fn === "function" ? fn : null;
}

/**
 * 队列快照变了（`WpJobsBridge` 每次轮询后调）⇒ 只通知**显示内容真的变了**的卡。
 * `nowMs` 可注入（测试用固定时钟；生产调用不传 = Date.now()）。
 */
function wpPushJobs(jobs, nowMs) {
  const list = Array.isArray(jobs) ? jobs : [];
  WP_STORE.jobs = list;
  wpSampleEta(list, Number(nowMs) || Date.now());
  // 4.24.1（P0-5）：先把"清单可能过期"这件事处理掉，再按最新快照推视图。
  wpRequestInventoryRefresh(list);
  wpNotifySubscribers(nowMs);
}

/**
 * **单条**服务端 job 快照（`/downloads/add` 回执、或 `src/download-first.js` 自己的 1s 轮询）
 * ⇒ 并入快照并立即通知（4.25.5）。
 *
 * 为什么要有这条旁路：标题栏的状态必须由服务端事实派生，而队列那条轮询是 1.5s —— 用户点下
 * 一张壁纸后，宿主**立刻**就知道它是 `queued` 还是被 burst 上限挤回了 `pending`。等下一拍
 * 才改标题，那 1.5 秒里界面就该显示点什么的这段时间会停在乐观状态（用户实测的故障窗口）。
 *
 * 它**不是**第二套轮询（没有 timer、没有请求）：只是一次「把已知的服务端事实并进快照」。
 * 行按 `at` 倒序插回（与 `snapshot()` 同序），同一 id 覆盖旧的。
 */
function wpNoteJob(job, nowMs) {
  const id = String((job && job.id) || "");
  if (!id) return false;
  const row = Object.assign({}, job, { id, kind: String((job && job.kind) || "wallpaper") });
  const rest = (Array.isArray(WP_STORE.jobs) ? WP_STORE.jobs : [])
    .filter((j) => String((j && j.id) || "") !== id);
  WP_STORE.jobs = [row].concat(rest)
    .sort((a, b) => (Number(b && b.at) || 0) - (Number(a && a.at) || 0));
  wpNotifySubscribers(nowMs);
  return true;
}

/** 按当前快照给**所有订阅的卡**推一次视图（显示内容没变的不通知：签名去重）。 */
function wpNotifySubscribers(nowMs) {
  const list = WP_STORE.jobs;
  const at = Number(nowMs) || Date.now();
  for (const rec of [...WP_STORE.subs.values()]) {
    const view = wpViewOf(rec.item, list, wpEtaOfItem(rec.item, list), at);
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
      items: [lfAddItem(w, w.media, "high", true)],
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
  if (view.phase === "pending") {
    // 4.23.18：未缓存 = 静态小标（没有进度条）。点卡片会以 high 入队，变成「排队中」。
    return React.createElement("span", {
      className: "we-wp-pending", "data-we-wp": "pending", title: weT("未缓存（点它才开始下载）"),
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

/**
 * 标题栏（当前壁纸那一行）：这一行**必须始终说得出状态**（4.25.5 用户口径）。
 *
 *   running / queued ⇒ 进度 / 排队（带数字）
 *   pending          ⇒ 「未缓存（点击继续）」—— 这是 4.25.5 新增的一格：旧实现返回 null，
 *                      于是"点完被挤回 pending"的用户只剩一个按钮、没有文字
 *   failed           ⇒ 「下载失败：<原因>（点击重试）」+「重试」按钮
 *   cached / 无 job  ⇒ null（卡片角标「已缓存」已经是明确状态，不重复占一行）
 */
function wpTitleRender(view, item) {
  if (!view) return null;
  if (view.phase === "running" || view.phase === "queued" || view.phase === "pending") {
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
      React.createElement("span", { className: "we-wp-title__why" }, view.title || view.reason),
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
  wpCachedOf,
  wpServerJobStatusOf,
  wpStateOf,
  wpViewOf,
  wpSnapshotOf,
  wpPushJobs,
  wpNoteJob,
  wpRequestInventoryRefresh,
  setWpInventoryRefresher,
  wpSubscribe,
  wpUnsubscribe,
  wpCardRender,
  wpTitleRender,
  wpRetryDownload,
  useWallpaperProgress,
  WpJobsBridge,
  WpCardProgress,
};
