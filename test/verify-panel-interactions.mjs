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

/* ⑤ pre.49：桌宠页「🐟 智能大肥鱼」开关（控制行最右，默认收起，点开才挂载语音助手设置） */
{
  const sizeAt = pets.indexOf('weT("大小")');
  const fishAt = pets.indexOf('weT("智能大肥鱼")');
  check('pre.49 控制行「大小」之后有「智能大肥鱼」按钮（同一 flex-wrap 控制行）',
    sizeAt >= 0 && fishAt > sizeAt
      && /row: \{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" \}/.test(pets),
    `size@${sizeAt} · fish@${fishAt}`);
  check('pre.49 按钮沿用 .we-picker__btn，带 aria-expanded / aria-controls，点击切换本地 state',
    /className: "we-picker__btn"[\s\S]{0,320}?["']aria-expanded["']?: assistantOpen/.test(pets)
      && /"aria-controls": "we-pet-chat-settings"/.test(pets)
      && /onClick: \(\) => setAssistantOpen\(\(v\) => !v\)/.test(pets));
  check('pre.49 语音助手默认收起，且只在展开时条件渲染（不是 CSS 隐藏）',
    /const \[assistantOpen, setAssistantOpen\] = React\.useState\(false\)/.test(pets)
      && /if \(assistantOpen\) \{[\s\S]{0,180}React\.createElement\(PetChatSettings/.test(pets)
      && !/^\s{2}children\.push\(React\.createElement\(PetChatSettings/m.test(pets));
  check('pre.49 展开块字段齐全（Key / 名字 / 称呼 / 音色 / 保存 / 工作能力 / 冲突提醒）',
    ['模型 Key', '名字', '称呼', '音色', '保存', '可选工作能力（已安装才可用）', '冲突提醒：']
      .every((text) => pets.includes(text)));
  check('pre.49 aria-controls 指向的设置块 id 真的存在',
    /id: 'we-pet-chat-settings'/.test(pets));
  // 负对照：无条件渲染 / 按钮跑到「大小」前面，必须被上面同一套判据判红。
  const conditionalOf = (src) => /if \(assistantOpen\) \{[\s\S]{0,180}React\.createElement\(PetChatSettings/.test(src)
    && !/^\s{2}children\.push\(React\.createElement\(PetChatSettings/m.test(src);
  check('pre.49 negative control：无条件渲染会被「默认收起」判据判红',
    !conditionalOf('children.push(React.createElement(PetChatSettings, { key: "petChat" }));'));
  const wrongOrder = 'React.createElement("button", null, "🐟 " + weT("智能大肥鱼")) ... weT("大小")';
  check('pre.49 negative control：按钮放到「大小」前面会被顺序判据判红',
    !(wrongOrder.indexOf('weT("大小")') < wrongOrder.indexOf('weT("智能大肥鱼")')));
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
