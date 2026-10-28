/**
 * routes/skins.js — 「皮肤包」数据源：把**自建站点**上的皮肤包列出来、下下来、装上、切换。
 *
 * 与 `routes/inventory.js` 的站点数据源是**同一套思路**（自建站 = 唯一真源，宿主端代取，
 * 浏览器不直连），但落地对象不同：那边是壁纸条目，这边是**整套皮肤包**。
 *
 * 为什么这件事可行而不是"另造一套皮肤引擎"：
 *   · 站点已经按市场同一格式产出索引（`<site>/skins/manifest.json`）与 zip
 *     （`<site>/skins/<id>.zip`），zip 内就是 `skin.json` + `skin.css` + `assets/`
 *     + `dsh-market.provenance.json`；
 *   · 本插件**不负责渲染** —— 皮肤中心（dsh-skin-center）读 `harness/skins/<id>/`
 *     自己应用样式与 hooks。我们只做"取、验、落、切"四件事。
 *   · 所以皮肤中心的完整性校验仍会照常跑（provenance 在 zip 内原样带着，哈希没被动过）。
 *
 * 四个路由（全部 `${base}/skins` 前缀下，一条 prefix 注册）：
 *   GET  /skins                 索引 + 本机已装/在用状态（合并后下发，客户端一次拿全）
 *   POST /skins/install   {id}  下载 → sha256 校验 → 解压到 harness/skins/<id>/
 *   POST /skins/activate  {id}  写 harness/skin-center-active.json 的 `active`
 *   POST /skins/remove    {id}  删目录（在用 / 不存在的拒绝）
 *
 * 纪律（与库存族同口径）：
 *   · 站点不可达**绝不影响**插件其他功能：索引失败返回 503 + 结构化错误，客户端显示"不可达"；
 *   · 每次下载都有上限（`SKIN_ZIP_MAX_BYTES`）与超时；
 *   · zip 解压是**纯 JS**（node:zlib）—— 不引入新依赖，也不 shell 出去调 Expand-Archive；
 *   · 解压路径做 zip-slip 防护：绝对路径、`..`、反斜杠、盘符一律拒绝；
 *   · 只认 `^[a-z0-9][a-z0-9-]*$` 的 id（索引来自远端，不能拿它当路径片段直接拼）。
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { sendJson } from '../json-response.js';
import { bodyReader } from '../http-body.js';

/* ── 站点 ────────────────────────────────────────────────────────────────── */

const SKINS_SITE = 'https://folia-major-3t6.pages.dev';
const SKINS_INDEX_PATH = '/skins/manifest.json';
const SKINS_TTL_MS = 60000;
const SKINS_TIMEOUT_MS = 8000;
/** 单个 zip 上限：站点上最大的是 8 MB 那套（whalechan-harness），留足余量。 */
const SKIN_ZIP_MAX_BYTES = 32 * 1024 * 1024;
/** 分卷拼接后的总上限（DIY 手账本 3 段合计约 67 MB，留余量）。 */
const SKIN_TOTAL_MAX_BYTES = 128 * 1024 * 1024;
const CONTROL_JSON_MAX_BYTES = 64 * 1024;
const ACTIVE_FILE = 'skin-center-active.json';
const SKINS_DIR_NAME = 'skins';
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** `DSH_FOLIA_SKINS_SITE` → 归一化基址；`off`/空串表示停用整条通道。 */
function skinsSiteBase() {
  const raw = process.env.DSH_FOLIA_SKINS_SITE;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return null;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : SKINS_SITE;
  return base.replace(/\/+$/, '');
}

/** @type {{ at: number, payload: any[] | null, error: string | null }} */
let indexCache = { at: 0, payload: null, error: null };

/**
 * harness 根目录（`skins/` 与 `skin-center-active.json` 所在的那一层）。
 *
 * 桌面版是 `<userData>/harness`（Electron 的 `--user-data-dir` 是 `%APPDATA%\dsh-desktop`）；
 * CLI 版是 `~/.dsh`。两边都没有权威 API 可问，所以按候选逐个试，**以 `skins/` 或
 * `skin-center-active.json` 是否存在为准**。`DSH_FOLIA_HARNESS` 可强制指定（自检/异形安装）。
 * @returns {string | null}
 */
export function harnessRoot() {
  const forced = process.env.DSH_FOLIA_HARNESS;
  if (typeof forced === 'string' && forced.trim()) return resolve(forced.trim());
  const home = homedir();
  /** @type {string[]} */
  const candidates = [];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  if (appData) candidates.push(join(appData, 'dsh-desktop', 'harness'));
  if (localAppData) candidates.push(join(localAppData, 'dsh-desktop', 'harness'));
  candidates.push(join(home, '.dsh', 'harness'), join(home, '.dsh'), join(home, '.dsh-desktop', 'harness'));
  for (const c of candidates) {
    try {
      if (existsSync(join(c, SKINS_DIR_NAME)) || existsSync(join(c, ACTIVE_FILE))) return c;
    } catch { /* 单个候选读不到 ⇒ 试下一个 */ }
  }
  return null;
}

/* ── 索引 ────────────────────────────────────────────────────────────────── */

/**
 * 拉站点索引并**精简**成客户端要的形状。永不抛；失败返回 `{ items: [], error }`。
 *
 * 为什么精简：原始 manifest 62 KB / 65 条，每条还带完整 description 与 parts 清单；
 * 客户端一次拿全没有意义，只留卡片需要的字段 + `zipRelative`（安装时回传给宿主）。
 */
async function fetchIndex(force = false) {
  const base = skinsSiteBase();
  if (!base) return { items: [], error: 'disabled' };
  if (!force && Date.now() - indexCache.at < SKINS_TTL_MS) {
    return { items: indexCache.payload || [], error: indexCache.error };
  }

  let items = [];
  let error = null;
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(SKINS_TIMEOUT_MS)
      : undefined;
    const res = await fetch(base + SKINS_INDEX_PATH, { headers: { accept: 'application/json' }, signal });
    if (!res.ok) {
      error = 'http-' + res.status;
    } else {
      let doc;
      try {
        doc = await res.json();
      } catch {
        error = 'json';
      }
      if (doc) {
        const list = Array.isArray(doc.skins) ? doc.skins : [];
        for (const s of list) {
          const id = String((s && s.id) || '');
          if (!ID_RE.test(id)) continue;
          // 分卷包（DIY 手账本那种 67 MB 三段）：`parts` 是 **对象数组** `{name, bytes}`，
          // 也兼容纯字符串形态 —— 早期实现只认字符串，把 diy-journal 整条静默丢了
          //（manifest 65 条、列表只出 64 条，就是它）。
          const parts = (Array.isArray(s.parts) ? s.parts : [])
            .map((p) => (typeof p === 'string' ? p : (p && typeof p.name === 'string' ? p.name : '')))
            .filter(Boolean);
          const zip = typeof s.zip === 'string' ? s.zip : '';
          if (!zip && parts.length === 0) continue;
          items.push({
            id,
            name: String(s.name || id),
            nameEn: String(s.nameEn || ''),
            version: String(s.version || ''),
            author: String(s.author || ''),
            accent: typeof s.accent === 'string' ? s.accent : '',
            tagline: String(s.tagline || ''),
            tags: Array.isArray(s.tags) ? s.tags.slice(0, 8).map(String) : [],
            zipBytes: Number(s.zipBytes) || 0,
            sha256: typeof s.sha256 === 'string' ? s.sha256 : '',
            zipRelative: zip,
            parts: parts.slice(0, 16),
            previewLight: (s.preview && typeof s.preview.light === 'string') ? s.preview.light : '',
            previewDark: (s.preview && typeof s.preview.dark === 'string') ? s.preview.dark : '',
          });
        }
      }
    }
  } catch (e) {
    const code = String((e && (e.name || e.code)) || '');
    const msg = String((e && e.message) || '');
    if (/timeout|abort/i.test(code) || /timeout|aborted/i.test(msg)) error = 'timeout';
    else if (/cert|tls|ssl/i.test(msg)) error = 'tls';
    else error = 'network';
  }

  indexCache = { at: Date.now(), payload: items, error };
  return { items, error };
}

/* ── 本机状态 ─────────────────────────────────────────────────────────────── */

/** 本机已装的皮肤 id 集合（`skins/` 下的目录名）。 */
function installedIds(harness) {
  const dir = join(harness, SKINS_DIR_NAME);
  try {
    return new Set(readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
  } catch {
    return new Set();
  }
}

/** 皮肤中心当前的 `active`（读不到就当没有 —— fail-open，不影响列表）。 */
function activeSkinId(harness) {
  try {
    const doc = JSON.parse(readFileSync(join(harness, ACTIVE_FILE), 'utf8'));
    return typeof doc.active === 'string' ? doc.active : null;
  } catch {
    return null;
  }
}

/* ── zip 解压（纯 JS，零依赖）────────────────────────────────────────────── */

/** 从中央目录读条目表。只支持 store(0) / deflate(8)，够用且不引依赖。 */
function zipEntries(buf) {
  // 找 EOCD（0x06054b50），从尾部往前扫（注释区最多 65535 字节）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录条目损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    out.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 校验条目名是安全的相对路径，并返回归一化后的相对段。 */
function safeRelPath(name) {
  const norm = String(name).replace(/\\/g, '/');
  if (!norm || norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return null;
  const segs = norm.split('/').filter((s) => s && s !== '.');
  if (segs.length === 0) return null;
  for (const s of segs) {
    if (s === '..') return null;
    if (s.includes('\0')) return null;
  }
  return segs;
}

/**
 * 解压到 `destDir`。**先解到临时目录再整体改名**，中途失败不留半个皮肤。
 * @returns {{ files: number }}
 */
function extractZipTo(buf, destDir, tmpDir) {
  const entries = zipEntries(buf);
  let files = 0;
  for (const e of entries) {
    const segs = safeRelPath(e.name);
    if (!segs) throw new Error('zip 内含不安全路径：' + e.name);
    // 本地文件头长度可变（name/extra 可能与中央目录不同），必须重读
    const lo = e.localOff;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地文件头损坏：' + e.name);
    const lNameLen = buf.readUInt16LE(lo + 26);
    const lExtraLen = buf.readUInt16LE(lo + 28);
    const dataStart = lo + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compSize);
    const isDir = e.name.endsWith('/');
    const target = join(tmpDir, ...segs);
    // 兜底：拼接后必须仍在 tmpDir 里（防 zip-slip 的任何漏网）
    if (!resolve(target).startsWith(resolve(tmpDir) + sep)) throw new Error('zip 路径越界：' + e.name);
    if (isDir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = inflateRawSync(raw);
    else throw new Error('不支持的 zip 压缩方式 ' + e.method + '：' + e.name);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, data);
    files++;
  }
  if (files === 0) throw new Error('zip 里没有任何文件');
  return { files };
}

/* ── 下载 ────────────────────────────────────────────────────────────────── */

async function fetchBytes(url, maxBytes) {
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(SKINS_TIMEOUT_MS * 4)   // 8 MB 的包在跨境链路上要给足时间
    : undefined;
  const res = await fetch(url, { headers: { accept: '*/*' }, signal });
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > maxBytes) throw new Error('皮肤包过大：' + len + ' 字节');
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > maxBytes) throw new Error('皮肤包过大：' + buf.length + ' 字节');
  if (buf.length === 0) throw new Error('下载到 0 字节');
  return buf;
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/* ── 路由 ────────────────────────────────────────────────────────────────── */

/**
 * @param {any} webServer
 * @param {{ disposers: Function[], base: string, log?: Function }} c
 */
export function registerSkinRoutes(webServer, c) {
  const { disposers, base, log } = c;
  const note = typeof log === 'function' ? log : () => {};

  /**
   * 读一个小 JSON body（{id}）并校验成合法皮肤 id。解析失败 / 缺 id / 越界一律 null ⇒ 调用方回 400。
   *
   * ⚠️ `bodyReader` 是「处理器 + 取值器」模式（见 lib/http-body.js 文件头的用法），**没有**
   * `await reader.text()` 这种异步形态 —— 监听器由调用点挂，这里包一层 Promise 收口。
   */
  function readIdBody(req) {
    return new Promise((resolveId) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolveId(v); } };
      const reader = bodyReader(req, {
        maxBytes: CONTROL_JSON_MAX_BYTES,
        // 越限当场判失败：body 不该继续占内存，也不该等到 end 才应 400。
        onOverflow: () => done(null),
      });
      req.on('data', reader.onData);
      req.on('end', () => {
        if (reader.overflowed) { done(null); return; }
        let doc;
        try {
          doc = JSON.parse(reader.text());
        } catch {
          done(null);
          return;
        }
        const id = doc && typeof doc.id === 'string' ? doc.id : '';
        done(ID_RE.test(id) ? id : null);
      });
      req.on('error', () => done(null));
    });
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const force = url.searchParams.get('refresh') === '1';
      const harness = harnessRoot();
      const { items, error } = await fetchIndex(force);
      const installed = harness ? installedIds(harness) : new Set();
      const active = harness ? activeSkinId(harness) : null;
      const merged = items.map((it) => ({
        ...it,
        installed: installed.has(it.id),
        active: it.id === active,
      }));
      sendJson(res, 200, {
        ok: error === null,
        error,
        site: skinsSiteBase(),
        harness,
        harnessFound: Boolean(harness),
        active,
        count: merged.length,
        installedCount: [...installed].length,
        skins: merged,
      });
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/install`,
    handler: async (req, res) => {
      const id = await readIdBody(req);
      if (!id) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const harness = harnessRoot();
      if (!harness) { sendJson(res, 503, { ok: false, error: 'harness-not-found' }); return; }
      const site = skinsSiteBase();
      if (!site) { sendJson(res, 503, { ok: false, error: 'disabled' }); return; }

      const { items } = await fetchIndex();
      const entry = items.find((x) => x.id === id);
      if (!entry) { sendJson(res, 404, { ok: false, error: 'unknown-skin' }); return; }

      const skinsDir = join(harness, SKINS_DIR_NAME);
      const destDir = join(skinsDir, id);
      const tmpDir = join(skinsDir, '.' + id + '.tmp-' + Date.now().toString(36));
      try {
        // 分卷包：按顺序拼接成完整 zip
        let buf;
        if (entry.parts.length > 0) {
          const chunks = [];
          for (const p of entry.parts) {
            chunks.push(await fetchBytes(site + '/' + String(p).replace(/^\/+/, ''), SKIN_ZIP_MAX_BYTES));
          }
          buf = Buffer.concat(chunks);
          // 拼接后总量另设一道闸：单包 32 MB 的上限管不住 3 段拼起来的 67 MB。
          if (buf.length > SKIN_TOTAL_MAX_BYTES) {
            throw new Error('分卷拼接后过大：' + buf.length + ' 字节');
          }
        } else {
          buf = await fetchBytes(site + '/' + String(entry.zipRelative).replace(/^\/+/, ''), SKIN_ZIP_MAX_BYTES);
        }

        // 哈希校验：manifest 里给的是**截断**哈希（16 位十六进制），按前缀比
        if (entry.sha256 && /^[0-9a-f]+$/i.test(entry.sha256)) {
          const actual = sha256Hex(buf);
          if (!actual.toLowerCase().startsWith(entry.sha256.toLowerCase())) {
            throw new Error('校验失败：sha256 不匹配（下载可能被截断）');
          }
        }

        mkdirSync(skinsDir, { recursive: true });
        rmSync(tmpDir, { recursive: true, force: true });
        mkdirSync(tmpDir, { recursive: true });
        const { files } = extractZipTo(buf, destDir, tmpDir);

        // zip 顶层就是 `<id>/`：把它里面的内容搬到 destDir
        const inner = join(tmpDir, id);
        const innerExists = existsSync(inner) && statSync(inner).isDirectory();
        const payload = innerExists ? inner : tmpDir;
        rmSync(destDir, { recursive: true, force: true });
        mkdirSync(destDir, { recursive: true });
        for (const name of readdirSync(payload)) {
          const from = join(payload, name);
          const to = join(destDir, name);
          // 同一分区：rename 最快；跨设备时退化为复制
          try {
            renameSyncSafe(from, to);
          } catch {
            cpSyncSafe(from, to);
          }
        }
        rmSync(tmpDir, { recursive: true, force: true });

        if (!existsSync(join(destDir, 'skin.json'))) {
          throw new Error('装完没有 skin.json —— zip 结构不对');
        }
        note('[skins] installed ' + id + ' (' + files + ' files)');
        sendJson(res, 200, { ok: true, id, files, bytes: buf.length, installed: true });
      } catch (err) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 清理失败不影响应答 */ }
        const msg = String((err && err.message) || err);
        note('[skins] install ' + id + ' failed: ' + msg);
        sendJson(res, 502, { ok: false, error: 'install-failed', detail: msg });
      }
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/activate`,
    handler: async (req, res) => {
      const id = await readIdBody(req);
      if (!id) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const harness = harnessRoot();
      if (!harness) { sendJson(res, 503, { ok: false, error: 'harness-not-found' }); return; }
      if (!existsSync(join(harness, SKINS_DIR_NAME, id, 'skin.json'))) {
        sendJson(res, 404, { ok: false, error: 'not-installed' });
        return;
      }
      const file = join(harness, ACTIVE_FILE);
      let doc = {};
      try {
        doc = JSON.parse(readFileSync(file, 'utf8')) || {};
      } catch { /* 文件不存在 / 坏掉 ⇒ 用最小骨架重建 */ }
      // 只改 `active`：background 那一段是皮肤中心自己的设置，一个字都不能丢。
      doc.active = id;
      if (typeof doc.initialized !== 'boolean') doc.initialized = true;
      try {
        writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
        note('[skins] activated ' + id);
        sendJson(res, 200, { ok: true, id, active: id, restartRequired: true });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'write-failed', detail: String(err && err.message || err) });
      }
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/remove`,
    handler: async (req, res) => {
      const id = await readIdBody(req);
      if (!id) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const harness = harnessRoot();
      if (!harness) { sendJson(res, 503, { ok: false, error: 'harness-not-found' }); return; }
      if (activeSkinId(harness) === id) {
        sendJson(res, 409, { ok: false, error: 'skin-active' });
        return;
      }
      const dir = join(harness, SKINS_DIR_NAME, id);
      if (!existsSync(dir)) { sendJson(res, 404, { ok: false, error: 'not-installed' }); return; }
      try {
        rmSync(dir, { recursive: true, force: true });
        note('[skins] removed ' + id);
        sendJson(res, 200, { ok: true, id, removed: true });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'remove-failed', detail: String(err && err.message || err) });
      }
    },
  }));

  /* ── 热切换：把皮肤样式自己喂给浏览器 ──────────────────────────────────────
   * 皮肤中心只在**页面加载时**应用皮肤（它的 host 侧把样式塞进文档、client 侧启动时拉
   * `/api/skin-center/v2/active`），桌面壳里 `location.reload()` 又常常被吞掉 ⇒
   * 用户点「使用」后界面永远不变。
   *
   * 所以这里补两条只读路由，把 `harness/skins/<id>/` 里的样式与素材直接发给页面：
   *   GET /skins/css?id=<id>            → skin.css（`url()` 已重写成下面那条素材路由）
   *   GET /skins/asset?id=<id>&p=<rel>  → 皮肤目录里的任意素材（图片/字体）
   * 客户端把 CSS 挂成一个 `<link id="folia-skin-hot">` 追加在 `<head>` 末尾 ——
   * 后加载的规则覆盖先前的，于是**不刷新也能换肤**；hooks（粒子等）不会跑，那部分
   * 仍归皮肤中心管。
   */

  /** 读一套皮肤的 manifest，拿 `contributes.stylesheet`。 */
  function skinStylesheetOf(dir) {
    try {
      const doc = JSON.parse(readFileSync(join(dir, 'skin.json'), 'utf8'));
      const rel = doc && doc.contributes && doc.contributes.stylesheet;
      if (typeof rel !== 'string') return null;
      const segs = safeRelPath(rel);
      if (!segs || segs.includes('..')) return null;
      return { rel: segs.join('/'), doc };
    } catch {
      return null;
    }
  }

  /**
   * 取 manifests 里某个可选的样式类字段（当前用于 `patches`）。
   * 与 stylesheet 同样的安全校验：只接受皮肤目录内的相对路径。
   */
  function skinAuxFileOf(dir, key) {
    try {
      const doc = JSON.parse(readFileSync(join(dir, 'skin.json'), 'utf8'));
      const rel = doc && doc.contributes && doc.contributes[key];
      if (typeof rel !== 'string' || !rel) return null;
      const segs = safeRelPath(rel);
      if (!segs || segs.includes('..')) return null;
      return segs.join('/');
    } catch {
      return null;
    }
  }

  const ASSET_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
  };

  /* ── 背景层数据 ────────────────────────────────────────────────────────────
   * 一套皮肤的"背景"不在 CSS 里，而是 `contributes.backgroundMedia`：
   *   { light: { type: 'video'|'image', src: 'assets/x.mp4', scrim: '<css 渐变>' }, dark: {...} }
   * 皮肤中心负责把这层画出来；它的 DOM 契约（从各皮肤 CSS 反推）是
   *   `body [data-dsh-skin-layer='background']`，z-index -2，视频/图片作为子元素
   *（`future-window` 直接写 `> img`，`frutiger-aero` 用 `::after` 叠气泡）。
   * 热切换时没人建这层 ⇒ 背景全空（"水墨丹青没有背景动画"就是这个原因）。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/manifest`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) { sendJson(res, 400, { ok: false, error: 'bad-id' }); return; }
      const harness = harnessRoot();
      if (!harness) { sendJson(res, 503, { ok: false, error: 'harness-not-found' }); return; }
      const dir = join(harness, SKINS_DIR_NAME, id);
      let doc;
      try {
        doc = JSON.parse(readFileSync(join(dir, 'skin.json'), 'utf8'));
      } catch {
        sendJson(res, 404, { ok: false, error: 'no-manifest' });
        return;
      }
      const c = (doc && doc.contributes) || {};
      const media = c.backgroundMedia && typeof c.backgroundMedia === 'object' ? c.backgroundMedia : null;
      /** `src` 相对路径 → 我们的素材路由（浏览器只认这条）。 */
      const abs = (rel) => {
        if (typeof rel !== 'string' || !rel) return '';
        if (/^(?:[a-z]+:|\/)/i.test(rel)) return rel;
        return `${base}/skins/asset?id=${encodeURIComponent(id)}&p=${encodeURIComponent(rel)}`;
      };
      const shape = (m) => (m && typeof m === 'object' ? {
        type: m.type === 'video' ? 'video' : 'image',
        url: abs(m.src),
        scrim: typeof m.scrim === 'string' ? m.scrim : '',
      } : null);
      sendJson(res, 200, {
        ok: true,
        id,
        name: typeof doc.name === 'string' ? doc.name : id,
        backgroundMedia: media ? { light: shape(media.light), dark: shape(media.dark) } : null,
        // ⚠️ hooks 的声明位置是 **`facets.client.entry`**，不是 `contributes.hooks`
        //（契约见皮肤中心 contracts/hooks-api.d.ts：`facets.client.entry (hooks.mjs)`）。
        // 之前读 contributes.hooks ⇒ 28 套带动效的皮肤全部"无动效"，而那正是它们
        // 看起来"显示不全"的部分（粒子/漂浮/交互）。这里两个位置都认，以 facets 为准。
        hooks: (() => {
          const facets = (doc && doc.facets) || null;
          const client = facets && facets.client;
          if (client && typeof client.entry === 'string' && client.entry) return client.entry;
          return typeof c.hooks === 'string' ? c.hooks : '';
        })(),
      });
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/css`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) { res.statusCode = 400; res.end(); return; }
      const harness = harnessRoot();
      if (!harness) { res.statusCode = 503; res.end(); return; }
      const dir = join(harness, SKINS_DIR_NAME, id);
      const sheet = skinStylesheetOf(dir);
      if (!sheet) { res.statusCode = 404; res.end(); return; }
      let css;
      try {
        // ⚠️ 一套皮肤通常有**两份样式**：`contributes.stylesheet`（token 与结构）与
        // `contributes.patches`（覆盖补丁）。**很多皮肤把全部改动写在 patches 里，
        // stylesheet 故意留空**（例如 black-gold-vip 的 skin.css 只有一行注释）。
        // 只下发 stylesheet ⇒ 换肤"看起来毫无变化"。两份都读，patches 放在后面覆盖。
        const files = [];
        files.push(sheet.rel);
        const patchesRel = skinAuxFileOf(dir, 'patches');
        if (patchesRel) files.push(patchesRel);
        css = files.map((rel) => {
          try { return readFileSync(join(dir, ...rel.split('/')), 'utf8'); } catch { return ''; }
        }).join('\n/* ---- patches ---- */\n');
      } catch {
        res.statusCode = 404;
        res.end();
        return;
      }
      // `url(...)` 全部改写成素材路由：CSS 是从 `/folia/skins/css` 下发的，相对路径会
      // 解析到错误的前缀；改成绝对路径后，图片/字体才找得到。
      const baseDir = sheet.rel.includes('/') ? sheet.rel.slice(0, sheet.rel.lastIndexOf('/')) : '';
      const abs = (p) => {
        if (/^(?:[a-z]+:|\/|#|data:)/i.test(p)) return p;
        const rel = (baseDir ? baseDir + '/' : '') + p;
        return `${base}/skins/asset?id=${encodeURIComponent(id)}&p=${encodeURIComponent(rel)}`;
      };
      css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, p) => `url("${abs(p.trim())}")`);
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      // 不缓存：换皮肤后必须立刻拿到新的一份，否则用户会看到上一套的样式。
      res.setHeader('Cache-Control', 'no-store');
      res.end(css);
    },
  }));

  /* ── 路径式素材路由 ────────────────────────────────────────────────────────
   * 皮肤的 hooks 契约（`contracts/hooks-api.d.ts`）给的是 `assetBase`：一个**同源 URL
   * 前缀**，hooks 里自己拼 `assetBase + 'assets/x.webp'`。`?id=&p=` 这种查询式前缀拼不出
   * 合法地址，所以这里再提供一条路径式：`/skins/files/<id>/<相对路径>`。
   * 与 asset 完全同一套安全校验（id 白名单 + 路径段 + 越界检查）。
   */
  disposers.push(webServer.register({
    kind: 'prefix',
    path: `${base}/skins/files`,
    handler: async (req, res) => {
      let pathname = '/';
      try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch { res.statusCode = 400; res.end(); return; }
      const prefix = `${base}/skins/files/`;
      if (!pathname.startsWith(prefix)) { res.statusCode = 404; res.end(); return; }
      const rest = decodeURIComponent(pathname.slice(prefix.length));
      const slash = rest.indexOf('/');
      const id = slash < 0 ? rest : rest.slice(0, slash);
      const rel = slash < 0 ? '' : rest.slice(slash + 1);
      if (!ID_RE.test(id)) { res.statusCode = 400; res.end(); return; }
      const segs = safeRelPath(rel);
      if (!segs || segs.includes('..')) { res.statusCode = 400; res.end(); return; }
      const harness = harnessRoot();
      if (!harness) { res.statusCode = 503; res.end(); return; }
      const root = join(harness, SKINS_DIR_NAME, id);
      const file = join(root, ...segs);
      if (!resolve(file).startsWith(resolve(root) + sep)) { res.statusCode = 400; res.end(); return; }
      if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
      const ext = (file.slice(file.lastIndexOf('.')).toLowerCase() || '');
      res.setHeader('Content-Type', ASSET_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(readFileSync(file));
    },
  }));

  /* ── 自己实现「作用域化」，不再依赖皮肤中心的接口 ────────────────────────────
   *
   * 皮肤中心的 `/api/skin-center/v2/skins/<id>/stylesheet` 会走 `transformSkinCss()`：
   * 把**每条选择器**包进 `html[data-dsh-skin="<id>"]`。这一步决定皮肤能不能压住应用
   * 自身的面板/令牌规则 —— 作用域化之后特异性更高。
   *
   * 但那条路由在网关后面：浏览器直连 401，宿主代发（哪怕透传全部请求头）也可能 401。
   * 而"让每个用户把自己的会话凭证交给插件"不是可交付的方案。所以这里**自己算**：
   * 读皮肤目录里的 CSS，做同一件事，输出等价结果。
   *
   * 转换规则：
   *   · 普通规则：`a, b` → `html[data-dsh-skin="x"] a, html[data-dsh-skin="x"] b`
   *   · 以 `:root` 开头的：开头换成作用域本身
   *   · 以 `html` 开头的：原样保留（作者自己已作用域化，别套两层）
   *   · `@media/@supports/@layer/@container`：**递归进去**处理内部规则
   *   · `@keyframes/@font-face/@page/@property/@import`：原样保留
   *     （关键帧内部是 `0% {}` 这种选择器，套作用域会直接毁掉动画）
   */

  /** 从 `openIdx`（指向 `{`）找配对的 `}`，跳过注释与字符串。找不到返回 -1。 */
  function matchBrace(css, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < css.length; i++) {
      const ch = css[i];
      if (ch === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2);
        if (end < 0) return -1;
        i = end + 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        for (i++; i < css.length; i++) {
          if (css[i] === '\\') { i++; continue; }
          if (css[i] === quote) break;
        }
        continue;
      }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /** 单个选择器 → 作用域化后的选择器。 */
  function scopeSelector(sel, scope) {
    const t = sel.trim();
    if (!t) return t;
    if (/^:root\b/.test(t)) return t.replace(/^:root/, scope);
    if (/^html\b/i.test(t)) return t;          // 作者已作用域化，别套两层
    return scope + ' ' + t;
  }

  /** 选择器列表 → 逐项作用域化。**不切括号内的逗号**（:is()/:not()/[a="b,c"]）。 */
  function scopeSelectorList(list, scope) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of list) {
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map((s) => scopeSelector(s, scope)).join(', ');
  }

  const GROUP_AT = /^@(media|supports|layer|container|scope)\b/i;
  const KEEP_AT = /^@(keyframes|-webkit-keyframes|font-face|page|property|counter-style|import|charset|namespace)\b/i;

  /** 把整段 CSS 作用域化。看不懂的结构就原样跳过该段（宁可少转，不可转坏）。 */
  function scopeCss(css, id) {
    const scope = `html[data-dsh-skin="${id}"]`;
    let out = '';
    let i = 0;
    while (i < css.length) {
      if (css[i] === '/' && css[i + 1] === '*') {          // 注释原样保留
        const end = css.indexOf('*/', i + 2);
        if (end < 0) { out += css.slice(i); break; }
        out += css.slice(i, end + 2);
        i = end + 2;
        continue;
      }
      if (/\s/.test(css[i])) { out += css[i++]; continue; }

      if (css[i] === '@') {
        const headEnd = css.indexOf('{', i);
        const semi = css.indexOf(';', i);
        if (semi >= 0 && (headEnd < 0 || semi < headEnd)) {  // 无块 at-rule
          out += css.slice(i, semi + 1);
          i = semi + 1;
          continue;
        }
        if (headEnd < 0) { out += css.slice(i); break; }
        const head = css.slice(i, headEnd).trim();
        const close = matchBrace(css, headEnd);
        if (close < 0) { out += css.slice(i); break; }
        const inner = css.slice(headEnd + 1, close);
        // 分组 at-rule 递归进去；其余（关键帧/字体面/未知）原样保留
        out += head + '{' + (GROUP_AT.test(head) ? scopeCss(inner, id) : inner) + '}';
        i = close + 1;
        continue;
      }

      const braceIdx = css.indexOf('{', i);                 // 普通规则
      if (braceIdx < 0) { out += css.slice(i); break; }
      const selector = css.slice(i, braceIdx);
      const close = matchBrace(css, braceIdx);
      if (close < 0) { out += css.slice(i); break; }
      out += scopeSelectorList(selector, scope) + '{' + css.slice(braceIdx + 1, close) + '}';
      i = close + 1;
    }
    return out;
  }

  /* ── 皮肤中心「加工后 CSS」的宿主端代理 ──────────────────────────────────────
   * 皮肤中心的 `/skins/<id>/stylesheet|patches` 是 `transformSkinCss()` 的产物：
   * **每条规则被强制包进 `html[data-dsh-skin="<id>"]`**，特异性高于应用自身规则 ——
   * 只有那份 CSS 才能真正把面板压透。皮肤目录里的原始 CSS 压不住，于是"显示不全"。
   *
   * 为什么需要代理：浏览器直接请求 `/api/skin-center/v2/...` 被 DSH 网关挡掉
   *（实测前端一直落到"未作用域化"的降级分支）。宿主端在本机回环上再发一次、并**带上
   * 浏览器这次请求的 Cookie 与同源头**，就能拿到那份产物。
   *
   * 拿不到（皮肤中心没装 / 该皮肤不在它的 catalog 里）一律 404，客户端据此回退到原始 CSS。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/scoped-css`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const id = url.searchParams.get('id') || '';
      if (!ID_RE.test(id)) { res.statusCode = 400; res.end(); return; }
      const host = req && req.headers && req.headers.host;
      if (!host) { res.statusCode = 500; res.end(); return; }
      const origin = 'http://' + host;
      // 透传**全部**入站头（网关认的是这次会话的凭证，可能是 cookie，也可能是某个自定义
      // 头；只挑几个字段必漏），再去掉逐跳头并补上同源语义。
      // 实测：裸请求与"只带 sec-fetch-*"都回 401 ⇒ 凭证不在这几个头里。
      const HOP_BY_HOP = new Set([
        'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
        'proxy-authorization', 'proxy-authenticate', 'content-length', 'accept-encoding',
      ]);
      const fwdHeaders = {};
      for (const [k, v] of Object.entries(req.headers || {})) {
        const key = k.toLowerCase();
        if (HOP_BY_HOP.has(key)) continue;
        if (typeof v === 'string') fwdHeaders[key] = v;
        else if (Array.isArray(v)) fwdHeaders[key] = v.join(', ');
      }
      fwdHeaders.origin = origin;
      fwdHeaders.referer = origin + '/';
      fwdHeaders['sec-fetch-site'] = 'same-origin';
      fwdHeaders['sec-fetch-mode'] = 'cors';
      fwdHeaders['sec-fetch-dest'] = 'empty';
      fwdHeaders.accept = 'text/css,*/*;q=0.1';

      for (const part of ['stylesheet', 'patches']) {
        try {
          const r = await fetch(origin + '/api/skin-center/v2/skins/' + encodeURIComponent(id) + '/' + part, {
            headers: fwdHeaders,
            signal: AbortSignal.timeout(SKINS_TIMEOUT_MS),
          });
          if (!r.ok) continue;
          const text = await r.text();
          if (!text || !text.trim()) continue;
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Folia-Scoped', 'skin-center');
          res.end(text);
          return;
        } catch { /* 这一段失败就试下一段 */ }
      }

      // 代理拿不到（网关拦截 / 没装皮肤中心）⇒ **自己作用域化**。
      // 这条路不依赖任何凭证，也不依赖对方的进程，对所有用户一致成立。
      const harness = harnessRoot();
      if (!harness) { res.statusCode = 503; res.end(); return; }
      const dir = join(harness, SKINS_DIR_NAME, id);
      const sheet = skinStylesheetOf(dir);
      if (!sheet) { res.statusCode = 404; res.end(); return; }
      const raw = [];
      try { raw.push(readFileSync(join(dir, ...sheet.rel.split('/')), 'utf8')); } catch { /* 主样式读不到就不能算成功 */ }
      if (raw.length === 0) { res.statusCode = 404; res.end(); return; }
      const patches = skinAuxFileOf(dir, 'patches');
      if (patches) {
        try { raw.push(readFileSync(join(dir, ...patches.split('/')), 'utf8')); } catch { /* 补丁缺失可接受 */ }
      }
      // url() 先改写成我们的素材路由（作用域化只动选择器，不动声明）。
      const baseDir = sheet.rel.includes('/') ? sheet.rel.slice(0, sheet.rel.lastIndexOf('/')) : '';
      const absUrl = (p) => {
        if (/^(?:[a-z]+:|\/|#|data:)/i.test(p)) return p;
        const rel = (baseDir ? baseDir + '/' : '') + p;
        return `${base}/skins/asset?id=${encodeURIComponent(id)}&p=${encodeURIComponent(rel)}`;
      };
      const merged = raw.join('\n/* ---- patches ---- */\n')
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, p) => `url("${absUrl(p.trim())}")`);
      const scoped = scopeCss(merged, id);
      note('[skins] scoped locally: ' + id + ' (' + scoped.length + ' bytes)');
      res.setHeader('Content-Type', 'text/css; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Folia-Scoped', 'local');
      res.end(scoped);
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/asset`,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://x');
      const id = url.searchParams.get('id') || '';
      const rel = url.searchParams.get('p') || '';
      if (!ID_RE.test(id)) { res.statusCode = 400; res.end(); return; }
      const segs = safeRelPath(rel);
      if (!segs || segs.includes('..')) { res.statusCode = 400; res.end(); return; }
      const harness = harnessRoot();
      if (!harness) { res.statusCode = 503; res.end(); return; }
      const root = join(harness, SKINS_DIR_NAME, id);
      const file = join(root, ...segs);
      if (!resolve(file).startsWith(resolve(root) + sep)) { res.statusCode = 400; res.end(); return; }
      if (!existsSync(file) || !statSync(file).isFile()) { res.statusCode = 404; res.end(); return; }
      const ext = (file.slice(file.lastIndexOf('.')).toLowerCase() || '');
      res.setHeader('Content-Type', ASSET_TYPES[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.end(readFileSync(file));
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/skins/preview`,
    handler: async (req, res) => {
      // 预览图代理：浏览器不能直连站点（跨境），也避免把站点 URL 散到客户端各处。
      const url = new URL(req.url || '/', 'http://x');
      const rel = url.searchParams.get('p') || '';
      const site = skinsSiteBase();
      if (!site) { res.statusCode = 503; res.end(); return; }
      const segs = safeRelPath(rel);
      if (!segs || segs.includes('..')) { res.statusCode = 400; res.end(); return; }
      try {
        const r = await fetch(site + '/' + segs.join('/'), {
          headers: { accept: 'image/*' },
          signal: AbortSignal.timeout(SKINS_TIMEOUT_MS),
        });
        if (!r.ok) { res.statusCode = 404; res.end(); return; }
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.end(buf);
      } catch {
        res.statusCode = 502;
        res.end();
      }
    },
  }));
}

/* renameSync / cpSync 的薄封装：统一「同分区 rename、跨设备退化复制」这一处。 */
function renameSyncSafe(from, to) { renameSync(from, to); }
function cpSyncSafe(from, to) { cpSync(from, to, { recursive: true }); }
