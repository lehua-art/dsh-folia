# 站点下载接口 v1（站点侧 + 插件侧，可执行清单）

> 目标只有一个：**用户点一下，5 秒内开始播放；重复使用 0 网络**。
> 判定基线：家用中位吞吐 5 MB/s ⇒ 单资源 ≤ 20 MB；弱网 1–2 MB/s ⇒ 必须有 ≤ 8 MB 的 1080p 变体。
> 本文件是**双方合同**：站点侧做什么、插件侧做什么、怎么验收，逐条可勾选。

---

## 0. 一页结论

| 谁 | 要做的事 | 为什么 |
|---|---|---|
| 站点 | 清单加 `sha256` / `etag` / `variants[]` | 插件才能"内容没变就跳过"、弱网选小变体 |
| 站点 | 确认支持 `Range` + `ETag` + `immutable` 缓存头 | 续传、3 路分片、CDN 长期缓存 |
| 站点 | 资源 URL 带内容哈希（`/media/<sha8>/<name>.mp4`） | 换内容即换 URL ⇒ 缓存永不脏 |
| 站点 | 可选：一个资源挂 2–3 个域名 | 3 路分片打到不同主机，绕开单主机连接数限制 |
| 插件 | 读新字段；分片/续传/HEAD 跳过（**已实现** 4.19.x） | 已上线 |
| 插件 | 按实测带宽选变体；无变体时按本机转码兜底 | 下一步 |
| 插件 | 面板显示"命中/首次下载/实测 MB/s"（**已实现** 4.19.1） | 用户能自证快慢 |

---

## 1. 站点侧（必须做）

### 1.1 清单字段（`GET /api/public/wallpapers?category=…`）

`data.items[]` 每条新增/确认：

```json
{
  "slug": "blue-throated-bee-eater",
  "title": "蓝喉蜂虎",
  "type": "video",
  "bytes": 18432000,
  "sha256": "9f2c…（整文件十六进制，小写）",
  "etag": "\"9f2c…\"",
  "url": "https://cdn.example.com/media/9f2c1a7b/wallpaper.mp4",
  "thumbUrl": "https://cdn.example.com/media/9f2c1a7b/thumb.jpg",
  "variants": [
    { "label": "4k",    "bytes": 18432000, "width": 3840, "height": 2160, "url": "…/wallpaper-4k.mp4" },
    { "label": "1080p", "bytes":  6200000, "width": 1920, "height": 1080, "url": "…/wallpaper-1080p.mp4" }
  ]
}
```

规则：

```
· bytes 必须是真实字节数（插件用它决定要不要分片/选变体）
· sha256 可选但强烈建议；缺了就退回"按 URL + 长度"判重（精度下降）
· variants 可选；有就必须按 bytes 升序、至少含一个 ≤ 8 MB 的档
· 所有 URL 必须是**同域**（插件只允许与站点同 host，否则拒绝 —— 防开放代理）
```

### 1.2 HTTP 语义

```
· 必须支持 HEAD（返回 content-length + etag + accept-ranges）
· 必须支持 Range: bytes=a-b（206 + content-range）；分片并发靠它
· 资源响应头：
    ETag: "…"
    Cache-Control: public, max-age=31536000, immutable
    Content-Type 正确（video/mp4 / image/jpeg / application/zip）
· 404/403 时**不要**返回 200 的 HTML 错误页（会让插件把 HTML 当视频）
```

### 1.3 上传规格（控制"5 秒"）

| 类别 | 上限 | 备注 |
|---|---|---|
| 缩略图 | 150 KB | WebP/JPEG，宽度 ≤ 640 |
| 桌宠包 | 3 MB | zip |
| 开机动画 | 10 MB | mp4 (H.264) |
| 皮肤包 | 15 MB | zip（css + 资产 + hooks） |
| 壁纸视频 1080p | **8 MB** | H.264，30fps，≤ 8 Mbps |
| 壁纸视频 4K | **20 MB**（硬上限 25 MB） | H.265 或 H.264 high，≤ 20 Mbps |

> 超过上限的资源必须**同时**提供 1080p 变体，否则弱网用户不可能 5 秒。

### 1.4 可选加速（不改协议，收益最大）

```
· 同一个资源挂 2–3 个域名（pages 域 + 自定义域 + R2 直连域）
· 插件会把 3 路分片分别打到不同 host（名单由清单里的 `mirrors[]` 给出或按约定域名轮转）
· 清单可带：
    "mirrors": ["https://cdn-a.example.com", "https://cdn-b.example.com"]
```

---

## 2. 插件侧（我们做）

### 2.1 已实现（4.19.x，用户装了就有）

```
· 队列：并发 3、Range 续传、URL 去重、原子完成（完成才 rename）、单任务失败隔离
· ≥8 MB 且 accept-ranges ⇒ 3 路分片并发（大小不符整次失败）
· 下载前 HEAD：长度 + etag 与本地 sidecar 一致 ⇒ 整次跳过
· 皮肤包走同一条队列（先落盘再解压）
· 面板自述：缓存命中 / 首次下载 / 实测 MB/s / 缓存不可写告警
· 上限 2 GiB（DSH_FOLIA_SITE_CACHE_MB 可调）、只允许与站点同 host
```

### 2.2 下一步（本文档的插件侧任务）

```
① 读 variants[]：清单有变体时按"实测吞吐"选档
   - 首播前 2 秒测速（用当前下载的瞬时速率）< 2 MB/s ⇒ 切 1080p 并记住该资源的选择
   - 无变体 ⇒ 不改行为（先播后缓存）
② 读 sha256/etag：本地索引存"内容哈希"，同内容不同 URL 也能命中
③ mirrors[]：3 路分片分配到不同 host（同一 host 最多 2 路）
④ 站点没给变体时的兜底：本机 ffmpeg 转 1080p 副本并优先播（已有转码能力，复用抽帧链路）
⑤ 缓存命中率/速度写进诊断页（面板那行已够，再给"导出诊断"按钮）
```

---

## 3. 验收（站点侧改完后，照着跑）

```powershell
# ① 清单是否带新字段
curl.exe -sS "https://<site>/api/public/wallpapers?category=wallpaper&limit=1"

# ② HEAD 是否给长度/etag/range
curl.exe -sSI "https://<cdn>/media/<sha8>/wallpaper-1080p.mp4"

# ③ Range 是否 206
curl.exe -sS -o NUL -D - -H "Range: bytes=0-1023" "https://<cdn>/media/<sha8>/wallpaper.mp4"

# ④ 缓存头是否 immutable
curl.exe -sSI "https://<cdn>/media/<sha8>/thumb.jpg" | findstr /i cache-control
```

插件侧验收（用户视角）：

```
· 点一张未缓存的站点壁纸：面板出现"首次下载 x%"→ 播完一行"平均 x MB/s"
· 再点同一张：**0 网络**（stats 的 hits+1、misses 不变）
· 弱网（限速 1 MB/s）：自动落到 1080p 变体，5 秒内出画面
· 断网重连：从已下载字节续（stats 的 avgMBps 反映真实速率）
```

---

## 4. 明确不做

```
· 不做全量预缓存（100 张 4K ≈ 4 GB，用户的盘不是我们的）
· 不把站点整站镜像到本地
· 不为了"5 秒"偷偷降清晰度而不告诉用户 —— 面板会写明当前播的是哪一档
```
