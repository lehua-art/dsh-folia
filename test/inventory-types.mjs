/**
 * inventory-types.mjs — 站点条目**类型判定**的行为测试。
 *
 * 为什么单独立一条：实测踩过 —— 站点上的 WE **工程包**（`mime: application/zip`、`kind: dynamic`）
 * 被老顺序判成 `video`，于是几十 MB 的 zip 被塞进 `<video>`，用户看到的是
 * 「浏览器无法解码这段视频」。
 *
 * 判据咬三件事：
 *   ① zip ⇒ `package`（不是 video），`playable === false`，`unsupportedReason === 'we-package'`；
 *   ② 真视频 / 真图片照旧判对（不许为了修 zip 把正常条目判错）；
 *   ③ 负对照：老顺序（kind=dynamic 优先）在同一条目上必须判成 video —— 证明判据咬的是真差别。
 *
 * 用纯函数级判据（`foliaTypeOfEntry` / `foliaItemFromCatalog`）：走 HTTP 要伪造缓存目录与时点，
 * 脆弱且与判据无关。
 */
import assert from 'node:assert/strict';
import { foliaTypeOfEntry, foliaItemFromCatalog } from '../lib/routes/inventory.js';

const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

const BASE = 'https://folia-5ve.pages.dev';
/** 与 /api/public/wallpapers 实测响应同形的夹具。 */
const PACKAGE = { slug: 'we-package', title: 'WE 工程包', kind: 'dynamic', mime: 'application/zip', url: '/media/a.zip', bytes: 1000 };
const VIDEO = { slug: 'real-video', title: '真视频', kind: 'dynamic', mime: 'video/mp4', url: '/media/b.mp4' };
const IMAGE = { slug: 'real-image', title: '真图', kind: 'image', mime: 'image/webp', url: '/media/c.webp' };
const ZIP_EXT = { slug: 'zip-by-ext', title: '后缀是 zip', kind: 'dynamic', mime: '', url: '/media/d.zip' };
const JSON_ODD = { slug: 'json-odd', title: '奇怪 mime', kind: 'dynamic', mime: 'application/json', url: '/media/e.json' };
const OCTET = { slug: 'octet', title: '八位流', kind: 'video', mime: 'application/octet-stream', url: '/media/f' };

/* ① 类型判定 */
{
  check('zip（mime=application/zip）判成 package', foliaTypeOfEntry(PACKAGE) === 'package', 'got=' + foliaTypeOfEntry(PACKAGE));
  check('真视频仍判 video', foliaTypeOfEntry(VIDEO) === 'video', 'got=' + foliaTypeOfEntry(VIDEO));
  check('真图片仍判 image', foliaTypeOfEntry(IMAGE) === 'image', 'got=' + foliaTypeOfEntry(IMAGE));
  check('没有 mime 但后缀 .zip 也判 package', foliaTypeOfEntry(ZIP_EXT) === 'package', 'got=' + foliaTypeOfEntry(ZIP_EXT));
  check('非媒体 mime（application/json）不猜成视频', foliaTypeOfEntry(JSON_ODD) === null, 'got=' + foliaTypeOfEntry(JSON_ODD));
  check('application/octet-stream 仍可按 kind 判 video', foliaTypeOfEntry(OCTET) === 'video', 'got=' + foliaTypeOfEntry(OCTET));
}

/* ② 条目形状：package 不可播放且带原因 */
{
  const pkg = foliaItemFromCatalog(PACKAGE, BASE);
  check('package 条目仍会出现在清单里（可显示、可安装）', Boolean(pkg), 'pkg=' + String(pkg));
  check('package.playable === false', pkg && pkg.playable === false, 'playable=' + (pkg && pkg.playable));
  check('package.unsupportedReason === we-package', pkg && pkg.unsupportedReason === 'we-package', 'reason=' + (pkg && pkg.unsupportedReason));
  const vid = foliaItemFromCatalog(VIDEO, BASE);
  check('video.playable === true', vid && vid.playable === true, 'playable=' + (vid && vid.playable));
  check('video.unsupportedReason 为空', vid && !vid.unsupportedReason, 'reason=' + (vid && vid.unsupportedReason));
  const odd = foliaItemFromCatalog(JSON_ODD, BASE);
  check('非媒体条目不进清单（返回 null）', odd === null, 'got=' + String(odd));
}

/* ③ 负对照：老顺序（kind 优先）会把这个 zip 判成 video */
{
  const legacy = (it) => {
    const kind = String(it.kind || '').toLowerCase();
    if (kind === 'video' || kind === 'dynamic') return 'video';
    if (kind === 'image') return 'image';
    return null;
  };
  check('negative control: 老顺序把 zip 判成 video（判据咬的是真差别）', legacy(PACKAGE) === 'video', 'legacy=' + legacy(PACKAGE));
  check('正对照: 新顺序与老顺序在同一夹具上结论不同', foliaTypeOfEntry(PACKAGE) !== legacy(PACKAGE));
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const x of results) {
  if (x.ok) process.stdout.write('  ✓ ' + x.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + x.name + (x.detail ? ' — ' + x.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
