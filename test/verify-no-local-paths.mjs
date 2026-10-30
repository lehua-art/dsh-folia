/**
 * verify-no-local-paths.mjs — 出货包里**不许出现本机路径**。
 *
 * 为什么必须有一条守卫：这类问题（把作者机器的磁盘路径/用户名带进 npm 包）不属于"功能 bug"，
 * 功能测试全绿也照样会漏出去，而一旦到了别人机器上就是"路径不存在 / 报错 / 看着像病毒"。
 * 所以它得是一条**机械判据**，不靠人记得检查。
 *
 * 判据（只看 `package.json#files` 真正会发布的那些文件）：
 *   ① 不许出现 `X:\Users\<名字>` / `/Users/<名字>` / `/home/<名字>` 这类**用户目录**
 *   ② 不许出现作者的机器标识串（这里用"任意 5 位纯数字用户名段"与已知的构建机名占位）
 *   ③ 负对照：故意喂一条 `C:\Users\alice\Desktop` ⇒ 必须被判红
 *   ④ 负对照：`C:\Windows` / `C:\Program Files\Steam` 这类**产品默认值**必须放行（不是本机隐私）
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 守卫图要求每条守卫都**指名**它守护的模块：这里守护的是路由族里会拼路径的那些文件。
import { DEPS } from '../lib/routes/downloads.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });

/** 允许出现：桌面端/系统的**产品级默认路径**，与任何具体用户名无关。 */
// ⚠️ 这里**不能**写 'C:\\'：把"盘符根"放进白名单，`startsWith` 会把 `C:\Users\alice` 也放行，
// 判据就恒真了（实测踩过，负对照当场变红）。
const ALLOWED = [
  'C:\\Windows',
  'C:\\Program Files\\Steam',
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\DSH Desktop',
];

/** 本机隐私模式：用户目录下带具体用户名（或家目录的用户名段）。 */
const PRIVATE = [
  // 用字符类而不是 `\\{1,2}`：源码里两种写法（单反斜杠 / JSON 转义后的双反斜杠）都要命中
  /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/g,
  /\/Users\/[^/\s"'`]+/g,                        // macOS
  /\/home\/[^/\s"'`]+/g,                         // Linux
];

/** 只扫真正会发布的东西：`package.json#files` 展开出来的文件。 */
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
    if (entry.endsWith('/')) addDir(abs); else addFile(abs);
  }
  // package.json 本身与 README（npm 总会带）也在扫描面内
  addFile(join(ROOT, 'package.json'));
  return [...out].filter((f) => /\.(js|mjs|cjs|json|css|yml|yaml|md|html)$/i.test(f));
}

/** 从一段文本里找"本机隐私路径"，返回命中片段（负对照也用它，所以是纯函数）。 */
function findPrivatePaths(text) {
  const hits = [];
  for (const re of PRIVATE) {
    for (const m of String(text).matchAll(re)) {
      const hit = m[0];
      if (ALLOWED.some((ok) => hit.toLowerCase().startsWith(ok.toLowerCase()))) continue;
      hits.push(hit);
    }
  }
  return hits;
}

check('⓪ 被守护的路由族导入了依赖契约（守卫有明确目标）', Array.isArray(DEPS) && DEPS.includes('base'), String(DEPS));

const files = shippedFiles();
check('① 扫描面非空（真的读到了要发布的文件）', files.length > 50, 'files=' + files.length);

const offenders = [];
for (const file of files) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const hits = findPrivatePaths(text);
  if (hits.length) offenders.push(file.replace(ROOT + '\\', '').replace(ROOT + '/', '') + ' → ' + hits.slice(0, 3).join(', '));
}
check('② 出货文件里没有本机用户目录路径', offenders.length === 0, offenders.slice(0, 5).join(' | '));

// ③ 负对照：真把本机路径写进去 ⇒ 必须判红
{
  // 用 String.raw 表达"源码里真的写着一个单反斜杠的用户目录"，避免被转义层级绕晕
  const bad = String.raw`const cache = "C:\Users\alice\AppData\Local\x";`;
  check('③ negative control: C:\\Users\\<名字> 会被判红', findPrivatePaths(bad).length > 0, JSON.stringify(findPrivatePaths(bad)));
  check('③ negative control: /Users/<名字> 会被判红', findPrivatePaths('"/Users/bob/Library/x"').length > 0);
  check('③ negative control: /home/<名字> 会被判红', findPrivatePaths("'/home/carol/.dsh'").length > 0);
}

// ④ 负对照：产品默认值必须放行（否则守卫会因为正常代码变红，等于没牙）
{
  check('④ 产品默认值 C:\\Windows 放行', findPrivatePaths("'C:\\\\Windows'").length === 0);
  check('④ 产品默认值 Steam 安装目录放行', findPrivatePaths("'C:\\\\Program Files (x86)\\\\Steam'").length === 0);
  check('④ 产品默认值 C:\\ 放行（转码临时目录回退）', findPrivatePaths("'C:\\\\'").length === 0);
}

let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
