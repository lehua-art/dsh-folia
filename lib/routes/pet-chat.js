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
// `speechToText`：DSH 宿主的转写服务（`ctx.speechToText`）。它可能**不存在**（用户没启用
// 「语音输入」实验特性）—— 那种情况由路由回 `asr-not-ready`，而不是启动失败。
// `edgeTts`：在线情感朗读的合成函数（判据注入假 transport；生产为 undefined ⇒ 用默认实现）。
export const DEPS = ['disposers', 'base', 'log', 'readSettings', 'speechToText', 'edgeTts'];

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  readMemory, writeMemory, clearMemory, parseExplicitMemory, rememberExplicit,
  mergeSummary, memoryPromptLine, MEMORY_SUMMARY_PROMPT,
} from '../pet-chat-memory.js';
import { synthesize as edgeSynthesize } from '../pet-chat-edge-tts.js';
// v0.1：旧键迁移与默认值只在 settings-schema 定义一次，路由复用同一个函数
import { readPetChat as normalizePetChat } from '../settings-schema.js';
// v0.1「零配置」主动搭话：固定策略 + 语音指令静默（追加决定 1/2）
import {
  canSpeak, markSaid, buildProactiveLine, readProactiveState, todayUsage, isSilent,
  enterSilence, clearSilence, parseSilenceCommand, PROACTIVE_RULES,
} from '../pet-chat-proactive.js';

/** 单次输入上限（工单：≤400 字）。 */
const MAX_INPUT_CHARS = 400;
/** 模型调用超时（工单：20s）。 */
const TIMEOUT_MS = 20000;
/** 同一来源的最小间隔（工单：1 次/秒）。 */
const RATE_LIMIT_MS = 1000;
/** 会话记忆最多保留的轮数（一轮 = 一问一答）。 */
const MAX_MEMORY_TURNS = 12;

/**
 * 上下文轮数 / 单条字数上限（v0.1 起不再暴露给用户）。
 *
 * 为什么从设置里拿掉：工单 §4「解耦」与 §5「默认值只在 settings-schema 定义一次」——
 * 这两项属于实现细节，用户只需要"填 key、选音色、起名字"。留在设置里只会让
 * 配置面板变成一长串旋钮（旧版本正是因为这点被推翻的）。
 */
const DEFAULT_MAX_TURNS = 8;
const DEFAULT_MAX_CHARS = 80;
/** 每 N 轮写一次记忆摘要。 */
const DEFAULT_MEMORY_EVERY_TURNS = 10;

/* ── 语音转写（PET-CHAT-ROUND-NEXT 之后的一轮）────────────────────────────── */
/** 单段音频上限：15 秒（16kHz 单声道 PCM16 ≈ 480KB）。 */
const ASR_MAX_SECONDS = 15;
/** 单段音频字节上限：2MB（工单 B 的硬约束）。 */
const ASR_MAX_BYTES = 2 * 1024 * 1024;
/** 同一来源的转写最小间隔：1 次 / 2 秒。 */
const ASR_RATE_LIMIT_MS = 2000;
/** 转写超时：模型推理可能要几秒，给 20s。 */
const ASR_TIMEOUT_MS = 20000;
/** edge-tts 超时（在线合成，给宽一点）。 */
const EDGE_TIMEOUT_MS = 15000;
/** DSH 语音输入 bundle 注册的本地 provider id（契约见 docs/ASR-INTEGRATION.md）。 */
const ASR_PROVIDER_ID = 'sensevoice-local';
/** 转写语言（本功能只做中文；要别的语种先改契约）。 */
const ASR_LANGUAGE = 'zh';
/** 未就绪时给用户的一句话（两条路径共用，避免文案漂移）。 */
const ASR_NOT_READY_HINT = '请在 DSH 设置启用语音输入（需下载模型）';

/**
 * 解析 16kHz 单声道 PCM16 WAV 的时长（秒）。
 *
 * 为什么自己解析而不是看 `content-length`：15 秒的上限是**时长**约束，
 * 而 44.1kHz 立体声的 15 秒会是 2.6MB —— 只看字节数会把合法的短音频挡掉。
 * 只认 `RIFF/WAVE` + `fmt ` + `data` 三块；不是 WAV 就返回 null（调用方回 400）。
 */
export function wavSeconds(bytes) {
  if (!bytes || bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataBytes = Math.min(size, bytes.byteLength - body);
      break;
    }
    offset = body + size + (size % 2);
    if (size <= 0) break;
  }
  if (!sampleRate || !channels || !bits || !dataBytes) return null;
  const bytesPerFrame = channels * (bits / 8);
  if (!bytesPerFrame) return null;
  const seconds = dataBytes / (sampleRate * bytesPerFrame);
  return Number.isFinite(seconds) ? seconds : null;
}

/** base64 → Uint8Array（浏览器与 Node 都能用；Node 走 Buffer 分支）。 */
export function decodeBase64(text) {
  const clean = String(text || '');
  if (!clean) return new Uint8Array(0);
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 各 provider 的默认端点 / 默认模型（设置里 baseUrl / model 为空时用）。 */
const PROVIDER_DEFAULTS = {
  // Ollama 的 OpenAI 兼容前缀是 /v1（少了它 /chat/completions 会 404）
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
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
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        // 超限**只丢数据、不断连接**：`req.destroy()` 会让客户端拿到 ECONNRESET，
        // 浏览器那边表现成 "fetch failed"，看起来像服务器崩了 —— 其实是我们主动拒的。
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) { reject(Object.assign(new Error('body-too-large'), { code: 'bad-request' })); return; }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch { reject(Object.assign(new Error('bad-json'), { code: 'bad-request' })); }
    });
    req.on('error', reject);
  });
}

/** 读原始请求体（音频；超过上限直接拒绝）。 */
function readRawBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) { reject(Object.assign(new Error('body-too-large'), { code: 'bad-request' })); return; }
      resolve(new Uint8Array(Buffer.concat(chunks)));
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
  const { disposers, base: BASE, log, readSettings, speechToText, edgeTts } = c;

  /** 当前进程内的会话记忆（重启即忘；`/reset` 清空）。 */
  let memory = [];
  /** 轮次计数（摘要触发用）与最近一次摘要时间。 */
  let turnCount = 0;
  let lastMemoryAt = 0;
  /** 同一来源的最近一次请求时间（限频）。 */
  const lastAt = new Map();
  /** 转写限频（1 次 / 2 秒）：同一来源一张表。 */
  const asrLastAt = new Map();
  /** edge-tts 失败只记一次日志（工单：不刷屏）。 */
  let edgeFallbackLogged = false;
  /** 最近一次失败原因（`/state` 里回给界面）。 */
  let lastError = null;

  /**
   * 面板保存的覆盖层（`<DSH_FOLIA_HOME>/pet-chat/settings.json`）。
   *
   * 为什么不用 DSH 的设置服务：插件这边只拿到了 `readSettings`（只读），没有写入口；
   * 桌宠面板又必须能改（开启对话 / 换模型 / 填 key 都在这里）。所以沿用 `/pets/config`
   * 的做法，用一个插件自己的配置文件当**覆盖层**：
   *   · 读：schema 默认值 → DSH 设置 → 本文件（后者优先）
   *   · 写：只写本文件，不动 DSH 的设置档
   * 好处是面板保存立刻生效、且插件卸载时删掉文件就回到 DSH 设置。
   */
  function overlayPath() {
    const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
    return join(base, 'pet-chat', 'settings.json');
  }

  function readOverlay() {
    try {
      const file = overlayPath();
      if (!existsSync(file)) return null;
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      return doc && typeof doc === 'object' ? doc : null;
    } catch { return null; }
  }

  function writeOverlay(patch) {
    const file = overlayPath();
    const current = readOverlay() || {};
    const next = { ...current, ...patch };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2));
    return next;
  }

  /** 读当前 petChat 配置（每次现读：设置面板改完立刻生效，不用重启）。 */
  function readPetChat() {
    let settings = null;
    try { settings = readSettings(); } catch (error) {
      // 读设置失败不能让整条链路炸：当作默认（关）
      log('[pet-chat] 读设置失败：' + String((error && error.message) || error));
    }
    const schemaRaw = settings && typeof settings === 'object' && settings.petChat && typeof settings.petChat === 'object'
      ? settings.petChat : {};
    // 旧键映射只写一处：settings-schema 的 readPetChat 同时负责"默认值 + 迁移"
    const normalized = normalizePetChat({ ...schemaRaw, ...(readOverlay() || {}) });
    const provider = normalized.provider === 'openai' ? 'openai' : 'ollama';
    const defaults = PROVIDER_DEFAULTS[provider];
    const baseUrl = typeof normalized.baseUrl === 'string' && normalized.baseUrl.trim() ? normalized.baseUrl.trim() : defaults.baseUrl;
    return {
      enabled: normalized.enabled === true,
      provider,
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: normalized.apiKey,
      model: typeof normalized.model === 'string' && normalized.model.trim() ? normalized.model.trim() : defaults.model,
      // v0.1 设置收敛：名字两项 + 音色两项 + 唤醒三项，其余（轮数/字数）是代码常量
      petName: normalized.petName,
      ownerName: normalized.ownerName,
      voice: normalized.voice,
      wake: normalized.wake,
      // 记忆常开（零配置）：设置里没有开关
      memoryEnabled: true,
      // 实现细节：不再暴露给用户，也不再从设置里读
      maxTurns: DEFAULT_MAX_TURNS,
      maxChars: DEFAULT_MAX_CHARS,
      // 内部旋钮：不进 UI，但保留可配置（测试与排障用）
      memoryEveryTurns: (() => {
        const raw = Number((readOverlay() || {}).memoryEveryTurns ?? schemaRaw.memoryEveryTurns);
        return Number.isFinite(raw) && raw > 0 ? Math.min(50, raw) : DEFAULT_MEMORY_EVERY_TURNS;
      })(),
    };
  }

  /** 组装请求体（两种协议各一份；都只发到配置里的端点）。 */
  function buildRequest(config, text) {
    // v0.1：人设不再是一长串设置，只有"名字 / 主人称呼"两项；风格走内置文案
    const petName = config.petName || 'Folia';
    const ownerName = config.ownerName ? `，称呼用户为「${config.ownerName}」` : '';
    let system = `你是${petName}${ownerName}，元气、短句、偶尔颜文字、不说教；`
      + '你的特点：喜欢壁纸和游戏，被夸会害羞。'
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
      // v0.1：语音输入开关随设置收敛去掉（能力由 DSH 决定）；语音/名字照旧回给客户端
      petName: config.petName,
      ownerName: config.ownerName,
      voice: config.voice,
      memoryEnabled: config.memoryEnabled,
      asrProvider: ASR_PROVIDER_ID,
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

    /**
     * 语音/打字指令：**说"别说了"就静默**（到次日 0 点），说"可以说话了"就恢复。
     * 这是「零配置」里用户唯一的控制方式（追加决定 2），所以在这里拦一道，
     * 命中就不调模型（省 token，也让响应立刻生效）。
     */
    const command = parseSilenceCommand(text);
    if (command === 'silence') {
      enterSilence();
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      sse(res, 'delta', { t: '好，那我安静一会儿。' });
      sse(res, 'done', { emotion: 'calm', command: 'silence' });
      res.end();
      return;
    }
    if (command === 'resume') {
      clearSilence();
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      sse(res, 'delta', { t: '好，我回来了。' });
      sse(res, 'done', { emotion: 'happy', command: 'resume' });
      res.end();
      return;
    }

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


  /**
   * POST /pet-chat/transcribe —— 把一段 WAV 交给 DSH 宿主的转写服务。
   *
   * 为什么不在插件里带模型：DSH 已经有 `ctx.speechToText`（provider 自己下载并校验模型）。
   * 插件这边只做「收音频 → 校验 → 转发 → 回文本」四件事，序列化与推理都不碰。
   *
   * 返回（**一律 200**，除参数不合法）：
   *   · 成功     `{ ok:true, text, audioSeconds, inferenceSeconds }`
   *   · 未就绪   `{ ok:false, code:'asr-not-ready', hint:'请在 DSH 设置启用语音输入（需下载模型）' }`
   *   · 超时取消 `{ ok:false, code:'asr-timeout' }`
   * 参数不合法（超长/超大/不是 WAV）走 400 `bad-request` —— 那是客户端 bug，不是环境问题。
   */
  async function handleTranscribe(req, res) {
    const ip = sourceOf(req);
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };

    // 两种入参：JSON `{audio: base64, language}` 或原始 WAV 体（content-type: audio/wav）
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    let audio;
    let language = 'zh';
    try {
      if (contentType.includes('audio/')) {
        audio = new Uint8Array(await readRawBody(req, ASR_MAX_BYTES + 1));
      } else {
        const body = await readJsonBody(req, ASR_MAX_BYTES + 4096);
        if (typeof body.audio === 'string') audio = decodeBase64(body.audio);
        else if (Array.isArray(body.audio)) audio = Uint8Array.from(body.audio);
        else audio = new Uint8Array(0);
        if (typeof body.language === 'string' && body.language) language = body.language.slice(0, 8);
      }
    } catch {
      send({ ok: false, code: 'bad-request', hint: '请求体不是合法的 JSON / 音频' }, 400);
      return;
    }

    if (!audio || !audio.byteLength) { send({ ok: false, code: 'bad-request', hint: '音频为空' }, 400); return; }
    if (audio.byteLength > ASR_MAX_BYTES) { send({ ok: false, code: 'bad-request', hint: '音频超过 2MB' }, 400); return; }
    const seconds = wavSeconds(audio);
    if (seconds === null) { send({ ok: false, code: 'bad-request', hint: '只接受 16kHz 单声道 PCM16 WAV' }, 400); return; }
    if (seconds > ASR_MAX_SECONDS) {
      send({ ok: false, code: 'bad-request', hint: `单段最多 ${ASR_MAX_SECONDS} 秒（这段 ${seconds.toFixed(1)} 秒）` }, 400);
      return;
    }

    // 参数都合法了才计入限频：坏请求不占配额
    const lastAtMs = asrLastAt.get(ip) || 0;
    const nowMs = Date.now();
    if (nowMs - lastAtMs < ASR_RATE_LIMIT_MS) {
      send({ ok: false, code: 'rate-limited', hint: '2 秒内最多转写一次' });
      return;
    }
    asrLastAt.set(ip, nowMs);

    // ① 服务可能压根没装（用户没启用「语音输入」实验特性）
    const service = speechToText;
    if (!service || typeof service.snapshot !== 'function' || typeof service.transcribe !== 'function') {
      send({ ok: false, code: 'asr-not-ready', hint: ASR_NOT_READY_HINT });
      return;
    }

    // ② 服务装了，但 provider 没就绪（没下载 / 正在下 / 加载失败）——用快照判断，不要靠 try/catch 猜
    let phase = 'missing';
    try {
      const snapshot = service.snapshot();
      const provider = (snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [])
        .find((item) => item && item.id === ASR_PROVIDER_ID);
      phase = provider && provider.preparation ? provider.preparation.phase : 'missing';
    } catch (error) {
      log('[pet-chat] speechToText.snapshot 失败：' + String((error && error.message) || error));
      phase = 'missing';
    }
    if (phase !== 'ready') {
      send({
        ok: false,
        code: 'asr-not-ready',
        hint: phase === 'missing'
          ? ASR_NOT_READY_HINT
          : `${ASR_NOT_READY_HINT}（当前状态：${phase}）`,
        phase,
      });
      return;
    }

    // ③ 就绪：resolve 出 provider-pinned spec，再执行
    let spec;
    try {
      spec = service.resolve({ audio, language: ASR_LANGUAGE, providerId: ASR_PROVIDER_ID });
    } catch (error) {
      send({ ok: false, code: 'asr-not-ready', hint: ASR_NOT_READY_HINT });
      log('[pet-chat] speechToText.resolve 失败：' + String((error && error.message) || error));
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASR_TIMEOUT_MS);
    try {
      const transcript = await service.transcribe(spec, controller.signal);
      send({
        ok: true,
        text: String((transcript && transcript.text) || ''),
        audioSeconds: Number((transcript && transcript.audioSeconds) || seconds),
        inferenceSeconds: Number((transcript && transcript.inferenceSeconds) || 0),
      });
    } catch (error) {
      const aborted = controller.signal.aborted || (error && error.name === 'AbortError');
      send(aborted
        ? { ok: false, code: 'asr-timeout', hint: '转写超时，再试一次' }
        : { ok: false, code: 'asr-failed', hint: '转写失败，可以改用打字' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Uint8Array → base64（Node 与 Worker 都能用）。 */
  function toBase64(bytes) {
    if (!bytes || !bytes.byteLength) return '';
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  /**
   * POST /pet-chat/speak —— **朗读**.的宿主侧。
   *
  /**
   * 设置面板用的读写接口。
   *
   * GET  /pet-chat/config  回完整配置（apiKey 只回掩码 + hasApiKey）
   * POST /pet-chat/config  保存（写覆盖层；provider=ollama 时强制默认地址、清空 key）
   * POST /pet-chat/test    真连一次 provider，失败给具体原因（401/402/超时/地址错）
   * DELETE /pet-chat/memory 只清记忆，不动对话与设置
   */
  async function handleConfigGet(res) {
    const config = readPetChat();
    const key = String(config.apiKey || '');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: true,
      data: {
        enabled: config.enabled === true,
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKeyMasked: key ? `${key.slice(0, 3)}${'•'.repeat(Math.max(4, Math.min(16, key.length - 7)))}${key.slice(-4)}` : '',
        hasApiKey: Boolean(key),
        petName: config.petName,
        ownerName: config.ownerName,
        voice: config.voice,
        wake: config.wake,
      },
    }));
  }

  async function handleConfigPost(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    let body = {};
    try { body = await readJsonBody(req); } catch { send({ ok: false, error: 'bad-json' }, 400); return; }

    const provider = body.provider === 'openai' ? 'openai' : 'ollama';
    const defaults = PROVIDER_DEFAULTS[provider];
    const patch = { provider };

    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (provider === 'ollama') {
      // 本机 Ollama：地址固定默认、key 不用（避免 UI 上还留着上一家的 key）
      patch.baseUrl = defaults.baseUrl;
      patch.apiKey = '';
    } else {
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) patch.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
      if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
    }
    if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
    // v0.1：只接受新结构的名字 / 音色 / 唤醒 / 记忆；旧字段（persona/maxTurns/voiceOut/voiceEngine）一律忽略
    if (typeof body.petName === 'string') patch.petName = body.petName.trim().slice(0, 24);
    if (typeof body.ownerName === 'string') patch.ownerName = body.ownerName.trim().slice(0, 24);
    if (body.voice && typeof body.voice === 'object') {
      patch.voice = {
        name: String(body.voice.name || 'zh-CN-XiaoxiaoNeural').slice(0, 120),
        muted: body.voice.muted === true,
      };
    }
    if (body.wake && typeof body.wake === 'object') {
      patch.wake = {
        click: body.wake.click !== false,
        name: body.wake.name === true,
        keyword: String(body.wake.keyword || '').trim().slice(0, 40),
      };
    }

    writeOverlay(patch);
    const config = readPetChat();
    send({
      ok: true,
      data: { saved: true, enabled: config.enabled, provider: config.provider, baseUrl: config.baseUrl, model: config.model },
    });
  }

  /** 真连一次 provider：失败要说清是 401 / 402 / 超时 / 地址错。 */
  async function handleConfigTest(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const config = readPetChat();
    const baseUrl = String(body.baseUrl || config.baseUrl || '').replace(/\/+$/, '');
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : config.apiKey;
    const provider = body.provider === 'openai' ? 'openai' : (body.provider === 'ollama' ? 'ollama' : config.provider);
    if (!baseUrl) { send({ ok: false, code: 'no-base-url', message: '接口地址为空' }); return; }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        send({ ok: false, code: 'unauthorized', status: response.status, message: 'API Key 无效或没有权限（401）' });
        return;
      }
      if (response.status === 402) { send({ ok: false, code: 'no-balance', status: 402, message: '账号余额不足（402）' }); return; }
      if (!response.ok) {
        send({ ok: false, code: 'http', status: response.status, message: `服务返回 ${response.status}` });
        return;
      }
      send({ ok: true, provider, baseUrl, models: 'reachable' });
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = String((error && error.message) || error);
      send({
        ok: false,
        code: aborted ? 'timeout' : (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message) ? 'dns' : 'network'),
        message: aborted ? '连接超时（8 秒）' : (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message) ? '地址解析失败，检查接口地址' : `网络错误：${message.slice(0, 80)}`),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 主动搭话（v0.1 零配置）：客户端周期性问一次"现在能说吗"，策略全在服务端。
   * 返回 `{ ok, reason, line }`；命中就立刻记账（节奏与当日上限都靠它）。
   */
  async function handleProactiveTick(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const decision = canSpeak({
      idleMinutes: Number(body.idleMinutes) || 0,
      fullscreen: body.fullscreen === true,
      randomHit: body.randomHit !== false,
    });
    let line = null;
    if (decision.ok) {
      const state = readProactiveState();
      const built = buildProactiveLine({
        wallpaperTitle: body.wallpaperTitle,
        memory: readMemory(),
        usedLines: state.usedLines,
      });
      markSaid(Date.now(), built.line);
      line = built.line;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: decision.ok, reason: decision.reason, line, usage: todayUsage() }));
  }

  /** 手动静默（设置页的「暂时不说话」用；语音指令走 handleChat 里的解析）。 */
  async function handleSilence(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const silent = body.silent !== false;
    if (silent) enterSilence(); else clearSilence();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, silent }));
  }

  /**
   * 朗读（v0.1）：**只有一档引擎** —— edge 在线情感音色；失败自动回落系统音色。
   *
   * 为什么没有 system/edge 开关了：工单 §0「不做朗读引擎手动切换（改为自动回落）」。
   * `voice.muted` 是唯一的开关（右键菜单的「静音」写它）。
   */
  async function handleSpeak(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    let body = {};
    try { body = await readJsonBody(req); } catch { send({ ok: false, code: 'bad-request', hint: '请求体不是合法 JSON' }, 400); return; }
    const text = String(body.text || '').trim();
    const emotionRaw = String(body.emotion || 'calm');
    const emotion = ['happy', 'tired', 'angry', 'calm'].includes(emotionRaw) ? emotionRaw : 'calm';
    if (!text) { send({ ok: false, code: 'bad-request', hint: '文本为空' }, 400); return; }
    if (text.length > 400) { send({ ok: false, code: 'bad-request', hint: '一次最多 400 字' }, 400); return; }

    const config = readPetChat();
    // 静音：连网络都不碰
    if (config.voice.muted === true) { send({ ok: false, code: 'voice-muted', hint: '已静音' }); return; }

    try {
      const synth = typeof edgeTts === 'function' ? edgeTts : edgeSynthesize;
      const result = await synth({
        text,
        emotion,
        voice: config.voice.name,
        timeoutMs: EDGE_TIMEOUT_MS,
      });
      send({ ok: true, engine: 'edge', mime: result.mime || 'audio/mpeg', style: result.style || null, audio: toBase64(result.audio) });
    } catch (error) {
      // ③ 失败回落 system；日志**只记一次**（不刷屏、不弹窗）
      if (!edgeFallbackLogged) {
        edgeFallbackLogged = true;
        log('[pet-chat] edge-tts 失败，回落系统语音：' + String((error && error.message) || error));
      }
      send({ ok: true, engine: 'system', fallback: 'edge-failed', style: null });
    }
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
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const tail = url.pathname.slice(`${BASE}/pet-chat`.length).replace(/\/+$/, '');
      const method = (req.method || 'GET').toUpperCase();
      if (tail === '/state' && (method === 'GET' || method === 'HEAD')) { handleState(res); return; }
      if (tail === '/config' && (method === 'GET' || method === 'HEAD')) { await handleConfigGet(res); return; }
      if (tail === '/config' && method === 'POST') { await handleConfigPost(req, res); return; }
      if (tail === '/test' && method === 'POST') { await handleConfigTest(req, res); return; }
      if (tail === '/models' && (method === 'GET' || method === 'HEAD')) { handleModels(res); return; }
      if (tail === '/chat' && method === 'POST') { handleChat(req, res); return; }
      if (tail === '/reset' && method === 'POST') { handleReset(res); return; }
      if (tail === '/transcribe' && method === 'POST') { handleTranscribe(req, res); return; }
      if (tail === '/speak' && method === 'POST') { handleSpeak(req, res); return; }
      // v0.1「零配置」主动搭话：没有开关，只有内部策略 + 语音指令静默
      if (tail === '/proactive' && (method === 'GET' || method === 'HEAD')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, usage: todayUsage(), silent: isSilent(), rules: PROACTIVE_RULES }));
        return;
      }
      if (tail === '/proactive/tick' && method === 'POST') { await handleProactiveTick(req, res); return; }
      if (tail === '/silence' && method === 'POST') { await handleSilence(req, res); return; }
      if (tail === '/memory' && (method === 'GET' || method === 'HEAD')) {
        // B4：给气泡的「查看记忆」用 —— 只回偏好摘要，不含任何聊天原文
        const memory = readMemory();
        const line = memoryPromptLine(memory);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, memory, line, enabled: true }));
        return;
      }
      if (tail === '/memory' && method === 'DELETE') {
        // 面板的「清空记忆」：只清偏好记忆，不动对话历史、不动设置
        clearMemory();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, cleared: true }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    },
  }));
}

