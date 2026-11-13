/**
 * panel-tabs-assistant.js — 「智能大肥鱼」一级设置项（pre.51）。
 *
 * 用户口径：桌宠页里的「智能大肥鱼」不该是内联展开的表单，而要是**独立页面**
 * （「是智能大肥鱼这个标签点开的页面和桌宠分开，这两个不要在一个界面」）。
 *
 * 于是把 pre.49 里住在 `panel-tabs-pets.js` 的 `PetChatSettings` 整块搬到这里：
 *   · 设置左侧导航注册 `settings.section`（id=folia-assistant，order 502）；
 *   · 本文件只负责这一页：页面标题 + 一句说明 + 完整语音助手表单；
 *   · 桌宠页（panel-tabs-pets.js）不再挂载表单，只留一行指路提示。
 *
 * 语音助手功能本身一行没改：模型 Key / 名字 / 称呼 / 音色（v0.2 占位）/ 保存 /
 * 已保存 Key / 可选工作能力 / 冲突提醒，全部仍走 `/pet-chat/*`。
 *
 * 契约：同其它 `panel-tabs-*.js` —— 构建期内联进主 bundle 的工厂作用域，
 * 浏览器安全（无 import / require / Node API），不新增颜色样式。
 */

const CHAT_DEFAULTS = {
  provider: 'openai',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  apiKeyMasked: '',
  hasApiKey: false,
  petName: '',
  ownerName: '',
};

/**
 * 设置页（v0.1 验收口径）：**三项，无开关**。
 *   1) 模型 Key   2) 名字（桌宠名 = 唤醒词 + 你的称呼）   3) 音色（v0.2 占位，灰色只读）
 *
 * 为什么连"开启对话"都没有：工单要求用户不做选择 —— 填了 Key 就等于启用，
 * 主动搭话/记忆都是固定策略。删除任何开关，就少一次"用户要不要打开"的决策。
 */
/** apiJson 的返回是 { ok, status, data }，而 /pet-chat/* 的 data 里还套一层 { ok, data }。
 * 各调用点各写一遍「多解一层」就是 P1 那个"保存成功却显示保存失败"的来源 —— 统一到这里解。 */
const unwrapPetChat = (resp) => (resp && resp.data && resp.data.data) || (resp && resp.data) || {};

function PetChatSettings() {
  const [draft, setDraft] = React.useState(CHAT_DEFAULTS);
  const [status, setStatus] = React.useState({ ok: null, text: '' });
  const [note, setNote] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  // 工作能力插件（聚合携带）的安装状态；只读展示，不加开关
  const [workPlugins, setWorkPlugins] = React.useState(null);
  const update = React.useCallback((patch) => setDraft((prev) => ({ ...prev, ...patch })), []);

  const load = React.useCallback(async () => {
    try {
      const resp = await apiJson('/pet-chat/config', { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc && doc.ok !== false) {
        setDraft({ ...CHAT_DEFAULTS, ...doc, apiKey: '' });
        setStatus(doc.hasApiKey
          ? { ok: true, text: weT('已保存的 Key：{mask}', { mask: doc.apiKeyMasked || '••••' }) }
          : { ok: null, text: weT('还没有填 API Key') });
      }
    } catch { /* 首次加载失败不打扰 */ }
  }, []);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    void (async () => {
      const resp = await apiJson('/pet-chat/work-plugins', { parse: 'always' }).catch(() => null);
      setWorkPlugins(unwrapPetChat(resp));
    })();
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      // 填了 Key 就启用：面板不放任何开关，语义由 Key 的有无决定
      const body = { ...draft, apiKey: draft.apiKey || '', enabled: Boolean(draft.apiKey) || Boolean(draft.hasApiKey) };
      // ⚠️ 必须用 apiPostJson：apiJson 只拼 URL，不做 JSON.stringify，
      //    传对象会被浏览器发成 "[object Object]" ⇒ 宿主回 400 bad-json ⇒ 界面永远"保存失败"。
      const resp = await apiPostJson('/pet-chat/config', body, { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc.saved) {
        setNote({ ok: true, text: weT('已保存') });
        await load();
        const state = await apiJson('/pet-chat/state', { parse: 'always' });
        const sdoc = unwrapPetChat(state);
        setStatus(sdoc.reachable
          ? { ok: true, text: weT('已连接 · {m}', { m: sdoc.model || draft.model }) }
          : { ok: false, text: sdoc.lastError ? weT('未连接：{e}', { e: sdoc.lastError }) : weT('已保存，但还没连上') });
      } else setNote({ ok: false, text: weT('保存失败') });
    } catch (e) {
      setNote({ ok: false, text: weT('保存失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally { setBusy(false); }
  };

  const row = (key, label, node) => React.createElement('label', {
    key, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0' },
  }, weT(label), node);

  const child = [];
  child.push(React.createElement('div', { key: 'title', style: { fontWeight: 600, margin: '14px 0 4px', fontSize: '13px' } }, weT('桌宠语音助手')));
  child.push(React.createElement('div', { key: 'hint', className: 'we-picker__hint', style: { margin: '0 0 6px' } },
    weT('三项就够：填 Key、起名字、选音色。主动搭话与记忆是固定策略；停止/恢复对它说一声就行。')));

  child.push(React.createElement('div', { key: 'key', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0' } },
    weT('模型 Key'),
    React.createElement('input', {
      type: 'password', value: draft.apiKey || '',
      placeholder: draft.hasApiKey ? (draft.apiKeyMasked || '••••••••') : weT('填 DeepSeek API Key'),
      disabled: busy, style: { flex: 1, minWidth: 0 },
      onChange: (e) => update({ apiKey: e.target.value }),
    }),
  ));

  child.push(row('name', '名字', React.createElement('input', {
    type: 'text', value: draft.petName || '', placeholder: weT('桌宠叫什么（也是唤醒词）'), disabled: busy,
    style: { flex: 1, minWidth: 0 }, onChange: (e) => update({ petName: e.target.value }),
  })));
  child.push(row('owner', '称呼', React.createElement('input', {
    type: 'text', value: draft.ownerName || '', placeholder: weT('它该怎么称呼你'), disabled: busy,
    style: { flex: 1, minWidth: 0 }, onChange: (e) => update({ ownerName: e.target.value }),
  })));

  // 音色：v0.2 占位（灰色、不可改），避免用户以为现在能选
  child.push(row('voice', '音色', React.createElement('select', {
    className: 'we-picker__playlist-select', disabled: true, value: 'zh-CN-XiaoxiaoNeural',
  },
  React.createElement('option', { value: 'zh-CN-XiaoxiaoNeural' }, weT('晓晓（v0.2 可选）')),
  )));

  child.push(React.createElement('div', { key: 'status', className: 'we-picker__hint', style: { margin: '6px 0', color: status.ok === false ? '#f87171' : undefined } },
    status.text || weT('未连接')));
  if (note && note.text) {
    child.push(React.createElement('div', { key: 'note', className: 'we-picker__hint', style: { color: note.ok ? undefined : '#f87171' } }, note.text));
  }
  child.push(React.createElement('div', { key: 'save', style: { display: 'flex', gap: '6px', marginTop: '4px' } },
    React.createElement('button', { type: 'button', className: 'we-picker__btn', disabled: busy, onClick: save }, weT('保存')),
  ));


  // ── 工作能力（随插件携带，只读状态）─────────────────────────────────
  const workItems = (workPlugins && Array.isArray(workPlugins.items)) ? workPlugins.items : [];
  child.push(React.createElement('div', {
    key: 'work-head',
    style: { marginTop: '14px', fontSize: '12px', fontWeight: 600 },
  }, weT('可选工作能力（已安装才可用）')));
  if (!workItems.length) {
    child.push(React.createElement('div', { key: 'work-empty', className: 'we-picker__hint' }, weT('正在读取…')));
  } else {
    workItems.forEach((item) => {
      child.push(React.createElement('div', {
        key: 'work-' + item.id,
        className: 'we-picker__hint',
        style: { margin: '2px 0' },
      }, (item.installed ? '✓ ' : '· ') + item.label
        + (item.version ? ' ' + item.version : '')
        + (item.needs ? '（' + item.needs + '）' : '')));
    });
  }
  if (workPlugins && workPlugins.conflict) {
    child.push(React.createElement('div', {
      key: 'work-conflict',
      className: 'we-picker__hint',
      style: { marginTop: '4px', color: '#d9a13b' },
    }, weT('冲突提醒：') + workPlugins.conflict.note));
  }
  // 卡片样式沿用桌宠页的 PET_STYLE（同一 bundle 作用域、同一份颜色，不新增颜色样式）。
  return React.createElement('div', { id: 'we-pet-chat-settings', style: { ...PET_STYLE.card, marginTop: '10px' } }, child);
}

/**
 * 「智能大肥鱼」一级设置页。只做版面装配：标题 + 完整表单。
 * 设置导航的注册在 `src/client.js`（id=folia-assistant，order 502）。
 */
function AssistantSection() {
  return React.createElement('div', { className: 'we-assistant-section', style: { padding: '4px 2px' } },
    React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, weT('智能大肥鱼')),
    React.createElement(PetChatSettings, null),
  );
}

export { AssistantSection, PetChatSettings };
