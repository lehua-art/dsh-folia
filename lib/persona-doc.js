/**
 * persona-doc.js — 人设文档（docx / md / txt）→ 纯文本 → 分块 → CCv2 草稿卡。
 *
 * 设计取舍（pre.65 UI v2）：
 *   · **不引入新依赖**：docx 是 ZIP + XML，单文件最小解析 `word/document.xml` 足够，
 *     不为了 2 个样例装 mammoth/jszip；
 *   · 抽取只做纯文本 + 段落，不执行宏/图片/外链；
 *   · 长文只取“设定/关系/世界观/开场/示例”相关块送模型，绝不整篇塞 prompt；
 *   · 模型不可用时给**确定性启发式卡**，保证“上传即可预览”，不是卡在报错页。
 */
import { inflateRawSync } from 'node:zlib';

const MAX_DOC_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_CHARS = 120_000;

const clip = (value, max) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

const decodeXml = (text) => String(text || '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** 从 `word/document.xml` 抽段落文本（不保留样式，只保留换行）。 */
export function docxXmlToText(xml) {
  let text = String(xml || '');
  text = text.replace(/<w:tab\b[^>]*\/>/gi, '\t');
  text = text.replace(/<w:br\b[^>]*\/>/gi, '\n');
  text = text.replace(/<\/w:p>/gi, '\n');
  text = text.replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi, (_, value) => decodeXml(value));
  text = text.replace(/<[^>]+>/g, '');
  return decodeXml(text).replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 最小 ZIP 中央目录读取：只拿指定 entry，支持 store/deflate。 */
function readZipEntry(buf, wanted) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return null;
  const min = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (name === wanted) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) return null;
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const end = start + compressedSize;
      if (end > buf.length) return null;
      const payload = buf.subarray(start, end);
      if (method === 0) return payload;
      if (method === 8) {
        try { return inflateRawSync(payload); } catch { return null; }
      }
      return null;
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** docx Buffer → 纯文本。 */
export function readDocxText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (buf.length > MAX_DOC_BYTES) throw Object.assign(new Error('doc-too-large'), { code: 'too-large' });
  const xml = readZipEntry(buf, 'word/document.xml');
  if (!xml) throw Object.assign(new Error('bad-docx'), { code: 'bad-docx' });
  const text = docxXmlToText(xml.toString('utf8'));
  if (!text) throw Object.assign(new Error('empty-doc'), { code: 'empty-doc' });
  return text;
}

/** 按文件名/MIME 取文本；md/txt/json 直接 utf8。 */
export function extractDocumentText({ fileName = '', mime = '', buffer = null, text = '' } = {}) {
  const name = String(fileName || '').toLowerCase();
  const type = String(mime || '').toLowerCase();
  if (/\.(docx)$/.test(name) || /officedocument\.wordprocessingml/.test(type) || /application\/zip/.test(type)) {
    if (!buffer) throw Object.assign(new Error('docx-needs-binary'), { code: 'bad-request' });
    return { text: readDocxText(buffer), kind: 'docx' };
  }
  if (/\.(json)$/.test(name) || /application\/json/.test(type)) {
    const raw = buffer ? buffer.toString('utf8') : String(text || '');
    return { text: raw, kind: 'json', raw };
  }
  const raw = buffer ? buffer.toString('utf8') : String(text || '');
  if (!raw.trim()) throw Object.assign(new Error('empty-doc'), { code: 'empty-doc' });
  return { text: clip(raw.replace(/\r\n/g, '\n'), MAX_TEXT_CHARS), kind: /\.(md|markdown)$/.test(name) ? 'md' : 'txt' };
}

/** 按段落/标题切块；长文只留“有信息量”的块。 */
export function chunkDocument(text, maxChars = 6000) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const sections = raw.split(/\n(?=#{1,4}\s)/);
  const chunks = [];
  let buf = '';
  for (const section of sections) {
    if ((buf + '\n' + section).length > maxChars && buf) {
      chunks.push(buf.trim());
      buf = '';
    }
    if (section.length > maxChars) {
      const lines = section.split('\n');
      for (const line of lines) {
        if ((buf + '\n' + line).length > maxChars && buf) { chunks.push(buf.trim()); buf = ''; }
        buf += (buf ? '\n' : '') + line;
      }
    } else {
      buf += (buf ? '\n\n' : '') + section;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.map((chunk) => clip(chunk, maxChars)).filter(Boolean).slice(0, 40);
}

/** 选与“人设卡”最相关的块（世界书/场景/开场/性格优先），不整篇送模型。 */
export function selectCardChunks(chunks, maxChunks = 4) {
  const score = (chunk) => {
    const text = String(chunk);
    let value = 0;
    for (const [re, weight] of [
      [/角色简介|姓名|身份|种族|职业/, 6], [/性格|人格|互动原则|回复格式/, 5],
      [/场景描述|环境设定|启动|开场白|立即回复/, 6], [/世界观|设定|泰拉|罗德岛|关系/, 4],
      [/示例对话|对话样例|称呼/, 3], [/目录|更新说明|制作方/, -3],
    ]) if (re.test(text)) value += weight;
    return value + Math.min(2, text.length / 4000);
  };
  return chunks.map((chunk, index) => ({ chunk, index, score: score(chunk) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxChunks).sort((a, b) => a.index - b.index).map((item) => item.chunk);
}

function headingOf(text) {
  const line = String(text || '').split('\n').map((item) => item.trim()).find(Boolean) || '';
  return line.replace(/^#{1,6}\s*/, '').replace(/^\*\*|\*\*$/g, '').trim();
}

function sectionText(text, pattern, maxChars = 3000) {
  const raw = String(text || '');
  const match = raw.match(pattern);
  if (!match) return '';
  const start = match.index + match[0].length;
  const rest = raw.slice(start);
  const next = rest.search(/\n#{1,4}\s/);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  return clip(body.replace(/^```(?:markdown)?\s*/i, '').replace(/```$/g, '').trim(), maxChars);
}

function firstQuoteBlock(text) {
  const match = String(text || '').match(/(?:^|\n)>\s*([^\n]+(?:\n>\s*[^\n]+)*)/);
  if (!match) return '';
  return clip(match[1].split(/\n>\s*/).map((line) => line.trim()).filter(Boolean).join('\n'), 4000);
}

/** 文档 → CCv2 卡（确定性启发式；模型失败/未配置时仍可用）。 */
export function heuristicCardFromText(text, fileName = '') {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const title = headingOf(raw) || String(fileName).replace(/\.(docx|md|markdown|txt|json)$/i, '');
  const nameMatch = raw.match(/【姓名】\s*([^\n（(]+)/) || raw.match(/姓名[：:]\s*([^\n（(]+)/);
  const name = clip((nameMatch && nameMatch[1] ? nameMatch[1] : title.replace(/[（(].*$/, '')).trim(), 80) || '未命名角色';
  const intro = sectionText(raw, /【绝对优先】文本意义|本文档用于|角色简介/i, 2200);
  const personality = sectionText(raw, /性格特质|人格设定|核心本质/i, 2400);
  const scenario = sectionText(raw, /场景描述|环境设定|常驻场景/i, 2400);
  const opening = firstQuoteBlock(raw)
    || sectionText(raw, /开场白|启动(?:口令|方式)|立即回复以下内容/i, 1200)
    || `（${name}抬起头，看向你。）你来了。`;
  const wake = (raw.match(/发送[“"]([^”"]{1,40})[”"]后/) || [])[1] || '';
  const worldSource = sectionText(raw, /世界观|泰拉|矿石病|感染者|核心设定/i, 3200);
  const worldBook = [];
  const pick = (keys, content, priority) => {
    if (content && content.trim()) worldBook.push({ keys, content: clip(content, 4000), priority });
  };
  pick(['泰拉', '源石', '矿石病', '感染者'], worldSource, 8);
  pick(['罗德岛', '本舰', '指挥室'], scenario, 6);
  pick([name, '角色', '关系'], [intro, personality].filter(Boolean).join('\n\n'), 7);
  if (!worldBook.length) pick([name, '设定'], intro || raw, 5);
  const description = [intro, personality].filter(Boolean).join('\n\n') || clip(raw, 6000);
  const speech = (raw.match(/称呼[：:]\s*([^\n]+)/g) || []).slice(0, 4);
  const tags = [];
  if (/明日方舟|罗德岛|泰拉/.test(raw)) tags.push('明日方舟');
  if (/互动小说|故事|叙述/.test(raw)) tags.push('互动故事');
  tags.push('角色扮演');
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description,
      personality: personality || intro,
      scenario,
      first_mes: opening,
      mes_example: opening ? `{{user}}：我回来了。\n{{char}}：${opening}` : '',
      system_prompt: sectionText(raw, /回复格式|互动原则|绝对优先.*格式/i, 2200),
      post_history_instructions: '',
      character_book: {
        name: `${name} 世界书`,
        entries: worldBook.map((entry, index) => ({
          keys: entry.keys, content: entry.content, enabled: true, insertion_order: entry.priority, id: index,
        })),
      },
      tags: [...new Set(tags)].slice(0, 8),
      creator_notes: '由文档导入并自动卡片化；请预览后保存。',
      extensions: {
        folia: {
          wakeKeyword: wake,
          recommendedVoice: '',
          source: 'document',
          sourceName: clip(String(fileName || ''), 160),
          speechHabits: speech.map((line) => clip(line.replace(/^称呼[：:]\s*/, ''), 80)),
        },
      },
    },
  };
}

/** 把模型返回的 JSON 对象补成 CCv2；缺字段用启发式结果兜底。 */
export function mergeDraftCard(modelCard, fallbackCard) {
  const base = fallbackCard && fallbackCard.data ? fallbackCard : { data: {} };
  const incoming = modelCard && modelCard.data && typeof modelCard.data === 'object' ? modelCard.data : (modelCard || {});
  const merged = {
    ...base.data,
    ...incoming,
    character_book: incoming.character_book || base.data.character_book,
    tags: Array.isArray(incoming.tags) && incoming.tags.length ? incoming.tags : base.data.tags,
    extensions: {
      ...(base.data.extensions || {}),
      ...(incoming.extensions || {}),
      folia: {
        ...((base.data.extensions && base.data.extensions.folia) || {}),
        ...((incoming.extensions && incoming.extensions.folia) || {}),
      },
    },
  };
  return { spec: 'chara_card_v2', spec_version: '2.0', data: merged };
}

export { MAX_DOC_BYTES, MAX_TEXT_CHARS };
