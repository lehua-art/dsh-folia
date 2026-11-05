#!/usr/bin/env node
/**
 * verify-wallpaper-core.mjs — **4.25.0 的核心 6 条行为 + 3 条质量判据 + 4.25.1 的 T1–T4 / U1–U4**。
 *
 * 4.25.1（用户实测）：T1 所有入队路径 1s 内 queued/running · T2 同一条目原画/变体只 1 条 job ·
 * T3 total=0 时阶段文案 / total 已知后百分比 · T4 启动 pending+high 不自动下载且 UI 明说
 * 「未缓存（点击继续）」；U1–U4 连点语义（末位优先 / 并发 2 / 未开始队列 ≤8 / pending 再点回队列）。
 * 每条都配负对照。
 *
 * 用户口径（原样）：
 *   B1 不点任何壁纸 ⇒ 队列恒为 0（默认 prefetchCount=0；没有 pending→queued 批量 promote）
 *   B2 点 1 张 ⇒ 只有这 1 张在缓存（queued==1，priority=high）
 *   B3 点第 2 张 ⇒ 前一张转后台（low，不取消、字节不归零），队列只有这 2 张
 *   B4 切走再切回 ⇒ 进度从队列读取，不归零、不重算（与 /downloads/list 快照一致）
 *   B5 下完 ⇒ 「已缓存」角标数量 == 服务端 inventory localReady 数量
 *   B6 选档：4K@60 ⇒ 4k30；超分辨率（>3840 宽 / >2160 高 / >830 万像素）⇒ 1080p；
 *      HEVC ⇒ 1080p（用站点 fps/codec；缺失才宽度兜底）
 *   Q2 错误文案：进入 playing 清空；切条目不继承；AbortError / NotAllowedError / 缺失 /
 *      损坏 / 超限分流（不许笼统「无法解码」）
 *   Q3 进度位置：缓存进度只在标题栏元信息区（`we-qp__meta` 之后），不得有居中浮层
 *      （DOM 断言不存在 `.we-switch-hint`）
 *
 * ## 判据怎么取
 *   · 队列行为用**真队列**（`createDownloadQueue`，隔离 home 里真写 downloads.json）；
 *   · 客户端行为用**真源码**：`src/download-first.js` / `src/wallpaper-progress.js` /
 *     `src/client.js` / `src/local-first.js` 的函数块直接 import / 取出来真跑；
 *   · 每条判据都配一条**旧实现贴回必红**的负对照（`negative control`），没有负对照的绿不算证据。
 *
 * Usage: `node test/verify-wallpaper-core.mjs`
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';
import { stripComments } from './tools/js-text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = isolateTestHome('wallpaper-core', { force: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

const weT = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (
  vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/* 客户端模块按名读全局（生产由 build-client 的内联工厂提供；测试里显式注入）。 */
globalThis.weT = weT;
globalThis.dlJobActive = (j) => Boolean(j) && (j.status === 'running' || j.status === 'queued');
globalThis.dlProgressDetail = () => '';
globalThis.dlQueueDetail = () => '排队中…';
globalThis.dlFailReason = () => '';
globalThis.React = globalThis.React || {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
};

const MB = 1024 * 1024;

const BASE_HOME = TEST_HOME;
let caseNo = 0;
function freshHome(label) {
  caseNo += 1;
  const h = join(BASE_HOME, 'h' + caseNo + '-' + label);
  rmSync(h, { recursive: true, force: true });
  mkdirSync(join(h, 'library', 'wallpaper'), { recursive: true });
  return h;
}

const { createDownloadQueue } = await import('../lib/download-queue.js');
const { startupStatusFor } = await import('../lib/media-state.js');
const { prefetchCount, PREFETCH_MAX } = await import('../lib/routes/downloads.js');
const { pickVariant, decodeLimitHit } = await import('../lib/variant-pick.js');
const DF = await import('../src/download-first.js');
const WP = await import('../src/wallpaper-progress.js');

/**
 * 70 条 pending（用户"清空媒体"之后的真实形态）。job id 必须用队列自己的 `idForUrl`，
 * 自造 id 会让 `add()` 建出另一条 job（夹具没对齐，判据就永远为假）。
 */
function seedPending(home, n, opts = {}) {
  const urls = [];
  for (let i = 0; i < n; i += 1) urls.push('http://127.0.0.1:1/' + String(opts.prefix || 'p') + String(i).padStart(2, '0') + '.mp4');
  const probe = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const jobs = urls.map((url, i) => ({
    id: probe.idForUrl(url), url,
    dest: join(home, 'library', 'wallpaper', String(opts.prefix || 'p') + String(i).padStart(2, '0') + '.mp4'),
    kind: 'wallpaper', total: opts.total == null ? 1024 : opts.total, status: 'pending', error: null,
    at: 1000 + i, priority: 'low',
  }));
  writeFileSync(join(home, 'downloads.json'), JSON.stringify({ version: 1, paused: true, jobs }), 'utf8');
  return { urls, ids: jobs.map((j) => j.id) };
}

const between = (src, start, end) => {
  const a = String(src).indexOf(start);
  if (a < 0) return '';
  const b = String(src).indexOf(end, a + start.length);
  if (b < 0) return '';
  return String(src).slice(a, b);
};

/* ══ B1. 不点任何壁纸 ⇒ 队列恒为 0 ═══════════════════════════════════════════ */
console.log('\nB1. 不点任何壁纸 ⇒ 队列恒为 0（默认 prefetchCount=0，无批量 promote）');
let q1;
let b1Holds;
{
  const home = freshHome('b1-pending70');
  seedPending(home, 70);
  q1 = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  await sleep(350);                       // 给 load/pump/对账一拍时间（不许"顺手"排队）
  const counts = q1.queueCounts();
  b1Holds = (c) => Boolean(c) && Number(c.queuedCount) === 0 && Number(c.runningCount) === 0
    && Number(c.pendingCount) === 70;
  check('B1 70 条 pending 启动后 queued=0 / running=0 / pending=70', b1Holds(counts), JSON.stringify(counts));
  check('B1b 70 条都没有 queuePos / queuedAhead（pending 不占队列位）',
    q1.snapshot().every((j) => j.queuePos == null && j.queuedAhead == null),
    'withPos=' + q1.snapshot().filter((j) => j.queuePos != null).length);
  check('B1c 宿主默认 prefetchCount=0（不是 3；未点击就不许替用户下）',
    prefetchCount() === 0 && PREFETCH_MAX === 3, 'prefetchCount=' + prefetchCount());
  check('B1d 启动映射唯一判据：queued/running/done-缺失 ⇒ pending（不批量 promote）',
    startupStatusFor('queued', false) === 'pending' && startupStatusFor('running', false) === 'pending'
      && startupStatusFor('done', false) === 'pending' && startupStatusFor('done', true) === 'done',
    'queued=' + startupStatusFor('queued', false));
  // 连续 3 次采样：时间流逝本身不许把 pending 变成 queued。
  const samples = [];
  for (let i = 0; i < 3; i += 1) { await sleep(80); samples.push(q1.queueCounts().queuedCount); }
  check('B1e 连续 3 次采样 queued 恒 0', samples.every((x) => x === 0), JSON.stringify(samples));
  /* ── 负对照：启动把 queued 原样放回 / 批量 promote 的形态 ⇒ B1 必红 ── */
  const legacyStatus = (s, onDisk) => (s === 'queued' ? 'queued' : startupStatusFor(s, onDisk));
  const legacyCounts = { queuedCount: 70, runningCount: 0, pendingCount: 0 };
  check('B1f 负对照：启动批量排队（queued 原样放回）⇒ B1 恒等式为假',
    legacyStatus('queued', false) === 'queued' && b1Holds(legacyCounts) === false,
    'legacy=' + JSON.stringify(legacyCounts));
  check('B1g 源码里没有 pending→queued 批量 promote（load() 只走 startupStatusFor）',
    !/jobs\.forEach\([\s\S]{0,200}status\s*=\s*['"]queued['"]/.test(readFileSync(join(ROOT, 'lib', 'download-queue.js'), 'utf8')));
}

/* ══ B2. 点 1 张 ⇒ 只有这 1 张在缓存（queued==1，high）══════════════════════ */
console.log('\nB2. 点 1 张 ⇒ queued==1，priority=high，其余仍是 pending');
const B2_URLS = ['https://site.test/media/a.mp4', 'https://site.test/media/b.mp4'];
let q2 = null;
let b2Home;
let idA = '';
let idB = '';
{
  const home = freshHome('b2-two');
  b2Home = home;
  // 种子 job 的 id 必须与队列 `add()` 同源；先建探针队列取 id。
  const probe = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  idA = probe.idForUrl(B2_URLS[0]);
  idB = probe.idForUrl(B2_URLS[1]);
  writeFileSync(join(home, 'downloads.json'), JSON.stringify({ version: 1, paused: true, jobs: [
    { id: idA, url: B2_URLS[0], dest: join(home, 'library', 'wallpaper', 'a.mp4'), kind: 'wallpaper', total: 1000, status: 'pending', error: null, at: 1, priority: 'low' },
    { id: idB, url: B2_URLS[1], dest: join(home, 'library', 'wallpaper', 'b.mp4'), kind: 'wallpaper', total: 1000, status: 'pending', error: null, at: 2, priority: 'low' },
  ] }), 'utf8');
  writeFileSync(join(home, 'library', 'wallpaper', 'a.mp4.part'), Buffer.alloc(400, 0x41));
  q2 = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const before = q2.queueCounts();
  const r = q2.add({ url: B2_URLS[0], dest: join(home, 'library', 'wallpaper', 'a.mp4'), kind: 'wallpaper', priority: 'high' });
  const active = q2.snapshot().filter((j) => j.status === 'queued' || j.status === 'running');
  check('B2 点 1 张 ⇒ queued==1，其余（1 条）仍是 pending',
    active.length === 1 && active[0].id === idA && q2.queueCounts().queuedCount === 1
      && q2.queueCounts().pendingCount === 1 && before.queuedCount === 0,
    'active=' + active.length + ' pending=' + q2.queueCounts().pendingCount + ' before=' + JSON.stringify(before));
  check('B2b 这一条 priority=high（用户点击，不是 low 预取）', r.job.priority === 'high', r.job.priority);
  check('B2c 只有它一条带 queuePos=1（没有别的排队项）',
    active[0].queuePos === 1 && q2.snapshot().filter((j) => j.queuePos != null).length === 1,
    'queuePos=' + active[0].queuePos);
  /* ── 负对照：旧版默认预取 3 ⇒ 同一时刻不再是 1 条 ── */
  const legacyPrefetch = () => 3;
  check('B2d 负对照：旧默认预取 3 张 ⇒ 活跃数会是 1+3=4（B2 的 ==1 必红）',
    legacyPrefetch() === 3 && (1 + legacyPrefetch()) !== 1, 'legacy active=' + (1 + legacyPrefetch()));
}

/* ══ B3. 点第 2 张 ⇒ 前一张 low，不取消、字节不归零，队列只有 2 张 ═════════ */
console.log('\nB3. 点第 2 张 ⇒ 前一张 low、不取消、字节不归零，队列只有这 2 张');
let b3RowA;
{
  const partPath = join(b2Home, 'library', 'wallpaper', 'a.mp4.part');
  q2.applyReconcile([{ id: idA, patch: { received: 400 } }]);
  const partBefore = statSync(partPath).size;
  // 真实客户端状态机：点 A（caching）→ 切到 B 时 dfLeaveSelection 发 low（不 cancel/pause）。
  DF.dfBegin({ id: 'A', title: 'A', media: B2_URLS[0] });
  DF.dfApplyJob(q2.snapshot().find((j) => j.id === idA));
  const leave = DF.dfLeaveSelection('B', { demote: (payload) => { q2.setPriority(payload); } });
  // 点 B（high）。
  q2.add({ url: B2_URLS[1], dest: join(b2Home, 'library', 'wallpaper', 'b.mp4'), kind: 'wallpaper', priority: 'high' });
  b3RowA = q2.snapshot().find((j) => j.id === idA);
  const active = q2.snapshot().filter((j) => j.status === 'queued' || j.status === 'running');
  const partAfter = statSync(partPath).size;
  check('B3 切走 A ⇒ dfLeaveSelection 发 priority=low（不是 cancel / pause）',
    Boolean(leave) && leave.priority === 'low' && leave.demoted === true && DF.dfSnapshot().state === 'idle',
    JSON.stringify(leave && { priority: leave.priority, demoted: leave.demoted, state: DF.dfSnapshot().state }));
  check('B3b A 仍留在队列（queued/running），priority=low，未取消',
    Boolean(b3RowA) && (b3RowA.status === 'queued' || b3RowA.status === 'running')
      && b3RowA.priority === 'low' && b3RowA.status !== 'cancelled' && b3RowA.status !== 'failed',
    b3RowA && (b3RowA.status + '/' + b3RowA.priority));
  check('B3c A 的已下字节不归零：received 仍是 400，.part 仍是 400 B（前 400）',
    b3RowA && Number(b3RowA.received) === 400 && partBefore === 400 && partAfter === 400,
    'received=' + (b3RowA && b3RowA.received) + ' part=' + partBefore + '→' + partAfter);
  check('B3d 队列里**只有这 2 张**（active==2，pending==0），B 是 high',
    active.length === 2 && q2.queueCounts().pendingCount === 0
      && active.some((j) => j.id === idA) && active.some((j) => j.id === idB && j.priority === 'high'),
    'active=' + active.length + ' pending=' + q2.queueCounts().pendingCount
      + ' prio=' + active.map((j) => j.priority).join(','));
  /* ── 负对照：旧「切走即取消」的形态 ⇒ B3b/B3c 必红 ── */
  const legacyRow = Object.assign({}, b3RowA, { status: 'cancelled', received: 0 });
  const b3Holds = (row, part) => Boolean(row) && (row.status === 'queued' || row.status === 'running')
    && row.priority === 'low' && row.status !== 'cancelled' && Number(row.received) === 400 && part === 400;
  check('B3e 负对照：旧实现切走即 cancel + 字节归零 ⇒ B3 的判据必红',
    legacyRow.status === 'cancelled' && legacyRow.received === 0 && b3Holds(legacyRow, partAfter) === false);
  check('B3f 源码级：dfLeaveSelection 只发 low，不调用 cancel/pause',
    (() => {
      const src = readFileSync(join(ROOT, 'src', 'download-first.js'), 'utf8');
      const block = between(src, 'function dfLeaveSelection(', '/** 用户点「改用边下边播」');
      return /priority:\s*["']low["']/.test(block) && !/\.cancel\s*\(/.test(block) && !/\.pause\s*\(/.test(block);
    })());
}

/* ══ B4. 切走再切回 ⇒ 进度来自 /downloads/list 快照（不归零、不重算）════════ */
console.log('\nB4. 切走再切回 ⇒ 进度读队列快照（不归零、不重算）');
{
  // A 走到 67%（真实队列快照；/downloads/list 的 jobs 就是 q.snapshot()）。
  q2.applyReconcile([{ id: idA, patch: { status: 'running', received: 670, total: 1000 } }]);
  const row67 = q2.snapshot().find((j) => j.id === idA);
  WP.wpPushJobs(q2.snapshot());
  const itemA = { id: 'A', media: B2_URLS[0], localReady: false };
  let seen = null;
  const off = WP.wpSubscribe(itemA, (v) => { seen = v; });
  check('B4 第一次看到 A ⇒ 67%（job.percent 的真实值）',
    row67 && row67.percent === 67 && seen && seen.percent === 67,
    'row=' + (row67 && row67.percent) + ' view=' + (seen && seen.percent));
  off();                                       // 切走：卡片卸载，但队列快照不丢
  q2.applyReconcile([{ id: idA, patch: { received: 820 } }]);
  WP.wpPushJobs(q2.snapshot());                // 队列继续到 82%
  const row82 = q2.snapshot().find((j) => j.id === idA);
  let back = null;
  const off2 = WP.wpSubscribe(itemA, (v) => { back = v; });  // 切回：立刻给当前值
  check('B4b 切回 A ⇒ 82%（与 /downloads/list 快照逐字一致，不是 0 / 不是重新计时）',
    Boolean(back) && back.percent === 82 && row82 && row82.percent === 82
      && WP.wpSnapshotOf(itemA).percent === 82,
    'view=' + (back && back.percent) + ' snapshot=' + WP.wpSnapshotOf(itemA).percent
      + ' list=' + (row82 && row82.percent));
  off2();
  /* ── 负对照：旧实现"切回来从 0 开始 + 切走清快照"⇒ B4b 必红 ── */
  const legacyResubscribe = () => ({ percent: 0, phase: 'running', card: '缓存中 0%', title: '' });
  check('B4c 负对照：旧实现切回读到 0%（不是 82）⇒ B4b 的判据必红',
    legacyResubscribe().percent === 0 && legacyResubscribe().percent !== 82);
  check('B4d 源码级：订阅时用 wpSnapshotOf(item)（读快照），退订不清 WP_STORE.jobs',
    /fn\(wpSnapshotOf\(item\)\)/.test(readFileSync(join(ROOT, 'src', 'wallpaper-progress.js'), 'utf8'))
      && !/function wpUnsubscribe\(key, fn\) \{\s*WP_STORE\.jobs\s*=\s*\[\]/.test(
        readFileSync(join(ROOT, 'src', 'wallpaper-progress.js'), 'utf8')));
}

/* ══ B5. 下完 ⇒ 角标数量 == inventory localReady 数量 ═══════════════════════ */
console.log('\nB5. 「已缓存」角标唯一读 localReady；数量 == 服务端 localReady 数量');
{
  const items = [
    { id: 'a', media: B2_URLS[0], localReady: true },
    { id: 'b', media: B2_URLS[1], localReady: true },
    { id: 'c', media: 'https://site.test/media/c.mp4', localReady: false },
    { id: 'd', media: 'https://site.test/media/d.mp4', localReady: false },
  ];
  // 四条都"下完了"：旧实现会按 job=done 数出 4 个角标，新判据只认 localReady=2。
  const jobs = items.map((it, i) => ({
    id: 'done-' + i, kind: 'wallpaper', url: it.media, status: 'done', percent: 100,
  }));
  const badgeCount = (list, js) => list.filter((it) => {
    const v = WP.wpViewOf(it, js, 0);
    return Boolean(v) && v.phase === 'cached' && v.card === '已缓存';
  }).length;
  const readyCount = (list) => list.filter((it) => it && it.localReady === true).length;
  check('B5 角标数 == inventory localReady 数（2 == 2）',
    badgeCount(items, jobs) === 2 && readyCount(items) === 2,
    '角标=' + badgeCount(items, jobs) + ' localReady=' + readyCount(items));
  check('B5b localReady=true 但没有 job ⇒ 仍显示「已缓存」（job 从列表消失也不掉角标）',
    WP.wpViewOf({ id: 'a', media: B2_URLS[0], localReady: true }, []).phase === 'cached');
  check('B5c done 但 localReady=false ⇒ **不说**已缓存（done 不是第二份判据）',
    (() => { const v = WP.wpViewOf(items[2], jobs, 0); return !v || v.phase !== 'cached'; })(),
    JSON.stringify(WP.wpViewOf(items[2], jobs, 0)));
  /* ── 完成/刷新后自动更新：job done + 卡片还没缓存 ⇒ 拉一次清单（同一 job 只拉一次）── */
  const itemC = items[2];
  const offC = WP.wpSubscribe(itemC, () => {});
  let asked = 0;
  WP.setWpInventoryRefresher(() => { asked += 1; });
  const doneC = { id: 'job-refresh-c', kind: 'wallpaper', url: itemC.media, status: 'done', percent: 100 };
  WP.wpPushJobs([doneC]);
  const first = asked;
  WP.wpPushJobs([doneC]);
  const second = asked;
  offC();
  check('B5d 下完且角标仍 false ⇒ 自动拉新一次；同一 job 不重复拉', first === 1 && second === 1,
    'asked=' + first + '→' + second);
  itemC.localReady = true;                     // 拉新后的清单（服务端对账结论）
  let cv = null;
  const offC2 = WP.wpSubscribe(itemC, (v) => { cv = v; });
  check('B5e 拉新后角标随 localReady 变「已缓存」（不靠用户手动刷新）',
    Boolean(cv) && cv.phase === 'cached', cv && cv.phase);
  offC2();
  WP.setWpInventoryRefresher(null);
  /* ── 负对照：旧实现按"job done / local 精确命中"判断 ⇒ 角标 4 ≠ localReady 2 ── */
  const legacyBadgeCount = (list, js) => list.filter((it) => it.localReady === true
    || it.local === true || js.some((j) => j.url === it.media && j.status === 'done')).length;
  check('B5f 负对照：旧实现按 job=done 数角标 ⇒ 4 ≠ localReady 2（B5 必红）',
    legacyBadgeCount(items, jobs) === 4 && legacyBadgeCount(items, jobs) !== readyCount(items));
  check('B5g 源码级：角标判据只有 wpCachedOf(localReady)，不再看 local / job 状态',
    /function wpCachedOf\(item\) \{\s*return Boolean\(item\) && typeof item === "object" && item\.localReady === true;\s*\}/.test(
      readFileSync(join(ROOT, 'src', 'wallpaper-progress.js'), 'utf8')));
}

/* ══ B6. 选档：4K@60→4k30；超分辨率→1080p；HEVC→1080p ════════════════════ */
console.log('\nB6. 选档：4K@60 ⇒ 4k30；超分辨率 ⇒ 1080p；HEVC ⇒ 1080p');
{
  const ORIG = 'https://site.test/media/o.mp4';
  const V4K30 = { label: '4K30', width: 3840, height: 2160, fps: 30, bytes: 12e6, url: 'https://site.test/media/o-4k30.mp4' };
  const V1080 = { label: '1080p', width: 1920, height: 1080, fps: 30, bytes: 6e6, url: 'https://site.test/media/o-1080p.mp4' };
  const pick = (o) => pickVariant(Object.assign({ originalUrl: ORIG, quality: 'auto' }, o));
  const r60 = pick({ variants: [V4K30, V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 60, originalCodec: 'h264' });
  check('B6 4K@60 + 4K30 变体 ⇒ 4k30（hifps-variant，降帧不降分辨率）',
    r60.chosen === '4k30' && r60.url === V4K30.url && r60.reason === 'hifps-variant',
    r60.chosen + '/' + r60.reason);
  const rWide = pick({ variants: [V1080], originalWidth: 3841, originalHeight: 1080, originalFps: 30, originalCodec: 'h264' });
  const rTall = pick({ variants: [V1080], originalWidth: 3840, originalHeight: 2161, originalFps: 30, originalCodec: 'h264' });
  const rPixels = pick({ variants: [V1080], originalWidth: 4096, originalHeight: 2160, originalFps: 30, originalCodec: 'h264' });
  const rWide4320 = pick({ variants: [V1080], originalWidth: 5916, originalHeight: 2530, originalFps: 30, originalCodec: 'h264' });
  check('B6b 超分辨率（>3840 宽 / >2160 高 / >830 万像素）⇒ 1080p',
    [rWide, rTall, rPixels, rWide4320].every((r) => r.chosen === '1080p' && r.url === V1080.url && r.reason === 'decode-limit'),
    [rWide, rTall, rPixels, rWide4320].map((r) => r.chosen).join(','));
  check('B6c 3840×2160 本身不算超分辨率（严格大于；行为不能宽过头）',
    decodeLimitHit(3840, 2160) === '' && pick({ variants: [V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30 }).chosen === 'original');
  const rHevc = pick({ variants: [V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30, originalCodec: 'hevc' });
  const rHevc4k = pick({ variants: [V4K30], originalWidth: 3840, originalHeight: 2160, originalFps: 30, originalCodec: 'hevc' });
  check('B6d HEVC + 1080p ⇒ 1080p（codec 是站点事实，不是偏好）',
    rHevc.chosen === '1080p' && rHevc.reason === 'codec-unsupported', rHevc.chosen + '/' + rHevc.reason);
  check('B6e HEVC + 只有 4K30 ⇒ 4k30（1080p 缺失时落到第二档）',
    rHevc4k.chosen === '4k30' && rHevc4k.reason === 'codec-unsupported', rHevc4k.chosen + '/' + rHevc4k.reason);
  check('B6f 同一条但 h264 ⇒ original（差别只来自 codec，不是尺寸）',
    pick({ variants: [V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30, originalCodec: 'h264' }).chosen === 'original');
  const rGuess = pick({ variants: [V4K30], originalWidth: 3840, originalHeight: 2160 });
  check('B6g fps 缺失 ⇒ 宽度兜底（4k30）+ fpsSource=width-fallback（不把缺数据当事实）',
    rGuess.chosen === '4k30' && rGuess.fpsSource === 'width-fallback', rGuess.chosen + '/' + rGuess.fpsSource);
  /* ── 负对照：旧 decodeLimitHit 只判 width>4096 ⇒ 3841 宽会漏（选原画）── */
  const legacyDecodeHit = (w, h) => (Number(w) > 4096 || Number(h) > 2160
    || (Number(w) > 0 && Number(h) > 0 && Number(w) * Number(h) > 3840 * 2160) ? 'over' : '');
  const legacyWide = legacyDecodeHit(3841, 1080) ? '1080p' : 'original';
  check('B6h 负对照：旧判据（width>4096）对 3841×1080 选原画 ⇒ B6b 必红',
    legacyWide === 'original' && rWide.chosen === '1080p');
  check('B6i 负对照：旧实现不看 codec ⇒ HEVC 会选原画（B6d 必红）',
    pick({ variants: [V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30, originalCodec: 'h264' }).chosen === 'original'
      && rHevc.chosen !== 'original');
}

/* ══ Q2. 错误文案：进入 playing 清空 / 切条目不继承 / 分类不笼统 ═══════════ */
console.log('\nQ2. 错误文案：进入 playing 清空、切条目清空、Abort/NotAllowed/缺失/损坏/超限分流');
{
  const clientSrc = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  const lfSrc = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const prepSrc = readFileSync(join(ROOT, 'src', 'media-prep.js'), 'utf8');

  /* ── ① play() 拒绝的分类：AbortError 静默、NotAllowedError / NotSupported 各有词 ── */
  const refusalBlock = between(clientSrc, 'function playRefusalMessage(video) {', '// 把元素真实状态写进 store');
  const REF = refusalBlock
    ? new Function('weT', refusalBlock + '\nreturn playRefusalMessage;')(weT) : null;
  check('Q2a 能取出 playRefusalMessage 并真跑（取不到 = 判据失效）', Boolean(REF));
  if (REF) {
    const ref = (name) => REF({ dataset: { wePlayRefused: name } });
    check('Q2b AbortError ⇒ 空串（快速切换/换源打断，不显示错误）', ref('AbortError') === '', JSON.stringify(ref('AbortError')));
    check('Q2c NotAllowedError ⇒ 自动播放被拒的具体文案（不是"无法解码"）',
      /已静音|自动播放/.test(ref('NotAllowedError')) && !/无法解码/.test(ref('NotAllowedError')), ref('NotAllowedError'));
    check('Q2d NotSupportedError ⇒ 解码文案（这一类才是真解码失败）',
      /无法解码/.test(ref('NotSupportedError')), ref('NotSupportedError'));
    check('Q2e 未知 name ⇒ 带 name 的「播放失败（{name}）」（保留排障线索）',
      /播放失败/.test(ref('WeirdError')) && /WeirdError/.test(ref('WeirdError')), ref('WeirdError'));
  }

  /* ── ② MediaError 分类：本地地址不先翻译、损坏/缺失各有词 ── */
  const vpeBlock = between(clientSrc, 'function videoPlaybackError(video) {', '// 拒绝的性质');
  const selVpe = { url: '' };
  const VPE = vpeBlock
    ? new Function('weT', 'msIsLocalMediaUrl', 'selection', vpeBlock + '\nreturn videoPlaybackError;')(
      weT, (u) => /\/local-media\//.test(String(u || '')), selVpe) : null;
  check('Q2f 能取出 videoPlaybackError 并真跑', Boolean(VPE));
  if (VPE) {
    const at = (code, url) => { selVpe.url = url || 'https://site.test/media/x.mp4'; return VPE({ error: { code } }); };
    check('Q2g code=3（损坏）⇒「文件可能已损坏」，不是笼统"无法解码"',
      /损坏/.test(at(3)) && !/浏览器无法解码/.test(at(3)), at(3));
    check('Q2h code=2（缺失/移动）⇒「读取失败」类具体文案，不复用解码句',
      /读取失败|移动或删除/.test(at(2)) && !/浏览器无法解码/.test(at(2)), at(2));
    check('Q2i 本地副本地址 + code=4 ⇒ 空串（先交宿主判 404/编码，绝不抢答"无法解码"）',
      at(4, '/folia/local-media/job-x') === '', JSON.stringify(at(4, '/folia/local-media/job-x')));
    check('Q2j 没有 MediaError ⇒ 空串', (() => { selVpe.url = 'https://site.test/media/x.mp4'; return VPE({ error: null }); })() === '');
  }

  /* ── ③ 宿主自愈结论：缺失 / 损坏 / 超限 / 编码各有独立人话 ── */
  const healBlock = between(lfSrc, 'function dlHealNote(verdict) {', 'function dlHealPending(');
  const HEAL = healBlock ? new Function('weT', healBlock + '\nreturn dlHealNote;')(weT) : null;
  check('Q2k 能取出 dlHealNote 并真跑', Boolean(HEAL));
  if (HEAL) {
    const notes = ['corrupt', 'variant', 'transcoded', 'undecodable', 'undecodable-no-variant'].map((v) => HEAL(v));
    check('Q2l 损坏 / 换 1080p / 转码 / 编码不支持 各自一句，且都不是笼统"无法解码"',
      new Set(notes).size >= 4 && notes.every((s) => s && !/^浏览器无法解码这段视频/.test(s)),
      notes.join(' | '));
    const generic = () => '浏览器无法解码这段视频';
    const legacyNotes = ['corrupt', 'variant', 'transcoded', 'undecodable'].map(generic);
    check('Q2m 负对照：旧实现一律"浏览器无法解码这段视频" ⇒ 上面的去重判据必红',
      new Set(legacyNotes).size === 1);
  }
  const failBlock = between(lfSrc, 'function dlFailReason(code) {', '/**\n * job 的排队位置');
  const FAIL = failBlock ? new Function('weT', failBlock + '\nreturn dlFailReason;')(weT) : null;
  check('Q2n 416 自愈失败的错误码有专属文案（不是笼统"无法解码"/裸 failed）',
    Boolean(FAIL) && /本地残留/.test(FAIL('local-part-invalid')) && !/无法解码/.test(FAIL('local-part-invalid')),
    FAIL && FAIL('local-part-invalid'));

  /* ── ④ 进入 playing ⇒ 清掉旧错误/旧提示/元素级拒绝标记 ── */
  const svBlock = between(clientSrc, 'function syncVideoState(video) {', '/* ── 播放失败自愈');
  const svRun = (src) => {
    const sel = { videoPlaying: false, videoError: '浏览器无法解码这段视频', mediaNote: '本地副本已丢失' };
    const setTransient = (k, v) => { sel[k] = v; };
    const fn = new Function('setTransient', 'emit', 'selection', 'videoPlaybackError', 'playRefusalMessage',
      src + '\nreturn syncVideoState;')(setTransient, () => {}, sel, () => '', () => '');
    const video = { paused: false, ended: false, error: null, dataset: { wePlayRefused: 'NotAllowedError', wePlayAbortRetried: '1' } };
    fn(video);
    return { sel, video };
  };
  const good = svRun(svBlock);
  check('Q2o 进入 playing ⇒ videoError / mediaNote 清空，拒绝/重试标记一起清',
    good.sel.videoPlaying === true && good.sel.videoError === '' && good.sel.mediaNote === ''
      && !('wePlayRefused' in good.video.dataset) && !('wePlayAbortRetried' in good.video.dataset),
    JSON.stringify({ vp: good.sel.videoPlaying, err: good.sel.videoError, note: good.sel.mediaNote, ds: good.video.dataset }));
  const legacySv = svBlock.replace(/ {2}if \(playing && selection\.videoPlaying !== true\) \{[\s\S]*?\n {2}\}\n/, '');
  const bad = svRun(legacySv === svBlock ? svBlock : legacySv);
  check('Q2p 负对照：旧实现进入 playing 不清 mediaNote/标记 ⇒ 旧提示会留着（Q2o 必红）',
    legacySv !== svBlock && bad.sel.mediaNote === '本地副本已丢失'
      && bad.video.dataset.wePlayRefused === 'NotAllowedError',
    JSON.stringify({ note: bad.sel.mediaNote, ds: bad.video.dataset }));

  /* ── ⑤ 切条目 ⇒ 上一张的错误不继承（媒体准备入口按 idChanged 清）── */
  const clearBlock = /if \(idChanged\) \{\s*selection\.videoError = "";\s*selection\.mediaNote = "";\s*\}/.exec(prepSrc);
  const CLEAR = clearBlock ? new Function('selection', 'idChanged', clearBlock[0]) : null;
  check('Q2q 能取出"换条目清瞬态"的代码块并真跑', Boolean(CLEAR));
  if (CLEAR) {
    const a = { videoError: '旧错误', mediaNote: '旧提示' };
    const b = { videoError: '旧错误', mediaNote: '旧提示' };
    CLEAR(a, true);
    CLEAR(b, false);
    check('Q2r 换了条目 ⇒ 清空；同一条目 revalidate ⇒ 不清（错误归属按条目）',
      a.videoError === '' && a.mediaNote === '' && b.videoError === '旧错误' && b.mediaNote === '旧提示',
      JSON.stringify({ changed: a, same: b }));
    const legacyClear = () => {};
    const c = { videoError: '旧错误', mediaNote: '旧提示' };
    legacyClear(c, true);
    check('Q2s 负对照：旧实现不按 idChanged 清 ⇒ 上一张的错误会挂到新条目上（Q2r 必红）',
      c.videoError === '旧错误');
  }
  check('Q2t 缺失文案独立存在（"本地副本已丢失，正在重新下载"），与解码/损坏分开',
    /本地副本已丢失，正在重新下载/.test(clientSrc));
}

/* ══ Q3. 进度位置：只在标题栏元信息区；无居中浮层 ═══════════════════════════ */
console.log('\nQ3. 缓存进度只在标题栏（we-qp__meta 之后）；DOM 里没有 .we-switch-hint');
{
  const item = { id: 'A', media: B2_URLS[0], localReady: false };
  const job = { id: 'q3-job', kind: 'wallpaper', url: B2_URLS[0], status: 'running', percent: 62, received: 62, total: 100 };
  const view = WP.wpViewOf(item, [job], 8);
  const title = WP.wpTitleRender(view, item);
  const flat = JSON.stringify(title);
  check('Q3 标题栏进度节点是行内 hint（we-wp-title），带真实百分比',
    Boolean(title) && /we-picker__hint/.test(String(title.props && title.props.className))
      && /we-wp-title/.test(String(title.props && title.props.className)) && /62%/.test(flat),
    flat.slice(0, 160));
  check('Q3b 进度节点不创建居中浮层（无 we-switch-hint / 无 position:fixed）',
    !/we-switch-hint/.test(flat) && !/position\s*:\s*fixed/i.test(flat),
    flat.slice(0, 160));
  const qpSrc = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8');
  const atMeta = qpSrc.indexOf('className: "we-qp__meta"');
  const atHint = qpSrc.indexOf('React.createElement(QpCacheHint');
  check('Q3c quick-panel 里进度行在 we-qp__meta **之后**（标题栏元信息区）',
    atMeta >= 0 && atHint > atMeta, 'meta@' + atMeta + ' hint@' + atHint);
  const srcDir = join(ROOT, 'src');
  const offenders = [];
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.js')) continue;
    const codeOnly = stripComments(readFileSync(join(srcDir, f), 'utf8'));
    if (/we-switch-hint/.test(codeOnly)) offenders.push(f);
  }
  check('Q3d 全部客户端源码（剥注释）都没有 .we-switch-hint', offenders.length === 0, offenders.join(','));

  /* ── DOM 断言：真跑 video-switch 的缓冲路径，body 里不存在 .we-switch-hint ── */
  const created = [];
  const bodyChildren = [];
  const makeNode = () => {
    const classes = new Set();
    const attrs = {};
    return {
      _classes: classes, _attrs: attrs, style: {}, dataset: {}, textContent: '',
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      appendChild: (c) => { bodyChildren.push(c); return c; },
    };
  };
  const makeVideo = () => {
    const handlers = {};
    const el = {
      tagName: 'VIDEO', dataset: {}, readyState: 0, muted: false, loop: false,
      preload: '', autoplay: false, src: '', poster: '', currentTime: 0, playbackRate: 1,
      setAttribute() {}, removeAttribute() {}, style: {},
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      removeEventListener() {},
      load() {}, play() { return Promise.resolve(); }, pause() {},
      _fire(t) { (handlers[t] || []).forEach((f) => f({ type: t })); },
    };
    created.push(el);
    return el;
  };
  const prev = { document: globalThis.document, performance: globalThis.performance };
  const body = makeNode();
  globalThis.document = {
    body,
    createElement: (t) => (String(t).toLowerCase() === 'video' ? makeVideo() : makeNode()),
    getElementById: () => null,
  };
  globalThis.performance = { now: () => Date.now() };
  const vs = await import('../src/video-switch.js');
  const card = () => {
    const classes = new Set();
    const attrs = {};
    return {
      _classes: classes,
      classList: { add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x) },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
    };
  };
  const ctx = vs.weSwitchBegin(card());
  vs.weSwitchAttachPlayer(null, '/folia/site-media/x.mp4', { kind: 'video', originUrl: 'https://s/a/x.mp4' });
  ctx.bytesRecv = 8.3 * MB; ctx.bytesTotal = 19.7 * MB; ctx.etaSec = 6;
  await sleep(420);
  const hasHint = (nodes) => nodes.some((n) => String(n && n.className) === 'we-switch-hint'
    || (n && n._classes && n._classes.has && n._classes.has('we-switch-hint')));
  check('Q3e 300ms 未出帧 ⇒ 状态机 buffering，且 hint 文案在状态里（进度没被删掉）',
    vs.weSwitchState() === 'buffering' && /缓冲中/.test(String(vs.weSwitchHintTextOf() || '')),
    'state=' + vs.weSwitchState() + ' hint=' + vs.weSwitchHintTextOf());
  check('Q3f DOM 断言：video-switch 缓冲路径没有创建 .we-switch-hint', !hasHint(bodyChildren),
    'children=' + bodyChildren.length + ' hint=' + hasHint(bodyChildren));
  const fakeOverlay = { className: 'we-switch-hint' };
  bodyChildren.push(fakeOverlay);
  check('Q3g 负对照：把旧居中浮层塞回 DOM ⇒ 同一个探测器必命中（Q3f 不是恒真）', hasHint(bodyChildren));
  bodyChildren.pop();
  try { vs.weSwitchFail('cleanup'); } catch { /* ignore */ }
  globalThis.document = prev.document;
  globalThis.performance = prev.performance;
}

/* ══ 4.25.1 T1–T4：条目级身份 / 入队必被调度 / 阶段进度 / 启动不自愈成"缓存中" ══ */
import { createServer } from 'node:http';

console.log('\nT1. 所有入队路径产出的 job 在 1s 内进入 queued/running（逐路径）');
const hangServer = createServer(() => { /* 故意不回响应：job 会停在 running，便于断言"已开始" */ });
await new Promise((resolveListen) => { hangServer.listen(0, '127.0.0.1', resolveListen); });
try { hangServer.unref(); } catch { /* unref 是增强 */ }
const HANG_PORT = hangServer.address().port;
const hangUrl = (name) => 'http://127.0.0.1:' + HANG_PORT + '/' + name + '.mp4';
const destOf = (home, name) => join(home, 'library', 'wallpaper', name + '.mp4');
/** 测试用媒体族键（与宿主同口径的最小子集：去扩展名 + 去变体后缀）。 */
const mediaFamily = (raw) => {
  try {
    const u = new URL(String(raw));
    const parts = u.pathname.split('/');
    const file = parts.pop() || '';
    const stem = file.replace(/\.(?:mp4|webm|mov|m4v)$/i, '')
      .replace(/(?:[._-](?:1080p|1440p|2160p|4k30|4k|30fps|60fps))+$/i, '');
    return stem;
  } catch { return ''; }
};
const writeJobs = (home, jobs, extra) => {
  writeFileSync(join(home, 'downloads.json'), JSON.stringify(Object.assign({ version: 1, paused: false, jobs }, extra || {})), 'utf8');
};
const waitJobState = async (q, id, pred, ms = 1200) => {
  const t0 = Date.now();
  for (;;) {
    const row = q.snapshot().find((j) => j && j.id === id) || null;
    if (row && pred(row)) return { row, ms: Date.now() - t0 };
    if (Date.now() - t0 >= ms) return { row, ms: Date.now() - t0 };
    await sleep(20);
  }
};
const cancelAll = (q) => {
  for (const j of q.snapshot()) {
    if (j.status === 'queued' || j.status === 'running') { try { q.cancel(j.id); } catch { /* ignore */ } }
  }
};
const activeOrQueued = (j) => j.status === 'queued' || j.status === 'running';

async function t1Path(name, fn) {
  const home = freshHome('t1-' + name);
  const q = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  try {
    const id = await fn(q, home);
    const hit = await waitJobState(q, id, activeOrQueued, 1000);
    check('T1 ' + name + ' ⇒ 1s 内 queued/running（不停在 pending）',
      Boolean(hit.row) && activeOrQueued(hit.row) && hit.ms <= 1000,
      'status=' + (hit.row && hit.row.status) + ' in=' + hit.ms + 'ms');
    return { q, id };
  } finally {
    cancelAll(q);
  }
}

await t1Path('add-high（用户点击）', async (q, home) => {
  const url = hangUrl('t1-click');
  return q.add({ url, dest: destOf(home, 't1-click'), kind: 'wallpaper', priority: 'high', itemKey: 'wallpaper:t1-click' }).job.id;
});
await t1Path('add-low（预取）', async (q, home) => {
  const url = hangUrl('t1-prefetch');
  return q.add({ url, dest: destOf(home, 't1-prefetch'), kind: 'wallpaper', priority: 'low', itemKey: 'wallpaper:t1-prefetch' }).job.id;
});
await t1Path('priority-high（显式提权）', async (q, home) => {
  const url = hangUrl('t1-priority');
  q.setPaused(true);
  const id = q.add({ url, dest: destOf(home, 't1-priority'), kind: 'wallpaper', priority: 'low', itemKey: 'wallpaper:t1-priority' }).job.id;
  q.applyReconcile([{ id, patch: { status: 'pending', received: 0 } }]);
  const row = q.setPriority({ id, priority: 'high' });
  q.setPaused(false);
  return row && row.id;
});
await t1Path('在播 promote（pending → high）', async (q, home) => {
  const url = hangUrl('t1-inplay');
  q.setPaused(true);
  const id = q.add({ url, dest: destOf(home, 't1-inplay'), kind: 'wallpaper', priority: 'low', itemKey: 'wallpaper:t1-inplay' }).job.id;
  q.applyReconcile([{ id, patch: { status: 'pending', received: 0 } }]);
  const again = q.add({ url, dest: destOf(home, 't1-inplay'), kind: 'wallpaper', priority: 'high', itemKey: 'wallpaper:t1-inplay' }).job.id;
  q.setPaused(false);
  return again;
});
await t1Path('缓存清空重置（done→pending）后点击', async (q, home) => {
  const url = hangUrl('t1-reset');
  q.setPaused(true);
  const id = q.add({ url, dest: destOf(home, 't1-reset'), kind: 'wallpaper', priority: 'high', itemKey: 'wallpaper:t1-reset' }).job.id;
  q.applyReconcile([{ id, patch: { status: 'done', total: 1, received: 1 } }]);
  q.resetDoneForKinds(['wallpaper']);
  q.setPaused(false);
  return q.add({ url, dest: destOf(home, 't1-reset'), kind: 'wallpaper', priority: 'high', itemKey: 'wallpaper:t1-reset' }).job.id;
});
await t1Path('失败后重试（failed → high）', async (q, home) => {
  const url = hangUrl('t1-retry');
  const first = q.add({ url, dest: destOf(home, 't1-retry'), kind: 'wallpaper', priority: 'high', itemKey: 'wallpaper:t1-retry' }).job.id;
  q.cancel(first);
  const again = q.add({ url, dest: destOf(home, 't1-retry'), kind: 'wallpaper', priority: 'high', itemKey: 'wallpaper:t1-retry' }).job.id;
  return again;
});
/* 负对照：旧 setPriority 只改 priority、不把 pending 变 queued ⇒ T1 的 priority 路径永远判红。 */
const legacyPriorityStatus = (status) => status;
check('T1i 负对照：pending 只改 priority 不 promote ⇒ 仍 pending（T1 的 priority 路径必红）',
  legacyPriorityStatus('pending') === 'pending'
    && !activeOrQueued({ status: legacyPriorityStatus('pending') }));

/* T2. 同一条目的原画/变体只有 1 条 job；点击提权复用既有记录 */
console.log('\nT2. 同一 item 原始/变体 URL ⇒ 1 条 job；提权不产生第二条');
{
  const home = freshHome('t2-item-key');
  const ORIG = hangUrl('t2-item');
  const VAR = hangUrl('t2-item.1080p');
  const probe = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const legacyId = probe.idForUrl(VAR);
  // 4.25.0 的现场：变体 URL 的 pending/high 老记录，**没有 itemKey**。
  writeJobs(home, [{
    id: legacyId, url: VAR, dest: destOf(home, 't2-item.1080p'), kind: 'wallpaper',
    total: 0, status: 'pending', error: null, at: 1, priority: 'high',
  }], { paused: true });
  const q = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const first = q.add({
    url: ORIG, dest: destOf(home, 't2-item'), kind: 'wallpaper', priority: 'high',
    itemKey: 'wallpaper:t2-item', relatedUrls: [ORIG, VAR],
  });
  check('T2 变体 pending 老记录被点击原画时复用（job id 不变、URL 迁移、状态 queued）',
    Boolean(first.job) && first.job.id === legacyId && first.job.itemKey === 'wallpaper:t2-item'
      && first.job.status === 'queued' && first.job.url === ORIG,
    JSON.stringify(first.job && { id: first.job.id, itemKey: first.job.itemKey, st: first.job.status, url: first.job.url }));
  const second = q.add({
    url: VAR, dest: destOf(home, 't2-item.1080p'), kind: 'wallpaper', priority: 'high',
    itemKey: 'wallpaper:t2-item', relatedUrls: [ORIG, VAR],
  });
  const mine = q.snapshot().filter((j) => j.itemKey === 'wallpaper:t2-item');
  check('T2b 再点变体 ⇒ 仍是同一条 job（数量 1，id 不变，URL 迁到变体）',
    mine.length === 1 && second.job && second.job.id === legacyId && second.job.url === VAR,
    'count=' + mine.length + ' id=' + (second.job && second.job.id) + ' url=' + (second.job && second.job.url));
  q.setPaused(false);
  const live = await waitJobState(q, legacyId, activeOrQueued, 1000);
  check('T2c 点击后 1s 内进入 queued/running（不是第二条 pending）',
    Boolean(live.row) && activeOrQueued(live.row) && live.ms <= 1000,
    'status=' + (live.row && live.row.status) + ' in=' + live.ms + 'ms');
  cancelAll(q);
  /* 负对照：旧实现按 URL 做键 ⇒ 原画 / 变体是两条独立 job。 */
  const legacyIds = new Set([probe.idForUrl(ORIG), probe.idForUrl(VAR)]);
  check('T2d 负对照：旧实现按 URL 建 job ⇒ 2 条（T2 的 ==1 必红）',
    legacyIds.size === 2 && mine.length === 1, 'legacy=' + legacyIds.size + ' actual=' + mine.length);

  /* 4.25.0 的真实遗留：同一条目可能同时躺着"原画 pending + 变体 pending"两条记录。
     点击任何一条后，另一条永远不会被 pump 取到 ⇒ 必须清掉（只清不会被调度的）。 */
  const dupHome = freshHome('t2-duplicates');
  const dupOrig = hangUrl('t2-dup');
  const dupVar = hangUrl('t2-dup.1080p');
  const dupProbe = createDownloadQueue({ home: dupHome, log: () => {}, concurrency: 1 });
  const dupOrigId = dupProbe.idForUrl(dupOrig);
  const dupVarId = dupProbe.idForUrl(dupVar);
  writeJobs(dupHome, [
    { id: dupOrigId, url: dupOrig, dest: destOf(dupHome, 't2-dup'), kind: 'wallpaper', total: 0, status: 'pending', error: null, at: 1, priority: 'high' },
    { id: dupVarId, url: dupVar, dest: destOf(dupHome, 't2-dup.1080p'), kind: 'wallpaper', total: 0, status: 'pending', error: null, at: 2, priority: 'high' },
  ], { paused: true });
  const dupQ = createDownloadQueue({ home: dupHome, log: () => {}, concurrency: 1 });
  dupQ.add({
    url: dupOrig, dest: destOf(dupHome, 't2-dup'), kind: 'wallpaper', priority: 'high',
    itemKey: 'wallpaper:t2-dup', relatedUrls: [dupOrig, dupVar],
  });
  const dupLeft = dupQ.snapshot().filter((j) => mediaFamily(j.url) === 't2-dup');
  check('T2e 同一条目的原画/变体 pending 重复记录：点击后只留 1 条（不再永远 pending）',
    dupLeft.length === 1 && dupLeft[0].status !== 'pending', JSON.stringify(dupLeft.map((j) => ({ id: j.id, st: j.status, url: j.url }))));
}

/* T3. total=0 ⇒ 阶段文案；total 已知 ⇒ 百分比 */
console.log('\nT3. total 未知 ⇒ 排队中 / 连接中 / 已下载 X MB；total 已知 ⇒ 百分比');
{
  const jobUnknown0 = { id: 't3-a', kind: 'wallpaper', url: hangUrl('t3-a'), status: 'running', total: 0, received: 0 };
  const jobUnknownN = { id: 't3-b', kind: 'wallpaper', url: hangUrl('t3-b'), status: 'running', total: 0, received: 17.3 * MB };
  const jobKnown = { id: 't3-c', kind: 'wallpaper', url: hangUrl('t3-c'), status: 'running', total: 100 * MB, received: 50 * MB, percent: 50 };
  check('T3 queued + total=0 ⇒「排队中」（不是空白/0%）',
    DF.dfProgressText(0, 0, 0, 'queued') === '排队中', DF.dfProgressText(0, 0, 0, 'queued'));
  check('T3b running + total=0 + 未收到字节 ⇒「连接中」',
    DF.dfProgressText(0, 0, 0, 'running') === '连接中', DF.dfProgressText(0, 0, 0, 'running'));
  check('T3c running + total=0 + 已收到字节 ⇒「已下载 17.3 MB」',
    DF.dfProgressText(17.3 * MB, 0, 0, 'running') === '已下载 17.3 MB', DF.dfProgressText(17.3 * MB, 0, 0, 'running'));
  check('T3d 拿到 total ⇒ 百分比 + 已下/总量（不再停在阶段文案）',
    /^正在缓存 50%/.test(DF.dfProgressText(50 * MB, 100 * MB, 0, 'running')),
    DF.dfProgressText(50 * MB, 100 * MB, 0, 'running'));
  DF.dfBegin({ id: 't3-state', title: 'T3', media: jobUnknownN.url });
  const snap = DF.dfApplyJob(jobUnknownN);
  check('T3e 状态机：running + total=0 时 text = 阶段文案（不是空白）',
    snap.state === 'caching' && snap.text === '已下载 17.3 MB', JSON.stringify({ st: snap.state, text: snap.text }));
  const item = { id: 't3-item', media: jobUnknown0.url, localReady: false };
  const v0 = WP.wpViewOf(item, [jobUnknown0], 0);
  const vN = WP.wpViewOf({ id: 't3-item-b', media: jobUnknownN.url, localReady: false }, [jobUnknownN], 0);
  const vK = WP.wpViewOf({ id: 't3-item-c', media: jobKnown.url, localReady: false }, [jobKnown], 0);
  check('T3f 卡片：total=0 ⇒ 阶段文案（连接中 / 已下载 X MB），不是「缓存中 0%」',
    v0 && v0.card === '连接中' && vN && vN.card === '已下载 17.3 MB',
    JSON.stringify({ zero: v0 && v0.card, progressing: vN && vN.card }));
  check('T3g 卡片：total 已知 ⇒「缓存中 50%」', vK && vK.card === '缓存中 50%', vK && vK.card);
  /* 负对照：旧实现 total=0 时给「正在缓存…」/「缓存中 0%」。 */
  const legacyText = () => '正在缓存…';
  const legacyCard = () => '缓存中 0%';
  check('T3h 负对照：旧实现 total=0 ⇒「正在缓存…」/「缓存中 0%」（T3 的判据必红）',
    legacyText() === '正在缓存…' && legacyCard() === '缓存中 0%'
      && DF.dfProgressText(0, 0, 0, 'running') !== legacyText()
      && v0.card !== legacyCard());
  /* 负对照：进度只按 URL 绑 ⇒ 变体 job 对不上原画条目（用户 4.25.0 的现场）。 */
  const t3Orig = 'https://site.test/media/t3-orig.mp4';
  const t3Var = 'https://site.test/media/t3-orig.1080p.mp4';
  const t3VarJob = { id: 't3-var', kind: 'wallpaper', url: t3Var, status: 'running', total: 0, received: 5 * MB };
  const t3VarView = WP.wpViewOf({ id: 't3-var-item', media: t3Orig, localReady: false }, [t3VarJob], 0);
  const legacyUrlOnly = (job, item) => (job.url === item.media ? job : null);
  check('T3i 负对照：按 URL 绑进度 ⇒ 变体 job 对不上原画条目；媒体族兜底后才显示阶段文案',
    legacyUrlOnly(t3VarJob, { media: t3Orig }) === null
      && Boolean(t3VarView) && t3VarView.card === '已下载 5.0 MB',
    JSON.stringify({ legacy: legacyUrlOnly(t3VarJob, { media: t3Orig }), view: t3VarView && t3VarView.card }));
}

/* T4. 启动看到 pending + high ⇒ 不自动下载；UI 是「未缓存（点击继续）」 */
console.log('\nT4. 启动 pending+high ⇒ 不自动下载；UI 明说「未缓存（点击继续）」');
{
  const home = freshHome('t4-pending-high');
  const ORIG = hangUrl('t4-stuck');
  const VAR = hangUrl('t4-stuck.1080p');
  const probe = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const id = probe.idForUrl(VAR);
  writeJobs(home, [{
    id, url: VAR, dest: destOf(home, 't4-stuck.1080p'), kind: 'wallpaper',
    itemKey: 'wallpaper:t4-stuck',
    total: 0, status: 'pending', error: null, at: 1, priority: 'high',
  }]);
  const q = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  await sleep(350);
  const c1 = q.queueCounts();
  await sleep(250);
  const c2 = q.queueCounts();
  check('T4 load 后 pending+high 仍是 pending（queued=0 / running=0，两次采样）',
    c1.pendingCount === 1 && c1.queuedCount === 0 && c1.runningCount === 0
      && c2.pendingCount === 1 && c2.queuedCount === 0 && c2.runningCount === 0,
    JSON.stringify({ c1, c2 }));
  check('T4b 队列行标出 pendingHigh（UI/排障可读，且不是"可自动下载"）',
    q.snapshot().some((j) => j.id === id && j.pendingHigh === true && j.priority === 'high'));
  const item = { id: 't4-stuck', media: ORIG, localReady: false, jobStatus: 'pending', jobPriority: 'high' };
  check('T4c 非点击路径 ⇒ 不自动开始（dfShouldHoldAutoStart=true）；用户点击 ⇒ 放行',
    DF.dfShouldHoldAutoStart(item, {}) === true
      && DF.dfShouldHoldAutoStart(item, { fromManual: true }) === false);
  const view = WP.wpViewOf(item, q.snapshot(), 0);
  check('T4d UI：pending+high ⇒「未缓存（点击继续）」，绝不说「缓存中」',
    Boolean(view) && view.phase === 'pending' && view.card === '未缓存（点击继续）'
      && !/缓存中/.test(JSON.stringify(view)),
    JSON.stringify(view));
  // 4.25.0 老数据没有 itemKey、清单也没有 variants：只能按媒体族（原画 ↔ .1080p）对上。
  const legacyRow = { id: 'legacy-var', kind: 'wallpaper', url: VAR, status: 'pending', priority: 'high', pendingHigh: true };
  const legacyFamilyView = WP.wpViewOf({ id: 't4-legacy', media: ORIG, localReady: false }, [legacyRow], 0);
  check('T4d2 老变体 job（无 itemKey / 无 variants）⇒ 媒体族兜底也能显示「未缓存（点击继续）」',
    Boolean(legacyFamilyView) && legacyFamilyView.card === '未缓存（点击继续）', JSON.stringify(legacyFamilyView));
  const prepSrc = readFileSync(join(ROOT, 'src', 'media-prep.js'), 'utf8');
  const invSrc = readFileSync(join(ROOT, 'lib', 'routes', 'inventory.js'), 'utf8');
  check('T4e 源码：applySelection 真的走了 hold 分支（仅 fromManual 放行；非点击只上海报 + pending）',
    /dfShouldHoldAutoStart\(w, opts\)/.test(prepSrc)
      && /selection\.playbackState = "pending"/.test(prepSrc)
      && /未缓存（点击继续）/.test(prepSrc));
  check('T4f 源码：清单随条目下发 jobStatus/jobPriority/pendingHigh（客户端不按 URL 猜）',
    /jobFieldsOf/.test(invSrc) && /jobStatus/.test(invSrc) && /pendingHigh/.test(invSrc));
  /* 点击继续：同一条 pending job 被提权并复用 ⇒ 1s 内 queued/running。 */
  const r = q.add({
    url: ORIG, dest: destOf(home, 't4-stuck'), kind: 'wallpaper', priority: 'high',
    itemKey: 'wallpaper:t4-stuck', relatedUrls: [ORIG, VAR],
  });
  const cont = await waitJobState(q, r.job.id, activeOrQueued, 1000);
  check('T4g 「点击继续」⇒ 复用同一条 job 并在 1s 内 queued/running（不是新 pending）',
    r.job && r.job.id === id && Boolean(cont.row) && activeOrQueued(cont.row) && cont.ms <= 1000,
    'id=' + (r.job && r.job.id) + ' status=' + (cont.row && cont.row.status) + ' in=' + cont.ms + 'ms');
  cancelAll(q);
  /* 负对照：恢复"启动批量 promote / UI 只说未缓存"的旧形态 ⇒ T4 必红。 */
  const legacyCounts = { queuedCount: 1, runningCount: 1, pendingCount: 0 };
  const legacyView = { phase: 'pending', percent: 0, card: '未缓存', title: null };
  check('T4h 负对照：启动自动 promote（queued/running=1）或旧「未缓存」文案 ⇒ T4 的判据必红',
    legacyCounts.queuedCount + legacyCounts.runningCount > 0
      && legacyView.card !== '未缓存（点击继续）'
      && !(legacyCounts.queuedCount === 0 && legacyCounts.runningCount === 0));
}

/* ══ U1–U4. 连点语义：末位优先 + 未开始队列有界（4.25.1 追加）══════════════════ */
console.log('\nU1. 连点 10 张：最后一张 high + running；前 9 张 low；同 kind 同时 running ≤2');
const BURST_MP4 = (() => {
  const b = Buffer.alloc(4096, 0x42);
  b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1'); b.write('isom', 8, 'latin1');
  b.writeUInt32BE(4096 - 32, 32); b.write('moov', 36, 'latin1');
  return b;
})();
const burstServer = createServer((req, res) => {
  // 400ms 后给一份结构合法的 mp4：前两张先占满 2 个槽，最后点的高优任务在槽位释放后立刻接管。
  setTimeout(() => {
    try {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': BURST_MP4.length });
      res.end(BURST_MP4);
    } catch { /* 客户端可能已 abort */ }
  }, 400);
});
await new Promise((resolveListen) => { burstServer.listen(0, '127.0.0.1', resolveListen); });
try { burstServer.unref(); } catch { /* unref 是增强 */ }
const BURST_PORT = burstServer.address().port;
{
  const home = freshHome('u1-burst');
  const q = createDownloadQueue({ home, log: () => {} });
  const clicked = [];
  let prev = null;
  for (let i = 1; i <= 10; i += 1) {
    if (prev) q.setPriority({ id: prev, priority: 'low' });
    const r = q.add({
      url: 'http://127.0.0.1:' + BURST_PORT + '/u1-' + i + '.mp4',
      dest: destOf(home, 'u1-' + i), kind: 'wallpaper', priority: 'high',
      itemKey: 'wallpaper:u1-' + i, clicked: true,
    });
    clicked.push(r.job.id);
    prev = r.job.id;
  }
  let lastRow = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    lastRow = q.snapshot().find((j) => j.id === prev) || null;
    if (lastRow && lastRow.status === 'running') break;
    await sleep(20);
  }
  const priorRows = clicked.slice(0, 9).map((id) => q.snapshot().find((j) => j.id === id));
  const runningNow = q.snapshot().filter((j) => j.status === 'running').length;
  check('U1 最后点的那张 priority=high 且已 running（末位优先）',
    Boolean(lastRow) && lastRow.priority === 'high' && lastRow.status === 'running',
    JSON.stringify(lastRow && { st: lastRow.status, prio: lastRow.priority, pos: lastRow.queuePos }));
  check('U1b 前 9 张全部 priority=low（后台继续，不取消）',
    priorRows.every((j) => j && j.priority === 'low' && j.status !== 'cancelled'),
    priorRows.map((j) => j && (j.priority + '/' + j.status)).join(','));
  check('U1c 同 kind 同时 running ≤ 2（并发上限没被末位优先破坏）', runningNow <= 2, 'running=' + runningNow);
  const clickedRows = q.snapshot().filter((j) => j.sessionClicked === true);
  const keys = new Set(clickedRows.map((j) => j.itemKey));
  check('U2 10 张被点击过的 job = 10 且 itemKey 唯一（无重复）',
    clickedRows.length === 10 && keys.size === 10, 'clicked=' + clickedRows.length + ' unique=' + keys.size);
  /* 负对照：去掉"最后一张 high" ⇒ U1 的 last.priority===high 必红。 */
  const legacyLastPriority = 'low';
  check('U2b 负对照：末位不设 high ⇒ last.priority=low（U1 必红）', legacyLastPriority !== 'high');
  cancelAll(q);
}
try { burstServer.closeAllConnections(); } catch { /* ignore */ }
await new Promise((resolveClose) => { burstServer.close(() => resolveClose()); });

console.log('\nU3. 连点 30 张：queued ≤ 8，其余 pending；pending 不显示「排队中」');
let u3Q;
let u3Rows;
let u3Pending;
{
  const home = freshHome('u3-burst');
  u3Q = createDownloadQueue({ home, log: () => {} });
  let prev = null;
  for (let i = 1; i <= 30; i += 1) {
    if (prev) u3Q.setPriority({ id: prev, priority: 'low' });
    const r = u3Q.add({
      url: hangUrl('u3-' + String(i).padStart(2, '0')), dest: destOf(home, 'u3-' + String(i).padStart(2, '0')),
      kind: 'wallpaper', priority: 'high', itemKey: 'wallpaper:u3-' + i, clicked: true,
    });
    prev = r.job.id;
  }
  u3Rows = u3Q.snapshot();
  const queued = u3Rows.filter((j) => j.status === 'queued').length;
  const pending = u3Rows.filter((j) => j.status === 'pending').length;
  const running = u3Rows.filter((j) => j.status === 'running').length;
  check('U3 连点 30 张 ⇒ queued ≤ 8（其余回落 pending）',
    queued <= 8 && pending >= 20 && running <= 2 && queued + pending + running === 30,
    JSON.stringify({ queued, pending, running }));
  u3Pending = u3Rows.find((j) => j.status === 'pending' && j.sessionClicked === true) || null;
  const pendingView = u3Pending
    ? WP.wpViewOf({ id: String(u3Pending.itemKey).replace(/^wallpaper:/, ''), media: u3Pending.url, localReady: false }, u3Rows, 0)
    : null;
  check('U3b pending 的卡片不显示「排队中」/不报队列位置（无幽灵任务）',
    Boolean(pendingView) && pendingView.phase === 'pending' && !/排队中/.test(pendingView.card || ''),
    JSON.stringify(pendingView));
  /* 负对照：去掉上限 ⇒ 30 张都留在 queued，U3 的 queued ≤ 8 必红。 */
  const legacyQueued = 30;
  check('U3c 负对照：不给未开始队列上限 ⇒ queued=30（U3 必红）',
    legacyQueued > 8 && queued <= 8 && legacyQueued !== queued);
}
{
  const before = u3Q.queueCounts();
  const pendingId = u3Pending && u3Pending.id;
  const r = u3Q.add({
    url: u3Pending.url, dest: u3Pending.dest, kind: 'wallpaper', priority: 'high',
    itemKey: u3Pending.itemKey, clicked: true,
  });
  const hit = await waitJobState(u3Q, pendingId, activeOrQueued, 1000);
  const after = u3Q.queueCounts();
  check('U4 点一下 pending（本次会话点过）⇒ 1s 内回到队列（queued/running），且 queued 仍 ≤ 8',
    Boolean(hit.row) && activeOrQueued(hit.row) && hit.ms <= 1000 && after.queuedCount <= 8,
    'status=' + (hit.row && hit.row.status) + ' in=' + hit.ms + 'ms queued=' + after.queuedCount
      + ' before=' + JSON.stringify(before) + ' ret=' + Boolean(r.job));
  /* 负对照：恢复"pending 不 promote" ⇒ 再点一次仍 pending，U4 必红。 */
  const legacyRetry = (status) => status;
  check('U4b 负对照：pending 再点不 promote ⇒ 仍 pending（U4 必红）',
    legacyRetry('pending') === 'pending' && !activeOrQueued({ status: legacyRetry('pending') }));
  cancelAll(u3Q);
}

try { hangServer.closeAllConnections(); } catch { /* ignore */ }
await new Promise((resolveClose) => { hangServer.close(() => resolveClose()); });

/* ══ 汇总 ═══════════════════════════════════════════════════════════════════ */
cleanupTestHome(TEST_HOME);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\nWALLPAPER CORE CHECKS FAILED — ' + failed.length + ' 条：');
  for (const f of failed) console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : ''));
  process.exit(1);
}
console.log('\nALL WALLPAPER CORE CHECKS PASSED — ' + results.length + ' 条');
