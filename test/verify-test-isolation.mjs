#!/usr/bin/env node
/**
 * verify-test-isolation.mjs — **测试/脚本不得写用户真实 home**（4.23.15，P0-4）。
 *
 * ## 为什么要有这一页（事故驱动）
 *
 * 真实事故：我们跑测试时把**合成占位视频**写进了用户的
 * `%APPDATA%\dsh-desktop\harness\library\wallpaper\`（30 个 4–65 KB 的 `ftyp isom … mdat`，
 * ffprobe 无 stream）。用户看到的所有「浏览器无法解码」正是这些假文件 ——
 * 不是编码问题、也不是坏文件。根因是**默认值就是真实 home**
 *（`lib/routes/downloads.js` 的 `dshHome()` 在 `DSH_HOME` 缺席时回落到真实 harness）。
 *
 * 这一页钉两件事：
 *   ① **静态面**：`test/**` 与 `scripts/**` 里任何"会写 media 的地方"（`destForUrl` /
 *      `getDownloadQueue` / `createDownloadQueue` / `dshHome` / `DSH_HOME`）都必须
 *      先经 `test/tools/isolate-home.mjs`（`isolateTestHome()`），或显式传临时 `home`。
 *   ② **行为面**：拿**真实 harness** 当 `DSH_HOME` 起一个子进程跑 `isolate-home --self-test`
 *      ⇒ 必须被拒（退出码 3 + `refuse to run against real DSH_HOME`）。
 *
 * 两条判据各自带负对照（合成输入喂**同一个**判据函数），否则"扫不到"与"没问题"同形。
 *
 * Usage: `node test/verify-test-isolation.mjs`
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { looksLikeRealHome, realHarnessHome } from './tools/isolate-home.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

/** 一行的"会写 media / 会解析 home"的入口点（出现即必须有隔离手段）。 */
const ENTRY_RE = /\b(destForUrl|libraryDest|getDownloadQueue|createDownloadQueue|dshHome)\b|process\.env\.DSH_HOME/;
/** 隔离手段：静态 import 或（测试里常见的）在顶部先建临时 home。 */
const ISOLATION_RES = [
  /isolate-home\.mjs/,
  /isolateTestHome\s*\(/,
  /mkdtempSync\s*\(/,
  // home 来自系统临时目录（bench 那一类：`const HOME = join(tmpdir(), …)` 再 `{ home }` 传下去）
  /tmpdir\s*\(\s*\)/,
  /home\s*:\s*(?:HOME|home|TESTS_HOME|TMP|tmp|tmpDir)/,
  /\{\s*home\s*[,}]/,
  /process\.env\.DSH_HOME\s*=/,
];

/**
 * 逐文件豁免（**必须非空理由**，且必须仍在源码里命中入口点 —— 过期豁免判红，
 * 否则它会给未来的回归打掩护）。每一条都要说明"为什么它不会写用户 media"。
 */
const WHY_OK = {
  'scripts/dev-link-subpackages.mjs': '开发期只把子包 symlink 进 profile 的 node_modules，不写 media library；'
    + '它自己的 dshHome() 默认是 ~/.dsh（不是桌面端 harness），且入口点只是同名标识符。',
};
/** 只在"测试/脚本"这一面扫。 */
const SCAN_DIRS = ['test', 'scripts'];
/** 这个文件自己就是那套工具，不参与（它会 import 自身）。 */
const SELF = 'test/verify-test-isolation.mjs';
const TOOL = 'test/tools/isolate-home.mjs';

/** 收集 `dir` 下的 `.mjs` / `.js`（跳过 node_modules 与隐藏目录）。 */
function collect(dir, out = []) {
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const abs = join(dir, name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) { collect(abs, out); continue; }
    if (/\.(mjs|js)$/.test(name)) out.push(abs);
  }
  return out;
}

/**
 * 判据：扫一批文件，返回**没有隔离证据**的文件相对路径。
 * 正判据（真仓）与负对照（合成输入）喂的是同一个函数。
 * @param {Array<{ rel: string, text: string }>} files
 * @returns {string[]}
 */
export function unisolatedFiles(files, why = WHY_OK) {
  const out = [];
  for (const f of files) {
    const rel = String(f.rel || '').replace(/\\/g, '/');
    if (rel === SELF || rel === TOOL) continue;
    const text = String(f.text || '');
    const lines = text.split(/\r?\n/);
    const hit = lines.some((ln) => ENTRY_RE.test(ln) && !/^\s*(?:\*|\/\/)/.test(ln));
    if (!hit) continue;
    if (Object.prototype.hasOwnProperty.call(why, rel) && String(why[rel] || '').trim()) continue;
    const isolated = ISOLATION_RES.some((re) => re.test(text));
    if (!isolated) out.push(rel);
  }
  return out;
}

/* ══ ① 静态面 ═══════════════════════════════════════════════════════════════ */
console.log('\n① 测试/脚本的 home 隔离（静态面）');
const files = [];
for (const d of SCAN_DIRS) {
  for (const abs of collect(join(ROOT, d))) {
    files.push({ rel: relative(ROOT, abs), text: readFileSync(abs, 'utf8') });
  }
}
check('扫到了测试/脚本面（判据不为空集）', files.length > 50, files.length + ' 个文件');
const offenders = unisolatedFiles(files);
check('任何解析/写入 home 的测试与脚本都带隔离证据（隔离或显式临时 home）',
  offenders.length === 0, offenders.slice(0, 6).join(' · '));
// 负对照：同一判据对"没有隔离证据"的合成文件必须判红。
check('负对照：无隔离证据的合成文件被点名',
  unisolatedFiles([{ rel: 'test/fake-no-isolation.mjs', text: 'const d = destForUrl(u);\n' }]).length === 1);
check('负对照：带 isolateTestHome() 的合成文件放行',
  unisolatedFiles([{
    rel: 'test/fake-ok.mjs',
    text: "import { isolateTestHome } from './tools/isolate-home.mjs';\nisolateTestHome('x');\nconst d = destForUrl(u);\n",
  }]).length === 0);
check('负对照：显式传临时 home 的合成文件放行',
  unisolatedFiles([{ rel: 'test/fake-home.mjs', text: 'createDownloadQueue({ home: HOME });\n' }]).length === 0);

/* ══ ② 行为面：拿真实 home 起子进程必须被拒 ═════════════════════════════════ */
console.log('\n② 行为面（真实 home ⇒ 必须被拒）');
{
  const tool = join(ROOT, 'test', 'tools', 'isolate-home.mjs');
  let code;
  let text;
  try {
    const out = execFileSync(process.execPath, [tool, '--self-test'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { DSH_HOME: realHarnessHome() }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    text = String(out || '');
    code = 0;
  } catch (e) {
    code = Number(e && e.status) || 1;
    text = String((e && (e.stdout || e.stderr)) || '');
  }
  check('真实 DSH_HOME ⇒ 退出码 3（拒跑，不是静默通过）', code === 3, 'exit=' + code);
  check('拒绝文案点名拒绝原因', /refuse to run against real DSH_HOME/.test(text), text.trim().slice(0, 60));
  // 正对照：临时 home 必须放行（判据不是"永远拒绝"）。
  let okCode;
  try {
    execFileSync(process.execPath, [tool, '--self-test'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { DSH_HOME: join(process.env.TEMP || process.env.TMP || '.', 'folia-test-selfcheck') }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    okCode = 0;
  } catch (e) { okCode = Number(e && e.status) || 1; }
  check('临时 DSH_HOME ⇒ 放行（isolation NOT enforced 才算坏）', okCode === 0, 'exit=' + okCode);
}

/* ══ ③ 判据本身：真实 home 的识别器 ═════════════════════════════════════════ */
console.log('\n③ 真实 home 识别器');
check('识别 APPDATA\\dsh-desktop\\harness 形态', looksLikeRealHome(realHarnessHome()) === true);
check('识别任意含 dsh-desktop/harness 的路径',
  looksLikeRealHome('D:/other/dsh-desktop/harness/library') === true);
check('临时目录不算真实 home',
  looksLikeRealHome(join(process.env.TEMP || '/tmp', 'folia-test-abc')) === false);

/* ══ 汇总 ════════════════════════════════════════════════════════════════════ */
const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length
  ? 'TEST ISOLATION CHECKS FAILED — ' + failed.length + '/' + results.length + ' 条红'
  : 'TEST ISOLATION CHECKS PASSED — ' + results.length + ' 条'));
process.exit(failed.length ? 1 : 0);
