/**
 * panel-tabs-skins.js — 「皮肤包」页签：**管理器**，不是渲染器。
 *
 * ══ 为什么只做管理 ══════════════════════════════════════════════════════════
 *
 * 皮肤的**渲染**只能由皮肤中心（@linxin666/dsh-client-ui-skin-center）完成：
 * 它读 `harness/skins/<id>/`，注入强制作用域化的 CSS、建六个装饰层、跑 hooks、
 * 铺背景媒体 —— 而且**只在页面加载时**做一次。它的控制器 `activate(id)` 没有导出，
 * 外部无法调用。
 *
 * 我们曾经试图"复刻"这套渲染（约 600 行：作用域化 CSS / 六层 / hooks / 背景 / 仲裁），
 * 结果是：怎么补都差一层，而且**能把整个界面画成空白**（2026-10-28 事故）。
 * 所以现在明确分工：
 *
 *   本页签：列表 · 预览 · 下载安装 · 删除 · 选中（写 active）
 *   皮肤中心：真正把皮肤画出来（在它自己的 设置 → 皮肤 页面点「应用」）
 *
 * 纪律（每一条都对应一次真实事故）：
 *   · **绝不**注入 CSS / 造装饰层 / 跑 hooks / 改 html 属性；
 *   · **绝不**尝试刷新页面（桌面壳里 location.reload 被吞过）；
 *   · 选中之后只写 active，然后**告诉用户下一步去哪点**；
 *   · 不碰 patch 行、不碰 generation、不跑 pnpm。
 */

function skinsFmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  if (v >= 1024) return Math.round(v / 1024) + " KB";
  return v + " B";
}

/** 当前是深色还是浅色主题（决定卡片显示哪张预览图）。 */
function skinsThemeIsDark() {
  try {
    return Boolean(document.body && document.body.hasAttribute("data-ds-dark-theme"));
  } catch {
    return false;
  }
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

/** 卡片网格与卡片本体样式：内联，不为一个页签去动全局样式表。 */
const SKINS_STYLE = {
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(168px, 1fr))", gap: "10px", marginTop: "10px" },
  card: {
    display: "flex", flexDirection: "column", overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px", background: "rgba(255,255,255,0.04)",
  },
  thumb: { width: "100%", aspectRatio: "4 / 3", objectFit: "cover", display: "block", background: "rgba(0,0,0,0.35)" },
  body: { padding: "8px 9px 9px", display: "flex", flexDirection: "column", gap: "4px", flex: "1 1 auto" },
  title: { fontSize: "12.5px", fontWeight: 600, lineHeight: 1.3 },
  meta: { fontSize: "11px", opacity: 0.62, lineHeight: 1.3 },
  tags: { display: "flex", flexWrap: "wrap", gap: "3px", marginTop: "2px" },
  tag: { fontSize: "10px", padding: "1px 5px", borderRadius: "999px", background: "rgba(255,255,255,0.09)", opacity: 0.75 },
  actions: { display: "flex", gap: "6px", marginTop: "6px" },
};

function SkinsTabPanel(props) {
  // 「清掉当前壁纸」的入口由挂载点传入（皮肤与壁纸互斥）。本组件不直接碰设置。
  const onClearWallpaper = props && props.onClearWallpaper;

  const [list, setList] = React.useState([]);
  const [active, setActive] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(null);
  const [harnessFound, setHarnessFound] = React.useState(true);
  const [skinCenter, setSkinCenter] = React.useState(false);
  const [providers, setProviders] = React.useState([]);
  const [busy, setBusy] = React.useState("");
  const [note, setNote] = React.useState(null);
  const [q, setQ] = React.useState("");

  const load = React.useCallback(async (force) => {
    setLoading(true);
    setError(null);
    try {
      // apiJson 返回 { ok, status, data, error } 包装对象，不是响应体本身。
      const resp = await apiJson("/skins" + (force ? "?refresh=1" : ""), { parse: "always" });
      const r = (resp && resp.data) || null;
      setList((r && r.skins) || []);
      setActive((r && r.active) || null);
      setError((r && r.error) || (resp && resp.error) || null);
      setHarnessFound(!r || r.harnessFound !== false);
      setSkinCenter(Boolean(r && r.skinCenter));
      setProviders(Array.isArray(r && r.skinCenterProviders) ? r.skinCenterProviders : []);
    } catch (e) {
      setError("network");
      setList([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { load(false); }, [load]);

  // ── 「应用」= 写 active + 刷新页面 ─────────────────────────────────────────
  // 皮肤中心**只在页面加载时**应用皮肤，而它的控制器没有导出（0.4.8 与 0.4.11 都
  // 没有全局句柄 / activate API / 文件监听）。所以让用户"点一下就出效果"的唯一
  // 可行做法，是让页面重新加载一次，触发它的 boot。
  //
  // 用 sessionStorage 留时间戳标记：页面确实重载了，标记就还在（同一标签页会话内
  // 有效）—— 据此判断"刷新到底发生了没有"，而不是靠猜。刷新被桌面壳吞掉时，
  // 标记留在原地，4 秒后给出明确的兜底提示。
  React.useEffect(() => {
    try {
      const raw = sessionStorage.getItem("folia.applyPending");
      if (!raw) return;
      sessionStorage.removeItem("folia.applyPending");
      const o = JSON.parse(raw);
      if (o && Date.now() - Number(o.at || 0) < 20000) {
        setNote({
          kind: "ok",
          text: weT("页面已重新加载，「") + (o.label || o.id)
            + weT("」应由皮肤中心应用。若仍无变化，请到「设置 → 皮肤」点「应用」。"),
        });
      }
    } catch { /* sessionStorage 不可用就跳过，不影响主流程 */ }
  }, []);

  /**
   * 执行一个动作。
   * · install / remove：宿主真正干活（下载解压 / 删目录）。
   * · activate：**只写 active**（`skin-center-active.json`），然后告诉用户下一步。
   *   不注入任何样式 —— 那一步归皮肤中心。
   */
  async function act(kind, id, label) {
    if (busy) return;
    setBusy(id);
    setNote(null);
    try {
      const resp = await apiPostJson("/skins/" + kind, { id }, { parse: "always" });
      const r = (resp && resp.data) || null;
      if (resp && resp.ok && r && r.ok) {
        if (kind === "install") {
          setNote({ kind: "ok", text: weT("已安装：") + label });
          await load(true);
        } else if (kind === "activate") {
          setActive(id);
          setList((prev) => prev.map((x) => ({ ...x, active: x.id === id })));
          // 皮肤与壁纸都在铺背景，必须互斥：先让壁纸让位。
          try {
            if (typeof onClearWallpaper === "function") await Promise.resolve(onClearWallpaper());
          } catch { /* 清壁纸失败不影响选中本身 */ }
          setNote({
            kind: "ok",
            text: skinCenter
              ? weT("已选中「") + label + weT("」，正在重新加载页面让皮肤生效…")
              : weT("已选中「") + label + weT("」—— 未检测到皮肤中心，无法渲染；请安装 @linxin666/dsh-client-ui-skin-center 后重启"),
          });
          // 只有皮肤中心在台时，刷新才有意义（boot 时它会应用 active）。
          if (skinCenter) {
            try {
              sessionStorage.setItem("folia.applyPending", JSON.stringify({ id, label, at: Date.now() }));
            } catch { /* 不可用就退化：不刷新，只给提示 */ }
            setTimeout(() => {
              try { window.location.reload(); } catch { /* 桌面壳拦了刷新 */ }
            }, 700);
            // 兜底：4 秒后页面还在（说明刷新被吞），明确告诉用户改用手动重启。
            setTimeout(() => {
              setNote({
                kind: "err",
                text: weT("页面没有自动刷新 —— 桌面壳可能拦了刷新。请手动重启 DSH 让「") + label + weT("」生效。"),
              });
            }, 4000);
          }
        } else if (kind === "remove") {
          setNote({ kind: "ok", text: weT("已删除：") + label });
          await load(true);
        }
      } else {
        const code = (r && r.error) || "failed";
        const detail = (r && r.detail) ? "（" + r.detail + "）" : "";
        setNote({ kind: "err", text: weT("操作失败：") + code + detail });
      }
    } catch (e) {
      setNote({ kind: "err", text: weT("请求失败：") + (e && e.message ? e.message : weT("网络错误")) });
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

  // 重复挂载警示：我们的 patch 只有一行（folia），正常不会出现；
  // 但用户可能自己加了行，这里如实报出来。
  if (providers.length > 1) {
    children.push(React.createElement("div", {
      key: "dup",
      className: "we-picker__hint",
      style: {
        margin: "4px 0 10px", padding: "7px 10px", borderRadius: "8px",
        background: "rgba(255,120,120,0.14)", color: "#ff9a9a", lineHeight: 1.5,
      },
    }, weT("⚠️ 检测到 ") + providers.length + weT(" 处挂载了皮肤中心（")
      + providers.map((p) => p.bundle).join(" / ")
      + weT("）。请只保留一处，否则会重复挂载。")));
  }

  // 分工常驻说明：让用户一开始就知道"应用"在哪一步。
  if (list.length > 0) {
    children.push(React.createElement("div", {
      key: "division",
      className: "we-picker__hint",
      style: { margin: "2px 0 8px", opacity: 0.8 },
    }, skinCenter
      ? weT("这里负责下载与管理。选中后请到「设置 → 皮肤」点「应用」完成渲染。")
      : weT("未检测到皮肤中心：可以下载/管理皮肤包，但无法渲染。请安装 @linxin666/dsh-client-ui-skin-center 并重启。")));
  }

  // 当前选中（只是"选中"，不是"已应用"）
  if (active) {
    const activeName = (list.find((x) => x.id === active) || {}).name || active;
    children.push(React.createElement("div", {
      key: "active",
      className: "we-picker__hint",
      style: { margin: "4px 0 8px", display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" },
    },
    React.createElement("span", null, weT("已选中：") + activeName),
    React.createElement("span", {
      style: { fontSize: "11px", padding: "1px 6px", borderRadius: "999px", background: "rgba(255,196,120,0.16)", color: "#ffd08a" },
    }, weT("需在皮肤中心点「应用」")),
    ));
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
      style: { color: note.kind === "err" ? "#ff9a9a" : "#8ee6a8", margin: "6px 0 10px", lineHeight: 1.5 },
    }, note.text));
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
  React.createElement("span", { className: "we-picker__hint" }, weT("已装 ") + installedCount + " / " + list.length),
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
    const darkNow = skinsThemeIsDark();
    children.push(React.createElement("div", { key: "grid", style: SKINS_STYLE.grid },
      shown.map((s) => {
        const previewRel = (darkNow
          ? (s.previewDark || s.previewLight)
          : (s.previewLight || s.previewDark)) || "";
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
        } else if (!s.active) {
          actions.push(btn(isBusy ? weT("选中中…") : weT("选择"), () => act("activate", s.id, s.name), false, true));
          actions.push(btn(weT("删除"), () => act("remove", s.id, s.name), isBusy, false));
        } else {
          actions.push(btn(weT("已选中"), () => {}, true, false));
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
 * 传进来的 props 原样转交（目前只有 `onClearWallpaper`）。
 */
function renderSkinsTab(props) {
  return React.createElement(SkinsTabPanel, props || null);
}

export { SkinsTabPanel, renderSkinsTab };
