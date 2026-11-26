/**
 * panel-tabs-work.js — 「能力」一级设置项（与「壁纸引擎」并列的第二个 settings.section）。
 *
 * 定位：**只做展示与指引，不做一键安装**（用户明确要求）。
 *   · 精选（默认） / 工作能力 / 娱乐 三片独立页面
 *   · 精选：20 套组合、场景向导（只高亮）、6 家族筛选、收藏、复制全部/单条、导出脚本/JSON
 *   · 工作能力/娱乐：保留原有卡片与详情
 *
 * 数据来自宿主：
 *   GET /folia/pet-chat/capabilities/catalog  （原有市场快照）
 *   GET /folia/pet-chat/capabilities/curated  （20 套组合 + profile node_modules 版本）
 */
const CAP_STATUS_TEXT = (item) => (item.installed ? weT('已安装') : weT('未安装'));

const CAP_CARD = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px 12px',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: '10px',
  background: 'rgba(255,255,255,0.03)',
};

const CAP_ICON = {
  width: '40px',
  height: '40px',
  flex: '0 0 40px',
  borderRadius: '10px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '20px',
  background: 'linear-gradient(135deg, rgba(124,108,255,0.35), rgba(76,175,125,0.22))',
};

const CAP_META = { fontSize: '11px', opacity: 0.6, marginTop: '2px', wordBreak: 'break-all' };

/* ── pre.71：能力/精选卡的"能不能真调用"标记 ───────────────────────────────
 * direct  = 已装的技能类包（capability_call 可读正文并按它执行）；
 * delegate= 已装的插件/组合，交给 delegate_to_dsh 的独立 DSH agent 执行；
 * manual  = 未装 / 宿主没有 agents 服务 ⇒ 只能读说明，必须如实标注。
 * 这是 UI 提示，不是权限边界；真正的权限/确认/审计在工具层与路由层。 */
const CALL_MODE_TONES = { direct: 'ok', delegate: 'medium', manual: undefined };

/** 包名是否是"技能"类（技能正文可被 capability_call 读取）。 */
function isSkillPackage(pkg) {
  return /(?:^|\/)dsh-skills?(?:-|$)/i.test(String(pkg || ''));
}

/** 单个能力条目的调用方式。 */
function capabilityCallMode(item, agentsAvailable) {
  if (!item || item.installed !== true) return 'manual';
  if (isSkillPackage(item.pkg)) return 'direct';
  return agentsAvailable === true ? 'delegate' : 'manual';
}

/** 精选组合的调用方式：全装且全是技能 ⇒ direct；有已装插件且宿主有 agents ⇒ delegate。 */
function curatedCallMode(bundle, installed, agentsAvailable) {
  const steps = Array.isArray(bundle && bundle.steps) ? bundle.steps : [];
  if (!steps.length) return 'manual';
  const installedSteps = steps.filter((s) => installed && installed[s.pkg]);
  if (!installedSteps.length) return 'manual';
  if (installedSteps.length === steps.length && installedSteps.every((s) => isSkillPackage(s.pkg))) {
    return 'direct';
  }
  return agentsAvailable === true ? 'delegate' : 'manual';
}

function CallModeTag({ mode }) {
  const label = mode === 'direct'
    ? weT('助手可直接调用')
    : mode === 'delegate' ? weT('需 DSH 执行') : weT('仅说明');
  return React.createElement(CuratedTag, { tone: CALL_MODE_TONES[mode] }, label);
}

/** 作者仓库预览占位块：固定 120px 高，图片失败时仍占位（不塌、不露裂图）。 */



function CapabilityCard({ item, agentsAvailable }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const callMode = capabilityCallMode(item, agentsAvailable);
  const copy = () => {
    const text = String(item.command || '');
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        void navigator.clipboard.writeText(text);
      }
    } catch { /* 复制失败不打断 */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const head = React.createElement('div', {
    key: 'head',
    style: { display: 'flex', alignItems: 'flex-start', gap: '10px' },
  },
  React.createElement('div', { style: CAP_ICON }, item.icon || '🧩'),
  React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
  React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' } },
    React.createElement('span', { style: { fontWeight: 600, fontSize: '13px' } }, item.name),
    item.installedVersion
      ? React.createElement('span', { className: 'we-picker__hint' }, 'v' + item.installedVersion)
      : null),
  React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '2px' } }, item.summary),
  React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap', marginTop: '2px' } },
    React.createElement(CallModeTag, { mode: callMode }),
    React.createElement('span', { style: CAP_META }, item.pkg + (item.size ? ' · ' + item.size : '')))),
  React.createElement('div', {
    style: { flex: '0 0 auto', textAlign: 'right', fontSize: '11px', opacity: 0.85, whiteSpace: 'nowrap' },
  },
  React.createElement('span', {
    style: {
      width: '6px', height: '6px', borderRadius: '50%', marginRight: '4px',
      background: item.installed ? '#4caf7d' : 'rgba(255,255,255,0.35)',
      display: 'inline-block',
    },
  }),
  React.createElement('span', { style: item.installed ? { color: '#4caf7d' } : null }, CAP_STATUS_TEXT(item))));

  const body = [head];
  if (open) {
    const line = (k, v) => React.createElement('div', { key: k, className: 'we-picker__hint', style: { marginTop: '4px' } }, v);
    body.push(React.createElement('div', { key: 'd-title', style: { marginTop: '8px', fontSize: '12px', fontWeight: 600 } }, weT('详情')));
    body.push(line('desc', item.authorDesc || item.summary || ''));
    body.push(React.createElement('div', { key: 'u-title', style: { marginTop: '8px', fontSize: '12px', fontWeight: 600 } }, weT('如何使用')));
    body.push(line('usage', item.usage || ''));
    if (item.requires) body.push(line('req', weT('前提：') + item.requires));
    if (!item.installed && item.command) {
      body.push(React.createElement('div', {
        key: 'cmd',
        style: {
          marginTop: '8px', padding: '6px 8px', borderRadius: '6px',
          background: 'rgba(255,255,255,0.06)', fontFamily: 'monospace', fontSize: '11px',
          wordBreak: 'break-all',
        },
      }, item.command));
    }
  }
  body.push(React.createElement('div', { key: 'btns', style: { display: 'flex', gap: '6px' } },
    React.createElement('button', {
      type: 'button', className: 'we-picker__btn', onClick: () => setOpen((v) => !v),
    }, open ? weT('收起') : weT('详情')),
    !item.installed && item.command
      ? React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: copy },
        copied ? weT('已复制') : weT('复制安装命令'))
      : null));

  return React.createElement('div', { style: CAP_CARD }, body);
}

function CapGroup({ title, hint, items, agentsAvailable }) {
  // 220 条一次性渲染会卡（每张卡都带状态），先展示 60 条，按需展开。
  const PAGE = 60;
  const [visibleCount, setVisibleCount] = React.useState(PAGE);
  return React.createElement('div', { style: { marginTop: '14px' } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
      React.createElement('div', { style: { fontWeight: 600, fontSize: '14px' } }, title),
      React.createElement('div', { className: 'we-picker__hint' }, hint)),
    React.createElement('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
        gap: '8px',
        marginTop: '8px',
      },
    }, items.slice(0, visibleCount).map((it) => React.createElement(CapabilityCard, { key: it.pkg || it.name, item: it, agentsAvailable })),
      items.length > visibleCount
        ? React.createElement("button", { key: "more", type: "button", className: "we-picker__btn", style: { marginTop: "8px" }, onClick: () => setVisibleCount((n) => n + PAGE) },
            weT("显示更多（还有 {n} 个）", { n: items.length - visibleCount }))
        : null));
}

/* ── 精选：命令/导出/收藏（纯前端，不执行安装）────────────────────────── */

const CURATED_PREFIX = 'dsh plugin --profile web add ';
const CURATED_FAV_KEY = 'we-curated-favorites';
const CURATED_FAMILY_LABELS = {
  all: '全部', basic: '基础', work: '工作', dev: '开发', creative: '创意', life: '生活', advanced: '进阶',
};
const CURATED_RISK_LABELS = { low: '低风险', medium: '中风险', high: '高风险' };
const CURATED_BUDGET_LABELS = { free: '免费', key: '需 Key', software: '需正版软件', paid: '需订阅' };

function curatedCommands(bundle) {
  return (bundle && Array.isArray(bundle.steps) ? bundle.steps : []).map((s) => CURATED_PREFIX + s.pkg);
}

function curatedExportText(bundle, format) {
  const commands = curatedCommands(bundle);
  if (format === 'powershell') {
    return "$ErrorActionPreference = 'Stop'\n" + commands.join('\n') + '\n';
  }
  if (format === 'bash') {
    return '#!/usr/bin/env bash\nset -euo pipefail\n' + commands.join('\n') + '\n';
  }
  return JSON.stringify({
    id: bundle.id, name: bundle.name, family: bundle.family, goal: bundle.goal,
    requires: bundle.requires, risk: bundle.risk, budget: bundle.budget,
    commands, steps: bundle.steps,
  }, null, 2) + '\n';
}

function curatedRecommend(role, software) {
  const r = String(role || '').toLowerCase();
  const s = String(software || '').toLowerCase();
  if (r === 'secure' || /安全|trust/.test(s)) return ['security', 'starter'];
  if (r === 'work') {
    if (/excel|data|数据/.test(s)) return ['data', 'ops-report'];
    return ['starter', 'office'];
  }
  if (r === 'dev') {
    if (/blender|unity|unreal|ue|game|游戏/.test(s)) return ['gamedev', 'coding'];
    return ['coding', 'starter'];
  }
  if (r === 'creative') {
    if (/pr|davinci|video|剪辑/.test(s)) return ['video', 'content'];
    if (/ps|figma|design|设计/.test(s)) return ['design', 'content'];
    if (/cad/.test(s)) return ['engineering', 'design'];
    return ['content', 'design'];
  }
  if (r === 'life') return ['companion', 'learn'];
  return ['starter'];
}

function readCuratedFavorites() {
  try {
    const raw = localStorage.getItem(CURATED_FAV_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.map(String) : [];
  } catch { return []; }
}
function writeCuratedFavorites(list) {
  try { localStorage.setItem(CURATED_FAV_KEY, JSON.stringify(Array.from(new Set(list)))); } catch { /* ignore */ }
}
function copyPlainText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(String(text || ''));
      return true;
    }
  } catch { /* fall through */ }
  return false;
}
function downloadTextFile(name, text, mime) {
  try {
    const blob = new Blob([String(text || '')], { type: mime || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch { /* ignore */ } }, 500);
    return true;
  } catch { return false; }
}

function CuratedTag({ children, tone }) {
  const color = tone === 'high' ? '#f87171' : tone === 'medium' ? '#fbbf24' : tone === 'ok' ? '#4caf7d' : undefined;
  return React.createElement('span', {
    style: {
      display: 'inline-block', padding: '1px 6px', borderRadius: '999px',
      border: '1px solid rgba(255,255,255,0.16)', fontSize: '10px', lineHeight: '1.5',
      color, whiteSpace: 'nowrap',
    },
  }, children);
}

function CuratedStep({ step, version, onCopy }) {
  const [copied, setCopied] = React.useState(false);
  const command = CURATED_PREFIX + step.pkg;
  return React.createElement('div', {
    style: {
      padding: '7px 8px', borderRadius: '8px', background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.08)',
    },
  },
  React.createElement('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' } },
    React.createElement('span', { style: { fontSize: '12px', fontWeight: 600 } }, step.pkg),
    version ? React.createElement(CuratedTag, { tone: 'ok' }, weT('已装 v{ver}', { ver: version })) : React.createElement(CuratedTag, null, weT('未装')),
    step.optional ? React.createElement(CuratedTag, null, weT('可选')) : null,
    step.alt ? React.createElement(CuratedTag, null, weT('可替代')) : null),
  React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '2px' } }, step.why || ''),
  step.detail && step.detail !== step.why
    ? React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '2px' } }, step.detail)
    : null,
  step.repo ? React.createElement('div', { style: { marginTop: '2px', fontSize: '10px' } },
    React.createElement('a', { href: step.repo, target: '_blank', rel: 'noreferrer', style: { color: 'inherit', textDecoration: 'underline' } }, step.repo)) : null,
  step.alt ? React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '2px' } },
    weT('替代：') + step.alt + '（' + CURATED_PREFIX + step.alt + '）') : null,
  React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '4px' } },
    React.createElement('code', { style: { flex: 1, minWidth: 0, fontSize: '10px', opacity: 0.8, wordBreak: 'break-all' } }, command),
    !version ? React.createElement('button', {
      type: 'button', className: 'we-picker__btn', style: { fontSize: '10px', padding: '1px 7px' },
      onClick: () => {
        copyPlainText(command);
        setCopied(true);
        if (onCopy) onCopy(command);
        setTimeout(() => setCopied(false), 1500);
      },
    }, copied ? weT('已复制') : weT('复制安装命令')) : null));
}

function CuratedCard({ bundle, installed, favorite, recommended, agentsAvailable, onToggleFavorite, onCopy, onExport }) {
  const [open, setOpen] = React.useState(false);
  const [copyNote, setCopyNote] = React.useState('');
  const steps = Array.isArray(bundle.steps) ? bundle.steps : [];
  const installedCount = steps.filter((s) => installed && installed[s.pkg]).length;
  const callMode = curatedCallMode(bundle, installed, agentsAvailable);
  const commands = curatedCommands(bundle);
  const risk = CURATED_RISK_LABELS[bundle.risk] || bundle.risk || '';
  const budgets = (Array.isArray(bundle.budget) ? bundle.budget : []).map((b) => CURATED_BUDGET_LABELS[b] || b).join(' / ');
  const high = bundle.risk === 'high';
  const copyWithNote = (text) => {
    onCopy(text);
    setCopyNote(weT('已复制。粘贴到 DSH 对话，让助手帮你安装（会先确认）。'));
    setTimeout(() => setCopyNote(''), 3500);
  };
  return React.createElement('div', {
    style: {
      ...CAP_CARD,
      border: recommended ? '1px solid rgba(124,108,255,0.8)' : CAP_CARD.border,
      boxShadow: recommended ? '0 0 0 1px rgba(124,108,255,0.25) inset' : undefined,
    },
  },
  React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
    React.createElement('div', { style: CAP_ICON }, bundle.icon || '🧩'),
    React.createElement('div', { style: { flex: 1, minWidth: 0 } },
      React.createElement('div', { style: { fontWeight: 600, fontSize: '13px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
        bundle.name,
        recommended ? React.createElement(CuratedTag, { tone: 'ok' }, weT('推荐')) : null),
      React.createElement('div', { className: 'we-picker__hint' }, bundle.goal),
      React.createElement('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' } },
        React.createElement(CuratedTag, { tone: bundle.risk }, risk),
        React.createElement(CuratedTag, null, budgets),
        React.createElement(CallModeTag, { mode: callMode }),
        high ? React.createElement(CuratedTag, { tone: 'high' }, weT('第三方 MCP，先 trust-check')) : null)),
    React.createElement('button', {
      type: 'button', className: 'we-picker__btn', title: favorite ? weT('取消收藏') : weT('收藏'),
      onClick: () => onToggleFavorite(bundle.id),
      style: { padding: '0 6px' },
    }, favorite ? '★' : '☆')),
  React.createElement('div', { className: 'we-picker__hint' }, weT('前置：') + (bundle.requires || '—')),
  React.createElement('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', alignItems: 'center', fontSize: '11px' } },
    steps.map((step, index) => React.createElement(React.Fragment, { key: step.pkg },
      index ? React.createElement('span', { style: { opacity: 0.4 } }, '→') : null,
      React.createElement('span', {
        style: {
          padding: '2px 6px', borderRadius: '6px',
          background: installed && installed[step.pkg] ? 'rgba(76,175,125,0.16)' : 'rgba(255,255,255,0.05)',
        },
      }, step.pkg + (installed && installed[step.pkg] ? ' v' + installed[step.pkg] : ' · ' + weT('未装')))))),
  React.createElement('div', { className: 'we-picker__hint' },
    weT('已装 {n}/{m}', { n: installedCount, m: steps.length })),
  (bundle.conflicts || []).length
    ? React.createElement('div', { className: 'we-picker__hint', style: { color: '#fbbf24' } },
      weT('冲突：') + bundle.conflicts.join('；'))
    : null,
  React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
    React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => copyWithNote(commands.join('\n')) },
      weT('复制全部命令')),
    React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => setOpen((v) => !v) },
      open ? weT('收起步骤') : weT('展开步骤')),
    React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => onExport(bundle, 'powershell') }, 'PowerShell'),
    React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => onExport(bundle, 'bash') }, 'bash'),
    React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => onExport(bundle, 'json') }, 'JSON')),
  copyNote ? React.createElement('div', { className: 'we-picker__hint', style: { color: '#4caf7d' } }, copyNote) : null,
  open ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
    steps.map((step) => React.createElement(CuratedStep, {
      key: step.pkg, step, version: installed ? installed[step.pkg] : null, onCopy: copyWithNote,
    }))) : null);
}

function CuratedWizard({ value, onChange, recommended, bundleById }) {
  const role = value.role || '';
  const software = value.software || '';
  const budget = value.budget || '';
  const select = (key, label, options) => React.createElement('label', {
    style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: '11px' },
  }, weT(label), React.createElement('select', {
    className: 'we-picker__playlist-select', value: value[key] || '', style: { fontSize: '11px' },
    onChange: (e) => onChange({ ...value, [key]: e.target.value }),
  }, React.createElement('option', { value: '' }, weT('不限')), options.map(([id, text]) =>
    React.createElement('option', { key: id, value: id }, weT(text)))));
  return React.createElement('div', {
    style: { padding: '8px 10px', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' },
  },
  React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } }, weT('场景向导')),
  React.createElement('div', { className: 'we-picker__hint' }, weT('只高亮推荐，不折叠其它组合。')),
  React.createElement('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' } },
    select('role', '你主要做什么？', [['work', '工作'], ['dev', '开发'], ['creative', '创作'], ['life', '生活'], ['secure', '安全治理']]),
    select('software', '装了什么软件？', [['', '无'], ['excel', 'Excel/数据'], ['ps', 'PS/Figma'], ['pr', 'PR/DaVinci'], ['blender', 'Blender/Unity'], ['cad', 'CAD']]),
    select('budget', '愿意付费吗？', [['free', '免费'], ['key', '可买 Key'], ['subscription', '可订阅']])),
  recommended.length ? React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '4px' } },
    weT('推荐：') + recommended.map((id) => (bundleById[id] ? bundleById[id].name : id)).join(' / ')) : null);
}

/* ── 个人工具（Docker/Windows，非 DSH 插件；只给仓库 + README 安装说明）── */

const PERSONAL_CATEGORY_LABELS = {
  all: '全部', ai: 'AI', 'speech-doc': '语音文档', media: '相册影音', docs: '文档效率',
  notes: '笔记阅读', home: '家庭生活', ops: '自动化运维', backup: '备份文件',
  privacy: '隐私安全', finance: '财务', creative: '创作设计', dev: '开发',
};

function PersonalToolCard({ tool }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [note, setNote] = React.useState('');
  const risk = CURATED_RISK_LABELS[tool.risk] || tool.risk || '';
  const copyRepo = () => {
    copyPlainText(tool.repo);
    setCopied(true);
    setNote(weT('已复制。粘贴到 DSH 对话，让助手帮你安装（会先确认）。'));
    setTimeout(() => { setCopied(false); setNote(''); }, 3500);
  };
  return React.createElement('div', { style: CAP_CARD },
    React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start' } },
      React.createElement('div', { style: CAP_ICON }, '🧰'),
      React.createElement('div', { style: { flex: 1, minWidth: 0 } },
        React.createElement('div', { style: { fontWeight: 600, fontSize: '13px', display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
          tool.name,
          React.createElement(CuratedTag, { tone: tool.risk }, risk),
          React.createElement(CuratedTag, null, weT('非 DSH 插件'))),
        React.createElement('div', { className: 'we-picker__hint' }, tool.desc),
        React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
          React.createElement(CuratedTag, null, tool.license),
          React.createElement(CuratedTag, null, tool.requires))),
      React.createElement('span', { style: { fontSize: '10px', opacity: 0.6 } }, PERSONAL_CATEGORY_LABELS[tool.category] || tool.category)),
    React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
      React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: copyRepo },
        copied ? weT('已复制') : weT('复制仓库地址')),
      React.createElement('a', {
        className: 'we-picker__btn', href: tool.repo, target: '_blank', rel: 'noreferrer',
        style: { textDecoration: 'none' },
      }, weT('打开 GitHub')),
      React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => setOpen((v) => !v) },
        open ? weT('收起') : weT('详情'))),
    note ? React.createElement('div', { className: 'we-picker__hint', style: { color: '#4caf7d' } }, note) : null,
    React.createElement('div', { className: 'we-picker__hint' },
      weT('需按 README 安装；助手只给步骤，不盲装。')),
    open ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      React.createElement('div', { className: 'we-picker__hint' }, tool.detail),
      React.createElement('div', { className: 'we-picker__hint' }, weT('前置：') + tool.requires),
      React.createElement('div', { className: 'we-picker__hint' }, weT('许可：') + tool.license),
      React.createElement('a', { href: tool.repo, target: '_blank', rel: 'noreferrer', style: { fontSize: '11px', color: 'inherit' } }, tool.repo),
      (tool.repos || []).length ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        tool.repos.map((r) => React.createElement('a', {
          key: r.repo, href: r.repo, target: '_blank', rel: 'noreferrer', style: { fontSize: '11px', color: 'inherit' },
        }, r.name + ' · ' + r.repo))) : null) : null);
}

function PersonalPanel({ tools }) {
  const [category, setCategory] = React.useState('all');
  const [query, setQuery] = React.useState('');
  const list = (Array.isArray(tools) ? tools : []).filter((t) => {
    if (category !== 'all' && t.category !== category) return false;
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return [t.name, t.desc, t.repo, t.category].join(' ').toLowerCase().includes(q);
  });
  return React.createElement('div', { style: { marginTop: '8px' } },
    React.createElement('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
      Object.keys(PERSONAL_CATEGORY_LABELS).map((id) => React.createElement('button', {
        key: id, type: 'button',
        className: 'we-picker__btn' + (category === id ? ' we-picker__btn--primary' : ''),
        onClick: () => setCategory(id),
      }, weT(PERSONAL_CATEGORY_LABELS[id])))),
    React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' } },
      React.createElement('input', {
        type: 'text', value: query, placeholder: weT('搜索个人工具'),
        onChange: (e) => setQuery(e.target.value),
        style: { flex: '1 1 180px', fontSize: '11px', padding: '4px 6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.16)', background: 'transparent', color: 'inherit' },
      }),
      React.createElement('span', { className: 'we-picker__hint' }, weT('共 {n} 项', { n: list.length }))),
    list.length ? React.createElement('div', {
      style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '8px', marginTop: '8px' },
    }, list.map((tool) => React.createElement(PersonalToolCard, { key: tool.id, tool })))
      : React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '10px' } }, weT('没有匹配的个人工具')));
}

function CuratedPanel({ data, favorites, onToggleFavorite, agentsAvailable }) {
  const [family, setFamily] = React.useState('all');
  const [favOnly, setFavOnly] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [wizard, setWizard] = React.useState({ role: '', software: '', budget: '' });
  const [copiedAll, setCopiedAll] = React.useState(false);
  const bundles = data && Array.isArray(data.bundles) ? data.bundles : [];
  const installed = (data && data.installed) || {};
  const bundleById = React.useMemo(() => {
    const map = {};
    bundles.forEach((b) => { map[b.id] = b; });
    return map;
  }, [bundles]);
  const recommended = React.useMemo(() => curatedRecommend(wizard.role, wizard.software), [wizard.role, wizard.software]);
  const filterText = String(query || '').trim().toLowerCase();
  const list = bundles.filter((b) => {
    if (family !== 'all' && b.family !== family) return false;
    if (favOnly && !favorites.has(b.id)) return false;
    if (!filterText) return true;
    return [b.name, b.goal, b.family, ...(b.steps || []).map((s) => s.pkg)].join(' ').toLowerCase().includes(filterText);
  });
  const allCommands = list.flatMap((b) => curatedCommands(b));
  const copyAll = () => {
    if (!allCommands.length) return;
    copyPlainText(allCommands.join('\n'));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  };
  const exportAllJson = () => {
    downloadTextFile('folia-curated.json', JSON.stringify({ bundles: list, commands: allCommands }, null, 2), 'application/json');
  };
  return React.createElement('div', { style: { marginTop: '8px' } },
    React.createElement(CuratedWizard, { value: wizard, onChange: setWizard, recommended, bundleById }),
    React.createElement('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '8px' } },
      Object.keys(CURATED_FAMILY_LABELS).map((id) => React.createElement('button', {
        key: id, type: 'button',
        className: 'we-picker__btn' + (family === id ? ' we-picker__btn--primary' : ''),
        onClick: () => setFamily(id),
      }, weT(CURATED_FAMILY_LABELS[id])))),
    React.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '6px' } },
      React.createElement('input', {
        type: 'text', value: query, placeholder: weT('搜索组合'),
        onChange: (e) => setQuery(e.target.value),
        style: { flex: '1 1 160px', minWidth: '120px', fontSize: '11px', padding: '4px 6px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.16)', background: 'transparent', color: 'inherit' },
      }),
      React.createElement('label', { style: { display: 'flex', gap: '4px', alignItems: 'center', fontSize: '11px' } },
        React.createElement('input', { type: 'checkbox', checked: favOnly, onChange: (e) => setFavOnly(e.target.checked) }),
        weT('只看收藏')),
      React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: copyAll, disabled: !list.length },
        copiedAll ? weT('已复制') : weT('复制全部命令')),
      React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: exportAllJson, disabled: !list.length },
        weT('导出 JSON'))),
    React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '4px' } },
      weT('共 {n} 套；已装状态来自 profile 的 node_modules（只读，不联网）。', { n: list.length })),
    list.length
      ? React.createElement('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '8px', marginTop: '8px' },
      }, list.map((bundle) => React.createElement(CuratedCard, {
        key: bundle.id, bundle, installed, favorite: favorites.has(bundle.id),
        recommended: recommended.includes(bundle.id),
        agentsAvailable: data && data.agentsAvailable === true,
        onToggleFavorite, onCopy: copyPlainText,
        onExport: (b, format) => downloadTextFile(
          'folia-curated-' + b.id + '.' + (format === 'json' ? 'json' : format === 'bash' ? 'sh' : 'ps1'),
          curatedExportText(b, format),
          format === 'json' ? 'application/json' : 'text/plain',
        ),
      })))
      : React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '10px' } },
        favOnly && !favorites.size ? weT('还没有收藏：点组合卡右上角的 ☆') : weT('没有匹配的组合')));
}

function CapabilitiesSection() {
  // items = 市场快照；curated = 20 套组合；page = 精选/工作能力/娱乐（精选默认）
  const [state, setState] = React.useState({ items: null, curated: null, page: "curated", curatedTab: "bundles", error: null, agentsAvailable: false });
  const [favorites, setFavorites] = React.useState(() => new Set(readCuratedFavorites()));

  React.useEffect(() => {
    void (async () => {
      const [catResp, curResp] = await Promise.all([
        apiJson("/pet-chat/capabilities/catalog", { parse: "always" }).catch(() => null),
        apiJson("/pet-chat/capabilities/curated", { parse: "always" }).catch(() => null),
      ]);
      const catDoc = (catResp && catResp.data) || null;
      const curDoc = (curResp && curResp.data) || null;
      setState((prev) => ({
        ...prev,
        items: catDoc && Array.isArray(catDoc.items) ? catDoc.items : prev.items,
        curated: curDoc && Array.isArray(curDoc.bundles) ? curDoc : prev.curated,
        agentsAvailable: Boolean((catDoc && catDoc.agentsAvailable) || (curDoc && curDoc.agentsAvailable) || prev.agentsAvailable),
        error: !catDoc && !curDoc ? weT("读取失败，重开设置页再试") : null,
      }));
    })();
  }, []);

  const toggleFavorite = React.useCallback((id) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      writeCuratedFavorites(Array.from(next));
      return next;
    });
  }, []);

  if (state.error) return React.createElement("div", { className: "we-picker__hint" }, state.error);
  if (!state.items && !state.curated) return React.createElement("div", { className: "we-picker__hint" }, weT("正在读取…"));

  const page = ["curated", "work", "fun"].includes(state.page) ? state.page : "curated";
  const tabs = [
    { id: "curated", label: weT("精选") },
    { id: "work", label: weT("工作能力") },
    { id: "fun", label: weT("娱乐") },
  ];
  const items = state.items || [];
  const workItems = items.filter((it) => it.section === "work");
  const funItems = items.filter((it) => it.section === "fun");

  return React.createElement("div", { style: { padding: "4px 2px" } },
    React.createElement("div", { style: { fontSize: "14px", fontWeight: 600 } }, weT("能力")),
    React.createElement("div", { className: "we-picker__hint", style: { marginTop: "2px" } },
      weT("这些是可选的插件与个人工具。安装方式：复制包名命令或 GitHub 地址 → 粘贴到 DSH 对话 → 让助手帮你下载安装（会先确认）。已装插件可由助手交给 DSH 执行；未装的只能看说明。非 DSH 插件的个人工具（Docker/Windows 应用）需要按 README 安装，助手只给步骤。")),
    // 三个页面之间切换（页内 tab），精选默认打开
    React.createElement("div", { style: { display: "flex", gap: "6px", marginTop: "10px" } },
      tabs.map((tab) => React.createElement("button", {
        key: tab.id,
        type: "button",
        className: "we-picker__btn" + (page === tab.id ? " we-picker__btn--primary" : ""),
        onClick: () => setState((prev) => ({ ...prev, page: tab.id })),
      }, tab.label))),
    page === "curated"
      ? (state.curated
        ? [
          React.createElement("div", { key: "curated-segments", style: { display: "flex", gap: "4px", marginTop: "8px" } },
            [["bundles", weT("场景组合")], ["personal", weT("个人工具")]].map(([id, label]) => React.createElement("button", {
              key: id, type: "button",
              className: "we-picker__btn" + (state.curatedTab === id ? " we-picker__btn--primary" : ""),
              onClick: () => setState((prev) => ({ ...prev, curatedTab: id })),
            }, label))),
          state.curatedTab === "personal"
            ? React.createElement(PersonalPanel, { key: "personal", tools: state.curated.personalTools })
            : React.createElement(CuratedPanel, {
              key: "bundles", data: state.curated, favorites, onToggleFavorite: toggleFavorite,
              agentsAvailable: state.agentsAvailable === true,
            }),
        ]
        : React.createElement("div", { className: "we-picker__hint", style: { marginTop: "10px" } }, weT("精选读取失败，重开设置页再试")))
      : React.createElement(CapGroup, {
        title: page === "work" ? weT("工作能力") : weT("娱乐"),
        hint: page === "work" ? weT("提高日常办事效率") : weT("让界面和对话更有趣"),
        items: page === "work" ? workItems : funItems,
        agentsAvailable: state.agentsAvailable === true,
      }));
}

export { CapabilityCard, CapabilitiesSection, CapGroup, capabilityCallMode, curatedCallMode };
