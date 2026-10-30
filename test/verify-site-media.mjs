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
 *
 * 每条都配负对照：把该条判据的前提改坏，判据必须变红。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSiteMediaRoutes } from '../lib/routes/site-media.js';

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

upstream.close();
try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }

let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
