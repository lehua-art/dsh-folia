# 一次性跑完：门1修复 → 门2 → 门3（自检循环，无需人工）

> 给协作者机器。**从"修门1两条"开始，一路做到门3联调，全程自检，每步通过才进下一步。**
> 铁律：不发 npm、不动 latest（4.25.5）、不改现有公开字段、不加数据库列、不 force push、不提交 token。

---

## 0. 开工前（必须全绿才进入第 1 步）

```
0.1 git pull --rebase（两个仓库：站点 folia-admin / 插件 dsh-folia）
0.2 推送能力自检（关键，上次你的改动没到远端）：
    git commit --allow-empty -m "chore: push self-check"
    git push origin main
    然后：
      git rev-parse HEAD                 → 得 H1
      git ls-remote origin refs/heads/main → 得 H2
    必须 H1 == H2；不等就停下修推送（SSH key / PAT），不要继续
0.3 记录基线：
    站点：node tools/run-tests.mjs 的 tests/pass/fail
    插件：test/run-audit.mjs 的通过/失败数
```

**规则**：任何一步失败，最多重试 6 次；仍失败就把"失败项 + 证据 + 已试过的做法"写进
`docs/PET-CHAT-AUTORUN-LOG.md`，标记 BLOCKED，继续下一步（不要死循环、不要放宽断言）。

---

## 第 1 步：修门 1 两条（站点仓库）

### 1.1 分类计数与 total 不一致
- 复用 `queries.js` 的 `PUBLIC_VISIBLE` 谓词（禁止复制第二份 SQL）
- `listCategories.published_count` 与 facets 分类计数改成同一谓词
- "未分类"条目单列，保证 sum(分类) == total

### 1.2 `?kind=pet` 400
- `src/core/validate.js` 的 `KINDS` 加 `'pet'`
- 快照内存筛选 + D1 兜底两条路径都支持
- 更新 `docs/API-V1.md` 的 kind 枚举

### 1.3 自检（全 PASS 才继续）
```
S1 node tools/run-tests.mjs            → 0 失败（新增 ≥4 条：pending 不计、verified 空不计、未分类计入、kind=pet）
S2 check-sql 0 失败
S3 线上：curl /api/v1/public/wallpapers?limit=1 的 total
        == curl /api/v1/public/categories 各 publishedCount 之和（含未分类）
S4 线上：?kind=pet → 200；?kind=bogus → 400
S5 node tools/smoke-public-api.mjs → 通过
S6 部署后复跑 S3/S4/S5
```
- 通过 ⇒ commit + push ⇒ **验证 H1==H2** ⇒ 进入第 2 步

---

## 第 2 步：门 2 插件对话引擎（插件仓库）

### 2.1 设置项 `petChat`
enabled(false) / provider('ollama') / baseUrl / apiKey / model /
persona{name,style,traits} / maxTurns(8) / maxChars(80)

### 2.2 宿主路由 `lib/routes/pet-chat.js`
```
GET  /folia/pet-chat/state   → {enabled,provider,model,reachable,lastError}
GET  /folia/pet-chat/models  → ollama 列表（openai 返回空+hint）
POST /folia/pet-chat/chat    → SSE：delta{t} / done{usage,emotion} / error{code,hint}
POST /folia/pet-chat/reset   → 清空记忆
约束：超时 20s、限频 1/s、输入 ≤400 字、只转发到用户配置端点、key 不入日志
```

### 2.3 客户端 `src/pet-chat.js`
气泡（输入 + 最近 6 条）、流式打字机、思考动作、错误重试、
`enabled=false` ⇒ 预设台词库（≥30 句）、快捷键 Ctrl+Alt+P

### 2.4 情绪 → 动作
模型输出 `{"reply":"...","emotion":"happy|calm|tired|angry"}`；解析失败走关键词兜底；
映射 pets 的 tracks（happy→wave / tired→sleep / calm→idle，缺则 idle）

### 2.5 自检（全 PASS 才继续）
```
S1 node scripts/build-client.mjs        → 0
S2 node test/verify-pet-chat.mjs        → 9 条全绿
   （SSE 逐字 / 无模型兜底 / 401 / 超时 / 上下文 8 条 / 超长截断 / 限频 / 情绪兜底 / key 不外泄）
S3 node test/run-audit.mjs              → 失败 0
S4 node test/run-guards.mjs verify      → 跑完全程（贴步数）
S5 grep：apiKey 不出现在构建产物/日志字符串
```
- 通过 ⇒ commit + push ⇒ 验证 H1==H2 ⇒ 第 3 步

---

## 第 3 步：门 3 从站点装桌宠 + 联调（插件仓库）

### 3.1 功能
「站点桌宠」列表（只取 `kind='pet'`）→ 卡片（预览/名称/大小）→
下载 zip（进度）→ 校验 sha256 → 解压 `harness\pets\<pet.id>` →
校验 `pet.json` → 写索引 → 可切换；失败删半成品

### 3.2 自检（全 PASS 才继续）
```
S1 单测：mock 站点列表 → 卡片渲染
S2 单测：下载+sha 成功 → 解压 → pet.json 校验 → 索引写入
S3 单测：sha 不符 → 报错且不留半成品
S4 单测：zip 缺 pet.json → 报错 + 清理
S5 node test/verify-pet-chat.mjs 仍全绿（回归）
S6 node test/run-audit.mjs 失败 0 + run-guards 跑完 + build-client 0
```
- 通过 ⇒ commit + push ⇒ 验证 H1==H2 ⇒ 第 4 步

---

## 第 4 步：收尾（不需要人工）

```
4.1 写 docs/PET-CHAT-AUTORUN-LOG.md：
    每步的 commit / 自检输出关键行 / 跳过的项（SKIPPED-NEED-ADMIN 等）
4.2 写 docs/PET-CHAT-DONE.md：
    · 三步各自完成度与证据
    · 主机器待办：① 发 4.26.0-pre.1 到 next ② 真实上传宠物包 ③ 真实模型验收
    · 回滚方式（latest 4.25.5）
4.3 两仓库最终 push，并各自验证 H1==H2
4.4 输出最终报告（门/commit/自检/PASS-FAIL/遗留）
```

---

## 报告模板（最后一次性输出）

```
【第1步 门1修复】commit=<hash> 自检 S1–S6 全 PASS；total=<n> 分类和=<n>；kind=pet=<200>
【第2步 门2对话】commit=<hash> 自检 S1–S5 全 PASS；verify-pet-chat 9/9
【第3步 门3安装】commit=<hash> 自检 S1–S6 全 PASS
【收尾】LOG=<路径> DONE=<路径>；H1==H2 均已验证
npm：未发布，latest 仍 4.25.5
主机器待办：发 next / 真实上传 / 真实模型验收
```

---

## 禁止清单

```
✗ npm publish / dist-tag / 改 latest
✗ 改现有公开字段（只允许新增 kind='pet' 与 pet 对象）
✗ 加数据库列
✗ force push
✗ token 进代码/commit/日志
✗ 为过自检而放宽断言/删测试
✗ 一次跳步（必须 1→2→3 顺序，每步自检全绿才进下一步）
```
