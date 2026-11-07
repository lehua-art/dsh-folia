/**
 * pet-chat-proactive.js — **主动闲聊**的判定与状态（工单 C，默认关）。
 *
 * 这个模块只做**判定**（能不能说话），不说话、不发请求：调用方（路由 / 客户端定时器）
 * 拿 `canSpeak()` 的结果决定要不要弹气泡。这样判据可以完全离线测。
 *
 * 五条件（工单 C2，全部满足才说话）：
 *   ① 已开启            ② 今日未超限（proactiveDailyLimit 1–20）
 *   ③ 距上次 ≥ minGapMin  ④ 不在静默时段（quietHours，如 '22:00-08:00'，可跨零点）
 *   ⑤ 用户空闲 ≥10 分钟   ⑥ 非全屏（fullscreen）
 *   （⑦ 随机命中由调用方给 `randomHit`，本模块只把它当条件之一）
 *
 * 状态文件：`<DSH_FOLIA_HOME>/pet-chat/proactive.json`
 *   `{ date:'YYYY-MM-DD', said:0, lastAt:0, skipDate:'' }`
 * 「今天别说了」= 把 skipDate 记成今天，当天不再主动。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 固定阈值（工单 C1/C2）。 */
export const PROACTIVE_RULES = Object.freeze({
  dailyLimitDefault: 10,
  dailyLimitMin: 1,
  dailyLimitMax: 20,
  minGapMinDefault: 120,
  minGapMinMin: 30,
  minGapMinMax: 720,
  idleMinutes: 10,
  // 客户端**每 5 分钟**问一次（不是每秒）：系统级空闲拿不到，用窗口内活动近似，见 docs。
  checkIntervalMs: 5 * 60 * 1000,
});

export const QUIET_HOURS_DEFAULT = '22:00-08:00';

/** 状态文件路径（与记忆同一套根）。 */
export function proactivePath() {
  const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(base, 'pet-chat', 'proactive.json');
}

const dayKey = (date) => {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function emptyProactiveState(now = Date.now()) {
  return { date: dayKey(now), said: 0, lastAt: 0, skipDate: '' };
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
      skipDate: typeof doc.skipDate === 'string' ? doc.skipDate : '',
    };
    // 跨天自动归零（不看昨天说了几条）
    if (state.date !== base.date) return { ...base, skipDate: state.skipDate };
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

/**
 * 静默时段判定（支持跨零点，如 22:00-08:00）。
 * `quietHours` 形状非法 ⇒ 视为**没有静默时段**（宁可多说话，也不要因为配置写错永远不说话）。
 */
export function inQuietHours(quietHours, now = Date.now()) {
  const raw = String(quietHours || '').trim();
  const hit = raw.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!hit) return false;
  const minutes = (hh, mm) => Number(hh) * 60 + Number(mm);
  const start = minutes(hit[1], hit[2]);
  const end = minutes(hit[3], hit[4]);
  if (start === end) return false;
  const date = new Date(now);
  const current = date.getHours() * 60 + date.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end; // 跨零点
}

/**
 * 能不能说话。返回 `{ ok, reason }`，`reason` 用于日志/调试（也是判据的证据）。
 *
 * @param {object} input
 * @param {boolean} input.enabled           proactiveEnabled
 * @param {number}  input.dailyLimit
 * @param {number}  input.minGapMin
 * @param {string}  input.quietHours
 * @param {number}  input.now               注入时间（测试用）
 * @param {number}  input.idleMinutes       用户已空闲多久
 * @param {boolean} input.fullscreen        当前是否全屏
 * @param {boolean} input.randomHit         随机命中（调用方算）
 */
export function canSpeak(input) {
  const {
    enabled, dailyLimit, minGapMin, quietHours, now = Date.now(),
    idleMinutes = 0, fullscreen = false, focused = true, randomHit = true,
  } = input || {};
  if (enabled !== true) return { ok: false, reason: 'disabled' };
  const state = readProactiveState(now);
  if (state.skipDate === dayKey(now)) return { ok: false, reason: 'skip-today' };
  const limit = Math.min(PROACTIVE_RULES.dailyLimitMax, Math.max(PROACTIVE_RULES.dailyLimitMin, Number(dailyLimit) || PROACTIVE_RULES.dailyLimitDefault));
  if (state.said >= limit) return { ok: false, reason: 'daily-limit' };
  const gapMin = Math.min(PROACTIVE_RULES.minGapMinMax, Math.max(PROACTIVE_RULES.minGapMinMin, Number(minGapMin) || PROACTIVE_RULES.minGapMinDefault));
  if (state.lastAt && now - state.lastAt < gapMin * 60000) return { ok: false, reason: 'too-soon' };
  if (inQuietHours(quietHours || QUIET_HOURS_DEFAULT, now)) return { ok: false, reason: 'quiet-hours' };
  if (Number(idleMinutes) < PROACTIVE_RULES.idleMinutes) return { ok: false, reason: 'not-idle' };
  if (fullscreen === true) return { ok: false, reason: 'fullscreen' };
  // 窗口失焦（`document.hasFocus() === false`）：用户多半在看别的应用，不打扰
  if (focused === false) return { ok: false, reason: 'unfocused' };
  if (randomHit !== true) return { ok: false, reason: 'random-miss' };
  return { ok: true, reason: 'ok' };
}

/** 记一条"说了"（同一天累加；跨天自动归零）。 */
export function markSaid(now = Date.now()) {
  const state = readProactiveState(now);
  return writeProactiveState({ ...state, said: state.said + 1, lastAt: now });
}

/** 「今天别说了」：当天不再主动。 */
export function skipToday(now = Date.now()) {
  const state = readProactiveState(now);
  return writeProactiveState({ ...state, skipDate: dayKey(now) });
}

/** 今日还剩几条（气泡区显示「今日已说 N/10」用）。 */
export function todayUsage(now = Date.now(), dailyLimit = PROACTIVE_RULES.dailyLimitDefault) {
  const state = readProactiveState(now);
  const limit = Math.min(PROACTIVE_RULES.dailyLimitMax, Math.max(PROACTIVE_RULES.dailyLimitMin, Number(dailyLimit) || PROACTIVE_RULES.dailyLimitDefault));
  return { said: state.said, limit, remaining: Math.max(0, limit - state.said), skipped: state.skipDate === dayKey(now) };
}
