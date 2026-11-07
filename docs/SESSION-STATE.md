# 会话交接状态（新对话只读这一份就够）

> 用于新开对话时快速接上，不必翻历史。最后更新：2026-11-07 18:20（本地）。

## 1. 两个仓库与当前 HEAD

```
插件仓库：github.com/lehua-art/dsh-folia      HEAD 1daa234（仅文档提交，工作区干净）
站点仓库：github.com/ZXY20020906/-            HEAD b6e3483（与远端同步）
本地：D:\文档\deepseek-harness\default-workspace\dsh-we\dsh-wallpaper-engine-main
      └─ folia-admin\  ← 站点仓库（嵌套独立 git）
```

## 2. npm 状态（冻结中）

```
latest = 4.25.5   next = 4.25.5
本地备份：D:\folia-recover\releases\dsh-folia-4.25.5.tgz
          sha1 19b03b76024c160a4e6ec8a39be948d1e145ef24
规则：新功能只发 next（4.26.0-pre.N），任何情况不得动 latest
```

## 3. 已完成

**插件 4.25.5（壁纸链路）**
- 不点不下载、itemKey 去重、点击必被调度、进度由服务端派生、删除"边下边播"
- 门禁：132 步跑完 / run-audit 0 失败 / 新测试 128 条（本人复跑）

**站点**
- 分片上传 ≤2GB、60fps→draft→本机 `tools/make-variants.mjs` 转码发布
- 公开读静态化：实测 4 小时 D1 行读 = 0；缓存头/304/降级均验过
- 巡检 inspect-assets / export-d1 / d1-usage 三脚本 + OPS 文档
- 测试 407 pass / 0 fail

**门 1（站点侧桌宠包）** 站点提交 `7ec6923` + `ea27dc5`
- 新增 `src/server/pet-package.js`（pet.json 校验）、`tests/pet-package.test.js`、`tests/pet-upload.test.js`
- DTO 增 `pet{id,displayName,frames,columns,tracks,previewUrl}`，`kind='pet'`
- 测试 387 → 407 pass（本人本地复跑）

## 4. 待办（按序）

```
① 复核门 1 剩余 3 条：真实上传宠物包后的公开字段 / sha / 预览；缺 pet.json 的 422；旧接口回归
   （smoke 脚本有一次网络超时，需重试）
② 门 2：插件侧对话引擎（设置项 petChat / SSE 路由 / 气泡 UI / 情绪→tracks / 9 条测试）
③ 门 3：插件从站点安装桌宠 + 联调
④ 我发 4.26.0-pre.1 到 next → 用户安装 → 真实模型验收 → 再定 4.26.0
```

## 5. 锁定决策（不要改）

```
· 私有素材库，只服务插件与自研助手；不做对外市场
· 对话消耗用户自己的模型额度（Ollama / OpenAI 兼容），不经过我们服务器
· 宠物包只分发自制或授权资产；市场第三方作品让用户自己在市场装
· 站点只新增 kind='pet' 与 pet 对象；不改现有公开字段、不加数据库列
· 每阶段独立 commit；两台机器不同时改同一文件；不发 npm 不发 latest
```

## 6. 文档索引

```
插件仓库 docs/PET-CHAT-PLAN.md      方案与接口契约
        docs/PET-CHAT-EXEC.md       三任务工单 + 分工协议（协作者只写代码）
        docs/PET-CHAT-CHECKLIST.md  门0-3 勾选清单
        docs/PET-CHAT-AUTORUN.md    全自动执行协议（自检循环 + 跳过规则）
站点仓库 docs/SITE-CHARTER.md       章程（优先级/DoD/禁止项）
        docs/ACCEPTANCE-REPORT.md   站点 A–G 验收报告
```

## 7. 环境与工具

```
Node：ELECTRON_RUN_AS_NODE=1 + "C:\Program Files\DSH Desktop\DSH Desktop.exe"
站点测试：node tools/run-tests.mjs（407 pass）/ tools/smoke-public-api.mjs
插件门禁：scripts/build-client.mjs / test/run-audit.mjs / test/run-guards.mjs verify
CF 账户 ID（正确）：2f31addd6894dbafbcfb220c6809fee3   ← 注意是 addd，不是 add
凭据：D:\folia-recover\cf-token.txt、D:\folia-handoff\npm-token-next.txt、
      D:\folia-handoff\deploy-key-folia.zip（插件仓库 SSH 推送）
```

## 8. 已知小问题

```
· smoke 脚本偶发超时（网络），重试即可
· CF token 需 Account Analytics: Read 才能跑 d1-usage（当前那把缺权限）
· 站点新上传素材可能缺缩略图/海报 ⇒ 跑 tools/backfill-metadata.mjs --only=<slug> 补
```

---

## 更新（2026-11-07 20:50）

### 门 1（站点侧桌宠包）：✅ 完成并复核通过
```
站点远端：2b20426（含 7f227b4 修复补齐）
我实测：total=114 == 分类之和 114（wallpaper 49 + boot 3 + skin 61 + pet 1）
        ?kind=pet → 200，?kind=bogus → 400
站点测试：407 pass / 0 fail（我本地跑）
遗留（不阻塞）：远端 tests/fixtures/pets/whale-girl-refined.zip 是 0 字节占位（我提交的），
              建议删除或只使用 sample-pet-v2.zip（689KB，自造）
```

### 门 2（插件对话引擎）：进行中，已完成第 1–2 轮
```
插件远端：ef1f1e7（第2轮 路由）、ce324a1（第1轮 设置项）
本地 HEAD：920a089（我 rebase 后的文档提交，ahead 1 未推）
我本地 build-client 成功；run-audit = 通过 100 / 退役 52 / 失败 3（需确认是否既有）
待办：第3轮 src/pet-chat.js + build 模块登记；第4轮 verify-pet-chat 9 条；第5轮 DONE
```

### 已知环境性红项（协作者机器报告）
```
run-guards 有 17 项红落在"需要真 DSH 宿主 + 现场网络"的链路
（下载完成校验、/local-media、站点流兜底、队列优先级）
协作者机器称与本次改动无关、改动前后同一批；需在主机器用同一基线复核
```

### 新对话怎么接
```
读 docs/SESSION-STATE.md（本文件）→ 按"待办"继续：
① 复核门 2 第 1–2 轮（本地 build+audit 的 3 条失败是否既有）
② 推动第 3–5 轮
③ 全绿 → 我发 4.26.0-pre.1 到 next → 用户装 → 真实模型验收
```