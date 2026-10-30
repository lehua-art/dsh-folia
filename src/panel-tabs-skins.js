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

/**
 * 皮肤 id 的归一键：站点上的 slug 是**全站唯一**的，撞名时上传工具会加 `skin-` 前缀
 * （实测：blue-throated-bee-eater 同时是桌宠 id ⇒ 站上叫 skin-blue-throated-bee-eater），
 * 而本机目录名用的是 skin.json 里的原始 id。两边比对必须先归一，否则"已安装"会显示成未安装。
 */
function normSkinId(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s.startsWith("skin-") ? s.slice(5) : s;
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
        // 顺带问一下当前在用哪套皮肤（皮肤中心没装时它会 409，忽略即可 —— 页签本来就会提示"缺插件"）
        if (doc.skinCenter === "present") {
          try {
            const a = await apiJson("/skins/active", { parse: "always" });
            const ad = (a && a.data) || null;
            if (a && a.ok && ad && ad.ok) doc.active = ad.active || "";
          } catch { /* 读不到就显示"无使用中" */ }
        }
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
    // 结构性操作才锁整块 UI；`activate` 是幂等的、而且要让人能连点换皮肤，所以不锁。
    const structural = kind === "install" || kind === "remove";
    if (structural) setBusy(kind + ":" + ((payload && payload.id) || ""));
    if (kind === "activate") setBusy("activate:" + ((payload && payload.id) || ""));
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
              : weT("已安装：{name} —— 点「应用」就能切换", { name: label || "" }),
          });
        }
        if (kind === "remove") setNote({ ok: true, text: weT("已卸载：{name}", { name: label || "" }) });
        if (kind === "activate") {
          // 两条收敛路径：① 广播皮肤中心自己监听的 `dsh-skin-applied`（立即就地切换）；
          // ② 它另外每 2 秒轮询 /api/skin-center/v2/active（事件丢了也会在 2 秒内跟上）。
          try {
            window.dispatchEvent(new CustomEvent("dsh-skin-applied", { detail: { id: (payload && payload.id) || null } }));
          } catch { /* 老环境没有 CustomEvent 也无所谓，②会兜住 */ }
          setNote({
            ok: true,
            text: payload && payload.id
              ? weT("已切换到：{name}", { name: label || "" })
              : weT("已恢复官方默认外观"),
          });
        }
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
          'not-installed': weT("这个皮肤不在本机（先安装）"),
          'skin-center-missing': weT("装皮肤中心后才能切换皮肤（见下面的安装命令）"),
          'bad-id': weT("皮肤 id 不合法"),
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

  // 皮肤中心在不在，决定这段提示说什么：
  //   在   → "装完去皮肤中心点它"（本页签只负责落盘）
  //   不在 → 明说它是个**独立插件**（不在 dsh-web-all 里），给一条可复制的安装命令
  //   unknown（探测失败）→ 保守地按"在"讲，不吓唬用户
  const skinCenter = (state && state.skinCenter) || "unknown";
  if (skinCenter === "absent") {
    children.push(React.createElement("div", {
      key: "hint-absent",
      className: "we-picker__hint",
      style: { margin: "6px 0 4px", color: "#ffd08a", lineHeight: "1.6" },
    }, weT("皮肤中心没装：它是**独立插件** @linxin666/dsh-client-ui-skin-center（不在 dsh-web-all 里，那个只是聚合包）。装它才能启用皮肤：")));
    children.push(React.createElement("div", { key: "cmd", style: { display: "flex", gap: "8px", alignItems: "center", margin: "0 0 6px" } },
      React.createElement("code", {
        style: { fontSize: "11px", padding: "3px 8px", borderRadius: "6px", background: "rgba(255,255,255,0.08)" },
      }, "dsh plugin --profile web add @linxin666/dsh-client-ui-skin-center"),
      React.createElement("button", {
        className: "we-picker__btn", type: "button",
        onClick: () => { try { navigator.clipboard.writeText("dsh plugin --profile web add @linxin666/dsh-client-ui-skin-center"); setNote({ ok: true, text: weT("已复制安装命令") }); } catch { setNote({ ok: false, text: weT("复制失败，请手动选中上面的命令") }); } },
      }, weT("复制命令")),
    ));
  } else {
    children.push(React.createElement("div", {
      key: "hint",
      className: "we-picker__hint",
      style: { margin: "6px 0 4px", opacity: 0.8 },
    }, weT("本页签可以直接切换皮肤：装完点「应用」即可，无需打开设置页。皮肤包落在皮肤中心目录，两边读同一份。")));
  }

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
  const activeId = (state && state.active) || "";
  /** 这个 id 是不是"正在用"的那套（两边都归一后比，站点 slug 可能带 skin- 前缀）。 */
  const isActiveSkin = (id) => Boolean(activeId) && normSkinId(activeId) === normSkinId(id);
  if (state) {
    children.push(React.createElement("div", { key: "installed-head", className: "we-picker__hint" },
      weT("本机已装（{n}）", { n: installed.length }),
      activeId ? weT(" · 使用中：{name}", { name: activeId }) : ""));
    // 「恢复默认」：清空选择、回到官方外观。只有确实有皮肤在用的时候才有意义。
    if (activeId) {
      children.push(React.createElement("button", {
        key: "clear",
        className: "we-picker__btn", type: "button",
        style: { alignSelf: "flex-start", margin: "0 0 6px" },
        disabled: Boolean(busy),
        onClick: () => act("activate", { id: "" }, ""),
      }, busy === "activate:" ? weT("正在恢复…") : weT("恢复默认外观")));
    }
    children.push(React.createElement("div", { key: "installed", style: SKIN_STYLE.grid },
      installed.length === 0
        ? [React.createElement("span", { key: "none", className: "we-picker__hint" }, weT("还没有安装任何皮肤 —— 从下面的站点清单里挑一个。"))]
        : installed.map((s) => {
          const isActive = isActiveSkin(s.id);
          const busyThis = busy === "activate:" + s.id;
          return React.createElement("div", {
            key: s.id,
            style: isActive ? { ...SKIN_STYLE.card, borderColor: "rgba(120,220,150,0.75)" } : SKIN_STYLE.card,
          },
          React.createElement("div", { style: { ...SKIN_STYLE.title, color: s.accent || undefined } },
            (isActive ? weT("✓ ") : "") + (s.name || s.id)),
          React.createElement("div", { style: SKIN_STYLE.meta },
            [s.version ? "v" + s.version : "", skinFmtBytes(s.bytes), s.hasHooks ? weT("含动效钩子") : ""]
              .filter(Boolean).join(" · ")),
          React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
            // 「应用」= 写皮肤中心的 active + 广播 `dsh-skin-applied`，就地切换（不刷新页面）。
            isActive
              ? React.createElement("span", { style: { ...SKIN_STYLE.badge, background: "rgba(60,160,90,0.55)" } }, weT("使用中"))
              : React.createElement("button", {
                className: "we-picker__btn", type: "button",
                disabled: Boolean(busy),
                onClick: () => act("activate", { id: s.id }, s.name),
              }, busyThis ? weT("切换中…") : weT("应用")),
            React.createElement("button", {
              className: "we-picker__btn", type: "button",
              disabled: Boolean(busy) || isActive,
              title: isActive ? weT("正在使用，先切到别的再卸") : undefined,
              onClick: () => act("remove", { id: s.id }, s.name),
            }, busy === "remove:" + s.id ? weT("卸载中…") : weT("卸载")),
          ),
        );
        }),
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
          React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
            s.installed
              // 已装的站点卡片也要能**直接应用**：用户是照着站点缩略图挑的，
              // 让他再滚回上面的「本机已装」区去点一次是多余的一步（实测反馈）。
              // 站点 slug 与本机目录名可能差一个 `skin-` 前缀 ⇒ 用归一后的比较。
              ? [
                isActiveSkin(s.id)
                  ? React.createElement("span", { key: "on", style: { ...SKIN_STYLE.badge, background: "rgba(60,160,90,0.55)" } }, weT("使用中"))
                  : React.createElement("button", {
                    key: "apply",
                    className: "we-picker__btn", type: "button",
                    disabled: Boolean(busy),
                    onClick: () => act("activate", { id: normSkinId(s.id) }, s.title),
                  }, busy === "activate:" + normSkinId(s.id) ? weT("切换中…") : weT("应用")),
                React.createElement("span", { key: "done", style: SKIN_STYLE.badge }, weT("已安装")),
              ]
              : React.createElement("button", {
                className: "we-picker__btn", type: "button",
                disabled: Boolean(busy),
                title: skinCenter === "absent" ? weT("先装皮肤中心，否则皮肤装好也没法启用") : undefined,
                onClick: () => act("install", { id: s.id, url: s.url }, s.title),
              }, busyThis ? weT("安装中…") : weT("安装")),
          ),
        );
      }),
  ));

  return React.createElement("div", { className: "we-picker", style: { display: "flex", flexDirection: "column" } }, children);
}
