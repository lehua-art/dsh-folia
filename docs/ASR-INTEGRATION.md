# 语音输入集成契约（插件 ↔ DSH 宿主）

> 一句话：**模型不由插件分发**。DSH 宿主已有 `ctx.speechToText` 服务，provider
> （`sensevoice-local`）自己下载并校验模型；插件只做「录音 → 上传 → 回填文本」。

## 1. 宿主侧端点

```
POST /folia/pet-chat/transcribe
Content-Type: application/json      { "audio": "<base64 wav>", "language": "zh" }
              或 audio/wav          （裸 WAV 字节体）

200 { ok:true,  text, audioSeconds, inferenceSeconds }
200 { ok:false, code:"asr-not-ready", hint, phase? }   ← provider 未注册 / 未就绪（缺模型、下载中、加载失败）
200 { ok:false, code:"asr-timeout", hint }            ← 推理超时（20s）
200 { ok:false, code:"asr-failed",  hint }            ← provider 抛错
200 { ok:false, code:"rate-limited", hint }           ← 同一来源 2 秒内第二次
400 { ok:false, code:"bad-request", hint }            ← 音频为空 / 不是 WAV / >15s / >2MB
```

**为什么 `asr-not-ready` 是 200 而不是 5xx**：它不是"服务器坏了"，而是"这个功能还没准备好"，
客户端要据此显示「去 DSH 设置里启用语音输入」，而不是弹错误框。

## 2. 就绪判定

```
snapshot().providers.find(p => p.id === 'sensevoice-local').preparation.phase === 'ready'
```

`phase` 取值范围：`unprepared | downloading | checking | loading | waking | ready | standby | cancelled | failed`。
只有 `ready` 才继续；其余一律回 `asr-not-ready`，并把 `phase` 带回去（便于界面说清是"没下载"还是"正在下"）。

## 3. 录制与音频格式

- 渲染进程 `getUserMedia({ audio: true })` + AudioWorklet 采 PCM；
- **必须是 16kHz 单声道 PCM16 WAV**（服务端只认这个；`wavSeconds()` 按头部算时长，不按字节数）；
- 单段 ≤ **15 秒**、≤ **2MB**；超了服务端 400，客户端在录音时就应停止；
- 音频**只在本机内存与宿主之间流转**，不上传任何第三方。

## 4. 用户体验约束（判据）

1. 按住说话；松手上传；识别结果**只填进输入框**，绝不自动发送；
2. 任何失败（没麦克风权限 / 未就绪 / 超时 / 限频 / 400）都**回落打字**，只给一行提示，不弹错误框；
3. 首次点击麦克风时说明"需先在 DSH 开启语音输入"（设置项 `petChat.voiceEnabled` 默认 **false**）。

## 5. 限频

同一来源 **1 次 / 2 秒**（`ASR_RATE_LIMIT_MS = 2000`）。按住说话的交互天然不会触发，
但防止脚本/连点把转写服务打满。
