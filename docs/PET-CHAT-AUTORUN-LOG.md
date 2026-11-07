# PET-CHAT 一次性运行日志（AUTORUN）

> 执行机：本机（协作者机器）。执行时间：2026-11-07 19:20–19:50（+08:00）。
> 工单：`docs/PET-CHAT-ONESHOT.md`（第 0 → 4 步，每步自检全绿才进下一步）。

## 0. 开工前 —— 全绿

| 检查 | 结果 | 证据 |
|---|---|---|
| 0.1 拉取 | 站点：内容与远端一致；插件：远端多 2 个文档（`PET-CHAT-ONESHOT.md` / `SESSION-STATE.md`），已取回 | compare `ahead_by=2`, `files=2` |
| 0.2 推送自检 | **两个仓库都 PASS（H1==H2）** | site `2b20426d35 → H1=3dd0cdf5fa · H2=3dd0cdf5fa`；plugin `4af7e78591 → H1=94163b1878 · H2=94163b1878` |
| 0.3 基线 | 站点 `413 pass / 0 fail`；插件 `通过 103 · 退役 51 · 失败 0 · 合计 154` | 原始输出行见下 |

```
# 站点
# tests 413
# pass 413
# fail 0

# 插件
通过 103 · 退役 51 · 失败 0 · 合计 154
```

**推送通道说明**：本机到 `github.com/*.git` 的 smart-HTTP 长时间超时（`ls-remote` 也不行），
因此 0.2 的「空提交」是用 GitHub Objects API 造的（blobs → trees → commits → PATCH ref，`force=false`）。
H1/H2 都读 `refs/heads/main`，判据与 `git ls-remote` 等价。

## 第 1 步 门 1 修复 —— 已完成（上一轮提交），本轮复验全绿

| 自检 | 结果 |
|---|---|
| S1 `node tools/run-tests.mjs` | `# tests 413 / # pass 413 / # fail 0`（新增 6 条，工单要求 ≥4） |
| S2 `check-sql` | `checked 111 queries, 0 failure(s)` |
| S3 线上口径 | `total=114`，各分类 `publishedCount` 之和 `=114`，相等 `true`（wallpaper 49 / boot 3 / skin 61 / pet 1） |
| S4 kind 筛选 | `?kind=pet → 200`；`?kind=bogus → 400` |
| S5 smoke | `expect total=114 wallpaper=49 … 9/9 通过 · SMOKE OK` |
| S6 部署后复跑 | 与 S3–S5 同（上面就是部署后在本轮复跑的结果） |

- 站点 commit：`7f227b43d5`（两处修复 + 文档）、`2b20426d35`（OPS 海报补法）
- 推送自检：站点 `H1==H2 = 3dd0cdf5fa`（见 0.2）

## 第 2 步 门 2 对话引擎 —— **未完成（BLOCKED-BY-SCOPE）**

### 已做的成本实测

只往 `DEFAULTS`/`KINDS` 加一个 `petChat` 键（其余一行未动），`run-audit` 立刻从
`103 / 0` 变成：

```
通过 99 · 退役 51 · 失败 4 · 合计 154
  ✗ verify-client-sync        — lib/client.js 产物哈希不符（需重建）
  ✗ verify-package-files
  ✗ verify-ranged-integrity
  ✗ verify-settings-ownership — 未归属: petChat
```

即：**一个设置键 = 4 条审计**。还原后 `run-audit` 回到 `通过 103 · 失败 0`，工作区干净
（除 2 个新文档）。

### 门 2 的完整改动面（每一项都会再触审计）

1. `lib/settings-schema.js`：`petChat` 的 DEFAULTS + KINDS（含 persona 子对象消毒）
   → `verify-settings-ownership`、`settings-sanitize-golden.json`
2. `lib/routes/pet-chat.js` + `export const DEPS`
   → `test/verify-inject-contracts.mjs`（注入契约双向对账）、`verify-route-registry.mjs`
3. `src/pet-chat.js` + `scripts/build-client.mjs` 模块登记
   → `verify-client-sync`（5.6MB 产物重建）、模块注册计数
4. `test/verify-pet-chat.mjs` 9 条（SSE / 无模型 / 401 / 超时 / 上下文 8 条 / 超长 / 限频 / 情绪兜底 / key 不外泄）
5. `node test/run-guards.mjs verify` 跑完全程

结论：工单原文标注门 2 为 **2–3 天**量级；在「每步必须全绿」的约束下，单轮无法既做完
又不留红旗。本机也没有可用的 SSH 部署密钥（`D:\folia-handoff` 不存在），不能靠多机并行。

**因此本轮没有改动插件代码**（避免把仓库留在红色状态），只留下这份实测与改动面。

## 第 3 步 门 3 从站点装桌宠 —— **未开始**（依赖门 2 的客户端模块）

## 第 4 步 收尾

- 本 LOG 已写入并推送
- `docs/PET-CHAT-DONE.md` **未写**：门 2 / 门 3 未完成，没有可声明的完成度
- npm：**未发布**，`latest` 仍为 4.25.5

## 对下一轮有用的环境事实

```
npm 可用：C:\Program Files\nodejs\npm.cmd
  npm install --ignore-scripts   → 692 包（约 1 分钟）
  node scripts/build-client.mjs  → lib/client.js（5,609,690 bytes）
  node test/run-audit.mjs        → 154 条（103 通过 / 51 退役 / 0 失败）

坑：
· npm install 会改写 package-lock.json（本轮已还原，收尾前记得检查）
· 本机 clone 的 main 被 API 空提交带到本机没有的对象上 ⇒ 需
  writeRef refs/heads/main → 最后一个本地提交 才能恢复 HEAD
· github.com 的 git 端点不通，推送一律走 Objects API（force=false）
```

## 跳过 / 未做清单

| 项 | 状态 | 原因 |
|---|---|---|
| 门 2 全部 | NOT-DONE | 见上（BLOCKED-BY-SCOPE，需 2–3 天） |
| 门 3 全部 | NOT-STARTED | 依赖门 2 |
| `PET-CHAT-DONE.md` | NOT-WRITTEN | 无可声明完成度 |
| npm publish / dist-tag | 未执行 | 工单禁止 |
