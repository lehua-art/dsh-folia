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
/**
 * 行号 → 轨道名的**候选表**。
 *
 * ⚠️ dsh-pet 的 manifest 用的是 kebab 命名（`running-right` / `waving` / `failed` …），
 * 我最初按驼峰（`runRight` / `wave`）去查，结果**一次都没命中** —— 每帧都退回默认 120ms，
 * 于是所有动作的节奏都是同一个硬速度，看起来就像"动作不对/没几个动作"。
 * 这里按「标准名 → 驼峰别名 → 其它常见写法」依次找，命中即用。
 */
const PET_TRACK_ALIASES = [
  ['idle'],
  ['running-right', 'runRight', 'right'],
  ['running-left', 'runLeft', 'left'],
  ['waving', 'wave'],
  ['jumping', 'jump'],
  ['failed', 'fail'],
  ['waiting', 'wait'],
  ['running', 'working', 'work'],
  ['review', 'done', 'completed'],
];
const PET_DEFAULT_FRAME_MS = 120;
/**
 * 活动检测：DSH 的客户端 `ctx` 只暴露 effect/get/slots/surface，没有会话事件，
 * 所以"模型在不在干活"只能从**页面本身**读。两条独立信号，任一命中即认为在工作：
 *   ① DOM 特征：选择器（默认覆盖常见的 streaming / 生成中 标记）
 *   ② 文本特征：屏幕上出现"正在生成 / 思考中 / Stop generating"这类字眼
 * 两条都读不到时**安静地停在 idle** —— 宁可不动，也不要让宠物乱跳。
 */
const PET_ACTIVITY_SELECTORS = [
  '[data-dsh-streaming]', '[data-streaming="true"]', '.ds-streaming',
  '[class*="streaming"]', '[class*="isGenerating"]', '[aria-busy="true"]',
];
const PET_ACTIVITY_TEXTS = ['正在生成', '思考中', '停止生成', 'Stop generating', 'Thinking'];
/** 检测节流（毫秒）：一次 body 扫描比一次布局还便宜，但没必要每帧跑。 */
const PET_ACTIVITY_POLL_MS = 500;
/** 光标静止后多久切回 idle（毫秒）。 */
const PET_WAVE_IDLE_MS = 9000;
/**
 * 日常动作调度：没在干活时，每隔 5~11 秒随机演一个。
 *
 * 为什么需要它：只播 idle 的宠物看起来是"一张会呼吸的图"，不像活物。这里把 manifest 的
 * 9 条轨道都用上 —— 走一段（左右跑）、挥手、跳一下、发会儿呆 —— 用**随机间隔**而不是固定节拍，
 * 避免机械感。干活（work/done/fail）优先级最高，调度器在那些状态下不抢行。
 */
const PET_IDLE_ACTIONS = [
  { row: "wave", weight: 3, ms: 0 },
  { row: "jump", weight: 2, ms: 0 },
  { row: "wait", weight: 2, ms: 1800 },
  { row: "walkRight", weight: 3, ms: 1600 },
  { row: "walkLeft", weight: 3, ms: 1600 },
];
/**
 * 统一时钟。
 *
 * ⚠️ `requestAnimationFrame(fn)` 交给 fn 的是**页面相对时间**（与 performance.now 同源），
 *    不是 petNow()。两者混用会出现「holdUntil = petNow() + 1400，而 now 只有几千」——
 *    比较永远不成立，于是宠物切到 done/fail/wave 之后**再也回不到 idle**（实测复现）。
 *    所有时间比较一律走这一个函数。
 */
function petNow() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
  } catch { /* 退回 Date.now */ }
  return petNow();
}
/** 两次随机动作之间的间隔范围（毫秒）。 */
const PET_IDLE_GAP_MS = [3000, 7000];

/**
 * 声音：包内 `sounds/<事件>.ogg|mp3|wav` 优先（manifest.sounds 显式声明），
 * 没有就用 Web Audio 合成 —— 一只宠物没声音比"声音是版权素材"糟得多。
 * 全部失败都静默：声音是可选项，不该有能力打断渲染。
 */
function petVoice(ctxWindow, sounds, cfg) {
  const enabled = Boolean(cfg && cfg.sound);
  const volume = Math.max(0, Math.min(1, Number(cfg && cfg.volume) || 0));
  let audioCtx = null;
  const cache = new Map();

  function ensureCtx() {
    if (audioCtx || typeof ctxWindow.AudioContext !== 'function') return audioCtx;
    try { audioCtx = new ctxWindow.AudioContext(); } catch { audioCtx = null; }
    return audioCtx;
  }

  /** 合成提示音：不同事件不同音高与波形，短、克制。 */
  function synth(kind) {
    const ac = ensureCtx();
    if (!ac) return;
    const spec = kind === "done" ? { f: 880, d: 0.09, w: "sine" }
      : kind === "fail" ? { f: 220, d: 0.16, w: "sawtooth" }
      : { f: 620, d: 0.08, w: "triangle" };
    try {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = spec.w;
      osc.frequency.value = spec.f;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ac.destination);
      const now = ac.currentTime;
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * 0.25), now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + spec.d);
      osc.start(now);
      osc.stop(now + spec.d + 0.02);
    } catch { /* 合成失败就算了 */ }
  }

  function file(kind) {
    const url = sounds && sounds[kind];
    if (!url) return null;
    let el = cache.get(kind);
    if (!el) {
      try { el = new ctxWindow.Audio(apiUrl(url)); } catch { return null; }
      el.preload = "auto";
      cache.set(kind, el);
    }
    return el;
  }

  return {
    get enabled() { return enabled; },
    play(kind) {
      if (!enabled || volume <= 0) return;
      const el = file(kind);
      if (el) {
        try { el.currentTime = 0; el.volume = volume; const p = el.play(); if (p && p.catch) p.catch(() => synth(kind)); return; } catch { /* 落回合成 */ }
      }
      synth(kind);
    },
    destroy() {
      cache.clear();
      try { if (audioCtx && typeof audioCtx.close === "function") audioCtx.close(); } catch { /* ignore */ }
      audioCtx = null;
    },
  };
}

/** 页面里现在像不像"模型在干活"。任何异常都当 false。 */
function petActivityProbe() {
  try {
    if (typeof document === 'undefined' || !document.body) return false;
    for (const sel of PET_ACTIVITY_SELECTORS) {
      if (document.querySelector(sel)) return true;
    }
    const text = document.body.innerText || "";
    for (const marker of PET_ACTIVITY_TEXTS) {
      if (text.indexOf(marker) !== -1) return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * 桌宠实例：一只宠物一条生命周期（换宠物 = 销毁重来）。
 * 不导出（构建期内联进同一作用域），只由 mountPetLayer 使用。
 */
function createPetLayer(layerEl, canvas, pet, scale, cfg) {
  const ctx = canvas.getContext("2d");
  const img = new Image();
  let frame = 0;
  let row = PET_ROW.idle;
  let acc = 0;
  let last = 0;   // rAF 时间戳（页面相对时间），不是 Date.now()
  let raf = 0;
  let dead = false;
  let idleSince = 0;
  let dragging = null;
  let ready = false;
  const voice = petVoice(typeof window !== "undefined" ? window : {}, pet.sounds, cfg || {});
  let activity = false;
  let activityTimer = null;
  /** 一次性动作（done/fail）播完自动回 idle 的时间戳。 */
  let holdUntil = 0;
  /** 下一次随机动作的时间点；0 = 立即重排。 */
  let nextActionAt = 0;
  /** 走动中的速度（px/帧，正=向右）。0 = 不走。 */
  let walkSpeed = 0;
  /** 走动剩余时长（毫秒）。 */
  let walkLeft = 0;
  /** 单击轮换到第几号轨道。 */
  let clickIdx = 0;

  let scaleCur = Number(scale) > 0 ? Number(scale) : 1;
  const cw = Math.max(1, Number(pet.cell && pet.cell.width) || 192);
  const ch = Math.max(1, Number(pet.cell && pet.cell.height) || 208);
  const cols = Math.max(1, Number(pet.columns) || 8);
  const frames = Array.isArray(pet.frames) && pet.frames.length ? pet.frames : new Array(9).fill(cols);

  function rowFrames(r) {
    const n = Number(frames[r]);
    return Number.isFinite(n) && n > 0 ? Math.min(cols, n) : cols;
  }
  /** 该行的轨道配置（按别名表找；找不到返回 null）。 */
  function trackOf(r) {
    const names = PET_TRACK_ALIASES[r] || [];
    for (const n of names) {
      const tr = pet.tracks && pet.tracks[n];
      if (tr && Array.isArray(tr.durations) && tr.durations.length) return tr;
    }
    return null;
  }
  function frameMs(r, f) {
    const tr = trackOf(r);
    const d = tr ? tr.durations[f] : null;
    return Number.isFinite(Number(d)) && Number(d) > 0 ? Number(d) : PET_DEFAULT_FRAME_MS;
  }

  function resize() {
    const w = Math.round(cw * scaleCur);
    const h = Math.round(ch * scaleCur);
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
      ctx.clearRect(0, 0, cw * scaleCur, ch * scaleCur);
      ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cw * scaleCur, ch * scaleCur);
    } catch { /* 贴图还没解码完：下一帧再画 */ }
  }

  function tick(now) {
    if (dead) return;
    if (!last) last = now;
    const dt = Math.max(0, Math.min(100, now - last));   // 切后台回来可能是几百毫秒，钳住
    acc += dt;
    last = now;
    // ── 走动：每帧挪一点，走到头或时间到就停下回 idle ──
    if (walkSpeed !== 0 && walkLeft > 0) {
      const p = pos();
      const maxX = Math.max(0, (window.innerWidth || 1920) - layerEl.offsetWidth);
      const nx = p.left + walkSpeed;
      if (nx <= 0 || nx >= maxX) {
        walkSpeed = -walkSpeed;
        setRow(walkSpeed > 0 ? PET_ROW.runRight : PET_ROW.runLeft);
        moveTo(Math.max(0, Math.min(maxX, nx)), p.top);
      } else {
        moveTo(nx, p.top);
      }
      walkLeft -= dt;
      if (walkLeft <= 0) {
        walkSpeed = 0;
        setRow(PET_ROW.idle);
        nextActionAt = petNow() + PET_IDLE_GAP_MS[0] + Math.random() * (PET_IDLE_GAP_MS[1] - PET_IDLE_GAP_MS[0]);
      }
    }
    // ── 日常动作调度：只在"真的闲着"时才演 ──
    if (!activity && walkSpeed === 0 && row === PET_ROW.idle && !holdUntil && now >= nextActionAt) {
      playIdleAction();
      const gap = PET_IDLE_GAP_MS[0] + Math.random() * (PET_IDLE_GAP_MS[1] - PET_IDLE_GAP_MS[0]);
      nextActionAt = petNow() + gap;
    }

    // 活动状态变化时先切行（work/done/fail 优先于 idle/wave）。
    if (activityTimer === null && typeof setInterval === "function") {
      activityTimer = setInterval(() => {
        const nowActive = petActivityProbe();
        if (nowActive === activity && now < holdUntil) return;
        activity = nowActive;
        if (activity) {
          holdUntil = 0;
          walkSpeed = 0;
          walkLeft = 0;
          if (row !== PET_ROW.work) setRow(PET_ROW.work);
        } else if (row === PET_ROW.work) {
          // 干完活 → 完成行一小会儿，再回 idle（"被看见"的反馈）
          setRow(PET_ROW.done);
          holdUntil = petNow() + 1600;
          voice.play("done");
        }
      }, PET_ACTIVITY_POLL_MS);
    }
    if (holdUntil && now >= holdUntil) { holdUntil = 0; setRow(PET_ROW.idle); }
    const ms = frameMs(row, frame);
    if (acc >= ms) {
      acc = 0;
      frame += 1;
      if (frame >= rowFrames(row)) {
        frame = 0;
        // 一次性动作（挥手 / 跳）播完回 idle
        if (row === PET_ROW.wave || row === PET_ROW.jump) row = PET_ROW.idle;
        // done / fail 由 holdUntil 计时收尾，不在这里回 idle（否则刚出现的反馈会被吞掉）。
      }
    }
    draw();
    raf = (typeof requestAnimationFrame === "function")
      ? requestAnimationFrame(tick)
      : setTimeout(() => tick(petNow()), 60);
  }

  /** 当前左上角（拖动/走动都读写这一对值）。 */
  function pos() {
    const left = parseFloat(layerEl.style.left);
    const top = parseFloat(layerEl.style.top);
    return {
      left: Number.isFinite(left) ? left : (window.innerWidth - layerEl.offsetWidth - 24),
      top: Number.isFinite(top) ? top : (window.innerHeight - layerEl.offsetHeight - 16),
    };
  }
  function moveTo(left, top) {
    const maxX = Math.max(0, (window.innerWidth || 1920) - layerEl.offsetWidth);
    const maxY = Math.max(0, (window.innerHeight || 1080) - layerEl.offsetHeight);
    const x = Math.max(0, Math.min(maxX, left));
    const y = Math.max(0, Math.min(maxY, top));
    layerEl.style.left = x + "px";
    layerEl.style.top = y + "px";
    layerEl.style.right = "auto";
    layerEl.style.bottom = "auto";
  }

  /** 从 idle 里挑一个动作演。走动会真的位移，演完自己停。 */
  function playIdleAction() {
    const total = PET_IDLE_ACTIONS.reduce((s, a) => s + a.weight, 0);
    let pick = Math.random() * total;
    let action = PET_IDLE_ACTIONS[0];
    for (const a of PET_IDLE_ACTIONS) { if ((pick -= a.weight) <= 0) { action = a; break; } }
    if (action.row === "walkRight" || action.row === "walkLeft") {
      const dir = action.row === "walkRight" ? 1 : -1;
      const p0 = pos();
      // 走到边上就掉头：撞墙不停在原地踏步，直接换方向。
      const maxX = Math.max(0, (window.innerWidth || 1920) - layerEl.offsetWidth);
      if ((dir > 0 && p0.left >= maxX - 2) || (dir < 0 && p0.left <= 2)) {
        setRow(dir > 0 ? PET_ROW.runLeft : PET_ROW.runRight);
        walkSpeed = -dir * (0.9 * scaleCur);
      } else {
        setRow(dir > 0 ? PET_ROW.runRight : PET_ROW.runLeft);
        walkSpeed = dir * (0.9 * scaleCur);
      }
      walkLeft = action.ms;
      return;
    }
    walkSpeed = 0;
    walkLeft = 0;
    setRow(PET_ROW[action.row] === undefined ? PET_ROW.idle : PET_ROW[action.row]);
    holdUntil = action.ms ? petNow() + action.ms : petNow() + 1400;
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
      walkSpeed = 0;
      walkLeft = 0;
      // 单击 = 演下一个动作（按 9 条轨道轮换），让用户能逐个看到它会什么。
      clickIdx = (clickIdx + 1) % PET_TRACK_ALIASES.length;
      const nextRow = clickIdx === 0 ? PET_ROW.idle : clickIdx;
      setRow(nextRow);
      holdUntil = petNow() + 1400;
      voice.play(nextRow === PET_ROW.fail ? "fail" : nextRow === PET_ROW.done ? "done" : "wave");
    } else {
      try { localStorage.setItem("wePetPos", JSON.stringify({ left: layerEl.style.left, top: layerEl.style.top })); } catch { /* ignore */ }
    }
  }

  /* ── 右键菜单：换宠物之外的全部互动都在这里 ────────────────────────────
   * 为什么自己做：宿主的页签要打开面板才能操作，而"摸它"这件事应该发生在宠物身上。
   * 菜单条目 = 9 条动作各一条（点一下立刻试演）+ 声音/大小/复位/隐藏。
   */
  let menu = null;
  function closeMenu() {
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    menu = null;
  }
  function buildMenuItem(label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.style.cssText = "display:block;width:100%;padding:6px 10px;background:transparent;border:0;color:inherit;text-align:left;font-size:12px;cursor:pointer;white-space:nowrap";
    b.addEventListener("mouseenter", () => { b.style.background = "rgba(255,255,255,0.10)"; });
    b.addEventListener("mouseleave", () => { b.style.background = "transparent"; });
    b.addEventListener("click", (ev) => { ev.stopPropagation(); onClick(); });
    return b;
  }
  function openMenu(clientX, clientY) {
    closeMenu();
    menu = document.createElement("div");
    menu.style.cssText = [
      "position:fixed", "z-index:2147482001", "min-width:150px", "padding:6px 0",
      "border-radius:8px", "font-size:12px", "color:#eee",
      "background:rgba(28,32,40,0.96)", "border:1px solid rgba(255,255,255,0.16)",
      "box-shadow:0 10px 30px rgba(0,0,0,0.45)", "backdrop-filter:blur(8px)",
    ].join(";");
    // 九条轨道的中文名是**界面文案**（右键菜单里给用户点的）⇒ 必须走 weT；
    // 上面 PET_ACTIVITY_TEXTS 那几条是拿去匹配页面文字的，翻不动，登记在 i18n 的 VALUE_ALLOW。
    const titles = [weT("闲置"), weT("向右走"), weT("向左走"), weT("挥手"), weT("跳一下"), weT("失败"), weT("发呆"), weT("干活"), weT("完成")];
    const head = document.createElement("div");
    head.textContent = weT("试演动作");
    head.style.cssText = "padding:4px 10px 6px;opacity:0.55;font-size:11px";
    menu.appendChild(head);
    titles.forEach((name, r) => {
      menu.appendChild(buildMenuItem(name, () => {
        walkSpeed = 0; walkLeft = 0;
        setRow(r);
        holdUntil = petNow() + 1600;
        voice.play(r === PET_ROW.fail ? "fail" : r === PET_ROW.done ? "done" : "wave");
        closeMenu();
      }));
    });
    const hr = document.createElement("div");
    hr.style.cssText = "height:1px;margin:6px 0;background:rgba(255,255,255,0.14)";
    menu.appendChild(hr);
    menu.appendChild(buildMenuItem(weT("再大一点"), () => { applyScale(scale + 0.2); closeMenu(); }));
    menu.appendChild(buildMenuItem(weT("再小一点"), () => { applyScale(Math.max(0.5, scale - 0.2)); closeMenu(); }));
    menu.appendChild(buildMenuItem(weT("回右下角"), () => {
      try { localStorage.removeItem("wePetPos"); } catch { /* ignore */ }
      layerEl.style.left = ""; layerEl.style.top = "";
      layerEl.style.right = "24px"; layerEl.style.bottom = "16px";
      closeMenu();
    }));
    menu.appendChild(buildMenuItem(weT("不显示它"), () => {
      // 只隐藏本地这一层；真正的开关在面板里（下一次轮询会被尊重）。
      if (layerEl) layerEl.style.display = "none";
      closeMenu();
    }));
    document.body.appendChild(menu);
    const w = menu.offsetWidth || 160;
    const h = menu.offsetHeight || 320;
    const maxX = (window.innerWidth || 1920) - w - 8;
    const maxY = (window.innerHeight || 1080) - h - 8;
    menu.style.left = Math.max(8, Math.min(maxX, clientX)) + "px";
    menu.style.top = Math.max(8, Math.min(maxY, clientY)) + "px";
  }
  function onContextMenu(e) {
    e.preventDefault();
    openMenu(e.clientX, e.clientY);
  }
  function onDocDown(e) {
    if (menu && !menu.contains(e.target)) closeMenu();
  }
  /** 菜单里的缩放：改本地样式并写回配置（下一次轮询沿用）。 */
  function applyScale(next) {
    const v = Math.max(0.5, Math.min(3, Number(next) || 1));
    try { apiPostJson("/pets/config", { scale: v }, { parse: "always" }); } catch { /* 本地先变 */ }
    scaleCur = v;
    resize();
    draw();
  }

  canvas.addEventListener("contextmenu", onContextMenu);
  if (typeof document !== "undefined" && document.addEventListener) document.addEventListener("pointerdown", onDocDown);
  img.onload = () => { ready = true; resize(); draw(); };
  img.onerror = () => { destroy(); };
  img.src = apiUrl(pet.sheet || "/pets/sheet?v=" + encodeURIComponent(pet.dirId || pet.id));

  canvas.addEventListener("pointerdown", onPointerDown);
  if (typeof window !== "undefined") {
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }
  idleSince = petNow();
  raf = (typeof requestAnimationFrame === "function") ? requestAnimationFrame(tick) : setTimeout(() => tick(petNow()), 60);

  function destroy() {
    dead = true;
    if (typeof clearInterval === "function" && activityTimer !== null) clearInterval(activityTimer);
    activityTimer = null;
    try { voice.destroy(); } catch { /* ignore */ }
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf); else clearTimeout(raf);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("contextmenu", onContextMenu);
    if (typeof document !== "undefined" && document.removeEventListener) document.removeEventListener("pointerdown", onDocDown);
    closeMenu();
    if (typeof window !== "undefined") {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }
  }

  return {
    destroy, setRow, resize,
    /** 外部事件注入（面板操作失败等）：一次性播放失败行并出声。 */
    fail() { setRow(PET_ROW.fail); holdUntil = petNow() + 1600; voice.play("fail"); },
    cheer() { setRow(PET_ROW.done); holdUntil = petNow() + 1600; voice.play("done"); },
    get row() { return row; },
    /** 让下一次随机动作尽快发生（首次出现时用）。 */
    scheduleSoon() { nextActionAt = petNow() + 1200 + Math.random() * 1800; },
  };
}

/**
 * 挂载桌宠层。返回卸载函数（无宠物 / 未启用时返回 null）。
 *
 * 它自己拉 `/folia/pets/list`（配置 + 已装宠物），所以**不依赖面板是否打开过** ——
 * 冷启动就能出宠物。
 */
/** 让刚出现的宠物在 1.2~3 秒后演第一个动作（实例内部按需读 nextActionAt）。 */
function nextActionSoon(instance) {
  try { if (instance && typeof instance.scheduleSoon === "function") instance.scheduleSoon(); } catch { /* ignore */ }
}

function mountPetLayer() {
  if (typeof document === "undefined" || !document.body) return null;
  let disposed = false;
  let instance = null;
  let layerEl = null;
  /** 当前实例对应的「宠物@大小」；变了就要销毁重建。 */
  let currentKey = "";

  function teardownDom() {
    if (instance) { try { instance.destroy(); } catch { /* ignore */ } instance = null; }
    if (layerEl && layerEl.parentNode) layerEl.parentNode.removeChild(layerEl);
    layerEl = null;
    currentKey = "";
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
    const key = String(pet.dirId || pet.id) + "@" + scale;
    // 换宠物 / 改大小 ⇒ **必须重建**：旧实例的贴图与几何都是上一只的。
    // （实测踩过：只在首次创建，于是点「使用」换了宠物而屏幕没变 —— 就是这里。）
    if (layerEl && currentKey === key) { layerEl.style.display = ""; return; }
    teardownDom();
    currentKey = key;

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
    instance = createPetLayer(layerEl, canvas, pet, scale, cfg);
    // 首次出现时排一个随机动作，别一上来就傻站着。
    nextActionSoon(instance);
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

// 仅供单测驱动（构建期内联时会剥掉 export，不影响产物）。
export { createPetLayer, mountPetLayer, petActivityProbe };
