/**
 * verify-install-flow.mjs — 下载/安装**状态机**的流程级回归（4.23.6）。
 *
 * ## 为什么要有这一页（这一页就是"以后不要再出现这类问题"的那道闸）
 *
 * 4.23.4–4.23.5 里，皮肤/开机动画/桌宠的"下载 → 落地 → 可点"是**一处一处修**的：每次都是
 * 用户先撞上、我再去补一个格子，然后下一个格子又漏。根因不是某一行写错，而是"卡片该显示什么"
 * 这件事从来没有一张**完整的表** —— 单点单测只钉住"我这次改的那一格"，改别处照样能把它撞坏。
 *
 * 所以这里不按"函数"测，按**状态机**测：
 *   A. **覆盖表**（14 行）：本地状态 × 队列状态 × 是否已安装 × 时长 ⇒ 展示状态 + 是否可点。
 *      每一行同时钉住"文案里必须有的那句话"和"按钮的可用性" —— 真实故障的症状从来都是
 *      "卡片看着在干活、其实点不了也永远不动"。
 *   B. **端到端**：真站点替身 + 真宿主路由 + 真下载队列 + 真 zip，跑完
 *      点击 → 200 → installed；点击 → 202+jobId → 排队 → 下载 → done → 自动安装 → installed；
 *      再加两条**故障注入**（宿主重启清空 job 表 / 站点 500），各判"会不会永久转圈"。
 *   C. 文档对账：`docs/INSTALL-FLOW.md` 里必须逐条列出这些用例编号（那张表就是防复发清单）。
 *
 * 客户端部分取的是 `src/local-first.js` 的**真源码**（切片后在 Function 里跑），宿主接口用假实现替换 ——
 * 面板本来也只是通过 `apiJson` / `apiPostJson` 拿数据，所以这是同一个决策面。
 *
 * Usage: `node test/verify-install-flow.mjs`
 */
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerSkinsRoutes, installGateTry, installGateRelease, installGateMarkDone, INSTALL_GATE_TTL_MS } from '../lib/routes/skins.js';import { getDownloadQueue, installStallMs } from '../lib/routes/downloads.js';
import { pickVariant } from '../lib/variant-pick.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });

/* ── 客户端状态机：把 src/local-first.js 的那一段**真代码**取出来跑 ────────────
 *
 * 为什么不复制一份"期望逻辑"：复制品永远不会和真代码一起漂，判据就恒绿。
 * 准星是"面板拿到的那个 stateOf() 到底给出什么"，所以取真源码、只换掉网络出口。 */
function loadClient(transport) {
  const src = readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8');
  const a = src.indexOf('const DL_POLL_MS = 1500;');
  const b = src.indexOf('function useDownloadJobs(');
  if (a < 0 || b <= a) return null;
  const slice = src.slice(a, b);
  const shim = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
  const t = transport || {};
  try {
    return new Function('weT', 'apiJson', 'apiPostJson', slice + `
return { DL_PHASES, DL_INSTALL_STALL_MS, DL_JOB_MISS_LIMIT, dlCardState, dlFailReason,
  dlInstallStallMs, dlHealStuck, dlHealTargets, dlStaleCards, dlAwaitJob, dlJobForCard, skinInstalledMatch };`)(
      shim,
      t.apiJson || (async () => ({ ok: true, data: { jobs: [] } })),
      t.apiPostJson || (async () => ({ ok: true, data: { ok: true } })),
    );
  } catch { return null; }
}

/* ── 假站点：清单 + 三个 zip（快包 / 慢包 / 失败包）────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** 最小 zip 写入器（store / deflate 都支持；`data` 可以是 Buffer）。 */
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const method = f.deflate === false ? 0 : 8;
    const payload = method === 8 ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(payload.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, payload); central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }
  const cbuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cbuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cbuf, eocd]);
}

const manifestOf = (id, name) => JSON.stringify({
  id, name, nameEn: name, version: '0.1.0', author: 'folia-test',
  contributes: { stylesheet: 'skin.css' },
});
/** 预置"本机已装"的那一套（A9 要用它判"查不到但已装好 ⇒ done"）。 */
const PRE_ID = 'preinstalled-skin';
const FAST_ID = 'e2e-fast-skin';
const SLOW_ID = 'e2e-slow-skin';
/** A18 用：装完必须刷新清单（这一套只走"成功 → markOk → load(true)"那条路）。 */
const REFRESH_ID = 'refresh-skin';
const ZIP_FAST = makeZip([
  { name: 'skin.json', data: manifestOf(FAST_ID, '端到端·快包') },
  { name: 'skin.css', data: '[data-dsh-skin="' + FAST_ID + '"]{--x:1}' },
]);
/** A15 用：栅栏判据要断言"第二次真的没落盘"，所以这一套的 id 必须与目录名一致。 */
const GATE_ID = 'gate-skin';
const ZIP_GATE = makeZip([
  { name: 'skin.json', data: manifestOf(GATE_ID, '栅栏验证') },
  { name: 'skin.css', data: '[data-dsh-skin="' + GATE_ID + '"]{--x:1}' },
]);
/** A17 用：另一套（目录还不存在）⇒ 才能走到栅栏那一格，而不是被 `exists` 早退。 */
const GATE2_ID = 'gate2-skin';
const ZIP_GATE2 = makeZip([
  { name: 'skin.json', data: manifestOf(GATE2_ID, '栅栏验证 2') },
  { name: 'skin.css', data: '[data-dsh-skin="' + GATE2_ID + '"]{--x:1}' },
]);
const ZIP_REFRESH = makeZip([
  { name: 'skin.json', data: manifestOf(REFRESH_ID, '刷新验证') },
  { name: 'skin.css', data: '[data-dsh-skin="' + REFRESH_ID + '"]{--x:1}' },
]);
/** 慢包：body 卡 slowDelayMs 才发 ⇒ 宿主 8 秒窗口内必然还没 done ⇒ 走 202 + jobId 那条路。 */
const SLOW_PAD = Buffer.alloc(1024 * 1024, 7);
const ZIP_SLOW = makeZip([
  { name: 'skin.json', data: manifestOf(SLOW_ID, '端到端·慢包') },
  { name: 'skin.css', data: '[data-dsh-skin="' + SLOW_ID + '"]{--x:1}' },
  { name: 'assets/pad.bin', data: SLOW_PAD, deflate: false },
]);
const slowDelayMs = 9000;
let slowHits = 0;
const server = createServer((req, res) => {
  const u = String(req.url || '');
  if (u.startsWith('/api/public/wallpapers')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      data: {
        items: [
          { slug: PRE_ID, title: '预置·已装', bytes: 1, mime: 'application/zip', url: '/media/pre.zip', thumbUrl: '/media/t0.jpg', tags: '["皮肤"]' },
          { slug: FAST_ID, title: '端到端·快包', bytes: ZIP_FAST.length, mime: 'application/zip', url: '/media/fast.zip', thumbUrl: '/media/t1.jpg', tags: '["皮肤"]' },
          { slug: SLOW_ID, title: '端到端·慢包', bytes: ZIP_SLOW.length, mime: 'application/zip', url: '/media/slow.zip', thumbUrl: '/media/t2.jpg', tags: '["皮肤"]' },
        ],
      },
    }));
    return;
  }
  if (u === '/media/fast.zip') { res.setHeader('content-type', 'application/zip'); res.end(ZIP_FAST); return; }
  if (u === '/media/gate.zip') { res.setHeader('content-type', 'application/zip'); res.end(ZIP_GATE); return; }
  if (u === '/media/gate2.zip') { res.setHeader('content-type', 'application/zip'); res.end(ZIP_GATE2); return; }
  if (u === '/media/refresh.zip') { res.setHeader('content-type', 'application/zip'); res.end(ZIP_REFRESH); return; }
  if (u === '/media/slow.zip') {
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-length', String(ZIP_SLOW.length));
    if (req.method === 'HEAD') { res.end(); return; }   // 预检不许被 9 秒拖住
    slowHits += 1;
    try { res.flushHeaders(); } catch { /* 老实现没有 flushHeaders 也不致命 */ }
    setTimeout(() => { try { res.end(ZIP_SLOW); } catch { /* 客户端可能已断开 */ } }, slowDelayMs);
    return;
  }
  if (u === '/media/fail.zip') { res.statusCode = 500; res.end('boom'); return; }
  res.statusCode = 404;
  res.end('nope');
});
await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
const site = 'http://127.0.0.1:' + server.address().port;

/* ── 环境：$DSH_HOME 指到临时目录；站点基址指到假站点（宿主路由据此下载）────── */
const dshHome = mkdtempSync(join(tmpdir(), 'folia-flow-'));
process.env.DSH_HOME = dshHome;
process.env.DSH_FOLIA_SITE = site;
mkdirSync(join(dshHome, 'skins', PRE_ID), { recursive: true });
writeFileSync(join(dshHome, 'skins', PRE_ID, 'skin.json'), manifestOf(PRE_ID, '预置·已装'), 'utf8');
writeFileSync(join(dshHome, 'skins', PRE_ID, 'skin.css'), 'x', 'utf8');

const routes = [];
registerSkinsRoutes({ register: (spec) => { routes.push(spec); return () => {}; } }, { disposers: [], base: '/folia', log: () => {} });
const find = (p) => routes.find((r) => r.path === p);
const installRoute = find('/folia/skins/install');
const listRoute = find('/folia/skins/list');

/** 直接调宿主路由（不起第二个 http server：与 skins-http.mjs 同一套假 req/res）。 */
function call(route, { method = 'GET', body = null, url = null } = {}) {
  return new Promise((resolve) => {
    const resObj = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(s) { resolve({ status: this.statusCode, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }); },
    };
    const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      method, url: url || route.path, headers: {},
      on(ev, fn) {
        if (ev === 'data') for (const c of chunks) fn(c);
        if (ev === 'end') setTimeout(fn, 0);
        if (ev === 'error') { /* 不触发 */ }
        return this;
      },
    };
    route.handler(req, resObj);
  });
}

/** `/skins/list` 的 installed 里有没有这一套（"到底装没装"的唯一真源）。 */
async function listedInstalled(id) {
  const r = await call(listRoute, { url: '/folia/skins/list?refresh=1' });
  const list = (r && r.json && r.json.installed) || [];
  return list.some((x) => x && x.id === id);
}

const client = loadClient();
check('R1 客户端状态机（src/local-first.js 的真代码）能被取出来跑', Boolean(client), client ? 'ok' : '切片失败');
check('R2 宿主路由齐了（install / list）', Boolean(installRoute && listRoute));
/** 端到端用：`/downloads/list` 换成**真队列**的快照（E3 故意用空列表模拟宿主重启）。 */
const clientLive = loadClient({
  apiJson: async () => ({ ok: true, data: { jobs: getDownloadQueue().snapshot() } }),
});

/* ══ A. 状态机覆盖表（14 行）══════════════════════════════════════════════════
 *
 * 每一行 = (本地状态 × 队列状态 × 是否已安装 × 时长) ⇒ 展示状态 + 是否可点 + 文案。
 * 断言的是**用户能看到的东西**（phase / label / 那句人话 / 按钮可行性），不是内部字段好不好看。
 * 编号 A1–A14 与 `docs/INSTALL-FLOW.md` 的表一一对应。 */
const A = [];
const labels = { idle: '安装', done: '已安装', failed: '重试' };
if (client) {
  const NOW = 1_700_000_000_000;
  const st = (o) => client.dlCardState(Object.assign({ id: 'card-1', labels, nowMs: NOW }, o || {}));

  // A1 idle + 无 job + 未安装 → idle / 可点
  {
    const s = st({ job: null, done: false });
    A.push({ id: 'A1', name: 'idle：无 job、未安装 → 可点「安装」', ok: s.phase === 'idle' && s.label === '安装' && s.disabled === false && s.retry === false, detail: JSON.stringify(s) });
  }
  // A2 submitting：请求在途 → 不可点（且看得出在等）
  {
    const s = st({ job: null, sub: { id: 'card-1', at: NOW - 4000 } });
    A.push({ id: 'A2', name: 'submitting：请求在途 → 不可点、有已等待秒数', ok: s.phase === 'submitting' && s.disabled === true && s.label.includes('正在提交') && s.detail.includes('已等待'), detail: JSON.stringify(s) });
  }
  // A3 queued → 排队位置可见 / 不可点
  {
    const s = st({ job: { id: 'j1', status: 'queued', queuePos: 3 } });
    A.push({ id: 'A3', name: 'queued → 排队位置可见、不可点', ok: s.phase === 'queued' && s.disabled === true && s.label.includes('排队中') && s.detail.includes('前面还有 2 个'), detail: JSON.stringify(s) });
  }
  // A4 running → 「下载中 x%」+ a/b MB / 不可点
  {
    const job = { id: 'j1', status: 'running', percent: 50, received: 8.3 * 1048576, total: 16.6 * 1048576, mode: 'single' };
    const s = st({ job, etaSec: 12 });
    A.push({ id: 'A4', name: 'running（50%）→ 百分比 + a/b MB、不可点', ok: s.phase === 'running' && s.disabled === true && s.label === '下载中… 50%' && /8\.3\/16\.6 MB/.test(s.detail) && s.detail.includes('约剩 12 秒'), detail: JSON.stringify(s) });
  }
  // A5 done + 未安装 + 未超时 → installing / 不可点（不误判）
  {
    const s = st({ job: { id: 'j1', status: 'done' }, done: false, installingSince: NOW - 3000, installStallMs: 90000 });
    A.push({ id: 'A5', name: 'done 但未落地（3 秒）→ 解压/落位中、不可点', ok: s.phase === 'installing' && s.disabled === true && s.retry === false && s.label.includes('解压'), detail: JSON.stringify(s) });
  }
  // A6 done + 未安装 + 超时（窗口调小到 5 秒）→ failed / 可点 /「重试」
  {
    const backup = process.env.DSH_FOLIA_INSTALL_STALL_MS;
    process.env.DSH_FOLIA_INSTALL_STALL_MS = '5000';
    const hostMs = installStallMs();   // 宿主解析（客户端不读 process.env，只收这个数字）
    const s = st({ job: { id: 'j1', status: 'done' }, done: false, installingSince: NOW - 6000, installStallMs: hostMs });
    if (backup === undefined) delete process.env.DSH_FOLIA_INSTALL_STALL_MS;
    else process.env.DSH_FOLIA_INSTALL_STALL_MS = backup;
    A.push({ id: 'A6', name: 'done 但未落地（超时，窗口=5 秒）→ failed +「重试」可点', ok: hostMs === 5000 && s.phase === 'failed' && s.disabled === false && s.retry === true && s.label === '重试' && s.reason.includes('安装未落地'), detail: JSON.stringify({ hostMs, s }) });
  }
  // A7 done + 已安装 → done（安装按钮置灰，「应用」在页签里单独渲染）
  {
    const s = st({ job: { id: 'j1', status: 'done' }, done: true });
    const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
    const applyBtn = /weT\("应用"\)/.test(skinsTab);
    A.push({ id: 'A7', name: 'done 且已安装 → done（页签给「应用」）', ok: s.phase === 'done' && s.label === '已安装' && s.disabled === true && applyBtn, detail: JSON.stringify({ s, applyBtn }) });
  }
  // A8 jobId 连续 5 次查不到 → failed / 可点 /「下载任务已丢失」
  {
    let polls = 0;
    const c = loadClient({ apiJson: async () => { polls += 1; return { ok: true, data: { jobs: [] } }; } });
    const t0 = Date.now();
    const waited = await c.dlAwaitJob('ghost-job', 120000);
    const took = Date.now() - t0;
    const s = st({ job: null, err: { code: 'job-lost' } });
    A.push({
      id: 'A8', name: 'jobId 查不到（宿主重启/队列重置）→ failed +「下载任务已丢失」',
      ok: Boolean(waited) && waited.status === 'lost' && took < 20000 && c.DL_JOB_MISS_LIMIT === 5
        && s.phase === 'failed' && s.retry === true && s.disabled === false && s.reason.includes('下载任务已丢失'),
      detail: JSON.stringify({ waited: waited && waited.status, polls, took, s }),
    });
  }
  // A9 jobId 查不到、但 installed 里已有 → done（列表是唯一真源）
  {
    const already = await listedInstalled(PRE_ID);
    const s = st({ job: null, done: already });
    A.push({ id: 'A9', name: 'jobId 查不到但 installed 已有 → done', ok: already === true && s.phase === 'done', detail: JSON.stringify({ already, phase: s.phase }) });
  }
  // A10 本地 installing 但队列里无对应 job → 回落 idle / 可点
  {
    const items = [{ id: FAST_ID, url: site + '/media/fast.zip' }];
    const stale = client.dlStaleCards([], 'skin', items, () => false);
    const s = st({ job: null, done: false });
    A.push({ id: 'A10', name: '本地残留 installing 但队列无 job → 回落 idle 可点', ok: stale.length === 1 && s.phase === 'idle' && s.disabled === false, detail: JSON.stringify({ stale: stale.length, s }) });
  }
  // A11 failed + error=404 → 说得出"站点上没有这个文件"
  {
    const s = st({ job: { id: 'j1', status: 'failed', error: 'http-404' } });
    A.push({ id: 'A11', name: 'failed（HTTP 404）→ 站点上没有这个文件', ok: s.phase === 'failed' && s.retry === true && s.reason.includes('404') && s.reason.includes('站点上'), detail: s.reason });
  }
  // A12 failed + error=fetch failed → 说得出"连不上站点"
  {
    const s = st({ job: { id: 'j1', status: 'failed', error: 'fetch failed' } });
    A.push({ id: 'A12', name: 'failed（fetch failed）→ 连不上站点', ok: s.phase === 'failed' && s.retry === true && s.reason.includes('连不上站点'), detail: s.reason });
  }
  // A13 重复点击：submitting 中再点 ⇒ 只发 1 个请求
  {
    let sends = 0;
    // 与真实面板同一条语义：按钮 disabled: st.disabled，禁用的按钮不会触发 onClick。
    const click = (state) => { if (state.disabled) return false; sends += 1; return true; };
    const first = click(st({ job: null }));
    const afterFirst = st({ job: null, sub: { id: 'card-1', at: NOW } });
    const second = click(afterFirst);
    const third = click(afterFirst);
    A.push({ id: 'A13', name: '重复点击（提交中再点两次）→ 只发 1 个请求', ok: first === true && second === false && third === false && sends === 1, detail: JSON.stringify({ sends }) });
  }
  // A14 慢链路 + 1080p 变体可用 → 选 1080p 且界面有标注
  {
    const picked = pickVariant({
      originalUrl: site + '/media/orig.mp4',
      originalBytes: 30 * 1048576,
      variants: [{ url: site + '/media/orig-1080.mp4', height: 1080, label: '1080p', bytes: 6 * 1048576 }],
      hostSlow: true,
    });
    const i18n = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');
    const badge = i18n.includes(JSON.stringify(' · 1080p'));
    const note = i18n.includes(JSON.stringify('已按 1080p 变体下载：{name}（省流量；可在面板点「用原画」改回）'));
    const row = client.dlJobForCard(
      [{ id: 'j1', url: site + '/media/orig-1080.mp4', kind: 'wallpaper', status: 'running', percent: 10, chosenVariant: '1080p' }],
      'wallpaper', site + '/media/orig-1080.mp4');
    A.push({
      id: 'A14', name: '慢链路 + 1080p 可用 → 选 1080p 且有「· 1080p」标注',
      ok: picked.chosen === '1080p' && picked.reason === 'slow-link' && badge && note
        && Boolean(row) && row.chosenVariant === '1080p',
      detail: JSON.stringify({ chosen: picked.chosen, reason: picked.reason, badge, note }),
    });
  }
}

/* ══ A15–A20：「装了两遍」与「第二遍装完仍停在解压/落位中…」（4.23.6 追加）══════
 *
 * 真实故障（用户实测，4.23.5）：进度条满了之后又装了一遍；第二遍装完仍停在「解压/落位中…」。
 * 根因：同一次点击有两条安装路径（客户端 202 轮询 / 宿主 scheduleFinishInstall 自调用），
 * 谁也不认识谁 ⇒ 重复解压；而"装在哪个目录、skin.json 里的 id 是什么、站点 slug 是什么"
 * 三者不总相同 ⇒ 装好了却判成没装。
 * 判据：宿主栅栏（去重）+ 客户端先查再发 + installed 三合一归一 + 成功即 markOk + 4xx/5xx 可重试。 */
if (client) {
  const st2 = (o) => client.dlCardState(Object.assign({ id: 'card-2', labels, nowMs: 1_700_000_000_000 }, o || {}));

  // A15 同一次点击只产生 1 次实际解压（宿主栅栏生效）
  {
    const ttlOk = INSTALL_GATE_TTL_MS === 2 * 60 * 1000;
    const frozen = 9_000_000;
    const first = installGateTry('ttl-probe', frozen);
    const second = installGateTry('ttl-probe', frozen + 1000);
    const expired = installGateTry('ttl-probe', frozen + INSTALL_GATE_TTL_MS + 1);
    installGateRelease('ttl-probe');
    const taken = installGateTry(GATE_ID);
    const dup = await call(installRoute, { method: 'POST', body: { id: GATE_ID, url: site + '/media/gate.zip' } });
    const dupWrote = existsSync(join(dshHome, 'skins', GATE_ID, 'skin.json'));
    installGateRelease(GATE_ID);
    const real = await call(installRoute, { method: 'POST', body: { id: GATE_ID, url: site + '/media/gate.zip' } });
    const realWrote = existsSync(join(dshHome, 'skins', GATE_ID, 'skin.json'));
    // 装完之后栅栏被标记 done ⇒ 同 id 再来一次会放行（会被 exists 早退挡住，不会二次解压）
    installGateMarkDone(GATE_ID);
    const afterDone = installGateTry(GATE_ID);
    installGateRelease(GATE_ID);
    A.push({
      id: 'A15', name: '同一次点击只解压 1 次：宿主栅栏 deduped、且第二次不落盘',
      ok: ttlOk && first === true && second === false && expired === true
        && taken === true && dup.status === 200 && dup.json.deduped === true && dupWrote === false
        && real.status === 200 && !real.json.deduped && realWrote === true && afterDone === true,
      detail: JSON.stringify({ ttlOk, first, second, expired, dupStatus: dup.status, deduped: dup.json && dup.json.deduped, dupWrote, realWrote, afterDone }),
    });
  }

  // A16 install 返回 exists:true → 卡片立即「已安装」，不进入 installing
  {
    const r = await call(installRoute, { method: 'POST', body: { id: PRE_ID, url: site + '/media/pre.zip' } });
    const card = st2({ job: null, done: true });   // 客户端 onOk ⇒ cards.markOk() 之后的状态
    const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
    const markOkFirst = /if \(cardId\) cards\.markOk\(cardId\);/.test(skinsTab)
      && skinsTab.indexOf('cards.markOk(cardId)') < skinsTab.indexOf("weT(\"已安装过：{name}\"");
    A.push({
      id: 'A16', name: 'install 返回 exists:true → 立刻「已安装」（不进 installing）',
      ok: r.status === 200 && r.json.exists === true && card.phase === 'done' && markOkFirst,
      detail: JSON.stringify({ status: r.status, exists: r.json && r.json.exists, phase: card.phase, markOkFirst }),
    });
  }

  // A17 install 返回 deduped:true → 卡片不重复解压、也不假失败（保持有上界的进行中/done）
  {
    installGateTry(GATE2_ID);
    const r = await call(installRoute, { method: 'POST', body: { id: GATE2_ID, url: site + '/media/gate2.zip' } });
    const wrote = existsSync(join(dshHome, 'skins', GATE2_ID, 'skin.json'));
    installGateRelease(GATE2_ID);
    const asInstalling = st2({ job: { id: 'jg', status: 'done' }, done: false, installingSince: Date.now() });
    const asDone = st2({ job: null, done: true });
    const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
    const handled = /r\.deduped/.test(skinsTab) && /这套皮肤正在安装中，稍后自动刷新/.test(skinsTab);
    A.push({
      id: 'A17', name: 'install 返回 deduped:true → 不重复解压、不假失败（有上界）',
      ok: r.status === 200 && r.json.deduped === true && r.json.pending === true
        && wrote === false && handled
        && asInstalling.phase === 'installing' && asDone.phase === 'done' && asInstalling.phase !== 'failed',
      detail: JSON.stringify({ status: r.status, deduped: r.json && r.json.deduped, wrote, handled, phase: asInstalling.phase }),
    });
  }

  // A18 install 成功后 /skins/list 被刷新（计数断言 + 清单真源）
  {
    let listCalls = 0;
    const orig = listRoute.handler;
    listRoute.handler = (req, res) => { listCalls += 1; return orig(req, res); };
    const before = listCalls;
    const r = await call(installRoute, { method: 'POST', body: { id: REFRESH_ID, url: site + '/media/refresh.zip' } });
    const listed = await listedInstalled(REFRESH_ID);
    const skinsTab = readFileSync(join(ROOT, 'src', 'panel-tabs-skins.js'), 'utf8');
    // 面板：markOk 之后必须紧跟一次 load(true)（"装完不刷新 = 卡片还显示安装"就是 4.23.4 的老毛病）
    // 4.26：刷新改为**后台非阻塞**（void load(true)），判据接受两种写法 ——
  // 关键是"markOk 之后确实刷新了清单"，不是"把界面卡住等它"。
  const refreshAfterOk = /cards\.markOk\(cardId\);[\s\S]{0,1200}?(?:await|void) load\(true\)/.test(skinsTab);
    listRoute.handler = orig;
    A.push({
      id: 'A18', name: 'install 成功后 /skins/list 被刷新（卡片才有"已安装"的真源）',
      ok: r.status === 200 && Boolean(r.json && r.json.ok) && listCalls > before && listed === true && refreshAfterOk,
      detail: JSON.stringify({ status: r.status, listCallsBefore: before, listCallsAfter: listCalls, listed, refreshAfterOk }),
    });
  }

  // A19 catalog id ≠ skin.json id（`skin-` 前缀 / 目录名不同）→ 仍判为已安装
  {
    const installList = [
      { id: 'rainy-night', dirId: 'rainy-night', name: '鲸鱼娘 · 雨夜' },       // 目录名 = skin.json.id
      { id: 'inner-x', dirId: 'rainy-night-2', name: '目录名与 id 不同' },      // 目录名 ≠ id
    ];
    const byPrefix = client.skinInstalledMatch(installList, 'skin-rainy-night'); // 站点 slug 带 skin- 前缀
    const byId = client.skinInstalledMatch(installList, 'inner-x');
    const byDir = client.skinInstalledMatch(installList, 'rainy-night-2');
    const noMatch = client.skinInstalledMatch(installList, 'not-installed-at-all');
    const empty = client.skinInstalledMatch(null, 'rainy-night');
    A.push({
      id: 'A19', name: 'installed 判定归一：目录名 / skin.json.id / catalog id 任一命中即已装',
      ok: byPrefix === true && byId === true && byDir === true && noMatch === false && empty === false,
      detail: JSON.stringify({ byPrefix, byId, byDir, noMatch, empty }),
    });
  }

  // A20 install 4xx/5xx → failed + 原因 + 可重试（不许留在 installing）
  {
    const bad = await call(installRoute, { method: 'POST', body: { id: 'foreign-skin', url: 'https://example.com/x.zip' } });
    const code = (bad.json && bad.json.error) || 'http-' + bad.status;
    const card = st2({ job: null, err: { code } });
    const stillInstalling = st2({ job: { id: 'j', status: 'done' }, done: false, err: { code }, installingSince: Date.now() });
    A.push({
      id: 'A20', name: 'install 400/5xx → failed + 原因 +「重试」（不许留在 installing）',
      ok: bad.status === 400 && code === 'host-not-allowed'
        && card.phase === 'failed' && card.retry === true && card.disabled === false && card.reason.length > 0
        && stillInstalling.phase === 'failed',
      detail: JSON.stringify({ status: bad.status, code, phase: card.phase, reason: card.reason }),
    });
  }
}

/* ══ B. 端到端（真路由 + 真队列 + 真 zip）════════════════════════════════════
 *
 *   E1 点击 → 200 → installed=true → 卡片 done（快包在 8 秒窗口内下完，走同步路径）
 *   E2 点击 → 202 + jobId → 排队/下载 → done → 自动安装 → installed=true（慢包，真等待）
 *   E3 宿主重启：等的那条 job 从列表里消失 → 5 次后 failed 可重试（不许无限转圈）
 *   E4 下载中途失败（站点 500）→ 立刻 failed + 原因 + 可重试
 */
const E = [];
if (clientLive) {
  const st = (o) => clientLive.dlCardState(Object.assign({ id: 'card-e', labels }, o || {}));

  /* E1 快包：点击 → 200 → 落地 */
  {
    const r = await call(installRoute, { method: 'POST', body: { id: FAST_ID, url: site + '/media/fast.zip' } });
    const onDisk = existsSync(join(dshHome, 'skins', FAST_ID, 'skin.json'));
    const listed = await listedInstalled(FAST_ID);
    const card = st({ job: { id: 'fast-job', status: 'done' }, done: listed });
    E.push({
      id: 'E1', name: '点击 → 200 → installed=true → 卡片 done',
      ok: r.status === 200 && Boolean(r.json && r.json.ok) && onDisk && listed && card.phase === 'done',
      detail: JSON.stringify({ status: r.status, onDisk, listed, phase: card.phase }),
    });
  }

  /* E2 慢包：202 + jobId → 排队/下载 → done → 自动安装 → installed */
  {
    const t0 = Date.now();
    const posted = await call(installRoute, { method: 'POST', body: { id: SLOW_ID, url: site + '/media/slow.zip' } });
    const jobId = (posted.json && posted.json.jobId) || '';
    const pending = posted.status === 202 && Boolean(posted.json && posted.json.pending) && Boolean(jobId);
    check('E2a 慢链路下宿主先回 202 + jobId（不是让请求干挂着）', pending, JSON.stringify({ status: posted.status, jobId: jobId || 'missing' }));

    // 立刻取一帧：宿主已把 job 交出来 ⇒ 卡片必须能显示"排队中"/"下载中"（不是空白）
    const snap0 = getDownloadQueue().snapshot().find((j) => j && j.id === jobId) || null;
    const phase0 = snap0 ? st({ job: snap0 }).phase : 'missing';
    check('E2b 拿到 jobId 后卡片立刻有进度（排队/下载中，不是"正在提交…"）',
      ['queued', 'running'].includes(phase0), 'phase=' + phase0);

    // 真等到下载结束（面板在这一步就是"轮询到 done 再补一次安装"）
    const done = await clientLive.dlAwaitJob(jobId, 120000);
    const installing = st({ job: { id: jobId, status: 'done' }, done: false, installingSince: Date.now() });
    check('E2c 下载完成 ⇒ 卡片先进「解压/落位中…」（有上界，不是永久）',
      Boolean(done) && done.status === 'done' && installing.phase === 'installing',
      JSON.stringify({ done: done && done.status, phase: installing.phase }));

    // 自动安装：面板在 job=done 时会再打一次安装（读本地 zip 缓存，不再下载）
    const hitsBefore = slowHits;
    const again = await call(installRoute, { method: 'POST', body: { id: SLOW_ID, url: site + '/media/slow.zip' } });
    const listed = await listedInstalled(SLOW_ID);
    const card = st({ job: { id: jobId, status: 'done' }, done: listed });
    check('E2d 自动安装读的是本地缓存（第二次没有重新下载）', slowHits === hitsBefore, 'slowHits=' + slowHits + ' before=' + hitsBefore);
    check('E2e 落地后 /skins/list 的 installed 里有它（卡片的真源）', listed === true, 'again=' + again.status);
    E.push({
      id: 'E2', name: '202+jobId → 排队/下载 → done → 自动安装 → installed',
      ok: pending && again.status === 200 && listed && card.phase === 'done',
      detail: JSON.stringify({ posted: posted.status, again: again.status, listed, phase: card.phase, took: Date.now() - t0 }),
    });
  }

  /* E3 宿主重启：job 从列表里消失 → failed 可重试 */
  {
    const c = loadClient({ apiJson: async () => ({ ok: true, data: { jobs: [] } }) });   // 队列被清空
    const t0 = Date.now();
    const waited = await c.dlAwaitJob('job-before-restart', 120000);
    const took = Date.now() - t0;
    const s = st({ job: null, err: { code: 'job-lost' } });
    // 兜底核对：列表里也确实没有它 ⇒ 必须给失败，而不是继续转圈
    const listedNow = await listedInstalled('never-installed-skin');
    E.push({
      id: 'E3', name: '宿主重启（job 表清空）→ failed 可重试',
      ok: Boolean(waited) && waited.status === 'lost' && took < 20000 && listedNow === false
        && s.phase === 'failed' && s.retry === true && s.reason.includes('下载任务已丢失'),
      detail: JSON.stringify({ waited: waited && waited.status, took, listedNow, phase: s.phase }),
    });
  }

  /* E4 下载中途失败（站点 500）→ failed + 原因 */
  {
    const r = await call(installRoute, { method: 'POST', body: { id: 'e2e-fail-skin', url: site + '/media/fail.zip' } });
    // 真实失败原因由队列给出（宿主的 502 里也带着它）—— 这里同时看两边，避免"只信一处"。
    const snap = getDownloadQueue().snapshot().find((j) => j && String(j.url || '').endsWith('/media/fail.zip')) || null;
    const errCode = (r.json && r.json.error) || (snap && snap.error) || '';
    const s = st({ job: snap || { id: 'fail-job', status: 'failed', error: errCode } });
    E.push({
      id: 'E4', name: '下载失败（站点 500）→ failed + 原因 + 可重试',
      ok: r.status === 502 && Boolean(snap) && snap.status === 'failed'
        && s.phase === 'failed' && s.retry === true && s.disabled === false && s.reason.length > 0,
      detail: JSON.stringify({ status: r.status, queueStatus: snap && snap.status, errCode, reason: s.reason }),
    });
  }
}

/* ══ C. 文档对账：防复发清单必须和用例一起存在 ═════════════════════════════════ */
{
  const docPath = join(ROOT, 'docs', 'INSTALL-FLOW.md');
  const doc = existsSync(docPath) ? readFileSync(docPath, 'utf8') : '';
  check('C1 存在 docs/INSTALL-FLOW.md（防复发清单）', doc.length > 800, 'len=' + doc.length);
  const ids = A.map((r) => r.id).concat(E.map((r) => r.id));
  const missing = ids.filter((id) => !new RegExp('\\b' + id + '\\b').test(doc));
  check('C2 文档逐条列出 A1–A14 / E1–E4 的判据编号', missing.length === 0, 'missing=' + missing.join(','));
  check('C3 文档写明两条超时口径（落地上界 90 秒 / 查不到 5 次约 7.5 秒）',
    /90000|90\s*秒/.test(doc) && /7\.5\s*秒/.test(doc));
  check('C4 文档写明 DSH_FOLIA_INSTALL_STALL_MS 可覆盖且夹取 5 秒..30 分钟',
    /DSH_FOLIA_INSTALL_STALL_MS/.test(doc) && /5000|5\s*秒/.test(doc) && /30\s*分钟/.test(doc));
}

/* ── 汇总 ───────────────────────────────────────────────────────────────────── */
for (const r of A) check('A ' + r.id + ' · ' + r.name, r.ok, r.detail);
for (const r of E) check('B ' + r.id + ' · ' + r.name, r.ok, r.detail);

let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
try { server.close(); } catch { /* ignore */ }
if (failed) process.exit(1);
