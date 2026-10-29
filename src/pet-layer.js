/**
 * pet-layer.js — 桌宠**渲染层**（自己画，不依赖任何第三方宠物插件）。
 *
 * 形态：`<body>` 下的一个 fixed 容器 + 一张 canvas，用 sprite2d 雪碧图逐帧绘制。
 *
 * 契约（与宿主 `/folia/pets/list` 一致）：
 *   pets[i] = { id, dirId, name, renderer, cell:{width,height}, columns, frames:number[9],
 *               tracks:{ <轨道名>: { durations:number[] } }, sheet:'/folia/pets/sheet?v=<dirId>' }
 *
 * 行序（9 行，dsh-pet 的 contract，缺轨道时回落 idle）：
 *   0 idle · 1 右跑 · 2 左跑 · 3 挥手 · 4 跳 · 5 失败 · 6 等待 · 7 工作 · 8 完成
 *
 * 为什么整层是"命令式 DOM + rAF"而不是 React：它每秒重绘几十次，进 React 只会让
 * 每次 setState 触发整棵树协调；这里只碰一个 canvas 的像素，与面板渲染互不干扰。
 */

const PET_LAYER_ID = "we-pet-layer";
const PET_ROW = { idle: 0, runRight: 1, runLeft: 2, wave: 3, jump: 4, fail: 5, wait: 6, work: 7, done: 8 };
const PET_DEFAULT_FRAME_MS = 120;
/** 光标静止后多久切回 idle（毫秒）。 */
const PET_WAVE_IDLE_MS = 9000;

/**
 * 桌宠实例：一只宠物一条生命周期（换宠物 = 销毁重来）。
 * 不导出（构建期内联进同一作用域），只由 mountPetLayer 使用。
 */
function createPetLayer(layerEl, canvas, pet, scale) {
  const ctx = canvas.getContext("2d");
  const img = new Image();
  let frame = 0;
  let row = PET_ROW.idle;
  let acc = 0;
  let last = 0;
  let raf = 0;
  let dead = false;
  let idleSince = 0;
  let dragging = null;
  let ready = false;

  const cw = Math.max(1, Number(pet.cell && pet.cell.width) || 192);
  const ch = Math.max(1, Number(pet.cell && pet.cell.height) || 208);
  const cols = Math.max(1, Number(pet.columns) || 8);
  const frames = Array.isArray(pet.frames) && pet.frames.length ? pet.frames : new Array(9).fill(cols);

  function rowFrames(r) {
    const n = Number(frames[r]);
    return Number.isFinite(n) && n > 0 ? Math.min(cols, n) : cols;
  }
  function frameMs(r, f) {
    const t = pet.tracks && pet.tracks[Object.keys(PET_ROW)[r] === undefined ? "" : Object.keys(PET_ROW)[r]];
    const d = t && Array.isArray(t.durations) ? t.durations[f] : null;
    return Number.isFinite(Number(d)) && Number(d) > 0 ? Number(d) : PET_DEFAULT_FRAME_MS;
  }

  function resize() {
    const w = Math.round(cw * scale);
    const h = Math.round(ch * scale);
    const dpr = Math.min(3, Math.max(1, (typeof window !== "undefined" && window.devicePixelRatio) || 1));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    if (canvas.getContext) {
      const c2 = canvas.getContext("2d");
      if (c2 && c2.setTransform) c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function draw() {
    if (!ready || dead) return;
    const n = rowFrames(row);
    if (frame >= n) frame = 0;
    const sx = frame * cw;
    const sy = row * ch;
    try {
      ctx.clearRect(0, 0, cw * scale, ch * scale);
      ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw * scale, ch * scale);
    } catch { /* 贴图还没解码完：下一帧再画 */ }
  }

  function tick(now) {
    if (dead) return;
    if (!last) last = now;
    acc += now - last;
    last = now;
    const ms = frameMs(row, frame);
    if (acc >= ms) {
      acc = 0;
      frame += 1;
      if (frame >= rowFrames(row)) {
        frame = 0;
        // 一次性动作（挥手 / 跳）播完回 idle
        if (row === PET_ROW.wave || row === PET_ROW.jump) row = PET_ROW.idle;
      }
    }
    draw();
    raf = (typeof requestAnimationFrame === "function")
      ? requestAnimationFrame(tick)
      : setTimeout(() => tick(Date.now()), 60);
  }

  function setRow(next) {
    if (row === next) return;
    row = next;
    frame = 0;
    acc = 0;
  }

  function onPointerDown(e) {
    if (!layerEl) return;
    dragging = {
      dx: e.clientX - layerEl.offsetLeft,
      dy: e.clientY - layerEl.offsetTop,
      moved: false,
    };
    try { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const x = Math.max(0, Math.min((window.innerWidth || 1920) - layerEl.offsetWidth, e.clientX - dragging.dx));
    const y = Math.max(0, Math.min((window.innerHeight || 1080) - layerEl.offsetHeight, e.clientY - dragging.dy));
    layerEl.style.left = x + "px";
    layerEl.style.top = y + "px";
    layerEl.style.right = "auto";
    layerEl.style.bottom = "auto";
    dragging.moved = true;
  }
  function onPointerUp() {
    if (!dragging) return;
    const moved = dragging.moved;
    dragging = null;
    if (!moved) {
      // 单击 = 挥手（给用户一个"它有反应"的反馈），之后自动回 idle
      setRow(PET_ROW.wave);
    } else {
      try { localStorage.setItem("wePetPos", JSON.stringify({ left: layerEl.style.left, top: layerEl.style.top })); } catch { /* ignore */ }
    }
  }

  img.onload = () => { ready = true; resize(); draw(); };
  img.onerror = () => { destroy(); };
  img.src = apiUrl(pet.sheet || "/pets/sheet?v=" + encodeURIComponent(pet.dirId || pet.id));

  canvas.addEventListener("pointerdown", onPointerDown);
  if (typeof window !== "undefined") {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }
  idleSince = Date.now();
  raf = (typeof requestAnimationFrame === "function") ? requestAnimationFrame(tick) : setTimeout(() => tick(Date.now()), 60);

  function destroy() {
    dead = true;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf); else clearTimeout(raf);
    canvas.removeEventListener("pointerdown", onPointerDown);
    if (typeof window !== "undefined") {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }
  }

  return { destroy, setRow, resize };
}

/**
 * 挂载桌宠层。返回卸载函数（无宠物 / 未启用时返回 null）。
 *
 * 它自己拉 `/folia/pets/list`（配置 + 已装宠物），所以**不依赖面板是否打开过** ——
 * 冷启动就能出宠物。
 */
function mountPetLayer() {
  if (typeof document === "undefined" || !document.body) return null;
  let disposed = false;
  let instance = null;
  let layerEl = null;

  function teardownDom() {
    if (instance) { try { instance.destroy(); } catch { /* ignore */ } instance = null; }
    if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
    layerEl = null;
  }

  async function sync() {
    let doc = null;
    try {
      const resp = await apiJson("/pets/list", { parse: "always" });
      doc = (resp && resp.data) || null;
    } catch { doc = null; }
    if (disposed) return;
    const cfg = (doc && doc.config) || null;
    const pets = (doc && doc.pets) || [];
    const pet = cfg && cfg.petId ? pets.find((p) => p.dirId === cfg.petId || p.id === cfg.petId) : null;
    if (!cfg || !cfg.enabled || !pet) { teardownDom(); return; }

    const scale = Number(cfg.scale) > 0 ? Number(cfg.scale) : 1;
    if (layerEl) { layerEl.style.display = ""; if (instance) instance.resize(); return; }

    layerEl = document.createElement("div");
    layerEl.id = PET_LAYER_ID;
    layerEl.style.cssText = [
      "position:fixed", "right:24px", "bottom:16px", "z-index:2147482000",
      "cursor:grab", "user-select:none", "touch-action:none",
      "filter:drop-shadow(0 6px 14px rgba(0,0,0,0.35))",
    ].join(";");
    try {
      const saved = JSON.parse(localStorage.getItem("wePetPos") || "null");
      if (saved && saved.left && saved.top) {
        layerEl.style.left = saved.left;
        layerEl.style.top = saved.top;
        layerEl.style.right = "auto";
        layerEl.style.bottom = "auto";
      }
    } catch { /* 用默认位置 */ }
    const canvas = document.createElement("canvas");
    layerEl.appendChild(canvas);
    document.body.appendChild(layerEl);
    instance = createPetLayer(layerEl, canvas, pet, scale);
  }

  sync();
  // 配置变化（面板里换宠物/开关）不需要重启：轻量轮询即可，代价是一次本地 HTTP。
  // ⚠️ 定时器要 feature-detect：宿主在 smoke / 单测沙箱里没有 timers，直接调会 ReferenceError，
  //    而那一抛会把整个 apply 打成失败（实测：smoke 第 1 步就红）。
  const timer = typeof setInterval === 'function'
    ? setInterval(() => { if (!disposed) sync(); }, 4000)
    : null;

  return () => {
    disposed = true;
    if (typeof clearInterval === 'function' && timer !== null) clearInterval(timer);
    teardownDom();
  };
}
