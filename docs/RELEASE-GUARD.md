# 发布护栏：把"只在我机器上生效"的修复变成"所有人都生效"

> 这条是从一次真实事故里写下的：问题在用户机器上被发现 → 我在本机修好了代码 →
> **但没有发 npm**，于是别人装到的还是旧版，同一个 bug 继续在他们机器上出现。
>
> 结论：**修复的完成定义是「发到 npm 且验证过安装」**，不是「本机能跑」。

---

## 一、什么算"修好了"

| 层级 | 完成标准 | 不满足的后果 |
|---|---|---|
| 站点数据（D1 / R2） | 逐条校验脚本全绿（问题=0），且有每日对账 | 用户点到 404/500、记录与文件不符 |
| 插件代码 | **发到 npm**，且本机装的是同一个版本 | 别人跑旧代码，同样的 bug 继续出现 |
| 文档 | CHANGELOG + 相关 docs 写明原因与判据 | 下次重犯 |

## 二、发布前必须过的门（一个都不能跳）

```powershell
# 0) 语法/构建
node scripts/build-client.mjs

# 1) 22 项门禁（+ build 共 23 步）
node test/run-guards.mjs smoke
node test/verify-features.mjs
node test/verify-route-registry.mjs
node test/verify-settings-ownership.mjs
node test/verify-skin-center-bundle.mjs
node test/verify-panel-interactions.mjs
node test/inventory-types.mjs
node test/skins-http.mjs
node test/boot-http.mjs
node test/pets-http.mjs
node test/pets-layer.mjs
node test/verify-package-files.mjs
node test/verify-guard-chain.mjs
node test/verify-guard-map.mjs
node test/verify-client-sync.mjs
node test/verify-eol.mjs
node test/verify-picker-model.mjs
node test/verify-api-client.mjs
node test/verify-site-media.mjs
node test/verify-downloads.mjs
# 下载/安装**状态机**的流程级回归（14 行覆盖表 + 4 条端到端，见 docs/INSTALL-FLOW.md）：
node test/verify-install-flow.mjs
# **整条链路**（清单→选档→下载→落位→安装→启用）的 6 个场景，逐段断言 + 计时：
node test/verify-download-chain.mjs

# 2) 全量审计（必须 0 失败）
node test/run-audit.mjs

# 3) 静态棘轮（逐规则只减不增）
node test/verify-static.mjs
```

## 三、发布

```powershell
# 版本号：bug 修复 +1 末位；行为变更 +1 中间位；破坏性 +1 首位
# 然后：
pnpm pack --config.ignore-scripts=true
pnpm publish --access public --no-git-checks --config.ignore-scripts=true

# 验证已上架（npm 的版本文档有几分钟传播延迟，最多重试 12 次 × 15s）
curl.exe -sS "https://registry.npmjs.org/dsh-folia/<version>?cb=$(Get-Date -Format o)"
```

## 四、装机验证（"别人装到也不会出问题"的唯一证明）

```powershell
# ① 用发布出来的 tgz 装到 profile（不要用手改 node_modules 的旧办法，那会破坏 generation 快照）
#    正确姿势：改 profile 的 package.json 依赖版本号，然后在 profile 目录跑 pnpm install
# ② 清空本机缓存（皮肤 + 队列），模拟"全新用户"
# ③ 逐条下载站点全部皮肤（61 套），必须全部成功
#    验收工具：D:\folia-recover\check-site-skins.py（问题=0）
```

## 四之二、4.23.17 起的三条**硬门槛**（缺一条不发版）

这三条是 2026-11-04 三类事故（多连接静默损坏 / 变体哈希来源错误 / 测试污染真实 library）
逐条换来的，写进门禁、不靠记性：

| # | 硬门槛 | 判据（真跑的那条） | 事故 |
|---|---|---|---|
| G1 | **`node test/run-audit.mjs` 失败必须 0** | 全仓 `test/*.mjs` 逐个真跑；只有 PASS / RETIRED 两种绿，FAIL 一律挡住发版 | 4.23.16 有 1 条真红（guard-map 元守卫表过期）却差点被当成"只是文档"放过 |
| G2 | **任何"数据来源"变更必须配矩阵测试** | 例：`test/verify-hash-source.mjs` 的 `{原画,变体}×{sha 有,无}×{bytes 一致,不一致}` 全组合 + 负对照（旧写法贴回必须红）；`test/verify-variant-hash.mjs` 用真 HTTP 源 + 真路由 + 真队列跑行为 | 变体下载用了原画的 `sha256` ⇒ 15 条 job 全 `hash-mismatch`，用户看到"点了壁纸不显示" |
| G3 | **测试禁止写真实 home** | 一律 `isolateTestHome()` / 显式临时 `home`；`test/verify-test-isolation.mjs` 静态面 + 行为面双判据 | 上一轮把 30 个合成占位视频写进了用户 `%APPDATA%\dsh-desktop\harness\library\wallpaper`，用户看到的所有"浏览器无法解码"都是这些假文件 |

配套纪律（同一次事故）：

- **单一真相源**：`(url, bytes, sha256)` 只允许 `resolveMediaExpectation(item, chosen)` 产出；
  入队点出现 `sha256: item.sha256` 即判红（`test/verify-hash-source.mjs` 的源码扫描）。
- **不许静默跳过校验**：没有期望哈希 ⇒ 宿主 `log` 一句（`no sha256 expectation …`），
  `/downloads/list` 带 `expectSha / expectBytes / hashSource`，事后可审计。
- **本地文件被外部清理不是失败**：`ENOENT` 先清残留 + 重排（连续两次才 `file-vanished`）。

## 五、这次事故的具体教训（写进判据，不靠记性）

1. **失败的下载任务必须能被重试**：`add()` 对 failed/cancelled 的 job 要重置为 queued，
   否则用户"再点一次"会继承上次失败。判据：`test/verify-downloads.mjs` ⑫（行为级，含负对照）。
2. **记录必须来自校验过的对象**：站点上传流程要"写 R2 → 回读 HEAD 校验 → 才写 D1"。
3. **数据漂移要有常驻对账**：`integrity-cron.py`（或 Cloudflare Cron）每天跑一次，
   bytes 不符就校正、文件缺失就隐藏。
4. **别用手改 node_modules 的方式升级插件**：会破坏 DSH 的 generation 快照，导致安全模式。
5. **UI 错误文案必须能定位**：禁止出现裸的 `failed`；网络/上游/超时分别给出人话与下一步动作。
