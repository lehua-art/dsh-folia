#!/usr/bin/env node
/**
 * verify-queue-priority.mjs — **队列优先级 / 启动限流 / 队列运维 / 旧 job 迁移**（4.23.18）。
 *
 * ## 守的是什么（用户实测原文）
 *
 *   「标题栏显示『排队中：前面还有 50 个任务』，当前正在看的壁纸被排在 31+ 个 low 之后。」
 *
 * 定因两条（本判据按它们组织）：
 *   ① 4.23.17 的「done 但成品缺失 ⇒ 重置为 queued」在启动时把**所有**非 done 记录折成
 *      queued 一起 pump ⇒ 清理过 library 后重启一次多出 31+ 个 low；
 *   ② 当前在播那张仍是 low（点击路径给的是 low），标题栏又从**全局** queuePos 算 N
 *      （把 skin / 其它优先级档也算进来）。
 *
 * ## 判据（每条都配负对照 / 真实行为）
 *
 *   A. `queueAheadOf()`（纯函数、假队列）：只数**同 kind + 同优先级档**，跨 kind 不串号；
 *   B. 启动 30 条 done-但缺失 ⇒ 全 `pending`、`queuedCount=0`（不 pump、不占队列位）；
 *   C. 点击某张 ⇒ `priority=high`、`queuePos=1`、`queuedAhead=0`；在播保持 high 直到 done；
 *   D. 预取最多 2 个且 low（源码 + 行为）；
 *   E. 「前面还有 N 个」= `queuedAhead`（0 基）且与假队列顺序一致（含跨 kind）；
 *   F. 「清空未开始队列」把 queued→pending，不动 running / done / failed；
 *   G. 暂停全部：不再取任务 / 正在跑的回到 queued / 恢复后能下完；
 *   H. 升级迁移：4.23.16 形态坏 job（变体 URL + 原画 sha + expectBytes=0）⇒ 加载后
 *      `expectSha=变体 sha`、重置 queued、**能正常 done**；幂等；清单不可达时跳过不崩；
 *      另有**源码变异负对照**（删掉迁移调用 ⇒ 同一条断言必须红）。
 *
 * 隔离 home（`%TEMP%\folia-test-*`）：本判据会真建临时队列/临时 http 源，绝不碰用户库。
 * Usage: `node test/verify-queue-priority.mjs`
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createDownloadQueue, queueAheadOf, compareQueueOrder,
} from '../lib/download-queue.js';
import { resolveJobExpectationFromItems } from '../lib/variant-pick.js';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = isolateTestHome('queue-priority', { force: true });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 起一个本地假上游（可延迟响应；忽略 Range ⇒ 续传会走"200 全量重下"，仍然正确）。 */
async function serveBytes(body, delayMs = 0) {
  const hits = { count: 0, ranges: [] };
  const srv = createServer((req, res) => {
    hits.count += 1;
    hits.ranges.push(String(req.headers.range || ''));
    const send = () => {
      try {
        res.statusCode = 200;
        res.setHeader('content-type', 'video/mp4');
        res.setHeader('accept-ranges', 'bytes');
        res.setHeader('etag', '"verify-queue-priority"');
        res.setHeader('content-length', String(body.length));
        res.end(body);
      } catch { /* 被 abort 的连接 */ }
    };
    if (delayMs > 0) setTimeout(send, delayMs); else send();
  });
  await new Promise((ok) => { srv.listen(0, '127.0.0.1', ok); });
  return {
    origin: 'http://127.0.0.1:' + srv.address().port,
    hits,
    close: () => { try { srv.close(); } catch { /* ignore */ } },
  };
}

/** 等一个条件（超时返回 false，绝不无限挂）。 */
async function waitFor(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (fn()) return true; } catch { /* 条件探测失败当作未满足 */ }
    await sleep(30);
  }
  return false;
}

const dirs = [];
function freshDir(label) {
  const d = mkdtempSync(join(tmpdir(), 'folia-qp-' + label + '-'));
  dirs.push(d);
  return d;
}

try {
  /* ══ A. 纯函数：同 kind + 同优先级档的真实顺序；跨 kind 不串号 ═════════════ */
  console.log('\nA. queueAheadOf：同 kind + 同优先级档，0 基，跨 kind 不串号');
  {
    const fake = [
      // 壁纸 low：w4 最早（at=10）⇒ 它前面没人；w1 前面有 w4；w2 最后。
      { id: 'w4', kind: 'wallpaper', priority: 'low', status: 'queued', at: 10, seq: 4 },
      { id: 'w1', kind: 'wallpaper', priority: 'low', status: 'queued', at: 100, seq: 1 },
      { id: 'w2', kind: 'wallpaper', priority: 'low', status: 'queued', at: 200, seq: 2 },
      // 皮肤 low：at 更早，但 kind 不同 ⇒ 不许算进壁纸的 N。
      { id: 's1', kind: 'skin', priority: 'low', status: 'queued', at: 1, seq: 3 },
      // 壁纸 high：优先级档不同 ⇒ 也不许算进 low 的 N。
      { id: 'wh', kind: 'wallpaper', priority: 'high', status: 'queued', at: 5, seq: 5 },
      // 已结束的 job 不参与排队。
      { id: 'wdone', kind: 'wallpaper', priority: 'low', status: 'done', at: 0, seq: 0 },
    ];
    check('A1 壁纸 low 的 N：只数同 kind + 同档（w4 前面 0、w1 前面 1、w2 前面 2）',
      queueAheadOf(fake, 'w4') === 0 && queueAheadOf(fake, 'w1') === 1 && queueAheadOf(fake, 'w2') === 2,
      ['w4', 'w1', 'w2'].map((id) => id + '=' + queueAheadOf(fake, id)).join(','));
    check('A2 跨 kind 不串号：皮肤 s1 的 at 更早，但**不**让壁纸 w4 的 N 变成 1',
      queueAheadOf(fake, 'w4') === 0, 'w4=' + queueAheadOf(fake, 'w4'));
    check('A3 跨优先级档不串号：high 的 wh 不抬高 low 的 N',
      queueAheadOf(fake, 'w2') === 2, 'w2=' + queueAheadOf(fake, 'w2'));
    check('A4 done 不参与排队（wdone 不是 queued）', queueAheadOf(fake, 'wdone') === null,
      'wdone=' + queueAheadOf(fake, 'wdone'));

    // 提权序号：用户刚点的那条（boostSeq 大）必须在同档最前。
    const boosted = fake.map((j) => (j.id === 'w2' ? { ...j, boostSeq: 99 } : j));
    check('A5 点击提权（boostSeq）⇒ 那条 N=0，其它同档 +1',
      queueAheadOf(boosted, 'w2') === 0 && queueAheadOf(boosted, 'w4') === 1,
      'w2=' + queueAheadOf(boosted, 'w2') + ' w4=' + queueAheadOf(boosted, 'w4'));

    // 负对照：把 skin 也当同 kind ⇒ w4 的 N 会变 1（这条判据必须有牙）。
    const mutatedKind = (j) => (j.id === 's1' ? { ...j, kind: 'wallpaper' } : j);
    const mutated = fake.map(mutatedKind);
    check('A6 负对照：把皮肤改成同 kind ⇒ w4 的 N 变 1（跨 kind 判据不是恒真）',
      queueAheadOf(mutated, 'w4') === 1, 'w4=' + queueAheadOf(mutated, 'w4'));

    // 排序函数本身：优先级 → boostSeq → at → seq。
    const order = [...fake].filter((j) => j.status === 'queued').sort(compareQueueOrder).map((j) => j.id);
    check('A7 compareQueueOrder：high 最前；同档 boostSeq 大→小；再按 at/seq',
      order[0] === 'wh' && order.includes('w4') && order.indexOf('w4') < order.indexOf('w1'),
      order.join('>'));
  }

  /* ══ B. 启动 30 条 done-但缺失 ⇒ 全 pending，queuedCount=0 ══════════════════ */
  console.log('\nB. 启动重置限流：30 条 done-缺失 ⇒ pending（不批量 queued）');
  {
    const home = freshDir('reset');
    const jobs = [];
    for (let i = 0; i < 30; i += 1) {
      jobs.push({
        id: 'gone-' + i, url: 'https://site.test/media/gone-' + i + '.mp4',
        dest: join(home, 'library', 'gone-' + i + '.mp4'),
        kind: 'wallpaper', total: 4096, status: 'done', error: null, at: i, priority: 'low',
      });
    }
    // 一条成品还在的 done：必须仍然是 done（不因为"重置"被重下）。
    const kept = join(home, 'library', 'kept.mp4');
    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(kept, Buffer.alloc(2048, 1));
    jobs.push({ id: 'kept-1', url: 'https://site.test/media/kept.mp4', dest: kept, kind: 'wallpaper', total: 2048, status: 'done', error: null, at: 99, priority: 'low' });
    writeFileSync(join(home, 'downloads.json'), JSON.stringify({ version: 1, jobs }), 'utf8');
    const q = createDownloadQueue({ home, log: () => {} });
    const snap = q.snapshot();
    const pending = snap.filter((j) => j.status === 'pending');
    check('B1 30 条 done-缺失 ⇒ 全部 pending（不是 queued）',
      pending.length === 30, 'pending=' + pending.length + ' statuses=' + snap.map((j) => j.status).join(','));
    check('B2 queuedCount = 0（启动不产生批量队列）', snap.queuedCount === 0,
      'queuedCount=' + snap.queuedCount);
    check('B3 byPriority.low.pending = 30 / queued = 0',
      snap.byPriority.low.pending === 30 && snap.byPriority.low.queued === 0,
      JSON.stringify(snap.byPriority.low));
    check('B4 成品还在的 done 保持 done（不因"元数据重置"被重下）',
      snap.find((j) => j.id === 'kept-1')?.status === 'done',
      snap.find((j) => j.id === 'kept-1')?.status);
    check('B5 没有 job 在跑（pending 不参与调度）',
      snap.filter((j) => j.status === 'running').length === 0);
  }

  /* ══ C. 点击提权 + 在播保持 high ═══════════════════════════════════════════ */
  console.log('\nC. 点击 / 当前在播 = high + 队首（queuePos=1 / queuedAhead=0）');
  {
    const home = freshDir('priority');
    const body = Buffer.alloc(128 * 1024, 7);
    const up = await serveBytes(body, 350);
    const q = createDownloadQueue({ home, log: () => {} });
    // 8 条 low：wallpaper 只有 2 个槽 ⇒ 后 6 条必然排队。
    const made = [];
    for (let i = 0; i < 8; i += 1) {
      made.push(q.add({
        url: up.origin + '/media/prio-' + i + '.mp4',
        dest: join(home, 'prio-' + i + '.mp4'),
        kind: 'wallpaper', priority: 'low',
      }).job);
    }
    await waitFor(() => q.snapshot().filter((j) => j.status === 'running').length === 2, 5000);
    const queued = q.snapshot().filter((j) => j.status === 'queued');
    check('C1 初始有排队（8 条 low > 2 个槽）', queued.length >= 4, 'queued=' + queued.length);
    const target = queued[queued.length - 1];
    const clicked = q.add({
      url: target.url, dest: target.dest, kind: 'wallpaper', priority: 'high',
    }).job;
    check('C2 点击 ⇒ priority=high', clicked.priority === 'high', clicked.priority);
    check('C3 点击 ⇒ 队首（queuePos=1 / queuedAhead=0）',
      clicked.queuePos === 1 && clicked.queuedAhead === 0,
      'queuePos=' + clicked.queuePos + ' queuedAhead=' + clicked.queuedAhead);
    // 再次 low 预取同一条：不许降级（在播/当前这条保持 high）。
    const afterPrefetch = q.add({
      url: target.url, dest: target.dest, kind: 'wallpaper', priority: 'low',
    }).job;
    check('C4 low 重复入队不降级（在播保持 high）', afterPrefetch.priority === 'high',
      afterPrefetch.priority);
    await waitFor(() => q.snapshot().every((j) => j.status === 'done' || j.status === 'failed'), 20000);
    const finished = q.snapshot().find((j) => j.id === clicked.id);
    check('C5 下完仍是 high（没有任何路径把它降回 low）', finished?.status === 'done' && finished?.priority === 'high',
      finished ? finished.status + '/' + finished.priority : 'missing');
    // C6/C7：客户端点击 / 在播的**真实入队点**必须是 high —— 上面 C2 用的是队列 API，
    // 若有人把 localFirstApply 改回 low，C2 不会红；这一条才是那条回归的牙。
    const lfSrc = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
    const clickHighOf = (src) => /items: \[lfAddItem\(item, item\.media, "high"\)\]/.test(src);
    check('C6 客户端点击/在播入队 priority="high"（不是 low）', clickHighOf(lfSrc));
    check('C7 负对照：把点击入队改回 low ⇒ C6 立即红',
      !clickHighOf(lfSrc.replace('items: [lfAddItem(item, item.media, "high")]',
        'items: [lfAddItem(item, item.media, "low")]')));
    up.close();
  }

  /* ══ D. 预取最多 2 个、low；pending 不算"已在队列" ════════════════════════ */
  console.log('\nD. 预取：最多 2 个、low；pending 可被预取重新入队');
  {
    const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
    check('D1 预取张数常量 = 2', /const LF_PREFETCH_COUNT = 2;/.test(lf));
    check('D2 预取入队 priority="low"（不抢点击的 high）',
      /kind: "wallpaper", url: next\.media, priority: "low"/.test(lf)
      && /fresh\.map\(\(c\) => \(\{ kind: "wallpaper", url: c\.media, priority: "low" \}\)\)/.test(lf));
    check('D3 pending 不算"已在队列"（否则启动后的下一张永远不会被预取）',
      /const taken = new Set\(\["queued", "running", "done"\]\);/.test(lf)
      && /taken\.has\(String\(j\.status \|\| ""\)\)/.test(lf));
    check('D4 负对照：预取张数写成 3 会被判出来', !/LF_PREFETCH_COUNT = 3/.test(lf));
    check('D5 负对照：预取 priority 改成 high 会被判出来',
      !/kind: "wallpaper", url: next\.media, priority: "high"/.test(lf));
  }

  /* ══ E. 标题栏 N 读 queuedAhead（0 基），不是全局 queuePos ═══════════════ */
  console.log('\nE. 标题栏「前面还有 N 个」= queuedAhead（0 基、同 kind + 同档）');
  {
    const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
    const prog = readFileSync(join(ROOT, 'src', 'wallpaper-progress.js'), 'utf8');
    check('E1 local-first 的 dlQueueDetail 优先读 queuedAhead',
      /const ahead = job && job\.queuedAhead;/.test(lf) && /weT\("排队中：前面还有 \{n\} 个任务", \{ n: Number\(ahead\) \}\)/.test(lf));
    check('E2 旧宿主兼容：没有 queuedAhead 时回落 queuePos - 1',
      /const pos = Number\(job && job\.queuePos\) \|\| 0;/.test(lf));
    // E3 行为面：把 local-first 的纯函数段抠出来真跑（与 verify-wallpaper-progress 同一口径）。
    const weT = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (
      vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
    const LF = (() => {
      const a = lf.indexOf('const DL_POLL_MS = 1500;');
      const b = lf.indexOf('function useDownloadJobs(');
      if (a < 0 || b <= a) return null;
      try {
        return new Function('weT', lf.slice(a, b) + '\nreturn { dlQueueDetail };')(weT);
      } catch { return null; }
    })();
    check('E3 能真跑 dlQueueDetail', Boolean(LF));
    check('E4 queuedAhead=0 ⇒「前面还有 0 个」（队首语义；不再用全局 queuePos=9 算成 8）',
      LF?.dlQueueDetail({ status: 'queued', queuedAhead: 0, queuePos: 9 }) === '排队中：前面还有 0 个任务',
      LF && LF.dlQueueDetail({ status: 'queued', queuedAhead: 0, queuePos: 9 }));
    check('E5 负对照 / 旧宿主兼容：没有 queuedAhead 的旧 job 才回落 queuePos-1（=8）',
      LF?.dlQueueDetail({ status: 'queued', queuePos: 9 }) === '排队中：前面还有 8 个任务',
      LF && LF.dlQueueDetail({ status: 'queued', queuePos: 9 }));
    check('E6 壁纸进度卡 / 标题栏都用同一个 dlQueueDetail（没有第二套 N）',
      /const text = dlQueueDetail\(s\.job\);/.test(prog));
  }

  /* ══ F. 清空未开始队列：queued→pending，不动 running/done/failed ═══════════ */
  console.log('\nF. 清空未开始：只动 queued');
  {
    const home = freshDir('clear');
    const body = Buffer.alloc(64 * 1024, 3);
    const up = await serveBytes(body, 1500);
    // 先放一条已完成的记录（成品在）——清空不许动它。
    const doneDest = join(home, 'done.mp4');
    mkdirSync(dirname(doneDest), { recursive: true });
    writeFileSync(doneDest, Buffer.alloc(2048, 2));
    writeFileSync(join(home, 'downloads.json'), JSON.stringify({
      version: 1,
      jobs: [{ id: 'done-keep', url: 'https://site.test/media/done.mp4', dest: doneDest, kind: 'wallpaper', total: 2048, status: 'done', error: null, at: 1, priority: 'low' }],
    }), 'utf8');
    const q = createDownloadQueue({ home, log: () => {} });
    for (let i = 0; i < 6; i += 1) {
      q.add({ url: up.origin + '/media/clear-' + i + '.mp4', dest: join(home, 'clear-' + i + '.mp4'), kind: 'wallpaper', priority: 'low' });
    }
    await waitFor(() => q.snapshot().filter((j) => j.status === 'running').length >= 1, 5000);
    const before = q.snapshot();
    const queuedBefore = before.filter((j) => j.status === 'queued').length;
    const runningBefore = before.filter((j) => j.status === 'running').length;
    check('F1 清空前确有排队与在跑', queuedBefore >= 1 && runningBefore >= 1,
      'queued=' + queuedBefore + ' running=' + runningBefore);
    const out = q.clearQueued();
    const after = q.snapshot();
    check('F2 queued ⇒ pending（数量与返回值一致）',
      out.cleared === queuedBefore && after.filter((j) => j.status === 'pending').length === queuedBefore,
      'cleared=' + out.cleared + ' pending=' + after.filter((j) => j.status === 'pending').length);
    check('F3 running 不动', after.filter((j) => j.status === 'running').length === runningBefore,
      'running=' + after.filter((j) => j.status === 'running').length);
    check('F4 done 不动', after.find((j) => j.id === 'done-keep')?.status === 'done');
    check('F5 清空后 queuedCount=0', after.queuedCount === 0, 'queuedCount=' + after.queuedCount);
    // 点击其中一条 pending ⇒ 立刻 high 入队。
    const one = after.find((j) => j.status === 'pending');
    const again = q.add({ url: one.url, dest: one.dest, kind: 'wallpaper', priority: 'high' }).job;
    check('F6 清空后点击 pending ⇒ high + 入队', again.priority === 'high' && again.status === 'queued',
      again.priority + '/' + again.status);
    up.close();
  }

  /* ══ G. 暂停全部 / 恢复 ═══════════════════════════════════════════════════ */
  console.log('\nG. 暂停全部：不取新任务、正在跑的回到 queued、恢复后能下完');
  {
    const home = freshDir('pause');
    const body = Buffer.alloc(64 * 1024, 9);
    const up = await serveBytes(body, 1200);
    const q = createDownloadQueue({ home, log: () => {} });
    for (let i = 0; i < 3; i += 1) {
      q.add({ url: up.origin + '/media/pause-' + i + '.mp4', dest: join(home, 'pause-' + i + '.mp4'), kind: 'wallpaper', priority: 'low' });
    }
    await waitFor(() => q.snapshot().filter((j) => j.status === 'running').length >= 1, 5000);
    const paused = q.setPaused(true);
    check('G1 setPaused(true) 回报 paused=true', paused.paused === true);
    const stopped = await waitFor(() => q.snapshot().filter((j) => j.status === 'running').length === 0, 5000);
    check('G2 暂停后没有 running（正在跑的 abort 回 queued）', stopped,
      'running=' + q.snapshot().filter((j) => j.status === 'running').length);
    const pausedSnap = q.snapshot();
    check('G3 暂停后 3 条都还在队列里（queued，不是 cancelled/failed）',
      pausedSnap.filter((j) => j.status === 'queued').length === 3,
      pausedSnap.map((j) => j.status).join(','));
    // 暂停期间新入队也不许启动。
    q.add({ url: up.origin + '/media/pause-late.mp4', dest: join(home, 'pause-late.mp4'), kind: 'wallpaper', priority: 'high' });
    await sleep(250);
    check('G4 暂停期间新任务不启动（全部 queued）',
      q.snapshot().filter((j) => j.status === 'running').length === 0,
      q.snapshot().map((j) => j.status).join(','));
    q.setPaused(false);
    const allDone = await waitFor(() => q.snapshot().every((j) => j.status === 'done' || j.status === 'failed'), 30000);
    check('G5 恢复后全部下完', allDone,
      q.snapshot().map((j) => j.status).join(','));
    check('G6 暂停开关落盘（重建队列仍读得到 paused）',
      (() => {
        const home2 = freshDir('pause-persist');
        const q2 = createDownloadQueue({ home: home2, log: () => {} });
        q2.setPaused(true);
        const q3 = createDownloadQueue({ home: home2, log: () => {} });
        const ok = q3.snapshot().paused === true;
        q2.setPaused(false); q3.setPaused(false);
        return ok;
      })());
    up.close();
  }

  /* ══ H. 升级迁移：旧 job 的错误期望值 ═══════════════════════════════════════ */
  console.log('\nH. 升级迁移：变体 URL + 原画哈希 + expectBytes=0 ⇒ 重算并自动重试');
  {
    const home = freshDir('migrate');
    const body = Buffer.alloc(96 * 1024, 0x5a);
    const variantSha = sha256(body);
    const originalSha = sha256(Buffer.from('original-bytes-different'));
    const up = await serveBytes(body, 0);
    const variantUrl = up.origin + '/media/abc.1080p.mp4';
    const originalUrl = up.origin + '/media/abc.mp4';
    const items = [{
      id: 'folia-migrate', title: 'migrate', media: originalUrl,
      bytes: 123456, sha256: originalSha,
      variants: [{ label: '1080p', height: 1080, bytes: body.length, url: variantUrl, sha256: variantSha }],
    }];
    const dest = join(home, 'variant.mp4');
    /** 4.23.16 形态的坏 job：变体 URL + 原画哈希 + expectBytes=0 + hashSource=original。 */
    const badJobFor = (destPath) => ({
      id: 'bad-old-job', url: variantUrl, dest: destPath, kind: 'wallpaper', total: 0,
      status: 'failed', error: 'hash-mismatch: 传输内容与站点不一致', at: 1,
      priority: 'low',
      sha256: originalSha, expectSha: originalSha, expectBytes: 0, hashSource: 'original',
      chosenVariant: 'original',
    });
    writeFileSync(join(home, 'downloads.json'), JSON.stringify({
      version: 1,
      jobs: [badJobFor(dest)],
    }), 'utf8');

    // H0：纯函数本身：命中原画 / 命中变体 / 查不到。
    const expVar = resolveJobExpectationFromItems({ url: variantUrl }, items);
    const expOrig = resolveJobExpectationFromItems({ url: originalUrl }, items);
    check('H0 纯函数：变体 URL ⇒ 变体自己的 sha/bytes/source',
      expVar && expVar.source === 'variant' && expVar.sha256 === variantSha && expVar.bytes === body.length,
      JSON.stringify(expVar));
    check('H0b 纯函数：原画 URL ⇒ 原画 sha/source',
      expOrig && expOrig.source === 'original' && expOrig.sha256 === originalSha,
      JSON.stringify(expOrig));
    check('H0c 纯函数：清单里没有 ⇒ null（不拿原画哈希去套变体）',
      resolveJobExpectationFromItems({ url: 'https://nope.test/x.1080p.mp4' }, items) === null);

    const q = createDownloadQueue({
      home, log: () => {},
      migrateExpectation: (job) => resolveJobExpectationFromItems(job, items),
    });
    // 迁移后 job 会被 pump 立刻取走，所以"迁移字段"可能在 running/done 上读 —— 都算同一事实。
    const migrated = q.snapshot().find((j) => j.id === 'bad-old-job');
    check('H1 加载后 expectSha = 变体 sha（不是原画）',
      migrated?.expectSha === variantSha, migrated && String(migrated.expectSha).slice(0, 12));
    check('H2 expectBytes = 变体字节 / hashSource=variant / chosenVariant=1080p',
      migrated?.expectBytes === body.length && migrated?.hashSource === 'variant' && migrated?.chosenVariant === '1080p',
      JSON.stringify({ bytes: migrated?.expectBytes, source: migrated?.hashSource, v: migrated?.chosenVariant }));
    check('H3 迁移后自动重试（不再是 failed）',
      migrated && migrated.status !== 'failed', migrated && migrated.status);
    const stats = q.migrationStats();
    check('H4 迁移统计：migrated=1 / retried=1', stats.migrated === 1 && stats.retried === 1,
      JSON.stringify(stats));

    const done = await waitFor(() => q.snapshot().find((j) => j.id === 'bad-old-job')?.status === 'done'
      || q.snapshot().find((j) => j.id === 'bad-old-job')?.status === 'failed', 15000);
    const final = q.snapshot().find((j) => j.id === 'bad-old-job');
    check('H5 迁移后能正常 done（用本地假源）', done && final?.status === 'done', final && final.status);
    check('H6 落地文件字节 = 假源（内容正确）',
      final?.status === 'done' && statSync(dest).size === body.length && sha256(readFileSync(dest)) === variantSha,
      final && final.status);

    // 幂等：同一 home 再建一次（job 已 done、字段已正）⇒ migrated=0。
    const q2 = createDownloadQueue({
      home, log: () => {},
      migrateExpectation: (job) => resolveJobExpectationFromItems(job, items),
    });
    const again = q2.migrationStats();
    check('H7 幂等：第二次加载 migrated=0', again.migrated === 0, JSON.stringify(again));

    // 清单不可达（回调返回 null）⇒ 跳过、不崩、不无限重试；失败原因原样保留。
    const home2 = freshDir('migrate-skip');
    writeFileSync(join(home2, 'downloads.json'), JSON.stringify({
      version: 1, jobs: [badJobFor(join(home2, 'variant.mp4'))],
    }), 'utf8');
    const q3 = createDownloadQueue({ home: home2, log: () => {}, migrateExpectation: () => null });
    const skipped = q3.snapshot().find((j) => j.id === 'bad-old-job');
    check('H8 清单不可达 ⇒ 跳过迁移、不崩、job 仍 failed', skipped?.status === 'failed',
      skipped && skipped.status);
    check('H9 跳过时统计 skipped=1 / migrated=0',
      q3.migrationStats().skipped === 1 && q3.migrationStats().migrated === 0,
      JSON.stringify(q3.migrationStats()));
    const again3 = q3.migrate();
    check('H10 跳过不是无限重试：再迁一次仍是 0 / skipped=1',
      again3.migrated === 0 && again3.skipped === 1, JSON.stringify(again3));

    // 负对照（源码变异）：把 load() 之后的迁移调用删掉 ⇒ 同一条断言必须红。
    const mutRoot = freshDir('mut');
    mkdirSync(join(mutRoot, 'lib'), { recursive: true });
    copyFileSync(join(ROOT, 'lib', 'media-verify.js'), join(mutRoot, 'lib', 'media-verify.js'));
    const src = readFileSync(join(ROOT, 'lib', 'download-queue.js'), 'utf8');
    const mutatedSrc = src.replace(/\n\s*migrateLegacyExpectations\(\);\n\s*pump\(\);/, '\n  pump();');
    writeFileSync(join(mutRoot, 'lib', 'download-queue.js'), mutatedSrc, 'utf8');
    const mutated = await import(pathToFileURL(join(mutRoot, 'lib', 'download-queue.js')).href + '?v=' + Date.now());
    const home3 = freshDir('mut-home');
    writeFileSync(join(home3, 'downloads.json'), JSON.stringify({
      version: 1, jobs: [badJobFor(join(home3, 'variant.mp4'))],
    }), 'utf8');
    const q4 = mutated.createDownloadQueue({
      home: home3, log: () => {},
      migrateExpectation: (job) => resolveJobExpectationFromItems(job, items),
    });
    const stale = q4.snapshot().find((j) => j.id === 'bad-old-job');
    check('H11 负对照：删掉迁移调用 ⇒ 旧 expectSha 仍是原画（H1 会红）',
      stale?.expectSha === originalSha && stale?.status === 'failed',
      stale && (String(stale.expectSha).slice(0, 12) + '/' + stale.status));
    q4.setPaused(false);
    up.close();
  }

  /* ── 汇总 ─────────────────────────────────────────────────────────────── */
  const bad = results.filter((r) => !r.ok);
  console.log('\n  ── 汇总 ──');
  console.log('  通过 ' + (results.length - bad.length) + ' / ' + results.length);
  if (bad.length) {
    for (const r of bad) console.log('    ✗ ' + r.name + (r.detail ? ' — ' + r.detail : ''));
  }
  process.exit(bad.length ? 1 : 0);
} finally {
  cleanupTestHome(HOME);
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
}
