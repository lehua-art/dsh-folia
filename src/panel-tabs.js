/**
 * panel-tabs.js — 面板页签的**渲染器**（七个域：壁纸 / 外观 / 吉祥物 / 效果 / 声音 / 高级 / 关于，
 * 再加一个**模块容器**「扩展」；组合成六页签 壁纸库 / 外观 / 播放 / 系统 / 扩展 / 关于，
 * 装配点见 src/client.js 的 renderActiveTab）。
 *
 * 为什么单独一个文件：这些渲染器**读**面板状态、**调**面板处理器，但自己不持有状态 ——
 * 正是最适合独立出去的一层。这样面板组件体只剩"状态 + 处理器 + 装配"，页签怎么画看这里。
 * （「关于」除组件行状态外不读任何 ctx 字段：静态文案 + 两张随包二维码。「扩展」也只画
 * `extensionModules()` 里登记过的模块（外加组件行状态与 `onResetModule`），一张都没登记就画空态。）
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域，"外部作用域"=
 * 同一 prelude / src/client.js 的顶层）：
 *   · 每个渲染器**只从一个参数取外界**：`(ctx)`。函数体**逐字搬入**，唯一改动是开头那段
 *     解构 —— 于是"这个页签要什么"写在签名处，"怎么画"一行没动（模板字符串里的有效空白
 *     也不会被批量重排弄坏）。
 *   · ctx 由 `WallpaperPicker` 在调用点就地组装（见 src/client.js 的 `renderActiveTab`）：
 *     面板的 `sel` / 页签需要的局部视图状态 / 处理器。**多传字段无害，漏传会当场
 *     ReferenceError**（守卫会抓住）—— 这是刻意选的失败方式：响亮且可定位。
 *   · 页签**只做"读 + 组装 React 树"**，四类越界由 `test/verify-client.mjs` 的接缝判据钉住
 *     （与 `src/picker-modal.js` / `src/picker-props-panel.js` **同一条口径**）：
 *       ① 不得引用 `selection`（写入经 ctx 的 `setSetting` / `setTransient` 两个入口）；
 *       ② 不得调 `emit(`（通知归处理器）；
 *       ③ 不得改写 **ctx 别名**指向的东西（`editing` = `selection.editing`、`sel` = store 快照…）
 *          —— `editing.name = …` 是"渲染器成了状态的写入方"，那不是读；
 *       ④ 不得改写**模块级状态**（`propsPanelOpen` / `pickerFocusPending` / `pickerOpener` …）。
 *     ③④ 两类**不是风格问题**：它们不含 `selection.` 字面量，因此躲得过"只数字面量"的判据 ——
 *     那正是本文件长期违规却一直没变红的原因（同一批搬出去的另外两个渲染器早就在严口径下）。
 *   · **动作经具名处理器**：除写设置外还要做别的事（重建层 / 清失败记忆 / 重绘 / 刷库存…）
 *     一律收口成 `src/client.js` 里的 `on*` 处理器，经 ctx 传进来；页签只写 `onClick: onFoo`。
 *     于是"点了会发生什么"住在处理器里，页签只回答"画什么"。
 *   · 模块级依赖（React / SliderRow / switchRow / ctlText / FRAME_VARIANTS / 各类预设表 /
 *     纯函数如 `weT` / `adapterCaps` / `liveRenderEnabled`…）仍按内联规则直接读，不经过 ctx
 *     —— 它们是常量与纯组件/纯函数，与面板状态无关。**判据只盯状态与动作，不盯这些。**
 *   · 本文件必须保持浏览器安全（无 import / require / Node API），且**不得有顶层可执行语句**
 *     读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）。
 *
 * 把五个域的**节渲染器**按域搬进同族兄弟模块（构建期内联在本文件之前，
 * 见 scripts/build-client.mjs 的 INLINE_MODULES）：src/panel-tabs-wallpaper.js /
 * -appearance.js / -mascot.js / -effects.js / -advanced.js。本文件只留八个 render*Tab
 * （守卫与 src/client.js 的调用点都按名字取它们，导出名必须在**本文件**里有绑定）与
 * extensionModules()。搬出的 render*Section / renderMascotFormCards / renderFont* 等
 * 仍是同一工厂作用域的自由名字（打包后同作用域；按文件 import 的台架按既有口径挂全局）。
 * **接缝四类越界的判据扫的是全族并集**（test/verify-client.mjs 的 RENDERERS 表 +
 * test/tools/src-scope.mjs 的 panelText()），搬出去不等于搬出判据。
 */

/**
 * 可见面判据的**本地包装**（同 `avatar-layer.js` 的口径）：本文件可被**独立求值**
 * （判据逐页签抽函数真跑），因此不裸引用拼接作用域里的 `weComponentVisible`，改读
 * `globalThis.__weComponentVisible`（`src/client.js` 启动时注入）；缺省 `true` = 不渲染（D3① 安全方向）。
 */
function weComponentVisibleOf(components, name) {
  const f = globalThis.__weComponentVisible;
  // 缺省 **true**（未知 ⇒ 按可用渲染）：注入缺失只可能是接线疏漏或独立求值上下文，
  // 那种情况下"把整个面板藏掉"是更坏的失败；生产侧 src/client.js 启动时必定注入。
  return typeof f === 'function' ? f(components, name) : true;
}

  // 这一层只**按顺序组装**各节（"有哪几节、什么顺序"一眼可读；
  // 判据按真渲染的节序列钉住，见 verify-scene-live 的节顺序一节）。
  // 首行空解构是**契约**（test/verify-scene-live.mjs 的『每个页签首行都从 ctx 解构』）：
  // 本页签只把 ctx **转交**给各节、自己不读字段 —— 所以那不是无操作声明，是"要什么写在签名处"。
  function renderWallpaperTab(ctx) {
    const { } = ctx;
    return React.createElement(React.Fragment, null,
      renderWallpaperCurrentSection(ctx),
      renderWallpaperTransitionSection(ctx),
      renderWallpaperRotationSection(ctx),
      renderWallpaperUploadsSection(ctx),
    );
  }


  // 这一层只**按顺序组装**各节（"有哪几节、什么顺序"一眼可读；
  // 判据按真渲染的节序列钉住，见 verify-scene-live 的节顺序一节）。
  // ⚠️ 这个顺序是**两个界面共用的**（侧边栏的 `qpRenderAppearancePane` 调的也是本函数）
  //    ⇒ 改这里等于同时改设置页与侧边栏 —— 这正是用户口径要的"两边同序"。
  // 用户口径：主题 → 细节 → 玻璃 UI → 侧边栏圆角 → 全局 UI 配色 → 全局字体。
  // 与上一版的差别只有一处：**「玻璃 UI」与「侧边栏圆角」对调**（前者上移到细节之后）。
  // 首行的空解构是**契约**（test/verify-scene-live.mjs 的『每个页签首行都从 ctx 解构』）：
  // 本页签只把 ctx 转交给各节、自己不读字段 —— 所以那不是无操作声明。
  function renderAppearanceTab(ctx) {
    const { } = ctx;
    // 第六节「全局字体」在 P-C 之后**住在 packages/fonts**（子包把渲染器登记进
    // src/extension-registry.js 的面板节注册表）⇒ 这里按注册表续接，屏上位置仍**在最后**
    //（描述符不写 `order` ⇒ 落到默认位 100；顺序口径与 extensionModules() 同源）。
    // ⚠️ 注册表为空 = 该子包没装 / 被关：页签照画前五节，**不**整页签消失
    //    （D3①/D3③ 在这条通道上的形态：缺的是那一节，不是这一页）。
    const registered = wePanelSectionsOf("appearance").map((section) => (
      React.createElement(React.Fragment, { key: section.id }, section.render(ctx))
    ));
    return React.createElement(React.Fragment, null,
      renderAppearanceThemeSection(ctx),
      renderAppearanceDetailSection(ctx),
      renderAppearanceGlassSection(ctx),
      renderAppearanceSidebarCornersSection(ctx),
      // 「全局 UI 配色」在「全局字体」**上面**（用户口径：「变成全局UI配色放在全局字体上面」）；
      // 原「输入光标」节已撤销，其唯一一行（光标颜色）并入本节（见该渲染器的 ③）。
      renderAppearanceUiColorSection(ctx),
      registered,
    );
  }


  // 模块级 ↺ 的**薄包装**（issue #192）：真实现住在 `src/module-reset.js`（panel-tabs 与
  // glass-panel 共用，抽出来才能让挂载台 import 真实现）。这里只把"取词 + 处理器"两样外界
  // 喂给它 —— 中文因此留在本文件的 `weT(...)` 里（i18n 扫描器认这个形态；写进被调模块会
  // 被判成"裸中文"），各节调用点则保持 `moduleResetButton("模块名", onResetModule)` 这么短。
  // ⚠️ 必须是**本文件的模块级（工厂作用域）声明**，不能留在 `renderAppearanceTab` 体内：
  //    五个域模块（src/panel-tabs-*.js）按域搬出后仍按这个名字引用它 —— 打包后同一工厂
  //    作用域没问题，但按文件 import 的守卫台架（verify-fontset / verify-scene-live 的
  //    侧栏档）只有把真实现挂到全局才找得到。
  function moduleResetButton(moduleName, onResetModule) {
    return moduleResetButtonNode(moduleName, onResetModule, {
      title: weT("把这一块的参数恢复为默认值（不需要确认）"),
      aria: weT("重置本模块"),
    });
  }

  function renderAudioTab(ctx) {
    const { onToggleAudio, onVideoVolume, sel } = ctx;
    // 声音：壁纸音轨（视频 / 场景内嵌 MP4 / 场景包内音频共用一套设置）。
    // 系统音频反应 / 媒体信息 / 在线歌词三键**恒为常开**（schema kind 'const'）：
    // 面板不提供页面定义，运行时两侧一律按默认接入读值。
    return React.createElement(React.Fragment, null,
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, weT("声音")),
        ),
        SliderRow(weT("音量"), 0, 100, 5,
          Math.round((Number(sel.videoVolume) || 0) * 100), onVideoVolume,
          Math.round((Number(sel.videoVolume) || 0) * 100) + "%"),
        switchRow(weT("壁纸音轨"), sel.videoAudioEnabled !== false, () => onToggleAudio(), {
          hint: weT("关闭=静音（保留音量数值）· 开启时音量 0 自动 50%"),
          tooltip: weT("视频壁纸与场景壁纸（内嵌 MP4 音轨 / 包内独立音频）共用；默认静音，开启时若音量为 0 会自动提到 50%"),
        }),
      ),
    );
  }


  function renderMascotTab(ctx) {
    const { onRopeScaleChange, onRopeVisibilityChange, onMascotFormConfirm, onDisarmConfirm, sel, paneWidth } = ctx;
    // ── D3 可见面 gate（ADR-0013 D3①/D3③）：该组件行关掉 ⇒ **整块不渲染**（返回 null，
    // 界面不显示；配置项由调用方按同一判据隐藏）。判据：test/verify-component-visibility.mjs
    // 的"声明落点必须被 gate"双向对账。唯一实现在 src/client.js 的 weComponentVisible。
    if (!weComponentVisibleOf(ctx.sel && ctx.sel.inventory && ctx.sel.inventory.components, 'mascot-avatar')) return null;
    // 主页面那只吉祥物**当前用的立绘**（自定义优先 / 否则内置形态）—— 与 RopeDock 共用
    // 同一条解析（`ropeArtOf`）：设置页看到的盒与主页面那只的盒必须是同一个数。
    const previewArt = ropeArtOf(sel);
    const customArt = previewArt.custom;
    // 自定义立绘卡片的舞台盒 = 内置卡里最高的那张（Deepseek_Pro 64×96）的盒 ——
    // "同样的卡片大小和样式"（用户口径）在这条链上就落到这两个数上。
    const boxW = 64, boxH = 96;
    // 卡面舞台：把当前立绘等比缩进 64×96（与最高的内置卡「Deepseek_Pro」同一个盒）——
    // 保持宽高比，直接夹住某一边会把长竖图压成方的，看到的就不是那只吉祥物的形状了。
    const previewFit = Math.min(1, boxW / previewArt.w, boxH / previewArt.h);
    // 没导入时占位就是整块舞台（虚线框 + 一个加号），导入后图片按自己的比例缩进它。
    const previewW = customArt ? Math.max(1, Math.round(previewArt.w * previewFit)) : boxW;
    const previewH = customArt ? Math.max(1, Math.round(previewArt.h * previewFit)) : boxH;
    return React.createElement(React.Fragment, null,
      // ── 吉祥物：形态卡片固定基础尺寸（「吉祥物大小」只作用于主页面），开关总控 ──
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, weT("聊天吉祥物")),
        ),
        switchRow(weT("显示吉祥物"), sel.ropeShown !== false, onRopeVisibilityChange, {
          key: "rope-shown",
          hint: weT("关闭后隐藏吉祥物与壁纸仓库抽屉"),
          tooltip: weT("关闭后隐藏吉祥物与壁纸仓库抽屉；可随时在本页重新开启"),
        }),
        // ── 自定义立绘（用户口径：可导入，已导入时下一次导入覆盖上一次）──────────
        // 它是**转盘（3D 环）上的最后一项**（用户口径：与内置立绘同样的卡片大小和样式）——
        // 点它导入 / 替换（再导入即覆盖），正在用时是 `--active` 那一项；内置项**不因**自定义
        // 生效而禁用（并入 #180 之后：点内置项 = 两步确认换回出厂自带，见
        // `onMascotFormConfirm`），只有导入进行中才禁用（`disabled: mascotBusy`）。
        // 卡面尺寸口径与内置项一致（固定，不随「吉祥物大小」缩放）：图片按自己的宽高比
        // contain 进 64×96 的小舞台（那是最高的内置项「Deepseek_Pro」的盒）。清除入口排在最后。
        renderMascotFormCards(sel, previewArt, previewW, previewH, onRopeFormChange, onMascotPick, onMascotClear, onMascotFormConfirm, onDisarmConfirm, paneWidth),
        sel.mascotError
          && React.createElement("div", { className: "we-picker__hint we-avatar-error", key: "rope-custom-err" }, sel.mascotError),
        SliderRow(weT("吉祥物大小"), ROPE_SCALE_MIN, ROPE_SCALE_MAX, ROPE_SCALE_STEP,
          sel.ropeScale, onRopeScaleChange, Math.round(sel.ropeScale * 100) + "%", "rope-scale"),
      ),
    );
  }


  // 这一层保留"空态提前返回 + 唯一的节外壳"，把**节里的内容**按块分给子渲染器；
  // "有哪几块、什么顺序"一眼可读（细锚按真渲染的**控件标签有序序列**钉住，见 verify-scene-live）。
  function renderEffectsTab(ctx) {
    const { sel, setPickerOpener, onOpenPicker, onPickWallpaper, surface } = ctx;
    const sidebarSurface = surface === "sidebar";
    if (!sel.id) {
      return React.createElement("div", { className: "we-picker__empty" },
        React.createElement("span", { className: "we-picker__empty-title" }, weT("还没有启用壁纸")),
        React.createElement("span", { className: "we-picker__hint" },
          weT("选择一款壁纸后，可在这里调整模糊、亮度、适配、倍速等效果")),
        React.createElement("button", {
          className: "we-picker__btn we-picker__btn--primary", type: "button",
          ref: sidebarSurface ? undefined : setPickerOpener,
          onClick: sidebarSurface ? onPickWallpaper : onOpenPicker,
        }, sidebarSurface ? weT("去挑一张 ›") : weT("选择壁纸")),
      );
    }
    return React.createElement(React.Fragment, null,
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, weT("画面")),
        ),
        renderEffectsSlidersSection(ctx),
        renderEffectsLiveSection(ctx),
        renderEffectsSourceSection(ctx),
        renderEffectsPlaybackSection(ctx),
        renderEffectsFitSection(ctx),
      ),
    );
  }

  // 这一层只**按顺序组装**各节 —— 于是"这个页签有哪几节、什么顺序"
  // 一眼可读（判据按真渲染的节序列钉住，见 verify-scene-live 的节顺序一节）。
  // 首行的空解构是**契约**（test/verify-scene-live.mjs 的『每个页签首行都从 ctx 解构』）：
  // 本页签只把 ctx 转交给各节、自己不读字段 —— 所以那不是无操作声明。
  function renderAdvancedTab(ctx) {
    const { } = ctx;
    return React.createElement(React.Fragment, null,
      renderAdvancedBrowsingSection(ctx),
      renderAdvancedCompatSection(ctx),
      renderAdvancedAdapterSection(ctx),
      renderAdvancedPowerSection(ctx),
      renderAdvancedCacheSection(ctx),
      renderAdvancedDiagSection(ctx),
    );
  }
  // ── 「扩展」页签：后续功能的**模块容器** ─────────────────────────────────────
  // 这一页刻意只放一张**注册表**：加一个功能 = 往 EXTENSION_MODULES 里加一项，页签本身
  // 不用改（"接下来的功能追加都以模块形式放在该 tab 下"是用户的明确口径，见 CHANGELOG）。
  // 注册表为空时页签照旧在、只画空态 —— 页签栏是稳定的，用户不会因为"现在还没有模块"
  // 就找不到这一页的入口。
  //
  // 每一项的**描述符住在它自己的 src/<语义名>.js 里**（渲染器不膨胀）。取用一律走下面这个
  // **惰性**函数：顶层直接写 `const EXTENSION_MODULES = [SYMBOL]` 会踩两个坑 ——
  //   ① 内联后 prelude 求值期就要读兄弟模块的常量，模块顺序成了隐式契约；
  //   ② test/verify-scene-live.mjs 是**单独 import 本文件**、再喂 `globalThis` 的，
  //      顶层一引用别处的符号就当场 ReferenceError。
  // 写成函数后两个坑都没了：求值发生在"画这一页"的时候，那时兄弟模块早就内联好了。
  //
  // 模块形状（给未来加功能的自己）：
  //   { id, title, desc?, render? }
  //   · `id`    React key，稳定且唯一；
  //   · `title` / `desc` 取到的就是**译文**（描述符里写成 getter，见下）。写法上有个硬约束：
  //     **不能直接写成 `title: "…"`** —— 那在 test/verify-i18n.mjs 的判据 ① 里是
  //     "没进 weT(...) 的裸中文"；也不能写成顶层 `title: weT("…")`，那会在内联后的
  //     prelude 求值期撞 TDZ。既有写法是**getter**：
  //       get title() { return weT("点击效果与拖尾效果"); }
  //     这样 `weT(...)` 就落在字面量的最内层调用帧上，且取译文发生在渲染时（照抄
  //     packages/fx/src/ext-fx.js 的 FX_EXTENSION_MODULE 即可）—— 因此**本文件不再套一层
  //     weT**（套了就成了拿译文再查一次词表）。
  //   · `render(ctx)` 可选：给了就在这个模块的位置画它自己的控件；没给就只显示
  //     title + desc —— "功能还没做完"的模块可以先上架占位。
  //   · 模块**不得**自己写设置 / 发通知 / 持有状态：本文件是渲染器（契约见文件头），
  //     要动状态就把动作做成 src/client.js 的具名处理器、经 ctx 传进来。
  // 现有三项 —— **本文件不再枚举它们**（P-A 起）：
  //   一号 = 自定义会话头像（src/ext-avatar.js + src/avatar-layer.js，会话界面上的 DOM 补丁），
  //          **留在主包**，由 src/client.js 在模块作用域自登记；
  //   二号 = 点击效果与拖尾效果（packages/fx）、三号 = 3D 效果（packages/parallax）**各自
  //          是一个独立包** —— 三份 bundle 的求值顺序不保证，同一个工厂作用域里再也放不下
  //          一份"按数组顺序排好的清单"，于是"谁登记了什么"落在一张共享注册表上
  //          （src/extension-registry.js；跨包通道见 BUNDLE-SPLIT §6.2）。
  // ⚠️ **顺序即屏上顺序**：跨包顺序**不能**靠数组序（bundle 求值顺序不是契约），改由描述符的
  //    `order` 声明（avatar=1 / fx=2 / parallax=3），排序 = (order, 注册序)。
  //    加第四项 = 在它自己的包里调 `weRegisterExtensionModule(id, descriptor)`，本文件零改动。
  // 注册表为空时页签照旧在、只画下面那个空态（形状见 :230-252 的注释）。
  function extensionModules() {
    return weExtensionModules();
  }

  // 这一页自己不读 ctx 的任何字段：整包（sel + 具名 on* 处理器）转交给各模块的 render。
  // ⚠️ 判据口径：`const { … } = ctx;` 必须是函数体的**第一条语句**（前面连注释行都不许有），
  // 所以说明文字只能写在函数外面 —— 见 test/verify-scene-live.mjs 的『每个页签首行都从 ctx 解构』。
  function renderExtensionsTab(ctx) {
    const { onResetModule } = ctx;
    // ── D3 可见面 gate（ADR-0013 D3①/D3③）：该组件行关掉 ⇒ **整块不渲染**（返回 null，
    // 界面不显示；配置项由调用方按同一判据隐藏）。判据：test/verify-component-visibility.mjs
    // 的"声明落点必须被 gate"双向对账。唯一实现在 src/client.js 的 weComponentVisible。
    if (!weComponentVisibleOf(ctx.sel && ctx.sel.inventory && ctx.sel.inventory.components, 'mascot-avatar')) return null;
    const modules = extensionModules();
    return React.createElement(React.Fragment, null,
      React.createElement("div", { className: "we-picker__section" },
        React.createElement("div", { className: "we-picker__section-head" },
          React.createElement("span", { className: "we-picker__section-label" }, weT("扩展模块")),
        ),
        React.createElement("div", { className: "we-ext" },
          modules.length === 0
            ? React.createElement("div", { className: "we-picker__empty" },
                React.createElement("span", { className: "we-picker__empty-title" },
                  weT("还没有可用的扩展模块")),
                React.createElement("span", { className: "we-picker__hint" },
                  weT("后续新增的功能会以模块形式收在这里，每个模块自带它的控件")),
              )
            : modules.map((mod) => React.createElement("div", {
                key: mod.id, className: "we-ext__module",
              },
                React.createElement("div", { className: "we-ext__module-head" },
                  React.createElement("span", { className: "we-ext__module-title" }, mod.title),
                  moduleResetButton(mod.resetGroup, onResetModule),
                ),
                mod.desc ? React.createElement("span", { className: "we-picker__hint" }, mod.desc) : null,
                mod.render ? mod.render(ctx) : null,
              )),
        ),
      ),
    );
  }

  // ── 「关于」页签：项目简介 / 仓库与 Star / 交流群二维码 / 贡献者致谢（压尾）──────
  // 内容全是静态文案 + 两张内联二维码（数据在 src/about-assets.js，构建期随 prelude
  // 内联）；**唯一的外部能力**是 `ctx.onReopenNotice`（「重新查看更新公告」按钮）。
  // 它不是"读面板状态"：状态写入与 emit 都发生在 client.js 那一侧（回调体内），本渲染器
  // 只读模块级真值 + 调一个交进来的回调 —— 这正是 test/verify-about.mjs 那条
  // "渲染器只读模块级状态（不自己发请求 / 不写设置 / 不发通知）"允许的形状。
  // 契约是**逐页签**的 —— verify-scene-live 要求每个 render*Tab 首行从 ctx 解构
  //（"要什么"写在签名处），所以这里显式解构出那一个回调。
  // 四段的**顺序**是用户的明确口径（致谢压尾），判据按首次出现下标比大小钉住。
function renderAboutTab(ctx) {
  // 组件可见性门：关掉 about-notice 组件行时，这一页签整块不渲染。
  if (!weComponentVisibleOf(ctx.sel && ctx.sel.inventory && ctx.sel.inventory.components, 'about-notice')) return null;
  // 纯静态文案：不发请求、不写设置、不读面板状态（verify-about 的只读契约）。
  const section = (title, body) => React.createElement("div", { className: "we-picker__section", key: title },
    React.createElement("div", { className: "we-picker__section-head" },
      React.createElement("span", { className: "we-picker__section-label" }, title),
    ),
    body,
  );
  const p = (text, key) => React.createElement("div", { className: "we-picker__hint", key }, text);
  const ul = (items) => React.createElement("ul", { className: "we-picker__hint", style: { margin: "4px 0 0 18px", padding: 0 } },
    items.map((text, i) => React.createElement("li", { key: i, style: { margin: "2px 0" } }, text)));
  const link = (href, text) => React.createElement("a", {
    href, target: "_blank", rel: "noreferrer",
    style: { color: "inherit", textDecoration: "underline" },
  }, text);
  return React.createElement("div", null,
    React.createElement("div", { style: { fontSize: "16px", fontWeight: 600, marginBottom: "2px" } }, "dshAI · 桌面增强插件"),
    p("给 DeepSeek Harness 的桌面增强插件，不是另一个 AI。它把「桌宠 + 语音 + 壁纸引擎 + 人设 + 能力市场」接到 DSH 上：点一下桌宠就能说话，回答变成气泡字幕并朗读；设置页还能管理壁纸、外观、声音与能力。项目由社区维护，不替代 DSH，也不修改宿主代码。"),
    section("🎙 语音与陪伴", ul([
      "常驻聆听：装好就在听，不用先点桌宠；说完自动断句",
      "开口打断：朗读中你一说话，它先停下听你说",
      "暂停说话：只出字幕不出声，继续听；暂停聆听：临时关麦",
      "本地识别：SenseVoice 本地转写，音频不出本机",
      "音色：Edge 在线 / Piper、SAPI 离线 / 火山引擎（自填 Key）；试听即所选，不会偷偷换成别的音色",
      "按谱清唱：生成歌词 + 旋律（公共领域曲调 + 原创），逐行歌词，是「唱」不是「念」；明确无伴奏",
      "人设：助手 / 特殊人设（角色卡 CCv2、PNG 导入），各自 Key、独立长期记忆、成长自动采纳；特殊人设禁用系统工具",
    ])),
    section("🖼 壁纸与桌面", ul([
      "本机 Wallpaper Engine 场景/网页实时渲染",
      "视频、网页壁纸、开机动画、皮肤",
      "壁纸库 / 自动轮播 / 本地上传（拖拽即可）/ 壁纸音轨与音量",
      "桌宠显隐、大小、音量；媒体控制；提醒与系统通知",
    ])),
    section("🧰 能力与精选", React.createElement("div", null,
      p("能力页分三片：精选 / 工作能力 / 娱乐。精选是把常用场景打包好的 20 套组合，每套都给出插件链、前置条件、风险与预算标签、已装检测、复制全部命令、导出脚本与收藏。"),
      p("覆盖场景：办公文档 · 数据分析 · 学术研究 · 会议沟通 · 运营报表 · 编程开发 · 游戏开发 · 自动化 RPA · 多 Agent 协作 · 远程办公 · 设计视觉 · 视频剪辑 · 内容创作 · 3D 与工程 · 情绪陪伴 · 学习成长 · 安全治理 · 模型与订阅。"),
      ul([
        "查时间 / 计算 / 单位换算 / 翻译 / 总结",
        "写文案 / 方案 / 代码 / 诗 / 故事 / 笑话；做计划 / 讲概念 / 角色扮演 / 清唱",
        "换壁纸 / 调音量 / 媒体控制 / 提醒 / 通知 / 开应用或网页 / 读写工作区文档 / 剪贴板",
        "多步任务：先计划再逐步执行，高危步骤二次确认",
        "已安装插件与技能：读取技能说明并由模型执行；逐能力开关、权限组默认询问、调用写审计",
        "权限：标准 / 宽松 / 自定义三档；allow / ask / deny；写文件、剪贴板、删除等高危动作永远二次确认",
      ]),
    )),
    section("🔒 安全与隐私", ul([
      "数据只存本机 ~/.dsh-folia，不上传聊天与壁纸",
      "只有主动使用在线语音、联网搜索或在线模型时才联网；本地识别与本地合成不发出音频",
      "第三方 MCP / 插件默认标风险，建议先跑 trust-check",
      "不修改宿主代码，不替代 DSH",
    ])),
    section("🙏 技术与开源致谢", p("感谢 DeepSeek Harness / Cordis 提供插件宿主、ctx 服务与权限模型；感谢 Electron、Chromium、Node.js、FFmpeg、SenseVoice、Edge TTS、Piper、Sherpa-onnx、WebWallGL 等开源项目；感谢上游 Wallpaper Engine 面板、所有贡献者、Issue 作者、翻译与测试用户。")),
    section("© 版权说明", p("内置曲调只使用公共领域作品（小星星 / 两只老虎 / 生日快乐 / 铃儿响叮当 / 欢乐颂 / 茉莉花）与原创旋律，不包含受版权保护的流行歌曲；如发现侵权内容会第一时间核实并下架/替换。")),
    section("📮 联系与反馈", p("问题 / 侵权 / 建议：请到 GitHub 仓库提 Issue（标题注明「问题 / 侵权 / 建议」，附版本号、系统、复现步骤或截图）。"),
      React.createElement("div", { style: { marginTop: "4px" } }, link(ABOUT_REPO_URL + "/issues", "GitHub Issues · " + ABOUT_REPO_URL + "/issues"))),
  );
}
  // ── 页签级重置（issue #192 用户口径：「每个选项卡后面加重置，重置指定选项卡」）──────────
  // 压在**每个页签内容的最末尾**，由 client.js 的渲染点在 renderActiveTab() 之后统一挂 ——
  // 六处渲染器各挂一遍必然漏一个，挂一处才是结构性的。
  // 走两步确认：整页设置量不小（外观页就有 60 个键）且不可撤销 ⇒ 与模块级 ↺ 分档
  //（那是单模块、用户口径明确"无需确认"）。令牌按页签区分，因为 `armedConfirm` 是单值。
  function renderTabReset(ctx, tabId) {
    const { armedConfirm, onArmConfirm, onDisarmConfirm, onResetTab } = ctx;
    // 「关于」页签没有任何设置（纯静态文案）⇒ 不给它画一个点了没反应的按钮。
    if (tabId === "about") return null;
    const token = "tab:" + tabId;
    // ⚠️ 刻意**不用** `we-picker__section-label`：那是"设置分组卡"的类名，而本节的判据口径
    //（既有守卫按"末三张分组卡"取窗口）会被这一节顶掉 —— 3D 效果那一页就有三张分组卡，
    // 重置节排在它后面会挤走「背景」。它是**操作区**不是分组卡，用独立类名在语义上也更准。
    const cls = "we-picker__section-reset-label";
    return React.createElement("div", { className: "we-picker__section" },
      React.createElement("div", { className: "we-picker__section-head" },
        React.createElement("span", { className: cls }, weT("重置本页")),
      ),
      React.createElement("span", { className: "we-picker__hint" },
        weT("把这一页的设置恢复为默认值；其他页签与导入的图片不受影响。")),
      React.createElement("div", { className: "we-picker__row" },
        React.createElement("button", {
          className: "we-picker__btn",
          type: "button",
          disabled: armedConfirm === token,
          onClick: () => onArmConfirm(token),
        }, weT("重置本页")),
      ),
      renderConfirmRow(armedConfirm, token,
        weT("确定要把这一页的设置恢复为默认吗？此操作不可撤销。"),
        () => onResetTab(tabId), onDisarmConfirm),
    );
  }

  // ── 全局重置节（issue #192，压在「系统」页签末尾）──────────────────────────────
  // 三档里的最高一档：**模块 < 页签 < 全局**。全局必须二次确认（不可撤销）。
  // 二次确认复用 client.js 既有的 `armConfirm` / `renderConfirmRow` 两步构件 ——
  // `selection.armedConfirm` 是单值 ⇒ 结构上同一时刻只有一个动作待确认。
  // ⚠️ 只重置**设置值**：导入的头像图 / 吉祥物立绘 / 字体集住各自的目录，删不删是另一件事
  //（文案必须把这一点说清，否则用户会以为"重置"连图一起删了）。
  function renderResetSection(ctx) {
    const { armedConfirm, onArmConfirm, onDisarmConfirm, onResetAll } = ctx;
    const token = "resetAll";
    return React.createElement("div", { className: "we-picker__section" },
      React.createElement("div", { className: "we-picker__section-head" },
        // 同 renderTabReset：操作区不用「设置分组卡」那个类名（它会被"末三张分组卡"那类
        // 位置口径的判据看见，挤掉真正的分组卡）。
        React.createElement("span", { className: "we-picker__section-reset-label" }, weT("重置")),
      ),
      React.createElement("span", { className: "we-picker__hint" },
        weT("把全部设置恢复为出厂默认值；导入的头像与吉祥物图片、字体集不受影响。此操作不可撤销。")),
      React.createElement("div", { className: "we-picker__row" },
        React.createElement("button", {
          className: "we-picker__btn we-picker__btn--danger",
          type: "button",
          disabled: armedConfirm === token,
          onClick: () => onArmConfirm(token),
        }, weT("全部重置")),
      ),
      renderConfirmRow(armedConfirm, token,
        weT("确定要将所有设置恢复为默认吗？此操作不可撤销。"),
        onResetAll, onDisarmConfirm),
    );
  }

export {
  renderWallpaperTab, renderAppearanceTab, renderAudioTab, renderMascotTab, renderEffectsTab, renderAdvancedTab,
  renderExtensionsTab, renderAboutTab, renderResetSection, renderTabReset,
  // 模块级 ↺ 的薄包装：域模块（-appearance / -effects / -mascot）的节头按工厂作用域自由名字引用它
  // （打包后同作用域）。导出它只为让**按文件 import 的守卫台架**能挂上真实现，
  // 不是新公共 API；bundle 侧无消费者（内联后同作用域）。
  moduleResetButton,
};
