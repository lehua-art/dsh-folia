/**
 * routes/boot.js — 开机动画的 HTTP 面：列候选 / 下载 / 选择 / 删除 / 流式播放。
 *
 * 数据来自两处：
 *   · **候选清单** = 模块索引里的 `boot` 模块（`manifest` 指向一份 `{ clips: [...] }`），
 *     站点优先、R2 兜底 —— 复用 `routes/modules.js` 的解析，不另造一套基址。
 *   · **本地文件** = `~/.dsh-folia/boot/<id>.mp4`，由「下载」写进来。
 *
 * 播放走 `/folia/boot/clip`，**支持 Range**：注入的 `<video>` 与浏览器都靠它边下边播。
 * 这也是为什么片段必须先落盘 —— 启动路径上不能有网络。
 */
import { createReadStream, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { sendJson } from '../json-response.js';
import { bodyReader } from '../http-body.js';
import { resolveModules } from './modules.js';
import { clipExists, clipFile, clipMetaFile, listLocalClips, readBoot, importLocalClip, act1ImagePath, act1ImageExists, removeClip, resolveClipFile, writeBoot } from '../boot/index.js';
// 4.24.0：站点清单端点偏好（v1 优先 / v0 回退）的唯一实现 —— 四族共用。
import { siteListFetch } from '../site-list.js';
// 4.23.3：开机动画下载改走**下载队列**（Range 续传 / 自适应多连接 / 进度可读）。
// 面板切走再回来时，卡片从 `/folia/downloads/list` 恢复「下载中… x%」，不再回到「下载」。
import { getDownloadQueue, registerManifestSource } from './downloads.js';

/**
 * 站点基址。开机动画的候选**从站点分类取**（`?category=boot-animation`），
 * 与壁纸页签用的是同一个接口 —— 站点上看到 3 条，这里就是 3 条，不会各说各话。
 */
const DEFAULT_SITE = 'https://folia-5ve.pages.dev';
const BOOT_CATEGORY = 'boot-animation';
function siteBase() {
  const raw = process.env.DSH_FOLIA_SITE;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return null;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_SITE;
  return base.replace(/\/+$/, '');
}

const CLIP_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 读完一个小 JSON 请求体。
 *
 * ⚠️ `bodyReader()` 是**流式**收体器（返回 `{ onData, text() }`），不是 Promise ——
 *    必须自己把 `req` 的 data/end 挂上去。把它 `await` 出来会拿到那个对象，
 *    `JSON.parse` 立刻抛、被 catch 成 null，于是每个写操作都报 `bad-id`。
 */
function readBodyText(req, maxBytes) {
  return new Promise((resolve) => {
    let tooLarge = false;
    const reader = bodyReader(req, { maxBytes, onOverflow: () => { tooLarge = true; } });
    const finish = () => resolve(tooLarge ? '' : reader.text());
    try {
      req.on('data', reader.onData);
      req.on('end', finish);
      req.on('error', () => resolve(''));
    } catch {
      resolve('');
    }
  });
}

/**
 * 4.23.3 起，开机动画**不再自带一套"探测 + 分段并发"下载器**：这条路径已经由下载队列
 * （`lib/download-queue.js`）统一接管 —— 它同时提供 Range 续传、**自适应多连接**
 * （高 RTT 才切多路，低 RTT 保持单流最快）、优先级与可读进度。
 * 本模块只负责"验头 + 写 meta"这一步收尾，避免出现两套下载事实。
 */

/**
 * 判定一段字节是不是**真的视频**，并给出它的 MIME。
 *
 * 为什么必须验文件头而不是 content-type：站点对未知路径会回退 index.html 并以 200 返回，
 * 这种"伪视频"存成 .mp4 的结果是**每次开机黑屏**。
 *
 * 认两种容器（覆盖站点上实际会有的上传）：
 *   MP4/MOV  ISO BMFF —— 偏移 4..8 是 `ftyp`
 *   WebM     EBML    —— 开头 4 字节是 1A 45 DF A3
 */
function sniffVideo(buf) {
  if (!buf || buf.length < 1024) return null;
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    return { mime: 'video/mp4', ext: '.mp4', container: 'mp4', brand };
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { mime: 'video/webm', ext: '.webm', container: 'webm', brand: null };
  }
  return null;
}

export { sniffVideo };

/**
 * 队列下载完成后的**宿主侧收尾**（4.23.3）。
 *
 * 为什么放在宿主而不是面板里：用户可能切走页签、甚至关掉面板 —— 面板里的等待循环
 * 会跟着组件一起完蛋，文件就永远停在 `.part` 旁边（下次列表里"看不到已下载"）。
 * 这里自己轮询队列，下完再打一次 `/boot/download`（那次只读本地文件做验头 + 写 meta），
 * 复用同一条收尾逻辑，不复制第二份。
 */
function scheduleBootFinish({ hostHeader, base, id, jobId, log }) {
  if (!hostHeader || !jobId) return;
  const startedAt = Date.now();
  /** 收尾结果日志（4.23.6）：一律 `warn` 档 —— 默认终端只出 error+warn，写成 info 等于没留痕。 */
  const say = (result, code, extra) => {
    if (typeof log !== 'function') return;
    try {
      log('[boot] finish id=' + id + ' result=' + result + ' took=' + Math.max(0, Date.now() - startedAt)
        + 'ms code=' + (code || '-') + (extra ? ' ' + extra : ''), 'warn');
    } catch { /* 日志失败不影响收尾 */ }
  };
  let ticks = 0;
  const tick = async () => {
    ticks += 1;
    if (ticks > 600) { say('give-up', 'timeout', 'job=' + jobId); return; }   // ~15 分钟：比任何一次真实下载都长
    let job;
    try { job = getDownloadQueue().snapshot().find((j) => j && j.id === jobId) || null; } catch { job = null; }
    if (job && job.status === 'done') {
      let status;
      try {
        const r = await fetch('http://' + hostHeader + base + '/boot/download', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        status = Number(r && r.status) || 0;
      } catch (e) {
        // 自调用失败必须留痕：旧实现是空 catch ⇒ "收尾根本没发生"在日志里与成功同形。
        say('self-call-failed', 'network', 'job=' + jobId + ' detail=' + String((e && e.message) || e).slice(0, 120));
        return;
      }
      say(status >= 200 && status < 300 ? 'auto-finish-ok' : 'auto-finish-failed',
        status >= 200 && status < 300 ? '-' : 'http-' + status, 'job=' + jobId);
      return;
    }
    if (job && (job.status === 'failed' || job.status === 'cancelled')) { say('give-up', job.error || job.status, 'job=' + jobId); return; }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1500);
  if (typeof log === 'function') log('[boot] queued finish scheduled for ' + id + ' (' + jobId + ')', 'warn');
}
/** 读请求体里的 `{ id }`。 */
async function readIdBody(req) {
  try {
    const text = await readBodyText(req, 64 * 1024);
    const doc = JSON.parse(text || '{}');
    const id = String((doc && doc.id) || '').trim();
    // id 来自站点 slug，**可以是中文**（实测有「痘印」）。这里只挡真正的危险输入：
    // 路径分隔符、控制字符、`..`、超长 —— 其余一律放行，文件名由宿主安全化。
    if (!id || id.length > 200) return null;
    if (/[\u0000-\u001f\u007f/\\]/.test(id)) return null;
    if (id === '.' || id === '..' || id.includes('..')) return null;
    return id;
  } catch {
    return null;
  }
}

/**
 * 候选清单：模块索引里的 `boot` 模块 → 拉它的 manifest → `{ clips: [...] }`。
 * 失败一律返回空数组（面板显示"没有候选"），绝不抛。
 */
/** 候选缓存：30 秒。页签每次打开要跳两跳（模块索引 + 站点分类），没必要每次都跳。 */
const CANDIDATE_TTL_MS = 30000;
let candidateCache = { at: 0, value: null };

async function fetchCandidates(force = false) {
  if (!force && candidateCache.value && Date.now() - candidateCache.at < CANDIDATE_TTL_MS) {
    return candidateCache.value;
  }
  const fresh = await fetchCandidatesUncached();
  // 有结果才缓存（空结果多半是站点恰好不可达，别把它固化 30 秒）。
  if (fresh && fresh.clips && fresh.clips.length) candidateCache = { at: Date.now(), value: fresh };
  return fresh;
}

// 4.23.22：队列校验时现问**当前开机动画清单**（不再从 job 上复用旧 sha）。
registerManifestSource('boot', {
  snapshot: () => (candidateCache.value && Array.isArray(candidateCache.value.clips) && candidateCache.value.clips.length
    ? { items: candidateCache.value.clips, base: '', at: candidateCache.at }
    : null),
  refresh: async () => {
    const fresh = await fetchCandidates(true);
    return fresh && Array.isArray(fresh.clips) && fresh.clips.length
      ? { items: fresh.clips, base: '', at: Date.now() }
      : null;
  },
});

async function fetchCandidatesUncached() {
  // ① 站点分类接口（与壁纸同一个接口，只是 category 不同）
  const site = siteBase();
  if (site) {
    try {
      // 4.24.0：**v1 优先、v0 回退**（`lib/site-list.js` 唯一实现；四族共用同一条判据）。
      const r = await siteListFetch(site, '?category=' + BOOT_CATEGORY, { family: 'boot', timeoutMs: 15000 });
      if (r.doc && !r.error) {
        const items = (r.doc.data && Array.isArray(r.doc.data.items)) ? r.doc.data.items : [];
        const clips = items.map((it) => ({
          id: String((it && (it.slug || it.id)) || ''),
          title: String((it && it.title) || (it && it.slug) || ''),
          // 站点接口给的是相对路径（/media/...），下载时要绝对地址 —— 这里补上，
          // 否则 fetch 一个相对路径会当场失败。
          url: (() => { const u = String((it && it.url) || ''); return /^https?:/i.test(u) ? u : (u ? site + u : ''); })(),
          bytes: Number(it && it.bytes) || null,
          sha256: it && it.sha256 ? String(it.sha256) : null,
          durationSec: it && it.durationMs ? Number(it.durationMs) / 1000 : null,
          // 封面只认图片扩展名：站点上有几条老条目的 thumbUrl 直接指向 mp4
          // （那时还没有缩略图功能）。把视频当 <img> 用只会得到一张破图。
          cover: (() => {
            const u = String((it && it.thumbUrl) || '');
            if (!u) return null;
            if (!/\.(jpg|jpeg|png|webp|gif|avif)(\?|#|$)/i.test(u)) return null;
            return /^https?:/i.test(u) ? u : site + u;
          })(),
          faststart: true,
        })).filter((c) => c.id && c.url);
        if (clips.length) return { clips, error: null };
      }
    } catch { /* 落到模块清单 */ }
  }

  // ② 模块索引里的 boot 清单（站点不可达时的兜底）
  try {
    const index = await resolveModules(false);
    const mod = (index.modules || []).find((m) => m.id === 'boot');
    if (!mod || !mod.manifest || mod.status === 'disabled') return { clips: [], error: 'no-module' };
    const res = await fetch(mod.manifest, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { clips: [], error: 'http-' + res.status };
    const doc = await res.json();
    const list = Array.isArray(doc && doc.clips) ? doc.clips : [];
    const base = mod.manifest.replace(/\/[^/]*$/, '');
    const clips = list.map((c) => {
      const file = String((c && (c.file || c.id)) || '');
      const url = c && c.url ? String(c.url) : (base + '/' + file);
      return {
        id: String((c && c.id) || file.replace(/\.mp4$/i, '')),
        title: String((c && (c.name || c.title)) || c.id || file),
        url,
        bytes: Number(c && c.bytes) || null,
        sha256: c && c.sha256 ? String(c.sha256) : null,
        durationSec: Number(c && c.durationSec) || null,
        faststart: c && c.faststart === true,
      };
    }).filter((c) => c.id && c.url);
    return { clips, error: null };
  } catch (e) {
    return { clips: [], error: 'network' };
  }
}

/** 注入契约（ADR-0013 D12）：本族从 `c` 消费的**必需**键。
 *  判据 test/verify-inject-contracts.mjs 会把它与调用点逐键对账 —— 少一个就红，
 *  所以新增依赖（哪怕只是 `log`）也必须同步写在这里。 */
export const DEPS = ['disposers','base','log'];
export function registerBootRoutes(webServer, c) {
  const { disposers, base: BASE, log } = c;

  /* ① 候选 + 本地状态（面板一次拿全） */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/boot/list`,
    handler: async (req, res) => {
      let force = false;
      try { force = new URL(req.url || '/', 'http://x').searchParams.get('refresh') === '1'; } catch { /* ignore */ }
      if (force) await resolveModules(true);
      const [boot, candidates] = await Promise.all([Promise.resolve(readBoot()), fetchCandidates(force)]);
      const local = listLocalClips();
      const localById = new Map(local.map((x) => [x.id, x]));
      const clips = candidates.clips.map((c) => {
        const have = localById.get(c.id) || null;
        return { ...c, installed: Boolean(have), localBytes: have ? have.bytes : null, source: have && have.source === 'local' ? 'local' : 'site' };
      });
      // 本地有、清单里没有的（我们换了站点/清单）：也列出来，否则用户删不掉。
      const known = new Set(clips.map((c) => c.id));
      for (const it of local) {
        if (known.has(it.id)) continue;
        clips.push({
          id: it.id, title: it.title, url: null, bytes: null, sha256: null,
          durationSec: it.durationSec, faststart: true, cover: null,
          installed: true, localBytes: it.bytes, orphan: true, source: it.source || 'local',
        });
      }
      sendJson(res, 200, {
        ok: true,
        enabled: boot.enabled,
        items: boot.items,
        poolMode: boot.poolMode,
        clipId: boot.clipId,
        enterMode: boot.enterMode,
        sound: boot.sound,
        volume: boot.volume,
        fadeMs: boot.fadeMs,
        minShowMs: boot.minShowMs,
        maxHoldMs: boot.maxHoldMs,
        clips,
        error: candidates.error,
      });
    },
  }));

  /* ② 下载一条到本地（4.23.3：交给下载队列，返回 202 + jobId；下完宿主自己收尾） */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/boot/download`,
    handler: async (req, res) => {
      // 4.23.6：落地耗时从请求进来算起；结果日志走 warn（默认终端只出 error+warn）。
      const startedAt = Date.now();
      const id = await readIdBody(req);
      if (!id) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const { clips } = await fetchCandidates();
      const item = clips.find((c) => c.id === id);
      if (!item) { sendJson(res, 404, { ok: false, error: 'not-in-catalog' }); return; }
      const dest = clipFile(id);
      if (!dest) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }

      /**
       * 本地已有字节 ⇒ 只做**收尾**（验头 + 写 meta）。
       * 队列下完后的第二次调用走这里；因此"下载"和"收尾"共用同一段校验，
       * 不会出现"队列路径少验一次 ftyp"这种两套事实。
       */
      const finalize = () => {
        let buf;
        try { buf = readFileSync(dest); } catch (e) {
          sendJson(res, 500, { ok: false, error: 'read-failed', detail: String((e && e.message) || e) });
          return;
        }
        // 站点把未知路径回落到 HTML —— 这类"伪 200"绝不能当成视频存下来（否则每次开机黑屏）。
        // 只认文件头（mp4 的 ftyp / webm 的 EBML），比 content-type 可靠。
        const sniff = sniffVideo(buf);
        if (!sniff) {
          try { rmSync(dest, { force: true }); } catch { /* ignore */ }
          if (typeof log === 'function') {
            log('[boot] finish id=' + id + ' result=failed took=' + (Date.now() - startedAt)
              + 'ms code=not-a-video', 'warn');
          }
          sendJson(res, 422, { ok: false, error: 'not-a-video', detail: 'ftyp/ebml missing' });
          return;
        }
        if (buf.length > CLIP_MAX_BYTES) {
          try { rmSync(dest, { force: true }); } catch { /* ignore */ }
          sendJson(res, 413, { ok: false, error: 'too-large' });
          return;
        }
        try {
          writeFileSync(clipMetaFile(id), JSON.stringify({
            id,
            mime: sniff.mime,
            title: item.title, durationSec: item.durationSec, bytes: buf.length, sha256: item.sha256 || null,
          }, null, 2) + '\n');
        } catch { /* meta 只是锦上添花 */ }
        // 落地成功 = 验头通过 + meta 写好（`installed` 就是从 meta 推出来的）。warn 档留痕。
        if (typeof log === 'function') {
          log('[boot] finish id=' + id + ' result=ok took=' + (Date.now() - startedAt)
            + 'ms code=- bytes=' + buf.length + ' kind=' + sniff.mime, 'warn');
        }
        sendJson(res, 200, { ok: true, id, bytes: buf.length });
      };

      if (existsSync(dest)) { finalize(); return; }

      // 下载走队列：Range 续传、自适应多连接（4.23.3）、进度可读；下载完由宿主自己再调一次收尾。
      try {
        const q = getDownloadQueue(log);
        // 4.23.22：入队只记 URL；完成那一刻按**当前清单**验（registerManifestSource('boot')）。
        const added = q.add({
          url: item.url, dest, kind: 'boot', priority: 'high',
        });
        const job = (added && added.job) || null;
        const jobId = job ? job.id : '';
        if (job && job.status === 'done' && existsSync(dest)) { finalize(); return; }
        scheduleBootFinish({ hostHeader: req.headers && req.headers.host, base: BASE, id, jobId, log });
        sendJson(res, 202, {
          ok: true,
          pending: true,
          jobId,
          id,
          status: (job && job.status) || 'queued',
          received: Number(job && job.received) || 0,
          total: Number(job && job.total) || 0,
          queuePos: Number(job && job.queuePos) || 0,
          // 4.23.18：0 基、同 kind + 同优先级档（面板「前面还有 N 个」优先读它）。
          queuedAhead: job && job.queuedAhead != null ? Number(job.queuedAhead) : null,
          mode: (job && job.mode) || 'single',
        });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: 'queue-failed', detail: String((e && e.message) || e) });
      }
    },
  }));

  /* ②b 导入本地动画（base64 JSON；只写 ~/.dsh-folia/boot，不联网、不碰站点） */
disposers.push(webServer.register({
  kind: 'exact',
  path: `${BASE}/boot/import`,
  handler: async (req, res) => {
    let doc = null;
    try {
      const text = await readBodyText(req, 40 * 1024 * 1024);
      doc = JSON.parse(text || '{}');
    } catch { doc = null; }
    if (!doc || typeof doc.data !== 'string' || !doc.data) { sendJson(res, 400, { ok: false, error: 'bad-request' }); return; }
    let buf = null;
    try { buf = Buffer.from(doc.data, 'base64'); } catch { buf = null; }
    if (!buf || !buf.length) { sendJson(res, 400, { ok: false, error: 'bad-data' }); return; }
    const out = importLocalClip(buf, { title: doc.filename });
    if (!out.ok) {
      const status = out.error === 'too-large' ? 413 : (out.error === 'not-a-video' ? 415 : 400);
      sendJson(res, status, { ok: false, error: out.error });
      return;
    }
    if (typeof log === 'function') log(`[boot] imported ${out.id} bytes=${out.bytes}`);
    sendJson(res, 200, { ok: true, id: out.id, bytes: out.bytes });
  },
}));

/* ②c 第一幕图片：上传（base64 PNG，≤4MB）/ 读取 */
disposers.push(webServer.register({
  kind: 'exact',
  path: `${BASE}/boot/act1-image`,
  handler: async (req, res) => {
    if ((req.method || 'GET').toUpperCase() === 'GET') {
      if (!act1ImageExists()) { sendJson(res, 404, { ok: false, error: 'not-found' }); return; }
      try {
        const buf = readFileSync(act1ImagePath());
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store');
        res.end(buf);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
      }
      return;
    }
    if ((req.method || 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
    let doc = null;
    try {
      const text = await readBodyText(req, 8 * 1024 * 1024);
      doc = JSON.parse(text || '{}');
    } catch { doc = null; }
    if (!doc || typeof doc.data !== 'string' || !doc.data) { sendJson(res, 400, { ok: false, error: 'bad-request' }); return; }
    let buf = null;
    try { buf = Buffer.from(doc.data, 'base64'); } catch { buf = null; }
    if (!buf || !buf.length) { sendJson(res, 400, { ok: false, error: 'bad-data' }); return; }
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isPng) { sendJson(res, 415, { ok: false, error: 'not-png' }); return; }
    if (buf.length > 4 * 1024 * 1024) { sendJson(res, 413, { ok: false, error: 'too-large' }); return; }
    try { writeFileSync(act1ImagePath(), buf); } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
      return;
    }
    if (typeof log === 'function') log(`[boot] act1 image saved bytes=${buf.length}`);
    sendJson(res, 200, { ok: true, bytes: buf.length });
  },
}));

/* ③ 选择（并顺手启用） */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/boot/select`,
    handler: async (req, res) => {
      const id = await readIdBody(req);
      if (!id) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      if (!clipExists(id)) { sendJson(res, 404, { ok: false, error: 'not-installed' }); return; }
      const cur = readBoot();
        // 选中的一律提到池首：poolMode=first 时下次启动立刻就是它
        const items = [id, ...(Array.isArray(cur.items) ? cur.items : []).filter((x) => x !== id)];
        const boot = writeBoot({ clipId: id, items, enabled: true });
      if (typeof log === 'function') log(`[boot] selected ${id}`);
      sendJson(res, 200, { ok: true, ...boot });
    },
  }));

  /* ④ 开关 */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/boot/toggle`,
    handler: async (req, res) => {
      let enabled = false;
      try {
        const text = await readBodyText(req, 8 * 1024);
        const doc = JSON.parse(text || '{}');
        enabled = Boolean(doc && doc.enabled);
      } catch { /* 坏请求当 false */ }
      const boot = writeBoot({ enabled });
      sendJson(res, 200, { ok: true, ...boot });
    },
  }));

  /* ⑤ 设置（淡出 / 最短显示 / 最长停留） */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/boot/settings`,
    handler: async (req, res) => {
      let patch = {};
      try {
        const text = await readBodyText(req, 8 * 1024);
        const doc = JSON.parse(text || '{}');
        if (doc && typeof doc === 'object') patch = doc;
      } catch { /* 坏请求 = 不改 */ }
      const boot = writeBoot({
        ...(patch.enterMode !== undefined ? { enterMode: String(patch.enterMode) } : {}),
        ...(patch.sound !== undefined ? { sound: Boolean(patch.sound) } : {}),
        ...(patch.volume !== undefined ? { volume: Number(patch.volume) } : {}),
        ...(patch.fadeMs !== undefined ? { fadeMs: Number(patch.fadeMs) } : {}),
        ...(patch.minShowMs !== undefined ? { minShowMs: Number(patch.minShowMs) } : {}),
        ...(patch.maxHoldMs !== undefined ? { maxHoldMs: Number(patch.maxHoldMs) } : {}),
          ...(patch.transition !== undefined ? { transition: String(patch.transition) } : {}),
          ...(patch.act1 !== undefined && patch.act1 && typeof patch.act1 === 'object' ? { act1: patch.act1 } : {}),
          ...(patch.poolMode !== undefined ? { poolMode: String(patch.poolMode) } : {}),
      });
      sendJson(res, 200, { ok: true, ...boot });
    },
  }));

  /* ⑥ 删除本地片段 */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/boot/remove`,
    handler: async (req, res) => {
      const id = await readIdBody(req);
      if (!id) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const boot = readBoot();
      const bootNow = readBoot();
        const items = (Array.isArray(bootNow.items) ? bootNow.items : []).filter((x) => x !== id);
        if (bootNow.clipId === id) writeBoot({ clipId: items[0] || '', items, enabled: items.length > 0 });
        else writeBoot({ items });
      const ok = removeClip(id);
      sendJson(res, 200, { ok, id });
    },
  }));

  /* ⑦ 流式播放（Range） */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/boot/clip`,
    handler: async (req, res) => {
      const boot = readBoot();
      const id = boot.clipId;
      // 旧命名的片段（升级前下载的）也要能播 —— 解析器会顺手迁移成新名字。
      const file = resolveClipFile(id);
      if (!file || !existsSync(file)) { res.statusCode = 404; res.end('no clip'); return; }
      const size = statSync(file).size;
      const range = String((req.headers && req.headers.range) || '');
      // MIME 取自下载时记下的 meta：webm 用 video/webm，否则 video/mp4。
      let type = 'video/mp4';
      try {
        const meta = JSON.parse(readFileSync(clipMetaFile(boot.clipId), 'utf8'));
        if (meta && typeof meta.mime === 'string' && /^video\//.test(meta.mime)) type = meta.mime;
      } catch { /* 没 meta 就按 mp4 */ }
      // Range：`bytes=start-end` —— Chromium 播放本地大文件时会先发一小段探测请求。
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end !== null) { start = Math.max(0, size - end); end = size - 1; }
        if (start === null) start = 0;
        if (end === null || end >= size) end = size - 1;
        if (start > end || start >= size) {
          res.statusCode = 416;
          if (typeof res.setHeader === 'function') res.setHeader('content-range', `bytes */${size}`);
          res.end();
          return;
        }
        if (typeof res.setHeader === 'function') {
          res.setHeader('content-type', type);
          res.setHeader('content-length', String(end - start + 1));
          res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
          res.setHeader('accept-ranges', 'bytes');
          res.setHeader('cache-control', 'no-store');
        }
        res.statusCode = 206;
        createReadStream(file, { start, end }).pipe(res);
        return;
      }
      if (typeof res.setHeader === 'function') {
        res.setHeader('content-type', type);
        res.setHeader('content-length', String(size));
        res.setHeader('accept-ranges', 'bytes');
        res.setHeader('cache-control', 'no-store');
      }
      res.statusCode = 200;
      createReadStream(file).pipe(res);
    },
  }));
}
