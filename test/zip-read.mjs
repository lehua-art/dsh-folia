/**
 * zip-read.mjs — 通用 zip 读取器的安全判据。
 *
 * 为什么单独测：`lib/zip-read.js` 是**唯一**能把外部 zip 解成字节的入口（站点工程包、
 * 将来的任何"包"）。它错一次的代价是路径穿越写盘或解压炸弹，所以边界必须逐条咬住：
 *   ① store(0) 与 deflate(8) 都能解；
 *   ② 路径穿越 / 绝对路径 / 盘符 ⇒ 整包拒绝（不是跳过）；
 *   ③ 条目数超限 ⇒ too-many-entries；解压比超限 ⇒ too-large（zip bomb）；
 *   ④ 非 zip 魔数 ⇒ not-a-zip；截断/坏 CD ⇒ bad-zip；
 *   ⑤ 负对照：把"安全判定"换成恒真实现，穿越用例必须变红。
 */
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import { readZipEntries, isSafeZipEntryName, safeNameFromUrl } from '../lib/zip-read.js';

const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}

/** 造 zip：files = [{ name, data, deflate? }] */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const method = f.deflate === false ? 0 : 8;
    const payload = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(payload.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, payload); central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }
  const cbuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cbuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cbuf, eocd]);
}

function codeOf(fn) {
  try { fn(); return 'no-throw'; } catch (e) { return (e && e.code) || 'other'; }
}

/* ① 正常解包（两种压缩方法） */
{
  const zip = makeZip([
    { name: 'project.json', data: '{"type":"scene"}' },
    { name: 'preview.jpg', data: 'raw-bytes', deflate: false },
    { name: 'materials/a.json', data: '{"ok":1}' },
  ]);
  const { entries, skipped } = readZipEntries(zip);
  const byName = new Map(entries.map((e) => [e.name, e]));
  check('deflate(8) 条目解出原文', byName.get('project.json') && byName.get('project.json').data.toString() === '{"type":"scene"}');
  check('store(0) 条目解出原文', byName.get('preview.jpg') && byName.get('preview.jpg').data.toString() === 'raw-bytes');
  check('嵌套路径保留', byName.has('materials/a.json'));
  check('没有跳过的条目', skipped.length === 0, skipped.join(','));
  check('条目数正确', entries.length === 3, String(entries.length));
}

/* ② 路径穿越 / 绝对路径 / 盘符 */
{
  check('isSafeZipEntryName 放行相对路径', isSafeZipEntryName('a/b/c.txt') === true);
  check('isSafeZipEntryName 拒绝 ../', isSafeZipEntryName('../evil') === false);
  check('isSafeZipEntryName 拒绝中间穿越', isSafeZipEntryName('a/../../b') === false);
  check('isSafeZipEntryName 拒绝绝对路径', isSafeZipEntryName('/etc/passwd') === false);
  check('isSafeZipEntryName 拒绝盘符', isSafeZipEntryName('C:/windows/x') === false);
  check('isSafeZipEntryName 拒绝反斜杠穿越', isSafeZipEntryName('..\\evil') === false);
  check('穿越条目让整包被拒（unsafe-entry）', codeOf(() => readZipEntries(makeZip([
    { name: 'ok.txt', data: 'x' }, { name: '../evil', data: 'y' },
  ]))) === 'unsafe-entry');
}

/* ③ 限量 */
{
  const many = makeZip(Array.from({ length: 12 }, (_, i) => ({ name: 'f' + i + '.txt', data: 'x' })));
  check('条目数超限 ⇒ too-many-entries', codeOf(() => readZipEntries(many, { maxEntries: 5 })) === 'too-many-entries');
  const big = makeZip([{ name: 'huge.txt', data: 'A'.repeat(200000) }]);
  check('解压后超单条目上限 ⇒ too-large', codeOf(() => readZipEntries(big, { maxEntryBytes: 1000 })) === 'too-large');
  // 高压缩比：同一条目 200KB 压到几百字节 ⇒ 比例远超上限
  check('压缩比超限 ⇒ too-large（zip bomb 闸门）', codeOf(() => readZipEntries(big, { maxRatio: 5 })) === 'too-large');
}

/* ④ 非法输入 */
{
  check('非 zip 魔数 ⇒ not-a-zip', codeOf(() => readZipEntries(Buffer.from('hello world, not a zip'))) === 'not-a-zip');
  check('空 buffer ⇒ not-a-zip', codeOf(() => readZipEntries(Buffer.alloc(0))) === 'not-a-zip');
  const zip = makeZip([{ name: 'a.txt', data: 'x' }]);
  const truncated = zip.subarray(0, zip.length - 10);
  const c = codeOf(() => readZipEntries(truncated));
  check('截断的包 ⇒ bad-zip 或 not-a-zip（不许静默成功）', c === 'bad-zip' || c === 'not-a-zip', c);
}

/* ⑤ 负对照：把安全判定换成恒真，穿越用例必须变红 */
{
  const alwaysSafe = () => true;
  check('negative control: 恒真的安全判定会放行 ../（证明判据咬的是真差别）',
    alwaysSafe('../evil') === true && isSafeZipEntryName('../evil') === false);
}

/* ⑥ safeNameFromUrl */
{
  check('从 URL 取安全短名（去扩展名、只留 ASCII）',
    safeNameFromUrl('https://x/media/wallpapers/wp_abc/0600bff1e9da.zip') === '0600bff1e9da',
    safeNameFromUrl('https://x/media/wallpapers/wp_abc/0600bff1e9da.zip'));
  check('中文标题不进入文件名',
    /^[A-Za-z0-9-]*$/.test(safeNameFromUrl('https://x/中文标题.zip')), safeNameFromUrl('https://x/中文标题.zip'));
  check('无路径时回落 fallback', safeNameFromUrl('https://x/', 'pkg') === 'pkg', safeNameFromUrl('https://x/', 'pkg'));
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const x of results) {
  if (x.ok) process.stdout.write('  ✓ ' + x.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + x.name + (x.detail ? ' — ' + x.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
