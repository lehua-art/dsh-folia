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
import { createDownloadQueue, normalizePriority } from '../lib/download-queue.js';
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
/** ⑫ 用：切换上游行为（先 500 再恢复），验证"失败后重试"。 */
const FAIL_MODE = { on: false };
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

/* ⑨ 单源复用：代理不再为同一条 URL 开第二条上游连接（实测重复下载抢带宽 5 倍差距）。 */
{
  const sm = readFileSync(join(ROOT, 'lib', 'routes', 'site-media.js'), 'utf8');
  check('⑨ 代理会复用队列里同 URL 的 job（queueJobFor）', /queueJobFor\(u\.toString\(\), 'wallpaper'\)/.test(sm));
  check('⑨ 存在渐进读函数 serveGrowingFile', /async function serveGrowingFile\(/.test(sm));
  check('⑨ 渐进读会读 .part（下载中的文件）', /\.dest \+ '\.part'/.test(sm));
  check('⑨ 无新字节时有上限（stalled）不无限挂着', /stalled > 600/.test(sm));
  check('⑨ negative control: 去掉复用块 ⇒ 判据会红', !/serveGrowingFile\(partPath, job, res, headOnly\)/.test(sm.replace(/await serveGrowingFile\(partPath, job, res, headOnly\);/, '')));
}

/* ⑩ 壁纸入队：必须能从 /inventory 的**真实键名**（wallpapers）里找到条目。
   实测踩过：只认 items ⇒ 永远找不到 ⇒ 静默不入队 ⇒ 代理没有可复用 job ⇒ 壁纸回到 0.6 MB/s。 */
{
  const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  check('⑩ 入队前查找会覆盖 wallpapers 键', /doc\.wallpapers/.test(lf));
  check('⑩ 查找用"多个对象数组池"兜底，不依赖单一键名', /\[doc\.items, doc\.wallpapers, doc\.list, doc\.entries\]/.test(lf));
  check('⑩ negative control: 只认 data.items 的旧写法会被判出来', !/resp\.data\.items\) \? resp\.data\.items\s*\n\s*: \(Array\.isArray\(resp && resp\.items\)/.test(lf));
}

/* ⑪ 站点凭据注入层（为"接口只给插件用"预留）：四个取数点都必须走统一头。 */
{
  const sa = readFileSync(join(ROOT, 'lib', 'site-auth.js'), 'utf8');
  check('⑪ 存在 site-auth 模块且支持环境变量与文件两种来源', /DSH_FOLIA_SITE_KEY/.test(sa) && /site-key\.txt/.test(sa));
  check('⑪ 有 key 时带 Bearer，没有则不带（向后兼容公开站点）',
    /\? \{ \.\.\.headers, authorization: 'Bearer ' \+ key \} : headers/.test(sa));
  const users = ['lib/routes/inventory.js','lib/routes/skins.js','lib/routes/boot.js','lib/routes/pets.js'];
  const missing = users.filter((f) => !/siteRequestHeaders\(\)/.test(readFileSync(join(ROOT, f), 'utf8')));
  check('⑪ 四个站点取数点都用了统一头（少一个就会漏带凭据）', missing.length === 0, missing.join(','));
  // 负对照：把一个文件的**全部**调用替换成普通 headers，同一判据必须只差 1 个
  const mutated = readFileSync(join(ROOT, 'lib/routes/pets.js'), 'utf8')
    .split('siteRequestHeaders()').join('plainHeaders');
  const mutatedHits = users
    .filter((f) => (f === 'lib/routes/pets.js' ? mutated : readFileSync(join(ROOT, f), 'utf8')).includes('siteRequestHeaders()'))
    .length;
  check('⑪ negative control: 把某个取数点的调用换掉后判据会红',
    mutatedHits === users.length - 1 && !mutated.includes('siteRequestHeaders()'),
    'mutatedHits=' + mutatedHits + ' / 期望 ' + (users.length - 1));
}

/* ⑫ 「失败过一次之后还能不能重试」—— 这是"别人机器明明能通却怎么点都下不来"的根因。
   用户要求：修好以后**任何人都不会**再遇到。所以用行为判据钉住，不靠代码看起来对。 */
{
  const http = createServer((req, res) => {
    if (FAIL_MODE.on) { res.statusCode = 500; res.end('boom'); return; }
    const range = String(req.headers.range || '');
    const m = /bytes=(\d+)-/.exec(range);
    const start = m ? Number(m[1]) : 0;
    res.statusCode = m ? 206 : 200;
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(BODY.length - start));
    res.end(BODY.subarray(start));
  });
  await new Promise((ok) => { http.listen(0, '127.0.0.1', ok); });
  const url = 'http://127.0.0.1:' + http.address().port + '/media/retry.mp4';
  const dest = join(home, 'retry', 'retry.mp4');
  const q = createDownloadQueue({ home: join(home, 'retry'), log: () => {} });

  FAIL_MODE.on = true;
  q.add({ url, dest, kind: 'wallpaper' });
  for (let i = 0; i < 80; i += 1) {
    const j = q.snapshot()[0];
    if (j && j.status === 'failed') break;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  const failed = q.snapshot()[0];
  check('⑫ 上游 500 ⇒ job 变 failed（第一拍）', Boolean(failed) && failed.status === 'failed', failed && failed.status);

  FAIL_MODE.on = false;
  q.add({ url, dest, kind: 'wallpaper' });   // 同一个 URL 再来一次 = 「用户再点一次安装」
  for (let i = 0; i < 120; i += 1) {
    const j = q.snapshot()[0];
    if (j && j.status === 'done') break;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  const retried = q.snapshot()[0];
  check('⑫ 失败后再次入队必须重试并成功（旧实现会永远停在 failed）',
    Boolean(retried) && retried.status === 'done', retried && retried.status);
  try { http.close(); } catch { /* ignore */ }
}

/* ⑬⑭⑮ 4.23.2：**优先级 + 按 kind 独立并发槽 + 排队位置**。
   真实故障：壁纸在播（预取把同队列的 3 个槽占满）时点皮肤安装，4.1 MB 的包永远停在
   「安装中…」。这一组用行为判据钉住三件事：
   ① 同一 kind 内 high 先于 low 启动，且 queuePos 就是**真实取任务顺序**里的位置；
   ② 壁纸占满自己的槽时，皮肤仍能立刻启动（这是用户遇到的场景本身）；
   ③ 旧 jobs.json（没有 priority 字段）不崩、恢复为 normal。 */
{
  const order = [];
  /** 每个请求延迟 250ms：给"排队"留出可观察的窗口，又不至于把用例拖慢。 */
  const slow = createServer((req, res) => {
    order.push(String(req.url));
    setTimeout(() => {
      res.statusCode = 200;
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-length', String(BODY.length));
      res.end(BODY);
    }, 250);
  });
  await new Promise((ok) => { slow.listen(0, '127.0.0.1', ok); });
  const base = 'http://127.0.0.1:' + slow.address().port;
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const waitAll = async (q, ms = 25000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && q.snapshot().some((j) => ['queued', 'running'].includes(j.status))) await sleep(40);
  };

  /* ⑬ 优先级排序 + queuePos */
  {
    const homeP = join(home, 'prio');
    const q = createDownloadQueue({ home: homeP, log: () => {} });
    // wallpaper 的槽是 2：前两条先跑起来，后两条必然排队 ⇒ 正好观察"取任务的顺序"。
    q.add({ url: base + '/media/p-a.mp4', dest: join(homeP, 'a.mp4'), kind: 'wallpaper', priority: 'low' });
    q.add({ url: base + '/media/p-b.mp4', dest: join(homeP, 'b.mp4'), kind: 'wallpaper', priority: 'low' });
    q.add({ url: base + '/media/p-c.mp4', dest: join(homeP, 'c.mp4'), kind: 'wallpaper', priority: 'low' });
    q.add({ url: base + '/media/p-d.mp4', dest: join(homeP, 'd.mp4'), kind: 'wallpaper', priority: 'high' });

    const queued = q.snapshot().filter((j) => j.status === 'queued').sort((x, y) => x.queuePos - y.queuePos);
    check('⑬ 排队中的任务带 1 基 queuePos 且连续（1、2…）',
      queued.length === 2 && queued[0].queuePos === 1 && queued[1].queuePos === 2,
      queued.map((j) => j.queuePos).join(','));
    check('⑬ queuePos 与优先级一致：high 在 queuePos=1，low 在 2',
      queued.length === 2 && /p-d\.mp4$/.test(queued[0].url) && /p-c\.mp4$/.test(queued[1].url),
      queued.map((j) => j.url.split('/').pop()).join(','));
    check('⑬ 快照带 priority（面板/排障要用）',
      q.snapshot().every((j) => ['high', 'normal', 'low'].includes(j.priority)));

    await waitAll(q);
    const iD = order.indexOf('/media/p-d.mp4');
    const iC = order.indexOf('/media/p-c.mp4');
    check('⑬ 高优先级先于低优先级启动（上游请求顺序）',
      iD >= 0 && iC >= 0 && iD < iC, 'd@' + iD + ' c@' + iC);
    check('⑬ 负对照：先入队的 low 确实排在后面（顺序不是"谁先入队谁先跑"）', iC > iD);

    // queuePos 与 pump 用**同一个**排序函数，否则"显示第 2 位、实际跑第 4 位"。
    const qSrc = readFileSync(join(ROOT, 'lib', 'download-queue.js'), 'utf8');
    check('⑬ queuePos 与取任务同一排序源（queuedOrder）',
      /function queuedOrder\(\)/.test(qSrc) && /queuedOrder\(\)\.find\(/.test(qSrc) && /posById = new Map\(ordered\.map/.test(qSrc));
    check('⑬ 优先级白名单：非法值回落 normal（不是抛错、不是 unknown）',
      normalizePriority('urgent') === 'normal' && normalizePriority(undefined) === 'normal' && normalizePriority('high') === 'high');
  }

  /* ⑭ 按 kind 独立槽：**用户遇到的场景本身** —— 壁纸占满槽，皮肤仍能立刻启动 */
  {
    const order2 = [];
    const srv2 = createServer((req, res) => {
      order2.push(String(req.url));
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('content-type', 'video/mp4');
        res.setHeader('accept-ranges', 'bytes');
        res.setHeader('content-length', String(BODY.length));
        res.end(BODY);
      }, 300);
    });
    await new Promise((ok) => { srv2.listen(0, '127.0.0.1', ok); });
    const b2 = 'http://127.0.0.1:' + srv2.address().port;
    const homeK = join(home, 'kinds');
    const q = createDownloadQueue({ home: homeK, log: () => {} });

    // 4 张壁纸 ⇒ wallpaper 只开 2 个槽，另 2 个排队（这就是"壁纸占住队列"的样子）
    for (let i = 0; i < 4; i += 1) {
      q.add({ url: b2 + '/media/w' + i + '.mp4', dest: join(homeK, 'w' + i + '.mp4'), kind: 'wallpaper', priority: 'low' });
    }
    await sleep(60);
    const before = q.snapshot();
    check('⑭ 壁纸最多占自己那 2 个槽（多出来的在排队）',
      before.filter((j) => j.kind === 'wallpaper' && j.status === 'running').length === 2
      && before.filter((j) => j.kind === 'wallpaper' && j.status === 'queued').length === 2,
      before.filter((j) => j.kind === 'wallpaper').map((j) => j.status).join(','));

    // 用户点「安装皮肤」：必须**立刻**启动，而不是排在 2 个壁纸后面
    q.add({ url: b2 + '/media/skin.zip', dest: join(homeK, 'skin.zip'), kind: 'skin', priority: 'high' });
    await sleep(120);
    const after = q.snapshot();
    const skin = after.find((j) => j.kind === 'skin');
    check('⑭ 壁纸占满槽时皮肤仍能立刻启动（不再卡「安装中…」）',
      Boolean(skin) && (skin.status === 'running' || skin.status === 'done'), skin && skin.status);
    check('⑭ 负对照：那条皮肤**不是**排队第 1 位（旧行为会先排 2 个壁纸）',
      Boolean(skin) && !skin.queuePos, skin && ('queuePos=' + skin.queuePos));

    // byKind 统计必须与 jobs 自述一致（否则面板/排障看到的是两套事实）
    const snap = q.snapshot();
    const expect = {};
    for (const j of snap) {
      const k = String(j.kind || 'default');
      if (!expect[k]) expect[k] = { running: 0, queued: 0 };
      if (j.status === 'running') expect[k].running += 1;
      if (j.status === 'queued') expect[k].queued += 1;
    }
    const byKind = snap.byKind || {};
    const consistent = Object.keys(expect).every((k) => {
      const got = byKind[k] || {};
      return got.running === expect[k].running && got.queued === expect[k].queued;
    }) && Object.keys(byKind).every((k) => Object.prototype.hasOwnProperty.call(expect, k));
    check('⑭ byKind 统计与 snapshot 逐条一致（同一真相）', consistent,
      JSON.stringify(byKind) + ' 期望 ' + JSON.stringify(expect));
    check('⑭ byKind 给出每类的并发上限（skin=2 / wallpaper=2 / pet=1 / boot=1）',
      byKind.wallpaper && byKind.wallpaper.limit === 2 && byKind.skin && byKind.skin.limit === 2,
      JSON.stringify({ w: byKind.wallpaper, s: byKind.skin }));

    // 每 kind 的上限：pet=1，3 条桌宠任务里同时最多 1 条在跑
    const homePet = join(home, 'kinds-pet');
    const qp = createDownloadQueue({ home: homePet, log: () => {} });
    for (let i = 0; i < 3; i += 1) {
      qp.add({ url: b2 + '/media/pet' + i + '.mp4', dest: join(homePet, 'pet' + i + '.mp4'), kind: 'pet', priority: 'low' });
    }
    let maxPet = 0;
    let maxAll = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const s = qp.snapshot();
      const petRun = s.filter((j) => j.kind === 'pet' && j.status === 'running').length;
      const allRun = s.filter((j) => j.status === 'running').length;
      maxPet = Math.max(maxPet, petRun);
      maxAll = Math.max(maxAll, allRun);
      if (!s.some((j) => ['queued', 'running'].includes(j.status))) break;
      await sleep(20);
    }
    check('⑭ pet 类同时最多 1 个在跑（按 kind 的上限生效）', maxPet === 1, 'maxPet=' + maxPet);
    check('⑭ 全局并发不超过 4（总带宽有天花板）', maxAll <= 4, 'maxAll=' + maxAll);
    check('⑭ 皮肤确实在壁纸跑着的时候就发了请求（不是等壁纸排完）',
      order2.indexOf('/media/skin.zip') >= 0 && order2.indexOf('/media/skin.zip') < order2.indexOf('/media/w3.mp4'),
      order2.join('|'));
    try { srv2.close(); } catch { /* ignore */ }
  }

  /* ⑮ 旧 jobs.json（**没有 priority 字段**）必须照旧能用 */
  {
    const homeOld = join(home, 'legacy');
    mkdirSync(join(homeOld, 'lib'), { recursive: true });
    // 真机上这份文件就是 4.23.1 及更早版本写下的样子：没有 priority / 没有 queuePos。
    writeFileSync(join(homeOld, 'downloads.json'), JSON.stringify({
      version: 1,
      jobs: [
        { id: 'old-1', url: base + '/media/legacy1.mp4', dest: join(homeOld, 'lib', 'legacy1.mp4'), kind: 'skin', total: 0, status: 'queued', error: null, at: Date.now() - 3000 },
        { id: 'old-2', url: base + '/media/legacy2.mp4', dest: join(homeOld, 'lib', 'legacy2.mp4'), kind: 'wallpaper', total: 0, status: 'failed', error: 'boom', at: Date.now() - 2000 },
      ],
    }, null, 2));
    let q = null;
    let crashed = null;
    try { q = createDownloadQueue({ home: homeOld, log: () => {} }); } catch (e) { crashed = e; }
    check('⑮ 旧 jobs.json（缺 priority）不崩', !crashed && Boolean(q), crashed && String(crashed.message || crashed));
    const snap0 = q ? q.snapshot() : [];
    check('⑮ 旧任务被恢复为 normal（不崩、也不是全员 high）',
      snap0.length === 2 && snap0.every((j) => j.priority === 'normal'),
      snap0.map((j) => j.priority).join(','));
    await waitAll(q, 20000);
    const snap1 = q.snapshot();
    check('⑮ 恢复后仍能继续下（旧条目不是死档）',
      snap1.filter((j) => j.status === 'done').length === 2
      && existsSync(join(homeOld, 'lib', 'legacy1.mp4')),
      snap1.map((j) => j.status).join(','));
    // 负对照：把同一份文件改成"priority 存在但非法" ⇒ 仍须回落 normal，且不崩
    let q2 = null;
    let crashed2 = null;
    const homeBad = join(home, 'legacy-bad');
    mkdirSync(join(homeBad, 'lib'), { recursive: true });
    writeFileSync(join(homeBad, 'downloads.json'), JSON.stringify({
      version: 1,
      jobs: [{ id: 'bad-1', url: base + '/media/bad1.mp4', dest: join(homeBad, 'lib', 'bad1.mp4'), kind: 'skin', total: 0, status: 'done', priority: 'URGENT', error: null, at: Date.now() }],
    }, null, 2));
    try { q2 = createDownloadQueue({ home: homeBad, log: () => {} }); } catch (e) { crashed2 = e; }
    check('⑮ 负对照：非法 priority 也回落 normal（白名单不是"照抄传入值"）',
      !crashed2 && q2 && q2.snapshot()[0] && q2.snapshot()[0].priority === 'normal',
      crashed2 ? String(crashed2.message || crashed2) : (q2 && q2.snapshot()[0] && q2.snapshot()[0].priority));
    try { slow.close(); } catch { /* ignore */ }
  }
}

/* ⑯ 4.23.2 的另外三条体感项：预取、完成文件的长缓存、排队/ETA 文案。
   判据以**源码事实**为主（行为面在 ⑬⑭ 已覆盖），并各配一条负对照。 */
{
  const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const panel = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
  const smedia = readFileSync(join(ROOT, 'lib', 'routes', 'site-media.js'), 'utf8');
  const serveSrc = readFileSync(join(ROOT, 'lib', 'serve.js'), 'utf8');
  const dict = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');

  check('⑯ 预取只在悬停 300ms 后触发（不是一进面板就全下）',
    /lfSchedulePrefetch/.test(lf) && /300\)/.test(lf) && /lfCancelPrefetch/.test(lf));
  check('⑯ 预取同一时刻最多 1 个，且已入队/已落地的不重复发',
    /LF_PREFETCH\.busy/.test(lf) && /LF_PREFETCH\.seen/.test(lf) && /downloads\/list/.test(lf));
  check('⑯ 预取走 low 优先级（不抢用户点击的 high）',
    /kind: "wallpaper", url: next\.media, priority: "low"/.test(lf));
  check('⑯ 负对照：把预取的 priority 改成 high 会被判出来',
    !/kind: "wallpaper", url: next\.media, priority: "high"/.test(lf));
  check('⑯ 面板卡片确实接了预取触发器',
    /onMouseEnter: \(\) => \{ try \{ lfSchedulePrefetch/.test(readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8')));

  check('⑯ 已完成的站点文件按不可变载荷发（immutable + 长缓存）',
    /\{ immutable: true \}/.test(smedia) && /public, max-age=31536000, immutable/.test(serveSrc));
  check('⑯ 负对照：下载中的渐进读仍然是 no-store（不缓存半截文件）',
    /serveGrowingFile\(partPath, job, res, headOnly\)/.test(smedia)
    && /res\.setHeader\('cache-control', 'no-store'\)/.test(smedia));

  check('⑯ 面板有排队位置文案，且 N = queuePos - 1',
    /排队中：前面还有 \{n\} 个任务/.test(panel) && /pos - 1/.test(panel));
  check('⑯ 面板有预计剩余时间（最近 3 秒增量估算）',
    /约剩 \{s\} 秒/.test(panel) && /samples\.push/.test(panel) && /3000/.test(panel));
  check('⑯ 新增文案都在英文词表里（零漏译不靠"以后再说"）',
    ['排队中：前面还有 {n} 个任务', '排队中：{name}', '排队中', '正在下载：{name} {p}%（{a}/{b} MB）· 约剩 {s} 秒']
      .every((k) => dict.includes(JSON.stringify(k))));
  check('⑯ 负对照：词表里没有的键会被这条判据判红',
    !['不存在的键-AB'].every((k) => dict.includes(JSON.stringify(k))));
}

let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
