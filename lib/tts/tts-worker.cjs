/**
 * tts-worker.cjs — 本地 TTS 子进程入口（普通 node.exe 运行，**不能**在 Electron 里跑）
 *
 * 为什么必须是独立进程：
 *   sherpa-onnx 的 native 扩展会创建 V8 external buffer，
 *   Electron/DSH 进程里会直接抛 `External buffers are not allowed`。
 *   普通 node.exe 没有这个限制 —— 所以合成放到子进程，主进程只走 stdio。
 *
 * 协议：stdin/stdout 各一行一条 JSON（NDJSON），stdout 只写协议、日志全部走 stderr。
 *   请求：{ "id": "1", "text": "要念的话", "speed": 1.0 }
 *   成功：{ "id": "1", "ok": true, "sampleRate": 44100, "wav": "<base64>", "ms": 1340 }
 *   失败：{ "id": "1", "ok": false, "error": "原因" }
 *   就绪：{ "ready": true, "sampleRate": 44100, "speakers": 1 }
 *
 * 用法：node tts-worker.cjs --model-dir <dir> [--speed 1.0]
 *   <dir> 里要有：node/、sherpa-onnx-node/、sherpa-onnx-win-x64/、models/melo/
 *   实际布局由 lib/tts/local.js 决定；本脚本只按参数找文件。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const root = arg('model-dir', '');
if (!root) {
  process.stderr.write('[tts-worker] 缺少 --model-dir\n');
  process.exit(2);
}

const modelDir = path.join(root, 'models', 'melo');
const sherpaDir = path.join(root, 'runtime', 'sherpa-onnx-node');
const sherpaNative = path.join(root, 'runtime', 'sherpa-onnx-win-x64');

const modelFile = path.join(modelDir, 'model.onnx');
for (const p of [modelFile, path.join(modelDir, 'tokens.txt'), path.join(modelDir, 'lexicon.txt'), sherpaDir]) {
  if (!fs.existsSync(p)) {
    process.stderr.write('[tts-worker] 缺少文件：' + p + '\n');
    process.exit(3);
  }
}

// native 扩展按模块名解析同目录的 sherpa-onnx-win-x64：这里显式把两个目录放进搜索路径
process.env.PATH = sherpaNative + ';' + process.env.PATH;
process.env.NODE_PATH = root;

let OfflineTts;
try {
  ({ OfflineTts } = require(path.join(sherpaDir, 'non-streaming-tts.js')));
} catch (e) {
  process.stderr.write('[tts-worker] 加载 sherpa 失败：' + e.message + '\n');
  process.exit(4);
}

let tts;
try {
  tts = new OfflineTts({
    model: {
      vits: {
        model: modelFile,
        tokens: path.join(modelDir, 'tokens.txt'),
        lexicon: path.join(modelDir, 'lexicon.txt'),
      },
      numThreads: Math.max(1, Math.min(4, (require('node:os').cpus().length || 2) - 1)),
      debug: 0,
      provider: 'cpu',
    },
    maxNumSentences: 1,
  });
} catch (e) {
  process.stderr.write('[tts-worker] 初始化模型失败：' + e.message + '\n');
  process.exit(5);
}

/** Float32 波形 → 16bit PCM WAV Buffer。 */
function toWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] < -1 ? -1 : samples[i] > 1 ? 1 : samples[i];
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

const defaultSpeed = Number(arg('speed', '1')) || 1;
const sampleRate = tts.sampleRate;

process.stdout.write(JSON.stringify({ ready: true, sampleRate, speakers: 1 }) + '\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = String(line || '').trim();
  if (!text) return;
  let req;
  try { req = JSON.parse(text); } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'bad-json' }) + '\n'); return; }
  const id = req.id ?? null;
  const content = String(req.text ?? '').slice(0, 300);
  if (!content) { process.stdout.write(JSON.stringify({ id, ok: false, error: 'empty-text' }) + '\n'); return; }
  const speed = Number.isFinite(req.speed) ? Math.max(0.6, Math.min(1.6, req.speed)) : defaultSpeed;
  const t0 = Date.now();
  try {
    const audio = tts.generate({ text: content, sid: 0, speed });
    const wav = toWav(audio.samples, sampleRate);
    process.stdout.write(JSON.stringify({ id, ok: true, sampleRate, wav: wav.toString('base64'), ms: Date.now() - t0 }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: String(e && e.message || e) }) + '\n');
  }
});

rl.on('close', () => process.exit(0));
