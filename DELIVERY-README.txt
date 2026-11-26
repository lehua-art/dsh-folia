# Folia 1.0.1 · 关于页 / 筛选 / DSH 能力调用（A 机器交付）

## 基线 / 分支

- 基线：`22d48cd81b852019cb4e85356026de5e873379cb`（upstream main，1.0.0）
- 分支：`feat/machine-a-about-filter-capability`
- 提交：
  - `e487b03` chore(baseline): untrack lib/client.js + drop unreadable gitlinks
  - `997ff3d` fix(about-filter-capability): unblank about tab, recompute subtag filters, delegate to DSH
- 版本：`1.0.1`（package.json + package-lock）；**未 npm publish**。

## 修复

1. **关于页空白（P0）**
   - `renderAboutTab` 只在 `components` 明确带 `about-notice` 且它被关时隐藏；
   - inventory / components 未就绪时正常渲染完整静态内容。

2. **壁纸筛选（P0）**
   - 子标签计数按当前缓存 / 来源 / 搜索重算；
   - 0 张置灰；选中项变 0 自动回退「全部」并提示；
   - 空态显示「当前条件…共 0 张」+「清空筛选」。

3. **助手调用已装插件（P1，C 方案：DSH 会话委托）**
   - 新增 `delegate_to_dsh`：`agents.create` 独立 agent → `setup` 限能力 → `followup` →
     60s 超时 → `sessions.flush` → `deriveMessages` 回读 assistant 文本 → dispose；
   - 默认询问、审计来源 `dsh-agent`、特殊人设禁用；
   - `agents/sessions/agentDefaultModel` 缺失时如实降级；
   - 能力 / 精选卡标注：助手可直接调用 / 需 DSH 执行 / 仅说明。

## 验证

- `node scripts/build-client.mjs` → exit 0（`lib/client.js` 6,031,538 bytes）
- `node test/run-audit.mjs` → **通过 131 · 退役 50 · 失败 0 · 合计 181**
- `node test/verify-about-filter-capability.mjs` → **33 passed / 0 failed**
- `verify-host-diag` 48/48 · `verify-cache-manager` 67/67 · `verify-capabilities-v5` 31/31

> 计数说明：任务单基线 128/52/180。新增验收 +1；另 2 条原退役用例在本机转绿（退役 52→50）。
> 本机还修了两处环境相关红：审计 PATH 缺 powershell；host-diag 慢沙箱 2000 行灌入超过 10s TTL
> （G1 冻结时钟，判据不变）。

## 使用

本包已是完整源码，并带构建产物 `lib/client.js` 与四个组件兼容产物。

```powershell
npm install --no-audit --no-fund   # 需要 webwallgl 等已声明依赖才能跑全量 audit
node scripts/build-client.mjs
node test/run-audit.mjs
```

若从 git bundle 应用（要求基线 `22d48cd`）：

```powershell
git fetch .\folia-machine-a-about-filter-capability.bundle feat/machine-a-about-filter-capability
git checkout -B feat/machine-a-about-filter-capability FETCH_HEAD
```

## 边界

- 未改：TTS / 人设存储 / 壁纸渲染 / 下载队列 / 品牌；未新增原生依赖；不 eval / 不开 shell。
- `delegate_to_dsh` 的独立 agent 禁 shell / 写盘 / 子 agent / 定时 / 目标工具；
  插件自身注册的工具保留，因此“调用插件”与“执行任意代码”是两件事。
- 环境修复提交（构建产物出库 + 两个不可读 gitlink）不含功能改动；功能提交 20 个文件。
