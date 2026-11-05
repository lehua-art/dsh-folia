#!/usr/bin/env node
/**
 * verify-local-media-heal.mjs — **本地副本 404 / 清空媒体后的假"无法解码"**（4.23.19，P0）。
 *
 * ## 事故链（用户实测，原文）
 *
 *   按面板「清空媒体」→ 成品文件被删，但 `downloads.json` / **内存队列**里的 job 仍是
 *   `status=done` ⇒ 客户端以为"已缓存" ⇒ 播 `/folia/local-media/<id>` ⇒ 宿主发现文件不存在
 *   回 404 JSON ⇒ `<video>` 收到 `MEDIA_ERR_SRC_NOT_SUPPORTED` ⇒ 界面显示
 *   「浏览器无法解码这段视频」。用户实际上只是清了自己的缓存。
 *
 * ## 判据（每条都配"不修就红"的负对照）
 *
 *   A. 启动 sweep：3 条 done-但-缺失 ⇒ 全部 pending、done=0、日志有 startup sweep 计数；
 *   B. `/local-media/<id>` 命中 done 但文件不存在 ⇒ 404 **且** job 复位 queued
 *      （负对照：路由前同一 job 仍是 done —— 只回 404 不改状态就是事故形态）；
 *   C. 清空媒体：宿主响应 `clearedJobs` > 0，**内存队列**里 done=0（全部 pending）；
 *      负对照：只调 `clearCache()`（只删文件/JSON）不会改内存队列 —— 证明必须同步；
 *   D. 客户端兜底：local-media URL + 站点代理 ⇒ 重挂后 `el.src` 不是 local-media、
 *      且调用 `/downloads/requeue`；负对照：没有可代播地址时返回空串；
 *   E. 源码接线：`maybeSelfHealVideo` 在自愈前先走代播（error code 4/2 + local-media），
 *      并把 `videoError` 清空（绝不把 404 当解码失败）；面板 toast 读 `clearedJobs`。
 *
 * 隔离 home（`%TEMP%\folia-test-*`）：用真路由 + 真队列 + 假 req/res，不碰用户库。
 * Usage: `node test/verify-local-media-heal.mjs`
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';
import { createDownloadQueue } from '../lib/download-queue.js';
import { registerDownloadsRoutes, getDownloadQueue } from '../lib/routes/downloads.js';
import { registerCacheRoutes, clearCache, TARGET_KINDS } from '../lib/routes/cache.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = isolateTestHome('local-media-heal', { force: true });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

const logs = [];

/* ── 预置：3 条 done（文件都在）+ 1 条 running + 1 条 skin done ───────────────── */
const LIB = join(HOME, 'library', 'wallpaper');
mkdirSync(LIB, { recursive: true });
const destOf = (id) => join(LIB, id + '.mp4');
/**
 * 4.23.19：成品必须是**结构有效**的 mp4（ftyp + moov）—— 对账器启动即验结构，
 * 拿 `Buffer.alloc()` 占位会被正确判成"内容无效"并删掉（那不是本用例要测的东西）。
 */
function fakeMp4(total = 2048) {
  const b = Buffer.alloc(total, 7);
  b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1'); b.writeUInt32BE(0x200, 12);
  b.write('mp41', 16, 'latin1'); b.write('isom', 20, 'latin1');
  b.writeUInt32BE(total - 32, 32); b.write('moov', 36, 'latin1');
  return b;
}
for (const id of ['w1', 'w2', 'w3']) writeFileSync(destOf(id), fakeMp4());
const seedJobs = [
  ...['w1', 'w2', 'w3'].map((id) => ({
    id, url: 'https://site.test/media/' + id + '.mp4', dest: destOf(id), kind: 'wallpaper',
    total: 2048, status: 'done', error: null, at: 1, priority: 'low',
  })),
  { id: 'r1', url: 'https://site.test/media/r1.mp4', dest: join(LIB, 'r1.mp4'), kind: 'wallpaper', total: 0, status: 'running', error: null, at: 2, priority: 'low' },
  { id: 's1', url: 'https://site.test/media/s1.zip', dest: join(HOME, 'library', 'skin', 's1.zip'), kind: 'skin', total: 2048, status: 'done', error: null, at: 3, priority: 'high' },
];
writeFileSync(join(HOME, 'downloads.json'), JSON.stringify({ version: 1, jobs: seedJobs }), 'utf8');

/* ── 真路由 + 假 webServer/req/res ───────────────────────────────────────────── */
const routes = [];
const webServer = { register(route) { routes.push(route); return () => {}; } };
const disposers = [];
registerDownloadsRoutes(webServer, {
  disposers, base: '/folia', serveFile: () => {}, log: (m) => logs.push(String(m)),
});
registerCacheRoutes(webServer, { disposers, base: '/folia', log: (m) => logs.push(String(m)) });
const routeOf = (path) => routes.find((r) => r.path === path) || null;

function makeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
    end(s) { this.body = String(s == null ? '' : s); if (this._done) this._done(); },
  };
  return res;
}
function getRoute(route, url) {
  const res = makeRes();
  route.handler({ method: 'GET', url, headers: {}, on() {} }, res);
  return res;
}
async function postRoute(route, body) {
  const res = makeRes();
  const done = new Promise((r) => { res._done = r; });
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = {};
  route.handler(req, res);
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body || {})));
    req.emit('end');
  });
  await done;
  return res;
}

/* ── A. 启动 sweep：3 条 done-缺失 ⇒ pending ─────────────────────────────────── */
console.log('\nA. 启动 sweep：done 但成品缺失 ⇒ pending');
{
  const home2 = join(HOME, 'startup-missing');
  mkdirSync(home2, { recursive: true });
  const jobs = [0, 1, 2].map((i) => ({
    id: 'gone-' + i, url: 'https://site.test/media/gone-' + i + '.mp4',
    dest: join(home2, 'library', 'gone-' + i + '.mp4'), kind: 'wallpaper',
    total: 4096, status: 'done', error: null, at: i, priority: 'low',
  }));
  writeFileSync(join(home2, 'downloads.json'), JSON.stringify({ version: 1, jobs }), 'utf8');
  const localLogs = [];
  const q = createDownloadQueue({ home: home2, log: (m) => localLogs.push(String(m)) });
  const snap = q.snapshot();
  check('A1 3 条 done-缺失全部 pending（不是 done / queued）',
    snap.filter((j) => j.status === 'pending').length === 3,
    snap.map((j) => j.status).join(','));
  check('A2 done 数 = 0', snap.filter((j) => j.status === 'done').length === 0);
  check('A3 启动 sweep 有可审计日志（回答"4.23.18 为什么没生效"）',
    localLogs.some((m) => /startup sweep: 3 条 done 但成品缺失 ⇒ pending/.test(m)),
    localLogs.join(' | '));
}

/* ── B. /local-media 命中 done 但文件不存在 ⇒ 404 + 复位 pending ────────────── */
console.log('\nB. /local-media：done 但文件不存在 ⇒ 404 + 复位 pending');
{
  const q = getDownloadQueue();
  check('B1 预置：w1 载入时是 done（文件存在）', q.jobById('w1')?.status === 'done', q.jobById('w1')?.status);
  rmSync(destOf('w1'), { force: true });
  check('B2 文件被删后：pathFor 已拿不到，但 job 仍是 done（事故形态）',
    q.pathFor('w1') === null && q.jobById('w1')?.status === 'done',
    q.jobById('w1')?.status);
  const route = routeOf('/folia/local-media');
  check('B3 local-media 路由在场', Boolean(route));
  const res = getRoute(route, '/folia/local-media/w1');
  let body;
  try { body = JSON.parse(res.body || '{}'); } catch { body = null; }
  check('B4 回 404 JSON（不是把 404 当成功）', res.statusCode === 404 && body && body.ok === false,
    res.statusCode + ' ' + String(res.body).slice(0, 80));
  // 4.23.19：语义是 **pending**（不替用户决定重下；在播的那张由客户端 requeue，见 D4）。
  check('B5 同时把 job 复位 pending（不是只回 404，也不是偷偷排队重下）',
    body && body.reset === 'pending' && q.jobById('w1')?.status === 'pending',
    JSON.stringify({ reset: body && body.reset, status: q.jobById('w1')?.status }));
  check('B6 404 响应点明"改用站点流"的来源（客户端据此换源，不用猜）',
    body && body.source === 'proxy', JSON.stringify({ source: body && body.source }));
}

/* ── C. 清空媒体：内存队列 done ⇒ pending，响应 clearedJobs ──────────────────── */
console.log('\nC. 清空媒体：同步重置内存队列');
{
  const q = getDownloadQueue();
  const doneBefore = q.snapshot().filter((j) => j.status === 'done').length;
  // B 段已把 w1 复位；s1 的 dest 本来就不存在（载入即 pending）⇒ 剩下 w2/w3 两条 done。
  check('C1 清空前内存队列确有 done（w2/w3）', doneBefore === 2, 'done=' + doneBefore);
  // 负对照：只调纯函数 clearCache（只删文件 + 摘 JSON）**不会**改内存队列。
  const homeNeg = join(HOME, 'negative-clear');
  mkdirSync(join(homeNeg, 'library', 'wallpaper'), { recursive: true });
  const negDest = join(homeNeg, 'library', 'wallpaper', 'neg.mp4');
  writeFileSync(negDest, Buffer.alloc(2048, 1));
  writeFileSync(join(homeNeg, 'downloads.json'), JSON.stringify({
    version: 1,
    jobs: [{ id: 'neg', url: 'https://site.test/media/neg.mp4', dest: negDest, kind: 'wallpaper', total: 2048, status: 'done', error: null, at: 1, priority: 'low' }],
  }), 'utf8');
  const qNeg = createDownloadQueue({ home: homeNeg, log: () => {} });
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = homeNeg;
  try {
    clearCache(['library']);
  } finally {
    process.env.DSH_HOME = oldHome;
  }
  check('C2 负对照：只删文件/摘 JSON ⇒ 内存队列仍 done（所以必须同步）',
    qNeg.jobById('neg')?.status === 'done' && !existsSync(negDest),
    qNeg.jobById('neg')?.status);

  const res = await postRoute(routeOf('/folia/cache/clear'), { targets: ['library'] });
  let body;
  try { body = JSON.parse(res.body || '{}'); } catch { body = null; }
  check('C3 清空媒体回 200 且带 clearedJobs', res.statusCode === 200 && Number(body?.clearedJobs) > 0,
    res.statusCode + ' clearedJobs=' + (body && body.clearedJobs));
  const snap = q.snapshot();
  check('C4 内存队列 done 数 = 0（被清目标的记录全部 pending）',
    snap.filter((j) => j.status === 'done').length === 0,
    snap.map((j) => j.id + ':' + j.status).join(','));
  check('C5 对应的 wallpaper done 记录都变成 pending',
    ['w2', 'w3'].every((id) => snap.find((j) => j.id === id)?.status === 'pending'),
    ['w2', 'w3'].map((id) => id + ':' + snap.find((j) => j.id === id)?.status).join(','));
  const disk = JSON.parse(readFileSync(join(HOME, 'downloads.json'), 'utf8'));
  check('C6 downloads.json 里 done 记录数 = 0（落盘同步）',
    (disk.jobs || []).filter((j) => j.status === 'done').length === 0,
    (disk.jobs || []).map((j) => j.id + ':' + j.status).join(','));
  check('C7 清理目标 kind 覆盖 library（wallpaper/pet/boot/media…）',
    (TARGET_KINDS.library || []).includes('wallpaper'));
}

/* ── D. 客户端兜底：local-media → 站点代理 + requeue ────────────────────────── */
console.log('\nD. 客户端兜底：404/error code 4 ⇒ 站点代理重试一次');
{
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('function lfLocalMediaJobId(');
  const b = src.indexOf('/**\n * **播放失败自愈的客户端入口**');
  check('D1 能取出代播兜底函数（源码真跑，不复制逻辑）', a >= 0 && b > a);
  const calls = [];
  const block = src.slice(a, b);
  const fn = new Function('apiPostJson', 'lfSay',
    block + '\nreturn { lfLocalMediaJobId, lfLocalMediaProxyFor, lfLocalMediaFallback };')(
    (path, body) => { calls.push({ path, body }); return Promise.resolve({ ok: true }); },
    () => {},
  );
  const item = { mediaProxy: '/folia/site-media/x.mp4?u=https%3A%2F%2Fsite.test%2Fx.mp4', media: 'https://site.test/x.mp4' };
  const el = { src: '', load() { this.loaded = true; }, play() { this.played = true; return Promise.resolve(); } };
  const proxy = fn.lfLocalMediaFallback(el, 'job1', '/folia/local-media/job1', item);
  check('D2 返回站点代理地址（不是 local-media）', proxy === item.mediaProxy && !proxy.includes('/local-media/'),
    proxy);
  check('D3 在屏元素真的切到代理（最终 src 不是 local-media）',
    el.src === item.mediaProxy && !String(el.src).includes('/local-media/') && el.loaded === true,
    el.src);
  check('D4 同时 POST /downloads/requeue（job 复位 queued）',
    calls.length === 1 && calls[0].path === '/downloads/requeue' && calls[0].body.id === 'job1',
    JSON.stringify(calls));
  check('D5 jobId 从 /local-media/<id> 解析（URL 编码也认）',
    fn.lfLocalMediaJobId('/folia/local-media/a%20b?x=1') === 'a b',
    fn.lfLocalMediaJobId('/folia/local-media/a%20b?x=1'));
  check('D6 负对照：没有可代播地址 ⇒ 空串（不拿 local-media 自己换自己）',
    fn.lfLocalMediaProxyFor({ media: '/folia/local-media/job2' }, '/folia/local-media/job1') === '');

  const client = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  check('D7 播放错误先走代播（local-media + code 4/2），再走自愈',
    /\/\\\/local-media\\\/\//.test(client) && /code === 4 \|\| code === 2/.test(client)
    // 4.24.0（I4）：第 4 个参数变成「刷新后的条目，拿不到才退回旧条目」——
    // 调用形状仍是 lfLocalMediaFallback(el, jobId, url, item)，判据只随契约一起改。
    && /lfLocalMediaFallback\(el, lfLocalMediaJobId\(url\), url, newItem \|\| staleItem\)/.test(client)
    && /lfStaleLocalPlan\(\{ url, headStatus: status \}\)/.test(client)
    && /refreshInventoryAfterLocalMissing\(id\)/.test(client));
  check('D8 404/缺失时清空 videoError（不显示"无法解码"）并给出人话提示',
    /setTransient\("videoError", ""\)/.test(client)
    && /本地副本已丢失，正在重新下载/.test(client));
  check('D9 只重试一次（LOCAL_MEDIA_FALLBACK_TRIED 去重，404→代理也坏时不死循环）',
    /LOCAL_MEDIA_FALLBACK_TRIED/.test(client) && /if \(!LOCAL_MEDIA_FALLBACK_TRIED\.has\(fkey\)\)/.test(client));
}

/* ── E. 面板文案：清空媒体会重置记录 + toast 显示 clearedJobs ───────────────── */
console.log('\nE. 面板文案与回执');
{
  const adv = readFileSync(join(ROOT, 'src', 'panel-tabs-advanced.js'), 'utf8');
  const client = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  check('E1 面板写明「清空媒体会同时重置下载记录，之后需重新下载」',
    /清空媒体会同时重置下载记录，之后需重新下载/.test(adv));
  check('E2 按钮 title 也写明会重置记录',
    /会同时重置下载记录，之后需重新下载/.test(adv));
  check('E3 toast 读宿主的 clearedJobs 并显示「重置 N 条下载记录」',
    /const jobs = Number\(d\.clearedJobs\) \|\| 0;/.test(client)
    && /重置 \{jobs\} 条下载记录/.test(client));
}

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */
const bad = results.filter((r) => !r.ok);
console.log('\n  ── 汇总 ──');
console.log('  通过 ' + (results.length - bad.length) + ' / ' + results.length);
if (bad.length) for (const r of bad) console.log('    ✗ ' + r.name + (r.detail ? ' — ' + r.detail : ''));
cleanupTestHome(HOME);
process.exit(bad.length ? 1 : 0);
