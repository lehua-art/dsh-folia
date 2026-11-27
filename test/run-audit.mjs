/**
 * run-audit.mjs — **全仓审计**：把 `test/*.mjs` 逐个真跑一遍，分成三档。
 *
 * 为什么要单独一个入口：`test/run-guards.mjs verify` 是**门禁**（硬档，短路），它回答的是
 * "能不能发版"；而"这个仓现在整体健康到什么程度"需要一个**不短路**的全量视图。
 * 过去这件事靠我临时敲一段 PowerShell 循环，结果每次都埋在噪音里 —— 于是有了这个脚本。
 *
 * 三档：
 *   PASS     退出码 0
 *   RETIRED  在 test/tools/retired-tests.mjs 里登记过（断言的结构已不存在 / 需要真宿主），
 *            打印理由与接管者，**既不算绿也不算红**
 *   FAIL     真红 —— 只有这一档需要修
 *
 * 用法：
 *   node test/run-audit.mjs            # 全量
 *   node test/run-audit.mjs --only-retired
 *   node test/run-audit.mjs --quiet    # 只打印汇总与 FAIL 清单
 */
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETIRED_TESTS, isRetired } from './tools/retired-tests.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUIET = process.argv.includes('--quiet');
const ONLY_RETIRED = process.argv.includes('--only-retired');
/**
 * 子进程输出走**文件**而不是管道：Windows 上 `verify-glass-runtime-browser` 会拉起
 * Chromium，浏览器子进程会继承父进程的 stdout 管道句柄 —— spawnSync 等到管道 EOF
 * 才返回，于是整个 audit 挂死（本机实测 30 分钟不返回）。写文件后只看退出码，
 * 既没有管道等待，也不丢失败详情。
 */
const LOG_DIR = join(tmpdir(), 'folia-audit-logs');
mkdirSync(LOG_DIR, { recursive: true });

const SKIP = new Set(['run-guards.mjs', 'run-audit.mjs', 'warn-only.mjs']);
const files = readdirSync(join(ROOT, 'test'))
  .filter((n) => n.endsWith('.mjs') && !SKIP.has(n))
  .sort();

const pass = [];
const retired = [];
const fail = [];
const failDetail = new Map();

for (const file of files) {
  const known = isRetired(file);
  if (ONLY_RETIRED && !known) continue;
  const outPath = join(LOG_DIR, file + '.out.log');
  const errPath = join(LOG_DIR, file + '.err.log');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const run = spawnSync(process.execPath, [join(ROOT, 'test', file)], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000, stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  const ok = run.status === 0;
  if (ok) { pass.push(file); try { rmSync(outPath, { force: true }); rmSync(errPath, { force: true }); } catch { /* ignore */ } continue; }
  if (known) { retired.push(file); continue; }
  fail.push(file);
  let out = '';
  try { out = readFileSync(outPath, 'utf8') + '\n' + readFileSync(errPath, 'utf8'); } catch { out = ''; }
  const line = out.split('\n').find((l) => l.includes('✗') || l.includes('Error:')) || '';
  failDetail.set(file, line.trim().slice(0, 160));
}

if (!QUIET) {
  if (retired.length) {
    process.stdout.write('\n  ── 已登记退役（不参与红绿）──\n');
    for (const f of retired) {
      const why = RETIRED_TESTS[f] || {};
      process.stdout.write('    ○ ' + f + '\n       理由: ' + (why.why || '(无)') + '\n');
      if (why.replacedBy) process.stdout.write('       接管: ' + why.replacedBy + '\n');
    }
  }
}

process.stdout.write('\n  ── 汇总 ──\n');
process.stdout.write('  通过 ' + pass.length + ' · 退役 ' + retired.length + ' · 失败 ' + fail.length +
  ' · 合计 ' + (pass.length + retired.length + fail.length) + '\n');
if (fail.length) {
  process.stdout.write('\n  真红清单:\n');
  for (const f of fail) process.stdout.write('    ✗ ' + f + (failDetail.get(f) ? ' — ' + failDetail.get(f) : '') + '\n');
}
process.stdout.write('\n');
process.exit(fail.length ? 1 : 0);
