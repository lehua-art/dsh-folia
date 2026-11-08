# 站点侧修复交接单（给持有站点源码的人）

> 仓库：`https://github.com/ZXY20020906/-`（Cloudflare Pages + Functions + D1 `DB` + R2 `BUCKET`）
> 线上：`https://folia-5ve.pages.dev`
> 结论先行：`/media`（404 / immutable / Range / 边缘缓存）**已经是好的，不要改**；
> 真正要修的是**配置漂移**、**上传缺少回读校验**、**视频缺少 faststart/codec 检查**、**缺少对账**。

---

## 0. 千万别动这些（实测已经正确）

```
✅ functions/media/[[path]].js —— 404 JSON、cache-control immutable、Range 206、caches.default 边缘缓存、CORS
   线上证据：不存在对象 → 404 {"code":"not_found"}；真实对象 HEAD → immutable + x-folia-cache: HIT + etag；Range → 206
✅ src/server/storage.js:31   —— R2 putAsset 已带 cacheControl: public, max-age=31536000, immutable
✅ 上传鉴权/体积/MIME 双检     —— wallpapers.js:194-214
✅ 公开接口 ETag/304           —— public.js:89-94，cache-control: max-age=30, stale-while-revalidate=60
```

---

## P0-1 修 `wrangler.toml` 的域名漂移（最高危，先做这条）

```diff
 # wrangler.toml
-database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
+database_id = "64761fc2-cd88-46f4-b08f-c2b08d5b667f"

 [vars]
-PUBLIC_ORIGIN = "https://folia-major-3t6.pages.dev"
+PUBLIC_ORIGIN = "https://folia-5ve.pages.dev"
```

**为什么必须先改**：线上直链来自 `PUBLIC_ORIGIN`（`src/server/storage.js` 的 `publicUrl()`）。
`folia-major-3t6.pages.dev` 是**已下线的旧部署**（实测该域名 `/api/public/wallpapers` 返回 404 HTML、无 Functions）。
按现状部署 ⇒ 所有图片/视频直链写成坏域名 ⇒ 全站裂图。

**验收**：部署后 `curl https://folia-5ve.pages.dev/api/public/wallpapers?limit=1` 返回的 `url` 必须是 `folia-5ve`。

---

## P0-2 上传加「写完回读校验」（消灭"库里有、桶里没有"）

位置：`src/server/routes/wallpapers.js` 的 `upload()`（约 L234）与 `uploadThumb()`（约 L279）

```js
// 现在
await putAsset(env, key, bytes, meta.mime);
if (row.storage_key && row.storage_key !== key) await deleteAsset(env, row.storage_key);
await run(env, Q.updateWallpaperAsset,
  key, meta.mime, bytes.byteLength, meta.width, meta.height, durationMs, sha, nextKind, nowMs(), row.id);

// 改成
await putAsset(env, key, bytes, meta.mime);

const head = await env.BUCKET.head(key);                  // 新增：回读
if (!head || head.size !== bytes.byteLength) {            // R2 写成功 ≠ 对象在/大小对
  await deleteAsset(env, key).catch(() => {});             // 清掉孤儿对象
  throw new HttpError(500, 'storage-verify-failed', 'R2 写入校验失败（对象缺失或大小不符），请重试');
}
const storedBytes = head.size;                             // 用 R2 的真实 size 记账

if (row.storage_key && row.storage_key !== key) await deleteAsset(env, row.storage_key);
await run(env, Q.updateWallpaperAsset,
  key, meta.mime, storedBytes, /* 原来是 bytes.byteLength */ meta.width, meta.height, durationMs, sha, nextKind, nowMs(), row.id);
```

别忘了 `import { ..., HttpError, ... } from '../../core/errors.js';`（`src/core/errors.js:4` 已有该类）。

`uploadThumb()` 同样处理（缩略图缺失会导致列表黑块，同样需要 head 校验）。

---

## P0-3 新增 schema 迁移（为对账/编码留字段）

新建 `schema/012_verify_and_codec.sql`：

```sql
ALTER TABLE wallpapers ADD COLUMN verified_at INTEGER;
ALTER TABLE wallpapers ADD COLUMN missing_reason TEXT;
ALTER TABLE wallpapers ADD COLUMN codec TEXT;
ALTER TABLE wallpapers ADD COLUMN faststart INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_wallpapers_cat_status ON wallpapers(category_id, status);
```

> SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，按编号只执行一次（和 `schema/` 其它文件一致）。
> 执行：`wrangler d1 execute folia --remote --file=schema/012_verify_and_codec.sql`

---

## P1-1 一次性回填 `verified_at`（加过滤的前置条件）

新增 `tools/backfill-verified.mjs`：

```
默认 dry-run，逐个 status='published' 的记录：
  head = R2.head(storage_key)
  · 不存在            → 报告 missing（不要立刻隐藏，先看清单）
  · head.size != bytes → 报告 size-mismatch（建议 UPDATE bytes=head.size）
  · 一致              → 报告 ok
--apply 时写库：verified_at=now；size 不符则同时修正 bytes
输出汇总：检查 N / ok N / missing N / mismatch N
```

**注意顺序**：现在 111 条 `verified_at` 全是 NULL。
若先给公开接口加 `verified_at IS NOT NULL` 过滤，会把现有内容**全部隐藏**。
所以必须：**先跑回填 → 再加过滤**。

---

## P1-2 上传时检测 codec / faststart（先打标记，不要硬拒绝）

位置：`wallpapers.js` upload 中，`meta` 解析之后：

```
对 video/*：
  · 读前 256KB，判断是否含 'moov'（在前 = faststart=1）
  · 读尾部 256KB，判断 moov（在后 = 非 faststart）
  · 搜索 'hvc1' / 'hev1' → codec='hevc'；搜索 'avc1'（在 stsd 里）→ codec='h264'
  · 写入 D1 的 codec / faststart 两列
若 codec='hevc'：允许入库，但返回一个 warning 字段（浏览器默认不解 H.265）
```

**已知存量问题**：47 条壁纸里有 6 条非 faststart（全是「明日方舟」系列），
其中 6 条已由外部修好并换成新 URL；**以后新上传必须带上检测**，否则同样的问题会复发。
修法命令（本地/流水线）：`ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4`（无损，体积几乎不变）。

---

## P1-3 每日对账（Cloudflare Cron 或本机计划任务）

新增 `tools/reconcile.mjs`（复用 P1-1 逻辑，带 `--apply`）：

```
每天跑一次，for 每条 status='published'：
  不存在      → status='hidden', missing_reason='object-missing'
  size 不符   → bytes=head.size, verified_at=now
  一致        → verified_at=now
最后把汇总写 audit_log（便于以后追查"
哪天开始缺的"）
```

挂载方式二选一：
- Cloudflare Cron（推荐，不依赖本机开机）；
- 本机 `schtasks /SC DAILY`。

---

## P2 可选（按需再做）

```
1) >40MB 文件没有 sha256：wallpapers.js:223-233 超 40MB 时 sha=null、key=Date.now()
   → 建议改成"先写临时 key → 取 R2 head 的 etag → copy 成 wallpapers/<id>/<etag前12>.<ext> → 删临时"
   （或者用 multipart upload 分块算哈希）
2) 公开接口无 review_status 过滤（queries.js:13-17）——若你们有审核流程，应补：
   AND (w.review_status IS NULL OR w.review_status='approved')，但需先确认存量数据语义
3) dto.js:1 注释说"不暴露 sha256"，但 :47 实际输出 sha256 —— 要么删字段要么改注释
4) package.json 无 deploy 脚本，建议加 "deploy": "wrangler pages deploy ./public --project-name=folia"
```

---

## 上传规范（以后每条资源都要满足）

```
壁纸视频：H.264/AVC，mp4，必须 faststart；1080p ≤ 8 MB，4K ≤ 20 MB（硬上限 25 MB）；一般无音轨
壁纸图片：JPG/WebP，≤ 3 MB，长边 ≥ 1920
皮肤包  ：zip 根目录含 skin.json；id ^[a-z][a-z0-9-]{0,31}$ 且与目录名一致；
         contributes.stylesheet 指向的文件必须存在；禁止 .exe/.dll/.bat/.cmd/.ps1/.msi/.vbs/.lnk/.jar；
         ≤ 15 MB（复杂皮肤 20 MB）
每条都要有：真实 sha256 + bytes、正确 mime、缩略图 1280×720 WebP/JPG ≤ 150 KB
```

---

## 改完的验收命令（照抄执行）

```powershell
$base = "https://folia-5ve.pages.dev"

# 1. 域名漂移已修：清单里的 url 必须是 folia-5ve
curl.exe -sS "$base/api/public/wallpapers?limit=1" | findstr /i "pages.dev"

# 2. 缺失对象必须是 404 JSON（不是 500）
curl.exe -sS -o NUL -w "http=%{http_code}`n" "$base/media/wallpapers/wp_nope/x.mp4"

# 3. 真实对象必须有 immutable + 边缘缓存
curl.exe -sSI "$base/media/wallpapers/<真实key>" | findstr /i "http/ cache-control x-folia-cache etag"

# 4. Range 必须 206
curl.exe -sS -o NUL -D - -H "Range: bytes=0-1023" "$base/media/wallpapers/<真实key>" | findstr /i "HTTP/ content-range"

# 5. 上传校验生效：故意上传超过 R2 单对象上限/中断的文件，应得到 storage-verify-failed，而不是静默成功
```

---

## 一句话总结

```
必改：wrangler.toml 两行（域名 + D1 id）、上传回读校验（wallpapers.js 两处）、schema/012 加四列
应改：回填 verified_at → 再加公开过滤、上传检测 codec/faststart、每日对账
可选：>40MB 内容指纹、review_status 过滤、dto 的 sha256 暴露、deploy 脚本
```
