/**
 * routes/modules.js — 数据模块索引（站点侧声明"有哪些数据模块"）。
 *
 * 为什么需要它：插件的能力是固定的（壁纸库、开机动画…），但**站点会一直加新东西**。
 * 把"有哪些模块、每个模块的清单在哪、该用哪个 handler 处理"放进一份索引里，插件就不必
 * 为每加一批素材发一次版 —— 它读索引，按 handler 决定自己认不认识。
 *
 * 解析顺序（**站点优先，R2 兜底，内置最后**）：
 *
 *   ① `<site>/data/modules.json`       站点自己维护的索引（你以后放进 Pages 即优先）
 *   ② `<assets>/data/modules.json`     R2 桶上的索引（当前由我们维护）
 *   ③ 内置默认                          两条都读不到时的最小集合
 *
 * 页面/助手只调 `/folia/modules` 这一个入口，具体从哪来的写在 `source` 里 —— 排查时
 * 不用猜"到底读的哪份"。
 */
import { sendJson } from '../json-response.js';

/** 站点基址（与 inventory 同一套环境变量，保持"换站只改一处"的手感）。 */
const DEFAULT_SITE = 'https://folia-5ve.pages.dev';
/** 素材桶基址：托管 <site> 上暂时没有的模块清单（例如 boot 素材）。 */
const DEFAULT_ASSETS = 'https://pub-1275321f146e479eaac54948f4cdad6f.r2.dev';

/**
 * 索引可能落在哪。**按顺序试**，第一个返回 JSON 的胜出：
 *
 *   /data/modules.json        站点自己的静态路径（你以后把文件放进 Pages 时用这条）
 *   /media/data/modules.json  站点的 /media 代理 —— 它把 /media/X 映射到 R2 的键 X，
 *                             所以这条能读到 R2 上的 data/modules.json（现在走这条）
 *
 * 为什么重要：站点的 /data/* 没有 Function，未知路径会回退 index.html；
 * 而 /media/* 有代理。走 /media/ 让"全部数据都从站点域名来"成立，R2 只是背后的仓库。
 */
const MODULES_PATHS = ['/data/modules.json', '/media/data/modules.json'];
const TTL_MS = 60000;
const TIMEOUT_MS = 8000;

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

/**
 * 内置默认索引。**只在两条网络源都不可用时使用** —— 它同时也是一份"契约示例"：
 * 想加模块时照这个形状写，不必读代码。
 */
const BUILTIN = {
  version: 1,
  modules: [
    {
      id: 'wallpapers',
      name: '壁纸',
      handler: 'wallpaper-library',
      status: 'live',
      manifest: '/data/catalog.json',
      fallbackManifest: '/manifest.json',
    },
    {
      id: 'boot',
      name: '开机动画',
      handler: 'boot-animation',
      status: 'planned',
      manifest: '/boot/manifest.json',
    },
  ],
};

/** @type {{ at: number, payload: any | null }} */
let cache = { at: 0, payload: null };

/** 形状校验：宁可判为无效（回落下一层），也不把半截数据当索引下发。 */
function normalize(doc, origin) {
  if (!doc || typeof doc !== 'object') return null;
  const list = Array.isArray(doc.modules) ? doc.modules : null;
  if (!list) return null;
  const modules = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const id = String(m.id || '').trim();
    const handler = String(m.handler || '').trim();
    if (!id || !handler) continue;       // 没有 id 或 handler 的条目无法被使用
    modules.push({
      id,
      name: String(m.name || id),
      handler,
      status: String(m.status || 'live'),
      manifest: m.manifest ? String(m.manifest) : null,
      fallbackManifest: m.fallbackManifest ? String(m.fallbackManifest) : null,
      description: m.description ? String(m.description) : null,
      requirements: m.requirements && typeof m.requirements === 'object' ? m.requirements : null,
    });
  }
  return { version: doc.version || 1, updatedAt: doc.updatedAt || null, origin, modules };
}

async function fetchJson(url) {
  // 网络抖动（境外 CDN 偶发 connect timeout）不该让索引退回内置集合 —— 重试一次。
  // 只对 network/timeout 重试；`not-json` / `http-4xx` 是确定性结果，重试没意义。
  let lastError = 'network';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { doc: null, error: 'http-' + res.status };
      const ct = String(res.headers.get('content-type') || '');
      // 站点把未知路径回落到 index.html，这里必须挡住：HTML 不是索引。
      if (ct && !/json/i.test(ct)) return { doc: null, error: 'not-json' };
      return { doc: await res.json(), error: null };
    } catch (e) {
      const msg = String((e && e.message) || '');
      lastError = /timeout|abort/i.test(msg) ? 'timeout' : 'network';
      if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
    }
  }
  return { doc: null, error: lastError };
}

/**
 * 解析模块索引。永不抛 —— 索引只是"能多发现一点东西"，读不到就必须退回内置集合，
 * 绝不能让面板因为一个索引文件而空白。
 */
export async function resolveModules(force = false) {
  if (!force && Date.now() - cache.at < TTL_MS && cache.payload) return cache.payload;

  const tried = [];
  const site = siteBase();
  const assets = assetsBase();

  // 站点先试（它优先），每个基址再按路径表试；R2 直接地址留作最后兜底。
  const bases = [
    ...(site ? [{ base: site, origin: 'site' }] : []),
    { base: assets, origin: 'assets' },
  ];
  for (const { base, origin } of bases) {
    for (const path of MODULES_PATHS) {
    const url = base + path;
    const { doc, error } = await fetchJson(url);
    tried.push({ url, error });
    if (doc) {
      const norm = normalize(doc, origin);
      if (norm) {
        // 相对清单路径补成绝对 URL：调用方不必再关心基址是谁。
        for (const m of norm.modules) {
          if (m.manifest && m.manifest.startsWith('/')) m.manifest = base + m.manifest;
          if (m.fallbackManifest && m.fallbackManifest.startsWith('/')) m.fallbackManifest = base + m.fallbackManifest;
        }
        const payload = { ok: true, source: norm.origin, url, updatedAt: norm.updatedAt, modules: norm.modules, tried };
        cache = { at: Date.now(), payload };
        return payload;
      }
      tried[tried.length - 1].error = 'bad-shape';
    }
    }
  }

  const payload = { ok: false, source: 'builtin', url: null, updatedAt: null, modules: BUILTIN.modules, tried };
  cache = { at: Date.now(), payload };
  return payload;
}

export function registerModulesRoutes(webServer, c) {
  const { disposers, base: BASE } = c;

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/modules`,
    handler: async (req, res) => {
      let force = false;
      try {
        force = new URL(req.url || '/', 'http://x').searchParams.get('refresh') === '1';
      } catch { /* 解析失败就当没传 */ }
      const payload = await resolveModules(force);
      sendJson(res, 200, payload);
    },
  }));
}
