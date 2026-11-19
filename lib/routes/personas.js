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
  hasPersonaKey, maskKey,
} from '../persona-store.js';
import { cardToPersonaPatch, parseCardJson, readCardFromPng, personaToCard, buildCardPng } from '../persona-card.js';
import { listEvents, deleteEvent, eventCount, readSummary } from '../persona-memory.js';
import { rollbackGrowth, deleteTrait } from '../persona-growth.js';

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

function clip(value, max) {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
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
          sendJson(res, { ok: true, activeId: getActivePersonaId(), personas: personas.map((item) => {
            const p = readPersona(item.id);
            return {
              ...item,
              key: publicKeyInfo(item.id),
              memoryCount: eventCount(item.id),
              growthCount: p ? p.growth.traits.length : 0,
            };
          }) });
          return true;
        }
        if (method === 'POST') {
          const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
          const persona = createPersona({
            type: body.type === 'character' ? 'character' : 'assistant',
            mode: ['chat', 'roleplay', 'story'].includes(body.mode) ? body.mode : (body.type === 'character' ? 'roleplay' : 'chat'),
            name: typeof body.name === 'string' ? body.name : '',
            avatar: typeof body.avatar === 'string' ? body.avatar : '',
          });
          sendJson(res, { ok: true, persona }, 201);
          return true;
        }
        return false;
      }

      const match = path.match(/^\/([^/]+)(?:\/(.*))?$/);
      if (!match) return false;
      const id = decodeURIComponent(match[1]);
      const rest = match[2] || '';
      const persona = readPersona(id);
      if (!persona) { errorOf(res, 'not-found', '人设不存在', 404); return true; }

      if (!rest && method === 'GET') {
        sendJson(res, { ok: true, persona, key: publicKeyInfo(id) });
        return true;
      }
      if (!rest && method === 'PATCH') {
        const body = await new Promise((resolve) => { withBody(req, resolve).catch(() => resolve({})); });
        const saved = updatePersona(id, body);
        sendJson(res, { ok: true, persona: saved, key: publicKeyInfo(id) });
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
        sendJson(res, { ok: true, key: publicKeyInfo(id) });
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
