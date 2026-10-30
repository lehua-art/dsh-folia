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

/* ⑤ 皮肤兼容层（src/skin-compat.js）：它补的 `data-pane` / `data-dsh-frame` 是**皮肤包写的词表**，
 *    所以它的判据不是风格问题，而是"皮肤到底能不能画对"：
 *      · 锚点必须是**列那一级**的槽名（sidebar / main / rightbar）。宿主的 `renderSlot` 锚点带
 *        `ANCHOR_STYLE = { display: "contents" }`（app.asar 实证），`main.conversation` /
 *        `rightbar.session` 这类**深层槽名**的父元素是另一个 contents 锚点或内层 div ⇒ 写在那里
 *        没有布局效果，皮肤的分栏规则照样不命中（就是"皮肤显示不全"那个症状）。
 *      · 幂等：已存在 `data-pane` 就不许覆盖（装了 web-all 时以它为准）。
 *      · 自身可失败：只观察 childList，不观察属性（否则自激）。
 *    这张表同时是它的守卫覆盖登记 —— 覆盖面口径只认代码里的字面量路径。 */
{
  const compatSrc = readFileSync(join(ROOT, 'src', 'skin-compat.js'), 'utf8');
  const buildSrc = readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8');
  const featuresSrc = readFileSync(join(ROOT, 'src', 'features.js'), 'utf8');

  /** 列级槽名（缺一不可）。 */
  const COLUMN_KEYS = ['[data-slot="sidebar"]', '[data-slot="main"]', '[data-slot="rightbar"]'];
  const hasColumnKeys = (src) => COLUMN_KEYS.every((k) => src.includes("'" + k + "'"));
  /** 退路选择器只在列级之后：深层槽名不许抢在列级前面。 */
  const columnKeysFirst = (src) => {
    const at = (k) => src.indexOf("'" + k + "'");
    return at(COLUMN_KEYS[1]) !== -1 && at('[data-slot="main.conversation"]') !== -1
      && at(COLUMN_KEYS[1]) < at('[data-slot="main.conversation"]')
      && at(COLUMN_KEYS[2]) !== -1 && at('[data-slot="rightbar.session"]') !== -1
      && at(COLUMN_KEYS[2]) < at('[data-slot="rightbar.session"]');
  };
  /** 幂等：`hasAttribute('data-pane')` 的判据必须出现在 `setAttribute` **之前**。 */
  const idempotent = (src) => {
    const a = src.indexOf("hasAttribute('data-pane')");
    const b = src.indexOf("setAttribute('data-pane'");
    return a !== -1 && b !== -1 && a < b;
  };
  /** 每条规则各判各的（累计计数会让后一条规则跳过自己的退路选择器）。 */
  const perRuleBreak = (src) => /if \(ruleStamped\) break;/.test(src) && !/if \(stamped\) break;/.test(src);
  /** 穿过 display:contents 锚点。 */
  const climbsAnchors = (src) => /hasAttribute\('data-slot'\)/.test(src);

  check('src/skin-compat.js 在构建面里被内联（INLINE_MODULES）', buildSrc.includes("file: 'src/skin-compat.js'"));
  check('皮肤兼容层注册成常驻挂载（features.js WE_FEATURE_MOUNTS）',
    featuresSrc.includes('id: "skin-compat"') && featuresSrc.includes('mount: installSkinCompat'));
  check('分栏锚点用**列级**槽名（sidebar / main / rightbar）', hasColumnKeys(compatSrc), COLUMN_KEYS.join(' '));
  check('深层槽名只作退路：列级选择器排在它前面', columnKeysFirst(compatSrc));
  check('paneHost 穿过 display:contents 的 `[data-slot]` 锚点再落笔', climbsAnchors(compatSrc));
  check('幂等：已有 data-pane 就不覆盖（装了 web-all 时以它为准）', idempotent(compatSrc));
  check('每条 pane 规则各自判断命中（`ruleStamped`），不用累计计数短路退路', perRuleBreak(compatSrc));
  check('只观察 childList / subtree，不观察属性（否则自激）',
    /observer\.observe\(document\.body, \{ childList: true, subtree: true \}\)/.test(compatSrc)
    && !/attributes: true/.test(compatSrc) && !/attributeFilter/.test(compatSrc));
  check('installSkinCompat 返回 teardown（与仓库其它 install* 同形）',
    /function installSkinCompat\(\)/.test(compatSrc) && /return \(\) => \{/.test(compatSrc));
  check('只写三种 pane 值（不发明词表）',
    (compatSrc.match(/pane: '/g) || []).length === 3
    && ["pane: 'sidebar'", "pane: 'conversation'", "pane: 'details'"].every((v) => compatSrc.includes(v)));

  /* 挂载点必须**可失败**：`ctx.effect(() => feat.mount())` 不做保护，mount 一抛就顺着 apply 链
   * 把整个宿主插件带崩。实测（2026-10-30）：fake DOM 的沙箱里没有 `setTimeout`，裸调它让
   * verify-playback-controls / verify-transcode-state / verify-softrender 一起变红（含 17 条判据）。
   * 判据：① 不许有裸 `setTimeout(` 调用（只许 `window.setTimeout` 或 typeof 探测后的变量调用）；
   *       ② install 自己吞掉异常并返回 noop teardown。 */
  const timerTolerant = (src) => !/(^|[^.\w])setTimeout\(/m.test(src) && /typeof setTimeout/.test(src);
  const failureContained = (src) => /catch \{ return \(\) => \{\}; \}/.test(src)
    && /function installSkinCompat\(\) \{[\s\S]*?try \{/.test(src);
  check('挂载点不裸调 setTimeout（fake DOM 沙箱里没有定时器）', timerTolerant(compatSrc));
  check('挂载点自吞异常并返回 noop teardown（mount 抛会带崩整个 apply 链）', failureContained(compatSrc));
  check('negative control: 塞一处裸 `setTimeout(` ⇒ 定时器判据会红',
    !timerTolerant(compatSrc.replace('stampAll();', 'setTimeout(stampAll, 1);')));
  check('negative control: 去掉兜底 catch ⇒ 可失败判据会红',
    !failureContained(compatSrc.replace('} catch { return () => {}; }\n}', '}\n}')));

  /* 负对照：把任一条判据的前提改坏，上面的判据必须变红。 */
  const noMainKey = compatSrc.replace("'[data-slot=\"main\"]', ", '');
  check('negative control: 删掉 `[data-slot="main"]` ⇒ 列级判据会红', !hasColumnKeys(noMainKey));
  const deepFirst = compatSrc.replace(
    "'[data-slot=\"main\"]', '[data-slot=\"main.conversation\"]'",
    "'[data-slot=\"main.conversation\"]', '[data-slot=\"main\"]'");
  check('negative control: 把深层槽名排到列级前面 ⇒ 顺序判据会红', !columnKeysFirst(deepFirst));
  const noGuard = compatSrc.replace("if (!host || host.hasAttribute('data-pane')) continue;", 'if (!host) continue;');
  check('negative control: 删掉幂等判据 ⇒ 幂等会红', !idempotent(noGuard));
  const oldStyle = compatSrc.replace('if (ruleStamped) break;', 'if (stamped) break;');
  check('negative control: 退回累计计数 ⇒ 逐规则判据会红', !perRuleBreak(oldStyle));
  check('正对照: 真实文件四条判据全真',
    hasColumnKeys(compatSrc) && columnKeysFirst(compatSrc) && idempotent(compatSrc) && perRuleBreak(compatSrc));
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
