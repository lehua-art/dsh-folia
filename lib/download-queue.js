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
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

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

export function createDownloadQueue(opts = {}) {
  const {
    home,                        // 状态文件所在目录（调用方给）
    log = () => {},
    // 默认值在**每次调用**时读环境变量（`DSH_FOLIA_CONCURRENCY`，默认 6，夹 1..8），
    // 而不是模块加载时快照：否则测试与宿主同一进程时，改了环境变量也不会生效。
    concurrency: rawConcurrency = concurrencyFromEnv(),
    onDone = () => {},           // (job) => void：调用方在"落地完成"后做事（建索引 / 通知界面）
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
  let running = 0;
  /** kind → 正在跑的条数（pump 取任务时看它，不用去数 status）。 */
  const runningByKind = Object.create(null);
  let pumping = false;

  function persist() {
    try {
      mkdirSync(home, { recursive: true });
      const list = [...jobs.values()].map((j) => ({
        id: j.id, url: j.url, dest: j.dest, kind: j.kind, total: j.total,
        status: j.status, error: j.error || null, at: j.at,
        // 4.23.2：优先级必须落盘，否则重启后"用户点击"会退化成后台预取，优先级形同虚设。
        priority: normalizePriority(j.priority),
        // 4.23.3：`mode` / `autoSwitched` 也落盘 —— 面板与排障读的是"这条当时怎么下的"。
        mode: jobMode(j),
        autoSwitched: Boolean(j.autoSwitched),
        // 4.23.4：这条下的是原画还是 1080p 变体（`original` | `1080p`）。落盘才能在重启后
        // 仍然答得上"为什么这条只有 3 MB"这种问题。
        chosenVariant: String(j.chosenVariant || 'original'),
      }));
      writeFileSync(statePath, JSON.stringify({ version: 1, jobs: list }, null, 2));
    } catch { /* 持久化失败不影响下载 */ }
  }

  function load() {
    try {
      const doc = JSON.parse(readFileSync(statePath, 'utf8'));
      for (const j of (doc && Array.isArray(doc.jobs) ? doc.jobs : [])) {
        if (!j || !j.id || !j.url || !j.dest) continue;
        // 上次没下完的：状态回到 queued（有 .part 就续传）
        const done = j.status === 'done' && existsSync(j.dest);
        seqCounter += 1;
        jobs.set(j.id, {
          id: j.id, url: j.url, dest: j.dest, kind: j.kind || '', total: Number(j.total) || 0,
          received: done ? Number(j.total) || 0 : 0,
          status: done ? 'done' : 'queued', error: null, at: Number(j.at) || Date.now(),
          // 旧 jobs.json 没有 priority ⇒ `normal`（不是崩、也不是全员 high）。
          priority: normalizePriority(j.priority),
          // 旧 jobs.json 没有 mode ⇒ `single`；非法值同样回落到 single（向下兼容）。
          mode: /^ranged:\d+$/.test(String(j.mode || '')) ? String(j.mode) : 'single',
          autoSwitched: Boolean(j.autoSwitched),
          // 旧 jobs.json 没有 chosenVariant ⇒ `original`（4.23.3 的行为，不改画质）。
          chosenVariant: j.chosenVariant === '1080p' ? '1080p' : 'original',
          seq: seqCounter,
        });
      }
    } catch { /* 首次运行没有状态文件 */ }
  }

  /**
   * 队列里**等待中**的 job，按 (优先级 高→低, at 早→晚, 入队序号) 排好。
   * pump 与 snapshot 的 `queuePos` 用的是**同一个**函数 —— 否则"面板显示第 2 位、
   * 实际却先跑第 4 位"这种不一致会让人再也不敢信这个数字。
   */
  function queuedOrder() {
    return [...jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => (rankOf(b) - rankOf(a)) || (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)));
  }

  function snapshot() {
    const ordered = queuedOrder();
    const posById = new Map(ordered.map((j, i) => [j.id, i + 1]));
    /** 按 kind 的排队/在跑统计（面板与排障用；见 byKind 的挂载方式说明）。 */
    const byKind = Object.create(null);
    const slot = (k) => {
      if (!byKind[k]) byKind[k] = { running: 0, queued: 0, limit: limitForKind(k) };
      return byKind[k];
    };
    for (const j of jobs.values()) {
      const row = slot(kindOf(j));
      if (j.status === 'running') row.running += 1;
      else if (j.status === 'queued') row.queued += 1;
    }
    const out = [...jobs.values()]
      .sort((a, b) => b.at - a.at)
      .map((j) => {
        const row = {
          id: j.id, url: j.url, kind: j.kind, dest: j.dest, total: j.total, received: j.received,
          status: j.status, error: j.error || null,
          priority: normalizePriority(j.priority),
          // 4.23.3：这条 job **正在/曾经**怎么下的 —— `single` 或 `ranged:<n>`；
          // `autoSwitched` 只对 auto 模式成立（= 单流跑着跑着切成了多连接）。
          mode: jobMode(j),
          autoSwitched: Boolean(j.autoSwitched),
          // 4.23.4：这条下的是原画还是 1080p 变体（面板据此显示「1080p」小标，排障据此解释体积）。
          chosenVariant: j.chosenVariant === '1080p' ? '1080p' : 'original',
          percent: j.total > 0 ? Math.min(100, Math.round((j.received / j.total) * 100)) : (j.status === 'done' ? 100 : 0),
        };
        // 只有排队中的任务才有"位置"；1 基，1 = 前面没人（下一个就是它）。
        if (j.status === 'queued') row.queuePos = posById.get(j.id) || 0;
        return row;
      });
    // byKind 挂在**数组**上，而不是把 snapshot() 改成对象：它的返回形状是既有契约
    // （面板 / routes / 十余条判据都在当数组用）。这样 `.filter/.find/[0]` 一行都不用改。
    // 用 JSDoc 断言收敛类型：数组字面量上本没有这个属性，但这是**故意**挂上去的旁路统计。
    /** @type {any} */ (out).byKind = byKind;
    return out;
  }

  /** 入队（幂等）。返回 job 快照；`existed` 表示此前已存在。 */
  function add({ url, dest, kind = '', priority = 'normal', chosenVariant = 'original' }) {
    const id = urlKey(url);
    const wantPriority = normalizePriority(priority);
    const wantVariant = chosenVariant === '1080p' ? '1080p' : 'original';
    const existed = jobs.has(id);
    if (existed) {
      const job = jobs.get(id);
      // 同一 URL 被**更高优先级**重新入队 ⇒ 提权。语义：用户主动点击（high）应该插到
      // 后台预取（low）前面；反过来（low 重复入队）**不降级**，免得后台请求把用户刚点的安装降下去。
      if (rankOf({ priority: wantPriority }) > rankOf(job)) setJob(job, { priority: wantPriority });
      // 4.23.4：同一条 URL 再入队时选档结论以**这次**为准（用户可能刚点过「用原画」）。
      setJob(job, { chosenVariant: wantVariant });
      // 已完成但文件被删 ⇒ 重新排队
      if (job.status === 'done' && !existsSync(job.dest)) { job.status = 'queued'; job.received = 0; }
      // ⚠️ **失败/取消的 job 必须在"再点一次"时重置为 queued**。
      // 老实现只处理 done，于是：第一次因为瞬断（fetch failed）失败后，job 永远停在 failed，
      // 用户再点安装 → add 返回同一个 failed job → 安装立刻又报错（看起来"怎么点都下不来"）。
      // 实测症状：`error:"fetch failed"` 之后每次重试都秒失败。
      // `.part` 保留 ⇒ 重置后再下载会从已下载字节续传，不浪费流量。
      if (job.status === 'failed' || job.status === 'cancelled') {
        setJob(job, { status: 'queued', error: null });
      }
      // ⚠️ **必须再 pump 一次**：老实现"存在就直接返回"，于是一个已经 queued 的 job
      // 如果当时没有在跑的 pump（例如上一条刚结束、或快照被重置成 queued），
      // 就永远没人来启动它 ⇒ 调用方（皮肤安装）会一直等到超时。实测就是这样卡了 5 分钟。
      persist();
      pump();
      return { job: snapshot().find((x) => x.id === id), existed: true };
    }
    seqCounter += 1;
    jobs.set(id, {
      id, url: String(url), dest: String(dest), kind: String(kind || ''),
      total: 0, received: 0, status: 'queued', error: null, at: Date.now(),
      priority: wantPriority, mode: 'single', autoSwitched: false, chosenVariant: wantVariant, seq: seqCounter,
    });
    persist();
    pump();
    return { job: snapshot().find((x) => x.id === id), existed: false };
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return false;
    if (job.status === 'running' && job.ctrl) { try { job.ctrl.abort(); } catch { /* ignore */ } }
    job.status = 'cancelled';
    persist();
    return true;
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
   */
  async function fetchRanged(url, part, from, total, chunks, onChunk) {
    const base = Math.max(0, Math.min(Number(from) || 0, total));
    const span = total - base;
    if (span <= 0) return;
    mkdirSync(dirname(part), { recursive: true });
    if (base === 0) {
      // 先占位到正确长度（截断目标文件），随后各分片用 r+ 按偏移写
      writeFileSync(part, Buffer.alloc(0));
      truncateSync(part, total);
    } else {
      const have = statSync(part).size;
      if (have !== base) throw new Error('range-resume-mismatch:' + have + '/' + base);
    }
    const size = Math.ceil(span / chunks);
    const tasks = [];
    for (let i = 0; i < chunks; i += 1) {
      const start = base + i * size;
      const end = Math.min(total - 1, start + size - 1);
      if (start > end) break;
      tasks.push((async () => {
        const r = await fetch(url, {
          headers: { 'user-agent': 'dsh-folia/download-queue', range: 'bytes=' + start + '-' + end },
          redirect: 'follow',
        });
        if (r.status !== 206) throw new Error('range-unsupported-' + r.status);
        const out = createWriteStream(part, { flags: 'r+', start });
        const src = r.body ? Readable.fromWeb(r.body) : null;
        if (!src) throw new Error('empty-range-body');
        await new Promise((resolve, reject) => {
          src.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            onChunk(buf.length);
            if (!out.write(buf)) { src.pause(); out.once('drain', () => src.resume()); }
          });
          src.on('end', resolve);
          src.on('error', reject);
        });
        await new Promise((resolve) => { out.end(() => resolve(undefined)); });
        return end - start + 1;
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
      await fetchRanged(job.url, part, from, total, chunks, (n) => { job.received += n; });
    } catch (e) {
      try { truncateSync(part, from); } catch { /* ignore */ }
      setJob(job, { mode: 'single', autoSwitched: false, received: from });
      log('download-queue: ranged failed on ' + job.url + ' — ' + String((e && e.message) || e) + ', fall back to single');
      return false;
    }
    const onDisk = statSync(part).size;
    if (onDisk !== total) throw new Error('range-size-mismatch:disk ' + onDisk + '/' + total);
    // 慢标记：同域后续任务直接多连接（只在 auto 模式下、且这次切换确实成功过）。
    if (opts.autoSwitched) {
      const host = hostOf(job.url);
      if (host) slowHosts.add(host);
    }
    renameSync(part, job.dest);
    try { writeFileSync(job.dest + '.etag', JSON.stringify({ size: total, etag: '' })); } catch { /* ignore */ }
    setJob(job, { status: 'done', total, received: total });
    try { onDone(job); } catch { /* ignore */ }
    log('download-queue: done (ranged) ' + job.kind + ' ' + job.dest + ' (' + Math.round(total / 1048576) + ' MB)');
    return true;
  }

  /** 多连接失败后的兜底：从 `fromPos` 续一条单流（调用方已把 `.part` 截回该点）。 */
  async function resumeSingle(job, part, fromPos, totalKnown) {
    // 自适应切换时旧 controller 已经被 abort，复用它的 signal 会让兜底请求秒失败。
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    setJob(job, { mode: 'single', received: fromPos, ctrl });
    const headers = { 'user-agent': 'dsh-folia/download-queue' };
    if (fromPos > 0) headers.range = 'bytes=' + fromPos + '-';
    const r = await fetch(job.url, { headers, signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' });
    if (!r.ok && r.status !== 206) throw new Error('http-' + r.status);
    const startAt = r.status === 206 ? fromPos : 0;
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


  async function runOne(job) {
    job.status = 'running';
    job.error = null;
    const part = job.dest + '.part';
    let from = 0;
    try {
      if (existsSync(part)) {
        try { from = statSync(part).size; } catch { from = 0; }
      }
      const headers = { 'user-agent': 'dsh-folia/download-queue' };
      if (from > 0) headers.range = 'bytes=' + from + '-';
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      job.ctrl = ctrl;

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
              setJob(job, { status: 'done', total: size, received: size });
              try { onDone(job); } catch { /* 消费方失败不影响结果 */ }
              return;
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
      const host = hostOf(job.url);
      const remaining = totalKnown - startAt;
      /**
       * ① 一开始就多连接的两种情形：
       *    · `DSH_FOLIA_RANGED=1`：用户显式要，且文件够大（>= 8 MB，沿用 4.22 口径）；
       *    · `auto` + 本会话已标记慢的同域：不让每个后续任务都先慢 3 秒。
       */
      const wantRangedNow = mode === 'force' || (mode === 'auto' && host !== '' && slowHosts.has(host));
      const rangedEligible = acceptsRanges && totalKnown > 0 && remaining >= ADAPTIVE_MIN_REMAINING
        && (mode !== 'force' || totalKnown >= RANGED_MIN_BYTES);
      if (wantRangedNow && rangedEligible) {
        try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel(); } catch { /* ignore */ }
        if (await finishRanged(job, part, startAt, totalKnown, chunks, { autoSwitched: false })) return;
        // 分片路径失败（例如中间代理吃掉 Range）：.part 已被截回 startAt，落回单流续传。
        await resumeSingle(job, part, startAt, totalKnown);
      } else {
        /**
         * ② 先单流；`auto` 模式在**开始后 3 秒**评估一次：
         *    平均吞吐 < 0.6 MB/s 且剩余 > 4 MB ⇒ abort 并从 `.part` 当前偏移续多连接。
         */
        const single = await streamSingle(job, part, startAt, r, ctrl, { auto: mode === 'auto' && acceptsRanges && totalKnown > 0 });
        if (single.switched) {
          if (await finishRanged(job, part, single.from, totalKnown, chunks, { autoSwitched: true })) return;
          await resumeSingle(job, part, single.from, totalKnown);
        }
      }

      if (!job.received && startAt === 0) throw new Error('empty-body');
      // 最终 size 校验：多连接/回落/断点续传都写着同一个 `.part`，只有长度对得上才算完成。
      const onDisk = statSync(part).size;
      if (totalKnown > 0 && onDisk !== totalKnown) throw new Error('size-mismatch:' + onDisk + '/' + totalKnown);
      renameSync(part, job.dest);
      job.status = 'done';
      if (!job.total) { try { job.total = statSync(job.dest).size; } catch { /* ignore */ } }
      // 记一次 sidecar，供下次 HEAD 比对（内容没变就整次跳过）
      try { writeFileSync(job.dest + '.etag', JSON.stringify({ size: job.total, etag: '' })); } catch { /* ignore */ }
      try { onDone(job); } catch { /* 消费方失败不影响下载结果 */ }
      log('download-queue: done ' + job.kind + ' ' + job.dest + ' (' + Math.round(job.total / 1048576) + ' MB)');
    } catch (e) {
      const aborted = e && (e.name === 'AbortError');
      setJob(job, {
        status: aborted ? 'cancelled' : 'failed',
        error: aborted ? 'aborted' : String((e && e.message) || e),
      });
      if (!aborted) log('download-queue: failed ' + job.url + ' — ' + job.error);
    } finally {
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
  pump();

  /** 按 dest 反查 job（含 dest/状态/总大小）——代理复用同一条下载用。 */
  function jobFor(dest) {
    for (const j of jobs.values()) {
      if (j.dest !== dest) continue;
      return { id: j.id, dest: j.dest, status: j.status, total: j.total, received: j.received, kind: j.kind };
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
   * 这个域**本会话实测**是不是慢（< ADAPTIVE_SLOW_MBPS）。
   *
   * 4.23.4 起这是 1080p 变体选档的"速度"那一半判据（`lib/variant-pick.js` 的 `hostSlow`）：
   * 队列已经在 3 秒处量过吞吐了，选档不该再量一次，也不该自己写一个阈值。
   * 只记内存、不落盘：换网络环境后旧结论不该继续生效。
   */
  function isSlowHost(host) {
    return Boolean(host) && slowHosts.has(String(host));
  }

  return { add, cancel, snapshot, pump, statePath, pathFor, jobFor, isSlowHost };
}
