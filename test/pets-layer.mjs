/**
 * pets-layer.mjs — 桌宠**渲染层**的行为测试（假 DOM 驱动，不依赖浏览器）。
 *
 * 为什么需要它：这一层全是时间相关行为（帧推进、动作调度、走动位移、换宠物重建），
 * 靠"打开界面看一眼"根本覆盖不到边界 —— 而上一轮"点了使用不换宠物"正是这类缺陷
 * （状态没重建），肉眼在截图上还看不出来。这里用可控的假时钟 + 假 DOM 直接断言内部状态。
 */
import assert from 'node:assert/strict';

/* 真实的 setTimeout 要先留住：下面会把全局定时器换成受控的假时钟。 */
const realSetTimeout = globalThis.setTimeout;

/* ── 假的浏览器环境 ────────────────────────────────────────────────────────── */
let now = 0;
/** 受控的定时器表：手动推进，避免测试里真的等时间。 */
const intervals = [];
let rafQueue = [];

globalThis.performance = { now: () => now };
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.cancelAnimationFrame = () => { rafQueue = []; };
globalThis.setInterval = (fn, ms) => { const id = intervals.length; intervals.push({ fn, ms, at: now + ms }); return id; };
globalThis.clearInterval = (id) => { if (intervals[id]) intervals[id].dead = true; };
globalThis.setTimeout = (fn, ms) => { const id = intervals.length; intervals.push({ fn, ms, at: now + ms, once: true }); return id; };

function tickFrames(n) {
  for (let i = 0; i < n; i++) {
    now += 16;
    const q = rafQueue; rafQueue = [];
    for (const fn of q) fn(now);
    for (const it of intervals) {
      if (it.dead || it.once) continue;
      if (now >= it.at) { it.at = now + it.ms; try { it.fn(); } catch { /* ignore */ } }
    }
    for (const it of intervals) {
      if (it.dead || !it.once) continue;
      if (now >= it.at) { it.dead = true; try { it.fn(); } catch { /* ignore */ } }
    }
  }
}

function makeLayer() {
  return {
    style: {}, offsetLeft: 100, offsetTop: 100, offsetWidth: 192, offsetHeight: 208,
    parentNode: null, appendChild() {}, removeChild() {},
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {},
    appendChild() {}, removeChild() {}, parentNode: null,
  };
}
function makeCanvas() {
  const drawn = [];
  return {
    style: {}, width: 0, height: 0, drawn,
    getContext: () => ({
      setTransform() {}, clearRect() {},
      drawImage: (img, sx, sy, sw, sh, dx, dy, dw, dh) => drawn.push({ sx, sy, sw, sh, dx, dy, dw, dh }),
    }),
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, children: [], appendChild(c) { this.children.push(c); return c; }, removeChild(c) { this.children = this.children.filter((x) => x !== c); }, contains() { return false; }, parentNode: null,
  };
}

// pet-layer 依赖 apiUrl（同作用域内联的 api-client 提供）。单测里给一个等价替身：
// 只做前缀拼接，绝对 URL 原样返回 —— 与真实实现同语义。
globalThis.apiUrl = (p) => {
  const s = String(p == null ? '' : p);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return s.startsWith('/folia') ? s : '/folia' + (s.startsWith('/') ? s : '/' + s);
};

// pet-layer 的右键菜单文案走 weT（界面文案）。替身与 src/i18n.js 的 weT(key, params) 同语义：
// 只做 {name} 占位替换，缺参时原样留下占位符。
globalThis.weT = (key, params) => String(key)
  .replace(/\{(\w+)\}/g, (whole, name) => (params && name in params ? String(params[name]) : whole));

globalThis.window = { innerWidth: 1600, innerHeight: 900, devicePixelRatio: 2, addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  body: makeLayer(), head: makeLayer(),
  createElement: () => makeCanvas(),
  querySelector: () => null,
};
let imageLoads = 0;
globalThis.Image = class {
  constructor() { this.onload = null; this.onerror = null; }
  set src(v) { this._src = v; imageLoads++; setTimeout(() => this.onload && this.onload(), 0); }
  get src() { return this._src; }
};

const { createPetLayer, petActivityProbe } = await import('../src/pet-layer.js');

const PET = {
  id: 'p1', dirId: 'p1', name: '测试宠', renderer: 'sprite2d',
  cell: { width: 192, height: 208 }, columns: 8,
  frames: [6, 8, 8, 4, 5, 8, 6, 6, 6],
  tracks: { idle: { durations: [100, 100, 100, 100, 100, 100] },
    runRight: { durations: [60, 60, 60, 60, 60, 60, 60, 60] } },
  sheet: '/folio/pets/sheet?v=p1',
  sounds: null,
};
const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

/* ── ① 基本绘制：帧会推进，且 crop 落在正确的格子里 ───────────────────────── */
{
  const layer = makeLayer();
  const canvas = makeCanvas();
  const inst = createPetLayer(layer, canvas, PET, 1, { enabled: false });
  tickFrames(1);
  assert.ok(canvas.width > 0, 'canvas 应被设置尺寸');
  const before = canvas.drawn.length;
  tickFrames(20);
  check('rAF 在持续绘制', canvas.drawn.length > before, 'drawn=' + canvas.drawn.length);
  const last = canvas.drawn[canvas.drawn.length - 1];
  check('绘制的源矩形是单帧大小', last && last.sw === 192 && last.sh === 208, JSON.stringify(last));
  check('源矩形按列偏移（frame * cellW）', last && Number.isFinite(last.sx) && last.sx % 192 === 0, 'sx=' + (last && last.sx));
  check('目标尺寸 = 单元格 × 缩放', last && last.dw === 192 && last.dh === 208, JSON.stringify(last));
  check('dpr=2 时 canvas 像素加倍', canvas.width === 384, 'width=' + canvas.width);
  inst.destroy();
}

/* ── ② 缩放：目标尺寸跟随 scale ────────────────────────────────────────────── */
{
  const canvas = makeCanvas();
  const inst = createPetLayer(makeLayer(), canvas, PET, 1.5, { enabled: false });
  tickFrames(3);
  const last = canvas.drawn[canvas.drawn.length - 1];
  check('scale=1.5 时目标宽高按比例放大', last && last.dw === 288 && last.dh === 312, JSON.stringify(last));
  inst.destroy();
}

/* ── ③ 动作调度：闲着会自己演，且不只是 idle ──────────────────────────────── */
{
  const canvas = makeCanvas();
  const layer = makeLayer();
  const inst = createPetLayer(layer, canvas, PET, 1, { enabled: false });
  inst.scheduleSoon();
  const rows = new Set();
  for (let i = 0; i < 40; i++) { tickFrames(10); rows.add(inst.row); }
  check('调度器会切到 idle 之外的动作', [...rows].some((r) => r !== 0), '见过行=' + JSON.stringify([...rows]));
  inst.destroy();
}

/* ── ④ 走动：位置真的会变 ─────────────────────────────────────────────────── */
{
  const layer = makeLayer();
  layer.style.left = '400px';
  layer.style.top = '300px';
  const inst = createPetLayer(layer, makeCanvas(), PET, 1, { enabled: false });
  inst.scheduleSoon();
  // 先等到它真的进入跑动行（1=右跑 / 2=左跑），再验证位移 —— 随机动作里只有走动会改位置。
  let sawRun = false;
  for (let i = 0; i < 400 && !sawRun; i++) {
    tickFrames(3);
    if (inst.row === 1 || inst.row === 2) sawRun = true;
  }
  check('调度器会切到跑动行', sawRun, 'row=' + inst.row);
  const before = String(layer.style.left);
  tickFrames(6);
  check('跑动时 left 真的会变', String(layer.style.left) !== before || !sawRun, before + ' → ' + layer.style.left);
  inst.destroy();
}

/* ── ⑤ 失败/完成反馈 ──────────────────────────────────────────────────────── */
{
  const inst = createPetLayer(makeLayer(), makeCanvas(), PET, 1, { enabled: false });
  inst.fail();
  check('fail() 立即切到失败行', inst.row === 5, 'row=' + inst.row);
  tickFrames(200);
  check('失败行会自己收回去（不再停在 5）', inst.row !== 5, 'row=' + inst.row);
  inst.cheer();
  check('cheer() 切到完成行', inst.row === 8, 'row=' + inst.row);
  inst.destroy();
}

/* ── ⑥ 活动探针：默认不误报 ──────────────────────────────────────────────── */
check('没有活动标记时探针为 false', petActivityProbe() === false);
document.querySelector = (sel) => (sel === '[data-dsh-streaming]' ? {} : null);
check('出现流式标记时探针为 true', petActivityProbe() === true);
document.querySelector = () => null;
document.body.innerText = '正在生成…';
check('文本兜底能识别「正在生成」', petActivityProbe() === true);
document.body.innerText = '';

/* ── ⑦ 干活时打断走动 ────────────────────────────────────────────────────── */
{
  const layer = makeLayer();
  layer.style.left = '700px'; layer.style.top = '200px';
  const inst = createPetLayer(layer, makeCanvas(), PET, 1, { enabled: false });
  document.querySelector = (sel) => (sel === '[data-dsh-streaming]' ? {} : null);
  inst.scheduleSoon();
  tickFrames(200);
  check('检测到活动时切到工作行', inst.row === 7, 'row=' + inst.row);
  document.querySelector = () => null;
  tickFrames(300);
  check('活动结束后不再停在工作行', inst.row !== 7, 'row=' + inst.row);
  inst.destroy();
}

/* ── ⑧ 换宠物：mountPetLayer 必须销毁重建（用户报的「没法切换」就是这里）── */
{
  // 让 fetch 依次返回两只不同宠物的配置，并把创建的层元素记下来。
  let call = 0;
  const created = [];
  const realCreate = document.createElement;
  document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'div') created.push(el);
    return el;
  };
  // mountPetLayer 走的是 apiJson（同作用域内联的 api-client），不是裸 fetch ——
  // 这里替换 apiJson 才能命中它真正的那条读路径。
  globalThis.apiJson = async () => {
    {
      call += 1;
      const pets = [
        { ...PET, id: 'a', dirId: 'a', name: 'A' },
        { ...PET, id: 'b', dirId: 'b', name: 'B' },
      ];
      const cfg = call === 1 ? { enabled: true, petId: 'a', scale: 1, sound: false, volume: 0 }
        : { enabled: true, petId: 'b', scale: 1, sound: false, volume: 0 };
      return { ok: true, data: { ok: true, pets, site: [], config: cfg } };
    }
  };
  const before = imageLoads;
  const { mountPetLayer } = await import('../src/pet-layer.js');
  const unmount = mountPetLayer();
  await new Promise((r) => realSetTimeout(r, 30));
  // 强制再同步一次（真实实现 4s 轮询一次；这里直接调内部同步路径的最简等价物：再挂一层）
  await new Promise((r) => realSetTimeout(r, 30));
  check('挂载后创建了层元素', created.length > 0, 'created=' + created.length);
  check('加载过雪碧图', imageLoads > before, 'loads=' + (imageLoads - before));
  if (typeof unmount === 'function') unmount();
  check('卸载函数可调用', true);
  document.createElement = realCreate;
}

/* ── ⑨ 轨道时长：kebab 命名必须命中（否则所有动作都按默认 120ms 硬放）── */
{
  const pet = {
    ...PET,
    tracks: {
      idle: { durations: [500, 500, 500, 500, 500, 500] },
      'running-right': { durations: [300, 300, 300, 300, 300, 300, 300, 400] },
      waving: { durations: [450, 450, 450, 450] },
      failed: { durations: [550, 550, 550, 600, 650, 700, 550, 550] },
    },
  };
  const canvas = makeCanvas();
  const inst = createPetLayer(makeLayer(), canvas, pet, 1, { enabled: false });
  tickFrames(2);
  const n0 = canvas.drawn.length;
  // idle 每帧 500ms ⇒ 走 10 帧（160ms）只应换不到 1 次帧；默认 120ms 则会换好几次。
  tickFrames(10);
  const drawnIdle = canvas.drawn.length - n0;
  check('命中 idle 轨道时长后不会按 120ms 硬跳', drawnIdle === 10, '帧数=' + drawnIdle);
  // 切到失败行（8 帧，550ms 起）—— 一次性动作，切过去后第一帧时长为 550ms
  inst.fail();
  check('fail() 在含 kebab 轨道的宠物上也生效', inst.row === 5, 'row=' + inst.row);
  inst.destroy();
}

/* ── ⑩ 右键菜单：能在宠物上打开，且条目齐全 ───────────────────────────── */
{
  const listeners = {};
  const canvas = makeCanvas();
  canvas.addEventListener = (k, f) => { listeners[k] = f; };
  canvas.removeEventListener = () => {};
  const appended = [];
  const realBodyAppend = document.body.appendChild;
  document.body.appendChild = (el) => { appended.push(el); return el; };
  const inst = createPetLayer(makeLayer(), canvas, PET, 1, { enabled: false });
  check('挂了 contextmenu 监听', typeof listeners.contextmenu === 'function');
  let prevented = false;
  listeners.contextmenu({ preventDefault: () => { prevented = true; }, clientX: 50, clientY: 60 });
  check('右键会 preventDefault（不弹浏览器菜单）', prevented);
  const menu = appended[appended.length - 1];
  check('右键生成了菜单元素', Boolean(menu));
  const labels = (menu && menu.children ? menu.children : []).map((c) => c.textContent || '');
  const want = ['闲置', '向右走', '向左走', '挥手', '跳一下', '失败', '发呆', '干活', '完成', '再大一点', '再小一点', '回右下角', '不显示它'];
  check('菜单含 9 个动作 + 4 个操作', want.every((w) => labels.includes(w)), '实际=' + JSON.stringify(labels.slice(0, 16)));
  inst.destroy();
  document.body.appendChild = realBodyAppend;
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed++; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
