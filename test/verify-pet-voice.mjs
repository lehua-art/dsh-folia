/**
 * verify-pet-voice.mjs — 语音输入（v0.1 核心）6 条判据。
 *
 * 用假 getUserMedia / 假 AudioContext / 假 HTTP：链路本身（静音判定、15s 上限、
 * WAV 头、失败分支）都是真代码，只有浏览器 API 被替换。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'src', 'pet-voice-input.js'), 'utf8');
const create = new Function(`${source}; return { petVoiceInputCreate };`)().petVoiceInputCreate;

const results = [];
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); }

/** 假时钟 + 假录音环境；feed 用固定音量模拟"说话/静音"。 */
function harness({ transcribe, chat, permission = true } = {}) {
  let clock = 1000;
  const sent = { transcribe: [], chat: [] };
  const events = { text: [], error: [], state: [] };
  const node = { onaudioprocess: null, connect() {}, disconnect() {} };
  const ctx = { destination: {}, close() {} };
  const api = create({
    now: () => clock,
    getUserMedia: async () => {
      if (!permission) throw new Error('NotAllowedError');
      return { getTracks: () => [{ stop() {} }] };
    },
    createContext: () => ({ context: ctx, node, sampleRate: 48000 }),
    postTranscribe: async (b64) => { sent.transcribe.push(b64); return transcribe ? transcribe(b64) : { ok: true, text: '你好' }; },
    postChat: async (text, onState) => { sent.chat.push(text); if (chat) chat(text, onState); },
    onText: (text) => events.text.push(text),
    onError: (error) => events.error.push(error),
    onState: (state) => events.state.push(state),
  });
  const tick = (ms) => { clock += ms; };
  const say = (loud = true) => {
    const samples = new Float32Array(480);
    samples.fill(loud ? 0.2 : 0);
    node.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
  };
  return { api, sent, events, tick, say };
}

/* ① 全链路：说话 → 静音 1.2s 自动停 → 转录 → SSE 回复 */
{
  const h = harness();
  const started = await h.api.start();
  for (let i = 0; i < 5; i += 1) { h.say(true); h.tick(100); }
  for (let i = 0; i < 13; i += 1) { h.say(false); h.tick(100); }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const wav = h.sent.transcribe[0] ? Buffer.from(h.sent.transcribe[0], 'base64') : null;
  const header = wav ? wav.subarray(0, 12).toString('latin1') : '';
  check('① 说话→静音→转录→回答 全链路',
    started && h.sent.transcribe.length === 1 && header.startsWith('RIFF') && wav.readUInt32LE(24) === 16000
      && h.events.text[0] === '你好' && h.sent.chat[0] === '你好',
    `transcribe=${h.sent.transcribe.length} · 头=${header.slice(0, 4)} · 采样率=${wav ? wav.readUInt32LE(24) : '-'} · text=${h.events.text[0]}`);
}

/* ② 权限拒绝 → onError('permission')，并标记需要打字兜底 */
{
  const h = harness({ permission: false });
  const started = await h.api.start();
  check('② 无麦克风权限 ⇒ permission 错误（触发打字兜底）',
    started === false && h.events.error[0] && h.events.error[0].code === 'permission',
    `started=${started} · code=${h.events.error[0] && h.events.error[0].code}`);
}

/* ③ transcribe 返回 asr-not-ready ⇒ 原样透出 */
{
  const h = harness({ transcribe: () => ({ ok: false, code: 'asr-not-ready', hint: '请在 DSH 设置启用语音输入' }) });
  await h.api.start();
  h.say(true); h.tick(100);
  for (let i = 0; i < 13; i += 1) { h.say(false); h.tick(100); }
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('③ asr-not-ready ⇒ 提示去 DSH 开启（不误报网络错）',
    h.events.error[0] && h.events.error[0].code === 'asr-not-ready' && h.sent.chat.length === 0,
    `code=${h.events.error[0] && h.events.error[0].code}`);
}

/* ④ 15 秒上限：一直说话也会被强制结束 */
{
  const h = harness();
  await h.api.start();
  for (let i = 0; i < 160; i += 1) { h.say(true); h.tick(100); }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const states = h.events.state.filter((item) => item.state === 'transcribing');
  check('④ 说话不停 ⇒ 15 秒强制停止',
    states.length === 1 && states[0].reason === 'max' && h.sent.transcribe.length === 1,
    `reason=${states[0] && states[0].reason} · transcribe=${h.sent.transcribe.length}`);
}

/* ⑤ 静音自动结束（不到 15 秒） */
{
  const h = harness();
  await h.api.start();
  for (let i = 0; i < 3; i += 1) { h.say(true); h.tick(100); }
  for (let i = 0; i < 13; i += 1) { h.say(false); h.tick(100); }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const states = h.events.state.filter((item) => item.state === 'transcribing');
  check('⑤ 连续静音 1.2 秒 ⇒ 自动结束',
    states.length === 1 && states[0].reason === 'silence',
    `reason=${states[0] && states[0].reason}`);
}

/* ⑥ 打字兜底：错误回调显式带出"可以打字"的信号（面板据此提示） */
{
  const h = harness({ transcribe: () => ({ ok: false, code: 'timeout', hint: '重试一次' }) });
  await h.api.start();
  h.say(true); h.tick(100);
  for (let i = 0; i < 13; i += 1) { h.say(false); h.tick(100); }
  await new Promise((resolve) => setTimeout(resolve, 30));
  const err = h.events.error[0] || {};
  check('⑥ 超时/网络失败 ⇒ 提示重试（可打字兜底）',
    err.code === 'timeout' && h.sent.chat.length === 0,
    `code=${err.code}`);
}

let failed = 0;
for (const item of results) {
  if (item.ok) process.stdout.write(`  ✓ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`);
  else { failed += 1; process.stdout.write(`  ✗ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`); }
}
process.stdout.write(`\n  ${results.length - failed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
