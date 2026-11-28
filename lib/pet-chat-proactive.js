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
  /** 每天上限（v2：主动发起每日 ≤3 次，事件触发与空闲搭话共用这个额度）。 */
  dailyCap: 3,
  idleMinutes: 10,
  quietHours: '22:00-08:00',
  /** 单条内容上限。 */
  maxChars: 30,
  /** 客户端问一次的最小间隔（5 分钟）。 */
  checkIntervalMs: 5 * 60 * 1000,
});

/**
 * v2 的事件触发规则（与“空闲搭话”分开：事件触发不等 10 分钟空闲，但**同样**受静默、
 * 每日上限、正在朗读/正在听的约束）。
 */
export const EVENT_RULES = Object.freeze({
  /** 换壁纸成功后至少等 30 秒再点评，避免和切换动作抢话。 */
  wallpaperDelayMs: 30 * 1000,
  /** 连续工作多少分钟后提醒休息。 */
  workMinutes: 45,
  /** 早上问候窗口（小时，左闭右开）。 */
  morningFrom: 8,
  morningTo: 10,
  /** 夜间提醒从 22 点开始。 */
  nightFrom: 22,
});

/** 「静默」指令：命中任一即进入静默（到次日 0 点）。 */
export const SILENCE_PATTERNS = ['别说了', '别说话了', '别说话', '安静', '闭嘴', '别吵', '不要说话了'];
/** 「恢复」指令：命中任一即提前解除静默。 */
export const RESUME_PATTERNS = ['可以说话了', '可以说了', '说话吧', '继续吧', '说点什么'];

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
  return { date: dayKey(now), said: 0, lastAt: 0, silentUntil: 0, usedLines: [], events: {} };
}

/** 事件记账：只留本日字符串（greeting/night/work），壁纸事件留时间戳。 */
function sanitizeEventState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const kind of ['greeting', 'night', 'work']) {
    if (typeof raw[kind] === 'string' && raw[kind]) out[kind] = raw[kind];
  }
  if (Number.isFinite(Number(raw.wallpaperAt)) && Number(raw.wallpaperAt) > 0) {
    out.wallpaperAt = Number(raw.wallpaperAt);
  }
  return out;
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
      events: sanitizeEventState(doc.events),
    };
    // 跨天：计数归零，事件记账按日期清空（静默用绝对时间，清了也不影响判断）
    if (state.date !== base.date) {
      return { ...base, silentUntil: state.silentUntil > now ? state.silentUntil : 0 };
    }
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

/**
 * v2：事件触发（换壁纸 / 连续工作 / 早晚问候）能不能说。
 *
 * 与 `canSpeak()` 的差别：**不等用户空闲 10 分钟**（事件本身就是上下文），但同样
 * 遵守静默、每日 ≤3 次、正在朗读/正在听时不插嘴。问候/工作/夜间各每天一次。
 *
 * @param {{
 *   event: 'wallpaper'|'work'|'greeting'|'night',
 *   now?: number,
 *   speaking?: boolean,
 *   listening?: boolean,
 *   sinceMs?: number,
 *   activeMinutes?: number,
 * }} input
 */
export function canEventSpeak(input = {}) {
  const now = input.now || Date.now();
  const event = String(input.event || '');
  if (!['wallpaper', 'work', 'greeting', 'night'].includes(event)) return { ok: false, reason: 'unknown-event' };
  const state = readProactiveState(now);
  if (state.silentUntil > now) return { ok: false, reason: 'silent' };
  if (input.speaking === true) return { ok: false, reason: 'speaking' };
  if (input.listening === true) return { ok: false, reason: 'listening' };
  if (state.said >= PROACTIVE_RULES.dailyCap) return { ok: false, reason: 'daily-cap' };
  const today = dayKey(now);
  const hour = new Date(now).getHours();
  // 壁纸点评 / 工作提醒沿用旧版“夜间不主动”；夜间休息提醒本身就在静默时段里，单独放行。
  if ((event === 'wallpaper' || event === 'work') && inQuietHours(PROACTIVE_RULES.quietHours, now)) {
    return { ok: false, reason: 'quiet-hours' };
  }

  if (event === 'wallpaper') {
    const since = Number(input.sinceMs);
    if (!Number.isFinite(since) || since < EVENT_RULES.wallpaperDelayMs) return { ok: false, reason: 'too-soon' };
    // 两次壁纸点评之间至少隔 30 秒（用户快速连点时不刷屏）
    if (state.events.wallpaperAt && now - state.events.wallpaperAt < EVENT_RULES.wallpaperDelayMs) {
      return { ok: false, reason: 'too-soon' };
    }
    return { ok: true, reason: 'ok' };
  }
  if (event === 'work') {
    if (state.events.work === today) return { ok: false, reason: 'done-today' };
    if (!(Number(input.activeMinutes) >= EVENT_RULES.workMinutes)) return { ok: false, reason: 'not-enough-work' };
    return { ok: true, reason: 'ok' };
  }
  if (event === 'greeting') {
    if (state.events.greeting === today) return { ok: false, reason: 'done-today' };
    if (hour < EVENT_RULES.morningFrom || hour >= EVENT_RULES.morningTo) return { ok: false, reason: 'wrong-time' };
    return { ok: true, reason: 'ok' };
  }
  // night
  if (state.events.night === today) return { ok: false, reason: 'done-today' };
  if (hour < EVENT_RULES.nightFrom && hour >= 6) return { ok: false, reason: 'wrong-time' };
  return { ok: true, reason: 'ok' };
}

/**
 * 生成事件触发的一句话（≤30 字）。
 * @param {{event:string, now?:number, wallpaperTitle?:string, activeMinutes?:number}} input
 */
export function buildEventLine(input = {}) {
  const event = String(input.event || '');
  const title = String(input.wallpaperTitle || '').trim().slice(0, 16);
  const minutes = Math.max(EVENT_RULES.workMinutes, Math.round(Number(input.activeMinutes) || EVENT_RULES.workMinutes));
  const limit = PROACTIVE_RULES.maxChars;
  let line;
  if (event === 'wallpaper') line = title ? `「${title}」这张挺耐看。` : '换好了，这张挺顺眼。';
  else if (event === 'work') line = `连续忙了${minutes}分钟，起来动动吧。`;
  else if (event === 'greeting') line = '早上好，今天也慢慢来。';
  else if (event === 'night') line = '夜深了，早点休息。';
  else line = '我在这儿。';
  if ([...line].length > limit) line = [...line].slice(0, limit).join('');
  return { line, event, source: 'event' };
}

/** 记一条事件触发（当日额度 + 该事件的“今天已经说过”）。 */
export function markEventSaid(event, now = Date.now(), line = '') {
  const state = markSaid(now, line);
  const today = dayKey(now);
  const events = { ...state.events };
  if (event === 'wallpaper') events.wallpaperAt = now;
  else if (event === 'work' || event === 'greeting' || event === 'night') events[event] = today;
  return writeProactiveState({ ...state, events });
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
