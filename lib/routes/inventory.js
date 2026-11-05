/**
 * 清单 JSON 路由 —— `GET ${BASE}/inventory`。
 *
 * 为什么独立成族：P0.2-D 把 `apply()` 里最后一条内联路由处理器搬了出来，门面只剩
 * 「建 kit → 装路由 → 返回 disposer」的装配骨架。处理器体逐字搬来（原本就在 apply() 里
 * 2 格缩进 ⇒ 本文件里的缩进逐字未变），路径 / 头 / 状态码 / 错误文案一律不变。
 *
 * 契约：registerInventoryRoutes(webServer, c)；`c` 里是这一族要用、但不属于它的东西：
 *   - disposers      apply() 的清理句柄台账（注册返回值**必须**推进去）
 *   - base           URL 前缀（= 门面 BASE，这里本地别名为 BASE）
 *   - mediaOriginApi 媒体源访问器（`observeAdapter(req)`）
 *   - buildInventory 清单构建器（门面模块作用域的 3s TTL 缓存，生命周期 = 一次 apply）
 *   - componentsProbe 组件行**行状态**探针（门面 `componentProbe()`，只读；见下「组件行状态」）
 *
 * 不变量：
 *   - `mediaOriginApi.observeAdapter(req)` 必须在 `buildInventory()` **之前**：媒体源起不起
 *     由本次请求的形态决定。
 *   - 成功响应头逐字保留：`application/json; charset=utf-8` + `Cache-Control: no-store`；
 *     500 分支只有 `application/json`（**不带** charset），字面量按 P0 纪律原样搬来，
 *     不要"顺手"改用 sendJson（那会多出 `; charset=utf-8`）。
 *   - 只 import `node:*` 与相对路径；**绝不** import `lib/index.js`。
 *
 * ── 组件行状态（`inventory.components`，ADR-0013 D3 的**状态面**）────────────────────
 * 形状（跨半边契约，浏览器半边按它 gate 可见面）：
 *   `{ "<组件名>": "started" | "failed:<错误文案>" | "missing" }`
 *   · `started`：该组件行的 apply 跑完、disposer 已交回宿主 —— **唯一算"可用"的值**；
 *   · `failed:<…>`：apply 抛错（文案随行，便于排障；判定不可用只该看前缀 `failed`）；
 *   · `missing`  ：该行**存在**（本包内建）但运行时**没有**装载 —— 行被 `disabled`、或入口没走到。
 * 键集 = 该次装载的**内建声明面**（探针的 `builtin`，即 `componentImpls()` 的键）。
 * 为什么不用探针的 `declared`（同一个键集、且被 `test/verify-bundle-rows.mjs` 钉成"逐名等于 patch 子行"）：
 * 那个面表达的是**装载面**（这次到底装了什么），`/diag-log` 的买家要的是它；
 * 行状态表要的是**代码内建面**（这个包写死了哪些组件行）—— 两者当前取值相同，但**读取方向必须有优先序**：
 * 先 `builtin`、`declared` 只作"更老/更窄的宿主"的兜底。
 * ⚠️ 别把这条读成"关掉的行会在 `declared` 里消失"：`declared` 是调用点传进来的**同一个键集**
 * （`lib/index.js` 现在把 `componentImpls()` 的键同时传给两个面），它 **不知道** patch 行的启停 ——
 * "行被 disable"最终由**账本**表达：没装载 ⇒ 不在 `started` / `failed` 里 ⇒ 落到 `missing`。
 * 两个面都保留在探针里，是为了让下游买家各自认自己那一面，且不放开 `declared` 的既有判据。
 *
 * ⚠️ **失效口径（D3③，跨半边纪律）**：整个 `components` 字段可能**缺席**
 *   （探针不可用 / 响应来自更老的宿主）⇒ 消费方必须**按"可用"渲染**（宁可显示，不可静默消失）。
 *   这条与"内核缺键即抛"是不同场景的两条纪律：缺键 = 装错（响亮报错），探测失败 = 不许让功能凭空消失。
 *   ⇒ 本族因此在探针不可用时**不合成**一份"全 missing"的假地图，而是让字段缺席。
 *
 * 单一真源：三本账（loaded / started / failed）都在 `lib/host-boot.js`；
 * 本文件只做**派生**（把三本账折叠成上面这张状态表），不持有任何组件状态。
 */
/** 注入契约（P2-7A / ADR-0013 D12）：本族从 `c` 消费的**必需**键 —— 门面/组件行调用点必须逐键给到（判据 test/verify-inject-contracts.mjs 双向对账）。 */
export const DEPS = ['disposers', 'base', 'mediaOriginApi', 'buildInventory', 'componentsProbe'];

/**
 * 探针三面 → 行状态表（形状见文件头「组件行状态」）。
 * 纯派生，不改探针、不缓存。**先读内建面**（`builtin`：本包写死了哪些组件行）——
 * 行被 disable 时它在 `declared` 里不出现、但在 `builtin` 里必然出现 ⇒ 才有一个值为 `missing`
 * 的键可以表达"这一行被关掉了"。退一步用 `declared` 兜底（探针来自更老 / 更窄的宿主时）。
 * 探针不可用（不是函数 / **抛错** / 返回非对象 / 两个面都读不出）时返回 `null` —— 调用方据此**不写**
 * `components` 字段，而不是合成"全不可用"（失效口径：宁可显示）。
 * ⚠️ **探针抛错必须在这里吞掉**：`components` 只是可选的状态面，它不该有能力把整条清单（壁纸库）
 * 一起打成 500 —— 那等于让"可选面不可用"升级成"主功能不可用"，与 D3③ 的方向相反。
 * @param {unknown} probe 门面注入的 `componentProbe()`
 * @returns {Record<string, string> | null}
 */
function rowStatusOf(probe) {
  /** @type {any} */
  let p;
  try {
    p = typeof probe === 'function' ? probe() : null;
  } catch {
    p = null;   // 探针抛错 = 状态面不可用（不是"全都不在"）⇒ 交给下面的失效口径
  }
  if (!p || typeof p !== 'object') return null;
  const rows = Array.isArray(p.builtin) && p.builtin.length ? p.builtin
    : (Array.isArray(p.declared) && p.declared.length ? p.declared : null);
  if (!rows) return null;
  const failed = (p.failed && typeof p.failed === 'object') ? p.failed : {};
  const started = Array.isArray(p.started) ? p.started : [];
  const out = {};
  for (const name of rows) {
    if (started.includes(name)) out[name] = 'started';
    // `in` 而不是真值判断：空文案的失败也是失败（`failed:''` 折叠成 `missing` 会把"抛错"误报成"没装载"）。
    else if (name in failed) out[name] = `failed:${failed[name]}`;
    else out[name] = 'missing';
  }
  return out;
}

/* ── Folia 站点数据源 ────────────────────────────────────────────────────────
 * 把自建站点（默认 `https://pub-1275321f146e479eaac54948f4cdad6f.r2.dev`）清单里的条目
 * 并进 inventory，于是「本机 Wallpaper Engine 工坊 + 上传库 + 站点」三者在客户端看来是
 * 同一个壁纸库。
 *
 * 为什么默认值是 folia-5ve.pages.dev：站点后台（D1 + admin）产出 /data/catalog.json，
 * 素材 `<base>/boot/*`）。旧站 `folia-major-3t6.pages.dev` 已废弃 —— 但**换站不需要改代码**，
 * 用 `DSH_FOLIA_SITE` 覆盖即可。
 *
 * 契约：
 *   · 地址由 `DSH_FOLIA_SITE` 覆盖；`=off` 关闭整条通道（测试/离线场景用）。
 *   · 站点**不可达绝不影响本机库**：任何异常都折成空数组，TLT 60s 内不重试
 *     （失败也进缓存 —— 否则每次 /inventory 都要等一次超时）。
 *   · 只认清单里带媒体后缀或 `kind` 的条目；无法判类型的一律丢弃（宁可少，不可坏）。
 *   · 产出条目**自带绝对 URL**（`media` / `preview`），客户端 `apiUrl()` 对绝对 URL 原样放行。
 *
 * 站点格式（`<site>/manifest.json`）：`{ images: [{ file, title, url, preview, kind?, animated? }] }`
 * —— 与 `folia-wallpaper-site` 产物一致；`url`/`preview` 可以是相对路径（相对站点基址）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// 本地优先：站点条目若已由下载队列落地，清单里直接给本地地址（渲染只读本地）。
import {
  localCopyFor, localFamilyCopyFor, isSlowHostUrl, mediaStateOfUrl, registerManifestSource,
} from './downloads.js';
// **4.23.19：播放源的唯一解析器**（宿主与客户端同一份判据）。
import { resolvePlaySrc } from '../media-state.js';
// 1080p 变体选档（纯函数）：清单时刻给一个"当前该用哪一档"的结论供卡片显示。
import { pickVariant } from '../variant-pick.js';
import { siteRequestHeaders } from '../site-auth.js';

const FOLIA_SITE = 'https://folia-5ve.pages.dev';
/**
 * 站点数据源的两个可能形态，按顺序尝试：
 *   · `/data/catalog.json` —— 站点（D1 + admin）产出的目录，**当前的真源**
 *   · `/manifest.json`     —— 早期静态清单，保留兼容（站点上没有 catalog 时回退）
 * 顺序有讲究：catalog 是站点后台维护的，manifest 是我们手写的；两者都在时以站点为准。
 */
/**
 * 站点的**实时接口**。它比静态快照优先：快照只在部署时生成（我们实测过它停在某个时间点，
 * 而站点后台早就加了新图），接口才是"你传完就能看到"的那条路。
 *
 * 形状：`{ ok, data: { items: [...], total, hasMore, nextCursor } }`，按游标分页。
 */
const FOLIA_API_PATH = '/api/public/wallpapers';
/**
 * 只要壁纸分类。站点分类不止壁纸（还有 `boot-animation` / `skin-pack` / 桌宠），
 * 而它们的 `kind` 同样是 `dynamic`/`static` —— 只按类型判会把开机动画当成壁纸拉进来。
 * 服务端支持 `?category=`，优先用它（少传无用数据）；客户端的 `foliaIsWallpaperCategory`
 * 是兜底，防服务端忽略参数或以后新增分类。
 */
const FOLIA_API_CATEGORY = 'wallpaper';
/** 明确**不是**壁纸的分类。没列进来的（含未来新增的）一律放行 —— 宁可多显示，不静默丢。 */
const FOLIA_NON_WALLPAPER_CATEGORIES = ['boot-animation', 'skin-pack', 'skin', 'pet', 'pets', 'assistant-skin'];
/** 分页上限：防止站点游标异常时无限翻页（每页 12~24，20 页足够几百条）。 */
/** 每次请求要多少条：接口支持 `?limit=`（实测 limit=5 生效），一次要 100 条能把
 *  几百张图的清单压到个位数请求。 */
const FOLIA_API_LIMIT = 100;
/** 条目总数上限（防止站点数据异常时无限翻页）。100 × 20 = 2000 条。 */
const FOLIA_API_MAX_PAGES = 20;
const FOLIA_CATALOG_PATH = '/data/catalog.json';
const FOLIA_MANIFEST_PATH = '/manifest.json';
const FOLIA_TTL_MS = 60000;
const FOLIA_TIMEOUT_DEFAULT_MS = 4000;
const FOLIA_TIMEOUT_MIN_MS = 1000;
const FOLIA_TIMEOUT_MAX_MS = 15000;

/**
 * 拉取状态。**对用户可见**（随 inventory 下发 `siteSource`）：站点不可达时界面要能
 * 说清"为什么没有云端壁纸"，而不是静默空库 —— 之前就是静默失败，排查时无从下手。
 * @type {{ at: number, items: any[], status: { url: string, ok: boolean, count: number, ms: number, error: string|null } | null }}
 */
/**
 * 站点清单的磁盘缓存：`~/.dsh-folia/cache/site-items.json`。
 *
 * 为什么落盘：内存缓存只活一个进程。没有它，**每次重启后第一次打开面板**都要等一次
 * 完整的跨境往返（实测 ~800ms），这段时间界面是空的。有了它，冷启动也能立刻出内容。
 *
 * 纪律：读失败一律当"没有缓存"（坏缓存只该慢一次，不该出错）；只缓存**成功**的结果，
 * 失败不落盘 —— 否则一次断网会把空列表固化下来，之后每次启动都显示没壁纸。
 */
function foliaDiskCachePath() {
  const home = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(home, 'cache', 'site-items.json');
}

function readFoliaDiskCache() {
  try {
    const doc = JSON.parse(readFileSync(foliaDiskCachePath(), 'utf8'));
    if (!doc || !Array.isArray(doc.items) || !doc.items.length) return null;
    return { at: Number(doc.at) || 0, items: doc.items, status: doc.status || null };
  } catch {
    return null;
  }
}

function writeFoliaDiskCache(entry) {
  try {
    const p = foliaDiskCachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ at: entry.at, items: entry.items, status: entry.status }));
  } catch { /* 只读盘 / 配额：写不进去只影响下次速度，不影响正确性 */ }
}

/** 内存缓存；**用磁盘缓存打底** —— 冷启动第一次请求就能立刻返回旧列表。 */
let foliaCache = (() => {
  const disk = readFoliaDiskCache();
  return disk ? { at: disk.at, items: disk.items, status: disk.status } : { at: 0, items: [], status: null };
})();

/** 后台刷新是否在途（避免多个请求同时触发同一次刷新）。 */
let foliaRefreshInflight = false;

/** 超时从 env 读，越界收敛到 [1s, 15s]。`DSH_FOLIA_SITE_TIMEOUT_MS=8000` 可放宽弱网。 */
function foliaTimeoutMs() {
  const n = Number(process.env.DSH_FOLIA_SITE_TIMEOUT_MS);
  if (!Number.isFinite(n) || n <= 0) return FOLIA_TIMEOUT_DEFAULT_MS;
  return Math.min(FOLIA_TIMEOUT_MAX_MS, Math.max(FOLIA_TIMEOUT_MIN_MS, Math.round(n)));
}

/** `DSH_FOLIA_SITE` → 归一化基址；`off`/空串表示停用。 */
function foliaSiteBase() {
  const raw = process.env.DSH_FOLIA_SITE;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return null;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : FOLIA_SITE;
  return base.replace(/\/+$/, '');
}

/** 相对路径 → 绝对 URL；已是 scheme 的原样返回。 */
function foliaAbs(base, u) {
  if (!u) return null;
  const s = String(u);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return base + (s.startsWith('/') ? s : '/' + s);
}

/**
 * 条目类型。优先级：**mime** > kind > URL 后缀。
 *
 * 站点目录的条目长这样：`{ slug, title, kind: 'dynamic', mime: 'video/mp4', url: '/media/...' }` ——
 * 它没有 `file` 字段，而且 `kind: 'dynamic'` 既可能是视频也可能是有动画的图，所以 mime 最可靠。
 *
 * ⚠️ 实测踩过的坑：WE **工程包**（zip）的 `kind` 也是 `dynamic`、`mime` 是 `application/zip`。
 * 早先的顺序是「kind=dynamic ⇒ video」，于是 56 MB 的 zip 被当成视频塞进 `<video>`，
 * 用户看到的是「浏览器无法解码这段视频」。⇒ **非 image/ 非 video/ 的 mime 一律不猜视频**，
 * 而是判成 `package`（可显示、不可播放，客户端会给出明确原因而不是解码失败）。
 */
function foliaTypeOfEntry(it) {
  const mime = String((it && it.mime) || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  // 已知的"包"形态：工程包 / 压缩包。它们不是可直接播放的媒体。
  if (/^application\/(zip|x-zip|x-zip-compressed)$/.test(mime)) return 'package';
  const kind = String((it && it.kind) || '').toLowerCase();
  const probe = String((it && (it.file || it.url || it.slug)) || '');
  if (/\.zip$/i.test(probe)) return 'package';
  // `application/octet-stream` 是"不知道是什么的二进制"：按后缀与 kind 继续判，
  // 不当成包（上传工具经常把视频标成 octet-stream）。
  // 其余"有 mime 但不是媒体"的（例如 application/json）一律不猜 —— 宁可丢也不塞进播放器。
  if (mime && mime !== 'application/octet-stream') return null;
  if (kind === 'video' || kind === 'dynamic') return 'video';
  if (kind === 'image') return 'image';
  if (/\.(mp4|webm|mov|m4v)$/i.test(probe)) return 'video';
  if (/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(probe)) return 'image';
  return null;
}

/** 条目的分类 slug（没有就返回空串）。 */
function foliaCategoryOf(it) {
  // ⚠️ 形参**不要**叫 c：test/verify-inject-contracts.mjs 会把 c.<键> 读成"从注入面消费了
  // 该键"，这里一个分类对象曾经让对账表凭空多出 slug。名字取得像注入面就会被当成注入面。
  const category = it && it.category;
  return String((category && category.slug) || '').trim().toLowerCase();
}

/**
 * 它是不是一条"壁纸"。黑名单制：只有明确属于其它模块的分类才排除。
 * 不用白名单，是因为站点以后加分类时白名单会静默把新东西吞掉。
 */
function foliaIsWallpaperCategory(it) {
  const slug = foliaCategoryOf(it);
  if (!slug) return true;
  return !FOLIA_NON_WALLPAPER_CATEGORIES.includes(slug);
}

/**
 * 站点资源的**本站缓存代理**地址（未落地时的站点流）。
 *
 * 唯一拼法：`/folia/site-media/<basename>?u=<绝对URL>`。`lib/routes/site-media.js` 按 `u`
 * 校验同源白名单；尾段的 basename 只是"像文件名的占位"（客户端拿它当 /media-info 的 token）。
 */
function siteProxyUrlOf(media) {
  const s = String(media || '');
  return '/folia/site-media/' + encodeURIComponent(s.split('/').pop() || 'media')
    + '?u=' + encodeURIComponent(s);
}

/**
 * **清单缓存命中时重算本地字段**（4.23.19）。
 *
 * 真实故障：`site-items.json` 与 60s 内存缓存装的是**已富化**条目 —— `mediaProxy` 在写缓存
 * 那一刻就被钉成 `/folia/local-media/<id>`。此后文件被清掉 / 4.23.18 把记录折成 pending /
 * 重启换了一轮队列，缓存里那份**旧本地地址**仍然会发给客户端 ⇒ 首屏必然 404。
 *
 * 判据（唯一）：`resolvePlaySrc(对账器的当前状态, { mediaProxy: 站点流, media })`。
 * 于是"缓存里的旧地址"不再有话语权 —— 它只提供与网络无关的元数据（标题/变体/预览）。
 */
function refreshLocalFields(item) {
  if (!item || !item.media) return item;
  const type = item.type;
  const exact = (() => {
    try { return type === 'package' ? null : localCopyFor(String(item.media), 'wallpaper'); } catch { return null; }
  })();
  const family = exact || (() => {
    try { return type === 'package' ? null : localFamilyCopyFor(String(item.media), 'wallpaper'); } catch { return null; }
  })();
  const mediaState = mediaStateOfUrl(String(item.media));
  const play = resolvePlaySrc(mediaState, { mediaProxy: siteProxyUrlOf(item.media), media: item.media });
  return Object.assign({}, item, {
    local: Boolean(exact),
    localReady: play.source === 'local',
    localDownload: play.source === 'local' ? family : null,
    mediaProxy: play.url,
    mediaState,
  });
}

/** 站点目录的一条 → inventory 条目。判不出类型/没有媒体地址就返回 null。 */
function foliaItemFromCatalog(it, base) {
  const type = foliaTypeOfEntry(it);
  if (!type) return null;
  const media = foliaAbs(base, it && it.url);
  if (!media) return null;
  const slug = String((it && (it.slug || it.id)) || '');
  // 站点图片的预览走宿主缩略图代理：卡片只下 ~10 KB，不再下 500 KB 原图。
  // （视频没有封面，保持 null —— 卡片会显示「无预览」，不会去拉整段视频。）
  // 预览优先级：**站点自己给的 preview 最高**（省掉宿主这一跳，也最省流量）；
  // 站点没给才退回宿主缩略图代理。只有预览走小图，`media` 永远是原图 ——
  // 应用壁纸用的是 `media`，所以画质不受影响。
  // 站点后台已经自动生成缩略图（thumbUrl，webp 小图），优先用它 ——
  // 比宿主自己 ffmpeg 生成更快（少一跳），也比你手传更省事。
  const sitePreview = foliaAbs(base, it && (it.thumbUrl || it.preview || it.poster)) || null;
  const thumb = sitePreview ? null : (type === 'image' ? '/folia/site-thumb?u=' + encodeURIComponent(media) : null);
  const extHit = String(media).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  // **缓存族一次性求值**（4.23.8 / 成因 ⑤）：下面三处（本地下载地址 / 播放代理 / 角标）
  // 必须是同一个结论 —— 分三次算会在"两次调用之间 job 恰好落盘"时给出互相矛盾的值
  //（一次命中一次不命中），那是线上最难查的一类。精确命中优先，族命中兜底。
  const exactCopy = (() => {
    try { return type === 'package' ? null : localCopyFor(String(media), 'wallpaper'); } catch { return null; }
  })();
  const familyCopy = exactCopy || (() => {
    try { return type === 'package' ? null : localFamilyCopyFor(String(media), 'wallpaper'); } catch { return null; }
  })();
  // **4.23.19：播放源只由 `resolvePlaySrc()` 决定**（宿主与客户端同一份判据，见 media-state.js）。
  // 这里不再写 `familyCopy ? familyCopy.url : proxy` —— 那条三元式正是"本地地址可能指向缺失文件"的入口。
  const mediaState = mediaStateOfUrl(media);
  const play = resolvePlaySrc(mediaState, { mediaProxy: siteProxyUrlOf(media), media });
  return {
    id: 'folia-' + (slug || media),
    title: String((it && it.title) || slug || 'Folia'),
    type,                                   // 'video' | 'image' | 'package'
    contentrating: null,
    // 工程包（zip）不是可直接播放的媒体：标成不可播放，客户端据此**不塞进 <video>**，
    // 而是显示「工程包 · 暂不支持」的明确说明（而不是让浏览器报解码失败）。
    playable: type !== 'package',
    unsupportedReason: type === 'package' ? 'we-package' : null,
    media,                                  // 绝对 URL（原始站点地址；下载/兜底都用它）
    // 播放走**本机缓存代理**：首次边下边播并落盘，之后同一张直接从磁盘读（切换不再等网络）。
    // 尾部那一段只是"像文件名的占位"（客户端拿 `url.split('/').pop()` 当 token 去问 /media-info，
    // 查不到即"未知源"，不会报错）。代理的任何失败都会 302 回 `media` ⇒ 与直连等价。
    // **本地优先**：只有"文件在 + 内容有效 + job done"才给本地地址（其余一律站点流）。
    /** 本地下载地址：族级命中**且经解析器确认可播**才给。 */
    localDownload: play.source === 'local' ? familyCopy : null,
    mediaProxy: play.url,
    /**
     * **4.23.19：盘上事实**（`fileExists` / `fileValid` / `localReady` / `source`）。
     * 客户端只用它做一件事：**不是"完整且有效"就绝不把 `<video>` 指到 local**。
     * 来自对账器（唯一产地）；清单缓存每次返回都会重算（见 `refreshLocalFields`）。
     */
    mediaState,
    /** **精确**命中（这一条 URL 自己有 job 且 done）—— 排障看它，语义与 4.23.7 一致。 */
    local: Boolean(exactCopy),
    /**
     * **族级**命中（原画 / 1080p 任一档已落地）—— 面板的「已缓存」角标看它。
     * 与 `local` 分开是因为两件事回答的问题不同：「能直接读本地吗」vs「恰好下了这一条吗」。
     */
    localReady: play.source === 'local',
    // ── 1080p 变体（4.23.4）────────────────────────────────────────────────
    // 站点从 d960c62 起给视频条目带 `variants`（通常一档 1080p）。三件事：
    //   ① `variants` **原样透传**（规整掉非法 url），客户端入队时再带回去，选档逻辑只有一处；
    //   ② 这里也给一个**清单时刻**的选档结论（用队列的慢域标记 + 环境级画质设置），
    //      供卡片显示「1080p」小标 —— 它与入队时那一枪读的是同一个纯函数；
    //   ③ 站点还没有 variants 字段时，这三项分别是 `[]` / `original` / 原 `media`，
    //      于是整条链路与 4.23.3 逐字节等价（不报错、不改画质）。
    ...(() => {
      const pick = (() => {
        try {
          const raw = Array.isArray(it && it.variants) ? it.variants : [];
          if (!raw.length || type !== 'video') return null;
          return pickVariant({
            variants: raw,
            base,
            originalUrl: String(media),
            originalBytes: num(it && it.bytes) || 0,
            quality: process.env.DSH_FOLIA_QUALITY,
            hostSlow: (() => { try { return isSlowHostUrl(String(media)); } catch { return false; } })(),
            screenHeight: 0,   // 宿主不知道屏幕高度 ⇒ 只按速度判；入队时客户端会补上
            // 4.23.15：**解码上限预判**也要在清单时刻参与 —— 卡片上的「1080p」小标与
            // 入队时那一枪必须给出同一个结论，否则用户会看到"卡片说 1080p、实际下了原画"。
            originalWidth: num(it && it.width) || 0,
            originalHeight: num(it && it.height) || 0,
            // 4.23.15 真机定因：**4K@60** 才是"浏览器无法解码"的主因（不是 HEVC、不是坏文件）。
            // 清单没给帧率时由 highFpsHit 按"宽>=3840"兜底。
            originalFps: num(it && (it.fps || it.frameRate)) || 0,
          });
        } catch { return null; }
      })();
      return {
        variants: (pick && pick.variants) || [],
        chosenVariant: (pick && (pick.chosen === '1080p' || pick.chosen === '4k30')) ? pick.chosen : 'original',
        variantUrl: (pick && pick.url) || String(media),
        variantHeight: (pick && pick.height) || 0,
        variantReason: (pick && pick.reason) || 'no-variant',
      };
    })(),
    mediaExt: '.' + (extHit ? extHit[1].toLowerCase() : (type === 'video' ? 'mp4' : 'jpg')),
    // 站点目录可能带 preview/poster；图片没封面时用自己当预览，视频没有就留空（卡片会是黑块）
    preview: sitePreview || thumb || null,
    frameUrl: null,
    schemeColor: null,
    sceneLiveSrc: null,
    sceneVideo: null,
    sceneAudio: null,
    propsUrl: null,
    liveFrame: null,
    source: 'folia',
    bytes: num(it && it.bytes),
    width: num(it && it.width),
    height: num(it && it.height),
    // 4.23.15：帧率随条目下发（选档要它；站点没给就是 null，交给"宽>=3840"兜底）。
    fps: num(it && (it.fps || it.frameRate)),
    durationMs: num(it && it.durationMs),
    // 4.23.15：站点清单的 sha256 **必须透传到客户端**。播放失败自愈要靠它回答
    // "这份本地副本是坏了，还是只是本机解不了" —— 而客户端手里只有这条清单。
    // 空串（站点没给）⇒ null：让"没给"与"给了个空值"在链路上不混为一谈。
    sha256: (() => {
      const v = String((it && it.sha256) || '').trim().toLowerCase();
      return /^[0-9a-f]{64}$/.test(v) ? v : null;
    })(),
  };
}

/** 旧静态清单 `{ images: [...] }` 的一条 → inventory 条目。 */
function foliaItemFromManifest(it, base) {
  const type = foliaTypeOfEntry(it);
  if (!type) return null;
  const file = String((it && (it.file || it.id)) || '');
  const media = foliaAbs(base, it && it.url);
  if (!media) return null;
  const ext = (file.split('.').pop() || (type === 'video' ? 'mp4' : 'jpg')).toLowerCase();
  return {
    id: 'folia-' + (file || media),
    title: String((it && it.title) || file || 'Folia'),
    type,
    contentrating: null,
    playable: true,
    media,
    mediaExt: '.' + ext,
    preview: foliaAbs(base, it && it.preview) || (type === 'image' ? media : null),
    frameUrl: null,
    schemeColor: null,
    sceneLiveSrc: null,
    sceneVideo: null,
    sceneAudio: null,
    propsUrl: null,
    liveFrame: null,
    source: 'folia',
  };
}

/** 条目类型：先看 `kind`，回落到文件后缀。判不出返回 null（丢弃）。 */
function foliaTypeOf(it) {
  const file = String(it && it.file ? it.file : '');
  const kind = String(it && it.kind ? it.kind : '').toLowerCase();
  if (kind === 'video' || /\.(mp4|webm|mov|m4v)$/i.test(file)) return 'video';
  if (kind === 'image' || /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(file)) return 'image';
  return null;
}

/**
 * 拉站点清单并折成 inventory 条目。永不抛。
 *
 * @param {boolean} [force] 忽略 TTL 强制重拉（客户端「重试」按钮走 `?refresh=1`）。
 * @returns {Promise<{ items: any[], status: { url: string, ok: boolean, count: number, ms: number, error: string|null } | null }>}
 *
 * 失败分类（写进 `status.error`，让界面能说人话）：
 *   `disabled` 通道被 `DSH_FOLIA_SITE=off` 关掉 · `timeout` 超时 · `tls` 证书问题
 *   `http-<code>` 状态码非 2xx · `json` 清单不是合法 JSON · `network` 其它网络错误
 */
/**
 * 对外入口：**先给已有结果，再后台刷新**（stale-while-revalidate）。
 *
 * 这是面板"打开就能看到东西"的关键：清单过期 ≠ 让用户等。有缓存就立刻返回，
 * 同时后台拉一次新的（下次打开就是新的）。只有**一条缓存都没有**时才会阻塞等待。
 */
async function foliaRemote(force = false, filter = null) {
  const base = foliaSiteBase();
  if (!base) return { items: [], status: null, facets: null };

  // **带标签筛选 ⇒ 完全绕过缓存**（4.23.9）：内存/磁盘缓存装的是"全部壁纸"那一份，
  // 拿它去答 `tag=a` 会把"全部"当成"标签 a 的命中"（比慢得多更糟）。
  // 同时也不写缓存 —— 否则下一次"全部"会拿到被筛过的列表。
  const filtered = Boolean(filter && (filter.tag || filter.subtag));
  if (!filtered) {
    const fresh = Date.now() - foliaCache.at < FOLIA_TTL_MS;
    if (!force && foliaCache.items.length) {
      if (!fresh && !foliaRefreshInflight) {
        foliaRefreshInflight = true;
        // 有意不 await：这次先把旧列表发出去，刷新结果留给下一次请求。
        foliaRefresh().catch(() => {}).finally(() => { foliaRefreshInflight = false; });
      }
      return { items: foliaCache.items.map(refreshLocalFields), status: foliaCache.status, facets: foliaCache.facets || null };
    }
  }
  return foliaRefresh(force, filter);
}

/** 真正去站点抓一次（缓存为空、或调用方要求强制刷新时走这里）。 */
async function foliaRefresh(force = false, filter = null) {
  const base = foliaSiteBase();
  if (!base) return { items: [], status: null, facets: null };
  const filtered = Boolean(filter && (filter.tag || filter.subtag));

  const startedAt = Date.now();
  /** @type {any[]} */
  let items = [];
  let error = null;
  let usedPath = FOLIA_CATALOG_PATH;
  /** 站点聚合出来的 facets（4.23.9）：分类/标签/子标签的计数。null = 站点没给。 */
  let facets = null;

  /** 抓一个 JSON；返回 { doc, error }，永不抛。 */
  const fetchJson = async (path) => {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(foliaTimeoutMs())
      : undefined;
    try {
      const res = await fetch(base + path, { headers: siteRequestHeaders(), signal });
      if (!res.ok) return { doc: null, error: 'http-' + res.status };
      try {
        return { doc: await res.json(), error: null };
      } catch {
        return { doc: null, error: 'json' };
      }
    } catch (e) {
      const code = String((e && (e.name || e.code)) || '');
      const msg = String((e && e.message) || '');
      if (/timeout|abort/i.test(code) || /timeout|aborted/i.test(msg)) return { doc: null, error: 'timeout' };
      if (/cert|tls|ssl/i.test(msg)) return { doc: null, error: 'tls' };
      return { doc: null, error: 'network' };
    }
  };

  /**
   * 站点接口的查询串（4.23.9 起带可选的标签筛选）。
   *
   * ⚠️ `category=` **恒为 `wallpaper`**，没有任何分支能改它 —— 那是壁纸库的承重闸门
   * （只拉壁纸，否则开机动画/皮肤会被当成壁纸）。标签只是在这个前提**之内**再筛一层。
   * 判据：`test/verify-filters-dynamic.mjs` 的负对照（不得出现 category≠wallpaper 的请求）。
   */
  const siteScope = (withCursor) => {
    let q = '?category=' + encodeURIComponent(FOLIA_API_CATEGORY) + '&limit=' + FOLIA_API_LIMIT;
    if (filter && filter.tag) q += '&tag=' + encodeURIComponent(String(filter.tag));
    if (filter && filter.subtag) q += '&subtag=' + encodeURIComponent(String(filter.subtag));
    if (withCursor) q += '&cursor=' + encodeURIComponent(withCursor);
    return q;
  };

  /**
   * 拉接口的全部条目（按游标翻页）。任何一页失败就停，用已拿到的那些 ——
   * 半份列表也比空列表有用。
   *
   * 同时把第一页的 `data.facets` 记下来（4.23.9）：它是面板「标签」下拉的**唯一数据源**
   *（服务端聚合计数的结果，客户端不再自己数）。缺失/形状不对 ⇒ `facets` 保持 null，
   * 客户端回落到"只有全部"。
   */
  const fetchApiItems = async () => {
    const out = [];
    let cursor = null;
    for (let page = 0; page < FOLIA_API_MAX_PAGES; page++) {
      // 4.23.22：强刷（hash-mismatch 后的复核）带 `_ts` 抖动，绕过任何中间层缓存。
      const qs = FOLIA_API_PATH + siteScope(cursor) + (force ? '&_ts=' + Date.now() : '');
      const { doc, error } = await fetchJson(qs);
      if (!doc || !doc.ok || !doc.data) return { items: out, error: error || 'api-shape' };
      if (!facets && doc.data.facets && typeof doc.data.facets === 'object') {
        facets = doc.data.facets;
      }
      const items = Array.isArray(doc.data.items) ? doc.data.items : [];
      out.push(...items);
      if (!doc.data.hasMore || !doc.data.nextCursor) return { items: out, error: null };
      cursor = doc.data.nextCursor;
    }
    return { items: out, error: null };
  };

  // ① 站点**接口**（真源）：`{ ok, data: { items: [...] } }`
  const api = await fetchApiItems();
  if (api.items.length) {
    for (const it of api.items) {
      if (!foliaIsWallpaperCategory(it)) continue;   // 兜底：服务端过滤失效时也不把开机动画当壁纸
      const one = foliaItemFromCatalog(it, base);
      if (one) items.push(one);
    }
    usedPath = FOLIA_API_PATH + '?category=' + FOLIA_API_CATEGORY;
  }

  // ② 站点目录（静态快照）：`{ wallpapers: [{ slug, mime, url, ... }] }`
  if (items.length === 0) {
  const cat = await fetchJson(FOLIA_CATALOG_PATH);
  if (cat.doc && Array.isArray(cat.doc.wallpapers)) {
    for (const it of cat.doc.wallpapers) {
      if (!foliaIsWallpaperCategory(it)) continue;   // 快照里也混着开机动画，同样按分类排掉
      const one = foliaItemFromCatalog(it, base);
      if (one) items.push(one);
    }
    if (items.length === 0) error = 'empty';
  } else {
    // ② 回退到旧静态清单：`{ images: [{ file, url, ... }] }`
    usedPath = FOLIA_MANIFEST_PATH;
    const man = await fetchJson(FOLIA_MANIFEST_PATH);
    if (man.doc && Array.isArray(man.doc.images)) {
      for (const it of man.doc.images) {
        const one = foliaItemFromManifest(it, base);
        if (one) items.push(one);
      }
      if (items.length === 0) error = 'empty';
    } else {
      // 两条都不成立：报 catalog 的错（它是真源，错因更有诊断价值）
      error = cat.error || man.error || 'network';
    }
  }
  }
  const status = {
    url: base + usedPath,
    ok: error === null,
    count: items.length,
    ms: Date.now() - startedAt,
    error,
    at: Date.now(),
  };
  // 失败也写内存缓存：否则每次 /inventory 都要再等一次超时。
  // **带标签筛选的那次不写**（4.23.9）：缓存装的是"全部壁纸"，写进去会让下一次"全部"
  // 拿到被筛过的列表（用户会看到"怎么突然少了这么多张"）。
  // facets 随缓存一起留着，这样命中缓存时标签下拉仍有选项。
  if (!filtered) {
    foliaCache = { at: Date.now(), items, status, facets };
    // **成功**才落盘（失败了别把空列表固化到磁盘上）。
    if (!error && items.length) writeFoliaDiskCache(foliaCache);
  }
  return { items, status, facets };
}

// 启动预热：插件一装好就在后台抓一次站点清单，这样**重启后的第一次打开面板**也不冷。
// 有意不 await、失败静默 —— 预热只是优化，绝不能影响启动。
function warmInventorySiteCache() {
  try { foliaRemote(true).catch(() => {}); } catch { /* ignore */ }
}

// 4.23.22：队列校验时现问**当前壁纸清单**（内存快照优先；冷启动由 downloads.js 回退磁盘副本）。
// `refresh` 强制走网络（绕过 60s 内存缓存），并带 `_ts` 抖动 —— hash-mismatch 后的复核闭环。
registerManifestSource('wallpaper', {
  snapshot: () => (foliaCache.items.length
    ? { items: foliaCache.items, base: foliaSiteBase() || '', at: foliaCache.at }
    : null),
  refresh: async () => {
    const r = await foliaRefresh(true);
    const items = Array.isArray(r && r.items) ? r.items : [];
    return items.length ? { items, base: foliaSiteBase() || '', at: Date.now() } : null;
  },
});

export { warmInventorySiteCache };
// 类型判定与条目构造导出**只为测试**（test/inventory-types.mjs）：它们是纯函数，
// 用它做判据比"起一个假站点再走 HTTP"稳定得多 —— 后者要伪造缓存目录与时点。
export { foliaTypeOfEntry, foliaItemFromCatalog };
export function registerInventoryRoutes(webServer, c) {
  const { disposers, base: BASE, mediaOriginApi, buildInventory, componentsProbe } = c;

  // 1. Inventory JSON.
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/inventory`,
    handler: async (req, res) => {
      try {
        mediaOriginApi.observeAdapter(req);   // 先观测再建库：媒体源起不起由本次请求的形态决定
        const payload = await buildInventory();
        // 查询参数（4.23.9）：`refresh=1` 强刷；`tag` / `subtag` 是标签筛选。
        // ⚠️ **故意没有 `category` 参数**：壁纸库恒只拉壁纸（承重闸门，见文件头），
        //    标签只在这个前提之内再筛一层。任何"按分类取货"的请求都不该从这里发出。
        let force = false;
        let filter = null;
        try {
          const sp = new URL(req.url || '/', 'http://x').searchParams;
          force = sp.get('refresh') === '1';
          const tag = String(sp.get('tag') || '').slice(0, 400);
          const subtag = String(sp.get('subtag') || '').slice(0, 400);
          if (tag || subtag) filter = { tag, subtag };
        } catch { /* URL 解析失败就当没传 */ }
        // 站点数据源：并进同一个壁纸库。失败/停用 ⇒ 原样返回本机库（本机功能永不受影响）。
        const { items: remote, status: siteSource, facets } = await foliaRemote(force, filter);
        const merged = remote.length
          ? {
            ...payload,
            wallpapers: [...(payload.wallpapers || []), ...remote],
            // 远程条目全部 `playable: true` ⇒ 两个计数各加一次，别让客户端看到"库里 20 张、可播放 4 张"。
            total: (payload.total || 0) + remote.length,
            portableCount: (payload.portableCount || 0) + remote.length,
          }
          : payload;
        // 站点源的**状态面**（无论成功失败都下发）：界面据此显示"站点 6 张"/"站点不可达（超时）"，
        // 而不是让用户对着空列表猜。字段缺席 = 更老的宿主 ⇒ 客户端按"不展示"处理。
        const withSite = siteSource ? { ...merged, siteSource } : merged;
        // `facets`（4.23.9）：站点聚合的分类/标签计数，面板「标签」下拉的唯一数据源。
        // 缺失就**不写**这个字段 —— 客户端据此回落"只有全部"，而不是把 undefined
        // 渲染成一个空下拉（那会看起来像"站点一张标签都没有"）。
        const withFacets = facets ? { ...withSite, facets } : withSite;
        // 组件行状态（只读，形状与失效口径见文件头「组件行状态」）：探针不可用时**不写**该字段 ——
        // 消费方据此按"可用"渲染，而不是把"探测失败"渲染成"组件都没了"。
        const components = rowStatusOf(componentsProbe);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(components ? { ...withFacets, components } : withFacets));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(err && err.message ? err.message : err) }));
      }
    },
  }));
}
