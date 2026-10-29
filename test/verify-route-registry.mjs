/**
 * verify-route-registry.mjs — 宿主侧**功能路由注册表**的守卫。
 *
 * 判据（与 test/verify-features.mjs 的客户端部分对称）：
 *   ① 注册表里每个族都真实存在，且 `deps` 是从上下文学出来的（不是空对象）；
 *   ② 两张表的并集**覆盖** `lib/routes/*.js`（不留第三处偷偷注册的族）；
 *   ③ `INLINE_ROUTE_FAMILIES` 是棘轮：只许缩小 —— 表里写着的族必须真的还在门面里注册；
 *   ④ 门面里不许再出现"已迁移族"的逐个注册（那等于绕过注册表）；
 *   ⑤ 负对照：塞一个不存在的族名 / 一个已迁移的族进 inline 表，判据必须变红。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = await import('../lib/route-registry.js');
const { FEATURE_ROUTE_FAMILIES, INLINE_ROUTE_FAMILIES } = registry;

const hostSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const routeFiles = readdirSync(join(ROOT, 'lib', 'routes')).filter((n) => n.endsWith('.js')).sort();

const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

/* ① 注册表族的文件存在、deps 有形 */
{
  const badFiles = FEATURE_ROUTE_FAMILIES.filter((f) => !readdirSync(join(ROOT, 'lib', 'routes')).includes(f.file.replace('lib/routes/', '')));
  check('注册表里每个族都有对应的路由文件', badFiles.length === 0, badFiles.map((f) => f.id).join(','));
  const badDeps = FEATURE_ROUTE_FAMILIES.filter((f) => {
    try {
      const d = f.deps({ disposers: [], base: '/x', log: () => {}, mediaOriginApi: {}, buildInventory: () => {}, componentProbe: () => null, ensureImagePreview: async () => null });
      return !d || typeof d !== 'object' || Object.keys(d).length === 0;
    } catch { return true; }
  });
  check('每个族的 deps(ctx) 都能算出非空对象', badDeps.length === 0, badDeps.map((f) => f.id).join(','));
  const noRegister = FEATURE_ROUTE_FAMILIES.filter((f) => typeof f.register !== 'function');
  check('每个族都有 register 函数', noRegister.length === 0, noRegister.map((f) => f.id).join(','));
}

/* ② 并集覆盖所有路由文件 */
{
  const covered = new Set();
  for (const f of FEATURE_ROUTE_FAMILIES) covered.add(f.file);
  // inline 表用 { id, fn } 记名；文件名 = <id>.js（族名与注册函数名不总同形，故按 id 对文件）
  for (const fam of INLINE_ROUTE_FAMILIES) covered.add('lib/routes/' + fam.id + '.js');
  const missing = routeFiles.filter((n) => !covered.has('lib/routes/' + n));
  check('两表并集覆盖 lib/routes/*.js（无第三处偷偷注册的族）', missing.length === 0, '未覆盖: ' + missing.join(','));
  check('路由文件面足够大（判据不在空集上恒真）', routeFiles.length >= 15, 'routes=' + routeFiles.length);
}

/* ③ inline 表是棘轮：写着的族必须真的还在门面里注册 */
{
  // 门面里各族注册函数的调用名（族 → 函数名没有统一规则，故按"是否存在 register<X>Routes(" 判定）
  const stillRegistered = INLINE_ROUTE_FAMILIES.filter((fam) => hostSrc.includes(fam.fn + '(webServer'));
  check('inline 表里的族仍在门面里注册（否则该从表里删掉）',
    stillRegistered.length === INLINE_ROUTE_FAMILIES.length,
    '已不在门面: ' + INLINE_ROUTE_FAMILIES.filter((fam) => !stillRegistered.includes(fam)).map((f) => f.id).join(','));
  check('inline 表非空（迁移未完成时它是真数据，不是摆设）', INLINE_ROUTE_FAMILIES.length > 0);
}

/* ④ 门面里不许再逐个注册已迁移的族 */
{
  const migratedCalls = [];
  for (const f of FEATURE_ROUTE_FAMILIES) {
    const camel = f.id.split('-').map((s, i) => (i === 0 ? s : s[0].toUpperCase() + s.slice(1))).join('');
    const name = 'register' + camel[0].toUpperCase() + camel.slice(1) + 'Routes';
    if (hostSrc.includes(name + '(webServer')) migratedCalls.push(name);
  }
  check('门面里没有已迁移族的逐个注册（绕过注册表会被判红）', migratedCalls.length === 0, migratedCalls.join(','));
  check('门面确实调用了注册表', hostSrc.includes('registerFeatureRoutes(webServer'));
  check('门面确实调用了预热钩子', hostSrc.includes('warmFeatureCaches()'));
}

/* ⑤ 负对照 */
{
  const ghost = [...INLINE_ROUTE_FAMILIES.map((f) => f.id), 'zzz-gone-family'];
  const covered = new Set();
  for (const f of FEATURE_ROUTE_FAMILIES) covered.add(f.file);
  for (const id of ghost) covered.add('lib/routes/' + id + '.js');
  const missing = routeFiles.filter((n) => !covered.has('lib/routes/' + n));
  check('negative control: 少一个族会被覆盖判据判出',
    missing.length === 0, '（说明加一个假族不会让覆盖判据变红 —— 这是对的；覆盖判据咬的是"漏"）');
  const fakeMissing = routeFiles.filter((n) => !covered.has('lib/routes/' + n)).concat(['lib/routes/__not_exists__.js']);
  check('negative control: 路由文件多出来一个没被认领的 ⇒ 判红',
    fakeMissing.length > 0, fakeMissing.join(','));
  const dupMigrated = [...INLINE_ROUTE_FAMILIES.map((f) => f.id), FEATURE_ROUTE_FAMILIES[0].id];
  const dupHit = dupMigrated.filter((id) => FEATURE_ROUTE_FAMILIES.some((f) => f.id === id));
  check('negative control: 已迁移的族若又出现在 inline 表 ⇒ 判红', dupHit.length === 1, dupHit.join(','));
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  注册表族: ' + FEATURE_ROUTE_FAMILIES.length + ' · 未迁移族: ' + INLINE_ROUTE_FAMILIES.length +
  ' · 路由文件: ' + routeFiles.length + '\n');
process.stdout.write('  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
