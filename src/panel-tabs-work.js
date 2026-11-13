/**
 * panel-tabs-work.js — 「能力」一级设置项（与「壁纸引擎」并列的第二个 settings.section）。
 *
 * 定位：**只做展示与指引，不做一键安装**（用户明确要求）。
 *   · 工作能力 / 娱乐 两片独立区域（各自标题 + 卡片网格）
 *   · 卡片外观对齐 web-all 的插件列表：左侧图标方块 + 名称 + 描述 + 元信息 + 右侧状态点
 *   · 「详情」行内展开：功能点 / 使用示例 / 前提 / 安装命令（可复制）
 *
 * 数据来自宿主 `GET /folia/pet-chat/capabilities`（catalog 写死在宿主侧，前端只渲染）。
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

function CapabilityCard({ item }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
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
  React.createElement('div', { style: CAP_META }, item.pkg + (item.size ? ' · ' + item.size : ''))),
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

function CapGroup({ title, hint, items }) {
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
    }, items.slice(0, visibleCount).map((it) => React.createElement(CapabilityCard, { key: it.pkg || it.name, item: it })),
      items.length > visibleCount
        ? React.createElement("button", { key: "more", type: "button", className: "we-picker__btn", style: { marginTop: "8px" }, onClick: () => setVisibleCount((n) => n + PAGE) },
            weT("显示更多（还有 {n} 个）", { n: items.length - visibleCount }))
        : null));
}

function CapabilitiesSection() {
  // items = 数据；page = 当前停在哪一页（工作能力 / 娱乐）—— 两个独立页面，不并排堆在一起
  const [state, setState] = React.useState({ items: null, page: "work", error: null });

  React.useEffect(() => {
    void (async () => {
      const resp = await apiJson("/pet-chat/capabilities", { parse: "always" }).catch(() => null);
      const doc = (resp && resp.data) || null;
      if (doc && Array.isArray(doc.items)) setState((prev) => ({ ...prev, items: doc.items, error: null }));
      else setState((prev) => ({ ...prev, error: weT("读取失败，重开设置页再试") }));
    })();
  }, []);

  if (state.error) return React.createElement("div", { className: "we-picker__hint" }, state.error);
  if (!state.items) return React.createElement("div", { className: "we-picker__hint" }, weT("正在读取…"));

  const page = state.page === "fun" ? "fun" : "work";
  const tabs = [
    { id: "work", label: weT("工作能力") },
    { id: "fun", label: weT("娱乐") },
  ];
  const items = page === "work"
    ? state.items.filter((it) => it.section === "work")
    : state.items.filter((it) => it.section === "fun");

  return React.createElement("div", { style: { padding: "4px 2px" } },
    React.createElement("div", { style: { fontSize: "14px", fontWeight: 600 } }, weT("能力")),
    React.createElement("div", { className: "we-picker__hint", style: { marginTop: "2px" } },
      weT("这些是可选插件：装好后能力给 DSH 助手用，桌宠本身不受影响。不做一键安装，复制命令自行安装。")),
    // 两个页面之间切换（页内 tab），每个页面只渲染自己那一组
    React.createElement("div", { style: { display: "flex", gap: "6px", marginTop: "10px" } },
      tabs.map((tab) => React.createElement("button", {
        key: tab.id,
        type: "button",
        className: "we-picker__btn" + (page === tab.id ? " we-picker__btn--primary" : ""),
        onClick: () => setState((prev) => ({ ...prev, page: tab.id })),
      }, tab.label))),
    React.createElement(CapGroup, {
      title: page === "work" ? weT("工作能力") : weT("娱乐"),
      hint: page === "work" ? weT("提高日常办事效率") : weT("让界面和对话更有趣"),
      items,
    }));
}
export { CapabilityCard, CapabilitiesSection, CapGroup };
