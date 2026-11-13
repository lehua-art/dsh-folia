/**
 * tts-worker.cjs — 桌宠朗读的**真实合成**子进程（P1：SAPI 优先，系统语音兜底）。
 *
 * 为什么独立进程（沿用 v0.2 的结论，不重写现有语音栈）：
 *   · 合成要调用 Windows 的 PowerShell / .NET，**不能**占住 Electron 主进程的事件循环；
 *   · 以后若换回 sherpa-onnx 本地模型，native 扩展在 Electron 里也会抛
 *     `External buffers are not allowed` —— 子进程边界是同一个保险。
 *
 * 合成链（每次请求都按顺序试，失败自动退下一条，**不静默**）：
 *   ① `sapi`：System.Speech（SAPI5 桌面音色，离线、零模型）
 *   ② `edge`：Windows.Media.SpeechSynthesis（WinRT / OneCore 音色，即 Edge「大声朗读」
 *      用的那套系统音色，离线、零模型）
 *   ③ 全失败 ⇒ `{ok:false, code:'tts-unavailable'}`，把每一跳的原因都带回去
 *
 * PowerShell 的姿势（踩过的坑）：
 *   · **stdin/stdout/stderr 一律不走管道**（Electron 里 piped stdio 会 EPERM）：
 *     请求配置写 UTF-8 JSON 文件，stderr 重定向到临时文件，进程结束后再读；
 *   · 中文文本从不进命令行参数（避免 Windows PowerShell 的引号/编码地雷），只经 JSON 文件；
 *   · 脚本本身是 ASCII，`-File` + `-NoProfile -NonInteractive -ExecutionPolicy Bypass`。
 *
 * 协议（NDJSON，stdout 只写协议，日志走 stderr）：
 *   就绪：{ "ready": true, "platform": "win32", "engines": ["sapi","edge"] }
 *   请求：{ "id": "1", "text": "要念的话", "voice": "Microsoft Huihui Desktop", "rate": 0 }
 *   成功：{ "id": "1", "ok": true, "file": "C:\\…\\1.wav", "engine": "sapi",
 *           "voice": "Microsoft Huihui Desktop", "bytes": 87314, "ms": 412, "attempts": [] }
 *   失败：{ "id": "1", "ok": false, "code": "tts-unavailable", "error": "…",
 *           "attempts": [{ "engine": "sapi", "error": "…" }, …] }
 *
 * 一次性模式（判据/排障用；真跑一次合成并落文件）：
 *   node tts-worker.cjs --once --req <req.json> --out <out.wav>
 *   成功 exit 0 并打印结果 JSON；失败 exit 1 并打印原因 JSON。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

/** 合成链的顺序（单一真源；服务端缓存/判据都读它）。 */
const ENGINES = Object.freeze(['sapi', 'edge']);

/**
 * Edge / WinRT 的音色命名（例：`zh-CN-XiaoxiaoNeural`）。
 * 这种名字**只存在于 Edge/OneCore 目录**，SAPI 一定没有 ⇒ 必须把 edge 排到第一跳，
 * 否则 SAPI 找不到时会回落到 Huihui 并"成功"，用户的音色设置永远不生效。
 */
const NEURAL_VOICE_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;

function isNeuralVoice(voice) {
  return NEURAL_VOICE_RE.test(String(voice == null ? '' : voice).trim());
}

/**
 * 按用户指定的音色决定引擎顺序：
 *   · 空 / SAPI 风格名（`Microsoft Xxx Desktop` …）⇒ 默认 `['sapi','edge']`
 *   · Edge 风格 neural 名 ⇒ `['edge','sapi']`
 * `engines` 参数只是"允许的子集"（判据/强制单引擎用），不会把顺序倒回去；
 * 指定音色在某个引擎里不存在时由脚本 `throw voice-not-found`，**不许**静默用默认音色成功。
 */
function engineOrderForVoice(voice, engines) {
  const base = (Array.isArray(engines) && engines.length ? engines : ENGINES)
    .filter((engine) => engine === 'sapi' || engine === 'edge');
  const list = base.length ? base : ENGINES.slice();
  if (!isNeuralVoice(voice)) return list;
  return [...list].sort((a, b) => (a === 'edge' ? 0 : 1) - (b === 'edge' ? 0 : 1));
}

/** 单句字数上限（与路由一致；多出来的截掉而不是报错）。 */
const MAX_TEXT_CHARS = 240;

/** 每条引擎的超时（PowerShell 起进程约 0.4s，正常合成 < 1s；12s 足够慢机器）。 */
const ENGINE_TIMEOUT_MS = 12000;

/** PowerShell 绝对路径（PATH 不可靠时也能起）。 */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fs.existsSync(abs)) return abs;
  } catch { /* ignore */ }
  return 'powershell.exe';
}

/** 写 UTF-8 JSON（带 BOM：Windows PowerShell 5.1 对无 BOM 的 UTF-8 识别不稳）。 */
function writeJson(file, doc) {
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(doc), 'utf8');
}

/** 文档里的“有效 WAV”判据：RIFF/WAVE 头 + 至少 1KB（空文件/半截头一律算失败）。 */
function validateWav(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (stat.size < 1024) return { ok: false, error: 'wav-too-small', bytes: stat.size };
    const head = Buffer.alloc(12);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, error: 'not-a-wav', bytes: stat.size };
    }
    return { ok: true, bytes: stat.size };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * PowerShell 的 stderr → 一条人能读的原因。
 *
 * `throw 'voice-not-found: <name>'` 在 Windows PowerShell 5.1 里会把
 * “CategoryInfo / FullyQualifiedErrorId / 抛出的源码行”整段打出来；原样塞进 attempts
 * 会是一屏 `+ [string]$cfg.voice) }`。这里只取 `FullyQualifiedErrorId` 那一行
 * （最干净、包含音色名），否则取 CategoryInfo 的括号内容，再否则取最后一行。
 */
function cleanEngineError(stderr) {
  const text = String(stderr || '');
  const fq = /FullyQualifiedErrorId\s*:\s*([^\r\n]+)/i.exec(text);
  if (fq && /voice-not-found/i.test(fq[1])) return fq[1].trim();
  const vn = /voice-not-found:\s*([A-Za-z0-9 ._-]+)/i.exec(text);
  if (vn) return 'voice-not-found: ' + vn[1].trim();
  const cat = /CategoryInfo\s*:\s*[^:]+:\s*\(([^)]*)\)/.exec(text);
  if (cat) return cat[1].trim().slice(0, 200);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] || 'synthesis-failed').slice(0, 200);
}

/* ── PowerShell 脚本（ASCII；中文只经 JSON 文件）────────────────────────────── */

/** SAPI：System.Speech 的桌面音色。 */
const SAPI_SCRIPT = `
param([string]$Req, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$cfg = Get-Content -Raw -Encoding UTF8 $Req | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $picked = ''
  # An explicit voice MUST exist in this engine's catalog. Do not silently fall
  # back to the system default: the caller reports this attempt as failed and
  # tries the next engine (the voice may belong to the Edge/OneCore catalog).
  # stdout prints 'OK <name>' so callers report the REAL voice.
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  if ($cfg.voice) {
    $match = $voices | Where-Object { $_.Name -eq [string]$cfg.voice } | Select-Object -First 1
    if (-not $match) { throw ('voice-not-found: ' + [string]$cfg.voice) }
    $synth.SelectVoice($match.Name)
    $picked = $match.Name
  } else {
    $match = $voices | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
    if (-not $match) { $match = $voices | Where-Object { $_.Culture.Name -like 'zh*' } | Select-Object -First 1 }
    if (-not $match) { $match = $voices | Select-Object -First 1 }
    if ($match) { $synth.SelectVoice($match.Name); $picked = $match.Name }
  }
  $rate = 0
  if ($null -ne $cfg.rate) { $rate = [int][math]::Max(-10, [math]::Min(10, [double]$cfg.rate)) }
  $synth.Rate = $rate
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($Out)
  $synth.Speak([string]$cfg.text)
  $synth.SetOutputToNull()
  [Console]::Out.WriteLine('OK ' + $picked)
} finally {
  $synth.Dispose()
}
`;

/**
 * Edge / OneCore：WinRT SpeechSynthesizer（Edge 浏览器「大声朗读」用的同一批系统音色）。
 *
 * 用 SSML 的 `<prosody rate="%">` 承载语速（WinRT 没有 SAPI 那种 Rate 属性）；
 * 文本先做 XML 转义。异步 API 经 `AsTask()` 同步等待（Windows PowerShell 5.1 的老办法）。
 */
const EDGE_SCRIPT = `
param([string]$Req, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$cfg = Get-Content -Raw -Encoding UTF8 $Req | ConvertFrom-Json
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
try {
  $picked = ''
  # Same rule as SAPI: an explicit voice must exist in this engine's catalog;
  # otherwise fail this attempt (the caller falls through to the next engine).
  $voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  if ($cfg.voice) {
    $match = $voices | Where-Object { $_.DisplayName -eq [string]$cfg.voice -or $_.Id -eq [string]$cfg.voice } | Select-Object -First 1
    if (-not $match) { throw ('voice-not-found: ' + [string]$cfg.voice) }
    $synth.Voice = $match
    $picked = $match.DisplayName
  } else {
    $match = $voices | Where-Object { $_.Language -like 'zh*' } | Select-Object -First 1
    if (-not $match) { $match = $voices | Select-Object -First 1 }
    if ($match) { $synth.Voice = $match; $picked = $match.DisplayName }
  }
  $rate = 0
  if ($null -ne $cfg.rate) { $rate = [int][math]::Max(-10, [math]::Min(10, [double]$cfg.rate)) }
  $pct = [int][math]::Max(50, [math]::Min(200, 100 + $rate * 10))
  $text = [System.Security.SecurityElement]::Escape([string]$cfg.text)
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><prosody rate='$pct%'>$text</prosody></speak>"
  $stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $file = [System.IO.File]::Create($Out)
  try { $netStream.CopyTo($file) } finally { $file.Close(); $netStream.Close() }
  [Console]::Out.WriteLine('OK ' + $picked)
} finally {
  $synth.Dispose()
}
`;

/** 把一段脚本写到临时目录（一次进程一份，避免并发互相覆盖）。 */
function writeScript(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'ascii');
  return file;
}

/**
 * 跑一次 PowerShell（stdio 全走文件；超时强杀）。
 * @returns {Promise<{ ok: boolean, code: number|null, voice: string, stderr: string }>}
 */
function runPowerShellScript(scriptFile, reqFile, outFile, timeoutMs) {
  return new Promise((resolve) => {
    const errFile = outFile + '.ps.log';
    const voiceFile = outFile + '.ps.out';
    let fd = null;
    let outFd = null;
    try { fd = fs.openSync(errFile, 'w'); } catch { fd = null; }
    try { outFd = fs.openSync(voiceFile, 'w'); } catch { outFd = null; }
    const cleanupFiles = () => {
      try { if (fd !== null) fs.closeSync(fd); } catch { /* ignore */ }
      try { if (outFd !== null) fs.closeSync(outFd); } catch { /* ignore */ }
      try { fs.unlinkSync(errFile); } catch { /* ignore */ }
      try { fs.unlinkSync(voiceFile); } catch { /* ignore */ }
    };
    let child;
    try {
      child = spawn(powershellPath(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptFile, reqFile, outFile,
      ], {
        windowsHide: true,
        // stdout 也走文件（**不 pipe**）：脚本最后一行 `OK <实际音色>` 就是真实音色。
        stdio: ['ignore', outFd === null ? 'ignore' : outFd, fd === null ? 'ignore' : fd],
      });
    } catch (error) {
      cleanupFiles();
      resolve({ ok: false, code: -1, voice: '', stderr: String((error && error.message) || error) });
      return;
    }
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let stderr = '';
      let stdout = '';
      try { stderr = fs.readFileSync(errFile, 'utf8'); } catch { /* ignore */ }
      try { stdout = fs.readFileSync(voiceFile, 'utf8'); } catch { /* ignore */ }
      cleanupFiles();
      const picked = /^OK\s+(.+)$/m.exec(stdout);
      resolve({
        ok: code === 0,
        code,
        voice: picked ? String(picked[1]).trim().slice(0, 120) : '',
        stderr: stderr.slice(-1600),
      });
    };
    const timer = setTimeout(() => {
      try { if (child && child.pid) child.kill(); } catch { /* ignore */ }
      setTimeout(() => finish(null), 300);
    }, timeoutMs);
    child.on('error', (error) => {
      try { if (child && child.pid) child.kill(); } catch { /* ignore */ }
      finish(null);
      void error;
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * 引擎一跳：准备请求 JSON → 跑 PowerShell → 校验 WAV。
 * voice 归一化：没显式匹配到就按引擎的“实际默认音色”写回，便于客户端提示。
 */
async function runEngine(engine, text, options, deps) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'windows-only', attempts: [] };
  }
  const dir = deps.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-tts-'));
  // 同一句重复请求也不许互相覆盖：文件名带随机后缀（worker 串行，但一次性模式可能并发）。
  const stamp = crypto.createHash('sha1').update(engine + ':' + text + ':' + (options.voice || '')).digest('hex').slice(0, 10)
    + '-' + crypto.randomBytes(4).toString('hex');
  const reqFile = path.join(dir, engine + '-' + stamp + '.json');
  const outFile = path.join(dir, engine + '-' + stamp + '.wav');
  const scriptFile = writeScript(dir, engine + '-' + stamp + '.ps1', engine === 'sapi' ? SAPI_SCRIPT : EDGE_SCRIPT);
  writeJson(reqFile, {
    text: String(text || '').slice(0, MAX_TEXT_CHARS),
    voice: String(options.voice || '').slice(0, 120),
    rate: Number.isFinite(options.rate) ? Number(options.rate) : 0,
  });
  const started = Date.now();
  const result = await runPowerShellScript(scriptFile, reqFile, outFile, deps.timeoutMs || ENGINE_TIMEOUT_MS);
  // 请求配置与脚本都是一次性的：落盘只为绕开命令行编码/管道，进程结束后立刻删
  for (const file of [reqFile, scriptFile]) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  const wav = result.ok ? validateWav(outFile) : { ok: false, error: 'powershell-exit-' + result.code };
  if (!wav.ok) {
    const reason = result.ok ? (wav.error || 'synthesis-failed') : cleanEngineError(result.stderr);
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
    return {
      ok: false,
      error: String(reason || 'synthesis-failed').slice(0, 300),
      engine,
      ms: Date.now() - started,
    };
  }
  return {
    ok: true,
    engine,
    file: outFile,
    bytes: wav.bytes,
    // 脚本 stdout 的 `OK <name>` 是**实际选中的音色**（SAPI 与 Edge 目录不同，
    // 请求名可能只属于另一套）；拿不到才退回请求名。
    voice: String(result.voice || options.voice || ''),
    ms: Date.now() - started,
    dir,
  };
}

/** SAPI 一跳（导出给判据注入假实现）。 */
function runSapiEngine(text, options, deps) {
  return runEngine('sapi', text, options || {}, deps || {});
}

/** Edge/OneCore 一跳（导出给判据注入假实现）。 */
function runEdgeEngine(text, options, deps) {
  return runEngine('edge', text, options || {}, deps || {});
}

/**
 * 合成链（**纯逻辑**，正判据与负对照共用）：
 * 按 `engines` 顺序逐跳尝试；第一个产出有效 WAV 的引擎胜出；
 * 全失败返回 `{ok:false, code:'tts-unavailable', attempts}`。
 *
 * @param {string} text
 * @param {{voice?: string, rate?: number, engines?: string[]}} options
 * @param {{runSapi?: Function, runEdge?: Function, timeoutMs?: number, dir?: string}} deps
 */
async function synthesizeOnce(text, options = {}, deps = {}) {
  const clean = String(text == null ? '' : text).trim().slice(0, MAX_TEXT_CHARS);
  if (!clean) return { ok: false, code: 'empty-text', error: 'empty-text', attempts: [] };
  const requestedVoice = String(options.voice == null ? '' : options.voice).trim();
  // 音色 → 引擎顺序：neural 名先走 edge；SAPI 名/空先走 sapi。显式音色在某一跳不存在时
  // 脚本会 `voice-not-found`，这里记一次 attempt 后继续下一跳，绝不当成“用默认音色成功”。
  const engines = engineOrderForVoice(requestedVoice, options.engines);
  const runSapi = typeof deps.runSapi === 'function' ? deps.runSapi : runSapiEngine;
  const runEdge = typeof deps.runEdge === 'function' ? deps.runEdge : runEdgeEngine;
  const attempts = [];
  for (const engine of engines) {
    let jumped;
    try {
      jumped = await (engine === 'sapi' ? runSapi : runEdge)(clean, options, deps);
    } catch (error) {
      jumped = { ok: false, error: String((error && error.message) || error) };
    }
    if (jumped && jumped.ok && jumped.file) {
      const valid = validateWav(jumped.file);
      if (valid.ok) {
        return {
          ok: true,
          engine,
          file: jumped.file,
          bytes: valid.bytes,
          voice: String(jumped.voice || requestedVoice || ''),
          requestedVoice,
          ms: Number(jumped.ms) || 0,
          attempts,
        };
      }
      attempts.push({ engine, error: valid.error || 'invalid-wav' });
    } else {
      attempts.push({ engine, error: String((jumped && (jumped.error || jumped.code)) || 'engine-failed').slice(0, 400) });
    }
  }
  return {
    ok: false,
    code: 'tts-unavailable',
    error: attempts.map((item) => item.engine + ': ' + item.error).join(' | '),
    attempts,
    requestedVoice,
    hint: requestedVoice
      ? '本机没有这个音色（已依次尝试 ' + engines.join(' → ') + '），换一个音色或把音色留空。'
      : '本机语音合成不可用：系统语音（SAPI）和 Edge 系统音色都没出声。',
  };
}

/* ── 模式 1：一次性（判据 / 排障）────────────────────────────────────────── */

async function runOnce(reqFile, outFile) {
  let req = {};
  try { req = JSON.parse(fs.readFileSync(reqFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 空请求由 synthesizeOnce 判 */ }
  const dir = path.dirname(outFile);
  const result = await synthesizeOnce(req.text, {
    voice: req.voice,
    rate: req.rate,
    engines: Array.isArray(req.engines) ? req.engines : undefined,
  }, { dir });
  if (result.ok && result.file !== outFile) {
    try {
      fs.renameSync(result.file, outFile);
    } catch {
      // 跨盘 / 被占用：复制后删源（失败也要把真实错误带出去，不能假装成功）
      try {
        fs.copyFileSync(result.file, outFile);
        fs.unlinkSync(result.file);
      } catch (error) {
        result.ok = false;
        result.code = 'output-move-failed';
        result.error = String((error && error.message) || error);
      }
    }
    if (result.ok) result.file = outFile;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

/* ── 模式 2：NDJSON 常驻 worker（宿主路由用）──────────────────────────────── */

function runWorker(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-tts-worker-'));
  process.stdout.write(JSON.stringify({
    ready: true,
    platform: process.platform,
    engines: ENGINES.slice(),
    powershell: powershellPath(),
  }) + '\n');

  const rl = readline.createInterface({ input: process.stdin });
  // 串行执行：PowerShell 是重进程，同一时刻只跑一条；请求方（lib/tts/tts.js）也会排队。
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const raw = String(line || '').trim();
    if (!raw) return;
    let req;
    try { req = JSON.parse(raw); } catch {
      process.stdout.write(JSON.stringify({ id: null, ok: false, code: 'bad-json', error: 'bad-json' }) + '\n');
      return;
    }
    const id = req.id === undefined ? null : req.id;
    chain = chain.then(async () => {
      const started = Date.now();
      let result;
      try {
        result = await synthesizeOnce(req.text, {
          voice: req.voice,
          rate: req.rate,
          engines: Array.isArray(req.engines) ? req.engines : undefined,
        }, { dir, timeoutMs: Number(req.timeoutMs) || ENGINE_TIMEOUT_MS });
      } catch (error) {
        result = { ok: false, code: 'worker-failed', error: String((error && error.message) || error) };
      }
      process.stdout.write(JSON.stringify({
        id,
        ok: result.ok === true,
        file: result.ok ? result.file : null,
        engine: result.ok ? result.engine : null,
        voice: result.ok ? result.voice : null,
        bytes: result.ok ? result.bytes : null,
        ms: Number(result.ms) || (Date.now() - started),
        attempts: result.attempts || [],
        code: result.ok ? null : (result.code || 'tts-unavailable'),
        error: result.ok ? null : (result.error || 'failed'),
        hint: result.ok ? null : (result.hint || ''),
      }) + '\n');
    }).catch((error) => {
      process.stdout.write(JSON.stringify({
        id, ok: false, code: 'worker-failed', error: String((error && error.message) || error),
      }) + '\n');
    });
  });
  rl.on('close', () => { process.exit(0); });
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

if (require.main === module) {
  if (process.argv.includes('--once')) {
    const reqFile = arg('req', '');
    const outFile = arg('out', '');
    if (!reqFile || !outFile) {
      process.stderr.write('[tts-worker] --once 需要 --req 与 --out\n');
      process.exit(2);
    }
    runOnce(reqFile, outFile).catch((error) => {
      process.stderr.write('[tts-worker] ' + String((error && error.message) || error) + '\n');
      process.exit(1);
    });
  } else {
    runWorker(arg('out-dir', path.join(os.tmpdir(), 'folia-tts-out')));
  }
}

module.exports = {
  ENGINES,
  MAX_TEXT_CHARS,
  ENGINE_TIMEOUT_MS,
  NEURAL_VOICE_RE,
  isNeuralVoice,
  engineOrderForVoice,
  powershellPath,
  validateWav,
  runSapiEngine,
  runEdgeEngine,
  synthesizeOnce,
};
