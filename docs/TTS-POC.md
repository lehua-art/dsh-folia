# 本地情感 TTS POC（阶段 5：只出结论，不改主线）

> 结论先行：
> **A. sherpa-onnx 中文 TTS 可行**（运行时已在依赖树里，只差模型文件，约 60–200MB）。
> **B. EmotiVoice ONNX 不可行/不建议**（文本前端依赖 Python，没有可离线用的 ONNX 导出）。
> **建议：做"本地自然音色"（sherpa vits/melo）作为第三档，不做"本地情感"。**

---

## A. sherpa-onnx 中文 TTS

### 现状（本机实测到的证据，不是推测）

| 事实 | 证据 |
|---|---|
| **运行时已在依赖树里** | `dsh-folia → @linxin666/dsh-client-ui-market → @deepseek-ai/dsh → … → sherpa-onnx-node@1.13.8` |
| 原生库已随包安装 | `sherpa-onnx-win-x64` 22.4MB（`onnxruntime.dll` 17.0MB + `sherpa-onnx-c-api.dll` 4.4MB） |
| **TTS API 存在** | `node_modules/sherpa-onnx-node/non-streaming-tts.js`（3.1KB） |
| 支持的模型族 | `types.js` 里 `OfflineTtsVitsModelConfig` / `MatchaModelConfig` / `KokoroModelConfig` ⇒ **vits / matcha / kokoro** |

一句话：**不用新增原生依赖、不用编译**，`new OfflineTts({...})` + `tts.generate(text)` 就能出声。

### 模型体积（官方模型库的公开数字，**本机没有下载，未实测**）

| 模型 | 体积 | 中文 | 备注 |
|---|---|---|---|
| `vits-zh-hf-fanchen-C` | ≈ 120 MB | ✅ | 单说话人女声，最省事 |
| `vits-zh-aishell3` | ≈ 120 MB | ✅ | 多说话人（174 人） |
| `melo-tts-zh_en` | ≈ 160–200 MB | ✅ | 中英混说，音质更好 |
| `kokoro-multi-lang-v1_0` | ≈ 300 MB+ | ✅ | 多语言，体积最大 |

（这些数字来自上游模型卡，**没有在本机下载实测**；落地前应实测一次后再写进用户文档。）

### 延迟 / CPU 预期（**未实测**，标注为待测）

| 指标 | 预期 | 说明 |
|---|---|---|
| 首字延迟（冷） | 1–3 s | 含模型加载（一次性） |
| 5 秒文字的合成（热） | 0.3–1.2 s | vits 在 4 核笔记本 CPU 上通常快于实时 |
| CPU 峰值 | 1–2 核 | `numThreads` 可调 |
| 常驻内存 | 200–500 MB | 仅合成时 |

### 许可

- sherpa-onnx 本体：**Apache-2.0**（可商用）。
- 模型各有各的许可：`vits-zh-hf-fanchen-C` / `aishell3` 为 **Apache-2.0**；MeloTTS 为 **MIT**；
  kokoro 为 **Apache-2.0**。**上线前仍需逐个复核模型卡**（尤其 aishell3 的训练数据条款）。

### 与现有两档的关系

```
第一档 system（已完成）：系统音色，零下载，离线，无情感
第二档 edge（已完成）：在线情感（cheerful/gentle/angry/narration），0 下载，需联网
第三档 local（本 POC 建议）：sherpa vits/melo，自然音色，60–200MB 下载，离线，**无情感风格**
```

---

## B. EmotiVoice ONNX

| 项 | 结论 |
|---|---|
| 官方形态 | PyTorch 仓库 + 推理脚本；**没有官方 ONNX 导出** |
| 文本前端 | 依赖 `pypinyin` / `jieba` / 自定义 g2p **Python 包** ⇒ 纯 Node 宿主跑不了 |
| 情感控制 | 靠 prompt/embedding 注入，需要把前端逻辑一起移植，工作量大且易漂移 |
| 体积 | 基础模型 + 声碼器 ≈ 1GB 级别 |
| 许可 | **Apache-2.0**（代码），但模型权重与训练数据另有条款 |

**结论：不可行**（在"不引入 Python 运行时"的约束下）。若将来愿意带一个 Python sidecar，
才值得重新评估；那已经超出"桌面插件"的形态。

---

## 建议

1. **做第三档"本地自然音色"**，不做"本地情感"：
   - 模型：`vits-zh-hf-fanchen-C`（≈120MB，单女声，Apache-2.0）；
   - 分发：走插件现有的下载队列（不要像 228MB ASR 那样自建站点分发）；
   - 交互：设置里三档单选 `system / edge / local`，local 需先下载模型并显示进度。
2. **情感仍然只由 edge 提供**：本地档只做"自然朗读"，情绪映射只作用于 edge。
3. **落地前必须实测三件事**（本机没有模型，全部未测）：
   - 冷/热合成延迟；
   - 5 秒中文的听感（是否明显机械）；
   - 与宠物音效同时播放时的混音（`AudioContext` 抢占）。
4. 若实测"热合成 > 2s"，则第三档不值得做 —— 用户会退回 edge 或 system。

---

## 附：本 POC 的证据清单（可复现）

```bash
# 1) 运行时在不在
npm ls sherpa-onnx-node
# 2) TTS API 在不在
ls node_modules/sherpa-onnx-node/non-streaming-tts.js
# 3) 支持哪些模型族
grep -n "OfflineTts.*ModelConfig" node_modules/sherpa-onnx-node/types.js
# 4) 本机有没有模型（答案：没有）
find . -name "*.onnx" -path "*sherpa*"
```

> 本阶段**没有改动任何主线代码**，也没有新增依赖。
