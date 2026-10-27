# dsh-folia

DSH Desktop 的壁纸插件。基于 [dsh-plugin-wallpaper-engine](https://www.npmjs.com/package/dsh-plugin-wallpaper-engine)（MIT，© 2026 elysia395）二次开发：**保留其全部功能**，并增加一个自建站点数据源。

**不依赖上游插件**——装这一个包就能用。

## 安装

```bash
dsh plugin --profile web add dsh-folia
```

安装后重启 DSH Desktop。

## 两个包

| 包 | 作用 |
| :-- | :-- |
| `dsh-folia` | 主包：浏览器半边（31k 行客户端）+ `cordis.patch.yml` + 站点数据源补丁 |
| `dsh-folia-host` | 宿主包：把主包的宿主半边重新导出成独立插件，提供 `wallpaperEngineHost` 服务 |

为什么需要宿主包：`cordis.patch.yml` 里宿主那一行（`id: wallpaper-engine`）的 `name` **不能指向 patch 自己所属的 bundle 包名**——会被加载器当成重复项跳过，导致 `wallpaperEngineHost` 服务不被注册，7 个子模块永久停留在 `pending`。所以宿主行必须指向另一个包名，这就是 `dsh-folia-host` 存在的唯一理由。

主包把 `dsh-folia-host` 列为依赖，因此安装时两个包会自动一起装上。

## 与上游的差异

功能改动**只有一处**，位于 `lib/routes/inventory.js`：

```js
const payload = await buildInventory();
const remote = await foliaRemote();          // 拉站点 manifest
const merged = remote.length
  ? { ...payload, wallpapers: [...(payload.wallpapers || []), ...remote] }
  : payload;
```

`foliaRemote()` 把站点上的视频壁纸转成插件认识的条目形状，60 秒缓存。站点不可达时返回空数组，**不影响本地 Wallpaper Engine 库**。

其余文件与上游 1.4.0 逐字节一致。

## 站点数据源

默认 `https://folia-major-3t6.pages.dev`，可用环境变量覆盖：

```bash
DSH_FOLIA_SITE=https://your-site.pages.dev
```

站点需提供 `/manifest.json`：

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

## 功能（全部来自上游）

- 场景壁纸实时渲染（WebWallGL / WebGL）
- 视频壁纸播放
- 玻璃材质、可读性地板、透明度与模糊调节
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
| `packages/dsh-folia-host/` | 宿主包装包的源码（发布为 `dsh-folia-host`） |

## 许可

MIT。上游署名与许可见 `LICENSE`。