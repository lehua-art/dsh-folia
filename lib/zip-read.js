/**
 * lib/zip-read.js — 最小可用的 **zip 读取器**（只读，流式无关，内存里完成）。
 *
 * 为什么自己写：站点上的 WE 工程包是普通 zip（store / deflate），我们只需要"把条目读出来"，
 * 而 Node 没有内置解压。已有的 `lib/routes/pets.js#unzip` 是给宠物包定制的（只收
 * `sounds/` 前缀、上限几 MB），不适合 56 MB 的工程包；与其在那里放宽，不如抽出通用件。
 *
 * 安全纪律（每条都由 `test/zip-read.mjs` 钉住）：
 *   · **拒路径穿越**：条目名里出现 `..`、绝对路径、盘符、反斜杠穿越 ⇒ 整包拒绝（不是跳过 ——
 *     一个恶意条目说明这个包不可信，不该"部分解压"）。
 *   · **限量**：条目数、单条目解压后大小、总解压后大小、压缩比上限（zip bomb）。
 *   · `data` 一律返回**解压后**字节；调用方只写自己白名单内的条目。
 */

import { inflateRawSync } from 'node:zlib';

/** 默认上限：够放 336MB 的 scene.pkg，但挡住失控的解压炸弹。 */
export const ZIP_LIMITS = {
  maxEntries: 4000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 768 * 1024 * 1024,
  // 单条目压缩比上限（解压后 / 压缩后）。正常资源很难超过 200 倍。
  maxRatio: 200,
};

/** 条目名是否安全（相对、无穿越）。 */
export function isSafeZipEntryName(name) {
  const s = String(name || '');
  if (!s) return false;
  if (s.includes('\0')) return false;
  // 统一分隔符后再判
  const norm = s.replace(/\\/g, '/');
  if (norm.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(norm)) return false;         // 盘符
  const parts = norm.split('/');
  if (parts.some((p) => p === '..')) return false;
  return true;
}

/**
 * 解析并解压一个 zip（缓冲）。
 *
 * @param {Buffer} buf
 * @param {Partial<typeof ZIP_LIMITS>} [limits]
 * @returns {{ entries: { name: string, data: Buffer, isDir: boolean }[], skipped: string[] }}
 * @throws {Error} 带 `code`：`not-a-zip` / `unsafe-entry` / `too-many-entries` / `too-large` / `bad-zip`
 */
export function readZipEntries(buf, limits = {}) {
  const lim = { ...ZIP_LIMITS, ...limits };
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw Object.assign(new Error('not a zip'), { code: 'not-a-zip' });
  }
  // 本地文件头魔数 'PK\x03\x04'；允许空包 'PK\x05\x06'。
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x04034b50 && magic !== 0x06054b50) {
    throw Object.assign(new Error('not a zip'), { code: 'not-a-zip' });
  }
  // 末尾找中央目录结束记录（EOCD），最多回扫 64KB（含注释）。
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('bad zip: no EOCD'), { code: 'bad-zip' });

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > lim.maxEntries) {
    throw Object.assign(new Error('too many entries: ' + count), { code: 'too-many-entries' });
  }
  if (cdOffset + cdSize > buf.length) throw Object.assign(new Error('bad zip: CD out of range'), { code: 'bad-zip' });

  const entries = [];
  const skipped = [];
  let total = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw Object.assign(new Error('bad zip: bad CD entry'), { code: 'bad-zip' });
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!isSafeZipEntryName(name)) {
      throw Object.assign(new Error('unsafe entry: ' + name), { code: 'unsafe-entry' });
    }
    const isDir = name.endsWith('/');
    if (isDir) { entries.push({ name, data: Buffer.alloc(0), isDir: true }); continue; }
    if (uncompSize > lim.maxEntryBytes) {
      throw Object.assign(new Error('entry too large: ' + name), { code: 'too-large' });
    }
    total += uncompSize;
    if (total > lim.maxTotalBytes) throw Object.assign(new Error('archive too large'), { code: 'too-large' });

    // 本地头的名字/额外字段长度可能与中央目录不同 ⇒ 以本地头为准算数据起点。
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw Object.assign(new Error('bad zip: bad local header for ' + name), { code: 'bad-zip' });
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw Object.assign(new Error('bad zip: truncated data for ' + name), { code: 'bad-zip' });
    const raw = buf.subarray(dataStart, dataEnd);

    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      if (compSize > 0 && uncompSize / compSize > lim.maxRatio) {
        throw Object.assign(new Error('suspicious compression ratio: ' + name), { code: 'too-large' });
      }
      try { data = inflateRawSync(raw); } catch (e) {
        throw Object.assign(new Error('inflate failed for ' + name + ': ' + e.message), { code: 'bad-zip' });
      }
      if (data.length > lim.maxEntryBytes) {
        throw Object.assign(new Error('entry too large after inflate: ' + name), { code: 'too-large' });
      }
    } else {
      skipped.push(name + ' (method ' + method + ')');
      continue;
    }
    entries.push({ name, data, isDir: false });
  }
  return { entries, skipped };
}

/** 从 URL 末尾推出一个**文件系统安全**的短名（只保留 ASCII 字母数字与连字符）。 */
export function safeNameFromUrl(url, fallback = 'pkg') {
  let base = '';
  try { base = String(new URL(url).pathname).split('/').filter(Boolean).pop() || ''; } catch { base = ''; }
  const stem = base.replace(/\.[a-z0-9]{1,6}$/i, '');
  const ascii = stem.replace(/[^a-zA-Z0-9-]/g, '');
  return (ascii || fallback).slice(0, 40);
}
