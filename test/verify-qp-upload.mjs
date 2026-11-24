/**
 * verify-qp-upload.mjs — 侧栏「壁纸」页签的本地上传入口（pre.70）。
 *
 * 任务单：在搜索框右边加「⬆ 上传本地」（隐藏 file input、可多选）、复用
 * `src/client.js` 的 `uploadWallpaperFile(file)`、串行上传 + 进度、成功后来源切「本机」、
 * 支持拖拽上传；宿主 `UPLOAD_EXT` 只认 jpg/png/mp4 时**不得**放开 webp/gif/avif/webm。
 *
 * 为什么既跑函数又读源码：
 *   · 串行编排 / 进度 / 失败不中断 / drop 取文件 / 进度文案都是纯逻辑 —— 直接执行
 *     `src/quick-panel.js` 里的实现（vm 沙箱只替身 React 与 WE_FEATURE_TABS）才能测出
 *     "并发把 transient 覆盖掉"这类源码看着没问题的错。
 *   · 按钮位置 / 真 `<button>` / accept 清单 / 来源切换挂点 / 样式断点属于结构事实，
 *     用源码锚点 + i18n 词表对账钉住。
 *
 * Usage: node test/verify-qp-upload.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { stripExportBlocks } from './tools/js-text.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

const qpSrc = read('src/quick-panel.js');
const styles = read('src/styles-quick.js');
const clientSrc = read('src/client.js');
const hostDirs = read('lib/media/media-dirs.js');

// ══ ① 执行 quick-panel 的纯编排 / 拖拽 / 文案实现 ════════════════════════════
// 只替身掉模块顶层就会读到的两个自由名字；上传链路本身一个都不碰。
const sandbox = {
  WE_FEATURE_TABS: [],
  React: {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => ({ type, props: props || null, children }),
    useRef: (v) => ({ current: v }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  },
  localStorage: { getItem: () => null, setItem: () => {} },
  // 与 i18n 运行时同口径的插值（键原样返回时便于断言键名本身）。
  weT: (key, params) => (params
    ? String(key).replace(/\{(\w+)\}/g, (_, k) => String(params[k]))
    : String(key)),
  console,
};
const qpBody = stripExportBlocks(qpSrc)
  + '\n;({ QP_UPLOAD_ACCEPT, qpUploadFilesSequential, qpDroppedFiles, qpUploadProgressText,'
  + ' QpUploadControl, qpRenderUploadStatus, qpRenderViewBar })';
const qp = new Script(qpBody, { filename: 'quick-panel.js' }).runInNewContext(sandbox);
const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  return (Array.isArray(node.children) ? node.children.filter((c) => typeof c === 'string').join(' ') : '')
    + ' ' + (Array.isArray(node.children) ? node.children.map(textOf).join(' ') : '');
};

{
  check('允许格式常量 = .jpg,.jpeg,.png,.mp4（与设置页 accept 同口径）',
    qp.QP_UPLOAD_ACCEPT === '.jpg,.jpeg,.png,.mp4', qp.QP_UPLOAD_ACCEPT);
  for (const ext of ['.webp', '.gif', '.avif', '.webm']) {
    check('宿主 UPLOAD_EXT 未支持 ⇒ 不放开 ' + ext,
      !String(qp.QP_UPLOAD_ACCEPT).includes(ext));
  }
}

{
  const order = [];
  const progress = [];
  const succeeded = [];
  let active = 0;
  let maxActive = 0;
  const result = await qp.qpUploadFilesSequential(
    [{ name: 'a.jpg' }, { name: 'b.png' }, { name: 'c.mp4' }], {
    uploadOne: async (file) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(file);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { ok: true };
    },
    onProgress: (p) => progress.push({ ...p }),
    onSuccess: (file) => succeeded.push(file),
  });

  check('串行上传：调用顺序 = 选择顺序，且在途峰值恰为 1',
    order.map((f) => f.name).join(',') === 'a.jpg,b.png,c.mp4' && maxActive === 1,
    order.map((f) => f.name).join(',') + ' · max=' + maxActive);
  check('进度：开始 0/3 → 1/3 → 2/3 → 结束 3/3',
    progress.length === 4
    && progress[0].busy === true && progress[0].done === 0 && progress[0].total === 3
    && progress[1].done === 1 && progress[2].done === 2
    && progress[3].busy === false && progress[3].done === 3 && progress[3].total === 3,
    progress.map((p) => (p.busy ? 'busy' : 'idle') + ':' + p.done + '/' + p.total).join(' '));
  check('每个成功文件触发一次 onSuccess（来源切「本机」的挂点）',
    succeeded.map((f) => f.name).join(',') === 'a.jpg,b.png,c.mp4'
    && result.succeeded === 3 && result.failed === 0);
}

{
  const order = [];
  const succeeded = [];
  const result = await qp.qpUploadFilesSequential(
    [{ name: 'bad.gif' }, { name: 'ok.jpg' }], {
    uploadOne: async (file) => { order.push(file); return { ok: file.name !== 'bad.gif' }; },
    onSuccess: (file) => succeeded.push(file),
  });
  check('单个文件失败不中断这一批，且失败项不触发成功回调',
    order.map((f) => f.name).join(',') === 'bad.gif,ok.jpg'
    && result.succeeded === 1 && result.failed === 1
    && succeeded.map((f) => f.name).join(',') === 'ok.jpg',
    JSON.stringify(result));
}

{
  let called = 0;
  const result = await qp.qpUploadFilesSequential([], { uploadOne: async () => { called++; return { ok: true }; } });
  check('空选择是 no-op（不调上传、返回 0/0）',
    called === 0 && result.total === 0 && result.succeeded === 0 && result.failed === 0);
}

{
  const got = qp.qpDroppedFiles({ files: [{ name: 'a.jpg' }, { name: '' }, null, { name: 'b.mp4' }] });
  check('drop → 只取有文件名的文件（空项 / null 被丢掉）',
    got.length === 2 && got[0].name === 'a.jpg' && got[1].name === 'b.mp4');
  check('非拖拽 / 没有 files ⇒ 空数组（不抛）',
    qp.qpDroppedFiles(null).length === 0
    && qp.qpDroppedFiles({}).length === 0
    && qp.qpDroppedFiles({ files: null }).length === 0);
}

{
  check('进度文案插值成「上传中 1/3…」',
    qp.qpUploadProgressText({ busy: true, done: 0, total: 3 }) === '上传中 1/3…');
  check('进度文案不会越过总数（done=3/total=3 仍显示 3/3）',
    qp.qpUploadProgressText({ busy: true, done: 3, total: 3 }) === '上传中 3/3…');
}

// ══ ①b 渲染树（真渲染器 + 最小 React 替身）：按钮位置 / 状态行内容 ═══════════
{
  const sel = { qpSearch: '', uploadError: '', uploadNote: '' };
  const upload = {
    busy: false, progress: { busy: false, done: 0, total: 0 }, dragActive: false,
    onFiles: () => {}, onDragOver: () => {}, onDragLeave: () => {}, onDrop: () => {},
  };
  const filters = {
    cacheFilter: 'all', subtagFilter: '', subtagOptions: [], sourceFilter: 'all',
    onCacheFilterChange: () => {}, onSubtagFilterChange: () => {}, upload,
  };
  const bar = qp.qpRenderViewBar(sel, 'cards', filters, () => {});
  const top = bar && Array.isArray(bar.children) ? bar.children[0] : null;
  const topKids = top && Array.isArray(top.children) ? top.children : [];
  check('渲染树：搜索 input → 上传按钮 → 列表/卡片切换（按钮真的在搜索框右边）',
    topKids.length === 3
    && String(topKids[0].props && topKids[0].props.className).includes('we-qp__search')
    && topKids[1].type === qp.QpUploadControl
    && String(topKids[2].props && topKids[2].props.className).includes('we-qp__viewtabs'),
    topKids.map((n) => (typeof n.type === 'function' ? 'QpUploadControl' : n.type)).join(' → '));

  const kidsOf = (node) => (node && Array.isArray(node.children) ? node.children : []);
  const idleCtrl = qp.QpUploadControl({ busy: false, onFiles: () => {} });
  const idleBtn = kidsOf(idleCtrl).find((n) => n.type === 'button');
  const idleInput = kidsOf(idleCtrl).find((n) => n.type === 'input');
  check('空闲态：上传按钮可用、不在 Tab 序外（tabIndex 未设）、aria-label 完整',
    Boolean(idleBtn) && idleBtn.props.disabled === false
    && idleBtn.props.tabIndex === undefined && idleBtn.props['aria-label'] === '上传本地');
  check('隐藏 input：multiple + accept 常量 + tabIndex=-1（Tab 只停在按钮上）',
    Boolean(idleInput) && idleInput.props.multiple === true
    && idleInput.props.accept === qp.QP_UPLOAD_ACCEPT && idleInput.props.tabIndex === -1);
  const busyCtrl = qp.QpUploadControl({ busy: true, onFiles: () => {} });
  const busyBtn = kidsOf(busyCtrl).find((n) => n.type === 'button');
  const busyInput = kidsOf(busyCtrl).find((n) => n.type === 'input');
  check('上传中：按钮与隐藏 input 都禁用（不能并发起第二批）',
    busyBtn.props.disabled === true && busyInput.props.disabled === true);

  const progressNode = qp.qpRenderUploadStatus(sel, { busy: true, done: 0, total: 3 }, false);
  check('状态行渲染出「上传中 1/3…」', textOf(progressNode).includes('上传中 1/3…'));
  const dragNode = qp.qpRenderUploadStatus(sel, { busy: false, done: 0, total: 0 }, true);
  check('拖拽态渲染出「拖到这里上传」+ 格式提示',
    textOf(dragNode).includes('拖到这里上传') && textOf(dragNode).includes('仅支持 JPG / PNG / MP4'));
  const errNode = qp.qpRenderUploadStatus(
    { uploadError: '上传失败：文件过大（上限 512MB）', uploadNote: '' },
    { busy: false, done: 0, total: 0 }, false);
  check('错误态原样显示可读错误（不吞成"上传中"）',
    textOf(errNode).includes('上传失败：文件过大（上限 512MB）'));
  const noteNode = qp.qpRenderUploadStatus(
    { uploadError: '', uploadNote: '已存在相同内容的壁纸，已直接选择原有的那张' },
    { busy: false, done: 0, total: 0 }, false);
  check('重复内容提示上屏（复用既有 uploadNote 通道）',
    textOf(noteNode).includes('已存在相同内容'));
  const idleNode = qp.qpRenderUploadStatus(sel, { busy: false, done: 0, total: 0 }, false);
  check('无进度 / 无错误 / 无拖拽时状态行返回 null（不占高度）', idleNode === null);
}

// ══ ② 宿主格式契约（与客户端 UPLOAD_TYPES / accept 双向对账）════════════════
{
  const hostBlock = (hostDirs.match(/const UPLOAD_EXT = \{([^}]*)\}/) || [])[1] || '';
  const hostPairs = [...hostBlock.matchAll(/'([^']+)':\s*'([^']+)'/g)]
    .map((m) => [m[1], m[2]]);
  const hostMimes = hostPairs.map(([mime]) => mime).sort();
  const hostExts = new Set(hostPairs.map(([, ext]) => '.' + ext));
  const clientBlock = (clientSrc.match(/const UPLOAD_TYPES = \[([^\]]*)\]/) || [])[1] || '';
  const clientMimes = [...clientBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  const acceptExts = new Set(String(qp.QP_UPLOAD_ACCEPT).split(',').map((s) => s.trim()).filter(Boolean));

  check('宿主 UPLOAD_EXT 确实只有 mp4/jpeg/png（这是"不放开 webp/gif/avif/webm"的依据）',
    hostMimes.join(',') === 'image/jpeg,image/png,video/mp4', hostMimes.join(','));
  check('客户端 UPLOAD_TYPES 与宿主 UPLOAD_EXT 键集一致（上传链路没有第二份格式表）',
    clientMimes.join(',') === hostMimes.join(','), clientMimes.join(','));
  check('侧栏 accept 的扩展名覆盖宿主全部扩展名（.jpeg 是 .jpg 的同义写法）',
    [...hostExts].every((e) => acceptExts.has(e))
    && [...acceptExts].every((e) => hostExts.has(e) || e === '.jpeg'),
    'host=' + [...hostExts].join(',') + ' client=' + [...acceptExts].join(','));
}

// ══ ③ 结构事实：按钮位置 / 真 button / 隐藏多选 input / 复用上传函数 ════════
{
  const searchAt = qpSrc.indexOf('className: "we-picker__text we-qp__search"');
  const uploadAt = qpSrc.indexOf('React.createElement(QpUploadControl');
  const tabsAt = qpSrc.indexOf('className: "we-tabs we-qp__viewtabs"');
  check('按钮渲染在搜索 input 之后、列表/卡片视图切换之前（要求的"搜索框右边"）',
    searchAt >= 0 && uploadAt > searchAt && tabsAt > uploadAt,
    'search=' + searchAt + ' upload=' + uploadAt + ' tabs=' + tabsAt);
  check('既有渲染器签名保持不变（verify-panel-interactions 按字面锚定；上传态经 filters ctx 传）',
    /function qpRenderViewBar\(sel, view, filters, switchView\)/.test(qpSrc)
    && /function qpRenderLibrarySection\(sel, view, filters, listRef/.test(qpSrc)
    && /upload: qpUpload,/.test(qpSrc));

  check('上传按钮是真 <button> + 挂钩锚点 data-we-qp-upload（键盘可 Tab / Enter）',
    /className: "we-picker__btn we-qp__uploadbtn"/.test(qpSrc)
    && /"data-we-qp-upload": "1"/.test(qpSrc)
    && /type: "button"/.test(qpSrc));
  check('隐藏 file input：type=file、multiple、accept=常量、不在 Tab 序里',
    /type: "file"/.test(qpSrc)
    && /multiple: true/.test(qpSrc)
    && /accept: QP_UPLOAD_ACCEPT/.test(qpSrc)
    && /tabIndex: -1/.test(qpSrc));
  check('点按钮转去隐藏 input（不是只画一个不能用的按钮）',
    /const el = inputRef\.current;[\s\S]*?el\.click\(\)/.test(qpSrc));
  check('复用 uploadWallpaperFile，不在 quick-panel 里重写上传',
    /await uploadWallpaperFile\(file\)/.test(qpSrc)
    && !/async function uploadWallpaperFile/.test(qpSrc)
    && !/\/folia\/upload/.test(qpSrc)
    && !/apiFetch\(/.test(qpSrc));
  check('共享上传函数仍自行 applySelection / duplicate 提示（B/C 的既有行为没被绕开）',
    /await loadInventory\(\);\s*applySelection\(data\.id\);/.test(clientSrc)
    && /if \(data\.duplicate\)/.test(clientSrc)
    && /setTransient\("uploadNote"/.test(clientSrc));
  check('共享上传函数失败后复位 uploading（不会把面板留在"上传中"）',
    /setTransient\("uploadError"[\s\S]{0,600}?setTransient\("uploading", false\)/.test(clientSrc));
  check('提交串行走 qpUploadFilesSequential，进度行接上传状态',
    /await qpUploadFilesSequential\(files, \{/.test(qpSrc)
    && /onProgress: \(p\) => setUploadState\(p\)/.test(qpSrc)
    && /qpRenderUploadStatus\(sel, upload && upload\.progress/.test(qpSrc));
  check('成功后把来源切到 local（否则刚上传的那张会被站点筛选藏起来）',
    /setSetting\("sourceFilter", "local"\)/.test(qpSrc));
  check('拖拽：列表区挂 onDragOver / onDragLeave / onDrop，并 preventDefault',
    /onDragOver: upload && upload\.onDragOver/.test(qpSrc)
    && /onDragLeave: upload && upload\.onDragLeave/.test(qpSrc)
    && /onDrop: upload && upload\.onDrop/.test(qpSrc)
    && /e\.preventDefault\(\)/.test(qpSrc));
  check('drop 的文件走同一个 runQpUpload（不另起第二条上传链）',
    /const files = qpDroppedFiles\(e\.dataTransfer\);[\s\S]{0,80}?if \(files\.length\) runQpUpload\(files\);/.test(qpSrc));
  check('防连点 + 忙碌态（state 异步，靠 ref 拦住同帧二次点击）',
    /uploadBusyRef\.current \|\| sel\.uploading/.test(qpSrc)
    && /uploadBusyRef\.current = true/.test(qpSrc)
    && /uploadBusyRef\.current = false/.test(qpSrc));
  check('上传中 / 失败都收尾为忙碌态 false（不会卡在"上传中"）',
    /finally \{[\s\S]{0,160}?setUploadState\(\(prev\) => \(\{ busy: false/.test(qpSrc)
    && /catch \(err\) \{[\s\S]{0,240}?setTransient\("uploadError"/.test(qpSrc));
}

// ══ ④ 样式：按钮不挤压搜索框 + 隐藏 input + 拖拽高亮 ═════════════════════════
{
  check('按钮 flex:none（搜索框先缩），并有窄屏只露图标的断点',
    /\.we-qp__viewbar \.we-qp__uploadbtn \{ flex: none;/.test(styles)
    && /@media \(max-width: 420px\)/.test(styles)
    && /\.we-qp__uploadbtn-label \{ display: none; \}/.test(styles));
  check('隐藏 input 用 display:none（不从布局里占位）',
    /\.we-qp__uploadfile \{ display: none; \}/.test(styles));
  check('拖拽悬停有整块列表区的视觉反馈',
    /\.we-qp__library--drop \{/.test(styles) && /outline: 1px dashed/.test(styles));
}

// ══ ⑤ i18n：新词在册、非空、无中文、占位符与键相等、且真的被 quick-panel 使用 ═
{
  const { WE_I18N_EN_PANEL } = await import(pathToFileURL(join(ROOT, 'src/i18n-copy-panel.js')).href);
  const dict = WE_I18N_EN_PANEL || {};
  const required = ['⬆ 上传本地', '上传本地', '上传中 {done}/{total}…', '拖到这里上传', '仅支持 JPG / PNG / MP4'];
  const used = new Set([...qpSrc.matchAll(/weT\("([^"]+)"/g)].map((m) => m[1]));
  const cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

  for (const key of required) {
    const value = dict[key];
    check('i18n 在册：' + key, typeof value === 'string' && value.trim() !== '', JSON.stringify(value));
    check('i18n 值纪律：' + key + ' 无中文且占位符与键相等',
      typeof value === 'string' && !cjk.test(value) && placeholders(value) === placeholders(key),
      JSON.stringify(value));
    check('词表里的新词确实被 quick-panel 使用（不是孤儿键）', used.has(key));
  }
}

// ══ ⑥ 构建产物已更新（忘了 npm run build 时这里红，而不是用户看到旧面板）════════
{
  const builtPath = join(ROOT, 'lib/client.js');
  const built = existsSync(builtPath) ? readFileSync(builtPath, 'utf8') : '';
  check('lib/client.js 含新入口的锚点与串行编排',
    built.includes('data-we-qp-upload')
    && built.includes('qpUploadFilesSequential')
    && built.includes('⬆ 上传本地'),
    built ? '' : '缺少产物：先跑 node scripts/build-client.mjs');
}

console.log('');
console.log((failed ? '✗ FAILED' : '✓ PASSED') + ' — ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
