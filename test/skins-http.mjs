/**
 * skins-http.mjs — 「助手皮肤」宿主路由的真 HTTP 行为测试。
 *
 * 判据（每条都有正/负两边）：
 *   ① 列站点皮肤：mock 站点返回 2 条 ⇒ 全部出现，且已装的那条标 installed=true；
 *   ② 安装：真 zip（store/deflate 混合）→ 落到 `$DSH_HOME/skins/<id>/`，skin.json 可读；
 *      **目录名以 skin.json 的 id 为准**（URL 里给的名字不作数）；
 *   ③ 幂等：第二次安装 exists=true，且不再发第二次下载请求；
 *   ④ 安全：路径穿越条目 ⇒ 422 且**不残留**半成品目录；非 zip ⇒ 422 not-a-zip；
 *      缺 skin.json ⇒ 422 no-skin-json；host 不在白名单 ⇒ 400；
 *   ⑤ 卸载：只删皮肤根下那个目录；`..` 之类的 id ⇒ 400 unsafe/bad-id；不存在 ⇒ 404；
 *      可执行后缀不落盘（skipped ≥ 1）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerSkinsRoutes } from '../lib/routes/skins.js';
import { getDownloadQueue } from '../lib/routes/downloads.js';

const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ── zip 构造（store / deflate 都要覆盖）────────────────────────────────── */
/**
 * 表驱动 CRC32：⑦ 的用例要打一个 **16.6 MB** 的真包（用户在站点上遇到的量级），
 * 逐位版本在 1700 万字节上要跑十几秒；改成查表后同样的结果、几十毫秒。
 */
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
function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
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

const SKIN_MANIFEST = JSON.stringify({ id: 'demo-skin', name: '演示皮肤', version: '0.1.0', contributes: { stylesheet: 'skin.css' } });
const FIXTURES = {
  '/demo.zip': makeZip([
    { name: 'skin.json', data: SKIN_MANIFEST },
    { name: 'skin.css', data: '[data-dsh-skin="demo-skin"]{--x:1}' },
    { name: 'assets/bg.webp', data: 'fake-webp', deflate: false },
    { name: 'preview/light.jpg', data: 'fake-jpg' },
    { name: 'tool.exe', data: 'MZ' },
  ]),
  '/slip.zip': makeZip([
    { name: 'skin.json', data: SKIN_MANIFEST },
    { name: '../../evil.txt', data: 'pwned' },
  ]),
  '/noskin.zip': makeZip([{ name: 'skin.css', data: 'x' }]),
  '/notzip.zip': Buffer.from('definitely not a zip'),
};

/** 假站点：/api/public/wallpapers 返回两条（其中 demo-skin 已被本机装过） */
let downloadHits = 0;
// ⑦ 用：16.6 MB 的真包（模拟「鲸鱼娘·雨夜」那个量级），前 9.5 秒一个字节都不发
// ⇒ 安装请求在宿主 8 秒窗口内拿不到 done，必然走 202 pending 那条路。
let bigZip = null;
let bigHits = 0;
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/public/wallpapers')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      data: {
        items: [
          { slug: 'demo-skin', title: '演示皮肤', bytes: 1234, mime: 'application/zip', url: '/media/demo.zip', thumbUrl: '/media/t.jpg', tags: '["皮肤"]' },
          { slug: 'other-skin', title: '另一款', bytes: 2345, mime: 'application/zip', url: '/media/other.zip', thumbUrl: '/media/t2.jpg', tags: '["皮肤","动态"]' },
        ],
      },
    }));
    return;
  }
  if (req.url === '/big.zip' && bigZip) {
    bigHits += 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-length', String(bigZip.length));
    // 先把**响应头**真的发出去（真站点就是这样：头先到、体慢到）——
    // 队列据此拿到总量，卡片才能显示 a/b MB 的分母。
    try { res.flushHeaders(); } catch { /* 老实现没有这个方法也不致命 */ }
    // 再"卡" 9.5 秒不发送 body：宿主侧 8 秒窗口结束时 job 还在 running，
    // 这正是用户看到的"点了半天什么都没有"那段时间（现在有 jobId + 进度可看）。
    setTimeout(() => { try { res.end(bigZip); } catch { /* 客户端可能已断开 */ } }, 9500);
    return;
  }
  const body = FIXTURES[req.url];
  if (!body) { res.statusCode = 404; res.end('nope'); return; }
  downloadHits += 1;
  res.setHeader('content-type', 'application/zip');
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const site = 'http://127.0.0.1:' + port;

/* ── 环境：$DSH_HOME 指到临时目录；站点基址指到假站点 ────────────────────── */
const dshHome = mkdtempSync(join(tmpdir(), 'folia-skins-'));
process.env.DSH_HOME = dshHome;
process.env.DSH_FOLIA_SITE = site;
// 预置一个"已安装"的皮肤（验证 installed 标记与幂等）
mkdirSync(join(dshHome, 'skins', 'demo-skin'), { recursive: true });
writeFileSync(join(dshHome, 'skins', 'demo-skin', 'skin.json'), SKIN_MANIFEST, 'utf8');
writeFileSync(join(dshHome, 'skins', 'demo-skin', 'skin.css'), 'x', 'utf8');

const routes = [];
const deps = { disposers: [], base: '/folia', log: () => {} };
registerSkinsRoutes({ register: (spec) => { routes.push(spec); return () => {}; } }, deps);
const find = (p) => routes.find((r) => r.path === p);
// 五条路由：list / install / remove + activate / active。
// 后两条是**写入兜底**：浏览器直连皮肤中心的 /api/skin-center/v2/active 可能拿不到会话或打错源，
// 于是宿主代理会转发凭据；若 HTTP 仍不可用，就直接写它自己的持久层（skin-center-active.json）。
check('五条路由都注册了（list / install / remove / activate / active）',
  ['/folia/skins/list', '/folia/skins/install', '/folia/skins/remove',
    '/folia/skins/activate', '/folia/skins/active'].every(find),
  routes.map((r) => r.path).join(','));

function call(route, { method = 'GET', body = null, url = null, host = null } = {}) {
  return new Promise((resolve) => {
    const resObj = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(s) { this.body = s; resolve({ status: this.statusCode, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }); },
    };
    const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      method, url: url || route.path,
      headers: host ? { host } : {},
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

/* ① 列表 */
{
  const r = await call(find('/folia/skins/list'), { url: '/folia/skins/list?refresh=1' });
  check('列表 200', r.status === 200, 'status=' + r.status);
  const siteItems = (r.json && r.json.site) || [];
  check('站点两条都出现', siteItems.length === 2, 'n=' + siteItems.length);
  const demo = siteItems.find((x) => x.id === 'demo-skin');
  check('已装的标 installed=true', Boolean(demo && demo.installed === true), JSON.stringify(demo && demo.installed));
  const other = siteItems.find((x) => x.id === 'other-skin');
  check('没装的 installed=false', Boolean(other && other.installed === false));
  check('本机已装清单含 demo-skin', ((r.json && r.json.installed) || []).some((x) => x.id === 'demo-skin'));
  // 皮肤中心在线探测：本用例里请求没有真实 Host（假站点不是 DSH 服务器），所以只断言"四态之一"，
  // 不假装知道答案 —— 判据的价值是"这个字段一定存在且取值受控"，而不是在这里伪造一个 200。
  // 四态：present（真拿到 catalog JSON）/ absent（路由不存在）/ auth-gated（鉴权挡在路由前，
  // 无法判定 —— 这个态是实测补上的：把 401 当成 present 会让界面"看起来能用、点应用必然失败"）。
  check('响应里带 skinCenter 四态',
    ['present', 'absent', 'auth-gated', 'unknown'].includes(r.json.skinCenter), 'skinCenter=' + r.json.skinCenter);
  check('皮肤中心不在跑时给出钉住版本的提示（随 package.json 的精确版本走）',
    r.json.skinCenter === 'present' || r.json.skinCenterHint === 'skin-center-0.4.12',
    'hint=' + r.json.skinCenterHint);
  // 「用户在插件市场里手动禁用」是比 401 更准确的原因，列表必须把它带出来（字段受控即可，
  // 这里没有真实市场状态文件，所以只断言类型）。
  check('带出 skinCenterDisabled（布尔）与 skinCenterMarketKnown（布尔）',
    typeof r.json.skinCenterDisabled === 'boolean' && typeof r.json.skinCenterMarketKnown === 'boolean',
    JSON.stringify({ d: r.json.skinCenterDisabled, k: r.json.skinCenterMarketKnown }));
}

/* ② 安装（幂等分支：demo-skin 已存在 ⇒ 不该下载） */
{
  const before = downloadHits;
  const r = await call(find('/folia/skins/install'), { method: 'POST', body: { id: 'demo-skin', url: site + '/demo.zip' } });
  check('已装的再装 ⇒ exists=true', r.status === 200 && r.json && r.json.exists === true, JSON.stringify(r.json));
  check('已装的再装 ⇒ 没有重新下载', downloadHits === before, 'hits=' + downloadHits);
}

/* ③ 全新安装：另一个 id（改 manifest 后打包） */
{
  const NEW = JSON.stringify({ id: 'fresh-skin', name: '全新皮肤', version: '0.1.0', contributes: { stylesheet: 'skin.css' } });
  FIXTURES['/fresh.zip'] = makeZip([
    { name: 'skin.json', data: NEW },
    { name: 'skin.css', data: 'a{}' },
    { name: 'assets/a.webp', data: 'w', deflate: false },
  ]);
  const r = await call(find('/folia/skins/install'), { method: 'POST', body: { id: 'whatever-url-says', url: site + '/fresh.zip' } });
  check('安装成功 200', r.status === 200 && r.json && r.json.ok === true, JSON.stringify(r.json));
  check('目录名以 skin.json 的 id 为准', r.json && r.json.id === 'fresh-skin', 'id=' + (r.json && r.json.id));
  const dir = join(dshHome, 'skins', 'fresh-skin');
  check('skin.json 落盘可读', existsSync(join(dir, 'skin.json')) && JSON.parse(readFileSync(join(dir, 'skin.json'), 'utf8')).id === 'fresh-skin');
  check('子目录里的 asset 也写出', existsSync(join(dir, 'assets', 'a.webp')));
  // 注意：假站点的目录里只有 demo-skin / other-skin，fresh-skin 不在站点清单里。
  // 所以这条要断的是**本机已装清单**里出现了它（site[].installed 只对站点条目有意义）。
  {
    const ls = await call(find('/folia/skins/list'), { url: '/folia/skins/list?refresh=1' });
    check('本机已装清单里出现 fresh-skin', (ls.json.installed || []).some((x) => x.id === 'fresh-skin'), JSON.stringify((ls.json.installed || []).map((x) => x.id)));
  }
}

/* ④ 安全边界 */
{
  const slip = await call(find('/folia/skins/install'), { method: 'POST', body: { id: 'x', url: site + '/slip.zip' } });
  check('路径穿越 ⇒ 422', slip.status === 422 && slip.json.error === 'unsafe-entry', JSON.stringify(slip.json));
  check('穿越没有写出皮肤根之外', !existsSync(join(dshHome, 'evil.txt')) && !existsSync(join(dshHome, 'skins', '..', 'evil.txt')));
  const junk = readdirSync(join(dshHome, 'skins')).filter((n) => n.includes('x') && n !== 'demo-skin' && n !== 'fresh-skin');
  check('穿越没有残留半成品目录', junk.length === 0, junk.join(','));

  const notZip = await call(find('/folia/skins/install'), { method: 'POST', body: { id: 'y', url: site + '/notzip.zip' } });
  check('非 zip ⇒ 422 not-a-zip', notZip.status === 422 && notZip.json.error === 'not-a-zip', JSON.stringify(notZip.json));

  const noSkin = await call(find('/folia/skins/install'), { method: 'POST', body: { id: 'z', url: site + '/noskin.zip' } });
  check('缺 skin.json ⇒ 422 no-skin-json', noSkin.status === 422 && noSkin.json.error === 'no-skin-json', JSON.stringify(noSkin.json));

  const badHost = await call(find('/folia/skins/install'), { method: 'POST', body: { id: 'w', url: 'https://example.com/x.zip' } });
  check('白名单外 host ⇒ 400', badHost.status === 400 && badHost.json.error === 'host-not-allowed', JSON.stringify(badHost.json));
}

/* ⑤ 可执行后缀 + 卸载 */
{
  const r = await call(find('/folia/skins/install'), { method: 'POST', body: { id: 'demo-skin2', url: site + '/demo.zip' } });
  // demo.zip 的 manifest id 是 demo-skin（已存在）⇒ 走 exists；这里换 id 再装一次验证 exe 跳过
  FIXTURES['/with-exe.zip'] = makeZip([
    { name: 'skin.json', data: JSON.stringify({ id: 'exe-skin', name: '带 exe', contributes: { stylesheet: 'skin.css' } }) },
    { name: 'skin.css', data: 'b{}' },
    { name: 'payload.exe', data: 'MZ' },
  ]);
  const r2 = await call(find('/folia/skins/install'), { method: 'POST', body: { id: 'exe-skin', url: site + '/with-exe.zip' } });
  check('带 exe 的皮肤仍能装', r2.status === 200 && r2.json.ok === true, JSON.stringify(r2.json));
  check('exe 未落盘', r2.json && r2.json.skipped >= 1 && !existsSync(join(dshHome, 'skins', 'exe-skin', 'payload.exe')), JSON.stringify(r2.json && r2.json.skipped));

  const bad = await call(find('/folia/skins/remove'), { method: 'POST', body: { id: '../..' } });
  check('非法 id ⇒ 400', bad.status === 400, 'status=' + bad.status);
  const missing = await call(find('/folia/skins/remove'), { method: 'POST', body: { id: 'no-such-skin' } });
  check('不存在 ⇒ 404', missing.status === 404, 'status=' + missing.status);
  const okDel = await call(find('/folia/skins/remove'), { method: 'POST', body: { id: 'fresh-skin' } });
  check('卸载成功 200', okDel.status === 200 && okDel.json.ok === true, JSON.stringify(okDel.json));
  check('目录确实删了', !existsSync(join(dshHome, 'skins', 'fresh-skin')));
  const other = await call(find('/folia/skins/remove'), { method: 'POST', body: { id: 'demo-skin' } });
  check('已装的还能删', other.status === 200);
}

/* ⑥ 切换皮肤：HTTP 走不通时的**落盘兜底**（这是用户实测 401/404 之后加的最后一道） */
{
  // 把 demo-skin 装回来（activate 会校验目录真实存在）
  mkdirSync(join(dshHome, 'skins', 'demo-skin'), { recursive: true });
  writeFileSync(join(dshHome, 'skins', 'demo-skin', 'skin.json'), SKIN_MANIFEST, 'utf8');
  const statePath = join(dshHome, 'skin-center-active.json');
  // 预置一份带 background 的状态，验证"只改 active、其它字段原样保留"
  writeFileSync(statePath, JSON.stringify({ active: null, initialized: true, background: { enabled: true, inputCardBlur: 10 } }, null, 2), 'utf8');

  // host 指向一个必然连不上的地址 ⇒ 代理失败 ⇒ 落到写文件
  const dead = '127.0.0.1:1';
  const r = await call(find('/folia/skins/activate'), { method: 'POST', body: { id: 'demo-skin' }, host: dead });
  check('代理不可用 ⇒ 仍返回 200（落盘兜底）', r.status === 200 && r.json.ok === true, JSON.stringify(r.json));
  check('返回 via=state-file', r.json && r.json.via === 'state-file', String(r.json && r.json.via));
  let doc = {};
  try { doc = JSON.parse(readFileSync(statePath, 'utf8')); } catch { doc = {}; }
  check('状态文件里 active 已写成 demo-skin', doc.active === 'demo-skin', JSON.stringify(doc.active));
  check('background 字段原样保留', Boolean(doc.background && doc.background.inputCardBlur === 10), JSON.stringify(doc.background));

  // 读：HTTP 不可用时读同一个文件
  const cur = await call(find('/folia/skins/active'), { host: dead });
  check('读当前皮肤 ⇒ 200 via=state-file', cur.status === 200 && cur.json.via === 'state-file', JSON.stringify(cur.json));
  check('读到 demo-skin', cur.json && cur.json.active === 'demo-skin', String(cur.json && cur.json.active));

  // 清空（恢复默认）同样落盘
  const clear = await call(find('/folia/skins/activate'), { method: 'POST', body: { id: '' }, host: dead });
  doc = {};
  try { doc = JSON.parse(readFileSync(statePath, 'utf8')); } catch { doc = {}; }
  check('清空 ⇒ 200 且文件里 active 变 null', clear.status === 200 && doc.active === null, JSON.stringify(doc.active));

  // 未安装的 id：拒绝，且**不写文件**
  writeFileSync(statePath, JSON.stringify({ active: null, initialized: true }, null, 2), 'utf8');
  const ghost = await call(find('/folia/skins/activate'), { method: 'POST', body: { id: 'no-such-skin' }, host: dead });
  check('未安装 ⇒ 404 not-installed', ghost.status === 404 && ghost.json.error === 'not-installed', JSON.stringify(ghost.json));
  doc = JSON.parse(readFileSync(statePath, 'utf8'));
  check('被拒时没有动状态文件', doc.active === null, String(doc.active));

  // 非法 id 与错误方法
  const badId = await call(find('/folia/skins/activate'), { method: 'POST', body: { id: '../x' }, host: dead });
  check('非法 id ⇒ 400 bad-id', badId.status === 400 && badId.json.error === 'bad-id', JSON.stringify(badId.json));
  const wrongMethod = await call(find('/folia/skins/activate'), { host: dead });
  check('activate 只收 POST ⇒ 405', wrongMethod.status === 405, 'status=' + wrongMethod.status);
}

/* ⑦ 4.23.4：**16.6 MB 皮肤包的 202 pending 全链路**（用户报的「鲸鱼娘·雨夜 点了没反应」）。
   站点侧真打一个 16.6 MB 的 zip，且前 9.5 秒不发字节 ⇒ 宿主 8 秒窗口结束时它必然还没下完。
   判据钉住四件事：
     ① 点下去这段时间，队列里**已经有**这条 job（status + 总量都可读）= 界面有东西可显示；
     ② 到点回 202 且**带 jobId / status / received / total**（旧实现 jobId 可能为 null ⇒ 客户端
        既轮询不到进度也等不到收尾，只能静默等到超时）；
     ③ 最终真的 done，再装一次能解压落位（不是"卡在 0% 再也不动"）；
     ④ 两个"没有可识别状态"的分支：**坏 zip 缓存**与**站点返回 HTML**，
        都必须给出明确错误码并**清掉缓存**，让「重试」能真重下（旧实现永远读同一个坏文件秒失败）。 */
{
  const MB = 1024 * 1024;
  const q = getDownloadQueue();
  const snapAll = () => { try { return q.snapshot() || []; } catch { return []; } };
  const cacheOf = (u) => join(dshHome, 'cache', 'skins-zip',
    createHash('sha256').update(u).digest('hex').slice(0, 32) + '.zip');
  const install = find('/folia/skins/install');

  bigZip = makeZip([
    { name: 'skin.json', data: JSON.stringify({ id: 'rain-whale', name: '雨夜鲸鱼娘', version: '0.1.0', contributes: { stylesheet: 'skin.css' } }) },
    { name: 'skin.css', data: '[data-dsh-skin="rain-whale"]{--y:1}' },
    { name: 'assets/big.bin', data: 'x'.repeat(Math.round(16.6 * MB)), deflate: false },
  ]);
  check('⑦ 假站点真的备好了一个 16.6 MB 的皮肤包', bigZip.length > 16.6 * MB, (bigZip.length / MB).toFixed(1) + ' MB');

  const bigUrl = site + '/big.zip';
  // 不等它返回：这期间"界面能不能看见状态"正是判据本身。
  const inflight = call(install, { method: 'POST', body: { id: 'rain-whale', url: bigUrl } });
  await sleep(1200);
  const live = snapAll().find((j) => j && j.url === bigUrl) || null;
  check('⑦ 点下去 1.2 秒内队列里就有这条 job（卡片有东西可显示）', Boolean(live),
    live ? JSON.stringify({ status: live.status, total: live.total }) : 'no-job');
  check('⑦ 它的 status 是 queued|running（不是"什么都没有"）',
    Boolean(live && (live.status === 'queued' || live.status === 'running')), live && live.status);
  check('⑦ 进度分母已知（站点 content-length ⇒ 16 MB 级）',
    Boolean(live && Number(live.total) > 16 * MB), live && String(live.total));

  const r = await inflight;
  check('⑦ 16.6 MB 那条真的被站点发过一次（不是本地缓存冒充的）', bigHits >= 1, 'hits=' + bigHits);
  check('⑦ 8 秒窗口内没下完 ⇒ 202 pending（不是失败、也不是静默）',
    r.status === 202 && Boolean(r.json && r.json.pending === true), JSON.stringify({ status: r.status, json: r.json }));
  check('⑦ 202 带 jobId（客户端据此拉进度；空 jobId 等于没有状态）',
    Boolean(r.json && r.json.jobId) && String(r.json.jobId).length > 0, JSON.stringify(r.json && { jobId: r.json.jobId }));
  check('⑦ 202 带 status/received/total 三个可识别字段',
    Boolean(r.json) && typeof r.json.status === 'string'
    && typeof r.json.received === 'number' && typeof r.json.total === 'number',
    JSON.stringify(r.json && { status: r.json.status, received: r.json.received, total: r.json.total }));
  check('⑦ 负对照：pending 但没 jobId 的响应不算"可识别状态"',
    !(r.json && r.json.pending === true && !r.json.jobId));

  const t0 = Date.now();
  let doneJob = null;
  while (Date.now() - t0 < 40000) {
    doneJob = snapAll().find((j) => j && j.url === bigUrl) || null;
    if (doneJob && doneJob.status === 'done') break;
    await sleep(200);
  }
  check('⑦ 16.6 MB 最终下完（done，不是永远 running/queued）',
    Boolean(doneJob && doneJob.status === 'done'), doneJob && doneJob.status);
  check('⑦ 落地字节数与站点声明一致（16.6 MB 级）',
    Boolean(doneJob && Number(doneJob.total) > 16.6 * MB), doneJob && String(doneJob.total));

  const r2 = await call(install, { method: 'POST', body: { id: 'rain-whale', url: bigUrl } });
  check('⑦ 下完后再装 ⇒ 200 ok（读本地 zip 解压落位）',
    r2.status === 200 && Boolean(r2.json && r2.json.ok === true), JSON.stringify({ status: r2.status, json: r2.json }));
  check('⑦ 皮肤目录真的写出来了（皮肤中心下一次扫描就能认领）',
    existsSync(join(dshHome, 'skins', 'rain-whale', 'skin.json')));

  /* ④a 坏 zip 缓存（"已存在 zip 缓存"分支不会有可识别状态） */
  FIXTURES['/corrupt.zip'] = makeZip([
    { name: 'skin.json', data: JSON.stringify({ id: 'coral-skin', name: '珊瑚', version: '0.1.0', contributes: { stylesheet: 'skin.css' } }) },
    { name: 'skin.css', data: 'c{}' },
  ]);
  const coralUrl = site + '/corrupt.zip';
  const coralCache = cacheOf(coralUrl);
  const ok1 = await call(install, { method: 'POST', body: { id: 'coral-skin', url: coralUrl } });
  check('⑦ 基准：小包一次装好（缓存随之落盘）',
    ok1.status === 200 && Boolean(ok1.json && ok1.json.ok) && existsSync(coralCache), JSON.stringify({ status: ok1.status, cache: existsSync(coralCache) }));
  // 删掉已装目录 + 把缓存截成 1/3 ⇒ 这条 URL 的"已存在 zip 缓存"是个坏包。
  rmSync(join(dshHome, 'skins', 'coral-skin'), { recursive: true, force: true });
  const whole = readFileSync(coralCache);
  writeFileSync(coralCache, whole.subarray(0, Math.max(64, Math.floor(whole.length / 3))));
  const r3 = await call(install, { method: 'POST', body: { id: 'coral-skin', url: coralUrl } });
  check('⑦ 坏缓存 ⇒ 422 bad-zip（不再把坏包当成功、也不再静默）',
    r3.status === 422 && Boolean(r3.json && r3.json.error === 'bad-zip'), JSON.stringify({ status: r3.status, json: r3.json }));
  check('⑦ 坏缓存**当场清掉**（cacheCleared 且文件真的没了）',
    Boolean(r3.json && r3.json.cacheCleared === true) && !existsSync(coralCache),
    JSON.stringify({ cleared: r3.json && r3.json.cacheCleared, exists: existsSync(coralCache) }));
  const hitsBefore = downloadHits;
  const r4 = await call(install, { method: 'POST', body: { id: 'coral-skin', url: coralUrl } });
  check('⑦ 点「重试」⇒ 真的重新下载并装好（不是每次都秒失败）',
    r4.status === 200 && Boolean(r4.json && r4.json.ok) && downloadHits > hitsBefore,
    JSON.stringify({ status: r4.status, hits: downloadHits - hitsBefore }));

  /* ④b 站点返回 HTML（200 但内容不是 zip） */
  FIXTURES['/html.zip'] = Buffer.from('<!DOCTYPE html><html><body>login required</body></html>');
  const htmlUrl = site + '/html.zip';
  const r5 = await call(install, { method: 'POST', body: { id: 'html-skin', url: htmlUrl } });
  check('⑦ 站点拿 HTML 冒充 zip ⇒ 422 not-a-zip（包结构不对，说得出原因）',
    r5.status === 422 && Boolean(r5.json && r5.json.error === 'not-a-zip'), JSON.stringify({ status: r5.status, json: r5.json }));
  check('⑦ 它不会被留在缓存里（否则每次重试都读同一份 HTML）', !existsSync(cacheOf(htmlUrl)));
  const r6 = await call(install, { method: 'POST', body: { id: 'html-skin', url: htmlUrl } });
  check('⑦ 再点一次仍然明确报错（有码、有原因，不静默卡住）',
    r6.status === 422 && typeof (r6.json && r6.json.error) === 'string' && r6.json.error.length > 0,
    JSON.stringify({ status: r6.status, error: r6.json && r6.json.error }));
}

server.close();
try { rmSync(dshHome, { recursive: true, force: true }); } catch { /* ignore */ }
/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const x of results) {
  if (x.ok) process.stdout.write('  ✓ ' + x.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + x.name + (x.detail ? ' — ' + x.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
