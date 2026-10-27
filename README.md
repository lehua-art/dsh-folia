# dsh-folia

DSH Desktop 的壁纸插件。基于 [dsh-plugin-wallpaper-engine](https://www.npmjs.com/package/dsh-plugin-wallpaper-engine)（MIT，© 2026 elysia395）二次开发，**保留其全部功能**，并增加一个自建站点数据源。

## 与上游的差异

**全仓库只有一处功能改动**，位于 `lib/routes/inventory.js`：

```js
const payload = await buildInventory();
const remote = await foliaRemote();          // 拉站点 manifest
const merged = remote.length
  ? { ...payload, wallpapers: [...(payload.wallpapers || []), ...remote] }
  : payload;
```

`foliaRemote()` 负责把站点上的视频壁纸转成插件认识的条目形状，并带 60 秒缓存。站点不可达时返回空数组，**不影响本地 Wallpaper Engine 库**。

其余 143 个文件与上游 1.4.0 完全一致。

## 站点数据源

默认地址：`https://folia-major-3t6.pages.dev`

可通过环境变量覆盖：

```bash
DSH_FOLIA_SITE=https://your-site.pages.dev
```

站点需要提供 `/manifest.json`：

```json
{
  "images": [
    {
      "id": "azure-loop",
      "file": "azure-loop.mp4",
      "title": "Azure Loop",
      "kind": "video",
      "url": "/wallpapers/azure-loop.mp4",
      "preview": "/previews/azure-loop.jpg"
    }
  ]
}
```

只注入 `kind: "video"`（或 `.mp4` / `.webm` 后缀）的条目——上游没有静态图片的渲染管线。

## 安装

```bash
dsh plugin --profile web add dsh-folia-wallpaper
```

或从本仓库安装：

```bash
dsh plugin --profile web add github:lehua-art/dsh-folia
```

安装后重启 DSH Desktop。

## 功能（全部来自上游）

- 场景壁纸实时渲染（WebWallGL，WebGL）
- 视频壁纸播放
- 玻璃材质、可读性地板、透明度/模糊调节
- 壁纸库面板：列表/卡片、标签、排序、属性
- 播放列表、轮播、遮挡暂停、自动画质
- 字体系统、视差层、特效层、吉祥物头像、媒体桥

## 目录

| 路径 | 说明 |
| :-- | :-- |
| `lib/` | 宿主半边 + 浏览器半边（上游 31k 行客户端） |
| `lib/webwallgl/` | 场景渲染页（引擎为 npm 依赖 `webwallgl`） |
| `lib/routes/inventory.js` | **唯一改动的文件** |
| `cordis.patch.yml` | 插件行注册（8 个宿主行） |

## 许可

MIT。上游署名与许可见 `LICENSE`。