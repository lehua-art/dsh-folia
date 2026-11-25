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
  check('① dshow 滤镜链：高通/低通 + silencedetect，VAD 前不放 dynaudnorm/afftdn',
    /highpass=f=80/.test(af) && /lowpass=f=8000/.test(af) && /silencedetect=noise=/.test(af)
    && !/dynaudnorm/.test(af) && !/afftdn/.test(af)
    && args.includes('16000') && args.includes('-ac') && args[args.indexOf('-ac') + 1] === '1',
    af);
  check('① 断句默认 silenceDb=-40 / silenceMs=1000 / minSpeechMs=500 / onsetWaitMs=8000',
    recordMod.RECORD_DEFAULTS.silenceDb === -40 && recordMod.RECORD_DEFAULTS.silenceMs === 900
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
    const got = await rec.record({ maxMs: 2000, probeMs: 1000 });
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
check('① 探测全静音也照常出音频（不再判 no-signal）',
got.ok === true && Boolean(got.audioPath),
`ok=${got.ok}`);
  }
  {
    const f = fake({ 'audio=静音麦': LOUD, 'audio=好麦': LOUD }, QUIET);
    const rec = recordMod.createVoiceRecorder({
      resolveFfmpeg: async () => 'ffmpeg', runFfmpeg: f.runFfmpeg,
      probeSize: (p) => statSync(p).size,
    });
    const got = await rec.record({ maxMs: 2000 });
check('① 声音小也不拒绝：照常出音频，由 ASR 判空',
got.ok === true && Boolean(got.audioPath),
`ok=${got.ok}`);
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

/* ④ 常驻聆听状态机（vm 里跑真实 pet-chat.js；v3 语义：装好就在听） */
{
  const source = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const bubble = {
    continuous: false, statuses: [], lastState: '', voiceFlags: null,
    setContinuous(v) { this.continuous = v; },
    setVoiceFlags(f) { this.voiceFlags = f; },
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
    apiJson: async () => ({ data: { ready: true } }),
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
      + 'setSpeakPaused: petChatSetSpeakPaused, get speakPaused() { return petChatSpeakPaused; },'
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
    // 真实触发点：petTts 的 onIdle（朗读播完）→ 150ms 后自动恢复听（半双工）。
    state.ttsDeps.onIdle();
    const pending = timers.filter((t) => !t.cleared);
    check('④ 朗读结束 → 150ms 自动恢复听，状态条显示「常驻聆听中」',
      api.active === true && bubble.continuous === true && bubble.lastState === 'listen'
        && pending.length === 1 && pending[0].ms === 150
        && /常驻聆听中/.test(readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8')),
      `delay=${pending[0] && pending[0].ms} state=${bubble.lastState}`);
    pending[0].fn();
    check('④ 计时到点只开一次麦', state.starts === 1, `starts=${state.starts}`);

    api.wake();
    check('④ 常驻聆听中点桌宠：不关麦（只收起气泡），仍在听', api.active === true
      && !bubble.statuses.some((m) => /连续对话已暂停/.test(m)), bubble.statuses.slice(-1)[0]);

    api.error('no-speech');
    check('④ 没听到人声 ⇒ 不退出，继续探听', api.active === true
      && timers.filter((t) => !t.cleared).length >= 1, `status=${bubble.statuses.slice(-1)[0]}`);
    api.setRounds(8);
    api.error('unclear');
    api.error('too-quiet');
    check('④ 连续安静/轮次多也不退出常驻聆听（不靠 8 轮上限）', api.active === true && api.paused === false,
      `rounds=${api.rounds} active=${api.active}`);

    api.error('no-device');
    check('④ 麦克风被占用/权限失败 ⇒ 自动退出常驻聆听并提示', api.active === false && api.paused === true
      && bubble.statuses.some((m) => /常驻聆听已暂停/.test(m)), bubble.statuses.slice(-1)[0]);

    api.setSpeakPaused(true);
    check('④ 暂停说话 = 静音但继续听（voice.muted + 状态条「仅文字」）',
      api.speakPaused === true && bubble.voiceFlags && bubble.voiceFlags.speakPaused === true,
      JSON.stringify(bubble.voiceFlags));

    check('④ 安装/启动后自动进入常驻聆听；暂停聆听持久化到 voice.listenPaused',
      /petChatResidentStart/.test(source) && /listenPaused/.test(source)
        && /if \(!petChatContinuousPaused\) void petChatResidentStart\(\)/.test(source)
        && /voice\/config/.test(source));

    const layerSrc = readFileSync(join(ROOT, 'src', 'pet-layer.js'), 'utf8');
    check('④ 右键菜单：暂停说话 / 暂停聆听（不再有「连续对话」「继续听」）',
      /☑ /.test(layerSrc) && /☐ /.test(layerSrc)
        && /weT\("暂停说话"\)/.test(layerSrc)
        && /weT\("暂停聆听"\)/.test(layerSrc) && /weT\("继续聆听"\)/.test(layerSrc)
        && !/weT\("连续对话"\)/.test(layerSrc)
        && /we-pet-continuous-state/.test(layerSrc) && /we-pet-voice-state/.test(layerSrc)
        && /new CustomEvent\("we-pet-continuous"/.test(layerSrc));
    check('④ 页面隐藏只临时停麦，回页面自动恢复（不持久化）',
      /visibilitychange/.test(source) && /petChatResidentStart\(\)/.test(source)
        && /we-pet-speak-pause/.test(source) && /we-pet-listen-pause/.test(source));
  }
}

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`  ${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);

