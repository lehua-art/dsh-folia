# 双环境语音策略（桌面端 / 浏览器端自动切换）

> 背景：桌面端（Electron）麦克风被 DSH 权限处理器拦死；浏览器端（Edge/Chrome 打开 DSH Web UI）
> 麦克风由浏览器授权，且 Edge 自带「晓晓/云希」等自然语音（localService=false，需联网）。
> 目标：**同一份插件，按运行环境自动选最合适的录音与朗读通道，用户无感。**

---

## 1. 环境判定（唯一判据）

```js
const isElectron = /Electron/i.test(navigator.userAgent)
  || (typeof window !== 'undefined' && window.process && window.process.versions && window.process.versions.electron);
const env = isElectron ? 'desktop' : 'web';
```

```
判据要求：
· 只在这里判定一次，导出 getVoiceEnv()，其它模块复用（禁止多处各写一套）
· 判定结果写进日志（[pet-voice] env=desktop|web），便于真机排查
```

---

## 2. 录音通道

| 环境 | 通道 | 端点 | 权限 |
|---|---|---|---|
| **web（浏览器）** | `getUserMedia` + MediaRecorder/AudioWorklet → WAV | `POST /folia/pet-chat/transcribe` | 浏览器弹窗授权 |
| **desktop（Electron）** | 宿主 ffmpeg（dshow）录音 | `POST /folia/pet-chat/record` | Windows 系统麦克风权限 |

```
实现要求：
· 前端按 env 选通道；**不要把两条都跑一遍**
· web 通道失败（用户拒绝/无设备）⇒ 提示 + 自动切「右键 → 打字说」
· desktop 通道失败（no-device/ffmpeg-missing）⇒ 同样提示 + 切打字
· 两条通道最终都落到同一个转写服务（speechToText），文本处理逻辑共用
```

---

## 3. 朗读通道（优先级链）

| 环境 | 优先级 1 | 优先级 2 | 优先级 3 |
|---|---|---|---|
| **web** | Edge 自然语音（名称含 `Online (Natural)` 且 `zh-CN`） | 本机中文 SAPI5（Huihui/Yaoyao/Kangkang） | 只显示文字 |
| **desktop** | 本地 Melo（已下载时，宿主 /tts/speak） | 中文 SAPI5 | 只显示文字 |
| **两者** | 装了 dsh-audiogen 且已配渠道 ⇒ 最高优先 | — | — |

```
细则：
· Edge 自然语音通过 speechSynthesis 直接用（voice.name 匹配 /Online \(Natural\)/ 且 zh 语言）
· Edge 自然语音是**在线**的（localService=false）：断网会失败 ⇒ 失败自动回落下一档
· 音色偏好存 settings.voice.name（web 存 Edge voiceURI，desktop 存 Melo 标记），不要硬编码
· 任何一档失败都只记日志 + 状态行提示，不弹窗、不打断对话
```

---

## 4. 交互不变（沿用 v0.1 定稿）

```
点桌宠 → 气泡「我在听…」→ 录音（按 env 选通道）→ 转写 → /chat(SSE)
→ 气泡逐字显示回答（不显示用户原话）→ 朗读（按 env 选通道）→ 结束淡出
关闭按钮 ×；点桌宠可重开；气泡跟随桌宠（rAF）；主动搭话零配置（语音叫停/恢复）
```

---

## 5. 设置页（只加一个只读提示，不加开关）

```
桌宠语音助手
  [模型 Key]
  [名字] [称呼]
  语音通道：自动（当前：浏览器 / 桌面）   ← 只读展示，用户不需要选
  朗读音色：[自动（推荐）] / [具体音色列表]（按当前环境列出可用音色）
```

---

## 6. 判据（必须进 run-audit）

```
R1 环境判定：mock navigator.userAgent 含 Electron ⇒ env=desktop；不含 ⇒ env=web
R2 web 录音：env=web 时只调 getUserMedia，不调 /pet-chat/record
R3 desktop 录音：env=desktop 时只调 /pet-chat/record，不调 getUserMedia
R4 web 朗读：getVoices 含 "Microsoft 晓晓 Online (Natural)" ⇒ 优先选它（断言 speak 的 voice）
R5 web 朗读回落：无自然语音 ⇒ 选 zh 本地音色；都没有 ⇒ 只显示文字不抛错
R6 desktop 朗读：Melo 未下载 ⇒ 用 SAPI5；已下载 ⇒ 调宿主 /tts/speak（断言调用）
R7 断网模拟（自然语音 speak 抛错）⇒ 回落下一档并记一次日志
R8 两条通道都不改变"气泡只显示回答"的行为
```

---

## 7. 交付

```
· 每项一个 commit（环境判定 / 录音分通道 / 朗读分通道 / 判据）
· 真机验收（主机器）：
  ① 桌面端：点桌宠 → ffmpeg 录音 → 转写 → 回答 → SAPI5 朗读
  ② 浏览器端（Edge 打开 DSH Web UI）：点桌宠 → 浏览器授权 → 录音 → 转写 → 晓晓朗读
· 浏览器端入口：DSH 启动时会打印带 token 的 URL（http://127.0.0.1:43129/?token=…）
```
