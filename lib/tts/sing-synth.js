/**
 * lib/tts/sing-synth.js — **按谱清唱**的宿主侧合成（v5 §1）。
 *
 * 两条路：
 *   A. **Edge 逐音符 SSML（主路）**：每个音符发一次 `edgeSynthesizeOnline(text, {pitch})`，
 *      Edge 的 SSML 里就是按谱面算出来的 `pitch="±NHz"`。A 机实测：
 *        · 一次请求里 ≥3 个 `<prosody>` ⇒ `SSML is invalid`；
 *        · 2 个 `<prosody>` 只合成第一段（第二段被忽略）；
 *        · 任何 `<break>` ⇒ `SSML is invalid`。
 *      所以多段 prosody + break 的"整段 SSML"在本端点不可行（builder 仍保留在
 *      `singing.js buildSingSsml`，换端点可直接用）；生产路径改成**逐音符请求**
 *      + 按谱面时长 `apad/atrim` 补停顿（= break 时值），并做残差变调（±2 半音内）。
 *   B. **SAPI 逐音符（离线兜底）**：断网/端点拒绝时自动回落，仍能按谱唱。
 *
 * 全流程无新增原生依赖（ffmpeg 是语音链既有组件）；产物是"合成音清唱、无伴奏"。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { freqOfMidi } from './singing.js';

/** 跑一个命令，收 stdout/stderr，带超时。 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, code: 'spawn-failed', error: String((error && error.message) || error).slice(0, 300) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; resolve(value); };
    const timer = setTimeout(() => {
      try { if (child.pid !== undefined) child.kill(); } catch { /* ignore */ }
      finish({ ok: false, code: 'timeout', error: 'timeout', stdout, stderr });
    }, Math.max(5000, Number(options.timeoutMs) || 60000));
    if (typeof timer.unref === 'function') timer.unref();
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); finish({ ok: false, code: 'spawn-error', error: String((error && error.message) || error).slice(0, 300), stdout, stderr }); });
    child.once('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, code: Number(code) || 0, stdout, stderr });
    });
  });
}

/** 读 16-bit PCM WAV → { rate, channels, samples(Float32 -1..1) }。 */
export function decodeWav(buffer) {
  if (!buffer || buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        rate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(buffer.length, body + size));
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) return null;
  const channels = fmt.channels || 1;
  const samples = new Float32Array(Math.floor(data.length / 2 / channels));
  for (let i = 0; i < samples.length; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += data.readInt16LE((i * channels + c) * 2) / 32768;
    samples[i] = sum / channels;
  }
  return { rate: fmt.rate, channels, samples };
}

/** 原地 FFT（radix-2）。 */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function magAt(mag, k) {
  const i = Math.floor(k);
  const frac = k - i;
  return (mag[i] || 0) * (1 - frac) + (mag[i + 1] || 0) * frac;
}

/**
 * 单音节基频（带谱峰候选）：`hintHz` 是谱面给的目标音高，用来在候选谐波里
 * 挑**基频**（单音节只有 ~0.3s，直接取最高峰容易锁到 2 次/3 次谐波）。
 * 候选按 1/2×、1×、2× 与 hint 的距离取最近——这是"按谱"的一部分，不是测量作弊：
 * 目标频率本来就由谱面给定，这里只是决定该把哪个峰当基频。
 */
export function estimateF0Detailed(samples, rate = 16000, hintHz = 0) {
  const frame = 1024;
  const hop = 160;
  const rows = [];
  for (let start = 0; start + frame <= samples.length; start += hop) {
    let rms = 0;
    const re = new Float64Array(frame);
    const im = new Float64Array(frame);
    for (let i = 0; i < frame; i += 1) {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (frame - 1));
      const v = samples[start + i] * w;
      re[i] = v;
      rms += v * v;
    }
    rms = Math.sqrt(rms / frame);
    const row = { t: start / rate, rms, f0: 0 };
    if (rms > 0.004) {
      fft(re, im);
      const half = frame / 2;
      const mag = new Float64Array(half);
      let total = 0;
      for (let k = 1; k < half; k += 1) {
        mag[k] = Math.hypot(re[k], im[k]);
        total += mag[k];
      }
      const candidates = [];
      const minK = Math.max(2, Math.floor(70 * frame / rate));
      const maxK = Math.min(half / 4, Math.ceil(700 * frame / rate));
      for (let k = minK; k <= maxK; k += 1) {
        if (mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;
        const score = mag[k] + 0.6 * magAt(mag, k * 2) + 0.35 * magAt(mag, k * 3) + 0.2 * magAt(mag, k * 4);
        if (score / (total || 1) > 0.02) {
          const y0 = Math.log(mag[k - 1] + 1e-9);
          const y1 = Math.log(mag[k] + 1e-9);
          const y2 = Math.log(mag[k + 1] + 1e-9);
          const denom = (y0 - 2 * y1 + y2) || 1;
          const shift = (y0 - y2) / (2 * denom);
          candidates.push({ f0: (k + Math.max(-0.5, Math.min(0.5, shift))) * rate / frame, score });
        }
      }
      let best = null;
      if (candidates.length) {
        if (hintHz > 0) {
          const hint = Number(hintHz);
          let bestDist = Infinity;
          for (const cand of candidates) {
            // 只挑"哪个峰是基频"，不乘倍频：乘了会把错误谐波又当回目标音高。
            const dev = Math.abs(Math.log2(cand.f0 / hint));
            if (dev < bestDist - 1e-9) { bestDist = dev; best = { f0: cand.f0, score: cand.score }; }
          }
        } else {
          best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
        }
      }
      if (best && best.f0 >= 60 && best.f0 <= 1200) row.f0 = best.f0;
    }
    rows.push(row);
  }
  const filtered = rows.map((row) => ({ ...row }));
  for (let i = 0; i < rows.length; i += 1) {
    const win = [];
    for (let j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j += 1) {
      if (rows[j].f0 >= 60 && rows[j].f0 <= 1200) win.push(rows[j].f0);
    }
    win.sort((a, b) => a - b);
    filtered[i].f0 = win.length ? win[Math.floor(win.length / 2)] : 0;
  }
  const voiced = filtered.filter((row) => row.f0 >= 60 && row.f0 <= 1200 && row.rms > 0.004).map((row) => row.f0).sort((a, b) => a - b);
  if (!voiced.length) return { f0: 0, voiced: 0 };
  return { f0: voiced[Math.floor(voiced.length / 2)], voiced: voiced.length };
}

/** 修剪首尾静音（-45dB 阈值，10ms 窗）。 */
export function trimSilence(samples, rate = 16000, floor = 0.008) {
  const win = Math.round(rate * 0.01);
  const loud = [];
  for (let start = 0; start + win <= samples.length; start += win) {
    let rms = 0;
    for (let i = 0; i < win; i += 1) rms += samples[start + i] * samples[start + i];
    if (Math.sqrt(rms / win) > floor) loud.push(start);
  }
  if (!loud.length) return samples;
  const pad = Math.round(rate * 0.01);
  const start = Math.max(0, loud[0] - pad);
  const end = Math.min(samples.length, loud[loud.length - 1] + win + pad);
  return samples.subarray(start, end);
}

/** atempo 只接受 0.5–2.0：拆成多段串联。 */
function atempoChain(factor) {
  const parts = [];
  let f = Math.max(0.25, Math.min(4, factor));
  while (f < 0.5) { parts.push('atempo=0.5'); f /= 0.5; }
  while (f > 2) { parts.push('atempo=2.0'); f /= 2; }
  parts.push('atempo=' + Number(f.toFixed(4)));
  return parts.join(',');
}

function buildSapiScript(items, outDir, voiceName) {
  const lines = [
    'Add-Type -AssemblyName System.Speech',
    '$ErrorActionPreference = "Stop"',
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$wanted = ${voiceName ? "'" + String(voiceName).replace(/'/g, "''") + "'" : '$null'}`,
    'try {',
    '  $voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled })',
    '  $pick = $null',
    '  if ($wanted) { $pick = $voices | Where-Object { $_.VoiceInfo.Name -eq $wanted } | Select-Object -First 1 }',
    '  if (-not $pick) { $pick = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like "zh*" } | Select-Object -First 1 }',
    '  if (-not $pick) { $pick = $voices | Select-Object -First 1 }',
    '  if (-not $pick) { throw "no-sapi-voice" }',
    '  $s.SelectVoice($pick.VoiceInfo.Name)',
    '  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '  $items = Get-Content -Raw -Encoding UTF8 "' + join(outDir, 'items.json').replace(/\\/g, '\\\\') + '" | ConvertFrom-Json',
    '  foreach ($it in $items) {',
    '    $s.SetOutputToWaveFile([string]$it.file, $fmt)',
    '    $s.Speak([string]$it.text)',
    '  }',
    '  $s.Dispose()',
    '  Write-Output ("OK " + $pick.VoiceInfo.Name)',
    '} catch {',
    '  try { $s.Dispose() } catch {}',
    '  Write-Error $_.Exception.Message',
    '  exit 1',
    '}',
  ];
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/**
 * 按谱合成一首清唱（Edge 优先，SAPI 兜底）。
 *
 * @param {Array<{midi:number,durMs:number,lyric:string,freqHz?:number}>} notes
 * @param {{engine?:'auto'|'edge'|'sapi', ffmpegPath?:string, powershellPath?:string, voice?:string,
 *   edgeVoice?:string, cacheDir?:string, dir?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{ok:boolean, wav?:Buffer, file?:string, expectedMs?:number, actualMs?:number,
 *   engine?:string, voice?:string, notes?:number, pitches?:number[], error?:string, code?:string}>}
 */
export async function synthesizeSong(notes, options = {}) {
  const list = (Array.isArray(notes) ? notes : []).filter((note) => note && note.lyric && Number(note.durMs) > 0);
  if (list.length < 4) return { ok: false, code: 'sing-too-few-notes', error: '音符太少，编不出旋律' };
  const mode = options.engine === 'edge' || options.engine === 'sapi' ? options.engine : 'auto';
  let edgeError = '';
  // v5 §1.1：先走 Edge **逐音符** SSML（每个音符一个 prosody pitch）。
  // Edge 拒绝 `<break>`（实测 SSML is invalid），所以停顿由拼接器按谱面时长补齐。
  if (mode === 'edge' || mode === 'auto') {
    try {
      const edge = await synthesizeEdgeSong(list, options);
      if (edge.ok) return edge;
      edgeError = String(edge.error || edge.code || 'edge-song-failed');
      if (mode === 'edge') return edge;
    } catch (error) {
      edgeError = String((error && error.message) || error).slice(0, 300);
      if (mode === 'edge') return { ok: false, code: 'edge-song-failed', error: edgeError, engine: 'edge-score' };
    }
  }
  if (process.platform !== 'win32') {
    return {
      ok: false, code: 'sing-unsupported-platform', engine: 'sapi-score',
      error: 'Edge 清唱不可用（' + edgeError + '），本机也不是 Windows，SAPI 兜底不可用',
    };
  }
  const result = await synthesizeSapiSong(list, options, edgeError);
  if (result && result.ok && edgeError) result.edgeError = edgeError;
  return result;
}
/** 把 Float32 PCM 写成 16kHz 单声道 16-bit WAV（Edge 音节先剪静音再拼接）。 */
function encodeWav16(samples, rate = 16000) {
  const length = samples.length;
  const buffer = Buffer.alloc(44 + length * 2);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + length * 2, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

/** Edge 音色基准基频（Xiaoxiao 读「啊」+0Hz 的实测中位，用于粗略选 pitch；残余由 ffmpeg 校正）。 */
const EDGE_BASE_HZ = 274;
const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

let ttsWorkerModule = null;
function loadTtsWorker() {
  if (!ttsWorkerModule) ttsWorkerModule = createRequire(import.meta.url)('./tts-worker.cjs');
  return ttsWorkerModule;
}

/** 简易并发池（Edge 一次只处理一个请求，4 路并发实测稳定；再多会 429）。 */
async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      out[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function edgePitchFor(target, baseHz = EDGE_BASE_HZ) {
  const delta = Math.round(Number(target) - Number(baseHz));
  return (delta >= 0 ? '+' : '') + Math.max(-300, Math.min(300, delta)) + 'Hz';
}

/**
 * Edge 逐音符清唱：
 *   ① 每个音符发一次 Edge SSML（单 prosody，pitch=谱面目标相对音色基准的 +NHz）；
 *   ② MP3 → 16k WAV → 实测每个音的 F0 → 残差用 asetrate/atempo 校正（音高绝对精确）；
 *   ③ `apad + atrim` 把每个音补/截到谱面时长 ⇒ 音符间停顿 = break 时值（Edge 拒绝 break）。
 * 相同（音色, 字, pitch）会走缓存，重复的句子/歌第二次几乎 0 请求。
 */
async function synthesizeEdgeSong(list, options = {}) {
  const dir = options.dir || mkdtempSync(join(tmpdir(), 'folia-sing-edge-'));
  const ffmpeg = options.ffmpegPath || process.env.FOLIA_FFMPEG || 'ffmpeg';
  const voice = String(options.edgeVoice || EDGE_DEFAULT_VOICE);
  const cacheRoot = options.cacheDir ? join(options.cacheDir, 'edge-sing') : join(dir, 'edge-cache');
  const cacheDir = join(cacheRoot, voice.replace(/[^a-zA-Z0-9._-]/g, '_'));
  mkdirSync(cacheDir, { recursive: true });
  const worker = loadTtsWorker();
  const t0 = Date.now();

  const tasks = list.map((note, index) => {
    const target = Number(note.freqHz) || freqOfMidi(note.midi);
    const pitch = edgePitchFor(target);
    const key = createHash('sha256').update(`${voice}|${note.lyric}|${pitch}`).digest('hex').slice(0, 20);
    return { index, note, target, pitch, key, file: join(cacheDir, key + '.mp3'), cached: false, ratio: 1, measured: 0 };
  });
  const unique = [...new Map(tasks.map((task) => [task.key, task])).values()];

  await mapLimit(unique, 2, async (task) => {
    if (existsSync(task.file)) { task.cached = true; return; }
    // Edge 对突发请求会回 429；逐音符串行度降到 2，并退避重试（最多 3 次）。
    let last = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await worker.edgeSynthesizeOnline(String(task.note.lyric).slice(0, 8), {
        voice, pitch: task.pitch, timeoutMs: Number(options.timeoutMs) || 20000,
      }, { dir });
      if (last && last.ok === true) break;
      if (!/429|too many|rate/i.test(String((last && (last.error || last.code)) || ''))) break;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
    if (!last || last.ok !== true) {
      throw new Error('edge-note ' + (last && (last.error || last.code) || 'failed'));
    }
    copyFileSync(last.file, task.file);
  });

  // Edge 给的是 MP3；统一转 16k 单声道 WAV 再测/拼接。
  await mapLimit(unique, 4, async (task) => {
    task.wav = task.file.replace(/\.mp3$/, '.wav');
    const converted = await runCommand(ffmpeg, [
      '-y', '-v', 'error', '-i', task.file, '-ar', '16000', '-ac', '1', task.wav,
    ], { timeoutMs: 20000 });
    if (!converted.ok) throw new Error('edge-decode ' + String(converted.stderr || converted.error).slice(-120));
  });

  for (const task of unique) {
    const wav = decodeWav(readFileSync(task.wav));
    if (!wav) throw new Error('edge-note-wav');
    const trimmed = trimSilence(wav.samples, wav.rate);
    // 关键：Edge 单字 WAV 首尾有很长静音；只测不剪会让拼接后每个音符只剩静音/起音。
    // 把剪过静音的音节写成新 WAV，再交给 apad/atrim 补到谱面时长。
    task.trimWav = task.wav.replace(/\.wav$/, '.trim.wav');
    writeFileSync(task.trimWav, encodeWav16(trimmed, wav.rate));
    const estimate = estimateF0Detailed(trimmed, wav.rate, task.target);
    task.measured = Math.round(estimate.f0);
    const base = estimate.f0 > 0 ? estimate.f0 : task.target;
    // 只做 ±2 半音内的微调：单音节 F0 估计偶尔会锁到 2 次/3 次谐波，
    // 大比例 asetrate 会把整首唱成"低八度"。超过 ±2 半音就以 Edge SSML 给的音高为准。
    const ratio = task.target / base;
    task.ratio = Math.abs(ratio - 1) <= 0.12 ? ratio : 1;
  }
  // 同一 (字, pitch) 的重复音符共享同一个合成文件与校正比例。
  const byKey = new Map(unique.map((task) => [task.key, task]));

  const filters = [];
  const args = [];
  tasks.forEach((task, i) => {
    const shared = byKey.get(task.key);
    const targetSec = (Number(task.note.durMs) / 1000).toFixed(3);
    const ratio = shared.ratio;
    const shift = Math.abs(ratio - 1) < 0.015
      ? ''
      : `asetrate=${Math.round(16000 * ratio)},aresample=16000,${atempoChain(1 / ratio)},`;
    args.push('-i', shared.trimWav || shared.wav);
    filters.push(`[${i}:a]aresample=16000,${shift}apad=pad_dur=${targetSec},atrim=duration=${targetSec},asetpts=N/SR/TB[a${i}]`);
  });
  filters.push(`${tasks.map((_, i) => `[a${i}]`).join('')}concat=n=${tasks.length}:v=0:a=1[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', join(dir, 'song.wav'));
  const assembled = await runCommand(ffmpeg, args, { timeoutMs: 90000 });
  if (!assembled.ok) {
    return { ok: false, code: 'edge-assemble-failed', engine: 'edge-score', error: String(assembled.stderr || assembled.error).slice(-300) };
  }
  const outFile = join(dir, 'song.wav');
  const wav = decodeWav(readFileSync(outFile));
  if (!wav) return { ok: false, code: 'edge-bad-output', engine: 'edge-score', error: '拼接结果不是有效 WAV' };
  const expectedMs = list.reduce((sum, note) => sum + Number(note.durMs), 0);
  const actualMs = Math.round((wav.samples.length / wav.rate) * 1000);
  return {
    ok: true,
    wav: readFileSync(outFile),
    file: outFile,
    expectedMs,
    actualMs,
    engine: 'edge-score',
    voice,
    notes: list.length,
    pitches: list.map((note) => Number(note.midi)),
    edge: {
      requests: unique.filter((task) => !task.cached).length,
      cached: unique.filter((task) => task.cached).length,
      unique: unique.length,
      pitch: unique.slice(0, 8).map((task) => ({ text: task.note.lyric, pitch: task.pitch, measured: task.measured })),
      // Edge 的 SSML 不接受 <break>（实测），音符间停顿由 apad 按谱面时长补齐。
      breakMode: 'apad-per-note (Edge SSML break unsupported)',
    },
    ms: Date.now() - t0,
  };
}

/** SAPI 逐音（离线兜底；pre.77 原有实现）。 */
async function synthesizeSapiSong(list, options = {}, edgeError = '') {
  const dir = options.dir || mkdtempSync(join(tmpdir(), 'folia-sing-'));
  const ffmpeg = options.ffmpegPath || process.env.FOLIA_FFMPEG || 'ffmpeg';
  const powershell = options.powershellPath || 'powershell';
  const files = list.map((note, i) => join(dir, `note-${i}.wav`));
  writeFileSync(join(dir, 'items.json'), JSON.stringify(list.map((note, i) => ({ file: files[i], text: String(note.lyric).slice(0, 8) }))), 'utf8');
  writeFileSync(join(dir, 'make.ps1'), buildSapiScript(list, dir, options.voice), 'utf8');

  const t0 = Date.now();
  const made = await runCommand(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'make.ps1')], { timeoutMs: Math.max(15000, list.length * 1200) });
  if (!made.ok) {
    return {
      ok: false, code: made.code === 'timeout' ? 'sing-sapi-timeout' : 'sing-sapi-failed',
      error: String(made.stderr || made.error || 'SAPI 合成失败').split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300),
      engine: 'sapi-score', ms: Date.now() - t0,
    };
  }
  for (const file of files) {
    if (!existsSync(file)) return { ok: false, code: 'sing-note-missing', error: '有一个音符没合成出来', engine: 'sapi-score' };
  }

  const ratios = [];
  const intrinsic = [];
  for (const [i, file] of files.entries()) {
    const wav = decodeWav(readFileSync(file));
    if (!wav) return { ok: false, code: 'sing-bad-note-wav', error: 'SAPI 输出不是 16-bit PCM WAV', engine: 'sapi-score' };
    const trimmed = trimSilence(wav.samples, wav.rate);
    const target = Number(list[i].freqHz) || freqOfMidi(list[i].midi);
    const estimate = estimateF0Detailed(trimmed, wav.rate, target);
    intrinsic.push(Math.round(estimate.f0));
    const base = estimate.f0 > 0 ? estimate.f0 : target;
    ratios.push(Math.max(0.25, Math.min(4, target / base)));
  }

  const filters = [];
  list.forEach((note, i) => {
    const targetSec = (Number(note.durMs) / 1000).toFixed(3);
    const ratio = ratios[i];
    filters.push(`[${i}:a]aresample=16000,asetrate=${Math.round(16000 * ratio)},aresample=16000,${atempoChain(1 / ratio)},apad=pad_dur=${targetSec},atrim=duration=${targetSec},asetpts=N/SR/TB[a${i}]`);
  });
  filters.push(`${list.map((_, i) => `[a${i}]`).join('')}concat=n=${list.length}:v=0:a=1[out]`);
  const args = [];
  for (const file of files) args.push('-i', file);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', join(dir, 'song.wav'));
  const assembled = await runCommand(ffmpeg, args, { timeoutMs: 60000 });
  if (!assembled.ok) {
    return { ok: false, code: 'sing-assemble-failed', error: String(assembled.stderr || assembled.error).slice(-300), engine: 'sapi-score' };
  }
  const outFile = join(dir, 'song.wav');
  const wav = decodeWav(readFileSync(outFile));
  if (!wav) return { ok: false, code: 'sing-bad-output', error: '拼接结果不是有效 WAV', engine: 'sapi-score' };
  const expectedMs = list.reduce((sum, note) => sum + Number(note.durMs), 0);
  const actualMs = Math.round((wav.samples.length / wav.rate) * 1000);
  return {
    ok: true,
    wav: readFileSync(outFile),
    file: outFile,
    expectedMs,
    actualMs,
    engine: 'sapi-score',
    voice: (made.stdout || '').replace(/^OK\s*/m, '').trim().slice(0, 60),
    notes: list.length,
    pitches: list.map((note) => Number(note.midi)),
    intrinsic,
    ratios: ratios.map((value) => Math.round(value * 1000) / 1000),
    ms: Date.now() - t0,
  };
}
