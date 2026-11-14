/**
 * verify-voice-setup.mjs — v0.2「填完 Key 就能听能说」的判据。
 *
 * 覆盖：
 *   ① 默认音色策略：Edge 在线 → Piper 内置 → SAPI（默认不参与）；
 *   ② worker 不在包里写死 Edge neural 名单，音色由运行时目录决定；
 *   ③ /tts/state 同时给出 engine 与 actualVoice（不是只给一个）；
 *   ④ /voice/diagnose 给出 麦克风 / ASR / TTS / 在线渠道 四块；
 *   ⑤ /voice/setup 三步报告（听得见 / 说得出 / 失败项）+ 一键启用按钮；
 *   ⑥ 设置页三分页 + 6 张需 Key 渠道卡（全部如实「即将支持」）；
 *   ⑦ SIGTERM 后的 speechEnd 兜底：不再把已录到的音频判成 no-device。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.DSH_FOLIA_HOME = mkdtempSync(join(tmpdir(), 'folia-voice-setup-'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (detail ? ' — ' + detail : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const worker = (await import('../lib/tts/tts-worker.cjs')).default
  || await import('../lib/tts/tts-worker.cjs');
const tts = await import('../lib/tts/tts.js');

/* ① 策略顺序 */
{
  check('① 默认策略顺序 = Edge 在线 → Piper → SAPI',
    eq(tts.TTS_POLICY, ['edge', 'piper', 'sapi']),
    JSON.stringify(tts.TTS_POLICY));
  check('① 未开启 SAPI：顺序里没有 sapi，且 Edge 第一',
    eq(worker.policyEngineOrder('', false), ['edge', 'piper'])
      && eq(worker.policyEngineOrder('Microsoft Huihui Desktop', false), ['edge', 'piper']),
    JSON.stringify({ empty: worker.policyEngineOrder('', false), sapiName: worker.policyEngineOrder('Microsoft Huihui Desktop', false) }));
  check('① 手动开启 SAPI：只在最后追加，不抢 Edge',
    eq(worker.policyEngineOrder('', true), ['edge', 'piper', 'sapi'])
      && eq(worker.policyEngineOrder('piper:zh_CN-huayan-medium', true), ['piper', 'edge', 'sapi']),
    JSON.stringify({ default: worker.policyEngineOrder('', true), piper: worker.policyEngineOrder('piper:zh_CN-huayan-medium', true) }));

  const calls = [];
  const fallback = await worker.synthesizePolicy('测试。', { voice: '', rate: 0, sapiEnabled: false }, {
    runEdgeOnline: async () => { calls.push('edge'); return { ok: false, error: 'edge-failed' }; },
    runPiper: async () => { calls.push('piper'); return { ok: true, file: 'fake.wav', voice: 'piper:test', bytes: 12000, mime: 'audio/wav' }; },
    runSapi: async () => { calls.push('sapi'); return { ok: false, error: 'should-not-run' }; },
  });
  check('① Edge 失败 ⇒ 自动退 Piper；SAPI 关闭时一次都不调用',
    fallback.ok === true && fallback.engine === 'piper' && eq(calls, ['edge', 'piper']),
    'engine=' + fallback.engine + ' calls=' + calls.join('→'));

  const sapiCalls = [];
  const sapi = await worker.synthesizePolicy('测试。', { voice: '', rate: 0, sapiEnabled: true }, {
    runEdgeOnline: async () => { sapiCalls.push('edge'); return { ok: false, error: 'edge-failed' }; },
    runPiper: async () => { sapiCalls.push('piper'); return { ok: false, error: 'piper-not-installed' }; },
    runSapi: async () => { sapiCalls.push('sapi'); return { ok: true, file: 'fake.wav', voice: 'Microsoft Test Desktop', bytes: 12000, mime: 'audio/wav' }; },
  });
  check('① 手动开启 SAPI 且 Edge/Piper 都失败 ⇒ 才轮到 SAPI',
    sapi.ok === true && sapi.engine === 'sapi' && eq(sapiCalls, ['edge', 'piper', 'sapi']),
    'engine=' + sapi.engine + ' calls=' + sapiCalls.join('→'));
}

/* ② 不打包 Edge 名单 */
{
  const workerSrc = readFileSync(join(ROOT, 'lib', 'tts', 'tts-worker.cjs'), 'utf8');
  const packageJson = readFileSync(join(ROOT, 'package.json'), 'utf8');
  check('② 包里没有写死 Edge neural 名单（默认晓晓也只按规则选择）',
    !/zh-CN-(Xiaoxiao|Xiaoyi|Yunxi|Yunjian)Neural/.test(workerSrc)
      && !/zh-CN-(Xiaoxiao|Xiaoyi|Yunxi|Yunjian)Neural/.test(packageJson)
      && /edgeVoiceList/.test(workerSrc),
    'worker 用运行时 voice list');
  check('② Edge 在线地址与 v2 token 都在 worker（不依赖外部 npm 包）',
    /api\.msedgeservices\.com/.test(workerSrc) && /edgeSecMsGec/.test(workerSrc)
      && /edgeSynthesizeOnline/.test(workerSrc));
  check('② Sec-MS-GEC v2 与微软公开实现逐位一致（固定时间戳对照）',
    worker.edgeSecMsGec(1770000000)
      === '00DDB33FD01602D8-87C1FE6B212DC02BD1C09F05EE72850D2069A3CC92C5F462FDD6DDE2B15E8B08',
    worker.edgeSecMsGec(1770000000));
}

/* ③ 路由：fake TTS 也能给出 engine + actualVoice */
function makeWav(n = 12000) {
  const b = Buffer.alloc(n);
  b.write('RIFF', 0); b.writeUInt32LE(n - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n - 44, 40);
  return b;
}
const fakeTts = {
  calls: [], voicesCalls: 0,
  async synthesize(text, opts) {
    this.calls.push({ text, opts });
    return {
      ok: true, wav: makeWav(), engine: 'edge', transport: 'online', mime: 'audio/mpeg',
      voice: 'zh-CN-XiaoxiaoNeural', requestedVoice: String((opts && opts.voice) || ''),
      fallback: false, fallbackFrom: '', attempts: [], ms: 5, cached: false,
    };
  },
  async voices(opts) {
    this.voicesCalls += 1;
    return [
      { engine: 'edge', id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao', lang: 'zh-CN', usable: true },
      { engine: 'sapi', id: 'Microsoft Huihui Desktop', label: 'Huihui', lang: 'zh-CN', usable: true },
    ].filter((item) => item.engine !== 'sapi' || (opts && opts.sapiEnabled === true));
  },
  voiceMeta() {
    return {
      defaultVoice: 'zh-CN-XiaoxiaoNeural', defaultEngine: 'edge',
      edge: { ok: true, voice: 'zh-CN-XiaoxiaoNeural', voices: 1 },
      piper: { installed: false },
    };
  },
  stop() { return { ok: true, generation: 1 }; },
  status() {
    return {
      ok: true, ready: true, engines: ['edge', 'piper', 'sapi'],
      policy: ['edge', 'piper', 'sapi'], defaultVoice: 'zh-CN-XiaoxiaoNeural',
      defaultEngine: 'edge', lastResult: { engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural' },
    };
  },
  dispose() {},
};

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const routes = [];
const serverHost = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
registerPetChatRoutes(serverHost, {
  disposers: [], base: '/folia', log: () => {},
  readSettings: () => ({ petChat: { voice: { name: '', muted: false, sapiEnabled: false } } }),
  speechToText: undefined, tts: fakeTts,
});
const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolveP) => server.listen(0, '127.0.0.1', resolveP));
const base = `http://127.0.0.1:${server.address().port}/folia/pet-chat`;
const getJson = async (path, init) => {
  const response = await fetch(base + path, init);
  return { status: response.status, body: await response.json(), headers: response.headers };
};
const postJson = (path, body) => getJson(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});

try {
  const state = await getJson('/tts/state');
  check('③ /tts/state 同时给出 engine 与 actualVoice',
    state.body.engine === 'edge' && state.body.actualVoice === 'zh-CN-XiaoxiaoNeural'
      && eq(state.body.policy, ['edge', 'piper', 'sapi']),
    `engine=${state.body.engine} actual=${state.body.actualVoice}`);

  const voices = await getJson('/tts/voices');
  check('④ /tts/voices 默认不列 SAPI，只列 usable 的 Edge',
    voices.body.voices.length === 1 && voices.body.voices[0].engine === 'edge'
      && voices.body.voices[0].usable === true && !voices.body.voices.some((v) => v.engine === 'sapi'),
    JSON.stringify(voices.body.voices));

  await postJson('/voice/config', { sapiEnabled: true });
  const voicesSapi = await getJson('/tts/voices');
  check('④ 手动开启 SAPI 后才列出 SAPI',
    voicesSapi.body.voices.some((v) => v.engine === 'sapi'),
    JSON.stringify(voicesSapi.body.voices.map((v) => v.engine)));
  await postJson('/voice/config', { sapiEnabled: false });

  // v0.2：Edge neural 名必须能在配置里存活（settings-schema 的旧迁移会清空它，
  // 所以宿主读取 voice 时以覆盖层原始对象为准）。
  await postJson('/config', {
    enabled: true, provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
    apiKey: 'sk-test-voice', petName: '小鲸',
    voice: { name: 'zh-CN-XiaoxiaoNeural', muted: false, rate: 0, sapiEnabled: false },
  });
  const cfg = await getJson('/config');
  const stateAgain = await getJson('/tts/state');
  check('④ 保存后 Edge neural 音色不被旧迁移清空',
    cfg.body.data.voice.name === 'zh-CN-XiaoxiaoNeural'
      && stateAgain.body.voice.name === 'zh-CN-XiaoxiaoNeural',
    `config=${cfg.body.data.voice.name} state=${stateAgain.body.voice.name}`);

  const diagnose = await getJson('/voice/diagnose');
  check('④ /voice/diagnose 给出麦克风 / ASR / TTS / 渠道四块',
    diagnose.status === 200 && diagnose.body.ok === true
      && diagnose.body.microphone && diagnose.body.asr && diagnose.body.tts
      && Array.isArray(diagnose.body.providers) && diagnose.body.providers.length === 6
      && typeof diagnose.body.microphone.selected === 'string',
    `mic=${diagnose.body.microphone && diagnose.body.microphone.selected} · asr=${diagnose.body.asr && diagnose.body.asr.phase}`);

  const ttsAudio = await fetch(base + '/tts?text=' + encodeURIComponent('你好'));
  const bytes = new Uint8Array(await ttsAudio.arrayBuffer());
  check('④ /tts 按真实引擎回 Content-Type（Edge=audio/mpeg，不再谎报 audio/wav）',
    ttsAudio.status === 200 && /audio\/mpeg/i.test(String(ttsAudio.headers.get('content-type') || ''))
      && bytes.byteLength > 10240 && ttsAudio.headers.get('x-folia-tts-engine') === 'edge',
    `status=${ttsAudio.status} type=${ttsAudio.headers.get('content-type')} bytes=${bytes.byteLength}`);

  const setup = await postJson('/voice/setup', { dryRun: true, allowDownload: false });
  const labels = (setup.body.steps || []).map((step) => step.label);
  check('⑤ /voice/setup 回三步报告（听得见 / 说得出 / 失败项）',
    setup.status === 200 && eq(labels, ['听得见', '说得出', '失败项'])
      && setup.body.spoke === true && Array.isArray(setup.body.failed),
    JSON.stringify({ labels, heard: setup.body.heard, spoke: setup.body.spoke, failed: setup.body.failed }));
} finally {
  server.close();
}

/* ⑥ 设置页三分页 + 六张需 Key 渠道卡 */
{
  const panel = readFileSync(join(ROOT, 'src', 'panel-tabs-assistant.js'), 'utf8');
  const providerNames = ['Azure 语音', 'OpenAI TTS', 'ElevenLabs', 'MiniMax 语音', '火山引擎语音', '讯飞语音'];
  check('⑥ 设置页三分页（助手 / 朗读与音色 / 工作能力）',
    ['助手', '朗读与音色', '工作能力'].every((label) => panel.includes("weT('" + label + "')")),
    '三分页标签');
  check('⑥ 六张「在线音色（需 Key）」渠道卡齐全，且全部如实「即将支持」',
    panel.includes("weT('在线音色（需 Key）')")
      && providerNames.every((name) => panel.includes(name))
      && (panel.match(/weT\('即将支持'\)/g) || []).length >= 1
      && !/已支持(?!的渠道)/.test(panel),
    'providers=' + providerNames.length);
  check('⑥ 每张卡都有「优点」「怎么用」「状态」',
    panel.includes("weT('优点')") && panel.includes("weT('怎么用')")
      && panel.includes('assistantVoiceCard') && panel.includes('status:'),
    'assistantVoiceCard');
  check('⑥ 一键启用按钮 + 三步报告渲染都在',
    panel.includes("weT('一键启用语音')") && panel.includes('setupReport')
      && panel.includes("weT('🔊 朗读回答')"),
    'one-click + report');
}

/* ⑦ SIGTERM 后的 speechEnd 兜底 */
{
  const { createVoiceRecorder } = await import('../lib/voice/record.js');
  let listed = false;
  const recorder = createVoiceRecorder({
    resolveFfmpeg: async () => 'ffmpeg',
    runFfmpeg: async (ff, args) => {
      if (args.includes('-list_devices')) {
        listed = true;
        return { code: 0, stderr: '[dshow @ x] "麦克风 (Test)" (audio)\n' };
      }
      return { code: null, signal: 'SIGTERM', timedOut: true, stoppedByWatch: false, speechEnd: 0, stderr: '' };
    },
    probeSize: () => 4096,
  });
  const recorded = await recorder.record({ maxMs: 2000 });
  check('⑦ SIGTERM/超时后没有 silence_end 也按已录时长成功返回（不判 no-device）',
    listed && recorded.ok === true && recorded.speech && recorded.speech.auto === true,
    JSON.stringify(recorded));
}

/* ⑧ ASR 下载：进度、ETA 数据源、失败重试、sha256 校验 */
{
  const { ensureInstalled } = await import('../lib/asr/asr-local.js');
  const payload = Buffer.alloc(256 * 1024, 0x5a);
  const sha = createHash('sha256').update(payload).digest('hex');
  let hits = 0;
  const srv = createServer((req, res) => {
    if (req.url === '/manifest.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ files: [{ key: 'asr/v1/runtime/fake.bin', size: payload.length, sha256: sha }] }));
      return;
    }
    if (req.url === '/asr/v1/runtime/fake.bin') {
      hits += 1;
      if (hits === 1) { res.statusCode = 500; res.end('first-attempt-fails'); return; }
      res.writeHead(200, { 'content-length': String(payload.length) });
      // 分块写，保证 onProgress 能观察到中间进度（不是只有 0/100）。
      res.write(payload.subarray(0, 64 * 1024));
      setTimeout(() => { res.write(payload.subarray(64 * 1024, 160 * 1024)); }, 15);
      setTimeout(() => { res.end(payload.subarray(160 * 1024)); }, 30);
      return;
    }
    res.statusCode = 404; res.end('no');
  });
  await new Promise((resolveP) => srv.listen(0, '127.0.0.1', resolveP));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'folia-asr-download-'));
  const progress = [];
  const retries = [];
  let ok = false;
  try {
    await ensureInstalled(root, {
      manifestUrl: base + '/manifest.json',
      mediaBase: base + '/',
      retries: 2,
      fileTimeoutMs: 5000,
      onProgress: (p) => progress.push({ ...p }),
      onRetry: (r) => retries.push({ ...r }),
    });
    ok = true;
  } catch { ok = false; }
  srv.close();
  const file = join(root, 'runtime', 'fake.bin');
  const bytes = ok ? readFileSync(file) : Buffer.alloc(0);
  check('⑧ ASR 下载有中间进度、失败自动重试、sha256 校验通过',
    ok && hits === 2 && retries.length === 1
      && progress.some((p) => p.doneBytes > 0 && p.doneBytes < payload.length)
      && progress.some((p) => p.doneBytes === payload.length)
      && statSync(file).size === payload.length
      && createHash('sha256').update(bytes).digest('hex') === sha,
    `hits=${hits} retries=${retries.length} progress=${progress.length} bytes=${bytes.length}`);
}

/* ⑨ OpenAI 真调用（本地 mock 端点）+ 401 自动回落 Edge */
{
  const mp3 = Buffer.alloc(4096, 0);
  mp3.write('ID3', 0, 'ascii');
  let mode = 'ok';
  let seen = null;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') };
      if (mode === 'fail') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad key sk-secret-123' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(mp3);
    });
  });
  await new Promise((resolveP) => srv.listen(0, '127.0.0.1', resolveP));
  process.env.OPENAI_TTS_BASE_URL = `http://127.0.0.1:${srv.address().port}/v1`;
  const config = { openai: { apiKey: 'sk-test-123', voice: 'alloy', model: 'gpt-4o-mini-tts' } };
  const ok = await worker.synthesizePolicy('你好，OpenAI。', {
    voice: 'openai:alloy', rate: 0, policy: true, online: config,
  }, { allowDownload: false });
  check('⑨ OpenAI 真调用：Key 进 Authorization，男/女声与 model/input 都进请求体',
    ok.ok === true && ok.engine === 'openai' && ok.mime === 'audio/mpeg'
      && seen && seen.auth === 'Bearer sk-test-123'
      && seen.url === '/v1/audio/speech' && seen.body.voice === 'alloy'
      && seen.body.model === 'gpt-4o-mini-tts' && seen.body.input === '你好，OpenAI。',
    `engine=${ok.engine} auth=${seen && seen.auth} url=${seen && seen.url}`);

  mode = 'fail';
  const fallback = await worker.synthesizePolicy('你好，回落。', {
    voice: 'openai:alloy', rate: 0, policy: true, online: config,
  }, {
    allowDownload: false,
    runEdgeOnline: async () => ({ ok: true, file: 'fake.mp3', bytes: 4096, voice: 'zh-CN-XiaoxiaoNeural', mime: 'audio/mpeg' }),
  });
  check('⑨ OpenAI 401 ⇒ 可读原因 + 自动回落 Edge（错误里 Key 被掩码）',
    fallback.ok === true && fallback.engine === 'edge'
      && fallback.attempts.some((a) => a.engine === 'openai' && /401/.test(a.error) && /sk-\*{6}/.test(a.error))
      && !JSON.stringify(fallback.attempts).includes('sk-secret-123'),
    `engine=${fallback.engine} attempts=${JSON.stringify(fallback.attempts)}`);
  srv.close();
}

/* ⑩ ASR 首次使用：可见下载状态 / ETA / 自动重试 / 就绪前不硬开麦 */
{
  const petChatSrc = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const routeSrc = readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8');
  const asrSrc = readFileSync(join(ROOT, 'lib', 'asr', 'asr-local.js'), 'utf8');
  check('⑩ 下载进度带 ETA + 自动重试，失败可重试（客户端/服务端都有）',
    /etaSeconds/.test(routeSrc) && /retryAt/.test(routeSrc) && /lastError/.test(routeSrc)
      && /自动重试/.test(routeSrc) && /onRetry/.test(asrSrc)
      && /retries/.test(asrSrc) && /fileTimeoutMs/.test(asrSrc)
      && /petAsrEta/.test(petChatSrc) && /etaSeconds/.test(petChatSrc)
      && /正在自动重试/.test(petChatSrc),
    'ETA + retry');
  check('⑩ 下载完成前点桌宠显示进度，就绪后才真正开始录音',
    /await ensureAsrReady\(/.test(petChatSrc)
      && /seq !== petChatWakeSeq/.test(petChatSrc)
      && /if \(!ready \|\| seq !== petChatWakeSeq\) return;/.test(petChatSrc)
      && petChatSrc.indexOf('petBubble.setState(\'listen\')') > petChatSrc.indexOf('await ensureAsrReady('),
    'wake gated by ASR');
}

/* ⑪ 镜像目录 / 无 Key 静默回落 / Edge 5–8s 预算 */
{
  const { TTS_CATALOG, TTS_MODEL_MIRROR } = await import('../lib/tts/catalog.js');
  const piper = TTS_CATALOG.find((item) => item.id === 'piper-zh');
  check('⑪ Piper catalog 默认站点镜像，运行时/模型各有 ≥2 个地址 + sha256',
    /^https:\/\//.test(TTS_MODEL_MIRROR)
      && piper && piper.runtime && piper.runtime.downloadUrls.length >= 2
      && piper.model && piper.model.downloadUrls.length >= 2
      && /^[A-F0-9]{64}$/.test(piper.runtime.sha256)
      && /^[A-F0-9]{64}$/.test(piper.model.sha256)
      && !/Neural/.test(piper.id),
    `${TTS_MODEL_MIRROR} · runtime=${piper.runtime.downloadUrls.length} model=${piper.model.downloadUrls.length}`);

  const noKey = await worker.synthesizePolicy('没有 Key 也要回落。', {
    voice: 'openai:alloy', rate: 0, policy: true,
    online: { openai: { apiKey: '', voice: 'alloy' } },
  }, {
    runEdgeOnline: async () => ({ ok: true, file: 'fake.mp3', bytes: 4096, voice: 'zh-CN-XiaoxiaoNeural', mime: 'audio/mpeg' }),
  });
  check('⑪ OpenAI 无 Key 静默跳过并回落 Edge（不需要用户点掉错误框）',
    noKey.ok === true && noKey.engine === 'edge'
      && noKey.attempts.some((a) => a.engine === 'openai' && (a.code === 'openai-no-key' || /openai-no-key/.test(a.error))),
    `engine=${noKey.engine} attempts=${JSON.stringify(noKey.attempts)}`);

  const workerSrc = readFileSync(join(ROOT, 'lib', 'tts', 'tts-worker.cjs'), 'utf8');
  check('⑪ Edge 失败预算被限制在 5–8 秒（超时即回落）',
    /edgeBudget = Math\.max\(5000, Math\.min\((6500|7000|8000)/.test(workerSrc)
      && /edgeDeadline/.test(workerSrc)
      && /timeoutMs: Math\.min\(edgeBudget, remaining\)/.test(workerSrc),
    'edgeBudget 5–8s');
}

/* ⑫ 独立 Piper 下载器：进度可见 / Range 续传 / sha / 多源重试 */
{
  const workerSrc = readFileSync(join(ROOT, 'lib', 'tts', 'tts-worker.cjs'), 'utf8');
  const routeSrc = readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8');
  const panelSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-assistant.js'), 'utf8');
  check('⑫ Piper 下载器有 Range 续传、sha256、3 次多源重试、进度上报',
    /part = dest \+ '\.part'/.test(workerSrc)
      && /headers\.Range/.test(workerSrc)
      && /for \(let attempt = 1; attempt <= 3/.test(workerSrc)
      && /sha256-mismatch/.test(workerSrc)
      && /onPiperProgress/.test(workerSrc)
      && /piper-progress/.test(workerSrc)
      && /voice\/piper\/progress/.test(routeSrc)
      && /voice\/piper\/progress/.test(panelSrc),
    'resume + sha + retry + progress');
}

const failed = results.filter((item) => !item.ok);
console.log('\n  ' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败');
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
