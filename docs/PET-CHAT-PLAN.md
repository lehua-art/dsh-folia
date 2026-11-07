# 桌宠对话 + 站点桌宠包：开发流程（v1）

> 目标：给**现有桌宠系统**加"能对话"能力（不新建宠物），并让站点能分发桌宠包。
> 版本策略：**npm 上 4.25.5 保持 latest 不动**；本功能开发版一律发 `next`（`4.26.0-pre.N`），验收通过才发 `4.26.0` 并切 latest。

---

## 0. 总体流程（谁先做）

```
阶段 A（插件侧，先做）：对话引擎 + 气泡 UI（用本机已有宠物，如鲸鱼娘）
        ↓ 验收：能聊、人设稳定、错误兜底
阶段 B（站点侧）：桌宠包作为"素材类型"（校验/预览/分发）
        ↓ 验收：站点能看到桌宠包、有封面
阶段 C（插件侧）：站点桌宠下载安装（zip 校验 → harness\pets → 启用）
        ↓ 验收：从站点装一个宠物并切换
阶段 D（可选）：TTS 朗读；STT 暂不做
```

**为什么先 A 后 B**：对话能力不依赖站点；先用本机宠物把"能聊"打通，站点只是分发渠道，风险更低。

---

## 1. 契约（先定下来，两边都按这个写）

### 1.1 站点侧「桌宠包」素材

```
分类：desktop-pet（已有）
mime：application/zip（≤64MB）
包内结构（必须）：
  pet.json                  ← 宠物清单（必须有）
  spritesheet.webp|png      ← 雪碧图（pet.json.sprite2d.spritesheetPath 指向）
  previews/（可选）          ← 至少 1 张预览图（gif/webp/png），用于列表封面
pet.json 必填字段（做校验）：
  petManifestVersion = 2
  id（slug 风格）、displayName
  renderer = 'sprite2d'
  sprite2d.frames[]（长度 = 行数）、sprite2d.tracks{idle:{durations[]}, ...}
公开列表返回（新增字段）：
  kind: 'pet'
  pet: { id, displayName, frames, columns, tracks: ['idle','running-right',...], previewUrl }
  bytes / sha256 / url（zip 直链）/ thumbUrl=previewUrl
```

### 1.2 插件侧安装

```
下载 zip → 校验 sha256（站点给的）→ 解压到 harness\pets\<id>\ → 校验 pet.json →
写入 pet 索引 → 「站点桌宠」里显示为已安装 → 可切换启用
卸载：删目录 + 清索引（不动用户其他宠物）
```

---

## 2. 阶段 A：插件对话引擎（2–3 天）

### 2.1 设置项（`lib/settings-schema.js` 新增一节 `petChat`）

```
enabled: boolean（默认 false，首次点击宠物时引导开启）
provider: 'ollama' | 'openai'（默认 ollama 优先检测，不可用提示选 openai）
baseUrl: string（默认 http://127.0.0.1:11434 / https://api.deepseek.com）
apiKey: string（仅 openai 需要；只存本机 profile，不打印、不上传）
model: string（默认 qwen2.5:7b / deepseek-chat）
persona: { name, style, traits }（默认见 2.4）
maxTurns: number（默认 8，最多 12）
maxChars: number（默认 80，最多 160）
proactive: boolean（默认 false，本阶段不实现）
```

### 2.2 宿主路由（新增 `lib/routes/pet-chat.js`，挂到 app）

```
GET  /folia/pet-chat/state    → { enabled, provider, model, reachable, lastError }
GET  /folia/pet-chat/models   → ollama /api/tags 列表（openai 返回空 + hint）
POST /folia/pet-chat/chat     → 请求体 { text, history? }
     响应：SSE 流（text/event-stream），事件：
       event: delta  data: {"t":"字"}
       event: done   data: {"usage":{...},"emotion":"happy|calm|tired"}
       event: error  data: {"code":"no-model|timeout|unauthorized|rate-limited","hint":"..."}
     · 超时 20s；同一来源 1 次/秒；单次输入 ≤400 字
     · 只转发到用户配置的端点，**不经过任何我们的服务器**
POST /folia/pet-chat/reset    → 清空会话记忆
```

### 2.3 客户端（新增 `src/pet-chat.js`，挂到宠物组件）

```
· 点宠物 → 气泡（输入框 + 历史 6 条 + 关闭）
· Enter 发送 / Esc 关闭 / 点击外部关闭
· 流式打字机（逐字追加，自动滚动）
· 状态：连接中 / 思考中（宠物做"思考"动作）/ 出错（显示 hint + 重试）
· 关掉 AI（enabled=false）→ 预设台词库（内置 30–50 句，按情绪分组）
· 快捷键：Ctrl+Alt+P 唤起/隐藏
```

### 2.4 人设默认（可在设置里改）

```
name: Folia
style: 元气、有点粘人、短句、偶尔颜文字、不说教、不解释自己是AI
traits: 喜欢壁纸/画画/打游戏；被夸会害羞；用户很久不说话会问"在忙吗"
系统提示词模板（代码里固定）：
  "你是 {name}，{traits}。用中文口语回答，最多 {maxChars} 字，不用 Markdown。
   对方是你的主人。不确定的事就说不知道。"
```

### 2.5 情绪与动作（P1，本阶段末尾一起做）

```
· 模型返回 emotion 标签（schema 里要求输出 JSON: {"reply":"...","emotion":"happy|calm|tired|angry"}）
  · 解析失败 ⇒ 兜底从关键词判断（哈哈/好耶→happy；不知道/算了→calm）
· 情绪 → tracks 状态映射（可配置）：
    happy → 有 wave 播 wave，否则 idle
    tired → 有 sleep 播 sleep，否则 idle
    calm  → idle
· 回复期间播放"说话动作"（如果包里没有，就保持 idle + 气泡打字机）
```

### 2.6 测试与门禁

```
· 新增 test/verify-pet-chat.mjs：
  ① SSE 流式（mock 端点，逐字到达）
  ② 无模型 ⇒ error.no-model + 预设台词兜底
  ③ 401 ⇒ error.unauthorized + 提示检查 key
  ④ 超时 20s ⇒ error.timeout
  ⑤ 上下文裁剪：第 9 轮时只带最近 8 条（断言请求体）
  ⑥ 回复超长 ⇒ 截断到 maxChars
  ⑦ 限频：1 秒内第二次请求 ⇒ error.rate-limited
  ⑧ emotion 解析失败 ⇒ 关键词兜底
  ⑨ key 不出现在任何日志/响应里（grep）
· npm test 全绿 + run-audit 0 失败 + run-guards 全链 + build-client 0
· 发 `--tag next`（`4.26.0-pre.1`），latest 保持 4.25.5
```

---

## 3. 阶段 B：站点侧桌宠包（1–2 天，交那台机器做）

```
① 上传识别：zip 内含 pet.json ⇒ 判定"桌宠包"（否则走原 zip 通道）
② 校验：petManifestVersion=2 / renderer=sprite2d / spritesheetPath 存在且是图片 /
        frames 长度 = spritesheet 行数 / tracks 至少含 idle / previews 至少 1 个
③ 元数据：pet.id、displayName、frames、columns、tracks 列表、previewUrl
④ 封面：从 previews/ 取第一张（gif 也可）作为 thumbUrl
⑤ 公开列表：kind='pet'、pet:{...}、url(直链)、sha256（上传时算好）
⑥ 后台：桌宠分类上传入口 + 列表显示"宠物/帧数/状态数/预览"
⑦ 失败处理：缺 pet.json / 结构不合法 ⇒ 422 + 具体原因（不静默通过）
⑧ 快照：桌宠包进入公开快照（同其他素材），静态化后 0 DB 读
验收：上传一个真实宠物包（如鲸鱼娘）→ 列表可见（带预览）→ 直链可下载 → sha 正确
```

---

## 4. 阶段 C：插件安装站点桌宠（1 天，插件侧）

```
· 「站点桌宠」区：GET 站点 desktop-pet 列表 → 卡片（预览/名称/大小/下载）
· 点安装：下载 zip（分片/流式，显示进度）→ 校验 sha → 解压到 harness\pets\<id>
  → 校验 pet.json → 写索引 → 提示"已安装，可切换"
· 已安装：显示"使用中/卸载"（复用现有逻辑）
· 失败：sha 不符/结构损坏 ⇒ 明确提示 + 删除半成品
验收：从站点装一个包 → 切换 → 宠物出现 → 对话可用
```

---

## 5. 阶段 D（可选）：TTS

```
· speechSynthesis 朗读（默认关，用户可在设置里开 + 选音色）
· 失败（无中文语音）⇒ 提示"系统未安装中文语音"
· STT（语音输入）暂不做：Electron 里 webkitSpeechRecognition 不可靠
```

---

## 6. 版本与发布策略

```
· npm latest = 4.25.5 冻结（你说保留这个版本）
· 本功能开发：4.26.0-pre.1 / pre.2 …（全部 --tag next）
· 验收通过 ⇒ 4.26.0 → next；你确认后再切 latest
· 站点侧改动只影响 desktop-pet 分类，不动现有公开字段（向后兼容）
```

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 用户没配模型 | 首次点击引导 + 预设台词兜底 |
| 用户 token 被烧 | 上下文 8 条、回复 80 字、限频 1/s、默认关主动闲聊 |
| 模型端点跨域 | 由宿主路由转发（本机 127.0.0.1），不受 CORS 限制 |
| key 泄露 | 只存 profile 设置，不打印、不进日志、不上传站点 |
| SSR 渲染慢 | 打字机 + "思考中"动作，首字延迟目标 ≤2s |
| 宠物包缺状态 | 情绪映射回落 idle；不报错 |
| 站点包损坏 | sha + 结构双重校验，失败删半成品 |
```
