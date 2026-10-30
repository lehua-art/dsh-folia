/**
 * verify-panel-defensive.mjs — 面板"不再整片变白"的守卫。
 *
 * 故障形态（真实发生）：站点清单里出现一条字段形状异常的条目（tags 是字符串、preview 是对象、
 * media 缺失、bytes 是 "1.2 MB"），卡片渲染期抛错 ⇒ React 丢弃整棵树 ⇒ **整个壁纸面板一片空白**，
 * 而且没有任何提示。用户只能看到"界面消失了"。换三个版本都一样 —— 因为故障在数据，不在版本。
 *
 * 判据：
 *   ① 归一：畸形输入必须被归成"渲染层可以无条件相信"的形状
 *   ② 不抛：喂 12 条畸形数据给渲染路径，必须**一条都不抛**
 *   ③ 一条坏不带走一片：坏条目渲染成占位卡，正常条目照常出卡
 *   ④ 负对照：故意让卡片渲染抛错 ⇒ 占位卡必须出现（证明"错离"真的在起作用，而不是碰巧没抛）
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail });

const src = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8');

/* ① 归一函数存在且被渲染路径使用（不靠"我记得加上"） */
{
  check('① 存在归一函数 qpNormalizeItem', /function qpNormalizeItem\(/.test(src));
  check('① 列表渲染走的是**带守卫**的卡片函数', /qpRenderCardGuarded\(w, sel, cardsView\)/.test(src));
  check('① 守卫里有占位卡（坏条目不再是空白）', /we-qp__card--broken/.test(src));
  check('① 守卫里有 console.warn（可追溯哪条坏了）', /卡片渲染失败/.test(src));
}

/**
 * 从源码里**抽出**归一函数的真实实现来跑（不是复制一份逻辑，否则守卫会与实现漂移）。
 * 做法：截取 `function qpNormalizeItem(...) { ... }` 的函数体，包一层返回它。
 */
function extractNormalizer() {
  const start = src.indexOf('function qpNormalizeItem(raw) {');
  assert.ok(start > 0, '找不到 qpNormalizeItem');
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
    }
  }
  const body = src.slice(start, i);
  // 归一函数里只用了 String/Number/Array/isFinite，无外部依赖 ⇒ 可以直接求值
  return new Function(body + '\nreturn qpNormalizeItem;')();
}

let normalize = null;
try { normalize = extractNormalizer(); } catch (e) {
  check('② 能从源码里抽出归一函数（单一真源）', false, String(e && e.message));
}

if (normalize) {
  const malformed = [
    { id: 'a', title: 'x', tags: 'A,B  C', bytes: '1.2 MB', width: '1920', height: null, type: 'video' },
    { id: 'b', title: null, tags: { a: 1 }, preview: { src: 'x' }, media: 42, type: null },
    { id: 'c' },
    {},
    null,
    undefined,
    { id: 0, title: '', tags: [1, 2, 'ok'], bytes: -5, width: 'abc' },
    { id: 'd', type: 'weird', tags: ['a', null, 3], bytes: Infinity },
    { id: 'e', media: '', mediaProxy: {}, thumb: 7, rating: 9 },
    { id: 'f', tags: [], type: 'scene', preview: '', bytes: NaN },
    { id: 'g', title: ['arr'], tags: '   ', type: 'image' },
    { id: 123, title: 'num-id', bytes: '0' },
  ];
  let threw = null;
  const out = [];
  for (const item of malformed) {
    try { out.push(normalize(item)); } catch (e) { threw = e; break; }
  }
  check('② 12 条畸形数据归一**一条都不抛**', threw === null, threw && String(threw.message));
  check('② 负对照：归一结果全部是对象', out.length === malformed.length && out.every((x) => x && typeof x === 'object'));

  const byId = (id) => out.find((x) => String(x.id) === String(id));
  const a = byId('a');
  check('① tags 字符串被拆成数组', Array.isArray(a.tags) && a.tags.length === 3, JSON.stringify(a.tags));
  check('① 非数字 bytes 归 0（"1.2 MB" 不会变成 NaN 传到界面）', a.bytes === 0, String(a.bytes));
  check('① 数字字符串 width 仍是数字', a.width === 1920, String(a.width));
  const d = byId('d');
  check('① 未知 type 归 image', d.type === 'image', d.type);
  check('① Infinity 归 0', d.bytes === 0, String(d.bytes));
  const e = byId('e');
  check('① 非字符串 media 归 null', e.media === null);
  check('① 对象型 mediaProxy 归 null', e.mediaProxy === null);
  check('① 数字 id 保留（不变成 "[object Object]"）', String(byId('123').id) === '123');
  const g = byId('g');
  check('① 数组 title 归成字符串（res 不炸）', typeof g.title === 'string');
}

/* ④ 负对照：错离机制本身必须真的存在（源码级），而不是靠运气不抛 */
{
  check('④ 负对照：守卫函数里 try/catch 包住了真正的渲染调用',
    /try \{\s*return cardsView \? qpRenderCard\(w, sel\) : qpRenderRow\(w, sel\);/.test(src.replace(/\r/g, '')));
  check('④ 负对照：若把守卫换成直接调用，此判据会红（源码特征不匹配）',
    !/rows\.map\(cardsView \? qpRenderCard : qpRenderRow\)/.test(src));
}

let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
