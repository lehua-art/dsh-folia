/**
 * persona-growth.js — 人设成长：反思 → **自动采纳** → 可查看/删除/按日期回滚。
 *
 * 与设计文档 §4 / 已确认决策 ② 对齐：
 *   · 每 N 轮（默认 5）让模型做一次反思，只回 JSON，单次最多 3 条；
 *   · confidence 默认 0.6，相似度去重（同一主题不重复长）；
 *   · 写入 persona.json 的 growth.traits（不再有待审阅队列）；
 *   · 注入 prompt 时只用 confidence ≥ 0.5 的条目；
 *   · 回滚 = 删除 `at > 指定日期 23:59:59` 的 traits（保留 core 与记忆）。
 */
import { readPersona, sanitizePersona, writePersona } from './persona-store.js';

const MAX_NEW_TRAITS = 3;
const MIN_PROMPT_CONFIDENCE = 0.5;
export const REFLECT_EVERY_TURNS = 5;

const clip = (value, max) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

function normalizeTheme(text) {
  return String(text || '').toLowerCase().replace(/[\s，,。.!！?？、；;:："'“”‘’]/g, '');
}

function bigrams(text) {
  const raw = normalizeTheme(text);
  const out = [];
  for (let i = 0; i < raw.length - 1; i += 1) out.push(raw.slice(i, i + 2));
  return out;
}

/** 0–1 相似度：完全同文=1，否则按双字 Jaccard。 */
export function traitSimilarity(a, b) {
  const left = normalizeTheme(a);
  const right = normalizeTheme(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.85;
  const A = new Set(bigrams(left));
  const B = new Set(bigrams(right));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const token of A) if (B.has(token)) hit += 1;
  return hit / (A.size + B.size - hit);
}

export function promptTraits(persona) {
  const traits = persona && persona.growth && Array.isArray(persona.growth.traits) ? persona.growth.traits : [];
  return traits.filter((trait) => trait && trait.text && Number(trait.confidence) >= MIN_PROMPT_CONFIDENCE)
    .slice(-20);
}

/** 注入 prompt 的成长块（≤800 字；没有则空串）。 */
export function growthPromptLine(persona) {
  const traits = promptTraits(persona);
  if (!traits.length) return '';
  return '你逐渐养成的特点（只作行为倾向，不要逐条念）：\n'
    + traits.map((trait) => '- ' + clip(trait.text, 160)).join('\n');
}

/**
 * 采纳一批反思结果。返回实际新增的 traits（去重后最多 3 条）。
 * @param {string} personaId
 * @param {{traits?:Array, insideJokes?:Array, styleNotes?:Array}} reflection
 * @param {string} [source]
 */
export function adoptGrowth(personaId, reflection, source = 'reflection') {
  const persona = readPersona(personaId);
  if (!persona) return { ok: false, error: 'not-found', added: [] };
  const incoming = Array.isArray(reflection && reflection.traits) ? reflection.traits : [];
  const existing = persona.growth.traits || [];
  const added = [];
  const now = Date.now();
  for (const raw of incoming) {
    if (added.length >= MAX_NEW_TRAITS) break;
    const text = clip(raw && (raw.text || raw.trait), 300).trim();
    if (!text) continue;
    const confidence = Math.max(0, Math.min(1, Number(raw && raw.confidence) || 0.6));
    // 与已有 + 本批已加入的比较；阈值 0.72 足够挡住“喜欢短句/喜欢简短”这类近义重复。
    if ([...existing, ...added].some((trait) => traitSimilarity(trait.text, text) >= 0.72)) continue;
    added.push({
      text,
      confidence,
      source: clip((raw && raw.source) || source, 80),
      at: now,
    });
  }
  const jokes = Array.isArray(reflection && reflection.insideJokes)
    ? reflection.insideJokes.map((item) => clip(item, 200)).filter(Boolean) : [];
  const styles = Array.isArray(reflection && reflection.styleNotes)
    ? reflection.styleNotes.map((item) => clip(item, 200)).filter(Boolean) : [];
  const next = sanitizePersona({
    ...persona,
    growth: {
      ...persona.growth,
      traits: [...existing, ...added].slice(-300),
      insideJokes: [...new Set([...(persona.growth.insideJokes || []), ...jokes])].slice(-100),
      styleNotes: [...new Set([...(persona.growth.styleNotes || []), ...styles])].slice(-100),
    },
  });
  writePersona(next);
  return { ok: true, added, total: next.growth.traits.length };
}

/** 删除一条成长（按 text 或数组下标；界面用 text 更稳）。 */
export function deleteTrait(personaId, { text = '', index = -1 } = {}) {
  const persona = readPersona(personaId);
  if (!persona) return { ok: false, error: 'not-found' };
  const traits = persona.growth.traits || [];
  const next = traits.filter((trait, i) => (text ? trait.text !== text : i !== Number(index)));
  if (next.length === traits.length) return { ok: false, error: 'not-found' };
  writePersona(sanitizePersona({ ...persona, growth: { ...persona.growth, traits: next } }));
  return { ok: true, remaining: next.length };
}

/** 按日期回滚：只保留 `at <= date 23:59:59` 的成长项。 */
export function rollbackGrowth(personaId, date) {
  const persona = readPersona(personaId);
  if (!persona) return { ok: false, error: 'not-found' };
  const raw = String(date || '').trim();
  const end = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(raw + 'T23:59:59.999').getTime()
    : Date.parse(raw);
  if (!Number.isFinite(end)) return { ok: false, error: 'bad-date' };
  const before = persona.growth.traits || [];
  const kept = before.filter((trait) => Number(trait.at) <= end);
  writePersona(sanitizePersona({ ...persona, growth: { ...persona.growth, traits: kept } }));
  return { ok: true, removed: before.length - kept.length, remaining: kept.length, before: end };
}

/** 反思请求（系统提示 + 最近对话）；模型只回一行 JSON。 */
export function buildReflectionPrompt(persona, turns) {
  const name = persona.name || (persona.type === 'character' ? '角色' : '助手');
  const core = persona.core || {};
  const history = (Array.isArray(turns) ? turns : []).slice(-10)
    .map((turn) => `${turn.role === 'user' ? '用户' : name}：${clip(turn.content, 500)}`).join('\n');
  return {
    system: '[persona-reflection] 你是人设成长观察器，只输出一行 JSON，不要解释、不要 Markdown。\n'
      + '格式：{"traits":[{"text":"...","confidence":0.6}],"insideJokes":[],"styleNotes":[]}。\n'
      + '从最近对话里提炼 1–3 条**可长期保留**的偏好/性格/互动习惯；没有就 traits 空数组。\n'
      + '不要复述原话，不要编造；每条 text ≤40 字。',
    user: `人设：${name}\n核心身份：${clip(core.identity, 1200) || '（未填写）'}\n`
      + `已有成长：${(persona.growth.traits || []).slice(-10).map((t) => t.text).join('；') || '（无）'}\n`
      + `最近对话：\n${history || '（无）'}`,
  };
}

/** 从模型文本里抽 JSON；失败返回 null（反思不阻塞聊天）。 */
export function parseReflection(text) {
  const raw = String(text == null ? '' : text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const doc = JSON.parse(raw.slice(start, end + 1));
    return doc && typeof doc === 'object' ? doc : null;
  } catch {
    return null;
  }
}

/**
 * 执行一次反思。`callModel({system,user})` 由路由注入（复用该 persona 的模型/Key）。
 * 失败一律返回 `{ok:false}`，不把聊天弄挂。
 */
export async function reflectGrowth(personaId, turns, deps = {}) {
  const persona = readPersona(personaId);
  if (!persona) return { ok: false, error: 'not-found', added: [] };
  if (typeof deps.callModel !== 'function') return { ok: false, error: 'no-model', added: [] };
  const prompt = buildReflectionPrompt(persona, turns);
  let text = '';
  try {
    text = String(await deps.callModel(prompt) || '');
  } catch {
    return { ok: false, error: 'model-failed', added: [] };
  }
  const reflection = parseReflection(text);
  if (!reflection) return { ok: false, error: 'bad-json', added: [] };
  const result = adoptGrowth(personaId, reflection, deps.source || 'reflection');
  return { ...result, reflection };
}
