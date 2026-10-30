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
        // 皮肤中心在不在跑，**由浏览器判定**，不信宿主探测的结论。
        // 宿主 fetch 不带会话：`/api/**` 一旦被鉴权挡在前面就只会拿到 401，而 401 既可能是
        // "装了但需要会话"也可能是"路由没挂载"，从宿主那一侧**无法区分**（实测踩过：
        // 报文纯 401 就把整个页签的「应用」按钮锁死）。浏览器同源请求天然带会话，
        // 拿得到就是真在跑，拿不到再退回宿主给的三态。
        if (doc.skinCenter !== "present") {
          try {
            const cat = await apiJson("/api/skin-center/v2/catalog", { parse: "always" });
            if (cat && cat.ok && cat.data && cat.data.ok) doc.skinCenter = "present";
          } catch { /* 仍旧用宿主给的状态 */ }
        }
        // 读"当前在用哪套皮肤"：**先直连**（同源相对路径 `/api/**`，凭据天然带全），
        // 直连不通（页面的 origin 可能不等于宿主 HTTP 服务的 origin ⇒ 路由没到）再退回宿主代理
        // `/folia/skins/active` —— 代理会把浏览器这一侧的 cookie 与同源头转发过去。
        if (doc.skinCenter === "present") {
          try {
            let a = await apiJson("/api/skin-center/v2/active", { parse: "always" });
            if (!(a && a.ok)) a = await apiJson("/skins/active", { parse: "always" });
            if (a && a.ok) doc.active = (a.data && a.data.active) || "";
          } catch { /* 读不到就显示"无使用中" */ }
        }
        setState(doc);
        if (doc.siteError && doc.siteError !== "site-off") {
          // `site-locked` = 站点整站上锁（登录页 + {"code":"site_locked"}），不是网络/插件问题。
          // 给它一句能照做的说明，而不是甩一个 http-401（实测：这个错误码让人误判成插件坏了）。
          const msg = doc.siteError === "site-locked"
            ? weT("站点已锁定：只对已登录的管理员开放（需站点侧放行 GET /api/public/wallpapers）")
            : String(doc.siteError);
          setNote({ ok: false, text: weT("站点清单读不到：{msg}", { msg }) });
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
      if (kind === "activate") {
        const wantId = (payload && payload.id) || null;
        // ⚠️ 这里写入的必须是**皮肤中心自己认识的 id**（= skin.json 里的原始 id），
        // 不能用归一键：归一只是用来"比对"，拿去当写值会变成另一个名字 ——
        // 皮肤中心的 activePostHandler 对解析不到的 id 回 404 skin-not-found（实测报错 skin-center-404）。
        if (wantId) {
          const local = ((state && state.installed) || []).find((s) => s.id === wantId);
          if (!local) {
            setNote({ ok: false, text: weT("这个皮肤不在本机（先安装）") });
            return;
          }
        }
        // 写入有两条路，**先直连、再代理**：
        //   ① 直连：相对 `/api/skin-center/v2/active`（同源、凭据天然带全）。
        //      前提是页面的 origin 就是宿主 HTTP 服务那个源；桌面端内嵌页面的 origin 未必是它 ⇒ 路由没到 ⇒ 404。
        //   ② 代理：`/folia/skins/activate`，宿主把浏览器这侧的 cookie 与同源头转发给皮肤中心。
        //      这条在"origin 不一致"时仍然成立，所以作为兜底存在。
        // 两条都失败时把两边的状态码都显示出来 —— 下一次不用再猜是哪一段断的。
        const direct = await apiPostJson("/api/skin-center/v2/active", { active: wantId }, { parse: "always" });
        let resp = direct;
        if (!(resp && resp.ok)) {
          resp = await apiPostJson("/skins/activate", { id: wantId || "" }, { parse: "always" });
        }
        if (!(resp && resp.ok)) {
          const up = (resp && resp.data && resp.data.upstream) || null;
          const det = (up && up.error) ? ":" + up.error
            : ((resp && resp.data && resp.data.error) ? ":" + resp.data.error : "");
          setNote({
            ok: false,
            text: weT("操作失败：{code}", {
              code: "direct=" + ((direct && direct.status) || 0) + " proxy=" + ((resp && resp.status) || 0) + det,
            }),
          });
          return;
        }
        // 关键：让**皮肤赢**。皮肤中心检测到 `body[data-we-wallpaper]` 时会**主动停画**
        // （它的 withhold 合约：壁纸在台时它不上台），所以"写成功但画面不变"完全合理 ——
        // 用户在这个页签点「应用」，意图就是让皮肤接管外观，因此这里主动进入「皮肤让路」态：
        // 清掉我们的壁纸层 + 摘下玻璃门控（client.js 里既有的 enterSkinYield，记忆会落盘，
        // 点「恢复默认外观」时按记忆放回壁纸）。
        try {
          if (wantId && typeof enterSkinYield === "function") enterSkinYield("folia-tab-apply");
          if (!wantId && typeof exitSkinYield === "function") exitSkinYield("folia-tab-clear");
        } catch { /* 让路是增强：失败也不影响皮肤中心的写入 */ }
        // 两条收敛路径：① 广播皮肤中心自己监听的 `dsh-skin-applied`（立即就地切换）；
        // ② 它另外每 2 秒轮询 /api/skin-center/v2/active（事件丢了也会在 2 秒内跟上）。
        try {
          window.dispatchEvent(new CustomEvent("dsh-skin-applied", { detail: { id: wantId } }));
        } catch { /* 老环境没有 CustomEvent 也无所谓，②会兜住 */ }
        setNote({
          ok: true,
          text: wantId
            ? weT("已切换到：{name}（本插件的壁纸与玻璃已让位）", { name: label || "" })
            : weT("已恢复官方默认外观（壁纸已按记忆放回）"),
        });
        await load(true);
        return;
      }

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
  // 用户在插件市场里手动禁用了它 —— 这是最准确的原因，优先于所有 http 状态码推测。
  const marketDisabled = Boolean(state && state.skinCenterDisabled);
  // `present` 是**唯一**允许点「应用」的状态：只有真的拿到 catalog JSON 才算它在跑。
  // `absent`=路由不存在（插件没装/未启用）；`auth-gated`=鉴权在路由前面挡住（无法判定）；
  // `unknown`=探测失败。后三种都如实告诉用户"现在点应用不会成功"，而不是让他点了看 404。
  const canApply = skinCenter === "present";
  if (marketDisabled) {
    children.push(React.createElement("div", {
      key: "hint-disabled",
      className: "we-picker__hint",
      style: { margin: "6px 0 4px", color: "#ffd08a", lineHeight: "1.6" },
    }, weT("皮肤中心被**你在插件市场里禁用了**（市场记录里它在 disabled 列表里）。皮肤的实际渲染方就是它，禁用它 ⇒ 这里只能装/卸皮肤包，不能应用。到插件市场把它重新启用即可（dsh-folia 已把它作为依赖随身携带，不需要另装）。")));
  } else if (skinCenter === "absent") {
    children.push(React.createElement("div", {
      key: "hint-absent",
      className: "we-picker__hint",
      style: { margin: "6px 0 4px", color: "#ffd08a", lineHeight: "1.6" },
    }, weT("皮肤中心**没在运行**（它的 /api/skin-center/v2/* 路由不存在）。它是独立插件 @linxin666/dsh-client-ui-skin-center；常见原因是版本与当前桌面端不匹配 —— 0.4.9+ 要求 dsh ≥ 0.2.1-rc.3，而本机是 rc.2，市场会把这条行保持为 off。装/降级到 0.4.8 即可：")));
    children.push(React.createElement("div", { key: "cmd", style: { display: "flex", gap: "8px", alignItems: "center", margin: "0 0 6px" } },
      React.createElement("code", {
        style: { fontSize: "11px", padding: "3px 8px", borderRadius: "6px", background: "rgba(255,255,255,0.08)" },
      }, "dsh plugin --profile web add @linxin666/dsh-client-ui-skin-center@0.4.8"),
      React.createElement("button", {
        className: "we-picker__btn", type: "button",
        onClick: () => { try { navigator.clipboard.writeText("dsh plugin --profile web add @linxin666/dsh-client-ui-skin-center@0.4.8"); setNote({ ok: true, text: weT("已复制安装命令") }); } catch { setNote({ ok: false, text: weT("复制失败，请手动选中上面的命令") }); } },
      }, weT("复制命令")),
    ));
  } else if (skinCenter === "auth-gated" || skinCenter === "unknown") {
    children.push(React.createElement("div", {
      key: "hint-unknown",
      className: "we-picker__hint",
      style: { margin: "6px 0 4px", color: "#ffd08a", lineHeight: "1.6" },
    }, skinCenter === "auth-gated"
      ? weT("读不到皮肤中心的清单（浏览器侧也被鉴权挡住）。先点一次「刷新」；仍不行就说明它没在运行 —— 去设置里确认皮肤中心已启用。")
      : weT("皮肤中心状态未知（探测超时/网络错误）。点「刷新」重试。")));
  } else {
    children.push(React.createElement("div", {
      key: "hint",
      className: "we-picker__hint",
      style: { margin: "6px 0 4px", opacity: 0.8 },
    }, weT("本页签可以直接切换皮肤：装完点「应用」即可，无需打开设置页。皮肤包落在皮肤中心目录，两边读同一份。")));
  }
  // 皮肤中心不在跑时，「应用」按钮直接禁用并给出原因 —— 比"点了报错"诚实。
  const applyBlockedReason = canApply ? "" : weT("读不到皮肤中心的清单，先点「刷新」；仍不行说明它没在运行");

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

  /**
   * 站点条目 → 本机已装皮肤的真实 id（皮肤中心只认这个）。
   *
   * 站点 slug 由标题生成、并为"全站唯一"可能被加 `skin-` 前缀；本机目录/皮肤中心用的是
   * skin.json 里的 id。两者可能不同（实测：站点 windows-xp-luna ↔ 本机 xp）。
   * 先按归一的 id 比，再按标题兜底；都没有就返回空串（表示"本机没有这一套"）。
   */
  const localIdOf = (siteItem) => {
    const list = (state && state.installed) || [];
    const byId = list.find((x) => normSkinId(x.id) === normSkinId(siteItem.id));
    if (byId) return byId.id;
    const wantTitle = String((siteItem && siteItem.title) || "").trim();
    if (!wantTitle) return "";
    const byTitle = list.find((x) => String(x.name || "").trim() === wantTitle);
    return byTitle ? byTitle.id : "";
  };
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
          // 皮肤中心**没收录**这套（它有自己的 manifest 规则）⇒ 应用后它会回退到内置默认款，
          // 用户看到的是"点哪套都不变"。这是实测症状（别人机器上"只剩鲸鱼娘"），所以这里
          // 直接把原因与「应用」的禁用一起给出来，而不是让人一遍遍点。
          const notListed = s.inCatalog === false;
          const notListedWhy = notListed
            ? weT("皮肤中心没有收录这套（它的 manifest 规则更严：id 必须等于目录名、必须 v2、name/nameEn/author/stylesheet 齐全）")
            : "";
          return React.createElement("div", {
            key: s.id,
            style: isActive ? { ...SKIN_STYLE.card, borderColor: "rgba(120,220,150,0.75)" } : SKIN_STYLE.card,
          },
          React.createElement("div", { style: { ...SKIN_STYLE.title, color: s.accent || undefined } },
            (isActive ? weT("✓ ") : "") + (s.name || s.id)),
          React.createElement("div", { style: SKIN_STYLE.meta },
            [s.version ? "v" + s.version : "", skinFmtBytes(s.bytes), s.hasHooks ? weT("含动效钩子") : "",
              notListed ? weT("皮肤中心未收录") : ""]
              .filter(Boolean).join(" · ")),
          React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
            // 「应用」= 写皮肤中心的 active + 广播 `dsh-skin-applied`，就地切换（不刷新页面）。
            isActive
              ? React.createElement("span", { style: { ...SKIN_STYLE.badge, background: "rgba(60,160,90,0.55)" } }, weT("使用中"))
              : React.createElement("button", {
                className: "we-picker__btn", type: "button",
                disabled: Boolean(busy) || !canApply || notListed,
                title: notListed ? notListedWhy : (applyBlockedReason || undefined),
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
        // 站点条目的 slug 与本机皮肤 id **不一定相同**（站点 slug 由标题生成/为避撞名会加 skin- 前缀），
        // 而皮肤中心只认 skin.json 里的原始 id ⇒ 写之前必须换成**本机那个 id**，
        // 否则它的 activePostHandler 会回 404 skin-not-found（实测报错 skin-center-404）。
        const localId = localIdOf(s);
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
              ? [
                localId && isActiveSkin(localId)
                  ? React.createElement("span", { key: "on", style: { ...SKIN_STYLE.badge, background: "rgba(60,160,90,0.55)" } }, weT("使用中"))
                  : React.createElement("button", {
                    key: "apply",
                    className: "we-picker__btn", type: "button",
                    disabled: Boolean(busy) || !canApply,
                    title: applyBlockedReason || undefined,
                    onClick: () => act("activate", { id: localId }, s.title),
                  }, busy === "activate:" + localId ? weT("切换中…") : weT("应用")),
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
