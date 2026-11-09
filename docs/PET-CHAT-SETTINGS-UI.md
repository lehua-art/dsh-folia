# 桌宠对话：设置面板必须放进「桌宠」页签（用户可见）

> 反馈：用户在插件设置里**找不到"桌宠"配置**，也没有"桌宠对话"一节 ⇒ 无法填 key、开不了功能。
> 现状：`lib/settings-schema.js` 有 `petChat` 默认值与 sanitize（后端齐全），
> 但**客户端没有渲染任何配置控件**；气泡虽能弹（features.js → mountPetChat），没有 key 就用不了。
> 铁律：不发 npm（主机器发）、不动 latest、不改公开字段；每项独立 commit + push + 门禁全绿。

---

## 目标（用户视角）

```
插件面板 → 「桌宠」页签 → 底部新增一块「桌宠对话」：

  [x] 开启对话（点宠物就能聊天）
  模型来源：[OpenAI 兼容 ▾]（另一项：本机 Ollama）
  接口地址：[https://api.deepseek.com          ]
  模型名：  [deepseek-chat                     ]
  API Key： [••••••••••••••••••  ] [显示] [测试连接]
  人设：    名字[Folia] 性格[元气、短句…] 备注[喜欢壁纸和游戏]
  上下文轮数：[8]   单条字数上限：[80]

  [x] 朗读回答   音色[Microsoft Yaoyao ▾]  语速[1.0]  音量[1.0]  [试听]
  朗读引擎：[系统语音 ▾]（可选：在线情感 edge-tts，需联网）
  [x] 长期记忆（本机保存）  [查看记忆] [清空记忆]
  [ ] 主动闲聊（每日上限 10 条、间隔 2 小时、22:00-08:00 静默）
  [ ] 语音输入（需先在 DSH 开启"语音输入"）

  状态行：已连接 · openai · deepseek-chat   或   未配置 / 连不上（原因）
  [保存]
```

---

## 实现要求

```
1) 位置：桌宠页签（pets 面板）底部，紧跟"显示桌宠/声音/音量/复位位置/大小"那一组之后；
   不要放进全局"设置"页（用户找不到）
2) 数据：读写 settings.petChat（后端已有 sanitize；apiKey 只在本机、输入框默认掩码）
3) 交互：
   · 保存后立刻刷新状态行（调 GET /folia/pet-chat/state）
   · 「测试连接」按钮：调 state + models，失败把 lastError 原文显示在状态行（401/超时/baseUrl 错）
   · 「试听」：用当前音色念一句样例
   · 「查看记忆」：GET /folia/pet-chat/memory 弹出只读摘要 + 清空按钮
   · 「清空记忆」：POST /folia/pet-chat/reset 后提示
   · 开关"开启对话"时若 key 为空且 provider=openai：状态行提示"请先填入 API Key"
4) 判据（新增 6 条）：
   ① 页签渲染出「桌宠对话」区块（含 8 个控件 id）
   ② 填 key + 保存 ⇒ 调 state 且状态行显示已连接
   ③ provider 切 ollama ⇒ 接口地址自动变 http://127.0.0.1:11434、key 输入框禁用
   ④ 测试连接失败 ⇒ 状态行显示具体原因（不是"未知错误"）
   ⑤ 查看记忆 ⇒ 展示 nickname/likes/notes；清空后再次查看为空
   ⑥ 关闭对话 ⇒ 点宠物不再弹气泡（或只回预设台词）
5) 门禁：build-client 0 / run-audit 0 失败 / verify-pet-chat 全绿 / run-guards 全程
```

---

## 顺带修（同批）

```
· 现有 bubbles 入口：未配置时点宠物应给出"先去桌宠页签配置"的可读提示，而不是静默无反应
· 设置保存后不需要重启 DSH 即可生效（读的是同一份 settings）
```

## 汇报

```
commit：<hash>
文件：<客户端文件 + i18n>
判据：+6（贴输出）
门禁：build/audit/verify-pet-chat 结果
截图：桌宠页签里的「桌宠对话」区块
```
