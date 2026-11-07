# 门 2 分轮执行（每轮必须全绿再进下一轮）

> 背景：只加一个 `petChat` 设置键就让 run-audit 从 103/0 变 99/4 红。
> 根因：`lib/client.js` 是构建产物，src/settings 改动会影响它，**改完必须 rebuild 再跑门禁**；
> 另有"设置项归属"与 golden 文件需要同步登记。
> 铁律：不发 npm、不动 latest（4.25.5）、不改现有公开字段、不 force push、不放宽/删除断言。

## 每轮固定动作（缺一步都会红）

```
1) 改代码（只改本轮范围内）
2) node scripts/build-client.mjs          ← 必须，重建 lib/client.js
3) node test/run-audit.mjs                ← 必须 0 失败
4) node test/run-guards.mjs verify        ← 必须跑完全程（贴步数）
5) git commit + push origin main          ← 插件仓库统一用 main（默认分支是 folia，别推错）
6) H1 == H2 校验（git rev-parse HEAD vs git ls-remote origin refs/heads/main）
7) 更新 docs/PET-CHAT-PROGRESS.md 一行：轮次/commit/自检结果
```

**若某条红是"golden/产物未更新"**：允许**有意**更新 golden（`settings-sanitize-golden.json`、
chain fixture 等），但必须在提交信息里写明"golden 更新原因"，不许跳过或注释掉断言。

---

## 第 1 轮：设置项骨架（最小可绿）

```
改动：
  · lib/settings-schema.js：新增 petChat 一节（enabled/provider/baseUrl/apiKey/model/
    persona/maxTurns/maxChars），字段类型与默认值见 docs/PET-CHAT-PLAN.md
  · 设置项归属：在 ownership 映射里登记 petChat（verify-settings-ownership 依赖它）
  · 若 golden 里列了键清单：同步更新 settings-sanitize-golden.json 并写明原因
固定动作 1–7 全绿
验收：
  · run-audit 0 失败（贴 通过/退役/失败 三个数）
  · verify-settings-ownership 绿
  · verify-client-sync 绿（说明已 rebuild）
```

## 第 2 轮：宿主路由

```
改动：
  · 新增 lib/routes/pet-chat.js（state/models/chat(SSE)/reset）
  · 路由注册（verify-route-registry 依赖）
  · DEPS 声明（verify-inject-contracts 双向对账依赖）
  · 不接真实模型：当前只需路由可用 + 未配置时返回 no-model
固定动作 1–7 全绿
验收：verify-route-registry 绿、verify-inject-contracts 绿、run-audit 0 失败
```

## 第 3 轮：客户端气泡 + 模块登记

```
改动：
  · 新增 src/pet-chat.js（气泡/流式打字机/预设台词兜底/快捷键）
  · build-client 模块登记（verify-client-sync 依赖，必须 rebuild）
固定动作 1–7 全绿
验收：verify-client-sync 绿（产物哈希与 src 一致）
```

## 第 4 轮：判据与全链

```
改动：新建 test/verify-pet-chat.mjs（9 条）
  ①SSE 逐字 ②无模型兜底 ③401 ④超时 ⑤上下文 8 条 ⑥超长截断 ⑦限频 ⑧情绪兜底 ⑨key 不外泄
固定动作 1–7 全绿（run-guards 必须跑完全程）
验收：
  · verify-pet-chat 9/9
  · run-guards 全程步数（贴出来）
  · grep 确认 key 不出现在构建产物/日志字符串
```

## 第 5 轮：收尾

```
· docs/PET-CHAT-DONE.md：门 2 完成度、证据、主机器待办（发 next / 真实模型验收）
· docs/PET-CHAT-PROGRESS.md 标门 2 ✅
· 最后一次 push + H1==H2
⇒ 停止，不做门 3（等主机器验收门 2 后再放行）
```

---

## 关于"要不要一次做完"

```
不允许跳过"每轮全绿"这条；但允许把门 2 拆成上面 5 轮，每轮独立提交。
这样即使中途上下文耗尽，仓库也始终是绿的（不会留红）。
门 3 暂不做：它依赖门 2 的客户端模块，等门 2 验收后单独一轮。
```

## 汇报格式（每轮一行 + 最终汇总）

```
第N轮：commit=<hash> audit=通过X/失败0 guards=<步数> verify-<名>=<结果> H1==H2=true
最终：门2 完成 / 遗留 / 主机器待办
```
