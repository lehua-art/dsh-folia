/**
 * persona-store.js — 多 Persona 的**存储层**（pre.65）。
 *
 * 布局（与设计文档 §3.2 一致，和旧的 pet-chat/config、memory.json 物理隔离）：
 *
 *   <DSH_FOLIA_HOME or ~/.dsh-folia>/personas/
 *     index.json                 [{ id, type, name, avatar, mode, active, updatedAt }]
 *     <id>/persona.json          core / growth / express / affect / model / card / story
 *     <id>/memory/events.jsonl   事件流（persona-memory.js）
 *     <id>/memory/summary.json   滚动摘要
 *     <id>/memory/bond.json      好感/信任/心情快照
 *     <id>/cards/                导入的原始角色卡
 *     <id>/vault.json            该人设的 Key（权限 600）
 *
 * 三条硬纪律：
 *   ① **绝不读旧数据**：旧 `pet-chat/memory.json` / `pet-chat/settings.json` 不在本模块
 *      的任何路径里；旧文件保留不删，人设系统从空开始。
 *   ② **Key 只进 vault**：persona.json 只存 `apiKeyRef`，GET 永远只回掩码。
 *   ③ **一人设一目录**：删除人设 = 删除自己的目录，不碰别人的记忆。
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync, renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const PERSONA_TYPES = Object.freeze(['assistant', 'character']);
export const PERSONA_MODES = Object.freeze(['chat', 'roleplay', 'story']);
export const DEFAULT_PERSONA_NAME = '';

const ID_RE = /^p_[A-Za-z0-9_-]{1,40}$/;

const DEFAULT_MODEL = Object.freeze({
  provider: 'inherit',
  baseUrl: '',
  model: '',
  apiKeyRef: 'inherit',
  temperature: 0.8,
  maxTokens: null,
});

const DEFAULT_CORE = Object.freeze({
  identity: '',
  values: [],
  boundaries: [],
  speechHabits: [],
  exampleDialogues: [],
  worldBook: [],
});

const DEFAULT_GROWTH = Object.freeze({
  traits: [],
  bond: { affection: 0.5, trust: 0.5 },
  insideJokes: [],
  styleNotes: [],
});

const DEFAULT_EXPRESS = Object.freeze({
  warmth: 0.6,
  playfulness: 0.3,
  directness: 0.6,
  preachiness: 0.5,
  lengthPolicy: 'adaptive',
  emoji: false,
  voice: { engine: 'inherit', name: '', rate: 0 },
});

const DEFAULT_AFFECT = Object.freeze({
  valence: 0,
  arousal: 0.3,
  energy: 0.6,
  mood: 'neutral',
});

const DEFAULT_CARD = Object.freeze({
  scenario: '',
  firstMes: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  tags: [],
  wakeKeyword: '',
  cover: '',
  recommendedVoice: '',
  source: 'user',
  sourceName: '',
  version: '1.0',
});

const DEFAULT_STORY = Object.freeze({
  chapter: '',
  scene: '',
  location: '',
  time: '',
  flags: {},
  choices: [],
});

const clip = (value, max) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};
const num = (value, fallback, lo, hi) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};
const bool = (value, fallback = false) => (typeof value === 'boolean' ? value : fallback);
const strList = (value, maxItems, maxChars) => (Array.isArray(value) ? value : [])
  .map((item) => clip(item, maxChars)).filter(Boolean).slice(0, maxItems);

function baseDir() {
  return process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
}

/** 人设根目录。**不是** pet-chat 目录 —— 旧数据不在这里。 */
export function personasRoot() {
  return join(baseDir(), 'personas');
}

export function personaDir(id) {
  const clean = String(id || '');
  if (!ID_RE.test(clean)) throw Object.assign(new Error('bad-persona-id'), { code: 'bad-id' });
  return join(personasRoot(), clean);
}

export function personaPath(id) {
  return join(personaDir(id), 'persona.json');
}

export function vaultPath(id) {
  return join(personaDir(id), 'vault.json');
}

export function newPersonaId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export function emptyPersona(patch = {}) {
  const type = PERSONA_TYPES.includes(patch.type) ? patch.type : 'assistant';
  const mode = PERSONA_MODES.includes(patch.mode) ? patch.mode : 'chat';
  const id = ID_RE.test(String(patch.id || '')) ? patch.id : newPersonaId();
  const now = Date.now();
  return {
    id,
    type,
    name: clip(patch.name, 80),
    avatar: clip(patch.avatar, 300),
    mode,
    active: patch.active === true,
    model: { ...DEFAULT_MODEL, ...(patch.model && typeof patch.model === 'object' ? patch.model : {}) },
    core: { ...DEFAULT_CORE, ...(patch.core && typeof patch.core === 'object' ? patch.core : {}) },
    growth: { ...DEFAULT_GROWTH, ...(patch.growth && typeof patch.growth === 'object' ? patch.growth : {}) },
    express: { ...DEFAULT_EXPRESS, ...(patch.express && typeof patch.express === 'object' ? patch.express : {}) },
    affect: { ...DEFAULT_AFFECT, ...(patch.affect && typeof patch.affect === 'object' ? patch.affect : {}) },
    card: { ...DEFAULT_CARD, ...(patch.card && typeof patch.card === 'object' ? patch.card : {}) },
    story: { ...DEFAULT_STORY, ...(patch.story && typeof patch.story === 'object' ? patch.story : {}) },
    createdAt: Number(patch.createdAt) || now,
    updatedAt: Number(patch.updatedAt) || now,
  };
}

/** 把任意输入收敛成合法 persona（不信任磁盘/请求体）。 */
export function sanitizePersona(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const persona = emptyPersona(src);
  const model = src.model && typeof src.model === 'object' ? src.model : {};
  persona.model = {
    provider: ['inherit', 'openai', 'ollama'].includes(String(model.provider || '')) ? String(model.provider) : 'inherit',
    baseUrl: clip(model.baseUrl, 300),
    model: clip(model.model, 120),
    apiKeyRef: String(model.apiKeyRef || 'inherit') === 'inherit' ? 'inherit' : ('vault:' + persona.id),
    temperature: num(model.temperature, 0.8, 0, 2),
    maxTokens: model.maxTokens == null ? null : Math.round(num(model.maxTokens, 0, 1, 32768)) || null,
  };
  const core = src.core && typeof src.core === 'object' ? src.core : {};
  persona.core = {
    identity: clip(core.identity, 8000),
    values: strList(core.values, 20, 200),
    boundaries: strList(core.boundaries, 20, 200),
    speechHabits: strList(core.speechHabits, 20, 200),
    exampleDialogues: strList(core.exampleDialogues, 30, 1200),
    worldBook: (Array.isArray(core.worldBook) ? core.worldBook : []).filter((item) => item && typeof item === 'object').map((item) => ({
      keys: strList(item.keys, 12, 40),
      content: clip(item.content, 4000),
      priority: Math.round(num(item.priority, 5, 0, 100)),
    })).slice(0, 200),
  };
  const growth = src.growth && typeof src.growth === 'object' ? src.growth : {};
  persona.growth = {
    traits: (Array.isArray(growth.traits) ? growth.traits : []).filter((item) => item && typeof item === 'object').map((item) => ({
      text: clip(item.text, 300),
      confidence: num(item.confidence, 0.6, 0, 1),
      source: clip(item.source, 80),
      at: Number(item.at) || Date.now(),
    })).filter((item) => item.text).slice(-300),
    bond: {
      affection: num(growth.bond && growth.bond.affection, 0.5, 0, 1),
      trust: num(growth.bond && growth.bond.trust, 0.5, 0, 1),
    },
    insideJokes: strList(growth.insideJokes, 100, 200),
    styleNotes: strList(growth.styleNotes, 100, 200),
  };
  const express = src.express && typeof src.express === 'object' ? src.express : {};
  const voice = express.voice && typeof express.voice === 'object' ? express.voice : {};
  persona.express = {
    warmth: num(express.warmth, 0.6, 0, 1),
    playfulness: num(express.playfulness, 0.3, 0, 1),
    directness: num(express.directness, 0.6, 0, 1),
    preachiness: num(express.preachiness, 0.5, 0, 1),
    lengthPolicy: ['adaptive', 'short', 'long'].includes(String(express.lengthPolicy)) ? String(express.lengthPolicy) : 'adaptive',
    emoji: bool(express.emoji, false),
    voice: {
      engine: ['inherit', 'edge', 'piper', 'sapi', 'openai', 'azure', 'elevenlabs'].includes(String(voice.engine || '')) ? String(voice.engine) : 'inherit',
      name: clip(voice.name, 160),
      rate: num(voice.rate, 0, -10, 10),
    },
  };
  const affect = src.affect && typeof src.affect === 'object' ? src.affect : {};
  persona.affect = {
    valence: num(affect.valence, 0, -1, 1),
    arousal: num(affect.arousal, 0.3, 0, 1),
    energy: num(affect.energy, 0.6, 0, 1),
    mood: ['neutral', 'happy', 'tired', 'sad', 'excited', 'calm'].includes(String(affect.mood)) ? String(affect.mood) : 'neutral',
  };
  const card = src.card && typeof src.card === 'object' ? src.card : {};
  persona.card = {
    scenario: clip(card.scenario, 4000),
    firstMes: clip(card.firstMes, 4000),
    systemPrompt: clip(card.systemPrompt, 8000),
    postHistoryInstructions: clip(card.postHistoryInstructions, 4000),
    tags: strList(card.tags, 50, 40),
    wakeKeyword: clip(card.wakeKeyword, 80),
    cover: clip(card.cover, 500),
    recommendedVoice: clip(card.recommendedVoice, 160),
    source: ['official', 'document', 'import', 'user'].includes(String(card.source)) ? String(card.source) : 'user',
    sourceName: clip(card.sourceName, 160),
    version: clip(card.version, 40) || '1.0',
  };
  const story = src.story && typeof src.story === 'object' ? src.story : {};
  persona.story = {
    chapter: clip(story.chapter, 200),
    scene: clip(story.scene, 1000),
    location: clip(story.location, 200),
    time: clip(story.time, 100),
    flags: story.flags && typeof story.flags === 'object' && !Array.isArray(story.flags) ? story.flags : {},
    choices: strList(story.choices, 10, 120),
  };
  return persona;
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    return doc && typeof doc === 'object' ? doc : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now();
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try { renameSync(tmp, path); } catch {
    writeFileSync(path, JSON.stringify(value, null, 2));
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  if (mode !== undefined) {
    try { chmodSync(path, mode); } catch { /* Windows 上无 POSIX 权限，忽略 */ }
  }
  return value;
}

export function indexEntry(persona) {
  return {
    id: persona.id,
    type: persona.type,
    name: persona.name,
    avatar: persona.avatar,
    mode: persona.mode,
    active: persona.active === true,
    updatedAt: persona.updatedAt || 0,
  };
}

export function readPersonaIndex() {
  const doc = readJson(join(personasRoot(), 'index.json'), { items: [] });
  const items = (Array.isArray(doc.items) ? doc.items : []).filter((item) => item && ID_RE.test(String(item.id || '')))
    .map((item) => ({
      id: item.id,
      type: PERSONA_TYPES.includes(item.type) ? item.type : 'assistant',
      name: clip(item.name, 80),
      avatar: clip(item.avatar, 300),
      mode: PERSONA_MODES.includes(item.mode) ? item.mode : 'chat',
      active: item.active === true,
      updatedAt: Number(item.updatedAt) || 0,
    }));
  if (items.length && !items.some((item) => item.active)) items[0].active = true;
  return { items };
}

export function writePersonaIndex(items) {
  const list = (Array.isArray(items) ? items : []).filter((item) => item && ID_RE.test(String(item.id || '')));
  if (list.length && !list.some((item) => item.active)) list[0].active = true;
  return writeJsonAtomic(join(personasRoot(), 'index.json'), { items: list.map((item) => ({
    id: item.id, type: item.type, name: item.name, avatar: item.avatar, mode: item.mode,
    active: item.active === true, updatedAt: Number(item.updatedAt) || 0,
  })) });
}

export function readPersona(id) {
  try {
    const doc = readJson(personaPath(id), null);
    if (!doc) return null;
    const persona = sanitizePersona({ ...doc, id });
    return persona;
  } catch {
    return null;
  }
}

export function writePersona(persona) {
  const safe = sanitizePersona({ ...persona, updatedAt: Date.now() });
  writeJsonAtomic(personaPath(safe.id), safe);
  return safe;
}

/** 首次访问时建一个空 assistant 人设（用户自己起名）。 */
export function ensurePersonaStore() {
  const root = personasRoot();
  mkdirSync(root, { recursive: true });
  let index = readPersonaIndex();
  if (!index.items.length) {
    const persona = emptyPersona({ type: 'assistant', mode: 'chat', name: DEFAULT_PERSONA_NAME, active: true });
    writePersona(persona);
    index = { items: [indexEntry(persona)] };
    writePersonaIndex(index.items);
  }
  // index 里的条目必须真的有 persona.json；坏条目清掉但至少保留一个。
  const live = index.items.filter((item) => readPersona(item.id));
  if (!live.length) {
    for (const item of index.items) {
      try { rmSync(personaDir(item.id), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const persona = emptyPersona({ type: 'assistant', mode: 'chat', active: true });
    writePersona(persona);
    writePersonaIndex([indexEntry(persona)]);
    return readPersonaIndex();
  }
  if (live.length !== index.items.length) writePersonaIndex(live);
  return readPersonaIndex();
}

export function listPersonas() {
  const index = ensurePersonaStore();
  return index.items.map((item) => {
    const persona = readPersona(item.id);
    return persona ? { ...indexEntry(persona), hasKey: hasPersonaKey(item.id) } : null;
  }).filter(Boolean);
}

export function getActivePersonaId() {
  const index = ensurePersonaStore();
  return (index.items.find((item) => item.active) || index.items[0] || {}).id || '';
}

export function getActivePersona() {
  const id = getActivePersonaId();
  return id ? readPersona(id) : null;
}

export function setActivePersona(id) {
  const target = readPersona(id);
  if (!target) return null;
  const index = readPersonaIndex();
  const items = index.items.map((item) => ({ ...item, active: item.id === id }));
  writePersonaIndex(items);
  return readPersona(id);
}

export function createPersona(input = {}) {
  ensurePersonaStore();
  const persona = emptyPersona({
    type: input.type,
    mode: input.mode,
    name: input.name,
    avatar: input.avatar,
  });
  const index = readPersonaIndex();
  persona.active = index.items.length === 0;
  writePersona(persona);
  index.items.push(indexEntry(persona));
  writePersonaIndex(index.items);
  return readPersona(persona.id);
}

export function updatePersona(id, patch = {}) {
  const current = readPersona(id);
  if (!current) return null;
  const merged = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    model: { ...current.model, ...(patch.model && typeof patch.model === 'object' ? patch.model : {}) },
    core: { ...current.core, ...(patch.core && typeof patch.core === 'object' ? patch.core : {}) },
    growth: { ...current.growth, ...(patch.growth && typeof patch.growth === 'object' ? patch.growth : {}) },
    express: {
      ...current.express,
      ...(patch.express && typeof patch.express === 'object' ? patch.express : {}),
      voice: { ...current.express.voice, ...(patch.express && patch.express.voice ? patch.express.voice : {}) },
    },
    affect: { ...current.affect, ...(patch.affect && typeof patch.affect === 'object' ? patch.affect : {}) },
    card: { ...current.card, ...(patch.card && typeof patch.card === 'object' ? patch.card : {}) },
    story: { ...current.story, ...(patch.story && typeof patch.story === 'object' ? patch.story : {}) },
  };
  const saved = writePersona(merged);
  if (patch.active === true) setActivePersona(saved.id);
  const index = readPersonaIndex();
  writePersonaIndex(index.items.map((item) => (item.id === saved.id ? indexEntry(readPersona(saved.id)) : item)));
  return readPersona(saved.id);
}

export function deletePersona(id) {
  const target = readPersona(id);
  if (!target) return { ok: false, error: 'not-found' };
  const index = readPersonaIndex();
  const rest = index.items.filter((item) => item.id !== id);
  try { rmSync(personaDir(id), { recursive: true, force: true }); } catch (error) {
    return { ok: false, error: 'delete-failed', detail: String((error && error.message) || error).slice(0, 160) };
  }
  if (!rest.length) {
    const persona = emptyPersona({ type: 'assistant', active: true });
    writePersona(persona);
    rest.push(indexEntry(persona));
  } else if (!rest.some((item) => item.active)) {
    rest[0].active = true;
  }
  writePersonaIndex(rest);
  return { ok: true, id, active: getActivePersonaId() };
}

/* ── Key vault（只写不读；对外只回掩码） ───────────────────────────────── */

export function readVault(id) {
  const doc = readJson(vaultPath(id), {});
  return { apiKey: typeof doc.apiKey === 'string' ? doc.apiKey : '', updatedAt: Number(doc.updatedAt) || 0 };
}

export function writePersonaKey(id, apiKey) {
  if (!readPersona(id)) return null;
  const key = String(apiKey || '');
  const vault = { apiKey: key, updatedAt: Date.now() };
  writeJsonAtomic(vaultPath(id), vault, 0o600);
  return maskKey(key);
}

export function hasPersonaKey(id) {
  try { return Boolean(readVault(id).apiKey); } catch { return false; }
}

export function maskKey(key) {
  const value = String(key || '');
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return value.slice(0, 4) + '••••' + value.slice(-4);
}

export function publicKeyInfo(id) {
  const vault = readVault(id);
  return { hasKey: Boolean(vault.apiKey), maskedKey: maskKey(vault.apiKey), updatedAt: vault.updatedAt };
}

/**
 * 解析该人设最终使用的模型配置。
 * `inherit` / 空字段逐项回落 global（旧设置里的全局默认只在这条路径被引用）。
 */
export function resolvePersonaModel(persona, globalConfig = {}) {
  const model = persona && persona.model ? persona.model : {};
  const provider = model.provider && model.provider !== 'inherit'
    ? model.provider : (globalConfig.provider || 'openai');
  const baseUrl = String(model.baseUrl || globalConfig.baseUrl || '').replace(/\/+$/, '');
  const modelName = model.model || globalConfig.model || 'deepseek-chat';
  const vault = readVault(persona.id);
  const usePersonaKey = model.apiKeyRef !== 'inherit';
  const apiKey = usePersonaKey ? vault.apiKey : globalConfig.apiKey;
  return {
    provider: provider === 'ollama' ? 'ollama' : 'openai',
    baseUrl,
    model: modelName,
    apiKey: String(apiKey || ''),
    temperature: Number(model.temperature) || 0.8,
    maxTokens: model.maxTokens == null ? null : Number(model.maxTokens),
  };
}
