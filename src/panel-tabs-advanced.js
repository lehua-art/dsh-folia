/**
 * 「系统」页签的节渲染器（原 src/panel-tabs.js）：浏览 / 兼容 / 适配器 /
 * 电源 / 缓存 / 诊断。renderAdvancedTab 仍在组装点，按顺序调这六节。
 * 本节渲染器从 src/panel-tabs.js 按域搬出，函数体逐字未改；内联顺序见 scripts/build-client.mjs（排在组装点之前）。
 */
  function renderAdvancedBrowsingSection(ctx) {
    const { onLayoutChange, sel } = ctx;
    return React.createElement(React.Fragment, null,
    // ── 浏览方式：紧凑 CD 架 vs 常规分页网格 ──
    React.createElement("div", { className: "we-picker__section" },
      React.createElement("div", { className: "we-picker__section-head" },
        React.createElement("span", { className: "we-picker__section-label" }, weT("浏览方式")),
      ),
      // Card style: classic (WE's original aspect-ratio 16/9 cards — the CD-like
      // look) vs the rewritten fixed-height cards that never overlap.
      switchRow(weT("紧凑布局"), sel.pickerLayout === "classic", (e) => onLayoutChange(e.target.checked ? "classic" : "fixed"), {
        hint: sel.pickerLayout === "classic" ? weT("CD 架：层叠 + 一页到底") : weT("常规网格 · 分页"),
        tooltip: weT("紧凑 CD 架：层叠 + 一页到底"),
      }),
    ),
    );
  }

  function renderAdvancedCompatSection(ctx) {
    const { onEdgeCompatChange, sel } = ctx;
    return React.createElement(React.Fragment, null,
    // ── 兼容性 ──
    React.createElement("div", { className: "we-picker__section" },
      React.createElement("div", { className: "we-picker__section-head" },
        React.createElement("span", { className: "we-picker__section-label" }, weT("兼容性")),
      ),
      // Edge 兼容渲染开关：仅在 Edge 中生效（canvas 渲染，避免浏览器自带的
      // 「下载 / 投屏」悬浮工具栏）。
      switchRow(weT("Edge 兼容"), sel.edgeCompat !== false, (e) => onEdgeCompatChange(e.target.checked), {
        hint: weT("Edge 下视频壁纸走 canvas 渲染"),
        tooltip: weT("Edge 兼容：视频壁纸改用 canvas 渲染，避免浏览器自带的「下载 / 投屏」悬浮工具栏；关闭则始终使用原生 <video>"),
      }),
    ),
    );
  }

  function renderAdvancedAdapterSection(ctx) {
    const { onAdapterTarget, sel } = ctx;
    return React.createElement(React.Fragment, null,
    // ── 适配（适配器模式）：本页跑在哪种宿主形态里 —— 自动检测 + 可手选 ──
    // 检测事实来源在宿主侧（能力头 / UA，见 lib/index.js 的 3c-0），客户端拿
    // 上报值 + 本地信号兜底；手选优先于检测，是检测不准时的自救。
    React.createElement("div", { className: "we-picker__section" },
      React.createElement("div", { className: "we-picker__section-head" },
        React.createElement("span", {
          className: "we-picker__section-label",
          title: weT("适配目标决定四件事：网页壁纸载荷走哪个源（有无能力头栅栏）、桌面壳材质规则是否生效、窗口失焦暂停是否适用、面板哪些行可用。默认自动检测，检测不准时可手选覆盖（手选优先）。"),
        }, weT("适配", null, "adapter")),
      ),
      React.createElement("div", { className: "we-picker__ctl" },
        ctlText(weT("适配目标"), weT("自动检测 · 手选可覆盖")),
        React.createElement("select", {
          className: "we-picker__select",
          value: ADAPTER_TARGET_VALUES.includes(sel.adapterTarget) ? sel.adapterTarget : "auto",
          onChange: onAdapterTarget,
          "aria-label": weT("适配目标"),
        },
          ADAPTER_TARGET_VALUES.map((t) =>
            React.createElement("option", { key: t, value: t }, ADAPTER_LABELS[t] || t)),
        ),
      ),
      // 状态行只反映**检测**（与手选无关），且必须与宿主 mediaOriginNeeded 的
      // 三分支逐条对齐 —— 否则文案会说错载荷到底走哪个源：栅栏 ⇒ 独立媒体源；
      // 无栅栏的桌面形态（Electron UA）**仍然**走独立媒体源（安全默认）；只有
      // 原生浏览器才走应用源。desktop/fence 取自 adapterCaps（最终目标 + 上报）。
      React.createElement("div", { className: "we-picker__hint", key: "adapter-detected" },
        weT("检测到：{target}{suffix}", {
          target: weT(adapterDetectedLabel()),
          suffix: adapterCaps().fence
            ? weT(" · 有能力头栅栏（网页壁纸走独立媒体源）")
            : adapterCaps().desktop
              ? weT(" · 无栅栏的桌面形态（网页壁纸仍走独立媒体源）")
              : weT(" · 无栅栏（网页壁纸走应用源）"),
        })),
      adapterMismatchWarning() && React.createElement("div", { className: "we-picker__hint", key: "adapter-warn" },
        adapterMismatchWarning()),
    ),
    );
  }

  function renderAdvancedPowerSection(ctx) {
    const { onPauseOnBattery, onPauseOnBlur, onPauseOnHidden, sel } = ctx;
    return React.createElement(React.Fragment, null,
    // ── 省电：遮挡暂停（借鉴 Wallpaper Engine 的「被遮挡时暂停」）──
    React.createElement("div", { className: "we-picker__section" },
      React.createElement("div", { className: "we-picker__section-head" },
        React.createElement("span", {
          className: "we-picker__section-label",
          title: weT("类似 WE 的遮挡暂停：最小化、切到其它应用或使用电池供电时视频暂停、GPU 解码归零；回到界面 / 接通电源自动继续（网页壁纸仅随页面隐藏被浏览器节流）"),
        }, weT("省电")),
      ),
      switchRow(weT("最小化/切页时暂停"), sel.pauseOnHidden, onPauseOnHidden, { key: "pause-hidden" }),
      // 失焦档按适配目标显隐：桌面壳失焦时壁纸多半仍整块可见，暂停会定格
      // **可见**画面 ⇒ 本目标下不提供；值不删，切到浏览器目标即重新生效。
      adapterCaps().blurPause
        && switchRow(weT("窗口失焦时暂停"), sel.pauseOnBlur, onPauseOnBlur, { key: "pause-blur" }),
      !adapterCaps().blurPause && React.createElement("div", { className: "we-picker__hint", key: "pause-blur-note" },
        weT("「窗口失焦时暂停」只在原生浏览器目标下提供 —— 桌面壳失焦时壁纸仍可见，暂停会定格可见画面{note}", {
          note: sel.pauseOnBlur ? weT("（当前已开启，本目标下不生效，切到浏览器目标后恢复）") : "",
        })),
      switchRow(weT("使用电池时暂停"), sel.pauseOnBattery, onPauseOnBattery, { key: "pause-battery" }),
    ),
    );
  }

  function renderAdvancedCacheSection(ctx) {
    const { onCacheDirDraft, onCancelEditCacheDir, onStartEditCacheDir, sel,
      onCacheDirBrowseInput, onCacheDirBrowseGo, onCacheDirBrowseEnter, onCacheDirBrowseUp, onPickCacheDir, onCloseCacheDirBrowse } = ctx;
    const browse = sel.cacheDirBrowse;
    return React.createElement(React.Fragment, null,
    // ── 缓存位置：转码产物 / faststart 变体 / 静态帧 / 预览图 / 媒体桥缓存都是**可再生**的
    //    大块文件（本机实测到 GB 级），默认落在插件数据目录 —— Windows 上那个目录仍在 C 盘
    //    用户目录下，这正是「C 盘洁癖」的触发点。持久化在宿主 config.json 的 cacheDir，
    //    经 /cache-dir 端点读写；显示值一律取宿主返回的**解析链答案**（设了
    //    `DSH_FOLIA_CACHE_DIR` 时它与用户填的值不同 —— 那是环境变量覆盖，不是保存失败）。──
    React.createElement("div", { className: "we-picker__section" },
      React.createElement("div", { className: "we-picker__section-head" },
        React.createElement("span", { className: "we-picker__section-label" }, weT("缓存位置")),
      ),
      React.createElement("div", { className: "we-picker__uploads" },
      React.createElement("div", { className: "we-picker__row" },
        React.createElement("span", { className: "we-picker__hint we-picker__label" }, weT("缓存目录")),
        React.createElement("span", {
          className: "we-picker__uploads-path",
        }, sel.inventory.cacheDir || "—"),
        React.createElement("button", {
          className: "we-picker__btn", type: "button",
          disabled: sel.cacheDirBusy,
          onClick: onStartEditCacheDir,
        }, weT("更改")),
      ),
      // 目录浏览器开着时草稿行让位（地址栏就在浏览器里，两行输入框互相打架）；
      // 选中后浏览器收起、草稿行带着填好的路径回来，保存/迁移语义不变。
      sel.editingCacheDir && !browse && React.createElement("div", { className: "we-picker__row" },
        React.createElement("input", {
          className: "we-picker__text", type: "text",
          value: sel.cacheDirDraft,
          placeholder: weT("绝对路径，如 D:\\WallpaperEngineCache"),
          onInput: onCacheDirDraft,
          onKeyDown: (e) => {
            if (e.key === "Enter") changeCacheDir(sel.cacheDirDraft, true);
            if (e.key === "Escape") onCancelEditCacheDir();
          },
        }),
        React.createElement("button", {
          className: "we-picker__btn", type: "button",
          disabled: sel.cacheDirBusy,
          onClick: () => changeCacheDir(sel.cacheDirDraft, true),
        }, weT("保存")),
        React.createElement("button", {
          className: "we-picker__btn", type: "button",
          onClick: onCancelEditCacheDir,
        }, weT("取消")),
      ),
      // 目录浏览器：宿主列目录（GET /cache-dir/browse），这里只管点着进出 ——
      // 客户端不做路径拼接，条目的 path 原样回传问下一级。选中 = 把地址栏（或最后
      // 到达的一级）填进草稿，走既有保存链。
      browse && React.createElement("div", { className: "we-dirpick" },
        React.createElement("div", { className: "we-dirpick__bar" },
          React.createElement("input", {
            className: "we-picker__text we-dirpick__path", type: "text",
            value: browse.display || "",
            placeholder: weT("绝对路径，如 D:\\WallpaperEngineCache"),
            onInput: onCacheDirBrowseInput,
            onKeyDown: (e) => {
              if (e.key === "Enter") onCacheDirBrowseGo();
              if (e.key === "Escape") onCloseCacheDirBrowse();
            },
          }),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            disabled: !browse.parent || browse.loading,
            title: weT("上一级"),
            onClick: onCacheDirBrowseUp,
          }, weT("上一级")),
        ),
        React.createElement("div", { className: "we-dirpick__chips" },
          React.createElement("button", {
            className: "we-picker__btn we-dirpick__chip", type: "button",
            disabled: browse.loading,
            onClick: () => onCacheDirBrowseEnter(""),
          }, weT("此电脑")),
          browse.home && React.createElement("button", {
            className: "we-picker__btn we-dirpick__chip", type: "button",
            disabled: browse.loading,
            onClick: () => onCacheDirBrowseEnter(browse.home),
          }, weT("主目录")),
          sel.inventory.cacheDir && React.createElement("button", {
            className: "we-picker__btn we-dirpick__chip", type: "button",
            disabled: browse.loading,
            onClick: () => onCacheDirBrowseEnter(sel.inventory.cacheDir),
          }, weT("当前缓存位置")),
        ),
        React.createElement("div", { className: "we-dirpick__list" },
          browse.loading && React.createElement("div", { className: "we-dirpick__empty" },
            weT("正在读取目录…")),
          !browse.loading && browse.error && React.createElement("div", { className: "we-picker__error" },
            browse.error),
          !browse.loading && !browse.error && !browse.dirs.length && React.createElement("div", { className: "we-dirpick__empty" },
            weT("没有子目录")),
          !browse.loading && browse.dirs.map((d, i) => {
            // 条目形状防御：宿主契约是 { name, path }，但万一拿到裸字符串（服务端形态
            // 漂移）也能渲染出名字、点进去 —— 空行比报错更难排查。
            const label = typeof d === "string" ? d : String((d && d.name) || (d && d.path) || "");
            const path = typeof d === "string" ? d : String((d && d.path) || "");
            return React.createElement("button", {
              key: path || label || i, type: "button", className: "we-dirpick__item",
              title: path,
              onClick: () => onCacheDirBrowseEnter(path),
            }, label || "—");
          }),
        ),
        browse.truncated && React.createElement("div", { className: "we-picker__hint" },
          weT("目录项过多，仅显示部分")),
        React.createElement("div", { className: "we-dirpick__foot" },
          React.createElement("span", {
            className: "we-picker__hint we-dirpick__sel", title: browse.display || "",
          }, browse.display || "—"),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            disabled: browse.loading || !(String(browse.display || "").trim() || browse.path),
            onClick: onPickCacheDir,
          }, weT("选择此目录")),
          React.createElement("button", {
            className: "we-picker__btn", type: "button",
            onClick: onCloseCacheDirBrowse,
          }, weT("取消")),
        ),
      ),
      React.createElement("div", { className: "we-picker__row" },
        React.createElement("span", { className: "we-picker__hint" },
          weT("已有缓存会迁移到新位置")),
        React.createElement("span", { className: "we-picker__hint" },
          weT("缓存可再生，随时可删")),
      ),
      sel.cacheDirNote && React.createElement("div", { className: "we-picker__hint" },
        sel.cacheDirNote),
      sel.cacheDirError && React.createElement("div", { className: "we-picker__error" },
        sel.cacheDirError),
      // 4.23.7：「缓存管理」—— 同一节里**接在缓存位置之后**（搬动/新增节都会改
      // 「系统」页签的节序列，那是 `verify-scene-live` 的细锚；这条是"同一节的又一组行"）。
      renderCacheManagerBlock(ctx),
      ),
    ),
    );
  }

  /**
   * 「缓存管理」这一组行（4.23.7）：五层用量 + 五个清理按钮 + 释放量提示。
   *
   * 为什么放在**同一个节**里（不新开 `we-picker__section`）：
   *   「系统」页签的节序列与控件标签序列是 `test/verify-scene-live.mjs` 的硬锚
   *   （它是纯搬动唯一会破坏的东西）。缓存位置与缓存管理回答的是同一个问题
   *   （"这些可再生的文件占了我多少地方"），合成一节既准确又不改那条锚。
   *
   * 为什么按钮是**显式五个**而不是"一个清全部的开关 + 勾选"：
   *   `skins`（已装皮肤）清掉等于把皮肤中心的皮肤**全部卸载**，是不可撤销的破坏性动作；
   *   它必须是**用户单独指到**的那一个按钮（二次确认），不能被"一键清理"顺手带走。
   *   `electron`（Electron 自己的 Cache/GPUCache）被占用是常态 ⇒ 只能尽力删并提示重启。
   */
  function renderCacheManagerBlock(ctx) {
    const { sel, onClearCache, onClearCacheSkins, onRefreshCacheUsage, armedConfirm, onDisarmConfirm } = ctx;
    const { onVerifyMedia, onRefreshMediaHealth } = ctx;
    // 4.23.18「队列运维」：暂停全部 / 清空未开始（处理器由 client.js 注入，见 renderAdvancedTab 的 ctx）。
    const { onToggleQueuePause, onClearQueuedDownloads, onRefreshQueueStatus } = ctx;
    const queuePaused = Boolean(sel && sel.queuePaused);
    const queueBusy = Boolean(sel && sel.queueBusy);
    const queueQueued = Math.max(0, Number(sel && sel.queueQueuedCount) || 0);
    const queuePending = Math.max(0, Number(sel && sel.queuePendingCount) || 0);
    const usage = sel && sel.cacheUsage;
    const items = (usage && Array.isArray(usage.items)) ? usage.items : [];
    const rowOf = (t) => items.find((x) => x && x.target === t) || null;
    const busy = Boolean(sel && sel.cacheBusy);
    const clearing = Boolean(sel && sel.cacheBusy === "clear");
    const fmt = (n) => (typeof fmtCacheBytes === "function" ? fmtCacheBytes(n) : String(n));
    const clear = (targets) => { try { onClearCache(targets); } catch { /* 处理器缺失不影响渲染 */ } };
    const btn = (key, label, targets, title) => React.createElement("button", {
      key, type: "button", className: "we-picker__btn",
      disabled: busy || !items.length,
      title: title || label,
      onClick: () => clear(targets),
    }, label);
    const line = (t, label, extra) => {
      const row = rowOf(t);
      const bytes = row ? Number(row.bytes) || 0 : 0;
      const files = row ? Number(row.files) || 0 : 0;
      const within = !row || row.within !== false;
      return React.createElement("div", { className: "we-picker__row", key: "cache-usage-" + t },
        React.createElement("span", { className: "we-picker__hint we-picker__label" }, label),
        React.createElement("span", { className: "we-picker__uploads-path" },
          within ? fmt(bytes) + " · " + files + " " + weT("个文件") : weT("不在可清理目录内")),
        extra ? React.createElement("span", { className: "we-picker__hint" }, extra) : null,
      );
    };
    const pendingSkins = String(armedConfirm || "") === "cache:skins";
    // ── 4.23.15「本地媒体自检」读数：**损坏文件 N 个（已清理/待重下）** ──
    // 为什么放在缓存区而不新开一节：用户是在"我的缓存怎么了"这个问题下看到它的；
    // 而「系统」页签的节序列是 `verify-scene-live` 的硬锚，不能为一行统计新开一节。
    const health = sel && sel.mediaHealth;
    const bad = health ? Number(health.damaged) || 0 : 0;
    const cleaned = health ? Number(health.cleaned) || 0 : 0;
    const pending = health ? Number(health.pending) || 0 : 0;
    const verifying = Boolean(sel && sel.mediaVerifyBusy);
    return React.createElement(React.Fragment, null,
      // ⚠️ 这一行**故意不用** `we-picker__section-label`：那会把「缓存管理」算成第八个"节"，
      // 改掉 `verify-scene-live` 的节序列锚（见上面"为什么放在同一个节里"）。
      React.createElement("div", { className: "we-picker__row", key: "cache-mgr-head" },
        React.createElement("span", { className: "we-picker__ctl" }, weT("缓存管理")),
        React.createElement("button", {
          className: "we-picker__btn", type: "button",
          disabled: busy, title: weT("重新统计各层用量（只读，不改盘）"),
          onClick: () => { try { onRefreshCacheUsage(); } catch { /* ignore */ } },
        }, weT("刷新")),
      ),
      React.createElement("div", { className: "we-picker__hint", key: "cache-mgr-total" },
        usage
          ? weT("合计 {size}（{n} 个文件）· 缓存都可再生，随时可删", {
            size: fmt((usage.total && usage.total.bytes) || 0),
            n: (usage.total && usage.total.files) || 0,
          })
          : weT("正在统计缓存用量…")),
      line("library", weT("媒体库（壁纸/开机动画/桌宠）")),
      line("site-media", weT("站点媒体缓存")),
      line("skins-zip", weT("皮肤包")),
      line("skins", weT("已装皮肤")),
      line("electron", weT("Electron 缓存"), weT("需重启 DSH")),
      // ── 本地媒体自检（4.23.15）──────────────────────────────────────────────
      // 读数口径与宿主 `/folia/local-check` 逐字一致：`damaged` 是**累计发现**的坏文件，
      // `cleaned` 是其中已删并排回下载队列的，`pending` 是还没修好的（还在队列里等重下）。
      React.createElement("div", { className: "we-picker__row", key: "media-health" },
        React.createElement("span", { className: "we-picker__hint we-picker__label" }, weT("损坏文件")),
        React.createElement("span", { className: "we-picker__uploads-path" },
          health
            ? String(bad) + " " + weT("个（已清理 {cleaned} / 待重下 {pending}）", { cleaned, pending })
            : weT("未校验（进本页签时自动读一次）")),
        React.createElement("button", {
          key: "media-health-refresh", type: "button", className: "we-picker__btn",
          disabled: verifying,
          title: weT("重新读取校验账本（只读，不触发校验）"),
          onClick: () => { try { onRefreshMediaHealth(); } catch { /* ignore */ } },
        }, weT("刷新")),
      ),
      // ── 4.23.18「队列运维」：两枚按钮 + 读数 ────────────────────────────────
      // 为什么放在缓存区：它们回答的是"缓存什么时候下、现在在占多少带宽"，与缓存位置同一节；
      // 同时**不新开** `we-picker__section`（「系统」页签的节序列是 verify-scene-live 的硬锚）。
      React.createElement("div", { className: "we-picker__row", key: "queue-ops" },
        React.createElement("span", { className: "we-picker__hint we-picker__label" }, weT("下载队列")),
        React.createElement("span", { className: "we-picker__uploads-path" },
          weT("排队 {q} 个 · 未缓存 {p} 个", { q: queueQueued, p: queuePending })),
        React.createElement("button", {
          key: "queue-pause", type: "button", className: "we-picker__btn",
          disabled: queueBusy,
          title: queuePaused
            ? weT("恢复取任务：之前暂停的任务会从已下载部分续传")
            : weT("不再取新任务；正在下的会先停下（已下载的部分保留，恢复后续传）"),
          onClick: () => { try { onToggleQueuePause(); } catch { /* ignore */ } },
        }, queuePaused ? weT("继续全部下载") : weT("暂停全部下载")),
        React.createElement("button", {
          key: "queue-clear", type: "button", className: "we-picker__btn",
          disabled: queueBusy || queueQueued === 0,
          title: weT("把排队中、还没开始的任务标记为未缓存；正在下和已完成的不动"),
          onClick: () => { try { onClearQueuedDownloads(); } catch { /* ignore */ } },
        }, weT("清空未开始队列")),
        React.createElement("button", {
          key: "queue-refresh", type: "button", className: "we-picker__btn",
          disabled: queueBusy,
          title: weT("重新读取队列读数（只读，不触发下载）"),
          onClick: () => { try { onRefreshQueueStatus(); } catch { /* ignore */ } },
        }, weT("刷新")),
      ),
      sel && sel.queueNote
        && React.createElement("div", { className: "we-picker__hint", key: "queue-note" }, sel.queueNote),
      sel && sel.queueError
        && React.createElement("div", { className: "we-picker__error", key: "queue-err" }, sel.queueError),
      React.createElement("div", { className: "we-picker__row", key: "cache-mgr-actions" },
        btn("clear-library", weT("清空媒体"), ["library"], weT("删除已下载的壁纸 / 开机动画 / 桌宠（可重新下载）")),
        btn("clear-site-media", weT("清空站点媒体"), ["site-media"]),
        btn("clear-skins-zip", weT("清空皮肤包"), ["skins-zip"]),
        // 破坏性：清掉 = 皮肤中心那边的皮肤全部卸载。两段式（上膛 → 确认）。
        pendingSkins
          ? React.createElement(React.Fragment, null,
            React.createElement("button", {
              key: "clear-skins-confirm", type: "button", className: "we-picker__btn",
              disabled: clearing, title: weT("确认卸载全部已装皮肤（不可撤销）"),
              onClick: () => { try { onClearCacheSkins(); } catch { /* ignore */ } },
            }, weT("确认清空已装皮肤")),
            React.createElement("button", {
              key: "clear-skins-cancel", type: "button", className: "we-picker__btn",
              onClick: () => { try { onDisarmConfirm(); } catch { /* ignore */ } },
            }, weT("取消")))
          : React.createElement("button", {
            key: "clear-skins", type: "button", className: "we-picker__btn",
            disabled: busy || !items.length,
            title: weT("清空已装皮肤（等于把皮肤中心的皮肤全部卸载，需二次确认）"),
            onClick: () => { try { onClearCacheSkins(); } catch { /* ignore */ } },
          }, weT("清空已装皮肤…")),
        btn("clear-electron", weT("清空 Electron 缓存"), ["electron"], weT("清的是 Electron 自己的 Cache / GPUCache；占用中的文件请重启 DSH 后彻底生效")),
        btn("clear-all-but-skins", weT("一键清理（不含皮肤）"),
          ["library", "site-media", "skins-zip", "electron"], weT("清掉除「已装皮肤」以外的全部缓存")),
        // 「校验并修复本地媒体」（4.23.15）= **启动自检的全量版**：逐条比 size / sha256 /
        // mp4 结构，坏的删掉并排回下载队列。它不是"清理"（不清好文件），所以单独一颗。
        React.createElement("button", {
          key: "verify-media", type: "button", className: "we-picker__btn",
          disabled: verifying,
          title: weT("逐个校验已下载的媒体文件（≤20MB 比 sha256，大文件比长度与 mp4 结构）；发现坏文件就删掉并排回下载队列"),
          onClick: () => { try { onVerifyMedia(); } catch { /* ignore */ } },
        }, verifying ? weT("校验中…") : weT("校验并修复本地媒体")),
      ),
      sel && sel.mediaVerifyNote
        && React.createElement("div", { className: "we-picker__hint", key: "media-verify-note" }, sel.mediaVerifyNote),
      sel && sel.cacheNote
        && React.createElement("div", { className: "we-picker__hint", key: "cache-mgr-note" }, sel.cacheNote),
      sel && sel.cacheError
        && React.createElement("div", { className: "we-picker__error", key: "cache-mgr-err" }, sel.cacheError),
    );
  }

  function renderAdvancedDiagSection(ctx) {
    const { onToggleLiveDiag, sel } = ctx;
    return React.createElement(React.Fragment, null,
    // ── 实时渲染诊断（本会话有效，不落盘）：只对**能走实时
    //    渲染**的壁纸（场景 / 网页）显示 —— 视频、图片壁纸没有渲染页，摆出来是空的。──
    (sel.type === "scene" || sel.type === "web") && sel.sceneLive !== false
      && React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, weT("实时渲染诊断")),
        ),
        // live 诊断日志（本会话有效，不落盘）：默认只记关键事件（准备就绪/领养/
        // 首帧确认/判失败，每轮轮换 2–3 条，写在控制台与宿主诊断缓冲
        // `/folia/diag-log`）；这里开的是**逐秒心跳读数**（fps/running/
        // 暂停原因），排查「为什么没出帧」时用。
        switchRow(
          weT("live 诊断日志"), liveDiagVerbose(), onToggleLiveDiag, {
            key: "scene-live-diag",
            hint: weT("本会话有效 · 逐秒心跳读数"),
            tooltip: weT("开启后每秒记录一次渲染页心跳读数（fps / running / 暂停原因）与准备、领养、判失败事件；同时写入浏览器控制台和宿主诊断缓冲（GET /folia/diag-log）。排查 live 掉帧/降级时用，平时关着。"),
          }),
      ),
    );
  }

export { renderAdvancedBrowsingSection, renderAdvancedCompatSection, renderAdvancedAdapterSection, renderAdvancedPowerSection, renderAdvancedCacheSection, renderAdvancedDiagSection };
