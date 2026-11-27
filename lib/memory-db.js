/**
 * memory-db.js — 长期记忆 v2（SQLite + FTS5 + 衰减 + 关系 + 世界书）。
 *
 * 为什么是 node:sqlite：宿主 Node ≥22.12 自带 `node:sqlite`（本机实测 SQLite 3.50.4、
 * FTS5 可用），因此**不需要**新增 better-sqlite3 这类原生依赖 —— 这正是任务书的硬约束。
 *
 * 每个人设一个库：`<persona>/memory/memory.db`（由 personaDir 决定根目录）。
 *
 * 表：
 *   events(id, persona_id, kind, text, importance 1-10, created_at, last_used_at,
 *          strength, pinned 0/1, source, tags, archived, embedding, vector_source)
 *   events_fts(text)            -- FTS5 contentless_delete（存 bigram 分词后的索引串）
 *   relations(persona_id, entity, affinity -10..10, notes, updated_at)
 *   lore(id, persona_id, title, content, chunk_no, source, created_at)
 *   lore_fts(text)
 *   summaries(persona_id, period, text, created_at)
 *   meta(key, value)
 *
 * 中文为什么不是直接用 unicode61：FTS5 的默认分词器把连续中文当成**一个 token**，
 * “咖啡”查不到“我喜欢喝咖啡”。所以入库前用与查询同一套 `tokenizeForIndex()` 做
 * bigram 预分词（英文按词、中文按双字），索引串存进 events_fts —— BM25 排序照旧由
 * SQLite 算。这是**明确的取舍**，写在迁移说明里，不假装是原生中文分词。
 *
 * 向量：有注入的 `embedder` 才写 embedding（列里同时记 vector_source='onnx' 或 'js-ngram'）；
 * 没有 embedder 时用 JS 字符 n-gram 余弦做**排序补偿**，但不写 embedding 列 ——
 * 不把“JS 兜底”冒充成 ONNX 向量。
 *
 * 所有 API 都是**同步**的（DatabaseSync 本身就同步）；路由里调用不会卡事件循环太久
 * （单库操作都是毫秒级，FTS 检索 top-8）。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { personaDir } from './persona-store.js';

const require = createRequire(import.meta.url);

/** 与 persona-memory 的预算口径保持一致（1200 字 ≈ 800 token）。 */
export const MEMORY_DB_BUDGET = Object.freeze({
  topK: 8,
  budgetChars: 1200,
  tokenBudget: 800,
  recencyHalfLifeDays: 30,
  archiveBelow: 0.05,
  maxEventChars: 4000,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'event',
  text TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  strength REAL NOT NULL DEFAULT 5,
  pinned INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  embedding TEXT,
  vector_source TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_persona ON events(persona_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_archived ON events(persona_id, archived);
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(text, content='', contentless_delete=1);
CREATE TABLE IF NOT EXISTS relations(
  persona_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  affinity INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(persona_id, entity)
);
CREATE TABLE IF NOT EXISTS lore(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  chunk_no INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lore_persona ON lore(persona_id, chunk_no);
CREATE VIRTUAL TABLE IF NOT EXISTS lore_fts USING fts5(text, content='', contentless_delete=1);
CREATE TABLE IF NOT EXISTS summaries(
  persona_id TEXT NOT NULL,
  period TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(persona_id, period)
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/* ── 可用性 / 路径 ───────────────────────────────────────────────────────── */

let sqliteModule;
let sqliteLoadError = '';
/** node:sqlite 是否可用（进程内缓存；失败原因只在诊断里出现一次）。 */
export function memoryDbAvailable() {
  if (sqliteModule !== undefined) return Boolean(sqliteModule);
  if (process.env.FOLIA_MEMORY_DB === '0' || process.env.FOLIA_MEMORY_DB === 'off') {
    sqliteModule = null;
    sqliteLoadError = 'disabled-by-env';
    return false;
  }
  try {
    // node:sqlite 是内置模块，createRequire 在 ESM 里也稳。
    // 用 require 而不是顶层 import，保证「不可用 ⇒ 回退 JSONL」不会在模块加载期炸掉宿主。
    sqliteModule = require('node:sqlite');
  } catch (error) {
    sqliteModule = null;
    sqliteLoadError = String((error && error.message) || error);
  }
  return Boolean(sqliteModule);
}

/** `<persona>/memory/memory.db`；personaId 由 personaDir 负责清洗。 */
export function memoryDbPath(personaId) {
  return join(personaDir(personaId), 'memory', 'memory.db');
}

/* ── 分词 / 估价 ─────────────────────────────────────────────────────────── */

/** 中文 bigram + 英文/数字词：入库与查询共用，保证两边口径一致。 */
export function tokenizeForIndex(text) {
  const raw = String(text == null ? '' : text).toLowerCase();
  const tokens = [];
  for (const word of raw.match(/[a-z0-9]{2,}/g) || []) tokens.push(word);
  const cjk = raw.replace(/[^\u4e00-\u9fff]/g, '');
  for (let i = 0; i < cjk.length; i += 1) {
    if (i + 1 < cjk.length) tokens.push(cjk.slice(i, i + 2));
  }
  // 单个汉字也要能命中（否则「猫」这类一字查询只能走 LIKE 兜底）
  for (const ch of new Set(cjk)) tokens.push(ch);
  return [...new Set(tokens)];
}

/** 检索报价：中文 1.5 字/token、英文词 1.3（与 persona-memory 同口径）。 */
export function estimateMemoryTokens(text) {
  const raw = String(text || '');
  const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (raw.match(/[a-zA-Z0-9]+/g) || []).length;
  return Math.ceil(cjk / 1.5 + words * 1.3 + Math.max(0, raw.length - cjk) * 0.05);
}

const clip = (value, max) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

/** 字符 n-gram 余弦（没有 ONNX 时的兜底排序信号；不写库、不冒充向量）。 */
export function ngramCosine(a, b, n = 2) {
  const grams = (text) => {
    const raw = String(text || '').toLowerCase().replace(/\s+/g, '');
    const map = new Map();
    for (let i = 0; i < raw.length; i += 1) {
      const gram = raw.slice(i, i + n);
      if (gram.length < n) continue;
      map.set(gram, (map.get(gram) || 0) + 1);
    }
    return map;
  };
  const left = grams(a);
  const right = grams(b);
  if (!left.size || !right.size) return 0;
  let dot = 0;
  let la = 0;
  let lb = 0;
  for (const value of left.values()) la += value * value;
  for (const value of right.values()) lb += value * value;
  for (const [gram, value] of left) {
    const other = right.get(gram);
    if (other) dot += value * other;
  }
  const denom = Math.sqrt(la) * Math.sqrt(lb);
  return denom ? dot / denom : 0;
}

/* ── 连接管理 ───────────────────────────────────────────────────────────── */

/**
 * **每次操作开一个连接、用完就关**（有意为之）：
 *   · Windows 上打开的文件句柄会阻止 `rmSync` 删人设目录（`deletePersona` / `clearEvents`
 *     都是整目录删除），长连接会让“删除人设”静默失败；
 *   · 单次 open 是亚毫秒级，聊天一轮只有个位数操作，不值得为它引入连接生命周期管理。
 */
function openDb(personaId) {
  const file = memoryDbPath(personaId);
  if (!memoryDbAvailable()) {
    throw Object.assign(new Error('memory-db-unavailable: ' + (sqliteLoadError || 'no node:sqlite')), { code: 'unavailable' });
  }
  mkdirSync(dirname(file), { recursive: true });
  const db = new sqliteModule.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 4000;');
  db.exec(SCHEMA);
  return db;
}

/** 判据/诊断用：当前没有常驻连接（连接按次打开、按次关闭）。 */
function withDb(personaId, fn) {
  const db = openDb(personaId);
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/* ── 事件 ───────────────────────────────────────────────────────────────── */

/**
 * 写一条事件。字段与 JSONL 时代兼容（ts ↔ created_at）。
 * @returns {{id:number, ts:number, kind:string, text:string, importance:number, pinned:boolean, personaId:string}}
 */
export function addEvent(personaId, raw = {}) {
  const text = clip(raw.text, MEMORY_DB_BUDGET.maxEventChars).trim();
  if (!text) throw Object.assign(new Error('bad-event'), { code: 'bad-event' });
  const kind = ['chat', 'action', 'preference', 'event', 'observation', 'lore', 'treehole'].includes(String(raw.kind))
    ? String(raw.kind) : 'event';
  const importance = Math.max(1, Math.min(10, Math.round(Number(raw.importance) || 5)));
  const ts = Number(raw.ts ?? raw.created_at) || Date.now();
  const pinned = raw.pinned === true ? 1 : 0;
  const source = clip(raw.source || '', 40);
  const tags = Array.isArray(raw.tags) ? raw.tags.map((tag) => clip(tag, 20)).filter(Boolean).join(',') : clip(raw.tags || '', 120);
  // strength 的语义是“衰减时间尺度（天）”：importance 越高忘得越慢；pinned 永不衰减。
  const strength = Math.max(1, Number(raw.strength) || importance * 3);
  const embedding = raw.embedding ? JSON.stringify(raw.embedding) : null;
  const vectorSource = embedding ? clip(raw.vectorSource || 'js-ngram', 20) : null;
  return withDb(personaId, (db) => {
    const info = db.prepare(`INSERT INTO events
      (persona_id, kind, text, importance, created_at, last_used_at, strength, pinned, source, tags, archived, embedding, vector_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
      .run(String(personaId), kind, text, importance, ts, ts, strength, pinned, source, tags, embedding, vectorSource);
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO events_fts(rowid, text) VALUES (?, ?)')
      .run(id, tokenizeForIndex(text).join(' '));
    return { id, ts, kind, text, importance, pinned: pinned === 1, personaId: String(personaId), source, tags };
  });
}

/** 单条事件（内部用）。 */
function eventRowToItem(row) {
  return {
    id: Number(row.id),
    ts: Number(row.created_at),
    kind: row.kind,
    text: row.text,
    importance: Number(row.importance),
    pinned: row.pinned === 1,
    source: row.source || '',
    tags: row.tags || '',
    archived: row.archived === 1,
    strength: Number(row.strength) || 1,
    lastUsedAt: Number(row.last_used_at) || 0,
    personaId: row.persona_id,
  };
}

/** FTS5 查询串：tokens 用 OR 连接（中文 bigram 已在两侧统一）。 */
function ftsQueryFor(query) {
  const tokens = tokenizeForIndex(query);
  if (!tokens.length) return '';
  return tokens.slice(0, 24).map((token) => '"' + token.replace(/"/g, '""') + '"').join(' OR ');
}

/** 命中条数（诊断用）。 */
export function eventsCount(personaId) {
  return withDb(personaId, (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM events WHERE persona_id = ?').get(String(personaId)).n) || 0);
}

/**
 * FTS5 + bm25 检索（只检索，不做预算/衰减排序 —— 那是 retrieve 的事）。
 * 没有命中时返回空数组；query 为空返回最近事件。
 */
export function search(personaId, query, options = {}) {
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 8));
  const match = ftsQueryFor(query);
  return withDb(personaId, (db) => {
    if (!match) {
      const rows = db.prepare(`SELECT * FROM events WHERE persona_id = ? AND archived = 0
        ORDER BY created_at DESC LIMIT ?`).all(String(personaId), limit);
      return rows.map(eventRowToItem);
    }
    let rows = [];
    try {
      rows = db.prepare(`SELECT e.*, bm25(events_fts) AS rank FROM events_fts
        JOIN events e ON e.id = events_fts.rowid
        WHERE events_fts MATCH ? AND e.persona_id = ? AND e.archived = 0
        ORDER BY rank LIMIT ?`).all(match, String(personaId), limit);
    } catch {
      rows = [];
    }
    if (!rows.length) {
      // 一字/生僻查询的兜底：LIKE（仍受 limit 限制，不扫全库返回）
      const like = '%' + String(query).trim().slice(0, 40) + '%';
      rows = db.prepare(`SELECT * FROM events WHERE persona_id = ? AND archived = 0 AND text LIKE ?
        ORDER BY created_at DESC LIMIT ?`).all(String(personaId), like, limit);
    }
    return rows.map((row) => ({ ...eventRowToItem(row), rank: row.rank === undefined ? null : Number(row.rank) }));
  });
}

/**
 * 混合召回：FTS5 + recency（半衰期 30 天）+ importance + 衰减保留度；预算 1200 字 / top-8。
 * @returns {{items:Array, tokens:number, chars:number, total:number, usedFts:boolean}}
 */
export function retrieve(personaId, options = {}) {
  const now = Number(options.now) || Date.now();
  const topK = Math.max(1, Math.min(20, Number(options.topK) || MEMORY_DB_BUDGET.topK));
  const budgetChars = Math.max(80, Number(options.budgetChars) || MEMORY_DB_BUDGET.budgetChars);
  const query = String(options.query || '');
  return withDb(personaId, (db) => {
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM events WHERE persona_id = ? AND archived = 0').get(String(personaId)).n) || 0;
    if (!total) return { items: [], tokens: 0, chars: 0, total: 0, usedFts: false };
    const match = ftsQueryFor(query);
    /**
     * **混合候选池**（不是「FTS 命中就只看 FTS」）：
     *   FTS top-60 ∪ 最近 60 条 ∪ 全部 pinned（最多 30）。
     * 为什么必须并集：用户上一句刚说“记住我喜欢原神”，下一句问“今天桌面有点乱”时 FTS
     * 只会命中一两条无关事件 —— 若此时不回看最近事件，pinned 偏好就被挤掉，人设立刻失忆。
     * 这是 v1.2 实测到的真实缺陷（verify-pet-chat B①）。
     */
    const byId = new Map();
    const addRows = (list) => {
      for (const row of list) {
        const key = Number(row.id);
        if (!byId.has(key)) byId.set(key, row);
        else if (row.rank !== undefined && byId.get(key).rank === undefined) byId.set(key, row);
      }
    };
    if (match) {
      try {
        addRows(db.prepare(`SELECT e.*, bm25(events_fts) AS rank FROM events_fts
          JOIN events e ON e.id = events_fts.rowid
          WHERE events_fts MATCH ? AND e.persona_id = ? AND e.archived = 0
          ORDER BY rank LIMIT 60`).all(match, String(personaId)));
      } catch { /* FTS 语法/索引问题 ⇒ 只用最近事件兜底 */ }
    }
    addRows(db.prepare(`SELECT * FROM events WHERE persona_id = ? AND archived = 0
      ORDER BY created_at DESC LIMIT 60`).all(String(personaId)));
    addRows(db.prepare(`SELECT * FROM events WHERE persona_id = ? AND pinned = 1 AND archived = 0
      ORDER BY created_at DESC LIMIT 30`).all(String(personaId)));
    const rows = [...byId.values()];
    const bestRank = rows.reduce((min, row) => (Number.isFinite(Number(row.rank)) && Number(row.rank) < 0 ? Math.min(min, Number(row.rank)) : min), 0);
    const scored = rows.map((row) => {
      const item = eventRowToItem(row);
      const rank = Number(row.rank);
      // bm25 越小越相关；用“相对最佳命中”做归一，避免绝对量纲随库大小漂移。
      const relevance = Number.isFinite(rank) && rank < 0 && bestRank < 0
        ? Math.max(0, Math.min(1, rank / bestRank))
        : (match && Number.isFinite(rank) ? 0.2 : 0);
      const ageDays = Math.max(0, (now - item.ts) / 86400000);
      const recency = Math.pow(0.5, ageDays / MEMORY_DB_BUDGET.recencyHalfLifeDays);
      const importance = Math.max(0, Math.min(1, item.importance / 10));
      const retention = item.pinned ? 1 : Math.exp(-ageDays / Math.max(1, item.strength));
      const semantic = query ? ngramCosine(query, item.text) : 0;
      const score = item.pinned
        ? 1
        : (0.45 * relevance + 0.25 * recency + 0.2 * importance + 0.1 * retention) * (0.5 + 0.5 * retention)
          + 0.05 * semantic;
      return { ...item, relevance: Number(relevance.toFixed(4)), retention: Number(retention.toFixed(4)), score: Number(score.toFixed(4)) };
    }).sort((a, b) => b.score - a.score);

    const items = [];
    let chars = 0;
    let tokens = 0;
    for (const row of scored) {
      if (items.length >= topK) break;
      const cost = [...row.text].length;
      if (items.length && chars + cost > budgetChars) continue;
      items.push(row);
      chars += cost;
      tokens += estimateMemoryTokens(row.text) + 4;
      // 命中即“唤醒”：strength +1（pinned 不衰减也不加）
      if (!row.pinned) {
        try {
          db.prepare('UPDATE events SET last_used_at = ?, strength = strength + 1 WHERE id = ?').run(now, row.id);
        } catch { /* 记账失败不影响召回 */ }
      }
    }
    return { items, tokens, chars, total, usedFts: Boolean(match) };
  });
}

/**
 * 艾宾浩斯衰减 tick：retention = exp(-days/strength)；低于阈值归档（**不删**）。
 * pinned 永不衰减；importance ≥ 8 的事件也不归档（“重要的事不该忘”）。
 */
export function decayTick(personaId, options = {}) {
  const now = Number(options.now) || Date.now();
  return withDb(personaId, (db) => {
    const rows = db.prepare('SELECT id, importance, created_at, last_used_at, strength, pinned FROM events WHERE persona_id = ? AND archived = 0')
      .all(String(personaId));
    let archived = 0;
    let decayed = 0;
    const update = db.prepare('UPDATE events SET archived = ? WHERE id = ?');
    for (const row of rows) {
      if (row.pinned === 1) continue;
      const last = Number(row.last_used_at) || Number(row.created_at);
      const days = Math.max(0, (now - last) / 86400000);
      const strength = Math.max(1, Number(row.strength) || 1);
      const retention = Math.exp(-days / strength);
      if (retention < MEMORY_DB_BUDGET.archiveBelow && Number(row.importance) < 8) {
        update.run(1, row.id);
        archived += 1;
      } else if (retention < 0.5) {
        decayed += 1;
      }
    }
    return { ok: true, archived, decayed, total: rows.length };
  });
}

/** 全部事件（含归档；JSONL 兼容层/诊断用）。 */
export function allEvents(personaId, options = {}) {
  const includeArchived = options.includeArchived !== false;
  return withDb(personaId, (db) => {
    const sql = 'SELECT * FROM events WHERE persona_id = ?' + (includeArchived ? '' : ' AND archived = 0')
      + ' ORDER BY created_at ASC';
    return db.prepare(sql).all(String(personaId)).map(eventRowToItem);
  });
}

/** 事件列表（UI 时间线；新→旧，可按关键词过滤）。 */
export function listEvents(personaId, options = {}) {
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
  const query = String(options.q || '').trim();
  return withDb(personaId, (db) => {
    let rows;
    let total;
    if (query) {
      const like = '%' + query + '%';
      total = Number(db.prepare('SELECT COUNT(*) AS n FROM events WHERE persona_id = ? AND text LIKE ?').get(String(personaId), like).n) || 0;
      rows = db.prepare(`SELECT * FROM events WHERE persona_id = ? AND text LIKE ?
        ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(String(personaId), like, limit, offset);
    } else {
      total = eventsCount(personaId);
      rows = db.prepare(`SELECT * FROM events WHERE persona_id = ?
        ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(String(personaId), limit, offset);
    }
    return { total, offset, limit, items: rows.map(eventRowToItem) };
  });
}

/** 删除单条事件（FTS 索引同步删）。 */
export function deleteEvent(personaId, eventId) {
  const id = Number(eventId);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'not-found' };
  return withDb(personaId, (db) => {
    const row = db.prepare('SELECT id FROM events WHERE id = ? AND persona_id = ?').get(id, String(personaId));
    if (!row) return { ok: false, error: 'not-found' };
    db.prepare('DELETE FROM events_fts WHERE rowid = ?').run(id);
    db.prepare('DELETE FROM events WHERE id = ?').run(id);
    return { ok: true, id: String(eventId) };
  });
}

/** 按本地日期（YYYY-MM-DD）删事件 —— “按日期回滚”。 */
export function deleteByDate(personaId, dateKey) {
  const parts = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return { ok: false, error: 'bad-date', deleted: 0 };
  const start = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 0, 0, 0, 0).getTime();
  const end = start + 86400000;
  return withDb(personaId, (db) => {
    const rows = db.prepare('SELECT id FROM events WHERE persona_id = ? AND created_at >= ? AND created_at < ?')
      .all(String(personaId), start, end);
    const delFts = db.prepare('DELETE FROM events_fts WHERE rowid = ?');
    const del = db.prepare('DELETE FROM events WHERE id = ?');
    for (const row of rows) { delFts.run(row.id); del.run(row.id); }
    return { ok: true, deleted: rows.length, date: dateKey };
  });
}

/** 回滚到某个时间点之后（更“版本化”的口径：保留 <= before 的事件）。 */
export function rollbackTo(personaId, beforeTs) {
  const ts = Number(beforeTs);
  if (!Number.isFinite(ts)) return { ok: false, error: 'bad-time', deleted: 0 };
  return withDb(personaId, (db) => {
    const rows = db.prepare('SELECT id FROM events WHERE persona_id = ? AND created_at > ?').all(String(personaId), ts);
    const delFts = db.prepare('DELETE FROM events_fts WHERE rowid = ?');
    const del = db.prepare('DELETE FROM events WHERE id = ?');
    for (const row of rows) { delFts.run(row.id); del.run(row.id); }
    return { ok: true, deleted: rows.length, before: ts };
  });
}

export function clear(personaId) {
  return withDb(personaId, (db) => {
    const ids = db.prepare('SELECT id FROM events WHERE persona_id = ?').all(String(personaId));
    const delFts = db.prepare('DELETE FROM events_fts WHERE rowid = ?');
    for (const row of ids) delFts.run(row.id);
    db.prepare('DELETE FROM events WHERE persona_id = ?').run(String(personaId));
    db.prepare('DELETE FROM relations WHERE persona_id = ?').run(String(personaId));
    const loreIds = db.prepare('SELECT id FROM lore WHERE persona_id = ?').all(String(personaId));
    const delLoreFts = db.prepare('DELETE FROM lore_fts WHERE rowid = ?');
    for (const row of loreIds) delLoreFts.run(row.id);
    db.prepare('DELETE FROM lore WHERE persona_id = ?').run(String(personaId));
    db.prepare('DELETE FROM summaries WHERE persona_id = ?').run(String(personaId));
    return { ok: true };
  });
}

/* ── 关系 / 好感度 ───────────────────────────────────────────────────────── */

const AFFINITY_MIN = -10;
const AFFINITY_MAX = 10;

/** 从一句对话里抽实体（尽量保守：只认明确的“喜欢/讨厌/在做/叫我”）。 */
export function extractEntities(text) {
  const raw = String(text || '');
  const out = [];
  const push = (entity, delta, note) => {
    const name = clip(String(entity || '').trim(), 24);
    if (!name || name.length < 2) return;
    out.push({ entity: name, delta, note: clip(note || '', 80) });
  };
  const like = raw.match(/(?:我|人家)?(?:很|最|超|特别)?(?:喜欢|爱看|爱玩|爱吃|爱听)\s*([^\s，,。！!？?、]{2,12})/);
  if (like) push(like[1], 1, '从对话抽到：用户喜欢');
  const dislike = raw.match(/(?:我|人家)?(?:很|最|超|特别)?(?:不喜欢|讨厌|受不了|怕)\s*([^\s，,。！!？?、]{2,12})/);
  if (dislike) push(dislike[1], -1, '从对话抽到：用户不喜欢');
  const working = raw.match(/(?:我在|我正在|最近在|这段时间在)(?:做|写|弄|搞|学|玩)\s*([^\s，,。！!？?、]{2,16})/);
  if (working) push(working[1], 0.5, '从对话抽到：最近在做');
  const callMe = raw.match(/(?:叫我|称呼我|管我叫)\s*([^\s，,。！!？?、]{1,12})/);
  if (callMe) push(callMe[1], 0.5, '从对话抽到：称呼');
  return out;
}

/** 关系 upsert：affinity 累加并夹在 -10..10；entity 按人设隔离。 */
export function upsertRelation(personaId, entity, delta = 0, note = '') {
  const name = clip(String(entity || '').trim(), 24);
  if (!name) return { ok: false, error: 'bad-entity' };
  const now = Date.now();
  return withDb(personaId, (db) => {
    const current = db.prepare('SELECT affinity, notes FROM relations WHERE persona_id = ? AND entity = ?')
      .get(String(personaId), name);
    const next = Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, Math.round((Number(current && current.affinity) || 0) + Number(delta || 0))));
    const notes = clip(note || (current && current.notes) || '', 200);
    db.prepare(`INSERT INTO relations(persona_id, entity, affinity, notes, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(persona_id, entity) DO UPDATE SET affinity = excluded.affinity, notes = excluded.notes, updated_at = excluded.updated_at`)
      .run(String(personaId), name, next, notes, now);
    return { ok: true, entity: name, affinity: next, notes, updatedAt: now };
  });
}

/** 从一段对话里抽实体并写关系（路由在每轮聊天后调用）。 */
export function touchRelations(personaId, text) {
  const found = extractEntities(text);
  for (const item of found) upsertRelation(personaId, item.entity, item.delta, item.note);
  return found;
}

export function listRelations(personaId, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
  return withDb(personaId, (db) => db.prepare('SELECT * FROM relations WHERE persona_id = ? ORDER BY ABS(affinity) DESC, updated_at DESC LIMIT ?')
    .all(String(personaId), limit).map((row) => ({
      entity: row.entity,
      affinity: Number(row.affinity),
      notes: row.notes || '',
      updatedAt: Number(row.updated_at) || 0,
    })));
}

export function deleteRelation(personaId, entity) {
  return withDb(personaId, (db) => {
    const info = db.prepare('DELETE FROM relations WHERE persona_id = ? AND entity = ?').run(String(personaId), clip(entity, 24));
    return { ok: Number(info.changes) > 0 };
  });
}

/** 关系注入块（给 system prompt 用；没有人设数据返回空串）。 */
export function relationsPromptLine(personaId, limit = 8) {
  const rows = listRelations(personaId, { limit });
  if (!rows.length) return '';
  return '你记得和这些对象的关系（好感度 -10..10；只作背景，不要报数值）：\n'
    + rows.map((row) => `- ${row.entity}：${row.affinity > 0 ? '好感 +' : row.affinity < 0 ? '好感 ' : '中性 '}${row.affinity}`
      + (row.notes ? `（${row.notes}）` : '')).join('\n');
}

/* ── 世界书（lore）──────────────────────────────────────────────────────── */

const LORE_CHUNK_MIN = 500;
const LORE_CHUNK_MAX = 800;

/** 把长文切成 500–800 字的块（按段落/句号优先，硬切兜底）。 */
export function chunkLore(text, options = {}) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const max = Math.max(LORE_CHUNK_MIN, Math.min(1200, Number(options.maxChars) || LORE_CHUNK_MAX));
  const chunks = [];
  let buffer = '';
  const flush = () => {
    const value = buffer.trim();
    buffer = '';
    if (value) chunks.push(value);
  };
  for (const paragraph of raw.split(/\n{2,}/)) {
    const piece = paragraph.trim();
    if (!piece) continue;
    if ([...buffer].length + [...piece].length + 2 <= max) {
      buffer += (buffer ? '\n\n' : '') + piece;
      continue;
    }
    flush();
    if ([...piece].length <= max) { buffer = piece; continue; }
    // 长段落：按句号切，单句仍超长就硬切
    for (const sentence of piece.split(/(?<=[。！？!?；;])/)) {
      if (!sentence.trim()) continue;
      if ([...buffer].length + [...sentence].length <= max) buffer += sentence;
      else {
        flush();
        if ([...sentence].length <= max) buffer = sentence;
        else {
          let rest = sentence;
          while ([...rest].length > max) {
            chunks.push([...rest].slice(0, max).join(''));
            rest = [...rest].slice(max).join('');
          }
          buffer = rest;
        }
      }
    }
    flush();
  }
  flush();
  return chunks.filter((chunk) => [...chunk].length >= 30);
}

/**
 * 导入世界书（角色卡/文档正文）：分块入 lore + FTS。
 * @returns {{ok:true, chunks:number, ids:number[]}}
 */
export function addLore(personaId, input = {}) {
  const content = String(input.content || '').trim();
  if (!content) return { ok: false, error: 'empty-content', chunks: 0, ids: [] };
  const title = clip(input.title || '世界书', 120);
  const source = clip(input.source || '', 80);
  const chunks = chunkLore(content, { maxChars: input.maxChars });
  const now = Date.now();
  return withDb(personaId, (db) => {
    const ids = [];
    chunks.forEach((chunk, index) => {
      const info = db.prepare('INSERT INTO lore(persona_id, title, content, chunk_no, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(String(personaId), title, chunk, index, source, now);
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO lore_fts(rowid, text) VALUES (?, ?)').run(id, tokenizeForIndex(`${title} ${chunk}`).join(' '));
      ids.push(id);
    });
    return { ok: true, chunks: chunks.length, ids };
  });
}

/** 世界书检索：FTS top-3（注入用）或指定 limit。 */
export function searchLore(personaId, query, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 3));
  const match = ftsQueryFor(query);
  return withDb(personaId, (db) => {
    if (!match) {
      return db.prepare('SELECT * FROM lore WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(String(personaId), limit).map((row) => ({ id: Number(row.id), title: row.title, content: row.content, chunkNo: Number(row.chunk_no), source: row.source }));
    }
    let rows = [];
    try {
      rows = db.prepare(`SELECT l.*, bm25(lore_fts) AS rank FROM lore_fts JOIN lore l ON l.id = lore_fts.rowid
        WHERE lore_fts MATCH ? AND l.persona_id = ? ORDER BY rank LIMIT ?`).all(match, String(personaId), limit);
    } catch { rows = []; }
    return rows.map((row) => ({ id: Number(row.id), title: row.title, content: row.content, chunkNo: Number(row.chunk_no), source: row.source }));
  });
}

export function listLore(personaId, options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 100));
  return withDb(personaId, (db) => db.prepare('SELECT id, title, chunk_no, source, created_at, length(content) AS size FROM lore WHERE persona_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(String(personaId), limit).map((row) => ({
      id: Number(row.id), title: row.title, chunkNo: Number(row.chunk_no), source: row.source, createdAt: Number(row.created_at), size: Number(row.size),
    })));
}

export function deleteLore(personaId, loreId) {
  const id = Number(loreId);
  if (!Number.isFinite(id)) return { ok: false };
  return withDb(personaId, (db) => {
    const row = db.prepare('SELECT id FROM lore WHERE id = ? AND persona_id = ?').get(id, String(personaId));
    if (!row) return { ok: false };
    db.prepare('DELETE FROM lore_fts WHERE rowid = ?').run(id);
    db.prepare('DELETE FROM lore WHERE id = ?').run(id);
    return { ok: true };
  });
}

/** lore 注入块（FTS top-3）。 */
export function lorePromptLine(personaId, query, limit = 3) {
  const rows = searchLore(personaId, query, { limit });
  if (!rows.length) return '';
  return '【世界书命中】只作背景，不要整段复述：\n' + rows.map((row) => '- ' + clip(row.content, 400)).join('\n');
}

/* ── 摘要 ───────────────────────────────────────────────────────────────── */

export function saveSummary(personaId, period, text) {
  const key = clip(period || 'latest', 20);
  withDb(personaId, (db) => db.prepare(`INSERT INTO summaries(persona_id, period, text, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(persona_id, period) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`)
    .run(String(personaId), key, clip(text, 8000), Date.now()));
  return { ok: true, period: key };
}

export function readSummary(personaId) {
  return withDb(personaId, (db) => {
    const row = db.prepare("SELECT text, created_at FROM summaries WHERE persona_id = ? AND period = 'latest'").get(String(personaId));
    return row ? { text: row.text, updatedAt: Number(row.created_at) || 0 } : { text: '', updatedAt: 0 };
  });
}

/* ── 统计 / 迁移 / 导出 ─────────────────────────────────────────────────── */

export function stats(personaId) {
  return withDb(personaId, (db) => {
    const get = (sql, ...args) => Number(db.prepare(sql).get(...args).n) || 0;
    return {
      ok: true,
      personaId: String(personaId),
      events: get('SELECT COUNT(*) AS n FROM events WHERE persona_id = ?', String(personaId)),
      archived: get('SELECT COUNT(*) AS n FROM events WHERE persona_id = ? AND archived = 1', String(personaId)),
      pinned: get('SELECT COUNT(*) AS n FROM events WHERE persona_id = ? AND pinned = 1', String(personaId)),
      relations: get('SELECT COUNT(*) AS n FROM relations WHERE persona_id = ?', String(personaId)),
      lore: get('SELECT COUNT(*) AS n FROM lore WHERE persona_id = ?', String(personaId)),
      summaries: get('SELECT COUNT(*) AS n FROM summaries WHERE persona_id = ?', String(personaId)),
      path: memoryDbPath(personaId),
    };
  });
}

/** 导出（JSON 可读；事件/关系/世界书/摘要/元信息）。 */
export function exportMemory(personaId) {
  return withDb(personaId, (db) => {
    const events = db.prepare('SELECT * FROM events WHERE persona_id = ? ORDER BY created_at').all(String(personaId));
    const relations = db.prepare('SELECT * FROM relations WHERE persona_id = ? ORDER BY entity').all(String(personaId));
    const lore = db.prepare('SELECT id, title, content, chunk_no, source, created_at FROM lore WHERE persona_id = ? ORDER BY chunk_no').all(String(personaId));
    const summaries = db.prepare('SELECT * FROM summaries WHERE persona_id = ?').all(String(personaId));
    return {
      ok: true,
      version: 2,
      personaId: String(personaId),
      exportedAt: Date.now(),
      events: events.map(eventRowToItem),
      relations: relations.map((row) => ({ entity: row.entity, affinity: Number(row.affinity), notes: row.notes, updatedAt: Number(row.updated_at) })),
      lore: lore.map((row) => ({ id: Number(row.id), title: row.title, content: row.content, chunkNo: Number(row.chunk_no), source: row.source })),
      summaries: summaries.map((row) => ({ period: row.period, text: row.text, createdAt: Number(row.created_at) })),
      stats: stats(personaId),
    };
  });
}

/** meta 读写（迁移标记用）。 */
function readMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : '';
}
function writeMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/**
 * 从旧 JSONL 迁移（幂等：已迁移过就跳过；按 text+created_at 去重）。
 * 保留 JSONL 原文件不动（只读备份），迁移失败由调用方回退旧路径。
 * @returns {{ok:boolean, imported:number, skipped:number, reason?:string}}
 */
export function migrateFromJsonl(personaId, options = {}) {
  const dir = join(personaDir(personaId), 'memory');
  const jsonlPath = options.eventsPath || join(dir, 'events.jsonl');
  const summaryPath = options.summaryPath || join(dir, 'summary.json');
  if (!existsSync(jsonlPath) && !existsSync(summaryPath)) return { ok: true, imported: 0, skipped: 0, reason: 'no-jsonl' };
  return withDb(personaId, (db) => {
    const marker = readMeta(db, 'jsonl_migrated_at');
    if (marker) return { ok: true, imported: 0, skipped: 0, reason: 'already-migrated' };
    let imported = 0;
    let skipped = 0;
    let summaryImported = false;
    try {
      if (existsSync(jsonlPath) && statSync(jsonlPath).size > 0) {
        const text = readFileSync(jsonlPath, 'utf8');
        const known = db.prepare('SELECT id FROM events WHERE persona_id = ? AND text = ? AND created_at = ?');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          let raw;
          try { raw = JSON.parse(line); } catch { skipped += 1; continue; }
          const body = String((raw && raw.text) || '').trim();
          if (!body) { skipped += 1; continue; }
          const ts = Number(raw.ts) || Date.now();
          if (known.get(String(personaId), body, ts)) { skipped += 1; continue; }
          addEvent(personaId, {
            text: body,
            kind: raw.kind,
            importance: raw.importance,
            ts,
            pinned: raw.pinned === true,
            source: 'jsonl-migration',
            tags: Array.isArray(raw.refs) ? raw.refs : [],
          });
          imported += 1;
        }
      }
      if (existsSync(summaryPath)) {
        try {
          const doc = JSON.parse(readFileSync(summaryPath, 'utf8'));
          if (doc && typeof doc.text === 'string' && doc.text.trim()) {
            saveSummary(personaId, 'latest', doc.text);
            summaryImported = true;
          }
        } catch { skipped += 1; }
      }
      writeMeta(db, 'jsonl_migrated_at', String(Date.now()));
      writeMeta(db, 'jsonl_source', jsonlPath);
      return { ok: true, imported, skipped, summaryImported };
    } catch (error) {
      return { ok: false, imported, skipped, reason: String((error && error.message) || error) };
    }
  });
}

/** 迁移标记（诊断用；不触发迁移）。 */
export function migrationInfo(personaId) {
  return withDb(personaId, (db) => ({
    migratedAt: Number(readMeta(db, 'jsonl_migrated_at')) || 0,
    source: readMeta(db, 'jsonl_source') || '',
    path: memoryDbPath(personaId),
  }));
}
