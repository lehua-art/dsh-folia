/**
 * pet-bubble.js — 桌宠头顶的**双层气泡**（pre.54 重做）。
 *
 * 用户口径：提示/错误不能和回答挤在同一个框里。
 *   ① 状态条（独立、细、可点、3–5 秒淡出）：在听 / 在想 / 在说 / 没找到麦克风 / …
 *   ② 回答气泡（只有回答，小尾巴指向桌宠）：逐句显示、随朗读推进、长回答可滚。
 *
 * 结构：
 *   .we-pet-wrap（固定定位、列布局、整体锚定在桌宠头顶）
 *     ├─ .we-pet-status（状态条；自带 data-state 控制 🎤/💭/🔊 动效）
 *     └─ .we-pet-bubble（回答气泡；内部 .we-pet-bubble-text + 关闭按钮）
 *
 * 依赖全部注入（document / 定时器 / 锚点），Node 里能用假 DOM 跑判据；
 * 浏览器侧由 pet-chat.js 用真实 window 构造。`setState` 仍同步写 bubble 的
 * `data-state`（既有判据与桌宠动作读它），视觉三态则落在状态条上。
 */
function petBubbleCreate(deps) {
  const options = deps || {};
  const doc = options.document;
  const setTimer = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (typeof setTimeout === 'function' ? setTimeout : (fn) => { if (typeof fn === 'function') fn(); return 0; });
  const clearTimer = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : (typeof clearTimeout === 'function' ? clearTimeout : () => {});
  const getAnchor = typeof options.getAnchor === 'function' ? options.getAnchor : () => null;
  const onStatusClick = typeof options.onStatusClick === 'function' ? options.onStatusClick : null;
  const MAX_LINES = 6;
  const BUBBLE_MAX_WIDTH = 320;
  const BUBBLE_MAX_HEIGHT = 160;

  const raf = typeof options.requestAnimationFrame === 'function' ? options.requestAnimationFrame : null;
  const cancelRaf = typeof options.cancelAnimationFrame === 'function' ? options.cancelAnimationFrame : null;
  let rafId = null;
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
  /** 独立冒烟（只 eval 本文件）时没有 weT；有就用词表，没有就回落中文原文。 */
  const tr = (text) => {
    try { return typeof weT === 'function' ? weT(text) : text; } catch { return text; }
  };

  const CSS = [
    '.we-pet-wrap{position:fixed;z-index:9999;display:flex;flex-direction:column;align-items:center;gap:6px;max-width:320px;pointer-events:none;transform-origin:50% 100%;}',
    // 回答气泡：半透明深色底 + 轻描边 + 14–16px 圆角；长回答 160px 内滚动。
    '.we-pet-bubble{position:relative;max-width:320px;max-height:160px;overflow-y:auto;padding:10px 12px;border-radius:15px;background:rgba(20,20,24,.82);color:#f2f2f5;font-size:13px;line-height:1.5;border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 24px rgba(0,0,0,.28);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);white-space:pre-wrap;word-break:break-word;opacity:0;transition:opacity 150ms ease;pointer-events:auto;scrollbar-width:thin;}',
    '.we-pet-bubble[data-visible="1"]{opacity:1;}',
    // 小尾巴指向桌宠（在气泡底部中央；不挡脸）。
    '.we-pet-bubble::after{content:"";position:absolute;left:50%;bottom:-6px;width:12px;height:12px;background:inherit;border-right:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14);transform:translateX(-50%) rotate(45deg);}',
    '.we-pet-bubble::-webkit-scrollbar{width:4px;}',
    '.we-pet-bubble::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:2px;}',
    // 状态条：细、独立、可点、3–5 秒淡出。
    '.we-pet-status{max-width:320px;padding:5px 10px;border-radius:999px;background:rgba(20,20,24,.74);color:#ececf2;font-size:12px;line-height:1.4;border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 14px rgba(0,0,0,.22);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;opacity:0;transition:opacity 150ms ease;pointer-events:auto;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.we-pet-status[data-visible="1"]{opacity:1;}',
    '.we-pet-status[data-state="listen"]::after{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.7;animation:we-pet-status-pulse 1s ease-in-out infinite;}',
    '.we-pet-status[data-state="think"]::after{content:"…";margin-left:1px;opacity:.8;animation:we-pet-status-blink 1.1s steps(2,end) infinite;}',
    '.we-pet-status[data-state="speak"]::after{content:"";display:block;width:28px;height:10px;opacity:.85;background:linear-gradient(currentColor,currentColor) 0 100%/3px 45% no-repeat,linear-gradient(currentColor,currentColor) 7px 100%/3px 90% no-repeat,linear-gradient(currentColor,currentColor) 14px 100%/3px 60% no-repeat,linear-gradient(currentColor,currentColor) 21px 100%/3px 100% no-repeat;transform-origin:0 100%;animation:we-pet-status-wave .8s ease-in-out infinite alternate;}',
    '.we-pet-status[data-state="error"]{border-color:rgba(255,120,120,.45);}',
    '@keyframes we-pet-status-wave{from{transform:scaleY(.55);opacity:.55;}to{transform:scaleY(1);opacity:.95;}}',
    '@keyframes we-pet-status-pulse{0%,100%{transform:scale(.8);opacity:.45;}50%{transform:scale(1.15);opacity:.9;}}',
    '@keyframes we-pet-status-blink{0%,60%{opacity:.35;}100%{opacity:.9;}}',
  ].join('');

  let wrap = null;
  let el = null;          // 回答气泡
  let textEl = null;
  let statusEl = null;
  let text = '';
  let visible = false;
  let fadeTimer = null;
  let statusTimer = null;
  let stylesInjected = false;

  function startFollow() {
    if (!raf || rafId != null) return;
    const step = () => { place(); rafId = raf(step); };
    rafId = raf(step);
  }
  function stopFollow() {
    if (rafId != null && cancelRaf) { try { cancelRaf(rafId); } catch { /* ignore */ } }
    rafId = null;
  }

  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    try {
      if (!doc || !doc.head || typeof doc.createElement !== 'function') return;
      const style = doc.createElement('style');
      style.setAttribute('data-folia-pet-bubble', '1');
      style.textContent = CSS;
      if (typeof doc.head.appendChild === 'function') doc.head.appendChild(style);
    } catch { /* 气泡是装饰层，样式失败不能影响显示 */ }
  }

  /** 锚点 → 整组位置：水平居中于桌宠，垂直贴在头顶上方。 */
  function place() {
    if (!wrap) return;
    const anchor = getAnchor();
    if (!anchor) return;
    const width = Number(anchor.width) || 0;
    const left = Math.round(Number(anchor.left || 0) + width / 2);
    const top = Math.round(Number(anchor.top || 0) - 8);
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
    wrap.style.transform = `translate(-50%, -100%) scale(${Number(anchor.scale) || 1})`;
  }

  function ensure() {
    if (wrap || !doc || typeof doc.createElement !== 'function') return wrap;
    ensureStyles();
    wrap = doc.createElement('div');
    wrap.className = 'we-pet-wrap';

    statusEl = doc.createElement('div');
    statusEl.className = 'we-pet-status';
    statusEl.dataset = statusEl.dataset || {};
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.addEventListener('click', () => {
      try { if (onStatusClick) onStatusClick(); else hideStatus(0); } catch { /* ignore */ }
    });

    el = doc.createElement('div');
    el.className = 'we-pet-bubble';
    el.dataset = el.dataset || {};
    el.style.position = 'relative';
    el.style.pointerEvents = 'auto';
    // 点气泡 = 收起（二选一里的“收起”；不复制，避免误触剪贴板）。拖选文字时不触发 click。
    el.addEventListener('click', () => { hide(0); onClose(); });

    textEl = doc.createElement('div');
    textEl.className = 'we-pet-bubble-text';
    if (typeof el.appendChild === 'function') el.appendChild(textEl);

    const close = doc.createElement('button');
    close.className = 'pet-bubble-close';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:none;background:#333;color:#ddd;font-size:12px;line-height:1;cursor:pointer;pointer-events:auto;';
    close.addEventListener('click', (event) => {
      // 阻止冒泡到气泡（否则同一次点击会触发两次 onClose）。
      try { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); } catch { /* ignore */ }
      hide(0);
      onClose();
    });
    if (typeof el.appendChild === 'function') el.appendChild(close);

    if (typeof wrap.appendChild === 'function') { wrap.appendChild(statusEl); wrap.appendChild(el); }
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(wrap);
    return wrap;
  }

  /** 长回答追加时保持在底部（用户往上翻时不强拉，交给浏览器滚动条）。 */
  function followBottom() {
    try {
      if (!el) return;
      if (Number(el.scrollHeight) > Number(el.clientHeight)) el.scrollTop = el.scrollHeight;
    } catch { /* 假 DOM / 旧浏览器没有 scroll 属性 */ }
  }

  function cancelFade() {
    if (fadeTimer != null) { clearTimer(fadeTimer); fadeTimer = null; }
  }
  function cancelStatus() {
    if (statusTimer != null) { clearTimer(statusTimer); statusTimer = null; }
  }
  function statusVisible() {
    return Boolean(statusEl && statusEl.style && String(statusEl.style.opacity) === '1');
  }

  /** 显示（或继续显示）一段**回答**；状态/错误请走 `status()`。 */
  function show(nextText) {
    if (!ensure()) return;
    cancelFade();
    text = String(nextText == null ? '' : nextText);
    if (textEl) textEl.textContent = text;
    if (el) { el.dataset.visible = '1'; el.style.opacity = '1'; }
    visible = true;
    followBottom();
    place();
    startFollow();
  }

  /** 逐字/逐段追加（SSE 每个 chunk 调一次）。 */
  function append(chunk) {
    if (!ensure()) return;
    cancelFade();
    text += String(chunk == null ? '' : chunk);
    if (textEl) textEl.textContent = text;
    if (el) { el.dataset.visible = '1'; el.style.opacity = '1'; }
    visible = true;
    followBottom();
    place();
    startFollow();
  }

  /** 清空回答文本（新一轮回答开始前用；不改变状态条）。 */
  function clear() {
    if (!ensure()) return;
    cancelFade();
    text = '';
    if (textEl) textEl.textContent = '';
    if (el) {
      el.style.opacity = '0';
      if (el.dataset) el.dataset.visible = '0';
    }
    visible = false;
  }

  /** 隐藏回答气泡；带 delay 时先挂着，到点淡出（朗读结束后 +3s 用这个）。 */
  function hide(delayMs) {
    if (!el) return;
    cancelFade();
    const delay = Number(delayMs) || 0;
    const doHide = () => {
      fadeTimer = null;
      if (!statusVisible()) stopFollow();
      el.style.opacity = '0';
      if (el.dataset) el.dataset.visible = '0';
      visible = false;
    };
    if (delay > 0) { fadeTimer = setTimer(doHide, delay); return; }
    doHide();
  }

  /** 显示状态条（错误/提示/在听/在想/在说）。 */
  function status(kind, message, opts) {
    if (!ensure()) return;
    cancelStatus();
    const o = opts || {};
    const k = String(kind || 'info');
    const icon = k === 'error' ? '🔴 ' : (k === 'info' ? 'ℹ️ ' : '');
    if (statusEl) {
      statusEl.dataset.state = k;
      statusEl.textContent = icon + String(message == null ? '' : message);
      statusEl.dataset.visible = '1';
      statusEl.style.opacity = '1';
    }
    // 状态条可能独立于回答气泡出现（没麦克风/在听）—— 也必须锚在桌宠头顶。
    place();
    startFollow();
    const delay = o.delay !== undefined ? Number(o.delay) || 0 : (k === 'error' ? 6000 : 4000);
    if (delay > 0) statusTimer = setTimer(() => { statusTimer = null; hideStatus(0); }, delay);
  }

  /** 隐藏状态条（独立于回答气泡）。 */
  function hideStatus(delayMs) {
    if (!statusEl) return;
    cancelStatus();
    const delay = Number(delayMs) || 0;
    const doHide = () => {
      statusTimer = null;
      statusEl.style.opacity = '0';
      if (statusEl.dataset) { statusEl.dataset.visible = '0'; statusEl.dataset.state = ''; }
      if (!visible) stopFollow();
    };
    if (delay > 0) { statusTimer = setTimer(doHide, delay); return; }
    doHide();
  }

  /** 三态：听 / 想 / 说（落在状态条上；bubble 的 data-state 同步保留给既有判据）。 */
  function setState(kind) {
    if (!ensure()) return;
    const k = String(kind || '');
    if (el && el.dataset) el.dataset.state = k;
    if (k === 'idle') {
      // 错误/提示正在显示时不许被 idle 抹掉（TTS 错误后常紧跟一个 idle）。
      const cur = statusEl && statusEl.dataset ? String(statusEl.dataset.state || '') : '';
      if (cur === 'error' || cur === 'info') return;
      cancelStatus();
      hideStatus(1200);
      return;
    }
    const labels = { listen: '🎤 ' + tr('在听'), think: '💭 ' + tr('在想'), speak: '🔊 ' + tr('在说') };
    const label = labels[k];
    if (!label) return;
    // 错误/提示（含音色回落）在它自己的 3–6 秒窗口内优先于三态，别被下一句“在说”立刻盖掉。
    const curState = statusEl && statusEl.dataset ? String(statusEl.dataset.state || '') : '';
    if (curState === 'error' || curState === 'info') return;
    cancelStatus();
    if (statusEl) {
      statusEl.dataset.state = k;
      statusEl.textContent = label;
      statusEl.dataset.visible = '1';
      statusEl.style.opacity = '1';
    }
    place();
    startFollow();
  }

  function isVisible() { return visible; }

  function dispose() {
    cancelFade();
    cancelStatus();
    stopFollow();
    if (wrap && typeof wrap.remove === 'function') wrap.remove();
    wrap = null;
    el = null;
    textEl = null;
    statusEl = null;
    text = '';
    visible = false;
  }

  return {
    show, append, clear, hide, setState, status, hideStatus, place, isVisible, dispose,
    get following() { return rafId != null; },
    get text() { return text; },
    get element() { return el; },
    get textElement() { return textEl; },
    get statusElement() { return statusEl; },
    get wrapElement() { return wrap; },
    MAX_LINES,
    BUBBLE_MAX_WIDTH,
    BUBBLE_MAX_HEIGHT,
  };
}
