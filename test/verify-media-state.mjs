#!/usr/bin/env node
/**
 * verify-media-state.mjs — **单一状态模型 / 单一解析器 / 对账** 的门禁（4.23.19）。
 *
 * 这一条守卫回答的不是"某个函数对不对"，而是**整类问题会不会再回来**：
 *   · 是否只有一处能回答"这份本地副本能不能播"（`resolvePlaySrc`）；
 *   · 是否只有一处能拼本地播放地址（`localMediaUrl` / `msLocalMediaUrl`）；
 *   · 是否只有一处能把 done 改成 pending（对账器 → `applyReconcile`）；
 *   · "下载中"是否**永远**走站点流（4.23.17 实测：81% 时播 `.part` ⇒「文件可能已损坏」）；
 *   · 生命周期合同（docs/MEDIA-LIFECYCLE.md）里的 13 个状态 / 15 条文案 / 12 条绕过是否还在。
 *
 * 判据矩阵（每条都配正向 + 负向对照；负对照改的是**真源码的副本**，不是重写一遍判据）：
 *   M1 纯函数状态机 × 8         M2 宿主解析器 × 6 + 负对照
 *   M3 客户端解析器 × 6 + 负对照  M4 对账器（30 条 done-缺失 / 幂等 / sha 不符 / 提升）
 *   M5 清缓存同一事务            M6 /local-media 缺失 ⇒ pending
 *   M7 /diag/media-state         M8 源码扫描（唯一解析器 / 唯一拼法 / 唯一写入口）
 *   M9 下载中/完成后的播放源判据
 *
 * 隔离：`test/tools/isolate-home.mjs`（临时 DSH_HOME，绝不写用户库）。
 * Usage: node test/verify-media-state.mjs
 */
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';
import {
  decideReconcile, resolvePlaySrc,
} from '../lib/media-state.js';
import { createDownloadQueue } from '../lib/download-queue.js';
import * as client from '../src/media-state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = isolateTestHome('media-state', { force: true });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

/** 结构有效的假 mp4（ftyp + moov，`invalidMediaReason` 与 `scanMp4Boxes` 都认）。 */
function fakeMp4(total = 4096, fill = 0x11) {
  const b = Buffer.alloc(total, fill);
  b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1'); b.writeUInt32BE(0x200, 12);
  b.write('mp41', 16, 'latin1'); b.write('isom', 20, 'latin1');
  b.writeUInt32BE(total - 32, 32); b.write('moov', 36, 'latin1');
  return b;
}
const shaOf = (buf) => createHash('sha256').update(buf).digest('hex');

/* ══ M0 生命周期合同：状态 13 / 文案 15 / 绕过 12 ═════════════════════════════ */
console.log('\nM0 生命周期合同（docs/MEDIA-LIFECYCLE.md）');
{
  const doc = readFileSync(join(ROOT, 'docs', 'MEDIA-LIFECYCLE.md'), 'utf8');
  const section = (from, to) => {
    const a = doc.indexOf(from);
    const b = to ? doc.indexOf(to) : doc.length;
    return a >= 0 ? doc.slice(a, b > a ? b : doc.length) : '';
  };
  const stateRows = (section('## 1. 状态定义', '## 2. ') || '').match(/^\| \d+ \| /gm) || [];
  const copyRows = (section('## 3. 失败文案矩阵', '## 4. ') || '').match(/^\| \d+ \| /gm) || [];
  const bypassRows = (section('## 6. 绕过清单', '') || '').match(/^\| \d+ \| /gm) || [];
  check('M0a 状态定义 13 行（与状态模型一一对应）', stateRows.length === 13, stateRows.length + ' 行');
  check('M0b 失败文案矩阵 16 条（每条都有触发条件与测试）', copyRows.length === 16, copyRows.length + ' 条');
  check('M0c 绕过清单 12 条（修前 → 修后）', bypassRows.length === 12, bypassRows.length + ' 条');
  check('M0d 合同写明"唯一允许 local 的状态"', /complete-valid/.test(doc) && /只有 `complete-valid`/.test(doc));
}

/* ══ M1 纯状态机 decideReconcile ════════════════════════════════════════════ */
console.log('\nM1 纯状态机（decideReconcile）');
{
  const job = (over) => Object.assign({
    id: 'j1', url: 'https://site.test/a.mp4', kind: 'wallpaper', status: 'done',
    dest: 'X.mp4', expectSha: '', expectBytes: 0,
  }, over || {});
  const st = (over) => Object.assign({ exists: true, bytes: 4096, valid: true }, over || {});

  const a = decideReconcile(job(), st(), {});
  check('M1a done + 存在 + 有效 ⇒ localReady（唯一允许 local 的形态）',
    a.state.localReady === true && a.state.source === 'local' && !a.patch, JSON.stringify(a.state));

  const b = decideReconcile(job(), { exists: false }, {});
  check('M1b done + 缺失 ⇒ pending（不占队列）+ 异常记录',
    b.patch && b.patch.status === 'pending' && b.anomaly && b.anomaly.reason === 'done-but-missing',
    JSON.stringify({ patch: b.patch, anomaly: b.anomaly }));

  const c = decideReconcile(job(), st({ valid: false, reason: 'no-moov' }), {});
  check('M1c done + 内容无效 ⇒ 删文件 + pending',
    c.removeFile === true && c.patch && c.patch.status === 'pending', JSON.stringify(c.patch));

  const d = decideReconcile(job({ status: 'pending' }), st({ bytes: 4096 }), {});
  check('M1d pending + 盘上是完整有效成品 ⇒ 提升 done（记录丢了但字节对）',
    d.patch && d.patch.status === 'done' && d.state.localReady === true, JSON.stringify(d.patch));

  const e = decideReconcile(job({ status: 'running' }), st(), {});
  check('M1e downloading：即使盘上有一份可读文件也**不是** local（I3）',
    e.state.localReady === false && e.state.source === 'proxy' && !e.patch);

  const f = decideReconcile(job({ status: 'queued' }), st(), {});
  check('M1f queued ⇒ proxy（未开始取任务）', f.state.localReady === false && f.state.source === 'proxy');

  const g = decideReconcile(job({ status: 'failed' }), st(), {});
  check('M1g failed ⇒ 不动状态、不可播', g.state.localReady === false && !g.patch && !g.removeFile);

  const h = decideReconcile(job({ status: 'pending' }), { exists: false }, {});
  check('M1h pending + 缺失 ⇒ 保持 pending（幂等：没有可做的动作）',
    h.state.localReady === false && !h.patch && !h.removeFile);
}

/* ══ M2 宿主解析器 resolvePlaySrc ═══════════════════════════════════════════ */
console.log('\nM2 宿主解析器（resolvePlaySrc）');
{
  const ok = { jobId: 'j1', jobStatus: 'done', fileExists: true, fileValid: true, localReady: true };
  const r1 = resolvePlaySrc(ok, { mediaProxy: '/folia/site-media/a.mp4?u=x', media: 'https://site.test/a.mp4' });
  check('M2a 完整且有效 ⇒ local（唯一拼法）',
    r1.source === 'local' && r1.url === '/folia/local-media/j1', r1.url);

  const r2 = resolvePlaySrc({ jobId: 'j1', jobStatus: 'done', fileExists: false, fileValid: false, localReady: false },
    { mediaProxy: '/folia/local-media/j1', media: 'https://site.test/a.mp4' });
  check('M2b done-缺失 ⇒ proxy；**跳过**候选里的本地地址（不 404 自循环）',
    r2.source === 'proxy' && !r2.url.includes('/local-media/') && r2.url === 'https://site.test/a.mp4', r2.url);

  const r3 = resolvePlaySrc({ jobId: 'j1', jobStatus: 'running', fileExists: true, fileValid: true, localReady: false },
    { mediaProxy: '/folia/site-media/a.mp4?u=x' });
  check('M2c downloading ⇒ proxy（收到的字节不算成品）',
    r3.source === 'proxy' && r3.url === '/folia/site-media/a.mp4?u=x', r3.url);

  const r4 = resolvePlaySrc(null, { mediaProxy: '/folia/site-media/a.mp4?u=x' });
  check('M2d 没有记录 ⇒ proxy', r4.source === 'proxy');

  const r5 = resolvePlaySrc({ jobId: '', jobStatus: 'done', fileExists: true, fileValid: true, localReady: true },
    { media: 'https://site.test/a.mp4' });
  check('M2e 没有 jobId ⇒ 不许拼 local（宁可多走一次网络）', r5.source === 'proxy');

  // 负对照：把真源码复制一份、**只摘掉 fileExists 判据** ⇒ M2b 必须红。
  const dir = mkdtempSync(join(tmpdir(), 'media-state-mutant-'));
  try {
    copyFileSync(join(ROOT, 'lib', 'media-verify.js'), join(dir, 'media-verify.js'));
    const src = readFileSync(join(ROOT, 'lib', 'media-state.js'), 'utf8');
    const mutated = src.replace(
      /const ready = Boolean\(state && state\.jobStatus === 'done'\n\s{4}&& state\.fileExists === true && state\.fileValid === true && localUrl\);/,
      'const ready = Boolean(state && state.jobStatus === \'done\'\n    && state.fileValid === true && localUrl);',
    );
    const changed = mutated !== src;
    writeFileSync(join(dir, 'media-state.js'), mutated, 'utf8');
    const mod = await import(pathToFileURL(join(dir, 'media-state.js')).href + '?v=' + Date.now());
    const bad = mod.resolvePlaySrc({ jobId: 'j1', jobStatus: 'done', fileExists: false, fileValid: true, localReady: true },
      { media: 'https://site.test/a.mp4' });
    check('M2f 负对照：摘掉 fileExists 判据 ⇒ 缺失文件也会被当 local（M2b 变红）',
      changed && bad.source === 'local', 'changed=' + changed + ' src=' + bad.source);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ══ M3 客户端解析器（src/media-state.js 真实现）════════════════════════════ */
console.log('\nM3 客户端解析器（src/media-state.js）');
{
  const origin = 'https://site.test/x.mp4';
  const proxy = '/folia/site-media/x.mp4?u=https%3A%2F%2Fsite.test%2Fx.mp4';

  const downloading = client.resolvePlaySrc({
    media: origin, mediaProxy: proxy,
    mediaState: { key: origin, jobId: 'c1', jobStatus: 'running', fileExists: false, fileValid: false, localReady: false },
  });
  check('M3a 下载中 ⇒ proxy（src 不含 /local-media）',
    downloading.source === 'proxy' && !downloading.url.includes('/local-media/'), downloading.url);

  const complete = client.resolvePlaySrc({
    media: origin, mediaProxy: proxy,
    mediaState: { key: origin, jobId: 'c1', jobStatus: 'done', fileExists: true, fileValid: true, localReady: true },
  });
  check('M3b 完整且有效 ⇒ local', complete.source === 'local' && complete.url === '/folia/local-media/c1', complete.url);

  const stale = client.resolvePlaySrc({
    media: origin, mediaProxy: '/folia/local-media/c2',
    mediaState: { key: origin, jobId: 'c2', jobStatus: 'pending', fileExists: false, fileValid: false, localReady: false },
  });
  check('M3c 清单缓存里的旧本地地址（pending）⇒ 回落到站点源，不再 404',
    stale.source === 'proxy' && stale.url === origin, stale.url);

  // I4：下载完成 ⇒ 同一条在 3 秒内变成 local（判据面：/downloads/list 一行就够）。
  client.msNoteJob({ id: 'c3', url: 'https://site.test/y.mp4', status: 'done', fileExists: true, fileValid: true });
  const afterDone = client.resolvePlaySrc({ media: 'https://site.test/y.mp4', mediaProxy: '/folia/site-media/y.mp4?u=y' });
  check('M3d 下载完成（fileExists+fileValid）⇒ 解析为 local（I4 的判据面）',
    afterDone.source === 'local' && afterDone.url === '/folia/local-media/c3', afterDone.url);

  client.msMarkUnavailable(afterDone.url, 'local-media-missing');
  const afterMissing = client.resolvePlaySrc({ media: 'https://site.test/y.mp4', mediaProxy: '/folia/site-media/y.mp4?u=y' });
  check('M3e 404 之后同一张 ⇒ proxy（本会话不再拿 404 地址去试）',
    afterMissing.source === 'proxy', afterMissing.url);

  // 负对照：客户端源码副本摘掉 fileExists 判据 ⇒ M3a 的红形态复现。
  const dir = mkdtempSync(join(tmpdir(), 'client-media-state-mutant-'));
  try {
    const src = readFileSync(join(ROOT, 'src', 'media-state.js'), 'utf8');
    const mutated = src.replace(
      '  const ready = Boolean(state\n    && state.jobStatus === "done"\n    && state.fileExists === true',
      '  const ready = Boolean(state\n    && state.jobStatus === "done"',
    );
    writeFileSync(join(dir, 'media-state.js'), mutated, 'utf8');
    const mod = await import(pathToFileURL(join(dir, 'media-state.js')).href + '?v=' + Date.now());
    const bad = mod.resolvePlaySrc({
      media: origin, mediaProxy: proxy,
      mediaState: { key: origin, jobId: 'c9', jobStatus: 'done', fileExists: false, fileValid: true, localReady: true },
    });
    check('M3f 负对照：摘掉 fileExists 判据 ⇒ 下载中的旧形态复活（M3a 变红）',
      mutated !== src && bad.source === 'local', 'src=' + bad.source);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ══ M4 对账器（真队列 + 真文件）════════════════════════════════════════════ */
console.log('\nM4 对账器：30 条 done-缺失 / 幂等 / sha 不符 / 提升');
const { createMediaReconciler } = await import('../lib/media-state.js');
const LIB = join(HOME, 'library', 'wallpaper');
mkdirSync(LIB, { recursive: true });
{
  const jobs = [];
  for (let i = 0; i < 30; i += 1) {
    jobs.push({
      id: 'gone-' + i, url: 'https://site.test/media/gone-' + i + '.mp4',
      dest: join(LIB, 'gone-' + i + '.mp4'), kind: 'wallpaper',
      total: 4096, status: 'done', error: null, at: i, priority: 'low',
      sha256: '', expectSha: '', expectBytes: 0, hashSource: 'original',
    });
  }
  // 1 条 sha 不符（文件在、内容与 expectSha 不一致）
  const badBuf = fakeMp4(4096, 0x22);
  const badDest = join(LIB, 'bad.mp4');
  writeFileSync(badDest, badBuf);
  jobs.push({
    id: 'bad', url: 'https://site.test/media/bad.mp4', dest: badDest, kind: 'wallpaper',
    total: 4096, status: 'done', error: null, at: 100, priority: 'low',
    sha256: shaOf(Buffer.from('different')), expectSha: shaOf(Buffer.from('different')),
    expectBytes: 4096, hashSource: 'original',
  });
  // 1 条 pending 但盘上完整（记录丢了）
  const okBuf = fakeMp4(4096, 0x33);
  const okDest = join(LIB, 'orphan.mp4');
  writeFileSync(okDest, okBuf);
  jobs.push({
    id: 'orphan', url: 'https://site.test/media/orphan.mp4', dest: okDest, kind: 'wallpaper',
    total: 4096, status: 'pending', error: null, at: 101, priority: 'low',
    sha256: shaOf(okBuf), expectSha: shaOf(okBuf), expectBytes: 4096, hashSource: 'original',
  });
  writeFileSync(join(HOME, 'downloads.json'), JSON.stringify({ version: 1, jobs }), 'utf8');

  const q = createDownloadQueue({ home: HOME, log: () => {} });
  const rec = createMediaReconciler({ queue: q, log: () => {} });
  // 4.23.18 的 `load()` 语义保留：done-缺失在载入时已经折成 pending（不占队列）。
  // 对账器负责的是**运行时**的同一件事（文件在会话中途被删 / 被外部清理），所以这里
  // 先把 3 条强制改回 done，再对账 —— 这才是"done 但成品缺失"的真实发生方式。
  await rec.reconcileAll({ reason: 'startup' });
  q.applyReconcile(['gone-0', 'gone-1', 'gone-2'].map((id) => ({ id, patch: { status: 'done' } })));
  const s1 = await rec.reconcileAll({ reason: 'runtime-delete' });
  const snap = q.snapshot();
  const gone = snap.filter((j) => j.id.startsWith('gone-'));
  check('M4a 30 条 done-缺失 ⇒ 全部 pending（I1）；运行时那 3 条由对账器复位',
    gone.every((j) => j.status === 'pending') && s1.reset === 3,
    'reset=' + s1.reset + ' statuses=' + [...new Set(gone.map((j) => j.status))].join(','));
  check('M4b 对账**不**产生排队任务（queuedCount = 0，不重演 4.23.18 之前的批量入队）',
    snap.queuedCount === 0, 'queuedCount=' + snap.queuedCount);
  const deepStats = await rec.reconcileAll({ reason: 'deep', deep: true });
  check('M4c pending + 盘上完整 ⇒ 提升 done；sha 不符 ⇒ 删文件 + pending（deep 才能证伪）',
    q.jobById('orphan')?.status === 'done' && q.jobById('bad')?.status === 'pending' && !existsSync(badDest),
    JSON.stringify({ orphan: q.jobById('orphan')?.status, bad: q.jobById('bad')?.status, badFile: existsSync(badDest), deepStats }));

  const s2 = await rec.reconcileAll({ reason: 'again' });
  check('M4d 幂等：同一份盘上证据再跑一遍 ⇒ reset/deleted/promoted 全 0',
    s2.reset === 0 && s2.deleted === 0 && s2.promoted === 0,
    JSON.stringify(s2));

  // deep：sha 不符才删（quick 只看长度/结构，内容错但长度对的要靠 deep）。
  const deepBuf = fakeMp4(4096, 0x44);
  const deepDest = join(LIB, 'deep.mp4');
  writeFileSync(deepDest, deepBuf);
  q.add({ url: 'https://site.test/media/deep.mp4', dest: deepDest, kind: 'wallpaper' });
  q.add({ url: 'https://site.test/media/deep.mp4', dest: deepDest, kind: 'wallpaper' });
  // 直接把它改成 done 且期望值错（模拟"长度对、内容错"的 4.23.6 遗留）
  q.applyReconcile([{
    id: q.snapshot().find((j) => j.url.endsWith('/deep.mp4')).id,
    patch: { status: 'done', expectSha: shaOf(Buffer.from('other')), expectBytes: 4096, total: 4096 },
  }]);
  await rec.reconcileAll({ reason: 'deep', deep: true });
  const deepJob = q.snapshot().find((j) => j.url.endsWith('/deep.mp4'));
  check('M4e deep 对账：长度对但 sha 不符 ⇒ 删文件 + pending（4.23.6 遗留也能清）',
    deepJob.status === 'pending' && !existsSync(deepDest), deepJob.status + ' file=' + existsSync(deepDest));
}

/* ══ M5–M7 清缓存事务 / /local-media 缺失 / diag ═════════════════════════════ */
console.log('\nM5 清缓存同一事务：clearedFiles > 0 且 resetJobs > 0');
{
  // 换一个隔离 home，重建单例（真实路由）。
  const home2 = join(HOME, 'clear-case');
  mkdirSync(join(home2, 'library', 'wallpaper'), { recursive: true });
  const d1 = join(home2, 'library', 'wallpaper', 'k1.mp4');
  const d2 = join(home2, 'library', 'wallpaper', 'k2.mp4');
  writeFileSync(d1, fakeMp4(2048, 0x55));
  writeFileSync(d2, fakeMp4(2048, 0x66));
  const jobs = [
    { id: 'k1', url: 'https://site.test/k1.mp4', dest: d1, kind: 'wallpaper', total: 2048, status: 'done', error: null, at: 1, priority: 'low' },
    { id: 'k2', url: 'https://site.test/k2.mp4', dest: d2, kind: 'wallpaper', total: 2048, status: 'done', error: null, at: 2, priority: 'low' },
  ];
  writeFileSync(join(home2, 'downloads.json'), JSON.stringify({ version: 1, jobs }), 'utf8');

  process.env.DSH_HOME = home2;
  const { __resetMediaSingletons, registerDownloadsRoutes, getDownloadQueue } = await import('../lib/routes/downloads.js');
  const { registerCacheRoutes } = await import('../lib/routes/cache.js');
  __resetMediaSingletons();
  const routes = [];
  const webServer = { register(r) { routes.push(r); return () => {}; } };
  const disposers = [];
  registerDownloadsRoutes(webServer, { disposers, base: '/folia', serveFile: () => {}, log: () => {} });
  registerCacheRoutes(webServer, { disposers, base: '/folia', log: () => {} });

  const res = { statusCode: 200, headers: {}, body: '', setHeader() {}, end(s) { this.body = String(s); if (this._done) this._done(); } };
  const req = new EventEmitter();
  req.method = 'POST'; req.headers = {};
  const done = new Promise((r) => { res._done = r; });
  routes.find((r) => r.path === '/folia/cache/clear').handler(req, res);
  setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify({ targets: ['library'] }))); req.emit('end'); });
  await done;
  let body;
  try { body = JSON.parse(res.body || '{}'); } catch { body = null; }
  check('M5a 清空媒体 ⇒ clearedFiles > 0（真删了文件）',
    body && Number(body.clearedFiles) > 0, JSON.stringify({ clearedFiles: body && body.clearedFiles }));
  check('M5b 同一事务把下载记录重置（resetJobs > 0，不是只删文件）',
    body && Number(body.resetJobs) > 0, JSON.stringify({ resetJobs: body && body.resetJobs }));
  const q = getDownloadQueue();
  check('M5c 内存队列里 done = 0（清完不会再有 404 的本地地址）',
    q.snapshot().filter((j) => j.status === 'done').length === 0,
    q.snapshot().map((j) => j.id + ':' + j.status).join(','));

  /* M6 /local-media 缺失 ⇒ 404 + job pending */
  const d3 = join(home2, 'library', 'wallpaper', 'k3.mp4');
  mkdirSync(dirname(d3), { recursive: true });   // 清空媒体会把 library 目录一起删掉
  writeFileSync(d3, fakeMp4(2048, 0x77));
  const addRes = q.add({ url: 'https://site.test/k3.mp4', dest: d3, kind: 'wallpaper' });
  q.applyReconcile([{ id: addRes.job.id, patch: { status: 'done' } }]);
  rmSync(d3, { force: true });
  const lm = routes.find((r) => r.path === '/folia/local-media');
  const out = { statusCode: 200, headers: {}, body: '', setHeader() {}, end(s) { this.body = String(s); } };
  lm.handler({ method: 'GET', url: '/folia/local-media/' + addRes.job.id, headers: {}, on() {} }, out);
  let lmBody;
  try { lmBody = JSON.parse(out.body || '{}'); } catch { lmBody = null; }
  check('M6a /local-media 命中缺失 ⇒ 404 + reset=pending（不偷偷重下）',
    out.statusCode === 404 && lmBody && lmBody.reset === 'pending', out.statusCode + ' ' + out.body.slice(0, 90));
  check('M6b job 同步变成 pending（下一次 resolvePlaySrc 必走 proxy）',
    q.jobById(addRes.job.id)?.status === 'pending', q.jobById(addRes.job.id)?.status);

  /* M7 diag */
  const diag = routes.find((r) => r.path === '/folia/diag/media-state');
  const dres = { statusCode: 200, headers: {}, body: '', setHeader() {}, end(s) { this.body = String(s); } };
  diag.handler({ method: 'GET', url: '/folia/diag/media-state', headers: {}, on() {} }, dres);
  let dbody;
  try { dbody = JSON.parse(dres.body || '{}'); } catch { dbody = null; }
  check('M7 /diag/media-state 返回总数/本地可用/待下载/上次对账/最近异常（≤20）',
    dbody && Number.isFinite(Number(dbody.total)) && Number.isFinite(Number(dbody.localReady))
    && Number.isFinite(Number(dbody.pending)) && dbody.last && typeof dbody.last === 'object'
    && Array.isArray(dbody.anomalies) && dbody.anomalies.length <= 20,
    JSON.stringify(dbody && { total: dbody.total, pending: dbody.pending, anomalies: dbody.anomalies.length }));

  cleanupTestHome(HOME);
}

/* ══ M8 源码扫描：唯一解析器 / 唯一拼法 / 唯一写入口 / 无半截文件播放 ═══════ */
console.log('\nM8 源码扫描（结构与接线）');
{
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const HOST_BUILD = /['"]\/folia\/local-media\/['"]\s*\+/;
  const CLIENT_BUILD = /["']\/folia\/local-media\/["']\s*\+/;

  const hostFiles = ['lib/media-state.js', 'lib/routes/downloads.js', 'lib/routes/inventory.js', 'lib/media-selfheal.js', 'lib/routes/cache.js'];
  const hostBuilders = hostFiles.filter((f) => HOST_BUILD.test(read(f)));
  check('M8a 本地播放地址的**拼接**只在 lib/media-state.js（唯一拼法）',
    hostBuilders.length === 1 && hostBuilders[0] === 'lib/media-state.js', hostBuilders.join(',') || 'none');

  const clientFiles = ['src/media-state.js', 'src/local-first.js', 'src/client.js', 'src/video-switch.js', 'src/media-prep.js'];
  const clientBuilders = clientFiles.filter((f) => CLIENT_BUILD.test(read(f)));
  check('M8b 客户端同理：只有 src/media-state.js 拼本地地址（video-switch 改调 msLocalMediaUrl）',
    clientBuilders.length === 1 && clientBuilders[0] === 'src/media-state.js', clientBuilders.join(',') || 'none');

  const parseSites = ['lib/routes/inventory.js', 'lib/routes/downloads.js', 'src/media-prep.js'];
  check('M8c 三处"决定播什么"的调用点都走 resolvePlaySrc()',
    parseSites.every((f) => /resolvePlaySrc\(/.test(read(f))), parseSites.join(','));
  check('M8d 客户端不再用 `w.mediaProxy || w.media` 直接当播放源',
    !/\(w\.mediaProxy \|\| w\.media\)/.test(read('src/media-prep.js')));
  check('M8e 清缓存路由改走对账 + 同一事务计数（resetDoneForKinds + reconcileMediaState）',
    /resetQueuedDoneForKinds/.test(read('lib/routes/cache.js'))
    && /reconcileMediaState\(\{ reason: 'cache-clear'/.test(read('lib/routes/cache.js'))
    && /clearedFiles/.test(read('lib/routes/cache.js')));

  const qsrc = read('lib/download-queue.js');
  check('M8f 启动状态映射唯一产地：load() 调 startupStatusFor()，且不再内联三元式',
    /startupStatusFor\(j\.status, onDisk\)/.test(qsrc) && !/j\.status === 'failed' \? 'failed'/.test(qsrc));
  check('M8g 队列暴露 applyReconcile（对账写状态的唯一入口，且不 pump）',
    /function applyReconcile\(patches\)/.test(qsrc) && /applyReconcile,/.test(qsrc)
    && !/function applyReconcile[\s\S]{0,800}pump\(\)/.test(qsrc));

  const sm = read('lib/routes/site-media.js');
  check('M8h 播放路径不再喂 `.part`（下载中 302 回源，growing 分支移除）',
    !/await serveGrowingFile\(/.test(sm) && /origin-downloading/.test(sm));

  const cl = read('src/client.js');
  check('M8i 本地源的 MediaError 不再单值翻译：videoPlaybackError 对 local 返回空串',
    /if \(msIsLocalMediaUrl\(selection\.url\)\) return "";/.test(cl));
  check('M8j 播放错误先 HEAD 判"丢/坏"再分类（apiHead + 404/410 + 缺失文案）',
    /apiHead\(url\)/.test(cl) && /status === 404 \|\| status === 410/.test(cl)
    && /本地副本已丢失，正在重新下载/.test(cl));
  check('M8k 视频切本地要求 fileValid（done 但缺失不许切）',
    /j\.fileValid !== false/.test(read('src/video-switch.js')));
}

/* ══ M9 文案矩阵：每条失败都有具体文案（I5）════════════════════════════════ */
console.log('\nM9 文案矩阵（禁止泛化"无法解码"）');
{
  const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const notes = ['文件已损坏，已重新下载', '本机不支持该编码（可换一张跳过此壁纸）',
    '该壁纸分辨率/编码超出本机解码能力（可换一张跳过此壁纸）', '已切换到 1080p（原画超出本机解码上限）',
    '正在生成本机可播放副本 {percent}%'];
  check('M9a 失败文案按判据分流（corrupt / undecodable / no-variant / variant / transcoding）',
    notes.every((s) => lf.includes(s)), notes.length + ' 条');
  const clientSrc = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  check('M9b 本地缺失文案在场（两种：有/无站点代理）',
    clientSrc.includes('本地副本已丢失，正在重新下载') && clientSrc.includes('本地副本已丢失，正在重新下载…'));
  check('M9c 代理源上的 code 3/4 才允许出现"浏览器无法解码"',
    /if \(msIsLocalMediaUrl\(selection\.url\)\) return "";[\s\S]{0,400}if \(err\.code === 4\) return weT\("浏览器无法解码这段视频/.test(clientSrc));
}

/* ══ M10 渲染方式（P1）+ 静态封面垫底（P0）═════════════════════════════════ */
console.log('\nM10 渲染方式（P1）+ 静态封面垫底（P0）');
{
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  const origin = 'https://site.test/x.mp4';
  const proxy = '/folia/site-media/x.mp4?u=https%3A%2F%2Fsite.test%2Fx.mp4';
  const prepSrc = read('src/media-prep.js');
  const clientSrc2 = read('src/client.js');

  const imgEntry = { type: 'image', media: 'https://site.test/x.jpg', mediaProxy: '/folia/site-media/x.jpg?u=x' };
  check('M10a image ⇒ mode=image（走 <img>，不建 video）',
    client.resolvePlaySrc(imgEntry).mode === 'image');

  const videoOk = client.resolvePlaySrc({ type: 'video', media: origin, mediaProxy: proxy });
  check('M10b 站点视频正常 ⇒ mode=video', videoOk.mode === 'video' && videoOk.source === 'proxy');

  const noSrc = client.resolvePlaySrc({ type: 'video', media: '', mediaProxy: '' });
  check('M10c 视频没有任何可用地址 ⇒ mode=poster（静态封面兜底）',
    noSrc.mode === 'poster' && noSrc.url === '');

  const liveEntry = { type: 'scene', media: origin, mediaProxy: proxy };
  check('M10d scene/web 是**预留**分支 ⇒ poster（不影响现有渲染）',
    client.resolvePlaySrc(liveEntry).mode === 'poster');

  check('M10e buildMedia：视频 + poster ⇒ 直接返回静态 <img>（不建 <video>）',
    /sel\.type === "video" && sel\.playMode === "poster"[\s\S]{0,600}createElement\("img"\)/.test(prepSrc));
  check('M10f 本地缺失路径**先铺封面再切流**（不黑屏、不报"无法解码"）',
    /mountStaticFrameFallback\(staticFallbackUrlOf\(\)\)[\s\S]{0,600}lfLocalMediaFallback\(/.test(clientSrc2));
  check('M10g 封面自身加载失败 ⇒ 撤掉 img 并回调（只有这时才允许最终失败）',
    /img\.onerror = \(\) => \{[\s\S]{0,220}onFail/.test(clientSrc2));
  check('M10h 缺失文案区分"已显示静态封面"与"没有封面"两种',
    /已显示静态封面 · 本地副本已丢失，正在重新下载/.test(clientSrc2)
    && /本地副本已丢失，正在重新下载…/.test(clientSrc2));

  // 负对照：客户端源码副本删掉 `mode` ⇒ M10a 必红（渲染分派不能靠"顺手加个字段"）。
  const dir = mkdtempSync(join(tmpdir(), 'client-mode-mutant-'));
  try {
    const src = readFileSync(join(ROOT, 'src', 'media-state.js'), 'utf8');
    const mutated = src.replace('if (t === "image") return "image";', 'if (t === "image") return "video";');
    writeFileSync(join(dir, 'media-state.js'), mutated, 'utf8');
    const mod = await import(pathToFileURL(join(dir, 'media-state.js')).href + '?v=' + Date.now());
    check('M10i 负对照：去掉 mode 分派 ⇒ image 条目不再得到 image（M10a 变红）',
      mutated !== src && mod.resolvePlaySrc(imgEntry).mode !== 'image',
      'mode=' + mod.resolvePlaySrc(imgEntry).mode);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ══ 汇总 ═══════════════════════════════════════════════════════════════════ */
const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length ? failed.length + ' CHECK(S) FAILED' : 'ALL MEDIA-STATE CHECKS PASSED')
  + '（' + results.length + ' 条）');
process.exit(failed.length ? 1 : 0);
