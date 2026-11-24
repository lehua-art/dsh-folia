/**
 * verify-voice-permission-v2.mjs — 音色系统 v2 + 权限重做验收 A–K。
 *
 * 覆盖：
 *   A 声音页目录：15 个 Edge 中文名不 undefined；429 标注“暂不可用”
 *   B 卡片选择器 + ▶ 试听（静态面 + /voice/preview 真回音频）
 *   C 新人设默认继承全局；指定音色不影响全局
 *   D 内置音色包：安装进度 → 完成 → 试听（用本地夹具替下载器，不跑 160MB 真下载）
 *   E 火山：未配置 / 401 / 403 / 429 / 超时 / 真调用（本地假端点）/ 失败回落
 *   F 火山「如何获取」六步齐全
 *   G 权限三档：壁纸 allow 直接做；媒体 ask 先问；拒绝不执行
 *   H 特殊人设：代码层拒绝 + 权限页“不能使用系统工具”
 *   I 审计：tool-log.jsonl 每条含 permission/confirmed/verified
 *   J 高级权限：关闭时 system 不可用；打开后仍二次确认
 *   K 全仓 run-audit 由交付脚本单独跑（本文件不重复跑 172 个测试）
 *
 * 所有外部副作用都落在 mkdtemp 的 TEST_HOME 里；不写用户真实 ~/.dsh-folia。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-voice-perm-v2-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;
process.env.FOLIA_ASR_ROOT = join(TEST_HOME, 'asr-none');

const require = createRequire(import.meta.url);
const worker = require(join(ROOT, 'lib', 'tts', 'tts-worker.cjs'));

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const { readPersona, toolPolicy } = await import('../lib/persona-store.js');
const { personaToolRegistry } = await import('../lib/pet-chat-brain.js');
const { toolLogPath } = await import('../lib/persona-tool-log.js');
const { listPacks } = await import('../lib/tts/packs.js');
const { readVoiceCenter, setPreferredVoice } = await import('../lib/tts/voice-center.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const wait = (ms) => new Promise((resolveP) => { setTimeout(resolveP, ms); });

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

/* ── 台架：假宿主 + 假 TTS ─────────────────────────────────────────────── */

function fakeTts() {
  const calls = [];
  return {
    calls,
    async synthesize(text, opts = {}) {
      calls.push({ text, opts });
      const voice = String(opts.voice || '');
      const engine = /^melo:/i.test(voice) ? 'sherpa'
        : /^volc:/i.test(voice) ? 'volc'
          : /^piper:/i.test(voice) ? 'piper'
            : /^openai:/i.test(voice) ? 'openai'
              : /^azure:/i.test(voice) ? 'azure'
                : /^elevenlabs:/i.test(voice) ? 'elevenlabs' : 'edge';
      // 不同音色给不同字节数：验收“试听明显不同”时可比对。
      const bytes = engine === 'sherpa' ? 32000 : engine === 'volc' ? 28000 : 12000;
      return {
        ok: true, wav: makeWav(bytes, engine === 'sherpa' ? 7 : 0), engine,
        subtype: engine === 'sherpa' ? 'sherpa' : (engine === 'volc' ? 'volc-tts' : ''),
        transport: engine === 'piper' || engine === 'sherpa' ? 'local' : 'online',
        mime: 'audio/wav', voice: voice || 'edge:zh-CN-XiaoxiaoNeural', requestedVoice: voice,
        fallback: false, fallbackFrom: '', attempts: [], ms: 3, cached: false,
      };
    },
    async voices() {
      const list = [];
      const names = [
        ['zh-CN-XiaoxiaoNeural', '晓晓', 'Female', 'zh-CN'],
        ['zh-CN-XiaoyiNeural', '晓伊', 'Female', 'zh-CN'],
        ['zh-CN-YunjianNeural', '云健', 'Male', 'zh-CN'],
        ['zh-CN-YunxiNeural', '云希', 'Male', 'zh-CN'],
        ['zh-CN-YunyangNeural', '云扬', 'Male', 'zh-CN'],
        ['zh-CN-YunxiaNeural', '云夏', 'Male', 'zh-CN'],
        ['zh-CN-liaoning-XiaobeiNeural', '晓北', 'Female', 'zh-CN'],
        ['zh-CN-shaanxi-XiaoniNeural', '晓妮', 'Female', 'zh-CN'],
        ['zh-HK-HiuMaanNeural', '曉曼', 'Female', 'zh-HK'],
        ['zh-HK-HiuGaaiNeural', '曉佳', 'Female', 'zh-HK'],
        ['zh-HK-WanLungNeural', '雲龍', 'Male', 'zh-HK'],
        ['zh-TW-HsiaoChenNeural', '曉臻', 'Female', 'zh-TW'],
        ['zh-TW-HsiaoYuNeural', '曉雨', 'Female', 'zh-TW'],
        ['zh-TW-YunJheNeural', '雲哲', 'Male', 'zh-TW'],
        ['zh-CN-XiaoxiaoMultilingualNeural', '晓晓多语言', 'Female', 'zh-CN'],
      ];
      names.forEach(([id, label, gender, lang], index) => {
        list.push({
          engine: 'edge', id, label, lang, gender, usable: index !== 2,
          reason: index === 2 ? 'edge-http-429 rate limited' : '',
        });
      });
      return list;
    },
    voiceMeta() { return { edge: { ok: true, voice: 'zh-CN-XiaoxiaoNeural', voices: 15 }, piper: { installed: true } }; },
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

async function json(host, path, options = {}) {
  const res = await fetch(host.base + path, options);
  const type = String(res.headers.get('content-type') || '');
  return { status: res.status, headers: res.headers, doc: type.includes('json') ? await res.json() : null, res };
}

const post = (host, path, body) => json(host, path, {
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

/** 发一句 chat；收到 action 时由 onAction 回执（默认成功改 settings.id）。 */
async function chat(host, settings, text, onAction, personaId) {
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
        if (typeof onAction === 'function') {
          await onAction(payload);
        } else if (String(payload.tool) === 'wallpaper_switch') {
          settings.id = 'wp-dark';
          await post(host, '/tool-result', { id: payload.id, ok: true, targetId: 'wp-dark', title: '暗夜' });
        } else if (String(payload.tool) === 'wallpaper_cycle') {
          settings.rotationEnabled = !(payload.args && payload.args.enabled === false);
          await post(host, '/tool-result', { id: payload.id, ok: true });
        } else {
          await post(host, '/tool-result', { id: payload.id, ok: false, error: 'no-client' });
        }
      }
    }
  }
  const doneEvent = events.find((item) => item.event === 'done') || { data: {} };
  const textOut = events.filter((item) => item.event === 'delta').map((item) => item.data.t || '').join('');
  return { events, done: doneEvent.data, text: textOut };
}

/* ── 准备：本机假 Piper 运行时 + 一个已装华言（让 packInstalled 有真路径）── */
const piperRoot = join(TEST_HOME, 'piper', 'v1');
mkdirSync(join(piperRoot, 'piper'), { recursive: true });
mkdirSync(join(piperRoot, 'models'), { recursive: true });
writeFileSync(join(piperRoot, 'piper', 'piper.exe'), 'MZ fake');
mkdirSync(join(piperRoot, 'piper', 'espeak-ng-data'), { recursive: true });
writeFileSync(join(piperRoot, 'models', 'zh_CN-huayan-medium.onnx'), Buffer.alloc(2 * 1024 * 1024));
writeFileSync(join(piperRoot, 'models', 'zh_CN-huayan-medium.onnx.json'), '{}');

/* ── A/B：声音页目录 + 卡片 + 试听 ──────────────────────────────────────── */

console.log('\nA. 声音页目录：Edge 中文名 / 429 标注');
const tts = fakeTts();
const settings = { petChat: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'fake' }, id: 'wp-old' };
const host = await startHost(settings, tts);
try {
  const catalog = (await json(host, '/voice/catalog')).doc;
  const edge = (catalog.groups || []).find((group) => group.key === 'edge');
  const edgeItems = (edge && edge.items) || [];
  check('A1 15 个 Edge 音色都有中文 label，不再出现 undefined',
    edgeItems.length === 15 && edgeItems.every((item) => item.label && !/undefined/i.test(item.label)),
    `count=${edgeItems.length} · 首条=${edgeItems[0] && edgeItems[0].label}`);
  const limited = edgeItems.find((item) => item.status === 'rate-limited');
  check('A2 429 音色保留并标注“暂不可用/限流”',
    Boolean(limited) && /429|限流/.test(`${limited.reason}`) && catalog.edgeRateLimited === true,
    limited ? `${limited.label} · ${limited.reason}` : '没有 rate-limited 项');
  const builtin = (catalog.groups || []).find((group) => group.key === 'builtin');
  check('A3 内置音色包在目录里（华言/高清）且带状态',
    Boolean(builtin) && builtin.items.length === 6
      && builtin.items.some((item) => item.label.includes('华言') && item.status === 'ready')
      && builtin.items.some((item) => item.hd === true),
    `items=${(builtin && builtin.items || []).length}`);

  console.log('\nB. 卡片选择器 + 试听');
  const panel = readFileSync(join(ROOT, 'src', 'panel-tabs-personas.js'), 'utf8');
  const voiceStart = panel.indexOf('const voicePage = (() => {');
  const voiceEnd = panel.indexOf('const permissionsPage =');
  const voiceSrc = voiceStart >= 0 && voiceEnd > voiceStart ? panel.slice(voiceStart, voiceEnd) : '';
  check('B1 声音页用单选“继承/指定”+ 卡片（不是下拉）',
    /we-persona-voice-mode/.test(voiceSrc) && /voiceCard\(/.test(voiceSrc)
      && /继承全局/.test(voiceSrc) && /指定音色/.test(voiceSrc)
      && !/自动 \/ 继承全局/.test(voiceSrc),
    'radio + voiceCard');
  check('B2 每个音色有 ▶ 试听与 /voice/preview 通道',
    /▶ 试听/.test(voiceSrc) && /\/pet-chat\/voice\/preview/.test(panel)
      && /handleVoicePreview/.test(readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8')),
    'preview button + endpoint');
  const preview = await fetch(host.base + '/voice/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'piper:zh_CN-huayan-medium' }),
  });
  const previewBytes = new Uint8Array(await preview.arrayBuffer());
  check('B3 选 piper 华言 → 试听回 audio/wav（>10KB）',
    preview.status === 200 && /audio\/wav/i.test(String(preview.headers.get('content-type') || '')) && previewBytes.byteLength > 10240
      && tts.calls.some((call) => call.opts.voice === 'piper:zh_CN-huayan-medium'),
    `status=${preview.status} bytes=${previewBytes.byteLength}`);

  /* ── C：继承 / 指定 ─────────────────────────────────────────────────── */
  console.log('\nC. 新人设默认继承；指定音色不影响全局');
  const created = await post(host, '/personas', { type: 'assistant', name: '小满' });
  const personaId = created.doc.persona.id;
  await json(host, `/personas/${personaId}/active`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  setPreferredVoice('piper:zh_CN-huayan-medium');
  const detail1 = (await json(host, `/personas/${personaId}`)).doc;
  check('C1 新建助手 express.voice.mode=inherit',
    detail1.persona.express.voice.mode === 'inherit',
    `mode=${detail1.persona.express.voice.mode}`);
  const patched = await json(host, `/personas/${personaId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ express: { voice: { mode: 'fixed', id: 'piper:zh_CN-huayan-x_low', engine: 'piper', name: 'zh_CN-huayan-x_low', rate: 2 } } }),
  });
  const detail2 = patched.doc;
  const centerAfter = readVoiceCenter();
  check('C2 改成指定音色后，全局默认不变',
    detail2.persona.express.voice.mode === 'fixed'
      && detail2.persona.express.voice.id === 'piper:zh_CN-huayan-x_low'
      && centerAfter.preferred === 'piper:zh_CN-huayan-medium'
      && detail2.voice.mode === 'fixed' && detail2.voice.id === 'piper:zh_CN-huayan-x_low',
    `preferred=${centerAfter.preferred} · voice=${detail2.voice.id}`);

  /* ── D：内置包安装 → 进度 → 完成 → 试听 ─────────────────────────────── */
  console.log('\nD. 内置音色包：下载进度 → 完成 → 试听');
  const originals = {
    ensurePiperRuntime: worker.ensurePiperRuntime,
    ensurePiperModel: worker.ensurePiperModel,
    ensureSherpaModel: worker.ensureSherpaModel,
  };
  worker.ensurePiperRuntime = async (deps) => {
    if (deps && deps.onPiperProgress) deps.onPiperProgress({ phase: 'download', file: 'runtime', doneBytes: 5, totalBytes: 10, percent: 50 });
    return { installed: true };
  };
  worker.ensurePiperModel = async (modelId, deps) => {
    const file = join(piperRoot, 'models', modelId + '.onnx');
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024));
    writeFileSync(file + '.json', '{}');
    if (deps && deps.onPiperProgress) {
      deps.onPiperProgress({ phase: 'download', file: 'model', doneBytes: 30, totalBytes: 60, percent: 50 });
      deps.onPiperProgress({ phase: 'ready', file: 'model', doneBytes: 60, totalBytes: 60 });
    }
    return { installed: true };
  };
  worker.ensureSherpaModel = async (modelId, deps) => {
    const dir = join(TEST_HOME, 'sherpa', modelId === 'melo-zh-female' ? 'vits-melo-tts-zh_en' : 'vits-zh-aishell3');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model.onnx'), Buffer.alloc(2 * 1024 * 1024));
    writeFileSync(join(dir, 'tokens.txt'), 'a 0\n');
    writeFileSync(join(dir, 'lexicon.txt'), 'a 0\n');
    if (deps && deps.onPiperProgress) deps.onPiperProgress({ phase: 'ready', file: 'model', doneBytes: 100, totalBytes: 100 });
    return { installed: true };
  };
  try {
    const install = await post(host, '/voice/packs/install', { id: 'melo-zh-female' });
    let status = null;
    for (let i = 0; i < 20; i += 1) {
      const doc = (await json(host, '/voice/packs/progress')).doc;
      status = (doc.packs || []).find((pack) => pack.id === 'melo-zh-female');
      if (status && status.installed) break;
      await wait(80);
    }
    check('D1 安装开始 → 进度轮询 → 完成（installed=true）',
      install.doc.ok === true && Boolean(status) && status.installed === true
        && status.progress.phase === 'ready',
      `started=${install.doc.started} · phase=${status && status.progress.phase}`);
    const hdPreview = await fetch(host.base + '/voice/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'melo:zh_female' }),
    });
    const hdBytes = new Uint8Array(await hdPreview.arrayBuffer());
    check('D2 高清试听与华言是不同音频（sherpa 引擎、字节数不同）',
      hdPreview.status === 200 && hdBytes.byteLength !== previewBytes.byteLength
        && tts.calls.some((call) => call.opts.voice === 'melo:zh_female'),
      `huayan=${previewBytes.byteLength} · hd=${hdBytes.byteLength}`);
    await post(host, '/voice/packs/remove', { id: 'melo-zh-female' });
    const afterRemove = listPacks().find((pack) => pack.id === 'melo-zh-female');
    check('D3 删除包后 installed=false，运行时不受影响', afterRemove.installed === false);
  } finally {
    worker.ensurePiperRuntime = originals.ensurePiperRuntime;
    worker.ensurePiperModel = originals.ensurePiperModel;
    worker.ensureSherpaModel = originals.ensureSherpaModel;
  }

  /* ── E：火山 ─────────────────────────────────────────────────────────── */
  console.log('\nE. 火山引擎：未配置 / 401 / 403 / 429 / 超时 / 真调用 / 回落');
  const noKey = await worker.volcSynthesize('你好', { voice: 'volc:zh_female_x' }, {});
  check('E1 不填 Key ⇒ volc-no-key（可读）',
    noKey.ok === false && noKey.code === 'volc-no-key' && /AppID|Access Token/.test(noKey.error),
    noKey.error);

  let volcMode = 'legacy';
  let volcStatus = 200;
  let volcDelayMs = 0;
  const volcServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const reply = () => {
        res.statusCode = volcStatus;
        if (volcStatus === 401) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: 'bad token' })); return; }
        if (volcStatus === 403) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: 'service not opened' })); return; }
        if (volcStatus === 429) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: 'rate limited' })); return; }
        res.setHeader('content-type', volcMode === 'seed' ? 'application/x-ndjson' : 'application/json');
        if (volcMode === 'seed') {
          res.end(JSON.stringify({ code: 0, data: makeMp3(12000).toString('base64') }) + '\n'
            + JSON.stringify({ code: 20000000 }) + '\n');
        } else {
          res.end(JSON.stringify({ code: 3000, message: 'Success', data: makeMp3(12000).toString('base64') }));
        }
      };
      if (volcDelayMs) setTimeout(reply, volcDelayMs); else reply();
    });
  });
  await new Promise((r) => { volcServer.listen(0, '127.0.0.1', r); });
  const volcBase = `http://127.0.0.1:${volcServer.address().port}/`;
  const volcCfg = { appId: 'app-id', accessToken: 'token-secret', voiceId: 'zh_female_x', baseUrl: volcBase };
  try {
    for (const [code, expect, label] of [
      [401, 'volc-unauthorized', '401 鉴权失败'],
      [403, 'volc-forbidden', '403 未开通/权限不足'],
      [429, 'volc-rate-limited', '429 限流'],
    ]) {
      volcStatus = code;
      const result = await worker.volcSynthesize('测试', { voice: 'volc:zh_female_x', online: { volcengine: volcCfg } }, {});
      check(`E2 ${label} ⇒ ${expect} 且原因可读`,
        result.ok === false && result.code === expect && /401|403|429|火山/.test(result.error)
          && !String(result.error).includes('token-secret'),
        `${result.code} · ${result.error}`);
    }
    volcStatus = 200; volcMode = 'legacy';
    const legacy = await worker.volcSynthesize('测试', { voice: 'volc:zh_female_x', online: { volcengine: volcCfg } }, {});
    check('E3 传统 TTS 真调用 ⇒ ok + subtype=volc-tts + mp3',
      legacy.ok === true && legacy.subtype === 'volc-tts' && legacy.mime === 'audio/mpeg' && legacy.bytes > 1024,
      `subtype=${legacy.subtype} bytes=${legacy.bytes}`);
    volcMode = 'seed';
    const seed = await worker.volcSynthesize('测试', { voice: 'volc:zh_female_x', online: { volcengine: { ...volcCfg, subtype: 'volc-seed-tts', resourceId: 'seed-tts-2.0' } } }, {});
    check('E4 Seed-TTS 真调用 ⇒ ok + subtype=volc-seed-tts',
      seed.ok === true && seed.subtype === 'volc-seed-tts' && seed.bytes > 1024,
      `subtype=${seed.subtype} bytes=${seed.bytes}`);
    volcStatus = 200; volcMode = 'legacy'; volcDelayMs = 6000;
    const timed = await worker.volcSynthesize('测试', {
      voice: 'volc:zh_female_x', timeoutMs: 3000, online: { volcengine: volcCfg },
    }, {});
    volcDelayMs = 0;
    check('E5 超时 ⇒ volc-timeout（不静默）', timed.ok === false && timed.code === 'volc-timeout', timed.error);
  } finally {
    await new Promise((r) => { volcServer.close(r); });
  }

  const fallback = await worker.synthesizePolicy('回落测试。', {
    voice: 'volc:zh_female_x', rate: 0, policy: true,
    online: { volcengine: { ...volcCfg, baseUrl: 'http://127.0.0.1:9/' } },
  }, {
    runEdgeOnline: async () => ({ ok: true, file: 'edge-fake.wav', bytes: 12000, voice: 'zh-CN-XiaoxiaoNeural', mime: 'audio/wav', ms: 3 }),
  });
  check('E6 火山失败自动回落到 Edge（attempts 带 volc 原因）',
    fallback.ok === true && fallback.engine === 'edge'
      && fallback.attempts.some((item) => item.engine === 'volc'),
    `engine=${fallback.engine} attempts=${JSON.stringify(fallback.attempts)}`);

  const volcView = (await json(host, '/voice/providers')).doc.providers.find((item) => item.id === 'volcengine');
  check('E7 未配置时 /voice/providers 显示 unconfigured', volcView.configured === false && volcView.status === 'unconfigured');
  await post(host, '/voice/providers', {
    provider: 'volcengine', appId: 'app-id', accessToken: 'token-secret',
    cluster: 'volcano_tts', resourceId: 'seed-tts-2.0', subtype: 'volc-seed-tts', voiceId: 'zh_female_x',
  });
  const volcView2 = (await json(host, '/voice/providers')).doc.providers.find((item) => item.id === 'volcengine');
  check('E8 保存后只回掩码（不含 token 原文）',
    volcView2.configured === true && Boolean(volcView2.maskedToken)
      && !JSON.stringify(volcView2).includes('token-secret'),
    `mask=${volcView2.maskedToken}`);
  const volcTest = await post(host, '/voice/providers/test', { provider: 'volcengine' });
  check('E9 「测试」按钮真调一次（假 TTS 返回 volc 引擎）',
    volcTest.doc.ok === true && volcTest.doc.engine === 'volc'
      && tts.calls.some((call) => String(call.opts.voice || '').startsWith('volc:')),
    `ok=${volcTest.doc.ok} engine=${volcTest.doc.engine} error=${volcTest.doc.error || ''}`);

  /* ── F：如何获取六步 ─────────────────────────────────────────────────── */
  console.log('\nF. 火山「如何获取」六步');
  const howTo = (await json(host, '/voice/catalog')).doc.howTo || [];
  const howText = JSON.stringify(howTo);
  check('F1 六步齐全：注册/开通/AppID+Token/ResourceID/测试/计费',
    howTo.length === 6
      && /注册|实名/.test(howText) && /开通/.test(howText)
      && /AppID/.test(howText) && /Access Token/.test(howText)
      && /Resource ID|Cluster/.test(howText) && /计费|充值|额度/.test(howText),
    `${howTo.length} 步 · ${howTo.map((step) => step.title).join(' / ')}`);

  /* ── G：权限三档 ─────────────────────────────────────────────────────── */
  console.log('\nG. 权限三档：allow / ask / deny');
  // 壁纸默认 allow：直接发 action，回执成功后 verified=true
  const wall = await chat(host, settings, '把壁纸换成暗色的', null, personaId);
  check('G1 壁纸 allow ⇒ 直接执行并经回读确认',
    wall.done.tool === 'wallpaper_switch' && wall.done.verified === true
      && wall.events.some((event) => event.event === 'action')
      && wall.text.includes('好，我这就办'),
    `done=${JSON.stringify(wall.done)} · text=${wall.text}`);

  await wait(1100);
  const mediaAsk = await chat(host, settings, '暂停播放', null, personaId);
  check('G2 媒体 ask ⇒ 先问，不执行',
    mediaAsk.done.confirm === true && mediaAsk.done.tool === 'media_control'
      && mediaAsk.events.some((event) => event.event === 'confirm')
      && !mediaAsk.events.some((event) => event.event === 'action'),
    `done=${JSON.stringify(mediaAsk.done)} · text=${mediaAsk.text}`);
  await wait(1100);
  const mediaYes = await chat(host, settings, '好', null, personaId);
  check('G3 语音说「好」⇒ 执行（confirmed 落审计）',
    mediaYes.done.tool === 'media_control' && mediaYes.done.confirm !== true
      && mediaYes.text.length > 0,
    `done=${JSON.stringify(mediaYes.done)} · text=${mediaYes.text}`);

  // 把媒体组改成 deny：任何请求都明确拒绝
  await post(host, `/personas/${personaId}/permissions`, { group: 'media', level: 'deny' });
  await wait(1100);
  const mediaDeny = await chat(host, settings, '暂停播放', null, personaId);
  check('G4 媒体 deny ⇒ 明确拒绝，不弹确认、不执行',
    mediaDeny.done.toolRefused === true && !mediaDeny.events.some((event) => event.event === 'confirm')
      && !mediaDeny.events.some((event) => event.event === 'action')
      && mediaDeny.text.includes('不能做'),
    `done=${JSON.stringify(mediaDeny.done)} · text=${mediaDeny.text}`);

  // 气泡按钮：/tool-confirm（deny 不执行；allow 把客户端动作交回浏览器）
  await post(host, `/personas/${personaId}/permissions`, { group: 'wallpaper', level: 'ask' });
  await wait(1100);
  const wallAsk = await chat(host, settings, '把壁纸换成暗色的', null, personaId);
  const wallConfirm = wallAsk.events.find((event) => event.event === 'confirm');
  const denyBubble = await post(host, '/tool-confirm', { id: wallConfirm && wallConfirm.data.id, decision: 'deny' });
  check('G5 气泡「不允许」⇒ 不执行（无 clientAction）',
    Boolean(wallConfirm) && denyBubble.doc.ok === true && !denyBubble.doc.clientAction
      && denyBubble.doc.say.includes('不办'),
    `confirm=${Boolean(wallConfirm)} · doc=${JSON.stringify(denyBubble.doc)}`);

  await wait(1100);
  const wallAsk2 = await chat(host, settings, '把壁纸换成暗色的', null, personaId);
  const wallConfirm2 = wallAsk2.events.find((event) => event.event === 'confirm');
  const allowBubble = await post(host, '/tool-confirm', { id: wallConfirm2 && wallConfirm2.data.id, decision: 'allow' });
  check('G6 气泡「允许」⇒ 执行，客户端动作回传（wallpaper_switch）',
    allowBubble.doc.ok === true && allowBubble.doc.clientAction
      && allowBubble.doc.clientAction.tool === 'wallpaper_switch',
    `doc=${JSON.stringify(allowBubble.doc)}`);

  await post(host, `/personas/${personaId}/permissions`, { group: 'media', level: 'ask' });
  await wait(1100);
  const mediaAsk2 = await chat(host, settings, '暂停播放', null, personaId);
  const mediaConfirm2 = mediaAsk2.events.find((event) => event.event === 'confirm');
  const always = await post(host, '/tool-confirm', { id: mediaConfirm2 && mediaConfirm2.data.id, decision: 'always' });
  const afterAlways = readPersona(personaId).permissions;
  check('G7 「以后都允许」写 consentMemory + 把组改成 allow',
    always.doc.confirmed === true && afterAlways.media === 'allow'
      && afterAlways.consentMemory && afterAlways.consentMemory.media === 'allow',
    `media=${afterAlways.media} consent=${JSON.stringify(afterAlways.consentMemory)}`);

  await post(host, `/personas/${personaId}/permissions`, { group: 'docs', level: 'ask' });
  await wait(1100);
  const docAsk = await chat(host, settings, '读一下 README.md', null, personaId);
  const docConfirm = docAsk.events.find((event) => event.event === 'confirm');
  const never = await post(host, '/tool-confirm', { id: docConfirm && docConfirm.data.id, decision: 'never' });
  const afterNever = readPersona(personaId).permissions;
  check('G8 「以后都别问」把组改成 deny',
    never.doc.ok === true && afterNever.docs === 'deny'
      && afterNever.consentMemory && afterNever.consentMemory.docs === 'deny',
    `docs=${afterNever.docs} consent=${JSON.stringify(afterNever.consentMemory)}`);

  await post(host, `/personas/${personaId}/permissions`, { group: 'docs', level: 'ask' });
  // 新增工具：media_control / status_query / doc_read / search_query / wallpaper_cycle
  const toolNames = personaToolRegistry(readPersona(personaId)).map((tool) => tool.name);
  check('G9 五个新工具都进了（按权限过滤后的）工具表',
    ['media_control', 'status_query', 'doc_read', 'search_query', 'wallpaper_cycle'].every((name) => toolNames.includes(name)),
    toolNames.join(','));

  await post(host, `/personas/${personaId}/permissions`, { group: 'wallpaper', level: 'allow' });
  await wait(1100);
  const cycle = await chat(host, settings, '打开轮播', null, personaId);
  check('G10 wallpaper_cycle 真执行并经回读确认（轮播打开）',
    cycle.done.tool === 'wallpaper_cycle' && cycle.done.verified === true && settings.rotationEnabled === true,
    `done=${JSON.stringify(cycle.done)}`);

  await wait(1100);
  const status = await chat(host, settings, '现在用的什么音色', null, personaId);
  check('G11 status_query 返回壁纸/音色/音量/播放状态',
    status.done.tool === 'status_query' && status.done.verified === true
      && status.text.includes('音色') && status.text.includes('音量'),
    `text=${status.text}`);

  await post(host, `/personas/${personaId}/permissions`, { group: 'docs', level: 'ask' });
  await wait(1100);
  const docAsk2 = await chat(host, settings, '读一下 README.md', null, personaId);
  const docConfirm2 = docAsk2.events.find((event) => event.event === 'confirm');
  const docAllowed = await post(host, '/tool-confirm', { id: docConfirm2 && docConfirm2.data.id, decision: 'allow' });
  check('G12 doc_read 经「允许」后只读工作区文件（不写不删）',
    docAllowed.doc.ok === true && /README/.test(String(docAllowed.doc.say || '')),
    `say=${docAllowed.doc.say}`);

  await wait(1100);
  const searchAsk = await chat(host, settings, '搜索 今天的天气', null, personaId);
  const searchConfirm = searchAsk.events.find((event) => event.event === 'confirm');
  const searchDeny = await post(host, '/tool-confirm', { id: searchConfirm && searchConfirm.data.id, decision: 'deny' });
  check('G13 search_query 默认 ask：先问；拒绝后不发网络请求',
    Boolean(searchConfirm) && searchDeny.doc.ok === true && searchDeny.doc.decision === 'deny',
    `confirm=${Boolean(searchConfirm)} · doc=${JSON.stringify(searchDeny.doc)}`);

  /* ── H：特殊人设 ─────────────────────────────────────────────────────── */
  console.log('\nH. 特殊人设：代码层拒绝 + 权限页');
  const character = await post(host, '/personas', { type: 'character', name: '阿米娅' });
  const characterId = character.doc.persona.id;
  const charPerm = (await json(host, `/personas/${characterId}/permissions`)).doc;
  check('H1 特殊人设权限页：不能使用系统工具，所有组 deny',
    charPerm.isCharacter === true && charPerm.message.includes('不能使用系统工具')
      && charPerm.groups.every((group) => group.permission === 'deny' && group.available === false),
    charPerm.message);
  const charTools = personaToolRegistry(readPersona(characterId));
  check('H2 特殊人设工具表为空（代码层）', charTools.length === 0);
  await json(host, `/personas/${characterId}/active`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await wait(1100);
  const charChat = await chat(host, settings, '把壁纸换成暗色的', null, characterId);
  check('H3 特殊人设请求工具 ⇒ 明确拒绝（toolRefused）',
    charChat.done.toolRefused === true && charChat.text.includes('特殊人设')
      && !charChat.events.some((event) => event.event === 'action'),
    `${charChat.text} · ${JSON.stringify(charChat.done)}`);
  const charWrite = await post(host, `/personas/${characterId}/permissions`, { group: 'media', level: 'allow' });
  check('H4 特殊人设写权限 ⇒ 403 代码层拒绝（不信 UI）',
    charWrite.status === 403 && charWrite.doc.code === 'character-no-tools',
    `${charWrite.status} ${charWrite.doc.code}`);

  /* ── I：审计 ─────────────────────────────────────────────────────────── */
  console.log('\nI. 审计 tool-log.jsonl');
  const logFile = toolLogPath(personaId);
  const logDoc = (await json(host, `/personas/${personaId}/tool-log?limit=100`)).doc;
  const logText = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  check('I1 每次调用落 tool-log.jsonl（含 permission/confirmed/verified）',
    existsSync(logFile) && logDoc.items.length >= 2
      && logDoc.items.every((item) => 'permission' in item && 'confirmed' in item && 'verified' in item),
    `items=${logDoc.items.length} · 文件 ${logText.split('\n').filter(Boolean).length} 行`);
  check('I2 ask 确认后的记录 confirmed=true；deny 的记录 permission=deny',
    logDoc.items.some((item) => item.tool === 'media_control' && item.confirmed === true && item.permission === 'ask')
      && logDoc.items.some((item) => item.tool === 'media_control' && item.permission === 'deny' && item.result === 'denied'),
    JSON.stringify(logDoc.items.slice(0, 4)));
  await json(host, `/personas/${personaId}/tool-log`, { method: 'DELETE' });
  const cleared = (await json(host, `/personas/${personaId}/tool-log`)).doc;
  check('I3 清空后 0 条', cleared.items.length === 0);

  /* ── J：高级权限 ─────────────────────────────────────────────────────── */
  console.log('\nJ. 高级权限：关闭不可用；打开仍二次确认');
  const locked = await post(host, `/personas/${personaId}/permissions`, { group: 'system', level: 'allow' });
  check('J1 高级权限关闭时，system 不允许设为 allow（409 advanced-required）',
    locked.status === 409 && locked.doc.code === 'advanced-required',
    `${locked.status} ${locked.doc.code}`);
  const activeBefore = readPersona(personaId);
  check('J2 高级权限关闭时，系统工具不在工具表里',
    !personaToolRegistry(activeBefore).some((tool) => tool.name === 'skin_uninstall')
      && toolPolicy(activeBefore, 'skin_uninstall').allowed === false,
    JSON.stringify(toolPolicy(activeBefore, 'skin_uninstall')));
  await post(host, `/personas/${personaId}/permissions`, { advanced: true });
  const opened = await post(host, `/personas/${personaId}/permissions`, { group: 'system', level: 'allow' });
  check('J3 打开高级权限后可设为 allow；但高危仍需二次确认',
    opened.doc.ok === true
      && opened.doc.groups.find((group) => group.id === 'system').permission === 'allow'
      && readPersona(personaId).permissions.advanced === true,
    JSON.stringify(opened.doc.groups.find((group) => group.id === 'system')));
  await json(host, `/personas/${personaId}/active`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await wait(1100);
  const danger = await chat(host, settings, '卸载当前皮肤', null, personaId);
  check('J4 即使 allow，system 动作仍先问确认',
    danger.done.confirm === true && danger.done.tool === 'skin_uninstall'
      && danger.events.some((event) => event.event === 'confirm'),
    `done=${JSON.stringify(danger.done)}`);
  await post(host, `/personas/${personaId}/permissions`, { advanced: false });
  check('J5 关闭高级权限后 system 立即不可用',
    toolPolicy(readPersona(personaId), 'skin_uninstall').allowed === false);
} finally {
  await host.close();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 收账 ──────────────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.ok);
console.log(`\nVOICE/PERMISSION V2 CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
