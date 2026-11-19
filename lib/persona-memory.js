/**
 * persona-memory.js — 每个人设的**事件流记忆**（pre.65）。
 *
 * 与旧 `pet-chat-memory.js` 的关系：没有关系。旧模块只服务旧版 `memory.json`，
 * 本模块只读写 `<persona>/memory/`；旧文件不读不引用不删（已确认决策 ④）。
 *
 * 事件：{ id, ts, kind: 'chat'|'action'|'preference'|'event', text, importance, refs[] }
 *   · 不设条数/时间上限；
 *   · 单文件超过 4MB 时滚到 `archive/events-<ts>.jsonl`，读取时按时间合并；
 *   · 删除单条事件会把所有分片重写到当前 live 文件（事件量小，简单优先）。
 *
 * 召回：score = 0.5*BM25 + 0.3*新近(14 天半衰期) + 0.2*重要度，top-8，再按 800 token 预算截断。
 */
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { personaDir } from './persona-store.js';

export const MEMORY_BUDGET = Object.freeze({
  topK: 8,
  tokenBudget: 800,
  recencyHalfLifeDays: 14,
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
    kind: ['chat', 'action', 'preference', 'event'].includes(String(raw.kind)) ? String(raw.kind) : 'event',
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

/** 追加一条事件；返回落盘后的形状。 */
export function appendEvent(personaId, raw) {
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
export function readAllEvents(personaId) {
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

export function eventCount(personaId) {
  return readAllEvents(personaId).length;
}

/** 分页 + 搜索（界面时间线用；新→旧）。 */
export function listEvents(personaId, { offset = 0, limit = 50, q = '' } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const all = readAllEvents(personaId)
    .filter((event) => !query || event.text.toLowerCase().includes(query))
    .sort((a, b) => b.ts - a.ts);
  const start = Math.max(0, Number(offset) || 0);
  const take = Math.min(200, Math.max(1, Number(limit) || 50));
  return { total: all.length, offset: start, limit: take, items: all.slice(start, start + take) };
}

/** 删除单条事件：合并所有分片后重写 live，删除归档。 */
export function deleteEvent(personaId, eventIdToDelete) {
  const all = readAllEvents(personaId);
  const kept = all.filter((event) => event.id !== eventIdToDelete);
  if (kept.length === all.length) return { ok: false, error: 'not-found' };
  const dir = archiveDir(personaId);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(memoryDir(personaId), { recursive: true });
  writeFileSync(eventsPath(personaId), kept.map((event) => JSON.stringify(event)).join('\n') + (kept.length ? '\n' : ''));
  return { ok: true, id: eventIdToDelete, remaining: kept.length };
}

export function clearEvents(personaId) {
  try { rmSync(memoryDir(personaId), { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ── 摘要 / 好感快照（写入与读取都按 persona 隔离） ───────────────────── */

export function readSummary(personaId) {
  try {
    const doc = JSON.parse(readFileSync(summaryPath(personaId), 'utf8'));
    return { text: clip(doc.text, 8000), updatedAt: Number(doc.updatedAt) || 0 };
  } catch {
    return { text: '', updatedAt: 0 };
  }
}

export function writeSummary(personaId, text) {
  mkdirSync(memoryDir(personaId), { recursive: true });
  const doc = { text: clip(text, 8000), updatedAt: Date.now() };
  writeFileSync(summaryPath(personaId), JSON.stringify(doc, null, 2));
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

/* ── 检索：BM25 + 新近 + 重要度 ────────────────────────────────────────── */

/** 极简 tokenizer：中文按双字，英文按词；小写、去掉常见标点。 */
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

/**
 * 召回 top-k 事件，按 token 预算截断。
 * 没有找到任何相关事件时仍按“新近 + 重要度”兜底，不返回空（人格需要连续性）。
 */
export function retrieveEvents(personaId, query, options = {}) {
  const now = options.now || Date.now();
  const topK = Math.max(1, Math.min(20, Number(options.topK) || MEMORY_BUDGET.topK));
  const budget = Math.max(80, Number(options.tokenBudget) || MEMORY_BUDGET.tokenBudget);
  const all = readAllEvents(personaId);
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

/** 注入 system 的召回块（没有事件返回空串）。 */
export function memoryRecallLine(items) {
  const list = Array.isArray(items) ? items.filter((item) => item && item.text).slice(0, MEMORY_BUDGET.topK) : [];
  if (!list.length) return '';
  const lines = list.map((item) => '- ' + clip(item.text, 160));
  return '你记得这些相关的事（只作背景，不要逐条复述）：\n' + lines.join('\n');
}
