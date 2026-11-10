/**
 * verify-ctx-access.mjs — G2：`ctx.<服务名>` 直读的静态扫描。
 *
 * 事故（docs/POSTMORTEM-LOAD-CRASH.md）：`lib/index.js` 里写了 `ctx.speechToText`，
 * 但 `speechToText` 不在 `export const inject` 里 ⇒ cordis 直接抛
 * "cannot get property … without inject" ⇒ **整个插件加载失败**，用户连界面都进不去。
 *
 * 规则：
 *   · 只有声明了 `inject` 的文件（以及根入口 lib/index.js）才受检；
 *   · 受检文件里出现的 `ctx.<name>` 直读，`name` 必须在**该文件**的 inject 里；
 *   · 框架属性白名单（不是服务）：`get` / `effect` / `on` / `logger`；
 *   · 否则必须写成 `ctx.get('<name>')`。
 *
 * 负例自检：把 `ctx.get('speechToText')` 改回 `ctx.speechToText` 必须变红 —— 由
 * `checkViolations()` 的纯函数负例覆盖（不依赖真的改仓库文件）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib');

/** 框架属性：它们不是"服务"，直读合法（cordis 的 Context 上本来就有）。 */
const FRAMEWORK_WHITELIST = new Set(['get', 'effect', 'on', 'logger']);

/** 生成的文件不扫（≈5.6MB 的打包产物）。 */
const SKIP_FILES = new Set(['lib/client.js']);

const results = [];
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); }

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 纯函数：给定源码，返回违规列表。
 * @param {string} source
 * @param {{injects: string[], checked: boolean}} options
 * @returns {{name: string, index: number}[]}
 */
export function checkViolations(source, { injects = [], checked = false } = {}) {
  if (!checked) return [];
  const declared = new Set(injects);
  const out = [];
  const pattern = /\bctx\.([A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (FRAMEWORK_WHITELIST.has(name)) continue;
    if (declared.has(name)) continue;
    out.push({ name, index: match.index });
  }
  return out;
}

/** 去掉注释（注释里也常出现 `export const inject = [...]` 这种示例，会把解析带偏）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 解析文件里的 inject 声明（兼容多行与空格；多个声明取并集）。 */
export function parseInject(rawSource) {
  const source = stripComments(rawSource);
  const found = new Set();
  for (const match of source.matchAll(/(?:export\s+)?const\s+inject\s*=\s*\[([\s\S]*?)\]/g)) {
    for (const item of match[1].matchAll(/'([^']+)'/g)) found.add(item[1]);
  }
  return [...found];
}

/* ① 仓库现状：0 违规 */
{
  const violations = [];
  for (const file of walk(LIB)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (SKIP_FILES.has(rel)) continue;
    const source = readFileSync(file, 'utf8');
    const injects = parseInject(source);
    // 只有声明了 inject 的文件、以及根入口才受检：
    // 组件文件（没有 inject）拿到的 ctx 来自父级，父级已经声明过了。
    const checked = injects.length > 0 || rel === 'lib/index.js';
    // 注释里出现 `ctx.xxx` 只是说明文字，不参与判定
    for (const item of checkViolations(stripComments(source), { injects, checked })) {
      violations.push(`${rel}: ctx.${item.name}`);
    }
  }
  check('① lib/** 无 ctx.<服务> 直读（0 违规）', violations.length === 0,
    violations.length ? violations.slice(0, 8).join(' · ') : '0 违规');
}

/* ② 负例自检：把 ctx.get('speechToText') 改回 ctx.speechToText 必须变红 */
{
  const broken = "speechToText: ctx.speechToText,";
  const fixed = "speechToText: ctx.get('speechToText'),";
  const bad = checkViolations(broken, { injects: ['webServer'], checked: true });
  const good = checkViolations(fixed, { injects: ['webServer'], checked: true });
  check('② 负例：ctx.speechToText ⇒ 报违规；ctx.get(...) ⇒ 干净',
    bad.length === 1 && bad[0].name === 'speechToText' && good.length === 0,
    `坏样本=${bad.map((item) => item.name).join(',') || '无'} · 好样本=${good.length}`);
}

/* ③ 已声明 inject 的服务直读不算违规（避免把正常代码判红） */
{
  const source = "const routes = ctx.wallpaperEngineHost; ctx.effect(() => {}); ctx.logger.info('x');";
  const clean = checkViolations(source, { injects: ['wallpaperEngineHost'], checked: true });
  check('③ 已在 inject 里的服务 / 框架属性 ⇒ 不报', clean.length === 0,
    clean.map((item) => item.name).join(',') || '无违规');
}

/* ④ 未声明 inject 的文件不误伤（组件文件由父级声明） */
{
  const source = 'const host = ctx.wallpaperEngineHost;';
  const skipped = checkViolations(source, { injects: [], checked: false });
  check('④ 无 inject 声明的文件不参与扫描', skipped.length === 0, skipped.length ? '误报' : '按规则跳过');
}

/* ⑤ inject 解析能吃到多行/带空格的声明 */
{
  const source = "export const inject = ['webServer', 'wallpaperEngineHost'];";
  const parsed = parseInject(source);
  check('⑤ inject 解析：多服务声明都能读到',
    parsed.length === 2 && parsed.includes('webServer') && parsed.includes('wallpaperEngineHost'),
    parsed.join(','));
}

/* 汇总 */
let failed = 0;
for (const item of results) {
  if (item.ok) process.stdout.write(`  ✓ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`);
  else { failed += 1; process.stdout.write(`  ✗ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`); }
}
process.stdout.write(`\n  ${results.length - failed} 通过 / ${failed} 失败\n`);
if (failed) process.exit(1);
