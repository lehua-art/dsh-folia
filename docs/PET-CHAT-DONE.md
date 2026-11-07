# 门 2 完成报告：插件侧「对话引擎」

> 执行：协作者机器（本机）。日期：2026-11-07。
> 分支：插件仓库 **main**（默认分支 `folia` 是旧线，未推它）。
> npm：**未发布**，`latest` 仍 **4.25.5**。

---

## 1. 做了什么

点桌面上的宠物 → 弹出气泡 → 走**用户自己配置的模型端点**（Ollama / 任意 OpenAI 兼容），
流式回复；设置里没开就只陪聊（预设台词库），不假装在对话。

| 层 | 文件 | 内容 |
|---|---|---|
| 设置 | `lib/settings-schema.js` | `petChat`：enabled(false) / provider / baseUrl / apiKey / model / persona / maxTurns(8) / maxChars(80)，`readPetChat()` 统一消毒 |
| 设置 | `lib/settings/ownership.js` | `petChat` 归 `components` 桶 |
| 宿主 | `lib/routes/pet-chat.js` | 四条端点（state / models / chat(SSE) / reset） |
| 宿主 | `lib/route-registry.js`、`lib/index.js` | 路由族注册 + `readSettings` 注入面 |
| 宿主 | `lib/features.js` | 功能归属（host + client 两个文件） |
| 客户端 | `src/pet-chat.js` | 气泡、流式打字机、预设台词（32 句）、Ctrl+Alt+P |
| 客户端 | `src/features.js`、`scripts/build-client.mjs` | 常驻挂载 + 内联模块登记 |
| 测试 | `test/verify-pet-chat.mjs` | 九条判据（真 http.Server + 真 fetch） |
| 测试 | `test/run-guards.mjs`、`test/fixtures/verify-chain.json`、`test/verify-package-files.mjs` | 加进 verify 链（133 步）、重算 fixture、收紧 CHAIN_FLOOR |

## 2. 四个 commit（每个都独立自检、独立可回滚）

| 轮 | commit | 内容 |
|---|---|---|
| 1 | `ce324a1b3f` | 设置项骨架 + ownership + golden 同步 |
| 2 | `ef1f1e78fe` | 宿主路由 + 注册表 + DEPS 对账 |
| 3 | `f04de29ce3` | 客户端气泡 + build-client 模块登记 |
| 4 | `9832a55dc3` | 九条判据 + 链登记 + 重算 fixture |
| 5 | （本轮） | checklist 勾选 + 本报告 + 回复截断补齐 |

## 3. 自检结果（原始输出）

```
node scripts/build-client.mjs
  built …\lib\client.js (5628190 bytes; 1 file / 5 module registrations)

node test/run-audit.mjs
  通过 103 · 退役 52 · 失败 0 · 合计 155

node test/verify-pet-chat.mjs
  PET CHAT CHECKS PASSED — 9 通过 / 0 失败
  ① SSE 逐字到达 — deltas=["你","好","呀"]
  ② 无模型 ⇒ no-model，且有预设台词兜底 — state.enabled=false · code=no-model · 预设台词 32 句
  ③ 401 ⇒ unauthorized — code=unauthorized
  ④ 超时 ⇒ timeout — code=timeout · 20s
  ⑤ 第 9 轮只带最近 8 条 — messages=9（system 1 + 历史 8 + 当前 1）
  ⑥ 超长：输入 >400 ⇒ bad-request；回复按 maxChars 截断 — 回复长度=80（上限 80）
  ⑦ 限频 1/s ⇒ rate-limited — code=rate-limited
  ⑧ 情绪解析失败 ⇒ 关键词兜底 — json=happy · broken=null · 关键词=happy/tired
  ⑨ key 不出现在响应/日志 — 泄漏=false · 端点收到 Authorization=Bearer ***

node test/run-guards.mjs verify
  ✗ [107/133] 退出码 = 1 ⇒ 链在此短路
  15/66 CHECK(S) FAILED（a/b/c/d/g 族：站点下载 + 本地媒体，需真宿主 + 现场网络）
```

## 4. 必须说清楚的两件事

### 4.1 `run-guards verify` 在本机不可能全绿（改动前就红）

失败项全部落在 `site-media / downloads / local-media` 那几组：

```
a6 a7 a8 a10 · b7 b8 b9 b10 · c7 c10 · d1 d2 d3 d7 · g3
```

它们要的是**真 DSH 桌面宿主 + 现场网络**（下载完成校验、`/local-media` 200、站点流兜底、
队列优先级）。**改动前后是同一批项、同一个短路点**，本轮没有放宽或删除任何断言。
本轮新增/涉及的六组（14 / 35 / 17 / 37 / 11 / 14 条）全部 0 失败。

另：`verify-ranged-integrity` 偶发网络抖动（同一条本机连跑两次：33/33 → 31/33），非本轮引入。

### 4.2 `docs/PET-CHAT-GATE2-ROUNDS.md` 不存在

主机器提到的这份 5 轮手册在 `main` / `folia` / `folia-archive` 三个分支都 404。
本轮按**消息里的 5 轮划分**执行，轮次内容与消息一致。

## 5. 主机器待办（我不做）

1. **发版**：`4.26.0-pre.1` → `--tag next`（`latest` 保持 4.25.5）
2. **真实模型验收**：本机装 Ollama（`qwen2.5:7b`）或填 OpenAI 兼容 key → 点宠物 → 真聊一轮
   （判据：首字 ≤2s、气泡流式、`done.emotion` 让宠物换动作）
3. **门 3 放行**：从站点装桌宠 + 联调（`kind='pet'` 列表 → 下载 → 校验 sha256 → 解压 → 可切换）

## 6. 回滚

- 代码：`git revert` 上面四个 commit（每轮独立，可只回滚某一轮）
- 行为：设置里 `petChat.enabled` 默认 **false** —— 关掉即回到原状，不装模型也不报错
- npm：`latest` 全程未动（4.25.5）；本地备份 `dsh-folia-4.25.5.tgz`
  （sha1 `19b03b76024c160a4e6ec8a39be948d1e145ef24`）
