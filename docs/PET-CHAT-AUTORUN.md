# 桌宠对话：全自动执行协议（无需人工指导，跑到完成）

> 给协作者机器。目标：**三门依次自动完成，每门自测通过才进下一门，失败就自己定位修复，直到通过；最后全部提交。**
> 没有人工介入。遇到"必须人工授权"的动作（发 npm、动 latest、需要 admin 登录），**跳过并记录**，不要卡死。
> 铁律：不发 npm、不改 latest（4.25.5）、不改现有公开字段、不加数据库列、不 force push、不提交 token。

---

## 0. 执行模型（每门一个循环）

```
for 门 in [1 站点侧, 2 插件侧, 3 安装+联调]:
    尝试 = 0
    while 尝试 < 6:
        尝试 += 1
        实现本门未完成项
        运行本门的"自检清单"（全部是命令，能自动判定 PASS/FAIL）
        if 全部 PASS:
            commit + push
            break
        else:
            定位失败项 → 修 → 重跑自检
    if 尝试到 6 仍 FAIL:
        把失败项与证据写入 docs/PET-CHAT-AUTORUN-LOG.md，标记该门 BLOCKED
        继续下一门（不要死循环）
    门通过后：在 LOG 里记 commit + 自检结果 → 进下一门
```

**禁止**：为让自检"变绿"而放宽断言、删测试、跳过用例。

---

## 1. 环境（门 0，一次性）

- [ ] 站点仓库：`git clone https://github.com/ZXY20020906/-.git`（classic PAT）
- [ ] 插件仓库：按 `deploy-key-folia.zip/README.txt` 配 SSH 后 clone
- [ ] 两仓库 `git pull --rebase`
- [ ] 复读：`docs/PET-CHAT-PLAN.md`（契约）、`docs/PET-CHAT-EXEC.md`、`docs/PET-CHAT-CHECKLIST.md`
- [ ] 自检推送：各自 push 一次文档改动

---

## 门 1：站点侧桌宠包（自检命令）

### 实现项
zip 含 `pet.json` ⇒ 桌宠包；校验 `petManifestVersion=2 / renderer=sprite2d /
spritesheetPath 是 image/* / frames 非空 / tracks 含 idle / previews ≥1 图`；
失败 **422**；`kind='pet'`；`pet{id,displayName,frames,columns,tracks,previewUrl}`；
`thumbUrl=previews[0]`；`sha256` 上传时算；进公开快照；后台列表显示宠物信息。

### 自检（全部必须 PASS，命令可脚本化）
```
S1  node tools/run-tests.mjs            → 0 失败（新增桌宠用例 ≥6 条）
S2  node tools/check-sql.mjs（或 dump-queries + check-sql）→ 0 失败
S3  node tools/smoke-public-api.mjs     → 通过
S4  回归：curl 公开 wallpaper 分类总数 == 改动前（记基线数字）
S5  node tools/validate-pet-zip.mjs tests/fixtures/pets/whale-girl-refined.zip
    （若工具不存在，先实现：解压→校验→打印推导出的 pet 元数据；
     期望：id=whale-girl-refined、tracks 含 idle、frames=[6,8,8,4,5,8,6,6,9…]、previews≥1）
S6  负例：构造缺 pet.json 的 zip → 校验工具/接口必须拒绝（422 语义）
S7  部署后：curl /api/v1/public/wallpapers?limit=1 → 200；current.json 200
```
> 需要 admin 登录才能做的"真实上传"：**标记 SKIPPED-NEED-ADMIN**，由主机器补做，不算本门失败。

### 通过标准
S1–S3、S5–S7 全 PASS（S4 一致），S6 拒绝成功；commit + push。

---

## 门 2：插件侧对话引擎（自检命令）

### 实现项
设置项 `petChat`；宿主路由 `state/models/chat(SSE)/reset`；气泡 UI + 流式打字机；
情绪→tracks 映射（缺则 idle）；无模型回落预设台词；限频 1/s；上下文 8 条；回复 ≤80 字。

### 自检（全部必须 PASS）
```
S1  node scripts/build-client.mjs                 → 0
S2  node test/verify-pet-chat.mjs                 → 全绿（9 条：SSE/无模型/401/超时/
                                                    上下文裁剪/截断/限频/情绪兜底/key 不外泄）
S3  node test/run-audit.mjs                       → 失败 0
S4  node test/run-guards.mjs verify               → 跑完全程（贴步数）
S5  node scripts/build-client.mjs 二次执行        → 输出版本号一致（幂等）
S6  静态自检：grep 确认 apiKey 不出现在任何日志/响应/构建产物字符串里
```
> 需要真实模型端点才能做的端到端：用**本地 mock 端点**（test 内起 http server 返回 SSE）代替；
> 真实模型验收由主机器/用户补做，不算本门失败。

### 通过标准
S1–S6 全 PASS；commit + push（**不发 npm**）。

---

## 门 3：插件从站点装桌宠 + 联调（自检命令）

### 实现项
「站点桌宠」列表（只取 kind='pet'）；下载 zip（进度）→ 校验 sha256 → 解压
`harness\pets\<id>` → 校验 pet.json → 写索引 → 可切换；失败删半成品。

### 自检（全部必须 PASS）
```
S1  单测：mock 站点列表（返回一个 pet 条目）→ 列表渲染出卡片
S2  单测：下载+sha 校验成功 → 解压到临时目录 → pet.json 校验通过 → 索引写入
S3  单测：sha 不符 → 报错且不写索引、不留半成品目录
S4  单测：zip 结构坏（缺 pet.json）→ 报错 + 清理
S5  node test/verify-pet-chat.mjs 仍全绿（回归）
S6  node test/run-audit.mjs 失败 0；node test/run-guards.mjs verify 跑完
S7  node scripts/build-client.mjs → 0
```
> 真实"从线上站点装"需要站点已有桌宠包（依赖门 1 的真实上传，主机器补做）；
> 用 mock 站点完成自动化验证，不算失败。

### 通过标准
S1–S7 全 PASS；commit + push。

---

## 收尾（自动执行）

```
1) 更新 docs/PET-CHAT-AUTORUN-LOG.md：
   门/commit/自检结果/跳过的项（SKIPPED-NEED-ADMIN / SKIPPED-NEED-NPM 等）
2) 补一份 docs/PET-CHAT-HANDOFF-DONE.md：
   · 三门各自完成度与证据
   · 主机器还需要做什么（发 npm、真实上传、真实模型验收）
   · 回滚方式（4.25.5）
3) 两仓库最终 commit + push
4) 输出最终报告（见下）
```

---

## 最终报告模板

```
## 门 1 站点侧
commit：<hash>
自检：S1 ✅ S2 ✅ S3 ✅ S4 回归=<数字> S5 ✅ S6 ✅ S7 ✅
跳过：SKIPPED-NEED-ADMIN（真实上传，需主机器）
## 门 2 插件侧
commit：<hash>
自检：S1–S6 全 ✅（贴关键输出行）
## 门 3 安装+联调
commit：<hash>
自检：S1–S7 全 ✅
## 收尾
LOG / HANDOFF-DONE：<路径>
npm：未发布（按纪律）；latest 仍 4.25.5
主机器待办：① 发 4.26.0-pre.1 到 next ② 真实上传宠物包 ③ 真实模型验收
```

---

## 不可做（违反即视为失败）

```
✗ npm publish / dist-tag 任何操作
✗ 改 latest
✗ 改现有公开字段（只允许新增 kind='pet' 与 pet 对象）
✗ 加数据库列（元数据放现有字段/JSON）
✗ force push
✗ token 进代码/commit/日志
✗ 放宽断言让自检变绿
```
