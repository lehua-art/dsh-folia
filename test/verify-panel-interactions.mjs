/**
 * verify-panel-interactions.mjs — **交互手感**的静态守卫。
 *
 * 为什么要有它：用户实测报过两个只有"用起来"才发现的缺陷 ——
 *   ① 「启用」复选框点不动（因为它被 `!activeId` 一起禁用了：把"有没有选片"和"能不能开"绑在一起）；
 *   ② 点「带声音」界面闪一下（每次设置都 `load(true)` 重拉整表 + 设 busy 禁用控件 ⇒ 两轮重渲染 + 布局跳动）。
 *
 * 这两类都不是逻辑错误，任何"跑一遍路由"的测试都测不出来；但它们在源码里有**确定的形状**，
 * 所以用静态判据钉住，改回去就红：
 *   ① 开关类控件的 disabled 不得绑定"有没有选片/装没装"（那是两件事）；
 *   ② 幂等设置（toggle/settings/config）必须**合并响应**，不许整表重载；
 *   ③ 提示行必须有固定高度（minHeight），否则出现/消失会让面板跳。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boot = readFileSync(join(ROOT, 'src', 'panel-tabs-boot.js'), 'utf8');
const pets = readFileSync(join(ROOT, 'src', 'panel-tabs-pets.js'), 'utf8');

const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

/* ① 开关不绑"有没有选片" */
{
  // 判据本体：从源码里取出「启用」复选框的 disabled 表达式（正判据与负对照共用）。
  const disabledExprOf = (src) => {
    const m = /checked: enabled,[\s\S]{0,260}?disabled: ([^,\n]+),/.exec(src);
    return m ? m[1].trim() : '';
  };
  const expr = disabledExprOf(boot);
  check('「启用」复选框的 disabled 不引用 activeId', Boolean(expr) && !expr.includes('activeId'), 'expr=' + expr);
  check('「启用」复选框仍然只在 busy 时禁用（结构操作期间不误点）', expr.includes('busy'), 'expr=' + expr);
  // 负对照：同一判据喂一段"绑回 activeId"的源码，必须判出（否则上面两条是空转）
  const brokenExpr = disabledExprOf(
    'React.createElement("input", {\n  type: "checkbox", checked: enabled, disabled: Boolean(busy) || !activeId,\n})',
  );
  check('negative control: 绑回 activeId 会被同一条判据判出', brokenExpr.includes('activeId'), 'expr=' + brokenExpr);
  check('正对照: 真实源码的表达式与负对照不同', brokenExpr !== expr && Boolean(expr));
}

/* ② 幂等设置合并响应，不整表重载 */
{
  check('boot: toggle / settings 走合并分支', /kind === "toggle" \|\| kind === "settings"/.test(boot));
  check('boot: 合并分支里出现 setState(...spread r)', /setState\(\(prev\)[\s\S]{0,80}\.\.\.r/.test(boot));
  check('boot: 结构性操作仍走 load(true)（下载/选择/删除）', /await load\(true\);/.test(boot));
  check('pets: config 走合并分支', /kind === "config" && r && r\.config/.test(pets));
  check('pets: 合并分支里出现 setState config', /setState\(\(prev\)[\s\S]{0,80}config: r\.config/.test(pets));
  // 判据本体：源码里出现「设置类直接 await load(true)」就是那个旧形状。
  const looksReloadOnly = (src) => /kind === "settings"\) \{\s*await load\(true\);/.test(src);
  // 正对照：真实源码不是那个形状（否则上面两条合并判据就是空转）
  check('正对照: 真实 boot 面板不是「只重载」形状', !looksReloadOnly(boot));
  // 负对照：塞一段旧形状进去，同一条判据必须判出
  const bad = 'if (kind === "settings") { await load(true); }';
  check('negative control: 设置类只重载不合并会被同一条判据判出', looksReloadOnly(bad));
}

/* ③ busy 只锁结构操作 */
{
  check('boot: structural 只含 download/select/remove/import', /const structural = kind === "download" \|\| kind === "select" \|\| kind === "remove" \|\| kind === "import";/.test(boot));
  check('pets: structural 只含 install/remove/import', /const structural = kind === "install" \|\| kind === "remove" \|\| kind === "import";/.test(pets));
}

/* ④ 提示行占位（布局不跳） */
{
  check('boot: 提示行有 minHeight', /key: "note"[\s\S]{0,220}minHeight/.test(boot));
  check('pets: 提示行有 minHeight', /key: "note"[\s\S]{0,220}minHeight/.test(pets));
  check('boot: 提示行常驻（不再 `if (note)` 包住 push）', !/^\s{2}if \(note\) \{/m.test(boot));
  check('pets: 提示行常驻', !/^\s{2}if \(note\) \{/m.test(pets));
}

/* ⑤ pre.51/pre.52：桌宠页与「智能大肥鱼」两个界面；pre.52 起桌宠页的指路提示也删了 */
{
  const assistant = readFileSync(join(ROOT, 'src', 'panel-tabs-assistant.js'), 'utf8');
  const client = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  const build = readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8');
  const separated = (petsSrc) => !petsSrc.includes('PetChatSettings')
    && !petsSrc.includes('在左侧「智能大肥鱼」里配置')
    && !petsSrc.includes('assistantHint');
  check('pre.51/52 桌宠页不再挂载语音助手表单，也不再留指路提示',
    separated(pets) && !pets.includes('模型 Key') && !pets.includes('apiKey'));
  check('pre.51 一级设置项 folia-assistant（order 502）注册 AssistantSection',
    /id: "folia-assistant", order: 502/.test(client)
      && /React\.createElement\(AssistantSection\)/.test(client));
  check('pre.51 独立页字段齐全（Key / 名字 / 称呼 / 音色 / 保存 / 工作能力 / 冲突提醒）',
    ['模型 Key', '名字', '称呼', '音色', '保存', '可选工作能力（已安装才可用）', '冲突提醒：']
      .every((text) => assistant.includes(text)));
  check('pre.51 独立页保留设置块 id（样式与锚点不变）',
    /id: 'we-pet-chat-settings'/.test(assistant));
  check('pre.52 独立页标题下那句说明已删（保留标题 + 表单）',
    !assistant.includes('这里是桌宠语音助手的完整设置') && assistant.includes("weT('智能大肥鱼')"));
  check('pre.52 「站点桌宠」标题只在有可装条目或站点不可达时渲染',
    /if \(available\.length \|\| state\.siteError\) \{/.test(pets)
      && /key: "siteHead"/.test(pets));
  check('pre.51 新组件已登记构建内联清单 + markers',
    build.includes('src/panel-tabs-assistant.js')
      && build.includes("'function AssistantSection()'")
      && build.includes("'function PetChatSettings()'"));
  // 负对照：把表单塞回桌宠页，同一条"分开"判据必须判红。
  check('pre.51 negative control：表单塞回桌宠页会被同一条判据判红',
    !separated(pets + '\nchildren.push(React.createElement(PetChatSettings));'));
  check('pre.52 negative control：指路提示塞回桌宠页会被同一条判据判红',
    !separated(pets + '\n// 语音助手（Key、名字、称呼、音色）在左侧「智能大肥鱼」里配置。'));
}

/* ⑥ pre.51：侧栏壁纸筛选条 = 缓存 / 子标签 / 来源 三档（分级、类型已删） */
{
  const quick = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8');
  // 只看代码：注释里写"不再有 typeFilter"不算残留。
  const code = quick.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const cleanBar = (src) => !src.includes('we-qp__rating') && !src.includes('we-qp__type');
  check('pre.51 侧栏筛选条是 缓存 / 子标签 / 来源 三档',
    ['we-qp__cache', 'we-qp__subtag', 'we-qp__source'].every((cls) => quick.includes(cls))
      && quick.includes('weT("缓存状态")') && quick.includes('weT("子标签")')
      && quick.includes('weT("来源筛选")'));
  check('pre.51 侧栏不再有内容分级 / 类型两档',
    cleanBar(code) && !code.includes('contentRatingFilter') && !code.includes('typeFilter'));
  check('pre.51 三个筛选经 filters 入参进入渲染器（不读外层未定义变量）',
    /function qpRenderViewBar\(sel, view, filters, switchView\)/.test(quick)
      && /function qpRenderLibrarySection\(sel, view, filters, listRef/.test(quick)
      && quick.includes('onCacheFilterChange, onSubtagFilterChange'));
  check('pre.51 过滤流水线：未缓存 = localReady !== true；子标签按 w.subtag 精确匹配',
    /const ready = Boolean\(w && w\.localReady === true\)/.test(quick)
      && /cacheFilter === "uncached" && ready/.test(quick)
      && /String\(\(w && w\.subtag\) \|\| ""\)\.trim\(\) !== subtagFilter/.test(quick));
  check('pre.51 子标签选项来自站点 facets（站点新增后重开即同步）',
    /tagOptionsFromFacets\(sel\.inventory && sel\.inventory\.facets\)/.test(quick)
      && /group === "subtags"/.test(quick));
  // 负对照：旧的分级/类型下拉，同一条判据必须判红。
  const oldBar = 'React.createElement("select", { className: "we-picker__select we-qp__rating" })'
    + 'React.createElement("select", { className: "we-picker__select we-qp__type" })';
  check('pre.51 negative control：旧的分级/类型下拉会被同一条判据判红', !cleanBar(oldBar));
}

/* ⑦ pre.52（P4）：开机动画 / 助手皮肤两页签预热（设置面板挂载时一次） */
{
  const features = readFileSync(join(ROOT, 'src', 'features.js'), 'utf8');
  const client = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  const boot = readFileSync(join(ROOT, 'src', 'panel-tabs-boot.js'), 'utf8');
  const skins = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
  check('pre.52 注册表给 boot / skins 声明了 warm，并暴露通用 warmFeaturePanels()',
    /warm: warmBootTab/.test(features) && /warm: warmSkinsTab/.test(features)
      && /function warmFeaturePanels\(\)/.test(features));
  check('pre.52 设置面板挂载时只调通用入口（不在 client.js 点名具体 warm 函数）',
    /warmFeaturePanels\(\)/.test(client)
      && !/warmBootTab\(/.test(client) && !/warmSkinsTab\(/.test(client));
  check('pre.52 两个 warm 都写已有页签缓存，且失败静默（catch 返回 null）',
    /async function warmBootTab\(\)[\s\S]{0,900}?BOOT_TAB_CACHE = r/.test(boot)
      && /async function warmSkinsTab\(\)[\s\S]{0,900}?SKINS_TAB_CACHE = doc/.test(skins)
      && /catch \{ return null; \}/.test(boot) && /catch \{ return null; \}/.test(skins));
  check('pre.52 预热只发一次（有 in-flight promise 去重）',
    /BOOT_WARM_PROMISE/.test(boot) && /SKINS_WARM_PROMISE/.test(skins));
  // 负对照：在 client.js 里硬插具体调用，必须被判红（这正是上一轮构建报错的形态）。
  const hard = client + '\nwarmBootTab(); warmSkinsTab();';
  check('pre.52 negative control：client.js 里硬插具体 warm 调用会被同一条判据判红',
    /warmBootTab\(/.test(hard) && /warmSkinsTab\(/.test(hard));
}

/* ⑧ pre.52（P2）：卸载不卡 —— 客户端乐观移除 + 宿主 rename 到 .trash 后台删 */
{
  const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
  const skinsRoute = readFileSync(join(ROOT, 'lib', 'routes', 'skins.js'), 'utf8');
  check('pre.52 客户端卸载：点下去先置 removing + 提示「卸载中…」',
    /const \[removing, setRemoving\] = React\.useState\(\{\}\)/.test(skinsTab)
      && /if \(kind === "remove" && cardId\) \{\s*setRemoving/.test(skinsTab)
      && /卸载中…：\{name\}/.test(skinsTab));
  check('pre.52 已装列表按 removing 过滤（卡片同帧消失），失败路径会回滚',
    /const installed = installedAll\.filter\(\(s\) => !s \|\| !removing\[s\.id\]\)/.test(skinsTab)
      && (skinsTab.match(/delete n\[cardId\]/g) || []).length >= 2);
  check('pre.52 宿主卸载：先 rename 到 .trash 再回 200，递归删除放后台',
    /renameSync\(dir, trashed\)/.test(skinsRoute)
      && /sendJson\(res, 200, \{ ok: true, id, clearedActive \}\)/.test(skinsRoute)
      && /setImmediate\(later\)/.test(skinsRoute));
  check('pre.52 listInstalled 跳过点目录（.trash 不会被当成已装）',
    /!d\.name\.startsWith\('\.'\)/.test(skinsRoute));
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
