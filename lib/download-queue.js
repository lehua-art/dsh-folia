/**
 * download-queue.js — **站点资源批量下载队列**（壁纸 / 开机动画 / 桌宠 / 皮肤包共用）。
 *
 * 产品流程（用户明确要求的）：
 *   站点资源 → **先下载到本地** → 渲染方（我们 / 皮肤中心）只从本地取。
 *   并且允许**一次勾选很多个并发下载**，而不是点一个下一个。
 *
 * 设计要点（与仓库其它地方同一套纪律）：
 *   · **按 kind 的独立并发槽**（skin 2 / wallpaper 2 / pet 1 / boot 1 / 其它 2）+ 全局上限
 *     （4.23.3 起默认 6，`DSH_FOLIA_CONCURRENCY` 可调，夹 1..8）：
 *     "看壁纸的同时装皮肤"曾经卡在「安装中…」——壁纸预取把同一队列的 3 个槽全占了。
 *     现在壁纸最多占自己那 2 个槽，皮肤永远拿得到自己的槽；全局上限仍封顶总带宽。
 *   · **自适应多连接**（4.23.3，`DSH_FOLIA_RANGED=auto|1|0`）：先单流，开始后 3 秒实测慢
 *     （< 0.6 MB/s）且还剩 > 4 MB ⇒ 从 `.part` 偏移续多连接（默认 8 路，
 *     `DSH_FOLIA_CHUNKS` 2..16）。低 RTT 单流最优、高 RTT 多路最优，两边实测见文件下方常量注释。
 *   · **优先级**（high / normal / low，同一 kind 内生效）：用户主动点击 = high，
 *     后台预取 = low。排序键 = (优先级 高→低, 入队时间 早→晚)，同刻再按入队序号，结果确定。
 *   · 断点续传：`.part` + meta（url/size）；同一 URL 再入队时按已下载字节续。
 *   · 幂等 + 去重：同一 URL 只会有**一个** job；重复入队返回既有 job（调用方据此显示"已在下/已完成"）。
 *   · 落盘路径由调用方给（`dest` 绝对路径），本模块只保证"原子完成"（完成才 rename）。
 *   · 可失败：单个 job 失败只标记该 job，不拖垮队列；失败可重试（`retry`）。
 *   · 持久化：快照写 `$DSH_HOME/downloads.json`，宿主重启后**已完成**的仍在（供"本地优先"判据），
 *     未完成的标记为 `queued` 继续。
 *
 * 不做的事（明确）：不解析 zip、不决定渲染方式 —— 那是调用方（安装器 / 播放器）的事。
 */
import {
  createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
// 4.23.15（P0-5）：**无效媒体不入库**的判据住 `media-verify.js`（纯结构、不需要 ffmpeg）。
// 依赖方向是 queue → media-verify（那边不 import 本模块），模块图里没有环。
import { invalidMediaReason } from './media-verify.js';
// 4.23.19：**启动时的状态映射只有一个产地**（`startupStatusFor`）—— 4.23.18 把它写在
// `load()` 里，于是"done+缺失 ⇒ pending"没有第二个出口（永不重下）；收敛到 media-state 之后，
// 对账器与启动映射读同一条判据，改一处即全改。依赖方向 queue → media-state → media-verify。
import { mediaResetPatch, startupStatusFor } from './media-state.js';

/**
 * **自适应多连接**（4.23.3）：默认先单流，慢到一定程度才切多连接。
 *
 * 为什么不能"要么全单流、要么全多路"—— 两条**实测**都成立，而且结论相反：
 *   · 本机（低 RTT，4.6–4.9 MB/s）：单流最快；3 路 Range 反而更慢（2.13 vs 3.28 MB/s）。
 *     多连接在低 RTT 线路上只是互相抢窗口、抢 TCP 公平性。
 *   · 用户另一台（高 RTT ≈0.8 s，单流 0.21 MB/s）：12 路 Range 快 6 倍（1.28 MB/s）。
 *     单条 TCP 被带宽时延积卡死时，只有多连接能把窗口"拼"起来。
 * 所以默认 `auto`：先按大多数机器最优的单流跑，**开始后 3 秒**用实测吞吐决定要不要切。
 *
 * 判据（改动前先想清楚，这三条是这次需求的原文）：
 *   · 平均吞吐 < 0.6 MB/s（高 RTT 典型值 0.21，低 RTT 典型值 4+，中间地带不折腾）；
 *   · 且剩余字节 > 4 MB（小文件切过去只多花握手时间）；
 *   · 切换从 `.part` 当前**偏移**续传，已下载的字节一个都不重下。
 *
 * `DSH_FOLIA_RANGED`：`auto`（默认）| `1`（一开始就多连接）| `0`（永不切换，恒单流）。
 * `DSH_FOLIA_CHUNKS`：多连接路数，默认 8，夹在 2..16。
 */
const ADAPTIVE_EVAL_MS = 3000;
const ADAPTIVE_SLOW_MBPS = 0.6;
const ADAPTIVE_MIN_REMAINING = 4 * 1024 * 1024;
/** 显式 `DSH_FOLIA_RANGED=1` 时的最小文件：沿用 4.22 的口径，小文件不为此多开 8 条连接。 */
const RANGED_MIN_BYTES = 8 * 1024 * 1024;
const CHUNKS_DEFAULT = 8;
const CHUNKS_MIN = 2;
const CHUNKS_MAX = 16;
/**
 * 全局并发上限。
 *
 * 4.23.3 起默认 6（可用 `DSH_FOLIA_CONCURRENCY` 覆盖，夹在 1..8）：
 * 「皮肤 / 壁纸 / 桌宠 各自有槽」之后，各类上限之和（skin 2 + wallpaper 2 + pet 1 + boot 1）= 6，
 * 所以 6 才是"每种都能开满"的真实上限；4 会在四种同时有活时把某一类饿一下。
 * 它仍然是一道**总带宽闸门** —— 弱网机器可以用环境变量调回 1..8 之间任意值。
 */
const DEFAULTS = { concurrency: 6, retries: 1 };

/**
 * 队列发出所有 HTTP 请求时共用的请求头（**唯一一份**）。
 *
 * 为什么要收成一个常量：同一个 `user-agent` 以前在「多连接分片 / 单流续传 / 主下载」三处
 * 各写了一遍 —— 改一处漏两处时，排障看到的 UA 会变成三种（分不清哪一路在拉字节）。
 * 值本身也是排障标记：站点日志里 `dsh-folia/download-queue` 就是本机下载队列。
 */
const UA = { 'user-agent': 'dsh-folia/download-queue' };

/** `DSH_FOLIA_RANGED` → `auto` | `force` | `off`（未知值按 `auto`，不为一个拼错的环境变量改行为）。 */
function rangedMode() {
  const raw = String(process.env.DSH_FOLIA_RANGED == null ? '' : process.env.DSH_FOLIA_RANGED).trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') return 'force';
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return 'off';
  return 'auto';
}

/** 多连接路数：默认 8，`DSH_FOLIA_CHUNKS` 夹在 2..16（1 路等于单流，不算多连接）。 */
function rangedChunks() {
  const raw = Number.parseInt(String(process.env.DSH_FOLIA_CHUNKS == null ? '' : process.env.DSH_FOLIA_CHUNKS), 10);
  if (!Number.isFinite(raw)) return CHUNKS_DEFAULT;
  return Math.min(CHUNKS_MAX, Math.max(CHUNKS_MIN, raw));
}

/** 并发夹取：1..8。非数字 ⇒ 默认 6（调错环境变量不该让队列停摆或开满）。 */
function normalizeConcurrency(value) {
  const raw = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(raw)) return DEFAULTS.concurrency;
  return Math.min(8, Math.max(1, raw));
}

/** `DSH_FOLIA_CONCURRENCY` → 生效的全局并发（默认 6，夹在 1..8）。 */
function concurrencyFromEnv() {
  return normalizeConcurrency(process.env.DSH_FOLIA_CONCURRENCY);
}

/** job 的 host（"慢标记"按域记：同一站点的后续任务直接多连接）。 */
function hostOf(url) {
  try { return new URL(String(url)).host; } catch { return ''; }
}

/** job 的下载模式：`single` | `ranged:<n>`（`/folia/downloads/list` 与面板直接显示这个字段）。 */
function jobMode(job) {
  const m = String((job && job.mode) || '');
  return /^ranged:\d+$/.test(m) ? m : 'single';
}

/**
 * 这个异常是不是"本地文件不见了"（`ENOENT`）—— 4.23.17：**不是**链路失败，先自己重下。
 * 判据看 `code`（Node 的 fs 错误一定带），再用 message 兜底（被包了一层 Error 的场合）。
 */
function isEnoentError(e) {
  if (!e) return false;
  if (String(e.code || '') === 'ENOENT') return true;
  return /ENOENT/i.test(String(e.message || ''));
}

/**
 * **按 kind 的独立并发槽**（用户明确要求：不同类型的下载不要互相抢槽位）。
 *
 * 为什么不是拆成多个队列 / 多个 downloads.json：断点续传、幂等去重、容量统计、
 * 清理与 `/downloads/list` 都只认一份状态；拆文件把这些复杂度乘了 N，却没有多出任何能力。
 * 单队列 + 每 kind 一个 running 计数，语义等价、改动最小。
 *
 * 各值可用环境变量覆盖（如 `DSH_FOLIA_QUEUE_SKIN=2`）：弱网机器可以调小，
 * 宽带机器可以调大，不需要改代码。
 */
const KIND_LIMITS = { skin: 2, wallpaper: 2, pet: 1, boot: 1, default: 2 };

/**
 * 4.25.1（连点语义）：**未开始队列上限** = 8。
 *
 * 用户一次快速连点 30 张时，前 8 张之外不再堆进 queued（它们会显示「排队中」、占满队列位）；
 * 超出部分回落到 `pending`（未缓存、不下载、不显示排队位置），用户再点它时立刻拉回队列。
 * `wallpaper` 的**同时下载**上限仍是 `KIND_LIMITS.wallpaper = 2` —— 这两个数不是一回事：
 * 前者约束"等待队列长度"，后者才是"并行下载数"。
 */
const BURST_QUEUE_MAX = 8;

/**
 * 优先级：**同一 kind 内部**决定谁先被取。
 *   high   = 用户主动点击（安装皮肤 / 手动下载）
 *   normal = 默认
 *   low    = 后台预取（例如「看壁纸时顺手把下一张下到本地」）
 * 跨 kind 由各自的槽位隔离，优先级**不能**越过 kind 上限（否则皮肤又会把壁纸挤掉）。
 */
const PRIORITY_RANK = { high: 3, normal: 2, low: 1 };
/** 白名单（HTTP 层与持久化层共用同一份，避免两处各写一遍）。 */
export const PRIORITIES = ['high', 'normal', 'low'];

/** 非法 / 缺失 ⇒ `normal`（旧 jobs.json 没有这个字段，必须照旧能用）。 */
export function normalizePriority(raw) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_RANK, raw) ? raw : 'normal';
}
function rankOf(job) {
  return PRIORITY_RANK[normalizePriority(job && job.priority)] || PRIORITY_RANK.normal;
}

/**
 * 队列的**唯一排序口径**（4.23.18）：pump、`queuePos`、`queueAhead` 必须都读它。
 *
 * 键序：① 优先级 high→low；② **提权序号**大→小（用户刚点 / 当前在播排最前）；
 * ③ 入队时间早→晚；④ 入队序号小→大（同毫秒也定序）。
 * `queueAheadOf()` 也用这个比较函数，于是"面板说前面还有 N 个"与"实际先取谁"不可能漂。
 */
export function compareQueueOrder(a, b) {
  return (rankOf(b) - rankOf(a))
    || ((Number(b && b.boostSeq) || 0) - (Number(a && a.boostSeq) || 0))
    || ((Number(a && a.at) || 0) - (Number(b && b.at) || 0))
    || ((Number(a && a.seq) || 0) - (Number(b && b.seq) || 0));
}

/**
 * **同 kind + 同优先级档**里，排在这条 job 前面的 queued 任务数（0 = 队首）。
 *
 * 为什么不是全局位置：标题栏的「前面还有 N 个」曾把**别的 kind**（皮肤）与**别的优先级档**
 * 一起算进去。实测用户看到 50 而壁纸队列只有 31，正是这种串号。kinds 各自有独立并发槽，
 * 皮肤排几个并不会让这张壁纸晚一秒；N 必须只数"同一队里真正挡在它前面的那些"。
 *
 * 纯函数：`jobs` 可以是任意 job 快照数组（测试用假队列即可），不依赖队列实例。
 * 找不到 / 不是 queued ⇒ 返回 null（调用方回落旧字段，不编数字）。
 * @param {any[]} jobs
 * @param {string} id
 * @returns {number|null}
 */
export function queueAheadOf(jobs, id) {
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.status === 'queued');
  const me = list.find((j) => String(j.id) === String(id));
  if (!me) return null;
  const kind = kindOf(me);
  const rank = rankOf(me);
  let ahead = 0;
  for (const j of list) {
    if (j === me) continue;
    if (kindOf(j) !== kind || rankOf(j) !== rank) continue;
    if (compareQueueOrder(j, me) < 0) ahead += 1;
  }
  return ahead;
}
/** job 的 kind 归一键（空 ⇒ `default`；大小写/空白不敏感，避免 `Skin` 与 `skin` 各占一份额度）。 */
function kindOf(job) {
  const k = String((job && job.kind) || '').trim().toLowerCase();
  return k || 'default';
}
/** kind 的并发上限：环境变量 > 内置表 > default。 */
function limitForKind(kind) {
  const envName = 'DSH_FOLIA_QUEUE_' + String(kind).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const raw = Number.parseInt(String(process.env[envName] == null ? '' : process.env[envName]), 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return Object.prototype.hasOwnProperty.call(KIND_LIMITS, kind) ? KIND_LIMITS[kind] : KIND_LIMITS.default;
}

/**
 * 统一写 job 字段。
 *
 * 为什么不用 `job.status = ...`：`require-atomic-updates` 会把"await 之后逐字段写外部对象"
 * 判成竞态。这里实际是**单写者**（每个 job 只被自己的 runOne 推进），所以用 Object.assign
 * 表达"一次写入一组字段"的意图，规则也就不再误报。
 */
function setJob(job, patch) { Object.assign(job, patch); }

function urlKey(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
}

/* ── 4.25.1：**条目级身份**（itemKey）──────────────────────────────────────────
 *
 * 真实故障（用户实测 4.25.0）：同一张壁纸先按变体 URL（`.1080p.mp4` / `.30fps.mp4`）
 * 入队，后来清单换回原始 URL 再点 ⇒ `add()` 用 URL 做键，于是又建了一条新 job；
 * 旧变体 job 永远停在 `pending`，界面上「缓存中」却没有百分比。
 *
 * 这里引入**条目级键**：一个条目（壁纸）只有一条 job，URL 只是这条 job 当前要下的对象。
 * 客户端从清单条目 id 生成 `wallpaper:<id>`；老客户端/老数据没有 itemKey 时用同一媒体的
 * **族键**（去掉 `1080p` / `30fps` / `4k30` 这类变体后缀）兜底 —— 原画与变体天然同族。
 */
const ITEM_MEDIA_EXT_RE = /\.(?:mp4|webm|mov|m4v|mkv|avi|jpg|jpeg|png|webp|gif|avif|zip)$/i;
const ITEM_VARIANT_SUFFIX_RE = /(?:[._-](?:1080p|1440p|2160p|4k30|4k|30fps|60fps|h264|hevc|av1|transcoded))+$/i;

function normalizeItemKey(raw) {
  return String(raw == null ? '' : raw).trim();
}

/** 同一媒体的族键：忽略变体后缀与查询串；解析失败返回空串（调用方回落到 urlKey）。 */
function mediaFamilyKey(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    const parts = u.pathname.split('/');
    const file = parts.pop() || '';
    let stem = file.replace(ITEM_MEDIA_EXT_RE, '');
    stem = stem.replace(ITEM_VARIANT_SUFFIX_RE, '');
    const dir = parts.filter(Boolean).join('/');
    return u.origin + '/' + (dir ? dir + '/' : '') + stem;
  } catch { return ''; }
}

/** 没有显式 itemKey 时的稳定默认键：同 kind + 同族媒体 ⇒ 同一条目。 */
function defaultItemKey(url, kind) {
  const k = String(kind || 'media').trim().toLowerCase() || 'media';
  const fam = mediaFamilyKey(url);
  return fam ? k + ':url:' + fam : k + ':' + urlKey(String(url || ''));
}

/** 这条 job 的 itemKey 是否只是"按 URL 族推出来的默认键"（不是清单条目的稳定 id）。 */
function isDefaultItemKey(job) {
  return !normalizeItemKey(job && job.itemKey)
    || normalizeItemKey(job.itemKey) === defaultItemKey(job && job.url, job && job.kind);
}

/**
 * 解析 `Content-Range: bytes <start>-<end>/<total>`（`total` 允许是 `*`）。
 *
 * 4.23.7（P0-②）的**唯一**版本判据来源。旧实现只看 `status === 206`，于是"站点对同一
 * URL 有两个版本"（全量给旧版 17,509,106、Range 回源给新版 17,414,581）时每一片都算成功，
 * 拼出来的文件长度对、内容错。`start/end` 必须逐字等于**我们请求的那一段**，`/total`
 * 必须是**同一个总量** —— 否则这些字节属于另一个对象，一片都不能用。
 *
 * 返回 null = 头缺失 / 形态不认识 ⇒ 调用方按"无法核对版本"拒绝继续（不是放行）。
 */
export function parseContentRange(raw) {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(raw == null ? '' : raw).trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

/**
 * 站点清单给的 sha256（**可以没有**：实测皮肤包/壁纸有一部分是空串）。
 * 只认 64 位十六进制；其它任何形态一律当"未提供"—— 一条脏字段不该让下载判失败。
 */
export function normalizeSha256(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : '';
}

/**
 * 文件字节数；读不到（不存在 / 权限 / 是目录）⇒ `fallback`。
 *
 * 默认 `-1` 是**判据的一部分**：`0` 字节的 `.part` 与"盘上没有 `.part`"必须能分开
 * （前者是"上一轮刚建文件就被杀"，后者是"从没开始下"）。4.24.1 的 `.part` 体检、
 * 启动清理都只认这一个读数，不许各处自己 stat。
 */
function bytesOf(file, fallback = -1) {
  try { return statSync(file).size; } catch { return fallback; }
}

/**
 * 目录项；目录不存在 / 读不了 ⇒ `[]`。
 *
 * 启动清理只做"存在就删"，目录缺失是**正常状态**（没下过皮肤包的机器就没有
 * `cache/skins-zip`），不该因此报错或跳过整轮清理。
 */
function dirEntries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** 流式计算文件 sha256（1 MB 块；不把十几 MB 整读进内存）。 */
function hashFileP(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(file, { highWaterMark: 1024 * 1024 });
    s.on('data', (b) => h.update(b));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/*
 * 4.23.22：**期望值不再从 job 上读**（旧 `assertContentHash(job, file)` 读 `job.sha256`）。
 *
 * 真实事故（4.23.21，用户机器）：job 的 `expectSha` 是**入队那天**的清单 sha，站点后来
 * 更新了同一个 URL 的内容（对账也拿到了新 sha），但 job 仍拿旧值校验 ⇒ 必然 hash-mismatch。
 * 下载到的字节与站点当前清单逐字一致 —— 错的是"把入队那一刻的期望持久化后复用"。
 *
 * 现在的校验函数在 `createDownloadQueue` 作用域里（`verifyCompletedFile`）：完成那一刻问
 * `resolveExpectation(job)` 拿**当前清单**；hash 不符时再 `refreshExpectation(job)` 强制
 * 刷新清单重判一次。job 上只写"这次实际用了什么"（`verified*`），下次校验不读它。
 */

export function createDownloadQueue(opts = {}) {
  const {
    home,                        // 状态文件所在目录（调用方给）
    log = () => {},
    // 默认值在**每次调用**时读环境变量（`DSH_FOLIA_CONCURRENCY`，默认 6，夹 1..8），
    // 而不是模块加载时快照：否则测试与宿主同一进程时，改了环境变量也不会生效。
    concurrency: rawConcurrency = concurrencyFromEnv(),
    onDone = () => {},           // (job) => void：调用方在"落地完成"后做事（建索引 / 通知界面）
    /**
     * 4.23.22：**校验期望值的唯一入口**（`(job) => { sha256, bytes, source, at } | null`）。
     *
     * 为什么是回调而不是 job 上的字段：4.23.21 及以前，入队那一刻的清单 sha 被写进
     * `expectSha` 并**一直复用**。站点数据在我们对账之后更新（同 URL 换内容）时，旧 job
     * 必然 `hash-mismatch` —— 用户看到"传输内容与站点不一致"，而实际下载到的就是站点当前
     * 的那份字节。根因不是网络，是**把期望值当成 job 的事实持久化了**。
     *
     * 现在校验只问当前清单：调用方（`lib/routes/downloads.js`）把清单快照/刷新能力注入进来，
     * 队列自己不认识站点。返回 null = 清单不可达 / 条目已删 ⇒ 退化为长度 + 结构校验。
     */
    resolveExpectation = null,
    /**
     * hash-mismatch 时**强制刷新清单再判一次**（4.23.22，闭环"清单缓存陈旧"）。
     *
     * 返回刷新后的 `{ sha256, bytes, source, at }`；拿不到就返回 null（失败原因照旧，
     * 只在 job 上记 `refreshAttempted`）。没有这个注入位 ⇒ 不做刷新（行为等价于只看当前快照）。
     */
    refreshExpectation = null,
  } = opts;
  const concurrency = normalizeConcurrency(rawConcurrency);
  const statePath = join(home, 'downloads.json');
  /** id → job */
  const jobs = new Map();
  /**
   * 本会话已经证明"这条域要走多连接"的 host 集合（4.23.3 的可选优化）。
   * 一次自适应切换成功后，同域后续任务直接多连接 —— 省掉每个任务都先慢 3 秒的代价。
   * 只在内存里（进程级会话），不落盘：换网络环境（例如从公司网回家）后旧标记不该继续生效。
   * @type {Set<string>}
   */
  const slowHosts = new Set();
  /** 每个 job 的入队序号：`at` 相同的（同一毫秒内连点）也能排出确定顺序。 */
  let seqCounter = 0;
  /**
   * **用户点击 / 当前在播**的提权序号（4.23.18）。
   *
   * 为什么不用 `at` 排序：`at` 是"入队时间"，一条**很久以前入队**的壁纸（低优先级预取，
   * 或启动时变成 pending 的旧记录）在用户点它的那一刻必须立刻排到队首。只把 priority
   * 改成 high 还不够 —— 它仍会排在其它 high 任务的 `at` 后面。于是给"这次提权"一个独立
   * 的单调序号：`boostSeq` 越大越靠前（只影响同优先级内，high 永远在 normal/low 之前）。
   */
  let boostCounter = 0;
  /**
   * 4.25.1（连点语义）：**"本次会话第几次被用户点击"**的单调序号。
   *
   * 不是 `boostSeq`：当前在播的 silent promote 也会用 high/boostSeq，但它不是"用户又点了一张",
   * 不该占连点队列的名额。只有显式 `clicked:true`（用户点击）才记这里。
   */
  let clickCounter = 0;
  /**
   * 队列级暂停（4.23.18，面板「暂停全部下载」）。
   *
   * 语义：**不再取新任务**，并把正在跑的任务 abort 回 `queued`（`.part` 保留 ⇒ 恢复后
   * 从已下载字节续传）。它不是取消：`cancel()` 仍然是 cancelled，暂停只是运维开关。
   */
  let paused = false;
  /**
   * **连续**几次「本地临时/成品文件不见了」才判失败（4.23.17，P0）。
   *
   * 真实故障：库里的 `.part` / 成品被外部清理（缓存管理器、用户手工删、另一台实例的 sweep）
   * 之后，job 还在队列里跑。下一次写盘 / stat / rename 直接 `ENOENT: ...xxx.mp4.part`，
   * 旧实现把它当**普通失败** ⇒ job 停在 failed，用户看到的却是"点了壁纸不显示"，
   * 而重新点一次又会命中同一条 failed job（`add()` 虽然会重置，但界面已经红过一次）。
   *
   * 文件被清掉不是"站点/链路"的错 ⇒ **先自己重下一次**（清 `.part`，单流），
   * 连续两次都这样才承认失败，并把原因写成 `file-vanished`（有明确人话，不是裸 ENOENT）。
   */
  const ENOENT_RETRY_LIMIT = 2;
  let running = 0;
  /** kind → 正在跑的条数（pump 取任务时看它，不用去数 status）。 */
  const runningByKind = Object.create(null);
  let pumping = false;

  /** 归一一次期望值回调的结果（任何脏字段都不许变成"猜哈希"）。 */
  function normalizeExpectation(exp) {
    if (!exp || typeof exp !== 'object') return null;
    return {
      sha256: normalizeSha256(exp.sha256),
      bytes: Math.max(0, Number(exp.bytes) || 0),
      source: exp.source === 'variant' ? 'variant' : 'original',
      at: Number(exp.at) || 0,
    };
  }

  /**
   * **当前清单**给这条 URL 的期望值（4.23.22 的唯一校验输入）。
   * 回调抛错 / 返回 null = 清单不可达或条目已删 ⇒ 退化为长度 + 结构校验。
   */
  function currentExpectation(job) {
    try {
      return normalizeExpectation(typeof resolveExpectation === 'function' ? resolveExpectation(job) : null);
    } catch { return null; }
  }

  /**
   * **完成那一刻的校验**（4.23.22 结构修复的核心）。
   *
   * 两条判据，顺序固定：
   *   ① 用**当前清单**（`currentExpectation`）的 sha 比。命中 ⇒ 写 `verified=sha256`。
   *   ② 不符 ⇒ 强制刷新清单（`refreshExpectation`）再比一次。
   *      · 刷新后命中 ⇒ 仍算成功（这就是"清单缓存陈旧"的闭环：先纠正、不误报）；
   *      · 刷新后仍不符 ⇒ 才 `hash-mismatch`，错误与 job 上带
   *        `{ expected, actual, manifestAgeMs, refreshAttempted:true }`。
   *
   * 清单不可达 / 没有 sha ⇒ **只做长度 + 结构**（长度与区间在完成前已经验过）：
   * `verified=none(manifest-unreachable)` 或 `verified=size(no-hash)`，并打一条 warn 日志，
   * 绝不因此判失败。
   *
   * job 上只写"这次实际用了什么"：`verifiedSha` / `verifiedBytes` / `verifiedAt` / `verifyDetail`。
   * 下一次校验**不读**它们（见 `persist` / `load`）。
   */
  async function verifyCompletedFile(job, file) {
    const size = (() => { try { return statSync(file).size; } catch { return 0; } })();
    let exp = currentExpectation(job);
    let manifestAgeMs = exp && exp.at ? Math.max(0, Date.now() - exp.at) : null;
    if (exp && exp.sha256) {
      const got = await hashFileP(file);
      if (got === exp.sha256) {
        setJob(job, {
          verified: 'sha256', verifiedSha: exp.sha256, verifiedBytes: exp.bytes || size,
          verifiedSource: exp.source, verifiedAt: Date.now(), verifyReason: null, verifyDetail: null,
        });
        return { expected: exp, actual: got, refreshed: false };
      }
      // ② 先刷新清单再判一次（旧 job / 旧清单缓存都会走到这里）。
      // 自动单流重下那一轮不再强刷（清单已在上一轮刷新过），但**证据要保留**：
      // 最终失败时仍要能回答"这条试过刷新没有"。
      const prevDetail = job.verifyDetail && typeof job.verifyDetail === 'object' ? job.verifyDetail : null;
      let refreshAttempted = Boolean(prevDetail && prevDetail.refreshAttempted);
      let refreshError = prevDetail ? (prevDetail.refreshError || null) : null;
      let fresh = null;
      // 一轮里只强刷一次：第一次 mismatch 已把清单刷新过，自动单流重下那一轮直接用刷新后的值。
      let refreshOk = Boolean(prevDetail && prevDetail.refreshOk);
      if (typeof refreshExpectation === 'function' && !job.hashRetry) {
        refreshAttempted = true;
        try { fresh = normalizeExpectation(await refreshExpectation(job)); } catch (e) {
          refreshError = String((e && e.message) || e);
        }
        refreshOk = Boolean(fresh);
      }
      if (fresh && fresh.sha256) {
        exp = fresh;
        manifestAgeMs = fresh.at ? Math.max(0, Date.now() - fresh.at) : 0;
        if (fresh.sha256 === got) {
          setJob(job, {
            verified: 'sha256', verifiedSha: fresh.sha256, verifiedBytes: fresh.bytes || size,
            verifiedSource: fresh.source, verifiedAt: Date.now(), verifyReason: null, verifyDetail: null,
          });
          log('download-queue: hash-mismatch 已由清单刷新纠正 ' + job.url
            + '（刷新后 sha 与字节一致，不判失败）');
          return { expected: fresh, actual: got, refreshed: true };
        }
      }
      const detail = {
        url: job.url,
        expected: exp ? { sha256: exp.sha256, bytes: exp.bytes, source: exp.source } : null,
        actual: got,
        manifestAgeMs,
        refreshAttempted,
        refreshOk,
        refreshError,
      };
      setJob(job, { verifyReason: 'hash-mismatch', verifyDetail: detail });
      throw Object.assign(new Error('hash-mismatch: ' + got.slice(0, 12) + '… ≠ '
        + String((exp && exp.sha256) || '').slice(0, 12) + '…（传输内容与站点不一致）'),
      { hashMismatch: true, actualHash: got, expectedSha: exp && exp.sha256, verifyDetail: detail });
    }
    // 清单不可达 / 条目没有 sha ⇒ 长度 + 结构（长度/区间在完成前已由 total 校验）。
    const reason = exp ? 'no-hash' : 'manifest-unreachable';
    const verified = exp ? 'size' : 'none';
    setJob(job, {
      verified,
      verifiedSha: '',
      verifiedBytes: exp ? exp.bytes : 0,
      verifiedSource: exp ? exp.source : null,
      verifiedAt: Date.now(),
      verifyReason: reason,
      verifyDetail: { url: job.url, expected: exp, actual: null, manifestAgeMs, refreshAttempted: false },
    });
    log('download-queue: verified=' + verified + ' (' + reason + ') for ' + job.url
      + ' — length/structure checks only');
    return { expected: exp, actual: null, refreshed: false };
  }

  function persist() {
    try {
      mkdirSync(home, { recursive: true });
      const list = [...jobs.values()].map((j) => ({
        id: j.id, url: j.url, dest: j.dest, kind: j.kind, total: j.total,
        status: j.status, error: j.error || null, at: j.at,
        // 4.25.1：条目级身份跟着落盘 —— 重启后同一条目的原画/变体仍是同一条 job。
        itemKey: normalizeItemKey(j.itemKey),
        // 4.23.2：优先级必须落盘，否则重启后"用户点击"会退化成后台预取，优先级形同虚设。
        priority: normalizePriority(j.priority),
        // 4.23.3：`mode` / `autoSwitched` 也落盘 —— 面板与排障读的是"这条当时怎么下的"。
        mode: jobMode(j),
        autoSwitched: Boolean(j.autoSwitched),
        // 4.23.4：这条下的是原画还是 1080p 变体（`original` | `1080p`）。落盘才能在重启后
        // 仍然答得上"为什么这条只有 3 MB"这种问题。
        chosenVariant: j.chosenVariant === '1080p' || j.chosenVariant === '4k30' ? j.chosenVariant : 'original',
        /**
         * 4.23.22：**只剩"最近一次校验实际用了什么"的毒理记录**（diagnostic）。
         *
         * 它不是校验输入：下次完成时仍然去问当前清单。保留它的唯一理由是排障能回答
         * "这条当时算完成是怎么验的"（`/downloads/list` 的 `expectSha` + `verifiedAt`）。
         */
        verified: j.verified || null,
        verifiedSha: normalizeSha256(j.verifiedSha),
        verifiedBytes: Number(j.verifiedBytes) || 0,
        verifiedAt: Number(j.verifiedAt) || 0,
        verifiedSource: j.verifiedSource === 'variant' ? 'variant' : (j.verifiedSource === 'original' ? 'original' : null),
        verifyReason: j.verifyReason || null,
        verifyDetail: j.verifyDetail && typeof j.verifyDetail === 'object' ? j.verifyDetail : null,
        // 4.23.15：「这条本地副本的内容**没错**，只是本机解不了」—— 播放失败自愈判出来的结论。
        // 必须落盘：重启后 inventory 仍然要跳过它、优先用 1080p 变体，
        // 否则用户每重启一次就会被那条解不了的原始文件再坑一次（见 lib/switch-cache-family.js）。
        decodeUnsupported: j.decodeUnsupported === true,
        // 4.23.17：连续"本地文件不见了"的次数（见 ENOENT_RETRY_LIMIT）。落盘只为排障与
        // "重启前已经连续两次"的那条不白重置；用户再点一次仍会从 0 重新给机会。
        enoentRetries: Number(j.enoentRetries) || 0,
      }));
      // 4.23.18：`paused` 也跟着落盘 —— 运维开关跨重启保持（否则"暂停后重启又自己跑"
      // 会让用户以为按钮没生效）。恢复用同一个按钮（面板读 `/downloads/list` 的 paused）。
      writeFileSync(statePath, JSON.stringify({ version: 1, paused, jobs: list }, null, 2));
    } catch { /* 持久化失败不影响下载 */ }
  }

  /**
   * 载入 `downloads.json`（4.23.18 起**启动不再批量入队**）。
   *
   * 真实事故（用户实测，2026-11-04）：清理过 library 之后重启，31 条「done 但成品缺失」
   * 的记录在 `load()` 里被逐条改写成 `queued` ⇒ 队列瞬间多出 31 个 low 任务，当前在播的
   * 壁纸排在它们后面。实测计数 50 的来源就是这里：旧实现把**所有**非 done 记录（done-缺失 /
   * failed / running / queued）都折成 queued 再一起 pump。
   *
   * 现在的口径：
   *   · `done` 且成品在 ⇒ `done`（唯一"已缓存"）；
   *   · `done` 但成品没了 ⇒ **`pending`**（未缓存，不参与调度、不占队列位）；
   *   · 上次 `running` / `queued` / 已是 `pending` ⇒ `pending`（用户没点/预取/在播之前不自动下）；
   *   · `failed` / `cancelled` ⇒ **原样保留**（失败原因要给人看；`failed` 的 retry 是显式动作）。
   *
   * 只有三条路径会把 `pending` 变回 `queued`：用户点击（`add` 带 high）、当前在播
   * （客户端 `localFirstApply(..., { silent:true })`，同样是 `add` 带 high）、预取
   * （`add` 带 low，最多 2 个）。见 `add()` 与 `src/local-first.js`。
   */
  function load() {
    try {
      const doc = JSON.parse(readFileSync(statePath, 'utf8'));
      paused = doc && doc.paused === true;
      let missingDone = 0;
      for (const j of (doc && Array.isArray(doc.jobs) ? doc.jobs : [])) {
        if (!j || !j.id || !j.url || !j.dest) continue;
        const onDisk = j.status === 'done' && existsSync(j.dest);
        // 4.23.19：启动 sweep 的**可审计**计数（"done 但成品缺失" ⇒ pending）。
        // 用户问"为什么 4.23.18 没生效"时，日志能直接回答是这条路径跑没跑、修了几条。
        if (j.status === 'done' && !onDisk) missingDone += 1;
        /**
         * 4.23.18：启动后的状态映射（见函数头；pending 是新增状态，不参与调度）。
         * 4.23.19：判据搬到 `lib/media-state.js` 的 `startupStatusFor` —— 与对账器**同一份**。
         */
        const status = startupStatusFor(j.status, onDisk);
        seqCounter += 1;
        jobs.set(j.id, {
          id: j.id, url: j.url, dest: j.dest, kind: j.kind || '', total: Number(j.total) || 0,
          // 4.25.1：旧 downloads.json 没有 itemKey ⇒ 按媒体族键补一个（`x.1080p.mp4` 与
          // `x.mp4` 同族）；之后用户点击时 `add()` 还会把它升级成清单条目的稳定 id。
          itemKey: normalizeItemKey(j.itemKey) || defaultItemKey(j.url, j.kind),
          received: status === 'done' ? Number(j.total) || 0 : 0,
          status, error: status === 'failed' ? (j.error || null) : null, at: Number(j.at) || Date.now(),
          // 旧 jobs.json 没有 priority ⇒ `normal`（不是崩、也不是全员 high）。
          priority: normalizePriority(j.priority),
          // 旧 jobs.json 没有 mode ⇒ `single`；非法值同样回落到 single（向下兼容）。
          mode: /^ranged:\d+$/.test(String(j.mode || '')) ? String(j.mode) : 'single',
          autoSwitched: Boolean(j.autoSwitched),
          // 旧 jobs.json 没有 chosenVariant ⇒ `original`（4.23.3 的行为，不改画质）。
          chosenVariant: j.chosenVariant === '1080p' || j.chosenVariant === '4k30' ? j.chosenVariant : 'original',
          /**
           * 4.23.22：旧文件里的 `sha256` / `expectSha` / `expectBytes` / `hashSource` **一律不读**。
           * 它们是把期望值持久化的旧设计；继续读回来就等于换了个名字复用旧事实。
           * 只承接"最近一次校验实际用了什么"（纯排障，不参与下一次校验）。
           */
          verified: typeof j.verified === 'string' ? j.verified : null,
          verifiedSha: normalizeSha256(j.verifiedSha),
          verifiedBytes: Number(j.verifiedBytes) || 0,
          verifiedAt: Number(j.verifiedAt) || 0,
          verifiedSource: j.verifiedSource === 'variant' ? 'variant' : (j.verifiedSource === 'original' ? 'original' : null),
          verifyReason: typeof j.verifyReason === 'string' ? j.verifyReason : null,
          verifyDetail: j.verifyDetail && typeof j.verifyDetail === 'object' ? j.verifyDetail : null,
          // 4.23.15：旧 downloads.json 没有这个字段 ⇒ false（行为与 4.23.14 逐字节等价）。
          decodeUnsupported: j.decodeUnsupported === true,
          // 4.23.17：连续 ENOENT 次数（旧文件没有 ⇒ 0 = 这一轮从没撞见过）。
          enoentRetries: Number(j.enoentRetries) || 0,
          hashRetry: false, singleOnly: false,
          // 4.23.18：提权序号只在**本会话**有意义（重启后当前在播会重新 promote）。
          boostSeq: 0,
          // 4.25.1（连点语义）：重启后"上次点击"不再算本次会话的连点名额；pending+high 仍由
          // 启动自愈显示「未缓存（点击继续）」。
          sessionClicked: false, clickSeq: 0,
          pauseRequested: false,
          seq: seqCounter,
        });
      }
      if (missingDone) {
        log('download-queue: startup sweep: ' + missingDone
          + ' 条 done 但成品缺失 ⇒ pending（不自动入队；点/在播/预取才重新排队）');
      }
    } catch { /* 首次运行没有状态文件 */ }
  }

  /* 4.23.22：**没有"期望值迁移"了**。
   *
   * 4.23.18 的迁移是在给"job 持久化期望值"这个错设计打补丁：它读清单把旧 job 的
   * `expectSha/expectBytes/hashSource` 改成当前值。只要清单在下载前后再变一次，同样的
   * hash-mismatch 又会回来 —— 补丁永远追不上根因。
   *
   * 现在 job 不再持有校验输入（见 `persist` / `load` / `add`）；校验发生在完成那一刻、
   * 直接问当前清单（`resolveExpectation`），失败时还能强制刷新一次清单（`refreshExpectation`）。
   * 因此旧 job 里的 `sha256/expectSha/expectBytes/hashSource` 只会被**忽略**，不需要迁移。
   */

  /**
   * **启动清理本地残留**（4.24.1，P0：从源头消灭 http-416）。
   *
   * 为什么必须在启动时做，而不是等下次打开 job：残留 `.part` 只有在"续传"那一刻才会被读，
   * 于是它可以在盘上躺几天，然后在用户点开时把一条本来没问题的下载打成 416。启动时（此刻
   * 不可能有本进程的在途下载）按**唯一判据**一次清干净：
   *
   *   · `library/**\/*.part`：`size >= job.total`（完整或比目标还大）或**对应 job 不存在**
   *     ⇒ 删；`0 < size < total` 的**合法半截**保留（断点续传的价值就在这里），计入 `kept`；
   *   · `cache/skins-zip/*.part`：启动时不可能在飞 ⇒ 全删；
   *   · `cache/skins-zip/*.etag`：它对应的 `.zip` 已不存在 ⇒ 删（孤儿 sidecar 会让 HEAD
   *     比对把"没下载"误判成"已完成"）。
   *
   * 统计写进 `sweepStats()`，由 `/folia/diag/media-state` 的 `sweep` 字段下发（可审计）。
   *
   * @returns {{ deletedParts: number, deletedEtags: number, kept: number, at: number }}
   */
  function sweepLocalResidue() {
    const stats = { deletedParts: 0, deletedEtags: 0, kept: 0, at: Date.now() };
    const byDest = new Map();
    for (const j of jobs.values()) byDest.set(String(j.dest || ''), j);
    /** 有界遍历（缓存目录可能很大；这里只找 `.part` / `.etag`，不做全量统计）。 */
    const walk = (dir, depth) => {
      if (depth > 6) return;
      let ents;
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) { walk(p, depth + 1); continue; }
        if (!ent.isFile()) continue;
        if (ent.name.endsWith('.part')) {
          const dest = p.slice(0, -5);
          const job = byDest.get(dest);
          const total = job ? Math.max(0, Number(job.total) || 0) : 0;
          const size = bytesOf(p, 0);
          // 没有 job / 总量未知 / 起点 ≥ 总量 ⇒ 这份残留不可能被安全续传（起点 ≥ 总量
          // 就会在下一次打开时变成 http-416，这正是本函数存在的理由）。
          const stale = !job || total <= 0 || size >= total;
          if (stale) {
            try { rmSync(p, { force: true }); stats.deletedParts += 1; } catch { /* 删不掉留给打开 job 时的体检 */ }
          } else {
            stats.kept += 1;
          }
        }
      }
    };
    walk(join(home, 'library'), 0);
    // 皮肤 zip 缓存：`.part` 一律清（启动时不可能有在途下载）；孤儿 `.etag`（无对应 zip）也清。
    const zipDir = join(home, 'cache', 'skins-zip');
    for (const ent of dirEntries(zipDir)) {
      if (!ent.isFile()) continue;
      const p = join(zipDir, ent.name);
      if (ent.name.endsWith('.part')) {
        try { rmSync(p, { force: true }); stats.deletedParts += 1; } catch { /* ignore */ }
        continue;
      }
      if (ent.name.endsWith('.etag')) {
        const zip = p.slice(0, -5);
        if (!existsSync(zip)) {
          try { rmSync(p, { force: true }); stats.deletedEtags += 1; } catch { /* ignore */ }
        }
      }
    }
    if (stats.deletedParts || stats.deletedEtags) {
      log('download-queue: 启动清理本地残留：删除 .part ' + stats.deletedParts
        + ' 个 / 孤儿 .etag ' + stats.deletedEtags + ' 个 / 保留可续传半截 ' + stats.kept + ' 个');
    }
    return stats;
  }
  /** 最近一次启动清理的统计（只读；`/diag/media-state` 的 `sweep` 字段）。 */
  let sweepStats = { deletedParts: 0, deletedEtags: 0, kept: 0, at: 0 };

  /**
   * 队列里**等待中**的 job，按 (优先级 高→低, at 早→晚, 入队序号) 排好。
   * pump 与 snapshot 的 `queuePos` 用的是**同一个**函数 —— 否则"面板显示第 2 位、
   * 实际却先跑第 4 位"这种不一致会让人再也不敢信这个数字。
   */
  function queuedOrder() {
    return [...jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort(compareQueueOrder);
  }

  function snapshot() {
    const ordered = queuedOrder();
    const posById = new Map(ordered.map((j, i) => [j.id, i + 1]));
    /**
     * 4.23.18：同 kind + 同优先级档的 0 基位置（0 = 前面没人）。
     * 标题栏的「前面还有 N 个」直接读它；`queuePos` 仍是全局 1 基位置（既有契约/排障）。
     */
    const aheadById = new Map();
    for (let i = 0; i < ordered.length; i += 1) {
      const me = ordered[i];
      let ahead = 0;
      for (let k = 0; k < i; k += 1) {
        const other = ordered[k];
        if (kindOf(other) === kindOf(me) && rankOf(other) === rankOf(me)) ahead += 1;
      }
      aheadById.set(me.id, ahead);
    }
    /** 按 kind 的排队/在跑统计（面板与排障用；见 byKind 的挂载方式说明）。 */
    const byKind = Object.create(null);
    const slot = (k) => {
      if (!byKind[k]) byKind[k] = { running: 0, queued: 0, pending: 0, limit: limitForKind(k) };
      return byKind[k];
    };
    /**
     * 4.23.18：按优先级档的汇总（`/downloads/list` 的 `byPriority`）。
     * 形状 `{ high: { queued, running, pending, done, failed, cancelled, total }, … }` ——
     * 面板/排障要回答"现在到底是谁在排队"，而不是只有一个总数。
     */
    const byPriority = Object.create(null);
    for (const p of PRIORITIES) byPriority[p] = { queued: 0, running: 0, pending: 0, done: 0, failed: 0, cancelled: 0, total: 0 };
    let queuedCount = 0;
    let pendingCount = 0;
    for (const j of jobs.values()) {
      const row = slot(kindOf(j));
      if (j.status === 'running') row.running += 1;
      else if (j.status === 'queued') row.queued += 1;
      else if (j.status === 'pending') row.pending += 1;
      const pr = normalizePriority(j.priority);
      const bucket = byPriority[pr];
      if (bucket) {
        bucket.total += 1;
        // 只认白名单里的状态键；未知状态只计入 total（不为一条脏数据发明一个计数桶）。
        if (Object.prototype.hasOwnProperty.call(bucket, j.status)) bucket[j.status] += 1;
      }
      if (j.status === 'queued') queuedCount += 1;
      else if (j.status === 'pending') pendingCount += 1;
    }
    const out = [...jobs.values()]
      .sort((a, b) => b.at - a.at)
      .map((j) => {
        const row = {
          id: j.id, url: j.url, kind: j.kind, dest: j.dest, total: j.total, received: j.received,
          status: j.status, error: j.error || null,
          priority: normalizePriority(j.priority),
          // 4.25.1：条目级身份（客户端按它绑进度，不再拿 URL 当身份）+ 点击未完成的标记。
          // `pendingHigh` 只用于 UI 文案（「未缓存（点击继续）」），**不代表可自动下载**。
          itemKey: normalizeItemKey(j.itemKey),
          pendingHigh: j.status === 'pending' && normalizePriority(j.priority) === 'high',
          // 4.25.1（连点语义）：本次会话是否被用户点过、第几次点（排障与 U1–U4 判据读它）。
          sessionClicked: j.sessionClicked === true,
          clickSeq: Number(j.clickSeq) || 0,
          // 4.23.3：这条 job **正在/曾经**怎么下的 —— `single` 或 `ranged:<n>`；
          // `autoSwitched` 只对 auto 模式成立（= 单流跑着跑着切成了多连接）。
          mode: jobMode(j),
          autoSwitched: Boolean(j.autoSwitched),
          // 4.23.4：这条下的是原画还是 1080p 变体（面板据此显示「1080p」小标，排障据此解释体积）。
          chosenVariant: j.chosenVariant === '1080p' || j.chosenVariant === '4k30' ? j.chosenVariant : 'original',
          /**
           * 4.23.22：`expectSha` 不再是"入队时的期望"，而是**最近一次校验实际使用的 sha**。
           * 时间戳 `verifiedAt` 一起下发，排障能读成"这条完成时按哪份清单验的"。
           * 它**不参与**下一次校验 —— 下一次完成仍然去问当前清单（见 `verifyCompletedFile`）。
           */
          expectSha: normalizeSha256(j.verifiedSha) || null,
          expectBytes: Number(j.verifiedBytes) || 0,
          expectShaAt: Number(j.verifiedAt) || 0,
          verified: j.verified || null,
          verifiedAt: Number(j.verifiedAt) || 0,
          verifiedSource: j.verifiedSource === 'variant' ? 'variant' : (j.verifiedSource === 'original' ? 'original' : null),
          verifyReason: j.verifyReason || null,
          verifyDetail: j.verifyDetail || null,
          hashRetry: Boolean(j.hashRetry),
          // 4.23.15：本机解不了这份内容（自愈判出来的）⇒ inventory 跳过它、优先 1080p 变体。
          decodeUnsupported: j.decodeUnsupported === true,
          percent: j.total > 0 ? Math.min(100, Math.round((j.received / j.total) * 100)) : (j.status === 'done' ? 100 : 0),
        };
        // 只有排队中的任务才有"位置"；1 基，1 = 前面没人（下一个就是它）。
        if (j.status === 'queued') {
          row.queuePos = posById.get(j.id) || 0;
          // 4.23.18：0 基、只数**同 kind + 同优先级档** —— 标题栏「前面还有 N 个」读这个。
          row.queuedAhead = aheadById.get(j.id) || 0;
        }
        return row;
      });
    // byKind 挂在**数组**上，而不是把 snapshot() 改成对象：它的返回形状是既有契约
    // （面板 / routes / 十余条判据都在当数组用）。这样 `.filter/.find/[0]` 一行都不用改。
    // 用 JSDoc 断言收敛类型：数组字面量上本没有这个属性，但这是**故意**挂上去的旁路统计。
    /** @type {any} */ (out).byKind = byKind;
    /** @type {any} */ (out).byPriority = byPriority;
    /** @type {any} */ (out).queuedCount = queuedCount;
    /** @type {any} */ (out).pendingCount = pendingCount;
    /** @type {any} */ (out).paused = paused;
    return out;
  }

  /**
   * 找一条 job 的**条目身份**（不写盘、不 pump）：add / setPriority / inventory 共用。
   *
   * 顺序（从最强到最弱）：
   *   ① 显式 job id（老调用方只有 URL → id 就是 urlKey）；
   *   ② 当前 URL 的 urlKey（同 URL 的幂等路径，id 语义不变）；
   *   ③ itemKey（4.25.1 的条目级身份，解决"原始 URL vs 变体 URL"）；
   *   ④ relatedUrls（清单里的变体地址，精确命中）；
   *   ⑤ 媒体族键（老 downloads.json 没有 itemKey 时的兜底：`x.1080p.mp4` 与 `x.mp4` 同族）。
   *
   * @param {{id?:string,url?:string,kind?:string,itemKey?:string,relatedUrls?:string[]}|string} inp
   * @returns {any|null}
   */
  function findJobFor(inp) {
    const o = typeof inp === 'string' ? { url: inp } : (inp || {});
    const url = String(o.url || '');
    const kind = o.kind ? String(o.kind).trim().toLowerCase() : '';
    const itemKey = normalizeItemKey(o.itemKey);
    if (o.id) {
      const byId = jobs.get(String(o.id));
      if (byId) return byId;
    }
    if (url) {
      const byUrl = jobs.get(urlKey(url));
      if (byUrl) return byUrl;
    }
    if (itemKey) {
      for (const j of jobs.values()) {
        if (normalizeItemKey(j.itemKey) !== itemKey) continue;
        if (kind && kindOf(j) !== kind) continue;
        return j;
      }
    }
    const related = new Set();
    if (url) related.add(url);
    for (const u of (Array.isArray(o.relatedUrls) ? o.relatedUrls : [])) {
      const s = String(u || '').trim();
      if (s) related.add(s);
    }
    if (related.size) {
      for (const j of jobs.values()) {
        if (related.has(String(j.url))) return j;
      }
    }
    const fam = url ? mediaFamilyKey(url) : '';
    if (fam) {
      for (const j of jobs.values()) {
        if (kind && kindOf(j) !== kind) continue;
        // 显式不同的条目键不许被"同族"吞并；只有老记录（空键 / URL 默认键）才吃族兜底。
        if (itemKey && !isDefaultItemKey(j) && normalizeItemKey(j.itemKey) !== itemKey) continue;
        if (mediaFamilyKey(j.url) === fam) return j;
      }
    }
    return null;
  }

  /**
   * 把一条 job 换到另一个 URL / 落点（**同一条目换档**），保留 job id 与条目身份。
   *
   * 只在"没有在跑"时调用：正在下的对象不能中途换，否则已写进 `.part` 的字节会与新 URL 拼在
   * 一起。已下字节 / 上次校验结论都属于旧对象 ⇒ 全部清零，下一次 pump 从 0 开始下新对象。
   *
   * @param {any} job
   * @param {string} url
   * @param {string} dest
   * @returns {boolean}
   */
  function relocateJob(job, url, dest) {
    if (String(job.url) === String(url) && String(job.dest) === String(dest)) return false;
    try { rmSync(String(job.dest || '') + '.part', { force: true }); } catch { /* 删不掉也不影响换档 */ }
    setJob(job, {
      url: String(url), dest: String(dest), total: 0, received: 0, error: null,
      // 旧对象的校验结论不能留给新对象。
      verified: null, verifiedSha: '', verifiedBytes: 0, verifiedAt: 0,
      verifiedSource: null, verifyReason: null, verifyDetail: null,
      decodeUnsupported: false, hashRetry: false, singleOnly: false, enoentRetries: 0,
      mode: 'single', autoSwitched: false, range416Retry: false,
      // 完成的旧对象 → 新对象还没下；其余状态由 add() 继续归一（pending/failed → queued）。
      status: job.status === 'done' ? 'queued' : job.status,
    });
    return true;
  }

  /**
   * 同一条目**正在跑**的 job（4.25.1）：点击时优先复用它，避免"旧变体还在下、又新建一条原画"。
   * @param {{url?:string,kind?:string,itemKey?:string}} inp
   * @returns {any|null}
   */
  function findRunningForItem(inp) {
    const o = inp || {};
    const itemKey = normalizeItemKey(o.itemKey);
    const kind = o.kind ? String(o.kind).trim().toLowerCase() : '';
    const fam = mediaFamilyKey(o.url);
    for (const j of jobs.values()) {
      if (j.status !== 'running') continue;
      if (kind && kindOf(j) !== kind) continue;
      if (itemKey && normalizeItemKey(j.itemKey) === itemKey) return j;
      if (itemKey && !isDefaultItemKey(j) && normalizeItemKey(j.itemKey) !== itemKey) continue;
      if (fam && mediaFamilyKey(j.url) === fam) return j;
    }
    return null;
  }

  /**
   * **清掉同一条目上永远不会被调度的重复记录**（4.25.1）。
   *
   * 4.25.0 的现场可能同时留着"原画 job + 变体 pending job"（旧实现按 URL 建键）。
   * 用户点击其中一条后，另一条 pending 永远不会被 pump 取到，却会一直算进 `pendingCount`。
   * 这里只删**非 running / 非 done** 的重复项：有效的缓存与正在跑的下载都不动。
   */
  function dropStaleItemDuplicates(canonical, inp) {
    const o = inp || {};
    const itemKey = normalizeItemKey(o.itemKey);
    const kind = o.kind ? String(o.kind).trim().toLowerCase() : '';
    const fam = mediaFamilyKey(canonical && canonical.url) || mediaFamilyKey(o.url);
    let removed = 0;
    for (const [jid, j] of [...jobs.entries()]) {
      if (j === canonical) continue;
      if (kind && kindOf(j) !== kind) continue;
      const sameKey = itemKey && normalizeItemKey(j.itemKey) === itemKey;
      const sameFam = fam && mediaFamilyKey(j.url) === fam
        && (!itemKey || isDefaultItemKey(j) || normalizeItemKey(j.itemKey) === itemKey);
      if (!sameKey && !sameFam) continue;
      if (j.status === 'running' || j.status === 'done') continue;
      jobs.delete(jid);
      removed += 1;
    }
    if (removed) log('download-queue: dropped ' + removed + ' stale duplicate job(s) for item '
      + (itemKey || fam || canonical.id));
    return removed;
  }

  /**
   * 4.25.1（连点语义）：**未开始队列有界**。
   *
   * 只约束 `queued` 里的 **wallpaper**（等待队列），不动 `running`（并行下载最多仍是 kind limit，
   * wallpaper=2）：皮肤/桌宠/开机动画的安装队列不受这条影响。
   *   · 用户连点 30 张 ⇒ 2 张在跑 + 最近点击的 8 张 queued + 其余 20 张 pending；
   *   · 超过 8 的按 `clickSeq`（**最近点击**优先）淘汰回 `pending`；非点击的预取排在更后；
   *   · 回落 pending 不取消、不删 `.part`；用户再点一次时 `add()` 会把它拉回队首。
   *
   * @returns {number} 被回落 pending 的条数
   */
  function enforceBurstCap() {
    // 只约束 wallpaper：这条语义来自"用户连点壁纸库"，皮肤/桌宠/开机动画的安装队列不走这里。
    const queued = [...jobs.values()].filter((j) => j.status === 'queued' && kindOf(j) === 'wallpaper');
    if (queued.length <= BURST_QUEUE_MAX) return 0;
    queued.sort((a, b) => (Number(b.clickSeq) || 0) - (Number(a.clickSeq) || 0)
      || (Number(b.boostSeq) || 0) - (Number(a.boostSeq) || 0)
      || (Number(b.at) || 0) - (Number(a.at) || 0)
      || (Number(b.seq) || 0) - (Number(a.seq) || 0));
    let demoted = 0;
    for (let i = BURST_QUEUE_MAX; i < queued.length; i += 1) {
      setJob(queued[i], { status: 'pending', error: null, boostSeq: 0, pauseRequested: false });
      demoted += 1;
    }
    if (demoted) {
      log('download-queue: burst cap ' + queued.length + ' queued → 回落 ' + demoted
        + ' 条 pending（只保留最近点击的 ' + BURST_QUEUE_MAX + ' 条在队列）');
    }
    return demoted;
  }

  /**
   * 入队（幂等，**按条目**）。返回 job 快照；`existed` 表示此前已存在。
   *
   * 4.23.22：**只记录"要下哪个 URL + kind + 选档"**。sha256 / bytes / hashSource 不再是
   * 入队参数 —— 它们要在下载完成那一刻去问当前清单（见 `verifyCompletedFile`）。
   *
   * 4.25.1：同一条目（itemKey / 同族 URL）再次入队 ⇒ **复用同一条 job**；若新 URL 与旧的不同
   * （原画 ↔ 1080p / 30fps 变体）且当前没有在跑，就把这条 job 迁移到新 URL，绝不另建第二条
   * 永远 pending 的记录。`forceReload` 用于"用户显式换档（用原画）"：即使旧档已 done 也迁移。
   */
  function add({
    url, dest, kind = '', priority = 'normal', chosenVariant = 'original',
    itemKey = '', relatedUrls = [], forceReload = false, clicked = false,
  }) {
    const wantKey = normalizeItemKey(itemKey) || defaultItemKey(url, kind);
    let existing = findJobFor({ url, kind, itemKey: wantKey, relatedUrls });
    // 同一条目已有在跑的下载 ⇒ 复用它（旧变体在跑时点原画，不该再并排开第二条）。
    const runner = findRunningForItem({ url, kind, itemKey: wantKey });
    if (runner && runner !== existing) existing = runner;
    const existed = Boolean(existing);
    if (existed) {
      const job = existing;
      const id = job.id;
      // 同一 URL 被**更高优先级**重新入队 ⇒ 提权。语义：用户主动点击（high）应该插到
      // 后台预取（low）前面；反过来（low 重复入队）**不降级**，免得后台请求把用户刚点的安装降下去。
      if (rankOf({ priority: normalizePriority(priority) }) > rankOf(job)) {
        setJob(job, { priority: normalizePriority(priority) });
      }
      // 老 job（4.25.0 及以前）没有 itemKey：这里补上，下一次重启也能按条目去重。
      // 显式带来的条目键优先于加载时按 URL 族的默认键（否则 legacy 记录永远升不到条目身份）。
      const explicitKey = normalizeItemKey(itemKey);
      if (explicitKey && normalizeItemKey(job.itemKey) !== explicitKey) {
        setJob(job, { itemKey: explicitKey });
      } else if (!normalizeItemKey(job.itemKey)) {
        setJob(job, { itemKey: wantKey });
      }
      const wantUrl = String(url);
      const urlChanged = String(job.url) !== wantUrl;
      let keptOldUrl = false;
      if (urlChanged) {
        // 正在跑的 job 不换 URL（已下载字节属于当前对象）；已完成的旧档默认也复用
        //（同一张壁纸已经缓存了，点它不该再下一遍）。只有显式换档才迁移。
        const canRelocate = job.status !== 'running'
          && (forceReload === true || job.status !== 'done' || !existsSync(job.dest));
        if (canRelocate) relocateJob(job, wantUrl, dest);
        else if (forceReload === true && job.status === 'running') {
          // 用户显式换档（用原画）时正在下变体：先 abort，等 runOne 收尾后再迁移。
          // 在流的半途换 url/dest 会把两段字节写进同一个 `.part` —— 必须等它停稳。
          job.replaceOnAbort = { url: wantUrl, dest };
          try { if (job.ctrl) job.ctrl.abort(); } catch { /* ignore */ }
        } else {
          // 复用的是旧档（变体已缓存 / 正在跑）：chosenVariant 必须描述**实际 URL**，
          // 不能把响应里这次没采纳的选档写上去（否则列表说原画、URL 还是变体）。
          keptOldUrl = true;
        }
      }
      // 4.23.4：同一条 URL 再入队时选档结论以**这次**为准（用户可能刚点过「用原画」）。
      if (!keptOldUrl) {
        setJob(job, { chosenVariant: chosenVariant === '1080p' || chosenVariant === '4k30' ? chosenVariant : 'original' });
      }
      // 已完成但文件被删 ⇒ 重新排队（4.23.17：这也是"启动后发现成品缺失"的运行时版本）。
      if (job.status === 'done' && !existsSync(job.dest)) {
        setJob(job, { status: 'queued', received: 0, error: null, enoentRetries: 0 });
      }
      // 4.23.18：`pending`（未缓存、启动时没有自动入队）被用户点击 / 预取 / 在播 promote 到时
      // 才变回 queued。这不是"批量重置"—— 一次 add 只动这一条。
      if (job.status === 'pending') {
        setJob(job, { status: 'queued', error: null, received: 0, enoentRetries: 0 });
      }
      // ⚠️ **失败/取消的 job 必须在"再点一次"时重置为 queued**（见长注释，略）。
      if (job.status === 'failed' || job.status === 'cancelled') {
        setJob(job, {
          status: 'queued', error: null, hashRetry: false, singleOnly: false, enoentRetries: 0,
          range416Retry: false,
        });
      }
      // 4.25.1（连点语义）：这次是**用户点击** ⇒ 记"最近点击"序号（用于 8 条未开始队列上限）。
      if (clicked === true) {
        clickCounter += 1;
        setJob(job, { sessionClicked: true, clickSeq: clickCounter });
      }
      // 4.23.18「当前点击 / 在播 = 队首」：只要这次是 high，就在**状态处理完之后**记一枚新的
      // 提权序号（done-missing 会先被上面改回 queued，所以必须放在这里）。
      if (normalizePriority(priority) === 'high' && job.status !== 'done') {
        boostCounter += 1;
        setJob(job, { priority: 'high', boostSeq: boostCounter });
      }
      // 4.25.1：同一条目上遗留的 pending/queued/failed 重复记录一并清掉（只删不会被调度的那些）。
      dropStaleItemDuplicates(job, { itemKey: normalizeItemKey(job.itemKey) || wantKey, url: job.url, kind });
      if (clicked === true) enforceBurstCap();
      persist();
      pump();
      return { job: snapshot().find((x) => x.id === id), existed: true };
    }
    const id = urlKey(url);
    seqCounter += 1;
    const wantPriority = normalizePriority(priority);
    // 4.23.18：用户点击 / 当前在播（high）的新 job 一入队就在队首；预取（low）按入队顺序排。
    if (wantPriority === 'high') boostCounter += 1;
    if (clicked === true) clickCounter += 1;
    const created = {
      id, url: String(url), dest: String(dest), kind: String(kind || ''),
      itemKey: wantKey,
      total: 0, received: 0, status: 'queued', error: null, at: Date.now(),
      priority: wantPriority, boostSeq: wantPriority === 'high' ? boostCounter : 0,
      // 4.25.1（连点语义）：只有显式 clicked:true 才计入 8 条未开始队列上限。
      sessionClicked: clicked === true, clickSeq: clicked === true ? clickCounter : 0,
      mode: 'single', autoSwitched: false, chosenVariant: chosenVariant === '1080p' || chosenVariant === '4k30' ? chosenVariant : 'original',
      seq: seqCounter,
      pauseRequested: false,
      hashRetry: false, singleOnly: false,
      // 4.23.22：校验记录（**只写结果，不写期望**）。完成那一刻才填。
      verified: null, verifiedSha: '', verifiedBytes: 0, verifiedAt: 0,
      verifiedSource: null, verifyReason: null, verifyDetail: null,
      // 4.23.17：这一轮"本地文件不见了"的连续次数（成功即清零，见 runOne 的 catch）。
      enoentRetries: 0,
    };
    jobs.set(id, created);
    dropStaleItemDuplicates(created, { itemKey: wantKey, url, kind });
    if (clicked === true) enforceBurstCap();
    persist();
    pump();
    return { job: snapshot().find((x) => x.id === id), existed: false };
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return false;
    // 取消优先于暂停：清掉 pauseRequested，否则 runOne 的 catch 会把它当"暂停"排回 queued。
    setJob(job, { pauseRequested: false });
    if (job.status === 'running' && job.ctrl) { try { job.ctrl.abort(); } catch { /* ignore */ } }
    job.status = 'cancelled';
    persist();
    return true;
  }

  /**
   * **显式升降优先级**（4.23.23，download-first 的「切走降 low / 点回升 high」）。
   *
   * 与 `add()` 的区别是**允许降级**：`add({priority:'low'})` 对已存在的高优 job 是 no-op
   * （保护"当前在播/用户刚点的那条"不被后台预取意外降级）。而"用户已经切走"是一个
   * **显式**信号 ⇒ 只有这里能把它降回 low；同时清掉提权序号，让它回到 low 档的入队顺序。
   *
   * 不改变 status / received / job id（不暂停、不取消、不重置已下字节）—— 队列继续跑。
   *
   * @param {{id?:string,url?:string,kind?:string,priority?:string,itemKey?:string,relatedUrls?:string[],clicked?:boolean}|string} inp
   * @returns {object|null} 更新后的 job 快照行；找不到 job ⇒ null
   */
  function setPriority(inp) {
    const o = typeof inp === 'string' ? { id: inp } : (inp || {});
    const id = String(o.id || '');
    const itemKey = normalizeItemKey(o.itemKey);
    const job = findJobFor({
      id, url: String(o.url || ''), kind: String(o.kind || ''), itemKey,
      relatedUrls: Array.isArray(o.relatedUrls) ? o.relatedUrls : [],
    });
    if (!job) return null;
    const want = normalizePriority(o.priority);
    if (want === 'high') {
      // 用户点回同一张 = 新的"我就要现在看"信号 ⇒ 归队首。
      boostCounter += 1;
      const patch = { priority: 'high', boostSeq: boostCounter };
      /**
       * 4.25.1：**high 必须落实成"会被调度"**。
       *
       * `pending` 是"未缓存、没排队"（启动 / 清队列 / 清缓存留下的记录）。旧实现只改
       * priority，状态仍是 pending ⇒ pump 永远挑不到它，"提权"看起来成功、实际永远不开始。
       * 点击路径现在主要走 `/downloads/add`（add 会 promote），但 `/downloads/priority`
       * 也是显式"我就要这张"的信号，两条语义必须一致。
       */
      if (job.status === 'pending') {
        Object.assign(patch, { status: 'queued', error: null, received: 0, enoentRetries: 0 });
      }
      setJob(job, patch);
      // 4.25.1（连点语义）：显式 clicked:true 的 high 才占 8 条未开始队列名额。
      if (o.clicked === true) {
        clickCounter += 1;
        setJob(job, { sessionClicked: true, clickSeq: clickCounter });
      }
    } else {
      // 降级：清提权序号，别让它在 low 档里继续冒充队首。
      setJob(job, { priority: 'low', boostSeq: 0 });
    }
    if (o.clicked === true) enforceBurstCap();
    persist();
    pump();
    return snapshot().find((x) => x.id === job.id) || null;
  }

  /**
   * **暂停 / 恢复全部下载**（4.23.18，面板「暂停全部下载」）。
   *
   * 暂停 = ① `pump()` 不再取新任务；② 正在跑的 job 立刻 abort 并回到 `queued`（`.part`
   * 保留 ⇒ 恢复后从已下载字节续传）。这不是取消：`cancel()` 仍单独把 job 标 cancelled。
   * 返回暂停后的队列计数，路由直接回给面板。
   */
  function setPaused(on) {
    const want = on !== false;
    paused = want;
    if (paused) {
      for (const job of jobs.values()) {
        if (job.status !== 'running') continue;
        setJob(job, { pauseRequested: true });
        try { if (job.ctrl) job.ctrl.abort(); } catch { /* ignore */ }
      }
    }
    persist();
    if (!paused) pump();
    return queueCounts();
  }

  /**
   * **清空未开始队列**（4.23.18）：把所有 `queued` 标成 `pending`（未缓存），
   * 不碰 running / done / failed / cancelled。用户点壁纸或预取时会重新入队。
   */
  function clearQueued() {
    let cleared = 0;
    for (const job of jobs.values()) {
      if (job.status !== 'queued') continue;
      setJob(job, { status: 'pending', error: null, received: 0, boostSeq: 0, pauseRequested: false });
      cleared += 1;
    }
    if (cleared) persist();
    return Object.assign({ cleared }, queueCounts());
  }

  /**
   * **清缓存时同步队列**（4.23.19，P0）：把指定 kind 的 `done` 记录重置为 `pending`。
   *
   * 事故：面板「清空媒体」删掉 `library/` 里的成品，但下载队列是内存单例 —— 只改
   * `downloads.json` 不会让内存里的 job 变状态。于是 job 仍是 done，客户端按"已缓存"去要
   * `/local-media/<id>`，宿主发现文件不在返回 404 ⇒ `<video>` 得到 SRC_NOT_SUPPORTED，
   * 界面显示"浏览器无法解码"（用户正是按"清空媒体"步骤踩到的）。
   *
   * @param {string[]} kinds 目标 kind（大小写/空白不敏感）
   * @param {{ dropExpectation?: boolean }} [opts] 兼容旧调用：现在只清"最近一次校验"的排障记录
   * @returns {number} 重置条数
   */
  function resetDoneForKinds(kinds, opts) {
    const wanted = new Set((Array.isArray(kinds) ? kinds : [])
      .map((k) => String(k || '').trim().toLowerCase()).filter(Boolean));
    if (!wanted.size) return 0;
    const drop = Boolean(opts && opts.dropExpectation);
    let reset = 0;
    for (const job of jobs.values()) {
      if (job.status !== 'done' || !wanted.has(kindOf(job))) continue;
      // 4.23.19：patch 的字段集与对账器**同一份**（`mediaResetPatch()`），不再各写一遍。
      const patch = mediaResetPatch();
      if (drop) {
        // 4.23.22：期望值已经不在 job 上；这里清的只是"上次完成时验过什么"的排障记录。
        Object.assign(patch, {
          verified: null, verifiedSha: '', verifiedBytes: 0, verifiedAt: 0,
          verifiedSource: null, verifyReason: null, verifyDetail: null,
        });
      }
      setJob(job, patch);
      reset += 1;
    }
    if (reset) persist();
    return reset;
  }

  /**
   * **对账器专用：批量改 job 状态（不 pump）**（4.23.19）。
   *
   * 为什么单独一个入口而不是让 `media-state.js` 直接改 job：队列的 `jobs` 是私有的，
   * 对账器只该描述"这条应该是什么状态"，落盘/发事件由队列负责。**不 pump** 是语义要求：
   * 对账的结论是"这条不可播 / 这条未缓存"，它**不许顺手把东西排进队列** —— 4.23.18 的
   * "启动批量重置"正是从"顺手"来的。
   *
   * @param {{ id: string, patch: object }[]} patches
   * @returns {number} 实际改动的条数
   */
  function applyReconcile(patches) {
    let n = 0;
    for (const p of (Array.isArray(patches) ? patches : [])) {
      if (!p || !p.id || !p.patch || typeof p.patch !== 'object') continue;
      const job = jobs.get(String(p.id));
      if (!job) continue;
      setJob(job, p.patch);
      n += 1;
    }
    if (n) persist();
    return n;
  }

  /** `/downloads/list` 的标量汇总（与 snapshot 上的旁路字段同一口径）。 */
  function queueCounts() {
    let queuedCount = 0;
    let runningCount = 0;
    let pendingCount = 0;
    let pendingHighCount = 0;
    for (const j of jobs.values()) {
      if (j.status === 'queued') queuedCount += 1;
      else if (j.status === 'running') runningCount += 1;
      else if (j.status === 'pending') {
        pendingCount += 1;
        if (normalizePriority(j.priority) === 'high') pendingHighCount += 1;
      }
    }
    return { paused, queuedCount, runningCount, pendingCount, pendingHighCount };
  }

  /**
   * **多连接 Range 下载**（针对高延迟线路）：从 `from` 字节继续，写到同一个 `.part`。
   *
   * 为什么需要：单条 TCP 连接在高 RTT 线路上会被带宽时延积卡死（用户另一台 0.8 s RTT：
   * 单流 0.21 MB/s，12 路 1.28 MB/s）。反过来低 RTT 线路上多连接只会互相抢窗口
   * （本机 3 路 2.13 MB/s < 单流 3.28 MB/s）—— 所以**由调用方**决定何时用（见 runOne 的 auto）。
   *
   * ⚠️ **必须直接按偏移写同一个文件**（`flags:'r+'` + `start`），不能再"多个分片文件 +
   * 拼接到 .part"：那条旧实现要把 17 MB 再整读一遍、整写一遍，实测比 curl 单流还慢
   * （16.7 MB：curl 5.2 s / 3.20 MB·s⁻¹，旧分片 7.9 s / 2.13 MB·s⁻¹）。
   * 现在每条 Range 各自写自己那段，收完只做一次 rename ⇒ 没有第二轮 IO。
   *
   * `from > 0` 是 4.23.3 的关键：自适应切换**从已下载偏移续传**，已下的字节一个不重下。
   * 所以这里不对文件做"清空重写"，只要求盘上大小正好等于 `from`（否则说明状态不一致，直接失败）。
   *
   * ── 4.23.7 修复（ranged 静默损坏，P0）：三层即时校验，任何一层不过就抛 ────────────
   *   ① **每片实收字节** `got`：收尾必须 `got === 期望长度`，否则 `range-short`。
   *      旧实现 `return end - start + 1`（请求长度）当"实收"，于是下面那句
   *      `written !== span` **恒不成立** —— 这条判据从写成那天起就没生效过。
   *   ② **Content-Range 逐字核对**：`start/end` 与请求一致、`/total` 等于本地 `total`，
   *      否则 `range-version-mismatch`。双版本对象（事故现场）在这里被拦下。
   *   ③ **ETag 一致性**：全量响应那次记下的 ETag，与每片 206 的 ETag（若有）必须相同，
   *      否则 `range-etag-mismatch`。
   *   ④ **不预填**：`base === 0` 只建空文件，不再 `truncateSync(part, total)`。
   *      旧实现的预填把文件先撑到 `total` 个 0x00，于是收尾的 `onDisk !== total` 也**恒不成立**
   *      —— 少写一段就变成"尾部一截 0"，而长度校验说一切正常。现在写多少涨多少，
   *      落盘长度重新成为证据（选择"按实际长度定长"而不是"维护已收区间"：区间在
   *      ①已经逐片核对过、分片按构造连续覆盖 `[base, total-1]`，再来一份区间账只是
   *      重复证据；而"文件长度"原本是唯一的独立证据，必须先让它恢复可信）。
   */
  async function fetchRanged(url, part, from, total, chunks, onChunk, opts = {}) {
    const base = Math.max(0, Math.min(Number(from) || 0, total));
    const span = total - base;
    if (span <= 0) return;
    mkdirSync(dirname(part), { recursive: true });
    if (base === 0) {
      // 建**空**文件（绝不预填到 total）：各分片用 r+ 按偏移写，写越界自然扩展。
      writeFileSync(part, Buffer.alloc(0));
    } else {
      const have = statSync(part).size;
      if (have !== base) throw new Error('range-resume-mismatch:' + have + '/' + base);
    }
    const expectedEtag = String((opts && opts.etag) || '');
    const size = Math.ceil(span / chunks);
    const tasks = [];
    for (let i = 0; i < chunks; i += 1) {
      const start = base + i * size;
      const end = Math.min(total - 1, start + size - 1);
      if (start > end) break;
      tasks.push((async () => {
        const r = await fetch(url, {
          headers: { ...UA, range: 'bytes=' + start + '-' + end },
          redirect: 'follow',
        });
        if (r.status !== 206) throw new Error('range-unsupported-' + r.status);
        // ② 版本守卫：这段字节必须属于**我们要的那个对象、那一段**。
        const cr = parseContentRange(r.headers.get('content-range'));
        if (!cr) throw new Error('range-version-mismatch:no-content-range');
        if (cr.start !== start || cr.end !== end) {
          throw new Error('range-version-mismatch:asked ' + start + '-' + end
            + ' got ' + cr.start + '-' + cr.end);
        }
        if (cr.total !== null && cr.total !== total) {
          throw new Error('range-version-mismatch:total ' + cr.total + '/' + total);
        }
        // ③ 同一对象的另一条证据：ETag（服务端不给就不比，给就必须逐字一致）。
        const etag = String(r.headers.get('etag') || '');
        if (etag && expectedEtag && etag !== expectedEtag) {
          throw new Error('range-etag-mismatch:' + etag + ' ≠ ' + expectedEtag);
        }
        const src = r.body ? Readable.fromWeb(r.body) : null;
        if (!src) throw new Error('empty-range-body');
        const want = end - start + 1;
        // ① 每片**实收**字节：这才是判据，不是"我请求了多少"。
        let got = 0;
        const out = createWriteStream(part, { flags: 'r+', start });
        try {
          await new Promise((resolve, reject) => {
            src.on('data', (chunk) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              got += buf.length;
              onChunk(buf.length);
              if (!out.write(buf)) { src.pause(); out.once('drain', () => src.resume()); }
            });
            src.on('end', () => {
              if (got !== want) reject(new Error('range-short:' + got + '/' + want + ' @' + start + '-' + end));
              else resolve(undefined);
            });
            src.on('error', reject);
            out.on('error', reject);
          });
          await new Promise((resolve, reject) => {
            out.end(() => resolve(undefined));
            out.on('error', reject);
          });
        } catch (e) {
          // ⚠️ 失败时必须**先关掉这条分片的写入流**：Windows 上还开着的 fd 会让调用方的
          // "截回切换点 + 续传单流"直接 EPERM（实测：range-short 之后整个 job 变成
          // `EPERM: open …part`，回落路径根本没跑到）。
          try { out.destroy(); } catch { /* ignore */ }
          try { src.destroy(); } catch { /* ignore */ }
          throw e;
        }
        return got;
      })());
    }
    let sizes;
    try {
      sizes = await Promise.all(tasks);
    } catch (e) {
      // 一个分片失败时其余分片可能还在写：必须**等它们都收尾**再抛，
      // 否则调用方的"截回切换点 + 回落单流"会与仍在写文件的流打架（写成洞）。
      await Promise.allSettled(tasks);
      throw e;
    }
    const written = sizes.reduce((a, b) => a + b, 0);
    if (written !== span) throw new Error('range-size-mismatch:' + written + '/' + span);
    const onDisk = statSync(part).size;
    if (onDisk !== total) throw new Error('range-size-mismatch:disk ' + onDisk + '/' + total);
  }

  /**
   * **单连接**把响应体写进 `.part`；`auto` 模式下到点评估一次，慢就主动 abort，
   * 把控制权交回 runOne 改走多连接。
   *
   * 返回 `{ switched, from }`：`from` 是切换那一刻**盘上真实字节数**（缓冲区里的不算），
   * 多连接就从它续传 —— 这保证"切换不重下已下载部分"不是靠估算，而是靠盘上的事实。
   */
  async function streamSingle(job, part, startAt, resp, ctrl, opts) {
    mkdirSync(dirname(part), { recursive: true });
    const out = createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' });
    const src = resp.body ? Readable.fromWeb(resp.body) : null;
    if (!src) { out.end(); throw new Error('empty-body'); }
    const baseReceived = Number(job.received) || 0;
    const startedAt = Date.now();
    let switched = false;
    let finished = false;
    const timer = opts && opts.auto ? setTimeout(() => {
      if (finished) return;
      const elapsed = Math.max(1, Date.now() - startedAt) / 1000;
      const mbps = Math.max(0, (Number(job.received) || 0) - baseReceived) / 1048576 / elapsed;
      const remaining = (Number(job.total) || 0) - (Number(job.received) || 0);
      // 判据与文档/CHANGELOG 一致：**平均**吞吐 < 0.6 MB/s 且剩余 > 4 MB ⇒ 高 RTT 的典型形态。
      if (mbps < ADAPTIVE_SLOW_MBPS) {
        // 4.23.4：**不管要不要切多连接，都把"这个域慢"记下来** —— 1080p 变体选档
        // （lib/variant-pick.js）读的就是这个标记。它必须是同一次实测结论，
        // 不能各写一个 0.6 的阈值（否则"队列觉得慢、选档觉得不慢"）。
        const h = hostOf(job.url);
        if (h) slowHosts.add(h);
      }
      if (mbps < ADAPTIVE_SLOW_MBPS && remaining > ADAPTIVE_MIN_REMAINING) {
        switched = true;
        log('download-queue: ' + mbps.toFixed(2) + ' MB/s, '
          + (remaining / 1048576).toFixed(1) + ' MB left ⇒ switch to ranged');
        try { if (ctrl) ctrl.abort(); } catch { /* ignore */ }
        // abort 之外再显式 destroy：有的实现只断 socket、不一定会让 body 流报错。
        try { src.destroy(new Error('adaptive-switch')); } catch { /* ignore */ }
      }
    }, ADAPTIVE_EVAL_MS) : null;
    try {
      await new Promise((resolve, reject) => {
        src.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          job.received += buf.length;
          if (!out.write(buf)) { src.pause(); out.once('drain', () => src.resume()); }
        });
        src.on('end', resolve);
        // 主动切换时 body 会以错误收尾，这不是失败 —— 交给多连接续传。
        src.on('error', (e) => { if (switched) resolve(undefined); else reject(e); });
        out.on('error', reject);
      });
    } finally {
      finished = true;
      if (timer) clearTimeout(timer);
      await new Promise((resolve) => { out.end(() => resolve(undefined)); });
    }
    if (switched) {
      let size;
      try { size = statSync(part).size; } catch { size = 0; }
      setJob(job, { received: size });
      return { switched: true, from: size };
    }
    return { switched: false, from: 0 };
  }

  /**
   * 走一次多连接并把 job 收尾（rename + sidecar + onDone）。成功返回 true。
   *
   * 失败时**回落到单流**的前提是先把 `.part` 截回切换点 `from`：分片是并发按偏移写的，
   * 中途失败会留下"洞"（后面的段写了、前面的没写），直接续传单流会把洞永久留在文件里。
   */
  async function finishRanged(job, part, from, total, chunks, opts) {
    setJob(job, { mode: 'ranged:' + chunks, autoSwitched: Boolean(opts.autoSwitched) });
    log('download-queue: ' + (opts.autoSwitched ? 'ranged switch' : 'ranged start') + ' ' + job.kind
      + ' @' + (from / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1) + ' MB x' + chunks);
    try {
      // `etag` = 全量响应那次的 ETag（版本见证人）；每片 206 若也带 ETag 就必须与它一致。
      await fetchRanged(job.url, part, from, total, chunks, (n) => { job.received += n; }, { etag: opts.etag });
    } catch (e) {
      // 4.23.17：**本地文件不见了**（`.part` 被外部清理）不是"回源路径失败"，不能落回单流
      // 假装没事（单流会重新建文件并"成功"）。交给 runOne 的 ENOENT 自愈：清残留 + 重排。
      if (isEnoentError(e)) throw e;
      try { truncateSync(part, from); } catch { /* ignore */ }
      setJob(job, { mode: 'single', autoSwitched: false, received: from });
      log('download-queue: ranged failed on ' + job.url + ' — ' + String((e && e.message) || e) + ', fall back to single');
      return false;
    }
    const onDisk = statSync(part).size;
    if (onDisk !== total) throw new Error('range-size-mismatch:disk ' + onDisk + '/' + total);
    // P0-5：多连接这条路也吃同一条"无效媒体不入库"判据（rename 之前）。
    const rangedInvalid = invalidMediaReason(part);
    if (rangedInvalid) {
      try { rmSync(part, { force: true }); } catch { /* ignore */ }
      setJob(job, { status: 'failed', error: 'invalid-media:' + rangedInvalid, received: 0 });
      log('download-queue: invalid-media (ranged) ' + job.url + ' — ' + rangedInvalid);
      persist();
      return false;
    }
    // 4.23.22：校验用**当前清单**（刷新一次再判）；不一致仍由 runOne 决定是否单流重下一次。
    await verifyCompletedFile(job, part);
    // 慢标记：同域后续任务直接多连接（只在 auto 模式下、且这次切换确实成功过）。
    if (opts.autoSwitched) {
      const host = hostOf(job.url);
      if (host) slowHosts.add(host);
    }
    renameSync(part, job.dest);
    try { writeFileSync(job.dest + '.etag', JSON.stringify({ size: total, etag: '' })); } catch { /* ignore */ }
    setJob(job, { status: 'done', total, received: total, enoentRetries: 0 });
    try { onDone(job); } catch { /* ignore */ }
    log('download-queue: done (ranged) ' + job.kind + ' ' + job.dest + ' (' + Math.round(total / 1048576) + ' MB)');
    return true;
  }

  /** 多连接失败后的兜底：从 `fromPos` 续一条单流（调用方已把 `.part` 截回该点）。 */
  async function resumeSingle(job, part, fromPos, totalKnown) {
    // 自适应切换时旧 controller 已经被 abort，复用它的 signal 会让兜底请求秒失败。
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    setJob(job, { mode: 'single', received: fromPos, ctrl });
    const headers = /** @type {Record<string, string>} */ ({ ...UA });
    // 4.24.1（与 planResume 同一条不变量）：Range 起点必须**严格小于**总量；否则不发 Range
    // （起点 == 总量 ⇒ 416；总量未知 ⇒ 无法证明起点合法）。这里不加这条会让 ranged → 单流
    // 的兜底绕过上面的体检，重新制造同一类 416。
    if (fromPos > 0 && (totalKnown <= 0 || fromPos < totalKnown)) headers.range = 'bytes=' + fromPos + '-';
    const r = await fetch(job.url, { headers, signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' });
    if (!r.ok && r.status !== 206) throw new Error('http-' + r.status);
    const startAt = r.status === 206 ? fromPos : 0;
    // 单流续传也吃同一条版本判据：206 的 `/total` 与本地已知总量不一致 ⇒ 这条连接给的是
    // 另一个对象，从这里往后写就是拼错。宁可明确失败（`range-version-mismatch`），
    // 也不要拼出一个长度对、内容坏的文件。
    if (r.status === 206 && totalKnown > 0) {
      const cr = parseContentRange(r.headers.get('content-range'));
      if (cr && cr.total !== null && cr.total !== totalKnown) {
        throw new Error('range-version-mismatch:total ' + cr.total + '/' + totalKnown);
      }
    }
    if (startAt === 0) {
      try { rmSync(part, { force: true }); } catch { /* ignore */ }
      setJob(job, { received: 0 });
    }
    await streamSingle(job, part, startAt, r, ctrl, { auto: false });
    if (totalKnown > 0) {
      const onDisk = statSync(part).size;
      if (onDisk !== totalKnown) throw new Error('size-mismatch:' + onDisk + '/' + totalKnown);
    }
  }


  /**
   * hash-mismatch 之后的**唯一一次**自动重下：把 job 放回队列，并置 `singleOnly`
   * （关掉多连接与自适应切换，换一条传输路径把同一批字节重新取一遍）。
   *
   * 为什么延到下一个 tick：`runOne` 的 finally 还没跑完（`ctrl=null` / `persist()`）。
   * 立刻 `pump()` 会让同一条 job 带着旧状态再进来；等一拍，队列看到的是一个干净的
   * `queued`。也只重排**一次**：`job.hashRetry` 已经是 true 时不再进来（见 runOne 的 catch）。
   */
  function scheduleSingleRetry(job) {
    setTimeout(() => {
      if (!jobs.has(job.id) || job.status !== 'failed') return;
      setJob(job, {
        status: 'queued', error: null, received: 0, singleOnly: true, mode: 'single', autoSwitched: false,
      });
      persist();
      pump();
    }, 0);
  }

  /* ── 4.24.1（P0）：`.part` 体检与残留损坏的唯一处置 ───────────────────────── */

  /** 删掉 `.part`，返回是否真的删到了东西（删不掉也要继续重下，绝不因此失败）。 */
  function discardPart(part, why) {
    try {
      rmSync(part, { force: true });
    } catch { /* 删不掉也要继续重下 */ }
    log('download-queue: dropped stale .part (' + why + ') ' + part + ' — restart from byte 0');
  }

  /**
   * **`.part` 已完整（`size === total`）时的落位通道**（4.24.1，P0-1）。
   *
   * 为什么必须先校验再 rename：`size` 相等只能证明"**长度**对"，不能证明"内容就是站点那个
   * 对象"（4.23.6 的静默损坏、旧版预填 0x00 都是"长度对、内容错"）。
   *
   * ⚠️ **没有可用的 sha 就不许直接落位**（这条是判据，不是优化）：
   *   用户要求原话是「`partSize == total` ⇒ 先按已知 sha 校验（对 ⇒ rename 完成；**错/无 sha**
   *   ⇒ 删 part 从 0）」。旧实现在"清单不可达 ⇒ 退化为长度 + 结构"这一档会把**长度相等的
   *   垃圾**直接 rename 成成品（结构判据对 `.part` 后缀本来就不生效 —— `invalidMediaReason()`
   *   只判媒体后缀，`.mp4.part` 不在其中）。所以这里先问 `currentExpectation()`：
   *   拿不到 sha 就直接放弃落位、交回调用方删掉重下。代价是一次重下，收益是**不可能**把
   *   "长度对、内容错"的残留冒充成已缓存。
   *
   * @returns {Promise<boolean>} true = 已 rename 为成品并标 done
   */
  async function tryCompletePart(job, part, total) {
    const exp = currentExpectation(job);
    if (!exp || !exp.sha256) {
      // 证明不了内容 ⇒ 不落位（调用方会 discardPart 后从 0 重下）。
      log('download-queue: complete .part 无法证明内容（清单没有 sha）' + job.url
        + ' — restart from byte 0');
      return false;
    }
    try {
      await verifyCompletedFile(job, part);
    } catch (e) {
      log('download-queue: complete .part failed content check (' + String((e && e.message) || e) + ') '
        + job.url + ' — restart from byte 0');
      return false;
    }
    try { renameSync(part, job.dest); } catch (e) {
      log('download-queue: cannot land complete .part (' + String((e && e.message) || e) + ') ' + job.dest);
      return false;
    }
    setJob(job, { status: 'done', total, received: total, enoentRetries: 0, mode: 'single', autoSwitched: false });
    try { writeFileSync(job.dest + '.etag', JSON.stringify({ size: total, etag: '' })); } catch { /* sidecar 是优化，不是判据 */ }
    try { onDone(job); } catch { /* 消费方失败不影响下载结论 */ }
    log('download-queue: complete .part verified & landed ' + job.kind + ' ' + job.dest
      + ' (' + Math.round(total / 1048576) + ' MB)');
    return true;
  }

  /**
   * **打开 job 前的续传计划**（4.24.1，P0）。
   *
   * 不变量（每一条都对应一次实测故障）：
   *   · `partSize >= total` ⇒ 绝不再发 Range（起点 ≥ 总量必然 416）；
   *   · `partSize === total` ⇒ 先校验：通过就直接落位（省一次整包重下），不通过就删掉从 0 重下；
   *   · `partSize > total` ⇒ 残留比目标还大（换过版本 / 拼坏）⇒ 删掉从 0 重下；
   *   · `total <= 0`（总量未知）⇒ 保留半截、按盘上字节续传（**不删**：总量未知只说明
   *     "证明不了起点 ≥ 总量"，不说明这份半截有毒；真要是越界，站点会回 416，下面那条
   *     自愈路径会删掉它从 0 重来。为了一个假设删掉用户已经下好的几 MB 是净损失）；
   *   · `0 < partSize < total` ⇒ 正常续传，起点 = partSize。
   *
   * @returns {Promise<{ from: number, landed?: boolean }>}
   */
  async function planResume(job, part) {
    const size = bytesOf(part);
    if (size < 0) return { from: 0 };
    const total = Number(job.total) || 0;
    // 总量未知：无法证明 `partSize >= total`，但**也不该**把已下字节扔掉 ⇒ 按盘上字节续传。
    if (total <= 0) return { from: size };
    if (size < total) return { from: size };
    if (size === total && await tryCompletePart(job, part, total)) return { from: 0, landed: true };
    discardPart(part, size === total ? 'complete-but-invalid' : 'oversize:' + size + '/' + total);
    return { from: 0 };
  }

  /** 416 / 416-like：站点明确表示"你要的起点 ≥ 对象长度"⇒ 本地残留损坏，不是链路故障。 */
  function isRange416(e) {
    const msg = String((e && (e.message || e.code)) || e || '');
    return /(^|[^0-9])416([^0-9]|$)/.test(msg);
  }

  async function runOne(job) {
    job.status = 'running';
    job.error = null;
    job.pauseRequested = false;
    const part = job.dest + '.part';
    try {
      // 4.24.1（P0：http-416 的根因）：**打开 job 之前先体检 `.part`**。
      // 旧实现无条件把盘上字节数当 Range 起点：残留 `.part` 恰好等于 total（上次收尾前被杀 /
      // 手工拷贝 / 旧版预填）时发 `Range: bytes=<total>-`，站点按规范回 416，用户看到
      // 「站点返回错误(http-416)」而文件其实一个字节都不缺。判据见 test/verify-download-recovery.mjs。
      const resume = await planResume(job, part);
      if (resume.landed) return;       // `.part` 已完整且校验通过 ⇒ 已直接落位（省掉整包重下）
      // Range 起点 = min(盘上字节, 总量)，由 `planResume` 保证落在 [0, total) ——
      // 因此这里的 `from > 0` 同时就是"起点严格小于总量"的判据。
      const from = resume.from;
      const headers = /** @type {Record<string, string>} */ ({ ...UA });
      if (from > 0) headers.range = 'bytes=' + from + '-';
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      // ⚠️ 走 `setJob`（`Object.assign`）而不是直接 `job.ctrl = ctrl`：上面已经有 await，
      // 直写成员会被 `require-atomic-updates` 判成"基于过期快照赋值"（verify-static 的基线）。
      setJob(job, { ctrl });

      // ③ 下载前先问一次"要不要下"：HEAD 拿长度 + etag，与上次落地的 sidecar 记录一致 ⇒ 整次跳过。
      //    省掉的是整包传输，收益比任何传输优化都大（站点换 CDN 但内容没变时也能认出来）。
      if (from === 0 && existsSync(job.dest)) {
        try {
          const h = await fetch(job.url, { method: 'HEAD', redirect: 'follow' });
          if (h.ok) {
            const size = Number(h.headers.get('content-length') || 0);
            const etag = h.headers.get('etag') || '';
            let seen = null;
            try { seen = JSON.parse(readFileSync(job.dest + '.etag', 'utf8')); } catch { seen = null; }
            const same = seen && seen.size === size && size > 0 && (!etag || !seen.etag || seen.etag === etag);
            if (same) {
              // 4.23.22：**已有文件也要按当前清单验一次**（旧文件可能是旧版本 / 拼坏）。
              // 校验器会先刷新清单再判；刷新后仍不符才当"本地副本不是当前对象"处理。
              let hashOk = true;
              try { await verifyCompletedFile(job, job.dest); }
              catch (e) { if (e && e.hashMismatch) hashOk = false; else throw e; }
              if (hashOk) {
                setJob(job, { status: 'done', total: size, received: size, enoentRetries: 0 });
                try { onDone(job); } catch { /* 消费方失败不影响结果 */ }
                return;
              }
              // 本地那份内容对不上站点 ⇒ 当它不存在，照常重下（下面会覆盖 .part/dest）。
              try { rmSync(job.dest, { force: true }); } catch { /* ignore */ }
              try { rmSync(job.dest + '.etag', { force: true }); } catch { /* ignore */ }
              log('download-queue: local copy of ' + job.url + ' failed content check — re-download');
            }
          }
        } catch { /* HEAD 失败就照常下载，不做判断 */ }
      }

      const mode = rangedMode();
      const chunks = rangedChunks();
      const r = await fetch(job.url, { headers, signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' });
      if (!r.ok && r.status !== 206) throw new Error('http-' + r.status);
      const startAt = r.status === 206 ? from : 0;
      if (startAt === 0 && existsSync(part)) { try { rmSync(part, { force: true }); } catch { /* ignore */ } }
      const len = Number(r.headers.get('content-length') || 0);
      // 进度以"盘上已有字节"为起点：续传时收到的不是从 0 开始，否则百分比会从 0 爬。
      setJob(job, { total: len ? len + startAt : (job.total || 0), received: startAt, mode: 'single', autoSwitched: false });

      const acceptsRanges = /bytes/i.test(String(r.headers.get('accept-ranges') || ''));
      const totalKnown = Number(job.total) || 0;
      // 全量响应那次的 ETag = "这一版对象"的见证人。各 206 的 ETag 必须与它一致（见 fetchRanged ③）。
      const etag = String(r.headers.get('etag') || '');
      const host = hostOf(job.url);
      const remaining = totalKnown - startAt;
      /**
       * ① 一开始就多连接的两种情形：
       *    · `DSH_FOLIA_RANGED=1`：用户显式要，且文件够大（>= 8 MB，沿用 4.22 口径）；
       *    · `auto` + 本会话已标记慢的同域：不让每个后续任务都先慢 3 秒。
       * ③ `job.singleOnly`（4.23.7）：hash-mismatch 之后的**唯一一次**自动重下强制走单流 ——
       *    重试的意义是"换一条路径重新取字节"，再走同一条多连接等于把同一组判据再跑一遍。
       */
      const wantRangedNow = !job.singleOnly
        && (mode === 'force' || (mode === 'auto' && host !== '' && slowHosts.has(host)));
      const rangedEligible = acceptsRanges && totalKnown > 0 && remaining >= ADAPTIVE_MIN_REMAINING
        && (mode !== 'force' || totalKnown >= RANGED_MIN_BYTES);
      if (wantRangedNow && rangedEligible) {
        try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel(); } catch { /* ignore */ }
        if (await finishRanged(job, part, startAt, totalKnown, chunks, { autoSwitched: false, etag })) return;
        // 分片路径失败（例如中间代理吃掉 Range / 双版本对象 / 短读）：.part 已被截回 startAt，
        // 落回单流续传 —— **任何** fetchRanged 的 throw 都走这条路，不留 job 在中间态。
        await resumeSingle(job, part, startAt, totalKnown);
      } else {
        /**
         * ② 先单流；`auto` 模式在**开始后 3 秒**评估一次：
         *    平均吞吐 < 0.6 MB/s 且剩余 > 4 MB ⇒ abort 并从 `.part` 当前偏移续多连接。
         */
        const single = await streamSingle(job, part, startAt, r, ctrl,
          { auto: !job.singleOnly && mode === 'auto' && acceptsRanges && totalKnown > 0 });
        if (single.switched) {
          if (await finishRanged(job, part, single.from, totalKnown, chunks, { autoSwitched: true, etag })) return;
          await resumeSingle(job, part, single.from, totalKnown);
        }
      }

      if (!job.received && startAt === 0) throw new Error('empty-body');
      // 最终 size 校验：多连接/回落/断点续传都写着同一个 `.part`，只有长度对得上才算完成。
      const onDisk = statSync(part).size;
      if (totalKnown > 0 && onDisk !== totalKnown) throw new Error('size-mismatch:' + onDisk + '/' + totalKnown);
      /**
       * **无效媒体不入库**（4.23.15 / P0-5，事故驱动）。
       *
       * 真实事故：测试/脚本把合成占位视频（4–65 KB 的 `ftyp isom … mdat`、ffprobe 无 stream）
       * 写进了用户的 library，用户看到的所有「浏览器无法解码」正是这些假文件。
       * 而它们**通过了**长度校验（长度就是那样）、也常通过 sha256（站点没给时这层不设防）
       * ⇒ 必须在 rename **之前**用内容判据拦下来，并且**标 failed 而不是 done**：
       * 界面要能看见"这条根本没下来"，而不是留一个坏文件冒充已缓存。
       */
      const invalid = invalidMediaReason(part);
      if (invalid) {
        try { rmSync(part, { force: true }); } catch { /* ignore */ }
        setJob(job, { status: 'failed', error: 'invalid-media:' + invalid, received: 0 });
        log('download-queue: invalid-media ' + job.url + ' — ' + invalid + ' (not landed)');
        persist();
        return;
      }
      // 4.23.22：长度对之后还要证明"内容就是站点**当前**那个文件"（当前清单的 sha，刷新一次再判）。
      await verifyCompletedFile(job, part);
      renameSync(part, job.dest);
      job.status = 'done';
      job.enoentRetries = 0;
      if (!job.total) { try { job.total = statSync(job.dest).size; } catch { /* ignore */ } }
      // 记一次 sidecar，供下次 HEAD 比对（内容没变就整次跳过）
      try { writeFileSync(job.dest + '.etag', JSON.stringify({ size: job.total, etag: '' })); } catch { /* ignore */ }
      try { onDone(job); } catch { /* 消费方失败不影响下载结果 */ }
      log('download-queue: done ' + job.kind + ' ' + job.dest + ' (' + Math.round(job.total / 1048576) + ' MB)');
    } catch (e) {
      const aborted = e && (e.name === 'AbortError');
      /**
       * 4.25.1：显式换档（user clicked "use original" / quality switch）打断了在跑的旧档。
       * 此刻流已收尾 ⇒ 安全地把同一条 job 迁到新 URL，重新排队（不产生第二条 job）。
       */
      if (job.replaceOnAbort) {
        const target = job.replaceOnAbort;
        job.replaceOnAbort = null;
        relocateJob(job, target.url, target.dest);
        setJob(job, { status: 'queued', error: null, received: 0, pauseRequested: false, enoentRetries: 0 });
        log('download-queue: quality switch ' + job.kind + ' → ' + target.url + ' — requeued');
        persist();
        setTimeout(() => pump(), 0);
        return;
      }
      /**
       * 4.23.18：暂停打断（`setPaused(true)`）。**不是失败、也不是取消**：回到 queued，
       * `.part` 保留，恢复后从盘上字节续传。放在 hash/ENOENT 分支之前 —— 暂停时抛什么
       * 异常都只表达"这一轮被打断了"，不该被误记成链路失败。
       */
      if (job.pauseRequested) {
        setJob(job, {
          status: 'queued', error: null, received: 0, pauseRequested: false,
          mode: 'single', autoSwitched: false,
        });
        log('download-queue: paused ' + job.kind + ' ' + job.url + ' — requeued (resume continues from .part)');
        persist();
        return;
      }
      // 4.24.1（P0）：**416 = 本地残留损坏**，不是站点/链路故障。
      // 触发面：`.part` 起点 ≥ 对象长度（残留恰好完整 / 换过版本 / total 是旧的）。
      // 处置：删掉本地残留（part + 成品 + sidecar）⇒ 从 0 重下**一次**；仍 416 才 failed，
      // 文案明确说"本地残留文件异常，已重新开始"（用户据此知道不是网络坏了）。
      if (!aborted && isRange416(e)) {
        for (const p of [part, job.dest, job.dest + '.etag']) {
          try { rmSync(p, { force: true }); } catch { /* ignore */ }
        }
        if (job.range416Retry !== true) {
          setJob(job, {
            status: 'queued', error: null, received: 0, total: 0,
            range416Retry: true, singleOnly: false, mode: 'single', autoSwitched: false, hashRetry: false,
          });
          log('download-queue: 站点返回 416（本地残留文件异常，已重新开始）' + job.url
            + ' — dropped local part/copy and restarting from byte 0');
          persist();
          return;
        }
        setJob(job, {
          status: 'failed',
          // 稳定错误码（面板按它取人话文案：`dlFailReason('local-part-invalid')`）。
          // 完整原因写在日志里，不把中文塞进 error 字段 —— 那会让客户端匹配不到词条。
          error: 'local-part-invalid',
          received: 0, range416Retry: true,
        });
        log('download-queue: 416 persisted after local reset ' + job.url + ' — giving up (local-part-invalid)');
        persist();
        return;
      }
      // B：内容不一致的处理**不是**普通失败 —— 删掉坏文件、标 failed(hash-mismatch)，
      // 并自动用单流重下一次（只一次）。仍不一致 ⇒ 停在 failed，文案说清"传输内容与站点不一致"。
      if (!aborted && e && e.hashMismatch) {
        try { rmSync(part, { force: true }); } catch { /* ignore */ }
        try { rmSync(job.dest, { force: true }); } catch { /* ignore */ }
        try { rmSync(job.dest + '.etag', { force: true }); } catch { /* ignore */ }
        const first = !job.hashRetry;
        setJob(job, {
          status: 'failed',
          error: first ? 'hash-mismatch' : 'hash-mismatch: 传输内容与站点不一致（已强制刷新清单复核）',
          received: 0, hashRetry: true, singleOnly: true, mode: 'single', autoSwitched: false,
          // 4.23.22：把"刷新后仍不符"的证据留在 job 上（url / expected / actual / manifestAgeMs / refreshAttempted）。
          verifyDetail: (e && e.verifyDetail) || job.verifyDetail || null,
          verifyReason: 'hash-mismatch',
        });
        log('download-queue: hash-mismatch ' + job.url + (first
          ? ' — auto retry once over a single stream'
          : ' — giving up after manifest refresh (content differs from the site)')
          + (job.verifyDetail ? ' ' + JSON.stringify(job.verifyDetail) : ''));
        persist();
        if (first) scheduleSingleRetry(job);
        return;
      }
      // 4.23.17：**本地文件被外部清理**（`.part` 被删 / 目录被清）⇒ 不是失败，先自己重下。
      // 详见 ENOENT_RETRY_LIMIT 的注释：只认"连续两次"，重下走单流并清掉残留 `.part`。
      if (!aborted && isEnoentError(e)) {
        try { rmSync(part, { force: true }); } catch { /* ignore */ }
        const tries = Math.max(0, Number(job.enoentRetries) || 0) + 1;
        if (tries < ENOENT_RETRY_LIMIT) {
          setJob(job, {
            status: 'queued', error: null, received: 0, enoentRetries: tries,
            // 不清 `singleOnly`：这不是"传输路径有问题"，换单流没有意义；
            // 下一轮按当前模式重新取（`.part` 已清，从 0 开始）。
            mode: 'single', autoSwitched: false,
          });
          log('download-queue: local file vanished (' + tries + '/' + (ENOENT_RETRY_LIMIT - 1)
            + ') ' + job.url + ' — requeue and download again');
          persist();
          return;
        }
        setJob(job, { status: 'failed', error: 'file-vanished', received: 0, enoentRetries: tries });
        log('download-queue: local file vanished twice ' + job.url + ' — giving up (file-vanished)');
        persist();
        return;
      }
      setJob(job, {
        status: aborted ? 'cancelled' : 'failed',
        error: aborted ? 'aborted' : String((e && e.message) || e),
      });
      if (!aborted) log('download-queue: failed ' + job.url + ' — ' + job.error);
    } finally {
      // 显式换档恰好撞上"旧档在 finally 之前已经跑完"（abort 没来得及打断）：也要迁过去。
      if (job.replaceOnAbort) {
        const target = job.replaceOnAbort;
        job.replaceOnAbort = null;
        relocateJob(job, target.url, target.dest);
        setJob(job, { status: 'queued', error: null, received: 0, pauseRequested: false, enoentRetries: 0 });
        log('download-queue: quality switch ' + job.kind + ' → ' + target.url + ' — requeued');
        setTimeout(() => pump(), 0);
      }
      setJob(job, { ctrl: null });
      persist();
    }
  }

  /**
   * 取任务：全局上限内，**每个 kind 只在自己的槽位里取**。
   *
   * 这是"看壁纸同时装皮肤不再卡住"的实现点：壁纸把自己的 2 个槽占满之后，
   * 皮肤仍然能在自己的槽里立刻启动（全局 ≤ 6 还有余量），而不是排在壁纸队列后面等。
   */
  function pump() {
    // 4.23.18：暂停期间不取新任务。恢复时 `setPaused(false)` 会显式再 pump 一次。
    if (paused) return;
    if (pumping) return;
    pumping = true;
    (async () => {
      try {
        for (;;) {
          if (running >= concurrency) break;
          const next = queuedOrder().find((j) => (runningByKind[kindOf(j)] || 0) < limitForKind(kindOf(j)));
          if (!next) break;
          const kind = kindOf(next);
          runningByKind[kind] = (runningByKind[kind] || 0) + 1;
          running += 1;
          runOne(next).finally(() => {
            runningByKind[kind] = Math.max(0, (runningByKind[kind] || 1) - 1);
            running -= 1;
            setTimeout(() => pump(), 0);
          });
        }
      } finally {
        pumping = false;
      }
    })();
  }

  load();
  // 4.24.1：**启动清理残留**（见 sweepLocalResidue 的文件内注释）——必须在 load() 之后、
  // pump() 之前：此刻没有任何本进程的在途下载，盘上的 `.part` 全是上个进程的遗产。
  try { sweepStats = sweepLocalResidue(); } catch (e) {
    log('download-queue: 启动清理残留失败（不影响下载）：' + String((e && e.message) || e));
  }
  // 4.23.22：启动时**不**迁移期望值（job 上已没有期望值）；校验发生在每次完成那一刻。
  pump();

  /** 按 dest 反查 job（含 dest/状态/总大小）——代理复用同一条下载用。 */
  function jobFor(dest) {
    for (const j of jobs.values()) {
      if (j.dest !== dest) continue;
      return {
        id: j.id, dest: j.dest, status: j.status, total: j.total, received: j.received, kind: j.kind,
        // 4.25.1：代理/清单按条目认同一份下载，不再只看 URL。
        itemKey: normalizeItemKey(j.itemKey), priority: normalizePriority(j.priority),
        // 4.23.15：`localCopyFor()` 要用它判"这份本地内容本机解不了 ⇒ 别选它播"。
        decodeUnsupported: j.decodeUnsupported === true,
      };
    }
    return null;
  }

  /** 已落地文件的绝对路径（未完成 / 不存在 ⇒ null）。/folia/local-media/<id> 用它。 */
  function pathFor(id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'done') return null;
    try { return existsSync(job.dest) ? job.dest : null; } catch { return null; }
  }

  /**
   * URL → job id（**与 `add()` 完全同一个键**，4.23.19）。
   *
   * 为什么需要它：清单里 100 个条目要各自拿到"这条 job 的最新状态"，若每次都 `snapshot()`
   * 扫一遍 + 排序，一次 `/inventory` 就是 100×O(n)。这里只是把 `add()` 已经在用的
   * `urlKey()` 暴露出来 —— 键的定义仍然只有一处。
   */
  function idForUrl(url) {
    const key = urlKey(String(url || ''));
    if (jobs.has(key)) return key;
    /**
     * 4.25.1：job id 在"原画 ↔ 变体"换档后仍保持稳定（不重建 job），因此 URL 的散列不再
     * 必然等于 id。这里按“当前 URL → 同族 URL”反查一次，让对账器/清单继续用 URL 找到同一条目。
     */
    const hit = findJobFor({ url: String(url || '') });
    return hit ? hit.id : key;
  }

  /**
   * 按**条目身份**取一条 job（inventory 用来给条目挂 `jobStatus/jobPriority`）。
   * 不写盘、不 pump：清单只读事实，绝不因为渲染列表而排下载。
   *
   * @param {{id?:string,url?:string,kind?:string,itemKey?:string,relatedUrls?:string[]}|string} inp
   * @returns {null|{id:string,itemKey:string,url:string,dest:string,kind:string,status:string,priority:string,pendingHigh:boolean}}
   */
  function jobForItem(inp) {
    const job = findJobFor(inp);
    if (!job) return null;
    return {
      id: job.id,
      itemKey: normalizeItemKey(job.itemKey),
      url: job.url,
      dest: job.dest,
      kind: job.kind,
      status: job.status,
      priority: normalizePriority(job.priority),
      pendingHigh: job.status === 'pending' && normalizePriority(job.priority) === 'high',
    };
  }

  /**
   * 按 **job id** 取一条**完整**视图（4.23.15 的「本地副本自愈」要用）。
   *
   * 与 `jobFor(dest)` 的区别：那条是给代理复用二进制读法的（只要 dest/状态/总量），
   * 而自愈还要回答"这条的期望 sha256 是多少、选的是哪个档、本机是不是已经判过解不了"
   * —— 这些都在 job 自己身上，不该再让调用方拼一次。
   *
   * 返回 null = 没有这条 job（旧 downloads.json / 客户端传了个过期 id）。
   * @param {string} id
   */
  function jobById(id) {
    const job = jobs.get(String(id || ''));
    if (!job) return null;
    return {
      id: job.id, url: job.url, dest: job.dest, kind: job.kind, status: job.status,
      total: Number(job.total) || 0, received: Number(job.received) || 0,
      error: job.error || null,
      chosenVariant: job.chosenVariant === '1080p' || job.chosenVariant === '4k30' ? job.chosenVariant : 'original',
      // 4.23.22：**不再向调用方提供"期望输入"**（旧 `sha256/expectSha` 已被删除）。
      // 自愈要验内容时用客户端带来的**当前清单** sha（见 `lib/media-selfheal.js`）。
      verified: job.verified || null,
      verifiedSha: normalizeSha256(job.verifiedSha),
      verifiedBytes: Number(job.verifiedBytes) || 0,
      verifiedAt: Number(job.verifiedAt) || 0,
      verifyReason: job.verifyReason || null,
      decodeUnsupported: job.decodeUnsupported === true,
    };
  }

  /**
   * **作废一条已完成 job 的本地成品**（4.23.15 自愈的核心动作）：
   * 删掉文件（及 `.etag` / `.part` 残留）→ 状态退回 `queued` → 下一次 pump 以**单流**重下。
   *
   * 为什么是"删文件 + 重置状态"而不是"再 add 一次"：`add()` 是幂等的，它看到同一条 job
   * 已经 `done` 且文件还在就什么都不做 —— 那正是"坏文件永远修不好"的形态。所以这里必须
   * 把**完成记录**一起作废；作废之后 `pathFor()` 立刻返回 null（代理与 inventory 都不会再
   * 把坏字节端出去），而 `pumps()` 会按单流把同一 URL 重新取一遍。
   *
   * `singleOnly` 的理由与 hash-mismatch 重试同源：重试的意义是"换一条传输路径重新取字节"，
   * 而 ranged 分片正是 4.23.6 静默损坏的来源 ⇒ 自愈重下**一律单流**（用户明确要求的）。
   *
   * @param {string} id
   * @param {object} [patch] 额外覆盖（例如 `{ decodeUnsupported: false }`）
   * @returns {null | { id: string, dest: string }}
   */
  function invalidate(id, patch) {
    const job = jobs.get(String(id || ''));
    if (!job) return null;
    for (const p of [job.dest, job.dest + '.etag', job.dest + '.part']) {
      try { rmSync(p, { force: true }); } catch { /* 删不掉（占用）也要继续重置状态 */ }
    }
    setJob(job, {
      status: 'queued', error: null, received: 0, total: Number(job.total) || 0,
      singleOnly: true, mode: 'single', autoSwitched: false, hashRetry: false, hashVerified: null,
      decodeUnsupported: false,
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    persist();
    pump();
    return { id: job.id, dest: job.dest };
  }

  /**
   * 标记「这份内容本身没问题，只是本机解不了」（4.23.15）。
   *
   * 为什么不下掉 job、也不删文件：内容是对的（sha256 与站点一致），删了只是白费一次下载；
   * 需要改变的是**后续选谁播** —— `localCopyFor()` 遇到这枚标记就跳过它，让
   * `pickFamilyCopy()` 落到同族的 1080p 变体上（见 lib/routes/downloads.js）。
   * @param {string} id
   * @param {boolean} [on]
   */
  function markDecodeUnsupported(id, on) {
    const job = jobs.get(String(id || ''));
    if (!job) return false;
    setJob(job, { decodeUnsupported: on !== false });
    persist();
    return true;
  }

  /**
   * 这个域**本会话实测**是不是慢（< ADAPTIVE_SLOW_MBPS）。
   *
   * 4.23.4 起这是 1080p 变体选档的"速度"那一半判据（`lib/variant-pick.js` 的 `hostSlow`）：
   * 队列已经在 3 秒处量过吞吐了，选档不该再量一次，也不该自己写一个阈值。
   * 只记内存、不落盘：换网络环境后旧结论不该继续生效。
   */
  function isSlowHost(host) {
    return Boolean(host) && slowHosts.has(String(host));
  }

  return {
    add, cancel, snapshot, pump, statePath, pathFor, jobFor, isSlowHost,
    // 4.23.19：URL → job id（与 add() 同一个键，供对账器做 O(1) 查询）。
    idForUrl,
    // 4.25.1：条目身份查询（清单挂 job 状态 / 点击前判断 pending+high）。
    jobForItem,
    // 4.23.15「本地副本自愈」：查一条 job 的完整视图 / 作废成品 / 标记"本机解不了"。
    jobById, invalidate, markDecodeUnsupported,
    // 4.23.18「队列可运维」：暂停全部 / 清空未开始（queued→pending）/ 读汇总。
    // 4.23.22：**没有 `migrate()`** —— 期望值不再持久化，就不需要迁移（见文件下方的说明）。
    setPaused, clearQueued, queueCounts,
    // 4.23.23：显式升/降优先级（切走降 low 继续下、点回升 high 回队首）。
    setPriority,
    // 4.23.19（P0）：清缓存后把内存里的 done 记录同步成 pending（否则客户端继续要 404 的本地文件）。
    resetDoneForKinds,
    // 4.23.19：对账器写状态（不 pump）—— 见 applyReconcile 的注释。
    applyReconcile,
    // 4.24.1（P0）：启动清理本地残留的最近一次统计（`/diag/media-state` 的 `sweep`）。
    sweepStats: () => ({ ...sweepStats }),
  };
}
