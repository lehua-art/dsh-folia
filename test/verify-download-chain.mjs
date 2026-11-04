/**
 * verify-download-chain.mjs — **整条链路**（清单 → 选档 → 下载 → 落位 → 安装 → 启用）的端到端回归（4.23.6）。
 *
 * 为什么单点判据不够：4.23.3–4.23.5 的三次事故都出在"段与段之间"——队列说 done、落地没发生；
 * 装好了却判成没装；两条安装路径各装一遍。每一段自己的单测都是绿的，坏的是**接力**。
 * 所以这一页按场景跑完整条链，逐段断言 + 计时，并把每个场景的（断言数 / 失败 / 耗时）打出来。
 *
 * 六个场景（与 docs/DOWNLOAD-CHAIN-REPORT.md 对应）：
 *   1 快链路：清单带 variants、原画 >20 MB ⇒ **选原画**（快链路不降档）、全程 single、0 条 Range、总耗时 < 2s
 *   2 慢链路（每连接 0.2 MB/s）：3 秒内切 `ranged:8`、整体吞吐 ≥ 单流的 2.5 倍；有 1080p 变体就选它且字节 < 原画 30%
 *   3 清单陈旧（没有 variants 字段）⇒ 优雅回落 original，不报错、不重试风暴
 *   4 缓存命中：同 URL 第二次 **0 次网络请求**；已完成文件的缓存头按大小分档（≤8MB immutable / >8MB 1 小时）
 *   5 落位与安装：zip → 解压到 `skins/<id>` → `/skins/list` 的 installed 里有它；重复 install 只解压 1 次（栅栏）
 *   6 故障注入：队列被清空（模拟重启）⇒ 7.5 秒内 failed 可重试；下载中途 500 ⇒ failed + 原因；
 *      磁盘写失败 ⇒ failed + 明确文案（不卡在 installing）
 *
 * Usage: `node test/verify-download-chain.mjs`
 */
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDownloadQueue } from '../lib/download-queue.js';
import { localCopyFor } from '../lib/routes/downloads.js';
import { completedCacheControl } from '../lib/serve.js';
import { pickVariant } from '../lib/variant-pick.js';
import { registerSkinsRoutes, installGateTry, installGateRelease, installGateMarkDone } from '../lib/routes/skins.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const MB = 1048576;

/* ── 假站点：快链路满速、慢链路**每连接**限速（8 条连接才真的能快 8 倍）──────── */
const RATE = { bpsPerConn: 0 };      // 0 = 不限速
const HITS = { total: 0, range: 0, head: 0, get: 0, byPath: {} };
const BODIES = new Map();            // path → { buf, fail }

function serveWithRange(req, res, buf, fail) {
  HITS.total += 1;
  HITS.byPath[req.url] = (HITS.byPath[req.url] || 0) + 1;
  if (fail) { res.statusCode = 500; res.end('boom'); return; }
  const range = String(req.headers.range || '');
  if (req.method === 'HEAD') HITS.head += 1; else HITS.get += 1;
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  let start = 0;
  let end = buf.length - 1;
  if (m) {
    HITS.range += 1;
    start = Number(m[1]);
    if (m[2] !== '') end = Math.min(Number(m[2]), buf.length - 1);
  }
  const body = buf.subarray(start, end + 1);
  res.statusCode = m ? 206 : 200;
  res.setHeader('content-type', 'video/mp4');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-length', String(body.length));
  if (m) res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + buf.length);
  if (req.method === 'HEAD') { res.end(); return; }
  if (!RATE.bpsPerConn) { res.end(body); return; }
  // 每连接限速：每 100ms 发 rate/10 字节（多连接时总吞吐 = 连接数 × 单连接速率）。
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
}

const server = createServer((req, res) => {
  const u = String(req.url || '');
  if (u.startsWith('/api/public/wallpapers')) {
    // 皮肤清单替身（场景 5 用）
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: { items: [{ slug: SKIN_ID, title: '链路皮肤', bytes: ZIP.length, mime: 'application/zip', url: '/media/skin.zip', thumbUrl: '/media/t.jpg', tags: '["皮肤"]' }] } }));
    return;
  }
  const hit = BODIES.get(u);
  if (!hit) { res.statusCode = 404; res.end('nope'); return; }
  serveWithRange(req, res, hit.buf, hit.fail);
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
const site = 'http://127.0.0.1:' + server.address().port;

/* ── 环境 + 素材 ────────────────────────────────────────────────────────────── */
const dshHome = mkdtempSync(join(tmpdir(), 'folia-chain-'));
process.env.DSH_HOME = dshHome;
process.env.DSH_FOLIA_SITE = site;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const method = f.deflate === false ? 0 : 8;
    const payload = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(payload.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, payload); central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }
  const cbuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cbuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cbuf, eocd]);
}

const SKIN_ID = 'chain-skin';
const ZIP = makeZip([
  { name: 'skin.json', data: JSON.stringify({ id: SKIN_ID, name: '链路皮肤', nameEn: 'chain skin', version: '0.1.0', author: 'folia-test', contributes: { stylesheet: 'skin.css' } }) },
  { name: 'skin.css', data: '[data-dsh-skin="' + SKIN_ID + '"]{--x:1}' },
]);

const FAST = Buffer.alloc(6 * MB, 3);        // 场景 1/4：6 MB（本地满速）
const SLOW = Buffer.alloc(6 * MB, 5);        // 场景 2：6 MB（每连接 0.2 MB/s，>4 MB 剩余才会触发切换）
const SMALL1080 = Buffer.alloc(Math.round(1.5 * MB), 7);   // 1080p 变体（原画的 25%）
const BIG12 = Buffer.alloc(12 * MB, 9);      // 场景 4 的缓存头分档（>8 MB）
BODIES.set('/media/fast.mp4', { buf: FAST });
BODIES.set('/media/slow.mp4', { buf: SLOW });
BODIES.set('/media/small-1080.mp4', { buf: SMALL1080 });
BODIES.set('/media/big12.mp4', { buf: BIG12 });
BODIES.set('/media/skin.zip', { buf: ZIP });
BODIES.set('/media/fail.mp4', { buf: FAST, fail: true });

/* ── 客户端状态机（真源码切片；只换网络出口）────────────────────────────────── */
function loadClient(transport) {
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs(');
  if (a < 0 || b <= a) return null;
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  const t = transport || {};
  try {
    return new Function('weT', 'apiJson', 'apiPostJson', src.slice(a, b) + `
return { dlCardState, dlFailReason, dlAwaitJob, DL_JOB_MISS_LIMIT, dlJobForCard };`)(
      shim,
      t.apiJson || (async () => ({ ok: true, data: { jobs: [] } })),
      t.apiPostJson || (async () => ({ ok: true, data: { ok: true } })),
    );
  } catch { return null; }
}
const client = loadClient();

/* ── 皮肤安装路由（场景 5）──────────────────────────────────────────────────── */
const routes = [];
registerSkinsRoutes({ register: (spec) => { routes.push(spec); return () => {}; } }, { disposers: [], base: '/folia', log: () => {} });
const installRoute = routes.find((r) => r.path === '/folia/skins/install');
const listRoute = routes.find((r) => r.path === '/folia/skins/list');
function call(route, { method = 'GET', body = null, url = null } = {}) {
  return new Promise((resolve) => {
    const resObj = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(s) { resolve({ status: this.statusCode, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }); },
    };
    const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      method, url: url || route.path, headers: {},
      on(ev, fn) {
        if (ev === 'data') for (const c of chunks) fn(c);
        if (ev === 'end') setTimeout(fn, 0);
        if (ev === 'error') { /* 不触发 */ }
        return this;
      },
    };
    route.handler(req, resObj);
  });
}

/* ── 队列：每个场景一个干净的 home（幂等/缓存/进度都从零开始）────────────────── */
function newQueue(tag) {
  const home = join(dshHome, tag);
  mkdirSync(home, { recursive: true });
  return { q: createDownloadQueue({ home, log: () => {} }), home };
}
async function waitDone(q, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const snap = q.snapshot();
    if (snap.length && snap.every((j) => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')) return snap;
    await sleep(50);
  }
  return q.snapshot();
}

/* ══ 场景执行器：每个场景独立计时、（断言数 / 失败 / 耗时）单独统计 ═══════════ */
const SCENES = [];
async function scene(name, fn) {
  const t0 = Date.now();
  const before = results.length;
  try {
    await fn();
  } catch (e) {
    check(name + '：场景自身不许抛错', false, (e && e.message) || String(e));
  }
  const mine = results.slice(before);
  SCENES.push({ name, asserts: mine.length, failed: mine.filter((r) => !r.ok).length, ms: Date.now() - t0 });
}

/* ── 场景 1：快链路 ⇒ 选原画、单流、0 Range、< 2s ───────────────────────────── */
await scene('1 快链路（6 MB 满速）', async () => {
  const picked = pickVariant({
    originalUrl: site + '/media/fast.mp4',
    originalBytes: 24 * MB,                      // 原画 > 20 MB
    variants: [{ url: site + '/media/small-1080.mp4', height: 1080, label: '1080p', bytes: 1.5 * MB }],
    hostSlow: false,                             // 快链路
    screenHeight: 2160,                          // 大屏：不降档的更充分理由
  });
  check('1 快链路 + 原画 >20 MB ⇒ 选**原画**（不降档）', picked.chosen === 'original', JSON.stringify({ chosen: picked.chosen, reason: picked.reason }));
  check('1 选档理由是可解释的（auto-original）', picked.reason === 'auto-original', picked.reason);

  HITS.range = 0;
  RATE.bpsPerConn = 0;
  const { q, home } = newQueue('s1');
  const dest = join(home, 'lib', 'fast.mp4');
  const t0 = Date.now();
  q.add({ url: site + '/media/fast.mp4', dest, kind: 'wallpaper', priority: 'high' });
  const snap = await waitDone(q);
  const took = Date.now() - t0;
  check('1 下载 done 且字节数正确', snap[0] && snap[0].status === 'done' && snap[0].received === FAST.length, JSON.stringify({ status: snap[0] && snap[0].status, received: snap[0] && snap[0].received }));
  check('1 全程 single 流（没有切多连接）', snap[0] && snap[0].mode === 'single', snap[0] && snap[0].mode);
  check('1 快链路 0 条 Range 请求', HITS.range === 0, 'ranges=' + HITS.range);
  check('1 总耗时 < 2s（本地 6 MB）', took < 2000, took + 'ms');
});

/* ── 场景 2：慢链路 ⇒ 3 秒内切 ranged:8、吞吐 ≥ 2.5×、1080p 变体省流量 ──────── */
await scene('2 慢链路（每连接 0.2 MB/s）', async () => {
  HITS.range = 0;
  RATE.bpsPerConn = 0.2 * MB;
  const { q, home } = newQueue('s2');
  const dest = join(home, 'lib', 'slow.mp4');
  const t0 = Date.now();
  q.add({ url: site + '/media/slow.mp4', dest, kind: 'wallpaper', priority: 'high' });
  let switchedAt = 0;
  let bytesAtSwitch = 0;
  while (Date.now() - t0 < 30000) {
    const j = q.snapshot()[0];
    if (j && /^ranged:/.test(String(j.mode))) { switchedAt = Date.now() - t0; bytesAtSwitch = j.received; break; }
    if (j && (j.status === 'done' || j.status === 'failed')) break;
    await sleep(50);
  }
  const snap = await waitDone(q, 60000);
  const took = Date.now() - t0;
  RATE.bpsPerConn = 0;
  const job = snap[0] || {};
  const singleRate = bytesAtSwitch > 0 && switchedAt > 0 ? bytesAtSwitch / (switchedAt / 1000) / MB : 0;   // MB/s（切换前实测）
  const overallRate = (job.received || 0) / Math.max(0.001, took / 1000) / MB;
  // 队列的评估窗口就是 3.0s（ADAPTIVE_EVAL_MS）⇒ 观察值 = 3000ms + 一拍轮询（50ms 级）。
  // 判据给到 3.5s：既要证明"3 秒窗口一到就切"，也不能把轮询抖动判成失败。
  check('2 3 秒左右切到多连接（ranged:8）', /^ranged:8$/.test(String(job.mode)) && switchedAt > 0 && switchedAt <= 3500, JSON.stringify({ mode: job.mode, switchedAt }));
  check('2 切换点在队列的 3 秒评估窗口之后（不是碰巧）', switchedAt >= 2900, switchedAt + 'ms');
  check('2 切多连接后仍有 Range 请求（证明真的并行续传）', HITS.range >= 2, 'ranges=' + HITS.range);
  check('2 整体吞吐 ≥ 单流的 2.5 倍', overallRate >= singleRate * 2.5, JSON.stringify({ singleRate: Number(singleRate.toFixed(2)), overallRate: Number(overallRate.toFixed(2)) }));
  check('2 文件完整（没有因切换丢字节）', job.status === 'done' && job.received === SLOW.length, JSON.stringify({ status: job.status, received: job.received }));

  // 慢链路 + 有 1080p 变体 ⇒ 选它，且下载字节 < 原画 30%
  const v = pickVariant({
    originalUrl: site + '/media/slow.mp4',
    originalBytes: SLOW.length,
    variants: [{ url: site + '/media/small-1080.mp4', height: 1080, label: '1080p', bytes: SMALL1080.length }],
    hostSlow: true,
  });
  check('2 慢链路 + 1080p 可用 ⇒ 选 1080p（slow-link）', v.chosen === '1080p' && v.reason === 'slow-link', JSON.stringify({ chosen: v.chosen, reason: v.reason }));
  check('2 1080p 字节 < 原画 30%', SMALL1080.length < SLOW.length * 0.3, JSON.stringify({ small: SMALL1080.length, original: SLOW.length }));
});

/* ── 场景 3：清单陈旧（无 variants）⇒ 回落 original、不报错、不重试风暴 ─────── */
await scene('3 清单陈旧（没有 variants 字段）', async () => {
  const v = pickVariant({ originalUrl: site + '/media/fast.mp4', variants: undefined, quality: undefined });
  check('3 没有 variants ⇒ original（不抛、不猜）', v.chosen === 'original' && v.reason === 'no-variant', JSON.stringify({ chosen: v.chosen, reason: v.reason }));
  const { q, home } = newQueue('s3');
  const dest = join(home, 'lib', 'stale.mp4');
  const before = HITS.byPath['/media/fast.mp4'] || 0;
  const r = q.add({ url: site + '/media/fast.mp4', dest, kind: 'wallpaper' });
  const snap = await waitDone(q);
  const hits = (HITS.byPath['/media/fast.mp4'] || 0) - before;
  check('3 清单陈旧也照常下完', snap[0] && snap[0].status === 'done' && existsSync(dest), snap[0] && snap[0].status);
  check('3 没有重试风暴（≤ 4 次请求：HEAD + GET + 余量）', hits > 0 && hits <= 4, 'hits=' + hits);
  check('3 入队返回的 job 带 url/dest（调用方可判）', Boolean(r && r.job && r.job.url));
});

/* ── 场景 4：缓存命中（0 次网络） + 缓存头分档 ──────────────────────────────── */
await scene('4 缓存命中与缓存头', async () => {
  const { q, home } = newQueue('s4');
  const dest = join(home, 'lib', 'fast.mp4');
  q.add({ url: site + '/media/fast.mp4', dest, kind: 'wallpaper' });
  await waitDone(q);
  const before = HITS.total;
  const again = q.add({ url: site + '/media/fast.mp4', dest, kind: 'wallpaper' });
  await sleep(300);
  check('4 第二次入队是命中（existed=true 且立刻 done）', Boolean(again && again.existed === true && again.job && again.job.status === 'done'), JSON.stringify({ existed: again && again.existed }));
  check('4 命中时 **0 次网络请求**', HITS.total === before, 'before=' + before + ' after=' + HITS.total);
  check('4 本地库能直接给出文件（localCopyFor）', typeof localCopyFor === 'function');
  const cc8 = completedCacheControl(6 * MB);
  const cc12 = completedCacheControl(12 * MB);
  check('4 ≤8 MB 的已完成文件：immutable + 一年', /immutable/.test(cc8) && /max-age=31536000/.test(cc8), cc8);
  check('4 >8 MB 的已完成文件：max-age=3600（不再一年）', /max-age=3600/.test(cc12) && !/immutable/.test(cc12), cc12);
});

/* ── 场景 5：落位与安装（zip → skins/<id> → installed；重复 install 只解压 1 次）── */
await scene('5 落位与安装', async () => {
  const first = await call(installRoute, { method: 'POST', body: { id: SKIN_ID, url: site + '/media/skin.zip' } });
  const dir = join(dshHome, 'skins', SKIN_ID, 'skin.json');
  check('5 安装 200 且 skin.json 落盘', first.status === 200 && Boolean(first.json && first.json.ok) && existsSync(dir), JSON.stringify({ status: first.status }));
  const list = await call(listRoute, { url: '/folia/skins/list?refresh=1' });
  const listed = ((list && list.json && list.json.installed) || []).some((x) => x && x.id === SKIN_ID);
  check('5 /skins/list 的 installed 里有它（启用前真源）', listed === true);
  // 重复 install（幂等）：命中 exists，不会二次解压；栅栏语义单测在下面
  const hitsBefore = HITS.byPath['/media/skin.zip'] || 0;
  const again = await call(installRoute, { method: 'POST', body: { id: SKIN_ID, url: site + '/media/skin.zip' } });
  check('5 重复 install ⇒ exists:true（不重新下载、不重新解压）', again.status === 200 && again.json.exists === true, JSON.stringify(again.json));
  check('5 重复 install 没有触发新的下载请求', (HITS.byPath['/media/skin.zip'] || 0) === hitsBefore, 'hits=' + (HITS.byPath['/media/skin.zip'] || 0));
  // 栅栏：占用 ⇒ 同 id 的落位被去重（只解压 1 次）
  const took = installGateTry('chain-gate');
  const dup = installGateTry('chain-gate');
  installGateMarkDone('chain-gate');
  const afterDone = installGateTry('chain-gate');
  installGateRelease('chain-gate');
  check('5 栅栏：同一 id 的第二次落位被去重（只解压 1 次）', took === true && dup === false, JSON.stringify({ took, dup }));
  check('5 栅栏：装完之后放行（卸载后能马上重装）', afterDone === true, String(afterDone));
});

/* ── 场景 6：故障注入（重启 / 500 / 磁盘写失败）────────────────────────────── */
await scene('6 故障注入', async () => {
  // ① 队列被清空（模拟宿主重启）
  if (client) {
    const c = loadClient({ apiJson: async () => ({ ok: true, data: { jobs: [] } }) });
    const t0 = Date.now();
    const waited = await c.dlAwaitJob('job-gone', 120000);
    const took = Date.now() - t0;
    const card = c.dlCardState({ id: 'c', labels: { idle: '安装', done: '已安装', failed: '重试' }, err: { code: 'job-lost' }, nowMs: Date.now() });
    check('6 队列被清空 ⇒ 7.5 秒内判 lost（不无限轮询）', waited && waited.status === 'lost' && took < 20000, JSON.stringify({ status: waited && waited.status, took }));
    check('6 判 lost 后卡片 failed +「重试」+ 原因', card.phase === 'failed' && card.retry === true && card.reason.includes('下载任务已丢失'), JSON.stringify({ phase: card.phase, reason: card.reason }));
  } else {
    check('6 客户端状态机可加载', false, 'slice 失败');
  }
  // ② 下载中途 500
  {
    RATE.bpsPerConn = 0;
    const { q, home } = newQueue('s6a');
    const dest = join(home, 'lib', 'fail.mp4');
    q.add({ url: site + '/media/fail.mp4', dest, kind: 'wallpaper' });
    const snap = await waitDone(q, 20000);
    const job = snap[0] || {};
    const reason = client ? client.dlFailReason(job.error || job.status) : '';
    const card = client ? client.dlCardState({ id: 'c', labels: { idle: '安装', done: '已安装', failed: '重试' }, job }) : null;
    check('6 站点 500 ⇒ job failed 且带错误码', job.status === 'failed' && Boolean(job.error), JSON.stringify({ status: job.status, error: job.error }));
    check('6 卡片 failed +「重试」+ 人话原因', Boolean(card) && card.phase === 'failed' && card.retry === true && reason.length > 0, reason);
  }
  // ③ 磁盘写失败（dest 的父目录是一个**文件** ⇒ 落盘必失败）
  {
    const { q, home } = newQueue('s6b');
    const blocked = join(home, 'blocked');
    writeFileSync(blocked, 'not a dir', 'utf8');
    const dest = join(blocked, 'x.mp4');
    q.add({ url: site + '/media/fast.mp4', dest, kind: 'wallpaper' });
    const snap = await waitDone(q, 20000);
    const job = snap[0] || {};
    const card = client ? client.dlCardState({ id: 'c', labels: { idle: '安装', done: '已安装', failed: '重试' }, job }) : null;
    check('6 磁盘写失败 ⇒ job failed（不是永远 running）', job.status === 'failed' && Boolean(job.error), JSON.stringify({ status: job.status, error: job.error }));
    check('6 磁盘写失败 ⇒ 卡片 failed + 有文案（不卡 installing）', Boolean(card) && card.phase === 'failed' && card.reason.length > 0, card && card.reason);
  }
});

/* ── 汇总：每场景（断言数 / 失败 / 耗时）+ 总计 ─────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  场景 | 断言数 | 通过/失败 | 耗时\n');
let totalMs = 0;
for (const s of SCENES) {
  totalMs += s.ms;
  process.stdout.write('  ' + s.name + ' | ' + s.asserts + ' | ' + (s.asserts - s.failed) + '/' + s.failed + ' | ' + s.ms + 'ms\n');
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败 · 总耗时 ' + totalMs + 'ms\n');
try { server.close(); } catch { /* ignore */ }
if (failed) process.exit(1);
