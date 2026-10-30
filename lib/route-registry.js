/**
 * lib/route-registry.js — **功能路由注册表**（宿主侧）。
 *
 * 为什么要它：`lib/index.js` 过去逐个 `registerXxxRoutes(webServer, {…})`，加一个功能就得
 * 在那个 400 行装配文件里挑一处插进去，并保证依赖对象拼对。客户端已经收口成注册表
 * （`src/features.js`），宿主侧对称过来，装配点就只剩一次循环。
 *
 * 纪律（由 `test/verify-route-registry.mjs` 机器校验）：
 *   · 本表里写出的族**必须在** `lib/routes/` 里真实存在，且 `deps` 只从传入的上下文取键；
 *   · `INLINE_ROUTE_FAMILIES` 是**尚未迁移**的族（大依赖：mediaMap / hub / 转码器等），
 *     它是**棘轮**：只许缩小 —— 迁一个删一个，不许往回调；
 *   · 两表并集必须覆盖 `lib/routes/*.js`（不许有第三处偷偷注册的族）。
 *
 * 迁移一个族的步骤：把 `lib/index.js` 里那段调用删掉 → 在 `FEATURE_ROUTE_FAMILIES` 加一条 →
 * 从 `INLINE_ROUTE_FAMILIES` 删掉 → 跑守卫。
 */

import { registerInventoryRoutes, warmInventorySiteCache } from './routes/inventory.js';
import { registerModulesRoutes, warmModulesCache } from './routes/modules.js';
import { registerBootRoutes } from './routes/boot.js';
import { registerSiteThumbRoutes } from './routes/site-thumb.js';
import { registerSkinsRoutes } from './routes/skins.js';
import { registerPetsRoutes } from './routes/pets.js';

/**
 * 已迁移的功能族。
 *
 * `deps(c)` 只从上下文取键 —— 这样"某个族需要什么"是**声明式**的，装配点不需要知道。
 * 上下文由门面按需提供（见 lib/index.js 的 `registerFeatureRoutes(webServer, { … })`）。
 *
 * @type {{ id: string, file: string, register: Function, deps: (c: any) => any, warm?: Function }[]}
 */
export const FEATURE_ROUTE_FAMILIES = [
  {
    id: 'inventory',
    file: 'lib/routes/inventory.js',
    register: registerInventoryRoutes,
    // 清单族需要"本机清单构建器 + 组件行状态探针 + 媒体源访问器"：三者都是门面现算的，
    // 所以只能由调用方传进来（族自己拿不到）。
    deps: (c) => ({
      disposers: c.disposers,
      base: c.base,
      mediaOriginApi: c.mediaOriginApi,
      buildInventory: c.buildInventory,
      componentsProbe: c.componentProbe,
    }),
    warm: warmInventorySiteCache,
  },
  {
    id: 'modules',
    file: 'lib/routes/modules.js',
    register: registerModulesRoutes,
    deps: (c) => ({ disposers: c.disposers, base: c.base }),
    warm: warmModulesCache,
  },
  {
    id: 'boot',
    file: 'lib/routes/boot.js',
    register: registerBootRoutes,
    deps: (c) => ({ disposers: c.disposers, base: c.base, log: c.log }),
  },
  {
    id: 'site-thumb',
    file: 'lib/routes/site-thumb.js',
    register: registerSiteThumbRoutes,
    // 缩略图复用内核的 ffmpeg 套件（ensureImagePreview），不自己 spawn。
    deps: (c) => ({ disposers: c.disposers, base: c.base, ensureImagePreview: c.ensureImagePreview, log: c.log }),
  },
  {
    id: 'pets',
    file: 'lib/routes/pets.js',
    register: registerPetsRoutes,
    deps: (c) => ({ disposers: c.disposers, base: c.base, log: c.log }),
  },
  {
    id: 'skins',
    file: 'lib/routes/skins.js',
    register: registerSkinsRoutes,
    // 皮肤安装目标是 $DSH_HOME/skins（皮肤中心读同一个目录）：由路由自己按 DSH_HOME 解析，
    // 不额外引入注入面 —— 少一处注入，就少一种"改了目录却没生效"的可能。
    deps: (c) => ({ disposers: c.disposers, base: c.base, log: c.log }),
  },
];

/**
 * **尚未迁移**的族（棘轮：只许缩小）。
 *
 * 为什么留在门面里：它们的依赖是内核的活对象（mediaMap / occlusionHub / transcodeKit /
 * sceneFrameSlot / uploadStoreKit …），搬进本表需要把那些对象也传进来，属于另一轮改动。
 * 这张清单存在的意义是**把"还剩多少"写下来**，守卫据此防止有人往回调。
 */
export const INLINE_ROUTE_FAMILIES = [
  // 每条写「族 id + 门面里的注册函数名」：两者**不总同形**（presets → registerGlassPresetsRoutes），
  // 靠名字猜会在守卫里制造假红。迁移一个族 = 在 FEATURE_ROUTE_FAMILIES 加一条 + 删这里一行。
  { id: 'site-media', fn: 'registerSiteMediaRoutes' },
  { id: 'media-bytes', fn: 'registerMediaBytesRoutes' },
  { id: 'media-derived', fn: 'registerMediaDerivedRoutes' },
  { id: 'scene-frame', fn: 'registerSceneFrameRoutes' },
  { id: 'scene-serve', fn: 'registerSceneServeRoutes' },
  { id: 'scene-media', fn: 'registerSceneMediaRoutes' },
  { id: 'live-frame', fn: 'registerLiveFrameRoutes' },
  { id: 'props', fn: 'registerPropsRoutes' },
  { id: 'occlusion', fn: 'registerOcclusionRoutes' },
  { id: 'diag', fn: 'registerDiagRoutes' },
  { id: 'we-assets', fn: 'registerWeAssetsRoutes' },
  { id: 'upload', fn: 'registerUploadRoutes' },
  { id: 'presets', fn: 'registerGlassPresetsRoutes' },
  { id: 'settings', fn: 'registerSettingsRoutes' },
  { id: 'cache-dir', fn: 'registerCacheDirRoutes' },
];

/** 按注册表挂载全部已迁移族；`warm` 钩子显式调用（预热是有意不阻塞的）。 */
export function registerFeatureRoutes(webServer, ctx) {
  for (const fam of FEATURE_ROUTE_FAMILIES) {
    fam.register(webServer, fam.deps(ctx));
  }
}

/** 启动预热（站点清单与模块索引各拉一次）。失败静默 —— 预热只是优化。 */
export function warmFeatureCaches() {
  for (const fam of FEATURE_ROUTE_FAMILIES) {
    if (typeof fam.warm !== 'function') continue;
    try { fam.warm(); } catch { /* 预热失败不影响启动 */ }
  }
}
