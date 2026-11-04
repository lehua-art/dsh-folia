# 壁纸切换性能（4.23.8）

> 一句话：**「已缓存壁纸切换卡顿」不是"没下载好"，而是"下载好的那份没被认出来 + 播放器每次重建"**。
> 本文给出切换的时序、双缓冲/预热策略、`switchLatencyMs` 指标口径，以及已知边界（4K 解码）。

---

## 1. 用户症状与故障链

用户口径（4.23.7 前）：

> 点**已经下载好**的壁纸会**卡一下**才播，而 Wallpaper Engine 切换很流畅。

把这句话拆开，实测里它对应**两条互相独立的成本**。两者都表现为"点了之后要等一下"，
但修法完全不同 —— 所以必须**分别度量**，否则改一处会被另一处盖掉。

| # | 成因 | 结论 | 位置 |
|---|---|---|---|
| ① | 切换时 `<video>` 被卸载重建 ⇒ 解码器重建 | **成立**（结构性，恒在） | `src/live-layer.js` `layerWantKey` / `obtainLayerNode`、`src/video-layer.js` `buildVideoMedia` |
| ② | `src` 指向代理 URL（`/folia/site-media/…`），即使文件在本地也走一次 HTTP + 代理中继 | **成立**（条件性） | `src/media-prep.js` `applySelection`、`lib/routes/inventory.js` `mediaProxy` |
| ③ | 没有 `preload="auto"`，也没预热解码 | **部分成立** | 见下 |
| ④ | 切换瞬间旧画面被清 ⇒ 黑屏感 | **基本不成立** | 既有内容闸门已挡住 |
| ⑤ | 原画与 1080p 是两个 URL ⇒ 已缓存原画时切到变体仍重新下载 | **成立**（离群最大） | `lib/routes/downloads.js` `libraryDest` |

### ① 元素重建（恒在）

`layerWantKey()` 把 `selection.url` 算进**层键**；换一张视频壁纸键必变 ⇒
`syncLayers()` 让旧层交出 `LAYER_ID` ⇒ `obtainLayerNode()` 看不到层节点 ⇒
新建 div ⇒ `buildMedia()` → `buildVideoMedia()` → `document.createElement("video")`。

于是**资源选择 → 取 moov → 解复用器初始化 → 首帧解码**整段都压在点击的关键路径上。

唯一的复用后门是 `consumePreparedMedia()` / `consumeWarmVideo()`，而
`src/media-prep.js` 的 `prepareWallpaper()` 对 `w.type === "video"` **故意直接
`onReady()`**（注释写明：视频档不跑准备链，怕双解码、怕观感变成「GIF→静图→正片」）。
⇒ 手动点击时 prepared 恒为 `null`，**这条后门对视频档实际是关着的**。

### ② 代理中继（条件性）

`applySelection()` 里 `playableSrc = w.mediaProxy || w.media`，而 `mediaProxy` 在
`inventory.js` 里是二选一：命中本地 ⇒ `/folia/local-media/<job>`（读盘）；
**未命中** ⇒ `/folia/site-media/?u=…`（客户端 → 宿主 → 上游的中继）。

所以"是否走代理"完全取决于**命中判定**——而命中判定正是 ⑤ 的问题。

### ③ 预热：半不成立（必须如实写）

- `preload="auto"` **早就设了**（`video-layer.js` 建层那段，还带注释解释
  moov 在文件尾部、缺省会取完 moov 就停）。
- 预热机制**也早就有**（`warmVideoUrl` / `consumeWarmVideo` / `warmVideoForPointer`，
  单槽位 + 20s TTL + hover 120ms 去抖）。
- **真正缺的是**：预热**只到 `HAVE_METADATA`**（`preload="metadata"`、`autoplay=false`、
  **绝不 `play()`**，为了不引进第二个 4K 解码器）⇒ **首帧解码仍在关键路径上**。

⇒ 修法不是"加 preload"，而是**把预热从 metadata 推到"首帧已解码"**。

### ④ 黑屏：基本不成立

内容闸门（`disposeOutgoingLayer` → `armLayerContentReveal` → `armVideoChannelReveal`）
在**新层没有画面时不拆旧层**；判据是「海报图**已加载**（不是属性存在）」或
`readyState ≥ 2`；`VIDEO_STALL_GIVE_UP_MS = 15s` 到点也只留旧壁纸、绝不铺层底色。
换张壁纸还有 150–250ms 交叉淡化。

⇒ 正常路径**不会黑**。用户的"卡一下"= **旧壁纸多留 0.5–2s 且没有任何反馈**，
观感等同"点了没生效"。这正是点击反馈（§4）要解决的那件事，与性能是同一个问题的两面。

### ⑤ 缓存族不命中（离群最大）

`libraryDest(kind, slug, ext)` 用**最终 URL 的 basename** 做散列：
原画 `x.mp4` 与 1080p `x-1080p.mp4` ⇒ 不同 slug ⇒ **两条独立缓存**。
`localCopyFor()` / `queueJobFor()` 又只按**问的那个 URL** 的 basename 重算 dest，
于是「下了 1080p」不会让原画 URL 变 `local:true`。

⇒ 用户看到 `local:false` 并不等于"没下载"，而是"**没按这一条 URL 下载**"。
修法是**缓存族**（`lib/switch-cache-family.js`）：同族任一档落地即视为可播。

---

## 2. 切换时序（改前 vs 改后）

改前：解码器重建 + 首帧解码全在关键路径上。

```
click ─┬─ applySelection ── emit ── syncLayers
       │                              │
       │                              ├─ layerWantKey 变化 ⇒ 旧层交出 LAYER_ID
       │                              ├─ obtainLayerNode ⇒ createElement("video")   ← ①
       │                              ├─ mediaProxy 是否命中?  ← ②/⑤（未命中 ⇒ HTTP 中继）
       │                              ├─ preload=auto ⇒ 取 moov
       │                              ├─ 首帧解码                         ← 关键路径
       │                              └─ 内容闸门放行 ⇒ 交叉淡化 ⇒ 首帧可见
       └──────────────── 旧壁纸一直留屏（无反馈）──────────────┘
                                    ↑ 0.5–2s「卡一下」
```

改后：元素常驻 + 首帧已预热 + 按下即反馈。

```
pointerdown ── (同步, <1ms) 卡片 pressed + aria-busy="true" + clickFeedbackMs 记录   ← G1
                    │
click ─── weSwitchBegin() ⇒ priming
                    │
                    ├─ 池里已有该 URL 且首帧已解?  ── 是 ─→ 直接 reparent 进新层 (playing)   ← 命中
                    │                                （元素身份不变、解码器连续）
                    └─ 否 ⇒ 池里另一个元素装 src（它不在屏上，换源安全）
                              ├─ 1.5s 内没到可播 ⇒ 状态转 buffering
                              │     ⇒ 「正在缓冲 x%」+ 取消按钮                        ← G2
                              └─ 首帧未到且出错 ⇒ failed + 原因 + 「重试」              ← G5
                    │
                    └─ 首帧在 ⇒ swapping ⇒ publish（交叉淡入 150–250ms）⇒ playing
                              └─ 收尾：switchLatencyMs 记账、卡片复位、toast 1.5s     ← D9/G4
```

关键差别：**② 的 HTTP 中继被移出关键路径**（族命中后走 `/folia/local-media/` 读盘），
而 **① 的解码器重建被池化消除**（同一对元素，永不新建）。

---

## 3. 双缓冲与预热策略

### 3.1 为什么不是"复用同一个 `<video>` 改 src"

需求原文写的是「复用同一个 `<video>`：切换只改 `src` + `load()` + `play()`」。
**对在屏元素直接改 src 是被明令禁止的** —— 仓库里有两处判据盯着：

- `src/video-layer.js` 的 `layerStillPending()` 注释：**换源会清掉已上屏的那一帧**，
  屏上只剩层底色；
- 同文件的换源落地条件（只在"层还被闸门押着"或"用户刚主动改过上限"时允许），
  以及 `test/verify-transcode-state.mjs` 对这条不变量的断言。

那是为修「纯色帧」回归加的。照字面做会把它重演一遍。

### 3.2 实际做法：常驻双元素池

`src/video-switch.js` 持有一对**长生命周期**的 `<video>`（`we-pool-1` / `we-pool-2`，
`el.dataset.wePlayerId`），**永不再 `createElement("video")`**：

| 元素 | 角色 |
|---|---|
| 可见的那个 | 挂在 `LAYER_ID` 层里、在屏上播放 |
| 另一个 | **不在屏上**，`preload="auto"` + muted 播放，预热下一张并**等到首帧已解码** |

切换时：

1. 池里挑一个元素（优先"已经带着该 URL 且 `readyState ≥ 2`"的那个）；
2. 把预热好的元素**整体搬进新层**（同文档 reparent `<video>` **不重载** —— iframe 才会）；
3. 交叉淡入 150–250ms；
4. 旧元素**淡出之后**才回到池里当"下一个备用"，此时它已不在屏上，换源安全。

这条路径同时满足：
- **需求 A1 的意图**（元素身份稳定、解码器连续、不卸载重建）；
- **需求 A2 的字面**（双缓冲 + 150–250ms 交叉淡入 + 旧层淡出后释放）；
- **仓库既有不变量**（不在在屏元素上换源）；
- **可断言性**（元素身份 = `wePlayerId`，`createElement("video")` 计数 == 池容量）。

### 3.3 「第二个解码器」怎么被池化解决

`video-layer.js` 当初把预热停在 metadata，理由写得很清楚：**预热会引进第二个 4K
解码器**（实测双解码卡顿）。

池化的答案是**把"第二个解码器"变成有上界的、且本来就已经存在的那一个**：

- 池容量恒为 **2**（`WE_SWITCH_POOL_SIZE`），第三个一律不建；
- 交叉淡化期间本来就会同时存在"旧元素 + 新元素"两个解码器 —— 池化**没有增加**峰值，
  只是把"新建"换成"复用"；
- 预热元素 **muted**，不产生声音；旧元素淡出后 `src` 才被换掉并释放解码器。

### 3.4 预热触发点

| 触发 | 立即/去抖 | 预热到哪 |
|---|---|---|
| `pointerdown` 落在卡片上 | 立即 | **首帧**（改前只到 metadata） |
| `pointerover` 停在卡片上 | 120ms 去抖 | **首帧** |
| 轮播/「下一张」 | 提前 **2 张**，优先"下一张" | **首帧**（改前 1 张、且是"任意下一项"） |

### 3.5 已缓存判定与「已缓存」角标

- `local`（**精确**命中）：这条 URL 自己有 job 且 `done` —— 排障看它。
- `localReady`（**族级**命中）：同内容族任一档落地 —— **面板的「已缓存」角标看它**，
  并且 `mediaProxy` 据此指向 `/folia/local-media/<job>`（读盘）而不是站点代理。
- 族键由 `lib/switch-cache-family.js` 的 `familyKeyOf()` 给出：**只剥**清晰度/编码后缀
  （`-1080p` / `-4k` / `-hevc` …），剥过头会把两张不同壁纸并族 —— 那比原缺陷更糟。
  认不出（token 形态 basename）⇒ 退化成精确匹配，行为与放宽前逐字节等价。

---

## 4. 点击反馈（每个阶段都有可见变化，≤ 50ms 内出现）

| 阶段 | 可见变化 | 时限 |
|---|---|---|
| 按下瞬间 | 卡片 `pressed` 态（缩放/高亮）+ 按钮文案「切换中…」并禁用 + `aria-busy="true"` | **< 50ms**（同步，实测 < 1ms） |
| 已缓存切换 | 双缓冲完成，卡片变 active、播放条标题更新、toast「已切换：<名称>」1.5s | 正常 < 300ms |
| 1.5s 未就绪 | 「正在缓冲 x%…」（不留空白/旧壁纸） | 1.5s |
| 未缓存 | 立刻 封面图 + 进度条 +「x%（a/b MB · 约剩 N 秒）」+「取消」 | 立即 |
| 成功 | 卡片 active + toast 1.5s 自动消失 | — |
| 失败 | 卡片红边 + 原因（连不上 / 404 / 超时 / 解码失败）+「重试」 | — |
| 进阶兜底 | 切换中再点其他卡 ⇒ 队列化最后一个；规则：**保留最后一次点击**，中间的点忽略并 toast「正在切换，请稍候」 | — |

键盘 / 滚轮 / 「下一张」**全部走同一条** `weSwitchBegin()` 状态机，不另写一套。

---

## 5. 指标：`switchLatencyMs`

### 5.1 口径

| 字段 | 定义 |
|---|---|
| `switchLatencyMs` | **点击 → 首帧可见**（元素已上屏且首帧已呈现）的耗时 |
| `clickFeedbackMs` | **点击 → 第一处视觉变化**（pressed 态/DOM 变更）的耗时 |
| `cacheFamilyHit` | 本次是否走了缓存族命中 |
| `is1080p` | 本次播的是不是 1080p 变体 |

`cacheFamilyHit` 是**区分成因 ① 与 ②/⑤ 的唯一字段**：同样 300ms，
`cacheFamilyHit=false` 指向"在等网络"，`true` 则指向"在等解码"。

### 5.2 记录与暴露

- 环形缓冲**最近 20 次**（`WE_SWITCH_STATS_MAX`）；
- 每次同时：
  - `console.log("[folia-switch] {…}")`；
  - `POST /folia/diag/switch-stats`；
- 读回：`GET /folia/diag/switch-stats` → `{ entries: [...], summary: {...} }`，
  `summary` 给 `switchLatencyMs` / `clickFeedbackMs` 的 `{ n, avg, max }`。

### 5.3 示例数据（形态示意）

```
{"at":1730000000000,"slug":"rainy-night.mp4","cacheFamilyHit":true,"is1080p":true,
 "switchLatencyMs":212,"clickFeedbackMs":0,"ok":true,"reason":""}
{"at":1730000060000,"slug":"forest.mp4","cacheFamilyHit":false,"is1080p":false,
 "switchLatencyMs":1418,"clickFeedbackMs":1,"ok":true,"reason":""}
{"at":1730000120000,"slug":"city.mp4","cacheFamilyHit":true,"is1080p":false,
 "switchLatencyMs":188,"clickFeedbackMs":0,"ok":true,"reason":""}
```

读法：第一条是**族命中**（1080p 已落地、切原画）⇒ 走读盘 + 预热命中 ⇒ 200ms 级；
第二条 `cacheFamilyHit:false` ⇒ 在等一次代理中继 ⇒ 1.4s 级。两簇分得很开，
这就是"改前基线 vs 改后"的判别依据。

### 5.4 掉帧提示

`requestVideoFrameCallback` 统计：**< 24fps 且持续 2s** ⇒ 置掉帧结论 ⇒ 面板提示
「建议切换 1080p」并提供按钮。判据只看**在屏的那个元素**，换人即停。

---

## 6. 已知边界

- **4K 解码**：池化把"新建解码器"换成"复用已有解码器"，但**不降低单路 4K 的解码成本**。
  4K60 的 H.264 在部分核显上本身就跑不满 60fps —— 这时 200ms 的交叉淡化也可能掉帧。
  这是**浏览器/硬件边界**，不是切换逻辑能修的；掉帧提示（§5.4）就是为它准备的出口。
- **首帧预热不是零成本**：预热一个元素 = 它真的在解码。池容量 2 保证峰值与既有
  交叉淡化相同，但**空闲时也可能有一个 muted 元素在跑**（TTL 到期/被替换时释放）。
- **`preload="auto"` 的取数**：本地文件代价可忽略；**远端未缓存**的源仍受带宽限制，
  这时 `cacheFamilyHit:false` + 长 `switchLatencyMs` 是**预期内**的，不是回归。
- **Edge 兼容腿**：走镜像 `<canvas>`，首帧判据是"画布第一笔"，比 `<video>` 多一拍；
  本文的时序图描述的是 native `<video>` 那条腿。
- **族键的保守性**：只剥清晰度/编码后缀。站点若用"完全不同的文件名"命名变体
  （例如 `x.mp4` 与 `x_alt.mp4`），族判据认不出来 —— 此时行为退回精确匹配（安全方向）。
