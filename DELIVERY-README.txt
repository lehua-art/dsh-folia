# Folia 4.26.0-pre.69 · 侧栏「壁纸」本地上传入口（A 机器交付）

## 基线 / 分支

- 基线：`84872f104e53d6b087174ce4c3e25c27b93d220a`（upstream main，4.26.0-pre.69）
- 分支：`feat/machine-a-qp-upload`
- 提交：
  - `ca17c62` chore(baseline): untrack lib/client.js + drop unreadable gitlinks
  - `d51d7e1` feat(quick-panel): add local upload entry to wallpaper tab
- 版本：保持 `4.26.0-pre.69`（任务单「版本号我们统一」）；**未 npm publish**。

## 功能

侧栏「壁纸」页签 → 搜索框右侧「⬆ 上传本地」：

- 隐藏多选 file input（`.jpg,.jpeg,.png,.mp4`）；真 `<button>`，键盘可 Tab。
- 复用 `src/client.js` 的 `uploadWallpaperFile(file)`，不重写上传。
- 多文件串行上传；搜索行下方显示「上传中 1/3…」/ 错误 / 重复提示。
- 成功后来源切「本机」，并沿用共享函数内的 `applySelection` 选中新上传项。
- 整个壁纸列表区支持拖拽上传（走同一个上传函数）。
- 宿主 `UPLOAD_EXT` 只认 jpg/png/mp4 ⇒ webp/gif/avif/webm 不放开。
- 新词已进 i18n；新增 `test/verify-qp-upload.mjs` 并挂入 verify 链。

## 验证

- `node scripts/build-client.mjs` → exit 0
- `node test/run-audit.mjs` → **通过 125 · 退役 49 · 失败 0 · 合计 174**
- `node test/verify-qp-upload.mjs` → **59 passed / 0 failed**
- live 宿主上传实测（png/jpg/mp4 200、重复 `duplicate:true`、webp 415），测试条目已清理；详见 `A-G-output.md`。

> 计数说明：任务单基线 123/50/173。新增验收测试 +1；`verify-scene-live-occlusion` 需要 `package.json` 已声明的 `webwallgl@3.0.0`，源码快照不带 node_modules，补装依赖后由红转绿，故退役 50→49、通过再 +1。

## 使用

本包已是完整源码，并带有构建产物 `lib/client.js` 与四个组件的兼容产物。

```powershell
npm install --no-audit --no-fund   # 需要 webwallgl 等已声明依赖才能跑全量 audit
node scripts/build-client.mjs
node test/run-audit.mjs
```

若从 git bundle 应用（要求基线 `84872f1`）：

```powershell
git fetch .\folia-machine-a-qp-upload.bundle feat/machine-a-qp-upload
git checkout -B feat/machine-a-qp-upload FETCH_HEAD
```

## 边界

- 未改：下载队列 / 卡片状态 / 卸载 / 缓存 / 预热 / 能力页 / 语音相关。
- 未改 `src/client.js`。
- 环境修复提交（build artifact 出库 + 两个不可读 gitlink）与 pre.68 交付同口径，不含功能改动；功能提交只有 8 个文件。
