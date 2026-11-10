/**
 * verify-pet-settings.mjs — 桌宠对话设置区的 6 条判据。
 *
 * 面板是 React 渲染的（Node 里没有 DOM），所以「控件渲染」用源码级判据：
 * 这一区必须同时具备这些控件名。其余 5 条都走**真 HTTP**（真 http.Server + 真路由）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'folia-pet-settings-'));
process.env.DSH_FOLIA_HOME = HOME;

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');

const results = [];
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); }

/** 起一个假宿主：只有 pet-chat 路由 + 一个会话外的最小 settings。 */
function startHost(settings) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [],
    base: '/folia',
    log: () => {},
    readSettings: () => settings,
    speechToText: undefined,
    edgeTts: undefined,
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

/* ① 控件渲染（源码级） */
{
  const source = readFileSync(join(ROOT, 'src', 'panel-tabs-pets.js'), 'utf8');
  const required = [
    '开启对话', '模型来源', 'OpenAI 兼容', '本机 Ollama', '接口地址', '模型名', 'API Key', '测试连接',
    '人设', '上下文轮数', '字数上限', '朗读回答', '音色', '语速', '音量', '试听', '朗读引擎',
    '长期记忆', '查看记忆', '清空记忆', '语音输入（需先在 DSH 开启）', '保存',
  ];
  const missing = required.filter((label) => !source.includes(label));
  check('① 控件齐全（24 个标签）', missing.length === 0, missing.length ? `缺：${missing.join('、')}` : '全部存在');
}

/* ② 保存后连上（enabled/provider/model 立刻生效） */
{
  const host = await startHost(settings);
  const saved = await postJson(`${host.base}/config`, {
    enabled: true, provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-test-1234',
    persona: { name: '小鲸', traits: '元气', notes: '喜欢壁纸' }, maxTurns: 6, maxChars: 60,
    voiceOut: { enabled: true, rate: 1.2, volume: 0.8, voiceURI: '' }, voiceEngine: 'edge',
    memoryEnabled: true,
  });
  const state = await getJson(`${host.base}/state`);
  const config = await getJson(`${host.base}/config`);
  check('② 保存后配置立刻生效（enabled/provider/model/persona）',
    saved.body.data.saved === true
      && state.body.enabled === true && state.body.provider === 'openai' && state.body.model === 'deepseek-chat'
      && config.body.data.persona.name === '小鲸' && config.body.data.maxTurns === 6
      && config.body.data.voiceOut.rate === 1.2 && config.body.data.voiceEngine === 'edge',
    `saved=${saved.body.data.saved} · state=${state.body.provider}/${state.body.model} · persona=${config.body.data.persona.name}`);
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
      && config.body.data.provider === 'ollama'
      && config.body.data.baseUrl === 'http://127.0.0.1:11434/v1'
      && config.body.data.hasApiKey === false,
    `provider=${config.body.data.provider} · baseUrl=${config.body.data.baseUrl} · hasApiKey=${config.body.data.hasApiKey}`);
  await host.close();
}

/* ④ 测试失败给具体原因（401 / 地址错） */
{
  const host = await startHost(settings);
  // 假 provider：一律 401
  const provider = createServer((req, res) => { res.statusCode = 401; res.end('{"error":"invalid api key"}'); });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerPort = provider.address().port;

  const unauthorized = await postJson(`${host.base}/test`, { provider: 'openai', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'bad' });
  const badDns = await postJson(`${host.base}/test`, { provider: 'openai', baseUrl: 'http://no-such-host.invalid', apiKey: 'x' });

  check('④ 测试连接失败 ⇒ 给具体原因（401 / 地址错）',
    unauthorized.body.ok === false && unauthorized.body.code === 'unauthorized'
      && badDns.body.ok === false && ['dns', 'network', 'timeout'].includes(badDns.body.code),
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
    before.body.memory.nickname === '小鲸' && before.body.memory.likes.includes('原神')
      && cleared.body.cleared === true
      && (!after.body.memory || !after.body.memory.nickname),
    `清空前昵称=${before.body.memory.nickname} · 清空后=${after.body.memory && after.body.memory.nickname}`);
  await host.close();
}

/* ⑥ 关闭对话后点宠物不弹气泡（源码级） */
{
  const source = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const guarded = /function petChatShow\(\)[\s\S]{0,220}petChatChatEnabled === false\) return;/.test(source);
  check('⑥ 关闭对话 ⇒ petChatShow 直接返回（不弹气泡）', guarded, `守卫存在=${guarded}`);
}

/* 汇总 */
let failed = 0;
for (const item of results) {
  if (item.ok) process.stdout.write(`  ✓ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`);
  else { failed += 1; process.stdout.write(`  ✗ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`); }
}
process.stdout.write(`\n  ${results.length - failed} 通过 / ${failed} 失败\n`);
try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
if (failed) process.exit(1);
