/**
 * verify-site-v1-sync.mjs — **4.24.0「消费站点素材网 v1 新字段」的判据矩阵**。
 *
 * 站点（`folia-admin`）从 2026-11 起把技术元数据写进 D1 并随 v1 公开：
 *   · 条目级：`fps` / `codec` / `pixFmt` / `hasAudio` / `posterUrl` / `license` / `source` / `author`
 *   · 变体级：`variants[].width` / `variants[].fps`（`label`/`height`/`bytes`/`sha256`/`url` 本来就有）
 *   · 端点级：`/api/v1/public/wallpapers`（旧 `/api/public/wallpapers` 仍可用且逐字节相同）
 *
 * 4.24.0 的插件因此要做四件事，本文件逐件钉住（每条都配"旧行为会怎样"的对照）：
 *
 *   ① **inventory 透传**：新字段原样到客户端（字段名与站点一致；唯一例外 `source`→`sourceUrl`，
 *      因为 inventory 的 `source` 已经是"站点/本机"的来源标记，见 `foliaTechFieldsOf()`）。
 *   ② **选档与解码判断改用真实数据**（`lib/variant-pick.js`）：
 *      codec 不支持 ⇒ 不走原画；fps 有值按它判、缺失才用宽度兜底（兜底要能区分出来）；
 *      「1080p 档」多一条 `fps ≤30`。判据矩阵：
 *        {4K@30 原画} ⇒ original · {4K@60 + 4K30 变体} ⇒ 4k30 ·
 *        {HEVC + 1080p} ⇒ 1080p · {fps 缺失 + width 3840} ⇒ 兜底 + `fpsSource=width-fallback`
 *   ③ **静态封面用 posterUrl**：`posterUrl` 优先、`thumbUrl` 回退（宿主 preview、客户端
 *      `weSwitchStillOf()`、download-first 海报三处同一口径；断言**最终 poster 来源**）。
 *   ④ **端点偏好 v1**：真起一个 HTTP 替身，v1 回 400/404/字段缺失 ⇒ 自动回退 v0 且功能不降级；
 *      v1 可用 ⇒ `siteApiVersion='v1'`（同时进 inventory 响应与 `/folia/diag/media-state` 的同一张表）。
 *
 * ⑤ 兼容（负对照）：站点字段**全 null** 时，行为必须与 4.23.24 完全一致 —— 拿"没有这些字段的
 *    老条目"与"字段齐全但全为 null 的新条目"喂同一条链路，行为投影必须逐字段相等。
 *
 * ⚠️ 真 HTTP 替身 + 隔离 home（`DSH_HOME` / `DSH_FOLIA_HOME` 指向临时目录）：
 *    这条判据要验的就是"请求打到哪条路径"，mock `fetch` 会把它验成实现细节。
 *
 * Usage: node test/verify-site-v1-sync.mjs
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pickVariant, normalizeVariants, codecSupported,
  CODEC_SUPPORTED_PREFIXES, TIER_1080_MAX_FPS, VARIANT_REASONS,
} from '../lib/variant-pick.js';
import { weSwitchStillOf } from '../src/video-switch.js';
import { dfLayerPlan } from '../src/download-first.js';
import { siteApiVersions } from '../lib/site-list.js';
// 代码面判据统一用共享的「剥注释」实现（行内 `//` 与注释里的旧路径不算硬编码）。
import { stripComments } from './tools/js-text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

/* ── 夹具：形状与站点 `/api/v1/public/wallpapers` 的 DTO 一致 ────────────────── */
const BASE = 'https://site.example';
/** 一条**字段齐全**的 v1 视频条目（h264，供透传判据用）。 */
const V1_ITEM = {
  slug: 'v1-full',
  title: 'v1 全字段',
  kind: 'dynamic',
  mime: 'video/mp4',
  url: '/media/v1-full.mp4',
  bytes: 42 * 1024 * 1024,
  width: 3840,
  height: 2160,
  fps: 60,
  codec: 'h264',
  pixFmt: 'yuv420p',
  hasAudio: false,
  posterUrl: '/media/v1-full.poster.webp',
  thumbUrl: '/media/v1-full.thumb.webp',
  license: 'cc-by',
  source: 'https://example.test/source-page',
  author: '画师甲',
  sha256: 'a'.repeat(64),
  variants: [{
    label: '4K30', width: 3840, height: 2160, fps: 30, bytes: 12 * 1024 * 1024,
    sha256: 'b'.repeat(64), url: '/media/v1-full-4k30.mp4',
  }],
};
/** 站点的**老形状**条目：没有 v1 技术字段（模拟还没升级的部署）。 */
const LEGACY_ITEM = {
  slug: 'legacy', title: '老条目', kind: 'dynamic', mime: 'video/mp4',
  url: '/media/legacy.mp4', bytes: 8 * 1024 * 1024,
  thumbUrl: '/media/legacy.thumb.webp',
};
/** v1 字段**全 null** 的新条目（站点还没给元数据，但端点已是新版）。 */
const NULLISH_ITEM = {
  ...LEGACY_ITEM,
  slug: 'nullish',
  title: '全 null',
  // ⚠️ 媒体地址与老条目**必须相同**：行为投影里含 `variantUrl`，URL 一变就比不出"行为相同"。
  fps: null, codec: null, pixFmt: null, hasAudio: null, posterUrl: null,
  license: null, source: null, author: null,
  variants: [],
};

/* ── ① inventory 透传 ─────────────────────────────────────────────────────── */
async function sectionPassthrough() {
  /** `foliaItemFromCatalog()` 依赖 downloads.js 的本地副本查询 ⇒ 用隔离 home 起模块。 */
  const home = mkdtempSync(join(tmpdir(), 'folia-v1-sync-'));
  process.env.DSH_HOME = home;
  process.env.DSH_FOLIA_HOME = join(home, 'folia');
  const { foliaItemFromCatalog } = await import('../lib/routes/inventory.js');

  const item = foliaItemFromCatalog(V1_ITEM, BASE);
  check('① 条目被接受（type=video）', item && item.type === 'video', item && item.type);
  if (!item) return;

  const want = {
    codec: 'h264',
    pixFmt: 'yuv420p',
    hasAudio: false,
    license: 'cc-by',
    author: '画师甲',
    sourceUrl: 'https://example.test/source-page',
    posterUrl: BASE + '/media/v1-full.poster.webp',
  };
  for (const [k, v] of Object.entries(want)) {
    check('① 透传 ' + k + '（字段名与站点一致）', item[k] === v, JSON.stringify(item[k]));
  }
  check('① 透传 fps / width / height（既有字段不受影响）',
    item.fps === 60 && item.width === 3840 && item.height === 2160,
    [item.fps, item.width, item.height].join(','));
  check('① 透传 variants[].width / fps（选档要这两项）',
    item.variants.length === 1 && item.variants[0].width === 3840
    && item.variants[0].fps === 30 && item.variants[0].height === 2160,
    JSON.stringify(item.variants[0]));

  // 静态封面：posterUrl 优先（断言**最终 preview 来源**）。
  check('① 静态封面 preview === posterUrl（poster 优先于 thumbUrl）',
    item.preview === BASE + '/media/v1-full.poster.webp', String(item.preview));
  check('① negative control：老口径（preview 直接取 thumbUrl）在同一夹具上会不同',
    BASE + '/media/v1-full.thumb.webp' !== item.preview,
    BASE + '/media/v1-full.thumb.webp');

  // 来源标记不许被站点同名字段覆盖（否则整库站点条目会被认成本机）。
  check('① 站点 `source` 不覆盖条目来源标记：item.source 仍为 folia、值落在 sourceUrl',
    item.source === 'folia' && item.sourceUrl === 'https://example.test/source-page',
    item.source + ' / ' + item.sourceUrl);

  // hasAudio 三态：false 是事实、null 才是"不知道"。
  const tri = [
    foliaItemFromCatalog({ ...V1_ITEM, hasAudio: true }, BASE).hasAudio,
    foliaItemFromCatalog({ ...V1_ITEM, hasAudio: false }, BASE).hasAudio,
    foliaItemFromCatalog({ ...V1_ITEM, hasAudio: null }, BASE).hasAudio,
  ];
  check('① hasAudio 三态（true / false / null）原样保留', tri[0] === true && tri[1] === false && tri[2] === null,
    JSON.stringify(tri));

  // 清单时刻的选档结论与入队那一枪同源：HEVC 原画 + 4K30 变体 ⇒ 选变体（不是原画）。
  const hevc = foliaItemFromCatalog({ ...V1_ITEM, codec: 'hevc' }, BASE);
  check('① 清单时刻：HEVC 原画 + 4K30 变体 ⇒ chosenVariant=4k30（reason=codec-unsupported）',
    hevc.chosenVariant === '4k30' && hevc.variantReason === 'codec-unsupported',
    hevc.chosenVariant + ' / ' + hevc.variantReason);

  const legacyItem = foliaItemFromCatalog(LEGACY_ITEM, BASE);
  const nullishItem = foliaItemFromCatalog(NULLISH_ITEM, BASE);
  /** 行为投影（不含"字段在不在"，只含"行为相关"的那几项）。 */
  const projection = (it) => ({
    type: it.type, playable: it.playable, preview: it.preview, mediaExt: it.mediaExt,
    chosenVariant: it.chosenVariant, variantReason: it.variantReason,
    variantUrl: it.variantUrl, variantHeight: it.variantHeight,
  });
  check('⑤ 站点字段全 null ⇒ 行为与老条目**逐字段相等**（4.23.24 等价）',
    JSON.stringify(projection(nullishItem)) === JSON.stringify(projection(legacyItem)),
    JSON.stringify(projection(nullishItem)) + ' vs ' + JSON.stringify(projection(legacyItem)));
  check('⑤ 负对照：投影里 preview 是**真的**来自 thumbUrl（不是空串）',
    legacyItem.preview === BASE + '/media/legacy.thumb.webp', String(legacyItem.preview));
  return home;
}

/* ── ② 选档矩阵 ───────────────────────────────────────────────────────────── */
function sectionMatrix() {
  const ORIG = 'https://site.example/media/o.mp4';
  const V4K30 = { label: '4K30', width: 3840, height: 2160, fps: 30, bytes: 12e6, url: 'https://site.example/media/o-4k30.mp4' };
  const V1080 = { label: '1080p', width: 1920, height: 1080, fps: 30, bytes: 6e6, url: 'https://site.example/media/o-1080p.mp4' };
  const pick = (o) => pickVariant({ originalUrl: ORIG, quality: 'auto', ...o });

  // 3840×2160@30 原画：真实 fps 说它没超 ⇒ 不再被降档（4.23.24 里 fps 缺失时会被猜成 4K@60）。
  const r30 = pick({
    variants: [V4K30, V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30,
  });
  check('② {3840×2160@30 原画} ⇒ original（真实 fps 下不再降档）',
    r30.chosen === 'original' && r30.reason === 'auto-original' && r30.fpsSource === 'measured',
    r30.chosen + ' / ' + r30.reason + ' / ' + r30.fpsSource);

  // 4K@60 + 同分辨率 30fps 变体 ⇒ 4K30（降帧不降分辨率）。
  const r60 = pick({
    variants: [V4K30], originalWidth: 3840, originalHeight: 2160, originalFps: 60,
  });
  check('② {3840×2160@60 + 4K30 变体} ⇒ 4k30（hifps-variant）',
    r60.chosen === '4k30' && r60.url === V4K30.url && r60.reason === 'hifps-variant',
    r60.chosen + ' / ' + r60.reason);

  // HEVC 原画 + 1080p 变体 ⇒ 1080p（codec 是事实，不是偏好）。
  const rHevc = pick({
    variants: [V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30,
    originalCodec: 'hevc',
  });
  check('② {HEVC 原画 + 1080p 变体} ⇒ 1080p（codec-unsupported）',
    rHevc.chosen === '1080p' && rHevc.url === V1080.url && rHevc.reason === 'codec-unsupported',
    rHevc.chosen + ' / ' + rHevc.reason);
  check('② negative control：同一条但仍标 h264 ⇒ 回到 original（差别只来自 codec）',
    pick({ variants: [V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30, originalCodec: 'h264' }).chosen === 'original');
  check('② h265 / av1 与 hevc 同判（支持集只有 h264）',
    codecSupported('h265') === false && codecSupported('av1') === false
    && codecSupported('H.264') === true && codecSupported('avc1.640028') === true
    && codecSupported('') === null && codecSupported(null) === null,
    JSON.stringify(['h265', 'av1', 'H.264', 'avc1.640028'].map(codecSupported)));

  // HEVC 且只有 4K30（没有 1080p）⇒ 仍要走变体（"优先 1080p → 4K30 → 原始"的第二档）。
  const rHevc4k = pick({
    variants: [V4K30], originalWidth: 3840, originalHeight: 2160, originalFps: 30,
    originalCodec: 'hevc',
  });
  check('② {HEVC + 只有 4K30} ⇒ 4k30（1080p 档缺失时落到第二档）',
    rHevc4k.chosen === '4k30' && rHevc4k.reason === 'codec-unsupported', rHevc4k.chosen);
  // HEVC 且没有任何变体 ⇒ 只能原画，理由单列（排障/自愈看得见）。
  const rHevcBare = pick({ variants: [], originalWidth: 3840, originalHeight: 2160, originalFps: 30, originalCodec: 'hevc' });
  check('② {HEVC + 无变体} ⇒ original + reason=codec-unsupported-no-variant',
    rHevcBare.chosen === 'original' && rHevcBare.reason === 'codec-unsupported-no-variant',
    rHevcBare.reason);

  // fps 缺失 ⇒ 宽度兜底（4.23.24 的兜底保留），但 fpsSource 必须点名这是推断。
  const rGuess = pick({ variants: [V4K30], originalWidth: 3840, originalHeight: 2160 });
  check('② {fps 缺失 + width 3840} ⇒ 按宽度兜底（4k30）+ fpsSource=width-fallback',
    rGuess.chosen === '4k30' && rGuess.reason === 'hifps-variant' && rGuess.fpsSource === 'width-fallback',
    rGuess.chosen + ' / ' + rGuess.reason + ' / ' + rGuess.fpsSource);
  check('② fps 缺失 + 无 4K30 ⇒ original(reason=high-fps) + fpsSource=width-fallback',
    (() => { const r = pick({ variants: [V1080], originalWidth: 3840, originalHeight: 2160 }); return r.chosen === 'original' && r.reason === 'high-fps' && r.fpsSource === 'width-fallback'; })());
  check('② fps 与宽度都缺失 ⇒ fpsSource=unknown（不猜）',
    pick({ variants: [V1080] }).fpsSource === 'unknown');

  // 「1080p 档」的帧率上限：一档 1920×1080@60 不是轻量档。
  const v1080p60 = { label: '1080p60', width: 1920, height: 1080, fps: 60, bytes: 9e6, url: 'https://site.example/media/o-1080p60.mp4' };
  const r60var = pick({ variants: [v1080p60], originalWidth: 3840, originalHeight: 2160, originalFps: 30, hostSlow: true });
  check('② 1080p@60 变体不算「1080p 档」（慢链路也不降它）',
    r60var.chosen === 'original' && TIER_1080_MAX_FPS === 30, r60var.chosen);
  check('② 1080p@30 变体仍算「1080p 档」（同一条判据的另一半）',
    pick({ variants: [V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30, hostSlow: true }).chosen === '1080p');

  // 理由表：新增的两条码都在 VARIANT_REASONS 里（面板/排障按它说人话）。
  check('② VARIANT_REASONS 覆盖新增的 codec 理由',
    Boolean(VARIANT_REASONS['codec-unsupported'] && VARIANT_REASONS['codec-unsupported-no-variant']));

  // 兼容：normalizeVariants 仍原样带出 width/fps（站点 null ⇒ 0，不猜）。
  const nv = normalizeVariants([{ label: 'x', width: null, height: 1080, fps: null, url: 'https://site.example/media/x.mp4' }])[0];
  check('② 变体 width/fps 缺失 ⇒ 0（不是 NaN / undefined）', nv.width === 0 && nv.fps === 0, nv.width + '/' + nv.fps);
  check('② CODEC_SUPPORTED_PREFIXES 只有 h264 家族', CODEC_SUPPORTED_PREFIXES.every((p) => /^(h26|h\.26|avc)/.test(p)));
}

/* ── ③ 静态封面 posterUrl 优先（客户端两处） ───────────────────────────────── */
function sectionPoster() {
  const poster = 'https://site.example/media/p.webp';
  const thumb = 'https://site.example/media/t.webp';

  check('③ weSwitchStillOf：posterUrl 优先于 previewUrl / preview / thumbUrl',
    weSwitchStillOf({ posterUrl: poster, previewUrl: thumb, preview: thumb, thumbUrl: thumb }) === poster,
    weSwitchStillOf({ posterUrl: poster, previewUrl: thumb, preview: thumb, thumbUrl: thumb }));
  check('③ weSwitchStillOf：posterUrl 缺席 ⇒ 回退 previewUrl（老站点等价）',
    weSwitchStillOf({ previewUrl: thumb, preview: thumb }) === thumb);
  check('③ weSwitchStillOf：全空 ⇒ 空串（调用方据此跳过，不设 undefined 到 <video>.poster）',
    weSwitchStillOf({}) === '' && weSwitchStillOf(null) === '' && weSwitchStillOf(undefined) === '');

  const planPoster = dfLayerPlan({ type: 'video', posterUrl: poster, preview: thumb }, {}, { state: 'caching' });
  const planThumb = dfLayerPlan({ type: 'video', preview: thumb }, {}, { state: 'caching' });
  check('③ download-first 的缓存层海报 = posterUrl（最终 poster 来源）',
    planPoster.mode === 'poster' && planPoster.src === poster, planPoster.mode + ' / ' + planPoster.src);
  check('③ download-first：posterUrl 缺席 ⇒ 仍是 preview（4.23.24 等价）',
    planThumb.src === thumb, planThumb.src);

  // 宿主侧：inventory 的 preview 已经是 posterUrl（上面 ① 断言过），这里钉"三处同一口径"。
  const vs = read('src/video-switch.js');
  const vl = read('src/video-layer.js');
  const df = read('src/download-first.js');
  check('③ 三处取图都认 posterUrl（video-switch / video-layer / download-first）',
    /function weSwitchStillOf/.test(vs) && /posterUrl/.test(vs)
    && /weSwitchStillOf/.test(vl) && /posterUrl/.test(df));
  check('③ 视频通道的 poster 走唯一口径（不是自己再拼一遍 previewUrl）',
    /const stillSrc = typeof weSwitchStillOf === "function"/.test(vl));
}

/* ── ④ 端点偏好：真 HTTP 替身（v1 → v0 回退） ─────────────────────────────── */
async function sectionEndpoint() {
  const home = mkdtempSync(join(tmpdir(), 'folia-v1-endpoint-'));
  process.env.DSH_HOME = home;
  process.env.DSH_FOLIA_HOME = join(home, 'folia');
  /** 站点替身的状态：`v1` / `v1-400` / `v1-404` / `v1-old-shape` / `v1-empty`。 */
  const state = { mode: 'v1' };
  const hits = [];
  const listDoc = (items) => ({ ok: true, data: { items, total: items.length, hasMore: false, nextCursor: null } });

  const server = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    hits.push(u.pathname);
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/api/v1/public/wallpapers') {
      if (state.mode === 'v1') return send(200, listDoc([V1_ITEM]));
      if (state.mode === 'v1-400') return send(400, { ok: false, error: 'bad-request' });
      if (state.mode === 'v1-404') return send(404, { ok: false, error: 'not-found' });
      if (state.mode === 'v1-old-shape') return send(200, listDoc([LEGACY_ITEM]));
      if (state.mode === 'v1-empty') return send(200, listDoc([]));
    }
    if (u.pathname === '/api/public/wallpapers') {
      // v0：老站点形状（字段全无）。v1 成功时两路径同体（站点一份实现）。
      return send(200, listDoc([state.mode === 'v1' ? V1_ITEM : LEGACY_ITEM]));
    }
    return send(404, { ok: false, error: 'nope' });
  });
  await new Promise((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen); });
  const { port } = server.address();
  process.env.DSH_FOLIA_SITE = 'http://127.0.0.1:' + port;
  process.env.DSH_FOLIA_SITE_TIMEOUT_MS = '2000';

  const { registerInventoryRoutes } = await import('../lib/routes/inventory.js');
  const routes = [];
  registerInventoryRoutes({
    register(spec) { routes.push(spec); return () => {}; },
  }, {
    disposers: [],
    base: '/folia',
    mediaOriginApi: { observeAdapter() { /* 判据不关心媒体源 */ } },
    buildInventory: async () => ({ wallpapers: [], total: 0, portableCount: 0 }),
    componentsProbe: null,
  });
  const route = routes.find((r) => r.path === '/folia/inventory');
  const callInventory = () => new Promise((resolveCall) => {
    const resObj = {
      // 真 `http.ServerResponse` 缺省就是 200；替身必须同形，否则"成功"会被读成 0。
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(s) {
        let json;
        try { json = JSON.parse(s); } catch { json = null; }
        resolveCall({ status: this.statusCode, json });
      },
    };
    // `refresh=1` ⇒ 绕过 60s 内存缓存，每次都真打站点替身。
    Promise.resolve(route.handler({ url: '/folia/inventory?refresh=1', method: 'GET', headers: {} }, resObj))
      .catch((e) => resolveCall({ status: 500, error: String(e && e.message ? e.message : e) }));
  });

  const site = (r) => (r.json && r.json.siteSource) || {};

  // ④a v1 可用 ⇒ siteApiVersion='v1'，且新字段走完整条链（HTTP 路径，不是纯函数）。
  state.mode = 'v1';
  hits.length = 0;
  const v1 = await callInventory();
  const v1Item = v1.json && (v1.json.wallpapers || []).find((x) => x.id === 'folia-v1-full');
  check('④a v1 可用 ⇒ inventory 响应 siteApiVersion=v1',
    v1.status === 200 && v1.json.siteApiVersion === 'v1' && site(v1).apiVersion === 'v1',
    v1.json && v1.json.siteApiVersion);
  check('④a v1 可用 ⇒ HTTP 链路里条目也带新字段（posterUrl / codec / variants[].fps）',
    Boolean(v1Item) && v1Item.codec === 'h264' && Boolean(v1Item.posterUrl)
    && v1Item.variants[0].fps === 30,
    v1Item && [v1Item.codec, v1Item.posterUrl, v1Item.variants[0].fps].join(' | '));
  check('④a v1 可用时不打 v0（端点偏好真的生效）',
    hits.includes('/api/v1/public/wallpapers') && !hits.includes('/api/public/wallpapers'),
    hits.join(','));

  // ④b/④c v1 400 / 404 ⇒ 回退 v0，条目仍然可用（功能不降级）。
  for (const mode of ['v1-400', 'v1-404']) {
    state.mode = mode;
    hits.length = 0;
    const r = await callInventory();
    const items = (r.json && r.json.wallpapers) || [];
    check('④ ' + mode + ' ⇒ 自动回退 v0（siteApiVersion=v0）且仍拿到条目',
      r.json && r.json.siteApiVersion === 'v0' && items.length === 1 && items[0].id === 'folia-legacy',
      (r.json && r.json.siteApiVersion) + ' / ' + items.length);
    check('④ ' + mode + ' ⇒ 回退原因记进 siteSource.apiFallbackReason',
      /^http-(400|404)$/.test(String(site(r).apiFallbackReason)), site(r).apiFallbackReason);
    check('④ ' + mode + ' ⇒ 确实请求过 v1 再请求 v0（先优先后回退）',
      hits.includes('/api/v1/public/wallpapers') && hits.includes('/api/public/wallpapers'),
      hits.join(','));
  }

  // ④d v1 200 但**字段缺失**（老实现占着新路径）⇒ 也回退 v0。
  state.mode = 'v1-old-shape';
  hits.length = 0;
  const shape = await callInventory();
  check('④d v1 200 但条目没有 v1 字段 ⇒ 判为"端点还不是 v1"并回退',
    shape.json && shape.json.siteApiVersion === 'v0' && site(shape).apiFallbackReason === 'shape',
    (shape.json && shape.json.siteApiVersion) + ' / ' + site(shape).apiFallbackReason);

  // ④e 空库也是 v1（端点可用；不能因为"没有条目可看字段"就误报 v0）。
  state.mode = 'v1-empty';
  const empty = await callInventory();
  check('④e v1 空清单 ⇒ 仍记 siteApiVersion=v1（不误报回退）',
    empty.json && empty.json.siteApiVersion === 'v1', empty.json && empty.json.siteApiVersion);

  // ④f 诊断表：`/folia/diag/media-state` 读的就是这张表。
  const versions = siteApiVersions();
  check('④f siteApiVersions 记录了 wallpaper 族的结论（诊断表非空）',
    Boolean(versions.wallpaper) && versions.wallpaper.version === 'v1',
    JSON.stringify(versions.wallpaper && versions.wallpaper.version));
  const diag = read('lib/routes/downloads.js');
  check('④f /diag/media-state 下发 siteApiVersion（读同一张表）',
    /path: `\$\{BASE\}\/diag\/media-state`/.test(diag) && /siteApiVersions\(\)/.test(diag));

  // 站点不可达（网络层失败）⇒ 不多花一个超时去试 v0，也不谎报 v0。
  state.mode = 'v1';
  server.close();
  await new Promise((r) => { setTimeout(r, 50); });
  const dead = await callInventory();
  check('④g 站点不可达 ⇒ 不谎报 v0（siteApiVersion=null）且本机库照常返回',
    dead.status === 200 && dead.json && dead.json.siteApiVersion === null,
    dead.json && String(dead.json.siteApiVersion));
  return { server, home };
}

/* ── ⑤ 端点偏好的**接线**（四族不许再各写一条硬编码路径） ─────────────────── */
function sectionWiring() {
  const files = ['lib/routes/inventory.js', 'lib/routes/skins.js', 'lib/routes/pets.js', 'lib/routes/boot.js'];
  for (const f of files) {
    const src = read(f);
    check('⑤ ' + f + ' 用 siteListFetch（端点偏好只有一份实现）', /siteListFetch\(/.test(src));
  }
  /**
   * "硬编码旧端点"的判据：**引号开始、后面紧跟 `?` 或引号**的路径字面量。
   * 只看代码（剥注释）—— 注释里提到旧路径是正常的（解释回退），不算硬编码。
   */
  const hardcodedV0 = (code) => /['"]\/api\/public\/wallpapers(?:\?|['"`])/.test(code);
  const hardcoded = files.filter((f) => hardcodedV0(stripComments(read(f))));
  check('⑤ 四族里**没有**任何硬编码的旧端点字面量（negative control 同一条判据）',
    hardcoded.length === 0, hardcoded.join(',') || 'none');
  const fake = "const url = base + '/api/public/wallpapers?category=x';";
  check('⑤ negative control: 旧写法能被同一条判据判出', hardcodedV0(fake));
  const siteList = read('lib/site-list.js');
  check('⑤ site-list.js 同时声明 v1 / v0 两条路径', /SITE_LIST_V1_PATH = '\/api\/v1\/public\/wallpapers'/.test(siteList)
    && /SITE_LIST_V0_PATH = '\/api\/public\/wallpapers'/.test(siteList));
  check('⑤ site-list.js 的 v1 字段表与站点 DTO 同名（8 项）',
    /'fps', 'codec', 'pixFmt', 'hasAudio', 'posterUrl', 'license', 'source', 'author',/.test(siteList));
}

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */
/** 临时 home 台账：测试结束统一清理（绝不留用户真实 home 的痕迹）。 */
const homes = [];
try {
  homes.push(await sectionPassthrough());
  sectionMatrix();
  sectionPoster();
  homes.push(await sectionEndpoint());
  sectionWiring();
} catch (err) {
  console.error('TEST ERROR:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
} finally {
  for (const h of homes) {
    if (!h) continue;
    try { rmSync(h, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0
  ? 'ALL SITE-V1-SYNC CHECKS PASSED (' + results.length + ')'
  : failed.length + '/' + results.length + ' CHECK(S) FAILED'));
process.exit(failed.length === 0 ? 0 : 1);
