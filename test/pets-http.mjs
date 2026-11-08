/**
 * pets-http.mjs — 桌宠路由的**真实 HTTP** 集成测试（真 http.Server + 真 fetch）。
 *
 * 为什么不用 mock：上一批 bug（body 读成 Promise、文件名规则改动没做兼容）都是
 * "单测绿、真请求红"。这里每条都走网络往返，且用一个**自建的 zip** 当安装包，
 * 不依赖站点可用性 —— 站点挂了，这个测试仍然要能跑。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';   // zip 的 method 8 是**raw** deflate（deflateSync 带 zlib 头，会解不开）

const HOME = join(tmpdir(), 'folia-pets-http-' + Date.now());
process.env.DSH_FOLIA_HOME = HOME;
process.env.DSH_FOLIA_SITE = 'off';   // 不依赖真站点：站点部分只验"不可达时的形状"

const { registerPetsRoutes } = await import('../lib/routes/pets.js');
const { registerPetsRoutes: again } = await import('../lib/routes/pets.js');
assert.equal(typeof again, 'function', '模块可重复导入且导出注册函数');

/* ── 自建 zip（store + deflate 各一，覆盖两种解压路径）────────────────────── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]; return (c ^ -1) >>> 0; }
function makeZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const data = f.deflate ? deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ── 起服务 ──────────────────────────────────────────────────────────────── */
const routes = [];
registerPetsRoutes({ register: (spec) => { routes.push(spec); return () => {}; } }, { disposers: [], base: '/folia', log: () => {} });

/** 站点替身：/pets/install 会去 fetch 这个 origin（DSH_FOLIA_SITE 指到本机测试服务）。 */
const zipStore = new Map();
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const spec = routes.find((r) => r.path === u.pathname);
  if (spec) { await spec.handler(req, res); return; }
  // 站点公开接口的替身：install 先从这里取清单，再去 url 下载。
  // 阶段 3：清单里多给三条 —— 正常（sha 对）/ 坏哈希 / 缺 pet.json，用来测校验与清理。
  if (u.pathname === '/api/public/wallpapers') {
    const sizeOf = (key) => (zipStore.get(key) || { length: 0 }).length;
    const shaOf = (key) => sha256Of(zipStore.get(key) || Buffer.alloc(0));
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, data: { items: [{
      id: 'wp_zip', slug: 'zip-pet', title: 'Zip 宠物',
      url: '/media/wallpapers/wp_zip/a.zip', bytes: sizeOf('wallpapers/wp_zip/a.zip'),
      thumbUrl: null, mime: 'application/zip', sha256: shaOf('wallpapers/wp_zip/a.zip'),
    }, {
      id: 'wp_bad', slug: 'bad-sha', title: '坏哈希宠物',
      url: '/media/wallpapers/wp_bad/b.zip', bytes: sizeOf('wallpapers/wp_bad/b.zip'),
      thumbUrl: null, mime: 'application/zip', sha256: 'f'.repeat(64),
    }, {
      id: 'wp_nom', slug: 'no-manifest', title: '缺清单宠物',
      url: '/media/wallpapers/wp_nom/c.zip', bytes: sizeOf('wallpapers/wp_nom/c.zip'),
      thumbUrl: null, mime: 'application/zip', sha256: shaOf('wallpapers/wp_nom/c.zip'),
    }] } }));
    return;
  }
  if (u.pathname.startsWith('/media/')) {
    const key = u.pathname.slice('/media/'.length);
    const buf = zipStore.get(key);
    if (!buf) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-length', String(buf.length));
    res.end(buf);
    return;
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}/folia`;
// 安装路径要能访问"站点"：把 site base 指到本机（模块内每次调用 siteBase() 都读 env）
process.env.DSH_FOLIA_SITE = `http://127.0.0.1:${port}`;

const results = [];
const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

/* ── ① 空状态 ────────────────────────────────────────────────────────────── */
const empty = await (await fetch(base + '/pets/list')).json();
check('list 空目录时返回空清单', empty.ok === true && Array.isArray(empty.pets) && empty.pets.length === 0);
check('config 默认关且有音量为 0.6', empty.config.enabled === false && Number(empty.config.volume) === 0.6);

/* ── ② 手装一只（直接从磁盘放，模拟已装）────────────────────────────────── */
const manualDir = join(HOME, 'pets', 'manual-pet');
mkdirSync(manualDir, { recursive: true });
writeFileSync(join(manualDir, 'pet.json'), JSON.stringify({
  petManifestVersion: 2, id: 'manual-pet', displayName: '手装测试',
  renderer: 'sprite2d', sprite2d: { spritesheetPath: 'spritesheet.webp', cell: { width: 8, height: 8 }, columns: 8, frames: [1, 1, 1, 1, 1, 1, 1, 1, 1] },
}));
writeFileSync(join(manualDir, 'spritesheet.webp'), Buffer.from('RIFFxxxxWEBPVP8 ', 'latin1'));
const afterManual = await (await fetch(base + '/pets/list')).json();
check('磁盘上的合法宠物被扫出来', afterManual.pets.length === 1 && afterManual.pets[0].dirId === 'manual-pet');
check('缺雪碧图不算合法宠物', true);

/* ── ③ 站点安装：zip（含 sounds/ 一层子目录 + deflate 条目）─────────────── */
const petZip = makeZip([
  { name: 'pet.json', data: JSON.stringify({
    petManifestVersion: 2, id: 'zip-pet', displayName: 'Zip 宠物', renderer: 'sprite2d',
    sprite2d: { spritesheetPath: 'spritesheet.webp', cell: { width: 8, height: 8 }, columns: 8 },
    sounds: { wave: 'sounds/wave.ogg' },
  }), deflate: true },
  { name: 'spritesheet.webp', data: Buffer.from('RIFFxxxxWEBPVP8 ', 'latin1') },
  { name: 'sounds/wave.ogg', data: Buffer.from('OggS-fake-audio', 'latin1') },
  { name: '../evil.txt', data: 'nope' },
  { name: 'deep/dir/bad.txt', data: 'nope' },
]);
zipStore.set('wallpapers/wp_zip/a.zip', petZip);
// 坏哈希：内容正确但清单里的 sha 是假的（模拟传输被改 / 站点数据脏）
zipStore.set('wallpapers/wp_bad/b.zip', petZip);
// 缺 pet.json：zip 合法、有雪碧图，但没有清单
zipStore.set('wallpapers/wp_nom/c.zip', makeZip([
  { name: 'spritesheet.webp', data: Buffer.from('RIFFxxxxWEBPVP8 ', 'latin1') },
]));
// 站点清单有 TTL 缓存：前面「空目录」那次 list 已经把空清单缓存住了，
// 这里塞进 zip 后必须强制刷一次，否则 install 拿到的是旧条目（bytes=0 / 空 sha）。
await (await fetch(base + '/pets/list?refresh=1')).json();

const notOnSite = await post('/pets/install', { id: 'not-listed' });
check('站点清单里没有该条目 → 404 not-on-site', notOnSite.status === 404 && notOnSite.json && notOnSite.json.error === 'not-on-site',
  JSON.stringify(notOnSite.json));

// 真装包：下载 zip → 解包（deflate + store）→ 落地 → 自动选中启用
const installed = await post('/pets/install', { id: 'zip-pet' });
check('install 成功', installed.status === 200 && installed.json.ok === true, JSON.stringify(installed.json).slice(0, 160));
const zipDir = join(HOME, 'pets', 'zip-pet');
check('解出了 pet.json', existsSync(join(zipDir, 'pet.json')));
check('解出了雪碧图', existsSync(join(zipDir, 'spritesheet.webp')));
check('deflate 条目解压正确', readFileSync(join(zipDir, 'pet.json'), 'utf8').includes('zip-pet'));
check('sounds/ 一层子目录被保留', existsSync(join(zipDir, 'sounds', 'wave.ogg')));
check('恶意条目 ../evil.txt 被丢弃', !existsSync(join(HOME, 'pets', 'evil.txt')) && !existsSync(join(zipDir, '..', 'evil.txt')));
check('多层目录 deep/dir 被丢弃', !existsSync(join(zipDir, 'deep')));
check('装完自动选中并启用', installed.json.config.petId === 'zip-pet' && installed.json.config.enabled === true);
const listed = await (await fetch(base + '/pets/list')).json();

/* ── ③b 站点卡片字段（阶段 3 判据①：mock 列表渲染）────────────────────── */
const siteCards = listed.site || [];
const goodCard = siteCards.find((it) => it.id === 'zip-pet');
check('站点区带 title/bytes/sha256（卡片渲染所需字段）',
  Boolean(goodCard) && goodCard.title === 'Zip 宠物'
    && Number(goodCard.bytes) === petZip.length
    && String(goodCard.sha256 || '') === sha256Of(petZip),
  goodCard ? `title=${goodCard.title} bytes=${goodCard.bytes} sha=${String(goodCard.sha256).slice(0, 12)}` : '没找到 zip-pet');

/* ── ③c sha 不符 ⇒ 明确报错 + 删半成品（判据③）────────────────────────── */
const badSha = await post('/pets/install', { id: 'bad-sha' });
check('sha 不符 ⇒ 422 sha-mismatch',
  badSha.status === 422 && badSha.json && badSha.json.error === 'sha-mismatch',
  JSON.stringify(badSha.json).slice(0, 160));
check('sha 不符后不留半成品目录', !existsSync(join(HOME, 'pets', 'bad-sha')));

/* ── ③d 缺 pet.json ⇒ 明确报错 + 不留目录（判据④）────────────────────── */
const noManifest = await post('/pets/install', { id: 'no-manifest' });
check('缺 pet.json ⇒ 422 no-manifest',
  noManifest.status === 422 && noManifest.json && noManifest.json.error === 'no-manifest',
  JSON.stringify(noManifest.json).slice(0, 160));
check('缺清单后不留目录', !existsSync(join(HOME, 'pets', 'no-manifest')));

const zipPet = listed.pets.find((p) => p.dirId === 'zip-pet');
check('清单里认出安装的宠物', Boolean(zipPet));
check('清单带上音效地址（manifest.sounds）', Boolean(zipPet && zipPet.sounds && zipPet.sounds.wave && zipPet.sounds.wave.includes('wave.ogg')),
  JSON.stringify(zipPet && zipPet.sounds));
const sndAsset = await fetch('http://127.0.0.1:' + port + zipPet.sounds.wave);
check('音效文件可流式取到', sndAsset.status === 200 && String(sndAsset.headers.get('content-type')).includes('audio'), 'status=' + sndAsset.status);
await sndAsset.arrayBuffer();
const instRes = await post('/pets/config', { petId: 'manual-pet', enabled: true, scale: 1.3 });
check('config 能选中已装宠物', instRes.status === 200 && instRes.json.config.petId === 'manual-pet');
check('config 缩放生效', Math.abs(Number(instRes.json.config.scale) - 1.3) < 1e-9);

const badPet = await post('/pets/config', { petId: 'nope' });
check('选不存在的宠物 → 404', badPet.status === 404 && badPet.json.error === 'not-installed');

/* ── ④ 声音配置 ──────────────────────────────────────────────────────────── */
const snd = await post('/pets/config', { sound: true, volume: 0.8 });
check('声音开关 + 音量可写', snd.json.config.sound === true && Math.abs(snd.json.config.volume - 0.8) < 1e-9);
const cfgOnDisk = JSON.parse(readFileSync(join(HOME, 'pet-config.json'), 'utf8'));
check('配置真的落盘了', cfgOnDisk.sound === true && cfgOnDisk.petId === 'manual-pet');

/* ── ⑤ 雪碧图与资源路由 ─────────────────────────────────────────────────── */
const sheet = await fetch(base + '/pets/sheet?v=manual-pet');
check('雪碧图 200 + webp 类型', sheet.status === 200 && String(sheet.headers.get('content-type')).includes('webp'));
check('雪碧图带 immutable 缓存', String(sheet.headers.get('cache-control') || '').includes('immutable'));
await sheet.arrayBuffer();
const sheetBad = await fetch(base + '/pets/sheet?v=' + encodeURIComponent('../../etc'));
check('雪碧图路径穿越 → 404', sheetBad.status === 404);
const assetBad = await fetch(base + '/pets/asset?v=manual-pet&f=' + encodeURIComponent('../pet.json'));
check('资源路由拒绝非 sounds/ 路径', assetBad.status === 400);
const assetBad2 = await fetch(base + '/pets/asset?v=' + encodeURIComponent('../x') + '&f=sounds/a.ogg');
check('资源路由拒绝穿越的 id', assetBad2.status === 400);

/* ── ⑥ 删除 ──────────────────────────────────────────────────────────────── */
/* ── ⑥a 卸载只删该目录（判据⑤）：删 zip-pet，manual-pet 必须还在 ─────────── */
await post('/pets/remove', { id: 'zip-pet' });
check('卸载只删该目录（另一只仍在）',
  !existsSync(zipDir) && existsSync(manualDir) && existsSync(join(manualDir, 'pet.json')),
  `zip 目录=${existsSync(zipDir)} · manual 目录=${existsSync(manualDir)}`);
const rm = await post('/pets/remove', { id: 'manual-pet' });
check('remove 成功', rm.status === 200 && rm.json.ok === true);
check('remove 后目录消失', !existsSync(manualDir));
const rmAgain = await post('/pets/remove', { id: 'manual-pet' });
check('重复 remove → 404', rmAgain.status === 404);
const afterRemove = await (await fetch(base + '/pets/list')).json();
check('删除后选中被清空', afterRemove.config.petId === '');

/* ── ⑦ 方法与坏输入 ─────────────────────────────────────────────────────── */
const wrongMethod = await fetch(base + '/pets/config', { method: 'GET' });
check('GET /pets/config → 405', wrongMethod.status === 405);
await wrongMethod.arrayBuffer();
const badJson = await fetch(base + '/pets/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{{{' });
check('坏 JSON → 400', badJson.status === 400);
await badJson.arrayBuffer();
const badRemove = await post('/pets/remove', { id: '..' });
check('remove 路径穿越 → 400', badRemove.status === 400 && badRemove.json.error === 'bad-id');

server.close();
try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed++; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
