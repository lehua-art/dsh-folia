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

/**
 * 兜底核对（4.23.6）：`/skins/list` 的 `installed` 是"到底装没装"的**唯一真源**。
 *
 * 用在三个"前端已经等不到结果"的时刻：
 *   ① 宿主回的 jobId 在 `/downloads/list` 里**连续查不到**（宿主重启 / 队列被重置 / job 被清理）；
 *   ② 等到了 30 分钟上界；
 *   ③ 发安装请求**之前**（已经装好就别再触发一次解压 —— "装了两遍"的客户端半边）。
 * 比对走 `skinInstalledMatch()`（**目录名 / skin.json.id / catalog id 三者任一命中**）：
 * 站点 slug 与本机目录名不总相同，只比一个名字就是"装好了却显示没装"的来源。
 */
async function skinInstalledNow(rawId) {
  const want = String(rawId || "").trim();
  if (!want) return false;
  try {
    // 不带 `refresh=1`：`installed` 是宿主每次请求现读磁盘（`listInstalled()`），不必触发站点重扫。
    const resp = await apiJson("/skins/list", { parse: "always" });
    const doc = (resp && resp.data) || null;
    const list = (doc && Array.isArray(doc.installed)) ? doc.installed : [];
    return skinInstalledMatch(list, want);
  } catch { return false; }
}

function SkinsTabPanel() {
  const [state, setState] = React.useState(null);
  const [busy, setBusy] = React.useState("");
  // 给"静默对账"用的只读镜像：定时器/可见性回调里不能读闭包里的旧 `busy`（会一直看到 ""），
  // 用一个 ref 跟住最新值，操作进行中就不打扰用户。
  const busyRef = React.useRef("");
  const [note, setNote] = React.useState(null);
  // 4.23.3：安装/下载进度以 /folia/downloads/list 为真源（kind=skin），切页签回来仍在。
  const dl = useDownloadJobs();
  // 4.23.4：**卡片级**状态机（四页签共用，见 src/local-first.js 的 `dlCardState`）——
  // idle→submitting→queued→running→installing→done，失败带原因 +「重试」。
  const cards = useDlCards(dl);
  // 4.23.14：300ms 占位要知道"队列里是不是已经有这张卡片的 queued/running"。
  // 直接用渲染闭包里的 `dl.jobs` 会读到**点击那一刻**的旧快照（定时器触发时不会重渲染），
  // 所以用一个 ref 跟住最新值（与 busyRef 同一手法）。
  const jobsRef = React.useRef([]);
  jobsRef.current = dl.jobs;
  // 状态机里只有两个词是"本模块自己的口径"：空闲时按什么、完成后叫什么。
  // 其余（正在提交… / 排队中：前面还有 N 个 / 下载中… x% / 解压/落位中… / 重试 / 失败原因）
  // 全部来自共用函数，四个页签逐字一致。
  const skinDlLabels = { idle: weT("安装"), done: weT("已安装"), failed: weT("重试") };

  // ⚠️ 这两面旗必须**在函数体最前面**算出来：下面「刷新」按钮的文案就要用它。
  // 曾把它们写在列表渲染处（更靠后）⇒ 首次渲染读到 TDZ 里的 const
  // ⇒ `Cannot access 'busyIsStructural' before initialization` ⇒ 整页被守卫接住变红。
  // 教训：渲染函数里任何"靠后声明的 const"都可能被靠前的 JSX 读到，声明一律前置。
  const busyIsStructural = /^(install|remove|repair):/.test(String(busy || ""));
  const busyIsActivating = /^activate:/.test(String(busy || ""));

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

  // 与外部改动**保持同步**：皮肤可能在皮肤中心那边被删/装，也可能在另一个窗口里操作。
  // 之前只在挂载时拉一次 ⇒ 那边删了，这边还列着（点了才失败，看起来像"没同步"）。
  // 三条腿都只做"重拉一次列表"，不做别的：
  //   ① 页签重新可见（switch 回来）② 窗口重新获得焦点 ③ 每 20 秒的轻量对账
  // 轻量对账只在**没有正在进行的操作**时跑，避免把用户刚点的"安装中…"状态冲掉。
  React.useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") return undefined;
    let timer = null;
    const refreshQuietly = () => { try { if (!busyRef.current) load(false); } catch { /* ignore */ } };
    const onVisible = () => { try { if (document.visibilityState === "visible") refreshQuietly(); } catch { /* ignore */ } };
    try { document.addEventListener("visibilitychange", onVisible); } catch { /* ignore */ }
    try { window.addEventListener("focus", refreshQuietly); } catch { /* ignore */ }
    try { timer = window.setInterval(refreshQuietly, 20000); } catch { timer = null; }
    return () => {
      try { document.removeEventListener("visibilitychange", onVisible); } catch { /* ignore */ }
      try { window.removeEventListener("focus", refreshQuietly); } catch { /* ignore */ }
      if (timer !== null) { try { window.clearInterval(timer); } catch { /* ignore */ } }
    };
  }, [load]);

  // 4.23.3：切走再回来不丢「正在下载皮肤包」——以 /downloads/list 为真源恢复提示。
  // 宿主侧的 scheduleFinishInstall 会在下载完成后自己再装一次，所以这里只需要"看得见"：
  // 挂载时若已有 kind=skin 的 queued|running job，就显示进度并在结束后重拉清单。
  React.useEffect(() => {
    let alive = true;
    (async () => {
      let active;
      try {
        const list = await apiJson("/downloads/list");
        const doc = (list && list.data) || list || {};
        const jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
        active = jobs.find((j) => j && j.kind === "skin" && (j.status === "queued" || j.status === "running")) || null;
      } catch { active = null; }
      if (!alive || !active) return;
      setNote({
        ok: true,
        text: weT("正在下载（皮肤包）{p}%（{a}/{b} MB）", {
          p: Number(active.percent) || 0,
          a: ((Number(active.received) || 0) / 1048576).toFixed(1),
          b: ((Number(active.total) || 0) / 1048576).toFixed(1),
        }),
      });
      await dlAwaitJob(active.id);
      if (!alive) return;
      await load(true);
    })();
    return () => { alive = false; };
  }, [load]);

  // 4.23.6：**挂载自愈** —— 队列里 job 已经 `done`、但本机 `installed=false` 的条目，
  // 自动补打一次 `/folia/skins/install`（幂等：走 `cache/skins-zip/<sha256(url)>.zip`，不再下载）。
  //
  // 为什么需要它（真实故障，已确诊）：鲸鱼娘·雨夜 17,509,106 B 全下完、缓存 zip 完好、能解压，
  // 但 `skins/rainy-night` 不存在 —— 当初的收尾是宿主内存里的 `setTimeout`，DSH 重启后就没了，
  // 而 `jobs.json` 里 `status=done` 落了盘 ⇒ 重启后没有任何人会再推进落地，卡片永远停
  // 「解压/落位中…」。这一条在**用户什么都不点**的情况下把它补完。
  //
  // 防抖：`dlHealStuck()` 内部按 `skin:<id>` 记账，**同一 id 每次会话只自动尝试一次**
  // （切页签重新挂载不会重打；用户手动点「重试」不受此限）。
  // 失败不静默：原因经 `cards.fail()` 写到卡片上（红字 +「重试」），提示行同时给一句人话。
  React.useEffect(() => {
    const items = (state && state.site) || [];
    if (!items.length) return undefined;
    let alive = true;
    // ⓪ 「本地没有对应 job」的卡片：把残留的"进行中"痕迹清掉 ⇒ **回落 idle、可点安装**。
    //    这是 Lenovo 实测的另一半：队列里根本没有那条 job 了，界面却还留着"在干活"的样子。
    for (const it of dlStaleCards(dl.jobs, "skin", items, (x) => Boolean(x.installed) || cards.okOf(x.id))) {
      cards.settle(it.id);
    }
    dlHealStuck({
      kind: "skin",
      jobs: dl.jobs,
      items,
      doneOf: (it) => Boolean(it.installed) || cards.okOf(it.id),
      path: "/skins/install",
      body: (it) => ({ id: it.id, url: it.url }),
      onTry: (it) => {
        if (!alive) return;
        setNote({ ok: true, text: weT("下载已完成但没落地，正在自动补装：{name}", { name: it.title || it.id }) });
      },
      onOk: (it) => {
        if (!alive) return;
        cards.markOk(it.id);
        setNote({ ok: true, text: weT("下载已完成，已自动补装：{name} —— 点「应用」就能切换", { name: it.title || it.id }) });
        load(true);
      },
      onFail: (it, code) => {
        if (!alive) return;
        cards.fail(it.id, code);
        setNote({ ok: false, text: weT("自动补装失败：{why}", { why: dlFailReason(code) }) });
      },
    }).catch(() => { /* dlHealStuck 内部已兜住；这里只防未处理的 rejection */ });
    return () => { alive = false; };
    // 依赖只放"清单"与"队列快照"：两者变了才需要重新判断该不该补装。
  }, [state, dl.jobs]);

  const act = async (kind, payload, label, ev) => {
    // 结构性操作才锁整块 UI；`activate` 是幂等的、而且要让人能连点换皮肤，所以不锁。
    const structural = kind === "install" || kind === "remove";
    const cardId = String((payload && payload.id) || "");
    const isInstall = kind === "install";
    const busyKey = structural
      ? kind + ":" + cardId
      : (kind === "activate" || kind === "repair" ? kind + ":" + cardId : "");
    // ⚠️ 4.23.4：安装**不占页面级 busy**。旧实现由 `busyIsStructural` 统一禁用**所有**安装按钮，
    // 于是"另一张卡片在下载"时点这张卡片 = 点在 disabled 按钮上：请求不发、提示不写，
    // 界面什么都不发生 —— 这就是用户报的「鲸鱼娘·雨夜 点了没反应」的直接形态。
    // 现在安装的可见性由**这张卡片自己**的 submitting/queued/running 承担（只禁它自己）。
    if (busyKey && !isInstall) { setBusy(busyKey); busyRef.current = busyKey; }
    // 非安装类操作沿用旧口径：先把上一轮的提示清掉。安装类**不清** —— 见下面 dlInstallClick。
    if (!isInstall) setNote(null);
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

      /**
       * 4.23.14：安装的**第一行**是同步视觉反馈（`dlInstallClick` 里先改 DOM 再发请求）。
       *
       * 旧顺序（`cards.begin` → `await skinInstalledNow`）在冷启动时那次 `/skins/list` 要
       * **555.7 ms**（热态 41.9–44.0 ms，实测 5 采样）：这段时间用户只等 React 的一次提交，
       * 卡片明细还是空的 ⇒ 第一击像"没反应"。现在：
       *   · 反馈与点击同一个 tick（pressed / aria-busy / 按钮「正在提交…」）；
       *   · 预检查**只在清单已 installed===true** 时做，且 1.5s 超时后照常发请求；
       *   · 300ms 还没进入 queued/running ⇒ 提示行先出「提交中…（正在准备）」。
       */
      let resp;
      if (isInstall) {
        const click = await dlInstallClick({
          el: ev && ev.currentTarget,
          btnText: weT("正在提交…"),
          installed: Boolean(payload && payload.installed === true),
          begin: () => { cards.begin(cardId); },
          onSubmitting: () => { setNote({ ok: true, text: weT("正在提交…") }); },
          onPreparing: (text) => { setNote({ ok: true, text }); },
          jobActive: () => dlJobActive(dlJobForCard(jobsRef.current, "skin", payload && payload.url)),
          precheck: () => skinInstalledNow(cardId),
          precheckMs: DL_PRECHECK_TIMEOUT_MS,
          submit: () => apiPostJson("/skins/install", payload || {}, { parse: "always" }),
        });
        // 清单已装且预检查命中：一次网络都不发（这是唯一允许"先查再发"的分支）。
        if (click.skipped) {
          cards.markOk(cardId);
          setNote({ ok: true, text: weT("已装过：{name}", { name: label || "" }) });
          await load(true);
          return;
        }
        resp = click.resp;
      } else {
        resp = await apiPostJson("/skins/" + kind, payload || {}, { parse: "always" });
      }
      const r = (resp && resp.data) || null;
      // 4.23.6：宿主说"同一套**正在装**"（`scheduleFinishInstall` 的自调用与客户端 202 轮询撞上了）。
      // 这不是失败、也**不是完成**：保持当前卡片状态（后面的 90 秒上界兜底），只把清单刷新一遍 ——
      // 若那边已经装好就直接 markOk；没装好就等下一拍，绝不重复解压、也不把卡片灰死。
      if (resp && resp.ok && r && r.deduped) {
        setNote({ ok: true, text: weT("这套皮肤正在安装中，稍后自动刷新：{name}", { name: label || "" }) });
        if (cardId && await skinInstalledNow(cardId)) cards.markOk(cardId);
        await load(true);
        return;
      }
      // 还没下完：宿主回 202 pending（弱网下 13.8 MB 可能要两分钟以上）。
      // 这里**不能当成失败**，更不能让用户重新点 —— 后台队列继续下、.part 可续传，
      // 我们只负责轮询进度，下完自动再调一次安装（那次读本地 zip，很快）。
      if (resp && resp.ok && r && r.pending) {
        const jobId = r.jobId;
        const label2 = label || "";
        // ⚠️ 202 里**必须有 jobId**：没有它客户端既等不到落地、也没法显示进度，
        // 旧实现会静默轮询到 30 分钟超时（"点了没反应"的另一种形态）。现在当场判失败。
        if (!jobId) {
          cards.fail(cardId, "queue-failed");
          setNote({ ok: false, text: dlFailReason("queue-failed") });
          return;
        }
        // 4.23.4：一拿到 jobId 就把卡片**交给队列**（排队位置 / 百分比 / 剩余时间），
        // 不再停在「正在提交…」——那会把真进度盖住。请求本身继续在后台等（下完自动续装）。
        cards.end(cardId);
        cards.refresh();
        /**
         * **排队位置**（4.23.2）：job 还在 `queued` 时，显示"前面还有几个"。
         * 为什么必须有：这个页签以前的文案是「正在下载 … 0%」——壁纸预取占满槽位时
         * 它会一动不动地停在 0%，用户唯一能得出的结论是"插件卡死了"。
         * 现在 `queuePos` 是队列**真实取任务的顺序**里的 1 基位置（见 lib/download-queue.js
         * 的 queuedOrder），所以 N = queuePos - 1 就是"还有几个排在前面"。
         */
        const queueText = (job) => {
          if (!(job && job.status === "queued")) return "";
          // 4.23.18：优先 `queuedAhead`（0 基、只数同 kind + 同优先级档）；旧宿主回落 queuePos。
          const ahead = job.queuedAhead;
          if (ahead != null && Number.isFinite(Number(ahead)) && Number(ahead) >= 0) {
            return weT("排队中：前面还有 {n} 个任务", { n: Number(ahead) });
          }
          const pos = Number(job.queuePos) || 0;
          if (pos <= 0) return label2 ? weT("排队中：{name}", { name: label2 }) : weT("排队中");
          return weT("排队中：前面还有 {n} 个任务", { n: pos - 1 });
        };
        setNote({ ok: true, text: queueText({ status: r.status, queuePos: r.queuePos, queuedAhead: r.queuedAhead })
          || weT("正在下载：{name} 0%", { name: label2 }) });
        const started = Date.now();
        /** 最近 3 秒的 received 采样：只用来算"约剩 N 秒"，样本不足就不显示。 */
        const samples = [];
        /**
         * 连续「列表里查不到这条 jobId」的次数（4.23.6，Lenovo 实测的永久转圈）。
         *
         * 真实故障：宿主回的 jobId 在 `/downloads/list` 里**根本没有**（宿主重启 / 队列被重置 /
         * job 被清理），而旧循环只在"查到了 job 但还在跑"时有分支、查不到就静默继续 ⇒ 一路转到
         * 30 分钟上界，卡片永远「解压/落位中…」。
         * 现在：**连续** `DL_JOB_MISS_LIMIT`（5）次查不到 ⇒ 判失败（先回 `/skins/list` 核一次
         * `installed`，装好了就直接当成功）。
         */
        let jobMisses = 0;
        while (Date.now() - started < 30 * 60 * 1000) {
          await new Promise((resolve) => { setTimeout(resolve, 1200); });
          let jobs = [];
          let listed = false;
          try {
            const list = await apiJson("/downloads/list");
            const doc = (list && list.data) || list || {};
            jobs = Array.isArray(doc.jobs) ? doc.jobs : [];
            listed = true;
          } catch { /* 拉不到就继续等（不算"查不到"） */ }
          const job = jobs.find((x) => x && x.id === jobId);
          // ① 任务丢了：连续 N 次查不到 ⇒ 不再空等（先核一次 installed，见下面 ②）
          if (listed && !job) {
            jobMisses += 1;
            if (jobMisses >= DL_JOB_MISS_LIMIT) {
              const already = await skinInstalledNow((payload && payload.id) || cardId);
              if (already) {
                if (cardId) cards.markOk(cardId);
                setNote({ ok: true, text: weT("已确认装好：{name} —— 点「应用」就能切换", { name: label2 }) });
                await load(true);
                return;
              }
              if (cardId) cards.fail(cardId, "job-lost");
              setNote({ ok: false, text: dlFailReason("job-lost") });
              return;
            }
            continue;   // 还没到阈值：继续轮询（这一段已经等过 1.2s）
          }
          if (job) jobMisses = 0;
          const pct = job && Number(job.percent) ? Number(job.percent) : 0;
          const rec = job && Number(job.received) ? (Number(job.received) / 1048576).toFixed(1) : "0";
          const tot = job && Number(job.total) ? (Number(job.total) / 1048576).toFixed(1) : "?";
          const queuedText = queueText(job);
          if (queuedText) {
            setNote({ ok: true, text: queuedText });
          } else {
            // 预计剩余：只用**最近 3 秒**的增量（整段平均会被起跑阶段拖低，越下越离谱）。
            // 样本 < 2 条、或这 3 秒没往前走 ⇒ 只显示百分比（宁可不给，也别给个假数字）。
            const now = Date.now();
            const got = job && Number(job.received) ? Number(job.received) : 0;
            const totalBytes = job && Number(job.total) ? Number(job.total) : 0;
            samples.push({ at: now, got });
            while (samples.length > 2 && now - samples[0].at > 3000) samples.shift();
            const first = samples[0];
            const span = now - first.at;
            const speed = span > 500 ? (got - first.got) / (span / 1000) : 0;
            const left = speed > 1024 && totalBytes > got ? Math.max(1, Math.round((totalBytes - got) / speed)) : 0;
            // 4.23.3：多连接时在**同一行末尾**补一句「· 多连接(8)」——不新增行、不改前面已定的
            // 百分比/ETA 文案（4.23.2 的判据逐字钉着它们）。单流仍走原文案，一个字符都不变。
            const modeStr = job && typeof job.mode === "string" ? job.mode : "single";
            const mRanged = /^ranged:(\d+)$/.exec(modeStr);
            const conns = mRanged ? Number(mRanged[1]) : 0;
            let statusText;
            if (conns > 1) {
              statusText = left > 0
                ? weT("正在下载：{name} {p}%（{a}/{b} MB）· 约剩 {s} 秒 · 多连接({n})", { name: label2, p: pct, a: rec, b: tot, s: left, n: conns })
                : weT("正在下载：{name} {p}%（{a}/{b} MB）· 多连接({n})", { name: label2, p: pct, a: rec, b: tot, n: conns });
            } else {
              statusText = left > 0
                ? weT("正在下载：{name} {p}%（{a}/{b} MB）· 约剩 {s} 秒", { name: label2, p: pct, a: rec, b: tot, s: left })
                : weT("正在下载：{name} {p}%（{a}/{b} MB）", { name: label2, p: pct, a: rec, b: tot });
            }
            setNote({ ok: true, text: statusText });
          }
          if (job && job.status === "failed") {
            // 失败必须**留在卡片上**（原因 +「重试」），不只写在提示行 —— 提示行会被下一次操作冲掉。
            cards.fail(cardId, job.error || "download-failed");
            setNote({ ok: false, text: dlFailReason(job.error || "download-failed") });
            return;
          }
          if (job && job.status === "done") {
            // 下完了：再调一次安装，这次直接解压本地 zip
            return act("install", payload, label);
          }
        }
        // 30 分钟还没落地：**先核一次 installed**（也许早装好了，只是我们等的那条 job 没了），
        // 再判超时。卡片上留「超时 + 重试」，提示行给同一句人话。
        {
          const already = await skinInstalledNow((payload && payload.id) || cardId);
          if (already) {
            if (cardId) cards.markOk(cardId);
            setNote({ ok: true, text: weT("已确认装好：{name} —— 点「应用」就能切换", { name: label2 }) });
            await load(true);
            return;
          }
        }
        cards.fail(cardId, "download-timeout");
        setNote({ ok: false, text: dlFailReason("download-timeout") });
        return;
      }
      if (resp && resp.ok && r && r.ok) {
        if (kind === "install") {
          // 宿主回 ok ⇒ 卡片立刻按"已完成"显示（`exists` 幂等分支同样适用）。
          // 站点 slug 与本机 skin.json 的 id 归一对不上时，列表里的 installed 会一直是 false，
          // 卡片就会静默回到「安装」= 用户眼里的"点了没反应"。
          if (cardId) cards.markOk(cardId);
          // 安装时宿主会把 skin.json **规范化**成皮肤中心一定收的样子（它的规则比我们严：
          // id 必须等于目录名、必须 v2、name/nameEn/author/stylesheet 齐全、不允许未知顶层键）。
          // 这一步做了什么要如实告诉用户，否则"为什么它动了我的清单"会变成新的疑问。
          const fixed = r.manifestFixed === true
            ? weT("（已按皮肤中心规则规范化清单：{what}）", { what: (r.manifestFixes || []).join("、") })
            : "";
          setNote({
            ok: true,
            text: r.exists
              ? weT("已安装过：{name}", { name: label || "" })
              : weT("已安装：{name} —— 点「应用」就能切换", { name: label || "" }) + fixed,
          });
        }
        if (kind === "remove") setNote({ ok: true, text: weT("已卸载：{name}", { name: label || "" }) });
    // 卸载成功后必须把这张卡片的失败/安装中状态清掉：
    // 真实事故 —— 卸完了，卡片还挂着上一轮「下载已完成但安装未落地 · 重试」，看着像没删掉。
    if (kind === "remove" && cardId) cards.end(cardId);
        if (kind === "repair") {
          setNote({
            ok: true,
            text: r.changed
              ? weT("已按皮肤中心规则修复清单：{what} —— 点「刷新」后应能被收录", { what: (r.fixes || []).join("、") })
              : weT("这套清单本来就合规（没有可修的）；若仍未被收录，把卡片上的原因发我"),
          });
        }
        await load(true);
      } else {
        const code = (r && r.error) || "failed";
        // 失败原因的**唯一真源**是 `dlFailReason`（四模块共用一张表，见 src/local-first.js）：
        // 以前这张表只在本页签里，另外两个页签只会显示裸错误码，于是同一个故障在三个地方
        // 说法不一样。现在卡片与提示行读的是同一句人话。
        if (isInstall && cardId) cards.fail(cardId, code);
        setNote({ ok: false, text: dlFailReason(code) });
      }
    } catch (e) {
      const why = e && e.message ? String(e.message) : "";
      const code = /timeout|超时/i.test(why) ? "submit-timeout" : "network";
      if (isInstall && cardId) cards.fail(cardId, code);
      setNote({ ok: false, text: weT("请求失败：{msg}", { msg: why || weT("网络错误") }) });
    } finally {
      // 请求返回/失败/超时都在这条路径上 ⇒ 退出「正在提交…」，卡片要么交给队列、要么给「重试」。
      if (isInstall && cardId) cards.end(cardId);
      if (busyKey && !isInstall) { setBusy(""); busyRef.current = ""; }
    }
  };

  const children = [];
  children.push(React.createElement("div", { key: "head", style: SKIN_STYLE.row },
    React.createElement("div", { style: { fontSize: "13px", fontWeight: 600 } }, weT("🎨 助手皮肤")),
    React.createElement("button", {
      className: "we-picker__btn", type: "button",
      disabled: Boolean(busy),
      onClick: () => load(true),
    }, busyIsStructural ? weT("下载中…（可继续切换皮肤）") : weT("刷新")),
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

  // 内核版本自检（宿主 /skins/list 里带来的 kernel 字段）：
  // 内核低于皮肤中心要求的版本时，"它被关掉"不是用户操作失误，而是门槛 —— 这里直接给**可点击的升级页**
  // （URL 由宿主从桌面端自己的 package.json 推导；拿不到就不给按钮，绝不编链接）。
  const kernel = (state && state.kernel) || null;
  const kernelTooOld = Boolean(kernel && kernel.kernelOk === false);
  if (kernelTooOld) {
    const url = kernel && kernel.upgradeUrl;
    children.push(React.createElement("div", {
      key: "kernel-old",
      className: "we-picker__hint",
      style: { color: "#ff9a9a", margin: "2px 0 6px", lineHeight: "1.6" },
    },
    weT("桌面端内核太低：当前 {cur}，皮肤中心要求 {req}", { cur: (kernel.dshVersion || weT("未知")), req: (kernel.requiredKernel || "0.2.1-rc.3") }),
    React.createElement("br"),
    url
      ? React.createElement("a", {
        href: url, target: "_blank", rel: "noreferrer",
        style: { color: "#8ecbff", textDecoration: "underline" },
      }, weT("点这里升级 DSH Desktop（桌面端 {v}）", { v: kernel.desktopVersion || "" }))
      : weT("请把 DSH Desktop 升级到满足该内核的版本后重启"),
    ));
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

  // ⚠️ 「正在下载/安装」**不能**把整块面板锁住：实测用户点「安装」后想切到另一套皮肤，
  // 结果所有「应用」都灰着，必须等 zip 下完 —— 下载是长任务，切换应该与它互不阻塞。
  // 所以把 busy 拆成两条互不相干的通道：
  //   · 结构操作（install / remove / repair）：改动磁盘目录，串行，期间只锁**结构按钮**
  //   · 切换（activate）：只写 active，幂等且"最后动作优先"，期间只锁**该卡片的「应用」**
  // （这两面旗已上移到函数开头声明 —— 上面的「刷新」按钮文案要用到它们，写在这里会触发 TDZ。）

  const installed = (state && state.installed) || [];
  const activeId = (state && state.active) || "";
  // 「皮肤中心记着哪套」≠「屏上现在是哪套」：壁纸在台上时皮肤会 withhold 自己，
  // 但它持久化的 active 不会自动清（我们 4.15.1 起在用户选壁纸时主动清一次）。
  // 这台机器的旧状态（或清理失败）仍可能出现"壁纸在播、页签却标使用中"，所以这里先看
  // 我们的壁纸标记，标了就不把 active 说成"使用中"，而是说"已让位"。
  const wallpaperOn = (() => {
    try { return Boolean(document && document.body && document.body.hasAttribute("data-we-wallpaper")); } catch { return false; }
  })();
  /** 这个 id 是不是"正在用"的那套（两边都归一后比，站点 slug 可能带 skin- 前缀）。 */
  const isActiveSkin = (id) => Boolean(activeId) && !wallpaperOn && normSkinId(activeId) === normSkinId(id);

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
      // 壁纸在台上时不说"使用中"：皮肤已让位，说了就是骗人（实测：壁纸在播却标皮肤使用中）
      activeId
        ? (wallpaperOn
          ? weT(" · 皮肤已让位（壁纸在使用中）：{name}", { name: activeId })
          : weT(" · 使用中：{name}", { name: activeId }))
        : ""));
    if (activeId && wallpaperOn) {
      children.push(React.createElement("div", {
        key: "yield-note",
        className: "we-picker__hint",
        style: { margin: "0 0 6px", opacity: 0.8 },
      }, weT("当前是壁纸在台上，皮肤中心记着的这套没有在画。点「应用」会让皮肤上台（壁纸自动让位）。")));
    }
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
          // ⚠️ 只有 `=== false` 才下结论：`null` 表示"问不到它的 catalog"（未知），
          // 未知绝不能禁用按钮 —— 那会变成"替我猜错了就不让我点"。
          const notListed = s.inCatalog === false;
          // 它给出的**具体拒收原因**（catalog diagnostics 里 subject = 目录名）。
          // 有原因就直接显示原因，比我们复述规则更有用。
          const whyDetail = notListed && Array.isArray(s.catalogWarnings) && s.catalogWarnings.length
            ? "：" + s.catalogWarnings.slice(0, 2).join("；")
            : "";
          const notListedWhy = notListed
            ? weT("皮肤中心未收录这套（它按自己的 manifest 规则筛选：id 必须等于目录名、必须 v2、name/nameEn/author/stylesheet 齐全、不允许未知顶层键）。可点「修复清单」按它的规则补一次；修完点刷新")
              + whyDetail
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
          // 未收录时把**原因直接印在卡片上**（不只放在 title 里）：实测用户看不到悬浮提示，
          // 只能看到一句"未收录"，于是只能来问"为什么"。
          notListed
            ? React.createElement("div", {
              style: { fontSize: "11px", lineHeight: "1.5", color: "#ffd08a", opacity: 0.95, margin: "2px 0 4px" },
            }, weT("原因：{why}", {
              why: (Array.isArray(s.catalogWarnings) && s.catalogWarnings.length)
                ? s.catalogWarnings.slice(0, 2).join("；")
                : weT("皮肤中心没有给出原因（常见于它还没重扫，或它的用户皮肤目录与我们的不同）"),
            }))
            : null,
          React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
            // 「应用」= 写皮肤中心的 active + 广播 `dsh-skin-applied`，就地切换（不刷新页面）。
            isActive
              ? React.createElement("span", { style: { ...SKIN_STYLE.badge, background: "rgba(60,160,90,0.55)" } }, weT("使用中"))
              : React.createElement("button", {
                className: "we-picker__btn", type: "button",
                disabled: (busyIsActivating && busyThis) || !canApply || notListed,
                title: notListed ? notListedWhy : (applyBlockedReason || undefined),
                onClick: () => act("activate", { id: s.id }, s.name),
              }, busyThis ? weT("切换中…") : weT("应用")),
            // 未被皮肤中心收录时给一个**可执行**的出口：按它的规则就地修一次清单。
            // 只是补/裁 skin.json 的字段，不动 skin.css / hooks / 资产。
            notListed
              ? React.createElement("button", {
                className: "we-picker__btn", type: "button",
                disabled: busyIsStructural,
                title: notListedWhy,
                onClick: () => act("repair", { id: s.dirId || s.id }, s.name),
              }, busy === "repair:" + (s.dirId || s.id) ? weT("修复中…") : weT("修复清单"))
              : null,
            React.createElement("button", {
              className: "we-picker__btn", type: "button",
              disabled: busyIsStructural || isActive,
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
        // 4.23.3：这条站点皮肤对应的队列 job（kind=skin + url）；挂载时已在跑的直接显示进度。
        const job = dlJobForCard(dl.jobs, "skin", s.url);
        // 4.23.4：卡片状态（idle/submitting/queued/running/installing/done/failed）由**四模块共用**的
        // `dlCardState` 算出来 —— 按钮文案、是否禁用、失败原因与「重试」都在那一个函数里。
        // 旧实现这里是 `disabled: busyIsStructural || jobBusy`：另一张卡片在装 ⇒ 这张的按钮也灰 ⇒ 点了什么都不发生。
        const st = cards.stateOf({ id: s.id, job, done: Boolean(s.installed) || cards.okOf(s.id), labels: skinDlLabels });
        // running 的按钮文案沿用 4.23.3 的紧凑形式（`下载中… 42% · 多连接(8)`，4.23.3 的判据逐字钉着它），
        // MB / 剩余时间放在下面那行明细里；其余状态一律由状态机给。
        const label = st.phase === "running" ? dlBusyLabel(job) : st.label;
        // 站点条目的 slug 与本机皮肤 id **不一定相同**（站点 slug 由标题生成/为避撞名会加 skin- 前缀），
        // 而皮肤中心只认 skin.json 里的原始 id ⇒ 写之前必须换成**本机那个 id**，
        // 否则它的 activePostHandler 会回 404 skin-not-found（实测报错 skin-center-404）。
        const localId = localIdOf(s);
        // 4.23.14：`we-dl-card` 是同步反馈的**卡片级**锚点（pressed 态挂它，见 styles-panel.js）。
        return React.createElement("div", { key: s.id, className: "we-dl-card", style: SKIN_STYLE.card },
          s.thumbUrl
            ? React.createElement("div", {
              style: { ...SKIN_STYLE.thumb, backgroundImage: "url(" + JSON.stringify(s.thumbUrl) + ")" },
            })
            : React.createElement("div", { style: SKIN_STYLE.thumb }),
          React.createElement("div", { style: SKIN_STYLE.title, title: s.title }, s.title),
          React.createElement("div", { style: SKIN_STYLE.meta },
            [skinFmtBytes(s.bytes), (s.tags || []).includes("动态") ? weT("动态") : ""].filter(Boolean).join(" · ")),
          React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" } },
            s.installed || cards.okOf(s.id)
              // 已装的站点卡片也要能**直接应用**：用户是照着站点缩略图挑的，
              // 让他再滚回上面的「本机已装」区去点一次是多余的一步（实测反馈）。
              ? [
                // ⚠️ 只有**确实知道本机 id** 时才给「应用」：`localId` 为空表示站点 slug 与本机
                // skin.json 的 id 对不上（为避撞名会加 `skin-` 前缀）。旧实现此时会渲染一个
                // id="" 的「应用」按钮 —— 点下去等于"恢复默认外观"（把正在用的皮肤清掉）。
                localId
                  ? (isActiveSkin(localId)
                    ? React.createElement("span", { key: "on", style: { ...SKIN_STYLE.badge, background: "rgba(60,160,90,0.55)" } }, weT("使用中"))
                    : React.createElement("button", {
                      key: "apply",
                      className: "we-picker__btn", type: "button",
                      disabled: (busyIsActivating && busy === "activate:" + localId) || !canApply,
                      title: applyBlockedReason || undefined,
                      onClick: () => act("activate", { id: localId }, s.title),
                    }, busy === "activate:" + localId ? weT("切换中…") : weT("应用")))
                  : null,
                React.createElement("span", { key: "done", style: SKIN_STYLE.badge }, weT("已安装")),
              ]
              : React.createElement("button", {
                className: "we-picker__btn", type: "button",
                // 只禁**这张卡片**自己（提交中/排队/在下/解压/已装）；别的卡片在装不影响它。
                disabled: st.disabled,
                title: st.phase === "failed" ? st.reason
                  : (skinCenter === "absent" ? weT("先装皮肤中心，否则皮肤装好也没法启用") : undefined),
                // 4.23.14：把被点的元素交给 act ⇒ 第一行就能同步做视觉反馈。`installed` 随行带给
                // 预检查门：只有清单说已装时才允许先查（否则直接发安装请求）。
                onClick: (ev) => act("install", { id: s.id, url: s.url, installed: Boolean(s.installed) }, s.title, ev),
              }, label),
          ),
          // 进度 / 原因明细：`12.3/16.6 MB · 约剩 41 秒`、`排队中：前面还有 2 个任务`、
          // 或失败原因（红字）。失败时按钮上是「重试」，点它立刻重新提交。
          st.detail
            ? React.createElement("div", {
              style: {
                fontSize: "10.5px", lineHeight: "1.45", marginTop: "2px",
                opacity: 0.9, color: st.phase === "failed" ? "#ff9a9a" : undefined,
              },
            }, st.detail)
            : null,
        );
      }),
  ));

  return React.createElement("div", { className: "we-picker", style: { display: "flex", flexDirection: "column" } }, children);
}
