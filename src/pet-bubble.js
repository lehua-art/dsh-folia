/**
 * pet-bubble.js — 桌宠头顶的**双层气泡**（v3 §5 美化版）。
 *
 * 用户口径：提示/错误不能和回答挤在同一个框里。
 *   ① 状态条（独立、细、可点、3–5 秒淡出）：🎤 在听 / 💭 在想 / 🔊 在说 / 🔇 仅文字 / 麦克风已暂停
 *   ② 回答气泡（只有回答，小尾巴指向桌宠）：最多 4 行，超出显示「展开」；展开后出现「复制」，
 *      长回答在 240px 内滚动到底部；新消息替换旧消息时先淡出再淡入（150ms）。
 *
 * 结构：
 *   .we-pet-wrap（固定定位、列布局、整体锚定在桌宠头顶）
 *     ├─ .we-pet-status（状态条；自带 data-state 控制 🎤/💭/🔊/🔇 动效）
 *     └─ .we-pet-bubble（回答气泡；内部 .we-pet-bubble-text + 展开/复制/关闭）
 *
 * 依赖全部注入（document / 定时器 / 锚点 / 剪贴板），Node 里能用假 DOM 跑判据；
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
  /** 最多显示几行（超出折叠 + 「展开」）。 */
  const MAX_LINES = 4;
  /** 气泡最大宽度（任务 §5：300px）。 */
  const BUBBLE_MAX_WIDTH = 300;
  /** 展开后的最大高度（长回答内部滚动）。 */
  const BUBBLE_MAX_HEIGHT = 240;
  /** 出现/消失的动效时长（任务 §5：150ms）。 */
  const FADE_MS = 150;

  const raf = typeof options.requestAnimationFrame === 'function' ? options.requestAnimationFrame : null;
  const cancelRaf = typeof options.cancelAnimationFrame === 'function' ? options.cancelAnimationFrame : null;
  let rafId = null;
  const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
  const clipboard = options.clipboard && typeof options.clipboard.writeText === 'function' ? options.clipboard : null;
  /** 独立冒烟（只 eval 本文件）时没有 weT；有就用词表，没有就回落中文原文。 */
  const tr = (text) => {
    try { return typeof weT === 'function' ? weT(text) : text; } catch { return text; }
  };

  const CSS = [
    '.we-pet-wrap{position:fixed;z-index:9999;display:flex;flex-direction:column;align-items:center;gap:6px;max-width:300px;pointer-events:none;transform-origin:50% 100%;}',
    // 回答气泡：深色半透明底 + 1px 描边 + 柔和阴影；圆角 16；最大宽 300；内边距 10 / 14。
    '.we-pet-bubble{position:relative;max-width:300px;max-height:240px;overflow:hidden;padding:10px 14px;border-radius:16px;background:rgba(18,18,22,.86);color:#f2f2f5;font-size:13px;line-height:1.5;border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.38);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);white-space:pre-wrap;word-break:break-word;opacity:0;transform:translateY(4px);transition:opacity 150ms ease, transform 150ms ease;pointer-events:auto;scrollbar-width:thin;}',
    '.we-pet-bubble[data-visible="1"]{opacity:1;transform:translateY(0);}',
    // 折叠态：最多 4 行（-webkit-line-clamp），超出显示「展开」。
    '.we-pet-bubble[data-expanded="0"] .we-pet-bubble-text{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;}',
    // 展开态：最多 240px，内部滚动到底部。
    '.we-pet-bubble[data-expanded="1"]{max-height:240px;overflow-y:auto;}',
    // 小尾巴指向桌宠（在气泡底部中央；不挡脸）。
    '.we-pet-bubble::after{content:"";position:absolute;left:50%;bottom:-6px;width:12px;height:12px;background:inherit;border-right:1px solid rgba(255,255,255,.14);border-bottom:1px solid rgba(255,255,255,.14);transform:translateX(-50%) rotate(45deg);}',
    '.we-pet-bubble::-webkit-scrollbar{width:4px;}',
    '.we-pet-bubble::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border-radius:2px;}',
    // 气泡底部小工具条（展开/收起 + 复制）：只在需要时出现，不抢正文。
    '.we-pet-bubble-tools{display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:6px;font-size:11px;opacity:.78;}',
    '.we-pet-bubble-tools button{background:transparent;border:0;color:inherit;font:inherit;cursor:pointer;padding:0;opacity:.9;}',
    '.we-pet-bubble-tools button:hover{opacity:1;text-decoration:underline;}',
    '.we-pet-bubble-tools button[hidden]{display:none;}',
    // 状态条：细、独立、可点、3–5 秒淡出；字号 12。
    '.we-pet-status{max-width:300px;padding:5px 10px;border-radius:999px;background:rgba(18,18,22,.78);color:#ececf2;font-size:12px;line-height:1.4;border:1px solid rgba(255,255,255,.12);box-shadow:0 4px 14px rgba(0,0,0,.24);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;gap:6px;opacity:0;transition:opacity 150ms ease;pointer-events:auto;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.we-pet-status[data-visible="1"]{opacity:1;}',
    '.we-pet-status[data-state="listen"]::after{content:"";width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.7;animation:we-pet-status-pulse 1s ease-in-out infinite;}',
    '.we-pet-status[data-state="think"]::after{content:"…";margin-left:1px;opacity:.8;animation:we-pet-status-blink 1.1s steps(2,end) infinite;}',
    '.we-pet-status[data-state="speak"]::after{content:"";display:block;width:28px;height:10px;opacity:.85;background:linear-gradient(currentColor,currentColor) 0 100%/3px 45% no-repeat,linear-gradient(currentColor,currentColor) 7px 100%/3px 90% no-repeat,linear-gradient(currentColor,currentColor) 14px 100%/3px 60% no-repeat,linear-gradient(currentColor,currentColor) 21px 100%/3px 100% no-repeat;transform-origin:0 100%;animation:we-pet-status-wave .8s ease-in-out infinite alternate;}',
    '.we-pet-status[data-state="sing"]::after{content:"";display:block;width:34px;height:11px;opacity:.9;background:linear-gradient(currentColor,currentColor) 0 100%/3px 40% no-repeat,linear-gradient(currentColor,currentColor) 6px 100%/3px 85% no-repeat,linear-gradient(currentColor,currentColor) 12px 100%/3px 55% no-repeat,linear-gradient(currentColor,currentColor) 18px 100%/3px 100% no-repeat,linear-gradient(currentColor,currentColor) 24px 100%/3px 60% no-repeat,linear-gradient(currentColor,currentColor) 30px 100%/3px 30% no-repeat;transform-origin:0 100%;animation:we-pet-status-wave .55s ease-in-out infinite alternate;}',
    '.we-pet-status[data-state="muted"]{opacity:.92;}',
    '.we-pet-status[data-state="error"]{border-color:rgba(255,120,120,.45);}',
    '@keyframes we-pet-status-wave{from{transform:scaleY(.55);opacity:.55;}to{transform:scaleY(1);opacity:.95;}}',
    '@keyframes we-pet-status-pulse{0%,100%{transform:scale(.8);opacity:.45;}50%{transform:scale(1.15);opacity:.9;}}',
    '@keyframes we-pet-status-blink{0%,60%{opacity:.35;}100%{opacity:.9;}}',
  ].join('');

  let wrap = null;
  let el = null;          // 回答气泡
  let textEl = null;
  let toolsEl = null;
  let moreBtn = null;
  let copyBtn = null;
  let statusEl = null;
  let text = '';
  let visible = false;
  let expanded = false;
  let fadeTimer = null;
  let replaceTimer = null;
  let statusTimer = null;
  let copyTimer = null;
  let stylesInjected = false;
  let continuous = false;
  let speakPaused = false;
  let listenPaused = false;

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

  /** 展开/收起：只改 data 属性，视觉由 CSS 的 line-clamp 与 max-height 决定。 */
  function setExpanded(next) {
    expanded = next === true;
    if (el && el.dataset) el.dataset.expanded = expanded ? '1' : '0';
    if (moreBtn) moreBtn.textContent = expanded ? tr('收起') : tr('展开');
    if (copyBtn) {
      if (expanded) {
        if (typeof copyBtn.removeAttribute === 'function') copyBtn.removeAttribute('hidden');
        if (copyBtn.style) copyBtn.style.display = '';
      } else {
        if (typeof copyBtn.setAttribute === 'function') copyBtn.setAttribute('hidden', 'hidden');
        if (copyBtn.style) copyBtn.style.display = 'none';
      }
    }
    if (expanded) followBottom();
    return expanded;
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
    if (replaceTimer != null) { clearTimer(replaceTimer); replaceTimer = null; }
  }
  function cancelStatus() {
    if (statusTimer != null) { clearTimer(statusTimer); statusTimer = null; }
  }
  function statusVisible() {
    return Boolean(statusEl && statusEl.style && String(statusEl.style.opacity) === '1');
  }

  /** 把文字真正写进气泡（show / 替换淡出后都走这里）。 */
  function applyText(nextText, animate) {
    text = String(nextText == null ? '' : nextText);
    if (textEl) textEl.textContent = text;
    if (el) {
      if (el.dataset) el.dataset.visible = '1';
      // 淡入：先让 opacity 回到 1（CSS transition 150ms + translateY 4px→0）。
      el.style.opacity = animate === false ? '1' : '0';
      if (animate !== false) {
        setTimer(() => { if (el) el.style.opacity = '1'; }, 10);
      }
    }
    visible = true;
    setExpanded(false);
    followBottom();
    place();
    startFollow();
  }

  /** 假 DOM / 老环境可能没有 addEventListener：气泡是装饰层，缺了也不能抛。 */
  const listen = (target, type, fn) => {
    try {
      if (target && typeof target.addEventListener === 'function') target.addEventListener(type, fn);
    } catch { /* ignore */ }
  };

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
    listen(statusEl, 'click', () => {
      try { if (onStatusClick) onStatusClick(); else hideStatus(0); } catch { /* ignore */ }
    });

    el = doc.createElement('div');
    el.className = 'we-pet-bubble';
    el.dataset = el.dataset || {};
    el.dataset.expanded = '0';
    el.style.position = 'relative';
    el.style.pointerEvents = 'auto';
    // 点气泡 = 收起（二选一里的“收起”；不复制，避免误触剪贴板）。拖选文字时不触发 click。
    listen(el, 'click', () => { hide(0); onClose(); });

    textEl = doc.createElement('div');
    textEl.className = 'we-pet-bubble-text';
    if (typeof el.appendChild === 'function') el.appendChild(textEl);

    // 底部工具条：展开/收起 + 复制（复制只在展开态出现，任务 §5）。
    toolsEl = doc.createElement('div');
    toolsEl.className = 'we-pet-bubble-tools';
    moreBtn = doc.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'pet-bubble-more';
    moreBtn.textContent = tr('展开');
    listen(moreBtn, 'click', (event) => {
      try { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); } catch { /* ignore */ }
      setExpanded(!expanded);
    });
    copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'pet-bubble-copy';
    copyBtn.textContent = tr('复制');
    copyBtn.setAttribute('hidden', 'hidden');
    if (copyBtn.style) copyBtn.style.display = 'none';
    listen(copyBtn, 'click', (event) => {
      try { if (event && typeof event.stopPropagation === 'function') event.stopPropagation(); } catch { /* ignore */ }
      void copyText();
    });
    if (typeof toolsEl.appendChild === 'function') {
      toolsEl.appendChild(moreBtn);
      toolsEl.appendChild(copyBtn);
    }
    if (typeof el.appendChild === 'function') el.appendChild(toolsEl);

    const close = doc.createElement('button');
    close.className = 'pet-bubble-close';
    close.setAttribute('aria-label', '关闭');
    close.textContent = '×';
    close.style.cssText = 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;border:none;background:#333;color:#ddd;font-size:12px;line-height:1;cursor:pointer;pointer-events:auto;';
    listen(close, 'click', (event) => {
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

  /** 复制全文（只在展开态可用；失败给状态条提示，不静默）。 */
  async function copyText() {
    if (!text) return false;
    try {
      if (clipboard) {
        await clipboard.writeText(text);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('clipboard-unavailable');
      }
      if (copyBtn) copyBtn.textContent = tr('已复制');
      if (copyTimer != null) clearTimer(copyTimer);
      copyTimer = setTimer(() => { copyTimer = null; if (copyBtn) copyBtn.textContent = tr('复制'); }, 1500);
      return true;
    } catch {
      status('error', tr('复制失败：这个环境没有剪贴板权限'), { delay: 3000 });
      return false;
    }
  }

  /** 显示（或替换）一段**回答**；替换旧消息时先淡出再淡入。 */
  function show(nextText) {
    if (!ensure()) return;
    cancelFade();
    const next = String(nextText == null ? '' : nextText);
    if (visible && text && next !== text) {
      // 任务 §5：新消息替换旧消息时先淡出（150ms），再换文字淡入。
      if (el) el.style.opacity = '0';
      replaceTimer = setTimer(() => {
        replaceTimer = null;
        applyText(next, true);
      }, FADE_MS);
      return;
    }
    applyText(next, visible);
  }

  /**
   * 清唱歌词：逐行显示 + 当前行高亮（'▶'）。**不做淡入淡出**（每 120ms 更新，
   * 用 show() 会每次触发替换动画）。`meta.title` 只在第一次带上。
   */
  function showLyrics(lines, activeIndex, meta) {
    if (!ensure()) return;
    cancelFade();
    const list = Array.isArray(lines) ? lines.filter((line) => line && line.text) : [];
    const active = Math.max(0, Math.min(Math.max(0, list.length - 1), Math.round(Number(activeIndex) || 0)));
    const head = meta && meta.title ? '🎵 ' + String(meta.title) + '\n' : '';
    const body = head + list.map((line, i) => (i === active ? '▶ ' : '   ') + String(line.text)).join('\n');
    text = body;
    if (textEl) textEl.textContent = body;
    if (el) {
      if (el.dataset) el.dataset.visible = '1';
      el.style.opacity = '1';
    }
    visible = true;
    if (!expanded) followBottom();
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
    setExpanded(false);
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

  /** 显示状态条（错误/提示/在听/在想/在说/仅文字/麦克风暂停）。 */
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

  /** 三态 + v3 两态：在听 / 在想 / 在说 / 🔇 仅文字（落在状态条上）。 */
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
    const labels = {
      listen: listenPaused ? '🎤 ' + tr('麦克风已暂停') : '🎤 ' + (continuous ? tr('常驻聆听中') : tr('在听')),
      think: '💭 ' + tr('在想'),
      speak: '🔊 ' + tr('在说'),
      sing: '🎵 ' + tr('在唱'),
      muted: '🔇 ' + tr('仅文字'),
    };
    const label = labels[k];
    if (!label) return;
    // 错误/提示在它自己的 3–6 秒窗口内优先于三态，别被下一句“在说”立刻盖掉。
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

  /** 常驻聆听：把「在听」换成一语中的状态条。 */
  function setContinuous(active) {
    continuous = active === true;
    if (continuous && statusEl && statusEl.dataset && String(statusEl.dataset.state || '') === 'listen') {
      statusEl.textContent = '🎤 ' + tr('常驻聆听中');
    }
  }

  /** 「暂停说话 / 暂停聆听」的状态同步（状态条文案立刻跟着变）。 */
  function setVoiceFlags(flags) {
    const next = flags && typeof flags === 'object' ? flags : {};
    if (typeof next.speakPaused === 'boolean') speakPaused = next.speakPaused;
    if (typeof next.listenPaused === 'boolean') listenPaused = next.listenPaused;
    const cur = statusEl && statusEl.dataset ? String(statusEl.dataset.state || '') : '';
    if (cur === 'listen') setState('listen');
    else if (speakPaused && cur === 'speak') setState('muted');
    return { speakPaused, listenPaused };
  }

  function dispose() {
    cancelFade();
    cancelStatus();
    stopFollow();
    if (wrap && typeof wrap.remove === 'function') wrap.remove();
    wrap = null;
    el = null;
    textEl = null;
    toolsEl = null;
    moreBtn = null;
    copyBtn = null;
    statusEl = null;
    text = '';
    visible = false;
    expanded = false;
  }

  return {
    show, append, clear, hide, setState, status, hideStatus, place, isVisible, setContinuous, setVoiceFlags,
    showLyrics,
    setExpanded, copyText, dispose,
    get following() { return rafId != null; },
    get text() { return text; },
    get expanded() { return expanded; },
    get element() { return el; },
    get textElement() { return textEl; },
    get statusElement() { return statusEl; },
    get wrapElement() { return wrap; },
    MAX_LINES,
    BUBBLE_MAX_WIDTH,
    BUBBLE_MAX_HEIGHT,
    FADE_MS,
  };
}
