#!/usr/bin/env node
/**
 * isolate-home.mjs — **测试/脚本的 home 隔离**（4.23.15，事故驱动）。
 *
 * ══ 为什么要有它 ══════════════════════════════════════════════════════════════
 * 真实事故：跑测试/脚本时把**合成占位视频**写进了用户的真实
 * `%APPDATA%\dsh-desktop\harness\library\wallpaper\`（30 个 4–65 KB 的
 * `ftyp isom … mdat` 文件，ffprobe 认不出任何 stream）。用户看到的所有
 * 「浏览器无法解码」正是这些假文件 —— 不是编码问题。
 *
 * 根因不是某一处忘了清理，而是**默认值就是真实 home**：`lib/routes/downloads.js` 的
 * `dshHome()` 在 `DSH_HOME` 缺席时回落到 `%APPDATA%\dsh-desktop\harness`。任何
 * "顺手 import 了 `destForUrl` / `getDownloadQueue`" 的测试都会往真实库里写。
 *
 * 所以这里只做一件事、而且做成**必答题**：把 home 钉到一个全新的临时目录，
 * 并且在"解析出来的 home 仍然是真实 harness"时**直接抛错**。
 *
 * 用法（模块顶部、任何 lib 模块被使用之前）：
 *   import { isolateTestHome } from './tools/isolate-home.mjs';
 *   const HOME = isolateTestHome('my-test');
 *
 * 命令行自检（守卫用它证明"用真实 home 启动会被拒"）：
 *   DSH_HOME=<真实 harness> node test/tools/isolate-home.mjs --self-test
 *   ⇒ 退出码 3 + 一行 'refuse to run against real DSH_HOME'
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 真实 harness 目录（Windows 桌面端形态；其它平台据此拼）——**只用来识别，不写**。 */
export function realHarnessHome() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'dsh-desktop', 'harness');
}

/**
 * 这个路径像不像"用户真实 home"。
 *
 * 判据故意宽（两条任一命中就算真实）：`<APPDATA>/dsh-desktop/harness` 本身、
 * 以及任何包含 `dsh-desktop\harness`（或正斜杠形态）的路径 —— 换机器/改盘符都逃不掉。
 * 判错的代价只是"测试报错要求你给临时目录"，而漏判的代价是**污染用户的壁纸库**。
 * @param {string} p
 * @returns {boolean}
 */
export function looksLikeRealHome(p) {
  const s = String(p || '');
  if (!s) return false;
  const norm = resolve(s).replace(/\\/g, '/').toLowerCase();
  const real = resolve(realHarnessHome()).replace(/\\/g, '/').toLowerCase();
  if (norm === real) return true;
  return norm.includes('dsh-desktop/harness');
}

/**
 * 把 `DSH_HOME` 钉到一个**全新临时目录**并返回它。
 *
 * 两点硬要求：
 *   · **先判后设**：调用前 `DSH_HOME` 若已经是真实 harness ⇒ 默认**直接抛**
 *     （"反正我马上改"是危险的想法：调用点之前可能已经有模块读走了它）；
 *   · 只在 `DSH_HOME` 从未设置时才由这里决定，**已经指向临时目录的就原样保留**
 *     （嵌套调用不会把外层刚建好的目录换掉，否则两次 mkdtemp = 两份半成品）。
 *
 * `opts.force = true` ⇒ **重定位而不是拒绝**：桌面端宿主自己的 shell 里 `DSH_HOME`
 * 本来就指向真实 harness，若一律拒绝，门禁在这个最常见的环境里根本跑不起来
 * （"跑不起来"比"跑起来但写临时目录"更糟）。重定位与拒绝**同样安全**：
 * 目标永远是 `%TEMP%\folia-test-*`，真实 home 一个字节都不会被碰。
 *
 * @param {string} label 便于定位（会进目录名）
 * @param {{ force?: boolean }} [opts]
 * @returns {string} 临时 home 的绝对路径
 */
export function isolateTestHome(label, opts) {
  const o = opts || {};
  const cur = String(process.env.DSH_HOME || '');
  if (cur && looksLikeRealHome(cur)) {
    if (!o.force) {
      throw new Error('refuse to run against real DSH_HOME: ' + cur
        + '（测试/脚本一律用临时 home；见 test/tools/isolate-home.mjs）');
    }
    process.stdout.write('[isolate-home] DSH_HOME 指向真实 harness ⇒ 重定位到临时目录（不写真实 home）\n');
    process.env.DSH_HOME = '';
  }
  const now = String(process.env.DSH_HOME || '');
  if (now) return now;
  const safe = String(label || 'test').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 24);
  const dir = mkdtempSync(join(tmpdir(), 'folia-test-' + safe + '-'));
  process.env.DSH_HOME = dir;
  return dir;
}

/** 结束清理（**只删自己建的**：前缀对不上就不动，绝不 rm 一个来路不明的目录）。 */
export function cleanupTestHome(dir) {
  const s = String(dir || '');
  if (!s) return;
  if (!/[\\/]folia-test-/.test(s)) return;
  try { rmSync(s, { recursive: true, force: true }); } catch { /* 占用中就留给系统临时目录 */ }
}

/** CLI 自检：用**真实** home 启动必须被拒（守卫据此判"隔离真的生效"）。 */
function main() {
  if (!process.argv.includes('--self-test')) {
    process.stdout.write('usage: node test/tools/isolate-home.mjs --self-test\n');
    return 0;
  }
  try {
    const home = isolateTestHome('self-test');
    // 没抛 ⇒ 当前 home 是安全的（临时目录 / 未设置）。这本身就是"隔离生效"的证据。
    process.stdout.write('isolated ok: ' + home + '\n');
    return 0;
  } catch {
    process.stdout.write('refuse to run against real DSH_HOME\n');
    return 3;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(main());
