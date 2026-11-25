/**
 * verify-voice-thinking-ux-v3.mjs — v3 交付验收（任务 §1–§6，A–N）。
 *
 * 覆盖：
 *   A 试听不回落：指定音色就用它；失败直接报原因；三音色 sha256 互不相同
 *   B 火山适配器：真诊断（状态码/响应片段/URL/ResourceId/音色/子类型）、v1/v3 分支严格、错误映射人话
 *   C 火山测试按钮：诊断透传 + 已配置升级为「已验证」+ 配置变更退回未验证
 *   D 思考：内心步骤（≤40 字、不展示）、共情规则、两步门控、情绪影响语气
 *   E 思考路由：system 注入内心步骤；连续抱怨不重复；「讲个笑话」直接给内容（不两步）
 *   F 常驻聆听：安装/启动后自动进入听（不用点桌宠）
 *   G 半双工 + 暂停说话 / 暂停聆听 / 麦克风失败
 *   H 气泡：圆角 16 / 半透明 + 描边 + 阴影 / 宽 300 / 4 行可展开 / 150ms / 状态与正文分离 / 复制
 *   I 权限预设：标准 / 宽松 / 自定义（改一组自动变自定义）
 *   J 新工具：媒体 / 音量 / 通知 / open_url / app_launch / doc_write / clipboard（白名单 + 确认 + 回读）
 *   K 高危：写文件 / 剪贴板 / 删除请求 仍二次确认 + 审计
 *   L 预设效果：宽松「放首歌」直接执行；标准「打开记事本」先问
 *   M UI：试听提示引擎、火山诊断/已验证、权限预设按钮
 *   N 持久化：暂停聆听 / 暂停说话 写进 voice config，/state 同步
 *
 * 所有副作用都落在 mkdtemp 的 TEST_HOME 里；不写用户真实 ~/.dsh-folia。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-v3-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;
process.env.DSH_WORKSPACE = join(TEST_HOME, 'workspace');
process.env.FOLIA_ASR_ROOT = join(TEST_HOME, 'asr-none');
mkdirSync(process.env.DSH_WORKSPACE, { recursive: true });

const require = createRequire(import.meta.url);
const worker = require(join(ROOT, 'lib', 'tts', 'tts-worker.cjs'));
const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const {
  readPersona, toolPolicy, applyPermissionPreset, sanitizePermissions, permissionPresetOf,
} = await import('../lib/persona-store.js');
const {
  toolRegistry, buildInnerStep, needsTwoStep, detectMood, buildPersonaSystemPrompt, comfortStarts, classifyIntent,
} = await import('../lib/pet-chat-brain.js');
const { runTool, readToolWhitelist, hostAllowed, confirmAsk } = await import('../lib/pet-chat-tools.js');
const { toolLogPath } = await import('../lib/persona-tool-log.js');
const { readVoiceCenter } = await import('../lib/tts/voice-center.js');
const { listPacks } = await import('../lib/tts/packs.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const wait = (ms) => new Promise((resolveP) => { setTimeout(resolveP, ms); });
const sha256 = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex');

function makeWav(bytes = 12000, fill = 0) {
  const size = Math.max(44, Number(bytes) || 12000);
  const buf = Buffer.alloc(size, fill);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(size - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(size - 44, 40);
  return buf;
}

function makeMp3(bytes = 4096) {
  const size = Math.max(1024, Number(bytes) || 4096);
  const buf = Buffer.alloc(size, 0x55);
  buf.write('ID3', 0, 'ascii');
  return buf;
}

/* ══ 台架 ①：假 TTS + 假宿主（HTTP）════════════════════════════════════════ */

function fakeTts() {
  const calls = [];
  const state = {
    volcResult: null,
    strictFailures: new Map(),
    bytesFor: (engine) => (engine === 'piper' ? 12000 : engine === 'edge' ? 13000 : engine === 'volc' ? 18000 : 16000),
  };
  return {
    calls,
    state,
    async synthesize(text, opts = {}) {
      calls.push({ text, opts });
      const voice = String(opts.voice || '');
      const engine = /^piper:/i.test(voice) ? 'piper'
        : /^melo:/i.test(voice) ? 'sherpa'
          : /^volc:/i.test(voice) ? 'volc'
            : /^openai:/i.test(voice) ? 'openai'
              : /^azure:/i.test(voice) ? 'azure'
                : /^elevenlabs:/i.test(voice) ? 'elevenlabs' : 'edge';
      const forced = state.strictFailures.get(voice);
      if (forced) {
        return {
          ok: false, code: forced.code, engine, voice, requestedVoice: voice,
          hint: forced.hint, attempts: [], fallback: false,
        };
      }
      const bytes = state.bytesFor(engine);
      const fill = engine === 'piper' ? 1 : engine === 'edge' ? 2 : 3;
      return {
        ok: true, wav: makeWav(bytes, fill), engine, voice, requestedVoice: voice,
        subtype: engine === 'volc' ? 'volc-seed-tts' : '',
        transport: engine === 'piper' ? 'local' : 'online',
        mime: 'audio/wav', fallback: false, fallbackFrom: '',
        attempts: [], ms: 2, cached: false, bytes,
      };
    },
    async volcTest() {
      return state.volcResult || {
        ok: false, engine: 'volc', status: 0, code: 'volc-no-key', error: '没有 key',
        subtype: 'volc-seed-tts', resourceId: 'seed-tts-2.0', voiceId: 'zh_female_x',
        url: '', bodySnippet: '', maskedAppId: '', maskedToken: '',
      };
    },
    async voices() { return []; },
    voiceMeta() { return {}; },
    stop() { return { ok: true }; },
    status() { return { ok: true, ready: true, engines: ['edge', 'piper', 'sapi', 'volc', 'sherpa'], piper: { installed: true } }; },
    dispose() {},
  };
}

function startHost(settings, tts) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [], base: '/folia', log: () => {},
    readSettings: () => settings, speechToText: undefined, tts,
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  assert.ok(route, '路由已注册');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({ base: `http://127.0.0.1:${port}/folia/pet-chat`, close: () => new Promise((r) => { server.close(r); }) });
    });
  });
}

const post = (host, path, body) => fetch(host.base + path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});

function parseFrames(buffer) {
  const frames = [];
  for (;;) {
    const cut = buffer.indexOf('\n\n');
    if (cut < 0) return { frames, rest: buffer };
    const frame = buffer.slice(0, cut);
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (data) {
      try { frames.push({ event, data: JSON.parse(data) }); } catch { /* ignore */ }
    }
    buffer = buffer.slice(cut + 2);
  }
}

async function chat(host, text, personaId) {
  const res = await fetch(host.base + '/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(personaId ? { text, personaId } : { text }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseFrames(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.frames) {
      events.push(frame);
      if (frame.event === 'action') {
        const payload = frame.data || {};
        if (String(payload.tool) === 'wallpaper_switch') {
          await post(host, '/tool-result', { id: payload.id, ok: true, targetId: 'wp-1', title: '暗夜' });
        } else {
          await post(host, '/tool-result', { id: payload.id, ok: false, error: 'no-client' });
        }
      }
    }
  }
  const doneEvent = events.find((item) => item.event === 'done') || { data: {} };
  return {
    events,
    done: doneEvent.data,
    text: events.filter((item) => item.event === 'delta').map((item) => item.data.t || '').join(''),
  };
}

/* 本机假 Piper（让"已装音色包"有真路径；试听只走它做 packInstalled 门禁） */
const piperRoot = join(TEST_HOME, 'piper', 'v1');
mkdirSync(join(piperRoot, 'piper', 'espeak-ng-data'), { recursive: true });
mkdirSync(join(piperRoot, 'models'), { recursive: true });
writeFileSync(join(piperRoot, 'piper', 'piper.exe'), 'MZ fake');
writeFileSync(join(piperRoot, 'models', 'zh_CN-huayan-medium.onnx'), Buffer.alloc(2 * 1024 * 1024));
writeFileSync(join(piperRoot, 'models', 'zh_CN-huayan-medium.onnx.json'), '{}');

const tts = fakeTts();
const settings = {
  petChat: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'fake' },
  id: 'wp-old',
};
const host = await startHost(settings, tts);

try {
  /* ══ A. 试听不回落 + 三音色 sha256 不同 ══════════════════════════════════ */
  console.log('\nA. 试听：指定音色就用它（不回落），三音色 sha256 不同');
  const previews = [];
  for (const id of ['piper:zh_CN-huayan-medium', 'edge:zh-CN-XiaoxiaoNeural', 'volc:zh_female_x']) {
    const resp = await post(host, '/voice/preview', { id, text: '试听一句话。' });
    const bytes = Buffer.from(await resp.arrayBuffer());
    previews.push({ id, status: resp.status, sha: sha256(bytes), engine: resp.headers.get('x-folia-tts-engine'), fallback: resp.headers.get('x-folia-tts-fallback') });
  }
  const strictCalls = tts.calls.filter((call) => call.opts.strict === true);
  check('A1 三个音色各自走自己的引擎（strict），响应头 fallback=0',
    previews.every((item) => item.status === 200 && item.fallback === '0')
      && previews[0].engine === 'piper' && previews[1].engine === 'edge' && previews[2].engine === 'volc'
      && strictCalls.length >= 3 && strictCalls.every((call) => call.opts.policy !== true),
    previews.map((item) => `${item.engine}:${item.fallback}`).join(' · '));
  check('A2 三段音频 sha256 互不相同（听感不会再是同一个音色）',
    new Set(previews.map((item) => item.sha)).size === 3,
    previews.map((item) => item.sha.slice(0, 12)).join(' / '));

  tts.state.strictFailures.set('edge:zh-CN-FakeNeural', {
    code: 'edge-http-429', hint: '这个在线音色被限流（429）：稍后再试',
  });
  const failPreview = await post(host, '/voice/preview', { id: 'edge:zh-CN-FakeNeural' });
  const failDoc = await failPreview.json();
  const failCalls = tts.calls.filter((call) => call.opts.voice === 'edge:zh-CN-FakeNeural');
  check('A3 音色不可用 ⇒ 直接报原因（engine/voiceId/fallback:false），不换别的音色重试',
    failPreview.status === 503 && failDoc.ok === false && failDoc.engine === 'edge'
      && failDoc.voiceId === 'edge:zh-CN-FakeNeural' && failDoc.fallback === false
      && /限流|429/.test(String(failDoc.hint)) && failCalls.length === 1
      && failPreview.headers.get('x-folia-tts-fallback') === '0',
    `${failDoc.code} · ${failDoc.hint}`);

  /* ══ B. 火山适配器：真诊断 + 分支严格 + 错误映射 ══════════════════════════ */
  console.log('\nB. 火山：真诊断（状态码/响应片段/URL/ResourceId）、v1–v3 分支严格、人话映射');
  let volcStatus = 200;
  let volcMode = 'legacy';
  let volcDelay = 0;
  const seenRequests = [];
  const volcServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seenRequests.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      const reply = () => {
        res.statusCode = volcStatus;
        if (volcStatus !== 200) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ message: volcStatus === 401 ? 'bad token abc' : 'opened? no' }));
          return;
        }
        if (volcMode === 'seed') {
          res.setHeader('content-type', 'application/x-ndjson');
          res.end(JSON.stringify({ code: 0, data: makeMp3(9000).toString('base64') }) + '\n'
            + JSON.stringify({ code: 20000000 }) + '\n');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 3000, message: 'Success', data: makeMp3(9000).toString('base64') }));
      };
      if (volcDelay) setTimeout(reply, volcDelay); else reply();
    });
  });
  await new Promise((r) => { volcServer.listen(0, '127.0.0.1', r); });
  const volcBase = `http://127.0.0.1:${volcServer.address().port}/`;
  const baseCfg = {
    appId: 'app-12345678', accessToken: 'token-secret-abcdef',
    voiceId: 'zh_female_x', baseUrl: volcBase,
  };
  try {
    volcMode = 'seed';
    const seed = await worker.volcTest({ ...baseCfg, subtype: 'volc-seed-tts', resourceId: 'seed-tts-2.0' }, {});
    const seedReq = seenRequests[seenRequests.length - 1];
    check('B1 Seed-TTS 分支：只走 v3（X-Api-* 头 + resourceId），诊断字段齐全',
      seed.ok === true && seed.status === 200 && seed.subtype === 'volc-seed-tts'
        && seed.url === volcBase && seed.resourceId === 'seed-tts-2.0' && seed.voiceId === 'zh_female_x'
        && seedReq.headers['x-api-resource-id'] === 'seed-tts-2.0'
        && seedReq.headers['x-api-app-id'] === 'app-12345678'
        && !seedReq.headers.authorization,
      `url=${seed.url} resource=${seed.resourceId} status=${seed.status}`);

    volcMode = 'legacy';
    seenRequests.length = 0;
    const legacyPlan = worker.volcRequestPlan({ appId: 'app-1', accessToken: 'tok-1', subtype: 'volc-tts', cluster: 'volcano_tts' }, 'zh_female_x', '你好', 0);
    const seedPlan = worker.volcRequestPlan({ appId: 'app-1', accessToken: 'tok-1', subtype: 'volc-seed-tts', resourceId: 'seed-tts-2.0' }, 'zh_female_x', '你好', 0);
    const legacy = await worker.volcTest({ ...baseCfg, subtype: 'volc-tts', cluster: 'volcano_tts', resourceId: 'seed-tts-2.0' }, {});
    const legacyReq = seenRequests[0];
    const legacyBody = JSON.parse(legacyReq.body || '{}');
    check('B2 传统 TTS 分支：只走 v1（Bearer; + cluster），不因 resourceId 偷偷换成 v3',
      legacy.ok === true && legacy.subtype === 'volc-tts'
        && legacyReq.headers.authorization === 'Bearer;token-secret-abcdef'
        && !legacyReq.headers['x-api-resource-id']
        && legacyBody.app && legacyBody.app.cluster === 'volcano_tts'
        && legacyPlan.url === 'https://openspeech.bytedance.com/api/v1/tts'
        && seedPlan.url === 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
      `v1=${legacyPlan.url} · v3=${seedPlan.url} · cluster=${legacyBody.app && legacyBody.app.cluster}`);

    volcMode = 'legacy';
    seenRequests.length = 0;
    const forced = await worker.volcTest({ ...baseCfg, subtype: 'volc-tts', voiceId: 'zh_female_wanwanxiaohe_moon_bigtts' }, {});
    check('B3 选了 volc-tts 就只走传统分支（即使音色名以 _bigtts 结尾）',
      forced.ok === true && forced.subtype === 'volc-tts'
        && seenRequests[0].headers.authorization === 'Bearer;token-secret-abcdef'
        && !seenRequests[0].headers['x-api-resource-id'],
      `${forced.subtype} · ${forced.voiceId}`);

    for (const [status, expectCode, expectText] of [
      [401, 'volc-unauthorized', /AppID\/Token 无效或未开通语音服务/],
      [403, 'volc-forbidden', /AppID\/Token 无效或未开通语音服务/],
      [404, 'volc-not-found', /Resource ID \/ Cluster \/ 音色 ID 与所选产品线不匹配/],
      [400, 'volc-bad-request', /Resource ID \/ Cluster \/ 音色 ID 与所选产品线不匹配/],
      [429, 'volc-rate-limited', /限流\/额度不足/],
    ]) {
      volcStatus = status;
      const diag = await worker.volcTest({ ...baseCfg, subtype: 'volc-tts' }, {});
      check(`B4 HTTP ${status} ⇒ ${expectCode} + 人话映射 + 响应片段`,
        diag.ok === false && diag.code === expectCode && diag.status === status
          && expectText.test(String(diag.error)) && String(diag.bodySnippet).length > 0
          && String(diag.bodySnippet).length <= 300
          && !JSON.stringify(diag).includes('token-secret-abcdef'),
        `${diag.code} · ${diag.error} · 片段=${diag.bodySnippet}`);
    }
    volcStatus = 200;
    volcMode = 'legacy';
    volcDelay = 4200;
    const timed = await worker.volcTest({ ...baseCfg, subtype: 'volc-tts' }, { timeoutMs: 3000 });
    volcDelay = 0;
    check('B5 超时 ⇒ volc-timeout +「网络不可达或超时」',
      timed.ok === false && timed.code === 'volc-timeout' && /网络不可达或超时/.test(String(timed.error)),
      timed.error);

  // O. 常驻聆听前置：没填模型 Key 不开麦（隐私 + 体验）
  const routesSrc = readFileSync(join(ROOT, 'lib/routes/pet-chat.js'), 'utf8');
  const chatSrc = readFileSync(join(ROOT, 'src/pet-chat.js'), 'utf8');
  const i18nSrc = readFileSync(join(ROOT, 'src/i18n-copy-panel.js'), 'utf8');
  check('O1 /state 暴露 hasApiKey 与 modelReady',
    routesSrc.includes('hasApiKey') && routesSrc.includes('modelReady: config.enabled === true'));
  check('O2 模型未就绪时不开麦，并给可读提示',
    chatSrc.includes('if (!petChatModelReady)')
    && chatSrc.includes('petChatModelReady = doc.modelReady === true'));
  check('O3 首次常驻聆听只提示一次（localStorage 标记）',
    chatSrc.includes('resident-notice-v1') && chatSrc.includes('我会一直听着'));
  check('O4 两条新提示都有英文词条',
    i18nSrc.includes('先填模型 Key') && i18nSrc.includes('我会一直听着'));
  check('O5 旧版 Edge 短标签（YunJhe/Xiaoxiao）归一为完整 id，试听不再 bad-voice',
    (await import('../lib/tts/voice-center.js')).normalizeVoiceId('YunJhe') === 'edge:zh-TW-YunJheNeural'
    && (await import('../lib/tts/voice-center.js')).normalizeVoiceId('Xiaoxiao') === 'edge:zh-CN-XiaoxiaoNeural');
  } finally {
    await new Promise((r) => { volcServer.close(r); });
  }

  /* ══ C. 火山测试按钮：诊断透传 + 已验证 ═══════════════════════════════════ */
  console.log('\nC. 火山「测试」按钮：诊断透传 + 已配置升级为已验证');
  await post(host, '/voice/providers', {
    provider: 'volcengine', appId: 'app-12345678', accessToken: 'token-secret-abcdef',
    cluster: 'volcano_tts', resourceId: 'seed-tts-2.0', subtype: 'volc-seed-tts', voiceId: 'zh_female_x',
  });
  tts.state.volcResult = {
    ok: false, engine: 'volc', subtype: 'volc-seed-tts', resourceId: 'seed-tts-2.0',
    voiceId: 'zh_female_x', url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    status: 401, code: 'volc-unauthorized', bodySnippet: 'bad token abc',
    maskedAppId: 'app-••••5678', maskedToken: 'toke••••cdef',
    error: 'AppID/Token 无效或未开通语音服务（HTTP 401）', hint: '去火山控制台确认 AppID/Token',
  };
  const failedTest = await (await post(host, '/voice/providers/test', { provider: 'volcengine' })).json();
  const providersAfterFail = await (await fetch(host.base + '/voice/providers')).json();
  const volcViewFail = providersAfterFail.providers.find((item) => item.id === 'volcengine');
  check('C1 测试失败 ⇒ 状态码 + 响应片段 + URL + ResourceId + 掩码 Key（原文不出现在响应里）',
    failedTest.ok === false && failedTest.status === 401 && failedTest.code === 'volc-unauthorized'
      && failedTest.bodySnippet === 'bad token abc'
      && failedTest.url.includes('/api/v3/tts/unidirectional')
      && failedTest.resourceId === 'seed-tts-2.0' && failedTest.voiceId === 'zh_female_x'
      && !JSON.stringify(failedTest).includes('token-secret-abcdef')
      && Boolean(failedTest.diagnostic) && volcViewFail.status === 'configured',
    `status=${failedTest.status} code=${failedTest.code} 片段=${failedTest.bodySnippet}`);

  tts.state.volcResult = {
    ok: true, engine: 'volc', subtype: 'volc-seed-tts', resourceId: 'seed-tts-2.0',
    voiceId: 'zh_female_x', url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    status: 200, code: 'ok', bodySnippet: 'HTTP 200 · volc-seed-tts · 音频 9000 字节',
    maskedAppId: 'app-••••5678', maskedToken: 'toke••••cdef',
    error: '', hint: '合成成功：实际使用的子类型 / Resource ID 见上', bytes: 9000, mime: 'audio/mpeg',
  };
  const okTest = await (await post(host, '/voice/providers/test', { provider: 'volcengine' })).json();
  const volcViewOk = (await (await fetch(host.base + '/voice/providers')).json()).providers.find((item) => item.id === 'volcengine');
  check('C2 测试通过 ⇒ 已配置升级为「已验证」，并显示实际子类型 / Resource ID',
    okTest.ok === true && okTest.verified === true && volcViewOk.status === 'verified'
      && volcViewOk.verified === true && volcViewOk.verifiedSubtype === 'volc-seed-tts'
      && volcViewOk.verifiedResourceId === 'seed-tts-2.0',
    `status=${volcViewOk.status} · ${volcViewOk.verifiedSubtype} · ${volcViewOk.verifiedResourceId}`);

  await post(host, '/voice/providers', { provider: 'volcengine', subtype: 'volc-tts' });
  const volcViewChanged = (await (await fetch(host.base + '/voice/providers')).json()).providers.find((item) => item.id === 'volcengine');
  check('C3 配置一改就退回「已配置（未验证）」（旧测试结论不再可信）',
    volcViewChanged.status === 'configured' && volcViewChanged.verified === false,
    volcViewChanged.status);

  /* ══ D. 思考：内心步骤 / 共情规则 / 两步门控 / 情绪语气 ═════════════════════ */
  console.log('\nD. 思考：内心步骤（≤40 字）+ 先共情 + 两步门控 + 情绪影响语气');
  const tiredInner = buildInnerStep('今天好累', detectMood('今天好累', Date.now()), { inputMode: 'text' });
  check('D1 「今天好累」⇒ 判成累/想要安慰/别先讲道理，且 ≤40 字',
    /累/.test(tiredInner.emotion) && /安慰/.test(tiredInner.want)
      && /讲道理|建议/.test(tiredInner.avoid) && [...tiredInner.text].length <= 40,
    `${tiredInner.text}（${[...tiredInner.text].length} 字）`);
  const jokeInner = buildInnerStep('讲个笑话', null, { inputMode: 'text' });
  check('D2 「讲个笑话」⇒ 想要直接给内容、别分析情绪',
    /内容/.test(jokeInner.want) && /分析情绪|铺垫/.test(jokeInner.avoid),
    jokeInner.text);
  check('D3 两步门控：简单寒暄/笑话不走两步，复杂问题才走',
    needsTwoStep('讲个笑话', { inputMode: 'text' }) === false
      && needsTwoStep('你好', { inputMode: 'text' }) === false
      && needsTwoStep('帮我规划一下这周的学习计划，每天两小时，还要留出复习时间', { inputMode: 'text' }) === true
      && needsTwoStep('为什么天空是蓝色的？为什么会下雨？', { inputMode: 'text' }) === true
      && needsTwoStep('帮我规划一下这周的学习计划，每天两小时，还要留出复习时间', { inputMode: 'voice' }) === false);

  const prompt = buildPersonaSystemPrompt({ type: 'assistant', name: '小满' }, {
    innerStep: tiredInner.text, avoidLines: ['抱抱你，先歇会儿。'],
    affect: { mood: 'tired', valence: -0.3, energy: 0.3 }, inputMode: 'text',
  });
  check('D4 system 有「回答方式」（先接住情绪/不列 1-2-3/允许立场）+ 内心步骤 + 别重复 + 情绪语气',
    /先接住对方的情绪/.test(prompt) && /不要机械列 1\/2\/3/.test(prompt)
      && /可以表达你自己的偏好和立场/.test(prompt) && /【内心步骤·只给自己看】/.test(prompt)
      && /【别重复】/.test(prompt) && /抱抱你/.test(prompt)
      && /【当前情绪】tired/.test(prompt) && /语气更轻/.test(prompt)
      && !/最多 \d+ 字/.test(prompt),
    `长度=${prompt.length}`);
  check('D5 情绪影响语速：累→-1、开心→+1（深夜开心的基线不变）',
    detectMood('好累', new Date(2026, 10, 16, 12, 0).getTime()).rate === -1
      && detectMood('太开心了', new Date(2026, 10, 16, 12, 0).getTime()).rate === 1
      && detectMood('好累', new Date(2026, 10, 16, 23, 30).getTime()).rate === -1);

  /* ══ E. 思考路由：system 注入 + 三步不重复 + 笑话直接 ════════════════════ */
  console.log('\nE. 思考路由：system 真注入；连续抱怨不重复；笑话不两步');
  const modelSeen = [];
  let modelReply = '抱抱你，先歇会儿。';
  const modelServer = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let doc = null;
      try { doc = JSON.parse(body); } catch { /* ignore */ }
      modelSeen.push({ url: req.url, body: doc });
      if (doc && doc.stream === false) {
        // 两步策划器：回 3 条要点（按 provider 各自的响应形状）
        const content = '1. 先接住累\n2. 给一个轻建议\n3. 别长篇';
        res.writeHead(200, { 'content-type': 'application/json' });
        if (String(req.url).includes('/api/chat')) {
          res.end(JSON.stringify({ message: { content } }));
        } else {
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(JSON.stringify({ message: { content: modelReply }, done: false }) + '\n');
      res.end();
    });
  });
  await new Promise((r) => { modelServer.listen(0, '127.0.0.1', r); });
  const modelBase = `http://127.0.0.1:${modelServer.address().port}`;
  const thoughtSettings = { ...settings, petChat: { ...settings.petChat, baseUrl: modelBase } };
  const thoughtHost = await startHost(thoughtSettings, tts);
  try {
    const first = await chat(thoughtHost, '今天好累');
    const system1 = String((modelSeen[0] && modelSeen[0].body && modelSeen[0].body.messages[0].content) || '');
    check('E1 「今天好累」⇒ system 带内心步骤（先共情、别列建议），且不是两步',
      /【内心步骤·只给自己看】/.test(system1) && /安慰/.test(system1)
        && /先接住对方的情绪/.test(system1) && modelSeen.length === 1
        && first.text.includes('抱抱'),
      `调用=${modelSeen.length} · 内心步骤=${/【内心步骤/.test(system1)}`);

    await wait(1100);
    modelReply = '我在呢，慢慢来。';
    await chat(thoughtHost, '工作好烦，不想动');
    await wait(1100);
    modelReply = '那就先什么都不做。';
    await chat(thoughtHost, '还是一样，累');
    const system3 = String((modelSeen[modelSeen.length - 1].body.messages[0].content) || '');
    check('E2 连续 3 轮抱怨 ⇒ system 带「别重复」并列出最近说过的安慰话',
      /【别重复】/.test(system3) && /我在呢|抱抱/.test(system3),
      `第三轮 system 含别重复=${/【别重复】/.test(system3)}`);

    await wait(1100);
    modelSeen.length = 0;
    modelReply = '好，讲一个：为什么鱼不上网？因为它们怕被网住。';
    const joke = await chat(thoughtHost, '讲个笑话');
    const jokeSystem = String((modelSeen[0] && modelSeen[0].body && modelSeen[0].body.messages[0].content) || '');
    check('E3 「讲个笑话」⇒ 直接讲，不先分析情绪、不走两步',
      modelSeen.length === 1 && joke.text.includes('鱼')
        && /直接给内容/.test(jokeSystem) && /【内心步骤/.test(jokeSystem),
      `调用=${modelSeen.length} · 回答=${joke.text.slice(0, 30)}`);

    await wait(1100);
    modelSeen.length = 0;
    modelReply = '可以这样安排：先定目标，再拆周计划。';
    await chat(thoughtHost, '帮我规划一下这周的学习计划，每天两小时，还要留出复习时间');
    const complexSystem = String((modelSeen[modelSeen.length - 1].body.messages[0].content) || '');
    const plannerCall = modelSeen.find((item) => item.body && item.body.stream === false);
    check('E4 复杂问题 ⇒ 先两步列 3 条要点（内部），最终回答的 system 带要点',
      Boolean(plannerCall) && /【先想过的三条要点/.test(complexSystem) && /先接住累/.test(complexSystem),
      `调用=${modelSeen.length} · 策划器=${Boolean(plannerCall)}`);
  } finally {
    await thoughtHost.close();
    await new Promise((r) => { modelServer.close(r); });
  }

  /* ══ F/G. 常驻聆听 + 半双工 + 两个暂停（vm 里跑真实客户端）═══════════════ */
  console.log('\nF/G. 常驻聆听（装好就在听）+ 半双工 + 暂停说话 / 暂停聆听');
  const clientSrc = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  {
    const timers = [];
    const bubble = {
      appended: '', states: [], statuses: [], flags: null, continuous: false,
      append(t) { this.appended += String(t || ''); }, show(t) { this.appended = String(t || ''); },
      clear() { this.appended = ''; }, hide() {}, hideStatus() {}, place() {},
      setState(k) { this.states.push(String(k)); }, status(_k, m) { this.statuses.push(String(m)); },
      setVoiceFlags(f) { this.flags = f; }, setContinuous(v) { this.continuous = v; },
      isVisible() { return false; }, dispose() {},
    };
    const state = {
      ttsDeps: null, voiceDeps: null, speaking: false, spoke: [], starts: 0, stops: 0, posted: [],
      asrReady: true,
    };
    function sseResponse(frames) {
      let index = 0;
      const chunks = frames.map((frame) => Buffer.from(frame, 'utf8'));
      return {
        ok: true, status: 200,
        response: {
          body: {
            getReader: () => ({
              read: async () => {
                if (index >= chunks.length) return { value: undefined, done: true };
                const value = chunks[index];
                index += 1;
                return { value, done: false };
              },
            }),
          },
        },
      };
    }
    const sandbox = {
      console,
      setTimeout: (fn, ms) => { const row = { fn, ms: Number(ms) || 0, cleared: false }; timers.push(row); return row; },
      clearTimeout: (row) => { if (row) row.cleared = true; },
      setInterval: () => 1,
      clearInterval: () => {},
      weT: (s, o) => String(s).replace(/\{(\w+)\}/g, (_, k) => (o && o[k] !== undefined ? o[k] : '{' + k + '}')),
      petBubbleCreate: () => bubble,
      petBubble: bubble,
      petTtsCreate: (deps) => {
        state.ttsDeps = deps;
        return {
          speak: (line) => { state.spoke.push(String(line)); return true; },
          stop: () => {},
          isSpeaking: () => state.speaking,
        };
      },
      petVoiceInputCreate: (deps) => {
        state.voiceDeps = deps;
        return {
          start: async () => { state.starts += 1; return true; },
          stop: () => { state.stops += 1; },
          postChat: (text, onState) => deps.postChat(text, onState),
        };
      },
      petTtsSentences: (raw) => {
        const sentences = [];
        let start = 0;
        for (let i = 0; i < raw.length; i += 1) {
          if (/[。！？!?\n]/.test(raw[i])) {
            const piece = raw.slice(start, i + 1).trim();
            if (piece) sentences.push(piece);
            start = i + 1;
          }
        }
        return { sentences, rest: raw.slice(start) };
      },
      apiJson: async (path) => {
        if (String(path).includes('/asr')) return { data: { available: true, ready: state.asrReady } };
        if (String(path).includes('/state')) return { data: { enabled: true, hasApiKey: true, modelReady: true, voice: { name: '', muted: false, rate: 0, continuous: true, listenPaused: false } } };
        if (String(path).includes('/now-playing')) return { data: { media: null } };
        return { data: {} };
      },
      apiPostJson: async (path, payload) => { state.posted.push({ path, payload }); return { data: {} }; },
      apiFetch: async () => sseResponse([
        'event: meta\ndata: {"mood":"tired","rate":-1,"intent":"chat"}\n\n',
        'data: {"t":"我今天有点累。"}\n\n',
        'data: {"t":"先歇会儿吧。"}\n\n',
        'event: done\ndata: {"emotion":"calm"}\n\n',
      ]),
      apiUrl: (path) => path,
      ensureAsrReady: async () => true,
      EventSource: function EventSource() { this.close = () => {}; },
      TextDecoder,
      document: {
        visibilityState: 'visible',
        addEventListener() {}, removeEventListener() {},
        querySelector: () => null,
        createElement: () => ({ style: {}, dataset: {}, appendChild() {}, addEventListener() {}, remove: () => {} }),
        body: { appendChild() {} },
      },
      window: {
        addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
        innerWidth: 1920, innerHeight: 1080,
      },
    };
    sandbox.globalThis = sandbox;
    runInNewContext(clientSrc, sandbox, { filename: 'pet-chat.js' });
    const runTimers = (maxMs = 400) => {
      for (const row of timers) {
        if (!row.cleared && row.ms <= maxMs) { row.cleared = true; row.fn(); }
      }
    };
    const flush = async () => {
      for (let i = 0; i < 12; i += 1) { await new Promise((r) => setImmediate(r)); }
    };
    const cleanup = sandbox.mountPetChat();
    await flush();
    runTimers();
    await flush();
    check('F1 安装/挂载后自动进入常驻聆听（不点桌宠就开麦）',
      state.starts >= 1 && /petChatResidentStart/.test(clientSrc)
        && /if \(!petChatContinuousPaused\) void petChatResidentStart\(\)/.test(clientSrc)
        && bubble.states.includes('listen'),
      `开麦次数=${state.starts} · 状态=${bubble.states.slice(-2).join(',')}`);

    // 半双工：正在朗读时，计时到点也不开麦；播完 300ms 才恢复听。
    const before = state.starts;
    state.speaking = true;
    state.ttsDeps.onIdle();
    const pending = timers.filter((row) => !row.cleared && row.ms === 300);
    for (const row of pending) { row.cleared = true; row.fn(); }
    await flush();
    const duringSpeak = state.starts;
    state.speaking = false;
    state.ttsDeps.onIdle();
    const pending2 = timers.filter((row) => !row.cleared && row.ms === 300);
    for (const row of pending2) { row.cleared = true; row.fn(); }
    await flush();
    check('F2 半双工：朗读中绝不开麦；播完 300ms 自动恢复听（不录自己的声音）',
      duringSpeak === before && state.starts === before + 1,
      `朗读中=${duringSpeak} · 播完=${state.starts}（before=${before}）`);

    // 暂停说话：只出字幕、不出声；恢复后重新出声。
    sandbox.window.__dshFoliaPet.setSpeakPaused(true);
    const mutedPost = state.posted.find((item) => item.path === '/pet-chat/voice/config' && item.payload && item.payload.muted === true);
    bubble.appended = '';
    bubble.states.length = 0;
    const spokeBefore = state.spoke.length;
    await state.voiceDeps.postChat('在吗', () => {});
    await flush();
    const subtitle = bubble.appended;
    const spokeDuringPause = state.spoke.length - spokeBefore;
    sandbox.window.__dshFoliaPet.setSpeakPaused(false);
    const spokeBefore2 = state.spoke.length;
    await state.voiceDeps.postChat('在吗', () => {});
    await flush();
    check('G1 暂停说话：有字幕、无声音；关掉后恢复语音（voice.config muted 持久化）',
      Boolean(mutedPost) && subtitle.includes('我今天有点累') && spokeDuringPause === 0
        && bubble.states.includes('muted') && state.spoke.length > spokeBefore2,
      `字幕=${subtitle.slice(0, 16)}… · 静音期间朗读=${spokeDuringPause} · 恢复后朗读=${state.spoke.length - spokeBefore2}`);

    // 暂停聆听：关麦 + 持久化；恢复后马上能听。
    const stopsBefore = state.stops;
    sandbox.window.__dshFoliaPet.setListenPaused(true);
    await flush();
    const pausedPost = state.posted.find((item) => item.path === '/pet-chat/voice/config' && item.payload && item.payload.listenPaused === true);
    const startsWhilePaused = state.starts;
    runTimers();
    await flush();
    sandbox.window.__dshFoliaPet.setListenPaused(false);
    await flush();
    runTimers();
    await flush();
    check('G2 暂停聆听：立刻停麦 + 持久化；再点恢复后马上能听',
      state.stops > stopsBefore && Boolean(pausedPost)
        && pausedPost.payload.listenPaused === true
        && bubble.statuses.some((m) => /麦克风已暂停/.test(m))
        && state.starts >= startsWhilePaused,
      `停麦=${state.stops - stopsBefore} · 持久化=${Boolean(pausedPost)}`);

    // 麦克风被占用/权限失败：自动退出常驻聆听并提示（不静默）。
    const statusBefore = bubble.statuses.length;
    state.voiceDeps.onError({ code: 'no-device', message: 'mic busy' });
    await flush();
    const pausedAfterError = state.posted.some((item) => item.path === '/pet-chat/voice/config' && item.payload && item.payload.listenPaused === true);
    check('G3 麦克风被占用/权限失败 ⇒ 退出常驻聆听 + 提示 + 持久化（不静默）',
      pausedAfterError && bubble.statuses.slice(statusBefore).some((m) => /常驻聆听已暂停/.test(m))
        && sandbox.window.__dshFoliaPet.isListenPaused() === true,
      bubble.statuses.slice(statusBefore).join(' / '));

    check('G4 状态文案：🎤 在听 / 💭 在想 / 🔊 在说 / 🔇 仅文字',
      /🎤/.test(readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8'))
        && /💭/.test(readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8'))
        && /🔊/.test(readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8'))
        && /🔇/.test(readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8')));
    check('G5 恢复后立刻可听：恢复聆听 / 回到页面都把人声时间拉回现在（不套 2s 降频）',
      (clientSrc.match(/petChatLastHeardAt = Date\.now\(\)/g) || []).length >= 3
        && /petChatQuietAfter|PET_CHAT_QUIET_AFTER_MS/.test(clientSrc)
        && /PET_CHAT_QUIET_PROBE_MS/.test(clientSrc),
      `lastHeard 重置处=${(clientSrc.match(/petChatLastHeardAt = Date\.now\(\)/g) || []).length}`);
    cleanup();
  }

  /* ══ H. 气泡美化（静态规格 + 行为在 verify-pet-bubble）═══════════════════ */
  console.log('\nH. 气泡：圆角 16 / 半透明 + 描边 + 阴影 / 宽 300 / 4 行展开 / 150ms');
  const bubbleSrc = readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8');
  check('H1 规格齐：rgba(18,18,22,.86) + 1px 描边 + 柔和阴影 + 300 宽 + 10/14 内边距 + 13px/1.5',
    /rgba\(18,18,22,\.86\)/.test(bubbleSrc) && /border:1px solid rgba\(255,255,255,\.14\)/.test(bubbleSrc)
      && /box-shadow:0 10px 30px/.test(bubbleSrc) && /max-width:300px/.test(bubbleSrc)
      && /padding:10px 14px/.test(bubbleSrc) && /font-size:13px/.test(bubbleSrc)
      && /line-height:1\.5/.test(bubbleSrc) && /border-radius:16px/.test(bubbleSrc));
  check('H2 4 行折叠 + 展开全文 + 长回答滚动到底 + 尾巴指向桌宠',
    /-webkit-line-clamp:4/.test(bubbleSrc) && /setExpanded/.test(bubbleSrc)
      && /followBottom/.test(bubbleSrc) && /bottom:-6px/.test(bubbleSrc)
      && /data-expanded="1"/.test(bubbleSrc));
  check('H3 150ms 淡入淡出 + 轻微上移；新消息替换先淡出；复制只在展开态',
    /transition:opacity 150ms/.test(bubbleSrc) && /translateY\(4px\)/.test(bubbleSrc)
      && /替换旧消息时先淡出|先淡出/.test(bubbleSrc) && /replyTimer|replaceTimer/.test(bubbleSrc)
      && /hidden/.test(bubbleSrc) && /copyText/.test(bubbleSrc));
  check('H4 状态与正文分离（两个元素），且不做彩色主题/图片',
    /we-pet-status/.test(bubbleSrc) && /we-pet-bubble-text/.test(bubbleSrc)
      && !/background-image|url\(/.test(bubbleSrc));

  /* ══ I. 权限预设 ═════════════════════════════════════════════════════════ */
  console.log('\nI. 权限预设：标准 / 宽松 / 自定义');
  const standard = applyPermissionPreset({}, 'standard', 'assistant');
  const relaxed = applyPermissionPreset({}, 'relaxed', 'assistant');
  check('I1 标准：壁纸/桌宠/朗读/提醒 allow；媒体/文档/搜索/应用/剪贴板 ask；系统 ask',
    standard.wallpaper === 'allow' && standard.pet === 'allow' && standard.voice === 'allow'
      && standard.reminder === 'allow' && standard.media === 'ask' && standard.docs === 'ask'
      && standard.search === 'ask' && standard.apps === 'ask' && standard.clipboard === 'ask'
      && standard.system === 'ask' && standard.preset === 'standard',
    JSON.stringify({ ...standard, consentMemory: undefined }));
  check('I2 宽松：媒体/搜索/文档/应用 allow；剪贴板与系统仍 ask（写文件仍要确认）',
    relaxed.media === 'allow' && relaxed.search === 'allow' && relaxed.docs === 'allow'
      && relaxed.apps === 'allow' && relaxed.clipboard === 'ask' && relaxed.system === 'ask'
      && relaxed.preset === 'relaxed',
    JSON.stringify({ ...relaxed, consentMemory: undefined }));
  const custom = { ...relaxed, media: 'ask' };
  check('I3 改过任何一组 ⇒ 自动判定为「自定义」（不信任客户端标签）',
    permissionPresetOf(custom) === 'custom'
      && sanitizePermissions({ ...custom, preset: 'relaxed' }, 'assistant').preset === 'custom',
    permissionPresetOf(custom));
  check('I4 特殊人设即使套预设也是全 deny（代码层）',
    Object.entries(applyPermissionPreset({}, 'relaxed', 'character'))
      .filter(([key]) => !['advanced', 'consentMemory', 'preset', 'presetAt'].includes(key))
      .every(([, level]) => level === 'deny'));

  /* ══ J. 新工具 ═══════════════════════════════════════════════════════════ */
  console.log('\nJ. 新工具：媒体/音量/通知/open_url/app_launch/doc_write/clipboard（白名单 + 确认 + 回读）');
  const toolNames = toolRegistry().map((tool) => tool.name);
  check('J1 七个新工具都在工具表里',
    ['media_control', 'volume_set', 'notify', 'open_url', 'app_launch', 'doc_write', 'clipboard_get', 'clipboard_set']
      .every((name) => toolNames.includes(name)),
    toolNames.join(','));

  const workspace = process.env.DSH_WORKSPACE;
  const writeGood = await runTool('doc_write', { path: 'notes/today.md', content: '今天写完 v3。' }, {
    persona: { type: 'assistant', permissions: { docs: 'allow' } }, confirmed: true, workspaceRoot: workspace,
  });
  const wroteFile = join(workspace, 'notes', 'today.md');
  const writeAgain = await runTool('doc_write', { path: 'notes/today.md', content: '第二版。' }, {
    persona: { type: 'assistant', permissions: { docs: 'allow' } }, confirmed: true, workspaceRoot: workspace,
  });
  check('J2 doc_write：写进工作区并回读校验；覆盖旧文件前自动备份',
    writeGood.ok === true && writeGood.verified === true && existsSync(wroteFile)
      && readFileSync(wroteFile, 'utf8') === '第二版。'
      && writeAgain.data.backup && existsSync(writeAgain.data.backup)
      && readFileSync(writeAgain.data.backup, 'utf8') === '今天写完 v3。',
    `备份=${writeAgain.data.backup}`);
  const escape = await runTool('doc_write', { path: '../escape.md', content: 'x' }, {
    persona: { type: 'assistant', permissions: { docs: 'allow' } }, confirmed: true, workspaceRoot: workspace,
  });
  check('J3 doc_write 拒绝逃出工作区 / 非文本后缀', escape.ok === false && /相对路径/.test(escape.say));

  const httpUrl = await runTool('open_url', { url: 'http://bilibili.com/' }, { openUrlDomains: ['bilibili.com'] });
  const evilUrl = await runTool('open_url', { url: 'https://evil.example/x' }, { openUrlDomains: ['bilibili.com'] });
  const opened = [];
  const okUrl = await runTool('open_url', { url: 'https://www.bilibili.com/video/1' }, {
    openUrlDomains: ['bilibili.com'], openUrl: async (url) => { opened.push(url); return { ok: true }; },
  });
  check('J4 open_url：只开 https + 白名单域名；命中才真打开',
    httpUrl.ok === false && /https/.test(httpUrl.say) && evilUrl.ok === false && /白名单/.test(evilUrl.say)
      && okUrl.ok === true && opened[0] === 'https://www.bilibili.com/video/1',
    `${httpUrl.say} / ${evilUrl.say}`);

  const launched = [];
  const unknownApp = await runTool('app_launch', { app: 'powershell' }, { appWhitelist: [{ id: 'notepad', label: '记事本' }] });
  const okApp = await runTool('app_launch', { app: 'notepad' }, {
    appWhitelist: [{ id: 'notepad', label: '记事本' }],
    launchApp: async (id) => { launched.push(id); return { ok: true }; },
  });
  check('J5 app_launch：只启动白名单应用；不在名单里明确拒绝',
    unknownApp.ok === false && /白名单/.test(unknownApp.say)
      && okApp.ok === true && launched[0] === 'notepad',
    `${unknownApp.say} · 启动=${launched.join(',')}`);

  const notified = [];
  const notifyTool = await runTool('notify', { title: '桌宠', text: '开会了' }, {
    notify: async (payload) => { notified.push(payload); return { ok: true, verified: true }; },
  });
  check('J6 notify：发桌面通知（标题 + 正文）',
    notifyTool.ok === true && notifyTool.verified === true && notified[0].text === '开会了');

  const volume = await runTool('volume_set', { target: 'pet', percent: 35 }, {});
  check('J7 volume_set：桌宠音量写入并经回读确认',
    volume.ok === true && volume.verified === true && volume.data.percent === 35);

  const clipRead = await runTool('clipboard_get', {}, {
    confirmed: true,
    clipboardRead: async () => ({ ok: true, text: '剪贴板里的字' }),
  });
  check('J8 clipboard_get：读出剪贴板文本（ask 组 + 每次确认）',
    clipRead.ok === true && clipRead.data.text === '剪贴板里的字');

  check('J9 白名单可编辑：域名去重/清洗 + 非法域名丢弃',
    hostAllowed('https://docs.bilibili.com/x', ['bilibili.com']).ok === true
      && hostAllowed('https://notbilibili.com', ['bilibili.com']).ok === false
      && typeof readToolWhitelist === 'function');

  /* ══ K. 高危仍二次确认 ════════════════════════════════════════════════════ */
  console.log('\nK. 高危仍二次确认 + 审计');
  const writeAsk = await runTool('doc_write', { path: 'notes/ask.md', content: 'x' }, {
    persona: { type: 'assistant', permissions: { docs: 'allow' } }, confirmed: false, workspaceRoot: workspace,
  });
  const clipboardAsk = await runTool('clipboard_set', { text: '秘密' }, {
    persona: { type: 'assistant', permissions: { clipboard: 'allow' } }, confirmed: false,
  });
  check('K1 即使权限组 allow，doc_write / clipboard_set 仍先要确认（needsConfirm）',
    writeAsk.ok === false && writeAsk.needsConfirm === true && /备份/.test(writeAsk.say)
      && clipboardAsk.ok === false && clipboardAsk.needsConfirm === true
      && !/执行|已复制/.test(String(writeAsk.say)),
    `${writeAsk.say} / ${clipboardAsk.say}`);
  check('K2 特殊人设：任何新工具都被代码层拒绝',
    (await runTool('open_url', { url: 'https://bilibili.com' }, { persona: { type: 'character' } })).ok === false
      && (await runTool('notify', { text: 'x' }, { persona: { type: 'character' } })).ok === false);

  /* ══ L. 预设效果（route 级）══════════════════════════════════════════════ */
  console.log('\nL. 预设效果：宽松「放首歌」直接执行；标准「打开记事本」先问');
  const created = await (await post(host, '/personas', { type: 'assistant', name: '小满' })).json();
  const personaId = created.persona.id;
  await post(host, `/personas/${personaId}/active`, {});
  const relaxedSet = await (await post(host, `/personas/${personaId}/permissions/preset`, { preset: 'relaxed' })).json();
  const relaxedPersona = readPersona(personaId);
  await wait(1100);
  const song = await chat(host, '放首歌', personaId);
  check('L1 「宽松」预设一键生效；「放首歌」直接执行（media_control，不弹确认）',
    relaxedSet.ok === true && relaxedSet.preset === 'relaxed'
      && toolPolicy(relaxedPersona, 'media_control').permission === 'allow'
      && song.done.tool === 'media_control' && song.done.confirm !== true
      && song.events.some((event) => event.event === 'delta' && /我这就办/.test(String(event.data.t || ''))),
    `preset=${relaxedSet.preset} · done=${JSON.stringify(song.done).slice(0, 120)}`);

  const standardSet = await (await post(host, `/personas/${personaId}/permissions/preset`, { preset: 'standard' })).json();
  await wait(1100);
  const notepad = await chat(host, '打开记事本', personaId);
  check('L2 「标准」预设：打开记事本先问确认（app_launch ask），不直接启动',
    standardSet.ok === true && notepad.done.confirm === true && notepad.done.tool === 'app_launch'
      && notepad.events.some((event) => event.event === 'confirm'),
    `done=${JSON.stringify(notepad.done).slice(0, 120)}`);

  // 拒绝后不执行 + 审计
  const confirmFrame = notepad.events.find((event) => event.event === 'confirm');
  const toolConfirm = await (await post(host, '/tool-confirm', { id: confirmFrame.data.id, decision: 'deny' })).json();
  await wait(1100);
  const logDoc = await (await fetch(host.base + `/personas/${personaId}/tool-log?limit=20`)).json();
  check('L3 拒绝 ⇒ 不执行；tool-log 里能看到 app_launch 的 ask/denied 记录',
    toolConfirm.ok === true && toolConfirm.confirmed === false
      && logDoc.items.some((item) => item.tool === 'app_launch' && item.permission === 'ask'),
    `deny=${toolConfirm.decision} · 记录=${logDoc.items.map((item) => item.tool + ':' + item.result).join(',')}`);

  // 删除文件：先确认，拒绝则不动 → 审计；确认也不会真删（没有删除工具）
  await wait(1100);
  const danger = await chat(host, '删除这个文件', personaId);
  const dangerConfirm = danger.events.find((event) => event.event === 'confirm');
  check('L4 「删除这个文件」⇒ 先二次确认（不直接执行）',
    danger.done.confirm === true && danger.done.tool === 'unsupported_danger' && Boolean(dangerConfirm)
      && danger.text.includes('确认'),
    `done=${JSON.stringify(danger.done).slice(0, 100)}`);
  const dangerDeny = await (await post(host, '/tool-confirm', { id: dangerConfirm.data.id, decision: 'deny' })).json();
  check('L5 拒绝删除 ⇒ 不执行，明确回「那就不办了」', dangerDeny.ok === true && /不办/.test(String(dangerDeny.say)));

  /* ══ M. UI（静态）════════════════════════════════════════════════════════ */
  console.log('\nM. UI：试听提示引擎、火山诊断/已验证、权限预设按钮');
  const personasPanelSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-personas.js'), 'utf8');
  check('M1 试听前显示「正在用 <engine> 合成…」；失败显示原因（含 code/hint），不静默播放别的音色',
    /正在用 \$\{engine\} 合成/.test(personasPanelSrc)
      && /试听失败（\$\{engineOut/.test(personasPanelSrc)
      && /不会偷偷换成别的音色/.test(personasPanelSrc));
  check('M2 火山：显示「已验证」+ 实际子类型/ResourceId + 诊断（状态/片段/URL）',
    /已验证/.test(personasPanelSrc) && /verifiedSubtype/.test(personasPanelSrc)
      && /verifiedResourceId/.test(personasPanelSrc) && /响应片段/.test(personasPanelSrc)
      && /诊断 · HTTP/.test(personasPanelSrc) && /diagBlock/.test(personasPanelSrc));
  check('M3 权限页有标准/宽松/自定义预设按钮，并调用 /permissions/preset',
    /setPermissionPreset/.test(personasPanelSrc)
      && /permissions\/preset/.test(personasPanelSrc)
      && /预设：/.test(personasPanelSrc));
  const i18nSrc = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');
  check('M4 新文案都有英文词条（暂停说话 / 暂停聆听 / 展开 / 仅文字）',
    /"暂停说话":/.test(i18nSrc) && /"暂停聆听":/.test(i18nSrc)
      && /"继续聆听":/.test(i18nSrc) && /"展开":/.test(i18nSrc) && /"仅文字":/.test(i18nSrc));
  check('M5 权限页有「工具白名单」编辑器（用户可编辑域名/应用）',
    /工具白名单/.test(personasPanelSrc) && /saveToolWhitelist/.test(personasPanelSrc)
      && /loadToolWhitelist/.test(personasPanelSrc) && /tools\/whitelist/.test(personasPanelSrc));

  /* ══ N. 持久化：两个暂停开关写 voice config，/state 同步 ══════════════════ */
  console.log('\nN. 持久化：暂停说话 / 暂停聆听');
  await post(host, '/voice/config', { muted: true, listenPaused: true });
  const stateDoc = await (await fetch(host.base + '/state')).json();
  const configDoc = await (await fetch(host.base + '/voice/config')).json();
  check('N1 /voice/config 保存 muted + listenPaused；/state 与 /voice/config 同步',
    stateDoc.voice.muted === true && stateDoc.voice.listenPaused === true
      && configDoc.data.voice.muted === true && configDoc.data.voice.listenPaused === true
      && configDoc.data.listenPaused === true,
    JSON.stringify({ muted: stateDoc.voice.muted, listenPaused: stateDoc.voice.listenPaused }));
  await post(host, '/voice/config', { muted: false, listenPaused: false });
  const resumed = await (await fetch(host.base + '/state')).json();
  check('N2 恢复后两个开关都回到 false（再点即恢复）',
    resumed.voice.muted === false && resumed.voice.listenPaused === false);

  const wlSaved = await (await post(host, '/tools/whitelist', {
    domains: ['example.com', 'example.com', 'https://docs.example.org/path'],
    apps: ['notepad', 'calc'],
  })).json();
  const wlRead = await (await fetch(host.base + '/tools/whitelist')).json();
  check('N3 白名单可编辑并落盘：域名去重/去 scheme、应用名保留',
    wlSaved.ok === true && wlRead.domains.includes('example.com')
      && wlRead.domains.includes('docs.example.org')
      && wlRead.domains.filter((item) => item === 'example.com').length === 1
      && wlRead.apps.map((item) => item.id).join(',') === 'notepad,calc',
    JSON.stringify(wlRead));
} finally {
  await host.close();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((item) => !item.ok);
console.log(`\nV3 VOICE/THINKING/UX CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}

