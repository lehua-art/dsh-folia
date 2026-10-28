/**
 * panel-tabs-skins.js — 「皮肤包」页签：从**自建站**列皮肤包 → 下载 → 装到本地 → 激活。
 *
 * 为什么是一个**真正的 React 组件**（而不是像别的页签那样是纯渲染函数）：
 * 这个页签有自己的异步状态（列表 / 加载中 / 下载中 / 错误），而页签渲染器是在
 * `renderActiveTab` 里被**条件调用**的普通函数 —— 在里面放 hooks 会违反 hooks 顺序。
 * 所以这里导出一个组件 `SkinsTabPanel`，由薄包装 `renderSkinsTab(ctx)` 挂上去：
 * 组件实例化后 hooks 是稳定的，父级重渲染也不会错位。
 *
 * 契约与别的 `panel-tabs-*.js` 相同：构建期被内联进 bundle 的工厂作用域，
 * 因此 `React` / `apiUrl` / `apiJson` / `apiPostJson` / `weT` 都是同作用域的既有名字，
 * 本文件**不 import 任何东西**。
 *
 * 数据流（全部走宿主端，浏览器不直连站点）：
 *   apiJson("/skins")                     → 索引 + 已装/在用标记
 *   apiPostJson("/skins/install", {id})   → 下载 / 校验 / 解压
 *   apiPostJson("/skins/activate", {id})  → 写 skin-center-active.json
 *   apiPostJson("/skins/remove", {id})    → 删目录
 *   apiUrl("/skins/preview?p=…")          → 预览图代理
 */

/** 卡片网格与卡片本体的样式：内联，避免为一个页签去动全局样式表。 */
const SKINS_STYLE = {
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))",
    gap: "10px",
    marginTop: "10px",
  },
  card: {
    display: "flex", flexDirection: "column", overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px",
    background: "rgba(255,255,255,0.04)",
  },
  thumb: { width: "100%", aspectRatio: "4 / 3", objectFit: "cover", display: "block", background: "rgba(0,0,0,0.35)" },
  body: { padding: "8px 9px 9px", display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto" },
  title: { fontSize: "12.5px", fontWeight: 600, lineHeight: 1.3 },
  meta: { fontSize: "11px", opacity: 0.62, lineHeight: 1.3 },
  tags: { display: "flex", flexWrap: "wrap", gap: "3px", marginTop: "2px" },
  tag: { fontSize: "10px", padding: "1px 5px", borderRadius: "999px", background: "rgba(255,255,255,0.09)", opacity: 0.75 },
  actions: { display: "flex", gap: "6px", marginTop: "6px" },
};

function skinsFmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  if (v >= 1024) return Math.round(v / 1024) + " KB";
  return v + " B";
}

function skinsErrText(code) {
  if (!code) return "";
  if (code === "disabled") return weT("站点数据源已关闭（DSH_FOLIA_SKINS_SITE=off）");
  if (code === "timeout") return weT("站点超时，点「刷新」重试");
  if (code === "tls") return weT("站点证书校验失败");
  if (code === "network") return weT("连不上站点（网络或域名问题）");
  if (/^http-/.test(code)) return weT("站点返回错误：") + code.slice(5);
  if (code === "json") return weT("站点索引格式不对");
  return code;
}

/**
 * 取一套皮肤**最终该用的 CSS**。
 *
 * 关键：皮肤中心不是把皮肤目录里的 CSS 原样发出去的 ——
 *   `GET /api/skin-center/v2/skins/<id>/stylesheet` → `transformSkinCss()`：**强制作用域化**
 *   `GET /api/skin-center/v2/skins/<id>/patches`    → 同上（无则 404）
 * 作用域化 = 把每条规则包进 `html[data-dsh-skin="<id>"]`。这一步直接决定成败：
 * **包了作用域的规则特异性更高**，才压得过应用自身的面板/令牌规则。我们早先注入的是
 * 目录里的裸 CSS，特异性与应用同级 ⇒ 大量规则输掉 ⇒ 配色变了一点、面板依旧不透明。
 *
 * 所以优先**直接用它加工好的那份**（同源，浏览器自带凭证）；只有拿不到才退回我们自己的
 * `/folia/skins/css`（未作用域化，能变配色但压不住应用规则）。
 *
 * @returns {Promise<{ css: string, source: string }>}
 */
async function fetchSkinCss(id) {
  const enc = encodeURIComponent(id);
  const origin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
  const parts = [];
  let source = "";
  for (const part of ["stylesheet", "patches"]) {
    try {
      const r = await apiFetch(origin + "/api/skin-center/v2/skins/" + enc + "/" + part, {
        parse: false,
        cache: "no-store",
      });
      if (r && r.ok && r.response) {
        const text = await r.response.text();
        if (text && text.trim()) {
          parts.push(text);
          source = "skin-center";
        }
      }
    } catch { /* 拿不到就试下一段 / 退回自己的路由 */ }
  }
  if (parts.length > 0) return { css: parts.join("\n/* ---- patches ---- */\n"), source };
  const r2 = await apiFetch("/skins/css?id=" + enc + "&t=" + Date.now(), { parse: false, cache: "no-store" });
  if (!r2 || !r2.ok || !r2.response) throw new Error("css-http-" + ((r2 && r2.status) || 0));
  const text = await r2.response.text();
  if (!text || !text.trim()) throw new Error("css-empty");
  return { css: text, source: "folia-raw" };
}

/**
 * 把一套皮肤的样式**当场**挂进文档。
 *
 * 用 `<style>` 而不是 `<link>`：`<style>` 一赋值就参与样式计算，且追加到 `<body>` 末尾
 * ⇒ 文档顺序最后、同等特异性下后写的赢；`<link>` 是异步的，顺序不由我们定。
 *
 * @param {string} id 皮肤 id
 * @returns {Promise<{ bytes: number, rules: number, source: string }>}
 */
async function applySkinCss(id) {
  const { css, source } = await fetchSkinCss(id);
  let el = document.getElementById("folia-skin-hot");
  if (!el) {
    el = document.createElement("style");
    el.id = "folia-skin-hot";
    (document.body || document.head).appendChild(el);
  }
  el.textContent = css;
  let rules = 0;
  try { rules = (el.sheet && el.sheet.cssRules && el.sheet.cssRules.length) || 0; } catch { /* 读不到就报 0 */ }
  return { bytes: css.length, rules, source };
}

/**
 * 搭出皮肤的**背景层**：`body > [data-dsh-skin-layer="background"]`，z-index -2，
 * 里面放 `<video>`/`<img>`（object-fit: cover）+ 一层 scrim 渐变。
 *
 * 为什么必须自己搭：背景不在 CSS 里，而是 `contributes.backgroundMedia`；皮肤中心只在
 * 启动时建这个元素。热切换时没人建 ⇒ 只剩下配色变了、背景还是一片空 ——
 * 用户看到的"水墨丹青没有背景动画"就是这个（它是一段 21 MB 的循环视频）。
 * 元素契约（z-index -2、媒体作直接子元素）从各皮肤 CSS 反推：
 * `future-window` 写 `[data-dsh-skin-layer="background"] > img`，
 * `ice-princess` 的注释直接写明"挂在 z-index -2 这层上"。
 *
 * @param {string} id 皮肤 id
 * @returns {Promise<{ kind: string }>}
 */
async function applySkinBackground(id) {
  const resp = await apiJson("/skins/manifest?id=" + encodeURIComponent(id));
  const doc = (resp && resp.data) || null;
  const media = doc && doc.backgroundMedia;
  let dark = false;
  try { dark = Boolean(document.body && document.body.hasAttribute("data-ds-dark-theme")); } catch { /* 取不到按浅色 */ }
  const pick = media ? (dark ? (media.dark || media.light) : (media.light || media.dark)) : null;

  const existing = document.querySelector('[data-dsh-skin-layer="background"]');
  if (!pick || !pick.url) {
    // 这套皮肤没有背景媒体：把上一次留下的层清掉，别串味。
    if (existing) existing.remove();
    return { kind: "none" };
  }

  let layer = existing;
  if (!layer) {
    layer = document.createElement("div");
    layer.setAttribute("data-dsh-skin-layer", "background");
    layer.style.cssText = "position:fixed;inset:0;z-index:-2;pointer-events:none;overflow:hidden;";
    (document.body || document.documentElement).insertBefore(layer, document.body.firstChild);
  }
  layer.innerHTML = "";

  let el;
  if (pick.type === "video") {
    el = document.createElement("video");
    el.autoplay = true;
    el.muted = true;
    el.loop = true;
    el.setAttribute("muted", "");
    el.setAttribute("playsinline", "");
    el.setAttribute("autoplay", "");
    el.setAttribute("loop", "");
  } else {
    el = document.createElement("img");
    el.alt = "";
    el.setAttribute("draggable", "false");
  }
  el.src = pick.url;
  // 皮肤 CSS 通过 `> img` / `> video` 选中它 ⇒ 必须是**直接子元素**。
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;";
  layer.appendChild(el);

  if (pick.scrim) {
    const scrim = document.createElement("div");
    scrim.style.cssText = "position:absolute;inset:0;pointer-events:none;background:" + pick.scrim + ";";
    layer.appendChild(scrim);
  }

  if (pick.type === "video") {
    const kick = () => { try { const p = el.play(); if (p && typeof p.catch === "function") p.catch(() => {}); } catch { /* 自动播放被拒就静帧 */ } };
    el.addEventListener("loadeddata", kick, { once: true });
    kick();
  }
  return { kind: pick.type };
}

/* ── 热切换运行时：作用域属性 + 六个装饰层 + hooks ───────────────────────────────
 *
 * 皮肤不是"一份 CSS"。它有三层，缺一层就"显示不全"：
 *   ① 样式：`stylesheet` + `patches`
 *   ② 背景：`contributes.backgroundMedia`
 *   ③ 作用域与装饰层：`html[data-dsh-skin="<id>"]` + 六个 `[data-dsh-skin-layer=...]`
 *
 * 第 ③ 项是"大部分皮肤看起来没生效"的真正原因 —— 65 套里有 **30 套**把规则整段挂在
 * `html[data-dsh-skin]` 下面，属性不设，那些规则一条都不匹配；另有 **28 套**带
 * `hooks.mjs`（粒子/交互），契约见皮肤中心 `contracts/hooks-api.d.ts`：
 *   apply({ skinId, scopeAttr, assetBase, layers{...}, theme{get,subscribe}, onCleanup })
 * 所以这里补齐作用域属性、六个层，并按契约跑 hooks（失败只降级）。
 */

const SKIN_LAYER_NAMES = ["background", "ambient", "bottom", "sidebar", "top", "foreground"];
/**
 * 六层的**精确**样式：逐字对齐皮肤中心 `runtime/decoration-layers.ts` 的 `LAYER_STYLE`。
 *
 * 不能自己拍脑袋定层级 —— 它的注释写明了为什么：
 *   · background 用 **-2**：负 z-index 元素画在 html/body 背景**之上**（皮肤自己的
 *     不透明底色因此在画后面、艺术图在它前面），但**在所有面板之下**；
 *   · ambient 30、top/bottom/sidebar 40、foreground 41：压在面板之上、官方浮层
 *     （>=1000）之下。之前我把非背景层留成 auto ⇒ 装饰条落进文档流最底层，
 *     表现正是"上面被面板盖住、只有下面露出背景"。
 */
const SKIN_LAYER_STYLE = {
  background: "position:fixed;top:0;right:0;bottom:0;left:0;z-index:-2;pointer-events:none;will-change:transform;",
  ambient: "position:fixed;top:0;right:0;bottom:0;left:0;z-index:30;pointer-events:none;",
  top: "position:fixed;top:0;left:0;right:0;z-index:40;pointer-events:none;",
  bottom: "position:fixed;bottom:0;left:0;right:0;z-index:40;pointer-events:none;",
  sidebar: "position:fixed;top:0;bottom:0;left:0;z-index:40;pointer-events:none;",
  foreground: "position:fixed;top:0;right:0;bottom:0;left:0;z-index:41;pointer-events:none;",
};
/** 本次激活注册的清理函数（切换皮肤时逐个跑掉，幂等）。 */
let skinHotCleanups = [];

function skinThemeNow() {
  try {
    return (document.body && document.body.hasAttribute("data-ds-dark-theme")) ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** 建立/复用六个装饰层，返回契约里那个 `layers` 对象。 */
function ensureSkinLayers() {
  const host = document.body || document.documentElement;
  const out = {};
  for (const name of SKIN_LAYER_NAMES) {
    let el = null;
    try { el = document.querySelector('[data-dsh-skin-layer="' + name + '"]'); } catch { el = null; }
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("data-dsh-skin-layer", name);
      el.setAttribute("aria-hidden", "true");
      host.appendChild(el);
    }
    // 与它的 ensureOne 同口径：**每次都对已有层重写样式** —— 皮肤中心的层可能带着
    // 上一次激活留下的内联覆盖，只建不改会继承脏值。
    el.style.cssText = SKIN_LAYER_STYLE[name];
    out[name] = el;
  }
  // 皮肤中心自己会给 body 盖 `data-dsh-skin-center`（它的若干基础样式挂在这个前缀下），
  // 缺了它，面板/列表那些"表面透明"的规则不生效 → 大片面板仍然不透明。
  try { document.body.setAttribute("data-dsh-skin-center", ""); } catch { /* ignore */ }
  return out;
}

/**
 * 按契约跑一套皮肤的 hooks。失败**只降级**（返回原因），绝不打断样式/背景。
 * @returns {Promise<{ ran: boolean, reason?: string }>}
 */
async function applySkinHooks(id) {
  const resp = await apiJson("/skins/manifest?id=" + encodeURIComponent(id));
  const doc = (resp && resp.data) || null;
  const rel = doc && doc.hooks;
  if (!rel) return { ran: false, reason: "no-hooks" };

  const encoded = String(rel).split("/").map(encodeURIComponent).join("/");
  const r = await apiFetch("/skins/files/" + encodeURIComponent(id) + "/" + encoded, {
    parse: false,
    cache: "no-store",
  });
  if (!r || !r.ok || !r.response) return { ran: false, reason: "hooks-http-" + ((r && r.status) || 0) };
  const source = await r.response.text();
  if (!source || !source.trim()) return { ran: false, reason: "hooks-empty" };

  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const mod = await import(blobUrl);
    const factory = mod && typeof mod.default === "function" ? mod.default : null;
    if (!factory) return { ran: false, reason: "no-default-export" };
    const hooks = factory();
    if (!hooks || typeof hooks.apply !== "function") return { ran: false, reason: "no-apply" };

    const layers = ensureSkinLayers();
    const unsubs = [];
    const ctx = {
      skinId: id,
      scopeAttr: id,
      assetBase: apiUrl("/skins/files/" + encodeURIComponent(id) + "/"),
      layers,
      theme: {
        get: skinThemeNow,
        subscribe(listener) {
          try {
            const obs = new MutationObserver(() => {
              try { listener(skinThemeNow()); } catch { /* 监听方出错不影响别人 */ }
            });
            obs.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
            const off = () => { try { obs.disconnect(); } catch { /* ignore */ } };
            unsubs.push(off);
            return off;
          } catch {
            return () => {};
          }
        },
      },
      onCleanup(fn) { if (typeof fn === "function") skinHotCleanups.push(fn); },
    };
    hooks.apply(ctx);
    if (typeof hooks.dispose === "function") {
      skinHotCleanups.push(() => { try { hooks.dispose(); } catch { /* 幂等 */ } });
    }
    skinHotCleanups.push(() => { for (const off of unsubs) { try { off(); } catch { /* ignore */ } } });
    return { ran: true };
  } finally {
    setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ } }, 10000);
  }
}

/** 撤掉上一次热切换留下的东西（清理函数 + 注入样式）。作用域属性由下一次直接覆盖。 */
function clearSkinHot() {
  for (const fn of skinHotCleanups.splice(0).reverse()) {
    try { fn(); } catch { /* 清理幂等，单个失败不影响其余 */ }
  }
  try {
    const el = document.getElementById("folia-skin-hot");
    if (el) el.remove();
  } catch { /* ignore */ }
}

/**
 * 把一套皮肤**完整**应用上去（作用域 + 六层 + 样式 + 背景 + hooks）。
 * 按钮和"壁纸撤下后自动恢复"走的是**同一个**函数 —— 两条路径不能各写一遍。
 */
async function applySkinHot(id) {
  clearSkinHot();
  try { document.documentElement.setAttribute("data-dsh-skin", id); } catch { /* ignore */ }
  ensureSkinLayers();
  const info = await applySkinCss(id);
  const bg = await applySkinBackground(id);
  let hooksInfo = { ran: false, reason: "skipped" };
  try {
    hooksInfo = await applySkinHooks(id);
  } catch (e) {
    hooksInfo = { ran: false, reason: String((e && e.message) || e) };
  }
  return { info, bg, hooks: hooksInfo };
}

/** 把皮肤**整个撤掉**，回到应用原生外观（壁纸接管背景时走这条）。 */
function teardownSkin() {
  clearSkinHot();
  try { document.documentElement.removeAttribute("data-dsh-skin"); } catch { /* ignore */ }
  try { document.body.removeAttribute("data-dsh-skin-center"); } catch { /* ignore */ }
  for (const name of SKIN_LAYER_NAMES) {
    try {
      const el = document.querySelector('[data-dsh-skin-layer="' + name + '"]');
      if (el) el.innerHTML = "";
    } catch { /* ignore */ }
  }
}

/** 向宿主问"当前选中的皮肤是哪个"（没选中返回空串）。 */
async function activeSkinIdFromHost() {
  try {
    const resp = await apiJson("/skins");
    const doc = (resp && resp.data) || null;
    return (doc && typeof doc.active === "string") ? doc.active : "";
  } catch {
    return "";
  }
}

let skinArbiterStarted = false;
/**
 * **皮肤与壁纸互斥的仲裁器**（两个方向都要管）。
 *
 * 现状：点「使用」时我们会主动清掉壁纸（一个方向）；但用户**反过来**点壁纸时，
 * 没人撤掉我们热注入的皮肤 —— 于是皮肤那层不透明样式压在壁纸上面，壁纸看起来被"遮挡"。
 *
 * 这里盯 `body[data-we-wallpaper]` 这个标记（**壁纸插件自己在挂/摘**，是双方共同的事实源）：
 *   · 标记出现 ⇒ 撤掉皮肤（teardownSkin）
 *   · 标记消失 ⇒ 若选中过皮肤，重新完整应用（applySkinHot）
 * 这样无论用户先点哪边，最后都是"只有一个在台"。
 */
function startSkinArbiter() {
  if (skinArbiterStarted) return;
  const body = (typeof document !== "undefined") ? document.body : null;
  if (!body) { setTimeout(startSkinArbiter, 400); return; }
  skinArbiterStarted = true;
  let seq = 0;
  const sync = async () => {
    const mine = ++seq;
    const wallpaperOn = body.hasAttribute("data-we-wallpaper");
    if (wallpaperOn) { teardownSkin(); return; }
    const id = await activeSkinIdFromHost();
    if (mine !== seq) return;                 // 期间又变了，放弃这次
    if (!id) return;
    try { await applySkinHot(id); } catch { /* 失败就保持原生外观 */ }
  };
  try {
    new MutationObserver(() => { sync().catch(() => {}); })
      .observe(body, { attributes: true, attributeFilter: ["data-we-wallpaper"] });
    // 启动时就跑一次：处理"上次退出时壁纸在台、皮肤被让位"这类残留状态
    sync().catch(() => {});
  } catch { /* 环境不支持观察就只保留按钮路径 */ }
}

function SkinsTabPanel(props) {
  // 壁纸让位：挂载点（设置页 / 首页抽屉）各自把"清掉当前壁纸"的回调传进来 ——
  // 皮肤和壁纸都在铺背景，必须二选一。本组件不直接碰设置，只调用传进来的入口。
  const onClearWallpaper = props && props.onClearWallpaper;
  const [list, setList] = React.useState([]);
  const [active, setActive] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [harnessFound, setHarnessFound] = React.useState(true);
  const [busy, setBusy] = React.useState("");       // 正在安装 / 激活的那个 id
  const [note, setNote] = React.useState(null);      // 一次性提示（成功 / 失败原因）
  const [q, setQ] = React.useState("");

  const load = React.useCallback(async (force) => {
    setLoading(true);
    setError(null);
    try {
      // ⚠️ `apiJson` 返回的是 **`{ ok, status, data, error }` 包装对象**，不是响应体本身
      //（见 src/api-client.js 的 apiFetch）。最初按裸体取值 ⇒ `list=[] 且 error=null`，
      // 界面显示"没有匹配的皮肤包"却没有任何错误提示 —— 静默空列表比报错难查得多。
      // `parse: "always"` 让非 2xx 的 `{error}` 也能被读到。
      const resp = await apiJson("/skins" + (force ? "?refresh=1" : ""), { parse: "always" });
      const r = (resp && resp.data) || null;
      setList((r && r.skins) || []);
      setActive((r && r.active) || null);
      setError((r && r.error) || (resp && resp.error) || null);
      setHarnessFound(!r || r.harnessFound !== false);
    } catch (e) {
      setError("network");
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(false); }, [load]);

  /**
   * 执行一个动作（install / activate / remove）。
   *
   * ⚠️ **「使用」必须立刻有反馈**：切换皮肤只写 `skin-center-active.json`，host 端 6 ms 就应，
   * 而皮肤要重启才生效 —— 如果等一次 `?refresh=1`（约 600 ms）再改标记，用户看到的就是
   * "点了一下，半天没反应"。所以「使用」走**乐观更新**：先本地翻转 active 并把提示打出来，
   * 请求失败再回滚重拉。装 / 删仍然要重拉（已装标记与体积都变了）。
   */
  async function act(kind, id, label) {
    if (busy) return;
    setBusy(id);
    setNote(null);
    const prevActive = active;
    if (kind === "activate") {
      // 乐观：先给反馈，再等网络
      setActive(id);
      setList((prev) => prev.map((x) => ({ ...x, active: x.id === id })));
      setNote({ kind: "ok", text: weT("正在切换到「") + label + weT("」…") });
    }
    try {
      // 同样是包装对象：`ok` 是 HTTP 2xx，业务结论在 `data.ok`（宿主回 `{ok:false,error}`）。
      const resp = await apiPostJson("/skins/" + kind, { id }, { parse: "always" });
      const r = (resp && resp.data) || null;
      if (resp && resp.ok && r && r.ok) {
        if (kind === "install") {
          setNote({ kind: "ok", text: weT("已安装：") + label });
          await load(true);
        } else if (kind === "activate") {
          // **当场换肤**：作用域 + 六层 + 样式 + 背景 + hooks，全在 applySkinHot 里
          //（与"壁纸撤下后自动恢复"共用同一实现，两条路径不会漂移）。
          let info = null;
          let applyErr = "";
          let bgKind = "none";
          let hooksInfo = { ran: false, reason: "skipped" };
          try {
            // ① 壁纸先让位：清掉 `id` 之后壁纸层撤下、`data-we-wallpaper` 消失，
            //    皮肤中心也不会再扣住皮肤。（反方向由 startSkinArbiter 负责。）
            if (typeof onClearWallpaper === "function") {
              try { await Promise.resolve(onClearWallpaper()); } catch { /* 清不掉也继续换肤 */ }
            }
            // ② 应用皮肤
            const applied = await applySkinHot(id);
            info = applied.info;
            bgKind = applied.bg.kind;
            hooksInfo = applied.hooks;
          } catch (e) {
            applyErr = String((e && e.message) || e);
          }
          setNote({
            kind: applyErr ? "err" : "ok",
            text: applyErr
              ? weT("已切换为「") + label + weT("」，但样式注入失败：") + applyErr
              : weT("已切换到「") + label + weT("」—— 样式 ")
                + Math.round(info.bytes / 1024) + " KB / " + info.rules + weT(" 条规则")
                + (info.source === "skin-center" ? weT("（已作用域化）") : weT("（未作用域化，可能显示不全）"))
                + (bgKind === "none" ? weT("，无背景媒体") : weT("，背景：") + bgKind)
                + (hooksInfo.ran ? weT("，动效已启动") : (hooksInfo.reason === "no-hooks" ? weT("，无动效") : weT("，动效未启动(") + hooksInfo.reason + ")"))
                + (typeof onClearWallpaper === "function" ? weT("，壁纸已关闭") : ""),
            // hooks 已经跑过了；这里只作为"整页重载"的可选入口（极少数皮肤依赖启动期布局）
            reload: true,
          });
          // 不再整表重拉：本地标记已经对了，省掉那 600 ms 的"没反应"窗口。
        } else if (kind === "remove") {
          setNote({ kind: "ok", text: weT("已删除：") + label });
          await load(true);
        }
      } else {
        const code = (r && r.error) || "failed";
        const detail = (r && r.detail) ? "（" + r.detail + "）" : "";
        setNote({ kind: "err", text: weT("操作失败：") + code + detail });
        if (kind === "activate") {
          // 回滚乐观更新
          setActive(prevActive);
          setList((prev) => prev.map((x) => ({ ...x, active: x.id === prevActive })));
        }
      }
    } catch (e) {
      setNote({ kind: "err", text: weT("请求失败：") + (e && e.message ? e.message : weT("网络错误")) });
      if (kind === "activate") {
        setActive(prevActive);
        setList((prev) => prev.map((x) => ({ ...x, active: x.id === prevActive })));
      }
    } finally {
      setBusy("");
    }
  }

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? list.filter((s) => (s.name + " " + s.nameEn + " " + s.id + " " + (s.tags || []).join(" "))
      .toLowerCase().indexOf(needle) !== -1)
    : list;

  const installedCount = list.filter((s) => s.installed).length;

  const header = React.createElement("div", { className: "we-picker__section-head" },
    React.createElement("span", { className: "we-picker__section-label" },
      weT("🎨 皮肤包") + (list.length ? "  ·  " + list.length : "")),
    React.createElement("button", {
      type: "button",
      className: "we-picker__btn",
      style: { marginLeft: "auto" },
      disabled: loading,
      onClick: () => load(true),
      title: weT("重新从站点拉取列表"),
    }, loading ? weT("加载中…") : weT("刷新")),
  );

  if (!harnessFound) {
    return React.createElement(React.Fragment, null,
      React.createElement("div", { className: "we-picker__section" }, header,
        React.createElement("div", { className: "we-picker__empty" },
          React.createElement("span", { className: "we-picker__empty-title" }, weT("找不到 DSH 的 skins 目录")),
          React.createElement("span", { className: "we-picker__hint" },
            weT("皮肤包要装到 DSH 的 harness/skins 下。可用环境变量 DSH_FOLIA_HARNESS 指定该目录")))));
  }

  const children = [React.createElement("div", { className: "we-picker__section", key: "sec" }, header)];
  // 常驻一行「当前皮肤」：切换只写文件、皮肤要重启才生效，不给这一行用户就无从判断
  // 刚才那次点击到底成没成（这是"点了没反应"的一半原因）。
  if (active) {
    const activeName = (list.find((x) => x.id === active) || {}).name || active;
    children.push(React.createElement("div", {
      key: "active",
      className: "we-picker__hint",
      style: { margin: "4px 0 8px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
    },
    React.createElement("span", null, weT("当前皮肤：") + activeName),
    React.createElement("span", {
      style: { fontSize: "11px", padding: "1px 6px", borderRadius: "999px", background: "rgba(142,230,168,0.16)", color: "#8ee6a8" },
    }, weT("已应用")),
    ));
  }

  // ⚠️ **壁纸在台时皮肤不会生效** —— 这是皮肤中心写死的行为，不是我们的 bug：
  //   · host 侧：peer（= 本插件）持久化的壁纸选择非空时，它从文档里**扣住**皮肤；
  //   · client 侧：它盯 `body[data-we-wallpaper]`，只要那个标记在，就把皮肤让位
  //     （源码注释：`an active WE wallpaper suppresses skin media`）。
  // 于是"点了使用但界面没变"最可能的原因就是**壁纸还开着**。这里直接读那个标记，
  // 命中就把话说清楚，并告诉用户该先做什么。
  let wallpaperOn = false;
  try {
    wallpaperOn = Boolean(document.body && document.body.hasAttribute("data-we-wallpaper"));
  } catch { /* 拿不到 DOM 就当没有 */ }
  if (wallpaperOn) {
    children.push(React.createElement("div", {
      key: "wpwarning",
      className: "we-picker__hint",
      style: {
        margin: "4px 0 10px",
        padding: "7px 10px",
        borderRadius: "8px",
        background: "rgba(255,196,120,0.12)",
        color: "#ffd08a",
        lineHeight: 1.5,
      },
    }, weT("⚠️ 当前有壁纸在台：皮肤会被壁纸让位，切换不会生效。")
    + weT(" 先到「壁纸」页签点「清除」，再回来切换皮肤。")));
  }

  if (error) {
    children.push(React.createElement("div", {
      key: "err",
      className: "we-picker__hint",
      style: { color: "#ff9a9a", margin: "6px 0 10px" },
    }, skinsErrText(error)));
  }
  if (note) {
    children.push(React.createElement("div", {
      key: "note",
      className: "we-picker__hint",
      style: {
        color: note.kind === "err" ? "#ff9a9a" : "#8ee6a8",
        margin: "6px 0 10px",
        display: "flex",
        gap: "10px",
        alignItems: "center",
        flexWrap: "wrap",
      },
    },
    React.createElement("span", null, note.text),
    note.reload
      ? React.createElement("button", {
        type: "button",
        className: "we-picker__btn we-picker__btn--primary",
        style: { fontSize: "11.5px", padding: "3px 10px" },
        onClick: () => {
          // 与自动那条路一致：优先硬跳转，退而 reload。只重载前端页面 ——
          // 对话与设置都在宿主侧，不会丢。
          try { window.location.replace(window.location.href); } catch {
            try { window.location.reload(); } catch { /* 极端环境刷不动就让用户手动重启 */ }
          }
        },
        title: weT("整页重载 —— 皮肤动效（粒子等）需要重载才跑；纯配色已即时生效"),
      }, weT("重载以播放动效"))
      : null,
    ));
  }
  children.push(React.createElement("div", {
    key: "search",
    style: { display: "flex", gap: "8px", alignItems: "center", margin: "2px 0 4px" },
  },
  React.createElement("input", {
    type: "text",
    value: q,
    placeholder: weT("搜索名称 / 作者 / 标签"),
    className: "we-picker__search",
    onChange: (e) => setQ(e.target.value),
    style: { flex: "1 1 auto" },
  }),
  React.createElement("span", { className: "we-picker__hint" },
    weT("已装 ") + installedCount + " / " + list.length),
  ));

  if (loading && list.length === 0) {
    children.push(React.createElement("div", { key: "loading", className: "we-picker__empty" },
      React.createElement("span", { className: "we-picker__empty-title" }, weT("正在从站点拉取皮肤包…"))));
  } else if (!error && shown.length === 0) {
    children.push(React.createElement("div", { key: "empty", className: "we-picker__empty" },
      React.createElement("span", { className: "we-picker__empty-title" }, weT("没有匹配的皮肤包")),
      React.createElement("span", { className: "we-picker__hint" }, weT("换个关键词，或点「刷新」重新拉取"))));
  }

  if (shown.length > 0) {
    children.push(React.createElement("div", { key: "grid", style: SKINS_STYLE.grid },
      shown.map((s) => {
        const previewRel = s.previewLight || s.previewDark || "";
        const previewSrc = previewRel
          ? apiUrl("/skins/preview?p=" + encodeURIComponent(previewRel))
          : "";
        const isBusy = busy === s.id;
        const btn = (label, onClick, disabled, primary) => React.createElement("button", {
          type: "button",
          className: "we-picker__btn" + (primary ? " we-picker__btn--primary" : ""),
          style: { flex: "1 1 0", fontSize: "11.5px", padding: "4px 6px" },
          disabled: Boolean(disabled) || Boolean(busy),
          onClick,
        }, label);

        const actions = [];
        if (!s.installed) {
          actions.push(btn(isBusy ? weT("安装中…") : weT("下载安装"), () => act("install", s.id, s.name), false, true));
        } else {
          if (!s.active) {
            actions.push(btn(isBusy ? weT("切换中…") : weT("使用"), () => act("activate", s.id, s.name), false, true));
            actions.push(btn(weT("删除"), () => act("remove", s.id, s.name), isBusy, false));
          } else {
            actions.push(btn(weT("使用中"), () => {}, true, false));
          }
        }

        return React.createElement("div", { key: s.id, style: SKINS_STYLE.card },
          previewSrc
            ? React.createElement("img", {
              src: previewSrc, alt: s.name, loading: "lazy", draggable: false, style: SKINS_STYLE.thumb,
            })
            : React.createElement("div", { style: SKINS_STYLE.thumb }),
          React.createElement("div", { style: SKINS_STYLE.body },
            React.createElement("div", { style: SKINS_STYLE.title }, s.name || s.id),
            s.tagline ? React.createElement("div", { style: SKINS_STYLE.meta }, s.tagline) : null,
            (s.tags || []).length
              ? React.createElement("div", { style: SKINS_STYLE.tags },
                s.tags.slice(0, 4).map((t) => React.createElement("span", { key: t, style: SKINS_STYLE.tag }, t)))
              : null,
            React.createElement("div", { style: SKINS_STYLE.actions }, actions),
          ),
        );
      })));
  }

  return React.createElement(React.Fragment, null, children);
}

/**
 * 页签薄包装：`renderActiveTab` 只认这个签名（与别的 `render*Tab(ctx)` 一致）。
 * 传进来的 `props` 原样转交给组件 —— 目前只有 `onClearWallpaper`（皮肤与壁纸互斥，
 * 由挂载点提供"清掉当前壁纸"的入口；本文件不直接碰设置）。
 */
function renderSkinsTab(props) {
  return React.createElement(SkinsTabPanel, props || null);
}

// 模块加载即启动互斥仲裁（不依赖用户是否打开过皮肤包页签）：
//   壁纸在台 ⇒ 撤掉皮肤；壁纸撤下 ⇒ 恢复选中的皮肤。
// 放在模块作用域而不是 React effect 里，是因为它必须在**任何面板渲染之前**就守住这个不变量。
try { startSkinArbiter(); } catch { /* 环境异常时退化为纯按钮路径 */ }

export { SkinsTabPanel, renderSkinsTab };
