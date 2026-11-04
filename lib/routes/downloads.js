/**
 * routes/downloads.js — **站点资源本地化**的接口族（点击即下载，可并发）。
 *
 * 产品语义（用户明确要求，2026-10-30）：
 *   · **不用勾选**：用户点哪一条，那一条立刻开始下载；
 *   · 连点多条 ⇒ 它们**同时**在下载（队列并发上限 3，多余排队，不会互相拖死）；
 *   · 渲染方（我们 / 皮肤中心 / 播放器）只从本地取 —— 见 docs/LOCAL-FIRST-DOWNLOADS.md。
 *
 * 路由：
 *   POST /folia/downloads/add     {items:[{kind,url,priority}], priority} → 入队（幂等）；
 *                                 返回每个条目的 job 快照。priority ∈ high / normal / low（白名单，
 *                                 非法值回落 normal）；条目级 priority 优先于批次级。
 *   GET  /folia/downloads/list                        → 全部 job 快照（状态/进度/失败原因）+ byKind 统计
 *                                                       + installStallMs（"下完但没落地"的宽容窗口，4.23.6）
 *   POST /folia/downloads/cancel  {id}                → 取消（保留 .part 供续传）
 *   GET  /folia/local-media/<id>                      → 已落地文件的字节（Range/HEAD 复用 serveFile）
 *
 * 注入契约：`disposers` / `base` / `serveFile` / `log`（队列由本模块自建单例）。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
// 优先级的**唯一**白名单与归一键都在队列模块里（HTTP 层只做校验，不再抄一份枚举）。
import { createDownloadQueue, normalizePriority, PRIORITIES } from '../download-queue.js';
// 1080p 变体选档：**纯函数**，与队列的自适应阈值共用同一个 0.6 MB/s 口径。
import { pickVariant, pickQuality } from '../variant-pick.js';
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

/**
 * 「下载已完成但没落地」的宽容窗口（4.23.6）——**宿主侧的唯一真源**。
 *
 * 为什么这条要在宿主解析：它管的是面板那条卡片的超时（`src/local-first.js` 的
 * `dlCardState` ③），而浏览器里没有 `process.env`。所以宿主读环境变量、把**数字**随
 * `/downloads/list` 一起下发，客户端只负责用（缺省时回落到同一个 90 秒常量）。
 *
 * 口径与队列/皮肤侧一致：默认 90000 ms；`DSH_FOLIA_INSTALL_STALL_MS` 覆盖；
 * **夹取 5s..30min**（比 5 秒短会把一次正常解压判成失败；比 30 分钟长就回到"永远卡住"）。
 * 非法值（非数字 / ≤0）不报错、按默认走 —— 环境变量写错不该让功能失效。
 */
const INSTALL_STALL_DEFAULT_MS = 90000;
const INSTALL_STALL_MIN_MS = 5000;
const INSTALL_STALL_MAX_MS = 30 * 60 * 1000;
export function installStallMs() {
  const raw = Number(process.env.DSH_FOLIA_INSTALL_STALL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return INSTALL_STALL_DEFAULT_MS;
  return Math.min(INSTALL_STALL_MAX_MS, Math.max(INSTALL_STALL_MIN_MS, Math.round(raw)));
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
 * 这条 URL 所在的**域**本会话实测是不是慢（< 0.6 MB/s）。
 *
 * inventory 用它来给清单时刻的变体选档提供"速度"那一半判据 —— 阈值与实测都来自队列本身
 * （`createDownloadQueue().isSlowHost`），不在上层再写一个数。
 */
export function isSlowHostUrl(url) {
  try {
    const host = new URL(String(url)).host;
    const q = getDownloadQueue();
    return Boolean(q.isSlowHost && q.isSlowHost(host));
  } catch { return false; }
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
      // 优先级：body.priority 是"这一批的默认值"，单个条目还可以各自覆盖。
      // 白名单只有 high / normal / low，别的一律回落 normal（不报错 —— 旧客户端/旧调用方
      // 根本不会带这个字段，不能因为多巴胺写成 "urgent" 就把整批下载拒掉）。
      const bodyPriority = normalizePriority(body && body.priority);
      // 1080p 选档的"质量偏好"：批次级 `quality`（`auto`/`original`/`saver`），
      // 缺省读环境级设置 `DSH_FOLIA_QUALITY`（未设 = auto，与 4.23.3 的行为一致）。
      const bodyQuality = pickQuality((body && body.quality) || process.env.DSH_FOLIA_QUALITY);
      const out = [];
      for (const it of items.slice(0, 64)) {
        const url = String((it && it.url) || '');
        const kind = String((it && it.kind) || 'media');
        const priority = normalizePriority((it && it.priority) || bodyPriority);
        let u;
        try { u = new URL(url); } catch { out.push({ url, ok: false, error: 'bad-url' }); continue; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') { out.push({ url, ok: false, error: 'bad-protocol' }); continue; }
        /**
         * **1080p 变体选档**（4.23.4，策略 A 自动）。
         *
         * 决策只做一次、就在入队这一刻，而且用的是**纯函数**（`lib/variant-pick.js`）：
         *   · `variants` 由调用方从 inventory 条目原样带回（站点还没上线该字段时它缺席 ⇒ 原画）；
         *   · `hostSlow` 取队列自己 3 秒实测的慢域标记（同一个 0.6 MB/s 阈值，不重复量一次）；
         *   · `screenHeight` 由客户端上报（取不到就只按速度判）；
         *   · `quality` 单项可覆盖（「用原画」按钮走的就是这条），缺省读环境级 `DSH_FOLIA_QUALITY`。
         * 结论写进 job（`chosenVariant`），`/downloads/list` 与排障读同一个事实。
         */
        const pick = pickVariant({
          variants: it && it.variants,
          base: it && it.base,
          originalUrl: u.toString(),
          originalBytes: Number(it && it.bytes) || 0,
          quality: (it && it.quality) || bodyQuality,
          hostSlow: (() => { try { return downloadQueue.isSlowHost(u.host); } catch { return false; } })(),
          screenHeight: Number((it && it.screenHeight) || (body && body.screenHeight)) || 0,
        });
        const finalUrl = pick.url || u.toString();
        // 选中变体时 URL 会变（原画 → 1080p，或反过来）：解析失败就退回请求里那个，
        // **绝不因为一条变体数据把整次下载拒掉**。
        let fu;
        try { fu = new URL(finalUrl); } catch { fu = u; }
        if (fu.protocol !== 'http:' && fu.protocol !== 'https:') { out.push({ url, ok: false, error: 'bad-protocol' }); continue; }
        const ext = (fu.pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || 'bin';
        const slug = fu.pathname.split('/').filter(Boolean).pop() || 'item';
        const dest = libraryDest(kind, slug, ext);
        const r = downloadQueue.add({
          url: fu.toString(), dest, kind, priority, chosenVariant: pick.chosen,
        });
        out.push({
          url: fu.toString(), ok: true, priority,
          // 选档结论随条目一起回去（客户端据此显示「1080p」小标，不用再猜）。
          chosenVariant: pick.chosen, variantReason: pick.reason,
          originalUrl: u.toString(),
          ...r,
        });
      }
      send(res, 200, { ok: true, items: out, priorities: PRIORITIES });
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/downloads/list`,
    handler: (req, res) => {
      // `jobs` 保持数组形状（既有契约）；`byKind` 是 4.23.2 新增的按类统计
      // （每类 running / queued / limit），面板排障与"皮肤有没有被壁纸挤掉"的取证都看它。
      // `installStallMs`（4.23.6）是"下完但没落地"的宽容窗口：**宿主解析、客户端用**
      // （浏览器里没有 process.env）。多一个标量字段，形状仍是向后兼容的。
      const jobs = downloadQueue.snapshot();
      send(res, 200, { ok: true, jobs, byKind: jobs.byKind || {}, installStallMs: installStallMs() });
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
