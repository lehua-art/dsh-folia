/**
 * pet-chat-memory.js — **桌宠对话的长期偏好记忆**（门 2 之后 / 工单 B）。
 *
 * 存哪：`<DSH_FOLIA_HOME or ~/.dsh-folia>/pet-chat/memory.json`（**只在本机**，不上传）。
 * 存什么：**结论**，不是聊天原文 ——
 *   `{ nickname, likes[], dislikes[], style, notes[], updatedAt }`
 *   上限：likes/dislikes ≤ 20 项、notes ≤ 10 条、单条 ≤ 40 字。
 *
 * 两条写入路径（工单 B2）：
 *   ① **显式**：用户说「记住我喜欢原神」/「记住我叫你 Folia」⇒ 立刻写
 *   ② **周期摘要**：每 `memoryEveryTurns` 轮让模型吐一次 JSON ⇒ 合并去重（不覆盖显式项）
 * ③ 任何情况下**不存原文**：本模块只接受上面那几个字段，调用方传别的也会被丢掉。
 *
 * 读取方：`memoryPromptLine()` 生成注入 system prompt 的那一行（≤80 字）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 上限（工单 B1）。 */
export const MEMORY_LIMITS = Object.freeze({ likes: 20, dislikes: 20, notes: 10, itemChars: 40, promptChars: 80 });

/** 记忆文件路径（与 pets 目录同一套根：`DSH_FOLIA_HOME` 优先）。 */
export function memoryPath() {
  const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(base, 'pet-chat', 'memory.json');
}

export function emptyMemory() {
  return { nickname: '', likes: [], dislikes: [], style: '', notes: [], updatedAt: 0 };
}

const clip = (value, max = MEMORY_LIMITS.itemChars) => String(value ?? '').trim().slice(0, max);
const uniq = (list) => [...new Set(list.filter(Boolean))];

/** 把任意输入收敛成合法形状（非法字段直接丢，不猜）。 */
export function sanitizeMemory(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const arr = (value, max) => uniq((Array.isArray(value) ? value : []).map((item) => clip(item)).filter(Boolean)).slice(0, max);
  return {
    nickname: clip(src.nickname, 20),
    likes: arr(src.likes, MEMORY_LIMITS.likes),
    dislikes: arr(src.dislikes, MEMORY_LIMITS.dislikes),
    style: clip(src.style, 60),
    notes: arr(src.notes, MEMORY_LIMITS.notes),
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

/** 摘要请求的 system 提示词（同一端点、不同指令；模型据此输出 JSON）。 */
export const MEMORY_SUMMARY_PROMPT = '[memory-summary] 只输出一个 JSON：'
  + '{"nickname":"","likes":[],"dislikes":[],"style":"","notes":[]}；'
  + '从下面这段对话里提炼**长期偏好**（称呼/喜欢/不喜欢/说话风格/备注），没有的留空。'
  + '不要复述原话，不要编造。';
