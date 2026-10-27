# 问题分诊与认领审批（Triage & claim approval）

> 本文面向**贡献者与维护者**，说明 issue 从提出到被认领、到 PR 收口的流程与机器判据。
> 治理总纲（历史瘦身 / 分支保护 / 标签体系的来龙去脉）：issue [#212](https://github.com/elysia395/dsh-folia/issues/212)。

## 标签体系

| 标签 | 含义 | 谁打 |
|---|---|---|
| `status:needs-triage` | 刚提出、还没人看过 —— **新 issue 的初始状态**（模板自动带上） | 模板自动 |
| `status:accepted` | 维护者已确认"这是个值得做的事"；**认领从这里开始** | 维护者 |
| `status:declined` | 明确不做/不是本仓范围（会写一句原因） | 维护者 |
| `area:client` | 浏览器半边（`src/**` 与渲染 / 面板 / 玻璃） | 任何人 |
| `area:host` | 宿主半边（`lib/**`：路由、扫描、媒体管线、配置） | 任何人 |
| `area:glass-ui` | 液态玻璃 / 外观 / 字体 / 吉祥物 | 任何人 |
| `area:webwallgl` | 场景 / 网页壁纸渲染引擎与媒体桥 | 任何人 |
| `area:ci-docs` | CI、守卫、文档、发布链路 | 任何人 |

沿用 GitHub 默认标签：`bug` / `enhancement` / `documentation` / `good first issue` /
`help wanted` / `question` / `duplicate` / `invalid` / `wontfix` / `accessibility`。
`good first issue` 只在**已受理**且确认范围小的时候加 —— 它是给新贡献者的承诺。

## 适用范围与权限

**外部贡献者必须先在 issue 申请认领，获得维护者批准并成为 assignee 后，才能创建 PR；不能直接开 PR。**
此要求包括 draft PR，关闭后重新打开也不例外。

- 本文的维护者指仓库 owner，以及 GitHub API 实时确认具有 `write` / `maintain` / `admin` 权限的协作者。
- 只有上述人员豁免 issue 认领门禁；每次校验都重新查询权限，不凭缓存的身份、`author_association` 或 `contributor` 徽章放行。仅有历史贡献、`read` / `triage` 权限不算豁免。
- 不设 `claim:exempt` 或其他标签豁免。权限 API 故障属于校验失败，不能据此认定作者违规并关闭 PR。

## 认领申请与审批（评论命令）

issue 必须处于 **open**，已由维护者添加 `status:accepted`，且不带 `status:needs-triage` / `status:declined`，才能进入认领流程。受理 issue 不等于批准某位贡献者认领。

| 命令或操作 | 谁执行 | 结果 |
|---|---|---|
| `/assign` | 外部贡献者本人，在目标 issue 评论 | 仅登记认领申请，**不会立刻分配**；等待维护者同意 |
| `/approve @login` | 维护者，在同一个 issue 评论 | 核对该贡献者事前的有效 `/assign` 申请后，批准并由机器人指派给 `@login` |
| GitHub UI 手动指派 | 维护者 | 可替代 `/approve`，但同一 issue 必须已有被指派者事前的有效 `/assign` 记录；直接指派不能跳过申请 |
| `/unassign` | 申请人或认领人本人 | 取消自己的待批申请，或释放自己的认领 |
| `/unassign @login` | 维护者 | 取消指定人的申请或释放其认领 |
| `/unassign`（无参数） | 维护者 | 释放当前所有 assignee，不是仅移除维护者本人 |

- 还未受理时，先等维护者受理，再评论 `/assign`；申请后必须等审批与实际指派完成，不能把机器人收件回复当作批准。
- 已有其他认领人时，先沟通接力；新的 `/assign` 不会自动抢占或重复指派。取消申请后若想继续，需重新申请并获得批准。
- 认领后 **14 天**无进展且无留言说明，维护者可以改派或释放，会先在该 issue 留言 @ 认领人。
- 评论命令入口为 `.github/workflows/issue-claim.yml`。上述审批制是工作流必须落实的契约；旧版 `/assign` 直接自动指派不等于维护者批准，部署条件见下文。

## 维护者分诊动作（每周一次或按需）

1. 打开 `status:needs-triage` 列表，逐条读；
2. 能复现或有价值的，由维护者添加 `status:accepted`、移除 `status:needs-triage` / `status:declined`，再打 `area:*` 及合适的 `good first issue`；不做的标 `status:declined`，写明原因后关闭；
3. 审阅 `/assign` 申请，确认范围与认领人后，在同一 issue 评论 `/approve @login` 或按上表手动指派；
4. 已受理但长期无人认领且影响面大的，挂到维护者自己的计划里或加入 milestone。

## 贡献者路径（从 issue 到合并）

1. 找到合适的 issue，或先开 issue 讨论，等待维护者受理；
2. 在该 issue 评论 `/assign`，等待维护者 `/approve @login` 或合规的 UI 手动指派，确认自己已成为 assignee；
3. 从最新 `main` 开分支，按 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 准备环境，并按完整改动类型选择验证路径；修改 `src/**` 时先 `npm run build`，构建产物不入库；
4. **完成受理、申请、批准及指派后再创建 PR**，正文按下文关联 issue；一个 PR 只解决一个明确问题；
5. 合并前必须满足仓库现有代码 CI 与 `issue-claim-policy`，并经过维护者审阅。实时权限豁免仅针对认领门禁，不豁免代码 CI。

## PR 关联与时间判据

外部 PR 正文至少包含一条**独立行**的 `Fixes` 或 `Refs` 引用，每个 issue 单独一行，可列多条。支持以下形式，但完整 URL 和 `owner/repo#123` 必须指向本仓库：

```text
Fixes #123
Refs #124
Fixes https://github.com/elysia395/dsh-folia/issues/125
Refs elysia395/dsh-folia#126
```

裸 `#123`、任意文字中的 `#` 号、`关联 issue：Fixes #123` 等带前缀的行、其他仓库的引用，以及标题或 PR 评论中的引用，都不能替代正文里的独立关联行。`Refs` 仅引用 issue，不承诺合并后自动关闭。

**所有关联 issue 都必须逐一合规，不能只挑其中一个通过：**

- 当前是 open，带 `status:accepted`，不带 `status:needs-triage` / `status:declined`，且 PR 作者是当前 assignee。
- 受理必须有可信的维护者操作记录；申请必须是 PR 作者本人在同一 issue 的有效 `/assign`；审批必须来自维护者 `/approve @login` 及其对应的机器人指派，或维护者的 UI 手动指派，且申请先于审批/分配。
- 上述可信受理、申请、批准及实际分配记录的时间都必须**严格早于 `PR.created_at`**。校验依据为 GitHub API 的评论与 issue 时间线，不能只看当前标签/assignee 或相信 PR 正文自报的批准与时间。
- PR 创建后补受理、补 `/assign`、补批准或补指派，不能使原 PR 合格；编辑正文、转为 ready 或重新打开同一 PR 也不重置 `created_at`。需先走完流程，再创建一个新的 PR。

## 自动执行与部署

以下是可信工作流必须实现的门禁规则，**不是仅修改文档就已上线的功能**：

- 通过 `pull_request_target` 使用受信任的基线工作流校验，不能带写权限检出或执行 PR head 中的代码。创建、编辑、同步提交、重新打开及转为 ready 等事件都要重验；draft PR 同样受检。
- 确认外部作者违规时，机器人解释具体原因并自动关闭 PR，同时在该 PR 的 **head SHA** 创建或更新固定名称 **`issue-claim-policy`** 的 Check Run，结论为 `failure`。合规或实时权限豁免时该检查通过；不能只让基线/merge SHA 上的工作流作业变红来替代这个检查。
- GitHub API 故障、权限查询失败或历史数据获取不完整而无法可靠判定时，检查仅判失败并说明无法完成校验，**不因状态未知误关 PR**；取得可靠数据后再重新判断。完整历史确认没有事前申请或批准的，仍属于违规，而不是 API 故障。
- issue 开闭、受理相关标签或分配变化时，重新校验所有按上述格式关联该 issue 的开放 PR。机器人执行 `/approve` 或 `/unassign` 后，必须在当前运行中主动刷新关联 PR 的检查，不能依赖机器人或 `GITHUB_TOKEN` 产生的事件触发另一次工作流。
- GitHub 不支持预先禁止外部贡献者打开 PR 创建页。因此执行方式是**创建后自动解释并关闭 + 必过检查阻断合并**，不是禁用创建页面。
- 审批命令与 PR 门禁的可信工作流必须先合入默认分支 **`main`** 才生效。维护者还须在 Ruleset / 分支保护的 **Required checks** 中保留当前配置并追加 `issue-claim-policy`；不能借此替换或移除既有代码 CI，也不在此流程中擅自迁移到 `ci/result`。

合并要求统一为：**现有代码 CI + `issue-claim-policy` 全绿**。当前分支的代码 CI 汇总名为 `ci/result`，不代表远程 Required checks 已迁移；现有 CI 检查名称的调整须另行确认。

---

## 摘要 / Summary

外部贡献者必须先等 issue 受理，再 `/assign` 申请，取得维护者 `/approve @login` 或有事前申请记录的 UI 指派后才能开 PR；`/assign` 不会立刻分配。本人 `/unassign` 取消申请或释放，维护者可 `/unassign @login` 或无参释放所有认领人。豁免仅限实时确认的 owner / `write` / `maintain` / `admin`，不凭 contributor 徽章或标签。PR 正文须有独立行 `Fixes` / `Refs`（支持多条、本仓库 issue URL 或 `owner/repo#123`）；每项均须 open、accepted、无 needs-triage/declined，作者为 assignee，可信受理/申请/批准/分配均早于 PR 创建。补手续后需新开 PR。可信门禁覆盖 draft/reopened，违规自动解释关闭，head SHA 的 `issue-claim-policy` 失败；API 故障只判失败、不误关。issue 变化重验关联开放 PR，机器人 `/approve` / `/unassign` 主动刷新。工作流合入 main，保留现有 Required checks 并追加新检查后，按“现有代码 CI + `issue-claim-policy`”阻断合并；GitHub 不能预禁创建页。

External contributors must wait for issue acceptance, request with `/assign`, then receive a maintainer's `/approve @login` or UI assignment backed by a prior request before opening a PR; `/assign` does not assign immediately. Their own `/unassign` cancels a request or releases a claim; maintainers may use `/unassign @login` or release all assignees with no argument. Only the owner or collaborators with live `write` / `maintain` / `admin` permission are exempt, not contributor badges or labels. PR bodies need standalone `Fixes` / `Refs` lines (multiple lines, same-repository issue URLs and `owner/repo#123` are supported); every issue must be open, accepted, free of needs-triage/declined, and assigned to the author, with trusted acceptance/request/approval/assignment predating PR creation. Late compliance requires a new PR. The trusted gate covers drafts and reopened PRs, explains and closes confirmed violations, and fails `issue-claim-policy` on the head SHA; API failures fail the check without closing. Issue changes revalidate linked open PRs, and bot `/approve` / `/unassign` actions refresh them directly. Deploy workflows to main, preserve existing Required checks and append the new check, requiring existing code CI + `issue-claim-policy`; GitHub cannot block access to the creation page.
