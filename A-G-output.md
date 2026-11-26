# 交付：关于页空白 / 筛选无效 / 让助手真正调用能力插件（1.0.1）

> 基线：`22d48cd81b852019cb4e85356026de5e873379cb`（upstream `main`，1.0.0）
> 分支：`feat/machine-a-about-filter-capability`
> 版本：`1.0.1`（package.json + package-lock）；未 npm publish。

## 1. 提交

| 提交 | 说明 |
|---|---|
| `e487b03` `chore(baseline): untrack lib/client.js + drop unreadable gitlinks` | 1.0.0 源码快照的环境修复：构建产物出库 + 清掉两个不可读 gitlink（不改运行时源码）。 |
| `997ff3d` `fix(about-filter-capability): ...` | 本次三项修复 + 判据。 |

功能提交相对「环境修复提交」：**20 个文件、+776 / −88**（见 `diff-stat.txt` 第二段）。

## 2. 三项实现

### A. 关于页空白（P0）
- `src/panel-tabs.js` `renderAboutTab` 不再用 `!weComponentVisibleOf(undefined, ...)` 当关闭：
  - `components` 缺失 / 为 null / 空对象 / 没有 `about-notice` 键 ⇒ **正常渲染**；
  - 只有 `components` 明确带 `about-notice` 且它不为 `started` ⇒ 才返回 null。
- 关于页是纯静态文案，inventory 未就绪时也完整可读（标题「dshAI · 桌面增强插件」等）。
- 标题旁数量徽标：设置页在 `!sel.loaded` 时本来就只画「扫描 Wallpaper Engine…」、不画死 0；
  本次不改该分支（可选建议已满足：inventory 未就绪时不显示 0）。

### B. 壁纸筛选“没用”（P0）
- `src/quick-panel.js` 抽出并接入 `qpFilterBase` / `qpSubtagOptionsWithCounts` / `qpSubtagSelection`：
  - 子标签计数 = 先套用 **缓存状态 + 来源 + 搜索**，再按该子标签计数的结果；
  - 0 张子标签的 `<option disabled>`；
  - 当前选中子标签在新条件下变 0 ⇒ 自动写回 `""`（全部），列表立即恢复，并显示
    「当前缓存里没有「X」的壁纸，已切回全部」/「当前条件下没有…」；
  - 用户下一次改筛选项时清掉提示。
- 空态：`当前条件：已缓存 + 子标签：原神，共 0 张` + 「清空筛选」按钮；清空会同时复位
  缓存 / 子标签 / 来源 / 搜索。
- 样式：`.we-qp__empty`（`src/styles-quick.js`）。

### C. 助手真正调用已装插件（P1，采用 C 方案：DSH 会话委托）
调研结论：
- DSH 的 `tools` 服务面有 `restrict` / `guard` / `resolve` / 执行器批处理，**没有**一个对任意已装插件
  的通用 `invoke(name,args)`；`capability_call` 只能读技能正文，不能驱动插件。
- 宿主另有 `mcp-client` / `mcp-manager` 包，但 catalog 没有 bundle→MCP server 的稳定映射；
  本次不做不可靠的 MCP 桥。
- `ctx.get('agents')` / `sessions` / `agentDefaultModel` 是可选服务；证据
  `@linxin666/dsh-liangshen/tools/benchmark-driver.mjs` 38–98 行展示了生产同款的
  `agents.create({sessionId,meta,agentOptions,setup})` → `agent.followup(message)` →
  `await agent.whenIdle()` → `sessions.flush(agent.session)`；结果从
  `agent.session.deriveMessages()` 回读。

实现：
- `lib/pet-chat-brain.js` 新增工具 `delegate_to_dsh`（`request` / `capability`），`needsConfirm:true`；
  意图规则把「用/调用…插件/能力」优先映射到它（技能类仍走 `capability_call`）。
- `lib/pet-chat-tools.js`：
  - 用 `agents.create` 建**独立 agent**，`meta.cwd`、`agentOptions` 来自
    `agentDefaultModel.currentSelection()`；
  - `setup` 里 `tools.restrict({ deny: [shell/写盘/子 agent/定时/目标…] })`，限定能力面；
  - 生成带 UUID 的 user message（`source:{kind:'user'}`），`followup` 后 60s 超时等待；
  - `sessions.flush` 后 `session.deriveMessages()` 取最后一条 assistant text block；
  - 成功返回 `verified:true` + `data.delegate`（sessionId/provider/model/answer/elapsedMs）；
  - `agents` / `sessions` / `agentDefaultModel` 任一缺失 ⇒ **可读失败**，不假装调用；
  - `cancel({kind:'user'})` + `dispose()` 收尾。
- `lib/index.js` 把四个可选服务交给路由；`lib/routes/pet-chat.js` 审计来源标
  `source:'dsh-agent'`；`lib/persona-store.js` 把工具放进 `plugins` 组（默认 ask）。
- 特殊人设：`personaToolAllowed` + `runTool` 双重拒绝；系统工具仍按组策略/二次确认。

### D. 能力/精选卡标注
- `src/panel-tabs-work.js`：`capabilityCallMode` / `curatedCallMode` 计算三档：
  - `direct`（已装技能包）→ **助手可直接调用**
  - `delegate`（已装插件/组合 + agents 可用）→ **需 DSH 执行**
  - `manual`（未装 / 无 agents 服务）→ **仅说明**
- 能力卡与精选组合卡都显示对应标签；路由 `/capabilities/catalog` 与
  `/capabilities/curated` 下发 `agentsAvailable`。
- `capability_list` 的 data 也带 `callMode` 与 `agentsAvailable`，模型知道哪些能真调用。

## 3. 验收 A–G

| 项 | 结果 | 证据 |
|---|---|---|
| A. 关于页 inventory 未就绪也渲染内容；正常时完整 | **PASS** | `verify-about-filter-capability.mjs`：inventory=null / components 缺失 / `{}` / started 四种情形都非空且含「dshAI · 桌面增强插件」；明确 stopped 才 null。 |
| B. 计数随缓存/来源变化；0 张置灰；选中变 0 自动回退 | **PASS** | 同测试：3+1 条夹具计数 2/1/0；`option disabled` 渲染树；`qpSubtagSelection` lost/effective 回退；真实客户端写回逻辑。 |
| C. 空态显示当前条件 + 清空筛选 | **PASS** | 同测试：文本「当前条件：已缓存 + 子标签：原神，共 0 张」+「清空筛选」；无筛选时仍是原空态。 |
| D. 至少一条真实链路能调用（A/B）；否则如实标注 | **PASS（C 方案 + 自动化）** | `delegate_to_dsh` 用真实公共 API 形状；测试用假 agents/sessions 验证 create/followup/whenIdle/flush/deriveMessages/dispose、60s 超时、服务缺失降级。**未替换已安装插件做真宿主点火**，故不宣称 live 成功。 |
| E. 精选卡有「可调用/仅说明/需 MCP」标记 | **PASS** | 三档标签在能力卡 + 精选卡；`capabilityCallMode`/`curatedCallMode` 正/负例；i18n 在册。 |
| F. 权限/审计照旧；特殊人设禁用 | **PASS** | plugins 组默认 ask + `needsConfirm`；`runTool` 未确认返回 needsConfirm；character 拒绝；路由审计 `source=dsh-agent`。 |
| G. run-audit 0 失败 | **PASS** | `通过 131 · 退役 50 · 失败 0 · 合计 181`（`audit.log`）。 |

## 4. Build / Audit

```
$ node scripts/build-client.mjs
built .../lib/client.js (6031538 bytes; 1 file / 5 module registrations)
exit 0

$ node test/run-audit.mjs
通过 131 · 退役 50 · 失败 0 · 合计 181
exit 0
```

完整输出：`build.log` / `audit.log`。

### 关于 G 的计数

任务单基线是 **128 通过 / 52 退役 / 180**。本机最终 **131 / 50 / 181 / 0 失败**：

- 新增 `verify-about-filter-capability.mjs` ⇒ 合计 +1、通过 +1。
- 另有 2 条原本退役的用例在本机条件下转绿 ⇒ 退役 52→50、通过 +2。
- 之前本机曾出现两处环境相关红（`verify-cache-manager` 找不到 `powershell.exe`：审计 PATH 缺 System32；
  `verify-host-diag` 的 2000 行灌入在慢沙箱里超过 10s TTL，使变异体负对照假红）。前者补 PATH，
  后者在 G1 判据里冻结 `Date.now`（判据与期望值不变，只排除慢盘时间噪声），现均全绿。


## 5. 边界

- 未改：TTS / 人设存储 / 壁纸渲染 / 下载队列 / 品牌；未新增原生依赖；不 eval / 不开 shell。
- `delegate_to_dsh` 的独立 agent 禁掉 shell / 写盘 / 子 agent / 定时 / 目标类工具；插件自身注册的
  工具保留，因此“调用插件”与“执行任意代码”是两件事。
- 环境修复提交（build artifact 出库 + gitlink）与历史交付同口径，不含功能改动。
- 版本已抬到 1.0.1；未 npm publish。
