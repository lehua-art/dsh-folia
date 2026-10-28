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
    fadeMs: Number.isFinite(Number(raw.fadeMs)) ? Math.min(3000, Math.max(200, Number(raw.fadeMs))) : 900,
    minShowMs: Number.isFinite(Number(raw.minShowMs)) ? Math.min(5000, Math.max(0, Number(raw.minShowMs))) : 1200,
    maxHoldMs: Number.isFinite(Number(raw.maxHoldMs)) ? Math.min(30000, Math.max(2000, Number(raw.maxHoldMs))) : 6000,
    sound: raw.sound === true,
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
    var p = video.play();
    if (p && typeof p.catch === "function") p.catch(function () { teardown(); });
  } catch (e) {
    teardown();
    return;
  }

  // 应用就绪判定：#root 有子节点即认为外壳已画出。配合 minShowMs 防止"闪一下"，
  // 配合 maxHoldMs 防止慢机器上把启动拖长。
  var t0 = Date.now();
  var timer = setInterval(function () {
    var host = doc.querySelector("#root");
    var ready = !!(host && host.children && host.children.length > 0);
    var elapsed = Date.now() - t0;
    if ((ready && elapsed >= (cfg.minShowMs || 1200)) || elapsed >= (cfg.maxHoldMs || 6000)) {
      clearInterval(timer);
      teardown();
    }
  }, 120);

  // 硬兜底：即使上面的判定因为任何原因没跑（异常、被替换），也在 maxHold+2s 后消失。
  setTimeout(function () { try { clearInterval(timer); } catch (e) {} teardown(); }, (cfg.maxHoldMs || 6000) + 2000);

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
      sound: boot.sound,
    };
    table.push({ kind: 'script', placement: 'head', text: 'globalThis.__FOLIA_BOOT__=' + JSON.stringify(cfg) });
    table.push({ kind: 'script', placement: 'head', text: BOOT_SCREEN_SOURCE });
  });
}
