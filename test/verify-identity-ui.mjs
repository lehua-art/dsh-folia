/**
 * verify-identity-ui.mjs — pre.71 身份文案 + 两处 UI 文案删除 + 能力作者预览图。
 *
 * 任务单四项：
 *   A. 插件身份文案（package.json displayName/description + README 首屏副标题）覆盖现状；
 *   B. 侧栏插件卡删除旧副标题，标题 + 数量徽标仍在；
 *   C. 「壁纸引擎」设置页删除「官方资源路径」整块（宿主路由 / inventory 字段保留）；
 *   D. 能力详情按 item.source 推作者仓库 OG 预览图；非 GitHub 无图；失败不露裂图。
 *
 * 判据组织：纯函数（capPreviewUrl）直接执行；渲染器用最小 React 替身展开
 * CapabilityCard 看真实渲染树；源码断言只钉"删干净/接线在"这类结构事实。
 *
 * Usage: node test/verify-identity-ui.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

const pkg = JSON.parse(read('package.json'));
const readme = read('README.md');
const client = read('src/client.js');
const coreI18n = read('src/i18n-copy-core.js');
const panelI18n = read('src/i18n-copy-panel.js');
const wallpaperTab = read('src/panel-tabs-wallpaper.js');
const workTab = read('src/panel-tabs-work.js');
const chromeCss = read('src/styles-chrome.js');
const hostRoute = read('lib/routes/we-assets.js');
const inventory = read('lib/inventory.js');

// ══ A. 身份文案 ═══════════════════════════════════════════════════════════════
{
  check('package.json displayName 改为「Folia · 壁纸引擎与 AI 桌宠」',
    pkg.displayName === 'Folia · 壁纸引擎与 AI 桌宠', pkg.displayName);
  const desc = String(pkg.description || '');
  const tokens = ['壁纸', 'AI 桌宠', '人设', '皮肤', '开机动画', '能力'];
  check('package.json description 语义覆盖壁纸 / AI 桌宠 / 人设 / 皮肤 / 开机动画 / 能力',
    tokens.every((t) => desc.includes(t)), desc);
  check('package.json description 不再只写旧的 WE 壁纸 + 皮肤',
    !/^DSH 壁纸引擎：本机 WE 壁纸实时渲染/.test(desc), desc);
  check('README 首屏标题同步为「Folia · 壁纸引擎与 AI 桌宠」',
    /^# Folia · 壁纸引擎与 AI 桌宠$/m.test(readme));
  check('README 首屏副标题覆盖 AI 桌宠语音 / 多人设 / 皮肤 / 开机动画 / 能力市场',
    /AI 桌宠语音助手/.test(readme) && /多人设角色卡/.test(readme)
    && /皮肤与开机动画/.test(readme) && /能力市场/.test(readme),
    (readme.match(/^<p>([^<]*)<\/p>$/m) || [])[1] || '');
}

// ══ B. 侧栏插件卡副标题删除 ═══════════════════════════════════════════════════
{
  check('client.js 不再渲染 we-picker__card-desc',
    !client.includes('we-picker__card-desc'));
  check('client.js 不再出现旧副标题文案',
    !client.includes('本地 Wallpaper Engine 壁纸 · 液态玻璃主题'));
  check('侧栏插件卡标题 + 数量徽标仍在',
    client.includes('className: "we-picker__card-name"')
    && client.includes('className: "we-picker__card-badge"'));
  check('i18n 不再有旧副标题词条（避免死词）',
    !coreI18n.includes('"本地 Wallpaper Engine 壁纸 · 液态玻璃主题":'));
  check('styles-chrome 不再有 .we-picker__card-desc 死样式',
    !chromeCss.includes('.we-picker__card-desc'));
}

// ══ C. 「官方资源路径」整块删除；宿主面保留 ═══════════════════════════════════
{
  check('panel-tabs-wallpaper.js 不再有「官方资源路径」UI',
    !wallpaperTab.includes('官方资源路径') && !wallpaperTab.includes('weAssets'));
  check('client.js 不再有 weAssets 编辑器 transient / 保存函数',
    !client.includes('editingWeAssetsDir') && !client.includes('weAssetsDirDraft')
    && !client.includes('weAssetsError') && !client.includes('changeWeAssetsDir')
    && !client.includes('WE_ASSETS_DIR_URL'));
  check('i18n 不再有该块词条（官方资源路径 / WE assets / 状态三连 / 说明 / 保存失败）',
    !panelI18n.includes('"官方资源路径":')
    && !panelI18n.includes('"WE assets 绝对路径，留空保存=清除":')
    && !panelI18n.includes('"已启用 · 场景实时渲染取官方像素":')
    && !panelI18n.includes('"目录不可用（缺 materials/），场景实时渲染走程序化复刻":')
    && !panelI18n.includes('"未配置 · 场景实时渲染贴图走程序化复刻":')
    && !panelI18n.includes('"指向 Wallpaper Engine 安装目录的 assets（或其拷贝）":')
    && !coreI18n.includes('"保存失败：{error}":'));
  check('宿主 /we-assets-dir 路由仍保留（只删 UI 入口）',
    hostRoute.includes('/we-assets-dir') || hostRoute.includes('we-assets-dir'));
  check('宿主 inventory 仍下发 weAssetsDir / weAssetsAvailable',
    inventory.includes('weAssetsDir:') && inventory.includes('weAssetsAvailable:'));
  check('client.js 仍接收 inventory.weAssets* 字段（live 渲染可用性不受影响）',
    client.includes('weAssetsDir: data.weAssetsDir') && client.includes('weAssetsAvailable: Boolean(data.weAssetsAvailable)'));
}

// ══ D. 能力详情：作者仓库 OG 预览图 ═════════════════════════════════════════════
{
  globalThis.React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || null, children }),
    useState: () => [false, () => {}],
    useEffect: () => {},
  };
  globalThis.weT = (key) => String(key);
  const mod = await import(pathToFileURL(join(ROOT, 'src/panel-tabs-work.js')).href);
  const capCoverHue = mod.capCoverHue;
check('本地封面：同名确定性色相（0–359）',
  capCoverHue({ pkg: 'a' }) === capCoverHue({ pkg: 'a' })
  && capCoverHue({ pkg: 'a' }) >= 0 && capCoverHue({ pkg: 'a' }) < 360);
check('不再依赖外部图片（无 opengraph / 无 img 预览）',
  !/opengraph/.test(workTab) && !/预览图来自作者仓库/.test(workTab) && !/capPreviewUrl/.test(workTab));

const stateQueue = [];
globalThis.React.useState = (init) => {
  const v = stateQueue.length ? stateQueue.shift() : (typeof init === 'function' ? init() : init);
  return [v, () => {}];
};
const findNode = (root, pred) => {
  let hit = null;
  (function walk(n) {
    if (hit) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    if (pred(n)) { hit = n; return; }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  })(root);
  return hit;
};
const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  return (Array.isArray(node.children) ? node.children.filter((c) => typeof c === 'string').join(' ') : '')
    + ' ' + (Array.isArray(node.children) ? node.children.map(textOf).join(' ') : '');
};
const baseItem = { name: '示例能力', summary: '摘要', pkg: 'pkg', authorDesc: '描述', usage: '用法', icon: '🧩', section: 'fun' };

stateQueue.push(true, false);
const tree = mod.CapabilityCard({ item: baseItem });
check('渲染树：详情顶部有本地封面（图标 + 名称 + 分类）且不渲染 img',
  !findNode(tree, (n) => n.type === 'img')
  && textOf(tree).includes('示例能力') && textOf(tree).includes('娱乐'));
check('渲染树：不再出现“预览图来自作者仓库”小字', !textOf(tree).includes('预览图来自作者仓库'));
}

console.log('');
console.log((failed ? '✗ FAILED' : '✓ PASSED') + ' — ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
