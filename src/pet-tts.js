/**
 * pet-tts.js（客户端）— 桌宠朗读：**按句合成 / 排队播放 / 字幕 / barge-in**。
 *
 * 为什么不把整段文字一次合成：
 *   · 第一句能先出声（模型刚说完第一句就开始念，不等整段）；
 *   · 一句失败只影响一句，不会“整段静音”；
 *   · stop 时清队列即可立刻闭嘴，不需要等一个长请求。
 *
 * 依赖全部注入（apiFetch / Audio / URL / 回调），所以 Node 里能用假播放器跑判据；
 * 浏览器侧由 `src/pet-chat.js` 用真实 `Audio` 与 `URL.createObjectURL` 构造。
 *
 * 与宿主的分工：
 *   · 宿主负责“SAPI → Edge 系统音色 → 明确错误”的兜底链，返回 `audio/wav`；
 *   · 客户端只负责切句、排队、播、停、把当前句交给气泡显示。
 */

/** 单句上限：超过就在标点/字数处切开（与宿主路由的 240 字上限配合）。 */
const PET_TTS_MAX_SENTENCE = 48;
/** 一次最多几句：再长也只念前 8 句（防止任务提醒念一整篇）。 */
const PET_TTS_MAX_PIECES = 8;
/** 与宿主 `TTS_MAX_CHARS` 对齐的总上限。 */
const PET_TTS_MAX_CHARS = 240;

/**
 * 纯函数：把一段文字切成“适合一句一合成”的片段。
 * 优先在句末标点切；长句在逗号处或硬上限处切。
 */
function petTtsSplit(text) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, PET_TTS_MAX_CHARS);
  if (!raw) return [];
  const pieces = [];
  let buffer = '';
  const flush = () => {
    const piece = buffer.trim();
    buffer = '';
    if (piece) pieces.push(piece);
  };
  for (const ch of raw) {
    buffer += ch;
    const ends = /[。！？!?；;\n]/.test(ch);
    const commaCut = /[，,、]/.test(ch) && buffer.length >= PET_TTS_MAX_SENTENCE * 0.7;
    const hardCut = buffer.length >= PET_TTS_MAX_SENTENCE;
    if (ends || commaCut || hardCut) flush();
    if (pieces.length >= PET_TTS_MAX_PIECES) break;
  }
  flush();
  return pieces.slice(0, PET_TTS_MAX_PIECES);
}

/**
 * 纯函数：流式场景下“已经说完的句子”与“还没说完的尾巴”。
 * SSE 每来一小段就调用一次，把完整句立刻入队（第一句更早出声）。
 */
function petTtsSentences(text) {
  const raw = String(text == null ? '' : text);
  const sentences = [];
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (/[。！？!?；;\n]/.test(raw[i])) {
      const piece = raw.slice(start, i + 1).trim();
      if (piece) sentences.push(piece);
      start = i + 1;
    }
  }
  let rest = raw.slice(start);
  // 没有标点的长句也要在安全长度切开，避免一直等到整段结束
  if (rest.length >= PET_TTS_MAX_SENTENCE) {
    const cut = rest.lastIndexOf('，', PET_TTS_MAX_SENTENCE);
    const at = cut > 8 ? cut + 1 : PET_TTS_MAX_SENTENCE;
    sentences.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  return { sentences, rest };
}

/**
 * @param {{
 *   apiFetch: Function,
 *   apiPostJson?: Function,
 *   Audio?: Function,
 *   URL?: object,
 *   getVoice?: () => {name?: string, muted?: boolean, rate?: number},
 *   onSentence?: (text: string) => void,
 *   onState?: (state: 'speak'|'idle') => void,
 *   onError?: (error: {code: string, hint?: string, status?: number}) => void,
 *   onIdle?: () => void,
 *   log?: (line: string) => void,
 * }} deps
 */
function petTtsCreate(deps) {
  const options = deps || {};
  const apiFetch = options.apiFetch;
  const apiPostJson = options.apiPostJson;
  const AudioCtor = typeof options.Audio === 'function' ? options.Audio : null;
  const UrlApi = options.URL || null;
  const getVoice = typeof options.getVoice === 'function' ? options.getVoice : () => ({});
  const onSentence = typeof options.onSentence === 'function' ? options.onSentence : () => {};
  const onState = typeof options.onState === 'function' ? options.onState : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const onIdle = typeof options.onIdle === 'function' ? options.onIdle : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};

  let generation = 0;
  let queue = [];
  let busy = false;
  let playing = null;
  let prefetch = null;
  let disposed = false;

  function revoke(url) {
    if (!url || !UrlApi || typeof UrlApi.revokeObjectURL !== 'function') return;
    try { UrlApi.revokeObjectURL(url); } catch { /* ignore */ }
  }

  /** 取一句的 WAV：成功 `{url,size}`，失败 `{error}`，被 stop `{stopped:true}`。 */
  async function fetchSpeech(item, gen) {
    if (typeof apiFetch !== 'function') {
      return { error: { code: 'tts-unavailable', hint: '这个版本没有接朗读接口' } };
    }
    const query = '/pet-chat/tts?text=' + encodeURIComponent(item.text)
      + '&voice=' + encodeURIComponent(item.voice || '')
      + '&rate=' + encodeURIComponent(String(item.rate));
    let res;
    let blob;
    try {
      // parse:false：**二进制体**不能交给默认的 json() 解析（流会被吃掉）；
      // 这里的 blob() 必须和它在同一个调用窗里（verify-api-client ①b 的判据）。
      res = await apiFetch(query, { parse: false, cache: 'no-store' });
      if (gen !== generation) return { stopped: true };
      if (!res || !res.ok || !res.response) {
        let hint = '';
        try {
          if (res && res.response && typeof res.response.json === 'function') {
            const doc = await res.response.json();
            hint = String((doc && doc.hint) || '');
          }
        } catch { /* 非 JSON 错误体 */ }
        return { error: { code: 'tts-failed', status: (res && res.status) || 0, hint: hint || '语音合成失败' } };
      }
      blob = await res.response.blob();
    } catch (error) {
      if (!res) return { error: { code: 'tts-network', hint: '连不上宿主，语音没出来' } };
      return { error: { code: 'tts-read-failed', hint: '读不到语音数据' } };
    }
    if (!blob || !blob.size) return { error: { code: 'tts-empty', hint: '没合成出声音' } };
    let url = '';
    if (UrlApi && typeof UrlApi.createObjectURL === 'function') {
      try { url = UrlApi.createObjectURL(blob); } catch { url = ''; }
    }
    if (!url) return { error: { code: 'tts-audio-unavailable', hint: '这个环境不能播放音频' } };
    return { url, size: blob.size };
  }

  /** 播一句；stop 时由 `entry.finish` 立即结束 Promise。 */
  function playSpeech(item, prepared, gen) {
    return new Promise((resolve) => {
      let audio;
      try {
        audio = new AudioCtor(prepared.url);
      } catch (error) {
        resolve({ code: 'tts-audio', hint: '播放器创建失败' });
        return;
      }
      const entry = { audio, url: prepared.url, finish: null };
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (playing === entry) playing = null;
        revoke(prepared.url);
        resolve(error || null);
      };
      entry.finish = finish;
      playing = entry;
      onState('speak');
      onSentence(item.text);
      audio.onended = () => finish(null);
      audio.onerror = () => finish({ code: 'tts-play-failed', hint: '这条语音播放失败' });
      try {
        const ret = audio.play();
        if (ret && typeof ret.then === 'function') {
          ret.catch(() => finish({ code: 'tts-blocked', hint: '系统拦了自动播放，点一下桌宠再试' }));
        }
      } catch (error) {
        finish({ code: 'tts-blocked', hint: '系统拦了自动播放，点一下桌宠再试' });
      }
      if (gen !== generation) finish(null);
    });
  }

  function startPrefetch(gen) {
    if (prefetch || !queue.length) return;
    const item = queue[0];
    if (item.gen !== gen) return;
    prefetch = { item, gen, promise: fetchSpeech(item, gen) };
  }

  async function pump(gen) {
    if (busy || disposed) return;
    busy = true;
    try {
      while (queue.length) {
        const item = queue[0];
        // stop 之后的新一批有自己的 pump；旧 pump 不许动它
        if (item.gen !== gen) break;
        let prepared;
        if (prefetch && prefetch.item === item && prefetch.gen === gen) {
          prepared = await prefetch.promise;
          prefetch = null;
        } else {
          prepared = await fetchSpeech(item, gen);
        }
        if (item.gen !== generation) { queue.shift(); if (prepared && prepared.url) revoke(prepared.url); break; }
        if (!prepared || prepared.error) {
          queue.length = 0;
          onState('idle');
          onError((prepared && prepared.error) || { code: 'tts-failed', hint: '语音合成失败' });
          break;
        }
        queue.shift();
        startPrefetch(gen);
        const error = await playSpeech(item, prepared, gen);
        if (item.gen !== generation) break;
        if (error) {
          queue.length = 0;
          onState('idle');
          onError(error);
          break;
        }
      }
    } finally {
      busy = false;
      if (disposed) {
        // 已销毁：不再启动下一批，也不再回调界面
      } else if (queue.length && queue[0].gen === generation) {
        // stop 之后又来了新的一批：旧 pump 收尾时把接力棒交出去
        void pump(queue[0].gen);
      } else if (gen === generation && !queue.length && !playing) {
        onState('idle');
        onIdle();
      }
    }
  }

  /** 停止：清队列 + 停当前音频 + 通知宿主作废在途合成（幂等）。 */
  function stop() {
    generation += 1;
    queue = [];
    prefetch = null;
    if (playing) {
      const entry = playing;
      playing = null;
      try { entry.audio.pause(); } catch { /* ignore */ }
      if (typeof entry.finish === 'function') entry.finish(null);
      revoke(entry.url);
    }
    onState('idle');
    if (typeof apiPostJson === 'function') {
      try {
        const ret = apiPostJson('/pet-chat/tts/stop', {});
        if (ret && typeof ret.catch === 'function') ret.catch(() => {});
      } catch { /* 停不下来也不能抛给界面 */ }
    }
    return true;
  }

  /**
   * 说一段话（会按句切开排队）。
   * @returns {boolean} 是否入队（静音 / 空文本 / 环境不支持时 false）
   */
  function speak(text, speech) {
    if (disposed) return false;
    const cfg = getVoice() || {};
    if (cfg.muted === true) { onState('idle'); return false; }
    const pieces = petTtsSplit(text);
    if (!pieces.length) return false;
    if (!AudioCtor) {
      onError({ code: 'tts-no-audio', hint: '这个环境不能播放声音' });
      return false;
    }
    const speechOpts = speech || {};
    const voice = String(speechOpts.voice || cfg.name || '');
    const rawRate = speechOpts.rate !== undefined ? speechOpts.rate : cfg.rate;
    const rate = Number.isFinite(Number(rawRate)) ? Number(rawRate) : 0;
    const gen = generation;
    for (const piece of pieces) queue.push({ text: piece, voice, rate, gen });
    log('[pet-tts] queue ' + pieces.length + ' sentence(s) voice=' + (voice || '(auto)'));
    void pump(gen);
    return true;
  }

  function isSpeaking() {
    return Boolean(playing) || queue.length > 0 || busy;
  }

  function state() {
    return { busy, playing: Boolean(playing), queued: queue.length, generation };
  }

  function dispose() {
    if (disposed) return;
    stop();
    disposed = true;
  }

  return { speak, stop, isSpeaking, state, dispose };
}

/* 供判据从产物/源码里取纯函数；浏览器侧由 pet-chat.js 构造实例。 */
