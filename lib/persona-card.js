/**
 * persona-card.js — SillyTavern Character Card V2 的导入/导出（纯函数，无路由依赖）。
 *
 * 支持：
 *   · JSON：CCv2（`spec:"chara_card_v2"` + `data`）与裸字段旧卡；
 *   · PNG：解析 tEXt 块 `chara`（V2 规范，base64 JSON）与 `ccv3`（优先 ccv3）；
 *   · 导出：把 persona 反向写成 CCv2 JSON。
 *
 * PNG 解析只做**取文本块**：校验 8 字节签名与基本 chunk 结构，CRC 不参与判断
 * （CRC 错但 JSON 可读时按可读内容导入；坏卡由 JSON.parse 拒绝）。不上传、不写日志。
 */
const clip = (value, max) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

const asString = (value) => (typeof value === 'string' ? value : '');
const asArray = (value) => (Array.isArray(value) ? value : []);

/** 把 V2 的 `character_book.entries` 折成我们的 worldBook。 */
export function normalizeWorldBook(book) {
  const entries = book && Array.isArray(book.entries) ? book.entries : [];
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const keys = asArray(entry.keys).map((key) => clip(key, 40)).filter(Boolean);
    const secondary = asArray(entry.secondary_keys).map((key) => clip(key, 40)).filter(Boolean);
    return {
      keys: [...new Set([...keys, ...secondary])].slice(0, 12),
      content: clip(entry.content, 4000),
      priority: Math.max(0, Math.min(100, Math.round(Number(entry.insertion_order ?? entry.priority ?? entry.order) || 5))),
    };
  }).filter((entry) => entry && entry.keys.length && entry.content);
}

/** 把任意 CCv2/旧卡对象归一成统一卡形状。 */
export function normalizeCard(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const data = src.data && typeof src.data === 'object' && !Array.isArray(src.data) ? src.data : src;
  const rawBook = data.character_book || data.characterBook || { entries: [] };
  const book = Array.isArray(rawBook) ? { entries: rawBook } : rawBook;
  const rawExt = data.extensions && typeof data.extensions === 'object' ? data.extensions : {};
  const folia = rawExt.folia && typeof rawExt.folia === 'object' ? rawExt.folia : {};
  return {
    name: clip(data.name, 80),
    description: asString(data.description),
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    firstMes: asString(data.first_mes ?? data.firstMes),
    mesExample: asString(data.mes_example ?? data.mesExample),
    systemPrompt: asString(data.system_prompt ?? data.systemPrompt),
    postHistoryInstructions: asString(data.post_history_instructions ?? data.postHistoryInstructions),
    characterBook: normalizeWorldBook(book),
    tags: asArray(data.tags || src.tags).map((tag) => clip(tag, 40)).filter(Boolean).slice(0, 50),
    creatorNotes: asString(data.creator_notes || data.creatorcomment),
    cover: clip(folia.cover || data.cover || '', 500),
    recommendedVoice: clip(folia.recommendedVoice || data.recommendedVoice || data.recommended_voice || data.voice || '', 160),
    wakeKeyword: clip(folia.wakeKeyword || data.wakeKeyword || '', 80),
    source: ['official', 'document', 'import', 'user'].includes(String(folia.source || '')) ? String(folia.source) : 'import',
    sourceName: clip(folia.sourceName || data.sourceName || '', 160),
    version: clip(folia.version || data.version || '1.0', 40),
    speechHabits: asArray(folia.speechHabits).map((item) => clip(item, 200)).filter(Boolean).slice(0, 20),
  };
}

/** 字符串或对象 → 归一卡；解析失败返回 null。 */
export function parseCardJson(input) {
  let doc = input;
  if (typeof input === 'string') {
    try { doc = JSON.parse(input.trim()); } catch { return null; }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  return normalizeCard(doc);
}

/** 把示例对话按行/分隔符切成数组（保留完整多行段）。 */
function splitExamples(text) {
  const raw = asString(text).trim();
  if (!raw) return [];
  return raw.split(/\n{2,}|<START>/i).map((part) => part.trim()).filter(Boolean).slice(0, 30);
}

/** 卡 → 更新 persona 的 patch（不直接写盘）。 */
export function cardToPersonaPatch(card, current = {}) {
  const normalized = normalizeCard(card);
  const personality = normalized.personality.trim();
  const description = normalized.description.trim();
  const identity = [description, personality].filter(Boolean).join('\n\n');
  const identityText = identity || (current.core && current.core.identity) || '';
  return {
    type: 'character',
    name: normalized.name || current.name || '',
    core: {
      identity: clip(identityText, 8000),
      values: (current.core && current.core.values) || [],
      boundaries: (current.core && current.core.boundaries) || [],
      speechHabits: normalized.speechHabits.length
        ? normalized.speechHabits
        : ((current.core && current.core.speechHabits) || []),
      exampleDialogues: splitExamples(normalized.mesExample).length
        ? splitExamples(normalized.mesExample)
        : ((current.core && current.core.exampleDialogues) || []),
      worldBook: normalized.characterBook.length
        ? normalized.characterBook
        : ((current.core && current.core.worldBook) || []),
    },
    card: {
      scenario: clip(normalized.scenario, 4000),
      firstMes: clip(normalized.firstMes, 4000),
      systemPrompt: clip(normalized.systemPrompt, 8000),
      postHistoryInstructions: clip(normalized.postHistoryInstructions, 4000),
      tags: normalized.tags,
      wakeKeyword: normalized.wakeKeyword,
      cover: normalized.cover,
      recommendedVoice: normalized.recommendedVoice,
      source: normalized.source,
      sourceName: normalized.sourceName,
      version: normalized.version,
    },
  };
}

/** persona → CCv2 导出（data 段，可直接写入 JSON 文件）。 */
export function personaToCard(persona) {
  const safe = persona && typeof persona === 'object' ? persona : {};
  const core = safe.core && typeof safe.core === 'object' ? safe.core : {};
  const card = safe.card && typeof safe.card === 'object' ? safe.card : {};
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: clip(safe.name, 80),
      description: clip(core.identity || '', 8000),
      personality: clip((core.values || []).join('；'), 4000),
      scenario: clip(card.scenario || '', 4000),
      first_mes: clip(card.firstMes || '', 4000),
      mes_example: clip((core.exampleDialogues || []).join('\n\n'), 8000),
      system_prompt: clip(card.systemPrompt || '', 8000),
      post_history_instructions: clip(card.postHistoryInstructions || '', 4000),
      character_book: {
        name: `${safe.name || 'persona'} 世界书`,
        entries: (Array.isArray(core.worldBook) ? core.worldBook : []).map((entry, index) => ({
          keys: Array.isArray(entry.keys) ? entry.keys : [],
          content: String(entry.content || ''),
          enabled: true,
          insertion_order: Number(entry.priority) || 5,
          id: index,
        })),
      },
      tags: Array.isArray(card.tags) ? card.tags : [],
      creator_notes: '由 Folia 人设系统导出',
      extensions: {
        folia: {
          cover: card.cover || '',
          recommendedVoice: card.recommendedVoice || '',
          wakeKeyword: card.wakeKeyword || '',
          source: card.source || 'user',
          sourceName: card.sourceName || '',
          version: card.version || '1.0',
        },
      },
    },
  };
}

/* ── PNG tEXt / iTXt ───────────────────────────────────────────────────── */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 解析 PNG 文本块，返回 `{ chara, ccv3 }`（值为 JSON 字符串或 null）。 */
export function readPngTextChunks(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { chara: null, ccv3: null };
  const out = { chara: null, ccv3: null };
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    if (length > 16 * 1024 * 1024) break;
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > buf.length) break;
    const data = buf.subarray(start, end);
    if (type === 'tEXt') {
      const zero = data.indexOf(0);
      if (zero > 0) {
        const keyword = data.toString('latin1', 0, zero).toLowerCase();
        if (keyword === 'chara' || keyword === 'ccv3') {
          const text = data.toString('utf8', zero + 1);
          out[keyword] = text;
        }
      }
    } else if (type === 'iTXt') {
      const zero = data.indexOf(0);
      if (zero > 0) {
        const keyword = data.toString('latin1', 0, zero).toLowerCase();
        // iTXt: keyword\0 compressionFlag(1) compressionMethod(1) language\0 translated\0 text
        let p = zero + 3;
        const langEnd = data.indexOf(0, p);
        if (langEnd >= 0) {
          p = langEnd + 1;
          const transEnd = data.indexOf(0, p);
          if (transEnd >= 0) {
            p = transEnd + 1;
            if (keyword === 'chara' || keyword === 'ccv3') out[keyword] = data.toString('utf8', p);
          }
        }
      }
    }
    if (type === 'IEND') break;
    offset = end + 4;
  }
  return out;
}

/** 从 PNG 里拿卡（优先 ccv3，其次 chara）；不是角色卡返回 null。 */
export function readCardFromPng(buffer) {
  const chunks = readPngTextChunks(buffer);
  const order = [chunks.ccv3, chunks.chara].filter(Boolean);
  for (const text of order) {
    let decoded = text.trim();
    // tEXt 里通常是 base64(JSON)；也容忍直接 JSON 的卡。
    if (!decoded.startsWith('{')) {
      try { decoded = Buffer.from(decoded, 'base64').toString('utf8'); } catch { continue; }
    }
    const card = parseCardJson(decoded);
    if (card) return card;
  }
  return null;
}

/** 生成一张带 `chara` tEXt 块的最小 PNG（导出 PNG 卡 / 判据夹具用）。 */
export function buildCardPng(card, { keyword = 'chara' } = {}) {
  const payload = card && card.spec ? card : personaToCard(card);
  const json = JSON.stringify(payload);
  const text = Buffer.from(String(keyword) + '\0' + Buffer.from(json, 'utf8').toString('base64'), 'latin1');
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('tEXt', text), chunk('IEND', Buffer.alloc(0))]);
}
