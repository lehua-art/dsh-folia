/**
 * pet-chat-memory.js — **旧版记忆的纯函数残留**（不再读写 `memory.json`）。
 *
 * pre.65 起人设系统使用 `persona-memory.js`；本模块只保留 sanitize / 注入行两个纯函数
 * 给兼容 prompt 与判据使用。旧 `pet-chat/memory.json` 不读、不写、不删（已确认决策 ④）。

/** 上限（工单 B1）。事件是 v2 新增：最多 30 条、30 天过期、注入最近 8 条。 */
export const MEMORY_LIMITS = Object.freeze({
  likes: 20, dislikes: 20, notes: 10, itemChars: 40, promptChars: 80,
  events: 30, eventChars: 80, eventPromptItems: 8, eventPromptChars: 30,
});
/** 事件过期：30 天（毫秒）。 */
export const MEMORY_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const clip = (value, max = MEMORY_LIMITS.itemChars) => String(value ?? '').trim().slice(0, max);
const uniq = (list) => [...new Set(list.filter(Boolean))];
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

/** 旧模块已不读写 `memory.json`；这里保留纯函数给 prompt 兼容/判据使用。 */
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

