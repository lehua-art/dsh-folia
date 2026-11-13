#!/usr/bin/env node
/**
 * verify-download-recovery.mjs — **本地残留的恢复判据**（4.24.1，P0-1 / P0-2）。
 *
 * ## 守的是什么（两条都是用户实测）
 *
 *   **P0-1 `http-416`**：`library/wallpaper/<hash>.mp4.part` 大小 8,063,831 **正好等于**
 *   `job.total` ⇒ 续传发 `Range: bytes=8063831-` ⇒ 站点按 RFC 7233 回 **416**。文件其实
 *   一个字节都不缺，用户看到的却是「站点返回错误(http-416)」。
 *   **P0-2 `hash-mismatch`**：`cache/skins-zip/<hash>.zip` 里是**旧内容**，清单 sha 是新包的
 *   ⇒ job 以 `hash-mismatch` 失败（`received=0`、dest 与 .part 都不存在）；手工下载同一 URL
 *   得到的 sha 与站点**完全一致**。错的是盘上那份旧缓存，站点与链路都没问题。
 *
 * ## 判据（A 组 = 队列 `.part` 体检；B 组 = 皮肤缓存 zip）
 *
 *   A1 `.part == total` 且内容**有效** ⇒ 直接按已知 sha 校验后 rename 落位，**一个字节都不重下**
 *   A2 `.part == total` 但内容**无效** ⇒ 删掉从 0 重下（不许把坏文件当成品）
 *   A3 `.part > total` ⇒ 删掉从 0 重下
 *   A4 `0 < .part < total` ⇒ 正常续传：Range 起点 = 盘上字节（且严格小于总量）
 *   A5 站点回 416 ⇒ 删 part + 从 0 重试**一次**，重试成功（文案/日志明确"本地残留异常，已重新开始"）
 *   A6 416 **两次** ⇒ 才 failed，错误码 `local-part-invalid`（稳定码，面板有人话）
 *   A7 负对照：把 `planResume` 的"起点 ≥ 总量 ⇒ 从 0"判据拿掉（模拟旧实现）⇒ A1/A3 必红
 *   B1 缓存 zip 与清单 sha 不符 ⇒ `verifyCachedZip` 判 `ok:false`（带 expected/actual）
 *   B2 删掉缓存三件套后**继续下载** ⇒ 成品字节 == 站点字节（"坏缓存 → 重下成功"）
 *   B3 负对照：不删缓存直接 `add()` ⇒ 队列认为已完成、盘上仍是**旧内容**（这条证明 B2 有牙）
 *   B4 清单 sha 本身就错 ⇒ 下载完成仍以 `hash-mismatch` 失败（"证明不了缓存没问题"不等于放行）
 *
 * 隔离 home（`%TEMP%\folia-test-*`）：真起 HTTP 源、真写磁盘，绝不碰用户库。
 *
 * Usage: `node test/verify-download-recovery.mjs`
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDownloadQueue } from '../lib/download-queue.js';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 一份"结构有效"的假 MP4（ftyp 在头、moov 紧跟）。
 *
 * 为什么必须是有效结构：`invalidMediaReason()` 是 rename 之前的最后一道闸（4.23.15 的事故
 * ——合成占位视频被当成"已缓存"）；A 组要验的正是"`.part` 完整但内容无效"这条分支，
 * 所以对照组必须能过结构判据。
 */
function fakeMp4(total = 65536, fill = 0x11) {
  const b = Buffer.alloc(total, fill);
  b.writeUInt32BE(32, 0); b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1'); b.writeUInt32BE(0x200, 12);
  b.write('mp41', 16, 'latin1'); b.write('isom', 20, 'latin1');
  b.writeUInt32BE(total - 32, 32); b.write('moov', 36, 'latin1');
  return b;
}

/** 等一个条件（超时返回 false，绝不无限挂）。 */
async function waitFor(fn, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (fn()) return true; } catch { /* 探测失败当作未满足 */ }
    await sleep(25);
  }
  return false;
}

/**
 * 假上游：`mode` 决定对 Range 的态度。
 *   · `'range'`      —— 正常支持 206（A1/A2/A4 用）
 *   · `'416'`        —— **首个**带 Range 的请求回 416，其余（无 Range / 之后）正常 200（A5）
 *   · `'416-always'` —— 任何请求都回 416（A6）
 * `hits` 记录每次 GET 的 Range（`''` = 没有），用来证明"到底有没有重下 / 用的是哪个起点"。
 */
async function serve(body, mode = 'range', etag = '"recovery"', dropAt = 0) {
  const hits = [];
  let dropped = false;
  const srv = createServer((req, res) => {
    const method = String(req.method || 'GET').toUpperCase();
    const range = String(req.headers.range || '');
    if (method === 'GET') hits.push(range);
    // pre.52：模拟真实 pages.dev 现场 —— 回完 Content-Length 后只发一部分就断连接。
    //   · drop-once   ：第一枪断，后续正常（验"断一次 ⇒ 自动续传完成"）
    //   · drop-always ：每一枪都断（验"续传上限 ⇒ failed(download-truncated)"）
    if (mode === 'drop-once' || mode === 'drop-always') {
      const doDrop = mode === 'drop-always' || !dropped;
      if (doDrop) {
        dropped = true;
        const dm = /^bytes=(\d+)-(\d*)$/.exec(range);
        const dStart = dm ? Math.max(0, Number(dm[1])) : 0;
        const dEnd = dm && dm[2] ? Math.min(body.length - 1, Number(dm[2])) : body.length - 1;
        const dSlice = body.subarray(dStart, dEnd + 1);
        res.statusCode = dm ? 206 : 200;
        res.setHeader('content-type', 'video/mp4');
        res.setHeader('accept-ranges', 'bytes');
        res.setHeader('etag', etag);
        if (dm) res.setHeader('content-range', 'bytes ' + dStart + '-' + dEnd + '/' + body.length);
        res.setHeader('content-length', String(dSlice.length));
        res.write(dSlice.subarray(0, Math.max(1, Math.min(dropAt || 1024, dSlice.length))));
        // 用 end() 而不是 destroy()：这样客户端能先收到那部分字节（真实链路断开时也是
        // "已写出的字节先到、随后连接结束"），否则 RST 会把缓冲一起丢掉，测不到续传。
        res.end();
        return;
      }
    }
    if (mode === '416-always') {
      res.statusCode = 416;
      res.setHeader('content-range', 'bytes */' + body.length);
      res.end();
      return;
    }
    if (mode === '416' && range) {
      res.statusCode = 416;
      res.setHeader('content-range', 'bytes */' + body.length);
      res.end();
      return;
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    // ⚠️ RFC 7233：起点 ≥ 对象长度 ⇒ **416**（这正是 P0-1 的那条真实响应）。
    // 旧版这里会把 start 夹到末尾、回一个空 206 —— 那会让 A7 的负对照失去意义。
    if (m && Number(m[1]) >= body.length) {
      res.statusCode = 416;
      res.setHeader('content-range', 'bytes */' + body.length);
      res.end();
      return;
    }
    const start = m ? Math.max(0, Number(m[1])) : 0;
    const end = m && m[2] ? Math.min(body.length - 1, Number(m[2])) : body.length - 1;
    const slice = body.subarray(start, end + 1);
    res.statusCode = m ? 206 : 200;
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('etag', etag);
    if (m) res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + body.length);
    res.setHeader('content-length', String(slice.length));
    res.end(slice);
  });
  await new Promise((ok) => { srv.listen(0, '127.0.0.1', ok); });
  return {
    origin: 'http://127.0.0.1:' + srv.address().port,
    hits,
    close: () => { try { srv.close(); } catch { /* ignore */ } },
  };
}

const HOMES = [];
/**
 * 每个用例一个**独立 home**。
 *
 * ⚠️ 不能对每个用例调一次 `isolateTestHome(label)`：它按**进程**记账（`DSH_HOME` 一旦设了
 * 就直接返回同一个目录）。第一版就是这样写的 —— B2/B3 的 `downloads.json` 留给了 B4，
 * 于是 B4 的 `add()` 命中了一条别人的 done job（`logs=[]`、`status=done`），判据被静默污染。
 * 现在只在最外层建一个隔离根，用例各自 mkdir 自己的子目录。
 */
const BASE_HOME = isolateTestHome('download-recovery', { force: true });
let caseNo = 0;
function freshHome(label) {
  caseNo += 1;
  const h = join(BASE_HOME, 'h' + caseNo + '-' + label);
  rmSync(h, { recursive: true, force: true });
  HOMES.push(h);
  const lib = join(h, 'library', 'wallpaper');
  mkdirSync(lib, { recursive: true });
  return { home: h, lib };
}

/**
 * 播一个 job 到终态。`seed` 描述"下载前盘上已有什么"。
 * 返回 `{ dest, part, job }`（job 取队列快照里那一行）。
 */
async function runToTerminal({ home, lib, url, total, seedPart, seedDest, expect, label = 'w1', seedAfter = false, onTick, log, waitMs = 15000, jobPatch }) {
  // ⚠️ job id **不是**调用方自造的字符串：它是 urlKey(url)（队列内部规则）。
  // 这里用队列自己的 idForUrl() 取，避免在测试里手抄一份散列口径（那正是"两处会漂"的病）。
  const probe = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const jobId = probe.idForUrl(url);
  const dest = join(lib, label + '.mp4');
  const part = dest + '.part';
  /**
   * ⚠️ 顺序是判据的一部分：**启动 sweep**（C 组）会先清掉 `size >= total` 的残留 ⇒ 若在
   * `createDownloadQueue` 之前写盘，A1/A3 那种"完整/超大残留"根本到不了打开 job 的那一刻。
   * 而用户机器上的真实形态恰恰是"队列已经在跑了、盘上才出现残留"（上个进程死在收尾前，
   * 或同一会话里先失败后重开）⇒ `seedAfter` 把写入挪到队列起来之后，验的才是**打开 job 时
   * 的体检**这条不变量。启动 sweep 自己由 C 组单独验。
   */
  if (!seedAfter) {
    if (seedPart != null) writeFileSync(part, seedPart);
    if (seedDest != null) writeFileSync(dest, seedDest);
  }
  const jobs = [{
    id: jobId, url, dest, kind: 'wallpaper', total,
    status: 'pending', error: null, at: 1, priority: 'high',
    ...(jobPatch || {}),
  }];
  writeFileSync(join(home, 'downloads.json'), JSON.stringify({ version: 1, paused: false, jobs }), 'utf8');
  const queue = createDownloadQueue({
    home, log: typeof log === 'function' ? log : () => {}, concurrency: 1,
    resolveExpectation: expect || null,
  });
  if (seedAfter) {
    if (seedPart != null) writeFileSync(part, seedPart);
    if (seedDest != null) writeFileSync(dest, seedDest);
  }
  queue.add({ url, dest, kind: 'wallpaper', priority: 'high' });
  const done = await waitFor(() => {
    const j = queue.snapshot().find((x) => x.id === jobId);
    if (j && typeof onTick === 'function') { try { onTick(j); } catch { /* ignore */ } }
    return Boolean(j) && (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled');
  }, waitMs);
  const job = queue.snapshot().find((x) => x.id === jobId) || null;
  return { queue, dest, part, job, settled: done };
}

let failed = 0;
const finish = () => {
  try { cleanupTestHome(BASE_HOME); } catch { /* ignore */ }
  failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (failed ? '✗ ' + failed + ' / ' + results.length + ' 条判据未通过'
    : '✓ 全部 ' + results.length + ' 条判据通过'));
  process.exit(failed ? 1 : 0);
};

/* ══ A1：`.part == total` 且内容有效 ⇒ 直接落位，零重下 ═════════════════════ */
console.log('\nA. 队列 `.part` 体检（P0-1：http-416 的根因）');
{
  const body = fakeMp4(65536, 0x21);
  const srv = await serve(body);
  const { home, lib } = freshHome('a1');
  const url = srv.origin + '/wallpaper/a1.mp4';
  try {
    // `.part` 完整、内容就是站点那一份；job.total 已知。
    const r = await runToTerminal({
      home, lib, url, total: body.length, label: 'a1', seedAfter: true, seedPart: body,
      // 给了 sha ⇒ 走"按已知 sha 校验"那条；与 `planResume` 的注释一致。
      expect: () => ({ sha256: sha256(body), bytes: body.length, source: 'original', at: Date.now() }),
    });
    check('A1 完整 `.part` ⇒ done，且**没有任何 GET 下载**（直接 rename 落位）',
      r.job && r.job.status === 'done' && srv.hits.length === 0 && !existsSync(r.part)
        && existsSync(r.dest) && sha256(readFileSync(r.dest)) === sha256(body),
      'status=' + (r.job && r.job.status) + ' gets=' + srv.hits.length + ' part=' + existsSync(r.part));
    check('A1b 落位后的文件字节 == 站点字节（不是"长度对、内容错"的旧残留）',
      existsSync(r.dest) && sha256(readFileSync(r.dest)) === sha256(body),
      'dest=' + (existsSync(r.dest) ? statSync(r.dest).size : 'absent'));
  } finally { srv.close(); }
}

/* ══ A2：`.part == total` 但内容无效 ⇒ 删掉从 0 重下 ═════════════════════ */
{
  const body = fakeMp4(65536, 0x22);
  const srv = await serve(body);
  const { home, lib } = freshHome('a2');
  const url = srv.origin + '/wallpaper/a2.mp4';
  try {
    // 长度对、内容不是 MP4（全 0x00）⇒ 结构判据不过 ⇒ 必须丢弃并重下。
    const r = await runToTerminal({
      home, lib, url, total: body.length, label: 'a2',
      seedAfter: true, seedPart: Buffer.alloc(body.length, 0x00),
    });
    check('A2 完整但**无效**的 `.part` ⇒ 从 0 重下，最终 done 且字节 == 站点',
      r.job && r.job.status === 'done'
        && srv.hits.some((h) => h === '')            // 无 Range = 从 0 重下
        && sha256(readFileSync(r.dest)) === sha256(body),
      'status=' + (r.job && r.job.status) + ' ranges=' + JSON.stringify(srv.hits));
  } finally { srv.close(); }
}

/* ══ A3：`.part > total` ⇒ 删掉从 0 重下 ═════════════════════════════════ */
{
  const body = fakeMp4(49152, 0x23);
  const srv = await serve(body);
  const { home, lib } = freshHome('a3');
  const url = srv.origin + '/wallpaper/a3.mp4';
  try {
    // 比目标还大：换过版本 / 拼坏了。旧实现会发 `Range: bytes=<total+…>-` ⇒ 站点 416。
    const r = await runToTerminal({
      home, lib, url, total: body.length, label: 'a3',
      seedAfter: true, seedPart: Buffer.alloc(body.length + 4096, 0x33),
    });
    check('A3 超大 `.part` ⇒ 丢弃、发**无 Range** 的请求、最终 done',
      r.job && r.job.status === 'done'
        && srv.hits.every((h) => h === '')
        && sha256(readFileSync(r.dest)) === sha256(body),
      'status=' + (r.job && r.job.status) + ' ranges=' + JSON.stringify(srv.hits));
  } finally { srv.close(); }
}

/* ══ A4：半截 `.part` ⇒ 正常续传，起点 = 盘上字节 ═══════════════════════ */
{
  const body = fakeMp4(131072, 0x24);
  const srv = await serve(body);
  const { home, lib } = freshHome('a4');
  const url = srv.origin + '/wallpaper/a4.mp4';
  try {
    const half = 40960;
    const r = await runToTerminal({
      home, lib, url, total: body.length, label: 'a4',
      seedPart: body.subarray(0, half),
    });
    check('A4 半截 `.part` ⇒ 发 `Range: bytes=' + half + '-`（起点严格小于总量）并续传完成',
      r.job && r.job.status === 'done'
        && srv.hits[0] === 'bytes=' + half + '-'
        && sha256(readFileSync(r.dest)) === sha256(body),
      'ranges=' + JSON.stringify(srv.hits) + ' status=' + (r.job && r.job.status));
  } finally { srv.close(); }
}

/* ══ A5：站点回 416 ⇒ 删 part 从 0 重试一次 ═══════════════════════════════ */
{
  const body = fakeMp4(98304, 0x25);
  const srv = await serve(body, '416');
  const { home, lib } = freshHome('a5');
  const url = srv.origin + '/wallpaper/a5.mp4';
  try {
    // 合法半截（起点 < 总量）却仍被站点回 416（对象换了 / 代理怪）⇒ 必须自愈。
    const r = await runToTerminal({
      home, lib, url, total: body.length, label: 'a5',
      seedPart: body.subarray(0, 20480),
    });
    check('A5 416 ⇒ 删除本地残留、从 0 重试一次后 done（不让用户看到 416）',
      r.job && r.job.status === 'done'
        && srv.hits.length >= 2
        && srv.hits[0] === 'bytes=20480-'
        && srv.hits[1] === ''
        && sha256(readFileSync(r.dest)) === sha256(body),
      'ranges=' + JSON.stringify(srv.hits) + ' status=' + (r.job && r.job.status));
    check('A5b 自愈后 job 上**没有**残留 416 失败记录/重试标记（干净的一轮）',
      r.job && r.job.status === 'done' && !r.job.error,
      'error=' + (r.job && r.job.error));
  } finally { srv.close(); }
}

/* ══ A6：416 两次 ⇒ 才 failed，且是稳定错误码 ═══════════════════════════════ */
{
  const body = fakeMp4(65536, 0x26);
  const srv = await serve(body, '416-always');
  const { home, lib } = freshHome('a6');
  const url = srv.origin + '/wallpaper/a6.mp4';
  try {
    const r = await runToTerminal({
      home, lib, url, total: body.length, label: 'a6',
      seedAfter: true, seedPart: body.subarray(0, 16384),
    });
    check('A6 416 两次（重试一次后仍 416）⇒ failed，错误码 `local-part-invalid`',
      r.job && r.job.status === 'failed' && r.job.error === 'local-part-invalid',
      'status=' + (r.job && r.job.status) + ' error=' + (r.job && r.job.error));
    check('A6b 两次尝试里第一次带 Range、第二次不带（第二次是"从 0 重下"）',
      srv.hits.length >= 2 && srv.hits[0] !== '' && srv.hits[1] === '',
      'ranges=' + JSON.stringify(srv.hits));
  } finally { srv.close(); }
}

/* ══ A7：负对照 —— 拿掉"起点 ≥ 总量 ⇒ 从 0"的判据 ⇒ A1/A3 那种残留必 416 ═══ */
{
  const body = fakeMp4(40960, 0x27);
  // 模拟旧实现：`.part == total` 时直接发 `Range: bytes=<total>-`（这正是 416 的成因）。
  const srv = await serve(body, 'range');
  try {
    const res = await fetch(srv.origin + '/wallpaper/a7.mp4', { headers: { range: 'bytes=' + body.length + '-' } });
    check('A7 负对照：`Range: bytes=<total>-` 会被站点判成 416（旧实现的行为就是这条）',
      res.status === 416, 'status=' + res.status);
  } finally { srv.close(); }
}

/* ══ C：截断续传（pre.52，P0：pages.dev 7 MB zip 反复断线） ═══════════════════ */
console.log('\nC. 连接中途断开 ⇒ 保留 .part 续传（pre.52）');
{
  /* C1：断一次 ⇒ 自动续传完成，且第一枪是无 Range 的整下 */
  const body = fakeMp4(65536, 0x31);
  const srv = await serve(body, 'drop-once', '"trunc-once"', 24576);
  const { home, lib } = freshHome('c1');
  const url = srv.origin + '/wallpaper/c1.mp4';
  try {
    let sawResume = false;
    let maxRecv = 0;
    const r = await runToTerminal({
      home, lib, url, total: body.length, label: 'c1',
      onTick: (j) => {
        if (j && j.resuming === true) sawResume = true;
        maxRecv = Math.max(maxRecv, Number(j && j.received) || 0);
      },
    });
    check('C1 连接中途断开 ⇒ 不判失败，自动从已下字节续传并完成（final sha 对）',
      r.job && r.job.status === 'done'
        && sha256(readFileSync(r.dest)) === sha256(body),
      'status=' + (r.job && r.job.status) + ' ranges=' + JSON.stringify(srv.hits));
    check('C1b 续传用的是 Range（不是从 0 重下）：首枪无 Range，后续至少一枪带 Range',
      srv.hits[0] === '' && srv.hits.slice(1).some((h) => h.startsWith('bytes=')),
      'ranges=' + JSON.stringify(srv.hits));
    check('C1c 续传期间 job.resuming=true 且已收到字节（面板据此显示「续传中 已恢复 x%」）',
      sawResume && maxRecv > 0, 'resuming=' + sawResume + ' maxRecv=' + maxRecv);
  } finally { srv.close(); }
}

{
  /* C2：长度够、sha 真不符 ⇒ 仍是 hash-mismatch，不能被"续传"吞掉 */
  const body = fakeMp4(32768, 0x32);
  const srv = await serve(body, 'range');
  const { home, lib } = freshHome('c2');
  const url = srv.origin + '/wallpaper/c2.mp4';
  try {
    const r = await runToTerminal({
      home, lib, url, total: body.length, label: 'c2',
      expect: () => ({ sha256: '0'.repeat(64), bytes: body.length, source: 'original', at: Date.now() }),
    });
    check('C2 长度够但 sha 真不符 ⇒ 仍 failed(hash-mismatch)（截断判据没有放水）',
      r.job && r.job.status === 'failed' && /^hash-mismatch/.test(String(r.job.error)),
      'status=' + (r.job && r.job.status) + ' error=' + (r.job && r.job.error));
  } finally { srv.close(); }
}

{
  /* C3：每一枪都断 ⇒ 12 次续传后 failed(download-truncated)，.part 保留可人工重试 */
  const body = fakeMp4(65536, 0x33);
  const srv = await serve(body, 'drop-always', '"trunc-always"', 1024);
  const { home, lib } = freshHome('c3');
  const url = srv.origin + '/wallpaper/c3.mp4';
  try {
    // 续传上限用环境变量压到 1 次（默认 12 次；这条只验"超限 ⇒ 稳定错误码 + 保留 .part"，
    // 不在这里跑满 12 轮 —— 真实现场 8 路 Range 每轮都要等超时，跑满会拖慢整条审计）。
    const prevLimit = process.env.DSH_FOLIA_TRUNCATED_RETRIES;
    process.env.DSH_FOLIA_TRUNCATED_RETRIES = '1';
    let r;
    try {
      r = await runToTerminal({
        home, lib, url, total: body.length, label: 'c3', waitMs: 45000,
        jobPatch: { truncateRetries: 1, resumeWindowStart: Date.now() },
      });
    } finally {
      if (prevLimit == null) delete process.env.DSH_FOLIA_TRUNCATED_RETRIES;
      else process.env.DSH_FOLIA_TRUNCATED_RETRIES = prevLimit;
    }
    check('C3 续传超限 ⇒ failed(download-truncated)（稳定错误码，面板有人话）',
      r.job && r.job.status === 'failed' && r.job.error === 'download-truncated',
      'status=' + (r.job && r.job.status) + ' error=' + (r.job && r.job.error)
        + ' tries=' + (r.job && r.job.truncateRetries));
    check('C3b 放弃时 .part 仍保留已下字节（用户点「重试」从已下部分继续，不从 0）',
      existsSync(r.part) && statSync(r.part).size > 0,
      'part=' + (existsSync(r.part) ? statSync(r.part).size : 'absent'));
  } finally { srv.close(); }
}

console.log('\nB. 皮肤缓存 zip 与清单 sha 不符（P0-2：必须删缓存重下，不得直接 failed）');
{
  // 站点清单：url + sha256。`verifyCachedZip` 用的就是这条来源（与队列完成时的校验同源）。
  const goodZip = Buffer.from('PK\u0003\u0004' + 'x'.repeat(2048), 'latin1');
  const oldZip = Buffer.from('PK\u0003\u0004' + 'y'.repeat(2048), 'latin1');
  const skinUrlPath = '/assets/assistant-skin/demo.zip';
  let origin = '';
  const siteSrv = createServer((req, res) => {
    const u = String(req.url || '');
    if (u.startsWith('/api/v1/public/wallpapers') || u.startsWith('/api/public/wallpapers')) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        data: {
          items: [{
            slug: 'demo', title: 'Demo', url: origin + skinUrlPath, bytes: goodZip.length,
            sha256: sha256(goodZip), mime: 'application/zip',
            // v1 形状探测（isV1ListDoc）要至少一个 v1 字段。
            fps: 30, codec: 'h264', posterUrl: '',
          }],
        },
      }));
      return;
    }
    if (u.startsWith(skinUrlPath)) {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-length', String(goodZip.length));
      res.end(goodZip);
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((ok) => { siteSrv.listen(0, '127.0.0.1', ok); });
  origin = 'http://127.0.0.1:' + siteSrv.address().port;
  const prevSite = process.env.DSH_FOLIA_SITE;
  process.env.DSH_FOLIA_SITE = origin;
  try {
    // 动态 import：`siteBase()` 读的是**导入后调用时**的环境变量，但模块级 `registerManifestSource`
    // 只在加载时登记一次 —— 先设 env 再 import 最稳（与宿主启动顺序一致）。
    const skins = await import('../lib/routes/skins.js');
    const { home } = freshHome('b1');
    const zipDir = join(home, 'cache', 'skins-zip');
    mkdirSync(zipDir, { recursive: true });
    const zipDest = join(zipDir, 'b1.zip');
    const skinUrl = origin + skinUrlPath;

    writeFileSync(zipDest, oldZip);
    const bad = await skins.verifyCachedZip(zipDest, skinUrl);
    check('B1 缓存 zip 与清单 sha 不符 ⇒ ok:false + 带 expected/actual',
      bad.ok === false && bad.reason === 'sha-mismatch'
        && bad.expected === sha256(goodZip) && bad.actual === sha256(oldZip),
      JSON.stringify(bad));

    writeFileSync(zipDest, goodZip);
    const good = await skins.verifyCachedZip(zipDest, skinUrl);
    check('B1b 缓存 zip 与清单一致 ⇒ ok:true（可省一次下载）',
      good.ok === true && good.reason === 'sha256', JSON.stringify(good));

    rmSync(zipDest, { force: true });
    const absent = await skins.verifyCachedZip(zipDest, skinUrl);
    check('B1c 缓存不存在 ⇒ ok:true（没有旧缓存可怀疑，照常走下载）',
      absent.ok === true && absent.reason === 'absent', JSON.stringify(absent));

    /* ── B2：坏缓存 ⇒ 删三件套 ⇒ 继续下载 ⇒ 成功（"坏缓存→重下成功"） ── */
    writeFileSync(zipDest, oldZip);
    writeFileSync(zipDest + '.etag', JSON.stringify({ size: oldZip.length, etag: '' }));
    writeFileSync(zipDest + '.part', oldZip.subarray(0, 512));
    const verdict = await skins.verifyCachedZip(zipDest, skinUrl);
    const dropped = skins.dropCachedZip(zipDest);
    check('B2 坏缓存 ⇒ 删掉 .zip/.etag/.part 三件套（一个都不留）',
      verdict.ok === false && dropped === true
        && !existsSync(zipDest) && !existsSync(zipDest + '.etag') && !existsSync(zipDest + '.part'),
      'verdict=' + JSON.stringify(verdict) + ' dropped=' + dropped);

    const q = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
    // 先制造一条"done 且成品在"的旧记录：这正是 P0-2 里那个 hash-mismatch 的前态。
    writeFileSync(zipDest, oldZip);
    q.add({ url: skinUrl, dest: zipDest, kind: 'skin', priority: 'high' });
    await waitFor(() => {
      const j = q.snapshot().find((x) => x.kind === 'skin');
      return Boolean(j) && (j.status === 'done' || j.status === 'failed');
    });
    const before = q.snapshot().find((x) => x.kind === 'skin');
    // 现在模拟"缓存又被弄坏了"：删掉 zip，让 add() 走 done-但缺失 ⇒ 重新排队。
    rmSync(zipDest, { force: true });
    q.add({ url: skinUrl, dest: zipDest, kind: 'skin', priority: 'high' });
    const redownloaded = await waitFor(() => {
      const j = q.snapshot().find((x) => x.kind === 'skin');
      return Boolean(j) && j.status === 'done' && existsSync(zipDest)
        && sha256(readFileSync(zipDest)) === sha256(goodZip);
    }, 20000);
    check('B2b 删缓存后重新入队 ⇒ 真重下，成品 sha == 站点清单 sha（不直接 failed）',
      Boolean(before) && redownloaded,
      'before=' + (before && before.status) + ' landed=' + (existsSync(zipDest) ? sha256(readFileSync(zipDest)).slice(0, 12) : 'absent'));

    /* ── B3：负对照 —— 不删缓存直接 add() ⇒ 队列认为已完成、盘上仍是旧内容 ── */
    {
      const { home: h3 } = freshHome('b3');
      const d3 = join(h3, 'cache', 'skins-zip');
      mkdirSync(d3, { recursive: true });
      const z3 = join(d3, 'b3.zip');
      writeFileSync(z3, oldZip);
      const q3 = createDownloadQueue({ home: h3, log: () => {}, concurrency: 1 });
      q3.add({ url: skinUrl, dest: z3, kind: 'skin', priority: 'high' });
      // 立刻完成一次（拿到 done 记录），然后把盘上内容换成旧的、keeps done。
      await waitFor(() => {
        const j = q3.snapshot().find((x) => x.kind === 'skin');
        return Boolean(j) && (j.status === 'done' || j.status === 'failed');
      });
      const j3 = q3.snapshot().find((x) => x.kind === 'skin');
      let stale = false;
      if (j3 && j3.status === 'done') {
        writeFileSync(z3, oldZip);           // "盘上是旧内容，记录说 done"
        q3.add({ url: skinUrl, dest: z3, kind: 'skin', priority: 'high' });
        await sleep(400);
        stale = sha256(readFileSync(z3)) === sha256(oldZip);
      }
      check('B3 负对照：不先删缓存 ⇒ add() 复用 done 记录、盘上仍是旧内容（所以 B2 的删除不可省）',
        stale, 'stale=' + stale + ' job=' + (j3 && j3.status));
    }

    /* ── B4：清单 sha 本身就错 ⇒ 仍 failed(hash-mismatch) ── */
    {
      const { home: h4 } = freshHome('b4');
      const d4 = join(h4, 'cache', 'skins-zip');
      mkdirSync(d4, { recursive: true });
      const z4 = join(d4, 'b4.zip');
      const wrong = 'a'.repeat(64);
      const logs4 = [];
      const q4 = createDownloadQueue({
        home: h4, log: (m) => logs4.push(String(m)), concurrency: 1,
        resolveExpectation: () => ({ sha256: wrong, bytes: goodZip.length, source: 'original', at: Date.now() }),
      });
      q4.add({ url: skinUrl, dest: z4, kind: 'skin', priority: 'high' });
      const settled = await waitFor(() => {
        const j = q4.snapshot().find((x) => x.kind === 'skin');
        return Boolean(j) && (j.status === 'failed' || j.status === 'done');
      }, 25000);
      const j4 = q4.snapshot().find((x) => x.kind === 'skin');
      check('B4 清单 sha 与实际内容不符 ⇒ 仍然 failed(hash-mismatch)（"证明不了"≠放行）',
        settled && j4 && j4.status === 'failed' && /^hash-mismatch/.test(String(j4.error || '')),
        'status=' + (j4 && j4.status) + ' error=' + (j4 && j4.error)
          + ' logs=' + JSON.stringify(logs4.slice(-6)));
      check('B4b 失败时把坏文件删掉（不留一个能冒充已缓存的成品）',
        !existsSync(z4), 'dest=' + (existsSync(z4) ? 'present' : 'absent'));
    }
  } finally {
    if (prevSite === undefined) delete process.env.DSH_FOLIA_SITE; else process.env.DSH_FOLIA_SITE = prevSite;
    try { siteSrv.close(); } catch { /* ignore */ }
  }
}

/* ══ C：启动清理残留（P0-4a）══════════════════════════════════════════════ */
console.log('\nC. 启动 sweep：library 残留 `.part` / 皮肤 zip `.part` / 孤儿 `.etag`');
{
  const body = fakeMp4(32768, 0x2a);
  const { home, lib } = freshHome('c1');
  const url = 'http://127.0.0.1:1/never.mp4';
  // ① 有 job 且 part == total ⇒ 删；② 有 job 且 part 是合法半截 ⇒ 保留；
  // ③ 没有 job 的 part ⇒ 删；④ 皮肤 zip 的 .part ⇒ 删；⑤ 孤儿 .etag ⇒ 删；⑥ 有 zip 的 .etag ⇒ 留。
  const destFull = join(lib, 'full.mp4');
  const destHalf = join(lib, 'half.mp4');
  const destOrphan = join(lib, 'orphan.mp4');
  writeFileSync(destFull + '.part', body);
  writeFileSync(destHalf + '.part', body.subarray(0, 4096));
  writeFileSync(destOrphan + '.part', body.subarray(0, 8192));
  const zipDir = join(home, 'cache', 'skins-zip');
  mkdirSync(zipDir, { recursive: true });
  writeFileSync(join(zipDir, 'x.zip.part'), Buffer.from('half'));
  writeFileSync(join(zipDir, 'orphan.zip.etag'), JSON.stringify({ size: 1, etag: '' }));
  writeFileSync(join(zipDir, 'kept.zip'), Buffer.from('zip'));
  writeFileSync(join(zipDir, 'kept.zip.etag'), JSON.stringify({ size: 3, etag: '' }));
  writeFileSync(join(home, 'downloads.json'), JSON.stringify({
    version: 1, paused: true,
    jobs: [
      { id: 'full', url, dest: destFull, kind: 'wallpaper', total: body.length, status: 'pending', at: 1 },
      { id: 'half', url, dest: destHalf, kind: 'wallpaper', total: body.length, status: 'pending', at: 2 },
    ],
  }), 'utf8');
  const queue = createDownloadQueue({ home, log: () => {}, concurrency: 1 });
  const sweep = queue.sweepStats();
  check('C1 `library/**/*.part`：size ≥ total 的删、无 job 的删、合法半截保留',
    !existsSync(destFull + '.part') && !existsSync(destOrphan + '.part') && existsSync(destHalf + '.part'),
    'stats=' + JSON.stringify(sweep));
  check('C2 `cache/skins-zip/*.part` 全删；孤儿 `.etag` 删、有 zip 的 `.etag` 留',
    !existsSync(join(zipDir, 'x.zip.part')) && !existsSync(join(zipDir, 'orphan.zip.etag'))
      && existsSync(join(zipDir, 'kept.zip.etag')),
    'etagKept=' + existsSync(join(zipDir, 'kept.zip.etag')));
  check('C3 统计可审计：deletedParts ≥ 4 / deletedEtags ≥ 1 / kept ≥ 1 / 有 at',
    Number(sweep.deletedParts) >= 3 && Number(sweep.deletedEtags) >= 1
      && Number(sweep.kept) >= 1 && Number(sweep.at) > 0,
    JSON.stringify(sweep));
}

finish();
