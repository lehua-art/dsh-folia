# 4.23.20 自测记录（给 QA）

> 环境：Windows 11 · Electron/DSH Desktop（`ELECTRON_RUN_AS_NODE=1`）· Node 24
> 判据来源：`test/verify-*` 门禁（真路由 + 真队列 + 隔离 home）+ 本次真机接口返回。
> 隔离：所有用例都用 `test/tools/isolate-home.mjs` 的临时 `DSH_HOME`，**不写用户 library**。

| # | 功能 | 判定方式 | 结果 | 证据 |
|---|------|----------|------|------|
| 1 | 下载：未缓存点击 → 入队 high → 进度 → 完成校验 | `POST /downloads/add` 断言 `priority=high`；`/downloads/list` 观察 `queued→running→done`；done 时 `verified=sha256` | **通过** | `verify-queue-priority` C1/C2（点击即 high + 队首）、`verify-downloads`（真源下载 done + sha）、`verify-wallpaper-progress`（「缓存中 N%」） |
| 2 | 播放源：完成→local；下载中→proxy | 纯判据 `resolvePlaySrc`：`done+fileExists+fileValid` ⇒ `local`；`running/queued` ⇒ `proxy` | **通过** | `verify-media-state` M1e/M2c/M3a/M3d/M10b（58 条全过） |
| 3 | 切换 A→B→A：A 未完成仍显示真实进度；完成后只显示「已缓存」 | `wallpaper-progress` 按卡订阅 `/downloads/list` 真值；切回不重置进度 | **通过** | `verify-wallpaper-progress`（切走再切回接着显示 / 负对照=切回归零即红） |
| 4 | 失败兜底：local 404 / error(4) → 自动 proxy + 重下；文案不是"无法解码" | HEAD 判 404 ⇒ `lfLocalMediaFallback` 换站点流 + `POST /downloads/requeue`；本地源 `videoPlaybackError` 返回空串 | **通过** | `verify-local-media-heal` B5/B6/D2–D9（28 条）；`verify-media-state` M8i/M8j/M9c |
| 5 | 清缓存：清空媒体 → 记录同一事务重置 → 立即可重下（无需重启） | `/folia/cache/clear` 返回 `clearedFiles>0 && resetJobs>0`；内存队列 done=0；随后点击 `add()` ⇒ queued | **通过** | `verify-media-state` M5a–M5c；`verify-local-media-heal` C3–C6（负对照：只删文件不改内存队列） |
| 6 | 重启：done+缺失 → pending；再点可下 | 隔离 home 写 31 条 done+缺失 ⇒ `load()` → 全 pending、`queuedCount=0`；`add()` 后 queued | **通过** | `verify-queue-priority` B3（30 条 pending / queued=0）；`verify-local-media-heal` A1–A3 |
| 7 | 4K@60 + 4K30 变体 ⇒ 选 `4k30` | `pickVariant({originalFps:60, variants:[{label:'4K30',height:2160,fps:30}]})` ⇒ `chosen='4k30'`, `reason='hifps-variant'`；`/downloads/list` 的 `chosenVariant='4k30'` | **通过** | `verify-variants` 新增 7 条（含"5916×2530 仍选 1080p"与"去掉 label/fps ⇒ 认不出"负对照） |
| 8 | 超分辨率（5916×2530）+ 1080p ⇒ 选 1080p | `decodeLimitHit` 优先于降帧；`chosen='1080p'`, `reason='decode-limit'` | **通过** | `verify-variants`（decode-limit 用例）；`verify-media-selfheal` G2 |
| 9 | 队列：点击即队首；「前面还有 N 个」与实际一致 | `compareQueueOrder` + `queuedAhead` 只数**同 kind + 同优先级**；面板读 `queuedAhead` | **通过** | `verify-queue-priority`（点击/在播 high + 队首、跨 kind 不串号） |
| 10 | 皮肤/开机动画/桌宠：首击有反馈、进度、可重试 | 点击同一 tick 出 pressed/aria-busy、零网络；300ms 未入队出「提交中…」占位；失败可重试 | **通过** | `verify-first-click-feedback`（四类入口各一条 + 旧顺序负对照） |

## 附加自测（本次新增收口）

| # | 功能 | 判定方式 | 结果 | 证据 |
|---|------|----------|------|------|
| 11 | 对账四时机 | 启动 / 清缓存 / `/local-media` 404 / 下载完成（队列 `onDone`）都调对账器；`/diag/media-state` 有 `last` 统计 | **通过** | `verify-media-state` M4/M5/M6/M7；源码扫描 M8f/M8e |
| 12 | 静态封面垫底（P0） | 本地 404 时先 `mountStaticFrameFallback` 再切流；封面自身失败才撤图 | **通过** | `verify-media-state` M10f/M10g/M10h |
| 13 | 混沌 100 轮 | 随机删文件/改记录/只写一半/校验不符/清缓存/重启；每轮断言 I1–I6 | **通过（0 违例）** | `verify-media-chaos`：seed=20261104 · 100 轮 · 200 次不变量评估 |
| 14 | 生命周期合同 | 13 状态 × 10 事件、16 条文案、12 条绕过清单与代码/测试对账 | **通过** | `verify-media-state` M0a–M0d |

## 门禁（本版发布时）

- `build-client`：通过（`lib/client.js` 5.52 MB · 1 文件 / 5 模块注册）
- `run-audit`：**94 通过 / 52 退役 / 0 失败**（146 条）
- `verify-static`：通过（ESLint 11 规则全 ≤ 基线 · tsc 6 错误码全 ≤ 基线）
- 新增/相关守卫：`verify-media-state` **58/58** · `verify-media-chaos` **0 违例** ·
  `verify-local-media-heal` **28/28** · `verify-variants` **34/34** · `verify-queue-priority` **58/58**
