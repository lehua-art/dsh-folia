# 朗读回答（TTS）——加入本版，与文字同时出现

> 用户要求：**文字气泡照常显示，同时把回复念出来**（不是"二选一"）。
> 实现方式：浏览器内置 `speechSynthesis`（Electron 里走 Windows SAPI 语音），零新增依赖、零 token。
> 归属：协作者机器实现；主机器验收后随 `4.26.0-pre.1` 一起发布。

---

## 1. 设置项（`petChat.voiceOut`）

```
enabled : true（**默认开**：用户要求装完就能听到回答；首次朗读时提示"使用系统语音，无需下载/不耗 token"）
rate    : 1.0（0.5–2.0）
pitch   : 1.0（0.5–2.0）
volume  : 1.0（0–1）
voiceURI: ''（空 = 自动挑中文音色：优先含 zh / Chinese / Huihui / Xiaoxiao 的语音）
```

```
与现有"桌宠声音"开关的关系：宠物面板已有"声音"复选框 + 音量；
朗读是独立的"朗读回复"，不受宠物音效开关影响（避免用户想静音音效却听不到回答）
```

## 2. 行为

```
① 文字永远显示（气泡 + 打字机），**朗读是叠加**，不能替换文字
② 朗读时机：回复结束后整段朗读；若走流式，按"句末标点"分段朗读（更自然）
③ 打断：新消息 / 关闭气泡 / 点"停止" ⇒ speechSynthesis.cancel()
④ 静音：用户切到别的窗口/全屏时不朗读（可配置，默认：仅窗口有焦点时读）
⑤ 降级：
   · 没有 speechSynthesis ⇒ 静默跳过，不报错
   · 没有中文音色 ⇒ 读一次提示"系统未安装中文语音"，之后不再提醒
⑥ 关闭 AI（enabled=false，走预设台词）时：朗读仍生效（读预设台词）
```

## 3. 实现位置

```
客户端 src/pet-chat.js：
  · petChatSpeak(text)   —— 组装 utterance（rate/pitch/volume/voice），speak
  · petChatStopSpeak()   —— cancel
  · 在 done 事件后调用；在 hide/新请求前调用 stop
设置页：朗读回复 开关 + 语速/音量/音色下拉（voiceURI 来自 speechSynthesis.getVoices()）
```

## 4. 判据（新增 6 条，mock speechSynthesis）

```
① 开启朗读：回复完成后 speak 被调用一次，且参数文本 == 气泡文本（不截断）
② 文字仍显示：气泡节点文本非空（朗读不替换文字）
③ 关闭朗读 ⇒ speak 从未被调用
④ 新消息/关闭气泡 ⇒ 先 cancel 再继续（断言 cancel 被调用）
⑤ 无 speechSynthesis（模拟 undefined）⇒ 不抛错、文字照常显示
⑥ 无中文音色 ⇒ 只提示一次（第二次不再提示）
```

## 5. 门禁

```
build-client 0 / run-audit 0 失败 / verify-pet-chat 全绿（含上面 6 条）/ run-guards 全程
commit + push origin main + H1==H2
```

## 6. 不做

```
✗ 云端 TTS（要 key、要花钱）
✗ 语音克隆 / 自定义音色包
✗ 朗读时做口型同步（后续再说）
```
