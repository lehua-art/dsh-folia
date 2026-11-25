/**
 * persona-tool-log.js — 每个 persona 的工具调用审计（任务单 §2.3）。
 *
 * 文件：`<DSH_FOLIA_HOME>/personas/<id>/tool-log.jsonl`
 * 一行一条：{ ts, tool, args, permission, confirmed, result, verified, source }
 *
 * 纪律：
 *   · 只追加，不重写历史（清空是显式动作）；
 *   · 参数裁剪到 500 字，绝不写 Key/密码（调用方传入的 args 已经过工具白名单）；
 *   · 读失败不影响聊天 —— 审计是证据，不是主链路。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { personaDir } from './persona-store.js';

export const TOOL_LOG_MAX_BYTES = 2 * 1024 * 1024;

export function toolLogPath(personaId) {
  return join(personaDir(personaId), 'tool-log.jsonl');
}

const clip = (value, max = 500) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('');
};

function jsonSafe(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return clip(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

/** 追加一条审计。返回真实落盘的那条（调用方不必再读）。 */
export function appendToolLog(personaId, entry = {}) {
  const row = {
    ts: Number(entry.ts) || Date.now(),
    tool: clip(entry.tool, 80),
    args: jsonSafe(entry.args) || {},
    permission: clip(entry.permission, 16) || 'unknown',
    confirmed: entry.confirmed === true,
    result: entry.result === true || entry.result === 'ok' ? 'ok' : (entry.result === false ? 'failed' : clip(entry.result, 40) || 'unknown'),
    verified: entry.verified === true,
    source: clip(entry.source, 40) || 'chat',
    error: clip(entry.error, 300),
    // v5 §3：多步任务的可追溯字段（普通调用为空/0；旧日志读出来仍是 undefined，判据按"有没有"看）。
    planId: entry.planId ? clip(entry.planId, 60) : '',
    step: Number.isFinite(Number(entry.step)) ? Math.max(0, Math.round(Number(entry.step))) : 0,
  };
  try {
    const file = toolLogPath(personaId);
    mkdirSync(dirname(file), { recursive: true });
    let prefix = '';
    try { if (existsSync(file) && readFileSync(file, 'utf8').length > TOOL_LOG_MAX_BYTES) prefix = ''; } catch { /* ignore */ }
    if (prefix === '' && existsSync(file)) {
      // 超过上限：保留最近一半行（低频触发；不阻塞调用方）。
      try {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        if (lines.length > 2000) writeFileSync(file, lines.slice(-1000).join('\n') + '\n');
      } catch { /* ignore */ }
    }
    writeFileSync(file, JSON.stringify(row) + '\n', { flag: 'a' });
  } catch {
    // 审计失败不抛给聊天
  }
  return row;
}

/** 最近 N 条（新的在前）。 */
export function readToolLog(personaId, limit = 10) {
  const max = Math.max(1, Math.min(100, Number(limit) || 10));
  try {
    const file = toolLogPath(personaId);
    if (!existsSync(file)) return { ok: true, items: [], total: 0 };
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const items = [];
    for (let i = lines.length - 1; i >= 0 && items.length < max; i -= 1) {
      try {
        const doc = JSON.parse(lines[i]);
        if (doc && typeof doc === 'object') items.push(doc);
      } catch { /* 坏行跳过 */ }
    }
    return { ok: true, items, total: lines.length };
  } catch (error) {
    return { ok: false, items: [], total: 0, error: String((error && error.message) || error).slice(0, 160) };
  }
}

export function clearToolLog(personaId) {
  try {
    rmSync(toolLogPath(personaId), { force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 160) };
  }
}
