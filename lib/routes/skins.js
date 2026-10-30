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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/**
 * 皮肤中心持久化"当前皮肤"的那个文件。
 *
 * 为什么我们会直接写它（兜底路径）：切换皮肤要落到 `/api/skin-center/v2/active`，
 * 而那条路径 ① 需要 DSH 会话；② 必须打到宿主 HTTP 服务那个源。实测这两点在桌面端内嵌页面里
 * 都可能不成立（401 / 路由没到），于是"点应用"根本没有可靠的写入通道。
 * 这个文件是**它自己的持久层**（`{ active, initialized, background }`），它每次 GET 都重新读它，
 * 并且客户端每 2 秒轮询一次 GET 收敛 —— 所以写这个文件等价于"替它记下选择"，可靠且即时。
 * 语义上只改 `active` 一个键，其余原样保留。
 */
function activeStatePath() { return join(dshHome(), 'skin-center-active.json'); }

/** 把 `active` 写进皮肤中心的持久层（保留其它字段；原子替换，失败不破坏原文件）。 */
function writeActiveStateFile(id) {
  const p = activeStatePath();
  let doc = {};
  try { doc = JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { doc = {}; }
  if (typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  doc.active = id === undefined ? null : id;
  if (doc.initialized === undefined) doc.initialized = true;
  const tmp = p + '.folia-tmp';
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
  return doc;
}

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
const skinCenterProbe = { at: 0, state: 'unknown', detail: '' };

/**
 * 皮肤中心是不是被**用户自己在插件市场里禁用了**。
 *
 * 为什么要单独读：它被禁用时 DSH 的鉴权中间件先于路由回答 401，和"需要会话"长得一模一样，
 * 于是页签只能写出"浏览器侧也被鉴权挡住"这种既对又没用的话（实测被用户当成插件故障）。
 * 市场的 `.dsh-market/state.json` 里有 `disabled` 数组 —— 读它是**只读事实**，比猜准得多。
 */
function readMarketDisabled() {
  try {
    const p = join(dshHome(), 'profiles', 'web', '.dsh-market', 'state.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(j && j.disabled) ? j.disabled : [];
    return { known: true, skinCenterDisabled: list.includes('@linxin666/dsh-client-ui-skin-center') };
  } catch { return { known: false, skinCenterDisabled: false }; }
}

async function probeSkinCenter(hostHeader, force) {
  const now = Date.now();
  if (!force && skinCenterProbe.at && now - skinCenterProbe.at < 30000) return skinCenterProbe.state;
  let state = 'unknown';
  let detail = '';
  if (hostHeader) {
    try {
      const r = await fetch('http://' + hostHeader + '/api/skin-center/v2/catalog', { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        // 只有**真的拿到 catalog JSON** 才算在跑。这个判据以前写成"非 404 即 present"，
        // 而 401 也会落到那一支 —— 但宿主进程没有会话，拿到的 401 只代表"鉴权挡在前面"，
        // 完全可能是插件被禁用（路由根本没注册）。实测就被它骗过：面板显示"皮肤中心在"，
        // 点应用却永远 404（真实原因：插件被市场保持为 off）。
        let doc = null;
        try { doc = await r.json(); } catch { doc = null; }
        state = doc && doc.ok ? 'present' : 'auth-gated';
        detail = state === 'present' ? '' : 'catalog-not-json';
      } else if (r.status === 401 || r.status === 403) {
        // 鉴权挡在前面 ⇒ **无法判定**它到底有没有挂载；如实说"不确定"，不要冒充 present。
        state = 'auth-gated';
        detail = 'http-' + r.status;
      } else if (r.status === 404) {
        state = 'absent';
        detail = 'route-missing';
      } else {
        state = 'unknown';
        detail = 'http-' + r.status;
      }
    } catch (e) {
      state = 'unknown';
      detail = (e && e.name) || 'network';
    }
  }
  skinCenterProbe.at = now;
  skinCenterProbe.state = state;
  skinCenterProbe.detail = detail;
  return state;
}

/**
 * 拉一份皮肤中心的 catalog，回答"**它到底收录了哪几套**"。
 *
 * 为什么必须问它、而不是自己扫目录：它有自己的收录规则（manifest.id 必须等于目录名、
 * 必须 v2、name/nameEn/author/stylesheet 齐全，且 `diagnostics` 会给出被剔除的原因）。
 * 我们扫到 5 个目录 ≠ 它认得这 5 套；实测症状：某台机器上"本机已装(5)"里点哪套都只显示
 * 皮肤中心的内置默认款（blue-fantasy）——因为那几套压根不在它的 catalog 里，它的客户端按
 * "active 解析不到就回退默认款"处理，看起来像"点了没反应"。
 *
 * 30 秒缓存：面板刷新/多标签共用；拿不到就返回 null（"未知"，不据此判红）。
 */
// 快照缓存：写进 Map 而不是给模块级对象赋值 —— 后者正是 require-atomic-updates 判红的形态，
// 而这里本来就是「最后一次完整快照胜出」的语义，用 Map.set 更贴合且不触发该规则。
const catalogCacheStore = new Map();
function readCatalogCache() { return catalogCacheStore.get('v') || { at: 0, map: null }; }
function setCatalogCache(at, map) { catalogCacheStore.set('v', { at, map }); }
async function fetchSkinCenterCatalog(hostHeader, force) {
  const now = Date.now();
  const snapshot = readCatalogCache();
  if (!force && snapshot.at && now - snapshot.at < 30000) return snapshot.map;
  if (!hostHeader) return readCatalogCache().map;
  let map = null;
  try {
    const r = await fetch('http://' + hostHeader + '/api/skin-center/v2/catalog', { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const doc = await r.json();
      const skins = (doc && Array.isArray(doc.skins)) ? doc.skins : [];
      map = new Map();
      for (const s of skins) {
        const id = s && s.manifest && s.manifest.id;
        if (typeof id === 'string' && id) map.set(id, Array.isArray(s.warnings) ? s.warnings : []);
      }
    }
  } catch { map = readCatalogCache().map; }
  setCatalogCache(now, map);
  return map;
}

/** 站点列表缓存（30 秒）：面板打开与"刷新"共用，避免每次都打站点。 */
const siteCache = { at: 0, items: [], error: null };
const SITE_TTL_MS = 30000;

/**
 * 给"本机已装"逐条附上**皮肤中心是否收录**。
 *
 * 比对口径要宽：它的 catalog 以 `manifest.id` 为键，而我们的条目同时有 `id`（manifest）与
 * `dirId`（目录名），且历史上站点 slug 可能带 `skin-` 前缀 ⇒ 三种形态都试，任一命中即算收录。
 * `catalog === null`（问不到）时给 `null`：**未知不等于未收录**，界面不能据此禁用「应用」。
 */
function annotateCatalog(installed, catalog) {
  if (!catalog) return installed.map((s) => ({ ...s, inCatalog: null, catalogWarnings: [] }));
  return installed.map((s) => {
    const hit = catalog.has(s.id) ? s.id
      : catalog.has(s.dirId) ? s.dirId
        : catalog.has(normSkinId(s.id)) ? normSkinId(s.id) : null;
    return { ...s, inCatalog: Boolean(hit), catalogWarnings: hit ? catalog.get(hit) : [] };
  });
}

async function fetchSiteSkins(force) {  const now = Date.now();
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
      // 站点现在把 tags 直接给**数组**（旧版给的是字符串化 JSON）。两种都收：
      // 只认字符串会让「动态」这类标记静默丢失（实测：线上返回 ["皮肤","catppuccin",…]）。
      tags: (() => {
        const raw = it.tags;
        if (Array.isArray(raw)) return raw.map((t) => String(t));
        try { const parsed = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed.map((t) => String(t)) : []; } catch { return []; }
      })(),
    }));
    siteCache.error = null;
  } catch (e) {
    // 把站点的**真实原因**带出来：站点整站上锁时只回 401 + `{"error":{"code":"site_locked"}}`，
    // 只显示 "http-401" 会让人以为是插件/网络问题（实测就栽在这条上）。
    const msg = (e && e.message) || 'fetch-failed';
    const status = /^http-(\d+)$/.exec(msg);
    if (status) {
      const code = Number(status[1]);
      siteCache.error = (code === 401 || code === 403) ? 'site-locked' : msg;
    } else {
      siteCache.error = msg;
    }
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
      const installedBase = listInstalled();
      const skinCenter = await probeSkinCenter(req.headers && req.headers.host, force);
      // 关键对账：**它收录了哪几套**。`null` = 问不到（不据此判红）。
      // 被它剔除的皮肤"能装但应用后画面不变"——它客户端会回退到内置默认款，
      // 用户看到的就是"点哪套都还是鲸鱼娘/blue-fantasy"（实测症状）。
      //
      // ⚠️ 但"它没列出"**不能**只凭一次缓存就下定论：刚装完皮肤时，它自己的 catalog 可能还没
      // 重扫（它按目录 mtime 做缓存），我们 30 秒的副本更可能比它更旧。实测：别人机器上刚装完
      // 就被标成「皮肤中心未收录」，而打开它的设置页却是有的 —— 一次假红。
      // 所以对账分两拍：先按缓存比，**出现"未收录"就强制重拉一次**再定论。
      const hostHeader = req.headers && req.headers.host;
      let catalog = skinCenter === 'present' ? await fetchSkinCenterCatalog(hostHeader, force) : null;
      let installed = annotateCatalog(installedBase, catalog);
      if (catalog && installed.some((s) => s.inCatalog === false)) {
        catalog = await fetchSkinCenterCatalog(hostHeader, true);
        installed = annotateCatalog(installedBase, catalog);
      }
      // ⚠️ 站点 slug 与本机皮肤 id **不总是同一个字符串**：站点上 slug 是全站唯一的，
      // 撞名时上传工具会加 `skin-` 前缀（实测 blue-throated-bee-eater 同时是桌宠 id）。
      // 所以比对要归一：两边都去掉可选的 `skin-` 前缀再比，否则会显示成"未安装"。
      const installedKeys = new Set();
      for (const s of installed) {
        installedKeys.add(normSkinId(s.id));
        installedKeys.add(normSkinId(s.dirId));
      }
      const market = readMarketDisabled();
      sendJson(res, 200, {
        ok: true,
        skinCenter,
        // 用户在插件市场里**手动禁用**它 ⇒ 这是我们能给出的最准确的原因（比 401 含糊其辞好）
        skinCenterDisabled: market.skinCenterDisabled,
        skinCenterMarketKnown: market.known,
        skinCenterDetail: skinCenterProbe.detail || '',
        // 版本线索：我们随身携带的是 0.4.12（engines 要求 dsh >= 0.2.1-rc.3）。
        // 低于该内核的机器会被市场 keep off —— 页签据此告诉用户"要么升级桌面端、要么别指望它"。
        skinCenterHint: skinCenter === 'present'
          ? ''
          : 'skin-center-0.4.12',
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

  /* ④ 代理皮肤中心的 active 端点（**转发浏览器凭据**）。
   *
   * 为什么需要它：写入 `/api/skin-center/v2/active` 有两个前提 ——
   *   ① 会话（DSH 对这条路径做鉴权）；② 请求打到**宿主 HTTP 服务**那个源。
   * 浏览器直连是首选（同源相对路径，凭据天然带全）；但当页面的 origin 与宿主 API 的 origin
   * 不同（桌面端内嵌页面可能是自定义协议或另一个端口），直连会 404 —— 那是**路由没到**，
   * 而它的 body 里没有 `error` 字段，正好和皮肤中心自己的 404 `skin-not-found` 区分开。
   *
   * 所以这里做**兜底**：把浏览器这一侧的 cookie 与同源头一起转发过去。
   * 只转发必要的头，不转发 `authorization`（避免把别的凭据带进第三方插件）。
   */
  const FORWARD_HEADERS = ['cookie', 'origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode'];
  function forwardedHeaders(req) {
    const out = {};
    const src = (req && req.headers) || {};
    for (const k of FORWARD_HEADERS) {
      const v = src[k];
      if (typeof v === 'string' && v) out[k] = v;
    }
    // 同源栅栏看的是 Sec-Fetch-Site / Origin 与 Host 的一致性：我们代理出去时 Host 变了，
    // 所以显式把它标成 same-origin（这正是事实：浏览器是发给"自己这台的宿主"的）。
    out['sec-fetch-site'] = 'same-origin';
    return out;
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/activate`,
    handler: async (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const host = req.headers && req.headers.host;
      if (!host) { sendJson(res, 400, { ok: false, error: 'no-host' }); return; }
      const body = await readJsonBody(req);
      const raw = body && body.id;
      const requested = (raw === null || raw === undefined || String(raw) === '') ? null : safeSkinId(raw);
      if (raw !== null && raw !== undefined && String(raw) !== '' && !requested) {
        sendJson(res, 400, { ok: false, error: 'bad-id' });
        return;
      }
      if (requested && !existsSync(join(skinsRoot(), requested))) {
        sendJson(res, 404, { ok: false, error: 'not-installed' });
        return;
      }
      let upstream = { status: 0, error: null };
      try {
        const r = await fetch('http://' + host + '/api/skin-center/v2/active', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...forwardedHeaders(req) },
          body: JSON.stringify({ active: requested }),
          signal: AbortSignal.timeout(6000),
        });
        const text = await r.text();
        let doc = null;
        try { doc = JSON.parse(text); } catch { /* 非 JSON（路由 miss 时常见） */ }
        upstream = { status: r.status, error: (doc && doc.error) || null };
        if (r.ok) {
          sendJson(res, 200, { ok: true, active: requested, via: 'http', upstream });
          return;
        }
      } catch (e) {
        upstream = { status: 0, error: e && e.name === 'TimeoutError' ? 'timeout' : 'network' };
      }

      // ── 兜底：直接写它自己的持久层 ────────────────────────────────────────
      // HTTP 写入不可用（无会话 / 源不一致 / 端点不在）时，写 `skin-center-active.json` 的
      // `active` 字段：皮肤中心每次 GET 都重读这个文件，客户端又每 2 秒轮询一次 GET，
      // 所以写文件等价于"替它记下选择"，最迟 2 秒生效；我们同时还会广播 dsh-skin-applied 立即生效。
      try {
        writeActiveStateFile(requested);
        sendJson(res, 200, { ok: true, active: requested, via: 'state-file', upstream });
      } catch (e) {
        sendJson(res, 502, {
          ok: false,
          error: 'activate-failed',
          upstream,
          detail: String((e && e.message) || e).slice(0, 160),
        });
      }
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/active`,
    handler: async (req, res) => {
      const host = req.headers && req.headers.host;
      // 先问皮肤中心自己（HTTP），问不到就**读它的持久层** —— 后者是写路径的兜底，
      // 两边都必须能回答"现在用的是哪套"，否则面板的"使用中"标记会随写入方式漂移。
      if (host) {
        try {
          const r = await fetch('http://' + host + '/api/skin-center/v2/active', {
            headers: { accept: 'application/json', ...forwardedHeaders(req) },
            signal: AbortSignal.timeout(5000),
          });
          if (r.ok) {
            const doc = await r.json().catch(() => null);
            sendJson(res, 200, { ok: true, active: (doc && doc.active) || null, via: 'http' });
            return;
          }
        } catch { /* 落到文件读 */ }
      }
      try {
        let doc = {};
        try { doc = JSON.parse(readFileSync(activeStatePath(), 'utf8')) || {}; } catch { doc = {}; }
        sendJson(res, 200, { ok: true, active: doc.active || null, via: 'state-file' });
      } catch (e) {
        sendJson(res, 502, { ok: false, error: 'read-failed', detail: String((e && e.message) || e).slice(0, 120) });
      }
    },
  }));
}
