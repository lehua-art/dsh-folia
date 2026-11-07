# 下一轮改造指令（协作者机器执行）

> 基于讨论定稿：默认走用户自己的 DeepSeek 大模型；补齐 P0 尾巴；再做长期记忆与主动闲聊；语音输入先 POC。
> 铁律：不发 npm、不动 latest（4.25.5）、不改现有公开字段、不 force push、不放宽断言；
> 每次交付：build-client → run-audit(0 失败) → verify-pet-chat → run-guards 全程 → push origin main → H1==H2。

---

## A. P0 收尾（0.5–1 天，必须先做）

### A1 默认来源改成用户自己的 DeepSeek
```
settings DEFAULTS.petChat：
  provider: 'openai'
  baseUrl : 'https://api.deepseek.com'
  model   : 'deepseek-chat'
  apiKey  : ''（用户填）
  enabled : false
首次打开气泡（或设置页）提示：
  "填入 DeepSeek API Key 即可对话（也可改用本机 Ollama，检测到 127.0.0.1:11434 时提示）"
```
- 判据：`state` 返回 provider=openai、baseUrl=deepseek、model=deepseek-chat；
  未填 key 时 `chat` 返回 `no-model` 并给可读 hint（不是 500）

### A2 清空记忆按钮
```
气泡右上角"清空记忆" → POST /folia/pet-chat/reset → 提示"已清空"
判据：清空后下一次 chat 的 history 为空（断言请求体）
```

### A3 人设默认值（可在设置里改）
```
persona: { name:'Folia', style:'元气、短句、偶尔颜文字、不说教', traits:'喜欢壁纸和游戏，被夸会害羞' }
系统提示词模板固定：中文口语、≤maxChars 字、不用 Markdown、不解释自己是 AI
判据：默认 persona 生效（断言 system prompt 含这三个字段）
```

### A4 预设台词库 ≥30 句（分组）
```
分组：问候(6) / 壁纸相关(8) / 陪伴与鼓励(8) / 空状态与失败兜底(5) / 夜间(3)
判据：数组长度 ≥30；`enabled=false` 与 `no-model` 两条路径都从这里取
```

### A5 门禁
```
build-client 0 / run-audit 0 失败 / verify-pet-chat 9 条全绿（新增 A1–A4 判据）/ run-guards 全程
```

---

## B. P1 长期偏好记忆（1–2 天）

### B1 存储
```
文件：~/.dsh-folia/pet-chat/memory.json（本机，不上传）
结构：{ nickname, likes:[], dislikes:[], style, notes:[], updatedAt }
上限：likes/dislikes ≤20 项、notes ≤10 条；单条 ≤40 字
```

### B2 写入时机（只存结论，不存原文）
```
① 用户显式："记住我喜欢原神" / "记住我叫你 Folia" ⇒ 直接写
② 每 10 轮（可配 memoryEveryTurns）让模型输出一次摘要 JSON：
   {"nickname":"","likes":[],"dislikes":[],"style":"","notes":[]}
   ⇒ 合并去重后写盘（不覆盖用户显式写入的项）
③ 绝不存聊天原文
```

### B3 注入
```
system prompt 末尾追加一段（≤80 tokens）：
  "关于主人：称呼={nickname}；喜欢={likes}；不喜欢={dislikes}；说话风格={style}；备注={notes}"
```

### B4 设置与隐私
```
memoryEnabled: true（首次启用时提示"会记住你的偏好，仅存本机，可随时清空"）
按钮：查看记忆（弹窗显示 JSON 摘要）/ 清空记忆 / 关闭记忆
```

### B5 判据
```
① 显式"记住X" ⇒ memory.json 出现该条，下一轮 system prompt 含它
② 第 10 轮触发摘要 ⇒ 合并且不重复
③ 清空 ⇒ 文件清空、prompt 不再含记忆
④ 关闭 ⇒ 不再写、不再注入
⑤ 隐私：memory.json 里不含聊天原文（grep 断言）
```

---

## C. P1.5 主动闲聊（1–2 天，默认关）

### C1 开关与计数
```
proactiveEnabled: false（默认）
proactiveDailyLimit: 10（可配 1–20）
proactiveMinGapMin: 120（两次间隔 ≥2 小时）
quietHours: '22:00-08:00'
气泡区显示"今日已说 N/10 条"（开启后可见）
```

### C2 触发条件（全部满足才说话）
```
① 已开启  ② 今日未超限  ③ 距上次 ≥120 分钟
④ 当前不在静默时段  ⑤ 用户空闲 ≥10 分钟（无键鼠/无会话活动）
⑥ 非全屏（检测 document.fullscreenElement）
⑦ 随机命中（建议每小时最多检查一次，命中率 25%）
```

### C3 内容
```
基于：当前时间/当前壁纸标题/记忆里的偏好
例："这张《原神 钟离》看了一晚上了，换一张吗？"
不做随机废话；≤40 字；可一键"今天别说了"
```

### C4 判据
```
① 默认关 ⇒ 不主动说话（模拟 3 小时无事件，0 次）
② 开启后：超日限/间隔不足/静默时段/全屏/非空闲 ⇒ 都不说话
③ 满足条件时最多每 2 小时 1 条
④ "今天别说了" ⇒ 当日不再主动
```

---

## D. P2 语音输入（先 POC，不阻塞 A–C）

```
POC 目标（半天，只出结论不改主线）：
① sherpa-onnx 能否复用 DSH 已带依赖（能 ⇒ 只带中文模型 60–120MB）
② 否则评估 Vosk 小模型（+45MB，流式）
③ 用一段 5 秒中文录音测：识别准确率、延迟、CPU 占用
输出：docs/ASR-POC.md（结论 + 建议方案 + 体积/延迟数据）
主机器依据结论决定是否立项。
```

---

## 交付顺序与汇报

```
A（P0 收尾）⇒ 停下汇报 ⇒ 主机器验收 ⇒ 发 4.26.0-pre.1 给用户真实验收
B（长期记忆）⇒ 停下汇报 ⇒ 验收 ⇒ 随下一版 next
C（主动闲聊）⇒ 同上
D（POC）可并行，只交文档
```

汇报格式：
```
项：A1–A5 / B1–B5 / C1–C4 / D
commit：<hash>
改动：文件 + 关键函数
判据：新增 N 条，X 通过 / Y 失败
门禁：build / audit / verify-pet-chat / guards 结果
证据：关键断言输出行
H1==H2：true/false
```
