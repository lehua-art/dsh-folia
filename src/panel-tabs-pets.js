/**
 * panel-tabs-pets.js — 「桌宠」页签：站点清单 / 安装 / 使用 / 卸载 / 开关 / 缩放。
 *
 * 与「开机动画」页签同构（fetch → busy → note → 卡片列表），差别只有一处：
 * 开机动画的播放不在前端（启动那一刻应用还没挂载），而桌宠**就活在前端** ——
 * 这里的每个动作最终都落到宿主 `/folia/pets/*`，渲染由 pet-layer.js 负责。
 */

/**
 * 兜底核对（4.23.6）：`/pets/list` 的 `pets[].dirId` 是"到底装上没有"的唯一真源。
 *
 * 用在宿主回的 jobId **连续查不到**或等到超时的时候：先问列表再判失败 ——
 * 最常见的情形是"其实早就装好了，只是我们等的那条 job 没了"（宿主重启 / 队列重置 / job 被清理）。
 */
async function petsInstalledNow(id) {
  const want = String(id || "").trim();
  if (!want) return false;
  try {
    const resp = await apiJson("/pets/list", { parse: "always" });
    const doc = (resp && resp.data) || null;
    const pets = (doc && Array.isArray(doc.pets)) ? doc.pets : [];
    return pets.some((p) => p && String(p.dirId) === want);
  } catch { return false; }
}

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
  // 4.23.3：安装进度以 /folia/downloads/list 为真源（kind=pet），切页签回来仍在。
  const dl = useDownloadJobs();
  // 4.23.4：**卡片级**状态机（四页签共用，见 src/local-first.js 的 `dlCardState`）——
  // 点击瞬间就有「正在提交…」，随后 排队 / 进度 / 解压 / 失败原因+重试，四模块同一套。
  const cards = useDlCards(dl);
  // 4.23.14：300ms 占位要知道队列里是否已有这张卡片的 queued/running（闭包会读到点击瞬间的旧
  // 快照 ⇒ 用 ref 跟住最新值）。
  const jobsRef = React.useRef([]);
  jobsRef.current = dl.jobs;
  // 只有这两个词属于本页签的口径。
  const petDlLabels = { idle: weT("安装"), done: weT("已安装"), failed: weT("重试") };

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
      else setNote({ ok: false, text: weT("读取失败：{msg}", { msg: (resp && resp.error) || "unknown" }) });
    } catch (e) {
      setNote({ ok: false, text: weT("请求失败：{msg}", { msg: (e && e.message) || weT("网络错误") }) });
    }
  }, []);

  React.useEffect(() => { load(false); }, [load]);

  // 4.23.6：**挂载自愈** —— 队列里 job 已经 `done`、但本机没装上的条目，自动补打一次
  // `POST /folia/pets/install`。
  //
  // 同一死锁形态：桌宠包的下载属于宿主队列，而"落地"（解压 + 校验 pet.json/雪碧图 + 写 config）
  // 以前只由宿主内存里的 `schedulePetsFinish()` 推进 —— 进程重启后就没人做了。
  // `/pets/install` 在 `cache/pets-zip/<id>.zip` 还在时**只解压、不再下载**（4.23.3 的队列缓存），
  // 已装好时直接回 `exists:true`，所以这个补打是幂等的、不会白占带宽。
  //
  // 防抖 / 不静默同另两个页签：`dlHealStuck()` 按 `pet:<id>` 每次会话只试一次；
  // 失败经 `cards.fail()` 把原因写在卡片上。
  React.useEffect(() => {
    const installedNow = new Set(((state && state.pets) || []).map((p) => p.dirId));
    const items = ((state && state.site) || []).filter((s) => s && s.id && !installedNow.has(s.id));
    if (!items.length) return undefined;
    let alive = true;
    // ⓪ 「本地没有对应 job」的卡片：清掉残留的进行中痕迹 ⇒ 回落「安装」，可点。
    for (const s of dlStaleCards(dl.jobs, "pet", items, () => false)) {
      cards.settle(s.id);
    }
    dlHealStuck({
      kind: "pet",
      jobs: dl.jobs,
      items,
      doneOf: () => false,   // 已在上面按 installed 过滤过了
      path: "/pets/install",
      body: (s) => ({ id: s.id }),
      onTry: (s) => {
        if (!alive) return;
        setNote({ ok: true, text: weT("下载已完成但没落地，正在自动补装：{name}", { name: s.title || s.id }) });
      },
      onOk: (s) => {
        if (!alive) return;
        setNote({ ok: true, text: weT("下载已完成，已自动补装：{name}", { name: s.title || s.id }) });
        load(true);
      },
      onFail: (s, code) => {
        if (!alive) return;
        cards.fail(s.id, code);
        setNote({ ok: false, text: weT("自动补装失败：{why}", { why: dlFailReason(code) }) });
      },
    }).catch(() => { /* dlHealStuck 内部已兜住 */ });
    return () => { alive = false; };
  }, [state, dl.jobs]);


  const act = async (kind, payload, label, ev, jobUrl) => {
    // 只有安装/卸载/导入这类**结构性**操作才锁 UI；开关与大小是幂等的。
    const structural = kind === "install" || kind === "remove" || kind === "import";
    const cardId = String((payload && payload.id) || "");
    const isInstall = kind === "install";
    // 4.23.3：安装走下载队列（payload.queue）时不锁整页 —— 进度落在卡片上，切页签回来仍在。
    const lockUi = structural && !(kind === "install" && payload && payload.queue === true);
    if (lockUi) setBusy(kind + ":" + cardId);
    // 非安装类沿用旧口径：先清上一轮提示。安装类交给 dlInstallClick（它先写即时反馈）。
    if (!isInstall) setNote(null);
    try {
      let resp;
      if (isInstall) {
        // 4.23.14：与皮肤/开机动画**同一个**实现 —— 第一行同步反馈（按钮「正在提交…」+ 卡片
        // pressed + aria-busy），再进卡片状态机，最后才发请求；300ms 没进队列就出「提交中…
        // （正在准备）」。桌宠的清单接口 `/pets/list` 因此不再挡在点击与请求之间。
        const click = await dlInstallClick({
          el: ev && ev.currentTarget,
          btnText: weT("正在提交…"),
          installed: false,
          begin: () => { cards.begin(cardId); },
          onSubmitting: () => { setNote({ ok: true, text: weT("正在提交…") }); },
          onPreparing: (text) => { setNote({ ok: true, text }); },
          jobActive: () => dlJobActive(dlJobForCard(jobsRef.current, "pet", jobUrl)),
          submit: () => apiPostJson("/pets/install", payload || {}, { parse: "always" }),
        });
        resp = click.resp;
      } else {
        resp = await apiPostJson("/pets/" + kind, payload || {}, { parse: "always" });
      }
      const r = (resp && resp.data) || null;
      if (resp && resp.ok && r && r.ok) {
        if (kind === "install") {
          // 宿主回 202 pending（zip 交给队列）：进度看 list，下完宿主会自己再调一次落地。
          if (r.pending && r.jobId) {
            // 拿到 jobId ⇒ 卡片交给队列显示，不再停在「正在提交…」（那会把真进度盖住）。
            cards.end(cardId);
            dl.refresh();
            setNote({ ok: true, text: dlBusyLabel({ percent: 0, mode: r.mode }) });
            const done = await dlAwaitJob(r.jobId);
            if (done && done.status === "done") setNote({ ok: true, text: weT("已安装并启用：{name}", { name: label || "" }) });
            else if (done && (done.status === "lost" || done.status === "timeout")) {
              // 兜底核对（4.23.6）：先问列表"到底装上没有"，再决定是失败还是成功。
              const okNow = await petsInstalledNow(cardId);
              if (okNow) {
                cards.markOk(cardId);
                setNote({ ok: true, text: weT("已确认装好：{name}", { name: label || "" }) });
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
          setNote({ ok: true, text: weT("已安装并启用：{name}", { name: label || "" }) });
        }
        if (kind === "remove") setNote({ ok: true, text: weT("已卸载：{name}", { name: label || "" }) });
        if (kind === "import") setNote({ ok: true, text: weT("已导入并启用：{name}", { name: label || "" }) });
        if (kind === "config") setNote({ ok: true, text: weT("已保存") });
        // config 的响应里带新的 config（{ ok, config }）⇒ 直接并进 state，
        // 不再 load(true) 重拉整个清单（那次重拉会让所有按钮先禁用再恢复 = 闪动）。
        if (kind === "config" && r && r.config) {
          setState((prev) => (prev ? { ...prev, config: r.config } : prev));
        } else {
          await load(true);
        }
      } else {
        const code = (r && r.error) || "failed";
        if (isInstall && cardId) cards.fail(cardId, code);
        // 失败原因与人话文案同样走共用表（与皮肤 / 开机动画逐字一致，不再各写一套）。
        setNote({ ok: false, text: dlFailReason(code) });
      }
    } catch (e) {
      const why = e && e.message ? String(e.message) : "";
      if (isInstall && cardId) cards.fail(cardId, /timeout|超时/i.test(why) ? "submit-timeout" : "network");
      setNote({ ok: false, text: weT("请求失败：{msg}", { msg: why || weT("网络错误") }) });
    } finally {
      // 请求返回/失败/超时 ⇒ 退出「正在提交…」（成功分支已提前 end 的话这里是空操作）。
      if (isInstall && cardId) cards.end(cardId);
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
      weT("🐾 桌宠")),
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

  // 与开机动画页签同理：提示行常驻占位，避免开关时整块高度跳动。
  children.push(React.createElement("div", {
    key: "note",
    className: "we-picker__hint",
    style: {
      color: note && !note.ok ? "rgba(255,140,140,0.95)" : "rgba(120,220,150,0.95)",
      margin: "2px 0 8px", minHeight: "18px", lineHeight: "18px",
      opacity: note ? 1 : 0, transition: "opacity 120ms linear",
    },
  }, note ? note.text : "\u00a0"));

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
            weT("{cols} 列 · {size}", { cols: p.columns || 8, size: p.cell ? p.cell.width + "×" + p.cell.height : "" })),
          React.createElement("div", { style: PET_STYLE.row }, actions),
        );
      })
      : React.createElement("div", { className: "we-picker__hint" }, weT("还没有安装任何桌宠 —— 从下面的站点清单里挑一只。")),
  ));

  // 本机其它宠物插件里可导入的（dsh-pet 等下载的宠物就落在 $DSH_HOME/pets）
  if (importable.length) {
    children.push(React.createElement("div", { key: "impHead", className: "we-picker__section-head", style: { marginTop: "14px" } },
      React.createElement("span", { className: "we-picker__section-label" },
        weT("本机可导入")),
    ));
    children.push(React.createElement("div", { key: "imp", style: PET_STYLE.grid },
      importable.map((it) => {
        const isBusy = busy === "import:" + it.id;
        return React.createElement("div", { key: "imp:" + it.id, style: PET_STYLE.card },
          React.createElement("div", { style: PET_STYLE.title }, it.name || it.id),
          React.createElement("div", { style: PET_STYLE.meta },
            weT("来自其它宠物插件 · {size}", { size: petFmtBytes(it.bytes) })),
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
      weT("站点桌宠")),
    state.siteError
      ? React.createElement("span", { className: "we-picker__hint", style: { marginLeft: "auto" } }, weT("站点不可达"))
      : null,
  ));

  if (available.length) {
    children.push(React.createElement("div", { key: "site", style: PET_STYLE.grid },
      available.map((s) => {
        // 4.23.3：按 kind=pet + url 找回这条的下载 job（挂载时已在跑的也认得出）。
        const job = dlJobForCard(dl.jobs, "pet", s.url);
        // 4.23.4：卡片状态由**四模块共用**的状态机决定（文案/禁用/失败原因+重试都在那一处）。
        const st = cards.stateOf({ id: s.id, job, done: false, labels: petDlLabels });
        // running 沿用 4.23.3 的紧凑文案（`下载中… 42% · 多连接(8)`），MB/剩余时间在下面那行明细里。
        const label = st.phase === "running" ? dlBusyLabel(job) : st.label;
        return React.createElement("div", { key: "site:" + s.id, className: "we-dl-card", style: PET_STYLE.card },
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
            // 只禁**这一张**卡片（提交中/排队/在下/解压）；别的卡片在动不影响它。
            // 4.23.14：事件与本条 url 一并交给 act ⇒ 同步反馈 + 300ms 占位判定。
            btn(label, (ev) => act("install", { id: s.id, queue: true }, s.title || s.id, ev, s.url), st.disabled)),
          // 进度 / 原因明细：`12.3/16.6 MB · 约剩 41 秒`、`排队中：前面还有 2 个任务`、
          // 或失败原因（红字）。失败时按钮上是「重试」，点它立刻重新提交。
          st.detail
            ? React.createElement("div", {
              style: { ...PET_STYLE.meta, color: st.phase === "failed" ? "#ff9a9a" : undefined },
            }, st.detail)
            : null,
        );
      }),
    ));
  } else if (!site.length) {
    children.push(React.createElement("div", { key: "siteEmpty", className: "we-picker__hint", style: { marginTop: "6px" } },
      weT("站点上还没有桌宠。")));
  }

  // ── 桌宠对话（/folia/pet-chat/*）────────────────────────────────────────
  // 放在页签底部，紧跟「显示桌宠 / 声音 / 音量 / 复位位置 / 大小」之后。
  children.push(React.createElement(PetChatSettings, { key: "petChat" }));

  return React.createElement("div", { className: "we-picker__section" }, children);
}

/* ── 桌宠对话设置区 ─────────────────────────────────────────────────────── */

const CHAT_DEFAULTS = {
  enabled: false,
  provider: 'openai',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  apiKeyMasked: '',
  hasApiKey: false,
  persona: { name: '', traits: '', notes: '' },
  maxTurns: 8,
  maxChars: 80,
  voiceOut: { enabled: true, rate: 1, pitch: 1, volume: 1, voiceURI: '' },
  voiceEngine: 'system',
  memoryEnabled: true,
  proactive: { enabled: false, dailyLimit: 10, minGapMin: 120, quietHours: '22:00-08:00' },
  voiceEnabled: false,
};

const PROVIDER_PRESETS = {
  openai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
};

function PetChatSettings() {
  const [draft, setDraft] = React.useState(CHAT_DEFAULTS);
  const [status, setStatus] = React.useState({ ok: null, text: '' });
  const [note, setNote] = React.useState(null);
  const [showKey, setShowKey] = React.useState(false);
  const [memory, setMemory] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const update = React.useCallback((patch) => setDraft((prev) => ({ ...prev, ...patch })), []);

  const load = React.useCallback(async () => {
    try {
      const resp = await apiJson('/pet-chat/config', { parse: 'always' });
      const doc = (resp && resp.data) || null;
      if (doc && doc.ok !== false) {
        setDraft({ ...CHAT_DEFAULTS, ...doc, apiKey: '' });
        setStatus(doc.hasApiKey
          ? { ok: true, text: weT('已保存的 Key：{mask}', { mask: doc.apiKeyMasked || '••••' }) }
          : { ok: null, text: weT('还没有填 API Key') });
      }
    } catch { /* 首次加载失败不打扰：保存时会报 */ }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setBusy(true);
    try {
      const resp = await apiJson('/pet-chat/config', {
        method: 'POST',
        body: { ...draft, apiKey: draft.apiKey || '' },
        parse: 'always',
      });
      const doc = (resp && resp.data) || {};
      if (doc.saved) {
        setNote({ ok: true, text: weT('已保存') });
        await load();
        const state = await apiJson('/pet-chat/state', { parse: 'always' });
        const sdoc = (state && state.data) || {};
        setStatus(sdoc.reachable
          ? { ok: true, text: weT('已连接 · {p} · {m}', { p: sdoc.provider || draft.provider, m: sdoc.model || draft.model }) }
          : { ok: false, text: sdoc.lastError ? weT('未连接：{e}', { e: sdoc.lastError }) : weT('已保存，但还没连上') });
      } else {
        setNote({ ok: false, text: weT('保存失败') });
      }
    } catch (e) {
      setNote({ ok: false, text: weT('保存失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally { setBusy(false); }
  };

  const testConnection = async () => {
    setBusy(true);
    try {
      const resp = await apiJson('/pet-chat/test', {
        method: 'POST',
        body: { provider: draft.provider, baseUrl: draft.baseUrl, apiKey: draft.apiKey || '' },
        parse: 'always',
      });
      const doc = (resp && resp.data) || {};
      setStatus(doc.ok
        ? { ok: true, text: weT('已连接 · {p}', { p: doc.provider || draft.provider }) }
        : { ok: false, text: doc.message || weT('连接失败') });
    } catch (e) {
      setStatus({ ok: false, text: weT('连接失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally { setBusy(false); }
  };

  const switchProvider = (provider) => {
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.openai;
    update({ provider, baseUrl: preset.baseUrl, model: preset.model, ...(provider === 'ollama' ? { apiKey: '' } : {}) });
  };

  const voices = (() => {
    try {
      const list = typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.getVoices
        ? window.speechSynthesis.getVoices() : [];
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  })();

  const row = (label, node) => React.createElement('label', { key: label, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0' } },
    weT(label), node);

  const child = [];
  child.push(React.createElement('div', { key: 'title', style: { fontWeight: 600, margin: '14px 0 6px', fontSize: '13px' } }, weT('桌宠对话')));
  child.push(row('开启对话', React.createElement('input', {
    type: 'checkbox', checked: Boolean(draft.enabled), disabled: busy,
    onChange: (e) => update({ enabled: e.target.checked }),
  })));
  child.push(row('模型来源', React.createElement('select', {
    value: draft.provider, disabled: busy,
    onChange: (e) => switchProvider(e.target.value),
  },
  React.createElement('option', { value: 'openai' }, 'OpenAI 兼容'),
  React.createElement('option', { value: 'ollama' }, weT('本机 Ollama')))));
  child.push(row('接口地址', React.createElement('input', {
    type: 'text', value: draft.baseUrl, disabled: busy || draft.provider === 'ollama',
    style: { flex: 1, minWidth: 0 }, onChange: (e) => update({ baseUrl: e.target.value }),
  })));
  child.push(row('模型名', React.createElement('input', {
    type: 'text', value: draft.model, disabled: busy,
    style: { flex: 1, minWidth: 0 }, onChange: (e) => update({ model: e.target.value }),
  })));
  child.push(React.createElement('div', { key: 'key', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0' } },
    weT('API Key'),
    React.createElement('input', {
      type: showKey ? 'text' : 'password',
      value: draft.apiKey || '',
      placeholder: draft.hasApiKey ? (draft.apiKeyMasked || '••••••••') : '',
      disabled: busy || draft.provider === 'ollama',
      style: { flex: 1, minWidth: 0 },
      onChange: (e) => update({ apiKey: e.target.value }),
    }),
    React.createElement('button', { type: 'button', className: 'we-picker__btn', disabled: busy, onClick: () => setShowKey((v) => !v) }, showKey ? weT('隐藏') : weT('显示')),
    React.createElement('button', { type: 'button', className: 'we-picker__btn', disabled: busy, onClick: testConnection }, weT('测试连接')),
  ));

  child.push(React.createElement('div', { key: 'persona', style: { display: 'flex', gap: '6px', fontSize: '12px', margin: '4px 0', flexWrap: 'wrap' } },
    weT('人设'),
    React.createElement('input', { type: 'text', placeholder: weT('名字'), value: (draft.persona && draft.persona.name) || '', style: { width: '80px' }, disabled: busy, onChange: (e) => update({ persona: { ...draft.persona, name: e.target.value } }) }),
    React.createElement('input', { type: 'text', placeholder: weT('性格'), value: (draft.persona && draft.persona.traits) || '', style: { flex: 1, minWidth: '120px' }, disabled: busy, onChange: (e) => update({ persona: { ...draft.persona, traits: e.target.value } }) }),
    React.createElement('input', { type: 'text', placeholder: weT('备注'), value: (draft.persona && draft.persona.notes) || '', style: { flex: 1, minWidth: '120px' }, disabled: busy, onChange: (e) => update({ persona: { ...draft.persona, notes: e.target.value } }) }),
  ));
  child.push(React.createElement('div', { key: 'limits', style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', margin: '4px 0' } },
    weT('上下文轮数'),
    React.createElement('input', { type: 'number', min: 1, max: 12, value: draft.maxTurns, style: { width: '64px' }, disabled: busy, onChange: (e) => update({ maxTurns: Number(e.target.value) }) }),
    weT('字数上限'),
    React.createElement('input', { type: 'number', min: 20, max: 160, value: draft.maxChars, style: { width: '64px' }, disabled: busy, onChange: (e) => update({ maxChars: Number(e.target.value) }) }),
  ));

  child.push(React.createElement('div', { key: 'voice', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '6px 0 0', flexWrap: 'wrap' } },
    React.createElement('label', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
      React.createElement('input', { type: 'checkbox', checked: Boolean(draft.voiceOut && draft.voiceOut.enabled), disabled: busy, onChange: (e) => update({ voiceOut: { ...draft.voiceOut, enabled: e.target.checked } }) }),
      weT('朗读回答')),
    weT('音色'),
    React.createElement('select', {
      className: 'we-picker__playlist-select', value: (draft.voiceOut && draft.voiceOut.voiceURI) || '', disabled: busy,
      onChange: (e) => update({ voiceOut: { ...draft.voiceOut, voiceURI: e.target.value } }),
    }, React.createElement('option', { value: '' }, weT('自动（中文）')), voices.slice(0, 40).map((v) => React.createElement('option', { key: v.voiceURI, value: v.voiceURI }, v.name))),
    weT('语速'),
    React.createElement('input', { type: 'range', min: 0.5, max: 2, step: 0.1, value: (draft.voiceOut && draft.voiceOut.rate) || 1, disabled: busy, style: { width: '80px' }, onChange: (e) => update({ voiceOut: { ...draft.voiceOut, rate: Number(e.target.value) } }) }),
    weT('音量'),
    React.createElement('input', { type: 'range', min: 0, max: 1, step: 0.1, value: (draft.voiceOut && draft.voiceOut.volume) || 1, disabled: busy, style: { width: '80px' }, onChange: (e) => update({ voiceOut: { ...draft.voiceOut, volume: Number(e.target.value) } }) }),
    React.createElement('button', {
      type: 'button', className: 'we-picker__btn', disabled: busy,
      onClick: () => {
        try {
          const synth = window.speechSynthesis;
          if (!synth) { setNote({ ok: false, text: weT('这台机器没有系统语音') }); return; }
          synth.cancel();
          const utter = new window.SpeechSynthesisUtterance(weT('你好，我是你的桌宠。'));
          utter.rate = (draft.voiceOut && draft.voiceOut.rate) || 1;
          utter.volume = (draft.voiceOut && draft.voiceOut.volume) || 1;
          synth.speak(utter);
        } catch { setNote({ ok: false, text: weT('试听失败') }); }
      },
    }, weT('试听')),
  ));

  child.push(row('朗读引擎', React.createElement('select', {
    value: draft.voiceEngine || 'system', disabled: busy,
    onChange: (e) => update({ voiceEngine: e.target.value }),
  },
  React.createElement('option', { value: 'system' }, weT('系统语音')),
  React.createElement('option', { value: 'edge' }, weT('在线情感 edge-tts')))));

  child.push(React.createElement('div', { key: 'memory', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0' } },
    React.createElement('label', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
      React.createElement('input', { type: 'checkbox', checked: draft.memoryEnabled !== false, disabled: busy, onChange: (e) => update({ memoryEnabled: e.target.checked }) }),
      weT('长期记忆')),
    React.createElement('button', {
      type: 'button', className: 'we-picker__btn', disabled: busy,
      onClick: async () => {
        try {
          const resp = await apiJson('/pet-chat/memory', { parse: 'always' });
          setMemory(((resp && resp.data) || {}).memory || {});
        } catch { setNote({ ok: false, text: weT('读取记忆失败') }); }
      },
    }, weT('查看记忆')),
    React.createElement('button', {
      type: 'button', className: 'we-picker__btn', disabled: busy,
      onClick: async () => {
        try {
          await apiJson('/pet-chat/memory', { method: 'DELETE', parse: 'always' });
          setMemory(null);
          setNote({ ok: true, text: weT('记忆已清空') });
        } catch { setNote({ ok: false, text: weT('清空失败') }); }
      },
    }, weT('清空记忆')),
  ));
  if (memory) {
    const parts = [];
    if (memory.nickname) parts.push(weT('称呼') + '：' + memory.nickname);
    if (Array.isArray(memory.likes) && memory.likes.length) parts.push(weT('喜欢') + '：' + memory.likes.join('、'));
    if (Array.isArray(memory.notes) && memory.notes.length) parts.push(weT('备注') + '：' + memory.notes.join('、'));
    child.push(React.createElement('div', { key: 'memoryView', className: 'we-picker__hint', style: { margin: '2px 0 6px' } }, parts.length ? parts.join('  ·  ') : weT('还没有记住任何偏好')));
  }

  child.push(React.createElement('div', { key: 'proactive', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0', flexWrap: 'wrap' } },
    React.createElement('label', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
      React.createElement('input', { type: 'checkbox', checked: Boolean(draft.proactive && draft.proactive.enabled), disabled: busy, onChange: (e) => update({ proactive: { ...draft.proactive, enabled: e.target.checked } }) }),
      weT('主动闲聊')),
    weT('每日'),
    React.createElement('input', { type: 'number', min: 1, max: 20, value: (draft.proactive && draft.proactive.dailyLimit) || 10, style: { width: '56px' }, disabled: busy, onChange: (e) => update({ proactive: { ...draft.proactive, dailyLimit: Number(e.target.value) } }) }),
    weT('间隔(分)'),
    React.createElement('input', { type: 'number', min: 30, max: 720, value: (draft.proactive && draft.proactive.minGapMin) || 120, style: { width: '64px' }, disabled: busy, onChange: (e) => update({ proactive: { ...draft.proactive, minGapMin: Number(e.target.value) } }) }),
    weT('夜间静默'),
    React.createElement('input', { type: 'text', value: (draft.proactive && draft.proactive.quietHours) || '22:00-08:00', style: { width: '110px' }, disabled: busy, onChange: (e) => update({ proactive: { ...draft.proactive, quietHours: e.target.value } }) }),
  ));

  child.push(React.createElement('label', { key: 'asr', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0 8px', opacity: 0.7 } },
    React.createElement('input', { type: 'checkbox', checked: Boolean(draft.voiceEnabled), disabled: true }),
    weT('语音输入（需先在 DSH 开启）'),
  ));

  child.push(React.createElement('div', { key: 'status', className: 'we-picker__hint', style: { margin: '2px 0 6px', color: status.ok === false ? '#f87171' : undefined } },
    status.text || weT('未连接')));
  if (note && note.text) {
    child.push(React.createElement('div', { key: 'note', className: 'we-picker__hint', style: { color: note.ok ? undefined : '#f87171' } }, note.text));
  }
  child.push(React.createElement('div', { key: 'save', style: { display: 'flex', gap: '6px', marginTop: '4px' } },
    React.createElement('button', { type: 'button', className: 'we-picker__btn', disabled: busy, onClick: save }, weT('保存')),
  ));

  return React.createElement('div', { style: { ...PET_STYLE.card, marginTop: '10px' } }, child);
}

/** 页签组装点调用它。 */
function renderPetsTab() {
  return React.createElement(PetsTabPanel, null);
}
