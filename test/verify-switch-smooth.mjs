// Verify the **cached-wallpaper switch path** (4.23.8) —
// 「点已下载好的壁纸会卡一下才播」的五条成因与逐条修法的判据。
//
// 为什么这个守卫是"两段式"的（先纯函数 / 先模块，再结构）：
//   这一族缺陷**全部**是"量不出来就只能靠感觉"的那一类 —— 用户说"卡一下"，
//   而"卡"既可能是**元素重建**（解码器），也可能是**缓存族不命中**（网络）。
//   两者在屏幕上长得一模一样，但修法完全不同。于是本文件先把**可纯函数化的判据**
//   钉死（缓存族键、池身份、状态机迁移），再用**结构判据**证明它们真的接在切换路径上。
//
// 覆盖（编号对齐交付清单）：
//   A. 缓存族归一化                          → 需求 B6 / H13 / 判据 13
//   B. 双元素池 + 切换状态机 + 连点防护      → 需求 A1/A2/A5 / G7 / H11 / H13 / 判据 11–12
//   C. 点击反馈 / 缓冲提示 / 失败重试 / 度量 → 需求 G1–G5 / D9 / H8–H10 / H14–H15 / 判据 14–15
//   D. 结构判据：池真的接在切换路径上        → 需求 A1（不许再有裸 createElement("video")）
//
// Usage: node test/verify-switch-smooth.mjs
import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ══════════════════════════════════════════════════════════════════════════════
// A. 缓存族归一化（`lib/switch-cache-family.js` 是纯函数，零依赖）
// ══════════════════════════════════════════════════════════════════════════════
async function sectionFamily() {
  const { familyKeyOf, pickFamilyCopy, localReadyOf } = await import('../lib/switch-cache-family.js');

  // A1 原画与 1080p 变体必须是**同一条缓存族** —— 这正是"已下载却仍走代理"的根因。
  check('A1 原画与 1080p 变体归入同一缓存族',
    familyKeyOf('https://s/a/rainy-night.mp4') === familyKeyOf('https://s/a/rainy-night-1080p.mp4'));

  // A2 族键必须忽略查询串：站点变体 URL 常带 `?u=` / `?v=`。
  check('A2 族键忽略查询串',
    familyKeyOf('https://s/a/x.mp4') === familyKeyOf('https://s/a/x-1080p.mp4?u=abc&v=2'));

  // A3 叠了两段的站点命名（`x-1080p-hevc`）也要能收敛到同一族。
  check('A3 叠加后缀（-1080p-hevc）仍收敛到同一族',
    familyKeyOf('https://s/a/x-1080p-hevc.mp4') === familyKeyOf('https://s/a/x.mp4'));

  // A4 **负对照**：不同的壁纸绝不许并族 —— 并错了是"放错壁纸"，比"缓存不命中"更糟。
  check('A4 负对照：两张不同壁纸不并族',
    familyKeyOf('https://s/a/rainy-night.mp4') !== familyKeyOf('https://s/a/sunny-day.mp4'));

  // A5 **负对照**：夹在中间（不是结尾）的 1080p 不许被剥 —— 那是名字的一部分。
  check('A5 负对照：词中间的 1080p 不被剥掉',
    familyKeyOf('https://s/a/my-1080p-wallpaper.mp4') !== familyKeyOf('https://s/a/my-wallpaper.mp4'));

  // A6 kind 参与族键：壁纸与皮肤的 x.mp4 是两回事。
  check('A6 kind 参与族键（wallpaper ≠ skin）',
    familyKeyOf('https://s/a/x.mp4', 'wallpaper') !== familyKeyOf('https://s/a/x.mp4', 'skin'));

  // A7 认不出的 token 形态 basename 必须退化成精确匹配（安全方向）。
  check('A7 负对照：token 形态 basename 退回精确匹配',
    familyKeyOf('https://s/a/abc123XYZ') !== familyKeyOf('https://s/a/def456UVW'));

  // A8 族命中：只下了 1080p，问原画时也必须认。
  const jobs = [
    { id: 'j1', url: 'https://s/a/rainy-night-1080p.mp4', kind: 'wallpaper', status: 'done', total: 100 },
    { id: 'j2', url: 'https://s/a/other.mp4', kind: 'wallpaper', status: 'done', total: 5 },
    { id: 'j3', url: 'https://s/a/rainy-night.mp4', kind: 'wallpaper', status: 'running' },
  ];
  const hit = pickFamilyCopy(jobs, 'https://s/a/rainy-night.mp4', 'wallpaper');
  check('A8 只落了 1080p 时，问原画也能命中（localReady）',
    !!hit && hit.job.id === 'j1' && hit.family === true, hit ? 'job=' + hit.job.id : 'null');
  check('A9 族里没有已落地的就不许命中（负对照）',
    pickFamilyCopy(jobs, 'https://s/a/never-downloaded.mp4', 'wallpaper') === null);

  // A10 精确命中优先于族命中：用户点了原画就优先给原画，画质不打折。
  const jobs2 = [
    { id: 'e1', url: 'https://s/a/x-1080p.mp4', kind: 'wallpaper', status: 'done' },
    { id: 'e2', url: 'https://s/a/x.mp4', kind: 'wallpaper', status: 'done' },
  ];
  const h2 = pickFamilyCopy(jobs2, 'https://s/a/x.mp4', 'wallpaper');
  check('A10 精确命中优先于族命中（画质无损）',
    !!h2 && h2.job.id === 'e2' && h2.family === false);

  // A11 localReady 是"族级"，与 local（精确）语义不同 —— 面板角标看它。
  check('A11 localReady 为族级判据',
    localReadyOf(jobs, 'https://s/a/rainy-night.mp4', 'wallpaper') === true
    && localReadyOf(jobs, 'https://s/a/never.mp4', 'wallpaper') === false);
}

// ══════════════════════════════════════════════════════════════════════════════
// B/C. 双元素池 + 状态机 + 点击反馈（假 DOM 直接驱动 `src/video-switch.js`）
// ══════════════════════════════════════════════════════════════════════════════
function installFakeDom() {
  const created = [];
  const card = () => {
    const classes = new Set();
    const attrs = {};
    return {
      _classes: classes, _attrs: attrs,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
    };
  };
  const makeVideo = () => {
    const handlers = {};
    const el = {
      tagName: 'VIDEO', dataset: {}, readyState: 0, muted: false, loop: false,
      preload: '', autoplay: false, src: '', poster: '',
      _loads: 0, _plays: 0,
      setAttribute() {}, removeAttribute() {},
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      removeEventListener() {},
      load() { this._loads += 1; },
      play() { this._plays += 1; this.readyState = Math.max(this.readyState, 2); return Promise.resolve(); },
      pause() {},
      _fire(t) { (handlers[t] || []).forEach((f) => f({ type: t })); },
    };
    created.push(el);
    return el;
  };
  const prev = { document: globalThis.document, performance: globalThis.performance };
  globalThis.document = {
    createElement: (t) => (String(t).toLowerCase() === 'video' ? makeVideo() : card()),
    getElementById: () => null,
  };
  globalThis.performance = { now: () => Date.now() };
  return { created, card, restore: () => { globalThis.document = prev.document; globalThis.performance = prev.performance; } };
}

async function sectionSwitch() {
  const dom = installFakeDom();
  let vs;
  try {
    vs = await import('../src/video-switch.js');
  } finally {
    // 模块级状态需要跨用例保持，所以这里不 restore document —— 本段内部自洽即可。
  }

  const u1 = 'https://s/a/one.mp4';
  const u2 = 'https://s/a/two-1080p.mp4';

  // ── B. 池：恒为两个元素，元素身份稳定（判据 11 / H11）──────────────────────
  const p1 = vs.weSwitchPoolPick(u1);
  const p2 = vs.weSwitchPoolPick(u2);
  check('B1 池只在首次申请时创建元素，容量恒为 2（判据 11 / H11）',
    dom.created.length === 2, 'created=' + dom.created.length);
  check('B2 两个池元素身份互不相同且带稳定 playerId（H11）',
    p1 !== p2 && Boolean(p1.dataset.wePlayerId) && Boolean(p2.dataset.wePlayerId)
    && p1.dataset.wePlayerId !== p2.dataset.wePlayerId,
    [p1.dataset.wePlayerId, p2.dataset.wePlayerId].join(','));

  // ── A5：同一 src 已加载 ⇒ 绝不重复 load() ─────────────────────────────────
  vs.weSwitchArm(p1, u1, null);
  p1.readyState = 2;
  const loadsMid = p1._loads;
  vs.weSwitchArm(p1, u1, null);
  check('B3 同一 src 已加载则不再 load()（需求 A5：禁止重复 load）',
    p1._loads === loadsMid, 'loads=' + p1._loads + ' mid=' + loadsMid);

  // ── 状态机：idle → priming → preloading → swapping → playing（判据 12 / A2）──
  check('B4 空闲态为 idle', vs.weSwitchState() === 'idle');
  const ctx = vs.weSwitchBegin(dom.card());
  check('B5 点击后进入 priming', vs.weSwitchState() === 'priming' && ctx.state === 'priming');
  vs.weSwitchAttachPlayer(p1, u1, { cacheFamilyHit: true, is1080p: false });
  check('B6 装上播放器后进入 preloading', vs.weSwitchState() === 'preloading');
  vs.weSwitchPublish(p1, {});
  check('B7 元素上屏后进入 swapping', vs.weSwitchState() === 'swapping');
  vs.weSwitchPlayed(p1);
  check('B8 首帧可见后结算回 idle（playing 已记录）', vs.weSwitchState() === 'idle');

  // 状态机**只走合法迁移**：不能从 idle 直接跳到 playing 而不经 preloading。
  const badJump = vs.weSwitchBegin(dom.card());
  let threw = false;
  try { vs.weSwitchPlayed(p1); } catch { threw = true; }
  check('B9 未经 attach 直接 played 不会留下残状态（状态机收敛）',
    !threw && (vs.weSwitchState() === 'idle' || vs.weSwitchState() === 'playing'),
    'state=' + vs.weSwitchState());
  if (badJump && !badJump.settled) vs.weSwitchFail('test-cleanup');

  // ── C. 点击反馈：clickFeedbackMs < 50ms（H8 / G1 / 判据 8）────────────────
  const c8 = vs.weSwitchBegin(dom.card());
  check('C1 按下即记 clickFeedbackMs 且 < 50ms（H8 / G1）',
    c8.feedbackMs < 50, 'feedbackMs=' + c8.feedbackMs);
  const cardEl = dom.card();
  vs.weSwitchBegin(cardEl);
  check('C2 切换期间卡片 aria-busy="true"（H14 / G1）',
    cardEl.getAttribute('aria-busy') === 'true' && cardEl._classes.has('we-qp__item--pressed'));
  vs.weSwitchFail('x');
  check('C3 收尾后 aria-busy 被放下、pressed 被摘掉（H14 / G6）',
    cardEl.getAttribute('aria-busy') === null && !cardEl._classes.has('we-qp__item--pressed'));
  if (c8 && !c8.settled) vs.weSwitchFail('test-cleanup');

  // ── 缓冲提示：1.5s 内没就绪 ⇒ 转 buffering（H9 负对照 / G2 / 判据 14）────
  const events = [];
  const off = vs.weSwitchSubscribe((ev) => events.push(ev));
  const slow = vs.weSwitchBegin(dom.card());
  vs.weSwitchAttachPlayer(p1, u2, { cacheFamilyHit: false });
  await sleep(1700);
  check('C4 1.5s 未达可播 ⇒ 状态机转 buffering（H9 负对照 / G2）',
    vs.weSwitchState() === 'buffering', 'state=' + vs.weSwitchState());
  check('C5 buffering 会向外发事件（面板据此画「正在缓冲 x%」）',
    events.some((e) => e.state === 'buffering'));
  if (slow && !slow.settled) vs.weSwitchFail('slow-source');

  // ── 失败 + 重试（H14 / G5 / 判据 14）──────────────────────────────────────
  const failCtx = vs.weSwitchBegin(dom.card());
  vs.weSwitchAttachPlayer(p1, u1, {});
  vs.weSwitchFail('decode');
  const lastFail = vs.weSwitchStatsSnapshot().slice(-1)[0];
  check('C6 失败记录原因且 ok=false（G5：绝不静默）',
    lastFail && lastFail.ok === false && lastFail.reason === 'decode',
    lastFail ? lastFail.reason : 'none');
  // 重试 = 重新进入同一状态机（不另写一套）
  const retryCtx = vs.weSwitchBegin(dom.card());
  check('C7 「重试」走同一个状态机入口（重新进入 priming）',
    retryCtx.state === 'priming' && retryCtx !== failCtx);
  if (retryCtx && !retryCtx.settled) vs.weSwitchFail('retry-cleanup');

  // ── 连点防护（G7 / H13 / 判据 13）──────────────────────────────────────────
  vs.weSwitchBegin(dom.card());
  vs.weSwitchAttachPlayer(p1, u1, {});
  const applied = [];
  const q1 = vs.weSwitchQueuePick('a', () => applied.push('a'));
  const q2 = vs.weSwitchQueuePick('b', () => applied.push('b'));
  const q3 = vs.weSwitchQueuePick('c', () => applied.push('c'));
  check('C8 切换中再点会被队列化并告知调用方（G7，要 toast「正在切换，请稍候」）',
    q1 && q2 && q3);
  vs.weSwitchPlayed(p1);
  check('C9 连点 3 次只补切最后一张（H13 / 判据 13：计数断言）',
    applied.length === 1 && applied[0] === 'c', JSON.stringify(applied));

  // ── 度量（D9 / H15 / 判据 15）──────────────────────────────────────────────
  const before = vs.weSwitchStatsSnapshot().length;
  for (let i = 0; i < 3; i += 1) {
    vs.weSwitchBegin(dom.card());
    vs.weSwitchAttachPlayer(p1, i === 1 ? u2 : u1, { cacheFamilyHit: i !== 1, is1080p: i === 1 });
    vs.weSwitchPublish(p1, {});
    vs.weSwitchPlayed(p1);
  }
  const after = vs.weSwitchStatsSnapshot();
  check('C10 快速切换 3 次 ⇒ 新增 3 条度量（H15 / 判据 15）',
    after.length - before === 3, 'delta=' + (after.length - before));
  const rec = after.slice(-2)[0];
  check('C11 每条度量都带 switchLatencyMs / clickFeedbackMs / cacheFamilyHit / is1080p（D9）',
    Number.isFinite(rec.switchLatencyMs) && Number.isFinite(rec.clickFeedbackMs)
    && typeof rec.cacheFamilyHit === 'boolean' && rec.is1080p === true,
    JSON.stringify(rec));
  const summary = vs.weSwitchStatSummary();
  check('C12 统计给出 clickFeedbackMs 的均值与最大值（需求 I）',
    Number.isFinite(summary.clickFeedbackMs.avg) && Number.isFinite(summary.clickFeedbackMs.max));

  // ── P0 回归（4.23.9）：**按下不能等于"切换已开始"** ────────────────────────
  // 实测故障：ptrdown 就建了切换上下文 ⇒ onClick 被连点防护判成"切换中"而 return
  // ⇒ `applySelection` 从来没被调用 ⇒ 点未缓存壁纸**毫无反应**。
  vs.weSwitchSettle();                       // 先收拾干净
  const pfCard = dom.card();
  vs.weSwitchPressFeedback(pfCard);
  check('P1 仅"按下"不得产生在飞切换（否则 onClick 会被连点防护吞掉）',
    vs.weSwitchBusy() === false, 'busy=' + vs.weSwitchBusy());
  check('P2 按下仍然有可见反馈（pressed + aria-busy）',
    pfCard._classes.has('we-qp__item--pressed') && pfCard.getAttribute('aria-busy') === 'true');

  // 非视频壁纸没有 weSwitchPlayed 那条腿 ⇒ 必须能靠 weSwitchSettle 收口，
  // 否则"切换在飞"恒真、之后的点击全部被挡。
  vs.weSwitchBegin(pfCard);
  check('P3 begin 后确实在飞（这一步是连点防护该拦的唯一情形）', vs.weSwitchBusy() === true);
  vs.weSwitchSettle();
  check('P4 非视频路径能结算（settle 后不再挡点击）', vs.weSwitchBusy() === false);
  check('P5 结算后卡片复位（pressed/aria-busy 摘掉）',
    !pfCard._classes.has('we-qp__item--pressed') && pfCard.getAttribute('aria-busy') === null);

  // 「每次点击最终必达 playing | buffering | failed」—— 不许有"既不入队也不切层"的静默态。
  const terminals = [];
  const c1 = vs.weSwitchBegin(dom.card()); vs.weSwitchSettle(); terminals.push(c1.state);
  const c2 = vs.weSwitchBegin(dom.card()); vs.weSwitchFail('decode'); terminals.push(c2.state);
  check('P6 每次切换都收敛到终态（playing / failed；buffering 是中间态）',
    terminals.every((s) => s === 'playing' || s === 'failed' || s === 'buffering'),
    terminals.join(','));
  // 池容量在全部用例之后仍然是 2 —— 没有泄漏出新解码器（H11）。
  check('C13 全部用例跑完仍只有 2 个池元素（H11：无解码器泄漏）',
    dom.created.length === 2, 'created=' + dom.created.length);
  off();
}

// ══════════════════════════════════════════════════════════════════════════════
// D. 结构判据：池必须真的接在切换路径上
// ══════════════════════════════════════════════════════════════════════════════
function sectionStructure() {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const videoLayer = read('../src/video-layer.js');

  // D1 `buildVideoMedia` 必须向池申请元素，不许自己造。
  check('D1 buildVideoMedia 向池申请播放器（weSwitchClickPlayer）',
    /function buildVideoMedia\(/.test(videoLayer) && videoLayer.includes('weSwitchClickPlayer('));

  // D2 视频档的重建路径里不许再有裸 `document.createElement("video")` —— 那正是
  //    成因 ① 的构造点。池的 `weSwitchNewPlayer()` 是唯一合法的创建点。
  //    判据**针对代码**：先剥注释（本仓既有口径 —— 注释里提到旧写法不算数）。
  //    **允许恰好一处**：`weLayerNewVideo()` 里那条 `typeof` 退化分支，专供
  //    `test/verify-transcode-state.mjs` 把本文件单文件加载时用（那时池模块不在作用域）。
  //    所以判据是"裸调用只许出现在那个守卫的函数体里"，而不是"全文零次"。
  const videoCode = videoLayer
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  // 「裸创建只许出现在 typeof 守卫的退化分支里」—— 按**行**判：那一行必须同时出现
  // `typeof weSwitchDetachedPlayer`。主路径（池）与这条退化分支因此可区分。
  const bareLines = videoCode.split('\n').map((l) => l.trim())
    .filter((l) => /document\.createElement\(\s*["']video["']\s*\)/.test(l));
  const bareCreate = bareLines.filter((l) => !l.includes('typeof weSwitchDetachedPlayer')).length;
  check('D2 视频通道里裸 document.createElement("video") 只许出现在 typeof 守卫的退化分支里',
    bareCreate === 0, 'bare=' + bareCreate + ' total=' + bareLines.length);

  // D3 点击反馈必须在 applySelection **之前**被调用（否则第一处视觉变化就晚了）。
  const quickPanel = read('../src/quick-panel.js');
  const beginAt = quickPanel.indexOf('weSwitchBegin(');
  const applyAt = quickPanel.indexOf('applySelection(w.id');
  check('D3 卡片点击先打反馈再 applySelection（G1：≤50ms 第一处视觉变化）',
    beginAt >= 0 && applyAt >= 0 && beginAt < applyAt,
    'beginAt=' + beginAt + ' applyAt=' + applyAt);

  // D4 池模块必须进了内联清单（否则上了屏却没有它）。
  const build = read('../scripts/build-client.mjs');
  check('D4 src/video-switch.js 已登记进 INLINE_MODULES',
    build.includes("file: 'src/video-switch.js'"));

  // D6 结构判据（P0 回归）：卡片点击**不许**因为"ptrdown 已按下"就跳过 applySelection。
  //    真实故障形态是 `weSwitchQueuePick(w.id, …)` 在 onClick 里提前 return。
  const qpCode = quickPanel
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  check('D6 onClick 里不再用 weSwitchQueuePick 提前 return（P0：那会吞掉每一次点击）',
    !/weSwitchQueuePick\(w\.id/.test(qpCode));
  // D7 结构判据（4.23.12 反转）：onClick **不许**再"busy 就 return"。
  //
  // 为什么把判据反过来：4.23.9 那版把 `if (weSwitchBusy()) { toast; return; }` 当成连点防护，
  // 前提是"上一次切换必然很快结算"。实测否证了这个前提（慢视频首帧 6–9 秒），于是这几秒里
  // 用户点「本机」里的场景壁纸会被整片吞掉 —— 表现就是"点了没反应"。
  // 现在的口径是 **last-click-wins**：onClick 一定走到 `weSwitchBegin()` + `applySelection()`，
  // 由 `weSwitchBegin()` 把上一次未结算的切换收口（reason='superseded'）。
  check('D7 onClick 不再因 weSwitchBusy() 提前 return，且一定调 applySelection（last-click-wins）', (() => {
    const sites = [];
    let at = qpCode.indexOf('onClick: (ev) => {');
    while (at >= 0) { sites.push(at); at = qpCode.indexOf('onClick: (ev) => {', at + 1); }
    if (!sites.length) return false;
    const okSites = sites.filter((start) => {
      const body = qpCode.slice(start, start + 900);
      const endAt = body.indexOf('onKeyDown');
      const seg = endAt > 0 ? body.slice(0, endAt) : body;
      const beginAt2 = seg.indexOf('weSwitchBegin(ev');
      const applyAt2 = seg.indexOf('applySelection(w.id');
      // 负对照的形态：seg 里出现 `weSwitchBusy()` 当**守卫**（后面紧跟 return）。
      const busyGuard = /weSwitchBusy\(\)\s*\)\s*\{[\s\S]{0,160}?return;/.test(seg);
      return !busyGuard && beginAt2 >= 0 && applyAt2 > beginAt2;
    });
    return okSites.length === sites.length && sites.length >= 2;
  })(), 'sites=' + (qpCode.match(/onClick: \(ev\) => \{/g) || []).length);
  // D7b 负对照的**另一半**：`weSwitchBegin` 自己必须能收口上一次（superseded）。
  const vsCode = read('../src/video-switch.js');
  check('D7b weSwitchBegin 内建 supersede（上一次未结算 ⇒ 收口后再开新的）',
    /function weSwitchBegin\(/.test(vsCode)
    && /weSwitchFail\("superseded"\)/.test(vsCode)
    && vsCode.indexOf('weSwitchFail("superseded")') > vsCode.indexOf('function weSwitchBegin(')
    && vsCode.indexOf('weSwitchFail("superseded")') < vsCode.indexOf('function weSwitchBegin(') + 1500);
  // D7c 硬上限收短到 5s（15s 会让一次漏结算变成十几秒的沉默）。
  check('D7c 状态机硬上限 = 5s（reason=busy-timeout）',
    /const WE_SWITCH_HARD_MS = 5000;/.test(vsCode) && /weSwitchFail\("busy-timeout"\)/.test(vsCode));
  check('D8 按下只做视觉（onPointerDown 用 weSwitchPressFeedback，不建上下文）',
    (qpCode.match(/onPointerDown: \(ev\) => \{[\s\S]{0,120}weSwitchPressFeedback\(ev/g) || []).length >= 2);
  // D5 宿主侧度量端点存在。
  const diag = read('../lib/routes/diag.js');
  check('D5 /folia/diag/switch-stats 端点已注册（D9）',
    diag.includes('/diag/switch-stats'));
}

// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  await sectionFamily();
  await sectionSwitch();
  sectionStructure();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0
    ? 'ALL SWITCH-SMOOTH CHECKS PASSED (' + results.length + ')'
    : failed.length + '/' + results.length + ' CHECK(S) FAILED'));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
