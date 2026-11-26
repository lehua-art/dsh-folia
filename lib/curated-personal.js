/**
 * curated-personal.js — 「精选 → 个人工具」静态数据（60+ 项，12 类）。
 *
 * 纪律：
 *   · 只做展示：这些是**个人工具**（Docker / Windows / 自托管），不是 DSH 插件；
 *     页面只给仓库地址与 README 安装说明，不做逐条安装器、不扫安装路径/注册表；
 *   · 数据静态，不联网抓 GitHub；repo/license 来自项目公开仓库与交接清单；
 *   · `repos` 用于同类合并卡（如 *arr、备份四件套），detail 里列各仓库。
 */

export const PERSONAL_CATEGORIES = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'ai', label: 'AI' },
  { id: 'speech-doc', label: '语音文档' },
  { id: 'media', label: '相册影音' },
  { id: 'docs', label: '文档效率' },
  { id: 'notes', label: '笔记阅读' },
  { id: 'home', label: '家庭生活' },
  { id: 'ops', label: '自动化运维' },
  { id: 'backup', label: '备份文件' },
  { id: 'privacy', label: '隐私安全' },
  { id: 'finance', label: '财务' },
  { id: 'creative', label: '创作设计' },
  { id: 'dev', label: '开发' },
]);

const repoOf = (owner, name) => `https://github.com/${owner}/${name}`;

/**
 * @param {object} item
 * @param {string} item.id
 * @param {string} item.name
 * @param {string} item.category
 * @param {string} item.desc 一句话
 * @param {string} item.repo 主仓库
 * @param {string} item.license
 * @param {string} item.requires
 * @param {'low'|'medium'|'high'} [item.risk]
 * @param {string} [item.detail] 2–4 句
 * @param {{name:string,repo:string}[]} [item.repos] 同类合并卡里的各仓库
 */
const tool = (item) => {
  const repos = Array.isArray(item.repos) ? item.repos : [];
  const detail = item.detail || (repos.length
    ? `${item.desc}。同类可选：${repos.map((r) => r.name).join(' / ')}；安装方式以各自 README 为准。`
    : `${item.desc}。部署/前提：${item.requires}。许可：${item.license}。`);
  return {
    kind: 'oss-tool',
    id: item.id,
    name: item.name,
    category: item.category,
    desc: item.desc,
    detail,
    repo: item.repo,
    repos,
    license: item.license,
    requires: item.requires,
    risk: item.risk || 'low',
    homepage: item.homepage || item.repo,
  };
};

export const PERSONAL_TOOLS = Object.freeze([
  /* ── AI（13）────────────────────────────────────────────────────────── */
  tool({
    id: 'ollama', name: 'Ollama', category: 'ai',
    desc: '本机一条命令跑开源大模型，模型即拉即用',
    repo: repoOf('ollama', 'ollama'), license: 'MIT', requires: 'Windows / macOS / Linux',
    detail: 'Ollama 负责在本机拉起并托管开源模型，提供 OpenAI 兼容端点。适合先离线跑起来，再接 Open WebUI、SillyTavern 或 DSH 的模型配置。',
  }),
  tool({
    id: 'open-webui', name: 'Open WebUI', category: 'ai',
    desc: '给 Ollama/OpenAI 兼容端点套一个 ChatGPT 式界面',
    repo: repoOf('open-webui', 'open-webui'), license: 'Open WebUI License', requires: 'Docker（推荐）',
    risk: 'medium',
  }),
  tool({
    id: 'sillytavern', name: 'SillyTavern', category: 'ai',
    desc: '角色扮演 / 人设聊天前端，角色卡生态成熟',
    repo: repoOf('SillyTavern', 'SillyTavern'), license: 'AGPL-3.0', requires: 'Node.js；可选本地模型端点',
    risk: 'medium',
  }),
  tool({
    id: 'anythingllm', name: 'AnythingLLM', category: 'ai',
    desc: '拖文档就能问的本地知识库，桌面版可一键装',
    repo: repoOf('Mintplex-Labs', 'anything-llm'), license: 'MIT', requires: '桌面版或 Docker',
    risk: 'medium',
  }),
  tool({
    id: 'comfyui', name: 'ComfyUI', category: 'ai',
    desc: '节点式 AI 绘图 / 视频工作流，个人创作生态最大',
    repo: repoOf('comfyanonymous', 'ComfyUI'), license: 'GPL-3.0', requires: 'Windows 便携包 / Python；按显卡装模型',
    risk: 'medium',
  }),
  tool({
    id: 'gpt4all-jan', name: 'GPT4All / Jan', category: 'ai',
    desc: '本地模型桌面端，低配也能跑、离线可用',
    repo: repoOf('nomic-ai', 'gpt4all'), license: 'MIT / Apache-2.0', requires: 'Windows / macOS / Linux',
    repos: [
      { name: 'GPT4All', repo: repoOf('nomic-ai', 'gpt4all') },
      { name: 'Jan', repo: repoOf('janhq', 'jan') },
    ],
  }),
  tool({
    id: 'cherry-lobe', name: 'Cherry Studio / Lobe Chat / LibreChat', category: 'ai',
    desc: '三种多模型聊天界面，按偏好选一个',
    repo: repoOf('CherryHQ', 'cherry-studio'), license: 'Apache-2.0 / MIT', requires: '桌面端或 Docker；模型 Key/本地端点',
    repos: [
      { name: 'Cherry Studio', repo: repoOf('CherryHQ', 'cherry-studio') },
      { name: 'Lobe Chat', repo: repoOf('lobehub', 'lobe-chat') },
      { name: 'LibreChat', repo: repoOf('danny-avila', 'LibreChat') },
    ],
  }),
  tool({
    id: 'open-interpreter', name: 'Open Interpreter', category: 'ai',
    desc: '让模型操作本机文件与代码，注意权限边界',
    repo: repoOf('OpenInterpreter', 'open-interpreter'), license: 'AGPL-3.0', requires: 'Python；建议在隔离目录/容器里运行',
    risk: 'high',
    detail: 'Open Interpreter 把自然语言变成在本机执行的代码/命令，能直接读写文件。个人自动化很强，但没有沙箱时风险高；建议先在虚拟机或只读目录里试。',
  }),
  tool({
    id: 'ai-coding', name: 'Continue / Cline / Aider', category: 'ai',
    desc: '编辑器/终端里的 AI 编程助手，可接本地模型',
    repo: repoOf('continuedev', 'continue'), license: 'Apache-2.0', requires: 'VS Code / JetBrains / 终端；模型端点',
    repos: [
      { name: 'Continue', repo: repoOf('continuedev', 'continue') },
      { name: 'Cline', repo: repoOf('cline', 'cline') },
      { name: 'Aider', repo: repoOf('Aider-AI', 'aider') },
    ],
  }),
  tool({
    id: 'ragflow-dify', name: 'RAGFlow / Dify / Flowise / Langflow', category: 'ai',
    desc: '自建 RAG、工作流与 Agent 的可视化平台',
    repo: repoOf('infiniflow', 'ragflow'), license: 'Apache-2.0', requires: 'Docker（多数需要）；模型 Key/本地端点',
    risk: 'medium',
    repos: [
      { name: 'RAGFlow', repo: repoOf('infiniflow', 'ragflow') },
      { name: 'Dify', repo: repoOf('langgenius', 'dify') },
      { name: 'Flowise', repo: repoOf('FlowiseAI', 'Flowise') },
      { name: 'Langflow', repo: repoOf('langflow-ai', 'langflow') },
    ],
  }),
  tool({
    id: 'khoj', name: 'Khoj', category: 'ai',
    desc: '接笔记/文档/网页的个人 AI 第二大脑',
    repo: repoOf('khoj-ai', 'khoj'), license: 'AGPL-3.0', requires: 'Docker 或桌面端；模型 Key/本地端点',
    risk: 'medium',
  }),
  tool({
    id: 'letta-mem', name: 'Letta / Mem0 / LightRAG', category: 'ai',
    desc: '给个人助手做长期记忆与检索的三条路线',
    repo: repoOf('letta-ai', 'letta'), license: 'Apache-2.0 / MIT', requires: 'Python / Docker；数据库（按项目）',
    risk: 'medium',
    repos: [
      { name: 'Letta', repo: repoOf('letta-ai', 'letta') },
      { name: 'Mem0', repo: repoOf('mem0ai', 'mem0') },
      { name: 'LightRAG', repo: repoOf('HKUDS', 'LightRAG') },
    ],
  }),
  tool({
    id: 'crawl-firecrawl', name: 'Crawl4AI / Firecrawl', category: 'ai',
    desc: '把网页抓成干净的 LLM 可用数据',
    repo: repoOf('unclecode', 'crawl4ai'), license: 'Apache-2.0 / AGPL-3.0', requires: 'Python / Docker；遵守目标站点条款',
    risk: 'medium',
    repos: [
      { name: 'Crawl4AI', repo: repoOf('unclecode', 'crawl4ai') },
      { name: 'Firecrawl', repo: repoOf('mendableai', 'firecrawl') },
    ],
  }),

  /* ── 语音文档（7）──────────────────────────────────────────────────── */
  tool({
    id: 'whisper', name: 'Whisper', category: 'speech-doc',
    desc: '本地语音转写，离线且准确，已有大量 GUI',
    repo: repoOf('openai', 'whisper'), license: 'MIT', requires: 'Python / CLI；可配 GPU',
    detail: 'OpenAI Whisper 是本地语音识别模型，支持多语言；可通过命令行或第三方 GUI 使用。模型文件需首次下载，CPU 也能跑但较慢。',
  }),
  tool({
    id: 'gpt-sovits', name: 'GPT-SoVITS', category: 'speech-doc',
    desc: '少样本语音克隆 / TTS，个人玩声音的首选',
    repo: repoOf('RVC-Boss', 'GPT-SoVITS'), license: 'MIT（代码；模型另看）', requires: 'Python + GPU 推荐；录音样本',
    risk: 'medium',
  }),
  tool({
    id: 'cosyvoice', name: 'CosyVoice', category: 'speech-doc',
    desc: '多语言 TTS / 声音克隆，阿里开源',
    repo: repoOf('FunAudioLLM', 'CosyVoice'), license: 'Apache-2.0', requires: 'Python + GPU 推荐；模型下载',
    risk: 'medium',
  }),
  tool({
    id: 'mineru', name: 'MinerU', category: 'speech-doc',
    desc: 'PDF / 扫描件 → Markdown，论文与报告解析强',
    repo: repoOf('opendatalab', 'MinerU'), license: 'AGPL-3.0（看 LICENSE）', requires: 'Python / Docker；GPU 可选',
    risk: 'medium',
  }),
  tool({
    id: 'markitdown', name: 'MarkItDown', category: 'speech-doc',
    desc: '各种文档 → Markdown 的轻量 CLI',
    repo: repoOf('microsoft', 'markitdown'), license: 'MIT', requires: 'Python 3.10+',
  }),
  tool({
    id: 'docling-marker', name: 'Docling / Marker', category: 'speech-doc',
    desc: '文档结构化与 PDF → Markdown 的另一条路线',
    repo: repoOf('docling-project', 'docling'), license: 'MIT / GPL-3.0', requires: 'Python；模型下载；GPU 可选',
    repos: [
      { name: 'Docling', repo: repoOf('docling-project', 'docling') },
      { name: 'Marker', repo: repoOf('VikParuchuri', 'marker') },
    ],
  }),
  tool({
    id: 'ocrmypdf', name: 'OCRmyPDF', category: 'speech-doc',
    desc: '给扫描 PDF 加可检索文字层',
    repo: repoOf('ocrmypdf', 'OCRmyPDF'), license: 'MPL-2.0', requires: 'Python；Tesseract / Ghostscript',
  }),

  /* ── 相册影音（8）──────────────────────────────────────────────────── */
  tool({
    id: 'immich', name: 'Immich', category: 'media',
    desc: '自托管相册，手机自动备份，替代 iCloud/Google Photos',
    repo: repoOf('immich-app', 'immich'), license: 'AGPL-3.0', requires: 'Docker / NAS；手机 App',
    risk: 'medium',
  }),
  tool({
    id: 'photoprism', name: 'PhotoPrism / LibrePhotos / Ente', category: 'media',
    desc: 'Immich 之外的三种相册方案',
    repo: repoOf('photoprism', 'photoprism'), license: 'AGPL-3.0', requires: 'Docker / NAS；手机/桌面客户端',
    risk: 'medium',
    repos: [
      { name: 'PhotoPrism', repo: repoOf('photoprism', 'photoprism') },
      { name: 'LibrePhotos', repo: repoOf('LibrePhotos', 'librephotos') },
      { name: 'Ente', repo: repoOf('ente-io', 'ente') },
    ],
  }),
  tool({
    id: 'jellyfin', name: 'Jellyfin', category: 'media',
    desc: '无订阅、全平台客户端的自托管影音库',
    repo: repoOf('jellyfin', 'jellyfin'), license: 'GPL-2.0', requires: 'Docker / NAS；客户端',
    risk: 'medium',
  }),
  tool({
    id: 'music-server', name: 'Navidrome / Audiobookshelf', category: 'media',
    desc: '自托管音乐流媒体与有声书/播客库',
    repo: repoOf('navidrome', 'navidrome'), license: 'GPL-3.0', requires: 'Docker / NAS；音乐/有声书目录',
    risk: 'medium',
    repos: [
      { name: 'Navidrome', repo: repoOf('navidrome', 'navidrome') },
      { name: 'Audiobookshelf', repo: repoOf('advplyr', 'audiobookshelf') },
    ],
  }),
  tool({
    id: 'comics', name: 'Kavita / Komga', category: 'media',
    desc: '漫画/电子书服务器，带阅读进度',
    repo: repoOf('Kareadita', 'Kavita'), license: 'GPL-3.0 / MIT', requires: 'Docker / NAS；漫画目录',
    risk: 'medium',
    repos: [
      { name: 'Kavita', repo: repoOf('Kareadita', 'Kavita') },
      { name: 'Komga', repo: repoOf('gotson', 'komga') },
    ],
  }),
  tool({
    id: 'requests', name: 'Overseerr / Jellyseerr', category: 'media',
    desc: '影视请求与审批，接 Jellyfin/Plex/*arr',
    repo: repoOf('sct', 'overseerr'), license: 'MIT', requires: 'Docker；已有媒体库与 *arr',
    risk: 'medium',
    repos: [
      { name: 'Overseerr', repo: repoOf('sct', 'overseerr') },
      { name: 'Jellyseerr', repo: repoOf('Fallenbagel', 'jellyseerr') },
    ],
  }),
  tool({
    id: 'arr-stack', name: '*arr 媒体自动化套件', category: 'media',
    desc: 'Sonarr/Radarr/Prowlarr/Bazarr + qBittorrent 一条龙',
    repo: repoOf('Sonarr', 'Sonarr'), license: 'GPL-3.0 / GPL-2.0', requires: 'Docker 推荐；索引器/下载器；遵守版权',
    risk: 'high',
    detail: '组合：Sonarr（剧集）、Radarr（电影）、Prowlarr（索引器）、Bazarr（字幕）、qBittorrent（下载）。每个都需单独部署并在 Web UI 里互连；只用于你有权获取的内容。',
    repos: [
      { name: 'Sonarr', repo: repoOf('Sonarr', 'Sonarr') },
      { name: 'Radarr', repo: repoOf('Radarr', 'Radarr') },
      { name: 'Prowlarr', repo: repoOf('Prowlarr', 'Prowlarr') },
      { name: 'Bazarr', repo: repoOf('morpheus65535', 'bazarr') },
      { name: 'qBittorrent', repo: repoOf('qbittorrent', 'qBittorrent') },
    ],
  }),
  tool({
    id: 'game-stream', name: 'Sunshine + Moonlight', category: 'media',
    desc: '自建游戏串流：主机编码，手机/电视解码',
    repo: repoOf('LizardByte', 'Sunshine'), license: 'GPL-3.0', requires: 'NVIDIA/AMD/Intel 编码；Moonlight 客户端',
    risk: 'medium',
    repos: [
      { name: 'Sunshine', repo: repoOf('LizardByte', 'Sunshine') },
      { name: 'Moonlight', repo: repoOf('moonlight-stream', 'moonlight-qt') },
    ],
  }),

  /* ── 文档效率（5）──────────────────────────────────────────────────── */
  tool({
    id: 'paperless-ngx', name: 'Paperless-ngx', category: 'docs',
    desc: '家庭票据/合同归档 + OCR + 全文检索',
    repo: repoOf('paperless-ngx', 'paperless-ngx'), license: 'GPL-3.0', requires: 'Docker；扫描件/邮箱导入',
    risk: 'medium',
  }),
  tool({
    id: 'stirling-pdf', name: 'Stirling-PDF', category: 'docs',
    desc: '本地 PDF 工具箱：合并/拆分/OCR/签名',
    repo: repoOf('Stirling-Tools', 'Stirling-PDF'), license: 'MIT', requires: 'Docker 或桌面版',
    risk: 'medium',
  }),
  tool({
    id: 'documenso', name: 'Documenso', category: 'docs',
    desc: '自建电子签，替代 DocuSign 的基础流程',
    repo: repoOf('documenso', 'documenso'), license: 'AGPL-3.0', requires: 'Docker + 数据库；邮件服务',
    risk: 'medium',
  }),
  tool({
    id: 'ebooks', name: 'Calibre-Web / KOReader', category: 'docs',
    desc: '电子书库与阅读器，支持推送/同步',
    repo: repoOf('janeczku', 'calibre-web'), license: 'GPL-3.0 / AGPL-3.0', requires: 'Docker / 阅读器设备；书库目录',
    risk: 'medium',
    repos: [
      { name: 'Calibre-Web', repo: repoOf('janeczku', 'calibre-web') },
      { name: 'KOReader', repo: repoOf('koreader', 'koreader') },
    ],
  }),
  tool({
    id: 'study', name: 'Anki / Zotero / JabRef / Kiwix', category: 'docs',
    desc: '记忆、文献、离线知识四件套',
    repo: repoOf('ankitects', 'anki'), license: 'AGPL-3.0 / MIT / GPL-3.0', requires: '桌面端；同步/离线包按项目',
    repos: [
      { name: 'Anki', repo: repoOf('ankitects', 'anki') },
      { name: 'Zotero', repo: repoOf('zotero', 'zotero') },
      { name: 'JabRef', repo: repoOf('JabRef', 'jabref') },
      { name: 'Kiwix', repo: repoOf('kiwix', 'kiwix-desktop') },
    ],
  }),

  /* ── 笔记阅读（9）──────────────────────────────────────────────────── */
  tool({
    id: 'siyuan', name: '思源笔记', category: 'notes',
    desc: '块级笔记、本地优先、中文友好',
    repo: repoOf('siyuan-note', 'siyuan'), license: 'AGPL-3.0', requires: '桌面端 / Docker',
  }),
  tool({
    id: 'logseq', name: 'Logseq', category: 'notes',
    desc: '大纲/双链/本地 Markdown 笔记',
    repo: repoOf('logseq', 'logseq'), license: 'AGPL-3.0', requires: '桌面端 / 移动端',
  }),
  tool({
    id: 'joplin-trilium', name: 'Joplin / Trilium', category: 'notes',
    desc: '跨平台笔记与层级知识库',
    repo: repoOf('laurent22', 'joplin'), license: 'AGPL-3.0', requires: '桌面/移动端；可选同步服务',
    repos: [
      { name: 'Joplin', repo: repoOf('laurent22', 'joplin') },
      { name: 'Trilium', repo: repoOf('TriliumNext', 'Trilium') },
    ],
  }),
  tool({
    id: 'excalidraw', name: 'Excalidraw', category: 'notes',
    desc: '手绘风白板，本地/自托管都行',
    repo: repoOf('excalidraw', 'excalidraw'), license: 'MIT', requires: '浏览器 / Docker',
  }),
  tool({
    id: 'affine-appflowy', name: 'AFFiNE / AppFlowy', category: 'notes',
    desc: 'Notion 风格的开源替代',
    repo: repoOf('toeverything', 'AFFiNE'), license: 'MIT / AGPL-3.0', requires: '桌面端 / Docker',
    risk: 'medium',
    repos: [
      { name: 'AFFiNE', repo: repoOf('toeverything', 'AFFiNE') },
      { name: 'AppFlowy', repo: repoOf('AppFlowy-IO', 'AppFlowy') },
    ],
  }),
  tool({
    id: 'memos-blinko', name: 'Memos / Blinko', category: 'notes',
    desc: '轻量碎片笔记/快速记录',
    repo: repoOf('usememos', 'memos'), license: 'MIT / AGPL-3.0', requires: 'Docker / 桌面端',
    risk: 'medium',
    repos: [
      { name: 'Memos', repo: repoOf('usememos', 'memos') },
      { name: 'Blinko', repo: repoOf('blinko-space', 'blinko') },
    ],
  }),
  tool({
    id: 'karakeep', name: 'Karakeep', category: 'notes',
    desc: '书签/稍后读 + AI 自动标签',
    repo: repoOf('karakeep-app', 'karakeep'), license: 'AGPL-3.0', requires: 'Docker；可选 AI Key',
    risk: 'medium',
  }),
  tool({
    id: 'linkwarden', name: 'Linkwarden / Linkding', category: 'notes',
    desc: '书签收藏、全文归档与检索',
    repo: repoOf('linkwarden', 'linkwarden'), license: 'AGPL-3.0 / MIT', requires: 'Docker / 自托管',
    risk: 'medium',
    repos: [
      { name: 'Linkwarden', repo: repoOf('linkwarden', 'linkwarden') },
      { name: 'Linkding', repo: repoOf('sissbruecker', 'linkding') },
    ],
  }),
  tool({
    id: 'rss', name: 'FreshRSS / Miniflux / Folo / RSSHub', category: 'notes',
    desc: 'RSS 阅读与聚合，自己掌控信息源',
    repo: repoOf('FreshRSS', 'FreshRSS'), license: 'AGPL-3.0 / MIT', requires: 'Docker / PHP；阅读客户端',
    risk: 'medium',
    repos: [
      { name: 'FreshRSS', repo: repoOf('FreshRSS', 'FreshRSS') },
      { name: 'Miniflux', repo: repoOf('miniflux', 'v2') },
      { name: 'Folo', repo: repoOf('RSSNext', 'Folo') },
      { name: 'RSSHub', repo: repoOf('DIYgod', 'RSSHub') },
    ],
  }),

  /* ── 家庭生活（6）──────────────────────────────────────────────────── */
  tool({
    id: 'home-assistant', name: 'Home Assistant', category: 'home',
    desc: '智能家居中枢，个人家庭首选',
    repo: repoOf('home-assistant', 'core'), license: 'Apache-2.0', requires: 'Docker / HAOS；智能设备',
    risk: 'medium',
  }),
  tool({
    id: 'frigate', name: 'Frigate', category: 'home',
    desc: '本地 NVR + AI 目标检测，不传云',
    repo: repoOf('blakeblackshear', 'frigate'), license: 'MIT', requires: 'Docker；摄像头；可选 Coral GPU',
    risk: 'medium',
  }),
  tool({
    id: 'esphome', name: 'ESPHome', category: 'home',
    desc: '用 YAML 刷 ESP32，把普通设备接进 Home Assistant',
    repo: repoOf('esphome', 'esphome'), license: 'MIT', requires: 'Python / Docker；ESP32 设备',
    risk: 'medium',
  }),
  tool({
    id: 'mealie-tandoor', name: 'Mealie / Tandoor', category: 'home',
    desc: '家庭食谱库：导入网页菜谱、做购物清单',
    repo: repoOf('mealie-recipes', 'mealie'), license: 'MIT', requires: 'Docker',
    risk: 'medium',
    repos: [
      { name: 'Mealie', repo: repoOf('mealie-recipes', 'mealie') },
      { name: 'Tandoor', repo: repoOf('TandoorRecipes', 'recipes') },
    ],
  }),
  tool({
    id: 'grocy-homebox', name: 'Grocy / HomeBox', category: 'home',
    desc: '库存、购物清单与家中物品/保修管理',
    repo: repoOf('grocy', 'grocy'), license: 'MIT', requires: 'Docker / PHP',
    risk: 'medium',
    repos: [
      { name: 'Grocy', repo: repoOf('grocy', 'grocy') },
      { name: 'HomeBox', repo: repoOf('hay-kot', 'homebox') },
    ],
  }),
  tool({
    id: 'monica-baby', name: 'Monica / Baby Buddy / wger', category: 'home',
    desc: '个人 CRM、育儿记录与健身计划',
    repo: repoOf('monicahq', 'monica'), license: 'AGPL-3.0', requires: 'Docker / PHP；按项目',
    risk: 'medium',
    repos: [
      { name: 'Monica', repo: repoOf('monicahq', 'monica') },
      { name: 'Baby Buddy', repo: repoOf('babybuddy', 'babybuddy') },
      { name: 'wger', repo: repoOf('wger-project', 'wger') },
    ],
  }),

  /* ── 自动化运维（8）────────────────────────────────────────────────── */
  tool({
    id: 'n8n', name: 'n8n', category: 'ops',
    desc: '节点式自动化工作流，接 API 神器',
    repo: repoOf('n8n-io', 'n8n'), license: 'Sustainable Use（非 OSI）', requires: 'Docker / Node.js',
    risk: 'medium',
    detail: 'n8n 用节点拼自动化，把 Webhook、数据库、通知、AI 串起来。自托管个人使用免费，但许可是 Sustainable Use，不是标准开源；商用/再分发前先读许可证。',
  }),
  tool({
    id: 'uptime-gatus', name: 'Uptime Kuma / Gatus', category: 'ops',
    desc: '网站/服务可用性监控与通知',
    repo: repoOf('louislam', 'uptime-kuma'), license: 'MIT / Apache-2.0', requires: 'Docker / 单二进制',
    risk: 'medium',
    repos: [
      { name: 'Uptime Kuma', repo: repoOf('louislam', 'uptime-kuma') },
      { name: 'Gatus', repo: repoOf('TwiN', 'gatus') },
    ],
  }),
  tool({
    id: 'changedetection', name: 'Changedetection.io', category: 'ops',
    desc: '网页变化监控（补货/公告/价格）',
    repo: repoOf('dgtlmoon', 'changedetection.io'), license: 'Apache-2.0', requires: 'Docker；目标网页',
    risk: 'medium',
  }),
  tool({
    id: 'docker-mon', name: 'Dozzle / Beszel / Glances', category: 'ops',
    desc: '容器日志、资源监控与系统概览',
    repo: repoOf('amir20', 'dozzle'), license: 'MIT / LGPL-3.0', requires: 'Docker / Python',
    risk: 'medium',
    repos: [
      { name: 'Dozzle', repo: repoOf('amir20', 'dozzle') },
      { name: 'Beszel', repo: repoOf('henrygd', 'beszel') },
      { name: 'Glances', repo: repoOf('nicolargo', 'glances') },
    ],
  }),
  tool({
    id: 'dashboard', name: 'Homepage / Dashy / Homarr', category: 'ops',
    desc: '自托管导航面板，把手上的服务收进一页',
    repo: repoOf('gethomepage', 'homepage'), license: 'GPL-3.0 / MIT', requires: 'Docker',
    risk: 'medium',
    repos: [
      { name: 'Homepage', repo: repoOf('gethomepage', 'homepage') },
      { name: 'Dashy', repo: repoOf('Lissy93', 'dashy') },
      { name: 'Homarr', repo: repoOf('homarr-labs', 'homarr') },
    ],
  }),
  tool({
    id: 'app-manager', name: 'CasaOS / Runtipi / Dockge / Portainer', category: 'ops',
    desc: '在 NAS/小主机上装和管理 Docker 应用',
    repo: repoOf('IceWhaleTech', 'CasaOS'), license: 'Apache-2.0 / GPL-3.0 / MIT / Zlib', requires: 'Docker；Linux 主机',
    risk: 'medium',
    repos: [
      { name: 'CasaOS', repo: repoOf('IceWhaleTech', 'CasaOS') },
      { name: 'Runtipi', repo: repoOf('runtipi', 'runtipi') },
      { name: 'Dockge', repo: repoOf('louislam', 'dockge') },
      { name: 'Portainer', repo: repoOf('portainer', 'portainer') },
    ],
  }),
  tool({
    id: 'proxy-auth', name: 'Caddy / Traefik / NPM + Authelia/Authentik', category: 'ops',
    desc: '反向代理、自动 HTTPS 与自建 SSO',
    repo: repoOf('caddyserver', 'caddy'), license: 'Apache-2.0 / MIT', requires: 'Docker；域名/证书；上游服务',
    risk: 'high',
    detail: '反代层可用 Caddy、Traefik 或 Nginx Proxy Manager；登录门户可用 Authelia 或 Authentik。暴露到公网前必须配好 HTTPS、强密码与二次验证，high 风险。',
    repos: [
      { name: 'Caddy', repo: repoOf('caddyserver', 'caddy') },
      { name: 'Traefik', repo: repoOf('traefik', 'traefik') },
      { name: 'Nginx Proxy Manager', repo: repoOf('NginxProxyManager', 'nginx-proxy-manager') },
      { name: 'Authelia', repo: repoOf('authelia', 'authelia') },
      { name: 'Authentik', repo: repoOf('goauthentik', 'authentik') },
    ],
  }),
  tool({
    id: 'notify-update', name: 'Watchtower / Diun + Apprise/ntfy/Gotify', category: 'ops',
    desc: '容器更新提醒与统一通知通道',
    repo: repoOf('containrrr', 'watchtower'), license: 'Apache-2.0 / MIT', requires: 'Docker；通知渠道',
    risk: 'medium',
    detail: '更新侧用 Watchtower（自动/提醒）或 Diun（只提醒）；通知侧用 Apprise、ntfy 或 Gotify。自动更新前先备份，避免把可回滚的服务直接升级坏。',
    repos: [
      { name: 'Watchtower', repo: repoOf('containrrr', 'watchtower') },
      { name: 'Diun', repo: repoOf('crazy-max', 'diun') },
      { name: 'Apprise', repo: repoOf('caronc', 'apprise') },
      { name: 'ntfy', repo: repoOf('binwiederhier', 'ntfy') },
      { name: 'Gotify', repo: repoOf('gotify', 'server') },
    ],
  }),

  /* ── 备份文件（4）──────────────────────────────────────────────────── */
  tool({
    id: 'backup', name: 'Kopia / Restic / Duplicati / Borg', category: 'backup',
    desc: '个人备份四件套：去重、加密、增量',
    repo: repoOf('kopia', 'kopia'), license: 'Apache-2.0 / BSD / LGPL', requires: '桌面端 / CLI；备份目标盘/云',
    risk: 'medium',
    detail: 'Kopia、Restic、Duplicati、Borg 都能做加密增量备份；选一个坚持用。先做一份本地备份并实际恢复一次，再考虑云备份。',
    repos: [
      { name: 'Kopia', repo: repoOf('kopia', 'kopia') },
      { name: 'Restic', repo: repoOf('restic', 'restic') },
      { name: 'Duplicati', repo: repoOf('duplicati', 'duplicati') },
      { name: 'Borg', repo: repoOf('borgbackup', 'borg') },
    ],
  }),
  tool({
    id: 'rclone', name: 'Rclone', category: 'backup',
    desc: '几十种云盘的挂载、同步与加密',
    repo: repoOf('rclone', 'rclone'), license: 'MIT', requires: 'CLI；云盘授权',
    detail: 'Rclone 支持大量对象存储/网盘，可挂载或单向同步。配置时先用 `rclone check` 验证，再设为定时任务。',
  }),
  tool({
    id: 'filebrowser', name: 'Filebrowser / Filestash / Alist', category: 'backup',
    desc: '自建文件管理与网盘聚合',
    repo: repoOf('filebrowser', 'filebrowser'), license: 'Apache-2.0 / AGPL-3.0', requires: 'Docker / 单二进制',
    risk: 'medium',
    repos: [
      { name: 'Filebrowser', repo: repoOf('filebrowser', 'filebrowser') },
      { name: 'Filestash', repo: repoOf('mickael-kerjean', 'filestash') },
      { name: 'Alist', repo: repoOf('AlistGo', 'alist') },
    ],
  }),
  tool({
    id: 'sync-send', name: 'Syncthing / LocalSend / PairDrop', category: 'backup',
    desc: '点对点同步与局域网互传，无账号无云',
    repo: repoOf('syncthing', 'syncthing'), license: 'MPL-2.0 / Apache-2.0 / GPL-3.0', requires: '桌面/手机客户端；同一局域网（LocalSend/PairDrop）',
    repos: [
      { name: 'Syncthing', repo: repoOf('syncthing', 'syncthing') },
      { name: 'LocalSend', repo: repoOf('localsend', 'localsend') },
      { name: 'PairDrop', repo: repoOf('schlagmichdoch', 'PairDrop') },
    ],
  }),

  /* ── 隐私安全（4）──────────────────────────────────────────────────── */
  tool({
    id: 'vault', name: 'Vaultwarden / KeePassXC / 2FAuth', category: 'privacy',
    desc: '自托管密码库与本地 2FA',
    repo: repoOf('dani-garcia', 'vaultwarden'), license: 'AGPL-3.0 / GPL-3.0', requires: 'Docker / 桌面客户端；备份密钥',
    risk: 'medium',
    detail: 'Vaultwarden 是轻量 Bitwarden 服务端，KeePassXC 是纯本地密码库，2FAuth 管双因素码。无论选哪个，都要离线备份主密码/恢复码。',
    repos: [
      { name: 'Vaultwarden', repo: repoOf('dani-garcia', 'vaultwarden') },
      { name: 'KeePassXC', repo: repoOf('keepassxreboot', 'keepassxc') },
      { name: '2FAuth', repo: repoOf('Bubka', '2FAuth') },
    ],
  }),
  tool({
    id: 'adguard', name: 'AdGuard Home / Pi-hole / Blocky', category: 'privacy',
    desc: '全网 DNS 去广告与跟踪拦截',
    repo: repoOf('AdguardTeam', 'AdGuardHome'), license: 'GPL-3.0 / MIT / Apache-2.0', requires: 'Docker / 小主机；路由器 DNS 指向它',
    risk: 'medium',
    repos: [
      { name: 'AdGuard Home', repo: repoOf('AdguardTeam', 'AdGuardHome') },
      { name: 'Pi-hole', repo: repoOf('pi-hole', 'pi-hole') },
      { name: 'Blocky', repo: repoOf('0xERR0R', 'blocky') },
    ],
  }),
  tool({
    id: 'vpn', name: 'WireGuard / Headscale / Netbird', category: 'privacy',
    desc: '自建组网，远程访问家里设备',
    repo: repoOf('WireGuard', 'wireguard-tools'), license: 'GPL-2.0 / BSD-3-Clause / AGPL-3.0', requires: '服务器/路由器；端口与密钥',
    risk: 'high',
    detail: 'WireGuard 做点对点隧道，Headscale 是 Tailscale 控制面的自托管实现，Netbird 提供更完整的组网。暴露端口前先确认防火墙与密钥管理。',
    repos: [
      { name: 'WireGuard', repo: repoOf('WireGuard', 'wireguard-tools') },
      { name: 'Headscale', repo: repoOf('juanfont', 'headscale') },
      { name: 'Netbird', repo: repoOf('netbirdio', 'netbird') },
    ],
  }),
  tool({
    id: 'searx', name: 'SearXNG / Perplexica', category: 'privacy',
    desc: '自建元搜索与 AI 搜索，减少追踪',
    repo: repoOf('searxng', 'searxng'), license: 'AGPL-3.0 / MIT', requires: 'Docker / Python；可选模型 Key',
    risk: 'medium',
    repos: [
      { name: 'SearXNG', repo: repoOf('searxng', 'searxng') },
      { name: 'Perplexica', repo: repoOf('ItzCrazyKns', 'Perplexica') },
    ],
  }),

  /* ── 财务（3）──────────────────────────────────────────────────────── */
  tool({
    id: 'budget', name: 'Actual Budget / Firefly III / Ghostfolio', category: 'finance',
    desc: '本地优先记账、预算与投资组合',
    repo: repoOf('actualbudget', 'actual'), license: 'MIT / AGPL-3.0', requires: '桌面端 / Docker；账本数据',
    risk: 'medium',
    repos: [
      { name: 'Actual Budget', repo: repoOf('actualbudget', 'actual') },
      { name: 'Firefly III', repo: repoOf('firefly-iii', 'firefly-iii') },
      { name: 'Ghostfolio', repo: repoOf('ghostfolio', 'ghostfolio') },
    ],
  }),
  tool({
    id: 'ledger', name: 'Beancount + Fava / GnuCash / HomeBank', category: 'finance',
    desc: '复式记账，账本在自己手里',
    repo: repoOf('beancount', 'beancount'), license: 'GPL-2.0 / MIT / GPL-2.0', requires: '桌面端 / Python；账本文件',
    repos: [
      { name: 'Beancount', repo: repoOf('beancount', 'beancount') },
      { name: 'Fava', repo: repoOf('beancount', 'fava') },
      { name: 'GnuCash', repo: repoOf('Gnucash', 'gnucash') },
      { name: 'HomeBank', repo: repoOf('homebank', 'homebank') },
    ],
  }),
  tool({
    id: 'portfolio', name: 'Portfolio Performance', category: 'finance',
    desc: '桌面端投资组合跟踪与收益分析',
    repo: repoOf('portfolio-performance', 'portfolio'), license: 'EPL-1.0', requires: 'Windows / macOS / Linux',
  }),

  /* ── 创作设计（5）──────────────────────────────────────────────────── */
  tool({
    id: 'penpot', name: 'Penpot', category: 'creative',
    desc: '开源 Figma 替代，浏览器里做设计与原型',
    repo: repoOf('penpot', 'penpot'), license: 'MPL-2.0', requires: 'Docker / 官方托管',
    risk: 'medium',
  }),
  tool({
    id: 'raster-vector', name: 'Krita / GIMP / Inkscape', category: 'creative',
    desc: '绘画、修图与矢量设计三件套',
    repo: repoOf('KDE', 'krita'), license: 'GPL-3.0 / GPL-2.0', requires: '桌面端',
    repos: [
      { name: 'Krita', repo: repoOf('KDE', 'krita') },
      { name: 'GIMP', repo: repoOf('GNOME', 'gimp') },
      { name: 'Inkscape', repo: repoOf('inkscape', 'inkscape') },
    ],
  }),
  tool({
    id: 'blender-cad', name: 'Blender / FreeCAD / OpenSCAD / KiCad', category: 'creative',
    desc: '3D、CAD、参数建模与 PCB 设计',
    repo: repoOf('blender', 'blender'), license: 'GPL-3.0 / LGPL-2.1 / GPL-2.0 / GPL-3.0', requires: '桌面端；按项目装插件/库',
    risk: 'medium',
    repos: [
      { name: 'Blender', repo: repoOf('blender', 'blender') },
      { name: 'FreeCAD', repo: repoOf('FreeCAD', 'FreeCAD') },
      { name: 'OpenSCAD', repo: repoOf('openscad', 'openscad') },
      { name: 'KiCad', repo: repoOf('KiCad', 'kicad-source-mirror') },
    ],
  }),
  tool({
    id: 'slicer', name: 'OrcaSlicer / PrusaSlicer / Cura', category: 'creative',
    desc: '3D 打印切片，按打印机选一个',
    repo: repoOf('SoftFever', 'OrcaSlicer'), license: 'AGPL-3.0 / LGPL-3.0', requires: '桌面端；打印机配置',
    repos: [
      { name: 'OrcaSlicer', repo: repoOf('SoftFever', 'OrcaSlicer') },
      { name: 'PrusaSlicer', repo: repoOf('prusa3d', 'PrusaSlicer') },
      { name: 'Cura', repo: repoOf('Ultimaker', 'Cura') },
    ],
  }),
  tool({
    id: 'media-suite', name: 'Kdenlive / Shotcut / Audacity / Ardour / LMMS / OBS / Upscayl / Rembg', category: 'creative',
    desc: '剪辑、音频、直播、超分与抠图工作台',
    repo: repoOf('KDE', 'kdenlive'), license: 'GPL / AGPL / MIT', requires: '桌面端；按项目装插件/模型',
    risk: 'medium',
    repos: [
      { name: 'Kdenlive', repo: repoOf('KDE', 'kdenlive') },
      { name: 'Shotcut', repo: repoOf('mltframework', 'shotcut') },
      { name: 'Audacity', repo: repoOf('audacity', 'audacity') },
      { name: 'Ardour', repo: repoOf('Ardour', 'ardour') },
      { name: 'LMMS', repo: repoOf('LMMS', 'lmms') },
      { name: 'OBS Studio', repo: repoOf('obsproject', 'obs-studio') },
      { name: 'Upscayl', repo: repoOf('upscayl', 'upscayl') },
      { name: 'Rembg', repo: repoOf('danielgatis', 'rembg') },
    ],
  }),

  /* ── 开发（3）──────────────────────────────────────────────────────── */
  tool({
    id: 'git-server', name: 'Gitea / Forgejo', category: 'dev',
    desc: '轻量自建 Git 服务，替代 GitHub 私有仓库',
    repo: repoOf('go-gitea', 'gitea'), license: 'MIT / GPL-3.0', requires: 'Docker / 单二进制；备份仓库',
    risk: 'medium',
    repos: [
      { name: 'Gitea', repo: repoOf('go-gitea', 'gitea') },
      { name: 'Forgejo', repo: repoOf('forgejo', 'forgejo') },
    ],
  }),
  tool({
    id: 'ci', name: 'Woodpecker / Drone', category: 'dev',
    desc: '自建 CI，跑测试与构建',
    repo: repoOf('woodpecker-ci', 'woodpecker'), license: 'Apache-2.0', requires: 'Docker；Git 服务；Runner',
    risk: 'medium',
    repos: [
      { name: 'Woodpecker', repo: repoOf('woodpecker-ci', 'woodpecker') },
      { name: 'Drone', repo: repoOf('drone', 'drone') },
    ],
  }),
  tool({
    id: 'pbs', name: 'Proxmox Backup Server / UrBackup', category: 'dev',
    desc: '整机/虚拟机和文件级备份',
    repo: repoOf('proxmox', 'pbs'), license: 'AGPL-3.0', requires: '独立主机/存储；备份目标盘',
    risk: 'medium',
    repos: [
      { name: 'Proxmox Backup Server', repo: repoOf('proxmox', 'pbs') },
      { name: 'UrBackup', repo: repoOf('uroni', 'urbackup-server') },
    ],
  }),
]);
