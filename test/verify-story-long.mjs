/**
 * verify-story-long.mjs — v1.2 判据 S1/S2：800–1200 字故事完整讲完，不按 3/8 句截断；
 * 语音 chat 默认 8 句；故事 TTS 分批 + 长文气泡可滚动。
 * 真 http + 自建假模型端点（不依赖外网/Ollama）。
 */
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT || 'C:/Windows/Temp/folia-asr-none';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'folia-story-'));
process.env.DSH_FOLIA_HOME = HOME;
const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const store = await import('../lib/persona-store.js');
const { buildPersonaSystemPrompt } = await import('../lib/pet-chat-brain.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const persona = store.createPersona({ type: 'assistant', name: '说书' });
store.setActivePersona(persona.id);
const settings = { petChat: { enabled: true, provider: 'ollama', baseUrl: '', model: 'fake' } };

function startHost() {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [], base: '/folia', log: () => {}, readSettings: () => settings, speechToText: null,
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  assert.ok(route, '路由已注册');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      resolveP({ base: `http://127.0.0.1:${server.address().port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) });
    });
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
      const pieces = typeof script === 'function' ? script(seen.length) : script;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of pieces) res.write(JSON.stringify({ message: { content: piece }, done: false }) + '\n');
      res.end();
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      resolveP({ base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) });
    });
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

const textOf = (events) => events.filter((item) => item.event === 'delta').map((item) => item.data.t).join('');
const doneOf = (events) => events.filter((item) => item.event === 'done').at(-1)?.data || {};

/* ① prompt：故事模式不再“1–3 句” */
const storyPrompt = buildPersonaSystemPrompt(persona, { conversationMode: 'story', voiceLength: 8 });
const chatPrompt3 = buildPersonaSystemPrompt(persona, { conversationMode: 'chat', inputMode: 'voice', voiceLength: 3 });
check('S1① 故事 prompt：完整讲完（开头/发展/结尾），不再写死 1–3 句',
  /完整讲完/.test(storyPrompt) && /开头、发展、结尾/.test(storyPrompt) && !/1–3 句/.test(storyPrompt),
  'story prompt ok');
check('S1② chat 语音长度由 voiceLength 决定（3 句档写进 prompt）',
  /最多 3 句/.test(chatPrompt3) && /语音播报/.test(chatPrompt3), 'voiceLength=3');

/* ② 端到端：故事 1000+ 字完整到结尾，不按句数截断 */
const model = await startModel(() => {
  const sentences = [];
  for (let i = 0; i < 14; i += 1) {
    sentences.push(`第${i + 1}段，故事继续往前走。风从窗缝里灌进来，他把那盏旧灯往桌角挪了挪，'
      + '压低声音把这件事说完；屋外的人没有回头，只有影子在门缝下慢慢退开。`);
  }
  return sentences;
});
settings.petChat.baseUrl = model.base;
const host = await startHost();
const storyRes = await fetch(`${host.base}/chat`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '给我讲个长一点的故事', inputMode: 'voice', conversationMode: 'story' }),
});
const storyEvents = await readSse(storyRes);
const storyText = textOf(storyEvents);
const storyDone = doneOf(storyEvents);
check('S1③ 故事完整到结尾（≥800 字，14 句全在）',
  [...storyText].length >= 800 && (storyText.match(/[。！？!?]/g) || []).length >= 14 && storyDone.story === true,
  `chars=${[...storyText].length} sentences=${(storyText.match(/[。！？!?]/g) || []).length}`);
const storySystem = String((model.seen.at(-1).body.messages || [])[0].content || '');
const storyBody = model.seen.at(-1).body || {};
check('S1④ 宿主给故事放宽输出上限（ollama num_predict=6000）',
  storyBody.options && storyBody.options.num_predict === 6000, JSON.stringify(storyBody.options || null));

/* ③ chat 语音：默认 8 句（不是 3），且流不提前 cancel（done 正常到达） */
await new Promise((r) => setTimeout(r, 1100));
const chatRes = await fetch(`${host.base}/chat`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '讲十句', inputMode: 'voice', conversationMode: 'chat' }),
});
const chatEvents = await readSse(chatRes);
const chatText = textOf(chatEvents);
check('S1⑤ chat 语音默认 8 句（10 句请求只显示 8 句，但这一轮正常结束）',
  (chatText.match(/[。！？!?]/g) || []).length === 8 && doneOf(chatEvents).usage,
  `sentences=${(chatText.match(/[。！？!?]/g) || []).length}`);

/* ④ 客户端：TTS 分批 + 长文滚动 + 「继续/重讲/缩短」 */
const client = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
const bubble = readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8');
const tts = readFileSync(join(ROOT, 'src', 'pet-tts.js'), 'utf8');
check('S2① TTS 分批（2 句/段）+ group + 句间静音',
  /speechBatch/.test(client) && /group: 2/.test(tts) && /PET_TTS_GAP_MS/.test(tts));
check('S2② 长文气泡可滚动 + 故事不自动收起',
  /overflow-y:auto/.test(bubble) && /petChatConversationMode === 'story'/.test(client));
check('S2③ 故事按钮：继续 / 重讲 / 缩短（都走现有通道）',
  /weT\('继续'\)/.test(client) && /weT\('重讲'\)/.test(client) && /weT\('缩短'\)/.test(client)
  && /petChatStoryBarShow/.test(client) && /petChatLastReply/.test(client));

await host.close();
await model.close();
const failed = results.filter((item) => !item.ok);
console.log(`\nSTORY LONG CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
