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
 *   D. 预取**默认 0 张**（4.24.1 起：宿主下发、上限 3）且一律 low（源码 + 行为）；
 *   E. 「前面还有 N 个」= `queuedAhead`（0 基）且与假队列顺序一致（含跨 kind）；
 *   F. 「清空未开始队列」把 queued→pending，不动 running / done / failed；
 *   G. 暂停全部：不再取任务 / 正在跑的回到 queued / 恢复后能下完；
 *   H. 4.23.22 结构修复：期望值**只在下载完成那一刻**问当前清单（job 上不再持久化）。
 *      旧 job 的 expectSha 被忽略仍能 done；清单旧/站点新 ⇒ 强刷清单后通过；刷新后仍不符
 *      才 failed（带 refreshAttempted）；清单不可达 ⇒ verified=none 不失败；另有源码变异
 *      负对照（把"用 job 的 expectSha"贴回 ⇒ 第一条必红）。
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
    // C8/C9：**当前在播**（启动恢复 / 轮播 / revalidate）的提权也走同一个 high 入队；
    // 且条目来自内存 inventory，不为提权多发 /inventory。
    const mpSrc = readFileSync(join(ROOT, 'src', 'media-prep.js'), 'utf8');
    check('C8 applySelection 的非点击路径会提权当前在播（silent + 内存条目）',
      /localFirstApply\(id, \{ silent: true, item: hit \|\| undefined \}\)/.test(mpSrc));
    check('C9 负对照：删掉这行提权调用会被判出来（C8 的牙）',
      !/localFirstApply\(id, \{ silent: true, item: hit \|\| undefined \}\)/
        .test(mpSrc.replace('localFirstApply(id, { silent: true, item: hit || undefined })', '')));
    up.close();
  }

  /* ══ D. 预取张数：4.24.1 起**默认 0**（宿主下发，上限 3），一律 low ═════════ */
  console.log('\nD. 预取：默认 0 张（宿主下发，上限 3）；一律 low；pending 可被重新入队');
  {
    const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
    check('D1 预取张数：默认 0、上限 3、只认宿主下发（不再按 playbackPolicy 算 3）',
      /const LF_PREFETCH_MAX = 3;/.test(lf)
      && /function lfPrefetchCount\(hostValue\)/.test(lf)
      && /!Number\.isFinite\(v\) \|\| v <= 0\) return 0;/.test(lf)
      && /hostCount = lfPrefetchCount\(doc\.prefetchCount\);/.test(lf)
      && /if \(hostCount <= 0\) return;/.test(lf));
    check('D2 预取入队 priority="low"（不抢点击的 high）',
      /items: batch\.map\(\(c\) => \(\{ kind: "wallpaper", url: c\.media, priority: "low" \}\)\)/.test(lf));
    check('D3 pending 不算"已在队列"（否则启动后的下一张永远不会被预取）',
      /const taken = new Set\(\["queued", "running", "done"\]\);/.test(lf)
      && /taken\.has\(String\(j\.status \|\| ""\)\)/.test(lf));
    check('D4 负对照：把"按播放策略算 2/3 张"的旧常量贴回 ⇒ 必红',
      !/LF_PREFETCH_COUNT_DOWNLOAD_FIRST = 3;/.test(lf)
      && !/const LF_PREFETCH_COUNT = 2;/.test(lf));
    check('D5 负对照：预取 priority 改成 high 会被判出来',
      !/priority: "high"/.test(lf.slice(lf.indexOf('function lfPrefetchNext'))));
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

  /* ══ H. 4.23.22 结构修复：期望值只在完成那一刻问当前清单 ═════════════════════
   *
   * 旧判据（H 组）守的是"迁移旧 expectSha"。用户否定了这个方向：迁移只是给
   * "把期望值持久化"打补丁 —— 清单再变一次，同样的 hash-mismatch 又回来。
   * 现在的判据直接守根因：
   *   H1/H2 旧 job 里残留的期望值被**忽略**，下载仍能 done；
   *   H3 校验记录的是**完成时**的当前清单 sha（带时间戳），不是入队时的；
   *   H4 清单旧、站点新 ⇒ 强制刷新清单后校验通过（不误报）；
   *   H5 刷新后仍不符 ⇒ 才 failed，且 verifyDetail 带 refreshAttempted；
   *   H6 清单不可达 ⇒ 退化为长度 + 结构，verified=none，不失败；
   *   H7 负对照（源码变异）：把"用 job 持久化的 expectSha"贴回 ⇒ H1 必红。
   */
  console.log('\nH. 校验只在完成那一刻问当前清单（不再持久化 expectSha）');
  {
    const body = Buffer.alloc(96 * 1024, 0x5a);
    const variantSha = sha256(body);
    const originalSha = sha256(Buffer.from('original-bytes-different'));
    const up = await serveBytes(body, 0);
    // 用 .zip：与用户实测的皮肤包同形态，跳过"媒体结构"判据，只守内容哈希路径。
    const variantUrl = up.origin + '/media/abc.1080p.zip';
    const originalUrl = up.origin + '/media/abc.zip';
    const items = [{
      id: 'folia-current', title: 'current', media: originalUrl,
      bytes: 123456, sha256: originalSha,
      variants: [{ label: '1080p', height: 1080, bytes: body.length, url: variantUrl, sha256: variantSha }],
    }];
    const staleId = sha256(variantUrl).slice(0, 32);   // 与队列 urlKey() 同一个键
    /** 旧形态 job：期望值三件套都在文件里（4.23.21 及以前）—— 现在必须被**忽略**。 */
    const staleJobFor = (destPath) => ({
      id: staleId, url: variantUrl, dest: destPath, kind: 'wallpaper', total: 0,
      status: 'pending', at: 1, priority: 'low',
      sha256: originalSha, expectSha: originalSha, expectBytes: 0, hashSource: 'original',
      chosenVariant: 'original',
    });

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
      resolveJobExpectationFromItems({ url: 'https://nope.test/x.1080p.zip' }, items) === null);

    // H1/H2：旧 job 的 expectSha 是**错的**（原画 sha + expectBytes=0）。修好之后下载
    // 完成时问当前清单，拿变体自己的 sha ⇒ done；旧字段完全不参与。
    const home = freshDir('no-migrate');
    const dest = join(home, 'variant.zip');
    writeFileSync(join(home, 'downloads.json'), JSON.stringify({ version: 1, jobs: [staleJobFor(dest)] }), 'utf8');
    const q = createDownloadQueue({
      home, log: () => {},
      resolveExpectation: (job) => resolveJobExpectationFromItems(job, items),
      refreshExpectation: async (job) => resolveJobExpectationFromItems(job, items),
    });
    const loaded = q.snapshot().find((j) => j.id === staleId);
    check('H1 旧 job 的 expectSha/expectBytes 不被读回（加载后仍是 pending，不预填旧值）',
      loaded && loaded.status === 'pending' && loaded.expectSha == null && loaded.expectBytes === 0,
      loaded && JSON.stringify({ st: loaded.status, sha: loaded.expectSha, bytes: loaded.expectBytes }));
    q.add({ url: variantUrl, dest, kind: 'wallpaper', priority: 'high' });
    const settled = await waitFor(() => {
      const s = q.snapshot().find((j) => j.id === staleId)?.status;
      return s === 'done' || s === 'failed';
    }, 15000);
    const final = q.snapshot().find((j) => j.id === staleId);
    check('H1b 旧的错误期望不阻塞下载：最终 done', settled && final?.status === 'done', final && final.status);
    check('H2 落地字节与当前清单一致（sha/bytes 都取自完成时的清单）',
      final?.status === 'done' && statSync(dest).size === body.length
        && sha256(readFileSync(dest)) === variantSha
        && final.expectSha === variantSha && final.expectBytes === body.length,
      final && JSON.stringify({ sha: String(final.expectSha).slice(0, 12), bytes: final.expectBytes }));

    // H3：校验记录的是"完成那一刻实际用了什么" + 时间戳。
    check('H3 /downloads/list 的 expectSha = 最近一次校验实际使用的 sha（verifiedAt>0）',
      final?.verified === 'sha256' && final?.verifiedAt > 0 && final?.expectShaAt === final?.verifiedAt,
      final && JSON.stringify({ verified: final.verified, at: final.verifiedAt }));

    // H4：本地清单旧（旧 sha）、站点已是新内容 ⇒ 强制刷新清单后校验通过，不误报。
    {
      const home4 = freshDir('stale-manifest');
      const dest4 = join(home4, 'new.zip');
      const newSha = sha256(Buffer.from('site-rotated-content'));
      const body4 = Buffer.from('site-rotated-content');
      const up4 = await serveBytes(body4, 0);
      const url4 = up4.origin + '/media/rotated.zip';
      const oldSha = sha256(Buffer.from('old-content'));
      let manifestSha = oldSha;
      let refreshes = 0;
      const q4 = createDownloadQueue({
        home: home4, log: () => {},
        resolveExpectation: () => ({ sha256: manifestSha, bytes: 0, source: 'original', at: Date.now() - 3600_000 }),
        refreshExpectation: async () => {
          refreshes += 1;
          manifestSha = newSha; // 刷新后站点清单给出了新 sha
          return { sha256: newSha, bytes: body4.length, source: 'original', at: Date.now() };
        },
      });
      q4.add({ url: url4, dest: dest4, kind: 'wallpaper', priority: 'high' });
      const ok4 = await waitFor(() => q4.snapshot().find((j) => j.url === url4)?.status === 'done'
        || q4.snapshot().find((j) => j.url === url4)?.status === 'failed', 15000);
      const f4 = q4.snapshot().find((j) => j.url === url4);
      check('H4 清单旧 sha + 站点新字节 ⇒ 刷新清单后校验通过（不失败）',
        ok4 && f4?.status === 'done' && f4?.expectSha === newSha && refreshes === 1,
        f4 && JSON.stringify({ st: f4.status, sha: String(f4.expectSha).slice(0, 12), refreshes }));
      up4.close();
    }

    // H5：刷新后仍与字节不符 ⇒ 才 failed；verifyDetail 带 refreshAttempted / expected / actual。
    {
      const home5 = freshDir('still-bad');
      const dest5 = join(home5, 'still.zip');
      const wrongSha = sha256(Buffer.from('manifest-still-wrong'));
      const up5 = await serveBytes(Buffer.from('actual-bytes'), 0);
      const url5 = up5.origin + '/media/still.zip';
      const q5 = createDownloadQueue({
        home: home5, log: () => {},
        resolveExpectation: () => ({ sha256: sha256(Buffer.from('manifest-old-wrong')), bytes: 0, source: 'original', at: Date.now() }),
        refreshExpectation: async () => ({ sha256: wrongSha, bytes: 0, source: 'original', at: Date.now() }),
      });
      q5.add({ url: url5, dest: dest5, kind: 'wallpaper', priority: 'high' });
      const bad5 = await waitFor(() => q5.snapshot().find((j) => j.url === url5)?.status === 'failed', 20000);
      const f5 = q5.snapshot().find((j) => j.url === url5);
      check('H5 刷新后仍不符 ⇒ failed(hash-mismatch)，且错误/详情带 refreshAttempted:true',
        bad5 && /hash-mismatch/i.test(String(f5?.error))
          && f5?.verifyDetail?.refreshAttempted === true
          && f5?.verifyDetail?.actual === sha256(Buffer.from('actual-bytes')),
        f5 && JSON.stringify({ err: f5.error, detail: f5.verifyDetail }));
      up5.close();
    }

    // H6：清单不可达 ⇒ 只做长度 + 结构；done + verified=none，不失败、不猜哈希。
    {
      const home6 = freshDir('manifest-down');
      const dest6 = join(home6, 'down.zip');
      const up6 = await serveBytes(Buffer.from('whatever-bytes'), 0);
      const url6 = up6.origin + '/media/down.zip';
      const logs6 = [];
      const q6 = createDownloadQueue({
        home: home6, log: (m) => logs6.push(String(m)),
        resolveExpectation: () => null,
        refreshExpectation: async () => null,
      });
      q6.add({ url: url6, dest: dest6, kind: 'wallpaper', priority: 'high' });
      const ok6 = await waitFor(() => q6.snapshot().find((j) => j.url === url6)?.status === 'done'
        || q6.snapshot().find((j) => j.url === url6)?.status === 'failed', 15000);
      const f6 = q6.snapshot().find((j) => j.url === url6);
      check('H6 清单不可达 ⇒ done + verified=none(manifest-unreachable)，不判失败',
        ok6 && f6?.status === 'done' && f6?.verified === 'none' && f6?.verifyReason === 'manifest-unreachable',
        f6 && JSON.stringify({ st: f6.status, verified: f6.verified, why: f6.verifyReason }));
      check('H6b 静默跳过校验会打 warn（长度/结构层仍生效）',
        logs6.some((l) => /verified=none/.test(l) && /manifest-unreachable/.test(l)),
        logs6.filter((l) => /verified=/.test(l)).slice(-2).join(' | '));
      up6.close();
    }

    // H7 负对照（源码变异）：把"用 job 里持久化的 expectSha"贴回校验路径 ⇒ H1 必须红。
    {
      const mutRoot = freshDir('mut');
      mkdirSync(join(mutRoot, 'lib'), { recursive: true });
      copyFileSync(join(ROOT, 'lib', 'media-verify.js'), join(mutRoot, 'lib', 'media-verify.js'));
      copyFileSync(join(ROOT, 'lib', 'media-state.js'), join(mutRoot, 'lib', 'media-state.js'));
      const src = readFileSync(join(ROOT, 'lib', 'download-queue.js'), 'utf8');
      let mutatedSrc = src.replace(
        'let exp = currentExpectation(job);',
        'let exp = { sha256: normalizeSha256(job.expectSha), bytes: 0, source: \'original\', at: 0 };',
      );
      // 同时让 load() 把旧字段读回来（旧设计的形态），否则 job 上根本没有 expectSha。
      mutatedSrc = mutatedSrc.replace(
        'verified: typeof j.verified === \'string\' ? j.verified : null,',
        'verified: typeof j.verified === \'string\' ? j.verified : null,\n          expectSha: normalizeSha256(j.expectSha || j.sha256),',
      );
      check('H7 负对照变异真的命中了源码（两处替换都生效）', mutatedSrc !== src
        && /job\.expectSha/.test(mutatedSrc) && /expectSha: normalizeSha256\(j\.expectSha/.test(mutatedSrc));
      writeFileSync(join(mutRoot, 'lib', 'download-queue.js'), mutatedSrc, 'utf8');
      const mutated = await import(pathToFileURL(join(mutRoot, 'lib', 'download-queue.js')).href + '?v=' + Date.now());
      const home7 = freshDir('mut-home');
      const dest7 = join(home7, 'variant.zip');
      writeFileSync(join(home7, 'downloads.json'), JSON.stringify({ version: 1, jobs: [staleJobFor(dest7)] }), 'utf8');
      const q7 = mutated.createDownloadQueue({
        home: home7, log: () => {},
        resolveExpectation: (job) => resolveJobExpectationFromItems(job, items),
      });
      q7.add({ url: variantUrl, dest: dest7, kind: 'wallpaper', priority: 'high' });
      await waitFor(() => q7.snapshot().find((j) => j.id === staleId)?.status === 'failed', 20000);
      const stale = q7.snapshot().find((j) => j.id === staleId);
      check('H7b 负对照：用 job 里的旧 expectSha ⇒ 旧 job 仍然 failed（H1 会红）',
        stale?.status === 'failed' && /hash-mismatch/i.test(String(stale.error)),
        stale && (String(stale.expectSha).slice(0, 12) + '/' + stale.status));
      q7.setPaused(false);
    }
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
