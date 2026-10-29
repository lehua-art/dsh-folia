/**
 * routes/pets.js — **桌宠**（自渲染，不依赖第三方宠物插件）。
 *
 * 为什么自己渲染：桌宠的本质只是"一张雪碧图 + 每行的帧数/每帧时长 + 一个状态机"，
 * 属于纯前端的绘帧问题，没有必须借助外部渲染器的理由。站点当分发通道，插件自己画。
 *
 * 数据契约（与 @linxin666/dsh-pet 的 manifest v2 兼容，方便复用现成宠物资产）：
 *   <数据目录>/pets/<id>/pet.json          必填，见下
 *   <数据目录>/pets/<id>/spritesheet.webp  必填
 *
 * 支持的最小形态（sprite2d）：
 *   { petManifestVersion: 2, id, displayName, renderer: "sprite2d",
 *     sprite2d: { spritesheetPath, cell: { width, height }, columns,
 *                 frames?: number[], tracks?: { <状态>: { durations: number[] } } } }
 * 几何缺省值按 dsh-pet 的 contract 走：8 列 × 9 行，每格 192×208。
 *
 * 纪律：
 *   · **只读我们自己的目录**（`<数据目录>/pets`），不碰别的插件的资源目录；
 *   · 安装只认带 `pet.json` 且 spritesheet 真实存在的目录，缺一不可；
 *   · 任何异常都折成 4xx + 明确错误码，绝不把宿主打 500。
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';

/** 注入契约（ADR-0013 D12）。 */
export const DEPS = ['disposers', 'base', 'log'];

const DEFAULT_COLUMNS = 8;
const DEFAULT_ROWS = 9;
const DEFAULT_CELL = { width: 192, height: 208 };
const SHEET_MAX_BYTES = 24 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

function dataRoot() {
  const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(base, 'pets');
}

function siteBase() {
  const raw = process.env.DSH_FOLIA_SITE;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return null;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'https://folia-5ve.pages.dev';
  return base.replace(/\/+$/, '');
}

/** 站点上的桌宠分类 slug（站点 `/api/public/categories` 里就有这一条）。 */
const PET_CATEGORY = 'desktop-pet';

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

/**
 * 一只已安装宠物的完整描述；`null` 表示这目录不是合法宠物（必须是**整份**：
 * pet.json + 雪碧图都存在）。宁可少认一只，也不要在前端画出空白方块。
 */
function readPet(dir, id) {
  const manifestPath = join(dir, 'pet.json');
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
  if (!manifest || typeof manifest !== 'object') return null;
  const g = (manifest.sprite2d && typeof manifest.sprite2d === 'object') ? manifest.sprite2d : {};
  const sheetName = typeof g.spritesheetPath === 'string' ? basename(g.spritesheetPath) : 'spritesheet.webp';
  const sheetPath = join(dir, sheetName);
  if (!existsSync(sheetPath)) return null;
  const cell = (g.cell && Number(g.cell.width) > 0 && Number(g.cell.height) > 0)
    ? { width: Number(g.cell.width), height: Number(g.cell.height) } : { ...DEFAULT_CELL };
  const columns = Number(g.columns) > 0 ? Number(g.columns) : DEFAULT_COLUMNS;
  const frames = Array.isArray(g.frames) && g.frames.length === DEFAULT_ROWS
    ? g.frames.map((n) => Math.max(1, Math.min(columns, Number(n) || columns)))
    : new Array(DEFAULT_ROWS).fill(columns);
  // 轨道：只保留显式给出且长度合理的 durations；其余由前端用默认节奏。
  const tracks = {};
  if (g.tracks && typeof g.tracks === 'object') {
    for (const [k, v] of Object.entries(g.tracks)) {
      if (v && Array.isArray(v.durations) && v.durations.length) {
        tracks[k] = { durations: v.durations.map((d) => Math.max(16, Number(d) || 120)) };
      }
    }
  }
  return {
    id: String(manifest.id || id),
    dirId: id,
    name: String(manifest.displayName || manifest.id || id),
    author: manifest.author ? String(manifest.author) : null,
    license: manifest.license ? String(manifest.license) : null,
    renderer: String(manifest.renderer || 'sprite2d'),
    bytes: (() => { try { return statSync(sheetPath).size; } catch { return null; } })(),
    cell, columns, frames, tracks,
    sheet: '/folia/pets/sheet?v=' + encodeURIComponent(id),
  };
}

/** 列出本地已安装的宠物（目录扫描；坏目录静默跳过）。 */
function listInstalled() {
  const root = dataRoot();
  const out = [];
  let names = [];
  try { names = readdirSync(root); } catch { return out; }
  for (const name of names) {
    const dir = join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const pet = readPet(dir, name);
    if (pet) out.push(pet);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** 桌面宠物的配置（我们自己的文件，不写别人的配置）。 */
function configPath() { return join(dirname(dataRoot()), 'pet-config.json'); }
function readConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
    return {
      enabled: raw.enabled === true,
      petId: typeof raw.petId === 'string' ? raw.petId : '',
      scale: Number.isFinite(Number(raw.scale)) ? Math.min(3, Math.max(0.5, Number(raw.scale))) : 1,
    };
  } catch {
    return { enabled: false, petId: '', scale: 1 };
  }
}
function writeConfig(next) {
  const cur = readConfig();
  const merged = {
    enabled: next.enabled === undefined ? cur.enabled : Boolean(next.enabled),
    petId: next.petId === undefined ? cur.petId : String(next.petId || ''),
    scale: next.scale === undefined ? cur.scale : Math.min(3, Math.max(0.5, Number(next.scale) || 1)),
  };
  try {
    ensureDir(dirname(configPath()));
    writeFileSync(configPath(), JSON.stringify(merged, null, 2) + '\n');
  } catch { /* 只读盘：本次配置不落盘，但内存里仍按 merged 回给调用方 */ }
  return merged;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  if (typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
  }
  res.end(text);
}

/**
 * 极简 zip 读取器：只做**取条目**这一件事（store / deflate 两种方法）。
 *
 * 为什么不引依赖：宠物包在我们自己手里生成（见 tools/upload-pets.mjs，store 模式），
 * 而站点上别人上传的包也只有这两类方法。整个解析靠中央目录遍历，不猜、不流式、
 * 且对每个条目做**大小与路径安全**检查 —— 一个 zip 解析器最该防的是路径穿越与 zip bomb。
 *
 * @returns {Map<string, Buffer>} 文件名 → 内容（只保留通过检查的条目）
 */
function unzip(buf, opts = {}) {
  const maxEntry = Number(opts.maxEntry) || 24 * 1024 * 1024;
  const maxTotal = Number(opts.maxTotal) || 64 * 1024 * 1024;
  const out = new Map();
  let total = 0;
  // EOCD 在文件尾 22 字节起，最多带 64KB 注释
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not-a-zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad-central');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    // 路径安全：只收单层文件名，任何目录跳转一律丢弃
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) continue;
    if (compSize > maxEntry) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataAt = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataAt, dataAt + compSize);
    if (comp.length !== compSize) continue;
    let data;
    try {
      data = method === 0 ? Buffer.from(comp) : method === 8 ? inflateRawSync(comp) : null;
    } catch { data = null; }
    if (!data) continue;
    total += data.length;
    if (total > maxTotal) throw new Error('too-large');
    out.set(name, data);
  }
  return out;
}

function readBodyText(req, maxBytes = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { resolve(''); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

export function registerPetsRoutes(webServer, c) {
  const { disposers, base: BASE, log } = c;

  // ── 站点桌宠清单（分类 desktop-pet） ──────────────────────────────────────
  let siteCache = { at: 0, items: [], error: null };
  async function fetchSitePets(force) {
    if (!force && siteCache.items.length && Date.now() - siteCache.at < 60000) return siteCache;
    const base = siteBase();
    if (!base) { siteCache = { at: Date.now(), items: [], error: 'site-off' }; return siteCache; }
    try {
      const r = await fetch(base + '/api/public/wallpapers?category=' + PET_CATEGORY + '&limit=100', {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error('http-' + r.status);
      const doc = await r.json();
      const list = (doc && doc.data && Array.isArray(doc.data.items)) ? doc.data.items : [];
      const items = list.map((it) => {
        const url = String((it && it.url) || '');
        const abs = /^https?:/i.test(url) ? url : (url ? base + url : '');
        const thumb = String((it && it.thumbUrl) || '');
        return {
          id: String((it && (it.slug || it.id)) || ''),
          title: String((it && it.title) || ''),
          bytes: Number(it && it.bytes) || null,
          url: abs,
          cover: thumb && /\.(jpg|jpeg|png|webp|gif|avif)(\?|#|$)/i.test(thumb)
            ? (/^https?:/i.test(thumb) ? thumb : base + thumb) : null,
        };
      }).filter((x) => x.id && x.url);
      siteCache = { at: Date.now(), items, error: null };
      return siteCache;
    } catch (e) {
      siteCache = { at: Date.now(), items: siteCache.items, error: String((e && e.message) || e) };
      return siteCache;
    }
  }

  // ── GET /pets/list ────────────────────────────────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/pets/list`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const force = url.searchParams.get('refresh') === '1';
      const site = await fetchSitePets(force);
      const installed = listInstalled();
      const installedIds = new Set(installed.map((p) => p.dirId));
      sendJson(res, 200, {
        ok: true,
        pets: installed,
        site: site.items.map((it) => ({ ...it, installed: installedIds.has(it.id) })),
        siteError: site.error,
        config: readConfig(),
      });
    },
  }));

  // ── GET /pets/sheet?v=<dirId>（本地雪碧图） ───────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/pets/sheet`,
    handler: async (req, res) => {
      let id = '';
      try { id = new URL(req.url || '/', 'http://x').searchParams.get('v') || ''; } catch { id = ''; }
      const dir = join(dataRoot(), String(id));
      const pet = id && existsSync(dir) ? readPet(dir, id) : null;
      if (!pet) { res.statusCode = 404; res.end(); return; }
      const manifest = (() => { try { return JSON.parse(readFileSync(join(dir, 'pet.json'), 'utf8')); } catch { return {}; } })();
      const sheetName = basename((manifest.sprite2d && manifest.sprite2d.spritesheetPath) || 'spritesheet.webp');
      const file = join(dir, sheetName);
      let size = 0;
      try { size = statSync(file).size; } catch { /* 下面统一 404 */ }
      if (!size || size > SHEET_MAX_BYTES) { res.statusCode = 404; res.end(); return; }
      const type = extname(file).toLowerCase() === '.png' ? 'image/png'
        : extname(file).toLowerCase() === '.gif' ? 'image/gif' : 'image/webp';
      if (typeof res.setHeader === 'function') {
        res.setHeader('content-type', type);
        res.setHeader('content-length', String(size));
        res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
      res.statusCode = 200;
      createReadStream(file).pipe(res);
    },
  }));

  // ── POST /pets/config（开关 / 选中 / 缩放） ───────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/pets/config`,
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      const text = await readBodyText(req);
      let patch = {};
      try { patch = JSON.parse(text || '{}'); } catch { sendJson(res, 400, { ok: false, error: 'bad-json' }); return; }
      if (patch.petId && !existsSync(join(dataRoot(), String(patch.petId)))) {
        sendJson(res, 404, { ok: false, error: 'not-installed' });
        return;
      }
      const cfg = writeConfig(patch);
      sendJson(res, 200, { ok: true, config: cfg });
    },
  }));

  // ── POST /pets/install（从站点条目安装：下载 zip → 解开 → 校验） ─────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/pets/install`,
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      const text = await readBodyText(req);
      let id = '';
      try { id = String((JSON.parse(text || '{}') || {}).id || '').trim(); } catch { id = ''; }
      if (!id || /[\\/]/.test(id) || id.includes('..') || id.length > 120) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }

      const site = await fetchSitePets(false);
      const item = site.items.find((x) => x.id === id);
      if (!item) { sendJson(res, 404, { ok: false, error: 'not-on-site', detail: site.error || null }); return; }

      let buf;
      try {
        const r = await fetch(item.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) { sendJson(res, 502, { ok: false, error: 'http-' + r.status }); return; }
        buf = Buffer.from(await r.arrayBuffer());
      } catch (e) { sendJson(res, 502, { ok: false, error: 'fetch-failed', detail: String((e && e.message) || e) }); return; }

      if (buf.length < 64 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        sendJson(res, 422, { ok: false, error: 'not-a-zip' });
        return;
      }

      let entries;
      try { entries = unzip(buf); } catch (e) { sendJson(res, 422, { ok: false, error: 'bad-zip', detail: String((e && e.message) || e) }); return; }
      const manifestRaw = entries.get('pet.json');
      if (!manifestRaw) { sendJson(res, 422, { ok: false, error: 'no-manifest' }); return; }
      let manifest;
      try { manifest = JSON.parse(manifestRaw.toString('utf8')); } catch { sendJson(res, 422, { ok: false, error: 'bad-manifest' }); return; }
      const sheetName = basename((manifest.sprite2d && manifest.sprite2d.spritesheetPath) || 'spritesheet.webp');
      const sheet = entries.get(sheetName);
      if (!sheet) { sendJson(res, 422, { ok: false, error: 'no-spritesheet', detail: sheetName }); return; }

      const dir = join(dataRoot(), id);
      try {
        ensureDir(dir);
        for (const [name, data] of entries) writeFileSync(join(dir, basename(name)), data);
      } catch (e) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        sendJson(res, 500, { ok: false, error: 'write-failed', detail: String((e && e.message) || e) });
        return;
      }

      const pet = readPet(dir, id);
      if (!pet) { sendJson(res, 422, { ok: false, error: 'install-invalid' }); return; }
      // 装完就选中它并开启 —— 用户点「安装」的意图就是「我要用它」。
      const cfg = writeConfig({ enabled: true, petId: id });
      if (typeof log === 'function') log('[pets] installed ' + id + ' (' + buf.length + ' bytes)');
      sendJson(res, 200, { ok: true, id, pet, config: cfg });
    },
  }));

  // ── POST /pets/remove（只删我们目录下的一只） ─────────────────────────────
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/pets/remove`,
    handler: async (req, res) => {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method' }); return; }
      const text = await readBodyText(req);
      let id = '';
      try { id = String((JSON.parse(text || '{}') || {}).id || ''); } catch { id = ''; }
      if (!id || /[\\/]/.test(id) || id.includes('..')) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const dir = join(dataRoot(), id);
      if (!existsSync(dir)) { sendJson(res, 404, { ok: false, error: 'not-installed' }); return; }
      try { rmSync(dir, { recursive: true, force: true }); } catch { sendJson(res, 500, { ok: false, error: 'remove-failed' }); return; }
      const cfg = readConfig();
      if (cfg.petId === id) writeConfig({ petId: '' });
      if (typeof log === 'function') log('[pets] removed ' + id);
      sendJson(res, 200, { ok: true, id });
    },
  }));

  return () => { /* 无长驻资源：路由随 disposers 归还 */ };
}
