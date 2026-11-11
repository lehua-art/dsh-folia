/**
 * asr-worker.cjs — 本地 STT 子进程入口（普通 node.exe 运行，**不能**在 Electron 里跑）
 *
 * 为什么独立进程：与 tts-worker.cjs 同一原因 —— sherpa-onnx 的 native 扩展会创建 V8
 * external buffer，Electron 进程里直接抛 `External buffers are not allowed`。
 *
 * 协议（stdin/stdout 各一行一条 JSON，stdout 只写协议、日志走 stderr）：
 *   请求：{ "id": "1", "wavPath": "C:\\...\\in.wav" }
 *   成功：{ "id": "1", "ok": true, "text": "你好", "ms": 420 }
 *   失败：{ "id": "1", "ok": false, "error": "原因" }
 *   就绪：{ "ready": true, "model": "sensevoice", "sampleRate": 16000 }
 *
 * 用法：node asr-worker.cjs --model-dir <dir>
 *   <dir> 里要有：runtime/sherpa-onnx-node/、runtime/sherpa-onnx-win-x64/、models/sensevoice/
 *   models/sensevoice/ 需要 model.int8.onnx（或 model.onnx）+ tokens.txt
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const root = arg('model-dir', '');
if (!root) {
  process.stderr.write('[asr-worker] 缺少 --model-dir\n');
  process.exit(2);
}

const modelDir = path.join(root, 'models', 'sensevoice');
const sherpaDir = path.join(root, 'runtime', 'sherpa-onnx-node');
const sherpaNative = path.join(root, 'runtime', 'sherpa-onnx-win-x64');

const modelFile = fs.existsSync(path.join(modelDir, 'model.int8.onnx'))
  ? path.join(modelDir, 'model.int8.onnx')
  : path.join(modelDir, 'model.onnx');
const tokensFile = path.join(modelDir, 'tokens.txt');

for (const p of [modelFile, tokensFile, sherpaDir]) {
  if (!fs.existsSync(p)) {
    process.stderr.write('[asr-worker] 缺少文件：' + p + '\n');
    process.exit(3);
  }
}

// native 扩展按模块名解析同目录的 sherpa-onnx-win-x64
process.env.PATH = sherpaNative + ';' + process.env.PATH;
process.env.NODE_PATH = root;

let OfflineRecognizer;
try {
  ({ OfflineRecognizer } = require(path.join(sherpaDir, 'non-streaming-asr.js')));
} catch (e) {
  process.stderr.write('[asr-worker] 加载 sherpa 失败：' + e.message + '\n');
  process.exit(4);
}

const numThreads = Math.max(1, Math.min(4, (os.cpus().length || 2) - 1));
let recognizer;
try {
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: modelFile,
        language: 'zh',
        useInverseTextNormalization: 1,
      },
      tokens: tokensFile,
      numThreads,
      debug: 0,
      provider: 'cpu',
    },
  });
} catch (e) {
  process.stderr.write('[asr-worker] 初始化模型失败：' + e.message + '\n');
  process.exit(5);
}

/**
 * 读 16-bit PCM WAV → Float32Array（-1..1）。
 * 只认 ffmpeg 产出的形态（PCM s16le、单声道）；多声道取第一声道。
 */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV 文件');
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    pos = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 段');
  if (fmt.bits !== 16) throw new Error('只支持 16-bit PCM，收到 ' + fmt.bits + ' bit');
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    out[i] = data.readInt16LE(i * 2 * fmt.channels) / 32768;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

/** 采样率不是 16k 时做一次线性重采样（ffmpeg 一般已给 16k，这里兜底）。 */
function resample16k(samples, sampleRate) {
  if (!sampleRate || sampleRate === 16000) return samples;
  const ratio = 16000 / sampleRate;
  const length = Math.max(1, Math.floor(samples.length * ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

function transcribe(wavPath) {
  const started = Date.now();
  const { samples, sampleRate } = readWav(wavPath);
  if (!samples.length) return { ok: true, text: '', ms: 0 };
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples: resample16k(samples, sampleRate), sampleRate: 16000 });
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  const text = String((result && result.text) || '').trim();
  return { ok: true, text, ms: Date.now() - started };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const raw = String(line || '').trim();
  if (!raw) return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'bad-json' }) + '\n');
    return;
  }
  const id = req && req.id !== undefined ? req.id : null;
  try {
    if (!req || typeof req.wavPath !== 'string') throw new Error('缺少 wavPath');
    const result = transcribe(req.wavPath);
    process.stdout.write(JSON.stringify({ id, ...result }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String((e && e.message) || e) }) + '\n');
  }
});

process.stdout.write(JSON.stringify({ ready: true, model: 'sensevoice', sampleRate: 16000 }) + '\n');
