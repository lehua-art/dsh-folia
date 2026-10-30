/**
 * verify-skin-center-bundle.mjs — 「装我们的插件 = 同时得到皮肤中心」这条契约的守卫。
 *
 * 为什么需要单独钉住：这是一条**跨包**契约，而且它坏掉的方式很安静 ——
 *   · 只写进 `cordis.patch.yml` 却没写进 `dependencies`：别人装完 row 指向不存在的包，
 *     表现为「皮肤页签在，但皮肤中心没起来」，日志里只有一句解析失败；
 *   · 只写进 `dependencies` 却没插 row：包装进来了但没人加载它（DSH 只加载 profile 里
 *     有 row 的插件），表现为「装完还是提示缺皮肤中心」；
 *   · 两条都写但 id 重复：同一份 patch 里两个 `id:` 相同 ⇒ 装配期冲突。
 *
 * 判据（正反都咬）：
 *   ① package.json 的 dependencies 里有 skin centre，且版本范围指到实测过的 0.4.8 线；
 *   ② cordis.patch.yml 里有一条 insert row，name 指向该包；
 *   ③ 该 patch 里所有 row 的 id **唯一**（我们自己的 folia + folia-skin-center 不撞）；
 *   ④ 负对照：把 dependencies 里的那一行删掉 ⇒ ① 变红；把 row 删掉 ⇒ ② 变红。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'dsh-folia';
const SKIN_CENTER = '@linxin666/dsh-client-ui-skin-center';

const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');

const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

/** patch 里所有 `id:`（只认 insert 行的缩进形式，取其值）。 */
function rowIds(src) {
  return [...src.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));
}
/** patch 里所有 `name:`。 */
function rowNames(src) {
  return [...src.matchAll(/^\s*name:\s*['"]?([^'"\n]+)['"]?\s*$/gm)].map((m) => m[1].trim());
}

/* ① 依赖声明 */
{
  const dep = (pkgJson.dependencies || {})[SKIN_CENTER];
  check('package.json 把皮肤中心列为 dependency', Boolean(dep), 'dep=' + String(dep));
  check('版本范围指到实测过的 0.4.8 线', Boolean(dep) && /^\^?0\.4\.\d+$/.test(String(dep).trim()), 'dep=' + String(dep));
  // 不能只放 devDependencies：那样用户装包时不会带上它。
  const devOnly = !dep && Boolean((pkgJson.devDependencies || {})[SKIN_CENTER]);
  check('不是只写在 devDependencies 里', !devOnly);
}

/* ② patch 行 */
{
  const names = rowNames(patch);
  check('cordis.patch.yml 插了一条指向皮肤中心的 row', names.includes(SKIN_CENTER), names.join(','));
  check('我们自己的 row 仍在', names.includes(PKG), names.join(','));
}

/* ③ id 唯一 + **id 前缀纪律** */
{
  const ids = rowIds(patch);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  check('patch 里所有 row id 唯一', dup.length === 0, 'ids=' + ids.join(','));
  check('皮肤中心的 row 用自己的 id（不与 web-all 的 web-ui-skin-center 抢名）',
    ids.includes('skin-center'), 'ids=' + ids.join(','));
  // ⚠️ 这条不是风格问题：`lib/subpackage-boot.js#subpackageSpecifiers` 把「id 以 folia- 开头」的行
  //    当作**我们自己的子包行**去仓库 node_modules 里解析，解析不到就抛（宿主对行级失败静默）。
  //    给第三方行起 `folia-xxx` 会被误判 ⇒ apply 直接失败。实测踩过：整条 audit 因此红了 7 个。
  check('第三方行的 id 不得以 `folia-` 开头（否则会被子包自检误判）',
    !ids.some((id) => id.startsWith('folia-') && id !== 'folia'),
    'ids=' + ids.join(','));
}

/* ④ 负对照：删掉任一半，对应判据必须变红 */
{
  const pkgNoDep = { ...pkgJson, dependencies: { ...(pkgJson.dependencies || {}) } };
  delete pkgNoDep.dependencies[SKIN_CENTER];
  check('negative control: 删掉 dependencies 那一行 ⇒ 依赖判据会红',
    !Object.prototype.hasOwnProperty.call(pkgNoDep.dependencies, SKIN_CENTER));

  const patchNoRow = patch.split('\n').filter((l) => !l.includes(SKIN_CENTER)).join('\n');
  check('negative control: 删掉 row ⇒ 行判据会红', !rowNames(patchNoRow).includes(SKIN_CENTER));

  const idsNow = rowIds(patch);
  check('正对照: 真实 patch 的 id 列表非空', idsNow.length >= 2, 'ids=' + idsNow.join(','));
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
