/**
 * verify-about-filter-capability.mjs — pre.71 三项 P0/P1 的验收判据。
 *
 *   A. 关于页：inventory / components 未就绪时也渲染；只有明确读到 about-notice 关闭才隐藏。
 *   B. 侧栏筛选：子标签计数按缓存/来源/搜索重算；0 张置灰；选中变 0 自动回退。
 *   C. 空态：当前条件 + 共 0 张 + 清空筛选按钮。
 *   D/E. delegate_to_dsh：真建 agent / 限能力 / 60s / 回读 / 审计来源 / 默认询问 / 特殊人设禁用 /
 *        服务缺失如实降级；能力与精选卡的调用方式标记。
 *
 * Usage: node test/verify-about-filter-capability.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { stripExportBlocks } from './tools/js-text.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');

let passed = 0;
let failed = 0;
const check = (name, ok, detail) => {
  if (ok) passed++; else failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

// 独立求值 src/panel-tabs.js 要用的最小浏览器 globals。
globalThis.React = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props: props || null, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
};
globalThis.weT = (key, params) => (params
  ? String(key).replace(/\{(\w+)\}/g, (_, k) => String(params[k]))
  : String(key));
globalThis.ABOUT_REPO_URL = 'https://github.com/lehua-art/dsh-folia';
globalThis.__weComponentVisible = (components, name) => Boolean(components && components[name] === 'started');

const textOf = (node) => {
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  return (Array.isArray(node.children) ? node.children.filter((c) => typeof c === 'string').join(' ') : '')
    + ' ' + (Array.isArray(node.children) ? node.children.map(textOf).join(' ') : '');
};

// ══ A. 关于页 gate ════════════════════════════════════════════════════════════
{
  const tabs = await import(pathToFileURL(join(ROOT, 'src/panel-tabs.js')).href);
  for (const [label, inventory] of [
    ['inventory 为 null', null],
    ['components 缺失', { wallpapers: [] }],
    ['components 为空对象', { components: {} }],
    ['components 明确 started', { components: { 'about-notice': 'started' } }],
  ]) {
    let tree = null;
    let error = '';
    try { tree = tabs.renderAboutTab({ sel: { inventory }, onReopenNotice: () => {} }); } catch (e) { error = String(e && e.message || e); }
    check('A 关于页在' + label + '时仍渲染完整内容',
      !error && Boolean(tree) && textOf(tree).includes('dshAI · 桌面增强插件'),
      error || (tree ? 'non-null' : 'null'));
  }
  const off = tabs.renderAboutTab({ sel: { inventory: { components: { 'about-notice': 'stopped' } } }, onReopenNotice: () => {} });
  check('A 只有明确读到 about-notice 关闭时才返回 null', off === null);
}

// ══ B/C. 侧栏筛选：纯函数 + 渲染器 ═════════════════════════════════════════════
{
  const qpSrc = stripExportBlocks(read('src/quick-panel.js'));
  const sandbox = {
    WE_FEATURE_TABS: [],
    React: globalThis.React,
    weT: globalThis.weT,
    localStorage: { getItem: () => null, setItem: () => {} },
    setTransient: () => {}, setSetting: () => {}, emit: () => {},
    window: { localStorage: { getItem: () => null, setItem: () => {} } },
    console,
  };
  const mod = new Script(qpSrc
    + '\n;({ qpFilterBase, qpSubtagOptionsWithCounts, qpSubtagSelection, qpRenderViewBar, qpRenderList })')
    .runInNewContext(sandbox);

  const playable = [
    { id: '1', title: 'A', localReady: true, source: 'folia', subtag: '原神' },
    { id: '2', title: 'B', localReady: true, source: 'folia', subtag: '崩铁' },
    { id: '3', title: 'C', localReady: false, source: 'folia', subtag: '原神' },
    { id: '4', title: 'D', localReady: true, source: undefined, subtag: '原神' },
  ];
  const cachedBase = mod.qpFilterBase(playable, 'cached', 'all', '');
  const cachedOptions = mod.qpSubtagOptionsWithCounts([
    { value: '原神', label: '原神' }, { value: '崩铁', label: '崩铁' }, { value: '绝区零', label: '绝区零' },
  ], cachedBase);
  check('B 计数按 cache=已缓存 重算：原神 2 / 崩铁 1 / 绝区零 0',
    cachedOptions.map((it) => it.value + ':' + it.count).join(',') === '原神:2,崩铁:1,绝区零:0',
    cachedOptions.map((it) => it.value + ':' + it.count).join(','));
  const siteBase = mod.qpFilterBase(playable, 'cached', 'site', '');
  const siteOptions = mod.qpSubtagOptionsWithCounts([{ value: '原神', label: '原神' }], siteBase);
  check('B 来源也参与重算：cache=已缓存 + source=站点 ⇒ 原神 1',
    siteOptions[0].count === 1, 'count=' + siteOptions[0].count);
  check('B 搜索也参与重算：q="a" 只剩条目 1',
    mod.qpFilterBase(playable, 'cached', 'all', 'a').length === 1);
  const lost = mod.qpSubtagSelection('绝区零', cachedBase);
  check('B 选中项变 0 ⇒ lost=true 且有效子标签回退为空（列表恢复全部）',
    lost.lost === true && lost.effective === '' && lost.count === 0);
  const kept = mod.qpSubtagSelection('原神', cachedBase);
  check('B 选中项仍有数据 ⇒ 不回退', kept.lost === false && kept.effective === '原神' && kept.count === 2);

  const bar = mod.qpRenderViewBar({ qpSearch: '' }, 'list', {
    cacheFilter: 'cached', subtagFilter: '', sourceFilter: 'all',
    subtagOptions: [{ value: '原神', label: '原神', count: 0 }, { value: '崩铁', label: '崩铁', count: 1 }],
    onCacheFilterChange: () => {}, onSubtagFilterChange: () => {},
    onFilterInteract: () => {}, filterNote: '',
  }, () => {});
  const options = [];
  (function collect(node) {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (!node || typeof node !== 'object') return;
    if (node.type === 'option') options.push(node);
    if (Array.isArray(node.children)) node.children.forEach(collect);
  })(bar);
  check('B 0 张子标签在 <option> 上 disabled=true（渲染树）',
    Boolean(options.find((o) => o.props.value === '原神' && o.props.disabled === true))
    && Boolean(options.find((o) => o.props.value === '崩铁' && o.props.disabled !== true)));

  const empty = mod.qpRenderList(null, [], 'list', false, 0, 0, {}, {
    hasActiveFilters: true, summary: '已缓存 + 子标签：原神', onClearFilters: () => {},
  });
  check('C 空态显示「当前条件…共 0 张」且带「清空筛选」按钮',
    textOf(empty).includes('当前条件：已缓存 + 子标签：原神，共 0 张')
    && textOf(empty).includes('清空筛选'));
  const noFilterEmpty = mod.qpRenderList(null, [], 'list', false, 0, 0, {}, { hasActiveFilters: false });
  check('C 无筛选条件时仍是原空态，不冒充"筛选造成"',
    textOf(noFilterEmpty).includes('没有可播放的壁纸') && !textOf(noFilterEmpty).includes('清空筛选'));
}

// ══ D. delegate_to_dsh：真实编排（假 agents/sessions，真工具函数）═════════════
{
  const toolsMod = await import(pathToFileURL(join(ROOT, 'lib/pet-chat-tools.js')).href);
  const runTool = toolsMod.runTool;

  let created = null;
  let restrictFilter = null;
  let followup = null;
  let flushed = false;
  let disposed = false;
  const messages = [];
  const fakeSession = {
    header: { id: 'delegate-session-1' }, seq: 0,
    deriveMessages: () => messages.slice(),
  };
  const fakeAgent = {
    session: fakeSession,
    whenIdle: async () => {},
    followup: (message) => {
      followup = message;
      messages.push({ role: 'assistant', content: [{ type: 'text', text: '已完成表格。' }] });
    },
    cancel: () => {},
  };
  const services = {
    agents: {
      create: async (opts) => {
        created = opts;
        await opts.setup({ tools: { restrict: (filter) => { restrictFilter = filter; } } });
        return { agent: fakeAgent, dispose: async () => { disposed = true; } };
      },
    },
    sessions: { flush: async () => { flushed = true; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
  };

  const ok = await runTool('delegate_to_dsh', { request: '用办公文档能力做一张表', capability: '办公文档' }, {
    services, confirmed: true, workspaceRoot: process.cwd(),
  });
  check('D 建独立 agent：sessionId/meta.cwd/provider/model 都从公共 API 传入',
    Boolean(created) && /^folia-delegate-/.test(created.sessionId)
    && created.agentOptions.provider === 'deepseek' && created.agentOptions.model === 'deepseek-chat'
    && typeof created.meta.cwd === 'string');
  check('D setup 用 tools.restrict(deny) 关掉 shell/写盘/子 agent（能力受限）',
    Boolean(restrictFilter) && Array.isArray(restrictFilter.deny)
    && restrictFilter.deny.includes('pwsh') && restrictFilter.deny.includes('write') && restrictFilter.deny.includes('subagent'));
  check('D followup 收到一条 user 文本消息，sessions.flush 被调用，dispose 收尾',
    Boolean(followup) && followup.role === 'user' && followup.content[0].type === 'text'
    && followup.content[0].text.includes('用办公文档能力做一张表')
    && flushed === true && disposed === true);
  check('D 回读 assistant 结果并写进 data（verified=true）',
    ok.ok === true && ok.verified === true && ok.data.delegate.answer === '已完成表格。'
    && ok.data.delegate.sessionId === 'delegate-session-1' && ok.say.includes('已完成表格。'));

  const confirm = await runTool('delegate_to_dsh', { request: '做表' }, { services });
  check('D 默认询问：未确认时返回 needsConfirm=true，不建 agent',
    confirm.ok === false && confirm.needsConfirm === true && confirm.say.includes('DSH'));

  const character = await runTool('delegate_to_dsh', { request: '做表' }, {
    services, confirmed: true, persona: { type: 'character' },
  });
  check('D 特殊人设禁用：character 直接拒绝，不建 agent',
    character.ok === false && character.say.includes('特殊人设'));

  const degraded = await runTool('delegate_to_dsh', { request: '做表' }, { services: {}, confirmed: true });
  check('D agents 服务不可用 ⇒ 如实降级，不假装调用',
    degraded.ok === false && degraded.verified === false && degraded.say.includes('没有可用的 DSH agent 服务'));

  let cancelled = false;
  const timeoutServices = {
    agents: {
      create: async () => ({
        agent: {
          session: { header: { id: 'timeout' }, deriveMessages: () => [] },
          whenIdle: () => new Promise(() => {}),
          followup: () => {},
          cancel: () => { cancelled = true; },
        },
        dispose: async () => {},
      }),
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const timed = await runTool('delegate_to_dsh', { request: '慢任务' }, {
    services: timeoutServices, confirmed: true, delegateTimeoutMs: 20,
  });
  check('D 60s 超时路径可判：超时返回可读失败并 cancel', timed.ok === false && timed.say.includes('超时') && cancelled === true);
}

// ══ E. 能力 / 精选卡标记 + 服务接线 ════════════════════════════════════════════
{
  const work = await import(pathToFileURL(join(ROOT, 'src/panel-tabs-work.js')).href);
  check('E 已装技能包 → 助手可直接调用',
    work.capabilityCallMode({ installed: true, pkg: '@deepseek-ai/dsh-skill-office' }, true) === 'direct');
  check('E 已装普通插件 + agents 服务 → 需 DSH 执行',
    work.capabilityCallMode({ installed: true, pkg: 'dsh-excel-chat' }, true) === 'delegate');
  check('E 已装插件但 agents 不可用 → 仅说明',
    work.capabilityCallMode({ installed: true, pkg: 'dsh-excel-chat' }, false) === 'manual');
  check('E 未装 → 仅说明',
    work.capabilityCallMode({ installed: false, pkg: 'dsh-excel-chat' }, true) === 'manual');
  const allSkill = { steps: [{ pkg: '@deepseek-ai/dsh-skill-office' }, { pkg: 'dsh-skill-hub' }] };
  check('E 精选：全装且全是技能 → 可直接调用',
    work.curatedCallMode(allSkill, { '@deepseek-ai/dsh-skill-office': '1', 'dsh-skill-hub': '1' }, true) === 'direct');
  const mixed = { steps: [{ pkg: 'dsh-excel-chat' }, { pkg: 'dsh-sql' }] };
  check('E 精选：部分/混合安装 + agents → 需 DSH 执行',
    work.curatedCallMode(mixed, { 'dsh-excel-chat': '1' }, true) === 'delegate');
  check('E 精选：未装 → 仅说明',
    work.curatedCallMode(mixed, {}, true) === 'manual');

  const indexSrc = read('lib/index.js');
  const routeSrc = read('lib/routes/pet-chat.js');
  const toolsSrc = read('lib/pet-chat-tools.js');
  const brainSrc = read('lib/pet-chat-brain.js');
  const personaSrc = read('lib/persona-store.js');
  check('E 宿主把 agents/sessions/agentDefaultModel 交给工具层（ctx.get + 缺失降级）',
    indexSrc.includes("safe('agents')") && indexSrc.includes("safe('sessions')")
    && indexSrc.includes("safe('agentDefaultModel')"));
  check('E capabilities/curated 响应带 agentsAvailable；审计来源标 dsh-agent',
    routeSrc.includes('agentsAvailable') && routeSrc.includes("'dsh-agent'"));
  check('E 工具实现含 60s 超时 / tools.restrict / 回读 deriveMessages / flush',
    toolsSrc.includes('DELEGATE_TIMEOUT_MS = 60000')
    && toolsSrc.includes('tools.restrict')
    && toolsSrc.includes('deriveMessages')
    && toolsSrc.includes('sessions.flush'));
  check('E delegate_to_dsh 进工具表、默认询问、plugins 权限组',
    brainSrc.includes("name: 'delegate_to_dsh'") && brainSrc.includes('needsConfirm: true')
    && personaSrc.includes("'delegate_to_dsh'"));
  const panelI18n = read('src/i18n-copy-panel.js');
  const pickerI18n = read('src/i18n-copy-picker.js');
  check('E 三种调用标记与筛选新词都在 i18n 表里',
    panelI18n.includes('"助手可直接调用":') && panelI18n.includes('"需 DSH 执行":')
    && panelI18n.includes('"仅说明":')
    && pickerI18n.includes('"清空筛选":') && pickerI18n.includes('"当前条件：{summary}，共 0 张":')
    && pickerI18n.includes('"当前缓存里没有「{name}」的壁纸，已切回全部":'));
}

console.log('');
console.log((failed ? '✗ FAILED' : '✓ PASSED') + ' — ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
