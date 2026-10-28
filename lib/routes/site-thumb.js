/**
 * routes/site-thumb.js — 站点图片的**缩略图代理**。
 *
 * 为什么需要它：站点上的壁纸是 1024×1024 起的原图（实测一张 536 KB）。卡片网格一页
 * 9~12 张，一次要下 5 MB 左右，在慢网络上就是"站点壁纸加载很慢"。
 *
 * 做法：宿主把原图抓一次存到缓存，然后用**已有的** `ensureImagePreview`（ffmpeg 缩到
 * 320px、q=5，约 10 KB）生成小图，之后每次都直接发小图。原图只下一次、只在第一次。
 *
 * 三条纪律：
 *   · **只代理白名单主机**（站点基址与素材桶），避免变成任意 URL 的开放代理；
 *   · 任何失败都 **302 回原图** —— 慢一点但一定能显示，绝不 404；
 *   · 缩略图与源图都按 URL 的 sha1 命名，天然幂等，不需要失效逻辑。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;

const DEFAULT_SITE = 'https://folia-5ve.pages.dev';
const DEFAULT_ASSETS = 'https://pub-1275321f146e479eaac54948f4cdad6f.r2.dev';

function siteBase() {
  const raw = process.env.DSH_FOLIA_SITE;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return null;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_SITE;
  return base.replace(/\/+$/, '');
}
function assetsBase() {
  const raw = process.env.DSH_FOLIA_ASSETS;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_ASSETS;
  return base.replace(/\/+$/, '');
}

/** 源图缓存目录（与 config.json 同一个数据根）。 */
function sourceDir() {
  const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  const d = join(base, 'site-src');
  try { if (!existsSync(d)) mkdirSync(d, { recursive: true }); } catch { /* 只读盘：后面会失败并回退 */ }
  return d;
}

/** 只允许抓我们自己的两个主机。 */
function allowed(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const hosts = [siteBase(), assetsBase()].filter(Boolean).map((b) => { try { return new URL(b).host; } catch { return ''; } });
    return hosts.includes(u.host);
  } catch {
    return false;
  }
}

export function registerSiteThumbRoutes(webServer, c) {
  const { disposers, base: BASE, ensureImagePreview, log } = c;

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/site-thumb`,
    handler: async (req, res) => {
      let target = '';
      try { target = new URL(req.url || '/', 'http://x').searchParams.get('u') || ''; } catch { target = ''; }

      const redirect = () => {
        res.statusCode = 302;
        if (typeof res.setHeader === 'function') res.setHeader('location', target);
        res.end();
      };

      if (!target || !allowed(target)) { redirect(); return; }

      const key = createHash('sha1').update(target).digest('hex');
      let ext = '.jpg';
      try { ext = extname(new URL(target).pathname) || '.jpg'; } catch { /* 用默认 */ }
      const src = join(sourceDir(), key + (ext.length <= 5 ? ext : '.jpg'));

      try {
        if (!existsSync(src) || statSync(src).size === 0) {
          const r = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!r.ok) { redirect(); return; }
          const ct = String(r.headers.get('content-type') || '');
          if (!/^image\//i.test(ct)) { redirect(); return; }
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length === 0 || buf.length > MAX_SOURCE_BYTES) { redirect(); return; }
          writeFileSync(src, buf);
        }
        // 已有套件：缩到 320px（失败返回 null ⇒ 回落原图）
        const thumb = await ensureImagePreview(src).catch(() => null);
        const file = thumb && existsSync(thumb) ? thumb : src;
        const size = statSync(file).size;
        if (typeof res.setHeader === 'function') {
          res.setHeader('content-type', 'image/jpeg');
          res.setHeader('content-length', String(size));
          res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        }
        res.statusCode = 200;
        createReadStream(file).pipe(res);
      } catch (e) {
        if (typeof log === 'function') log(`[site-thumb] ${String((e && e.message) || e)}`);
        try { if (existsSync(src)) rmSync(src); } catch { /* ignore */ }
        redirect();
      }
    },
  }));
}
