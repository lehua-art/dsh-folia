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

/**
 * **「1080p 档」的几何边界**（4.23.21，P0-B）。
 *
 * 站点给的是"轻量档"，不是"高度必须等于 1080 的文件"：4320×2160 的原画对应的轻量档是
 * **1920×960**（2:1 的源按 1920 宽缩，高自然不是 1080）。判据见 `pick1080()` 的注释。
 */
export const TIER_1080_MAX_WIDTH = 1920;
export const TIER_1080_MAX_HEIGHT = 1080;
/**
 * 非 16:9 档的**面积下限** = 半个 1920×1080。用来把 720p（1280×720 ≈ 0.92M）挡在外面：
 * 用户口径是"看不出差别才降"，720p 在 1440p 屏上看得出来。
 */
export const TIER_1080_MIN_PIXELS = Math.round(1920 * 1080 * 0.5);

/**
 * **本机解码上限**（4.23.15）。超过它就不是"清晰度偏好"问题了，而是**播不出来**：
 * Chromium 的软/硬解在 4096×2160 之外基本必然 `MEDIA_ERR_SRC_NOT_SUPPORTED`。
 *
 * 真实案例（另一台机器）：壁纸「原神 绫华」原画 **5916×2530**，站点明明给了 689 万字节的
 * 1080p 变体，却因为"链路很快 + 屏幕够大"选了原画 ⇒ 播放器报「浏览器无法解码这段视频」。
 * 选档这条判据当时只看速度/体积/屏高，**完全不看源有多大** —— 这就是那个洞。
 *
 * 三档口径（顺序即精度）：
 *   · 宽高都知道：`w > 4096 || h > 2160 || w*h > 3840*2160`；
 *   · 只知道高：`h > 1440`（清单里 width/height 可能缺，此时按保守口径退化）；
 *   · 只知道宽：`w > 2560`；
 *   · 都不知道：不判（**绝不猜** —— 没有证据就把所有大文件降档等于替用户改画质）。
 */
export const DECODE_MAX_WIDTH = 4096;
export const DECODE_MAX_HEIGHT = 2160;
export const DECODE_MAX_PIXELS = 3840 * 2160;
/** 尺寸缺一半时的退化阈值（用户口径原文："为空时退化为按 height>1440 或 width>2560 判断"）。 */
export const DECODE_FALLBACK_WIDTH = 2560;
export const DECODE_FALLBACK_HEIGHT = 1440;

/**
 * **本机解码能力的规格上限**（4.23.15 最终口径，用户拍板"降帧优先、尽量不降画质"）：
 * 宽 ≤3840 且 高 ≤2160 且 像素 ≤830 万 且 fps ≤30。
 */
export const SPEC_MAX_WIDTH = 3840;
export const SPEC_MAX_HEIGHT = 2160;
export const SPEC_MAX_PIXELS = 3840 * 2160;   // ≈830 万
export const SPEC_MAX_FPS = 30;

/**
 * 源的规格 → **该怎么播**（纯函数，决策树的唯一实现；判据见 verify-media-selfheal 的 ⑥ 节）。
 *
 * 用户最终口径（顺序即优先级，先满足就停）：
 *   1. 规格在解码能力内 ⇒ `direct`（**最高画质，不许替他降级**）
 *   2. 只有 fps 超标（分辨率在范围内）⇒ `decimate`（**同分辨率**，fps→30。不降画质！）
 *   3. 分辨率超限 ⇒ 有变体 `variant`（1080p）/ 无变体 `rescue`（缩到 ≤1920×1080）
 *
 * ⚠️ 第 2 条是这版最重要的一条：**60fps 的 4K 不许直接降到 1080p**。
 * 4K@60 的瓶颈是像素吞吐（帧率 × 面积），先砍帧率能把开销减半而画质一点不损；
 * 上来就缩分辨率是"为了省事把用户的画质白白扔掉"。
 *
 * @param {{ width?: number, height?: number, fps?: number, hasVariant?: boolean }} [inp]
 * @returns {DecodePlan}
 */
/** @typedef {{ action: 'direct'|'decimate'|'variant'|'rescue', reason: string,
 *   targetWidth: number, targetHeight: number, targetFps: number }} DecodePlan */

export function decodePlan(inp) {
  const o = inp || {};
  const w = Number(o.width) || 0;
  const h = Number(o.height) || 0;
  const f = Number(o.fps) || 0;
  const px = w > 0 && h > 0 ? w * h : 0;
  const resOver = (w > 0 && w > SPEC_MAX_WIDTH) || (h > 0 && h > SPEC_MAX_HEIGHT)
    || (px > 0 && px > SPEC_MAX_PIXELS);
  const fpsOver = f > SPEC_MAX_FPS;
  /** @type {DecodePlan} */
  const direct = { action: 'direct', reason: 'within-spec', targetWidth: 0, targetHeight: 0, targetFps: 0 };
  // 尺寸/帧率都不知道 ⇒ 不猜（交给播放失败自愈那条腿）。
  if (!(w > 0) && !(h > 0) && !(f > 0)) return direct;
  if (!resOver && !fpsOver) return direct;
  // ② 只有帧率超标 ⇒ 同分辨率降帧（画质不动）。
  if (!resOver) {
    return /** @type {DecodePlan} */ ({
      action: 'decimate', reason: 'fps>' + SPEC_MAX_FPS + '&res-in-spec',
      targetWidth: w, targetHeight: h, targetFps: SPEC_MAX_FPS,
    });
  }
  // ③ 分辨率超限 ⇒ 优先站点 1080p 变体；没有才让救援转码缩。
  if (o.hasVariant === true) {
    return /** @type {DecodePlan} */ ({ action: 'variant', reason: 'resolution-over', targetWidth: 1920, targetHeight: 1080, targetFps: SPEC_MAX_FPS });
  }
  return /** @type {DecodePlan} */ ({ action: 'rescue', reason: 'resolution-over&no-variant', targetWidth: 1920, targetHeight: 1080, targetFps: SPEC_MAX_FPS });
}

/**
 * 源是否超出**本机解码上限**。返回 `''` = 没超（或不知道）；否则返回判据名（排障用）。
 *
 * 纯函数、零依赖 —— 判据见 `test/verify-variants.mjs` 的「解码上限」一节。
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function decodeLimitHit(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w > 0 && h > 0) {
    if (w > DECODE_MAX_WIDTH) return 'width>' + DECODE_MAX_WIDTH;
    if (h > DECODE_MAX_HEIGHT) return 'height>' + DECODE_MAX_HEIGHT;
    if (w * h > DECODE_MAX_PIXELS) return 'pixels>' + DECODE_MAX_PIXELS;
    return '';
  }
  if (h > 0) return h > DECODE_FALLBACK_HEIGHT ? 'height>' + DECODE_FALLBACK_HEIGHT + '(fallback)' : '';
  if (w > 0) return w > DECODE_FALLBACK_WIDTH ? 'width>' + DECODE_FALLBACK_WIDTH + '(fallback)' : '';
  return '';
}

/**
 * **高帧率 + 高分辨率**是否超出本机解码能力（4.23.15 的真机定因）。
 *
 * 实测（另一台机器，ffprobe 逐个探）：
 *   · 用户报"无法解码"的那些高画质壁纸**全是 4K@60**（h264 High / yuv420p / 3840×2160@60
 *     与 4320×2160@60），不是 HEVC、也不是坏文件；
 *   · 同机 1920×1080@30 正常可播；站点给的 1080p 变体实测是 **1080p@30**、可直接播。
 * ⇒ 主因是**解码吞吐**（4K@60 的像素吞吐超出 Chromium 的硬解/软解能力），
 *    其次才是超宽（5916×2530 那一类，见 `decodeLimitHit`）。
 *
 * 口径（三条，缺一条就漏）：
 *   ① 有 fps：`fps > 30` 且 `width >= 2560` ⇒ 超（4K@60 / 4320@60 都在内）；
 *   ② 没有 fps：`width >= 3840` ⇒ 按"UHD 兜底"判超（用户口径原文）；
 *   ③ 都不是 ⇒ 不超（1080p@30 必须照常原画直出，不能把能播的也降档）。
 *
 * @param {number} fps
 * @param {number} width
 * @returns {string}
 */
export function highFpsHit(fps, width) {
  const f = Number(fps) || 0;
  const w = Number(width) || 0;
  if (f > 0) return (f > 30 && w >= 2560) ? 'fps>' + 30 + '&width>=' + 2560 : '';
  return w >= 3840 ? 'uhd(width>=' + 3840 + ')' : '';
}


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
 *
 * 4.23.17（P0）：**变体自己的 `sha256` 必须原样带出来**。此前这里只留
 * `{label,height,bytes,url}`，于是"这条要下变体"的决定发生在 `/downloads/add` 时，
 * 而校验用的哈希只剩调用方带的那一个 —— 调用方带的是**原画**的 `sha256`（清单里
 * `item.sha256`）。变体与原画是两个对象、两个哈希 ⇒ 每次下 1080p 都 `hash-mismatch`，
 * 重下一次后仍不一致，job 停在 failed（用户看到的"点了壁纸不显示"）。
 * 现在原画的哈希只配原画、变体的哈希只配变体，两档各自可验。
 * @param {any} raw
 * @param {string} [base] 站点基址（相对 url 会被解析成绝对地址）
 * @returns {{label:string,height:number,bytes:number,url:string,sha256?:string}[]}
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
    const width = Number(v.width);
    const bytes = Number(v.bytes);
    const fps = Number(v.fps || v.frameRate);
    const item = {
      // 4.23.19：**label 原样保留**（站点给的 4K30 / 1080p 是选档的第一判据）。
      // 以前缺 label 时用 height 反算 —— 于是"4K 同分辨率 30fps 变体"（height=2160）
      // 会退化成 label 2160p，选档认不出它。
      label: String(v.label || (Number.isFinite(height) && height > 0 ? height + 'p' : '')),
      height: Number.isFinite(height) && height > 0 ? height : 0,
      // 4.23.21（P0-B）：**宽度必须带出来**。1080p 档不再按"高 === 1080"认，而是按
      // "宽 ≤1920 且 高 ≤1080"这个矩形认；没有宽就无法把 1920×960 与 720p 分开
      // （见 `pick1080()` 与 `variant1080Rank()`）。缺失 ⇒ 0（不猜）。
      width: Number.isFinite(width) && width > 0 ? width : 0,
      bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
      // 变体帧率（站点 dto 透传；缺失 = 0 ⇒ 只按 label 判）。
      fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
      url,
    };
    // 只认合法 sha256（64 位十六进制）；没给 / 非法 ⇒ 不设内容判据（长度那两层仍然生效）。
    const sha = String(v.sha256 || '').trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(sha)) item.sha256 = sha;
    out.push(item);
  }
  return out;
}

/**
 * 一档变体在「1080p 档」里的**排序权重**（越大越优先；−1 = 不属于 1080p 档）。
 *
 * 规则与 `pick1080()` 的注释一一对应：高度必须 ≤1080；宽度给了就必须 ≤1920；
 * `height === 1080` 无条件合格（旧数据没有 width）；其余必须面积 ≥ 半个 1080p。
 *
 * @param {any} v 规整后的变体
 * @returns {number}
 */
function variant1080Rank(v) {
  if (!v) return -1;
  const h = Number(v.height) || 0;
  const w = Number(v.width) || 0;
  if (!(h > 0) || h > TIER_1080_MAX_HEIGHT) return -1;
  if (w > 0 && w > TIER_1080_MAX_WIDTH) return -1;
  if (h === 1080) return h * Math.max(w, TIER_1080_MAX_WIDTH);
  if (w <= 0) return -1;                       // 几何不全 ⇒ 不猜（旧数据靠上面的 h===1080 兜）
  const px = w * h;
  return px >= TIER_1080_MIN_PIXELS ? px : -1;
}

/** 从规整后的变体里挑"1080p 那一档"：优先 `height === 1080`，其次几何落在 1080p 档内的最大一档。
 *
 * ## 4.23.21（P0-B）：把"1080p 档"从**一个数字**放宽成**一个矩形**
 *
 * 真实故障（QA 实测）：「原神 钟离」原画 **4320×2160**，站点给的唯一变体是
 * `{height: 960, width: 1920}`（即 1920×960，url 名 `.1080p.mp4`）。旧判据只认
 * `height === 1080` ⇒ 不命中 ⇒ `chosenVariant='original'` ⇒ 4K@60 原画仍走客户端转码。
 * 但那条变体**就是站点给这一档的 1080p**：1920 宽 = 1080p 档的宽，高度低是**宽高比**的结果
 * （2:1 的源裁出 1920×960），不是"更糊的一档"。
 *
 * 新口径（`variant` 是站点给的"轻量档"，我们只判断它是否落在 1080p 档的矩形里）：
 *   · 宽 ≤1920 **且** 高 ≤1080；
 *   · `height === 1080` 仍无条件命中（站点没给 width 的旧数据不许回归）；
 *   · 非 16:9 的档必须同时给出宽，且像素面积 ≥ 半个 1920×1080 —— 这条把 **720p
 *     （1280×720 ≈ 0.92M < 1.04M）** 挡在外面：用户口径是"看不出差别才降"，
 *     720p 在 1440p 屏上看得出来，降错档比不降更让人难受；
 *   · 命中多档时取**面积最大**的一档（站点可能同时给 1920×960 与 1280×720）。
 *
 * `chosen` 统一记 `'1080p'`（面板小标与排障只认这三个字；`height` 保留变体的真实高度）。
 */
export function pick1080(variants) {
  const list = Array.isArray(variants) ? variants : [];
  let best = null;
  let bestRank = -1;
  for (const v of list) {
    const rank = variant1080Rank(v);
    if (rank > bestRank) { best = v; bestRank = rank; }
  }
  if (best) return best;
  // 老的回退：站点把档位名写在 label 里（`1080p`）但尺寸缺失 —— 只认 label，不猜几何。
  return list.find((v) => v && /1080/.test(String(v.label || ''))) || null;
}

/**
 * 从规整后的变体里挑「**同分辨率的 30fps 档**」（4.23.19，站点 label 形如 4K30）。
 *
 * 为什么需要它：站点为 4K@60 的原画生成的是**同分辨率、30fps** 的变体（height=2160）。
 * 旧 pick1080() 只认 height===1080 ⇒ 选不到它 ⇒ 4K@60 只能靠客户端现场转码（慢且吃 CPU）。
 * 判据（任一）：
 *   · height 与原画相同，且变体 fps === 30（含 29.97 / <=31 的容差）；
 *   · label 命中 4K30 / 30fps，且 height >= 1440（**排除 1080p 档**，它有自己的分支）。
 * 找不到 ⇒ null（回落原画；绝不猜一档不相关的变体）。
 *
 * @param {any[]} variants
 * @param {number} [originalHeight]
 * @returns {any|null}
 */
export function pick4k30(variants, originalHeight) {
  const list = Array.isArray(variants) ? variants : [];
  if (!list.length) return null;
  const oh = Number(originalHeight) || 0;
  return list.find((v) => {
    if (!v) return false;
    const h = Number(v.height) || 0;
    if (h === 1080) return false;                       // 1080p 档不走这条
    const f = Number(v.fps) || 0;
    const fps30 = f > 0 && f <= 31;
    const sameRes = oh > 0 && h === oh;
    const label30 = /(4k30|30fps|30p\b)/i.test(String(v.label || '')) && h >= 1440;
    if (sameRes && fps30) return true;
    return label30;
  }) || null;
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
 *   · `originalWidth`  原画宽度（4.23.15；0/缺省 = 不知道 ⇒ 解码上限那条不判）
 *   · `originalHeight` 原画高度（同上）
 *   · `originalFps`    原画帧率（4.23.15；0/缺省 ⇒ 按"宽≥3840"兜底判 4K@60）
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
  // 4.23.19：**同分辨率 30fps 变体**（站点 label 形如 `4K30`）。原画 4K@60 先试它 ——
  // 降帧不降分辨率，是用户口径里最划算的一档（比 1080p 清楚、比 60fps 好解）。
  const v4k30 = pick4k30(variants, Number(o.originalHeight) || 0);
  // ② 站点没给变体（或给的全不合法）⇒ 原画。这是 4.23.3 的行为，一个字节都不变。
  if (!v1080 && !v4k30) return orig('no-variant');
  const pickTo1080 = (reason) => (v1080
    ? { chosen: '1080p', url: v1080.url, height: v1080.height || 1080, reason, variants }
    : { chosen: '4k30', url: v4k30.url, height: v4k30.height || 0, reason, variants });
  const pickTo4k30 = (reason) => (v4k30
    ? { chosen: '4k30', url: v4k30.url, height: v4k30.height || 0, reason, variants }
    : orig(reason + '-no-4k30'));
  // ③ 省流档：只要有合法变体就降。
  if (quality === 'saver') return pickTo1080('quality-saver');
  /**
   * ③b **解码上限**（4.23.15）：源宽高超出本机解码能力 ⇒ 无论链路多快都优先 1080p。
   *
   * 为什么排在慢链路**之前**：慢链路是"体验偏好"（等多久），解码上限是"能不能播"
   * （0 和 1 的差别）。5916×2530 的源在快链路上**必然**播不出来，而 1080p 变体一定播得出来
   * —— 这个顺序没有取舍空间。
   *
   * ⚠️ `quality === 'original'`（用户在面板上点了「用原画」）在 ① 就返回了，**不受这条影响**：
   * 那是用户明确的取舍，替他把画质降掉比让他自己点「用原画」更糟。真播不出来时由播放失败
   * 自愈接管（`/folia/local-heal`），届时会带一句说明再换档/转码。
   */
  const limitHit = decodeLimitHit(Number(o.originalWidth) || 0, Number(o.originalHeight) || 0);
  if (limitHit) return pickTo1080('decode-limit');
  /**
   * ③c **高帧率**（4.23.19）：原画 4K@>30fps ⇒ 优先**同分辨率 30fps** 变体（label `4K30`）。
   *
   * 为什么不是 1080p：用户口径是"降帧优先、尽量不降画质"；4K30 在 4K 屏上比 1080p60 清楚。
   * 没有这一档时才回到原画（旧行为），由播放失败自愈的 `decimate` 转码兜底。
   */
  if (highFpsHit(Number(o.originalFps) || 0, Number(o.originalWidth) || 0)) {
    if (v4k30) return pickTo4k30('hifps-variant');
    return orig('high-fps');
  }
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
  'decode-limit': 'decode-limit(>4096x2160)',
  'hifps-variant': 'hifps-variant(4K30)',
  'high-fps': 'high-fps(4K@>30fps)',
  'high-fps-no-4k30': 'high-fps(no 4K30 variant)',
  'slow-link': 'slow-link(<0.6MB/s)',
  'big-file-small-screen': 'big-file(>20MB)&screen<=1440',
  'auto-original': 'auto-original',
};

/** 合法 sha256 归一（空 / 非法 ⇒ 空串 = 不设内容判据）。 */
function normalizeSha(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : '';
}

/** 在规整后的变体数组里按 URL 精确定位一档（选档与不变式共用同一处，避免各写一套匹配）。 */
function findVariantByUrl(variants, url) {
  const want = String(url || '');
  if (!want) return null;
  return (Array.isArray(variants) ? variants : []).find((v) => v && v.url === want) || null;
}

/**
 * ══ **期望值的唯一真相源**（4.23.17，P0-6）：`(url, bytes, sha256)` 只能从这里出 ══
 *
 * 真实事故：同一个"要下哪个对象"的问题被拆成两处各答一次 ——
 *   · `pickVariant()` 决定**下变体**（url 换成 `…1080p.mp4`）；
 *   · 调用方却仍按"这条壁纸"取 `item.sha256`（**原画**的哈希）交给队列。
 * 两个对象的哈希天生不同 ⇒ 每次 `hash-mismatch`，自动重下一次仍失败，job 停在 failed
 * （用户看到的"点了壁纸不显示"）。
 *
 * 现在的口径：**选档结论 + 清单事实 → 这一条 job 的期望值**，三类字段（url / bytes /
 * sha256）来自**同一个对象**，`source` 标明它取自原画还是变体。任何入队点都不许再自己
 * 从 `item.sha256` / `item.bytes` 里挑去校验 —— 它们只作为"清单事实"传进来。
 *
 * @param {{ url?: string, media?: string, originalUrl?: string, bytes?: number, sha256?: string,
 *   variants?: any[], base?: string, chosenUrl?: string }} item 清单条目（+选档给的 chosenUrl）
 * @param {string} [chosen] 选档结论（`'original'` | `'1080p'`；缺省/非法按原画）
 * @returns {{ url: string, bytes: number, sha256: string, source: 'original'|'variant' }}
 */
export function resolveMediaExpectation(item, chosen) {
  const o = item || {};
  const originalUrl = String(o.url || o.media || o.originalUrl || '');
  const original = {
    url: originalUrl,
    bytes: Number(o.bytes) || 0,
    sha256: normalizeSha(o.sha256),
    source: /** @type {'original'} */ ('original'),
  };
  // 4.23.19：4k30 也是变体档 —— 必须按 chosenUrl 取**它自己**的 sha/bytes。
  if (chosen !== '1080p' && chosen !== '4k30') return original;
  const variants = normalizeVariants(o.variants, o.base);
  // 优先按选档给出的**最终 URL** 精确定位那一档（站点可能有多档，只有 1080p 才会被选中，
  // 但按 URL 命中永远比"猜哪一档"可靠）；没有 chosenUrl 时退回 `pick1080`。
  const hit = findVariantByUrl(variants, o.chosenUrl) || pick1080(variants);
  if (!hit) return original;                       // 选档说 1080p 但清单里没有这一档 ⇒ 不猜
  return {
    url: hit.url,
    bytes: Number(hit.bytes) || 0,
    sha256: normalizeSha(hit.sha256),
    source: /** @type {'variant'} */ ('variant'),
  };
}

/**
 * **当前清单 → 某条 URL 的期望值**（4.23.22 的唯一校验输入；纯函数）。
 *
 * 判据只有一条：URL 必须**逐字**出现在清单里（原画 `media`/`url` 或某一档
 * `variants[].url`）。命中变体 ⇒ 取**该变体自己的** sha256/bytes（`source='variant'`）；
 * 命中原画 ⇒ 取原画的；找不到 ⇒ null（退化为长度 + 结构校验；绝不拿原画哈希去套变体）。
 *
 * 4.23.22 起它**不再用于迁移**（没有迁移了）：`lib/routes/downloads.js` 把它包成
 * `resolveExpectation(job)` / `refreshExpectation(job)` 注入队列，校验发生在**下载完成那一刻**。
 * 入队不再写 sha，job 上也不再有"期望值"可复用 —— 这是 4.23.21 hash-mismatch 的根因修复。
 *
 * @param {{ url?: string }} job
 * @param {any[]} items 站点清单（inventory 形状或原始 API 形状都吃）
 * @param {string} [base] 相对 URL 的站点基址（原始 API 条目需要；inventory 缓存里通常是绝对地址）
 * @returns {{ url: string, sha256: string, bytes: number, source: 'original'|'variant' } | null}
 */
export function resolveJobExpectationFromItems(job, items, base) {
  const url = String((job && job.url) || '');
  if (!url) return null;
  const abs = (u) => {
    const s = String(u || '').trim();
    if (!s) return '';
    try { return new URL(s, base || undefined).toString(); } catch { return ''; }
  };
  for (const it of (Array.isArray(items) ? items : [])) {
    if (!it || typeof it !== 'object') continue;
    const origRaw = String(it.media || it.url || '');
    const originalUrl = /^https?:\/\//i.test(origRaw) ? origRaw : abs(origRaw);
    if (originalUrl === url) {
      // 原画档：仍然走唯一真相源（它同时守住 bytes/source 的口径）。
      const exp = resolveMediaExpectation({
        url: originalUrl, bytes: Number(it.bytes) || 0, sha256: it.sha256 || it.manifestSha256,
      }, 'original');
      return { url, sha256: exp.sha256, bytes: exp.bytes, source: exp.source };
    }
    for (const v of normalizeVariants(it.variants, base)) {
      if (v.url !== url) continue;
      // 变体档：按**这个 URL** 命中那一档，结论同样由唯一真相源产出。
      const exp = resolveMediaExpectation({
        url: originalUrl,
        bytes: Number(it.bytes) || 0,
        sha256: it.sha256 || it.manifestSha256,
        variants: it.variants,
        base,
        chosenUrl: url,
      }, '1080p');
      return { url, sha256: exp.sha256, bytes: exp.bytes, source: exp.source };
    }
  }
  return null;
}

/**
 * **运行时不变式**（4.23.17）：期望值与"这条 URL 是谁"必须自洽。
 *
 * 判据（返回空串 = 通过；否则是错误码）：
 *   · 期望 url 命中 `variants[]` 里的某一档 ⇒ `source` 必须是 `variant`；
 *   · 而且它的 sha256 **不许**等于原画的 sha256（两个对象不同 —— 真相同只在站点复用同一
 *     文件时出现，那种情况下站点本来也会给同一个哈希，这里只在**都非空**时判）。
 * 命中即 `hash-source-mismatch`：宁可当场明确失败，也不要慢慢 `hash-mismatch`
 * （后者看起来像"网络传坏了"，真因却是我们自己拿错了哈希）。
 *
 * @param {any} item 清单条目
 * @param {{ url?: string, sha256?: string, source?: string }} expectation
 * @returns {''|'hash-source-mismatch'|'hash-source-not-variant'}
 */
export function assertExpectation(item, expectation) {
  const o = item || {};
  const e = expectation || {};
  const variants = normalizeVariants(o.variants, o.base);
  const hit = findVariantByUrl(variants, e.url);
  if (!hit) return '';                              // 期望值不是任何变体 ⇒ 走原画口径
  if (e.source !== 'variant') return 'hash-source-not-variant';
  const own = normalizeSha(hit.sha256);
  const orig = normalizeSha(o.sha256);
  if (own && orig && own === orig) return '';       // 站点两档同哈希（罕见但合法）
  const want = normalizeSha(e.sha256);
  if (orig && want === orig) return 'hash-source-mismatch';
  if (own && want && want !== own) return 'hash-source-mismatch';
  return '';
}
