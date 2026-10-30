/**
 * routes/skins.js — **助手皮肤**页签的宿主半边：列站点皮肤、安装到皮肤中心目录、卸载。
 *
 * 为什么是这个形态（而不是另造一套渲染）：皮肤中心扫的是 `$DSH_HOME/skins/<id>/`
 * （`skin.json` + `skin.css` + 可选 `hooks.mjs` + `assets/`）。我们只要**把站点上的 zip 解到那个目录**，
 * 皮肤中心下一次 catalog 扫描就会认领它 —— 它的缓存键里带父目录 `mtimeMs`，新增目录必然穿透缓存。
 * 所以这里不"通知"皮肤中心，也不需要它配合：写盘即生效。
 *
 * 数据契约（站点一条 = 一个 zip；解出来必须是 v2 皮肤目录）：
 *   <皮肤根>/<id>/skin.json  必填（id/name 从里面取，**不信任 URL 里的名字**）
 *   <皮肤根>/<id>/skin.css   必填（contributes.stylesheet 指向它）
 *   hooks.mjs 可选；带它时皮肤中心会要求 `dsh-market.provenance.json` 字节对得上才执行 ——
 *   我们的 zip 是原样打的，所以 provenance 一起解出来，语义与市场安装一致。
 *
 * 纪律：
 *   · 只写 `$DSH_HOME/skins`，删也只删它下面（realpath 前缀校验，防符号链接逃逸）；
 *   · 下载白名单 = 站点 host（挡 SSRF）；只认 zip 魔数；单包上限 200 MB；
 *   · 解包拒路径穿越（整包拒绝，不是跳过）；可执行后缀一律不落盘；
 *   · 失败清干净：绝不留下没有 skin.json 的残缺目录（否则皮肤中心会把它算进"坏皮肤"）。
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 注入契约（ADR-0013 D12）。 */
export { unzipSkinZip, safeSkinId };
export const DEPS = ['disposers', 'base', 'log'];

/** 站点分类 slug：助手皮肤。 */
const SKIN_CATEGORY = 'assistant-skin';
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60000;
const SKIN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** 可执行/脚本后缀：皮肤包不需要，一律不写（防"皮肤包里塞个 exe"）。 */
const SKIP_EXEC_RE = /\.(exe|dll|bat|cmd|com|scr|ps1|sh|msi|vbs|wsf|hta|lnk|jar)$/i;

function dshHome() {
  return process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
}
/** 皮肤根：与皮肤中心同一个目录（它读 `$DSH_HOME/skins`）。 */
function skinsRoot() { return join(dshHome(), 'skins'); }

function siteBase() {
  const raw = process.env.DSH_FOLIA_SITE;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return null;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : 'https://folia-5ve.pages.dev';
  return base.replace(/\/+$/, '');
}

/**
 * 皮肤中心是否在线。
 *
 * 为什么由宿主探而不是前端探：两个插件跑在同一个 webServer 上，用请求自带的 Host 就能问到自己 —— 
 * 前端也能问，但宿主这一侧拿到的结果与"装没装"一一对应，而且不受浏览器缓存/跨源策略影响。
 * 判据用**它自己的 catalog 路由**：该路由不需要鉴权（实测 200），404 就是没装。
 */
const skinCenterProbe = { at: 0, state: 'unknown' };
async function probeSkinCenter(hostHeader, force) {
  const now = Date.now();
  if (!force && skinCenterProbe.at && now - skinCenterProbe.at < 30000) return skinCenterProbe.state;
  let state = 'unknown';
  if (hostHeader) {
    try {
      const r = await fetch('http://' + hostHeader + '/api/skin-center/v2/catalog', { signal: AbortSignal.timeout(4000) });
      state = r.status === 404 ? 'absent' : (r.ok ? 'present' : 'present');
      // 401/403 也说明插件在（只是该路由被别的版本加了鉴权）；只有 404 才代表没装。
    } catch { state = 'unknown'; }
  }
  skinCenterProbe.at = now;
  skinCenterProbe.state = state;
  return state;
}

/** 站点列表缓存（30 秒）：面板打开与"刷新"共用，避免每次都打站点。 */
const siteCache = { at: 0, items: [], error: null };
const SITE_TTL_MS = 30000;

async function fetchSiteSkins(force) {
  const now = Date.now();
  if (!force && siteCache.at && now - siteCache.at < SITE_TTL_MS) return siteCache;
  const base = siteBase();
  if (!base) { siteCache.at = now; siteCache.items = []; siteCache.error = 'site-off'; return siteCache; }
  try {
    const url = base + '/api/public/wallpapers?category=' + encodeURIComponent(SKIN_CATEGORY) + '&limit=100';
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('http-' + res.status);
    const body = await res.json();
    const items = (body && body.data && body.data.items) || [];
    siteCache.items = items.map((it) => ({
      id: String(it.slug || ''),
      title: String(it.title || it.slug || ''),
      bytes: Number(it.bytes) || 0,
      mime: String(it.mime || ''),
      url: String(it.url || ''),
      thumbUrl: it.thumbUrl ? String(it.thumbUrl) : '',
      tags: (() => { try { return JSON.parse(it.tags || '[]'); } catch { return []; } })(),
    }));
    siteCache.error = null;
  } catch (e) {
    siteCache.error = (e && e.message) || 'fetch-failed';
    siteCache.items = siteCache.items || [];
  }
  siteCache.at = now;
  return siteCache;
}

/** 本机已装皮肤（只读 `$DSH_HOME/skins`）。 */
function listInstalled() {
  const root = skinsRoot();
  let names = [];
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const out = [];
  for (const dirId of names) {
    const dir = join(root, dirId);
    let manifest;
    try { manifest = JSON.parse(readFileSync(join(dir, 'skin.json'), 'utf8')); } catch { continue; }
    let bytes = 0;
    try { bytes = dirBytes(dir); } catch { /* 忽略 */ }
    out.push({
      dirId,
      id: String(manifest.id || dirId),
      name: String(manifest.name || manifest.nameEn || manifest.id || dirId),
      nameEn: manifest.nameEn ? String(manifest.nameEn) : '',
      version: String(manifest.version || ''),
      author: String(manifest.author || ''),
      accent: manifest.accent ? String(manifest.accent) : '',
      hasHooks: existsSync(join(dir, 'hooks.mjs')),
      hasProvenance: existsSync(join(dir, 'dsh-market.provenance.json')),
      bytes,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return out;
}

function dirBytes(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    total += st.isDirectory() ? dirBytes(abs) : st.size;
  }
  return total;
}

/* ── zip 读取（只读，够用即可；判据见 test/skins-http.mjs）────────────────── */
/**
 * 解一个 zip 缓冲成条目数组。
 *
 * @param {Buffer} buf
 * @param {{ maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number }} [limits]
 * @returns {{ name: string, data: Buffer, isDir: boolean }[]}
 * @throws {Error} code: `not-a-zip` / `bad-zip` / `unsafe-entry` / `too-large`
 */
function unzipSkinZip(buf, limits = {}) {
  const maxEntries = limits.maxEntries || 4000;
  const maxEntry = limits.maxEntryBytes || 256 * 1024 * 1024;
  const maxTotal = limits.maxTotalBytes || 512 * 1024 * 1024;
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw Object.assign(new Error('not a zip'), { code: 'not-a-zip' });
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x04034b50 && magic !== 0x06054b50) throw Object.assign(new Error('not a zip'), { code: 'not-a-zip' });
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw Object.assign(new Error('no EOCD'), { code: 'bad-zip' });
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > maxEntries) throw Object.assign(new Error('too many entries'), { code: 'too-large' });
  if (cdOffset + cdSize > buf.length) throw Object.assign(new Error('CD out of range'), { code: 'bad-zip' });
  const out = [];
  let p = cdOffset;
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw Object.assign(new Error('bad CD'), { code: 'bad-zip' });
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const norm = String(name || '').replace(/\\/g, '/');
    if (!norm || norm.includes('\0') || norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').some((s) => s === '..')) {
      throw Object.assign(new Error('unsafe entry: ' + name), { code: 'unsafe-entry' });
    }
    if (norm.endsWith('/')) { out.push({ name: norm, data: Buffer.alloc(0), isDir: true }); continue; }
    if (uncompSize > maxEntry) throw Object.assign(new Error('entry too large'), { code: 'too-large' });
    total += uncompSize;
    if (total > maxTotal) throw Object.assign(new Error('archive too large'), { code: 'too-large' });
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw Object.assign(new Error('bad local header'), { code: 'bad-zip' });
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw Object.assign(new Error('truncated'), { code: 'bad-zip' });
    const raw = buf.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw); } catch (e) { throw Object.assign(new Error('inflate failed'), { code: 'bad-zip' }); }
    } else throw Object.assign(new Error('unsupported method ' + method), { code: 'bad-zip' });
    out.push({ name: norm, data, isDir: false });
  }
  return out;
}

/** 比对本机/站点 id 用的归一键：去掉可选的 `skin-` 前缀（站点 slug 为避撞名会加）。 */
function normSkinId(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return s.startsWith('skin-') ? s.slice(5) : s;
}

/** 皮肤 id 只允许安全字符（要当目录名用）。 */
function safeSkinId(raw) {
  const s = String(raw || '').trim();
  return SKIN_ID_RE.test(s) ? s : '';
}

/** 校验"删/写这个目录"确实在皮肤根下面（realpath 前缀，挡符号链接逃逸）。 */
function resolveInside(root, id) {
  const dir = join(root, id);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const realDir = existsSync(dir) ? realpathSync(dir) : dir;
  const withSep = realRoot.endsWith('\\') || realRoot.endsWith('/') ? realRoot : realRoot + (process.platform === 'win32' ? '\\' : '/');
  return realDir === realRoot || realDir.startsWith(withSep) ? dir : '';
}

function sendJson(res, code, payload) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let acc = '';
    let done = false;
    req.on('data', (d) => {
      if (done) return;
      acc += d;
      if (acc.length > limit) { done = true; resolve(null); }
    });
    req.on('end', () => { if (!done) { done = true; try { resolve(JSON.parse(acc || '{}')); } catch { resolve(null); } } });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

export function registerSkinsRoutes(webServer, c) {
  const { disposers, base, log } = c;

  /* ① 列表：站点可装的 + 本机已装的（同一份响应，面板一次拿全） */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/list`,
    handler: async (req, res) => {
      const force = /[?&]refresh=1/.test(req.url || '');
      const site = await fetchSiteSkins(force);
      const installed = listInstalled();
      const skinCenter = await probeSkinCenter(req.headers && req.headers.host, force);
      // ⚠️ 站点 slug 与本机皮肤 id **不总是同一个字符串**：站点上 slug 是全站唯一的，
      // 撞名时上传工具会加 `skin-` 前缀（实测 blue-throated-bee-eater 同时是桌宠 id）。
      // 所以比对要归一：两边都去掉可选的 `skin-` 前缀再比，否则会显示成"未安装"。
      const installedKeys = new Set();
      for (const s of installed) {
        installedKeys.add(normSkinId(s.id));
        installedKeys.add(normSkinId(s.dirId));
      }
      sendJson(res, 200, {
        ok: true,
        skinCenter,
        siteBase: siteBase(),
        siteError: site.error,
        installed,
        site: site.items.map((it) => ({ ...it, installed: installedKeys.has(normSkinId(it.id)) })),
      });
    },
  }));

  /* ② 安装：下载 zip → 解到 $DSH_HOME/skins/<id> */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/install`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readJsonBody(req);
      if (!body) { sendJson(res, 400, { ok: false, error: 'bad-body' }); return; }
      const base0 = siteBase();
      if (!base0) { sendJson(res, 400, { ok: false, error: 'site-off' }); return; }
      let url;
      try { url = new URL(String(body.url || ''), base0); } catch { sendJson(res, 400, { ok: false, error: 'bad-url' }); return; }
      const allowHost = new URL(base0).host.toLowerCase();
      if (url.host.toLowerCase() !== allowHost) { sendJson(res, 400, { ok: false, error: 'host-not-allowed' }); return; }

      const root = skinsRoot();
      // 幂等：站点 id 与本机目录同名时直接返回（用户"再点一次"应该是立刻生效，而不是重下一遍）
      const hinted = safeSkinId(body.id);
      if (hinted && existsSync(join(root, hinted, 'skin.json'))) {
        sendJson(res, 200, { ok: true, exists: true, id: hinted, dir: join(root, hinted) });
        return;
      }

      let buf;
      try {
        const r = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!r.ok) { sendJson(res, 502, { ok: false, error: 'http-' + r.status }); return; }
        const len = Number(r.headers.get('content-length') || 0);
        if (len && len > MAX_ZIP_BYTES) { sendJson(res, 413, { ok: false, error: 'too-large' }); return; }
        buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > MAX_ZIP_BYTES) { sendJson(res, 413, { ok: false, error: 'too-large' }); return; }
      } catch (e) {
        sendJson(res, 502, { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' });
        return;
      }

      let entries;
      try { entries = unzipSkinZip(buf); } catch (e) {
        sendJson(res, 422, { ok: false, error: (e && e.code) || 'bad-zip' });
        return;
      }
      const manifestEntry = entries.find((e) => !e.isDir && /^skin\.json$/i.test(e.name));
      if (!manifestEntry) { sendJson(res, 422, { ok: false, error: 'no-skin-json' }); return; }
      let manifest;
      try { manifest = JSON.parse(manifestEntry.data.toString('utf8')); } catch { sendJson(res, 422, { ok: false, error: 'bad-skin-json' }); return; }
      // 目录名以 skin.json 的 id 为准（不信任 URL/调用方给的名字）。
      const skinId = safeSkinId(manifest && manifest.id) || hinted;
      if (!skinId) { sendJson(res, 422, { ok: false, error: 'bad-skin-id' }); return; }
      const dir = resolveInside(root, skinId);
      if (!dir) { sendJson(res, 400, { ok: false, error: 'unsafe-id' }); return; }
      if (existsSync(join(dir, 'skin.json'))) {
        sendJson(res, 200, { ok: true, exists: true, id: skinId, dir });
        return;
      }

      try {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        let written = 0;
        let skipped = 0;
        for (const e of entries) {
          if (e.isDir) continue;
          if (SKIP_EXEC_RE.test(e.name)) { skipped += 1; continue; }
          const target = join(dir, e.name);
          const parent = join(target, '..');
          mkdirSync(parent, { recursive: true });
          writeFileSync(target, e.data);
          written += 1;
        }
        const check = JSON.parse(readFileSync(join(dir, 'skin.json'), 'utf8'));
        if (!check || !check.id) throw new Error('manifest lost after write');
        sendJson(res, 200, {
          ok: true,
          id: skinId,
          name: String(check.name || check.nameEn || skinId),
          dir,
          written,
          skipped,
          bytes: buf.length,
          installedDir: root,
        });
      } catch (e) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        try { log && log('skins install failed: ' + (e && e.message)); } catch { /* ignore */ }
        sendJson(res, 500, { ok: false, error: 'extract-failed', detail: String(e && e.message).slice(0, 200) });
      }
    },
  }));

  /* ③ 卸载：只删皮肤根下的那个目录 */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/remove`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const body = await readJsonBody(req);
      const id = safeSkinId(body && body.id);
      if (!id) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const root = skinsRoot();
      const dir = resolveInside(root, id);
      if (!dir) { sendJson(res, 400, { ok: false, error: 'unsafe-id' }); return; }
      if (!existsSync(dir)) { sendJson(res, 404, { ok: false, error: 'not-installed' }); return; }
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) {
        sendJson(res, 500, { ok: false, error: 'remove-failed', detail: String(e && e.message).slice(0, 160) });
        return;
      }
      sendJson(res, 200, { ok: true, id });
    },
  }));

  /* ④ 应用：把"选中的皮肤"写进皮肤中心的 active 端点 —— **不自己实现渲染**。
   *
   * 为什么这样接：皮肤中心的客户端有两条收敛路径（读它的源码得到，不是猜）：
   *   · `window` 上的 `dsh-skin-applied` 事件（`detail: { id }`）⇒ 立即就地切换；
   *   · 每 2000ms 轮询 `/api/skin-center/v2/active` ⇒ 事件丢了也会在 2 秒内收敛。
   * 所以这里只写"选择"，客户端再补一个事件把切换做成瞬时的。皮肤中心没装时明确 409，
   * 而不是让用户点了没反应。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/activate`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const host = req.headers && req.headers.host;
      const state = await probeSkinCenter(host, true);
      if (state === 'absent') { sendJson(res, 409, { ok: false, error: 'skin-center-missing' }); return; }
      const body = await readJsonBody(req);
      // 允许清空（回到官方默认）：id 传空串 / null。
      const raw = body && body.id;
      const requested = (raw === null || raw === undefined || String(raw) === '') ? null : safeSkinId(raw);
      if (raw !== null && raw !== undefined && String(raw) !== '' && !requested) {
        sendJson(res, 400, { ok: false, error: 'bad-id' });
        return;
      }
      // 只允许切到**本机真实存在**的皮肤：否则皮肤中心会尝试渲染一个不存在的目录。
      if (requested && !existsSync(join(skinsRoot(), requested))) {
        sendJson(res, 404, { ok: false, error: 'not-installed' });
        return;
      }
      try {
        const r = await fetch('http://' + host + '/api/skin-center/v2/active', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ active: requested }),
          signal: AbortSignal.timeout(6000),
        });
        const text = await r.text();
        let doc = null;
        try { doc = JSON.parse(text); } catch { /* 非 JSON */ }
        if (!r.ok) {
          sendJson(res, 502, { ok: false, error: 'skin-center-' + r.status, detail: String(text).slice(0, 160) });
          return;
        }
        sendJson(res, 200, { ok: true, active: requested, skinCenter: doc && doc.active });
      } catch (e) {
        sendJson(res, 502, { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' });
      }
    },
  }));

  /* ⑤ 当前皮肤（给面板显示"使用中"，读的是皮肤中心自己记的选择） */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/active`,
    handler: async (req, res) => {
      const host = req.headers && req.headers.host;
      const state = await probeSkinCenter(host, true);
      if (state === 'absent') { sendJson(res, 409, { ok: false, error: 'skin-center-missing' }); return; }
      try {
        const r = await fetch('http://' + host + '/api/skin-center/v2/active', { signal: AbortSignal.timeout(5000) });
        const doc = await r.json().catch(() => null);
        if (!r.ok) { sendJson(res, 502, { ok: false, error: 'skin-center-' + r.status }); return; }
        sendJson(res, 200, { ok: true, active: (doc && doc.active) || null });
      } catch (e) {
        sendJson(res, 502, { ok: false, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' });
      }
    },
  }));
}
