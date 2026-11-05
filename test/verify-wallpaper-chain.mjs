/**
 * verify-wallpaper-chain.mjs — **壁纸链路稳定性**（4.24.0 的十条不变量，端到端）。
 *
 * 事故是"同一条链反复坏"：清空媒体后角标仍说已缓存、第一次点击报"无法解码"、第二次又好了、
 * 下到一半切走字节归零、坏文件被当成好文件端上屏……每一次都只修了其中一段。这一条守卫
 * 把链**从头到尾**串起来跑（真 HTTP 字节 + 真队列 + 真路由 + 隔离 home），并在每一段配
 * 有牙的负对照 —— 只改一段而破坏另一段时，这里会红。
 *
 * 覆盖的不变量（I1–I10，见交付说明）：
 *   I1 角标真实：`localReady` ⇔ 盘上存在 + 长度/结构有效（清空后立即 false）
 *   I2 播放源安全：只有 I1 成立才给 `/local-media`，否则一律站点流
 *   I3 清空一致：删文件 + 重置记录 + **清单缓存失效**（内存+落盘）+ 面板立即重拉
 *   I4 首次即对：local-media 404 ⇒ 清单回到事实 + 自动换流重试一次（用户不点第二次）
 *   I5 下载策略：download-first（海报 → 进度 → 下完校验 → 播）、切走降 low、点回升 high
 *   I6 校验来源：完成时用**当前清单**解析期望；不符 ⇒ 失败可解释（不静默 done）
 *   I7 错误分类：AbortError 连发不报错、最终仍能播；缺失/损坏/4xx 各有独立文案
 *   I8 队列透明：点击即 high 且 queuePos=1
 *   I9 脏数据自愈：重启时 done+缺失 ⇒ pending，且不批量入队
 *   I10 不污染：全程只写隔离 home
 *
 * 判据组织（a–h = 交付矩阵）：
 *   a 未缓存点击 → 海报 → 下完校验 → local-media 200 → 播（全程不拿站点流当 <video> 源）
 *   b 清空媒体 → 立即请求 inventory（localReady 全 false）→ 角标未缓存 → 再点可重下并播
 *   c 清单说已缓存但文件不存在 → 第一次点击即自愈（刷新清单 + 换流，无错误提示）
 *   d 下载中切走 → 降 low、字节不归零 → 点回升 high → 完成后可播
 *   e 选档：4K@60 → 4K30、超分辨率 → 1080p、HEVC 跳过原画
 *   f AbortError 连发 5 次不报错、最终能播
 *   g 截断/坏文件 → 校验失败 → 重下 → 可播；哈希不符 ⇒ hash-mismatch（不静默 done）
 *   h 重启（重建队列单例）→ done+缺失变 pending、queued=0
 *
 * Usage: node test/verify-wallpaper-chain.mjs
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';
import { installWeTShim } from './tools/weT-shim.mjs';
import { createDownloadQueue } from '../lib/download-queue.js';
import { pickVariant } from '../lib/variant-pick.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
function section(title) { console.log('\n══ ' + title + ' ══'); }
const between = (text, start, end) => {
  const a = text.indexOf(start);
  const b = a < 0 ? -1 : text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error('源码边界找不到：' + start);
  return text.slice(a, b);
};

/* ── 隔离 home（I10）：先落 env，再 import 任何会读盘的宿主模块 ─────────────── */
const HOME = isolateTestHome('wallpaper-chain', { force: true });
process.env.DSH_FOLIA_HOME = join(HOME, 'folia');
process.env.DSH_FOLIA_QUALITY = 'auto';
delete process.env.DSH_FOLIA_SITE_KEY;
installWeTShim();

/** 一条**结构有效**的 mp4（ftyp + moov）：对账器会验结构，占位字节会被正确判成无效。 */
function fakeMp4(total = 2048, fill = 7) {
  const b = Buffer.alloc(total, fill);
  b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1'); b.writeUInt32BE(0x200, 12);
  b.write('mp41', 16, 'latin1'); b.write('isom', 20, 'latin1');
  b.writeUInt32BE(total - 32, 32); b.write('moov', 36, 'latin1');
  return b;
}
const MP4 = { a: fakeMp4(2048, 0x11), b: fakeMp4(2048, 0x22), g: fakeMp4(2048, 0x33), m: fakeMp4(2048, 0x44) };
const POSTER = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');

/* ── 站点替身：真字节 + 真 v1 清单（端点偏好走 site-list） ─────────────────── */
const state = { origin: '', hits: [], override: new Map() };
function siteItem(name, opts = {}) {
  const media = { a: MP4.a, b: MP4.b, g: MP4.g, m: MP4.m }[name];
  return {
    slug: 'chain-' + name,
    title: '链路 ' + name,
    kind: 'dynamic',
    mime: 'video/mp4',
    url: '/media/' + name + '.mp4',
    bytes: media ? media.length : 2048,
    width: opts.width || 1920,
    height: opts.height || 1080,
    fps: opts.fps == null ? 30 : opts.fps,
    codec: opts.codec || 'h264',
    pixFmt: 'yuv420p',
    hasAudio: false,
    posterUrl: '/media/' + name + '-poster.webp',
    thumbUrl: '/media/' + name + '-thumb.webp',
    license: 'cc0',
    source: 'https://example.test/' + name,
    author: '画师甲',
    sha256: media ? sha256(media) : null,
    variants: [],
  };
}
function startSite() {
  const srv = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    state.hits.push(u.pathname);
    const json = (body, status = 200) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/api/v1/public/wallpapers' || u.pathname === '/api/public/wallpapers') {
      const items = [siteItem('a'), siteItem('b'), siteItem('c'), siteItem('g'), siteItem('m')];
      return json({ ok: true, data: { items, total: items.length, hasMore: false, nextCursor: null,
        facets: { categories: [], tags: [], subtags: [] } } });
    }
    if (u.pathname.startsWith('/media/')) {
      const name = u.pathname.slice('/media/'.length);
      let buf = null;
      if (name.endsWith('-poster.webp') || name.endsWith('-thumb.webp')) buf = POSTER;
      else if (name.endsWith('.mp4')) {
        const key = name.slice(0, -4);
        buf = state.override.has(key) ? state.override.get(key) : ({ a: MP4.a, b: MP4.b, g: MP4.g, m: MP4.m }[key] || null);
      }
      if (!buf) { res.statusCode = 404; res.end('nope'); return; }
      res.statusCode = 200;
      res.setHeader('content-type', name.endsWith('.webp') ? 'image/webp' : 'video/mp4');
      res.setHeader('content-length', String(buf.length));
      if (String(req.method || 'GET').toUpperCase() === 'HEAD') { res.end(); return; }
      res.end(buf);
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  return new Promise((ok) => {
    srv.listen(0, '127.0.0.1', () => { state.origin = 'http://127.0.0.1:' + srv.address().port; ok(srv); });
  });
}

/* ── 路由台架（真路由 + 假 webServer/req/res；serveFile 用真字节） ─────────── */
function serveFileStub(abs, req, res, head) {
  let buf;
  try { buf = readFileSync(abs); } catch { res.statusCode = 404; res.end('missing'); return; }
  res.statusCode = 200;
  res.setHeader('content-length', String(buf.length));
  res.setHeader('content-type', 'video/mp4');
  res.end(head ? '' : buf);
}
function makeRouteCaller(routes) {
  return (path, { method = 'GET', body = null, url = null } = {}) => new Promise((resolveCall) => {
    // 精确优先；`/folia/local-media/<id>` / `/folia/site-media/...` 这类是 **prefix** 路由。
    const exact = routes.find((r) => r.path === path);
    const prefix = exact ? null : routes
      .filter((r) => r.kind === 'prefix' && path.startsWith(r.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const route = exact || prefix;
    if (!route) { resolveCall({ statusCode: 0, body: 'no-route:' + path }); return; }
    const res = {
      statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
      end(s) { this.body = s; resolveCall(this); },
    };
    const req = new EventEmitter();
    req.method = method;
    req.url = url || path;
    req.headers = {};
    let settled = false;
    Promise.resolve(route.handler(req, res)).catch((e) => {
      if (settled) return; settled = true;
      res.statusCode = 500; res.body = String((e && e.message) || e); resolveCall(res);
    });
    setImmediate(() => {
      try {
        if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      } catch { /* handler 可能已同步响应 */ }
    });
  });
}
const jsonOf = (res) => { try { return JSON.parse(String(res.body || '')); } catch { return null; } };

/* ── 启动：站点 → env → 动态 import 宿主模块（保证磁盘缓存路径已被隔离） ──── */
const siteSrv = await startSite();
process.env.DSH_FOLIA_SITE = state.origin;
process.env.DSH_FOLIA_SITE_TIMEOUT_MS = '4000';
const downloadsLib = await import('../lib/routes/downloads.js');
const { registerDownloadsRoutes, getDownloadQueue } = downloadsLib;
const { registerCacheRoutes } = await import('../lib/routes/cache.js');
const { registerInventoryRoutes, inventoryEpoch } = await import('../lib/routes/inventory.js');
const DF = await import('../src/download-first.js');
const MS = await import('../src/media-state.js');

const routes = [];
const webServer = { register(spec) { routes.push(spec); return () => {}; } };
const disposers = [];
const logs = [];
registerDownloadsRoutes(webServer, { disposers, base: '/folia', serveFile: serveFileStub, log: (m) => logs.push(String(m)) });
registerCacheRoutes(webServer, { disposers, base: '/folia', log: (m) => logs.push(String(m)) });
registerInventoryRoutes(webServer, {
  disposers, base: '/folia',
  mediaOriginApi: { observeAdapter() { /* 判据不关心媒体源 */ } },
  buildInventory: async () => ({ wallpapers: [], total: 0, portableCount: 0 }),
  componentsProbe: null,
});
const call = makeRouteCaller(routes);

async function inventory() {
  const res = await call('/folia/inventory', { url: '/folia/inventory?refresh=1' });
  const doc = jsonOf(res);
  return { res, doc, items: (doc && doc.wallpapers) || [] };
}
const itemOf = (items, name) => items.find((x) => x && String(x.id) === 'folia-chain-' + name) || null;
const jobRow = (id) => getDownloadQueue().snapshot().find((j) => j && String(j.id) === String(id)) || null;
async function waitJob(id, pred, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const row = jobRow(id);
    if (row && pred(row)) return row;
    await sleep(40);
  }
  return jobRow(id);
}
async function addDownload(item, extra = {}) {
  const res = await call('/folia/downloads/add', {
    method: 'POST',
    body: {
      items: [{
        url: item.media, kind: 'wallpaper', bytes: item.bytes,
        width: item.width, height: item.height, fps: item.fps, codec: item.codec,
        variants: item.variants || [], ...extra,
      }],
    },
  });
  const doc = jsonOf(res);
  return { res, doc, row: doc && doc.items && doc.items[0] };
}
const localMediaUrlOf = (jobId) => '/folia/local-media/' + jobId;

/* ══ a. 未缓存点击 → 海报 → 下完校验 → local-media 200 → 播 ═════════════════ */
section('a. 未缓存点击 → 海报（不建 <video>）→ 下载 → 校验 → local-media 200 → 播');
const invA = await inventory();
const itemA0 = itemOf(invA.items, 'a');
check('a0 inventory 拿到了站点条目（v1 字段齐全）',
  Boolean(itemA0) && itemA0.codec === 'h264' && itemA0.posterUrl.endsWith('/a-poster.webp'),
  itemA0 && (itemA0.codec + ' / ' + itemA0.posterUrl));
check('a1 未缓存：localReady=false（I1）且播放源=站点流（I2）',
  itemA0.localReady === false && MS.resolvePlaySrc(itemA0).source === 'proxy',
  String(itemA0.localReady) + ' / ' + MS.resolvePlaySrc(itemA0).source);
check('a2 静态封面用 posterUrl（4.24.0 的附带项）',
  itemA0.preview === state.origin + '/media/a-poster.webp', String(itemA0.preview));
check('a3 download-first 判定：未缓存站点视频 ⇒ 该走「先下载再播」',
  DF.dfShouldCache(itemA0, { playbackPolicy: 'download-first' }) === true);
const planCaching = DF.dfLayerPlan(itemA0, { playbackPolicy: 'download-first' }, { state: 'caching' });
check('a4 缓存中：层里是<海报>、**没有 <video>**（I5；<video> 从未指向站点流）',
  planCaching.mode === 'poster' && planCaching.src === itemA0.preview,
  planCaching.mode + ' / ' + planCaching.src);

const addA = await addDownload(itemA0);
const jobA = addA.row && addA.row.job;
check('a5 /downloads/add 入队成功（high）', Boolean(jobA && jobA.id), addA.row && addA.row.ok);
const doneA = await waitJob(jobA.id, (r) => r.status === 'done' || r.status === 'failed');
check('a6 下载完成且**按当前清单的 sha256 校验通过**（I6）',
  doneA && doneA.status === 'done' && doneA.verified === 'sha256',
  doneA && (doneA.status + ' / verified=' + doneA.verified + ' / err=' + doneA.error));
const localA = await call('/folia/local-media/' + jobA.id);
check('a7 /local-media 回 200 且字节与站点一致（I1 的"存在且完整"）',
  localA.statusCode === 200 && Buffer.isBuffer(localA.body) && sha256(localA.body) === sha256(MP4.a),
  localA.statusCode + ' / ' + (Buffer.isBuffer(localA.body) ? localA.body.length : 'not-buffer'));

const invA2 = await inventory();
const itemA1 = itemOf(invA2.items, 'a');
check('a8 下完之后清单说已缓存（localReady=true）且代理指向本地副本（I1/I2）',
  itemA1.localReady === true && itemA1.mediaProxy === '/folia/local-media/' + jobA.id,
  itemA1.localReady + ' / ' + itemA1.mediaProxy);
const planPlaying = DF.dfLayerPlan(itemA1, { playbackPolicy: 'download-first' },
  { state: 'playing', localUrl: '/folia/local-media/' + jobA.id });
check('a9 播放计划：<video> 指向本地副本、**不是 /site-media**',
  planPlaying.mode === 'video' && planPlaying.src === '/folia/local-media/' + jobA.id
  && !/\/site-media\//.test(planPlaying.src), planPlaying.mode + ' / ' + planPlaying.src);
check('a10 客户端解析器同样给本地（source=local）', MS.resolvePlaySrc(itemA1).source === 'local',
  MS.resolvePlaySrc(itemA1).source);

/* ══ b. 清空媒体：三段一致失效 + 角标 + 再点可播 ════════════════════════════ */
section('b. 清空媒体（I3）：清单缓存失效 + 角标立即「未缓存」+ 再点可下可播');
const diskCacheFile = join(process.env.DSH_FOLIA_HOME, 'cache', 'site-items.json');
check('b1 下载成功后清单落盘（site-items.json 在盘上）', existsSync(diskCacheFile), diskCacheFile);
const epochBefore = inventoryEpoch();
const clearRes = await call('/folia/cache/clear', { method: 'POST', body: { targets: ['library'] } });
const clearDoc = jsonOf(clearRes);
check('b2 /cache/clear 回执带 inventoryInvalidated=true（客户端据此重拉清单）',
  clearRes.statusCode === 200 && clearDoc && clearDoc.inventoryInvalidated === true,
  clearRes.statusCode + ' / ' + (clearDoc && clearDoc.inventoryInvalidated));
check('b3 清单缓存代际 +1（内存+落盘都作废）',
  Number(clearDoc && clearDoc.inventoryEpoch) === epochBefore + 1 && !existsSync(diskCacheFile),
  'epoch ' + epochBefore + '→' + (clearDoc && clearDoc.inventoryEpoch) + ' disk=' + existsSync(diskCacheFile));
const invB = await inventory();
const allRemote = invB.items.filter((x) => x && String(x.source) === 'folia');
check('b4 清空后**立即**请求 inventory：所有站点条目 localReady=false（I1/I3）',
  allRemote.length >= 4 && allRemote.every((x) => x.localReady === false),
  allRemote.length + ' 条 / true 数=' + allRemote.filter((x) => x.localReady).length);
check('b5 清空后 local-media 不再可播：解析器给站点流（I2）',
  MS.resolvePlaySrc(itemOf(invB.items, 'a')).source === 'proxy');

const addB = await addDownload(itemOf(invB.items, 'a'));
const doneB = await waitJob(addB.row.job.id, (r) => r.status === 'done' || r.status === 'failed');
check('b7 清空后重下：done + sha256 校验通过（I5/I6）',
  doneB && doneB.status === 'done' && doneB.verified === 'sha256',
  doneB && doneB.status + ' / ' + doneB.verified);
const localB = await call('/folia/local-media/' + addB.row.job.id);
check('b8 重下后 /local-media 200 且字节一致', localB.statusCode === 200 && sha256(localB.body) === sha256(MP4.a),
  localB.statusCode);

/* ── 角标 / 标题栏（P0-A）与旧错误清理（P0-B）─────────────────────────────── */
// `wallpaper-progress.js` 是浏览器半边的行内模块（global weT / React / dl* 文案函数）
// ⇒ 单独 import 时补最小身份层（与 weT-shim 同一套"中文原样"口径）。
globalThis.React = globalThis.React || {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
};
globalThis.dlJobActive = (j) => Boolean(j) && (j.status === 'running' || j.status === 'queued');
globalThis.dlProgressDetail = (job, eta) => {
  const r = (Number(job && job.received) || 0) / 1048576;
  const t = (Number(job && job.total) || 0) / 1048576;
  const pct = t > 0 ? Math.round((r / t) * 100) : 0;
  return r.toFixed(1) + '/' + t.toFixed(1) + ' MB · 约剩 ' + String(eta) + ' 秒';
};
globalThis.dlQueueDetail = () => '排队中…';
globalThis.dlFailReason = () => '';
const WP = await import('../src/wallpaper-progress.js');
const nodeText = (n) => (n == null ? '' : (typeof n === 'string' ? n
  : nodeText(n.children && n.children.length ? n.children[0] : '') || String((n.props && n.props.title) || '')));
const runningJob = { id: 'jp', url: itemA0.media, kind: 'wallpaper', status: 'running', percent: 27, received: 12.9 * 1048576, total: 48.5 * 1048576 };
const titleNode = WP.wpTitleRender(WP.wpViewOf(itemA0, [runningJob], 6), itemA0);
check('P0-A1 缓存的进度节点是**标题栏行内元素**（`we-picker__hint we-wp-title`，非 fixed 浮层）',
  Boolean(titleNode) && /we-picker__hint/.test(String(titleNode.props.className))
  && /we-wp-title/.test(String(titleNode.props.className))
  && !titleNode.props.style, titleNode && titleNode.props.className);
check('P0-A2 标题栏进度文案带百分比与「约剩」（与元信息同一处显示）',
  /缓存中 27%/.test(nodeText(titleNode)) && /约剩 6 秒/.test(nodeText(titleNode)), nodeText(titleNode));
check('P0-A3 下完（已缓存）⇒ 标题栏进度节点消失', WP.wpTitleRender(WP.wpViewOf(itemA0, [{ ...runningJob, status: 'done' }], 0), itemA0) === null);
check('P0-A4 切走（该条目不再高亮/没有 job）⇒ 标题栏不显示它的进度',
  WP.wpTitleRender(WP.wpViewOf(itemA0, [], 0), itemA0) === null);
check('P0-A5 页面里**不存在**居中浮层（覆盖层 DOM 已退役，源码里零创建点）',
  !/createElement\("div"\)[\s\S]{0,200}we-switch-hint/.test(read('src/video-switch.js'))
  && !/"position:fixed;left:50%;bottom:14%/.test(read('src/video-switch.js'))
  && !/we-switch-hint/.test(read('src/styles-panel.js') + read('src/styles-base.js')));
check('P0-A6 进度显示在标题栏的元信息容器里（`we-qp__meta` 之后紧跟 QpCacheHint）',
  /className: "we-qp__meta"[\s\S]{0,1600}React\.createElement\(QpCacheHint, \{ item: current \}\)/.test(read('src/quick-panel.js')));
check('P0-A7 面板「当前壁纸」那一行仍以**行内 hint** 显示 mediaNote（不是浮层）',
  /sel\.mediaNote && React\.createElement\("div", \{ className: "we-picker__hint" \}, sel\.mediaNote\)/.test(read('src/panel-tabs-wallpaper.js')));

// P0-B：进入 playing ⇒ 清空旧错误/旧提示/元素级拒绝标记；换条目 ⇒ 新条目不带上一张的文案。
const clientBody = read('src/client.js');
const svBlock = between(clientBody, 'function syncVideoState(video)', '/* ── 播放失败自愈');
const faults = [];
const sel = { videoPlaying: false, videoError: '浏览器无法解码这段视频', mediaNote: '正在缓存 27%' };
const SV = new Function('setTransient', 'emit', 'selection', 'videoPlaybackError', 'playRefusalMessage',
  svBlock + '\nreturn syncVideoState;')(
  (k, v) => { faults.push({ k, v }); sel[k] = v; },
  () => {}, sel,
  () => '', () => '',
);
const okVideo = { paused: false, ended: false, error: null, dataset: { wePlayRefused: 'NotSupportedError', wePlayAbortRetried: '1' } };
SV(okVideo);
check('P0-B1 先失败再成功 ⇒ 成功后旧错误/旧提示被清空（DOM 只剩「播放中」）',
  sel.videoError === '' && sel.mediaNote === '', JSON.stringify({ err: sel.videoError, note: sel.mediaNote }));
check('P0-B2 元素级拒绝/重试标记一并清掉（下一轮不再拦住播放）',
  okVideo.dataset.wePlayRefused === undefined && okVideo.dataset.wePlayAbortRetried === undefined,
  JSON.stringify(okVideo.dataset));
check('P0-B3 换条目时新条目不得继承上一条文案（idChanged 清两个瞬态字段）',
  /if \(idChanged\) \{\s*selection\.videoError = "";\s*selection\.mediaNote = "";\s*\}/.test(read('src/media-prep.js')));
check('P0-B4 池元素换源时清拒绝标记（B 不背 A 的判决）',
  /delete el\.dataset\.wePlayRefused; delete el\.dataset\.wePlayAbortRetried;/.test(read('src/video-switch.js')));

const staleSnapshot = { ...itemA1 };   // 清空前那份 client 快照（localReady=true）
const clearedJobs = getDownloadQueue().snapshot().map((j) => ({ ...j, status: j.status === 'done' ? 'pending' : j.status }));
const freshSnapshot = itemOf(invB.items, 'a');
check('b9 negative control：**不重拉清单**时角标仍说「已缓存」（这就是用户看到的现象）',
  WP.wpStateOf(staleSnapshot, clearedJobs).phase === 'cached'
  && WP.wpViewOf(staleSnapshot, clearedJobs, 0).card === '已缓存',
  WP.wpViewOf(staleSnapshot, clearedJobs, 0).card);
check('b10 重拉后的快照：角标「未缓存」（I3 的可见结论）',
  WP.wpStateOf(freshSnapshot, clearedJobs).phase === 'pending'
  && WP.wpViewOf(freshSnapshot, clearedJobs, 0).card === '未缓存',
  WP.wpViewOf(freshSnapshot, clearedJobs, 0).card);
const clientSrc = read('src/client.js');
check('b11 面板清空后**真的**重拉清单（I3 接线：inventoryInvalidated / 代际 / library）',
  /const needInventory = d\.inventoryInvalidated === true/.test(clientSrc)
  && /await loadInventory\(\);/.test(clientSrc)
  && /inventoryEpoch/.test(clientSrc));

/* ══ c. 清单说已缓存但文件不存在 → 第一次点击即自愈 ═══════════════════════ */
section('c. 清单说已缓存但文件不存在（I4）：刷新清单 + 换流重试一次，无错误提示');
const itemA2 = itemOf((await inventory()).items, 'a');
const staleA = {
  ...itemA2,
  localReady: true,
  mediaState: { ...(itemA2.mediaState || {}), jobStatus: 'done', fileExists: true, fileValid: true, localReady: true },
};
check('c1 negative control：陈旧快照（localReady=true）会让解析器去播本地副本（I2 的边界）',
  MS.resolvePlaySrc(staleA).source === 'local', MS.resolvePlaySrc(staleA).source);
// 外部删除：只删文件、不动 job 状态（清空媒体之外的现实路径）。
const destA = getDownloadQueue().pathFor(jobA.id) || join(HOME, 'library', 'wallpaper', 'a.mp4');
rmSync(destA, { force: true });
const invC = await inventory();
const itemA3 = itemOf(invC.items, 'a');
check('c2 宿主侧即时判真（I1）：文件被删后**同一份清单**立刻 localReady=false（不等对账）',
  itemA3 && itemA3.localReady === false, itemA3 && String(itemA3.localReady));
const headMissing = await call('/folia/local-media/' + jobA.id, { method: 'HEAD' });
check('c3 HEAD 本地副本 ⇒ 404（客户端据此判"文件丢了"）', headMissing.statusCode === 404, headMissing.statusCode);
// 客户端判据：纯函数 + 真兜底函数（源码块直接跑，不复制逻辑）
const lfSrc = read('src/local-first.js');
const planFn = new Function(between(lfSrc, 'function lfStaleLocalPlan(', '/**\n * 本地副本 URL → 可代播的站点地址')
  + '\nreturn { lfStaleLocalPlan };')().lfStaleLocalPlan;
const fallbackBlock = between(lfSrc, 'function lfLocalMediaJobId(', '/**\n * **播放失败自愈的客户端入口**');
const calls = [];
const LF = new Function('apiPostJson', 'lfSay', fallbackBlock
  + '\nreturn { lfLocalMediaJobId, lfLocalMediaProxyFor, lfLocalMediaFallback };')(
  (path, body) => { calls.push({ path, body }); return Promise.resolve({ ok: true }); },
  () => {},
);
const plan404 = planFn({ url: '/folia/local-media/' + jobA.id, headStatus: 404 });
check('c4 404 的处置计划 = 刷新清单 + 用站点流重试一次（I4）',
  plan404.missing === true && plan404.refreshInventory === true && plan404.useProxy === true,
  JSON.stringify(plan404));
check('c5 文件在（HEAD 200）时**不**刷新清单（刷新只治"清单说谎"）',
  planFn({ url: '/folia/local-media/x', headStatus: 200 }).refreshInventory === false);
check('c6 非本地地址 ⇒ 不接管（交给自愈取证）',
  planFn({ url: 'https://site.test/x.mp4', headStatus: 404 }).missing === false);
const el = { src: '', load() { this.loaded = true; }, play() { return Promise.resolve(); } };
const proxyUrl = LF.lfLocalMediaFallback(el, jobA.id, localMediaUrlOf(jobA.id), staleA);
check('c7 兜底把元素切到站点流（不是再撞一次 404）且复位 job',
  /^https?:\/\//.test(proxyUrl) && proxyUrl === state.origin + '/media/a.mp4'
  && el.src === proxyUrl && !/local-media/.test(el.src)
  && calls.some((c) => c.path === '/downloads/requeue' && c.body.id === jobA.id),
  el.src + ' / ' + JSON.stringify(calls.map((c) => c.path)));
check('c8 客户端接线：错误分支先判计划、刷新清单、再用新条目重试、清空 videoError（I4）',
  /const plan = typeof lfStaleLocalPlan === "function"/.test(clientSrc)
  && /refreshInventoryAfterLocalMissing\(id\)/.test(clientSrc)
  && /lfLocalMediaFallback\(el, lfLocalMediaJobId\(url\), url, newItem \|\| staleItem\)/.test(clientSrc)
  && /setTransient\("videoError", ""\)/.test(clientSrc));
check('c9 池里预热中的元素（不在屏）也会进 404 兜底（I4 的"第一次点击"根因）',
  /const el = onScreenVideo\(video\) \|\| \(\/\\\/local-media\\\/\/\.test\(rawSrc\) \? video : null\);/.test(clientSrc));
const proxyNow = await (async () => {
  try {
    const r = await fetch(proxyUrl);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, bytes: buf.length };
  } catch { return { status: 0, bytes: 0 }; }
})();
check('c10 站点流兜底地址本身可用（真取到与站点一致的字节）',
  proxyNow.status === 200 && proxyNow.bytes === MP4.a.length,
  proxyNow.status + ' / ' + proxyNow.bytes);

/* ══ d. 下载中切走 → 降 low、字节不归零 → 点回升 high（I5/I8） ════════════ */
section('d. 下载中切走：降 low 继续下、字节不归零；点回升 high 且 queuePos=1');
const slowSrv = createServer((req, res) => {
  // 必须是**结构有效**的 mp4：完成那一刻对账器会验结构，占位字节会被正确判成 pending。
  const body = fakeMp4(768 * 1024, 5);
  res.statusCode = 200;
  res.setHeader('content-type', 'video/mp4');
  res.setHeader('content-length', String(body.length));
  let at = 0;
  const timer = setInterval(() => {
    if (at >= body.length) { clearInterval(timer); try { res.end(); } catch { /* ignore */ } return; }
    const chunk = body.subarray(at, at + 24 * 1024);
    at += chunk.length;
    try { res.write(chunk); } catch { clearInterval(timer); }
  }, 12);
  req.on('close', () => { try { clearInterval(timer); } catch { /* ignore */ } });
});
await new Promise((ok) => { slowSrv.listen(0, '127.0.0.1', ok); });
const slowOrigin = 'http://127.0.0.1:' + slowSrv.address().port;
const q = getDownloadQueue();
const slowJob = q.add({
  url: slowOrigin + '/media/slow.mp4', dest: join(HOME, 'library', 'wallpaper', 'slow.mp4'),
  kind: 'wallpaper', priority: 'high',
}).job;
let running = null;
for (let i = 0; i < 200 && !running; i += 1) {
  const row = q.snapshot().find((j) => j.id === slowJob.id);
  if (row && row.status === 'running' && Number(row.received) > 0) running = row;
  else await sleep(30);
}
check('d1 点击入队 = high 且在跑', Boolean(running) && running.priority === 'high', running && running.status + '/' + running.priority);
const beforeBytes = running ? Number(running.received) : 0;
const demoted = q.setPriority({ id: slowJob.id, priority: 'low' });
check('d2 切走 ⇒ 降 low，但**不暂停/不取消**（仍在跑）',
  demoted && demoted.priority === 'low' && demoted.status === 'running',
  demoted && demoted.status + '/' + demoted.priority);
check('d3 已下字节不归零（I5）',
  demoted && demoted.id === slowJob.id && Number(demoted.received) >= beforeBytes && Number(demoted.received) > 0,
  beforeBytes + ' → ' + (demoted && demoted.received));
const back = q.add({ url: slowJob.url, dest: join(HOME, 'library', 'wallpaper', 'slow.mp4'), kind: 'wallpaper', priority: 'high' }).job;
check('d4 点回 ⇒ 同一个 job 升回 high（不新建、不重下）',
  back && back.id === slowJob.id && back.priority === 'high', back && back.priority);
const boosted = q.setPriority({ id: slowJob.id, priority: 'high' });
check('d5 点击后再升 high 不改变 job 身份（队列透明的前提）',
  boosted && boosted.id === slowJob.id && boosted.priority === 'high',
  boosted && boosted.priority);
// queuePos=1 只在"排队中"这一态有意义：用一条**独立且暂停**的队列验（不干扰上面那条真下载）。
{
  const q2 = createDownloadQueue({ home: join(HOME, 'queue-case'), log: () => {} });
  q2.setPaused(true);
  const lows = [];
  for (let i = 0; i < 3; i += 1) {
    lows.push(q2.add({
      url: state.origin + '/media/q-' + i + '.mp4', dest: join(HOME, 'queue-case', 'q-' + i + '.mp4'),
      kind: 'wallpaper', priority: 'low',
    }).job);
  }
  const head = q2.setPriority({ id: lows[lows.length - 1].id, priority: 'high' });
  check('d6 点击即队首（同一 kind 同档里 queuePos=1，I8）',
    head && head.priority === 'high' && head.queuePos === 1, head && String(head.queuePos));
}
const slowDone = await waitJob(slowJob.id, (r) => r.status === 'done' || r.status === 'failed', 20000);
check('d7 降级不丢进度：最终完成且字节完整', slowDone && slowDone.status === 'done'
  && existsSync(join(HOME, 'library', 'wallpaper', 'slow.mp4')), slowDone && slowDone.status + '/' + slowDone.error);
slowSrv.close();

/* ══ e. 选档：4K30 / 1080p / HEVC ═════════════════════════════════════════ */
section('e. 选档矩阵（I5）：4K@60→4K30、超分辨率→1080p、HEVC 跳过原画');
const V4K30 = { label: '4K30', width: 3840, height: 2160, fps: 30, bytes: 12e6, url: 'https://s.test/o-4k30.mp4' };
const V1080 = { label: '1080p', width: 1920, height: 1080, fps: 30, bytes: 6e6, url: 'https://s.test/o-1080p.mp4' };
const ORIG = 'https://s.test/o.mp4';
check('e1 3840×2160@30 原画 ⇒ original（真实 fps，不再被猜成 4K@60）',
  (() => { const r = pickVariant({ originalUrl: ORIG, variants: [V4K30, V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30 });
    return r.chosen === 'original' && r.fpsSource === 'measured'; })());
check('e2 3840×2160@60 + 4K30 变体 ⇒ 4k30（降帧不降分辨率）',
  (() => { const r = pickVariant({ originalUrl: ORIG, variants: [V4K30], originalWidth: 3840, originalHeight: 2160, originalFps: 60 });
    return r.chosen === '4k30' && r.reason === 'hifps-variant'; })());
check('e3 5916×2530（超分辨率）+ 1080p ⇒ 1080p（decode-limit）',
  (() => { const r = pickVariant({ originalUrl: ORIG, variants: [V1080], originalWidth: 5916, originalHeight: 2530, originalFps: 30 });
    return r.chosen === '1080p' && r.reason === 'decode-limit'; })());
check('e4 HEVC 原画 + 1080p 变体 ⇒ 1080p（codec-unsupported）',
  (() => { const r = pickVariant({ originalUrl: ORIG, variants: [V1080], originalWidth: 3840, originalHeight: 2160, originalFps: 30, originalCodec: 'hevc' });
    return r.chosen === '1080p' && r.reason === 'codec-unsupported'; })());

/* ══ f. AbortError 连发 5 次不报错、最终能播（I7） ═════════════════════════ */
section('f. AbortError 连发 5 次不报错、最终仍能播');
const audioSrc = read('src/client-audio-playback.js');
const audioBlock = between(audioSrc, 'function isCurrentVideoEl(', '// ── 源元数据 + 抽帧转码');
const H = new Function('onScreenVideo', 'syncVideoState', 'weApplyAudio', 'isEffectivelyPlaying',
  'playRefusalBlocks', 'watchVideoState',
  audioBlock + '\nreturn { applyVideoPlayback, recoverPlayFailure, clearPlayRefusal };')(
  () => null, () => {}, () => {}, () => true, (v) => Boolean(v && v.dataset && v.dataset.wePlayRefused), () => {},
);
const video = { paused: true, ended: false, error: null, dataset: {}, loads: 0, load() { this.loads += 1; }, play() { return Promise.resolve(); } };
let attempts = 0;
// 第一阶段：连续被打断（AbortError）——静默，不显示错误，且只 load 一次。
video.play = () => { attempts += 1; return Promise.reject({ name: 'AbortError' }); };
for (let i = 0; i < 5; i += 1) { H.applyVideoPlayback(video); await sleep(5); }
check('f1 连发 5 次 AbortError 后**没有任何错误标记**（不显示"无法解码"）',
  !video.dataset.wePlayRefused, JSON.stringify(video.dataset));
check('f2 同一元素只重新 load 一次（不死循环）：5 次打断后 loads 恒为 1',
  video.loads === 1 && video.dataset.wePlayAbortRetried === '1',
  'loads=' + video.loads + ' attempts=' + attempts);
// 第二阶段：源恢复正常（play resolve）⇒ 最终能播，且拒绝/重试标记都被清掉。
video.play = () => { attempts += 1; return Promise.resolve(); };
H.applyVideoPlayback(video);
await sleep(5);
check('f3 最终 play() 成功 ⇒ 能播且标记被清掉（下一轮重新给机会）',
  video.dataset.wePlayAbortRetried === undefined && video.dataset.wePlayRefused === undefined,
  JSON.stringify(video.dataset));
check('f4 缺失/损坏/4xx 各有独立文案（不是一句"无法解码"）',
  (() => {
    const lf = read('src/local-first.js');
    return /msMarkUnavailable\(url, "local-media-missing"\)/.test(clientSrc)
      && /本地副本已丢失，正在重新下载/.test(clientSrc)
      && /校验失败（下到的字节数与站点声明的长度不一致/.test(lf)
      && /站点返回错误（\{code\}）/.test(lf)
      && /本机无法解码该视频/.test(clientSrc);
  })());

/* ══ g. 坏文件 → 校验失败 → 重下 → 可播；哈希不符 ⇒ hash-mismatch（I6/I9） ═ */
section('g. 截断/坏文件 → 校验失败 → 重下 → 可播；哈希不符不静默 done');
{
  // g-1：done + 截断 ⇒ 重启扫描把它判 pending（不能端出去），再点可重下。
  const home2 = join(HOME, 'truncated-case');
  const lib2 = join(home2, 'library', 'wallpaper');
  mkdirSync(lib2, { recursive: true });
  const destG = join(lib2, 'g.mp4');
  writeFileSync(destG, MP4.g.subarray(0, 600));   // 截断：长度对不上
  writeFileSync(join(home2, 'downloads.json'), JSON.stringify({ version: 1, jobs: [{
    id: 'g', url: state.origin + '/media/g.mp4', dest: destG, kind: 'wallpaper',
    total: MP4.g.length, status: 'done', error: null, at: 1, priority: 'low',
  }] }), 'utf8');
  const qG = createDownloadQueue({ home: home2, log: () => {} });
  // 队列自己只在"文件缺失"时折 pending；**截断**（长度不符）要由对账器判（同一份盘上证据）。
  const { createMediaReconciler } = await import('../lib/media-state.js');
  const recG = createMediaReconciler({ queue: qG, log: () => {} });
  await recG.reconcileAll({ reason: 'startup' });
  const rowG = qG.snapshot().find((j) => j.id === 'g');
  check('g1 截断文件（done+长度不符）⇒ 启动对账即 pending（I9），不占队列',
    rowG && rowG.status === 'pending' && qG.snapshot().queuedCount === 0,
    rowG && rowG.status + ' / queued=' + qG.snapshot().queuedCount);
  const reG = qG.add({ url: state.origin + '/media/g.mp4', dest: destG, kind: 'wallpaper', priority: 'high' }).job;
  const until = Date.now() + 15000;
  let doneG = null;
  while (Date.now() < until) {
    const r = qG.snapshot().find((j) => j.id === reG.id);
    if (r && (r.status === 'done' || r.status === 'failed')) { doneG = r; break; }
    await sleep(40);
  }
  const bytesG = existsSync(destG) ? readFileSync(destG) : null;
  check('g2 重下后：done + 字节与站点一致（可播）',
    doneG && doneG.status === 'done' && bytesG && sha256(bytesG) === sha256(MP4.g),
    doneG && doneG.status);
}
{
  // g-3：哈希不符（站点换内容、清单仍给旧 sha）⇒ 必须失败且可解释，不许静默 done。
  const bad = Buffer.from(MP4.m); bad[100] ^= 0xff;
  state.override.set('m', bad);
  const invG = await inventory();
  const itemM = itemOf(invG.items, 'm');
  const addM = await addDownload(itemM);
  const doneM = await waitJob(addM.row.job.id, (r) => r.status === 'done' || r.status === 'failed', 20000);
  check('g3 内容哈希不符 ⇒ failed + hash-mismatch（I6：期望值来自当前清单）',
    doneM && doneM.status === 'failed' && /hash-mismatch/.test(String(doneM.error)),
    doneM && (doneM.status + ' / ' + doneM.error));
  state.override.delete('m');
}

/* ══ h. 重启（重建队列单例）→ done+缺失变 pending、queued=0（I9） ═════════ */
section('h. 重启：done+缺失 ⇒ pending，且不批量入队');
{
  const home3 = join(HOME, 'reboot-case');
  const lib3 = join(home3, 'library', 'wallpaper');
  mkdirSync(lib3, { recursive: true });
  const jobs = [0, 1, 2].map((i) => ({
    id: 'gone-' + i, url: 'https://site.test/gone-' + i + '.mp4',
    dest: join(lib3, 'gone-' + i + '.mp4'), kind: 'wallpaper',
    total: 2048, status: 'done', error: null, at: i, priority: 'low',
  }));
  writeFileSync(join(home3, 'downloads.json'), JSON.stringify({ version: 1, jobs }), 'utf8');
  const q3 = createDownloadQueue({ home: home3, log: () => {} });
  const snap3 = q3.snapshot();
  check('h1 重启：3 条 done-缺失全部 pending（I9）',
    snap3.filter((j) => j.status === 'pending').length === 3 && snap3.filter((j) => j.status === 'done').length === 0,
    snap3.map((j) => j.status).join(','));
  check('h2 不批量入队（queuedCount = 0）', snap3.queuedCount === 0, String(snap3.queuedCount));
  check('h3 重启后本地副本不可播（I2）：文件缺失 ⇒ 没有任何 done', snap3.every((j) => j.status !== 'done'));
}

/* ══ I10：隔离（全程只写隔离 home） ═══════════════════════════════════════ */
section('I10 不污染：所有写入都在隔离 home 内');
check('I10a DSH_HOME 指向临时目录', String(process.env.DSH_HOME || '') === HOME, String(process.env.DSH_HOME));
check('I10b 站点清单磁盘缓存落在隔离 home 内',
  String(process.env.DSH_FOLIA_HOME || '').startsWith(HOME), String(process.env.DSH_FOLIA_HOME));
check('I10c 下载成品落在隔离 home 的 library/ 下',
  existsSync(join(HOME, 'library', 'wallpaper')) || existsSync(join(HOME, 'library')),
  join(HOME, 'library'));

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */
try { siteSrv.close(); } catch { /* ignore */ }
try { getDownloadQueue().setPaused(true); } catch { /* ignore */ }
cleanupTestHome(HOME);
const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0
  ? 'ALL WALLPAPER-CHAIN CHECKS PASSED (' + results.length + ')'
  : failed.length + '/' + results.length + ' CHECK(S) FAILED'));
if (failed.length) for (const f of failed) console.log('  ✗ ' + f.name);
process.exit(failed.length === 0 ? 0 : 1);
