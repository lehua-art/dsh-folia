# Folia 问题总清单（截至 2026-11-03 19:30）

> 口径：只统计**有证据**的问题；每条标注「已修 / 待修 / 待部署 / 需你操作」。
> 站点仓库：`ZXY20020906/-`（本地克隆 `folia-admin`）；插件：`dsh-folia`（npm latest = 4.23.1）

## 一、站点数据类（影响所有人）

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| 1 | 61 套皮肤在 R2 里不存在，点了 500 | D1 有记录、R2 `wallpapers/` 只有 5 个旧对象；用户截图 `http-500` | ✅ 已修（61 套重传 + 61 条 published） |
| 2 | 57 条记录 bytes 与实际文件不符 | 校验脚本 57 条 SIZE_MISMATCH（如 catppuccin 108062 vs 78857） | ✅ 已修（bytes 校正，复验 61/61 全绿） |
| 3 | 3 套皮肤无任何源文件 | gilded / whale-dream / crimson-porcelain（后者 bytes=0，当初就没传成功） | ⏳ 待你提供原件；已保持 hidden 避免用户点到 500 |
| 4 | 6 条壁纸未 faststart（moov 在文件尾） | 47 条里 6 条（全是「明日方舟」），浏览器需基本下完才起播 → 报"无法解码" | ✅ 已修（无损重封装 + 换新哈希 URL，47/47 复查通过） |
| 5 | 111 条记录没有 `verified_at` | schema 无该字段；上传不校验 | ⏳ 待修（先回填，再加过滤） |

## 二、站点代码类（需要改源码 / 部署）

| # | 问题 | 位置 | 严重度 | 状态 |
|---|---|---|---|---|
| 6 | `PUBLIC_ORIGIN` 指向已下线域名 `folia-major-3t6` | `wrangler.toml:19` | **P0 极高** | 🟡 本地已改，待部署（不改就部署 = 全站直链裂图） |
| 7 | D1 `database_id` 是占位符 | `wrangler.toml:10` | **P0 高** | 🟡 本地已改（填真实 id） |
| 8 | 上传写完不校验 R2（无 `head`） | `wallpapers.js:234-242` | **P0 高** | 🟡 本地已改（回读校验 + 真实 size 记账），待部署 |
| 9 | 缩略图上传同样不校验 | `wallpapers.js:279-282` | P1 | ⏳ 待改（同 #8 处理） |
| 10 | >40 MB 文件无 sha256、无去重、key 用 `Date.now()` | `wallpapers.js:223-233` | P1 | ⏳ 待改（用 etag 做指纹，或分块算哈希） |
| 11 | 上传不检查 codec / faststart | `image-meta.js:211` 只读时长 | P1 | ⏳ 待改（先打标记，勿硬拒绝） |
| 12 | 无每日对账（文件丢了没人发现） | 全仓库无 reconcile | P1 | ⏳ 待加（Cron 或计划任务） |
| 13 | 公开接口只判 `storage_key IS NOT NULL`，不验 R2 真实存在 | `queries.js:13-17` | P1 | ⏳ 待改（回填 verified 后加过滤） |
| 14 | 公开接口无 `review_status` 过滤（不审即发） | `queries.js:13-17` | P2 | ⏳ 待你确认业务语义 |
| 15 | `dto.js:1` 注释说不暴露 sha256，但 `:47` 实际输出 | `dto.js:1,47` | P2 | ⏳ 二选一（删字段 or 改注释） |
| 16 | 无 `variants` / 多尺寸（大文件只能整包拉） | `dto.js:21-47` | P2 | ⏳ 待做（1080p 变体） |
| 17 | 无 deploy 脚本，全靠手敲 wrangler | `package.json` | P2 | ⏳ 待加 |
| 18 | 6 条 faststart 修复的**旧 R2 对象未删**（保留回滚） | R2 `wallpapers/` | P2 | ⏳ 一周后确认再删 |

## 三、插件侧（dsh-folia，已发布 4.23.1）

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| 19 | 一次网络失败后 job 永久 `failed`，怎么点都不行 | `error:"fetch failed"` 后重试秒失败；旧 `add()` 不重置 failed | ✅ 4.23.1 已修（failed/cancelled → queued，`.part` 续传） |
| 20 | 瞬时错误无自动重试 | 同上 | ✅ 4.23.1 已修（安装内自动重试一次） |
| 21 | 错误提示只有裸 `failed` | 面板「操作失败：failed」 | ✅ 4.23.1 已修（网络/404/500/超时分级文案） |
| 22 | `~/.dsh` 残留状态文件会把皮肤根劫持走 | 门禁 08 假红 10 条；真实机会导致"皮肤一套都看不到" | ✅ 4.23.1 已修（$DSH_HOME 优先） |
| 23 | 本机仍装 4.22.1（不含上述修复） | profile `node_modules/dsh-folia` = 4.22.1 | ⏳ 需你操作：插件市场 → 卸载 → 重装 4.23.1 → 重启 |
| 24 | 站点凭据注入层已加，但站点未开校验 | `lib/site-auth.js` | ⏳ 预留（等订阅制/私有时启用） |

## 四、运维 / 收尾类

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| 25 | 两枚 npm 令牌进过对话日志 | `npm_voF4…`（DSH-Publish-3）、`npm_C7XM…` | ⏳ 请去 npm 删除并重生成 |
| 26 | 4.23.0 暂存记录卡在 `validating` | stage id `e4bfffc2-…`，不影响 4.23.1 | ⏳ 想清就 `npm stage reject e4bfffc2-… --otp <6位>` |
| 27 | 本地两份站点副本 | `.recon-site-src`（侦察用）、`folia-admin`（改动用） | ⏳ 可删 `.recon-site-src` |
| 28 | 发布令牌过期无预警 | DSH-Publish-2 今天到期才发现 | ⏳ 建议：发版前先 `whoami` + 检查令牌有效期（已写入 RELEASE-GUARD 待补） |

## 优先级建议（按"修了收益最大"排序）

```
1. #6 #7（wrangler.toml 两行）—— 不改就别部署，否则全站裂图
2. #8（上传回读校验）—— 从根上杜绝"库里有、桶里没有"
3. #23（本机升到 4.23.1）—— 否则你测的是旧行为
4. #5 + #12（回填 verified_at + 每日对账）—— 让"文件丢了"能被自动发现
5. #11（codec/faststart 检测）—— 防止 #4 那种问题复发
6. 其余 P2 按需
```

## 已交付的修复（可对外说明）

```
· 站点：61 套皮肤恢复可下载（61/61 复验通过）、57 条 bytes 校正、6 条壁纸 faststart 重做
· 插件：4.23.1 上 npm（失败重试 + failed job 重置 + 错误文案 + DSH_HOME 优先），门禁 20/20、审计 76/52/0/128
· 仓库：3da0279 已推送，新增 docs/SITE-MEDIA-CACHE.md、docs/SITE-FIX-SPEC.md、docs/RELEASE-GUARD.md
```

## 六、本轮收尾后状态（2026-11-03 20:30）

| 项 | 结果 | 证据 |
|---|---|---|
| 站点代码 | commit `6bce9c3` 已推送；远端基线 `d7a134d`，快进合并，未覆盖对面 3 个提交 | `origin/main` = `6bce9c3`，`d7a134d` 是它的祖先，ahead/behind = 0/0 |
| 部署 | `ba050656` → canonical `folia-5ve.pages.dev` | 线上接口 200，带 `x-folia-edge` 头 |
| 测试 | 185 pass / 0 fail；`check-syntax` exit 0（39 模块 + 1 脚本） | 本轮实跑 `node tools/run-tests.mjs`、`node tools/check-syntax.mjs` |
| 审计 Medium 4 条 | ✅ 已修：Range 416、缓存键白名单 + 限速、`/api/setup` 白名单、yomiya 隐藏 | 内容同在 `6bce9c3` 提交里 |

### schema/013 执行结果

- 执行前：`PRAGMA table_info(wallpapers)` 28 列、无 `content_fingerprint`；`sqlite_master` 无 `upload_usage` → 两条都缺失，需要执行。
- `013_fingerprint.sql`（`ALTER TABLE wallpapers ADD COLUMN content_fingerprint TEXT`）：**成功**，HTTP 200 / `success:true`、`rows_written=1`；执行后 29 列，`content_fingerprint` 为第 29 列（cid=28，TEXT）。
- `013_upload_usage.sql`（`CREATE TABLE IF NOT EXISTS upload_usage`）：**成功**，HTTP 200 / `success:true`、`changed_db:true`；表已存在，`(day, actor_id)` 复合主键，`bytes INTEGER NOT NULL DEFAULT 0`，当前 0 行。
- 跳过 0 条、失败 0 条。（首次请求体被 API 以 `7400 Invalid property: sql` 拒绝，未执行任何 SQL；修正请求格式后重发成功。）

### yomiya-宵宫-动态版 收尾

- 行 `wp_bc3f5d6892cef16e55e59cb7` / slug `yomiya-宵宫-动态版`：`status=hidden`、`missing_reason=object-missing`，`updated_at` 刷新为 2026-11-03 20:19:05。
- R2 复核：`wallpapers/wp_bc3f5d6892cef16e55e59cb7/a67a7084bd9a.mp4` → HTTP 404 / `10007 The specified key does not exist.`
- 线上：`GET /api/public/wallpapers?limit=100` 的 `total=110`（published=110 / hidden=111 / draft=11），两页共 110 条中不含该 slug 与 id。
- 注：执行前该行已是 hidden（上次更新 2026-10-30 00:20:33），所以 total 不是本轮从 111 掉到 110，本轮只刷新了 `updated_at`。

### 仍存在

- 限速只在 isolate 内存里计数，多 isolate 下会被放大 → 需在 Cloudflare 控制台加 Rate limiting 规则。
- CSRF 跨 isolate 重放返回 401（不是 403），语义待统一。
- 3 套皮肤仍无源文件（gilded / whale-dream / crimson-porcelain），继续保持 hidden。
- 本机插件仍装 4.22.1，待升 4.23.1（见 #23）。
