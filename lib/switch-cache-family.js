/**
 * switch-cache-family.js — **缓存族**：同一资源的「原画」与「1080p 变体」是同一条缓存。
 *
 * ══ 为什么需要 ══════════════════════════════════════════════════════════════════
 * 用户实测：「点**已下载好**的壁纸会卡一下才播」。
 *
 * 真实的坏链在这里：`lib/routes/downloads.js` 的 `libraryDest(kind, slug, ext)` 用
 * **最终 URL 的 basename** 做散列 —— 原画 `x.mp4` 与 1080p `x-1080p.mp4` 因此是
 * **两条互不相干的缓存**。而 `localCopyFor(url)` / `queueJobFor(url)` 又只按**问的那个
 * URL 自己的 basename** 重算 dest，于是：
 *
 *   · 站点按「策略 A」给这条壁纸选了 1080p 下载 ⇒ 盘上是 `x-1080p.mp4`；
 *   · 播放时 `applySelection()` 拿的是 `w.mediaProxy`，而 `inventory.js` 只按
 *     **原画 URL** 算 `localCopyFor()` ⇒ 未命中 ⇒ `local:false`；
 *   · `mediaProxy` 于是回落到 `/folia/site-media/?u=…` 代理 ⇒ 客户端点一下要走
 *     「客户端 → 宿主 → 上游」的中继，**明明本地就有这份内容**；
 *   · 某些路径还会**重新入队下载**（`src/local-first.js` 只在 `local === true` 时跳过）。
 *
 * 结论：`local:false` 并不等于"没下载"，它等于"**没按这一条 URL 下载**"。用户看到的是
 * "已缓存却还卡"，不是自相矛盾。
 *
 * 本文件把"同一条 URL"放宽成"同一个**内容族**"：只要族里任一档已落地，就认为这条
 * 资源在本地可播（`localReady`）。`local`（精确命中）保留 —— 两者语义不同，面板要显示
 * 的是 `localReady`（「已缓存」角标），排障要看的才是 `local`。
 *
 * ══ 不变量 ══════════════════════════════════════════════════════════════════════
 *   · **纯函数、零依赖**（不读文件、不碰队列）：族键必须可单测，
 *     判据见 `test/verify-switch-smooth.mjs` 的缓存族一节。
 *   · **只剥清晰度/编码后缀**，绝不剥"看起来像后缀"的正文 —— 剥过头会把两张**不同**
 *     的壁纸并成一族，那就从"缓存不命中"升级成"放错壁纸"，比原缺陷更糟。
 *   · 认不出来（basename 是 token / 没有扩展名 / 空）⇒ 族键退化成**精确 URL**，
 *     也就是行为与放宽之前逐字节等价（不报错、不变快、也不变慢）。
 */

/**
 * 只在 basename 末尾剥的"清晰度/编码"后缀。顺序无关（循环剥到不再变化）。
 *
 * ⚠️ 放进这张表的每一条都必须是**站点生成变体时真的会加的那一段**。放进来一个
 * 常见词（`small` / `light` / `big`）就会把两张不同的壁纸并族 —— 这类词要么不进表，
 * 要么只在**同时**有另一档同名文件时才认定（本函数做不到后者，所以宁可不认）。
 */
const QUALITY_SUFFIXES = [
  '2160p', '1440p', '1080p', '720p', '480p', '360p', '240p',
  '4k', '2k', 'uhd', 'fhd', 'qhd', 'hd', 'sd',
  'hdr', 'sdr', 'hdr10',
  'hevc', 'h264', 'av1', 'vp9',
  'saver', 'compressed',
];

/** URL → 只留 pathname 的 basename（去查询串 / 哈希 / 百分号编码统一小写比较）。 */
function familyBaseName(url) {
  let s = String(url == null ? '' : url).trim();
  if (!s) return '';
  // 去掉查询串与哈希：变体 URL 常带 `?u=` / `?v=`，它们不是身份的一部分。
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  const at = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (at >= 0) s = s.slice(at + 1);
  try { s = decodeURIComponent(s); } catch { /* 非法编码：按原文 */ }
  return s.trim();
}

/** 拆成 { stem, ext }（ext 不含点；没有扩展名时 ext 为空串）。 */
function familySplit(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  // `.hidden` / 没有点 / 点在开头 ⇒ 没有扩展名。
  if (dot <= 0) return { stem: s, ext: '' };
  return { stem: s.slice(0, dot), ext: s.slice(dot + 1) };
}

/**
 * 族的"主干"：把清晰度 / 编码后缀从 stem 末尾**反复**剥掉。
 *
 * 反复剥是为了 `x-1080p-hevc` 这种叠了两段的站点命名。每一轮只剥**一个**分离符
 * 加一个后缀，剥完再判 —— 于是 `my-1080p-wallpaper` 不会因为中间那一段被剥成
 * `my-wallpaper`（后缀必须"结尾"，这是这条函数唯一的防线）。
 */
function familyStem(stem) {
  let s = String(stem || '');
  for (let guard = 0; guard < 4; guard += 1) {
    let hit = false;
    for (const suf of QUALITY_SUFFIXES) {
      // 结尾是 `[-_.]<suf>`，且前面**还有内容**（否则 `hd.mp4` 会被剥成空串）。
      const re = new RegExp('^(.+)[-_.]' + suf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
      const m = s.match(re);
      if (m && m[1]) { s = m[1]; hit = true; break; }
    }
    if (!hit) break;
  }
  return s;
}

/**
 * 缓存族键。`kind` 参与键（壁纸与皮肤的 `x.mp4` 是两回事）。
 *
 * 返回 `''` 表示"认不出"——调用方此时应退回精确匹配（见文件头不变量第三条）。
 */
export function familyKeyOf(url, kind = 'wallpaper') {
  const base = familyBaseName(url);
  if (!base) return '';
  const { stem, ext } = familySplit(base);
  if (!stem) return '';
  const fam = familyStem(stem);
  if (!fam || fam === stem) {
    // 没剥掉任何东西：说明这条 URL 本来就没有清晰度后缀。仍然给出族键（=它自己），
    // 这样"精确命中"与"族命中"在同一条路径上，调用点不必写两个分支。
    return String(kind) + '/' + stem.toLowerCase() + (ext ? '.' + ext.toLowerCase() : '');
  }
  return String(kind) + '/' + fam.toLowerCase() + (ext ? '.' + ext.toLowerCase() : '');
}

/**
 * 从一批下载 job 里挑出与 `url` **同族且已落地**的那一条。
 *
 * `jobs` 的形状与 `queue.snapshot()` 一致：`{ id, url, kind, status, total }`。
 * 返回 `null` = 族里没有任何一条已落地。
 *
 * ⚠️ 先找**精确命中**，再找同族：用户点了原画就优先给原画（画质不打折），只有当
 * 同族里有别的档位已落地时才降级复用 —— 这是本函数唯一允许的"行为放宽"。
 */
export function pickFamilyCopy(jobs, url, kind = 'wallpaper', opts = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const want = String(url == null ? '' : url).trim();
  if (!want) return null;
  const doneOf = (j) => j && j.status === 'done' && (!j.kind || String(j.kind) === String(kind));
  // ① 精确命中（画质无损）。
  for (const j of list) {
    if (!doneOf(j)) continue;
    if (String(j.url || '') === want) return { job: j, family: false };
  }
  // ② 同族命中（复用另一档已落地的那份）。
  if (opts.family === false) return null;
  const key = familyKeyOf(want, kind);
  if (!key) return null;
  for (const j of list) {
    if (!doneOf(j)) continue;
    if (familyKeyOf(String(j.url || ''), kind) === key) return { job: j, family: true };
  }
  return null;
}

/**
 * 「已缓存」角标的判据：**族级**命中即为真。
 *
 * 与 `local`（精确）分开是因为两件事的下游不同：面板显示要"用户看得见的那个结论"
 * （已缓存），排障要"精确的那一条"（为什么没走本地）。
 */
export function localReadyOf(jobs, url, kind = 'wallpaper') {
  const hit = pickFamilyCopy(jobs, url, kind);
  return Boolean(hit);
}
