/**
 * lib/features.js — **功能清单**（单一真源）。
 *
 * 为什么需要这张表：这个插件已经长到 19 个宿主路由文件 + 70 个客户端文件 + 24k 行，
 * 而"某个功能到底由哪些文件负责"过去只存在于人脑里。后果是真实的：
 *   · 加一个功能要同时改 client.js / quick-panel.js / settings-schema.js / build-client.mjs
 *     / lib/index.js 五处接线，漏一处就"功能看着在、点开是空的"；
 *   · 有的功能（如站点缩略图）横跨 host + client，谁都能往里塞逻辑，边界逐渐糊掉。
 *
 * 这张表把"归属"写成数据，并由 test/verify-features.mjs 机器校验：
 *   ① 表里每个文件都必须真实存在；
 *   ② `lib/routes/*.js` 里的**每一个文件都必须被且仅被一个功能认领**（不许有孤儿路由）；
 *   ③ 每个 `tab` 必须真的出现在客户端 QP_TABS 里（不许有幽灵页签）；
 *   ④ 用到的站点分类必须在这里登记（站点是数据源，分类就是功能的入口）。
 *
 * 这张表**不改变运行行为**（运行时仍按各文件自己的注册方式装配），它的价值是：
 * 让"模块化"变成可失败的判据，而不是口头承诺。下次要加功能，先在这里登记，再动手。
 */

/**
 * @typedef {object} Feature
 * @property {string} id            功能 id（与 tab / 站点分类对齐）
 * @property {string} name          中文名（界面与文档用）
 * @property {string} role          这一层负责什么（一句话）
 * @property {string[]} host        宿主侧文件（相对仓库根）
 * @property {string[]} client      浏览器侧文件（相对仓库根）
 * @property {string[]} [tab]       客户端页签 id（没有页签的写 null）
 * @property {string[]} [site]      使用的站点分类 slug（站点数据源入口）
 * @property {string[]} [settings]  拥有的设置键前缀（可空）
 */

/** @type {Feature[]} */
export const FEATURES = [
  {
    id: 'wallpaper',
    name: '壁纸',
    role: '本机/上传/站点三源合并成壁纸库；着色、图层、播放与轮换由客户端接管',
    host: [
      'lib/routes/inventory.js',
      'lib/routes/site-media.js',
      'lib/routes/downloads.js',
      'lib/download-queue.js',
      'lib/routes/media-bytes.js',
      'lib/routes/media-derived.js',
      'lib/routes/scene-frame.js',
      'lib/routes/scene-media.js',
      'lib/routes/scene-serve.js',
      'lib/routes/live-frame.js',
      'lib/routes/occlusion.js',
      'lib/routes/props.js',
      'lib/routes/we-assets.js',
      'lib/routes/upload.js',
      'lib/inventory.js',
      'lib/wallpaper-scan.js',
      'lib/upload-store.js',
      'lib/scene-manifest.js',
      'lib/faststart.js',
      'lib/mp4-vfs.js',
      'lib/media/frame-store.js',
      'lib/media/transcode.js',
      'lib/media/video-preview.js',
      'lib/media/image-preview.js',
      'lib/media/scene-probe.js',
      'lib/media/mp4-probe.js',
      'lib/media/media-dirs.js',
    ],
    client: [
      'src/quick-panel.js',
      'src/picker-modal.js',
      'src/picker-model.js',
      'src/picker-props-panel.js',
      'src/panel-tabs-wallpaper.js',
      'src/video-layer.js',
      'src/layer-core.js',
      'src/live-layer.js',
      'src/live-layer-watch.js',
      'src/live-layer-gate.js',
      'src/live-layer-pointer.js',
      'src/live-layer-underlay.js',
      'src/live-layer-diag.js',
      'src/media-prep.js',
      'src/client-media-frame.js',
      'src/client-rotation.js',
      'src/client-audio-playback.js',
      'src/occlusion.js',
    ],
    tab: ['wallpaper'],
    site: ['wallpaper'],
  },
  {
    id: 'site',
    name: '站点数据源',
    role: '把站点当唯一数据源：清单拉取、分类过滤、缩略图代理、模块索引',
    host: [
      'lib/routes/site-thumb.js',
      'lib/routes/modules.js',
    ],
    client: [],
    tab: [],
    site: ['wallpaper', 'boot-animation', 'desktop-pet', 'assistant-skin'],
  },
  {
    id: 'boot',
    name: '开机动画',
    role: '站点候选 → 并行下载 → 本地目录 → 启动注入播放（脚本在宿主侧注入，不依赖应用挂载）',
    host: [
      'lib/routes/boot.js',
      'lib/boot/index.js',
    ],
    client: ['src/panel-tabs-boot.js'],
    tab: ['boot'],
    site: ['boot-animation'],
    settings: ['boot'],
  },
  {
    id: 'pets',
    name: '桌宠',
    role: '自渲染：站点/本机宠物 → 安装解包 → canvas 逐帧绘 sprite2d + 动作状态机 + 语音',
    host: ['lib/routes/pets.js'],
    client: ['src/panel-tabs-pets.js', 'src/pet-layer.js'],
    tab: ['pets'],
    site: ['desktop-pet'],
    settings: ['pet'],
  },
  {
    id: 'appearance',
    name: '外观',
    role: '玻璃、主题、字体、预设、页签样式 —— 纯客户端表现层',
    host: [
      'lib/routes/settings.js',
      'lib/routes/presets.js',
      // 助手皮肤：站点皮肤包 → $DSH_HOME/skins（皮肤中心读同一目录，写盘即生效）。
      'lib/routes/skins.js',
      'lib/settings-schema.js',
      'lib/components/fonts/routes/fontsets.js',
      'lib/components/fonts/routes/system-fonts.js',
    ],
    client: [
      'src/panel-tabs-appearance.js',
      'src/panel-tabs-skins.js',
      'src/glass.js',
      'src/glass-panel.js',
      'src/glass-surfaces.js',
      'src/glass-extra.js',
      'src/theme-follow.js',
      'src/system-fonts.js',
      'src/fontset-store.js',
      'src/preset-store.js',
      'src/styles-base.js',
      'src/styles-chrome.js',
      'src/styles-ext.js',
      'src/styles-panel.js',
      'src/styles-quick.js',
      'src/styles-settings.js',
      'src/styles-shell.js',
      'src/styles-sidebar.js',
      'src/about-assets.js',
      'src/nav-icon.js',
    ],
    tab: ['appearance', 'skins'],
  },
  {
    id: 'playback',
    name: '播放',
    role: '音量、静音、轮换节奏与播放控制（壁纸的播放面，独立页签）',
    host: [],
    client: [
      'src/panel-tabs-advanced.js',
      'src/effects.js',
      'src/adapter.js',
    ],
    tab: ['playback'],
  },
  {
    id: 'components',
    name: '可选组件行',
    role: '上游形态保留的 7 个组件行（fx/parallax/fonts/mascot-avatar/media-bridge/pet-link/about-notice），各自独立装载',
    host: [
      'lib/components/fx/index.js',
      'lib/components/parallax/index.js',
      'lib/components/fonts/index.js',
      'lib/components/mascot-avatar/index.js',
      'lib/components/media-bridge/index.js',
      'lib/components/pet-link/index.js',
      'lib/components/about-notice/index.js',
    ],
    client: [],
    tab: [],
  },
  {
    id: 'system',
    name: '系统',
    role: '诊断、缓存目录、设置存储、客户端装配骨架（不属于任何单个功能）',
    host: [
      'lib/routes/diag.js',
      'lib/routes/cache-dir.js',
      'lib/index.js',
      'lib/kernel/host-kernel.js',
      'lib/kernel/host-session.js',
      'lib/kernel/config.js',
      'lib/kernel/data-dir.js',
      'lib/diag-trace.js',
      'lib/cache-dir.js',
      'lib/serve.js',
      'lib/http-body.js',
      'lib/http-lifecycle.js',
      'lib/json-response.js',
      'lib/pkg-read.js',
      'lib/log.js',
      'lib/notice.js',
      'lib/host-boot.js',
      'lib/subpackage-boot.js',
      'lib/startup-sweep.js',
      'lib/fs-paths.js',
      'lib/upload-dir.js',
      'lib/steam-discovery.js',
      'lib/shim-seed.js',
      'lib/we-props.js',
      'lib/we-focus-guard.js',
      'lib/media-origin.js',
      'lib/types/index.d.ts',
      'lib/types/client.d.ts',
    ],
    client: [
      'src/client.js',
      'src/api-client.js',
      'src/persistence.js',
      'src/extension-registry.js',
      'src/i18n.js',
      'src/i18n-copy.js',
      'src/i18n-copy-core.js',
      'src/i18n-copy-ext.js',
      'src/i18n-copy-font.js',
      'src/i18n-copy-glass.js',
      'src/i18n-copy-live.js',
      'src/i18n-copy-panel.js',
      'src/i18n-copy-pet-link.js',
      'src/i18n-copy-picker.js',
      'src/we-base.js',
      'src/we-cond.js',
      'src/module-reset.js',
      'src/focus-handback.js',
      'src/sidebar-right.js',
      'src/section-head.js',
      'src/avatar-import.js',
      'src/avatar-layer.js',
      'src/ext-avatar.js',
      'src/panel-tabs.js',
      'src/panel-tabs-effects.js',
      'src/panel-tabs-mascot.js',
    ],
    tab: [],
  },
];

/** 页签 id → 功能 id（供校验与文档使用）。 */
export const TAB_OWNERS = FEATURES.reduce((acc, f) => {
  for (const t of f.tab || []) acc[t] = f.id;
  return acc;
}, {});

/** 站点分类 slug → 功能 id。 */
export const SITE_OWNERS = FEATURES.reduce((acc, f) => {
  for (const s of f.site || []) acc[s] = f.id;
  return acc;
}, {});
