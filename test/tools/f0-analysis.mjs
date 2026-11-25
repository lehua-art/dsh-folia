/**
 * test/tools/f0-analysis.mjs — 音高分析（验收 S1–S3 的**客观数据源**）。
 *
 * 方法（可复现，不依赖听感）：
 *   1. 读 16-bit PCM WAV；非 16k 用 ffmpeg 转 16k 单声道；
 *   2. 短时傅里叶（1024 点 / 40ms，Hann 窗）；每帧在 100–500Hz 找谱峰，
 *      用「基频 + 2/3/4 次谐波」打分（清唱元音与朗读都适用）；
 *   3. 7 帧中值滤波去掉倍频/半频跳变；
 *   4. 按 >80ms 静音切段；每段取中位 F0（一个音符/一个音节一个值）。
 *
 * 判据用**段中位的标准差**：朗读的自然语调 vs 唱歌的谱面音高，
 * 比"逐帧标准差"稳（逐帧会被辅音/擦音污染）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function runFfmpeg(args) {
  return execFileSync('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 读 WAV → { rate, samples }（Float32，-1..1）。非 16k 自动转。 */
export function readWav(file) {
  let buf;
  try { buf = readFileSync(file); } catch { throw new Error('no-file'); }
  const parsed = parseWav(buf);
  if (!parsed) throw new Error('not-16bit-pcm-wav');
  if (parsed.rate === 16000) return parsed;
  const out = file.replace(/\.wav$/i, '') + '.16k.wav';
  runFfmpeg(['-y', '-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', out]);
  return parseWav(readFileSync(out));
}

function parseWav(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
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
  return { rate: fmt.rate, samples };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang); const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1; let ci = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const ur = re[i + k]; const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function magAt(mag, k) {
  const i = Math.floor(k);
  const frac = k - i;
  return (mag[i] || 0) * (1 - frac) + (mag[i + 1] || 0) * frac;
}

/** 逐帧 F0（100–500Hz 谱峰 + 谐波打分 + 中值滤波）。 */
export function f0Frames(samples, rate) {
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
    if (rms > 0.006) {
      fft(re, im);
      const half = frame / 2;
      const mag = new Float64Array(half);
      let total = 0;
      for (let k = 1; k < half; k += 1) { mag[k] = Math.hypot(re[k], im[k]); total += mag[k]; }
      let bestScore = 0;
      let bestK = 0;
      const minK = Math.max(2, Math.floor(100 * frame / rate));
      const maxK = Math.min(half / 4, Math.ceil(500 * frame / rate));
      for (let k = minK; k <= maxK; k += 1) {
        if (mag[k] < mag[k - 1] || mag[k] < mag[k + 1]) continue;
        const score = mag[k] + 0.6 * magAt(mag, k * 2) + 0.35 * magAt(mag, k * 3) + 0.2 * magAt(mag, k * 4);
        if (score > bestScore) { bestScore = score; bestK = k; }
      }
      if (bestK > 0 && bestScore / (total || 1) > 0.02) {
        const y0 = Math.log(mag[bestK - 1] + 1e-9);
        const y1 = Math.log(mag[bestK] + 1e-9);
        const y2 = Math.log(mag[bestK + 1] + 1e-9);
        const denom = (y0 - 2 * y1 + y2) || 1;
        const shift = (y0 - y2) / (2 * denom);
        row.f0 = (bestK + Math.max(-0.5, Math.min(0.5, shift))) * rate / frame;
      }
    }
    rows.push(row);
  }
  const out = rows.map((row) => ({ ...row }));
  for (let i = 0; i < rows.length; i += 1) {
    const win = [];
    for (let j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j += 1) if (rows[j].f0 > 0) win.push(rows[j].f0);
    win.sort((a, b) => a - b);
    out[i].f0 = win.length ? win[Math.floor(win.length / 2)] : 0;
  }
  return out;
}

/** 段中位 F0 列表 + 统计量。 */
export function pitchStats(file) {
  const { samples, rate } = readWav(file);
  const frames = f0Frames(samples, rate);
  const segs = [];
  let cur = null;
  let silent = 0;
  for (const frame of frames) {
    const voiced = frame.f0 >= 90 && frame.f0 <= 500 && frame.rms > 0.008;
    if (voiced) {
      silent = 0;
      if (!cur) { cur = { f0s: [] }; segs.push(cur); }
      cur.f0s.push(frame.f0);
    } else if (cur) {
      silent += 10;
      if (silent > 80) { cur = null; silent = 0; }
    }
  }
  const medians = segs.filter((seg) => seg.f0s.length >= 4).map((seg) => {
    const arr = seg.f0s.slice().sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  });
  const mean = medians.reduce((a, b) => a + b, 0) / (medians.length || 1);
  const variance = medians.reduce((a, b) => a + (b - mean) ** 2, 0) / (medians.length || 1);
  return {
    file,
    durationMs: Math.round((samples.length / rate) * 1000),
    segments: medians.length,
    medians: medians.map((v) => Math.round(v)),
    f0Std: Math.round(Math.sqrt(variance) * 10) / 10,
    f0Mean: Math.round(mean * 10) / 10,
  };
}

if (process.argv[1] && process.argv[1].endsWith('f0-analysis.mjs')) {
  for (const file of process.argv.slice(2)) {
    try { console.log(JSON.stringify(pitchStats(file))); } catch (error) { console.log(JSON.stringify({ file, error: String((error && error.message) || error) })); }
  }
}

