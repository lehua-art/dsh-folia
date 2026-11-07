# 桌宠对话功能：交接工单（站点侧 + 插件侧都能做）

> 给协作者机器。读完直接按「任务 A / 任务 B / 任务 C」执行，不必翻历史。
> 总方案：`docs/PET-CHAT-PLAN.md`（本仓库）。站点侧文档在站点仓库 `docs/`。
> **版本纪律：npm `latest` 冻结在 4.25.5；本功能一律发 `next`（`4.26.0-pre.N`）。**

---

## 0. 三条硬纪律（违反即停）

```
1) 不改 npm 的 latest 标签（4.25.5 是用户的安全版本）
2) 不改现有公开接口字段（只允许新增 kind='pet' 与 pet 对象）
3) 每阶段单独 commit + push；做完一阶段再做下一阶段；跑完全部门禁再发 next
```

---

## 任务 A：插件侧——对话引擎 + 气泡（2–3 天）

**目标**：点宠物能聊，流式输出，人设稳定，无模型时回落预设台词。不依赖站点。

### A1 设置项（`lib/settings-schema.js` 新增 `petChat`）

```
enabled      boolean  默认 false（首次点击宠物时引导开启）
provider     'ollama' | 'openai'   默认 'ollama'
baseUrl      string   默认 http://127.0.0.1:11434（ollama）/ https://api.deepseek.com（openai）
apiKey       string   仅 openai 用；只存本机 profile，不打印、不进日志、不上传
model        string   默认 qwen2.5:7b（ollama）/ deepseek-chat（openai）
persona      object   { name:'Folia', style:'元气、短句、偶尔颜文字、不说教', traits:'喜欢壁纸和游戏' }
maxTurns     number   默认 8（上限 12）
maxChars     number   默认 80（上限 160）
```

### A2 宿主路由（新增 `lib/routes/pet-chat.js`，在 app 里挂载）

```
GET  /folia/pet-chat/state    → { enabled, provider, model, reachable, lastError }
GET  /folia/pet-chat/models   → ollama /api/tags 列表；openai 返回空 + hint
POST /folia/pet-chat/chat     → SSE（text/event-stream）
      请求：{ text, history? }        （history 可选，客户端也可由宿主维护）
      事件：delta {t} / done {usage, emotion} / error {code, hint}
      code ∈ no-model | timeout | unauthorized | rate-limited | bad-request
POST /folia/pet-chat/reset    → 清空会话记忆
```

约束：超时 20s；同来源 1 次/秒；输入 ≤400 字；**只转发到用户配置的端点**。

### A3 客户端（新增 `src/pet-chat.js`，挂到宠物组件）

```
点宠物 → 气泡（输入 + 最近 6 条 + 关闭）；Enter 发送 / Esc 关闭
流式打字机；思考中让宠物做"思考"动作（有则播，无则 idle）
出错：显示 hint + 重试；enabled=false ⇒ 预设台词库（30–50 句，按情绪分组）
快捷键 Ctrl+Alt+P 唤起/隐藏
```

### A4 情绪 → 动作（P1，同阶段末做）

```
模型输出要求 JSON：{"reply":"...","emotion":"happy|calm|tired|angry"}
解析失败 ⇒ 关键词兜底（好耶/哈哈→happy；算了/不知道→calm）
映射到宠物包 tracks：happy→wave（无则 idle）、tired→sleep（无则 idle）、calm→idle
```

### A5 测试 `test/verify-pet-chat.mjs`（9 条）

```
① SSE 逐字到达  ② 无模型 ⇒ no-model + 预设台词  ③ 401 ⇒ unauthorized
④ 超时 20s ⇒ timeout  ⑤ 第 9 轮只带最近 8 条（断言请求体）
⑥ 超长截断 maxChars  ⑦ 限频 rate-limited  ⑧ emotion 解析失败 ⇒ 关键词兜底
⑨ key 不出现在日志/响应（grep）
```

### A6 门禁与发布

```
node scripts/build-client.mjs → 0
node test/run-audit.mjs → 失败 0
node test/run-guards.mjs verify → 跑完全程
node test/verify-pet-chat.mjs → 全绿
pnpm publish --tag next（4.26.0-pre.1）· **不要动 latest**
```

---

## 任务 B：站点侧——桌宠包作为素材类型（1–2 天）

**目标**：能上传/校验/分发桌宠包；公开列表带预览；不动现有字段。

### B1 识别与校验（`src/server/routes/wallpapers.js` + `ingest.js`）

```
zip 内含 pet.json ⇒ 判定"桌宠包"（否则走原 zip 通道）
校验：
  petManifestVersion === 2
  renderer === 'sprite2d'
  sprite2d.spritesheetPath 存在且是 image/*
  Array.isArray(frames) 且长度 > 0
  tracks 至少含 idle
  previews/ 至少 1 个图片（gif/webp/png）
失败：422 + 具体原因（缺 pet.json / 结构不合法 / 缺预览）
```

### B2 元数据与封面

```
pet = { id, displayName, frames, columns, tracks:[...], previewUrl }
thumbUrl = previews 第一张
kind = 'pet'；mime = 'application/zip'；sha256 上传时算（>40MB 用采样指纹并标注）
公开 DTO 增加 pet 字段（只新增，不改旧字段）
```

### B3 后台与快照

```
后台桌宠分类上传入口 + 列表显示"宠物/帧数/状态数/预览"
桌宠包进公开快照（同其他素材）
```

### B4 验收（用现成样本）

```
样本：tests/fixtures/pets/whale-girl-refined.zip
  （sha256 1b12ecf276042dedf74998f228da809a460dbc530bf716d3326b57bd8c8c68dc，2.2MB）
  ⚠️ 若 zip 里有 `\` 分隔路径，按 zip 规范视为 `/`
步骤：
  1) 上传该 zip 到 desktop-pet 分类 → 成功入库
  2) 公开列表 category=desktop-pet → kind='pet'、pet.tracks 含 idle、previewUrl 可访问
  3) 直链下载 zip → sha256 与站点一致
  4) 上传一个"缺 pet.json 的 zip" → 422 且原因明确
```

---

## 任务 C：插件侧——从站点安装桌宠（1 天，等 B 完成后）

```
「站点桌宠」区：GET desktop-pet 列表（kind='pet'）→ 卡片（预览/名称/大小）
安装：下载 zip（进度）→ 校验 sha256 → 解压到 harness\pets\<pet.id> →
      校验 pet.json → 写索引 → 提示"已安装，可切换"
失败：sha 不符/结构坏 ⇒ 明确提示 + 删半成品
已安装：复用现有"使用中/卸载"逻辑
验收：从站点装一个包 → 切换 → 宠物出现 → 对话可用（依赖 A）
```

---

## 环境与权限

```
插件仓库：D:\...\dsh-wallpaper-engine-main（Node: ELECTRON_RUN_AS_NODE=1 + DSH Desktop.exe）
站点仓库：folia-admin（push main 自动部署）
npm 凭据：C:\Users\86136\.npmrc；**只发 --tag next**
CF token：D:\folia-recover\cf-token.txt（不打印）
```

## 汇报模板（每阶段）

```
阶段：A / B / C
改动：文件 + 关键函数
接口：新增/变更（方法+路径+请求/响应）
测试：X pass / Y fail（新增 N 条）
门禁：build / audit / guards 结果
线上/本地验证：证据（截图或命令输出）
commit：<hash>
npm：发布到 next 的版本号 + shasum（若有）
遗留：…
```

---

## 9. 分工与交接协议（必须遵守）

### 9.1 两个仓库（别搞混）

```
插件仓库：github.com/lehua-art/dsh-folia      ← 插件代码（会话引擎/气泡/安装链路）
站点仓库：github.com/ZXY20020906/-            ← 网站代码（桌宠包校验/预览/分发）
各自 push；不互相覆盖。
```

### 9.2 协作者机器（那台机器）只做三件事

```
① 写代码 → commit → push（到对应仓库）
② 本地跑门禁：build-client / run-audit / run-guards / 新增测试
③ （可选）npm pack 出测试 tgz，把 sha1 写进汇报，供主机器核对
```

**禁止**：
```
· 不执行 npm publish（无令牌，也不该扩散令牌）
· 不改 npm 的 latest 标签（latest 必须保持 4.25.5）
· 不 force push
· 不改现有公开接口字段、不改数据库结构、不改 wrangler.toml 绑定
```

### 9.3 主机器（有令牌的那台）做的四件事

```
① git pull（拿到它的 commit），逐项 review diff
② 独立跑门禁（不信自述）：npm test / build-client / run-audit / run-guards verify / 新测试
③ 发版：pnpm publish --tag next（4.26.0-pre.N）→ 核对 registry shasum 与本地 tgz 一致
④ 通知用户安装测试；出问题用 `dist-tag add dsh-folia@4.25.5 latest` 回滚
```

### 9.4 汇报格式（协作者机器每次交付）

```
阶段：A/B/C
commit：<完整 hash>（插件仓库 / 站点仓库分别写）
改动：文件清单 + 关键函数
接口：新增/变更（方法+路径+请求/响应示例）
测试：X pass / Y fail（新增 N 条）
门禁：build / audit / guards 结果（贴原始输出行）
本地包：npm pack 产物 sha1（可选）
遗留：…
```

### 9.5 三门闸（一次只做一门）

```
门 1（站点 B）→ 主机器验收 → 通过
门 2（插件 A）→ 主机器验收 → 通过
门 3（插件 C + 联调）→ 主机器验收 → 通过 → 发 4.26.0
```

### 9.6 回滚预案

```
· npm：latest 冻结 4.25.5；本地备份 D:\folia-recover\releases\dsh-folia-4.25.5.tgz
        (sha1 19b03b76024c160a4e6ec8a39be948d1e145ef24)
· 代码：每阶段独立 commit，可 git revert
· 设置：petChat.enabled 默认 false，关掉即回到原状
· 站点：只新增 kind='pet'，git revert + push 即回滚
· 宠物包：卸载只删 harness\pets\<id>
```