/**
 * tts/catalog.js — 可下载/可打包的**离线 TTS 音色目录**（pre.54，任务 C 的骨架）。
 *
 * 纪律（用户硬性要求）：
 *   · Edge neural（`zh-CN-XxxNeural` 这类）**是云端音色**，没有本地模型、许可不允许再分发
 *     ⇒ 不进目录、不进包、不进下拉；
 *   · 这里只列**开源、可离线、许可允许再分发**的方案；`available:false` 明示本版只接目录，
 *     合成尚未接通 —— 界面不得写成"已支持"；
 *   · 不提供假的下载地址：`homepage` 指向项目官方仓库，模型下载 URL 在接通后由实现补。
 *
 * 后续接 Piper/sherpa 时：把 `available` 改为 true、补 `downloadUrl`，并让 `/tts/voices`
 * 在模型落盘后返回 `engine:'piper'|'sherpa'` 的条目；前端只认 `usable:true`。
 */
export const TTS_CATALOG = Object.freeze([
  {
    id: 'piper-zh',
    name: 'Piper 中文音色',
    engine: 'piper',
    license: 'MIT',
    size: '约 60–70 MB / 音色',
    homepage: 'https://github.com/rhasspy/piper',
    available: false,
    status: 'coming-soon',
    note: '离线开源；本版只接目录，合成尚未接通（会在接通后标为可用）',
  },
  {
    id: 'sherpa-onnx-zh',
    name: 'sherpa-onnx 中文 TTS',
    engine: 'sherpa',
    license: 'Apache-2.0',
    size: '约 40–100 MB / 模型',
    homepage: 'https://github.com/k2-fsa/sherpa-onnx',
    available: false,
    status: 'coming-soon',
    note: '离线开源；本版只接目录，合成尚未接通',
  },
  {
    id: 'melo-zh',
    name: 'MeloTTS 中文',
    engine: 'melo',
    license: 'MIT',
    size: '约 300–500 MB',
    homepage: 'https://github.com/myshell-ai/MeloTTS',
    available: false,
    status: 'coming-soon',
    note: '体积较大，计划首次使用时下载；本版只接目录',
  },
]);
