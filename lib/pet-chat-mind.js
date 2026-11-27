/**
 * pet-chat-mind.js — 主动思维（v1.2 需求三）：**偶尔**说一句 / 问一个问题 / 只记不说。
 *
 * 和旧 `pet-chat-proactive.js` 的分工：
 *   · 旧模块是 v0.1「零配置」固定策略（40–90 分钟、每天 3 条、4 条模板）；
 *   · 本模块是 v1.2 的「内心 tick」：间隔可配（默认 15 分钟）、每小时最多 2 次、
 *     输入多一层上下文（前台应用/观察摘要/记忆 top3），决策分四档：
 *       speak  —— 陈述一句（"你今晚一直在写代码。"）
 *       ask    —— 问一个问题（"要不要我帮你把这段整理成文档？"）
 *       record —— 只记不说（把观察写进记忆，不弹气泡）
 *       none   —— 什么都不做
 *
 * 硬约束（全部在 `mindAllowed()` 里，按顺序短路）：
 *   · 主动搭话默认关（设置 `proactive.enabled` 默认 false）；
 *   · 朗读中 / 录音中 / 一轮回答中 / 静音 / 勿扰时段 ⇒ 不打扰；
 *   · 每小时最多 2 次；静默口令（"别说了"）优先于一切；
 *   · 不重复最近 3 次说过的话（归一化后比较，避免只差标点就重说）。
 *
 * 状态文件：`<DSH_FOLIA_HOME>/pet-chat/mind.json`（本机、可删；重启后仍生效）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const MIND_RULES = Object.freeze({
  /** tick 间隔（分钟）：任务书 10–20，默认 15。 */
  defaultIntervalMin: 15,
  minIntervalMin: 10,
  maxIntervalMin: 20,
  /** 每小时最多主动 2 次。 */
  perHourCap: 2,
  /** 连续工作多少分钟后可以问一次（验收 P1：45 分钟能触发）。 */
  workAskMinutes: 45,
  /** 最近说过的话保留多少条（去重用）。 */
  recentLines: 3,
  /** 默认勿扰时段（设置里可改）。 */
  quietFrom: '23:00',
  quietTo: '08:00',
  /** 单条内容上限（和旧主动搭话一致，气泡不刷屏）。 */
  maxChars: 60,
});

/** 哪些前台应用算“在写代码 / 看视频 / 开会”。只按进程名判断，不读内容。 */
const APP_KINDS = Object.freeze([
  { kind: 'code', apps: ['code', 'code-insiders', 'cursor', 'devenv', 'idea64', 'idea', 'webstorm64', 'pycharm64', 'goland64', 'rider64', 'sublime_text', 'notepad++', 'vim', 'emacs', 'windowsterminal', 'wt', 'powershell', 'pwsh', 'cmd'] },
  { kind: 'video', apps: ['vlc', 'potplayermini64', 'potplayermini', 'mpc-hc64', 'mpv', 'bilibili', 'youtube', 'netflix', 'iqiyi', 'youku', 'tencentvideo', 'qqlive'] },
  { kind: 'meeting', apps: ['zoom', 'teams', 'ms-teams', 'dingtalk', 'feishu', 'lark', 'wemeetapp', 'webex', 'skype'] },
]);

/** 进程名 → code / video / meeting / ''。 */
export function appKind(app) {
  const name = String(app || '').toLowerCase().trim().replace(/\.exe$/, '');
  if (!name) return '';
  for (const group of APP_KINDS) {
    if (group.apps.some((item) => name === item || name.includes(item))) return group.kind;
  }
  return '';
}

export function mindStatePath() {
  const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(base, 'pet-chat', 'mind.json');
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function emptyMindState(now = Date.now()) {
  return { date: dayKey(now), lastTickAt: 0, saidAt: [], recent: [] };
}

export function readMindState(now = Date.now()) {
  try {
    const file = mindStatePath();
    if (!existsSync(file)) return emptyMindState(now);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const base = emptyMindState(now);
    const state = {
      date: typeof doc.date === 'string' ? doc.date : base.date,
      lastTickAt: Number(doc.lastTickAt) || 0,
      saidAt: Array.isArray(doc.saidAt) ? doc.saidAt.map(Number).filter((n) => n > 0).slice(-20) : [],
      recent: Array.isArray(doc.recent) ? doc.recent.filter((x) => typeof x === 'string').slice(-10) : [],
    };
    if (state.date !== base.date) return { ...base, lastTickAt: 0 };
    return state;
  } catch {
    return emptyMindState(now);
  }
}

export function writeMindState(state) {
  const file = mindStatePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
  return state;
}

export function clearMindState() {
  try {
    const file = mindStatePath();
    if (existsSync(file)) rmSync(file);
  } catch { /* ignore */ }
}

/** 勿扰时段（支持跨零点，格式 HH:MM）。 */
export function inQuietWindow(from, to, now = Date.now()) {
  const parse = (value) => {
    const hit = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    return hit ? Number(hit[1]) * 60 + Number(hit[2]) : null;
  };
  const start = parse(from);
  const end = parse(to);
  if (start === null || end === null) return false;
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
}

/** 归一化一句话（去掉标点/空白/emoji 后比较，用于“不重复最近 3 次”）。 */
export function normalizeMindLine(line) {
  return String(line || '')
    .replace(/[\s，。！？、；：,.!?;:…—~"'"'「」『』（）()【】[\]]/g, '')
    .toLowerCase();
}

/**
 * 能不能主动（按顺序短路，reason 给排障用）。
 * @param {{
 *   now?:number, enabled?:boolean, intervalMin?:number, quietFrom?:string, quietTo?:string,
 *   speaking?:boolean, listening?:boolean, turnBusy?:boolean, muted?:boolean, silent?:boolean,
 *   activeMinutes?:number, state?:object,
 * }} input
 */
export function mindAllowed(input = {}) {
  const now = Number(input.now) || Date.now();
  if (input.enabled !== true) return { ok: false, reason: 'disabled' };
  if (input.speaking === true) return { ok: false, reason: 'speaking' };
  if (input.listening === true) return { ok: false, reason: 'listening' };
  if (input.turnBusy === true) return { ok: false, reason: 'turn-busy' };
  if (input.muted === true) return { ok: false, reason: 'muted' };
  if (input.silent === true) return { ok: false, reason: 'silent' };
  const intervalMin = Math.max(MIND_RULES.minIntervalMin, Math.min(MIND_RULES.maxIntervalMin,
    Number(input.intervalMin) || MIND_RULES.defaultIntervalMin));
  const quietFrom = String(input.quietFrom || MIND_RULES.quietFrom);
  const quietTo = String(input.quietTo || MIND_RULES.quietTo);
  if (inQuietWindow(quietFrom, quietTo, now)) return { ok: false, reason: 'quiet-hours' };
  const state = input.state || readMindState(now);
  const hourAgo = now - 3600 * 1000;
  const saidThisHour = state.saidAt.filter((ts) => ts > hourAgo).length;
  if (saidThisHour >= MIND_RULES.perHourCap) return { ok: false, reason: 'hour-cap' };
  if (state.lastTickAt && now - state.lastTickAt < intervalMin * 60000) return { ok: false, reason: 'too-soon' };
  return { ok: true, reason: 'ok', intervalMin };
}

const SLOT_WORD = Object.freeze({
  late: '夜深了', morning: '早上好', noon: '中午了', afternoon: '下午了', evening: '晚上了',
});

function timeSlot(now) {
  const hour = new Date(now).getHours();
  if (hour < 5) return 'late';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'noon';
  if (hour < 18) return 'afternoon';
  if (hour < 23) return 'evening';
  return 'late';
}

/**
 * 生成一条主动内容（纯函数）。
 * @param {{
 *   now?:number, app?:string, title?:string, activeMinutes?:number,
 *   wallpaperTitle?:string, memories?:Array<{text?:string}>, state?:object,
 * }} input
 * @returns {{action:'speak'|'ask'|'record'|'none', line:string, kind:string, reason:string}}
 */
export function buildMindDecision(input = {}) {
  const now = Number(input.now) || Date.now();
  const kind = appKind(input.app);
  const title = String(input.title || '').trim().slice(0, 40);
  const activeMinutes = Math.round(Number(input.activeMinutes) || 0);
  const state = input.state || readMindState(now);
  const used = new Set(state.recent.map(normalizeMindLine));
  const slot = SLOT_WORD[timeSlot(now)] || '';
  const candidates = [];

  if (kind === 'code' && activeMinutes >= MIND_RULES.workAskMinutes) {
    candidates.push({ action: 'ask', line: `你今晚一直在写代码，要不要我帮你把这段整理成文档？`, kind: 'work' });
  }
  if (kind === 'code') {
    candidates.push({ action: 'ask', line: '写了好一会儿了，要不要先歇一下眼睛？', kind: 'code' });
    candidates.push({ action: 'speak', line: '这段看起来快收尾了，需要我帮你顺一遍吗？', kind: 'code' });
  }
  if (kind === 'video') {
    candidates.push({ action: 'ask', line: title ? `在看「${title.slice(0, 16)}」吗？好看的话记我一份。` : '这部片子看到一半停了，是先去忙了吗？', kind: 'video' });
  }
  if (kind === 'meeting') {
    candidates.push({ action: 'ask', line: '会开完了吗？要不要我帮你把要点记下来？', kind: 'meeting' });
  }
  const memories = Array.isArray(input.memories) ? input.memories.filter((item) => item && item.text) : [];
  const firstMemory = memories.length ? String(memories[0].text).replace(/^[^：:]{0,6}[：:]/, '').slice(0, 20) : '';
  if (firstMemory) {
    candidates.push({ action: 'speak', line: `想起你之前说的「${firstMemory}」，后来怎么样了？`, kind: 'memory' });
  }
  if (activeMinutes >= 60) {
    candidates.push({ action: 'speak', line: '忙了一个小时了，起来动一动吧。', kind: 'rest' });
  }
  const wallpaperTitle = String(input.wallpaperTitle || '').trim().slice(0, 16);
  if (wallpaperTitle) candidates.push({ action: 'speak', line: `「${wallpaperTitle}」这张挺耐看。`, kind: 'wallpaper' });
  candidates.push({ action: 'ask', line: slot ? `${slot}，今天过得怎么样？` : '今天过得怎么样？', kind: 'time' });

  for (const candidate of candidates) {
    const line = candidate.line.slice(0, MIND_RULES.maxChars);
    if (used.has(normalizeMindLine(line))) continue;
    return { action: candidate.action, line, kind: candidate.kind, reason: 'ok' };
  }
  return { action: 'none', line: '', kind: '', reason: 'deduped' };
}

/**
 * 一次完整 tick：先过闸门，再给决策。
 * @returns {{ok:boolean, action:'speak'|'ask'|'record'|'none', line:string, kind:string, reason:string}}
 */
export function mindTick(input = {}) {
  const now = Number(input.now) || Date.now();
  const state = input.state || readMindState(now);
  const gate = mindAllowed({ ...input, now, state });
  if (!gate.ok) {
    // 不允许打扰时，仍然可以“只记不说”（观察照常入库，由调用方决定是否写）
    if (gate.reason === 'hour-cap' || gate.reason === 'silent' || gate.reason === 'quiet-hours') {
      return { ok: false, action: input.observationText ? 'record' : 'none', line: '', kind: '', reason: gate.reason };
    }
    return { ok: false, action: 'none', line: '', kind: '', reason: gate.reason };
  }
  const decision = buildMindDecision({ ...input, now, state });
  return { ok: decision.action !== 'none', ...decision, reason: decision.reason === 'ok' ? gate.reason : decision.reason };
}

/** 记一条“说了”：更新时间戳 + 去重窗口。 */
export function markMindSaid(now = Date.now(), line = '', kind = '') {
  const state = readMindState(now);
  const text = String(line || '').trim();
  const recent = text ? [...state.recent, text].slice(-10) : state.recent;
  return writeMindState({
    ...state,
    sayKind: kind || state.sayKind || '',
    saidAt: [...state.saidAt, now].slice(-20),
    recent,
  });
}

/** 记一次 tick（即使什么都没说，也要间隔够了才再 tick）。 */
export function markMindTick(now = Date.now()) {
  const state = readMindState(now);
  return writeMindState({ ...state, lastTickAt: now });
}
