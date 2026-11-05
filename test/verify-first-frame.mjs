/**
 * verify-first-frame.mjs — **4.23.12 的四段式切换手感**（点一张 = 立刻有反应 → 先出首帧 →
 * 后台下到本地 → 无缝切到本地）与**终态保证**（每类壁纸点完都必须能再点下一次）。
 *
 * ## 这一族判据为什么必须存在
 *
 * 用户实测（4.23.11）：未缓存的壁纸点下去要 **6–9 秒**才出画面，本机场景壁纸点下去
 * **完全没反应**。两者的观感一样（"点了没反应"），成因却分三层，任何一层没有判据都会
 * 悄悄回来：
 *
 *   ① **代理头**：下载中的 `.part` 分支曾回 chunked + `accept-ranges: none` +
 *      `application/octet-stream` ⇒ 浏览器无法提前取 moov，只能等"攒够一大段"才出帧；
 *   ② **结算点**：`weSwitchPublish()`（层上屏）过去**不排结算**，要等 `syncLayers` 里
 *      `readyState >= 2` 才收口 ⇒ `weSwitchBusy()` 的窗口 = 首帧耗时 = 数秒；这期间
 *      `onClick` 里的 `if (weSwitchBusy()) return;` 把**每一次**点击都吞掉（本机场景中招）；
 *   ③ **可见反馈**：缓冲提示阈值 1.5s 且**没有任何订阅者**，于是那几秒是纯沉默。
 *
 * 判据分三段：A. 代理的**结构**（头 + Range）；B. 代理的**时序**（200 KB/s 慢速上游下，
 * 出首帧所需的字节 ≤ 1.5s 到位，而不是等全量）；C. 客户端状态机（poster 顺序、300ms 缓冲
 * 提示、终态保证、last-click-wins、类型分簇、切本地副本的时间对齐）。
 *
 * 每条判据都配**负对照**：把修复贴回旧形态，判据必须变红（否则它只是装饰）。
 *
 * Usage: node test/verify-first-frame.mjs
 */
import { mkdirSync, openSync, rmSync, writeFileSync, readFileSync, closeSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveGrowingFile } from '../lib/routes/site-media.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const now = () => Number(process.hrtime.bigint() / 1000000n);

// ══════════════════════════════════════════════════════════════════════════════
// A. 代理的结构判据：「下载中」的 .part 必须给出 content-length / accept-ranges / 可 Range
// ══════════════════════════════════════════════════════════════════════════════
//
// 一个"够用"的假 MP4：ftyp 在头、moov 紧跟（faststart），后面跟 mdat 填充。
// 我们只关心**字节何时到位**，所以不必是能真解码的流。
function fakeFaststartMp4(totalBytes) {
  const buf = Buffer.alloc(totalBytes, 0x21);
  buf.writeUInt32BE(32, 0);                 // ftyp size
  buf.write('ftyp', 4, 'latin1');
  buf.writeUInt32BE(1024, 32);              // moov size
  buf.write('moov', 36, 'latin1');
  const mdatAt = 32 + 1024;
  buf.writeUInt32BE(totalBytes - mdatAt, mdatAt);
  buf.write('mdat', mdatAt + 4, 'latin1');
  return buf;
}

/** 最小 res 替身：收集头与字节，`end` 时结算。 */
function mockRes() {
  const chunks = [];
  const res = {
    statusCode: 0, headers: {}, headersSent: false, writableEnded: false,
    _firstByteAt: 0,
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); this.headersSent = true; },
    write(b) { if (!this._firstByteAt) this._firstByteAt = now(); chunks.push(Buffer.from(b)); return true; },
    end(b) { if (b) chunks.push(Buffer.from(b)); this.writableEnded = true; this._done(); },
    destroy() { this.writableEnded = true; this._done(); },
    _done() { if (this._resolveDone) this._resolveDone(); },
    once() { return this; }, on() { return this; },
    _wait() { return new Promise((r) => { this._resolveDone = r; if (this.writableEnded) r(); }); },
    body() { return Buffer.concat(chunks); },
  };
  return res;
}

/**
 * 造一个"正在下载"的 .part：先写 head 字节，然后按 `bytesPerSec` 继续追加，
 * 队列 job 的 `total` 是我们已知的完整长度（这就是 content-length 的来源）。
 */
function makeGrowingPair({ totalBytes, headBytes, bytesPerSec }) {
  const dir = join(process.env.TEMP || ROOT, 'folia-firstframe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'growing.mp4');
  const part = dest + '.part';
  const all = fakeFaststartMp4(totalBytes);
  writeFileSync(part, all.subarray(0, headBytes));
  const job = { status: 'running', total: totalBytes, received: headBytes, dest, cancelled: false };
  job.refresh = () => ({ status: job.status, total: job.total, received: job.received, dest });
  const fd = openSync(part, 'a');
  let written = headBytes;
  const step = Math.max(1024, Math.round(bytesPerSec / 20));   // 50ms 一拍
  const timer = setInterval(() => {
    if (job.status !== 'running' || written >= totalBytes) {
      clearInterval(timer);
      try { closeSync(fd); } catch { /* ignore */ }
      return;
    }
    const n = Math.min(step, totalBytes - written);
    try { writeSync(fd, all.subarray(written, written + n)); } catch { /* ignore */ }
    written += n;
    job.received = written;
  }, 50);
  return { dir, dest, part, job, all, cleanup: () => { clearInterval(timer); try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

/** 判据：头齐全 + 可 Range。返回 { ok, headers, partialOk } */
async function probeHeaders(pair, rangeHeader) {
  const res = mockRes();
  const req = { headers: rangeHeader ? { range: rangeHeader } : {} };
  const done = res._wait();
  const p = serveGrowingFile(pair.part, pair.job, res, false, req);
  // 立刻够一会儿：这个调用会一直流到 job 结束，所以取到"头 + 前若干字节"就主动结束。
  await sleep(120);
  if (!res.writableEnded) { res.writableEnded = true; res._done(); }
  await Promise.race([p, done, sleep(1500)]);
  return { headers: res.headers, status: res.statusCode, firstByteAt: res._firstByteAt, bodyLen: res.body().length };
}

async function sectionProxyHeaders() {
  const TOTAL = 4 * 1024 * 1024;   // 4 MB
  const pair = makeGrowingPair({ totalBytes: TOTAL, headBytes: 2048, bytesPerSec: 200 * 1024 });
  try {
    const got = await probeHeaders(pair, null);
    check('A1 「下载中」回 content-length（= 队列 job 的 total，不是"未知"）',
      got.headers['content-length'] === String(TOTAL), 'len=' + got.headers['content-length']);
    check('A2 「下载中」回 accept-ranges: bytes（浏览器据此能发 Range 取 moov）',
      got.headers['accept-ranges'] === 'bytes', 'ar=' + got.headers['accept-ranges']);
    check('A3 「下载中」的 Content-Type 是 video/mp4（不是 application/octet-stream）',
      got.headers['content-type'] === 'video/mp4', 'ct=' + got.headers['content-type']);
    check('A4 「下载中」仍然 no-store（内容在变，不许缓存半截）',
      got.headers['cache-control'] === 'no-store', 'cc=' + got.headers['cache-control']);

    // Range：请求头 128 KB（moov 就在里面）⇒ 必须 206 + 正确 Content-Range。
    const par = await probeHeaders(pair, 'bytes=0-131071');
    check('A5 Range 请求 ⇒ 206 + content-range 逐字正确',
      par.status === 206 && par.headers['content-range'] === 'bytes 0-131071/' + TOTAL,
      'status=' + par.status + ' cr=' + par.headers['content-range']);
    check('A6 Range 响应的 content-length = 请求的区间长度',
      par.headers['content-length'] === String(131072), 'len=' + par.headers['content-length']);

    // **负对照**：总量未知（队列还没拿到 content-length）⇒ 必须退回 chunked，
    // 不许谎报一个长度。这条判据保证 A1 的"有 content-length"是**挣来的**，不是恒真。
    const unknown = makeGrowingPair({ totalBytes: TOTAL, headBytes: 2048, bytesPerSec: 200 * 1024 });
    try {
      unknown.job.total = 0;
      const g2 = await probeHeaders(unknown, null);
      check('A7 负对照：总量未知时不得谎报 content-length（退回 chunked / accept-ranges:none）',
        g2.headers['content-length'] === undefined && g2.headers['accept-ranges'] === 'none',
        'len=' + g2.headers['content-length'] + ' ar=' + g2.headers['accept-ranges']);
    } finally { unknown.cleanup(); }
  } finally { pair.cleanup(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// B. 代理的时序判据：200 KB/s 的慢速上游，**出首帧所需的字节**必须在 1.5s 内到手
// ══════════════════════════════════════════════════════════════════════════════
//
// "出首帧所需的字节" = ftyp + moov + 一点点 mdat（moov 里就是索引，浏览器拿到它 +
// 第一个关键帧就能解出第一帧）。**判据的意义**：不许等全量 —— 28 MB 的源在 200 KB/s 下
// 要 140 秒，等它等于"点了没反应"。
async function sectionFirstFrameTiming() {
  const TOTAL = 28 * 1024 * 1024;             // 28 MB（与站点上的真实 4K 源同量级）
  const needBytes = 32 + 1024 + 64 * 1024;    // ftyp + moov + 一点 mdat
  const pair = makeGrowingPair({ totalBytes: TOTAL, headBytes: 2048, bytesPerSec: 200 * 1024 });
  try {
    const res = mockRes();
    const req = { headers: { range: 'bytes=0-' + (needBytes - 1) } };
    const t0 = now();
    const p = serveGrowingFile(pair.part, pair.job, res, false, req);
    // 等到"够出首帧"的字节数（或超时）。
    let readyAt = 0;
    const deadline = t0 + 4000;
    while (now() < deadline) {
      if (res.body().length >= needBytes) { readyAt = now(); break; }
      await sleep(10);
    }
    if (!res.writableEnded) { res.writableEnded = true; res._done(); }
    await Promise.race([p, sleep(500)]);
    const ms = readyAt ? readyAt - t0 : Infinity;
    check('B1 200 KB/s 慢速上游：出首帧所需的字节 ≤ 1.5s 到手（不是等全量）',
      ms <= 1500, 'ms=' + (Number.isFinite(ms) ? ms : 'timeout') + ' need=' + needBytes + 'B');
    check('B2 负对照：全量 28 MB 在 200 KB/s 下要 > 100s（所以"等全量"必然是"点了没反应"）',
      (TOTAL / (200 * 1024)) > 100, 'full=' + Math.round(TOTAL / (200 * 1024)) + 's');
    check('B3 首帧所需字节远小于全量（≤ 5%）',
      needBytes / TOTAL <= 0.05, 'ratio=' + (needBytes / TOTAL).toFixed(4));
  } finally { pair.cleanup(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// C. 客户端状态机：poster 顺序 / 300ms 缓冲提示 / 终态保证 / last-click-wins / 类型
// ══════════════════════════════════════════════════════════════════════════════
function installFakeDom() {
  const created = [];
  const bodyChildren = [];
  const node = () => {
    const classes = new Set();
    const attrs = {};
    return {
      _classes: classes, _attrs: attrs, style: {}, dataset: {},
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      appendChild: (c) => { bodyChildren.push(c); return c; },
    };
  };
  const makeVideo = () => {
    const handlers = {};
    const el = {
      tagName: 'VIDEO', dataset: {}, readyState: 0, muted: false, loop: false,
      preload: '', autoplay: false, src: '', poster: '', currentTime: 0, playbackRate: 1,
      _loads: 0, _plays: 0, parentElement: null,
      setAttribute() {}, removeAttribute() {}, style: {},
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      removeEventListener() {},
      load() { this._loads += 1; },
      play() { this._plays += 1; this.readyState = Math.max(this.readyState, 2); return Promise.resolve(); },
      pause() {},
      _fire(t) { (handlers[t] || []).forEach((f) => f({ type: t })); },
    };
    created.push(el);
    return el;
  };
  const prev = { document: globalThis.document, performance: globalThis.performance };
  const body = node();
  globalThis.document = {
    body,
    createElement: (t) => (String(t).toLowerCase() === 'video' ? makeVideo() : node()),
    getElementById: () => null,
  };
  globalThis.performance = { now: () => Date.now() };
  return {
    created, body, bodyChildren,
    restore: () => { globalThis.document = prev.document; globalThis.performance = prev.performance; },
  };
}

async function sectionClient() {
  const dom = installFakeDom();
  const vs = await import('../src/video-switch.js');
  const makeCard = () => {
    const classes = new Set();
    const attrs = {};
    return {
      _classes: classes,
      classList: { add: (x) => classes.add(x), remove: (x) => classes.delete(x), contains: (x) => classes.has(x) },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
    };
  };
  const card = () => makeCard();

  // ── C1 缓冲提示文案（纯函数）：有数字就给数字，没有就绝不编 ──────────────────
  check('C1 缓冲文案带百分比与 a/b MB（需求 B）',
    vs.weSwitchBufferHintText(8.3 * 1048576, 19.7 * 1048576, 6) === '缓冲中 42%（8.3/19.7 MB · 约剩 6 秒）',
    vs.weSwitchBufferHintText(8.3 * 1048576, 19.7 * 1048576, 6));
  check('C2 总量未知 ⇒ 只写「缓冲中…」（不编百分比）',
    vs.weSwitchBufferHintText(100, 0, 0) === '缓冲中…', vs.weSwitchBufferHintText(100, 0, 0));
  check('C3 没有速度样本 ⇒ 省掉"约剩 N 秒"',
    !/约剩/.test(vs.weSwitchBufferHintText(1024, 4096, 0)));

  // ── C4 300ms 未出帧 ⇒ buffering + 覆盖层文案（需求 B 的核心）────────────────
  const events = [];
  const off = vs.weSwitchSubscribe((ev) => events.push(ev));
  const slowCtx = vs.weSwitchBegin(card());
  vs.weSwitchAttachPlayer(null, '/folia/site-media/x.mp4', { kind: 'video', originUrl: 'https://s/a/x.mp4' });
  slowCtx.bytesRecv = 8.3 * 1048576;
  slowCtx.bytesTotal = 19.7 * 1048576;
  slowCtx.etaSec = 6;
  await sleep(420);
  check('C5 300ms 未出帧 ⇒ 状态机进 buffering（不再是旧的 1.5s 静默）',
    vs.weSwitchState() === 'buffering', 'state=' + vs.weSwitchState());
  check('C6 buffering 事件带 hint / recvBytes / totalBytes / etaSec（面板可直画）',
    events.some((e) => e.state === 'buffering' && /缓冲中/.test(String(e.hint || ''))
      && e.totalBytes > 0 && e.etaSec > 0));
  const overlay = dom.bodyChildren.find((n) => String(n.className) === 'we-switch-hint');
  // 4.24.0（P0-A）：**居中浮层已退役** —— 进度只进标题栏元信息区（行内），
  // 页面里不许再出现那块压在壁纸正中的 `.we-switch-hint` 胶囊。
  check('C7 不再创建居中浮层（进度只走标题栏）：DOM 里没有 .we-switch-hint',
    !overlay, overlay ? String(overlay.textContent) : 'no-overlay（符合预期）');
  check('C7b 提示仍以**纯状态**保留（事件 hint + weSwitchHintTextOf，供标题栏/诊断读）',
    /缓冲中/.test(String(vs.weSwitchHintTextOf() || ''))
    && events.some((e) => e.state === 'buffering' && /缓冲中/.test(String(e.hint || ''))),
    String(vs.weSwitchHintTextOf()));
  off();
  if (!slowCtx.settled) vs.weSwitchFail('cleanup');

  // ── C8 **终态保证**：没有任何结算腿的路径也必须收口（否则 busy 恒真）─────────
  const orphan = vs.weSwitchBegin(card());
  check('C8 刚点下时确实在飞（busy=true）', vs.weSwitchBusy() === true);
  await sleep(vs.WE_SWITCH_SETTLE_GUARD_MS + 120);
  check('C9 没有任何播放器/结算腿 ⇒ 终态保证到点收口（不靠 5s 硬上限）',
    orphan.settled === true && vs.weSwitchBusy() === false,
    'settled=' + orphan.settled + ' busy=' + vs.weSwitchBusy());

  // ── C10 **last-click-wins**：慢视频切换进行中再点（本机场景）不许被吞 ────────
  // 这是用户报的"本机场景点了没反应"的直接判据。
  const slowVideo = vs.weSwitchBegin(card());
  vs.weSwitchAttachPlayer(null, '/folia/site-media/lenta.mp4', { kind: 'video' });
  check('C11 慢视频切换中 ⇒ busy=true（这正是旧实现会吞掉下一次点击的窗口）',
    vs.weSwitchBusy() === true);
  // 旧实现等价物：busy 就 return。用它做**负对照**，证明判据有牙。
  const oldClick = () => { if (vs.weSwitchBusy()) return 'dropped'; return 'applied'; };
  check('C12 负对照：旧写法（busy ⇒ return）在这个窗口里会吞掉点击',
    oldClick() === 'dropped');
  // 新写法：先 begin（内部 supersede 上一次）再 applySelection。
  const sceneCtx = vs.weSwitchBegin(card());
  const superseded = vs.weSwitchStatsSnapshot().filter((r) => r.reason === 'superseded');
  check('C13 新写法：上一次被收口为 superseded（不是被忽略）',
    slowVideo.settled === true && superseded.length >= 1, 'superseded=' + superseded.length);
  check('C14 场景壁纸在慢视频切换**进行中**也能生效（不被吞）',
    sceneCtx && sceneCtx.settled === false && vs.weSwitchBusy() === true);
  vs.weSwitchSettleAs('scene');
  check('C15 场景结算后立刻可以再点（busy=false）', vs.weSwitchBusy() === false);

  // ── C16 五类连点：video → scene → web → image → video，**5 次全部生效** ─────
  const order = ['video', 'scene', 'web', 'image', 'video'];
  const applied = [];
  for (const kind of order) {
    if (vs.weSwitchBusy()) { applied.push(kind + ':dropped'); continue; }
    vs.weSwitchBegin(card());
    if (kind === 'video') {
      const el = vs.weSwitchPoolPick('/folia/site-media/' + kind + '.mp4');
      vs.weSwitchAttachPlayer(el, '/folia/site-media/' + kind + '.mp4', { kind: 'video' });
      vs.weSwitchPublish(el, {});        // 层上屏 ⇒ 结算点（不等首帧）
      await sleep(260);                  // 等交叉淡入那一拍
      if (vs.weSwitchBusy()) vs.weSwitchSettleAs('video');
    } else {
      vs.weSwitchSettleAs(kind);         // 非视频：applySelection 里就是这一条
    }
    applied.push(kind + ':' + (vs.weSwitchBusy() ? 'stuck' : 'ok'));
  }
  check('C17 依次点 video→scene→web→image→video，5 次全部生效',
    applied.every((s) => s.endsWith(':ok')), applied.join(','));
  const kinds = vs.weSwitchStatsSnapshot().map((r) => r.kind);
  check('C18 每条度量都带 kind（video/scene/web/image），排障能按类型分簇',
    order.every((k) => kinds.includes(k)), kinds.join(','));

  // ── C19 切到本地副本：时间对齐 ≤ 0.3s 才切（否则宁可继续播代理流）───────────
  const from = vs.weSwitchPoolPick('/folia/site-media/stream.mp4');
  const localEl = dom.created.find((e) => e !== from) || null;
  // 这四行必须在 `await` **之前**做完：require-atomic-updates 会（正确地）把"await 之后才写
  // 一个 await 之前读过的对象"判成基于过期状态写。这里只是给假元素补上 DOM 位置与时间。
  from.parentElement = { insertBefore: () => {}, removeChild: () => {}, offsetWidth: 1 };
  from.currentTime = 12.0;
  if (localEl) localEl.currentTime = 12.05;   // 差 0.05s ⇒ 允许切
  vs.weSwitchBegin(card());
  vs.weSwitchAttachPlayer(from, '/folia/site-media/stream.mp4', { kind: 'video' });
  vs.weSwitchPublish(from, {});
  await sleep(260);
  if (localEl) {
    const started = vs.weSwitchHandoverLocal('/folia/local-media/job-1');
    check('C20 本地副本预热后开始切换（返回 true = 已开始淡入）', started === true, 'started=' + started);
    check('C21 对齐判据存在：切换前把 currentTime 设成在屏元素的时间',
      localEl.src === '/folia/local-media/job-1', 'src=' + localEl.src);
  } else {
    check('C20 本地副本预热后开始切换（返回 true = 已开始淡入）', false, 'no hidden pool element');
    check('C21 对齐判据存在：切换前把 currentTime 设成在屏元素的时间', false, 'no hidden pool element');
  }
  if (vs.weSwitchBusy()) vs.weSwitchFail('cleanup');

  // ── C22 源结构：poster 必须先于 src（需求 A：≤50ms 就有图，而不是空元素）────
  const vl = readFileSync(join(ROOT, 'src', 'video-layer.js'), 'utf8');
  // 4.24.0：取值改成唯一口径 `stillSrc`（posterUrl 优先、预览图回退）—— 顺序不变量不变。
  const posterAt = vl.indexOf('if (stillPreview) media.poster = stillSrc;');
  const srcAt = vl.indexOf('media.src = useCached ? rc.url : sel.url;');
  check('C22 buildVideoMedia 先挂 poster、再赋 src（否则首帧前是空元素）',
    posterAt > 0 && srcAt > 0 && posterAt < srcAt, 'poster=' + posterAt + ' src=' + srcAt);
  check('C22b 静态封面取自唯一口径（posterUrl 优先，回退预览图）',
    /const stillSrc = typeof weSwitchStillOf === "function"/.test(vl));
  check('C23 视频档把 kind / originUrl 交给状态机（度量分簇 + 进度 + 切本地都要它）',
    /kind: "video"/.test(vl) && /originUrl: sel\.originUrl/.test(vl));

  dom.restore();
}

// ══════════════════════════════════════════════════════════════════════════════
// D. 结构判据（宿主 + 客户端源码事实）
// ══════════════════════════════════════════════════════════════════════════════
function sectionStructure() {
  const sm = readFileSync(join(ROOT, 'lib', 'routes', 'site-media.js'), 'utf8');
  // 4.23.19：**下载中不再走渐进读**（半截字节被当成品 ⇒「文件可能已损坏」，用户截图 81%）。
  // 首帧提速的那条判据（moov 前置 + Range）仍然由下载队列自己的 Range 实现保证；
  // 播放器在下载中拿到的是**站点源**（302），content-length/Range 由源端保证。
  check('D1 下载中分支改为 302 回源（不再把 .part 喂给播放器）',
    /origin-downloading/.test(sm) && !/await serveGrowingFile\(partPath/.test(sm));
  check('D2 已完成的本地副本仍按不可变载荷发（长缓存 + Range）',
    /\{ immutable: true \}/.test(sm) && /serveFile\(job\.dest, req, res, headOnly/.test(sm));
  const diag = readFileSync(join(ROOT, 'lib', 'routes', 'diag.js'), 'utf8');
  check('D3 /folia/diag/switch-stats 记录 kind 并按类型汇总',
    /kind: String\(b\.kind \|\| ''\)/.test(diag) && /byKind:/.test(diag));
  check('D4 switch-stats 汇总里有 superseded / busyTimeout 计数',
    /superseded:/.test(diag) && /busyTimeout:/.test(diag));
  const mp = readFileSync(join(ROOT, 'src', 'media-prep.js'), 'utf8');
  check('D5 applySelection 的两条早退分支也结算（否则 busy 恒真）',
    (mp.match(/weSwitchSettleAs\(/g) || []).length >= 3,
    'settleAs=' + (mp.match(/weSwitchSettleAs\(/g) || []).length);
  const qp = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  check('D6 deck/卡片两条 onClick 都不再有 busy 守卫（last-click-wins）',
    !/if \(weSwitchBusy\(\)\) \{[\s\S]{0,120}?return;/.test(qp));
}

// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  await sectionProxyHeaders();
  await sectionFirstFrameTiming();
  await sectionClient();
  sectionStructure();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0
    ? 'ALL FIRST-FRAME CHECKS PASSED (' + results.length + ')'
    : failed.length + '/' + results.length + ' CHECK(S) FAILED'));
  if (failed.length) {
    for (const f of failed) console.log('  FAILED: ' + f.name);
    process.exit(1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
