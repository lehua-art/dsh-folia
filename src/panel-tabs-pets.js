/**
 * panel-tabs-pets.js — 「桌宠」页签：站点清单 / 安装 / 使用 / 卸载 / 开关 / 缩放。
 *
 * 与「开机动画」页签同构（fetch → busy → note → 卡片列表），差别只有一处：
 * 开机动画的播放不在前端（启动那一刻应用还没挂载），而桌宠**就活在前端** ——
 * 这里的每个动作最终都落到宿主 `/folia/pets/*`，渲染由 pet-layer.js 负责。
 */

const PET_STYLE = {
  row: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
  card: {
    display: "flex", flexDirection: "column", gap: "8px", padding: "12px",
    borderRadius: "10px", border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.04)", minWidth: "220px", flex: "1 1 220px",
  },
  title: { fontSize: "13px", fontWeight: 600 },
  meta: { fontSize: "11px", opacity: 0.72 },
  grid: { display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "10px" },
};

function petFmtBytes(n) {
  const v = Number(n) || 0;
  if (!v) return "";
  if (v < 1024 * 1024) return Math.round(v / 1024) + " KB";
  return (v / 1048576).toFixed(1) + " MB";
}

function PetsTabPanel() {
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState("");
  const [note, setNote] = React.useState(null);
  const [importable, setImportable] = React.useState([]);

  const load = React.useCallback(async (force) => {
    try {
      const resp = await apiJson("/pets/list" + (force ? "?refresh=1" : ""), { parse: "always" });
      const doc = (resp && resp.data) || null;
      if (resp && resp.ok && doc && doc.ok) {
        setState(doc);
        // 顺带问一下本机其它宠物插件里有哪些可导入的（失败不影响主列表）。
        try {
          const im = await apiJson("/pets/importable", { parse: "always" });
          const imDoc = (im && im.data) || null;
          if (imDoc && imDoc.ok) setImportable(imDoc.pets || []);
        } catch { /* 无外部目录是正常情况 */ }
      }
      else setNote({ ok: false, text: weT("读取失败：") + ((resp && resp.error) || "unknown") });
    } catch (e) {
      setNote({ ok: false, text: weT("请求失败：") + ((e && e.message) || weT("网络错误")) });
    }
  }, []);

  React.useEffect(() => { load(false); }, [load]);

  const act = async (kind, payload, label) => {
    setBusy(kind + ":" + (payload.id || ""));
    setNote(null);
    try {
      const resp = await apiPostJson("/pets/" + kind, payload || {}, { parse: "always" });
      const r = (resp && resp.data) || null;
      if (resp && resp.ok && r && r.ok) {
        if (kind === "install") setNote({ ok: true, text: weT("已安装并启用：") + (label || "") });
        if (kind === "remove") setNote({ ok: true, text: weT("已卸载：") + (label || "") });
        if (kind === "import") setNote({ ok: true, text: weT("已导入并启用：") + (label || "") });
        if (kind === "config") setNote({ ok: true, text: weT("已保存") });
        await load(true);
      } else {
        const code = (r && r.error) || "failed";
        setNote({ ok: false, text: weT("操作失败：") + code });
      }
    } catch (e) {
      setNote({ ok: false, text: weT("请求失败：") + ((e && e.message) || weT("网络错误")) });
    } finally {
      setBusy("");
    }
  };

  const pets = (state && state.pets) || [];
  const site = (state && state.site) || [];
  const cfg = (state && state.config) || { enabled: false, petId: "", scale: 1 };
  const installedIds = new Set(pets.map((p) => p.dirId));

  if (!state) {
    return React.createElement("div", { className: "we-picker__section" },
      React.createElement("div", { className: "we-picker__hint" }, weT("正在读取桌宠…")));
  }

  const children = [];

  children.push(React.createElement("div", { className: "we-picker__section-head", key: "head" },
    React.createElement("span", { className: "we-picker__section-label" },
      weT("🐾 桌宠") + (pets.length ? "  ·  " + pets.length : "")),
    React.createElement("button", {
      type: "button", className: "we-picker__btn", style: { marginLeft: "auto" },
      disabled: Boolean(busy), onClick: () => load(true),
    }, weT("刷新")),
  ));

  children.push(React.createElement("div", { key: "hint", className: "we-picker__hint", style: { margin: "6px 0 10px" } },
    weT("桌宠由本插件自己绘制（雪碧图逐帧），不依赖其它宠物插件。它会跟着模型状态换动作：干活时换成工作行、干完变完成、出错变失败；安装后出现在右下角，可拖动，点一下会挥手并出声。")));

  children.push(React.createElement("div", { key: "opts", style: { ...PET_STYLE.row, margin: "2px 0 8px" } },
    React.createElement("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" } },
      React.createElement("input", {
        type: "checkbox",
        checked: Boolean(cfg.enabled),
        disabled: Boolean(busy) || !pets.length,
        onChange: (e) => act("config", { enabled: e.target.checked }, ""),
      }),
      weT("显示桌宠"),
    ),
    React.createElement("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" } },
      React.createElement("input", {
        type: "checkbox",
        checked: Boolean(cfg.sound),
        disabled: Boolean(busy),
        onChange: (e) => act("config", { sound: e.target.checked }, ""),
      }),
      weT("声音"),
    ),
    React.createElement("label", { style: { display: "flex", gap: "4px", alignItems: "center", fontSize: "12px" } },
      weT("音量"),
      React.createElement("select", {
        className: "we-picker__playlist-select",
        value: String(cfg.volume == null ? 0.6 : cfg.volume),
        disabled: Boolean(busy) || !cfg.sound,
        onChange: (e) => act("config", { volume: Number(e.target.value) }, ""),
      },
      [[0.2, "20%"], [0.4, "40%"], [0.6, "60%"], [0.8, "80%"], [1, "100%"]].map(([v, lb]) =>
        React.createElement("option", { key: String(v), value: String(v) }, lb)),
      ),
    ),
    React.createElement("button", {
      type: "button", className: "we-picker__btn", disabled: Boolean(busy),
      title: weT("把桌宠挪回右下角"),
      onClick: () => { try { localStorage.removeItem("wePetPos"); } catch { /* ignore */ } setNote({ ok: true, text: weT("位置已复位（下一次出现回到右下角）") }); },
    }, weT("复位位置")),
    React.createElement("label", { style: { display: "flex", gap: "4px", alignItems: "center", fontSize: "12px" } },
      weT("大小"),
      React.createElement("select", {
        className: "we-picker__playlist-select",
        value: String(cfg.scale || 1),
        disabled: Boolean(busy),
        onChange: (e) => act("config", { scale: Number(e.target.value) }, ""),
      },
      [[0.6, "60%"], [0.8, "80%"], [1, "100%"], [1.3, "130%"], [1.6, "160%"]].map(([v, t]) =>
        React.createElement("option", { key: String(v), value: String(v) }, t)),
      ),
    ),
  ));

  if (note) {
    children.push(React.createElement("div", {
      key: "note",
      className: "we-picker__hint",
      style: { color: note.ok ? "rgba(120,220,150,0.95)" : "rgba(255,140,140,0.95)", margin: "2px 0 8px" },
    }, note.text));
  }

  const btn = (text, onClick, disabled) => React.createElement("button", {
    type: "button", className: "we-picker__btn", disabled: Boolean(disabled),
    style: { flex: "1 1 auto" }, onClick,
  }, text);

  // 已装：换一只 / 卸载
  children.push(React.createElement("div", { key: "installed", style: PET_STYLE.grid },
    pets.length
      ? pets.map((p) => {
        const isActive = cfg.petId === p.dirId || cfg.petId === p.id;
        const key = "inst:" + p.dirId;
        const actions = [];
        actions.push(btn(isActive ? weT("使用中") : weT("使用"), () => act("config", { enabled: true, petId: p.dirId }, p.name), isActive || Boolean(busy)));
        actions.push(btn(weT("卸载"), () => act("remove", { id: p.dirId }, p.name), Boolean(busy)));
        return React.createElement("div", { key, style: PET_STYLE.card },
          // 预览只显示**第一帧**：雪碧图是 8×9 网格，直接贴图会看到一整排小人（用户实测反馈"看着很乱"）。
          // 用 background-size = 列数/行数 × 100% + position 0 0 裁出左上角那一格。
          React.createElement("div", {
            style: {
              width: "100%",
              aspectRatio: (p.cell ? p.cell.width + " / " + p.cell.height : "192 / 208"),
              maxHeight: "96px",
              backgroundImage: "url(" + apiUrl(p.sheet) + ")",
              backgroundSize: (Number(p.columns) || 8) * 100 + "% " + (Array.isArray(p.frames) ? p.frames.length : 9) * 100 + "%",
              backgroundPosition: "0 0",
              backgroundRepeat: "no-repeat",
              backgroundColor: "rgba(0,0,0,0.25)",
              borderRadius: "6px",
            },
          }),
          React.createElement("div", { style: PET_STYLE.title }, p.name),
          React.createElement("div", { style: PET_STYLE.meta },
            (p.columns || 8) + weT(" 列 · ") + (p.cell ? p.cell.width + "×" + p.cell.height : "")),
          React.createElement("div", { style: PET_STYLE.row }, actions),
        );
      })
      : React.createElement("div", { className: "we-picker__hint" }, weT("还没有安装任何桌宠 —— 从下面的站点清单里挑一只。")),
  ));

  // 本机其它宠物插件里可导入的（dsh-pet 等下载的宠物就落在 $DSH_HOME/pets）
  if (importable.length) {
    children.push(React.createElement("div", { key: "impHead", className: "we-picker__section-head", style: { marginTop: "14px" } },
      React.createElement("span", { className: "we-picker__section-label" },
        weT("本机可导入") + "  ·  " + importable.length),
    ));
    children.push(React.createElement("div", { key: "imp", style: PET_STYLE.grid },
      importable.map((it) => {
        const isBusy = busy === "import:" + it.id;
        return React.createElement("div", { key: "imp:" + it.id, style: PET_STYLE.card },
          React.createElement("div", { style: PET_STYLE.title }, it.name || it.id),
          React.createElement("div", { style: PET_STYLE.meta },
            weT("来自其它宠物插件 · ") + petFmtBytes(it.bytes)),
          React.createElement("div", { style: PET_STYLE.row },
            btn(isBusy ? weT("导入中…") : weT("导入"), () => act("import", { id: it.id }, it.name || it.id), Boolean(busy))),
        );
      }),
    ));
  }

  // 站点：未装的可安装
  const available = site.filter((s) => !installedIds.has(s.id));
  children.push(React.createElement("div", { key: "siteHead", className: "we-picker__section-head", style: { marginTop: "14px" } },
    React.createElement("span", { className: "we-picker__section-label" },
      weT("站点桌宠") + (site.length ? "  ·  " + site.length : "")),
    state.siteError
      ? React.createElement("span", { className: "we-picker__hint", style: { marginLeft: "auto" } }, weT("站点不可达"))
      : null,
  ));

  if (available.length) {
    children.push(React.createElement("div", { key: "site", style: PET_STYLE.grid },
      available.map((s) => {
        const isBusy = busy === "install:" + s.id;
        return React.createElement("div", { key: "site:" + s.id, style: PET_STYLE.card },
          s.cover
            ? React.createElement("img", {
              src: s.cover, alt: "", loading: "lazy", decoding: "async",
              style: { width: "100%", maxHeight: "96px", objectFit: "cover", borderRadius: "6px" },
              onError: (e) => { e.target.style.display = "none"; },
            })
            : null,
          React.createElement("div", { style: PET_STYLE.title }, s.title || s.id),
          React.createElement("div", { style: PET_STYLE.meta }, petFmtBytes(s.bytes)),
          React.createElement("div", { style: PET_STYLE.row },
            btn(isBusy ? weT("安装中…") : weT("安装"), () => act("install", { id: s.id }, s.title || s.id), Boolean(busy))),
        );
      }),
    ));
  } else if (!site.length) {
    children.push(React.createElement("div", { key: "siteEmpty", className: "we-picker__hint", style: { marginTop: "6px" } },
      weT("站点上还没有桌宠。")));
  }

  return React.createElement("div", { className: "we-picker__section" }, children);
}

/** 页签组装点调用它。 */
function renderPetsTab() {
  return React.createElement(PetsTabPanel, null);
}
