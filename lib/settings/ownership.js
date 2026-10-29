/**
 * lib/settings/ownership.js — **设置键归属清单**（每个键属于哪个功能）。
 *
 * 为什么要有它：`lib/settings-schema.js` 有 138 个 DEFAULTS 键 / 134 个 KINDS 键，过去"这个键
 * 属于哪个功能"只存在于人脑里。后果是真实出现过的：加一个功能要往那张 2000 行的表里挑地方插，
 * 而删一个功能时没人敢删键（不知道还有谁在用）。
 *
 * 这张表把归属写成数据，由 `test/verify-settings-ownership.mjs` 机器校验三条：
 *   ① 每个键**恰好**有一个归属（没归属 = 有人偷偷加键；两个归属 = 归属不清）；
 *   ② 每条模式都要**真的匹配到东西**（写错了 / 功能删了留着的模式会被判红）；
 *   ③ 五个功能（wallpaper / playback / appearance / components / system）都非空 ——
 *      防止有人把整表塞进一个兜底桶。
 *
 * 为什么现在只写数据、不拆文件：拆 `settings-schema.js` 要动 DEFAULTS / KINDS / 一堆
 * 引用这些常量的消毒器，属于高风险改动；先把**归属**固定住，拆分才有对账依据。
 * 拆分时的目标形态已经写在这里：每个 `files` 条目将来对应 `lib/settings/<id>.js`。
 */

/** @typedef {{ id: string, name: string, why: string, files?: string[], keys?: string[], prefixes?: string[] }} FeatureKeys */

/** @type {FeatureKeys[]} */
export const SETTINGS_OWNERS = [
  {
    id: 'wallpaper',
    name: '壁纸',
    why: '壁纸本体的显示参数：着色/裁切/图层几何/场景帧/评分与来源筛选/自定义属性。',
    files: ['lib/routes/inventory.js', 'src/quick-panel.js', 'src/picker-model.js'],
    keys: [
      'scrim', 'border', 'blur', 'wallpaperBlur', 'wallpaperOpacity', 'objectFit', 'flip',
      'backgroundBrightness', 'backgroundContrast', 'backgroundSaturate',
      'layerPositionX', 'layerPositionY', 'layerScale',
      'hiddenIds', 'contentRatingFilter', 'typeFilter', 'sourceFilter', 'pickerLayout',
      'sceneFrameUrl', 'sceneLive', 'sceneLiveFps', 'sceneLiveFailures',
      'customFrames', 'frameVariants', 'userProps', 'edgeCompat',
    ],
  },
  {
    id: 'playback',
    name: '播放',
    why: '播放与轮换的时序：轮换间隔/过场、倍速、帧率上限、声音、暂停策略。',
    files: ['src/client-rotation.js', 'src/client-audio-playback.js', 'src/panel-tabs-advanced.js'],
    keys: [
      'rotationEnabled', 'rotationInterval', 'rotationGroupId', 'rotationGroups', 'rotationSeeded',
      'switchTransition', 'switchTransitionDir', 'switchTransitionSpeed',
      'playbackRate', 'fpsCap', 'videoVolume', 'videoAudioEnabled',
      'pauseOnHidden', 'pauseOnBlur', 'pauseOnBattery', 'liveBootDelay',
    ],
  },
  {
    id: 'appearance',
    name: '外观',
    why: '玻璃 / 主题 / 字体 / 配色 / 胶囊与侧栏装饰：改的是界面自身的观感。',
    files: ['src/glass.js', 'src/glass-panel.js', 'src/theme-follow.js', 'src/system-fonts.js'],
    prefixes: ['glass', 'sidebar', 'titlebar', 'capsule', 'leftSidebar', 'rightSidebar', 'uiColor', 'theme', 'font', 'accent', 'chatGlass', 'extraGlass', 'rope', 'caretColor', 'globalFamily', 'componentFonts', 'noticeSeen'],
  },
  {
    id: 'components',
    name: '可选组件（fx / parallax / 头像 / 立绘）',
    why: '七个组件行各自的外观参数：点击拖尾、3D 视差、自定义头像与立绘。',
    files: ['lib/components/fx/index.js', 'lib/components/parallax/index.js', 'lib/components/mascot-avatar/index.js'],
    prefixes: ['fx', 'parallax', 'avatar', 'mascotImage'],
  },
  {
    id: 'system',
    name: '系统',
    why: '不属于任何单一功能的全局项：设置表版本、皮肤互操作标记、媒体适配目标。',
    files: ['lib/kernel/config.js', 'lib/kernel/host-kernel.js'],
    keys: [
      'settingsVersion', 'skinYieldRestoreId', 'skinYieldRestoreRotation',
      'adapterTarget', 'mediaIntegration', 'audioSource', 'mediaLyricsOnline',
      'thinkingGlass', 'thinkingNative',
      // `id` 不是"设置"而是设置记录的标识字段（DEFAULTS 里与真实设置同形存在）。
      'id',
    ],
  },
];

/**
 * 「兜底键」的显式豁免：没有任何模式匹配、且确实只给系统用的少数键。
 *
 * ⚠️ 这张表是**棘轮**：只许缩小。往这里加一条 = 又有一个键没人负责。
 */
export const UNOWNED_WHY = {
  // 目前为空：所有键都能被上面的模式覆盖。
};
