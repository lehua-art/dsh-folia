/**
 * voice-pre57-route-check.mjs — pre.57 路由闭环（假 TTS，不发真请求）。
 *
 * 覆盖：内置音色「勾选→启用」只写一个 enabledEngine、Azure/ElevenLabs Key
 * 只写不读、测试按钮的真实回落标记、/tts 把当前启用音色作为 activeEngine。
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_FOLIA_HOME = mkdtempSync(join(tmpdir(), 'folia-pre57-route-'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
function makeWav(n = 12000) {
  const b = Buffer.alloc(n);
  b.write('RIFF', 0); b.writeUInt32LE(n - 8, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n - 44, 40);
  return b;
}

const ttsCalls = [];
const fakeTts = {
  async synthesize(text, opts = {}) {
    ttsCalls.push({ text, opts });
    const voice = String(opts.voice || '');
    const engine = /^openai:/i.test(voice) ? 'openai'
      : /^azure:/i.test(voice) ? 'azure'
        : /^elevenlabs:/i.test(voice) ? 'elevenlabs'
          : String(opts.activeEngine || 'edge');
    return {
      ok: true, wav: makeWav(), engine,
      transport: engine === 'edge' ? 'online' : 'local',
      mime: 'audio/wav', voice: voice || (engine === 'edge' ? 'zh-CN-XiaoxiaoNeural' : engine),
      requestedVoice: voice, fallback: false, fallbackFrom: '', attempts: [], ms: 1, cached: false,
    };
  },
  async voices(opts = {}) {
    const list = [
      { engine: 'edge', id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao', lang: 'zh-CN', usable: true },
      { engine: 'piper', id: 'piper:zh_CN-huayan-medium', label: 'Huayan', lang: 'zh-CN', usable: true },
    ];
    if (opts.sapiEnabled === true) {
      list.push({ engine: 'sapi', id: 'Microsoft Huihui Desktop', label: 'Huihui', lang: 'zh-CN', usable: true });
    }
    return list;
  },
  voiceMeta() {
    return {
      defaultVoice: 'zh-CN-XiaoxiaoNeural', defaultEngine: 'edge',
      edge: { ok: true, voice: 'zh-CN-XiaoxiaoNeural', voices: 1 },
      piper: { installed: true },
    };
  },
  stop() { return { ok: true, generation: 1 }; },
  status() {
    return {
      ok: true, ready: true, engines: ['edge', 'openai', 'azure', 'elevenlabs', 'piper', 'sapi'],
      policy: ['edge', 'piper', 'sapi'], defaultVoice: 'zh-CN-XiaoxiaoNeural',
      defaultEngine: 'edge', lastResult: null,
    };
  },
  dispose() {},
};

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const routes = [];
const host = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
registerPetChatRoutes(host, {
  disposers: [], base: '/folia', log: () => {},
  readSettings: () => ({ petChat: { voice: { name: '', muted: false, sapiEnabled: false } } }),
  speechToText: undefined, tts: fakeTts,
});
const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
const server = createServer((req, res) => route.handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/folia/pet-chat`;
const request = async (path, init) => {
  const response = await fetch(base + path, init);
  const type = String(response.headers.get('content-type') || '');
  return { status: response.status, json: type.includes('json') ? await response.json() : null, type };
};
const post = (path, body) => request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
});

try {
  const initial = await request('/voice/config');
  check('① 默认启用 Edge、连续对话默认开（连续设置未显式关闭）',
    initial.json.data.enabledEngine === 'edge' && initial.json.data.continuous === true,
    `engine=${initial.json.data.enabledEngine} continuous=${initial.json.data.continuous}`);

  for (const engine of ['edge', 'piper', 'sapi']) {
    const resp = await post('/voice/enable', { engine });
    const cfg = await request('/voice/config');
    check(`② 启用 ${engine}：真合成测试句后才切换唯一启用项`,
      resp.json.ok === true && resp.json.engine === engine
        && cfg.json.data.enabledEngine === engine
        && ttsCalls.some((c) => c.opts.activeEngine === engine && c.opts.policy === true),
      `ok=${resp.json.ok} enabled=${cfg.json.data.enabledEngine}`);
  }

  const off = await post('/voice/config', { enabledEngine: 'edge', continuous: false });
  check('② 设置项「连续对话」可保存关闭', off.json.ok === true && off.json.data.continuous === false
    && (await request('/voice/config')).json.data.continuous === false);

  const azSave = await post('/voice/providers', {
    provider: 'azure', apiKey: 'az-secret-key-123', region: 'eastasia', voice: 'zh-CN-XiaoxiaoNeural', enabled: true,
  });
  const providers = await request('/voice/providers');
  const az = providers.json.providers.find((p) => p.id === 'azure');
  check('③ Azure Key 只写不读：GET 只回掩码，不回原文',
    azSave.json.ok === true && az.hasKey === true && /^az-/.test(az.maskedKey)
      && !JSON.stringify(providers.json).includes('az-secret-key-123'),
    `mask=${az.maskedKey}`);

  const azTest = await post('/voice/providers/test', { provider: 'azure' });
  check('③ Azure 测试按钮走真合成，成功写成 connected',
    azTest.json.ok === true && azTest.json.provider === 'azure'
      && azTest.json.engine === 'azure'
      && providers.json.providers.find((p) => p.id === 'azure').available === true,
    `engine=${azTest.json.engine} voice=${azTest.json.actualVoice}`);

  const elSave = await post('/voice/providers', {
    provider: 'elevenlabs', apiKey: 'sk_eleven_secret_123', voiceId: 'voice123', modelId: 'eleven_multilingual_v2', enabled: true,
  });
  const elTest = await post('/voice/providers/test', { provider: 'elevenlabs' });
  check('③ ElevenLabs 测试按钮走真合成并保存设置',
    elSave.json.ok === true && elTest.json.ok === true && elTest.json.engine === 'elevenlabs',
    `engine=${elTest.json.engine}`);

  const unsupported = await post('/voice/providers', { provider: 'minimax', apiKey: 'x' });
  check('③ 未接通渠道拒绝写入 Key，并明确 coming-soon',
    unsupported.status === 400 && unsupported.json.code === 'provider-coming-soon'
      && /尚未|未实现/.test(String(unsupported.json.error || '')),
    unsupported.json.code);

  const ttsResp = await request('/tts?text=' + encodeURIComponent('你好'));
  const last = ttsCalls[ttsCalls.length - 1];
  check('④ /tts 把配置里的 enabledEngine 传给服务（失败只回落到这个音色）',
    ttsResp.status === 200 && last.opts.activeEngine === 'edge' && last.opts.policy === true,
    `active=${last.opts.activeEngine} type=${ttsResp.type}`);
} finally {
  await new Promise((r) => server.close(r));
}

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`  ${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
