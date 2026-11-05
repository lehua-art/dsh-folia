/**
 * routes/cache.js — 面板内「缓存管理」：**各层用量统计 + 分目标清理**（4.23.7）。
 *
 * 为什么需要它（用户口径）：插件的缓存散在五处（壁纸/媒体库、站点媒体代理、皮肤包 zip、
 * 已装皮肤、Electron 自己的 Cache/Code Cache/GPUCache/Service Worker）。过去要清一遍得
 * 自己找回那几个路径、关掉 DSH 再删 —— 普通用户做不到。这一族把"现在用了多少 / 一键清哪些"
 * 做成两条接口，面板只画按钮。
 *
 * 路由（family = `cache`，与既有的 `/cache-dir` 族不重叠）：
 *   GET  /folia/cache/usage → 各层用量与文件数（library / site-media / skins-zip / skins /
 *                              electron 五个部件）+ 总计。**只读**，不建目录、不改盘。
 *   POST /folia/cache/clear {targets:[...]} → 逐项清理：
 *        · library / site-media / skins-zip：**删内容、保留目录**（目录本身是下一次写入的落点）；
 *        · skins：**默认不清**，只有请求里显式列出才清（清掉 = 皮肤中心那边全部卸载）；
 *        · electron：尽力删，被占用（EBUSY/EPERM）的文件进 `failed` 并提示"重启 DSH 后彻底生效"；
 *        清完把 `downloads.json` 里**对应 kind 且已 done** 的记录摘掉 —— 否则会留下
 *        "done 但文件已经没了"的残留状态（下一次点那条壁纸会拿一个空路径去播）。
 *
 * 安全（每一条都在 test/verify-cache-manager.mjs 里有判据）：
 *   · **路径只由本模块算**，请求体里只有目标**名字**（白名单），任何路径形态（`../`、绝对路径、
 *     盘符、UNC）都不是合法目标 ⇒ 400。**绝不**把请求里的字符串当路径用。
 *   · 算出来的每个目录都必须落在两个**允许根**之下（`DSH_HOME` / Electron 数据目录）；
 *     越界一律拒绝（`isWithin`），不删、不上报成功。
 *   · **不跟随符号链接**：统计用 `lstat`，软链本身只计入"跳过的链接"、不计入字节；
 *     清理时只 `unlink` 链接本身，绝不递归进它指向的地方。
 *   · 全部失败路径"宁可不清"：读不到 / 不是目录 / 权限不足都只记进 `failed`，不抛、不影响其它目标。
 *
 * 注入契约：`disposers` / `base` / `log`（`DEPS` 与 `test/verify-inject-contracts.mjs` 双向对账）。
 * 应答一律走 `lib/json-response.js` 的 `sendJson`（JSON 回复的唯一实现）。
 */
import {
  lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
// 收 body 的唯一缓冲实现（累加 + 字节计闸 + 一次解码）+ 控制面 JSON 的统一上限。
import { bodyReader, CONTROL_JSON_MAX_BYTES } from '../http-body.js';
// JSON 应答的唯一实现（状态码 + 两个头 + end）。
import { sendJson } from '../json-response.js';
// 4.23.19（P0）：清掉 library 里的成品后，必须把**内存队列**里的 done 记录同步成 pending。
// 只改 downloads.json 不动单例 ⇒ job 仍 done ⇒ 客户端要 /local-media ⇒ 404 ⇒ 假"无法解码"。
// 反向依赖不成立（downloads.js 不 import 本文件），不会形成环。
import { resetQueuedDoneForKinds, reconcileMediaState } from './downloads.js';
// 4.24.0（P0-B）：**清单缓存也是"清空媒体"的一部分**。清单（内存 + `site-items.json`）里
// 写死了每条 `localReady` / `mediaProxy`；不清它，客户端下一次拿到的还是"已缓存"快照
// ⇒ 角标不更新、第一次点击又去播已被删掉的本地副本。反向依赖不成立（inventory.js 不 import 本文件）。
import { invalidateSiteCache, inventoryEpoch } from './inventory.js';

/** 注入契约（P2-7A / ADR-0013 D12）：本族从 `c` 消费的**必需**键。 */
export const DEPS = ['disposers', 'base', 'log'];

/** 可清理的目标白名单（顺序 = 面板展示顺序）。请求里出现别的名字一律 400。 */
export const CACHE_TARGETS = ['library', 'site-media', 'skins-zip', 'skins', 'electron'];

/**
 * 各目标清完后该摘掉哪些 **downloads.json kind** 的 done 记录。
 *
 * 口径：`library/<kind>/<hash>.<ext>` 是下载队列的落点（见 lib/routes/downloads.js 的
 * `libraryDest`），所以"清空媒体缓存"必须把落在那里的 job 记录一起摘掉；皮肤包 zip 落在
 * `cache/skins-zip/`，对应 `skin`。`site-media` 是代理缓存（按 URL 散列，没有 job 记录），
 * `skins` / `electron` 本来就没有下载记录 ⇒ 空数组。
 */
export const TARGET_KINDS = {
  library: ['wallpaper', 'pet', 'boot', 'media', 'scene', 'default'],
  'site-media': [],
  'skins-zip': ['skin'],
  skins: [],
  electron: [],
};

/** Electron 自己的缓存部件（相对 Electron 数据目录；`Service Worker` 是子目录）。 */
const ELECTRON_PARTS = [
  ['Cache', 'Cache'],
  ['Code Cache', 'Code Cache'],
  ['GPUCache', 'GPUCache'],
  ['Service Worker/CacheStorage', join('Service Worker', 'CacheStorage')],
];

/** 单次统计/清理的**条目预算**：再大也只是一份缓存，扫不完就先给结论（面板不会转圈到死）。 */
const MAX_ENTRIES = 200000;

/** 与其它路由同一口径：`DSH_HOME` 优先，否则桌面端的 harness 目录。 */
function dshHome() {
  return process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
}

/**
 * Electron 的数据目录（`%APPDATA%\dsh-desktop`）。
 *
 * `DSH_FOLIA_ELECTRON_DIR` 是**测试注入点**（与 `DSH_FOLIA_CACHE_DIR` 同族口径）：判据要在
 * 一次性目录里造 Cache/GPUCache 再清，不能碰真机那份。生产环境不设它，永远是 APPDATA 下那个。
 */
function electronHome() {
  const raw = process.env.DSH_FOLIA_ELECTRON_DIR;
  if (typeof raw === 'string' && raw.trim()) return resolve(raw.trim());
  return join(process.env.APPDATA || homedir(), 'dsh-desktop');
}

/**
 * 皮肤根：**皮肤中心真正在用的那个目录**下的 `skins`。
 *
 * ⚠️ 这里与 `lib/routes/skins.js` 的 `skinCenterHome()` 是**同一个口径**（那边是安装/发现的
 * 真源）：`$DSH_HOME` 一旦设置就是唯一权威；没设时才看 `skin-center-active.json` 落在哪
 * （`~/.dsh` 与 harness 目录都可能是它）。两份实现必须同时改 —— 判据
 * `test/verify-cache-manager.mjs` 的 G 段直接比对两侧对同一个 HOME 的解析结果。
 */
function skinsRoot() {
  const home = dshHome();
  if (process.env.DSH_HOME) return join(home, 'skins');
  const candidates = [home, join(homedir(), '.dsh')];
  let best = { root: home, at: 0 };
  for (const root of candidates) {
    const at = (() => { try { return lstatSync(join(root, 'skin-center-active.json')).mtimeMs; } catch { return 0; } })();
    if (at > best.at) best = { root, at };
  }
  return join(best.root, 'skins');
}

/** 五个目标 → 目录（`electron` 是多目录，单独给 parts）。 */
function targetDirs() {
  const home = dshHome();
  return {
    library: join(home, 'library'),
    'site-media': join(home, 'cache', 'site-media'),
    'skins-zip': join(home, 'cache', 'skins-zip'),
    skins: skinsRoot(),
  };
}

/** 允许根：算出来的目录必须逐个落在其中某一个之下（否则拒绝）。 */
function allowedRoots() {
  return [dshHome(), electronHome()];
}

/**
 * `child` 是否在 `base` 之内（含相等）。**路径安全的第一道闸**：越界 ⇒ 不统计、不删除。
 * 用 `relative` 而不是字符串前缀：`C:\home2` 不是 `C:\home` 的子目录，前缀比较会判错。
 */
export function isWithin(base, child) {
  const b = resolve(String(base));
  const t = resolve(String(child));
  if (b === t) return true;
  const rel = relative(b, t);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 错误码归一（判据与日志都读它，不读栈）。 */
function reasonOf(err) {
  if (!err) return 'unknown';
  if (err.code) return String(err.code);
  return String(err.message || err);
}

/**
 * 删掉一条**链接本身**（绝不跟随）。
 *
 * POSIX 上目录软链用 `unlink`；Windows 的 junction 必须用 `rmdir`（`unlink` 会给 EPERM）。
 * 两者都只作用于链接节点，指向的目标不受影响 —— 这正是"禁止跟随符号链接"的落点。
 */
function removeLink(p) {
  try { unlinkSync(p); return null; } catch (err) {
    const code = reasonOf(err);
    if (code === 'EPERM' || code === 'EACCES' || code === 'EISDIR') {
      try { rmdirSync(p); return null; } catch (e2) { return reasonOf(e2); }
    }
    return code;
  }
}

/**
 * 统计一棵树的字节数与文件数（**不跟随符号链接**）。
 * @returns {{ exists: boolean, bytes: number, files: number, links: number, truncated: boolean }}
 */
export function scanTree(root) {
  const out = { exists: false, bytes: 0, files: 0, links: 0, truncated: false };
  let st;
  try { st = lstatSync(root); } catch { return out; }
  out.exists = true;
  // 根本身是链接 ⇒ 不跟（enclosing 的资产不在我们账上）。
  if (st.isSymbolicLink()) { out.links += 1; return out; }
  if (!st.isDirectory()) { out.files = 1; out.bytes = Number(st.size) || 0; return out; }
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of ents) {
      if (seen >= MAX_ENTRIES) { out.truncated = true; return out; }
      seen += 1;
      const p = join(dir, ent.name);
      let cst;
      try { cst = lstatSync(p); } catch { continue; }
      if (cst.isSymbolicLink()) { out.links += 1; continue; }
      if (cst.isDirectory()) { stack.push(p); continue; }
      if (cst.isFile()) { out.files += 1; out.bytes += Number(cst.size) || 0; }
    }
  }
  return out;
}

/**
 * 清掉一个目录里的**内容**（目录本身保留），返回 `{ files, bytes, failed }`。
 * 逐条 `lstat`：软链只 `unlink` 链接本身；目录先递归清空再 `rmdir`（失败 ⇒ 进 failed，不抛）。
 */
export function clearTree(root) {
  const out = { files: 0, bytes: 0, failed: [] };
  let st;
  try { st = lstatSync(root); } catch { return out; }          // 不存在 ⇒ 空操作
  if (st.isSymbolicLink()) { out.failed.push({ path: root, reason: 'refused-symlink' }); return out; }
  if (!st.isDirectory()) return out;
  removeChildren(root, out, { seen: 0 });
  return out;
}

/** `clearTree` 的递归体（顶层导出面只有 clearTree —— 判据不需要单测这一层）。 */
function removeChildren(dir, out, budget) {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); }
  catch (err) { out.failed.push({ path: dir, reason: reasonOf(err) }); return; }
  for (const ent of ents) {
    if (budget.seen >= MAX_ENTRIES) { out.failed.push({ path: dir, reason: 'entry-budget' }); return; }
    budget.seen += 1;
    const p = join(dir, ent.name);
    let cst;
    try { cst = lstatSync(p); } catch { continue; }            // 已经没了：不算失败
    if (cst.isSymbolicLink()) {
      // 只删链接本身：**绝不**跟随（删到外面就是越界写）。
      const bad = removeLink(p);
      if (bad) out.failed.push({ path: p, reason: bad });
      else out.files += 1;
      continue;
    }
    if (cst.isDirectory()) {
      removeChildren(p, out, budget);
      try { rmdirSync(p); } catch (err) { out.failed.push({ path: p, reason: reasonOf(err) }); }
      continue;
    }
    try {
      unlinkSync(p);
      out.files += 1;
      out.bytes += Number(cst.size) || 0;
    } catch (err) {
      // 被占用（Windows 上 EBUSY/EPERM 是常态：Electron 正在写自己的 Cache）⇒ 记下来，不中断。
      out.failed.push({ path: p, reason: reasonOf(err) });
    }
  }
}

/** 只读统计（`GET /cache/usage` 的纯计算面；导出是为了让判据能绕开 HTTP 直接对账）。 */
export function cacheUsage() {
  const dirs = targetDirs();
  const items = [];
  let totalBytes = 0;
  let totalFiles = 0;
  let truncated = false;
  for (const target of CACHE_TARGETS) {
    if (target === 'electron') continue;
    const dir = dirs[target];
    const within = allowedRoots().some((base) => isWithin(base, dir));
    const s = within ? scanTree(dir) : { exists: false, bytes: 0, files: 0, links: 0, truncated: false };
    if (s.truncated) truncated = true;
    items.push({ target, path: dir, exists: s.exists, bytes: s.bytes, files: s.files, links: s.links, within });
    totalBytes += s.bytes;
    totalFiles += s.files;
  }
  const eHome = electronHome();
  const parts = ELECTRON_PARTS.map(([name, rel]) => {
    const dir = join(eHome, rel);
    const s = scanTree(dir);
    if (s.truncated) truncated = true;
    return { name, path: dir, exists: s.exists, bytes: s.bytes, files: s.files };
  });
  const eBytes = parts.reduce((n, p) => n + p.bytes, 0);
  const eFiles = parts.reduce((n, p) => n + p.files, 0);
  items.push({ target: 'electron', path: eHome, exists: parts.some((p) => p.exists), bytes: eBytes, files: eFiles, links: 0, within: true, parts });
  totalBytes += eBytes;
  totalFiles += eFiles;
  return {
    ok: true,
    items,
    total: { bytes: totalBytes, files: totalFiles },
    truncated,
    at: Date.now(),
  };
}

/**
 * 摘掉 `downloads.json` 里**对应 kind 且已 done** 的记录，返回摘掉的条数。
 *
 * 只碰 `status === 'done'`：`running` / `queued` 不动（正在下的那条文件还在长，删了记录等于
 * 让它永远"看起来在等"）。文件读写失败一律静默（清缓存这条路不能因为状态文件而失败）。
 */
export function pruneDoneJobs(home, kinds) {
  const wanted = new Set(kinds.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean));
  if (!wanted.size) return 0;
  const statePath = join(home, 'downloads.json');
  let doc;
  try { doc = JSON.parse(readFileSync(statePath, 'utf8')); } catch { return 0; }
  if (!doc || !Array.isArray(doc.jobs)) return 0;
  const keep = [];
  let removed = 0;
  for (const job of doc.jobs) {
    if (!job || typeof job !== 'object') { keep.push(job); continue; }
    const kind = String(job.kind || '').trim().toLowerCase() || 'default';
    const done = String(job.status || '') === 'done';
    if (done && wanted.has(kind)) { removed += 1; continue; }
    keep.push(job);
  }
  if (!removed) return 0;
  try {
    doc.jobs = keep;
    writeFileSync(statePath, JSON.stringify(doc, null, 2));
  } catch { return 0; }
  return removed;
}

/**
 * `POST /cache/clear` 的纯计算面：`{ targets }` → `{ cleared, failed, removedJobs, warnings }`。
 * 导出给判据直接驱动（HTTP 层只做 method / body / 白名单校验）。
 */
export function clearCache(targets) {
  const dirs = targetDirs();
  const cleared = [];
  const failed = [];
  const warnings = [];
  let removedJobs = 0;
  for (const target of targets) {
    if (target === 'electron') {
      let bytes = 0;
      let files = 0;
      const eHome = electronHome();
      for (const [, rel] of ELECTRON_PARTS) {
        const dir = join(eHome, rel);
        if (!isWithin(eHome, dir)) { failed.push({ target, path: dir, reason: 'outside-allowed-root' }); continue; }
        const r = clearTree(dir);
        bytes += r.bytes;
        files += r.files;
        for (const f of r.failed) failed.push({ target, path: f.path, reason: f.reason });
      }
      cleared.push({ target, files, bytes });
      // 只有真的碰到占用才提示重启（否则是噪音）。占用 = 有文件没删掉。
      if (failed.some((f) => f.target === 'electron')) warnings.push('restart-dsh');
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(dirs, target)) {
      failed.push({ target, reason: 'unknown-target' });
      continue;
    }
    const dir = dirs[target];
    if (!allowedRoots().some((base) => isWithin(base, dir))) {
      failed.push({ target, reason: 'outside-allowed-root' });
      continue;
    }
    const r = clearTree(dir);
    for (const f of r.failed) failed.push({ target, path: f.path, reason: f.reason });
    cleared.push({ target, files: r.files, bytes: r.bytes });
    removedJobs += pruneDoneJobs(dshHome(), TARGET_KINDS[target] || []);
    if (target === 'skins') warnings.push('skins-uninstalled');
  }
  return { cleared, failed, removedJobs, warnings };
}

/** 注册两族（usage 只读 / clear 落盘）。 */
export function registerCacheRoutes(webServer, c) {
  const { disposers, base: BASE, log } = c;

  // 1. 用量（只读）：面板一进「系统」页签就拉一次；不建目录、不改盘，所以随便轮询。
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/cache/usage`,
    handler: (req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') { res.statusCode = 405; res.end('method not allowed'); return; }
      try {
        sendJson(res, 200, cacheUsage());
      } catch (err) {
        sendJson(res, 500, { ok: false, error: reasonOf(err) });
      }
    },
  }));

  // 2. 清理：body 只有 `{ targets: [...] }`。**任何路径形态都不是合法目标** —— 名字进白名单
  //    才往下走，路径由本模块自己算（安全边界见文件头）。
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/cache/clear`,
    handler: (req, res) => {
      const method = (req.method || 'POST').toUpperCase();
      if (method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return; }

      let tooLarge = false;
      const reader = bodyReader(req, {
        maxBytes: CONTROL_JSON_MAX_BYTES,
        onOverflow: () => {
          tooLarge = true;
          sendJson(res, 413, { error: 'payload too large' });
        },
      });
      req.on('data', reader.onData);

      req.on('end', async () => {
        if (tooLarge) return;
        let raw;
        try { raw = JSON.parse(reader.text() || '{}'); }
        catch { sendJson(res, 400, { error: '请求体不是合法 JSON' }); return; }
        const listed = Array.isArray(raw && raw.targets) ? raw.targets : [];
        if (!listed.length) {
          sendJson(res, 400, { error: '请至少指定一个清理目标（targets）' });
          return;
        }
        // 白名单是**整单**校验：有一个非法名字就整体 400，不"先清合法的再报错" ——
        // 半执行的结果最难解释，而清理是不可撤销的。
        const bad = listed.filter((t) => typeof t !== 'string' || !CACHE_TARGETS.includes(t));
        if (bad.length) {
          sendJson(res, 400, {
            error: '不支持的清理目标：' + bad.map((b) => String(b)).join('、'),
            allowed: CACHE_TARGETS.slice(),
          });
          return;
        }
        // 去重但保序：面板的"一键清理"与逐个点可能同时命中同一目标。
        const targets = [...new Set(listed)];
        let result;
        try {
          result = clearCache(targets);
        } catch (err) {
          sendJson(res, 500, { ok: false, error: reasonOf(err) });
          return;
        }
        const bytes = result.cleared.reduce((n, x) => n + x.bytes, 0);
        const files = result.cleared.reduce((n, x) => n + x.files, 0);
        /**
         * 4.23.19（D「清缓存入口自愈」，P0）：**删文件与重置记录必须是同一件事**。
         *
         * `pruneDoneJobs` 只摘 `downloads.json`，**内存队列单例仍是 done** ⇒ 用户「清空媒体」
         * 后点同一张 → 客户端以为已缓存 → `/local-media/<id>` 404 → `<video>` 报
         * SRC_NOT_SUPPORTED → 界面显示"无法解码"（用户正是按这个步骤踩到的）。
         *
         * 现在：① 把内存里这些 kind 的 done 记录同步成 pending；② 再跑一次对账（唯一状态模型）
         * 拿到统计并刷新状态缓存；③ 把**两个数字**都回给面板：`clearedFiles` / `resetJobs`。
         */
        const kinds = [...new Set(targets.flatMap((t) => TARGET_KINDS[t] || []))];
        const queueReset = resetQueuedDoneForKinds(kinds, { dropExpectation: true });
        let reconciled;
        try { reconciled = await reconcileMediaState({ reason: 'cache-clear', kinds }); } catch { reconciled = null; }
        /**
         * 4.24.0（P0-B）：**三段一致失效**的第三段 —— 清单缓存。
         *
         * 前两段（删文件 / 重置队列与对账器）4.23.19 就有了，但清单是**第三份状态**：
         *   · 内存 `foliaCache` + 落盘 `cache/site-items.json` 里写着 `localReady` / `mediaProxy`；
         *   · 客户端面板拿的是这份清单的**快照**（卡片角标读快照里的 `localReady`）。
         * 只清前两段 ⇒ 快照原样有效 ⇒ 角标继续显示「已缓存」，第一次点击仍去播已删掉的本地副本
         * ⇒ 404 ⇒「浏览器无法解码这段视频」。所以这里**必须**把清单一起失效（内存 + 磁盘），
         * 并把新代际写进回执（客户端据此决定重拉一次清单）。
         *
         * 只在清到 `library`（壁纸/开机动画/桌宠的成品）时才做：清站点媒体缓存/皮肤包不影响
         * 壁纸库的本地副本结论，白拉一次清单没有意义。
         */
        const invalidated = targets.includes('library')
          ? invalidateSiteCache('cache-clear')
          : null;
        const resetJobs = Number(queueReset) + Number(reconciled && reconciled.reset) || Number(queueReset);
        const clearedJobs = Math.max(result.removedJobs, resetJobs);
        if (typeof log === 'function') {
          try {
            log('cache clear: ' + targets.join(',') + ' → ' + files + ' 个文件 / '
              + Math.round(bytes / (1024 * 1024)) + ' MB，失败 ' + result.failed.length
              + '，摘除 done 记录 ' + result.removedJobs + '，内存队列重置 ' + queueReset
              + '，对账重置 ' + ((reconciled && reconciled.reset) || 0)
              + (invalidated ? '，清单缓存已失效（epoch=' + invalidated.epoch + '）' : ''));
          } catch { /* 日志失败不影响清理结论 */ }
        }
        sendJson(res, 200, {
          ok: result.failed.length === 0,
          partial: result.failed.length > 0,
          targets,
          cleared: result.cleared,
          failed: result.failed,
          removedJobs: result.removedJobs,
          // 4.23.19：面板显示「已清理 X 个文件 / 重置 Y 条下载记录」—— 两个数字同一事务产出。
          clearedFiles: files,
          resetJobs,
          clearedJobs,
          // 4.24.0：**清单缓存也失效了**（客户端据此强制重拉一次清单，角标立即变「未缓存」）。
          inventoryInvalidated: Boolean(invalidated),
          inventoryEpoch: inventoryEpoch(),
          inventoryCache: invalidated,
          mediaState: reconciled,
          warnings: result.warnings,
          released: { bytes, files },
          at: Date.now(),
        });
      });

      req.on('error', () => { res.statusCode = 400; res.end('request error'); });
    },
  }));
}
