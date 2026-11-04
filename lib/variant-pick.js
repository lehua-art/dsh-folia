/**
 * variant-pick.js — **1080p 变体选档**（宿主侧，纯函数；判据见 test/verify-variants.mjs）。
 *
 * 为什么要有它：站点从 d960c62 起给每条视频壁纸带 `variants`（通常是 1080p 的轻量版），
 * 但"什么时候该用 1080p"不该散落在三处各写一遍 —— 一处按速度、一处按体积、一处按设置，
 * 迟早会出现"同一个文件在清单里选原画、入队时选 1080p"这种自相矛盾。
 *
 * 策略 A（默认 `auto`，用户已确认）：**先原画，满足任一条件才降到 1080p**
 *   · 前 3 秒实测吞吐 < 0.6 MB/s（与 `lib/download-queue.js` 的自适应阈值**同一个数**，
 *     慢域标记由队列维护 —— 两个模块各写一个 0.6 就会出现"队列觉得慢、选档觉得不慢"）；
 *   · 原画 > 20 MB 且屏幕高度 ≤ 1440（看不出差别，但省一半流量与解码压力）。
 * 变体缺失 / url 非法 / 设置要求原画 ⇒ 一律原画，**绝不报错**（站点还没上线 variants 时
 * 整条链路必须与 4.23.3 逐字节等价）。
 *
 * 为什么不在这里做"下到一半再换源"：那要在队列里换 URL、丢掉已下的字节、重算 Range 起点，
 * 是另一个量级的改动，且弱网下会白付一次握手。这里只在**入队那一刻**选一次，并把结论写进
 * `job.chosenVariant`（面板与排障读同一个事实）。
 */

/** 自适应阈值：**与 download-queue.js 的 ADAPTIVE_SLOW_MBPS 必须相等**（单测钉着这一点）。 */
export const SLOW_MBPS = 0.6;
/** 原画"够大"的门槛：20 MB。 */
export const BIG_ORIGINAL_BYTES = 20 * 1024 * 1024;
/** 「屏幕不够大就别下原画」的高度上限：1440（含）。 */
export const SAVER_SCREEN_MAX = 1440;
/** 设置项白名单（`videoQuality`）。 */
export const QUALITY_MODES = ['auto', 'original', 'saver'];

/** 质量设置归一键：非法/缺失 ⇒ `auto`（不因为一个拼错的设置把画质偷偷降掉）。 */
export function pickQuality(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return QUALITY_MODES.includes(v) ? v : 'auto';
}

/** 合法媒体地址：必须是绝对 http(s)（相对地址由调用方先按站点基址解析好）。 */
export function isUsableMediaUrl(u) {
  try {
    const x = new URL(String(u));
    return (x.protocol === 'http:' || x.protocol === 'https:') && Boolean(x.host);
  } catch { return false; }
}

/**
 * 站点给的 `variants` → 规整后的数组（丢掉不合法的条目，绝不因为一条坏数据整单失败）。
 * @param {any} raw
 * @param {string} [base] 站点基址（相对 url 会被解析成绝对地址）
 * @returns {{label:string,height:number,bytes:number,url:string}[]}
 */
export function normalizeVariants(raw, base) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    let url = String(v.url || '').trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url) && base) {
      try { url = new URL(url, base).toString(); } catch { continue; }
    }
    if (!isUsableMediaUrl(url)) continue;
    const height = Number(v.height);
    const bytes = Number(v.bytes);
    out.push({
      label: String(v.label || (Number.isFinite(height) && height > 0 ? height + 'p' : '')),
      height: Number.isFinite(height) && height > 0 ? height : 0,
      bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
      url,
    });
  }
  return out;
}

/** 从规整后的变体里挑"1080p 那一档"：优先 height===1080，其次 label 含 1080。
 *  ⚠️ **只认 1080p**：站点若只给了 720p/480p，我们不"顺手"降到它 —— 那不是用户确认的策略
 *  （"看不出差别才降"，720p 在 1440p 屏上看得出来），降错档比不降更让人难受。 */
export function pick1080(variants) {
  const list = Array.isArray(variants) ? variants : [];
  if (!list.length) return null;
  const exact = list.find((v) => v && Number(v.height) === 1080);
  if (exact) return exact;
  return list.find((v) => v && /1080/.test(String(v.label || ''))) || null;
}

/**
 * 选档决策（纯函数）。
 *
 * 输入（**全部可缺省** ⇒ 一律原画，绝不抛）：
 *   · `variants`       站点给的变体数组（未规整也行）
 *   · `base`           站点基址（变体给的是相对 url 时用它补全）
 *   · `originalUrl`    原画地址（选中原画时原样返回）
 *   · `originalBytes`  原画体积（站点清单里的 bytes）
 *   · `quality`        `auto` | `original` | `saver`
 *   · `hostSlow`       该域是否已被队列 3 秒实测判为慢（< 0.6 MB/s）
 *   · `screenHeight`   屏幕高度（px；0/缺省 = 不知道 ⇒ 只按速度判）
 * 返回：`{ chosen: 'original'|'1080p', url, height, reason, variants }`。
 *
 * @param {any} [inp]
 */
export function pickVariant(inp) {
  const o = inp || {};
  const originalUrl = String(o.originalUrl || '');
  const variants = normalizeVariants(o.variants, o.base);
  const quality = pickQuality(o.quality);
  const orig = (reason) => ({ chosen: 'original', url: originalUrl, height: 0, reason, variants });
  // ① 用户/设置明确要原画 ⇒ 永远原画（画质优先，不许"替你省流量"）。
  if (quality === 'original') return orig('quality-original');
  const v1080 = pick1080(variants);
  // ② 站点没给变体（或给的全不合法）⇒ 原画。这是 4.23.3 的行为，一个字节都不变。
  if (!v1080) return orig('no-variant');
  const pickTo1080 = (reason) => ({ chosen: '1080p', url: v1080.url, height: v1080.height || 1080, reason, variants });
  // ③ 省流档：只要有合法变体就降。
  if (quality === 'saver') return pickTo1080('quality-saver');
  // ④ 慢链路（队列 3 秒实测 < 0.6 MB/s）。
  if (o.hostSlow === true) return pickTo1080('slow-link');
  // ⑤ 原画够大、屏幕又不够大（1440 及以下看不出差别）。
  const bytes = Number(o.originalBytes) || 0;
  const screenH = Number(o.screenHeight) || 0;
  if (bytes > BIG_ORIGINAL_BYTES && screenH > 0 && screenH <= SAVER_SCREEN_MAX) {
    return pickTo1080('big-file-small-screen');
  }
  // ⑥ 其余一律原画。
  return orig('auto-original');
}

/** 一句话说明选档理由（排障/界面提示用；未知理由原样返回，便于定位新分支）。 */
export const VARIANT_REASONS = {
  'quality-original': 'quality=original',
  'no-variant': 'no-variant',
  'quality-saver': 'quality=saver',
  'slow-link': 'slow-link(<0.6MB/s)',
  'big-file-small-screen': 'big-file(>20MB)&screen<=1440',
  'auto-original': 'auto-original',
};
