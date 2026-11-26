/**
 * pet-chat.js — 桌宠语音助手（P1：语音输入 + 朗读 + 头顶气泡 + 主动搭话）。
 *
 * 交互：点桌宠 = 唤醒 → 录音（说完自动停）→ 转写 → SSE 回答 → 按句朗读
 *       （气泡逐句字幕 + “说”态波形）；说话/点击/打字都先打断当前朗读。
 * 没有聊天窗口：无输入框、无历史列表、无开关按钮。
 */
const PET_CHAT_PRESET_LINES = {
  greeting: [
    '我在呢。',
    '叫我就来。',
    '嗯？我在听。',
    '你回来啦。',
    '有我在，别急。',
    '今天想聊点什么？',
  ],
  wallpaper: [
    '要不要换张壁纸？',
    '这张看久了，换一张吧。',
    '桌面有点暗，换个亮一点的？',
    '轮播开着，让它自己换吧。',
    '我给你挑一张安静的。',
    '这张当壁纸挺合适。',
    '换张清爽的，眼睛舒服点。',
    '需要我记住你喜欢的风格吗？',
  ],
  company: [
    '我在这儿待着。',
    '忙你的，我不吵。',
    '要喝水吗？我提醒你。',
    '坐久了，起来动一动。',
    '累了就歇会儿。',
    '今天也辛苦了。',
    '我陪着你。',
    '慢慢来，不急。',
  ],
  fallback: [
    '这个我还不会，等我学学。',
    '没听清，再说一次？',
    '换个说法试试？',
    '我先记下来。',
    '这个得你来定。',
  ],
  night: [
    '夜深了，早点睡。',
    '我先安静一会儿。',
    '明天见。',
  ],
};

/** 轮流取一句预设台词（分组轮换，避免总说同一组）。 */
let petChatPresetCursor = 0;
const PET_CHAT_PRESET_ORDER = ['greeting', 'wallpaper', 'company', 'fallback', 'night'];
function petChatPresetLine() {
  const group = PET_CHAT_PRESET_LINES[PET_CHAT_PRESET_ORDER[petChatPresetCursor % PET_CHAT_PRESET_ORDER.length]];
  petChatPresetCursor += 1;
  return group[Math.floor(Math.random() * group.length)];
}

/** 头顶气泡实例：锚点取桌宠层矩形，跟随位置与缩放。 */
const petBubble = petBubbleCreate({
  document: typeof document !== 'undefined' ? document : undefined,
  // 跟随桌宠：把宿主环境的 rAF 交给气泡，打开期间每帧按 getAnchor() 重定位
  requestAnimationFrame: typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : undefined,
  cancelAnimationFrame: typeof cancelAnimationFrame === 'function'
    ? (id) => cancelAnimationFrame(id)
    : undefined,
  getAnchor: () => {
    try {
      const layer = document && document.querySelector ? document.querySelector('#we-pet-layer') : null;
      if (!layer || typeof layer.getBoundingClientRect !== 'function') return null;
      const rect = layer.getBoundingClientRect();
      const style = window.getComputedStyle(layer);
      const scale = Number(style.getPropertyValue('--we-pet-scale')) || 1;
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, scale };
    } catch { return null; }
  },
  // 状态条可点：错误/提示 ⇒ 打开打字入口；在听/在想/在说 ⇒ 停止（与再点桌宠同一语义）。
  onStatusClick: () => {
    try {
      const st = petBubble.statusElement && petBubble.statusElement.dataset
        ? String(petBubble.statusElement.dataset.state || '') : '';
      if (st === 'error' || st === 'info') petChatOpenTyping();
      else petVoiceIn.stop();
    } catch { /* 状态条点击是增强 */ }
  },
});

/**
 * 语音模型（SenseVoice）自举：调宿主 /pet-chat/asr（它会 speechToText.prepare），
 * 然后轮询 /pet-chat/asr 把下载进度显示在气泡里。
 * 这样用户装完插件直接说话就行，不需要去 DSH 设置里找「语音输入」开关。
 */
function petAsrEta(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 60) return `约 ${Math.max(1, Math.round(n))} 秒`;
  return `约 ${Math.ceil(n / 60)} 分钟`;
}

/**
 * ASR 自举：POST 只负责触发（立刻返回），随后轮询 `/asr` 显示百分比 + ETA + 重试。
 * 下载完成前点桌宠不会再“看起来没反应”：状态条会一直显示下载进度。
 * @param {() => boolean} [isCancelled] 用户再次点桌宠收起时放弃本轮等待
 */
async function ensureAsrReady(isCancelled) {
  const cancelled = typeof isCancelled === 'function' ? isCancelled : () => false;
  // 假 DOM / 极简环境没有 setTimeout：常驻聆听不能因此抛错（只返回"没准备好"）。
  if (typeof setTimeout !== 'function') return false;
  petBubble.setState('think');
  try {
    await apiPostJson('/pet-chat/asr', {}, { parse: 'always' });
  } catch { /* 触发失败也要继续轮询看状态 */ }
  for (let i = 0; i < 3600; i += 1) {
    if (cancelled()) return false;
    await new Promise((resolve) => { setTimeout(resolve, i === 0 ? 400 : 1200); });
    if (cancelled()) return false;
    const resp = await apiJson('/pet-chat/asr', { parse: 'always' }).catch(() => null);
    const doc = (resp && resp.data) || {};
    if (doc.ready) {
      petBubble.status('info', '语音准备好了', { delay: 1500 });
      return true;
    }
    if (doc.available === false) {
      petBubble.status('error', '这个 DSH 版本没有语音转写服务，先打字吧', { delay: 5000 });
      return false;
    }
    if (doc.phase === 'failed') {
      const why = String(doc.lastError || doc.message || '下载失败').slice(0, 80);
      petBubble.status('error', `语音模型下载失败：${why} · 点桌宠重试`, { delay: 8000 });
      return false;
    }
    const pct = doc.totalBytes > 0 && doc.completedBytes >= 0
      ? Math.max(0, Math.min(100, Math.round((doc.completedBytes / doc.totalBytes) * 100)))
      : null;
    const eta = petAsrEta(doc.etaSeconds);
    const attempt = Number(doc.attempt) > 0 && Number(doc.retries) > 1
      ? ` · 第 ${Number(doc.attempt)}/${Number(doc.retries)} 次`
      : '';
    let line;
    if (doc.phase === 'downloading' && pct !== null) {
      line = `正在准备语音识别 ${pct}%${eta ? ' · ' + eta : ''}${attempt}`;
    } else if (doc.phase === 'loading') {
      line = '正在准备语音识别…';
    } else {
      line = '正在准备语音识别…';
    }
    if (doc.retryAt && Number(doc.retryAt) > Date.now()) {
      line = '下载中断，正在自动重试…' + (pct !== null ? `（${pct}%）` : '');
    }
    petBubble.status('info', line, { delay: 0 });
  }
  petBubble.status('info', '语音模型还没下完，过一会儿再点我', { delay: 5000 });
  return false;
}

/**
 * 朗读配置（P1）：`/pet-chat/state` 的 voice 字段。
 *
 * 懒加载：挂载时与每次唤醒时各刷一次（设置面板改完立刻生效，不用重启）。
 * 读不到就保持“不静音”，宁可多念一句，也不要让用户以为朗读坏了。
 */
let petChatVoice = { name: '', muted: false, rate: 0, continuous: true, listenPaused: false };
/** pre.65：本轮输入方式决定长度策略（语音 1–3 句；文字可长）。 */
let petChatInputMode = 'text';
/** 当前 active persona（只用于提示/排障；宿主以 index.active 为准，避免切换后发旧 id）。 */
let petChatPersonaId = '';
async function petChatRefreshVoice() {
  try {
    const resp = await apiJson('/pet-chat/state', { parse: 'always' });
    const doc = (resp && resp.data) || {};
    if (doc.persona && doc.persona.id) petChatPersonaId = String(doc.persona.id);
    petChatModelReady = doc.modelReady === true;
    if (doc.voice && typeof doc.voice === 'object') {
      petChatVoice = {
        name: String(doc.voice.name || ''),
        muted: doc.voice.muted === true,
        rate: Number.isFinite(Number(doc.voice.rate)) ? Number(doc.voice.rate) : 0,
        continuous: doc.voice.continuous !== false,
        listenPaused: doc.voice.listenPaused === true,
      };
    }
  } catch { /* 读不到就用默认（不静音） */ }
  // 「暂停说话 / 暂停聆听」都是持久开关：设置页/右键改完立刻生效。
  petChatSpeakPaused = petChatVoice.muted === true;
  petChatContinuousEnabled = true;
  petChatContinuousPaused = petChatVoice.listenPaused === true;
  petBubble.setVoiceFlags({ speakPaused: petChatSpeakPaused, listenPaused: petChatContinuousPaused });
  petChatPublishContinuousState();
  return petChatVoice;
}

/* ── 常驻聆听（任务 §4）：装好就在听；半双工；「暂停说话 / 暂停聆听」两个开关 ── *
 *
 * 状态机：idle → listening → thinking → speaking → listening（循环）
 *   · 挂载后自动进入 listening（受持久化的「暂停聆听」约束）；
 *   · 朗读开始时**绝不录音**（半双工，避免听到自己）；播完 150ms 自动恢复听；
 *   · 「暂停说话」只静音 TTS，继续听 + 头顶出字幕；
 *   · 麦克风被占用/权限失败 ⇒ 退出常驻聆听并明确提示（不静默）。
 */
const PET_CHAT_LISTEN_RESUME_MS = 150;
/** 连续 60 秒没听到人声 ⇒ 探听降频到每 2 秒一次（但仍算"在听"）。 */
const PET_CHAT_QUIET_AFTER_MS = 60000;
const PET_CHAT_QUIET_PROBE_MS = 2000;
const PET_CHAT_SILENT_PROMPT_EVERY = 3;
let petChatContinuousEnabled = true;
let petChatContinuousActive = false;
let petChatContinuousPaused = false;
let petChatContinuousRounds = 0;
let petChatContinuousSilent = 0;
let petChatContinuousTimer = null;
let petChatVoiceAbort = false;
/** 暂停说话（= voice.muted）：不出声，但继续听、继续出字幕。 */
let petChatSpeakPaused = false;
let petChatLastHeardAt = Date.now();
let petChatListeningNow = false;
/** 模型是否就绪（enabled + 有 Key/本机模型）：不满足时**不开麦**，先提示填 Key。 */
let petChatModelReady = false;

function petChatContinuousClearTimer() {
  if (petChatContinuousTimer != null) {
    clearTimeout(petChatContinuousTimer);
    petChatContinuousTimer = null;
  }
}

/** 把常驻聆听 / 暂停说话的状态推给右键菜单（pet-layer 监听）。 */
function petChatPublishContinuousState() {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent('we-pet-continuous-state', {
      detail: {
        enabled: petChatContinuousEnabled === true,
        active: petChatContinuousActive === true,
        paused: petChatContinuousPaused === true,
        rounds: petChatContinuousRounds,
      },
    }));
    window.dispatchEvent(new CustomEvent('we-pet-voice-state', {
      detail: {
        speakPaused: petChatSpeakPaused === true,
        listenPaused: petChatContinuousPaused === true,
        listening: petChatListeningNow === true,
        speaking: (() => { try { return petTts.isSpeaking(); } catch { return false; } })(),
      },
    }));
  } catch { /* 右键菜单是增强，事件失败不影响对话 */ }
}

function petChatContinuousStart() {
  if (petChatContinuousEnabled !== true) return false;
  petChatContinuousClearTimer();
  petChatContinuousActive = true;
  petChatContinuousPaused = false;
  petBubble.setContinuous(true);
  petChatPublishContinuousState();
  return true;
}

/** 停止常驻聆听（暂停聆听 / 页面隐藏 / 麦克风失败时调用）。 */
function petChatContinuousStop(reason, silent) {
  petChatContinuousClearTimer();
  petChatContinuousActive = false;
  petChatContinuousPaused = true;
  petChatContinuousRounds = 0;
  petChatContinuousSilent = 0;
  petChatListeningNow = false;
  petBubble.setContinuous(false);
  petChatPublishContinuousState();
  if (reason && silent !== true) petBubble.status('info', reason, { delay: 3500 });
}

/** 右键「暂停聆听」：立即停麦 + 停掉自动续听，并持久化（重启后仍暂停）。 */
function petChatContinuousPause(reason) {
  petChatVoiceAbort = true;
  try { petVoiceIn.stop(); } catch { /* ignore */ }
  petChatContinuousStop(reason || weT('⏸ 麦克风已暂停（右键「继续聆听」恢复）'), false);
  petBubble.status('info', weT('🎤 麦克风已暂停'), { delay: 3000 });
  void petChatPersistListenPaused(true);
  return true;
}

/** 右键「继续聆听」：恢复常驻聆听，并立刻听下一轮（不用再点桌宠）。 */
function petChatContinuousResume() {
  petChatVoiceAbort = false;
  petChatContinuousEnabled = true;
  petChatContinuousPaused = false;
  // 「恢复后立刻可听」：把最近人声时间拉回现在，不再套用 60s 静默后的 2s 探听节奏。
  petChatLastHeardAt = Date.now();
  petChatContinuousStart();
  void petChatPersistListenPaused(false);
  petChatContinuousArm(120);
  return true;
}

/** 存「暂停聆听」到 voice.listenPaused（宿主持久化；重启后沿用）。 */
async function petChatPersistListenPaused(paused) {
  try {
    await apiPostJson('/pet-chat/voice/config', { listenPaused: paused === true }, { parse: 'always' });
  } catch { /* 设置页下次保存会再写 */ }
}

/** 暂停说话：静音 TTS（继续听 + 出字幕）。 */
function petChatSetSpeakPaused(paused) {
  const next = paused === true;
  petChatSpeakPaused = next;
  petChatVoice.muted = next;
  if (next) petSpeakStop();
  petBubble.setVoiceFlags({ speakPaused: next, listenPaused: petChatContinuousPaused });
  petBubble.status('info', next ? weT('🔇 仅文字（继续听，不出声）') : weT('🔊 声音已恢复'), { delay: 2600 });
  petChatPublishContinuousState();
  try {
    void apiPostJson('/pet-chat/voice/config', { muted: next }, { parse: 'always' });
  } catch { /* ignore */ }
  return next;
}

/** 暂停聆听：关麦（不再自动开麦），保留"暂停说话"。 */
function petChatSetListenPaused(paused) {
  const next = paused === true;
  if (next) petChatContinuousPause();
  else petChatContinuousResume();
  petBubble.setVoiceFlags({ speakPaused: petChatSpeakPaused, listenPaused: next });
  return next;
}

/** 右键菜单事件：toggle / pause / resume（旧协议）+ speak-pause / listen-pause（v3）。 */
function petChatOnContinuousCommand(event) {
  const action = String((event && event.detail && event.detail.action) || '');
  if (action === 'toggle') petChatSetListenPaused(!petChatContinuousPaused);
  else if (action === 'set') petChatSetListenPaused(event.detail.enabled !== true);
  else if (action === 'pause') petChatSetListenPaused(true);
  else if (action === 'resume') petChatSetListenPaused(false);
  else if (action === 'speak-pause') petChatSetSpeakPaused(!petChatSpeakPaused);
  else if (action === 'speak-set') petChatSetSpeakPaused(event.detail.paused === true);
}

/** 静默累计到一定轮次才提示一次，不因为安静就退出常驻聆听。 */
function petChatSilenceDelay(delayMs) {
  const quietFor = Date.now() - petChatLastHeardAt;
  if (quietFor >= PET_CHAT_QUIET_AFTER_MS) return PET_CHAT_QUIET_PROBE_MS;
  return Math.max(PET_CHAT_LISTEN_RESUME_MS, Number(delayMs) || PET_CHAT_LISTEN_RESUME_MS);
}

/** 朗读结束 / 一次静默后，延迟 150ms 自动开麦（半双工：播完才听）。 */
function petChatContinuousArm(delayMs) {
  if (!petChatContinuousEnabled || !petChatContinuousActive || petChatContinuousPaused) return;
  petChatContinuousClearTimer();
  petChatShowContinuousListening();
  const waitMs = petChatSilenceDelay(delayMs);
  petChatContinuousTimer = setTimeout(() => {
    petChatContinuousTimer = null;
    if (!petChatContinuousEnabled || !petChatContinuousActive || petChatContinuousPaused) return;
    // 半双工硬约束：正在朗读时**绝不开麦**（等 onIdle 再排下一拍）。
    try { if (petTts.isSpeaking()) return; } catch { /* 实例未就绪时照常开麦 */ }
    petChatVoiceAbort = false;
    petChatListeningNow = true;
    petChatPublishContinuousState();
    void petVoiceIn.start();
  }, waitMs);
}

/**
 * 一次语音轮次失败：静默类（没听到/太小声）继续听，设备类错误退出常驻聆听并提示。
 */
function petChatContinuousVoiceError(code) {
  if (!petChatContinuousActive || petChatContinuousPaused) return;
  const silent = ['no-speech', 'unclear', 'too-quiet'].includes(String(code || ''));
  if (!silent) {
    // 麦克风被占用 / 权限失败：退出常驻聆听（不静默），并把提示留在状态条。
    petChatContinuousStop(weT('常驻聆听已暂停：{e}（右键「继续聆听」重试）', { e: code || '麦克风不可用' }));
    void petChatPersistListenPaused(true);
    return;
  }
  petChatContinuousSilent += 1;
  petChatContinuousRounds += 1;
  if (petChatContinuousSilent % PET_CHAT_SILENT_PROMPT_EVERY === 0) {
    petBubble.status('info', weT('还在听（没听到人声，{n} 次）', { n: petChatContinuousSilent }), { delay: 1600 });
  }
  petChatContinuousArm(PET_CHAT_LISTEN_RESUME_MS);
}

/* ── v2 大脑（前端侧）：情绪语速 / 环境快照 / 动作回执 / 主动触发 ─────────── */

/** 本轮回答的语速覆盖（宿主 meta 事件给 -1 = 夜间/疲惫 -10%）。 */
let petChatSpeechRate = 0;
/** 上一轮情绪（排障/测试可读；不参与 UI）。 */
let petChatMood = 'neutral';
/** 一轮对话进行中：主动搭话不得插嘴（模型在生成、气泡在更新）。 */
let petChatTurnBusy = false;
let petChatTurnBusyTimer = null;
/** 壁纸变化观察：id / 变化时刻 / 标题。 */
let petChatWallpaperId = '';
let petChatWallpaperChangedAt = 0;
let petChatWallpaperPendingTitle = '';
let petChatWallpaperTimer = null;
/** 连续工作：第一次用户消息 / 最近一条 / 今天是否已提醒。 */
let petChatWorkStart = 0;
let petChatWorkLastAt = 0;
let petChatWorkNotifiedDay = '';
let petChatWorkTimer = null;
let petChatGreetingTimer = null;

function petChatDayKey(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function petChatTurnBegin() {
  petChatTurnBusy = true;
  if (petChatTurnBusyTimer != null) clearTimeout(petChatTurnBusyTimer);
  // 兜底：任何异常路径都不该永久把主动搭话挡住
  petChatTurnBusyTimer = setTimeout(() => { petChatTurnBusy = false; petChatTurnBusyTimer = null; }, 30000);
}

function petChatTurnEnd() {
  petChatTurnBusy = false;
  if (petChatTurnBusyTimer != null) { clearTimeout(petChatTurnBusyTimer); petChatTurnBusyTimer = null; }
}

/** 现在能不能主动说一句：朗读中 / 录音中 / 一轮回答中 / 页面隐藏都不插嘴。 */
function petChatProactiveAllowed() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  if (petChatTurnBusy) return false;
  try { if (petTts.isSpeaking()) return false; } catch { /* 实例尚未就绪时按可说话处理 */ }
  try { if (petVoiceIn.isActive && petVoiceIn.isActive()) return false; } catch { /* ignore */ }
  return true;
}

/** 宿主主动 tick：命中就念一句（事件触发 / 早晚问候共用）。 */
async function petChatProactiveTick(event, extra) {
  if (!petChatProactiveAllowed()) return null;
  let speaking = false;
  let listening = false;
  try { speaking = petTts.isSpeaking(); } catch { speaking = false; }
  try { listening = Boolean(petVoiceIn.isActive && petVoiceIn.isActive()); } catch { listening = false; }
  try {
    const resp = await apiPostJson('/pet-chat/proactive/tick', {
      event,
      ...(extra || {}),
      speaking,
      listening,
    }, { parse: 'always' });
    const doc = (resp && resp.data) || {};
    if (!doc.ok || !doc.line) return null;
    petChatSay(String(doc.line));
    return String(doc.line);
  } catch {
    return null;
  }
}

/** 当前壁纸（前端 selection 是唯一真源；拿不到就返回空）。 */
function petChatCurrentWallpaper() {
  try {
    const id = String((typeof selection !== 'undefined' && selection && selection.id) || '');
    const list = (typeof selection !== 'undefined' && selection && selection.inventory
      && Array.isArray(selection.inventory.wallpapers)) ? selection.inventory.wallpapers : [];
    const hit = list.find((item) => item && String(item.id) === id) || null;
    return { id, title: String((hit && hit.title) || '') };
  } catch {
    return { id: '', title: '' };
  }
}

/** 环境快照：壁纸名 + 正在播放（音量/桌宠由宿主读自己的配置）。 */
async function petChatEnvSnapshot() {
  const wallpaper = petChatCurrentWallpaper();
  let playing = null;
  try {
    const resp = await Promise.race([
      apiJson('/now-playing', { parse: 'always' }),
      new Promise((resolve) => { setTimeout(() => resolve(null), 700); }),
    ]);
    const media = resp && resp.data && resp.data.media ? resp.data.media : null;
    if (media && media.title) playing = { title: media.title, artist: media.artist || '' };
  } catch { /* 没在播放 / 媒体桥没起：宿主环境行会写“无” */ }
  return { wallpaper, playing };
}

function petChatLuminance(item) {
  const color = String((item && item.schemeColor) || '').replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(color)) {
    const r = parseInt(color.slice(0, 2), 16);
    const g = parseInt(color.slice(2, 4), 16);
    const b = parseInt(color.slice(4, 6), 16);
    return r * 0.299 + g * 0.587 + b * 0.114;
  }
  return 999;
}

function petChatIsDarkWallpaper(item) {
  return petChatLuminance(item) < 105 || /暗|黑|夜|深色|dark/i.test(String((item && item.title) || ''));
}

/**
 * 客户端执行壁纸动作（宿主只发 action，不重写前端的 `applySelection`）。
 * 失败返回 `{ok:false,error}`，由宿主统一说人话 —— 这里只负责把真实结果回执回去。
 */
async function petChatApplyAction(tool, args) {
  if (tool === 'wallpaper_volume') {
    // 任务 §6② volume_set(target=wallpaper)：写壁纸音轨音量并回读 selection.videoVolume。
    const percent = Math.max(0, Math.min(100, Math.round(Number(args && args.percent) || 0)));
    try {
      if (typeof onVideoVolume !== 'function') return { ok: false, error: 'unsupported' };
      onVideoVolume(percent);
    } catch {
      return { ok: false, error: 'apply-failed' };
    }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    const actual = Math.round(Number(selection && selection.videoVolume || 0) * 100);
    if (Math.abs(actual - percent) > 2) return { ok: false, error: 'not-applied', percent: actual };
    return { ok: true, percent: actual, verified: true };
  }
  if (tool === 'wallpaper_cycle') {
    const enabled = !(args && args.enabled === false);
    const before = Boolean(selection && selection.rotationEnabled);
    try {
      onToggleRotation();
    } catch {
      return { ok: false, error: 'apply-failed' };
    }
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    const now = Boolean(selection && selection.rotationEnabled);
    if (now !== enabled) {
      // 状态没切到目标值（例如轮播候选为空被自动关掉）⇒ 如实回执，不谎报成功。
      if (before !== enabled) { try { onToggleRotation(); } catch { /* ignore */ } }
      return { ok: false, error: 'not-applied', enabled: now };
    }
    petBubble.status('info', enabled ? weT('轮播打开了') : weT('轮播关掉了'), { delay: 1800 });
    return { ok: true, enabled: now, rotationEnabled: now };
  }
  if (tool !== 'wallpaper_switch') return { ok: false, error: 'unsupported' };
  const input = args || {};
  let list;
  try {
    list = (selection.inventory && Array.isArray(selection.inventory.wallpapers))
      ? selection.inventory.wallpapers.slice() : [];
  } catch { list = []; }
  if (!list.length) {
    petBubble.status('error', weT('没有可用的壁纸'), { delay: 4000 });
    return { ok: false, error: 'no-wallpaper' };
  }
  const currentId = String((selection && selection.id) || '');
  const playable = list.filter((item) => item && item.playable !== false);
  const pool = playable.length ? playable : list;
  let target;
  const mode = String(input.mode || 'next');
  if (mode === 'byName') {
    const name = String(input.name || '').trim().toLowerCase();
    target = name
      ? list.find((item) => String((item && item.title) || '').toLowerCase().includes(name))
      : null;
    if (!target) {
      petBubble.status('error', weT('没找到叫「{name}」的壁纸', { name: String(input.name || '') }), { delay: 4000 });
      return { ok: false, error: 'no-match' };
    }
  } else if (mode === 'dark') {
    const dark = list.filter((item) => petChatIsDarkWallpaper(item));
    if (dark.length) target = dark[Math.floor(Math.random() * dark.length)];
    else {
      // 没有明确“暗色”的条目 ⇒ 选主题色最暗的那张，而不是随便挑一张亮图。
      const sorted = list.slice().sort((a, b) => petChatLuminance(a) - petChatLuminance(b));
      target = sorted[0] || null;
    }
  } else if (mode === 'random') {
    const source = pool.filter((item) => String(item.id) !== currentId);
    target = (source.length ? source : pool)[Math.floor(Math.random() * (source.length ? source.length : pool.length))];
  } else {
    const index = pool.findIndex((item) => String(item.id) === currentId);
    target = pool[(index >= 0 ? index + 1 : 0) % pool.length];
  }
  if (!target) return { ok: false, error: 'no-target' };
  petBubble.status('info', weT('正在换壁纸…'), { delay: 0 });
  try {
    applySelection(String(target.id), { fromManual: true });
  } catch {
    petBubble.hideStatus(0);
    return { ok: false, error: 'apply-failed' };
  }
  await new Promise((resolve) => { setTimeout(resolve, 700); });
  if (String((selection && selection.id) || '') !== String(target.id)) {
    petBubble.status('error', weT('壁纸切换没生效'), { delay: 4000 });
    return { ok: false, error: 'not-applied', targetId: String(target.id), title: String(target.title || '') };
  }
  petBubble.hideStatus(0);
  return { ok: true, targetId: String(target.id), title: String(target.title || '') };
}

/** SSE action → 执行 → POST 回执。宿主据此**回读设置**再决定说不说成功。 */
async function petChatHandleAction(payload) {  const id = String((payload && payload.id) || '');
  if (!id) return;
  let result;
  try {
    result = await petChatApplyAction(String(payload.tool || ''), payload.args || {});
  } catch {
    result = { ok: false, error: 'action-failed' };
  }
  try {
    await apiPostJson('/pet-chat/tool-result', {
      id,
      ok: result.ok === true,
      targetId: result.targetId || '',
      title: result.title || '',
      percent: Number.isFinite(Number(result.percent)) ? Number(result.percent) : undefined,
      error: result.error || '',
    }, { parse: 'always' });
  } catch { /* 回执失败由宿主超时判失败，不会谎报成功 */ }
}

/* ── v2 权限确认：气泡按钮（与语音说「好」等价）─────────────────────────── */

let petChatConfirmNode = null;

function petChatConfirmHide() {
  if (!petChatConfirmNode) return;
  try { petChatConfirmNode.remove(); } catch { /* ignore */ }
  petChatConfirmNode = null;
}

/**
 * 宿主发来 confirm 事件 → 在桌宠旁显示一行确认条：
 * [允许] [不允许] [以后都允许] [以后都别问]
 * 点击走 POST /pet-chat/tool-confirm；宿主执行完用 /speak 广播结果（本端会朗读）。
 */
function petChatConfirmShow(payload) {
  if (typeof document === 'undefined' || !payload || !payload.id) return;
  petChatConfirmHide();
  const box = document.createElement('div');
  box.id = 'we-pet-tool-confirm';
  box.dataset.tool = String(payload.tool || '');
  Object.assign(box.style, {
    position: 'fixed', left: '50%', bottom: '96px', transform: 'translateX(-50%)',
    zIndex: '2147483000', maxWidth: 'min(560px, calc(100vw - 32px))',
    padding: '10px 12px', borderRadius: '12px', background: 'rgba(22,24,30,.94)',
    border: '1px solid rgba(255,255,255,.18)', boxShadow: '0 10px 30px rgba(0,0,0,.35)',
    color: '#eef1f6', font: '12px/1.5 system-ui, "Segoe UI", sans-serif',
    display: 'flex', flexDirection: 'column', gap: '8px',
  });
  const question = document.createElement('div');
  question.textContent = String(payload.question || weT('要执行这个操作吗？'));
  box.appendChild(question);
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' });
  const finish = async (decision) => {
    petChatConfirmHide();
    try {
      const resp = await apiPostJson('/pet-chat/tool-confirm', { id: payload.id, decision }, { parse: 'always' });
      const data = (resp && resp.data) || {};
      if (data.clientAction) {
        const action = data.clientAction;
        const result = await petChatApplyAction(String(action.tool || ''), action.args || {});
        let say = '';
        if (action.tool === 'wallpaper_cycle') say = result.ok ? (result.enabled ? '轮播打开了。' : '轮播关掉了。') : '轮播没切成功。';
        else if (action.tool === 'wallpaper_volume') say = result.ok ? `壁纸音量调到 ${result.percent}% 了。` : '壁纸音量没调成。';
        else if (result.ok) say = result.title ? `换成「${result.title}」了。` : '换好了。';
        else say = result.error === 'no-match' ? '没找到那张壁纸。' : '没换成，再试一次吧。';
        petBubble.show(say);
        petSpeak(say);
        return;
      }
      if (data.say && decision === 'deny') petBubble.show(String(data.say));
      if (data.say && data.ok === false) petBubble.status('error', String(data.say), { delay: 4000 });
    } catch {
      petBubble.status('error', weT('确认没发出去，再试一次'), { delay: 4000 });
    }
  };
  const button = (label, decision, primary) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    Object.assign(el.style, {
      border: '1px solid ' + (primary ? 'rgba(120,190,255,.65)' : 'rgba(255,255,255,.2)'),
      borderRadius: '8px', padding: '5px 12px', cursor: 'pointer',
      background: primary ? 'rgba(90,160,255,.22)' : 'rgba(255,255,255,.05)',
      color: 'inherit', font: 'inherit',
    });
    el.addEventListener('click', (event) => {
      try { event.preventDefault(); event.stopPropagation(); } catch { /* ignore */ }
      void finish(decision);
    });
    return el;
  };
  const hardConfirm = payload.hardConfirm === true;
  row.appendChild(button(weT('允许'), 'allow', true));
  row.appendChild(button(weT('不允许'), 'deny', false));
  if (!hardConfirm) {
    row.appendChild(button(weT('以后都允许'), 'always', false));
    row.appendChild(button(weT('以后都别问'), 'never', false));
  } else if (question) {
    question.textContent += '（写文件/剪贴板这类操作每次都会确认，避免误操作）';
  }
  box.appendChild(row);
  document.body.appendChild(box);
  petChatConfirmNode = box;
}

/** 每 4 秒看一次壁纸是否变化；变化满 30 秒且不忙时点评一句。 */
function petChatWatchWallpaper() {
  if (typeof setInterval !== 'function') return null;
  const initial = petChatCurrentWallpaper();
  petChatWallpaperId = initial.id;
  return setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const cur = petChatCurrentWallpaper();
    if (!petChatWallpaperId) { petChatWallpaperId = cur.id; return; }
    if (cur.id && cur.id !== petChatWallpaperId) {
      petChatWallpaperId = cur.id;
      petChatWallpaperChangedAt = Date.now();
      petChatWallpaperPendingTitle = cur.title;
    }
    if (!petChatWallpaperChangedAt) return;
    if (Date.now() - petChatWallpaperChangedAt < 30000) return;
    if (!petChatProactiveAllowed()) return; // 正在朗读/录音/回答：等下一拍，不插嘴
    const sinceMs = Date.now() - petChatWallpaperChangedAt;
    petChatWallpaperChangedAt = 0;
    void petChatProactiveTick('wallpaper', { wallpaperTitle: petChatWallpaperPendingTitle, sinceMs });
  }, 4000);
}

/** 连续工作 ≥45 分钟（用户消息累计；10 分钟没消息视为中断）。 */
function petChatWatchWork() {
  if (typeof setInterval !== 'function') return null;
  return setInterval(() => {
    if (!petChatWorkStart) return;
    const now = Date.now();
    if (now - petChatWorkLastAt > 10 * 60 * 1000) { petChatWorkStart = 0; return; }
    if (now - petChatWorkStart < 45 * 60 * 1000) return;
    const day = petChatDayKey(now);
    if (petChatWorkNotifiedDay === day) return;
    if (!petChatProactiveAllowed()) return;
    petChatWorkNotifiedDay = day;
    petChatWorkStart = 0;
    void petChatProactiveTick('work', { activeMinutes: 45 });
  }, 60000);
}

/** 早晚问候：挂载后 3 秒试一次；宿主按 8–10 / 22 点后自行判定，每天只一次。 */
function petChatMaybeGreet() {
  if (typeof setTimeout !== 'function') return null;
  return setTimeout(() => {
    if (!petChatProactiveAllowed()) return;
    void petChatProactiveTick('greeting', {});
    void petChatProactiveTick('night', {});
  }, 3500);
}


/**
 * 朗读实例（P1）：宿主负责合成兜底，这里负责切句、排队、播、停、字幕同步。
 * 回调全部接到气泡：说 → `speak` 态 + 当前句；停/念完 → `idle` + 3 秒后淡出。
 */
const petTts = petTtsCreate({
  // ⚠️ 包一层再传：`api-client.js` 的内联位置在 `pet-chat.js` **之后**，
  // 直接 `apiFetch` / `apiPostJson` 会在模块求值期触发 TDZ
  // （真机/冒烟统一症状：Cannot access 'apiPostJson' before initialization）。
  apiFetch: (path, opts) => apiFetch(path, opts),
  apiPostJson: (path, payload, opts) => apiPostJson(path, payload, opts),
  // v5 §2：包一层 Audio，只为记录"首段音频真正开始播"的时刻（不改播放行为）。
  Audio: typeof Audio === 'function'
    ? function PetChatAudio(url) {
      const audio = new Audio(url);
      try {
        const originalPlay = audio.play;
        audio.play = function patchedPlay(...args) {
          if (!petChatPlayStartAt) petChatPlayStartAt = Date.now();
          return originalPlay.apply(audio, args);
        };
      } catch { /* 播放器不可改写时只是少一段诊断 */ }
      return audio;
    }
    : null,
  URL: typeof URL === 'function' ? URL : null,
  getVoice: () => petChatVoice,
  // 回答气泡只由 SSE 增量维护（完整回答、长文可滚）；逐句朗读只切“说”态，
  // 不再把气泡内容替换成当前一句（否则长回答永远只剩最后一句）。
  onSentence: () => {
    petBubble.setState('speak');
  },
  onState: (kind) => { petBubble.setState(kind); },
  onIdle: () => {
    petBubble.hide(3000);
    petChatListeningNow = false;
    // 播完 150ms 自动恢复听（半双工：朗读期间绝不录音）。
    if (petChatContinuousActive && !petChatContinuousPaused) petChatContinuousArm(PET_CHAT_LISTEN_RESUME_MS);
    petChatPublishContinuousState();
  },
  onVoiceFallback: (actual) => {
    // pre.54（B3④）：宿主回落到本机默认音色时明确提示，不静默换音色。
    petBubble.status('info', actual
      ? weT('所选音色不可用，已自动换用：{name}', { name: actual })
      : weT('所选音色不可用，已自动换用可用音色'), { delay: 5000 });
  },
  onError: (error) => {
    // 失败只进**状态条**（不污染回答气泡、不弹窗）；不静默 —— 用户至少知道为什么没声音
    const hint = (error && error.hint) || '语音没出来';
    petBubble.status('error', hint, { delay: 5000 });
  },
});

/** 对外/对内的“说一句”：按句入队，返回是否真的入队。 */
function petSpeak(text, speech) { return petTts.speak(text, speech); }
/** 立刻停：清队列 + 停当前音频 + 通知宿主作废在途合成（barge-in 用）。 */
function petSpeakStop() { return petTts.stop(); }

/* ── v5 §1：清唱播放 + 逐行歌词高亮 ─────────────────────────────────────── */

let petSingAudio = null;
let petSingTimer = null;
let petSingLines = [];
let petSingIndex = -1;

/** 停掉正在唱的歌（barge-in / 新歌替换 / 卸载）。 */
function petSingStop() {
  if (petSingTimer != null) { clearInterval(petSingTimer); petSingTimer = null; }
  if (petSingAudio) {
    try { petSingAudio.pause(); } catch { /* ignore */ }
    try { petSingAudio.src = ''; } catch { /* ignore */ }
    petSingAudio = null;
  }
  petSingLines = [];
  petSingIndex = -1;
}

/**
 * 播放一首清唱：`sing = { audioUrl, lines:[{text,startMs,durMs}], title, disclaimer }`。
 * 歌词行按 `startMs` 高亮；播完 2 秒收起气泡，并按常驻聆听的节奏恢复听。
 */
function petChatSingPlay(sing) {
  if (!sing || !sing.audioUrl) return false;
  if (typeof Audio !== 'function') return false;
  petSingStop();
  petSpeakStop(); // 唱歌前先停朗读，避免两路音频叠在一起
  petChatConfirmHide();
  const lines = Array.isArray(sing.lines) ? sing.lines : [];
  petSingLines = lines;
  petSingIndex = -1;
  petBubble.setVoiceFlags({ speakPaused: petChatSpeakPaused, listenPaused: petChatContinuousPaused });
  petBubble.setState('sing');
  petBubble.showLyrics(lines, 0, { title: sing.title, disclaimer: sing.disclaimer });
  try {
    const audio = new Audio(apiUrl(String(sing.audioUrl)));
    petSingAudio = audio;
    const tick = () => {
      const nowMs = Number(audio.currentTime || 0) * 1000;
      let active = 0;
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].startMs <= nowMs + 40) active = i;
        else break;
      }
      if (active !== petSingIndex) {
        petSingIndex = active;
        petBubble.showLyrics(lines, active);
      }
    };
    petSingTimer = setInterval(tick, 120);
    audio.addEventListener('ended', () => {
      petSingStop();
      petBubble.status('info', weT('唱完啦（清唱，无伴奏）'), { delay: 2600 });
      petBubble.hide(2000);
      petChatSingResumeListening();
    });
    audio.addEventListener('error', () => {
      petSingStop();
      petBubble.status('error', weT('这首歌的音频放不出来（文件坏了或播放器不可用）'), { delay: 5000 });
      petChatSingResumeListening();
    });
    const played = audio.play();
    if (played && typeof played.catch === 'function') {
      played.catch(() => {
        petSingStop();
        petBubble.status('info', weT('浏览器拦了自动播放：再点一次「唱首歌」'), { delay: 4000 });
      });
    }
    return true;
  } catch {
    petBubble.status('error', weT('唱歌音频没放起来'), { delay: 4000 });
    return false;
  }
}

/** 唱完回到常驻聆听（150ms，任务 §2：轮间不重开设备，只重启录音循环）。 */
function petChatSingResumeListening() {
  if (petChatContinuousEnabled && !petChatContinuousPaused) petChatContinuousArm(150);
}

/* ── v5 §2：延迟 6 段采样（说完/录音完/ASR/首 token/首段音频/出声）────────── */

let petChatVoiceTiming = null;
let petChatPlayStartAt = 0;
let petChatDeepTimer = null;

/** 一次语音轮次结束后把 6 段耗时上报宿主（失败静默，不影响对话）。 */
function petChatReportLatency(turnStartAt, firstTokenAt, firstAudioAt) {
  const timing = petChatVoiceTiming;
  petChatVoiceTiming = null;
  if (!timing || petChatInputMode !== 'voice' || !firstTokenAt) return;
  const vadTail = 550; // 与 lib/voice/record.js 的 streamSilenceMs 同口径
  const asr = Math.max(0, Number(timing.inferenceMs) || 0);
  const firstToken = Math.max(0, firstTokenAt - turnStartAt);
  const firstAudio = firstAudioAt ? Math.max(0, firstAudioAt - firstTokenAt) : 0;
  const playStart = petChatPlayStartAt ? Math.max(0, petChatPlayStartAt - (firstAudioAt || firstTokenAt)) : 0;
  const total = vadTail + asr + firstToken + firstAudio + playStart;
  try {
    void apiPostJson('/pet-chat/latency', {
      inputMode: 'voice',
      engine: petChatVoice && petChatVoice.name ? String(petChatVoice.name).split(':')[0] : '',
      segments: { recordTail: vadTail, asr, firstToken, firstAudio, playStart, total },
      total,
    }, { parse: 'always' }).catch(() => {});
  } catch { /* 诊断失败不影响对话 */ }
}

/** 语音输入（v0.1）：前端不碰麦克风 —— 宿主用 ffmpeg 录，这里只发请求、收文本。 */
const petVoiceIn = petVoiceInputCreate({
  // barge-in：**一开录就先停朗读**（判据 verify-voice-tts 断言这个顺序）
  onBeforeRecord: () => { petChatInputMode = 'voice'; petSpeakStop(); petSingStop(); },
  postRecord: async () => {
    // pre.62：ffmpeg 不在包里，首次点麦可能在下载。宿主回 ffmpeg-preparing+percent；
    // 这里在状态条显示进度并自动重试 /record（下载在宿主后台继续），不显示“没听到声音”。
    for (let attempt = 0; attempt < 180; attempt += 1) {
      const attemptStart = Date.now();
      const res = await apiPostJson('/pet-chat/record', { language: 'zh' }, { parse: 'always' });
      const doc = (res && res.data) || {};
      if (doc.code === 'ffmpeg-preparing') {
        const pct = Math.max(0, Math.min(100, Number(doc.percent) || 0));
        petBubble.status('info', weT('正在准备录音组件 {pct}%', { pct }), { delay: 0 });
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
        continue;
      }
      if (doc.ok === true) {
        // 6 段诊断：宿主在同一个 /record 里做了录音 + 转写；inferenceSeconds 是 ASR 那一段。
        petChatVoiceTiming = {
          recordStartedAt: attemptStart,
          recordDoneAt: Date.now(),
          inferenceMs: Math.max(0, Number(doc.inferenceSeconds) || 0) * 1000,
        };
      }
      petBubble.hideStatus(0);
      return doc;
    }
    return { ok: false, code: 'ffmpeg-preparing', hint: weT('录音组件还在准备，稍后再点我') };
  },
  postChat: async (text, onState) => {
    if (petChatVoiceAbort) {
      if (typeof onState === 'function') onState({ state: 'idle' });
      return;
    }
    petChatTurnBegin();
    const turnStartAt = Date.now();
    let firstTokenAt = 0;
    let firstAudioAt = 0;
    petChatPlayStartAt = 0;
    petChatSpeechRate = 0;
    petChatMood = 'neutral';
    const workNow = Date.now();
    if (!petChatWorkStart || workNow - petChatWorkLastAt > 10 * 60 * 1000) petChatWorkStart = workNow;
    petChatWorkLastAt = workNow;
    petChatContinuousClearTimer();
    // “想”态：模型还在回，先不给“说”的波形
    petBubble.setState('think');
    // 新一轮回答从空气泡开始（否则会追加到上一轮回答的尾部）。
    petBubble.clear();
    // v2 环境感知：壁纸名 / 正在播放由前端补（宿主不认识 selection 与媒体桥实例）。
    const context = await petChatEnvSnapshot();
    // ⚠️ apiFetch 的返回值里**已经带上了原始 Response**（字段 `response`）。
    //    上一版误写成 `res.body.getReader()`：res 是 { ok, status, data, response }，
    //    res.body 恒为 undefined ⇒ 抛 TypeError ⇒ 读流代码一行都跑不到
    //    （真机症状：输入后气泡停在 answer 状态、一个字都不出）。
    //    也不要用裸 fetch —— 守卫 verify-api-client 要求客户端零裸 fetch。
    let res;
    try {
      res = await apiFetch('/pet-chat/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          context,
          // pre.65：显式输入方式让宿主做“语音 1–3 句 / 文字可长”的长度策略。
          inputMode: petChatInputMode === 'voice' ? 'voice' : 'text',
        }),
        // ⚠️ 必须 parse:'none'。默认路径会 await response.json()，
        //    那会把 SSE 流**整个消费掉**（等到生成结束、再解析失败），
        //    之后 res.response.body 已 used ⇒ getReader() 抛错 ⇒ 气泡一个字都不出。
        parse: 'none',
      });
    } catch {
      petBubble.status('error', '连不上宿主，稍后再试', { delay: 4000 });
      if (typeof onState === 'function') onState({ state: 'idle' });
      petChatTurnEnd();
      return;
    }
    const stream = res && res.response;
    if (!res || !res.ok || !stream || !stream.body) {
      petBubble.status('error', res && res.status === 401 ? '模型 Key 无效，去设置里换一把' : '这次没答上来，再试一次', { delay: 4000 });
      if (typeof onState === 'function') onState({ state: 'idle' });
      petChatTurnEnd();
      return;
    }
    let rawReply = '';
    let replyStarted = false;
    /** v5：这一轮是不是以"唱歌"结尾（有 sing 事件时别按"无朗读"提前收气泡/开麦）。 */
    let singStarted = false;
    let replyDone = false;
    /**
     * 朗读的流式切句（P1）：
     * SSE 每来一小段就交给 `petTtsSentences`；**句末标点一到就入队**，
     * 不等 done —— 这是“录音停止后尽快开始播报”的关键（合成与模型生成重叠）。
     */
    let speakBuffer = '';
    let queuedSpeech = 0;
    const enqueueSpeech = (piece) => {
      const line = String(piece || '').trim();
      if (!line) return;
      // 任务 §4③：「暂停说话」= 跳过 TTS 队列，只出字幕；状态条显示「🔇 仅文字」。
      if (petChatSpeakPaused) {
        petBubble.setState('muted');
        return;
      }
      // v2：本轮语速由宿主 meta 给（夜间/疲惫 -1 = -10%）；再叠加当前人设的 voice.rate。
      if (petSpeak(line, { rate: petChatSpeechRate + (Number(petChatVoice.rate) || 0) })) {
        queuedSpeech += 1;
        if (!firstAudioAt) firstAudioAt = Date.now(); // 首段音频交给播放器的时刻
      }
    };
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); // eslint-disable-line no-await-in-loop
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const cut = buffer.indexOf('\n\n');
        if (cut < 0) break;
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        let eventName = 'message';
        let dataLine = '';
        for (const row of frame.split('\n')) {
          if (row.startsWith('event:')) eventName = row.slice(6).trim();
          else if (row.startsWith('data:')) dataLine = row.slice(5).trim();
        }
        if (!dataLine) continue;
        let payload;
        try { payload = JSON.parse(dataLine); } catch { payload = null; }
        if (!payload) continue;
        if (eventName === 'meta') {
          petChatMood = String(payload.mood || 'neutral');
          petChatSpeechRate = Number.isFinite(Number(payload.rate)) ? Number(payload.rate) : 0;
          // v5 §5：深度档 >3s 显示「深度思考中…」（quick/standard 秒回，不闪这一下）。
          if (payload.tier === 'deep') {
            if (petChatDeepTimer != null) clearTimeout(petChatDeepTimer);
            petChatDeepTimer = setTimeout(() => {
              petChatDeepTimer = null;
              petBubble.status('info', weT('深度思考中…'), { delay: 0 });
            }, 3000);
          } else if (petChatDeepTimer != null) {
            clearTimeout(petChatDeepTimer);
            petChatDeepTimer = null;
          }
          continue;
        }
        if (eventName === 'confirm') {
          // v2：权限为 ask 时宿主先发 confirm；语音说「好」或点气泡按钮后才执行。
          petChatConfirmShow(payload);
          continue;
        }
        if (eventName === 'action') {
          // 不 await：继续读流，宿主在收到 /tool-result 后才发后续 delta/done。
          void petChatHandleAction(payload);
          continue;
        }
        if (eventName === 'sing') {
          // v5 §1：唱歌事件带 audioUrl + 逐行时间戳；客户端单独放音频并逐行高亮。
          singStarted = true;
          petChatSingPlay(payload);
          continue;
        }
        if (eventName === 'done') {
          if (Number.isFinite(Number(payload.rate))) petChatSpeechRate = Number(payload.rate);
          continue;
        }
        // 防兜底：模型偶尔仍会输出 {"reply":"…","emotion":"…"} 信封，
        // 这里只把 reply 的正文喂给气泡（不显示大括号/字段名/emotion）。
        if (typeof payload.t === 'string') {
          if (!firstTokenAt) firstTokenAt = Date.now(); // 首 token 到达（诊断第 4 段）
          rawReply += payload.t;
          let piece = payload.t;
          if (!replyStarted) {
            const at = rawReply.indexOf('"reply":"');
            if (at >= 0) {
              replyStarted = true;
              piece = rawReply.slice(at + 9);
            } else if (rawReply.trimStart().startsWith('{')) {
              piece = '';
            }
          }
          if (piece && !replyDone) {
            const cut = piece.indexOf('","emotion"');
            if (cut >= 0) { piece = piece.slice(0, cut); replyDone = true; }
            if (piece) {
              // 气泡始终显示**完整回答**（逐段追加，长文在 160px 内滚动）；
              // 朗读只负责切句与“说”状态，不再改写气泡内容。
              petBubble.append(piece);
              speakBuffer += piece;
              const split = petTtsSentences(speakBuffer);
              for (const sentence of split.sentences) enqueueSpeech(sentence);
              speakBuffer = split.rest;
            }
          }
        }
      }
    }
    // 最后一段没有句末标点也要念（比如“我也在”）
    enqueueSpeech(speakBuffer);
    if (typeof onState === 'function') onState({ state: 'idle' });
    // 本轮成功：常驻聆听继续（任务 §4：装好就在听，不靠"点了才听"）；
    // 有朗读时等 onIdle 播完再开麦（半双工），没朗读（暂停说话/静音）直接 150ms 后排下一轮。
    if (!petChatContinuousActive && !petChatContinuousPaused) petChatContinuousStart();
    petChatLastHeardAt = Date.now();
    petChatContinuousRounds += 1;
    petChatContinuousSilent = 0;
    petChatPublishContinuousState();
    if (!queuedSpeech && !singStarted) petChatContinuousArm();
    // 没有任何一句进入朗读（暂停说话 / 合成不可用）⇒ 字幕照常显示，3 秒后淡出。
    // 唱歌时气泡归歌词用：不提前收，播完由 petChatSingPlay 收。
    if (!queuedSpeech && !singStarted) petBubble.hide(3000);
    petChatReportLatency(turnStartAt, firstTokenAt, firstAudioAt);
    petChatTurnEnd();
  },
  // P4：用户自己的话**不进**气泡（那是回声）；只显示 assistant 的 SSE delta
  onText: () => {},
  onError: (error) => {
    // 失败一律回落打字：只给一行提示，不弹错误框
    const map = {
      'no-device': '没找到麦克风，先打字吧',
      'no-signal': '麦克风没收到声音：检查静音或输入设备',
      'too-quiet': '太小声了，离麦克风近一点（30–50cm）再说一次',
      'ffmpeg-missing': '缺少 ffmpeg，先打字吧',
      'ffmpeg-preparing': '录音组件还在准备，稍后再点我',
      'ffmpeg-failed': '录音组件准备失败，去「智能大肥鱼 → 朗读与音色」点重试',
      'unsupported-platform': '这个系统不支持桌面录音，用浏览器打开 DSH 才能语音',
      'asr-not-ready': '语音模型还没下载，我来准备一下…',
      unclear: '没听清，再说一次或直接打字',
      timeout: '这次没听清，再说一次或直接打字',
      'no-speech': '没听到声音，再说一次或直接打字',
      network: '网络不太顺，重试或直接打字',
    };
    const message = map[error && error.code] || '没听清，直接打字也行';
    // 连续对话里：静默/太小声累计 2 轮才退出；其它设备错误立即停。
    if (petChatContinuousActive) {
      petChatContinuousVoiceError(error && error.code);
      return;
    }
    // asr-not-ready：自动触发模型下载并在状态条里显示进度，用户不用去 DSH 设置里找开关
    if (error && error.code === 'asr-not-ready') {
      petBubble.status('info', message, { delay: 0 });
      void ensureAsrReady();
      return;
    }
    // ⚠️ 失败**不要自动弹输入框**（用户会以为"点一下就变对话框"）。
    // 打字入口只从右键菜单「对话」进；这里只给一行提示 + 引导。
    petBubble.status('error', `${message}（右键 → 对话）`, { delay: 5000 });
  },
});

/**
 * 打字兜底（右键 → 打字说…）：一个小输入条挂在桌宠上方，回车发 /chat。
 * 为什么不用 window.prompt：Electron 里 prompt 返回 null，用户会以为坏了。
 */
function petChatOpenTyping(extra = {}) {
  if (typeof document === 'undefined' || !document.createElement) return;
  const existed = document.querySelector('#we-pet-typing');
  if (existed) { existed.focus(); return; }
  const box = document.createElement('div');
  box.id = 'we-pet-typing';
  box.style.cssText = 'position:fixed;z-index:10000;left:50%;bottom:120px;transform:translateX(-50%);'
    + 'display:flex;gap:6px;background:rgba(24,24,28,.95);padding:8px;border-radius:10px;';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = (extra && extra.hint) || '打字说…（回车发送）';
  input.style.cssText = 'width:240px;padding:6px 8px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;';
  const send = () => {
    const text = String(input.value || '').trim();
    if (!text) return;
    box.remove();
    // 新的一轮 = 先掐掉上一轮还在念的（与录音入口同一条 barge-in 纪律）
    petSpeakStop();
    petSingStop();
    petChatVoiceAbort = false;
    petChatInputMode = 'text';
    // 打字说的文本**不上气泡**（P4 同理：气泡只显示助手的回答）。
    // 这里只把状态切成"思考中"，等 SSE 的 delta 逐字填进来。
    petBubble.setState('think');
    void petVoiceIn.postChat(text);
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') send();
    if (event.key === 'Escape') box.remove();
  });
  box.appendChild(input);
  document.body.appendChild(box);
  input.focus();
}

/**
 * 说一句：气泡显示 + 朗读（P1）。
 * 静音/合成不可用时退回“只显示 3 秒”，不抛错、不弹窗。
 */
function petChatSay(text) {
  const line = String(text || '').trim();
  if (!line) return;
  petBubble.show(line);
  if (!petSpeak(line)) petBubble.hide(3000);
}

/** 每次点桌宠递增；收起/重开时让旧的 ASR 等待自动作废。 */
let petChatWakeSeq = 0;

/** 点桌宠：常驻聆听默认在听 —— 点它只做三件事：打断朗读 / 恢复聆听 / 收起气泡。 */
function petChatWake() {
  // **任何一次唤醒都是 barge-in**：先把正在念的/正在唱的停掉，再决定是收起还是开麦。
  petSpeakStop();
  petSingStop();
  void petChatRefreshVoice();
  const seq = ++petChatWakeSeq;
  // 暂停聆听中点桌宠 = 恢复常驻聆听（不用再去右键菜单）。
  if (petChatContinuousPaused) {
    petChatContinuousResume();
    return;
  }
  if (petChatContinuousActive) {
    // 已经常驻聆听：点一下只收起气泡/状态条，**不关麦**（任务 §4：装好就在听）。
    petBubble.hide(0);
    petBubble.hideStatus(0);
    petBubble.setContinuous(true);
    if (!petChatContinuousTimer && !petChatListeningNow) petChatContinuousArm(PET_CHAT_LISTEN_RESUME_MS);
    return;
  }
  if (petBubble.isVisible()) { petBubble.hide(0); petBubble.hideStatus(0); petVoiceIn.stop(); return; }
  petChatContinuousPaused = false;
  petChatVoiceAbort = false;
  petChatContinuousClearTimer();
  // 先看语音模型是否就绪；没就绪就**立刻**开始下载并在气泡里显示进度，
  // 不要等用户先撞一次 asr-not-ready 才被动触发（那之前会像"没反应"）。
  void (async () => {
    const resp = await apiJson('/pet-chat/asr', { parse: 'always' }).catch(() => null);
    const doc = (resp && resp.data) || {};
    if (!doc.ready) {
      if (doc.available === false) {
        petBubble.status('error', '这个 DSH 版本没有语音转写服务，先打字吧', { delay: 5000 });
        return;
      }
      const ready = await ensureAsrReady(() => seq !== petChatWakeSeq);
      if (!ready || seq !== petChatWakeSeq) return;
    }
    if (seq !== petChatWakeSeq) return;
    petChatVoiceAbort = false;
    petBubble.setState('listen');
    petChatListeningNow = true;
    const started = await petVoiceIn.start();
    if (!started) return; // 失败分支已经由 onError 提示（回落打字）
    // 状态条已经由 setState('listen') 显示「🎤 在听」，这里不再往回答气泡里塞提示。
  })();
}

/**
 * 添加/恢复常驻聆听（安装后自动跑一次；右键「继续聆听」也走它）。
 * ASR 没就绪时先准备模型（进度显示在状态条），就绪后才开麦。
 */
async function petChatResidentStart(seqGuard) {
  // 没填模型 Key 就不开麦（隐私 + 体验）：先让用户去设置里配置。
  if (!petChatModelReady) {
    petBubble.status('info', weT('先填模型 Key，我才能听懂你说话（设置 → 智能大肥鱼）'), { delay: 7000 });
    return false;
  }
  const seq = typeof seqGuard === 'number' ? seqGuard : ++petChatWakeSeq;
  if (petChatContinuousPaused || petChatContinuousEnabled !== true) {
    petBubble.setVoiceFlags({ speakPaused: petChatSpeakPaused, listenPaused: true });
    return false;
  }
  const resp = await apiJson('/pet-chat/asr', { parse: 'always' }).catch(() => null);
  const doc = (resp && resp.data) || {};
  if (doc.available === false) {
    petChatContinuousStop(weT('这个 DSH 版本没有语音转写服务：常驻聆听不可用，先打字吧'));
    petBubble.status('error', weT('这个 DSH 版本没有语音转写服务，先打字吧'), { delay: 6000 });
    return false;
  }
  if (!doc.ready) {
    const ready = await ensureAsrReady(() => seq !== petChatWakeSeq);
    if (!ready || seq !== petChatWakeSeq) return false;
  }
  if (seq !== petChatWakeSeq) return false;
  // 回到页面 / 刚恢复：不要因为之前安静了很久而等 2 秒，立刻进入听。
  petChatLastHeardAt = Date.now();
  petChatContinuousStart();
  petChatContinuousArm(120);
  // 首次进入常驻聆听的一次性告知（不弹窗，只气泡）。
  try {
    const NOTICE_KEY = 'dsh-folia:resident-notice-v1';
    if (window.localStorage && !window.localStorage.getItem(NOTICE_KEY)) {
      window.localStorage.setItem(NOTICE_KEY, '1');
      petBubble.status('info', weT('我会一直听着，直接说话就行；右键可「暂停聆听」'), { delay: 6500 });
    }
  } catch { /* 隐私模式/无 localStorage 时忽略 */ }
  return true;
}

/** 连续对话等待/开麦时的状态条：独立成函数，确保补丁位置在 ASR 就绪判断之后。 */
function petChatShowContinuousListening() {
  petBubble.setContinuous(true);
  petBubble.setVoiceFlags({ speakPaused: petChatSpeakPaused, listenPaused: petChatContinuousPaused });
  petBubble.setState('listen');
}

/**
 * 工作联动反向通道（P1）：宿主 `/pet-chat/speak` → SSE `/pet-chat/events` → 这里念。
 * 待办/提醒/其它插件可以直接 `POST /folia/pet-chat/speak`，也可以在同一渲染进程里
 * `window.__dshFoliaPet.speak(text)` / 派发 `we-pet-speak` 事件。
 * EventSource 自带重连；这里不弹任何提示。
 */
/**
 * 桌面通知（任务 §6② notify）：宿主经 /events 推 `{type:'notify'}`。
 * 浏览器 Notification 被系统拦掉时回落气泡状态条 —— 不静默丢通知。
 */
function petChatShowNotify(doc) {
  const title = String((doc && doc.title) || '桌宠');
  const text = String((doc && doc.text) || '').trim();
  if (!text) return;
  try {
    const N = typeof Notification === 'function' ? Notification : null;
    if (N && N.permission === 'granted') {
      const note = new N(title, { body: text });
      setTimeout(() => { try { note.close(); } catch { /* ignore */ } }, 6000);
      return;
    }
    if (N && N.permission === 'default' && typeof N.requestPermission === 'function') {
      void N.requestPermission().catch(() => {});
    }
  } catch { /* Electron 可能没有 Notification */ }
  petBubble.status('info', `🔔 ${title}：${text}`, { delay: 6000 });
}

let petChatEventSource = null;
function petChatEventsStart() {
  if (petChatEventSource || typeof EventSource !== 'function') return;
  try {
    const source = new EventSource(apiUrl('/pet-chat/events'));
    source.onmessage = (event) => {
      let doc;
      try { doc = JSON.parse((event && event.data) || ''); } catch { doc = null; }
      if (!doc) return;
      if (doc.type === 'notify') { petChatShowNotify(doc); return; }
      if (doc.type !== 'speak' || !doc.text) return;
      petSpeak(String(doc.text), { voice: doc.voice, rate: doc.rate });
    };
    source.onerror = () => { /* EventSource 自动重连；失败不打扰用户 */ };
    petChatEventSource = source;
  } catch { /* 老环境没有 EventSource：仍在渲染进程内的调用走 window.__dshFoliaPet */ }
}
function petChatEventsStop() {
  if (!petChatEventSource) return;
  try { petChatEventSource.close(); } catch { /* ignore */ }
  petChatEventSource = null;
}

/**
 * 常驻挂载（`WE_FEATURE_MOUNTS` 的一项）：绑定点桌宠 / 快捷键。
 * 返回 cleanup —— 卸载时摘监听、断开反向通道、销毁气泡。
 */
function mountPetChat() {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return () => {};
  const onDocumentClick = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('#we-pet-layer')) petChatWake();
  };
  const onKeyDown = (event) => {
    if (event.altKey && event.ctrlKey && String(event.key).toLowerCase() === 'p') {
      event.preventDefault();
      petChatWake();
    }
  };
  // 打字入口只从**右键菜单「对话」**进：pet-layer 的菜单项派发 `we-pet-talk`。
  // 不再劫持 contextmenu —— 那会让右键弹不出桌宠原生菜单（试演动作/缩放…）。
  const onTalkEvent = () => { petChatOpenTyping(); };

  /** 工作联动：同一渲染进程里的待办/提醒可以直接派发这个事件。 */
  const onSpeakEvent = (event) => {
    const detail = (event && event.detail) || {};
    const text = detail && detail.text;
    if (text) petSpeak(String(text), { voice: detail.voice, rate: detail.rate });
  };

  window.addEventListener('we-pet-talk', onTalkEvent);
  window.addEventListener('we-pet-speak', onSpeakEvent);
  // 右键菜单：常驻聆听 / 暂停说话（v3 §4）。旧 we-pet-continuous 保留兼容。
  const onContinuousEvent = (event) => { petChatOnContinuousCommand(event); };
  window.addEventListener('we-pet-continuous', onContinuousEvent);
  const onSpeakPauseEvent = (event) => {
    const detail = (event && event.detail) || {};
    petChatSetSpeakPaused(detail.paused === undefined ? !petChatSpeakPaused : detail.paused === true);
  };
  const onListenPauseEvent = (event) => {
    const detail = (event && event.detail) || {};
    petChatSetListenPaused(detail.paused === undefined ? !petChatContinuousPaused : detail.paused === true);
  };
  window.addEventListener('we-pet-speak-pause', onSpeakPauseEvent);
  window.addEventListener('we-pet-listen-pause', onListenPauseEvent);
  // 页面隐藏：暂时停麦（不持久化，回到页面自动恢复）；不偷偷在后台开麦。
  const onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      if (petChatContinuousActive && !petChatContinuousPaused) {
        petChatVoiceAbort = true;
        try { petVoiceIn.stop(); } catch { /* ignore */ }
        petChatContinuousClearTimer();
        petChatListeningNow = false;
        petBubble.setContinuous(false);
        petChatPublishContinuousState();
      }
      return;
    }
    // 回到页面：如果没被「暂停聆听」，150ms 内恢复听。
    if (!petChatContinuousPaused && petChatContinuousEnabled) petChatResidentStart();
  };
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  // 任务 §4：安装/启动后自动进入常驻聆听（受持久化的「暂停聆听」约束）。
  void petChatRefreshVoice().then(() => {
    petChatPublishContinuousState();
    if (!petChatContinuousPaused) void petChatResidentStart();
  }).catch(() => {});
  petChatEventsStart();
  // v2 主动发起：壁纸变化 → 30 秒后点评；连续工作 45 分钟 → 休息提醒；挂载后试早晚问候。
  // 三条都受“正在朗读 / 正在听 / 一轮回答中 / 页面隐藏”约束（见 petChatProactiveAllowed）。
  petChatWallpaperTimer = petChatWatchWallpaper();
  petChatWorkTimer = petChatWatchWork();
  petChatGreetingTimer = petChatMaybeGreet();
  // 对外通道：`speak(text)` 供待办/提醒直接调用（不打开任何窗口）
  try {
    window.__dshFoliaPet = {
      speak: (text, speech) => petSpeak(text, speech || {}),
      stop: () => { petSingStop(); return petSpeakStop(); },
      sing: (sing) => petChatSingPlay(sing),
      chat: (text) => { petChatInputMode = 'text'; return petVoiceIn.postChat(String(text || '')); },
      isSpeaking: () => petTts.isSpeaking(),
      // 任务 §4：两个开关（菜单之外的对外通道；判据也用它）
      setSpeakPaused: (paused) => petChatSetSpeakPaused(paused === true),
      setListenPaused: (paused) => petChatSetListenPaused(paused === true),
      isListening: () => petChatListeningNow === true,
      isSpeakPaused: () => petChatSpeakPaused === true,
      isListenPaused: () => petChatContinuousPaused === true,
    };
  } catch { /* 被别的插件占用就只保留事件通道 */ }
  return () => {
    window.removeEventListener('we-pet-talk', onTalkEvent);
    window.removeEventListener('we-pet-speak', onSpeakEvent);
    window.removeEventListener('we-pet-continuous', onContinuousEvent);
    window.removeEventListener('we-pet-speak-pause', onSpeakPauseEvent);
    window.removeEventListener('we-pet-listen-pause', onListenPauseEvent);
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('visibilitychange', onVisibility);
    if (petChatWallpaperTimer != null) clearInterval(petChatWallpaperTimer);
    if (petChatWorkTimer != null) clearInterval(petChatWorkTimer);
    if (petChatGreetingTimer != null) clearTimeout(petChatGreetingTimer);
    // v5 §6：深度思考的 3s 提示定时器也要随卸载清掉（否则会在 dispose 后改气泡）。
    if (petChatDeepTimer != null) { clearTimeout(petChatDeepTimer); petChatDeepTimer = null; }
    if (petSingTimer != null) { clearInterval(petSingTimer); petSingTimer = null; }
    petChatWallpaperTimer = null;
    petChatWorkTimer = null;
    petChatGreetingTimer = null;
    petChatEventsStop();
    petSpeakStop();
    petSingStop();
    petChatConfirmHide();
    try { if (window.__dshFoliaPet) delete window.__dshFoliaPet; } catch { /* ignore */ }
    petBubble.dispose();
  };
}

