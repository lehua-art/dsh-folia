import { Readable } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerSkinRoutes } from '../lib/routes/skins.js';

// 隔离：把 harness 指到临时目录，绝不动真实的 harness/skins
const HARNESS = mkdtempSync(join(tmpdir(), 'folia-harness-'));
process.env.DSH_FOLIA_HARNESS = HARNESS;

const routes = [];
const webServer = { register: (r) => { routes.push(r); return () => {}; } };
registerSkinRoutes(webServer, { disposers: [], base: '/folia', log: () => {} });

function find(path) { return routes.find((r) => r.path === path); }

async function call(path, { method = 'GET', body = null, query = '' } = {}) {
  const h = find(path);
  if (!h) throw new Error('no route ' + path);
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  const req = method === 'POST' ? Readable.from(payload ? [payload] : []) : Readable.from([]);
  req.url = path + query;
  req.method = method;
  req.headers = { 'content-type': 'application/json', 'content-length': payload ? String(payload.length) : '0' };
  const out = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  await h.handler(req, out);
  let json = null;
  try { json = JSON.parse(out.body); } catch { /* 图片等二进制直接忽略 */ }
  return { code: out.statusCode, json, raw: out.body };
}

const t0 = Date.now();
console.log('  临时 harness:', HARNESS);

// ① 索引
const idx = await call('/folia/skins');
console.log(`\n  ① GET /skins        ${Date.now() - t0}ms  code=${idx.code}`);
console.log('     ok=' + idx.json.ok + '  count=' + idx.json.count + '  harnessFound=' + idx.json.harnessFound + '  active=' + idx.json.active);
console.log('     error=' + idx.json.error + '  installedCount=' + idx.json.installedCount);
if (idx.json.skins && idx.json.skins[0]) {
  const s = idx.json.skins[0];
  console.log('     首条: ' + s.id + ' / ' + s.name + ' / ' + Math.round(s.zipBytes / 1024) + 'KB / sha=' + s.sha256);
}

// ② 安装（挑一个小的：black-gold-vip 45 KB）
const target = (idx.json.skins || []).find((s) => s.id === 'black-gold-vip') || (idx.json.skins || [])[0];
console.log('\n  ② POST /skins/install  id=' + target.id);
const ins = await call('/folia/skins/install', { method: 'POST', body: { id: target.id } });
console.log('     code=' + ins.code + '  ' + JSON.stringify(ins.json).slice(0, 200));
const dir = join(HARNESS, 'skins', target.id);
if (existsSync(dir)) {
  const files = readdirSync(dir);
  console.log('     落盘: ' + files.length + ' 项 -> ' + files.slice(0, 6).join(', '));
  console.log('     有 skin.json: ' + existsSync(join(dir, 'skin.json')));
  console.log('     有 skin.css : ' + existsSync(join(dir, 'skin.css')));
} else {
  console.log('     ⚠️ 目录不存在');
}

// ③ 激活
console.log('\n  ③ POST /skins/activate');
const act = await call('/folia/skins/activate', { method: 'POST', body: { id: target.id } });
console.log('     code=' + act.code + '  ' + JSON.stringify(act.json));
const activeFile = join(HARNESS, 'skin-center-active.json');
if (existsSync(activeFile)) console.log('     active.json: ' + readFileSync(activeFile, 'utf8').replace(/\s+/g, ' '));

// ④ 再取索引，看 installed/active 标记
const idx2 = await call('/folia/skins', { query: '?refresh=1' });
const back = (idx2.json.skins || []).find((s) => s.id === target.id);
console.log('\n  ④ 回读标记  installed=' + (back && back.installed) + '  active=' + (back && back.active));

// ⑤ 卸载：在用的应当 409
console.log('\n  ⑤ 卸载在用的（应 409）');
const rm1 = await call('/folia/skins/remove', { method: 'POST', body: { id: target.id } });
console.log('     code=' + rm1.code + '  ' + JSON.stringify(rm1.json));

// ⑥ 坏 id
console.log('\n  ⑥ 非法 id（应 400）');
const bad = await call('/folia/skins/install', { method: 'POST', body: { id: '../../evil' } });
console.log('     code=' + bad.code + '  ' + JSON.stringify(bad.json));

// ⑦ 预览图代理
console.log('\n  ⑦ GET /skins/preview');
const pv = await call('/folia/skins/preview', { query: '?p=' + encodeURIComponent(target.previewLight || 'skins/x/preview/light.jpg') });
console.log('     code=' + pv.code + '  字节=' + (pv.raw ? pv.raw.length : 0) + '  type=' + (pv.code === 200 ? 'image' : '-'));

rmSync(HARNESS, { recursive: true, force: true });
console.log('\n  临时目录已清理');
