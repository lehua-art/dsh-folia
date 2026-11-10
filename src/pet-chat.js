/**
 * pet-chat.js — 桌宠语音助手（v0.1 客户端）。
 *
 * 交互（工单「追加决定」）：**点桌宠 = 唤醒**，它说的话显示在头顶气泡里，
 * 同时用 edge 音色朗读（失败自动回落系统音色）。**没有聊天窗口**：
 * 没有输入框、没有历史列表、没有开关按钮 —— 旧的"面板式 UI"在 v0.1 里被删除。
 *
 * 依赖（都由 build-client 的 INLINE_MODULES 排在前面注入）：
 *   · petBubbleCreate —— 头顶气泡（只显示，3 秒淡出）
 *   · petChatTtsCreate —— 系统音色朗读（edge 失败时的回落）
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
let petChatAudioPlayer = null;
let petChatVoiceCfg = { name: 'zh-CN-XiaoxiaoNeural', muted: false };
let petChatBusy = false;

/** 头顶气泡实例：锚点取桌宠层矩形，跟随位置与缩放。 */
const petBubble = petBubbleCreate({
  document: typeof document !== 'undefined' ? document : undefined,
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
});

const petChatTts = petChatTtsCreate({
  getSpeech: () => (typeof window !== 'undefined' ? window.speechSynthesis : null),
  getVoices: () => {
    const speech = typeof window !== 'undefined' ? window.speechSynthesis : null;
    return speech && typeof speech.getVoices === 'function' ? speech.getVoices() : [];
  },
  // 新结构 {name, muted} → TTS 引擎要的 {enabled, voiceURI}（单一真源仍在设置里）
  getConfig: () => ({
    enabled: !petChatVoiceCfg || petChatVoiceCfg.muted !== true,
    rate: 1, pitch: 1, volume: 1,
    voiceURI: (petChatVoiceCfg && petChatVoiceCfg.name) || '',
  }),
  Utterance: typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : undefined,
  onHint: () => {},
});

/**
 * 朗读 + 显示一句话。
 * 先请宿主合成 edge 音频；失败/未启用则回落到系统音色。朗读结束 +3s 气泡淡出。
 */
async function petChatSay(text, emotion) {
  const line = String(text || '').trim();
  if (!line) return;
  petBubble.show(line);
  if (petChatVoiceCfg && petChatVoiceCfg.muted === true) { petBubble.hide(3000); return; }
  try {
    const res = await apiPostJson('/pet-chat/speak', { text: line, emotion: emotion || 'calm' }, { parse: 'always' });
    const doc = (res && res.data) || {};
    if (doc.ok && doc.engine === 'edge' && doc.audio) {
      const player = new Audio('data:' + (doc.mime || 'audio/mpeg') + ';base64,' + doc.audio);
      petChatAudioPlayer = player;
      player.onended = () => petBubble.hide(3000);
      void player.play();
      return;
    }
  } catch { /* 网络问题一律回落系统音色 */ }
  petChatTts.finish(line);
  petBubble.hide(3000);
}

/** 点桌宠：气泡可见 ⇒ 立刻收起；否则打招呼（唤醒）。 */
function petChatWake() {
  if (petBubble.isVisible()) { petBubble.hide(0); return; }
  petBubble.setState('listen');
  void petChatSay(petChatNextPreset(), 'happy');
}

/** 拉一次设置（静音/音色），失败就按默认。 */
async function petChatRefreshConfig() {
  try {
    const res = await apiJson('/pet-chat/state', { parse: 'always' });
    const doc = (res && res.data) || {};
    if (doc.voice && typeof doc.voice === 'object') petChatVoiceCfg = doc.voice;
    petChatBusy = false;
  } catch { /* 忽略 */ }
}

/**
 * 常驻挂载（`WE_FEATURE_MOUNTS` 的一项）：绑定点桌宠 / 快捷键。
 * 返回 cleanup —— 卸载时摘监听、销毁气泡。
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
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  void petChatRefreshConfig();
  return () => {
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    petBubble.dispose();
    if (petChatAudioPlayer) { try { petChatAudioPlayer.pause(); } catch { /* ignore */ } petChatAudioPlayer = null; }
  };
}
