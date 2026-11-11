# v0.1.1 返工单（A 机执行，7 项 + UI 判据）

> 来源：pre.10 真机验收失败项。全部**已定位到代码位置**，不要再猜。
> 目标：一次改完 → 主机器真机点一遍通过 → 才发 pre.11。
> 铁律：不发 npm、不改公开字段、每项独立 commit、门禁全绿。

---

## P1 客户端解包错一层 ⇒ "保存失败"（最高优先）

### 现象
```
填完 Key/名字点保存 → 红字「保存失败」
但服务端其实**已经存进去了**（curl 保存后 GET 能读到 petName/ownerName/apiKey）
同时界面永远显示「还没有填 API Key」
```

### 根因
```js
// src/panel-tabs-pets.js 的 PetChatSettings
const resp = await apiJson('/pet-chat/config', {...});  // resp = { ok, status, data }
const doc  = (resp && resp.data) || {};                 // doc = { ok:true, data:{saved:true} }
if (doc.saved) { 已保存 } else { 保存失败 }              // doc.saved === undefined ⇒ 永远失败
```

### 修法
```js
// 统一 helper（放 client 工具区，所有 apiJson 调用点复用）
const unwrap = (resp) => (resp && resp.data && resp.data.data) || (resp && resp.data) || {};
```
```
· /pet-chat/config GET：doc = unwrap(resp)（取到 hasApiKey / apiKeyMasked / petName…）
· /pet-chat/config POST：doc = unwrap(resp)，判断 doc.saved
· /pet-chat/state：sdoc = unwrap(resp)，判断 sdoc.reachable / sdoc.lastError
```

### 判据（新增）
```
① mock fetch 返回 { ok:true, data:{ ok:true, data:{ saved:true } } } ⇒ 界面必须显示"已保存"
② mock 返回 { ok:true, data:{ ok:true, data:{ hasApiKey:true, apiKeyMasked:'sk-••••abcd' } } }
   ⇒ 状态行显示"已保存的 Key：sk-••••abcd"（不是"还没有填"）
```

---

## P2 config 保存是"覆盖"不是"合并" ⇒ 保存名字会把模型配置冲掉

### 现象（已实测）
```
POST /pet-chat/config 只传 { petName } ⇒ 返回的 provider 变成 ollama、
baseUrl 变成 http://127.0.0.1:11434/v1、model 变成 qwen2.5:7b
```

### 修法
```
服务端：未出现的字段保持原值；只有显式传 null 或空串才清空（apiKey 空串=清空，保持现有语义）
· provider / baseUrl / model / petName / ownerName / voice / wake 都按"未传则保留"
```

### 判据
```
① 只传 { petName:'老朱' } ⇒ provider/baseUrl/model/apiKey 与保存前完全一致
② 传 { apiKey:'' } ⇒ key 被清空（这是唯一允许清空的动作）
```

---

## P3 气泡不跟随桌宠

### 现象
```
气泡只在打开时定位一次；拖动桌宠 / 改变窗口大小后，气泡留在原地
```

### 修法
```
src/pet-bubble.js：
· 打开期间启动 requestAnimationFrame 循环（或监听桌宠拖动/缩放事件）每帧调用 position()
· 关闭时停止循环（cancelAnimationFrame），避免后台空转
· 锚点仍用 getAnchor()（桌宠头顶），position() 内部做 translate(-50%, -100%)
· 页面隐藏（document.hidden）时暂停循环
```

### 判据
```
① 假 anchor 从 (100,200) 变 (300,400) ⇒ 气泡 left/top 随之变化（±1px）
② hide() 后 rAF 停止（用假 rAF 计数断言不再回调）
```

---

## P4 气泡显示的是"用户说的话"（回声）

### 现象
```
用户打字或说话后，气泡里出现的是用户原话
```

### 根因
```js
// src/pet-chat.js
onText: (text) => { petBubble.append(text); },   // ← 把用户转录文本 append 进气泡
```

### 修法
```
· 删除上面这行（用户文本只写入输入框，不进气泡）
· 气泡只接收：assistant 的回答（SSE delta / 最终文本）
· 步骤气泡状态：listen('我在听…') → think('…') → answer(逐字回答) → 结束淡出
```

### 判据
```
① 输入"今天天气怎么样" ⇒ 气泡内容**不包含**"今天天气怎么样"
② 回答文本逐字出现在气泡里（delta 数 > 1）
```

---

## P5 气泡没有关闭按钮

### 修法
```
· 气泡右上角加 ×（button，aria-label="关闭"）
· 点击 ⇒ petBubble.hide(0)＋停止 rAF＋停止录音
· 关闭后点桌宠必须能重新打开（回归判据）
```

### 判据
```
① 气泡 DOM 里有 .pet-bubble-close
② 点击后气泡隐藏；再次点桌宠 ⇒ 气泡重新出现
```

---

## P6 /pet-chat/record 抛 `voiceRecorder is not defined`

### 现象（日志实锤）
```
ReferenceError: voiceRecorder is not defined
    at handleRecord (lib/routes/pet-chat.js)
⇒ 点桌宠录音直接失败，返回 400
```

### 根因
```
只 import 了 createVoiceRecorder，没有实例化
```

### 修法
```
在 registerPetChatRoutes 闭包里创建一次：
  const voiceRecorder = createVoiceRecorder({ resolveFfmpeg: defaultResolveFfmpeg, runFfmpeg: defaultRunFfmpeg });
```

### 判据
```
① voiceRecorder 未定义时 /record 返回 500 且日志有错误（这条 bug 应被测试抓到）
② 正常路径：mock runFfmpeg 产出 wav ⇒ /record 返回 { ok:true, text }
```

---

## P7 转写参数契约错：`audioPath` → 应为 `audio` 字节

### 现状
```js
await speechToText.transcribe({ audioPath: result.audioPath, language })
```

### DSH 契约
```
speechToText.transcribe({ audio: Uint8Array, language, providerId? })
· providerId 从 snapshot() 里解析（现有 handleTranscribe 已有这套逻辑，直接复用）
```

### 修法
```
读 out.wav → Uint8Array → 走与 handleTranscribe 相同的 spec 构造与错误映射
（no-provider ⇒ asr-not-ready；超时 ⇒ asr-timeout；SpeechInputError ⇒ bad-request）
```

### 判据
```
① 传合法 wav ⇒ 返回 text
② provider 未就绪 ⇒ asr-not-ready（不是 500）
③ 音频 > 2MB ⇒ bad-request
```

---

## 统一验收（门禁 + UI）

```
门禁：
  node scripts/build-client.mjs        → 0
  node test/run-audit.mjs              → 0 失败
  node test/verify-entry-load.mjs      → 通过
  node test/verify-pet-voice.mjs       → 全绿（含上面 P6/P7 新增）
  node test/verify-pet-settings.mjs    → 全绿（含 P1/P2 新增）
UI 级（用 jsdom + 假 anchor/fetch，新增 test/verify-pet-bubble.mjs）：
  ① 信封解包：mock {data:{data:{saved:true}}} ⇒ 显示"已保存"
  ② 不回声：用户文本不进气泡
  ③ 跟随：anchor 变化 ⇒ 位置变化
  ④ 关闭按钮：存在 + 点击隐藏 + 再点桌宠可重开
  ⑤ rAF 在 hide 后停止
```

## 交付

```
· 每项一个 commit（P1…P7 分开），commit message 写"修 X + 判据 Y"
· 交付报告：每项 = 现象 / 改动文件 / 判据结果 / 门禁结果
· 主机器在真机点一遍（保存、气泡、跟随、关闭、录音）通过后才发 pre.11
```
