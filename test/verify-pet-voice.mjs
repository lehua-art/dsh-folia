/**
 * verify-pet-voice.mjs — 语音输入 6 条判据（L1–L6）。
 *
 * 录音在宿主侧（ffmpeg dshow），所以判据不碰麦克风：注入假的 runFfmpeg，
 * 用它吐出来的 silencedetect stderr 驱动"静音自动结束/15s 上限"。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel, names) => {
  const source = readFileSync(join(ROOT, rel), 'utf8');
  return new Function(`${source}; return { ${names.join(', ')} };`)();
};
const recordMod = await import('../lib/voice/record.js');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); }

const DEVICES_STDERR = `DirectShow audio devices (some may be none)
[dshow @ 0000] "Microphone (Realtek(R) Audio)" (audio)
[dshow @ 0000]   Alternative name "@device_cm_{33D9A762}\\wave_{...}"
DirectShow video devices (some may be none)
[dshow @ 0000] "HD WebCam" (video)`;

const SPEECH_STDERR = `[silencedetect @ 0000] silence_start: 0
[silencedetect @ 0000] silence_end: 0.8 | silence_duration: 0.8
[silencedetect @ 0000] silence_start: 3.4 | silence_duration: 1.2`;

/** 造一个录音器：devices 决定有没有麦克风，speech 决定 stderr。 */
function recorder({ devices = DEVICES_STDERR, speech = SPEECH_STDERR, throws = false } = {}) {
  const calls = [];
  const api = recordMod.createVoiceRecorder({
    resolveFfmpeg: async () => 'ffmpeg.exe',
    probeSize: () => 4096,
    runFfmpeg: async (ff, args, timeout) => {
      calls.push({ ff, args, timeout });
      if (throws) throw new Error('boom');
      if (args.includes('-list_devices')) return { code: 0, stderr: devices };
      return { code: 0, stderr: speech };
    },
  });
  return { api, calls };
}

/* L1 无设备 ⇒ no-device，不崩 */
{
  const { api } = recorder({ devices: 'DirectShow audio devices (some may be none)\n' });
  const result = await api.record();
  check('L1 无麦克风 ⇒ no-device（不崩）', result.ok === false && result.code === 'no-device', `code=${result.code}`);
}

/* L2 静音自动结束：silence_end 后紧跟 silence_start ⇒ 判定说完 */
{
  const parsed = recordMod.detectSpeechEnd(SPEECH_STDERR);
  const { api } = recorder();
  const result = await api.record();
  check('L2 静音 1.2s 自动结束（解析 silencedetect）',
    parsed && parsed.speechEnd === 0.8 && result.ok === true && result.speech.silenceStart === 3.4,
    `speechEnd=${parsed && parsed.speechEnd} · silenceStart=${parsed && parsed.silenceStart}`);
}

/* L3 15 秒上限：参数里带 -t，且 maxMs 透传 */
{
  const { api, calls } = recorder();
  await api.record({ maxMs: 15000 });
  const recordCall = calls.find((item) => item.args.includes('-af'));
  const tIndex = recordCall.args.indexOf('-t');
  check('L3 15s 上限（-t 与 maxMs 一致）',
    Boolean(recordCall) && Number(recordCall.args[tIndex + 1]) >= 15 && recordCall.timeout > 15000,
    `-t=${recordCall && recordCall.args[tIndex + 1]} · timeout=${recordCall && recordCall.timeout}`);
}

/* L4 没听到人声 ⇒ no-speech（不是 500） */
{
  const { api } = recorder({ speech: '[silencedetect @ 0000] silence_start: 0' });
  const result = await api.record();
  check('L4 全程静音 ⇒ no-speech', result.ok === false && result.code === 'no-speech', `code=${result.code}`);
}

/* L5 录音→转录→回答 全链路（前端用假 postRecord/postChat） */
{
  const voice = load('src/pet-voice-input.js', ['petVoiceInputCreate']).petVoiceInputCreate;
  const events = { text: [], error: [], state: [] };
  const api = voice({
    postRecord: async () => ({ ok: true, text: '帮我换张壁纸', ms: 3200 }),
    postChat: async (text, onState) => { events.text.push(text); if (onState) onState({ state: 'idle' }); },
    onText: (text) => events.text.push(text),
    onError: (error) => events.error.push(error),
    onState: (state) => events.state.push(state),
  });
  const ok = await api.start();
  check('L5 录音→转录→回答 全链路',
    ok === true && events.text[0] === '帮我换张壁纸' && events.error.length === 0,
    `ok=${ok} · text=${events.text[0]} · errors=${events.error.length}`);
}

/* L7 P6：路由闭包里必须实例化 voiceRecorder（只 import 不 new ⇒ ReferenceError） */
{
  const route = readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8');
  const instantiated = /const voiceRecorder = createVoiceRecorder\(/.test(route);
  const registered = /registerPetChatRoutes/.test(route);
  check('L7 P6 voiceRecorder 在闭包里实例化', instantiated && registered, `实例化=${instantiated}`);
}

/* L6 打字兜底仍在：前端有右键入口 + 输入条，没有 media API */
{
  const chat = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const voice = readFileSync(join(ROOT, 'src', 'pet-voice-input.js'), 'utf8');
  const both = chat + voice;
  const hasTyping = /function petChatOpenTyping\(/.test(chat) && /contextmenu/.test(chat);
  const media = /getUserMedia|AudioWorklet|ScriptProcessor/.test(both);
  // L0：刻意回归 —— typing 走 petVoiceIn.postChat，模块必须把它暴露出来
  //    （上一版只返回 start/stop，导致"输入文字后气泡毫无反应"）
  check(
    'L0 pet-voice-input 暴露 postChat（打字入口依赖）',
    /return \{ start, stop, isActive: \(\) => active, postChat \}/.test(voice),
    '模块 return 必须带 postChat（上一版漏了 ⇒ 打字后气泡毫无反应）',
  );
  check('L6 打字入口可用，且前端无 media API', hasTyping && !media, `打字入口=${hasTyping} · media=${media}`);
}

let failed = 0;
for (const item of results) {
  if (item.ok) process.stdout.write(`  ✓ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`);
  else { failed += 1; process.stdout.write(`  ✗ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`); }
}
process.stdout.write(`\n  ${results.length - failed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
