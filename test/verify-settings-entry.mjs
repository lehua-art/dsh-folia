/**
 * verify-settings-entry.mjs — v1.3 判据 U1–U4：
 *   U1 智能大肥鱼第一屏能看到「⚙ 对话与隐私 / 朗读 / 工作能力」
 *   U2 展开后默认「对话与隐私」，且该页内容齐全（含删除“对话模式”）
 *   U3 展开区能在 助手/对话与隐私/朗读/工作能力 之间切换，草稿同源不丢
 *   U4 build-client 不报“缺少预期标记”，产物里带入口
 * 静态结构 + 真构建；不依赖浏览器（视觉验收由 U1/U2 手工确认）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const panel = readFileSync(join(ROOT, 'src', 'panel-tabs-assistant.js'), 'utf8');
const assistant = panel.slice(panel.indexOf('function AssistantSection()'), panel.indexOf('export { AssistantSection'));
const petSettings = panel.slice(panel.indexOf('function PetChatSettings()'), panel.indexOf('function MicTestBlock'));

/* U1：入口在第一屏 */
check('U1① AssistantSection 标题旁有「⚙ 对话与隐私 / 朗读 / 工作能力」入口按钮',
  /⚙ 对话与隐私 \/ 朗读 \/ 工作能力/.test(assistant)
  && /we-assistant-settings-entry/.test(assistant)
  && /onClick: \(\) => setSettingsOpen\(\(open\) => !open\)/.test(assistant),
  'entry button');
check('U1② 入口下面仍然渲染人设区（不替换、不跳页）',
  /React.createElement\(PersonaSection, null\)/.test(assistant));
check('U1③ 点击后当前页展开 PetChatSettings，默认 behavior',
  /React.createElement\(PetChatSettings, \{ initialTab: 'behavior' \}\)/.test(assistant)
  && /setSettingsOpen\(\(open\) => !open\)/.test(assistant),
  'expand in place');

/* U2：默认页内容 */
check('U2① 默认页是「对话与隐私」，且四个页签都存在',
  /const tabs = \[/.test(petSettings) && /\['behavior', weT\('对话与隐私'\)\]/.test(petSettings)
  && /\['assistant', weT\('助手'\)\]/.test(petSettings)
  && /\['voice', weT\('朗读与音色'\)\]/.test(petSettings)
  && /\['work', weT\('工作能力'\)\]/.test(petSettings),
  'four tabs');
check('U2② 该页有：语音长度 / 主动搭话 / 勿扰 / 屏幕感知 / 观察记录 / 记忆 / 树洞热线',
  /语音回答长度/.test(petSettings) && /主动搭话/.test(petSettings) && /勿扰时段/.test(petSettings)
  && /屏幕感知/.test(petSettings) && /查看观察记录/.test(petSettings) && /查看记忆/.test(petSettings)
  && /树洞求助热线/.test(petSettings),
  'behavior controls');
check('U2③ 已删除「对话模式」下拉（不出现 conversation-mode / 对话模式：）',
  !/conversation-mode/.test(petSettings) && !/对话模式：/.test(petSettings)
  && !/\['chat', weT\('聊天'\)\], \['story'/.test(petSettings),
  'mode row removed');

/* U3：切页不丢草稿（同一个 draft 状态；tab 只切视图） */
check('U3① 四个页签共用一个 draft 状态（切页不重置）',
  (petSettings.match(/const \[draft, setDraft\] = React\.useState\(CHAT_DEFAULTS\);/g) || []).length === 1
  && petSettings.indexOf('const [draft, setDraft]') < petSettings.indexOf("if (tab === 'assistant')")
  && petSettings.indexOf('const [draft, setDraft]') < petSettings.indexOf("if (tab === 'behavior')"),
  'single draft');
check('U3② tab 只控制渲染分支（setTab 不发保存/不刷新）',
  /const \[tab, setTab\] = React\.useState\(initialTab\)/.test(petSettings)
  && /onClick: \(\) => setTab\(id\)/.test(petSettings),
  'tab state only');
check('U3③ 初始页签通过 props/arguments[0] 传入（函数签名不变）',
  /const initialProps = arguments\[0\]/.test(petSettings)
  && /initialProps\.initialTab/.test(petSettings)
  && /function PetChatSettings\(\)/.test(panel),
  'signature intact');

/* U4：真构建不报 marker 缺失；产物带入口 */
const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-client.mjs')], {
  cwd: ROOT, encoding: 'utf8', timeout: 120000,
});
const buildOut = String(build.stdout || '') + String(build.stderr || '');
check('U4① build-client 退出码 0，没有“缺少预期标记”',
  build.status === 0 && !/缺少预期标记/.test(buildOut) && /built .*lib[\\/]client\.js/.test(buildOut),
  `status=${build.status}`);
const marker = readFileSync(join(ROOT, 'scripts', 'build-client.mjs'), 'utf8');
check('U4② 构建脚本仍以 `function PetChatSettings()` 作 marker',
  /markers: \['function AssistantSection\(\)', 'function PetChatSettings\(\)'/.test(marker),
  'marker kept');
const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
check('U4③ 构建产物里有入口 id 与默认 behavior',
  bundle.includes('we-assistant-settings-entry') && bundle.includes('initialTab'),
  'artifact has entry');

const failed = results.filter((item) => !item.ok);
console.log(`\nSETTINGS ENTRY CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
