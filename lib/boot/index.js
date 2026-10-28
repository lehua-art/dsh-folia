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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  return {
    enabled: raw.enabled === true,
    clipId: typeof raw.clipId === 'string' ? raw.clipId : '',
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
  cfg.boot = { ...cur, ...patch };
  writeFileSync(bootConfigPath(), JSON.stringify(cfg, null, 2) + '\n');
  return readBoot();
}

/** 允许的 id：目录名安全字符，防止拿它拼路径时被穿越。 */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i;
export function clipFile(id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const p = join(bootDir(), String(id) + '.mp4');
  return p;
}
export function clipExists(id) {
  const p = clipFile(id);
  return Boolean(p && existsSync(p) && statSync(p).size > 0);
}

/** 本地已装片段（只有 mp4；meta 里带标题等可选信息）。 */
export function listLocalClips() {
  const dir = bootDir();
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (extname(n).toLowerCase() !== '.mp4') continue;
    const id = n.slice(0, -4);
    const abs = join(dir, n);
    let bytes = 0;
    try { bytes = statSync(abs).size; } catch { continue; }
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')) || {}; } catch { /* 没 meta 也能用 */ }
    out.push({ id, bytes, title: meta.title || id, durationSec: meta.durationSec || null });
  }
  return out;
}

export function removeClip(id) {
  const p = clipFile(id);
  if (!p) return false;
  try { if (existsSync(p)) rmSync(p); } catch { return false; }
  try { const m = join(bootDir(), String(id) + '.json'); if (existsSync(m)) rmSync(m); } catch { /* ignore */ }
  return true;
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
    try { if (root) root.style.opacity = "0"; } catch (e) {}
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
      "transition:opacity " + (cfg.fadeMs || 900) + "ms ease;opacity:1;");
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
    if (!boot.enabled || !boot.clipId) return;
    if (!clipExists(boot.clipId)) return;   // 片段被删了：静默不注入，别让用户卡黑屏
    const cfg = {
      clip: '/folia/boot/clip?v=' + encodeURIComponent(boot.clipId),
      fadeMs: boot.fadeMs,
      minShowMs: boot.minShowMs,
      maxHoldMs: boot.maxHoldMs,
      enterMode: boot.enterMode,
      sound: boot.sound,
      volume: boot.volume,
    };
    table.push({ kind: 'script', placement: 'head', text: 'globalThis.__FOLIA_BOOT__=' + JSON.stringify(cfg) });
    table.push({ kind: 'script', placement: 'head', text: BOOT_SCREEN_SOURCE });
  });
}
