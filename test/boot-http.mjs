/**
 * test/boot-http.mjs — 开机动画路由的**真实 HTTP** 测试。
 *
 * 为什么不用"直接调 handler"那种单测：这次的 bug（`bodyReader` 是流式的、
 * 被当成 Promise 用）在直接调用时**也能通过**——因为我把 req 伪造成了假对象。
 * 只有真起一个 http.Server、用 fetch 发真请求，才能覆盖"请求体怎么进来"这一层。
 *
 * 覆盖：list / download / select / toggle / settings / remove / clip(Range)
 */
import { createServer } from 'node:http';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const HOME = join(tmpdir(), 'folia-boot-test-' + Date.now());
process.env.DSH_FOLIA_HOME = HOME;

const { registerBootRoutes } = await import('../lib/routes/boot.js');
const { readBoot, writeBoot, clipFile, bootDir } = await import('../lib/boot/index.js');

const routes = [];
const fakeWeb = {
  register(spec) { routes.push(spec); return () => {}; },
};
registerBootRoutes(fakeWeb, { disposers: [], base: '/folia', log: () => {} });

/** 把注册表挂到一个真 http.Server 上（只做精确路径匹配）。 */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const spec = routes.find((r) => r.path === url.pathname);
  if (!spec) { res.statusCode = 404; res.end('nf'); return; }
  try { await spec.handler(req, res); }
  catch (e) { if (!res.headersSent) { res.statusCode = 500; res.end(String(e.message)); } }
});

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/folia`;
const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
};

try {
  // ① list：初始状态
  const l1 = await fetch(base + '/boot/list').then((r) => r.json());
  check('list 返回 ok', l1.ok === true, JSON.stringify(l1).slice(0, 120));
  check('list 默认未启用', l1.enabled === false);
  check('list 有候选（站点可达时 ≥1）', Array.isArray(l1.clips), 'clips=' + (l1.clips || []).length);

  check('list 默认进入方式是 tail（播完再进）', l1.enterMode === 'tail', 'enterMode=' + l1.enterMode);

  // ② toggle：真实写请求体
  const t1 = await post('/boot/toggle', { enabled: true });
  check('toggle 接受 JSON 体（不再 bad-id）', t1.status === 200 && t1.json && t1.json.ok === true, JSON.stringify(t1.json));
  check('toggle 落盘为 true', readBoot().enabled === true);

  // ③ select：未安装的 id 应 404 而不是 400
  const s1 = await post('/boot/select', { id: 'not-installed-clip' });
  check('select 未安装 → 404', s1.status === 404 && s1.json && s1.json.error === 'not-installed', JSON.stringify(s1.json));

  // ④ 手工放一个"片段"，再从接口选它
  writeFileSync(clipFile('probe'), Buffer.alloc(2048, 7));
  const s2 = await post('/boot/select', { id: 'probe' });
  check('select 已安装 → 200', s2.status === 200 && s2.json && s2.json.ok === true, JSON.stringify(s2.json));
  check('select 后 clipId=probe 且启用', readBoot().clipId === 'probe' && readBoot().enabled === true);

  // ⑤ clip：整段 + Range
  const whole = await fetch(base + '/boot/clip');
  check('clip 整段 200', whole.status === 200, 'status=' + whole.status);
  check('clip content-type 是 video/mp4', whole.headers.get('content-type') === 'video/mp4');
  check('clip 声明 accept-ranges', (whole.headers.get('accept-ranges') || '') === 'bytes');
  await whole.arrayBuffer();

  const part = await fetch(base + '/boot/clip', { headers: { range: 'bytes=100-199' } });
  check('clip Range → 206', part.status === 206, 'status=' + part.status);
  check('Range 长度 100', part.headers.get('content-length') === '100', 'len=' + part.headers.get('content-length'));
  check('Range content-range 正确', (part.headers.get('content-range') || '').includes('bytes 100-199/'));
  const buf = Buffer.from(await part.arrayBuffer());
  check('Range 实际字节数 100', buf.length === 100, 'got=' + buf.length);

  const bad = await fetch(base + '/boot/clip', { headers: { range: 'bytes=999999-' } });
  check('Range 越界 → 416', bad.status === 416, 'status=' + bad.status);

  // ⑥ settings：三个数值都落盘
  const st = await post('/boot/settings', { fadeMs: 1200, minShowMs: 600, maxHoldMs: 3000 });
  check('settings 接受 JSON 体', st.status === 200 && st.json && st.json.ok === true, JSON.stringify(st.json));
  const b = readBoot();
  check('settings 落盘正确', b.fadeMs === 1200 && b.minShowMs === 600 && b.maxHoldMs === 3000, JSON.stringify(b));

  // ⑥b enterMode：能改、能持久、非法值回落到 tail
  const em = await post('/boot/settings', { enterMode: 'ready' });
  check('settings 接受 enterMode', em.status === 200 && readBoot().enterMode === 'ready', JSON.stringify(readBoot()));
  await post('/boot/settings', { enterMode: 'bogus' });
  check('非法 enterMode 回落 tail', readBoot().enterMode === 'tail', readBoot().enterMode);

  // ⑦ 坏请求体不能 500
  const badBody = await fetch(base + '/boot/select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  check('坏 JSON → 400（不崩）', badBody.status === 400, 'status=' + badBody.status);

  // ⑧ remove：删掉正在用的片段应同时清空选择
  const rm = await post('/boot/remove', { id: 'probe' });
  check('remove 成功', rm.status === 200 && rm.json && rm.json.ok === true);
  check('remove 后 clipId 清空且停用', readBoot().clipId === '' && readBoot().enabled === false);
  const gone = await fetch(base + '/boot/clip');
  check('删掉后 clip → 404', gone.status === 404, 'status=' + gone.status);
  await gone.arrayBuffer();
} finally {
  server.close();
  try { if (existsSync(HOME)) rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n  ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
