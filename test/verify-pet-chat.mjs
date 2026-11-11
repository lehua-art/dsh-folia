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
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT || (process.platform === 'win32' ? 'C:/Windows/Temp/folia-asr-none' : '/tmp/folia-asr-none');
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

/* B④ v0.1 零配置：记忆常开 —— 旧档写 memoryEnabled=false 也照常记、照常注入 */
{
  resetMem();
  const model = await startModel(() => ({ lines: ollamaLines('好') }));
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, memoryEnabled: false } });
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '记住我喜欢原神' }),
  });
  await readSse(response);
  const lastSystem = String((model.seen[model.seen.length - 1].body.messages || [])[0].content || '');
  // 注意：记忆是**这一轮**从用户话里提取的，注入要到下一轮才看得到 —— 这里只断言"照常记"
  check('B④ 记忆常开：旧档写 memoryEnabled=false 也照常记',
    readMem() !== null,
    `文件=${readMem() === null ? '不存在' : '有'} · 本轮 prompt 含记忆=${lastSystem.includes('关于主人')}`);
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

/* D⑤/D⑥ 已随旧面板一起删除：v0.1 没有输入框，语音输入链路（唤醒→录音→转录→回填）
   会在 S3 重建，届时判据一并重写。删掉而不是 skip，避免"看起来还测着"的假覆盖。 */

/* E 块（朗读回答）已删除：v0.1 验收明确"不含任何朗读/TTS"（docs/PET-V01-ACCEPTANCE.md §1 ⑦），
   src/pet-chat-tts.js 随之下线；朗读相关的 6 条判据归 v0.2。 */

/* ── H 块：零配置主动搭话（固定策略 + 语音指令）────────────────────────── */
{
  const { canSpeak, buildProactiveLine, enterSilence, clearSilence, clearProactiveState, markSaid, PROACTIVE_RULES } = await import('../lib/pet-chat-proactive.js');
  const noon = new Date(2026, 10, 10, 14, 0).getTime();
  const night = new Date(2026, 10, 10, 23, 30).getTime();

  /* H① 固定策略：夜间 / 非空闲 / 全屏 / 刚说完 ⇒ 都不说 */
  {
    clearProactiveState();
    const base = { idleMinutes: 30, fullscreen: false, randomHit: true };
    const nightHit = canSpeak({ ...base, now: night });
    const idleMiss = canSpeak({ ...base, now: noon, idleMinutes: 0 });
    const fullscreenHit = canSpeak({ ...base, now: noon, fullscreen: true });
    markSaid(noon, 'x');
    const soon = canSpeak({ ...base, now: noon + 10 * 60000 });
    check('H① 固定策略：夜间/非空闲/全屏/刚说完 都不说',
      nightHit.reason === 'quiet-hours' && idleMiss.reason === 'not-idle'
        && fullscreenHit.reason === 'fullscreen' && soon.reason === 'too-soon',
      `夜间=${nightHit.reason} · 空闲=${idleMiss.reason} · 全屏=${fullscreenHit.reason} · 刚说完=${soon.reason}`);
    clearProactiveState();
  }

  /* H② 语音指令：说"别说了"⇒ 静默；说"可以说话了"⇒ 恢复 */
  {
    clearProactiveState();
    const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'x' } });
    const say = (text) => new Promise((resolve) => {
      const chunks = [];
      fetch(`${host.base}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
      }).then(async (response) => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read(); // eslint-disable-line no-await-in-loop
          if (done) break;
          chunks.push(decoder.decode(value));
        }
        resolve(chunks.join(''));
      }).catch(() => resolve(''));
    });
    const silenceStream = await say('别说了');
    const silentState = canSpeak({ now: noon, idleMinutes: 30, fullscreen: false, randomHit: true });
    // 路由有 1 次/秒限频：指令两条要隔开，否则第二条会吃 rate-limited
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const resumeStream = await say('可以说话了');
    const resumed = canSpeak({ now: noon, idleMinutes: 30, fullscreen: false, randomHit: true });
    await host.close();
    check('H② 语音指令：别说了 ⇒ 静默；可以说话了 ⇒ 恢复',
      /安静/.test(silenceStream) && silentState.reason === 'silent'
        && /回来/.test(resumeStream) && resumed.ok === true,
      `静默后=${silentState.reason} · 恢复后=${resumed.reason}`);
    clearProactiveState();
  }

  /* H③ 内容 ≤30 字，且带上下文要素 */
  {
    const built = buildProactiveLine({ now: noon, wallpaperTitle: '星空', memory: { likes: ['原神'] }, usedLines: [] });
    const built2 = buildProactiveLine({ now: noon, wallpaperTitle: '星空', memory: { likes: ['原神'] }, usedLines: [built.line] });
    check('H③ 内容 ≤30 字且不重复',
      built.line.length <= PROACTIVE_RULES.maxChars && built.line !== built2.line
        && (built.line.includes('星空') || built.source !== 'time'),
      `${built.line}（${built.line.length} 字）· 第二条=${built2.line}`);
  }
}

  /* H④ 静默后：用户主动唤醒对话照常，"叫停"仍被识别，且不会主动搭话 */
  {
    const { clearProactiveState: clear4, enterSilence: silence4, canSpeak: can4 } = await import('../lib/pet-chat-proactive.js');
    clear4();
    const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'x' } });
    const say = async (text) => {
      const response = await fetch(`${host.base}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
      });
      return response.text();
    };
    // 静默期间：主动搭话必须完全不发（tick 返回 silent，没有 line）
    silence4();
    const tick = await fetch(`${host.base}/proactive/tick`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idleMinutes: 30, fullscreen: false }),
    });
    const tickDoc = await tick.json();
    // 用户点一下桌宠再说话：对话链路照常（这里说"别说了"，指令仍被识别）
    const stream = await say('别说了');
    const stillSilent = can4({ idleMinutes: 30, fullscreen: false, randomHit: true });
    await host.close();
    clear4();
    check('H④ 静默后：主动搭话不发；用户主动说的"别说了"仍被识别',
      tickDoc.ok === false && tickDoc.reason === 'silent' && !tickDoc.line
        && /安静/.test(stream) && stillSilent.reason === 'silent',
      `tick=${tickDoc.reason} · 指令识别=${/安静/.test(stream)} · 仍静默=${stillSilent.reason}`);
  }


/* ── 收账 ─────────────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.ok);
console.log(`\nPET CHAT CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
