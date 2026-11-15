/**
 * voice-pre57-check.mjs — pre.57 五件事的回归判据（不碰真麦克风/真 Key）。
 *
 * ① 录音滤镜链 / 16k 单声道 / 设备 1 秒 RMS 自适应 / 太小声不送 ASR
 * ② 内置音色单一启用：activeEngine 限制回落顺序
 * ③ Azure / ElevenLabs 真实请求形状 + 401/429/超时映射 + 失败回落
 * ④ 连续对话：0.6s 自动开麦、静默 2 轮退出、连续 8 轮退出、点桌宠暂停
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TMP = mkdtempSync(join(tmpdir(), 'folia-pre57-'));

function wavPcm16({ seconds = 1, sampleRate = 16000, amplitude = 0.25 } = {}) {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * amplitude * 32767);
    data.writeInt16LE(value, i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const SILENT = wavPcm16({ amplitude: 0 });
const LOUD = wavPcm16({ amplitude: 0.3 });
const QUIET = wavPcm16({ amplitude: 0.0001 });

/* ① 录音链 + 设备自适应 + 太小声 */
{
  const recordMod = await import('../lib/voice/record.js');
  const args = recordMod.dshowArgs('麦', { maxMs: 15000 });
  const af = args[args.indexOf('-af') + 1];
  check('① dshow 滤镜链 highpass/lowpass/afftdn/dynaudnorm 全在，输出 16k 单声道',
    /highpass=f=80/.test(af) && /lowpass=f=8000/.test(af) && /afftdn=nf=-25/.test(af)
      && /dynaudnorm=f=150:g=15/.test(af)
      && args.includes('16000') && args.includes('-ac') && args[args.indexOf('-ac') + 1] === '1',
    af);
  check('① 断句默认 silenceDb=-40 / silenceMs=1000 / minSpeechMs=500 / onsetWaitMs=8000',
    recordMod.RECORD_DEFAULTS.silenceDb === -40 && recordMod.RECORD_DEFAULTS.silenceMs === 1000
      && recordMod.RECORD_DEFAULTS.minSpeechMs === 500 && recordMod.RECORD_DEFAULTS.onsetWaitMs === 8000);

  const devices = '[dshow @ x] "静音麦" (audio)\n[dshow @ x] "好麦" (audio)\n';
  const fake = (writes, actualWav) => {
    const calls = [];
    const runFfmpeg = async (ff, argv) => {
      calls.push(argv);
      if (argv.includes('-list_devices')) return { code: 0, stderr: devices };
      const out = argv[argv.length - 1];
      if (argv.join(' ').includes('probe.wav')) {
        const name = argv.find((part) => String(part).startsWith('audio='));
        writeFileSync(out, writes[name] || SILENT);
      } else {
        writeFileSync(out, actualWav);
      }
      return { code: null, signal: 'SIGTERM', stoppedByWatch: true, speechEnd: 2, stderr: 'silence_end: 0.5\nsilence_start: 2.0' };
    };
    return { calls, runFfmpeg };
  };
  {
    const f = fake({ 'audio=静音麦': SILENT, 'audio=好麦': LOUD }, LOUD);
    const rec = recordMod.createVoiceRecorder({
      resolveFfmpeg: async () => 'ffmpeg', runFfmpeg: f.runFfmpeg,
      probeSize: (p) => { try { return statSync(p).size; } catch { return 0; } },
    });
    const got = await rec.record({ maxMs: 2000 });
    check('① 两台设备先各测 1 秒，自动选有信号的好麦', got.ok === true && got.device === '好麦'
      && f.calls.filter((c) => c.join(' ').includes('probe.wav')).length === 2,
    `device=${got.device}`);
  }
  {
    const f = fake({ 'audio=静音麦': SILENT, 'audio=好麦': SILENT }, SILENT);
    const rec = recordMod.createVoiceRecorder({
      resolveFfmpeg: async () => 'ffmpeg', runFfmpeg: f.runFfmpeg,
      probeSize: (p) => statSync(p).size,
    });
    const got = await rec.record({ maxMs: 2000 });
    check('① 所有设备都没信号 ⇒ no-signal（明确提示，不静默）',
      got.ok === false && got.code === 'no-signal' && /没有收到声音/.test(String(got.hint || '')),
      got.code);
  }
  {
    const f = fake({ 'audio=静音麦': LOUD, 'audio=好麦': LOUD }, QUIET);
    const rec = recordMod.createVoiceRecorder({
      resolveFfmpeg: async () => 'ffmpeg', runFfmpeg: f.runFfmpeg,
      probeSize: (p) => statSync(p).size,
    });
    const got = await rec.record({ maxMs: 2000 });
    check('① 整段太小声 ⇒ too-quiet，不把空串送 ASR',
      got.ok === false && got.code === 'too-quiet' && /太小声/.test(String(got.hint || '')),
      got.code);
  }
}

/* ② 只让 activeEngine 参与回落 */
{
  const worker = require(join(ROOT, 'lib', 'tts', 'tts-worker.cjs'));
  check('② 在线音色失败只回落当前启用的内置音色（未启用的不参与）',
    eq(worker.policyEngineOrder('openai:alloy', false, 'edge'), ['openai', 'edge'])
      && eq(worker.policyEngineOrder('azure:x', false, 'piper'), ['azure', 'piper'])
      && eq(worker.policyEngineOrder('elevenlabs:x', false, 'sapi'), ['elevenlabs', 'sapi']),
    JSON.stringify(worker.policyEngineOrder('azure:x', false, 'piper')));
  check('② 未启用的 Piper/SAPI 不因 Edge 失败被拉进回落链',
    eq(worker.policyEngineOrder('zh-CN-XiaoxiaoNeural', false, 'edge'), ['edge'])
      && eq(worker.policyEngineOrder('piper:zh_CN-huayan-medium', false, 'edge'), ['edge']),
    JSON.stringify(worker.policyEngineOrder('piper:zh_CN-huayan-medium', false, 'edge')));
}

/* ③ Azure / ElevenLabs 请求形状 + 错误映射 + 回落 */
{
  const worker = require(join(ROOT, 'lib', 'tts', 'tts-worker.cjs'));
  const mp3 = Buffer.alloc(2048, 0);
  mp3.write('ID3', 0, 'ascii');
  const requests = [];
  let mode = 'ok';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body });
      if (mode === '401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key sk-secret-123' } }));
        return;
      }
      if (mode === '429') {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'quota' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(mp3);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const az = await worker.azureSynthesize('你好', {
      voice: 'azure:zh-CN-XiaoxiaoNeural', rate: 0, timeoutMs: 5000,
      online: { azure: { apiKey: 'az-key', region: 'eastasia', voice: 'zh-CN-XiaoxiaoNeural', endpoint: base + '/azure' } },
    });
    const azReq = requests.find((r) => r.url === '/azure');
    check('③ Azure 真请求：Ocp-Apim-Subscription-Key + SSML + 中文音色',
      az.ok === true && az.engine === 'azure' && az.mime === 'audio/mpeg'
        && azReq && azReq.headers['ocp-apim-subscription-key'] === 'az-key'
        && /<voice name='zh-CN-XiaoxiaoNeural'>/.test(azReq.body),
      `bytes=${az.bytes}`);

    const el = await worker.elevenLabsSynthesize('你好', {
      voice: 'elevenlabs:voice123', rate: 0, timeoutMs: 5000,
      online: { elevenlabs: { apiKey: 'el-key', voiceId: 'voice123', modelId: 'eleven_multilingual_v2', baseUrl: base + '/el' } },
    });
    const elReq = requests.find((r) => r.url.startsWith('/el/text-to-speech/voice123'));
    check('③ ElevenLabs 真请求：xi-api-key + Voice ID + 模型/文本',
      el.ok === true && el.engine === 'elevenlabs' && elReq
        && elReq.headers['xi-api-key'] === 'el-key'
        && /voice123/.test(elReq.url)
        && JSON.parse(elReq.body).model_id === 'eleven_multilingual_v2'
        && JSON.parse(elReq.body).text === '你好',
      `bytes=${el.bytes}`);

    mode = '401';
    const az401 = await worker.azureSynthesize('你好', {
      voice: 'azure:zh-CN-XiaoxiaoNeural', rate: 0,
      online: { azure: { apiKey: 'az-key', region: 'eastasia', endpoint: base + '/azure' } },
    });
    check('③ Azure 401 ⇒ azure-unauthorized，错误里 Key 被掩码',
      az401.ok === false && az401.code === 'azure-unauthorized' && !/sk-secret/.test(az401.error),
      az401.code);
    mode = '429';
    const el429 = await worker.elevenLabsSynthesize('你好', {
      voice: 'elevenlabs:voice123', rate: 0,
      online: { elevenlabs: { apiKey: 'el-key', voiceId: 'voice123', baseUrl: base + '/el' } },
    });
    check('③ ElevenLabs 429 ⇒ elevenlabs-rate-limited',
      el429.ok === false && el429.code === 'elevenlabs-rate-limited', el429.code);

    mode = '401';
    const fallback = await worker.synthesizePolicy('回落测试', {
      voice: 'azure:zh-CN-XiaoxiaoNeural', rate: 0, policy: true, activeEngine: 'edge',
      online: { azure: { apiKey: 'az-key', region: 'eastasia', endpoint: base + '/azure' } },
    }, {
      runEdge: async () => ({ ok: true, file: join(TMP, 'fallback.wav'), bytes: 12000, voice: 'edge-voice', mime: 'audio/wav' }),
    });
    check('③ Azure 失败自动回落到已启用 Edge，并标 fallback',
      fallback.ok === true && fallback.engine === 'edge' && fallback.fallback === true
        && fallback.attempts.some((a) => a.engine === 'azure'),
      `engine=${fallback.engine} attempts=${fallback.attempts.length}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/* ④ 连续对话状态机（vm 里跑真实 pet-chat.js） */
{
  const source = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const bubble = {
    continuous: false, statuses: [], lastState: '', setContinuous(v) { this.continuous = v; },
    setState(k) { this.lastState = k; }, status(_k, m) { this.statuses.push(String(m)); }, hide() {}, hideStatus() {},
    isVisible() { return false; }, clear() {}, append() {}, dispose() {},
  };
  const timers = [];
  const state = { starts: 0, voiceDeps: null, ttsDeps: null };
  const sandbox = {
    console,
    setTimeout: (fn, ms) => { const id = { fn, ms, cleared: false }; timers.push(id); return id; },
    clearTimeout: (id) => { if (id) id.cleared = true; },
    weT: (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => (o && o[k] !== undefined ? o[k] : '{' + k + '}')),
    petBubbleCreate: () => bubble,
    petBubble: bubble,
    petTtsCreate: (deps) => {
      state.ttsDeps = deps;
      return { speak: () => true, stop: () => {}, isSpeaking: () => false };
    },
    petVoiceInputCreate: (deps) => {
      state.voiceDeps = deps;
      return {
        start: async () => { state.starts += 1; return true; },
        stop: () => {}, postChat: async () => {},
      };
    },
    petTtsSentences: () => ({ sentences: [], rest: '' }),
    apiJson: async () => ({ data: {} }),
    apiPostJson: async () => ({ data: {} }),
    apiFetch: async () => ({ ok: false }),
    apiUrl: (p) => p,
    ensureAsrReady: async () => true,
    EventSource: function EventSource() { this.close = () => {}; },
    document: undefined,
    window: { addEventListener() {}, removeEventListener() {} },
  };
  let api;
  try {
    runInNewContext(source + '\n;globalThis.__PRE57__ = {'
      + 'start: petChatContinuousStart, arm: petChatContinuousArm, stop: petChatContinuousStop,'
      + 'error: petChatContinuousVoiceError, wake: petChatWake,'
      + 'get active() { return petChatContinuousActive; },'
      + 'get paused() { return petChatContinuousPaused; },'
      + 'get rounds() { return petChatContinuousRounds; },'
      + 'setRounds(n) { petChatContinuousRounds = n; },'
      + 'setEnabled(v) { petChatContinuousEnabled = v; }'
      + '};', sandbox, { filename: 'pet-chat.js' });
    api = sandbox.__PRE57__;
  } catch (error) {
    check('④ pet-chat.js 可在假环境加载', false, String((error && error.message) || error));
  }
  if (api) {
    api.start();
    // 真实触发点：petTts 的 onIdle（朗读播完）→ 连续对话计时。
    state.ttsDeps.onIdle();
    const pending = timers.filter((t) => !t.cleared);
    check('④ 朗读结束 → 0.5–0.8s 自动开麦，状态条显示「连续对话中·点桌宠暂停」',
      api.active === true && bubble.continuous === true && bubble.lastState === 'listen'
        && pending.length === 1 && pending[0].ms >= 500 && pending[0].ms <= 800
        && /连续对话中·点桌宠暂停/.test(readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8')),
      `delay=${pending[0] && pending[0].ms} state=${bubble.lastState}`);
    pending[0].fn();
    check('④ 计时到点只开一次麦', state.starts === 1, `starts=${state.starts}`);

    api.wake();
    check('④ 点桌宠暂停：连续对话立即退出并给提示', api.active === false
      && bubble.statuses.some((m) => /连续对话已暂停/.test(m)), bubble.statuses.slice(-1)[0]);

    api.start();
    api.error('no-speech');
    check('④ 第 1 轮静默 ⇒ 自动重听（还不到 2 轮）', api.active === true
      && timers.filter((t) => !t.cleared).length >= 1, `status=${bubble.statuses.slice(-1)[0]}`);
    api.error('no-speech');
    check('④ 静默 2 轮 ⇒ 退出连续对话', api.active === false
      && bubble.statuses.some((m) => /连续 2 轮没听到/.test(m)), bubble.statuses.slice(-1)[0]);

    api.start();
    api.setRounds(8);
    api.arm();
    check('④ 连续 8 轮 ⇒ 自动退出', api.active === false
      && bubble.statuses.some((m) => /已连续 8 轮/.test(m)), bubble.statuses.slice(-1)[0]);

    check('④ 设置项默认开启；点桌宠时先判连续对话并暂停',
      /continuous: true/.test(source) && /continuous !== false/.test(source)
        && /if \(petChatContinuousActive \|\| petChatContinuousTimer != null\)/.test(source)
        && /连续对话已暂停/.test(source));
  }
}

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`  ${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
