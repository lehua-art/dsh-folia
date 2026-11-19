/**
 * verify-personas.mjs — 人设系统验收（A–H；I 用 run-audit 单独跑）。
 *
 * 全部用真 http.Server + 假 OpenAI 兼容端点：模型端只看请求体/Authorization，
 * 不依赖 Ollama/外网。每个场景用独立 host（限频 1/s），跨场景用 1.1s 间隔。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-personas-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const { appendEvent, eventCount, writeBond, readBond, memoryRecallLine } = await import('../lib/persona-memory.js');
const { buildCardPng, normalizeCard } = await import('../lib/persona-card.js');
const { readPersona } = await import('../lib/persona-store.js');
const { promptTraits, growthPromptLine } = await import('../lib/persona-growth.js');
const { normalizeCardForTest } = await import('../lib/routes/personas.js');
const { personaToolRegistry } = await import('../lib/pet-chat-brain.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const wait = (ms) => new Promise((resolveP) => { setTimeout(resolveP, ms); });

/* ── 假模型（OpenAI 兼容；流式 + 反思 JSON） ───────────────────────────── */

function startModel() {
  const state = { seen: [], reply: ['我', '在。'], reflection: null };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      state.seen.push({ url: req.url, headers: req.headers, body: parsed });
      const system = String(parsed && parsed.messages && parsed.messages[0] && parsed.messages[0].content || '');
      if (parsed && parsed.stream === false) {
        let content = '{"intent":"chat","tool":null,"args":{}}';
        if (system.includes('[persona-reflection]') && state.reflection) content = JSON.stringify(state.reflection);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of state.reply) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({ base: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function startHost(settings) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [],
    base: '/folia',
    log: () => {},
    readSettings: () => settings,
    speechToText: undefined,
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  assert.ok(route, '路由已注册');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({ base: `http://127.0.0.1:${port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function request(host, path, options = {}) {
  return fetch(host.base + path, options);
}
async function json(host, path, options = {}) {
  const res = await request(host, path, options);
  return { status: res.status, doc: await res.json() };
}
async function createPersona(host, input) {
  const { doc } = await json(host, '/personas', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  assert.ok(doc.ok && doc.persona, 'create persona');
  return doc.persona;
}
async function patchPersona(host, id, patch) {
  const { doc } = await json(host, `/personas/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  assert.ok(doc.ok, 'patch persona');
  return doc.persona;
}
async function setKey(host, id, apiKey) {
  const { doc } = await json(host, `/personas/${id}/key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey }),
  });
  return doc;
}
async function chat(host, text, { inputMode = 'text', personaId } = {}) {
  const response = await request(host, '/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, inputMode, personaId }),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 流式读取必须逐块等
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const cut = buffer.indexOf('\n\n');
      if (cut < 0) break;
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (!data) continue;
      try { events.push({ event, data: JSON.parse(data) }); } catch { /* ignore */ }
    }
  }
  return { events, text: events.filter((e) => e.event === 'delta').map((e) => e.data.t).join('') };
}
const doneOf = (events) => (events.find((e) => e.event === 'done') || {}).data || {};

async function waitFor(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    // eslint-disable-next-line no-await-in-loop -- 轮询反思落盘
    await wait(120);
  }
}

const settings = { petChat: { enabled: true, provider: 'openai', baseUrl: '', model: 'global-model', apiKey: 'sk-global' } };

/* ── A：多人设、Key/模型互不影响 ───────────────────────────────────────── */
{
  console.log('\nA. 两个 assistant，Key/模型切换互不影响');
  const model = await startModel();
  model.state.reply = ['我', '在。'];
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const a = await createPersona(host, { type: 'assistant', name: 'A' });
  const b = await createPersona(host, { type: 'assistant', name: 'B' });
  await patchPersona(host, a.id, {
    active: true, core: { identity: '像诗人一样说话。' },
    model: { provider: 'openai', baseUrl: model.base, model: 'model-a' },
  });
  await setKey(host, a.id, 'sk-persona-a');
  await patchPersona(host, b.id, {
    core: { identity: '像工程师一样说话。' },
    model: { provider: 'openai', baseUrl: model.base, model: 'model-b' },
  });
  await setKey(host, b.id, 'sk-persona-b');

  await chat(host, '你好', { personaId: a.id });
  const seenA = model.state.seen.at(-1);
  await patchPersona(host, b.id, { active: true });
  await wait(1100);
  await chat(host, '你好', { personaId: b.id });
  const seenB = model.state.seen.at(-1);
  check('A1 A/B 的模型名、Key 与 prompt 身份分别生效',
    seenA.body.model === 'model-a' && seenA.headers.authorization === 'Bearer sk-persona-a'
      && seenB.body.model === 'model-b' && seenB.headers.authorization === 'Bearer sk-persona-b'
      && String(seenA.body.messages[0].content).includes('像诗人一样说话')
      && String(seenB.body.messages[0].content).includes('像工程师一样说话'),
    `A=${seenA.body.model}/${seenA.headers.authorization ? 'key' : '无'} · B=${seenB.body.model}/${seenB.headers.authorization ? 'key' : '无'}`);

  const list = await json(host, '/personas');
  const rowA = list.doc.personas.find((item) => item.id === a.id);
  check('A2 Key 列表只回掩码，不泄漏正文',
    rowA && rowA.key.hasKey === true && /••••/.test(rowA.key.maskedKey) && !JSON.stringify(list.doc).includes('sk-persona-a'),
    `masked=${rowA && rowA.key.maskedKey}`);
  await host.close();
  await model.close();
}

/* ── B：记忆隔离 ───────────────────────────────────────────────────────── */
{
  console.log('\nB. persona A 记住，B 不知道');
  const model = await startModel();
  model.state.reply = ['好', '的。'];
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const a = await createPersona(host, { type: 'assistant', name: '甲' });
  const b = await createPersona(host, { type: 'assistant', name: '乙' });
  for (const p of [a, b]) {
    await patchPersona(host, p.id, { model: { provider: 'openai', baseUrl: model.base, model: 'm' } });
    await setKey(host, p.id, 'sk-' + p.id);
  }
  await patchPersona(host, a.id, { active: true });
  await chat(host, '记住我喜欢深色壁纸');
  const memA = await json(host, `/personas/${a.id}/memory`);
  check('B1 显式记忆写入 A 的事件流（不写旧 memory.json）',
    memA.doc.total >= 1 && memA.doc.items.some((item) => item.text.includes('喜欢深色壁纸')),
    `events=${memA.doc.total}`);

  await patchPersona(host, b.id, { active: true });
  await wait(1100);
  await chat(host, '我喜欢什么？');
  const sysB = String(model.state.seen.at(-1).body.messages[0].content || '');
  check('B2 B 的 system 不含 A 的记忆', !sysB.includes('深色壁纸'), `B system 含 A 记忆=${sysB.includes('深色壁纸')}`);

  await patchPersona(host, a.id, { active: true });
  await wait(1100);
  await chat(host, '我喜欢什么？');
  const sysA = String(model.state.seen.at(-1).body.messages[0].content || '');
  check('B3 A 的 system 能召回自己的记忆', sysA.includes('深色壁纸'), `A 召回=${sysA.includes('深色壁纸')}`);
  await host.close();
  await model.close();
}

/* ── C：角色卡 JSON / PNG 导入 + 导出 ───────────────────────────────────── */
{
  console.log('\nC. 角色卡 JSON/PNG 导入导出');
  const model = await startModel();
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const card = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '阿米娅',
      description: '罗德岛的领袖。',
      personality: '温柔但坚定。',
      scenario: '罗德岛指挥室。',
      first_mes: '欢迎回来，博士。',
      mes_example: '<START>\n博士：阿米娅。\n阿米娅：我在。',
      system_prompt: '保持角色。',
      post_history_instructions: '不要说教。',
      character_book: { entries: [{ keys: ['罗德岛'], content: '移动城市。', insertion_order: 9 }] },
      tags: ['明日方舟'],
    },
  };
  const c = await createPersona(host, { type: 'character', name: '临时' });
  await patchPersona(host, c.id, { model: { provider: 'openai', baseUrl: model.base, model: 'm' } });
  await setKey(host, c.id, 'sk-c');
  const imp = await json(host, `/personas/${c.id}/import-card`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: card }),
  });
  const afterJson = (await json(host, `/personas/${c.id}`)).doc.persona;
  const normalizedCard = normalizeCard(card);
  const routeCard = normalizeCardForTest(card);
  check('C1 JSON 卡：name/identity/示例/世界书/开场白落到 core/card',
    imp.doc.ok && afterJson.name === '阿米娅' && afterJson.core.identity.includes('罗德岛的领袖')
      && afterJson.core.exampleDialogues.length >= 1 && afterJson.core.worldBook[0].keys.includes('罗德岛')
      && afterJson.card.firstMes.includes('欢迎回来')
      && normalizedCard.characterBook.length === 1 && routeCard.characterBook.length === 1,
    `name=${afterJson.name} · books=${afterJson.core.worldBook.length}`);

  const png = buildCardPng(card);
  const d = await createPersona(host, { type: 'character', name: 'PNG 临时' });
  const impPng = await request(host, `/personas/${d.id}/import-card`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: png,
  });
  const pngDoc = await impPng.json();
  const afterPng = (await json(host, `/personas/${d.id}`)).doc.persona;
  check('C2 PNG tEXt(chara) 卡导入成功',
    pngDoc.ok && afterPng.name === '阿米娅' && afterPng.core.worldBook.length === 1,
    `name=${afterPng.name} · books=${afterPng.core.worldBook.length}`);

  const exp = await request(host, `/personas/${c.id}/export-card`);
  const exported = await exp.json();
  check('C3 CCv2 导出字段完整',
    exp.status === 200 && exported.spec === 'chara_card_v2' && exported.data.name === '阿米娅'
      && exported.data.first_mes.includes('欢迎回来') && exported.data.character_book.entries.length === 1,
    `spec=${exported.spec} · entries=${exported.data.character_book.entries.length}`);
  await host.close();
  await model.close();
}

/* ── D：特殊人设禁止工具 ───────────────────────────────────────────────── */
{
  console.log('\nD. 特殊人设拒绝系统工具');
  const model = await startModel();
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const p = await createPersona(host, { type: 'character', name: '特殊' });
  await patchPersona(host, p.id, {
    active: true, model: { provider: 'openai', baseUrl: model.base, model: 'm' },
  });
  await setKey(host, p.id, 'sk-d');
  const before = model.state.seen.length;
  const res = await chat(host, '把壁纸换成暗色的');
  const done = doneOf(res.events);
  check('D 特殊人设明确拒绝，且不调工具/模型',
    res.text.includes('特殊人设') && res.text.includes('工具')
      && done.toolRefused === true && !res.events.some((e) => e.event === 'action')
      && model.state.seen.length === before,
    `delta=${res.text.slice(0, 80)} · toolRefused=${done.toolRefused} · 模型调用=${model.state.seen.length - before}`);
  check('D2 工具清单对特殊人设为空',
    personaToolRegistry({ type: 'character' }).length === 0
      && personaToolRegistry({ type: 'assistant' }).length > 0,
    `character=${personaToolRegistry({ type: 'character' }).length} · assistant=${personaToolRegistry({ type: 'assistant' }).length}`);
  await host.close();
  await model.close();
}

/* ── E：成长自动采纳 + 重启 + confidence 门控 ───────────────────────────── */
{
  console.log('\nE. 成长自动采纳');
  const model = await startModel();
  model.state.reply = ['嗯', '。'];
  model.state.reflection = {
    traits: [{ text: '喜欢短句', confidence: 0.8 }, { text: '有点怕吵', confidence: 0.3 }],
    insideJokes: [], styleNotes: [],
  };
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const p = await createPersona(host, { type: 'assistant', name: '成长' });
  await patchPersona(host, p.id, {
    active: true, model: { provider: 'openai', baseUrl: model.base, model: 'm' },
  });
  await setKey(host, p.id, 'sk-e');
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- 5 轮串行
    await chat(host, `第 ${i} 轮`);
    // eslint-disable-next-line no-await-in-loop -- 限频
    await wait(1100);
  }
  const grown = await waitFor(async () => {
    const doc = (await json(host, `/personas/${p.id}`)).doc.persona;
    return doc.growth.traits.length ? doc : null;
  });
  check('E1 5 轮后 growth 自动写入 1–3 条',
    grown && grown.growth.traits.length >= 1 && grown.growth.traits.length <= 3
      && grown.growth.traits.some((t) => t.text === '喜欢短句')
      && promptTraits(readPersona(p.id)).some((t) => t.text === '喜欢短句'),
    `traits=${JSON.stringify(grown && grown.growth.traits)}`);

  await chat(host, '再说一句');
  const system = String(model.state.seen.at(-1).body.messages[0].content || '');
  check('E2 confidence<0.5 不进 prompt，≥0.5 进 prompt',
    system.includes('喜欢短句') && !system.includes('有点怕吵')
      && growthPromptLine(readPersona(p.id)).includes('喜欢短句')
      && !growthPromptLine(readPersona(p.id)).includes('有点怕吵'),
    `高=${system.includes('喜欢短句')} 低=${system.includes('有点怕吵')}`);

  const bond = writeBond(p.id, { affection: 0.7, trust: 0.8, mood: 'happy' });
  const recall = memoryRecallLine([{ text: '喜欢短句' }]);
  check('E2b bond 快照与召回块可读',
    readBond(p.id).affection === 0.7 && bond.trust === 0.8 && recall.includes('喜欢短句'),
    `bond=${bond.affection}/${bond.trust} · recall=${recall}`);

  const host2 = await startHost(settings);
  const afterRestart = (await json(host2, `/personas/${p.id}`)).doc.persona;
  check('E3 重启后 growth 仍生效', afterRestart.growth.traits.some((t) => t.text === '喜欢短句'),
    `traits=${afterRestart.growth.traits.length}`);
  const rollback = await json(host, `/personas/${p.id}/rollback`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '2000-01-01' }),
  });
  const afterRollback = (await json(host, `/personas/${p.id}`)).doc.persona;
  check('E4 按日期回滚 growth',
    rollback.doc.ok === true && rollback.doc.removed >= 1 && afterRollback.growth.traits.length === 0,
    `removed=${rollback.doc.removed} · remaining=${afterRollback.growth.traits.length}`);
  await host2.close();
  await host.close();
  await model.close();
}

/* ── F：200 条事件仍可对话，召回 top-8 + token 预算 ─────────────────────── */
{
  console.log('\nF. 记忆无上限 + 召回 top-8/800 token');
  const model = await startModel();
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const p = await createPersona(host, { type: 'assistant', name: '记忆' });
  await patchPersona(host, p.id, {
    active: true, model: { provider: 'openai', baseUrl: model.base, model: 'm' },
  });
  await setKey(host, p.id, 'sk-f');
  for (let i = 0; i < 200; i += 1) {
    appendEvent(p.id, { kind: 'event', importance: (i % 10) + 1, text: `第 ${i} 条记忆：用户喜欢第 ${i} 号样例` });
  }
  const count = eventCount(p.id);
  const res = await chat(host, '第 199 条记忆是什么？');
  const resDone = doneOf(res.events);
  check('F1 200 条事件仍可正常回复',
    count === 200 && res.text.length > 0, `事件=${count} · 回复=${res.text.length} 字`);
  check('F2 召回只注入 top-8 且 token ≤800',
    resDone.memories <= 8 && resDone.memoryTokens <= 800,
    `memories=${resDone.memories} · tokens=${resDone.memoryTokens}`);
  await host.close();
  await model.close();
}

/* ── G：语音 1–3 句 / 文字可长 / 说教滑块 ───────────────────────────────── */
{
  console.log('\nG. 长度与说教');
  const model = await startModel();
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const p = await createPersona(host, { type: 'assistant', name: '语气' });
  await patchPersona(host, p.id, {
    active: true, model: { provider: 'openai', baseUrl: model.base, model: 'm' },
    express: { preachiness: 0.9 },
  });
  await setKey(host, p.id, 'sk-g');
  model.state.reply = ['第一句。第二句。第三句。第四句。第五句。'];
  const voice = await chat(host, '讲一句', { inputMode: 'voice' });
  const voiceSentences = (voice.text.match(/[。！？!?]/g) || []).length;
  check('G1 语音模式最多 3 句',
    voiceSentences <= 3 && voice.text.length > 0, `${voice.text}（${voiceSentences} 句）`);

  await wait(1100);
  model.state.reply = ['长'.repeat(400)];
  const long = await chat(host, '写长一点', { inputMode: 'text' });
  check('G2 文字模式不固定 80 字上限', long.text.length > 200, `长度=${long.text.length}`);

  const system = String(model.state.seen.at(-1).body.messages[0].content || '');
  await wait(1100);
  await patchPersona(host, p.id, { express: { preachiness: 0.1 } });
  await chat(host, '再说一句', { inputMode: 'text' });
  const systemLow = String(model.state.seen.at(-1).body.messages[0].content || '');
  check('G3 说教滑块改变 prompt',
    system.includes('说教=很高') && systemLow.includes('说教=很低'),
    `高=${system.includes('说教=很高')} 低=${systemLow.includes('说教=很低')}`);
  await host.close();
  await model.close();
}

/* ── E5：Key 测试 / 删除二次确认 ───────────────────────────────────────── */
{
  console.log('\nE5. Key 测试与删除确认');
  const model = await startModel();
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const p = await createPersona(host, { type: 'assistant', name: '待删' });
  await setKey(host, p.id, 'sk-delete');
  const test = await json(host, `/personas/${p.id}/key/test`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const noConfirm = await json(host, `/personas/${p.id}`, { method: 'DELETE' });
  const confirmed = await json(host, `/personas/${p.id}?confirm=1`, { method: 'DELETE' });
  const gone = await json(host, `/personas/${p.id}`);
  check('E5 Key 测试真调端点 + 删除必须二次确认',
    test.doc.ok === true && noConfirm.status === 409 && noConfirm.doc.code === 'confirm-required'
      && confirmed.doc.ok === true && gone.status === 404,
    `test=${test.doc.ok} · 无确认=${noConfirm.status} · 删除=${confirmed.doc.ok} · 再读=${gone.status}`);
  await host.close();
  await model.close();
}

/* ── 前端：三页签 + 类型裁剪（UI v2） ─────────────────────────────────── */
{
  const panel = readFileSync(join(ROOT, 'src', 'panel-tabs-personas.js'), 'utf8');
  const assistant = readFileSync(join(ROOT, 'src', 'panel-tabs-assistant.js'), 'utf8');
  const assistantTabs = panel.slice(panel.indexOf('const PERSONA_BASE_TABS'), panel.indexOf('const CHARACTER_TABS'));
  const characterTabs = panel.slice(panel.indexOf('const CHARACTER_TABS'), panel.indexOf('const LIST_TABS'));
  check('UI v2 三页签：我的助手 / 特殊人设 / 卡片库',
    ['我的助手', '特殊人设', '卡片库'].every((label) => panel.includes(label))
      && /function PersonaSection\(\)/.test(panel) && /PersonaSection/.test(assistant));
  check('UI v2 类型裁剪：assistant 有权限无剧情；character 有剧情无权限',
    /权限/.test(assistantTabs) && !/剧情/.test(assistantTabs)
      && /剧情/.test(characterTabs) && !/权限/.test(characterTabs));
  check('UI v2 全局默认只走弹窗；导入/导出/删除二次确认入口齐全',
    /GlobalKeyModal/.test(panel) && /type: 'password'/.test(panel)
      && /import-document/.test(panel) && /export-card/.test(panel)
      && /window\.confirm/.test(panel) && /会同时删除它的全部记忆/.test(panel),
    'modal/import/export/confirm');
}

/* ── H：旧 memory.json 不被读取 ─────────────────────────────────────────── */
{
  console.log('\nH. 旧 memory.json 不读');
  const model = await startModel();
  settings.petChat.baseUrl = model.base;
  const host = await startHost(settings);
  const p = await createPersona(host, { type: 'assistant', name: '旧档测试' });
  await patchPersona(host, p.id, { active: true });
  const oldPath = join(TEST_HOME, 'pet-chat', 'memory.json');
  mkdirSync(dirname(oldPath), { recursive: true });
  writeFileSync(oldPath, JSON.stringify({ nickname: '', likes: ['旧档案里的秘密'], dislikes: [], style: '', notes: [], updatedAt: Date.now() }));
  const before = readFileSync(oldPath, 'utf8');
  await chat(host, '你记得我喜欢什么吗？');
  const system = String(model.state.seen.at(-1).body.messages[0].content || '');
  check('H 旧 memory.json 不参与 prompt，文件原样保留',
    !system.includes('旧档案里的秘密') && readFileSync(oldPath, 'utf8') === before,
    `prompt 含旧=${system.includes('旧档案里的秘密')} · 文件未变=${readFileSync(oldPath, 'utf8') === before}`);
  await host.close();
  await model.close();
}

/* ── 收账 ──────────────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.ok);
console.log(`\nPERSONA CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
