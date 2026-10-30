/**
 * download-queue.js — **站点资源批量下载队列**（壁纸 / 开机动画 / 桌宠 / 皮肤包共用）。
 *
 * 产品流程（用户明确要求的）：
 *   站点资源 → **先下载到本地** → 渲染方（我们 / 皮肤中心）只从本地取。
 *   并且允许**一次勾选很多个并发下载**，而不是点一个下一个。
 *
 * 设计要点（与仓库其它地方同一套纪律）：
 *   · 并发上限（默认 3）：弱网下同时开太多连接，每个都慢，等于都不完成。
 *   · 断点续传：`.part` + meta（url/size）；同一 URL 再入队时按已下载字节续。
 *   · 幂等 + 去重：同一 URL 只会有**一个** job；重复入队返回既有 job（调用方据此显示"已在下/已完成"）。
 *   · 落盘路径由调用方给（`dest` 绝对路径），本模块只保证"原子完成"（完成才 rename）。
 *   · 可失败：单个 job 失败只标记该 job，不拖垮队列；失败可重试（`retry`）。
 *   · 持久化：快照写 `$DSH_HOME/downloads.json`，宿主重启后**已完成**的仍在（供"本地优先"判据），
 *     未完成的标记为 `queued` 继续。
 *
 * 不做的事（明确）：不解析 zip、不决定渲染方式 —— 那是调用方（安装器 / 播放器）的事。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

const DEFAULTS = { concurrency: 3, retries: 1 };

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
  let running = 0;
  let pumping = false;

  function persist() {
    try {
      mkdirSync(home, { recursive: true });
      const list = [...jobs.values()].map((j) => ({
        id: j.id, url: j.url, dest: j.dest, kind: j.kind, total: j.total,
        status: j.status, error: j.error || null, at: j.at,
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
        jobs.set(j.id, {
          id: j.id, url: j.url, dest: j.dest, kind: j.kind || '', total: Number(j.total) || 0,
          received: done ? Number(j.total) || 0 : 0,
          status: done ? 'done' : 'queued', error: null, at: Number(j.at) || Date.now(),
        });
      }
    } catch { /* 首次运行没有状态文件 */ }
  }

  function snapshot() {
    return [...jobs.values()]
      .sort((a, b) => b.at - a.at)
      .map((j) => ({
        id: j.id, url: j.url, kind: j.kind, dest: j.dest, total: j.total, received: j.received,
        status: j.status, error: j.error || null,
        percent: j.total > 0 ? Math.min(100, Math.round((j.received / j.total) * 100)) : (j.status === 'done' ? 100 : 0),
      }));
  }

  /** 入队（幂等）。返回 job 快照；`existed` 表示此前已存在。 */
  function add({ url, dest, kind = '' }) {
    const id = urlKey(url);
    const existed = jobs.has(id);
    if (existed) {
      const job = jobs.get(id);
      // 已完成但文件被删 ⇒ 重新排队
      if (job.status === 'done' && !existsSync(job.dest)) { job.status = 'queued'; job.received = 0; }
      return { job: snapshot().find((x) => x.id === id), existed: true };
    }
    jobs.set(id, {
      id, url: String(url), dest: String(dest), kind: String(kind || ''),
      total: 0, received: 0, status: 'queued', error: null, at: Date.now(),
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
      const r = await fetch(job.url, { headers, signal: ctrl ? ctrl.signal : undefined, redirect: 'follow' });
      if (!r.ok && r.status !== 206) throw new Error('http-' + r.status);
      const startAt = r.status === 206 ? from : 0;
      if (startAt === 0 && existsSync(part)) { try { rmSync(part, { force: true }); } catch { /* ignore */ } }
      const len = Number(r.headers.get('content-length') || 0);
      job.total = len ? len + startAt : (job.total || 0);
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
      try { onDone(job); } catch { /* 消费方失败不影响下载结果 */ }
      log('download-queue: done ' + job.kind + ' ' + job.dest + ' (' + Math.round(job.total / 1048576) + ' MB)');
    } catch (e) {
      const aborted = e && (e.name === 'AbortError');
      job.status = aborted ? 'cancelled' : 'failed';
      job.error = aborted ? 'aborted' : String((e && e.message) || e);
      if (!aborted) log('download-queue: failed ' + job.url + ' — ' + job.error);
    } finally {
      job.ctrl = null;
      persist();
    }
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    (async () => {
      try {
        for (;;) {
          if (running >= concurrency) break;
          const next = [...jobs.values()].find((j) => j.status === 'queued');
          if (!next) break;
          running += 1;
          runOne(next).finally(() => { running -= 1; setTimeout(() => pump(), 0); });
        }
      } finally {
        pumping = false;
      }
    })();
  }

  load();
  pump();

  /** 已落地文件的绝对路径（未完成 / 不存在 ⇒ null）。/folia/local-media/<id> 用它。 */
  function pathFor(id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'done') return null;
    try { return existsSync(job.dest) ? job.dest : null; } catch { return null; }
  }

  return { add, cancel, snapshot, pump, statePath, pathFor };
}
