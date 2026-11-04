# 宿主路由索引（P2-11 前置 1 · 自动生成，勿手改）

> 生成：`node test/tools/host-route-index.mjs --write`；核对：`node test/verify-route-index.mjs`
> （守卫会在索引与代码不一致时失败 —— 索引因此不会烂掉）。
>
> **依赖** = 该处理器块里引用到的 `apply` 作用域声明（缩进 ≤2）= **将来 context 对象的字段候选**；
> 同一列里反复出现的名字，就是该提出来的字段。拆成独立模块的族（`lib/routes/*.js` 或
> 组件目录里的实现文件）则列它的 **`c` 字段**。
> 循环里注册的路由（`for (const seg of [...])`）按**实际条数**逐条列出，不折叠成一行。
> 路径列省略 `${BASE}` 前缀；因此**看起来同名的两行**是同一路径同时挂了根路径与带前缀
> 两条注册（渲染页按根路径上报，只挂一条会静默 404）。**守卫提及**列的口径：该路由以
> 路由形状（尾边界，`/media` 不被 `/media-info` 误算）出现在几个守卫/冒烟文件的**代码**里；
> `lib/…`、`src/…`、`test/…` 这类**代码路径**先被遮掉 ⇒ 也不会被 `lib/media/mp4-probe.js`
> 这类源文件路径误算（提及 ≠ 有断言；零提及 = 拆前无安全网）。

共 **39** 条路由。

| # | 路径 | 来源 | 形态 | 依赖（闭包状态 / `c` 字段） | 守卫提及 |
|---|---|---|---|---|---|
| 1 | `/media-info` | lib/routes/media-derived.js:60 | 箭头 | disposers base mediaMap log getMediaInfo faststartVariant …(+1) | 10 |
| 2 | `/transcode-progress` | lib/routes/media-derived.js:103 | 箭头 | disposers base mediaMap transcodeJobs | 2 |
| 3 | `/transcoded` | lib/routes/media-derived.js:156 | 箭头 | disposers base mediaMap serveFile transcodeToFps registerTranscodeWaiter | 1 |
| 4 | `/video-preview` | lib/routes/media-derived.js:215 | 箭头 | disposers base mediaMap serveFile generateVideoPreview | 2 |
| 5 | `/media` | lib/routes/media-bytes.js:39 | 箭头 | disposers base serveFile serveLayout mediaMap log …(+2) | 30 |
| 6 | `/preview` | lib/routes/media-bytes.js:39 | 箭头 | disposers base serveFile serveLayout mediaMap log …(+2) | 12 |
| 7 | `/site-media-stats` | lib/routes/site-media.js:354 | 箭头 | disposers | 1 |
| 8 | `/site-media` | lib/routes/site-media.js:391 | async 箭头 | disposers serveFile | 1 |
| 9 | `/downloads/add` | lib/routes/downloads.js:145 | async 箭头 | disposers base | 2 |
| 10 | `/downloads/list` | lib/routes/downloads.js:214 | 箭头 | disposers | 4 |
| 11 | `/downloads/cancel` | lib/routes/downloads.js:227 | async 箭头 | disposers | **0** |
| 12 | `/local-media` | lib/routes/downloads.js:240 | 箭头 | disposers serveFile | **0** |
| 13 | `/kernel-info` | lib/routes/kernel.js:103 | 箭头 | disposers | **0** |
| 14 | `/kernel/enable-skin-center` | lib/routes/kernel.js:116 | 箭头 | disposers log | **0** |
| 15 | `/scene-frame` | lib/routes/scene-frame.js:82 | 箭头 | disposers base mediaMap trackStream customFramePath customIdFromAbs …(+3) | 13 |
| 16 | `/scene-frame-cache` | lib/routes/scene-frame.js:168 | 箭头 | disposers base mediaMap GPU_FRAME_AREA_TOL GPU_FRAME_MAX_BYTES GPU_WRITE_INFLIGHT …(+7) | 5 |
| 17 | `/custom-frame` | lib/routes/scene-frame.js:272 | 箭头 | disposers base serveFile CUSTOM_FRAME_EXT CUSTOM_FRAME_MAX_BYTES armBodyIdleTimeout …(+3) | 3 |
| 18 | `/scene-live` | lib/routes/scene-serve.js:86 | 箭头 | disposers base WEBWALLGL_DIR WEBWALLGL_PKG_DIR appendDiagLine traceRequests …(+3) | 9 |
| 19 | `/scene-files` | lib/routes/scene-serve.js:153 | 箭头 | disposers base handleSceneFiles | 5 |
| 20 | `/media-origin` | lib/routes/scene-serve.js:161 | 箭头 | disposers base mediaOriginInfo | 1 |
| 21 | `/scene-payload-progress` | lib/routes/scene-serve.js:181 | 箭头 | disposers base payloadProgress | 1 |
| 22 | `/props` | lib/routes/props.js:45 | 箭头 | disposers base mediaMap userPropsFor | 7 |
| 23 | `/live-frame` | lib/routes/live-frame.js:44 | 箭头 | disposers base mediaMap serveFile traceRequests liveFrameFile …(+2) | 3 |
| 24 | `/occlusion` | lib/routes/occlusion.js:50 | async 箭头 | disposers base hub | 3 |
| 25 | `/client-diag` | lib/routes/diag.js:85 | 箭头 | disposers appendDiagLine notice base | 5 |
| 26 | `/diag` | lib/routes/diag.js:149 | 箭头 | disposers | 11 |
| 27 | `/diag` | lib/routes/diag.js:150 | 箭头 | disposers base | 11 |
| 28 | `/diag-log` | lib/routes/diag.js:151 | 箭头 | disposers log base componentsProbe | 3 |
| 29 | `/api/local-assets` | lib/routes/we-assets.js:69 | async 箭头 | disposers serveFile listWeAssetNames weAssetsAvailable WE_ASSETS_SOURCE_ID getWeAssetsDir | 1 |
| 30 | `/we-assets-dir` | lib/routes/we-assets.js:116 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES normalizeUserDir setWeAssetsDir listWeAssetNames …(+2) | 3 |
| 31 | `/scene-video` | lib/routes/scene-media.js:54 | 箭头 | disposers base mediaMap serveFile ensureFrameCacheDir sceneVideoProbeKey …(+3) | 3 |
| 32 | `/scene-audio` | lib/routes/scene-media.js:138 | 箭头 | disposers base mediaMap serveFile ensureSceneAudio | 4 |
| 33 | `/upload` | lib/routes/upload.js:72 | 箭头 | disposers base tokenFor UPLOAD_EXT UPLOAD_MAX_BYTES ensureUploadDir …(+6) | 4 |
| 34 | `/remove` | lib/routes/upload.js:222 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES ensureUploadDir removeUploadMeta resolveUploadFile …(+1) | 6 |
| 35 | `/upload-dir` | lib/routes/upload.js:279 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES setUploadDir normalizeUserDir armBodyIdleTimeout | 3 |
| 36 | `/glass-presets` | lib/routes/presets.js:502 | async 箭头 | disposers base | 1 |
| 37 | `/settings` | lib/routes/settings.js:158 | 箭头 | disposers base ctx mediaOriginApi readSettings isBetterSidebarLoaded …(+3) | 22 |
| 38 | `/cache-dir` | lib/routes/cache-dir.js:47 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES normalizeUserDir cacheBaseDir setCacheDir …(+1) | 1 |
| 39 | `/cache-dir/browse` | lib/routes/cache-dir.js:115 | 箭头 | disposers base normalizeUserDir | 1 |

**零提及（拆分前必须先补守卫）**：`/downloads/cancel`、`/local-media`、`/kernel-info`、`/kernel/enable-skin-center`

**被最多路由引用的闭包状态（context 字段优先级，仅 `lib/index.js` 内的路由）**：



**路由模块的 context 契约**（声明了却没用到的字段单独标出 —— 那是死声明）：

| 模块 | 入口 | 路由数 | `c` 字段 | 死声明 |
|---|---|---|---|---|
| `lib/routes/boot.js` | `registerBootRoutes(webServer, c)` | 7 | `disposers` `base` `log` | — |
| `lib/routes/cache-dir.js` | `registerCacheDirRoutes(webServer, c)` | 2 | `disposers` `base` `CONTROL_JSON_MAX_BYTES` `normalizeUserDir` `cacheBaseDir` `setCacheDir` `armBodyIdleTimeout` | — |
| `lib/routes/cache.js` | `isWithin(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `scanTree(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `clearTree(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `cacheUsage(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `pruneDoneJobs(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `clearCache(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `registerCacheRoutes(webServer, c)` | 2 | `disposers` `base` `log` | — |
| `lib/routes/diag.js` | `registerDiagRoutes(webServer, c)` | 4 | `disposers` `appendDiagLine` `log` `notice` `base` `onHandleDiag` `componentsProbe` | — |
| `lib/routes/downloads.js` | `getDownloadQueue(webServer, c)` | 4 | — | — |
| `lib/routes/downloads.js` | `installStallMs(webServer, c)` | 4 | — | — |
| `lib/routes/downloads.js` | `localCopyFor(webServer, c)` | 4 | — | — |
| `lib/routes/downloads.js` | `isSlowHostUrl(webServer, c)` | 4 | — | — |
| `lib/routes/downloads.js` | `queueJobFor(webServer, c)` | 4 | — | — |
| `lib/routes/downloads.js` | `queueSummary(webServer, c)` | 4 | — | — |
| `lib/routes/downloads.js` | `registerDownloadsRoutes(webServer, c)` | 4 | `disposers` `base` `serveFile` `log` | — |
| `lib/routes/inventory.js` | `registerInventoryRoutes(webServer, c)` | 1 | `disposers` `base` `mediaOriginApi` `buildInventory` `componentsProbe` | — |
| `lib/routes/kernel.js` | `kernelInfo(webServer, c)` | 2 | — | — |
| `lib/routes/kernel.js` | `registerKernelRoutes(webServer, c)` | 2 | `disposers` `base` `log` | — |
| `lib/routes/live-frame.js` | `registerLiveFrameRoutes(webServer, c)` | 1 | `disposers` `base` `mediaMap` `serveFile` `traceRequests` `liveFrameFile` `atomicWriteFileSync` `lingerClose` | — |
| `lib/routes/media-bytes.js` | `registerMediaBytesRoutes(webServer, c)` | 2 | `disposers` `base` `serveFile` `serveLayout` `mediaMap` `log` `pinnedFaststartVariant` `ensureImagePreview` | — |
| `lib/routes/media-derived.js` | `registerMediaDerivedRoutes(webServer, c)` | 4 | `disposers` `base` `mediaMap` `serveFile` `log` `getMediaInfo` `faststartVariant` `transcodeJobs` `transcodeToFps` `registerTranscodeWaiter` `generateVideoPreview` `transcodeCached` | — |
| `lib/routes/modules.js` | `registerModulesRoutes(webServer, c)` | 1 | `disposers` `base` | — |
| `lib/routes/occlusion.js` | `registerOcclusionRoutes(webServer, c)` | 1 | `disposers` `base` `hub` `log` `diag` | — |
| `lib/routes/pets.js` | `registerPetsRoutes(webServer, c)` | 8 | `disposers` `base` `log` | — |
| `lib/routes/presets.js` | `registerGlassPresetsRoutes(webServer, c)` | 1 | `disposers` `base` | — |
| `lib/routes/props.js` | `registerPropsRoutes(webServer, c)` | 1 | `disposers` `base` `mediaMap` `userPropsFor` | — |
| `lib/routes/scene-frame.js` | `registerSceneFrameRoutes(webServer, c)` | 3 | `disposers` `base` `mediaMap` `trackStream` `serveFile` `GPU_FRAME_AREA_TOL` `GPU_FRAME_MAX_BYTES` `GPU_WRITE_INFLIGHT` `CUSTOM_FRAME_EXT` `CUSTOM_FRAME_MAX_BYTES` `armBodyIdleTimeout` `atomicWriteFileP` `customFrameDir` `customFramePath` `customIdFromAbs` `gpuFrameFileFor` `lingerClose` `looksLikePng` `pngDimsOfBuf` `pngSizeOf` `sceneFrameSlot` | — |
| `lib/routes/scene-media.js` | `registerSceneMediaRoutes(webServer, c)` | 2 | `disposers` `base` `mediaMap` `serveFile` `ensureFrameCacheDir` `sceneVideoProbeKey` `sceneVideoProbeSet` `atomicWriteFileP` `ensureSceneAudio` `SCENE_VIDEO_INFLIGHT` | — |
| `lib/routes/scene-serve.js` | `registerSceneServeRoutes(webServer, c)` | 4 | `disposers` `base` `WEBWALLGL_DIR` `WEBWALLGL_PKG_DIR` `appendDiagLine` `traceRequests` `serveFile` `handleSceneFiles` `mediaOriginInfo` `payloadProgress` `log` | — |
| `lib/routes/settings.js` | `registerSettingsRoutes(webServer, c)` | 1 | `disposers` `base` `ctx` `mediaOriginApi` `readSettings` `isBetterSidebarLoaded` `sanitizeSettings` `withLegacyFontValues` `mergeSettings` `armBodyIdleTimeout` `lingerClose` | — |
| `lib/routes/site-media.js` | `registerSiteMediaRoutes(webServer, c)` | 2 | `disposers` `base` `serveFile` `log` | — |
| `lib/routes/site-thumb.js` | `registerSiteThumbRoutes(webServer, c)` | 1 | `disposers` `base` `ensureImagePreview` `log` | — |
| `lib/routes/skins.js` | `installGateTry(webServer, c)` | 6 | — | — |
| `lib/routes/skins.js` | `installGateMarkDone(webServer, c)` | 6 | — | — |
| `lib/routes/skins.js` | `installGateRelease(webServer, c)` | 6 | — | — |
| `lib/routes/skins.js` | `registerSkinsRoutes(webServer, c)` | 6 | `disposers` `base` `log` | — |
| `lib/routes/upload.js` | `registerUploadRoutes(webServer, c)` | 3 | `disposers` `base` `tokenFor` `UPLOAD_EXT` `UPLOAD_MAX_BYTES` `CONTROL_JSON_MAX_BYTES` `ensureUploadDir` `readUploadMeta` `metaEntry` `setUploadMeta` `removeUploadMeta` `resolveUploadFile` `setUploadDir` `normalizeUserDir` `armBodyIdleTimeout` `lingerClose` | — |
| `lib/routes/we-assets.js` | `registerWeAssetsRoutes(webServer, c)` | 2 | `disposers` `base` `serveFile` `CONTROL_JSON_MAX_BYTES` `normalizeUserDir` `setWeAssetsDir` `listWeAssetNames` `weAssetsAvailable` `WE_ASSETS_SOURCE_ID` `getWeAssetsDir` | — |

