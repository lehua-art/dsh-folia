#!/usr/bin/env node
/**
 * e2e-wallpaper-path.mjs — **7 步真实操作路径**（4.25.0 核心 6 条的整体验收）。
 *
 * ⚠️ **不在 `run-guards` 门禁里**：它要起真站点（HTTP 字节）+ 真路由 + 真下载队列，几十秒级，
 * 属于"发布前手动复跑"的脚本。守卫侧的等价判据是 `test/verify-wallpaper-core.mjs`
 * （B1–B6 + Q2/Q3 × 正/负对照，秒级，进门禁）。两者共用同一套判据口径，不各写一份期望。
 *
 * 按用户点鼠标的顺序执行，每步打印 `PASS/FAIL` + 关键数字（queued 数 / 角标数 /
 * localReady 数 / chosenVariant），退出码 0/1。整体允许**重试 1 次**（网络波动），重试会打印。
 *
 *   ① 清空媒体      → inventory 全 `localReady=false`、角标数量 = 0
 *   ② 不点任何壁纸  → `queued == 0`（连续 3 次采样）
 *   ③ 点 1 张       → `queued == 1`、该 job `priority=high`
 *   ④ 点第 2 张     → 前一张降 `low` 且**字节不归零**、`queued` 仍 == 2
 *   ⑤ 切回第 1 张   → 进度值来自 `/downloads/list`（与快照一致，不归零）
 *   ⑥ 下载完成      → 角标「已缓存」数量 == inventory `localReady` 数量
 *   ⑦ 选档          → 4K@60 ⇒ `4k30`；超分辨率 ⇒ `1080p`；HEVC ⇒ `1080p`
 *
 * Usage: `node scripts/e2e-wallpaper-path.mjs`
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTestHome, cleanupTestHome } from '../test/tools/isolate-home.mjs';
import { installWeTShim } from '../test/tools/weT-shim.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); });
/** 环境变量写在函数里（不写在 `await` 之后的对象成员上，避免 require-atomic-updates 误报）。 */
const setEnv = (name, value) => { process.env[name] = String(value); };

const results = [];
const step = (n, name, ok, detail) => {
  results.push({ n, name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | 步骤' + n + ' ' + name + ' | ' + (detail == null ? '' : detail));
};

function fakeMp4(total = 4096, fill = 7) {
  const b = Buffer.alloc(total, fill);
  b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1'); b.writeUInt32BE(0x200, 12);
  b.write('mp41', 16, 'latin1'); b.write('isom', 20, 'latin1');
  b.writeUInt32BE(total - 32, 32); b.write('moov', 36, 'latin1');
  return b;
}
/**
 * a/b 是"点击链路"的两个大文件：**必须够大 + 服务端限速**，否则本机回环会在第 2 次点击
 * 之前就把第 1 张下完，B3 的"前一张仍在队列里、字节不归零"就退化成"前一张已 done"。
 */
const MP4 = {
  a: fakeMp4(2 * 1024 * 1024, 0x11), b: fakeMp4(2 * 1024 * 1024, 0x22),
  c: fakeMp4(4096, 0x33), d: fakeMp4(4096, 0x44), big: fakeMp4(4096, 0x55),
};
const SLOW_MEDIA = new Set(['a', 'b']);

/** 一次完整的 7 步运行；返回失败条数。`attempt` 用于"重试 1 次"时打印。 */
async function runOnce(attempt) {
  results.length = 0;
  const HOME = isolateTestHome('wallpaper-path', { force: true });
  process.env.DSH_FOLIA_HOME = join(HOME, 'folia');
  process.env.DSH_FOLIA_QUALITY = 'auto';
  // 限速版单流（ranged 会为同一个 URL 开多条连接，服务端限速夹具按单流写）⇒ 用单流。
  process.env.DSH_FOLIA_RANGED = 'off';
  delete process.env.DSH_FOLIA_PREFETCH;
  installWeTShim();

  const site = { origin: '' };
  const item = (name, opts = {}) => ({
    slug: 'e2e-' + name, title: '链路 ' + name, kind: 'dynamic', mime: 'video/mp4',
    url: '/media/' + name + '.mp4', bytes: MP4[name].length,
    width: opts.width || 1920, height: opts.height || 1080,
    fps: opts.fps == null ? 30 : opts.fps, codec: opts.codec || 'h264', pixFmt: 'yuv420p',
    hasAudio: false, posterUrl: '/media/' + name + '-poster.webp', thumbUrl: '/media/' + name + '-thumb.webp',
    license: 'cc0', source: 'https://example.test/' + name, author: '画师甲',
    sha256: sha256(MP4[name]), variants: opts.variants || [],
  });
  const srv = createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const json = (body) => { res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (u.pathname === '/api/v1/public/wallpapers' || u.pathname === '/api/public/wallpapers') {
      const items = [
        item('a'), item('b'), item('c'), item('d'),
        item('big', {
          width: 3840, height: 2160, fps: 60,
          variants: [{ label: '4k30', width: 3840, height: 2160, fps: 30, bytes: MP4.big.length, url: '/media/big-4k30.mp4', sha256: sha256(MP4.big) }],
        }),
      ];
      return json({ ok: true, data: { items, total: items.length, hasMore: false, nextCursor: null, facets: { categories: [], tags: [], subtags: [] } } });
    }
    if (u.pathname.startsWith('/media/')) {
      const name = u.pathname.slice(7);
      const key = name.replace(/-poster\.webp$|-thumb\.webp$|-4k30\.mp4$|\.mp4$/, '');
      const buf = name.endsWith('.webp') ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') : (MP4[key] || null);
      if (!buf) { res.statusCode = 404; res.end('nope'); return; }
      res.statusCode = 200;
      res.setHeader('content-type', name.endsWith('.webp') ? 'image/webp' : 'video/mp4');
      res.setHeader('content-length', String(buf.length));
      if (String(req.method || 'GET').toUpperCase() === 'HEAD') { res.end(); return; }
      // 点击链路的大文件按 64 KiB / 25ms 限速（≈2.5 MB/s，2 MB 约 0.8s）—— 足以让第 2 次点击
      // 落在第 1 张"还在下"的窗口里，而不是本机回环瞬间下完。
      if (SLOW_MEDIA.has(key)) {
        let off = 0;
        const tick = () => {
          if (res.destroyed || res.writableEnded) return;
          const end = Math.min(off + 64 * 1024, buf.length);
          res.write(buf.subarray(off, end));
          off = end;
          if (off >= buf.length) { res.end(); return; }
          const t = setTimeout(tick, 25);
          if (t && typeof t.unref === 'function') t.unref();
        };
        tick();
        return;
      }
      res.end(buf);
      return;
    }
    res.statusCode = 404; res.end('nope');
  });
  await new Promise((ok) => { srv.listen(0, '127.0.0.1', ok); });
  site.origin = 'http://127.0.0.1:' + srv.address().port;
  setEnv('DSH_FOLIA_SITE', site.origin);
  setEnv('DSH_FOLIA_SITE_TIMEOUT_MS', '4000');

  const { registerDownloadsRoutes, getDownloadQueue } = await import('../lib/routes/downloads.js');
  const { registerCacheRoutes } = await import('../lib/routes/cache.js');
  const { registerInventoryRoutes } = await import('../lib/routes/inventory.js');
  const { pickVariant } = await import('../lib/variant-pick.js');

  const routes = [];
  const webServer = { register(spec) { routes.push(spec); return () => {}; } };
  const disposers = [];
  const serveFile = (abs, req, res, head) => {
    let buf; try { buf = readFileSync(abs); } catch { res.statusCode = 404; res.end('missing'); return; }
    res.statusCode = 200; res.setHeader('content-length', String(buf.length)); res.end(head ? '' : buf);
  };
  registerDownloadsRoutes(webServer, { disposers, base: '/folia', serveFile, log: () => {} });
  registerCacheRoutes(webServer, { disposers, base: '/folia', log: () => {} });
  registerInventoryRoutes(webServer, {
    disposers, base: '/folia', mediaOriginApi: { observeAdapter() {} },
    buildInventory: async () => ({ wallpapers: [], total: 0, portableCount: 0 }), componentsProbe: null,
  });
  const call = (path, { method = 'GET', body = null, url = null } = {}) => new Promise((done) => {
    const exact = routes.find((r) => r.path === path);
    const route = exact || routes.filter((r) => r.kind === 'prefix' && path.startsWith(r.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!route) { done({ statusCode: 0, body: '' }); return; }
    const res = {
      statusCode: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
      end(s) { this.body = s; done(this); },
    };
    const req = new EventEmitter();
    req.method = method; req.url = url || path; req.headers = {};
    Promise.resolve(route.handler(req, res)).catch(() => { res.statusCode = 500; done(res); });
    setImmediate(() => { try { if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); } catch { /* 已响应 */ } });
  });
  const jsonOf = (res) => { try { return JSON.parse(String(res.body || '')); } catch { return null; } };

  const queue = getDownloadQueue();
  const inventory = async () => {
    const doc = jsonOf(await call('/folia/inventory', { url: '/folia/inventory?refresh=1' }));
    return (doc && doc.wallpapers) || [];
  };
  const itemOf = (items, name) => items.find((x) => x && String(x.id) === 'folia-e2e-' + name) || null;
  const rowOf = (id) => queue.snapshot().find((j) => j && j.id === id) || null;
  const waitJob = async (id, pred, ms = 20000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { const r = rowOf(id); if (r && pred(r)) return r; await sleep(40); }
    return rowOf(id);
  };
  const add = async (it) => {
    const doc = jsonOf(await call('/folia/downloads/add', {
      method: 'POST',
      body: { items: [{ url: it.media, kind: 'wallpaper', bytes: it.bytes, width: it.width, height: it.height, fps: it.fps, codec: it.codec, variants: it.variants || [], priority: 'high' }] },
    }));
    return doc && doc.items && doc.items[0];
  };

  // 浏览器半边：用**真实视图函数**数角标。
  globalThis.React = globalThis.React || { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) };
  globalThis.dlJobActive = (j) => Boolean(j) && (j.status === 'running' || j.status === 'queued');
  globalThis.dlProgressDetail = () => '';
  globalThis.dlQueueDetail = () => '排队中…';
  globalThis.dlFailReason = () => '';
  const WP = await import('../src/wallpaper-progress.js');
  const DF = await import('../src/download-first.js');
  const badges = (items, jobs) => items.filter((it) => {
    const v = WP.wpViewOf(it, jobs || [], 0);
    return Boolean(v) && v.phase === 'cached' && v.card === '已缓存';
  }).length;
  const ready = (items) => items.filter((it) => it && it.localReady === true).length;

  try {
    /* ① 清空媒体（用小的 c/d 制造"已缓存"，别把限速的 a/b 先下完） */
    const inv0 = await inventory();
    const seedC = await add(itemOf(inv0, 'c'));
    const seedD = await add(itemOf(inv0, 'd'));
    await waitJob(seedC.job.id, (r) => r.status === 'done' || r.status === 'failed');
    await waitJob(seedD.job.id, (r) => r.status === 'done' || r.status === 'failed');
    await inventory();
    await call('/folia/cache/clear', { method: 'POST', body: { targets: ['library'] } });
    const inv1 = await inventory();
    step(1, '清空媒体 ⇒ inventory 全 false、角标 0',
      ready(inv1) === 0 && badges(inv1, queue.snapshot()) === 0,
      'localReady=' + ready(inv1) + ' 角标=' + badges(inv1, queue.snapshot()) + ' 条目=' + inv1.length);

    /* ② 不点任何壁纸：连续 3 次采样 queued == 0 */
    const samples = [];
    for (let i = 0; i < 3; i += 1) { await sleep(120); samples.push(queue.queueCounts().queuedCount); }
    step(2, '不点任何壁纸 ⇒ queued 恒 0（3 次采样）',
      samples.every((n) => n === 0), 'queued 采样=' + JSON.stringify(samples) + ' pending=' + queue.queueCounts().pendingCount);

    /* ③ 点 1 张（a 是限速大文件 ⇒ 点完它会真的在 running，而不是瞬间 done） */
    const inv2 = await inventory();
    const clickA = await add(itemOf(inv2, 'a'));
    const jA = clickA.job;
    await waitJob(jA.id, (r) => Number(r.received) > 0 || r.status === 'done', 8000);
    const active1 = queue.snapshot().filter((j) => j.status === 'queued' || j.status === 'running');
    step(3, '点 1 张 ⇒ queued==1 且 priority=high',
      active1.length === 1 && jA.priority === 'high' && active1[0].id === jA.id,
      'queued/running=' + active1.length + ' priority=' + jA.priority + ' queuePos=' + (active1[0].queuePos));

    /* ④ 点第 2 张：真实客户端状态机先给 A 发 low（不 cancel/pause），再入队 B */
    const bytesOf = (row) => {
      if (!row) return 0;
      const p = row.status === 'done' ? row.dest : row.dest + '.part';
      try { return statSync(p).size; } catch { return 0; }
    };
    const rowA0 = rowOf(jA.id);
    const bytesBefore = Math.max(bytesOf(rowA0), Number(rowA0 && rowA0.received) || 0);
    DF.dfBegin({ id: 'A', title: 'A', media: itemOf(inv2, 'a').media });
    DF.dfApplyJob(rowA0);
    const leave = DF.dfLeaveSelection('B', {
      demote: (payload) => call('/folia/downloads/priority', { method: 'POST', body: payload }),
    });
    const clickB = await add(itemOf(inv2, 'b'));
    const jB = clickB.job;
    // 入队/降级都是异步 HTTP，给一拍让 snapshot 收敛（40ms 轮询最多 2s）。
    let rowA = rowOf(jA.id);
    let active2 = [];
    for (let i = 0; i < 50; i += 1) {
      rowA = rowOf(jA.id);
      active2 = queue.snapshot().filter((j) => j.status === 'queued' || j.status === 'running');
      if (rowA && rowA.priority === 'low' && active2.length === 2
        && (rowA.status === 'running' || rowA.status === 'queued')) break;
      await sleep(40);
    }
    const bytesAfter = Math.max(bytesOf(rowA), Number(rowA && rowA.received) || 0);
    const foreign = active2.filter((j) => j.id !== jA.id && j.id !== jB.id);
    step(4, '点第 2 张 ⇒ 前一张 low、未取消、字节不归零、队列只有这 2 张',
      Boolean(leave) && leave.priority === 'low'
        && rowA && (rowA.status === 'running' || rowA.status === 'queued')
        && rowA.priority === 'low' && rowA.status !== 'cancelled'
        && bytesBefore > 0 && bytesAfter >= bytesBefore && foreign.length === 0 && active2.length === 2,
      'priority=' + (rowA && rowA.priority) + ' 状态=' + (rowA && rowA.status)
        + ' 字节=' + bytesBefore + '→' + bytesAfter + ' 活跃=' + active2.length + ' 外来=' + foreign.length);

    /* ⑤ 切回第 1 张：进度来自 /downloads/list（真快照；不是本地计时器从 0 起） */
    const itemA = itemOf(inv2, 'a');
    WP.wpPushJobs(queue.snapshot());
    const rowNow = rowOf(jA.id);
    const listPercent = Number(rowNow && rowNow.percent) || 0;
    let seen = null;
    const off = WP.wpSubscribe(itemA, (v) => { if (seen == null) seen = v; });
    off();
    const snap = WP.wpSnapshotOf(itemA);
    step(5, '切回 ⇒ 进度来自队列快照（与 /downloads/list 一致、不归零）',
      Boolean(rowNow) && rowNow.status === 'running' && listPercent > 0
        && seen && seen.percent === listPercent && snap && snap.percent === listPercent,
      'list=' + listPercent + '% 订阅=' + (seen && seen.percent) + '% 快照=' + (snap && snap.percent) + '%');

    /* ⑥ 下完 ⇒ 角标数量 == localReady 数量 */
    await waitJob(jA.id, (r) => r.status === 'done' || r.status === 'failed');
    await waitJob(jB.id, (r) => r.status === 'done' || r.status === 'failed');
    const inv3 = await inventory();
    const lr = ready(inv3);
    const bc = badges(inv3, queue.snapshot());
    step(6, '下载完成 ⇒ 角标「已缓存」数量 == inventory localReady 数量',
      lr >= 2 && bc === lr, '角标=' + bc + ' localReady=' + lr + '（无 job 时角标=' + badges(inv3, []) + '）');

    /* ⑦ 选档：用清单真实条目 */
    const inv4 = await inventory();
    const bigRow = await add(itemOf(inv4, 'big'));
    const p1080 = pickVariant({
      variants: [{ label: '1080p', width: 1920, height: 1080, fps: 30, bytes: 100, url: site.origin + '/media/a-1080p.mp4' }],
      base: site.origin + '/media/a.mp4', originalUrl: site.origin + '/media/a.mp4',
      originalBytes: 4096, quality: 'auto', hostSlow: false, screenHeight: 2160,
      originalWidth: 5916, originalHeight: 2530, originalFps: 30, originalCodec: 'h264',
    });
    // HEVC：Chromium 解不开 ⇒ 必须避开原画。**有 1080p 变体时**才谈得上"换档"；没有变体时
    // 宿主只标明原因（`codec-unsupported-no-variant`），不会假装能修 —— 两种形态都验。
    const hevc1080 = [{ label: '1080p', width: 1920, height: 1080, fps: 30, bytes: 100, url: site.origin + '/media/a-1080p.mp4' }];
    const pHevc = pickVariant({
      variants: hevc1080, base: site.origin + '/media/a.mp4', originalUrl: site.origin + '/media/a.mp4',
      originalBytes: 4096, quality: 'auto', hostSlow: false, screenHeight: 1080,
      originalWidth: 1920, originalHeight: 1080, originalFps: 30, originalCodec: 'hevc',
    });
    const pHevcNoVar = pickVariant({
      variants: [], base: site.origin + '/media/a.mp4', originalUrl: site.origin + '/media/a.mp4',
      originalBytes: 4096, quality: 'auto', hostSlow: false, screenHeight: 1080,
      originalWidth: 1920, originalHeight: 1080, originalFps: 30, originalCodec: 'hevc',
    });
    step(7, '选档：4K@60 ⇒ 4k30；超分辨率 ⇒ 1080p；HEVC ⇒ 1080p',
      bigRow && bigRow.chosenVariant === '4k30' && p1080.chosen === '1080p' && pHevc.chosen === '1080p'
        && /codec/i.test(String(pHevcNoVar.reason)),
      '4K@60=' + (bigRow && bigRow.chosenVariant) + ' 超分辨率=' + p1080.chosen + ' HEVC(有变体)=' + pHevc.chosen + ' HEVC(无变体)=' + pHevcNoVar.chosen + '/' + pHevcNoVar.reason);

    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (failed.length
      ? '✗ ' + failed.length + ' / ' + results.length + ' 步未通过（第 ' + attempt + ' 次尝试）'
      : '✓ 7 步全部通过（第 ' + attempt + ' 次尝试）'));
    return failed.length;
  } finally {
    try { srv.close(); } catch { /* ignore */ }
    cleanupTestHome(HOME);
  }
}

let bad = await runOnce(1);
if (bad > 0) {
  console.log('\n⚠️ 第 1 次有 ' + bad + ' 步未通过 —— 网络波动重试 1 次…\n');
  bad = await runOnce(2);
}
process.exit(bad ? 1 : 0);
