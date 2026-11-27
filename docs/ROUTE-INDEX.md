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

共 **49** 条路由。

| # | 路径 | 来源 | 形态 | 依赖（闭包状态 / `c` 字段） | 守卫提及 |
|---|---|---|---|---|---|
| 1 | `(动态路径)` | lib/routes/personas.js:900 | async 箭头 | — | 2 |
| 2 | `/media-info` | lib/routes/media-derived.js:60 | 箭头 | disposers base mediaMap log getMediaInfo faststartVariant …(+1) | 10 |
| 3 | `/transcode-progress` | lib/routes/media-derived.js:103 | 箭头 | disposers base mediaMap transcodeJobs | 2 |
| 4 | `/transcoded` | lib/routes/media-derived.js:156 | 箭头 | disposers base mediaMap serveFile transcodeToFps registerTranscodeWaiter | 1 |
| 5 | `/video-preview` | lib/routes/media-derived.js:215 | 箭头 | disposers base mediaMap serveFile generateVideoPreview | 2 |
| 6 | `/media` | lib/routes/media-bytes.js:39 | 箭头 | disposers base serveFile serveLayout mediaMap log …(+2) | 36 |
| 7 | `/preview` | lib/routes/media-bytes.js:39 | 箭头 | disposers base serveFile serveLayout mediaMap log …(+2) | 15 |
| 8 | `/site-media-stats` | lib/routes/site-media.js:459 | 箭头 | disposers | 1 |
| 9 | `/site-media` | lib/routes/site-media.js:496 | async 箭头 | disposers serveFile | 8 |
| 10 | `/downloads/add` | lib/routes/downloads.js:568 | async 箭头 | disposers base | 8 |
| 11 | `/downloads/list` | lib/routes/downloads.js:679 | 箭头 | disposers | 13 |
| 12 | `/downloads/cancel` | lib/routes/downloads.js:727 | async 箭头 | disposers | **0** |
| 13 | `/downloads/priority` | lib/routes/downloads.js:748 | async 箭头 | disposers | 2 |
| 14 | `/downloads/pause` | lib/routes/downloads.js:782 | async 箭头 | disposers | **0** |
| 15 | `/downloads/requeue` | lib/routes/downloads.js:801 | async 箭头 | disposers log | 3 |
| 16 | `/diag/media-state` | lib/routes/downloads.js:830 | 箭头 | disposers | 4 |
| 17 | `/downloads/clear-queued` | lib/routes/downloads.js:860 | 箭头 | disposers | **0** |
| 18 | `/local-media` | lib/routes/downloads.js:873 | 箭头 | disposers serveFile transcodePlayablePathFor | 9 |
| 19 | `/local-heal` | lib/routes/downloads.js:934 | async 箭头 | disposers base log | **0** |
| 20 | `/local-check` | lib/routes/downloads.js:961 | 箭头 | disposers | **0** |
| 21 | `/local-verify` | lib/routes/downloads.js:971 | async 箭头 | disposers | **0** |
| 22 | `/kernel-info` | lib/routes/kernel.js:103 | 箭头 | disposers | **0** |
| 23 | `/kernel/enable-skin-center` | lib/routes/kernel.js:116 | 箭头 | disposers log | **0** |
| 24 | `/scene-frame` | lib/routes/scene-frame.js:82 | 箭头 | disposers base mediaMap trackStream customFramePath customIdFromAbs …(+3) | 13 |
| 25 | `/scene-frame-cache` | lib/routes/scene-frame.js:168 | 箭头 | disposers base mediaMap GPU_FRAME_AREA_TOL GPU_FRAME_MAX_BYTES GPU_WRITE_INFLIGHT …(+7) | 5 |
| 26 | `/custom-frame` | lib/routes/scene-frame.js:272 | 箭头 | disposers base serveFile CUSTOM_FRAME_EXT CUSTOM_FRAME_MAX_BYTES armBodyIdleTimeout …(+3) | 3 |
| 27 | `/scene-live` | lib/routes/scene-serve.js:86 | 箭头 | disposers base WEBWALLGL_DIR WEBWALLGL_PKG_DIR appendDiagLine traceRequests …(+3) | 9 |
| 28 | `/scene-files` | lib/routes/scene-serve.js:153 | 箭头 | disposers base handleSceneFiles | 5 |
| 29 | `/media-origin` | lib/routes/scene-serve.js:161 | 箭头 | disposers base mediaOriginInfo | 1 |
| 30 | `/scene-payload-progress` | lib/routes/scene-serve.js:181 | 箭头 | disposers base payloadProgress | 1 |
| 31 | `/props` | lib/routes/props.js:45 | 箭头 | disposers base mediaMap userPropsFor | 7 |
| 32 | `/live-frame` | lib/routes/live-frame.js:44 | 箭头 | disposers base mediaMap serveFile traceRequests liveFrameFile …(+2) | 3 |
| 33 | `/occlusion` | lib/routes/occlusion.js:50 | async 箭头 | disposers base hub | 3 |
| 34 | `/client-diag` | lib/routes/diag.js:85 | 箭头 | disposers appendDiagLine notice base | 5 |
| 35 | `/diag` | lib/routes/diag.js:149 | 箭头 | disposers | 17 |
| 36 | `/diag` | lib/routes/diag.js:150 | 箭头 | disposers base | 17 |
| 37 | `/diag-log` | lib/routes/diag.js:151 | 箭头 | disposers log base componentsProbe | 3 |
| 38 | `/diag/switch-stats` | lib/routes/diag.js:174 | 箭头 | disposers base | 2 |
| 39 | `/api/local-assets` | lib/routes/we-assets.js:69 | async 箭头 | disposers serveFile listWeAssetNames weAssetsAvailable WE_ASSETS_SOURCE_ID getWeAssetsDir | 1 |
| 40 | `/we-assets-dir` | lib/routes/we-assets.js:116 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES normalizeUserDir setWeAssetsDir listWeAssetNames …(+2) | 4 |
| 41 | `/scene-video` | lib/routes/scene-media.js:54 | 箭头 | disposers base mediaMap serveFile ensureFrameCacheDir sceneVideoProbeKey …(+3) | 3 |
| 42 | `/scene-audio` | lib/routes/scene-media.js:138 | 箭头 | disposers base mediaMap serveFile ensureSceneAudio | 4 |
| 43 | `/upload` | lib/routes/upload.js:72 | 箭头 | disposers base tokenFor UPLOAD_EXT UPLOAD_MAX_BYTES ensureUploadDir …(+6) | 5 |
| 44 | `/remove` | lib/routes/upload.js:222 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES ensureUploadDir removeUploadMeta resolveUploadFile …(+1) | 6 |
| 45 | `/upload-dir` | lib/routes/upload.js:279 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES setUploadDir normalizeUserDir armBodyIdleTimeout | 3 |
| 46 | `/glass-presets` | lib/routes/presets.js:502 | async 箭头 | disposers base | 1 |
| 47 | `/settings` | lib/routes/settings.js:158 | 箭头 | disposers base ctx mediaOriginApi readSettings isBetterSidebarLoaded …(+3) | 22 |
| 48 | `/cache-dir` | lib/routes/cache-dir.js:47 | 箭头 | disposers base CONTROL_JSON_MAX_BYTES normalizeUserDir cacheBaseDir setCacheDir …(+1) | 1 |
| 49 | `/cache-dir/browse` | lib/routes/cache-dir.js:115 | 箭头 | disposers base normalizeUserDir | 1 |

**零提及（拆分前必须先补守卫）**：`/downloads/cancel`、`/downloads/pause`、`/downloads/clear-queued`、`/local-heal`、`/local-check`、`/local-verify`、`/kernel-info`、`/kernel/enable-skin-center`

**被最多路由引用的闭包状态（context 字段优先级，仅 `lib/index.js` 内的路由）**：



**路由模块的 context 契约**（声明了却没用到的字段单独标出 —— 那是死声明）：

| 模块 | 入口 | 路由数 | `c` 字段 | 死声明 |
|---|---|---|---|---|
| `lib/routes/boot.js` | `registerBootRoutes(webServer, c)` | 9 | `disposers` `base` `log` | — |
| `lib/routes/cache-dir.js` | `registerCacheDirRoutes(webServer, c)` | 2 | `disposers` `base` `CONTROL_JSON_MAX_BYTES` `normalizeUserDir` `cacheBaseDir` `setCacheDir` `armBodyIdleTimeout` | — |
| `lib/routes/cache.js` | `isWithin(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `scanTree(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `clearTree(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `cacheUsage(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `pruneDoneJobs(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `clearCache(webServer, c)` | 2 | — | — |
| `lib/routes/cache.js` | `registerCacheRoutes(webServer, c)` | 2 | `disposers` `base` `log` | — |
| `lib/routes/diag.js` | `registerDiagRoutes(webServer, c)` | 5 | `disposers` `appendDiagLine` `log` `notice` `base` `onHandleDiag` `componentsProbe` | — |
| `lib/routes/downloads.js` | `registerManifestSource(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `resetQueuedDoneForKinds(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `getMediaReconciler(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `__resetMediaSingletons(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `getDownloadQueue(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `getMediaSelfHeal(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `installStallMs(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `prefetchCount(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `destForUrl(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `localCopyFor(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `localFamilyCopyFor(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `mediaStateOfUrl(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `isSlowHostUrl(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `queueJobFor(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `jobStateForItem(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `queueSummary(webServer, c)` | 12 | — | — |
| `lib/routes/downloads.js` | `registerDownloadsRoutes(webServer, c)` | 12 | `disposers` `base` `serveFile` `log` `transcodeToPlayable` `transcodePlayablePathFor` `transcodePlayableProgress` | — |
| `lib/routes/inventory.js` | `inventoryEpoch(webServer, c)` | 1 | — | — |
| `lib/routes/inventory.js` | `invalidateSiteCache(webServer, c)` | 1 | — | — |
| `lib/routes/inventory.js` | `registerInventoryRoutes(webServer, c)` | 1 | `disposers` `base` `mediaOriginApi` `buildInventory` `componentsProbe` | — |
| `lib/routes/kernel.js` | `kernelInfo(webServer, c)` | 2 | — | — |
| `lib/routes/kernel.js` | `registerKernelRoutes(webServer, c)` | 2 | `disposers` `base` `log` | — |
| `lib/routes/live-frame.js` | `registerLiveFrameRoutes(webServer, c)` | 1 | `disposers` `base` `mediaMap` `serveFile` `traceRequests` `liveFrameFile` `atomicWriteFileSync` `lingerClose` | — |
| `lib/routes/media-bytes.js` | `registerMediaBytesRoutes(webServer, c)` | 2 | `disposers` `base` `serveFile` `serveLayout` `mediaMap` `log` `pinnedFaststartVariant` `ensureImagePreview` | — |
| `lib/routes/media-derived.js` | `registerMediaDerivedRoutes(webServer, c)` | 4 | `disposers` `base` `mediaMap` `serveFile` `log` `getMediaInfo` `faststartVariant` `transcodeJobs` `transcodeToFps` `registerTranscodeWaiter` `generateVideoPreview` `transcodeCached` | — |
| `lib/routes/modules.js` | `registerModulesRoutes(webServer, c)` | 1 | `disposers` `base` | — |
| `lib/routes/occlusion.js` | `registerOcclusionRoutes(webServer, c)` | 1 | `disposers` `base` `hub` `log` `diag` | — |
| `lib/routes/personas.js` | `createPersonaApi(webServer, c)` | 1 | — | — |
| `lib/routes/personas.js` | `normalizeCardForTest(webServer, c)` | 1 | — | — |
| `lib/routes/personas.js` | `registerPersonaRoutes(webServer, c)` | 1 | `readSettings` `log` | `base` `disposers` |
| `lib/routes/pet-chat.js` | `wavSeconds(webServer, c)` | 1 | — | — |
| `lib/routes/pet-chat.js` | `decodeBase64(webServer, c)` | 1 | — | — |
| `lib/routes/pet-chat.js` | `parseReplyText(webServer, c)` | 1 | — | — |
| `lib/routes/pet-chat.js` | `emotionFromKeywords(webServer, c)` | 1 | — | — |
| `lib/routes/pet-chat.js` | `registerPetChatRoutes(webServer, c)` | 1 | `disposers` `base` `log` `readSettings` `speechToText` `tts` `ffmpegEnsure` `ffmpegStatus` `clock` | `// v5 §4：DSH 服务面（可选）。宿主的 ctx.skills/tools 若能传进来就走服务，
    // 传不进来就退到文件面（~/.dsh/skills + 随包 office-skills）——两条都实现，不假装。
    services` |
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

