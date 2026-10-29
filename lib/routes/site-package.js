/**
 * lib/routes/site-package.js — **站点工程包 → 本机工程目录**（点击即解码的那一半）。
 *
 * 背景：站点上有大量 wallpaper-engine **工程包**（zip：`project.json` + `scene.pkg` / `*.mp4`）。
 * 它不能被 `<video>` 直接播 —— 用户看到的是「浏览器无法解码这段视频」。但它们**能**用：
 * 本机已经用同一套管线渲染着几百个 WE 场景（Steam 创意工坊那批），差别只是文件还压在 zip 里。
 *
 * 所以这里只做一件事：**把 zip 解成"本机 WE 工程目录"**，落在存储位置（上传目录）下，
 * 命名 `up-dir-<短名>-<hash6>`。落盘之后：
 *   · `lib/upload-dir.js#enumerateUploadsP` 会自动认领它（它认"含 project.json 的目录"），
 *   · 于是下一次 `/folia/inventory` 里它就变成 `type: scene|video|web` 的普通壁纸，
 *   · 走现有场景/视频/web 渲染管线播放。
 *
 * 客户端因此可以做到「点一下就用」：点卡片 → 本路由解码 → 清单刷新 → 自动选中刚解出来的那条。
 * 对用户而言没有"下载/安装"这一步，只有第一次点的时候多等一下。
 *
 * 安全（每条都有测试）：
 *   · **只下我们自己的站点**：URL 的 host 必须在白名单里（默认站点基址），挡 SSRF；
 *   · 只认 zip 魔数，解包走 `lib/zip-read.js`（拒路径穿越、限量、拒炸弹）；
 *   · 只写 `project.json` + 工程内文件，不写可执行/脚本；
 *   · 幂等：同 URL 已解过就直接返回同一个 id（不重复占盘）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readZipEntries, safeNameFromUrl } from '../zip-read.js';

export const DEPS = ['disposers', 'base', 'getUploadDir', 'log', 'siteBase'];

/** 下载上限：工程包实测 3–56MB，留到 256MB；再大就不是"点击即用"的场景了。 */
const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120000;

/** 站点的默认基址（与 inventory 同一个真源语义：以 inventory 的解析为准，这里只作兜底）。 */
const DEFAULT_SITE = 'https://folia-5ve.pages.dev';

/** 把任意 URL 归一成"允许下载的"绝对 URL；不允许就返回 null。 */
function allowedDownloadUrl(raw, allowHosts) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.host.toLowerCase();
  if (!allowHosts.includes(host)) return null;
  return u;
}

/** 流式下载并限量（Content-Length 可能缺失，所以边下边数）。 */
async function fetchZip(url, maxBytes = MAX_ZIP_BYTES) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/zip,application/octet-stream,*/*' } });
    if (!res.ok) return { ok: false, error: 'http-' + res.status };
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) return { ok: false, error: 'too-large' };
    const chunks = [];
    let total = 0;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } return { ok: false, error: 'too-large' }; }
        chunks.push(Buffer.from(value));
      }
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      total = buf.length;
      if (total > maxBytes) return { ok: false, error: 'too-large' };
      chunks.push(buf);
    }
    const buf = Buffer.concat(chunks);
    // 魔数：只认 zip（'PK\x03\x04'）与空包（'PK\x05\x06'）。
    const magic = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
    if (magic !== 0x04034b50 && magic !== 0x06054b50) return { ok: false, error: 'not-a-zip' };
    return { ok: true, buf, bytes: total };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/** 目录名：`up-dir-<短名>-<hash6>`。短名只留 ASCII（中文标题不进文件名，避免各平台差异）。 */
function dirNameFor(url, name) {
  const stem = safeNameFromUrl(url, 'pkg');
  const hint = String(name || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 24);
  let h = 0;
  const s = String(url);
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hash = h.toString(16).padStart(6, '0').slice(0, 6);
  return 'up-dir-' + (hint || stem) + '-' + hash;
}

/** 读工程描述（project.json）；缺失/坏 JSON 返回 null。 */
function readProjectJson(dir) {
  try {
    const raw = readFileSync(join(dir, 'project.json'), 'utf8');
    const p = JSON.parse(raw);
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

/**
 * 解包落盘。只写 zip 里除目录之外的全部条目（工程包里的 scene.pkg / mp4 / tex / json 都需要），
 * 但**拒绝对可执行文件的写入**：扩展名在白名单外的一律跳过（正常工程包不会带 exe/dll/bat）。
 */
const SKIP_EXEC_RE = /\.(exe|dll|bat|cmd|com|scr|ps1|sh|msi|vbs|js|jse|wsf|hta|lnk|jar)$/i;

function extractInto(dir, entries) {
  mkdirSync(dir, { recursive: true });
  let written = 0;
  const skipped = [];
  for (const e of entries) {
    if (e.isDir) continue;
    if (SKIP_EXEC_RE.test(e.name)) { skipped.push(e.name); continue; }
    const target = join(dir, e.name);
    const parent = join(target, '..');
    mkdirSync(parent, { recursive: true });
    writeFileSync(target, e.data);
    written += 1;
  }
  return { written, skipped };
}

/**
 * @param {*} webServer
 * @param {{ disposers: any[], base: string, getUploadDir: () => string, log?: Function, siteBase?: string }} c
 */
export function registerSitePackageRoutes(webServer, c) {
  const { disposers, base, getUploadDir, log } = c;
  const siteBase = String(c.siteBase || DEFAULT_SITE);
  const allowHosts = (() => {
    try { return [new URL(siteBase).host.toLowerCase()]; } catch { return [new URL(DEFAULT_SITE).host.toLowerCase()]; }
  })();
  // 测试注入：允许把 127.0.0.1 加进白名单（只在显式传入时生效）。
  if (Array.isArray(c.allowHosts)) for (const h of c.allowHosts) allowHosts.push(String(h).toLowerCase());

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${base}/site-package/install`,
    handler: async (req, res) => {
      const send = (code, payload) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(payload));
      };
      let body = {};
      try {
        const text = await new Promise((resolve, reject) => {
          let acc = '';
          req.on('data', (d) => { acc += d; if (acc.length > 64 * 1024) reject(new Error('too-large')); });
          req.on('end', () => resolve(acc));
          req.on('error', reject);
        });
        body = text ? JSON.parse(text) : {};
      } catch { send(400, { ok: false, error: 'bad-body' }); return; }

      const url = allowedDownloadUrl(body.url, allowHosts);
      if (!url) { send(400, { ok: false, error: 'host-not-allowed' }); return; }

      const uploadDir = String(getUploadDir() || '');
      if (!uploadDir) { send(500, { ok: false, error: 'no-upload-dir' }); return; }
      const dir = join(uploadDir, dirNameFor(url.toString(), body.name));

      // 幂等：已经解过且工程描述可读 ⇒ 直接返回（"第二次点"应该立刻生效）。
      const existing = readProjectJson(dir);
      if (existing && existing.type && existing.type !== 'application') {
        send(200, { ok: true, reused: true, id: 'up-dir-' + dir.split(/[\\/]/).pop().replace(/^up-dir-/, ''), type: existing.type, title: existing.title || '' });
        return;
      }

      const dl = await fetchZip(url.toString());
      if (!dl.ok) {
        try { log && log('site-package: download failed ' + dl.error + ' ' + url.toString()); } catch { /* ignore */ }
        // 状态码要分得清"对面有问题"与"这个包本身有问题"：
        // 不是 zip ⇒ 422（内容问题，重试也没用）；超限 ⇒ 413；其余（网络/404）⇒ 502。
        const code = dl.error === 'not-a-zip' ? 422 : (dl.error === 'too-large' ? 413 : 502);
        send(code, { ok: false, error: dl.error });
        return;
      }

      let parsed;
      try { parsed = readZipEntries(dl.buf); } catch (e) {
        send(422, { ok: false, error: (e && e.code) || 'bad-zip' });
        return;
      }
      const hasProject = parsed.entries.some((e) => !e.isDir && /^project\.json$/i.test(e.name));
      if (!hasProject) { send(422, { ok: false, error: 'no-project-json' }); return; }

      // 半途失败要清干净：否则下次 enumerate 会看到一个没有 project.json 的残缺目录。
      try {
        rmSync(dir, { recursive: true, force: true });
        const { written, skipped } = extractInto(dir, parsed.entries);
        const proj = readProjectJson(dir);
        if (!proj) { rmSync(dir, { recursive: true, force: true }); send(422, { ok: false, error: 'bad-project-json' }); return; }
        if (String(proj.type || '') === 'application') {
          rmSync(dir, { recursive: true, force: true });
          send(422, { ok: false, error: 'application-package' });
          return;
        }
        send(200, {
          ok: true,
          id: 'up-dir-' + dir.split(/[\\/]/).pop().replace(/^up-dir-/, ''),
          type: String(proj.type || 'scene'),
          title: String(proj.title || ''),
          written,
          skipped: skipped.length,
          bytes: dl.bytes,
        });
      } catch (e) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        send(500, { ok: false, error: 'extract-failed', detail: e && e.message });
      }
    },
  }));
}

// 只为测试导出（纯函数，不碰 IO）：白名单与目录命名是安全与幂等的两处要点。
export { allowedDownloadUrl, dirNameFor };
