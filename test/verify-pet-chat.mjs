/**
 * verify-pet-chat.mjs — 桌宠对话的**九条判据**（门 2 / 任务 A5）。
 *
 * 为什么用真 http.Server + 真 fetch：上一批 bug 全是"单测绿、真请求红"。
 * 这里的模型端点也是**自建**的（不依赖 Ollama / 任何外网），所以站点或本机 Ollama
 * 挂了，这个测试照样跑。
 *
 * 覆盖（与工单 §2.2 / A5 一一对应）：
 *   ① SSE 逐字到达
 *   ② 无模型 ⇒ error.no-model，且客户端有预设台词兜底（判据在 src/pet-chat.js 的台词表）
 *   ③ 401 ⇒ error.unauthorized
 *   ④ 超时 ⇒ error.timeout
 *   ⑤ 上下文裁剪：第 9 轮只带最近 8 条（断言模型端收到的请求体）
 *   ⑥ 超长输入 ⇒ error.bad-request（≤400 字）
 *   ⑦ 限频：1 秒内第二次 ⇒ error.rate-limited
 *   ⑧ emotion 解析失败 ⇒ 关键词兜底
 *   ⑨ key 不出现在任何响应/日志里
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  registerPetChatRoutes, parseReplyText, emotionFromKeywords, DEPS,
} = await import('../lib/routes/pet-chat.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ── 台架：一个假宿主（注册路由）+ 一个假模型端点 ────────────────────────── */

/** 把路由挂到真 http.Server 上。`settings` 就是 readSettings() 的返回。 */
function startHost(settings) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  const logs = [];
  registerPetChatRoutes(webServer, {
    disposers: [],
    base: '/folia',
    log: (line) => logs.push(String(line)),
    readSettings: () => settings,
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  assert.ok(route, '路由已注册到 /folia/pet-chat');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({ base: `http://127.0.0.1:${port}/folia/pet-chat`, server, logs, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** 假模型端点：按 `script` 回放（SSE 行）。 */
function startModel(script) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 允许空体 */ }
      seen.push({ url: req.url, headers: req.headers, body: parsed });
      const mode = typeof script === 'function' ? script(seen.length, parsed) : script;
      if (mode.status && mode.status !== 200) {
        res.statusCode = mode.status;
        res.end(JSON.stringify({ error: 'nope' }));
        return;
      }
      if (mode.hang) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(''); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const line of mode.lines || []) res.write(line + '\n');
      res.end();
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({ base: `http://127.0.0.1:${port}`, server, seen, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** 读 SSE：返回 { events, text }。 */
async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 流式读取必须逐块等
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

const ollamaLines = (...pieces) => pieces.map((piece) => JSON.stringify({ message: { content: piece }, done: false }));

/* ── ① SSE 逐字到达 ───────────────────────────────────────────────────── */
{
  const model = await startModel({ lines: ollamaLines('你', '好', '呀') });
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, model: 'qwen2.5:7b' } });
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '在吗' }),
  });
  const events = await readSse(response);
  const deltas = events.filter((e) => e.event === 'delta').map((e) => e.data.t);
  check('① SSE 逐字到达', deltas.join('') === '你好呀' && deltas.length === 3, 'deltas=' + JSON.stringify(deltas));
  await host.close();
  await model.close();
}

/* ── ② 无模型 ⇒ no-model + 预设台词兜底 ───────────────────────────────── */
{
  const host = await startHost({ petChat: { enabled: false } });
  const state = await (await fetch(`${host.base}/state`)).json();
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
  });
  const events = await readSse(response);
  const error = events.find((e) => e.event === 'error');
  const presetSource = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const presetCount = (presetSource.match(/^\s+'[^']+',$/gm) || []).length;
  check('② 无模型 ⇒ no-model，且有预设台词兜底',
    state.enabled === false && error && error.data.code === 'no-model' && presetCount >= 30,
    `state.enabled=${state.enabled} · code=${error && error.data.code} · 预设台词 ${presetCount} 句`);
  await host.close();
}

/* ── ③ 401 ⇒ unauthorized ─────────────────────────────────────────────── */
{
  const model = await startModel({ status: 401 });
  const host = await startHost({ petChat: { enabled: true, provider: 'openai', baseUrl: model.base, apiKey: 'sk-test-123' } });
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
  });
  const events = await readSse(response);
  const error = events.find((e) => e.event === 'error');
  check('③ 401 ⇒ unauthorized', error && error.data.code === 'unauthorized', 'code=' + (error && error.data.code));
  await host.close();
  await model.close();
}

/* ── ④ 超时 ⇒ timeout（20s 上限）──────────────────────────────────────── */
{
  const model = await startModel({ hang: true });
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base } });
  const started = Date.now();
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
  });
  const events = await readSse(response);
  const elapsed = Date.now() - started;
  const error = events.find((e) => e.event === 'error');
  check('④ 超时 ⇒ timeout', error && error.data.code === 'timeout', `code=${error && error.data.code} · ${Math.round(elapsed / 1000)}s`);
  await host.close();
  await model.close();
  model.server.closeAllConnections?.();
}

/* ── ⑤ 上下文裁剪：第 9 轮只带最近 8 条 ───────────────────────────────── */
{
  const model = await startModel(() => ({ lines: ollamaLines('好') }));
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, maxTurns: 8 } });
  for (let turn = 1; turn <= 9; turn += 1) {
    const response = await fetch(`${host.base}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '问题' + turn }),
    });
    // eslint-disable-next-line no-await-in-loop -- 逐轮串行，第 9 轮才断言
    await readSse(response);
    // eslint-disable-next-line no-await-in-loop -- 限频 1/s
    await new Promise((r) => setTimeout(r, 1100));
  }
  const last = model.seen[model.seen.length - 1];
  const messages = (last && last.body && last.body.messages) || [];
  const dialogue = messages.filter((m) => m.role !== 'system');
  check('⑤ 第 9 轮只带最近 8 条', dialogue.length === 9 && messages[0].role === 'system',
    `messages=${messages.length}（system 1 + 历史 8 + 当前 1）· 首条=${messages[0] && messages[0].role}`);
  await host.close();
  await model.close();
}

/* ── ⑥ 超长输入 ⇒ bad-request ─────────────────────────────────────────── */
{
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama' } });
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '字'.repeat(401) }),
  });
  const events = await readSse(response);
  const error = events.find((e) => e.event === 'error');
  await host.close();

  // 另一半：**回复**按 maxChars 截断（工单 A5⑥）。假模型吐 200 字，上限 80 ⇒ 只该收到 80。
  const model = await startModel({ lines: ollamaLines('长'.repeat(120), '长'.repeat(80)) });
  const host2 = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, maxChars: 80 } });
  const response2 = await fetch(`${host2.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '说长点' }),
  });
  const events2 = await readSse(response2);
  const text2 = events2.filter((e) => e.event === 'delta').map((e) => e.data.t).join('');
  const done2 = events2.find((e) => e.event === 'done');
  check('⑥ 超长：输入 >400 ⇒ bad-request；回复按 maxChars 截断',
    error && error.data.code === 'bad-request' && text2.length === 80 && Boolean(done2),
    `输入 code=${error && error.data.code} · 回复长度=${text2.length}（上限 80）· done=${Boolean(done2)}`);
  await host2.close();
  await model.close();
}

/* ── ⑦ 限频：1 秒内第二次 ⇒ rate-limited ──────────────────────────────── */
{
  const model = await startModel({ lines: ollamaLines('嗯') });
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base } });
  const first = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '一' }),
  });
  await readSse(first);
  const second = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '二' }),
  });
  const events = await readSse(second);
  const error = events.find((e) => e.event === 'error');
  check('⑦ 限频 1/s ⇒ rate-limited', error && error.data.code === 'rate-limited', 'code=' + (error && error.data.code));
  await host.close();
  await model.close();
}

/* ── ⑧ emotion 解析失败 ⇒ 关键词兜底 ──────────────────────────────────── */
{
  const json = parseReplyText('{"reply":"好耶！","emotion":"happy"}');
  const broken = parseReplyText('{"reply":"好耶！","emotion":');
  const keywordHappy = emotionFromKeywords('哈哈，太好了');
  const keywordTired = emotionFromKeywords('我有点困了');
  const plain = parseReplyText('就是一句普通的话');
  check('⑧ 情绪解析失败 ⇒ 关键词兜底',
    json.emotion === 'happy' && broken.emotion === null && broken.reply === '{"reply":"好耶！","emotion":'
      && keywordHappy === 'happy' && keywordTired === 'tired' && plain.reply === '就是一句普通的话' && plain.emotion === null,
    `json=${json.emotion} · broken=${broken.emotion} · 关键词=${keywordHappy}/${keywordTired}`);
}

/* ── ⑨ key 不出现在任何响应 / 日志里 ──────────────────────────────────── */
{
  const SECRET = 'sk-do-not-leak-1234567890';
  const model = await startModel({ lines: ollamaLines('收到') });
  const host = await startHost({ petChat: { enabled: true, provider: 'openai', baseUrl: model.base, apiKey: SECRET } });
  const bodies = [];
  const state = await (await fetch(`${host.base}/state`)).text();
  bodies.push(state);
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
  });
  bodies.push(JSON.stringify(await readSse(response)));
  const models = await (await fetch(`${host.base}/models`)).text();
  bodies.push(models);
  const leaked = bodies.some((text) => text.includes(SECRET)) || host.logs.some((line) => line.includes(SECRET));
  const headersSent = model.seen[0] && model.seen[0].headers && String(model.seen[0].headers.authorization || '');
  check('⑨ key 不出现在响应/日志（只出现在发给端点的请求头）',
    !leaked && headersSent === `Bearer ${SECRET}`,
    `泄漏=${leaked} · 端点收到 Authorization=${headersSent ? 'Bearer ***' : '(无)'} · DEPS=${JSON.stringify(DEPS)}`);
  await host.close();
  await model.close();
}

/* ── 收账 ─────────────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.ok);
console.log(`\nPET CHAT CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
