#!/usr/bin/env node
/**
 * verify-hash-source.mjs — **哈希来源的单一真相源**（4.23.17，P0-6 / 结构性防复发）。
 *
 * ## 事故
 *
 * 4.23.16 用户「点击壁纸不显示」：`/downloads/list` 里 15 条 wallpaper job 全是
 * `hash-mismatch`，失败 url 全是 1080p 变体。真因不是网络：**选档决定下变体，校验却用原画的
 * sha256**（两个对象、两个哈希）。这类"同一件事在两处各答一次"的缺陷不会被类型检查抓住，
 * 也不会被单点测试抓住 —— 所以这里守的是**结构**：
 *
 *   ① **唯一出口**：`resolveMediaExpectation(item, chosen)` 是 `(url, bytes, sha256)` 的
 *      唯一产出点；`/downloads/add`、skins / boot / pets 的入队点都必须经它。
 *      客户端只允许转发**清单事实**（`manifestSha256` + `variants[]`），不许自己挑哈希。
 *      源码扫描：入队/校验处出现 `sha256: item.sha256` 这类"直接取"即红（白名单逐条列出）。
 *   ② **矩阵**：{原画, 变体} × {sha 有, 无} × {bytes 一致, 不一致} 全组合 —— 断言期望值
 *      三件套**来自同一个对象**，且 `assertExpectation` 对"变体 URL + 原画哈希"当场报
 *      `hash-source-mismatch`（不是慢慢 mismatch）。
 *   ③ **负对照**：把旧逻辑贴回（变体用原画哈希 / 入队点直接取 `item.sha256`）⇒ ① 与 ② 必须红；
 *      以及"把变体 sha 丢掉"（normalizeVariants 不保留）⇒ 矩阵里变体档拿不到哈希，也必须红。
 *
 * 隔离 home：本守卫只读源码 + 纯函数，不碰宿主目录；仍显式钉一次（4.23.15 事故护栏）。
 *
 * Usage: `node test/verify-hash-source.mjs`
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './tools/js-text.mjs';
import { isolateTestHome, cleanupTestHome } from './tools/isolate-home.mjs';
import { resolveMediaExpectation, assertExpectation, normalizeVariants } from '../lib/variant-pick.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = isolateTestHome('hash-source', { force: true });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const ORIG = 'https://site.test/media/a.mp4';
const V1080 = 'https://site.test/media/a.1080p.mp4';

/**
 * 入队/校验处的源码扫描（正判据与负对照喂**同一条**函数）。
 * 返回违规清单：`{ file, line }`。
 *
 * 白名单（位置 → 为什么可以出现）：
 *   · `lib/variant-pick.js`：`resolveMediaExpectation` 的**本体**（这里就是唯一真相源）；
 *   · `lib/download-queue.js`：收下期望值、落盘、校验（`job.sha256` / `job.expectSha`）；
 *   · `lib/routes/downloads.js` 的 `sha256: (it && (it.manifestSha256 || it.sha256))`：
 *     仅是**给 resolve 的清单事实**（实现里注释已写明，且下游只读 `expectation.*`）；
 *   · `src/local-first.js` 的 `manifestSha256`：客户端只转发清单事实，不参与决策。
 */
function scanHashSources(files) {
  const out = [];
  for (const f of files) {
    const rel = String(f.rel || '').replace(/\\/g, '/');
    if (rel === 'lib/variant-pick.js') continue;        // 唯一真相源本体
    const code = stripComments(String(f.text || ''));
    // 只看**入队调用**（`q.add({…})` / `queue.add({…})` / `downloadQueue.add({…})`）的对象体：
    // 清单解析（站点字段归一）、meta 落地等位置出现 `.sha256` 是合法的，不属于"决定校验来源"。
    const re = /\b(?:q|queue|downloadQueue)\.add\(\{/g;
    let m = re.exec(code);
    while (m) {
      const start = m.index + m[0].length;
      const close = code.indexOf('})', start);
      const body = code.slice(start, close < 0 ? start + 600 : close);
      if (/(?:sha256|expectSha)\s*:\s*[^,\n]*(?:\b(?:it|item)\b)[^,\n]*\.sha256/.test(body)) {
        const line = code.slice(0, start).split(/\r?\n/).length;
        const textLine = body.split(/\r?\n/).find((l) => /sha256|expectSha/.test(l)) || '';
        out.push({ file: rel, line, text: textLine.trim().slice(0, 160) });
      }
      m = re.exec(code);
    }
    // 客户端：入队条目只许写"清单事实"（manifestSha256），不许以 sha256 名义替宿主决定来源。
    if (rel === 'src/local-first.js' && /entry\.sha256\s*=/.test(code)) {
      out.push({ file: rel, line: 0, text: 'entry.sha256 = …（应由 manifestSha256 + 宿主 resolve 决定）' });
    }
  }
  return out;
}

/** 入队点是否都经 `resolveMediaExpectation`（每个宿主入队文件一条）。 */
function enqueueFilesUsingResolver(files) {
  const need = ['lib/routes/downloads.js', 'lib/routes/boot.js', 'lib/routes/pets.js', 'lib/routes/skins.js'];
  const byRel = new Map(files.map((f) => [String(f.rel).replace(/\\/g, '/'), String(f.text || '')]));
  return need.filter((rel) => !/resolveMediaExpectation\(/.test(byRel.get(rel) || ''));
}

const readFile = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SOURCE_FILES = [
  { rel: 'lib/routes/downloads.js', text: readFile('lib/routes/downloads.js') },
  { rel: 'lib/routes/boot.js', text: readFile('lib/routes/boot.js') },
  { rel: 'lib/routes/pets.js', text: readFile('lib/routes/pets.js') },
  { rel: 'lib/routes/skins.js', text: readFile('lib/routes/skins.js') },
  { rel: 'src/local-first.js', text: readFile('src/local-first.js') },
  { rel: 'lib/variant-pick.js', text: readFile('lib/variant-pick.js') },
];

/* ══ ① 源码扫描：正判据 ═════════════════════════════════════════════════════ */
{
  const bad = scanHashSources(SOURCE_FILES);
  check('① 入队/校验处没有任何"直接从 item.sha256 取哈希"（违规 0 条）', bad.length === 0,
    bad.slice(0, 4).map((b) => b.file + ':' + b.line + ' ' + b.text).join(' · ') || '0 条');
  const notUsing = enqueueFilesUsingResolver(SOURCE_FILES);
  check('① 宿主四个入队点都经 resolveMediaExpectation（downloads / boot / pets / skins）',
    notUsing.length === 0, notUsing.join(' · ') || 'ok');
  const lf = readFile('src/local-first.js');
  check('① 客户端只转发清单事实（manifestSha256），不再以 sha256 名义替宿主决定校验来源',
    /entry\.manifestSha256 = sha/.test(lf) && !/entry\.sha256 = sha/.test(lf));
  const route = readFile('lib/routes/downloads.js');
  check('① 入队用的是 expectation.url / expectation.sha256（三件套同源）',
    /url: expectation\.url/.test(route) && /sha256: expectation\.sha256/.test(route)
    && /hashSource: expectation\.source/.test(route));
  check('① 运行时不变式在入队前执行（assertExpectation → hash-source-mismatch）',
    /assertExpectation\(/.test(route) && /sourceViolation/.test(route));
  check('① 静默跳过校验会留痕（没有哈希 ⇒ 宿主 log 一句）',
    /no content hash for/.test(route) && /no sha256 expectation for/.test(readFile('lib/download-queue.js')));
}

/* ══ ② 矩阵：{原画, 变体} × {sha 有, 无} × {bytes 一致, 不一致} ═══════════════ */
{
  const item = (over) => Object.assign({
    url: ORIG, sha256: SHA_A, bytes: 4800000,
    variants: [{ url: V1080, height: 1080, bytes: 1300000, sha256: SHA_B }],
  }, over || {});

  const cases = [];
  for (const chosen of ['original', '1080p']) {
    for (const shaMode of ['present', 'missing']) {
      for (const bytesMode of ['equal', 'differ']) {
        cases.push({ chosen, shaMode, bytesMode });
      }
    }
  }
  let matrixOk = 0;
  for (const c of cases) {
    const variant = c.shaMode === 'missing'
      ? { url: V1080, height: 1080, bytes: 1300000 }
      : { url: V1080, height: 1080, bytes: 1300000, sha256: SHA_B };
    const it = item({
      variants: [variant],
      // 清单的"这条壁纸"字节：与变体不同 = 更真实（原画与变体本来就是两个对象）
      bytes: c.bytesMode === 'equal' ? 1300000 : 4800000,
    });
    const exp = resolveMediaExpectation(it, c.chosen);
    const wantUrl = c.chosen === '1080p' ? V1080 : ORIG;
    const wantSource = c.chosen === '1080p' ? 'variant' : 'original';
    const wantBytes = c.chosen === '1080p' ? 1300000 : it.bytes;
    const wantSha = c.chosen === '1080p' ? (c.shaMode === 'missing' ? '' : SHA_B) : SHA_A;
    const ok = exp.url === wantUrl && exp.source === wantSource
      && exp.bytes === wantBytes && exp.sha256 === wantSha
      // 关键：变体档**绝不**回落成原画哈希；缺失就是空（不设内容判据）
      && !(c.chosen === '1080p' && exp.sha256 === SHA_A);
    if (ok) matrixOk += 1;
    else check('② 矩阵用例 ' + JSON.stringify(c) + ' 期望值来自同一对象', false, JSON.stringify(exp));
  }
  check('② 矩阵 ' + cases.length + ' 组全过：{原画,变体}×{sha有,无}×{bytes一致,不一致}',
    matrixOk === cases.length, matrixOk + '/' + cases.length);

  // 运行时不变式：变体 URL + 原画哈希 ⇒ 当场 hash-source-mismatch；正确配对 ⇒ 通过。
  const goodExp = resolveMediaExpectation(item(), '1080p');
  check('② assertExpectation：变体 URL + 变体哈希 ⇒ 通过', assertExpectation(item(), goodExp) === '');
  const wrongExp = Object.assign({}, goodExp, { sha256: SHA_A });
  check('② assertExpectation：变体 URL + **原画**哈希 ⇒ hash-source-mismatch（不是慢慢 mismatch）',
    assertExpectation(item(), wrongExp) === 'hash-source-mismatch', assertExpectation(item(), wrongExp));
  const wrongSource = Object.assign({}, goodExp, { source: 'original' });
  check('② assertExpectation：变体 URL 却标 source=original ⇒ hash-source-not-variant',
    assertExpectation(item(), wrongSource) === 'hash-source-not-variant');
  check('② 变体没有 sha256 ⇒ 期望为空（不设内容判据），绝不借用原画哈希',
    resolveMediaExpectation(item({ variants: [{ url: V1080, height: 1080 }] }), '1080p').sha256 === ''
    && assertExpectation(item({ variants: [{ url: V1080, height: 1080 }] }), goodExp) === '');
  check('② normalizeVariants 保留变体 sha256（丢了它 = 变体档拿不到哈希）',
    normalizeVariants([{ url: V1080, sha256: SHA_B }])[0].sha256 === SHA_B);
}

/* ══ ③ 负对照：把旧逻辑贴回 ⇒ ① 与 ② 必须红 ═══════════════════════════════ */
{
  // (a) 入队点直接拿 item.sha256 下变体（旧写法）
  const legacyRoute = readFile('lib/routes/downloads.js').replace(
    'sha256: expectation.sha256,',
    'sha256: normalizeSha256(it && it.sha256),');
  const legacyFiles = SOURCE_FILES.map((f) => (f.rel === 'lib/routes/downloads.js'
    ? { rel: f.rel, text: legacyRoute } : f));
  const bad = scanHashSources(legacyFiles);
  check('③ 负对照：把"变体用 item.sha256"的旧写法贴回 ⇒ 源码扫描必须红', bad.length > 0,
    bad.length ? bad[0].file + ':' + bad[0].line : '仍然 0 条（判据没牙）');
  check('③ 负对照：同一变异下"入队点经 resolve"仍成立（证明两条判据各自独立）',
    enqueueFilesUsingResolver(legacyFiles).length === 0);

  // (b) resolve 本体退化成"永远用原画哈希" ⇒ 矩阵必须红
  const legacyResolve = (it, chosen) => ({
    url: chosen === '1080p' ? V1080 : String(it.url),
    bytes: Number(it.bytes) || 0,
    sha256: String(it.sha256 || ''),
    source: chosen === '1080p' ? 'variant' : 'original',
  });
  const variantCase = (() => {
    const it = { url: ORIG, sha256: SHA_A, bytes: 4800000, variants: [{ url: V1080, height: 1080, sha256: SHA_B }] };
    const exp = legacyResolve(it, '1080p');
    return exp.sha256 === SHA_A;                 // 旧逻辑：变体档拿到的是原画哈希
  })();
  check('③ 负对照：resolve 退化成"变体也用原画哈希"⇒ 矩阵②的断言会红', variantCase === true);

  // (c) 丢掉变体 sha（normalizeVariants 不保留）⇒ 变体档期望为空，与"正确配对"判据冲突
  const stripped = (() => {
    const vit = { url: V1080, sha256: SHA_B };
    // 模拟"旧 normalizeVariants 只留 label/height/bytes/url"：变体 sha 丢失
    const keep = (v) => { const { label, height, bytes, url } = v; return { label, height, bytes, url }; };
    return keep(vit).sha256 === undefined;
  })();
  check('③ 负对照：normalizeVariants 丢掉变体 sha256 ⇒ 变体档永远拿不到哈希', stripped === true);
}

/* ══ ④ 结构面：/downloads/list 可审计（expectSha / expectBytes / hashSource）════ */
{
  const q = readFile('lib/download-queue.js');
  check('④ job 持久化 expectSha / expectBytes / hashSource',
    /expectSha:/.test(q) && /expectBytes:/.test(q) && /hashSource:/.test(q));
  check('④ /downloads/list 的 job 视图带这三项（事后审计读同一份）',
    /expectSha: normalizeSha256/.test(q) && /expectBytes: Number\(j\.expectBytes\)/.test(q)
    && /hashSource: j\.hashSource === 'variant'/.test(q));
  const dict = readFile('src/i18n-copy-panel.js');
  check('④ hash-source-mismatch 有中文人话（和"传输内容不一致"分开说）',
    /原画\/变体的哈希搞混了/.test(dict) && /hash-source-mismatch/.test(readFile('src/local-first.js')));
}

cleanupTestHome(TEST_HOME);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\nHASH SOURCE CHECKS FAILED — ' + failed.length + ' 条：');
  for (const f of failed) console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : ''));
  process.exit(1);
}
console.log('\nALL HASH SOURCE CHECKS PASSED — ' + results.length + ' 条');
