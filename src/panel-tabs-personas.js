/**
 * panel-tabs-personas.js — 「智能大肥鱼 → 人设」：列表 + 7 子页（pre.65）。
 *
 * 设计取舍：
 *   · 第一屏只做三件事：看当前人设、切换/进入、新建/导入；
 *   · 每个 persona 一张卡，进入后 7 个子页（basic/model/card/memory/voice/play/permissions）；
 *   · 特殊人设（character）隐藏 permissions，并明确写“不使用系统工具”；
 *   · Key 输入只写不读：列表只显示接口返回的掩码。
 *
 * 不依赖新 npm 包；全部用 React.createElement（构建期内联，同其它面板）。
 */
const PERSONA_STYLE = {
  card: {
    border: '1px solid rgba(255,255,255,.10)', borderRadius: '12px', padding: '10px 12px',
    margin: '8px 0', background: 'rgba(255,255,255,.025)', fontSize: '12px',
  },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '5px 7px', borderRadius: '7px',
    border: '1px solid rgba(255,255,255,.18)', background: 'rgba(0,0,0,.18)', color: 'inherit', fontSize: '12px',
  },
  textarea: {
    width: '100%', minHeight: '64px', boxSizing: 'border-box', padding: '6px 7px', borderRadius: '7px',
    border: '1px solid rgba(255,255,255,.18)', background: 'rgba(0,0,0,.18)', color: 'inherit', fontSize: '12px',
    resize: 'vertical',
  },
  primary: {
    border: '1px solid rgba(120,190,255,.55)', borderRadius: '8px', padding: '5px 12px',
    background: 'rgba(90,160,255,.16)', color: 'inherit', cursor: 'pointer', fontSize: '12px',
  },
  ghost: {
    border: '1px solid rgba(255,255,255,.14)', borderRadius: '8px', padding: '4px 10px',
    background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '11px',
  },
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  label: { fontSize: '11px', opacity: .78, margin: '7px 0 3px' },
};

const PERSONA_TABS = [
  { id: 'basic', label: weT('基本') },
  { id: 'model', label: weT('模型与 Key') },
  { id: 'card', label: weT('人设卡') },
  { id: 'memory', label: weT('记忆') },
  { id: 'voice', label: weT('声音') },
  { id: 'play', label: weT('玩法') },
  { id: 'permissions', label: weT('权限') },
];

const unwrapPersona = (resp) => (resp && resp.data && resp.data.data) || (resp && resp.data) || {};

function personaInput(props) {
  return React.createElement('input', {
    type: props.type || 'text', value: props.value == null ? '' : String(props.value),
    placeholder: props.placeholder || '', onChange: (e) => props.onChange(e.target.value),
    style: { ...PERSONA_STYLE.input, ...(props.style || {}) },
  });
}

function personaTextarea(props) {
  return React.createElement('textarea', {
    value: props.value == null ? '' : String(props.value), placeholder: props.placeholder || '',
    onChange: (e) => props.onChange(e.target.value), rows: props.rows || 4,
    style: { ...PERSONA_STYLE.textarea, ...(props.style || {}) },
  });
}

function personaSelect(props) {
  return React.createElement('select', {
    value: props.value, onChange: (e) => props.onChange(e.target.value),
    style: { ...PERSONA_STYLE.input, width: 'auto', minWidth: '120px' },
  }, (props.options || []).map((opt) => React.createElement('option', { key: opt.value, value: opt.value }, opt.label)));
}

function personaField(label, child, hint) {
  return React.createElement('div', { key: label, style: { marginBottom: '6px' } },
    React.createElement('div', { style: PERSONA_STYLE.label }, label),
    child,
    hint ? React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '2px', fontSize: '10px', opacity: .7 } }, hint) : null);
}

function personaButton(label, onClick, opts = {}) {
  return React.createElement('button', {
    type: 'button', disabled: opts.disabled === true, onClick,
    style: { ...(opts.primary ? PERSONA_STYLE.primary : PERSONA_STYLE.ghost), ...(opts.style || {}) },
  }, label);
}

function personaTypeLabel(type) {
  return type === 'character' ? weT('特殊人设') : weT('助手');
}

function personaModeLabel(mode) {
  if (mode === 'roleplay') return weT('角色扮演');
  if (mode === 'story') return weT('互动故事');
  return weT('聊天');
}

/** 弹一个隐藏 file input，读成文本或 base64。 */
function personaPickFile(accept, onFile) {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { onFile(file, reader.result); } catch { /* ignore */ }
      try { input.remove(); } catch { /* ignore */ }
    };
    if (/\.png$/i.test(file.name) || /png/i.test(file.type)) reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
  document.body.appendChild(input);
  input.click();
}

function PersonaSection() {
  const [list, setList] = React.useState({ loading: true, items: [], activeId: '' });
  const [selected, setSelected] = React.useState(null);
  const [tab, setTab] = React.useState('basic');
  const [draft, setDraft] = React.useState(null);
  const [keyInfo, setKeyInfo] = React.useState({ hasKey: false, maskedKey: '' });
  const [keyValue, setKeyValue] = React.useState('');
  const [memory, setMemory] = React.useState({ loading: false, items: [], growth: [], q: '', total: 0 });
  const [voices, setVoices] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState(null);
  const [newName, setNewName] = React.useState('');
  const [newType, setNewType] = React.useState('assistant');

  const loadList = React.useCallback(async () => {
    setList((prev) => ({ ...prev, loading: true }));
    try {
      const doc = unwrapPersona(await apiJson('/pet-chat/personas', { parse: 'always' }));
      setList({ loading: false, items: Array.isArray(doc.personas) ? doc.personas : [], activeId: String(doc.activeId || '') });
    } catch {
      setList({ loading: false, items: [], activeId: '' });
    }
  }, []);

  React.useEffect(() => { void loadList(); }, [loadList]);

  const loadPersona = React.useCallback(async (id) => {
    setBusy(true);
    try {
      const doc = unwrapPersona(await apiJson('/pet-chat/personas/' + encodeURIComponent(id), { parse: 'always' }));
      if (!doc.persona) { setNote({ ok: false, text: weT('人设不存在') }); return; }
      setSelected(doc.persona);
      setDraft(JSON.parse(JSON.stringify(doc.persona)));
      setKeyInfo(doc.key || { hasKey: false, maskedKey: '' });
      setKeyValue('');
      setTab('basic');
      setNote(null);
    } catch {
      setNote({ ok: false, text: weT('读取人设失败') });
    } finally {
      setBusy(false);
    }
  }, []);

  const refreshVoice = React.useCallback(() => {
    try { if (typeof petChatRefreshVoice === 'function') void petChatRefreshVoice(); } catch { /* ignore */ }
  }, []);

  const create = async (type, mode) => {
    setBusy(true);
    try {
      const doc = unwrapPersona(await apiPostJson('/pet-chat/personas', {
        type, mode, name: newName.trim(),
      }, { parse: 'always' }));
      if (!doc.ok) { setNote({ ok: false, text: weT('新建失败') }); return; }
      setNewName('');
      await loadList();
      await loadPersona(doc.persona.id);
    } catch {
      setNote({ ok: false, text: weT('新建失败') });
    } finally { setBusy(false); }
  };

  const activate = async (id) => {
    setBusy(true);
    try {
      await apiPostJson('/pet-chat/personas/' + encodeURIComponent(id) + '/active', {}, { parse: 'always' });
      await loadList();
      refreshVoice();
      setNote({ ok: true, text: weT('已切换当前人设') });
    } catch {
      setNote({ ok: false, text: weT('切换失败') });
    } finally { setBusy(false); }
  };

  const remove = async (id, name) => {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm(weT('删除「{name}」会同时删除它的全部记忆，确定吗？', { name: name || id }))) return;
    setBusy(true);
    try {
      const doc = unwrapPersona(await apiFetch('/pet-chat/personas/' + encodeURIComponent(id) + '?confirm=1', { method: 'DELETE', parse: 'always' }));
      if (doc.ok) {
        setSelected(null); setDraft(null);
        await loadList(); refreshVoice();
        setNote({ ok: true, text: weT('人设已删除') });
      } else setNote({ ok: false, text: doc.hint || weT('删除失败') });
    } catch { setNote({ ok: false, text: weT('删除失败') }); } finally { setBusy(false); }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const payload = {
        name: draft.name, avatar: draft.avatar, type: draft.type, mode: draft.mode,
        model: draft.model, core: draft.core, express: draft.express, card: draft.card,
        story: draft.story, affect: draft.affect,
      };
      const doc = unwrapPersona(await apiFetch('/pet-chat/personas/' + encodeURIComponent(draft.id), {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), parse: 'always',
      }));
      if (doc.ok) {
        setSelected(doc.persona); setDraft(JSON.parse(JSON.stringify(doc.persona)));
        await loadList(); refreshVoice();
        setNote({ ok: true, text: weT('已保存') });
      } else setNote({ ok: false, text: doc.hint || weT('保存失败') });
    } catch { setNote({ ok: false, text: weT('保存失败') }); } finally { setBusy(false); }
  };

  const patchDraft = (fn) => setDraft((prev) => {
    const next = JSON.parse(JSON.stringify(prev));
    fn(next);
    return next;
  });

  const uploadCard = async (file, result) => {
    if (!draft) return;
    const isPng = /\.png$/i.test(file.name) || /png/i.test(file.type);
    const payload = isPng ? { base64: String(result) } : { json: String(result) };
    setBusy(true);
    try {
      const doc = unwrapPersona(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(draft.id) + '/import-card', payload, { parse: 'always' }));
      if (doc.ok) {
        await loadPersona(draft.id);
        setNote({ ok: true, text: weT('角色卡已导入') });
      } else setNote({ ok: false, text: doc.hint || weT('角色卡导入失败') });
    } catch { setNote({ ok: false, text: weT('角色卡导入失败') }); } finally { setBusy(false); }
  };

  const importNew = () => {
    personaPickFile('.json,.png,image/png', async (file, result) => {
      const isPng = /\.png$/i.test(file.name) || /png/i.test(file.type);
      const name = String(file.name || '').replace(/\.(json|png)$/i, '') || '导入的角色';
      setBusy(true);
      try {
        const created = unwrapPersona(await apiPostJson('/pet-chat/personas', { type: 'character', mode: 'roleplay', name }, { parse: 'always' }));
        if (!created.ok) { setNote({ ok: false, text: weT('新建失败') }); return; }
        const id = created.persona.id;
        const doc = unwrapPersona(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(id) + '/import-card', isPng ? { base64: String(result) } : { json: String(result) }, { parse: 'always' }));
        if (!doc.ok) { setNote({ ok: false, text: doc.hint || weT('角色卡导入失败') }); return; }
        await loadList(); await loadPersona(id);
        setNote({ ok: true, text: weT('角色卡已导入') });
      } catch { setNote({ ok: false, text: weT('角色卡导入失败') }); } finally { setBusy(false); }
    });
  };

  const loadMemory = React.useCallback(async (id, q) => {
    setMemory((prev) => ({ ...prev, loading: true, q }));
    try {
      const query = q ? '&q=' + encodeURIComponent(q) : '';
      const doc = unwrapPersona(await apiJson('/pet-chat/personas/' + encodeURIComponent(id) + '/memory?limit=50' + query, { parse: 'always' }));
      setMemory({ loading: false, q, items: Array.isArray(doc.items) ? doc.items : [], growth: Array.isArray(doc.growth) ? doc.growth : [], total: Number(doc.total) || 0 });
    } catch { setMemory((prev) => ({ ...prev, loading: false })); }
  }, []);

  const loadVoices = React.useCallback(async () => {
    try {
      const doc = unwrapPersona(await apiJson('/pet-chat/tts/voices', { parse: 'always' }));
      setVoices(Array.isArray(doc.voices) ? doc.voices.filter((v) => v && v.usable === true) : []);
    } catch { setVoices([]); }
  }, []);

  React.useEffect(() => {
    if (!selected) return;
    if (tab === 'memory') void loadMemory(selected.id, '');
    if (tab === 'voice' && !voices.length) void loadVoices();
  }, [selected, tab, loadMemory, loadVoices, voices.length]);

  if (!draft) {
    const active = list.items.find((item) => item.id === list.activeId) || null;
    const cards = list.items.map((item) => {
      const actions = [
        item.id !== list.activeId
          ? personaButton(weT('切换'), () => { void activate(item.id); })
          : null,
        personaButton(weT('进入'), () => { void loadPersona(item.id); }),
        personaButton(weT('删除'), () => { void remove(item.id, item.name); }),
      ].filter(Boolean);
      return React.createElement('div', {
        key: item.id,
        style: { ...PERSONA_STYLE.card, borderColor: item.id === list.activeId ? 'rgba(120,190,255,.55)' : undefined },
      },
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, item.name || weT('未命名')),
          React.createElement('div', { style: { fontSize: '11px', opacity: .72 } },
            `${personaTypeLabel(item.type)} · ${personaModeLabel(item.mode)} · ${weT('记忆 {n}', { n: item.memoryCount || 0 })}`),
          item.id === list.activeId
            ? React.createElement('div', { style: { fontSize: '10px', color: '#7fc4ff' } }, weT('当前使用'))
            : null),
        React.createElement('div', { style: { ...PERSONA_STYLE.row } }, actions)));
    });
    const createCard = React.createElement('div', { style: { ...PERSONA_STYLE.card, marginTop: '12px' } },
      React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '6px' } }, weT('新建人设')),
      React.createElement('div', { style: PERSONA_STYLE.row },
        personaInput({ value: newName, placeholder: weT('名字（可留空）'), onChange: setNewName, style: { width: '150px' } }),
        personaSelect({
          value: newType, onChange: setNewType,
          options: [{ value: 'assistant', label: weT('助手') }, { value: 'character', label: weT('特殊人设') }],
        }),
        personaButton(weT('＋新建'), () => { void create(newType, newType === 'character' ? 'roleplay' : 'chat'); }, { primary: true, disabled: busy }),
        personaButton(weT('导入角色卡（JSON/PNG）'), importNew, { disabled: busy })));
    return React.createElement('div', { id: 'we-persona-section', style: { marginBottom: '14px' } },
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between', marginBottom: '6px' } },
        React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, weT('人设')),
        personaButton(weT('刷新'), () => { void loadList(); })),
      React.createElement('div', { style: PERSONA_STYLE.card },
        React.createElement('div', { style: { fontSize: '11px', opacity: .75 } }, weT('当前使用')),
        React.createElement('div', { style: { fontSize: '14px', marginTop: '2px' } },
          active ? `${active.name || weT('未命名')}（${personaTypeLabel(active.type)}）` : weT('还没有人设'))),
      list.loading ? React.createElement('div', { className: 'we-picker__hint' }, weT('正在读取人设…')) : null,
      cards,
      createCard,
      note ? React.createElement('div', { className: 'we-picker__hint', style: { color: note.ok ? undefined : '#f87171', marginTop: '6px' } }, note.text) : null);
  }

  const p = draft;
  const isCharacter = p.type === 'character';
  const tabList = PERSONA_TABS.filter((item) => item.id !== 'permissions' || !isCharacter);
  const saveRow = React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '8px' } },
    personaButton(weT('保存'), () => { void save(); }, { primary: true, disabled: busy }),
    personaButton(weT('返回列表'), () => { setSelected(null); setDraft(null); setNote(null); void loadList(); }));

  const basicPage = React.createElement('div', null,
    personaField(weT('名字'), personaInput({ value: p.name, onChange: (v) => patchDraft((d) => { d.name = v; }) })),
    personaField(weT('头像（URL / emoji / 留空）'), personaInput({ value: p.avatar, onChange: (v) => patchDraft((d) => { d.avatar = v; }) })),
    personaField(weT('类型'), personaSelect({
      value: p.type, onChange: (v) => patchDraft((d) => { d.type = v; }),
      options: [{ value: 'assistant', label: weT('助手（可用系统工具）') }, { value: 'character', label: weT('特殊人设（不使用系统工具）') }],
    })),
    personaField(weT('模式'), personaSelect({
      value: p.mode, onChange: (v) => patchDraft((d) => { d.mode = v; }),
      options: [{ value: 'chat', label: weT('聊天') }, { value: 'roleplay', label: weT('角色扮演') }, { value: 'story', label: weT('互动故事') }],
    })),
    isCharacter ? React.createElement('div', { className: 'we-picker__hint' }, weT('特殊人设不使用任何系统工具。')) : null);

  const modelPage = React.createElement('div', null,
    personaField(weT('接口协议'), personaSelect({
      value: p.model.provider || 'inherit', onChange: (v) => patchDraft((d) => { d.model.provider = v; }),
      options: [{ value: 'inherit', label: weT('继承全局') }, { value: 'openai', label: weT('OpenAI 兼容') }, { value: 'ollama', label: 'Ollama' }],
    })),
    personaField(weT('接口地址'), personaInput({ value: p.model.baseUrl, placeholder: 'https://api.deepseek.com', onChange: (v) => patchDraft((d) => { d.model.baseUrl = v; }) })),
    personaField(weT('模型名'), personaInput({ value: p.model.model, placeholder: 'deepseek-chat', onChange: (v) => patchDraft((d) => { d.model.model = v; }) })),
    personaField(weT('温度'), personaInput({ type: 'number', value: p.model.temperature, onChange: (v) => patchDraft((d) => { d.model.temperature = Number(v); }) })),
    personaField(weT('Key') + (keyInfo.hasKey ? `（已保存：${keyInfo.maskedKey}）` : ''),
      React.createElement('div', { style: PERSONA_STYLE.row },
        personaInput({ type: 'password', value: keyValue, placeholder: weT('只写不读；留空不修改'), onChange: setKeyValue, style: { flex: 1 } }),
        personaButton(weT('保存 Key'), async () => {
          if (!keyValue.trim()) { setNote({ ok: false, text: weT('先填 Key') }); return; }
          setBusy(true);
          try {
            const doc = unwrapPersona(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(p.id) + '/key', { apiKey: keyValue.trim() }, { parse: 'always' }));
            setKeyInfo(doc.key || keyInfo); setKeyValue('');
            setNote({ ok: true, text: weT('Key 已保存') });
          } catch { setNote({ ok: false, text: weT('Key 保存失败') }); } finally { setBusy(false); }
        }, { primary: true, disabled: busy }),
        personaButton(weT('测试'), async () => {
          setBusy(true);
          try {
            const doc = unwrapPersona(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(p.id) + '/key/test', {}, { parse: 'always' }));
            setNote({ ok: doc.ok === true, text: doc.ok ? weT('连接成功') : (doc.message || doc.code || weT('连接失败')) });
          } catch { setNote({ ok: false, text: weT('连接失败') }); } finally { setBusy(false); }
        }, { disabled: busy }))),
    React.createElement('div', { className: 'we-picker__hint', style: { fontSize: '10px', opacity: .7 } }, weT('留空/继承全局时使用「全局默认」里保存的模型与 Key。')));

  const cardPage = React.createElement('div', null,
    personaField(weT('核心身份'), personaTextarea({ rows: 6, value: p.core.identity, onChange: (v) => patchDraft((d) => { d.core.identity = v; }) })),
    personaField(weT('价值观（每行一条）'), personaTextarea({ rows: 3, value: (p.core.values || []).join('\n'), onChange: (v) => patchDraft((d) => { d.core.values = v.split('\n').map((x) => x.trim()).filter(Boolean); }) })),
    personaField(weT('边界（每行一条）'), personaTextarea({ rows: 3, value: (p.core.boundaries || []).join('\n'), onChange: (v) => patchDraft((d) => { d.core.boundaries = v.split('\n').map((x) => x.trim()).filter(Boolean); }) })),
    personaField(weT('说话习惯（每行一条）'), personaTextarea({ rows: 3, value: (p.core.speechHabits || []).join('\n'), onChange: (v) => patchDraft((d) => { d.core.speechHabits = v.split('\n').map((x) => x.trim()).filter(Boolean); }) })),
    personaField(weT('示例对话（空行分隔）'), personaTextarea({ rows: 4, value: (p.core.exampleDialogues || []).join('\n\n'), onChange: (v) => patchDraft((d) => { d.core.exampleDialogues = v.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean); }) })),
    personaField(weT('世界书（JSON 数组：keys/content/priority）'), personaTextarea({
      rows: 4, value: JSON.stringify(p.core.worldBook || [], null, 2),
      onChange: (v) => patchDraft((d) => { try { d.core.worldBook = JSON.parse(v || '[]'); } catch { /* 输入中不报错 */ } }),
    })),
    personaField(weT('开场白 first_mes'), personaTextarea({ rows: 3, value: p.card.firstMes, onChange: (v) => patchDraft((d) => { d.card.firstMes = v; }) })),
    personaField(weT('场景 scenario'), personaTextarea({ rows: 2, value: p.card.scenario, onChange: (v) => patchDraft((d) => { d.card.scenario = v; }) })),
    personaField(weT('角色卡系统提示'), personaTextarea({ rows: 3, value: p.card.systemPrompt, onChange: (v) => patchDraft((d) => { d.card.systemPrompt = v; }) })),
    React.createElement('div', { style: PERSONA_STYLE.row },
      personaButton(weT('导入角色卡（JSON/PNG）'), () => personaPickFile('.json,.png,image/png', uploadCard), { disabled: busy }),
      personaButton(weT('导出 CCv2 JSON'), () => { try { window.open(apiUrl('/pet-chat/personas/' + encodeURIComponent(p.id) + '/export-card'), '_blank'); } catch { /* ignore */ } }),
      personaButton(weT('导出 PNG 卡'), () => { try { window.open(apiUrl('/pet-chat/personas/' + encodeURIComponent(p.id) + '/export-card.png'), '_blank'); } catch { /* ignore */ } })));

  const eventCards = memory.items.map((event) => React.createElement('div', { key: event.id, style: PERSONA_STYLE.card },
    React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
      React.createElement('div', { style: { fontSize: '11px' } }, new Date(event.ts).toLocaleString() + ' · ' + event.kind),
      personaButton(weT('删除'), async () => {
        try {
          await apiFetch('/pet-chat/personas/' + encodeURIComponent(p.id) + '/memory/' + encodeURIComponent(event.id), { method: 'DELETE', parse: 'always' });
          void loadMemory(p.id, memory.q || '');
        } catch { /* ignore */ }
      })),
    React.createElement('div', { style: { marginTop: '3px', fontSize: '12px', whiteSpace: 'pre-wrap' } }, event.text)));
  const growthCards = memory.growth.map((trait) => React.createElement('div', { key: trait.at + trait.text, style: PERSONA_STYLE.card },
    React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
      React.createElement('div', null,
        React.createElement('div', null, trait.text),
        React.createElement('div', { style: { fontSize: '10px', opacity: .65 } }, `confidence=${trait.confidence} · ${new Date(trait.at).toLocaleString()}`)),
      personaButton(weT('删除'), async () => {
        try {
          await apiPostJson('/pet-chat/personas/' + encodeURIComponent(p.id) + '/growth/delete', { text: trait.text }, { parse: 'always' });
          void loadMemory(p.id, memory.q || '');
        } catch { /* ignore */ }
      }))));
  const memoryPage = React.createElement('div', null,
    React.createElement('div', { style: { ...PERSONA_STYLE.row, marginBottom: '6px' } },
      personaInput({ value: memory.q || '', placeholder: weT('搜索记忆…'), onChange: (v) => { void loadMemory(p.id, v); }, style: { flex: 1 } }),
      personaButton(weT('刷新'), () => { void loadMemory(p.id, memory.q || ''); })),
    React.createElement('div', { style: { fontSize: '11px', opacity: .75 } }, weT('事件 {n} 条（无上限、不过期）', { n: memory.total })),
    eventCards.length ? eventCards : React.createElement('div', { className: 'we-picker__hint' }, weT('还没有记忆。')),
    React.createElement('div', { style: { marginTop: '12px', fontSize: '13px', fontWeight: 600 } }, weT('它最近学到的')),
    growthCards.length ? growthCards : React.createElement('div', { className: 'we-picker__hint' }, weT('还没有成长项。')),
    React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '8px' } },
      personaInput({ type: 'date', value: memory.rollbackDate || '', onChange: (v) => setMemory((prev) => ({ ...prev, rollbackDate: v })), style: { width: '150px' } }),
      personaButton(weT('回滚到这一天'), async () => {
        if (!memory.rollbackDate) return;
        setBusy(true);
        try {
          const doc = unwrapPersona(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(p.id) + '/rollback', { date: memory.rollbackDate }, { parse: 'always' }));
          setNote({ ok: doc.ok === true, text: doc.ok ? weT('已回滚') : (doc.hint || weT('回滚失败')) });
          await loadPersona(p.id);
        } catch { setNote({ ok: false, text: weT('回滚失败') }); } finally { setBusy(false); }
      }, { disabled: busy })),
    note ? React.createElement('div', { className: 'we-picker__hint', style: { color: note.ok ? undefined : '#f87171' } }, note.text) : null);

  const voicePage = React.createElement('div', null,
    personaField(weT('音色'), personaSelect({
      value: p.express.voice.name || '', onChange: (v) => patchDraft((d) => { d.express.voice.name = v; }),
      options: [{ value: '', label: weT('自动 / 继承') }, ...voices.map((voice) => ({ value: voice.name, label: `${voice.name}（${voice.engine || ''}）` }))],
    })),
    personaField(weT('语速（-10…10）'), personaInput({ type: 'number', value: p.express.voice.rate, onChange: (v) => patchDraft((d) => { d.express.voice.rate = Number(v); }) })),
    personaField(weT('长度策略'), personaSelect({
      value: p.express.lengthPolicy, onChange: (v) => patchDraft((d) => { d.express.lengthPolicy = v; }),
      options: [{ value: 'adaptive', label: weT('自适应') }, { value: 'short', label: weT('短') }, { value: 'long', label: weT('长') }],
    })),
    React.createElement('div', { className: 'we-picker__hint', style: { fontSize: '10px', opacity: .7 } }, weT('语音模式由宿主按 1–3 句截断；这里保存的是该人设的音色与语速。')));

  const playPage = React.createElement('div', null,
    personaField(weT('玩法模式'), personaSelect({
      value: p.mode, onChange: (v) => patchDraft((d) => { d.mode = v; }),
      options: [{ value: 'chat', label: weT('聊天') }, { value: 'roleplay', label: weT('角色扮演') }, { value: 'story', label: weT('互动故事') }],
    })),
    personaField(weT('唤醒口令'), personaInput({ value: p.card.wakeKeyword || '', placeholder: weT('例如：我回来了'), onChange: (v) => patchDraft((d) => { d.card.wakeKeyword = v; }) })),
    personaField(weT('故事章节'), personaInput({ value: p.story.chapter, onChange: (v) => patchDraft((d) => { d.story.chapter = v; }) })),
    personaField(weT('当前场景'), personaTextarea({ rows: 3, value: p.story.scene, onChange: (v) => patchDraft((d) => { d.story.scene = v; }) })),
    React.createElement('div', { className: 'we-picker__hint' }, weT('角色扮演与互动故事会按人设卡中的场景/开场白注入；故事模式章末给 2–3 个选项。')));

  const permissionsPage = React.createElement('div', null,
    React.createElement('div', { style: { fontSize: '12px' } }, weT('助手人设可以使用系统工具（换壁纸、提醒、桌宠设置等）。')),
    React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '4px' } }, weT('特殊人设不使用任何系统工具；切换到「特殊人设」后这一页会隐藏。')));

  const pages = { basic: basicPage, model: modelPage, card: cardPage, memory: memoryPage, voice: voicePage, play: playPage, permissions: permissionsPage };
  return React.createElement('div', { id: 'we-persona-detail', style: { marginBottom: '14px' } },
    React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
      React.createElement('div', null,
        React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, draft.name || weT('未命名')),
        React.createElement('div', { style: { fontSize: '11px', opacity: .75 } }, `${personaTypeLabel(draft.type)} · ${personaModeLabel(draft.mode)}`)),
      React.createElement('div', { style: PERSONA_STYLE.row },
        draft.id !== list.activeId ? personaButton(weT('设为当前'), () => { void activate(draft.id); }, { primary: true }) : null,
        personaButton(weT('返回列表'), () => { setSelected(null); setDraft(null); void loadList(); }))),
    React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '6px', gap: '4px' } },
      tabList.map((item) => personaButton(item.label, () => setTab(item.id), {
        style: tab === item.id ? { borderColor: 'rgba(120,190,255,.7)' } : {},
      }))),
    React.createElement('div', { style: { marginTop: '8px' } }, pages[tab] || basicPage),
    saveRow,
    note ? React.createElement('div', { className: 'we-picker__hint', style: { color: note.ok ? undefined : '#f87171', marginTop: '5px' } }, note.text) : null);
}

export { PersonaSection };
