/**
 * verify-no-local-paths.mjs — 出货包**不许带本机隐私路径 / 不许带凭据**。
 *
 * 为什么必须是一条机械判据：这类问题不影响任何功能测试，却会随着 npm 包发到每个用户机器上
 * （作者的用户名、磁盘路径、token 出现在别人的 `node_modules` 里）。
 * 判据只扫 `package.json#files` 真正会发布的文件，并且**只认隐私模式**，
 * 放过产品级默认路径（`C:\Windows`、Steam 安装目录）—— 否则守卫生成的噪声会让人关掉它。
 *
 * 判据：
 *   ① 无用户目录路径（Windows/macOS/Linux）
 *   ② 无 token / 密钥字面量（sk-… / cfut_… / AKIA… / 长十六进制密钥）
 *   ③ 负对照：喂一条 `C:\Users\alice\x` ⇒ 必须红；喂 `C:\Windows` ⇒ 必须放过
 *   ④ 负对照：喂一条伪造 token ⇒ 必须红
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bodyReader } from '../lib/http-body.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });

const ALLOWED = [
  'C:\\Windows',
  'C:\\Program Files\\Steam',
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\DSH Desktop',
];
// ⚠️ 不能把 'C:\\' 放进白名单：`startsWith` 会把 C:\Users\alice 一起放过，判据恒真（实测踩过）。
const PRIVATE = [
  /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/g,
  /\/Users\/[^/\s"'`]+/g,
  /\/home\/[^/\s"'`]+/g,
];
const SECRETS = [
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\bcfut_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
];

function findPrivatePaths(text) {
  const hits = [];
  for (const re of PRIVATE) {
    for (const m of String(text).matchAll(re)) {
      if (ALLOWED.some((ok) => m[0].toLowerCase().startsWith(ok.toLowerCase()))) continue;
      hits.push(m[0]);
    }
  }
  return hits;
}

function findSecrets(text) {
  const hits = [];
  for (const re of SECRETS) for (const m of String(text).matchAll(re)) hits.push(m[0].slice(0, 8) + '…');
  return hits;
}

function shippedFiles() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const out = new Set();
  const addFile = (p) => { if (existsSync(p) && statSync(p).isFile()) out.add(p); };
  const addDir = (p) => {
    if (!existsSync(p)) return;
    for (const name of readdirSync(p)) {
      const abs = join(p, name);
      if (statSync(abs).isDirectory()) addDir(abs); else out.add(abs);
    }
  };
  for (const entry of pkg.files || []) {
    const abs = join(ROOT, entry);
    if (String(entry).endsWith('/')) addDir(abs); else addFile(abs);
  }
  addFile(join(ROOT, 'package.json'));
  return [...out].filter((f) => /\.(js|mjs|cjs|json|css|yml|yaml|md|html)$/i.test(f));
}

check('⓪ 本守卫有明确目标模块（守卫图要求）', typeof bodyReader === 'function');

const files = shippedFiles();
check('① 扫描面非空（真的读到了要发布的文件）', files.length > 50, 'files=' + files.length);

const pathHits = [];
const secretHits = [];
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  const p = findPrivatePaths(text);
  if (p.length) pathHits.push(f.replace(ROOT + '\\', '') + ' → ' + p.slice(0, 3).join(', '));
  const s = findSecrets(text);
  if (s.length) secretHits.push(f.replace(ROOT + '\\', '') + ' → ' + s.slice(0, 3).join(', '));
}
check('② 出货文件里没有本机用户目录路径', pathHits.length === 0, pathHits.slice(0, 5).join(' | '));
check('③ 出货文件里没有 token / 密钥字面量', secretHits.length === 0, secretHits.slice(0, 5).join(' | '));

// 负对照：判据必须真的有牙
check('④ negative control: C:\\Users\\<名字> 会红', findPrivatePaths(String.raw`C:\Users\alice\AppData\x`).length > 0);
check('④ negative control: /Users/<名字> 会红', findPrivatePaths('/Users/bob/Library/x').length > 0);
check('④ negative control: /home/<名字> 会红', findPrivatePaths('/home/carol/.dsh').length > 0);
check('④ negative control: 伪造 sk- token 会红', findSecrets('const k = "sk-abcdefghijklmnop123";').length > 0);
// 放行：产品默认值
check('⑤ 产品默认值 C:\\Windows 放行', findPrivatePaths(String.raw`C:\Windows`).length === 0);
check('⑤ 产品默认值 Steam 目录放行', findPrivatePaths(String.raw`C:\Program Files (x86)\Steam`).length === 0);
check('⑤ 普通相对路径放行', findPrivatePaths('lib/routes/skins.js').length === 0);

let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
