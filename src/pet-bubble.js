/**
 * pet-bubble.js — 头顶气泡（v0.1 S2）。
 *
 * 与旧面板的区别：**只显示**，不承载输入框 / 历史列表 / 关闭按钮；输入走右键「打字说…」，
 * 语音走唤醒链路（S3）。这样做是因为旧面板把"窗口"和"助手"混在一起，
 * 用户点桌宠时弹出一个像聊天软件的窗口，与"桌宠在旁边说话"的产品形态冲突。
 *
 * 依赖全部注入（document / 定时器 / 锚点），这样 Node 里能用假 DOM 跑判据；
 * 浏览器侧由 pet-chat.js 用真实 window 构造。
 */
function petBubbleCreate(deps) {
  const options = deps || {};
  const doc = options.document;
  // 没有定时器的环境（极简 DOM 替身的冒烟测试）不能因为裸 setTimeout 直接炸：
  // 退化成立即执行 / 空取消，气泡仍能显示，只是没有延迟淡出。
  const setTimer = typeof options.setTimeout === 'function'
    ? options.setTimeout
    : (typeof setTimeout === 'function' ? setTimeout : (fn) => { if (typeof fn === 'function') fn(); return 0; });
  const clearTimer = typeof options.clearTimeout === 'function'
    ? options.clearTimeout
    : (typeof clearTimeout === 'function' ? clearTimeout : () => {});
  const getAnchor = typeof options.getAnchor === 'function' ? options.getAnchor : () => null;
  /** 最多显示几行（超出用 CSS 行钳制，见 lineClamp 样式）。 */
  const MAX_LINES = 6;

  let el = null;
  let text = '';
  let visible = false;
  let fadeTimer = null;

  /** 锚点 → 气泡位置：水平居中于桌宠，垂直贴在头顶上方。 */
  function place() {
    if (!el) return;
    const anchor = getAnchor();
    if (!anchor) return;
    const width = Number(anchor.width) || 0;
    const height = Number(anchor.height) || 0;
    const left = Math.round(Number(anchor.left || 0) + width / 2);
    const top = Math.round(Number(anchor.top || 0) - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    // 锚点也跟着缩放：桌宠放大时气泡不要贴在旧位置
    el.style.transform = `translate(-50%, -100%) scale(${Number(anchor.scale) || 1})`;
  }

  function ensure() {
    if (el || !doc || typeof doc.createElement !== 'function') return el;
    el = doc.createElement('div');
    el.className = 'we-pet-bubble';
    el.style.position = 'fixed';
    el.style.zIndex = '9999';
    el.style.maxWidth = '260px';
    el.style.padding = '8px 10px';
    el.style.borderRadius = '12px';
    el.style.background = 'rgba(24,24,28,.92)';
    el.style.color = '#f2f2f5';
    el.style.fontSize = '12px';
    el.style.lineHeight = '1.5';
    el.style.pointerEvents = 'none';
    el.style.opacity = '0';
    el.style.transition = 'opacity .18s ease';
    // 超过 6 行省略：气泡永远不长大到挡住桌宠
    el.style.display = '-webkit-box';
    el.style.webkitLineClamp = String(MAX_LINES);
    el.style.webkitBoxOrient = 'vertical';
    el.style.overflow = 'hidden';
    el.style.whiteSpace = 'pre-wrap';
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(el);
    return el;
  }

  function cancelFade() {
    if (fadeTimer != null) { clearTimer(fadeTimer); fadeTimer = null; }
  }

  /** 显示（或继续显示）一段文本；重复调用会重排文本而不是叠出第二个气泡。 */
  function show(nextText) {
    if (!ensure()) return;
    cancelFade();
    text = String(nextText == null ? '' : nextText);
    el.textContent = text;
    el.style.opacity = '1';
    visible = true;
    place();
  }

  /** 逐字/逐段追加（SSE 每个 chunk 调一次）。 */
  function append(chunk) {
    if (!ensure()) return;
    cancelFade();
    text += String(chunk == null ? '' : chunk);
    el.textContent = text;
    el.style.opacity = '1';
    visible = true;
    place();
  }

  /** 隐藏；带 delay 时先挂着，到点淡出（朗读结束后 +3s 用这个）。 */
  function hide(delayMs) {
    if (!el) return;
    cancelFade();
    const delay = Number(delayMs) || 0;
    const doHide = () => {
      fadeTimer = null;
      el.style.opacity = '0';
      visible = false;
    };
    if (delay > 0) { fadeTimer = setTimer(doHide, delay); return; }
    doHide();
  }

  /** 状态：听 / 想 / 答（客户端据此换桌宠动作、给气泡配色）。 */
  function setState(kind) {
    if (!el) return;
    el.dataset = el.dataset || {};
    el.dataset.state = String(kind || '');
  }

  function isVisible() { return visible; }

  function dispose() {
    cancelFade();
    if (el && typeof el.remove === 'function') el.remove();
    el = null;
    text = '';
    visible = false;
  }

  return {
    show, append, hide, setState, place, isVisible, dispose,
    // 判据要读的内部状态
    get text() { return text; },
    get element() { return el; },
    MAX_LINES,
  };
}
