# v0.2 定稿：本地开源 TTS（VITS-zh）+ 系统音色兜底

> ⚠️ **4.26.0-pre.45 起，P1 已改用「SAPI → Windows Edge/OneCore 系统音色 → 明确错误」**：
> 不再下载 VITS 模型、不再带 node.exe。见 `docs/PET-VOICE-TTS-P1.md`。本文保留为当时的
> 模型方案与实测结论（sherpa-onnx 子进程边界仍然适用）。
>
> 决策（2026-11-10 定稿）：**不做任何云 TTS**（火山/Azure 全部搁置）。
> 说话 = 本地开源模型（VITS-zh），免费、离线、无 key；失败回落系统音色。
> 前置：v0.1（头顶气泡 + 语音主链路 + 名字/记忆）已验收。

---

## 1. 已实测的技术结论（不是设想）

```
✅ 模型能跑：sherpa-onnx-node + VITS-zh（theresa 22.05k / fanchen 16k）
   5 秒音频 ≈ 1.1–1.6 秒合成（CPU 2 线程），RTF ≈ 0.3
✅ 输出：16k/22.05k 单声道 WAV → 可转 mp3 播放
❌ 在 Electron 进程里会失败：
   `External buffers are not allowed`（V8/Electron 外部内存限制）
   ⇒ **合成必须放进独立子进程**（普通 node.exe）
❌ DSH 自带的 "node.cmd" 其实是 Electron-as-node，同样失败
   ⇒ 我们必须随包带一个真正的 node.exe（约 30MB）
```

## 2. 分发形态

```
"语音运行时包"（zip，约 145MB）：
  ├─ node.exe                 （约 30MB，Node.js MIT 许可，附 NOTICE）
  ├─ tts-worker.js            （我们写的子进程入口）
  ├─ models/vits-zh-theresa/  （theresa.onnx 116MB + tokens.txt + lexicon.txt + 几个 fst）
  └─ MANIFEST.json            （版本、文件清单、每个文件 sha256）

托管：我们站点（R2），走现有分片上传（≤2GB）
下载：插件首次开语音时提示"需下载约 145MB" → 分片下载 → 校验 → 解压到
      ~/.dsh-folia/tts/<version>/
校验：整包 sha256 + 逐文件 sha256；不符即删半成品并提示重试
```

## 3. 插件架构

```
宿主（主进程）
  lib/tts/local.js
    · 状态机：absent → downloading → verifying → ready → broken
    · spawn(node.exe, tts-worker.js)，stdio 用 NDJSON：{id, text, speed} → {id, wavBase64, ms}
    · 常驻 worker：首次合成时启动；空闲 5 分钟自动退出；崩溃自动重启 1 次
    · 队列：同一时刻只跑一条（CPU 型任务），其余排队；支持 cancel(id)
    · 超时：单句 15 秒；超时 kill 并回落系统音色
  lib/routes/tts.js
    GET  /folia/tts/state    → { engine:'local'|'system', ready, version, bytes, progress?, lastError }
    POST /folia/tts/install  → 开始下载（返回任务 id）
    GET  /folia/tts/progress → 进度（已下载/总大小/阶段）
    POST /folia/tts/speak    → { text, speed? } → { audioBase64, mime:'audio/wav', ms }
    POST /folia/tts/stop     → 取消当前合成
    DELETE /folia/tts        → 卸载（删目录）

渲染进程（src/）
  · 朗读时：先把文本按标点切句（每句 ≤40 字）→ 逐句 speak → 边合成边排队播
  · 播放用 <audio> 或 AudioContext；与气泡逐字同步
  · 本地不可用/报错 → 立即回落 speechSynthesis（系统音色）
```

## 4. 文本处理（音质的另一半）

```
合成前做规范化（TS 工具函数，单测覆盖）：
  · 数字 → 中文读法（1 → 一、2024 → 二零二四、3.5 → 三点五）
  · 常见缩写 → 读法（AI → A I、OK → 欧克，可选）
  · 标点 → 停顿（，。！？→ 短停顿）
  · 长句按标点切分（≤40 字/句）
  · 表情/颜文字/括号注释剥离
```

## 5. 设置项

```
petChat.voice = {
  engine: 'local' | 'system',      // 默认 local；本地未就绪自动用 system
  speed: 1.0,                      // 0.8–1.2
  volume: 1.0,
  muted: false,
}
语音运行时：状态展示（未下载/下载中 X%/就绪/损坏）+「下载」「重新下载」「卸载」
```

## 6. 判据（进 run-audit）

```
L1 模型缺失 ⇒ state.ready=false，speak 回落系统音色（不报错）
L2 下载：进度回调、sha 不符 ⇒ 删半成品并提示（不覆盖旧版本）
L3 解压：MANIFEST 校验通过后置 ready；文件缺失 ⇒ broken
L4 子进程：spawn → 合成 → 返回 wav（mock worker）；worker 崩溃 ⇒ 重启 1 次
L5 队列：并发 3 条 ⇒ 串行执行，结果不错乱
L6 超时 15s ⇒ kill + 回落，不阻塞下一条
L7 文本规范化：数字/英文/长句切分（≥8 个用例）
L8 卸载：删目录 + state 回 absent
```

## 7. 许可与合规

```
· node.exe：Node.js（MIT）→ 包内附 LICENSE + 版本
· 模型：sherpa-onnx 官方发布的 VITS-zh 模型，需在 README 附模型来源与许可
· 下载前给用户明确提示："将下载约 145MB，仅用于本地语音合成，不上传任何数据"
```

## 8. 分步（当天交付）

```
S1（0.5 天）本地 TTS 子进程 + worker 协议 + local.js 状态机（可用本地模型手测）
S2（0.5 天）站点托管 + 下载/校验/解压 + 进度 UI
S3（0.5 天）speak 路由 + 渲染播放 + 分句 + 回落系统音色
S4（0.5 天）文本规范化 + 判据 L1–L8 + 门禁
S5（0.5 天）真实安装验证（主机器）：装插件 → 下载 → 点宠物 → 听声音
```

## 9. 汇报

```
每步：commit / 状态机阶段 / 判据数 / 门禁 / 本地合成耗时（ms/秒音频）
```
