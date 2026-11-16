/**
 * verify-pet-voice.mjs — 语音输入 6 条判据（L1–L6）。
 *
 * 录音在宿主侧（ffmpeg dshow），所以判据不碰麦克风：注入假的 runFfmpeg，
 * 用它吐出来的 silencedetect stderr 驱动"静音自动结束/15s 上限"。
 */
import { readFileSync, statSync } from 'node:fs';
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
function recorder({ devices = DEVICES_STDERR, speech = SPEECH_STDERR, throws = false, stopped = false } = {}) {
  const calls = [];
  const api = recordMod.createVoiceRecorder({
    resolveFfmpeg: async () => 'ffmpeg.exe',
    probeSize: () => 4096,
    runFfmpeg: async (ff, args, timeout) => {
      calls.push({ ff, args, timeout });
      if (throws) throw new Error('boom');
      if (args.includes('-list_devices')) return { code: 0, stderr: devices };
      if (stopped) return { code: 1, stderr: '', stoppedByWatch: true, speechEnd: 1.4 };
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
check('L3 上限：-t 不超过 maxMs+2（窗口固定，不 kill 避免 0 字节）',
  Boolean(recordCall) && Number(recordCall.args[tIndex + 1]) > 0 && Number(recordCall.args[tIndex + 1]) <= 17,
    `-t=${recordCall && recordCall.args[tIndex + 1]} · timeout=${recordCall && recordCall.timeout}`);
}

/* L4 没听到人声 ⇒ no-speech（不是 500） */
{
  const { api } = recorder({ speech: '[silencedetect @ 0000] silence_start: 0' });
  const result = await api.record();
  check('L4 全程静音：录制成功（交给路由判空）', result.ok === true && Boolean(result.audioPath), `ok=${result.ok}`);
}

/* L4b pre.54：SIGTERM 自动停机 code!=0，但 stoppedByWatch=true ⇒ 必须当成功 */
{
  const { api } = recorder({ stopped: true });
  const result = await api.record();
  check('L4b 自动停机（SIGTERM, code=1, stoppedByWatch）⇒ ok，speechEnd 用 result.speechEnd 兜底',
    result.ok === true && result.speech && result.speech.auto === true
      && Number(result.speech.speechEnd) === 1.4 && result.audioSeconds === 1.4,
    JSON.stringify({ ok: result.ok, code: result.code, speech: result.speech, audioSeconds: result.audioSeconds }));
}

/* L4c pre.54/pre.63：stdin/stderr 不能开管道（DSH 沙箱 EPERM）；流式只允许 stdout pipe */
{
  const src = readFileSync(join(ROOT, 'lib', 'voice', 'record.js'), 'utf8');
  check('L4c record.js：stdin/stderr 不开 pipe，流式仅 stdout pipe；停机用 kill(SIGTERM)',
    /stdio:\s*\['ignore',\s*'ignore',/.test(src)
      && /stdio:\s*\['ignore',\s*'pipe',/.test(src)
      && !/stdio:\s*\['pipe'/.test(src)
      && !/'pipe',\s*'pipe'/.test(src)
      && /child\.kill\('SIGTERM'\)/.test(src),
    'stdin=ignore / stdout=pipe / kill=SIGTERM');
}

/* L4d pre.63：流式 VAD —— 开口后静音 700ms 结束（0.7s，不再等固定 6s） */
{
  const sr = 16000;
  const frame = 640;
  const makePcm = (seconds, amp) => {
    const bytes = Math.round(sr * seconds) * 2;
    const b = Buffer.alloc(bytes);
    for (let i = 0; i < bytes / 2; i += 1) b.writeInt16LE(Math.round(Math.sin(i * 0.3) * amp * 32767), i * 2);
    return b;
  };
  const vad = recordMod.createPcmVad({ sampleRate: sr, silenceMs: 700, noOnsetMs: 8000 });
  let state = { done: false };
  for (const chunk of [makePcm(0.4, 0.001), makePcm(0.8, 0.2), makePcm(1.0, 0.001)]) {
    for (let i = 0; i < chunk.length && !state.done; i += frame) state = vad.push(chunk.subarray(i, i + frame));
  }
  const vr = vad.result();
  check('L4d RMS VAD：0.8s 人声 + 0.7s 静音 ⇒ 立刻结束，speechEnd 不含尾部静音',
    state.done === true && state.reason === 'silence' && vr.speechEnd === 1.2
      && vr.endSilenceMs === 700 && vr.onsetMs > 0,
    JSON.stringify({ state, vr }));

  // record() 的流式路径：假的 runFfmpegStream 直接给 PCM，不碰真麦克风。
  const pcm = Buffer.concat([makePcm(0.3, 0.001), makePcm(0.6, 0.2), makePcm(0.8, 0.001)]);
  const api = recordMod.createVoiceRecorder({
    resolveFfmpeg: async () => 'ffmpeg.exe',
    runFfmpeg: async (ff, args) => {
      if (args.includes('-list_devices')) return { code: 0, stderr: '[dshow @ x] "麦克风 (Test)" (audio)\n' };
      return { code: 0, stderr: '' };
    },
    runFfmpegStream: async () => ({
      ok: true, pcm, speechEnd: 0.9, onsetMs: 300, endSilenceMs: 800,
      reason: 'silence', noOnset: false, unsupported: false,
    }),
    probeSize: (p) => { try { return statSync(p).size; } catch { return 0; } },
  });
  const got = await api.record({ maxMs: 15000 });
  check('L4e record() 走流式：内存 PCM 补 WAV 头落盘，speech.stream=true',
    got.ok === true && got.speech && got.speech.stream === true
      && got.speech.speechEnd === 0.9 && got.bytes > 44 && got.audioSeconds === 0.9,
    JSON.stringify({ ok: got.ok, bytes: got.bytes, speech: got.speech, audioSeconds: got.audioSeconds }));
  const streamArgs = recordMod.streamArgs('麦克风', {});
  check('L4f 流式参数：16k/单声道/pcm_s16le/s16le stdout，不含文件输出',
    streamArgs.includes('pcm_s16le') && streamArgs.includes('s16le') && streamArgs[streamArgs.length - 1] === '-'
      && streamArgs[streamArgs.indexOf('-ar') + 1] === '16000' && streamArgs[streamArgs.indexOf('-ac') + 1] === '1',
    JSON.stringify(streamArgs));
}
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
