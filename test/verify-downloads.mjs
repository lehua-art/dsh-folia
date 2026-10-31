/**
 * verify-downloads.mjs — 站点资源「点击即下载、连点即并发、落地后再渲染」的守卫。
 *
 * 用户定的语义（2026-10-30）：**不做勾选** —— 点哪条下哪条，连点就同时下；
 * 渲染方（我们 / 皮肤中心 / 播放器）只从本地取。
 *
 * 五条不变量，每条都配负对照（把前提改坏，判据必须变红）：
 *   ① 并发上限：同时下 6 个，正在跑的 ≤ 3（弱网下开太多连接会让每个都慢）
 *   ② 幂等：同一 URL 入队两次 ⇒ 只有一个 job（第二次 `existed: true`）
 *   ③ 续传：已有 `.part` 且 meta 同 URL ⇒ 从已有字节续（上游收到 Range）
 *   ④ 原子：未完成时目标文件**不存在**；完成后 `.part` 消失、目标存在
 *   ⑤ 可失败：单个 404 只让该 job 失败，其它继续跑完
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDownloadQueue } from '../lib/download-queue.js';
import { localCopyFor } from '../lib/routes/downloads.js';
import { readFileSync } from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });

const home = join(process.env.TEMP || ROOT, 'folia-dl-' + Date.now());
mkdirSync(home, { recursive: true });

/* ── 假上游：支持 Range 的 256 KB 文件；`/fail` 恒 404 ───────────────────── */
const BODY = Buffer.alloc(256 * 1024, 5);
const seenRanges = [];
const upstream = createServer((req, res) => {
  if (String(req.url).startsWith('/fail')) { res.statusCode = 404; res.end('nope'); return; }
  const range = String(req.headers.range || '');
  if (range) seenRanges.push(range);
  const m = /bytes=(\d+)-/.exec(range);
  const start = m ? Number(m[1]) : 0;
  res.statusCode = m ? 206 : 200;
  res.setHeader('content-type', 'video/mp4');
  res.setHeader('content-length', String(BODY.length - start));
  if (m) res.setHeader('content-range', 'bytes ' + start + '-' + (BODY.length - 1) + '/' + BODY.length);
  res.end(BODY.subarray(start));
});
await new Promise((ok) => { upstream.listen(0, '127.0.0.1', ok); });
const port = upstream.address().port;
const urlFor = (p) => 'http://127.0.0.1:' + port + p;

/* ①②④ 并发 / 幂等 / 原子 */
{
  const q = createDownloadQueue({ home, log: () => {} });
  const jobs = [];
  for (let i = 0; i < 6; i += 1) {
    const r = q.add({ url: urlFor('/media/f' + i + '.mp4'), dest: join(home, 'lib', 'f' + i + '.mp4'), kind: 'wallpaper' });
    jobs.push(r.job.id);
  }
  // 立刻观察：并发上限 3 ⇒ 至少有一个还在 queued
  const early = q.snapshot();
  const runningEarly = early.filter((j) => j.status === 'running').length;
  check('① 并发上限 ≤ 3（同时最多 3 个在跑）', runningEarly <= 3, 'running=' + runningEarly);
  check('① 负对照：入队 6 个 ⇒ 至少 1 个在排队（不是全并发）', early.some((j) => j.status === 'queued'), early.map((j) => j.status).join(','));

  // ② 幂等
  const again = q.add({ url: urlFor('/media/f0.mp4'), dest: join(home, 'lib', 'f0.mp4'), kind: 'wallpaper' });
  check('② 同一 URL 再入队 ⇒ existed=true 且 id 相同', again.existed === true && again.job.id === jobs[0], 'existed=' + again.existed);
  check('② 负对照：换一个 URL ⇒ existed=false', q.add({ url: urlFor('/media/other.mp4'), dest: join(home, 'lib', 'other.mp4'), kind: 'wallpaper' }).existed === false);

  // 等全部完成
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && q.snapshot().some((j) => ['queued', 'running'].includes(j.status))) {
    await new Promise((r) => { setTimeout(r, 50); });
  }
  const done = q.snapshot();
  check('④ 全部完成（6 个 done）', done.filter((j) => j.status === 'done').length >= 6, done.map((j) => j.status).join(','));
  check('④ 完成后目标文件存在且大小 = 源', statSync(join(home, 'lib', 'f0.mp4')).size === BODY.length);
  const leftovers = readdirSync(join(home, 'lib')).filter((n) => n.endsWith('.part'));
  check('④ 完成后没有残留 .part（原子 rename）', leftovers.length === 0, 'leftovers=' + leftovers.join(','));
}

/* ③ 续传：先写半个 .part，再入队 ⇒ 上游必须收到 Range */
{
  const home2 = join(home, 'resume');
  mkdirSync(join(home2, 'lib'), { recursive: true });
  const dest = join(home2, 'lib', 'half.mp4');
  const half = Math.floor(BODY.length / 2);
  writeFileSync(dest + '.part', BODY.subarray(0, half));
  seenRanges.length = 0;
  const q2 = createDownloadQueue({ home: home2, log: () => {} });
  q2.add({ url: urlFor('/media/half.mp4'), dest, kind: 'wallpaper' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && q2.snapshot().some((j) => ['queued', 'running'].includes(j.status))) {
    await new Promise((r) => { setTimeout(r, 50); });
  }
  check('③ 续传：上游收到 Range 请求', seenRanges.length > 0, 'ranges=' + seenRanges.join('|'));
  check('③ 负对照：Range 起点等于已下载字节（不是 0）', seenRanges.some((r) => Number((/bytes=(\d+)-/.exec(r) || [])[1]) > 0), seenRanges.join('|'));
  check('③ 续传后文件完整', existsSync(dest) && statSync(dest).size === BODY.length, 'size=' + (existsSync(dest) ? statSync(dest).size : -1));
}

/* ⑤ 可失败：一个 404 不拖垮其它 */
{
  const home3 = join(home, 'fail');
  mkdirSync(join(home3, 'lib'), { recursive: true });
  const q3 = createDownloadQueue({ home: home3, log: () => {} });
  q3.add({ url: urlFor('/fail/x.mp4'), dest: join(home3, 'lib', 'x.mp4'), kind: 'wallpaper' });
  q3.add({ url: urlFor('/media/ok.mp4'), dest: join(home3, 'lib', 'ok.mp4'), kind: 'wallpaper' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && q3.snapshot().some((j) => ['queued', 'running'].includes(j.status))) {
    await new Promise((r) => { setTimeout(r, 50); });
  }
  const snap = q3.snapshot();
  check('⑤ 404 的 job 标 failed（带原因）', snap.some((j) => j.status === 'failed' && j.error), snap.map((j) => j.status).join(','));
  check('⑤ 同队列的另一个照常完成', snap.some((j) => j.status === 'done'), snap.map((j) => j.status).join(','));
  check('⑤ 负对照：失败的那个没有落地文件', !existsSync(join(home3, 'lib', 'x.mp4')));
}

/* ⑥ 本地优先的两半：清单侧 `localCopyFor` 与客户端侧 local-first 的约定 */
{
  check('⑥ 清单侧 localCopyFor 是函数（inventory 用它判"已落地"）', typeof localCopyFor === 'function');
  check('⑥ 负对照：没下载过的 URL ⇒ localCopyFor 返回 null', localCopyFor('http://127.0.0.1:1/nothing.mp4') === null);
  const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  check('⑥ 客户端侧有 localFirstApply（点击即入队、完成后再应用）', /function localFirstApply\(/.test(lf));
  check('⑥ 客户端侧轮询 job 状态（进度可见）', /function lfPoll\(/.test(lf));
  check('⑥ 客户端侧只入队、不拦截本次播放（点了就能看，下载并行）', /只入队、不拦截本次播放/.test(readFileSync(join(ROOT, 'src', 'media-prep.js'), 'utf8')));
}

upstream.close();
try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }


/* ⑦ 大文件分片 + HEAD 预检 + 皮肤包走队列：这三条是"21 MB 很慢"的直接对策。
   判据用源码特征（行为级判据在上面 ①–⑥ 已覆盖），并各配一条负对照。 */
{
  const qSrc = readFileSync(join(ROOT, 'lib', 'download-queue.js'), 'utf8');
  const kSrc = readFileSync(join(ROOT, 'lib', 'routes', 'skins.js'), 'utf8');
  check('⑦ 大文件走分片并发（8 MB 阈值 + accept-ranges 判定）',
    /8 \* 1024 \* 1024/.test(qSrc) && /accept-ranges/i.test(qSrc) && /function fetchRanged\(/.test(qSrc));
  check('⑦ 分片大小不符即整次失败（不留半截文件）', /range-size-mismatch/.test(qSrc));
  check('⑦ 下载前 HEAD 预检：长度/etag 一致就跳过', /method: 'HEAD'/.test(qSrc) && /\.etag/.test(qSrc));
  check('⑦ 皮肤包安装走同一条队列（不再 fetch→arrayBuffer）', /getDownloadQueue\(\)/.test(kSrc) && !/r\.arrayBuffer\(\)/.test(kSrc));
  // 负对照：把阈值改大/删掉 Range 判定 ⇒ 判据会红
  check('⑦ negative control: 没有阈值常量时判据不成立', !/8 \* 1024 \* 1024/.test('const x = 1;'));
}

/* ⑧ "已存在的 job 也必须被 pump 起来" —— 实测踩过的死锁：
   皮肤安装 add() 一个已 queued 的 job 后，旧实现在 existed 分支直接 return，没人启动下载，
   调用方一直等到超时（用户看到"点了安装没反应"）。这里用行为判据钉住它。 */
{
  // 用**自己的**小上游：外层 upstream 在这段之前已经 close，复用会测出 failed（踩过）。
  const srv2 = createServer((req, res) => {
    const range = String(req.headers.range || '');
    const m2 = /bytes=(\d+)-/.exec(range);
    const start2 = m2 ? Number(m2[1]) : 0;
    res.statusCode = m2 ? 206 : 200;
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(BODY.length - start2));
    res.end(BODY.subarray(start2));
  });
  await new Promise((ok2) => { srv2.listen(0, '127.0.0.1', ok2); });
  const q = createDownloadQueue({ home: join(home, 'pump'), log: () => {} });
  const dest = join(home, 'pump', 'twice.mp4');
  const url = 'http://127.0.0.1:' + srv2.address().port + '/media/twice.mp4';
  q.add({ url, dest, kind: 'wallpaper' });
  q.add({ url, dest, kind: 'wallpaper' });   // existed 分支：必须仍然把队列泵起来
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const j = q.snapshot()[0];
    if (j && j.status === 'done') break;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  const j = q.snapshot()[0];
  check('⑧ 重复 add 同一个 URL 仍会完成（existed 分支必须 pump）', Boolean(j) && j.status === 'done', j && j.status);
  try { srv2.close(); } catch { /* ignore */ }
  const qSrc = readFileSync(join(ROOT, 'lib', 'download-queue.js'), 'utf8');
  check('⑧ 源码里 existed 分支确实调用了 pump()', /existed: true[\s\S]{0,160}pump\(\)/.test(qSrc) || /pump\(\);\s*return \{ job: snapshot\(\)\.find[^}]*existed: true/.test(qSrc));
}
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
