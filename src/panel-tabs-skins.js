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

function SkinsTabPanel() {
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

  async function act(kind, id, label) {
    if (busy) return;
    setBusy(id);
    setNote(null);
    try {
      // 同样是包装对象：`ok` 是 HTTP 2xx，业务结论在 `data.ok`（宿主回 `{ok:false,error}`）。
      const resp = await apiPostJson("/skins/" + kind, { id }, { parse: "always" });
      const r = (resp && resp.data) || null;
      if (resp && resp.ok && r && r.ok) {
        if (kind === "install") {
          setNote({ kind: "ok", text: weT("已安装：") + label });
          await load(true);
        } else if (kind === "activate") {
          setActive(id);
          setNote({ kind: "ok", text: weT("已切换到「") + label + weT("」，重启 DSH 后生效") });
          await load(true);
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
      style: { color: note.kind === "err" ? "#ff9a9a" : "#8ee6a8", margin: "6px 0 10px" },
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
            React.createElement("div", { style: SKINS_STYLE.meta },
              (s.author ? s.author : weT("未知作者")) + " · " + skinsFmtBytes(s.zipBytes)),
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

/** 页签薄包装：`renderActiveTab` 只认这个签名（与别的 `render*Tab(ctx)` 一致）。 */
function renderSkinsTab(ctx) {
  return React.createElement(SkinsTabPanel, null);
}

export { SkinsTabPanel, renderSkinsTab };
