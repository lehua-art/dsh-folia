/**
 * site-package-http.mjs — 「站点工程包 → 本机工程目录」的真 HTTP 行为测试。
 *
 * 判据（每条都有正/负两边）：
 *   ① 合法工程包 zip 被解开、`project.json` 可读、返回 `up-dir-…` 的 id 与 type；
 *   ② **幂等**：同 URL 第二次调用不再下载/不再写盘（reused: true）；
 *   ③ 路径穿越条目 ⇒ 整包拒绝，且**磁盘上不残留半成品目录**；
 *   ④ 非 zip ⇒ 422 not-a-zip；缺 project.json ⇒ no-project-json；type=application ⇒ application-package；
 *   ⑤ **SSRF 白名单**：不在 allowHosts 里的 host（例如 127.0.0.1 未登记时）⇒ 400 host-not-allowed；
 *   ⑥ 可执行文件条目被跳过（工程包里不该有 exe）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerSitePackageRoutes } from '../lib/routes/site-package.js';

const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

/* ── 造一个 zip（store / deflate 两种都覆盖）──────────────────────────────── */
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const useDeflate = f.deflate !== false;
    const payload = useDeflate ? deflateRawSync(data) : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, payload);
    central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const PROJECT = JSON.stringify({ type: 'scene', title: '测试工程', file: 'scene.json' });

/* ── 起一个本地站点：/good.zip /notzip.zip /noproject.zip /app.zip /slip.zip /exe.zip ── */
const FIXTURES = {
  '/good.zip': makeZip([
    { name: 'project.json', data: PROJECT },
    { name: 'scene.pkg', data: 'PKGV0001 fake scene payload' },
    { name: 'preview.jpg', data: 'fakejpg', deflate: false },
    { name: 'materials/a.json', data: '{"ok":1}' },
  ]),
  '/notzip.zip': Buffer.from('this is not a zip at all, definitely not'),
  '/noproject.zip': makeZip([{ name: 'scene.pkg', data: 'x' }]),
  '/app.zip': makeZip([{ name: 'project.json', data: JSON.stringify({ type: 'application', file: 'app.exe' }) }]),
  '/slip.zip': makeZip([
    { name: 'project.json', data: PROJECT },
    { name: '../../evil.txt', data: 'pwned' },
  ]),
  '/exe.zip': makeZip([
    { name: 'project.json', data: PROJECT },
    { name: 'tool.exe', data: 'MZ...' },
    { name: 'scene.pkg', data: 'pkg' },
  ]),
};

let served = 0;
const server = createServer((req, res) => {
  const body = FIXTURES[req.url];
  if (!body) { res.statusCode = 404; res.end('nope'); return; }
  served += 1;
  res.setHeader('content-type', 'application/zip');
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const origin = 'http://127.0.0.1:' + port;

/* ── 装路由：上传目录指向临时目录，host 白名单只放 127.0.0.1 ─────────────── */
const uploadDir = mkdtempSync(join(tmpdir(), 'folia-upload-'));
const routes = [];
const deps = {
  disposers: [],
  base: '/folia',
  getUploadDir: () => uploadDir,
  log: () => {},
  siteBase: 'https://folia-5ve.pages.dev',
  allowHosts: ['127.0.0.1:' + port],
};
registerSitePackageRoutes({ register: (spec) => { routes.push(spec); return () => {}; } }, deps);
const route = routes.find((r) => r.path === '/folia/site-package/install');
check('路由已注册 /site-package/install', Boolean(route));

/** 打一次路由（返回 { status, json }）。 */
async function post(body, overrideDeps) {
  const list = [];
  const d = overrideDeps ? { ...deps, ...overrideDeps } : deps;
  registerSitePackageRoutes({ register: (spec) => { list.push(spec); return () => {}; } }, d);
  const h = list.find((r) => r.path === '/folia/site-package/install');
  const resObj = {
    statusCode: 0, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end(s) { this.body = s; },
  };
  const req = {
    method: 'POST',
    on(ev, fn) {
      if (ev === 'data') fn(Buffer.from(JSON.stringify(body)));
      if (ev === 'end') fn();
      return this;
    },
  };
  await h.handler(req, resObj);
  let json = null;
  try { json = JSON.parse(resObj.body); } catch { /* ignore */ }
  return { status: resObj.statusCode, json };
}

/* ① 合法包 */
{
  const r = await post({ url: origin + '/good.zip', name: '测试工程' });
  check('合法工程包 → 200', r.status === 200, 'status=' + r.status + ' ' + JSON.stringify(r.json && r.json.error));
  check('返回 type=scene', r.json && r.json.type === 'scene', 'type=' + (r.json && r.json.type));
  check('返回 up-dir- 前缀的 id', r.json && /^up-dir-/.test(r.json.id), 'id=' + (r.json && r.json.id));
  const dir = join(uploadDir, 'up-dir-' + String(r.json.id).replace(/^up-dir-/, ''));
  check('目录已落盘', existsSync(dir), dir);
  check('project.json 可读且 type=scene', (() => {
    try { return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).type === 'scene'; } catch { return false; }
  })());
  check('scene.pkg 已写出', existsSync(join(dir, 'scene.pkg')));
  check('嵌套子目录也被写出', existsSync(join(dir, 'materials', 'a.json')));
  check('store 模式条目（preview.jpg）也写出', existsSync(join(dir, 'preview.jpg')));

  /* ② 幂等 */
  const before = served;
  const again = await post({ url: origin + '/good.zip', name: '测试工程' });
  check('第二次调用 reused=true', again.json && again.json.reused === true, JSON.stringify(again.json));
  check('第二次没有重新下载', served === before, 'served=' + served + ' before=' + before);
}

/* ③ 路径穿越 */
{
  const r = await post({ url: origin + '/slip.zip' });
  check('含路径穿越条目 ⇒ 422', r.status === 422, 'status=' + r.status + ' ' + JSON.stringify(r.json));
  check('穿越包没有落盘', !existsSync(join(uploadDir, '..', 'evil.txt')));
  const leftover = readdirSync(uploadDir).filter((n) => n.includes('slip'));
  check('穿越包没有残留半成品目录', leftover.length === 0, leftover.join(','));
}

/* ④ 非 zip / 缺 project.json / application 包 */
{
  const r1 = await post({ url: origin + '/notzip.zip' });
  check('非 zip ⇒ 422 not-a-zip', r1.status === 422 && r1.json && r1.json.error === 'not-a-zip', JSON.stringify(r1.json));
  const r2 = await post({ url: origin + '/noproject.zip' });
  check('缺 project.json ⇒ 422 no-project-json', r2.status === 422 && r2.json && r2.json.error === 'no-project-json', JSON.stringify(r2.json));
  const r3 = await post({ url: origin + '/app.zip' });
  check('application 包 ⇒ 422 application-package', r3.status === 422 && r3.json && r3.json.error === 'application-package', JSON.stringify(r3.json));
}

/* ⑤ SSRF 白名单 */
{
  const r = await post({ url: 'https://example.com/x.zip' });
  check('白名单外的 host ⇒ 400 host-not-allowed', r.status === 400 && r.json && r.json.error === 'host-not-allowed', JSON.stringify(r.json));
  const r2 = await post({ url: 'file:///C:/windows/win.ini' });
  check('file:// 协议 ⇒ 400', r2.status === 400, 'status=' + r2.status);
}

/* ⑥ 可执行条目被跳过 */
{
  const r = await post({ url: origin + '/exe.zip' });
  check('带 exe 的包仍能装（跳过 exe）', r.status === 200, 'status=' + r.status + ' ' + JSON.stringify(r.json));
  check('exe 未落盘', r.json && r.json.skipped >= 1, 'skipped=' + (r.json && r.json.skipped));
  const dir = join(uploadDir, 'up-dir-' + String(r.json.id).replace(/^up-dir-/, ''));
  check('scene.pkg 仍在（只跳 exe，不跳过工程文件）', existsSync(join(dir, 'scene.pkg')));
}

server.close();
try { rmSync(uploadDir, { recursive: true, force: true }); } catch { /* ignore */ }

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const x of results) {
  if (x.ok) process.stdout.write('  ✓ ' + x.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + x.name + (x.detail ? ' — ' + x.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
