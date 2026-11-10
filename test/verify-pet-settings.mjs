/**
 * verify-pet-settings.mjs — 桌宠对话设置（v0.1 收敛后）的判据。
 *
 * v0.1 把配置收敛成一个 petChat 对象：{enabled, apiKey, provider, baseUrl, model,
 * petName, ownerName, voice:{name,muted}, wake:{click,name,keyword}, memoryEnabled}。
 * 面板只剩"key / 音色 / 名字 / 静音"四项，其余走默认值。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'folia-pet-settings-'));
process.env.DSH_FOLIA_HOME = HOME;

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); }

function startHost(settings) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [], base: '/folia', log: () => {},
    readSettings: () => settings, speechToText: undefined, edgeTts: undefined,
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  assert.ok(route, '路由已注册');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}/folia/pet-chat`, server, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const getJson = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
};
const postJson = (url, body) => getJson(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const settings = { petChat: { enabled: false } };

/* ① 控件齐全（源码级：面板只剩四项 + 右键说明） */
{
  const source = readFileSync(join(ROOT, 'src', 'panel-tabs-pets.js'), 'utf8');
  const required = ['API Key', '测试连接', '音色', '静音', '名字', '称呼', '保存', '右键'];
  const missing = required.filter((label) => !source.includes(label));
  // 旧的长设置区必须真的没了
  const legacy = ['上下文轮数', '字数上限', '朗读引擎', '主动闲聊', '人设'].filter((label) => source.includes(label));
  check('① 面板只剩四项 + 右键说明（长设置区已删）',
    missing.length === 0 && legacy.length === 0,
    `缺=${missing.join('、') || '无'} · 残留=${legacy.join('、') || '无'}`);
}

/* ② 保存后配置立刻生效（新结构） */
{
  const host = await startHost(settings);
  const saved = await postJson(`${host.base}/config`, {
    enabled: true, provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
    apiKey: 'sk-test-1234', petName: '小鲸', ownerName: '主人',
    voice: { name: 'zh-CN-XiaoyiNeural', muted: false },
    wake: { click: true, name: true, keyword: '小鲸' }, memoryEnabled: true,
  });
  const state = await getJson(`${host.base}/state`);
  const config = await getJson(`${host.base}/config`);
  check('② 保存后新结构立刻生效（名字/音色/唤醒）',
    saved.body.data.saved === true
      && state.body.enabled === true && state.body.provider === 'openai' && state.body.model === 'deepseek-chat'
      && config.body.data.petName === '小鲸' && config.body.data.ownerName === '主人'
      && config.body.data.voice.name === 'zh-CN-XiaoyiNeural'
      && config.body.data.wake.keyword === '小鲸',
    `petName=${config.body.data.petName} · voice=${config.body.data.voice.name} · wake=${config.body.data.wake.keyword}`);
  await host.close();
}

/* ③ 切 ollama 自动改地址并清空 key */
{
  const host = await startHost(settings);
  await postJson(`${host.base}/config`, { enabled: true, provider: 'openai', apiKey: 'sk-keep-me', baseUrl: 'https://api.deepseek.com' });
  const switched = await postJson(`${host.base}/config`, { provider: 'ollama' });
  const config = await getJson(`${host.base}/config`);
  check('③ 切到 Ollama ⇒ 地址换成默认、key 清空',
    switched.body.data.provider === 'ollama'
      && config.body.data.baseUrl === 'http://127.0.0.1:11434/v1'
      && config.body.data.hasApiKey === false,
    `baseUrl=${config.body.data.baseUrl} · hasApiKey=${config.body.data.hasApiKey}`);
  await host.close();
}

/* ④ 测试连接失败给具体原因（401 / 地址错） */
{
  const host = await startHost(settings);
  const provider = createServer((req, res) => { res.statusCode = 401; res.end('{"error":"invalid api key"}'); });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const unauthorized = await postJson(`${host.base}/test`, { provider: 'openai', baseUrl: `http://127.0.0.1:${provider.address().port}`, apiKey: 'bad' });
  const badDns = await postJson(`${host.base}/test`, { provider: 'openai', baseUrl: 'http://no-such-host.invalid', apiKey: 'x' });
  check('④ 测试连接失败 ⇒ 给具体原因（401 / 地址错）',
    unauthorized.body.code === 'unauthorized' && ['dns', 'network', 'timeout'].includes(badDns.body.code),
    `401→${unauthorized.body.code} · 坏地址→${badDns.body.code}`);
  await new Promise((resolve) => provider.close(resolve));
  await host.close();
}

/* ⑤ 查看记忆与清空 */
{
  const host = await startHost(settings);
  const memoryFile = join(HOME, 'pet-chat', 'memory.json');
  mkdirSync(dirname(memoryFile), { recursive: true });
  writeFileSync(memoryFile, JSON.stringify({ nickname: '小鲸', likes: ['原神'], dislikes: [], notes: ['夜里更活跃'], style: '', updatedAt: Date.now() }));
  const before = await getJson(`${host.base}/memory`);
  const cleared = await getJson(`${host.base}/memory`, { method: 'DELETE' });
  const after = await getJson(`${host.base}/memory`);
  check('⑤ 查看记忆（有内容）→ 清空后为空',
    before.body.memory.nickname === '小鲸' && cleared.body.cleared === true
      && (!after.body.memory || !after.body.memory.nickname),
    `清空前=${before.body.memory.nickname} · 清空后=${after.body.memory && after.body.memory.nickname}`);
  await host.close();
}

/* ⑥ 关闭对话后点宠物不弹气泡（源码级） */
{
  const source = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const guarded = /function petChatShow\(\)[\s\S]{0,220}petChatChatEnabled === false\) return;/.test(source);
  check('⑥ 关闭对话 ⇒ petChatShow 直接返回（不弹气泡）', guarded, `守卫存在=${guarded}`);
}

/* ⑦ S1 迁移：旧档升级后不丢 key、不丢名字、不丢音色 */
{
  // 前面的用例已经往覆盖层写过东西（切 ollama 会清 key）；迁移判据要看"只有旧档"的情况
  rmSync(join(HOME, 'pet-chat', 'settings.json'), { force: true });
  const legacy = {
    petChat: {
      enabled: true, apiKey: 'sk-legacy-key', provider: 'openai',
      persona: { name: '旧名字', style: '元气', traits: '喜欢壁纸' },
      voiceOut: { enabled: false, rate: 1.5, voiceURI: 'Microsoft Huihui' },
      voiceEngine: 'edge', maxTurns: 6, maxChars: 60,
    },
  };
  const host = await startHost(legacy);
  const config = await getJson(`${host.base}/config`);
  check('⑦ 旧配置升级：key / 名字 / 音色 / 静音都不丢',
    config.body.data.hasApiKey === true
      && config.body.data.petName === '旧名字'
      && config.body.data.voice.name === 'Microsoft Huihui'
      && config.body.data.voice.muted === true,
    `hasKey=${config.body.data.hasApiKey} · name=${config.body.data.petName} · voice=${config.body.data.voice.name} · muted=${config.body.data.voice.muted}`);
  await host.close();
}

/* ⑧ 写回只写新结构（覆盖层里不出现旧键） */
{
  const host = await startHost(settings);
  await postJson(`${host.base}/config`, {
    enabled: true, apiKey: 'sk-new', petName: '新名字', voice: { name: 'zh-CN-YunxiNeural', muted: false },
    // 故意混入旧键：必须被忽略，不能写进覆盖层
    persona: { name: '不该出现' }, voiceOut: { enabled: false, voiceURI: 'legacy' }, voiceEngine: 'system', maxTurns: 3,
  });
  const overlay = JSON.parse(readFileSync(join(HOME, 'pet-chat', 'settings.json'), 'utf8'));
  const legacyKeys = ['persona', 'voiceOut', 'voiceEngine', 'maxTurns', 'maxChars'].filter((key) => key in overlay);
  check('⑧ 写回只写新结构（覆盖层无旧键）',
    legacyKeys.length === 0 && overlay.petName === '新名字' && overlay.voice.name === 'zh-CN-YunxiNeural',
    `残留旧键=${legacyKeys.join('、') || '无'} · petName=${overlay.petName}`);
  await host.close();
}

let failed = 0;
for (const item of results) {
  if (item.ok) process.stdout.write(`  ✓ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`);
  else { failed += 1; process.stdout.write(`  ✗ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`); }
}
process.stdout.write(`\n  ${results.length - failed} 通过 / ${failed} 失败\n`);
try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(failed ? 1 : 0);
