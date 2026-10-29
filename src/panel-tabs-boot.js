/**
 * panel-tabs-boot.js — 「开机动画」页签（放在「壁纸」左侧）。
 *
 * 它只做四件事：看候选、下载、选一个、开关。**播放不在这里** —— 播放发生在启动那一刻，
 * 由宿主注入的脚本完成（`lib/boot/index.js` 的 BOOT_SCREEN_SOURCE），因为那时候应用
 * 还没挂载，任何 React 组件都还不存在。
 *
 * 数据全部来自宿主（`/folia/boot/*`），浏览器不直连站点：
 *   GET  /folia/boot/list      候选 + 本地状态
 *   POST /folia/boot/download  下一条到本地
 *   POST /folia/boot/select    选中并启用
 *   POST /folia/boot/toggle    开/关
 *   POST /folia/boot/settings  淡出/最短显示/最长停留
 *   POST /folia/boot/remove    删本地
 */

function bootFmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  if (v >= 1024) return Math.round(v / 1024) + " KB";
  return v + " B";
}

const BOOT_STYLE = {
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "10px", marginTop: "8px" },
  card: {
    display: "flex", flexDirection: "column", gap: "6px", padding: "9px 10px",
    border: "1px solid rgba(255,255,255,0.12)", borderRadius: "10px", background: "rgba(255,255,255,0.04)",
  },
  title: { fontSize: "12.5px", fontWeight: 600 },
  meta: { fontSize: "11px", opacity: 0.62 },
  row: { display: "flex", gap: "6px", alignItems: "center" },
};

function BootTabPanel() {
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState("");
  const [note, setNote] = React.useState(null);
  // 下载没有进度通道（宿主一次性 fetch 完才返回），但等待必须"看得见"：
  // 每秒 +1 的秒表足以让用户知道它没卡死。
  const [tick, setTick] = React.useState(0);

  const load = React.useCallback(async (force) => {
    try {
      const resp = await apiJson("/boot/list" + (force ? "?refresh=1" : ""), { parse: "always" });
      const r = (resp && resp.data) || null;
      setState(r || { ok: false, clips: [], error: "network" });
    } catch (e) {
      setState({ ok: false, clips: [], error: "network" });
    }
  }, []);

  React.useEffect(() => { load(false); }, [load]);

  React.useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function act(kind, payload, label) {
    if (busy) return;
    setBusy(payload && payload.id ? payload.id : kind);
    setTick(0);
    setNote(null);
    try {
      const resp = await apiPostJson("/boot/" + kind, payload || {}, { parse: "always" });
      const r = (resp && resp.data) || null;
      if (resp && resp.ok && r && r.ok) {
        if (kind === "download") setNote({ ok: true, text: weT("已下载：{name}", { name: label }) });
        if (kind === "select") setNote({ ok: true, text: weT("已选中「{name}」，下次启动生效", { name: label }) });
        if (kind === "remove") setNote({ ok: true, text: weT("已删除：{name}", { name: label }) });
        if (kind === "toggle") setNote({ ok: true, text: payload.enabled ? weT("开机动画已开启") : weT("开机动画已关闭") });
        if (kind === "settings") setNote({ ok: true, text: weT("已保存") });
        await load(true);
      } else {
        const code = (r && r.error) || "failed";
        setNote({ ok: false, text: r && r.detail ? weT("操作失败：{code}（{detail}）", { code, detail: String(r.detail) }) : weT("操作失败：{code}", { code }) });
      }
    } catch (e) {
      setNote({ ok: false, text: weT("请求失败：{msg}", { msg: (e && e.message) ? e.message : weT("网络错误") }) });
    } finally {
      setBusy("");
    }
  }

  const clips = (state && state.clips) || [];
  const enabled = Boolean(state && state.enabled);
  const activeId = (state && state.clipId) || "";
  const installedCount = clips.filter((c) => c.installed).length;

  const children = [];

  children.push(React.createElement("div", { className: "we-picker__section-head", key: "head" },
    React.createElement("span", { className: "we-picker__section-label" }, weT("🎬 开机动画")),
    React.createElement("button", {
      type: "button", className: "we-picker__btn", style: { marginLeft: "auto" },
      disabled: Boolean(busy), onClick: () => load(true),
    }, weT("刷新")),
  ));

  // 开关 + 当前选择
  children.push(React.createElement("div", {
    key: "switch", style: { ...BOOT_STYLE.row, margin: "6px 0 2px", flexWrap: "wrap" },
  },
  React.createElement("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" } },
    React.createElement("input", {
      type: "checkbox", checked: enabled, disabled: Boolean(busy) || !activeId,
      onChange: (e) => act("toggle", { enabled: e.target.checked }, ""),
    }),
    weT("启用（下次启动播放）"),
  ),
  React.createElement("span", { className: "we-picker__hint" },
    activeId ? weT("当前：{name}", { name: (clips.find((c) => c.id === activeId) || {}).title || activeId }) : weT("未选择")),
  ));

  children.push(React.createElement("div", { key: "hint", className: "we-picker__hint", style: { margin: "2px 0 6px", opacity: 0.75 } },
    weT("下载一条并「使用」后，每次启动都会先播它；默认播完才淡出进入界面。点击或按 Esc 可立即跳过。「带声音」若被浏览器的自动播放策略拦下，会自动退回静音播放。")));

  if (state && state.error && !clips.length) {
    children.push(React.createElement("div", { key: "err", className: "we-picker__hint", style: { color: "#ff9a9a" } },
      weT("候选清单读不到：{msg}", { msg: String(state.error) })));
  }

  if (note) {
    children.push(React.createElement("div", { key: "note", className: "we-picker__hint", style: { color: note.ok ? "#8ee6a8" : "#ff9a9a", margin: "4px 0 8px" } }, note.text));
  }

  // 淡出 / 停留
  if (state) {
    const opt = (label, key, list) => React.createElement("label", { style: { display: "flex", gap: "4px", alignItems: "center", fontSize: "12px" } },
      label,
      React.createElement("select", {
        className: "we-picker__playlist-select",
        value: String(state[key]),
        disabled: Boolean(busy),
        onChange: (e) => act("settings", { [key]: Number(e.target.value) }, ""),
      }, list.map(([v, t]) => React.createElement("option", { key: v, value: String(v) }, t))),
    );
    children.push(React.createElement("div", { key: "opts", style: { ...BOOT_STYLE.row, gap: "14px", flexWrap: "wrap", margin: "2px 0 8px" } },
      // 进入方式：默认「播完再进」——之前只有「就绪即进」，15 秒的片子 1.2 秒就被掐掉。
      React.createElement("label", { style: { display: "flex", gap: "4px", alignItems: "center", fontSize: "12px" } },
        weT("进入方式"),
        React.createElement("select", {
          className: "we-picker__playlist-select",
          value: String(state.enterMode || "tail"),
          disabled: Boolean(busy),
          onChange: (e) => act("settings", { enterMode: e.target.value }, ""),
        },
        React.createElement("option", { value: "tail" }, weT("播完再进（默认）")),
        React.createElement("option", { value: "ready" }, weT("界面就绪就进")),
        React.createElement("option", { value: "click" }, weT("点一下才进")),
        ),
      ),
      opt(weT("淡出时长"), "fadeMs", [[400, weT("0.4 秒")], [600, weT("0.6 秒")], [900, weT("0.9 秒")], [1200, weT("1.2 秒")], [1600, weT("1.6 秒")]]),
      // 声音：默认关（带声音的自动播放会被浏览器策略拦）。打开后若仍被拦，
      // 脚本会自动退回静音播放 —— 画面优先，不会黑屏。
      React.createElement("label", { style: { display: "flex", gap: "6px", alignItems: "center", fontSize: "12px" } },
        React.createElement("input", {
          type: "checkbox",
          checked: Boolean(state.sound),
          disabled: Boolean(busy),
          onChange: (e) => act("settings", { sound: e.target.checked }, ""),
        }),
        weT("带声音"),
      ),
      opt(weT("最短显示"), "minShowMs", [[0, weT("不限制")], [600, weT("0.6 秒")], [1200, weT("1.2 秒")], [2000, weT("2 秒")]]),
      opt(weT("最长停留"), "maxHoldMs", [[10000, weT("10 秒")], [20000, weT("20 秒（默认）")], [30000, weT("30 秒")], [60000, weT("60 秒")]]),
    ));
  }

  children.push(React.createElement("div", { key: "count", className: "we-picker__hint", style: { margin: "2px 0 4px" } },
    weT("已下载 {done} / {total}", { done: installedCount, total: clips.length })));

  if (clips.length) {
    children.push(React.createElement("div", { key: "grid", style: BOOT_STYLE.grid },
      clips.map((c) => {
        const isBusy = busy === c.id;
        const isActive = c.id === activeId;
        const btn = (label, onClick, disabled, primary) => React.createElement("button", {
          type: "button",
          className: "we-picker__btn" + (primary ? " we-picker__btn--primary" : ""),
          style: { flex: "1 1 0", fontSize: "11.5px", padding: "4px 6px" },
          disabled: Boolean(disabled) || Boolean(busy),
          onClick,
        }, label);
        const actions = [];
        if (!c.installed) {
          actions.push(btn(isBusy ? weT("下载中… {s}s", { s: tick }) : weT("下载"), () => act("download", { id: c.id }, c.title), false, true));
        } else if (!isActive) {
          actions.push(btn(weT("使用"), () => act("select", { id: c.id }, c.title), false, true));
          actions.push(btn(weT("删除"), () => act("remove", { id: c.id }, c.title), isBusy, false));
        } else {
          actions.push(btn(weT("使用中"), () => {}, true, false));
        }
        return React.createElement("div", { key: c.id, style: BOOT_STYLE.card },
          // 封面：站点给了真正的缩略图才显示；老条目没有就留空（不显示破图）。
          c.cover
            ? React.createElement("img", {
                src: c.cover, alt: "", loading: "lazy", decoding: "async",
                style: { width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "6px", background: "rgba(0,0,0,0.3)" },
                onError: (e) => { e.target.style.display = "none"; },
              })
            : null,
          React.createElement("div", { style: BOOT_STYLE.title }, c.title || c.id),
          React.createElement("div", { style: BOOT_STYLE.meta },
            [c.durationSec ? Number(c.durationSec).toFixed(1) + "s" : null,
             bootFmtBytes(c.localBytes || c.bytes)].filter(Boolean).join(" · ")),
          c.faststart === false
            ? React.createElement("div", { style: { ...BOOT_STYLE.meta, color: "#ffd08a" } }, weT("未做 faststart，播放可能更慢"))
            : null,
          React.createElement("div", { style: { ...BOOT_STYLE.row, marginTop: "4px" } }, actions),
        );
      })));
  } else if (state) {
    children.push(React.createElement("div", { key: "empty", className: "we-picker__empty" },
      React.createElement("span", { className: "we-picker__empty-title" }, weT("没有可用的开机动画")),
      React.createElement("span", { className: "we-picker__hint" }, weT("素材来自站点；站点不可达时这里为空，但不影响启动"))));
  }

  return React.createElement(React.Fragment, null, children);
}

function renderBootTab() {
  return React.createElement(BootTabPanel, null);
}

export { BootTabPanel, renderBootTab };
