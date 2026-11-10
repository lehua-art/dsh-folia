#!/usr/bin/env node
/**
 * convert-dm-pet.mjs — 把 DM Market 的桌宠原始包转成 folia 后台可上传的 zip。
 *
 * 只做**一只**、只做**转换**，不做批量（工单要求先验证链路）。
 *
 * 用法：
 *   node tools/convert-dm-pet.mjs --src <原始包目录> --out <输出.zip> [--preview <图>] [--keep-author]
 *
 * 原始包目录里认两种布局：
 *   · pet.json + spritesheet.webp           （平铺）
 *   · files/pet.json + spritesheet.webp     （我们下载器的布局）
 *
 * 输出必须能过站点 `parsePetPackage`（folia-admin/src/server/pet-package.js）：
 *   petManifestVersion=2 · renderer=sprite2d · sprite2d.spritesheetPath 指向包内图
 *   · sprite2d.frames 非空 · sprite2d.tracks 含 idle · previews/ 至少 1 张图
 *
 * 不做的事：不改 author / license（原样写入；缺了就保持缺），不压缩（zip store，
 * 避免依赖第三方库），不做多只循环。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
// ROOT = <workspace>/.tools/dsh-folia-main ⇒ 站点仓在 <workspace>/folia-admin
const SITE_PKG = join(ROOT, '..', '..', 'folia-admin', 'src', 'server', 'pet-package.js');

// ── 参数 ────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const SRC = resolve(argOf('src', '.'));
const OUT = resolve(argOf('out', join(SRC, `${basename(SRC)}.zip`)));
const PREVIEW_ARG = argOf('preview', null);
const DRY = args.includes('--dry');

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// ── 1. 读原始包 ────────────────────────────────────────────────────────────────
function readSource() {
  const candidates = [join(SRC, 'pet.json'), join(SRC, 'files', 'pet.json')];
  const manifestPath = candidates.find((path) => existsSync(path));
  if (!manifestPath) fail(`找不到 pet.json（试过 ${candidates.join(' / ')}）`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  const sheetRel = manifest?.sprite2d?.spritesheetPath;
  if (!sheetRel) fail('pet.json 没有 sprite2d.spritesheetPath');
  const sheetCandidates = [join(SRC, sheetRel), join(SRC, basename(sheetRel)), join(SRC, 'files', basename(sheetRel))];
  const sheetPath = sheetCandidates.find((path) => existsSync(path));
  if (!sheetPath) fail(`找不到雪碧图 ${sheetRel}（试过 ${sheetCandidates.join(' / ')}）`);
  return { manifest, sheetPath, sheetName: basename(sheetRel) };
}

// ── 2. 补全 sprite2d 几何（原包常缺 cell / columns） ─────────────────────────────
function findFfmpeg() {
  const env = process.env.DSH_FOLIA_FFMPEG;
  if (env && existsSync(env)) return env;
  const local = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh-folia', 'ffmpeg', 'ffmpeg.exe');
  if (existsSync(local)) return local;
  return 'ffmpeg';
}

function probeSize(ffmpeg, imagePath) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', imagePath], { encoding: 'utf8' });
  const text = `${result.stderr || ''}${result.stdout || ''}`;
  const match = text.match(/,\s(\d{2,5})x(\d{2,5})[\s,]/);
  if (!match) fail(`拿不到雪碧图尺寸：${text.split('\n').slice(0, 3).join(' | ')}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function deriveGeometry(manifest, ffmpeg, sheetPath) {
  const sprite = manifest.sprite2d;
  const frames = Array.isArray(sprite.frames) ? sprite.frames : [];
  if (!frames.length) fail('sprite2d.frames 为空');
  const rows = frames.length;
  const { width, height } = probeSize(ffmpeg, sheetPath);
  if (height % rows !== 0) fail(`雪碧图高 ${height} 不能被行数 ${rows} 整除`);
  const cellHeight = height / rows;
  // 列数：原包没写就按最大帧数推（帧数不能超过列数）
  const columns = Number(sprite.columns) > 0 ? Number(sprite.columns) : Math.max(...frames);
  if (width % columns !== 0) fail(`雪碧图宽 ${width} 不能被列数 ${columns} 整除（frames 最大值=${Math.max(...frames)}）`);
  const cellWidth = width / columns;
  return { columns, cell: { width: cellWidth, height: cellHeight }, rows };
}

// ── 3. 预览图：优先用现有图，缺了就抠第一帧 ─────────────────────────────────────
function ensurePreview(ffmpeg, sheetPath, geometry, outDir) {
  const previewDir = join(outDir, 'previews');
  mkdirSync(previewDir, { recursive: true });

  const existing = PREVIEW_ARG
    ? [resolve(PREVIEW_ARG)]
    : [
      join(SRC, 'previews'),
      join(SRC, 'preview-idle.gif'),
      join(SRC, 'preview.gif'),
      join(SRC, 'preview.webp'),
    ].flatMap((candidate) => {
      if (!existsSync(candidate)) return [];
      return statSync(candidate).isDirectory()
        ? readdirSync(candidate).filter((name) => /\.(gif|webp|png|jpe?g)$/i.test(name)).map((name) => join(candidate, name))
        : [candidate];
    });
  const source = existing[0];
  if (source) {
    const target = join(previewDir, `idle${extname(source).toLowerCase()}`);
    writeFileSync(target, readFileSync(source));
    return { path: target, source: 'copied', from: source };
  }

  // 缺预览：从雪碧图抠第一帧（左上角 cell）
  const target = join(previewDir, 'idle.webp');
  const filter = `crop=${geometry.cell.width}:${geometry.cell.height}:0:0`;
  const result = spawnSync(ffmpeg, ['-hide_banner', '-y', '-i', sheetPath, '-vf', filter, '-frames:v', '1', target], { encoding: 'utf8' });
  if (!existsSync(target) || !statSync(target).size) {
    fail(`生成预览失败：${(result.stderr || '').split('\n').slice(-3).join(' | ')}`);
  }
  return { path: target, source: 'cropped', from: `${geometry.cell.width}x${geometry.cell.height}@0,0` };
}

// ── 4. 手写 zip（store，无第三方依赖） ──────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12); // time/date 置零 ⇒ 可复现
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

// ── 5. 自检：用站点真实现跑一遍 parsePetPackage ────────────────────────────────
async function selfCheck(zipBytes) {
  if (!existsSync(SITE_PKG)) return { skipped: true, reason: `找不到站点校验器 ${SITE_PKG}` };
  const { parsePetPackage } = await import(`file://${SITE_PKG.replace(/\\/g, '/')}`);
  return parsePetPackage(new Uint8Array(zipBytes));
}

// ── main ──────────────────────────────────────────────────────────────────────
const { manifest, sheetPath, sheetName } = readSource();
if (manifest.petManifestVersion !== 2) fail(`petManifestVersion 必须是 2（当前 ${manifest.petManifestVersion}）`);
if (manifest.renderer !== 'sprite2d') fail(`只支持 renderer=sprite2d（当前 ${manifest.renderer}）`);

const ffmpeg = findFfmpeg();
const geometry = deriveGeometry(manifest, ffmpeg, sheetPath);

// 组装输出 manifest：保留原字段，只补 geometry（不改 author/license）
const outManifest = JSON.parse(JSON.stringify(manifest));
outManifest.sprite2d = {
  ...outManifest.sprite2d,
  spritesheetPath: sheetName,
  cell: outManifest.sprite2d.cell || geometry.cell,
  columns: Number(outManifest.sprite2d.columns) > 0 ? outManifest.sprite2d.columns : geometry.columns,
  frames: outManifest.sprite2d.frames,
  tracks: outManifest.sprite2d.tracks,
};

const preview = ensurePreview(ffmpeg, sheetPath, geometry, SRC);
const sheetBytes = readFileSync(sheetPath);
const manifestBytes = Buffer.from(`${JSON.stringify(outManifest, null, 2)}\n`, 'utf8');
const previewBytes = readFileSync(preview.path);

const entries = [
  { name: 'pet.json', data: manifestBytes },
  { name: sheetName, data: sheetBytes },
  { name: `previews/${basename(preview.path)}`, data: previewBytes },
];
const zip = buildZip(entries);

if (!DRY) writeFileSync(OUT, zip);
const sha256 = createHash('sha256').update(zip).digest('hex');

const check = await selfCheck(zip);
const tracks = Object.keys(outManifest.sprite2d.tracks || {});

console.log('\n=== 转换报告 ===');
console.log(`源目录      ${SRC}`);
console.log(`输出        ${DRY ? '(dry-run，未写盘)' : OUT}`);
console.log(`id          ${outManifest.id}`);
console.log(`名称        ${outManifest.displayName}`);
console.log(`作者        ${outManifest.author || '（原包未提供）'}`);
console.log(`许可        ${outManifest.license || '（原包未提供 —— 不可进公开库）'}`);
console.log(`帧数        ${outManifest.sprite2d.frames.length} 行 · ${JSON.stringify(outManifest.sprite2d.frames)}`);
console.log(`列数 / 格   ${outManifest.sprite2d.columns} 列 · ${geometry.cell.width}x${geometry.cell.height}`);
console.log(`轨道 ${tracks.length} 个  ${tracks.join(' / ')}`);
console.log(`预览        ${preview.source}（来自 ${preview.from}）`);
console.log(`包内文件    ${entries.map((entry) => `${entry.name} ${entry.data.length}B`).join(' · ')}`);
console.log(`zip 体积    ${(zip.length / 1048576).toFixed(2)} MB`);
console.log(`sha256      ${sha256}`);
console.log('站点校验    ' + (check.skipped ? `跳过（${check.reason}）` : check.ok
  ? `PASS · preview=${check.preview.name}(${check.preview.mime} ${check.preview.width}x${check.preview.height}) · 预览 ${check.previewCount} 张`
  : `FAIL · ${check.reason}`));

if (!check.skipped && !check.ok) process.exit(2);
