/**
 * gen-capabilities-usage.mjs — 重新生成「能力」页每条 `usage`（pre.51）。
 *
 * 背景：`lib/capabilities-catalog.js` 是市场快照（自动生成，勿手改）。pre.49 的 usage
 * 只有 12 条按关键词套的一句话模板（如「装好后在对话里说『放首歌』」），用户反馈太短。
 * 本脚本是**后处理生成器**：读现有 catalog，按类别重写每条的 usage，其余字段逐字保留。
 *
 * 生成规则（每类 2–4 步，全部含例句与注意）：
 *   ① 装好后去哪：独立面板 / 设置里的哪个页面 / 无需配置；
 *   ② 怎么触发：1–2 个对话例句（类别不同，例句不同）；
 *   ③ 注意：要不要 Key / 额外运行时 / 会不会和内置或同类插件重叠。
 *
 * 用法：
 *   node scripts/gen-capabilities-usage.mjs            # 写回 lib/capabilities-catalog.js
 *   node scripts/gen-capabilities-usage.mjs --report   # 只打印类别分布，不写文件
 *
 * 纪律：只替换每个对象里那一行 `"usage"`，不重新序列化整个文件（避免 260 条全量 diff）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = join(ROOT, 'lib', 'capabilities-catalog.js');
const REPORT = process.argv.includes('--report');

const blobOf = (item) => [item.name, item.summary, item.authorDesc, item.pkg]
  .filter(Boolean).join(' ').toLowerCase();

const has = (blob, re) => re.test(blob);

// ── 分类：**顺序即优先级**。先具体后宽泛（技能中心 → 技能包 → 角色扮演 → 阅读 → …）──
const RULES = [
  ['skillManager', /技能中心|技能市场|技能中枢|技能管理|技能面板|技能提供器|skills?[- ]?(console|hub|cockpit|market|explorer|center|center-panel|scope|tag)|skill[- ]?(hub|market|center|scope|explorer|cockpit|tag)|技能一键启停|按标签筛选技能/],
  ['skillPack', /技能包|技能 deck|skills? deck|技能会随|技能随包|技能随 |作为.{0,16}技能|内置.{0,4}技能|(?:个|套|组|系列).{0,6}技能|技能(?:库|中心)|打包五个|\btdd\b|superpowers?|mattpocock|remotion|hyperframes|brooks-lint|ponytail|bundle 技能|长文生产|生产流水线|video[- ]?pipeline|视频生产|事实核查|核查技能|调研技能|公文全流程|固件开发|嵌入式 c|插件开发知识库|rainskills|引导技能|remini|pptwise|ppt-master/],
  ['agents', /领域专家|专家名单|子代理|召唤.{0,6}专家/],
  ['roleplay', /角色扮演|酒馆|tavern|roleplay|cosplay|剧本杀|groupchat|群聊|galgame|角色卡|世界书|人格|多角色|agentic-roleplay|nexttavern|角色扮演系统|rpg 主角|互动小说/],
  ['debate', /辩论|debate/],
  ['study', /背单词|单词|学习|练习|题库|知识卡|高考|物理.{0,4}仿真|编程小教室|西语|时态|变位|年级|家教|猫狗品种/],
  ['reader', /小说|阅读器|阅读|书架|书源|epub|txt|微信读书|reader|novel|漫画|书页|档案馆|离线可读/],
  ['anime', /新番|番剧|动漫|anime|bangumi|追番/],
  ['divination', /塔罗|tarot|占卜|算命|玄学|六爻|八卦|紫微|八字|梅花易数|奇门|风水|黄历|运势|星座|求签|抽签|称骨|择日|起名|合婚|生命数字|人生k线|好运|大阿尔卡纳|五维评分/],
  // 强视觉信号放在游戏/桌宠/社区/开发之前：木鱼、表情包、数字雨这些名字里常带
  // 「鲸鱼娘」「QQ/微信」「插件」，先按"界面装饰"归类，避免被更宽的关键词抢走。
  ['visual', /表情包|emoji|颜文字|贴纸|木鱼|功德|烟花|礼花|fireworks|数字雨|代码雨|矩阵风格|打字特效|打字过程|打字音效|光标|粒子|光晕|特效|动效|挂件|香火|冷启动|弹幕|像素画|植物园|能量球|骑行带|小冰块|感谢语|等待提示|文风|机械神教|佛又曰|彩虹|连击计分|轮次评价|鼓励|制动|彩蛋|悬浮球|悬浮气泡|广告|白米饭|米饭|梦境/],
  ['game', /游戏|扑克|德州|斗地主|五子棋|象棋|围棋|扫雷|排雷|俄罗斯方块|骰子|麻将|自走棋|棋|小游戏|game|poker|holdem|chess|gomoku|minesweeper|tetris|arcade|roguelike|对局|关卡|牌桌|牌阵|牌库|抽卡|rpg|宝可梦|捕捉|杀戮尖塔|原神|米哈游|深海|掷骰|收藏卡|狼人杀|发牌|夜序|修仙/],
  ['media', /音乐|播放器|播客|电台|白噪音|音源|歌单|音频|音乐播放|视频|短视频|媒体库|影院|music|player|podcast|radio|ambient|piano|钢琴|音游|bgm|b站|抖音|收音机|小说播放器/],
  ['pet', /桌宠|桌面伴侣|桌面角色|伴宠|数字人|live2d|vrm|mascot|desktop[- ]?pet|吉祥物|小汤圆|鲸鱼娘|大肥鱼|鲸鲸|像素小鸡|鹈鹕|悬浮.{0,6}(宠物|角色|鱼)|右下角.{0,6}(角色|鱼|猫)|桌面伙伴|cute partner|coopanion|mimi|小猫|\bcat\b|电子榨菜/],
  ['monitor', /监控|内存|进程|网络|存储|安全|防火墙|磁盘|cpu|行情|股票|持仓|基金|投资|账本|a股|上证|指数|亏损|盈亏|token 用量|上下文健康|测速|dns|系统小|硬件|\bstock\b/],
  ['social', /贴吧|微信|小红书|黑盒|社区|发帖|回帖|评论|消息|好友|直播|弹幕|同花顺|群友|\b(?:qq|nga|bot)\b/],
  ['workflow', /目标模式|目标|goal|待办|todo|成就|勋章|等级|经验|xp|记忆|提醒|定时|计划|任务|记着你怎么跟 ai 说话|笔记本/],
  ['doc', /文档|pdf|office|markdown|ppt|幻灯片|表格|思维导图|typst|排版|报告|公文|写作|编辑器|studio|知识库|字体|论文|简历|海报|乐谱|数据.{0,6}insight|csv|excel|word|md\b|渲染|excalidraw|画布|mermaid|流程图/],
  ['dev', /开发|代码|插件|调试|固件|api|cli|编程|代码质量|审计|测试|架构|minecraft|forge|嵌入式|typescript|重构|lint|技术债|审查|数据模型|状态机|编译|部署|仓库/],
  // 兜底视觉：背景/主题/皮肤/预览这类词太宽，放在具体类别之后，只接住前面都没认领的。
  ['visual', /背景|主题|颜色|皮肤|头像|预览|装饰|像素|雨|雪|樱花|加密|画布|气泡|光晕/],
];

const CATEGORY_LABEL = {
  skillManager: '技能管理', skillPack: '技能包', agents: '专家/子代理', roleplay: '角色扮演', debate: '多智能体模拟',
  study: '学习练习', reader: '阅读', anime: '新番', divination: '占卜', game: '游戏',
  media: '音视频', pet: '桌宠/伴侣', monitor: '系统/行情监控', social: '社区/消息',
  doc: '文档处理', dev: '开发辅助', workflow: '目标/成就/记忆', visual: '界面动效', misc: '其它',
};

function classify(item) {
  const blob = blobOf(item);
  for (const [name, re] of RULES) if (has(blob, re)) return name;
  return 'misc';
}

// ── 类别内的例句细分（同一类不同工具给不同例子，避免 262 条全是同一句）──
function examplesFor(cat, item) {
  const blob = blobOf(item);
  const pick = (re, pair) => (has(blob, re) ? pair : null);
  if (cat === 'skillManager') {
    return ['列出当前可用的技能', '把不用的技能先停用'];
  }
  if (cat === 'skillPack') {
    return pick(/公文|通知|请示|报告/, ['按 GB/T 9704 检查这份通知的格式', '把这份材料改成一页请示'])
      || pick(/论文|学术|长文|行业分析|评论/, ['按这个题目写一篇行业分析长文', '先帮我搭论文的论证框架'])
      || pick(/ppt|幻灯|演示|路演/, ['把这份需求生成 12 页 PPT', '给这套方案做一版路演稿'])
      || pick(/视频|remotion|hyperframes|动画/, ['用 React 做一个 10 秒开场动画', '把这段音频做成波形视频'])
      || pick(/核查|调研|取证|fact/, ['先定型再取证，核查这段结论', '把这个问题拆成前提、定义、分析三类作业'])
      || pick(/固件|嵌入式|freertos|arm|keil/, ['审查这个 FreeRTOS 任务的中断安全', '给这个 Keil 工程补一份内存布局说明'])
      || pick(/minecraft|模组|forge/, ['写一个 1.7.10 的 Forge 模组骨架', '解释这段 Minecraft 协议包'])
      || pick(/设计|网页|排版|卡片|humanizer/, ['把这篇文章排成网页长图', '用这套 skill 做一组图文卡片'])
      || ['用 TDD 改这个函数', '先给方案再动手'];
  }
  if (cat === 'agents') return ['召唤一个数据库专家来评审这个设计', '让安全和性能两个专家分头看'];
  if (cat === 'roleplay') {
    return pick(/剧本杀/, ['开一局单人剧本杀', '让 AI 当主持人，我坐 3 号位'])
      || pick(/群聊|groupchat|多角色/, ['拉三个人进群聊，你是群主', '让 A 和 B 先各自说一句'])
      || pick(/酒馆|tavern|角色卡|galgame|cosplay/, ['导入这张角色卡，然后开始', '用店长的口吻跟我说话'])
      || ['开始角色扮演，你来当店长', '继续刚才的剧情'];
  }
  if (cat === 'debate') return ['开一场三人辩论，辩题是远程办公', '让八个辩手先各给一段立论'];
  if (cat === 'study') return ['今天背 20 个单词', '出三道初二物理题给我练'];
  if (cat === 'reader') return ['打开书架，接着上次读', '把这本书导入右侧栏'];
  if (cat === 'anime') return ['这季有什么新番', '帮我找评分最高的本季动画'];
  if (cat === 'divination') return ['帮我抽三张塔罗', '按现在的时间起一卦'];
  if (cat === 'game') {
    return pick(/扑克|德州|holdem|poker/, ['开一局无限注德州', '让我跟 AI 单挑一局'])
      || pick(/棋|chess|gomoku|围棋|象棋/, ['陪我下一盘象棋', '让两个 AI 对弈一局给我看'])
      || pick(/扫雷|sweeper/, ['开一局扫雷，20×20', '把雷数调到 99 再开'])
      || ['开一局小游戏', '陪我玩两分钟再继续干活'];
  }
  if (cat === 'media') {
    return pick(/播客|电台|radio|podcast/, ['放个播客听听', '打开上次听到的那一集'])
      || pick(/白噪音|ambient/, ['来点雨声白噪音', '切到咖啡馆背景音'])
      || ['放首歌', '打开我的播放列表'];
  }
  if (cat === 'pet') return ['摸摸头', '陪我说句话'];
  if (cat === 'monitor') {
    return pick(/股票|行情|持仓|a股|盈亏|基金|投资|账本/, ['今天大盘怎么样', '看看我持仓的盈亏'])
      || pick(/内存|进程|cpu|系统|存储|磁盘/, ['现在内存占用多少', '谁最占 CPU'])
      || pick(/上下文|token/, ['看看这个会话的 token 用量', '我的上下文健康度怎么样'])
      || pick(/网络|dns/, ['测一下网速', '查一下这个域名的 DNS'])
      || pick(/安全|防火墙|登录/, ['我的防火墙开着吗', '看看最近的登录记录'])
      || ['看看现在的系统状态', '把这个指标解释给我听'];
  }
  if (cat === 'social') return ['看看这个帖子在说什么', '帮我回一句得体的话'];
  if (cat === 'doc') {
    return pick(/pdf/, ['把这份 PDF 总结成三页', '读这份 PDF，把关键数字列出来'])
      || pick(/ppt|幻灯|演示/, ['把这份材料排成 12 页 PPT', '按这个大纲生成演示文稿'])
      || pick(/公文|通知|请示|报告/, ['按公文格式改这份通知', '检查这份报告的 GB/T 9704 格式'])
      || pick(/markdown|md\b/, ['把这段 Markdown 渲染出来', '打开 .md 文件按渲染结果编辑'])
      || pick(/表格|csv|excel/, ['把这份 CSV 变成带结论的表格', '按季度汇总这张表'])
      || ['把这份文档整理成一页摘要', '按这个模板生成一份报告'];
  }
  if (cat === 'dev') {
    return pick(/插件|plugin/, ['给我一个最小插件骨架', '这个 ctx.slot 为什么没生效'])
      || pick(/minecraft|forge|模组/, ['写一个 Forge 模组骨架', '解释这段协议包'])
      || pick(/审查|审计|质量|lint|测试/, ['审查这个模块的并发问题', '给这个项目补一组单测'])
      || ['先读这个仓库再给改造方案', '把这段逻辑重构成可测试的纯函数'];
  }
  if (cat === 'workflow') {
    return pick(/成就|勋章|等级|经验|xp/, ['看看我解锁了哪些成就', '这周还差多少经验升级'])
      || pick(/记忆|memory/, ['记下来：我偏好简短回答', '回忆一下我上次说的项目名'])
      || pick(/提醒|定时|计划|任务/, ['每天早上 9 点提醒我', '任务完成后通知我'])
      || ['帮我盯住这个目标直到完成', '把这件事拆成待办逐步做'];
  }
  if (cat === 'visual') {
    return pick(/表情包|meme|表情|emoji|颜文字|贴纸/, ['发个表情', '来张符合现在气氛的图'])
      || pick(/烟花|firework/, ['放个烟花庆祝一下', '来一场收工终场烟花'])
      || pick(/打字|输入|光标|粒子/, ['打开打字特效', '把连击音效关掉'])
      || pick(/木鱼|功德/, ['敲一下木鱼', '看看今天攒了多少功德'])
      || pick(/数字雨|背景|动效|特效|主题/, ['开一下数字雨', '把这个背景动效关掉'])
      || ['打开这个装饰', '把它关掉试试'];
  }
  return ['帮我试试它的主要功能', '把结果整理成一句话给我'];
}

const sectionLabel = (item) => (item.section === 'fun' ? '娱乐' : '工作能力');

function usageFor(item) {
  const cat = classify(item);
  const name = String(item.name || item.pkg || '').trim();
  const [ex1, ex2] = examplesFor(cat, item);
  const sec = sectionLabel(item);
  // ① 装好后去哪（所有类别共用：能力页一定能看到安装状态）。
  const where = `① 装好后重开会话让插件生效，在「设置 → 能力 → ${sec}」里能看到「${name}」的状态（多数无需额外配置）；`;
  // ② 怎么触发（按类别换动作，别让技能包也去"点开面板"）。
  const talk = `② 在对话里直接说「${ex1}」或「${ex2}」。`;
  const panel = `② 在对话里说「${ex1}」或「${ex2}」，也可以先打开它的面板再操作。`;
  const click = `② 在对话里说「${ex1}」或「${ex2}」，或直接点界面上的入口。`;
  const ask = `② 在对话里问「${ex1}」或「${ex2}」，也可以直接看卡片上的实时数字。`;
  const file = `② 把文件路径发给它并说「${ex1}」或「${ex2}」。`;
  const action = {
    skillManager: talk,
    skillPack: talk,
    agents: `② 在对话里说「${ex1}」或「${ex2}」，主会话负责收口。`,
    roleplay: `② 在对话里说「${ex1}」或「${ex2}」，也可以先导入角色卡再继续。`,
    debate: `② 在对话里说「${ex1}」或「${ex2}」，再让它开赛。`,
    study: `② 在对话里说「${ex1}」或「${ex2}」，也可以直接点面板里的「开始」。`,
    reader: `② 在对话里说「${ex1}」或「${ex2}」，也可以从书架点开。`,
    anime: `② 在对话里问「${ex1}」或「${ex2}」。`,
    divination: `② 在对话里说「${ex1}」或「${ex2}」，再追问「细说这一项」。`,
    game: `② 在对话里说「${ex1}」或「${ex2}」，或直接在面板里点「开始」。`,
    media: `② 在对话里说「${ex1}」或「${ex2}」，也可以先打开它的播放面板。`,
    pet: click,
    monitor: ask,
    social: `② 在对话里说「${ex1}」或「${ex2}」，也可以让它按计划定时浏览。`,
    doc: file,
    dev: `② 在对话里说「${ex1}」或「${ex2}」，再让它按步骤执行。`,
    workflow: panel,
    visual: click,
    misc: panel,
  }[cat] || panel;
  const note = {
    skillManager: '面板只管理技能清单，真正干活仍靠技能本身；停用后下一轮对话才生效。',
    skillPack: '技能按描述自动触发，不额外占端口；同时装多个同类技能包时模型会择优调用，冲突可去技能中心停用。',
    agents: '专家以子代理运行，会各占一份上下文；主会话只保留任务与最终答复，细节在子会话里。',
    roleplay: '角色设定只在本会话生效，长设定会吃上下文；导入角色卡/世界书（JSON/PNG）后，部分模式需在面板里手动开启。',
    debate: '一场辩论会多次调用模型，比较费 token；可以调辩手人数与轮数，先从小规模试。',
    study: '进度存在本机，换设备不同步；题目与讲解由模型生成，需要联网并消耗 token。',
    reader: '本地书要给它文件路径；阅读进度只存在本机，换设备不同步。',
    anime: '数据来自 Bangumi 等公开接口，需要联网；放送时间以日本时间为准，可能因改档变动。',
    divination: '结果仅供娱乐与自我复盘，不构成医疗、投资或法律建议；涉及真实决策请自行核实。',
    game: '对手是本地规则或 LLM 智能体，输赢不涉及真实货币；个别游戏要额外装 Python/Node 运行时。',
    media: '本地媒体要给文件路径；在线音源可能需要登录或额外服务，播放失败时先看面板里的音源状态。',
    pet: '部分角色包/模型要单独下载；若同时开了内置桌宠，建议只留一个，避免两只重叠。',
    monitor: '本机指标只读、不上传；行情/持仓有延迟，需先在面板里配置数据源或账号。',
    social: '需要有效登录态，发帖/评论有频率限制；账号安全自负，建议先用小号试。',
    doc: '本地文档要给绝对路径；转 PPT/PDF 可能依赖 LibreOffice/Pandoc 等本机工具。',
    dev: '它只动当前工作区，运行命令/改文件前会先征求确认；涉及外部服务时要自备 Key。',
    workflow: '目标/成就类数据存在本机；目标模式会跨轮保持上下文，长任务更费 token，随时可以说「暂停/结束目标」。',
    visual: '只改界面观感，不影响助手能力；和同类动效/表情插件同时开可能重叠，建议只留一个。',
    misc: '首次使用先看面板里的说明；需要 Key 或登录态的插件会在面板里提示。',
  }[cat] || '首次使用先看面板里的说明；需要 Key 或登录态的插件会在面板里提示。';
  return where + action + `③ 注意：${note}`;
}

// ── 读 catalog → 逐条算 usage → 只替换 usage 行 ──────────────────────────────
const src = readFileSync(CATALOG, 'utf8');
const match = /export const CAPABILITIES = (\[[\s\S]*?\]);\s*$/.exec(src);
if (!match) {
  console.error('[gen-capabilities-usage] 找不到 `export const CAPABILITIES = [...]` 结构');
  process.exit(1);
}
const items = JSON.parse(match[1]);

if (REPORT) {
  const counts = new Map();
  for (const item of items) {
    const c = classify(item);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  for (const [c, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(String(n).padStart(4), CATEGORY_LABEL[c] || c);
  }
  console.log('total', items.length);
  if (process.argv.includes('--list')) {
    for (const item of items) {
      if (classify(item) === 'misc') continue;
      console.log('  [' + classify(item) + ']', item.name, '|', String(item.summary || '').slice(0, 44));
    }
  }
  for (const item of items) {
    if (classify(item) === 'misc') console.log('  [misc]', item.name, '|', String(item.summary || '').slice(0, 50));
  }
  process.exit(0);
}

let usageIndex = 0;
const nextUsage = () => {
  const item = items[usageIndex];
  if (!item) throw new Error('catalog usage 行数多于条目数');
  usageIndex += 1;
  const usage = usageFor(item);
  if (!usage || usage.length < 40) throw new Error(`usage 过短：${item.name} (${usage.length})`);
  if (!usage.includes('①') || !usage.includes('②') || !usage.includes('注意')) {
    throw new Error(`usage 结构不完整：${item.name}`);
  }
  return JSON.stringify(usage);
};

let replaced = 0;
const out = src.replace(/(\n {2}"usage": )"(?:\\.|[^"\\])*"/g, (_full, prefix) => {
  replaced += 1;
  return prefix + nextUsage();
});

if (replaced !== items.length || usageIndex !== items.length) {
  console.error(`[gen-capabilities-usage] usage 行数 ${replaced} 与条目数 ${items.length} 不一致`);
  process.exit(1);
}
writeFileSync(CATALOG, out, 'utf8');

const min = Math.min(...items.map((it) => usageFor(it).length));
console.log(`[gen-capabilities-usage] 已更新 ${items.length} 条 usage（最短 ${min} 字）→ ${CATALOG}`);
