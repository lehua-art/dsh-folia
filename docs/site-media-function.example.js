/**
 * Cloudflare Pages Function —— 替换/新建 `functions/media/[[path]].js`
 *
 * 作用：把 `/media/<storage_key>` 变成"**长缓存 + 支持 Range + 正确 404**"的静态资源出口。
 *
 * 为什么必须自己做缓存：Pages Functions 的响应**默认不会被 Cloudflare 边缘缓存**。
 * 只加 `cache-control` 头只影响浏览器，边缘仍然每次都回源 R2。
 * 所以这里用 Cache API（caches.default）把 200 全量响应放进边缘缓存。
 *
 * 关键设计（每一条都对应一次真实故障）：
 *   1) 找不到对象 → **404 + no-store**（旧实现返回 500，客户端只能显示"服务器错误"）
 *   2) 命中缓存 → 直接返回，`x-folia-source: edge-cache`
 *   3) Range 请求 → 透传 R2 的 range，返回 206 + content-range（**不写缓存**）
 *   4) 全量 200 → `cache-control: public, max-age=31536000, immutable` + cache.put
 *   5) If-None-Match 命中 → 304（省流量、浏览器刷新不变慢）
 *   6) 存储异常（R2 抛错）→ 502 + no-store，且 body 里说明，便于定位
 *
 * 为什么敢 immutable 一年：URL 里已经带内容哈希（`/media/wallpapers/<id>/<sha12>.zip`），
 * 内容变 ⇒ 哈希变 ⇒ URL 变 ⇒ 永远不会拿到旧内容。
 */

export async function onRequest(context) {
  const { request, env, params } = context;

  // 只要 GET / HEAD
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  // 从 URL 拼出 R2 的 key：/media/wallpapers/x/y.zip -> wallpapers/x/y.zip
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/+media\/?/, '')).replace(/^\/+/, '');
  if (!key) return notFound();

  const bucket = env.BUCKET;
  if (!bucket) return fail('storage-unbound');

  // ── 1) 先看边缘缓存（只对"无 Range 的请求"做缓存查找）───────────────
  const hasRange = request.headers.has('range');
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  if (!hasRange) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('x-folia-source', 'edge-cache');
      // HEAD 只回头，不回 body
      return new Response(request.method === 'HEAD' ? null : hit.body, { status: 200, headers: h });
    }
  }

  // ── 2) 回源 R2 ────────────────────────────────────────────────────
  const rangeHeader = request.headers.get('range');
  let obj;
  try {
    obj = await bucket.get(key, rangeHeader ? { range: request.headers } : undefined);
  } catch (e) {
    return fail('storage-error');
  }
  if (!obj) return notFound();

  // ── 3) 条件请求：ETag 命中就 304（浏览器刷新不变慢）───────────────
  const etag = obj.httpEtag;
  const inm = request.headers.get('if-none-match');
  if (!rangeHeader && inm && inm === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }

  // ── 4) 组装响应头 ────────────────────────────────────────────────
  const headers = new Headers();
  headers.set('content-type', (obj.httpMetadata && obj.httpMetadata.contentType) || guessType(key));
  headers.set('etag', etag);
  headers.set('accept-ranges', 'bytes');
  // ⭐ 长缓存：浏览器与边缘都能长期复用（URL 带内容哈希，所以安全）
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('x-content-type-options', 'nosniff');

  const isPartial = Boolean(obj.range);
  if (isPartial) {
    const start = obj.range.offset;
    const end = start + obj.range.length - 1;
    headers.set('content-range', `bytes ${start}-${end}/${obj.size}`);
    headers.set('content-length', String(obj.range.length));
  } else {
    headers.set('content-length', String(obj.size));
  }

  const body = request.method === 'HEAD' ? null : obj.body;

  // ── 5) 全量 200 写入边缘缓存（Range 与 HEAD 不写）────────────────
  if (!isPartial && request.method === 'GET') {
    const toCache = new Response(obj.body, { status: 200, headers });
    // 注意：cache.put 需要独立的 body，所以这里 clone 一份，返回给用户的用原流
    const forCache = toCache.clone();
    context.waitUntil(cache.put(cacheKey, forCache).catch(() => {}));
    const outHeaders = new Headers(headers);
    outHeaders.set('x-folia-source', 'r2');
    return new Response(toCache.body, { status: 200, headers: outHeaders });
  }

  headers.set('x-folia-source', isPartial ? 'r2-range' : 'r2');
  return new Response(body, { status: isPartial ? 206 : 200, headers });
}

/* ── 小工具 ─────────────────────────────────────────────────────── */

function notFound() {
  return new Response(JSON.stringify({ ok: false, error: { code: 'not_found', message: '文件不存在' } }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function fail(code) {
  return new Response(JSON.stringify({ ok: false, error: { code, message: '存储暂不可用' } }), {
    status: 502,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function guessType(key) {
  const k = key.toLowerCase();
  if (k.endsWith('.zip')) return 'application/zip';
  if (k.endsWith('.mp4')) return 'video/mp4';
  if (k.endsWith('.webm')) return 'video/webm';
  if (k.endsWith('.mov')) return 'video/quicktime';
  if (k.endsWith('.jpg') || k.endsWith('.jpeg')) return 'image/jpeg';
  if (k.endsWith('.png')) return 'image/png';
  if (k.endsWith('.webp')) return 'image/webp';
  if (k.endsWith('.avif')) return 'image/avif';
  if (k.endsWith('.gif')) return 'image/gif';
  if (k.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}
