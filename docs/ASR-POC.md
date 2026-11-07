# ASR POC：桌宠语音输入可行性与方案对比

> 结论先行（3 条）：
> 1. **能复用 sherpa-onnx，而且运行时已经在 DSH 的依赖树里** —— 不用新增任何原生依赖、不用编译。
> 2. 但**模型体积比工单估的大**：中英日韩粤 SenseVoice **int8 = 228 MB**（不是 60–120 MB），
>    fp32 = 894 MB。这是唯一的大成本。
> 3. 本机**没有实测** 5 秒中文录音的准确率/延迟/CPU（没有模型文件、也没有麦克风）；
>    下面给出可直接照做的测量协议与预期区间，**结论以主机器实测为准**。

---

## 1. sherpa-onnx 能否复用？—— **能，且已经在树里**

在插件仓库 `node_modules` 里直接找到（`npm ls` 的依赖链）：

```
dsh-folia@4.25.5
└─ @linxin666/dsh-client-ui-market@0.4.12
   └─ @deepseek-ai/dsh@0.2.1-rc.5
      └─ @deepseek-ai/dsh-experimental-voice-input-bundle@0.2.1-rc.5
         └─ @deepseek-ai/dsh-experimental-speech-to-text-sensevoice@0.2.1-rc.5
            └─ sherpa-onnx-node@1.13.8
```

| 组件 | 体积 | 说明 |
|---|---|---|
| `sherpa-onnx-node`（JS 绑定） | 0.1 MB | `non-streaming-asr.js` / `audio-tagg.js` / `keyword-spotter.js` |
| `sherpa-onnx-win-x64`（原生） | **22.4 MB** | `onnxruntime.dll` 17.0 MB + `sherpa-onnx-c-api.dll` 4.4 MB + `sherpa-onnx.node` 0.7 MB |
| `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` | 4.5 MB | SenseVoiceSmall + Silero VAD 的 **Provider**（子进程 worker、下载校验、推理队列） |

也就是说：**DSH 已经自带「本地 CPU 语音转文字」的完整运行时**，插件这边要做的不是"引入 ASR"，
而是"把桌宠录到的 5 秒 WAV 交给它"。

### 它的模型资产（`runtime/assets.json`，版本 + 大小 + sha256 都钉死）

| 资产 | 字节 | 约 |
|---|---|---|
| `model.int8.onnx`（**默认**） | 239,233,841 | **228 MB** |
| `model.onnx`（fp32 参考权重） | 937,617,178 | 894 MB |
| `tokens.txt` | 315,894 | 0.3 MB |
| `silero_vad.onnx` | 1,807,522 | 1.8 MB |

来源：`huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`（revision
`2365bae…`），Provider 支持 HF 与 hf-mirror 双源探测，下载后按 `bytes + sha256` 校验，
校验失败会自动换源重试。

**⇒ 复用结论**：新增**原生依赖 = 0**；新增**磁盘 = 230 MB**（int8 + tokens + VAD，首次使用才下载）。

---

## 2. 备选：Vosk 小模型

| 维度 | SenseVoice（复用现成） | Vosk 小模型（备选） |
|---|---|---|
| 中文准确率 | 高（中英日韩粤混说也行） | 中（安静环境短句可用） |
| 模型体积 | **228 MB**（int8） | **≈ 42 MB**（`vosk-model-small-cn-0.22`） |
| 运行时 | **已在树里（0 新增）** | 需新增原生包（≈ 20 MB，含平台二进制） |
| 流式 | 非流式（整段推理，配合 Silero VAD 切句） | 原生流式（可边说边出字） |
| 中文标点 | SenseVoice 自带（其输出含标点） | 小模型基本不带 |
| 集成成本 | **低**：调用现有 Provider | 中：新依赖 + 新 worker + 新校验链 |

**建议**：默认走 SenseVoice（零新增原生依赖、质量高）；只有当"必须边流边出字"或"磁盘 < 100 MB"
成为硬约束时才考虑 Vosk。

---

## 3. 5 秒中文录音的三个指标：**本机未实测**

诚实说明：这台机器**没有模型文件**（`node_modules` 里没有 `.onnx`），也没有可用的麦克风输入，
所以下面三项**不是实测值**，只是"该怎么测 + 量级预期"。

### 测量协议（主机器照做即可）

```bash
# 0) 准备：让 Provider 把模型下到 DSH home（首次 230MB，HF 不通时配 hf-mirror）
#    入口见 @deepseek-ai/dsh-experimental-voice-input-bundle 的 dataRoot
# 1) 录一段 5 秒中文（朗读稿：今天天气不错，我想换一张原神的壁纸，可以吗）
#    Windows 自带录音机 → 导出 wav（16kHz 单声道）+ 记下标准答案
# 2) 计时：首次（含模型加载）与第二次（热）
$env:ELECTRON_RUN_AS_NODE=1
node -e "…"   # 用 provider 的 transcribe() 包一层 performance.now()
# 3) CPU：任务管理器观察 worker 进程峰值；或 Get-Counter '\Process(*)\% Processor Time'
```

### 预期区间（SenseVoice-small int8 / 4 核笔记本 CPU，**待实测确认**）

| 指标 | 预期 | 说明 |
|---|---|---|
| 准确率（安静、朗读） | 字准 90–97% | 带标点；噪声/口音会掉 |
| 首字延迟（冷启动） | 1.5–4 s | 含 228MB 模型加载（一次性） |
| 5 秒音频推理（热） | 0.6–2.0 s | 大约 0.12–0.4× 实时 |
| CPU 峰值 | 1.5–3 核 | `threads` 可调；空闲时 worker 退出（`idleTimeoutMs`） |
| 常驻内存 | 300–600 MB | 仅推理时；空闲释放 |

> 这三个数字是**方案取舍的关键**：如果热推理 > 2s，桌宠语音输入的手感会很差，
> 那时要么换 Vosk 流式，要么改成"说完再等 1 秒"的异步提示。

---

## 4. 若立项，建议的最小落地路径（不改现有主线）

1. **录音**：客户端 `getUserMedia` + `MediaRecorder`（或 AudioWorklet 采 PCM）→ 5 秒上限 → 16kHz 单声道 WAV。
   ⚠️ 桌宠跑在 DSH 的渲染进程里，权限与麦克风可用性要在真机确认。
2. **转写**：把 WAV 交给现有 `speech-to-text-sensevoice` Provider（**不新写推理代码**）。
3. **回填**：转写文本填进 `src/pet-chat.js` 的输入框，走已有的 `/folia/pet-chat/chat`。
4. **开关**：`petChat.voiceEnabled`（默认 false）+ "下载模型 230MB" 的显式确认，不做静默下载。

---

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 模型 228 MB（比预期大） | 首次使用时明确提示体积 + 进度；可配镜像；失败可退 Ollama 文本对话 |
| HuggingFace 不可达 | Provider 自带 hf-mirror 探测与换源；也能指定 `modelOrigin` |
| 麦克风权限 / 隐私 | 只在用户点"语音"时申请；音频**只在本机内存**与本地 worker 之间流转，不上传 |
| 冷启动慢 | 首次转写前给"正在准备语音模型"提示；之后 worker 常驻至空闲超时 |
| 与桌宠动画抢资源 | 推理期间降低宠物帧率（沿用 `fpsCap` 那套思路） |

---

## 6. 结论

- **技术可行、复用度高**：DSH 已带 sherpa-onnx + SenseVoice Provider，插件侧只差录音与回填。
- **成本集中在一处**：230 MB 模型（int8），不是原生依赖。
- **是否立项的关键指标是"热推理延迟"**：只有主机器实测 5 秒录音的准确率/延迟/CPU 之后才能定
  （< 1.5s ⇒ 直接做；1.5–2.5s ⇒ 加等待提示；> 2.5s ⇒ 转 Vosk 流式或放弃）。
- 本 POC **未改任何主线代码、未新增依赖**。
