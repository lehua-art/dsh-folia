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

/**
 * 兜底核对（4.23.6）：`/boot/list` 的 `installed`（= 落地校验过了、meta 也写了）是唯一真源。
 *
 * 用在宿主回的 jobId **连续查不到**或等到超时的时候：这两种情况都不该直接判失败 ——
 * 最常见的情形是"其实早就收尾好了，只是我们等的那条 job 没了"（宿主重启 / 队列重置 / job 被清理）。
 */
async function bootInstalledNow(id) {
  const want = String(id || "").trim();
  if (!want) return false;
  try {
    const resp = await apiJson("/boot/list", { parse: "always" });
    const doc = (resp && resp.data) || null;
    const clips = (doc && Array.isArray(doc.clips)) ? doc.clips : [];
    const hit = clips.find((c) => c && String(c.id) === want);
    return Boolean(hit && hit.installed);
  } catch { return false; }
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
  // 4.23.3：卡片状态以 /folia/downloads/list 为唯一真源 —— 切页签重新挂载后，
  // 这里拉回来的 job 会让「下载中… x%」直接出现，而不是回到「下载」。
  const dl = useDownloadJobs();
  // 4.23.4：**卡片级**状态机（四页签共用，见 src/local-first.js 的 `dlCardState`）——
  // 点击瞬间就有「正在提交…」，随后 排队 / 进度 / 解压 / 失败原因+重试，四模块同一套。
  const cards = useDlCards(dl);
  // 4.23.14：300ms 占位要知道队列里是否已有这张卡片的 queued/running（闭包会读到点击瞬间的旧
  // 快照 ⇒ 用 ref 跟住最新值）。
  const jobsRef = React.useRef([]);
  jobsRef.current = dl.jobs;
  // 只有这两个词属于本页签的口径。
  const bootDlLabels = { idle: weT("下载"), done: weT("使用中"), failed: weT("重试") };


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

  // 4.23.6：**挂载自愈** —— 队列里 job 已经 `done`、但本机 `installed=false` 的条目，
  // 自动补打一次 `POST /folia/boot/download`。
  //
  // 这一条对开机动画同样成立（同一个死锁形态）：下载本身属于宿主队列，而"落地"（验 ftyp/EBML
  // 文件头 + 写 meta，`installed` 就是从 meta 推出来的）以前只由宿主内存里的
  // `scheduleBootFinish()` 推进 —— 进程一重启就没人做了，卡片看起来"没下载"，其实文件早就在
  // 盘上（`/boot/download` 在本地文件已存在时**只做收尾、不会重下**，所以这是幂等安全的）。
  //
  // 「成功了怎么表示」与皮肤不同：这个页签的"完成"形态是**换一组按钮**（使用/删除），
  // 不是同一个按钮变字，所以这里不调 `cards.markOk()`（传 `done:false` 时它不影响渲染），
  // 而是 `load(true)` 让 `/boot/list` 用 `installed:true` 把它翻过去 —— 那才是本页签的真源。
  // 防抖与"失败不静默"同皮肤页签：`dlHealStuck()` 按 `boot:<id>` 每次会话只试一次。
  React.useEffect(() => {
    const clips2 = (state && state.clips) || [];
    // `url` 为空的条目是"本地有、清单里没有"的孤儿：既然本地已有，它不该被补装。
    const items = clips2.filter((c) => c && c.id && c.url);
    if (!items.length) return undefined;
    let alive = true;
    // ⓪ 「本地没有对应 job」的卡片：清掉残留的进行中痕迹 ⇒ 回落「下载」，可点。
    //    与皮肤页签同一条口径：队列里没有它，它就不在发生。
    for (const c of dlStaleCards(dl.jobs, "boot", items, (x) => Boolean(x.installed))) {
      cards.settle(c.id);
    }
    dlHealStuck({
      kind: "boot",
      jobs: dl.jobs,
      items,
      doneOf: (c) => Boolean(c.installed),
      path: "/boot/download",
      body: (c) => ({ id: c.id }),
      onTry: (c) => {
        if (!alive) return;
        setNote({ ok: true, text: weT("下载已完成但没落地，正在自动收尾：{name}", { name: c.title || c.id }) });
      },
      onOk: (c) => {
        if (!alive) return;
        setNote({ ok: true, text: weT("下载已完成，已自动收尾：{name}", { name: c.title || c.id }) });
        load(true);
      },
      onFail: (c, code) => {
        if (!alive) return;
        cards.fail(c.id, code);
        setNote({ ok: false, text: weT("自动收尾失败：{why}", { why: dlFailReason(code) }) });
      },
    }).catch(() => { /* dlHealStuck 内部已兜住 */ });
    return () => { alive = false; };
  }, [state, dl.jobs]);


  async function act(kind, payload, label, ev, jobUrl) {
    if (busy) return;
    // 只有结构性操作（下载 / 选择 / 删除）才锁 UI；开关与参数是幂等的，锁了反而闪。
    const structural = kind === "download" || kind === "select" || kind === "remove" || kind === "import";
    const cardId = String((payload && payload.id) || "");
    const isDownload = kind === "download";
    // 4.23.3：**下载走队列后不再锁整页** —— 进度落在卡片上（dlBusyLabel），锁住反而让人
    // 以为面板卡了。structural 的判据保持原样，只是在"真的 setBusy 吗"这一步把下载排除。
    if (structural && kind !== "download") setBusy(payload && payload.id ? payload.id : kind);
    // 非下载类沿用旧口径：先清上一轮提示。下载类交给 dlInstallClick（它先写即时反馈）。
    if (!isDownload) setNote(null);
    try {
      let resp;
      if (isDownload) {
        // 4.23.14：与皮肤页签**同一个**实现 —— 第一行同步反馈（按钮「正在提交…」+ 卡片 pressed +
        // aria-busy），再进卡片状态机，最后才发请求；300ms 没进队列就出「提交中…（正在准备）」。
        const click = await dlInstallClick({
          el: ev && ev.currentTarget,
          btnText: weT("正在提交…"),
          installed: false,
          begin: () => { cards.begin(cardId); },
          onSubmitting: () => { setNote({ ok: true, text: weT("正在提交…") }); },
          onPreparing: (text) => { setNote({ ok: true, text }); },
          jobActive: () => dlJobActive(dlJobForCard(jobsRef.current, "boot", jobUrl)),
          submit: () => apiPostJson("/boot/download", payload || {}, { parse: "always" }),
        });
        resp = click.resp;
      } else {
        resp = await apiPostJson("/boot/" + kind, payload || {}, { parse: "always" });
      }
      const r = (resp && resp.data) || null;
      if (resp && resp.ok && r && r.ok) {
        if (kind === "download") {
          // 宿主把下载交给队列并回 202 pending（jobId）：进度靠 list，落地后宿主自己再收尾。
          if (r.pending && r.jobId) {
            // 拿到 jobId ⇒ 卡片交给队列显示，不再停在「正在提交…」（那会把真进度盖住）。
            cards.end(cardId);
            dl.refresh();
            setNote({ ok: true, text: dlBusyLabel({ percent: 0, mode: r.mode }) });
            const done = await dlAwaitJob(r.jobId);
            if (done && done.status === "done") setNote({ ok: true, text: weT("已下载：{name}", { name: label }) });
            else if (done && (done.status === "lost" || done.status === "timeout")) {
              // 兜底核对（4.23.6）：先问列表"到底落地没有"，再决定是失败还是成功。
              const okNow = await bootInstalledNow(cardId);
              if (okNow) {
                cards.markOk(cardId);
                setNote({ ok: true, text: weT("已确认落地：{name}", { name: label }) });
              } else {
                const code = done.status === "lost" ? "job-lost" : "download-timeout";
                cards.fail(cardId, code);
                setNote({ ok: false, text: dlFailReason(code) });
              }
            } else if (done) {
              cards.fail(cardId, done.error || done.status);
              setNote({ ok: false, text: dlFailReason(done.error || done.status) });
            } else {
              cards.fail(cardId, "download-timeout");
              setNote({ ok: false, text: dlFailReason("download-timeout") });
            }
            await load(true);
            return;
          }
          setNote({ ok: true, text: weT("已下载：{name}", { name: label }) });
        }
        if (kind === "select") setNote({ ok: true, text: weT("已选中「{name}」，下次启动生效", { name: label }) });
        if (kind === "remove") setNote({ ok: true, text: weT("已删除：{name}", { name: label }) });
    if (kind === "import") setNote({ ok: true, text: weT("已导入：{name}", { name: label }) });
        if (kind === "toggle") setNote({ ok: true, text: payload.enabled ? weT("开机动画已开启") : weT("开机动画已关闭") });
        if (kind === "settings") setNote({ ok: true, text: weT("已保存") });
        // 开关/参数类：宿主把整份 boot 配置回给我们（{ ok, ...boot }），直接并进 state，
        // **不再 load(true) 重拉整表** —— 那次重拉会让所有控件先禁用再恢复，视觉上就是闪一下。
        if (kind === "toggle" || kind === "settings") {
          setState((prev) => (prev ? { ...prev, ...r } : prev));
        } else {
          await load(true);
        }
      } else {
        const code = (r && r.error) || "failed";
        if (isDownload && cardId) cards.fail(cardId, code);
        // 失败原因与人话文案同样走共用表（与皮肤 / 桌宠逐字一致，不再各写一套）。
        setNote({ ok: false, text: dlFailReason(code) });
      }
    } catch (e) {
      const why = e && e.message ? String(e.message) : "";
      if (isDownload && cardId) cards.fail(cardId, /timeout|超时/i.test(why) ? "submit-timeout" : "network");
      setNote({ ok: false, text: weT("请求失败：{msg}", { msg: why || weT("网络错误") }) });
    } finally {
      // 请求返回/失败/超时 ⇒ 退出「正在提交…」（成功分支已提前 end 的话这里是空操作）。
      if (isDownload && cardId) cards.end(cardId);
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
      type: "checkbox", checked: enabled,
        // 不因"还没选片"而禁用：开关本身是幂等的，宿主在无选片时不会注入任何脚本。
        // （实测反馈：勾不动，因为此时 activeId 为空 —— 那是把两件事绑在一起了。）
        disabled: Boolean(busy),
      onChange: (e) => act("toggle", { enabled: e.target.checked }, ""),
    }),
    weT("启用（下次启动播放）"),
  ),
  React.createElement("span", { className: "we-picker__hint" },
    activeId
      ? weT("当前：{name}", { name: (clips.find((c) => c.id === activeId) || {}).title || activeId })
      : (enabled ? weT("已开启，但还没有选片 —— 下载一条后点「使用」") : weT("未选择"))),
  ));

  children.push(React.createElement("div", { key: "hint", className: "we-picker__hint", style: { margin: "2px 0 6px", opacity: 0.75 } },
    weT("下载一条并「使用」后，每次启动都会先播它；默认播完才淡出进入界面。点击或按 Esc 可立即跳过。「带声音」若被浏览器的自动播放策略拦下，会自动退回静音播放。")));

  if (state && state.error && !clips.length) {
    children.push(React.createElement("div", { key: "err", className: "we-picker__hint", style: { color: "#ff9a9a" } },
      weT("候选清单读不到：{msg}", { msg: String(state.error) })));
  }

  // 提示行**常驻且占位**：它出现/消失会改变面板高度，视觉上就是"点一下闪一下"。
  // 固定 minHeight 之后文案变了、布局不动。
  children.push(React.createElement("div", {
    key: "note",
    className: "we-picker__hint",
    style: {
      color: note && !note.ok ? "#ff9a9a" : "#8ee6a8",
      margin: "4px 0 8px", minHeight: "18px", lineHeight: "18px",
      opacity: note ? 1 : 0, transition: "opacity 120ms linear",
    },
  }, note ? note.text : "\u00a0"));

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
      // 素材池取片方式：装了多条时才有意义
      React.createElement("label", { style: { display: "flex", gap: "4px", alignItems: "center", fontSize: "12px" } },
        weT("多条时"),
        React.createElement("select", {
          className: "we-picker__playlist-select",
          value: String(state.poolMode || "first"),
          disabled: Boolean(busy),
          onChange: (e) => act("settings", { poolMode: e.target.value }, ""),
        },
          React.createElement("option", { value: "first" }, weT("固定第一条")),
          React.createElement("option", { value: "random" }, weT("随机")),
          React.createElement("option", { value: "rotate" }, weT("轮换")),
        ),
      ),
      opt(weT("最短显示"), "minShowMs", [[0, weT("不限制")], [600, weT("0.6 秒")], [1200, weT("1.2 秒")], [2000, weT("2 秒")]]),
      opt(weT("最长停留"), "maxHoldMs", [[10000, weT("10 秒")], [20000, weT("20 秒（默认）")], [30000, weT("30 秒")], [60000, weT("60 秒")]]),
    ));
  }

    children.push(React.createElement("div", {
      key: "import",
      style: { display: "flex", alignItems: "center", gap: "8px", margin: "2px 0 6px", flexWrap: "wrap" },
    },
      React.createElement("button", {
        type: "button",
        className: "we-picker__btn",
        disabled: Boolean(busy),
        onClick: () => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "video/mp4,video/webm,.mp4,.webm";
          input.style.display = "none";
          input.addEventListener("change", () => {
            const file = input.files && input.files[0];
            if (!file) return;
            if (file.size > 64 * 1024 * 1024) { setNote({ ok: false, text: weT("文件太大（上限 64MB）") }); return; }
            const reader = new FileReader();
            reader.onload = () => {
              const raw = String(reader.result || "");
              const comma = raw.indexOf(",");
              const data = comma >= 0 ? raw.slice(comma + 1) : raw;
              void act("import", { data, filename: file.name }, file.name);
            };
            reader.onerror = () => setNote({ ok: false, text: weT("读取文件失败") });
            reader.readAsDataURL(file);
          });
          input.click();
        },
      }, weT("导入本地动画")),
      React.createElement("span", { className: "we-picker__hint" },
        weT("支持 mp4 / webm，≤64MB；导入后只在本地，不上传站点")),
    ));
  children.push(React.createElement("div", { key: "count", className: "we-picker__hint", style: { margin: "2px 0 4px" } },
    weT("已下载 {done} / {total}", { done: installedCount, total: clips.length })));

  if (clips.length) {
    children.push(React.createElement("div", { key: "grid", style: BOOT_STYLE.grid },
      clips.map((c) => {
        // 4.23.3：这一条卡片的下载 job（按 kind=boot + url 匹配）。挂载时已有 running 的，
        // 这里天然就能显示「下载中… x%」——状态不跟着组件挂载/卸载走。
        const job = dlJobForCard(dl.jobs, "boot", c.url);
        // 4.23.4：卡片状态由**四模块共用**的状态机决定（下载按钮的文案/禁用/失败原因+重试）。
        // `done` 传 false：本页签"完成"的形态是**换一组按钮**（使用/删除），不是同一个按钮变字。
        const st = cards.stateOf({ id: c.id, job, done: false, labels: bootDlLabels });
        // running 沿用 4.23.3 的紧凑文案（`下载中… 42% · 多连接(8)`），MB/剩余时间在下面那行明细里。
        const label = st.phase === "running" ? dlBusyLabel(job) : st.label;
        const isBusy = busy === c.id;
        const isActive = c.id === activeId;
        const btn = (text, onClick, disabled, primary) => React.createElement("button", {
          type: "button",
          className: "we-picker__btn" + (primary ? " we-picker__btn--primary" : ""),
          style: { flex: "1 1 0", fontSize: "11.5px", padding: "4px 6px" },
          disabled: Boolean(disabled) || Boolean(busy),
          onClick,
        }, text);
        const actions = [];
        if (!c.installed) {
          // 只禁**这一张**卡片（提交中/排队/在下/解压）；别的卡片在动不影响它。
          // 4.23.14：把事件（被点的按钮）与本条 url 交给 act ⇒ 同步反馈 + 300ms 占位判定。
          actions.push(btn(label, (ev) => act("download", { id: c.id }, c.title, ev, c.url), st.disabled, true));
        } else if (!isActive) {
          actions.push(btn(weT("使用"), () => act("select", { id: c.id }, c.title), false, true));
          actions.push(btn(weT("删除"), () => act("remove", { id: c.id }, c.title), isBusy, false));
        } else {
          actions.push(btn(weT("使用中"), () => {}, true, false));
        }
        return React.createElement("div", { key: c.id, className: "we-dl-card", style: BOOT_STYLE.card },
          // 封面：站点给了真正的缩略图才显示；老条目没有就留空（不显示破图）。
          c.cover
            ? React.createElement("img", {
                src: c.cover, alt: "", loading: "lazy", decoding: "async",
                style: { width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "6px", background: "rgba(0,0,0,0.3)" },
                onError: (e) => { e.target.style.display = "none"; },
              })
            : null,
          React.createElement("div", { style: BOOT_STYLE.title },
            (c.title || c.id),
            c.source === "local"
              ? React.createElement("span", { className: "we-picker__hint", style: { marginLeft: "6px" } }, weT("本地"))
              : null),
          React.createElement("div", { style: BOOT_STYLE.meta },
            [c.durationSec ? Number(c.durationSec).toFixed(1) + "s" : null,
             bootFmtBytes(c.localBytes || c.bytes)].filter(Boolean).join(" · ")),
          c.faststart === false
            ? React.createElement("div", { style: { ...BOOT_STYLE.meta, color: "#ffd08a" } }, weT("未做 faststart，播放可能更慢"))
            : null,
          React.createElement("div", { style: { ...BOOT_STYLE.row, marginTop: "4px" } }, actions),
          // 进度 / 原因明细：`12.3/16.6 MB · 约剩 41 秒`、`排队中：前面还有 2 个任务`、
          // 或失败原因（红字）。失败时按钮上是「重试」，点它立刻重新提交。
          st.detail
            ? React.createElement("div", {
              style: { ...BOOT_STYLE.meta, color: st.phase === "failed" ? "#ff9a9a" : undefined },
            }, st.detail)
            : null,
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
