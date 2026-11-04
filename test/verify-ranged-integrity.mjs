#!/usr/bin/env node
/**
 * verify-ranged-integrity.mjs — **4.23.7 P0 的回归测试**：多连接 Range 下载的静默损坏。
 *
 * ── 复现的是什么（事故原样，不是构造出来的极端值）────────────────────────────
 * 站点对**同一个 URL** 有两个对象：全量响应给旧版 17,509,106 字节，Range 回源给新版
 * 17,414,581 字节。旧 `fetchRanged` 的四处缺口让这条链路"成功"地拼出一个坏文件：
 *   ① `return end - start + 1`（请求长度当实收）⇒ 收尾 `written !== span` 恒不成立；
 *   ② 只看 `status === 206`，不核对 `Content-Range` 的 start/end/total ⇒ 双版本对象照单全收；
 *   ③ `base === 0` 先 `truncateSync(part, total)` 预填 0x00 ⇒ `onDisk !== total` 恒不成立；
 *   ④ 没有逐片字节计数 ⇒ 短读被吞掉。
 * 结果：文件长度 17,509,106（"对"）、内容错（尾部 94,525 个 0），job 报 `done`，装出来的 zip 坏。
 *
 * ── 六条判据（编号与交付说明一致）────────────────────────────────────────────
 *   1 双版本对象：全量旧版 / Range 新版 + 总量不同 ⇒ **不产出 ranged done**，
 *     错误含 `range-version-mismatch`，回落单流后落地文件的 sha256 = 全量响应的内容哈希；
 *   2 某片短读（body 少于请求）⇒ `range-short` 并回落单流；
 *   3 Range 正常 ⇒ `ranged:4` 成功、sha256 正确（**正向不回归**，并证明内容哈希这一层也通过）；
 *   4 ETag 不一致（206 的 ETag ≠ 全量响应的 ETag）⇒ `range-etag-mismatch` 并回落；
 *   5 内容哈希不符 ⇒ `failed:hash-mismatch` **自动以单流重下一次**（只一次）后成功；
 *     5b 永远不符 ⇒ 停在 failed，文案含"传输内容与站点不一致"，且**只重试了一次**（2 次请求）；
 *   6 「旧实现必须红」的负对照：
 *     (a) 源码级：`fetchRanged` 必须同时具备 逐片 got / got===want / Content-Range / ETag 四道判据，
 *         且不得含旧写法（`return end - start + 1`、`truncateSync(part, total)`）；
 *     (b) 把**旧实现的四处缺口原样贴回去**（本文件内嵌的 legacy 源码）⇒ 同一个判据必须逐条报红；
 *     (c) 真行为：用旧算法跑同一个双版本 server ⇒ 得到"长度对、内容错、尾部 94,525 个 0"的文件，
 *         而本测试对它的断言（sha256 == 正确哈希）**当场会红** ⇒ 证明这条回归测试有牙。
 *
 * Usage: `node test/verify-ranged-integrity.mjs`
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import {
  createWriteStream, existsSync, mkdtempSync, readFileSync, statSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createDownloadQueue, normalizeSha256, parseContentRange } from '../lib/download-queue.js';

const MB = 1024 * 1024;
/** 事故现场的两个长度（差值 94,525 = 旧实现拼出来的尾部 0 的个数）。 */
const OLD_LEN = 17509106;      // 全量响应（站点当前那份 = 正确内容）
const NEW_LEN = 17414581;      // Range 回源的另一个版本
const TAIL_ZEROS = OLD_LEN - NEW_LEN;

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** 每个偏移一个确定的字节（写错位置 / 重复写 / 少写一段都会改变哈希）。 */
function pattern(n, seed) {
  const buf = Buffer.allocUnsafe(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    buf[i] = (x >>> 24) & 0xff;
  }
  return buf;
}

const OLD_BUF = pattern(OLD_LEN, 0x1d);
const NEW_BUF = pattern(NEW_LEN, 0x7e);
const OLD_SHA = sha(OLD_BUF);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

/* ── 假站点：一个 server 一条路径一种"版本行为" ─────────────────────────────── */
function makeServer(handler) {
  const state = { gets: 0, ranges: 0, heads: 0 };
  const srv = createServer((req, res) => {
    const range = String(req.headers.range || '');
    if (req.method === 'HEAD') state.heads += 1;
    else if (range) state.ranges += 1;
    else state.gets += 1;
    try { handler(req, res, state, range); }
    catch { try { res.statusCode = 500; res.end('boom'); } catch { /* ignore */ } }
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({
      srv, state, origin: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close(),
    }));
  });
}

function sendFull(res, buf, etag) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/zip');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-length', String(buf.length));
  if (etag) res.setHeader('etag', etag);
  res.end(buf);
}

/** 206：`object` 是"这个版本的对象"（决定 total 与可用字节），`claim` 是请求的那一段。 */
function sendRange(res, range, object, claimTotal, opts = {}) {
  const m = /bytes=(\d+)-(\d*)/.exec(String(range || ''));
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] !== '' ? Number(m[2]) : claimTotal - 1;
  let body = start >= object.length ? Buffer.alloc(0)
    : object.subarray(start, Math.min(end + 1, object.length));
  if (opts.truncateTo > 0) body = body.subarray(0, Math.min(body.length, opts.truncateTo));
  res.statusCode = 206;
  res.setHeader('content-type', 'application/zip');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-length', String(body.length));
  // ⚠️ Content-Range 恒按**请求的那一段**报（事故站点就是这么回的：段对、总量是另一版）。
  res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + claimTotal);
  if (opts.etag) res.setHeader('etag', opts.etag);
  res.end(body);
}

const home = mkdtempSync(join(tmpdir(), 'folia-ranged-integrity-'));
let homeSeq = 0;
function newQueue(log) {
  homeSeq += 1;
  return createDownloadQueue({ home: join(home, 'q' + homeSeq), log });
}

const envBackup = {
  ranged: process.env.DSH_FOLIA_RANGED,
  chunks: process.env.DSH_FOLIA_CHUNKS,
};
function setEnv(ranged, chunks) {
  if (ranged == null) delete process.env.DSH_FOLIA_RANGED; else process.env.DSH_FOLIA_RANGED = String(ranged);
  if (chunks == null) delete process.env.DSH_FOLIA_CHUNKS; else process.env.DSH_FOLIA_CHUNKS = String(chunks);
}
function restoreEnv() {
  if (envBackup.ranged == null) delete process.env.DSH_FOLIA_RANGED;
  else process.env.DSH_FOLIA_RANGED = envBackup.ranged;
  if (envBackup.chunks == null) delete process.env.DSH_FOLIA_CHUNKS;
  else process.env.DSH_FOLIA_CHUNKS = envBackup.chunks;
}

/** 等 job 收尾（done / failed / cancelled）。 */
async function waitJob(q, ms = 60000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const j = q.snapshot()[0];
    if (j && ['done', 'failed', 'cancelled'].includes(j.status)) return j;
    if (Date.now() > deadline) return j || null;
    await sleep(30);
  }
}

const has = (logs, re) => logs.some((l) => re.test(l));

/* ── ① 双版本对象：全量旧版、Range 新版（总量不同）⇒ 必须被拦下并回落单流 ─────── */
{
  console.log('\n① 双版本对象（全量 17,509,106 / Range 17,414,581 + 总量不同）');
  const up = await makeServer((req, res, state, range) => {
    if (!range) { sendFull(res, OLD_BUF, '"v1-old"'); return; }
    // Ranges 回源到**另一个版本**：段按请求、总量按 NEW_LEN、ETag 也不同。
    sendRange(res, range, NEW_BUF, NEW_LEN, { etag: '"v2-new"' });
  });
  setEnv('1', 4);
  const logs = [];
  const q = newQueue((l) => logs.push(l));
  const dest = join(home, 'case1.zip');
  q.add({ url: up.origin + '/media/v1.zip', dest, kind: 'wallpaper' });
  const j = await waitJob(q);

  check('① 没有产生 "ranged 完成"（旧实现会在这里报 done）', !has(logs, /done \(ranged\)/), logs.filter((l) => /ranged/.test(l)).join(' | '));
  check('① 失败原因是 range-version-mismatch（Content-Range 的 /total 对不上）',
    has(logs, /range-version-mismatch/), (logs.find((l) => /range-version-mismatch/.test(l)) || '（没有）').slice(0, 160));
  check('① 走了既有回落路径（截回切换点 ⇒ 单流续传）',
    has(logs, /fall back to single/) && j && j.mode === 'single', j ? j.status + ' / ' + j.mode : 'no job');
  const ok1 = existsSync(dest) && sha(readFileSync(dest)) === OLD_SHA;
  check('① 回落单流后落地的文件 = 全量响应那份内容（sha256 正确）',
    j && j.status === 'done' && ok1,
    j ? j.status + ' size=' + (existsSync(dest) ? statSync(dest).size : -1) : 'no job');
  check('① 没有任何 Range 分片被当成"已收到"（recv 只来自单流）',
    j && j.received === OLD_LEN && j.total === OLD_LEN,
    j ? j.received + '/' + j.total : 'no job');
  up.close();
}

/* ── ② 某片短读（body 少于请求长度，Content-Range 仍然声称整段）→ range-short ── */
{
  console.log('\n② 某片短读（body 少于请求）');
  const up = await makeServer((req, res, state, range) => {
    if (!range) { sendFull(res, OLD_BUF, '"v1"'); return; }
    // 只发一半就 end：Content-Length 也是真实发出的字节数（干净地短读，不是网络错误）。
    sendRange(res, range, OLD_BUF, OLD_LEN, { etag: '"v1"', truncateTo: Math.floor((OLD_LEN / 4) / 2) });
  });
  setEnv('1', 4);
  const logs = [];
  const q = newQueue((l) => logs.push(l));
  const dest = join(home, 'case2.zip');
  q.add({ url: up.origin + '/media/short.zip', dest, kind: 'wallpaper' });
  const j = await waitJob(q);

  check('② 短读被判成 range-short（旧实现把请求长度当实收 ⇒ 吞掉）',
    has(logs, /range-short/), (logs.find((l) => /range-short/.test(l)) || '（没有）').slice(0, 160));
  check('② 落地文件内容正确（回落单流后 sha256 == 全量响应的哈希）',
    j && j.status === 'done' && existsSync(dest) && sha(readFileSync(dest)) === OLD_SHA,
    j ? j.status : 'no job');
  up.close();
}

/* ── ③ 正向不回归：Range 正常 ⇒ ranged:4 成功、sha256 正确 ──────────────────── */
{
  console.log('\n③ Range 正常（正向不回归）');
  const up = await makeServer((req, res, state, range) => {
    if (!range) { sendFull(res, OLD_BUF, '"good"'); return; }
    sendRange(res, range, OLD_BUF, OLD_LEN, { etag: '"good"' });
  });
  setEnv('1', 4);
  const logs = [];
  const q = newQueue((l) => logs.push(l));
  const dest = join(home, 'case3.zip');
  q.add({ url: up.origin + '/media/good.zip', dest, kind: 'wallpaper', sha256: OLD_SHA });
  const j = await waitJob(q);

  check('③ 走的是多连接且成功（mode=ranged:4）',
    j && j.status === 'done' && j.mode === 'ranged:4', j ? j.status + ' / ' + j.mode : 'no job');
  check('③ 内容哈希这一层也通过（verified=sha256）',
    j && j.verified === 'sha256', j ? String(j.verified) : 'no job');
  check('③ 文件 sha256 == 站点给的 sha256', existsSync(dest) && sha(readFileSync(dest)) === OLD_SHA);
  check('③ 4 条 Range 请求 / 0 次回落',
    up.state.ranges === 4 && !has(logs, /fall back to single/),
    'ranges=' + up.state.ranges);
  up.close();
}

/* ── ④ ETag 不一致（206 的 ETag ≠ 全量响应那次）────────────────────────────── */
{
  console.log('\n④ ETag 不一致');
  const up = await makeServer((req, res, state, range) => {
    if (!range) { sendFull(res, OLD_BUF, '"v1"'); return; }
    // 段与总量都对，但 ETag 换了 ⇒ 这批字节不是"我们正在下的那个对象"。
    sendRange(res, range, OLD_BUF, OLD_LEN, { etag: '"v2"' });
  });
  setEnv('1', 4);
  const logs = [];
  const q = newQueue((l) => logs.push(l));
  const dest = join(home, 'case4.zip');
  q.add({ url: up.origin + '/media/etag.zip', dest, kind: 'wallpaper' });
  const j = await waitJob(q);

  check('④ 判成 range-etag-mismatch',
    has(logs, /range-etag-mismatch/), (logs.find((l) => /range-etag-mismatch/.test(l)) || '（没有）').slice(0, 160));
  check('④ 回落后文件正确', j && j.status === 'done' && existsSync(dest) && sha(readFileSync(dest)) === OLD_SHA,
    j ? j.status : 'no job');
  up.close();
}

/* ── ⑤ / ⑤b 内容哈希不符：自动单流重下一次（只一次）────────────────────────── */
{
  console.log('\n⑤ 内容哈希不符 ⇒ 自动单流重下一次');
  const GOOD = pattern(1 * MB, 0x33);
  const BAD = pattern(1 * MB, 0x44);
  const GOOD_SHA = sha(GOOD);
  // 第一次给坏内容、之后给好内容
  const up = await makeServer((req, res, state, range) => {
    if (!range && state.gets === 1) { sendFull(res, BAD, '"bad"'); return; }
    sendFull(res, GOOD, '"good"');
  });
  setEnv('0', null);                         // 强制单流：先让"第一次下载"就是坏内容
  const logs = [];
  const q = newQueue((l) => logs.push(l));
  const dest = join(home, 'case5.bin');
  q.add({ url: up.origin + '/media/hash.bin', dest, kind: 'wallpaper', sha256: GOOD_SHA });
  const j = await waitJob(q);

  check('⑤ 内容不符被判成 hash-mismatch', has(logs, /hash-mismatch/),
    (logs.find((l) => /hash-mismatch/.test(l)) || '（没有）').slice(0, 160));
  check('⑤ 自动以单流重下一次（日志明写 auto retry once）',
    has(logs, /auto retry once over a single stream/));
  check('⑤ 第二次成功：done + verified=sha256 + 文件哈希正确',
    j && j.status === 'done' && j.verified === 'sha256'
      && existsSync(dest) && sha(readFileSync(dest)) === GOOD_SHA,
    j ? j.status + ' / ' + String(j.verified) : 'no job');
  check('⑤ 只重下了一次（共 2 次全量请求）', up.state.gets === 2, 'gets=' + up.state.gets);
  up.close();
}

{
  console.log('\n⑤b 内容永远不符 ⇒ 停在 failed，只重试一次');
  const GOOD = pattern(256 * 1024, 0x55);
  const BAD = pattern(256 * 1024, 0x66);
  const up = await makeServer((req, res) => { sendFull(res, BAD, '"bad"'); });
  setEnv('0', null);
  const logs = [];
  const q = newQueue((l) => logs.push(l));
  const dest = join(home, 'case5b.bin');
  q.add({ url: up.origin + '/media/bad.bin', dest, kind: 'wallpaper', sha256: sha(GOOD) });
  const j = await waitJob(q);

  check('⑤b 最终 failed，且文案说明"传输内容与站点不一致"',
    j && j.status === 'failed' && /传输内容与站点不一致/.test(String(j.error)), j ? String(j.error) : 'no job');
  check('⑤b 只重试了一次（共 2 次请求，不会无限循环）', up.state.gets === 2, 'gets=' + up.state.gets);
  check('⑤b 坏文件已删除（不留在 dest / 不留 .part）',
    !existsSync(dest) && !existsSync(dest + '.part'));
  up.close();
}

/* ── ⑥ 旧实现必须红：源码判据 + 旧实现内嵌负对照 + 旧算法真行为 ──────────────── */
const REAL_SRC = readFileSync(new URL('../lib/download-queue.js', import.meta.url), 'utf8');
const LEGACY_SRC = `
async function fetchRanged(url, part, from, total, chunks, onChunk) {
  const base = Math.max(0, Math.min(Number(from) || 0, total));
  if (base === 0) {
    writeFileSync(part, Buffer.alloc(0));
    truncateSync(part, total);
  }
  const tasks = [];
  for (let i = 0; i < chunks; i += 1) {
    const start = base + i * size;
    const end = Math.min(total - 1, start + size - 1);
    tasks.push((async () => {
      const r = await fetch(url, { headers: { range: 'bytes=' + start + '-' + end } });
      if (r.status !== 206) throw new Error('range-unsupported-' + r.status);
      const out = createWriteStream(part, { flags: 'r+', start });
      await new Promise((resolve, reject) => {
        src.on('data', (chunk) => { onChunk(Buffer.from(chunk).length); if (!out.write(Buffer.from(chunk))) { src.pause(); out.once('drain', () => src.resume()); } });
        src.on('end', resolve);
        src.on('error', reject);
      });
      await new Promise((resolve) => { out.end(() => resolve(undefined)); });
      return end - start + 1;
    })());
  }
  const sizes = await Promise.all(tasks);
  const written = sizes.reduce((a, b) => a + b, 0);
  if (written !== span) throw new Error('range-size-mismatch:' + written + '/' + span);
  const onDisk = statSync(part).size;
  if (onDisk !== total) throw new Error('range-size-mismatch:disk ' + onDisk + '/' + total);
}
`;

/** 取出一个具名 async 函数的源码（先配平形参表，再配平函数体；默认值里的 `{}` 不会误伤）。 */
function sliceFn(src, name) {
  const at = src.indexOf('async function ' + name + '(');
  if (at < 0) return '';
  let i = src.indexOf('(', at);
  let pd = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1;
    else if (src[i] === ')') { pd -= 1; if (!pd) break; }
  }
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let p = open; p < src.length; p += 1) {
    const ch = src[p];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (!depth) return src.slice(at, p + 1); }
  }
  return src.slice(at);
}

/**
 * 判据本体（纯函数）：`fetchRanged` 必须同时具备四道即时校验，且**不得**含旧写法。
 * 正判据与负对照喂同一个函数 —— 否则"负对照红了"不能证明正判据有牙。
 */
function judgeFetchRanged(src, name = 'fetchRanged') {
  const body = sliceFn(src, name);
  if (!body) return ['找不到 fetchRanged 的实现'];
  const bad = [];
  if (!/got\s*\+=\s*buf\.length/.test(body)) bad.push('① 缺少逐片实收计数（got += buf.length）');
  if (!/got\s*!==\s*want/.test(body)) bad.push('① 缺少 got === 期望长度 的收尾判据');
  if (!/range-short/.test(body)) bad.push('① 缺少 range-short 错误');
  if (!/content-range/i.test(body)) bad.push('② 没有解析 Content-Range');
  if (!/cr\.start\s*!==\s*start/.test(body)) bad.push('② 没有核对 Content-Range 的 start');
  if (!/cr\.end\s*!==\s*end/.test(body)) bad.push('② 没有核对 Content-Range 的 end');
  if (!/cr\.total\s*!==\s*null\s*&&\s*cr\.total\s*!==\s*total/.test(body)) bad.push('② 没有核对 Content-Range 的 /total');
  if (!/range-version-mismatch/.test(body)) bad.push('② 缺少 range-version-mismatch 错误');
  if (!/etag\s*!==\s*expectedEtag/.test(body)) bad.push('③ 没有比较 206 的 ETag 与全量响应的 ETag');
  if (!/range-etag-mismatch/.test(body)) bad.push('③ 缺少 range-etag-mismatch 错误');
  if (!/writeFileSync\(part,\s*Buffer\.alloc\(0\)\)/.test(body)) bad.push('④ 缺少"只建空文件"的写法');
  if (/truncateSync\(\s*part\s*,\s*total\s*\)/.test(body)) bad.push('旧实现：base===0 时预填 total 个 0x00（size 判据恒真）');
  if (/return\s+end\s*-\s*start\s*\+\s*1/.test(body)) bad.push('旧实现：把请求长度 end-start+1 当实收字节');
  return bad;
}

{
  console.log('\n⑥ 旧实现必须红');
  const realBad = judgeFetchRanged(REAL_SRC);
  check('⑥a 现实现通过四道判据（逐片 got / Content-Range / ETag / 不预填）',
    realBad.length === 0, realBad.join('；') || '4 道判据齐备');

  // (b) 把旧实现的四处缺口逐个贴回来 ⇒ 同一个判据必须报红（每条都要报对位置）。
  const mutations = [
    ['① 去掉逐片实收计数', (s) => s.replace('got += buf.length;', '/* got removed */'), /逐片实收计数/],
    ['① 去掉 got===want 收尾判据', (s) => s.replace('if (got !== want)', 'if (false)'), /收尾判据/],
    ['② 去掉 Content-Range 的 /total 核对', (s) => s.replace('if (cr.total !== null && cr.total !== total)', 'if (false)'), /\/total/],
    ['③ 去掉 ETag 一致性判据', (s) => s.replace(/if \(etag && expectedEtag && etag !== expectedEtag\)/, 'if (false)'), /etag/i],
    ['④ 预填 total 个 0x00（旧写法）', (s) => s.replace("writeFileSync(part, Buffer.alloc(0));", "writeFileSync(part, Buffer.alloc(0));\n      truncateSync(part, total);"), /预填/],
    ['① 把请求长度当实收（旧写法）', (s) => s.replace('return got;', 'return end - start + 1;'), /请求长度/],
  ];
  for (const [label, mutate, expectRe] of mutations) {
    const mutated = mutate(REAL_SRC);
    const changed = mutated !== REAL_SRC;
    const bad = judgeFetchRanged(mutated);
    check('⑥b 变异「' + label + '」会被判红且指对位置',
      changed && bad.some((x) => expectRe.test(x)), bad.join('；') || '（没报出来）');
  }

  const legacyBad = judgeFetchRanged(LEGACY_SRC);
  check('⑥c 把旧实现整段贴回去 ⇒ 四处缺口逐条报红',
    legacyBad.length >= 4
      && legacyBad.some((x) => /请求长度/.test(x))
      && legacyBad.some((x) => /预填/.test(x))
      && legacyBad.some((x) => /Content-Range/.test(x))
      && legacyBad.some((x) => /etag/i.test(x)),
    legacyBad.join('；'));

  // (d) 旧算法**真行为**：同一个双版本 server ⇒ 长度对、内容错、尾部 94,525 个 0。
  const up = await makeServer((req, res, state, range) => {
    if (!range) { sendFull(res, OLD_BUF, '"v1-old"'); return; }
    sendRange(res, range, NEW_BUF, NEW_LEN, { etag: '"v2-new"' });
  });
  /** 旧实现的原样重放（只搬了它的四处缺口，字面与 4.23.6 的 lib/download-queue.js 一致）。 */
  async function legacyFetchRanged(url, part, total, chunks) {
    writeFileSync(part, Buffer.alloc(0));
    truncateSync(part, total);
    const size = Math.ceil(total / chunks);
    const tasks = [];
    for (let i = 0; i < chunks; i += 1) {
      const start = i * size;
      const end = Math.min(total - 1, start + size - 1);
      if (start > end) break;
      tasks.push((async () => {
        const r = await fetch(url, { headers: { range: 'bytes=' + start + '-' + end } });
        if (r.status !== 206) throw new Error('range-unsupported-' + r.status);
        const out = createWriteStream(part, { flags: 'r+', start });
        const src = Readable.fromWeb(r.body);
        await new Promise((resolve, reject) => {
          src.on('data', (c) => {
            const b = Buffer.from(c);
            if (!out.write(b)) { src.pause(); out.once('drain', () => src.resume()); }
          });
          src.on('end', resolve);
          src.on('error', reject);
        });
        await new Promise((resolve) => { out.end(() => resolve(undefined)); });
        return end - start + 1;
      })());
    }
    const sizes = await Promise.all(tasks);
    const written = sizes.reduce((a, b) => a + b, 0);
    if (written !== total) throw new Error('range-size-mismatch');
    if (statSync(part).size !== total) throw new Error('range-size-mismatch:disk');
  }
  const legacyDest = join(home, 'legacy.zip');
  let legacyError = null;
  try { await legacyFetchRanged(up.origin + '/media/v1.zip', legacyDest, OLD_LEN, 4); }
  catch (e) { legacyError = e; }
  up.close();

  const legacyBuf = existsSync(legacyDest) ? readFileSync(legacyDest) : Buffer.alloc(0);
  const tail = legacyBuf.subarray(NEW_LEN);
  const tailAllZero = tail.length === TAIL_ZEROS && tail.every((b) => b === 0);
  check('⑥d 旧算法"成功"返回（没有抛错）而产出坏文件 —— 这正是 P0 的静默损坏',
    legacyError === null && legacyBuf.length === OLD_LEN,
    legacyError ? 'legacy threw ' + legacyError.message : 'size=' + legacyBuf.length);
  check('⑥d 旧产物的尾部就是 ' + TAIL_ZEROS + ' 个 0（预填残留），内容 sha256 与正确内容不同',
    tailAllZero && sha(legacyBuf) !== OLD_SHA,
    'tail=' + tail.length + ' zero=' + tailAllZero + ' sha=' + sha(legacyBuf).slice(0, 12) + '…');
  // 本测试 ① 的核心断言 = `status==='done' && sha256===正确哈希`：把它喂给旧产物必须不通过。
  const legacyOutcome = { status: 'done', sha256: sha(legacyBuf), size: legacyBuf.length };
  const accepts = (o) => o.status === 'done' && o.sha256 === OLD_SHA && o.size === OLD_LEN;
  check('⑥e 本测试 ① 的断言能抓住旧产物（旧产物会被判红）',
    accepts(legacyOutcome) === false && accepts({ status: 'done', sha256: OLD_SHA, size: OLD_LEN }) === true,
    'legacy 被拒 / 正确产物通过 = 判据有牙');
}

/* ── 辅助面自检：解析函数（判据的唯一真源）──────────────────────────────────── */
{
  console.log('\n附 解析函数自检');
  check('parseContentRange：正常 / 通配 / 脏头', (() => {
    const a = parseContentRange('bytes 0-99/17509106');
    const b = parseContentRange('bytes 10-19/*');
    const c = parseContentRange('garbage');
    return a && a.start === 0 && a.end === 99 && a.total === OLD_LEN && b && b.total === null && c === null;
  })());
  check('normalizeSha256：只认 64 位十六进制', normalizeSha256('A'.repeat(64)) === 'a'.repeat(64)
    && normalizeSha256('') === '' && normalizeSha256('xyz') === '' && normalizeSha256(null) === '');
}

restoreEnv();

const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (failed ? 'RANGED INTEGRITY CHECKS FAILED' : 'ALL RANGED INTEGRITY CHECKS PASSED')
  + ' — ' + (results.length - failed) + '/' + results.length + ' checks');
process.exit(failed ? 1 : 0);
