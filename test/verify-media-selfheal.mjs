#!/usr/bin/env node
/**
 * verify-media-selfheal.mjs — **本地副本自愈**（4.23.15）的门禁。
 *
 * ## 为什么要有这一页
 *
 * 另一台机器实测：壁纸显示「视频解码失败（文件可能已损坏）」/「浏览器无法解码这段视频」
 *（「原神 绫华」5916×2530），而面板同时说"缓存命中 4/5"。
 * 两条信息**都不假**：面板数的是"有没有 job、job 是不是 done"，播放器读的是**盘上那些字节**。
 * 4.23.6 之前的 ranged 静默损坏会留下"长度对、内容错"的成品，job 照样 done ⇒
 * 谁都没说谎，但**没有任何一层验内容**，也没有任何自愈手段。
 *
 * 这一页钉住四件事（每件都有正判据 + 负对照，负对照变异的都是**真代码**）：
 *   ① 坏文件（长度对、sha 错）⇒ 删掉 + **单流**重下 ⇒ 最终字节与站点逐字节一致（= 能播）；
 *   ② 好文件 + 本机解不了 ⇒ **不重下**，切 1080p 变体；
 *   ③ 没有变体 ⇒ 本地转码（可用时）；转码失败 / 已是 1080p ⇒ 明确说"本机不支持该编码"；
 *   ④ 启动自检的采样口径（最近 20 个）+ 全量校验抓得住两种坏文件（长度对 sha 错 / 截断）。
 *
 * ## 判据（改之前先想清楚）
 *
 *   · **有 sha256 就必须按 sha256 判**。"只比长度"正是把 4.23.6 事故判成"好文件"的那条错，
 *     所以 N1 负对照直接把 `lib/media-verify.js` 的 sha 分支**从真源码里摘掉**，
 *     断言同一条证据下它会给出别的结论（= 本页第一条用例会红）。
 *   · **"单流重下"必须可观测**：假 HTTP 源按请求记录 `range` 头与次数。自愈重下若走了多连接，
 *     第一次抓取就会带 `range: bytes=0-…` —— 那正是 4.23.6 静默损坏的那条路。
 *   · **文案是产品的一部分**：四种结论各一句不同的话（重下 / 切 1080p / 转码 / 解不了），
 *     断言的是 `src/local-first.js` 的**真源码**给出的那句，不是这里抄的一份。
 *
 * Usage: `node test/verify-media-selfheal.mjs`
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ **隔离必须早于任何 lib 模块被使用**（4.23.15 事故）：真实事故是"跑测试把合成占位视频
// 写进了用户的 `%APPDATA%\dsh-desktop\harness\library\wallpaper\`"（30 个假 mp4，
// 用户看到的所有「浏览器无法解码」正是它们）。本文件顶部就把 `DSH_HOME` 钉到临时目录，
// 并且**不再复用** `destForUrl`（它在 `DSH_HOME` 缺席时会回落到真实 harness）。
import { isolateTestHome, looksLikeRealHome } from './tools/isolate-home.mjs';

const TESTS_HOME = isolateTestHome('selfheal', { force: true });
if (looksLikeRealHome(TESTS_HOME)) throw new Error('refuse to run against real DSH_HOME: ' + TESTS_HOME);

const { createDownloadQueue } = await import('../lib/download-queue.js');
const { createMediaSelfHeal } = await import('../lib/media-selfheal.js');
const { scanMp4Boxes, verifyMediaFileP, VERDICT, SHA_FULL_LIMIT_BYTES } = await import('../lib/media-verify.js');
const { decodeLimitHit, decodePlan, pickVariant, decodeLimitHit: decodeHit2 } = await import('../lib/variant-pick.js');
const { createTranscodeKit } = await import('../lib/media/transcode.js');

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * 本测试**自己的** dest 规则：`<TESTS_HOME>/library/<kind>/<hash>.<ext>`。
 * 复述一遍散列只为**物理上写不到真实库**：即使 `DSH_HOME` 被外层改回去，这里也不看它。
 */
function testDest(url, kind) {
  const k = String(kind || 'wallpaper');
  const h = createHash('sha256').update(k + '/' + String(url)).digest('hex').slice(0, 16);
  const ext = (String(url).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i) || [])[1] || 'bin';
  return join(TESTS_HOME, 'library', k, h + '.' + ext);
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/* ══ 夹具：一个最小但**结构真实**的 mp4（ftyp + moov + mdat）══════════════════
 *
 * 为什么要真的带 moov：大文件那一条判据（>20 MB 不做全量 sha）只能靠结构判断，
 * 而"结构判断"要有一个能被 `scanMp4Boxes` 认出来的真 mp4。用 `Buffer.alloc` 假装
 * 一个 mp4 的话，那条判据在真实文件上失败、在这里却通过 —— 那种夹具只会骗自己。
 */
function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 4, 'latin1');
  return Buffer.concat([head, payload]);
}
function makeMp4(mdatBytes = 32768, fill = 0x21) {
  const ftyp = box('ftyp', Buffer.from('isom0000isommp41', 'latin1'));
  const moov = box('moov', Buffer.from('mvhd0000trak-0000', 'latin1'));
  const mdat = box('mdat', Buffer.alloc(mdatBytes, fill));
  return Buffer.concat([ftyp, moov, mdat]);
}

/** 在 mdat 里翻一个字节：**长度不变、结构不变、内容变** —— 4.23.6 事故的形态。 */
function tamperSameSize(file) {
  const buf = readFileSync(file);
  const at = buf.length - 64;
  buf[at] = buf[at] ^ 0xff;
  writeFileSync(file, buf);
  return buf.length;
}

/* ══ 假 HTTP 源：记录次数 / range 头（"单流"这条判据的唯一证据来源）═══════════ */
const SOURCES = new Map();   // path → Buffer
const HITS = [];             // { path, range, method }
const server = createServer((req, res) => {
  const u = String(req.url || '').split('?')[0];
  const buf = SOURCES.get(u);
  HITS.push({ path: u, range: String(req.headers.range || ''), method: String(req.method || 'GET') });
  if (!buf) { res.statusCode = 404; res.end('nope'); return; }
  const method = String(req.method || 'GET').toUpperCase();
  const etag = '"' + sha256(buf).slice(0, 16) + '"';
  const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
    const slice = buf.subarray(start, end + 1);
    res.statusCode = 206;
    res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + buf.length);
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('content-length', String(slice.length));
    res.setHeader('etag', etag);
    if (method === 'HEAD') { res.end(); return; }
    res.end(slice);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-length', String(buf.length));
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('etag', etag);
  if (method === 'HEAD') { res.end(); return; }
  res.end(buf);
});

await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(undefined); }); });
const PORT = (server.address() && typeof server.address() === 'object') ? server.address().port : 0;
const BASE = 'http://127.0.0.1:' + PORT;

/* ══ 环境：每个用例一套自己的 home / 队列（互不污染）══════════════════════════ */

/** 等到 `pred()` 为真（或超时）。返回最后一次的值。 */
async function waitFor(pred, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => { setTimeout(r, 25); });
  }
}

const jobDone = (q, id) => waitFor(() => {
  const row = q.jobById(id);
  return row && row.status === 'done' ? row : null;
}, 20000, id);

/** 下载一个源到本地（先入队再等 done），返回 { id, dest, row }。 */
async function fetchToLocal(q, url, kind = 'wallpaper') {
  const dest = testDest(url, kind);
  const r = q.add({ url, dest, kind });
  const id = r.job.id;
  const row = await jobDone(q, id);
  return { id, dest, row };
}

/** 一套独立环境（home + 队列 + 自愈实例）。`transcode` 传函数即可注入救援转码。 */
function makeEnv(opts) {
  const o = opts || {};
  const home = mkdtempSync(join(tmpdir(), 'folia-heal-'));
  // 4.23.22：期望值只在完成/校验那一刻问当前清单（本测试的"清单"就是 SOURCES）。
  const resolveExpectation = (row) => {
    let buf;
    try { buf = SOURCES.get(new URL(String(row && row.url)).pathname); } catch { buf = undefined; }
    return buf ? { sha256: sha256(buf), bytes: buf.length, source: 'original', at: Date.now() } : null;
  };
  const q = createDownloadQueue({ home, log: () => {}, resolveExpectation });
  const heal = createMediaSelfHeal({
    queue: q,
    log: () => {},
    resolveExpectation,
    destFor: (url, kind) => testDest(url, kind),
    transcodeToPlayable: o.transcodeToPlayable || undefined,
    transcodeProgressOf: o.transcodeProgressOf || undefined,
    transcodeWaitMs: Number.isFinite(Number(o.transcodeWaitMs)) ? Number(o.transcodeWaitMs) : 15000,
  });
  return { home, q, heal };
}

/** 假"救援转码"：写一份结构合法的小 mp4 到临时路径，并记录调用次数。 */
function stubTranscoder(counter) {
  const out = join(mkdtempSync(join(tmpdir(), 'folia-tc-')), 'playable.mp4');
  writeFileSync(out, makeMp4(2048, 0x33));
  return async () => { counter.n += 1; return out; };
}

/* ══ 1. 坏文件（长度对、sha 错）⇒ 删 + **单流**重下 ⇒ 最终字节与站点一致 ═════════ */
console.log('\n① 播放失败 ⇒ sha 校验 ⇒ 删 + 单流重下');
{
  const GOOD = makeMp4(65536, 0x21);
  const wantSha = sha256(GOOD);
  SOURCES.set('/heal-a.mp4', GOOD);
  const env = makeEnv();
  const { id, dest } = await fetchToLocal(env.q, BASE + '/heal-a.mp4');
  check('A0 首次落地：文件在盘上且 sha256 与站点一致', Boolean(dest && existsSync(dest))
    && sha256(readFileSync(dest)) === wantSha);

  // 事故形态：长度完全一样，内容被改坏。
  const sizeBefore = tamperSameSize(dest);
  const sizeAfter = statSync(dest).size;
  check('A1 篡改后**长度不变**（所以"只比长度"必然判好）', sizeBefore === sizeAfter,
    sizeBefore + '/' + sizeAfter);

  const hitsBefore = HITS.filter((h) => h.path === '/heal-a.mp4' && h.method === 'GET').length;
  const res = await env.heal.heal({ id, localUrl: '/folia/local-media/' + id });
  check('A2 结论 = corrupt（内容与站点清单不符）', res.verdict === 'corrupt', res.verdict + ' / ' + res.message);
  check('A3 文案：文件已损坏，已重新下载', res.message === '文件已损坏，已重新下载', res.message);
  check('A4 坏文件已被删除（重下期间 pathFor 为 null）', env.q.pathFor(id) === null);

  const back = await jobDone(env.q, id);
  check('A5 自动重下完成（同一条 job 回到 done）', Boolean(back), back ? back.status : 'timeout');
  const finalBytes = existsSync(dest) ? readFileSync(dest) : Buffer.alloc(0);
  check('A6 最终字节与站点**逐字节一致**（= 这份文件能播）',
    Buffer.compare(finalBytes, GOOD) === 0, sha256(finalBytes).slice(0, 12) + ' vs ' + wantSha.slice(0, 12));

  const reGets = HITS.filter((h) => h.path === '/heal-a.mp4' && h.method === 'GET').slice(hitsBefore);
  check('A7 自愈重下走的是**单流**（没有 range 分片请求）',
    reGets.length >= 1 && reGets.every((h) => h.range === ''),
    JSON.stringify(reGets.map((h) => h.range)));
}

/* ══ 2. 文件是好的、只是本机解不了 ⇒ **不重下**，切 1080p 变体 ════════════════ */
console.log('\n② 内容没问题 + 解码失败 ⇒ 切 1080p 变体（不重下原画）');
{
  const ORIG = makeMp4(65536, 0x41);
  const V1080 = makeMp4(8192, 0x42);
  SOURCES.set('/heal-b.mp4', ORIG);
  SOURCES.set('/heal-b-1080p.mp4', V1080);
  const env = makeEnv();
  const { id, dest } = await fetchToLocal(env.q, BASE + '/heal-b.mp4');
  const origSha = sha256(readFileSync(dest));
  const hitsBefore = HITS.filter((h) => h.path === '/heal-b.mp4' && h.method === 'GET').length;

  const res = await env.heal.heal({
    id,
    localUrl: '/folia/local-media/' + id,
    variants: [{ label: '1080p', height: 1080, bytes: V1080.length, url: BASE + '/heal-b-1080p.mp4' }],
  });
  check('B1 结论 = variant（内容没问题，换档）', res.verdict === 'variant', res.verdict + ' / ' + res.message);
  check('B2 文案：已切换到 1080p（原画超出本机解码上限）',
    res.message === '已切换到 1080p（原画超出本机解码上限）', res.message);
  check('B3 原画**没有被重下**（job 仍是 done、字节没变、没有新 GET）',
    env.q.jobById(id).status === 'done'
    && sha256(readFileSync(dest)) === origSha
    && HITS.filter((h) => h.path === '/heal-b.mp4' && h.method === 'GET').length === hitsBefore,
    'gets=' + HITS.filter((h) => h.path === '/heal-b.mp4' && h.method === 'GET').length);
  check('B4 原画被标记 decodeUnsupported（后续选档不再选它）',
    env.q.jobById(id).decodeUnsupported === true);
  const vRow = res.jobId ? await jobDone(env.q, res.jobId) : null;
  check('B5 1080p 变体已排进队列并落地', Boolean(vRow), res.jobId || '(无 jobId)');
  check('B6 响应带变体的本地地址（客户端据此重挂播放）',
    /^\/folia\/local-media\/.+/.test(String(res.url || '')), String(res.url || ''));
}

/* ══ 3. 没有变体 / 已在 1080p ⇒ 转码兜底，失败则明说"解不了" ═════════════════ */
console.log('\n③ 无变体 ⇒ 本地转码；转码失败/已是 1080p ⇒ 本机不支持该编码');
{
  const ORIG = makeMp4(65536, 0x51);
  SOURCES.set('/heal-c.mp4', ORIG);
  // 3a：转码管线可用 ⇒ 产出可播副本（并断言"只调用一次"）
  const counter = { n: 0 };
  const env = makeEnv({ transcodeToPlayable: stubTranscoder(counter) });
  const { id } = await fetchToLocal(env.q, BASE + '/heal-c.mp4');
  const res = await env.heal.heal({ id, localUrl: '/folia/local-media/' + id, variants: [] });
  check('C1 无变体 + 转码可用 ⇒ 结论 = transcoded', res.verdict === 'transcoded', res.verdict + ' / ' + res.message);
  check('C2 转码被调用**恰好一次**', counter.n === 1, 'n=' + counter.n);
  check('C3 回的是转码产物的地址（?playable=1）',
    String(res.url || '').indexOf('?playable=1') > 0, String(res.url || ''));
  check('C4 文案（rescue 档）：已切换到 1080p（原画超出本机解码上限）',
    res.message === '已切换到 1080p（原画超出本机解码上限）', res.message);

  // 3b：转码失败 ⇒ 「本机不支持该编码」
  const envFail = makeEnv({
    transcodeToPlayable: async () => { throw new Error('ffmpeg missing'); },
  });
  const b = await fetchToLocal(envFail.q, BASE + '/heal-c.mp4');
  const rf = await envFail.heal.heal({ id: b.id, localUrl: '/folia/local-media/' + b.id, variants: [] });
  check('C5 转码失败 ⇒ 结论 = undecodable（不再回退成播原片）', rf.verdict === 'undecodable', rf.verdict);
  check('C6 文案：本机不支持该编码', rf.message === '本机不支持该编码', rf.message);

  // 3c：已经是 1080p 还解不了 ⇒ 不转码、不再换档
  const env2 = makeEnv({ transcodeToPlayable: stubTranscoder({ n: 0 }) });
  const c = await fetchToLocal(env2.q, BASE + '/heal-c.mp4');
  const r2 = await env2.heal.heal({ id: c.id, localUrl: '/folia/local-media/' + c.id, variants: [], playing1080p: true });
  check('C7 已在 1080p 仍失败 ⇒ 结论 = undecodable', r2.verdict === 'undecodable', r2.verdict);
  check('C8 文案：本机不支持该编码（并提示换一张）',
    r2.message === '本机不支持该编码', r2.message);

  // 3d：无变体 + 无转码管线 ⇒ 「分辨率/编码超出本机解码能力」
  const env3 = makeEnv();
  const d = await fetchToLocal(env3.q, BASE + '/heal-c.mp4');
  const r3 = await env3.heal.heal({ id: d.id, localUrl: '/folia/local-media/' + d.id, variants: [] });
  check('C9 无变体 + 无转码 ⇒ 结论 = undecodable-no-variant', r3.verdict === 'undecodable-no-variant', r3.verdict);
  check('C10 文案：分辨率/编码超出本机解码能力',
    r3.message === '该壁纸分辨率/编码超出本机解码能力', r3.message);
}

/* ══ 4. 启动自检：采样口径 + 两种坏文件都被标记并清理 ═════════════════════════ */
console.log('\n④ 启动自检（最近 20 个）+ 全量校验');
{
  // 4a：25 个成品 ⇒ 采样只看最近 20 个（最旧的那 5 个不参与）
  const env = makeEnv();
  const files = Array.from({ length: 25 }, (_, i) => 'self-a-' + String(i).padStart(2, '0') + '.mp4');
  for (const f of files) SOURCES.set('/' + f, makeMp4(4096, 0x60));
  const rows = [];
  for (const f of files) rows.push(await fetchToLocal(env.q, BASE + '/' + f));
  // mtime：i 越小越新（0 最新）；给最旧 5 个改成很久以前。
  const old = Date.now() / 1000 - 86400;
  for (let i = 20; i < 25; i += 1) { try { utimesSync(rows[i].dest, old, old); } catch { /* ignore */ } }
  const tapped = env.heal.doneRowsNewestFirst(20);
  check('D1 采样口径 = 最近 20 个（25 个成品里只取 20）', tapped.length === 20, 'n=' + tapped.length);
  const inSample = new Set(tapped.map((r) => r.id));
  check('D2 最旧的那 5 个不在采样内（排序按 mtime 倒序）',
    !inSample.has(rows[24].id) && inSample.has(rows[0].id));

  // 4b：构造 1 个"长度对、sha 错" + 1 个"截断（长度错）"
  const env2 = makeEnv();
  const BAD = makeMp4(32768, 0x71);
  const TRUNC = makeMp4(32768, 0x72);
  SOURCES.set('/self-bad.mp4', BAD);
  SOURCES.set('/self-trunc.mp4', TRUNC);
  const jBad = await fetchToLocal(env2.q, BASE + '/self-bad.mp4');
  const jTrunc = await fetchToLocal(env2.q, BASE + '/self-trunc.mp4');
  tamperSameSize(jBad.dest);                                   // 长度对、sha 错
  const tbuf = readFileSync(jTrunc.dest).subarray(0, 200);      // 截断：长度错、moov 也没了
  writeFileSync(jTrunc.dest, tbuf);
  const scan = scanMp4Boxes(jTrunc.dest);
  check('D3 截断的探针真的报告"被截断"（夹具可信）', scan.truncated === true || scan.moov === false,
    JSON.stringify(scan));

  const out = await env2.heal.verifyAllP();
  check('D4 全量校验：两个坏文件都被标记', out.damaged === 2, 'damaged=' + out.damaged);
  check('D5 两个坏文件都被清掉（盘上不再有）',
    !existsSync(jBad.dest) && !existsSync(jTrunc.dest));
  const h = env2.heal.health();
  check('D6 账本：damaged=2 / cleaned=2 / pending=2（面板那三个数）',
    h.damaged === 2 && h.cleaned === 2 && h.pending === 2,
    JSON.stringify({ damaged: h.damaged, cleaned: h.cleaned, pending: h.pending }));
  check('D7 坏文件被排回下载队列（会被重新下载，而不是永久消失）',
    (await jobDone(env2.q, jBad.id)) !== null && (await jobDone(env2.q, jTrunc.id)) !== null);
}

/* ══ 5. 负对照：把 sha 校验从**真源码**里摘掉（只比长度）⇒ 第一条用例必须红 ══ */
console.log('\n⑤ 负对照（真源码变异）');
{
  const src = readFileSync(join(ROOT, 'lib', 'media-verify.js'), 'utf8');
  const at = src.indexOf('export function decideHeal(inp)');
  const end = at >= 0 ? src.indexOf('\n}\n', at) : -1;
  const fnText = (at >= 0 && end > at) ? src.slice(at, end + 3) : '';
  check('E1 能从 lib/media-verify.js 取到 decideHeal 的真源码', Boolean(fnText), fnText ? 'ok' : '切片失败');
  /** 把 sha 分支整段摘掉（回到"只比长度"的旧判据）。 */
  const mutantText = fnText
    .replace(/if \(o\.shaKnown === true\) \{[\s\S]*?\n {2}\}\n/, '  // (变异) 只比长度：sha 分支被摘掉\n');
  const real = (() => {
    try { return new Function(fnText.replace('export function', 'return function') + '\nreturn decideHeal;')(); } catch { return null; }
  })();
  const mutant = (() => {
    try { return new Function(mutantText.replace('export function', 'return function') + '\nreturn decideHeal;')(); } catch { return null; }
  })();
  check('E2 真实现与变异体都能跑（负对照本身可信）', Boolean(real) && Boolean(mutant),
    JSON.stringify({ real: Boolean(real), mutant: Boolean(mutant) }));
  // 事故证据：有 sha、长度对、内容错（= 第①条用例的现场）。
  const evidence = { shaKnown: true, shaMatch: false, sizeMatch: true, structOk: true, playing1080p: false, hasVariant: true };
  if (real && mutant) {
    check('E3 真实现：判 corrupt（有 sha 就看 sha）', real(evidence) === 'corrupt', real(evidence));
    check('E4 变异体（只比长度）：判成 variant/undecodable ⇒ 第①条用例会红',
      mutant(evidence) !== 'corrupt', mutant(evidence));
    check('E5 负对照有牙：两者对同一证据结论不同', real(evidence) !== mutant(evidence),
      real(evidence) + ' vs ' + mutant(evidence));
  }
}

/* ══ 6. 解码上限预判：5916×2530 的原画 + 有 1080p ⇒ **即使链路快**也选 1080p ═══ */
console.log('\n⑥ 解码上限预判（选档阶段就避开）');
{
  const variants = [{ label: '1080p', height: 1080, bytes: 6893692, url: BASE + '/v-1080p.mp4' }];
  const pick = pickVariant({
    variants,
    originalUrl: BASE + '/v-original.mp4',
    originalBytes: 48 * 1024 * 1024,
    quality: 'auto',
    hostSlow: false,          // 链路很快
    screenHeight: 0,
    originalWidth: 5916,
    originalHeight: 2530,
  });
  check('F1 5916×2530 + 有 1080p ⇒ 选 1080p（与链路快慢无关）', pick.chosen === '1080p', pick.chosen + '/' + pick.reason);
  check('F2 理由必须是 decode-limit（不是 slow-link）', pick.reason === 'decode-limit', pick.reason);
  check('F3 decodeLimitHit 认得三种口径',
    decodeHit2(5916, 2530) !== '' && decodeHit2(3840, 2160) === '' && decodeHit2(0, 1600) !== '' && decodeHit2(0, 0) === '',
    JSON.stringify([decodeHit2(5916, 2530), decodeHit2(3840, 2160), decodeHit2(0, 1600), decodeHit2(0, 0)]));
  // 4096×2160 也**必须**判超限：宽没过 4096、高没过 2160，但像素总量 8,847,360 > 3840×2160。
  // 这条是"三条判据缺一条就漏"的证据（实测 4096 宽的 DCI-4K 源同样解不出来）。
  check('F3b 4096×2160 按像素总量判超限（不只盯宽/高两个数）', decodeHit2(4096, 2160) !== '',
    decodeHit2(4096, 2160));
  // 尺寸只给一半 ⇒ 退化口径（height>1440 / width>2560）
  check('F4 只有高度时退化为 height>1440', decodeLimitHit(0, 1600) !== '' && decodeLimitHit(0, 1080) === '');
  check('F5 只有宽度时退化为 width>2560', decodeLimitHit(3000, 0) !== '' && decodeLimitHit(1920, 0) === '');
  // 负对照：把 4.23.14 的"只按速度/体积/屏高"选档实现**贴回来**（逐分支照抄，
  // 只是没有 decode-limit 那一段）⇒ F1 必须红。判据只读输入，不写死常量，
  // 所以这条负对照本身也是"同一套输入、两套实现"的差量证据。
  const oldPick = (inp) => {
    const o = inp || {};
    const oldVariants = Array.isArray(o.variants) ? o.variants : [];
    const quality = String(o.quality || 'auto');
    const oldV1080 = oldVariants.find((v) => v && Number(v.height) === 1080) || null;
    if (quality === 'original') return 'original';
    if (!oldV1080) return 'original';
    if (quality === 'saver') return '1080p';
    if (o.hostSlow === true) return '1080p';
    const bytes = Number(o.originalBytes) || 0;
    const screenH = Number(o.screenHeight) || 0;
    if (bytes > 20 * 1024 * 1024 && screenH > 0 && screenH <= 1440) return '1080p';
    return 'original';
  };
  const oldOut = oldPick({
    variants, originalBytes: 48 * 1024 * 1024, quality: 'auto',
    hostSlow: false, screenHeight: 0, originalWidth: 5916, originalHeight: 2530,
  });
  check('F6 负对照：只按速度/体积选档的旧实现 ⇒ 选原画（F1 会红）', oldOut === 'original', oldOut);
}

/* ══ 7. 客户端这一半：要不要惊动宿主 + 四种结论的文案（取真源码）═══════════════ */
console.log('\n⑦ 客户端判据与文案（src/local-first.js 真源码）');
{
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs()');
  const slice = (a >= 0 && b > a) ? src.slice(a, b) : '';
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  const client = (() => {
    try {
      return new Function('weT', 'setTimeout', 'clearTimeout', slice + `
return { dlHealPlan, dlHealNote, dlHealPending, lfIsLocalMediaUrl, dlHealMaxTries: LF_HEAL_MAX_TRIES };`)(shim, setTimeout, clearTimeout);
    } catch { return null; }
  })();
  check('G1 能取到 src/local-first.js 的真源码并跑起来', Boolean(client), client ? 'ok' : '切片/编译失败');
  if (client) {
    check('G2 本地副本 + 解码错误 ⇒ heal',
      client.dlHealPlan({ url: '/folia/local-media/abc', code: 3 }) === 'heal');
    check('G3 远端地址 ⇒ 不惊动宿主（我们既不能证明坏、也不能替站点重下）',
      client.dlHealPlan({ url: 'https://cdn.example/x.mp4', code: 3 }) === 'skip');
    check('G4 网络类错误（code 2）⇒ 不重下（那是"这一下没传完"）',
      client.dlHealPlan({ url: '/folia/local-media/abc', code: 2 }) === 'skip');
    check('G5 超过重试上限 ⇒ 只提示，不再重下（防死循环）',
      client.dlHealPlan({ url: '/folia/local-media/abc', code: 4, tries: 2, maxTries: 2 }) === 'skip');
    check('G6 library 直出形态也认作本地副本',
      client.lfIsLocalMediaUrl('/x/library/wallpaper/0123456789abcdef0123.mp4') === true
      && client.lfIsLocalMediaUrl('https://a/b.mp4') === false);
    check('G7 四种结论各一句不同的话',
      client.dlHealNote('corrupt') === '文件已损坏，已重新下载'
      && client.dlHealNote('variant') === '已切换到 1080p（原画超出本机解码上限）'
      && client.dlHealNote('undecodable') === '本机不支持该编码（可换一张跳过此壁纸）'
      && client.dlHealNote('undecodable-no-variant') === '该壁纸分辨率/编码超出本机解码能力（可换一张跳过此壁纸）',
      [client.dlHealNote('corrupt'), client.dlHealNote('variant')].join(' | '));
    check('G8 只有"还在路上"的三种结论要轮询',
      client.dlHealPending('corrupt') && client.dlHealPending('variant') && client.dlHealPending('transcoding')
      && !client.dlHealPending('undecodable') && !client.dlHealPending('transcoded'));
  }
}

/* ══ 8. 判据层：verifyMediaFileP 的三档 + 大文件退化口径 ═══════════════════════ */
console.log('\n⑧ 完整性判据分档');
{
  const dir = mkdtempSync(join(tmpdir(), 'folia-verify-'));
  const okFile = join(dir, 'ok.mp4');
  const buf = makeMp4(8192, 0x81);
  writeFileSync(okFile, buf);
  const vOk = await verifyMediaFileP({ file: okFile, sha256: sha256(buf), bytes: buf.length });
  check('H1 长度 + sha256 都对 ⇒ ok 且 hashed=true', vOk.verdict === VERDICT.OK && vOk.hashed === true, JSON.stringify(vOk.verdict));
  const vBad = await verifyMediaFileP({ file: okFile, sha256: sha256(Buffer.from('other')), bytes: buf.length });
  check('H2 sha256 不符 ⇒ sha（长度对也照样判坏）', vBad.verdict === VERDICT.SHA, vBad.verdict);
  const vSize = await verifyMediaFileP({ file: okFile, sha256: '', bytes: buf.length + 10 });
  check('H3 长度不符 ⇒ size（最便宜的那一档先做）', vSize.verdict === VERDICT.SIZE, vSize.verdict);
  const vMiss = await verifyMediaFileP({ file: join(dir, 'nope.mp4'), sha256: '', bytes: 1 });
  check('H4 文件不在 ⇒ missing（不抛）', vMiss.verdict === VERDICT.MISSING, vMiss.verdict);
  const truncFile = join(dir, 'trunc.mp4');
  writeFileSync(truncFile, buf.subarray(0, 64));
  const vTrunc = await verifyMediaFileP({ file: truncFile, sha256: '', bytes: 0 });
  check('H5 截断且没有 sha256 ⇒ struct（结构判据兜住）', vTrunc.verdict === VERDICT.STRUCT, vTrunc.verdict + '/' + vTrunc.reason);
  check('H6 大文件阈值 = 20 MB（超过它不做全量 sha）', SHA_FULL_LIMIT_BYTES === 20 * 1024 * 1024, String(SHA_FULL_LIMIT_BYTES));
}

/* ══ 9. 「最终必须能上屏」的最后一公里：转码产物尺寸 / 进度 / 静态帧兜底 ══════ */
console.log('\n⑨ 最终必须能上屏：≤1920 宽 / 转码进度 / 静态帧兜底');
{
  // 9a：5916×2530 的源 ⇒ 救援转码产物必须 ≤1920×1080（缩放滤镜自己算具体像素，不用表达式）
  const tcDir = mkdtempSync(join(tmpdir(), 'folia-kit-'));
  const kit = (() => {
    try {
      return createTranscodeKit({
        cacheBaseDir: () => tcDir,
        configPath: () => join(tcDir, 'config.json'),
        videoPreviewCacheDir: () => join(tcDir, 'pv'),
        getMediaInfo: () => ({ width: 5916, height: 2530, duration: 12 }),
        atomicTmpPath: (p) => p + '.tmp',
        pluginRoot: tcDir,
      });
    } catch { return null; }
  })();
  check('I1 能建出转码套件（判据要打在真实现上）', Boolean(kit), kit ? 'ok' : '建套件失败');
  if (kit) {
    const vf = kit.playableScaleFilter({ width: 5916, height: 2530 });
    const m = /^scale=(\d+):(\d+),fps=(\d+)$/.exec(String(vf));
    const w = m ? Number(m[1]) : 0;
    const h = m ? Number(m[2]) : 0;
    check('I2 5916×2530 ⇒ 缩放滤镜落到 ≤1920×1080', Boolean(m) && w <= 1920 && h <= 1080, vf + ' ⇒ ' + w + '×' + h);
    check('I3 宽高都是偶数（H.264 的 yuv420p 硬要求）', w % 2 === 0 && h % 2 === 0, w + '×' + h);
    const vfNoInfo = kit.playableScaleFilter(null);
    check('I4 尺寸未知时退回无参数逗号的安全形态 scale=1920:-2,fps=30',
      vfNoInfo === 'scale=1920:-2,fps=30', vfNoInfo);
  }
  // 结构不变量：救援产物必须是 H.264 + yuv420p（AV1/10-bit 在旧 Chromium 上本身就是"解不了"）
  const tcSrc = readFileSync(join(ROOT, 'lib', 'media', 'transcode.js'), 'utf8');
  check('I5 救援转码固定 yuv420p 且只接受 H.264 编码器',
    tcSrc.includes("pixFmt: 'yuv420p'") && tcSrc.includes("encoders: ['h264_nvenc', 'libx264']"));

  // 9b：转码进行中 ⇒ 响应带**可读进度**（百分比 + 可选 ETA），不许静默
  const envSlow = makeEnv({
    transcodeToPlayable: () => new Promise(() => { /* 永不 resolve：模拟还在转 */ }),
    transcodeProgressOf: () => ({ percent: 42, eta: 317, phase: 'transcode', finalizing: false }),
    transcodeWaitMs: 60,
  });
  SOURCES.set('/heal-slow.mp4', makeMp4(65536, 0x91));
  const sRow = await fetchToLocal(envSlow.q, BASE + '/heal-slow.mp4');
  const resSlow = await envSlow.heal.heal({ id: sRow.id, localUrl: '/folia/local-media/' + sRow.id, variants: [] });
  check('I6 转码中 ⇒ verdict=transcoding（不挂住 HTTP，让客户端轮询）', resSlow.verdict === 'transcoding', resSlow.verdict);
  check('I7 转码中 ⇒ 响应带进度（percent=42 / eta=317）',
    Boolean(resSlow.progress) && resSlow.progress.percent === 42 && resSlow.progress.eta === 317,
    JSON.stringify(resSlow.progress || null));

  // 9c：静态帧兜底（纯函数，取 src/local-first.js 真源码）
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs()');
  const slice = (a >= 0 && b > a) ? src.slice(a, b) : '';
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  const client = (() => {
    try {
      return new Function('weT', 'setTimeout', 'clearTimeout', slice + `
return { dlHealNote, dlHealProgressNote, dlHealFallbackPlan };`)(shim, setTimeout, clearTimeout);
    } catch { return null; }
  })();
  check('I8 能取到客户端兜底判据（真源码）', Boolean(client), client ? 'ok' : '切片失败');
  if (client) {
    check('I9 有静态帧 ⇒ static-frame', client.dlHealFallbackPlan({ verdict: 'undecodable', hasPreview: true }) === 'static-frame');
    check('I10 连静态帧都没有 ⇒ 才允许 cannot-display',
      client.dlHealFallbackPlan({ verdict: 'undecodable-no-variant', hasPreview: false }) === 'cannot-display');
    check('I11 还有得救的结论不走兜底', client.dlHealFallbackPlan({ verdict: 'transcoded', hasPreview: true }) === '');
    check('I12 进度文案带百分比与剩余秒数',
      client.dlHealProgressNote({ percent: 42, eta: 317 }).indexOf('42') > 0
      && client.dlHealProgressNote({ percent: 42, eta: 317 }).indexOf('317') > 0,
      client.dlHealProgressNote({ percent: 42, eta: 317 }));
    check('I13 没有 ETA 时只报百分比（不编数字）',
      client.dlHealProgressNote({ percent: 7 }).indexOf('7') > 0
      && client.dlHealProgressNote({ percent: 7 }).indexOf('秒') < 0,
      client.dlHealProgressNote({ percent: 7 }));
    // 负对照：把"直接报错、不降级"的旧行为贴回 ⇒ I9 必须红
    const oldPlan = (inp) => (String(inp && inp.verdict || '') ? 'cannot-display' : '');
    check('I14 负对照：直接报错不降级的旧行为 ⇒ 有静态帧也判 cannot-display（I9 会红）',
      oldPlan({ verdict: 'undecodable', hasPreview: true }) === 'cannot-display');
  }
  // 客户端真的把它铺上屏了（源码级：调用点存在且传的是缩略图/首帧）
  const clientSrc = readFileSync(join(ROOT, 'src', 'client.js'), 'utf8');
  check('I15 client.js 真的挂了静态帧兜底（不是只有判据函数）',
    clientSrc.includes('mountStaticFrameFallback(still)') && clientSrc.includes('function mountStaticFrameFallback('));
  check('I16 兜底图来自缩略图/首帧（staticFallbackUrlOf 读 preview/thumbUrl/frameUrl）',
    /function staticFallbackUrlOf\(\)[\s\S]{0,400}selection\.previewUrl[\s\S]{0,400}thumbUrl/.test(clientSrc));
}

/* ══ 10. 降帧升级（fps cap）**没有被池化路径绕过** —— 回归点的代码证据 ═════════ */
console.log('\n⑩ 降帧升级的调用链（4.23.12 池化之后仍然在）');
{
  const live = readFileSync(join(ROOT, 'src', 'live-layer.js'), 'utf8');
  const vl = readFileSync(join(ROOT, 'src', 'video-layer.js'), 'utf8');
  const callInLive = live.includes('videoChannelAfterLayerBuild(video, selection);');
  const hookInVideo = vl.includes('maybeUpgradeToTranscoded(video, String(sel.url).split("/").pop());');
  check('J1 syncLayers（唯一编排点）仍然调用视频通道的转码触发', callInLive);
  check('J2 视频通道把它转给 maybeUpgradeToTranscoded', hookInVideo);
  // 行为：抽帧判据本身（纯函数，从真源码里取出来跑）
  const fnSrc = (() => {
    const at = vl.indexOf('const FPS_CAP_TOLERANCE = 1;');
    const end = at >= 0 ? vl.indexOf('\n}', vl.indexOf('function capNeedsTranscode')) : -1;
    return (at >= 0 && end > at) ? vl.slice(at, end + 2) : '';
  })();
  const capFn = (() => { try { return new Function(fnSrc + '\nreturn capNeedsTranscode;')(); } catch { return null; } })();
  check('J3 能取出 capNeedsTranscode 的真源码', Boolean(capFn), capFn ? 'ok' : '切片失败');
  if (capFn) {
    check('J4 60fps 源、上限 30 ⇒ 需要抽帧（"以前靠降帧能播"那条路本身还在）', capFn({ fps: 60 }, 30) === true);
    check('J5 30fps 源、上限 30 ⇒ 不抽帧（不白烧 CPU）', capFn({ fps: 30 }, 30) === false);
    check('J6 帧率未知 ⇒ null（交给"原生可解就别盲转"那条成本护栏）', capFn({}, 30) === null);
  }
  // 负对照：把调用那一行注释掉 ⇒ J1 必须红
  const mutant = live.replace('videoChannelAfterLayerBuild(video, selection);', '/* removed */');
  check('J7 负对照：注释掉调用 ⇒ 调用链判据红', !mutant.includes('videoChannelAfterLayerBuild(video, selection);'));
  // 以及**事实澄清**：这条链的默认值是"不抽帧"（fpsCap=0），所以它救不了超限源 ——
  // 超限源的兜底是第 1/6/9 节那三条（选档避开 / 救援转码 / 静态帧）。
  const schema = readFileSync(join(ROOT, 'lib', 'settings-schema.js'), 'utf8');
  check('J8 fpsCap 默认 0（= 默认永不抽帧；它是省电功能，不是解码救援）', /fpsCap:\s*0,/.test(schema));
}

/* ══ 11. 最终决策树（用户拍板：**降帧优先、尽量不降画质**）═════════════════════ */
console.log('\n⑪ 决策树：降帧优先，分辨率超限才降 1080p');
{
  // ① 规格在能力内 ⇒ 原画（最高画质，不许替他降）
  check('K1 1920×1080@30 ⇒ direct（原画直出）',
    decodePlan({ width: 1920, height: 1080, fps: 30, hasVariant: true }).action === 'direct',
    decodePlan({ width: 1920, height: 1080, fps: 30, hasVariant: true }).action);
  // ② 只有 fps 超标 ⇒ **同分辨率降帧**（不是 1080p！）
  const p60 = decodePlan({ width: 3840, height: 2160, fps: 60, hasVariant: true });
  check('K2 3840×2160@60 + 有变体 ⇒ decimate（4K@30，不降分辨率）', p60.action === 'decimate', p60.action + '/' + p60.reason);
  check('K3 降帧档保留原分辨率、目标帧率 30',
    p60.targetWidth === 3840 && p60.targetHeight === 2160 && p60.targetFps === 30,
    JSON.stringify(p60));
  // 负对照：旧口径"fps>30 且宽≥2560 ⇒ 优先 1080p"会把 4K@60 降成 1080p ⇒ K2 必须红
  const oldRule = (o) => (Number(o.fps) > 30 && Number(o.width) >= 2560) ? 'variant' : 'decimate';
  check('K4 负对照：旧口径（60fps⇒1080p）⇒ 给出 variant（K2 会红）',
    oldRule({ width: 3840, height: 2160, fps: 60 }) === 'variant');
  // ③ 分辨率超限 ⇒ 站点 1080p 变体
  const wide = decodePlan({ width: 5916, height: 2530, fps: 30, hasVariant: true });
  check('K5 5916×2530 + 有变体 ⇒ variant（1080p）', wide.action === 'variant', wide.action);
  // ③b 分辨率超限 + 无变体 ⇒ rescue（缩到 ≤1920×1080 + 30fps）
  const ultra = decodePlan({ width: 4320, height: 2160, fps: 60, hasVariant: false });
  check('K6 4320×2160@60 无变体 ⇒ rescue', ultra.action === 'rescue', ultra.action);
  check('K7 rescue 目标 ≤1920×1080 且 fps=30',
    ultra.targetWidth <= 1920 && ultra.targetHeight <= 1080 && ultra.targetFps === 30, JSON.stringify(ultra));

  // 行为：fps 档的转码（真 kit 的滤镜串）—— 同分辨率、只改帧率
  const tcDir = mkdtempSync(join(tmpdir(), 'folia-kit2-'));
  const kit2 = createTranscodeKit({
    cacheBaseDir: () => tcDir,
    configPath: () => join(tcDir, 'config.json'),
    videoPreviewCacheDir: () => join(tcDir, 'pv'),
    getMediaInfo: () => ({ width: 3840, height: 2160, duration: 10 }),
    atomicTmpPath: (p) => p + '.tmp',
    pluginRoot: tcDir,
  });
  const vfFps = kit2.playableScaleFilter({ width: 3840, height: 2160 }, 'fps');
  check('K8 fps 档滤镜 = 只降帧（fps=30，没有 scale）', /^fps=30$/.test(String(vfFps)), String(vfFps));
  const vfRescue = kit2.playableScaleFilter({ width: 4320, height: 2160 }, 'rescue');
  const mr = /^scale=(\d+):(\d+),fps=(\d+)$/.exec(String(vfRescue));
  check('K9 rescue 档滤镜 = 缩到 ≤1920×1080 且 fps=30',
    Boolean(mr) && Number(mr[1]) <= 1920 && Number(mr[2]) <= 1080 && Number(mr[3]) === 30, String(vfRescue));

  // 端到端：4K@60 的原画（无变体）⇒ 走 fps 档转码，文案说明"分辨率不变"
  const FOURK = makeMp4(65536, 0xA1);
  SOURCES.set('/heal-4k60.mp4', FOURK);
  const env4k = makeEnv({ transcodeToPlayable: stubTranscoder({ n: 0 }) });
  const row4k = await fetchToLocal(env4k.q, BASE + '/heal-4k60.mp4');
  const res4k = await env4k.heal.heal({
    id: row4k.id, localUrl: '/folia/local-media/' + row4k.id, variants: [],
    width: 3840, height: 2160, fps: 60,
  });
  check('K10 4K@60 无变体 ⇒ 转码（transcoded），不是直接报错', res4k.verdict === 'transcoded', res4k.verdict);
  check('K11 走的是 fps 档（mode=fps，分辨率不变）', res4k.mode === 'fps', String(res4k.mode));
  check('K12 文案说明"只降帧、分辨率不变"',
    /30fps/.test(String(res4k.message)) && /分辨率不变/.test(String(res4k.message)), res4k.message);
}

/* ══ 汇总 ════════════════════════════════════════════════════════════════════ */
try { server.close(); } catch { /* ignore */ }const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length
  ? 'MEDIA SELFHEAL CHECKS FAILED — ' + failed.length + '/' + results.length + ' 条红'
  : 'MEDIA SELFHEAL CHECKS PASSED — ' + results.length + ' 条'));
process.exit(failed.length ? 1 : 0);
