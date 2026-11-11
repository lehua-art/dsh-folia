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

/**
 * 语音模型（SenseVoice）自举：调宿主 /pet-chat/asr（它会 speechToText.prepare），
 * 然后轮询 /pet-chat/asr 把下载进度显示在气泡里。
 * 这样用户装完插件直接说话就行，不需要去 DSH 设置里找「语音输入」开关。
 */
async function ensureAsrReady() {
  petBubble.setState('think');
  try {
    await apiPostJson('/pet-chat/asr', {}, { parse: 'always' });
  } catch { /* 触发失败也要继续轮询看状态 */ }
  for (let i = 0; i < 240; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    const resp = await apiJson('/pet-chat/asr', { parse: 'always' }).catch(() => null);
    const doc = (resp && resp.data) || {};
    if (doc.ready) {
      petBubble.show('语音准备好了，点我再说一次');
      petBubble.hide(3000);
      return;
    }
    if (doc.available === false) {
      petBubble.show('这个 DSH 版本没有语音转写服务，先打字吧');
      petBubble.hide(3000);
      return;
    }
    if (doc.phase === 'failed') {
      petBubble.show('语音模型下载失败，稍后再点我试试');
      petBubble.hide(3000);
      return;
    }
    const pct = doc.totalBytes > 0 && doc.completedBytes >= 0
      ? Math.max(0, Math.min(100, Math.round((doc.completedBytes / doc.totalBytes) * 100)))
      : null;
    petBubble.show(pct === null ? '语音模型准备中…' : `语音模型下载中 ${pct}%`);
  }
  petBubble.show('语音模型还没下完，过一会儿再点我');
  petBubble.hide(3000);
}

/** 语音输入（v0.1）：前端不碰麦克风 —— 宿主用 ffmpeg 录，这里只发请求、收文本。 */
const petVoiceIn = petVoiceInputCreate({
  postRecord: async () => {
    const res = await apiPostJson('/pet-chat/record', { language: 'zh' }, { parse: 'always' });
    return (res && res.data) || {};
  },
  postChat: async (text, onState) => {
    petBubble.setState('answer');
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
        body: JSON.stringify({ text }),
        // ⚠️ 必须 parse:'none'。默认路径会 await response.json()，
        //    那会把 SSE 流**整个消费掉**（等到生成结束、再解析失败），
        //    之后 res.response.body 已 used ⇒ getReader() 抛错 ⇒ 气泡一个字都不出。
        parse: 'none',
      });
    } catch {
      petBubble.show('连不上宿主，稍后再试');
      petBubble.hide(3000);
      if (typeof onState === 'function') onState({ state: 'idle' });
      return;
    }
    const stream = res && res.response;
    if (!res || !res.ok || !stream || !stream.body) {
      petBubble.show(res && res.status === 401 ? '模型 Key 无效，去设置里换一把' : '这次没答上来，再试一次');
      petBubble.hide(3000);
      if (typeof onState === 'function') onState({ state: 'idle' });
      return;
    }
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
  // P4：用户自己的话**不进**气泡（那是回声）；只显示 assistant 的 SSE delta
  onText: () => {},
  onError: (error) => {
    // 失败一律回落打字：只给一行提示，不弹错误框
    const map = {
      'no-device': '没找到麦克风，先打字吧',
      'ffmpeg-missing': '缺少 ffmpeg，先打字吧',
      'asr-not-ready': '语音模型还没下载，我来准备一下…',
      timeout: '这次没听清，再说一次或直接打字',
      'no-speech': '没听到声音，再说一次或直接打字',
      network: '网络不太顺，重试或直接打字',
    };
    const message = map[error && error.code] || '没听清，直接打字也行';
    petBubble.show(message);
    // asr-not-ready：自动触发模型下载并在气泡里显示进度，用户不用去 DSH 设置里找开关
    if (error && error.code === 'asr-not-ready') {
      void ensureAsrReady();
      return;
    }
    petBubble.hide(3000);
    petChatOpenTyping({ hint: message });
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
  // 先看语音模型是否就绪；没就绪就**立刻**开始下载并在气泡里显示进度，
  // 不要等用户先撞一次 asr-not-ready 才被动触发（那之前会像"没反应"）。
  void (async () => {
    const resp = await apiJson('/pet-chat/asr', { parse: 'always' }).catch(() => null);
    const doc = (resp && resp.data) || {};
    if (doc.ready) return;
    if (doc.available === false) return; // 该 DSH 没转写服务，交给 record 的失败分支提示
    await ensureAsrReady();
  })();
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
  const onContextMenu = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('#we-pet-layer')) return;
    event.preventDefault();
    petChatOpenTyping();
  };
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    petBubble.dispose();
  };
}
