# 桌宠对话：执行清单（勾选式，协作者机器逐项执行）

> 一次只做一门；每门做完停下汇报，等主机器验收后再进下一门。
> 铁律：不发 npm、不动 latest（4.25.5）、不改现有公开字段、不 force push、不提交 token。

---

## 门 0：环境准备

- [ ] 克隆站点仓库：`git clone https://github.com/ZXY20020906/-.git folia-admin`（用 classic PAT）
- [ ] 克隆插件仓库：按 `D:\folia-handoff\deploy-key-folia.zip` 的 README 配 SSH 后 clone
- [ ] 两个仓库都 `git pull --rebase`
- [ ] 读文档（插件仓库）：`docs/PET-CHAT-EXEC.md`、`docs/PET-CHAT-PLAN.md`
- [ ] 读契约（不能改字段名）：
      `{ kind:'pet', mime:'application/zip', url, sha256, bytes,
         pet:{ id, displayName, frames, columns, tracks:[...], previewUrl } }`
- [ ] 自检推送权限：站点仓库 `git push` 一次空提交测试（或改文档后 push）

---

## 门 1：站点侧「桌宠包」（只改站点仓库）

### 实现
- [ ] zip 内含 `pet.json` ⇒ 判定为桌宠包（其余 zip 走原通道）
- [ ] 校验：`petManifestVersion===2`、`renderer==='sprite2d'`、
      `sprite2d.spritesheetPath` 存在且是 image/*、`frames` 非空数组、
      `tracks` 含 `idle`、`previews/` 至少 1 张图
- [ ] 校验失败 ⇒ **422** + 具体原因（缺 pet.json / 结构不合法 / 缺预览）
- [ ] 元数据：`pet{id,displayName,frames,columns,tracks,previewUrl}`
- [ ] `kind='pet'`、`thumbUrl = previews 第一张`、`sha256` 上传时计算
- [ ] 公开 DTO **只新增** `pet` 对象，不动 url/bytes/thumbUrl/variants
- [ ] 桌宠包进入公开快照（静态化后仍 0 DB 读）
- [ ] 后台：桌宠分类上传入口 + 列表显示"宠物/帧数/状态数/预览"

### 测试
- [ ] 单测：正常包 → 入库成功；缺 pet.json → 422；frames 为空 → 422；
      缺 previews → 422；spritesheet 非图片 → 422
- [ ] `npm test` 0 失败；`check-sql` 0 失败；`smoke-public-api` 通过

### 线上验收（逐条贴证据）
- [ ] 1) 上传 `whale-girl-refined.zip`（sha256 `1b12ecf2…8c8c68dc`）→ 成功
- [ ] 2) `GET /api/v1/public/wallpapers?category=desktop-pet` → 含该条，`kind='pet'`
- [ ] 3) `pet.tracks` 含 `idle`；`pet.frames` 与 pet.json 一致
- [ ] 4) `previewUrl` HEAD 200 且 `content-type: image/*`
- [ ] 5) zip 直链下载 → sha256 == 站点返回值
- [ ] 6) 回归：`category=wallpaper` 条数与改动前一致（贴前后数字）
- [ ] 7) 上传"缺 pet.json 的 zip" → 422 且原因明确

### 收尾
- [ ] commit + push（Pages 自动部署），部署后复跑 1–7
- [ ] 汇报（格式见文末），**停在这里等验收**

---

## 门 2：插件侧「对话引擎」（只改插件仓库）

### 设置项（`lib/settings-schema.js`）
- [ ] `petChat`：enabled(false) / provider('ollama') / baseUrl / apiKey /
      model / persona{name,style,traits} / maxTurns(8) / maxChars(80)

### 宿主路由（新增 `lib/routes/pet-chat.js` 并在 app 挂载）
- [ ] `GET /folia/pet-chat/state` → `{enabled,provider,model,reachable,lastError}`
- [ ] `GET /folia/pet-chat/models` → Ollama 模型列表（openai 返回空 + hint）
- [ ] `POST /folia/pet-chat/chat` → **SSE**：`delta{t}` / `done{usage,emotion}` / `error{code,hint}`
- [ ] `POST /folia/pet-chat/reset` → 清空记忆
- [ ] 约束：超时 20s、限频 1 次/秒、输入 ≤400 字、只转发到用户配置端点

### 客户端（新增 `src/pet-chat.js`）
- [ ] 点宠物 → 气泡（输入 + 最近 6 条 + 关闭）；Enter 发送 / Esc 关闭
- [ ] 流式打字机显示；思考中播放"思考"动作（无则 idle）
- [ ] 出错显示 hint + 重试；`enabled=false` ⇒ 预设台词库（30–50 句）
- [ ] 快捷键 `Ctrl+Alt+P` 唤起/隐藏

### 情绪 → 动作
- [ ] 要求模型输出 `{"reply":"...","emotion":"happy|calm|tired|angry"}`
- [ ] 解析失败 ⇒ 关键词兜底
- [ ] 映射到宠物包 tracks：happy→wave / tired→sleep / calm→idle（缺则 idle）

### 测试（`test/verify-pet-chat.mjs`）
- [ ] ① SSE 逐字到达
- [ ] ② 无模型 ⇒ `no-model` + 预设台词兜底
- [ ] ③ 401 ⇒ `unauthorized` + 提示检查 key
- [ ] ④ 超时 ⇒ `timeout`
- [ ] ⑤ 第 9 轮只带最近 8 条（断言请求体）
- [ ] ⑥ 超长截断到 maxChars
- [ ] ⑦ 限频 ⇒ `rate-limited`
- [ ] ⑧ emotion 解析失败 ⇒ 关键词兜底
- [ ] ⑨ key 不出现在日志/响应（grep）

### 门禁
- [ ] `node scripts/build-client.mjs` → 0
- [ ] `node test/run-audit.mjs` → 失败 0
- [ ] `node test/run-guards.mjs verify` → 跑完全程
- [ ] `node test/verify-pet-chat.mjs` → 全绿
- [ ] commit + push（**不要发 npm**）
- [ ] 汇报，停下等验收

---

## 门 3：插件「从站点装桌宠」+ 联调（只改插件仓库）

- [ ] 「站点桌宠」区：`GET desktop-pet` 列表（只取 `kind='pet'`）
- [ ] 卡片：预览图/名称/大小/下载按钮
- [ ] 安装：下载 zip（显示进度）→ 校验 sha256 → 解压到 `harness\pets\<pet.id>` →
      校验 pet.json → 写索引 → 提示"已安装，可切换"
- [ ] 失败：sha 不符/结构坏 ⇒ 明确提示 + 删除半成品
- [ ] 已安装：复用"使用中/卸载"
- [ ] 联调验收（贴证据）：
      - [ ] 从站点装一个包 → 出现在列表 → 切换启用 → 宠物出现
      - [ ] 点宠物 → 能聊（门 2 的能力）→ 无模型时回落预设台词
      - [ ] 卸载 → 目录被删、列表消失、其他宠物不受影响
- [ ] 门禁同上四项 + commit + push
- [ ] 汇报（注明"可发 4.26.0"），等主机器发版

---

## 汇报模板（每门一次）

```
门：0/1/2/3
仓库：站点 / 插件
commit：<完整 hash>
改动：文件清单 + 关键函数
接口：新增/变更（方法 + 路径 + 请求/响应示例）
测试：X pass / Y fail（新增 N 条）
门禁：build / audit / guards / smoke（贴原始输出行）
验收证据：逐条贴（状态码 / 字段 / 数字 / 截图路径）
npm：未发布（按纪律）
遗留：…
```

---

## 禁止清单（违反即回滚）

```
✗ npm publish / 改 dist-tag（尤其 latest）
✗ 改现有公开字段（只允许新增 kind='pet' 与 pet 对象）
✗ 加数据库列（桌宠元数据用现有字段/JSON）
✗ force push
✗ token 写进代码 / commit / 日志
✗ 一次做完三门（必须一门一停）
```
