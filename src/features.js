/**
 * features.js（客户端）— **功能注册表**：页签声明、面板工厂、挂载钩子。
 *
 * 为什么需要它：加一个功能过去要改五处共享文件（client.js 挂载 / quick-panel 的 QP_TABS 与
 * 渲染点 / settings-schema / build-client 的内联表 / lib/index.js 的路由注册）。前两处是纯
 * "接线"，写错了症状是「页签在、点开空白」或「渲染层根本没挂」。把这些收成一份声明后：
 *
 *   · 页签条 = WE_FEATURE_TABS（顺序就是用户看到的顺序）
 *   · 整区面板 = WE_FEATURE_PANELS（哪些页签整区交给功能自己的面板）
 *   · 常驻层   = WE_FEATURE_MOUNTS（随插件生命周期挂载/卸载的浮动层，例如桌宠）
 *
 * 谁也别再往 quick-panel 里写 `qpTab === "xxx"` —— 那是把功能名焊死进装配点。
 * 判据：test/verify-features.mjs 会检查 quick-panel 里不再出现具体功能分支。
 *
 * ⚠️ 内联顺序：本文件必须排在**它引用的所有符号之后**（panel-tabs-boot / panel-tabs-pets /
 * pet-layer），且排在 quick-panel.js 与 client.js **之前** —— 那两处在模块顶层读本表。
 */

/** 页签条（顺序 = 界面顺序）。label 用 getter：语言切换后能立刻生效。 */
const WE_FEATURE_TABS = [
  // 开机动画与壁纸并列：它们回答的是同一个问题"开机/桌面看到什么"，不是壁纸的子功能。
  { id: "boot", get label() { return weT("开机动画"); } },
  { id: "wallpaper", get label() { return weT("壁纸"); } },
  { id: "appearance", get label() { return weT("外观"); } },
  { id: "playback", get label() { return weT("播放"); } },
  // 桌宠是"桌面上多出来的一只东西"，与壁纸/开机动画并列。
  { id: "pets", get label() { return weT("桌宠"); } },
  // 助手皮肤：装的是皮肤中心的皮肤包。我们只管装/卸，渲染与启用归皮肤中心。
  { id: "skins", get label() { return weT("助手皮肤"); } },
];

/**
 * 整区面板：这个页签的内容**整个**由功能自己的组件渲染（而不是 quick-panel 内的通用列表）。
 * 没登记的页签走 quick-panel 自己的通用布局（壁纸列表 / 外观节 / 播放节）。
 */
const WE_FEATURE_PANELS = {
  boot: BootTabPanel,
  pets: PetsTabPanel,
  skins: SkinsTabPanel,
};

/**
 * 常驻层：插件挂载时启动、卸载时归还。每个都必须返回 cleanup（或 undefined）。
 * 它们自己决定"要不要显示"（例如桌宠要读配置才知道是否启用），装配点不参与判断。
 */
const WE_FEATURE_MOUNTS = [
  { id: "pets", mount: mountPetLayer },
  // 皮肤兼容层：补写 `data-pane` / `data-dsh-frame`（皮肤包写的是 web-all 的 compat 词表）。
  // 它只写自己的惰性属性、幂等、可失败，所以随墙纸引擎常驻，不依赖皮肤是否在台上。
  { id: "skin-compat", mount: installSkinCompat },
];

/** 页签 → 功能归属（宿主清单 lib/features.js 的客户端镜像，供守卫对账）。 */
const WE_FEATURE_TAB_IDS = WE_FEATURE_TABS.map((t) => t.id);

/**
 * 页签底部那枚「去设置里改」的引导条。
 *
 * 为什么要收进注册表：它原本是 quick-panel 里的一条 `qpTab === "boot"` 分支 —— 属于
 * 「功能名焊死进装配点」。功能自己声明自己的引导语，装配点只查表。
 * 没声明的页签走 quick-panel 的通用文案（壁纸 / 外观 / 播放那三档是泛型布局，留在原地）。
 */
const WE_FEATURE_FOOTERS = {
  boot: {
    get label() { return weT("打开设置 ›"); },
    target: "",
    get title() { return weT("开机动画的全部参数都在侧栏「壁纸引擎」设置里"); },
  },
  pets: {
    get label() { return weT("打开设置 ›"); },
    target: "",
    get title() { return weT("桌宠的开关 / 大小 / 声音都在「桌宠」页签里调整"); },
  },
};
