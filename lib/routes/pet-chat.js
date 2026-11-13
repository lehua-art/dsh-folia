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
export const DEPS = ['disposers', 'base', 'log', 'readSettings', 'speechToText'];
/** 可选注入：判据可以传一个假的 TTS 服务（默认由本族自建）。 */
export const OPTIONAL_DEPS = ['tts'];

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTtsService, normalizeTtsText, TTS_MAX_CHARS } from '../tts/tts.js';

import {
  readMemory, writeMemory, clearMemory, parseExplicitMemory, rememberExplicit,
  mergeSummary, memoryPromptLine, MEMORY_SUMMARY_PROMPT,
} from '../pet-chat-memory.js';
// v0.1：旧键迁移与默认值只在 settings-schema 定义一次，路由复用同一个函数
import { readPetChat as normalizePetChat } from '../settings-schema.js';
import { createVoiceRecorder, defaultResolveFfmpeg, defaultRunFfmpeg } from '../voice/record.js';
// 本地 STT：资源不下发到 npm 包，首次使用时从站点 R2 下载（见 lib/asr/asr-local.js）
import { ensureInstalled as ensureAsrInstalled, startWorker as startAsrWorker } from '../asr/asr-local.js';
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
/** DSH 语音输入 bundle 注册的本地 provider id（契约见 docs/ASR-INTEGRATION.md）。 */
const ASR_PROVIDER_ID = 'sensevoice-local';
/** 转写语言（本功能只做中文；要别的语种先改契约）。 */
const ASR_LANGUAGE = 'zh';
/** 未就绪时给用户的一句话（两条路径共用，避免文案漂移）。 */
const ASR_NOT_READY_HINT = '语音输入还没就绪：模型还没下载好，稍等一下';

/* ── 本地 STT 运行时（自带 SenseVoice，不依赖 DSH 的语音实验包）─────────────── */
/**
 * 安装根：`~/.dsh-folia/asr/v1`。
 * 首次点桌宠说话时从站点下载（约 340MB；node.exe 复用 tts 包），之后完全离线。
 */
const ASR_ROOT = process.env.FOLIA_ASR_ROOT || join(homedir(), '.dsh-folia', 'asr', 'v1');
/** 下载/就绪状态（GET /pet-chat/asr 直接回它）。 */
let asrState = { phase: 'idle', doneBytes: 0, totalBytes: 0, error: null };
/** worker 实例（懒启动，常驻）。 */
let asrWorker = null;
/** 正在进行的安装任务（并发点击 join 同一个 Promise）。 */
let asrInstallPromise = null;

/** 本地运行时是否已经装在盘上（不下载、只探测）。 */
function asrInstalledOnDisk() {
  try {
    return existsSync(join(ASR_ROOT, 'runtime', 'asr-worker.cjs'))
      && existsSync(join(ASR_ROOT, 'runtime', 'node.exe'))
      && existsSync(join(ASR_ROOT, 'models', 'sensevoice', 'tokens.txt'));
  } catch { return false; }
}

/**
 * 确保本地 STT 可用：装包 → 启 worker。返回 worker；失败抛错并记 asrState.failed。
 * 幂等：并发调用共享同一个安装 Promise。
 */
function ensureLocalAsr() {
  if (asrWorker) return Promise.resolve(asrWorker);
  if (asrInstallPromise) return asrInstallPromise;
  asrInstallPromise = (async () => {
    if (!asrInstalledOnDisk()) {
      asrState = { phase: 'downloading', doneBytes: 0, totalBytes: 0, error: null };
      await ensureAsrInstalled(ASR_ROOT, {
        onProgress: (p) => {
          asrState = {
            phase: 'downloading',
            doneBytes: Number(p.doneBytes) || 0,
            totalBytes: Number(p.totalBytes) || 0,
            error: null,
          };
        },
      });
    }
    asrState = { phase: 'loading', doneBytes: asrState.doneBytes, totalBytes: asrState.totalBytes, error: null };
    asrWorker = startAsrWorker(ASR_ROOT);
    asrState = { phase: 'ready', doneBytes: asrState.doneBytes, totalBytes: asrState.totalBytes, error: null };
    return asrWorker;
  })().catch((error) => {
    asrWorker = null;
    asrState = {
      phase: 'failed',
      doneBytes: asrState.doneBytes,
      totalBytes: asrState.totalBytes,
      error: String((error && error.message) || error),
    };
    asrInstallPromise = null;
    throw error;
  });
  return asrInstallPromise;
}

/** 本地 STT 是否已就绪（已装或已启动）—— 决定 /transcribe 走本地还是 DSH 服务。 */
async function localAsrReady() {
  if (asrWorker) return true;
  return asrInstalledOnDisk();
}

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
  const { disposers, base: BASE, log, readSettings, speechToText, tts: injectedTts } = c;

  /** 宿主侧录音器：**必须在这里实例化** —— 只 import 不 new，/record 会抛
   *  ReferenceError: voiceRecorder is not defined（P6 实锤）。 */
  const voiceRecorder = createVoiceRecorder({
    resolveFfmpeg: defaultResolveFfmpeg,
    runFfmpeg: defaultRunFfmpeg,
  });

  /**
   * 朗读服务（P1）：SAPI 优先 → Edge/OneCore 系统音色 → 明确错误。
   * 懒启动 worker：**注册路由时不 spawn**，第一次点桌宠说话才起（不拖慢插件启动）。
   * `c.tts` 只给判据注入假实现用，正式装配点不传。
   */
  const ttsService = injectedTts || createTtsService({
    log: (line) => log('[pet-chat] ' + line),
    cacheDir: join(process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia'), 'tts', 'cache'),
  });

  /** 反向通道：工作联动（待办/提醒）通过 `/speak` 向桌宠客户端广播一句话。 */
  const speakClients = new Set();
  const pendingSpeaks = [];
  const PENDING_SPEAK_MAX = 5;

  /** 当前进程内的会话记忆（重启即忘；`/reset` 清空）。 */
  let memory = [];
  /** 轮次计数（摘要触发用）与最近一次摘要时间。 */
  let turnCount = 0;
  let lastMemoryAt = 0;
  /** 同一来源的最近一次请求时间（限频）。 */
  const lastAt = new Map();
  /** 转写限频（1 次 / 2 秒）：同一来源一张表。 */
  const asrLastAt = new Map();
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
    + '直接说人话，不要输出 JSON、不要加前缀、不要解释格式。';
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
    // 本地 STT 优先：收到的是 WAV 字节 ⇒ 落临时文件交给 worker 识别
    if (await localAsrReady()) {
      try {
        const dir = mkdtempSync(join(tmpdir(), 'folia-asr-'));
        const wavPath = join(dir, 'input.wav');
        writeFileSync(wavPath, Buffer.from(audio));
        const worker = await ensureLocalAsr();
        const spoken = await worker.request(wavPath, ASR_TIMEOUT_MS);
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        if (!spoken || !spoken.ok) { send({ ok: false, code: 'asr-failed', hint: '识别失败，再试一次' }, 502); return; }
        const text = String(spoken.text || '').trim();
        if (!text) { send({ ok: false, code: 'no-speech', hint: '没听清，再说一次' }, 422); return; }
        send({ ok: true, text, ms: spoken.ms, seconds });
        return;
      } catch {
        // 落到下面的 DSH 服务路径
      }
    }
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
   * 设置面板用的读写接口。
   *
   * GET  /pet-chat/config  回完整配置（apiKey 只回掩码 + hasApiKey）
   * POST /pet-chat/config  保存（写覆盖层；provider=ollama 时强制默认地址、清空 key）
   * POST /pet-chat/test    真连一次 provider，失败给具体原因（401/402/超时/地址错）
   * DELETE /pet-chat/memory 只清记忆，不动对话与设置
   */
  /**
   * POST /pet-chat/record —— 宿主侧录一段，然后走现有 speechToText 转写。
   * 前端不再碰 getUserMedia（Electron 权限只放行 clipboard/notifications）。
   */
  async function handleRecord(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const result = await voiceRecorder.record({
      maxMs: Number(body.maxMs) || undefined,
      silenceDb: body.silenceDb === undefined ? undefined : Number(body.silenceDb),
      silenceMs: Number(body.silenceMs) || undefined,
    });
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    if (!result.ok) {
      const hints = {
        'no-device': '没找到可用麦克风（检查系统录音设备或是否被其它程序占用）',
        'unsupported-platform': '这个系统不支持桌面录音，用浏览器打开 DSH 才能语音',
        'ffmpeg-missing': '缺少 ffmpeg，无法录音',
        timeout: '录音超时，再说一次',
        'no-speech': '没听到声音，再说一次或直接打字',
      };
      send({ ok: false, code: result.code, hint: hints[result.code] || '录音失败' }, result.code === 'ffmpeg-missing' ? 503 : 422);
      return;
    }
    // ── 转写：本地 SenseVoice 优先；没装/没下好 ⇒ asr-not-ready，由客户端触发下载 ──
    try {
      const worker = await ensureLocalAsr();
      const spoken = await worker.request(result.audioPath, ASR_TIMEOUT_MS);
      if (!spoken || !spoken.ok) {
        send({ ok: false, code: 'asr-failed', hint: '识别失败，再试一次或直接打字' }, 502);
        return;
      }
      const text = String(spoken.text || '').trim();
      if (!text) { send({ ok: false, code: 'no-speech', hint: '没听清，再说一次' }, 422); return; }
      send({ ok: true, text, ms: spoken.ms, audioSeconds: result.audioSeconds });
    } catch (error) {
      const message = String((error && error.message) || error);
      const notReady = /manifest|下载|ENOENT|缺少/.test(message) || asrState.phase !== 'ready';
      if (notReady) {
        send({ ok: false, code: 'asr-not-ready', hint: ASR_NOT_READY_HINT }, 422);
      } else {
        send({ ok: false, code: 'asr-failed', hint: '转写失败，重试或直接打字' }, 502);
      }
    } finally {
      try {
        const { rmSync } = await import('node:fs');
        if (result.dir) rmSync(result.dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  /**
   * GET /pet-chat/capabilities —— 「能力」页签的数据源。
   * 只读：每个条目的简介 / 用法 / 前提 / 安装命令（不做一键安装），
   * 以及本机是否已安装（扫 profile 的 node_modules）。
   */
  function handleCapabilities(res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    const profileRoot = join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'profiles', 'web');
    // ⚠️ ESM 没有 __dirname；这里只拼真实存在的位置（上一版用 __dirname 导致 400）
const roots = [
  join(profileRoot, 'node_modules'),
  join(profileRoot, 'node_modules', 'dsh-folia', 'node_modules'),
  join(profileRoot, '..', '.generations', 'live'),
];
    const findPkg = (name) => {
      for (const root of roots) {
        const f = join(root, ...name.split('/'), 'package.json');
        try {
          if (existsSync(f)) {
            const j = JSON.parse(readFileSync(f, 'utf8'));
            return { version: j.version || null };
          }
        } catch { /* ignore */ }
      }
      return null;
    };
    const catalog = [
      {
        section: 'work', name: '联网搜索', pkg: '@240xu/dsh-websearch', icon: '🔍', size: '约 0.3MB',
        summary: '让 AI 联网查资料、读网页正文，支持多个搜索后端',
        features: ['内置 11 个搜索后端（Exa / Parallel / Tavily 等）', '能抓取网页正文再总结，不只看标题', '搜索结果可以要求给出来源链接'],
        examples: ['帮我搜一下今天的 AI 新闻，给我三条带链接的', '查一下这个报错怎么解决，顺便读一下官方文档'],
        requires: '装完要在它自己的设置里填搜索 key（没有 key 装了也搜不了）',
        command: 'dsh plugin --profile web add @240xu/dsh-websearch',
      },
      {
        section: 'work', name: '文档读取', pkg: '@civilization/dsh-office-reader', icon: '📄', size: '约 0.2MB',
        summary: '读 PDF / Word / Excel（只读不修改），大文件分页/分表读取防爆上下文',
        features: ['先看结构（页数/工作表/标题大纲）再按需切片', 'PDF 可按页码区间读，Excel 可按工作表转 Markdown 表格', 'Word 可按小节标题精准提取'],
        examples: ['读一下 D:\\报告.pdf 前 5 页，总结要点', '把这个月的报表 xlsx 第 2 个 sheet 转成表格给我分析'],
        requires: '无需配置；只读，生成/修改请用 Office 相关能力',
        command: 'dsh plugin --profile web add @civilization/dsh-office-reader',
      },
      {
        section: 'work', name: '定时任务', pkg: '@aiwayds/dsh-cron', icon: '⏰', size: '约 0.2MB',
        summary: '按 cron 表达式或固定间隔自动执行任务，绑定到具体会话',
        features: ['支持标准 cron（工作日 9 点）与间隔（每 10 分钟）', '任务必须有有效期（最长 1 年），不会无限跑', '错过的时间点直接跳过，不补跑；每次触发都有记录'],
        examples: ['每天早上 9 点生成昨天的汇总，到年底为止', '每 10 分钟检查一次这个链接，异常就提醒我'],
        requires: '无需配置；任务绑会话，会话被归档任务就停',
        command: 'dsh plugin --profile web add @aiwayds/dsh-cron',
      },
      {
        section: 'work', name: 'Outlook 邮件', pkg: '@aryacode/dsh-arya-maildesk', icon: '📧', size: '约 1.2MB',
        summary: '让 AI 读、整理、回复你本机的 Outlook 邮件',
        features: ['列出未读/按条件筛选', '读取邮件正文与附件名', '起草回复（发送前会问你）'],
        examples: ['把昨天未读邮件列出来，挑重要的回', '找一下客户那封关于报价的邮件，总结要点'],
        requires: 'Windows + 本机已安装并登录 Outlook；不需要额外密钥',
        command: 'dsh plugin --profile web add @aryacode/dsh-arya-maildesk',
      },
      {
        section: 'work', name: '消息推送', pkg: '@alotop/dsh-notify-hub', icon: '🔔', size: '约 0.3MB',
        summary: '任务完成后把结果推到你手机（Bark / Telegram 等渠道）',
        features: ['支持多个推送渠道聚合', '可只推摘要或全文', '适合配合定时任务/长任务使用'],
        examples: ['这个任务跑完推我手机', '每天早上把汇总推给我'],
        requires: '要先配置推送渠道（Bark key / Telegram bot 等）',
        command: 'dsh plugin --profile web add @alotop/dsh-notify-hub',
      },
      {
        section: 'work', name: '直接改 Office 文档', pkg: '@copylee/dsh-office', icon: '📝', size: '约 1.3MB',
        summary: '在你正开着的 Word / Excel / PowerPoint 里直接改，改动实时可见',
        features: ['文件开着也能改（走 Office COM，不重写文件）', '原生公式、脚注、交叉引用、题注自动编号', '保存前会自己拼图做一次排版检查'],
        examples: ['把这份 Word 的标题改成二号字，加一张三线表', '给这份 PPT 每页补一句讲稿备注'],
        requires: 'Windows + 本机装 Office/WPS；会接管 DSH 自带 Office 技能（改变默认行为）',
        command: 'dsh plugin --profile web add @copylee/dsh-office',
      },
      {
        section: 'fun', name: 'AI 音频', pkg: 'dsh-audiogen', icon: '🎵', size: '约 1.3MB',
        summary: '生成语音 / 音乐 / 音效，支持多家云渠道与音色目录',
        features: ['文字转语音（多音色）', '音乐与音效生成', '历史记录与资源库'],
        examples: ['用温柔女声把这段话读出来', '生成一段 10 秒的轻松背景音乐'],
        requires: '要在它自己的设置里配渠道 key（OpenAI / MiniMax / ElevenLabs 等）',
        command: 'dsh plugin --profile web add dsh-audiogen',
      },
      {
        section: 'fun', name: '语音对话', pkg: 'dsh-talk', icon: '🗣️', size: '约 0.3MB',
        summary: '输入框麦克风说话 → 转文字 → 朗读回答（语音优先的会话闭环）',
        features: ['浏览器端麦克风按钮 + 中间结果', '支持浏览器语音 / FunASR / whisper.cpp', '说话即打断当前播报'],
        examples: ['点输入框旁的麦克风直接说一段话', '让它把回答读出来'],
        requires: '浏览器打开 DSH 时可用；桌面端麦克风受 DSH 权限限制（我们已有自己的语音链路）',
        command: 'dsh plugin --profile web add dsh-talk',
      },
      {
        section: 'fun', name: '交互卡片', pkg: 'dsh-genui', icon: '🧩', size: '约 0.5MB',
        summary: '让回答里直接渲染卡片 / 表格 / 表单，可点可选',
        features: ['回答内联交互组件', '适合做选择器、清单、表单', '不改变会话结构'],
        examples: ['用卡片列出三个方案让我选', '把结果做成一张表给你看'],
        requires: '无需配置',
        command: 'dsh plugin --profile web add dsh-genui',
      },
      {
        section: 'fun', name: '皮肤风格', pkg: 'dsh-dream-skin', icon: '🎨', size: '约 2.5MB',
        summary: '给 DSH 界面换一套外观主题（玻璃/配色/动效）',
        features: ['多套主题可选', '可自定义背景', '与官方皮肤机制兼容'],
        examples: ['装完在它自己的设置里挑主题', '换成深色磨砂那套'],
        requires: '可能与我们自带的皮肤中心重叠，二选一使用',
        command: 'dsh plugin --profile web add dsh-dream-skin',
      },
    ];
    const items = catalog.map((item) => {
      const hit = findPkg(item.pkg);
      return { ...item, installed: !!hit, installedVersion: hit ? hit.version : null };
    });
    send({ ok: true, items });
  }
  /**
   * GET /pet-chat/work-plugins —— 工作能力插件（聚合携带）的安装状态。
   * 只读探测（不 import 它们，坏插件不拖慢路由）：装没装 / 版本 / 要不要配置。
   */
  function handleWorkPlugins(res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    const list = [
      { id: 'office-reader', pkg: '@civilization/dsh-office-reader', label: '文档读取（PDF/Word/Excel）', needs: null },
      { id: 'cron', pkg: '@aiwayds/dsh-cron', label: '定时任务', needs: null },
      { id: 'websearch', pkg: '@240xu/dsh-websearch', label: '联网搜索', needs: '需要搜索 key（在它自己的设置里填）' },
      { id: 'maildesk', pkg: '@aryacode/dsh-arya-maildesk', label: 'Outlook 邮件', needs: '需要本机安装并登录 Outlook' },
      { id: 'notify-hub', pkg: '@alotop/dsh-notify-hub', label: '消息推送', needs: '需要配置推送渠道（Bark/Telegram 等）' },
    ];
    const profileRoot = join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'profiles', 'web');
    // ⚠️ ESM 没有 __dirname；这里只拼真实存在的位置（上一版用 __dirname 导致 400）
const roots = [
  join(profileRoot, 'node_modules'),
  join(profileRoot, 'node_modules', 'dsh-folia', 'node_modules'),
  join(profileRoot, '..', '.generations', 'live'),
];
    const findPkg = (name) => {
      for (const root of roots) {
        const f = join(root, ...name.split('/'), 'package.json');
        try {
          if (existsSync(f)) {
            const j = JSON.parse(readFileSync(f, 'utf8'));
            return { version: j.version || null, engines: j.engines || null };
          }
        } catch { /* ignore */ }
      }
      return null;
    };
    const items = list.map((item) => {
      const hit = findPkg(item.pkg);
      return { ...item, installed: !!hit, version: hit ? hit.version : null, engines: hit ? hit.engines : null };
    });
    const webAll = findPkg('@linxin666/dsh-web-all');
    send({
      ok: true,
      items,
      conflict: webAll ? { pkg: '@linxin666/dsh-web-all', version: webAll.version, note: '它自带桌宠（@linxin666/dsh-pet），会和 Folia 桌宠重叠；建议只启用一个' } : null,
    });
  }
  /**
   * GET /pet-chat/asr —— 本地 STT 运行时的状态 / 下载进度。
   * phase: idle | downloading | loading | ready | failed
   * downloading 时带 doneBytes / totalBytes（客户端用它显示"下载中 x%"）。
   */
  function handleAsrStatus(res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    if (!asrWorker && asrState.phase === 'idle' && asrInstalledOnDisk()) {
      asrState = { ...asrState, phase: 'ready' };
    }
    const total = Number(asrState.totalBytes) || 0;
    const done = Number(asrState.doneBytes) || 0;
    send({
      ok: true,
      available: true,
      engine: 'local-sensevoice',
      providerId: ASR_PROVIDER_ID,
      phase: asrState.phase,
      completedBytes: done,
      totalBytes: total,
      percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null,
      ready: asrState.phase === 'ready',
      message: asrState.error || null,
    });
  }

  /**
   * POST /pet-chat/asr —— 触发本地运行时下载（幂等；已在下载会 join 同一个任务）。
   * 用户装完插件点桌宠说话就会走这里，不需要去 DSH 设置里找任何开关。
   */
  function handleAsrPrepare(res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    ensureLocalAsr()
      .then(() => send({ ok: true, started: true, phase: 'ready', engine: 'local-sensevoice' }))
      .catch((error) => send({ ok: false, code: 'asr-prepare-failed', hint: String((error && error.message) || error) }));
  }

  /**
   * GET /pet-chat/selftest —— 语音链路自检。
   * 逐步骤返回，失败即停并把原因带出来：
   *   ffmpeg   ：能不能解析到可执行文件
   *   devices  ：能不能列出音频设备
   *   capture  ：真开麦录 2 秒，返回 wav 字节数
   *   asr      ：用运行时里的 sample.wav 跑一次识别
   */
  async function handleSelfTest(res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    const steps = {};
    try {
      const ff = await defaultResolveFfmpeg();
      steps.ffmpeg = { ok: true, path: ff };
      let devices = [];
      try { devices = await voiceRecorder.listDevices(); } catch (error) {
        steps.devices = { ok: false, error: String((error && error.message) || error) };
      }
      if (!steps.devices) {
        steps.devices = { ok: devices.length > 0, devices };
        if (devices.length > 0) {
          const dir = mkdtempSync(join(tmpdir(), 'folia-selftest-'));
          const wavPath = join(dir, 'capture.wav');
          const device = devices[0];
          const started = Date.now();
          const captured = await defaultRunFfmpeg(ff, ['-hide_banner', '-y', '-f', 'dshow', '-i', `audio=${device}`, '-ar', '16000', '-ac', '1', '-t', '2', wavPath], 15000);
          let size = 0;
          try { size = statSync(wavPath).size; } catch { size = 0; }
          steps.capture = { ok: captured.code === 0 && size > 1000, device, code: captured.code, bytes: size, ms: Date.now() - started };
          if (steps.capture.ok) {
            const worker = await ensureLocalAsr().catch(() => null);
            if (!worker) {
              steps.asr = { ok: false, error: '本地运行时未就绪' };
            } else {
              const spoken = await worker.request(wavPath, ASR_TIMEOUT_MS).catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
              steps.asr = { ok: !!(spoken && spoken.ok), text: String((spoken && spoken.text) || ''), ms: spoken && spoken.ms, error: spoken && spoken.error };
            }
          }
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }
      send({ ok: Object.values(steps).every((s) => s && s.ok), steps });
    } catch (error) {
      send({ ok: false, steps, error: String((error && error.message) || error) }, 500);
    }
  }
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

    // 合并语义：没传 provider 就保持当前值（P2：只改名字却把模型配置冲成 ollama）
    const current = readPetChat();
    const hasProvider = body.provider === 'openai' || body.provider === 'ollama';
    const provider = hasProvider ? body.provider : current.provider;
    const defaults = PROVIDER_DEFAULTS[provider];
    const patch = hasProvider ? { provider } : {};

    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (hasProvider && provider === 'ollama') {
      // 只有**显式切到** ollama 才改地址、清 key（未传 provider 时不能动）
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

  

  /* ── 朗读（P1）：合成 / 停止 / 状态 / 工作联动 ─────────────────────────────── */

  const TTS_UNAVAILABLE_HINT = '本机语音合成不可用（系统语音与 Edge 系统音色都失败了）';
  /** 最近一次 /tts 的真实结果（/tts/state 与排障用；不参与缓存）。 */
  let lastTts = null;

  /** 响应头只允许 latin1 ⇒ JSON/中文统一 URI 编码；过长截断，避免头被服务器拒绝。 */
  function ttsHeaderValue(value) {
    try {
      return encodeURIComponent(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 1200);
    } catch {
      return '';
    }
  }

  function jsonSend(res, payload, status = 200) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  }

  /** 把一句话推给所有已连上的桌宠客户端；返回送达数。 */
  function broadcastSpeak(event) {
    let delivered = 0;
    for (const client of [...speakClients]) {
      try {
        client.res.write('data: ' + JSON.stringify(event) + '\n\n');
        delivered += 1;
      } catch {
        speakClients.delete(client);
      }
    }
    return delivered;
  }

  /**
   * GET /pet-chat/tts?text=&voice=&rate= → `audio/wav`（单句；客户端按句排队）。
   * 失败一律 JSON + 明确 code：400 参数、409 已被 stop 作废、503 合成不可用。
   */
  async function handleTts(req, res, url) {
    const method = (req.method || 'GET').toUpperCase();
    const text = normalizeTtsText(url.searchParams.get('text') || '');
    if (!text) { jsonSend(res, { ok: false, code: 'bad-request', hint: 'text 为空' }, 400); return; }
    if ([...text].length > TTS_MAX_CHARS) {
      jsonSend(res, { ok: false, code: 'bad-request', hint: `一句话最多 ${TTS_MAX_CHARS} 字` }, 400);
      return;
    }
    if (method === 'HEAD') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      res.end();
      return;
    }
    const config = readPetChat();
    const voice = String(url.searchParams.get('voice') || '').trim()
      || String((config.voice && config.voice.name) || '');
    const rate = url.searchParams.get('rate');
    let result;
    try {
      result = await ttsService.synthesize(text, { voice, rate });
    } catch (error) {
      result = { ok: false, code: 'tts-unavailable', error: String((error && error.message) || error) };
    }
    const requestedVoice = String((result && result.requestedVoice) || voice || '');
    if (!result || result.ok !== true) {
      const code = (result && result.code) || 'tts-unavailable';
      const status = code === 'tts-stopped' ? 409 : (code === 'empty-text' ? 400 : 503);
      const attempts = (result && result.attempts) || [];
      lastTts = { requestedVoice, actualVoice: null, engine: null, attempts, code, at: Date.now() };
      jsonSend(res, {
        ok: false,
        code,
        requestedVoice,
        actualVoice: null,
        engine: null,
        hint: (result && result.hint) || (code === 'tts-stopped' ? '已停止' : TTS_UNAVAILABLE_HINT),
        attempts,
      }, status);
      return;
    }
    const actualVoice = String(result.voice || '');
    const attempts = result.attempts || [];
    lastTts = {
      requestedVoice,
      actualVoice,
      engine: String(result.engine || 'system'),
      attempts,
      code: null,
      cached: Boolean(result.cached),
      at: Date.now(),
    };
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(result.wav.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Folia-TTS-Engine', String(result.engine || 'system'));
    // 响应头必须是 latin1；音色名做一次 URI 编码，客户端 decodeURIComponent 还原
    res.setHeader('X-Folia-TTS-Voice', encodeURIComponent(actualVoice));
    res.setHeader('X-Folia-TTS-Requested-Voice', ttsHeaderValue(requestedVoice));
    res.setHeader('X-Folia-TTS-Attempts', ttsHeaderValue(attempts));
    res.setHeader('X-Folia-TTS-Ms', String(Number(result.ms) || 0));
    res.setHeader('X-Folia-TTS-Cached', result.cached ? '1' : '0');
    res.end(result.wav);
  }

  /** POST /pet-chat/tts/stop —— 停当前播报（幂等：没有播报也回 ok:true）。 */
  function handleTtsStop(res) {
    const stopped = typeof ttsService.stop === 'function' ? ttsService.stop() : { generation: 0 };
    jsonSend(res, { ok: true, stopped: true, generation: Number(stopped && stopped.generation) || 0 });
  }

  /** GET /pet-chat/tts/state —— 合成链状态（不触发合成）。 */
  function handleTtsState(res) {
    const status = typeof ttsService.status === 'function' ? ttsService.status() : {};
    const config = readPetChat();
    jsonSend(res, {
      ok: true,
      ...status,
      voice: config.voice,
      // pre.46：把“用户要的音色 / 上次实际用的音色 / 引擎 / 每跳原因”一起回，
      // 排障时不用再猜为什么设置没生效。
      requestedVoice: String((config.voice && config.voice.name) || ''),
      actualVoice: lastTts ? lastTts.actualVoice : null,
      engine: lastTts ? lastTts.engine : null,
      attempts: lastTts ? lastTts.attempts : [],
      lastTts,
      maxChars: TTS_MAX_CHARS,
      clients: speakClients.size,
    });
  }

  /**
   * POST /pet-chat/speak —— 工作联动通道（待办/提醒直接让桌宠说话）。
   * 没有客户端连着时最多留 5 条，等桌宠下一次连上 `/events` 补发。
   */
  async function handleSpeak(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const text = normalizeTtsText(body.text || '');
    if (!text) { jsonSend(res, { ok: false, code: 'bad-request', hint: 'text 为空' }, 400); return; }
    const config = readPetChat();
    if (config.voice && config.voice.muted) {
      jsonSend(res, { ok: true, skipped: 'muted', clients: speakClients.size });
      return;
    }
    const event = {
      type: 'speak',
      text,
      voice: String(body.voice || (config.voice && config.voice.name) || ''),
      rate: Number.isFinite(Number(body.rate)) ? Number(body.rate) : 0,
      ts: Date.now(),
    };
    const delivered = broadcastSpeak(event);
    if (!delivered) {
      pendingSpeaks.push(event);
      while (pendingSpeaks.length > PENDING_SPEAK_MAX) pendingSpeaks.shift();
    }
    jsonSend(res, { ok: true, clients: delivered, queued: pendingSpeaks.length, voice: event.voice });
  }

  /**
   * GET /pet-chat/events —— 桌宠客户端的常驻反向通道（SSE）。
   * 工作联动把 `{type:'speak'}` 推过来；客户端用 EventSource 接住再走 petSpeak。
   */
  function handleEvents(req, res) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.write(': folia-pet-events\n\n');
    const client = { res };
    speakClients.add(client);
    const timer = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 下一次清理 */ }
    }, 15000);
    if (typeof timer.unref === 'function') timer.unref();
    const cleanup = () => {
      clearInterval(timer);
      speakClients.delete(client);
      try { res.end(); } catch { /* ignore */ }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    // 连上之前攒下的工作联动消息补发（最多 5 条）
    while (pendingSpeaks.length) {
      const event = pendingSpeaks.shift();
      try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch { break; }
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
      if (tail === '/record' && method === 'POST') { await handleRecord(req, res); return; }
      // P1 智能语音闭环：分句合成 → 客户端排队播放；stop 幂等；/events + /speak 是工作联动反向通道
      if (tail === '/tts' && (method === 'GET' || method === 'HEAD')) { await handleTts(req, res, url); return; }
      if (tail === '/tts/stop' && method === 'POST') { handleTtsStop(res); return; }
      if (tail === '/tts/state' && (method === 'GET' || method === 'HEAD')) { handleTtsState(res); return; }
      if (tail === '/events' && (method === 'GET' || method === 'HEAD')) { handleEvents(req, res); return; }
      if (tail === '/speak' && method === 'POST') { await handleSpeak(req, res); return; }
    // 语音模型（SenseVoice）自举：用户不需要去 DSH 设置里找开关，
    // 插件自己触发 preparation 并轮询进度（DSH 的 speechToText.prepare 是公开方法）。
    // 自检：一次性跑「ffmpeg → 设备 → 录音 → 转写」四步，把每步结果原样返回。
    // 目的：发版前/真机排查时**一个请求就能看到哪一步坏了**，不用来回猜。
    if (tail === '/selftest' && (method === 'GET' || method === 'HEAD')) { void handleSelfTest(res); return; }
    if (tail === '/capabilities' && (method === 'GET' || method === 'HEAD')) { handleCapabilities(res); return; }
if (tail === '/work-plugins' && (method === 'GET' || method === 'HEAD')) { handleWorkPlugins(res); return; }
if (tail === '/asr' && (method === 'GET' || method === 'HEAD')) { handleAsrStatus(res); return; }
    if (tail === '/asr' && method === 'POST') { handleAsrPrepare(res); return; }
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

  // 卸载：断开所有事件流 + 停掉懒启动的 TTS worker（不留后台进程）
  disposers.push(() => {
    for (const client of [...speakClients]) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    speakClients.clear();
    try { if (typeof ttsService.dispose === 'function') ttsService.dispose(); } catch { /* ignore */ }
  });
}

