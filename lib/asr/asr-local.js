/**
 * asr-local.js — 本地 STT 运行时：下载/校验/启动 worker（宿主侧，普通 node 进程）。
 *
 * 设计约束（和 tts 那套一致）：
 *   · 资源不进 npm 包，放站点 R2，按 manifest 逐文件下载（带 sha256 校验、可续传）
 *   · **不能**在本进程里 require sherpa（Electron 里 native addon 会抛
 *     `External buffers are not allowed`）⇒ 一律走 node.exe 子进程 + NDJSON
 *   · 用户零操作：第一次用语音时自动下载，进度通过 onProgress 回给上层
 *
 * manifest 形状（站点 /media/asr/v1/manifest.json）：
 *   { "version":"v1", "sampleRate":16000,
 *     "files":[ { "key":"asr/v1/models/sensevoice/model.int8.onnx", "size":123, "sha256":"…" } ] }
 *   key 同时也是相对 /media/ 的路径（便于复用别的包里的文件，例如 node.exe）。
 */
import { createHash } from 'node:crypto';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MEDIA_BASE = String(
  process.env.FOLIA_ASR_BASE
  || process.env.FOLIA_ASR_MEDIA_BASE
  || 'https://folia-5ve.pages.dev/media/',
).replace(/\/?$/, '/');
const DEFAULT_MANIFEST = String(process.env.FOLIA_ASR_MANIFEST || (MEDIA_BASE + 'asr/v1/manifest.json'));

/**
 * 下载一个文件到 dest（先写 .part，校验通过再改名；支持 Range 续传）。
 *
 * v0.2：**边下边报**（onBytes 每个 chunk 调一次），单次请求有超时；
 * 超时/断流时保留 .part，下一轮用 Range 从断点续传，不再“卡住十几分钟没进度”。
 */
async function downloadOne(url, dest, expectedSize, onBytes, options = {}) {
  const part = dest + '.part';
  let start = 0;
  try { if (existsSync(part)) start = statSync(part).size; } catch { start = 0; }
  if (expectedSize > 0 && start > expectedSize) {
    try { rmSync(part, { force: true }); } catch { /* ignore */ }
    start = 0;
  }
  if (existsSync(dest) && expectedSize > 0 && statSync(dest).size === expectedSize) {
    if (typeof onBytes === 'function') onBytes(expectedSize);
    return;
  }
  const headers = {};
  if (start > 0) headers.Range = `bytes=${start}-`;
  const controller = new AbortController();
  const timeoutMs = Math.max(15000, Number(options.timeoutMs) || 180000);
  const timer = setTimeout(() => controller.abort(new Error('download-timeout')), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok && resp.status !== 206) throw new Error(`下载失败 ${resp.status} ${url}`);
    if (resp.status !== 206) start = 0; // 服务器不支持续传 ⇒ 重头写
    // 续传已有字节也要计入本轮进度（否则 ETA/百分比会从 0 重新跳）。
    if (start > 0 && typeof onBytes === 'function') onBytes(start);
    const body = Readable.fromWeb(resp.body);
    let received = 0;
    body.on('data', (chunk) => {
      received += chunk.length;
      if (typeof onBytes === 'function') onBytes(chunk.length);
    });
    await pipeline(body, createWriteStream(part, { flags: start > 0 ? 'a' : 'w' }), { signal: controller.signal });
    const size = statSync(part).size;
    if (expectedSize > 0 && size !== expectedSize) {
      throw new Error(`大小不符：${dest} 期望 ${expectedSize} 实际 ${size}`);
    }
    if (received === 0 && expectedSize > start) throw new Error('下载流为空');
    rmSync(dest, { force: true });
    renameSync(part, dest);
  } finally {
    clearTimeout(timer);
  }
}

/** 校验 sha256（不匹配则删掉重来一次）。 */
async function verifyOrDrop(file, sha256) {
  if (!sha256) return true;
  if (!existsSync(file)) return false;
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  const actual = hash.digest('hex');
  if (actual === String(sha256).toLowerCase()) return true;
  rmSync(file, { force: true });
  return false;
}

/**
 * 确保运行时完整（缺什么下什么）。
 * @returns {Promise<{ root: string, manifest: object }>}
 */
export async function ensureInstalled(root, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : null;
  const manifestUrl = options.manifestUrl || DEFAULT_MANIFEST;
  const mediaBase = String(options.mediaBase || MEDIA_BASE).replace(/\/?$/, '/');
  const timeoutMs = Math.max(1000, Number(options.fileTimeoutMs) || 180000);
  const retries = Math.max(1, Number(options.retries) || 3);
  const resp = await fetch(manifestUrl, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`manifest 获取失败 ${resp.status}`);
  const manifest = await resp.json();
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const total = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  let done = 0;
  for (const file of files) {
    const expected = Number(file.size) || 0;
    const dest = join(root, ...String(file.key).split('/').slice(2)); // 去掉 'asr/v1/'
    mkdirSync(dirname(dest), { recursive: true });
    const ok = await verifyOrDrop(dest, file.sha256);
    if (ok) {
      done += expected;
      if (onProgress) onProgress({ doneBytes: done, totalBytes: total, file: file.key, phase: 'verify' });
      continue;
    }
    const base = done;
    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        await downloadOne(mediaBase + file.key, dest, expected, (n) => {
          done = Math.min(total, base + n);
          if (onProgress) onProgress({ doneBytes: done, totalBytes: total, file: file.key, phase: 'download' });
        }, { timeoutMs });
        const verified = await verifyOrDrop(dest, file.sha256);
        if (!verified) throw new Error(`校验失败：${file.key}`);
        done = base + expected;
        if (onProgress) onProgress({ doneBytes: done, totalBytes: total, file: file.key, phase: 'verify' });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (onRetry) {
          onRetry({
            file: file.key, attempt, retries,
            error: String((error && error.message) || error),
            doneBytes: done, totalBytes: total,
          });
        }
        if (attempt >= retries) break;
        await new Promise((resolve) => { setTimeout(resolve, 800 * attempt); });
      }
    }
    if (lastError) throw lastError;
  }
  return { root, manifest };
}

/** worker 运行所需的路径（相对安装根）。 */
function workerPaths(root) {
  return {
    nodeExe: join(root, 'runtime', 'node.exe'),
    worker: join(root, 'runtime', 'asr-worker.cjs'),
  };
}

/**
 * 启动 worker（或复用已启动的）。返回 { request(wavPath) }。
 * 协议见 lib/asr/asr-worker.cjs；这里只做进程管理与超时。
 */
export function startWorker(root) {
  const { nodeExe, worker } = workerPaths(root);
  if (!existsSync(nodeExe)) throw new Error('缺少 runtime/node.exe');
  if (!existsSync(worker)) throw new Error('缺少 runtime/asr-worker.cjs');
  const child = spawn(nodeExe, [worker, '--model-dir', root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  let buffer = '';
  let ready = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const cut = buffer.indexOf('\n');
      if (cut < 0) break;
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.ready) { ready = true; continue; }
      const key = msg && msg.id !== undefined ? String(msg.id) : '';
      if (key && pending.has(key)) {
        const { resolve, timer } = pending.get(key);
        clearTimeout(timer);
        pending.delete(key);
        resolve(msg);
      }
    }
  });
  child.on('error', (error) => { lastError = String((error && error.message) || error); });
  child.stderr.setEncoding('utf8');
  let lastError = '';
  child.stderr.on('data', (chunk) => { lastError = (lastError + chunk).slice(-2000); });

  const request = (wavPath, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = String(++seq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('识别超时'));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.stdin.write(JSON.stringify({ id, wavPath }) + '\n', (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });

  return {
    isReady: () => ready,
    lastError: () => lastError,
    request,
    stop: () => {
      try { child.stdin.end(); } catch { /* ignore */ }
      try { if (child && child.pid) child.kill(); } catch { /* ignore */ }
    },
  };
}
