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

const PLUGIN_DETAILS = {
  "@aiwayds/dsh-cron": {
    repo: "https://github.com/fan56/dsh-cron",
    detail: "dsh plugin: cron scheduling — bounded tasks with calendar & interval rules, delivered to live agents",
  },
  "@aryacode/dsh-engineering": {
    repo: "https://github.com/KonnectSuite/dsh-engineering",
    detail: "Engineering bundle: Studio 5000 L5X, FactoryTalk View ME, FactoryTalk Optix, MotionWorks IEC, DXF/DWG drawing previews and RSLogix 500/5 migration - one install, one row per toolch…",
  },
  "@chengxianglibra/dsh-data-analysis": {
    repo: "https://github.com/chengxianglibra/dsh-data-analysis",
    detail: "Marivo runtime, live Help, secure datasource execution and presentation delivery for DeepSeek Harness",
  },
  "@copylee/dsh-office": {
    repo: "https://github.com/copylee711/dsh-office",
    detail: "DeepSeek Harness Office 插件（Windows）：AI 直接在你打开的 Word / Excel / PowerPoint 里改文档，改动实时出现在窗口中，你可以同时编辑；读结构、批量编辑、渲染成图核对、保存。",
  },
  "@deepseek-ai/dsh-skill-office": {
    repo: "https://github.com/deepseek-ai/deepseek-harness",
    detail: "Bundled Word, PowerPoint, and Excel workflows and structural checks",
  },
  "@ebony-vinyl/dsh-our-free-model": {
    repo: "https://github.com/Ebony-Vinyl/dsh-our-free-model",
    detail: "Our Free Model — 在 dsh 里装上这个插件即可，无需登录、注册或填 API Key，就能使用包括 DeepSeek V4.1 Flash、Kimi K3 在内的前沿模型，桌面端另有 EAC 协付渠道；2.0 起接入 LobsterAI、Qoder、TRAE、Cline、Loomy、Raccoon、MiniMax、ZCode、Gemini 十…",
  },
  "@iflow-mcp/leancoderkavy-premiere-pro-mcp": {
    repo: "https://github.com/ppmcp/premiere-pro-mcp",
    detail: "MCP server for controlling Adobe Premiere Pro via CEP/ExtendScript — 269 tools for AI-driven video editing",
  },
  "@michengai/dsh-archive-manager": {
    repo: "https://github.com/MichengAI/dsh-archive-manager",
    detail: "归档、恢复、收藏和永久删除会话，并诊断损坏的会话日志。 · Archive, restore, favorite, and permanently delete sessions, and diagnose damaged session logs.",
  },
  "@michengai/dsh-code-review": {
    repo: "https://github.com/MichengAI/dsh-code-review",
    detail: "DSH Code Review — 为 DeepSeek Harness 提供 Codex 风格代码审查、原生独立子 Agent、灵活范围选择和中英文报告 · Codex-style code review with native independent agents, flexible scope selection, and bilingual repo…",
  },
  "@nanmicoder/dsh-agent-teams": {
    repo: "https://github.com/NanmiCoder/dsh-agent-teams",
    detail: "AgentTeams for DeepSeek Harness: multi-agent team collaboration (captain, members, tasks with dependencies, messaging) driven by natural language, with a tree monitor in the web GU…",
  },
  "@xbzbing/dsh-git-panel": {
    repo: "https://github.com/xbzbing/dsh-git-panel",
    detail: "DeepSeek Harness (dsh) plugin: an IDE-style Git panel in the Web GUI — branch/history overview, uncommitted changes with commit & amend, diff stats, and a zsh-style branch marker i…",
  },
  "@xmanrui/dsh-im": {
    repo: "https://github.com/xmanrui/dsh-im",
    detail: "把微信、飞书、企微、钉钉、QQ、Telegram、WhatsApp、Slack、Discord、Matrix接入DSH。 Connect Telegram, WhatsApp, Slack, Discord, Matrix, WeChat, Feishu, WeCom, DingTalk, and QQ to DSH.",
  },
  "autocad-mcp": {
    repo: "https://www.npmjs.com/package/autocad-mcp",
    detail: "AutoCAD .NET API MCP server：让 AI 编程工具读取/操作 AutoCAD；按项目 README 配置 AutoCAD 与 MCP 客户端。",
  },
  "davinci-resolve-mcp": {
    repo: "https://github.com/samuelgursky/davinci-resolve-mcp",
    detail: "NPM bootstrapper for the DaVinci Resolve MCP Server.",
  },
  "ds-bot": {
    repo: "https://github.com/Fei2411/DS-Bot",
    detail: "DS Bot: a team of long-lived Bots for DeepSeek Harness, with Main Bots, Bot-to-Bot messages and group chats",
  },
  "dsh-agent-compare": {
    repo: "https://github.com/lijiaqi-AI-Product-Manager/dsh-agent-compare",
    detail: "让同一想法，长出更多实现方案！在 DSH 主对话里比较回答、文件与网页，选风格，盲选或公开对比，再审查采用。Compare 2–4 answers, files or live pages in DeepSeek Harness (DSH) Desktop and Web, then review and adopt.",
  },
  "dsh-blender-plugin": {
    repo: "https://github.com/sixtysevenlf/dsh-blender-plugin",
    detail: "DSH × Blender 直连插件（v3.0.6，GUI 优先，无头备用）：15 个模型工具让 AI 直接驱动 Blender——视口/自定义视角、持久内核 Python、时间窗/帧序列观察、内环参数搜索、无头进程与热会话（see/watch/reset/preload/warmup）、作业层、事务回滚、配方库，以及 34 family / 228 op …",
  },
  "dsh-config-manager": {
    repo: "https://github.com/xiajiajun516/dsh-config-manager",
    detail: "Backup, restore, export, import, migrate and sync your DeepSeek Harness (DSH) configuration: settings, plugins, MCP servers, skills, agent presets and workspaces. One-click migrati…",
  },
  "dsh-connect-workbuddy": {
    repo: "https://github.com/dingminhua/dsh-connect-workbuddy",
    detail: "把本机登录的 WorkBuddy 模型（国内版与国际版）接入 DeepSeek Harness：每次刷新按上游目录自动读取每个模型的积分倍率，支持逐模型图片输入开关、多账号切换与账号池自动换号，并提供每日签到、卡片与输入框里的胶囊积分读数等只读积分概览。",
  },
  "dsh-cost-meter": {
    repo: "https://github.com/Han-1413141/dsh-cost-meter",
    detail: "DeepSeek Harness 会话费用统计插件:本会话成本、当日费用、历史记录与官方价格同步,支持多厂商多模型价格计费(内置 170+ 模型 ID 价格目录与自动匹配)、主流 Coding Plan 订阅额度查询与显示(16 家,含 WorkBuddy 官方积分、OpenDesign 工作区查询、含小米 MiMo Token Plan 控制台 Cooki…",
  },
  "dsh-excel-chat": {
    repo: "https://github.com/hccccc01333/dsh-excel-chat",
    detail: "Talk to Excel in DeepSeek Harness: read, edit, clean and report on spreadsheets by conversation. Re-checks every formula after each edit, repairs silent errors, and needs no local …",
  },
  "dsh-excel-reconcile": {
    repo: "https://github.com/PerryLink/dsh-excel-reconcile",
    detail: "按主键对齐两份 Excel/CSV 表，按容差逐字段比较，输出 Markdown 报告、JSON 结果与差异工作簿。",
  },
  "dsh-figma-mcp": {
    repo: "https://github.com/lubanqihao9875/dsh-figma-mcp",
    detail: "DSH 的 Figma MCP 一键连接插件，对话中粘贴链接，Agent 即可读写节点/图层/变量/样式，生成 React/Vue 代码，OAuth 安全登录，Token 本机存储，内置工作流指令和 Skill 引导使用",
  },
  "dsh-folia": {
    repo: "https://github.com/lehua-art/dsh-folia",
    detail: "dshAI：壁纸引擎 + AI 桌宠语音助手 + 多人设角色卡 + 皮肤/开机动画 + 能力市场，一站式桌面伴侣。",
  },
  "dsh-free-search": {
    repo: "https://github.com/DDDMUC/dsh-free-search",
    detail: "Free web search for DeepSeek Harness: 42 engines (Bing/DuckDuckGo/AnySearch/SearXNG/Exa/Tavily/Keenable/Firecrawl/Parallel/Brave/Zhipu/You.com keyless; Zhihu global/site via MCP an…",
  },
  "dsh-genui": {
    repo: "https://github.com/lhuans/dsh-genui",
    detail: "GenUI for DeepSeek Harness: interactive charts, forms, calculators, dashboards, and mini apps rendered inline in assistant replies, with actions that flow back to the model.",
  },
  "dsh-image-gen": {
    repo: "https://github.com/shanliuling/dsh-image-gen",
    detail: "Bring ChatGPT-like image generation to DeepSeek Harness — Gemini, OpenAI, Seedream, DashScope, local ComfyUI & more.",
  },
  "dsh-meme": {
    repo: "https://github.com/yyh-001/dsh-meme",
    detail: "DeepSeek Harness 表情包插件：输入框一键发图（图库/情绪多选筛选、悬浮大图预览）、多图库开关、情绪与关键词搜图、AI 学图，图库可从市场一键安装或导入/导出 ZIP。",
  },
  "dsh-mnemon": {
    repo: "https://github.com/omdsh-dev/dsh-mnemon",
    detail: "Composable, view-based context for DeepSeek Harness. Pluggable sources and strategies, with layered memory and self-evolving skills out of the box.",
  },
  "dsh-mobile": {
    repo: "https://github.com/saya-ch/dsh-mobile",
    detail: "DeepSeek Harness 移动端适配与安全访问插件，支持局域网、远程连接、Android App 和手机浏览器。",
  },
  "dsh-notify-me": {
    repo: "https://github.com/chromoany/dsh-notify-me",
    detail: "离开 DSH 页面也能收到提醒：需要你操作 / 后台回复完成时发系统通知、标题标记与提示音，支持审批快捷裁决与外部推送，Web 版与桌面版均可用。",
  },
  "dsh-pdf-mineru": {
    repo: "https://github.com/Yurzi/dsh-pdf-mineru",
    detail: "Read PDFs in DeepSeek Harness with MinerU (official cloud or self-hosted): bounded evidence reading, background parsing jobs, and local page verification.",
  },
  "dsh-pdf-translator": {
    repo: "https://github.com/csukingzq/dsh-pdf-translator",
    detail: "PDF2zh translation with optional local MinerU recognition for scanned PDFs",
  },
  "dsh-perm-gate": {
    repo: "https://github.com/drscrewdriver/dsh-perm-gate",
    detail: "DSH permission-gate for the DeepSeek Harness 0.1.5 line: a single self-sufficient, deterministic-first, fail-closed gate covering P0 hard-deny -> P1 session grant -> P2 static rule…",
  },
  "dsh-ppt": {
    repo: "https://github.com/STARDUSTLC666/dsh-ppt",
    detail: "DeepSeek Harness 大师级演示文稿引擎与工作台：内置三层首席艺术总监提示词与 SLOP-15 反空盒门禁，支持三模路由（有资料直出 / 零资料 8 域权威深研 / Mode C 本地多源融合+外源对标）、企业品牌宪章锁（SLOP-13/14）、41 种原生可编辑图谱、24 主题 / 20 标杆范本、整卡联动 PPTX 动效与 16:9 自适应内…",
  },
  "dsh-remote": {
    repo: "https://github.com/flymysql/dsh-remote",
    detail: "SSH remote workspaces for DeepSeek Harness: parallel projects across hosts, remote file browsing and editing, recursive search, terminals, Git diffs, and workspace-bound Agent tool…",
  },
  "dsh-speak-up": {
    repo: "https://github.com/Yuuyuko-uu/dsh-speak-up",
    detail: "主动搭话（dsh-speak-up）：DSH 插件。没人在跟她说话的时候，她也会自己起个话头 —— 按你设的间隔掷一次本地骰子（不花模型），掷中了就走 DSH 自己的一轮（人格、历史、工具、记忆全都是她自己的）。",
  },
  "dsh-sql": {
    repo: "https://github.com/STARDUSTLC666/dsh-sql",
    detail: "DeepSeek Harness 数据库插件：SQLite / MySQL / PostgreSQL 结构探查、限流查询与写操作审批。欢迎提交 issues 和 PR。",
  },
  "dsh-trust-check": {
    repo: "https://github.com/liuwenji007/dsh-trust-check",
    detail: "Static capability disclosure for DeepSeek Harness plugins: capabilities, injected prompts, install scripts, and provenance, each with file:line evidence. Facts, not a safety verdic…",
  },
  "dsh-unity-mcp-bridge": {
    repo: "https://github.com/xiake-1/dsh-unity-mcp-bridge",
    detail: "Opt-in Unity-MCP bridge for DeepSeek Harness: dormant by default, /unity-mcp-tools activates it, ships the 1.6.0 command catalog plus /unity-mcp-install, /unity-mcp-delete, /unity-…",
  },
  "dsh-unlag": {
    repo: "https://github.com/regrevia/dsh-unlag",
    detail: "DSH 桌面端自己的刷新按钮：改插件不用重启、开久了卡了也点一下，正在进行的会话不受影响。",
  },
  "dsh-unreal-mcp": {
    repo: "https://github.com/PeterTXPan/dsh-unreal-mcp",
    detail: "Unofficial DeepSeek Harness integration for Unreal Engine 5.8 Unreal MCP",
  },
  "dsh-video-storyboard": {
    repo: "https://github.com/SAOS-3624/dsh-video-storyboard",
    detail: "Turn a video into storyboard images you can cite: one frame per shot, cell size follows cut density (1/1 … 1/8), row-packed into as few images as possible, with a timestamped index…",
  },
  "dsh-vscode-connect": {
    repo: "https://github.com/mcdottok/dsh-vscode-connect",
    detail: "Desktop companion for DSH Coding Agent in VS Code. Continue the same workspace and conversation with automatic local Windows connection.",
  },
  "dsh-windows-mcp": {
    repo: "https://github.com/helloHub1212/dsh-windows-mcp",
    detail: "Windows desktop automation for DeepSeek Harness — plugs CursorTouch/Windows-MCP (screenshot, UI automation, input, clipboard, processes, registry) into DSH through the official MCP…",
  },
};

const step = (pkg, why, extra = {}) => {
  const meta = PLUGIN_DETAILS[pkg] || {};
  return { pkg, why, detail: meta.detail || why, repo: meta.repo || '', ...extra };
};

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
