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

/* ⑨ 单源复用 + **下载中绝不喂 `.part`**（4.23.19：用户截图"81% + 文件可能已损坏"的根因）。 */
{
  const sm = readFileSync(join(ROOT, 'lib', 'routes', 'site-media.js'), 'utf8');
  /** 判据本体：路由里有没有"把正在增长的文件当成品发出去"的调用。 */
  const playsPart = (src) => /await serveGrowingFile\(partPath/.test(src);
  check('⑨ 代理会复用队列里同 URL 的 job（queueJobFor）', /queueJobFor\(u\.toString\(\), 'wallpaper'\)/.test(sm));
  check('⑨ 4.23.19：播放路径零处 serveGrowingFile 调用（下载中不播半截文件）',
    playsPart(sm) === false);
  check('⑨ 下载中 ⇒ 302 回源（x-folia-source: origin-downloading）',
    /origin-downloading/.test(sm) && /redirect\(res, u\)/.test(sm));
  check('⑨ 负对照：把 `await serveGrowingFile(partPath…` 贴回 ⇒ 判据会红',
    playsPart('await serveGrowingFile(partPath, job, res, headOnly, req);') === true);
}

/* ⑩ 壁纸入队：必须能从 /inventory 的**真实键名**（wallpapers）里找到条目。
   实测踩过：只认 items ⇒ 永远找不到 ⇒ 静默不入队 ⇒ 代理没有可复用 job ⇒ 壁纸回到 0.6 MB/s。 */
{
  const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  check('⑩ 入队前查找会覆盖 wallpapers 键', /doc\.wallpapers/.test(lf));
  check('⑩ 查找用"多个对象数组池"兜底，不依赖单一键名', /\[doc\.items, doc\.wallpapers, doc\.list, doc\.entries\]/.test(lf));
  check('⑩ negative control: 只认 data.items 的旧写法会被判出来', !/resp\.data\.items\) \? resp\.data\.items\s*\n\s*: \(Array\.isArray\(resp && resp\.items\)/.test(lf));
}

/* ⑪ 站点凭据注入层（为"接口只给插件用"预留）：四个取数点都必须走统一通道。 */
{
  const sa = readFileSync(join(ROOT, 'lib', 'site-auth.js'), 'utf8');
  check('⑪ 存在 site-auth 模块且支持环境变量与文件两种来源', /DSH_FOLIA_SITE_KEY/.test(sa) && /site-key\.txt/.test(sa));
  check('⑪ 有 key 时带 Bearer，没有则不带（向后兼容公开站点）',
    /\? \{ \.\.\.headers, authorization: 'Bearer ' \+ key \} : headers/.test(sa));
  /**
   * 4.24.0：**统一头的注入点收敛成一处**。四族（壁纸/皮肤/开机动画/桌宠）不再各自 `fetch` +
   * `siteRequestHeaders()`，而是统一走 `lib/site-list.js` 的 `siteListFetch()` —— 那里同时决定
   * 「v1 优先 / v0 回退」并注入统一头。判据因此变成两条：① 四族都走统一通道；② **只有**
   * site-list.js 拼头（散回四处 = 又会出现"漏带凭据"的入口）。
   * 负对照同一条判据：替换掉任意一族的调用 ⇒ ① 必须红。
   */
  const users = ['lib/routes/inventory.js', 'lib/routes/skins.js', 'lib/routes/boot.js', 'lib/routes/pets.js'];
  const srcOf = (f) => readFileSync(join(ROOT, f), 'utf8');
  const usesUnified = (src) => /siteListFetch\(/.test(src);
  const missing = users.filter((f) => !usesUnified(srcOf(f)));
  check('⑪ 四个站点取数点都走统一清单通道（siteListFetch ⇒ 统一头 + 端点偏好）',
    missing.length === 0, missing.join(','));
  check('⑪ 统一头只在 site-list.js 注入一处（三族不再各自拼 head；inventory 只留快照兜底）',
    /siteRequestHeaders\(\)/.test(srcOf('lib/site-list.js'))
    && ['lib/routes/skins.js', 'lib/routes/boot.js', 'lib/routes/pets.js']
      .every((f) => !/siteRequestHeaders\(\)/.test(srcOf(f))),
    ['skins.js', 'boot.js', 'pets.js'].filter((n) => /siteRequestHeaders\(\)/.test(srcOf('lib/routes/' + n))).join(',') || 'none');
  // 负对照：把一个文件的**全部**调用替换成普通取数函数，同一判据必须只差 1 个
  const mutated = srcOf('lib/routes/pets.js').split('siteListFetch(').join('plainListFetch(');
  const mutatedHits = users
    .filter((f) => usesUnified(f === 'lib/routes/pets.js' ? mutated : srcOf(f)))
    .length;
  check('⑪ negative control: 把某个取数点的调用换掉后判据会红',
    mutatedHits === users.length - 1 && !usesUnified(mutated),
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
    // 4.23.18：启动**不再批量入队** —— 旧 queued 变 pending（未缓存）、旧 failed 保留失败原因。
    check('⑮ 4.23.18 启动不自动入队：旧 queued ⇒ pending、旧 failed 原样保留',
      snap0.length === 2
      && snap0.find((j) => j.id === 'old-1')?.status === 'pending'
      && snap0.find((j) => j.id === 'old-2')?.status === 'failed',
      snap0.map((j) => j.id + ':' + j.status).join(','));
    // 用户点它们（点击 = high）⇒ 才入队，且仍能下完（旧条目不是死档）。
    q.add({ url: base + '/media/legacy1.mp4', dest: join(homeOld, 'lib', 'legacy1.mp4'), kind: 'skin', priority: 'high' });
    q.add({ url: base + '/media/legacy2.mp4', dest: join(homeOld, 'lib', 'legacy2.mp4'), kind: 'wallpaper', priority: 'high' });
    await waitAll(q, 20000);
    const snap1 = q.snapshot();
    check('⑮ 点击后仍能继续下（旧条目不是死档）',
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
  // 4.23.19：下载中的**渐进读**已从播放路径移除（半截字节被当成成品 ⇒「文件可能已损坏」）。
  // 现在那条分支是 302 回源；`.part` 只由下载队列自己消费。
  check('⑯ 4.23.19：下载中不读 `.part`（路由不再有 partPath 分支）',
    !/job\.dest \+ '\.part'/.test(smedia));
  check('⑯ 负对照：把"下载中读 .part"贴回 ⇒ 上一条即红',
    /job\.dest \+ '\.part'/.test(smedia + "const partPath = job.dest + '.part';"));

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

/* ⑰⑱⑲⑳ 4.23.3：**自适应多连接 + 可配并发**。
   两条实测同时成立，所以不能用"永远单流"或"永远多路"：
     · 本机低 RTT（4.6–4.9 MB/s）：单流最快，3 路 Range 反而 2.13 < 3.28 MB/s；
     · 用户另一台高 RTT 0.8 s（单流 0.21 MB/s）：12 路 1.28 MB/s，快 6 倍。
   判据用**真行为**（本地 server 控速）+ **逐字节比对**（重复下载/错位都会被抓住）。 */
{
  const MB = 1024 * 1024;
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  /** 带字节模式的测试体：每个偏移的值不同 ⇒ 写错位置/重复写都会让最终比对失败。 */
  const pattern = (n) => {
    const buf = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i += 1) buf[i] = i % 251;
    return buf;
  };
  /**
   * 可控速的 Range 上游：`delayMs` 是"每 chunkSize 字节之间等多久"。
   * 0.2 MB/s ≈ 64 KB / 320 ms —— 正好落在"高 RTT 单流"的实测区间（0.21 MB/s）。
   */
  const serve = (body, opts = {}) => new Promise((resolve) => {
    const state = { ranges: [], plain: 0 };
    const chunkSize = opts.chunkSize || 64 * 1024;
    const delayMs = opts.delayMs || 0;
    const srv = createServer((req, res) => {
      const range = String(req.headers.range || '');
      if (range) state.ranges.push(range); else state.plain += 1;
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : body.length - 1;
      res.statusCode = m ? 206 : 200;
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-length', String(end - start + 1));
      if (m) res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + body.length);
      let pos = start;
      let stopped = false;
      req.on('close', () => { stopped = true; });
      const tick = () => {
        if (stopped) return;
        if (pos > end) { res.end(); return; }
        const n = Math.min(chunkSize, end - pos + 1);
        res.write(body.subarray(pos, pos + n));
        pos += n;
        if (delayMs > 0) setTimeout(tick, delayMs); else tick();
      };
      tick();
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      srv, state, origin: 'http://127.0.0.1:' + srv.address().port,
    }));
  });
  const waitDone = async (q, ms = 60000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && q.snapshot()[0] && !['done', 'failed', 'cancelled'].includes(q.snapshot()[0].status)) await sleep(40);
  };

  /* ⑰ 快链路（本地 >2 MB/s）⇒ 全程 single，绝不切换、0 条 Range。 */
  {
    const body = pattern(6 * MB);
    const up = await serve(body);
    process.env.DSH_FOLIA_RANGED = 'auto';
    delete process.env.DSH_FOLIA_CHUNKS;
    const homeFast = join(home, 'adaptive-fast');
    const q = createDownloadQueue({ home: homeFast, log: () => {} });
    const dest = join(homeFast, 'fast.bin');
    const t0 = Date.now();
    q.add({ url: up.origin + '/media/fast.bin', dest, kind: 'wallpaper' });
    await waitDone(q, 30000);
    const ms = Date.now() - t0;
    const j = q.snapshot()[0];
    const mbps = (body.length / 1048576) / Math.max(0.001, ms / 1000);
    check('⑰ 快链路 >2 MB/s（本地实测）', mbps > 2, mbps.toFixed(1) + ' MB/s / ' + ms + 'ms');
    check('⑰ 快链路全程单流：mode=single 且 autoSwitched=false',
      j.status === 'done' && j.mode === 'single' && j.autoSwitched === false,
      j.status + ' / ' + j.mode + ' / ' + j.autoSwitched);
    check('⑰ 快链路 0 条 Range 请求（没有切换、没有重下）', up.state.ranges.length === 0,
      'ranges=' + up.state.ranges.length);
    check('⑰ 快链路文件 size + 内容正确',
      statSync(dest).size === body.length && Buffer.compare(readFileSync(dest), body) === 0,
      'size=' + statSync(dest).size);
    up.srv.close();
  }

  /* ⑱ 慢链路（≈0.2 MB/s，6 MB）⇒ 3 秒后切 ranged:8，从已下载偏移续传，size/内容正确。 */
  {
    const body = pattern(6 * MB);
    const up = await serve(body, { chunkSize: 64 * 1024, delayMs: 320 });
    process.env.DSH_FOLIA_RANGED = 'auto';
    delete process.env.DSH_FOLIA_CHUNKS;
    const homeSlow = join(home, 'adaptive-slow');
    const q = createDownloadQueue({ home: homeSlow, log: () => {} });
    const dest = join(homeSlow, 'slow.bin');
    const t0 = Date.now();
    q.add({ url: up.origin + '/media/slow.bin', dest, kind: 'wallpaper' });
    let switchedAt = 0;
    let sawSingle = false;
    while (Date.now() - t0 < 30000) {
      const j = q.snapshot()[0];
      if (j.mode === 'single' && j.status === 'running') sawSingle = true;
      if (/^ranged:\d+$/.test(j.mode)) { switchedAt = Date.now() - t0; break; }
      if (['done', 'failed', 'cancelled'].includes(j.status)) break;
      await sleep(40);
    }
    await waitDone(q, 60000);
    const ms = Date.now() - t0;
    const j = q.snapshot()[0];
    const parts = up.state.ranges.map((r) => {
      const m = /bytes=(\d+)-(\d+)/.exec(r);
      return { start: Number(m[1]), end: Number(m[2]) };
    }).sort((a, b) => a.start - b.start);
    const contiguous = parts.length > 0
      && parts[0].start > 0
      && parts[parts.length - 1].end === body.length - 1
      && parts.every((p, i) => i === 0 || p.start === parts[i - 1].end + 1);
    check('⑱ 慢链路先单流跑起来（不是一上来就多路）', sawSingle === true, 'sawSingle=' + sawSingle);
    check('⑱ 开始后 3 秒切换（实测切换时刻 2.5–6.5 s）',
      switchedAt >= 2500 && switchedAt <= 6500, 'switchedAt=' + switchedAt + 'ms');
    check('⑱ mode 变成 ranged:8 且 autoSwitched=true',
      j.mode === 'ranged:8' && j.autoSwitched === true, j.mode + ' / ' + j.autoSwitched);
    check('⑱ 恰好 8 条 Range 请求（= DSH_FOLIA_CHUNKS 默认值）',
      up.state.ranges.length === 8, 'ranges=' + up.state.ranges.length + ' [' + up.state.ranges.join(' | ') + ']');
    check('⑱ Range 起点 > 0（从已下载偏移续，不从 0 重下）',
      parts.length === 8 && parts[0].start > 0, 'firstStart=' + (parts[0] && parts[0].start));
    check('⑱ 8 段首尾相接、覆盖到文件末尾（无重叠 / 无空洞）', contiguous,
      parts.map((p) => p.start + '-' + p.end).join(','));
    check('⑱ 切换后总耗时 < 单流跑完（多连接确实更快）', ms < 20000, 'ms=' + ms);
    check('⑱ 最终文件 size 正确', statSync(dest).size === body.length, 'size=' + statSync(dest).size + '/' + body.length);
    check('⑱ 最终文件逐字节正确（没有重复下载 / 写错偏移）',
      Buffer.compare(readFileSync(dest), body) === 0, 'bytes differ');
    up.srv.close();
  }

  /* ⑲ 开关语义：`0` 永不切换；`1` 一开始就多连接。 */
  {
    const body = pattern(6 * MB);
    const up = await serve(body, { chunkSize: 64 * 1024, delayMs: 320 });
    process.env.DSH_FOLIA_RANGED = '0';
    const homeOff = join(home, 'adaptive-off');
    const q = createDownloadQueue({ home: homeOff, log: () => {} });
    const dest = join(homeOff, 'off.bin');
    q.add({ url: up.origin + '/media/off.bin', dest, kind: 'wallpaper' });
    // 4.5 s > 3 s 评估点：若判据失效（误切），这段时间足够看到 ranged。
    await sleep(4500);
    const j = q.snapshot()[0];
    check('⑲ DSH_FOLIA_RANGED=0 ⇒ 评估点之后仍是 single、autoSwitched=false',
      j.mode === 'single' && j.autoSwitched === false, j.mode + ' / ' + j.autoSwitched);
    check('⑲ DSH_FOLIA_RANGED=0 ⇒ 0 条 Range 请求（永不切换）', up.state.ranges.length === 0,
      'ranges=' + up.state.ranges.length);
    q.cancel(j.id);
    await sleep(300);
    up.srv.close();

    const big = pattern(9 * MB);
    const up2 = await serve(big);
    process.env.DSH_FOLIA_RANGED = '1';
    const homeForce = join(home, 'adaptive-force');
    const q2 = createDownloadQueue({ home: homeForce, log: () => {} });
    const dest2 = join(homeForce, 'force.bin');
    const t1 = Date.now();
    q2.add({ url: up2.origin + '/media/force.bin', dest: dest2, kind: 'wallpaper' });
    let modeSeen = '';
    while (Date.now() - t1 < 15000) {
      const j2 = q2.snapshot()[0];
      if (/^ranged:\d+$/.test(j2.mode)) { modeSeen = j2.mode; break; }
      if (['done', 'failed'].includes(j2.status)) break;
      await sleep(20);
    }
    await waitDone(q2, 30000);
    const j2 = q2.snapshot()[0];
    check('⑲ DSH_FOLIA_RANGED=1 ⇒ 一开始就是 ranged:8（不先等 3 秒）',
      modeSeen === 'ranged:8', 'modeSeen=' + modeSeen);
    check('⑲ 强制模式 autoSwitched=false（不算"自适应切换"）', j2.autoSwitched === false, String(j2.autoSwitched));
    check('⑲ 强制模式 8 条 Range、size 与内容正确',
      up2.state.ranges.length === 8 && statSync(dest2).size === big.length && Buffer.compare(readFileSync(dest2), big) === 0,
      'ranges=' + up2.state.ranges.length + ' size=' + statSync(dest2).size);
    up2.srv.close();

    /* ⑳ 全局并发：`DSH_FOLIA_CONCURRENCY` 生效并夹在 1..8（默认 6）。 */
    const tiny = pattern(256 * 1024);
    const up3 = await serve(tiny, { chunkSize: 256 * 1024, delayMs: 120 });
    delete process.env.DSH_FOLIA_RANGED;
    const peakOf = async (label, envVal, jobs, explicit) => {
      if (envVal == null) delete process.env.DSH_FOLIA_CONCURRENCY;
      else process.env.DSH_FOLIA_CONCURRENCY = String(envVal);
      // wallpaper 默认只给 2 个槽；这里放开它，才看得见**全局**并发到底是多少。
      process.env.DSH_FOLIA_QUEUE_WALLPAPER = '10';
      const h = join(home, 'conc-' + label);
      const q = createDownloadQueue(explicit ? { home: h, concurrency: explicit, log: () => {} } : { home: h, log: () => {} });
      for (let i = 0; i < jobs; i += 1) {
        q.add({ url: up3.origin + '/media/' + label + i + '.bin', dest: join(h, 'c' + i + '.bin'), kind: 'wallpaper' });
      }
      let peak = 0;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const snap = q.snapshot();
        const runningNow = snap.filter((x) => x.status === 'running').length;
        if (runningNow > peak) peak = runningNow;
        if (!snap.some((x) => x.status === 'queued' || x.status === 'running')) break;
        await sleep(10);
      }
      return peak;
    };
    check('⑳ DSH_FOLIA_CONCURRENCY=1 ⇒ 同时最多 1 个', (await peakOf('one', '1', 4)) === 1);
    check('⑳ DSH_FOLIA_CONCURRENCY=3 ⇒ 同时最多 3 个', (await peakOf('three', '3', 6)) === 3);
    check('⑳ DSH_FOLIA_CONCURRENCY=99 ⇒ 夹到 8（不是 99）', (await peakOf('over', '99', 10)) === 8);
    check('⑳ DSH_FOLIA_CONCURRENCY=0 ⇒ 夹到 1（不是 0 = 队列停摆）', (await peakOf('zero', '0', 4)) === 1);
    check('⑳ 非法值 ⇒ 默认 6', (await peakOf('junk', 'abc', 8)) === 6);
    check('⑳ 显式 opts.concurrency=99 同样夹到 8', (await peakOf('opts', null, 10, 99)) === 8);
    delete process.env.DSH_FOLIA_CONCURRENCY;
    delete process.env.DSH_FOLIA_QUEUE_WALLPAPER;
    up3.srv.close();

    /* 面板 / 接口可见：`/downloads/list` 的 mode 字段 + 面板文案「多连接(n)」。 */
    const panelSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
    const dictSrc = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');
    const routesSrc = readFileSync(join(ROOT, 'lib', 'routes', 'downloads.js'), 'utf8');
    check('⑳ 队列快照带 mode / autoSwitched（接口字段不靠调用方补）',
      q2.snapshot()[0] && typeof q2.snapshot()[0].mode === 'string' && q2.snapshot()[0].autoSwitched === false);
    check('⑳ /downloads/list 透传 snapshot（mode 随 job 一起出去）',
      /downloadQueue\.snapshot\(\)/.test(routesSrc) && /jobs, byKind/.test(routesSrc));
    check('⑳ 面板运行中显示「多连接(n)」（单流时仍是原文案）',
      /多连接\(\{n\}\)/.test(panelSrc) && /job\.mode/.test(panelSrc));
    check('⑳ 多连接文案在英文词表里（零漏译）',
      dictSrc.includes(JSON.stringify('正在下载：{name} {p}%（{a}/{b} MB）· 多连接({n})'))
      && dictSrc.includes(JSON.stringify('正在下载：{name} {p}%（{a}/{b} MB）· 约剩 {s} 秒 · 多连接({n})')));
    check('⑳ 负对照：词表里没有这条键时判据会红',
      !dictSrc.includes(JSON.stringify('正在下载：{name} {p}% · 不存在的多连接键')));
  }
}

/* ㉑㉒ 4.23.3：**切页签后下载状态不丢**（以 /folia/downloads/list 为唯一真源）。
   真实故障：开机动画页点「下载」→ 切到壁纸/皮肤页签 → 再切回来，进度消失、按钮回到「下载」，
   用户以为没在下（其实队列里还在跑）。根因是状态只存在组件 local state，重挂载即归零。
   判据两层：① 把 src 里的**纯函数**抠出来真跑（匹配 / 文案 / 是否继续轮询）；
             ② 三个页签与宿主路由必须真的接上这套（文本判据 + 负对照）。 */
{
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs(');
  const slice = (a >= 0 && b > a) ? src.slice(a, b) : '';
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  const mod = (() => {
    try {
      // 这段是"常量 + 纯函数"，喂一个 weT 就能原样跑 —— 判的就是**真的会跑的那段代码**。
      return new Function('weT', slice + '\nreturn { DL_POLL_MS, dlJobActive, dlHasActive, dlJobForCard, dlBusyLabel };')(shim);
    } catch { return null; }
  })();
  check('㉑ 能取到下载状态层的纯函数（匹配 / 轮询判据 / 文案都在同一段）', Boolean(mod), mod ? 'ok' : 'slice=' + slice.length);

  if (mod) {
    const running = { id: 'j1', kind: 'boot', url: 'https://x/a.mp4', status: 'running', percent: 42, mode: 'ranged:8' };
    const done = { id: 'j0', kind: 'boot', url: 'https://x/a.mp4', status: 'done', percent: 100, mode: 'single' };
    check('㉑ 挂载时 list 里已有 running job ⇒ 卡片按 (kind,url) 找到它（不回到「下载」）',
      mod.dlJobForCard([done, running], 'boot', 'https://x/a.mp4') === running);
    check('㉑ 负对照：kind 不同 / url 不同 / url 为空都匹配不到',
      mod.dlJobForCard([running], 'pet', 'https://x/a.mp4') === null
      && mod.dlJobForCard([running], 'boot', 'https://x/b.mp4') === null
      && mod.dlJobForCard([running], 'boot', '') === null);
    check('㉑ 轮询判据：有 queued|running 才继续，全部结束就停',
      mod.dlHasActive([running]) === true && mod.dlHasActive([{ status: 'queued' }]) === true
      && mod.dlHasActive([done]) === false && mod.dlHasActive([]) === false);
    check('㉑ 轮询间隔 = 1.5s（需求原文）', mod.DL_POLL_MS === 1500, 'ms=' + mod.DL_POLL_MS);
    check('㉑ 按钮文案 `下载中… x%`；多连接时就地补 ` · 多连接(8)`',
      mod.dlBusyLabel({ status: 'running', percent: 42, mode: 'single' }) === '下载中… 42%'
      && mod.dlBusyLabel(running) === '下载中… 42% · 多连接(8)',
      mod.dlBusyLabel(running));
    check('㉑ 负对照：没有 mode 时不会凭空出现「多连接」', !mod.dlBusyLabel({ percent: 7 }).includes('多连接'));
  }

  // ② 三个页签 + 宿主路由都真的接上这套（少一处，那个页签就还是"切回来就丢"）。
  check('㉒ useDownloadJobs 卸载即清定时器（切页签不泄漏）',
    /clearInterval\(timer\)/.test(src) && /return \(\) => \{ alive = false; stop\(\); \}/.test(src));
  check('㉒ 轮询由 dlHasActive 决定（全部结束即停表，不空转）',
    /if \(!dlHasActive\(list\)\) stop\(\);/.test(src));

  const bootTab = readFileSync(join(ROOT, 'src', 'panel-tabs-boot.js'), 'utf8');
  const petsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-pets.js'), 'utf8');
  const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
  const bootRoute = readFileSync(join(ROOT, 'lib', 'routes', 'boot.js'), 'utf8');
  const petsRoute = readFileSync(join(ROOT, 'lib', 'routes', 'pets.js'), 'utf8');
  const dict = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');

  check('㉒ 开机动画页：卡片按 list 匹配 job 并显示进度',
    /dlJobForCard\(dl\.jobs, "boot", c\.url\)/.test(bootTab) && /dlBusyLabel\(job\)/.test(bootTab));
  check('㉒ 桌宠页：安装卡片按 list 匹配 job 并显示进度',
    /dlJobForCard\(dl\.jobs, "pet", s\.url\)/.test(petsTab) && /dlBusyLabel\(job\)/.test(petsTab));
  check('㉒ 助手皮肤页：卡片按 list 匹配 job，并在挂载时恢复「正在下载皮肤包」',
    /dlJobForCard\(dl\.jobs, "skin", s\.url\)/.test(skinsTab)
    && /正在下载（皮肤包）/.test(skinsTab) && /kind === "skin"/.test(skinsTab));
  check('㉒ 三个页签都订阅同一个真源（useDownloadJobs）',
    [bootTab, petsTab, skinsTab].every((t) => /useDownloadJobs\(\)/.test(t)));
  check('㉒ 宿主侧：开机动画下载入队 kind=boot 并回 202 pending',
    /getDownloadQueue\(log\)/.test(bootRoute) && /kind: 'boot'/.test(bootRoute) && /pending: true/.test(bootRoute));
  check('㉒ 宿主侧：桌宠安装入队 kind=pet（queue:true）并回 202 pending',
    /kind: 'pet'/.test(petsRoute) && /pending: true/.test(petsRoute) && /body\.queue === true/.test(petsRoute));
  check('㉒ 负对照：三个页签里任意一个没订阅真源就会被判出来',
    [bootTab, petsTab, skinsTab].filter((t) => /useDownloadJobs\(\)/.test(t)).length === 3
    && !/useDownloadJobs\(\)/.test(bootTab.replace('useDownloadJobs()', '')));
  check('㉒ 新增文案都在英文词表里（下载中… / 皮肤包）',
    dict.includes(JSON.stringify('下载中… {p}%')) && dict.includes(JSON.stringify('下载中… {p}% · 多连接({n})'))
    && dict.includes(JSON.stringify('正在下载（皮肤包）{p}%（{a}/{b} MB）')));
}

/* ㉓ 4.23.4：**四个模块共用的卡片状态机**（submitting → queued → running → installing → done，
   失败带具体原因 +「重试」）。
   真实故障（用户实测）：有的皮肤卡片有进度（14 MB 那个显示「安装中…」），有的点了**毫无反应**
   （16.6 MB 那个既不置灰、不显示进度、也不报错）；开机动画/桌宠/皮肤的"进度"覆盖度不一致。
   根因：卡片的"忙"用的是**页面级** busy，且 install 的 disabled 绑 `busyIsStructural`
   —— 任何结构操作开始，**所有**安装按钮一起灰 ⇒ 点另一张卡片等于点在 disabled 按钮上
   （请求不发、提示不写、界面什么都不发生）。
   判据：纯函数用假数据逐格驱动（正/负都咬）＋ 四个页签必须接**同一个**函数。 */
{
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs(');
  const slice = (a >= 0 && b > a) ? src.slice(a, b) : '';
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  const mod = (() => {
    try {
      return new Function('weT', slice + '\nreturn { DL_PHASES, DL_SUBMIT_TIMEOUT_MS, dlCardState, dlFailReason, dlQueueDetail, dlProgressDetail };')(shim);
    } catch { return null; }
  })();
  check('㉓ 共用状态机能被取出来真跑（纯函数段）', Boolean(mod), mod ? 'ok' : 'slice=' + slice.length);

  if (mod) {
    const labels = { idle: '安装', done: '已安装', failed: '重试' };
    const st = (o) => mod.dlCardState(Object.assign({ id: 'c1', labels }, o || {}));
    const now = Date.now();

    // ① idle
    const idle = st({});
    check('㉓ idle ⇒「安装」且可点', idle.phase === 'idle' && idle.label === '安装' && idle.disabled === false,
      JSON.stringify(idle));
    // ② submitting：点击瞬间就置灰 +「正在提交…」（"点了没反应"的解药）
    const sub = st({ sub: { id: 'c1', at: now - 400 }, nowMs: now });
    check('㉓ 点击瞬间 ⇒ submitting 且**按钮禁用**（这一格必须在点击同一帧出现）',
      sub.phase === 'submitting' && sub.disabled === true && sub.label.includes('正在提交'),
      JSON.stringify(sub));
    const subLong = st({ sub: { id: 'c1', at: now - 7000 }, nowMs: now });
    check('㉓ 提交中 ≥3 秒 ⇒ 显示已等待秒数（请求在飞也不是死的）',
      subLong.phase === 'submitting' && subLong.detail.includes('已等待'), JSON.stringify(subLong.detail));
    const subOther = st({ sub: { id: 'other', at: now - 400 }, nowMs: now });
    check('㉓ 负对照：**别人**的提交中不影响这张卡片（按卡片、不是按页面）',
      subOther.phase === 'idle' && subOther.disabled === false, JSON.stringify(subOther));
    // ③ 提交超时 ⇒ 失败 + 重试（不永远停在提交中）
    const subTimeout = st({ sub: { id: 'c1', at: now - (mod.DL_SUBMIT_TIMEOUT_MS + 1000) }, nowMs: now });
    check('㉓ 提交超时 ⇒ failed +「重试」+ 原因里有"超时"',
      subTimeout.phase === 'failed' && subTimeout.retry === true && subTimeout.label === '重试'
      && subTimeout.reason.includes('超时'), JSON.stringify(subTimeout));
    check('㉓ 提交超时窗口 > 宿主 install 的等待窗口（8 秒），不会把还在飞的请求误判成失败',
      mod.DL_SUBMIT_TIMEOUT_MS >= 8000 * 2, 'ms=' + mod.DL_SUBMIT_TIMEOUT_MS);

    // ④ queued：前面还有 N 个
    const queued = st({ sub: { id: 'c1', at: now }, nowMs: now, job: { status: 'queued', queuePos: 3 } });
    check('㉓ queued ⇒ 显示「前面还有 2 个」（queuePos - 1），且仍禁用',
      queued.phase === 'queued' && queued.label.includes('前面还有 2 个') && queued.disabled === true,
      JSON.stringify(queued));
    check('㉓ queued 位置未知时不编数字（只说"排队中"）',
      st({ job: { status: 'queued', queuePos: 0 } }).label === '排队中');

    // ⑤ running：百分比 + a/b MB + 约剩 N 秒 + 多连接
    const running = st({
      job: { status: 'running', percent: 42, received: 7 * 1048576, total: 16.6 * 1048576, mode: 'ranged:8' },
      etaSec: 41,
    });
    const all = running.label + ' ' + running.detail;
    check('㉓ running ⇒ 进度一应俱全：x% + a/b MB + 约剩 N 秒 + 多连接(n)',
      running.phase === 'running' && running.label === '下载中… 42% · 多连接(8)'
      && /7\.0\/16\.6 MB/.test(running.detail) && running.detail.includes('约剩 41 秒'),
      JSON.stringify({ label: running.label, detail: running.detail }));
    check('㉓ running 的四个要素都能在一张卡片上读到（% / MB / 约剩 / 多连接）',
      /42%/.test(all) && /MB/.test(all) && /约剩/.test(all) && /多连接/.test(all), all);
    const noEta = st({ job: { status: 'running', percent: 3, received: 102400, total: 1048576, mode: 'single' } });
    check('㉓ 没有速度样本时**不编**剩余时间（只给 MB）',
      noEta.detail.includes('MB') && !noEta.detail.includes('约剩'), JSON.stringify(noEta.detail));

    // ⑥ installing / done
    check('㉓ 包下完但还没落地 ⇒ installing（解压/落位中…）',
      st({ job: { status: 'done' } }).phase === 'installing');
    const doneSt = st({ done: true, labels });
    check('㉓ 已装 ⇒ done（按钮禁用、文案用本模块自己的词）',
      doneSt.phase === 'done' && doneSt.disabled === true && doneSt.label === '已安装', JSON.stringify(doneSt));

    // ⑦ 失败：具体原因 + 重试入口（五类各一条）
    const fails = [
      ['http-404', '404'],
      ['fetch failed', '连不上站点'],
      ['timeout', '超时'],
      ['size-mismatch:1/2', '校验失败'],
      ['bad-zip', '包结构不对'],
      ['no-skin-json', '包结构不对'],
    ];
    const reasons = [];
    for (const [code, want] of fails) {
      const f = st({ job: { status: 'failed', error: code } });
      reasons.push({ code, phase: f.phase, label: f.label, retry: f.retry, reason: f.reason });
      check('㉓ 失败（' + code + '）⇒ failed +「重试」+ 原因含「' + want + '」',
        f.phase === 'failed' && f.retry === true && f.label === '重试'
        && f.disabled === false && f.reason.includes(want), JSON.stringify(f));
    }
    check('㉓ 五类失败的原因**互不相同**（不是同一句万能话）',
      new Set(reasons.map((r) => r.reason)).size === reasons.length);
    check('㉓ 未登记的错误码也带出码本身（禁止裸 failed）',
      (() => { const f = st({ job: { status: 'failed', error: 'weird-xyz' } }); return f.reason.includes('weird-xyz') && f.reason !== 'failed'; })());
    check('㉓ 负对照：失败态一定可重试且带原因（不存在"failed 但没原因/不可点"的组合）',
      fails.every(([code]) => {
        const f = st({ job: { status: 'failed', error: code } });
        return f.retry === true && f.reason.length > 0 && f.timedOut !== true;
      }));
    check('㉓ 提交阶段就失败（err）⇒ 同样落到 failed + 原因',
      (() => { const f = st({ err: { code: 'network' } }); return f.phase === 'failed' && f.reason.includes('连不上站点'); })(),
      JSON.stringify(st({ err: { code: 'network' } })));
    check('㉓ 畸形输入不抛（面板不许因为状态机变白屏）',
      (() => {
        try {
          const junk = [undefined, null, {}, { job: null, sub: null, err: null }, { job: { status: 'weird' } }, { sub: 'str' }, { err: 42 }, { job: { status: 'running' } }];
          return junk.every((x) => {
            const r = x === undefined ? mod.dlCardState() : mod.dlCardState(x);
            return r && typeof r.phase === 'string' && typeof r.label === 'string';
          });
        } catch { return false; }
      })());

    // ⑧ 四个页签必须接**同一个**函数（少一处，那个模块就还是"没有进度"）
    const bootTab = readFileSync(join(ROOT, 'src', 'panel-tabs-boot.js'), 'utf8');
    const petsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-pets.js'), 'utf8');
    const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
    const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
    check('㉓ 四个模块共用同一个状态计算函数（dlCardState 只有一处定义）',
      (lf.match(/function dlCardState\(/g) || []).length === 1
      && (lf.match(/function useDlCards\(/g) || []).length === 1);
    check('㉓ boot / pet / skin 三个页签都走 useDlCards + stateOf（壁纸模块保持原状）',
      [bootTab, petsTab, skinsTab].every((t) => /useDlCards\(dl\)/.test(t) && /cards\.stateOf\(/.test(t))
      && !/useDlCards/.test(readFileSync(join(ROOT, 'src', 'panel-tabs-wallpaper.js'), 'utf8')));
    check('㉓ 安装按钮只禁**这一张**卡片（不再被别处的结构操作一起禁掉）',
      /disabled: st\.disabled/.test(skinsTab)
      && !/disabled: busyIsStructural \|\| busy === "install:" \+ s\.id/.test(skinsTab)
      && !/Boolean\(busy\) \|\| jobBusy/.test(skinsTab + petsTab));
    check('㉓ 负对照：把 install 的 disabled 绑回页面级 busy 会被这条判据抓出来',
      /disabled: busyIsStructural \|\| busy === "install:" \+ s\.id || jobBusy/.test('disabled: busyIsStructural || busy === "install:" + s.id || jobBusy')
      && !/disabled: busyIsStructural \|\| busy === "install:" \+ s\.id \|\| jobBusy/.test(skinsTab));
    check('㉓ 三个页签都把失败原因写回卡片（cards.fail）并清掉（cards.end）',
      [bootTab, petsTab, skinsTab].every((t) => /cards\.fail\(cardId/.test(t) && /cards\.end\(cardId/.test(t) && /cards\.begin\(cardId\)/.test(t)));
    check('㉓ 失败原因的人话表只有一处（四模块共用 dlFailReason）',
      (lf.match(/function dlFailReason\(/g) || []).length === 1
      && [bootTab, petsTab, skinsTab].every((t) => /dlFailReason\(/.test(t)));
    check('㉓ 文案都在英文词表里（正在提交… / 解压/落位中… / 原因：{why}）',
      (() => {
        const dict = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');
        return ['正在提交…', '解压/落位中…', '原因：{why}', '已等待 {s} 秒', '{a}/{b} MB · 约剩 {s} 秒']
          .every((k) => dict.includes(JSON.stringify(k)));
      })());
    check('㉓ 负对照：词表里没有的键会被同一条判据判红',
      !readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8').includes(JSON.stringify('正在提交…-不存在')));
  }
}

/* ㉔ 4.23.6：**「下载已完成但安装没落地」的自愈与超时**。
   真实故障（用户实测，已确诊）：`/folia/downloads/list` 里 job.status 已经是 `done`
   （17,509,106 B 全下完、缓存 zip 完好、能解压、含 skin.json），但 `skins/rainy-night` 不存在；
   卡片在这一格上被永久映射成「解压/落位中…」（disabled、retry=false、无超时）。
   根因：当初的收尾是宿主内存里的 `setTimeout`（`scheduleFinishInstall()`），DSH 重启就没了，
   而 `jobs.json` 里的 `status=done` 落了盘 ⇒ 重启后没人再推进"落地"。

   判据分三层（都用真数据，不做"看起来对"的断言）：
     ① **超时**：done + 未落地 + 超过阈值 ⇒ failed +「重试」；阈值内 / 无样本 / 已落地都不许判失败；
     ② **自愈**：done + 未落地 ⇒ 挂载时自动打 1 次安装请求（幂等、走缓存）；成功 → markOk → done；
        失败 → 卡片带原因；同一 id 每次会话只试 1 次（防抖）；
     ③ **可观测**：宿主把窗口随 `/downloads/list` 下发；安装成功/失败日志在 `warn` 档且带
        id / 耗时 / 结果 / 错误码。 */
{
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs(');
  const slice = (a >= 0 && b > a) ? src.slice(a, b) : '';
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  /** 每个沙箱一份**独立**模块作用域（`LF_HEAL_TRIED` 是模块级，防抖判据必须互不污染）。 */
  const makeMod = (poster) => {
    try {
      return new Function('weT', 'apiPostJson', slice
        + '\nreturn { DL_PHASES, DL_INSTALL_STALL_MS, dlCardState, dlFailReason, dlInstallStallMs, dlHealOnce, dlHealTargets, dlHealStuck };')(shim, poster);
    } catch { return null; }
  };
  const posts = [];
  const mod = makeMod(async (path, body) => { posts.push({ path, body }); return { ok: true, status: 200, data: { ok: true } }; });
  check('㉔ 自愈 / 超时那一段纯函数能被取出来真跑', Boolean(mod), mod ? 'ok' : 'slice=' + slice.length);

  if (mod) {
    const labels = { idle: '安装', done: '已安装', failed: '重试' };
    const now = Date.now();
    const st = (o) => mod.dlCardState(Object.assign({ id: 'c1', labels }, o || {}));

    // ── ① 超时：死锁那一格必须有上界 ────────────────────────────────────────
    const stalled = st({ job: { id: 'j1', status: 'done' }, installingSince: now - 90001, installStallMs: 90000, nowMs: now });
    check('㉔ done + 未落地 + 超过阈值（90s）⇒ failed 且「重试」可用',
      stalled.phase === 'failed' && stalled.retry === true && stalled.label === '重试' && stalled.disabled === false,
      JSON.stringify(stalled));
    check('㉔ 它的原因说清「下载已完成、这次失败在落地」并给出下一步（点重试）',
      stalled.reason.includes('下载已完成') && stalled.reason.includes('安装未落地') && stalled.reason.includes('重试'),
      stalled.reason);
    check('㉔ 负对照：阈值内（30s < 90s）仍是 installing —— 正在解压的包不许被误判',
      st({ job: { id: 'j1', status: 'done' }, installingSince: now - 30000, installStallMs: 90000, nowMs: now }).phase === 'installing',
      st({ job: { id: 'j1', status: 'done' }, installingSince: now - 30000, installStallMs: 90000, nowMs: now }).phase);
    check('㉔ 负对照：还没有观察样本（installingSince=0）时不判失败',
      st({ job: { id: 'j1', status: 'done' }, nowMs: now }).phase === 'installing');
    check('㉔ 负对照：已落地（done=true）⇒ done，不会被超时判成 failed',
      st({ job: { id: 'j1', status: 'done' }, done: true, installingSince: now - 90001, installStallMs: 90000, nowMs: now }).phase === 'done');

    // ── ①b 窗口覆盖（夹取 + 非法回落）──────────────────────────────────────
    //     ⚠️ 客户端**不许**读 `process.env`（`scripts/build-client.mjs` 的浏览器安全判据会红），
    //     所以客户端只认宿主注入的全局袋 `globalThis.__weEnv`；真正解析环境变量的是宿主，
    //     见 `lib/routes/downloads.js` 的 `installStallMs()`（随 `/downloads/list` 下发）。
    const envKey = 'DSH_FOLIA_INSTALL_STALL_MS';
    const envBackup = globalThis.__weEnv;
    delete globalThis.__weEnv;
    check('㉔ 默认窗口 = 90 秒', mod.dlInstallStallMs() === 90000, 'ms=' + mod.dlInstallStallMs());
    check('㉔ 常量与默认一致（两处漂开就会各判各的）', mod.DL_INSTALL_STALL_MS === mod.dlInstallStallMs());
    globalThis.__weEnv = { [envKey]: '15000' };
    check('㉔ 宿主注入的窗口可覆盖（15000 ⇒ 15 秒）', mod.dlInstallStallMs() === 15000, 'ms=' + mod.dlInstallStallMs());
    globalThis.__weEnv = { [envKey]: '1' };
    check('㉔ 覆盖值被夹到下限 5 秒（比一次正常解压还短会把好包判成失败）', mod.dlInstallStallMs() === 5000, 'ms=' + mod.dlInstallStallMs());
    globalThis.__weEnv = { [envKey]: '999999999' };
    check('㉔ 覆盖值被夹到上限 30 分钟（更长就等于回到"永远卡住"）', mod.dlInstallStallMs() === 30 * 60 * 1000, 'ms=' + mod.dlInstallStallMs());
    globalThis.__weEnv = { [envKey]: 'abc' };
    check('㉔ 非法值回落默认（值写错不该让功能失效）', mod.dlInstallStallMs() === 90000, 'ms=' + mod.dlInstallStallMs());
    if (envBackup === undefined) delete globalThis.__weEnv; else globalThis.__weEnv = envBackup;
    check('㉔ 宿主侧的解析（读环境变量、夹取同一区间）与客户端默认值一致',
      (() => { const d = readFileSync(join(ROOT, 'lib', 'routes', 'downloads.js'), 'utf8'); return /INSTALL_STALL_DEFAULT_MS = 90000/.test(d) && /INSTALL_STALL_MIN_MS = 5000/.test(d) && /INSTALL_STALL_MAX_MS = 30 \* 60 \* 1000/.test(d); })());

    // ── ② 挂载自愈：done + 未落地 ⇒ 自动补装一次 ─────────────────────────────
    const jobs = [{ id: 'jc', url: 'https://site.example/media/skins/rainy-night.zip', kind: 'skin', status: 'done' }];
    const items = [{ id: 'rainy-night', title: '鲸鱼娘 · 雨夜', url: 'https://site.example/media/skins/rainy-night.zip' }];
    const okSeen = [];
    const failSeen = [];
    const base = {
      kind: 'skin', jobs, items, path: '/skins/install',
      body: (it) => ({ id: it.id, url: it.url }),
      onOk: (it) => okSeen.push(it.id),
      onFail: (it, code) => failSeen.push([it.id, code]),
    };
    posts.length = 0;
    const tried1 = await mod.dlHealStuck(Object.assign({}, base, { doneOf: () => false }));
    check('㉔ 挂载自愈：done + 未落地 ⇒ 自动打**一次**安装请求（走缓存，不重新下载）',
      posts.length === 1 && posts[0].path === '/skins/install' && posts[0].body.id === 'rainy-night' && tried1.length === 1,
      JSON.stringify(posts));
    check('㉔ 补装只带 id + url（宿主据此从本地 zip 解压，不需要重新入队下载）',
      posts[0] && Object.keys(posts[0].body).sort().join(',') === 'id,url', JSON.stringify(posts[0] && posts[0].body));
    check('㉔ 安装成功 ⇒ onOk（页签据此 cards.markOk()）', okSeen.length === 1 && failSeen.length === 0, JSON.stringify({ okSeen, failSeen }));
    check('㉔ markOk 之后卡片状态就是 done（不再停在「解压/落位中…」）',
      (() => { const d = st({ job: { id: 'jc', status: 'done' }, done: true }); return d.phase === 'done' && d.disabled === true; })());

    // 防抖：同一 id 每次会话（= 同一个模块作用域）只自动尝试 1 次
    await mod.dlHealStuck(Object.assign({}, base, { doneOf: () => false }));
    check('㉔ 防抖：同一 id 同一会话内第二次不再发请求（切页签重新挂载也不重打）', posts.length === 1, 'posts=' + posts.length);
    await mod.dlHealStuck(Object.assign({}, base, { doneOf: () => false }));
    await mod.dlHealStuck(Object.assign({}, base, { doneOf: () => false }));
    check('㉔ 防抖对多次挂载同样成立（计数恒为 1）', posts.length === 1, 'posts=' + posts.length);
    check('㉔ 防抖是"记账一次"而不是"永远不试"：换一个 id 仍会试（判据没有把自愈关死）',
      (() => { const fresh = mod.dlHealOnce('skin:another-skin'); const again = mod.dlHealOnce('skin:another-skin'); return fresh === true && again === false; })());

    // 负对照：已经落地 / job 还在下 ⇒ 一条请求都不发
    posts.length = 0;
    await mod.dlHealStuck({
      kind: 'boot', jobs: [{ id: 'jb', url: 'u-boot', kind: 'boot', status: 'done' }],
      items: [{ id: 'c1', url: 'u-boot' }], doneOf: () => true,
      path: '/boot/download', body: (it) => ({ id: it.id }),
    });
    check('㉔ 负对照：已落地 ⇒ 一条请求都不发', posts.length === 0, 'posts=' + posts.length);
    await mod.dlHealStuck({
      kind: 'boot', jobs: [{ id: 'jb', url: 'u-boot', kind: 'boot', status: 'running' }],
      items: [{ id: 'c2', url: 'u-boot' }], doneOf: () => false,
      path: '/boot/download', body: (it) => ({ id: it.id }),
    });
    check('㉔ 负对照：job 还在下（running）⇒ 不发收尾请求', posts.length === 0, 'posts=' + posts.length);
    // 开机动画 / 桌宠走同一个执行体，只是收尾接口不同
    await mod.dlHealStuck({
      kind: 'boot', jobs: [{ id: 'jb', url: 'u-boot', kind: 'boot', status: 'done' }],
      items: [{ id: 'c3', url: 'u-boot' }], doneOf: () => false,
      path: '/boot/download', body: (it) => ({ id: it.id }),
    });
    check('㉔ 开机动画也走同一个执行体：done + 未落地 ⇒ 打 /boot/download', posts.length === 1 && posts[0].path === '/boot/download', JSON.stringify(posts));
    posts.length = 0;
    await mod.dlHealStuck({
      kind: 'pet', jobs: [{ id: 'jp', url: 'u-pet', kind: 'pet', status: 'done' }],
      items: [{ id: 'p1', url: 'u-pet' }], doneOf: () => false,
      path: '/pets/install', body: (it) => ({ id: it.id }),
    });
    check('㉔ 桌宠也走同一个执行体：done + 未落地 ⇒ 打 /pets/install', posts.length === 1 && posts[0].path === '/pets/install', JSON.stringify(posts));

    // ── ③ 失败：卡片带原因（不是静默回「安装」）──────────────────────────────
    const mod2 = makeMod(async () => ({ ok: false, status: 422, data: { ok: false, error: 'no-skin-json' } }));
    const fail2 = [];
    await mod2.dlHealStuck({
      kind: 'skin', jobs, items, doneOf: () => false, path: '/skins/install',
      body: (it) => ({ id: it.id, url: it.url }),
      onOk: () => { throw new Error('不该走 onOk'); },
      onFail: (it, code) => fail2.push([it.id, code]),
    });
    check('㉔ 补装失败 ⇒ onFail 带**宿主给的错误码**（不是裸 failed）',
      fail2.length === 1 && fail2[0][1] === 'no-skin-json', JSON.stringify(fail2));
    const failCard = st({ job: { id: 'jc', status: 'done' }, err: { code: 'no-skin-json' } });
    check('㉔ 失败后卡片带原因（说得出"包里没有 skin.json"）+「重试」可点',
      failCard.phase === 'failed' && failCard.retry === true && failCard.reason.includes('skin.json'),
      JSON.stringify(failCard));
    check('㉔ 负对照：这条失败不会被「done 但没落地」盖回 installing（否则失败又变成静默）',
      failCard.phase !== 'installing');
    const mod3 = makeMod(async () => { throw new Error('network down'); });
    const fail3 = [];
    await mod3.dlHealStuck({
      kind: 'skin', jobs, items, doneOf: () => false, path: '/skins/install',
      body: (it) => ({ id: it.id, url: it.url }), onFail: (it, code) => fail3.push([it.id, code]),
    });
    check('㉔ 自愈**抛错**也不静默：落到 network 码并写回卡片', fail3.length === 1 && fail3[0][1] === 'network', JSON.stringify(fail3));
    check('㉔ 自愈绝不把异常抛给页签（单张卡片失败不影响整页）',
      (await mod3.dlHealStuck({ kind: 'skin', jobs, items: [{ id: 'x', url: 'nope' }], doneOf: () => false, path: '/skins/install', body: () => ({}) })) !== null);

    // ── ④ 可观测性：窗口随 list 下发；安装日志在 warn 档且四要素齐全 ────────────
    const bootTab = readFileSync(join(ROOT, 'src', 'panel-tabs-boot.js'), 'utf8');
    const petsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-pets.js'), 'utf8');
    const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
    const downloadsRoute = readFileSync(join(ROOT, 'lib', 'routes', 'downloads.js'), 'utf8');
    const skinsRoute = readFileSync(join(ROOT, 'lib', 'routes', 'skins.js'), 'utf8');
    const bootRoute = readFileSync(join(ROOT, 'lib', 'routes', 'boot.js'), 'utf8');
    const petsRoute = readFileSync(join(ROOT, 'lib', 'routes', 'pets.js'), 'utf8');
    check('㉔ 三个页签挂载时都走**同一个**自愈执行体（不是各写一套）',
      [skinsTab, bootTab, petsTab].every((t) => /dlHealStuck\(/.test(t))
      && (src.match(/function dlHealStuck\(/g) || []).length === 1);
    check('㉔ 三个模块的收尾接口各自正确（skin → /skins/install、boot → /boot/download、pet → /pets/install）',
      /path: "\/skins\/install"/.test(skinsTab) && /path: "\/boot\/download"/.test(bootTab) && /path: "\/pets\/install"/.test(petsTab));
    check('㉔ 三个页签都把自愈失败写回卡片（cards.fail + dlFailReason，不静默）',
      [skinsTab, bootTab, petsTab].every((t) => /cards\.fail\(/.test(t) && /dlFailReason\(/.test(t)));
    check('㉔ 宿主把超时窗口随 /downloads/list 下发（浏览器里没有 process.env）',
      /installStallMs: installStallMs\(\)/.test(downloadsRoute) && /function installStallMs\(\)/.test(downloadsRoute));
    check('㉔ 两端默认值一致：都是 90 秒（漂开就会各判各的）',
      /INSTALL_STALL_DEFAULT_MS = 90000/.test(downloadsRoute) && /DL_INSTALL_STALL_MS = 90000/.test(src));
    check('㉔ 秒表真的在走（useDownloadJobs 停表时，否则 90 秒的超时永远不触发）',
      /setInterval\(\(\) => \{[\s\S]{0,200}stallRef\.current\.values\(\)/.test(src) && /installingSince: since/.test(src));
    check('㉔ 皮肤安装成功/失败日志在 warn 档，且带 id / 耗时 / 结果 / 错误码',
      /function logInstallResult\(log, o\)/.test(skinsRoute)
      && /'id=' \+ String\(x\.id/.test(skinsRoute) && /'result=' \+ String\(x\.result/.test(skinsRoute)
      && /'took=' \+ took/.test(skinsRoute) && /'code=' \+ String\(x\.code/.test(skinsRoute)
      && /log\('skins install ' \+ parts\.join\(' '\), 'warn'\)/.test(skinsRoute));
    check('㉔ 开机动画 / 桌宠的收尾日志同样在 warn 档并带四要素',
      /\[boot\] finish id=' \+ id \+ ' result=' \+ result \+ ' took='/.test(bootRoute)
      && /'ms code=' \+ \(code \|\| '-'\)/.test(bootRoute)
      && /\[pets\] finish id=' \+ id \+ ' result=' \+ result \+ ' took='/.test(petsRoute)
      && /\[pets\] install id=' \+ id \+ ' result=/.test(petsRoute)
      && /'ms code=' \+ String\(code \|\| 'failed'\)/.test(petsRoute));
    check('㉔ 负对照：把结果日志降回 info（去掉 warn）时同一条判据不成立',
      !/log\('skins install ' \+ parts\.join\(' '\), 'warn'\)/.test(skinsRoute.split(", 'warn')").join(')')));
  }
}

/* ㉕ 4.23.6（**另一台机器 Lenovo 实测**）：**"任务丢了"导致的永久转圈**。
   现象：卡片「鲸鱼娘·雨夜」永远「解压/落位中…」，但 `/skins/list` 的 installed 里没有它，
   而 `/downloads/list` 里**根本没有**那条 job（连 url 里的 sha 都搜不到）
   ⇒ 前端在等一个不存在的 jobId（宿主重启 / 队列被重置 / job 被清理），
   而旧循环"查不到就静默继续"，一路转到 30 分钟上界。
   判据：① 连续 N 次查不到 ⇒ 判 lost（不是无限轮询）；
        ② 判失败**之前**先核一次 installed（装好了 ⇒ done）；
        ③ 本地没有对应 job 的卡片 ⇒ 回落 idle、可点安装。 */
{
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs(');
  const head = (a >= 0 && b > a) ? src.slice(a, b) : '';
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  let listedJobs = [];
  let listCalls = 0;
  const mod = (() => {
    try {
      return new Function('weT', 'apiPostJson', 'apiJson', head
        + '\nreturn { DL_JOB_MISS_LIMIT, dlAwaitJob, dlStaleCards, dlCardState, dlFailReason, dlHealStuck };')(
        shim,
        async () => ({ ok: false, status: 500, data: null }),
        async () => { listCalls += 1; return { ok: true, status: 200, data: { jobs: listedJobs } }; },
      );
    } catch { return null; }
  })();
  check('㉕ 轮询容错那一段能被取出来真跑', Boolean(mod), mod ? 'ok' : 'slice=' + head.length);

  if (mod) {
    const labels = { idle: '安装', done: '已安装', failed: '重试' };
    check('㉕ 连续查不到的阈值 = 5 次（5 × 1.5s ≈ 7.5s，不是 30 分钟）', mod.DL_JOB_MISS_LIMIT === 5, 'limit=' + mod.DL_JOB_MISS_LIMIT);

    listedJobs = [];
    listCalls = 0;
    const t0 = Date.now();
    const lost = await mod.dlAwaitJob('job-that-never-exists', 120000);
    const tookMs = Date.now() - t0;
    check('㉕ jobId 连续 5 次查不到 ⇒ 判 lost（不再无限轮询）',
      Boolean(lost) && lost.status === 'lost' && listCalls >= mod.DL_JOB_MISS_LIMIT,
      JSON.stringify({ lost, listCalls }));
    check('㉕ 从"查不到"到失败只用 ≈7.5 秒（旧实现要 30 分钟）', tookMs < 20000, 'took=' + tookMs + 'ms');
    check('㉕ 「任务丢了」有独立的人话原因（不是裸 failed）',
      mod.dlFailReason('job-lost').includes('任务已丢失') && mod.dlFailReason('job-lost') !== 'failed',
      mod.dlFailReason('job-lost'));
    const lostCard = mod.dlCardState({ id: 'c1', labels, err: { code: 'job-lost' } });
    check('㉕ 卡片落在 failed +「重试」可点，且写着原因',
      lostCard.phase === 'failed' && lostCard.retry === true && lostCard.disabled === false && lostCard.reason.includes('任务已丢失'),
      JSON.stringify(lostCard));

    // 负对照：job 真的在列表里 ⇒ 立刻按它的状态返回，绝不误判 lost
    listedJobs = [{ id: 'job-live', status: 'done', url: 'u', kind: 'skin' }];
    listCalls = 0;
    const got = await mod.dlAwaitJob('job-live', 120000);
    check('㉕ 负对照：job 在列表里 ⇒ 正常返回它的状态（不会误判成 lost）',
      Boolean(got) && got.status === 'done' && listCalls === 1, JSON.stringify({ got, listCalls }));
    // 负对照：列表请求**失败**（不是"查不到"）不许记账 —— 网络抖动不该把任务判丢
    const modErr = (() => {
      try {
        return new Function('weT', 'apiPostJson', 'apiJson', head + '\nreturn { DL_JOB_MISS_LIMIT, dlAwaitJob };')(
          shim, async () => ({ ok: false }),
          async () => { throw new Error('network down'); },
        );
      } catch { return null; }
    })();
    const stillWaiting = await modErr.dlAwaitJob('job-x', 4000);
    check('㉕ 负对照：/downloads/list 自己请求失败 ⇒ 判 timeout 而不是 lost（网络抖动不等于任务丢失）',
      stillWaiting && stillWaiting.status === 'timeout', JSON.stringify(stillWaiting));

    // ③ 本地没有对应 job ⇒ 回落 idle、可点安装
    const items = [{ id: 'rainy-night', url: 'u1' }];
    check('㉕ 本地没有对应 job ⇒ 判为残留（页签据此 settle ⇒ 回落 idle）',
      mod.dlStaleCards([], 'skin', items, () => false).length === 1);
    check('㉕ 负对照：有对应 job ⇒ 不是残留（不许把正在下的卡片打回 idle）',
      mod.dlStaleCards([{ id: 'j1', url: 'u1', kind: 'skin', status: 'running' }], 'skin', items, () => false).length === 0);
    check('㉕ 负对照：已装好 ⇒ 不是残留',
      mod.dlStaleCards([], 'skin', items, () => true).length === 0);
    const idleCard = mod.dlCardState({ id: 'rainy-night', labels, job: null, done: false });
    check('㉕ 无 job 的卡片状态是 idle 且**可点**（回落「安装」，不是灰的）',
      idleCard.phase === 'idle' && idleCard.disabled === false && idleCard.retry === false,
      JSON.stringify(idleCard));

    // ④ 三个页签的接线（源码级：顺序也判 —— 必须先核 installed 再判失败）
    const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
    const bootTab = readFileSync(join(ROOT, 'src', 'panel-tabs-boot.js'), 'utf8');
    const petsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-pets.js'), 'utf8');
    check('㉕ 皮肤页签：连续查不到 ⇒ 先核 installed、再判 job-lost（顺序不许反）',
      /jobMisses >= DL_JOB_MISS_LIMIT/.test(skinsTab)
      && /const already = await skinInstalledNow\(/.test(skinsTab)
      && /cards\.fail\(cardId, "job-lost"\)/.test(skinsTab)
      && skinsTab.indexOf('await skinInstalledNow(') > 0
      && skinsTab.indexOf('await skinInstalledNow(') < skinsTab.indexOf('cards.fail(cardId, "job-lost")'));
    check('㉕ 皮肤页签：连续计数在**查到 job** 时清零（抖一下就判丢是错的）',
      /if \(job\) jobMisses = 0;/.test(skinsTab));
    check('㉕ 开机动画 / 桌宠：lost 与 timeout 都先核列表再判失败',
      /done\.status === "lost"/.test(bootTab) && /bootInstalledNow\(cardId\)/.test(bootTab)
      && /done\.status === "lost"/.test(petsTab) && /petsInstalledNow\(cardId\)/.test(petsTab));
    check('㉕ 三个页签都在挂载时清理"无 job 的残留卡片"（回落 idle、可点安装）',
      [skinsTab, bootTab, petsTab].every((t) => /dlStaleCards\(/.test(t) && /cards\.settle\(/.test(t)));
  }
}

let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
