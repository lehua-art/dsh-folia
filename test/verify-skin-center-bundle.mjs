/**
 * verify-skin-center-bundle.mjs — 「**不**替用户装皮肤中心」这条契约的守卫。
 *
 * 演变（2026-10-30 实测，两次都是真事故）：
 *   早期我们想"装 dsh-folia 就同时得到皮肤中心"，于是给它加了 `dependencies` + 第二条 insert row。
 *   结果与桌面端/市场自己管理的那条 row 撞了，每次启动日志都写
 *
 *       "@linxin666/dsh-client-ui-skin-center -> off: fiber=true"
 *       "plugin kept off: @linxin666/dsh-client-ui-skin-center"
 *
 *   ⇒ 它被关掉，`/api/skin-center/v2/*` 整族变成路由 miss（带会话实测 404）⇒ 页签点「应用」必失败。
 *   把依赖钉到 0.4.8 只在那一次启动生效：桌面端重启会把 0.4.12 投影回来（engines 要求
 *   `dsh >= 0.2.1-rc.3`，而当前桌面端是 rc.2）→ 又被关掉。直接改 profile 的 package.json /
 *   overrides 会让桌面端"Profile 恢复未完成"进**安全模式**（已踩，已回滚）。
 *
 * 所以契约反过来：**本包不声明依赖、不插 row**。皮肤中心由用户在自己的插件市场/桌面端里装
 * （那里管版本与引擎匹配）；我们的页签只做两件事 —— 把站点 zip 解到 `$DSH_HOME/skins`，以及
 * 在它确实在跑时写选择。
 *
 * 判据（正反都咬）：
 *   ① package.json **不得**把皮肤中心列为 dependencies / devDependencies；
 *   ② cordis.patch.yml **只有一条** row（我们自己的 folia），不得出现它的 name；
 *   ③ patch 里所有 row id 唯一，且第三方 id 不得以 `folia-` 开头；
 *   ④ 负对照：把依赖/行塞回去 ⇒ ①② 必须变红。
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

/* ① 不许替用户装（依赖面） */
{
  const dep = (pkgJson.dependencies || {})[SKIN_CENTER];
  const devDep = (pkgJson.devDependencies || {})[SKIN_CENTER];
  check('package.json 不把皮肤中心列为 dependency（由用户自己的市场/桌面端装）', !dep, 'dep=' + String(dep));
  check('也不列进 devDependencies（同样会进 profile）', !devDep, 'devDep=' + String(devDep));
  check('negative control: 把它塞回 dependencies ⇒ 上面那条会红',
    Boolean({ ...(pkgJson.dependencies || {}), [SKIN_CENTER]: '0.4.8' }[SKIN_CENTER]));
}

/* ② patch 只有我们自己那一条 row */
{
  const names = rowNames(patch);
  check('cordis.patch.yml 里只有 dsh-folia 这一条 row', names.length === 1 && names[0] === PKG, names.join(','));
  check('不再插指向皮肤中心的 row（重复 fiber 会被市场关掉）', !names.includes(SKIN_CENTER), names.join(','));
  check('negative control: 塞回一条 skin-center 行 ⇒ 上面那条会红',
    rowNames(patch + '\n    - id: skin-center\n      name: \'' + SKIN_CENTER + '\'\n').includes(SKIN_CENTER));
}

/* ③ id 唯一 + **id 前缀纪律** */
{
  const ids = rowIds(patch);
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
  check('patch 里所有 row id 唯一', dup.length === 0, 'ids=' + ids.join(','));
  check('唯一那条 row 的 id 就是 folia', ids.length === 1 && ids[0] === 'folia', 'ids=' + ids.join(','));
  // ⚠️ 这条不是风格问题：`lib/subpackage-boot.js#subpackageSpecifiers` 把「id 以 folia- 开头」的行
  //    当作**我们自己的子包行**去仓库 node_modules 里解析，解析不到就抛（宿主对行级失败静默）。
  //    给第三方行起 `folia-xxx` 会被误判 ⇒ apply 直接失败。实测踩过：整条 audit 因此红了 7 个。
  check('任何第三方行都不得以 `folia-` 开头（否则会被子包自检误判）',
    !ids.some((id) => id.startsWith('folia-') && id !== 'folia'),
    'ids=' + ids.join(','));
}

/* ④ 正对照：真实文件确实通过上面三条（不是"因为空所以过"） */
{
  const idsNow = rowIds(patch);
  check('正对照: 真实 patch 的 id 列表就是 [folia]', idsNow.length === 1 && idsNow[0] === 'folia', 'ids=' + idsNow.join(','));
  check('正对照: 负对照用的注入确实能被 rowNames 解析出来',
    rowNames("    - id: x\n      name: 'probe-pkg'\n").includes('probe-pkg'));
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
