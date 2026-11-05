#!/usr/bin/env node
/**
 * verify-wallpaper-progress.mjs — **壁纸缓存进度的门禁**（4.23.17）。
 *
 * ## 守的是什么（用户口径原文）
 *
 *   ① 点一张没缓存的壁纸 ⇒ 卡片与顶部标题栏都显示「缓存中 62%」（卡片还有小进度条）；
 *   ② 下完 ⇒ 两处都不再出现百分比，卡片只说「已缓存」；
 *   ③ 点 A 再点 B：B 显示自己的进度，**A 的仍留在卡片上**（队列还在下 A）；
 *   ④ 切走再切回 A：已下好 ⇒ 不显示进度、只说「已缓存」；没下好 ⇒ **接着显示当前进度**
 *      （值来自 `/folia/downloads/list`，不是本地计时器从 0 数起）；
 *   ⑤ 原画与 1080p 变体是**同一族**：任一下好即算已缓存（复用 inventory 的 `localReady`）；
 *   ⑥ 排队 ⇒「排队中：前面还有 N 个任务」；失败 ⇒ 原因 +「重试」；没有 job 且没缓存 ⇒ 什么都不画。
 *
 * ## 判据怎么取（不复制"期望逻辑"）
 *
 * 真源码：`src/wallpaper-progress.js` 的**纯函数 + 存储**剥掉 `export {}` 后在 `new Function`
 * 里真跑；`dlJobActive / dlQueueDetail / dlProgressDetail / dlFailReason` 来自
 * `src/local-first.js` 的纯函数段（与 verify-downloads 同一口径）—— 文案与失败原因表**只有一份**。
 *
 * ## 负对照（必须有牙）
 *
 *   ⑦ 把"切回来从 0 开始"（旧病）的实现贴回：`wpSubscribe` 改用本地 0% 视图 + 退订即清快照
 *      ⇒ 同一个"切 A→B→A"断言必须**红**（`switchReturnPercent()` 返回 0 而不是 55）；
 *   ⑧ 源码级：本模块**不许**自己轮询（无 `setInterval` / 无 `/downloads/list` 直读）——
 *      轮询只有 `useDownloadJobs()` 一份，否则"1.5s + 无活跃 job 停表"就有了第二套口径。
 *
 * 隔离 home（`%TEMP%\folia-test-*`）：本判据只读源码，不碰宿主目录；仍然显式钉一次，
 * 保证"跑测试永远不是写用户 library"（4.23.15 事故驱动）。
 *
 * Usage: `node test/verify-wallpaper-progress.mjs`
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './tools/js-text.mjs';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = isolateTestHome('wallpaper-progress', { force: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

const MB = 1024 * 1024;

/** 词表插值（与其它守卫同一口径：`{p}` / `{detail}` 按 vars 替换）。 */
const weT = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (
  vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));

/** 最小 React 空壳：`createElement` 产出可遍历的描述对象（**不执行**组件，避免 hook 语义）。 */
const React = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
};

/* ── 真源码：src/local-first.js 的纯函数段（匹配 / 排队文案 / 进度明细 / 失败原因表）── */
function loadLocalFirst() {
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs(');
  if (a < 0 || b <= a) return null;
  try {
    return new Function('weT', src.slice(a, b)
      + '\nreturn { dlJobActive, dlQueueDetail, dlProgressDetail, dlFailReason };')(weT);
  } catch { return null; }
}

const LF = loadLocalFirst();

/** 真源码：`src/wallpaper-progress.js`（剥掉 `export {}` 后在 Function 里真跑）。 */
function loadProgress(srcOverride) {
  const raw = readFileSync(join(ROOT, 'src', 'wallpaper-progress.js'), 'utf8');
  const text = stripComments(String(srcOverride == null ? raw : srcOverride));
  if (!LF) return null;
  const body = text.replace(/^\s*export\s*\{[\s\S]*?\};?\s*$/gm, '');
  try {
    return new Function(
      'weT', 'React', 'dlJobActive', 'dlQueueDetail', 'dlProgressDetail', 'dlFailReason',
      'lfAddItem', 'apiPostJson', 'useDownloadJobs',
      body + `
return {
  WP_STORE, wpItemKey, wpItemUrls, wpJobForItem, wpPercentOf, wpStateOf, wpViewOf,
  wpSnapshotOf, wpPushJobs, wpSubscribe, wpUnsubscribe, wpCardRender, wpTitleRender,
  wpRetryDownload, useWallpaperProgress, WpJobsBridge, WpCardProgress,
};`,
    )(
      weT, React, LF.dlJobActive, LF.dlQueueDetail, LF.dlProgressDetail, LF.dlFailReason,
      (item, url, priority) => ({ kind: 'wallpaper', url: String(url || ''), priority: priority || 'normal' }),
      async () => ({ ok: true, data: { items: [] } }),
      () => ({ jobs: [], refresh: () => {} }),
    );
  } catch { return null; }
}

const mod = loadProgress(null);
const progressSrc = readFileSync(join(ROOT, 'src', 'wallpaper-progress.js'), 'utf8');

check('① 能取出 src/local-first.js 的纯函数段（文案/失败原因表只有一份）', Boolean(LF));
check('① 能取出 src/wallpaper-progress.js 并真跑（剥 export 后）', Boolean(mod));

/* ── DOM 断言小工具（描述对象，不依赖真 DOM）────────────────────────────────── */
function textOf(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  const own = typeof node.props?.title === 'string' ? [node.props.title] : [];
  return own.concat(textOf(node.children)).join(' ');
}
function findByClass(node, cls) {
  if (!node || typeof node !== 'object') return null;
  const c = typeof node.props?.className === 'string' ? node.props.className : '';
  if (c.split(/\s+/).includes(cls)) return node;
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const k of kids) {
    const hit = findByClass(k, cls);
    if (hit) return hit;
  }
  return null;
}

/* ── 夹具 ─────────────────────────────────────────────────────────────────── */
const ORIG = 'https://site.test/media/a.mp4';
const V1080 = 'https://site.test/media/a.1080p.mp4';
const itemA = { id: 'A', title: 'A', media: ORIG, localReady: false };
const itemB = { id: 'B', title: 'B', media: 'https://site.test/media/b.mp4', localReady: false };
const runJob = (url, percent, extra) => Object.assign({
  id: 'job-' + url + '-' + percent, kind: 'wallpaper', url,
  status: 'running', percent, received: Math.round(20 * MB * percent / 100), total: 20 * MB,
}, extra || {});

/* ══ ② 未缓存 + running(62%) ⇒ 卡片与标题栏都显示 62% ═══════════════════════════ */
if (mod) {
  const view = mod.wpViewOf(itemA, [runJob(ORIG, 62, { received: Math.round(12.3 * MB), total: 20 * MB })], 8);
  check('② running(62%) ⇒ 视图是 running + 62%（数字来自 job.percent）',
    view && view.phase === 'running' && view.percent === 62, JSON.stringify(view && { phase: view.phase, percent: view.percent }));
  check('② 卡片文案「缓存中 62%」', Boolean(view && /缓存中 62%/.test(view.card)), view && view.card);
  check('② 标题栏文案「缓存中 62%（12.3/20.0 MB · 约剩 8 秒）」',
    Boolean(view && /缓存中 62%/.test(view.title) && /12\.3\/20\.0 MB/.test(view.title) && /约剩 8 秒/.test(view.title)),
    view && view.title);
  const card = mod.wpCardRender(view, itemA);
  const title = mod.wpTitleRender(view, itemA);
  check('② 两处**都真的画出来**（卡片有小进度条 + 标题栏一条）',
    Boolean(card && findByClass(card, 'we-wp-progress') && findByClass(card, 'we-wp-progress__fill')
      && title && /62%/.test(textOf(title)) && /缓存中/.test(textOf(title))),
    textOf(card) + ' | ' + textOf(title));
  check('② 进度条宽度 = 62%（直接取 percent，不按时间估）',
    findByClass(card, 'we-wp-progress__fill')?.props?.style?.width === '62%',
    JSON.stringify(findByClass(card, 'we-wp-progress__fill')?.props?.style));
  check('② 卡片上不显示「已缓存」（还在下）', !/已缓存/.test(textOf(card)));
}

/* ══ ⑥ queued ⇒ 排队位置（复用 dlQueueDetail，不另造一句）════════════════════ */
if (mod) {
  const view = mod.wpViewOf(itemA, [Object.assign(runJob(ORIG, 0), { status: 'queued', queuePos: 3 })]);
  check('⑥ queued ⇒ 两处都是「排队中：前面还有 2 个任务」',
    Boolean(view && view.phase === 'queued'
      && view.card === '排队中：前面还有 2 个任务' && view.title === view.card),
    JSON.stringify(view && { phase: view.phase, card: view.card }));
  check('⑥ 排队态不显示百分比', Boolean(view && !/%/.test(view.card) && !/%/.test(view.title)));
}

/* ══ ③ 下完 ⇒ 两处都不再显示百分比；卡片只说「已缓存」════════════════════════ */
if (mod) {
  const view = mod.wpViewOf(itemA, [Object.assign(runJob(ORIG, 100), { status: 'done', received: 20 * MB })]);
  check('③ done ⇒ 卡片「已缓存」、标题栏不画进度、两处都没有百分比',
    Boolean(view && view.phase === 'cached' && view.card === '已缓存' && view.title == null
      && !/%/.test(view.card)),
    JSON.stringify(view && { phase: view.phase, card: view.card, title: view.title }));
  const card = mod.wpCardRender(view, itemA);
  check('③ 卡片「已缓存」是**角标**（we-wp-cached），不再有进度条',
    Boolean(findByClass(card, 'we-wp-cached')) && !findByClass(card, 'we-wp-progress')
      && /已缓存/.test(textOf(card)));
  check('③ 标题栏在 done 时返回 null（这一行不再出现进度）', mod.wpTitleRender(view, itemA) === null);
}

/* ══ ④ 切 A→B→A：未完成时切回仍显示**列表里的真实进度** ═════════════════════ */
function switchAwayAndBack(m) {
  const out = { away: [], after: null };
  m.wpPushJobs([runJob(ORIG, 30)], 1000);
  let cur = null;
  const offA = m.wpSubscribe(itemA, (v) => { cur = v; });
  out.away.push(cur && cur.percent);
  offA();                                            // 关掉库视图：卡片卸载
  // 队列继续（A 走到 55%），期间 B 入队
  m.wpPushJobs([runJob(ORIG, 55), runJob(itemB.media, 10)], 2500);
  // 切回来：重新订阅 A ⇒ 必须立刻是 55%（不是 0、不是重新计时）
  const offA2 = m.wpSubscribe(itemA, (v) => { cur = v; });
  out.after = cur && cur.percent;
  // 只给时间不给新快照 ⇒ 仍然是 55%（进度不是本地计时器涨的）
  m.wpPushJobs([runJob(ORIG, 55), runJob(itemB.media, 10)], 9000);
  out.still = cur && cur.percent;
  out.cancel = () => { offA2(); };
  return out;
}
if (mod) {
  const r = switchAwayAndBack(mod);
  check('④ 切走 A 时它显示 30%', r.away[0] === 30, 'away=' + JSON.stringify(r.away));
  check('④ 切回 A：读 /downloads/list 的**当前**值 55%（不是从头 0%）', r.after === 55, 'after=' + r.after);
  check('④ 时间流逝本身不推进度（仍 55%，证明不是本地计时器）', r.still === 55, 'still=' + r.still);
  // A 与 B 同时可见时各显示各的（A 的进度留在卡片上）
  const seen = new Map();
  const offA = mod.wpSubscribe(itemA, (v) => seen.set('A', v));
  const offB = mod.wpSubscribe(itemB, (v) => seen.set('B', v));
  mod.wpPushJobs([runJob(ORIG, 70), runJob(itemB.media, 40)], 10000);
  check('④ 点 B 之后 A、B 各自显示自己的真实进度（A 的不被抹掉）',
    seen.get('A')?.percent === 70 && seen.get('B')?.percent === 40,
    JSON.stringify({ A: seen.get('A')?.percent, B: seen.get('B')?.percent }));
  offA(); offB(); r.cancel();

  // A 已完成时切回：无百分比、只有「已缓存」
  mod.wpPushJobs([Object.assign(runJob(ORIG, 100), { status: 'done' })], 11000);
  let back = null;
  const offDone = mod.wpSubscribe(itemA, (v) => { back = v; });
  check('④ A 已完成时切回 ⇒ 无百分比、只有「已缓存」',
    Boolean(back && back.phase === 'cached' && back.card === '已缓存' && !/%/.test(back.card)),
    JSON.stringify(back && { phase: back.phase, card: back.card }));
  offDone();
}

/* ══ ⑤ 族命中：localReady（原画或 1080p 任一档已落地）⇒ 已缓存、不显示进度 ═════ */
if (mod) {
  const itemFamily = { id: 'F', media: ORIG, localReady: true, variants: [{ url: V1080, height: 1080 }] };
  const view = mod.wpViewOf(itemFamily, []);
  check('⑤ 族已缓存（localReady）⇒ 「已缓存」，不显示进度',
    Boolean(view && view.phase === 'cached' && view.card === '已缓存' && view.title == null));
  check('⑤ 族命中：本地副本地址 / 1080p 变体地址都算"这张卡的 job"',
    Boolean(mod.wpJobForItem([runJob(V1080, 20)], { id: 'F', media: ORIG, variants: [{ url: V1080, height: 1080 }] }))
      && Boolean(mod.wpJobForItem([runJob('/folia/local-media/x', 100, { status: 'done' })],
        { id: 'F', media: ORIG, localDownload: { url: '/folia/local-media/x' } })));
  const famJob = mod.wpViewOf(
    { id: 'F2', media: ORIG, localReady: false, variants: [{ url: V1080, height: 1080 }] },
    [runJob(V1080, 20)], 0);
  check('⑤ 下的是 1080p 变体时，原画那张卡的进度也能对上（族内 URL 集合）',
    Boolean(famJob && famJob.phase === 'running' && famJob.percent === 20),
    JSON.stringify(famJob && { phase: famJob.phase, percent: famJob.percent }));
}

/* ══ ⑨ 用户实测三场景（4.23.22，P1）：选中项与"别的在下载"的卡片分别显示什么 ══
 *
 *   ① 选中的那张正在下载 ⇒ 标题栏 + 卡片都显示「缓存中 x%」；
 *   ② 选中的那张已 localReady、但队列里**别的**在下载 ⇒ 标题栏不显示（合理），
 *      **那些卡片**各自显示自己的进度（这是旧版快捷面板的显示缺口：卡片根本没挂进度）；
 *   ③ 选中项 pending（未开始）⇒ 卡片「未缓存」，不显示假进度、标题栏不显示。
 */
if (mod) {
  const itemC = { id: 'C', title: 'C', media: 'https://site.test/media/c.mp4', localReady: false };
  // ②：选中 A 已缓存；B/C 在下载。
  const selectedCached = Object.assign({}, itemA, { localReady: true });
  const jobB = runJob(itemB.media, 88, { received: Math.round(17.6 * MB), total: 20 * MB });
  const jobC = runJob(itemC.media, 93, { received: Math.round(18.6 * MB), total: 20 * MB });
  const vSel = mod.wpViewOf(selectedCached, [jobB, jobC]);
  check('⑨② 选中项已 localReady + 别的在下载 ⇒ 标题栏不显示进度（合理）',
    Boolean(vSel && vSel.phase === 'cached' && vSel.title == null && vSel.card === '已缓存'),
    JSON.stringify(vSel && { phase: vSel.phase, card: vSel.card, title: vSel.title }));
  const vB = mod.wpViewOf(itemB, [jobB, jobC]);
  const vC = mod.wpViewOf(itemC, [jobB, jobC]);
  check('⑨② 别的下载中的卡片各自显示「缓存中 88% / 93%」（标题栏不必显示）',
    Boolean(vB && vB.phase === 'running' && vB.percent === 88 && /缓存中 88%/.test(vB.card)
      && vC && vC.phase === 'running' && vC.percent === 93 && /缓存中 93%/.test(vC.card)),
    JSON.stringify({ B: vB && vB.card, C: vC && vC.card }));
  const cardB = mod.wpCardRender(vB, itemB);
  check('⑨② 那些卡片真的画出进度条（不是只有标题栏有）',
    Boolean(cardB && findByClass(cardB, 'we-wp-progress')
      && findByClass(cardB, 'we-wp-progress__fill')?.props?.style?.width === '88%'),
    textOf(cardB));

  // ①：选中的那张自己在下载（未缓存）⇒ 两处都有。
  const vSelf = mod.wpViewOf(itemC, [jobC]);
  check('⑨① 选中项正在下载 ⇒ 卡片 + 标题栏都显示 93%',
    Boolean(vSelf && vSelf.phase === 'running' && /缓存中 93%/.test(vSelf.card)
      && /缓存中 93%/.test(vSelf.title)),
    JSON.stringify({ card: vSelf && vSelf.card, title: vSelf && vSelf.title }));
  check('⑨① 两处渲染器都真的输出节点',
    Boolean(findByClass(mod.wpCardRender(vSelf, itemC), 'we-wp-progress')
      && /93%/.test(textOf(mod.wpTitleRender(vSelf, itemC)))));

  // ③：选中项 pending ⇒ 只给静态「未缓存」，没有假进度。
  const pendingJob = Object.assign(runJob(itemC.media, 0), { status: 'pending', percent: 0 });
  const vPending = mod.wpViewOf(itemC, [pendingJob]);
  check('⑨③ 选中项 pending ⇒ 卡片「未缓存」、标题栏不显示、无百分比',
    Boolean(vPending && vPending.phase === 'pending' && vPending.card === '未缓存'
      && vPending.title == null && !/%/.test(vPending.card)),
    JSON.stringify(vPending && { phase: vPending.phase, card: vPending.card }));
  const cardPending = mod.wpCardRender(vPending, itemC);
  check('⑨③ pending 卡片是静态角标（we-wp-pending，没有进度条）',
    Boolean(findByClass(cardPending, 'we-wp-pending') && !findByClass(cardPending, 'we-wp-progress')),
    textOf(cardPending));
}

/* ══ ⑥ failed ⇒ 「重试」+ 原因（复用 dlFailReason）════════════════════════════ */
if (mod) {
  const job = Object.assign(runJob(ORIG, 0), { status: 'failed', error: 'http-404' });
  const view = mod.wpViewOf(itemA, [job]);
  const why = LF.dlFailReason('http-404');
  check('⑥ failed ⇒ 视图带原因（与 dlFailReason 同一句）',
    Boolean(view && view.phase === 'failed' && view.title === why && view.card === '重试'),
    JSON.stringify(view && { phase: view.phase, card: view.card }));
  const card = mod.wpCardRender(view, itemA);
  const title = mod.wpTitleRender(view, itemA);
  check('⑥ 卡片与标题栏都给出「重试」按钮 + 原因',
    Boolean(findByClass(card, 'we-wp-failed__retry') && /404/.test(textOf(card))
      && findByClass(title, 'we-wp-failed__retry') && /404/.test(textOf(title))),
    textOf(card) + ' | ' + textOf(title));
  check('⑥ 失败态不显示百分比', Boolean(view && !/%/.test(textOf(card))));
}

/* ══ ⑥ 没有 job 且未缓存 ⇒ 不渲染任何进度元素 ═════════════════════════════════ */
if (mod) {
  const view = mod.wpViewOf({ id: 'N', media: ORIG, localReady: false }, []);
  check('⑥ 无活跃 job 且未缓存 ⇒ 视图 null（避免噪音）', view === null, String(view));
  check('⑥ 两处渲染器都返回 null（一个进度节点都不留）',
    mod.wpCardRender(view, { id: 'N' }) === null && mod.wpTitleRender(view, { id: 'N' }) === null);
}

/* ══ ⑤ 性能：一次轮询只通知"显示内容变了"的卡（不整列表重渲染）═══════════════ */
if (mod) {
  const calls = new Map();
  const mk = (id, media) => ({ id, media, localReady: false });
  const i1 = mk('P1', 'https://site.test/p1.mp4');
  const i2 = mk('P2', 'https://site.test/p2.mp4');
  const i3 = mk('P3', 'https://site.test/p3.mp4');
  const off1 = mod.wpSubscribe(i1, () => calls.set('P1', (calls.get('P1') || 0) + 1));
  const off2 = mod.wpSubscribe(i2, () => calls.set('P2', (calls.get('P2') || 0) + 1));
  const off3 = mod.wpSubscribe(i3, () => calls.set('P3', (calls.get('P3') || 0) + 1));
  calls.clear();                                    // 订阅那次的首帧回调不计
  mod.wpPushJobs([runJob(i2.media, 40)], 12000);    // 只有 P2 有可见变化
  check('⑤ 只有显示内容变了的卡被通知（P2 一次；P1/P3 零次）',
    (calls.get('P2') || 0) === 1 && (calls.get('P1') || 0) === 0 && (calls.get('P3') || 0) === 0,
    JSON.stringify([...calls.entries()]));
  mod.wpPushJobs([runJob(i2.media, 40)], 12500);    // 同一百分比重复推送 ⇒ 不通知
  check('⑤ 同一快照重复推送不触发生效渲染（签名去重）', (calls.get('P2') || 0) === 1,
    JSON.stringify([...calls.entries()]));
  off1(); off2(); off3();
}

/* ══ 「重试」按钮的动作：重新入队（high）+ 立刻刷新队列 ═══════════════════════ */
if (mod) {
  const posted = [];
  let refreshed = 0;
  const m2 = (() => {
    const raw = readFileSync(join(ROOT, 'src', 'wallpaper-progress.js'), 'utf8');
    const body = stripComments(raw).replace(/^\s*export\s*\{[\s\S]*?\};?\s*$/gm, '');
    return new Function('weT', 'React', 'dlJobActive', 'dlQueueDetail', 'dlProgressDetail', 'dlFailReason',
      'lfAddItem', 'apiPostJson', 'useDownloadJobs',
      body + '\nreturn { wpRetryDownload, WP_STORE };')(
      weT, React, LF.dlJobActive, LF.dlQueueDetail, LF.dlProgressDetail, LF.dlFailReason,
      (item, url, priority) => ({ kind: 'wallpaper', url: String(url || ''), priority }),
      async (path, bodyIn) => { posted.push({ path, body: bodyIn }); return { ok: true }; },
      () => ({ jobs: [], refresh: () => { refreshed += 1; } }),
    );
  })();
  m2.WP_STORE.refresh = () => { refreshed += 1; };
  const ok = await m2.wpRetryDownload(itemA);
  check('「重试」⇒ POST /downloads/add 一条 kind=wallpaper、priority=high 的入队',
    ok === true && posted.length === 1 && posted[0].path === '/downloads/add'
      && posted[0].body.items[0].kind === 'wallpaper' && posted[0].body.items[0].priority === 'high',
    JSON.stringify(posted));
  check('「重试」⇒ 立刻刷新一次队列（不必等下一拍 1.5s）', refreshed === 1, 'refreshed=' + refreshed);
}

/* ══ ⑦ 负对照：把"切回来从 0 开始"的旧实现贴回 ⇒ 同一个断言必须红 ═════════════ */
if (mod) {
  const legacySrc = progressSrc
    // ① 订阅时用"本地计时器视图"（从 0 开始）而不是 /downloads/list 的真实值
    .replace('  try { fn(wpSnapshotOf(item)); } catch { /* 组件已卸载：忽略 */ }',
      '  try { fn({ phase: "running", percent: 0, card: weT("缓存中 {p}%", { p: 0 }), title: "" }); } catch { /* 旧病 */ }')
    // ② 切走即清快照（进度"消失"）
    .replace('function wpUnsubscribe(key, fn) {', 'function wpUnsubscribe(key, fn) {\n  WP_STORE.jobs = [];');
  const legacy = loadProgress(legacySrc);
  check('⑦ 旧实现（切回来从 0 开始 + 切走清快照）能编译（负对照真的在跑）', Boolean(legacy));
  if (legacy) {
    const r = switchAwayAndBack(legacy);
    check('⑦ 负对照：旧实现的"切回 A"读到 0%（不是 55%）⇒ 主判据会红',
      r.after !== 55 && r.after === 0, 'legacy after=' + r.after);
  }
}

/* ══ ⑧ 源码级：单一份轮询 + 两处接线（少一处，那一处就永远不显示进度）════════ */
{
  const codeOnly = stripComments(progressSrc);
  check('⑧ 进度层不自己轮询（无 setInterval / 无 /downloads/list 直读）',
    !/setInterval\s*\(/.test(codeOnly) && !/\/downloads\/list/.test(codeOnly));
  check('⑧ 轮询只有一份：桥直接调既有的 useDownloadJobs()',
    /function WpJobsBridge\(\)/.test(progressSrc) && /useDownloadJobs\(\)/.test(progressSrc));
  const picker = readFileSync(join(ROOT, 'src', 'picker-modal.js'), 'utf8');
  const qp = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8');
  check('⑧ 壁纸选择器卡片接了它（WpCardProgress）',
    /WpCardProgress/.test(picker) && /React\.createElement\(WpCardProgress/.test(picker));
  check('⑧ 库视图挂了队列桥（WpJobsBridge，且只在这里）',
    /React\.createElement\(WpJobsBridge/.test(picker));
  check('⑧ 顶部当前壁纸那一行接了它（QpCacheHint → wpTitleRender）',
    /useWallpaperProgress\(/.test(qp) && /wpTitleRender\(/.test(qp));
  check('⑧ 快捷面板也挂了队列桥（侧栏标题栏才有进度）',
    /React\.createElement\(WpJobsBridge/.test(qp));
  // 4.23.22（P1 显示缺口）：旧版快捷面板的行/卡片只有「已缓存」角标，**没有**进度组件 ——
  // 用户点一张正在下载的壁纸时，侧栏里看不到任何「缓存中 x%」。
  check('⑧ 快捷面板的列表行与卡片档都接了卡片进度（qpRenderRow / qpRenderCard → WpCardProgress）',
    (qp.match(/React\.createElement\(WpCardProgress, \{ key: "we-wp", item: w \}\)/g) || []).length >= 2);
  const build = readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8');
  check('⑧ 已登记进 INLINE_MODULES（漏登记 = 文件存在但从不进产物）',
    /file: 'src\/wallpaper-progress\.js'/.test(build));
}

/* ══ 汇总 ═══════════════════════════════════════════════════════════════════ */
cleanupTestHome(TEST_HOME);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\nWALLPAPER PROGRESS CHECKS FAILED — ' + failed.length + ' 条：');
  for (const f of failed) console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : ''));
  process.exit(1);
}
console.log('\nALL WALLPAPER PROGRESS CHECKS PASSED — ' + results.length + ' 条');
