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
/* ── C 块：主动闲聊（4 条判据）────────────────────────────────────────── */
const { canSpeak, inQuietHours, skipToday, markSaid, clearProactiveState, PROACTIVE_RULES } = await import('../lib/pet-chat-proactive.js');
const HOUR = 3600000;
const MIN = 60000;
/** 构造"当地某个整点"的毫秒时间（避免跨零点把日界判据搅进来）。 */
const at = (hour, minute = 0, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};
const NOON = at(14, 0);

/* C① 默认关 ⇒ 三小时无事件也 0 次 */
{
  resetMem();
  clearProactiveState();
  let spoken = 0;
  for (let i = 0; i < 36; i += 1) { // 3 小时，每 5 分钟探一次
    if (canSpeak({ enabled: false, now: NOON + i * 5 * MIN, idleMinutes: 30 }).ok) spoken += 1;
  }
  check('C① 默认关 ⇒ 三小时 0 次主动', spoken === 0, `探测 36 次 · 说话 ${spoken} 次`);
}

/* C② 五个条件任一不满足 ⇒ 都不说话 */
{
  clearProactiveState();
  const good = { enabled: true, now: NOON, idleMinutes: 30, fullscreen: false, randomHit: true, quietHours: '22:00-08:00' };
  const results = {
    enabled: canSpeak({ ...good, enabled: false }).reason,
    inQuiet: canSpeak({ ...good, now: at(23, 30) }).reason,      // 静默时段内
    idle: canSpeak({ ...good, idleMinutes: 3 }).reason,          // 用户刚动过
    fullscreen: canSpeak({ ...good, fullscreen: true }).reason,  // 全屏
    randomMiss: canSpeak({ ...good, randomHit: false }).reason,  // 随机未命中
  };
  // 日限：同一天说满 1 条之后应被挡
  clearProactiveState();
  const small = { ...good, dailyLimit: 1 };
  const first = canSpeak(small);
  markSaid(small.now);
  results.dailyLimit = canSpeak({ ...small, now: NOON + 3 * HOUR }).reason;
  check('C② 五条件：未开启/静默/非空闲/全屏/随机未命中/日限满 ⇒ 都不说话',
    results.enabled === 'disabled' && results.inQuiet === 'quiet-hours' && results.idle === 'not-idle'
      && results.fullscreen === 'fullscreen' && results.randomMiss === 'random-miss'
      && first.ok === true && results.dailyLimit === 'daily-limit',
    JSON.stringify(results));
  clearProactiveState();
}

/* C③ 满足条件时最多每 2 小时 1 条 */
{
  clearProactiveState();
  const base = at(9, 0);
  const cfg = { enabled: true, now: base, idleMinutes: 30, fullscreen: false, randomHit: true, quietHours: '22:00-08:00', dailyLimit: 10, minGapMin: PROACTIVE_RULES.minGapMinDefault };
  const a = canSpeak(cfg);
  markSaid(base); // 路由在 ok 时会记一条（这里模拟同一动作）
  const b = canSpeak({ ...cfg, now: base + 60 * MIN });
  const c = canSpeak({ ...cfg, now: base + 119 * MIN });
  const d = canSpeak({ ...cfg, now: base + 121 * MIN });
  check('C③ 间隔：首次可说话，2 小时内不再说，超过 2 小时才允许',
    a.ok === true && b.reason === 'too-soon' && c.reason === 'too-soon' && d.ok === true,
    `t0=${a.reason} · +1h=${b.reason} · +1h59=${c.reason} · +2h01=${d.reason}`);
  clearProactiveState();
}

/* C④ 「今天别说了」⇒ 当日不再主动 */
{
  clearProactiveState();
  const base = at(9, 0);
  const cfg = { enabled: true, now: base, idleMinutes: 30, fullscreen: false, randomHit: true, quietHours: '22:00-08:00', dailyLimit: 10, minGapMin: 30 };
  const before = canSpeak(cfg);
  skipToday(base);
  const after = canSpeak({ ...cfg, now: at(12, 0) });
  const tomorrow = canSpeak({ ...cfg, now: at(9, 0, 1) + 24 * HOUR });
  check('C④ 「今天别说了」⇒ 当日不再主动，次日恢复',
    before.ok === true && after.reason === 'skip-today' && tomorrow.ok === true,
    `说前=${before.reason} · 当天=${after.reason} · 次日=${tomorrow.reason}`);
  clearProactiveState();
}

/* ── C1 客户端接线：5 分钟节奏 + 渲染进程五事实 ──────────────────────── */
{
  clearProactiveState();
  const source = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const hasCadence = /PET_CHAT_CHECK_INTERVAL_MS\s*=\s*5 \* 60 \* 1000/.test(source);
  const usesFullscreen = /document\.fullscreenElement/.test(source);
  const usesFocus = /document\.hasFocus\(\)/.test(source);
  const tracksActivity = /'mousemove'/.test(source);
  const cadence = PROACTIVE_RULES.checkIntervalMs;
  check('C⑤ 客户端每 5 分钟检查一次，且用渲染进程能拿到的事实',
    hasCadence && cadence === 300000 && usesFullscreen && usesFocus && tracksActivity,
    `源码 5min 常量=${hasCadence} · PROACTIVE_RULES=${cadence} · fullscreen=${usesFullscreen} · hasFocus=${usesFocus} · 活动追踪=${tracksActivity}`);
}

/* C⑥ 模拟时钟推进 3 小时：用户一直活跃（idle 0）⇒ 0 次；转为空闲后 ⇒ 恰好 1 次 */
{
  clearProactiveState();
  const base = at(9, 0);
  const step = PROACTIVE_RULES.checkIntervalMs; // 5 分钟
  const cfg = { enabled: true, idleMinutes: 0, fullscreen: false, focused: true, randomHit: true, quietHours: '22:00-08:00', dailyLimit: 10, minGapMin: 120 };
  let activeSpoken = 0;
  for (let t = 0; t < 3 * 60 * 60 * 1000; t += step) {
    const decision = canSpeak({ ...cfg, now: base + t, idleMinutes: 0 });
    if (decision.ok) { activeSpoken += 1; markSaid(base + t); }
  }
  // 用户离开 12 分钟后（窗口内视角）应恰好触发一次
  const idleAt = base + 3 * 60 * 60 * 1000 + 12 * 60 * 1000;
  const first = canSpeak({ ...cfg, now: idleAt, idleMinutes: 12 });
  if (first.ok) markSaid(idleAt);
  const second = canSpeak({ ...cfg, now: idleAt + step, idleMinutes: 17 });
  check('C⑥ 3 小时活跃 0 次；转空闲后恰好 1 次',
    activeSpoken === 0 && first.ok === true && second.reason === 'too-soon',
    `活跃期 36 次探测 ⇒ ${activeSpoken} 次 · 空闲首次=${first.reason} · 5 分钟后=${second.reason}`);
  clearProactiveState();
}

/* C⑦ 全屏 / 失焦 / 静默时段 ⇒ 都不触发 */
{
  clearProactiveState();
  const base = at(14, 0);
  const cfg = { enabled: true, idleMinutes: 30, fullscreen: false, focused: true, randomHit: true, quietHours: '22:00-08:00', dailyLimit: 10, minGapMin: 30 };
  const fullscreen = canSpeak({ ...cfg, now: base, fullscreen: true });
  const unfocused = canSpeak({ ...cfg, now: base, focused: false });
  const quiet = canSpeak({ ...cfg, now: at(23, 30) });
  const normal = canSpeak({ ...cfg, now: base });
  check('C⑦ 全屏 / 失焦 / 静默时段 ⇒ 都不触发（对照组正常触发）',
    fullscreen.reason === 'fullscreen' && unfocused.reason === 'unfocused'
      && quiet.reason === 'quiet-hours' && normal.ok === true,
    `全屏=${fullscreen.reason} · 失焦=${unfocused.reason} · 静默=${quiet.reason} · 对照=${normal.reason}`);
  clearProactiveState();
}

/* ── 收账 ─────────────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.ok);
console.log(`\nPET CHAT CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
