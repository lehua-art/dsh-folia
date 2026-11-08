/**
 * pet-chat-edge-tts.js — **edge-tts 在线情感朗读**的宿主侧实现（第二档引擎）。
 *
 * 为什么放宿主：文本要经第三方（微软），渲染进程不该直连；桌面端也没有 CORS 可言。
 * 宿主用 Node 22 自带的全局 `WebSocket` 连 Edge 的朗读端点，拿回 mp3 字节交给客户端播。
 *
 * 契约（工单阶段 2）：
 *   · `voiceEngine: 'system' | 'edge'`（默认 system）；edge = 在线、0 下载、需联网；
 *   · 风格映射：happy→cheerful、tired→gentle、angry→angry、calm→narration；
 *   · 失败（网络/接口变更/超时）⇒ 调用方回落 system，并**只记一次日志**。
 *
 * 这里的 `synthesize()` 是**可注入**的：判据用假 transport（不联网），生产用默认实现。
 */

/** 情感 → Edge SSML 的 `mstts:express-as` 风格名。 */
export const EDGE_STYLE_MAP = Object.freeze({
  happy: 'cheerful',
  tired: 'gentle',
  angry: 'angry',
  calm: 'narration',
});

/** 默认音色（中文女声；与系统音色自动挑选口径一致）。 */
export const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/** Edge 朗读端点（公开的 read-aloud 通道；接口若变更由回落兜住）。 */
export const EDGE_ENDPOINT = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
  + '?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/** 把段落包成 Edge 要求的 SSML（带情感风格）。 */
export function buildEdgeSsml({ text, emotion = 'calm', voice = EDGE_DEFAULT_VOICE, rate = 1, pitch = 1, volume = 1 } = {}) {
  const style = EDGE_STYLE_MAP[emotion] || EDGE_STYLE_MAP.calm;
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // Edge 的 rate/pitch/volume 是相对百分比字符串（+0% = 原速）
  const percent = (value) => `${Math.round((Number(value) || 1) * 100 - 100) >= 0 ? '+' : ''}${Math.round((Number(value) || 1) * 100 - 100)}%`;
  const volPercent = `${Math.round(Math.min(1, Math.max(0, Number(volume) || 1)) * 100)}%`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN">`
    + `<voice name="${voice}">`
    + `<mstts:express-as style="${style}" styledegree="1.2">`
    + `<prosody rate="${percent(rate)}" pitch="${percent(pitch)}" volume="${volPercent}">${escaped}</prosody>`
    + '</mstts:express-as></voice></speak>';
}

/** 一帧 Edge 响应的解析：二进制帧前 2 字节是大端头长度，头里带 `Path: audio`。 */
function parseEdgeFrame(frame) {
  if (typeof frame === 'string') return { kind: 'text', text: frame };
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < 2) return { kind: 'other' };
  const headerLength = (bytes[0] << 8) | bytes[1];
  const header = new TextDecoder().decode(bytes.subarray(2, 2 + headerLength));
  if (!/Path:\s*audio/i.test(header)) return { kind: 'other' };
  return { kind: 'audio', bytes: bytes.subarray(2 + headerLength) };
}

/**
 * 默认 transport：真连 Edge（Node 22 的全局 WebSocket）。
 * 返回 mp3 字节；任何异常都往上抛，由调用方回落。
 */
export async function edgeTransport({ ssml, endpoint = EDGE_ENDPOINT, timeoutMs = 15000, WebSocketImpl } = {}) {
  const WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
  if (typeof WS !== 'function') throw new Error('no-websocket');
  return new Promise((resolve, reject) => {
    const socket = new WS(endpoint);
    const chunks = [];
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      if (error) reject(error); else resolve(new Uint8Array(Buffer.concat(chunks)));
    };
    const timer = setTimeout(() => finish(new Error('edge-timeout')), timeoutMs);
    socket.binaryType = 'arraybuffer';
    socket.onerror = () => finish(new Error('edge-socket-error'));
    socket.onclose = () => { if (!settled && !chunks.length) finish(new Error('edge-closed')); };
    socket.onopen = () => {
      const now = new Date().toUTCString();
      socket.send(`X-Timestamp:${now}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},'
        + '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      socket.send(`X-RequestId:${Math.random().toString(16).slice(2)}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${now}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    };
    socket.onmessage = (event) => {
      const frame = parseEdgeFrame(event.data);
      if (frame.kind === 'audio') chunks.push(Buffer.from(frame.bytes));
      else if (frame.kind === 'text' && /Path:\s*turn\.end/i.test(frame.text)) finish(null);
    };
  });
}

/**
 * 合成一段。返回 `{ audio, mime, style }`；失败抛出（调用方负责回落 system）。
 */
export async function synthesize({ text, emotion = 'calm', voice, rate, pitch, volume, transport, timeoutMs } = {}) {
  const ssml = buildEdgeSsml({ text, emotion, voice: voice || EDGE_DEFAULT_VOICE, rate, pitch, volume });
  const run = typeof transport === 'function' ? transport : edgeTransport;
  const audio = await run({ ssml, timeoutMs });
  if (!audio || !audio.byteLength) throw new Error('edge-empty-audio');
  return { audio, mime: 'audio/mpeg', style: EDGE_STYLE_MAP[emotion] || EDGE_STYLE_MAP.calm };
}
