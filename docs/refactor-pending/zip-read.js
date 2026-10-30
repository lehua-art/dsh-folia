/**
 * lib/zip-read.js — **唯一的 zip 读取器**（宿主侧所有"解包"都走这里）。
 *
 * 为什么要有它：`routes/pets.js` 与 `routes/skins.js` 曾各自实现了一遍中央目录遍历 +
 * inflateRaw + 路径检查 + 限量。两份实现的差别只在"遇到坏条目怎么办"和返回值形状上，
 * 而**路径穿越与 zip bomb 是安全面** —— 同一件事写两遍，迟早有一份漏掉一条检查。
 * 现在只有这一份，两个调用方各自声明**策略**（reject / skip）与形状转换。
 *
 * 安全纪律（每条都由 `test/zip-read.mjs` 钉住）：
 *   · 条目名出现 `..`、绝对路径、盘符、反斜杠穿越 ⇒ 由 `entryPolicy` 决定整包拒绝或跳过；
 *   · 条目数、单条目解压后大小、总解压后大小、压缩比（zip bomb）都有上限；
 *   · 只支持 store(0) 与 deflate(8)，其余方法显式报错（不静默当成空文件）。
 *
 * 错误一律带 `code`：`not-a-zip` / `bad-central` / `unsafe-entry` / `too-large` / `bad-entry`。
 */
import { inflateRawSync } from 'node:zlib';

/** 通用上限：够放 336MB 的 scene.pkg，同时挡住失控解压。 */
export const ZIP_LIMITS = {
  maxEntries: 4000,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 768 * 1024 * 1024,
  /** 单条目 压缩比 上限（解压后 / 压缩后）。正常资源很难超过 200 倍。 */
  maxRatio: 200,
};

function fail(code, message) {
  return Object.assign(new Error(message || code), { code });
}

/** 条目名是否安全（相对路径、无穿越）。 */
export function isSafeEntryName(name) {
  const s = String(name || '');
  if (!s) return false;
  if (s.includes('\0')) return false;
  const norm = s.replace(/\\/g, '/');
  if (norm.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(norm)) return false;
  if (norm.split('/').some((part) => part === '..')) return false;
  return true;
}

/**
 * 解析并解压一个 zip（缓冲）。
 *
 * @param {Buffer} buf
 * @param {{
 *   maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number, maxRatio?: number,
 *   entryPolicy?: 'reject' | 'skip',
 *   extraEntryFilter?: ((name: string) => boolean) | null,
 * }} [options]
 *   `entryPolicy`：遇到不安全条目时整包拒绝（默认，适合"外部下载的包"）还是跳过
 *   （适合"我们自己的包，只想收白名单形态"）。`extraEntryFilter` 是调用方追加的形状白名单。
 * @returns {{ entries: { name: string, data: Buffer, isDir: boolean }[], skipped: string[] }}
 */
export function readZipEntries(buf, options = {}) {
  const lim = { ...ZIP_LIMITS, ...options };
  const policy = lim.entryPolicy === 'skip' ? 'skip' : 'reject';
  const extra = typeof lim.extraEntryFilter === 'function' ? lim.extraEntryFilter : null;

  if (!Buffer.isBuffer(buf) || buf.length < 22) throw fail('not-a-zip', 'not a zip');
  const magic = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
  // 本地文件头 'PK\x03\x04'；空包 'PK\x05\x06'。
  if (magic !== 0x04034b50 && magic !== 0x06054b50) throw fail('not-a-zip', 'not a zip');

  // EOCD 在文件尾 22 字节起，最多带 64KB 注释。
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw fail('not-a-zip', 'no EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > lim.maxEntries) throw fail('too-large', 'too many entries: ' + count);
  if (cdOffset + cdSize > buf.length) throw fail('bad-central', 'central directory out of range');

  const entries = [];
  const skipped = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fail('bad-central', 'bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (!isSafeEntryName(name)) {
      if (policy === 'reject') throw fail('unsafe-entry', 'unsafe entry: ' + name);
      skipped.push(name);
      continue;
    }
    if (extra && !extra(name)) { skipped.push(name); continue; }
    if (name.endsWith('/')) { entries.push({ name, data: Buffer.alloc(0), isDir: true }); continue; }
    if (uncompSize > lim.maxEntryBytes) {
      if (policy === 'reject') throw fail('too-large', 'entry too large: ' + name);
      skipped.push(name);
      continue;
    }
    total += uncompSize;
    if (total > lim.maxTotalBytes) throw fail('too-large', 'archive too large');

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw fail('bad-central', 'bad local header for ' + name);
    }
    // 本地头里的名字/额外字段长度**可能**与中央目录不同 ⇒ 数据起点按本地头算。
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw fail('bad-entry', 'truncated data for ' + name);
    const raw = buf.subarray(dataStart, dataEnd);

    let data;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      if (compSize > 0 && uncompSize / compSize > lim.maxRatio) {
        throw fail('too-large', 'suspicious compression ratio: ' + name);
      }
      try {
        data = inflateRawSync(raw);
      } catch {
        if (policy === 'reject') throw fail('bad-entry', 'inflate failed for ' + name);
        skipped.push(name);
        continue;
      }
      if (data.length > lim.maxEntryBytes) throw fail('too-large', 'entry too large after inflate: ' + name);
    } else {
      if (policy === 'reject') throw fail('bad-entry', 'unsupported method ' + method + ' for ' + name);
      skipped.push(name);
      continue;
    }
    entries.push({ name, data, isDir: false });
  }
  return { entries, skipped };
}
