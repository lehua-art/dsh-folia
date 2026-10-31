/**
 * routes/downloads.js — **站点资源本地化**的接口族（点击即下载，可并发）。
 *
 * 产品语义（用户明确要求，2026-10-30）：
 *   · **不用勾选**：用户点哪一条，那一条立刻开始下载；
 *   · 连点多条 ⇒ 它们**同时**在下载（队列并发上限 3，多余排队，不会互相拖死）；
 *   · 渲染方（我们 / 皮肤中心 / 播放器）只从本地取 —— 见 docs/LOCAL-FIRST-DOWNLOADS.md。
 *
 * 路由：
 *   POST /folia/downloads/add     {items:[{kind,url}]} → 入队（幂等）；返回每个条目的 job 快照
 *   GET  /folia/downloads/list                        → 全部 job 快照（状态/进度/失败原因）
 *   POST /folia/downloads/cancel  {id}                → 取消（保留 .part 供续传）
 *   GET  /folia/local-media/<id>                      → 已落地文件的字节（Range/HEAD 复用 serveFile）
 *
 * 注入契约：`disposers` / `base` / `serveFile` / `log`（队列由本模块自建单例）。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createDownloadQueue } from '../download-queue.js';
export const DEPS = ['disposers', 'base', 'serveFile', 'log'];

/** 本地库与状态文件的位置（与其它路由同一口径：DSH_HOME 或桌面端的 harness 目录）。 */
function dshHome() {
  return process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
}

/** 进程内单例：接口与 inventory 共用同一个队列（并发上限/去重才有意义）。 */
let QUEUE = null;
export function getDownloadQueue(log) {
  if (!QUEUE) QUEUE = createDownloadQueue({ home: dshHome(), log: log || (() => {}) });
  return QUEUE;
}

/** <home>/library/<kind>/<sha256>.<ext>：同一 URL 同 kind ⇒ 同一路径（幂等的前提）。 */
function libraryDest(kind, slug, ext) {
  const h = createHash('sha256').update(String(kind) + '/' + String(slug) + '/' + String(ext)).digest('hex').slice(0, 32);
  return join(dshHome(), 'library', String(kind || 'media'), h + '.' + ext);
}

/**
 * inventory 用：这条站点资源**是否已经落到本地**，以及它的 job id。
 * 命中 ⇒ inventory 把 `media` 指向 `/folia/local-media/<id>`（渲染只读本地）。
 * 未命中 ⇒ 返回 null，调用方保持原来的远端/代理地址（用户点了会先入队下载）。
 */
export function localCopyFor(url, kind = 'wallpaper') {
  try {
    const job = queueJobFor(url, kind);
    if (!job || job.status !== 'done') return null;
    return { id: job.id, url: `/folia/local-media/${job.id}`, bytes: job.total };
  } catch { return null; }
}

/**
 * 这条 URL 在下载队列里的**原始 job**（含 dest 绝对路径与状态），供 site-media 代理复用：
 * 代理拿着 dest 就能"渐进读正在增长的文件"，而不是再开一条上游连接。
 * 返回 null = 队列里没有这条（代理照旧走远端流式）。
 */
export function queueJobFor(url, kind = 'wallpaper') {
  try {
    const u = new URL(String(url));
    const ext = (u.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'bin';
    const slug = u.pathname.split('/').filter(Boolean).pop() || 'item';
    const dest = libraryDest(kind, slug, ext);
    return getDownloadQueue().jobFor(dest);
  } catch { return null; }
}

/** 队列汇总（给 /site-media-stats 用：壁纸缓存下了多少、多快）。 */
export function queueSummary() {
  try {
    const jobs = getDownloadQueue().snapshot();
    const done = jobs.filter((j) => j.status === 'done');
    return {
      jobs: jobs.length,
      done: done.length,
      bytes: done.reduce((a, j) => a + (Number(j.total) || 0), 0),
      active: jobs.filter((j) => j.status === 'running').length,
    };
  } catch { return null; }
}

export function registerDownloadsRoutes(webServer, c) {
  const { disposers, base, serveFile, log } = c;
  const downloadQueue = getDownloadQueue(log);
  const BASE = base;

  const readBody = (req, limit = 64 * 1024) => new Promise((resolve) => {
    let acc = '';
    let done = false;
    req.on('data', (d) => { if (!done) { acc += d; if (acc.length > limit) { done = true; resolve(null); } } });
    req.on('end', () => { if (!done) { done = true; try { resolve(JSON.parse(acc || '{}')); } catch { resolve(null); } } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });

  const send = (res, status, body) => {
    try {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    } catch { /* ignore */ }
  };

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/add`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readBody(req);
      const items = (body && Array.isArray(body.items)) ? body.items : [];
      if (!items.length) { send(res, 400, { ok: false, error: 'no-items' }); return; }
      const out = [];
      for (const it of items.slice(0, 64)) {
        const url = String((it && it.url) || '');
        const kind = String((it && it.kind) || 'media');
        let u;
        try { u = new URL(url); } catch { out.push({ url, ok: false, error: 'bad-url' }); continue; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') { out.push({ url, ok: false, error: 'bad-protocol' }); continue; }
        const ext = (u.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'bin';
        const slug = u.pathname.split('/').filter(Boolean).pop() || 'item';
        const dest = libraryDest(kind, slug, ext);
        const r = downloadQueue.add({ url: u.toString(), dest, kind });
        out.push({ url: u.toString(), ok: true, ...r });
      }
      send(res, 200, { ok: true, items: out });
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/list`,
    handler: (req, res) => {
      send(res, 200, { ok: true, jobs: downloadQueue.snapshot() });
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/cancel`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readBody(req);
      const id = String((body && body.id) || '');
      if (!id) { send(res, 400, { ok: false, error: 'bad-id' }); return; }
      send(res, 200, { ok: downloadQueue.cancel(id) });
    },
  }));

  // 本地库字节直出：Range / HEAD 由 serveFile 统一处理（与 /media 同一条实现）。
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${BASE}/local-media`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const id = String(req.url || '').split('?')[0].split('/').filter(Boolean).pop() || '';
      const abs = downloadQueue.pathFor(id);
      if (!abs) { send(res, 404, { ok: false, error: 'not-downloaded' }); return; }
      serveFile(abs, req, res, method === 'HEAD');
    },
  }));
}
