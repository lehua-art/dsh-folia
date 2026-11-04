/**
 * routes/downloads.js — **站点资源本地化**的接口族（点击即下载，可并发）。
 *
 * 产品语义（用户明确要求，2026-10-30）：
 *   · **不用勾选**：用户点哪一条，那一条立刻开始下载；
 *   · 连点多条 ⇒ 它们**同时**在下载（队列并发上限 3，多余排队，不会互相拖死）；
 *   · 渲染方（我们 / 皮肤中心 / 播放器）只从本地取 —— 见 docs/LOCAL-FIRST-DOWNLOADS.md。
 *
 * 路由：
 *   POST /folia/downloads/add     {items:[{kind,url,priority}], priority} → 入队（幂等）；
 *                                 返回每个条目的 job 快照。priority ∈ high / normal / low（白名单，
 *                                 非法值回落 normal）；条目级 priority 优先于批次级。
 *   GET  /folia/downloads/list                        → 全部 job 快照（状态/进度/失败原因）+ byKind 统计
 *                                                       + installStallMs（"下完但没落地"的宽容窗口，4.23.6）
 *   POST /folia/downloads/cancel  {id}                → 取消（保留 .part 供续传）
 *   GET  /folia/local-media/<id>                      → 已落地文件的字节（Range/HEAD 复用 serveFile）
 *   POST /folia/local-heal  {id|localUrl, …}          → **播放失败自愈**（4.23.15）：验本地副本，
 *                                                       坏⇒删+单流重下；内容没问题⇒切 1080p / 明说解不了
 *   GET  /folia/local-check                           → 坏文件账本（损坏/已清理/待重下）+ 最近发现清单
 *   POST /folia/local-verify                          → **全量**校验并修复（面板「校验并修复本地媒体」）
 *
 * 注入契约：`disposers` / `base` / `serveFile` / `log`（队列由本模块自建单例）。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
// 优先级的**唯一**白名单与归一键都在队列模块里（HTTP 层只做校验，不再抄一份枚举）。
import { createDownloadQueue, normalizePriority, normalizeSha256, PRIORITIES } from '../download-queue.js';
// 1080p 变体选档：**纯函数**，与队列的自适应阈值共用同一个 0.6 MB/s 口径。
import { pickVariant, pickQuality } from '../variant-pick.js';
// **缓存族**（4.23.8）：原画与 1080p 变体是同一条缓存。判据见 test/verify-switch-smooth.mjs。
import { pickFamilyCopy } from '../switch-cache-family.js';
// **本地副本自愈**（4.23.15）：验成品字节、发现坏文件就删+重下、解不了就换 1080p。
import { createMediaSelfHeal } from '../media-selfheal.js';
export const DEPS = ['disposers', 'base', 'serveFile', 'log', 'transcodeToPlayable', 'transcodePlayablePathFor', 'transcodePlayableProgress'];

/** 本地库与状态文件的位置（与其它路由同一口径：DSH_HOME 或桌面端的 harness 目录）。 */
function dshHome() {
  return process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
}

/** 进程内单例：接口与 inventory 共用同一个队列（并发上限/去重才有意义）。 */
let QUEUE = null;
export function getDownloadQueue(log) {
  if (!QUEUE) QUEUE = createDownloadQueue({ home: dshHome(), log: log || (() => {}) });
  return QUEUE;
}

/** 进程内单例：坏文件账本要跨请求累计（面板读数与全量校验看的是同一份数字）。 */
let SELF_HEAL = null;
/**
 * 救援转码的**注入位**：`createMediaSelfHeal` 在模块单例化时把当时拿到的函数记下来。
 *
 * 为什么用模块级变量而不是把它塞进 `getMediaSelfHeal()` 的第二个参数：自愈单例可能
 * 被 `localCopyFor()` 之外的路径**先**创建（例如某次请求只碰了队列），那时的调用点
 * 没有注入面。这一段让"注册顺序"不再决定"救援转码能不能用" —— 少了它就是一条
 * 只在特定调用顺序下才失效的静默缺陷。
 */
let RESCUE = null;
/** 救援转码的**进度**查询（同上：注入位，供"正在生成 x%"那条文案用）。 */
let RESCUE_PROGRESS = null;
export function getMediaSelfHeal(log) {
  if (!SELF_HEAL) {
    SELF_HEAL = createMediaSelfHeal({
      queue: getDownloadQueue(log),
      log: log || (() => {}),
      // dest 的散列规则只有 `libraryDest` 一份 ⇒ 以函数注入，不在这里重算。
      destFor: (url, kind) => destForUrl(url, kind),
      // 救援转码（最后一档）：缺席 ⇒ 该档不可用（行为与 4.23.14 等价，不会假装成功）。
      transcodeToPlayable: RESCUE,
      transcodeProgressOf: RESCUE_PROGRESS,
      transcodeWaitMs: Number(process.env.DSH_FOLIA_HEAL_TRANSCODE_WAIT_MS) || undefined,
    });
  }
  return SELF_HEAL;
}

/**
 * 「下载已完成但没落地」的宽容窗口（4.23.6）——**宿主侧的唯一真源**。
 *
 * 为什么这条要在宿主解析：它管的是面板那条卡片的超时（`src/local-first.js` 的
 * `dlCardState` ③），而浏览器里没有 `process.env`。所以宿主读环境变量、把**数字**随
 * `/downloads/list` 一起下发，客户端只负责用（缺省时回落到同一个 90 秒常量）。
 *
 * 口径与队列/皮肤侧一致：默认 90000 ms；`DSH_FOLIA_INSTALL_STALL_MS` 覆盖；
 * **夹取 5s..30min**（比 5 秒短会把一次正常解压判成失败；比 30 分钟长就回到"永远卡住"）。
 * 非法值（非数字 / ≤0）不报错、按默认走 —— 环境变量写错不该让功能失效。
 */
const INSTALL_STALL_DEFAULT_MS = 90000;
const INSTALL_STALL_MIN_MS = 5000;
const INSTALL_STALL_MAX_MS = 30 * 60 * 1000;
export function installStallMs() {
  const raw = Number(process.env.DSH_FOLIA_INSTALL_STALL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return INSTALL_STALL_DEFAULT_MS;
  return Math.min(INSTALL_STALL_MAX_MS, Math.max(INSTALL_STALL_MIN_MS, Math.round(raw)));
}

/** <home>/library/<kind>/<sha256>.<ext>：同一 URL 同 kind ⇒ 同一路径（幂等的前提）。 */
function libraryDest(kind, slug, ext) {
  const h = createHash('sha256').update(String(kind) + '/' + String(slug) + '/' + String(ext)).digest('hex').slice(0, 32);
  return join(dshHome(), 'library', String(kind || 'media'), h + '.' + ext);
}

/**
 * URL → 落盘路径（`libraryDest` 的**唯一**调用口径，导出给自愈模块注入用）。
 *
 * 为什么抽出来：自愈要给 1080p 变体算 dest，而 dest 的散列规则**只许有一份** ——
 * 两处各写一遍，只要有一处漂了（例如 ext 的兜底不同），同一份内容就会落成两个文件，
 * 于是"下过了还是没命中"，那正是 4.23.8 花一整轮修掉的形态。
 * @param {string} rawUrl
 * @param {string} [kind]
 * @returns {string}
 */
export function destForUrl(rawUrl, kind = 'wallpaper') {
  const u = new URL(String(rawUrl));
  const ext = (u.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'bin';
  const slug = u.pathname.split('/').filter(Boolean).pop() || 'item';
  return libraryDest(kind, slug, ext);
}

/**
 * inventory 用：这条站点资源**是否已经落到本地**，以及它的 job id。
 * 命中 ⇒ inventory 把 `media` 指向 `/folia/local-media/<id>`（渲染只读本地）。
 * 未命中 ⇒ 返回 null，调用方保持原来的远端/代理地址（用户点了会先入队下载）。
 */
export function localCopyFor(url, kind = 'wallpaper') {
  try {
    const job = queueJobFor(url, kind);
    if (!job || job.status !== 'done') return null;
    // 4.23.15：这份本地内容**内容没错、只是本机解不了**（自愈判过）⇒ 不要再把它选给播放器。
    // 跳过之后 `localFamilyCopyFor()` 会落到同族的 1080p 变体上 —— 这正是用户要的"自动切变体"。
    if (job.decodeUnsupported === true) return null;
    return { id: job.id, url: `/folia/local-media/${job.id}`, bytes: job.total };
  } catch { return null; }
}

/**
 * inventory 用：这条站点资源**按缓存族**是否已落地（原画 / 1080p 任一档）。
 *
 * 为什么需要它（4.23.8 / 成因 ⑤「已缓存壁纸切换卡顿」）：`libraryDest()` 拿**最终 URL 的
 * basename** 做散列 ⇒ 原画 `x.mp4` 与 1080p `x-1080p.mp4` 是**两条独立缓存**。站点按
 * 「策略 A」替某条壁纸选了 1080p 下载之后，`localCopyFor(原画URL)` 依然未命中 ⇒ inventory
 * 判 `local:false` ⇒ `mediaProxy` 回落到站点代理 ⇒ **明明本地就有这份内容，点下去还要走
 * 一次「客户端 → 宿主 → 上游」的 HTTP 中继**。用户看到的就是"已下载好却还卡一下"。
 *
 * `local`（精确命中）语义保持不变 —— 排障要看的是"是不是恰好下了这一条"；面板与
 * `mediaProxy` 要看的是"能不能直接读本地"，那才是族级结论（`localReady`）。
 */
export function localFamilyCopyFor(url, kind = 'wallpaper') {
  try {
    const exact = localCopyFor(url, kind);
    if (exact) return { id: exact.id, url: exact.url, bytes: exact.bytes, family: false };
    const q = getDownloadQueue();
    const jobs = typeof q.snapshot === 'function' ? q.snapshot() : [];
    // 4.23.15：**优先选"本机能解"的那一份**。原画被自愈判成"解不了"之后，
    // 族里那一份 1080p 才是该播的；但族里若只有它自己（没有变体），
    // 仍然回落到本地那一份 —— 本地直出永远好过再走一次网络（两者都解不了，至少不白付流量）。
    const playable = jobs.filter((j) => !(j && j.decodeUnsupported === true));
    const hit = pickFamilyCopy(playable, url, kind) || pickFamilyCopy(jobs, url, kind);
    if (!hit || !hit.job) return null;
    return { id: hit.job.id, url: `/folia/local-media/${hit.job.id}`, bytes: hit.job.total, family: true };
  } catch { return null; }
}

/**
 * 这条 URL 所在的**域**本会话实测是不是慢（< 0.6 MB/s）。
 *
 * inventory 用它来给清单时刻的变体选档提供"速度"那一半判据 —— 阈值与实测都来自队列本身
 * （`createDownloadQueue().isSlowHost`），不在上层再写一个数。
 */
export function isSlowHostUrl(url) {
  try {
    const host = new URL(String(url)).host;
    const q = getDownloadQueue();
    return Boolean(q.isSlowHost && q.isSlowHost(host));
  } catch { return false; }
}

/**
 * 这条 URL 在下载队列里的**原始 job**（含 dest 绝对路径与状态），供 site-media 代理复用：
 * 代理拿着 dest 就能"渐进读正在增长的文件"，而不是再开一条上游连接。
 * 返回 null = 队列里没有这条（代理照旧走远端流式）。
 */
export function queueJobFor(url, kind = 'wallpaper') {
  try {
    return getDownloadQueue().jobFor(destForUrl(url, kind));
  } catch { return null; }
}

/** 队列汇总（给 /site-media-stats 用：壁纸缓存下了多少、多快）。 */
export function queueSummary() {
  try {
    const jobs = getDownloadQueue().snapshot();
    const done = jobs.filter((j) => j.status === 'done');
    return {
      jobs: jobs.length,
      done: done.length,
      bytes: done.reduce((a, j) => a + (Number(j.total) || 0), 0),
      active: jobs.filter((j) => j.status === 'running').length,
    };
  } catch { return null; }
}

export function registerDownloadsRoutes(webServer, c) {
  const { disposers, base, serveFile, log, transcodeToPlayable, transcodePlayablePathFor, transcodePlayableProgress } = c;
  const downloadQueue = getDownloadQueue(log);
  const BASE = base;
  // 4.23.15：救援转码的注入位必须在**建自愈单例之前**填好（见 RESCUE 的注释）。
  if (typeof transcodeToPlayable === 'function') RESCUE = transcodeToPlayable;
  if (typeof transcodePlayableProgress === 'function') RESCUE_PROGRESS = transcodePlayableProgress;
  // 4.23.15：**本地副本自愈**。挂载即排一次采样（30s 后、`unref`、不阻塞、不弹窗）。
  // 为什么在这里排：本文件是"本地库"这件事的唯一归属地（队列 + dest 规则 + 字节直出），
  // 自检的输入全都来自它；另开一族只为一行 setTimeout 不值当。
  const selfHeal = getMediaSelfHeal(log);
  try { selfHeal.scheduleStartupSample(); } catch { /* 定时器起不来不影响接口 */ }

  const readBody = (req, limit = 64 * 1024) => new Promise((resolve) => {
    let acc = '';
    let done = false;
    req.on('data', (d) => { if (!done) { acc += d; if (acc.length > limit) { done = true; resolve(null); } } });
    req.on('end', () => { if (!done) { done = true; try { resolve(JSON.parse(acc || '{}')); } catch { resolve(null); } } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });

  const send = (res, status, body) => {
    try {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    } catch { /* ignore */ }
  };

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/add`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readBody(req);
      const items = (body && Array.isArray(body.items)) ? body.items : [];
      if (!items.length) { send(res, 400, { ok: false, error: 'no-items' }); return; }
      // 优先级：body.priority 是"这一批的默认值"，单个条目还可以各自覆盖。
      // 白名单只有 high / normal / low，别的一律回落 normal（不报错 —— 旧客户端/旧调用方
      // 根本不会带这个字段，不能因为多巴胺写成 "urgent" 就把整批下载拒掉）。
      const bodyPriority = normalizePriority(body && body.priority);
      // 1080p 选档的"质量偏好"：批次级 `quality`（`auto`/`original`/`saver`），
      // 缺省读环境级设置 `DSH_FOLIA_QUALITY`（未设 = auto，与 4.23.3 的行为一致）。
      const bodyQuality = pickQuality((body && body.quality) || process.env.DSH_FOLIA_QUALITY);
      const out = [];
      for (const it of items.slice(0, 64)) {
        const url = String((it && it.url) || '');
        const kind = String((it && it.kind) || 'media');
        const priority = normalizePriority((it && it.priority) || bodyPriority);
        let u;
        try { u = new URL(url); } catch { out.push({ url, ok: false, error: 'bad-url' }); continue; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') { out.push({ url, ok: false, error: 'bad-protocol' }); continue; }
        /**
         * **1080p 变体选档**（4.23.4，策略 A 自动）。
         *
         * 决策只做一次、就在入队这一刻，而且用的是**纯函数**（`lib/variant-pick.js`）：
         *   · `variants` 由调用方从 inventory 条目原样带回（站点还没上线该字段时它缺席 ⇒ 原画）；
         *   · `hostSlow` 取队列自己 3 秒实测的慢域标记（同一个 0.6 MB/s 阈值，不重复量一次）；
         *   · `screenHeight` 由客户端上报（取不到就只按速度判）；
         *   · `quality` 单项可覆盖（「用原画」按钮走的就是这条），缺省读环境级 `DSH_FOLIA_QUALITY`。
         * 结论写进 job（`chosenVariant`），`/downloads/list` 与排障读同一个事实。
         */
        const pick = pickVariant({
          variants: it && it.variants,
          base: it && it.base,
          originalUrl: u.toString(),
          originalBytes: Number(it && it.bytes) || 0,
          quality: (it && it.quality) || bodyQuality,
          hostSlow: (() => { try { return downloadQueue.isSlowHost(u.host); } catch { return false; } })(),
          screenHeight: Number((it && it.screenHeight) || (body && body.screenHeight)) || 0,
          // 4.23.15：**解码上限预判**。5916×2530 的原画在 Chromium 上必解码失败，
          // 与"链路快不快"无关 ⇒ 选档阶段就要避开（理由见 lib/variant-pick.js 的 decode-limit）。
          originalWidth: Number(it && it.width) || 0,
          originalHeight: Number(it && it.height) || 0,
          // 4.23.15：4K@60 才是解码失败的主因 ⇒ 帧率必须参与选档（清单没给就 0，
          // 由 highFpsHit 按"宽>=3840"兜底）。
          originalFps: Number(it && (it.fps || it.frameRate)) || 0,
        });
        const finalUrl = pick.url || u.toString();
        // 选中变体时 URL 会变（原画 → 1080p，或反过来）：解析失败就退回请求里那个，
        // **绝不因为一条变体数据把整次下载拒掉**。
        let fu;
        try { fu = new URL(finalUrl); } catch { fu = u; }
        if (fu.protocol !== 'http:' && fu.protocol !== 'https:') { out.push({ url, ok: false, error: 'bad-protocol' }); continue; }
        const ext = (fu.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'bin';
        const slug = fu.pathname.split('/').filter(Boolean).pop() || 'item';
        const dest = libraryDest(kind, slug, ext);
        // 4.23.7：站点清单给的 sha256 随条目进队列（可能为空 ⇒ 队列跳过内容判据，
        // 长度 / Content-Range 两层仍然生效）。见 lib/download-queue.js 的 assertContentHash。
        const sha256 = normalizeSha256(it && it.sha256);
        const r = downloadQueue.add({
          url: fu.toString(), dest, kind, priority, chosenVariant: pick.chosen, sha256,
        });
        out.push({
          url: fu.toString(), ok: true, priority,
          // 选档结论随条目一起回去（客户端据此显示「1080p」小标，不用再猜）。
          chosenVariant: pick.chosen, variantReason: pick.reason,
          originalUrl: u.toString(),
          ...r,
        });
      }
      send(res, 200, { ok: true, items: out, priorities: PRIORITIES });
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/list`,
    handler: (req, res) => {
      // `jobs` 保持数组形状（既有契约）；`byKind` 是 4.23.2 新增的按类统计
      // （每类 running / queued / limit），面板排障与"皮肤有没有被壁纸挤掉"的取证都看它。
      // `installStallMs`（4.23.6）是"下完但没落地"的宽容窗口：**宿主解析、客户端用**
      // （浏览器里没有 process.env）。多一个标量字段，形状仍是向后兼容的。
      const jobs = downloadQueue.snapshot();
      send(res, 200, { ok: true, jobs, byKind: jobs.byKind || {}, installStallMs: installStallMs() });
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/cancel`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readBody(req);
      const id = String((body && body.id) || '');
      if (!id) { send(res, 400, { ok: false, error: 'bad-id' }); return; }
      send(res, 200, { ok: downloadQueue.cancel(id) });
    },
  }));

  // 本地库字节直出：Range / HEAD 由 serveFile 统一处理（与 /media 同一条实现）。
  // `?playable=1`（4.23.15）：出的是**救援转码产物**（H.264 / yuv420p / ≤1080p 副本），
  // 而不是库里的原文件。产物不存在时回 404 —— **绝不静默改回播原片**：那会让客户端
  // 以为"已经修好了"却再次撞上同一个解码错误。
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/local-media`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const raw = String(req.url || '');
      const noQuery = raw.split('?')[0];
      const query = raw.slice(noQuery.length);
      const id = noQuery.split('/').filter(Boolean).pop() || '';
      const wantPlayable = /(?:^|[?&])playable=1(?:&|$)/.test(query);
      const src = downloadQueue.pathFor(id);
      if (!src) { send(res, 404, { ok: false, error: 'not-downloaded' }); return; }
      /** @type {string | null} */
      let abs = src;
      if (wantPlayable) {
        let p;
        try { p = typeof transcodePlayablePathFor === 'function' ? transcodePlayablePathFor(src) : null; } catch { p = null; }
        if (!p) { send(res, 404, { ok: false, error: 'playable-not-ready' }); return; }
        abs = p;
      }
      serveFile(abs, req, res, method === 'HEAD');
    },
  }));

  /**
   * **播放失败自愈**（4.23.15，P0）。`POST /folia/local-heal`。
   *
   * 客户端 `<video>` 报 error 且当前源是 `/folia/local-media/<id>` 时才会调到这里；
   * 本路由只做一件事：把"这条本地副本"交给 `media-selfheal` 的判定，然后按结论动作：
   *   corrupt ⇒ 删成品 + 作废完成记录 + 单流重下（响应里带同一个 jobId，客户端轮询重挂）
   *   variant ⇒ 入队 1080p 变体（响应里带新 jobId 与本地地址）
   *   其余    ⇒ 只回结论，客户端据此说清「本机不支持该编码」/「超出本机解码能力」
   *
   * ⚠️ **命名是判据，不是风格**：这条**不能**叫 `/media/heal` —— `/media` 是已注册的
   * **prefix** 路由（`lib/routes/media-bytes.js`，而且比本族先注册），同前缀的子路径会被它
   * 吃掉，客户端只会看到"接口不存在"。同理不能挂在 `/local-media` 下（那也是 prefix）。
   * 所以三条自愈接口一律 `local-*`（与 `local-media` 互不为前缀）。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/local-heal`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = (await readBody(req)) || {};
      let out;
      try {
        out = await selfHeal.heal({
          id: String(body.id || ''),
          localUrl: String(body.localUrl || ''),
          originUrl: String(body.originUrl || ''),
          sha256: String(body.sha256 || ''),
          variants: body.variants,
          base: String(body.base || ''),
          title: String(body.title || ''),
          playing1080p: body.playing1080p === true,
        });
      } catch (e) {
        log('local-heal failed: ' + String((e && e.message) || e));
        out = { verdict: 'error', message: String((e && e.message) || e) };
      }
      send(res, 200, { ok: true, ...out });
    },
  }));

  /** 坏文件账本（只读）：面板「损坏文件：N 个（已清理/待重下）」读这一格。 */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/local-check`,
    handler: (req, res) => { send(res, 200, { ok: true, health: selfHeal.health() }); },
  }));

  /**
   * **全量**校验并修复（面板「校验并修复本地媒体」）。判据与启动采样同一条代码路径，
   * 只是范围从"最近 20 个"变成"全部已落地成品"。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/local-verify`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      let out;
      try { out = await selfHeal.verifyAllP(); } catch (e) {
        out = { checked: 0, damaged: 0, items: [], error: String((e && e.message) || e) };
      }
      send(res, 200, { ok: true, ...out, health: selfHeal.health() });
    },
  }));
}
