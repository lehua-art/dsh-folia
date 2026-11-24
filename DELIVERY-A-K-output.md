# 音色系统 v2 + 权限重做 · A–K 验收输出

- 分支：`feat/machine-a-voice-perm`（基于 `75f9cfb`，4.26.0-pre.68）
- 自动化判据：`test/verify-voice-permission-v2.mjs` → **48 通过 / 0 失败**
- 全量回归：`node test/run-audit.mjs` → **124 通过 / 49 退役 / 0 失败 / 173**（`audit.log`）
- 构建：`node scripts/build-client.mjs` → exit 0（`build.log`）

| 组 | 判据 | 结果 | 证据 |
|---|---|---|---|
| A | 15 个 Edge 中文名，不再 `undefined`；429 标注“暂不可用/限流” | PASS | A1/A2 |
| B | 声音页=`◉继承/○指定` + 卡片选择器（非下拉）+ 每卡 ▶ 试听 | PASS | B1/B2/B3 |
| C | 新人设默认 `mode=inherit`；改指定音色不影响全局 preferred | PASS | C1/C2 |
| D | 高清包：下载进度→完成→试听明显不同于华言 | PASS（真实下载 + 真合成） | D1–D3 + `D-real-e2e.log` |
| E | 火山：未配置 / 401 / 403 / 429 / 超时 / 真调用 / 失败回落 | PASS | E1–E9 |
| F | 「如何获取」六步齐全（注册/开通/AppID+Token/资源ID/测试/计费） | PASS | F1 |
| G | 权限三档：壁纸 allow 直接做；媒体 ask 先问；语音“好”/气泡按钮；拒绝不执行 | PASS | G1–G8 |
| G+ | 新工具：`media_control/status_query/doc_read/search_query/wallpaper_cycle` | PASS | G9–G13 |
| H | 特殊人设：代码层拒绝 + 权限页“不能使用系统工具” + 写权限 403 | PASS | H1–H4 |
| I | 每次调用落 `tool-log.jsonl`（permission/confirmed/verified/result） | PASS | I1–I3 |
| J | 高级权限关闭时 system 不可见/不可用；打开后仍二次确认 | PASS | J1–J5 |
| K | `run-audit` 0 失败 | PASS | `audit.log` |

---

## A. 声音页目录（15 个 Edge 中文名 / 429）

```text
✓ A1 15 个 Edge 音色都有中文 label，不再出现 undefined — count=15 · 首条=晓晓
✓ A2 429 音色保留并标注“暂不可用/限流” — 云健 · 在线音色被限流（429），稍后自动恢复
✓ A3 内置音色包在目录里（华言/高清）且带状态 — items=6
```

## B. 卡片选择器 + 试听

```text
✓ B1 声音页用单选“继承/指定”+ 卡片（不是下拉） — radio + voiceCard
✓ B2 每个音色有 ▶ 试听与 /voice/preview 通道 — preview button + endpoint
✓ B3 选 piper 华言 → 试听回 audio/wav（>10KB） — status=200 bytes=12000
```

## C. 继承 / 指定

```text
✓ C1 新建助手 express.voice.mode=inherit — mode=inherit
✓ C2 改成指定音色后，全局默认不变 — preferred=piper:zh_CN-huayan-medium · voice=piper:zh_CN-huayan-x_low
```

## D. 内置音色包（真实下载 + 真合成）

自动化判据（本地夹具，不下载 169MB）：

```text
✓ D1 安装开始 → 进度轮询 → 完成（installed=true） — started=true · phase=ready
✓ D2 高清试听与华言是不同音频（sherpa 引擎、字节数不同） — huayan=12000 · hd=32000
✓ D3 删除包后 installed=false，运行时不受影响
```

真实端到端（hf-mirror 逐文件下载，sha256 校验；`D-real-e2e.log`）：

```text
install started: true
progress: 0% → 20% → 31% → 41% → 51% → 61% → 72% → 82% → 92% → 100%
installed: true
preview: melo:zh_female status=200 mime=audio/wav bytes=288798 engine=sherpa fallback=0

preview: piper:zh_CN-huayan-medium status=200 mime=audio/wav bytes=195860 engine=piper fallback=0
preview: melo:zh_female          status=200 mime=audio/wav bytes=271170 engine=sherpa fallback=0
preview: melo:zh_male            status=200 mime=audio/wav bytes=277604 engine=sherpa fallback=0
```

> 高清女 = MeloTTS `vits-melo-tts-zh_en`（≈169MB）；高清男 = `vits-zh-hf-abyssinvoker` 男声 speaker（≈120MB）。
> 体积小于任务单的 400MB，是模型选型（sherpa-onnx 可直跑的 ONNX 导出）差异，非占位包。

## E. 火山引擎

```text
✓ E1 不填 Key ⇒ volc-no-key（可读）
✓ E2 401 ⇒ volc-unauthorized · 火山鉴权失败（401）…
✓ E2 403 ⇒ volc-forbidden · 请确认已开通「语音合成」/「大模型语音」服务…
✓ E2 429 ⇒ volc-rate-limited · 火山限流或额度不足（429）
✓ E3 传统 TTS 真调用 ⇒ ok + subtype=volc-tts + mp3 — bytes=12000
✓ E4 Seed-TTS 真调用 ⇒ ok + subtype=volc-seed-tts — bytes=12000
✓ E5 超时 ⇒ volc-timeout（不静默）
✓ E6 火山失败自动回落到 Edge（attempts 带 volc 原因）
✓ E7 未配置时 /voice/providers 显示 unconfigured
✓ E8 保存后只回掩码（不含 token 原文）
✓ E9 「测试」按钮真调一次（假 TTS 返回 volc 引擎）
```

## F. 「如何获取」六步

```text
✓ F1 六步齐全：注册/开通/AppID+Token/ResourceID/测试/计费 — 6 步
   注册并实名火山引擎账号 / 开通「语音合成」或「大模型语音」服务 /
   创建应用，拿 AppID 与 Access Token / 确认 Cluster / Resource ID /
   回来粘贴 → 点「测试」 / 计费说明（按量，先充值/领额度）
```

## G. 权限三档 + 确认流

```text
✓ G1 壁纸 allow ⇒ 直接执行并经回读确认 — verified=true
✓ G2 媒体 ask ⇒ 先问，不执行 — confirm=true，无 action
✓ G3 语音说「好」⇒ 执行（confirmed 落审计）
✓ G4 媒体 deny ⇒ 明确拒绝，不弹确认、不执行
✓ G5 气泡「不允许」⇒ 不执行（无 clientAction）
✓ G6 气泡「允许」⇒ 执行，客户端动作回传（wallpaper_switch）
✓ G7 「以后都允许」写 consentMemory + 把组改成 allow
✓ G8 「以后都别问」把组改成 deny
✓ G9 五个新工具都进了（按权限过滤后的）工具表
✓ G10 wallpaper_cycle 真执行并经回读确认（轮播打开） — verified=true
✓ G11 status_query 返回壁纸/音色/音量/播放状态
✓ G12 doc_read 经「允许」后只读工作区文件（不写不删） — README.md
✓ G13 search_query 默认 ask：先问；拒绝后不发网络请求
```

## H. 特殊人设

```text
✓ H1 特殊人设权限页：不能使用系统工具，所有组 deny
✓ H2 特殊人设工具表为空（代码层）
✓ H3 特殊人设请求工具 ⇒ 明确拒绝（toolRefused=true）
✓ H4 特殊人设写权限 ⇒ 403 character-no-tools（不信 UI）
```

## I. 审计

```text
✓ I1 每次调用落 tool-log.jsonl（含 permission/confirmed/verified） — 18 行
✓ I2 ask 确认后的记录 confirmed=true；deny 的记录 permission=deny
✓ I3 清空后 0 条
```

示例（`~/.dsh-folia/personas/<id>/tool-log.jsonl`）：

```json
{"ts":1795508158110,"tool":"doc_read","args":{"path":"README.md"},"permission":"ask","confirmed":true,"result":"ok","verified":true,"source":"chat","error":""}
```

## J. 高级权限

```text
✓ J1 高级权限关闭时，system 不允许设为 allow（409 advanced-required）
✓ J2 高级权限关闭时，系统工具不在工具表里
✓ J3 打开高级权限后可设为 allow；但高危仍需二次确认
✓ J4 即使 allow，system 动作仍先问确认
✓ J5 关闭高级权限后 system 立即不可用
```

## K. 全量回归

`node test/run-audit.mjs` → **124 通过 / 49 退役 / 0 失败 / 173**（见 `audit.log`）。同时：

```text
verify-persona-ui.mjs       24 通过 / 0 失败
verify-personas.mjs         25 通过 / 0 失败
verify-voice-tts.mjs        37 通过 / 0 失败
voice-pre57-route-check.mjs 10 通过 / 0 失败
voice-setup-check.mjs       35 通过 / 0 失败
verify-pet-chat.mjs         24 通过 / 0 失败
verify-pet-chat-brain.mjs   28 通过 / 0 失败（G 组已按新权限模型加严）
```

## 偏差与备注

1. 高清包体积 169MB / 120MB，不是 400MB（模型选型见 README）。
2. 高清运行时 `sherpa-onnx-node` 为可选探测；缺失时高清包可下载但试听回落内置音色（UI 标注“缺高清运行时”）。
3. pre.68 基线本身有 `lib/client.js` 误入库与两个不可读 gitlink；第一笔提交清理，否则 K 无法 0 失败。
4. 静态基线原已过期（363 → 实测 457 文件），按 `--write-baseline` 收紧到 465。
