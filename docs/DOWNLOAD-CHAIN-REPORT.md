# 下载链路：测试与优化报告（4.23.6）

> 覆盖**整条链**：清单 → 选档 → 下载 → 落位 → 安装 → 启用。
> 判据：`test/verify-download-chain.mjs`（6 个场景，进门禁）· 基准：`scripts/bench-chain.mjs`（出数字，不进门禁）
> 状态机（卡片该显示什么、能不能点）：[`INSTALL-FLOW.md`](INSTALL-FLOW.md)。

---

## 1. 链路分段图（每段的缓存 / 超时 / 降级策略）

```
① 清单 /inventory 或 /api/public/wallpapers
   缓存：模块索引清单 30s（boot）、站点皮肤 60s（pets）、inventory 带 local 标记
   超时：站点请求 15s；失败 → 保留上一次清单 + 明确 siteError（不静默清空）
   降级：站点不可达 ⇒ 候选为空但界面说明原因；不影响本机已下载的播放
        ↓
② 选档 lib/variant-pick.js（纯函数）
   规则：quality=original 恒原画；没有 1080p 变体 ⇒ 原画；saver 恒 1080p；
      慢链路（队列实测 <0.6 MB/s）⇒ 1080p；原画 >20 MB 且屏幕 ≤1440 ⇒ 1080p；其余原画
   降级：**只认 1080p**（720p/480p 不"顺手"降），字段缺失/非法一律回落原画并不抛
        ↓
③ 入队 POST /folia/downloads/add（幂等，同 URL 一个 job）
   并发：全局 3，按 kind 独立槽（壁纸预取不会挤掉皮肤安装）
   优先级：用户点击 high > 后台预取 low；failed/cancelled 再入队 ⇒ 重置为 queued（可重试）
        ↓
④ 下载 lib/download-queue.js
   续传：.part + Range；8 路分片（>8 MB 或自适应切换）；原子 rename
   自适应：开始后 3 秒实测平均吞吐 <0.6 MB/s 且剩余 >4 MB ⇒ 切 ranged:8（从盘上真实字节续）
   降级：HEAD 预检命中可跳过；单条失败只让该 job 失败；坏 zip 缓存当场清掉
        ↓
⑤ 落位快照 GET /folia/downloads/list（客户端唯一真源）
   done/queued/running/failed + percent/received/total/mode/chosenVariant + installStallMs
   客户端停表条件：没有 queued|running ⇒ 停；**停滞卡片另有 1 秒表**（否则 90 秒超时永不触发）
        ↓
⑥ 安装落地 POST /folia/skins/install（= boot/download、pets/install 同构）
   幂等：目录已有 skin.json ⇒ exists:true；已装 ⇒ 100/101 直接返回；栅栏（TTL 2 分钟）防重复解压
   状态：200 同步落地 / 202 + jobId（8 秒窗口没下完）/ deduped（另一条路径正在装）
   自愈：挂载时 done 但未落地 ⇒ 自动补一次（幂等、走缓存）；90 秒上界后 failed +「重试」
        ↓
⑦ 启用 /skins/activate（写皮肤中心 active + 广播 dsh-skin-applied）
   判据：/skins/list 的 installed（目录名 / skin.json.id / catalog id 三者任一命中）
```

---

## 2. 六个场景与实测（`node test/verify-download-chain.mjs`）

| # | 场景 | 断言数 | 结果 | 耗时 |
|---|---|---|---|---|
| 1 | 快链路（6 MB 满速）：原画 >20 MB + 有变体 ⇒ **选原画**、全程 single、**0 条 Range**、<2s | 6 | 6/0 | ~60 ms |
| 2 | 慢链路（每连接 0.2 MB/s）：**3 秒切 ranged:8**、吞吐 ≥2.5× 单流、1080p 变体字节 <30% | 7 | 7/0 | ~6.7 s |
| 3 | 清单陈旧（无 `variants`）：优雅回落 original、不抛、无重试风暴（≤4 次请求） | 4 | 4/0 | ~60 ms |
| 4 | 缓存命中：同 URL 第二次 **0 次网络请求**；缓存头 ≤8 MB immutable / >8 MB `max-age=3600` | 5 | 5/0 | ~0.4 s |
| 5 | 落位与安装：zip → `skins/<id>` → `installed` 含 id；重复 install **只解压 1 次**（栅栏） | 6 | 6/0 | ~0.25 s |
| 6 | 故障注入：队列被清空 ⇒ 7.5 s 内 failed 可重试；500 ⇒ failed + 原因；磁盘写失败 ⇒ failed 不卡 | 6 | 6/0 | ~6.2 s |

合计 **34 条断言 / 0 失败**，总耗时 **≈13.6 s**（其中两段是真实的等待：3 秒自适应窗口 + 5 次轮询）。

### 场景 2 的判据口径（为什么这样算"吞吐 ≥2.5×"）

- 队列的自适应窗口是 **3.0 秒**（`ADAPTIVE_EVAL_MS`）：到点用"这 3 秒的实际字节/时间"算平均吞吐，
  `<0.6 MB/s` 且剩余 `>4 MB` 才切多连接 ⇒ 判据要求 `switchedAt ∈ [2.9s, 3.5s]`（3.0s + 一拍轮询抖动）。
- "整体吞吐 ≥ 单流的 2.5 倍"用**同一次运行内的两段实测**算：
  单流速率 = 切换前已收字节 / 切换耗时；整体速率 = 总字节 / 总耗时。
  限速是**每连接** 0.2 MB/s，所以 8 路才可能真的快 8 倍；本次实测约 **4.4×**（含切换开销）。

---

## 3. 性能基准（`node scripts/bench-chain.mjs`，三次取中位数）

| 场景 | 模式 | 中位耗时 | 吞吐 |
|---|---|---|---|
| 原画 6 MB（满速） | single | **45 ms** | 132.56 MB/s |
| 1080p 1.5 MB（满速） | single | **30 ms** | 49.83 MB/s |
| 单流 9 MB（每连接 8 MB/s） | single | **1229 ms** | 7.32 MB/s |
| 多连接 8 路 9 MB（每连接 8 MB/s） | ranged:8 | **124 ms** | 72.52 MB/s |
| library 命中（同 URL 第二次） | existed | **1 ms** | —（**0 次网络请求**） |

- **多连接 / 单流 吞吐比：9.91×**（每连接限速时，连接数就是吞吐倍数）。
- **1080p / 原画：体积 25%、耗时 67%**（1.5 MB vs 6 MB；小包固定开销占比更高，所以耗时比不等于体积比）。
- **library 命中有 1 ms 级**：命中路径不碰网络，只做 `existsSync` + 快照返回。

> 数字与机器/负载强相关，只用于**同一台机器上改动前后**的横向对比；不要把它写成绝对门禁。

---

## 4. 这一轮针对"下载快"做了什么

| 措施 | 位置 | 效果 |
|---|---|---|
| 快链路**不降档** | `lib/variant-pick.js` | 满速时拿原画（画质优先），不为省流量牺牲观感 |
| 慢链路**3 秒自适应多连接** | `lib/download-queue.js` `streamSingle()` | 高 RTT 下吞吐从 0.2 MB/s 提到 ~0.9 MB/s（实测 4.4×） |
| 慢链路**自动选 1080p** | `lib/variant-pick.js` + 队列 `slowHosts` | 同一次实测结论同时驱动"切多连接"和"降档"，不各写一个阈值 |
| **HEAD 预检 + 缓存命中 0 请求** | 队列 `add()` | 第二次点击 1 ms 级返回，不重复占带宽 |
| **已完成载荷缓存分档** | `lib/serve.js` `completedCacheControl()` | ≤8 MB 一年 `immutable`；>8 MB 1 小时（不再让浏览器存双份大文件） |
| **落位幂等 + 栅栏** | `lib/routes/skins.js` | 重复安装不再解压第二遍（"装了两遍"） |
| **落地上界 + 挂载自愈** | `src/local-first.js` + 三个页签 | "下完但没落地"最多 90 秒，且通常无需用户操作就自愈 |

---

## 5. 已知边界（写清楚，免得下次当新 bug）

1. **自适应只看"开始后 3 秒的平均速率"**：如果前 3 秒恰好很快、之后被限速，本次不会切（下次同域会
   因为 `slowHosts` 记忆直接多连接）。这是刻意的：过早切多连接会在正常链路上白开 8 条连接。
2. **多连接只在"每连接限速"时有效**：若限速在出口（路由器/运营商整体整形）而不是每连接，
   8 路不会更快 —— 这是物理边界，不是实现问题。
3. **`RANGED_MIN_BYTES = 8 MB`**：小文件不为此开 8 条连接（开销占比太高）。
4. **1080p 只认 1080**：站点只给 720p/480p 时**不降**（1440p 屏上看得出来，降错档比不降更难受）。
5. **library 命中依赖 dest 已存在**：文件被手动删掉后 `add()` 会重新排队（`done` 且文件不在 ⇒ queued）。
6. **落地上界 90 秒是"观察起点"起算**，不是文件完成时刻（`jobs.json` 没存完成时间）；
   重开面板时秒表从挂载那一刻起算，足够覆盖"上一轮收尾丢了"的场景。
7. **磁盘写失败**没有专属错误码，卡片显示"下载/安装失败：<code>"（带出原始错误）。这一档
   目前只在链路测试里注入验证过，没有做磁盘满/只读盘的专项模拟。

---

## 6. 复现命令

```powershell
node test/verify-download-chain.mjs   # 6 个场景（进门禁，约 14s）
node test/verify-install-flow.mjs     # 状态机 20 行 + 4 条端到端（进门禁，约 12s）
node test/verify-downloads.mjs        # 队列/自愈/超时单点 + 负对照（进门禁）
node scripts/bench-chain.mjs          # 基准（不进门禁，约 5s）
```
