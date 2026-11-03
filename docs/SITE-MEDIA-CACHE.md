# 站点侧改造：`/media` 长缓存（immutable）+ 正确 404 + Range

> 参考实现：本仓库 docs/site-media-function.example.js（部署到站点仓库的 functions/media/[[path]].js）

> 目标：第二次及以后几乎 0 回源；失效/缺失文件返回 404（不再是 500）；大文件支持断点续传。
> 代码：`D:\folia-recover\media-function.js`（直接作为 `functions/media/[[path]].js` 使用）

---

## 0. 先确认它现在长什么样（不要盲改）

```powershell
# 在站点仓库里找现有的 media 路由
Get-ChildItem -Recurse -Include *.js,*.ts -Path functions 2>$null | Select-String -Pattern "media" -List | Select-Object -First 10
```

两种情况：

- **已有 `functions/media/...`**：把它的 body 换成新实现的逻辑（保留你们已有的鉴权/签名逻辑，只替换"取对象 + 组装响应"那段）
- **`/media` 由 Pages 的静态资源直出（R2 自定义域/绑定）**：那就改为新增 Function 接管 `/media/*`

---

## 1. 放置文件

```
站点仓库根/
└── functions/
    └── media/
        └── [[path]].js      ← 内容取 D:\folia-recover\media-function.js
```

要点：

- `[[path]]` 是 catch-all，能接住 `/media/a/b/c.zip`
- 绑定名必须是 **`BUCKET`**（你们 Pages 项目里就是这个名字；不确定就打开
  Dashboard → Workers & Pages → folia → Settings → Functions → Bindings 核对）
- 若你们用 `.ts`，把文件后缀改 `[[path]].ts`，内容无需改（就是标准 Request/Response）

---

## 2. 部署

```powershell
# 方式一（本地部署）
npx wrangler pages deploy . --project-name=folia

# 方式二（Git）：push 到 main，Pages 自动构建部署
git add functions/media/[[path]].js
git commit -m "perf(media): immutable cache, proper 404, range passthrough"
git push
```

> Pages Functions 的响应**默认不被边缘缓存**，所以新实现里用 `caches.default` 显式写入
> （`context.waitUntil(cache.put(...))`），这是"第二次几乎瞬开"的关键。

---

## 3. 验收（4 条，缺一不算成功）

```powershell
$u = "https://folia-5ve.pages.dev/media/wallpapers/wp_fcaef9b7a58c082bae06e219/715028863ae3.zip"

# ① 首次：应 MISS/无命中，且响应头带 immutable
curl.exe -sSI $u | findstr /i "HTTP/ cache-control etag accept-ranges content-length x-folia-source"

# ② 再次：应命中边缘缓存（x-folia-source: edge-cache），且明显更快
curl.exe -o NUL -w "ttfb=%{time_starttransfer}s total=%{time_total}s`n" $u
curl.exe -sSI $u | findstr /i "x-folia-source"

# ③ Range：应 206 + content-range
curl.exe -sS -o NUL -D - -H "Range: bytes=0-1023" $u | findstr /i "HTTP/ content-range"

# ④ 不存在：应 404（不是 500）
curl.exe -sS -o NUL -w "http=%{http_code}`n" "https://folia-5ve.pages.dev/media/wallpapers/wp_does-not-exist/x.zip"
```

期望结果：

| 检查 | 期望 |
|---|---|
| ① 响应头 | `cache-control: public, max-age=31536000, immutable`、`etag`、`accept-ranges: bytes` |
| ② 第二次 | `x-folia-source: edge-cache`，`time_total` 很小（同城通常 < 100 ms） |
| ③ Range | `206` + `content-range: bytes 0-1023/<total>` |
| ④ 缺失 | `404` + `{"code":"not_found"}` |

---

## 4. 与插件侧的关系（为什么这条对所有人都有效）

```
· 插件里的站内缓存（cache/site-media）会命中 → 本机 0 请求
· 边缘缓存（本文件的 caches.default）会命中 → 同城/同运营商用户不回源 R2
· 浏览器缓存（immutable）会命中 → 刷新、重新打开都不重下
三层叠加：第一次慢一次，之后基本瞬开
```

**注意**：若某天要"换掉某个文件的内容"，**必须换 URL（新哈希）**，否则用户一年内都会看到旧文件。
你们现在的 URL 已带 `sha256[:12]`，天然满足。

---

## 5. 可选项（更省事的替代方案）

```
① R2 自定义域（media.your-domain.com）直出对象，不走 Function：
   优点：少一跳、边缘缓存行为更标准
   缺点：要改清单接口里的 url 生成逻辑
② Cloudflare Cache Rules：对 /media/* 设 "Eligible for cache + Edge TTL 1 year"
   —— 但它对 Pages Functions 动态响应不一定生效，所以首推本文件的 Cache API 实现
```
