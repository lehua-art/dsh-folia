/**
 * boot/index.js — 开机动画的宿主半边：本地片段仓库 + 注入 + 屏幕脚本。
 *
 * 设计三条铁律（每条都对应一次真实教训）：
 *
 *  1. **关闭 = 什么都不注入**。不是"注入了再让脚本自己退出"—— 那等于整个东西还在跑。
 *  2. **启动路径上零网络**。片段必须已在本地（`~/.dsh-folia/boot/`），注入的内容是
 *     内联 JSON，启动时连一次请求都不发。
 *  3. **任何异常都必须放行**。注入的脚本顶层 try/catch，超时自毁，绝不把用户挡在门外。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

/** 本地片段目录（与 config.json 同一个数据根）。 */
export function bootHome() {
  const base = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return base;
}
export function bootDir() {
  const d = join(bootHome(), 'boot');
  try { if (!existsSync(d)) mkdirSync(d, { recursive: true }); } catch { /* 只读盘：后续写入会失败并如实报错 */ }
  return d;
}
export function bootConfigPath() {
  return join(bootHome(), 'config.json');
}

/** 读整个 config.json（失败返回空对象，绝不抛）。 */
function readConfig() {
  try {
    return JSON.parse(readFileSync(bootConfigPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

/**
 * 读写 boot 段。**只碰 `boot` 这一个键** —— 壁纸那边的设置一个字都不能动。
 * 默认值就是"没有开机动画"：enabled=false、clipId 空。这正是首次安装时的期望状态。
 */
export function readBoot() {
  const cfg = readConfig();
  const raw = cfg && typeof cfg.boot === 'object' && cfg.boot ? cfg.boot : {};
  // 素材池：items 是 id 数组；旧配置只有 clipId ⇒ 自动包成单条池（向后兼容）
  const rawItems = Array.isArray(raw.items) ? raw.items.filter((x) => typeof x === 'string' && x) : [];
  const legacyId = typeof raw.clipId === 'string' ? raw.clipId : '';
  const items = rawItems.length ? rawItems : (legacyId ? [legacyId] : []);
  return {
    enabled: raw.enabled === true,
    clipId: legacyId || (items[0] || ''),
    items,
    // 素材池取片方式：first=固定第一条；random=随机；rotate=按启动次数轮换
    poolMode: ['first', 'random', 'rotate'].includes(String(raw.poolMode)) ? String(raw.poolMode) : 'first',
    // 退场转场：fade（默认，只透明度）/ scale（轻微放大）/ slide（上滑）
    transition: ['fade', 'scale', 'slide'].includes(String(raw.transition)) ? String(raw.transition) : 'fade',
    // 两幕冷启动：第一幕是纯色 + 一行字（固定标识），第二幕才是素材
    act1: (() => {
      const a = raw.act1 && typeof raw.act1 === 'object' ? raw.act1 : {};
      return {
        enabled: a.enabled === true,
        text: typeof a.text === 'string' ? a.text.slice(0, 60) : '',
        durationMs: Number.isFinite(Number(a.durationMs)) ? Math.min(5000, Math.max(300, Number(a.durationMs))) : 1200,
      };
    })(),
    // 进入方式：tail = 播完再进（默认）；ready = 应用就绪就进；click = 点一下才进。
    // 之前没有这个字段，一律「就绪即进」，于是 8~15 秒的片子 1.2 秒就被掐掉。
    enterMode: ['tail', 'ready', 'click'].includes(String(raw.enterMode)) ? String(raw.enterMode) : 'tail',
    fadeMs: Number.isFinite(Number(raw.fadeMs)) ? Math.min(3000, Math.max(200, Number(raw.fadeMs))) : 900,
    minShowMs: Number.isFinite(Number(raw.minShowMs)) ? Math.min(5000, Math.max(0, Number(raw.minShowMs))) : 1200,
    // 最长停留：安全上限，不是「正常退出点」。默认 20 秒，足够一集 15 秒的片子播完。
    maxHoldMs: Number.isFinite(Number(raw.maxHoldMs)) ? Math.min(60000, Math.max(3000, Number(raw.maxHoldMs))) : 20000,
    sound: raw.sound === true,
    // 音量 0~1。带声音自动播放会被浏览器策略拦，所以 `sound` 默认关；
    // 打开后脚本先试带声音，被拦就退回静音重试一次（画面优先，绝不黑屏）。
    volume: Number.isFinite(Number(raw.volume)) ? Math.min(1, Math.max(0, Number(raw.volume))) : 1,
  };
}

export function writeBoot(patch) {
  const cfg = readConfig();
  const cur = cfg && typeof cfg.boot === 'object' && cfg.boot ? cfg.boot : {};
  const next = { ...cur, ...patch };
  // items 与 clipId 保持一致：写 items 时把 clipId 定成第一条（旧读路径仍能工作）
  if (Array.isArray(next.items)) {
    next.items = next.items.filter((x) => typeof x === 'string' && x);
    if (next.items.length) next.clipId = next.items[0];
    else if (typeof next.clipId === 'string' && next.clipId) next.items = [next.clipId];
  } else if (typeof next.clipId === 'string' && next.clipId) {
    next.items = [next.clipId];
  }
  cfg.boot = next;
  writeFileSync(bootConfigPath(), JSON.stringify(cfg, null, 2) + '\n');
  return readBoot();
}

/**
 * id → **磁盘文件名**：ASCII 化 + 短哈希。
 *
 * 为什么不再拿 id 直接当文件名：站点上的 slug 允许中文（实测有一条叫「痘印」），
 * 而严格的正则把它判成非法 ⇒ 用户点下载永远是 `bad-id`。id 可以任意宽容，
 * **文件名必须安全** —— 这两件事不该绑在一起。
 *
 * 规则：非 `[a-zA-Z0-9._-]` 一律折成 `-`，再拼 8 位 sha1 前缀，保证
 *   · 永远不会出现路径分隔符 / `..` / 控制字符；
 *   · 不同 id 即使折成同一个 ASCII 名也不会互相覆盖；
 *   · 原始 id 存在同名 `.json` 里，列表读回来还是原来那个。
 */
function clipStem(id) {
  const raw = String(id || '');
  const ascii = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'clip';
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return ascii + '-' + hash;
}
/** 片段文件。id 可以是任意字符串（含中文），只有磁盘名会被 ASCII 化。 */
export function clipFile(id) {
  if (!String(id || '')) return null;
  return join(bootDir(), clipStem(id) + '.mp4');
}
/** 片段元数据文件（存原始 id / 标题 / 时长）。 */
export function clipMetaFile(id) {
  if (!String(id || '')) return null;
  return join(bootDir(), clipStem(id) + '.json');
}
/** 旧命名规则下的路径：`<id>.mp4`（id 当年被限制成 ASCII 安全字符，所以能直接用）。 */
function legacyClipFile(id) {
  const raw = String(id || '');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(raw)) return null;
  return join(bootDir(), raw + '.mp4');
}

/**
 * 找出这个 id 实际对应的片段文件。
 *
 * 为什么需要"找"而不是直接算：4.0.2 把磁盘命名从 `<id>.mp4` 改成了
 * `<id>-<hash>.mp4`（为了支持中文 slug），于是**升级前下载的片段**还叫旧名字。
 * 列表是按文件名枚举的，所以旧文件看得见；可点「使用」时按新名字找不到 ⇒ `not-installed`。
 * 这里按"新名字 → 旧名字"的顺序找，找到旧名字就**顺手迁移**成新名字（幂等）。
 */
export function resolveClipFile(id) {
  const next = clipFile(id);
  if (next && existsSync(next) && statSync(next).size > 0) return next;
  const legacy = legacyClipFile(id);
  if (legacy && existsSync(legacy) && statSync(legacy).size > 0) {
    try {
      if (next && !existsSync(next)) writeFileSync(next, readFileSync(legacy));
      try { renameSync(legacy, next); } catch { /* 跨盘/占用：复制已经够用，旧文件留着无害 */ }
      try { rmSync(legacy); } catch { /* ignore */ }
      const metaPath = clipMetaFile(id);
      if (metaPath && !existsSync(metaPath)) {
        writeFileSync(metaPath, JSON.stringify({ id, migratedFrom: 'legacy' }, null, 2) + '\n');
      }
    } catch { /* 迁移失败也不影响这次使用 */ }
    return next || legacy;
  }
  return next;
}

export function clipExists(id) {
  const p = resolveClipFile(id);
  return Boolean(p && existsSync(p) && statSync(p).size > 0);
}

/** 本地已装片段（只有 mp4；meta 里带标题等可选信息）。 */
export function listLocalClips() {
  const dir = bootDir();
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  // 以 `.json` 为主：里面有**原始 id**（可能是中文），文件名只是它的 ASCII 代理。
  const stems = new Set();
  for (const n of names) {
    if (extname(n).toLowerCase() === '.json') stems.add(n.slice(0, -5));
    if (extname(n).toLowerCase() === '.mp4') stems.add(n.slice(0, -4));
  }
  for (const stem of stems) {
    const abs = join(dir, stem + '.mp4');
    if (!existsSync(abs)) continue;
    let bytes = 0;
    try { bytes = statSync(abs).size; } catch { continue; }
    if (bytes <= 0) continue;
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dir, stem + '.json'), 'utf8')) || {}; } catch { /* 没 meta 也能用 */ }
    const id = String(meta.id || stem);
    out.push({
      id, bytes, title: meta.title || id, durationSec: meta.durationSec || null,
      // 来源：站点下载的 meta 里有 url/sha256；本地导入的 meta.source='local'
      source: meta.source === 'local' ? 'local' : 'site',
    });
  }
  return out;
}

export function removeClip(id) {
  const paths = [clipFile(id), legacyClipFile(id)].filter(Boolean);
  let removed = false;
  for (const p of paths) {
    try { if (existsSync(p)) { rmSync(p); removed = true; } } catch { /* 继续尝试下一个 */ }
  }
  try { const m = clipMetaFile(id); if (m && existsSync(m)) rmSync(m); } catch { /* ignore */ }
  return removed || true;
}

/* ── 注入的启动屏幕脚本 ─────────────────────────────────────────────────────
 * 纯 ES5 风格、零依赖、自包含。为什么不用模块：它在 `<head>` 里同步执行，
 * 早于应用外壳，任何 import/await 都会让它晚一拍（那就会先闪一下界面）。
 */
export const BOOT_SCREEN_SOURCE = String.raw`
(function () {
  var cfg = globalThis.__FOLIA_BOOT__;
  if (!cfg || !cfg.clip) return;
  var doc = document;
  var root = null;
  var video = null;
  var done = false;

  function teardown() {
    if (done) return;
    done = true;
    // 退场转场：CSS transition 已在 root 上声明；这里只改目标样式
    try {
      if (root) {
        root.style.opacity = "0";
        if (cfg.transition === "scale") root.style.transform = "scale(1.06)";
        else if (cfg.transition === "slide") root.style.transform = "translateY(-8%)";
      }
    } catch (e) {}
    setTimeout(function () {
      try { if (video) { video.pause(); video.removeAttribute("src"); video.load && video.load(); } } catch (e) {}
      try { if (root && root.parentNode) root.parentNode.removeChild(root); } catch (e) {}
    }, (cfg.fadeMs || 900) + 60);
  }

  try {
    root = doc.createElement("div");
    root.id = "__folia_boot";
    root.setAttribute("style",
      "position:fixed;inset:0;z-index:2147483647;background:#000;" +
      "display:flex;align-items:center;justify-content:center;" +
      "transition:opacity " + (cfg.fadeMs || 900) + "ms ease,transform " + (cfg.fadeMs || 900) + "ms ease;opacity:1;transform:none;");
    video = doc.createElement("video");
    video.setAttribute("muted", "");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("style", "width:100%;height:100%;object-fit:cover;");
    video.src = cfg.clip;
    // 解码失败 / 文件不在：立刻放行，绝不留黑屏。
    video.addEventListener("error", teardown, { once: true });
    root.appendChild(video);
    (doc.body || doc.documentElement).appendChild(root);
    // 两幕冷启动：第一幕是纯色 + 一行字，盖在素材上；到时淡出露出第二幕
    try {
      if (cfg.act1 && cfg.act1.enabled) {
        var act1 = doc.createElement("div");
        act1.setAttribute("style",
          "position:absolute;inset:0;background:#000;display:flex;align-items:center;justify-content:center;" +
          "color:#fff;font-size:28px;letter-spacing:2px;transition:opacity 500ms ease;opacity:1;");
        act1.textContent = cfg.act1.text || "";
        root.appendChild(act1);
        setTimeout(function () {
          try { act1.style.opacity = "0"; } catch (e) {}
          setTimeout(function () { try { if (act1.parentNode) act1.parentNode.removeChild(act1); } catch (e) {} }, 520);
        }, Math.max(300, (cfg.act1.durationMs || 1200)));
      }
    } catch (e) {}
    // 声音：只有用户显式开启才带声；否则静音（否则 Chromium 直接拒绝自动播放）。
    try {
      if (cfg.sound) { video.muted = false; video.volume = (typeof cfg.volume === "number" ? cfg.volume : 1); }
      else { video.muted = true; }
    } catch (e) {}
    var p = video.play();
    if (p && typeof p.catch === "function") {
      p.catch(function () {
        // 带声音被自动播放策略拦住了：退回静音再试一次 —— 画面先出来最重要。
        try {
          video.muted = true;
          var p2 = video.play();
          if (p2 && typeof p2.catch === "function") p2.catch(function () { teardown(); });
        } catch (e) { teardown(); }
      });
    }
  } catch (e) {
    teardown();
    return;
  }

  // 退场时机由 enterMode 决定：
  //   tail  播完再进（默认）—— 视频 ended 即退场，真正把片子看完
  //   ready 应用就绪就进   —— 原来那套（1.2 秒左右就掐掉，短、但看不到片尾）
  //   click 点一下才进     —— 仪式感
  // maxHoldMs 是安全上限（默认 20 秒），任何模式下到点必退，防止卡死。
  var mode = cfg.enterMode || "tail";
  var t0 = Date.now();
  var ended = false;
  try { video.addEventListener("ended", function () { ended = true; }); } catch (e) {}

  var timer = setInterval(function () {
    var elapsed = Date.now() - t0;
    if (elapsed >= (cfg.maxHoldMs || 20000)) { clearInterval(timer); teardown(); return; }
    if (mode === "click") return;
    if (mode === "tail") {
      // 播完即退；再等 minShowMs 一拍，避免极短片「闪一下」。
      if (ended && elapsed >= (cfg.minShowMs || 0)) { clearInterval(timer); teardown(); }
      return;
    }
    // ready：应用就绪 且 已显示够 minShowMs
    var host = doc.querySelector("#root");
    var ready = !!(host && host.children && host.children.length > 0);
    if (ready && elapsed >= (cfg.minShowMs || 1200)) { clearInterval(timer); teardown(); }
  }, 120);

  // 硬兜底：即使上面的判定因为任何原因没跑（异常、被替换），也在 maxHold+2s 后消失。
  setTimeout(function () { try { clearInterval(timer); } catch (e) {} teardown(); }, (cfg.maxHoldMs || 20000) + 2000);

  // 用户放行：点击 / Esc / 空格。
  try {
    root.addEventListener("click", teardown, { once: true });
    doc.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || e.key === " ") teardown();
    }, { once: true });
  } catch (e) {}
})();
`;

/** 素材池状态文件（轮换计数；与 config.json 分开，避免每次启动都改配置）。 */
function poolStatePath() { return join(bootHome(), 'boot-pool.json'); }
function readPoolState() {
  try { return JSON.parse(readFileSync(poolStatePath(), 'utf8')) || {}; } catch { return {}; }
}
function writePoolState(next) {
  try { writeFileSync(poolStatePath(), JSON.stringify(next, null, 2) + '\n'); } catch { /* 只读盘：轮换退化成固定第一条 */ }
}

/**
 * 按 poolMode 从素材池里挑一条；只挑**本地真的存在**的（缺文件不能注入，否则黑屏）。
 * return null ⇒ 一条可用的都没有，调用方直接不注入。
 */
export function pickClipForBoot(boot) {
  const items = Array.isArray(boot && boot.items) ? boot.items.filter((id) => id && clipExists(id)) : [];
  if (!items.length) return null;
  const mode = (boot && boot.poolMode) || 'first';
  if (mode === 'random') return items[Math.floor(Math.random() * items.length)];
  if (mode === 'rotate') {
    const state = readPoolState();
    const next = (Number(state.index) || 0) % items.length;
    writePoolState({ index: next + 1 });
    return items[next];
  }
  return items[0];
}

/**
 * 导入一条本地动画（mp4/webm）。只写 `$DSH_HOME/boot/`，不碰站点、不联网。
 * 校验：文件头必须像视频（ftyp/EBML）、大小 ≤ CLIP_MAX_BYTES、目录固定。
 * @returns {{ok:true,id:string,bytes:number}|{ok:false,error:string}}
 */
export function importLocalClip(buffer, options = {}) {
  const max = Number(options.maxBytes) || 64 * 1024 * 1024;
  if (!buffer || !buffer.length) return { ok: false, error: 'empty' };
  if (buffer.length > max) return { ok: false, error: 'too-large' };
  const head = buffer.subarray(0, 12);
  const isMp4 = head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp';
  const isWebm = head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  if (!isMp4 && !isWebm) return { ok: false, error: 'not-a-video' };
  const title = String(options.title || '').trim() || '本地导入';
  const id = 'local-' + createHash('sha256').update(buffer).digest('hex').slice(0, 12);
  const dest = clipFile(id);
  try {
    writeFileSync(dest, buffer);
    writeFileSync(clipMetaFile(id), JSON.stringify({
      id, title, source: 'local', bytes: buffer.length,
      mime: isMp4 ? 'video/mp4' : 'video/webm', importedAt: Date.now(),
    }, null, 2) + '\n');
  } catch (error) {
    try { rmSync(dest, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: String((error && error.message) || error) };
  }
  return { ok: true, id, bytes: buffer.length, title };
}
/**
 * 装注入。**订阅在 apply() 里做一次**，每次 index 渲染时按当前配置决定注不注。
 *
 * @param {any} ctx cordis 上下文
 * @param {(msg: string) => void} note 日志
 */
export function installBootInjection(ctx, note) {
  if (!ctx || typeof ctx.on !== 'function') {
    note('[boot] 这个宿主没有 webserver/index-inject 事件，开机动画不可用');
    return;
  }
  ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return;
    const boot = readBoot();
    // 关 = 一行都不注入（不是"注入了再自己退出"）。
    if (!boot.enabled) return;
    // 素材池取片：按 poolMode 从 items 里挑一条本地真的存在的；一条都没有就不注入。
    const picked = pickClipForBoot(boot);
    if (!picked) return;   // 片段被删了：静默不注入，别让用户卡黑屏
    const cfg = {
      clip: '/folia/boot/clip?v=' + encodeURIComponent(picked),
      fadeMs: boot.fadeMs,
      minShowMs: boot.minShowMs,
      maxHoldMs: boot.maxHoldMs,
      enterMode: boot.enterMode,
      sound: boot.sound,
      transition: boot.transition,
      act1: boot.act1,
      volume: boot.volume,
    };
    table.push({ kind: 'script', placement: 'head', text: 'globalThis.__FOLIA_BOOT__=' + JSON.stringify(cfg) });
    table.push({ kind: 'script', placement: 'head', text: BOOT_SCREEN_SOURCE });
  });
}
