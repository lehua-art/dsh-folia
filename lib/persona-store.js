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
  // v2：mode='inherit'（默认）| 'fixed'；id 统一 engine:id；name/engine 是旧数据兼容字段。
  voice: { engine: 'inherit', name: '', rate: 0, mode: 'inherit', id: '' },
});

/**
 * 工具组 × 三档权限（任务单 §2.2；v3 §6 扩了媒体/应用/剪贴板/写文件）。
 * `default` 是新建助手时的建议值；`tools` 是落在这个组里的工具名（与 pet-chat-brain 的工具表对账）。
 * `system` 只在高级权限打开时出现/可用。
 */
export const PERMISSION_GROUPS = Object.freeze([
  {
    id: 'wallpaper', label: '壁纸与轮播', risk: 'low', riskLabel: '低风险', default: 'allow',
    desc: '换壁纸、切换轮播。只改外观，不动文件。',
    tools: ['wallpaper_switch', 'wallpaper_cycle'],
  },
  {
    id: 'pet', label: '桌宠与音量', risk: 'low', riskLabel: '低风险', default: 'allow',
    desc: '显示/隐藏桌宠、调大小与音量（桌宠音量或壁纸音轨）。随时可改回。',
    tools: ['pet_toggle', 'pet_scale', 'pet_volume', 'volume_set', 'status_query'],
  },
  {
    id: 'voice', label: '朗读与音色', risk: 'low', riskLabel: '低风险', default: 'allow',
    desc: '开关朗读、改音色与语速。',
    tools: ['tts_toggle'],
  },
  {
    id: 'reminder', label: '提醒与日程', risk: 'low', riskLabel: '低风险', default: 'allow',
    desc: '创建/查看/清除本机提醒。',
    tools: ['reminder_create', 'reminder_list', 'reminder_clear'],
  },
  {
    id: 'media', label: '媒体控制', risk: 'medium', riskLabel: '中风险', default: 'ask',
    desc: '播放/暂停/切歌（走系统媒体桥），会影响你正在听的东西。',
    tools: ['media_control'],
  },
  {
    id: 'docs', label: '工作区文档', risk: 'medium', riskLabel: '中风险', default: 'ask',
    desc: '读工作区文本；写文件会先备份并二次确认。',
    tools: ['doc_read', 'doc_write'],
  },
  {
    id: 'search', label: '联网搜索', risk: 'medium', riskLabel: '中风险', default: 'ask',
    desc: '把关键词发到网络搜索；内容会离开本机。',
    tools: ['search_query'],
  },
  {
    id: 'apps', label: '应用与网页', risk: 'medium', riskLabel: '中风险', default: 'ask',
    desc: '按白名单打开应用/网页，或发一条桌面通知。',
    tools: ['open_url', 'app_launch', 'notify'],
  },
  {
    id: 'clipboard', label: '剪贴板', risk: 'medium', riskLabel: '中风险', default: 'ask',
    desc: '读/写系统剪贴板；内容可能包含隐私，默认每次询问。',
    tools: ['clipboard_get', 'clipboard_set'],
  },
  {
    id: 'system', label: '系统操作', risk: 'high', riskLabel: '高风险', default: 'ask', advancedOnly: true,
    desc: '卸载皮肤、清空记忆等不可撤销操作；即使允许也要二次确认。',
    tools: ['skin_uninstall', 'memory_clear'],
  },
]);

export const PERMISSION_LEVELS = Object.freeze(['allow', 'ask', 'deny']);

/**
 * 权限预设（任务 §6①）：一键把整组工具切成「标准 / 宽松」；用户逐个改过之后
 * 自动变成「自定义」（`sanitizePermissions` 里比对得出，不信任客户端传的标签）。
 *
 *   标准：壁纸/桌宠/朗读/提醒 allow；媒体/文档/搜索/应用/剪贴板 ask；系统 ask（需高级开关）
 *   宽松：媒体/搜索/文档/应用 allow；剪贴板与写文件仍 ask；系统 ask（仍二次确认）
 * 写文件（doc_write）与系统级动作**任何预设都不给 allow** —— 它们永远需要确认。
 */
export const PERMISSION_PRESETS = Object.freeze([
  {
    id: 'standard', label: '标准', desc: '日常够用：壁纸/桌宠/朗读/提醒直接做，媒体/文档/搜索先问，系统动作需高级权限并二次确认。',
    levels: Object.freeze({
      wallpaper: 'allow', pet: 'allow', voice: 'allow', reminder: 'allow',
      media: 'ask', docs: 'ask', search: 'ask', apps: 'ask', clipboard: 'ask', system: 'ask',
    }),
  },
  {
    id: 'relaxed', label: '宽松', desc: '让它真能办事：媒体/搜索/文档/应用直接做；剪贴板、写文件、系统动作仍要确认。',
    levels: Object.freeze({
      wallpaper: 'allow', pet: 'allow', voice: 'allow', reminder: 'allow',
      media: 'allow', docs: 'allow', search: 'allow', apps: 'allow', clipboard: 'ask', system: 'ask',
    }),
  },
  {
    id: 'custom', label: '自定义', desc: '你自己逐个调过：每个工具组单独设允许/询问/禁止。',
    levels: Object.freeze({}),
  },
]);

export const PERMISSION_PRESET_IDS = Object.freeze(PERMISSION_PRESETS.map((preset) => preset.id));

/** 按「标准/宽松」生成整份权限（custom 不套层级，保留当前值只改标记）。 */
export function applyPermissionPreset(raw, presetId, type = 'assistant') {
  const base = sanitizePermissions(raw, type);
  // 特殊人设没有系统工具：任何预设都只是「自定义的全 deny」，绝不因为套预设放开。
  if (type === 'character') return { ...defaultPermissions('character'), preset: 'custom', presetAt: Date.now() };
  const preset = PERMISSION_PRESETS.find((item) => item.id === String(presetId));
  if (!preset) {
    return { ...base, preset: 'custom', presetAt: Date.now() };
  }
  if (preset.id === 'custom') return { ...base, preset: 'custom', presetAt: Date.now() };
  const next = { ...base, consentMemory: { ...(base.consentMemory || {}) } };
  for (const group of PERMISSION_GROUPS) {
    const level = preset.levels[group.id];
    if (PERMISSION_LEVELS.includes(String(level))) next[group.id] = String(level);
  }
  // 系统组仍需高级开关；这里不动 advanced（用户显式开/关）。
  next.preset = preset.id;
  next.presetAt = Date.now();
  return next;
}

/** 当前权限对应的预设名（用户改过任何一组 ⇒ custom）。 */
export function permissionPresetOf(permissions) {
  const src = permissions && typeof permissions === 'object' ? permissions : {};
  const claimed = PERMISSION_PRESET_IDS.includes(String(src.preset)) ? String(src.preset) : '';
  if (claimed !== 'standard' && claimed !== 'relaxed') return 'custom';
  const preset = PERMISSION_PRESETS.find((item) => item.id === claimed);
  if (!preset) return 'custom';
  for (const group of PERMISSION_GROUPS) {
    const want = preset.levels[group.id];
    if (!PERMISSION_LEVELS.includes(String(want))) continue;
    if (String(src[group.id]) !== String(want)) return 'custom';
  }
  return claimed;
}

const TOOL_GROUP = new Map();
for (const group of PERMISSION_GROUPS) for (const tool of group.tools) TOOL_GROUP.set(tool, group.id);

/** 工具 → 权限组（未知工具返回空串）。 */
export function toolGroup(tool) {
  return TOOL_GROUP.get(String(tool || '')) || '';
}

/** 默认权限：特殊人设一律 deny（代码层强制，不读存储里的值）。 */
export function defaultPermissions(type = 'assistant') {
  const out = { advanced: false, consentMemory: {}, preset: 'standard', presetAt: 0 };
  for (const group of PERMISSION_GROUPS) {
    out[group.id] = type === 'character' ? 'deny' : group.default;
  }
  return out;
}

/** 把任意输入收敛成合法权限；character 永远全 deny。 */
export function sanitizePermissions(raw, type = 'assistant') {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = defaultPermissions(type === 'character' ? 'character' : 'assistant');
  if (type === 'character') return out;
  for (const group of PERMISSION_GROUPS) {
    if (PERMISSION_LEVELS.includes(String(src[group.id]))) out[group.id] = String(src[group.id]);
  }
  out.advanced = src.advanced === true;
  const consentSrc = src.consentMemory && typeof src.consentMemory === 'object' && !Array.isArray(src.consentMemory)
    ? src.consentMemory : {};
  out.consentMemory = {};
  for (const group of PERMISSION_GROUPS) {
    const value = consentSrc[group.id];
    if (value === 'allow' || value === 'deny') out.consentMemory[group.id] = value;
  }
  // 预设标签与「逐组值是否仍然吻合」都由同一处算：客户端传什么标签都不作数。
  const presetAt = Number(src.presetAt) || 0;
  out.presetAt = presetAt;
  out.preset = permissionPresetOf({ ...out, preset: String(src.preset || '') });
  return out;
}

/** 该人设对某工具组的权限（system 组在高级权限关闭时一律 deny）。 */
export function permissionForGroup(persona, groupId) {
  if (!persona || persona.type === 'character') return 'deny';
  const permissions = persona.permissions && typeof persona.permissions === 'object'
    ? persona.permissions : defaultPermissions(persona.type);
  const group = PERMISSION_GROUPS.find((item) => item.id === groupId);
  if (!group) return 'deny';
  if (group.advancedOnly && permissions.advanced !== true) return 'deny';
  const level = permissions[groupId];
  return PERMISSION_LEVELS.includes(String(level)) ? String(level) : group.default;
}

/** 该人设对某工具的权限与归属（路由/工具层唯一入口）。 */
export function toolPolicy(persona, tool) {
  const group = toolGroup(tool);
  if (!group) return { allowed: false, permission: 'deny', group: '', tool: String(tool || ''), reason: 'unknown-tool' };
  if (!persona || persona.type === 'character') {
    return { allowed: false, permission: 'deny', group, tool: String(tool || ''), reason: 'character-no-tools' };
  }
  const permission = permissionForGroup(persona, group);
  return {
    allowed: permission !== 'deny',
    permission,
    group,
    tool: String(tool || ''),
    reason: permission === 'deny' ? 'denied' : '',
    needsAdvanced: Boolean((PERMISSION_GROUPS.find((item) => item.id === group) || {}).advancedOnly),
  };
}

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
    permissions: sanitizePermissions(patch.permissions, type),
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
      engine: ['inherit', 'edge', 'piper', 'sapi', 'openai', 'azure', 'elevenlabs', 'volc'].includes(String(voice.engine || '')) ? String(voice.engine) : 'inherit',
      name: clip(voice.name, 160),
      rate: num(voice.rate, 0, -10, 10),
      // v2：mode/id 是权威字段；旧数据没有 mode 时按 name/engine 推断（有音色名 = 指定）。
      mode: ['inherit', 'fixed'].includes(String(voice.mode))
        ? String(voice.mode)
        : (String(voice.name || '').trim() ? 'fixed' : 'inherit'),
      id: clip(voice.id, 160),
    },
  };
  persona.permissions = sanitizePermissions(src.permissions, persona.type);
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
    permissions: {
      ...current.permissions,
      ...(patch.permissions && typeof patch.permissions === 'object' ? patch.permissions : {}),
      consentMemory: {
        ...(current.permissions && current.permissions.consentMemory ? current.permissions.consentMemory : {}),
        ...(patch.permissions && patch.permissions.consentMemory && typeof patch.permissions.consentMemory === 'object'
          ? patch.permissions.consentMemory : {}),
      },
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
