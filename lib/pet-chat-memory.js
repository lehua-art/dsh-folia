/**
 * pet-chat-memory.js — **桌宠对话的长期记忆**（偏好 + 事件）。
 *
 * 存哪：`<DSH_FOLIA_HOME or ~/.dsh-folia>/pet-chat/memory.json`（**只在本机**，不上传）。
 * 存什么：**结论**，不是聊天原文 ——
 *   `{ nickname, likes[], dislikes[], style, notes[], events[], updatedAt }`
 *   上限：likes/dislikes ≤ 20 项、notes ≤ 10 条、events ≤ 30 条、单条偏好 ≤ 40 字。
 *   事件 `{ ts, kind:'action'|'event'|'preference', text, meta }`：30 天过期、注入最近 8 条。
 *
 * 三条写入路径：
 *   ① **显式**：用户说「记住我喜欢原神」/「记住我叫你 Folia」⇒ 立刻写
 *   ② **周期摘要**：每 `memoryEveryTurns` 轮让模型吐一次 JSON ⇒ 合并去重（不覆盖显式项）
 *   ③ **事件**：动作完成 / 用户偏好 ⇒ `addMemoryEvent()` 追加一条（不存原话）
 *   ④ 任何情况下**不存原文**：本模块只接受上面那几个字段，调用方传别的也会被丢掉。
 *
 * 读取方：`memoryPromptLine()`（≤80 字）与 `memoryEventsLine()`（最近 8 条，每条 ≤30 字）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 上限（工单 B1）。事件是 v2 新增：最多 30 条、30 天过期、注入最近 8 条。 */
export const MEMORY_LIMITS = Object.freeze({
  likes: 20, dislikes: 20, notes: 10, itemChars: 40, promptChars: 80,
  events: 30, eventChars: 80, eventPromptItems: 8, eventPromptChars: 30,
});
/** 事件过期：30 天（毫秒）。 */
export const MEMORY_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 记忆文件路径（与 pets 目录同一套根：`DSH_FOLIA_HOME` 优先）。 */
export function memoryPath() {
  const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(base, 'pet-chat', 'memory.json');
}

export function emptyMemory() {
  return { nickname: '', likes: [], dislikes: [], style: '', notes: [], events: [], updatedAt: 0 };
}

const clip = (value, max = MEMORY_LIMITS.itemChars) => String(value ?? '').trim().slice(0, max);
const uniq = (list) => [...new Set(list.filter(Boolean))];

/** 事件 kind 白名单：不接受模型/调用方随手写的标签。 */
const EVENT_KINDS = new Set(['action', 'event', 'preference']);

/** 单条事件的形状收敛（ts 用毫秒，text ≤80，meta 只留可 JSON 化的浅对象）。 */
function sanitizeEvent(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ts = Number(raw.ts);
  if (!Number.isFinite(ts) || ts <= 0 || now - ts > MEMORY_EVENT_TTL_MS) return null;
  const text = clip(raw.text, MEMORY_LIMITS.eventChars);
  if (!text) return null;
  const kind = EVENT_KINDS.has(raw.kind) ? raw.kind : 'event';
  let meta = {};
  if (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) {
    try {
      const encoded = JSON.stringify(raw.meta);
      if (encoded.length <= 400) meta = JSON.parse(encoded);
    } catch { meta = {}; }
  }
  return { ts, kind, text, meta };
}

/** 把任意输入收敛成合法形状（非法字段直接丢，不猜）。 */
export function sanitizeMemory(raw, now = Date.now()) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const arr = (value, max) => uniq((Array.isArray(value) ? value : []).map((item) => clip(item)).filter(Boolean)).slice(0, max);
  const events = (Array.isArray(src.events) ? src.events : [])
    .map((event) => sanitizeEvent(event, now))
    .filter(Boolean)
    // 旧的在前、新的在后；同一句只留最近一次（避免同一动作反复记）
    .filter((event, index, list) => list.findLastIndex((item) => item.text === event.text) === index)
    .slice(-MEMORY_LIMITS.events);
  return {
    nickname: clip(src.nickname, 20),
    likes: arr(src.likes, MEMORY_LIMITS.likes),
    dislikes: arr(src.dislikes, MEMORY_LIMITS.dislikes),
    style: clip(src.style, 60),
    notes: arr(src.notes, MEMORY_LIMITS.notes),
    events,
    updatedAt: Number(src.updatedAt) || 0,
  };
}

export function readMemory() {
  try {
    const file = memoryPath();
    if (!existsSync(file)) return emptyMemory();
    return sanitizeMemory(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyMemory();
  }
}

export function writeMemory(memory) {
  const next = { ...sanitizeMemory(memory), updatedAt: Date.now() };
  const file = memoryPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

/**
 * 追加一条长期事件（v2）。**不存原话**：调用方给的是结论（“换了壁纸「星空」”）。
 *
 * 去重规则：同一 `text` 已存在 ⇒ 只把 ts 提到最新（不新增行），避免每次动作后
 * system prompt 里的“最近事件”被同一句刷屏。
 *
 * @param {object} memory
 * @param {{kind?:'action'|'event'|'preference', text:string, meta?:object, ts?:number}} event
 * @returns {object} 写后的记忆（已落盘）
 */
export function addMemoryEvent(memory, event, now = Date.now()) {
  const base = sanitizeMemory(memory, now);
  const next = sanitizeEvent({ ts: now, kind: 'event', ...event }, now);
  if (!next) return writeMemory(base);
  const rest = base.events.filter((item) => item.text !== next.text);
  return writeMemory({
    ...base,
    events: [...rest, next].slice(-MEMORY_LIMITS.events),
  });
}

/** 清空：只删记忆文件，不碰其它目录。 */
export function clearMemory() {
  try {
    const file = memoryPath();
    if (existsSync(file)) rmSync(file);
  } catch { /* 删不掉也不算错：下次写入会覆盖 */ }
}

/**
 * 显式记忆（B2①）：从一句用户输入里抠出「记住…」的结论。
 *
 * 只认三种最不容易误判的形状，认不出就**不猜**（宁可不记，也不要把闲聊存成偏好）：
 *   · 记住我叫你<X> / 记住你叫<X>       → nickname
 *   · 记住我(喜欢|爱)<X>                → likes
 *   · 记住我(不喜欢|讨厌)<X>            → dislikes
 * 返回 `{ changed, field, value }`，由调用方决定何时写盘。
 */
export function parseExplicitMemory(text) {
  const raw = String(text ?? '');
  if (!/记住|记一下|记下/.test(raw)) return null;
  const patterns = [
    ['nickname', /(?:记住|记一下|记下)[，,、 ]*(?:我)?(?:叫你|称呼我|管我叫)\s*([^\s，,。！!？?]{1,20})/],
    ['likes', /(?:记住|记一下|记下)[，,、 ]*我(?:很|最|超)?(?:喜欢|爱|爱看|爱玩)\s*([^\s，,。！!？?]{1,20})/],
    ['dislikes', /(?:记住|记一下|记下)[，,、 ]*我(?:很|最|超)?(?:不喜欢|讨厌|受不了)\s*([^\s，,。！!？?]{1,20})/],
  ];
  for (const [field, re] of patterns) {
    const hit = raw.match(re);
    if (hit && hit[1]) return { field, value: clip(hit[1]) };
  }
  return null;
}

/** 把一条显式结论写进记忆（就地合并 + 去重，立即落盘）。 */
export function rememberExplicit(memory, parsed) {
  if (!parsed || !parsed.field || !parsed.value) return memory;
  const next = sanitizeMemory(memory);
  if (parsed.field === 'nickname') next.nickname = parsed.value;
  else if (parsed.field === 'likes') next.likes = uniq([...next.likes, parsed.value]).slice(0, MEMORY_LIMITS.likes);
  else if (parsed.field === 'dislikes') next.dislikes = uniq([...next.dislikes, parsed.value]).slice(0, MEMORY_LIMITS.dislikes);
  else return memory;
  return writeMemory(next);
}

/**
 * 周期摘要（B2②）：把模型给的 JSON 合并进记忆。
 *
 * 规则：**只增不改** —— 已有的项不删，用户显式写过的 nickname 不被摘要覆盖
 * （摘要里的空值/重复项都丢掉）。超出上限时按先后裁剪。
 */
export function mergeSummary(memory, summary) {
  const base = sanitizeMemory(memory);
  const incoming = sanitizeMemory({ ...summary, nickname: '' }); // nickname 只由显式路径改
  const merged = {
    ...base,
    likes: uniq([...base.likes, ...incoming.likes]).slice(0, MEMORY_LIMITS.likes),
    dislikes: uniq([...base.dislikes, ...incoming.dislikes]).slice(0, MEMORY_LIMITS.dislikes),
    notes: uniq([...base.notes, ...incoming.notes]).slice(0, MEMORY_LIMITS.notes),
    style: base.style || incoming.style,
  };
  return writeMemory(merged);
}

/** 注入 system prompt 的那一行（≤80 字；记忆为空时返回空串）。 */
export function memoryPromptLine(memory) {
  const m = sanitizeMemory(memory);
  const parts = [];
  if (m.nickname) parts.push(`称呼=${m.nickname}`);
  if (m.likes.length) parts.push(`喜欢=${m.likes.join('/')}`);
  if (m.dislikes.length) parts.push(`不喜欢=${m.dislikes.join('/')}`);
  if (m.style) parts.push(`说话风格=${m.style}`);
  if (m.notes.length) parts.push(`备注=${m.notes.join('/')}`);
  if (!parts.length) return '';
  return `关于主人：${parts.join('；')}`.slice(0, MEMORY_LIMITS.promptChars);
}

/**
 * 最近 8 条事件（每条 ≤30 字）折成一行；没有事件返回空串。
 *
 * 为什么单起一行而不是并进 `关于主人`：偏好是稳定结论，事件是“最近发生过什么”，
 * 时间顺序有意义；两者混在一起会让模型把一次换壁纸当成永久偏好。
 */
export function memoryEventsLine(memory) {
  const m = sanitizeMemory(memory);
  if (!m.events.length) return '';
  const items = m.events.slice(-MEMORY_LIMITS.eventPromptItems)
    .map((event) => clip(event.text, MEMORY_LIMITS.eventPromptChars))
    .filter(Boolean);
  if (!items.length) return '';
  return `最近发生：${items.join('；')}`.slice(0, 260);
}

/** 摘要请求的 system 提示词（同一端点、不同指令；模型据此输出 JSON）。 */
export const MEMORY_SUMMARY_PROMPT = '[memory-summary] 只输出一个 JSON：'
  + '{"nickname":"","likes":[],"dislikes":[],"style":"","notes":[]}；'
  + '从下面这段对话里提炼**长期偏好**（称呼/喜欢/不喜欢/说话风格/备注），没有的留空。'
  + '不要复述原话，不要编造。';
