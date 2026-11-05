/**
 * site-list.js — **站点清单接口的端点偏好**（v1 优先、v0 回退）的唯一实现。
 *
 * ## 为什么要有它
 *
 * 站点从 2026-11 起同时提供两套公开清单接口，**响应体逐字节相同**（站点侧
 * `public-api.js` 一份实现、`routes/public-v1.js` 与 `routes/public.js` 两个壳）：
 *
 *   · `/api/v1/public/wallpapers`   —— 新路径，带 v1 技术字段（fps/codec/pixFmt/…）；
 *   · `/api/public/wallpapers`      —— 旧路径，仍然可用，保留给还没升级的部署。
 *
 * 插件有**四个**地方拉站点清单（壁纸 `inventory.js`、助手皮肤 `skins.js`、桌宠 `pets.js`、
 * 开机动画 `boot.js`），各写一份"先试 v1 再退 v0"必然漂开：一处漏了回退就会在旧站点上
 * 静默空列表，一处漏了字段探测就会把"老站点"当成"新站点"而把新字段读成 undefined。
 * 所以判据只有这里一份。
 *
 * ## 判据（顺序即优先级）
 *
 *   ① 请求 v1；**200 + `{ok:true, data.items[]}`** 才算拿到；
 *   ② 还要求"它真的是 v1"：条目里至少出现**一个** v1 技术字段（own property，值可以是
 *      null —— **"字段在、值为空"与"字段压根没有"是两件事**，前者只是这条壁纸没有元数据，
 *      后者说明这个端点还是老实现）。空清单（0 条）没有字段可看 ⇒ 按"端点可用"算。
 *   ③ 任一条不成立 ⇒ **回退 v0**，并把 v1 的失败原因记进 `v1Error`（诊断用）。
 *   ④ **站点级失败不浪费第二个超时**：v1 的失败是 `timeout` / `tls` / `network`（连不上、
 *      证书、DNS）时，v0 必然是同一个失败 —— 直接返回 v1 的错误。HTTP 状态码失败
 *      （400/404/500/401…）才值得回退：那可能是网关/门禁**只挡这一条路径**。
 *
 * ## `siteApiVersion` 诊断
 *
 * 每个族（`wallpaper` / `skin` / `pet` / `boot`）最近一次清单请求的结论记在模块级表里，
 * `siteApiVersions()` 原样交给 `/folia/diag/media-state` 与 `/folia/inventory` 的
 * `siteApiVersion` 字段。**只记事实**（用的哪条路径 / 有没有回退 / 回退原因），
 * 不参与任何产品决策 —— 选档/渲染都不读它。
 */
import { siteRequestHeaders } from './site-auth.js';

/** v1 清单路径（新）。 */
export const SITE_LIST_V1_PATH = '/api/v1/public/wallpapers';
/** v0 清单路径（旧，仍可用）。 */
export const SITE_LIST_V0_PATH = '/api/public/wallpapers';
/**
 * **v1 才有的字段名**（与站点 DTO 一字不差，见 `folia-admin/src/server/dto.js`）。
 * ⚠️ 这里只用于"这个端点是不是 v1"的探测，**不**用于取值 —— 取值在各自的条目映射里。
 */
export const SITE_V1_FIELDS = Object.freeze([
  'fps', 'codec', 'pixFmt', 'hasAudio', 'posterUrl', 'license', 'source', 'author',
]);
/** 单次请求超时缺省值（与 inventory 的历史值一致：4s）。 */
export const SITE_LIST_TIMEOUT_MS = 4000;
const TIMEOUT_MIN_MS = 500;
const TIMEOUT_MAX_MS = 30000;

/** 族名 → 最近一次结论。值形如 `{ version, fallbackFrom, error, url, at }`。 */
const VERSIONS = new Map();

const hasOwn = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

/** 响应体是不是"清单形状"：`{ok:true, data:{items:[]}}`。 */
function isListDoc(doc) {
  return Boolean(doc) && doc.ok === true && Boolean(doc.data) && Array.isArray(doc.data.items);
}

/**
 * 响应体是不是**v1**的清单（形状 + 技术字段在场）。
 *
 * 空清单返回 true：没有条目就没有字段可看，此时"端点 200 且形状对"就是唯一的证据。
 * 这条豁免是有意的 —— 站点库为空时把端点判成 v0 会让 `siteApiVersion` 长期显示 `v0`，
 * 而那是**错误诊断**（端点明明是新版）。
 *
 * @param {any} doc
 * @returns {boolean}
 */
export function isV1ListDoc(doc) {
  if (!isListDoc(doc)) return false;
  const items = doc.data.items;
  if (!items.length) return true;
  return items.some((it) => Boolean(it) && typeof it === 'object'
    && SITE_V1_FIELDS.some((k) => hasOwn(it, k)));
}

/** 超时收敛：非数/越界一律回缺省（绝不因为一个坏 env 把请求变成 0ms）。 */
function clampTimeout(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return SITE_LIST_TIMEOUT_MS;
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, Math.round(n)));
}

/**
 * 记一次结论。**失败也记**（`error` 非空、`version:null`）—— 诊断要能回答"为什么这次没有 v1"，
 * 而不是只在成功时有一行。
 * @param {string} family
 * @param {{ version: string|null, fallbackFrom?: string|null, error?: string|null, url?: string }} info
 */
export function recordSiteApiVersion(family, info) {
  const key = String(family || 'site');
  const i = info || { version: null, fallbackFrom: null, error: null, url: '' };
  VERSIONS.set(key, {
    version: i.version === 'v1' || i.version === 'v0' ? i.version : null,
    fallbackFrom: i.fallbackFrom || null,
    error: i.error || null,
    url: String(i.url || ''),
    at: Date.now(),
  });
}

/** 某族最近一次结论（没请求过 ⇒ null）。 */
export function siteApiVersionOf(family) {
  const v = VERSIONS.get(String(family || 'site'));
  return v ? { ...v } : null;
}

/** 全部族的结论（只读快照；`/folia/diag/media-state` 读它）。 */
export function siteApiVersions() {
  const out = {};
  for (const [k, v] of VERSIONS) out[k] = { ...v };
  return out;
}

/** 单次尝试：返回 `{ url, doc, error, status }`，**永不抛**（失败分类沿用 inventory 的词汇）。 */
async function attempt(base, path, query, headers, timeoutMs) {
  const url = base + path + (query || '');
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  try {
    const res = await fetch(url, { headers, signal });
    if (!res.ok) return { url, doc: null, error: 'http-' + res.status, status: res.status };
    try {
      return { url, doc: await res.json(), error: null, status: res.status };
    } catch {
      return { url, doc: null, error: 'json', status: res.status };
    }
  } catch (e) {
    const code = String((e && (e.name || e.code)) || '');
    const msg = String((e && e.message) || '');
    if (/timeout|abort/i.test(code) || /timeout|aborted/i.test(msg)) return { url, doc: null, error: 'timeout', status: 0 };
    if (/cert|tls|ssl/i.test(msg)) return { url, doc: null, error: 'tls', status: 0 };
    return { url, doc: null, error: 'network', status: 0 };
  }
}

/** 站点级失败（连不上）—— 换路径也一定是同一个失败。 */
function isSiteWideError(error) {
  return error === 'timeout' || error === 'tls' || error === 'network';
}

/**
 * 拉一次站点清单（**v1 优先，v0 回退**）。
 *
 * @param {string} base 站点基址（不带尾斜杠也吃；空串 ⇒ `{doc:null, error:'no-site'}`）
 * @param {string} [query] 已拼好的查询串（含 `?`，例如 `?category=wallpaper&limit=100`）
 * @param {{ timeoutMs?: number, headers?: Record<string,string>, family?: string }} [opts]
 * @returns {Promise<{ doc: any, error: string|null, version: 'v1'|'v0'|null, url: string,
 *   status: number, v1Error: string|null }>}
 */
export async function siteListFetch(base, query = '', opts = {}) {
  const b = String(base || '').replace(/\/+$/, '');
  const family = opts.family || 'site';
  if (!b) {
    recordSiteApiVersion(family, { version: null, error: 'no-site' });
    return { doc: null, error: 'no-site', version: null, url: '', status: 0, v1Error: null };
  }
  const headers = opts.headers || siteRequestHeaders();
  const timeoutMs = clampTimeout(opts.timeoutMs);
  const v1 = await attempt(b, SITE_LIST_V1_PATH, query, headers, timeoutMs);
  const v1Usable = Boolean(v1.doc) && isV1ListDoc(v1.doc);
  if (v1Usable) {
    recordSiteApiVersion(family, { version: 'v1', fallbackFrom: null, error: null, url: v1.url });
    return { doc: v1.doc, error: null, version: 'v1', url: v1.url, status: v1.status, v1Error: null };
  }
  // v1 拿到了 JSON 但不是 v1 形状 ⇒ 原因记 `shape`（比"没错误"更能解释回退）。
  const v1Error = v1.error || 'shape';
  if (isSiteWideError(v1Error)) {
    recordSiteApiVersion(family, { version: null, fallbackFrom: 'v1', error: v1Error, url: v1.url });
    return { doc: null, error: v1Error, version: null, url: v1.url, status: v1.status, v1Error };
  }
  const v0 = await attempt(b, SITE_LIST_V0_PATH, query, headers, timeoutMs);
  const ok = Boolean(v0.doc) && isListDoc(v0.doc);
  recordSiteApiVersion(family, {
    version: ok ? 'v0' : null,
    fallbackFrom: 'v1',
    error: ok ? v1Error : (v0.error || v1Error),
    url: v0.url,
  });
  return {
    doc: v0.doc, error: v0.error, version: ok ? 'v0' : null,
    url: v0.url, status: v0.status, v1Error,
  };
}
