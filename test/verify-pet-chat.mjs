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
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 记忆文件必须落在临时 home 里（B 块）：否则测试会写进真实 `~/.dsh-folia`
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-pet-chat-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;
const {
  registerPetChatRoutes, parseReplyText, emotionFromKeywords, DEPS,
} = await import('../lib/routes/pet-chat.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ── 台架：一个假宿主（注册路由）+ 一个假模型端点 ────────────────────────── */

/** 把路由挂到真 http.Server 上。`settings` 就是 readSettings() 的返回；`speechToText` 是宿主转写服务。 */
function startHost(settings, speechToText, edgeTts) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  const logs = [];
  registerPetChatRoutes(webServer, {
    disposers: [],
    base: '/folia',
    log: (line) => logs.push(String(line)),
    readSettings: () => settings,
    speechToText,
    edgeTts,
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
      if (mode.json) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mode.json));
        return;
      }
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

/* ── A1 默认来源 = 用户自己的 DeepSeek ────────────────────────────────── */
{
  // 宿主真实给的是**消毒后**的设置（默认值都在里面），所以这里也走同一条路
  const { sanitizeFromSchema } = await import('../lib/settings-schema.js');
  const host = await startHost(sanitizeFromSchema({ petChat: { enabled: true } }, 'host'));
  const state = await (await fetch(`${host.base}/state`)).json();
  const noKey = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
  });
  const events = await readSse(noKey);
  const error = events.find((e) => e.event === 'error');
  check('A1 默认 DeepSeek：state=openai/deepseek；未填 key ⇒ no-model + 可读 hint',
    state.provider === 'openai' && state.model === 'deepseek-chat'
      && error && error.data.code === 'no-model' && /DeepSeek API Key/.test(String(error.data.hint || '')),
    `provider=${state.provider} · model=${state.model} · code=${error && error.data.code}`);
  await host.close();
}

/* ── A2 清空记忆：reset 之后 history 为空 ─────────────────────────────── */
{
  const model = await startModel(() => ({ lines: ollamaLines('嗯') }));
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base } });
  const say = async (text) => {
    const response = await fetch(`${host.base}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    await readSse(response);
  };
  await say('第一句');
  await new Promise((r) => setTimeout(r, 1100));
  await say('第二句');
  const beforeReset = (model.seen[model.seen.length - 1].body.messages || []).filter((m) => m.role !== 'system').length;
  const reset = await fetch(`${host.base}/reset`, { method: 'POST' });
  const resetDoc = await reset.json();
  await new Promise((r) => setTimeout(r, 1100));
  await say('清空后的第一句');
  const afterReset = (model.seen[model.seen.length - 1].body.messages || []).filter((m) => m.role !== 'system').length;
  check('A2 清空记忆：reset 后下一次 chat 的 history 为空',
    resetDoc.ok === true && beforeReset > 1 && afterReset === 1,
    `reset=${JSON.stringify(resetDoc)} · 清空前 ${beforeReset} 条 · 清空后 ${afterReset} 条（只有当前这句）`);
  await host.close();
  await model.close();
}

/* ── A3 人设默认值进 system prompt ────────────────────────────────────── */
{
  const model = await startModel(() => ({ lines: ollamaLines('好') }));
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base } });
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
  });
  await readSse(response);
  const system = String((model.seen[0].body.messages || [])[0].content || '');
  check('A3 人设默认值进 system prompt',
    system.includes('Folia') && system.includes('元气、短句、偶尔颜文字、不说教') && system.includes('被夸会害羞'),
    `system 长度=${system.length}`);
  await host.close();
  await model.close();
}

/* ── A4 预设台词库：五组 ≥30 句，无模型两条路径都从这里取 ──────────────── */
{
  const source = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const block = source.match(/const PET_CHAT_PRESET_LINES = \{[\s\S]*?\n\};/);
  const groups = block ? [...block[0].matchAll(/^\s{2}(\w+): \[([\s\S]*?)\],/gm)]
    .map((m) => [m[1], (m[2].match(/'/g) || []).length / 2]) : [];
  const total = groups.reduce((sum, [, n]) => sum + n, 0);
  const named = ['greeting', 'wallpaper', 'company', 'fallback', 'night'].every((k) => groups.some(([id]) => id === k));
  const usesPreset = /petChatPresetLine\(\)/.test(source);
  check('A4 预设台词库：五组 ≥30 句，两条无模型路径都调用',
    total >= 30 && named && groups.length === 5 && usesPreset,
    `分组=${JSON.stringify(groups)} · 合计=${total}`);
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
  const presetBlock = presetSource.match(/const PET_CHAT_PRESET_LINES = \{[\s\S]*?\n\};/);
  const presetCount = presetBlock
    ? [...presetBlock[0].matchAll(/^\s{2}(\w+): \[([\s\S]*?)\],/gm)]
      .reduce((sum, m) => sum + (m[2].match(/'/g) || []).length / 2, 0)
    : 0;
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

/* ── B 块：长期偏好记忆（5 条）────────────────────────────────────────── */
// 直接引用记忆模块（既做纯函数判据，也让 guard-map 认得这个文件的覆盖来源）
const { parseExplicitMemory, MEMORY_LIMITS } = await import('../lib/pet-chat-memory.js');
const MEMORY_FILE = join(TEST_HOME, 'pet-chat', 'memory.json');
const readMem = () => (existsSync(MEMORY_FILE) ? JSON.parse(readFileSync(MEMORY_FILE, 'utf8')) : null);
const resetMem = () => { try { rmSync(MEMORY_FILE, { force: true }); } catch { /* ignore */ } };

/* B① 显式「记住X」⇒ 落盘 + 下一轮 system prompt 含它 */
{
  resetMem();
  const model = await startModel(() => ({ lines: ollamaLines('好') }));
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base } });
  const send = async (text) => {
    const response = await fetch(`${host.base}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    await readSse(response);
    await new Promise((r) => setTimeout(r, 1100)); // 限频 1/s
  };
  await send('记住我喜欢原神');
  const mem = readMem();
  const parsedNick = parseExplicitMemory('记住我叫你小鲸');
  const parsedLike = parseExplicitMemory('记住我喜欢原神');
  assert.equal(parsedNick && parsedNick.field, 'nickname', '「记住我叫你X」应识别为称呼');
  assert.equal(parsedLike && parsedLike.value, '原神', '「记住我喜欢X」应识别为喜欢');
  assert.equal(MEMORY_LIMITS.likes, 20, '上限常量在模块里（likes ≤ 20）');
  await send('今天桌面有点乱');
  const lastSystem = String((model.seen[model.seen.length - 1].body.messages || [])[0].content || '');
  check('B① 显式「记住X」⇒ 落盘且下一轮 system prompt 含它',
    mem && mem.likes.includes('原神') && lastSystem.includes('喜欢=原神'),
    `文件=${JSON.stringify(mem && mem.likes)} · prompt 含记忆=${lastSystem.includes('关于主人')}`);
  await host.close();
  await model.close();
}

/* B② 第 N 轮触发摘要 ⇒ 合并去重，不覆盖显式项 */
{
  resetMem();
  const SUMMARY = { nickname: '不该覆盖', likes: ['原神', '星空'], dislikes: ['广告'], style: '简短', notes: ['夜里更活跃'] };
  const model = await startModel((index, body) => {
    const first = String((body && body.messages && body.messages[0] && body.messages[0].content) || '');
    if (first.startsWith('[memory-summary]')) return { json: { message: { content: JSON.stringify(SUMMARY) } } };
    return { lines: ollamaLines('嗯') };
  });
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, memoryEveryTurns: 3 } });
  for (let i = 1; i <= 3; i += 1) {
    const response = await fetch(`${host.base}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '随便聊聊' + i }),
    });
    // eslint-disable-next-line no-await-in-loop -- 逐轮串行，第 3 轮触发摘要
    await readSse(response);
    // eslint-disable-next-line no-await-in-loop -- 限频 1/s
    await new Promise((r) => setTimeout(r, 1100));
  }
  // 再跑 3 轮：同一份摘要再来一次，去重后条数不该增长
  for (let i = 4; i <= 6; i += 1) {
    const response = await fetch(`${host.base}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '继续聊' + i }),
    });
    // eslint-disable-next-line no-await-in-loop -- 同上
    await readSse(response);
    // eslint-disable-next-line no-await-in-loop -- 限频 1/s
    await new Promise((r) => setTimeout(r, 1100));
  }
  const mem = readMem();
  check('B② 第 3/6 轮触发摘要 ⇒ 合并去重（同一份摘要不重复）',
    mem && mem.likes.length === 2 && mem.likes.includes('原神') && mem.likes.includes('星空')
      && mem.nickname === '' && mem.notes.length === 1,
    `likes=${JSON.stringify(mem && mem.likes)} · nickname=${JSON.stringify(mem && mem.nickname)} · notes=${JSON.stringify(mem && mem.notes)}`);
  await host.close();
  await model.close();
}

/* B③ 清空 ⇒ 文件没了、prompt 不再含记忆 */
{
  resetMem();
  const model = await startModel(() => ({ lines: ollamaLines('好') }));
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base } });
  const send = async (text) => {
    const response = await fetch(`${host.base}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    await readSse(response);
    await new Promise((r) => setTimeout(r, 1100));
  };
  await send('记住我喜欢原神');
  const before = readMem();
  await fetch(`${host.base}/reset`, { method: 'POST' });
  await send('清空之后');
  const lastSystem = String((model.seen[model.seen.length - 1].body.messages || [])[0].content || '');
  check('B③ 清空 ⇒ 文件没了、prompt 不再含记忆',
    Boolean(before && before.likes.length) && readMem() === null && !lastSystem.includes('关于主人'),
    `清空前=${JSON.stringify(before && before.likes)} · 清空后文件=${readMem() === null ? '不存在' : '仍存在'} · prompt 含记忆=${lastSystem.includes('关于主人')}`);
  await host.close();
  await model.close();
}

/* B④ 关闭记忆 ⇒ 不写、不注入 */
{
  resetMem();
  const model = await startModel(() => ({ lines: ollamaLines('好') }));
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, memoryEnabled: false } });
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '记住我喜欢原神' }),
  });
  await readSse(response);
  const lastSystem = String((model.seen[model.seen.length - 1].body.messages || [])[0].content || '');
  check('B④ 关闭记忆 ⇒ 不写盘、不注入',
    readMem() === null && !lastSystem.includes('关于主人'),
    `文件=${readMem() === null ? '不存在' : '被写了'} · prompt 含记忆=${lastSystem.includes('关于主人')}`);
  await host.close();
  await model.close();
}

/* B⑤ 隐私：memory.json 里不含聊天原文 */
{
  resetMem();
  const model = await startModel(() => ({ lines: ollamaLines('好') }));
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base } });
  const secrets = ['我今天在写一个特别长的项目报告', '记住我喜欢原神'];
  for (const text of secrets) {
    const response = await fetch(`${host.base}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    });
    // eslint-disable-next-line no-await-in-loop -- 逐句串行
    await readSse(response);
    // eslint-disable-next-line no-await-in-loop -- 限频 1/s
    await new Promise((r) => setTimeout(r, 1100));
  }
  const raw = existsSync(MEMORY_FILE) ? readFileSync(MEMORY_FILE, 'utf8') : '';
  const leaked = secrets.some((text) => raw.includes(text));
  check('B⑤ 隐私：memory.json 不含聊天原文',
    raw.length > 0 && !leaked && raw.includes('原神'),
    `文件 ${raw.length} 字节 · 含原文=${leaked} · 含结论=${raw.includes('原神')}`);
  await host.close();
  await model.close();
  resetMem();
}
/* ── D 块：语音转写（6 条判据）────────────────────────────────────────── */
/** 造一段合法的 16kHz 单声道 PCM16 WAV（seconds 秒）。 */
function makeWav(seconds) {
  const rate = 16000;
  const frames = Math.round(rate * seconds);
  const dataBytes = frames * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const put = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  put(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, dataBytes, true);
  return new Uint8Array(buffer);
}

/** 假的宿主转写服务：可控 provider 就绪状态与返回文本。 */
function makeSpeech({ phase = 'ready', text = '你好呀', throwOnTranscribe = null } = {}) {
  const calls = [];
  return {
    calls,
    snapshot: () => ({
      providers: [{ id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['zh'], preparation: { phase } }],
      selection: { providerId: 'sensevoice-local', language: 'zh' },
    }),
    resolve: (request) => ({ ...request, providerId: 'sensevoice-local' }),
    transcribe: async (spec, signal) => {
      calls.push({ spec, aborted: signal?.aborted === true });
      if (throwOnTranscribe) throw throwOnTranscribe;
      return { text, audioSeconds: 1.5, inferenceSeconds: 0.4 };
    },
  };
}

const postWav = (host, bytes) => fetch(`${host.base}/transcribe`, {
  method: 'POST', headers: { 'content-type': 'audio/wav' }, body: bytes,
});
const postJsonAudio = (host, base64) => fetch(`${host.base}/transcribe`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ audio: base64, language: 'zh' }),
});
const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');

/* D① provider 未注册 ⇒ asr-not-ready（200，不是 500） */
{
  const host = await startHost({ petChat: { enabled: true } });
  const res = await postWav(host, makeWav(1));
  const doc = await res.json();
  check('D① 未注册 provider ⇒ 200 asr-not-ready（不是 500）',
    res.status === 200 && doc.code === 'asr-not-ready' && /语音输入/.test(String(doc.hint || '')),
    `HTTP ${res.status} · code=${doc.code}`);
  await host.close();
}

/* D② 就绪时透传 text */
{
  const speech = makeSpeech({ text: '打开设置' });
  const host = await startHost({ petChat: { enabled: true } }, speech);
  const res = await postJsonAudio(host, toBase64(makeWav(1)));
  const doc = await res.json();
  check('D② 就绪 ⇒ text 原样透传，且带 audioSeconds/inferenceSeconds',
    res.status === 200 && doc.ok === true && doc.text === '打开设置'
      && typeof doc.audioSeconds === 'number' && typeof doc.inferenceSeconds === 'number'
      && speech.calls.length === 1 && speech.calls[0].spec.providerId === 'sensevoice-local',
    `text=${doc.text} · audio=${doc.audioSeconds}s · inference=${doc.inferenceSeconds}s`);
  await host.close();
}

/* D③ 超长 / 超大 ⇒ 400 bad-request */
{
  const speech = makeSpeech();
  const host = await startHost({ petChat: { enabled: true } }, speech);
  const tooLong = await postWav(host, makeWav(20));
  const tooLongDoc = await tooLong.json();
  const oversized = new Uint8Array(2 * 1024 * 1024 + 16);
  // 头部填成合法 WAV，保证它被"体积"而不是"格式"挡下
  oversized.set(makeWav(1).subarray(0, 44), 0);
  const tooBig = await postWav(host, oversized);
  const tooBigDoc = await tooBig.json();
  check('D③ 超长（20s）/ 超大（>2MB）⇒ 400 bad-request',
    tooLong.status === 400 && tooLongDoc.code === 'bad-request'
      && tooBig.status === 400 && tooBigDoc.code === 'bad-request',
    `20s=${tooLong.status}/${tooLongDoc.code} · 2MB+ =${tooBig.status}/${tooBigDoc.code}`);
  await host.close();
}

/* D④ 限频 1 次 / 2 秒 ⇒ rate-limited */
{
  const speech = makeSpeech();
  const host = await startHost({ petChat: { enabled: true } }, speech);
  const first = await postWav(host, makeWav(1));
  const firstDoc = await first.json();
  const second = await postWav(host, makeWav(1));
  const secondDoc = await second.json();
  check('D④ 2 秒内第二次 ⇒ rate-limited',
    firstDoc.ok === true && secondDoc.code === 'rate-limited' && speech.calls.length === 1,
    `首次=${firstDoc.ok ? 'ok' : firstDoc.code} · 第二次=${secondDoc.code} · 实际调用 provider ${speech.calls.length} 次`);
  await host.close();
}

/* D⑤ 录音失败（无麦克风权限）⇒ 前端提示且不崩（源码级判据：try/catch + 状态提示） */
{
  const source = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  // 判据：录音函数在 try 里申请麦克风，catch 里只写状态行（不抛、不弹框）
  const fnAt = source.indexOf('async function petChatVoiceStart');
  const fnBody = fnAt >= 0 ? source.slice(fnAt, fnAt + 1800) : '';
  const guarded = /try\s*\{[\s\S]{0,900}?getUserMedia/.test(fnBody) && /catch[\s\S]{0,300}?petChatStatus/.test(fnBody);
  const noThrowOnDenied = /未授权|没有麦克风|打不开麦克风/.test(fnBody);
  check('D⑤ 录音失败 ⇒ 只给一行提示，不崩（getUserMedia 在 try/catch 里）',
    fnAt >= 0 && guarded && noThrowOnDenied,
    `有录音函数=${fnAt >= 0} · try/catch 包裹=${guarded} · 有权限失败文案=${noThrowOnDenied}`);
}

/* D⑥ 识别结果只填输入框，不自动发送 */
{
  const source = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  // 从**调用点**往后扫（文档注释里也出现过这个路径，不能用 indexOf 的第一次命中）
  const at = source.indexOf("apiPostJson('/pet-chat/transcribe'");
  const body = at >= 0 ? source.slice(at, at + 900) : '';
  const fillsInput = /els\.input\.value\s*=\s*doc\.text/.test(body);
  const sends = /petChatSend\s*\(/.test(body);
  check('D⑥ 识别结果只填输入框，不自动发送',
    at >= 0 && fillsInput && !sends,
    `填 input=${fillsInput} · 同一段里调用 send=${sends}`);
}

/* ── E 块：朗读回答（6 条判据，mock speechSynthesis）────────────────────── */
{
  // 引擎是浏览器侧的独立文件（不依赖 DOM）：在沙箱里加载真源码，注入 mock 依赖
  const ttsSource = readFileSync(join(ROOT, 'src', 'pet-chat-tts.js'), 'utf8');
  const loadTts = new Function(`${ttsSource}\n;return { petChatTtsCreate, petChatTtsSplit };`)();

  const makeSpeech = (voices) => {
    const spoken = [];
    let cancels = 0;
    return {
      spoken,
      cancels: () => cancels,
      speech: { speak: (utterance) => spoken.push(utterance.text), cancel: () => { cancels += 1; }, getVoices: () => voices },
    };
  };
  const makeUtterance = () => class FakeUtterance {
    constructor(text) { this.text = text; }
  };
  const zhVoices = [{ name: 'Microsoft Huihui Desktop', lang: 'zh-CN', voiceURI: 'huihui' }];

  /* E① 开启 ⇒ speak 一次，文本 == 气泡文本 */
  {
    const mock = makeSpeech(zhVoices);
    const hints = [];
    const tts = loadTts.petChatTtsCreate({
      getSpeech: () => mock.speech,
      getVoices: () => zhVoices,
      getConfig: () => ({ enabled: true, rate: 1, pitch: 1, volume: 1, voiceURI: '' }),
      Utterance: makeUtterance(),
      onHint: (code, message) => hints.push({ code, message }),
    });
    const reply = '你好呀，今天想换壁纸吗？';
    tts.start();
    tts.finish(reply);
    check('E① 开启 ⇒ speak 一次，文本 == 气泡文本',
      mock.spoken.length === 1 && mock.spoken[0] === reply,
      `speak ${mock.spoken.length} 次 · text=${JSON.stringify(mock.spoken[0])}`);
  }

  /* E② 文字仍在：引擎不碰 DOM / 不改传入文本 */
  {
    const mock = makeSpeech(zhVoices);
    const reply = '这段话必须还留在气泡里。';
    const tts = loadTts.petChatTtsCreate({
      getSpeech: () => mock.speech,
      getVoices: () => zhVoices,
      getConfig: () => ({ enabled: true }),
      Utterance: makeUtterance(),
      onHint: () => {},
    });
    tts.start();
    tts.finish(reply);
    // 引擎只接受字符串，没有任何 DOM 入口；断言文本原样、且没有 document 依赖
    const noDom = !/document\./.test(ttsSource) && !/innerHTML|textContent\s*=/.test(ttsSource);
    check('E② 文字仍在（朗读是叠加，不替换）',
      reply === '这段话必须还留在气泡里。' && noDom,
      `原文未变=${reply === '这段话必须还留在气泡里。'} · 引擎无 DOM 写入=${noDom}`);
  }

  /* E③ 关闭 ⇒ speak 从未调用 */
  {
    const mock = makeSpeech(zhVoices);
    const tts = loadTts.petChatTtsCreate({
      getSpeech: () => mock.speech,
      getVoices: () => zhVoices,
      getConfig: () => ({ enabled: false }),
      Utterance: makeUtterance(),
      onHint: () => {},
    });
    tts.start();
    tts.finish('不该被读出来');
    tts.push('也不该');
    check('E③ 关闭 ⇒ speak 从未调用', mock.spoken.length === 0, `speak ${mock.spoken.length} 次`);
  }

  /* E④ 新消息 / 关闭 ⇒ cancel 被调用 */
  {
    const mock = makeSpeech(zhVoices);
    const tts = loadTts.petChatTtsCreate({
      getSpeech: () => mock.speech,
      getVoices: () => zhVoices,
      getConfig: () => ({ enabled: true }),
      Utterance: makeUtterance(),
      onHint: () => {},
    });
    tts.start();          // 新消息先 cancel
    tts.finish('第一段');
    tts.cancel();         // 关闭气泡 / 点停止
    check('E④ 新消息 / 关闭 ⇒ cancel 被调用',
      mock.cancels() >= 2,
      `cancel ${mock.cancels()} 次（start 1 + cancel 1）`);
  }

  /* E⑤ speechSynthesis 缺失 ⇒ 不抛错、文字照常 */
  {
    let threw = false;
    let tts;
    try {
      tts = loadTts.petChatTtsCreate({
        getSpeech: () => null,
        getVoices: () => [],
        getConfig: () => ({ enabled: true }),
        Utterance: makeUtterance(),
        onHint: () => {},
      });
      tts.start();
      tts.push('没有语音引擎');
      tts.finish('没有语音引擎');
      tts.cancel();
    } catch { threw = true; }
    check('E⑤ speechSynthesis 缺失 ⇒ 不抛错、文字照常', !threw, `抛错=${threw}`);
  }

  /* E⑥ 无中文音色 ⇒ 只提示一次 */
  {
    const enVoices = [{ name: 'Microsoft David Desktop', lang: 'en-US', voiceURI: 'david' }];
    const mock = makeSpeech(enVoices);
    const hints = [];
    const tts = loadTts.petChatTtsCreate({
      getSpeech: () => mock.speech,
      getVoices: () => enVoices,
      getConfig: () => ({ enabled: true }),
      Utterance: makeUtterance(),
      onHint: (code, message) => hints.push({ code, message }),
    });
    tts.start();
    tts.finish('第一句');
    tts.finish('第二句');
    const noChinese = hints.filter((hint) => hint.code === 'no-chinese-voice');
    check('E⑥ 无中文音色 ⇒ 只提示一次（且仍然朗读）',
      noChinese.length === 1 && mock.spoken.length >= 1,
      `提示 ${noChinese.length} 次 · 仍朗读 ${mock.spoken.length} 段`);
  }
}

/* ── F 块：edge-tts 在线情感朗读（5 条判据）────────────────────────────── */
{
  const voiceOutOn = (over = {}) => ({ petChat: { enabled: true, voiceOut: { enabled: true, rate: 1, pitch: 1, volume: 1, voiceURI: '' }, ...over } });
  const postSpeak = (host, payload) => fetch(`${host.base}/speak`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const audio = new Uint8Array([1, 2, 3, 4, 5]);

  /* F① engine=system ⇒ 不请求网络 */
  {
    let edgeCalls = 0;
    const host = await startHost(voiceOutOn(), undefined, async () => { edgeCalls += 1; return { audio, mime: 'audio/mpeg', style: 'narration' }; });
    const res = await postSpeak(host, { text: '你好', emotion: 'happy' });
    const doc = await res.json();
    check('F① engine=system ⇒ 不发网络请求（engine 回 system）',
      doc.ok === true && doc.engine === 'system' && edgeCalls === 0,
      `engine=${doc.engine} · edge 调用 ${edgeCalls} 次`);
    await host.close();
  }

  /* F② engine=edge ⇒ 成功返回音频 */
  {
    let seen = null;
    const host = await startHost(voiceOutOn({ voiceEngine: 'edge' }), undefined, async (args) => {
      seen = args;
      return { audio, mime: 'audio/mpeg', style: 'cheerful' };
    });
    const res = await postSpeak(host, { text: '今天天气不错', emotion: 'happy' });
    const doc = await res.json();
    const decoded = doc.audio ? Buffer.from(doc.audio, 'base64') : null;
    check('F② engine=edge ⇒ 返回音频（base64 可解码、mime 正确）',
      doc.ok === true && doc.engine === 'edge' && doc.mime === 'audio/mpeg'
        && decoded && decoded.length === audio.length && seen && seen.text === '今天天气不错',
      `engine=${doc.engine} · mime=${doc.mime} · 字节 ${decoded ? decoded.length : 0} · 传参 text=${seen && seen.text}`);
    await host.close();
  }

  /* F③ edge 失败 ⇒ 回落 system 且日志只记一次 */
  {
    let edgeCalls = 0;
    const host = await startHost(voiceOutOn({ voiceEngine: 'edge' }), undefined, async () => { edgeCalls += 1; throw new Error('edge-timeout'); });
    const first = await (await postSpeak(host, { text: '第一句' })).json();
    const second = await (await postSpeak(host, { text: '第二句' })).json();
    const fallbackLogs = host.logs.filter((line) => /edge-tts 失败/.test(line));
    check('F③ edge 失败 ⇒ 回落 system，且日志只记一次',
      first.engine === 'system' && first.fallback === 'edge-failed'
        && second.engine === 'system' && fallbackLogs.length === 1 && edgeCalls === 2,
      `首次=${first.engine}/${first.fallback} · 二次=${second.engine}/${second.fallback} · 日志 ${fallbackLogs.length} 条 · edge 调用 ${edgeCalls} 次`);
    await host.close();
  }

  /* F④ 风格随 emotion 变化（断言 SSML style 映射） */
  {
    const { buildEdgeSsml, EDGE_STYLE_MAP } = await import('../lib/pet-chat-edge-tts.js');
    const ssml = (emotion) => buildEdgeSsml({ text: '测试', emotion });
    const okMap = EDGE_STYLE_MAP.happy === 'cheerful' && EDGE_STYLE_MAP.tired === 'gentle'
      && EDGE_STYLE_MAP.angry === 'angry' && EDGE_STYLE_MAP.calm === 'narration';
    const okSsml = /style="cheerful"/.test(ssml('happy')) && /style="gentle"/.test(ssml('tired'))
      && /style="angry"/.test(ssml('angry')) && /style="narration"/.test(ssml('calm'));
    check('F④ 风格随 emotion 变化（cheerful/gentle/angry/narration）',
      okMap && okSsml, `映射正确=${okMap} · SSML 正确=${okSsml}`);
  }

  /* F⑤ 关闭朗读 ⇒ 两档都不触发 */
  {
    let edgeCalls = 0;
    const host = await startHost({ petChat: { enabled: true, voiceEngine: 'edge', voiceOut: { enabled: false } } }, undefined, async () => { edgeCalls += 1; return { audio, mime: 'audio/mpeg', style: 'narration' }; });
    const doc = await (await postSpeak(host, { text: '不该读' })).json();
    check('F⑤ 关闭朗读 ⇒ 两档都不触发',
      doc.ok === false && doc.code === 'voice-out-disabled' && edgeCalls === 0,
      `code=${doc.code} · edge 调用 ${edgeCalls} 次`);
    await host.close();
  }
}

/* ── 收账 ─────────────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.ok);
console.log(`\nPET CHAT CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
