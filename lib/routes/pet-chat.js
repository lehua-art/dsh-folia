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
/** 可选注入：判据可以传一个假的 TTS 服务（默认由本族自建）；ffmpeg 供给器由内核注入。 */
export const OPTIONAL_DEPS = ['tts', 'ffmpegEnsure', 'ffmpegStatus', 'clock', 'services'];

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createTtsService, normalizeTtsText, sanitizeLyrics, TTS_MAX_CHARS, TTS_ENGINES } from '../tts/tts.js';
import { planSing, tuneSources, TUNE_LIBRARY } from '../tts/singing.js';
import { synthesizeSong } from '../tts/sing-synth.js';
import { TTS_CATALOG, piperAssetUrls, piperModelUrls } from '../tts/catalog.js';
import {
  VOICE_PACKS, listPacks, packById, packInstalled, packProgress, installPack, removePack,
} from '../tts/packs.js';
import {
  readVoiceCenter, publicVoiceCenter, volcHostConfig, saveVolcConfig, markVolcTest, setPreferredVoice,
  setDefaultPack, voiceEngineOf, resolvePersonaVoice, normalizeVoiceId, VOLC_VOICE_SUGGESTIONS,
} from '../tts/voice-center.js';
// v1.2：用户音色包导入 + 4 个内置系统音效（不携带任何角色/声优素材）
import {
  voicePackSummary, importVoicePack, removeUserVoicePack, listSystemSounds, SYSTEM_SOUNDS,
} from '../tts/voice-pack.js';
import { appendToolLog } from '../persona-tool-log.js';
import { CAPABILITIES } from '../capabilities-catalog.js';
import { CURATED_BUNDLES } from '../capabilities-curated.js';
import { PERSONAL_TOOLS } from '../curated-personal.js';

import {
  buildEnvContext, buildSystemPrompt, buildPersonaSystemPrompt, personaToolAllowed, personaToolRegistry,
  classifyIntent, detectMood, buildInnerStep, needsTwoStep, comfortStarts, personaPermissionsView,
  shouldUseModelIntent, buildIntentSystemPrompt, parseIntentJson, normalizeModelIntent,
  timeAnswer, dateAnswer, isConfirmText, isCancelText, isKnownTool, toolNeedsConfirm,
  buildCapabilityPrompt, capabilityForText, localCapabilityAnswer, thinkingTier,
  buildSelfCheckPrompt, reasonerModelFor, buildTaskPlan, taskPlanSentence,
  detectCrisis, treeholeSafetyReply, resolveTurnPolicy,
} from '../pet-chat-brain.js';
import {
  runTool, readPetConfig, dueReminders, markReminderFired,
  readToolWhitelist, writeToolWhitelist, listCapabilities,
} from '../pet-chat-tools.js';
import {
  getActivePersona, readPersona, resolvePersonaModel, toolPolicy, PERMISSION_GROUPS, updatePersona,
  applyPermissionPreset, permissionPresetOf,
} from '../persona-store.js';
import {
  appendEvent, retrieveEvents, listEvents, writeSummary, clearEvents,
  recordObservation, listObservations, clearObservations, memoryStats, memoryBackend,
  deleteEventsByDate, rollbackEvents, decayTick, memoryMigrationInfo, memoryStoragePath,
} from '../persona-memory.js';
import { touchRelations, relationsPromptLine, lorePromptLine } from '../memory-db.js';
import { reflectGrowth, REFLECT_EVERY_TURNS } from '../persona-growth.js';
import { createPersonaApi } from './personas.js';
// v0.1：旧键迁移与默认值只在 settings-schema 定义一次，路由复用同一个函数
import { readPetChat as normalizePetChat } from '../settings-schema.js';
import {
  createVoiceRecorder, defaultResolveFfmpeg, defaultRunFfmpeg, defaultRunFfmpegStream, pickDevice,
  setFfmpegProvisioner, ffmpegProvisionStatus, ensureFfmpegStatus, ensureFfmpegNow,
} from '../voice/record.js';
// 本地 STT：资源不下发到 npm 包，首次使用时从站点 R2 下载（见 lib/asr/asr-local.js）
import { ensureInstalled as ensureAsrInstalled, startWorker as startAsrWorker } from '../asr/asr-local.js';
// v0.1「零配置」主动搭话：固定策略 + 语音指令静默（追加决定 1/2）
import {
  canSpeak, markSaid, buildProactiveLine, readProactiveState, todayUsage, isSilent,
  enterSilence, clearSilence, parseSilenceCommand, PROACTIVE_RULES,
  canEventSpeak, buildEventLine, markEventSaid, EVENT_RULES,
} from '../pet-chat-proactive.js';
// v1.2：主动思维（内心 tick）+ 屏幕感知（前台窗口 / OCR）
import {
  mindTick, markMindSaid, markMindTick, readMindState, clearMindState, MIND_RULES,
} from '../pet-chat-mind.js';
import {
  readForegroundWindow, captureScreenOcr, foregroundObservation, ocrObservation,
  isSensitiveApp, isLockScreen, OBSERVE_RULES,
} from '../desktop-context.js';

/** 单次输入上限（工单：≤400 字）。 */
const MAX_INPUT_CHARS = 400;
/** 模型调用超时（工单：20s）。 */
const TIMEOUT_MS = 20000;
/** 同一来源的最小间隔（工单：1 次/秒）。 */
const RATE_LIMIT_MS = 1000;

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
/** v2：客户端执行壁纸切换的等待上限（SSE action → 客户端 POST tool-result）。 */
const CLIENT_ACTION_TIMEOUT_MS = 5000;
/** v2：危险动作的确认有效期（下一句必须在这之前说）。 */
const CONFIRM_TTL_MS = 120000;
/** v2：提醒轮询间隔（20 秒；只在有提醒时才会真的读文件）。 */
const REMINDER_TICK_MS = 20000;

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
/** 默认镜像：站点 /media（所有 ASR / 模型资源都从这里取；用户/运维可覆盖）。 */
const DEFAULT_ASR_MIRROR = 'https://folia-5ve.pages.dev/media/';
const DEFAULT_MODEL_MIRROR = DEFAULT_ASR_MIRROR;

function normalizeMirror(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  return text.replace(/\/?$/, '/');
}

/* 读镜像地址的函数在 registerPetChatRoutes 内（需要 readOverlay/readSettings）。 */
/** 下载/就绪状态（GET /pet-chat/asr 直接回它）。 */
let asrState = {
  phase: 'idle', doneBytes: 0, totalBytes: 0, error: null,
  startedAt: 0, etaSeconds: null, attempt: 0, retries: 3, retryAt: 0, lastError: null,
};
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
function ensureLocalAsr(baseUrl) {
  if (asrWorker) return Promise.resolve(asrWorker);
  if (asrInstallPromise) return asrInstallPromise;
  const mediaBase = normalizeMirror(baseUrl) || DEFAULT_ASR_MIRROR;
  asrInstallPromise = (async () => {
    if (!asrInstalledOnDisk()) {
      const startedAt = Date.now();
      let lastError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        asrState = {
          ...asrState, phase: 'downloading', startedAt,
          attempt, retries: 3, retryAt: 0,
          error: attempt > 1 ? asrState.error : null,
          lastError,
        };
        try {
          await ensureAsrInstalled(ASR_ROOT, {
            mediaBase,
            manifestUrl: mediaBase + 'asr/v1/manifest.json',
            // 单文件最多 3 次（超时/断流后 Range 续传），外层再整体重试 3 次。
            retries: 3,
            fileTimeoutMs: 180000,
            onProgress: (p) => {
              const done = Number(p.doneBytes) || 0;
              const total = Number(p.totalBytes) || 0;
              const elapsed = Math.max(0.5, (Date.now() - startedAt) / 1000);
              const rate = done > 0 ? done / elapsed : 0;
              const etaSeconds = rate > 0 && total > done ? Math.max(1, Math.ceil((total - done) / rate)) : null;
              asrState = {
                ...asrState,
                phase: 'downloading',
                doneBytes: done,
                totalBytes: total,
                etaSeconds,
                file: p.file || '',
                error: null,
                lastError: null,
                attempt,
              };
            },
            onRetry: (r) => {
              asrState = {
                ...asrState,
                phase: 'downloading',
                attempt,
                retryAt: Date.now() + 800 * Math.max(1, Number(r.attempt) || 1),
                lastError: String((r && r.error) || 'download-retry'),
                error: null,
                file: r && r.file ? r.file : asrState.file,
              };
            },
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = String((error && error.message) || error);
          if (attempt >= 3) {
            asrState = {
              ...asrState,
              phase: 'failed',
              error: lastError,
              lastError,
              etaSeconds: null,
              retryAt: 0,
              attempt,
            };
            throw error;
          }
          asrState = {
            ...asrState,
            phase: 'downloading',
            error: `下载中断，${Math.round(1.5 * attempt)} 秒后自动重试（第 ${attempt + 1}/3 次）`,
            lastError,
            retryAt: Date.now() + 1500 * attempt,
          };
          await new Promise((resolve) => { setTimeout(resolve, 1500 * attempt); });
        }
      }
    }
    asrState = {
      ...asrState,
      phase: 'loading', error: null, etaSeconds: null, retryAt: 0,
    };
    asrWorker = startAsrWorker(ASR_ROOT);
    asrState = {
      ...asrState,
      phase: 'ready', error: null, etaSeconds: 0, retryAt: 0,
    };
    // v5 §2：常驻聆听一进来就预热；空闲 10 分钟释放（真的 stop 子进程，不是只丢引用）。
    startAsrIdleReaper();
    asrLastUsedAt = Date.now();
    return asrWorker;
  })().catch((error) => {
    asrWorker = null;
    asrState = {
      ...asrState,
      phase: 'failed',
      error: String((error && error.message) || error),
      lastError: String((error && error.message) || error),
      etaSeconds: null,
      retryAt: 0,
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

/** v5 §2：ASR 常驻 + 空闲 10 分钟释放。 */
let asrLastUsedAt = 0;
let asrIdleTimer = null;
function startAsrIdleReaper() {
  if (asrIdleTimer) return;
  asrIdleTimer = setInterval(() => {
    if (!asrWorker) return;
    if (Date.now() - asrLastUsedAt < 10 * 60 * 1000) return;
    try { if (typeof asrWorker.stop === 'function') asrWorker.stop(); } catch { /* ignore */ }
    asrWorker = null;
    asrState = { ...asrState, phase: 'idle', error: null, etaSeconds: 0, retryAt: 0 };
  }, 60 * 1000);
  if (typeof asrIdleTimer.unref === 'function') asrIdleTimer.unref();
}
/** 每次真正用到语音（录音/转写）就续期。 */
function noteAsrUsed() { asrLastUsedAt = Date.now(); }

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
  const {
    disposers, base: BASE, log, readSettings, speechToText, tts: injectedTts,
    ffmpegEnsure, ffmpegStatus, clock,
    // v5 §4：DSH 服务面（可选）。宿主的 ctx.skills/tools 若能传进来就走服务，
    // 传不进来就退到文件面（~/.dsh/skills + 随包 office-skills）——两条都实现，不假装。
    services,
  } = c;
  /** v2 的可注入时钟：测试要固定“深夜”，生产不传就是 Date.now。 */
  const nowMs = () => {
    if (typeof clock === 'function') {
      const value = Number(clock());
      if (Number.isFinite(value)) return value;
    }
    return Date.now();
  };
  /** 危险动作待确认表：IP → { tool, args, expiresAt }。 */
  const pendingConfirms = new Map();
  /** v2：同一个待确认项的 id 索引（气泡按钮走 /tool-confirm，不依赖 IP）。 */
  const pendingConfirmById = new Map();
  /** 客户端动作回执表：taskId → { resolve, timer }。 */
  const pendingClientActions = new Map();
  let clientActionSeq = 0;
  // pre.62：把内核的 ffmpeg 供给器接到录音/诊断；没注入（单测）时 record.js 退回本地探测。
  if (typeof ffmpegEnsure === 'function' && typeof ffmpegStatus === 'function') {
    setFfmpegProvisioner({ ensure: ffmpegEnsure, status: ffmpegStatus });
  } else {
    setFfmpegProvisioner(null);
  }

  /** 宿主侧录音器：**必须在这里实例化** —— 只 import 不 new，/record 会抛
   *  ReferenceError: voiceRecorder is not defined（P6 实锤）。 */
  const voiceRecorder = createVoiceRecorder({
    resolveFfmpeg: defaultResolveFfmpeg,
    runFfmpeg: defaultRunFfmpeg,
    // pre.63：流式 VAD（stdout pipe + Node RMS），说完 0.7s 就停；pipe 不可用回退固定窗口。
    runFfmpegStream: defaultRunFfmpegStream,
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

  /** 同一来源的最近一次请求时间（限频）。 */
  const lastAt = new Map();
  /** 转写限频（1 次 / 2 秒）：同一来源一张表。 */
  const asrLastAt = new Map();
  /** 最近一次失败原因（`/state` 里回给界面）。 */
  let lastError = null;
  /** pre.65：人设 API（子路径委托；Key/记忆/成长都按 persona 隔离）。 */
  const personaApi = createPersonaApi({ readSettings, log });
  /** pre.65：每个 persona 独立的会话历史与反思轮次（进程内；重启只保留磁盘事件）。 */
  const personaHistory = new Map();
  const personaTurns = new Map();
  const personaReflecting = new Set();

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

  /**
   * 读**原始** voice 段（绕过 settings-schema 的旧迁移）。
   *
   * 为什么需要：settings-schema 是共享文件、本任务不能改；它的 `readVoice()` 会把
   * `zh-CN-*-Neural` 主动迁成空串（pre.54 的“不把云端音色名写进设置”策略）。
   * v0.2 的 Edge 在线音色恰恰要用户选中的 neural 名，且 `sapiEnabled` 是新字段。
   * 因此面板/路由读取 voice 时以覆盖层的原始对象为准，读不到才回落到规范化值。
   */
  function readVoiceRaw() {
    const normalized = readPetChat();
    const fallback = normalized.voice && typeof normalized.voice === 'object' ? normalized.voice : {};
    let raw = null;
    try {
      const overlay = readOverlay();
      if (overlay && overlay.voice && typeof overlay.voice === 'object') raw = overlay.voice;
    } catch { raw = null; }
    if (!raw) {
      try {
        const settings = readSettings();
        const candidate = settings && settings.petChat && settings.petChat.voice;
        if (candidate && typeof candidate === 'object') raw = candidate;
      } catch { raw = null; }
    }
    const source = raw || {};
    const rate = Number(source.rate);
    const name = String(source.name !== undefined ? source.name : (fallback.name || '')).slice(0, 120);
    const explicitEngine = String(source.enabledEngine || '');
    const inferredEngine = /^piper:/i.test(name) ? 'piper' : (/-[A-Za-z0-9]+Neural$/.test(name) ? 'edge' : (name ? 'sapi' : 'edge'));
    const enabledEngine = ['edge', 'piper', 'sapi'].includes(explicitEngine) ? explicitEngine : inferredEngine;
    const online = (source.online && typeof source.online === 'object') ? source.online
      : ((fallback.online && typeof fallback.online === 'object') ? fallback.online : {});
    return {
      name,
      muted: typeof source.muted === 'boolean' ? source.muted : fallback.muted === true,
      // 任务 §4：常驻聆听的持久开关（暂停聆听 = 关麦；重启后仍保持）。
      listenPaused: typeof source.listenPaused === 'boolean'
        ? source.listenPaused
        : fallback.listenPaused === true,
      rate: Number.isFinite(rate) ? Math.max(-10, Math.min(10, Math.round(rate))) : Number(fallback.rate) || 0,
      sapiEnabled: source.sapiEnabled === true,
      enabledEngine,
      continuous: source.continuous !== false,
      online,
    };
  }

  /** 浏览器可见的 voice（永远不含 online.apiKey）。 */
  function publicVoice(voice) {
    const v = voice && typeof voice === 'object' ? voice : {};
    return {
      name: String(v.name || ''),
      muted: v.muted === true,
      listenPaused: v.listenPaused === true,
      rate: Number.isFinite(Number(v.rate)) ? Number(v.rate) : 0,
      sapiEnabled: v.sapiEnabled === true,
      enabledEngine: ['edge', 'piper', 'sapi'].includes(String(v.enabledEngine || '')) ? String(v.enabledEngine) : 'edge',
      continuous: v.continuous !== false,
    };
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
      // v1.2：会话模式 / 语音长度 / 主动思维 / 屏幕感知 / 树洞热线
      conversationMode: normalized.conversationMode,
      voiceLength: normalized.voiceLength,
      proactive: normalized.proactive,
      screen: normalized.screen,
      treehole: normalized.treehole,
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

  /** 读镜像地址：环境变量 → 覆盖层/设置 asrBaseUrl → 站点默认。 */
  function readAsrBase() {
    const env = normalizeMirror(process.env.FOLIA_ASR_BASE || process.env.FOLIA_ASR_MEDIA_BASE);
    if (env) return env;
    try {
      const overlay = readOverlay();
      const fromOverlay = normalizeMirror(overlay && (overlay.asrBaseUrl || (overlay.voice && overlay.voice.asrBaseUrl)));
      if (fromOverlay) return fromOverlay;
    } catch { /* ignore */ }
    try {
      const settings = readSettings();
      const fromSettings = normalizeMirror(settings && (settings.asrBaseUrl || (settings.petChat && settings.petChat.asrBaseUrl)));
      if (fromSettings) return fromSettings;
    } catch { /* ignore */ }
    return DEFAULT_ASR_MIRROR;
  }

  function historyFor(personaId) {
    const id = String(personaId || '');
    if (!personaHistory.has(id)) personaHistory.set(id, []);
    return personaHistory.get(id);
  }

  /** v1.3：上一段故事正文（内存，仅用于“继续讲/后来呢”；不落盘、不持久化）。 */
  const lastStoryByPersona = new Map();

  /** 任务 §3⑤：最近几句回答（只用于「别重复同一句安慰话术」，不进历史）。 */
  const personaRecentReplies = new Map();
  /** v5 §3：多步任务的计划（进程内；重启清空，符合"这次会话里办完"）。 */
  const activeTaskPlans = new Map();
  function recentRepliesFor(personaId) {
    return personaRecentReplies.get(String(personaId || '')) || [];
  }
  function pushRecentReply(personaId, reply) {
    const id = String(personaId || '');
    const list = recentRepliesFor(id).slice();
    const text = String(reply || '').trim();
    if (text) list.push(text);
    personaRecentReplies.set(id, list.slice(-3));
  }

  function pushPersonaHistory(personaId, role, content) {
    const list = historyFor(personaId);
    list.push({ role, content: String(content || '') });
    const max = DEFAULT_MAX_TURNS * 2;
    if (list.length > max) list.splice(0, list.length - max);
  }

  /** 该 persona 本轮最终使用的模型配置（persona 优先，inherit 回落全局）。 */
  function personaChatConfig(persona) {
    const global = readPetChat();
    const resolved = resolvePersonaModel(persona, global);
    return {
      ...global,
      ...resolved,
      enabled: global.enabled,
      maxTurns: DEFAULT_MAX_TURNS,
      maxChars: global.maxChars,
      legacyMaxChars: global.maxChars,
    };
  }

  /** 从一句显式记忆里抠结论（只存结论，不存原话）。 */
  function preferenceText(raw) {
    const text = String(raw || '');
    const like = text.match(/(?:记住|记一下|记下)[，,、 ]*我(?:很|最|超)?(?:喜欢|爱|爱看|爱玩)\s*([^\s，,。！!？?]{1,20})/);
    if (like) return { kind: 'preference', text: `偏好：喜欢${like[1]}` };
    const dislike = text.match(/(?:记住|记一下|记下)[，,、 ]*我(?:很|最|超)?(?:不喜欢|讨厌|受不了)\s*([^\s，,。！!？?]{1,20})/);
    if (dislike) return { kind: 'preference', text: `偏好：不喜欢${dislike[1]}` };
    const nick = text.match(/(?:记住|记一下|记下)[，,、 ]*(?:我)?(?:叫你|称呼我|管我叫)\s*([^\s，,。！!？?]{1,20})/);
    if (nick) return { kind: 'preference', text: `称呼：${nick[1]}` };
    return { kind: 'preference', text: '偏好：' + String(text).replace(/^(?:记住|记一下|记着|记下|别忘)[，,、 ]*/, '').slice(0, 60) };
  }

  function recordPersonaEvent(persona, event) {
    try { appendEvent(persona.id, event); } catch { /* 记忆写失败不影响回复 */ }
  }

  /** v1.3：静音指令只切 TTS 开关（字幕继续），不进入任何“模式”。 */
  function setTtsMuted(muted) {
    try {
      const current = readVoiceRaw();
      writeOverlay({ voice: { ...current, muted: muted === true } });
    } catch { /* 写失败也不能拦住对话 */ }
  }

  /** 非流式 JSON 调用（反思/摘要/两步策划共用；不写日志、不泄漏 Key）。 */
  async function callPersonaJson(config, system, user, maxTokens = 500, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1500, Number(timeoutMs) || 15000));
    const headers = { 'content-type': 'application/json' };
    if (config.provider === 'openai' && config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const url = config.provider === 'ollama' ? `${config.baseUrl}/api/chat` : `${config.baseUrl}/chat/completions`;
    const body = {
      model: config.model,
      stream: false,
      temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens,
    };
    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      if (!response.ok) return '';
      const doc = await response.json();
      const content = config.provider === 'ollama'
        ? (doc && doc.message && doc.message.content)
        : (doc && doc.choices && doc.choices[0] && doc.choices[0].message && doc.choices[0].message.content);
      return typeof content === 'string' ? content : '';
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  /** 每 5 轮反思一次；自动采纳（不阻塞本轮回答）。 */
  function maybeReflect(persona, config) {
    const id = persona.id;
    const turns = (personaTurns.get(id) || 0) + 1;
    personaTurns.set(id, turns);
    if (turns % REFLECT_EVERY_TURNS !== 0 || personaReflecting.has(id)) return;
    personaReflecting.add(id);
    const snapshot = historyFor(id).slice(-12);
    void reflectGrowth(id, snapshot, {
      callModel: (prompt) => callPersonaJson(config, prompt.system, prompt.user, 500),
      source: 'reflection',
    }).then((result) => {
      if (result && result.ok) {
        try {
          writeSummary(id, snapshot.map((turn) => `${turn.role === 'user' ? '用户' : '我'}：${String(turn.content).slice(0, 300)}`).join('\n'));
        } catch { /* ignore */ }
      }
    }).catch(() => { /* 反思失败只影响成长，不影响聊天 */ }).finally(() => {
      personaReflecting.delete(id);
    });
  }

  /**
   * 组装请求体（两种协议各一份；都只发到该 persona 配置的端点）。
   * pre.65：system 由 core/growth/express/affect/世界书/召回记忆组成，不再读旧 memory.json。
   */
  function buildRequest(config, text, context = {}, persona = null) {
    // v1.2：关系/好感度 + 世界书 RAG（lore）都只作背景注入，不整本塞 prompt。
    let memoryExtras = '';
    if (persona) {
      try {
        const relations = relationsPromptLine(persona.id);
        if (relations) memoryExtras += '\n' + relations;
      } catch { /* ignore */ }
      try { const lore = lorePromptLine(persona.id, text); if (lore) memoryExtras += '\n' + lore; } catch { /* ignore */ }
    }
    const baseSystem = persona
      ? buildPersonaSystemPrompt(persona, {
        env: context.env || '',
        mood: context.mood || null,
        memories: context.memories || [],
        userText: text,
        inputMode: context.inputMode,
        turnPolicy: context.turnPolicy,
        storyContext: context.storyContext,
        voiceLength: context.voiceLength,
        // 任务 §3：内心步骤 / 先想过的要点 / 别重复的安慰话（都只进 system，不进历史）
        innerStep: context.innerStep || '',
        outline: context.outline || '',
        avoidLines: context.avoidLines || [],
        affect: persona.affect,
      }) + '\n' + buildCapabilityPrompt()
      : buildSystemPrompt(config, {}, context.env || '', context.mood || null) + '\n' + buildCapabilityPrompt();
    const system = baseSystem + memoryExtras;
    const headers = { 'content-type': 'application/json' };
    const history = persona ? historyFor(persona.id).slice(-config.maxTurns) : [];
    const temperature = Number(config.temperature);
    const maxTokens = Math.max(0, Math.min(8192, Number(context.maxTokens) || 0));
    if (config.provider === 'openai') {
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      return {
        url: `${config.baseUrl}/chat/completions`,
        body: {
          model: config.model,
          stream: true,
          temperature: Number.isFinite(temperature) ? temperature : 0.8,
          messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: text }],
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
        },
        headers,
      };
    }
    return {
      url: `${config.baseUrl}/api/chat`,
      body: {
        model: config.model,
        stream: true,
        temperature: Number.isFinite(temperature) ? temperature : 0.8,
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: text }],
        ...(maxTokens ? { options: { num_predict: maxTokens } } : {}),
      },
      headers,
    };
  }

  /** GET /pet-chat/state */
  async function handleState(res) {
    const config = readPetChat();
    const persona = getActivePersona();
    const resolved = persona ? resolvePersonaModel(persona, config) : config;
    let reachable = false;
    if (config.enabled) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const probe = resolved.provider === 'ollama' ? `${resolved.baseUrl}/api/tags` : `${resolved.baseUrl}/models`;
        const headers = {};
        if (resolved.provider === 'openai' && resolved.apiKey) headers.authorization = `Bearer ${resolved.apiKey}`;
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
    const personaVoice = persona && persona.express && persona.express.voice ? persona.express.voice : null;
    const center = readVoiceCenter();
    const resolvedVoice = persona
      ? resolvePersonaVoice(persona, { preferred: center.preferred, rate: Number(publicVoice(readVoiceRaw()).rate) })
      : { mode: 'inherit', id: normalizeVoiceId(center.preferred), rate: 0, source: 'global' };
    const voice = publicVoice(readVoiceRaw());
    if (resolvedVoice.id) voice.name = resolvedVoice.id;
    if (Number.isFinite(Number(resolvedVoice.rate))) voice.rate = Number(resolvedVoice.rate);
    voice.mode = resolvedVoice.mode;
    voice.id = resolvedVoice.id;
    voice.source = resolvedVoice.source;
    const hasApiKey = Boolean(resolved.apiKey);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: true,
      enabled: config.enabled,
      hasApiKey,
      // 常驻聆听前置：已启用 + 有凭据（ollama 本机不需要 Key）
      modelReady: config.enabled === true && (resolved.provider === 'ollama' || hasApiKey),
      provider: resolved.provider,
      model: resolved.model,
      reachable,
      lastError,
      // v0.1：语音输入开关随设置收敛去掉（能力由 DSH 决定）；语音/名字照旧回给客户端
      petName: persona ? (persona.name || '') : config.petName,
      ownerName: config.ownerName,
      voice,
      resolvedVoice,
      memoryEnabled: true,
      // v1.3：模式已删除；“policy”由每轮 meta 下发，这里只保留字段兼容（恒 auto）。
      conversationMode: 'auto',
      voiceLength: config.voiceLength,
      proactive: config.proactive,
      screen: config.screen,
      observing: config.screen.mode !== 'off',
      asrProvider: ASR_PROVIDER_ID,
      personas: persona ? {
        id: persona.id, name: persona.name, type: persona.type, mode: persona.mode,
        avatar: persona.avatar, voice: personaVoice,
        permissions: persona.permissions,
      } : null,
      persona: persona ? {
        id: persona.id, name: persona.name, type: persona.type, mode: persona.mode,
        avatar: persona.avatar, voice: personaVoice,
        permissions: persona.permissions,
      } : null,
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

  /**
   * 本轮环境串：宿主侧能读到的（时间 / 桌宠配置）以宿主为准，
   * 客户端在 body.context 里附上的壁纸名与正在播放作为补充（宿主不认识前端 `selection`）。
   */
  function buildEnvForChat(body) {
    let settings = {};
    try { settings = readSettings() || {}; } catch { settings = {}; }
    const pet = readPetConfig();
    const context = body && body.context && typeof body.context === 'object' && !Array.isArray(body.context)
      ? body.context : {};
    const wallpaper = context.wallpaper && typeof context.wallpaper === 'object'
      ? context.wallpaper
      : { title: context.wallpaperTitle || '', id: settings.id || '' };
    const playing = context.playing && typeof context.playing === 'object' ? context.playing : null;
    return buildEnvContext({
      now: nowMs(),
      wallpaper,
      pet: { visible: pet.enabled, scalePercent: pet.scale * 100 },
      volume: pet.volume * 100,
      playing,
    });
  }

  /** 客户端动作回执：发 SSE action，等客户端 POST /tool-result；超时按失败返回。 */
  function requestClientAction(res, payload) {
    const id = 'act-' + (++clientActionSeq).toString(36) + '-' + nowMs().toString(36);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingClientActions.delete(id);
        resolve({ ok: false, error: 'client-timeout' });
      }, CLIENT_ACTION_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pendingClientActions.set(id, { resolve, timer });
      try {
        sse(res, 'action', { id, ...payload });
      } catch {
        clearTimeout(timer);
        pendingClientActions.delete(id);
        resolve({ ok: false, error: 'client-offline' });
      }
    });
  }

  /** 宿主自调用（只用于复用现有 /skins 路由；不把本族变成通用转发器）。 */
  async function hostJson(req, path, payload) {
    const host = req && req.headers ? String(req.headers.host || '') : '';
    if (!host) return null;
    const url = `http://${host}${BASE}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── v2 权限确认流：问一句 / 气泡按钮 / 语音「好」/ 记忆同意 ─────────────── */

  function groupMetaOf(groupId) {
    return PERMISSION_GROUPS.find((group) => group.id === groupId) || null;
  }

  function permissionQuestion(tool, groupId) {
    const meta = groupMetaOf(groupId);
    const label = meta ? meta.label : '这一步';
    return `要我用「${label}」里的能力吗？确认就说「好」或点「允许」。`;
  }

  function newConfirmId() {
    return 'cf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function storeConfirm(req, entry) {
    const id = entry.id || newConfirmId();
    const row = {
      ...entry, id,
      personaId: entry.personaId || '',
      expiresAt: nowMs() + CONFIRM_TTL_MS,
    };
    pendingConfirms.set(sourceOf(req), row);
    pendingConfirmById.set(id, row);
    return row;
  }

  function dropConfirm(row) {
    if (!row) return;
    if (row.id) pendingConfirmById.delete(row.id);
    for (const [ip, item] of pendingConfirms) {
      if (item === row || (row.id && item.id === row.id)) pendingConfirms.delete(ip);
    }
  }

  /** 「以后都允许 / 以后都别问」写进 persona.permissions（并留 consentMemory 证据）。 */
  function setGroupPermission(persona, groupId, level, consent) {
    if (!persona || persona.type === 'character') return persona;
    const current = persona.permissions && typeof persona.permissions === 'object'
      ? persona.permissions : {};
    const permissions = {
      ...current,
      [groupId]: level,
      consentMemory: { ...(current.consentMemory || {}), [groupId]: consent },
    };
    try {
      const saved = updatePersona(persona.id, { permissions });
      return saved || persona;
    } catch {
      return persona;
    }
  }

  function auditTool(persona, tool, args, info = {}) {
    if (!persona || !persona.id) return;
    const extra = info.extra && typeof info.extra === 'object' ? info.extra : {};
    appendToolLog(persona.id, {
      tool,
      args: args || {},
      permission: info.permission || 'allow',
      confirmed: info.confirmed === true,
      result: info.result === undefined ? 'unknown' : info.result,
      verified: info.verified === true,
      error: info.error || '',
      source: info.source || 'chat',
      // v5 §3：多步任务要能看出是哪条计划、第几步（其余调用这两个字段为空）。
      planId: extra.planId ? String(extra.planId).slice(0, 60) : '',
      step: Number.isFinite(Number(extra.step)) ? Number(extra.step) : 0,
      ts: Date.now(),
    });
  }

  /** 状态查询：壁纸 / 音色 / 音量 / 正在播放（宿主能读到的都读，不猜）。 */
  async function statusSnapshot(req) {
    let settings = {};
    try { settings = readSettings() || {}; } catch { settings = {}; }
    const pet = readPetConfig();
    const rawVoice = readVoiceRaw();
    const center = publicVoiceCenter();
    const preferredId = center.preferred || normalizeVoiceId(rawVoice.name) || '';
    const preferredPack = listPacks().find((pack) => pack.voiceId === preferredId);
    let playing = null;
    const now = await hostJson(req, '/now-playing');
    if (now && now.ok && now.media && typeof now.media === 'object') {
      const media = now.media;
      if (media.title || media.artist) playing = { title: String(media.title || ''), artist: String(media.artist || '') };
    }
    return {
      wallpaperId: String(settings.id || ''),
      wallpaperTitle: String(settings.id || '未选择'),
      voice: preferredId,
      voiceLabel: preferredPack ? preferredPack.name : (preferredId || '继承全局'),
      volume: Math.round((Number(pet.volume) || 0) * 100),
      petVisible: pet.enabled === true,
      rotationEnabled: settings.rotationEnabled === true,
      playing,
    };
  }

  /* ── v3 宿主能力：通知 / 打开网页 / 启动应用 / 剪贴板（工具层调用） ─────── */

  /** 起一个后台进程（不等输出）；spawn 成功即算交出去了。 */
  function runDetached(command, args) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore' });
      } catch (error) {
        resolve({ ok: false, error: String((error && error.message) || error).slice(0, 160) });
        return;
      }
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once('error', (error) => settle({ ok: false, error: String((error && error.message) || error).slice(0, 160) }));
      child.once('spawn', () => {
        try { child.unref(); } catch { /* ignore */ }
        setTimeout(() => settle({ ok: true, pid: child.pid }), 150);
      });
    });
  }

  function powershellExe() {
    return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  }

  /** 跑一段 PowerShell（无交互、隐藏窗口、带超时）。 */
  function runPowerShell(script, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(powershellExe(), [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, code: -1, stdout: '', stderr: String((error && error.message) || error) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => {
        // pid 落地才 kill（未起来时裸 kill 会让事件循环挂死；verify-child-kill 的判据）
        try { if (child.pid !== undefined) child.kill(); } catch { /* ignore */ }
        done({ ok: false, code: -1, stdout, stderr: stderr || 'timeout' });
      }, Math.max(800, Number(timeoutMs) || 4000));
      if (typeof timer.unref === 'function') timer.unref();
      try { child.stdout.setEncoding('utf8'); } catch { /* ignore */ }
      try { child.stderr.setEncoding('utf8'); } catch { /* ignore */ }
      if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; });
      if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', (error) => {
        clearTimeout(timer);
        done({ ok: false, code: -1, stdout, stderr: String((error && error.message) || error) });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        done({ ok: code === 0, code: Number(code) || 0, stdout, stderr });
      });
    });
  }

  function b64Utf8(text) {
    return Buffer.from(String(text == null ? '' : text), 'utf8').toString('base64');
  }

  /**
   * 桌面通知：优先推给已连上的桌宠客户端（浏览器 Notification / 气泡）；
   * 没有客户端时在 Windows 上用托盘气泡（真桌面通知），fail 就照实报。
   */
  async function desktopNotify({ title, text }) {
    const delivered = broadcastSpeak({ type: 'notify', title, text, ts: nowMs() });
    if (delivered > 0) return { ok: true, channel: 'client', verified: true, delivered };
    if (process.platform !== 'win32') return { ok: false, error: 'no-notification-channel' };
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64Utf8(title) + "'))",
      "$b=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64Utf8(text) + "'))",
      '$n=New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon=[System.Drawing.SystemIcons]::Information',
      '$n.Visible=$true',
      '$n.ShowBalloonTip(5000,$t,$b,[System.Windows.Forms.ToolTipIcon]::Info)',
      'Start-Sleep -Milliseconds 700',
      '$n.Visible=$false; $n.Dispose()',
    ].join('; ');
    const result = await runPowerShell(script, 8000);
    return {
      ok: result.ok,
      channel: 'windows-toast',
      verified: result.ok,
      error: result.ok ? '' : String(result.stderr || 'notify-failed').slice(0, 160),
    };
  }

  function psQuote(text) {
    return "'" + String(text == null ? '' : text).replace(/'/g, "''") + "'";
  }

  /** 用默认浏览器打开一个**已过白名单校验**的 https 链接。 */
  async function openExternalUrl(url) {
    if (process.platform === 'win32') {
      const pushed = await runDetached(powershellExe(), [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Start-Process ' + psQuote(url),
      ]);
      return { ...pushed, verified: pushed.ok === true };
    }
    if (process.platform === 'darwin') {
      const opened = await runDetached('open', [url]);
      return { ...opened, verified: opened.ok === true };
    }
    const opened = await runDetached('xdg-open', [url]);
    return { ...opened, verified: opened.ok === true };
  }

  /** 启动白名单应用（id 由工具层白名单校验过）。 */
  async function launchWhitelistedApp(id) {
    const key = String(id || '').toLowerCase();
    if (key === 'browser') return openExternalUrl('https://www.bing.com');
    if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
    const commands = {
      notepad: 'notepad.exe',
      calc: 'calc.exe',
      mspaint: 'mspaint.exe',
      explorer: 'explorer.exe',
    };
    const command = commands[key];
    if (!command) return { ok: false, error: 'unknown-app' };
    const result = await runDetached(command, []);
    return { ...result, verified: result.ok === true };
  }

  /** 读系统剪贴板（Windows；其它平台明确不支持，不假装）。 */
  async function clipboardReadHost() {
    if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
    const result = await runPowerShell('Get-Clipboard -Raw -ErrorAction SilentlyContinue', 4000);
    if (!result.ok) return { ok: false, error: String(result.stderr || 'clipboard-failed').slice(0, 160) };
    return { ok: true, text: String(result.stdout || '').replace(/\r\n/g, '\n').replace(/\n$/, '') };
  }

  /** 写系统剪贴板（经 base64 传文本，避免引号/编码地雷）。 */
  async function clipboardWriteHost(text) {
    if (process.platform !== 'win32') return { ok: false, error: 'unsupported-platform' };
    const script = "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"
      + b64Utf8(text) + "')))";
    const result = await runPowerShell(script, 4000);
    return { ok: result.ok, error: result.ok ? '' : String(result.stderr || 'clipboard-failed').slice(0, 160), verified: result.ok };
  }

  /** 执行工具的统一依赖（SSE 版与气泡按钮版共用）。 */
  function buildToolDeps({ req, res, persona, text, confirmed }) {
    const whitelist = (() => {
      try { return readToolWhitelist(); } catch { return { domains: [], apps: [] }; }
    })();
    return {
      persona,
      sourceText: text,
      confirmed: confirmed === true,
      readSettings,
      // 壁纸切换走客户端现有 applySelection（宿主不重写前端选择逻辑）
      switchWallpaper: (payload) => requestClientAction(res, { tool: 'wallpaper_switch', args: payload }),
      toggleRotation: (enabled) => requestClientAction(res, { tool: 'wallpaper_cycle', args: { enabled } }),
      // 壁纸音轨音量（前端 selection.videoVolume）：同样走客户端动作 + 回执。
      setWallpaperVolume: (percent) => requestClientAction(res, { tool: 'wallpaper_volume', args: { percent } }),
      readOverlay: () => readOverlay() || {},
      writeOverlay,
      mediaControl: async (action) => {
        const doc = await hostJson(req, '/media-control', { action });
        return doc && typeof doc === 'object' ? doc : { ok: false, error: 'media-unavailable' };
      },
      mediaStatus: async () => {
        const doc = await hostJson(req, '/now-playing');
        const media = doc && doc.media && typeof doc.media === 'object' ? doc.media : {};
        return { ok: Boolean(doc && doc.ok), ...media };
      },
      statusSnapshot: () => statusSnapshot(req),
      notify: desktopNotify,
      openUrl: openExternalUrl,
      launchApp: launchWhitelistedApp,
      clipboardRead: clipboardReadHost,
      clipboardWrite: clipboardWriteHost,
      toolWhitelist: whitelist,
      openUrlDomains: whitelist.domains,
      appWhitelist: whitelist.apps,
      services: services || null,
      performSing: (args) => performSingForRoute(args),
      workspaceRoot: process.env.DSH_WORKSPACE || process.cwd(),
      skinsActive: async () => {
        const doc = await hostJson(req, '/skins/active');
        return doc && doc.ok ? String(doc.active || '') : '';
      },
      skinsRemove: async (id) => {
        const doc = await hostJson(req, '/skins/remove', { id });
        return { ok: Boolean(doc && doc.ok) };
      },
      skinsList: async () => {
        const doc = await hostJson(req, '/skins/list');
        return doc && Array.isArray(doc.installed) ? doc.installed : [];
      },
      verifyTimeoutMs: 1600,
    };
  }

  /**
   * 执行一个动作工具：先回“我这就办”，必要时发 action 给客户端，最后**按回读结果**汇报。
   * 不把工具异常抛给 SSE —— 失败也要说人话。
   * 权限（allow/ask/deny）由调用方先行判定；这里只负责执行 + 审计。
   */
  async function executeToolAction(input) {
    const {
      req, res, tool, args, text, confirmed, mood, config, persona, permission = 'allow', group = '',
      taskContext = null,
    } = input;
    sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'action', tool, personaId: persona && persona.id });
    sse(res, 'delta', { t: '好，我这就办。' });
    const deps = buildToolDeps({ req, res, persona, text, confirmed });
    const capability = capabilityForText(text || '');
    let result;
    try {
      result = await runTool(tool, args, deps);
    } catch {
      result = { ok: false, say: '这次没办成，我再试一次。', verified: false, data: {} };
    }
    if (result.needsConfirm) {
      const row = storeConfirm(req, {
        tool, args, personaId: persona && persona.id, permission, taskContext,
        group: result.group || group, question: result.say || permissionQuestion(tool, result.group || group),
      });
      sse(res, 'confirm', {
        id: row.id, tool, group: row.group, permission,
        hardConfirm: toolNeedsConfirm(tool),
        question: row.question,
        options: [
          { value: 'allow', label: '允许' },
          { value: 'deny', label: '不允许' },
          { value: 'always', label: '以后都允许' },
          { value: 'never', label: '以后都别问' },
        ],
      });
      sse(res, 'delta', { t: row.question });
      sse(res, 'done', {
        emotion: 'calm', intent: 'action', tool, confirm: true, confirmId: row.id, verified: false,
        mood: mood.mood, rate: mood.rate, personaId: persona && persona.id,
      });
      res.end();
      return;
    }
    const systemHint = (result.ok && (group === 'system' || (result.group === 'system')))
      ? '（这一步不可撤销；设置里可改回来）' : '';
    const sayLimit = Math.max(60, Number(config && config.maxChars) || 80);
    const say = String(result.say || (result.ok ? '办好了。' : '没办成。')).slice(0, sayLimit - systemHint.length) + systemHint;
    if (persona) {
      recordPersonaEvent(persona, {
        kind: 'action', importance: 7, text: `${result.ok ? '完成' : '失败'}：${say}`.slice(0, 500),
      });
    }
    auditTool(persona, tool, args, {
      permission: result.permission || permission,
      confirmed: confirmed === true,
      result: result.ok ? 'ok' : 'failed',
      verified: result.verified === true,
      error: result.ok ? '' : say,
      // v5 §4：能力调用的审计要能看出"来源方案"（文件面技能 / 宿主服务 / DSH 委派）。
      source: tool === 'delegate_to_dsh' ? 'dsh-agent'
        : tool === 'capability_call' ? 'skill-filesystem' : 'chat',
      extra: taskContext ? { planId: taskContext.planId, step: taskContext.step } : null,
    });
    // v5 §3：多步任务推进（这一步成功就记下来；失败保留原步号，方便"重试一步"）。
    let planData = null;
    if (taskContext && taskContext.planId) {
      const plan = activeTaskPlans.get(taskContext.planId);
      if (plan && result.ok) {
        plan.done = Math.max(Number(plan.done) || 0, taskContext.step);
        plan.nextStep = Math.max(Number(plan.nextStep) || 0, taskContext.step);
      }
      planData = {
        planId: taskContext.planId, step: taskContext.step, total: taskContext.total,
        label: taskContext.label, done: Boolean(result.ok),
        nextStep: plan ? Math.min(plan.steps.length + 1, (Number(plan.nextStep) || 0) + 1) : null,
      };
    }
    sse(res, 'delta', { t: say });
    // v5 §4：技能调用 = 读出 SKILL.md 正文 → 用模型按它做一次（不是只回一句"已加载"）。
    const skill = result.ok && result.data && result.data.capability;
    if (skill && skill.content) {
      const capabilitySystem = buildPersonaSystemPrompt(persona, {
        env: '', mood, userText: text, inputMode: 'text',
      }) + '\n' + buildCapabilityPrompt()
        + '\n【已加载技能·必须照做】' + String(skill.name || skill.id) + '\n' + String(skill.content).slice(0, 4000);
      let answer = '';
      try {
        answer = await callPersonaJson(config, capabilitySystem, text || String(skill.input || ''), 700, 20000);
      } catch { answer = ''; }
      if (answer) {
        sse(res, 'delta', { t: String(answer).slice(0, 1200) });
        if (persona) recordPersonaEvent(persona, { kind: 'action', importance: 7, text: `技能：${skill.name || skill.id}`.slice(0, 500) });
        sse(res, 'done', {
          emotion: 'happy', intent: 'action', tool, verified: true, ok: true,
          capability: skill.id, capabilityKind: skill.kind, source: 'skill-filesystem',
          data: { capability: { id: skill.id, name: skill.name }, plan: planData },
          mood: mood.mood, rate: mood.rate, personaId: persona && persona.id, personaType: persona && persona.type,
        });
        res.end();
        return;
      }
    }
    // 任务 §1.2：唱歌不是"念"，把音频 + 逐行时间戳单独发一个事件，客户端边放边高亮歌词。
    const sing = result.ok && result.data && result.data.sing;
    if (sing && sing.audioUrl) sse(res, 'sing', { ...sing, ts: Date.now() });
    sse(res, 'done', {
      emotion: result.ok ? 'happy' : 'calm',
      intent: 'action',
      tool,
      verified: result.verified === true,
      ok: result.ok === true,
      data: { ...(result.data || {}), ...(planData ? { plan: planData } : {}) },
      capability: capability ? capability.id : undefined,
      mood: mood.mood,
      rate: mood.rate,
      personaId: persona && persona.id,
      personaType: persona && persona.type,
    });
    res.end();
  }

  /** 权限为 deny：明确拒绝 + 审计（特殊人设统一话术）。 */
  function refuseToolAction(res, persona, tool, args, mood, permission = 'deny', group = '') {
    const message = persona && persona.type === 'character'
      ? '我是特殊人设，不使用系统工具，所以不能执行这个操作。'
      : '这个我不能做。';
    auditTool(persona, tool, args, { permission, confirmed: false, result: 'denied', verified: false, error: message });
    sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'action', tool, personaId: persona && persona.id });
    sse(res, 'delta', { t: message });
    sse(res, 'done', {
      emotion: 'calm', intent: 'action', toolRefused: true, verified: false,
      tool, permission, group, personaId: persona && persona.id, personaType: persona && persona.type,
      mood: mood.mood, rate: mood.rate,
    });
    res.end();
  }

  /** 权限为 ask：发确认事件（语音说「好」或气泡按钮），先不执行。 */
  function askToolAction(req, res, persona, tool, args, mood, permission, group, taskContext = null) {
    const question = permissionQuestion(tool, group);
    const row = storeConfirm(req, {
      tool, args, personaId: persona && persona.id, permission, group, question, taskContext,
    });
    auditTool(persona, tool, args, { permission, confirmed: false, result: 'asked', verified: false, error: question });
    sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'action', tool, personaId: persona && persona.id });
    sse(res, 'confirm', {
      id: row.id, tool, group, permission, question,
      hardConfirm: toolNeedsConfirm(tool),
      options: [
        { value: 'allow', label: '允许' },
        { value: 'deny', label: '不允许' },
        { value: 'always', label: '以后都允许' },
        { value: 'never', label: '以后都别问' },
      ],
    });
    sse(res, 'delta', { t: question });
    sse(res, 'done', {
      emotion: 'calm', intent: 'action', tool, confirm: true, confirmId: row.id, verified: false,
      permission, group, personaId: persona && persona.id, personaType: persona && persona.type,
      mood: mood.mood, rate: mood.rate,
    });
    res.end();
  }

  /**
   * 模型兜底：只让模型回一行 JSON / 原生 tool_call。
   *
   * 兼容策略（工单 §1）：
   *   · OpenAI 兼容端点先带 `tools` 试原生 function calling；端点 400 再退回纯 JSON 提示；
   *   · Ollama 直接走 JSON（不同版本的 tools 支持不一致，避免 400 噪音）。
   * 任何一种解析失败都返回 null ⇒ 调用方按普通聊天处理，不报错。
   */
  async function classifyWithModel(config, text, persona = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const headers = { 'content-type': 'application/json' };
    if (config.provider === 'openai' && config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const url = config.provider === 'ollama' ? `${config.baseUrl}/api/chat` : `${config.baseUrl}/chat/completions`;
    const tools = personaToolRegistry(persona).map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    const messages = [
      { role: 'system', content: buildIntentSystemPrompt() },
      { role: 'user', content: text },
    ];
    const ask = async (withTools) => {
      const body = { model: config.model, stream: false, temperature: 0, messages };
      if (withTools) body.tools = tools;
      const response = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    };
    try {
      let doc = await ask(config.provider === 'openai');
      if (!doc && config.provider === 'openai') doc = await ask(false);
      if (!doc) return null;
      const message = config.provider === 'ollama'
        ? (doc.message || {})
        : (doc.choices && doc.choices[0] && doc.choices[0].message) || {};
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (calls.length) {
        const fn = (calls[0] && calls[0].function) || {};
        let args = {};
        try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {}); } catch { args = {}; }
        return normalizeModelIntent({ intent: 'action', tool: fn.name, args });
      }
      return normalizeModelIntent(parseIntentJson(message.content));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /pet-chat/tool-result —— 客户端执行完 SSE action 后的回执。 */
  async function handleToolResult(req, res) {
    let body = {};
    try { body = await readJsonBody(req, 8 * 1024); } catch { body = {}; }
    const id = String(body.id || '');
    const hit = id ? pendingClientActions.get(id) : null;
    if (hit) {
      pendingClientActions.delete(id);
      clearTimeout(hit.timer);
      const data = body.data && typeof body.data === 'object' ? body.data : {};
      hit.resolve({
        ok: body.ok !== false,
        targetId: String(body.targetId || data.targetId || ''),
        title: String(body.title || data.title || ''),
        percent: Number.isFinite(Number(body.percent)) ? Number(body.percent)
          : (Number.isFinite(Number(data.percent)) ? Number(data.percent) : undefined),
        verified: body.verified === true || data.verified === true,
        error: String(body.error || ''),
      });
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: Boolean(hit) }));
  }

  /** POST /pet-chat/tool-confirm —— 气泡按钮的确认/拒绝（与语音「好」等价）。 */
  async function handleToolConfirm(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const id = String(body.id || '');
    const decision = String(body.decision || 'allow').toLowerCase();
    const row = id ? pendingConfirmById.get(id) : null;
    if (!row) { send({ ok: false, code: 'confirm-not-found', hint: '这个确认已经过期了，再说一次吧' }, 404); return; }
    if (row.expiresAt < nowMs()) {
      dropConfirm(row);
      send({ ok: false, code: 'confirm-expired', hint: '确认超时了，再说一次吧' }, 410);
      return;
    }
    const persona = row.personaId ? readPersona(row.personaId) : getActivePersona();
    dropConfirm(row);
    if (!persona) { send({ ok: false, code: 'no-persona', hint: '没有可用人设' }, 400); return; }
    if (decision === 'deny' || decision === 'cancel') {
      auditTool(persona, row.tool, row.args, {
        permission: row.permission || 'ask', confirmed: false, result: 'cancelled', verified: false,
      });
      send({ ok: true, decision: 'deny', confirmed: false, say: '好，那就不办了。', verified: false });
      return;
    }
    if (decision === 'never') {
      const saved = setGroupPermission(persona, row.group || '', 'deny', 'deny');
      auditTool(saved || persona, row.tool, row.args, {
        permission: 'deny', confirmed: false, result: 'denied', verified: false,
        error: '用户选择以后都别问',
      });
      send({ ok: true, decision: 'never', say: '好，以后这类事我不做了。', verified: false, permissions: (saved || persona).permissions });
      return;
    }
    const always = decision === 'always';
    const effectivePersona = always && row.group
      ? (setGroupPermission(persona, row.group, 'allow', 'allow') || persona)
      : persona;
    if (!personaToolAllowed(effectivePersona)) {
      auditTool(effectivePersona, row.tool, row.args, {
        permission: 'deny', confirmed: false, result: 'denied', verified: false,
      });
      send({ ok: false, code: 'character-no-tools', say: '特殊人设不使用系统工具。', verified: false }, 403);
      return;
    }
    // 客户端动作：不在宿主执行，交回浏览器（客户端执行后自己说话/回执）。
    if (row.tool === 'wallpaper_switch' || row.tool === 'wallpaper_cycle') {
      auditTool(effectivePersona, row.tool, row.args, {
        permission: row.permission || 'ask', confirmed: true, result: 'delegated', verified: false,
      });
      send({
        ok: true, decision: always ? 'always' : 'allow', say: '',
        clientAction: { tool: row.tool, args: row.args || {} }, verified: false,
      });
      return;
    }
    const deps = buildToolDeps({ req, res: null, persona: effectivePersona, text: '', confirmed: true });
    let result;
    try {
      result = await runTool(row.tool, row.args || {}, deps);
    } catch {
      result = { ok: false, say: '这次没办成，我再试一次。', verified: false, data: {} };
    }
    auditTool(effectivePersona, row.tool, row.args, {
      permission: row.permission || 'ask', confirmed: true,
      result: result.ok ? 'ok' : 'failed', verified: result.verified === true,
      error: result.ok ? '' : String(result.say || ''),
      source: row.tool === 'capability_call' ? 'skill-filesystem' : 'chat',
      extra: row.taskContext ? { planId: row.taskContext.planId, step: row.taskContext.step } : null,
    });
    const say = String(result.say || (result.ok ? '办好了。' : '没办成。')).slice(0, 160);
    if (say) {
      const event = { type: 'speak', text: say, rate: readVoiceRaw().rate, ts: nowMs() };
      if (!broadcastSpeak(event)) {
        pendingSpeaks.push(event);
        while (pendingSpeaks.length > PENDING_SPEAK_MAX) pendingSpeaks.shift();
      }
    }
    send({
      ok: result.ok === true, decision: always ? 'always' : 'allow',
      say, verified: result.verified === true, data: result.data || {},
      permission: row.permission || 'ask', confirmed: true,
      permissions: effectivePersona.permissions,
    });
  }

  /** GET /pet-chat/tools —— 工具清单（设置页排障 / 判据读取；已按权限过滤）。 */
  function handleTools(res) {
    const persona = getActivePersona();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, personaId: persona && persona.id, tools: personaToolRegistry(persona) }));
  }

  /** POST /pet-chat/chat（SSE） —— 按 active persona 取模型/Key/记忆/工具权限。 */
  async function handleChat(req, res) {
    const ip = sourceOf(req);
    // 限频用真实墙钟：`clock` 是“语义时间”（给判据固定深夜），不能把两次请求压成同一刻。
    const wallNow = Date.now();
    const now = nowMs();
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

    if (wallNow - prev < RATE_LIMIT_MS) { fail('rate-limited', '一秒一次，慢点~'); return; }
    lastAt.set(ip, wallNow);

    let body;
    try { body = await readJsonBody(req); } catch { fail('bad-request', '请求体不是合法 JSON'); return; }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) { fail('bad-request', '说点什么吧'); return; }
    if ([...text].length > MAX_INPUT_CHARS) { fail('bad-request', `一次最多 ${MAX_INPUT_CHARS} 字`); return; }

    // 允许客户端指定 persona（切页/判据）；不传就用宿主 index.active。
    const requested = typeof body.personaId === 'string' ? readPersona(body.personaId) : null;
    const persona = requested || getActivePersona();
    if (!persona) { fail('no-persona', '先创建一个助手人设'); return; }
    const config = personaChatConfig(persona);
    if (!config.enabled) { fail('no-model', '先在设置里打开桌宠对话并填一个模型'); return; }

    /**
     * 语音/打字指令：**说"别说了"就静默**（到次日 0 点），说"可以说话了"就恢复。
     * 这是「零配置」里用户唯一的控制方式（追加决定 2），所以在这里拦一道，
     * 命中就不调模型（省 token，也让响应立刻生效）。
     */
    const command = parseSilenceCommand(text);
    if (command === 'silence') {
      enterSilence();
      setTtsMuted(true);
      sse(res, 'delta', { t: '好，那我安静一会儿。' });
      sse(res, 'done', { emotion: 'calm', command: 'silence', muted: true, personaId: persona.id });
      res.end();
      return;
    }
    if (command === 'resume') {
      clearSilence();
      setTtsMuted(false);
      sse(res, 'delta', { t: '好，我回来了。' });
      sse(res, 'done', { emotion: 'happy', command: 'resume', muted: false, personaId: persona.id });
      res.end();
      return;
    }

    if (config.provider === 'openai' && !config.apiKey) {
      fail('no-model', '这个助手人设还没有可用的模型 Key：去「人设 → 模型与 Key」填，或填 DeepSeek API Key 后开启继承全局');
      return;
    }

    const mood = detectMood(text, now);
    const inputMode = body.inputMode === 'voice' ? 'voice' : 'text';
    /**
     * v1.3：**每轮意图判定**（不持久化、没有“模式”）。
     * story / empathy 只看这一句话 + 上一轮是不是故事；旧字段 conversationMode 一律忽略。
     */
    const turnInfo = resolveTurnPolicy(text, { lastWasStory: lastStoryByPersona.has(persona.id) });
    const turnPolicy = turnInfo.policy;
    const storyContext = turnPolicy === 'story' && turnInfo.storyContinue
      ? String(lastStoryByPersona.get(persona.id) || '')
      : '';

    /* ── 情绪/危机：命中自伤词先用固定回应接住，不交给模型自由发挥 ── */
    if (turnPolicy === 'empathy') {
      const hit = detectCrisis(text);
      if (hit) {
        const safety = treeholeSafetyReply((config.treehole && config.treehole.hotline) || '12356');
        recordPersonaEvent(persona, {
          kind: 'treehole', importance: 8,
          text: `情绪·危机词（${hit}）：用户需要安全支持`,
        });
        sse(res, 'meta', { mood: mood.mood, rate: mood.rate, policy: 'empathy', safety: true });
        sse(res, 'delta', { t: safety });
        sse(res, 'done', {
          emotion: 'calm', safety: true, crisis: hit, policy: 'empathy', personaId: persona.id,
          mood: mood.mood, rate: mood.rate,
        });
        res.end();
        return;
      }
    }

    /**
     * 权限确认：**只有下一句是确认才执行**。
     * 其它任何话都清掉待确认状态，避免“隔着十句突然执行”。
     */
    const pending = pendingConfirms.get(ip);
    if (pending) {
      if (pending.personaId !== persona.id || pending.expiresAt < now) {
        dropConfirm(pending);
      } else if (isCancelText(text)) {
        dropConfirm(pending);
        auditTool(persona, pending.tool, pending.args, {
          permission: pending.permission || 'ask', confirmed: false, result: 'cancelled', verified: false,
        });
        sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'confirm' });
        sse(res, 'delta', { t: '好，那就不办了。' });
        sse(res, 'done', { emotion: 'calm', intent: 'confirm', cancelled: true, mood: mood.mood, rate: mood.rate, personaId: persona.id });
        res.end();
        return;
      } else if (isConfirmText(text)) {
        dropConfirm(pending);
        if (!personaToolAllowed(persona)) {
          refuseToolAction(res, persona, pending.tool, pending.args, mood, pending.permission || 'deny', pending.group || '');
          return;
        }
        await executeToolAction({
          req, res, tool: pending.tool, args: pending.args, text, confirmed: true, mood, config, persona,
          permission: pending.permission || 'ask', group: pending.group || '',
          taskContext: pending.taskContext || null,
        });
        return;
      } else {
        dropConfirm(pending);
      }
    }

    let intent = classifyIntent(text, { now });
    // v1.3：故事 / 情绪轮不抢工具动作（“继续讲”“今天好累”都按对话处理）。
    if (turnPolicy !== 'chat') {
      intent = { intent: 'chat', tool: null, args: {}, confidence: 'rule', reason: 'turn-policy' };
    }

    // 特殊人设：任何系统动作都明确拒绝（不执行、不弹确认、不调工具）。
    if (!personaToolAllowed(persona) && intent.intent === 'action') {
      recordPersonaEvent(persona, {
        kind: 'event', importance: 6,
        text: `特殊人设拒绝系统工具请求：${text.slice(0, 80)}`,
      });
      refuseToolAction(res, persona, intent.tool || 'system', intent.args || {}, mood, 'deny', '');
      return;
    }

    // 显式记忆：不走旧 memory.json，也不作为系统工具；直接写该 persona 的事件流。
    if (intent.intent === 'memory') {
      const note = preferenceText(text);
      recordPersonaEvent(persona, { kind: 'preference', importance: 8, text: note.text });
      pushPersonaHistory(persona.id, 'user', text);
      pushPersonaHistory(persona.id, 'assistant', `记下了：${note.text}`);
      sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'memory' });
      sse(res, 'delta', { t: `记下了：${note.text.replace(/^偏好：/, '')}。` });
      sse(res, 'done', {
        emotion: 'happy', intent: 'memory', verified: true,
        personaId: persona.id, personaType: persona.type, mood: mood.mood, rate: mood.rate,
      });
      res.end();
      return;
    }

    if (intent.tool === 'unsupported_danger') {
      // 高危但没有对应工具（例如「删除这个文件」）：仍先问确认；拒绝就什么都不做。
      const question = '删除是不可撤销的，先确认一下：真要执行删除吗？确认就说「确认」，不想就说「取消」。';
      const row = storeConfirm(req, {
        tool: 'unsupported_danger', args: intent.args || {}, personaId: persona.id,
        permission: 'ask', group: 'system', question,
      });
      auditTool(persona, 'unsupported_danger', intent.args || {}, {
        permission: 'ask', confirmed: false, result: 'asked', verified: false, error: question,
      });
      sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'action' });
      sse(res, 'confirm', {
        id: row.id, tool: 'unsupported_danger', group: 'system', permission: 'ask', question,
        options: [
          { value: 'allow', label: '确认' },
          { value: 'deny', label: '取消' },
        ],
      });
      sse(res, 'delta', { t: question });
      sse(res, 'done', {
        emotion: 'calm', intent: 'action', tool: 'unsupported_danger', confirm: true, confirmId: row.id,
        verified: false, personaId: persona.id, mood: mood.mood, rate: mood.rate,
      });
      res.end();
      return;
    }

    /* ── v5 §3：多步任务 / 教学 / 能力调用 ─────────────────────────────── */

    /** 本轮多步任务的上下文（执行时写进 tool-log 的 planId/step）。 */
    let taskContext = null;
    /** 「讲讲 X」：把教学提示拼进 system。 */
    let teachConcept = '';
    /** 本轮调用的能力（用于 done 诊断）。 */
    const capability = capabilityForText(text);

    if (intent.tool === 'task_plan') {
      const plan = buildTaskPlan(intent.args.goal || text, now);
      activeTaskPlans.set(plan.id, { ...plan, nextStep: 0, personaId: persona.id });
      if (activeTaskPlans.size > 20) {
        const oldest = activeTaskPlans.keys().next().value;
        if (oldest && oldest !== plan.id) activeTaskPlans.delete(oldest);
      }
      auditTool(persona, 'task_plan', { goal: plan.goal }, {
        permission: 'allow', confirmed: false, result: 'ok', verified: true,
        extra: { planId: plan.id, step: 0 },
      });
      const sentence = taskPlanSentence(plan);
      sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'task', tier: 'standard' });
      sse(res, 'plan', { id: plan.id, goal: plan.goal, steps: plan.steps, template: plan.template });
      sse(res, 'delta', { t: sentence });
      sse(res, 'done', {
        emotion: 'calm', intent: 'task', tool: 'task_plan', ok: true, verified: true,
        data: { plan: { id: plan.id, goal: plan.goal, steps: plan.steps } },
        mood: mood.mood, rate: mood.rate, personaId: persona.id,
      });
      pushPersonaHistory(persona.id, 'user', text);
      pushPersonaHistory(persona.id, 'assistant', sentence);
      res.end();
      return;
    }

    if (intent.tool === 'task_run') {
      const requestedPlan = intent.args.planId ? activeTaskPlans.get(String(intent.args.planId)) : null;
      const latest = requestedPlan || [...activeTaskPlans.values()].filter((item) => item.personaId === persona.id).pop();
      if (!latest) {
        sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'task' });
        sse(res, 'delta', { t: '还没有计划：先说「帮我拆成几步」再让我执行。' });
        sse(res, 'done', { emotion: 'calm', intent: 'task', tool: 'task_run', ok: false, personaId: persona.id });
        res.end();
        return;
      }
      const stepNo = Number(intent.args.step) > 0 ? Math.round(Number(intent.args.step)) : latest.nextStep + 1;
      if (stepNo > latest.steps.length) {
        const sentence = `计划「${latest.goal}」的 ${latest.steps.length} 步都做完了。`;
        sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'task' });
        sse(res, 'delta', { t: sentence });
        sse(res, 'done', {
          emotion: 'happy', intent: 'task', tool: 'task_run', ok: true, data: { planId: latest.id, done: true },
          mood: mood.mood, rate: mood.rate, personaId: persona.id,
        });
        res.end();
        return;
      }
      const step = latest.steps[stepNo - 1];
      latest.nextStep = Math.max(latest.nextStep, stepNo);
      taskContext = { planId: latest.id, step: stepNo, total: latest.steps.length, label: step.label };
      // 用这一步自己的工具继续走通用 action 流程（权限/确认/回读全部沿用）。
      intent = { intent: 'action', tool: step.tool, args: step.args || {}, confidence: 'rule', reason: 'task-step' };
    }

    if (intent.tool === 'perform_teach') {
      teachConcept = String((intent.args && intent.args.concept) || '').slice(0, 40);
      intent = { intent: 'chat', tool: null, args: {}, confidence: 'rule', reason: 'teach' };
    }

    // 教学任务用专门提示（类比 + 例子 + 一句总结），仍走标准档。
    if (teachConcept) {
      // 放到 request 之后统一拼 system（见 buildRequest 后）。
    }

    // 模型兜底只对 assistant 有价值：character 没有工具可调，模糊句直接当聊天。
    if (personaToolAllowed(persona) && shouldUseModelIntent(text, intent)) {
      const modelIntent = await classifyWithModel(config, text, persona);
      if (modelIntent) intent = modelIntent;
    }

    if (intent.intent === 'query' && (intent.args.query === 'time' || intent.args.query === 'date')) {
      const answer = intent.args.query === 'time' ? timeAnswer(now) : dateAnswer(now);
      sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'query', query: intent.args.query });
      sse(res, 'delta', { t: answer });
      sse(res, 'done', {
        emotion: 'calm', intent: 'query', query: intent.args.query,
        mood: mood.mood, rate: mood.rate, personaId: persona.id,
      });
      res.end();
      return;
    }

    // v5 §3：确定性快答（算术/单位）不调模型 —— 省延迟也不编答案。
    if ((intent.intent === 'chat' || intent.intent === 'query') && capability
      && (capability.id === 'math' || capability.id === 'unit')) {
      const local = localCapabilityAnswer(text, { now });
      if (local && local.ok) {
        pushPersonaHistory(persona.id, 'user', text);
        pushPersonaHistory(persona.id, 'assistant', local.text);
        sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'query', capability: local.capability, tier: 'quick' });
        sse(res, 'delta', { t: local.text });
        sse(res, 'done', {
          emotion: 'calm', intent: 'query', capability: local.capability, local: true,
          mood: mood.mood, rate: mood.rate, personaId: persona.id,
        });
        res.end();
        return;
      }
    }

    if (intent.intent === 'action') {
      const tool = intent.tool;
      if (tool && isKnownTool(tool)) {
        if (tool === 'memory_note') {
          const note = preferenceText(text || (intent.args && intent.args.text) || '');
          recordPersonaEvent(persona, { kind: 'preference', importance: 8, text: note.text });
          sse(res, 'meta', { mood: mood.mood, rate: mood.rate, intent: 'memory', personaId: persona.id });
          sse(res, 'delta', { t: `记下了：${note.text.replace(/^偏好：/, '')}。` });
          sse(res, 'done', {
            emotion: 'happy', intent: 'memory', verified: true,
            personaId: persona.id, personaType: persona.type, mood: mood.mood, rate: mood.rate,
          });
          res.end();
          return;
        }
        // v2：先查权限组（allow / ask / deny），再决定执行、追问还是拒绝。
        const policy = toolPolicy(persona, tool);
        if (!policy.allowed) {
          refuseToolAction(res, persona, tool, intent.args || {}, mood, policy.permission, policy.group || '');
          return;
        }
        const needsConfirm = policy.permission === 'ask' || toolNeedsConfirm(tool);
        if (needsConfirm) {
          askToolAction(req, res, persona, tool, intent.args || {}, mood, policy.permission, policy.group || '', taskContext);
          return;
        }
        await executeToolAction({
          req, res, tool, args: intent.args || {}, text, confirmed: false, mood, config, persona,
          permission: policy.permission, group: policy.group || '', taskContext,
        });
        return;
      }
      // 模型给了不认识的工具 / 解析失败 ⇒ 当普通聊天，不报错
      intent = { intent: 'chat', tool: null, args: {}, confidence: 'fallback', reason: 'unknown-tool' };
    }

    const env = buildEnvForChat(body);
    const recalled = retrieveEvents(persona.id, text, { topK: 8, tokenBudget: 800 });
    // 任务 §3①：本轮「内心步骤」（≤40 字，不展示、不进历史）。
    const inner = buildInnerStep(text, mood, { affect: persona.affect, inputMode, intent: intent.intent });
    // 任务 §3③：复杂问题才两步（先列 3 条要点，再生成最终回答）；简单寒暄不走，避免变慢。
    let outline = '';
    if (needsTwoStep(text, { inputMode }) && intent.intent === 'chat') {
      try {
        const rawOutline = await callPersonaJson(
          config,
          '你是回答前的策划器。只输出 3 条极短要点（每条不超过 20 字），一行一条，不要编号以外的解释、不要开场白。',
          text,
          200,
          5000,
        );
        const points = String(rawOutline || '')
          .split(/\n+/)
          .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
          .filter(Boolean)
          .slice(0, 3);
        outline = points.join('；').slice(0, 300);
      } catch { outline = ''; }
    }
    // 任务 §3⑤：连续抱怨时不要重复同一句安慰话术 —— 把最近回答的开头塞进 system 的「别重复」。
    const avoidLines = /累|烦|难受|难过|委屈|低落|不开心|压力|撑不住|崩溃/.test(text)
      ? comfortStarts(recentRepliesFor(persona.id))
      : [];
    const request = buildRequest(config, text, {
      env, mood, memories: recalled.items, inputMode, innerStep: inner.text, outline, avoidLines,
      turnPolicy, storyContext, voiceLength: config.voiceLength,
      maxTokens: turnPolicy === 'story' ? 6000 : 0,
    }, persona);
    // v5 §5：三档思考（语音/寒暄 quick；文字复杂 standard；分析/规划/写作 deep）。
    const tier = thinkingTier(text, { inputMode });
    // v5 §3：教学请求把"类比 + 例子 + 一句总结"写进 system。
    if (teachConcept) {
      try {
        request.body.messages[0].content += '\n【教学任务】用「类比 → 一个具体例子 → 一句总结」讲清「'
          + teachConcept + '」；先说他能听懂的版本，再补一句更准确的边界。不要列 1/2/3，不要用 Markdown。';
      } catch { /* 非 messages 协议就算了 */ }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let finished = false;
    const done = (emotion, usage) => {
      if (finished) return;
      finished = true;
      sse(res, 'done', {
        emotion, usage: usage || null, intent: intent.intent, tier,
        mood: mood.mood, rate: mood.rate, personaId: persona.id, personaType: persona.type,
        memories: recalled.items.length, memoryTokens: recalled.tokens,
        policy: turnPolicy, conversationMode: 'auto', voiceLength: config.voiceLength,
        ...(turnPolicy === 'story' ? { story: true, storyContinue: turnInfo.storyContinue === true } : {}),
        ...(turnPolicy === 'empathy' ? { empathy: true } : {}),
      });
      res.end();
    };

    /**
     * 深度档（仅文字；语音永远 quick）：要点 → 草稿 → 自检 → 最终。
     * 可切 deepseek-reasoner（`reasonerModelFor`）；>12s 直接降级用草稿，不让用户干等。
     */
    if (tier === 'deep' && !teachConcept && turnPolicy === 'chat') {
      const deepStart = Date.now();
      const deepConfig = { ...config, model: reasonerModelFor(config.model, tier) };
      let draft = '';
      try {
        draft = await callPersonaJson(deepConfig, request.body.messages[0].content, text, 800, 15000);
      } catch { draft = ''; }
      if (draft && Date.now() - deepStart < 12000) {
        try {
          const checked = await callPersonaJson(
            deepConfig,
            buildSelfCheckPrompt(),
            '用户原话：' + text + '\n\n草稿：\n' + draft,
            800,
            Math.max(2500, 14000 - (Date.now() - deepStart)),
          );
          if (checked) draft = checked;
        } catch { /* 自检失败就用草稿 */ }
      }
      if (draft) {
        sse(res, 'meta', {
          mood: mood.mood, rate: mood.rate, intent: intent.intent, tier: 'deep',
          capability: capability ? capability.id : undefined, personaId: persona.id,
          policy: turnPolicy,
          deep: { model: deepConfig.model, selfCheck: true, ms: Date.now() - deepStart },
        });
        // 分块发出去，前端仍是逐字出现（不是一次性大段）。
        const chunks = String(draft).match(/[\s\S]{1,32}/g) || [];
        for (const chunk of chunks) sse(res, 'delta', { t: chunk });
        pushPersonaHistory(persona.id, 'user', text);
        pushPersonaHistory(persona.id, 'assistant', String(draft));
        pushRecentReply(persona.id, String(draft));
        sse(res, 'done', {
          emotion: 'calm', intent: intent.intent, tier: 'deep', capability: capability ? capability.id : undefined,
          usage: null, mood: mood.mood, rate: mood.rate, personaId: persona.id, personaType: persona.type,
          deep: { model: deepConfig.model, selfCheck: true, ms: Date.now() - deepStart },
          memories: recalled.items.length, memoryTokens: recalled.tokens,
        });
        res.end();
        return;
      }
      // 深度档失败：继续走正常流式（standards），失败要能被用户看见。
    }

    sse(res, 'meta', {
      mood: mood.mood, rate: mood.rate, intent: intent.intent, tier,
      capability: capability ? capability.id : undefined, personaId: persona.id,
      policy: turnPolicy, ...(turnInfo.storyContinue ? { storyContinue: true } : {}),
    });

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
      // 兼容老判据：不带 inputMode 的请求仍按旧 maxChars 截断；故事轮永不截断。
      const legacyLimit = body.inputMode || turnPolicy === 'story' ? 0 : (Number(config.legacyMaxChars) || 80);
      /**
       * v1.3 语音回答长度：**只在 chat 轮**按句数限制（3/8/不限，默认 8）。
       * story / empathy 不限制（讲故事必须完整到结尾；共情允许短句但也可能多说两句）。
       * 到上限后**不 cancel 流**：模型继续生成、历史保留完整，只是不再往气泡推 delta。
       */
      const voiceLimit = turnPolicy === 'chat' && inputMode === 'voice'
        ? Math.max(0, Number(config.voiceLength) || 0) : 0;
      let voiceLimitReached = false;
      let stopped = false;
      const appendPiece = (piece) => {
        let chunk = String(piece || '');
        if (!chunk) return true;
        if (legacyLimit) {
          const room = legacyLimit - full.length;
          if (room <= 0) return false;
          if (chunk.length > room) chunk = chunk.slice(0, room);
        }
        if (voiceLimit > 0) {
          const combined = full + chunk;
          if (voiceLimitReached) {
            full = combined;
            return true;
          }
          let sentences = 0;
          let cut = -1;
          for (let i = 0; i < combined.length; i += 1) {
            if (/[。！？!?]/.test(combined[i])) {
              sentences += 1;
              if (sentences >= voiceLimit) { cut = i + 1; break; }
            }
          }
          if (cut >= 0 && cut < combined.length) {
            const visible = combined.slice(full.length, cut);
            full = combined;
            voiceLimitReached = true;
            if (visible) sse(res, 'delta', { t: visible });
            return true;
          }
          full = combined;
          sse(res, 'delta', { t: chunk });
          if (cut === combined.length) voiceLimitReached = true;
          return true;
        }
        full += chunk;
        sse(res, 'delta', { t: chunk });
        if (legacyLimit && full.length >= legacyLimit) return false;
        return true;
      };
      outer: for (;;) {
        // eslint-disable-next-line no-await-in-loop -- 流式读取必须逐块等
        const { value, done: ended } = await reader.read();
        if (ended) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          for (const piece of decodeStreamChunk(config.provider, line)) {
            if (!appendPiece(piece)) { stopped = true; break outer; }
          }
        }
      }
      if (stopped) {
        try { await reader.cancel(); } catch { /* ignore */ }
      }
      const parsed = parseReplyText(full);
      const emotion = parsed.emotion || emotionFromKeywords(parsed.reply);
      // 事件流：用户与助手都入库（无条数/时间上限）；反思每 5 轮自动采纳。
      pushPersonaHistory(persona.id, 'user', text);
      pushPersonaHistory(persona.id, 'assistant', parsed.reply);
      pushRecentReply(persona.id, parsed.reply);
      recordPersonaEvent(persona, { kind: 'chat', importance: 4, text: `用户：${text.slice(0, 500)}` });
      recordPersonaEvent(persona, { kind: 'chat', importance: 5, text: `我：${parsed.reply.slice(0, 1000)}` });
      // v1.3：故事轮记住上一段正文（内存，供“继续讲”衔接；不落盘）。
      if (turnPolicy === 'story' && parsed.reply) {
        lastStoryByPersona.set(persona.id, String(parsed.reply).slice(-3000));
      }
      // v1.3：情绪轮记住“在意的事/情绪触发点”（importance 6–8），但**不持久化任何模式**。
      if (turnPolicy === 'empathy') {
        recordPersonaEvent(persona, {
          kind: 'treehole', importance: 7,
          text: `情绪：用户说「${text.slice(0, 200)}」（先接情绪，不急着建议）`,
        });
      }
      // v1.2：从对话里抽实体写关系/好感度（保守规则，见 memory-db.extractEntities）。
      try { touchRelations(persona.id, text); } catch { /* 关系抽取失败不影响回复 */ }
      maybeReflect(persona, config);
      done(emotion, { chars: parsed.reply.length });
    } catch (error) {
      if (error && error.name === 'AbortError') fail('timeout', '模型 20 秒没回应，再试一次');
      else fail('bad-request', '连不上模型端点，检查设置里的地址');
    } finally {
      clearTimeout(timer);
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
        const worker = await ensureLocalAsr(readAsrBase());
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
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    // pre.62：ffmpeg 不在包里 ⇒ 首次点麦先触发懒下载并**立刻**回进度；
    // 客户端收到 ffmpeg-preparing 后轮询 /record（下载在后台继续），不显示“没听到声音”。
    const ffmpeg = ensureFfmpegStatus();
    if (!ffmpeg || ffmpeg.ok !== true) {
      const failed = ffmpeg && ffmpeg.phase === 'failed';
      send({
        ok: false,
        code: failed ? 'ffmpeg-failed' : 'ffmpeg-preparing',
        phase: (ffmpeg && ffmpeg.phase) || 'preparing',
        percent: Math.max(0, Math.min(100, Number(ffmpeg && ffmpeg.percent) || 0)),
        hint: failed
          ? '录音组件准备失败，检查网络后重试'
          : '正在准备录音组件，完成后会自动继续',
      }, failed ? 503 : 202);
      return;
    }
    const result = await voiceRecorder.record({
      maxMs: Number(body.maxMs) || undefined,
      silenceDb: body.silenceDb === undefined ? undefined : Number(body.silenceDb),
      silenceMs: Number(body.silenceMs) || undefined,
    });
    if (!result.ok) {
      const hints = {
        'no-device': '没找到可用麦克风（检查系统录音设备或是否被其它程序占用）',
        'too-quiet': '太小声了，离麦克风近一点（30–50cm）再说一次',
        'unsupported-platform': '这个系统不支持桌面录音，用浏览器打开 DSH 才能语音',
        'ffmpeg-missing': '缺少 ffmpeg，无法录音',
        timeout: '录音超时，再说一次',
        'no-speech': '没听到声音，再说一次或直接打字',
      };
      send({
        ok: false,
        code: result.code,
        hint: hints[result.code] || result.hint || '录音失败',
        attempts: result.attempts || [],
        devices: result.devices || [],
        lastWav: result.lastWav || null,
        lastWavBytes: result.lastWavBytes || 0,
        lastWavRms: result.lastWavRms == null ? null : result.lastWavRms,
      }, result.code === 'ffmpeg-missing' ? 503 : 422);
      return;
    }
    // ── 转写：本地 SenseVoice 优先；没装/没下好 ⇒ asr-not-ready，由客户端触发下载 ──
    try {
      // ⚠️ 不要在这里 await 356MB 的模型下载：请求会挂十几分钟，客户端也拿不到任何进度。
      // 第一次 Record 先回 asr-not-ready，客户端会走既有的 ensureAsrReady() 轮询 `/asr`；
      // 下载在后台继续，下一次点桌宠就能直接转写。
      if (!asrWorker && !asrInstalledOnDisk()) {
        void ensureLocalAsr(readAsrBase()).catch(() => { /* 失败状态由 /asr 的 phase=failed 回给界面 */ });
        send({
          ok: false,
          code: 'asr-not-ready',
          hint: ASR_NOT_READY_HINT,
          downloading: true,
          audioSeconds: result.audioSeconds,
        }, 422);
        return;
      }
      const worker = await ensureLocalAsr(readAsrBase());
      const spoken = await worker.request(result.audioPath, ASR_TIMEOUT_MS, { language: ASR_LANGUAGE, itn: true });
      if (!spoken || !spoken.ok) {
        send({ ok: false, code: 'asr-failed', hint: '识别失败，再试一次或直接打字' }, 502);
        return;
      }
      const text = String(spoken.text || '').trim();
      const chars = [...text.replace(/\s+/g, '')].length;
      // pre.57：短于 2 个字视为“没听清”，不要拿半截文本去回答。
      if (!chars || chars < 2) {
        send({
          ok: false,
          code: 'unclear',
          hint: chars ? '没听清，再说一次（这次只识别到很少的字）' : '没听清，再说一次或直接打字',
          text,
          audioSeconds: result.audioSeconds,
        }, 422);
        return;
      }
      noteAsrUsed();
      send({
        ok: true, text, ms: spoken.ms, audioSeconds: result.audioSeconds,
        inferenceSeconds: Number((spoken && spoken.inferenceSeconds) || 0),
        audioDb: result.audioDb ?? null,
      });
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
   * 只读探测 profile 的 node_modules（能力页/精选页共用；不联网、不扫安装路径/注册表）。
   * 返回 { version, engines } 或 null。
   */
  function findProfilePkg(name) {
    const profileRoot = join(homedir(), 'AppData', 'Roaming', 'dsh-desktop', 'harness', 'profiles', 'web');
    const roots = [
      join(profileRoot, 'node_modules'),
      join(profileRoot, 'node_modules', 'dsh-folia', 'node_modules'),
      join(profileRoot, '..', '.generations', 'live'),
    ];
    for (const root of roots) {
      const f = join(root, ...String(name || '').split('/'), 'package.json');
      try {
        if (existsSync(f)) {
          const j = JSON.parse(readFileSync(f, 'utf8'));
          return { version: j.version || null, engines: j.engines || null };
        }
      } catch { /* ignore */ }
    }
    return null;
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
    // 数据源：lib/capabilities-catalog.js（市场快照生成，按下载降序）
    const catalog = CAPABILITIES;

    const items = catalog.map((item) => {
      const hit = findProfilePkg(item.pkg);
      return { ...item, installed: !!hit, installedVersion: hit ? hit.version : null };
    });
    // pre.71：UI 据此标「需 DSH 执行 / 仅说明」；没有 agents 服务时不能假装可调用。
    const agentsAvailable = Boolean(services && services.agents && typeof services.agents.create === 'function');
    send({ ok: true, items, agentsAvailable });
  }

  /**
   * GET /pet-chat/capabilities/curated —— 「精选」20 套组合 + 各包安装版本。
   * `installed` 的 key 是包名，value 是版本或 null；只读 profile node_modules，不联网。
   */
  function handleCuratedCapabilities(res) {
    const installed = {};
    for (const bundle of CURATED_BUNDLES) {
      for (const step of (bundle.steps || [])) {
        if (!step || !step.pkg || Object.prototype.hasOwnProperty.call(installed, step.pkg)) continue;
        const hit = findProfilePkg(step.pkg);
        installed[step.pkg] = hit ? hit.version : null;
      }
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const agentsAvailable = Boolean(services && services.agents && typeof services.agents.create === 'function');
    res.end(JSON.stringify({ ok: true, bundles: CURATED_BUNDLES, personalTools: PERSONAL_TOOLS, installed, agentsAvailable }));
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
      lastError: asrState.lastError || null,
      // 下载进度 / 预计剩余时间（客户端状态条直接用）
      startedAt: asrState.startedAt || 0,
      etaSeconds: asrState.etaSeconds === null || asrState.etaSeconds === undefined ? null : Number(asrState.etaSeconds),
      attempt: Number(asrState.attempt) || 0,
      retries: Number(asrState.retries) || 3,
      retryAt: Number(asrState.retryAt) || 0,
      file: asrState.file || '',
      canRetry: asrState.phase === 'failed' || (asrState.phase === 'downloading' && Number(asrState.retryAt) > 0),
      mirror: readAsrBase(),
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
    // 触发后**立刻回**：客户端马上拿到响应去轮询 /asr 的百分比与 ETA；
    // 不能等 356MB 下完才回（旧版就是这样，用户以为点了没反应）。
    const job = ensureLocalAsr(readAsrBase());
    job.catch(() => { /* 失败状态由 /asr 的 phase=failed 回给界面 */ });
    send({
      ok: true,
      started: asrState.phase !== 'ready',
      phase: asrState.phase === 'idle' ? 'downloading' : asrState.phase,
      engine: 'local-sensevoice',
      retry: Number(asrState.attempt) || 0,
    });
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
      const ffState = await ensureFfmpegNow();
      if (!ffState || ffState.ok !== true) {
        steps.ffmpeg = {
          ok: false, phase: (ffState && ffState.phase) || 'idle',
          percent: Number(ffState && ffState.percent) || 0,
          error: (ffState && ffState.error) || 'ffmpeg 未就绪',
        };
        send({ ok: false, steps });
        return;
      }
      const ff = ffState.path;
      steps.ffmpeg = { ok: true, path: ff, phase: 'ready', percent: 100 };
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
            const worker = await ensureLocalAsr(readAsrBase()).catch(() => null);
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
        voice: publicVoice(readVoiceRaw()),
        wake: config.wake,
        // v1.2
        conversationMode: 'auto',
        voiceLength: config.voiceLength,
        proactive: config.proactive,
        screen: config.screen,
        treehole: config.treehole,
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
      const previous = readVoiceRaw();
      patch.voice = {
        ...previous,
        // v0.2：空串 = 宿主按 Edge 在线 → OpenAI（仅选中时）→ Piper → SAPI 的策略自动选音色。
        name: String(body.voice.name || '').slice(0, 120),
        muted: body.voice.muted === true,
        // /config 不负责 SAPI 开关的语义，但**不能把它抹掉**（/voice/config 单独持久化）。
        sapiEnabled: typeof body.voice.sapiEnabled === 'boolean' ? body.voice.sapiEnabled : previous.sapiEnabled === true,
      };
    }
    if (body.wake && typeof body.wake === 'object') {
      patch.wake = {
        click: body.wake.click !== false,
        name: body.wake.name === true,
        keyword: String(body.wake.keyword || '').trim().slice(0, 40),
      };
    }

    /* ── v1.2 会话模式 / 语音长度 / 主动思维 / 屏幕感知 / 树洞 ───────────── */
    // v1.3：不再接受“会话模式”写入（旧字段保留在设置里仅为兼容，运行时忽略）。
    if ([0, 3, 8].includes(Number(body.voiceLength))) patch.voiceLength = Number(body.voiceLength);
    if (body.proactive && typeof body.proactive === 'object') {
      const previous = current.proactive || {};
      const interval = [0, 15, 30, 60].includes(Number(body.proactive.intervalMin))
        ? Number(body.proactive.intervalMin) : previous.intervalMin;
      const clock = (value, fallback) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? String(value) : fallback);
      patch.proactive = {
        enabled: body.proactive.enabled === true && interval !== 0,
        intervalMin: interval,
        quietFrom: clock(body.proactive.quietFrom, previous.quietFrom),
        quietTo: clock(body.proactive.quietTo, previous.quietTo),
      };
    }
    if (body.screen && typeof body.screen === 'object') {
      const previous = current.screen || { mode: 'off', confirmed: false };
      const mode = ['off', 'app', 'ocr'].includes(body.screen.mode) ? body.screen.mode : previous.mode;
      // 从 off 打开任何一级都要**二次确认**（UI 弹说明后带 confirm:true 再来一次）；
      // 单纯把 confirmed 置 true 但不改 mode 不允许，避免“绕过说明直接开”。
      if (mode !== 'off' && previous.mode === 'off' && body.screen.confirm !== true) {
        send({ ok: false, code: 'screen-confirm-required', hint: '开启屏幕感知前需要先看说明并二次确认' }, 409);
        return;
      }
      patch.screen = { mode, confirmed: mode === 'off' ? false : (body.screen.confirm === true || previous.confirmed === true) };
    }
    if (body.treehole && typeof body.treehole === 'object') {
      patch.treehole = {
        hotline: typeof body.treehole.hotline === 'string' && body.treehole.hotline.trim()
          ? body.treehole.hotline.trim().slice(0, 40) : (current.treehole || {}).hotline || '12356',
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
   * 主动搭话：客户端周期性问一次"现在能说吗"，策略全在服务端。
   *
   * v2 两种入口：
   *   · `{event:'wallpaper'|'work'|'greeting'|'night'}` —— 事件触发（换壁纸 30 秒后 /
   *     连续工作 45 分钟 / 早晚问候），不受“空闲 10 分钟”限制，但同样受静默、每日 ≤3 次、
   *     正在朗读/正在听的约束；
   *   · 不带 event —— 旧版空闲搭话（40–90 分钟节奏），判据 H① 不动。
   */
  async function handleProactiveTick(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const now = nowMs();
    const event = String(body.event || body.trigger || '').trim();
    if (event) {
      const decision = canEventSpeak({
        event,
        now,
        speaking: body.speaking === true,
        listening: body.listening === true,
        sinceMs: Number(body.sinceMs ?? body.wallpaperSinceMs),
        activeMinutes: Number(body.activeMinutes),
      });
      let line = null;
      if (decision.ok) {
        const built = buildEventLine({
          event,
          wallpaperTitle: body.wallpaperTitle,
          activeMinutes: body.activeMinutes,
          now,
        });
        markEventSaid(event, now, built.line);
        line = built.line;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        ok: decision.ok, reason: decision.reason, line, event,
        source: 'event', usage: todayUsage(now), rules: EVENT_RULES,
      }));
      return;
    }
    const config = readPetChat();
    const decision = canSpeak({
      idleMinutes: Number(body.idleMinutes) || 0,
      fullscreen: body.fullscreen === true,
      randomHit: body.randomHit !== false,
      now,
    });
    let line = null;
    // v1.2：主动搭话默认关。静默（用户说过“别说了”）优先于“默认关”，
    // 这样排障时能明确区分 “silent” 与 “disabled”。
    if (!decision.ok && decision.reason !== 'silent' && config.proactive.enabled !== true) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, reason: 'disabled', line: null, usage: todayUsage(now), enabled: false }));
      return;
    }
    if (decision.ok) {
      const state = readProactiveState(now);
      const active = getActivePersona();
      const built = buildProactiveLine({
        wallpaperTitle: body.wallpaperTitle,
        memory: { likes: active && active.core ? active.core.values : [] },
        usedLines: state.usedLines,
        now,
      });
      markSaid(now, built.line);
      line = built.line;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: decision.ok, reason: decision.reason, line, usage: todayUsage(now) }));
  }

  /* ── v1.2 主动思维（内心 tick）────────────────────────────────────────── */

  /**
   * 一次内心 tick：先过设置/勿扰/忙碌/静默闸门，再让 pet-chat-mind 决策。
   * 与 `/proactive/tick` 的区别：这是**没有外部事件**时的主动思考（默认关）。
   */
  async function handleMindTick(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    const config = readPetChat();
    const now = nowMs();
    const persona = getActivePersona();
    // 静默口令优先于“默认关”：用户说过“别说了”，任何 tick 都回 silent。
    if (isSilent(now)) {
      send({ ok: false, reason: 'silent', action: 'none', line: '', enabled: config.proactive.enabled });
      return;
    }
    if (config.proactive.enabled !== true) {
      send({ ok: false, reason: 'disabled', action: 'none', line: '', enabled: false });
      return;
    }
    let foreground = null;
    if (config.screen.mode !== 'off') {
      try { foreground = await readForegroundWindow(); } catch { foreground = null; }
      if (foreground && (foreground.locked || foreground.sensitive)) foreground = null;
    }
    const memories = persona ? retrieveEvents(persona.id, '', { topK: 3, tokenBudget: 300 }).items : [];
    const decision = mindTick({
      now,
      enabled: true,
      intervalMin: config.proactive.intervalMin,
      quietFrom: config.proactive.quietFrom,
      quietTo: config.proactive.quietTo,
      speaking: body.speaking === true,
      listening: body.listening === true,
      turnBusy: body.turnBusy === true,
      muted: Boolean(config.voice && config.voice.muted),
      silent: isSilent(now),
      activeMinutes: Number(body.activeMinutes) || 0,
      app: foreground ? foreground.app : '',
      title: foreground ? foreground.title : '',
      wallpaperTitle: body.wallpaperTitle,
      memories,
      observationText: body.observationText,
      state: readMindState(now),
    });
    if ((decision.action === 'speak' || decision.action === 'ask') && decision.line) {
      markMindSaid(now, decision.line, decision.kind);
      if (persona) {
        recordPersonaEvent(persona, { kind: 'event', importance: 3, text: `我主动搭话：${decision.line.slice(0, 200)}` });
      }
      // 只有真的“过闸并落地”才记账：被勿扰/静默挡下的 tick 不该吃掉 15 分钟间隔。
      markMindTick(now);
    } else if (decision.action === 'record') {
      if (body.observationText && persona) {
        recordObservation(persona.id, { text: String(body.observationText).slice(0, 200), importance: 2, source: 'mind' });
      }
      markMindTick(now);
    }
    send({
      ok: decision.action === 'speak' || decision.action === 'ask',
      ...decision,
      enabled: true,
      usage: { state: readMindState(now), rules: MIND_RULES },
    });
  }

  function handleMindState(res) {
    const config = readPetChat();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      ok: true,
      enabled: config.proactive.enabled === true,
      config: config.proactive,
      state: readMindState(),
      rules: MIND_RULES,
      silent: isSilent(),
    }));
  }

  /* ── v1.2 屏幕感知：采样 + 观察记录 ─────────────────────────────────────── */

  /** 采样节流状态（进程内；重启重置）。 */
  const observeLast = { foregroundAt: 0, ocrAt: 0, text: '', textAt: 0 };
  let observeTimer = null;

  /**
   * 采一次：Level 1 前台窗口 → Level 2（可选）屏幕 OCR。
   * 默认关（`screen.mode === 'off'` 时**不调用任何 PowerShell**）。
   * @param {{force?:boolean}} [options]
   */
  async function observeOnce(options = {}) {
    const config = readPetChat();
    if (config.screen.mode === 'off') return { ok: false, reason: 'disabled', records: 0 };
    const persona = getActivePersona();
    if (!persona) return { ok: false, reason: 'no-persona', records: 0 };
    const now = nowMs();
    if (!options.force && observeLast.foregroundAt && now - observeLast.foregroundAt < OBSERVE_RULES.foregroundMs) {
      return { ok: false, reason: 'throttled', records: 0 };
    }
    observeLast.foregroundAt = now;
    const foreground = await readForegroundWindow();
    if (!foreground.ok) return { ok: false, reason: foreground.reason || 'foreground-failed', records: 0 };
    if (foreground.locked || isLockScreen(foreground.app, foreground.title)) {
      return { ok: false, reason: 'locked', records: 0 };
    }
    if (foreground.sensitive || isSensitiveApp(foreground.app, foreground.title)) {
      return { ok: false, reason: 'sensitive', records: 0, app: foreground.app };
    }
    let records = 0;
    const text = foregroundObservation(foreground);
    if (text && (options.force || text !== observeLast.text || now - observeLast.textAt > OBSERVE_RULES.dedupeMs)) {
      recordObservation(persona.id, { text, importance: 2, source: 'foreground' });
      observeLast.text = text;
      observeLast.textAt = now;
      records += 1;
    }
    let ocr = null;
    if (config.screen.mode === 'ocr' && (options.force || !observeLast.ocrAt || now - observeLast.ocrAt >= OBSERVE_RULES.ocrMs)) {
      observeLast.ocrAt = now;
      ocr = await captureScreenOcr({ maxChars: 600 });
      const ocrText = ocrObservation(ocr);
      if (ocrText) {
        recordObservation(persona.id, { text: ocrText, importance: 3, source: 'ocr' });
        records += 1;
      }
    }
    return {
      ok: true, records,
      app: foreground.app, title: foreground.title,
      ocr: ocr ? { ok: ocr.ok, chars: ocr.chars || 0, reason: ocr.reason || '' } : null,
      mode: config.screen.mode,
    };
  }

  function observeStatus() {
    const config = readPetChat();
    const persona = getActivePersona();
    return {
      ok: true,
      mode: config.screen.mode,
      enabled: config.screen.mode !== 'off',
      confirmed: config.screen.confirmed === true,
      records: persona ? listObservations(persona.id, { limit: 1 }).total : 0,
      personaId: persona ? persona.id : '',
      rules: OBSERVE_RULES,
    };
  }

  async function handleObserveSample(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const result = await observeOnce({ force: body.force !== false });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  }

  /**
   * 后台采样循环：**每 30 秒问一次设置**，只有 `screen.mode !== 'off'` 才真的读窗口/截屏。
   * 定时器 `unref()`，不会拖住宿主退出；卸载时清掉。
   */
  function startObserveLoop() {
    if (observeTimer) return;
    observeTimer = setInterval(() => {
      void observeOnce().catch(() => {});
    }, 30000);
    if (typeof observeTimer.unref === 'function') observeTimer.unref();
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

  const TTS_UNAVAILABLE_HINT = '本机语音合成不可用（Edge 在线 / 内置离线音色 / 系统音色都没出声）';
  /** 最近一次 /tts 的真实结果（/tts/state 与排障用；不参与缓存）。 */
  let lastTts = null;

  /**
   * 「在线音色（需 Key）」的服务清单。
   * pre.57：OpenAI / Azure / ElevenLabs 三条真实接通（Key 只存本机覆盖层，
   * 调用失败回落到当前已启用的内置音色）；MiniMax / 火山 / 讯飞仍明确 coming-soon。
   */
  const OPENAI_TTS_VOICES = Object.freeze(['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']);
  const AZURE_TTS_VOICES = Object.freeze([
    'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunxiNeural',
    'zh-CN-YunyangNeural', 'zh-CN-YunxiaNeural', 'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  ]);
  const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
  const ONLINE_VOICE_PROVIDERS = Object.freeze([
    { id: 'volcengine', name: '火山引擎语音', available: true, status: 'available' },
    { id: 'azure', name: 'Azure 语音', available: true, status: 'available' },
    { id: 'openai', name: 'OpenAI TTS', available: true, status: 'available' },
    { id: 'elevenlabs', name: 'ElevenLabs', available: true, status: 'available' },
    {
      id: 'minimax', name: 'MiniMax 语音', available: false, status: 'coming-soon',
      reason: '官方语音接口需要 GroupId + 签名鉴权，当前版本尚未实现签名链路，不假装支持。',
    },
    {
      id: 'iflytek', name: '讯飞语音', available: false, status: 'coming-soon',
      reason: '需要 AppId / ApiKey / ApiSecret 与 WebSocket 鉴权，当前版本尚未接通。',
    },
  ]);

  function voiceConfig() {
    const voice = readVoiceRaw();
    return {
      sapiEnabled: voice.sapiEnabled === true,
      enabledEngine: voice.enabledEngine,
      continuous: voice.continuous !== false,
      listenPaused: voice.listenPaused === true,
      voice: {
        name: voice.name,
        muted: voice.muted,
        listenPaused: voice.listenPaused === true,
        rate: voice.rate,
        sapiEnabled: voice.sapiEnabled,
        enabledEngine: voice.enabledEngine,
        continuous: voice.continuous !== false,
      },
      providers: onlineProviderView(),
      defaults: {
        // 用户零配置：优先在线；ASR 与 Piper 都默认走同一个站点镜像。
        preferOnline: true,
        asrMirror: readAsrBase(),
        modelMirror: normalizeMirror(process.env.FOLIA_MODEL_MIRROR || DEFAULT_MODEL_MIRROR),
      },
    };
  }

  /** 宿主侧真正的在线渠道配置（含 Key；只在宿主内存/覆盖层用，绝不回给浏览器）。 */
  function onlineConfig() {
    const voice = readVoiceRaw();
    const online = (voice.online && typeof voice.online === 'object') ? voice.online : {};
    const openai = (online.openai && typeof online.openai === 'object') ? online.openai : {};
    const azure = (online.azure && typeof online.azure === 'object') ? online.azure : {};
    const eleven = (online.elevenlabs && typeof online.elevenlabs === 'object') ? online.elevenlabs : {};
    return {
      volcengine: volcHostConfig(),
      openai: {
        apiKey: String(openai.apiKey || ''),
        model: String(openai.model || 'gpt-4o-mini-tts'),
        voice: String(openai.voice || 'alloy'),
        enabled: openai.enabled !== false,
        lastOk: openai.lastOk === true,
        lastError: String(openai.lastError || ''),
        checkedAt: Number(openai.checkedAt) || 0,
      },
      azure: {
        apiKey: String(azure.apiKey || ''),
        region: String(azure.region || 'eastasia'),
        voice: String(azure.voice || 'zh-CN-XiaoxiaoNeural'),
        enabled: azure.enabled !== false,
        lastOk: azure.lastOk === true,
        lastError: String(azure.lastError || ''),
        checkedAt: Number(azure.checkedAt) || 0,
      },
      elevenlabs: {
        apiKey: String(eleven.apiKey || ''),
        voiceId: String(eleven.voiceId || ELEVENLABS_DEFAULT_VOICE),
        modelId: String(eleven.modelId || 'eleven_multilingual_v2'),
        enabled: eleven.enabled !== false,
        lastOk: eleven.lastOk === true,
        lastError: String(eleven.lastError || ''),
        checkedAt: Number(eleven.checkedAt) || 0,
      },
    };
  }

  function maskKey(key) {
    const text = String(key || '');
    if (!text) return '';
    if (text.length <= 7) return '••••';
    return text.slice(0, 3) + '•'.repeat(Math.max(4, Math.min(12, text.length - 7))) + text.slice(-4);
  }

  /** 给浏览器的在线渠道视图：不含 Key 原文。 */
  function onlineProviderView() {
    const cfg = onlineConfig();
    const oa = cfg.openai;
    const az = cfg.azure;
    const el = cfg.elevenlabs;
    const center = publicVoiceCenter();
    const volc = center.volcengine;
    const view = {
      volcengine: {
        id: 'volcengine', name: '火山引擎语音', available: true,
        // 任务 §2④：已配置 → 已验证（测试真通过过）；配置一改自动退回 configured。
        status: volc.configured ? (volc.lastOk ? 'verified' : 'configured') : 'unconfigured',
        verified: volc.verified === true,
        verifiedAt: Number(volc.verifiedAt) || 0,
        configured: volc.configured, hasKey: volc.configured,
        maskedKey: volc.maskedToken, maskedAppId: volc.maskedAppId, maskedToken: volc.maskedToken,
        cluster: volc.cluster, resourceId: volc.resourceId, subtype: volc.subtype,
        voice: volc.voiceId, voiceId: volc.voiceId, enabled: true,
        lastOk: volc.lastOk, lastError: volc.lastError, checkedAt: volc.checkedAt,
        verifiedSubtype: volc.verifiedSubtype, verifiedResourceId: volc.verifiedResourceId,
        verifiedVoiceId: volc.verifiedVoiceId, verifiedStatus: volc.verifiedStatus,
        voices: volc.voices, howTo: volc.howTo,
      },
      openai: {
        id: 'openai', name: 'OpenAI TTS', available: true,
        status: oa.apiKey ? (oa.lastOk ? 'connected' : 'configured') : 'unconfigured',
        configured: Boolean(oa.apiKey), hasKey: Boolean(oa.apiKey), maskedKey: maskKey(oa.apiKey),
        model: oa.model, voice: oa.voice, enabled: oa.enabled,
        lastOk: oa.lastOk, lastError: oa.lastError, checkedAt: oa.checkedAt,
        voices: OPENAI_TTS_VOICES.slice(),
      },
      azure: {
        id: 'azure', name: 'Azure 语音', available: true,
        status: az.apiKey ? (az.lastOk ? 'connected' : 'configured') : 'unconfigured',
        configured: Boolean(az.apiKey), hasKey: Boolean(az.apiKey), maskedKey: maskKey(az.apiKey),
        region: az.region, voice: az.voice, enabled: az.enabled,
        lastOk: az.lastOk, lastError: az.lastError, checkedAt: az.checkedAt,
        voices: AZURE_TTS_VOICES.slice(),
      },
      elevenlabs: {
        id: 'elevenlabs', name: 'ElevenLabs', available: true,
        status: el.apiKey ? (el.lastOk ? 'connected' : 'configured') : 'unconfigured',
        configured: Boolean(el.apiKey), hasKey: Boolean(el.apiKey), maskedKey: maskKey(el.apiKey),
        voiceId: el.voiceId, modelId: el.modelId, voice: el.voiceId, enabled: el.enabled,
        lastOk: el.lastOk, lastError: el.lastError, checkedAt: el.checkedAt,
        voices: [el.voiceId],
      },
    };
    const ordered = ['volcengine', 'azure', 'openai', 'elevenlabs'].map((id) => view[id]);
    const others = ONLINE_VOICE_PROVIDERS
      .filter((item) => !view[item.id])
      .map((item) => ({ ...item, configured: false, hasKey: false }));
    return [...ordered, ...others];
  }

  /** GET/POST /pet-chat/voice/config —— SAPI 总开关（默认关闭）。 */
  async function handleVoiceConfig(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      send({ ok: true, data: voiceConfig() });
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch { send({ ok: false, error: 'bad-json' }, 400); return; }
    const rawVoice = readVoiceRaw();
    const current = voiceConfig();
    const nextVoice = { ...rawVoice, ...current.voice };
    if (typeof body.sapiEnabled === 'boolean') nextVoice.sapiEnabled = body.sapiEnabled;
    if (typeof body.name === 'string') nextVoice.name = body.name.trim().slice(0, 120);
    if (typeof body.muted === 'boolean') nextVoice.muted = body.muted;
    if (typeof body.listenPaused === 'boolean') nextVoice.listenPaused = body.listenPaused;
    if (typeof body.continuous === 'boolean') nextVoice.continuous = body.continuous;
    if (typeof body.enabledEngine === 'string' && ['edge', 'piper', 'sapi'].includes(body.enabledEngine)) {
      nextVoice.enabledEngine = body.enabledEngine;
    }
    if (body.rate !== undefined && Number.isFinite(Number(body.rate))) {
      nextVoice.rate = Math.max(-10, Math.min(10, Math.round(Number(body.rate))));
    }
    const overlayPatch = { voice: nextVoice };
    if (typeof body.asrBaseUrl === 'string' && body.asrBaseUrl.trim()) overlayPatch.asrBaseUrl = normalizeMirror(body.asrBaseUrl);
    writeOverlay(overlayPatch);
    if (typeof body.name === 'string' && body.name.trim()) {
      try { setPreferredVoice(body.name.trim()); } catch { /* ignore */ }
    }
    send({
      ok: true, saved: true,
      data: {
        sapiEnabled: nextVoice.sapiEnabled === true,
        enabledEngine: nextVoice.enabledEngine,
        continuous: nextVoice.continuous !== false,
        listenPaused: nextVoice.listenPaused === true,
        voice: publicVoice(nextVoice),
        asrBaseUrl: readAsrBase(),
        defaults: voiceConfig().defaults,
      },
    });
  }

  function saveOnlineProvider(provider, patch) {
    const voice = readVoiceRaw();
    const online = (voice.online && typeof voice.online === 'object') ? voice.online : {};
    const current = (online[provider] && typeof online[provider] === 'object') ? online[provider] : {};
    const next = { ...current, ...patch };
    writeOverlay({ voice: { ...voice, online: { ...online, [provider]: next } } });
    return next;
  }

  /** GET /pet-chat/voice/piper/progress —— 离线音色下载进度（可轮询）。 */
  function handlePiperProgress(res) {
    const status = typeof ttsService.status === 'function' ? ttsService.status() : {};
    const progress = (status.piper && status.piper.progress) || { phase: 'idle' };
    jsonSend(res, {
      ok: true,
      installed: Boolean(status.piper && status.piper.installed),
      phase: progress.phase || 'idle',
      file: progress.file || '',
      doneBytes: Number(progress.doneBytes) || 0,
      totalBytes: Number(progress.totalBytes) || 0,
      percent: progress.percent === null || progress.percent === undefined ? null : Number(progress.percent),
      attempt: Number(progress.attempt) || 0,
      retries: Number(progress.retries) || 3,
      source: progress.source || '',
      error: progress.error || '',
      at: Number(progress.at) || 0,
    });
  }

  /** POST /pet-chat/voice/piper/prepare —— 显式准备离线兜底音色（下载 + 试合成）。 */
  async function handlePiperPrepare(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    let result;
    try {
      result = await ttsService.synthesize('离线音色准备好了。', {
        voice: 'piper:zh_CN-huayan-medium',
        rate: 0,
        policy: true,
        sapiEnabled: false,
        allowDownload: true,
        noCache: true,
        timeoutMs: 600000,
      });
    } catch (error) {
      result = { ok: false, error: String((error && error.message) || error) };
    }
    send({
      ok: Boolean(result && result.ok === true && result.engine === 'piper'),
      engine: result && result.engine ? result.engine : null,
      voice: result && result.voice ? result.voice : null,
      mime: result && result.mime ? result.mime : null,
      bytes: result && result.bytes ? Number(result.bytes) : 0,
      error: result && result.ok ? '' : String((result && (result.hint || result.error)) || '离线音色准备失败'),
    });
  }

  /** GET/POST /pet-chat/voice/providers —— 在线渠道配置（Key 只写不读）。 */
  async function handleVoiceProviders(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      send({ ok: true, providers: onlineProviderView() });
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch { send({ ok: false, error: 'bad-json' }, 400); return; }
    const provider = String(body.provider || '').toLowerCase();
    if (provider === 'volcengine' || provider === 'volc') {
      saveVolcConfig({
        appId: body.appId,
        accessToken: body.accessToken,
        cluster: body.cluster,
        resourceId: body.resourceId,
        subtype: body.subtype,
        voiceId: body.voiceId || body.voice,
        clearCredentials: body.clearCredentials === true || body.clearApiKey === true,
      });
      send({ ok: true, saved: true, provider: onlineProviderView().find((item) => item.id === 'volcengine') });
      return;
    }
    if (!['openai', 'azure', 'elevenlabs'].includes(provider)) {
      const known = ONLINE_VOICE_PROVIDERS.find((item) => item.id === provider);
      send({
        ok: false, code: 'provider-coming-soon',
        error: known && known.reason ? known.reason : '这个在线渠道还没接通；当前已真实接通 OpenAI / Azure / ElevenLabs',
      }, 400);
      return;
    }
    const patch = {};
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) patch.apiKey = body.apiKey.trim().slice(0, 4096);
    if (body.clearApiKey === true) patch.apiKey = '';
    if (provider === 'openai') {
      if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim().slice(0, 80);
      if (typeof body.voice === 'string' && body.voice.trim()) patch.voice = body.voice.trim().replace(/^openai:/i, '').slice(0, 40);
    } else if (provider === 'azure') {
      if (typeof body.region === 'string' && body.region.trim()) patch.region = body.region.trim().toLowerCase().slice(0, 40);
      if (typeof body.voice === 'string' && body.voice.trim()) patch.voice = body.voice.trim().replace(/^azure:/i, '').slice(0, 80);
    } else {
      if (typeof body.voiceId === 'string' && body.voiceId.trim()) patch.voiceId = body.voiceId.trim().replace(/^elevenlabs:/i, '').slice(0, 80);
      if (typeof body.modelId === 'string' && body.modelId.trim()) patch.modelId = body.modelId.trim().slice(0, 80);
    }
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    patch.lastOk = false;
    patch.lastError = '';
    patch.checkedAt = 0;
    saveOnlineProvider(provider, patch);
    send({ ok: true, saved: true, provider: onlineProviderView().find((item) => item.id === provider) });
  }

  /** 各在线渠道的请求音色。 */
  function providerVoice(provider, cfg) {
    if (provider === 'openai') return 'openai:' + String(cfg.voice || 'alloy');
    if (provider === 'azure') return 'azure:' + String(cfg.voice || 'zh-CN-XiaoxiaoNeural');
    return 'elevenlabs:' + String(cfg.voiceId || ELEVENLABS_DEFAULT_VOICE);
  }

  /** POST /pet-chat/voice/providers/test —— 真调一次；失败回可读原因，并标回落。 */
  async function handleVoiceProviderTest(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const provider = String(body.provider || 'openai').toLowerCase();
    if (provider === 'volcengine' || provider === 'volc') {
      const cfg = onlineConfig().volcengine;
      if (!cfg.hasCredentials) {
        send({
          ok: false, code: 'volcengine-no-key', provider: 'volcengine', engine: 'volc',
          status: 0, bodySnippet: '', url: String(cfg.baseUrl || ''), resourceId: cfg.resourceId || '',
          voiceId: cfg.voiceId || '', fallback: false,
          error: '没有填火山 AppID / Access Token', hint: '先填 AppID 与 Access Token 再点「测试」',
        }, 200);
        return;
      }
      // 任务 §2①：真诊断（status + bodySnippet + url + resourceId + voiceId + engine）。
      // 宿主 TTS 服务实现 `volcTest` 时走它；判据/替身服务没有这个方法时退回合成探测。
      let diag = null;
      if (typeof ttsService.volcTest === 'function') {
        try { diag = await ttsService.volcTest(cfg); } catch (error) {
          diag = {
            ok: false, engine: 'volc', status: 0, code: 'volc-test-failed',
            error: String((error && error.message) || error).slice(0, 300),
            subtype: cfg.subtype, resourceId: cfg.resourceId, voiceId: cfg.voiceId, url: '', bodySnippet: '',
          };
        }
      }
      if (diag && typeof diag === 'object') {
        const providerOk = diag.ok === true;
        markVolcTest(providerOk, providerOk ? '' : (diag.error || diag.code), {
          subtype: diag.subtype || cfg.subtype,
          resourceId: diag.resourceId || cfg.resourceId,
          voiceId: diag.voiceId || cfg.voiceId,
          status: diag.status,
          url: diag.url,
        });
        const view = publicVoiceCenter().volcengine;
        send({
          ok: providerOk,
          provider: 'volcengine',
          engine: 'volc',
          subtype: diag.subtype || cfg.subtype,
          status: Number(diag.status) || 0,
          code: String(diag.code || (providerOk ? 'ok' : 'volc-failed')),
          bodySnippet: String(diag.bodySnippet || '').slice(0, 300),
          url: String(diag.url || ''),
          resourceId: String(diag.resourceId || cfg.resourceId || ''),
          cluster: String(diag.cluster || cfg.cluster || ''),
          voiceId: String(diag.voiceId || cfg.voiceId || ''),
          maskedAppId: String(diag.maskedAppId || view.maskedAppId || ''),
          maskedToken: String(diag.maskedToken || view.maskedToken || ''),
          fallback: false,
          bytes: Number(diag.bytes) || 0,
          mime: String(diag.mime || ''),
          actualVoice: providerOk ? ('volc:' + String(diag.voiceId || cfg.voiceId || '')) : null,
          error: providerOk ? '' : String(diag.error || '火山调用失败').slice(0, 500),
          hint: String(diag.hint || ''),
          verified: providerOk && view.lastOk === true,
          verifiedSubtype: view.verifiedSubtype || '',
          verifiedResourceId: view.verifiedResourceId || '',
          checkedAt: view.checkedAt,
          diagnostic: {
            status: Number(diag.status) || 0,
            code: String(diag.code || ''),
            bodySnippet: String(diag.bodySnippet || '').slice(0, 300),
            url: String(diag.url || ''),
            resourceId: String(diag.resourceId || cfg.resourceId || ''),
            voiceId: String(diag.voiceId || cfg.voiceId || ''),
            engine: 'volc',
            subtype: String(diag.subtype || cfg.subtype || ''),
            maskedAppId: String(diag.maskedAppId || view.maskedAppId || ''),
            maskedToken: String(diag.maskedToken || view.maskedToken || ''),
          },
          attempts: [],
        });
        return;
      }
      let result;
      try {
        result = await ttsService.synthesize('你好，我是你的桌宠。', {
          voice: 'volc:' + (cfg.voiceId || ''),
          rate: 0,
          policy: true,
          online: onlineConfig(),
          noCache: true,
          timeoutMs: 25000,
        });
      } catch (error) {
        result = { ok: false, error: String((error && error.message) || error) };
      }
      const providerOk = Boolean(result && result.ok === true && result.engine === 'volc');
      const providerAttempt = (result && Array.isArray(result.attempts) ? result.attempts : [])
        .find((item) => item && item.engine === 'volc');
      const errorText = providerOk ? ''
        : String((providerAttempt && providerAttempt.error) || (result && (result.hint || result.error)) || '火山调用失败');
      markVolcTest(providerOk, errorText, {
        subtype: (result && result.subtype) || cfg.subtype,
        resourceId: cfg.resourceId, voiceId: cfg.voiceId, status: providerOk ? 200 : 0, url: '',
      });
      send({
        ok: providerOk,
        provider: 'volcengine',
        engine: 'volc',
        subtype: (result && result.subtype) || cfg.subtype,
        status: providerOk ? 200 : 0,
        code: providerOk ? 'ok' : ((providerAttempt && providerAttempt.code) || (result && result.code) || 'volc-failed'),
        bodySnippet: '',
        url: '',
        resourceId: cfg.resourceId || '',
        voiceId: cfg.voiceId || '',
        actualVoice: result && result.voice ? result.voice : null,
        mime: result && result.mime ? result.mime : null,
        bytes: result && result.bytes ? Number(result.bytes) : 0,
        fallback: Boolean(result && result.ok && !providerOk),
        error: providerOk ? '' : errorText.slice(0, 500),
        verified: providerOk,
        attempts: (result && result.attempts) || [],
      });
      return;
    }
    if (!['openai', 'azure', 'elevenlabs'].includes(provider)) {
      send({ ok: false, code: 'provider-coming-soon', error: '这个在线渠道还没接通' }, 400);
      return;
    }
    const cfg = onlineConfig()[provider];
    if (!cfg.apiKey) {
      send({ ok: false, code: provider + '-no-key', error: '没有填 ' + provider + ' Key', provider }, 200);
      return;
    }
    const rawVoice = readVoiceRaw();
    let result;
    try {
      result = await ttsService.synthesize('你好，我是你的桌宠。', {
        voice: providerVoice(provider, cfg),
        rate: 0,
        policy: true,
        activeEngine: rawVoice.enabledEngine,
        sapiEnabled: rawVoice.sapiEnabled === true,
        allowDownload: false,
        online: onlineConfig(),
        noCache: true,
        timeoutMs: 45000,
      });
    } catch (error) {
      result = { ok: false, error: String((error && error.message) || error) };
    }
    const providerOk = Boolean(result && result.ok === true && result.engine === provider);
    const providerAttempt = (result && Array.isArray(result.attempts) ? result.attempts : [])
      .find((item) => item && item.engine === provider);
    const errorText = providerOk ? ''
      : String((providerAttempt && providerAttempt.error) || (result && (result.hint || result.error)) || provider + ' 调用失败');
    saveOnlineProvider(provider, {
      lastOk: providerOk,
      lastError: providerOk ? '' : errorText.slice(0, 500),
      checkedAt: Date.now(),
    });
    send({
      ok: providerOk,
      provider,
      engine: result && result.engine ? result.engine : null,
      actualVoice: result && result.voice ? result.voice : null,
      mime: result && result.mime ? result.mime : null,
      bytes: result && result.bytes ? Number(result.bytes) : 0,
      fallback: Boolean(result && result.ok && !providerOk),
      error: providerOk ? '' : errorText.slice(0, 500),
      attempts: (result && result.attempts) || [],
    });
  }

  /**
   * POST /pet-chat/voice/enable —— 勾选一个内置音色并「启用」：
   * Edge 探活 / Piper 下载 / SAPI 显式开启 → 播测试句；成功后才切换唯一启用项。
   */
  async function handleVoiceEnable(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const engine = String(body.engine || '').toLowerCase();
    if (!['edge', 'piper', 'sapi'].includes(engine)) {
      send({ ok: false, code: 'bad-engine', error: '只支持 Edge / Piper / SAPI 三个内置音色' }, 400);
      return;
    }
    const rawVoice = readVoiceRaw();
    let chosenVoice = '';
    if (engine === 'edge') chosenVoice = 'zh-CN-XiaoxiaoNeural';
    else if (engine === 'piper') chosenVoice = 'piper:zh_CN-huayan-medium';
    else {
      try {
        const list = await ttsService.voices({ sapiEnabled: true });
        const first = (Array.isArray(list) ? list : []).find((item) => item && item.engine === 'sapi' && item.usable);
        chosenVoice = first ? String(first.id) : '';
      } catch { chosenVoice = ''; }
    }
    let result;
    try {
      result = await ttsService.synthesize('你好，我是你的桌宠。现在用这个音色说话。', {
        voice: chosenVoice,
        rate: rawVoice.rate || 0,
        // 强制单引擎：启用流程不偷偷借用别的音色，失败就照实报。
        policy: true,
        activeEngine: engine,
        sapiEnabled: engine === 'sapi',
        allowDownload: engine === 'piper',
        noCache: true,
        timeoutMs: engine === 'piper' ? 600000 : 45000,
      });
    } catch (error) {
      result = { ok: false, error: String((error && error.message) || error) };
    }
    const ok = Boolean(result && result.ok === true && result.engine === engine);
    if (!ok) {
      send({
        ok: false, engine,
        error: String((result && (result.hint || result.error)) || '启用失败，没有合成出测试句'),
        attempts: (result && result.attempts) || [],
      });
      return;
    }
    const actualVoice = String(result.voice || chosenVoice || '');
    const nextVoice = {
      ...rawVoice,
      enabledEngine: engine,
      name: actualVoice,
      sapiEnabled: engine === 'sapi',
      continuous: rawVoice.continuous !== false,
    };
    writeOverlay({ voice: nextVoice });
    // 注意：启用不等于“设为全局默认”。全局默认由声音页的音色中心显式设置；
    // 这里只把 voice.name/enabledEngine 写好，避免“继承全局”被一键启用悄悄改掉。
    lastTts = {
      requestedVoice: actualVoice,
      actualVoice,
      engine,
      transport: String(result.transport || (engine === 'edge' ? 'online' : 'local')),
      mime: String(result.mime || 'audio/wav'),
      fallback: false,
      fallbackFrom: '',
      attempts: result.attempts || [],
      code: null,
      cached: false,
      at: Date.now(),
    };
    send({
      ok: true,
      engine,
      voice: actualVoice,
      mime: result.mime || null,
      bytes: Number(result.bytes) || 0,
      testText: '你好，我是你的桌宠。现在用这个音色说话。',
      enabledEngine: engine,
      sapiEnabled: engine === 'sapi',
    });
  }

/**
 * GET /pet-chat/voice/mic-test —— 固定录 3 秒，直接回 audio/wav + 诊断响应头。
 * 用途：用户点「测试麦克风」后亲耳听到自己刚录的声音。
 */
async function handleMicTest(req, res) {
  const sendJson = (payload, status = 200) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  };
  if (typeof voiceRecorder.recordFixed !== 'function') {
    sendJson({ ok: false, code: 'unsupported', hint: '当前版本不支持麦克风测试' }, 501);
    return;
  }
  const result = await voiceRecorder.recordFixed(3000);
  if (!result || !result.ok) {
    sendJson({
      ok: false,
      code: (result && result.code) || 'mic-test-failed',
      hint: '麦克风打不开或没采到音频',
      bytes: (result && result.bytes) || 0,
      device: (result && result.device) || null,
    }, 422);
    return;
  }
  try {
    const bytes = readFileSync(result.audioPath);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    // 中文设备名不能直接进 HTTP 头（Node 会报 Invalid character in header）⇒ URL 编码
    res.setHeader('X-Folia-Mic-Device', encodeURIComponent(String(result.device || '')));
    res.setHeader('X-Folia-Mic-Rms', String(result.audioRms == null ? '' : result.audioRms));
    res.setHeader('X-Folia-Mic-Db', String(result.audioDb == null ? '' : result.audioDb));
    res.setHeader('X-Folia-Mic-Bytes', String(result.bytes || bytes.length));
    res.end(bytes);
  } catch (error) {
    sendJson({ ok: false, code: 'mic-test-read-failed', error: String((error && error.message) || error) }, 500);
  }
}

  /**
   * GET /pet-chat/voice/diagnose —— 一次看完整条语音链：
   * ffmpeg / 麦克风 / 本地 ASR / TTS（Edge 在线、Piper 安装状态、SAPI 开关）/ 上次结果。
   * 只读：不触发下载、不合成、不录音。
   */
  async function handleVoiceDiagnose(res, url) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    // 轻量模式：只回 ffmpeg 进度（下载时 UI 每 800ms 轮询，不能每次都枚举麦克风/合成音色）。
    if (url && url.searchParams && url.searchParams.get('light') === '1') {
      const st = ffmpegProvisionStatus();
      const ffmpeg = {
        ok: st && st.ok === true,
        phase: (st && st.phase) || 'idle',
        percent: Math.max(0, Math.min(100, Number(st && st.percent) || 0)),
        downloaded: Number(st && st.downloaded) || 0,
        total: Number(st && st.total) || 0,
        path: (st && st.path) || '',
        error: (st && st.error) || '',
      };
      send({ ok: true, steps: { ffmpeg }, ffmpeg });
      return;
    }
    const config = voiceConfig();
    const steps = {};
    // pre.62：只读状态，不触发 70MB 下载；phase/percent 由内核 ffmpeg 供给器维护。
    try {
      const st = ffmpegProvisionStatus();
      steps.ffmpeg = {
        ok: st && st.ok === true,
        phase: (st && st.phase) || 'idle',
        percent: Math.max(0, Math.min(100, Number(st && st.percent) || 0)),
        downloaded: Number(st && st.downloaded) || 0,
        total: Number(st && st.total) || 0,
        path: (st && st.path) || '',
        error: (st && st.error) || '',
      };
      if (!steps.ffmpeg.ok && !steps.ffmpeg.phase) {
        const ff = await defaultResolveFfmpeg({ ensure: false });
        steps.ffmpeg = { ok: true, phase: 'ready', percent: 100, path: ff, downloaded: 0, total: 0, error: '' };
      }
    } catch (error) {
      steps.ffmpeg = { ok: false, phase: 'failed', percent: 0, error: String((error && error.message) || error) };
    }
    let devices = [];
    try {
      devices = await voiceRecorder.listDevices();
      steps.microphone = {
        ok: devices.length > 0,
        count: devices.length,
        devices,
        selected: pickDevice(devices),
      };
    } catch (error) {
      steps.microphone = { ok: false, count: 0, devices: [], error: String((error && error.message) || error) };
    }
    let voices = [];
    let meta = {};
    try {
      voices = typeof ttsService.voices === 'function' ? await ttsService.voices({ sapiEnabled: config.sapiEnabled }) : [];
      meta = typeof ttsService.voiceMeta === 'function' ? ttsService.voiceMeta() : {};
    } catch { voices = []; }
    const usable = (Array.isArray(voices) ? voices : []).filter((v) => v && v.usable === true);
    const piper = (meta && meta.piper) || { installed: false };
    const edge = (meta && meta.edge) || {};
    steps.tts = {
      ok: usable.length > 0 || Boolean(meta.defaultVoice),
      engines: TTS_ENGINES,
      policy: ['edge', 'piper', 'sapi'],
      sapiEnabled: config.sapiEnabled,
      defaultVoice: meta.defaultVoice || '',
      defaultEngine: meta.defaultEngine || '',
      usableCount: usable.length,
      edge: { ok: Boolean(edge.ok), error: edge.error || '', voices: Number(edge.voices) || 0, voice: edge.voice || '' },
      piper: { installed: piper.installed === true, sizeBytes: Number(piper.sizeBytes) || 0 },
      last: lastTts,
    };
    steps.asr = {
      engine: 'local-sensevoice',
      phase: asrState.phase,
      installed: asrInstalledOnDisk(),
      ready: asrState.phase === 'ready' || asrInstalledOnDisk(),
      error: asrState.error || null,
      providerPhase: (() => {
        try {
          const snapshot = speechToText && typeof speechToText.snapshot === 'function' ? speechToText.snapshot() : null;
          const provider = (snapshot && Array.isArray(snapshot.providers) ? snapshot.providers : [])
            .find((item) => item && item.id === ASR_PROVIDER_ID);
          return provider && provider.preparation ? provider.preparation.phase : 'missing';
        } catch { return 'missing'; }
      })(),
    };
    steps.providers = onlineProviderView();
    send({
      ok: true,
      platform: process.platform,
      config,
      steps,
      ffmpeg: steps.ffmpeg,
      microphone: steps.microphone,
      asr: steps.asr,
      tts: steps.tts,
      providers: steps.providers,
      defaults: voiceConfig().defaults,
      asrBaseUrl: readAsrBase(),
      lastTts,
    });
  }

  /**
   * POST /pet-chat/voice/setup —— 一键启用语音。
   *
   * 用户填完模型 Key 后点一次：选麦 → 预热 ASR → 选音色 → 真合成一短句 → 回报三步。
   * 任何一步失败都照实写进 `failed`，不把“没接通”伪装成成功。
   * 请求体可选：{ dryRun, skipCapture, sapiEnabled, allowDownload, maxMs }。
   */
  async function handleVoiceSetup(req, res) {
    const send = (payload, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    };
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const dryRun = body.dryRun === true;
    const rawVoice = readVoiceRaw();
    const config = { sapiEnabled: rawVoice.sapiEnabled === true, voice: rawVoice };
    const sapiEnabled = typeof body.sapiEnabled === 'boolean' ? body.sapiEnabled : config.sapiEnabled;
    if (typeof body.sapiEnabled === 'boolean') {
      writeOverlay({ voice: { ...config.voice, sapiEnabled } });
    }
    const failed = [];

    /* ⓪ pre.62：录音组件（ffmpeg）—— 不在 npm 包里，首次使用懒下载 */
    let ffmpegState = ffmpegProvisionStatus();
    if (!dryRun && body.allowDownload !== false) {
      try { ffmpegState = await ensureFfmpegNow(); } catch (error) {
        ffmpegState = { ok: false, phase: 'failed', percent: 0, error: String((error && error.message) || error) };
      }
    }
    const ffmpegOk = Boolean(ffmpegState && ffmpegState.ok === true);
    if (!ffmpegOk) {
      const reason = ffmpegState && ffmpegState.error
        ? ffmpegState.error
        : (dryRun || body.allowDownload === false ? '演练模式跳过下载' : '录音组件未就绪');
      failed.push('录音组件：' + reason);
    }
    const ffmpegStep = {
      id: 'ffmpeg',
      label: '语音组件',
      ok: ffmpegOk,
      phase: (ffmpegState && ffmpegState.phase) || 'idle',
      percent: Math.max(0, Math.min(100, Number(ffmpegState && ffmpegState.percent) || 0)),
      detail: ffmpegOk
        ? 'ffmpeg 已就绪（离线录音/转码共用）'
        : ((ffmpegState && (ffmpegState.phase === 'download' || ffmpegState.phase === 'preparing'))
          ? '正在准备录音组件 ' + Math.max(0, Math.min(100, Number(ffmpegState.percent) || 0)) + '%'
          : ('未就绪：' + (ffmpegState && (ffmpegState.error || ffmpegState.phase) || '未知'))),
      path: (ffmpegState && ffmpegState.path) || '',
    };

    /* ① 听得见：麦克风 + 本地 ASR */
    let selected = null;
    let devices = [];
    let micError = '';
    try {
      devices = await voiceRecorder.listDevices();
      selected = pickDevice(devices);
      if (!selected) micError = '没有检测到可用麦克风';
    } catch (error) {
      micError = String((error && error.message) || error);
    }
    let asrOk = asrState.phase === 'ready' || asrInstalledOnDisk();
    let asrError = '';
    if (!dryRun && !asrOk) {
      try {
        await ensureLocalAsr(readAsrBase());
        asrOk = true;
      } catch (error) {
        asrError = String((error && error.message) || error);
      }
    }
    if (!asrOk) asrError = asrError || (dryRun ? '演练模式跳过下载' : '语音识别模型未就绪');
    const heardOk = Boolean(ffmpegOk) && Boolean(selected) && asrOk;
    if (!heardOk && ffmpegOk) failed.push(micError || asrError || '语音输入未就绪');
    const heardStep = {
      id: 'heard',
      label: '听得见',
      ok: heardOk,
      detail: !ffmpegOk
        ? '录音组件未就绪；先完成上面的 ffmpeg 步骤'
        : (selected
          ? '麦克风已选中：' + selected + '；识别引擎：' + (asrOk ? '已就绪' : '未就绪')
          : (micError || '没有检测到可用麦克风')),
      device: selected,
      devices,
      asrReady: asrOk,
    };

    /* ② 说得出：选一个真实可用音色，真合成一短句（预热 worker） */
    let voices = [];
    let meta = {};
    let spokeOk = false;
    let spokeError = '';
    let chosenVoice = '';
    try {
      voices = typeof ttsService.voices === 'function' ? await ttsService.voices({ sapiEnabled }) : [];
      meta = typeof ttsService.voiceMeta === 'function' ? ttsService.voiceMeta() : {};
    } catch { voices = []; }
    const usable = (Array.isArray(voices) ? voices : []).filter((v) => v && v.usable === true);
    const preferred = usable.find((v) => v.id === config.voice.name)
      || usable.find((v) => v.engine === config.voice.enabledEngine)
      || usable.find((v) => v.engine === 'edge' && v.id === (meta.edge && meta.edge.voice))
      || usable.find((v) => v.engine === 'piper')
      || usable[0]
      || null;
    chosenVoice = preferred ? String(preferred.id) : String(config.voice.name || '');
    let synth;
    try {
      synth = await ttsService.synthesize('你好，我准备好了。', {
        voice: chosenVoice,
        rate: config.voice.rate || 0,
        policy: true,
        sapiEnabled,
        activeEngine: config.voice.enabledEngine,
        online: onlineConfig(),
        allowDownload: body.allowDownload !== false,
        timeoutMs: 300000,
      });
    } catch (error) {
      synth = { ok: false, error: String((error && error.message) || error) };
    }
    if (synth && synth.ok === true) {
      spokeOk = true;
      chosenVoice = String(synth.voice || chosenVoice || '');
      const mime = String(synth.mime || 'audio/wav');
      lastTts = {
        requestedVoice: String(chosenVoice || config.voice.name || ''),
        actualVoice: chosenVoice || null,
        engine: String(synth.engine || 'edge'),
        transport: String(synth.transport || 'local'),
        mime,
        fallback: synth.fallback === true,
        fallbackFrom: synth.fallbackFrom || '',
        attempts: synth.attempts || [],
        code: null,
        cached: Boolean(synth.cached),
        at: Date.now(),
      };
      // 自动选音色：配置为空或旧音色已不可用时，把本次真实音色写回覆盖层。
      if (!config.voice.name || !usable.some((v) => v.id === config.voice.name)) {
        try { writeOverlay({ voice: { ...config.voice, name: chosenVoice, sapiEnabled } }); } catch { /* ignore */ }
      }
    } else {
      spokeError = String((synth && (synth.hint || synth.error)) || '语音合成失败');
      failed.push('说得出：' + spokeError);
    }
    const spokeStep = {
      id: 'spoke',
      label: '说得出',
      ok: spokeOk,
      detail: spokeOk
        ? '已用' + (synth.engine === 'edge' ? '在线音色'
          : synth.engine === 'openai' ? 'OpenAI 在线音色'
            : synth.engine === 'piper' ? '内置离线音色' : '系统音色')
          + '合成：' + chosenVoice
        : spokeError,
      engine: synth && synth.engine ? synth.engine : null,
      voice: chosenVoice || null,
      mime: synth && synth.mime ? synth.mime : null,
      attempts: (synth && synth.attempts) || [],
    };

    /* ③ 失败项：前两步之外，模型 Key 也在这里如实报 */
    let hasKey = false;
    try { hasKey = Boolean(readPetChat().apiKey); } catch { hasKey = false; }
    if (!hasKey) failed.push('模型 Key 未填：桌宠能听能说，但还不会回答');
    const failedStep = {
      id: 'failed',
      label: '失败项',
      ok: failed.length === 0,
      detail: failed.length ? failed.join('；') : '无',
      items: failed,
    };
    send({
      ok: heardStep.ok && spokeStep.ok && failedStep.ok,
      dryRun,
      steps: [ffmpegStep, heardStep, spokeStep, failedStep],
      ffmpeg: { ok: ffmpegOk, phase: ffmpegStep.phase, percent: ffmpegStep.percent, path: ffmpegStep.path },
      heard: heardStep.ok,
      spoke: spokeStep.ok,
      failed,
      voice: chosenVoice || null,
      engine: synth && synth.engine ? synth.engine : null,
      actualVoice: synth && synth.voice ? synth.voice : null,
      mime: synth && synth.mime ? synth.mime : null,
      sapiEnabled,
      providers: onlineProviderView(),
    });
  }

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
   * GET /pet-chat/tts/voices —— 本机**真实可用**音色（pre.54）。
   * 只返回 `usable:true` 的条目由前端再过滤；这里保留 usable 字段便于排障。
   */
  async function handleTtsVoices(res) {
    const sapiEnabled = readVoiceRaw().sapiEnabled === true;
    let voices = [];
    let meta = {};
    try {
      voices = typeof ttsService.voices === 'function' ? await ttsService.voices({ sapiEnabled }) : [];
      meta = typeof ttsService.voiceMeta === 'function' ? ttsService.voiceMeta() : {};
    } catch { voices = []; }
    const online = onlineConfig();
    const pushOnline = (engine, id, label, lang, usable, reason) => {
      voices.push({
        engine, id, label, lang, gender: '', usable,
        online: true, requiresKey: true, reason: usable ? '' : (reason || '尚未测试通过'),
      });
    };
    if (online.openai.apiKey && online.openai.enabled !== false) {
      for (const name of OPENAI_TTS_VOICES) {
        pushOnline('openai', 'openai:' + name, 'OpenAI · ' + name[0].toUpperCase() + name.slice(1),
          'multi', online.openai.lastOk === true, online.openai.lastError);
      }
    }
    if (online.azure.apiKey && online.azure.enabled !== false) {
      for (const name of AZURE_TTS_VOICES) {
        pushOnline('azure', 'azure:' + name, 'Azure · ' + name.replace(/^zh-CN-/, '').replace(/Neural$/, ''),
          'zh-CN', online.azure.lastOk === true, online.azure.lastError);
      }
    }
    if (online.elevenlabs.apiKey && online.elevenlabs.enabled !== false) {
      pushOnline('elevenlabs', 'elevenlabs:' + online.elevenlabs.voiceId,
        'ElevenLabs · ' + online.elevenlabs.voiceId, 'multi',
        online.elevenlabs.lastOk === true, online.elevenlabs.lastError);
    }
    // v2：火山引擎（唯一在线供应商）。未测试通过也列出；选中后由合成链真调并回落。
    const volcCenter = publicVoiceCenter().volcengine;
    if (volcCenter.configured) {
      for (const voice of volcCenter.voices) {
        pushOnline('volc', 'volc:' + voice.id,
          '火山 · ' + voice.label, /^en_/.test(voice.id) ? 'en-US' : 'zh-CN',
          volcCenter.lastOk === true, volcCenter.lastError || '点「测试」真调一次后才可用');
      }
      if (volcCenter.voiceId && !volcCenter.voices.some((voice) => voice.id === volcCenter.voiceId)) {
        pushOnline('volc', 'volc:' + volcCenter.voiceId,
          '火山 · ' + volcCenter.voiceId, 'zh-CN',
          volcCenter.lastOk === true, volcCenter.lastError || '点「测试」后启用');
      }
    }
    const rawVoice = readVoiceRaw();
    // v1.2：Edge 429 时前端只给一条提示 + 本地音色，不把 8 个灰项堆进列表。
    const rateLimited = (Array.isArray(voices) ? voices : []).some((voice) => voice && voice.engine === 'edge'
      && voice.usable !== true && /429|rate.?limit/i.test(String(voice.reason || '')));
    jsonSend(res, {
      ok: true,
      voices: Array.isArray(voices) ? voices : [],
      sapiEnabled,
      enabledEngine: rawVoice.enabledEngine,
      continuous: rawVoice.continuous !== false,
      meta,
      providers: onlineProviderView(),
      rateLimited,
      // 下拉只该出现 usable=true；这里保留 false 条目仅用于排障（旧判据也依赖它）。
      usable: (Array.isArray(voices) ? voices : []).filter((v) => v && v.usable === true),
    });
  }

  /** GET /pet-chat/tts/catalog —— 可下载离线音色目录（本版 mostly coming-soon）。 */
  function handleTtsCatalog(res) {
    // 同时把「当前实际会用的镜像 URL」回给设置页/运维，避免只看到静态目录。
    const items = TTS_CATALOG.map((item) => (item.id === 'piper-zh'
      ? { ...item, resolvedRuntimeUrls: piperAssetUrls(item), resolvedModelUrls: piperModelUrls(item) }
      : item));
    jsonSend(res, { ok: true, items });
  }

  /* ── v2 音色中心：统一目录 / 音色包 / 试听 / 全局默认 ─────────────────── */

  function edgeLangGroup(lang) {
    const text = String(lang || '');
    if (/^zh-HK/i.test(text)) return '粤语';
    if (/^zh-TW/i.test(text)) return '台湾';
    if (/^zh-CN/i.test(text)) return '普通话';
    return '其他';
  }

  function packLabelOfVoice(voiceId) {
    const model = String(voiceId || '').replace(/^piper:/i, '');
    const pack = VOICE_PACKS.find((item) => item.modelId === model);
    return pack ? pack.name : model;
  }

  function volcLabelOfVoice(voiceId) {
    const id = String(voiceId || '').replace(/^volc:/i, '');
    const hit = VOLC_VOICE_SUGGESTIONS.find((voice) => voice.id === id);
    return hit ? hit.label : id;
  }

  /** 统一目录：内置包 / 免费 Edge / 我的在线音色（火山）。 */
  async function handleVoiceCatalog(res) {
    const sapiEnabled = readVoiceRaw().sapiEnabled === true;
    let voices = [];
    try {
      voices = typeof ttsService.voices === 'function' ? await ttsService.voices({ sapiEnabled }) : [];
    } catch { voices = []; }
    const packs = listPacks();
    const builtin = packs.map((pack) => ({
      id: pack.voiceId || ('pack:' + pack.id),
      packId: pack.id,
      label: pack.name,
      engine: pack.engine || 'piper',
      lang: pack.lang,
      gender: pack.gender,
      quality: pack.quality,
      hd: pack.hd,
      sizeMB: pack.sizeMB,
      sizeBytes: pack.sizeBytes,
      license: pack.license,
      source: pack.source,
      offline: true,
      requiresKey: false,
      installed: pack.installed,
      runtimeReady: pack.runtimeReady !== false,
      status: pack.status,
      reason: pack.reason,
      progress: pack.progress,
      recommended: pack.recommended,
    }));
    const edge = voices.filter((voice) => voice && voice.engine === 'edge').map((voice) => ({
      id: 'edge:' + String(voice.id || ''),
      label: voice.label || voice.id,
      engine: 'edge',
      lang: voice.lang || 'zh-CN',
      langGroup: edgeLangGroup(voice.lang),
      gender: voice.gender || '',
      online: true,
      requiresKey: false,
      usable: voice.usable === true,
      status: voice.usable === true ? 'ready' : (/429|rate.?limit/i.test(String(voice.reason || '')) ? 'rate-limited' : 'unavailable'),
      reason: voice.usable === true ? '' : (/429|rate.?limit/i.test(String(voice.reason || ''))
        ? '在线音色被限流（429），稍后自动恢复' : (voice.reason || '在线音色暂不可用')),
    }));
    const sapi = voices.filter((voice) => voice && voice.engine === 'sapi').map((voice) => ({
      id: normalizeVoiceId(voice.id),
      label: voice.label || voice.id,
      engine: 'sapi',
      lang: voice.lang || '',
      gender: voice.gender || '',
      usable: voice.usable === true,
      status: voice.usable === true ? 'ready' : 'unavailable',
      reason: voice.usable === true ? '' : (voice.reason || '系统音色不可用'),
    }));
    const center = publicVoiceCenter();
    const volcItems = [];
    if (center.volcengine.configured) {
      const known = new Set();
      for (const voice of center.volcengine.voices) {
        known.add(voice.id);
        volcItems.push({
          id: 'volc:' + voice.id,
          label: voice.label,
          engine: 'volc',
          lang: /^en_/.test(voice.id) ? 'en-US' : 'zh-CN',
          gender: voice.gender,
          subtype: voice.subtype,
          online: true,
          requiresKey: true,
          usable: center.volcengine.lastOk === true,
          status: center.volcengine.lastOk === true ? 'ready' : 'needs-test',
          reason: center.volcengine.lastOk === true ? '' : (center.volcengine.lastError || '点「测试」真调一次后才可用'),
        });
      }
      if (center.volcengine.voiceId && !known.has(center.volcengine.voiceId)) {
        volcItems.unshift({
          id: 'volc:' + center.volcengine.voiceId,
          label: volcLabelOfVoice(center.volcengine.voiceId),
          engine: 'volc',
          lang: 'zh-CN',
          gender: '',
          subtype: center.volcengine.subtype,
          online: true,
          requiresKey: true,
          usable: center.volcengine.lastOk === true,
          status: center.volcengine.lastOk === true ? 'ready' : 'needs-test',
          reason: center.volcengine.lastOk === true ? '' : (center.volcengine.lastError || '点「测试」真调一次后才可用'),
          custom: true,
        });
      }
    }
    const groups = [
      { key: 'builtin', label: '内置音色包', items: builtin, hint: '离线可用；下载后点 ▶ 试听。' },
      { key: 'edge', label: '免费在线（Edge）', items: edge, hint: '免 Key，可能被微软限流（429）；限流时自动回落内置音色。' },
      {
        key: 'providers', label: '我的在线音色', items: volcItems,
        hint: center.volcengine.configured ? '火山引擎（唯一在线供应商）' : '火山引擎未配置：展开「如何获取」六步。',
        provider: center.volcengine,
      },
      ...(sapi.length ? [{ key: 'sapi', label: '系统音色（SAPI）', items: sapi, hint: '机械感明显，默认关闭。' }] : []),
    ];
    const preferred = center.preferred || normalizeVoiceId(readVoiceRaw().name);
    jsonSend(res, {
      ok: true,
      groups,
      preferred,
      preferredLabel: preferred ? voiceLabelOf(preferred, groups) : '',
      packs,
      center,
      howTo: center.howTo,
      edgeRateLimited: edge.some((voice) => voice.status === 'rate-limited'),
      rateLimitedCount: edge.filter((voice) => voice.status === 'rate-limited').length,
      sapiEnabled,
    });
  }

  /** 音色 id → 人类可读标签（只查目录已有的数据；不触发新的合成）。 */
  function voiceLabelOf(voiceId, groups) {
    const id = String(voiceId || '');
    if (!id) return '';
    const list = Array.isArray(groups) ? groups : [];
    for (const group of list) {
      const hit = (group.items || []).find((item) => item && item.id === id);
      if (hit) return hit.label;
    }
    if (/^piper:/i.test(id)) return packLabelOfVoice(id);
    if (/^volc:/i.test(id)) return volcLabelOfVoice(id);
    return id.replace(/^[a-z0-9-]+:/i, '');
  }

  /** GET /pet-chat/voice/catalog —— 声音页与音色中心共用一份目录。 */
  async function handleVoiceCatalogRoute(res) {
    await handleVoiceCatalog(res);
  }

  /** GET /pet-chat/voice/packs —— 内置包状态 + 进度。 */
  function handleVoicePacks(res) {
    const packs = listPacks();
    const center = publicVoiceCenter();
    const status = typeof ttsService.status === 'function' ? (ttsService.status() || {}) : {};
    jsonSend(res, {
      ok: true,
      packs,
      preferred: center.preferred,
      packDefault: center.packDefault,
      runtimeInstalled: Boolean((status.piper && status.piper.installed) || packs.some((pack) => pack.installed)),
      center,
    });
  }

  /** GET /pet-chat/voice/packs/progress —— 轮询所有包（含未开始的 idle）。 */
  function handleVoicePacksProgress(res) {
    jsonSend(res, { ok: true, packs: listPacks().map((pack) => ({ id: pack.id, installed: pack.installed, progress: pack.progress })) });
  }

  /** POST /pet-chat/voice/packs/install { id } —— 后台下载；立即返回，进度走 /progress。 */
  async function handleVoicePackInstall(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const pack = packById(body.id);
    if (!pack) { jsonSend(res, { ok: false, code: 'unknown-pack', hint: '没有这个音色包' }, 400); return; }
    if (packInstalled(pack)) {
      jsonSend(res, { ok: true, started: false, installed: true, progress: packProgress(pack.id) });
      return;
    }
    try {
      void installPack(pack.id).catch((error) => log('[voice] pack install failed: ' + String((error && error.message) || error)));
    } catch (error) {
      jsonSend(res, { ok: false, code: 'install-failed', hint: String((error && error.message) || error) }, 500);
      return;
    }
    jsonSend(res, { ok: true, started: true, installed: false, progress: packProgress(pack.id) });
  }

  /** POST /pet-chat/voice/packs/remove { id } */
  async function handleVoicePackRemove(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const pack = packById(body.id);
    const before = readVoiceCenter();
    const result = removePack(body.id);
    if (!result.ok) { jsonSend(res, { ok: false, code: 'remove-failed', hint: '没有这个音色包或删除失败' }, 400); return; }
    // 删掉的正好是全局默认 ⇒ 回落到另一个已装包（没有就清空，交给合成链按策略回落）。
    if (pack && pack.model && before.preferred === pack.model.voice) {
      const fallback = listPacks().find((item) => item.installed);
      setPreferredVoice(fallback ? fallback.voiceId : '');
    }
    jsonSend(res, { ok: true, ...result, packs: listPacks(), center: publicVoiceCenter() });
  }

  /** GET /pet-chat/voice/user-packs —— 用户导入的角色音色包 + 4 个内置系统音效。 */
  function handleUserVoicePacks(res) {
    jsonSend(res, voicePackSummary());
  }

  /**
   * POST /pet-chat/voice/user-packs/import —— 导入用户自己的 voice pack。
   * 必须带 license + author（授权硬门槛）；参考音频只存到用户目录，不进 npm 包、不上传。
   */
  async function handleUserVoicePackImport(req, res) {
    let body = {};
    try { body = await readJsonBody(req, 12 * 1024 * 1024); } catch { body = null; }
    if (!body || typeof body !== 'object') {
      jsonSend(res, { ok: false, code: 'bad-json', hint: '请求体不是合法 JSON' }, 400);
      return;
    }
    const result = importVoicePack(body);
    if (!result.ok) {
      jsonSend(res, {
        ok: false, code: result.error, hint: result.hint,
        // 界面直接展示授权口径：不让用户以为“导入=可以随便用别人的声音”
        policy: '角色语音必须由你拥有权利：请填写 license 与作者/来源；本插件不提供、不分发角色/声优素材。',
      }, 400);
      return;
    }
    jsonSend(res, { ok: true, pack: result.pack, packs: voicePackSummary() }, 201);
  }

  /** POST /pet-chat/voice/user-packs/remove { id } */
  async function handleUserVoicePackRemove(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const result = removeUserVoicePack(body.id);
    if (!result.ok) {
      jsonSend(res, { ok: false, code: result.error, hint: '没有这个音色包或删除失败' }, 400);
      return;
    }
    jsonSend(res, { ok: true, ...result, packs: voicePackSummary() });
  }

  /** GET /pet-chat/system-sounds —— 内置 4 个音效（授权：本仓库合成，MIT）。 */
  function handleSystemSounds(res) {
    jsonSend(res, {
      ok: true,
      sounds: listSystemSounds(),
      count: SYSTEM_SOUNDS.length,
      policy: '内置只有 4 个系统音效；角色语音走下载/导入，不进 npm 包。',
    });
  }

  /** GET /pet-chat/system-sounds/<id>.wav —— 直出内置音效（只认白名单）。 */
  function handleSystemSoundAudio(req, res, name) {
    const clean = String(name || '').replace(/\.wav$/i, '');
    const sound = SYSTEM_SOUNDS.find((item) => item.id === clean);
    if (!sound) { jsonSend(res, { ok: false, code: 'not-found' }, 404); return; }
    let bytes;
    try {
      bytes = readFileSync(new URL('../../assets/system/sound/' + sound.file, import.meta.url));
    } catch {
      jsonSend(res, { ok: false, code: 'missing-asset', hint: '这个音效文件没随包发布' }, 404);
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(bytes);
  }

  /** POST /pet-chat/voice/packs/default { id } —— 设为全局默认音色。 */
  async function handleVoicePackDefault(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const pack = packById(body.id);
    if (!pack) { jsonSend(res, { ok: false, code: 'unknown-pack', hint: '没有这个音色包' }, 400); return; }
    if (!packInstalled(pack)) {
      jsonSend(res, { ok: false, code: 'pack-not-installed', hint: '先下载这个音色包，再设为全局默认' }, 409);
      return;
    }
    const model = pack.model;
    setDefaultPack(pack.id);
    const preferred = setPreferredVoice(model ? model.voice : '');
    jsonSend(res, { ok: true, preferred, preferredLabel: pack.name, center: publicVoiceCenter() });
  }

  /** GET/POST /pet-chat/voice/preferred —— 全局默认音色（继承人设用它）。 */
  async function handleVoicePreferred(req, res) {
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      const center = publicVoiceCenter();
      jsonSend(res, { ok: true, preferred: center.preferred, center });
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const id = normalizeVoiceId(body.voiceId || body.id || '');
    if (!id) { jsonSend(res, { ok: false, code: 'bad-voice', hint: '音色 id 为空' }, 400); return; }
    const preferred = setPreferredVoice(id);
    jsonSend(res, { ok: true, preferred, preferredLabel: id });
  }

  /**
   * POST /pet-chat/voice/preview { id, text } —— 3–5 秒试听（真合成，不读缓存）。
   *
   * 任务 §1（P0）：试听**不做回落**。指定哪个音色就只让那个引擎/模型合成：
   *   · 引擎不可用（未下载 / 缺 Key / 被限流 / 超时）⇒ 直接回可读错误，不换音色；
   *   · 响应头带 engine / voiceId / fallback:false；错误 JSON 也带同一组字段。
   * （日常朗读走 `/tts` 的 policy 链，允许回落；这是两条独立路径。）
   */
  async function handleVoicePreview(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const id = normalizeVoiceId(body.id || body.voiceId || '');
    const engine = voiceEngineOf(id);
    if (!id) {
      jsonSend(res, { ok: false, code: 'bad-voice', engine: '', voiceId: '', fallback: false, hint: '要试听哪个音色？' }, 400);
      return;
    }
    // 试听只允许已安装的音色包（含高清 sherpa 包）；未安装先让用户点下载。
    const packRow = listPacks().find((pack) => pack.voiceId === id);
    if (packRow && !packRow.installed) {
      jsonSend(res, {
        ok: false, code: 'pack-not-installed', engine, voiceId: id, fallback: false,
        hint: '这个音色包还没下载，先点「下载」',
      }, 409);
      return;
    }
    const rawVoice = readVoiceRaw();
    const text = normalizeTtsText(String(body.text || '你好，我是你的桌宠。今天也一起加油吧。'));
    let result;
    try {
      result = await ttsService.synthesize(text, {
        voice: id,
        rate: Number.isFinite(Number(body.rate)) ? Number(body.rate) : (rawVoice.rate || 0),
        // strict 在 worker 里是「只用这个音色的引擎」；与 policy 互斥，绝不回落。
        strict: true,
        sapiEnabled: rawVoice.sapiEnabled === true,
        allowDownload: false,
        online: onlineConfig(),
        noCache: true,
        timeoutMs: 45000,
      });
    } catch (error) {
      result = { ok: false, code: 'tts-unavailable', error: String((error && error.message) || error) };
    }
    if (!result || result.ok !== true) {
      const code = String((result && result.code) || 'tts-unavailable');
      const actualEngine = String((result && result.engine) || engine || '');
      res.setHeader('X-Folia-TTS-Engine', actualEngine);
      res.setHeader('X-Folia-TTS-Voice', encodeURIComponent(String(id)));
      res.setHeader('X-Folia-TTS-Fallback', '0');
      jsonSend(res, {
        ok: false,
        code,
        engine: actualEngine,
        voiceId: id,
        requestedVoice: id,
        fallback: false,
        subtype: String((result && result.subtype) || ''),
        hint: (result && (result.hint || result.error)) || TTS_UNAVAILABLE_HINT,
        attempts: (result && result.attempts) || [],
      }, code === 'empty-text' ? 400 : 503);
      return;
    }
    const mime = String(result.mime || 'audio/wav').toLowerCase().includes('mpeg') ? 'audio/mpeg' : 'audio/wav';
    const actualVoice = String(result.voice || id);
    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(result.wav.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Folia-TTS-Engine', String(result.engine || engine || ''));
    res.setHeader('X-Folia-TTS-Voice', encodeURIComponent(actualVoice));
    res.setHeader('X-Folia-TTS-Voice-Id', encodeURIComponent(id));
    res.setHeader('X-Folia-TTS-Fallback', '0');
    res.setHeader('X-Folia-TTS-Subtype', String(result.subtype || ''));
    res.setHeader('X-Folia-TTS-Attempts', ttsHeaderValue(result.attempts || []));
    res.end(result.wav);
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
    const voiceRaw = readVoiceRaw();
    const center = readVoiceCenter();
    const activePersona = getActivePersona();
    const selected = activePersona
      ? resolvePersonaVoice(activePersona, { preferred: center.preferred, rate: voiceRaw.rate })
      : { mode: 'inherit', id: normalizeVoiceId(center.preferred || voiceRaw.name), rate: voiceRaw.rate, source: 'global' };
    const voiceParam = String(url.searchParams.get('voice') || '').trim();
    const voice = voiceParam
      || String(selected.id || voiceRaw.name || '');
    const rateParam = url.searchParams.get('rate');
    const rate = rateParam == null || rateParam === ''
      ? (Number.isFinite(Number(selected.rate)) ? Number(selected.rate) : voiceRaw.rate)
      : rateParam;
    const sapiEnabled = voiceRaw.sapiEnabled === true;
    // 只有“显式选了音色”（query / 人设固定 / 全局默认）才用它的引擎覆盖 enabledEngine；
    // 仅回落旧 voice.name 时保持旧行为（预.57 判据依赖这一点）。
    const explicitVoice = Boolean(voiceParam || selected.id);
    const voiceEngine = explicitVoice ? voiceEngineOf(voice) : '';
    const activeEngine = ['edge', 'piper', 'sapi'].includes(voiceEngine)
      ? voiceEngine : voiceRaw.enabledEngine;
    // 固定音色失败后允许回落到“继承全局”的启用引擎（任务 §1.3：失败自动回落）。
    const fallbackEngines = activePersona && selected.mode === 'fixed' && voiceRaw.enabledEngine
      && voiceRaw.enabledEngine !== activeEngine
      ? [voiceRaw.enabledEngine]
      : [];
    let result;
    try {
      // v0.2 默认策略：Edge 在线 → Piper 内置离线 → SAPI（默认关闭）。
      // `policy:true` 让服务把整条链作为缓存标签，绝不复用旧 Huihui 缓存。
      result = await ttsService.synthesize(text, {
        voice, rate, policy: true, sapiEnabled,
        activeEngine,
        fallbackEngines,
        online: onlineConfig(),
        timeoutMs: 45000,
      });
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
    const mime = String(result.mime || 'audio/wav').toLowerCase().includes('mpeg') ? 'audio/mpeg' : 'audio/wav';
    lastTts = {
      requestedVoice,
      actualVoice,
      engine: String(result.engine || 'system'),
      transport: String(result.transport || 'local'),
      mime,
      fallback: result.fallback === true,
      fallbackFrom: result.fallbackFrom || '',
      attempts,
      code: null,
      cached: Boolean(result.cached),
      at: Date.now(),
    };
    res.statusCode = 200;
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(result.wav.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Folia-TTS-Engine', String(result.engine || 'system'));
    res.setHeader('X-Folia-TTS-Transport', String(result.transport || 'local'));
    res.setHeader('X-Folia-TTS-Mime', mime);
    // 响应头必须是 latin1；音色名做一次 URI 编码，客户端 decodeURIComponent 还原
    res.setHeader('X-Folia-TTS-Voice', encodeURIComponent(actualVoice));
    res.setHeader('X-Folia-TTS-Requested-Voice', ttsHeaderValue(requestedVoice));
    res.setHeader('X-Folia-TTS-Attempts', ttsHeaderValue(attempts));
    res.setHeader('X-Folia-TTS-Ms', String(Number(result.ms) || 0));
    res.setHeader('X-Folia-TTS-Cached', result.cached ? '1' : '0');
    res.setHeader('X-Folia-TTS-Fallback', result.fallback === true ? '1' : '0');
    res.end(result.wav);
  }

  /** POST /pet-chat/tts/stop —— 停当前播报（幂等：没有播报也回 ok:true）。 */
  function handleTtsStop(res) {
    const stopped = typeof ttsService.stop === 'function' ? ttsService.stop() : { generation: 0 };
    jsonSend(res, { ok: true, stopped: true, generation: Number(stopped && stopped.generation) || 0 });
  }

  /** GET /pet-chat/tts/state —— 合成链状态（不触发合成；必要时补一次音色清单）。 */
  async function handleTtsState(res) {
    let status = typeof ttsService.status === 'function' ? ttsService.status() : {};
    const voiceRaw = readVoiceRaw();
    const sapiEnabled = voiceRaw.sapiEnabled === true;
    // 首次打开设置页时还没合成过：补一次音色清单，让 engine/actualVoice 立刻有值
    // （清单只探测一次，10 分钟内走缓存；不会在这里合成整句）。
    if (!lastTts && !status.defaultVoice && typeof ttsService.voices === 'function') {
      try {
        await ttsService.voices({ sapiEnabled });
        status = typeof ttsService.status === 'function' ? ttsService.status() : status;
      } catch { /* 探测失败就保持空状态，不阻塞设置页 */ }
    }
    const actualVoice = (lastTts && lastTts.actualVoice)
      || status.defaultVoice
      || (status.lastResult && status.lastResult.voice)
      || null;
    const engine = (lastTts && lastTts.engine)
      || status.defaultEngine
      || (status.lastResult && status.lastResult.engine)
      || (actualVoice && /^piper:/i.test(actualVoice) ? 'piper' : null);
    jsonSend(res, {
      ok: true,
      ...status,
      sapiEnabled,
      policy: status.policy || TTS_ENGINES,
      voice: publicVoice(voiceRaw),
      // pre.46：把“用户要的音色 / 上次实际用的音色 / 引擎 / 每跳原因”一起回，
      // 排障时不用再猜为什么设置没生效。pre.54：优先用**上次请求**的音色（配置可能为空 = 自动）。
      requestedVoice: String((lastTts && lastTts.requestedVoice) || voiceRaw.name || ''),
      actualVoice,
      engine,
      transport: lastTts ? (lastTts.transport || 'local') : (status.defaultEngine === 'edge' ? 'online' : 'local'),
      mime: lastTts ? (lastTts.mime || 'audio/wav') : (status.lastResult && status.lastResult.mime) || null,
      fallback: lastTts ? lastTts.fallback === true : false,
      fallbackFrom: lastTts ? (lastTts.fallbackFrom || '') : '',
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
    const voiceRaw = readVoiceRaw();
    if (voiceRaw.muted) {
      jsonSend(res, { ok: true, skipped: 'muted', clients: speakClients.size });
      return;
    }
    const event = {
      type: 'speak',
      text,
      voice: String(body.voice || voiceRaw.name || ''),
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

  /* ── v5 §2：延迟 6 段采样（说完 / 录音完 / ASR / 首 token / 首段音频 / 出声）── */

  /** 段名固定为 6 段；P50/P90 只统计有值的段。 */
  const LATENCY_SEGMENTS = Object.freeze([
    'recordTail', 'asr', 'firstToken', 'firstAudio', 'playStart', 'total',
  ]);
  const latencySamples = [];
  function percentileOf(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return Math.round(sorted[idx] * 10) / 10;
  }
  function latencySummary() {
    const segments = {};
    for (const name of LATENCY_SEGMENTS) {
      const values = latencySamples.map((sample) => Number(sample && sample.segments && sample.segments[name]))
        .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
      segments[name] = {
        n: values.length,
        p50: percentileOf(values, 0.5),
        p90: percentileOf(values, 0.9),
        max: values.length ? Math.round(values[values.length - 1] * 10) / 10 : null,
      };
    }
    const totals = latencySamples.map((sample) => Number(sample.total)).filter((value) => Number.isFinite(value) && value >= 0);
    const voice = latencySamples.filter((sample) => sample.inputMode === 'voice').length;
    return {
      ok: true,
      count: latencySamples.length,
      voiceCount: voice,
      segments,
      targets: { firstToken: 300, firstAudioLocal: 2500, firstAudioEdge: 3500, turnGap: 1000 },
      samples: latencySamples.slice(-20),
      updatedAt: Date.now(),
    };
  }
  async function handleLatency(req, res) {
    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') { jsonSend(res, latencySummary()); return; }
    let body = {};
    try { body = await readJsonBody(req, 8 * 1024); } catch { body = {}; }
    const segments = body && typeof body.segments === 'object' && body.segments ? body.segments : null;
    if (!segments) { jsonSend(res, { ok: false, code: 'bad-latency', hint: 'segments 必须是对象' }, 400); return; }
    const clean = {};
    for (const name of LATENCY_SEGMENTS) {
      const value = Number(segments[name]);
      if (Number.isFinite(value) && value >= 0 && value <= 60000) clean[name] = Math.round(value);
    }
    if (!Object.keys(clean).length) { jsonSend(res, { ok: false, code: 'bad-latency', hint: '没有可用的段耗时' }, 400); return; }
    latencySamples.push({
      at: Date.now(),
      inputMode: body.inputMode === 'voice' ? 'voice' : 'text',
      engine: String(body.engine || '').slice(0, 20),
      segments: clean,
      total: Number.isFinite(Number(body.total)) ? Math.round(Number(body.total)) : (clean.total || null),
    });
    while (latencySamples.length > 200) latencySamples.shift();
    jsonSend(res, latencySummary());
  }

  /* ── v5 §1：按谱清唱（planSing → SAPI 逐音 + 变调/定时 → WAV）──────────── */

  function singDirPath() {
    const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
    return join(base, 'pet-chat', 'sing');
  }

  /** 清唱产物只留最近 12 首（每首 ~1MB，避免无限长）。 */
  function pruneSingFiles() {
    try {
      const dir = singDirPath();
      const files = readdirSync(dir).filter((name) => name.endsWith('.wav')).sort();
      for (const name of files.slice(0, Math.max(0, files.length - 12))) {
        try { rmSync(join(dir, name), { force: true }); } catch { /* ignore */ }
        try { rmSync(join(dir, name.replace(/\.wav$/, '.json')), { force: true }); } catch { /* ignore */ }
      }
    } catch { /* 清理失败不影响这一首 */ }
  }

  /**
   * 生成一首清唱并把音频落盘。
   * @returns {Promise<{ok:boolean, code?:string, hint?:string, sing?:object}>}
   */
  async function performSingForRoute(args = {}) {
    if (args && args.accompaniment === true) {
      return {
        ok: false, code: 'sing-no-accompaniment',
        hint: '带伴奏/原唱做不到（版权 + 只有合成音清唱）：我可以按原创旋律清唱，或你打开音乐 App 放原唱。',
      };
    }
    const lyricLines = Array.isArray(args.lyrics)
      ? args.lyrics.map((line) => sanitizeLyrics(line)).filter(Boolean)
      : (typeof args.lyrics === 'string' && args.lyrics.trim()
        ? String(args.lyrics).split(/\r?\n/).map((line) => sanitizeLyrics(line)).filter(Boolean)
        : []);
    const plan = planSing({
      topic: String(args.topic || '今天').slice(0, 20),
      mood: args.mood,
      tune: args.tune,
      lyrics: lyricLines,
      spread: args.spread,
    });
    if (!plan.ok) return { ok: false, code: 'sing-not-enough-notes', hint: '旋律音符不够（至少 8 个、4 个不同音高）' };
    let ffmpegPath = 'ffmpeg';
    try { ffmpegPath = await defaultResolveFfmpeg({ ensure: true }); } catch { ffmpegPath = 'ffmpeg'; }
    const singHome = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
    const synth = await synthesizeSong(plan.notes, {
      ffmpegPath,
      // v5 §1.1：Edge 逐音符 SSML 优先；断网/端点拒绝时自动退 SAPI（返回里带 edgeError）。
      // 判据可显式传 engine:'sapi' 做离线确定性测试。
      engine: args.engine === 'sapi' || args.engine === 'edge' ? args.engine : 'auto',
      cacheDir: join(singHome, 'pet-chat', 'sing-cache'),
    });
    if (!synth || synth.ok !== true) {
      return {
        ok: false,
        code: (synth && synth.code) || 'sing-failed',
        hint: (synth && synth.error) || '清唱合成失败（SAPI/ffmpeg 未就绪）',
      };
    }
    const dir = singDirPath();
    mkdirSync(dir, { recursive: true });
    const id = 'sing-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const file = join(dir, id + '.wav');
    writeFileSync(file, synth.wav);
    const durationErr = plan.expectedMs > 0 ? (synth.actualMs - plan.expectedMs) / plan.expectedMs : 0;
    const payload = {
      id,
      title: plan.title,
      tuneId: plan.tuneId,
      tuneTitle: plan.title,
      tuneSource: plan.source,
      license: plan.license,
      lines: plan.lines,
      noteCount: plan.notes.length,
      notes: plan.notes.map((note) => ({
        midi: note.midi, durMs: note.durMs, startMs: note.startMs, lyric: note.lyric, line: note.line, freqHz: note.freqHz,
      })),
      expectedMs: plan.expectedMs,
      actualMs: synth.actualMs,
      durationError: Math.round(durationErr * 10000) / 10000,
      distinctPitches: plan.distinctPitches,
      engine: synth.engine,
      voice: synth.voice || '',
      engineDetail: synth.engine === 'edge-score'
        ? 'Edge 逐音符 SSML（pitch 按谱）；Edge 不接受 <break>，音符间停顿按谱面时长由拼接器补齐'
        : (synth.engine === 'sapi-score' ? 'SAPI 逐音符清唱（离线兜底）' : ''),
      // Edge 路径的逐音符请求数/缓存命中/实测音高（排障与"按谱"证据）。
      edge: synth.edge || null,
      edgeError: synth.edgeError || '',
      ssmlPreview: plan.ssml ? String(plan.ssml).slice(0, 600) : '',
      disclaimer: plan.disclaimer,
      audioUrl: '/pet-chat/sing/' + id + '.wav',
      createdAt: Date.now(),
    };
    try { writeFileSync(join(dir, id + '.json'), JSON.stringify(payload), 'utf8'); } catch { /* 元数据只是排障 */ }
    pruneSingFiles();
    return {
      ok: true,
      sing: payload,
      say: `唱给你听：《${plan.title}》——${plan.lines.length} 句、${plan.notes.length} 个音（清唱，无伴奏）。`,
    };
  }

  /** POST /pet-chat/sing {topic,mood,tune,lyrics} —— 生成一首清唱。 */
  async function handleSing(req, res) {
    let body = {};
    try { body = await readJsonBody(req, 16 * 1024); } catch { body = {}; }
    const result = await performSingForRoute(body);
    if (!result.ok) {
      jsonSend(res, {
        ok: false, code: result.code, hint: result.hint,
        disclaimer: '清唱 = 合成音 + 按谱音高；没有伴奏，也不是真人歌声。',
      }, result.code === 'sing-no-accompaniment' ? 400 : 503);
      return;
    }
    jsonSend(res, {
      ok: true,
      ...result.sing,
      tuneSources: tuneSources(), // 曲调来源清单（S6：代码里能列出）
    });
  }

  /** GET /pet-chat/sing/<id>.wav —— 直出清唱音频（离线文件，不重合成）。 */
  function handleSingAudio(req, res, name) {
    const safe = String(name || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!/^sing-[a-zA-Z0-9-]+\.wav$/.test(safe)) { jsonSend(res, { ok: false, code: 'bad-sing-id' }, 400); return; }
    const file = join(singDirPath(), safe);
    if (!existsSync(file)) { jsonSend(res, { ok: false, code: 'sing-not-found' }, 404); return; }
    let bytes;
    try { bytes = readFileSync(file); } catch { jsonSend(res, { ok: false, code: 'sing-read-failed' }, 500); return; }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(bytes);
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
    // 只清当前进程的会话历史；磁盘上的 persona 事件流/成长不删（那是用户资产）。
    personaHistory.clear();
    personaTurns.clear();
    lastError = null;
    pendingConfirms.clear();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
  }

  /**
   * POST /pet-chat/personas/:id/permissions/preset { preset } —— 一键切「标准 / 宽松 / 自定义」。
   *
   * 为什么在本族而不是 personas.js：本任务只允许改 pet-chat 的 tools 段；预设的**取值表**
   * 仍在 persona-store（单一事实源），这里只做"取当前权限 → 套预设 → 落盘 → 回视图"。
   */
  async function handlePermissionPreset(req, res, personaId) {
    const persona = readPersona(personaId);
    if (!persona) { jsonSend(res, { ok: false, code: 'not-found', hint: '人设不存在' }, 404); return; }
    if (persona.type === 'character') {
      jsonSend(res, { ok: false, code: 'character-no-tools', message: '特殊人设不能使用系统工具，没有可配置的权限' }, 403);
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const presetId = String(body.preset || '').toLowerCase();
    if (!['standard', 'relaxed', 'custom'].includes(presetId)) {
      jsonSend(res, { ok: false, code: 'bad-preset', hint: '预设只能是 standard / relaxed / custom' }, 400);
      return;
    }
    const current = persona.permissions && typeof persona.permissions === 'object'
      ? persona.permissions : {};
    const next = applyPermissionPreset(current, presetId, persona.type);
    const saved = updatePersona(persona.id, { permissions: next });
    const effective = saved || persona;
    auditTool(effective, 'permission_preset', { preset: presetId }, {
      permission: 'allow', confirmed: true, result: 'ok', verified: true, source: 'settings',
    });
    jsonSend(res, {
      ok: true,
      persona: effective,
      ...personaPermissionsView(effective),
      preset: presetId === 'custom' ? 'custom' : permissionPresetOf(effective.permissions),
      message: presetId === 'standard' ? '已切到「标准」'
        : presetId === 'relaxed' ? '已切到「宽松」（系统操作仍需二次确认）'
          : '已切到「自定义」：逐个工具组自己调',
    });
  }

  /** GET/POST /pet-chat/tools/whitelist —— 用户可编辑的应用/域名/能力白名单。 */
  async function handleToolWhitelist(req, res) {
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      jsonSend(res, { ok: true, ...readToolWhitelist() });
      return;
    }
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    if (!Array.isArray(body.domains) && !Array.isArray(body.apps) && !Array.isArray(body.capabilities)) {
      jsonSend(res, { ok: false, code: 'bad-whitelist', hint: 'domains / apps / capabilities 至少给一个数组' }, 400);
      return;
    }
    const saved = writeToolWhitelist({
      domains: body.domains, apps: body.apps, capabilities: body.capabilities,
    });
    jsonSend(res, { ok: true, ...saved, message: '白名单已保存' });
  }

  /** GET /capabilities —— 已安装插件/技能的能力清单（v5 §4，UI 与模型共用）。 */
  function handleCapabilitiesList(res) {
    const whitelist = readToolWhitelist();
    const list = listCapabilities({ toolWhitelist: whitelist });
    jsonSend(res, {
      ok: true,
      skills: list.skills.map((skill) => ({
        id: skill.id, name: skill.name, label: skill.label, description: skill.description,
        source: skill.source, callable: true, enabled: list.enabled.includes(skill.id),
      })),
      plugins: list.plugins,
      enabled: list.enabled,
      roots: list.roots,
      note: '只列出已安装的能力；调用默认需要询问，且每个能力要单独启用；调用记录会写审计。',
    });
  }

  /** POST /capabilities { id, enabled } —— 单个能力的启用开关。 */
  async function handleCapabilitiesToggle(req, res) {
    let body = {};
    try { body = await readJsonBody(req); } catch { body = {}; }
    const id = String(body.id || '').trim();
    if (!/^(?:skill|plugin):[a-zA-Z0-9:_@./-]{1,80}$/.test(id)) {
      jsonSend(res, { ok: false, code: 'bad-capability', hint: 'id 形如 skill:<name>' }, 400);
      return;
    }
    const current = readToolWhitelist();
    const enabled = new Set(current.capabilities || []);
    if (body.enabled === true) enabled.add(id);
    else enabled.delete(id);
    const saved = writeToolWhitelist({ capabilities: [...enabled] });
    jsonSend(res, { ok: true, enabled: saved.capabilities, id });
  }

  /** 判断 tail 是不是 `/personas/<id>/permissions/preset`，返回人设 id（否则空串）。 */
  function presetPathOf(tail) {
    const match = /^\/personas\/([^/]+)\/permissions\/preset$/.exec(String(tail || ''));
    return match ? decodeURIComponent(match[1]) : '';
  }

  /**
   * 提醒到点：走已有的 `/events` 反向通道念一句（没有客户端时进 pending 队列，
   * 下一次连上补发）。每 20 秒看一眼文件，没有提醒时只是一次 readFile。
   */
  const reminderTimer = setInterval(() => {
    const now = nowMs();
    for (const item of dueReminders(now)) {
      try {
        markReminderFired(item.id, now);
        const voice = publicVoice(readVoiceRaw());
        const event = {
          type: 'speak', text: `提醒你：${item.text}`, voice: voice.name,
          rate: 0, ts: now, kind: 'reminder',
        };
        if (!broadcastSpeak(event)) {
          pendingSpeaks.push(event);
          while (pendingSpeaks.length > PENDING_SPEAK_MAX) pendingSpeaks.shift();
        }
      } catch { /* 单条提醒失败不影响下一拍 */ }
    }
  }, REMINDER_TICK_MS);
  if (typeof reminderTimer.unref === 'function') reminderTimer.unref();
  disposers.push(() => { try { clearInterval(reminderTimer); } catch { /* ignore */ } });

  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/pet-chat`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const tail = url.pathname.slice(`${BASE}/pet-chat`.length).replace(/\/+$/, '');
      const method = (req.method || 'GET').toUpperCase();
      // v3：权限预设写在本族（personas.js 只管逐组权限）；必须在人设委托之前拦。
      const presetPersonaId = presetPathOf(tail);
      if (presetPersonaId && method === 'POST') {
        await handlePermissionPreset(req, res, presetPersonaId);
        return;
      }
      if (tail === '/tools/whitelist' && (method === 'GET' || method === 'HEAD' || method === 'POST')) {
        await handleToolWhitelist(req, res);
        return;
      }
      if (tail === '/capabilities' && (method === 'GET' || method === 'HEAD')) {
        handleCapabilitiesList(res);
        return;
      }
      if (tail === '/capabilities' && method === 'POST') {
        await handleCapabilitiesToggle(req, res);
        return;
      }
      // pre.65：人设 CRUD / Key / 记忆 / 角色卡（独立模块，子路径委托）。
      if (tail === '/personas' || tail.startsWith('/personas/')) {
        const handled = await personaApi(req, res, tail.slice('/personas'.length), url);
        if (handled) return;
      }
      if (tail === '/state' && (method === 'GET' || method === 'HEAD')) { handleState(res); return; }
      if (tail === '/config' && (method === 'GET' || method === 'HEAD')) { await handleConfigGet(res); return; }
      if (tail === '/config' && method === 'POST') { await handleConfigPost(req, res); return; }
      if (tail === '/test' && method === 'POST') { await handleConfigTest(req, res); return; }
      if (tail === '/models' && (method === 'GET' || method === 'HEAD')) { handleModels(res); return; }
      if (tail === '/chat' && method === 'POST') { handleChat(req, res); return; }
      if (tail === '/tool-result' && method === 'POST') { await handleToolResult(req, res); return; }
      if (tail === '/tool-confirm' && method === 'POST') { await handleToolConfirm(req, res); return; }
      if (tail === '/tools' && (method === 'GET' || method === 'HEAD')) { handleTools(res); return; }
      if (tail === '/reset' && method === 'POST') { handleReset(res); return; }
      if (tail === '/transcribe' && method === 'POST') { handleTranscribe(req, res); return; }
      if (tail === '/record' && method === 'POST') { await handleRecord(req, res); return; }
      // v0.2 语音自举：诊断 / 一键启用 / SAPI 开关（都在 /voice 段内）
      if (tail === '/voice/diagnose' && (method === 'GET' || method === 'HEAD')) { await handleVoiceDiagnose(res, url); return; }
      if (tail === '/voice/catalog' && (method === 'GET' || method === 'HEAD')) { await handleVoiceCatalogRoute(res); return; }
      if (tail === '/voice/packs' && (method === 'GET' || method === 'HEAD')) { handleVoicePacks(res); return; }
      if (tail === '/voice/packs/progress' && (method === 'GET' || method === 'HEAD')) { handleVoicePacksProgress(res); return; }
      if (tail === '/voice/packs/install' && method === 'POST') { await handleVoicePackInstall(req, res); return; }
      if (tail === '/voice/packs/remove' && method === 'POST') { await handleVoicePackRemove(req, res); return; }
      if (tail === '/voice/packs/default' && method === 'POST') { await handleVoicePackDefault(req, res); return; }
      // v1.2 用户音色包（角色语音走导入，不进 npm 包）+ 4 个内置系统音效
      if (tail === '/voice/user-packs' && (method === 'GET' || method === 'HEAD')) { handleUserVoicePacks(res); return; }
      if (tail === '/voice/user-packs/import' && method === 'POST') { await handleUserVoicePackImport(req, res); return; }
      if (tail === '/voice/user-packs/remove' && method === 'POST') { await handleUserVoicePackRemove(req, res); return; }
      if (tail === '/system-sounds' && (method === 'GET' || method === 'HEAD')) { handleSystemSounds(res); return; }
      const systemSoundMatch = /^\/system-sounds\/([^/]+\.wav)$/.exec(tail);
      if (systemSoundMatch && (method === 'GET' || method === 'HEAD')) { handleSystemSoundAudio(req, res, systemSoundMatch[1]); return; }
      if (tail === '/voice/preferred' && (method === 'GET' || method === 'HEAD' || method === 'POST')) { await handleVoicePreferred(req, res); return; }
      if (tail === '/voice/preview' && method === 'POST') { await handleVoicePreview(req, res); return; }
      if (tail === '/tts/preview' && method === 'POST') { await handleVoicePreview(req, res); return; }
      if (tail === '/voice/mic-test' && (method === 'GET' || method === 'HEAD')) { await handleMicTest(req, res); return; }
      if (tail === '/voice/setup' && method === 'POST') { await handleVoiceSetup(req, res); return; }
      if (tail === '/voice/enable' && method === 'POST') { await handleVoiceEnable(req, res); return; }
      if (tail === '/voice/piper/progress' && (method === 'GET' || method === 'HEAD')) { handlePiperProgress(res); return; }
      if (tail === '/voice/piper/prepare' && method === 'POST') { await handlePiperPrepare(req, res); return; }
      if (tail === '/voice/providers/test' && method === 'POST') { await handleVoiceProviderTest(req, res); return; }
      if (tail === '/voice/providers' && (method === 'GET' || method === 'HEAD' || method === 'POST')) {
        await handleVoiceProviders(req, res); return;
      }
      if (tail === '/voice/config' && (method === 'GET' || method === 'HEAD' || method === 'POST')) {
        await handleVoiceConfig(req, res); return;
      }
      // P1 智能语音闭环：分句合成 → 客户端排队播放；stop 幂等；/events + /speak 是工作联动反向通道
      if (tail === '/tts' && (method === 'GET' || method === 'HEAD')) { await handleTts(req, res, url); return; }
      if (tail === '/tts/stop' && method === 'POST') { handleTtsStop(res); return; }
      if (tail === '/tts/state' && (method === 'GET' || method === 'HEAD')) { await handleTtsState(res); return; }
      if (tail === '/tts/voices' && (method === 'GET' || method === 'HEAD')) { await handleTtsVoices(res); return; }
      if (tail === '/tts/catalog' && (method === 'GET' || method === 'HEAD')) { handleTtsCatalog(res); return; }
      if (tail === '/events' && (method === 'GET' || method === 'HEAD')) { handleEvents(req, res); return; }
      if (tail === '/speak' && method === 'POST') { await handleSpeak(req, res); return; }
      if (tail === '/sing' && method === 'POST') { await handleSing(req, res); return; }
      if (tail === '/latency' && (method === 'GET' || method === 'HEAD' || method === 'POST')) { await handleLatency(req, res); return; }
      if (tail === '/sing/tunes' && (method === 'GET' || method === 'HEAD')) {
        jsonSend(res, { ok: true, tunes: tuneSources(), unitMs: 320 });
        return;
      }
      const singAudioMatch = /^\/sing\/([^/]+\.wav)$/.exec(tail);
      if (singAudioMatch && (method === 'GET' || method === 'HEAD')) { handleSingAudio(req, res, singAudioMatch[1]); return; }
    // 语音模型（SenseVoice）自举：用户不需要去 DSH 设置里找开关，
    // 插件自己触发 preparation 并轮询进度（DSH 的 speechToText.prepare 是公开方法）。
    // 自检：一次性跑「ffmpeg → 设备 → 录音 → 转写」四步，把每步结果原样返回。
    // 目的：发版前/真机排查时**一个请求就能看到哪一步坏了**，不用来回猜。
    if (tail === '/selftest' && (method === 'GET' || method === 'HEAD')) { void handleSelfTest(res); return; }
    if (tail === '/capabilities/curated' && (method === 'GET' || method === 'HEAD')) { handleCuratedCapabilities(res); return; }
    if (tail === '/capabilities/catalog' && (method === 'GET' || method === 'HEAD')) { handleCapabilities(res); return; }
if (tail === '/work-plugins' && (method === 'GET' || method === 'HEAD')) { handleWorkPlugins(res); return; }
if (tail === '/asr' && (method === 'GET' || method === 'HEAD')) { handleAsrStatus(res); return; }
    if (tail === '/asr' && method === 'POST') { handleAsrPrepare(res); return; }
      // v0.1「零配置」主动搭话：没有开关，只有内部策略 + 语音指令静默
      if (tail === '/proactive' && (method === 'GET' || method === 'HEAD')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          ok: true, usage: todayUsage(), silent: isSilent(),
          rules: PROACTIVE_RULES, eventRules: EVENT_RULES,
        }));
        return;
      }
      if (tail === '/proactive/tick' && method === 'POST') { await handleProactiveTick(req, res); return; }
      // v1.2 主动思维：没有外部事件时的“内心 tick”（默认关；勿扰/静默/忙碌时只说 record 或 none）
      if (tail === '/mind/tick' && method === 'POST') { await handleMindTick(req, res); return; }
      if (tail === '/mind/state' && (method === 'GET' || method === 'HEAD')) { handleMindState(res); return; }
      if (tail === '/mind/reset' && method === 'POST') {
        clearMindState();
        jsonSend(res, { ok: true });
        return;
      }
      // v1.2 屏幕感知 / 被动观察：默认关；关闭时连 PowerShell 都不启动
      if (tail === '/observe/status' && (method === 'GET' || method === 'HEAD')) { jsonSend(res, observeStatus()); return; }
      if (tail === '/observe/sample' && method === 'POST') { await handleObserveSample(req, res); return; }
      if (tail === '/observe/records' && (method === 'GET' || method === 'HEAD')) {
        const persona = getActivePersona();
        if (!persona) { jsonSend(res, { ok: false, code: 'no-persona', items: [] }); return; }
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 50);
        jsonSend(res, { ok: true, personaId: persona.id, ...listObservations(persona.id, { offset, limit }) });
        return;
      }
      if (tail === '/observe/records' && method === 'DELETE') {
        const persona = getActivePersona();
        jsonSend(res, { ok: true, personaId: persona && persona.id, ...(persona ? clearObservations(persona.id) : { removed: 0 }) });
        return;
      }
      if (tail === '/silence' && method === 'POST') { await handleSilence(req, res); return; }
      if (tail === '/memory' && (method === 'GET' || method === 'HEAD')) {
        // 旧入口保留给气泡「查看记忆」；数据源已切到 active persona 的事件流，不再读旧 memory.json。
        const persona = getActivePersona();
        if (!persona) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, code: 'no-persona' }));
          return;
        }
        const page = listEvents(persona.id, { offset: 0, limit: 20 });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
          ok: true, personaId: persona.id, memory: { events: page.items },
          line: persona.growth.traits.filter((trait) => trait.confidence >= 0.5).map((trait) => trait.text).join('；'),
          enabled: true,
        }));
        return;
      }
      if (tail === '/memory' && method === 'DELETE') {
        const persona = getActivePersona();
        if (persona) clearEvents(persona.id);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ ok: true, cleared: Boolean(persona), personaId: persona && persona.id }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    },
  }));

  // v1.2：屏幕感知采样（每 30 秒看一次设置；off 时不调用任何外部进程）
  startObserveLoop();

  // 卸载：断开所有事件流 + 停掉懒启动的 TTS worker（不留后台进程）
  disposers.push(() => {
    if (observeTimer) { try { clearInterval(observeTimer); } catch { /* ignore */ } observeTimer = null; }
    pendingConfirms.clear();
    pendingConfirmById.clear();
    for (const hit of pendingClientActions.values()) {
      try { clearTimeout(hit.timer); } catch { /* ignore */ }
      try { hit.resolve({ ok: false, error: 'disposed' }); } catch { /* ignore */ }
    }
    pendingClientActions.clear();
    for (const client of [...speakClients]) {
      try { client.res.end(); } catch { /* ignore */ }
    }
    speakClients.clear();
    try { if (typeof ttsService.dispose === 'function') ttsService.dispose(); } catch { /* ignore */ }
  });
}

