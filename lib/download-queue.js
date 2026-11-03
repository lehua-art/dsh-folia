/**
 * download-queue.js — **站点资源批量下载队列**（壁纸 / 开机动画 / 桌宠 / 皮肤包共用）。
 *
 * 产品流程（用户明确要求的）：
 *   站点资源 → **先下载到本地** → 渲染方（我们 / 皮肤中心）只从本地取。
 *   并且允许**一次勾选很多个并发下载**，而不是点一个下一个。
 *
 * 设计要点（与仓库其它地方同一套纪律）：
 *   · **按 kind 的独立并发槽**（skin 2 / wallpaper 2 / pet 1 / boot 1 / 其它 2）+ 全局上限 4：
 *     "看壁纸的同时装皮肤"曾经卡在「安装中…」——壁纸预取把同一队列的 3 个槽全占了。
 *     现在壁纸最多占自己那 2 个槽，皮肤永远拿得到自己的槽；全局 4 仍封顶总带宽。
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
 * 分片并发**默认关闭**（实测：同一份 16.7 MB 包，本机 curl 单流 3.2 MB/s / 5.1 s，
 * 3 路 Range 反而 1.0 MB/s / 16.7 s —— 这条 CDN 上多连接并不更快，反而互相抢窗口）。
 * 想再试可用 DSH_FOLIA_RANGED=1 打开；关掉后走单流，与 curl 同级。
 */
const RANGE_ENABLED = process.env.DSH_FOLIA_RANGED === '1';
/**
 * 全局并发上限。
 *
 * 从 3 抬到 4 是为了「皮肤 / 壁纸 / 桌宠 各自有槽」之后**总带宽仍有一道上限**：
 * 各类自身上限之和（skin 2 + wallpaper 2 + pet 1 + boot 1）= 6 > 4，所以这条全局上限
 * 是真正起作用的闸门，避免"每种都开满"把弱网机器拉爆。
 */
const DEFAULTS = { concurrency: 4, retries: 1 };

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
    concurrency = DEFAULTS.concurrency,
    onDone = () => {},           // (job) => void：调用方在"落地完成"后做事（建索引 / 通知界面）
  } = opts;
  const statePath = join(home, 'downloads.json');
  /** id → job */
  const jobs = new Map();
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
  function add({ url, dest, kind = '', priority = 'normal' }) {
    const id = urlKey(url);
    const wantPriority = normalizePriority(priority);
    const existed = jobs.has(id);
    if (existed) {
      const job = jobs.get(id);
      // 同一 URL 被**更高优先级**重新入队 ⇒ 提权。语义：用户主动点击（high）应该插到
      // 后台预取（low）前面；反过来（low 重复入队）**不降级**，免得后台请求把用户刚点的安装降下去。
      if (rankOf({ priority: wantPriority }) > rankOf(job)) setJob(job, { priority: wantPriority });
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
      priority: wantPriority, seq: seqCounter,
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
   * **分片并发下载**（针对高延迟线路）。
   *
   * 为什么需要：单条 TCP 连接在高 RTT 线路上会被窗口/慢启动限制。
   *
   * ⚠️ **必须直接按偏移写同一个文件**（`flags:'r+'` + `start`），不能再"三个分片文件 +
   * 拼接到 .part"：那条旧实现要把 17 MB 再整读一遍、整写一遍，实测比 curl 单流还慢
   * （16.7 MB：curl 5.2 s / 3.20 MB·s⁻¹，旧分片 7.9 s / 2.13 MB·s⁻¹）。
   * 现在三条 Range 各自写自己那段，收完只做一次 rename ⇒ 没有第二轮 IO。
   */
  async function fetchRanged(url, part, total, onChunk) {
    const CHUNKS = 3;
    const size = Math.ceil(total / CHUNKS);
    mkdirSync(dirname(part), { recursive: true });
    // 先占位到正确长度（截断目标文件），随后各分片用 r+ 按偏移写
    writeFileSync(part, Buffer.alloc(0));
    truncateSync(part, total);
    const tasks = [];
    for (let i = 0; i < CHUNKS; i += 1) {
      const start = i * size;
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
        await new Promise((resolve) => { out.end(resolve); });
        return end - start + 1;
      })());
    }
    const sizes = await Promise.all(tasks);
    const written = sizes.reduce((a, b) => a + b, 0);
    if (written !== total) throw new Error('range-size-mismatch:' + written + '/' + total);
    const onDisk = statSync(part).size;
    if (onDisk !== total) throw new Error('range-size-mismatch:disk ' + onDisk + '/' + total);
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

      const r = await fetch(job.url, { headers, signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' });
      if (!r.ok && r.status !== 206) throw new Error('http-' + r.status);
      const startAt = r.status === 206 ? from : 0;
      if (startAt === 0 && existsSync(part)) { try { rmSync(part, { force: true }); } catch { /* ignore */ } }
      const len = Number(r.headers.get('content-length') || 0);
      setJob(job, { total: len ? len + startAt : (job.total || 0) });

      // ② 大文件 + 支持 Range ⇒ 分片并发（单连接在高 RTT 线路上被窗口限制）。
      const acceptsRanges = /bytes/i.test(String(r.headers.get('accept-ranges') || ''));
      const totalKnown = Number(job.total) || 0;
      if (RANGE_ENABLED && startAt === 0 && acceptsRanges && totalKnown >= 8 * 1024 * 1024) {
        try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel(); } catch { /* ignore */ }
        await fetchRanged(job.url, part, totalKnown, (n) => { job.received += n; });
        renameSync(part, job.dest);
        try { writeFileSync(job.dest + '.etag', JSON.stringify({ size: totalKnown, etag: '' })); } catch { /* ignore */ }
        setJob(job, { status: 'done', received: totalKnown });
        try { onDone(job); } catch { /* ignore */ }
        return;
      }

      mkdirSync(dirname(job.dest), { recursive: true });
      const out = createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' });
      const src = r.body ? Readable.fromWeb(r.body) : null;
      if (src) {
        await new Promise((resolve, reject) => {
          src.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            job.received += buf.length;
            if (!out.write(buf)) { src.pause(); out.once('drain', () => src.resume()); }
          });
          src.on('end', resolve);
          src.on('error', reject);
        });
      }
      await new Promise((resolve) => { out.end(resolve); });
      if (!job.received && startAt === 0) throw new Error('empty-body');
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
   * 皮肤仍然能在自己的槽里立刻启动（全局 4 还有余量），而不是排在壁纸队列后面等。
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

  return { add, cancel, snapshot, pump, statePath, pathFor, jobFor };
}
