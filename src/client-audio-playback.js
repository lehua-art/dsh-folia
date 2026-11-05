/** 客户端的音频 / 播放桥助手（从 `src/client.js` 按族搬出，函数体逐字未改）。
 *
 * 契约：
 *   1) 本文件不 import —— 构建期由 scripts/build-client.mjs 内联在正文之前，与正文同处一个扁平作用域；
 *      函数体引用的 selection / clampNum / layerEl 等自由名由正文与其它内联模块提供。
 *   2) 搬移只改了"声明住哪"：本段文本与拆前 src/client.js 逐字节相同。
 *   3) 顶层状态（rotationAudioGate、sceneAudioEl、LAYER_KEY_FIELDS）初始化式只有字面量，
 *      两个 `let` 的赋值点都在本文件内；LAYER_KEY_FIELDS 只被层 key 比对读取。
 *   4) 音频闸的开关时机由正文的轮换流程决定：本文件只提供判定与写入函数，不在顶层执行动作。
 */
// 把期望音量写到元素上。muted 与 volume 必须成对设置：只设 volume=0 时部分
// 浏览器仍会在 seek/换源后出声，而只设 muted 会让音量滑块看起来没生效。
// 轮换音频闸生效期间，闸内（= 正在淡入的新层）元素一律按 0 处理，见下方
// openRotationAudioGate。
function weApplyAudio(video) {
  if (!video) return;
  const v = isAudioGated(video) ? 0 : weAudioVolume();
  try {
    video.volume = v;
    video.muted = v <= 0;
  } catch { /* ignore */ }
}

// ── 轮换音频闸：BGM 等上一张完全退场后再起播 ─────────────────────────────
// 交叉渐变期间两层同时挂在 DOM 上，且旧层刻意保持播放（真交叉淡化）。若新层
// 立刻带音量起播，两层 BGM 会重叠整整 1.8s。这里在提交瞬间把**新层**所有音源
// 压到 0（<video>/<audio> 走 weApplyAudio 的闸判定，live iframe 走
// __wp.setVolume(0)，场景包 BGM 走 rotationAudioHold 只准备不播），等这次渐变
// 对应的旧层被移除（渐变结束）后再恢复：旧层音频在其可见期内照常出声，新层
// 音频严格晚于旧层退场。若用户在渐变中改音量，恢复时读的是最新值。
let rotationAudioGate = null; // { node, outgoing, released }
function rotationAudioHoldActive() {
  return Boolean(rotationAudioGate && !rotationAudioGate.released);
}
// 元素是否落在「正在淡入的新层」里（闸内 → 音量按 0）。
function isAudioGated(el) {
  const gate = rotationAudioGate;
  if (!gate || gate.released || !el || !gate.node) return false;
  try { return gate.node === el || (typeof gate.node.contains === "function" && gate.node.contains(el)); } catch { return false; }
}
function layerMediaEls(node) {
  if (!node || typeof node.querySelectorAll !== "function") return [];
  try { return Array.prototype.slice.call(node.querySelectorAll("video, audio")); } catch { return []; }
}
function muteNodeAudio(node) {
  for (const el of layerMediaEls(node)) {
    try { el.volume = 0; el.muted = true; } catch { /* ignore */ }
  }
}
function liveFrameOf(node) {
  try {
    return (node && typeof node.querySelector === "function") ? node.querySelector("iframe.we-live-iframe") : null;
  } catch { return null; }
}
function setLiveVolumeNow(frame, volume) {
  if (!frame) return false;
  try {
    const wp = frame.contentWindow && frame.contentWindow.__wp;
    if (!wp || typeof wp.setVolume !== "function") return false;
    wp.setVolume(volume);
    liveApplied.volume = volume; // 同步缓存：心跳 tick 不会再把旧值刷回去
    return true;
  } catch { return false; }
}
// 恢复（= 旧层已退场）：新层音源按当前设置出声，场景包 BGM 此刻才起播。
function restoreNodeAudio(node) {
  // isConnected 只在**明确**为 false（已被替换/移除）时跳过：测试 mock 无此属性。
  if (node && node.isConnected !== false) {
    for (const el of layerMediaEls(node)) weApplyAudio(el);
    const live = liveFrameOf(node);
    if (live) { liveApplied.volume = null; applyLiveControls(live); }
  }
  // 场景包 BGM 的元素挂在 body 上（不在层内），它由 hold 标记压住 → 这里放行。
  try { syncSceneAudio(selection); } catch { /* ignore */ }
}
// 这次渐变的旧层退场了 → 放行新层音频。outgoingNode 不匹配说明闸属于别的
// 渐变（快速连切），交给对应那次。
function releaseRotationAudioGateFor(outgoingNode) {
  const gate = rotationAudioGate;
  if (!gate || gate.released) return;
  if (gate.outgoing !== outgoingNode) return;
  gate.released = true;
  rotationAudioGate = null;
  restoreNodeAudio(gate.node);
}
// 强制放行（手动切换 / 卸载）：不再等渐变，闸内层若已不在 DOM 上则只清闸。
function releaseRotationAudioGate() {
  const gate = rotationAudioGate;
  if (!gate) return;
  gate.released = true;
  rotationAudioGate = null;
  restoreNodeAudio(gate.node);
}

// ── 场景包内独立音频（scene-audio）────────────────────────────────────────
// 长安雪等场景把 BGM/音效以独立音频文件（mp3/ogg…）放在 scene.pkg 里，由 WE
// 运行时的音频组件播放；静帧路径**没有播放器**，不补这一步就是无声。这里用独立
// <audio> 元素补上：宿主 /scene-audio 路由抽出音频（最大者当 BGM），音量与
// 总开关复用视频壁纸同一套设置（默认 0 = 静音）。
// 与 sceneVideo 互斥：有内嵌 MP4 时视频自带音轨，避免双声道叠加。
let sceneAudioEl = null;
// 场景包 BGM 的 <audio> 拆机（禁用插件 / 切到无音频形态 / 卸载都要走这里）。
function stopSceneAudioEl() {
  if (!sceneAudioEl) return;
  try {
    sceneAudioEl.pause();
    sceneAudioEl.removeAttribute("src");
    sceneAudioEl.load();
    sceneAudioEl.remove();
  } catch { /* ignore */ }
  sceneAudioEl = null;
}
function syncSceneAudio(selLike) {
  const wantUrl = (selLike && selLike.type === "scene" && selLike.sceneAudioUrl
    && !selLike.sceneVideo
    // live 渲染心跳已过 → 包内音频由 WebWallGL 音频组件自播（音量走
    // __wp.setVolume），外置 <audio> 不启动，避免双声道叠加。
    && !selLike.sceneLiveActive)
    ? selLike.sceneAudioUrl : null;
  if (!wantUrl) {
    stopSceneAudioEl();
    return;
  }
  if (!sceneAudioEl) {
    sceneAudioEl = document.createElement("audio");
    sceneAudioEl.loop = true;
    sceneAudioEl.preload = "auto";
    sceneAudioEl.setAttribute("aria-hidden", "true");
    try { document.body.appendChild(sceneAudioEl); } catch { sceneAudioEl = null; return; }
  }
  weApplyAudio(sceneAudioEl);
  if (sceneAudioEl.getAttribute("data-src") !== wantUrl) {
    sceneAudioEl.setAttribute("data-src", wantUrl);
    sceneAudioEl.src = wantUrl;
    weApplyAudio(sceneAudioEl);
  }
  // 轮换音频闸：渐变期间新层的场景 BGM 只装好音源、不播 —— 旧层完全退场后
  // 由 releaseRotationAudioGateFor → syncSceneAudio 放行起播。
  if (rotationAudioHoldActive()) {
    try { sceneAudioEl.volume = 0; sceneAudioEl.muted = true; sceneAudioEl.pause(); } catch { /* ignore */ }
    return;
  }
  if (weAudioVolume() > 0) {
    const p = sceneAudioEl.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* 自动播放被拦：用户点音乐开时再播 */ });
  } else {
    try { sceneAudioEl.pause(); } catch { /* ignore */ }
  }
}

/** 在屏那个元素才是"当前这一张"；旧元素被新切换取代后，它的 AbortError 直接忽略。 */
function isCurrentVideoEl(video) {
  try {
    const cur = typeof onScreenVideo === "function" ? onScreenVideo(null) : null;
    if (cur && cur !== video) return false;
  } catch { /* 没有该助手（单测/旧宿主）：按当前元素处理 */ }
  return true;
}
/** 成功一次就清掉拒绝/重试标记（下一轮（用户点播放 / 换源）重新给机会）。 */
function clearPlayRefusal(video) {
  try {
    if (video && video.dataset) {
      delete video.dataset.wePlayRefused;
      delete video.dataset.wePlayAbortRetried;
    }
  } catch { /* ignore */ }
}
/**
 * play() 失败后的**分类 + 重试**（4.23.22）。
 *
 * 用户截图里的「原神 纳西妲」：H.264 2524×1080、**没有音轨**，却显示"浏览器拒绝了
 * 播放请求"。这不是 NotAllowedError（不是自动播放策略），而是快速切换/换源时 play()
 * 被新的 load() 打断的 **AbortError**。旧实现把所有非 AbortError 一律翻译成同一句，
 * 于是瞬时失败被永久显示成"真拒绝"。
 *
 * 分类表（name → 动作）：
 *   · AbortError      ⇒ 旧元素忽略；当前元素重新 load 后**静默重试一次**，不显示错误；
 *   · NotAllowedError ⇒ 置 muted 再 play（自动播放策略的标准解法）；仍失败才提示；
 *   · NotSupportedError / 其它 ⇒ 记 name，由 `playRefusalMessage` 分类显示。
 */
function recoverPlayFailure(video, err, retried) {
  const name = String((err && err.name) || "");
  if (name === "AbortError") {
    clearPlayRefusal(video);
    // 快速切换：旧元素的 play() 被新 load 打断 —— 它已经不在屏上了，忽略，不重试。
    if (!isCurrentVideoEl(video)) { syncVideoState(video); return; }
    // 同一元素只重新 load 一次，避免 canplay ↔ play 的无限循环。
    if (retried || (video.dataset && video.dataset.wePlayAbortRetried === "1")) {
      syncVideoState(video);
      return;
    }
    try { if (video.dataset) video.dataset.wePlayAbortRetried = "1"; } catch { /* ignore */ }
    try { if (typeof video.load === "function") video.load(); } catch { /* ignore */ }
    let p;
    try { p = video.play(); } catch { p = null; }
    if (p && typeof p.then === "function") {
      p.then(() => { clearPlayRefusal(video); weApplyAudio(video); syncVideoState(video); },
        (again) => recoverPlayFailure(video, again, true));
    } else {
      syncVideoState(video);
    }
    return;
  }
  if (name === "NotAllowedError" && !retried) {
    // 自动播放被拒：先确保 muted=true 再试一次；成功就静默恢复（不打扰用户）。
    try { video.muted = true; } catch { /* ignore */ }
    let p;
    try { p = video.play(); } catch { p = null; }
    if (p && typeof p.then === "function") {
      p.then(() => { clearPlayRefusal(video); weApplyAudio(video); syncVideoState(video); },
        (again) => {
          const againName = String((again && again.name) || name);
          if (againName === "AbortError") { recoverPlayFailure(video, again, true); return; }
          if (video.dataset) video.dataset.wePlayRefused = againName || name;
          syncVideoState(video);
        });
    } else {
      if (video.dataset) video.dataset.wePlayRefused = name;
      syncVideoState(video);
    }
    return;
  }
  if (video.dataset) video.dataset.wePlayRefused = name || "1";
  syncVideoState(video);
}

function applyVideoPlayback(video) {
  if (!video) return;
  watchVideoState(video);
  weApplyAudio(video);
  if (!isEffectivelyPlaying()) {
    try { video.pause(); } catch { /* ignore */ }
    syncVideoState(video);
    return;
  }
  if (!video.paused && !video.ended && !video.error) { syncVideoState(video); return; }
  if (playRefusalBlocks(video)) { syncVideoState(video); return; } // 等用户显式重试（AbortError 不算）
  let p;
  try { p = video.play(); } catch { p = null; }
  if (!p || typeof p.then !== "function") { syncVideoState(video); return; }
  p.then(
    () => {
      clearPlayRefusal(video);
      weApplyAudio(video);
      syncVideoState(video);
    },
    (err) => { recoverPlayFailure(video, err, false); },
  );
}

// ── 源元数据 + 抽帧转码（抽帧转码 / 帧率上限）────────────────────────────────
// 这一族的实现住在 **`src/video-layer.js`**（探测 → 决策 → 进度轮询 → 落地/回退；
// 构建期内联回本作用域，调用点无需改动）。它拥有 `selection.mediaInfo` / `transcodeState` /
// `transcodeProgress` 三个字段的写入权；依赖清点、入口与不变量见该文件头。
function codecLabel(codec) {
  return { avc1: "H.264", hvc1: "H.265", hev1: "H.265", av01: "AV1", vp09: "VP9", mp4v: "MPEG-4" }[codec] || codec;
}

// 层 key 分段名（wantKey 的拼装顺序，见下）：重建时只报变化的那几段，避免把整条
// 带 scene 令牌的 URL 打进日志 —— 「为什么会重建（重建 = 渲染页冷启动）」必须能答。
const LAYER_KEY_FIELDS = ["type", "url", "edge", "sceneVideo", "audio", "live"];
function keySegBrief(v) {
  const t = String(v == null ? "" : v);
  return t ? (t.length > 46 ? "…" + t.slice(-44) : t) : "∅";
}
