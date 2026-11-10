# 桌宠 v0.2 工单：多引擎情感朗读 + 会话内执行

> 决策（2026-11-10）：音色按"可插拔引擎"做三档（Azure / 火山 / 声音克隆，用户自选）；
> 额外只做一个扩展能力：**在 DSH 会话里替用户发指令/执行任务**（不做生图、不做 QQ/微信）。
> 前置：v0.1（头顶气泡 + 语音主链路 + 名字/记忆）已验收。
> 铁律：不发 npm（主机器发）、不改公开字段、每步 commit + 门禁全绿。

---

## 一、A 部分：多引擎 TTS（用户自选）

### A1 统一抽象（先做这一层，后面接谁都快）

```ts
export const TTS_ENGINES = ['system', 'azure', 'volcano'] as const;

interface TtsEngine {
  id: 'system' | 'azure' | 'volcano';
  needsKey: boolean;
  listVoices(cfg): Promise<{ id, name, lang, gender, styles?: string[] }[]>;
  synth(cfg, { text, voiceId, emotion, speed, pitch }): Promise<{ audio: Uint8Array, mime, style }>;
  cloneVoice?(cfg, { samples, name }): Promise<{ voiceId }>;
  deleteVoice?(cfg, voiceId): Promise<void>;
}
```

```
宿主路由（统一入口，客户端只认这三条）：
  GET  /folia/tts/engines            → [{id, configured, needsKey, supportsClone}]
  GET  /folia/tts/voices?engine=     → 该引擎音色列表
  POST /folia/tts/speak              → { engine, voiceId, text, emotion, speed }
  POST /folia/tts/clone              → { engine:'volcano', samples(base64 wav), name }
  DELETE /folia/tts/voices/:id       → 删除克隆音色
```

### A2 回落链（必须实现）

```
用户选的引擎 → 其它已配置引擎（azure→volcano→…）→ 系统音色 → 只显示文字
每一跳记一次日志（当日去重），UI 状态行提示，不弹窗
```

### A3 各引擎实现

| 引擎 | 要点 | 判据 |
|---|---|---|
| **system** | 已有（speechSynthesis），作为兜底 | 关闭所有云引擎仍能出声 |
| **azure** | REST：`https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`，SSML 带 `mstts:express-as style`；配置 key+region；音色列表可内置常用 8 个（Xiaoxiao/Xiaoyi/Yunxi/Yunyang/Yunjian/Yunxia/Yunze + 1 英文） | ① 填 key 后能出声 ② style 随 emotion 变（断言 SSML 内容）③ 401 提示检查 key/region ④ 失败回落 |
| **volcano** | AppID + AccessToken 签名，WebSocket 双向流或 HTTP 一次性；返回 mp3/aac 需解码；音色列表（温柔桃子/磁性俊宇/阳光甜妹/知性小棠…按官方 id） | ① 签名正确 ② 能出声 ③ 情感参数生效 ④ 超时/断开回落 ⑤ 按量提示 |

### A4 设置与成本可见

```
朗读引擎：[自动 ▾] / Azure / 火山 / 系统
每家：key（掩码）、region/appid、音色下拉、[试听]、状态（可用/未配置/失败原因）
成本估算：本地按字符数 × 估价显示"本月约 X 字 / 约 ¥Y"，标注"以厂商后台为准"
情绪：自动（按对话 emotion）/ 固定某风格
```

### A5 声音克隆（仅火山）

```
流程：录 10 秒固定文本（16k wav）→ POST /folia/tts/clone → 存 voiceId 到设置
前置：勾选"我确认这是本人声音或已获授权"，明文提示克隆他人声音的法律风险
管理：试听 / 删除（调厂商删除 + 本地删）/ 每人 ≤2 个
判据：① 克隆成功后可选中并出声 ② 未勾选授权不允许提交 ③ 删除后列表消失且本地无残留
```

---

## 二、B 部分：会话内执行（替用户在 DSH 里发指令）

### B1 现状调研结论（已查 DSH 源码）

```
· 宿主侧没有"发送消息到会话"的 HTTP API（只有 /api/file、/api/session.export 等）
· 客户端有 InputTriggerService（dsh-client-ui-input-trigger），
  通过 `slash/input-insert-text` 事件可以把文本插入输入框
· "自动发送"（submit）没有公开接口，需要额外验证（风险：DSH 升级可能失效）
```

### B2 因此分两级，先做低风险那级

```
L1（必做，低风险）：把指令**插入输入框，不自动发送**
   桌宠听到"帮我整理一下今天的壁纸清单" →
   · 气泡显示"我帮你写到输入框了，按回车发送"
   · 文本插入 DSH 输入框，光标定位末尾
   · 用户确认后自己回车

L2（可选，需验证后再开）：自动发送
   · 设置项"允许桌宠直接发送指令"（默认关）
   · 通过 InputTriggerService 的 submit 路径；失败则退回 L1
   · 判据：插入文本 == 意图文本；关闭时不自动发送
```

### B3 意图识别（怎么判断"这句话是要执行任务"）

```
不做复杂分类：在 system prompt 里给桌宠一条规则 ——
  「如果用户的话是"让你去做一件事"（帮我、去、打开、整理、查、生成…），
    回答第一行用固定前缀：ACTION: <要执行的指令原文>」
宿主解析到 ACTION: 前缀 ⇒ 执行(L1/L2)；其余按普通聊天回答
判据：① 普通聊天不触发插入 ② "帮我…"触发插入且文本一致 ③ 前缀不出现在气泡里
```

---

## 三、步骤（当天可交付的拆法）

```
S1（0.5 天）引擎抽象 + 三条路由 + system 适配器 + 回落链 + 判据 4 条
S2（0.5 天）Azure 适配器（key/region/音色/SSML style/试听）+ 判据 4 条
S3（1 天）火山适配器（签名、音色列表、情感、超时回落）+ 判据 5 条
S4（0.5 天）设置页：引擎选择、key、音色、试听、成本估算、状态行 + 判据 3 条
S5（1 天）火山声音克隆（录制→上传→voiceId→试听/删除+合规勾选）+ 判据 3 条
S6（0.5 天）会话内执行 L1（ACTION 前缀 + 插入输入框）+ 判据 3 条
S7（0.5 天，可选）L2 自动发送（默认关，验证通过才开）
```

## 四、代码质量要求

```
· 每个引擎一个文件（lib/tts/azure.js / volcano.js / system.js），互不 import
· 引擎注册表单一真源（lib/tts/index.js），客户端只调统一路由
· 不复制粘贴 HTTP 客户端：抽一个带超时/重试（最多 1 次）/错误归一的 fetch 包装
· 密钥只存本机设置；日志里出现 key 即判失败（静态扫描）
· 新增判据进 run-audit；旧的 edge-tts 代码删除（不可用）
```

## 五、汇报

```
每步：commit / 引擎状态 / 判据数 / 门禁结果 / 真实出声证据（本地生成的 mp3 路径）
```
