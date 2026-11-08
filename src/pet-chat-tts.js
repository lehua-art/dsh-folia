/**
 * pet-chat-tts.js — **朗读回答**（浏览器 / Electron 内置 speechSynthesis 的薄封装）。
 *
 * 三条铁律（来自工单）：
 *   ① **文字照常显示**：本模块只调 `speechSynthesis`，**不碰 DOM、不改文本** ——
 *      朗读是叠加，不是替换（气泡 + 打字机该显示什么还显示什么）。
 *   ② **零依赖零 token**：走系统语音（Electron 下是 Windows SAPI）；没有就说没有。
 *   ③ 与宠物"音效"开关**无关**：这里只看 `petChat.voiceOut.enabled`。
 *
 * 朗读节奏：
 *   · 整段到达（非流式 / 预设台词）⇒ `finish(text)` 整段读一次；
 *   · 流式增量 ⇒ `push(chunk)`，凑满句末标点就按句读（不打断打字机）。
 *
 * 为什么要做成工厂并把 speechSynthesis / Utterance 注入进来：
 * 判据要能 mock（`test/verify-pet-chat.mjs` 的 6 条），而渲染进程的真实实现
 * 就是 `window.speechSynthesis` + `window.SpeechSynthesisUtterance`。
 */

/** 句末标点（中英混排；省略号也算一句的结尾）。 */
const PET_CHAT_TTS_SENTENCE_END = /[。！？!?；;…]+/;

/**
 * 按句末标点切句（保留标点）。
 * 单句过长（>120 字）时按逗号再切一次，避免一口气念 300 字。
 */
function petChatTtsSplit(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return [];
  const out = [];
  let buffer = '';
  for (const char of raw) {
    buffer += char;
    if (PET_CHAT_TTS_SENTENCE_END.test(char)) {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  // 保险：单句 >120 字再按逗号切
  const final = [];
  for (const sentence of out) {
    if (sentence.length <= 120) { final.push(sentence); continue; }
    let piece = '';
    for (const char of sentence) {
      piece += char;
      if (char === '，' || char === ',' ) { final.push(piece); piece = ''; }
    }
    if (piece.trim()) final.push(piece);
  }
  return final;
}

/** 中文音色识别：`zh-*`、名字里带 Chinese / Huihui / Xiaoxiao。 */
function petChatTtsIsChinese(voice) {
  if (!voice) return false;
  const lang = String(voice.lang || '').toLowerCase();
  const name = String(voice.name || '');
  return lang.startsWith('zh') || /chinese|huihui|xiaoxiao|kangkang|yaoyao|tingting|hanhan/i.test(name);
}

/**
 * 造一个朗读引擎。
 *
 * @param {object} deps
 * @param {() => any} deps.getSpeech        返回 speechSynthesis（可能不存在）
 * @param {() => any[]} deps.getVoices      返回音色列表（可能为空）
 * @param {() => object} deps.getConfig     返回 `{ enabled, rate, pitch, volume, voiceURI }`
 * @param {Function} [deps.Utterance]       `SpeechSynthesisUtterance` 构造器
 * @param {(code:string, message:string) => void} [deps.onHint]  一次性提示回调
 */
function petChatTtsCreate(deps) {
  const options = deps || {};
  const getSpeech = typeof options.getSpeech === 'function' ? options.getSpeech : () => null;
  const getVoices = typeof options.getVoices === 'function' ? options.getVoices : () => [];
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({ enabled: false });
  const onHint = typeof options.onHint === 'function' ? options.onHint : () => {};
  const Utterance = options.Utterance;

  let pending = '';       // 流式未成句的尾巴
  let spokenInTurn = 0;   // 本回合已经读了几段（决定 finish 要不要整段读）
  let hintShown = {};     // 一次性提示去重（按 code）

  const hintOnce = (code, message) => {
    if (hintShown[code]) return;
    hintShown[code] = true;
    onHint(code, message);
  };

  /** 选音色：voiceURI 优先，其次第一个中文音色；都没有返回 null（并提示一次）。 */
  function pickVoice(config, voices) {
    const list = Array.isArray(voices) ? voices : [];
    const wanted = String(config.voiceURI || '').trim();
    if (wanted) {
      const hit = list.find((voice) => voice && (voice.voiceURI === wanted || voice.name === wanted));
      if (hit) return hit;
    }
    const chinese = list.find((voice) => petChatTtsIsChinese(voice));
    if (chinese) return chinese;
    if (list.length) hintOnce('no-chinese-voice', '系统里没有中文音色，朗读可能不自然');
    return null;
  }

  /** 读一段（内部）：config 关了就什么都不做。 */
  function speakOne(text, speech, config, voices) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return false;
    if (typeof Utterance !== 'function') return false;
    const utterance = new Utterance(trimmed);
    utterance.rate = Number.isFinite(Number(config.rate)) ? Number(config.rate) : 1;
    utterance.pitch = Number.isFinite(Number(config.pitch)) ? Number(config.pitch) : 1;
    utterance.volume = Number.isFinite(Number(config.volume)) ? Number(config.volume) : 1;
    const voice = pickVoice(config, voices);
    if (voice) utterance.voice = voice;
    speech.speak(utterance);
    if (!hintShown['first-speak']) {
      hintShown['first-speak'] = true;
      hintOnce('first-speak', '使用系统语音，无需下载 / 不耗 token');
    }
    return true;
  }

  /** 新回合开始：停掉上一段朗读，清空缓冲。 */
  function start() {
    pending = '';
    spokenInTurn = 0;
    cancel();
  }

  /** 取消朗读（关闭气泡 / 点停止 / 新消息）。 */
  function cancel() {
    const speech = getSpeech();
    if (speech && typeof speech.cancel === 'function') speech.cancel();
  }

  /** 流式增量：凑满整句就先读（保证"边出字边读"，但不打断打字机）。 */
  function push(chunk) {
    const config = getConfig() || {};
    if (config.enabled !== true) return;
    const speech = getSpeech();
    if (!speech || typeof speech.speak !== 'function') return; // ⑤ 没有 speechSynthesis ⇒ 静默跳过
    const text = String(chunk ?? '');
    if (!text) return;
    pending += text;
    const sentences = petChatTtsSplit(pending);
    // 只有"以标点结尾"的才算成句；最后一段若不以标点结尾，留到下次
    const endsWithPunct = PET_CHAT_TTS_SENTENCE_END.test(pending.slice(-1));
    const ready = endsWithPunct ? sentences : sentences.slice(0, -1);
    if (!ready.length) return;
    if (endsWithPunct) pending = '';
    else pending = sentences[sentences.length - 1] || '';
    const voices = getVoices();
    for (const sentence of ready) if (speakOne(sentence, speech, config, voices)) spokenInTurn += 1;
  }

  /**
   * 回复结束：整段朗读。
   * 已经边流边读过句子的，这里只读剩下的尾巴；从没读过 ⇒ 整段读一次（判据①）。
   */
  function finish(fullText) {
    const config = getConfig() || {};
    if (config.enabled !== true) return;
    const speech = getSpeech();
    if (!speech || typeof speech.speak !== 'function') return;
    const whole = String(fullText ?? '');
    const tail = pending;
    pending = '';
    const voices = getVoices();
    if (spokenInTurn === 0) {
      // 整段一次读完（气泡里显示的还是同一段文字，这里只是读它）
      if (whole.trim()) speakOne(whole.trim(), speech, config, voices);
      return;
    }
    if (tail.trim()) speakOne(tail.trim(), speech, config, voices);
  }

  return { start, push, finish, cancel, split: petChatTtsSplit };
}
