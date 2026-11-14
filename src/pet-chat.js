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
      petBubble.status('info', '语音准备好了，点我再说一次', { delay: 3000 });
      return;
    }
    if (doc.available === false) {
      petBubble.status('error', '这个 DSH 版本没有语音转写服务，先打字吧', { delay: 5000 });
      return;
    }
    if (doc.phase === 'failed') {
      petBubble.status('error', '语音模型下载失败，稍后再点我试试', { delay: 5000 });
      return;
    }
    const pct = doc.totalBytes > 0 && doc.completedBytes >= 0
      ? Math.max(0, Math.min(100, Math.round((doc.completedBytes / doc.totalBytes) * 100)))
      : null;
    petBubble.status('info', pct === null ? '语音模型准备中…' : `语音模型下载中 ${pct}%`, { delay: 0 });
  }
  petBubble.status('info', '语音模型还没下完，过一会儿再点我', { delay: 5000 });
}

/**
 * 朗读配置（P1）：`/pet-chat/state` 的 voice 字段。
 *
 * 懒加载：挂载时与每次唤醒时各刷一次（设置面板改完立刻生效，不用重启）。
 * 读不到就保持“不静音”，宁可多念一句，也不要让用户以为朗读坏了。
 */
let petChatVoice = { name: '', muted: false, rate: 0 };
async function petChatRefreshVoice() {
  try {
    const resp = await apiJson('/pet-chat/state', { parse: 'always' });
    const doc = (resp && resp.data) || {};
    if (doc.voice && typeof doc.voice === 'object') {
      petChatVoice = {
        name: String(doc.voice.name || ''),
        muted: doc.voice.muted === true,
        rate: Number.isFinite(Number(doc.voice.rate)) ? Number(doc.voice.rate) : 0,
      };
    }
  } catch { /* 读不到就用默认（不静音） */ }
  return petChatVoice;
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
  Audio: typeof Audio === 'function' ? Audio : null,
  URL: typeof URL === 'function' ? URL : null,
  getVoice: () => petChatVoice,
  onSentence: (text) => {
    petBubble.setState('speak');
    petBubble.show(text);
  },
  onState: (kind) => { petBubble.setState(kind); },
  onIdle: () => { petBubble.hide(3000); },
  onVoiceFallback: (actual) => {
    // pre.54（B3④）：宿主回落到本机默认音色时明确提示，不静默换音色。
    petBubble.status('info', actual
      ? weT('所选音色不可用，已用系统默认：{name}', { name: actual })
      : weT('所选音色不可用，已用系统默认音色'), { delay: 5000 });
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

/** 语音输入（v0.1）：前端不碰麦克风 —— 宿主用 ffmpeg 录，这里只发请求、收文本。 */
const petVoiceIn = petVoiceInputCreate({
  // barge-in：**一开录就先停朗读**（判据 verify-voice-tts 断言这个顺序）
  onBeforeRecord: () => { petSpeakStop(); },
  postRecord: async () => {
    const res = await apiPostJson('/pet-chat/record', { language: 'zh' }, { parse: 'always' });
    return (res && res.data) || {};
  },
  postChat: async (text, onState) => {
    // “想”态：模型还在回，先不给“说”的波形
    petBubble.setState('think');
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
      petBubble.status('error', '连不上宿主，稍后再试', { delay: 4000 });
      if (typeof onState === 'function') onState({ state: 'idle' });
      return;
    }
    const stream = res && res.response;
    if (!res || !res.ok || !stream || !stream.body) {
      petBubble.status('error', res && res.status === 401 ? '模型 Key 无效，去设置里换一把' : '这次没答上来，再试一次', { delay: 4000 });
      if (typeof onState === 'function') onState({ state: 'idle' });
      return;
    }
    let rawReply = '';
    let replyStarted = false;
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
      if (petSpeak(line)) queuedSpeech += 1;
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
        const line = frame.split('\n').find((item) => item.startsWith('data:'));
        if (!line) continue;
        let payload;
        try { payload = JSON.parse(line.slice(5).trim()); } catch { payload = null; }
        // 防兜底：模型偶尔仍会输出 {"reply":"…","emotion":"…"} 信封，
        // 这里只把 reply 的正文喂给气泡（不显示大括号/字段名/emotion）。
        if (payload && typeof payload.t === 'string') {
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
              // 朗读没开始时先照旧把文字逐字填进气泡；一开始播，气泡字幕就交给
              // petTts 的 onSentence（逐句显示），避免两路同时写同一个气泡。
              if (queuedSpeech === 0) petBubble.append(piece);
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
    // 没有任何一句进入朗读（静音 / 合成不可用）⇒ 沿用旧行为：整段文字 3 秒后淡出。
    // 有朗读时由 petTts 的 onIdle 在念完后淡出（按句字幕不会被提前清掉）。
    if (!queuedSpeech) petBubble.hide(3000);
  },
  // P4：用户自己的话**不进**气泡（那是回声）；只显示 assistant 的 SSE delta
  onText: () => {},
  onError: (error) => {
    // 失败一律回落打字：只给一行提示，不弹错误框
    const map = {
      'no-device': '没找到麦克风，先打字吧',
      'ffmpeg-missing': '缺少 ffmpeg，先打字吧',
      'unsupported-platform': '这个系统不支持桌面录音，用浏览器打开 DSH 才能语音',
      'asr-not-ready': '语音模型还没下载，我来准备一下…',
      timeout: '这次没听清，再说一次或直接打字',
      'no-speech': '没听到声音，再说一次或直接打字',
      network: '网络不太顺，重试或直接打字',
    };
    const message = map[error && error.code] || '没听清，直接打字也行';
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

/** 点桌宠：气泡可见 ⇒ 立刻收起（同时停止录音与朗读）；否则唤醒并开始听。 */
function petChatWake() {
  // **任何一次唤醒都是 barge-in**：先把正在念的停掉，再决定是收起还是开麦。
  petSpeakStop();
  void petChatRefreshVoice();
  if (petBubble.isVisible()) { petBubble.hide(0); petBubble.hideStatus(0); petVoiceIn.stop(); return; }
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
    // 状态条已经由 setState('listen') 显示「🎤 在听」，这里不再往回答气泡里塞提示。
  });
}

/**
 * 工作联动反向通道（P1）：宿主 `/pet-chat/speak` → SSE `/pet-chat/events` → 这里念。
 * 待办/提醒/其它插件可以直接 `POST /folia/pet-chat/speak`，也可以在同一渲染进程里
 * `window.__dshFoliaPet.speak(text)` / 派发 `we-pet-speak` 事件。
 * EventSource 自带重连；这里不弹任何提示。
 */
let petChatEventSource = null;
function petChatEventsStart() {
  if (petChatEventSource || typeof EventSource !== 'function') return;
  try {
    const source = new EventSource(apiUrl('/pet-chat/events'));
    source.onmessage = (event) => {
      let doc;
      try { doc = JSON.parse((event && event.data) || ''); } catch { doc = null; }
      if (!doc || doc.type !== 'speak' || !doc.text) return;
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
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  void petChatRefreshVoice();
  petChatEventsStart();
  // 对外通道：`speak(text)` 供待办/提醒直接调用（不打开任何窗口）
  try {
    window.__dshFoliaPet = {
      speak: (text, speech) => petSpeak(text, speech || {}),
      stop: () => petSpeakStop(),
      chat: (text) => petVoiceIn.postChat(String(text || '')),
      isSpeaking: () => petTts.isSpeaking(),
    };
  } catch { /* 被别的插件占用就只保留事件通道 */ }
  return () => {
    window.removeEventListener('we-pet-talk', onTalkEvent);
    window.removeEventListener('we-pet-speak', onSpeakEvent);
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    petChatEventsStop();
    petSpeakStop();
    try { if (window.__dshFoliaPet) delete window.__dshFoliaPet; } catch { /* ignore */ }
    petBubble.dispose();
  };
}
