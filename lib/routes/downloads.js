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
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createDownloadQueue } from '../download-queue.js';
export const DEPS = ['disposers', 'base', 'serveFile', 'log'];

/**
 * 与 `lib/routes/site-media.js#EXT_OK` **必须一致**：那个模块按"扩展名在白名单里就保留、
 * 否则用 `.bin`"算缓存文件名。这里查缓存时必须用同一套规则，否则永远命不中（=重复下载）。
 */
const SITE_MEDIA_EXT_OK = new Set(['.mp4', '.webm', '.mov', '.m4v', '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

/** 本地库与状态文件的位置（与其它路由同一口径：DSH_HOME 或桌面端的 harness 目录）。 */
function dshHome() {
  return process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
}

/** 进程内单例：接口与 inventory 共用同一个队列（并发上限/去重才有意义）。 */
let QUEUE = null;
function getDownloadQueue(log) {
  if (!QUEUE) QUEUE = createDownloadQueue({ home: dshHome(), log: log || (() => {}) });
  return QUEUE;
}

/** <home>/library/<kind>/<sha256>.<ext>：同一 URL 同 kind ⇒ 同一路径（幂等的前提）。 */
function libraryDest(kind, slug, ext) {
  const h = createHash('sha256').update(String(kind) + '/' + String(slug) + '/' + String(ext)).digest('hex').slice(0, 32);
  return join(dshHome(), 'library', String(kind || 'media'), h + '.' + ext);
}

/**
 * inventory 用：这条站点资源**是否已经落到本地**，以及怎么读它。
 *
 * 两个来源，都算"本地"，按代价从低到高：
 *   ① 下载队列落地（`<home>/library/<kind>/…`）⇒ `/folia/local-media/<id>`
 *   ② **site-media 缓存**（首次播放时边下边播留下的那份）⇒ 走已有的
 *      `/folia/site-media/<name>?u=…`，它命中缓存时直接 `serveFile`，**不触网**
 *
 * 为什么必须查②：站点壁纸第一次播放会经过 site-media 代理并落盘，如果这里只看①，
 * 同一份字节会被**再下载一遍**（21 MB 的包在弱网上就是"点了很久才出来"的主因），
 * 而且磁盘上存两份。
 */
export function localCopyFor(url, kind = 'wallpaper') {
  try {
    const raw = String(url);
    const u = new URL(raw);
    const ext = (u.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'bin';
    const slug = u.pathname.split('/').filter(Boolean).pop() || 'item';
    const dest = libraryDest(kind, slug, ext);
    const q = getDownloadQueue();
    const job = q.snapshot().find((j) => j.dest === dest);
    if (job && job.status === 'done') {
      return { id: job.id, url: `/folia/local-media/${job.id}`, bytes: job.total, source: 'library' };
    }
    // ② site-media 缓存：键算法必须与 lib/routes/site-media.js#keyFor **逐字一致**
    //    （`sha256(url)[:32] + 规范化扩展名`），否则永远命不中。
    const key = createHash('sha256').update(raw).digest('hex').slice(0, 32)
      + (SITE_MEDIA_EXT_OK.has('.' + ext.toLowerCase()) ? '.' + ext.toLowerCase() : '.bin');
    const cached = join(dshHome(), 'cache', 'site-media', key);
    if (existsSync(cached)) {
      const name = raw.split('/').pop() || 'media';
      return {
        id: key,
        url: '/folia/site-media/' + encodeURIComponent(name) + '?u=' + encodeURIComponent(raw),
        bytes: (() => { try { return statSync(cached).size; } catch { return 0; } })(),
        source: 'site-media-cache',
      };
    }
    return null;
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
