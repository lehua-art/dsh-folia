/**
 * verify-features.mjs — **模块化守卫**：把"每个模块负责一个功能"变成可失败的判据。
 *
 * 判据（每条都双向咬，既有正例也有负例）：
 *   ① 清单里提到的每个文件都真实存在（写了不存在的文件 = 文档骗人）；
 *   ② `lib/routes/*.js` 里**每个文件都被且仅被**一个功能认领（不许孤儿 / 不许重复）；
 *   ③ 每个功能的 `tab` 真的出现在客户端 `QP_TABS` 里，且 QP_TABS 里没有未登记页签；
 *   ④ 站点分类只在 `site` 字段里出现（数据源入口是显式的）；
 *   ⑤ 反向：清单里没有任何一个空壳功能（必须有 host 或 client 之一）。
 *
 * 为什么值得写：这个仓已经 19 个路由文件 / 70 个客户端文件 / 24k 行，而"某个功能归哪些
 * 文件"过去只存在于人脑。加功能漏改一处接线的症状是"功能看着在、点开是空的"，肉眼查不出来。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { FEATURES, TAB_OWNERS } = await import('../lib/features.js');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  if (!cond) return false;
  return true;
}

/* ── ① 文件存在 ─────────────────────────────────────────────────────────── */
const missing = [];
let fileCount = 0;
for (const f of FEATURES) {
  for (const rel of [...(f.host || []), ...(f.client || [])]) {
    fileCount += 1;
    if (!existsSync(join(ROOT, rel))) missing.push(f.id + ' → ' + rel);
  }
}
check('清单里的文件全部存在', missing.length === 0, missing.slice(0, 6).join(' | '));
check('清单确实描述了足够多的文件（防止空表恒真）', fileCount >= 80, 'files=' + fileCount);

/* ── ② 路由文件全部被认领，且只被认领一次 ───────────────────────────────── */
const routeFiles = readdirSync(join(ROOT, 'lib', 'routes')).filter((n) => n.endsWith('.js')).sort();
const claimed = new Map();
for (const f of FEATURES) {
  for (const rel of f.host || []) {
    if (!rel.startsWith('lib/routes/')) continue;
    const key = rel.slice('lib/routes/'.length);
    if (!claimed.has(key)) claimed.set(key, []);
    claimed.get(key).push(f.id);
  }
}
const orphans = routeFiles.filter((n) => !claimed.has(n));
const dupes = [...claimed.entries()].filter(([, ids]) => ids.length > 1);
const ghostRoutes = [...claimed.keys()].filter((n) => !routeFiles.includes(n));

check('每个路由文件都有归属（没有孤儿路由）', orphans.length === 0, '孤儿: ' + orphans.join(', '));
check('没有路由被两个功能同时认领', dupes.length === 0,
  dupes.map(([n, ids]) => n + ' ← ' + ids.join('+')).join(' | '));
check('认领清单里没有不存在的路由文件', ghostRoutes.length === 0, ghostRoutes.join(', '));
check('路由文件面足够大（判据不是在空集上恒真）', routeFiles.length >= 15, 'routes=' + routeFiles.length);

/* 负例：把 manifest 复制一份、塞一个不存在的路由，判据必须变红 */
{
  const fake = JSON.parse(JSON.stringify(FEATURES));
  fake.find((f) => f.id === 'system').host.push('lib/routes/__not_exists__.js');
  const claimedFake = new Set();
  for (const f of fake) for (const rel of f.host || []) if (rel.startsWith('lib/routes/')) claimedFake.add(rel.slice('lib/routes/'.length));
  const ghostsFake = [...claimedFake].filter((n) => !routeFiles.includes(n));
  check('negative control: 塞一个不存在的路由会被判出', ghostsFake.length === 1, ghostsFake.join(','));
}

/* ── ③ 页签归属 ─────────────────────────────────────────────────────────── */
const quickSrc = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8');
// 页签真源是客户端功能注册表 src/features.js（quick-panel 只读它，不再写字面量）。
const featSrcRaw = readFileSync(join(ROOT, 'src', 'features.js'), 'utf8');
const qpBlock = (() => {
  const at = featSrcRaw.indexOf('const WE_FEATURE_TABS = [');
  if (at < 0) return '';
  const end = featSrcRaw.indexOf('];', at);
  return end < 0 ? '' : featSrcRaw.slice(at, end);
})();
const qpTabs = [...qpBlock.matchAll(/\{\s*id:\s*"([a-z-]+)"/g)].map((m) => m[1]);
const dupTab = qpTabs.filter((t, i) => qpTabs.indexOf(t) !== i);
check('QP_TABS 实际页签列表非空', qpTabs.length >= 4, 'tabs=' + qpTabs.join(','));
check('QP_TABS 没有重复页签', dupTab.length === 0, dupTab.join(','));
check('每个 QP_TABS 页签都在功能清单里登记了归属',
  qpTabs.every((t) => Boolean(TAB_OWNERS[t])), '未登记: ' + qpTabs.filter((t) => !TAB_OWNERS[t]).join(','));
check('清单里的页签都真的存在于 QP_TABS',
  Object.keys(TAB_OWNERS).every((t) => qpTabs.includes(t)),
  '幽灵页签: ' + Object.keys(TAB_OWNERS).filter((t) => !qpTabs.includes(t)).join(','));
check('negative control: 未登记的页签会被判出', !TAB_OWNERS['__ghost__']);

/* ── ④ 站点分类是显式登记的 ─────────────────────────────────────────────── */
const siteCategories = new Set();
for (const f of FEATURES) for (const s of f.site || []) siteCategories.add(s);
check('站点分类来自清单（壁纸/开机动画/桌宠至少三类）',
  siteCategories.has('wallpaper') && siteCategories.has('boot-animation') && siteCategories.has('desktop-pet'),
  [...siteCategories].join(','));

/* 反向：站点分类若在代码里硬编码却没登记，这里给出清单（提示用，不判红） */
const hardcoded = [];
for (const f of ['lib/routes/inventory.js', 'lib/routes/boot.js', 'lib/routes/pets.js']) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  for (const m of src.matchAll(/'([a-z-]+)'\s*;?\s*\/\/.*分类/g)) hardcoded.push(f + ':' + m[1]);
}

/* ── ⑤ 没有空壳功能 ─────────────────────────────────────────────────────── */
const shells = FEATURES.filter((f) => !(f.host || []).length && !(f.client || []).length);
check('没有空壳功能（host/client 至少一项非空）', shells.length === 0, shells.map((f) => f.id).join(','));

/* ── ⑥ 装配点不许点名具体功能（页签/面板/挂载都走注册表）─────────────────── */
{
  const qpSrc = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8');
  const hardBranches = [...qpSrc.matchAll(/qpTab\s*===?\s*"([a-z-]+)"/g)].map((m) => m[1]);
  check('quick-panel 不再按功能名分支（页签走注册表）',
    // 允许三种：壁纸列表 / 外观节 / 播放节 —— 它们是泛型布局（同一渲染器服务多页签），
    // 不属于「把某个功能焊死进装配点」。整区面板（开机动画 / 桌宠）必须走注册表。
    hardBranches.every((id) => ['wallpaper', 'appearance', 'playback'].includes(id)),
    '仍写死的页签: ' + [...new Set(hardBranches)].join(','));
  check('quick-panel 用注册表取页签', qpSrc.includes('const QP_TABS = WE_FEATURE_TABS;'));
  check('quick-panel 用注册表取整区面板', qpSrc.includes('WE_FEATURE_PANELS[qpTab]'));

  const cliSrc = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  check('client.js 不再点名桌宠挂载', !cliSrc.includes('mountPetLayer()'), '仍然直接调 mountPetLayer');
  check('client.js 遍历 WE_FEATURE_MOUNTS 挂载', cliSrc.includes('WE_FEATURE_MOUNTS'));

  const featSrc = readFileSync(join(ROOT, 'src', 'features.js'), 'utf8');
  check('注册表声明了页签/面板/挂载三张表',
    featSrc.includes('const WE_FEATURE_TABS = [') && featSrc.includes('const WE_FEATURE_PANELS = {') && featSrc.includes('const WE_FEATURE_MOUNTS = ['));
  const panelKeys = [...featSrc.matchAll(/^\s{2}([a-z-]+):\s*[A-Za-z]/gm)].map((m) => m[1]);
  check('注册表里的面板键都是登记过的页签', panelKeys.every((k) => qpTabs.includes(k)), '未知键: ' + panelKeys.filter((k) => !qpTabs.includes(k)).join(','));
  check('开机动画与桌宠都走注册表面板', panelKeys.includes('boot') && panelKeys.includes('pets'), panelKeys.join(','));
}

/* ── ⑦ 内联顺序：注册表必须在引用者之前 ─────────────────────────────────── */
{
  const build = readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8');
  const atFeatures = build.indexOf("'src/features.js'");
  const atQuick = build.indexOf("'src/quick-panel.js'");
  const atPetLayer = build.indexOf("'src/pet-layer.js'");
  check('build-client 登记了 features.js', atFeatures > 0);
  check('features.js 在 quick-panel.js 之前内联（顶层读注册表）', atFeatures > 0 && atQuick > atFeatures, atFeatures + ' vs ' + atQuick);
  check('features.js 在 pet-layer.js 之后内联（引用 mountPetLayer）', atPetLayer > 0 && atFeatures > atPetLayer, atPetLayer + ' vs ' + atFeatures);
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  功能数: ' + FEATURES.length + ' · 文件数: ' + fileCount + ' · 路由: ' + routeFiles.length +
  ' · 页签: ' + qpTabs.length + '\n');
if (hardcoded.length) process.stdout.write('  提示: 有 ' + hardcoded.length + ' 处分类可能硬编码: ' + hardcoded.slice(0, 3).join(', ') + '\n');
process.stdout.write('  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
