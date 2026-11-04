/**
 * bench-chain.mjs — 下载链路的**性能基准**（输出数字，**不进**门禁）。
 *
 * 为什么单列一个脚本而不进守卫链：基准会随机器、负载、杀软扫描波动，把它做成"必须 < X ms"
 * 的判据只会得到一条时红时绿的假门禁。这里只负责**如实出数字**，让"这次改了以后是快了还是慢了"
 * 有据可查（三次取中位数，减少抖动）。判据在 `test/verify-download-chain.mjs`（场景/结构/降级），
 * 两者分工：那边管"对不对"，这边管"快不快"。
 *
 * 五项：
 *   ① 原画（6 MB / 满速）          —— 下载耗时 + 吞吐
 *   ② 1080p 变体（1.5 MB / 满速）   —— 与 ① 的省流量/耗时对比
 *   ③ 单流（1.2 MB / 每连接 0.6 MB/s，`DSH_FOLIA_RANGED=0`）
 *   ④ 多连接 8 路（同一文件，`DSH_FOLIA_RANGED=1`）—— ③ vs ④ 的吞吐倍数
 *   ⑤ library 命中（同一 URL 第二次入队）—— 期望 <10 ms 级、**0 次网络请求**
 *
 * Usage: `node scripts/bench-chain.mjs`（约 10–20 秒）
 */
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDownloadQueue } from '../lib/download-queue.js';

const MB = 1048576;
const ROUNDS = 3;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/* ── 假站点：支持 Range，可选**每连接**限速 ─────────────────────────────────── */
const RATE = { bpsPerConn: 0 };
const HITS = { total: 0, range: 0 };
const BODIES = new Map([
  ['/media/original.mp4', Buffer.alloc(6 * MB, 3)],
  ['/media/variant-1080.mp4', Buffer.alloc(Math.round(1.5 * MB), 7)],
  // 单流 vs 多连接要 ≥ `RANGED_MIN_BYTES`（8 MB，见 lib/download-queue.js）才允许强制多连接。
  ['/media/mid.mp4', Buffer.alloc(9 * MB, 5)],
]);
const server = createServer((req, res) => {
  const buf = BODIES.get(String(req.url || ''));
  if (!buf) { res.statusCode = 404; res.end('nope'); return; }
  HITS.total += 1;
  const range = String(req.headers.range || '');
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  let start = 0;
  let end = buf.length - 1;
  if (m) { HITS.range += 1; start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), buf.length - 1); }
  const body = buf.subarray(start, end + 1);
  res.statusCode = m ? 206 : 200;
  res.setHeader('content-type', 'video/mp4');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-length', String(body.length));
  if (m) res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + buf.length);
  if (req.method === 'HEAD') { res.end(); return; }
  if (!RATE.bpsPerConn) { res.end(body); return; }
  const chunk = Math.max(1, Math.round(RATE.bpsPerConn / 10));
  let off = 0;
  let closed = false;
  req.on('close', () => { closed = true; });
  const tick = () => {
    if (closed) return;
    if (off >= body.length) { try { res.end(); } catch { /* ignore */ } return; }
    const slice = body.subarray(off, off + chunk);
    off += slice.length;
    try { res.write(slice); } catch { closed = true; return; }
    setTimeout(tick, 100);
  };
  tick();
});
await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
const addr = server.address();
const site = 'http://127.0.0.1:' + (addr && typeof addr === 'object' ? addr.port : 0);
const home = mkdtempSync(join(tmpdir(), 'folia-bench-'));

/** 跑一次下载，返回 { ms, bytes, mode, ok }。每次都用一个干净的队列表目录（互不影响）。 */
async function once(path, tag, rangedEnv) {
  const prevRanged = process.env.DSH_FOLIA_RANGED;
  if (rangedEnv == null) delete process.env.DSH_FOLIA_RANGED;
  else process.env.DSH_FOLIA_RANGED = rangedEnv;
  const dir = join(home, tag + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  const q = createDownloadQueue({ home: dir, log: () => {} });
  const dest = join(dir, 'lib', 'file.bin');
  const t0 = process.hrtime.bigint();
  q.add({ url: site + path, dest, kind: 'wallpaper', priority: 'high' });
  let job = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    job = q.snapshot()[0] || null;
    if (job && job.status !== 'queued' && job.status !== 'running') break;
    await sleep(10);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (prevRanged == null) delete process.env.DSH_FOLIA_RANGED;
  else process.env.DSH_FOLIA_RANGED = prevRanged;
  return { ms, bytes: (job && job.received) || 0, mode: (job && job.mode) || '?', ok: Boolean(job && job.status === 'done') };
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

async function bench(label, path, tag, rangedEnv, rateBps) {
  const runs = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    RATE.bpsPerConn = rateBps || 0;
    runs.push(await once(path, tag + '-' + i, rangedEnv));
  }
  RATE.bpsPerConn = 0;
  const ms = median(runs.map((r) => r.ms));
  const bytes = runs[0].bytes;
  const mode = runs[0].mode;
  const allOk = runs.every((r) => r.ok);
  return {
    label, mode, ok: allOk, bytes,
    ms: Math.round(ms),
    mbps: Number((bytes / 1048576 / (ms / 1000)).toFixed(2)),
  };
}

const rows = [];
rows.push(await bench('原画 6 MB（满速）', '/media/original.mp4', 'orig', null, 0));
rows.push(await bench('1080p 1.5 MB（满速）', '/media/variant-1080.mp4', 'v1080', null, 0));
// 单流 vs 多连接用**强制**模式（`DSH_FOLIA_RANGED=0|1`）量"同一文件两种跑法的差距"；
// "什么时候**该**切多连接"（3 秒实测自适应）由 test/verify-download-chain.mjs 场景 2 判。
// 文件 9 MB（≥ RANGED_MIN_BYTES=8 MB）、每连接 8 MB/s ⇒ 单流约 1.1 s，多连接约 0.2 s。
rows.push(await bench('单流 9 MB（每连接 8 MB/s）', '/media/mid.mp4', 'single', '0', 8 * MB));
rows.push(await bench('多连接 8 路 9 MB（每连接 8 MB/s）', '/media/mid.mp4', 'ranged', '1', 8 * MB));

// ⑤ library 命中：同一个 URL 第二次入队（同一个队列实例，文件已在盘上）
const hitDir = join(home, 'hit');
mkdirSync(join(hitDir, 'lib'), { recursive: true });
const hq = createDownloadQueue({ home: hitDir, log: () => {} });
const hdest = join(hitDir, 'lib', 'hit.bin');
hq.add({ url: site + '/media/original.mp4', dest: hdest, kind: 'wallpaper' });
for (let i = 0; i < 3000; i += 1) {
  const j = hq.snapshot()[0];
  if (j && j.status === 'done') break;
  await sleep(10);
}
const hitRuns = [];
for (let i = 0; i < ROUNDS; i += 1) {
  const before = HITS.total;
  const t0 = process.hrtime.bigint();
  const r = hq.add({ url: site + '/media/original.mp4', dest: hdest, kind: 'wallpaper' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  await sleep(50);
  hitRuns.push({ ms, net: HITS.total - before, existed: Boolean(r && r.existed) });
}
rows.push({
  label: 'library 命中（同 URL 第二次）', mode: hitRuns[0].existed ? 'existed' : '?', ok: hitRuns.every((h) => h.net === 0),
  bytes: 0, ms: Math.round(median(hitRuns.map((h) => h.ms))), mbps: 0,
});

/* ── 输出表格 ───────────────────────────────────────────────────────────────── */
const pad = (s, n) => String(s).padEnd(n, ' ');
process.stdout.write('\n  ' + pad('场景', 40) + pad('模式', 12) + pad('中位耗时', 12) + pad('吞吐', 12) + '结果\n');
process.stdout.write('  ' + '-'.repeat(84) + '\n');
for (const r of rows) {
  process.stdout.write('  ' + pad(r.label, 40) + pad(r.mode, 12) + pad(r.ms + ' ms', 12)
    + pad(r.mbps ? r.mbps + ' MB/s' : '—', 12) + (r.ok ? 'ok' : 'FAIL') + '\n');
}
const single = rows.find((r) => r.label.startsWith('单流'));
const ranged = rows.find((r) => r.label.startsWith('多连接'));
const speedup = single && ranged && single.mbps ? Number((ranged.mbps / single.mbps).toFixed(2)) : 0;
const hit = rows.find((r) => r.label.startsWith('library'));
const orig = rows.find((r) => r.label.startsWith('原画'));
const v1080 = rows.find((r) => r.label.startsWith('1080p'));
process.stdout.write('\n  多连接 / 单流 吞吐比：' + speedup + '×\n');
if (orig && v1080) {
  process.stdout.write('  1080p / 原画 体积比：' + Math.round((v1080.bytes / orig.bytes) * 100) + '% · 耗时比：'
    + Math.round((v1080.ms / orig.ms) * 100) + '%\n');
}
process.stdout.write('  library 命中：' + (hit ? hit.ms + ' ms（' + (hit.ok ? '0 次网络请求' : '有网络请求') + '）' : 'n/a') + '\n');
process.stdout.write('  （每行 = ' + ROUNDS + ' 次取中位数；机器/负载不同数字会变，只用于横向对比同一台机器上的改动前后）\n\n');
try { server.close(); } catch { /* ignore */ }
process.exit(rows.every((r) => r.ok) ? 0 : 1);
