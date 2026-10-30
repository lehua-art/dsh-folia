/**
 * panel-tabs-skins.js — 「助手皮肤」页签：站点皮肤清单 / 安装 / 卸载 / 去皮肤中心启用。
 *
 * 与「桌宠」页签同构（fetch → busy → note → 卡片列表）。差别在**安装之后谁负责渲染**：
 * 桌宠由本插件自己画（pet-layer.js），皮肤则由皮肤中心接管 —— 我们只把 zip 解到
 * `$DSH_HOME/skins/<id>/`，皮肤中心下一次 catalog 扫描就会认领（它的缓存键里带父目录 mtime）。
 * 所以这个页签的职责边界是：**装/卸 + 告诉你下一步去哪启用**，不重复实现渲染。
 */

const SKIN_STYLE = {
  row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  card: {
    display: "flex", flexDirection: "column", gap: "6px", padding: "10px",
    borderRadius: "10px", border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.04)", width: "188px",
  },
  thumb: {
    width: "100%", aspectRatio: "16 / 9", borderRadius: "6px",
    backgroundSize: "cover", backgroundPosition: "center",
    backgroundColor: "rgba(0,0,0,0.25)",
  },
  title: { fontSize: "13px", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  meta: { fontSize: "11px", opacity: 0.72 },
  grid: { display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "10px" },
  badge: {
    fontSize: "10px", padding: "1px 6px", borderRadius: "4px",
    background: "rgba(30,90,160,0.55)", alignSelf: "flex-start",
  },
};

function skinFmtBytes(n) {
  const v = Number(n) || 0;
  if (!v) return "";
  if (v < 1024 * 1024) return Math.round(v / 1024) + " KB";
  return (v / 1048576).toFixed(1) + " MB";
}

function SkinsTabPanel() {
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState("");
  const [note, setNote] = React.useState(null);

  const load = React.useCallback(async (force) => {
    try {
      const resp = await apiJson("/skins/list" + (force ? "?refresh=1" : ""), { parse: "always" });
      const doc = (resp && resp.data) || null;
      if (resp && resp.ok && doc && doc.ok) {
        setState(doc);
        if (doc.siteError && doc.siteError !== "site-off") {
          setNote({ ok: false, text: weT("站点清单读不到：{msg}", { msg: String(doc.siteError) }) });
        }
      } else {
        setNote({ ok: false, text: weT("读取失败：{msg}", { msg: (doc && doc.error) || "unknown" }) });
      }
    } catch (e) {
      setNote({ ok: false, text: weT("请求失败：{msg}", { msg: (e && e.message) || weT("网络错误") }) });
    }
  }, []);

  React.useEffect(() => { load(false); }, [load]);

  const act = async (kind, payload, label) => {
    const structural = kind === "install" || kind === "remove";
    if (structural) setBusy(kind + ":" + ((payload && payload.id) || ""));
    setNote(null);
    try {
      const resp = await apiPostJson("/skins/" + kind, payload || {}, { parse: "always" });
      const r = (resp && resp.data) || null;
      if (resp && resp.ok && r && r.ok) {
        if (kind === "install") {
          setNote({
            ok: true,
            text: r.exists
              ? weT("已安装过：{name}", { name: label || "" })
              : weT("已安装：{name} —— 到「设置 → 皮肤中心」点它即可启用", { name: label || "" }),
          });
        }
        if (kind === "remove") setNote({ ok: true, text: weT("已卸载：{name}", { name: label || "" }) });
        await load(true);
      } else {
        const code = (r && r.error) || "failed";
        const map = {
          'no-skin-json': weT("这个包里没有 skin.json，不是皮肤包"),
          'unsafe-entry': weT("包里有非法路径（已整包拒绝）"),
          'too-large': weT("包太大了（上限 200 MB）"),
          'host-not-allowed': weT("下载地址不在白名单里"),
          'site-off': weT("站点被关闭了（DSH_FOLIA_SITE=off）"),
          'not-a-zip': weT("这个文件不是 zip"),
        };
        setNote({ ok: false, text: map[code] || weT("操作失败：{code}", { code }) });
      }
    } catch (e) {
      setNote({ ok: false, text: weT("请求失败：{msg}", { msg: (e && e.message) || weT("网络错误") }) });
    } finally {
      setBusy("");
    }
  };

  const children = [];
  children.push(React.createElement("div", { key: "head", style: SKIN_STYLE.row },
    React.createElement("div", { style: { fontSize: "13px", fontWeight: 600 } }, weT("🎨 助手皮肤")),
    React.createElement("button", {
      className: "we-picker__btn", type: "button",
      disabled: Boolean(busy),
      onClick: () => load(true),
    }, weT("刷新")),
  ));

  children.push(React.createElement("div", {
    key: "hint",
    className: "we-picker__hint",
    style: { margin: "6px 0 4px", opacity: 0.8 },
  }, weT("皮肤包安装到皮肤中心目录；装完到「设置 → 皮肤中心」里点选即可启用。皮肤中心与本插件读同一个目录，无需重启。")));

  // 提示行常驻占位（与开机动画/桌宠页签同一条纪律：不因 note 出现/消失让面板跳高度）
  children.push(React.createElement("div", {
    key: "note",
    className: "we-picker__hint",
    style: {
      color: note && !note.ok ? "#ff9a9a" : "#8ee6a8",
      margin: "2px 0 8px", minHeight: "18px", lineHeight: "18px",
      opacity: note ? 1 : 0, transition: "opacity 120ms linear",
    },
  }, note ? note.text : "\u00a0"));

  const installed = (state && state.installed) || [];
  if (state) {
    children.push(React.createElement("div", { key: "installed-head", className: "we-picker__hint" },
      weT("本机已装（{n}）", { n: installed.length })));
    children.push(React.createElement("div", { key: "installed", style: SKIN_STYLE.grid },
      installed.length === 0
        ? [React.createElement("span", { key: "none", className: "we-picker__hint" }, weT("还没有安装任何皮肤 —— 从下面的站点清单里挑一个。"))]
        : installed.map((s) => React.createElement("div", { key: s.id, style: SKIN_STYLE.card },
          React.createElement("div", { style: { ...SKIN_STYLE.title, color: s.accent || undefined } }, s.name || s.id),
          React.createElement("div", { style: SKIN_STYLE.meta },
            [s.version ? "v" + s.version : "", skinFmtBytes(s.bytes), s.hasHooks ? weT("含动效钩子") : ""]
              .filter(Boolean).join(" · ")),
          React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
            React.createElement("button", {
              className: "we-picker__btn", type: "button",
              disabled: Boolean(busy),
              onClick: () => act("remove", { id: s.id }, s.name),
            }, busy === "remove:" + s.id ? weT("卸载中…") : weT("卸载")),
          ),
        )),
    ));
  }

  const site = (state && state.site) || [];
  children.push(React.createElement("div", { key: "site-head", className: "we-picker__hint", style: { marginTop: "10px" } },
    weT("站点皮肤（{n}）", { n: site.length })));
  children.push(React.createElement("div", { key: "site", style: SKIN_STYLE.grid },
    site.length === 0
      ? [React.createElement("span", { key: "none", className: "we-picker__hint" }, weT("站点上还没有皮肤。"))]
      : site.map((s) => {
        const busyThis = busy === "install:" + s.id;
        return React.createElement("div", { key: s.id, style: SKIN_STYLE.card },
          s.thumbUrl
            ? React.createElement("div", {
              style: { ...SKIN_STYLE.thumb, backgroundImage: "url(" + JSON.stringify(s.thumbUrl) + ")" },
            })
            : React.createElement("div", { style: SKIN_STYLE.thumb }),
          React.createElement("div", { style: SKIN_STYLE.title, title: s.title }, s.title),
          React.createElement("div", { style: SKIN_STYLE.meta },
            [skinFmtBytes(s.bytes), (s.tags || []).includes("动态") ? weT("动态") : ""].filter(Boolean).join(" · ")),
          s.installed
            ? React.createElement("div", { style: SKIN_STYLE.badge }, weT("已安装"))
            : React.createElement("button", {
              className: "we-picker__btn", type: "button",
              disabled: Boolean(busy),
              onClick: () => act("install", { id: s.id, url: s.url }, s.title),
            }, busyThis ? weT("安装中…") : weT("安装")),
        );
      }),
  ));

  return React.createElement("div", { className: "we-picker", style: { display: "flex", flexDirection: "column" } }, children);
}
