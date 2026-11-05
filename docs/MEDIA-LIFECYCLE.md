# 本地副本生命周期（MEDIA-LIFECYCLE）

> 归属：`lib/media-state.js`（状态模型 + 对账器）、`src/media-state.js`（客户端同一套判据）。
> 判据门禁：`test/verify-media-state.mjs`（矩阵 + 源码扫描 + 负对照）、
> `test/verify-media-chaos.mjs`（混沌 100 轮）、`test/verify-local-media-heal.mjs`（404/清缓存链路）。
>
> **本文是"这份本地副本现在能不能播"的合同**：状态、播放源、用户可见文案，三者一一对应。
> 任何模块想自己回答这个问题（`job.status === 'done'` / `mediaProxy || media`），都算违规 ——
> 绕过清单见第 5 节。

---

## 1. 状态定义（13 行）

| # | 状态 | 判定依据（唯一产地） | 允许的播放源 | 允许的用户可见文案 | 测试 id |
|---|------|----------------------|--------------|--------------------|---------|
| 1 | `none` 无记录 | 队列里没有这条 URL 的 job | `proxy`（站点流） | 无（点击才入队） | M1 / ch-none |
| 2 | `pending` 未缓存 | `job.status=pending`，或 done 但缺文件经对账降级 | `proxy` | 「未缓存」/ 点击后「缓存中 0%」 | M2 / ch-pending |
| 3 | `queued` 排队中 | `job.status=queued`，未开始取任务 | `proxy` | 「排队中：前面还有 {n} 个任务」 | M3 / ch-queued |
| 4 | `downloading` 下载中 | `job.status=running` 且 `0 < received < total` | `proxy`（**绝不用 `.part`**） | 「缓存中 {percent}%」/「已缓存」只在完成后 | M4 / C2 / ch-downloading |
| 5 | `downloading-blocked` 队列暂停 | `paused=true` 且有 queued/running | `proxy` | 「已暂停全部下载」 | M5 / ch-paused |
| 6 | `verifying` 校验中 | 下载收尾的 `hashVerified` 未落定（长度/区间/sha 三层） | `proxy` | 「校验中…」/ 不开播本地 | M6 / ch-verifying |
| 7 | `complete-valid` 完整且有效 | `job.status=done` **且** `fileExists` **且** `fileValid`（长度 + mp4 结构 / ≤20MB sha） | **`local`（唯一允许）** | 「已缓存」；切换时「已切换到本地副本」 | M7 / ch-valid / selfheal G2 |
| 8 | `complete-invalid` 内容坏 | done + 文件在，但结构/sha/长度不符 | `proxy` | 「文件已损坏，已重新下载」 | M8 / ch-invalid / selfheal A3 |
| 9 | `missing` 记录在文件没了 | done + `fileExists=false`（外部清理 / 清空媒体 / 4.23.18 遗留） | `proxy` | 「本地副本已丢失，正在重新下载」 | M9 / C1 / ch-missing / heal B |
| 10 | `failed-net` 链路失败 | `job.status=failed`，`error` 非 hash/decode | `proxy` | 「下载/安装失败：{code}」 | M10 / ch-failed-net |
| 11 | `failed-hash` 内容与站点不一致 | failed + `error` 以 `hash-mismatch` 开头 | `proxy` | 「传输内容与站点不一致」 | M11 / ch-failed-hash |
| 12 | `failed-decode` 本机解不了 | failed/标记 `decodeUnsupported`，内容本身正确 | `proxy`（或 1080p / 转码产物） | 「本机不支持该编码（可换一张跳过此壁纸）」 | M12 / selfheal G6 |
| 13 | `cleared` 清缓存后 | `POST /cache/clear` 同一事务：删文件 + `resetJobs>0` | `proxy` | 「已清理 {name}… · 重置 {jobs} 条下载记录」 | M13 / C3 / heal C |

**唯一判据**：`state.jobStatus === 'done' && state.fileExists === true && state.fileValid === true`
⇒ `resolvePlaySrc()` 才返回 `/folia/local-media/<jobId>`；其它 12 个状态**一律**返回站点流。
（客户端同名函数同一判据，见 `src/media-state.js`。）

---

## 2. 状态 × 事件矩阵（13 行 × 10 列）

单元格 = `下一状态（播放源）`。`P` = `proxy`，`L` = `local`。

| 状态 \ 事件 | 点击 | 切走 | 切回 | 下载完成 | 校验失败 | 删文件 | 清缓存 | 重启 | 队列暂停 | 恢复 |
|---|---|---|---|---|---|---|---|---|---|---|
| none | pending/P（入队） | none/P | none/P | — | — | — | none/P | none/P | none/P | none/P |
| pending | queued/P | pending/P | pending/P | — | — | pending/P | cleared/P | pending/P | pending/P | pending/P |
| queued | queued/P（提权） | queued/P | queued/P | — | — | pending/P | cleared/P | pending/P | downloading-blocked/P | queued/P |
| downloading | queued/P（提权） | downloading/P | downloading/P | **complete-valid/L** | failed-hash/P | pending/P | cleared/P | pending/P | downloading-blocked/P | downloading/P |
| downloading-blocked | queued/P | downloading-blocked/P | downloading-blocked/P | — | failed-hash/P | pending/P | cleared/P | pending/P | downloading-blocked/P | queued/P |
| verifying | queued/P | verifying/P | verifying/P | **complete-valid/L** 或 complete-invalid/P | failed-hash/P | pending/P | cleared/P | pending/P | downloading-blocked/P | verifying/P |
| complete-valid | complete-valid/L | complete-valid/L | complete-valid/L | — | complete-invalid/P | **missing/P** | **cleared/P** | complete-valid/L | complete-valid/L | complete-valid/L |
| complete-invalid | queued/P（重下） | complete-invalid/P | complete-invalid/P | — | complete-invalid/P | missing/P | cleared/P | pending/P（对账删文件） | complete-invalid/P | complete-invalid/P |
| missing | queued/P（重下） | missing/P | missing/P | — | — | missing/P | cleared/P | pending/P（对账） | missing/P | missing/P |
| failed-net | queued/P（重试） | failed-net/P | failed-net/P | complete-valid/L | — | failed-net/P | cleared/P | failed-net/P | failed-net/P | failed-net/P |
| failed-hash | queued/P（单流重下） | failed-hash/P | failed-hash/P | complete-valid/L | failed-hash/P | failed-hash/P | cleared/P | failed-hash/P | failed-hash/P | failed-hash/P |
| failed-decode | queued/P（换 1080p） | failed-decode/P | failed-decode/P | complete-valid/L（变体） | — | failed-decode/P | cleared/P | failed-decode/P | failed-decode/P | failed-decode/P |
| cleared | pending/P | cleared/P | cleared/P | — | — | cleared/P | cleared/P | pending/P | cleared/P | cleared/P |

**读法（三条硬规则）**
1. 只有 `complete-valid` 那一行出现 `L`。任何其它单元格出现 `L` 都是 bug（I2）。
2. 下载中（`downloading` / `downloading-blocked` / `verifying`）**任何事件**都不产生 `L`（I3）。
3. `重启`列没有 `L`：启动对账先取证据，再决定；4.23.18 的 `pending` 保留（不占队列）。

---

## 3. 失败文案矩阵（15 条，每条都有测试）

| # | 触发条件 | 文案（zh） | 出现在 | 测试 |
|---|----------|------------|--------|------|
| 1 | `running`，`received<total` | 缓存中 {percent}% | 卡片/标题栏 | verify-wallpaper-progress |
| 2 | `queued`，`queuedAhead>=0` | 排队中：前面还有 {n} 个任务 | 卡片/标题栏 | verify-queue-priority |
| 3 | `complete-valid` | 已缓存 | 卡片/标题栏 | verify-wallpaper-progress |
| 4 | 本地 404/410（HEAD 判定） | 本地副本已丢失，正在重新下载 | 面板提示位 | M9 / heal D8 |
| 5 | 同上但无站点代理（本机上传） | 本地副本已丢失，正在重新下载… | 面板提示位 | M9 |
| 6 | 本地 200 + 内容坏（`corrupt`） | 文件已损坏，已重新下载 | 面板提示位 | selfheal A3/G6 |
| 7 | 本地 200 + 编码不支持 | 本机不支持该编码（可换一张跳过此壁纸） | 面板提示位 | selfheal G6 |
| 8 | 本地 200 + 分辨率超限且无变体 | 该壁纸分辨率/编码超出本机解码能力（可换一张跳过此壁纸） | 面板提示位 | selfheal |
| 9 | 内容好但超限，已切 1080p | 已切换到 1080p（原画超出本机解码上限） | 面板提示位 | selfheal |
| 10 | 救援转码进行中 | 正在生成本机可播放副本 {percent}% | 面板提示位 | verify-transcode-state |
| 11 | 视频不可解但有静态帧 | 已降级为静态壁纸（本机无法解码该视频） | 面板错误行 | verify-media-selfheal |
| 12 | 连静态帧都没有 | 无法显示这张壁纸（本机无法解码该视频，且没有可用的静态帧） | 面板错误行 | verify-media-selfheal |
| 13 | 链路/安装失败 | 下载/安装失败：{code} | 卡片/提示 | verify-downloads |
| 14 | 传输内容与站点不一致 | 传输内容与站点不一致 | 卡片/提示 | verify-hash-source |
| 15 | **代理也**读不到（`proxy` + code 2） | 视频读取失败（文件可能已被移动或删除） | 面板错误行 | M14 |
| 16 | 本地缺失但静态封面已铺上（P0） | 已显示静态封面 · 本地副本已丢失，正在重新下载 | 面板提示位 | M10 / heal D8 |

**禁止**：`<video>` 的 `MediaError.code` 单值翻译成"无法播放/无法解码"。本地源为 URL 时
`videoPlaybackError()` 返回空串，由宿主判据（HEAD + `/local-heal`）给出上面 4–12 中的**具体**一条。
`proxy` 源上 code 3/4 才允许说"浏览器无法解码这段视频（…）"（此时没有本地副本可以怀疑）。

---

## 4. 不变量（混沌测试逐轮断言）

| id | 不变量 | 断言位置 |
|----|--------|----------|
| I1 | 不存在 `done + 文件缺失`（对账后） | verify-media-chaos |
| I2 | 不存在 `src=local` 指向缺失/不完整文件 | verify-media-chaos / M7 |
| I3 | 下载中（含暂停、校验中）的条目 `src` 必须是 proxy | verify-media-chaos / M4 |
| I4 | 下载完成后 3 秒内 `src` 变 local（或明确仍 proxy 且有原因） | verify-media-chaos |
| I5 | 任何失败都有具体文案（不得泛化成"无法解码"） | verify-media-chaos / 文案矩阵 |
| I6 | UI 状态与队列状态一致（queued/downloading/complete） | verify-media-chaos |

## 4b. 渲染方式与静态封面（P0/P1）

`resolvePlaySrc()` 除 `source` / `url` 外还返回 **`mode`**：

| mode | 触发 | 渲染 | 判据 |
|------|------|------|------|
| `image` | 条目 `type === 'image'` | `<img>`（现有路径） | M10 |
| `video` | 站点视频 + 有可用地址（本地或站点流） | 视频池 | M10 |
| `poster` | 视频**没有可用地址**；或 `scene`/`web`（**预留**，本次不改现有渲染） | 静态封面 `<img>` | M10 |

静态封面垫底（P0）的两条接线：
1. **播放层**：`buildMedia` 在 `type==='video' && playMode==='poster'` 时直接返回
   `<img class="we-media we-media--static">`（`previewUrl` = 站点 thumbUrl / 宿主抽帧）；
2. **错误路径**：本地副本 404/410 时，**先** `mountStaticFrameFallback(staticFallbackUrlOf())`
   再切站点流 —— 换源到首帧之间的空窗里屏上是这张壁纸的图，不是黑屏。
   `mountStaticFrameFallback` 挂了 `onerror`：**封面本身**加载失败才撤掉它，并允许进入
   "最终失败"那一级（文案矩阵 #12）。

降级链顺序（4.23.15 起，含本次）：变体 → 4K@30 → 1080p → 救援转码 → **静态帧** → 才报错。

## 5. 对账时机（`reconcileAll` 只在这四处跑）

| 时机 | 入口 | reason | 说明 |
|------|------|--------|------|
| 启动 | `registerDownloadsRoutes` | `startup` / `startup-deep` | quick 同步；deep（≤20MB sha）2s 后 |
| 清缓存后 | `lib/routes/cache.js` | `cache-clear` | 与"删文件"同一事务，回 `clearedFiles`/`resetJobs` |
| `/local-media` 缺失 | 路由 404 分支 | `local-media-404` | `noteMissing` ⇒ pending（**不**偷偷重下） |
| 下载完成 | 队列 `onDone` | `noteDone` | 只补一次盘上证据，刷成 localReady |

幂等：同一份盘上证据跑两遍，第二遍 `reset/deleted/promoted` 全 0。

---

## 6. 绕过清单（修前 / 修后）

"绕过"= 不经过 `reconcile` 就回答"这份本地副本能不能播"，或直接改 `job.status` / 删媒体文件。

| # | 位置（修前） | 问题 | 修后 |
|---|--------------|------|------|
| 1 | `lib/download-queue.js` `load()`：`status = onDisk ? done : pending`（291e493 / 4.23.18） | 状态映射自己写一份；done-缺失**永不重下** ⇒ 永久 404 | 调 `startupStatusFor()`（media-state 唯一实现） |
| 2 | `lib/routes/downloads.js` `localCopyFor()`：`job.status==='done'` ⇒ local | 不验文件在不在 | 经 `reconcile.stateOfId` + `resolvePlaySrc()` |
| 3 | `lib/routes/downloads.js` `localFamilyCopyFor()`：族命中直接给本地 URL | 同上（族里那份已删） | 同上 |
| 4 | `lib/routes/inventory.js` `foliaItemFromCatalog()`：`familyCopy ? local : proxy` | 播放源第二处决定；清单缓存还把它固化 60s | 改调 `resolvePlaySrc()`；缓存命中时 `refreshLocalFields()` 重算 |
| 5 | `src/media-prep.js` `applySelection()`：`(w.mediaProxy || w.media)` | 客户端播放源第二处决定；会播到缓存里的旧本地地址 | 改调 `resolvePlaySrc(w)`（客户端同名函数） |
| 6 | `lib/routes/site-media.js` 下载中 `.part` 渐进读（`content-length=总量`） | 半截字节当成品 ⇒「文件可能已损坏」 | 下载中一律 302 回源；`.part` 不再进播放路径 |
| 7 | `lib/routes/cache.js` 清缓存只删文件（`pruneDoneJobs` 只改盘） | 内存队列仍 done ⇒ 404 | `resetDoneForKinds` + `reconcileAll({reason:'cache-clear'})`，回 `clearedFiles`/`resetJobs` |
| 8 | `lib/routes/downloads.js` `/local-media` 404 直接 `invalidate()`（queued） | 任何一次 404 都偷偷往队列塞下载 | `noteMissing()` ⇒ pending；在播那张由客户端 `/downloads/requeue` 显式重下 |
| 9 | `src/client.js` `videoPlaybackError()`：code 4 ⇒「浏览器无法解码」 | 404 被说成解码失败 | 本地源返回空串；`maybeSelfHealVideo` 先 HEAD 判"丢/坏/编码"再给具体文案 |
| 10 | `src/video-switch.js` 完成即切本地：只认 `status==='done'` | done 也可能是 done-缺失 | 追加 `fileValid !== false` |
| 11 | `src/client.js` 清缓存 toast 只报文件数 | 用户不知道要重下 | 读 `clearedJobs` 显示两条数字 |
| 12 | 测试工具/脚本直接往 library 写合成占位文件 | 用户看到"无法解码"（4.23.15 事故） | 保留 `verify-test-isolation` 的隔离判据；本仓新测试一律隔离 home + 结构有效 mp4 |
