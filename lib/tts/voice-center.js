/**
 * tts/voice-center.js — 全局音色中心（v2）的配置与凭据。
 *
 * 布局（与设计文档 §3 一致，和 pet-chat/settings.json 物理隔离）：
 *   <DSH_FOLIA_HOME>/voice/config.json   非敏感配置（preferred / cluster / resourceId / subtype…）
 *   <DSH_FOLIA_HOME>/voice/vault.json    火山 AppID + Access Token（0600，只写不读）
 *
 * 纪律：
 *   · Key 只进 vault；返回给浏览器的永远是 `hasCredentials` + 掩码；
 *   · 配置读失败一律回落默认值（音色中心坏了不能拖垮合成链）；
 *   · 人设的「继承 / 指定」解析只在这里（`resolvePersonaVoice`），路由不要再写第二份。
 */
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const VOLC_SUBTYPES = Object.freeze(['volc-tts', 'volc-seed-tts']);
export const VOLC_DEFAULT_VOICE = 'zh_female_shuangkuaisisi_uranus_bigtts';
export const VOLC_DEFAULT_CLUSTER = 'volcano_tts';
export const VOLC_DEFAULT_RESOURCE_ID = 'seed-tts-2.0';

/** 常用火山音色（用户也可以直接填自己的音色 ID；这里只是候选）。 */
export const VOLC_VOICE_SUGGESTIONS = Object.freeze([
  { id: 'zh_female_shuangkuaisisi_uranus_bigtts', label: '爽快思思 2.0', gender: 'Female', subtype: 'volc-seed-tts' },
  { id: 'zh_female_cancan_uranus_bigtts', label: '知性灿灿 2.0', gender: 'Female', subtype: 'volc-seed-tts' },
  { id: 'zh_female_tianmeixiaoyuan_uranus_bigtts', label: '甜美小源 2.0', gender: 'Female', subtype: 'volc-seed-tts' },
  { id: 'zh_male_m191_uranus_bigtts', label: '舟 2.0', gender: 'Male', subtype: 'volc-seed-tts' },
  { id: 'zh_male_taocheng_uranus_bigtts', label: '小天 2.0', gender: 'Male', subtype: 'volc-seed-tts' },
  { id: 'en_female_dacey_uranus_bigtts', label: 'Dacey（多语种）', gender: 'Female', subtype: 'volc-seed-tts' },
  { id: 'en_male_tim_uranus_bigtts', label: 'Tim（多语种）', gender: 'Male', subtype: 'volc-seed-tts' },
  { id: 'zh_female_wanwanxiaohe_moon_bigtts', label: '湾湾小何（传统 TTS）', gender: 'Female', subtype: 'volc-tts' },
  { id: 'zh_female_shuangkuaisisi_moon_bigtts', label: '爽快思思（传统 TTS）', gender: 'Female', subtype: 'volc-tts' },
]);

/** 「如何获取」六步（任务单 F：注册/开通/AppID/Token/资源ID/计费）。 */
export const VOLC_HOW_TO = Object.freeze([
  {
    step: 1, title: '注册并实名火山引擎账号',
    body: '打开 console.volcengine.com 注册；按提示完成实名认证。未实名的账号不能开通语音合成。',
    link: 'https://console.volcengine.com/',
  },
  {
    step: 2, title: '开通「语音合成」或「大模型语音」服务',
    body: '在控制台搜索「语音合成」/「豆包语音」，进入产品页点「立即开通」。中文自然度优先选大模型语音（Seed-TTS）。',
    link: 'https://console.volcengine.com/speech/service/8',
  },
  {
    step: 3, title: '创建应用，拿 AppID 与 Access Token',
    body: '语音技术控制台 →「应用管理」→ 创建应用；应用详情页可看到 AppID，Token 在「Access Token」处复制（只显示一次，丢了就重置）。',
    link: 'https://console.volcengine.com/speech/app',
  },
  {
    step: 4, title: '确认 Cluster / Resource ID',
    body: '传统 TTS 一般填 Cluster=volcano_tts；大模型 Seed-TTS 填 Resource ID=seed-tts-2.0（克隆音色用 seed-icl-2.0）。不同产品线字段不同，填错会 403。',
  },
  {
    step: 5, title: '回来粘贴 → 点「测试」',
    body: '把 AppID / Access Token / Cluster（或 Resource ID）/ 音色 ID 填进来，点「测试」；听到测试句就表示已启用，人设选「继承全局」即可使用。',
  },
  {
    step: 6, title: '计费说明（按量，先充值/领额度）',
    body: '火山语音按合成字符数计费，新用户通常有免费额度；额度用完会返回 429/额度不足。请先在控制台充值或领取试用额度。',
    link: 'https://console.volcengine.com/finance/',
  },
]);

function baseDir() {
  return process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
}

export function voiceCenterDir() {
  return join(baseDir(), 'voice');
}

export function voiceCenterConfigPath() {
  return join(voiceCenterDir(), 'config.json');
}

export function voiceCenterVaultPath() {
  return join(voiceCenterDir(), 'vault.json');
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' ? doc : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value, mode) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try { renameSync(tmp, file); } catch {
    writeFileSync(file, JSON.stringify(value, null, 2));
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
  if (mode !== undefined) {
    try { chmodSync(file, mode); } catch { /* Windows 无 POSIX 权限，忽略 */ }
  }
  return value;
}

const DEFAULT_CONFIG = Object.freeze({
  version: 2,
  preferred: '',
  packDefault: 'piper-zh-huayan',
  volcengine: {
    cluster: VOLC_DEFAULT_CLUSTER,
    resourceId: VOLC_DEFAULT_RESOURCE_ID,
    subtype: 'volc-seed-tts',
    voiceId: VOLC_DEFAULT_VOICE,
    lastOk: false,
    lastError: '',
    checkedAt: 0,
  },
});

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const volc = src.volcengine && typeof src.volcengine === 'object' ? src.volcengine : {};
  return {
    version: 2,
    preferred: normalizeVoiceId(String(src.preferred || '')).slice(0, 160),
    packDefault: String(src.packDefault || DEFAULT_CONFIG.packDefault).slice(0, 80),
    volcengine: {
      cluster: String(volc.cluster || VOLC_DEFAULT_CLUSTER).slice(0, 80),
      resourceId: String(volc.resourceId || VOLC_DEFAULT_RESOURCE_ID).slice(0, 80),
      subtype: VOLC_SUBTYPES.includes(String(volc.subtype)) ? String(volc.subtype) : 'volc-seed-tts',
      voiceId: String(volc.voiceId || VOLC_DEFAULT_VOICE).slice(0, 160),
      lastOk: volc.lastOk === true,
      lastError: String(volc.lastError || '').slice(0, 500),
      checkedAt: Number(volc.checkedAt) || 0,
      // 任务 §2④：测试通过后要能显示「实际使用的子类型 / 资源 ID」。
      lastSubtype: VOLC_SUBTYPES.includes(String(volc.lastSubtype)) ? String(volc.lastSubtype) : '',
      lastResourceId: String(volc.lastResourceId || '').slice(0, 80),
      lastVoiceId: String(volc.lastVoiceId || '').slice(0, 160),
      lastStatus: Number(volc.lastStatus) || 0,
      lastUrl: String(volc.lastUrl || '').slice(0, 300),
    },
  };
}

export function readVoiceCenter() {
  return normalizeConfig(readJson(voiceCenterConfigPath(), DEFAULT_CONFIG));
}

function writeVoiceCenter(next) {
  return writeJsonAtomic(voiceCenterConfigPath(), normalizeConfig(next));
}

function readVault() {
  const doc = readJson(voiceCenterVaultPath(), {});
  const volc = doc && doc.volcengine && typeof doc.volcengine === 'object' ? doc.volcengine : {};
  return {
    volcengine: {
      appId: String(volc.appId || ''),
      accessToken: String(volc.accessToken || ''),
      updatedAt: Number(volc.updatedAt) || 0,
    },
  };
}

function writeVault(vault) {
  return writeJsonAtomic(voiceCenterVaultPath(), vault, 0o600);
}

export function maskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return text.slice(0, 4) + '••••' + text.slice(-4);
}

/** 宿主内部使用：带 Key 的火山配置（绝不直接回给浏览器）。 */
export function volcHostConfig() {
  const cfg = readVoiceCenter().volcengine;
  const vault = readVault().volcengine;
  return {
    ...cfg,
    appId: vault.appId,
    accessToken: vault.accessToken,
    hasCredentials: Boolean(vault.appId && vault.accessToken),
  };
}

/** 浏览器可见：只回掩码与状态。 */
export function publicVoiceCenter() {
  const cfg = readVoiceCenter();
  const vault = readVault().volcengine;
  return {
    preferred: cfg.preferred,
    packDefault: cfg.packDefault,
    volcengine: {
      id: 'volcengine',
      name: '火山引擎（Volcengine）',
      configured: Boolean(vault.appId && vault.accessToken),
      hasAppId: Boolean(vault.appId),
      maskedAppId: maskSecret(vault.appId),
      maskedToken: maskSecret(vault.accessToken),
      cluster: cfg.volcengine.cluster,
      resourceId: cfg.volcengine.resourceId,
      subtype: cfg.volcengine.subtype,
      voiceId: cfg.volcengine.voiceId,
      lastOk: cfg.volcengine.lastOk,
      lastError: cfg.volcengine.lastError,
      checkedAt: cfg.volcengine.checkedAt,
      // 已验证 = 最后一次真实测试通过；配置一改就退回「已配置」。
      verified: cfg.volcengine.lastOk === true,
      verifiedAt: cfg.volcengine.lastOk ? cfg.volcengine.checkedAt : 0,
      status: !(vault.appId && vault.accessToken) ? 'unconfigured' : (cfg.volcengine.lastOk ? 'verified' : 'configured'),
      verifiedSubtype: cfg.volcengine.lastSubtype,
      verifiedResourceId: cfg.volcengine.lastResourceId,
      verifiedVoiceId: cfg.volcengine.lastVoiceId,
      verifiedStatus: cfg.volcengine.lastStatus,
      verifiedUrl: cfg.volcengine.lastUrl,
      voices: VOLC_VOICE_SUGGESTIONS.map((voice) => ({ ...voice })),
    },
    howTo: VOLC_HOW_TO.map((step) => ({ ...step })),
  };
}

/** 保存火山配置：AppID/Token 进 vault，其余进 config。 */
export function saveVolcConfig(patch = {}) {
  const current = readVoiceCenter();
  const next = { ...current, volcengine: { ...current.volcengine } };
  const vault = readVault();
  const nextVault = { ...vault, volcengine: { ...vault.volcengine } };
  let secretChanged = false;
  if (typeof patch.appId === 'string' && patch.appId.trim()) {
    nextVault.volcengine.appId = patch.appId.trim().slice(0, 200);
    secretChanged = true;
  }
  if (typeof patch.accessToken === 'string' && patch.accessToken.trim()) {
    nextVault.volcengine.accessToken = patch.accessToken.trim().slice(0, 4096);
    secretChanged = true;
  }
  if (patch.clearCredentials === true) {
    nextVault.volcengine.appId = '';
    nextVault.volcengine.accessToken = '';
    secretChanged = true;
  }
  if (secretChanged) nextVault.volcengine.updatedAt = Date.now();
  if (typeof patch.cluster === 'string') next.volcengine.cluster = patch.cluster.trim().slice(0, 80) || VOLC_DEFAULT_CLUSTER;
  if (typeof patch.resourceId === 'string') next.volcengine.resourceId = patch.resourceId.trim().slice(0, 80) || VOLC_DEFAULT_RESOURCE_ID;
  if (typeof patch.subtype === 'string' && VOLC_SUBTYPES.includes(patch.subtype)) next.volcengine.subtype = patch.subtype;
  if (typeof patch.voiceId === 'string') next.volcengine.voiceId = patch.voiceId.trim().replace(/^volc:/i, '').slice(0, 160) || VOLC_DEFAULT_VOICE;
  // 配置一变，上一次“测试通过”就不再可信。
  if (secretChanged || typeof patch.cluster === 'string' || typeof patch.resourceId === 'string'
    || typeof patch.subtype === 'string' || typeof patch.voiceId === 'string') {
    next.volcengine.lastOk = false;
    next.volcengine.lastError = '';
    next.volcengine.checkedAt = 0;
  }
  writeVoiceCenter(next);
  writeVault(nextVault);
  return publicVoiceCenter().volcengine;
}

export function markVolcTest(ok, error, info = {}) {
  const current = readVoiceCenter();
  const details = info && typeof info === 'object' ? info : {};
  writeVoiceCenter({
    ...current,
    volcengine: {
      ...current.volcengine,
      lastOk: ok === true,
      lastError: ok ? '' : String(error || '').slice(0, 500),
      checkedAt: Date.now(),
      lastSubtype: ok === true && VOLC_SUBTYPES.includes(String(details.subtype)) ? String(details.subtype) : '',
      lastResourceId: ok === true ? String(details.resourceId || '').slice(0, 80) : '',
      lastVoiceId: ok === true ? String(details.voiceId || '').slice(0, 160) : '',
      lastStatus: ok === true ? Number(details.status) || 0 : 0,
      lastUrl: ok === true ? String(details.url || '').slice(0, 300) : '',
    },
  });
}

export function setPreferredVoice(voiceId) {
  const current = readVoiceCenter();
  const next = normalizeVoiceId(String(voiceId || '')).trim().slice(0, 160);
  writeVoiceCenter({ ...current, preferred: next });
  return next;
}

export function setDefaultPack(packId) {
  const current = readVoiceCenter();
  writeVoiceCenter({ ...current, packDefault: String(packId || '').slice(0, 80) });
}

/** 音色 id 统一 engine:id；旧数据（裸 Edge 名 / SAPI 名）补齐前缀。 */

/** 旧数据兼容：Edge「短标签」（Xiaoxiao / YunJhe…）→ 完整 id。 */
const EDGE_LABEL_TO_ID = Object.freeze({
  xiaoxiao: 'zh-CN-XiaoxiaoNeural',
  xiaoyi: 'zh-CN-XiaoyiNeural',
  yunjian: 'zh-CN-YunjianNeural',
  yunxi: 'zh-CN-YunxiNeural',
  yunxia: 'zh-CN-YunxiaNeural',
  yunyang: 'zh-CN-YunyangNeural',
  hiugaai: 'zh-HK-HiuGaaiNeural',
  hiumaan: 'zh-HK-HiuMaanNeural',
  wanlung: 'zh-HK-WanLungNeural',
  xiaobei: 'zh-CN-liaoning-XiaobeiNeural',
  hsiaochen: 'zh-TW-HsiaoChenNeural',
  yunjhe: 'zh-TW-YunJheNeural',
  hsiaoyu: 'zh-TW-HsiaoYuNeural',
  xiaoni: 'zh-CN-shaanxi-XiaoniNeural',
});

export function normalizeVoiceId(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (/^[a-z0-9-]+:/i.test(text)) return text;
  if (/^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/.test(text)) return 'edge:' + text;
  if (/^Microsoft\s.+\sDesktop$/i.test(text)) return 'sapi:' + text;
  // 旧版把 Edge 标签（如 "YunJhe"）当默认值存下来：归一到完整 id。
  const bare = text.replace(/[（(].*?[)）]/g, '').trim().toLowerCase();
  if (EDGE_LABEL_TO_ID[bare]) return 'edge:' + EDGE_LABEL_TO_ID[bare];
  return 'piper:' + text;
}

export function voiceEngineOf(id) {
  const match = /^([a-z0-9-]+):/i.exec(String(id || ''));
  return match ? match[1].toLowerCase() : '';
}

/**
 * 人设最终使用的音色。
 *   · mode='fixed'：用该人设的 id（没有 id 时用旧 name 推断）；rate 用人设的；
 *   · mode='inherit'（含旧数据空值）：用全局 preferred；rate 用全局语速。
 * 音色不可用时**不在这里回落** —— 合成策略（worker）会按引擎链自动回落并回传原因。
 */
export function resolvePersonaVoice(persona, global = {}) {
  const express = persona && persona.express && typeof persona.express === 'object' ? persona.express : {};
  const voice = express.voice && typeof express.voice === 'object' ? express.voice : {};
  const legacyName = String(voice.name || '').trim();
  const legacyEngine = String(voice.engine || 'inherit');
  const explicitMode = voice.mode === 'fixed' || voice.mode === 'inherit' ? voice.mode : '';
  const mode = explicitMode || (legacyName && legacyEngine !== 'inherit' ? 'fixed' : 'inherit');
  const fixedId = normalizeVoiceId(String(voice.id || legacyName || ''));
  const globalId = normalizeVoiceId(String(global.preferred || global.name || ''));
  const id = mode === 'fixed' ? fixedId : globalId;
  const rateRaw = mode === 'fixed' ? voice.rate : global.rate;
  const rate = Number.isFinite(Number(rateRaw)) ? Math.max(-10, Math.min(10, Math.round(Number(rateRaw)))) : 0;
  return {
    mode: mode === 'fixed' ? 'fixed' : 'inherit',
    id: id || '',
    rate,
    source: mode === 'fixed' ? 'persona' : 'global',
    fixedId,
    globalId,
  };
}
