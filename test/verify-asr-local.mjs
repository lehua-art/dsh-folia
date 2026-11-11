/**
 * verify-asr-local.mjs — 本地 STT（SenseVoice）安装器与 worker 的判据。
 *
 * 分两档：
 *   静态（任何机器都跑）：worker 可解析、安装器导出齐全、manifest 形状正确
 *   真机（只有装了运行时才跑）：worker 能启动并把一段 wav 识别成非空文本
 *
 * 为什么真机档要 skip 而不是 fail：运行时是 340MB 的可选下载，
 * CI/别人机器上不一定有；缺资源不是缺陷，是"还没下载"。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.cwd();
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── 静态 ───────────────────────────────────────────────────────────────────────
const localPath = join(ROOT, 'lib', 'asr', 'asr-local.js');
const workerPath = join(ROOT, 'lib', 'asr', 'asr-worker.cjs');
check('S1 安装器存在', existsSync(localPath), localPath);
check('S2 worker 存在', existsSync(workerPath), workerPath);

let localSrc = '';
try { localSrc = readFileSync(localPath, 'utf8'); } catch { /* 上面已判 */ }
check(
  'S3 安装器导出 ensureInstalled + startWorker',
  /export async function ensureInstalled/.test(localSrc) && /export function startWorker/.test(localSrc),
);
check(
  'S4 下载带 sha256 校验与 .part 续传',
  /sha256/.test(localSrc) && /\.part/.test(localSrc),
);
check(
  'S5 不在本进程 require sherpa（必须走子进程）',
  !/require\([^)]*sherpa-onnx-node/.test(localSrc) && /spawn\(/.test(localSrc),
);

let workerSrc = '';
try { workerSrc = readFileSync(workerPath, 'utf8'); } catch { /* ignore */ }
check('S6 worker 是 CommonJS（.cjs）', workerPath.endsWith('.cjs'));
check('S7 worker 用 NDJSON 协议', /JSON\.stringify/.test(workerSrc) && /readline/.test(workerSrc));

const parsed = spawnSync(process.execPath, ['--check', workerPath], { encoding: 'utf8' });
check('S8 worker 语法可解析', parsed.status === 0, (parsed.stderr || '').slice(0, 160));

// manifest 形状：真机有就校验，没有就跳过
const manifestPath = join(homedir(), '.dsh-folia', 'asr', 'v1', 'manifest.json');
if (existsSync(manifestPath)) {
  const doc = JSON.parse(readFileSync(manifestPath, 'utf8'));
  check(
    'S9 manifest 有 files[] 且每条带 sha256/size',
    Array.isArray(doc.files) && doc.files.length > 0
      && doc.files.every((f) => f && typeof f.key === 'string' && typeof f.sha256 === 'string' && typeof f.size === 'number'),
    `${(doc.files || []).length} files`,
  );
}

// ── 真机（有运行时才跑）───────────────────────────────────────────────────────
const runtimeRoot = join(homedir(), '.dsh-folia', 'asr', 'v1');
const haveRuntime = existsSync(join(runtimeRoot, 'runtime', 'node.exe'))
  && existsSync(join(runtimeRoot, 'runtime', 'asr-worker.cjs'))
  && existsSync(join(runtimeRoot, 'models', 'sensevoice', 'tokens.txt'));

if (!haveRuntime) {
  console.log('— 真机档跳过：本机还没安装本地 STT 运行时（首次使用时自动下载）');
} else {
  const { startWorker } = await import('../lib/asr/asr-local.js');
  const wav = join(runtimeRoot, 'sample.wav');
  if (!existsSync(wav)) {
    console.log('— 真机档跳过：缺少 sample.wav（识别样本）');
  } else {
    const worker = startWorker(runtimeRoot);
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    try {
      const res = await worker.request(wav, 60000);
      check('R1 worker 返回 ok 且文本非空', !!(res && res.ok && String(res.text || '').trim().length > 0),
        `text=${String((res && res.text) || '').slice(0, 24)} · ms=${res && res.ms}`);
    } catch (error) {
      check('R1 worker 返回 ok 且文本非空', false, String((error && error.message) || error));
    } finally {
      worker.stop();
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exitCode = 1;
