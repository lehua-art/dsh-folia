/**
 * routes/personas.js — 人设系统 API（挂在 `/pet-chat/personas/*`，由 pet-chat 前缀路由委托）。
 *
 * 为什么委托而不是再注册一条 prefix：宿主的 `/pet-chat` 已经是前缀路由，后注册的
 * `/pet-chat/personas` 能否命中取决于宿主的匹配顺序；把子路径交给同一个 handler 是确定的。
 * 本文件仍然独立：它只依赖 `readSettings` / `log` / 存储模块，不 import pet-chat 路由。
 *
 * 安全：
 *   · Key 只写 vault，响应只回掩码；
 *   · DELETE 默认 409，必须 `{confirm:true}` 或 `?confirm=1`；
 *   · 任何错误都不把请求体/Key 写日志。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listPersonas, readPersona, createPersona, updatePersona, deletePersona, setActivePersona,
  getActivePersonaId, personaDir, publicKeyInfo, writePersonaKey, resolvePersonaModel,
  hasPersonaKey, maskKey, PERMISSION_GROUPS, PERMISSION_LEVELS, defaultPermissions,
} from '../persona-store.js';
import { personaPermissionsView } from '../pet-chat-brain.js';
import { readToolLog, clearToolLog } from '../persona-tool-log.js';
import { resolvePersonaVoice, publicVoiceCenter, VOLC_VOICE_SUGGESTIONS } from '../tts/voice-center.js';
import { VOICE_PACKS } from '../tts/packs.js';
import { cardToPersonaPatch, parseCardJson, readCardFromPng, personaToCard, buildCardPng, normalizeCard } from '../persona-card.js';
import {
  listEvents, deleteEvent, eventCount, readSummary, appendEvent,
  memoryStats, memoryBackend, memoryMigrationInfo, memoryStoragePath,
  deleteEventsByDate, rollbackEvents, decayTick, listObservations, clearObservations,
} from '../persona-memory.js';
import {
  listRelations, upsertRelation, deleteRelation, addLore, listLore, searchLore, deleteLore,
  exportMemory,
} from '../memory-db.js';
import { rollbackGrowth, deleteTrait } from '../persona-growth.js';
import { listLibraryCards, useLibraryCard } from '../persona-library.js';
import {
  extractDocumentText, chunkDocument, selectCardChunks, heuristicCardFromText, mergeDraftCard,
} from '../persona-doc.js';

const MAX_JSON_BYTES = 8 * 1024 * 1024;

function readBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(Object.assign(new Error('too-large'), { code: 'bad-request' })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function errorOf(res, code, hint, status = 400) {
  sendJson(res, { ok: false, code, hint }, status);
}

/**
 * @param {{readSettings?:Function, log?:Function}} deps
 * @returns {(req:any,res:any,sub:string,url:URL)=>Promise<boolean>} 命中返回 true
 */
export function createPersonaApi(deps = {}) {
  const readSettings = typeof deps.readSettings === 'function' ? deps.readSettings : () => ({});
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  function globalConfig() {
    try {
      const settings = readSettings() || {};
      const petChat = settings.petChat && typeof settings.petChat === 'object' ? settings.petChat : {};
      const provider = petChat.provider === 'ollama' ? 'ollama' : 'openai';
      return {
        provider,
        baseUrl: String(petChat.baseUrl || (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.deepseek.com')).replace(/\/+$/, ''),
        model: String(petChat.model || (provider === 'ollama' ? 'qwen2.5:7b' : 'deepseek-chat')),
        apiKey: String(petChat.apiKey || ''),
      };
    } catch {
      return { provider: 'openai', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' };
    }
  }

  function globalStatus() {
    const global = globalConfig();
    return {
      provider: global.provider,
      baseUrl: global.baseUrl,
      model: global.model,
      hasKey: Boolean(global.apiKey),
      maskedKey: maskKey(global.apiKey),
    };
  }

  /** 音色 id → 可读标签（内置包 / 火山候选 / 裸 id）。 */
  function voiceLabelOf(voiceId) {
    const id = String(voiceId || '');
    if (!id) return '';
    const piper = id.replace(/^piper:/i, '');
    const pack = VOICE_PACKS.find((item) => item.modelId === piper);
    if (pack) return pack.name;
    const volc = id.replace(/^volc:/i, '');
    const hit = VOLC_VOICE_SUGGESTIONS.find((voice) => voice.id === volc);
    if (hit) return hit.label;
    return id.replace(/^[a-z0-9-]+:/i, '');
  }

  /** 全局音色中心（当前首选 + 人设“继承全局”的解析结果）。 */
  function globalVoiceStatus() {
    const center = publicVoiceCenter();
    let globalRate = 0;
    try {
      const settings = readSettings() || {};
      const voice = settings.petChat && settings.petChat.voice ? settings.petChat.voice : {};
      globalRate = Number.isFinite(Number(voice.rate)) ? Math.max(-10, Math.min(10, Math.round(Number(voice.rate)))) : 0;
    } catch { /* 读设置失败按 0 处理 */ }
    return {
      preferred: center.preferred,
      preferredLabel: voiceLabelOf(center.preferred),
      rate: globalRate,
      volcengine: center.volcengine,
    };
  }

  function voiceStatusOf(persona) {
    const global = globalVoiceStatus();
    const resolved = resolvePersonaVoice(persona, {
      preferred: global.preferred,
      rate: global.rate,
    });
    return {
      mode: resolved.mode,
      id: resolved.id,
      rate: resolved.rate,
      source: resolved.source,
      label: voiceLabelOf(resolved.id) || (resolved.mode === 'inherit' ? '继承全局（全局未设置）' : resolved.id),
      global,
    };
  }

  /** 列表/详情都带 Key 归属：继承全局 / 独立 / 未配置。 */
  function keyStatus(persona, global = globalStatus()) {
    const inherit = !persona || !persona.model || persona.model.apiKeyRef === 'inherit';
    if (inherit) {
      return {
        mode: 'inherit', label: global.hasKey ? '继承全局' : '继承全局（未配置）',
        configured: Boolean(global.hasKey), source: global.hasKey ? 'global' : 'none',
      };
    }
    const has = hasPersonaKey(persona.id);
    return {
      mode: 'persona', label: has ? '独立 Key' : '独立 Key（待填）',
      configured: has, source: has ? 'persona' : 'none',
    };
  }

  function nextAssistantName() {
    const items = listPersonas().filter((item) => item.type === 'assistant');
    return `助手 ${items.length + 1}`;
  }

  async function callJson(config, system, user, maxTokens = 1200) {
    if (!config || !config.baseUrl || !config.model) return '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const headers = { 'content-type': 'application/json' };
    if (config.provider === 'openai' && config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    const url = config.provider === 'ollama' ? `${config.baseUrl}/api/chat` : `${config.baseUrl}/chat/completions`;
    try {
      const response = await fetch(url, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({
          model: config.model, stream: false, temperature: 0.2,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: maxTokens,
        }),
      });
      if (!response.ok) return '';
      const doc = await response.json();
      const content = config.provider === 'ollama'
        ? (doc && doc.message && doc.message.content)
        : (doc && doc.choices && doc.choices[0] && doc.choices[0].message && doc.choices[0].message.content);
      return typeof content === 'string' ? content : '';
    } catch { return ''; } finally { clearTimeout(timer); }
  }

  function parseModelCard(text) {
    const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
    if (!raw) return null;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const doc = JSON.parse(raw.slice(start, end + 1));
      return doc && typeof doc === 'object' ? doc : null;
    } catch { return null; }
  }

  /** 归一卡 → CCv2（预览页始终吃 spec/data 形状，和导入的 JSON 卡一致）。 */
  function normalizedToCcv2(card) {
    return {
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name: card.name, description: card.description, personality: card.personality,
        scenario: card.scenario, first_mes: card.firstMes, mes_example: card.mesExample,
        system_prompt: card.systemPrompt, post_history_instructions: card.postHistoryInstructions,
        character_book: { name: `${card.name || 'persona'} 世界书`, entries: (card.characterBook || []).map((entry, index) => ({
          keys: entry.keys || [], content: entry.content || '', enabled: true,
          insertion_order: Number(entry.priority) || 5, id: index,
        })) },
        tags: card.tags || [],
        extensions: { folia: {
          cover: card.cover || '', recommendedVoice: card.recommendedVoice || '',
          wakeKeyword: card.wakeKeyword || '', source: card.source || 'import',
          sourceName: card.sourceName || '', version: card.version || '1.0',
          speechHabits: card.speechHabits || [],
        } },
      },
    };
  }

  /** 文档 → 草稿卡：优先模型，失败/未配置回落确定性启发式。 */
  async function cardizeDocument({ text, fileName, chunks }) {
    const selected = selectCardChunks(chunks, 4);
    const fallback = heuristicCardFromText(text, fileName);
    const global = globalConfig();
    const configured = Boolean(global.apiKey || global.provider === 'ollama');
    let usedModel = false;
    const warnings = [];
    if (configured && selected.length) {
      const system = [
        '你是角色卡编辑。把用户给的设定文档整理成 SillyTavern Character Card V2 JSON。',
        '只输出一个 JSON 对象，字段：name, description, personality, scenario, first_mes, mes_example, system_prompt, post_history_instructions, character_book {entries:[{keys:[],content}]}, tags:[]。',
        '规则：description/personality 只保留角色稳定设定；first_mes 必须来自文档里的“启动口令/开场白/示例对话”，不要自己另写；',
        'character_book 只放世界观/设定/关系，3–6 条，每条 content 不超过 800 字；不要复述整篇文档。',
        '不要输出 Markdown 代码围栏或解释。',
      ].join('\n');
      const user = selected.map((chunk, index) => `【文档块 ${index + 1}】\n${chunk}`).join('\n\n');
      const answer = await callJson(global, system, user, 1800);
      const parsed = parseModelCard(answer);
      if (parsed) {
        usedModel = true;
        return { card: mergeDraftCard(parsed, fallback), usedModel, warnings, chunks: selected.length };
      }
      warnings.push('模型没有返回合法卡片 JSON，已用本地启发式生成');
    } else {
      warnings.push(configured ? '文档为空，已用启发式' : '未配置全局模型，已用本地启发式卡片化');
    }
    return { card: fallback, usedModel, warnings, chunks: selected.length };
  }

  async function withBody(req, handler) {
    let body = {};
    try {
      const raw = await readBody(req);
      if (raw.length) body = JSON.parse(raw.toString('utf8'));
    } catch { body = {}; }
    return handler(body);
  }

  async function testKey(persona, body = {}) {
    const resolved = resolvePersonaModel(persona, globalConfig());
    const provider = body.provider === 'ollama' || body.provider === 'openai' ? body.provider : resolved.provider;
    const baseUrl = String(body.baseUrl || resolved.baseUrl || '').replace(/\/+$/, '');
    const model = String(body.model || resolved.model || '');
    const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : resolved.apiKey;
    if (!baseUrl) return { ok: false, code: 'no-base-url', message: '接口地址为空' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const url = provider === 'ollama' ? `${baseUrl}/api/tags` : `${baseUrl}/models`;
      const response = await fetch(url, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) return { ok: false, code: 'unauthorized', status: response.status, message: 'Key 无效或没有权限（401）' };
      if (response.status === 402) return { ok: false, code: 'no-balance', status: 402, message: '账号余额不足（402）' };
      if (!response.ok) return { ok: false, code: 'http', status: response.status, message: `服务返回 ${response.status}` };
      return { ok: true, provider, baseUrl, model, keySource: apiKey && hasPersonaKey(persona.id) ? 'persona' : 'inherit' };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = String((error && error.message) || error);
      return {
        ok: false,
        code: aborted ? 'timeout' : (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message) ? 'dns' : 'network'),
        message: aborted ? '连接超时（8 秒）' : (/ENOTFOUND|EAI_AGAIN/.test(message) ? '地址解析失败，检查接口地址' : `网络错误：${message.slice(0, 80)}`),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function importCard(persona, req, url) {
    let body = {};
    let png = null;
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    try {
      if (contentType.includes('image/png')) {
        png = await readBody(req);
      } else {
        const raw = await readBody(req);
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      }
    } catch {
      return { ok: false, code: 'bad-request', hint: '请求体不是合法 JSON / PNG' };
    }
    let card = null;
    let sourceKind = 'json';
    if (png || body.png || body.base64 || body.data) {
      sourceKind = 'png';
      let bytes = png;
      if (!bytes && typeof (body.png || body.base64 || body.data) === 'string') {
        try { bytes = Buffer.from(String(body.png || body.base64 || body.data).replace(/^data:image\/png;base64,/, ''), 'base64'); } catch { bytes = null; }
      }
      if (bytes && bytes.length) card = readCardFromPng(bytes);
      if (!card) return { ok: false, code: 'bad-card', hint: 'PNG 里没有可读的 chara/ccv3 角色卡' };
    } else {
      card = parseCardJson(body.json || body.card || body);
      if (!card) return { ok: false, code: 'bad-card', hint: '不是合法的 CCv2 角色卡 JSON' };
    }
    const patch = cardToPersonaPatch(card, persona);
    const saved = updatePersona(persona.id, patch);
    try {
      const dir = join(personaDir(persona.id), 'cards');
      mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      if (sourceKind === 'png' && (png || body.png || body.base64 || body.data)) {
        const bytes = png || Buffer.from(String(body.png || body.base64 || body.data).replace(/^data:image\/png;base64,/, ''), 'base64');
        writeFileSync(join(dir, `card-${stamp}.png`), bytes);
      } else {
        writeFileSync(join(dir, `card-${stamp}.json`), JSON.stringify(body.json || body.card || card, null, 2));
      }
    } catch { /* 原始卡备份失败不影响导入结果 */ }
    return { ok: true, persona: saved, card: { name: card.name, tags: card.tags, worldBook: card.characterBook.length } };
  }

  /**
   * 子路径处理器。`sub` 是 `/personas` 之后的部分（'' 或 '/p_x/...'）。
   */
  return async function handlePersonaRequest(req, res, sub, url) {
    const path = String(sub || '').replace(/\/+$/, '');
    const method = String(req.method || 'GET').toUpperCase();
    try {
      if (path === '' || path === '/') {
        if (method === 'GET') {
          const personas = listPersonas();
          const global = globalStatus();
          sendJson(res, { ok: true, activeId: getActivePersonaId(), global, personas: personas.map((item) => {
            const p = readPersona(item.id);
            const key = publicKeyInfo(item.id);
            return {
              ...item,
              key,
              keyStatus: keyStatus(p, global),
              voice: voiceStatusOf(p),
              permissions: p ? p.permissions : defaultPermissions('assistant'),
              memoryCount: eventCount(item.id),
              growthCount: p ? p.growth.traits.length : 0,
              tags: p ? p.card.tags.slice(0, 8) : [],
              cover: p ? p.card.cover : '',
              source: p ? p.card.source : 'user',
            };
          }) });
          return true;
        }
        if (method === 'POST') {
          const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
          const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : '';
          const persona = createPersona({
            type: body.type === 'character' ? 'character' : 'assistant',
            mode: ['chat', 'roleplay', 'story'].includes(body.mode) ? body.mode : (body.type === 'character' ? 'roleplay' : 'chat'),
            name: name || (body.type === 'character' ? '特殊人设' : nextAssistantName()),
            avatar: typeof body.avatar === 'string' ? body.avatar : '',
          });
          sendJson(res, { ok: true, persona }, 201);
          return true;
        }
        return false;
      }

      // 卡片库 / 助手向导 / 文档卡片化：必须在 `/:id` 之前匹配，否则会被当成 persona id。
      if (path === '/global' && method === 'GET') {
        sendJson(res, { ok: true, ...globalStatus() });
        return true;
      }
      if (path === '/library' && method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const category = url.searchParams.get('category') || 'all';
        const cards = listLibraryCards({ q, category });
        sendJson(res, { ok: true, cards, categories: [
          { id: 'all', label: '全部' }, { id: 'roleplay', label: '角色扮演' }, { id: 'story', label: '互动故事' },
        ] });
        return true;
      }
      const libraryUse = path.match(/^\/library\/([^/]+)\/use$/);
      if (libraryUse && method === 'POST') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const result = useLibraryCard(decodeURIComponent(libraryUse[1]), body);
        if (result.ok) result.keyStatus = keyStatus(result.persona);
        sendJson(res, result, result.ok ? 200 : 404);
        return true;
      }
      if (path === '/from-draft' && method === 'POST') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const card = normalizeCard(body.card || body.draft || {});
        if (!card.name) { errorOf(res, 'bad-card', '卡片缺少名字', 400); return true; }
        const created = createPersona({
          type: 'character', mode: ['roleplay', 'story'].includes(body.mode) ? body.mode : 'roleplay',
          name: card.name, avatar: card.cover ? '' : (body.avatar || ''),
        });
        const patch = cardToPersonaPatch(card, {});
        const saved = updatePersona(created.id, {
          ...patch,
          mode: ['roleplay', 'story'].includes(body.mode) ? body.mode : 'roleplay',
          core: {
            ...patch.core,
            speechHabits: card.speechHabits || [],
            worldBook: card.characterBook || [],
            exampleDialogues: card.mesExample ? String(card.mesExample).split(/\n{2,}/).filter(Boolean) : [],
          },
          card: {
            ...patch.card,
            cover: card.cover || '',
            recommendedVoice: card.recommendedVoice || '',
            source: 'document', sourceName: String(body.fileName || card.sourceName || '').slice(0, 160),
            version: card.version || '1.0',
            wakeKeyword: card.wakeKeyword || '',
          },
          express: card.recommendedVoice
            ? { voice: { engine: 'inherit', name: card.recommendedVoice, rate: 0 } }
            : undefined,
          model: { provider: 'inherit', baseUrl: '', model: '', apiKeyRef: 'inherit' },
          active: body.active !== false,
        });
        const active = saved && body.active !== false ? setActivePersona(saved.id) : saved;
        try {
          const dir = join(personaDir(created.id), 'cards');
          mkdirSync(dir, { recursive: true });
          if (typeof body.rawText === 'string' && body.rawText) {
            writeFileSync(join(dir, `document-${Date.now()}.txt`), body.rawText);
          }
          writeFileSync(join(dir, `document-${Date.now()}.json`), JSON.stringify(card, null, 2));
        } catch { /* 原文留档失败不影响保存 */ }
        if (active) {
          try { appendEvent(active.id, { kind: 'event', importance: 6, text: `从文档导入人设：${String(body.fileName || card.name).slice(0, 120)}` }); } catch { /* ignore */ }
          // v1.2：世界书 RAG —— 文档正文分块进 lore（500–800 字/块），按检索注入而非整本塞 prompt。
          try {
            const raw = typeof body.rawText === 'string' ? body.rawText : '';
            if (raw.trim().length >= 120) {
              addLore(active.id, { title: String(body.fileName || card.name || '文档').slice(0, 120), content: raw, source: 'document-import' });
            }
          } catch { /* lore 失败不影响导入 */ }
        }
        sendJson(res, {
          ok: true, persona: active, opening: card.firstMes || '',
          keyStatus: active ? keyStatus(active) : null,
        }, 201);
        return true;
      }
      if (path === '/wizard' && method === 'POST') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : nextAssistantName();
        const nickname = typeof body.nickname === 'string' ? body.nickname.trim().slice(0, 40) : '';
        const relation = typeof body.relation === 'string' ? body.relation.trim().slice(0, 80) : '';
        const tone = ['温柔', '活泼', '冷静', '毒舌'].includes(String(body.tone)) ? String(body.tone) : '温柔';
        const toneMap = {
          温柔: { warmth: 0.82, playfulness: 0.25, directness: 0.42, preachiness: 0.3, habits: ['语气温柔，先回应情绪再给建议'] },
          活泼: { warmth: 0.72, playfulness: 0.78, directness: 0.6, preachiness: 0.3, habits: ['短句、有活力，偶尔用一点玩笑'] },
          冷静: { warmth: 0.45, playfulness: 0.2, directness: 0.82, preachiness: 0.35, habits: ['先给结论，再给理由，少用感叹句'] },
          毒舌: { warmth: 0.4, playfulness: 0.5, directness: 0.9, preachiness: 0.2, habits: ['说话直接但不伤人，吐槽完会给实际帮助'] },
        };
        const style = toneMap[tone];
        const created = createPersona({ type: 'assistant', mode: 'chat', name, avatar: body.avatar || '✨' });
        const identity = [
          `你是「${name}」，用户的助手${relation ? `，与用户的关系是：${relation}` : ''}。`,
          nickname ? `称呼用户为「${nickname}」。` : '',
          '你记得你们之间发生过的事，会随相处慢慢形成自己的说话方式。',
        ].filter(Boolean).join('\n');
        const opening = typeof body.firstMes === 'string' && body.firstMes.trim()
          ? body.firstMes.trim().slice(0, 1000)
          : `我在。${nickname ? `${nickname}，` : ''}今天想先聊点什么？`;
        const saved = updatePersona(created.id, {
          core: { identity, speechHabits: style.habits, values: ['真诚', '有用'], boundaries: [] },
          express: {
            warmth: style.warmth, playfulness: style.playfulness,
            directness: style.directness, preachiness: style.preachiness,
            lengthPolicy: 'adaptive', emoji: false,
            voice: { engine: 'inherit', name: '', rate: 0 },
          },
          card: { firstMes: opening, tags: ['助手', tone] },
          model: { provider: 'inherit', baseUrl: '', model: '', apiKeyRef: 'inherit' },
          active: body.active !== false,
        });
        const active = saved && body.active !== false ? setActivePersona(saved.id) : saved;
        sendJson(res, { ok: true, persona: active, opening, keyMode: 'inherit' }, 201);
        return true;
      }
      if (path === '/import-document' && method === 'POST') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const fileName = String(body.fileName || body.name || 'document').slice(0, 200);
        const mime = String(body.mime || '').slice(0, 120);
        let bytes = null;
        if (typeof body.base64 === 'string' && body.base64) {
          try { bytes = Buffer.from(body.base64.replace(/^data:[^;]+;base64,/, ''), 'base64'); } catch { bytes = null; }
        }
        if (!bytes && typeof body.text === 'string') bytes = Buffer.from(body.text, 'utf8');
        if (!bytes || !bytes.length) { errorOf(res, 'bad-request', '没有收到文档内容', 400); return true; }
        // JSON/PNG 角色卡：直接归一，不再送模型。
        let directCard = null;
        if (/\.(json)$/i.test(fileName) || /application\/json/i.test(mime)) {
          directCard = parseCardJson(bytes.toString('utf8'));
        } else if (/\.(png)$/i.test(fileName) || /image\/png/i.test(mime)) {
          directCard = readCardFromPng(bytes);
        }
        if (directCard) {
          const draftPersona = {
            name: directCard.name || '特殊人设',
            type: 'character', mode: 'roleplay',
            core: { identity: [directCard.description, directCard.personality].filter(Boolean).join('\n\n') },
            card: {
              scenario: directCard.scenario, firstMes: directCard.firstMes,
              systemPrompt: directCard.systemPrompt, postHistoryInstructions: directCard.postHistoryInstructions,
              tags: directCard.tags, cover: directCard.cover, recommendedVoice: directCard.recommendedVoice,
              source: directCard.source, sourceName: directCard.sourceName, version: directCard.version,
            },
          };
          sendJson(res, {
            ok: true, kind: 'card', fileName, usedModel: false, warnings: [],
            card: normalizedToCcv2(directCard), persona: draftPersona, text: '', chunks: 0,
          });
          return true;
        }
        let extracted;
        try {
          extracted = extractDocumentText({ fileName, mime, buffer: bytes, text: body.text });
        } catch (error) {
          errorOf(res, (error && error.code) || 'bad-document', '文档读取失败（支持 docx/md/txt/JSON/PNG）', 400);
          return true;
        }
        if (extracted.kind === 'json') {
          const card = parseCardJson(extracted.text);
          if (card) {
            sendJson(res, { ok: true, kind: 'card', fileName, usedModel: false, warnings: [], card: normalizedToCcv2(card), persona: {
              name: card.name || '特殊人设', type: 'character', mode: 'roleplay',
              core: { identity: [card.description, card.personality].filter(Boolean).join('\n\n') },
              card: { scenario: card.scenario, firstMes: card.firstMes, tags: card.tags },
            }, text: '', chunks: 0 });
            return true;
          }
        }
        const chunks = chunkDocument(extracted.text);
        const result = await cardizeDocument({ text: extracted.text, fileName, chunks });
        const normalized = normalizeCard(result.card);
        const personaDraft = {
          name: normalized.name || '特殊人设',
          type: 'character', mode: 'roleplay',
          core: {
            identity: [normalized.description, normalized.personality].filter(Boolean).join('\n\n'),
            speechHabits: normalized.speechHabits || [],
            worldBook: normalized.characterBook,
            exampleDialogues: normalized.mesExample ? String(normalized.mesExample).split(/\n{2,}/).filter(Boolean) : [],
          },
          card: {
            scenario: normalized.scenario, firstMes: normalized.firstMes,
            systemPrompt: normalized.systemPrompt, postHistoryInstructions: normalized.postHistoryInstructions,
            tags: normalized.tags, wakeKeyword: normalized.wakeKeyword,
            cover: normalized.cover, recommendedVoice: normalized.recommendedVoice,
            source: 'document', sourceName: fileName, version: '1.0',
          },
          express: normalized.recommendedVoice
            ? { voice: { engine: 'inherit', name: normalized.recommendedVoice, rate: 0 } }
            : undefined,
        };
        let savedPersona = null;
        if (body.save === true) {
          const created = createPersona({
            type: 'character', mode: 'roleplay',
            name: personaDraft.name, avatar: '',
          });
          savedPersona = updatePersona(created.id, {
            ...personaDraft,
            card: { ...personaDraft.card, source: 'document', sourceName: fileName },
            model: { provider: 'inherit', baseUrl: '', model: '', apiKeyRef: 'inherit' },
            active: body.active === true,
          });
          try {
            const dir = join(personaDir(created.id), 'cards');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `document-${Date.now()}.txt`), extracted.text);
            writeFileSync(join(dir, `document-${Date.now()}.json`), JSON.stringify(normalized, null, 2));
          } catch { /* 原文留档失败不影响保存 */ }
          if (savedPersona && body.active === true) savedPersona = setActivePersona(savedPersona.id);
          if (savedPersona) {
            try { appendEvent(savedPersona.id, { kind: 'event', importance: 6, text: `从文档导入人设：${fileName}` }); } catch { /* ignore */ }
            try {
              if (extracted.text && extracted.text.trim().length >= 120) {
                addLore(savedPersona.id, { title: fileName, content: extracted.text, source: 'document-import' });
              }
            } catch { /* lore 失败不影响导入 */ }
          }
        }
        sendJson(res, {
          ok: true, kind: extracted.kind, fileName,
          usedModel: result.usedModel, warnings: result.warnings,
          card: result.card, persona: savedPersona || personaDraft,
          text: extracted.text, chunks: chunks.length,
        });
        return true;
      }

      const match = path.match(/^\/([^/]+)(?:\/(.*))?$/);
      if (!match) return false;
      const id = decodeURIComponent(match[1]);
      const rest = match[2] || '';
      const persona = readPersona(id);
      if (!persona) { errorOf(res, 'not-found', '人设不存在', 404); return true; }

      if (!rest && method === 'GET') {
        sendJson(res, {
          ok: true, persona, key: publicKeyInfo(id), keyStatus: keyStatus(persona), global: globalStatus(),
          voice: voiceStatusOf(persona), permissions: personaPermissionsView(persona),
          toolLog: readToolLog(id, 10),
        });
        return true;
      }
      if (!rest && method === 'PATCH') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const saved = updatePersona(id, body);
        sendJson(res, {
          ok: true, persona: saved, key: publicKeyInfo(id),
          keyStatus: saved ? keyStatus(saved) : keyStatus(persona), global: globalStatus(),
          voice: saved ? voiceStatusOf(saved) : voiceStatusOf(persona),
          permissions: saved ? personaPermissionsView(saved) : personaPermissionsView(persona),
        });
        return true;
      }
      if (!rest && method === 'DELETE') {
        const queryConfirm = url && url.searchParams ? url.searchParams.get('confirm') === '1' : false;
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        if (!queryConfirm && body.confirm !== true) {
          errorOf(res, 'confirm-required', '删除人设会同时删除它的全部记忆，请二次确认', 409);
          return true;
        }
        const result = deletePersona(id);
        sendJson(res, result, result.ok ? 200 : 500);
        return true;
      }
      if (rest === 'permissions' && (method === 'GET' || method === 'HEAD')) {
        sendJson(res, {
          ok: true, personaId: id, ...personaPermissionsView(persona),
          globalVoice: globalVoiceStatus(), voice: voiceStatusOf(persona),
        });
        return true;
      }
      if (rest === 'permissions' && method === 'POST') {
        if (persona.type === 'character') {
          errorOf(res, 'character-no-tools', '特殊人设不能使用系统工具，没有可配置的权限', 403);
          return true;
        }
        const body = await new Promise((resolveP) => { withBody(req, resolveP).catch(() => resolveP({})); });
        const current = persona.permissions && typeof persona.permissions === 'object'
          ? persona.permissions : defaultPermissions(persona.type);
        const next = { ...current };
        if (body.reset === true) {
          Object.assign(next, defaultPermissions('assistant'));
        }
        if (typeof body.advanced === 'boolean') next.advanced = body.advanced;
        if (body.group) {
          const group = PERMISSION_GROUPS.find((item) => item.id === String(body.group));
          if (!group) { errorOf(res, 'bad-group', '没有这个工具组', 400); return true; }
          if (!PERMISSION_LEVELS.includes(String(body.level))) {
            errorOf(res, 'bad-level', '权限只能是 allow / ask / deny', 400);
            return true;
          }
          if (group.advancedOnly && next.advanced !== true && String(body.level) !== 'deny') {
            errorOf(res, 'advanced-required', '系统操作需要先打开「高级权限」', 409);
            return true;
          }
          next[group.id] = String(body.level);
          next.consentMemory = { ...(next.consentMemory || {}) };
        }
        const saved = updatePersona(id, { permissions: next });
        sendJson(res, {
          ok: true, persona: saved, ...personaPermissionsView(saved),
          message: '权限已保存',
        });
        return true;
      }
      if (rest === 'tool-log' && (method === 'GET' || method === 'HEAD')) {
        const limit = Number(url.searchParams.get('limit') || 10);
        sendJson(res, { ok: true, personaId: id, ...readToolLog(id, limit) });
        return true;
      }
      if (rest === 'tool-log' && method === 'DELETE') {
        const result = clearToolLog(id);
        sendJson(res, { ok: result.ok, personaId: id, ...result });
        return true;
      }
      if (rest === 'import-card' && method === 'POST') {
        const result = await importCard(persona, req, url);
        sendJson(res, result, result.ok ? 200 : 400);
        return true;
      }
      if (rest === 'export-card' && (method === 'GET' || method === 'HEAD')) {
        const card = personaToCard(persona);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(persona.name || id)}-card.json"`);
        res.end(JSON.stringify(card, null, 2));
        return true;
      }
      if (rest === 'export-card.png' && (method === 'GET' || method === 'HEAD')) {
        const png = buildCardPng(persona);
        res.statusCode = 200;
        res.setHeader('content-type', 'image/png');
        res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(persona.name || id)}-card.png"`);
        res.end(png);
        return true;
      }
      if (rest === 'key' && method === 'POST') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        if (body.apiKey !== undefined) writePersonaKey(id, body.apiKey);
        if (body.mode === 'inherit' || body.mode === 'persona') {
          updatePersona(id, { model: { apiKeyRef: body.mode === 'inherit' ? 'inherit' : `vault:${id}` } });
        } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
          // 旧测试/旧客户端只发 apiKey：写 Key 即视为“独立 Key”，与 v1 行为兼容。
          updatePersona(id, { model: { apiKeyRef: `vault:${id}` } });
        }
        const updated = readPersona(id) || persona;
        sendJson(res, { ok: true, key: publicKeyInfo(id), keyStatus: keyStatus(updated), global: globalStatus() });
        return true;
      }
      if (rest === 'key/test' && method === 'POST') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const result = await testKey(persona, body);
        sendJson(res, result, result.ok ? 200 : 200);
        return true;
      }
      if (rest === 'memory' && (method === 'GET' || method === 'HEAD')) {
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 50);
        const q = url.searchParams.get('q') || '';
        sendJson(res, {
          ok: true,
          personaId: id,
          ...listEvents(id, { offset, limit, q }),
          growth: persona.growth.traits,
          summary: readSummary(id),
          totalAll: eventCount(id),
        });
        return true;
      }
      /* ── v1.2 记忆 v2：统计 / 导出 / 衰减 / 回滚 / 观察记录 / 关系 / 世界书 ── */
      if (rest === 'memory/stats' && (method === 'GET' || method === 'HEAD')) {
        sendJson(res, {
          ok: true, personaId: id,
          ...memoryStats(id),
          backend: memoryBackend(id),
          migration: memoryMigrationInfo(id),
          storage: memoryStoragePath(id),
        });
        return true;
      }
      if (rest === 'memory/export' && (method === 'GET' || method === 'HEAD')) {
        const payload = exportMemory(id);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-disposition', `attachment; filename="${encodeURIComponent(id)}-memory.json"`);
        res.end(JSON.stringify(payload, null, 2));
        return true;
      }
      if (rest === 'memory/decay' && method === 'POST') {
        const result = decayTick(id);
        sendJson(res, { ok: true, personaId: id, ...result });
        return true;
      }
      if (rest === 'memory/rollback' && method === 'POST') {
        const body = await new Promise((resolveP) => { withBody(req, resolveP).catch(() => resolveP({})); });
        const result = body.date
          ? deleteEventsByDate(id, String(body.date))
          : rollbackEvents(id, Number(body.before || 0));
        sendJson(res, { ...result, personaId: id }, result.ok ? 200 : 400);
        return true;
      }
      if (rest === 'memory/by-date' && method === 'DELETE') {
        const date = url && url.searchParams ? url.searchParams.get('date') : '';
        const result = deleteEventsByDate(id, String(date || ''));
        sendJson(res, { ...result, personaId: id }, result.ok ? 200 : 400);
        return true;
      }
      if (rest === 'observations' && (method === 'GET' || method === 'HEAD')) {
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 50);
        sendJson(res, { ok: true, personaId: id, ...listObservations(id, { offset, limit }) });
        return true;
      }
      if (rest === 'observations' && method === 'DELETE') {
        sendJson(res, { ok: true, personaId: id, ...clearObservations(id) });
        return true;
      }
      const observationMatch = rest.match(/^observations\/([^/]+)$/);
      if (observationMatch && method === 'DELETE') {
        const result = deleteEvent(id, decodeURIComponent(observationMatch[1]));
        sendJson(res, result, result.ok ? 200 : 404);
        return true;
      }
      if (rest === 'relations' && (method === 'GET' || method === 'HEAD')) {
        sendJson(res, { ok: true, personaId: id, items: listRelations(id) });
        return true;
      }
      if (rest === 'relations' && method === 'POST') {
        const body = await new Promise((resolveP) => { withBody(req, resolveP).catch(() => resolveP({})); });
        const result = upsertRelation(id, body.entity, Number(body.delta) || 0, body.note);
        sendJson(res, { ok: result.ok === true, personaId: id, ...result }, result.ok ? 200 : 400);
        return true;
      }
      const relationMatch = rest.match(/^relations\/([^/]+)$/);
      if (relationMatch && method === 'DELETE') {
        const result = deleteRelation(id, decodeURIComponent(relationMatch[1]));
        sendJson(res, { ...result, personaId: id }, result.ok ? 200 : 404);
        return true;
      }
      if (rest === 'lore' && (method === 'GET' || method === 'HEAD')) {
        const q = url.searchParams.get('q') || '';
        sendJson(res, {
          ok: true, personaId: id,
          items: q ? searchLore(id, q, { limit: 20 }) : listLore(id, { limit: 200 }),
        });
        return true;
      }
      if (rest === 'lore' && method === 'POST') {
        const body = await new Promise((resolveP) => { withBody(req, resolveP).catch(() => resolveP({})); });
        const result = addLore(id, { title: body.title, content: body.content, source: body.source });
        sendJson(res, { ok: result.ok === true, personaId: id, ...result }, result.ok ? 200 : 400);
        return true;
      }
      const loreMatch = rest.match(/^lore\/(\d+)$/);
      if (loreMatch && method === 'DELETE') {
        const result = deleteLore(id, Number(loreMatch[1]));
        sendJson(res, { ...result, personaId: id }, result.ok ? 200 : 404);
        return true;
      }
      const eventMatch = rest.match(/^memory\/([^/]+)$/);
      if (eventMatch && method === 'DELETE') {
        const result = deleteEvent(id, decodeURIComponent(eventMatch[1]));
        sendJson(res, result, result.ok ? 200 : 404);
        return true;
      }
      if (rest === 'rollback' && method === 'POST') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const result = rollbackGrowth(id, body.date || body.before);
        sendJson(res, result, result.ok ? 200 : 400);
        return true;
      }
      if (rest === 'growth/delete' && method === 'POST') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const result = deleteTrait(id, { text: body.text, index: body.index });
        sendJson(res, result, result.ok ? 200 : 404);
        return true;
      }
      if (rest === 'active' && method === 'POST') {
        const saved = setActivePersona(id);
        sendJson(res, { ok: true, activeId: getActivePersonaId(), persona: saved });
        return true;
      }
      return false;
    } catch (error) {
      log('[personas] request failed: ' + String((error && error.message) || error).slice(0, 160));
      errorOf(res, 'internal', '人设操作失败', 500);
      return true;
    }
  };
}

/** 仅用于路由测试：把卡 JSON 归一。 */
export function normalizeCardForTest(card) {
  return parseCardJson(card);
}

/** 路由族注入面（与 verify-inject-contracts 对账）。 */
export const DEPS = ['disposers', 'base', 'readSettings', 'log'];

/**
 * 注册 `/pet-chat/personas` 前缀路由。
 * pet-chat 的 `/pet-chat` 前缀也会把子路径委托给同一个 handler；两条同时存在时
 * 宿主按自己的匹配顺序选一条，功能等价（都调 createPersonaApi）。
 */
export function registerPersonaRoutes(webServer, c) {
  const api = createPersonaApi({ readSettings: c.readSettings, log: c.log });
  const prefix = `${c.base}/pet-chat/personas`;
  c.disposers.push(webServer.register({
    kind: 'prefix',
    path: prefix,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const sub = url.pathname.slice(prefix.length).replace(/\/+$/, '');
      const handled = await api(req, res, sub || '/', url);
      if (!handled) { res.statusCode = 404; res.end('not found'); }
    },
  }));
}
