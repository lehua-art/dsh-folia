/**
 * routes/site-media.js — **站点远程媒体的本机缓存代理**：`/folia/site-media?u=<encoded>`。
 *
 * 为什么需要它：站点壁纸是 8～29 MB 的 4K 文件，浏览器每次都从网络重拉。切换到同一张时
 * 又是从零开始 —— 在弱网机器上这就是"点了要等好几秒"。缓存代理把第一次的字节留在本机，
 * 第二次起走磁盘（与"本机壁纸"同一条快路）。
 *
 * ## 设计红线：**缓存是加速器，永远不是必经路径**
 *
 * 任何一环不可用（目录不可写 / 超容量 / 上游 401、404、超时 / 非白名单），一律
 * **302 到原始 URL**。浏览器自己会跟过去 —— 用户看到的只是"没加速"，而不是"看不了"。
 * 这条不是防御性编程的洁癖：别人的机器可能有只读盘、C 盘快满、公司代理、跨境弱网，
 * 我们在自己机器上永远测不到这些组合。
 *
 * ## 五条防线（每条都有守卫，见 test/site-media-http.mjs）
 *
 *   ① 白名单 —— `u` 必须是 http(s)、host 与站点基址一致、路径落在 `/media/`、`/assets/`。
 *      否则本路由就是**开放代理**（SSRF / 带宽滥用）。
 *   ② 容量 + LRU —— 默认 2 GiB（`DSH_FOLIA_SITE_CACHE_MB` 可覆盖）；按 atime 淘汰。
 *   ③ 可写性 —— 首次使用时试写哨兵；失败即 `disabled`，此后全部 302。
 *   ④ 续传 —— `.part` + `.part.json`（url/etag/size）；同 URL 再取时用 Range 续，从头不再是默认。
 *   ⑤ 超时 + 并发 —— 首字节 8s 不到就放弃直连；同时最多 3 条上游大文件流（弱网不能自己打满）。
 *
 * 键 = `sha256(url)[:32] + 原扩展名`：站点重传会换 URL（文件名里带内容哈希），
 * 换 URL 即换键 ⇒ 天然不会把旧内容当成新内容。
 *
 * 注入契约（ADR-0013 D12）：`DEPS` 逐键由 `lib/index.js` 给到。
 */
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';
import { queueJobFor } from './downloads.js';
import { Readable } from 'node:stream';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { homedir } from 'node:os';

export const DEPS = ['disposers', 'base', 'serveFile', 'log'];

const DEFAULT_CAP_MB = 2048;
const FIRST_BYTE_TIMEOUT_MS = 8000;
const MAX_UPSTREAM_CONCURRENCY = 3;
const EXT_OK = new Set(['.mp4', '.webm', '.mov', '.m4v', '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

/** 站点基址（与其它路由同一口径：`DSH_FOLIA_SITE=off` 关站，缺省官方站点）。 */
function siteBase() {
  const raw = process.env.DSH_FOLIA_SITE;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return null;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'https://folia-5ve.pages.dev';
  return base.replace(/\/+$/, '');
}

function dshHome() {
  return process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
}

function cacheRoot() { return join(dshHome(), 'cache', 'site-media'); }

function capBytes() {
  const mb = Number(process.env.DSH_FOLIA_SITE_CACHE_MB || DEFAULT_CAP_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CAP_MB) * 1024 * 1024;
}

/** 白名单判定：同 host + 只认媒体/静态资源前缀。返回 null 表示拒绝（调用点回 400）。 */
function allowedTarget(raw, base) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let siteOrigin;
  try { siteOrigin = new URL(base); } catch { return null; }
  if (u.hostname !== siteOrigin.hostname) return null;
  if (!/^\/(media|assets)\//.test(u.pathname)) return null;
  return u;
}

function keyFor(u) {
  const h = createHash('sha256').update(u.toString()).digest('hex').slice(0, 32);
  const ext = extname(u.pathname).toLowerCase();
  return h + (EXT_OK.has(ext) ? ext : '.bin');
}

/**
 * 从"正在增长的文件"里按偏移读给客户端（**渐进读**）。
 *
 * 场景：下载队列正在把这条壁纸拉到本地（`<dest>.part`），播放器同时要播。
 * 与其再开一条上游连接（会抢带宽、还会被播放器背压拖成 0.6 MB/s），
 * 不如直接读这份正在长大的文件：队列按线路速度推进，读端有多少字节喂多少。
 *
 * 终止条件：读到 job 状态变成 done 且读到 total；或 job 失败/取消；或客户端断开。
 * 任何异常都只是提前结束响应，不抛出（不能让一次播放把进程搞崩）。
 */
async function serveGrowingFile(filePath, job, res, headOnly) {
  const openAt = () => { try { return openSync(filePath, 'r'); } catch { return -1; } };
  let fd = openAt();
  let offset = 0;
  let stalled = 0;
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  try {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('accept-ranges', 'none');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-folia-source', 'library');
    if (headOnly) { res.end(); return true; }
    const BUF = Buffer.alloc(256 * 1024);
    for (;;) {
      if (res.writableEnded) break;
      if (fd < 0) fd = openAt();
      let n = 0;
      if (fd >= 0) {
        try { n = readSync(fd, BUF, 0, BUF.length, offset); } catch { n = 0; }
      }
      if (n > 0) {
        offset += n;
        stalled = 0;
        const ok = res.write(BUF.subarray(0, n));
        if (!ok) await new Promise((r) => { res.once('drain', r); });
        continue;
      }
      // 暂时没有新字节：看队列是否还在推进
      const cur = typeof job.refresh === 'function' ? job.refresh() : job;
      if (cur && cur.status === 'done') {
        // 完成的瞬间 .part 会被 rename 掉；重新打开最终文件继续读完
        try { if (fd >= 0) closeSync(fd); } catch { /* ignore */ }
        fd = -1;
        if (offset >= (cur.total || 0)) break;
        filePath = cur.dest || filePath;
        continue;
      }
      if (cur && (cur.status === 'failed' || cur.status === 'cancelled')) break;
      stalled += 1;
      if (stalled > 600) break;               // ≈ 30 秒没有新字节就收尾（不无限挂着）
      await sleep(50);
    }
    res.end();
    return true;
  } catch {
    try { res.end(); } catch { /* ignore */ }
    return false;
  } finally {
    try { if (fd >= 0) closeSync(fd); } catch { /* ignore */ }
  }
}

/** 目录总量与最旧条目（LRU 用；只看本目录的常规文件，跳过分片）。 */
function scanCache(dir) {
  let total = 0;
  const entries = [];
  let names;
  try { names = readdirSync(dir); } catch { return { total, entries }; }
  for (const name of names) {
    if (name.endsWith('.part') || name.endsWith('.part.json')) continue;
    const abs = join(dir, name);
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      total += st.size;
      entries.push({ abs, size: st.size, at: st.atimeMs || st.mtimeMs || 0 });
    } catch { /* 竞态删除：跳过 */ }
  }
  entries.sort((a, b) => a.at - b.at);
  return { total, entries };
}

/** 超出上限就按 atime 淘汰最旧的，直到回到上限内。返回删掉的条数。 */
function evictToCap(dir, log) {
  const cap = capBytes();
  let { total, entries } = scanCache(dir);
  let removed = 0;
  for (const e of entries) {
    if (total <= cap) break;
    try { rmSync(e.abs, { force: true }); total -= e.size; removed += 1; } catch { /* ignore */ }
  }
  if (removed && typeof log === 'function') { try { log('site-media: LRU 淘汰 ' + removed + ' 条，剩余 ' + Math.round(total / 1048576) + ' MB'); } catch { /* ignore */ } }
  return removed;
}

/** 首次使用探一次可写性；失败即整族降级为"全部 302 直连"。 */
function probeWritable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const sentinel = join(dir, '.writable');
    writeFileSync(sentinel, '1');
    rmSync(sentinel, { force: true });
    return true;
  } catch { return false; }
}

function touch(abs) {
  try { const now = new Date(); utimesSync(abs, now, now); } catch { /* ignore */ }
}

function readPartMeta(part) {
  try { return JSON.parse(readFileSync(part + '.json', 'utf8')); } catch { return null; }
}

export function registerSiteMediaRoutes(webServer, c) {
  const { disposers, base, serveFile, log } = c;
  const BASE = base;
  /** key → 在途下载的 Promise（去重：同一 URL 并发只发一次上游）。 */
  const inflight = new Map();
  /** 在途上游大文件流的并发闸门。 */
  let active = 0;
  const waiters = [];
  /** 可写性按**目录**记忆：DSH_HOME 可能在运行期变（测试/多 profile），不能一次性缓存全局。 */
  const writableByDir = new Map();

  const ensureCache = (dir) => {
    const known = writableByDir.get(dir);
    if (known !== undefined) return known;
    const ok = probeWritable(dir);
    writableByDir.set(dir, ok);
    if (!ok && typeof log === 'function') {
      try { log('site-media: 缓存目录不可写，已降级为直连（功能不受影响，只是不加速）'); } catch { /* ignore */ }
    }
    return ok;
  };

  const acquire = () => new Promise((resolve) => {
    if (active < MAX_UPSTREAM_CONCURRENCY) { active += 1; resolve(); return; }
    waiters.push(() => { active += 1; resolve(); });
  });
  const release = () => {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  };

  /** 302 直连：缓存层所有失败路径的唯一出口。 */
  function redirect(res, target) {
    try {
      res.statusCode = 302;
      res.setHeader('location', target.toString());
      res.setHeader('cache-control', 'no-store');
      res.end();
    } catch { try { res.end(); } catch { /* ignore */ } }
  }

  /**
   * 把上游字节边转发边落盘。成功返回 true（文件已在盘上），失败返回 false（调用点 302）。
   * 已经给客户端发过头之后失败：只能 destroy 响应（这一条由 response 自己兜）。
   */
  async function download(u, key, req, res, headOnly) {
    const dir = cacheRoot();
    const abs = join(dir, key);
    const part = abs + '.part';
    const meta = readPartMeta(part);
    // 续传起点：只有 meta 明确记录的是同一个 URL 才续（换 URL 即换键，这里再兜一层）
    const from = (() => {
      try { return meta && meta.url === u.toString() && existsSync(part) ? statSync(part).size : 0; } catch { return 0; }
    })();

    await acquire();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    try {
      if (typeof setTimeout === 'function') {
        timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch { /* ignore */ } }, FIRST_BYTE_TIMEOUT_MS);
      }
      const headers = { accept: '*/*', 'user-agent': 'dsh-folia/site-media' };
      if (from > 0) headers.range = 'bytes=' + from + '-';
      const r = await fetch(u.toString(), { headers, signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' });
      if (timer) { clearTimeout(timer); timer = null; }
      if (!r.ok && r.status !== 206) return false;
      const ctype = r.headers.get('content-type') || 'application/octet-stream';
      // 续传时上游不支持 Range（回 200）⇒ 从头来过，别把两段接在一起。
      const startAt = r.status === 206 ? from : 0;
      if (startAt === 0 && existsSync(part)) { try { rmSync(part, { force: true }); } catch { /* ignore */ } }
      const total = Number(r.headers.get('content-length') || 0) + startAt;
      // ⚠️ **先落盘、后发头**：写盘失败（只读盘/满盘）必须还能 302 直连。
      // 旧顺序是先 setHeader 再写文件 —— 一旦写失败就已经 headersSent，只能 destroy，
      // 用户看到的是"白屏 + 200"而不是回退直连（实测踩过）。
      let out;
      try {
        writeFileSync(part + '.json', JSON.stringify({
          url: u.toString(), etag: r.headers.get('etag') || '', size: total || null, at: Date.now(),
        }));
        out = createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' });
      } catch {
        try { if (r.body && typeof r.body.cancel === 'function') r.body.cancel(); } catch { /* ignore */ }
        return false;
      }
      if (!headOnly) {
        res.statusCode = r.status === 206 ? 206 : 200;
        res.setHeader('content-type', ctype);
        res.setHeader('accept-ranges', 'bytes');
        if (total > 0) res.setHeader('content-length', String(total - startAt));
        if (r.status === 206) {
          const cr = r.headers.get('content-range');
          if (cr) res.setHeader('content-range', cr);
        }
        res.setHeader('cache-control', 'private, max-age=3600');
        // 可观测：这条是**首次下载**（未命中）。命中走上面 serveFile 的分支，头是 `hit`。
        res.setHeader('x-folia-cache', 'miss');
      }
      // ⚠️ 转发必须**带背压**：慢盘（机械盘 / 杀毒实时扫描）会让文件流 write() 返回 false，
      // 此时若继续把上游字节往内存里塞，轻则内存飙高、重则把整条流拖成"越下越慢"。
      // 旧实现只对文件流做 drain 等待、对客户端响应完全不看返回值 ⇒ 客户端慢时内存堆积。
      // 现在两侧都看：任一侧未排空就 pause 上游，两侧都 drain 后再 resume。
      let pendingFile = false;
      let pendingRes = false;
      const maybeResume = () => { if (!pendingFile && !pendingRes) { try { readerSrc.resume(); } catch { /* ignore */ } } };
      const readerSrc = r.body ? Readable.fromWeb(r.body) : null;
      let wrote = false;
      if (readerSrc) {
        await new Promise((resolveDone, rejectDone) => {
          readerSrc.on('data', (chunk) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            wrote = true;
            if (!out.write(buf)) {
              pendingFile = true;
              readerSrc.pause();
              out.once('drain', () => { pendingFile = false; maybeResume(); });
            }
            if (!headOnly && !res.writableEnded) {
              const flushed = (() => { try { return res.write(buf); } catch { return true; } })();
              if (!flushed) {
                pendingRes = true;
                readerSrc.pause();
                res.once('drain', () => { pendingRes = false; maybeResume(); });
              }
            }
          });
          readerSrc.on('end', resolveDone);
          readerSrc.on('error', rejectDone);
        });
      }
      await new Promise((resolveEnd) => { out.end(resolveEnd); });
      if (!wrote && startAt === 0) { try { rmSync(part, { force: true }); } catch { /* ignore */ } return false; }
      renameSync(part, abs);
      try { rmSync(part + '.json', { force: true }); } catch { /* ignore */ }
      if (!headOnly && !res.writableEnded) res.end();
      else if (!res.writableEnded) res.end();
      touch(abs);
      evictToCap(dir, log);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  }

  // ── 计数与统计：别的机器"慢"到底慢在哪，必须有可读的数字，而不是靠感觉 ──────────
  // hits/misses 区分"没缓存所以每次都要下"与"缓存生效但网络慢"；
  // bytes/ms 给出每次都真实吞吐；writable 说明那台机器的缓存目录到底能不能写。
  const stats = { hits: 0, misses: 0, bytes: 0, ms: 0, failures: 0, since: Date.now() };

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/site-media-stats`,
    handler: (req, res) => {
      let total = 0;
      let files = 0;
      try {
        const dir = cacheRoot();
        for (const name of readdirSync(dir)) {
          if (name.endsWith('.part') || name.endsWith('.part.json')) continue;
          try { total += statSync(join(dir, name)).size; files += 1; } catch { /* ignore */ }
        }
      } catch { /* 目录不存在即 0 */ }
      const dirRoot = cacheRoot();
      const body = JSON.stringify({
        ok: true,
        root: dirRoot,
        writable: ensureCache(dirRoot),
        files,
        bytesOnDisk: total,
        capBytes: capBytes(),
        hits: stats.hits,
        misses: stats.misses,
        failures: stats.failures,
        avgMBps: stats.ms > 0 ? Number(((stats.bytes / 1048576) / (stats.ms / 1000)).toFixed(2)) : null,
        uptimeSec: Math.round((Date.now() - stats.since) / 1000),
      });
      try {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      } catch { /* ignore */ }
    },
  }));

  disposers.push(webServer.register({
    kind: 'prefix',
    // 路径尾部只是给客户端留一个"像文件名"的段（客户端按 `url.split('/').pop()` 取 token 做
    // `/media-info` 查询；查不到就是"未知源"，不会报错）。真正的目标在 `?u=` 里。
    path: `${BASE}/site-media`,
    handler: async (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        try { res.statusCode = 405; res.setHeader('allow', 'GET, HEAD'); res.end(); } catch { /* ignore */ }
        return;
      }
      const base0 = siteBase();
      if (!base0) { try { res.statusCode = 404; res.end(); } catch { /* ignore */ } return; }
      const raw = (() => {
        try { return new URL(req.url || '', 'http://x').searchParams.get('u') || ''; } catch { return ''; }
      })();
      const u = allowedTarget(raw, base0);
      if (!u) { try { res.statusCode = 400; res.end(); } catch { /* ignore */ } return; }

      const headOnly = method === 'HEAD';
      const dir = cacheRoot();
      const key = keyFor(u);
      const abs = join(dir, key);

      // **单源复用**：如果下载队列已经在为这条 URL 拉文件（用户点它时入队的），
      // 就直接读那个**正在增长的本地文件**，不再开第二条上游连接。
      // 为什么重要：实测同一份字节被拉两遍（代理 0.6 MB/s + 队列 3.2 MB/s），
      // 互相抢带宽，缓存补全速度还不如只跑一条。复用后带宽只花一份，速度=线路速度。
      try {
        const job = queueJobFor(u.toString(), 'wallpaper');
        if (job && (job.status === 'done' || job.status === 'running')) {
          const partPath = job.status === 'done' ? job.dest : job.dest + '.part';
          if (existsSync(partPath)) {
            if (job.status === 'done') { try { res.setHeader('x-folia-cache', 'hit'); } catch { /* ignore */ } }
            await serveGrowingFile(partPath, job, res, headOnly);
            return;
          }
        }
      } catch { /* 复用失败就照旧走远端流式 */ }

      if (ensureCache(dir) && existsSync(abs)) {
        stats.hits += 1;
        touch(abs);
        // 与 miss 对称的可观测头：页签/诊断据此区分"网络慢"与"我们没有缓存"。
        try { res.setHeader('x-folia-cache', 'hit'); } catch { /* ignore */ }
        serveFile(abs, req, res, headOnly);
        return;
      }
      // 缓存不可用 / 未命中：交给 302 或边下边播
      if (!ensureCache(dir) || headOnly) { redirect(res, u); return; }
      const running = inflight.get(key);
      if (running) {
        // 同一 URL 已在下载：等它落盘（上限 60s），成功就发文件，否则直连。
        const ok = await Promise.race([running, new Promise((r) => setTimeout(() => r(false), 60000))]);
        if (ok && existsSync(abs)) { touch(abs); serveFile(abs, req, res, headOnly); return; }
        redirect(res, u);
        return;
      }
      stats.misses += 1;
      const t0 = Date.now();
      const task = download(u, key, req, res, headOnly).then((ok) => {
        stats.ms += Date.now() - t0;
        if (ok) { try { stats.bytes += statSync(abs).size; } catch { /* ignore */ } }
        return ok;
      }).catch((e) => { stats.failures += 1; throw e; });
      inflight.set(key, task);
      let ok = false;
      try { ok = await task; } finally { inflight.delete(key); }
      if (!ok) {
        // 下载失败：**必须**回退到直连（缓存是加速器，不是必经路径）
        if (!res.headersSent) redirect(res, u);
        else { try { res.destroy(); } catch { /* ignore */ } }
      }
    },
  }));
}
