/**
 * routes/pet-chat.js — **桌宠对话**路由族：`/pet-chat/*`（门 2 / 任务 A2）。
 *
 * 四条端点（契约见插件仓库 docs/PET-CHAT-PLAN.md §2.2）：
 *   GET  /folia/pet-chat/state    → { enabled, provider, model, reachable, lastError }
 *   GET  /folia/pet-chat/models   → ollama 的 /api/tags 列表（openai 返回空 + hint）
 *   POST /folia/pet-chat/chat     → SSE：event: delta {"t"} / done {usage,emotion} / error {code,hint}
 *   POST /folia/pet-chat/reset    → 清空会话记忆
 *
 * 纪律（工单 §2.2 的约束，逐条对上）：
 *   · **只转发到用户配置的端点**：baseUrl 来自设置（空 = 该 provider 的默认端点），
 *     不接受请求体里带 URL —— 否则这个路由会变成任意转发器。
 *   · **超时 20s**：AbortController；到点即发 `error{code:'timeout'}` 并断流。
 *   · **限频 1 次/秒**（同一来源 IP）：超了直接 `error{code:'rate-limited'}`，不再打模型。
 *   · **输入 ≤400 字**：超长 `error{code:'bad-request'}`（客户端也会截断，这里是服务端兜底）。
 *   · **key 不进日志**：本文件**一行都不打印** apiKey / 请求头；错误文案只带状态码。
 *   · 会话记忆在**宿主进程内存**里（reset 清空），不落盘：重启即忘，符合"只在本次会话里聊"。
 *
 * 依赖面（与 test/verify-inject-contracts.mjs 双向对账）：`disposers` / `base` / `log` / `readSettings`。
 */

/** 注入契约：本族从 `c` 消费的**必需**键（门面/注册表调用点必须逐键给到）。 */
export const DEPS = ['disposers', 'base', 'log', 'readSettings'];

import {
  readMemory, writeMemory, clearMemory, parseExplicitMemory, rememberExplicit,
  mergeSummary, memoryPromptLine, MEMORY_SUMMARY_PROMPT,
} from '../pet-chat-memory.js';
import {
  canSpeak, markSaid, skipToday, todayUsage, QUIET_HOURS_DEFAULT,
} from '../pet-chat-proactive.js';

/** 单次输入上限（工单：≤400 字）。 */
const MAX_INPUT_CHARS = 400;
/** 模型调用超时（工单：20s）。 */
const TIMEOUT_MS = 20000;
/** 同一来源的最小间隔（工单：1 次/秒）。 */
const RATE_LIMIT_MS = 1000;
/** 会话记忆最多保留的轮数（一轮 = 一问一答）。 */
const MAX_MEMORY_TURNS = 12;

/** 各 provider 的默认端点 / 默认模型（设置里 baseUrl / model 为空时用）。 */
const PROVIDER_DEFAULTS = {
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b' },
  openai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
};

const EMO_CODES = Object.freeze(['happy', 'calm', 'tired', 'angry']);

/** 情绪关键词兜底（模型没给合法 emotion 时用；与客户端预设台词同一套分组）。 */
const EMO_KEYWORDS = [
  ['happy', /哈哈|好耶|开心|太好了|喜欢|嘿嘿|✧|（＾|^_^|😊|🎉/u],
  ['tired', /困|累|睡|休息|晚安|疲惫|zzz/i],
  ['angry', /生气|讨厌|烦|哼|气死|😠/u],
  ['calm', /算了|不知道|还好|一般|平静|嗯/],
];

/**
 * 从一段文本里取 `{reply, emotion}`。
 *
 * 模型被要求输出 `{"reply":"...","emotion":"happy|calm|tired|angry"}`；
 * 不是合法 JSON（很常见）就**整段当 reply**，情绪走关键词兜底 —— 不因为格式不对就不回答。
 */
export function parseReplyText(text) {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const doc = JSON.parse(trimmed);
      if (doc && typeof doc.reply === 'string') {
        return { reply: doc.reply, emotion: EMO_CODES.includes(doc.emotion) ? doc.emotion : null };
      }
    } catch { /* 落到下面按纯文本处理 */ }
  }
  return { reply: raw, emotion: null };
}

/** 关键词兜底（导出给测试与客户端对照）。 */
export function emotionFromKeywords(text) {
  const raw = String(text ?? '');
  for (const [code, re] of EMO_KEYWORDS) if (re.test(raw)) return code;
  return 'calm';
}

/** 状态码 → 机读错误码（工单 §2.2 的 code 集合）。 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return { code: 'unauthorized', hint: '检查设置里的 apiKey 是否正确' };
  if (status === 429) return { code: 'rate-limited', hint: '模型端点限流了，等一会儿再试' };
  return { code: 'bad-request', hint: `模型端点返回 HTTP ${status}` };
}

/** SSE 单帧。 */
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 读请求体（JSON；超过上限直接拒绝）。 */
function readJsonBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { reject(Object.assign(new Error('body-too-large'), { code: 'bad-request' })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch { reject(Object.assign(new Error('bad-json'), { code: 'bad-request' })); }
    });
    req.on('error', reject);
  });
}

/** 只取 IP 里的地址部分（限频键）。 */
function sourceOf(req) {
  return String((req.socket && req.socket.remoteAddress) || 'unknown');
}

/**
 * 把一次流式响应按 provider 解成纯文本增量。
 *
 * ollama：整行 JSON `{"message":{"content":"…"},"done":false}`
 * openai：`data: {"choices":[{"delta":{"content":"…"}}]}` / `data: [DONE]`
 * 两种都容忍空行与心跳注释（`: keep-alive`）。
 */
function* decodeStreamChunk(provider, line) {
  const raw = String(line ?? '').trim();
  if (!raw || raw.startsWith(':')) return;
  const payload = raw.startsWith('data:') ? raw.slice(5).trim() : raw;
  if (!payload || payload === '[DONE]') return;
  let doc;
  try { doc = JSON.parse(payload); } catch { return; }
  if (provider === 'ollama') {
    const piece = doc && doc.message && typeof doc.message.content === 'string' ? doc.message.content : '';
    if (piece) yield piece;
    return;
  }
  const choice = doc && Array.isArray(doc.choices) ? doc.choices[0] : null;
  const piece = choice && choice.delta && typeof choice.delta.content === 'string' ? choice.delta.content : '';
  if (piece) yield piece;
}

export function registerPetChatRoutes(webServer, c) {
  const { disposers, base: BASE, log, readSettings } = c;

  /** 当前进程内的会话记忆（重启即忘；`/reset` 清空）。 */
  let memory = [];
  /** 轮次计数（摘要触发用）与最近一次摘要时间。 */
  let turnCount = 0;
  let lastMemoryAt = 0;
  /** 同一来源的最近一次请求时间（限频）。 */
  const lastAt = new Map();
  /** 最近一次失败原因（`/state` 里回给界面）。 */
  let lastError = null;

  /** 读当前 petChat 配置（每次现读：设置面板改完立刻生效，不用重启）。 */
  function readPetChat() {
    let settings = null;
    try { settings = readSettings(); } catch (error) {
      // 读设置失败不能让整条链路炸：当作默认（关）
      log('[pet-chat] 读设置失败：' + String((error && error.message) || error));
    }
    const raw = settings && typeof settings === 'object' && settings.petChat && typeof settings.petChat === 'object'
      ? settings.petChat : {};
    const provider = raw.provider === 'openai' ? 'openai' : 'ollama';
    const defaults = PROVIDER_DEFAULTS[provider];
    const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : defaults.baseUrl;
    return {
      enabled: raw.enabled === true,
      provider,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : defaults.model,
      persona: raw.persona && typeof raw.persona === 'object' ? raw.persona : {},
      maxTurns: Number.isFinite(Number(raw.maxTurns)) ? Math.max(1, Math.min(MAX_MEMORY_TURNS, Number(raw.maxTurns))) : 8,
      maxChars: Number.isFinite(Number(raw.maxChars)) ? Math.max(20, Math.min(160, Number(raw.maxChars))) : 80,
      memoryEnabled: raw.memoryEnabled !== false,
      memoryEveryTurns: Number.isFinite(Number(raw.memoryEveryTurns)) ? Math.max(1, Math.min(50, Number(raw.memoryEveryTurns))) : 10,
      proactiveEnabled: raw.proactiveEnabled === true,
      proactiveDailyLimit: Number.isFinite(Number(raw.proactiveDailyLimit)) ? Math.max(1, Math.min(20, Number(raw.proactiveDailyLimit))) : 10,
      proactiveMinGapMin: Number.isFinite(Number(raw.proactiveMinGapMin)) ? Math.max(30, Math.min(720, Number(raw.proactiveMinGapMin))) : 120,
      quietHours: typeof raw.quietHours === 'string' && /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(raw.quietHours) ? raw.quietHours : '22:00-08:00',
    };
  }

  /** 组装请求体（两种协议各一份；都只发到配置里的端点）。 */
  function buildRequest(config, text) {
    const persona = config.persona || {};
    let system = `你是${persona.name || 'Folia'}，${persona.style || '元气、短句、偶尔颜文字、不说教'}；`
      + `你的特点：${persona.traits || '喜欢壁纸和游戏，被夸会害羞'}。`
      + `用中文口语回答，最多 ${config.maxChars} 字，不用 Markdown。`
      + '如果方便，把回答写成 JSON：{"reply":"…","emotion":"happy|calm|tired|angry"}；不方便就正常说话。';
    // 工单 A5⑤ 的判据是「第 9 轮只带最近 8 条」⇒ 上限按**条**算（一问一答 = 2 条）
    // B3：把长期偏好注入 system prompt（≤80 字；记忆为空时这一行为空）
    const memoryLine = config.memoryEnabled ? memoryPromptLine(readMemory()) : '';
    if (memoryLine) system += '\n' + memoryLine;
    const history = memory.slice(-config.maxTurns);
    const headers = { 'content-type': 'application/json' };
    if (config.provider === 'openai') {
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      return {
        url: `${config.baseUrl}/chat/completions`,
        body: {
          model: config.model,
          stream: true,
          temperature: 0.8,
          messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: text }],
        },
        headers,
      };
    }
    return {
      url: `${config.baseUrl}/api/chat`,
      body: {
        model: config.model,
        stream: true,
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: text }],
      },
      headers,
    };
  }

  /** GET /pet-chat/state */
  async function handleState(res) {
    const config = readPetChat();
    let reachable = false;
    if (config.enabled) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const probe = config.provider === 'ollama' ? `${config.baseUrl}/api/tags` : `${config.baseUrl}/models`;
        const headers = {};
        if (config.provider === 'openai' && config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
        const response = await fetch(probe, { headers, signal: controller.signal });
        reachable = response.ok;
        if (!response.ok) lastError = codeForStatus(response.status).code;
      } catch {
        reachable = false;
        lastError = 'unreachable';
      } finally {
        clearTimeout(timer);
      }
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: true,
      enabled: config.enabled,
      provider: config.provider,
      model: config.model,
      reachable,
      lastError,
    }));
  }

  /** GET /pet-chat/models */
  async function handleModels(res) {
    const config = readPetChat();
    const send = (payload) => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    if (config.provider === 'openai') {
      send({ ok: true, provider: 'openai', models: [], hint: 'OpenAI 兼容端点不提供模型列表，直接在设置里填模型名' });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${config.baseUrl}/api/tags`, { signal: controller.signal });
      if (!response.ok) { send({ ok: false, provider: 'ollama', models: [], hint: `HTTP ${response.status}` }); return; }
      const doc = await response.json();
      const models = (doc && Array.isArray(doc.models) ? doc.models : [])
        .map((item) => (item && typeof item.name === 'string' ? item.name : null))
        .filter(Boolean);
      send({ ok: true, provider: 'ollama', models });
    } catch {
      send({ ok: false, provider: 'ollama', models: [], hint: '连不上本机 Ollama（127.0.0.1:11434）' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /pet-chat/chat（SSE） */
  async function handleChat(req, res) {
    const ip = sourceOf(req);
    const now = Date.now();
    const prev = lastAt.get(ip) || 0;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const fail = (code, hint) => {
      lastError = code;
      sse(res, 'error', { code, hint });
      res.end();
    };

    if (now - prev < RATE_LIMIT_MS) { fail('rate-limited', '一秒一次，慢点~'); return; }
    lastAt.set(ip, now);

    let body;
    try { body = await readJsonBody(req); } catch { fail('bad-request', '请求体不是合法 JSON'); return; }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) { fail('bad-request', '说点什么吧'); return; }
    if ([...text].length > MAX_INPUT_CHARS) { fail('bad-request', `一次最多 ${MAX_INPUT_CHARS} 字`); return; }

    const config = readPetChat();
    if (!config.enabled) { fail('no-model', '先在设置里打开桌宠对话并填一个模型'); return; }
    if (config.provider === 'openai' && !config.apiKey) {
      fail('no-model', '填 DeepSeek API Key 即可对话（也可改用本机 Ollama，检测到 127.0.0.1:11434 时会提示）');
      return;
    }

    const request = buildRequest(config, text);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let finished = false;
    const done = (emotion, usage) => {
      if (finished) return;
      finished = true;
      sse(res, 'done', { emotion, usage: usage || null });
      res.end();
    };

    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const mapped = codeForStatus(response.status);
        fail(mapped.code, mapped.hint);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- 流式读取必须逐块等
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          for (const piece of decodeStreamChunk(config.provider, line)) {
            // 回复长度上限（工单 A5⑥）：超了就**在流里截断**，不把超长内容推给气泡，
            // 也不假装没发生 —— 截断处就是 done，客户端拿到的长度恒 ≤ maxChars。
            const room = config.maxChars - full.length;
            if (room <= 0) break;
            const chunk = piece.length > room ? piece.slice(0, room) : piece;
            full += chunk;
            sse(res, 'delta', { t: chunk });
            if (full.length >= config.maxChars) break;
          }
        }
      }
      const parsed = parseReplyText(full);
      const emotion = parsed.emotion || emotionFromKeywords(parsed.reply);
      // B2①：用户显式说「记住…」⇒ 立刻写记忆（只存结论）
      if (config.memoryEnabled) {
        const explicit = parseExplicitMemory(text);
        if (explicit) rememberExplicit(readMemory(), explicit);
      }
      memory.push({ role: 'user', content: text });
      memory.push({ role: 'assistant', content: parsed.reply });
      turnCount += 1;
      // B2②：每 N 轮让模型吐一次摘要 ⇒ 合并去重（不覆盖显式项）
      if (config.memoryEnabled && turnCount % config.memoryEveryTurns === 0) {
        const merged = await summarizeMemory(config, memory.slice(-config.maxTurns));
        if (merged) lastMemoryAt = Date.now();
      }
      if (memory.length > MAX_MEMORY_TURNS * 2) memory = memory.slice(-MAX_MEMORY_TURNS * 2);
      done(emotion, { chars: parsed.reply.length });
    } catch (error) {
      if (error && error.name === 'AbortError') fail('timeout', '模型 20 秒没回应，再试一次');
      else fail('bad-request', '连不上模型端点，检查设置里的地址');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * B2②：让模型对最近几轮做一次**偏好提炼**（非流式，独立请求）。
   * 失败一律吞掉（记忆是加分项，不能因为它把聊天弄挂）。
   */
  async function summarizeMemory(config, history) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const headers = { 'content-type': 'application/json' };
      if (config.provider === 'openai' && config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const url = config.provider === 'ollama' ? `${config.baseUrl}/api/chat` : `${config.baseUrl}/chat/completions`;
      const body = {
        model: config.model,
        stream: false,
        messages: [{ role: 'system', content: MEMORY_SUMMARY_PROMPT }, ...history],
      };
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return null;
      const doc = await response.json();
      const content = config.provider === 'ollama'
        ? (doc && doc.message && doc.message.content)
        : (doc && doc.choices && doc.choices[0] && doc.choices[0].message && doc.choices[0].message.content);
      if (typeof content !== 'string') return null;
      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}');
      if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
      const summary = JSON.parse(content.slice(jsonStart, jsonEnd + 1));
      return mergeSummary(readMemory(), summary);
    } catch {
      return null;
    }
  }

  /** C3：主动说话的内容（≤40 字；基于时间 + 记忆里的偏好，不做随机废话）。 */
  function proactiveLine(now) {
    const mem = readMemory();
    const hour = new Date(now).getHours();
    const like = Array.isArray(mem.likes) && mem.likes.length ? mem.likes[0] : '';
    const lines = hour >= 23 || hour < 6
      ? ['夜深了，早点休息。', '我先趴一会儿，晚安。']
      : (like
        ? [`今天还在看${like}相关的壁纸吗？`, `要不要换一张${like}的？`]
        : ['桌面看累了吧，换一张？', '要不要试试轮播？', '我在这儿，陪你待会儿。']);
    return lines[Math.floor(Math.random() * lines.length)].slice(0, 40);
  }

  /** C2：客户端问"现在能主动说话吗"。五条件全过才 ok，且 ok 时立刻记一条。 */
  async function handleProactiveTick(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const config = readPetChat();
    const decision = canSpeak({
      enabled: config.proactiveEnabled === true,
      dailyLimit: config.proactiveDailyLimit,
      minGapMin: config.proactiveMinGapMin,
      quietHours: config.quietHours || QUIET_HOURS_DEFAULT,
      idleMinutes: Number(body.idleMinutes) || 0,
      fullscreen: body.fullscreen === true,
      focused: body.focused !== false,
      randomHit: body.randomHit !== false,
    });
    let line = null;
    if (decision.ok) {
      markSaid();
      line = proactiveLine(Date.now());
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: decision.ok, reason: decision.reason, line, usage: todayUsage(Date.now(), config.proactiveDailyLimit) }));
  }

  function handleReset2(res) {
    skipToday();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
  }

  function handleReset(res) {
    clearMemory();
    memory = [];
    lastError = null;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
  }

  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/pet-chat`,
    handler: (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const tail = url.pathname.slice(`${BASE}/pet-chat`.length).replace(/\/+$/, '');
      const method = (req.method || 'GET').toUpperCase();
      if (tail === '/state' && (method === 'GET' || method === 'HEAD')) { handleState(res); return; }
      if (tail === '/models' && (method === 'GET' || method === 'HEAD')) { handleModels(res); return; }
      if (tail === '/chat' && method === 'POST') { handleChat(req, res); return; }
      if (tail === '/reset' && method === 'POST') { handleReset(res); return; }
      if (tail === '/proactive' && (method === 'GET' || method === 'HEAD')) {
        const config = readPetChat();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, enabled: config.proactiveEnabled === true, usage: todayUsage(Date.now(), config.proactiveDailyLimit) }));
        return;
      }
      if (tail === '/memory' && (method === 'GET' || method === 'HEAD')) {
        // B4：给气泡的「查看记忆」用 —— 只回偏好摘要，不含任何聊天原文
        const memory = readMemory();
        const line = memoryPromptLine(memory);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, memory, line, enabled: readPetChat().memoryEnabled !== false }));
        return;
      }
      if (tail === '/proactive/tick' && method === 'POST') { handleProactiveTick(req, res); return; }
      if (tail === '/proactive/skip' && method === 'POST') { handleReset2(res); return; }
      res.statusCode = 404;
      res.end('not found');
    },
  }));
}

