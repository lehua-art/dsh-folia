/**
 * verify-stall-heal.mjs — pre.46：卡片卡在「解压/落位中…」的自愈回归。
 *
 * 真实故障（用户实测）：下载 job 已经 `done`，但宿主的内存收尾（`scheduleFinishInstall()`）在
 * 重启后消失 ⇒ 文件没落位、`installed=false`，卡片只能等 90 秒后变红；开机动画/皮肤页签
 * 都只自动补一次收尾，第二次失败就放弃。
 *
 * 本守卫按「面板挂载后用户看到什么」组织：
 *   ① 挑选面：只补 `job=done && 本机未落地` 的卡片（已落地 / 还在下 ⇒ 一条请求都不发）；
 *   ② 退避重试：0s → 3s → 8s 三次；第一次失败、第二次成功 ⇒ 最终 onOk，不写失败；
 *      三次都失败 ⇒ onFail 只一次，带宿主错误码（卡片据此红字 +「重试」）；
 *   ③ 卡片态：自愈期间是 `healing`「正在补收尾… 第 a/t 次」，**不是** `installing`「解压/落位中…」；
 *      失败后是 `failed`（原因 + 可点重试）；
 *   ④ 接线：boot / skin 面板挂载时都传 `attempts: 3, backoff: [3000, 8000]`，并调
 *      `cards.heal / healOk / healFail`（成功就地变 done、清历史错误）。
 *
 * 取的是 `src/local-first.js` 的**真源码切片**（与 verify-install-flow / verify-downloads 同一口径），
 * 网络/定时器全部注入，所以判据不依赖真实下载或 React。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SRC = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
const bootTab = readFileSync(join(ROOT, 'src', 'panel-tabs-boot.js'), 'utf8');
const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');

/* ── 取真源码切片（纯函数段；与既有守卫同一口径）──────────────────────────── */
function loadClient(post) {
  const a = SRC.indexOf('const DL_POLL_MS = 1500;');
  const b = SRC.indexOf('function useDownloadJobs(');
  if (a < 0 || b <= a) return null;
  const slice = SRC.slice(a, b);
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g,
    (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  try {
    return new Function('weT', 'apiPostJson', slice + `
return { DL_PHASES, DL_INSTALL_STALL_MS, dlCardState, dlFailReason, dlHealStuck, dlHealTargets, dlHealOnce };`)(
      shim,
      post || (async () => ({ ok: true, status: 200, data: { ok: true } })),
    );
  } catch {
    return null;
  }
}

const mod = loadClient();
check('① src/local-first.js 的纯函数段能取出并运行（切片/编译失败 = 判据无从谈起）', Boolean(mod),
  mod ? 'ok' : 'slice 失败');

if (mod) {
  const labels = { idle: '安装', done: '已安装', failed: '重试' };
  const now = Date.now();
  const st = (o) => mod.dlCardState(Object.assign({
    id: 'c1', labels, nowMs: now,
    job: { id: 'j1', status: 'done' },
    installStallMs: 90000,
  }, o || {}));

  /* ── ① 挑选面 ───────────────────────────────────────────────────────── */
  {
    const jobs = [
      { id: 'j-done', url: 'u-done', kind: 'boot', status: 'done' },
      { id: 'j-run', url: 'u-run', kind: 'boot', status: 'running' },
    ];
    const items = [
      { id: 'a', url: 'u-done', installed: false },
      { id: 'b', url: 'u-done', installed: true },
      { id: 'c', url: 'u-run', installed: false },
    ];
    const picked = mod.dlHealTargets(jobs, 'boot', items, (it) => Boolean(it.installed));
    check('① 只挑「job=done 且本机未落地」的卡片（已落地 / 还在下都不碰）',
      picked.length === 1 && picked[0].id === 'a', JSON.stringify(picked.map((x) => x.id)));
  }

  /* ── ② 退避重试：第一次失败、第二次成功 → 最终 ok ─────────────────────── */
  {
    const events = [];
    const waits = [];
    let calls = 0;
    const c = loadClient(
      async () => {
        calls += 1;
        if (calls < 3) return { ok: false, status: 500, data: { ok: false, error: 'extract-failed' } };
        return { ok: true, status: 200, data: { ok: true } };
      },
    );
    const out = await c.dlHealStuck({
      kind: 'boot',
      jobs: [{ id: 'j', url: 'u', kind: 'boot', status: 'done' }],
      items: [{ id: 'a', url: 'u' }],
      doneOf: () => false,
      path: '/boot/download',
      body: (it) => ({ id: it.id }),
      attempts: 3,
      backoff: [3000, 8000],
      sleep: async (ms) => { waits.push(ms); },
      onTry: (it, attempt, total) => events.push('try:' + attempt + '/' + total),
      onOk: () => events.push('ok'),
      onFail: (it, code) => events.push('fail:' + code),
    });
    check('② 第一次失败、第二次失败、第三次成功 ⇒ 正好 3 次请求，最终 onOk（不写失败）',
      calls === 3 && out.length === 1 && events.includes('ok') && !events.some((e) => e.startsWith('fail')),
      JSON.stringify({ calls, events }));
    check('② 退避按 3000 / 8000 走，且重试前有 try:2/3、try:3/3（用户看得见第几次）',
      eq(waits, [3000, 8000]) && events.includes('try:2/3') && events.includes('try:3/3'),
      JSON.stringify({ waits, events }));
  }

  /* ── ② 三次都失败 → onFail 只一次、带宿主错误码 ─────────────────────────── */
  {
    let calls = 0;
    const fails = [];
    const c = loadClient(async () => {
      calls += 1;
      return { ok: false, status: 422, data: { ok: false, error: 'no-skin-json' } };
    });
    const out = await c.dlHealStuck({
      kind: 'skin',
      jobs: [{ id: 'j', url: 'u', kind: 'skin', status: 'done' }],
      items: [{ id: 'a', url: 'u' }],
      doneOf: () => false,
      path: '/skins/install',
      attempts: 3,
      backoff: [0, 0],
      onFail: (it, code) => fails.push(code),
      onOk: () => { throw new Error('不该走 onOk'); },
    });
    check('② 三次都失败 ⇒ onFail 只一次，带宿主给的错误码（不是裸 failed）',
      calls === 3 && out.length === 1 && eq(fails, ['no-skin-json']),
      JSON.stringify({ calls, fails }));
  }

  /* ── ③ 卡片态：healing 不是 installing；失败才 failed ─────────────────── */
  {
    const healing = st({ heal: { id: 'c1', attempt: 2, total: 3 }, installingSince: now - 120000 });
    check('③ 自愈中 ⇒ phase=healing、label=正在补收尾…、明细带第 2/3 次（不是「解压/落位中…」）',
      healing.phase === 'healing' && healing.label === '正在补收尾…'
        && healing.detail.includes('第 2/3 次') && healing.disabled === true && healing.retry === false,
      JSON.stringify(healing));
    check('③ 负对照：没有 heal 输入且已过 90s ⇒ 才轮到 installing/failed 的旧路径（新状态不是恒真）',
      st({ installingSince: now - 1000 }).phase === 'installing'
        && st({ installingSince: now - 120000 }).phase === 'failed',
      `within=${st({ installingSince: now - 1000 }).phase} over=${st({ installingSince: now - 120000 }).phase}`);
    const failed = st({ err: { code: 'no-skin-json' } });
    check('③ 自愈失败写回 err ⇒ failed + 原因 + 可点「重试」',
      failed.phase === 'failed' && failed.retry === true
        && failed.reason.includes('skin.json') && failed.label === '重试',
      JSON.stringify(failed));
  }

  /* ── ④ 面板接线：3 次退避 + heal/healOk/healFail ─────────────────────────── */
  {
    const both = (re) => re.test(bootTab) && re.test(skinsTab);
    check('④ boot / skin 挂载自愈都传 attempts:3 + backoff:[3000,8000]',
      both(/attempts:\s*3/) && both(/backoff:\s*\[\s*3000\s*,\s*8000\s*\]/));
    check('④ 两个页签都调 cards.heal / healOk / healFail（进行中/成功/失败三态都落到卡片）',
      both(/cards\.heal\(/) && both(/cards\.healOk\(/) && both(/cards\.healFail\(/));
    check('④ 两个页签挂载时都调用统一执行体 dlHealStuck（不是各写一套）',
      both(/dlHealStuck\(\{/) && (SRC.match(/function dlHealStuck\(/g) || []).length === 1);
    check('④ 卡片状态层真的暴露 heal 入口（不是只改文案）',
      /HEALING:\s*"healing"/.test(SRC)
        && /heal:\s*\(id,\s*attempt,\s*total\)/.test(SRC)
        && /healOk:\s*\(id\)/.test(SRC)
        && /healFail:\s*\(id,\s*code\)/.test(SRC)
        && /heal:\s*api\.healOf\(x\.id\)/.test(SRC));
  }
}

let failed = 0;
for (const item of results) if (!item.ok) failed += 1;
console.log(`\n  ${results.length - failed} 通过 / ${failed} 失败`);
if (failed) process.exit(1);
