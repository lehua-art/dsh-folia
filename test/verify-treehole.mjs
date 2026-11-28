/**
 * verify-treehole.mjs — v1.2 判据 T1：树洞先共情+提问、不急着建议；
 * 连续 3 轮不重复同一句安慰；危机词触发安全提示（可配置热线）。
 */
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT || 'C:/Windows/Temp/folia-asr-none';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'folia-treehole-'));
process.env.DSH_FOLIA_HOME = HOME;
const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const store = await import('../lib/persona-store.js');
const mem = await import('../lib/persona-memory.js');
const { buildPersonaSystemPrompt, detectCrisis, treeholeSafetyReply } = await import('../lib/pet-chat-brain.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const persona = store.createPersona({ type: 'assistant', name: '树洞' });
store.setActivePersona(persona.id);
const settings = {
  petChat: { enabled: true, provider: 'ollama', baseUrl: '', model: 'fake', treehole: { hotline: '400-123-4567' } },
};

function startHost() {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, { disposers: [], base: '/folia', log: () => {}, readSettings: () => settings, speechToText: null });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => resolveP({ base: `http://127.0.0.1:${server.address().port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) }));
  });
}
function startModel(script) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      seen.push({ url: req.url, body: parsed });
      const piece = typeof script === 'function' ? script(seen.length) : script;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const line of [JSON.stringify({ message: { content: piece }, done: false })]) res.write(line + '\n');
      res.end();
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => resolveP({ base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) }));
  });
}
async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
    }
  }
  return events;
}
const say = async (base, text) => {
  const res = await fetch(`${base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, inputMode: 'text' }),
  });
  const events = await readSse(res);
  return { events, text: events.filter((item) => item.event === 'delta').map((item) => item.data.t).join(''), done: events.filter((item) => item.event === 'done').at(-1)?.data || {} };
};

/* ① prompt 规则 */
const prompt = buildPersonaSystemPrompt(persona, { turnPolicy: 'empathy' });
check('T1① 树洞 prompt：先接住情绪 + 开放问题 + 不急建议 + 不诊断',
  /先接住情绪/.test(prompt) && /开放问题/.test(prompt) && /不急着给建议/.test(prompt)
  && /不评判、不诊断/.test(prompt) && /不是心理治疗/.test(prompt),
  'prompt rules');

/* ② 危机词：固定安全回应（含配置热线），不交给模型 */
const model = await startModel('我一直都在。慢慢说，最近发生了什么？');
settings.petChat.baseUrl = model.base;
const host = await startHost();
check('T1② 危机词识别（想死/自残/轻生…）', detectCrisis('我不想活了') === '不想活' && detectCrisis('今天好累') === '',
  'detectCrisis');
const crisis = await say(host.base, '我真的撑不住了，我不想活了');
check('T1③ 危机回应：先关心安全 + 求助热线（配置化）+ 明确不是心理治疗 + 不调模型',
  crisis.text.includes('400-123-4567') && /不是心理治疗/.test(crisis.text) && crisis.done.safety === true
  && model.seen.length === 0,
  `safety=${crisis.done.safety} modelCalls=${model.seen.length}`);
check('T1④ 安全回应文案可配置（热线注入）',
  treeholeSafetyReply('999').includes('999'), 'hotline inject');

/* ③ 普通倾诉：走模型、prompt 是树洞规则、记忆 importance 7 */
await new Promise((r) => setTimeout(r, 1100));
const first = await say(host.base, '今天好累');
const firstSystem = String((model.seen.at(-1).body.messages || [])[0].content || '');
check('T1⑤ 普通倾诉走模型，system 带“情绪优先”规则',
  first.text.length > 0 && /情绪优先/.test(firstSystem) && first.done.policy === 'empathy',
  first.text.slice(0, 20));
const events = mem.listEvents(persona.id, { limit: 20 }).items;
check('T1⑥ 树洞记住“在意的事/情绪触发点”（kind=treehole, importance 7）',
  events.some((item) => item.kind === 'treehole' && item.importance === 7 && item.text.includes('今天好累')),
  'treehole event');

/* ④ 连续 3 轮不重复：第 3 轮 system 里出现「别重复」 */
await new Promise((r) => setTimeout(r, 1100));
await say(host.base, '还是好累，什么都不想做');
await new Promise((r) => setTimeout(r, 1100));
await say(host.base, '感觉最近一直很累');
const thirdSystem = String((model.seen.at(-1).body.messages || [])[0].content || '');
check('T1⑦ 连续 3 轮倾诉：prompt 带「别重复」最近安慰',
  /【别重复】/.test(thirdSystem), 'avoid-lines');

await host.close();
await model.close();
const failed = results.filter((item) => !item.ok);
console.log(`\nTREEHOLE CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
