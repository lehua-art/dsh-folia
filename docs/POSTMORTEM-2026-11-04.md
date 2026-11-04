# 复盘：2026-11-04 三类事故（ranged 静默损坏 / 变体哈希来源 / 测试污染真实 library）

> 用户要求："不要再出这种问题"。所以这份文档不写"下次注意"，只写**根因 → 发现方式 → 修复 →
> 防线（判据）**。每一条防线都是仓库里真跑的东西，能逐条核对（见文末对照表）。

---

## 事故一：多连接 Range 的**静默损坏**（4.23.6 引入，4.23.7 修复）

### 根因（四处缺口，缺一不可）

站点对**同一个 URL** 有两个对象：全量响应 17,509,106 B（旧版）、Range 回源 17,414,581 B（新版）。
`lib/download-queue.js` 的 `fetchRanged` 当时：

1. `return end - start + 1` —— 把"请求长度"当"实收长度"，收尾的 `written !== span` **恒不成立**；
2. 只看 `status === 206`，不核对 `Content-Range` 的 start/end/total ⇒ 双版本对象照单全收；
3. `base === 0` 时 `truncateSync(part, total)` 预填 0x00 ⇒ 落盘长度"天然正确"，少写一段也看不出来；
4. 没有逐片字节计数 ⇒ 短读被吞。

结果：文件长度对、内容错（尾部 94,525 个 0），job 报 `done` → 装出来的 zip 坏 / 视频解不出来。

### 发现方式

用户报"下载完成但文件坏了"。`downloads.json` 里 job 是 `done`，`sha256` 与站点声明不符；
用同一 URL 分别走全量与 Range 回源，长度差 94,525 B —— 与文件尾部 0 的个数逐字节吻合。

### 修复

逐片 `got === want`、`Content-Range` 逐字核对、ETag 一致性、**不预填**（写多少涨多少）、
最终 `onDisk === total`、以及 sha256 内容判据；任何一层不过 ⇒ 回源路径失败/重下，绝不 `done`。

### 防线

| 防线 | 判据 |
|---|---|
| 四道即时校验 + 失败回落 | `test/verify-ranged-integrity.mjs`（含"旧实现贴回必须红"的源码级与行为级负对照） |
| 内容哈希（站点给了就必验） | `test/verify-downloads.mjs` ⑰ / `test/verify-ranged-integrity.mjs` ⑤ |
| 无效媒体不入库 | `test/verify-media-selfheal.mjs`（占位/缺 moov/截断都标 `invalid-media`，不冒充已缓存） |

---

## 事故二：1080p 变体的**哈希来源错误**（4.23.4 引入，4.23.17 修复，P0）

### 根因

"要下哪个对象"被拆成两处各答一次：

- `pickVariant()` 决定**下 1080p 变体**（url 换成 `…xxx.1080p.mp4`）；
- 调用方（`/downloads/add`）却仍按"这条壁纸"取 **`item.sha256`（原画的哈希）** 交给队列。

原画与变体是两个对象、两个哈希 ⇒ 每次校验都 `hash-mismatch`；自动单流重下一次仍不一致 ⇒
job 停在 failed。本机实测 **15 条** wallpaper job 是这个形态，用户看到的是"点击壁纸不显示"。

第二种形态：库里的 `.part` / 成品被外部清理（缓存管理器 / 手工删），job 还在跑，下一次
写盘 / stat / rename 直接 `ENOENT: …xxx.mp4.part` —— 旧实现把它当普通失败。

### 发现方式

用户报"点壁纸不显示" → `/folia/downloads/list` 里 15 条 `failed / hash-mismatch / received=0`，
失败 url 全是 `…1080p.mp4`；对照站点清单：`item.sha256 ≠ variant.sha256`、`item.bytes ≠ variant.bytes`。

### 修复

1. **单一真相源**：`lib/variant-pick.js` 新增 `resolveMediaExpectation(item, chosen)` ——
   `(url, bytes, sha256, source)` 只能由它产出，三件套来自**同一个对象**。
   四个宿主入队点（`/downloads/add`、skins、boot、pets）全部改为经它取值；
   客户端只转发**清单事实**（`manifestSha256` + `variants[]`），不再以 `sha256` 名义替宿主决策。
2. **运行时不变式**：`assertExpectation(item, expectation)` —— 期望 url 命中 `variants[]`
   但哈希等于原画的 ⇒ 当场 `hash-source-mismatch`（不是慢慢 mismatch，排障方向就是错的）。
3. **可审计**：job 持久化 `expectSha / expectBytes / hashSource` 并写进 `/downloads/list`。
4. **不许静默跳过校验**：没有期望哈希 ⇒ 宿主打日志；界面文案把"哈希来源错"与"传输内容坏"
   分成两句（`dlFailReason('hash-source-mismatch')`）。
5. **ENOENT 自愈**：`.part` / 成品被外部清掉不是"链路失败" —— 清残留 + 重排（单流/当前模式），
   **连续两次**才 `file-vanished`；`finishRanged` 不再把 ENOENT 当"多连接路径失败"回落单流
   （那会假装成功）。
6. **旧状态升级**：`downloads.json` 里 `status=done` 但成品不存在 ⇒ 载入即重置为 `queued`；
   缺 `priority/mode/chosenVariant/expectSha` 等旧字段 ⇒ 回落默认值，不崩。

### 防线

| 防线 | 判据 |
|---|---|
| 哈希来源唯一出口（源码面） | `test/verify-hash-source.mjs` ①：入队/校验处出现 `sha256: item.sha256` 即红（白名单逐条写明） |
| 矩阵（数据面） | `test/verify-hash-source.mjs` ②：`{原画,变体}×{sha 有,无}×{bytes 一致,不一致}` 8 组全过 + `assertExpectation` 三条 |
| 负对照（必须有牙） | 同上 ③：旧写法贴回 / resolve 退化 / 丢变体 sha ⇒ 判据当场红 |
| 行为（真 HTTP+真路由+真队列） | `test/verify-variant-hash.mjs` ②③：变体+变体哈希 ⇒ done；变体+原画哈希 ⇒ hash-mismatch |
| ENOENT 自愈（行为） | `test/verify-variant-hash.mjs` ④⑤：删 `.part` 一次 ⇒ done；连续两次 ⇒ `file-vanished` |
| 旧 JSON 升级 | `test/verify-variant-hash.mjs` ⑥：手工构造的 4.23.16 旧 `downloads.json` |
| 进度可见（用户侧） | `test/verify-wallpaper-progress.mjs`：卡片/标题栏 62% / 已缓存 / 切回接着显示真实进度 |

---

## 事故三：测试**污染用户真实 library**（4.23.15 前，4.23.15 修复）

### 根因

测试/脚本"顺手"用了 `createDownloadQueue()` / `destForUrl()`，而它们的默认 home 是
`%APPDATA%\dsh-desktop\harness` —— 默认值就是真实目录。30 个 4–65 KB 的合成占位视频
（`ftyp isom … mdat`，ffprobe 无 stream）被写进了用户的 `library/wallpaper/`。
用户看到的所有「浏览器无法解码」正是这些假文件，不是编码问题。

### 发现方式

用户报告"所有视频都解不出来" → 用 ffprobe 逐个探，全部无 stream；文件大小与测试合成数据吻合；
mtime 与跑测试的时间吻合。

### 修复

- `test/tools/isolate-home.mjs`：`isolateTestHome(label, { force })` 把 `DSH_HOME` 钉到
  `%TEMP%\folia-test-*`，**已经是真实 harness 就直接抛**（`force` 时重定位而不是放行）；
- 所有会写 media 的测试显式传临时 `home`；
- 同时补「无效媒体不入库」：<1 KiB 或 MP4 无 `moov`/越界 ⇒ `invalid-media`，不写进 library。

### 防线

| 防线 | 判据 |
|---|---|
| 静态面：解析 home 的测试/脚本必须有隔离证据 | `test/verify-test-isolation.mjs` ①（含两条负对照） |
| 行为面：真实 harness 当 `DSH_HOME` 起子进程必须被拒（exit 3） | `test/verify-test-isolation.mjs` ② |
| 占位媒体不入库 | `test/verify-media-selfheal.mjs`（`invalid-media` 分支 + 启动 sweep） |
| 新增测试一律隔离 | 本仓新增的 `verify-variant-hash` / `verify-wallpaper-progress` / `verify-hash-source` 都在模块顶部 `isolateTestHome(...)` |

---

## 三类事故 × 防线 × 判据（一张表核对）

| 事故 | 防线（结构性） | 覆盖它的测试/脚本 |
|---|---|---|
| 多连接静默损坏 | `fetchRanged` 四道即时校验 + 内容哈希 + 无效媒体闸 | `verify-ranged-integrity.mjs` · `verify-downloads.mjs` · `verify-media-selfheal.mjs` |
| 变体哈希来源错误 | `resolveMediaExpectation`（唯一出口）+ `assertExpectation`（运行时不变式）+ `expectSha/expectBytes/hashSource` 可审计 | `verify-hash-source.mjs` · `verify-variant-hash.mjs` |
| 测试污染真实 library | `isolateTestHome` + 默认 home 不再被测试使用 | `verify-test-isolation.mjs` · （所有新测试顶部调用隔离） |
| 本地文件被外部清理 | ENOENT 先清残留+重排（连续两次才 `file-vanished`） | `verify-variant-hash.mjs` ④⑤ |

## 发布门槛（详见 `docs/RELEASE-GUARD.md` 四之二）

1. `node test/run-audit.mjs` **失败必须 0**；
2. 任何"数据来源"变更必须配**矩阵测试**（正例 + 反例 + 旧写法负对照）；
3. 测试**禁止写真实 home**（一律 `isolateTestHome` / 显式临时 `home`）。
