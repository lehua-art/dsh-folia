# Folia 4.26.0-pre.68 · 音色系统 v2 + 权限重做（A 机器交付）

## 提交

- 基线：`75f9cfbedab003c96e050a12916d02af721cd05a`（GitHub `main`，4.26.0-pre.68）
- 分支：`feat/machine-a-voice-perm`
- 提交：
  - `c20a188` chore(baseline): 构建产物出库 + 清理不可读 gitlink（pre.68 环境修复）
  - `98a92b2` feat(voice+permission): 音色中心 v2 / 内置包 / 火山适配器 / 工具组三档权限 / 审计与确认流
  - `197a719` fix(voice): 高清包改 HF 逐文件下载（sha256/续传）+ 试听引擎对齐 + 守卫表/词表补齐
  - `027a60e` test(voice): 高清夹具补齐 lexicon（sherpa 完整性判据）
  - `22a42e3` chore(static): 收紧 ESLint/tsc 基线（pre.68 基线已过期：457/363 文件）+ 清理新增 lint
- 版本保持 `4.26.0-pre.68`；**未 npm publish**。

## 包内容

```
folia-machine-a-voice-perm.bundle   增量 git bundle（要求基线 75f9cfb）
folia-machine-a-voice-perm.patch    备用 patch（git format-patch）
folia-machine-a-voice-perm-src.zip  完整源码（顶层目录 folia-4.26.0-pre.68-voiceperm/；含构建产物 lib/client.js；不含 node_modules/.git）
diff-stat.txt                       git diff --stat 75f9cfb..HEAD
commits.txt                         提交列表
audit.log                           run-audit 全量汇总
A-K-output.md                       A–K 验收输出 + 偏差说明
build.log                           build-client.mjs 输出
verify-voice-permission-v2.log      A–K 自动化判据（48 通过 / 0 失败）
D-real-download.log                 真实 169MB 高清包下载 + 进度 + 试听
D-real-preview.log                  三音色真实试听对比
```

SHA256（源码包）：见最终回复（zip 自引用会改变哈希，故不写死在包内）。

## 应用

在 pre.68（`75f9cfb`）仓库中：

```powershell
git fetch .\folia-machine-a-voice-perm.bundle feat/machine-a-voice-perm
git checkout -B feat/machine-a-voice-perm FETCH_HEAD
npm install --no-audit --no-fund
$env:ELECTRON_RUN_AS_NODE=1
node scripts\build-client.mjs
node test\run-audit.mjs
```

> `lib/client.js` 按仓库 `.gitignore` 的「构建产物出库」策略不再入库；应用 bundle 后会**删除**被误跟踪的那份，由 `scripts/build-client.mjs` 现场生成。

## 验收

- `node scripts/build-client.mjs`：exit 0（见 `build.log`）
- `node test/run-audit.mjs`：**124 通过 / 49 退役 / 0 失败 / 173**（见 `audit.log`；172 基线 + 1 个新增验收，另有 2 个旧退役用例转绿）
- `node test/verify-voice-permission-v2.mjs`：**48 通过 / 0 失败**（A–K，见 `verify-voice-permission-v2.log`）
- 真实高清包：`D-real-download.log`（169MB MeloTTS 下载进度 → 完成 → 试听）、`D-real-preview.log`（华言 / 高清女 / 高清男三种真实音频）

## 需要你知道的偏差（诚实说明）

1. **高清包不是 400MB/个**：女声用 MeloTTS（`vits-melo-tts-zh_en`，约 169MB），男声用 `vits-zh-hf-abyssinvoker` 的男声 speaker（约 120MB）。
   都能离线真出声、与华言明显不同；体积比任务单写的 400MB 小，是因为 400MB 级 MeloTTS/PyTorch 全套无法塞进 Node 插件，
   这里选的是 sherpa-onnx 可直接跑的 ONNX 导出（同一许可族，MIT/见模型页）。
2. **高清运行时是外部依赖**：`sherpa-onnx-node`（DSH 依赖树里已有；本机验证用它）。代码会探测；缺失时高清包仍能下载，
   但界面标「缺高清运行时」，试听自动回落内置音色（不假装出声）。未把 22MB 原生包写进 `dependencies`，避免改变发布面。
3. **pre.68 基线本身有两处环境问题**：`lib/client.js` 被误跟踪（与 `.gitignore` 的产物出库策略冲突）、
   `.recon-site-src` / `folia-admin` 是不可读的 gitlink。bundle 里第一笔提交把它们清掉；不这样 `verify-client-sync` / `verify-eol` 必红。
4. **静态基线已过期**：pre.68 的 `test/fixtures/static-baseline.json` 还停在 363 文件（实际 457），`verify-static` 在**改动前**就红。
   本次按仓库唯一写盘分支 `node test/verify-static.mjs --write-baseline` 收紧到 465 文件。
5. **`search_query`** 默认走 DuckDuckGo Instant Answer（无需 Key）；如果装了搜索插件，可在 `deps.search` 注入替换。
   `doc_read` 只读相对工作区路径、文本扩展名、≤256KB，拒绝绝对路径/`..`。

## 回传边界

只改了任务允许的模块：

```
lib/tts/*（tts-worker.cjs / tts.js / packs.js / voice-center.js）
lib/routes/pet-chat.js（voice/tts 段 + 工具确认流）· lib/routes/personas.js
lib/persona-store.js · lib/persona-tool-log.js（新增）· lib/pet-chat-brain.js · lib/pet-chat-tools.js
src/panel-tabs-personas.js · src/panel-tabs-assistant.js · src/i18n-copy-panel.js
src/pet-chat.js（仅 SSE 确认/轮播动作段）· test/*
```

未动：下载队列 / 卡片状态 / 卸载 / 缓存 / 预热 / 能力页 catalog / 语音 VAD / ffmpeg 供给。
