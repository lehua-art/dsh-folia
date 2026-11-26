/**
 * capabilities-curated.js — 能力页「精选」20 套组合（静态数据，不联网）。
 *
 * 纪律：
 *   · 这里只有**展示数据 + 命令**，没有安装器：页面复制 `dsh plugin --profile web add <pkg>` 给用户自己装；
 *   · 不扫描安装路径/注册表；是否已装由路由用 profile node_modules 的 package.json 只读探测；
 *   · 20 套包名均来自交接单（已用 npm registry 校验存在）；
 *   · risk: low|medium|high；budget: free|key|software|paid；
 *   · `steps[].alt` / `optional` 用于二选一与可选项，不在数据层执行安装。
 */

export const CURATED_COMMAND_PREFIX = 'dsh plugin --profile web add ';

export const CURATED_FAMILIES = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'basic', label: '基础' },
  { id: 'work', label: '工作' },
  { id: 'dev', label: '开发' },
  { id: 'creative', label: '创意' },
  { id: 'life', label: '生活' },
  { id: 'advanced', label: '进阶' },
]);

const step = (pkg, why, extra = {}) => ({ pkg, why, ...extra });

export const CURATED_BUNDLES = Object.freeze([
  {
    id: 'starter', family: 'basic', icon: '🧰', name: '新手必装',
    goal: '一次补齐省钱、可信、可管的基础件',
    requires: '无', risk: 'low', budget: ['free'],
    steps: [
      step('dsh-unlag', '让卡顿的对话/输出先顺起来'),
      step('dsh-cost-meter', '看见每次调用花了多少，避免无感烧钱'),
      step('dsh-trust-check', '装第三方插件前先过一遍安全检查'),
      step('dsh-config-manager', '集中管理插件配置，换机器好迁移'),
    ],
  },
  {
    id: 'search-notify', family: 'basic', icon: '🔎', name: '联网与对比',
    goal: '让助手能查、能比、能在有结果时叫你',
    requires: '无', risk: 'low', budget: ['free'],
    steps: [
      step('dsh-free-search', '不用 Key 的联网搜索入口'),
      step('dsh-agent-compare', '同一问题让多个模型/Agent 对比'),
      step('dsh-notify-me', '长任务跑完后主动通知'),
    ],
  },
  {
    id: 'office', family: 'work', icon: '📄', name: '办公文档',
    goal: '把 Word / PDF / Excel 串成一条工作流',
    requires: 'Office/WPS 可选', risk: 'low', budget: ['free'],
    steps: [
      step('@deepseek-ai/dsh-skill-office', 'Office 文档读写的基础技能'),
      step('dsh-pdf-mineru', 'PDF 解析/抽取，扫描件也能处理'),
      step('dsh-excel-chat', '用自然语言改表格、做汇总'),
      step('@copylee/dsh-office', '更完整的 Office 集成（可选）', { optional: true }),
    ],
  },
  {
    id: 'data', family: 'work', icon: '📊', name: '数据分析',
    goal: '从数据库到图表到对账，一条链路跑通',
    requires: '数据库（SQLite 免配置）', risk: 'low', budget: ['free'],
    steps: [
      step('dsh-sql', '直连数据库做查询与导出'),
      step('dsh-genui', '把查询结果直接生成可交互图表'),
      step('dsh-excel-reconcile', '表格对账，找差异'),
      step('@chengxianglibra/dsh-data-analysis', '更完整的数据分析套件（可选）', { optional: true }),
    ],
  },
  {
    id: 'research', family: 'work', icon: '🎓', name: '学术研究',
    goal: '读论文、翻译、记住要点、再写成文档',
    requires: '无', risk: 'low', budget: ['free'],
    steps: [
      step('dsh-pdf-mineru', '先解析论文 PDF'),
      step('dsh-pdf-translator', '边读边译，保留版式'),
      step('dsh-mnemon', '把关键结论记成可检索的记忆'),
      step('@deepseek-ai/dsh-skill-office', '最后产出 Word/汇报'),
    ],
  },
  {
    id: 'meeting', family: 'work', icon: '🗣️', name: '会议与沟通',
    goal: '会议信息进得来、归档得住、结论叫得到人',
    requires: '微信/飞书/QQ 等账号', risk: 'medium', budget: ['free'],
    steps: [
      step('@xmanrui/dsh-im', '接入常用即时通讯'),
      step('@michengai/dsh-archive-manager', '把聊天/会议资料归档'),
      step('dsh-notify-me', '结论和待办主动提醒'),
    ],
  },
  {
    id: 'ops-report', family: 'work', icon: '📈', name: '运营与报表',
    goal: '数据表 → 查询 → 图表 → 配图，做周报/月报',
    requires: '数据表/数据库；图像 Key（可选）', risk: 'low', budget: ['free', 'key'],
    steps: [
      step('dsh-excel-chat', '读取并汇总运营表格'),
      step('dsh-sql', '需要时直连业务库'),
      step('dsh-genui', '把指标做成图表'),
      step('dsh-image-gen', '给报表配图（可选，需 Key）', { optional: true }),
    ],
  },
  {
    id: 'coding', family: 'dev', icon: '💻', name: '编程开发',
    goal: '写代码、看 diff、管 Git，少切窗口',
    requires: 'Git 仓库', risk: 'low', budget: ['free'],
    steps: [
      step('@michengai/dsh-code-review', '对改动做结构化 Code Review'),
      step('@xbzbing/dsh-git-panel', '在 DSH 里看分支/提交/差异'),
      step('dsh-vscode-connect', '和 VS Code 联动（可选）', { optional: true }),
    ],
  },
  {
    id: 'gamedev', family: 'dev', icon: '🎮', name: '游戏开发',
    goal: '资产 → 引擎 → 审查，一条游戏制作链',
    requires: 'Blender 4.x + Unity/UE + Git', risk: 'medium', budget: ['software'],
    steps: [
      step('dsh-blender-plugin', '从 Blender 出资产/改场景'),
      step('dsh-unity-mcp-bridge', '接 Unity 编辑器；UE 用 dsh-unreal-mcp', { alt: 'dsh-unreal-mcp' }),
      step('@michengai/dsh-code-review', '审查脚本与引擎代码'),
      step('@xbzbing/dsh-git-panel', '管理工程仓库'),
    ],
    conflicts: ['Unity 与 Unreal 二选一：装 dsh-unity-mcp-bridge 或 dsh-unreal-mcp，不要同时装'],
  },
  {
    id: 'rpa', family: 'dev', icon: '🖱️', name: '自动化 / RPA',
    goal: '让桌面操作、定时任务和通知自己跑',
    requires: 'Windows', risk: 'medium', budget: ['free'],
    steps: [
      step('dsh-windows-mcp', '操作 Windows 窗口/控件'),
      step('@aiwayds/dsh-cron', '定时触发自动化任务'),
      step('dsh-notify-me', '跑完/失败都通知'),
    ],
  },
  {
    id: 'agents', family: 'dev', icon: '🤖', name: '多 Agent 协作',
    goal: '把一个大任务拆给多个 Agent 并行做',
    requires: '无', risk: 'medium', budget: ['free'],
    steps: [
      step('@nanmicoder/dsh-agent-teams', '多 Agent 编队与任务分配'),
      step('ds-bot', '给 Agent 一个可对话的入口'),
      step('dsh-agent-compare', '比较不同 Agent 的结果，选优'),
    ],
  },
  {
    id: 'remote', family: 'dev', icon: '📡', name: '远程办公',
    goal: '人在外面，也能连回自己的开发环境',
    requires: '服务器/手机', risk: 'medium', budget: ['free'],
    steps: [
      step('dsh-remote', '从远程连回 DSH'),
      step('dsh-mobile', '手机端入口'),
      step('dsh-config-manager', '多端配置同步/迁移'),
    ],
  },
  {
    id: 'design', family: 'creative', icon: '🎨', name: '设计视觉',
    goal: 'Figma 读设计 → 生图 → 安全兜底',
    requires: 'Figma 账号；图像 Key', risk: 'medium', budget: ['key'],
    steps: [
      step('dsh-figma-mcp', '读取 Figma 文件/图层'),
      step('dsh-image-gen', '按描述生成配图/素材'),
      step('dsh-trust-check', '生图/第三方 MCP 的安全检查'),
    ],
  },
  {
    id: 'video', family: 'creative', icon: '🎬', name: '视频剪辑',
    goal: '分镜 → 剪辑软件 → 系统操作兜底',
    requires: 'PR / DaVinci / 剪映', risk: 'high', budget: ['software'],
    steps: [
      step('dsh-video-storyboard', '先把脚本拆成分镜'),
      step('@iflow-mcp/leancoderkavy-premiere-pro-mcp', '接 Premiere Pro；DaVinci 用 davinci-resolve-mcp', { alt: 'davinci-resolve-mcp' }),
      step('dsh-windows-mcp', '剪映等无 MCP 的软件用桌面操作兜底'),
    ],
    conflicts: ['Premiere 与 DaVinci MCP 二选一；high 风险，先装 dsh-trust-check 再装第三方 MCP'],
  },
  {
    id: 'content', family: 'creative', icon: '✍️', name: '内容创作',
    goal: '梗图/配图/PPT，从灵感到成稿',
    requires: '图像 Key（可选）', risk: 'low', budget: ['free', 'key'],
    steps: [
      step('dsh-meme', '梗图/表情包快速产出'),
      step('dsh-image-gen', '生成配图（可选，需 Key）', { optional: true }),
      step('dsh-ppt', '把内容直接排成 PPT'),
    ],
  },
  {
    id: 'engineering', family: 'creative', icon: '📐', name: '3D 与工程',
    goal: 'Blender / CAD 模型进 DSH，做检查与说明',
    requires: 'Blender / AutoCAD', risk: 'high', budget: ['software'],
    steps: [
      step('dsh-blender-plugin', 'Blender 场景/资产接入'),
      step('autocad-mcp', '接 AutoCAD；替代方案 @aryacode/dsh-engineering', { alt: '@aryacode/dsh-engineering' }),
      step('dsh-trust-check', '第三方 MCP 先过安全检查'),
    ],
    conflicts: ['AutoCAD MCP 与 dsh-engineering 二选一；high 风险，先 trust-check'],
  },
  {
    id: 'companion', family: 'life', icon: '🐟', name: '情绪陪伴与桌宠',
    goal: '让桌宠会说话，也能被你叫醒/提醒',
    requires: '无', risk: 'low', budget: ['free'],
    steps: [
      step('dsh-folia', '本插件（当前已装）'),
      step('dsh-speak-up', '让桌面角色主动开口'),
      step('dsh-notify-me', '提醒/待办叫得到你'),
    ],
    conflicts: ['dsh-pet / dsh-fish-soul / dsh-soul-md 与本插件部分功能重叠，二选一'],
  },
  {
    id: 'learn', family: 'life', icon: '📚', name: '学习成长',
    goal: '读材料、记知识、产出学习文档',
    requires: '无', risk: 'low', budget: ['free'],
    steps: [
      step('dsh-pdf-mineru', '拆开教材/论文/课件'),
      step('dsh-mnemon', '把知识点记成长期记忆'),
      step('@deepseek-ai/dsh-skill-office', '整理成笔记/Word'),
      step('dsh-notify-me', '复习提醒'),
    ],
  },
  {
    id: 'security', family: 'advanced', icon: '🛡️', name: '安全与治理',
    goal: '先审、再限权、最后可回滚',
    requires: '无', risk: 'low', budget: ['free'],
    steps: [
      step('dsh-trust-check', '插件信任检查'),
      step('dsh-perm-gate', '给工具/文件权限加闸'),
      step('dsh-config-manager', '配置变更可回滚/可迁移'),
    ],
  },
  {
    id: 'models', family: 'advanced', icon: '🧠', name: '模型与订阅',
    goal: '控制成本，接上更多可用模型',
    requires: '对应账号', risk: 'medium', budget: ['free', 'paid'],
    steps: [
      step('dsh-cost-meter', '按调用看成本'),
      step('@ebony-vinyl/dsh-our-free-model', '接入免费的模型通道；替代 dsh-connect-workbuddy', { alt: 'dsh-connect-workbuddy' }),
      step('dsh-config-manager', '模型/端点配置集中管理'),
    ],
  },
]);

/** 按顺序生成可执行安装命令（每行一条）。 */
export function curatedCommands(bundle) {
  const steps = bundle && Array.isArray(bundle.steps) ? bundle.steps : [];
  return steps.map((item) => CURATED_COMMAND_PREFIX + item.pkg);
}

/** 场景向导（纯规则，不调模型）：返回 1–2 个 bundle id。 */
export function curatedRecommend(role, software) {
  const r = String(role || '').toLowerCase();
  const s = String(software || '').toLowerCase();
  if (r === 'secure' || /安全|trust/.test(s)) return ['security', 'starter'];
  if (r === 'work' || r === 'office') {
    if (/excel|data|数据/.test(s)) return ['data', 'ops-report'];
    return ['starter', 'office'];
  }
  if (r === 'dev' || r === 'develop') {
    if (/blender|unity|unreal|ue|game|游戏/.test(s)) return ['gamedev', 'coding'];
    return ['coding', 'starter'];
  }
  if (r === 'creative' || r === 'create') {
    if (/pr|davinci|video|剪辑/.test(s)) return ['video', 'content'];
    if (/ps|figma|design|设计/.test(s)) return ['design', 'content'];
    return ['content', 'design'];
  }
  if (r === 'life' || r === 'learn') return ['companion', 'learn'];
  return ['starter'];
}

/** 导出：powershell / bash / json。JSON 同时带命令，方便分享。 */
export function curatedExport(bundle, format = 'json') {
  const commands = curatedCommands(bundle);
  if (format === 'powershell' || format === 'pwsh') {
    return "$ErrorActionPreference = 'Stop'\n" + commands.join('\n') + '\n';
  }
  if (format === 'bash' || format === 'sh') {
    return '#!/usr/bin/env bash\nset -euo pipefail\n' + commands.join('\n') + '\n';
  }
  return JSON.stringify({
    id: bundle.id,
    name: bundle.name,
    family: bundle.family,
    goal: bundle.goal,
    requires: bundle.requires,
    risk: bundle.risk,
    budget: bundle.budget,
    commands,
    steps: bundle.steps,
  }, null, 2) + '\n';
}
