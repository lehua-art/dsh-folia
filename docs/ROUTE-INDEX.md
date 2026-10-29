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

共 **41** 条路由。

| # | 路径 | 来源 | 形态 | 依赖（闭包状态 / `c` 字段） | 守卫提及 |
|---|---|---|---|---|---|
| 1 | `/inventory` | lib/routes/inventory.js:479 | async 箭头 | disposers base mediaOriginApi buildInventory componentsProbe | 26 |
| 2 | `/modules` | lib/routes/modules.js:185 | async 箭头 | disposers base | **0** |
| 3 | `/boot/list` | lib/routes/boot.js:249 | async 箭头 | disposers base | 1 |
| 4 | `/boot/download` | lib/routes/boot.js:291 | async 箭头 | disposers base log | **0** |
| 5 | `/boot/select` | lib/routes/boot.js:332 | async 箭头 | disposers base log | 1 |
| 6 | `/boot/toggle` | lib/routes/boot.js:346 | async 箭头 | disposers base | 1 |
| 7 | `/boot/settings` | lib/routes/boot.js:362 | async 箭头 | disposers base | 1 |
| 8 | `/boot/remove` | lib/routes/boot.js:385 | async 箭头 | disposers base | 1 |
| 9 | `/boot/clip` | lib/routes/boot.js:399 | async 箭头 | disposers base | 1 |
| 10 | `/site-thumb` | lib/routes/site-thumb.js:65 | async 箭头 | disposers base ensureImagePreview log | **0** |
| 11 | `/media-info` | lib/routes/media-derived.js:60 | 箭头 | disposers base mediaMap log getMediaInfo faststartVariant …(+1) | 10 |
| 12 | `/transcode-progress` | lib/routes/media-derived.js:103 | 箭头 | disposers base mediaMap transcodeJobs | 2 |
| 13 | `/transcoded` | lib/routes/media-derived.js:156 | 箭头 | disposers base mediaMap serveFile transcodeToFps registerTranscodeWaiter | 1 |
| 14 | `/video-preview` | lib/routes/media-derived.js:215 | 箭头 | disposers base mediaMap serveFile generateVideoPreview | 2 |
| 15 | `/media` | lib/routes/media-bytes.js:39 | 箭头 | disposers base serveFile serveLayout mediaMap log …(+2) | 19 |
| 16 | `/preview` | lib/routes/media-bytes.js:39 | 箭头 | disposers base serveFile serveLayout mediaMap log …(+2) | 12 |
| 17 | `/scene-frame` | lib/routes/scene-frame.js:82 | 箭头 | disposers base mediaMap trackStream customFramePath customIdFromAbs …(+3) | 13 |
| 18 | `/scene-frame-cache` | lib/routes/scene-frame.js:168 | 箭头 | disposers base mediaMap GPU_FRAME_AREA_TOL GPU_FRAME_MAX_BYTES GPU_WRITE_INFLIGHT …(+7) | 5 |
| 19 | `/custom-frame` | lib/routes/scene-frame.js:272 | 箭头 | disposers base serveFile CUSTOM_FRAME_EXT CUSTOM_FRAME_MAX_BYTES armBodyIdleTimeout …(+3) | 3 |
| 20 | `/scene-live` | lib/routes/scene-serve.js:86 | 箭头 | disposers base WEBWALLGL_DIR WEBWALLGL_PKG_DIR appendDiagLine traceRequests …(+3) | 9 |
| 21 | `/scene-files` | lib/routes/scene-serve.js:153 | 箭头 | disposers base handleSceneFiles | 5 |
| 22 | `/media-origin` | lib/routes/scene-serve.js:161 | 箭头 | disposers base mediaOriginInfo | 1 |
| 23 | `/scene-payload-progress` | lib/routes/scene-serve.js:181 | 箭头 | disposers base payloadProgress | 1 |
| 24 | `/props` | lib/routes/props.js:45 | 箭头 | disposers base mediaMap userPropsFor | 7 |
| 25 | `/live-frame` | lib/routes/live-frame.js:44 | 箭头 | disposers base mediaMap serveFile traceRequests liveFrameFile …(+2) | 3 |
| 26 | `/occlusion` | lib/routes/occlusion.js:50 | async 箭头 | disposers base hub | 3 |
| 27 | `/client-diag` | lib/routes/diag.js:85 | 箭头 | disposers appendDiagLine notice base | 5 |
| 28 | `/diag` | lib/routes/diag.js:149 | 箭头 | disposers | 11 |
| 29 | `/diag` | lib/routes/diag.js:150 | 箭头 | disposers base | 11 |
| 30 | `/diag-log` | lib/routes/diag.js:151 | 箭头 | disposers log base componentsProbe | 3 |
| 31 | `/api/local-assets` | lib/routes/we-assets.js:69 | async 箭头 | disposers serveFile listWeAssetNames weAssetsAvailable WE_ASSETS_SOURCE_ID getWeAssetsDir | 1 |
| 32 | `/we-assets-dir` | lib/routes/we-assets.js:116 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES normalizeUserDir setWeAssetsDir listWeAssetNames …(+2) | 3 |
| 33 | `/scene-video` | lib/routes/scene-media.js:54 | 箭头 | disposers base mediaMap serveFile ensureFrameCacheDir sceneVideoProbeKey …(+3) | 3 |
| 34 | `/scene-audio` | lib/routes/scene-media.js:138 | 箭头 | disposers base mediaMap serveFile ensureSceneAudio | 4 |
| 35 | `/upload` | lib/routes/upload.js:72 | 箭头 | disposers base tokenFor UPLOAD_EXT UPLOAD_MAX_BYTES ensureUploadDir …(+6) | 4 |
| 36 | `/remove` | lib/routes/upload.js:222 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES ensureUploadDir removeUploadMeta resolveUploadFile …(+1) | 2 |
| 37 | `/upload-dir` | lib/routes/upload.js:279 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES setUploadDir normalizeUserDir armBodyIdleTimeout | 3 |
| 38 | `/glass-presets` | lib/routes/presets.js:502 | async 箭头 | disposers base | 1 |
| 39 | `/settings` | lib/routes/settings.js:158 | 箭头 | disposers base ctx mediaOriginApi readSettings isBetterSidebarLoaded …(+3) | 21 |
| 40 | `/cache-dir` | lib/routes/cache-dir.js:47 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES normalizeUserDir cacheBaseDir setCacheDir …(+1) | 1 |
| 41 | `/cache-dir/browse` | lib/routes/cache-dir.js:115 | 箭头 | disposers base normalizeUserDir | 1 |

**零提及（拆分前必须先补守卫）**：`/modules`、`/boot/download`、`/site-thumb`

**被最多路由引用的闭包状态（context 字段优先级，仅 `lib/index.js` 内的路由）**：



**路由模块的 context 契约**（声明了却没用到的字段单独标出 —— 那是死声明）：

| 模块 | 入口 | 路由数 | `c` 字段 | 死声明 |
|---|---|---|---|---|
| `lib/routes/boot.js` | `registerBootRoutes(webServer, c)` | 7 | `disposers` `base` `log` | — |
| `lib/routes/cache-dir.js` | `registerCacheDirRoutes(webServer, c)` | 2 | `disposers` `base` `CONTROL_JSON_MAX_BYTES` `normalizeUserDir` `cacheBaseDir` `setCacheDir` `armBodyIdleTimeout` | — |
| `lib/routes/diag.js` | `registerDiagRoutes(webServer, c)` | 4 | `disposers` `appendDiagLine` `log` `notice` `base` `onHandleDiag` `componentsProbe` | — |
| `lib/routes/inventory.js` | `registerInventoryRoutes(webServer, c)` | 1 | `disposers` `base` `mediaOriginApi` `buildInventory` `componentsProbe` | — |
| `lib/routes/live-frame.js` | `registerLiveFrameRoutes(webServer, c)` | 1 | `disposers` `base` `mediaMap` `serveFile` `traceRequests` `liveFrameFile` `atomicWriteFileSync` `lingerClose` | — |
| `lib/routes/media-bytes.js` | `registerMediaBytesRoutes(webServer, c)` | 2 | `disposers` `base` `serveFile` `serveLayout` `mediaMap` `log` `pinnedFaststartVariant` `ensureImagePreview` | — |
| `lib/routes/media-derived.js` | `registerMediaDerivedRoutes(webServer, c)` | 4 | `disposers` `base` `mediaMap` `serveFile` `log` `getMediaInfo` `faststartVariant` `transcodeJobs` `transcodeToFps` `registerTranscodeWaiter` `generateVideoPreview` `transcodeCached` | — |
| `lib/routes/modules.js` | `registerModulesRoutes(webServer, c)` | 1 | `disposers` `base` | — |
| `lib/routes/occlusion.js` | `registerOcclusionRoutes(webServer, c)` | 1 | `disposers` `base` `hub` `log` `diag` | — |
| `lib/routes/presets.js` | `registerGlassPresetsRoutes(webServer, c)` | 1 | `disposers` `base` | — |
| `lib/routes/props.js` | `registerPropsRoutes(webServer, c)` | 1 | `disposers` `base` `mediaMap` `userPropsFor` | — |
| `lib/routes/scene-frame.js` | `registerSceneFrameRoutes(webServer, c)` | 3 | `disposers` `base` `mediaMap` `trackStream` `serveFile` `GPU_FRAME_AREA_TOL` `GPU_FRAME_MAX_BYTES` `GPU_WRITE_INFLIGHT` `CUSTOM_FRAME_EXT` `CUSTOM_FRAME_MAX_BYTES` `armBodyIdleTimeout` `atomicWriteFileP` `customFrameDir` `customFramePath` `customIdFromAbs` `gpuFrameFileFor` `lingerClose` `looksLikePng` `pngDimsOfBuf` `pngSizeOf` `sceneFrameSlot` | — |
| `lib/routes/scene-media.js` | `registerSceneMediaRoutes(webServer, c)` | 2 | `disposers` `base` `mediaMap` `serveFile` `ensureFrameCacheDir` `sceneVideoProbeKey` `sceneVideoProbeSet` `atomicWriteFileP` `ensureSceneAudio` `SCENE_VIDEO_INFLIGHT` | — |
| `lib/routes/scene-serve.js` | `registerSceneServeRoutes(webServer, c)` | 4 | `disposers` `base` `WEBWALLGL_DIR` `WEBWALLGL_PKG_DIR` `appendDiagLine` `traceRequests` `serveFile` `handleSceneFiles` `mediaOriginInfo` `payloadProgress` `log` | — |
| `lib/routes/settings.js` | `registerSettingsRoutes(webServer, c)` | 1 | `disposers` `base` `ctx` `mediaOriginApi` `readSettings` `isBetterSidebarLoaded` `sanitizeSettings` `withLegacyFontValues` `mergeSettings` `armBodyIdleTimeout` `lingerClose` | — |
| `lib/routes/site-thumb.js` | `registerSiteThumbRoutes(webServer, c)` | 1 | `disposers` `base` `ensureImagePreview` `log` | — |
| `lib/routes/upload.js` | `registerUploadRoutes(webServer, c)` | 3 | `disposers` `base` `tokenFor` `UPLOAD_EXT` `UPLOAD_MAX_BYTES` `CONTROL_JSON_MAX_BYTES` `ensureUploadDir` `readUploadMeta` `metaEntry` `setUploadMeta` `removeUploadMeta` `resolveUploadFile` `setUploadDir` `normalizeUserDir` `armBodyIdleTimeout` `lingerClose` | — |
| `lib/routes/we-assets.js` | `registerWeAssetsRoutes(webServer, c)` | 2 | `disposers` `base` `serveFile` `CONTROL_JSON_MAX_BYTES` `normalizeUserDir` `setWeAssetsDir` `listWeAssetNames` `weAssetsAvailable` `WE_ASSETS_SOURCE_ID` `getWeAssetsDir` | — |

