/**
 * verify-pet-bubble.mjs — S2 头顶气泡的 6 条判据（假 DOM + 假定时器，不需要浏览器）。
 *
 * 模块本身就在 `src/pet-bubble.js`，通过注入 document/定时器/锚点来跑；
 * 浏览器侧用真实 window 构造同一份代码，所以这里测的行为就是线上行为。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8');
const factory = new Function(`${source}; return { petBubbleCreate };`)().petBubbleCreate;

const results = [];
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); }

/** 极简假 DOM：只实现气泡真正用到的几个面。 */
function makeDoc() {
  const body = { children: [], appendChild(node) { this.children.push(node); } };
  return {
    body,
    createElement() {
      return {
        style: {}, dataset: {}, textContent: '', className: '', children: [], handlers: {},
        removed: false,
        setAttribute() {}, addEventListener(type, fn) { this.handlers[type] = fn; },
        appendChild(node) { this.children.push(node); },
        remove() { this.removed = true; },
      };
    },
  };
}

/** 假定时器：手动 tick 才触发。 */
function makeTimers() {
  const queue = [];
  return {
    setTimeout: (fn, ms) => { queue.push({ fn, ms }); return queue.length; },
    clearTimeout: (id) => { if (queue[id - 1]) queue[id - 1].fn = null; },
    tick: () => { const item = queue.shift(); if (item && item.fn) item.fn(); return item ? item.ms : 0; },
    pending: () => queue.filter((item) => item.fn).length,
  };
}

const makeBubble = (anchorRef) => {
  const rafQueue = [];
  const doc = makeDoc();
  const timers = makeTimers();
  const bubble = factory({
    document: doc,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    getAnchor: () => anchorRef.value,
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    cancelAnimationFrame: (id) => { rafQueue[id - 1] = null; },
  });
  return { bubble, doc, timers, rafQueue };
};

/* ① 锚定：气泡贴在桌宠头顶（水平居中、垂直向上） */
{
  const anchorRef = { value: { left: 100, top: 300, width: 80, height: 80, scale: 1 } };
  const { bubble } = makeBubble(anchorRef);
  bubble.show('你好');
  const style = bubble.wrapElement.style;
  check('① 锚定：水平居中于桌宠、垂直贴在头顶',
    style.left === '140px' && style.top === '292px' && /translate\(-50%, -100%\)/.test(style.transform),
    `left=${style.left} top=${style.top} transform=${style.transform}`);
}

/* ② 跟随：桌宠移动/缩放后重新定位 */
{
  const anchorRef = { value: { left: 100, top: 300, width: 80, height: 80, scale: 1 } };
  const { bubble } = makeBubble(anchorRef);
  bubble.show('你好');
  anchorRef.value = { left: 400, top: 500, width: 120, height: 120, scale: 1.5 };
  bubble.place();
  const style = bubble.wrapElement.style;
  check('② 跟随：锚点变化后位置与缩放都跟着变',
    style.left === '460px' && style.top === '492px' && /scale\(1\.5\)/.test(style.transform),
    `left=${style.left} top=${style.top} transform=${style.transform}`);
}

/* ③ 逐字：append 累加文本（SSE 每个 chunk 一次） */
{
  const anchorRef = { value: { left: 0, top: 0, width: 10, height: 10, scale: 1 } };
  const { bubble } = makeBubble(anchorRef);
  bubble.show('你');
  bubble.append('好');
  bubble.append('呀');
  check('③ 逐字：append 累加且元素文本同步',
    bubble.text === '你好呀' && bubble.textElement.textContent === '你好呀',
    `text=${bubble.text}`);
}

/* ④ 朗读结束 +3s 淡出 */
{
  const anchorRef = { value: { left: 0, top: 0, width: 10, height: 10, scale: 1 } };
  const { bubble, timers } = makeBubble(anchorRef);
  bubble.show('说完了');
  bubble.hide(3000);
  const stillVisible = bubble.isVisible();
  const delay = timers.tick();
  check('④ 朗读结束 +3s 淡出（3s 前仍可见）',
    stillVisible === true && delay === 3000 && bubble.isVisible() === false && bubble.element.style.opacity === '0',
    `延迟=${delay}ms · 淡出后可见=${bubble.isVisible()}`);
}

/* ⑤ 隐藏后点一下必能重开（关键回归项） */
{
  const anchorRef = { value: { left: 0, top: 0, width: 10, height: 10, scale: 1 } };
  const { bubble } = makeBubble(anchorRef);
  bubble.show('第一句');
  bubble.hide(0);
  const hidden = bubble.isVisible();
  bubble.show('第二句');
  check('⑤ 隐藏后再点必能重开（关键回归）',
    hidden === false && bubble.isVisible() === true
      && bubble.element.style.opacity === '1' && bubble.text === '第二句',
    `隐藏=${!hidden} · 重开后=${bubble.isVisible()} text=${bubble.text}`);
}

/* ⑥ 超长：160px 内滚动、320px 宽上限、15px 圆角（样式在注入 CSS 里） */
{
  const anchorRef = { value: { left: 0, top: 0, width: 10, height: 10, scale: 1 } };
  const { bubble } = makeBubble(anchorRef);
  bubble.show('长'.repeat(400));
  check('⑥ 超长回答：max-height 160px 可滚、宽度 ≤320px、圆角 15px',
    /max-height:160px/.test(source) && /overflow-y:auto/.test(source)
      && /max-width:320px/.test(source) && /border-radius:15px/.test(source)
      && bubble.BUBBLE_MAX_HEIGHT === 160 && bubble.BUBBLE_MAX_WIDTH === 320,
    `maxHeight=${bubble.BUBBLE_MAX_HEIGHT} · maxWidth=${bubble.BUBBLE_MAX_WIDTH}`);
}


/* ⑦ P3：rAF 跟随 —— 锚点变化后下一帧位置就跟上 */
{
  const anchorRef = { value: { left: 100, top: 200, width: 80, height: 80, scale: 1 } };
  const { bubble, rafQueue } = makeBubble(anchorRef);
  bubble.show('跟');
  anchorRef.value = { left: 300, top: 400, width: 80, height: 80, scale: 1 };
  const frame = rafQueue.find(Boolean);
  if (frame) frame();
  const style = bubble.wrapElement.style;
  check('⑦ P3 跟随：锚点变化后下一帧位置更新（±1px）',
    Math.abs(Number(style.left.replace('px','')) - 340) <= 1 && Math.abs(Number(style.top.replace('px','')) - 392) <= 1,
    `left=${style.left} top=${style.top}`);
}

/* ⑧ P3：hide 后 rAF 停止 */
{
  const anchorRef = { value: { left: 0, top: 0, width: 10, height: 10, scale: 1 } };
  const { bubble, rafQueue } = makeBubble(anchorRef);
  bubble.show('停');
  const before = rafQueue.filter(Boolean).length;
  bubble.hide(0);
  const after = rafQueue.filter(Boolean).length;
  const frame = rafQueue.find(Boolean);
  if (frame) frame();
  check('⑧ P3 hide 后 rAF 停止', bubble.following === false && after === 0, `following=${bubble.following} 队列 ${before}→${after}`);
}

/* ⑨ P5：关闭按钮存在，点击隐藏，再点能重开 */
{
  const anchorRef = { value: { left: 0, top: 0, width: 10, height: 10, scale: 1 } };
  const { bubble } = makeBubble(anchorRef);
  bubble.show('关');
  const close = (bubble.element.children || []).find((node) => node.className === 'pet-bubble-close');
  const ok = Boolean(close);
  if (close) close.handlers ? close.handlers.click() : null;
  bubble.show('再开');
  check('⑨ P5 关闭按钮存在 + 重开', ok && bubble.isVisible() === true, `按钮=${ok} · 重开=${bubble.isVisible()}`);
}

/* ⑩ pre.54：状态条可独立出现（没有回答气泡时也要锚在桌宠头顶） */
{
  const anchorRef = { value: { left: 100, top: 300, width: 80, height: 80, scale: 1 } };
  const { bubble } = makeBubble(anchorRef);
  bubble.status('error', '没找到麦克风 · 点此改用打字', { delay: 0 });
  const style = bubble.wrapElement.style;
  check('⑩ 状态条独立出现时也锚定在桌宠头顶，且回答气泡保持为空',
    style.left === '140px' && style.top === '292px'
      && bubble.text === ''
      && String(bubble.statusElement.textContent || '').includes('没找到麦克风'),
    `left=${style.left} top=${style.top} status=${bubble.statusElement.textContent}`);
}

let failed = 0;
for (const item of results) {
  if (item.ok) process.stdout.write(`  ✓ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`);
  else { failed += 1; process.stdout.write(`  ✗ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`); }
}
process.stdout.write(`\n  ${results.length - failed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
