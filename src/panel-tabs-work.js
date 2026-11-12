/**
 * panel-tabs-work.js — 「能力」一级设置项（与「壁纸引擎」并列的第二个 settings.section）。
 *
 * 定位：**只做展示与指引，不做一键安装**（用户明确要求）。
 *   · 工作能力 / 娱乐 两片区域
 *   · 每张卡片：名称 + 包名 + 版本 + 状态徽标（已安装 / 未安装）
 *   · 「详情」行内展开：它是什么 / 怎么用 / 前提
 *   · 未安装的给一条可复制的安装命令
 *
 * 数据来自宿主 `GET /folia/pet-chat/capabilities`（catalog 写死在宿主侧，前端只渲染）。
 */
const CAP_STATUS_TEXT = (item) => (item.installed ? weT('已安装') : weT('未安装'));

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
  const tail = [];
  tail.push(React.createElement('div', {
    key: 'row',
    style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' },
  },
  React.createElement('span', { style: { fontWeight: 600 } }, item.name),
  React.createElement('span', { className: 'we-picker__hint' }, item.pkg),
  item.installedVersion
    ? React.createElement('span', { className: 'we-picker__hint' }, 'v' + item.installedVersion)
    : null,
  React.createElement('span', {
    className: 'we-picker__hint',
    style: { color: item.installed ? '#4caf7d' : undefined },
  }, CAP_STATUS_TEXT(item))));
  tail.push(React.createElement('div', { key: 'sum', className: 'we-picker__hint' }, item.summary));
  if (open) {
    tail.push(React.createElement('div', { key: 'usage', className: 'we-picker__hint', style: { marginTop: '4px' } },
      weT('怎么用：') + item.usage));
    if (item.requires) {
      tail.push(React.createElement('div', { key: 'req', className: 'we-picker__hint' }, weT('前提：') + item.requires));
    }
    if (!item.installed && item.command) {
      tail.push(React.createElement('div', {
        key: 'cmd',
        style: {
          marginTop: '6px', padding: '6px 8px', borderRadius: '6px',
          background: 'rgba(255,255,255,0.06)', fontFamily: 'monospace', fontSize: '11px',
          wordBreak: 'break-all',
        },
      }, item.command));
    }
  }
  tail.push(React.createElement('div', { key: 'btns', style: { display: 'flex', gap: '6px', marginTop: '6px' } },
    React.createElement('button', {
      type: 'button', className: 'we-picker__btn', onClick: () => setOpen((v) => !v),
    }, open ? weT('收起') : weT('详情')),
    !item.installed && item.command
      ? React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: copy },
        copied ? weT('已复制') : weT('复制安装命令'))
      : null));
  return React.createElement('div', {
    style: {
      border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px',
      padding: '8px 10px', margin: '6px 0',
    },
  }, tail);
}

function CapabilitiesSection() {
  const [items, setItems] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    void (async () => {
      const resp = await apiJson('/pet-chat/capabilities', { parse: 'always' }).catch(() => null);
      const doc = (resp && resp.data) || null;
      if (doc && Array.isArray(doc.items)) setItems(doc.items);
      else setError(weT('读取失败，重开设置页再试'));
    })();
  }, []);

  if (error) return React.createElement('div', { className: 'we-picker__hint' }, error);
  if (!items) return React.createElement('div', { className: 'we-picker__hint' }, weT('正在读取…'));

  const work = items.filter((it) => it.section === 'work');
  const fun = items.filter((it) => it.section === 'fun');
  const block = (title, list) => React.createElement('div', { key: title, style: { marginTop: '12px' } },
    React.createElement('div', { style: { fontWeight: 600, fontSize: '13px', marginBottom: '4px' } }, title),
    list.map((it) => React.createElement(CapabilityCard, { key: it.pkg, item: it })));

  return React.createElement('div', { style: { padding: '4px 2px' } },
    React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, weT('能力')),
    React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '2px' } },
      weT('这些是可选插件：装好后能力是给 DSH 助手的，桌宠本身不受影响。我们不做一键安装，复制命令后自行安装。')),
    block(weT('工作能力'), work),
    block(weT('娱乐'), fun));
}

export { CapabilityCard, CapabilitiesSection };
