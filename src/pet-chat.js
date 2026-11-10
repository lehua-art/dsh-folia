/**
 * pet-chat.js — 桌宠语音助手（v0.1 客户端）。
 *
 * v0.1 范围（docs/PET-V01-ACCEPTANCE.md）：**语音输入 + 头顶文字气泡 + 名字/记忆 + 主动搭话**，
 * **不含任何朗读/TTS**（v0.2 再做）。所以这里没有 speechSynthesis、没有 /pet-chat/speak 调用。
 *
 * 交互：点桌宠 = 唤醒 → 气泡显示它的话（3 秒后淡出，点一下立刻收起）。
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

/** 语音输入（v0.1 核心）：点桌宠即开始听，静音 1.2s 或满 15s 自动结束。 */
const petVoiceIn = petVoiceInputCreate({
  now: () => Date.now(),
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createContext: (stream) => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor 是兜底路径（AudioWorklet 要额外加载模块文件，v0.1 先用它）
    const node = ctx.createScriptProcessor(4096, 1, 1);
    source.connect(node);
    return { context: ctx, node, sampleRate: ctx.sampleRate };
  },
  postTranscribe: async (audio) => {
    const res = await apiPostJson('/pet-chat/transcribe', { audio, language: 'zh' }, { parse: 'always' });
    return (res && res.data) || {};
  },
  postChat: async (text, onState) => {
    petBubble.setState('answer');
    const res = await apiFetch('/pet-chat/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const reader = res.body.getReader();
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
        const line = frame.split('\n').find((item) => item.startsWith('data:'));
        if (!line) continue;
        let payload = null;
        try { payload = JSON.parse(line.slice(5).trim()); } catch { payload = null; }
        if (payload && typeof payload.t === 'string') petBubble.append(payload.t);
      }
    }
    if (typeof onState === 'function') onState({ state: 'idle' });
    petBubble.hide(3000);
  },
  onText: (text) => { petBubble.append(text); },
  onError: (error) => {
    // 失败一律回落打字：只给一行提示，不弹错误框（工单 S3）
    const map = {
      permission: '没拿到麦克风权限，先打字吧',
      'no-mic': '打不开麦克风，先打字吧',
      'asr-not-ready': '语音输入还没就绪：去 DSH 设置里开启（需下载模型）',
      timeout: '这次没听清，再说一次或直接打字',
      network: '网络不太顺，重试或直接打字',
    };
    const message = map[error && error.code] || '没听清，直接打字也行';
    petBubble.show(message);
    petBubble.hide(3000);
  },
});

/** 说一句：气泡显示 + 3 秒后淡出。
 * v0.1 不朗读 —— 这里刻意不做音频（验收⑦：lib/ 里不允许出现 speechSynthesis）。
 */
function petChatSay(text) {
  const line = String(text || '').trim();
  if (!line) return;
  petBubble.show(line);
  petBubble.hide(3000);
}

/** 点桌宠：气泡可见 ⇒ 立刻收起（同时停止录音）；否则唤醒并开始听。 */
function petChatWake() {
  if (petBubble.isVisible()) { petBubble.hide(0); petVoiceIn.stop(); return; }
  petBubble.setState('listen');
  void petVoiceIn.start().then((started) => {
    if (!started) return; // 失败分支已经由 onError 提示（回落打字）
    petBubble.show('我在听…');
  });
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
  return () => {
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    petBubble.dispose();
  };
}
