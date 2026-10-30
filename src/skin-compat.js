/**
 * 皮肤兼容层：把宿主（stock DSH）的**槽位词表**翻译成皮肤包认的**分栏词表**。
 *
 * 为什么需要它（实测，不是推测）：
 *   · 皮肤包的 CSS 大量使用 `[data-pane="sidebar"]` / `[data-pane="conversation"]` /
 *     `[data-pane="details"]` / `[data-dsh-frame]`。样例计数（按行）：
 *     verdandi 60+、xp 36+、deep-current 12、cafe-roastery 10、ember-fall 6、blueprint 4 …
 *     全catalog 里 `data-pane=` 出现 250+ 次。
 *   · 但**这些属性不是宿主写的**，是 `@linxin666/dsh-web-all` 的 compat shim 写的：
 *     web-all/lib/client.js 的 `COLUMN_SHIMS = [["[class*=\"sidebarCol\"]","data-pane=\"sidebar\""], …]`
 *     而皮肤中心自己也写明："the `data-pane=\"conversation\"` attribute is stamped by the
 *     dsh-web-all compat shim"（skin-center/lib/client.js:4171 附近的注释）。
 *   ⇒ 没装 web-all 时，这些选择器**一条都不命中**：皮肤不是"坏了"，是它认的分栏标记不在。
 *     症状就是"皮肤显示不全"（布局/侧栏/输入区没被皮肤接管），而装了 web-all 就正常。
 *
 * 我们的做法：**只读宿主槽位，补写分栏属性**。
 *   · `[data-slot="sidebar"]` → 它的父元素（`div.[class*=sidebarCol]`）标 `data-pane="sidebar"`
 *   · `[data-slot="main"]`    → 它的父元素（`div.[class*=centerCol]`）标 `data-pane="conversation"`
 *   · `[data-slot="rightbar"]` → 它的父元素（`div.[class*=rightbarCol]`）标 `data-pane="details"`
 *   · `#root` 下的画框元素 → `data-dsh-frame`
 *
 * ⚠️ **锚点必须取"列那一级"的槽名**（sidebar / main / rightbar），取深层槽名是无效的：
 *   宿主 `renderSlot` 的锚点是 `ANCHOR_STYLE = { display: "contents" }` 的**无布局包裹元素**
 *   与列容器之间的嵌套（app.asar 实证，JSX 顺序即 DOM 顺序）：
 *
 *     div.frame
 *       ├ div.sidebarCol   ← children: renderSlot("sidebar")        ⇒ 锚点的父元素就是列
 *       ├ div.centerCol    ← children: renderSlot("main")           ⇒ 同上
 *       └ div.rightbarCol  ← children: renderSlot("rightbar")       ⇒ 同上
 *
 *   而 `main.conversation` 是 `main` 的子槽（`ConversationPanel` 里 renderSlot），
 *   `rightbar.session` 更在 `div.session` 之内 ⇒ 它们的**父元素是另一个 display:contents 锚点
 *   或内层包裹 div**，把 data-pane 写在那里既没有布局效果、也不是方案认的那一列。
 *   ⇒ 所以这里既用列级槽名，又让 `paneHost` **穿过 `[data-slot]` 锚点**再落笔；
 *     深层槽名只作退路（宿主哪天不再给列级槽名时仍能命中）。
 *
 * 三条纪律（与仓库既有的跨插件协议一致）：
 *   ① **只写自己的标记**：不碰皮肤中心的 `data-dsh-skin` / `data-dsh-surface` / 任何 `data-we-*`；
 *   ② **幂等**：已存在同名属性就不改（别人（web-all）先写过就以它为准）；
 *   ③ **可失败**：整段包在 try 里，异常绝不影响壁纸/玻璃主路径；观察器只在 document 就绪后装。
 *
 * 属性本身是惰性的（宿主 CSS 不用 data-pane），所以可以在启动时就补，不必等皮肤上台。
 */

const PANE_ANCHORS = [
  // 列级槽名优先（实证：这三种锚点的父元素就是列容器）。
  { pane: 'sidebar', selectors: ['[data-slot="sidebar"]'] },
  { pane: 'conversation', selectors: ['[data-slot="main"]', '[data-slot="main.conversation"]'] },
  { pane: 'details', selectors: ['[data-slot="rightbar"]', '[data-slot="rightbar.session"]', '[data-sidebar-right-panel]'] },
];

/** 从锚点元素上溯（穿过 display:contents 的 `[data-slot]` 锚点），得到"那一列"的容器。 */
function paneHost(anchor) {
  let el = anchor && anchor.parentElement;
  // 宿主的槽位锚点都是 display:contents 包裹元素（renderSlot 的 ANCHOR_STYLE），
  // 属性写在它身上没有布局效果 ⇒ 必须一直走到第一个"真盒子"。
  let guard = 0;
  while (el && el.hasAttribute && el.hasAttribute('data-slot') && guard < 12) {
    el = el.parentElement;
    guard += 1;
  }
  if (!el || el === document.body) return null;
  if (el.id === 'root') return null;
  if (el.hasAttribute('data-dsh-frame')) return null;
  return el;
}

function stampPanes() {
  let stamped = 0;
  for (const rule of PANE_ANCHORS) {
    // 每条规则**各自**判断有没有命中：早先用累计计数会让后一条规则在第一条选择器空手时
    // 直接跳过退路选择器（conversation/details 的退路因此永远不被尝试）。
    let ruleStamped = 0;
    for (const selector of rule.selectors) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      for (const node of nodes) {
        const host = paneHost(node);
        if (!host || host.hasAttribute('data-pane')) continue;
        host.setAttribute('data-pane', rule.pane);
        stamped += 1;
        ruleStamped += 1;
      }
      if (ruleStamped) break; // 同一 pane 命中一种锚点即可
    }
  }
  return stamped;
}

function stampFrame() {
  try {
    if (document.querySelector('[data-dsh-frame]')) return 0;
    const root = document.getElementById('root') || document.body;
    if (!root) return 0;
    // 与 web-all 同口径：**列容器的父元素**就是画框（`sidebarCol.parentElement`）；类名只作退路。
    const sidebarHost = document.querySelector('[data-pane="sidebar"]');
    const fromColumn = (sidebarHost && sidebarHost.parentElement) || null;
    const frame = (fromColumn && fromColumn !== document.body && fromColumn.id !== 'root' ? fromColumn : null)
      || root.querySelector('div[class*="_frame"]')
      || root.firstElementChild;
    if (!frame || frame.hasAttribute('data-dsh-frame')) return 0;
    if (frame === document.body || frame.id === 'root') return 0;
    frame.setAttribute('data-dsh-frame', '');
    return 1;
  } catch { return 0; }
}

function stampAll() {
  try { return stampPanes() + stampFrame(); } catch { return 0; }
}

/**
 * 定时器可缺省：**挂载点跑在不保证有定时的宿主里**。
 * 实测（2026-10-30，`test/verify-playback-controls.mjs` / `verify-transcode-state.mjs`）：
 * 那几个守卫用只实现 `document` 的 fake DOM 直接 apply 客户端，**没有 `setTimeout`** ——
 * 这里裸调 `setTimeout` 会 `ReferenceError`，而 `ctx.effect(() => feat.mount())` 不做保护，
 * 异常会顺着 apply 链把**整个宿主插件**带崩（一次 17 条判据全红）。
 * ⇒ 有就用（优先 `window.setTimeout`，与仓库其它层同口径），没有就**当场做**，绝不抛。
 */
function scheduleAfter(fn, ms) {
  try {
    const st = (typeof window !== 'undefined' && typeof window.setTimeout === 'function')
      ? window.setTimeout.bind(window)
      : (typeof setTimeout === 'function' ? setTimeout : null);
    if (!st) { fn(); return null; }
    return st(fn, ms);
  } catch { try { fn(); } catch { /* ignore */ } return null; }
}

function cancelAfter(id) {
  try {
    if (id === null || id === undefined) return;
    if (typeof clearTimeout === 'function') clearTimeout(id);
    else if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') window.clearTimeout(id);
  } catch { /* ignore */ }
}

/** 装上兼容层；返回幂等 teardown（与仓库其它 install* 同形）。整段可失败（异常不外溢）。 */
function installSkinCompat() {
  if (typeof document === 'undefined') return () => {};
  try {
    stampAll();
    let observer = null;
    let timer = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = scheduleAfter(() => { timer = null; stampAll(); }, 120);
    };
    try {
      observer = new MutationObserver(schedule);
      // 只观察结构性变化（子树增删）；不观察属性，避免别人改属性时我们无限自激。
      observer.observe(document.body, { childList: true, subtree: true });
    } catch { observer = null; }
    // 宿主是 SPA：路由切换会整块换掉列容器，所以补一次延迟重扫。
    const late = scheduleAfter(stampAll, 1500);
    return () => {
      try { if (observer) observer.disconnect(); } catch { /* ignore */ }
      if (timer !== null) { cancelAfter(timer); timer = null; }
      cancelAfter(late);
    };
  } catch { return () => {}; }
}
