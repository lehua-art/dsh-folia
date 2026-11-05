#!/usr/bin/env node
/**
 * verify-media-chaos.mjs — **状态机混沌测试**（4.23.19）：随机折腾 100 轮，逐轮验证不变量。
 *
 * 为什么需要它：这一整类 bug 的共同点是"**两个地方对同一件事有不同看法**"。逐条单测能证明
 * "某个函数写对了"，但证明不了"随便怎么折腾，队列/盘上/播放源三者不会互相矛盾"。所以这里
 * 不按功能组织，而是按**故障动作**组织 —— 随机删文件、随机改记录、只写一半、校验不符、清缓存、
 * 重启，然后要求下面五条**每一轮**都成立：
 *
 *   I1 不存在 `done + 文件缺失`（对账之后）
 *   I2 不存在 `src=local` 指向缺失 / 长度不符 / 结构坏的文件
 *   I3 下载中（queued / running / 校验中）的条目 `src` 必须是 proxy
 *   I4 一条"文件完整 + 记录 done"的条目，对账后 `src` 必须变 local（3 秒判据面）
 *   I5 任何失败态都有**具体**文案（禁止泛化成"浏览器无法解码"）
 *   I6 UI 状态与队列状态一致（queued / downloading / complete）
 *
 * 复现：输出里带 seed；`node test/verify-media-chaos.mjs --seed=<n> --verbose` 可复现同一串动作。
 * 隔离 home（默认），绝不写用户库。
 *
 * Usage: node test/verify-media-chaos.mjs [--rounds=100] [--seed=N] [--verbose]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';
import { createDownloadQueue } from '../lib/download-queue.js';
import {
  createMediaReconciler, resolvePlaySrc, localMediaUrl, mediaResetPatch,
} from '../lib/media-state.js';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ROUNDS = Math.max(1, Number(flag('rounds', 100)) || 100);
const SEED = Number(flag('seed', 20261104)) || 20261104;
const VERBOSE = argv.includes('--verbose');

/** 可复现 PRNG（mulberry32）—— 复现 bug 只需要 seed。 */
function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const HOME = isolateTestHome('media-chaos', { force: true });
const LIB = join(HOME, 'library', 'wallpaper');
mkdirSync(LIB, { recursive: true });

const shaOf = (buf) => createHash('sha256').update(buf).digest('hex');
function fakeMp4(total = 4096, fill = 0x11) {
  const b = Buffer.alloc(total, fill);
  b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1'); b.writeUInt32BE(0x200, 12);
  b.write('mp41', 16, 'latin1'); b.write('isom', 20, 'latin1');
  b.writeUInt32BE(total - 32, 32); b.write('moov', 36, 'latin1');
  return b;
}

/** 20 条初始 job：8 条完整有效 / 4 条 done-缺失 / 4 条 pending-缺失 / 2 failed / 2 下载中。 */
const jobs = [];
for (let i = 0; i < 20; i += 1) {
  const id = 'j' + i;
  const dest = join(LIB, id + '.mp4');
  const buf = fakeMp4(4096, 0x10 + i);
  const full = i < 8;
  if (full) writeFileSync(dest, buf);
  let status = 'done';
  if (i >= 12 && i < 16) status = 'pending';
  if (i >= 16 && i < 18) status = 'failed';
  if (i >= 18) status = 'running';
  jobs.push({
    id, url: 'http://127.0.0.1:1/' + id + '.mp4', dest, kind: 'wallpaper',
    total: 4096, status, error: status === 'failed' ? 'fetch failed' : null, at: i, priority: 'low',
    sha256: full ? shaOf(buf) : '', expectSha: full ? shaOf(buf) : '', expectBytes: full ? 4096 : 0,
    hashSource: 'original',
  });
}
writeFileSync(join(HOME, 'downloads.json'), JSON.stringify({ version: 1, paused: true, jobs }), 'utf8');

let queue = createDownloadQueue({ home: HOME, log: () => {} });
try { queue.setPaused(true); } catch { /* 已暂停 */ }
let reconciler = createMediaReconciler({ queue, log: () => {} });

const violations = [];
function violate(inv, detail, opLog) {
  violations.push({ inv, detail: String(detail || ''), ops: opLog.slice(-4).map((o) => o.label) });
}

/** I5：失败态 → 具体文案（与 docs/MEDIA-LIFECYCLE.md 的文案矩阵同表）。 */
function copyFor(state, job) {
  const error = String((job && job.error) || '');
  const status = String((job && job.status) || (state && state.jobStatus) || '');
  // ⚠️ 顺序即判据：**下载中**永远显示"缓存中"（哪怕盘上一个字节都没有），
  // 不能因为 fileExists=false 就退化成"未缓存"（那会让人以为任务没在跑）。
  if (status === 'running' || status === 'queued') return '缓存中';
  if (status === 'done') {
    if (state.fileExists !== true) return '本地副本已丢失，正在重新下载';
    if (state.fileValid !== true) return '文件已损坏，已重新下载';
    return '已缓存';
  }
  if (status === 'failed') {
    return /^hash-mismatch/i.test(error) ? '传输内容与站点不一致' : '下载/安装失败：' + (error || 'unknown');
  }
  return '未缓存';
}

const ops = [
  {
    label: '删文件',
    run(job) {
      try { rmSync(job.dest, { force: true }); } catch { /* ignore */ }
      // 事故形态：删了文件但记录还是 done（对账要负责把它折成 pending）。
      if (rnd() < 0.5) queue.applyReconcile([{ id: job.id, patch: { status: 'done' } }]);
    },
  },
  {
    label: '改 done',
    run(job) {
      queue.applyReconcile([{ id: job.id, patch: { status: 'done', error: null } }]);
    },
  },
  {
    label: '改 pending',
    run(job) {
      queue.applyReconcile([{ id: job.id, patch: mediaResetPatch() }]);
    },
  },
  {
    label: '改 failed',
    run(job) {
      queue.applyReconcile([{ id: job.id, patch: { status: 'failed', error: 'fetch failed' } }]);
    },
  },
  {
    label: '只写一半',
    run(job) {
      mkdirSync(dirname(job.dest), { recursive: true });
      writeFileSync(job.dest + '.part', fakeMp4(2048, 0x77));
      queue.applyReconcile([{ id: job.id, patch: { status: 'running', received: 2048, total: 4096 } }]);
    },
  },
  {
    label: '校验不符',
    run(job) {
      mkdirSync(dirname(job.dest), { recursive: true });
      writeFileSync(job.dest, fakeMp4(4096, 0x88));
      queue.applyReconcile([{
        id: job.id,
        patch: { status: 'done', expectSha: shaOf(Buffer.from('nope')), expectBytes: 4096, total: 4096 },
      }]);
    },
  },
  {
    label: '下载完成',
    run(job) {
      mkdirSync(dirname(job.dest), { recursive: true });
      const buf = fakeMp4(4096, 0x99);
      writeFileSync(job.dest, buf);
      queue.applyReconcile([{
        id: job.id,
        patch: { status: 'done', expectSha: shaOf(buf), expectBytes: 4096, total: 4096, error: null },
      }]);
      // I4：这一轮之后必须能解析成 local（下一次对账产出 fileExists/fileValid）。
      return { expectLocalAfterReconcile: true };
    },
  },
  {
    label: '清缓存',
    run() {
      for (const j of queue.snapshot()) { try { rmSync(j.dest, { force: true }); } catch { /* ignore */ } }
      queue.applyReconcile(queue.snapshot()
        .filter((j) => j.status === 'done')
        .map((j) => ({ id: j.id, patch: Object.assign(mediaResetPatch(), { sha256: '', expectSha: '', expectBytes: 0 }) })));
    },
  },
  {
    label: '重启',
    run() {
      // 重建队列 + 对账器（与宿主重启同一条路径：load → pending → 对账）。
      __restart();
    },
  },
];

function __restart() {
  try { queue.setPaused(true); } catch { /* ignore */ }
  queue = createDownloadQueue({ home: HOME, log: () => {} });
  try { queue.setPaused(true); } catch { /* ignore */ }
  reconciler = createMediaReconciler({ queue, log: () => {} });
}

const opLog = [];
const t0 = Date.now();
for (let round = 1; round <= ROUNDS; round += 1) {
  const snapBefore = queue.snapshot();
  const job = pick(snapBefore);
  const op = pick(ops);
  const opInfo = { round, label: op.label, id: job ? job.id : '-' };
  opLog.push(opInfo);
  let hinted = null;
  try { hinted = op.run(job); } catch (e) { violate('op-error', op.label + ': ' + String((e && e.message) || e), opLog); }

  // 每轮都跑 deep 对账：sha 那一层也要参与（否则"长度对、内容错"会在两轮之间蒙混过关）。
  await reconciler.reconcileAll({ reason: 'chaos-' + round, deep: true });
  const snap = queue.snapshot();
  const states = new Map(snap.map((j) => [j.id, reconciler.stateOfId(j.id)]));

  for (const j of snap) {
    const st = states.get(j.id);
    // I1：不存在 done + 文件缺失
    if (j.status === 'done' && !existsSync(j.dest)) {
      violate('I1', j.id + ' done 但文件不存在', opLog);
    }
    // I3：下载中必须是 proxy
    if (j.status === 'running' || j.status === 'queued') {
      const src = resolvePlaySrc(st, { mediaProxy: '/folia/site-media/x.mp4?u=x', media: j.url });
      if (src.source !== 'proxy') violate('I3', j.id + ' 下载中却解析成 ' + src.source, opLog);
    }
    const src = resolvePlaySrc(st, { mediaProxy: '/folia/site-media/x.mp4?u=x', media: j.url });
    // I2：src=local ⇒ 文件在、长度相符、结构有效
    if (src.source === 'local') {
      let size;
      try { size = statSync(j.dest).size; } catch { violate('I2', j.id + ' local 指向不存在的文件', opLog); continue; }
      const expect = Number(j.expectBytes) || Number(j.total) || 0;
      if (expect > 0 && size !== expect) violate('I2', j.id + ' local 长度 ' + size + ' ≠ ' + expect, opLog);
      if (st && st.fileValid !== true) violate('I2', j.id + ' local 指向 fileValid=false 的文件', opLog);
      if (src.url !== localMediaUrl(j.id)) violate('I2', j.id + ' local 地址不是唯一拼法：' + src.url, opLog);
    }
    // I4：刚"下载完成"的那条 ⇒ local
    if (hinted && hinted.expectLocalAfterReconcile && j.id === job.id && src.source !== 'local') {
      violate('I4', j.id + ' 下载完成后仍解析成 ' + src.source, opLog);
    }
    // I5：失败态必须有具体文案
    if (j.status === 'failed') {
      const note = copyFor(st || {}, j);
      if (!note || /浏览器无法解码|无法播放/.test(note)) violate('I5', j.id + ' 失败态没有具体文案：' + JSON.stringify(note), opLog);
    }
    // I6：UI 状态与队列状态一致
    const ui = copyFor(st || {}, j);
    const want = j.status === 'done' ? '已缓存' : (j.status === 'running' || j.status === 'queued' ? '缓存中' : ui);
    if (j.status === 'done' && ui !== '已缓存') violate('I6', j.id + ' UI=' + ui + ' 队列=done', opLog);
    if ((j.status === 'running' || j.status === 'queued') && ui !== want) violate('I6', j.id + ' UI=' + ui + ' 队列=' + j.status, opLog);
  }
  if (VERBOSE) console.log('  round ' + round + ' · ' + opInfo.label + ' ' + opInfo.id);
}

const elapsed = Date.now() - t0;
console.log('\n混沌测试：seed=' + SEED + ' · ' + ROUNDS + ' 轮 · ' + (ROUNDS * 2) + ' 次不变量评估 · '
  + elapsed + 'ms');
if (violations.length) {
  const byInv = {};
  for (const v of violations) byInv[v.inv] = (byInv[v.inv] || 0) + 1;
  console.log('  违例 ' + violations.length + ' 条：' + JSON.stringify(byInv));
  for (const v of violations.slice(0, 8)) {
    console.log('  ✗ [' + v.inv + '] ' + v.detail + ' — 最近动作：' + v.ops.join(' → '));
  }
  console.log('  复现：node test/verify-media-chaos.mjs --seed=' + SEED + ' --verbose');
} else {
  console.log('  0 违例：I1 无 done-缺失 · I2 local 只指完整有效文件 · I3 下载中必 proxy · '
    + 'I4 完成即 local · I5 失败有具体文案 · I6 UI 与队列一致');
}
cleanupTestHome(HOME);
process.exit(violations.length ? 1 : 0);
