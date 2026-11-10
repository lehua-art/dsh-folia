/**
 * pet-chat-proactive.js — 主动搭话（v0.1「零配置」版）。
 *
 * 设计依据：docs/PET-VOICE-V01-WORKORDER.md 的「追加决定 1/2」。
 *   用户**不做任何选择**：没有开关、没有频率设置、没有「今天别说了」按钮。
 *   · 节奏：每 40–90 分钟最多一次（随机，避免机械感）
 *   · 夜间 22:00–08:00 不主动
 *   · 仅用户空闲 ≥10 分钟且非全屏
 *   · 内容 ≤30 字，基于时间 / 当前壁纸 / 记忆偏好
 *   · 停止 = 用户**主动说**（别说了 / 安静 / 闭嘴 / 别吵 / 不要说话了）⇒ 静默到次日 0 点；
 *     恢复 = 主动说（可以说话了 / 继续吧 / 说点什么）或次日 0 点自动恢复
 *
 * 状态文件：`~/.dsh-folia/pet-chat/proactive.json`（重启后仍生效）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 测试快进开关（T7）：`FOLIA_PET_PROACTIVE_FAST=1` 时把间隔压到 60–90 **秒**。
 *
 * 为什么用环境变量而不是设置项：这是给真机验收用的（等 40 分钟不现实），
 * 绝不能出现在用户可见的配置里 —— 所以只认环境变量，且默认关闭。
 */
const FAST = process.env.FOLIA_PET_PROACTIVE_FAST === '1';
const GAP_UNIT_MS = FAST ? 1000 : 60000; // 快进时单位是"秒"

/** 固定策略：全部写死，不从设置读（零配置的硬要求）。 */
export const PROACTIVE_RULES = Object.freeze({
  /** 两次主动搭话的最小/最大间隔（默认分钟；FAST 模式下是秒）。 */
  minGapMin: FAST ? 60 : 40,
  maxGapMin: FAST ? 90 : 90,
  /** 间隔单位（毫秒）：正常 = 分钟，FAST = 秒。 */
  gapUnitMs: GAP_UNIT_MS,
  fast: FAST,
  /** 每天上限（安全阀，正常节奏下到不了）。 */
  dailyCap: 12,
  idleMinutes: 10,
  quietHours: '22:00-08:00',
  /** 单条内容上限。 */
  maxChars: 30,
  /** 客户端问一次的最小间隔（5 分钟）。 */
  checkIntervalMs: 5 * 60 * 1000,
});

/** 「静默」指令：命中任一即进入静默（到次日 0 点）。 */
export const SILENCE_PATTERNS = ['别说了', '安静', '闭嘴', '别吵', '不要说话了'];
/** 「恢复」指令：命中任一即提前解除静默。 */
export const RESUME_PATTERNS = ['可以说话了', '继续吧', '说点什么'];

export function proactivePath() {
  const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(base, 'pet-chat', 'proactive.json');
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** 次日 0 点的时间戳（静默到这时结束）。 */
export function nextMidnight(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function emptyProactiveState(now = Date.now()) {
  return { date: dayKey(now), said: 0, lastAt: 0, silentUntil: 0, usedLines: [] };
}

export function readProactiveState(now = Date.now()) {
  try {
    const file = proactivePath();
    if (!existsSync(file)) return emptyProactiveState(now);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const base = emptyProactiveState(now);
    const state = {
      date: typeof doc.date === 'string' ? doc.date : base.date,
      said: Number(doc.said) || 0,
      lastAt: Number(doc.lastAt) || 0,
      silentUntil: Number(doc.silentUntil) || 0,
      usedLines: Array.isArray(doc.usedLines) ? doc.usedLines.filter((x) => typeof x === 'string').slice(-20) : [],
    };
    // 跨天：计数归零，静默也自然过期（silentUntil 是绝对时间，这里不清也能判）
    if (state.date !== base.date) return { ...base, silentUntil: state.silentUntil > now ? state.silentUntil : 0 };
    return state;
  } catch {
    return emptyProactiveState(now);
  }
}

export function writeProactiveState(state) {
  const file = proactivePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
  return state;
}

export function clearProactiveState() {
  try {
    const file = proactivePath();
    if (existsSync(file)) rmSync(file);
  } catch { /* ignore */ }
}

/** 静默时段（支持跨零点）。 */
export function inQuietHours(range, now = Date.now()) {
  const raw = String(range || PROACTIVE_RULES.quietHours).trim();
  const hit = raw.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!hit) return false;
  const minutes = (hh, mm) => Number(hh) * 60 + Number(mm);
  const start = minutes(hit[1], hit[2]);
  const end = minutes(hit[3], hit[4]);
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/** 静默中？（用户说过"别说了"且还没到次日 0 点） */
export function isSilent(now = Date.now()) {
  const state = readProactiveState(now);
  return state.silentUntil > now;
}

/** 用户说"别说了"⇒ 静默到次日 0 点。 */
export function enterSilence(now = Date.now()) {
  const state = readProactiveState(now);
  return writeProactiveState({ ...state, silentUntil: nextMidnight(now) });
}

/** 用户说"可以说话了"⇒ 立刻解除静默。 */
export function clearSilence(now = Date.now()) {
  const state = readProactiveState(now);
  return writeProactiveState({ ...state, silentUntil: 0 });
}

/** 从一句用户话里识别"静默 / 恢复"指令；都不命中返回 null。 */
export function parseSilenceCommand(text) {
  const value = String(text || '');
  if (!value) return null;
  if (SILENCE_PATTERNS.some((word) => value.includes(word))) return 'silence';
  if (RESUME_PATTERNS.some((word) => value.includes(word))) return 'resume';
  return null;
}

/**
 * 现在能不能主动搭话（固定策略，不看任何设置）。
 * @param {{now?:number, idleMinutes?:number, fullscreen?:boolean, randomHit?:boolean}} input
 */
export function canSpeak(input = {}) {
  const {
    now = Date.now(),
    idleMinutes = 0,
    fullscreen = false,
    randomHit = true,
  } = input;
  const state = readProactiveState(now);
  if (state.silentUntil > now) return { ok: false, reason: 'silent' };
  if (state.said >= PROACTIVE_RULES.dailyCap) return { ok: false, reason: 'daily-cap' };
  // 节奏：40–90（FAST 模式下 60–90 秒）随机。用 lastAt 做抖动，避免机械的整点。
  const gap = PROACTIVE_RULES.minGapMin
    + (((state.lastAt % 97) / 97) * (PROACTIVE_RULES.maxGapMin - PROACTIVE_RULES.minGapMin));
  if (state.lastAt && now - state.lastAt < gap * PROACTIVE_RULES.gapUnitMs) return { ok: false, reason: 'too-soon' };
  if (inQuietHours(PROACTIVE_RULES.quietHours, now)) return { ok: false, reason: 'quiet-hours' };
  if (Number(idleMinutes) < PROACTIVE_RULES.idleMinutes) return { ok: false, reason: 'not-idle' };
  if (fullscreen === true) return { ok: false, reason: 'fullscreen' };
  if (randomHit !== true) return { ok: false, reason: 'random-miss' };
  return { ok: true, reason: 'ok' };
}

/** 记一条"说了"（用于节奏与当日上限）。 */
export function markSaid(now = Date.now(), line = '') {
  const state = readProactiveState(now);
  const usedLines = typeof line === 'string' && line.trim()
    ? [...state.usedLines, line.trim()].slice(-20)
    : state.usedLines;
  return writeProactiveState({ ...state, said: state.said + 1, lastAt: now, usedLines });
}

/** 今日用量（给管理/排障看，不发 UI）。 */
export function todayUsage(now = Date.now()) {
  const state = readProactiveState(now);
  return { said: state.said, cap: PROACTIVE_RULES.dailyCap, silent: state.silentUntil > now };
}

/** 时段：late / morning / noon / afternoon / evening。 */
export function timeSlot(now = Date.now()) {
  const hour = new Date(now).getHours();
  if (hour < 5) return 'late';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'noon';
  if (hour < 18) return 'afternoon';
  if (hour < 23) return 'evening';
  return 'late';
}

const SLOT_WORD = Object.freeze({
  late: '夜深了', morning: '早上好', noon: '中午了', afternoon: '下午了', evening: '晚上了',
});

/**
 * 生成一条主动搭话：要素优先级 壁纸 → 记忆 → 时段；**≤30 字**，当日不重复。
 */
export function buildProactiveLine(input = {}) {
  const now = input.now || Date.now();
  const slot = timeSlot(now);
  const wallpaper = String(input.wallpaperTitle || '').trim().slice(0, 16);
  const memory = input.memory || {};
  const likes = Array.isArray(memory.likes) ? memory.likes.filter((x) => typeof x === 'string' && x.trim()) : [];
  const like = (likes[0] || '').trim().slice(0, 8);
  const used = new Set((input.usedLines || []).map((x) => String(x).trim()));
  const limit = PROACTIVE_RULES.maxChars;

  const candidates = [];
  if (wallpaper) {
    candidates.push({ line: `「${wallpaper}」配${SLOT_WORD[slot]}正好。`, source: 'wallpaper' });
    candidates.push({ line: `${SLOT_WORD[slot]}，还在看「${wallpaper}」？`, source: 'wallpaper' });
  }
  if (like && wallpaper) candidates.push({ line: `又看${like}呢？「${wallpaper}」也不错。`, source: 'memory+wallpaper' });
  if (like) candidates.push({ line: `想起你喜欢${like}。`, source: 'memory' });
  candidates.push({ line: SLOT_WORD[slot] ? `${SLOT_WORD[slot]}，我在这儿。` : '我在这儿。', source: 'time' });

  for (const candidate of candidates) {
    const line = candidate.line.slice(0, limit);
    if (!used.has(line)) return { line, slot, source: candidate.source };
  }
  return { line: `${SLOT_WORD[slot]}。`.slice(0, limit), slot, source: 'time-dedup' };
}
