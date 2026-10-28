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
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson } from '../json-response.js';
import { bodyReader } from '../http-body.js';
import { resolveModules } from './modules.js';
import { bootDir, clipExists, clipFile, listLocalClips, readBoot, removeClip, writeBoot } from '../boot/index.js';

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
const FETCH_TIMEOUT_MS = 60000;

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

/** 读请求体里的 `{ id }`。 */
async function readIdBody(req) {
  try {
    const text = await readBodyText(req, 64 * 1024);
    const doc = JSON.parse(text || '{}');
    const id = String((doc && doc.id) || '').trim();
    return /^[a-z0-9][a-z0-9._-]*$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * 候选清单：模块索引里的 `boot` 模块 → 拉它的 manifest → `{ clips: [...] }`。
 * 失败一律返回空数组（面板显示"没有候选"），绝不抛。
 */
async function fetchCandidates() {
  // ① 站点分类接口（与壁纸同一个接口，只是 category 不同）
  const site = siteBase();
  if (site) {
    try {
      const res = await fetch(site + '/api/public/wallpapers?category=' + BOOT_CATEGORY, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const doc = await res.json();
        const items = (doc && doc.data && Array.isArray(doc.data.items)) ? doc.data.items : [];
        const clips = items.map((it) => ({
          id: String((it && (it.slug || it.id)) || ''),
          title: String((it && it.title) || (it && it.slug) || ''),
          // 站点接口给的是相对路径（/media/...），下载时要绝对地址 —— 这里补上，
          // 否则 fetch 一个相对路径会当场失败。
          url: (() => { const u = String((it && it.url) || ''); return /^https?:/i.test(u) ? u : (u ? site + u : ''); })(),
          bytes: Number(it && it.bytes) || null,
          sha256: it && it.sha256 ? String(it.sha256) : null,
          durationSec: it && it.durationMs ? Number(it.durationMs) / 1000 : null,
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
      const [boot, candidates] = await Promise.all([Promise.resolve(readBoot()), fetchCandidates()]);
      const local = listLocalClips();
      const localById = new Map(local.map((x) => [x.id, x]));
      const clips = candidates.clips.map((c) => {
        const have = localById.get(c.id) || null;
        return { ...c, installed: Boolean(have), localBytes: have ? have.bytes : null };
      });
      // 本地有、清单里没有的（我们换了站点/清单）：也列出来，否则用户删不掉。
      const known = new Set(clips.map((c) => c.id));
      for (const it of local) {
        if (known.has(it.id)) continue;
        clips.push({
          id: it.id, title: it.title, url: null, bytes: null, sha256: null,
          durationSec: it.durationSec, faststart: true,
          installed: true, localBytes: it.bytes, orphan: true,
        });
      }
      sendJson(res, 200, {
        ok: true,
        enabled: boot.enabled,
        clipId: boot.clipId,
        enterMode: boot.enterMode,
        fadeMs: boot.fadeMs,
        minShowMs: boot.minShowMs,
        maxHoldMs: boot.maxHoldMs,
        sound: boot.sound,
        clips,
        error: candidates.error,
      });
    },
  }));

  /* ② 下载一条到本地 */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/boot/download`,
    handler: async (req, res) => {
      const id = await readIdBody(req);
      if (!id) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const { clips } = await fetchCandidates();
      const item = clips.find((c) => c.id === id);
      if (!item) { sendJson(res, 404, { ok: false, error: 'not-in-catalog' }); return; }
      const dest = clipFile(id);
      if (!dest) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      try {
        const r = await fetch(item.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) { sendJson(res, 502, { ok: false, error: 'http-' + r.status }); return; }
        const ct = String(r.headers.get('content-type') || '');
        const buf = Buffer.from(await r.arrayBuffer());
        // 站点把未知路径回落到 HTML —— 这类"伪 200"绝不能当成视频存下来（否则每次开机黑屏）。
        if (!/video\//i.test(ct) || buf.length < 1024 || buf.toString('latin1', 4, 8) !== 'ftyp') {
          sendJson(res, 422, { ok: false, error: 'not-a-video', detail: ct || 'no content-type' });
          return;
        }
        if (buf.length > CLIP_MAX_BYTES) { sendJson(res, 413, { ok: false, error: 'too-large' }); return; }
        writeFileSync(dest, buf);
        try {
          writeFileSync(join(bootDir(), id + '.json'), JSON.stringify({
            title: item.title, durationSec: item.durationSec, bytes: buf.length, sha256: item.sha256 || null,
          }, null, 2) + '\n');
        } catch { /* meta 只是锦上添花 */ }
        if (typeof log === 'function') log(`[boot] downloaded ${id} (${(buf.length / 1048576).toFixed(1)} MB)`);
        sendJson(res, 200, { ok: true, id, bytes: buf.length });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: 'fetch-failed', detail: String((e && e.message) || e) });
      }
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
      const boot = writeBoot({ clipId: id, enabled: true });
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
        ...(patch.fadeMs !== undefined ? { fadeMs: Number(patch.fadeMs) } : {}),
        ...(patch.minShowMs !== undefined ? { minShowMs: Number(patch.minShowMs) } : {}),
        ...(patch.maxHoldMs !== undefined ? { maxHoldMs: Number(patch.maxHoldMs) } : {}),
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
      if (boot.clipId === id) writeBoot({ clipId: '', enabled: false });
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
      const file = clipFile(id);
      if (!file || !existsSync(file)) { res.statusCode = 404; res.end('no clip'); return; }
      const size = statSync(file).size;
      const range = String((req.headers && req.headers.range) || '');
      const type = 'video/mp4';
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
