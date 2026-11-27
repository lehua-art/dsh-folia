/**
 * persona-memory.js — 每个人设的**事件流记忆**。
 *
 * v1.2 起是**双后端**：
 *   · 首选 SQLite + FTS5（`lib/memory-db.js`，node:sqlite 自带，不新增原生依赖）；
 *   · 首次使用把 `memory/events.jsonl` + `summary.json` 迁进 DB，JSONL 原样保留只读备份；
 *   · node:sqlite 不可用 / 迁移失败 / `FOLIA_MEMORY_DB=0` ⇒ 原样回退 JSONL 路径
 *     （旧行为不变，宿主不会因为记忆升级而起不来）。
 *
 * 事件形状对上层保持兼容：{ id, ts, kind, text, importance, refs, personaId }。
 * 召回仍是 top-8 + token 预算（默认 800），只是排序换成 FTS5/BM25 + 30 天半衰期 + 重要度 + 衰减。
 *
 * 旧 `pet-chat-memory.js` 与这里的 `memory.json` 没有任何关系；旧文件不读不引用不删。
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { personaDir } from './persona-store.js';
import {
  memoryDbAvailable, memoryDbPath, migrateFromJsonl, migrationInfo, addEvent as dbAddEvent,
  retrieve as dbRetrieve, listEvents as dbListEvents, deleteEvent as dbDeleteEvent,
  deleteByDate as dbDeleteByDate, rollbackTo as dbRollbackTo, clear as dbClear,
  allEvents as dbAllEvents, eventsCount as dbEventsCount, stats as dbStats,
  saveSummary as dbSaveSummary, readSummary as dbReadSummary, decayTick as dbDecayTick,
} from './memory-db.js';

export const MEMORY_BUDGET = Object.freeze({
  topK: 8,
  tokenBudget: 800,
  /** v1.2：半衰期从 14 天延到 30 天（长期记忆要能“记住上个月的事”）。 */
  recencyHalfLifeDays: 30,
  archiveBytes: 4 * 1024 * 1024,
});

const clip = (value, max) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

export function memoryDir(personaId) {
  return join(personaDir(personaId), 'memory');
}

export function eventsPath(personaId) {
  return join(memoryDir(personaId), 'events.jsonl');
}

export function summaryPath(personaId) {
  return join(memoryDir(personaId), 'summary.json');
}

export function bondPath(personaId) {
  return join(memoryDir(personaId), 'bond.json');
}

export function archiveDir(personaId) {
  return join(memoryDir(personaId), 'archive');
}

/* ── 后端选择（DB 优先，失败回退 JSONL）────────────────────────────────── */

/** personaId → 'ready' | 'fallback'；进程内缓存，避免每轮都试一次迁移。 */
const backends = new Map();

/**
 * 解析该人设的记忆后端。首次调用会做一次迁移（幂等）。
 * @returns {null | {ok:true}} null = 用 JSONL
 */
function dbFor(personaId) {
  const id = String(personaId || '');
  if (!id) return null;
  if (process.env.FOLIA_MEMORY_DB === '0' || process.env.FOLIA_MEMORY_DB === 'off') return null;
  if (!memoryDbAvailable()) return null;
  const known = backends.get(id);
  if (known === 'fallback') return null;
  if (known === 'ready') return { ok: true };
  try {
    const info = migrateFromJsonl(id);
    if (!info || info.ok !== true) {
      backends.set(id, 'fallback');
      return null;
    }
    backends.set(id, 'ready');
    return { ok: true };
  } catch {
    backends.set(id, 'fallback');
    return null;
  }
}

/** 诊断/判据：当前后端（会触发一次解析）。 */
export function memoryBackend(personaId) {
  return dbFor(personaId) ? 'db' : 'jsonl';
}

/** 诊断：迁移状态（不触发迁移的只读视图；DB 不可用时 null）。 */
export function memoryMigrationInfo(personaId) {
  if (!memoryDbAvailable()) return null;
  try { return migrationInfo(String(personaId)); } catch { return null; }
}

function eventId() {
  return 'e_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function sanitizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = clip(raw.text, 4000);
  if (!text) return null;
  return {
    id: /^e_[A-Za-z0-9_-]{1,40}$/.test(String(raw.id || '')) ? String(raw.id) : eventId(),
    ts: Number(raw.ts) || Date.now(),
    kind: ['chat', 'action', 'preference', 'event', 'observation', 'treehole'].includes(String(raw.kind)) ? String(raw.kind) : 'event',
    text,
    importance: Math.max(1, Math.min(10, Math.round(Number(raw.importance) || 5))),
    refs: Array.isArray(raw.refs) ? raw.refs.map((ref) => clip(ref, 80)).filter(Boolean).slice(0, 10) : [],
    personaId: clip(raw.personaId, 40),
  };
}

function rotateIfNeeded(personaId) {
  const file = eventsPath(personaId);
  try {
    if (!existsSync(file) || statSync(file).size < MEMORY_BUDGET.archiveBytes) return;
    const dir = archiveDir(personaId);
    mkdirSync(dir, { recursive: true });
    renameSync(file, join(dir, 'events-' + Date.now() + '.jsonl'));
  } catch { /* 归档失败不阻塞写入：继续追加到 live */ }
}

/* ── JSONL 后端（回退路径；与原实现逐行一致）───────────────────────────── */

/** 追加一条事件；返回落盘后的形状。 */
function appendEventJsonl(personaId, raw) {
  const event = sanitizeEvent(raw);
  if (!event) throw Object.assign(new Error('bad-event'), { code: 'bad-event' });
  event.personaId = personaId;
  const dir = memoryDir(personaId);
  mkdirSync(dir, { recursive: true });
  rotateIfNeeded(personaId);
  appendFileSync(eventsPath(personaId), JSON.stringify(event) + '\n');
  return event;
}

/** 读所有分片（archive 按文件名时间排序 + live），坏行跳过。 */
function readAllEventsJsonl(personaId) {
  const files = [];
  try {
    const dir = archiveDir(personaId);
    if (existsSync(dir)) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) files.push(join(dir, name));
    }
  } catch { /* ignore */ }
  files.push(eventsPath(personaId));
  const out = [];
  for (const file of files) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = sanitizeEvent(JSON.parse(line));
        if (event) out.push({ ...event, personaId });
      } catch { /* 坏行跳过 */ }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/* ── 统一 API（内部按后端分派）──────────────────────────────────────────── */

/** 追加一条事件；返回落盘后的形状。 */
export function appendEvent(personaId, raw) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try {
      const item = dbAddEvent(id, {
        text: raw && raw.text,
        kind: raw && raw.kind,
        importance: raw && raw.importance,
        ts: raw && raw.ts,
        pinned: raw && (raw.pinned === true || raw.kind === 'preference'),
        source: (raw && raw.source) || 'chat',
        tags: raw && raw.refs,
      });
      return { ...item, id: String(item.id), refs: [], personaId: id };
    } catch (error) {
      // DB 写失败 ⇒ 本进程降级到 JSONL（不能让一句记忆把聊天打断）
      backends.set(id, 'fallback');
    }
  }
  return appendEventJsonl(id, raw);
}

/** 读所有事件（DB 或 JSONL，按时间升序）。 */
export function readAllEvents(personaId) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try {
      return dbAllEvents(id).map((item) => ({ ...item, id: String(item.id), refs: [], personaId: id }));
    } catch { backends.set(id, 'fallback'); }
  }
  return readAllEventsJsonl(id);
}

export function eventCount(personaId) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try { return dbEventsCount(id); } catch { backends.set(id, 'fallback'); }
  }
  return readAllEventsJsonl(id).length;
}

/** 分页 + 搜索（界面时间线用；新→旧）。 */
export function listEvents(personaId, { offset = 0, limit = 50, q = '' } = {}) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try {
      const page = dbListEvents(id, { offset, limit, q });
      return { ...page, items: page.items.map((item) => ({ ...item, id: String(item.id), refs: [], personaId: id })) };
    } catch { backends.set(id, 'fallback'); }
  }
  const query = String(q || '').trim().toLowerCase();
  const all = readAllEventsJsonl(id)
    .filter((event) => !query || event.text.toLowerCase().includes(query))
    .sort((a, b) => b.ts - a.ts);
  const start = Math.max(0, Number(offset) || 0);
  const take = Math.min(200, Math.max(1, Number(limit) || 50));
  return { total: all.length, offset: start, limit: take, items: all.slice(start, start + take) };
}

/** 删除单条事件（DB 走 rowid；JSONL 走合并重写）。 */
export function deleteEvent(personaId, eventIdToDelete) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try {
      const result = dbDeleteEvent(id, eventIdToDelete);
      if (result && result.ok) return { ok: true, id: String(eventIdToDelete), remaining: eventCount(id) };
      return { ok: false, error: 'not-found' };
    } catch { backends.set(id, 'fallback'); }
  }
  const all = readAllEventsJsonl(id);
  const kept = all.filter((event) => event.id !== String(eventIdToDelete));
  if (kept.length === all.length) return { ok: false, error: 'not-found' };
  const dir = archiveDir(id);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(memoryDir(id), { recursive: true });
  writeFileSync(eventsPath(id), kept.map((event) => JSON.stringify(event)).join('\n') + (kept.length ? '\n' : ''));
  return { ok: true, id: String(eventIdToDelete), remaining: kept.length };
}

/** 按日期删除（YYYY-MM-DD；DB 优先）。 */
export function deleteEventsByDate(personaId, dateKey) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try { return dbDeleteByDate(id, dateKey); } catch { backends.set(id, 'fallback'); }
  }
  const parts = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return { ok: false, error: 'bad-date', deleted: 0 };
  const start = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])).getTime();
  const end = start + 86400000;
  const all = readAllEventsJsonl(id);
  const kept = all.filter((event) => !(event.ts >= start && event.ts < end));
  mkdirSync(memoryDir(id), { recursive: true });
  writeFileSync(eventsPath(id), kept.map((event) => JSON.stringify(event)).join('\n') + (kept.length ? '\n' : ''));
  return { ok: true, deleted: all.length - kept.length, date: dateKey };
}

/** 回滚到 beforeTs 之前（之后写入的事件删除）。 */
export function rollbackEvents(personaId, beforeTs) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try { return dbRollbackTo(id, beforeTs); } catch { backends.set(id, 'fallback'); }
  }
  return { ok: false, error: 'jsonl-backend', deleted: 0 };
}

export function clearEvents(personaId) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try { dbClear(id); } catch { backends.set(id, 'fallback'); }
  }
  try { rmSync(memoryDir(id), { recursive: true, force: true }); } catch { /* ignore */ }
  // DB 文件刚被删掉：本进程的连接缓存要作废，否则下一次写会写进已删除的句柄。
  backends.delete(id);
}

/** 衰减 tick（DB 后端才有效；JSONL 无衰减，返回 total 统计）。 */
export function decayTick(personaId, options = {}) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try { return dbDecayTick(id, options); } catch { backends.set(id, 'fallback'); }
  }
  return { ok: true, archived: 0, decayed: 0, total: readAllEventsJsonl(id).length, backend: 'jsonl' };
}

/** 记忆统计（界面「记忆」页用）。 */
export function memoryStats(personaId) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try { return { ...dbStats(id), backend: 'db' }; } catch { backends.set(id, 'fallback'); }
  }
  return { ok: true, personaId: id, events: readAllEventsJsonl(id).length, backend: 'jsonl', path: eventsPath(id) };
}

/* ── 摘要 / 好感快照（写入与读取都按 persona 隔离） ───────────────────── */

export function readSummary(personaId) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try {
      const doc = dbReadSummary(id);
      return { text: clip(doc.text, 8000), updatedAt: Number(doc.updatedAt) || 0 };
    } catch { backends.set(id, 'fallback'); }
  }
  try {
    const doc = JSON.parse(readFileSync(summaryPath(id), 'utf8'));
    return { text: clip(doc.text, 8000), updatedAt: Number(doc.updatedAt) || 0 };
  } catch {
    return { text: '', updatedAt: 0 };
  }
}

export function writeSummary(personaId, text) {
  const id = String(personaId || '');
  if (dbFor(id)) {
    try {
      dbSaveSummary(id, 'latest', text);
      return { text: clip(text, 8000), updatedAt: Date.now() };
    } catch { backends.set(id, 'fallback'); }
  }
  mkdirSync(memoryDir(id), { recursive: true });
  const doc = { text: clip(text, 8000), updatedAt: Date.now() };
  writeFileSync(summaryPath(id), JSON.stringify(doc, null, 2));
  return doc;
}

export function readBond(personaId) {
  try {
    const doc = JSON.parse(readFileSync(bondPath(personaId), 'utf8'));
    return {
      affection: Math.max(0, Math.min(1, Number(doc.affection) || 0.5)),
      trust: Math.max(0, Math.min(1, Number(doc.trust) || 0.5)),
      mood: clip(doc.mood || 'neutral', 30),
      updatedAt: Number(doc.updatedAt) || 0,
    };
  } catch {
    return { affection: 0.5, trust: 0.5, mood: 'neutral', updatedAt: 0 };
  }
}

export function writeBond(personaId, patch) {
  const cur = readBond(personaId);
  const next = {
    affection: Math.max(0, Math.min(1, Number(patch.affection ?? cur.affection) || 0)),
    trust: Math.max(0, Math.min(1, Number(patch.trust ?? cur.trust) || 0)),
    mood: clip(patch.mood || cur.mood, 30),
    updatedAt: Date.now(),
  };
  mkdirSync(memoryDir(personaId), { recursive: true });
  writeFileSync(bondPath(personaId), JSON.stringify(next, null, 2));
  return next;
}

/* ── 检索：FTS5/BM25 + 新近 + 重要度 + 衰减 ─────────────────────────────── */

/** 极简 tokenizer（JSONL 回退路径用；中文按双字，英文按词）。 */
export function tokenize(text) {
  const raw = String(text || '').toLowerCase();
  const tokens = [];
  for (const word of raw.match(/[a-z0-9]{2,}/g) || []) tokens.push(word);
  const cjk = raw.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length; i += 1) {
    if (i + 1 < cjk.length) tokens.push(cjk.slice(i, i + 2));
  }
  return tokens;
}

/** 估算 token：中文按 1.5 字/token，英文词按 1.3。只用于预算，不追求精确。 */
export function estimateTokens(text) {
  const raw = String(text || '');
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (raw.match(/[a-zA-Z0-9]+/g) || []).length;
  return Math.ceil(cjk / 1.5 + words * 1.3 + Math.max(0, raw.length - cjk) * 0.05);
}

/** JSONL 回退召回（原实现；DB 可用时走 memory-db 的混合检索）。 */
function retrieveEventsJsonl(personaId, query, options = {}) {
  const now = options.now || Date.now();
  const topK = Math.max(1, Math.min(20, Number(options.topK) || MEMORY_BUDGET.topK));
  const budget = Math.max(80, Number(options.tokenBudget) || MEMORY_BUDGET.tokenBudget);
  const all = readAllEventsJsonl(personaId);
  if (!all.length) return { items: [], tokens: 0, total: 0 };
  const qTokens = [...new Set(tokenize(query))];
  const docs = all.map((event) => {
    const tokens = tokenize(event.text);
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    return { event, tokens, tf, len: tokens.length };
  });
  const avgLen = docs.reduce((sum, doc) => sum + doc.len, 0) / Math.max(1, docs.length) || 1;
  const df = new Map();
  for (const token of qTokens) {
    df.set(token, docs.reduce((n, doc) => n + (doc.tf.has(token) ? 1 : 0), 0));
  }
  const N = docs.length;
  const scored = docs.map((doc) => {
    let bm25 = 0;
    for (const token of qTokens) {
      const f = doc.tf.get(token) || 0;
      if (!f) continue;
      const n = df.get(token) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = f + 1.2 * (1 - 0.75 + 0.75 * doc.len / avgLen);
      bm25 += idf * (f * 2.2) / denom;
    }
    const relevance = Math.max(0, Math.min(1, bm25 / 3));
    const ageDays = Math.max(0, (now - doc.event.ts) / (24 * 60 * 60 * 1000));
    const recency = Math.pow(0.5, ageDays / MEMORY_BUDGET.recencyHalfLifeDays);
    const importance = Math.max(0, Math.min(1, (Number(doc.event.importance) || 5) / 10));
    const score = 0.5 * relevance + 0.3 * recency + 0.2 * importance;
    return { event: doc.event, score, relevance };
  }).sort((a, b) => b.score - a.score);

  const items = [];
  let tokens = 0;
  for (const row of scored) {
    if (items.length >= topK) break;
    const cost = estimateTokens(row.event.text) + 4;
    if (items.length && tokens + cost > budget) continue;
    items.push({ ...row.event, score: Number(row.score.toFixed(4)), relevance: Number(row.relevance.toFixed(4)) });
    tokens += cost;
  }
  return { items, tokens, total: all.length };
}

/**
 * 召回 top-k 事件，按 token 预算截断（DB 可用时：FTS5 + 30 天半衰期 + 重要度 + 衰减）。
 * 没有找到任何相关事件时仍按“新近 + 重要度”兜底，不返回空（人格需要连续性）。
 */
export function retrieveEvents(personaId, query, options = {}) {
  const id = String(personaId || '');
  const topK = Math.max(1, Math.min(20, Number(options.topK) || MEMORY_BUDGET.topK));
  const tokenBudget = Math.max(80, Number(options.tokenBudget) || MEMORY_BUDGET.tokenBudget);
  if (dbFor(id)) {
    try {
      const result = dbRetrieve(id, {
        query,
        topK,
        budgetChars: MEMORY_DB_CHARS,
        now: options.now,
      });
      // 字符预算与 token 预算双保险（旧判据断言 memoryTokens ≤ 800）
      const items = [];
      let tokens = 0;
      for (const item of result.items) {
        const nextTokens = tokens + estimateTokens(item.text) + 4;
        if (items.length && nextTokens > tokenBudget) continue;
        items.push({ ...item, id: String(item.id), refs: [], personaId: id });
        tokens = nextTokens;
      }
      return { items, tokens, total: result.total, backend: 'db' };
    } catch { backends.set(id, 'fallback'); }
  }
  return retrieveEventsJsonl(id, query, options);
}

/** DB 的字符预算（1200 字，任务书 §3.4）。 */
const MEMORY_DB_CHARS = 1200;

/** 注入 system 的召回块（没有事件返回空串）。 */
export function memoryRecallLine(items) {
  const list = Array.isArray(items) ? items.filter((item) => item && item.text).slice(0, MEMORY_BUDGET.topK) : [];
  if (!list.length) return '';
  const lines = list.map((item) => '- ' + clip(item.text, 160));
  return '你记得这些相关的事（只作背景，不要逐条复述）：\n' + lines.join('\n');
}

/* ── v1.2 观察记录 ──────────────────────────────────────────────────────── */

/**
 * 写一条观察（被动观察/屏幕感知用）：kind=observation、importance 2–3，默认不进气泡。
 * @returns {object|null} 写入的事件（失败返回 null，不抛给采样器）
 */
export function recordObservation(personaId, input = {}) {
  const text = String(input.text || '').trim().slice(0, 300);
  if (!text) return null;
  try {
    return appendEvent(personaId, {
      kind: 'observation',
      importance: Math.max(2, Math.min(3, Math.round(Number(input.importance) || 2))),
      text,
      source: String(input.source || 'observe').slice(0, 20),
      ts: input.ts,
    });
  } catch {
    return null;
  }
}

/** 观察记录列表（按 type/source 过滤；界面「观察记录」页用）。 */
export function listObservations(personaId, { offset = 0, limit = 50 } = {}) {
  const page = listEvents(personaId, { offset, limit: Math.min(200, Math.max(1, Number(limit) || 50)) });
  const items = page.items.filter((item) => item.kind === 'observation');
  return { total: items.length, offset, limit, items };
}

/** 清空观察记录（只删 observation，不动普通记忆）。 */
export function clearObservations(personaId) {
  let removed = 0;
  for (const item of readAllEvents(personaId)) {
    if (item.kind !== 'observation') continue;
    try { if (deleteEvent(personaId, item.id).ok) removed += 1; } catch { /* ignore */ }
  }
  return { ok: true, removed };
}

/** 记忆库路径（诊断；DB 不可用时返回 JSONL 路径）。 */
export function memoryStoragePath(personaId) {
  return dbFor(personaId) ? memoryDbPath(String(personaId)) : eventsPath(personaId);
}
