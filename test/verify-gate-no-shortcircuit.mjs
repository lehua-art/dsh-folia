#!/usr/bin/env node
/**
 * verify-gate-no-shortcircuit.mjs —— **门禁不许被"已登记退役"的步骤短路**（4.23.21，P0-A）。
 *
 * ## 真实缺陷
 *
 * `npm run verify`（`test/run-guards.mjs verify`）是 `&&` 语义：任一步硬档非 0 ⇒ 整组立刻终止。
 * 而第 3 步 `test/verify-client.mjs` 断言的是**关于页四节**，关于页早已按需求清空 ⇒ 它**永久红**。
 * 于是后面 121 步（含 4.23.20 新增的 7 条判据）**一次都没跑过**。同一批守卫在
 * `test/tools/retired-tests.mjs` 里**早就登记为退役**（`run-audit` 对它们既不算绿也不算红）——
 * 两个入口给出两套结论，门禁看起来在、实际是死的。
 *
 * ## 修法与判据
 *
 * `run-guards.mjs` 现在**读退役登记表**，把已登记退役的步骤自动降为 `soft`（经 `warn-only`
 * 执行，原退出码照样打印，但不短路）。本守卫钉住三件事：
 *
 *   ① **数据面**：`--list-json` 里凡是退役的步骤，档位必须是 `soft`；同一条链里
 *      `verify-client.mjs`（P0-A 的直接受害者）必须带 `retired: true`；
 *   ② **有牙**：把"退役步骤却是 hard"的合成输入喂给**同一个判据函数** ⇒ 必须报红；
 *      反向喂一条**名字相近但未退役**的守卫（`verify-client-sync.mjs`）⇒ 必须**不报**
 *      （防判据退化成子串匹配、把整条链都当成退役）；
 *   ③ **行为面**：真起一次 `run-guards.mjs --selfcheck`（执行器自检，两个内联子进程）：
 *      · 软档红 ⇒ 第 2 步**仍然执行**（输出 `SELFCHECK-SOFT-STEP2-RAN`）；
 *      · 硬档红 ⇒ 第 2 步**不执行**（`SELFCHECK-HARD-STEP2-RAN` 必须不出现）、退出码 = 7。
 *      这一条证明「跑完全程」是执行器的真实语义，而不是把短路整段删掉。
 *
 * ③ 也是"新增守卫在本机路径下确实被执行"的机器判据：本文件自己必须在链上（见 ④），
 * 而链上不再有会永久红的硬档步骤（①），执行器又确实会跨过软档红（③）⇒ 排在后面的守卫
 * 一定被跑到。**"没跑"再也不会和"跑绿"长得一样。**
 *
 *   ④ 本守卫必须在 `verify` 链上且自己是硬档（否则它自己会被降档 / 脱链，判据变成摆设）。
 *
 * Usage:  node test/verify-gate-no-shortcircuit.mjs
 */

import { readFileSync, openSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { RETIRED_TESTS, isRetired } from './tools/retired-tests.mjs';
import { readChain, ROOT } from './tools/guard-chain.mjs';

const SELF = 'verify-gate-no-shortcircuit.mjs';

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail });
  console.log((cond ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
}

/**
 * 判据：一条链上**已登记退役却仍是硬档**的步骤。返回文件名数组（空 = 不参与硬短路）。
 * 正判据（真链）与负对照（合成链）走**同一个函数** —— 否则负对照证明的是另一段代码。
 *
 * @param {{ steps?: any[] }} chain
 * @param {Set<string>|Record<string, any>} retired 退役名集合（按 basename 精确匹配）
 */
function retiredHardSteps(chain, retired) {
  const names = retired instanceof Set ? retired : new Set(Object.keys(retired || {}));
  const out = [];
  for (const s of (chain && chain.steps) || []) {
    if (!s || !s.file || s.kind === 'npm') continue;
    if (!names.has(basename(s.file))) continue;
    if (s.tier !== 'soft') out.push(s.file);
  }
  return out;
}

const RETIRED_NAMES = new Set(Object.keys(RETIRED_TESTS));

/* ── ① 数据面：真链里退役项一律软档 ─────────────────────────────────────────── */
console.log('① 数据面 —— 退役项不参与硬短路');
const verify = readChain('verify');
const offenders = retiredHardSteps(verify, RETIRED_NAMES);
check('① verify 链上没有任何"已登记退役却仍是硬档"的步骤（P0-A：退役项不参与硬短路）',
  offenders.length === 0, offenders.length ? offenders.join(', ') : '0 条');

const retiredSteps = (verify.steps || []).filter((s) => s.file && RETIRED_NAMES.has(basename(s.file)));
check('① 降档机制真的在起作用（链上退役步骤 > 0；否则本判据是空真）',
  retiredSteps.length > 0, retiredSteps.length + ' 条退役步骤');
check('① 退役步骤在 --list-json 里都带 retired:true（降档来自登记表，不是手写档位）',
  retiredSteps.length > 0 && retiredSteps.every((s) => s.retired === true),
  retiredSteps.filter((s) => s.retired !== true).map((s) => s.file).join(', ') || '全部带标记');

// P0-A 的直接受害者：第 3 步 verify-client.mjs。它必须**在链上、且是退役软档** ——
// 若它被删掉（而不是降档），那么"关于页四节"这条判据就彻底消失了，本守卫也要红。
const victim = (verify.steps || []).find((s) => s.file === 'test/verify-client.mjs');
check('① P0-A 受害者 verify-client.mjs 仍在链上，且已按登记表降为软档',
  Boolean(victim) && victim.tier === 'soft' && victim.retired === true,
  victim ? 'index=' + victim.index + ' tier=' + victim.tier + ' retired=' + victim.retired : '不在链上');

/* ── ② 有牙：同一个判据函数吃合成输入 ───────────────────────────────────────── */
console.log('② 负对照 —— 判据有牙且不会误伤');
{
  const hardRetired = {
    steps: [
      { kind: 'guard', file: 'test/verify-client.mjs', tier: 'hard', args: [], probe: false },
      { kind: 'guard', file: 'test/verify-client-sync.mjs', tier: 'hard', args: [], probe: false },
    ],
  };
  const bad = retiredHardSteps(hardRetired, RETIRED_NAMES);
  check('② 负对照：退役步骤却是 hard ⇒ 同一判据必须报红（并只报那一条）',
    bad.length === 1 && bad[0] === 'test/verify-client.mjs', JSON.stringify(bad));
  check('② 反面对照：名字相近但未退役的 verify-client-sync.mjs 仍是 hard ⇒ 不许被误报',
    !bad.includes('test/verify-client-sync.mjs'));
  check('② 反面对照：同一条退役步骤降为 soft ⇒ 判据放行（不是恒红）',
    retiredHardSteps({ steps: [{ ...hardRetired.steps[0], tier: 'soft' }] }, RETIRED_NAMES).length === 0);
  check('② 判据用 basename 精确匹配（isRetired 对 verify-client.mjs 为 true、对 ...-sync 为 false）',
    isRetired('verify-client.mjs') === true && isRetired('verify-client-sync.mjs') === false);
}

/* ── ③ 行为面：执行器自检（软档红不短路 / 硬档红仍短路）─────────────────────── */
console.log('③ 行为面 —— run-guards --selfcheck');
{
  const dir = mkdtempSync(join(tmpdir(), 'gate-selfcheck-'));
  const outFile = join(dir, 'out.txt');
  try {
    // stdout 落文件（不用管道）：与 test/tools/guard-chain.mjs 的 readChain 同一姿势，
    // 避免沙箱对子进程管道的限制把"环境起不了"误报成"门禁坏了"。
    const fd = openSync(outFile, 'w');
    let status = null;
    let err = null;
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'test', 'run-guards.mjs'), '--selfcheck'], {
        cwd: ROOT, stdio: ['ignore', fd, 'inherit'],
      });
      status = r.status;
      err = r.error || null;
    } finally {
      closeSync(fd);
    }
    const out = readFileSync(outFile, 'utf8');
    check('③ 执行器自检可运行且退出码 0', status === 0, 'status=' + status + (err ? ' err=' + err.message : ''));
    check('③ 软档红**不短路**：自检 A 的第 2 步真的被执行（SELFCHECK-SOFT-STEP2-RAN）',
      out.includes('SELFCHECK-SOFT-STEP2-RAN'));
    check('③ 硬档红**仍短路**：自检 B 的第 2 步没有执行（SELFCHECK-HARD-STEP2-RAN 必须缺席）',
      !out.includes('SELFCHECK-HARD-STEP2-RAN'));
    check('③ 两个场景都被点名通过（自检自己报 A / B 各一条 ✓）',
      out.includes('✓ selfcheck A') && out.includes('✓ selfcheck B'));
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ── ④ 本守卫自己在链上且是硬档 ────────────────────────────────────────────── */
console.log('④ 自检 —— 本守卫必须真的挂在门禁上');
{
  const me = (verify.steps || []).find((s) => s.file === 'test/' + SELF);
  check('④ 本守卫在 verify 链上', Boolean(me), me ? 'index=' + me.index : '不在链上');
  check('④ 本守卫是硬档（不会被退役降档，也不会只出声）',
    Boolean(me) && me.tier === 'hard' && me.retired === false,
    me ? 'tier=' + me.tier + ' retired=' + me.retired : '-');
  check('④ 本守卫之前没有任何"永久红"的硬档步骤（退役项全部已降档 ⇒ 一定会被执行）',
    retiredHardSteps({ steps: (verify.steps || []).filter((s) => Number(s.index) <= Number(me && me.index)) },
      RETIRED_NAMES).length === 0);
}

/* ── 汇总 ─────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) if (!r.ok) failed++;
process.stdout.write('\n    ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) {
  console.log('GATE NO-SHORTCIRCUIT CHECKS FAILED — ' + failed + ' failed');
  process.exit(1);
}
console.log('GATE NO-SHORTCIRCUIT CHECKS PASSED');
process.exit(0);
