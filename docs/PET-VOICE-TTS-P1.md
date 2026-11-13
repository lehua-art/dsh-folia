# P1 智能语音桌宠闭环（4.26.0-pre.45）

> 目标：点桌宠说话 → 说完自动停 → 气泡逐句字幕 + 朗读 → 说话/点击/打字立刻打断。
> 不重写既有语音栈（ffmpeg 录音 / SenseVoice 转写 / SSE 对话），只补「合成 + 播放 + 打断 + 联动」。
> 对照：`docs/PET-CHAT-PLAN.md` §2.2（对话接口）与 `docs/PET-VOICE-V01-WORKORDER.md`（v0.1 范围）。

## 1. 合成链（宿主侧，**不新增模型/下载**）

`lib/tts/tts-worker.cjs` 是真实合成子进程（NDJSON），按顺序试两条引擎：

| 顺序 | 引擎 | 实现 | 前提 |
|---|---|---|---|
| ① | `sapi` | PowerShell + `System.Speech`（SAPI5 桌面音色） | Windows 自带 |
| ② | `edge` | PowerShell + WinRT `Windows.Media.SpeechSynthesis`（Edge「大声朗读」使用的 OneCore/系统音色，离线） | Windows 自带 |
| ③ | — | `{ ok:false, code:'tts-unavailable', attempts:[…] }` | 两条都失败时明确报错 |

约定：

- **音色 → 引擎路由（pre.46）**：`zh-CN-XiaoxiaoNeural` 这类 Edge/WinRT 命名（`/^[a-z]{2}-[A-Z]{2}-\w+Neural$/`）
  先走 `edge`；`Microsoft Xxx Desktop` 或空音色先走 `sapi`。显式音色在某一跳不存在时脚本
  `throw voice-not-found`，该跳记一次 attempt 后换下一跳；**不许用默认音色静默当成功**。
- **缓存 key 含引擎（pre.46）**：`sha256('v1|<engine>|<voice>|<rate>|<text>')`。同一句话在
  SAPI 与 Edge 下是不同音色，不能互相命中；命中时还会校验缓存里的实际音色与请求一致，
  修复前留下的“Huihui 冒充 Xiaoxiao”旧条目会被丢弃重合成。
- **可观测（pre.46）**：`/tts` 响应头 `X-Folia-TTS-Requested-Voice` / `X-Folia-TTS-Voice`（实际）/
  `X-Folia-TTS-Engine` / `X-Folia-TTS-Attempts`（URI 编码 JSON）；`/tts/state` 回
  `requestedVoice / actualVoice / engine / attempts / lastTts`。
- **中文文本只经 UTF-8 JSON 文件**，从不放进命令行参数（避开 Windows PowerShell 引号/编码坑）；
- PowerShell 的 **stdin/stdout/stderr 不走管道**（Electron 里 piped stdio 会 EPERM）：配置/脚本/日志/音频全部走临时文件；
- SAPI/Edge 脚本是 **ASCII**，脚本 stdout 的 `OK <voice>` 回真实选中的音色；
- 未显式指定音色时：SAPI 选 `zh-CN` 默认（再退任意），Edge 选 `zh*` 默认（再退任意）；
  显式指定时只接受精确匹配，匹配不到就是该引擎的 attempt 失败。
- 单句 240 字上限；单引擎 12s 超时；同一句命中缓存（`<DSH_FOLIA_HOME>/tts/cache`）为 0ms。
- 本机没有 Edge 音色包时的行为：`/tts` 回 503 + `attempts` 里逐跳写明
  `voice-not-found: <voice>`（不会静默换成 Huihui）。

## 2. 路由（`lib/routes/pet-chat.js`）

```
GET  /folia/pet-chat/tts?text=&voice=&rate=   → 200 audio/wav（单句）
                                              400 参数不合法 / 409 已被 stop 作废 / 503 合成不可用
POST /folia/pet-chat/tts/stop                 → { ok:true, stopped:true }（幂等）
GET  /folia/pet-chat/tts/state                → 引擎/就绪/缓存目录/当前音色（不触发合成）
GET  /folia/pet-chat/events                   → SSE 反向通道（工作联动）
POST /folia/pet-chat/speak  { text, voice? }  → 广播给已连上的桌宠；无客户端时最多排队 5 条
```

`voice` / `rate` 缺省取设置里的 `petChat.voice`；`rate` 是 SAPI 的 -10..10（0 = 正常）。

## 3. 客户端（`src/pet-tts.js` + `src/pet-chat.js`）

- `petSpeak(text, {voice, rate})`：按句切分 → 逐句 `GET /tts` → `Audio` 排队播放；
  播放时把当前句交给气泡（逐句字幕），并预取下一句。
- `petSpeakStop()`：清队列、暂停当前音频、`POST /tts/stop` 通知宿主作废在途合成（幂等）。
- **barge-in**：`petVoiceInput.start()` 在 `postRecord` 之前先调 `onBeforeRecord()`（= `petSpeakStop()`）；
  点桌宠 / 打字发送也先停朗读。
- **VAD 自动停**：`lib/voice/record.js` 边录边轮询 ffmpeg 的 `silencedetect`，
  说完后向 ffmpeg stdin 写 `q` 优雅退出（直接 kill 会留下 0 字节/半截 WAV）；
  覆盖「一开口就说话、没有前导静音」的场景。录音结束后立刻转写并开始 SSE，
  第一句标点一到就入队合成/播放，不等整段回答。
- **三态气泡**：`listen`（●）/ `think`（…）/ `speak`（四根跳动竖条，CSS 伪元素 + `currentColor`，不新增颜色）。
  不弹窗；失败只进气泡提示行。
- **工作联动**：`window.__dshFoliaPet.speak(text)` / `window` 上的 `we-pet-speak` 事件 /
  宿主 `POST /pet-chat/speak` 三条入口，最终都走同一个 `petSpeak`。

## 4. 判据与门禁

`test/verify-voice-tts.mjs`（27 条，已挂 `test/run-guards.mjs` 的 verify 硬档）：

- 真合成：worker 一次性模式真跑 PowerShell，断言 exit 0 / RIFF/WAVE / **>10KB** / 引擎名；
- 兜底链：注入假引擎证明 SAPI 失败 → Edge 成功，两条都失败 → `tts-unavailable` + 每跳原因；
- 路由：真 `http.Server` 上 GET 200 + `audio/wav` + >10KB、HEAD、400、503、stop 幂等、`/speak`+`/events`；
- 打断顺序：运行时断言 `onBeforeRecord → postRecord`；源码断言 wake/打字入口先 `petSpeakStop()`；
- 分句/排队/stop：假播放器证明按句请求、顺序播放、stop 清队列并 pause；
- 三态气泡：`data-state` 四态 + 波形 CSS；
- 发布面：`package.json files` 覆盖 `lib/tts/`。

门禁数字随链更新：`CHAIN_FLOOR` 抬到 `142/155`，fixture 与 `docs/GUARD-MAP.md` 同步重生成。
