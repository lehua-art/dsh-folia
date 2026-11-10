/**
 * pet-voice-input.js — 桌宠语音输入（v0.1 核心链路）。
 *
 * 流程：唤醒 → getUserMedia → AudioWorklet（没有就 ScriptProcessor 兜底）采 PCM
 *      → 静音 1.2s 或满 15s 自动停 → 16kHz 单声道 WAV → /transcribe → /chat(SSE) → 气泡逐字。
 *
 * 为什么全部注入：录音依赖浏览器 API，Node 里跑不了；把 getUserMedia / AudioContext /
 * 两个 HTTP 调用都做成依赖，判据就能在假实现上跑完整链路（含权限拒绝、asr-not-ready、超时）。
 */
function petVoiceInputCreate(deps) {
  const options = deps || {};
  const getUserMedia = options.getUserMedia;
  const createContext = options.createContext;
  const postTranscribe = options.postTranscribe;
  const postChat = options.postChat;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const onText = typeof options.onText === 'function' ? options.onText : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const onState = typeof options.onState === 'function' ? options.onState : () => {};

  const SILENCE_MS = 1200;
  const MAX_MS = 15000;
  const SILENCE_RMS = 0.012;

  let ctx = null;
  let node = null;
  let stream = null;
  let chunks = [];
  let sampleRate = 48000;
  let startedAt = 0;
  let silenceSince = 0;
  let active = false;
  let finishing = false;

  function hardStop() {
    try { if (node) node.disconnect(); } catch { /* ignore */ }
    try { if (ctx && typeof ctx.close === 'function') void ctx.close(); } catch { /* ignore */ }
    try { if (stream && stream.getTracks) stream.getTracks().forEach((track) => track.stop()); } catch { /* ignore */ }
    ctx = null; node = null; stream = null;
  }

  /** Float32 PCM → 16kHz 单声道 PCM16 WAV（44 字节头自写）。 */
  function encodeWav(samples, rate) {
    const target = 16000;
    const ratio = rate / target;
    const frames = Math.max(1, Math.floor(samples.length / ratio));
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const put = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
    put(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); put(8, 'WAVE');
    put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, target, true); view.setUint32(28, target * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    put(36, 'data'); view.setUint32(40, frames * 2, true);
    let offset = 44;
    for (let i = 0; i < frames; i += 1) {
      const index = Math.min(samples.length - 1, Math.floor(i * ratio));
      const value = Math.max(-1, Math.min(1, samples[index] || 0));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
    return new Uint8Array(buffer);
  }

  function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    if (typeof btoa === 'function') return btoa(binary);
    return Buffer.from(bytes).toString('base64');
  }

  /** 静音判定：连续 SILENCE_MS 低于阈值 ⇒ 认为说完（每帧 update）。 */
  function feed(samples) {
    if (!active || finishing) return;
    chunks.push(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    const at = now();
    if (rms < SILENCE_RMS) {
      if (!silenceSince) silenceSince = at;
      if (at - silenceSince >= SILENCE_MS) void finish('silence');
    } else {
      silenceSince = 0;
    }
    if (at - startedAt >= MAX_MS) void finish('max');
  }

  async function finish(reason) {
    if (!active || finishing) return;
    finishing = true;
    active = false;
    onState({ state: 'transcribing', reason });
    const merged = chunks.reduce((acc, item) => acc + item.length, 0);
    const samples = new Float32Array(merged);
    let offset = 0;
    for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
    chunks = [];
    hardStop();
    const wav = encodeWav(samples, sampleRate);
    try {
      const result = await postTranscribe(base64(wav));
      const doc = result || {};
      if (doc.ok !== true) {
        onError({ code: doc.code || 'transcribe-failed', message: doc.hint || '' });
        return;
      }
      onText(String(doc.text || ''));
      if (typeof postChat === 'function' && doc.text) await postChat(String(doc.text), onState);
    } catch (error) {
      onError({ code: (error && error.code) || 'network', message: String((error && error.message) || error) });
    } finally {
      finishing = false;
    }
  }

  async function start() {
    if (active) return true;
    onState({ state: 'listening' });
    try {
      stream = await getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      onError({ code: 'permission', message: '没有麦克风权限' });
      return false;
    }
    try {
      const created = createContext(stream);
      ctx = created.context;
      sampleRate = Number(created.sampleRate) || 48000;
      node = created.node;
      node.onaudioprocess = (event) => {
        const data = event && event.inputBuffer ? event.inputBuffer.getChannelData(0) : null;
        if (data) feed(data);
      };
      node.connect(ctx.destination);
    } catch {
      onError({ code: 'no-mic', message: '打不开麦克风' });
      hardStop();
      return false;
    }
    active = true;
    startedAt = now();
    silenceSince = 0;
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    hardStop();
    onState({ state: 'idle' });
  }

  return { start, stop, feed, finish, isActive: () => active, encodeWav };
}
