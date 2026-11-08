# 1080p variants 上线验证报告（只读）

站点：https://folia-5ve.pages.dev
接口：GET /api/public/wallpapers?category=wallpaper&limit=50
验证时间：2026-11-04（Asia/Shanghai）
操作性质：仅 GET / HEAD，未修改 D1 / R2 / 任何线上数据

## 0. 翻页

- 第 1 页 `limit=50` 返回 46 条，`hasMore=false`，`nextCursor` 为空，`total=46` → 单页即全量，无需翻第二页。
- 46 条全部 `kind=dynamic`（视频），`mime=video/mp4`。

## 1. variants 覆盖统计

| 指标 | 值 |
| --- | --- |
| 总条数 | 46 |
| 有 variants（非空） | 29（63.0%） |
| 无 variants | 17 |
| variants 档数 | 每条均为 1 档（`label=1080p`、`height=1080`），平均 1.00 档 |
| 压缩比 min | 2.90% |
| 压缩比 中位 | 26.20% |
| 压缩比 平均 | 23.16% |
| 压缩比 max | 36.58% |
| 29 条合计原画 | 544,836,396 B（519.6 MiB） |
| 29 条合计 1080p | 106,755,902 B（101.8 MiB） |
| 合计节省 | 438,080,494 B（417.8 MiB），整体字节降 80.4% |

### 前 5 条带 variants（按原画 bytes 降序）

| slug | 原画 bytes | variants[0].bytes | 压缩比 | variants[0].url |
| --- | --- | --- | --- | --- |
| hatsune-miku-海色 | 51,676,787 | 1,498,279 | 2.90% | /media/wallpapers/wp_b672491a3ead446580199db6/e6ca2d3f162e.1080p.mp4 |
| 原神-钟离 | 47,231,464 | 7,861,004 | 16.64% | /media/wallpapers/wp_725bd3c5723a99c583b48de6/ab1a59bb37b3.1080p.mp4 |
| erase-小鸟游星野 | 47,194,381 | 17,249,383 | 36.55% | /media/wallpapers/wp_56aafe86ae2d6e9ba92eefe4/e28829340171.1080p.mp4 |
| 熊出没下坠 | 44,594,959 | 9,920,856 | 22.25% | /media/wallpapers/wp_6cee4fdab267accffbb8c52c/1cb97909f58e.1080p.mp4 |
| 哲风壁纸-微风草地-暖色调 | 38,670,904 | 5,324,026 | 13.77% | /media/wallpapers/wp_5a5c9047e222a147f3c57f93/eaaa5471168b.1080p.mp4 |

## 2. 直链验证（原画最大的 3 条，HEAD）

| slug | 目标 | status | content-length | 与 API bytes 一致 | content-type | cache-control | accept-ranges |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hatsune-miku-海色 | variants[0] | 200 | 1,498,279 | ✅ | video/mp4 | public, max-age=31536000, immutable | bytes |
| hatsune-miku-海色 | 原画 | 200 | 51,676,787 | ✅ | video/mp4 | 同上 | bytes |
| 原神-钟离 | variants[0] | 200 | 7,861,004 | ✅ | video/mp4 | 同上 | bytes |
| 原神-钟离 | 原画 | 200 | 47,231,464 | ✅ | video/mp4 | 同上 | bytes |
| erase-小鸟游星野 | variants[0] | 200 | 17,249,383 | ✅ | video/mp4 | 同上 | bytes |
| erase-小鸟游星野 | 原画 | 200 | 47,194,381 | ✅ | video/mp4 | 同上 | bytes |

附加：全部 29 条 variants URL 都做了 HEAD 扫描 → 0 失败，content-length 全部精确等于 API `bytes`，content-type 全为 video/mp4。

## 3. 速度对照（hatsune-miku-海色，原画 51.7 MB > 35 MB）

| 资源 | bytes | run1 | run2 | 中位 ms | 中位速度 |
| --- | --- | --- | --- | --- | --- |
| 原画 | 51,676,787 | 10,881 ms（4.53 MB/s） | 7,456 ms（6.61 MB/s） | 10,881 | ~4.5 MB/s |
| 1080p | 1,498,279 | 625 ms（2.28 MB/s） | 360 ms（3.97 MB/s） | 625 | ~2.3 MB/s |

- 时间缩短：10,881 ms → 625 ms = **17.4x**（下载阶段）
- 字节减少：1 - 1,498,279/51,676,787 = **97.10%**（带宽受限链路上理论 ~34.5x）
- 弱网投影（该条）：5 Mbps 下 83 s → 2 s
- 弱网投影（中位条目 9.4 MB → 1.8 MB）：5 Mbps 下 15 s → 3 s（5.3x）；10 Mbps 下 8 s → 1 s

## 4. 1080p 真实性 + faststart

前 256 KB 原子扫描：

| 资源 | ftyp | moov | mdat | faststart |
| --- | --- | --- | --- | --- |
| 1080p（miku） | @4 | @36 | @8096 | ✅ moov 前置 |
| 原画（miku） | @4 | @28 | @108765 | ✅ |

ffprobe（完整下载后）：

| 资源 | codec/profile | 分辨率 | fps | 时长 | 码率 | size |
| --- | --- | --- | --- | --- | --- | --- |
| 原画 | h264 Main | 2000x1124 | 30/1 | 20.000000 s | 20.31 Mbps | 51,676,787 |
| 1080p | h264 High | 1922x1080 | 30/1 | 20.000000 s | 0.596 Mbps | 1,498,279 |

- 时长差 0.000 s（< 0.5 s）✅
- 高度正好 1080；宽度 1922 = 2000/1124×1080 按比例缩放，符合“height=1080”语义，非固定 1920 宽
- 码率降 34x（20.31 → 0.60 Mbps）

## 5. 异常与待跟进

| # | 现象 | 判定 | 影响 |
| --- | --- | --- | --- |
| A | 6 条 2026-11-03 17:23–17:24 新条目（`明日方舟arknightsアークナイツ` 系列，含 -2/-3/-5/-6/-7）`width/height/durationMs` 全为空，且无 variants；但原画 URL 200、content-length 与 API bytes 一致、可播 | **真异常**：上传成功但 media probe 元数据写入失败，variants 因此未生成 | 这 6 条只能走原画（最大 27.9 MB），弱网收益为 0 |
| B | 11 条老条目（2026-10-29 ~ 10-31 01:00，元数据完整）无 variants，合计 313.7 MB，含 47.9 MB / 44.8 MB / 43.3 MB 三个大文件 | 上线前入库，**未回填** | 老热门大文件仍全量下载 |
| C | 对照：同系列 `明日方舟arknightsアークナイツ-4`（3840x2160, 3.35 s）元数据完整 → 已生成 1080p（523,756 B, 23.3%） | 说明生成管线本身可用 | 佐证 A 是 probe 环节问题 |
| D | 无 404、无 bytes 为 0、无 content-length 不符、variant sha256 全非空 | 无异常 | — |

## 6. 结论

1. **variants 已上线**：29/46 条具备 1080p，数据契约与服务端 HEAD 全对齐（29/29 content-length 精确匹配，cache-control immutable、accept-ranges bytes、video/mp4 全符合）。
2. **弱网收益显著**：中位条目 9.4 MB → 1.8 MB（字节 -81%，约 5.3x 时间）；重载条目 51.7 MB → 1.5 MB（字节 -97.1%，实测 17.4x，理论 ~34.5x）；带 variants 的 29 条整体请求字节降 80.4%。
3. **faststart OK**：1080p 与 原画均把 moov 放在文件头（1080p 在 @36），可边下边播。
4. **1080p 真实**：1922x1080（按高缩放）、时长与原画完全一致（20.000 s vs 20.000 s）。
5. **待跟进**：（A）6 条 11-03 新条目的 probe 元数据缺失需排查重跑；（B）11 条老条目需回填 variants。两项均属修复动作，本次未执行。

## 附：证据文件

- `_verify_items.json`：46 条 API 原始记录
- `_verify_head.json`：3 条 HEAD 结果
- `_verify_speed.json`：2 轮下载计时
