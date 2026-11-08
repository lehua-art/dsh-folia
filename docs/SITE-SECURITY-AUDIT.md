# 站点安全审计报告（folia 站点）

> 目标：`https://folia-5ve.pages.dev`（源码 `ZXY20020906/-`，本地 `folia-admin`）
> 时间：2026-11-03 · 当前 canonical 部署 `db71430a`
> 原则：只列**有证据**的项（`文件:行号` 或线上探测实测）；无证据的不写结论。

## 严重度

| 级别 | 含义 |
|---|---|
| Critical | 未授权读写数据 / 可执行代码 |
| High | 越权、注入、管理员 XSS |
| Medium | 需特定条件才能利用 |
| Low | 信息泄漏 / 纵深防御缺失 |
| Info | 设计取舍，记录备查 |

---

## 一、发现的问题（15 项，按严重度）

| # | 问题 | 证据 | 级别 | 建议 |
|---|---|---|---|---|
| 1 | 公开列表仍下发"对象已丢失"的 URL（1 条），客户端必现 404 | `queries.js:13` 无 verified 过滤；D1 111 条里 verified=110/missing=1；`/media/…yomiya` → 404 | 中 | 重传该文件或 `--hide-missing`，再按 `docs/reconcile.md` 加过滤 |
| 2 | Range 越界返回 200 + 全量文件（应 416） | `functions/media/[[path]].js:50`（`start>=size → null`）；探测 `Range: bytes=999999999-` → 200 / 44,848,486 | 中 | 无效 Range → `416` + `content-range: bytes */<size>` |
| 3 | 公开 API 无限速；边缘缓存 key 含全部 query，随机参数可绕过缓存 | `app.js:164` `cacheKey=url.toString()`；公开路由无 limiter；实测同 URL 第二次 HIT、改参数 MISS | 中 | 上 Cloudflare Rate Limiting；缓存键忽略未知参数 |
| 4 | `/api/setup` 被门禁永久挡住，空库时无法 HTTP 初始化 | `gate-middleware.js:27-32` AUTH_EXEMPT 未含它；`app.js:29` 声明 auth none；探测 → 401 site_locked | 中（功能缺陷） | 加进 AUTH_EXEMPT（它自带 BOOTSTRAP_TOKEN + countUsers 校验） |
| 5 | 下线/草稿的 `/media` 对象仍公开可取且 immutable（下线不撤文件） | media handler 不查 D1；`gate-middleware.js:46` 放行 `/media/`；1 年 immutable | 中低 | 下线时删对象，或改签名 URL |
| 6 | 口令哈希 PBKDF2-SHA256 仅 10 万次（低于 OWASP 建议） | `password.js:11-12` | 中低 | 加 Turnstile + 强口令策略；或外部 IdP |
| 7 | 登录限流只在 isolate 内存（非全局）；上传无限流 | `rate-limit.js:2-7`、`auth.js:39-42`；上传路由无 `hit()` | 低 | D1/DO/KV 计数或 Cloudflare Rate Limiting |
| 8 | 插件用的 `/api/plugin/feed`、`/api/public/categories`、`/api/public/wallpapers/:slug` 声明公开却被门禁 401 | 三路径实测 401；白名单只有 `/api/public/wallpapers`（`gate-middleware.js:45`） | 低（不一致） | 同步白名单，或文档明确插件只用列表接口 |
| 9 | 会话注释写"30 分钟闲置"，常量是 60 分钟；7 天绝对过期不续期 | `session.js:8` vs `:23/:109/:166` | 低 | 统一常量与注释；续期需更新 `expires_at` |
| 10 | 标签是自由文本，`% _ "` 进入 LIKE（参数化无注入，但匹配变宽） | `validate.js:138-151`、`wallpapers.js:65` | 低 | `cleanFreeTags` 限制字符集 |
| 11 | `/media` CORS `*` 且无来源校验，可被外站热链盗带宽 | `media:11-16`；实测 `access-control-allow-origin: *` | 低 | 接受嵌入则保持；否则签名/Referer 白名单 |
| 12 | `/__gate` 登录表单无 CSRF token，SameSite=Lax 不阻止跨站 top-level POST | `gate-middleware.js:154-187`；`session.js:63` Lax | 低 | 一次性 form token 或校验 Origin |
| 13 | 删成员口令用 sha256 后 `!==` 比较（非常量时间），无尝试限流 | `members.js:147-148` | 低 | 改 `constantTimeEqual` |
| 14 | 90 MB 上传整块 `arrayBuffer()` 缓冲，128 MB Worker 内存下有 OOM 风险 | `wallpapers.js:219`、`image-meta.js:9-11` | 低 | 流式上传或下调包上限 |
| 15 | `DEBUG_API=1` 时 500 带 stack/message | `app.js:194-202`（默认关闭） | 信息 | 保持默认关闭 |

---

## 二、查了**没有**问题的项（含检查范围）

| 项 | 结论 | 检查范围 |
|---|---|---|
| SQL 注入 | 未发现 | `db.js:8/13` 全部 `prepare().bind()`；`queries.js` 模板插值只有常量；探测 `category=' OR 1=1--` → 200 空结果，无 500 |
| XSS | 未发现 | `gallery.js:69`、`admin/app.js:26` 统一 `esc()`；toast 用 `textContent`；`content-disposition` 对 CRLF/引号清洗（探测 `?download=%22%0d%0aXInjected%3Ayes` → 只得到 `XInjected yes`） |
| 权限覆盖 | 未发现缺口 | members/categories/tags/subtags/audit/wallpapers 全查；editor 不能发布/删除/改他人作品 |
| 响应头 | 齐全 | CSP、XFO、nosniff、HSTS、COOP、CORP、Permissions-Policy 均在实测响应上 |
| 路径穿越 | 未发现 | `media:58` 拒绝 `..`；探测 `/media/%2e%2e%2f..` → 400（CF 层拦截） |
| 仓库卫生 | 干净 | 无 `.dev.vars`、无 `.bak`、无 token 字面量；`.gitignore` 覆盖 `.dev.vars`；`app.js.bak` 已从 HEAD 删除 |

---

## 三、部署与线上验收（本次已执行）

```
部署：wrangler pages deploy ./public --project-name=folia --branch=main --commit-dirty=true → exit 0
      ✨ Deployment complete! https://db71430a.folia-5ve.pages.dev
canonical：production_branch=main，canonical_deployment=db71430a
```

| 验收项 | 实测 |
|---|---|
| `/api/public/wallpapers?limit=2` | 200，total=111，url 域名 `https://folia-5ve.pages.dev/media/...` ✅ |
| `/media/<不存在>` | 404 + `application/json` + `no-store` + CORS ✅ |
| 真实对象 HEAD | 200 + `immutable` + `x-folia-cache: HIT` + content-length 正确 ✅ |
| Range `bytes=0-99` / `bytes=-100` | 206 + 正确 content-range ✅ |
| Range 越界 | 200 全量（问题 #2）❌ |
| OPTIONS `/api/public/wallpapers` | 204 + CORS ✅ |
| `limit=abc` / `sort=bogus` | 400 ✅ |
| 注入串 / 不存在路径 | 200 空结果 / 401（不泄漏路由）✅ |

---

## 四、本次同时完成的数据修复

```
执行 schema/012（线上 D1，5 条语句全部 success）：verified_at / missing_reason / codec / faststart + 索引
回填 --apply：111 条写入，verified=110，missing=1，失败 0
修正 4 条历史 bytes（diy-journal / midnight-contract / rainy-night / whalechan-harness）
仍未解决：yomiya-宵宫-动态版（wp_bc3f5d6892cef16e55e59cb7）对象缺失 → 需重传或隐藏
```

---

## 五、修复优先级

```
立即：无 Critical/High（本次未发现）
本轮：Medium 4 条（#1 缺失项、#2 Range 416、#3 限速与缓存键、#4 /api/setup 白名单）
顺手：Low 11 条，尤其 #7 全局限流、#12 登录 CSRF、#5 下线撤文件
```
