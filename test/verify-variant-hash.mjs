#!/usr/bin/env node
/**
 * verify-variant-hash.mjs — **变体下载的哈希选择 / ENOENT 自愈 / 旧状态升级**（4.23.17，P0）。
 *
 * ## 真实事故（本机 4.23.16 实测，不是构造）
 *
 * 用户「点击壁纸不显示」。`/folia/downloads/list` 里 15 条 wallpaper job 全是
 * `failed / error="hash-mismatch: 传输内容与站点不一致" / received=0`，失败的 url 全是
 * **1080p 变体**（`…/xxxx.1080p.mp4`）。对照清单：
 *   · 原画 `item.sha256 = 468b61…`，`item.bytes = 4,831,516`；
 *   · 变体 `…1080p.mp4` 自己的 `sha256 = 52c110e0…`、`bytes = 1,358,567`。
 * 旧实现把**原画的 sha256** 交给「下载变体」那条 job ⇒ 两个对象的哈希天生不同 ⇒ 每次
 * 都 `hash-mismatch`，自动单流重下一次仍不一致，job 停在 failed。
 *
 * 第二种失败形态：库里的 `.part` / 成品被外部清理（缓存管理器 / 手工删），job 还在跑，
 * 下次写盘 / stat / rename 直接 `ENOENT: …xxx.mp4.part` —— 旧实现当普通失败。
 *
 * ## 判据（每条都有牙）
 *
 *   ① 变体 URL + **变体自己的** sha256 ⇒ 校验通过、job done、盘上哈希 = 变体哈希（正向）；
 *   ② 变体 URL + **原画** sha256（旧逻辑）⇒ 必然 `hash-mismatch` 且失败（负对照：证明旧逻辑错）；
 *   ③ `/downloads/add` 的选档结论里带的就是"真正交给队列的那个哈希"（变体档 / 原画档各一条）；
 *   ④ `normalizeVariants` 必须原样保留变体的 sha256（丢掉它 = 客户端只能拿原画哈希）；
 *   ⑤ ENOENT（`.part` 被外部删）⇒ job 变 queued 并**最终 done**（不是 failed）；
 *   ⑥ 连续两次 ENOENT ⇒ failed 且原因是 `file-vanished`（有明确人话，不是裸 ENOENT）；
 *   ⑦ `status=done` 但成品不存在（旧 downloads.json / 外部清理）⇒ 载入即重置为 **pending**（4.23.18：未缓存、不自动入队）；
 *   ⑧ 旧 downloads.json（缺 priority / mode / chosenVariant / enoentRetries）平滑升级不崩。
 *
 * 隔离 home：全程 `%TEMP%\folia-test-variant-hash-*`（`isolateTestHome` + 显式 `home`），
 * 绝不碰真实 `%APPDATA%\dsh-desktop\harness`（4.23.15 污染事故的护栏）。
 *
 * Usage: `node test/verify-variant-hash.mjs`
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = isolateTestHome('variant-hash', { force: true });
process.env.DSH_HOME = TEST_HOME;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 一个**结构合法**的最小 MP4：`ftyp` + `moov` + 一个 `free` 填充 box。
 * 为什么必须合法：4.23.15 的「无效媒体不入库」会在 rename 之前用 `scanMp4Boxes` 判结构，
 * 假的 4 KB 占位会被判 `no-moov` —— 那样测的就不是哈希这条链了。
 */
function makeMp4(seed, padBytes) {
  const pad = Math.max(0, padBytes - 32);
  const total = 32 + pad;
  const b = Buffer.alloc(total);
  b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'latin1'); b.write('isom', 8, 'latin1');
  b.writeUInt32BE(24, 12); b.writeUInt32BE(8, 24); b.write('moov', 28, 'latin1');
  b.writeUInt32BE(Math.max(8, pad), 32); b.write('free', 36, 'latin1');
  let x = (seed >>> 0) || 1;
  for (let i = 40; i < total; i += 1) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; b[i] = (x >>> 24) & 0xff; }
  return b;
}

/** 本地静态文件站：一个路径一份字节；`onRange` 可注入"下载中途删 .part"的故障。 */
function startServer(routes) {
  const state = { rangeHits: 0, gets: 0 };
  const srv = createServer((req, res) => {
    const path = String(req.url || '').split('?')[0];
    const hit = routes[path];
    if (!hit) { res.statusCode = 404; res.end('nope'); return; }
    const buf = hit.buf;
    const range = String(req.headers.range || '');
    if (req.method === 'HEAD') {
      res.setHeader('content-length', String(buf.length));
      res.setHeader('accept-ranges', 'bytes');
      res.end();
      return;
    }
    if (range) {
      state.rangeHits += 1;
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      const start = Number(m && m[1]) || 0;
      const end = Math.min(buf.length - 1, Number(m && m[2]) || (buf.length - 1));
      const slice = buf.subarray(start, end + 1);
      if (typeof hit.onRange === 'function') hit.onRange(state.rangeHits);
      const send = () => {
        try {
          res.statusCode = 206;
          res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + buf.length);
          res.setHeader('content-length', String(slice.length));
          res.setHeader('accept-ranges', 'bytes');
          res.end(slice);
        } catch { /* 客户端已断开 */ }
      };
      setTimeout(send, Number(hit.rangeDelayMs) || 0);
      return;
    }
    state.gets += 1;
    res.statusCode = 200;
    res.setHeader('content-length', String(buf.length));
    res.setHeader('accept-ranges', 'bytes');
    res.end(buf);
  });
  return new Promise((resolveListen) => {
    srv.listen(0, '127.0.0.1', () => resolveListen({
      state, origin: 'http://127.0.0.1:' + srv.address().port,
      close: () => srv.close(),
    }));
  });
}

async function waitJob(getJobs, pred, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const cur = await getJobs();
    const hit = (cur || []).find(pred);
    if (hit) return hit;
    if (Date.now() - started > (timeoutMs || 12000)) return null;
    await sleep(30);
  }
}

/* ══ ① 纯函数：normalizeVariants 必须保留变体自己的 sha256 ════════════════════ */
{
  const { normalizeVariants } = await import('../lib/variant-pick.js');
  const V_SHA = sha(Buffer.from('variant-bytes'));
  const norm = normalizeVariants([{
    label: '1080p', height: 1080, bytes: 1234, url: 'https://site.test/x.1080p.mp4', sha256: V_SHA.toUpperCase(),
  }]);
  check('① normalizeVariants 保留变体 sha256（大写也归一成小写）',
    norm.length === 1 && norm[0].sha256 === V_SHA, JSON.stringify(norm));
  check('① 非法 / 缺失的 sha256 不设内容判据（不会被当成"给了个空哈希"）',
    normalizeVariants([{ url: 'https://site.test/y.mp4', sha256: 'not-a-hash' }])[0].sha256 === undefined
    && normalizeVariants([{ url: 'https://site.test/y.mp4' }])[0].sha256 === undefined);
  check('① 原画与变体的 bytes 各留各的（选档判原画体积，不拿变体的）',
    norm[0].bytes === 1234);
}

/* ══ ② 行为：/downloads/add 选 1080p 时，交给队列的是**变体**的 sha256 ═══════ */
const ORIG_BUF = makeMp4(0x11, 48 * 1024);
const VAR_BUF = makeMp4(0x22, 20 * 1024);
const ORIG_SHA = sha(ORIG_BUF);
const VAR_SHA = sha(VAR_BUF);
const site = await startServer({
  '/orig.mp4': { buf: ORIG_BUF },
  '/orig.1080p.mp4': { buf: VAR_BUF },
});
const ORIG_URL = site.origin + '/orig.mp4';
const VAR_URL = site.origin + '/orig.1080p.mp4';

{
  const { registerDownloadsRoutes } = await import('../lib/routes/downloads.js');
  const routes = [];
  const deps = { disposers: [], base: '/folia', log: () => {}, serveFile: () => {} };
  registerDownloadsRoutes({ register: (spec) => { routes.push(spec); return () => {}; } }, deps);
  const find = (p) => routes.find((r) => r.path === p);
  const call = (route, { method = 'POST', body = null } = {}) => new Promise((resolveCall) => {
    const resObj = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(s) { resolveCall({ status: this.statusCode, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }); },
    };
    const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      method, url: route.path, headers: {},
      on(ev, fn) {
        if (ev === 'data') for (const c of chunks) fn(c);
        if (ev === 'end') setTimeout(fn, 0);
        return this;
      },
    };
    route.handler(req, resObj);
  });
  const listJobs = () => new Promise((resolveList) => {
    const resObj = {
      statusCode: 0, headers: {},
      setHeader() { /* ignore */ },
      end(s) { resolveList(((() => { try { return JSON.parse(s).jobs; } catch { return []; } })())); },
    };
    find('/folia/downloads/list').handler({ method: 'GET', url: '/folia/downloads/list', headers: {}, on() { return this; } }, resObj);
  });

  // 慢链路 / 省流量档 ⇒ 选 1080p 变体（与线上真实触发条件同一条纯函数）。
  const added = await call(find('/folia/downloads/add'), {
    body: {
      items: [{
        kind: 'wallpaper', url: ORIG_URL, variants: [{ label: '1080p', height: 1080, url: VAR_URL, bytes: VAR_BUF.length, sha256: VAR_SHA }],
        bytes: ORIG_BUF.length, sha256: ORIG_SHA, screenHeight: 1080,
      }],
      quality: 'saver',
    },
  });
  const item = added.json && added.json.items && added.json.items[0];
  check('② /downloads/add 选的是变体地址', Boolean(item && item.chosenVariant === '1080p' && item.url === VAR_URL),
    JSON.stringify(item && { chosen: item.chosenVariant, url: item.url }));
  check('② 响应里回的就是**变体**的 sha256（不是原画的）',
    Boolean(item && item.sha256 === VAR_SHA), JSON.stringify(item && item.sha256));
  check('② 负对照：若拿原画哈希去校验变体必然不同（旧逻辑错在哪）', ORIG_SHA !== VAR_SHA);

  const done = await waitJob(listJobs, (j) => j.url === VAR_URL && (j.status === 'done' || j.status === 'failed'), 15000);
  check('② 变体 + 变体 sha256 ⇒ job done 且 verified=sha256',
    Boolean(done && done.status === 'done' && done.verified === 'sha256'),
    JSON.stringify(done && { status: done.status, verified: done.verified, error: done.error }));
  check('② 落盘字节的哈希 = 变体清单的 sha256（校验通过不是"跳过了校验"）',
    Boolean(done && existsSync(done.dest) && sha(readFileSync(done.dest)) === VAR_SHA));
  check('② job 里持久化期望值三件套：expectSha=变体哈希 / expectBytes=变体体积 / hashSource=variant',
    Boolean(done && done.expectSha === VAR_SHA && done.expectBytes === VAR_BUF.length && done.hashSource === 'variant'),
    JSON.stringify(done && { sha: done.expectSha, bytes: done.expectBytes, src: done.hashSource }));

  // 原画档仍用原画哈希（不能为了修变体把原画那条弄坏）
  const addedOrig = await call(find('/folia/downloads/add'), {
    body: {
      items: [{ kind: 'wallpaper', url: ORIG_URL, variants: [{ label: '1080p', height: 1080, url: VAR_URL, sha256: VAR_SHA }], sha256: ORIG_SHA }],
      quality: 'original',
    },
  });
  const origItem = addedOrig.json && addedOrig.json.items && addedOrig.json.items[0];
  check('② quality=original ⇒ 入队原画、用原画的 sha256',
    Boolean(origItem && origItem.chosenVariant === 'original' && origItem.url === ORIG_URL && origItem.sha256 === ORIG_SHA),
    JSON.stringify(origItem && { chosen: origItem.chosenVariant, sha: origItem.sha256 }));
  const doneOrig = await waitJob(listJobs, (j) => j.url === ORIG_URL && (j.status === 'done' || j.status === 'failed'), 15000);
  check('② 原画 + 原画 sha256 ⇒ done（正向不回归）',
    Boolean(doneOrig && doneOrig.status === 'done'),
    JSON.stringify(doneOrig && { status: doneOrig.status, error: doneOrig.error }));
  check('② 原画档的 hashSource=original（不会被变体档污染）',
    Boolean(doneOrig && doneOrig.hashSource === 'original' && doneOrig.expectSha === ORIG_SHA),
    JSON.stringify(doneOrig && { sha: doneOrig.expectSha, src: doneOrig.hashSource }));
}

/* ══ ③ 负对照（行为）：变体 URL + 原画 sha256 ⇒ 必然失败（= 旧实现）══════════ */
{
  const { createDownloadQueue } = await import('../lib/download-queue.js');
  const home = mkdtempSync(join(tmpdir(), 'folia-test-variant-hash-old-'));
  try {
    const dest = join(home, 'library', 'wallpaper', 'old' + Date.now() + '.mp4');
    mkdirSync(dirname(dest), { recursive: true });
    const q = createDownloadQueue({ home });
    q.add({ url: VAR_URL + '?old', dest, kind: 'wallpaper', sha256: ORIG_SHA });   // 旧逻辑：拿原画哈希下变体
    // 服务器按路径匹配（?old 已被 split 掉）⇒ 仍返回变体字节。
    const failed = await waitJob(() => q.snapshot(), (j) => j.status === 'failed', 15000);
    check('③ 负对照（旧逻辑）变体 URL + 原画 sha256 ⇒ failed / hash-mismatch',
      Boolean(failed && failed.status === 'failed' && /hash-mismatch/.test(String(failed.error))),
      JSON.stringify(failed && { status: failed.status, error: failed.error }));
    check('③ 负对照：失败时**没有**留下冒充成功的成品', !existsSync(dest));
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ══ ④ ENOENT 自愈：`.part` 被外部删 ⇒ 重新排队并最终 done ═══════════════════ */
{
  const { createDownloadQueue } = await import('../lib/download-queue.js');
  const BIG = makeMp4(0x33, 8 * 1024 * 1024 + 64 * 1024);   // ≥8 MB 才会走多连接（force）
  const home = mkdtempSync(join(tmpdir(), 'folia-test-enoent-'));
  const prevRanged = process.env.DSH_FOLIA_RANGED;
  const prevChunks = process.env.DSH_FOLIA_CHUNKS;
  process.env.DSH_FOLIA_RANGED = '1';
  process.env.DSH_FOLIA_CHUNKS = '2';
  const dest = join(home, 'library', 'wallpaper', 'enoent.mp4');
  mkdirSync(dirname(dest), { recursive: true });
  let deleted = 0;
  const bigSite = await startServer({
    '/big.mp4': {
      buf: BIG,
      rangeDelayMs: 120,
      onRange: () => {
        // 第一次分片请求进来时就把 `.part` 删掉（模拟外部清理）：随后 r+ 打开必然 ENOENT。
        if (deleted === 0) {
          deleted += 1;
          try { rmSync(dest + '.part', { force: true }); } catch { /* ignore */ }
        }
      },
    },
  });
  try {
    const q = createDownloadQueue({ home });
    q.add({ url: bigSite.origin + '/big.mp4', dest, kind: 'wallpaper' });
    const fin = await waitJob(() => q.snapshot(), (j) => j.status === 'done' || j.status === 'failed', 20000);
    check('④ `.part` 被外部删掉一次 ⇒ job **不是 failed**，而是重新下到 done',
      Boolean(fin && fin.status === 'done'), JSON.stringify(fin && { status: fin.status, error: fin.error }));
    check('④ 自愈后成品存在且长度正确（真的重下了，不是假装成功）',
      Boolean(existsSync(dest) && statSync(dest).size === BIG.length), existsSync(dest) ? String(statSync(dest).size) : 'missing');
    check('④ 证明它真的重试过（完整 GET 至少两次：一轮成功一次）', bigSite.state.gets > 1,
      'gets=' + bigSite.state.gets + ' · rangeHits=' + bigSite.state.rangeHits);
  } finally {
    bigSite.close();
    if (prevRanged === undefined) delete process.env.DSH_FOLIA_RANGED; else process.env.DSH_FOLIA_RANGED = prevRanged;
    if (prevChunks === undefined) delete process.env.DSH_FOLIA_CHUNKS; else process.env.DSH_FOLIA_CHUNKS = prevChunks;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ══ ⑤ 连续两次 ENOENT ⇒ failed 且原因是 file-vanished（有明确人话）════════════ */
{
  const { createDownloadQueue } = await import('../lib/download-queue.js');
  const BIG = makeMp4(0x44, 8 * 1024 * 1024 + 64 * 1024);
  const home = mkdtempSync(join(tmpdir(), 'folia-test-enoent2-'));
  const prevRanged = process.env.DSH_FOLIA_RANGED;
  const prevChunks = process.env.DSH_FOLIA_CHUNKS;
  process.env.DSH_FOLIA_RANGED = '1';
  process.env.DSH_FOLIA_CHUNKS = '2';
  const dest = join(home, 'library', 'wallpaper', 'enoent2.mp4');
  mkdirSync(dirname(dest), { recursive: true });
  // 每一轮的**第一条分片请求**都删一次（两轮 = 连续两次）⇒ 第 2 次后判 failed。
  const bigSite = await startServer({
    '/big.mp4': {
      buf: BIG,
      rangeDelayMs: 120,
      onRange: (n) => {
        if (n % 2 === 1 && n <= 3) {
          try { rmSync(dest + '.part', { force: true }); } catch { /* ignore */ }
        }
      },
    },
  });
  try {
    const q = createDownloadQueue({ home });
    q.add({ url: bigSite.origin + '/big.mp4', dest, kind: 'wallpaper' });
    const fin = await waitJob(() => q.snapshot(), (j) => j.status === 'failed', 20000);
    check('⑤ 连续两次 ENOENT ⇒ failed 且原因 = file-vanished（不是裸 ENOENT）',
      Boolean(fin && fin.status === 'failed' && fin.error === 'file-vanished'),
      JSON.stringify(fin && { status: fin.status, error: fin.error }));
    check('⑤ 两次就收手（没有无限重试：分片请求数有上界）', bigSite.state.rangeHits <= 6,
      'rangeHits=' + bigSite.state.rangeHits);
  } finally {
    bigSite.close();
    if (prevRanged === undefined) delete process.env.DSH_FOLIA_RANGED; else process.env.DSH_FOLIA_RANGED = prevRanged;
    if (prevChunks === undefined) delete process.env.DSH_FOLIA_CHUNKS; else process.env.DSH_FOLIA_CHUNKS = prevChunks;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ══ ⑥ 旧状态升级：done 但成品缺失（含旧字段全缺）⇒ 载入即重置为 pending（4.23.18）═ */
{
  const { createDownloadQueue } = await import('../lib/download-queue.js');
  const home = mkdtempSync(join(tmpdir(), 'folia-test-upgrade-'));
  try {
    const missingDest = join(home, 'library', 'wallpaper', 'gone.mp4');
    // 手工构造的 4.23.16 旧 jobs.json：done、成品不存在、**没有** enoentRetries，
    // 且故意缺 `mode` / `chosenVariant` / `priority`（更老的版本也没有）。
    writeFileSync(join(home, 'downloads.json'), JSON.stringify({
      version: 1,
      jobs: [{
        id: 'legacy-done-missing', url: 'https://site.test/missing.mp4', dest: missingDest,
        kind: 'wallpaper', total: 4096, status: 'done', error: null, at: 1,
      }],
    }), 'utf8');
    const q = createDownloadQueue({ home });
    const row = q.snapshot().find((j) => j.id === 'legacy-done-missing');
    check('⑥ 旧 downloads.json 能读（缺字段不崩）', Boolean(row), row ? 'ok' : 'missing');
    check('⑥ done 但成品不存在 ⇒ 载入后**不再**是 done（4.23.18 起是 pending，不自动入队）',
      Boolean(row && row.status === 'pending' && row.received === 0),
      JSON.stringify(row && { status: row.status, received: row.received }));
    check('⑥ 旧字段缺失 ⇒ 回落 priority=normal / mode=single / chosenVariant=original',
      Boolean(row && row.priority === 'normal' && row.mode === 'single' && row.chosenVariant === 'original'),
      JSON.stringify(row && { priority: row.priority, mode: row.mode, v: row.chosenVariant }));
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ══ ⑦ 源码级：哈希选择的唯一口径 + 客户端把变体的 sha 带回去 ═══════════════ */
{
  const route = readFileSync(join(ROOT, 'lib', 'routes', 'downloads.js'), 'utf8');
  const pick = readFileSync(join(ROOT, 'lib', 'variant-pick.js'), 'utf8');
  const lf = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  check('⑦ 期望值只有一个来源：选 1080p 时由 `resolveMediaExpectation` 给出变体的 (url,bytes,sha256)',
    /resolveMediaExpectation\(\{[\s\S]{0,400}?variants: pick\.variants,[\s\S]{0,120}?chosenUrl: pick\.url,[\s\S]{0,80}?\}, pick\.chosen\)/.test(route)
    && /url: expectation\.url[\s\S]{0,120}?sha256: expectation\.sha256/.test(route));
  check('⑦ 运行时不变式在入队前跑：期望值与 url 不自洽 ⇒ 当场 hash-source-mismatch',
    /assertExpectation\(/.test(route) && /hash-source-mismatch|sourceViolation/.test(route));
  check('⑦ 入队点不再自己从 `it.sha256` 拿哈希去校验（只把清单事实交给 resolve）',
    !/downloadQueue\.add\(\{[\s\S]{0,160}?sha256:\s*normalizeSha256\(it/.test(route)
    && !/sha256:\s*it && it\.sha256/.test(route));
  check('⑦ variant-pick 的 normalizeVariants 保留 sha256（丢掉它客户端就只能拿原画哈希）',
    /sha256/.test(pick) && /item\.sha256 = sha/.test(pick));
  check('⑦ 客户端入队条目把 `variants`（含各自 sha256）原样带回宿主',
    /entry\.variants = it\.variants/.test(lf));
  check('⑦ 失败原因表里有 file-vanished 的人话（不把 ENOENT 直接怼给用户）',
    /'file-vanished': weT\(/.test(lf));
  const dict = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');
  check('⑦ file-vanished 的中英文案都在词表里', /下载途中本地文件被清理掉了/.test(dict));
}

site.close();
cleanupTestHome(TEST_HOME);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\nVARIANT HASH / ENOENT CHECKS FAILED — ' + failed.length + ' 条：');
  for (const f of failed) console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : ''));
  process.exit(1);
}
console.log('\nALL VARIANT HASH / ENOENT CHECKS PASSED — ' + results.length + ' 条');
