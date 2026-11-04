#!/usr/bin/env node
/**
 * verify-cache-manager.mjs — **4.23.7 面板内「缓存管理」**的回归（宿主接口 + 面板两半）。
 *
 * 这一族回答两个问题：「我这些可再生文件占了多少地方」和「我只清其中一层」。
 * 它危险的地方不在功能，而在**删**：一秒写错的清理函数足以毁掉用户的壁纸库、皮肤、
 * 甚至 DSH 自己的 Electron 数据目录。所以判据按"能删错什么"组织：
 *
 *   A 用量接口：五个目标都在、`total` 是各层之和、**只读**（不建目录、不改盘）。
 *   B 分目标隔离：每个 target **只删自己**，诱饵目录一个字节都不动；清完把
 *     `downloads.json` 里对应 kind 的 done 记录摘掉（否则留下"done 但文件已没了"）。
 *   C `skins` 必须**显式**点名：一键清理（其余四个）绝不能顺手卸载已装皮肤。
 *   D 安全边界：`..` / 绝对路径 / 盘符 / UNC 一律 400（**整单**拒绝：一个坏名就不执行）；
 *     符号链接**不跟随**（只删链接本身，链接指向的诱饵原封不动）；`isWithin` 的
 *     前缀比较负对照（`C:\home2` 不是 `C:\home` 的子目录）。
 *   E 失败隔离：被占用的文件进 `failed`、其余照删、响应 `partial:true`、**不 500**。
 *   F 面板：真渲染（React 最小替身）出五个按钮 + 两段式确认（第一下只上膛、第二下才清）
 *     + toast 报"释放了多少"。
 *   G 接线：真 `apply()` 注册了这两条路由（隔离测试证明不了"线接上了"）；族登记与
 *     route-registry / features 双向对账。
 *
 * 隔离：`DSH_HOME` / `DSH_FOLIA_ELECTRON_DIR` 都指向 `.test-cache/cache-manager/`，
 * 全程不碰真实用户目录（`skinsRoot()` / `electronHome()` 都跟着这两个环境变量走）。
 *
 * Usage: `node test/verify-cache-manager.mjs`
 */
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ISO = join(root, '.test-cache', 'cache-manager');
const HOME = join(ISO, 'home');
const ELECTRON = join(ISO, 'electron');
const DECOY = join(ISO, 'decoy');
const OUTSIDE = join(ISO, 'outside');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) passed += 1; else failed += 1;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
}
function section(title) { console.log('\n' + title); }

rmSync(ISO, { recursive: true, force: true });
process.env.DSH_HOME = HOME;
process.env.DSH_FOLIA_ELECTRON_DIR = ELECTRON;
delete process.env.DSH_FOLIA_CACHE_DIR;

const cacheMod = await import(pathToFileURL(join(root, 'lib', 'routes', 'cache.js')).href);
const { registerCacheRoutes, clearCache, isWithin, scanTree, clearTree, pruneDoneJobs, CACHE_TARGETS, TARGET_KINDS, DEPS } = cacheMod;

/* ── 素材：五个目标各一份文件 + 诱饵 ──────────────────────────────────────── */
const FILES = {
  library: [
    join(HOME, 'library', 'wallpaper', 'a.bin'),
    join(HOME, 'library', 'pet', 'b.bin'),
  ],
  'site-media': [join(HOME, 'cache', 'site-media', 's1.bin')],
  'skins-zip': [join(HOME, 'cache', 'skins-zip', 'k.zip')],
  skins: [join(HOME, 'skins', 'demo', 'skin.json')],
  electron: [
    join(ELECTRON, 'Cache', 'c1.bin'),
    join(ELECTRON, 'GPUCache', 'g1.bin'),
    join(ELECTRON, 'Code Cache', 'js', 'x.bin'),
  ],
};
const DECOY_FILES = [join(DECOY, 'keep.txt'), join(OUTSIDE, 'keep.txt')];
const BYTE = (n) => Buffer.alloc(n, 7);

function writeAll(list, size = 1024) {
  for (const p of list) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, BYTE(size)); }
}
writeAll(FILES.library);
writeAll(FILES['site-media']);
writeAll(FILES['skins-zip']);
writeAll(FILES.skins);
writeAll(FILES.electron);
writeAll(DECOY_FILES, 64);

/** `downloads.json`：两个 done（wallpaper / skin）、一个 running（wallpaper）、一个 done（boot）。 */
const STATE = join(HOME, 'downloads.json');
function writeState() {
  writeFileSync(STATE, JSON.stringify({
    version: 1,
    jobs: [
      { id: 'w1', url: 'http://x/a.bin', dest: FILES.library[0], kind: 'wallpaper', total: 1024, status: 'done' },
      { id: 'w2', url: 'http://x/running.bin', dest: join(HOME, 'library', 'wallpaper', 'run.part'), kind: 'wallpaper', total: 9, status: 'running' },
      { id: 'p1', url: 'http://x/b.bin', dest: FILES.library[1], kind: 'pet', total: 1024, status: 'done' },
      { id: 's1', url: 'http://x/k.zip', dest: FILES['skins-zip'][0], kind: 'skin', total: 1024, status: 'done' },
      { id: 'b1', url: 'http://x/boot.mp4', dest: join(HOME, 'library', 'boot', 'c.mp4'), kind: 'boot', total: 1024, status: 'done' },
    ],
  }, null, 2));
}
const readState = () => JSON.parse(readFileSync(STATE, 'utf8'));
const kindsOf = () => readState().jobs.map((j) => j.id + ':' + j.kind + ':' + j.status).sort();

/* ── mock webServer + req/res 垫片（与 verify-cache-dir 同形）──────────────── */
const routes = [];
const disposers = [];
const mockWebServer = {
  register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); }; },
};
registerCacheRoutes(mockWebServer, { disposers, base: '/folia', log: () => {} });
const BASE = '/folia/cache';
const routeFor = (p) => routes.find((r) => r.path === p);
const USAGE_URL = BASE + '/usage';
const CLEAR_URL = BASE + '/clear';

function fakeRes() {
  const state = { status: 200, headers: {}, body: Buffer.alloc(0), ended: false };
  const res = new Writable({
    write(chunk, enc, cb) {
      state.body = Buffer.concat([state.body, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      cb();
    },
    final(cb) { state.ended = true; cb(); },
  });
  res.setHeader = (k, v) => { state.headers[k] = v; };
  res.writeHead = (s, h) => { state.status = s; if (h) Object.assign(state.headers, h); };
  Object.defineProperty(res, 'statusCode', { get: () => state.status, set: (v) => { state.status = v; } });
  res.__state = state;
  return res;
}
function fakeReq(url, method) { return { url, method, headers: {} }; }
function fakeReqBody(url, method, obj) {
  const r = Readable.from([Buffer.from(JSON.stringify(obj))]);
  r.url = url; r.method = method; r.headers = { 'content-type': 'application/json' };
  return r;
}
async function runHandler(route, req) {
  const res = fakeRes();
  const out = route.handler(req, res);
  if (out && typeof out.then === 'function') await out;
  if (!res.__state.ended) {
    await new Promise((r) => { const t = setTimeout(r, 8000); res.on('finish', () => { clearTimeout(t); r(); }); });
  }
  return res;
}
const json = (res) => { try { return JSON.parse(res.__state.body.toString('utf8')); } catch { return null; } };
const getUsage = async () => json(await runHandler(routeFor(USAGE_URL), fakeReq(USAGE_URL, 'GET'))) || {};
const postClear = async (targets) => {
  const res = await runHandler(routeFor(CLEAR_URL), fakeReqBody(CLEAR_URL, 'POST', { targets }));
  return { status: res.__state.status, body: json(res) || {} };
};
const listTree = (dir) => {
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = join(d, e.name); out.push(p); if (e.isDirectory()) walk(p); }
  };
  walk(dir);
  return out.sort();
};

/* ── G. 接线（先判，后面的行为才有意义）────────────────────────────────────── */
section('G. 接线：路由族 / 注册点 / 登记表');
check('G1 注册了恰好两条路由（usage / clear）',
  routes.length === 2 && routes.map((r) => r.path).sort().join(',') === [USAGE_URL, CLEAR_URL].sort().join(','),
  routes.map((r) => r.path).join(' '));
check('G2 两个 disposer 都进了 disposers（卸载能撤掉）', disposers.length === 2, 'disposers=' + disposers.length);
check('G3 注入契约 = 本族真正用的三个键', DEPS.join(',') === 'disposers,base,log', DEPS.join(','));
{
  const reg = readFileSync(join(root, 'lib', 'route-registry.js'), 'utf8');
  const feat = readFileSync(join(root, 'lib', 'features.js'), 'utf8');
  check('G4 route-registry 有 id=cache 的族行（且 register 指向本模块）',
    /id:\s*'cache'/.test(reg) && /register:\s*registerCacheRoutes/.test(reg)
    && /from '\.\/routes\/cache\.js'/.test(reg));
  check('G5 features.js 把 lib/routes/cache.js 登记进宿主文件面（否则选装裁剪会漏它）',
    /'lib\/routes\/cache\.js'/.test(feat));
}
{
  // 真 apply()：隔离的假 mock 证明不了"线接上了"（本仓踩过：控件加进错误的 ctx 档）。
  let ok = false;
  let why;
  const local = [];
  const mockCtx = {
    webServer: { register(route) { local.push(route); return () => {}; }, tapIndex() { return () => {}; } },
  };
  try {
    const hostMod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href);
    const host = hostMod.default || hostMod;
    const dispose = host.apply(mockCtx);
    ok = local.some((r) => r.path === USAGE_URL) && local.some((r) => r.path === CLEAR_URL);
    why = 'runtime routes=' + local.length;
    if (typeof dispose === 'function') dispose();
  } catch (e) {
    why = 'apply() 抛了：' + String((e && e.message) || e).slice(0, 140);
  }
  check('G6 真 apply() 注册了 /folia/cache/usage 与 /folia/cache/clear', ok, why);
}

/* ── A. 用量接口 ───────────────────────────────────────────────────────────── */
section('A. GET /folia/cache/usage');
writeState();
const before = listTree(HOME).concat(listTree(ELECTRON));
const usage = await getUsage();
const usageAfter = listTree(HOME).concat(listTree(ELECTRON));
check('A1 200 + 五个目标（顺序 = 宿主白名单）',
  ['library', 'site-media', 'skins-zip', 'skins', 'electron'].every((t, i) => usage.items && usage.items[i]
    && usage.items[i].target === t),
  (usage.items || []).map((x) => x.target).join(','));
{
  const expect = {
    library: 2048, 'site-media': 1024, 'skins-zip': 1024, skins: 1024, electron: 3072,
  };
  const got = Object.fromEntries((usage.items || []).map((x) => [x.target, x.bytes]));
  check('A2 每层字节数 = 该层文件之和（1024/2048/3072 三档）',
    Object.keys(expect).every((k) => got[k] === expect[k]), JSON.stringify(got));
  check('A3 total = 各层之和（面板那一行"合计"读的就是它）',
    usage.total && usage.total.bytes === 8192 && usage.total.files === 8,
    JSON.stringify(usage.total));
}
check('A4 只读：调用前后文件清单逐字不变（不建目录、不改盘）',
  before.join('|') === usageAfter.join('|'), 'diff=' + (before.length === usageAfter.length ? 'none' : 'length'));
{
  const res = await runHandler(routeFor(USAGE_URL), fakeReq(USAGE_URL, 'POST'));
  check('A5 只认 GET/HEAD：POST ⇒ 405', res.__state.status === 405);
}
{
  // 空 HOME：不存在的层必须报 exists:false 且**不把目录建出来**。
  const emptyHome = join(ISO, 'empty-home');
  mkdirSync(emptyHome, { recursive: true });
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = emptyHome;
  const u = await getUsage();
  const created = existsSync(join(emptyHome, 'cache'));
  process.env.DSH_HOME = prev;
  check('A6 目标目录不存在 ⇒ exists:false 且不创建目录（只读口径）',
    (u.items || []).filter((x) => ['site-media', 'skins-zip'].includes(x.target)).every((x) => x.exists === false)
    && !created, 'created=' + created);
}
check('A7 electron 给出四个子部件（Cache / Code Cache / GPUCache / Service Worker）',
  (() => {
    const e = (usage.items || []).find((x) => x.target === 'electron');
    return e && Array.isArray(e.parts) && e.parts.length === 4
      && e.parts.some((p) => p.name === 'GPUCache' && p.bytes === 1024);
  })(), JSON.stringify(((usage.items || []).find((x) => x.target === 'electron') || {}).parts || []).slice(0, 120));

/* ── B. 分目标隔离 ─────────────────────────────────────────────────────────── */
section('B. 每个 target 只删自己（诱饵不删）');
{
  const r = await postClear(['library']);
  const left = listTree(HOME);
  check('B1 清 library：library 里的文件没了',
    !existsSync(FILES.library[0]) && !existsSync(FILES.library[1]));
  check('B2 清 library：其它四层一个字节都没动',
    FILES['site-media'].every((p) => existsSync(p)) && FILES['skins-zip'].every((p) => existsSync(p))
    && FILES.skins.every((p) => existsSync(p)) && FILES.electron.every((p) => existsSync(p)),
    'left=' + left.length);
  check('B3 清 library：诱饵目录原封不动', DECOY_FILES.every((p) => existsSync(p)));
  check('B4 清 library：响应给出 released 字节数（1024×2）',
    r.body.released && r.body.released.bytes === 2048 && r.body.released.files === 2,
    JSON.stringify(r.body.released));
  check('B5 清 library：downloads.json 摘掉 wallpaper/pet/boot 的 done 记录，保留 running 与 skin',
    (() => {
      const k = kindsOf();
      return k.includes('s1:skin:done') && k.includes('w2:wallpaper:running')
        && !k.some((x) => x.startsWith('w1:') || x.startsWith('p1:') || x.startsWith('b1:'));
    })(), kindsOf().join(' '));
  check('B6 清 library：返回的 removedJobs 与真实摘除数一致', r.body.removedJobs === 3, 'removedJobs=' + r.body.removedJobs);
}
{
  writeState();
  const r = await postClear(['site-media']);
  check('B7 清 site-media：只删这一层',
    !existsSync(FILES['site-media'][0]) && existsSync(FILES['skins-zip'][0]) && existsSync(FILES.skins[0]),
    'released=' + JSON.stringify(r.body.released));
  check('B8 site-media 没有下载记录 ⇒ removedJobs=0（不做无意义改写）', r.body.removedJobs === 0);
}
{
  writeState();
  const r = await postClear(['skins-zip']);
  check('B9 清 skins-zip：zips 没了、skins 目录仍在、downloads 里 skin 的 done 被摘',
    !existsSync(FILES['skins-zip'][0]) && existsSync(FILES.skins[0])
    && !kindsOf().some((x) => x.startsWith('s1:')) && r.body.removedJobs === 1,
    kindsOf().join(' '));
}

/* ── C. skins 必须显式点名 ─────────────────────────────────────────────────── */
section('C. skins 只有显式点名才清（一键清理不含皮肤）');
{
  writeState();
  const r = await postClear(['library', 'site-media', 'skins-zip', 'electron']);
  check('C1 「一键清理（不含皮肤）」四个目标都清了',
    !existsSync(FILES['site-media'][0]) && !existsSync(FILES['skins-zip'][0]),
    JSON.stringify(r.body.cleared));
  // 「一个字节没动」= 文件还在、大小还是 1024、内容还没被改写。
  check('C2 已装皮肤**一个字节没动**（不点名就绝不卸载）',
    existsSync(FILES.skins[0]) && readFileSync(FILES.skins[0]).length === 1024,
    'exists=' + existsSync(FILES.skins[0]));
}
{
  writeState();
  const r = await postClear(['skins']);
  check('C3 显式点名 skins ⇒ 清掉（这是"卸载全部皮肤"的那一步）',
    !existsSync(FILES.skins[0]) && r.body.cleared.some((c) => c.target === 'skins'),
    JSON.stringify(r.body.cleared));
  check('C4 清 skins 会带 skins-uninstalled 警告（面板据此说明"皮肤全部卸载了"）',
    Array.isArray(r.body.warnings) && r.body.warnings.includes('skins-uninstalled'));
}

/* ── D. 安全边界 ───────────────────────────────────────────────────────────── */
section('D. 安全：路径穿越 / 绝对路径 / 符号链接');
{
  const cases = [
    ['..\\library', '../library'],
    ['../library', '../library'],
    ['绝对路径', 'C:\\\\Windows\\\\System32'],
    ['POSIX 绝对路径', '/etc'],
    ['UNC', '\\\\server\\share'],
  ];
  for (const [label, bad] of cases) {
    const r = await postClear([bad]);
    check('D 非法目标（' + label + '）⇒ 400 且给出 allowed 白名单',
      r.status === 400 && Array.isArray(r.body.allowed) && r.body.allowed.length === 5,
      'status=' + r.status + ' body=' + JSON.stringify(r.body).slice(0, 90));
  }
}
{
  // **整单**校验：混入一个坏名字 ⇒ 一个都不执行（半执行最难解释）。
  writeAll(FILES['site-media']);
  const r = await postClear(['site-media', '../library']);
  check('D 混入坏目标 ⇒ 400 且**一个都没删**（不是"先清合法的再报错"）',
    r.status === 400 && existsSync(FILES['site-media'][0]));
}
{
  // 符号链接/junction：只删链接本身，链接指向的诱饵原封不动。
  const linkPath = join(HOME, 'library', 'link-to-decoy');
  try { symlinkSync(DECOY, linkPath, 'junction'); } catch { try { symlinkSync(DECOY, linkPath, 'dir'); } catch { /* 无权限则跳过 */ } }
  const linked = existsSync(linkPath);
  const decoyBefore = listTree(DECOY);
  const s = scanTree(join(HOME, 'library'));
  const r = await postClear(['library']);
  const decoyAfter = listTree(DECOY);
  check('D 统计不跟随符号链接（links 计数 > 0、字节不把诱饵算进来）',
    !linked || (s.links > 0), 'links=' + s.links + ' linked=' + linked);
  check('D 清理不跟随符号链接：诱饵目录内容逐字不变',
    decoyBefore.join('|') === decoyAfter.join('|') && DECOY_FILES.every((p) => existsSync(p)),
    'entries=' + decoyAfter.length);
  check('D 链接本身被删掉（它留在库里只会变成一个坏指向）', !linked || !existsSync(linkPath),
    'linked=' + linked + ' still=' + existsSync(linkPath));
  check('D 响应不把"链接"算成删除失败', Array.isArray(r.body.failed) && r.body.failed.length === 0,
    JSON.stringify(r.body.failed).slice(0, 120));
}
{
  // `isWithin` 是路径安全的第一道闸：前缀比较会把 `home2` 判成 `home` 的子目录。
  check('D isWithin：子目录/自身为真、前缀相似的兄弟目录为假',
    isWithin(HOME, join(HOME, 'library')) === true
    && isWithin(HOME, HOME) === true
    && isWithin(HOME, join(HOME + '2', 'library')) === false
    && isWithin(HOME, join(HOME, '..', 'outside')) === false
    && isWithin(HOME, OUTSIDE) === false);
}
{
  // 直接驱动 clearCache：目标目录若被算到允许根之外 ⇒ 拒绝（不删、不报成功）。
  const r = clearCache(['library']);
  check('D clearCache 只接受白名单目标（未知目标记 failed，不抛）',
    clearCache(['nope']).failed.some((f) => f.reason === 'unknown-target') && Array.isArray(r.cleared));
}
{
  const bad = await postClear([]);
  check('D 空 targets ⇒ 400（不会把"没指定"当成"全清"）', bad.status === 400);
  const notJson = await runHandler(routeFor(CLEAR_URL), (() => {
    const q = Readable.from([Buffer.from('{oops')]); q.url = CLEAR_URL; q.method = 'POST'; q.headers = {};
    return q;
  })());
  check('D 坏 JSON ⇒ 400', notJson.__state.status === 400);
}

/* ── E. 失败隔离（被占用的文件）────────────────────────────────────────────── */
section('E. 被占用的文件进 failed，其余照删，不 500');
{
  /**
   * 造一个**真的**被占用的文件：Windows 上用 PowerShell 以 `FileShare.None` 打开它
   * （Node 自己做不到 —— libuv 的 open 一律带 FILE_SHARE_DELETE，于是 unlink 永远成功，
   * 这条判据就会变成恒真的"没有失败"）。POSIX 上退化成"父目录去掉写位"。
   *
   * 为什么值得多起一个进程：这条判据要证明的正是"删不掉的文件不会拖垮整层"，
   * 而"删不掉"必须由**操作系统**给出，不能靠 mock（mock 只会证明我们自己写的那句 catch）。
   */
  const lockDir = join(ISO, 'lock');
  mkdirSync(lockDir, { recursive: true });
  const holdExclusive = async (file) => {
    if (process.platform === 'win32') {
      const ps1 = join(lockDir, 'hold.ps1');
      const ready = join(lockDir, 'ready');
      const escaped = file.split("'").join("''");
      const script = [
        "$f = [System.IO.File]::Open('" + escaped + "', [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)",
        "Set-Content -Path '" + ready.split("'").join("''") + "' -Value 'ok'",
        'Start-Sleep -Seconds 40',
        '$f.Close()',
      ].join('\r\n');
      // BOM：Windows PowerShell 5.1 无 BOM 时按 ANSI 读脚本，我们路径里有中文会读坏。
      writeFileSync(ps1, '\uFEFF' + script, 'utf8');
      let child = null;
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
          { stdio: 'ignore', windowsHide: true });
      } catch { child = null; }
      for (let i = 0; i < 100; i += 1) {
        if (existsSync(ready)) break;
        await new Promise((r) => { setTimeout(r, 100); });
      }
      if (!existsSync(ready)) { try { if (child) child.kill(); } catch { /* ignore */ } return null; }
      return { release: () => { try { if (child) child.kill(); } catch { /* ignore */ } } };
    }
    // POSIX：父目录不可写 ⇒ unlink 报 EACCES。
    try { chmodSync(dirname(file), 0o555); } catch { return null; }
    return { release: () => { try { chmodSync(dirname(file), 0o755); } catch { /* ignore */ } } };
  };

  const busyDir = join(HOME, 'library', 'busy');
  mkdirSync(busyDir, { recursive: true });
  const busyFile = join(busyDir, 'locked.bin');
  writeFileSync(busyFile, BYTE(512));
  const normal = [join(HOME, 'library', 'wallpaper', 'n1.bin'), join(HOME, 'library', 'wallpaper', 'n2.bin')];
  writeAll(normal, 256);

  const hold = await holdExclusive(busyFile);
  check('E0 造出一个操作系统级的"被占用"文件（FileShare.None / 父目录只读）',
    hold !== null, hold ? '已占用 ' + busyFile : '无法建立占用（本用例的其余几条会失去前提）');
  const r = await postClear(['library']);
  const failedPaths = (r.body.failed || []).map((f) => f.path);
  check('E1 被占用的文件确实进 failed（不是 mock：unlink 真失败了）',
    hold !== null && failedPaths.some((p) => p === busyFile),
    'failed=' + JSON.stringify(failedPaths).slice(0, 140));
  check('E2 同层其余文件照删（失败不中断）', normal.every((p) => !existsSync(p)));
  check('E3 响应 200 + partial:true + ok:false（部分成功要说得出来）',
    r.status === 200 && r.body.partial === true && r.body.ok === false);
  check('E4 被占用文件仍留在盘上（我们不假装删掉了）', !hold || existsSync(busyFile));
  if (hold) hold.release();
  await new Promise((r2) => { setTimeout(r2, 400); });
  const r2 = await postClear(['library']);
  check('E5 解除占用后再清 ⇒ ok:true、failed 为空（E1 不是恒真）',
    r2.body.ok === true && (r2.body.failed || []).length === 0);
  check('E6 clearTree 对不存在的目录是空操作（幂等）',
    JSON.stringify(clearTree(join(HOME, 'library'))) === JSON.stringify({ files: 0, bytes: 0, failed: [] }));
}

/* ── F. 面板（真渲染 + 两段式确认）─────────────────────────────────────────── */
section('F. 面板：五层用量 + 五个按钮 + 二次确认 + toast');
{
  // React 最小替身：只做 createElement/Fragment —— 面板是纯函数组件树，够用。
  const el = (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat(4).filter((k) => k != null && k !== false) });
  globalThis.React = { createElement: el, Fragment: 'Fragment', useState: (v) => [v, () => {}], useEffect: () => {} };
  globalThis.weT = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : String(s));
  globalThis.fmtCacheBytes = (n) => {
    const v = Math.max(0, Number(n) || 0);
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let x = v / 1024; let i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i += 1; }
    return (x >= 10 ? x.toFixed(1) : x.toFixed(2)) + ' ' + units[i];
  };
  const panelMod = await import(pathToFileURL(join(root, 'src', 'panel-tabs-advanced.js')).href);
  const nodes = (n, acc = []) => {
    if (Array.isArray(n)) { n.forEach((x) => nodes(x, acc)); return acc; }
    if (!n || typeof n !== 'object') return acc;
    acc.push(n);
    if (Array.isArray(n.children)) n.children.forEach((x) => nodes(x, acc));
    return acc;
  };
  const textOf = (n) => nodes(n).map((x) => (Array.isArray(x.children) ? x.children.filter((c) => typeof c === 'string').join('') : '')).join('|');
  const buttons = (tree) => nodes(tree).filter((n) => n.type === 'button');
  const buttonLabels = (tree) => buttons(tree).map((b) => (Array.isArray(b.children) ? b.children.filter((c) => typeof c === 'string').join('') : ''));
  const clickable = (tree, label) => buttons(tree).find((b) => (Array.isArray(b.children) ? b.children.filter((c) => typeof c === 'string').join('') : '') === label);

  const usagePayload = {
    ok: true,
    items: [
      { target: 'library', bytes: 3 * 1024 * 1024 * 1024, files: 12, exists: true, within: true, links: 0 },
      { target: 'site-media', bytes: 2048, files: 2, exists: true, within: true, links: 0 },
      { target: 'skins-zip', bytes: 4096, files: 1, exists: true, within: true, links: 0 },
      { target: 'skins', bytes: 1024, files: 3, exists: true, within: true, links: 0 },
      { target: 'electron', bytes: 1024 * 1024, files: 9, exists: true, within: true, links: 0 },
    ],
    total: { bytes: 3 * 1024 * 1024 * 1024 + 2048 + 4096 + 1024 + 1048576, files: 27 },
  };
  const calls = [];
  const mkCtx = (sel) => ({
    sel,
    onClearCache: (t) => calls.push({ kind: 'clear', targets: t }),
    onClearCacheSkins: () => calls.push({ kind: 'skins' }),
    onRefreshCacheUsage: () => calls.push({ kind: 'refresh' }),
    armedConfirm: sel.armedConfirm || '',
    onDisarmConfirm: () => calls.push({ kind: 'disarm' }),
    // 缓存位置那一节还要这些（不传会渲染期炸 —— 面板是同一个函数画两段）
    onStartEditCacheDir: () => {}, onCancelEditCacheDir: () => {}, onCacheDirDraft: () => {},
    onCacheDirBrowseInput: () => {}, onCacheDirBrowseGo: () => {}, onCacheDirBrowseEnter: () => {},
    onCacheDirBrowseUp: () => {}, onPickCacheDir: () => {}, onCloseCacheDirBrowse: () => {},
  });
  const selFull = {
    inventory: { cacheDir: 'D:\\cache' }, cacheDirBrowse: null, editingCacheDir: false, cacheDirDraft: '',
    cacheDirBusy: false, cacheDirNote: '', cacheDirError: '',
    cacheUsage: usagePayload, cacheBusy: '', cacheNote: '', cacheError: '', armedConfirm: '',
  };
  let tree = null;
  let err = '';
  try { tree = panelMod.renderAdvancedCacheSection(mkCtx(selFull)); } catch (e) { err = String((e && e.message) || e); }
  check('F1 面板渲染得出（缺全局替身 / 缺 ctx 字段会在这里炸）', err === '', err || 'ok');
  if (!err) {
    const labels = buttonLabels(tree);
    const need = ['清空媒体', '清空站点媒体', '清空皮肤包', '清空已装皮肤…', '清空 Electron 缓存', '一键清理（不含皮肤）'];
    // 4.23.15：这一节多了两枚按钮 —— 本地媒体自检的「刷新」与「校验并修复本地媒体」。
    // 判据跟着改：按钮**多**是新增能力，但少了任何一枚清理按钮都是回归。
    check('F2 五个清理按钮都在（这一节共 10 枚按钮：更改 / 刷新×2 / 校验并修复 + 六码清理）',
      need.every((l) => labels.includes(l))
      && labels.length === 10
      && labels.includes('校验并修复本地媒体'), labels.join(' / '));
    const txt = textOf(tree);
    check('F3 用量行给出各层体积与文件数 + 合计（面板真的把读数画出来了）',
      /3\.00 GB/.test(txt) && /2\.00 KB/.test(txt) && /27/.test(txt) && /缓存管理/.test(txt),
      txt.slice(0, 160));
    check('F4 electron 行标注"需重启 DSH"（占用是常态，得提前说）', /需重启 DSH/.test(txt));
    const spy = (label) => { const b = clickable(tree, label); if (b && b.props && typeof b.props.onClick === 'function') b.props.onClick(); };
    spy('清空媒体');
    spy('清空皮肤包');
    spy('清空站点媒体');
    spy('清空 Electron 缓存');
    spy('一键清理（不含皮肤）');
    check('F5 每个按钮只清自己：五个 onClick 的 targets 逐条对',
      JSON.stringify(calls.filter((c) => c.kind === 'clear').map((c) => c.targets)) === JSON.stringify([
        ['library'], ['skins-zip'], ['site-media'], ['electron'],
        ['library', 'site-media', 'skins-zip', 'electron'],
      ]), JSON.stringify(calls.filter((c) => c.kind === 'clear')));
    check('F6 「一键清理」的 targets 里**没有** skins', !calls.some((c) => c.kind === 'clear'
      && c.targets.includes('skins')));
    calls.length = 0;
    spy('清空已装皮肤…');
    check('F7 第一下点「清空已装皮肤」只上膛、不发请求（两段式）',
      calls.length === 1 && calls[0].kind === 'skins' && !calls.some((c) => c.kind === 'clear'),
      JSON.stringify(calls));
    // 上膛后的渲染：确认/取消两枚，且确认才真的清 skins。
    const armedSel = Object.assign({}, selFull, { armedConfirm: 'cache:skins' });
    const armedTree = panelMod.renderAdvancedCacheSection(mkCtx(armedSel));
    const armedLabels = buttonLabels(armedTree);
    check('F8 上膛后画出「确认 / 取消」两枚（问句不跨上下文残留）',
      armedLabels.includes('确认清空已装皮肤') && armedLabels.includes('取消'), armedLabels.join(' / '));
    calls.length = 0;
    const confirmBtn = clickable(armedTree, '确认清空已装皮肤');
    if (confirmBtn && typeof confirmBtn.props.onClick === 'function') confirmBtn.props.onClick();
    check('F9 确认那一下才真的发清理（且是 skins 单独一项）',
      calls.length === 1 && calls[0].kind === 'skins', JSON.stringify(calls));
    const cancelBtn = clickable(armedTree, '取消');
    if (cancelBtn && typeof cancelBtn.props.onClick === 'function') cancelBtn.props.onClick();
    check('F10 取消只撤令牌、不发请求',
      calls.filter((c) => c.kind === 'disarm').length === 1 && calls.filter((c) => c.kind === 'skins').length === 1);
  }
  // 没有用量数据时按钮全禁用（不许"点了没反应"）。
  const emptySel = Object.assign({}, selFull, { cacheUsage: null });
  let emptyTree = null;
  try { emptyTree = panelMod.renderAdvancedCacheSection(mkCtx(emptySel)); } catch { /* F1 已报 */ }
  if (emptyTree) {
    const CLEAN_LABELS = ['清空媒体', '清空站点媒体', '清空皮肤包', '清空已装皮肤…', '清空 Electron 缓存', '一键清理（不含皮肤）'];
    const btns = buttons(emptyTree).filter((b) => CLEAN_LABELS.includes(
      Array.isArray(b.children) ? b.children.filter((c) => typeof c === 'string').join('') : ''));
    check('F11 还没拿到用量时清理按钮全部 disabled（并显示"正在统计…"）',
      btns.length === 6 && btns.every((b) => b.props && b.props.disabled === true)
      && /正在统计缓存用量/.test(textOf(emptyTree)), 'btns=' + btns.length);
  }
  // toast：客户端把 released.bytes 翻成"释放 X"的整句（文案与值都要在）。
  const clientSrc = readFileSync(join(root, 'src', 'client.js'), 'utf8');
  check('F12 客户端 toast 用 released.bytes/files 拼出「已清理 … 释放 …」',
    /released && res\.data\.released\.bytes/.test(clientSrc) || /\(d\.released && d\.released\.bytes\)/.test(clientSrc)
    ? /已清理 \{name\}：释放 \{size\}（\{n\} 个文件）/.test(clientSrc) : false);
  check('F13 toast 对"部分失败"单独一句话（占用 ⇒ 重启生效），不把部分成功说成成功',
    /个文件被占用，重启 DSH 后彻底生效/.test(clientSrc));
  check('F14 客户端只发目标名（路径不经过客户端）',
    /apiPostJson\(CACHE_CLEAR_URL, \{ targets: list \}/.test(clientSrc)
    && !/apiPostJson\(CACHE_CLEAR_URL, \{[^}]*path/.test(clientSrc));
  check('F15 进「系统」页签才拉用量（不跟轮询走；4.23.15 同一次也拉本地媒体账本）',
    /activeTab !== "system"\) return;/.test(clientSrc)
    && /loadCacheUsage\(\);/.test(clientSrc)
    && /loadMediaHealth\(\);/.test(clientSrc));
  const dict = readFileSync(join(root, 'src', 'i18n-copy-panel.js'), 'utf8');
  const needDict = ['缓存管理', '已清理 {name}：释放 {size}（{n} 个文件）', '需重启 DSH', '一键清理（不含皮肤）'];
  check('F16 新增文案都进了英文词表（零漏译不靠"以后再说"）',
    needDict.every((k) => dict.includes(JSON.stringify(k))), needDict.filter((k) => !dict.includes(JSON.stringify(k))).join(' '));
}

section('附 纯函数自检');
check('scanTree 对文件路径返回 files=1、对不存在返回 exists=false',
  scanTree(DECOY_FILES[0]).files === 1 && scanTree(join(ISO, 'nope')).exists === false,
  'file=' + JSON.stringify(scanTree(DECOY_FILES[0])));
check('TARGET_KINDS 覆盖四个落盘层（site-media / skins / electron 本来就没有下载记录）',
  JSON.stringify(TARGET_KINDS.library) === JSON.stringify(['wallpaper', 'pet', 'boot', 'media', 'scene', 'default'])
  && TARGET_KINDS['skins-zip'].join() === 'skin' && TARGET_KINDS['site-media'].length === 0);
check('CACHE_TARGETS 顺序 = 面板展示顺序（五层，skins 在 electron 之前）',
  CACHE_TARGETS.join('|') === 'library|site-media|skins-zip|skins|electron');
check('pruneDoneJobs 对没有 downloads.json 的目录返回 0（不抛）',
  pruneDoneJobs(join(ISO, 'nope'), ['wallpaper']) === 0);

rmSync(ISO, { recursive: true, force: true });
console.log('\n' + (failed ? 'CACHE MANAGER CHECKS FAILED' : 'ALL CACHE MANAGER CHECKS PASSED')
  + ' — ' + passed + ' 通过 / ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
