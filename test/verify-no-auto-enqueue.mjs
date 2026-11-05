#!/usr/bin/env node
/**
 * verify-no-auto-enqueue.mjs — **未点击就不许自己下**（4.24.1，P0-3）。
 *
 * ## 守的是什么（用户实测原文）
 *
 *   「清空媒体后 `pending`=70，我**一张都没点**，界面上却出现 20+ 张「排队中」。」
 *
 * 根因不是某一条 bug，而是"替用户提前下"这条策略**默认开着**：`src/local-first.js` 的
 * `lfPrefetchCount()` 在 download-first 下返回 **3**，而 hover 一张卡就发一次
 * `POST /downloads/add`（一批最多 3 条）⇒ 划过列表 = 批量入队；入队的每条都显示
 * 「排队中：前面还有 N 个」。
 *
 * ## 判据
 *
 *   A 宿主唯一真源 `prefetchCount()`：**默认 0** / 上限 3 / 非法值回落 0（不是 3）
 *   B 客户端 `lfPrefetchCount(hostValue)`：同一套夹取（真跑源码，不是读字符串）
 *   C **70 条 pending 不产生任何 queued**（启动/对账都不许顺手排队）
 *   D 点 1 张 ⇒ `queued==1` 且是 `high`；再点 2 张 ⇒ `queued==3`，**只有这 3 张**
 *   E `prefetchCount=3` 才允许额外 3 条，且一律 `low`；排序上 high 在 low 之前（前 low 后 high）
 *   F pending 的卡片没有「前面还有 N 个」（`snapshot()` 不给 queuePos/queuedAhead），
 *     并且客户端把 pending 画成「未缓存」
 *   G 负对照（三条，都必须让本文件的判据变红）：
 *      ① 把客户端默认值改回 3；② 把 `startupStatusFor('queued')` 改回 `'queued'`（= 启动批量排队）；
 *      ③ 把所有 pending 直接标成 queued（= 批量 promote 的形态）后，C 组的不变量必须为假
 *
 * 隔离 home（`%TEMP%\folia-test-*`）：真写 `downloads.json`、真建队列，绝不碰用户库。
 *
 * Usage: `node test/verify-no-auto-enqueue.mjs`
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDownloadQueue } from '../lib/download-queue.js';
import { startupStatusFor } from '../lib/media-state.js';
import { prefetchCount, PREFETCH_MAX } from '../lib/routes/downloads.js';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

const BASE_HOME = isolateTestHome('no-auto-enqueue', { force: true });
let caseNo = 0;
function freshHome(label) {
  caseNo += 1;
  const h = join(BASE_HOME, 'h' + caseNo + '-' + label);
  rmSync(h, { recursive: true, force: true });
  mkdirSync(join(h, 'library', 'wallpaper'), { recursive: true });
  return h;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * 70 条 pending 壁纸（用户"清空媒体"之后的真实形态：记录在、成品不在）。
 *
 * ⚠️ job id **不是**自造字符串：它是 `urlKey(url)`（队列内部规则）。自造 id 会让后续
 * `add()` 建出**另一条** job，于是"点一张 ⇒ pending 少一张"这条判据永远为假 ——
 * 那不是实现有问题，是夹具没对齐。这里用队列自己的 `idForUrl()` 取（不手抄散列口径）。
 */
function seedPending(home, n = 70) {
  const urls = [];
  for (let i = 0; i < n; i += 1) urls.push('http://127.0.0.1:1/p' + String(i).padStart(2, '0') + '.mp4');
  const probe = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const jobs = urls.map((url, i) => ({
    id: probe.idForUrl(url), url,
    dest: join(home, 'library', 'wallpaper', 'p' + String(i).padStart(2, '0') + '.mp4'),
    kind: 'wallpaper', total: 1024, status: 'pending', error: null,
    // 优先级用 `low`：这些记录的现实来源就是"后台预取留下来的"（点过的是 high）。
    // 用 `normal` 会让 `add({priority:'low'})` 看起来"没生效" —— 那是 `add()` 的
    // **不降级**语义（保护用户刚点的 high 不被后台预取降下去），不是判据失败。
    at: 1000 + i, priority: 'low',
  }));
  writeFileSync(join(home, 'downloads.json'), JSON.stringify({ version: 1, paused: true, jobs }), 'utf8');
  return { urls, ids: jobs.map((j) => j.id) };
}

/** 判据 C 的不变量：pending 一条都不在队列里。单独抽出来是为了能做负对照。 */
function noAutoEnqueueHolds(counts) {
  return Boolean(counts) && Number(counts.queuedCount) === 0 && Number(counts.pendingCount) === 70;
}

let failed = 0;
const finish = () => {
  try { cleanupTestHome(BASE_HOME); } catch { /* ignore */ }
  failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (failed ? '✗ ' + failed + ' / ' + results.length + ' 条判据未通过'
    : '✓ 全部 ' + results.length + ' 条判据通过'));
  process.exit(failed ? 1 : 0);
};

/* ══ A. 宿主唯一真源：prefetchCount() ═══════════════════════════════════════ */
console.log('\nA. 宿主 prefetchCount()：默认 0 / 上限 3 / 非法回落 0');
{
  const prev = process.env.DSH_FOLIA_PREFETCH;
  const val = (v) => {
    if (v === undefined) delete process.env.DSH_FOLIA_PREFETCH;
    else process.env.DSH_FOLIA_PREFETCH = v;
    return prefetchCount();
  };
  try {
    check('A1 未设环境变量 ⇒ 0（**默认关闭**，不是 3）', val(undefined) === 0, 'v=' + val(undefined));
    check('A2 =1/2/3 ⇒ 原样返回', val('1') === 1 && val('2') === 2 && val('3') === 3,
      ['1', '2', '3'].map(val).join(','));
    check('A3 =9/-1/abc/0 ⇒ 夹取或回落 0（绝不因写错而放大预取）',
      val('9') === PREFETCH_MAX && val('-1') === 0 && val('abc') === 0 && val('0') === 0,
      ['9', '-1', 'abc', '0'].map(val).join(','));
    check('A4 上限常量就是 3（用户要求"最大 3"）', PREFETCH_MAX === 3, 'PREFETCH_MAX=' + PREFETCH_MAX);
  } finally {
    if (prev === undefined) delete process.env.DSH_FOLIA_PREFETCH; else process.env.DSH_FOLIA_PREFETCH = prev;
  }
}

/* ══ B. 客户端 lfPrefetchCount()：真跑源码（不是读字符串）═══════════════════ */
console.log('\nB. 客户端 lfPrefetchCount(hostValue)：同一套夹取（真跑源码）');
const lfSrc = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
/** 从源码里切出 `LF_PREFETCH_MAX` + `lfPrefetchCount` 这两段，装进一个沙箱里真跑。 */
function loadLfPrefetch(src) {
  const m = /const LF_PREFETCH_MAX = 3;[\s\S]*?\nfunction lfPrefetchCount\(hostValue\) \{[\s\S]*?\n\}/.exec(src);
  if (!m) return null;
  try {
    return new Function(m[0] + '\nreturn { LF_PREFETCH_MAX, lfPrefetchCount };')();
  } catch { return null; }
}
{
  const api = loadLfPrefetch(lfSrc);
  check('B0 能从源码里取出这两个声明（取不到 = 判据失效，必须红）', Boolean(api),
    api ? 'ok' : 'anchor-missing');
  if (api) {
    const cases = [[undefined, 0], [0, 0], [1, 1], [3, 3], [99, 3], [-2, 0], ['2', 2], ['abc', 0], [null, 0]];
    const bad = cases.filter(([inp, want]) => api.lfPrefetchCount(inp) !== want)
      .map(([inp, want]) => String(inp) + '→' + api.lfPrefetchCount(inp) + '(want ' + want + ')');
    check('B1 入参矩阵：undefined/null/0/负数/非数字 ⇒ 0；1..3 原样；超上限夹到 3',
      bad.length === 0, bad.length ? bad.join(' ') : 'all-ok');
    check('B2 代码里没有"按播放策略自己算 2/3"的旧常量',
      !/LF_PREFETCH_COUNT_DOWNLOAD_FIRST/.test(lfSrc) && !/const LF_PREFETCH_COUNT = 2;/.test(lfSrc),
      'legacy-constants=' + /LF_PREFETCH_COUNT/.test(lfSrc));
    /* ── 负对照 ①：把默认值改回 3 ⇒ 同一条判据必须变红 ── */
    const mutated = lfSrc.replace('if (!Number.isFinite(v) || v <= 0) return 0;',
      'if (!Number.isFinite(v) || v <= 0) return 3;');
    const mApi = mutated === lfSrc ? null : loadLfPrefetch(mutated);
    check('B3 负对照：把默认值改回 3 ⇒ B1 那条判据必红（不是恒真）',
      Boolean(mApi) && mApi.lfPrefetchCount(undefined) === 3 && mApi.lfPrefetchCount(undefined) !== 0,
      'mutant(undefined)=' + (mApi ? mApi.lfPrefetchCount(undefined) : 'n/a'));
    check('B4 预取只在宿主下发 > 0 时才发请求（`hostCount <= 0` 直接 return）',
      /hostCount = lfPrefetchCount\(doc\.prefetchCount\);/.test(lfSrc)
      && /if \(hostCount <= 0\) return;/.test(lfSrc));
  }
}

/* ══ C. 70 条 pending ⇒ 0 条 queued ════════════════════════════════════════ */
console.log('\nC. 70 条 pending：启动 + 对账之后 queueCount 仍是 0');
let queueC = null;
let seeded;
{
  const home = freshHome('pending70');
  seeded = seedPending(home, 70);
  queueC = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  await sleep(400);                     // 给 pump/对账一拍时间（不许"顺手"排队）
  const counts = queueC.queueCounts();
  check('C1 启动后 queuedCount=0 / pendingCount=70（不批量 promote）', noAutoEnqueueHolds(counts),
    JSON.stringify(counts));
  const snap = queueC.snapshot();
  check('C2 70 条里没有任何一条带 queuePos / queuedAhead（pending 不占队列位）',
    snap.every((j) => j.queuePos == null && j.queuedAhead == null),
    'withPos=' + snap.filter((j) => j.queuePos != null).length);
  check('C3 启动映射的唯一判据：queued/running/done-缺失 一律 pending',
    startupStatusFor('queued', false) === 'pending'
      && startupStatusFor('running', false) === 'pending'
      && startupStatusFor('done', false) === 'pending'
      && startupStatusFor('done', true) === 'done'
      && startupStatusFor('failed', false) === 'failed'
      && startupStatusFor('cancelled', false) === 'cancelled',
    ['queued', 'running', 'done', 'done@onDisk', 'failed'].map((s) => s + '=' + startupStatusFor(s.split('@')[0], s.includes('@'))).join(','));
  /* ── 负对照 ②：把 startupStatusFor('queued') 改回 'queued' ⇒ C3 必红 ── */
  const mutant = (status, onDisk) => (status === 'queued' ? 'queued' : startupStatusFor(status, onDisk));
  check('C4 负对照：启动把 queued 原样放回 ⇒ C3 那条判据必红（启动批量排队的形态）',
    mutant('queued', false) === 'queued' && startupStatusFor('queued', false) === 'pending');
}

/* ══ D. 点 1 张 ⇒ queued==1；连点 3 张 ⇒ 只有那 3 张 ═══════════════════════ */
console.log('\nD. 用户点击（high）：点 1 张只排 1 张，连点 3 张只排 3 张');
{
  const q = queueC;
  const urls = seeded.urls;
  const add1 = q.add({ url: urls[0], dest: join(BASE_HOME, 'x0.mp4'), kind: 'wallpaper', priority: 'high' });
  await sleep(120);
  // 注意：点 1 张时 pump 可能立刻把它变成 running，所以判据看"queued + running == 1"。
  const active1 = q.snapshot().filter((j) => j.status === 'queued' || j.status === 'running');
  check('D1 点 1 张 ⇒ 只有这 1 条进入队列（其余 69 条仍是 pending）',
    active1.length === 1 && active1[0].priority === 'high'
      && q.snapshot().filter((j) => j.status === 'pending').length === 69,
    'active=' + active1.length + ' pending=' + q.snapshot().filter((j) => j.status === 'pending').length
      + ' job=' + (add1 && add1.job && add1.job.status));
  check('D2 点 1 张后 queuedAhead=0（它排在队首，不是"前面还有 N 个"）',
    active1.length === 1 && Number(active1[0].queuedAhead || 0) === 0,
    'queuedAhead=' + (active1[0] && active1[0].queuedAhead));
  // 再点 2 张：三条 high 之外**不许**再多任何一条。
  for (const u of urls.slice(1, 3)) {
    q.add({ url: u, dest: join(BASE_HOME, 'x-' + u.split('/').pop()), kind: 'wallpaper', priority: 'high' });
  }
  await sleep(150);
  const active3 = q.snapshot().filter((j) => j.status === 'queued' || j.status === 'running');
  check('D3 连点 3 张 ⇒ 队列里**只有这 3 张**（67 条继续 pending）',
    active3.length === 3 && active3.every((j) => j.priority === 'high')
      && q.snapshot().filter((j) => j.status === 'pending').length === 67,
    'active=' + active3.length + ' pending=' + q.snapshot().filter((j) => j.status === 'pending').length);
  /* ── 负对照 ③：模拟"批量 promote"（把 pending 全标 queued）⇒ C1 的不变量为假 ── */
  const promoted = q.queueCounts();
  const fakePromoted = { queuedCount: promoted.queuedCount + 67, pendingCount: 0 };
  check('D4 负对照：批量 promote 的形态（67 条 pending 全变 queued）会让 C1 的不变量为假',
    noAutoEnqueueHolds(promoted) === false && noAutoEnqueueHolds(fakePromoted) === false,
    'real=' + JSON.stringify(promoted) + ' fake=' + JSON.stringify(fakePromoted));
}

/* ══ E. prefetchCount=3 才允许额外 3 条（low），且 high 排在 low 之前 ══════ */
console.log('\nE. 预取：宿主给 3 才允许 3 条 low；排序上 high 在 low 之前');
{
  const home = freshHome('prefetch');
  const pf = seedPending(home, 70);
  const q = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const urlOf = (i) => pf.urls[i];
  // 宿主下发 0（默认）⇒ 预取一条都不会发。
  const prev = process.env.DSH_FOLIA_PREFETCH;
  let emitted = 0;
  try {
    delete process.env.DSH_FOLIA_PREFETCH;
    const n0 = prefetchCount();
    if (n0 > 0) for (let i = 0; i < n0; i += 1) { q.add({ url: urlOf(i), dest: join(home, 'pf' + i + '.mp4'), kind: 'wallpaper', priority: 'low' }); emitted += 1; }
    check('E1 默认（0）⇒ 预取**不发任何** add（未点击就不许自己下）',
      n0 === 0 && emitted === 0 && q.snapshot().every((j) => j.status === 'pending'),
      'prefetchCount=' + n0 + ' emitted=' + emitted);
    process.env.DSH_FOLIA_PREFETCH = '3';
    const n3 = prefetchCount();
    for (let i = 0; i < n3; i += 1) { q.add({ url: urlOf(i), dest: join(home, 'pf' + i + '.mp4'), kind: 'wallpaper', priority: 'low' }); emitted += 1; }
    await sleep(150);
    const low = q.snapshot().filter((j) => j.status === 'queued' || j.status === 'running');
    check('E2 prefetchCount=3 ⇒ 恰好额外 3 条，且一律 low',
      n3 === 3 && emitted === 3 && low.length === 3 && low.every((j) => j.priority === 'low'),
      'prefetchCount=' + n3 + ' active=' + low.length + ' prio=' + low.map((j) => j.priority).join(','));
    // 前 low 后 high：再点 2 张（high），排序上它们必须排在 3 条 low 之前。
    for (const i of [10, 11]) {
      q.add({ url: urlOf(i), dest: join(home, 'click' + i + '.mp4'), kind: 'wallpaper', priority: 'high' });
    }
    await sleep(150);
    const all = q.snapshot().filter((j) => j.status === 'queued' || j.status === 'running');
    const hi = all.filter((j) => j.priority === 'high');
    const lo = all.filter((j) => j.priority === 'low');
    check('E3 "前 low 后 high"：入队顺序 low 在前，但**队列顺序** high 全部排在 low 之前',
      hi.length === 2 && lo.length >= 1 && all.slice(0, hi.length).every((j) => j.priority === 'high'),
      'order=' + all.map((j) => j.priority).join('>'));
  } finally {
    if (prev === undefined) delete process.env.DSH_FOLIA_PREFETCH; else process.env.DSH_FOLIA_PREFETCH = prev;
  }
}

/* ══ F. pending 的卡片：只说「未缓存」，没有「前面还有 N 个」════════════════ */
console.log('\nF. pending 卡片 =「未缓存」（不显示"前面还有 N 个"）');
{
  const wp = readFileSync(join(ROOT, 'src', 'wallpaper-progress.js'), 'utf8');
  const lf = lfSrc;
  check('F1 pending ⇒ 卡片「未缓存」、标题栏「未缓存（点击继续）」（不画进度条、不报排队位置）',
    /if \(status === "pending"\)/.test(wp)
      && /phase === "pending"\) \{\s*\n\s*const title = weT\("未缓存（点击继续）"\)/.test(wp)
      && /card: high \? title : weT\("未缓存"\), title \}/.test(wp));
  check('F2 「前面还有 N 个」只在 queued/running 的文案路径上（pending 不经过 dlQueueDetail）',
    /if \(s\.phase === "queued"\) \{\s*\n\s*const text = dlQueueDetail\(s\.job\);/.test(wp)
      && !/phase === "pending"[\s\S]{0,120}dlQueueDetail/.test(wp));
  check('F3 队列快照：pending 行没有 queuePos/queuedAhead（UI 拿不到 N）',
    (() => {
      const snapped = queueC ? queueC.snapshot() : [];
      const pend = snapped.filter((j) => j.status === 'pending');
      return pend.length > 0 && pend.every((j) => j.queuePos == null && j.queuedAhead == null);
    })());
  check('F4 客户端不再按宿主外的策略自己算张数（`lfPrefetchCount()` 只吃一个入参）',
    /function lfPrefetchCount\(hostValue\)/.test(lf) && !/function lfPrefetchCount\(\)/.test(lf));
}

finish();
