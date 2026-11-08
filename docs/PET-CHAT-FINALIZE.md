# 未完成功能清单 + 一次性做完计划（协作者机器执行）

> 基线：`4.26.0-pre.1` 已发布（next=4.26.0-pre.1，latest=4.25.5）。
> 本文件 = 剩余全部工作量 + 自检标准。**一次跑完全部阶段，每阶段自检全绿再进下一阶段。**
> 铁律：不发 npm、不动 latest、不改现有公开字段、不加数据库列、不 force push、不放宽断言。
> 每阶段固定动作：改代码 → `build-client` → `run-audit`(0 失败) → `verify-pet-chat`(全绿)
> → `run-guards verify`(跑完全程) → commit → push origin main → 校验 H1==H2。

---

## 0. 未完成功能清单（按优先级）

| # | 功能 | 现状 | 目标 |
|---|---|---|---|
| 1 | **朗读回答（系统音色 TTS）** | ❌ 未做 | 默认开；文字照常显示 + 同时朗读；音色/语速/音量/试听；6 条判据 |
| 2 | **情感朗读（edge-tts 在线）** | ❌ 未做 | 第二档引擎；0 下载；按 emotion 选风格；失败回落系统语音 |
| 3 | **本地情感 TTS** | ❌ POC 未做 | 先半天 POC 出结论（sherpa 中文 TTS / EmotiVoice ONNX），再决定实现 |
| 4 | 情绪 → 朗读语气映射 | ❌ 依赖 1/2 | happy→cheerful、tired→gentle、angry→angry、calm→narration |
| 5 | **插件从站点装桌宠（门 3）** | ❌ 未开始 | 站点侧已就绪（kind='pet'）；插件「站点桌宠」列表 + 下载 + sha + 解压 + 启用 |
| 6 | 主动闲聊内容增强 | ⚠️ 判定层已有 | 内容基于时间/当前壁纸/记忆偏好，≤40 字，避免随机废话 |
| 7 | 语音输入实测 | ⚠️ 代码已发 | 需 DSH 开启语音输入（228MB 模型）后跑一次真实识别 |
| 8 | 端到端真实模型验收 | ⚠️ 未做 | 用户填 DeepSeek key 后跑一轮（主机器执行） |
| 9 | 口型/动作同步朗读 | ❌ 未做 | 可选，最后做；做不了就记录 |
| 10 | 用户使用文档 | ❌ 未做 | 主机器写 `docs/USER-GUIDE.md`（已另行产出） |
| 11 | 正式版与 latest 切换 | ❌ 未做 | 主机器在验收通过后发 `4.26.0` 并切 latest |

---

## 阶段 1：系统音色 TTS（半天）

```
设置项 petChat.voiceOut：
  enabled : true（默认开）
  rate    : 1.0（0.5–2.0）
  pitch   : 1.0（0.5–2.0）
  volume  : 1.0（0–1）
  voiceURI: ''（空 ⇒ 自动挑中文：Yaoyao → Huihui → Kangkang → 任意 zh）
行为：
  · 文字始终显示，朗读叠加，不替换
  · 回复结束整段读；流式时按句末标点分段读
  · 新消息/关闭气泡/点停止 ⇒ speechSynthesis.cancel()
  · 无 speechSynthesis ⇒ 静默跳过；无中文音色 ⇒ 只提示一次
  · 关闭 AI（走预设台词）时朗读同样生效
判据 6 条：①speak 一次且文本==气泡文本 ②文字仍在 ③关闭不调用 ④cancel 被调用
          ⑤speechSynthesis 缺失不抛错 ⑥无中文音色只提示一次
```

## 阶段 2：edge-tts 在线情感（1–2 天）

```
设置项 petChat.voiceEngine：'system' | 'edge'（默认 'system'，用户可切）
  · 'edge'：在线，0 下载，需联网；文本会经微软（设置页给隐私提示）
  · 风格映射：emotion happy→cheerful、tired→gentle、angry→angry、calm→narration
  · 失败（网络/接口变更/超时）⇒ 自动回落 system 并记一次日志（不弹窗）
实现：
  · 宿主侧路由 POST /folia/pet-chat/speak（返回音频字节或流），不要在渲染进程里直连第三方
  · 复用现有 edge-tts 客户端（若无，用 msedge-tts 之类轻量实现；不新增原生依赖）
判据 5 条：①engine=system 不请求网络 ②engine=edge 请求成功并返回音频
          ③edge 失败回落 system 且只记一次日志 ④风格随 emotion 变化（断言 SSML/style 参数）
          ⑤关闭朗读时两档都不触发
```

## 阶段 3：插件从站点装桌宠（1 天）

```
· 「站点桌宠」区：GET 站点 desktop-pet（只取 kind='pet'）→ 卡片（预览/名称/大小）
· 安装：下载 zip（进度）→ sha256 校验 → 解压 harness\pets\<pet.id> → 校验 pet.json → 写索引
· 失败：sha 不符/结构坏 ⇒ 明确提示 + 删除半成品
· 已安装：复用"使用中/卸载"
判据 5 条：mock 列表渲染 / 下载+校验+解压成功 / sha 不符清理 / 缺 pet.json 清理 / 卸载只删该目录
```

## 阶段 4：主动闲聊内容增强（半天）

```
· 内容来源：当前时间（早/午/晚/深夜）、当前壁纸标题、记忆偏好、最近对话主题
· 长度 ≤40 字；禁止"随机废话"模板；同一内容不重复（当日去重）
· "今天别说了" ⇒ 当日不再；次日恢复
判据 3 条：①内容含上下文要素（时间或壁纸名）②同日不重复 ③今天别说了生效且次日恢复
```

## 阶段 5：本地情感 TTS POC（半天，只出文档）

```
验证：
 A. sherpa-onnx 中文 TTS（vits/melo）能否在插件宿主跑通、模型体积、延迟
 B. EmotiVoice ONNX 是否可行（文本前端依赖、Python 是否必须）
产出 docs/TTS-POC.md：
 · 结论（可行/不可行/需外部运行时）
 · 体积、延迟、CPU、许可
 · 建议（作为第三档"本地情感"还是只做"本地自然音色"）
不改主线代码；POC 结论由主机器决定是否立项
```

## 阶段 6：收尾

```
· 更新 docs/PET-CHAT-DONE.md（各阶段完成度 + 证据）
· 全量门禁再跑一遍（build / audit / verify-pet-chat / guards）
· 两仓库 push + H1==H2
· 报告：阶段 / commit / 判据数 / 门禁结果 / 未完成项
```

---

## 汇报模板

```
阶段 N：commit=<hash> 判据 X 通过/0 失败 门禁(通过/退役/失败) guards=<步数> H1==H2=true
整体：完成 N/6；未完成：…；阻塞：…
```
