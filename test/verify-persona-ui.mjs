/**
 * verify-persona-ui.mjs — 人设 UI v2 验收 A–F。
 *
 * 真 http.Server + 假 OpenAI 兼容端点；docx 用仓库内 fixtures（阿米娅样例）。
 * 只覆盖 persona 层；下载队列 / VAD / ffmpeg 不在本文件。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-persona-ui-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const { personaDir } = await import('../lib/persona-store.js');
const { appendEvent, listEvents } = await import('../lib/persona-memory.js');
const { runTool } = await import('../lib/pet-chat-tools.js');
const { personaToolRegistry } = await import('../lib/pet-chat-brain.js');
const { readDocxText } = await import('../lib/persona-doc.js');
const { listLibraryCards } = await import('../lib/persona-library.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

function startModel() {
  const state = { seen: [], reply: ['我', '在。'] };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      state.seen.push({ url: req.url, headers: req.headers, body: parsed });
      if (!parsed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (parsed.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of state.reply) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolveP) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolveP({ base: `http://127.0.0.1:${port}`, state, close: () => new Promise((r) => server.close(r)) });
  }));
}

function startHost(settings) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [], base: '/folia', log: () => {},
    readSettings: () => settings, speechToText: undefined,
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  assert.ok(route, '路由已注册');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    resolveP({ base: `http://127.0.0.1:${port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) });
  }));
}

async function json(host, path, options = {}) {
  const res = await fetch(host.base + path, options);
  return { status: res.status, doc: await res.json() };
}

async function chat(host, text, inputMode = 'text') {
  const res = await fetch(host.base + '/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, inputMode }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
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
  const done = (events.find((item) => item.event === 'done') || {}).data || {};
  const textOut = events.filter((item) => item.event === 'delta').map((item) => item.data.t || '').join('');
  return { events, done, text: textOut };
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

/* ── A. 静态信息架构 ─────────────────────────────────────────────────── */
console.log('\nA. 列表页无 Key / 全局默认只在弹窗 / 三页签');
{
  const panel = readFileSync(join(ROOT, 'src', 'panel-tabs-personas.js'), 'utf8');
  const assistant = readFileSync(join(ROOT, 'src', 'panel-tabs-assistant.js'), 'utf8');
  const listStart = panel.indexOf('const assistantTab');
  const listEnd = panel.indexOf("if (view === 'list')");
  const listSource = listStart >= 0 && listEnd > listStart ? panel.slice(listStart, listEnd) : '';
  check('A1 列表三页签：我的助手 / 特殊人设 / 卡片库',
    ['我的助手', '特殊人设', '卡片库'].every((label) => panel.includes(label))
      && /LIST_TABS/.test(panel));
  check('A2 列表段没有任何 Key 输入框；全局默认入口是徽标+弹窗',
    listSource.length > 100 && !/type: 'password'/.test(listSource) && !/Key 归属/.test(listSource)
      && /全局默认/.test(panel) && /GlobalKeyModal/.test(panel)
      && /type: 'password'/.test(panel.slice(panel.indexOf('function GlobalKeyModal'), panel.indexOf('function PersonaSection'))));
  check('A3 旧 Key 表单不再渲染在智能大肥鱼首页',
    /function AssistantSection\(\)/.test(assistant)
      && /PersonaSection/.test(assistant) && !/PetChatSettings, null/.test(assistant));
  check('A4 助手向导三步（名字/称呼/语气/关系）',
    /wizard\.step/.test(panel) && /怎么称呼你/.test(panel) && /你们的关系/.test(panel)
      && /语气/.test(panel));
  check('A5 卡片库入口含搜索/分类/一键使用',
    /预览卡片|卡片预览/.test(panel) && /使用这个人设/.test(panel) && /搜索卡片/.test(panel)
      && /roleplay/.test(panel) && /story/.test(panel));
}

/* ── B. Key 归属与状态 ───────────────────────────────────────────────── */
console.log('\nB. Key 可继承/独立，列表显示状态');
{
  const model = await startModel();
  const settings = { petChat: { enabled: true, provider: 'openai', baseUrl: model.base, model: 'fake', apiKey: 'sk-global' } };
  const host = await startHost(settings);
  const p = await createPersona(host, { type: 'assistant', name: '小助手' });
  let list = (await json(host, '/personas')).doc;
  let item = list.personas.find((x) => x.id === p.id);
  check('B1 默认继承全局；列表带全局 Key 状态与 keyStatus',
    list.global && list.global.hasKey === true && item.keyStatus.mode === 'inherit'
      && item.keyStatus.configured === true && /继承全局/.test(item.keyStatus.label));
  const key = await json(host, `/personas/${p.id}/key`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'sk-persona' }),
  });
  list = (await json(host, '/personas')).doc;
  item = list.personas.find((x) => x.id === p.id);
  check('B2 填独立 Key → 状态变独立；Key 只回掩码',
    key.doc.ok && key.doc.keyStatus.mode === 'persona' && key.doc.keyStatus.configured === true
      && item.keyStatus.mode === 'persona' && !JSON.stringify(key.doc).includes('sk-persona'));
  await patchPersona(host, p.id, { model: { apiKeyRef: 'inherit' } });
  list = (await json(host, '/personas')).doc;
  item = list.personas.find((x) => x.id === p.id);
  check('B3 改回继承 → 状态回到继承全局（vault 里的旧 Key 可保留但不再使用）',
    item.keyStatus.mode === 'inherit' && item.keyStatus.configured === true);
  const detail = (await json(host, `/personas/${p.id}`)).doc;
  check('B4 详情带 keyStatus/global，模型页可读继承状态',
    detail.keyStatus && detail.keyStatus.mode === 'inherit' && detail.global && detail.global.model === 'fake');
  await host.close(); await model.close();
}

/* ── C. 卡片库一键使用 ───────────────────────────────────────────────── */
console.log('\nC. 卡片库使用 → 不填配置即可开始，开场白正确');
{
  const model = await startModel();
  const settings = { petChat: { enabled: true, provider: 'openai', baseUrl: model.base, model: 'fake', apiKey: 'sk-global' } };
  const host = await startHost(settings);
  const lib = (await json(host, '/personas/library')).doc;
  check('C1 卡片库有官方卡与搜索分类', lib.ok && lib.cards.length >= 1
    && lib.cards.every((card) => card.source === 'official' && card.cover && card.tags)
    && lib.cards.some((card) => card.id === 'amiya'));
  const used = (await json(host, '/personas/library/amiya/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).doc;
  check('C2 一键使用：创建 character / 继承全局 Key / 推荐音色 / 设为当前',
    used.ok && used.persona.type === 'character' && used.persona.active === true
      && used.persona.model.apiKeyRef === 'inherit' && used.persona.express.voice.name === 'zh-CN-XiaoxiaoNeural'
      && used.keyMode === 'inherit' && used.persona.mode === 'roleplay');
  check('C3 开场白来自卡片 first_mes',
    used.opening && used.opening.includes('博士，您来了') && used.opening.includes('罗德岛指挥室'));
  const said = await chat(host, '我回来了');
  const seen = model.state.seen[model.state.seen.length - 1];
  check('C4 不填任何配置即可对话；请求使用全局 Key 与该 persona',
    said.text.length > 0 && seen && seen.headers.authorization === 'Bearer sk-global'
      && said.done.personaId === used.persona.id && said.done.personaType === 'character',
    `text=${JSON.stringify(said.text)} auth=${seen && seen.headers.authorization} personaId=${said.done.personaId} type=${said.done.personaType}`);
  await host.close(); await model.close();
}

/* ── D. 特殊人设禁工具 / 助手可用 ────────────────────────────────────── */
console.log('\nD. 特殊人设拒绝工具；助手可执行');
{
  const model = await startModel();
  const settings = { petChat: { enabled: true, provider: 'openai', baseUrl: model.base, model: 'fake', apiKey: 'sk-global' } };
  const host = await startHost(settings);
  await json(host, '/personas/library/amiya/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const characterChat = await chat(host, '把壁纸换成暗色的');
  check('D1 特殊人设说换壁纸 → 明确拒绝，toolRefused=true，不产生 action',
    characterChat.text.includes('特殊人设') && characterChat.text.includes('工具')
      && characterChat.done.toolRefused === true
      && !characterChat.events.some((event) => event.event === 'action'),
    `text=${JSON.stringify(characterChat.text)} done=${JSON.stringify(characterChat.done)} events=${characterChat.events.map((e) => e.event).join(',')}`);
  const assistant = await createPersona(host, { type: 'assistant', name: '工具助手' });
  const allowed = await runTool('pet_toggle', { visible: true }, { persona: assistant });
  const denied = await runTool('pet_toggle', { visible: true }, { persona: { type: 'character', id: 'p_char' } });
  check('D2 工具层双保险：assistant 可执行、character 被拒',
    allowed.ok === true && allowed.verified === true
      && denied.ok === false && /特殊人设/.test(denied.say)
      && personaToolRegistry(assistant).length > 0 && personaToolRegistry({ type: 'character' }).length === 0);
  await host.close(); await model.close();
}

/* ── E. 阿米娅 docx → 卡片 → 可对话 ─────────────────────────────────── */
console.log('\nE. docx 文档 → 卡片预览 → 保存 → 对话');
{
  const model = await startModel();
  const settings = { petChat: { enabled: true, provider: 'openai', baseUrl: model.base, model: 'fake', apiKey: 'sk-global' } };
  const host = await startHost(settings);
  const docx = readFileSync(join(ROOT, 'test', 'fixtures', 'persona-docs', 'amiya.docx'));
  const imported = (await json(host, '/personas/import-document', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: '阿米娅-冉星璀璨-角色卡.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', base64: docx.toString('base64') }),
  })).doc;
  const card = imported.card && imported.card.data ? imported.card.data : {};
  const keys = ((card.character_book && card.character_book.entries) || []).flatMap((entry) => entry.keys || []);
  check('E1 docx 抽出阿米娅卡：名字/设定/开场白/世界书',
    imported.ok && card.name === '阿米娅' && String(card.description).includes('罗德岛')
      && String(card.first_mes).includes('博士，您来了')
      && keys.includes('罗德岛') && keys.includes('矿石病') && imported.text.includes('阿米娅')
      && readDocxText(docx).includes('阿米娅')
      && listLibraryCards({ q: '阿米娅' }).length === 1);
  check('E2 卡片化结果可编辑（返回 CCv2 + 原文 + 分块/模型标记）',
    imported.card.spec === 'chara_card_v2' && card.name === '阿米娅'
      && imported.text.length > 10000 && imported.chunks >= 1 && imported.usedModel === false);
  const saved = (await json(host, '/personas/from-draft', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ card: imported.card, mode: 'roleplay', fileName: '阿米娅.docx', rawText: imported.text, active: true }),
  })).doc;
  check('E3 预览保存 → 生成特殊人设（active，继承 Key，世界书落库）',
    saved.ok && saved.persona.type === 'character' && saved.persona.active === true
      && saved.persona.model.apiKeyRef === 'inherit'
      && saved.persona.core.worldBook.some((entry) => (entry.keys || []).includes('罗德岛')));
  const reply = await chat(host, '博士，我回来了。');
  check('E4 保存后可直接对话', reply.text.length > 0 && reply.done.personaId === saved.persona.id,
    `text=${JSON.stringify(reply.text)} personaId=${reply.done.personaId}`);
  await host.close(); await model.close();
}

/* ── F. 两个特殊人设记忆隔离；删除清掉 ──────────────────────────────── */
console.log('\nF. 特殊人设记忆不串；删除后记忆清掉');
{
  const model = await startModel();
  const settings = { petChat: { enabled: true, provider: 'openai', baseUrl: model.base, model: 'fake', apiKey: 'sk-global' } };
  const host = await startHost(settings);
  const a = (await json(host, '/personas/library/amiya/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).doc.persona;
  const b = (await json(host, '/personas/library/story-guide/use', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).doc.persona;
  appendEvent(a.id, { kind: 'preference', importance: 8, text: '偏好：喜欢星空' });
  appendEvent(b.id, { kind: 'preference', importance: 8, text: '偏好：喜欢雨夜' });
  const ma = (await json(host, `/personas/${a.id}/memory`)).doc;
  const mb = (await json(host, `/personas/${b.id}/memory`)).doc;
  check('F1 两个特殊人设的事件流互不串',
    ma.items.some((item) => item.text.includes('星空')) && !ma.items.some((item) => item.text.includes('雨夜'))
      && mb.items.some((item) => item.text.includes('雨夜')) && !mb.items.some((item) => item.text.includes('星空')));
  const noConfirm = await json(host, `/personas/${b.id}`, { method: 'DELETE' });
  const confirmed = await json(host, `/personas/${b.id}?confirm=1`, { method: 'DELETE' });
  check('F2 删除必须确认；删除后目录与记忆一起清掉，另一个不受影响',
    noConfirm.status === 409 && confirmed.doc.ok === true
      && !existsSync(personaDir(b.id)) && listEvents(a.id).items.length >= 1 && listEvents(b.id).items.length === 0);
  await host.close(); await model.close();
}

/* ── 静态：类型裁剪子页 + 文档导入入口 ──────────────────────────────── */
console.log('\nG. 类型裁剪与详情入口');
{
  const panel = readFileSync(join(ROOT, 'src', 'panel-tabs-personas.js'), 'utf8');
  const assistantTabs = panel.slice(panel.indexOf('const PERSONA_BASE_TABS'), panel.indexOf('const CHARACTER_TABS'));
  const characterTabs = panel.slice(panel.indexOf('const CHARACTER_TABS'), panel.indexOf('const LIST_TABS'));
  check('G1 assistant：基本/模型与Key/记忆/声音/权限；无剧情/人设卡',
    /权限/.test(assistantTabs) && !/剧情/.test(assistantTabs) && !/人设卡/.test(assistantTabs),
    JSON.stringify(assistantTabs.slice(0, 200)));
  check('G2 character：基本/模型与Key/人设卡/剧情/声音；无权限',
    /剧情/.test(characterTabs) && /人设卡/.test(characterTabs) && !/权限/.test(characterTabs));
  check('G3 文档导入入口接受 docx/md/txt/json/png',
    /\.docx/.test(panel) && /\.md/.test(panel) && /\.txt/.test(panel) && /\.json/.test(panel) && /\.png/.test(panel)
      && /import-document/.test(panel) && /from-draft/.test(panel));
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${failed.length ? 'PERSONA UI CHECKS FAILED' : 'PERSONA UI CHECKS PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) { for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : '')); process.exit(1); }
