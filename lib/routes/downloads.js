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
 *   GET  /folia/downloads/list                        → 全部 job 快照（状态/进度/失败原因）+ byKind/byPriority
 *                                                       汇总 + queuedCount/pendingCount/paused + migration + installStallMs
 *   POST /folia/downloads/cancel  {id}                → 取消（保留 .part 供续传）
 *   POST /folia/downloads/pause   {paused}            → 暂停/恢复全部下载（4.23.18，运维开关）
 *   POST /folia/downloads/clear-queued                → 把 queued 且未开始的标成 pending（4.23.18）
 *   POST /folia/downloads/requeue {id}                → 客户端本地副本 404 时显式复位（4.23.19）
 *   GET  /folia/local-media/<id>                      → 已落地文件的字节（Range/HEAD 复用 serveFile；
 *                                                       done 但文件缺失 ⇒ 404 + 复位 queued，4.23.19）
 *   POST /folia/local-heal  {id|localUrl, …}          → **播放失败自愈**（4.23.15）：验本地副本，
 *                                                       坏⇒删+单流重下；内容没问题⇒切 1080p / 明说解不了
 *   GET  /folia/local-check                           → 坏文件账本（损坏/已清理/待重下）+ 最近发现清单
 *   POST /folia/local-verify                          → **全量**校验并修复（面板「校验并修复本地媒体」）
 *
 * 注入契约：`disposers` / `base` / `serveFile` / `log`（队列由本模块自建单例）。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// 优先级的**唯一**白名单与归一键都在队列模块里（HTTP 层只做校验，不再抄一份枚举）。
import { createDownloadQueue, normalizePriority, PRIORITIES } from '../download-queue.js';
// 1080p 变体选档：**纯函数**，与队列的自适应阈值共用同一个 0.6 MB/s 口径。
import {
  pickVariant, pickQuality, resolveJobExpectationFromItems,
} from '../variant-pick.js';
// **缓存族**（4.23.8）：原画与 1080p 变体是同一条缓存。判据见 test/verify-switch-smooth.mjs。
import { pickFamilyCopy } from '../switch-cache-family.js';
// **本地副本自愈**（4.23.15）：验成品字节、发现坏文件就删+重下、解不了就换 1080p。
import { createMediaSelfHeal } from '../media-selfheal.js';
// **单一状态模型 / 单一解析器 / 对账器**（4.23.19）：本地副本能不能播，只能由它回答。
// 依赖方向：本文件 → media-state → media-verify；队列只 import 它的两个纯函数（无环）。
import {
  createMediaReconciler, localMediaUrl, resolvePlaySrc,
} from '../media-state.js';
export const DEPS = ['disposers', 'base', 'serveFile', 'log', 'transcodeToPlayable', 'transcodePlayablePathFor', 'transcodePlayableProgress'];

/** 本地库与状态文件的位置（与其它路由同一口径：DSH_HOME 或桌面端的 harness 目录）。 */
function dshHome() {
  return process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
}

/* ── 4.23.22：**当前清单**是校验期望值的唯一来源 ─────────────────────────────
 *
 * 根因（4.23.21 用户实测）：入队那一刻的清单 sha 被写进 `job.expectSha` 并一直复用。
 * 站点随后更新了同一个 URL 的内容（对账也拿到了新 sha），job 仍拿旧值校验 ⇒ 必然
 * `hash-mismatch`，可实际下载到的就是站点当前那份字节。
 *
 * 结构性修复：job 不再持有期望值；校验发生在**下载完成那一刻**，由队列回调这里
 * `resolveExpectation(job)` 现问当前清单。清单条目来自各路由注册的**实时快照**：
 *   · wallpaper → `lib/routes/inventory.js`（站点清单 / 磁盘缓存）
 *   · skin      → `lib/routes/skins.js`
 *   · boot      → `lib/routes/boot.js`
 *   · pet       → `lib/routes/pets.js`
 * 快照为空（冷启动，路由还没拉过清单）时，wallpaper 允许读 `site-items.json` 的磁盘副本。
 * 仍然解析不到 ⇒ 返回 null，队列退化为长度 + 结构校验（`verified=none`），绝不猜哈希。
 *
 * `refreshExpectation(job)` 是**校验失败后的闭环**：强制刷新对应清单（绕过 60s/30s 缓存，
 * 带 `_ts` 抖动），再用刷新后的值判一次 —— 这样"清单缓存陈旧"也不会再误报。
 */

/** kind → { snapshot(): {items,base,at}|null, refresh(): Promise<snapshot|null> } */
const MANIFEST_SOURCES = new Map();

/**
 * 注册一个**清单来源**（路由在模块加载/注册时调用；同 kind 后注册者覆盖前者）。
 * @param {string} kind job.kind（`wallpaper` / `skin` / `boot` / `pet`）
 * @param {{ snapshot?: Function, refresh?: Function }} source
 */
export function registerManifestSource(kind, source) {
  const k = String(kind || '').trim().toLowerCase();
  if (!k || !source || typeof source !== 'object') return;
  MANIFEST_SOURCES.set(k, source);
}

function siteItemsCachePath() {
  const home = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(home, 'cache', 'site-items.json');
}

/** 30s 记忆（磁盘回退只读；实时快照优先）。 */
let SITE_CACHE_MEMO = null;
let SITE_CACHE_MEMO_AT = 0;
const SITE_CACHE_TTL_MS = 30000;
function loadSiteItemsCache() {
  const now = Date.now();
  if (SITE_CACHE_MEMO && now - SITE_CACHE_MEMO_AT < SITE_CACHE_TTL_MS) return SITE_CACHE_MEMO;
  try {
    const doc = JSON.parse(readFileSync(siteItemsCachePath(), 'utf8'));
    const items = Array.isArray(doc && doc.items) ? doc.items : [];
    if (!items.length) return null;              // 空缓存不记：下次仍给它机会（不固化成"没有"）
    let base = '';
    try {
      const u = doc && doc.status && doc.status.url;
      if (u) base = new URL(String(u)).origin;
    } catch { base = ''; }
    SITE_CACHE_MEMO = { items, base, at: Number(doc && doc.at) || 0 };
    SITE_CACHE_MEMO_AT = now;
    return SITE_CACHE_MEMO;
  } catch { return null; }
}

function snapshotForKind(kind) {
  const k = String(kind || 'wallpaper').trim().toLowerCase() || 'wallpaper';
  try {
    const src = MANIFEST_SOURCES.get(k);
    if (src && typeof src.snapshot === 'function') {
      const snap = src.snapshot();
      if (snap && Array.isArray(snap.items) && snap.items.length) return snap;
    }
  } catch { /* 实时快照失败 ⇒ 走磁盘回退 */ }
  // 4.23.22：冷启动时 wallpaper 的路由还没拉过清单 —— 用成功拉取时落盘的副本。
  if (k === 'wallpaper') {
    try {
      const disk = loadSiteItemsCache();
      if (disk) return disk;
    } catch { /* ignore */ }
  }
  return null;
}

function expectationFromSnapshot(job, snap) {
  if (!snap || !Array.isArray(snap.items) || !snap.items.length) return null;
  try {
    const exp = resolveJobExpectationFromItems(job, snap.items, snap.base);
    if (!exp) return null;
    return { url: exp.url, sha256: exp.sha256, bytes: exp.bytes, source: exp.source, at: Number(snap.at) || 0 };
  } catch { return null; }
}

/**
 * 队列的**校验注入位**：当前清单 → 期望 `(sha256, bytes, source)`；解析不到 ⇒ null。
 * 不抛（队列把 null 当"清单不可达"，退化为长度 + 结构）。
 */
function resolveCurrentExpectation(job) {
  return expectationFromSnapshot(job, snapshotForKind(job && job.kind));
}

/**
 * 队列的**刷新闭环注入位**：hash-mismatch 时强制拉一次对应清单并返回刷新后的期望。
 * 拿不到 ⇒ null（队列只在 job 上记 `refreshAttempted`，失败原因仍按 hash-mismatch）。
 */
async function refreshCurrentExpectation(job) {
  const k = String((job && job.kind) || 'wallpaper').trim().toLowerCase() || 'wallpaper';
  const src = MANIFEST_SOURCES.get(k);
  if (!src || typeof src.refresh !== 'function') return null;
  try {
    const snap = await src.refresh();
    const exp = expectationFromSnapshot(job, snap);
    if (exp) return exp;
  } catch { /* 刷新失败 ⇒ 用旧快照之外的信息判失败 */ }
  return null;
}

/**
 * 4.23.19（P0）：清缓存路由的**队列同步**入口。
 *
 * 只有队列**已经初始化**时才动它：没初始化 = 内存里没有旧 done 记录，下一次 `getDownloadQueue`
 * 会从已经被 `pruneDoneJobs` 处理的 JSON 重建，没必要为了清缓存先建一个队列。这样也避免
 * 测试/多 profile 场景下把"另一个 home 的队列"改坏。
 * @param {string[]} kinds
 * @param {{ dropExpectation?: boolean }} [opts]
 * @returns {number}
 */
export function resetQueuedDoneForKinds(kinds, opts) {
  try { return QUEUE ? QUEUE.resetDoneForKinds(kinds, opts) : 0; } catch { return 0; }
}

/** 进程内单例：接口与 inventory 共用同一个队列（并发上限/去重才有意义）。 */
let QUEUE = null;
/** 进程内单例：**本地副本状态**的唯一产地（`lib/media-state.js`）。 */
let RECONCILER = null;

/**
 * 拿对账器（**唯一状态模型**的宿主半边）。
 *
 * 它不认识 HTTP，也不自己挂定时器：四个对账时机（启动 / 清缓存 / `/local-media` 缺失 /
 * 下载完成）都由调用方触发 —— 时机是产品决策，不该藏在库里。见 `lib/media-state.js` 文件头。
 */
export function getMediaReconciler(log) {
  if (!RECONCILER) {
    RECONCILER = createMediaReconciler({
      queue: getDownloadQueue(log),
      log: log || (() => {}),
      // 4.23.22：对账/深度校验也问**当前清单**（不再读 job 上持久化的旧期望值）。
      resolveExpectation: resolveCurrentExpectation,
    });
  }
  return RECONCILER;
}

/** 测试用：拆掉两个单例（隔离 home 的用例切 case 时用，生产路径不存在）。 */
export function __resetMediaSingletons() {
  QUEUE = null;
  RECONCILER = null;
  SELF_HEAL = null;
}

export function getDownloadQueue(log) {
  if (!QUEUE) {
    QUEUE = createDownloadQueue({
      home: dshHome(),
      log: log || (() => {}),
      // 4.23.22：**校验输入**（完成那一刻现问当前清单）与**刷新闭环**（hash-mismatch 后强刷再判）。
      // 这两个回调是结构修复的关键：job 上不再有可复用的 expectSha。
      resolveExpectation: resolveCurrentExpectation,
      refreshExpectation: refreshCurrentExpectation,
      // 4.23.19（④ 下载完成）：落地那一刻把状态刷成"可播"（`noteDone` 只补一次盘上证据，
      // 不做启发式）。放在这里而不是每次 `/downloads/list` 全量 stat —— 那个在轮询路径上。
      onDone: (job) => {
        try { getMediaReconciler(log).noteDone(job && job.id); } catch { /* 对账失败不影响下载结论 */ }
      },
    });
  }
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
      // 4.23.22：自愈/全量校验的期望值也只问**当前清单**（不再读 job 上的旧 sha）。
      resolveExpectation: resolveCurrentExpectation,
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
 *
 * 4.23.19：判据不再是"job.status === done"，而是**唯一解析器** `resolvePlaySrc()` 的结论 ——
 * done 但文件不在 / 内容无效 / 正在下载，一律不算本地可播（`job.status` 只是输入之一）。
 */
export function localCopyFor(url, kind = 'wallpaper') {
  try {
    const job = queueJobFor(url, kind);
    if (!job || job.status !== 'done') return null;
    // 4.23.15：这份本地内容**内容没错、只是本机解不了**（自愈判过）⇒ 不要再把它选给播放器。
    // 跳过之后 `localFamilyCopyFor()` 会落到同族的 1080p 变体上 —— 这正是用户要的"自动切变体"。
    if (job.decodeUnsupported === true) return null;
    const state = getMediaReconciler().stateOfId(job.id);
    const src = resolvePlaySrc(state, { media: job.url });
    if (src.source !== 'local') return null;
    return { id: job.id, url: localMediaUrl(job.id), bytes: job.total };
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
    // 4.23.19：族级命中也要过同一个解析器（否则"族里那份已删"会从这里漏回本地地址）。
    const state = getMediaReconciler().stateOfId(hit.job.id);
    const src = resolvePlaySrc(state, { media: hit.job.url });
    if (src.source !== 'local') return null;
    return { id: hit.job.id, url: localMediaUrl(hit.job.id), bytes: hit.job.total, family: true };
  } catch { return null; }
}

/** 一条 URL 的**最新**本地状态（inventory 用它给条目挂 `fileExists` / `fileValid`）。 */
export function mediaStateOfUrl(url) {
  try { return getMediaReconciler().stateOfUrl(url); } catch { return null; }
}

/** `/diag/media-state` 的载荷（只读；见 lib/media-state.js 的 summary）。 */
export function mediaStateSummary() {
  try { return getMediaReconciler().summary(); } catch { return null; }
}

/**
 * **对账入口**（§C）：清缓存路由用同一份 reconciler（`reason:'cache-clear'`）。
 * 面板不需要它 —— 它读 `/diag/media-state` / `/downloads/list` 的 `mediaState`。
 */
export async function reconcileMediaState(inp) {
  try { return await getMediaReconciler().reconcileAll(inp || {}); } catch { return null; }
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
      // 4.23.18："未缓存"是 pending，不该混进 active（它没在跑、也不排队）。
      queued: jobs.filter((j) => j.status === 'queued').length,
      pending: jobs.filter((j) => j.status === 'pending').length,
      paused: jobs.paused === true,
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

  /**
   * **① 启动对账**（4.23.19）：挂载时把"job 说的状态"与"盘上的字节"对一次。
   *
   * 先 quick（stat + 长度 + mp4 结构，几十毫秒），把清单要用的事实立刻准备好；
   * 再在 2s 后跑一次 deep（≤20MB 算 sha256），把"长度对、内容错"的 4.23.6 遗留也清掉。
   * 两次都**不 pump**（`applyReconcile` 不排队）：对账只改状态，下载只由点击/在播/预取触发。
   */
  const reconciler = getMediaReconciler(log);
  try {
    Promise.resolve(reconciler.reconcileAll({ reason: 'startup' }))
      .then(() => { try { log('media-state: 启动对账完成 ' + JSON.stringify(reconciler.stats())); } catch { /* ignore */ } })
      .catch(() => { /* 对账失败不阻塞宿主 */ });
  } catch { /* ignore */ }
  try {
    const t = setTimeout(() => {
      Promise.resolve(reconciler.reconcileAll({ reason: 'startup-deep', deep: true })).catch(() => {});
    }, 2000);
    if (t && typeof t.unref === 'function') t.unref();
  } catch { /* ignore */ }

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
        /**
         * 4.23.22：**入队只记录"要下哪个 URL"**（url + kind + chosen）。
         *
         * 不再在这里解析/保存 sha256 —— 期望值属于"当前清单"，不属于 job。校验在下载完成
         * 那一刻由队列回调 `resolveCurrentExpectation(job)` 现问（见文件上方 MANIFEST_SOURCES）。
         * 这样站点在入队之后更新数据（换内容/换哈希）也不会让 job 拿旧值误判。
         */
        const r = downloadQueue.add({
          url: finalUrl, dest, kind, priority, chosenVariant: pick.chosen,
        });
        out.push({
          url: finalUrl, ok: true, priority,
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
      /**
       * 4.23.19：每行补上**盘上事实**（`fileExists` / `fileValid` / `localReady` / `mediaSource`）。
       * 客户端拿它做的只有一件事：**下载中/失效时绝不把 `<video>` 指到 local**。字段来自
       * 对账器（唯一产地），不是这里临时 stat —— 否则又是一份会漂的判据。
       */
      for (const j of jobs) {
        try {
          const st = reconciler.stateOfId(j.id);
          if (!st) continue;
          j.fileExists = st.fileExists === true;
          j.fileValid = st.fileValid === true;
          j.localReady = st.localReady === true;
          j.mediaSource = st.source;
        } catch { /* 单条状态读失败不影响整张表的形状 */ }
      }
      // 4.23.18「队列可运维」：`byPriority` / `queuedCount` / `pendingCount` / `paused` 都是
      // **标量汇总**（jobs 数组形状不变，旧客户端逐字兼容）。
      // 4.23.22：删掉 `migration` —— 期望值不再持久化，也就没有"迁移旧期望"这件事。
      /** @type {any} */
      const snapshot = jobs;
      const payload = {
        // 既有契约：jobs 是数组、byKind 是按 kind 的统计（旧客户端逐字兼容）。
        jobs, byKind: snapshot.byKind || {},
        // 4.23.18 新增的标量汇总。
        byPriority: snapshot.byPriority || {},
        queuedCount: Number(snapshot.queuedCount) || 0,
        pendingCount: Number(snapshot.pendingCount) || 0,
        paused: snapshot.paused === true,
        installStallMs: installStallMs(),
        // 4.23.19：一体化的「本地副本」读数（总数 / 可播 / 下载中 / 待下载 / 上次对账 / 异常）。
        mediaState: (() => { try { return reconciler.summary(); } catch { return null; } })(),
      };
      send(res, 200, Object.assign({ ok: true }, payload));
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

  /**
   * 4.23.23「显式升降优先级」：`POST /folia/downloads/priority { id?, url?, kind?, priority }`。
   *
   * download-first 的两条腿都走这里：
   *   · 用户切走 ⇒ `priority:"low"`：**只降级**，job 继续跑（不 pause / 不 cancel）；
   *   · 用户点回 ⇒ `/downloads/add` 带 `high` 即可（与既有点击提权同一条路）；
   *     这条端点也接受 `high`，给"知道 jobId 但还没入队"的恢复路径兜底。
   * 找不到 job ⇒ `{ ok: true, job: null }`（旧版本 / 已被清理都不算失败，客户端不阻塞切换）。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/priority`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readBody(req);
      const priority = String((body && body.priority) || 'low').trim().toLowerCase();
      if (priority !== 'high' && priority !== 'low' && priority !== 'normal') {
        send(res, 400, { ok: false, error: 'bad-priority' });
        return;
      }
      let row;
      try {
        row = downloadQueue.setPriority({
          id: String((body && body.id) || ''),
          url: String((body && body.url) || ''),
          kind: String((body && body.kind) || 'wallpaper'),
          priority,
        });
      } catch { /* 队列不可用：按未找到返回，客户端不阻塞切换 */ }
      send(res, 200, { ok: true, job: row || null });
    },
  }));

  /**
   * 4.23.18「暂停全部下载」：`POST /folia/downloads/pause { paused: true|false }`。
   * 暂停 = 不再取新任务 + 正在跑的 abort 回 queued（`.part` 保留，恢复后续传）。
   * 无 body 时按 `paused:true` 处理（"点一下先停住"是最常见的意图）。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/pause`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readBody(req);
      const want = body && Object.prototype.hasOwnProperty.call(body, 'paused') ? body.paused !== false : true;
      send(res, 200, { ok: true, ...downloadQueue.setPaused(want) });
    },
  }));

  /**
   * 4.23.19：`POST /folia/downloads/requeue {id}` —— 在播的这张本地副本坏了/丢了时的**显式复位**。
   *
   * 只对 `done` / `pending` 生效（downloading 的不动，它本来就在下；failed 走它自己的重试）。
   * 走 `invalidate()`：删残留 + 单流重下。为什么客户端要主动调：`/local-media` 的 404 只能
   * 把记录复位成 `pending`（不替用户决定"要不要重下"，见 `/local-media` 的注释），而**在播**的
   * 那张是例外 —— 用户正看着它，它必须自己回来。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/requeue`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readBody(req);
      const id = String((body && body.id) || '');
      if (!id) { send(res, 400, { ok: false, error: 'bad-id' }); return; }
      const job = downloadQueue.jobById(id);
      if (!job) { send(res, 404, { ok: false, error: 'no-job' }); return; }
      const actionable = job.status === 'done' || job.status === 'pending';
      const requeued = actionable ? Boolean(downloadQueue.invalidate(id)) : false;
      if (requeued) log('downloads/requeue: ' + id + '（' + job.status + '）本地副本不可用 ⇒ queued 重下');
      // 状态已变 ⇒ 让对账器重取证据（下一条 `/downloads/list` 才会说 "downloading"）。
      try { reconciler.stateOfId(id); } catch { /* ignore */ }
      send(res, 200, { ok: true, requeued, status: requeued ? 'queued' : job.status });
    },
  }));

  /**
   * 4.23.19（G 可观测）：`GET /folia/diag/media-state` —— 本地副本状态的对账读数。
   *
   * 返回：总条目 / 本地可用 / 下载中 / 待下载 / 失败 / 上次对账统计 / 最近 20 条异常（含原因）。
   * 面板「系统 → 缓存位置」那行摘要读的就是同一份数字。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/diag/media-state`,
    handler: (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'GET') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      let summary;
      try { summary = reconciler.summary(); } catch { summary = null; }
      send(res, 200, Object.assign({ ok: Boolean(summary) }, summary || {}));
    },
  }));

  /**
   * 4.23.18「清空未开始队列」：`POST /folia/downloads/clear-queued`。
   * 只把 `queued`（还没开始）标成 `pending`（未缓存），running / done / failed 一律不动。
   * 之后点壁纸 / 当前在播 / 预取会重新入队 —— 清空不是删除，是"先不缓存"。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/clear-queued`,
    handler: (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      send(res, 200, { ok: true, ...downloadQueue.clearQueued() });
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
      if (!src) {
        /**
         * 4.23.19（③ 对账时机）：**本地副本请求命中缺失**。
         *
         * 这里只做一件事：让对账器把这条 done 记录复位成 `pending`（并记一条异常）。
         * **不在这里替用户决定重下** —— "文件没了"不等于"用户还要这份缓存"：
         *   · 在播的那张：客户端收到 404 后会自己 `POST /downloads/requeue`（它在播，必须回来）；
         *   · 只是清单里扫到的一张：保持 pending，用户点它时 `add()` 才入队。
         * 4.23.19 之前这里直接 `invalidate()`（⇒ queued ⇒ 立刻重下），等于任何一次 404
         * 都偷偷往队列里塞一条下载 —— 这正是"队列自己长出来"的来源之一。
         */
        let reset = null;
        try { reset = reconciler.noteMissing(id, 'local-media-404'); } catch { /* ignore */ }
        send(res, 404, {
          ok: false,
          error: 'not-downloaded',
          // 客户端据此把源换成站点流并说"本地副本已丢失，正在重新下载"。
          reset: 'pending',
          source: 'proxy',
          jobStatus: reset ? reset.jobStatus : 'absent',
        });
        return;
      }
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
