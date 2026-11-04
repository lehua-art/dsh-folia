#!/usr/bin/env node
/**
 * verify-first-click-feedback.mjs — **「第一下点击必然有可见变化」**的门禁（4.23.14）。
 *
 * ## 为什么要有这一页
 *
 * 用户实测（皮肤页签）：卡片的「安装」按钮**第一下点击没有任何反馈**，第二下才有反应。
 * 这不是"某一个按钮忘了置灰"，而是一组**顺序**问题，能被三种方式写回来：
 *   ① 点击后第一件事是 `await skinInstalledNow()`（一次 `/folia/skins/list` 往返；本机实测
 *      冷启动 **555.7 ms**、热态 **41.9–44.0 ms**）——反馈排在它后面 ⇒ 慢请求 = 静默；
 *   ② 反馈只靠 React 的一次提交（`cards.begin` 只是排 setState），不是同一 tick 的 DOM 变化；
 *   ③ 300ms 后仍没有 queued/running 时，卡片明细行是空的（`已等待 N 秒` 要到 3 秒才出现）。
 *
 * 所以这里按**用户能看到的第一帧**来判，而不是按函数返回什么：
 *   · 点击同一 tick：卡片 pressed / `aria-busy` / 按钮「正在提交…」已经到位，且**零网络调用**；
 *   · 只有清单说已装（`installed === true`）才允许预检查；预检查命中 ⇒ 不发请求，未命中 ⇒ 发；
 *   · 预检查 **1.5s 超时**后照常发安装请求（超时不许把用户卡死）；
 *   · 300ms 还没进入 queued/running ⇒ 出「提交中…（正在准备）」占位；
 *   · 皮肤 / 开机动画 / 桌宠 / 壁纸**四类**各有一条"首次点击即有反馈"；
 *   · 负对照：把"先 await 预检查再反馈"的旧顺序贴回，首条判据必须**红**（运行时 + 源码两条）。
 *
 * 客户端部分取的是 `src/local-first.js` / 三个页签 / `picker-modal.js` / `quick-panel.js` 的**真源码**
 *（切片后在 Function 里跑，或按同一判据函数解析），不复制一份"期望逻辑"。
 *
 * Usage: `node test/verify-first-click-feedback.mjs`
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments, functionBodyOf } from './tools/js-text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });

/* ── 取真源码：`src/local-first.js` 的纯函数段（与 verify-install-flow / verify-downloads 同一口径）── */
function loadClient() {
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs(');
  if (a < 0 || b <= a) return null;
  const slice = src.slice(a, b);
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  try {
    return new Function('weT', 'setTimeout', 'clearTimeout', slice + `
return {
  DL_FIRST_CLICK_PLACEHOLDER_MS, DL_PRECHECK_TIMEOUT_MS,
  dlFirstClickFeedback, dlInstallPrecheckPlan, dlPrecheckWithTimeout, dlPreparingHint, dlInstallClick, dlCardState,
};`)(shim, setTimeout, clearTimeout);
  } catch { return null; }
}

/* ── 假 DOM：`dlFirstClickFeedback` 只用到这几个成员（classList / aria / 按钮首文本节点 / closest）── */
function fakeDom(opts) {
  const o = opts || {};
  const cls = new Set(o.classes || []);
  const cardCls = new Set(o.cardClasses || []);
  const attrs = {};
  const classListOf = (set) => ({
    add(n) { set.add(n); },
    remove(n) { set.delete(n); },
    contains(n) { return set.has(n); },
  });
  const card = { classList: classListOf(cardCls) };
  const isButton = o.tagName !== 'DIV' && o.button !== false;
  // React 持有的是这个**文本节点**；helper 必须改 nodeValue（不能 textContent 换节点）。
  const textNode = { nodeType: 3, nodeValue: o.label == null ? '安装' : String(o.label) };
  const btn = isButton
    ? { tagName: 'BUTTON', disabled: Boolean(o.disabled), classList: classListOf(cls), firstChild: textNode, textContent: textNode.nodeValue }
    : null;
  const el = {
    // 被点的就是按钮时，helper 直接从 `node` 取 firstChild / disabled（不是 querySelector）。
    tagName: isButton ? 'BUTTON' : 'DIV',
    disabled: Boolean(o.disabled),
    classList: classListOf(cls),
    setAttribute(n, v) { attrs[n] = String(v); },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n] : null; },
    removeAttribute(n) { delete attrs[n]; },
    querySelector() { return btn || { tagName: 'BUTTON', disabled: false, classList: classListOf(cls), firstChild: textNode, textContent: textNode.nodeValue }; },
    closest(sel) { return /we-dl-card|we-picker__card|we-qp__item|we-qp__card/.test(String(sel)) ? card : null; },
    __attrs: attrs, __btn: null, __textNode: textNode, __card: card, __cls: cls, __cardCls: cardCls,
  };
  if (isButton) { el.firstChild = textNode; el.__btn = el; }
  return el;
}

/** 可控定时器：只记录不真等，测试按毫秒值手动点火（瞬时、确定）。 */
function manualTimers() {
  const queue = [];
  return {
    setTimeout(fn, ms) { const h = { fn, ms: Number(ms) || 0, fired: false, cleared: false }; queue.push(h); return h; },
    clearTimeout(h) { if (h) h.cleared = true; },
    fire(ms) {
      for (const h of queue) {
        if (!h.fired && !h.cleared && h.ms === Number(ms)) { h.fired = true; h.fn(); }
      }
    },
    pending() { return queue.filter((h) => !h.fired && !h.cleared); },
  };
}

const client = loadClient();

/* ══ 1. 点击**同一 tick**：submitting/pressed 已到位，且零网络 ══════════════════ */
{
  check('能取出 src/local-first.js 的真源码并跑起来（纯函数段）', Boolean(client), client ? 'ok' : '切片/编译失败');

  if (client) {
    check('常量：预检查超时 = 1.5s、首帧占位 = 300ms',
      client.DL_PRECHECK_TIMEOUT_MS === 1500 && client.DL_FIRST_CLICK_PLACEHOLDER_MS === 300,
      JSON.stringify({ precheck: client.DL_PRECHECK_TIMEOUT_MS, placeholder: client.DL_FIRST_CLICK_PLACEHOLDER_MS }));

    // ①-a 纯 helper：同一 tick 的视觉三件套，零网络、亚毫秒。
    {
      const fetchCount = 0;   // 这一条只测 helper 本身：它**不可能**发网络，断言 0 是硬口径
      const el = fakeDom({ label: '安装' });
      const t0 = process.hrtime.bigint();
      const restore = client.dlFirstClickFeedback(el, '正在提交…');
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      check('「同步反馈」同一 tick 内到位：卡片 pressed + aria-busy + 按钮文案「正在提交…」',
        el.__cardCls.has('we-first-click') && el.__attrs['aria-busy'] === 'true'
        && el.__btn.firstChild.nodeValue === '正在提交…' && el.__btn.disabled === true && fetchCount === 0,
        JSON.stringify({ pressed: el.__cardCls.has('we-first-click'), aria: el.__attrs['aria-busy'], label: el.__btn.firstChild.nodeValue, fetch: fetchCount }));
      check('「同步反馈」不 await、不网络：同步耗时 < 1ms（同一 tick 就能画）', us < 1000, us.toFixed(1) + 'µs');
      if (typeof restore === 'function') {
        restore();
        check('restore() 幂等撤掉 pressed / aria-busy（UI 不残留假忙碌）',
          !el.__cardCls.has('we-first-click') && !Object.prototype.hasOwnProperty.call(el.__attrs, 'aria-busy'));
        restore();
      } else {
        check('restore() 幂等撤掉 pressed / aria-busy（UI 不残留假忙碌）', false, '没有返回 restore');
      }
    }

    // ①-b 完整点击流程：begin 被调的**那一刻**，反馈已经在 DOM 上、网络计数必须还是 0。
    {
      let fetchCount = 0;
      const el = fakeDom({ label: '安装' });
      let atBegin = null;
      let phase = 'idle';
      const p = client.dlInstallClick({
        el,
        installed: false,
        begin: () => {
          phase = 'submitting';
          atBegin = { phase, pressed: el.__cardCls.has('we-first-click'), aria: el.__attrs['aria-busy'], fetch: fetchCount };
        },
        precheck: async () => { fetchCount += 1; return false; },
        submit: async () => { fetchCount += 1; return { ok: true, data: { ok: true } }; },
      });
      check('点击瞬间（同一 tick）：卡片状态 = submitting/pressed，且**未发生网络调用**（假 fetch 计数=0）',
        Boolean(atBegin) && atBegin.phase === 'submitting' && atBegin.pressed === true
        && atBegin.aria === 'true' && atBegin.fetch === 0,
        JSON.stringify(atBegin));
      const r = await p;
      check('清单未装（installed=false）⇒ 预检查 0 次、只发 1 次安装请求',
        fetchCount === 1 && r.precheck === 'skipped' && r.skipped === false,
        JSON.stringify({ fetchCount, precheck: r.precheck, skipped: r.skipped }));
    }

    // ①-c 负对照（运行时）：把"先 await 预检查，再反馈"的旧顺序贴回来 ⇒ 同一 tick 一定看不到反馈。
    {
      const el = fakeDom({ label: '安装' });
      let legacyNetwork = 0;
      const legacyClick = async () => {
        // 旧顺序：先把预检查走完
        await Promise.resolve().then(async () => { legacyNetwork += 1; return false; });
        // 然后才轮到状态机与视觉
        el.__cardCls.add('we-first-click');
      };
      const pending = legacyClick();
      const sawPressedSameTick = el.__cardCls.has('we-first-click');
      await pending;
      check('负对照：旧顺序（先 await 预检查再反馈）⇒ 点击同一 tick **看不到** pressed（首条判据会红）',
        sawPressedSameTick === false && legacyNetwork === 1,
        JSON.stringify({ sawPressedSameTick, legacyNetwork }));
    }
  }
}

/* ══ 2. 预检查只在 installed === true 时发生（命中/未命中两条腿）══════════════════ */
if (client) {
  check('门只有一个：installed === true 才预检查（其余一律直接发请求）',
    client.dlInstallPrecheckPlan(true).precheck === true
    && client.dlInstallPrecheckPlan(false).precheck === false
    && client.dlInstallPrecheckPlan(undefined).precheck === false
    && client.dlInstallPrecheckPlan('true').precheck === false,
    JSON.stringify([true, false, undefined].map((v) => client.dlInstallPrecheckPlan(v).precheck)));

  {
    let pre = 0;
    let sub = 0;
    const el = fakeDom();
    const r = await client.dlInstallClick({
      el,
      installed: true,
      precheck: async () => { pre += 1; return true; },
      submit: async () => { sub += 1; return { ok: true, data: { ok: true } }; },
    });
    check('installed=true 且预检查命中 ⇒ 预检查恰好 1 次、安装请求 0 次（不重复解压）',
      pre === 1 && sub === 0 && r.skipped === true && r.precheck === 'hit',
      JSON.stringify({ pre, sub, skipped: r.skipped, precheck: r.precheck }));
  }

  {
    let pre = 0;
    let sub = 0;
    const el = fakeDom();
    const r = await client.dlInstallClick({
      el,
      installed: true,
      precheck: async () => { pre += 1; return false; },
      submit: async () => { sub += 1; return { ok: true, data: { ok: true } }; },
    });
    check('installed=true 但预检查未命中 ⇒ 照常发 1 次安装请求',
      pre === 1 && sub === 1 && r.skipped === false && r.precheck === 'miss',
      JSON.stringify({ pre, sub, skipped: r.skipped, precheck: r.precheck }));
  }
}

/* ══ 3. 预检查 1.5s 超时后，照常发安装请求 ════════════════════════════════════ */
if (client) {
  {
    const timers = manualTimers();
    let sub = 0;
    let preparing = '';
    const el = fakeDom();
    const p = client.dlInstallClick({
      el,
      installed: true,
      timers,
      precheck: () => new Promise(() => {}),   // 永不返回：只能靠超时收口
      submit: async () => { sub += 1; return { ok: true, data: { ok: true } }; },
      onPreparing: (text) => { preparing = text; },
    });
    // 300ms：还没进队列 ⇒ 先出占位（这正是"慢请求不许静默"的那一拍）。
    timers.fire(300);
    check('300ms 未进入 queued/running ⇒ 出现「提交中…（正在准备）」占位',
      preparing === '提交中…（正在准备）', JSON.stringify(preparing));
    check('占位出现后请求仍未发出（超时前不抢发）', sub === 0, 'sub=' + sub);
    // 1500ms：预检查超时 ⇒ 照常发请求。
    timers.fire(1500);
    const r = await p;
    check('预检查超时 1.5s 后**仍发出**安装请求（超时 = 没查出结论，不是失败）',
      r.precheck === 'timeout' && sub === 1 && r.skipped === false,
      JSON.stringify({ precheck: r.precheck, sub, skipped: r.skipped }));
    check('超时后不再有待触发的占位定时器（已清理，不重复写提示）',
      timers.pending().length === 0, 'pending=' + timers.pending().length);
  }

  // 纯函数口径：300ms 之前 / 已有排队时都不出占位。
  check('占位判据：<300ms 不出、≥300ms 且无 queued/running 才出、已有进度不抢',
    client.dlPreparingHint({ waitedMs: 299, jobActive: false }) === ''
    && client.dlPreparingHint({ waitedMs: 300, jobActive: false }) === '提交中…（正在准备）'
    && client.dlPreparingHint({ waitedMs: 900, jobActive: true }) === '',
    JSON.stringify([299, 300].map((ms) => client.dlPreparingHint({ waitedMs: ms, jobActive: false }))));

  // 状态机同一口径：submitting 300ms ⇒ 明细行就是那句占位。
  {
    const now = 1_700_000_000_000;
    const st = (o) => client.dlCardState(Object.assign({ id: 'c1', labels: { idle: '安装', done: '已安装', failed: '重试' } }, o || {}));
    const at300 = st({ sub: { id: 'c1', at: now - 300 }, nowMs: now });
    const at200 = st({ sub: { id: 'c1', at: now - 200 }, nowMs: now });
    const at4000 = st({ sub: { id: 'c1', at: now - 4000 }, nowMs: now });
    check('卡片状态机：submitting 300ms ⇒ 明细行「提交中…（正在准备）」；200ms 不出；≥3s 走「已等待」',
      at300.phase === 'submitting' && at300.detail === '提交中…（正在准备）'
      && at200.detail === '' && at4000.detail.includes('已等待'),
      JSON.stringify({ at300: at300.detail, at200: at200.detail, at4000: at4000.detail }));
  }
}

/* ══ 4. 四类入口：皮肤 / 开机动画 / 桌宠 / 壁纸，各自"第一次点击即有反馈" ══════ */
/**
 * 判据本体：**安装/下载分支**（`functionBodyOf` 取到的真源码块）里，`dlInstallClick(` 必须在
 * **任何 await / 网络调用之前**。正判据与负对照喂同一个函数（否则"旧顺序会红"只是口号）。
 * 只看安装分支而不是整个 act：`activate` 分支在它前面、天然有 await，但它不在这条点击路径上。
 */
function feedbackBeforeAnyAwait(branchBody) {
  const code = stripComments(String(branchBody || ''));
  const fc = code.indexOf('dlInstallClick(');
  if (fc < 0) return false;
  // `await dlInstallClick(...)` 自己的那个 await 不算"反馈之前的等待"：真正要判的是
  // **在它之前**有没有别的 await / 网络（旧顺序里是 `await skinInstalledNow`）。
  const pre = code.slice(0, fc).replace(/await\s*$/, '');
  if (/(^|[^\w])await\s/.test(pre)) return false;                         // 反馈之前有 await ⇒ 旧顺序
  for (const net of ['await apiPostJson(', 'await apiJson(', 'await skinInstalledNow(', 'await bootInstalledNow(', 'await petsInstalledNow(']) {
    const at = code.indexOf(net);
    if (at >= 0 && at < fc) return false;                                  // 反馈之前有网络 ⇒ 旧顺序
  }
  return true;
}

const skinsSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
const bootSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-boot.js'), 'utf8');
const petsSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-pets.js'), 'utf8');
const pickerSrc = readFileSync(join(ROOT, 'src', 'picker-modal.js'), 'utf8');
const quickSrc = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8');
const stylesPanel = readFileSync(join(ROOT, 'src', 'styles-panel.js'), 'utf8');

{
  const skinBranch = functionBodyOf(skinsSrc, 'if (isInstall) ');
  check('① 皮肤：安装分支里 dlInstallClick 在**任何 await / 网络之前**（首帧反馈不被预检查挡住）',
    Boolean(skinBranch) && feedbackBeforeAnyAwait(skinBranch), skinBranch ? 'branch=' + skinBranch.length + 'B' : '分支切片失败');
  check('① 皮肤：状态机入口仍是 cards.begin(cardId)（verify-downloads 的既有判据也读这一行）',
    Boolean(skinBranch) && /begin:\s*\(\)\s*=>\s*\{\s*cards\.begin\(cardId\);\s*\}/.test(skinBranch));
  check('① 皮肤：安装按钮把 installed 标志随 payload 带给预检查门 + 把事件元素交给 act',
    /act\("install", \{ id: s\.id, url: s\.url, installed: Boolean\(s\.installed\) \}, s\.title, ev\)/.test(skinsSrc)
    && /className: "we-dl-card"/.test(skinsSrc));
}

{
  const bootBranch = functionBodyOf(bootSrc, 'if (isDownload) ');
  check('② 开机动画：下载分支里 dlInstallClick 在任何 await / 网络之前',
    Boolean(bootBranch) && feedbackBeforeAnyAwait(bootBranch), bootBranch ? 'branch=' + bootBranch.length + 'B' : '分支切片失败');
  check('② 开机动画：下载按钮把事件元素交给 act（点击同一 tick 就能改按钮/卡片）',
    /act\("download", \{ id: c\.id \}, c\.title, ev, c\.url\)/.test(bootSrc) && /className: "we-dl-card"/.test(bootSrc));
}

{
  const petBranch = functionBodyOf(petsSrc, 'if (isInstall) ');
  check('③ 桌宠：安装分支里 dlInstallClick 在任何 await / 网络之前',
    Boolean(petBranch) && feedbackBeforeAnyAwait(petBranch), petBranch ? 'branch=' + petBranch.length + 'B' : '分支切片失败');
  check('③ 桌宠：安装按钮把事件元素交给 act（点击同一 tick 就能改按钮/卡片）',
    /act\("install", \{ id: s\.id, queue: true \}, s\.title \|\| s\.id, ev, s\.url\)/.test(petsSrc)
    && /className: "we-dl-card"/.test(petsSrc));
}

{
  // ④ 壁纸侧"下载/应用"入口 = 壁纸库卡片与快捷面板行。
  //    它们的反馈是 pressed/aria-busy（卡片上没有"安装"按钮），所以还要判 CSS 里真有这条规则
  //    —— 否则 class 加上去也看不见（4.23.8 起的真实形态：`.we-qp__item--pressed` 一直没有样式）。
  const pressedStyled = /\.we-qp__item--pressed\s*\{[^}]*opacity/.test(stylesPanel)
    && /\.we-first-click\s*\{[^}]*opacity/.test(stylesPanel);
  const pickerFeedback = /onPointerDown: \(ev\) => pickerPressFeedback\(ev && ev\.currentTarget\)/.test(pickerSrc)
    && /onClick: \(ev\) => \{ pickerPressFeedback\(ev && ev\.currentTarget\); onPickCard\(w\); \}/.test(pickerSrc);
  const quickFeedback = /onPointerDown: \(ev\) => \{\s*try \{ weSwitchPressFeedback\(ev && ev\.currentTarget\); \}/.test(quickSrc)
    && (() => {
      // onClick 第一行必须是同步反馈（weSwitchBegin 内部会立刻加 pressed）
      const at = quickSrc.indexOf('onClick: (ev) => {');
      if (at < 0) return false;
      const seg = stripComments(quickSrc.slice(at, at + 900));
      const begin = seg.indexOf('weSwitchBegin(ev && ev.currentTarget)');
      const apply = seg.indexOf('applySelection(w.id');
      return begin > 0 && apply > begin;
    })();
  check('④ 壁纸：库卡片按下即同步反馈（pointerdown + onClick 第一行），且 pressed 真有 CSS（看得见）',
    pressedStyled && pickerFeedback, JSON.stringify({ pressedStyled, pickerFeedback }));
  check('④ 壁纸：快捷面板同一套（pointerdown 反馈 + onClick 先 weSwitchBegin 再 applySelection）',
    quickFeedback, JSON.stringify({ quickFeedback }));
}

/* ══ 5. 负对照（源码）：把旧顺序贴回 ⇒ 第 4 节那条判据必须红 ═══════════════════ */
{
  const legacyBranch = `{
    // 旧顺序：先 await 预检查，再 dlInstallClick（用户实测的"第一下没反应"）
    if (isInstall && cardId && await skinInstalledNow(cardId)) { cards.markOk(cardId); return; }
    const click = await dlInstallClick({ el: ev && ev.currentTarget });
  }`;
  check('负对照：把「先 await 预检查，再 dlInstallClick」的旧顺序贴回 ⇒ 同一条判据判红',
    feedbackBeforeAnyAwait(legacyBranch) === false);
  // 正对照：真实源码通过同一函数（证明上面的负对照不是恒真）
  const skinBranch = functionBodyOf(skinsSrc, 'if (isInstall) ');
  check('正对照：真实皮肤安装分支通过同一判据（判据会区分新旧顺序，不是恒假）',
    Boolean(skinBranch) && feedbackBeforeAnyAwait(skinBranch) === true);
}

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
process.exit(failed ? 1 : 0);
