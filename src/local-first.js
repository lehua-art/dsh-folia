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
      const resp = await apiPostJson("/downloads/add", {
        items: [lfAddItem(item, item.media, "low")],
      }, { parse: "always" });
      const items = (resp && resp.data && Array.isArray(resp.data.items)) ? resp.data.items : [];
      job = items[0] && items[0].job ? items[0].job : null;
      // 4.23.4：宿主可能**替我们选了 1080p 变体**（清单/设置/慢链路）。这不是失败 ——
      // 但要让人看得见：小标 + 一句说明（`chosenVariant` 来自宿主的同一个纯函数）。
      if (job && items[0] && items[0].chosenVariant === "1080p") {
        lfSay(`已按 1080p 变体下载：${label}（省流量；可在面板点「用原画」改回）`, true);
      }
    } catch { /* 入队失败：下面回退直连 */ }
    if (!job || !job.id) return;   // 下载链路不可用（老宿主 / 路由没注册）⇒ 静默跳过，播放照旧
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
    'download-failed': weT("下载失败（站点未返回文件），请稍后重试"),
    'download-timeout': weT("下载超时（已下部分会保留，再点「安装」可续传）"),
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

/** job 的排队位置：1 基 `queuePos` ⇒「前面还有 N 个」（N = queuePos - 1）。未知时只说"排队中"。 */
function dlQueueDetail(job) {
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
    const waited = Math.max(0, Math.round((now - (Number(o.sub.at) || now)) / 1000));
    if (waited * 1000 >= timeout) return fail('submit-timeout');
    return make(DL_PHASES.SUBMITTING, weT("正在提交…"),
      waited >= 3 ? weT("已等待 {s} 秒", { s: waited }) : "", true, false, "");
  }
  // ③ 包下完了、还没落地：宿主正在解压 / 规范化清单 / 写目录。
  if (job && job.status === 'done' && !o.done) {
    return make(DL_PHASES.INSTALLING, weT("解压/落位中…"), "", true, false, "");
  }
  // ④ 已经装好（或已下载）：按钮不再可点。
  if (o.done) return make(DL_PHASES.DONE, labels.done || weT("已安装"), "", true, false, "");
  // ⑤ 失败：队列 job 失败，或本卡片最近一次提交失败。两者都给「重试」+ 具体原因。
  if (job && (job.status === 'failed' || job.status === 'cancelled')) return fail(job.error || job.status);
  if (o.err && o.err.code) return fail(o.err.code);
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
 * 等一个 job 结束（done / failed / cancelled / timeout）。
 * 只读 list，所以**页面切走也不影响**：换成别的页签时这个等待仍在跑，回来时状态照样正确。
 */
function dlAwaitJob(jobId, timeoutMs) {
  const limit = Number(timeoutMs) || 30 * 60 * 1000;
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      if (Date.now() - started > limit) { resolve({ status: "timeout" }); return; }
      let job = null;
      try {
        const resp = await apiJson("/downloads/list");
        const doc = (resp && resp.data) || resp || {};
        const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
        job = jobs.find((j) => j && j.id === jobId) || null;
      } catch { /* 拉不到就再等一拍 */ }
      if (job && (job.status === "done" || job.status === "failed" || job.status === "cancelled")) { resolve(job); return; }
      setTimeout(tick, DL_POLL_MS);
    };
    tick();
  });
}

/**
 * React：订阅下载队列（三个页签共用）。
 * 挂载先拉一次；有未结束 job 才每 1.5s 拉；**卸载即清定时器**（切页签不泄漏）。
 * `refresh()` 用于"刚点了下载"——立刻重新起表，不必等下个 1.5s。
 */
function useDownloadJobs() {
  const [jobs, setJobs] = React.useState([]);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    let alive = true;
    let timer = null;
    const stop = () => {
      if (timer) { try { clearInterval(timer); } catch { /* ignore */ } timer = null; }
    };
    const pull = async () => {
      let list;
      try {
        const resp = await apiJson("/downloads/list");
        const doc = (resp && resp.data) || resp || {};
        list = Array.isArray(doc.jobs) ? doc.jobs : [];
      } catch { list = []; }
      if (!alive) return;
      setJobs(list);
      if (!dlHasActive(list)) stop();      // 全部结束 ⇒ 停表
    };
    pull();
    timer = setInterval(pull, DL_POLL_MS);
    try { if (timer && typeof timer.unref === "function") timer.unref(); } catch { /* ignore */ }
    return () => { alive = false; stop(); };
  }, [nonce]);
  return { jobs, refresh: () => setNonce((n) => n + 1) };
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
  const refreshRef = React.useRef(null);
  refreshRef.current = dl && typeof dl.refresh === "function" ? dl.refresh : null;

  // ① 提交中每秒走一格：「已等待 N 秒」与"到点即失败"都要它。只有提交中才开表。
  React.useEffect(() => {
    if (!sub || !sub.id) return undefined;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    try { if (t && typeof t.unref === "function") t.unref(); } catch { /* ignore */ }
    return () => { try { clearInterval(t); } catch { /* ignore */ } };
  }, [sub]);

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
  const api = {
    jobs,
    /** 立刻重拉一次队列（"刚点了"用；不必等下个 1.5s）。 */
    refresh: () => { try { if (refreshRef.current) refreshRef.current(); } catch { /* ignore */ } },
    /** 点击瞬间：这张卡片进入 submitting（立刻置灰 +「正在提交…」），并清掉它的旧失败。 */
    begin: (id) => {
      const k = key(id);
      setErrs((m) => {
        if (!Object.prototype.hasOwnProperty.call(m, k)) return m;
        const n = { ...m };
        delete n[k];
        return n;
      });
      setSub({ id: k, at: Date.now() });
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
      return dlCardState({
        id: x.id, job: x.job, done: x.done, labels: x.labels,
        sub: api.subOf(x.id), err: api.errOf(x.id), etaSec: api.etaOf(x.job), nowMs,
      });
    },
  };
  return api;
}

