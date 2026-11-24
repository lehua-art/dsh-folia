# Folia 4.26.0-pre.70 · 身份文案 + UI 收口 + 能力作者预览图（A 机器交付）

## 基线 / 分支

- 基线：`647bca8bf1b57be076d7575b38d52c9979697287`（upstream main，4.26.0-pre.70）
- 分支：`feat/machine-a-identity-ui`
- 提交：
  - `2c75eda` chore(baseline): untrack lib/client.js + drop unreadable gitlinks
  - `b64bc83` feat(identity-ui): refresh identity copy, trim two UI blocks, add repo preview
- 版本：保持 `4.26.0-pre.70`（任务单「版本号我们统一」）；**未 npm publish**。

## 功能

1. 插件身份文案：`displayName` → `Folia · 壁纸引擎与 AI 桌宠`；`description` 覆盖壁纸 / AI 桌宠语音助手 / 多人设角色卡 / 皮肤 / 开机动画 / 能力市场；README 首屏标题 + 副标题同步。
2. 侧栏插件卡删除旧副标题；标题「壁纸引擎」+ 数量徽标保留；旧 i18n 词与 CSS 一并删除。
3. 「壁纸引擎」设置页删除「官方资源路径」整块（UI / client transient / 保存函数 / 词条）；宿主 `/we-assets-dir` 路由与 `inventory.weAssets*` 字段保留。
4. 能力详情按 `item.source` 推作者仓库 OG 预览图（仅 GitHub）：120px 高、100% 宽、`object-fit: cover`、圆角 8px、`loading="lazy"`；加载失败隐藏图片并保留占位块；非 GitHub 来源无图。图片下方小字「预览图来自作者仓库」。

## 验证

- `node scripts/build-client.mjs` → exit 0
- `node test/run-audit.mjs` → **通过 126 · 退役 49 · 失败 0 · 合计 175**
- `node test/verify-identity-ui.mjs` → **26 passed / 0 failed**
- `node test/verify-picker-upload.mjs` / `verify-capabilities.mjs` / `verify-dead-code.mjs` / `verify-dead-declarations.mjs` → 全绿

> 计数说明：任务单基线 123/51/174。新增验收测试 +1；按 `package.json` 声明补装 `webwallgl@3.0.0`（仅 node_modules，不入库）后两个环境相关退役用例转绿，故退役 51→49、通过 +2。

## 使用

本包已是完整源码，并带有构建产物 `lib/client.js` 与四个组件的兼容产物。

```powershell
npm install --no-audit --no-fund   # 需要 webwallgl 等已声明依赖才能跑全量 audit
node scripts/build-client.mjs
node test/run-audit.mjs
```

若从 git bundle 应用（要求基线 `647bca8`）：

```powershell
git fetch .\folia-machine-a-identity-ui.bundle feat/machine-a-identity-ui
git checkout -B feat/machine-a-identity-ui FETCH_HEAD
```

## 边界

- 未改：下载队列 / 卡片状态 / 卸载 / 缓存 / 预热 / 语音 / 人设存储 / 能力 catalog 数据。
- 宿主 `/we-assets-dir` 与 `inventory.weAssets*` 保留；只删客户端 UI 入口。
- 环境修复提交（build artifact 出库 + 两个不可读 gitlink）与 pre.68/pre.70 交付同口径，不含功能改动；功能提交 14 个文件。
