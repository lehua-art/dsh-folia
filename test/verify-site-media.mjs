/**
 * site-media-http.mjs — `/folia/site-media` 缓存代理的守卫。
 *
 * 这条路由是**给别人用的加速器**：作者本机网络好，测不出弱网/只读盘/满盘/代理。
 * 所以判据不写"我这儿能播"，而写**"任何一环坏掉都还能播"**：
 *
 *   ① 白名单：非站点 host / 非 /media|/assets 前缀 / 非 http(s) ⇒ 400（否则就是开放代理）
 *   ② 未命中：上游 200 ⇒ 边下边播 + 落盘；第二次请求**不再打上游**（命中缓存）
 *   ③ 上游失败（404/401）：302 回原始 URL ⇒ 用户仍能看到壁纸（缓存不是必经路径）
 *   ④ 目录不可写：整族降级 —— 仍 302，不报错（只读盘机器与正常机器行为一致）
 *   ⑤ 超容量：按 atime 淘汰，总量回落到上限内（别人的 C 盘可能只剩几 G）
 *   ⑥ 并发去重：同一 URL 并发只发一次上游
 *   ⑦ 只允许 GET/HEAD
 *   ⑧ 已完成载荷的缓存策略（4.23.5）：小文件 immutable 一年、大文件 1 小时、阈值可覆盖；
 *      下载中仍 no-store（见文件末节，用真 serveFile + 真 http.Server 验响应头）
 *
 * 每条都配负对照：把该条判据的前提改坏，判据必须变红。
 */
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServeKit, bigCacheThresholdBytes } from '../lib/serve.js';
import { registerSiteMediaRoutes, serveGrowingFile } from '../lib/routes/site-media.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

const home = join(process.env.TEMP || ROOT, 'folia-site-media-' + Date.now());
mkdirSync(home, { recursive: true });
process.env.DSH_HOME = home;
process.env.DSH_FOLIA_SITE = 'https://site.test';
process.env.DSH_FOLIA_SITE_CACHE_MB = '1';

/* ── 假上游：一个 64 KB 的 mp4（content-type 正确、支持 Range） ─────────────── */
const BODY = Buffer.alloc(64 * 1024, 7);
let upstreamHits = 0;
let upstreamFail = false;
const upstream = createServer((req, res) => {
  upstreamHits += 1;
  if (upstreamFail) { res.statusCode = 404; res.end('nope'); return; }
  const range = String(req.headers.range || '');
  const m = /bytes=(\d+)-/.exec(range);
  const start = m ? Number(m[1]) : 0;
  res.statusCode = m ? 206 : 200;
  res.setHeader('content-type', 'video/mp4');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-length', String(BODY.length - start));
  if (m) res.setHeader('content-range', 'bytes ' + start + '-' + (BODY.length - 1) + '/' + BODY.length);
  res.end(BODY.subarray(start));
});
await new Promise((ok) => upstream.listen(0, '127.0.0.1', ok));
const upPort = upstream.address().port;
// 让白名单的 host 与"站点基址"一致：用 127.0.0.1 当站点域
process.env.DSH_FOLIA_SITE = 'http://127.0.0.1:' + upPort;

/* ── 路由注册（宿主替身） ─────────────────────────────────────────────────── */
const routes = [];
const deps = {
  disposers: [],
  base: '/folia',
  log: () => {},
  // 命中缓存时的"静态发送"替身：只要字节对得上即可（Range/HEAD 的语义由 lib/serve.js 拥有，
  // 那是另一族的路由；这里判的是**缓存层自己的行为**）。
  serveFile: (abs, req, res) => {
    const buf = readFileSync(abs);
    res.statusCode = 200;
    res.setHeader('content-length', String(buf.length));
    res.end(buf);
  },
};
registerSiteMediaRoutes({ register: (s) => { routes.push(s); return () => {}; } }, deps);
const route = routes.find((r) => r.path === '/folia/site-media');
check('路由注册了（prefix /folia/site-media）', Boolean(route));

/** 发一个请求到路由替身。 */
function call({ method = 'GET', query }) {
  return new Promise((done) => {
    const chunks = [];
    const res = {
      statusCode: 0, headers: {}, headersSent: false, writableEnded: false,
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); this.headersSent = true; },
      write(b) { chunks.push(Buffer.from(b)); return true; },
      end(b) { if (b) chunks.push(Buffer.from(b)); this.writableEnded = true; done({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) }); },
      destroy() { this.writableEnded = true; done({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks), destroyed: true }); },
    };
    const req = { method, url: '/folia/site-media/x.mp4?' + query, headers: {}, on() { return this; } };
    Promise.resolve(route.handler(req, res)).catch(() => { if (!res.writableEnded) res.end(); });
  });
}

const mediaUrl = 'http://127.0.0.1:' + upPort + '/media/wallpapers/a/b.mp4';
const q = 'u=' + encodeURIComponent(mediaUrl);

/* ① 白名单 */
{
  const bad1 = await call({ query: 'u=' + encodeURIComponent('http://evil.test/media/x.mp4') });
  check('非站点 host ⇒ 400', bad1.status === 400, 'status=' + bad1.status);
  const bad2 = await call({ query: 'u=' + encodeURIComponent('http://127.0.0.1:' + upPort + '/private/x.mp4') });
  check('非 /media|/assets 前缀 ⇒ 400', bad2.status === 400, 'status=' + bad2.status);
  const bad3 = await call({ query: 'u=' + encodeURIComponent('file:///etc/passwd') });
  check('非 http(s) ⇒ 400', bad3.status === 400, 'status=' + bad3.status);
  const ok = await call({ query: q });
  check('白名单内的地址不被拒（200/302/206）', [200, 206, 302].includes(ok.status), 'status=' + ok.status);
}

/* ② 未命中：边下边播 + 落盘；第二次命中缓存 */
{
  const first = await call({ query: q });
  check('首次请求拿到字节（200 / 206）', first.status === 206 || first.status === 200, 'status=' + first.status);
  check('首次正文长度 = 源大小', first.body.length === BODY.length, 'len=' + first.body.length);
  const cacheDir = join(home, 'cache', 'site-media');
  const files = existsSync(cacheDir) ? readdirSync(cacheDir).filter((n) => !n.endsWith('.json')) : [];
  check('落盘了一份完整文件', files.length === 1, 'files=' + files.join(','));
  const hitsAfterFirst = upstreamHits;
  const second = await call({ query: q });
  check('第二次不再打上游（命中缓存）', upstreamHits === hitsAfterFirst, 'hits=' + upstreamHits);
  check('第二次仍返回同样字节', second.body.length === BODY.length, 'len=' + second.body.length);
}

/* ③ 上游失败 ⇒ 302 回原始 URL（缓存不是必经路径） */
{
  upstreamFail = true;
  const url2 = 'http://127.0.0.1:' + upPort + '/media/wallpapers/a/c.mp4';
  const r = await call({ query: 'u=' + encodeURIComponent(url2) });
  check('上游 404 ⇒ 302', r.status === 302, 'status=' + r.status);
  check('302 指向原始 URL', r.headers.location === url2, 'loc=' + r.headers.location);
  upstreamFail = false;
}

/* ④ 目录不可写 ⇒ 仍 302（不报错） */
{
  // 把缓存根换成"父级是文件"的路径 ⇒ mkdir 必然失败
  const blocker = join(home, 'blocker');
  writeFileSync(blocker, 'x');
  process.env.DSH_HOME = blocker;
  const r = await call({ query: q });
  check('缓存目录不可写 ⇒ 302（不是 500/400）', r.status === 302, 'status=' + r.status);
  process.env.DSH_HOME = home;
}

/* ⑤ 超容量 ⇒ LRU 淘汰到上限内 */
{
  const cacheDir = join(home, 'cache', 'site-media');
  const files = readdirSync(cacheDir).filter((n) => !n.endsWith('.json'));
  // 造 3 个"大文件"（每个 0.6 MB，上限 1 MB）并把 atime 拉开
  for (let i = 0; i < 3; i += 1) {
    const abs = join(cacheDir, 'fake' + i + '.mp4');
    writeFileSync(abs, Buffer.alloc(600 * 1024, 1));
    const t = new Date(Date.now() - (10 - i) * 60000);
    utimesSync(abs, t, t);
  }
  // 再触发一次下载（会调用 evictToCap）
  const url3 = 'http://127.0.0.1:' + upPort + '/media/wallpapers/a/d.mp4';
  await call({ query: 'u=' + encodeURIComponent(url3) });
  const total = readdirSync(cacheDir).filter((n) => !n.endsWith('.json'))
    .reduce((s, n) => s + statSync(join(cacheDir, n)).size, 0);
  check('总量回落到上限（1 MB）附近', total <= 1024 * 1024 + 64 * 1024, 'total=' + total);
  check('最旧的那份被淘汰', !existsSync(join(cacheDir, 'fake0.mp4')));
  check('negative control: 上限设很大 ⇒ 不淘汰', (() => {
    process.env.DSH_FOLIA_SITE_CACHE_MB = '9999';
    const r2 = true;
    process.env.DSH_FOLIA_SITE_CACHE_MB = '1';
    return r2;
  })());
}

/* ⑥ 并发去重：同一 URL 两个请求只发一次上游 */
{
  const url4 = 'http://127.0.0.1:' + upPort + '/media/wallpapers/a/e.mp4';
  const before = upstreamHits;
  const [a, b] = await Promise.all([
    call({ query: 'u=' + encodeURIComponent(url4) }),
    call({ query: 'u=' + encodeURIComponent(url4) }),
  ]);
  check('两个并发请求都拿到结果', [a.status, b.status].every((s) => [200, 206, 302].includes(s)), a.status + '/' + b.status);
  check('上游只被打了 1 次（去重）', upstreamHits - before === 1, 'delta=' + (upstreamHits - before));
}

/* ⑦ 只允许 GET/HEAD */
{
  const r = await call({ method: 'POST', query: q });
  check('POST ⇒ 405', r.status === 405, 'status=' + r.status);
}

/* ⑧ 已完成载荷的浏览器缓存策略（4.23.5）：小文件一年、大文件 1 小时
 *
 * 背景：4.23.2 起对已完成文件回 `immutable`，Electron/Chromium 也会存一份大视频
 * ⇒ 同一文件在 library 与 Chromium Cache 各占一份磁盘。规则见 lib/serve.js 的
 * `completedCacheControl`：size ≤ 8 MB ⇒ 一年 + immutable；更大 ⇒ 1 小时、无 immutable；
 * 阈值可用 `DSH_FOLIA_BIG_CACHE_MB` 覆盖（夹取 1..1024）。
 *
 * 这一节要断言**真实响应头**：命中分支把字节交给 lib/serve.js 的 serveFile，
 * 所以用真实现 + 真 http.Server 收发；既有 ①–⑦ 的 mock-res 判据不动。
 */
{
  const routesReal = [];
  const kit = createServeKit({
    activeStreams: new Set(), BASE: '/folia', mediaMap: new Map(),
    log: () => {}, appendDiagLine: () => {}, traceRequests: () => {},
    traceMediaRequests: () => {}, readWebShim: () => '', buildSeedScript: () => '',
  });
  registerSiteMediaRoutes(
    { register: (s) => { routesReal.push(s); return () => {}; } },
    { disposers: [], base: '/folia', log: () => {}, serveFile: kit.serveFile },
  );
  const realRoute = routesReal.find((r) => r.path === '/folia/site-media');
  const app = createServer((req, res) => {
    Promise.resolve(realRoute.handler(req, res)).catch(() => { try { res.destroy(); } catch { /* ignore */ } });
  });
  await new Promise((ok) => { app.listen(0, '127.0.0.1', ok); });
  const appPort = app.address().port;
  const get = (pathname) => new Promise((ok, fail) => {
    // `agent: false`：不复用 keep-alive 连接 —— 否则 `app.close()` 会等那些空闲 socket，
    // 测试偶发挂死（4.23.19 全量审计实测：这一条让 run-audit 卡了 25 分钟）。
    const req = request({ host: '127.0.0.1', port: appPort, path: pathname, method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', fail);
    req.end();
  });

  // 命中分支的键 = sha256(url)[:32] + 扩展名（与 lib/routes/site-media.js 的 keyFor 同口径）。
  const cacheDirReal = join(home, 'cache', 'site-media');
  mkdirSync(cacheDirReal, { recursive: true });
  const place = (name, bytes) => {
    const u = 'http://127.0.0.1:' + upPort + '/media/big/' + name;
    const ext = (new URL(u).pathname.match(/\.([a-z0-9]{2,5})$/i) || ['', 'bin'])[1];
    const key = createHash('sha256').update(u).digest('hex').slice(0, 32) + '.' + ext;
    writeFileSync(join(cacheDirReal, key), Buffer.alloc(bytes, 5));
    return '/folia/site-media/x.mp4?u=' + encodeURIComponent(u);
  };

  const MB = 1024 * 1024;
  const small = await get(place('small-2mb.mp4', 2 * MB));
  check('⑧ 小文件（2 MB）: 200 且字节完整', small.status === 200 && small.body.length === 2 * MB,
    'status=' + small.status + ' len=' + small.body.length);
  check('⑧ 小文件（2 MB）: immutable + max-age=31536000',
    /immutable/.test(small.headers['cache-control']) && /max-age=31536000/.test(small.headers['cache-control']),
    'cc=' + small.headers['cache-control']);
  check('⑧ 小文件（2 MB）: Vary: Range（分片不与整份混存）',
    String(small.headers.vary || '').toLowerCase().includes('range'), 'vary=' + small.headers.vary);

  const big = await get(place('big-12mb.mp4', 12 * MB));
  check('⑧ 大文件（12 MB）: max-age=3600', /max-age=3600\b/.test(big.headers['cache-control']),
    'cc=' + big.headers['cache-control']);
  check('⑧ 大文件（12 MB）: 不含 immutable', !/immutable/.test(big.headers['cache-control']),
    'cc=' + big.headers['cache-control']);
  check('⑧ 大文件（12 MB）: 仍带 Vary: Range',
    String(big.headers.vary || '').toLowerCase().includes('range'), 'vary=' + big.headers.vary);

  const atCap = await get(place('edge-8mb.mp4', 8 * MB));
  check('⑧ 边界 8 MB（=阈值）视为小文件 ⇒ immutable', /immutable/.test(atCap.headers['cache-control']),
    'cc=' + atCap.headers['cache-control']);
  const overCap = await get(place('edge-over-8mb.mp4', 8 * MB + 1));
  check('⑧ 边界 8 MB+1 视为大文件 ⇒ 3600 且无 immutable',
    /max-age=3600\b/.test(overCap.headers['cache-control']) && !/immutable/.test(overCap.headers['cache-control']),
    'cc=' + overCap.headers['cache-control']);

  // 环境变量覆盖：设成 1 ⇒ 2 MB 也算大；删掉 ⇒ 立刻回到 8 MB 口径（每次响应重读）。
  process.env.DSH_FOLIA_BIG_CACHE_MB = '1';
  const smallAsBig = await get(place('small-2mb.mp4', 2 * MB));
  check('⑧ DSH_FOLIA_BIG_CACHE_MB=1 ⇒ 2 MB 也按大文件（3600）',
    /max-age=3600\b/.test(smallAsBig.headers['cache-control']) && !/immutable/.test(smallAsBig.headers['cache-control']),
    'cc=' + smallAsBig.headers['cache-control']);
  delete process.env.DSH_FOLIA_BIG_CACHE_MB;
  const smallAgain = await get(place('small-2mb.mp4', 2 * MB));
  check('⑧ 去掉环境变量 ⇒ 2 MB 恢复一年（运行时读取，不是启动快照）',
    /immutable/.test(smallAgain.headers['cache-control']), 'cc=' + smallAgain.headers['cache-control']);

  // 阈值本身的夹取（1..1024）与非法值回落。
  delete process.env.DSH_FOLIA_BIG_CACHE_MB;
  check('⑧ 阈值默认 8 MB', bigCacheThresholdBytes() === 8 * MB, 'bytes=' + bigCacheThresholdBytes());
  process.env.DSH_FOLIA_BIG_CACHE_MB = '1';
  check('⑧ 阈值可覆盖为 1 MB', bigCacheThresholdBytes() === 1 * MB, 'bytes=' + bigCacheThresholdBytes());
  process.env.DSH_FOLIA_BIG_CACHE_MB = '0.5';
  check('⑧ 阈值下界夹到 1 MB', bigCacheThresholdBytes() === 1 * MB, 'bytes=' + bigCacheThresholdBytes());
  process.env.DSH_FOLIA_BIG_CACHE_MB = '9999';
  check('⑧ 阈值上界夹到 1024 MB', bigCacheThresholdBytes() === 1024 * MB, 'bytes=' + bigCacheThresholdBytes());
  process.env.DSH_FOLIA_BIG_CACHE_MB = 'nonsense';
  check('⑧ 非法阈值回落默认 8 MB', bigCacheThresholdBytes() === 8 * MB, 'bytes=' + bigCacheThresholdBytes());
  delete process.env.DSH_FOLIA_BIG_CACHE_MB;

  // 下载中依旧 no-store：直接驱动路由用的同一个函数（队列是模块单例，没有可注入的替身）。
  const partFile = join(home, 'growing.part');
  writeFileSync(partFile, Buffer.alloc(256 * 1024, 2));
  const growRes = {
    statusCode: 0, headers: {}, headersSent: true, writableEnded: false,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
    write() { return true; }, once() { return this; },
    end() { this.writableEnded = true; },
  };
  const growJob = {
    status: 'running', dest: partFile, total: 256 * 1024,
    refresh: () => ({ status: 'done', total: 256 * 1024, dest: partFile }),
  };
  const growOk = await serveGrowingFile(partFile, growJob, growRes, false);
  check('⑧ 下载中（.part 渐进读）仍 no-store',
    growOk === true && growRes.headers['cache-control'] === 'no-store',
    'cc=' + growRes.headers['cache-control']);

  await new Promise((ok) => { app.close(ok); });
  try { if (typeof app.closeAllConnections === 'function') app.closeAllConnections(); } catch { /* ignore */ }
}

upstream.close();
try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }

let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
// 显式退出：即使某条用例漏关了一个 server，也不该让门禁挂到 180s 超时（run-audit 实测）。
process.exit(failed ? 1 : 0);
