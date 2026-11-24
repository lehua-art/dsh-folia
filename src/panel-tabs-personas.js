/**
 * panel-tabs-personas.js — 「智能大肥鱼 → 人设」v2（pre.65 UI v2）。
 *
 * 信息架构：
 *   · 列表：我的助手 / 特殊人设 / 卡片库 三个页签；右上角只有“全局默认”状态徽标；
 *   · 列表页**没有 Key 输入**；全局 Key 只在状态徽标打开的弹窗里；
 *   · 助手走三步向导；特殊人设走“导入/卡片库一键使用”；
 *   · 详情子页按类型裁剪：
 *       assistant: 基本 / 模型与 Key / 记忆 / 声音 / 权限
 *       character: 基本 / 模型与 Key / 人设卡 / 剧情 / 声音
 *
 * 全部 React.createElement（构建期内联），不新增 npm 依赖。
 */
const PERSONA_STYLE = {
  card: {
    border: '1px solid rgba(255,255,255,.10)', borderRadius: '12px', padding: '10px 12px',
    margin: '8px 0', background: 'rgba(255,255,255,.025)', fontSize: '12px',
  },
  cardActive: { borderColor: 'rgba(120,190,255,.65)', boxShadow: '0 0 0 1px rgba(120,190,255,.15) inset' },
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
  danger: {
    border: '1px solid rgba(248,113,113,.35)', borderRadius: '8px', padding: '4px 10px',
    background: 'rgba(248,113,113,.08)', color: 'inherit', cursor: 'pointer', fontSize: '11px',
  },
  row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  label: { fontSize: '11px', opacity: .78, margin: '7px 0 3px' },
  badge: {
    display: 'inline-block', padding: '1px 7px', borderRadius: '999px', fontSize: '10px',
    border: '1px solid rgba(255,255,255,.18)', background: 'rgba(255,255,255,.04)', marginLeft: '5px',
  },
  badgeOk: { borderColor: 'rgba(74,222,128,.45)', color: '#86efac' },
  badgeWarn: { borderColor: 'rgba(251,191,36,.45)', color: '#fcd34d' },
};

const PERSONA_BASE_TABS = [
  { id: 'basic', label: '基本' },
  { id: 'model', label: '模型与 Key' },
  { id: 'memory', label: '记忆' },
  { id: 'voice', label: '声音' },
  { id: 'permissions', label: '权限' },
];
const CHARACTER_TABS = [
  { id: 'basic', label: '基本' },
  { id: 'model', label: '模型与 Key' },
  { id: 'card', label: '人设卡' },
  { id: 'story', label: '剧情' },
  { id: 'voice', label: '声音' },
];
const LIST_TABS = [
  { id: 'assistants', label: '我的助手' },
  { id: 'characters', label: '特殊人设' },
  { id: 'library', label: '卡片库' },
];

const unwrap = (resp) => (resp && resp.data && resp.data.data) || (resp && resp.data) || {};
const clone = (value) => JSON.parse(JSON.stringify(value));
const personaName = (p) => String((p && p.name) || '').trim() || (p && p.type === 'character' ? '未命名角色' : '助手');

function personaInput(props) {
  return React.createElement('input', {
    type: props.type || 'text', value: props.value == null ? '' : String(props.value),
    placeholder: props.placeholder || '', onChange: (e) => props.onChange(e.target.value),
    disabled: props.disabled === true,
    list: props.list,
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
    React.createElement('div', { style: PERSONA_STYLE.label }, label), child,
    hint ? React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '2px', fontSize: '10px', opacity: .7 } }, hint) : null);
}

function personaButton(label, onClick, opts = {}) {
  return React.createElement('button', {
    type: 'button', disabled: opts.disabled === true, onClick,
    style: { ...(opts.danger ? PERSONA_STYLE.danger : (opts.primary ? PERSONA_STYLE.primary : PERSONA_STYLE.ghost)), ...(opts.style || {}) },
  }, label);
}

function KeyBadge({ status }) {
  if (!status) return null;
  const ok = Boolean(status.configured);
  return React.createElement('span', {
    style: { ...PERSONA_STYLE.badge, ...(ok ? PERSONA_STYLE.badgeOk : PERSONA_STYLE.badgeWarn) },
  }, status.label || (status.mode === 'inherit' ? '继承全局' : '独立 Key'));
}

function personaModeLabel(mode) {
  if (mode === 'roleplay') return '角色扮演';
  if (mode === 'story') return '互动故事';
  return '聊天';
}

function personaTypeLabel(type) {
  return type === 'character' ? '特殊人设' : '助手';
}

function pickFile(accept, onFile) {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = accept; input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { onFile(file, String(reader.result || '')); } catch { /* ignore */ }
      try { input.remove(); } catch { /* ignore */ }
    };
    reader.readAsDataURL(file);
  });
  document.body.appendChild(input);
  input.click();
}

function GlobalKeyModal({ form, setForm, keyValue, setKeyValue, info, busy, onSave, onTest, onClose, note }) {
  return React.createElement('div', {
    style: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.52)', zIndex: 30,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
    },
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); },
  },
  React.createElement('div', {
    style: {
      width: 'min(520px,92vw)', maxHeight: '86vh', overflow: 'auto', background: '#1b1d22',
      border: '1px solid rgba(255,255,255,.16)', borderRadius: '14px', padding: '14px',
    },
  },
  React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
    React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, '全局默认'),
    personaButton('关闭', onClose)),
  React.createElement('div', { className: 'we-picker__hint', style: { margin: '2px 0 8px' } },
    '只给“继承全局”的人设使用；Key 不会出现在人设列表里。'),
  personaField('接口协议', personaSelect({
    value: form.provider || 'openai', onChange: (v) => setForm((prev) => ({ ...prev, provider: v })),
    options: [{ value: 'openai', label: 'OpenAI 兼容' }, { value: 'ollama', label: 'Ollama' }],
  })),
  personaField('接口地址', personaInput({ value: form.baseUrl || '', placeholder: 'https://api.deepseek.com', onChange: (v) => setForm((prev) => ({ ...prev, baseUrl: v })) })),
  personaField('模型名', personaInput({ value: form.model || '', placeholder: 'deepseek-chat', onChange: (v) => setForm((prev) => ({ ...prev, model: v })) })),
  personaField(info && info.hasApiKey ? `Key（已保存：${info.maskedKey || info.apiKeyMasked || '已配置'}）` : 'Key',
    personaInput({ type: 'password', value: keyValue, placeholder: '留空则不修改', onChange: setKeyValue }),
    '只写不读；测试连接会使用这里填的 Key，或已保存的 Key。'),
  React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '6px' } },
    personaButton('保存', onSave, { primary: true, disabled: busy }),
    personaButton('测试', onTest, { disabled: busy }),
    personaButton('取消', onClose))),
  note ? React.createElement('div', { className: 'we-picker__hint', style: { color: note.ok ? undefined : '#f87171', marginTop: '6px' } }, note.text) : null);
}

function PersonaSection() {
  const [view, setView] = React.useState('list');
  const [listTab, setListTab] = React.useState('assistants');
  const [list, setList] = React.useState({ loading: true, items: [], activeId: '', global: null });
  const [selected, setSelected] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [detailTab, setDetailTab] = React.useState('basic');
  const [keyInfo, setKeyInfo] = React.useState({ hasKey: false, maskedKey: '' });
  const [keyStatus, setKeyStatus] = React.useState(null);
  const [globalInfo, setGlobalInfo] = React.useState(null);
  const [keyValue, setKeyValue] = React.useState('');
  const [globalOpen, setGlobalOpen] = React.useState(false);
  const [globalForm, setGlobalForm] = React.useState({ provider: 'openai', baseUrl: '', model: '' });
  const [globalKey, setGlobalKey] = React.useState('');
  const [globalNote, setGlobalNote] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState(null);
  const [memory, setMemory] = React.useState({ loading: false, items: [], growth: [], total: 0, q: '' });
  const [voices, setVoices] = React.useState([]);
  const [voiceCatalog, setVoiceCatalog] = React.useState(null);
  const [voiceBusy, setVoiceBusy] = React.useState('');
  const [previewId, setPreviewId] = React.useState('');
  const [pendingPreview, setPendingPreview] = React.useState('');
  const [voiceNote, setVoiceNote] = React.useState(null);
  const [volcOpen, setVolcOpen] = React.useState(false);
  const [howToOpen, setHowToOpen] = React.useState(false);
  const [volcForm, setVolcForm] = React.useState({
    appId: '', accessToken: '', cluster: 'volcano_tts', resourceId: 'seed-tts-2.0',
    subtype: 'volc-seed-tts', voiceId: 'zh_female_shuangkuaisisi_uranus_bigtts',
  });
  const [volcNote, setVolcNote] = React.useState(null);
  const [perm, setPerm] = React.useState({ loading: false, advanced: false, groups: [], toolLog: { items: [], total: 0 }, isCharacter: false, message: '' });
  const [permBusy, setPermBusy] = React.useState(false);
  const [permNote, setPermNote] = React.useState(null);
  const [wizard, setWizard] = React.useState({ step: 1, name: '', nickname: '', tone: '温柔', relation: '' });
  const [doc, setDoc] = React.useState(null);
  const [library, setLibrary] = React.useState({ loading: false, cards: [], categories: [], q: '', category: 'all' });
  const [previewCard, setPreviewCard] = React.useState(null);
  const [opening, setOpening] = React.useState(null);

  const loadList = React.useCallback(async () => {
    setList((prev) => ({ ...prev, loading: true }));
    try {
      const data = unwrap(await apiJson('/pet-chat/personas', { parse: 'always' }));
      setList({
        loading: false,
        items: Array.isArray(data.personas) ? data.personas : [],
        activeId: String(data.activeId || ''),
        global: data.global || null,
      });
      if (data.global) setGlobalInfo(data.global);
    } catch {
      setList({ loading: false, items: [], activeId: '', global: null });
    }
  }, []);

  React.useEffect(() => { void loadList(); }, [loadList]);

  const refreshVoice = React.useCallback(() => {
    try { if (typeof petChatRefreshVoice === 'function') void petChatRefreshVoice(); } catch { /* ignore */ }
  }, []);

  const openGlobal = async () => {
    setGlobalOpen(true);
    setGlobalNote(null);
    setGlobalKey('');
    try {
      const data = unwrap(await apiJson('/pet-chat/config', { parse: 'always' }));
      setGlobalInfo(data);
      setGlobalForm({ provider: data.provider || 'openai', baseUrl: data.baseUrl || '', model: data.model || '' });
    } catch { /* leave form */ }
  };

  const saveGlobal = async () => {
    setBusy(true);
    try {
      const body = { provider: globalForm.provider, baseUrl: globalForm.baseUrl, model: globalForm.model };
      if (globalKey.trim()) body.apiKey = globalKey.trim();
      const data = unwrap(await apiPostJson('/pet-chat/config', body, { parse: 'always' }));
      if (data.ok === false) throw new Error(data.error || 'save-failed');
      setGlobalNote({ ok: true, text: '全局默认已保存' });
      setGlobalKey('');
      await openGlobal();
      await loadList();
    } catch { setGlobalNote({ ok: false, text: '保存失败' }); } finally { setBusy(false); }
  };

  const testGlobal = async () => {
    setBusy(true);
    try {
      const body = { provider: globalForm.provider, baseUrl: globalForm.baseUrl, model: globalForm.model };
      if (globalKey.trim()) body.apiKey = globalKey.trim();
      const data = unwrap(await apiPostJson('/pet-chat/test', body, { parse: 'always' }));
      setGlobalNote({ ok: data.ok === true, text: data.ok ? '连接成功' : (data.message || data.code || '连接失败') });
    } catch { setGlobalNote({ ok: false, text: '连接失败' }); } finally { setBusy(false); }
  };

  const loadLibrary = React.useCallback(async (q = '', category = 'all') => {
    setLibrary((prev) => ({ ...prev, loading: true, q, category }));
    try {
      const query = `?q=${encodeURIComponent(q)}&category=${encodeURIComponent(category)}`;
      const data = unwrap(await apiJson('/pet-chat/personas/library' + query, { parse: 'always' }));
      setLibrary({ loading: false, cards: Array.isArray(data.cards) ? data.cards : [], categories: Array.isArray(data.categories) ? data.categories : [], q, category });
    } catch { setLibrary((prev) => ({ ...prev, loading: false })); }
  }, []);

  React.useEffect(() => {
    if (view === 'list' && listTab === 'library' && !library.cards.length) void loadLibrary();
  }, [view, listTab, library.cards.length, loadLibrary]);

  const openPersona = async (id, tab = 'basic') => {
    setBusy(true);
    try {
      const data = unwrap(await apiJson('/pet-chat/personas/' + encodeURIComponent(id), { parse: 'always' }));
      if (!data.persona) throw new Error('not-found');
      setSelected(data.persona);
      setDraft(clone(data.persona));
      setKeyInfo(data.key || { hasKey: false, maskedKey: '' });
      setKeyStatus(data.keyStatus || null);
      setGlobalInfo(data.global || null);
      setDetailTab(tab);
      setView('detail');
      setNote(null);
    } catch { setNote({ ok: false, text: '读取人设失败' }); } finally { setBusy(false); }
  };

  const saveDetail = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const payload = {
        name: draft.name, avatar: draft.avatar, type: draft.type, mode: draft.mode,
        model: draft.model, core: draft.core, express: draft.express, card: draft.card, story: draft.story,
      };
      const data = unwrap(await apiFetch('/pet-chat/personas/' + encodeURIComponent(draft.id), {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), parse: 'always',
      }));
      if (!data.ok) throw new Error(data.hint || 'save-failed');
      setSelected(data.persona); setDraft(clone(data.persona));
      setKeyInfo(data.key || keyInfo);
      setKeyStatus(data.keyStatus || keyStatus);
      await loadList(); refreshVoice();
      setNote({ ok: true, text: '已保存' });
    } catch { setNote({ ok: false, text: '保存失败' }); } finally { setBusy(false); }
  };

  const activate = async (id) => {
    setBusy(true);
    try {
      await apiPostJson('/pet-chat/personas/' + encodeURIComponent(id) + '/active', {}, { parse: 'always' });
      await loadList(); refreshVoice();
      setNote({ ok: true, text: '已切换当前人设' });
    } catch { setNote({ ok: false, text: '切换失败' }); } finally { setBusy(false); }
  };

  const remove = async (persona) => {
    const name = personaName(persona);
    if (typeof window !== 'undefined' && typeof window.confirm === 'function'
      && !window.confirm(`删除「${name}」会同时删除它的全部记忆，确定吗？`)) return;
    setBusy(true);
    try {
      const data = unwrap(await apiFetch('/pet-chat/personas/' + encodeURIComponent(persona.id) + '?confirm=1', {
        method: 'DELETE', parse: 'always',
      }));
      if (!data.ok) throw new Error(data.hint || 'delete-failed');
      if (selected && selected.id === persona.id) { setSelected(null); setDraft(null); setView('list'); }
      await loadList(); refreshVoice();
      setNote({ ok: true, text: '人设已删除' });
    } catch { setNote({ ok: false, text: '删除失败' }); } finally { setBusy(false); }
  };

  const createWizard = async () => {
    setBusy(true);
    try {
      const data = unwrap(await apiPostJson('/pet-chat/personas/wizard', {
        name: wizard.name, nickname: wizard.nickname, tone: wizard.tone, relation: wizard.relation,
      }, { parse: 'always' }));
      if (!data.ok) throw new Error(data.hint || 'create-failed');
      await loadList();
      setWizard({ step: 1, name: '', nickname: '', tone: '温柔', relation: '' });
      setOpening({ title: `已创建「${personaName(data.persona)}」`, text: data.opening || '', kind: 'assistant' });
      await openPersona(data.persona.id);
    } catch { setNote({ ok: false, text: '创建助手失败' }); } finally { setBusy(false); }
  };

  const useLibrary = async (card) => {
    setBusy(true);
    try {
      const data = unwrap(await apiPostJson('/pet-chat/personas/library/' + encodeURIComponent(card.id) + '/use', {}, { parse: 'always' }));
      if (!data.ok) throw new Error(data.hint || 'use-failed');
      setPreviewCard(null); setListTab('characters'); setView('list');
      setOpening({ title: `已唤醒「${personaName(data.persona)}」`, text: data.opening || '', kind: 'character' });
      await loadList(); refreshVoice();
    } catch { setNote({ ok: false, text: '使用卡片失败' }); } finally { setBusy(false); }
  };

  const importDocument = (file, dataUrl) => {
    const base64 = String(dataUrl).split(',')[1] || '';
    setBusy(true); setDoc({ loading: true, fileName: file.name, card: null, text: '', warnings: [] });
    apiPostJson('/pet-chat/personas/import-document', {
      fileName: file.name, mime: file.type || '', base64,
    }, { parse: 'always' }).then((resp) => {
      const data = unwrap(resp);
      if (!data.ok) throw new Error(data.hint || 'import-failed');
      setDoc({ loading: false, fileName: file.name, card: data.card, text: data.text || '', warnings: data.warnings || [], usedModel: data.usedModel, kind: data.kind });
      setView('import');
    }).catch(() => setDoc({ loading: false, fileName: file.name, card: null, text: '', warnings: [], error: true }))
      .finally(() => setBusy(false));
  };

  const saveDoc = async () => {
    if (!doc || !doc.card) return;
    setBusy(true);
    try {
      const card = clone(doc.card);
      if (doc.worldBookText !== undefined) {
        try { card.data.character_book = { entries: JSON.parse(doc.worldBookText || '[]') }; } catch { throw new Error('world-book-json'); }
      }
      const data = unwrap(await apiPostJson('/pet-chat/personas/from-draft', {
        card, mode: doc.mode || 'roleplay', fileName: doc.fileName, rawText: doc.text, active: true,
      }, { parse: 'always' }));
      if (!data.ok) throw new Error(data.hint || 'save-failed');
      setDoc(null);
      setOpening({ title: `已收下「${personaName(data.persona)}」`, text: data.opening || '', kind: 'character' });
      await loadList(); refreshVoice();
      await openPersona(data.persona.id);
    } catch { setNote({ ok: false, text: '保存卡片失败' }); } finally { setBusy(false); }
  };

  const loadMemory = React.useCallback(async (id, q = '') => {
    setMemory((prev) => ({ ...prev, loading: true, q }));
    try {
      const data = unwrap(await apiJson('/pet-chat/personas/' + encodeURIComponent(id) + '/memory?limit=50&q=' + encodeURIComponent(q), { parse: 'always' }));
      setMemory({ loading: false, q, items: Array.isArray(data.items) ? data.items : [], growth: Array.isArray(data.growth) ? data.growth : [], total: Number(data.total) || 0 });
    } catch { setMemory((prev) => ({ ...prev, loading: false })); }
  }, []);

  const loadVoices = React.useCallback(async () => {
    try {
      const data = unwrap(await apiJson('/pet-chat/tts/voices', { parse: 'always' }));
      // 保留全部音色：不可用的也显示并标注（Edge 429 时不能只剩一项）
      setVoices(Array.isArray(data.voices) ? data.voices.filter((v) => v && (v.id || v.name)) : []);
    } catch { setVoices([]); }
  }, []);

  /** v2：声音页的统一目录（内置包 / Edge / 火山）。 */
  const loadVoiceCatalog = React.useCallback(async () => {
    try {
      const data = unwrap(await apiJson('/pet-chat/voice/catalog', { parse: 'always' }));
      setVoiceCatalog(data);
      const volc = (data.center && data.center.volcengine) || {};
      setVolcForm((prev) => ({
        ...prev,
        cluster: volc.cluster || prev.cluster,
        resourceId: volc.resourceId || prev.resourceId,
        subtype: volc.subtype || prev.subtype,
        voiceId: volc.voiceId || prev.voiceId,
        appId: '',
        accessToken: '',
      }));
    } catch {
      setVoiceCatalog({ groups: [], packs: [], center: null, howTo: [] });
    }
  }, []);

  const loadPermissions = React.useCallback(async (id) => {
    setPerm((prev) => ({ ...prev, loading: true }));
    try {
      const data = unwrap(await apiJson('/pet-chat/personas/' + encodeURIComponent(id) + '/permissions', { parse: 'always' }));
      let log = { items: [], total: 0 };
      try { log = unwrap(await apiJson('/pet-chat/personas/' + encodeURIComponent(id) + '/tool-log?limit=10', { parse: 'always' })); } catch { /* ignore */ }
      setPerm({
        loading: false,
        advanced: data.advanced === true,
        groups: Array.isArray(data.groups) ? data.groups : [],
        isCharacter: data.isCharacter === true,
        message: String(data.message || ''),
        toolLog: { items: Array.isArray(log.items) ? log.items : [], total: Number(log.total) || 0 },
      });
    } catch {
      setPerm((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  /** 下载/删除/设默认之后把包状态合并回目录（不重新拉 Edge 列表）。 */
  const mergePackState = (packs) => {
    setVoiceCatalog((prev) => {
      if (!prev) return prev;
      const byId = new Map((packs || []).map((pack) => [pack.id, pack]));
      const groups = (prev.groups || []).map((group) => {
        if (group.key !== 'builtin') return group;
        return {
          ...group,
          items: (group.items || []).map((item) => {
            const pack = byId.get(item.packId);
            if (!pack) return item;
            return {
              ...item,
              installed: pack.installed,
              status: pack.status,
              reason: pack.reason,
              progress: pack.progress,
              sizeMB: pack.sizeMB,
              sizeBytes: pack.sizeBytes,
            };
          }),
        };
      });
      return { ...prev, groups, packs: packs || prev.packs };
    });
  };

  const refreshPacks = React.useCallback(async () => {
    try {
      const data = unwrap(await apiJson('/pet-chat/voice/packs', { parse: 'always' }));
      if (Array.isArray(data.packs)) mergePackState(data.packs);
      return data;
    } catch { return null; }
  }, []);

  const previewVoice = React.useCallback(async (id) => {
    if (!id) return;
    setPreviewId(id);
    setVoiceNote(null);
    try {
      const resp = await apiFetch('/pet-chat/voice/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }), parse: false,
      });
      if (!resp || !resp.ok) {
        let hint = '';
        try {
          const doc = await resp.response.json();
          hint = doc && (doc.hint || doc.code);
        } catch { /* ignore */ }
        setVoiceNote({ ok: false, text: hint || '试听失败（音色未就绪或网络不可用）' });
        setPreviewId('');
        return;
      }
      const blob = await resp.response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      const cleanup = () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } setPreviewId(''); };
      audio.onended = cleanup;
      audio.onerror = () => { cleanup(); setVoiceNote({ ok: false, text: '试听音频播放失败' }); };
      const played = audio.play();
      if (played && typeof played.catch === 'function') {
        played.catch(() => { cleanup(); setVoiceNote({ ok: false, text: '浏览器拦截了自动播放，再点一次 ▶' }); });
      }
    } catch {
      setPreviewId('');
      setVoiceNote({ ok: false, text: '试听请求失败' });
    }
  }, []);

  // 下载中：每 1.5s 合并一次进度；安装完成且有待试听 → 自动播放。
  React.useEffect(() => {
    if (!voiceCatalog || detailTab !== 'voice') return undefined;
    const downloading = (voiceCatalog.packs || []).some((pack) => pack.status === 'downloading');
    if (!downloading) return undefined;
    const timer = setInterval(() => {
      void refreshPacks().then((data) => {
        if (!data || !pendingPreview) return;
        const ready = (data.packs || []).find((pack) => pack.installed && pack.voiceId === pendingPreview);
        if (ready) {
          setPendingPreview('');
          void previewVoice(pendingPreview);
        }
      });
    }, 1500);
    return () => clearInterval(timer);
  }, [voiceCatalog, detailTab, pendingPreview, refreshPacks, previewVoice]);

  React.useEffect(() => {
    if (!selected) return;
    if (detailTab === 'memory') void loadMemory(selected.id, '');
    if (detailTab === 'voice' && !voices.length) void loadVoices();
    if (detailTab === 'voice' && !voiceCatalog) void loadVoiceCatalog();
    if (detailTab === 'permissions') void loadPermissions(selected.id);
  }, [selected, detailTab, loadMemory, loadVoices, voices.length, voiceCatalog, loadVoiceCatalog, loadPermissions]);

  const packAction = async (kind, pack) => {
    if (!pack) return;
    setVoiceBusy(kind + ':' + pack.id);
    setVoiceNote(null);
    try {
      if (kind === 'install') {
        const data = unwrap(await apiPostJson('/pet-chat/voice/packs/install', { id: pack.id }, { parse: 'always' }));
        if (!data.ok) throw new Error(data.hint || 'install-failed');
        setPendingPreview(pack.voiceId || '');
        setVoiceNote({ ok: true, text: `开始下载「${pack.name}」；完成后会自动试听。` });
        await refreshPacks();
      } else if (kind === 'remove') {
        const data = unwrap(await apiPostJson('/pet-chat/voice/packs/remove', { id: pack.id }, { parse: 'always' }));
        if (!data.ok) throw new Error(data.hint || 'remove-failed');
        setVoiceNote({ ok: true, text: `已删除「${pack.name}」（共享运行时与其它包不受影响）。` });
        await loadVoiceCatalog();
      } else if (kind === 'default') {
        const data = unwrap(await apiPostJson('/pet-chat/voice/packs/default', { id: pack.id }, { parse: 'always' }));
        if (!data.ok) throw new Error(data.hint || 'default-failed');
        setVoiceNote({ ok: true, text: `全局默认已设为「${pack.name}」。` });
        await loadVoiceCatalog();
      }
    } catch (error) {
      setVoiceNote({ ok: false, text: String((error && error.message) || '操作失败') });
    } finally {
      setVoiceBusy('');
    }
  };

  const setGlobalDefaultVoice = async (id, label) => {
    setVoiceBusy('default:' + id);
    setVoiceNote(null);
    try {
      const data = unwrap(await apiPostJson('/pet-chat/voice/preferred', { voiceId: id }, { parse: 'always' }));
      if (!data.ok) throw new Error(data.hint || 'default-failed');
      setVoiceNote({ ok: true, text: `全局默认已设为「${label || id}」。` });
      await loadVoiceCatalog();
    } catch (error) {
      setVoiceNote({ ok: false, text: String((error && error.message) || '设置失败') });
    } finally {
      setVoiceBusy('');
    }
  };

  const saveVolc = async () => {
    setVoiceBusy('volc-save');
    setVolcNote(null);
    try {
      const data = unwrap(await apiPostJson('/pet-chat/voice/providers', {
        provider: 'volcengine',
        appId: volcForm.appId,
        accessToken: volcForm.accessToken,
        cluster: volcForm.cluster,
        resourceId: volcForm.resourceId,
        subtype: volcForm.subtype,
        voiceId: volcForm.voiceId,
      }, { parse: 'always' }));
      if (!data.ok) throw new Error(data.error || 'save-failed');
      setVolcNote({ ok: true, text: '火山配置已保存（AppID/Token 只写不读）。' });
      await loadVoiceCatalog();
    } catch (error) {
      setVolcNote({ ok: false, text: String((error && error.message) || '保存失败') });
    } finally { setVoiceBusy(''); }
  };

  const testVolc = async () => {
    setVoiceBusy('volc-test');
    setVolcNote({ ok: true, text: '正在真调火山（最长 25 秒）…' });
    try {
      if (volcForm.appId.trim() || volcForm.accessToken.trim()) {
        const saved = unwrap(await apiPostJson('/pet-chat/voice/providers', {
          provider: 'volcengine',
          appId: volcForm.appId,
          accessToken: volcForm.accessToken,
          cluster: volcForm.cluster,
          resourceId: volcForm.resourceId,
          subtype: volcForm.subtype,
          voiceId: volcForm.voiceId,
        }, { parse: 'always' }));
        if (!saved.ok) throw new Error(saved.error || 'save-failed');
      }
      const data = unwrap(await apiPostJson('/pet-chat/voice/providers/test', { provider: 'volcengine' }, { parse: 'always' }));
      if (data.ok) {
        const fallback = data.fallback ? '（在线失败，已回落内置音色）' : '';
        setVolcNote({ ok: true, text: `火山已接通：${data.actualVoice || volcForm.voiceId}${fallback}` });
      } else {
        setVolcNote({ ok: false, text: String(data.error || '测试失败') });
      }
      await loadVoiceCatalog();
    } catch (error) {
      setVolcNote({ ok: false, text: String((error && error.message) || '测试失败') });
    } finally { setVoiceBusy(''); }
  };

  const setPermissionGroup = async (group, level) => {
    if (!draft) return;
    setPermBusy(true);
    setPermNote(null);
    try {
      const data = unwrap(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(draft.id) + '/permissions', { group, level }, { parse: 'always' }));
      if (!data.ok) throw new Error(data.hint || data.message || 'save-failed');
      setPermNote({ ok: true, text: '权限已保存' });
      await loadPermissions(draft.id);
    } catch (error) {
      setPermNote({ ok: false, text: String((error && error.message) || '保存失败') });
      await loadPermissions(draft.id);
    } finally { setPermBusy(false); }
  };

  const setAdvancedPermission = async (advanced) => {
    if (!draft) return;
    setPermBusy(true);
    setPermNote(null);
    try {
      const data = unwrap(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(draft.id) + '/permissions', { advanced }, { parse: 'always' }));
      if (!data.ok) throw new Error(data.hint || 'save-failed');
      setPermNote({ ok: true, text: advanced ? '高级权限已打开（系统操作仍需逐次确认）' : '高级权限已关闭（系统操作不可用）' });
      await loadPermissions(draft.id);
    } catch (error) {
      setPermNote({ ok: false, text: String((error && error.message) || '保存失败') });
    } finally { setPermBusy(false); }
  };

  const clearToolLog = async () => {
    if (!draft) return;
    setPermBusy(true);
    try {
      await apiFetch('/pet-chat/personas/' + encodeURIComponent(draft.id) + '/tool-log', { method: 'DELETE', parse: 'always' });
      await loadPermissions(draft.id);
      setPermNote({ ok: true, text: '调用记录已清空' });
    } catch {
      setPermNote({ ok: false, text: '清空失败' });
    } finally { setPermBusy(false); }
  };

  const patchDraft = (fn) => setDraft((prev) => { const next = clone(prev); fn(next); return next; });



  const saveKey = async (mode) => {
    if (!draft) return;
    setBusy(true);
    try {
      const body = { mode };
      if (keyValue.trim()) body.apiKey = keyValue.trim();
      const data = unwrap(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(draft.id) + '/key', body, { parse: 'always' }));
      setKeyInfo(data.key || keyInfo); setKeyStatus(data.keyStatus || null); setGlobalInfo(data.global || globalInfo);
      setKeyValue('');
      setNote({ ok: true, text: mode === 'inherit' ? '已改为继承全局' : '独立 Key 已保存' });
      await loadList();
    } catch { setNote({ ok: false, text: 'Key 保存失败' }); } finally { setBusy(false); }
  };

  const testKey = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const data = unwrap(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(draft.id) + '/key/test', {}, { parse: 'always' }));
      setNote({ ok: data.ok === true, text: data.ok ? '连接成功' : (data.message || data.code || '连接失败') });
    } catch { setNote({ ok: false, text: '连接失败' }); } finally { setBusy(false); }
  };

  const listHeader = (title, extra) => React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between', marginBottom: '6px' } },
    React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, title),
    React.createElement('div', { style: PERSONA_STYLE.row }, extra));

  const globalBadge = () => {
    const has = Boolean(list.global && list.global.hasKey);
    return personaButton(`⚙ 全局默认 ${has ? '已配置' : '未配置'}`,
      () => { void openGlobal(); },
      { style: { borderColor: has ? 'rgba(74,222,128,.45)' : 'rgba(251,191,36,.35)' } });
  };

  const openingCard = () => {
    if (!opening) return null;
    return React.createElement('div', { style: { ...PERSONA_STYLE.card, borderColor: 'rgba(120,190,255,.55)' } },
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, opening.title),
      React.createElement('div', { style: { marginTop: '4px', whiteSpace: 'pre-wrap', lineHeight: 1.55 } }, opening.text || ''),
      React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '6px' } },
        personaButton('去对话', () => {
          setOpening(null);
          try { window.dispatchEvent(new CustomEvent('we-pet-talk')); } catch { /* ignore */ }
        }, { primary: true }),
        personaButton('知道了', () => setOpening(null))));
  };

  const personaListCard = (p) => React.createElement('div', {
    key: p.id,
    style: { ...PERSONA_STYLE.card, ...(p.id === list.activeId ? PERSONA_STYLE.cardActive : {}) },
  },
  React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between', alignItems: 'flex-start' } },
    React.createElement('div', { style: { minWidth: 0 } },
      React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } },
        personaName(p),
        p.id === list.activeId ? React.createElement('span', { style: { ...PERSONA_STYLE.badge, ...PERSONA_STYLE.badgeOk } }, '当前使用') : null,
        React.createElement(KeyBadge, { status: p.keyStatus })),
      React.createElement('div', { style: { fontSize: '11px', opacity: .72, marginTop: '2px' } },
        `${personaTypeLabel(p.type)} · ${personaModeLabel(p.mode)} · 记忆 `,
        React.createElement('a', {
          href: '#', style: { color: 'inherit', textDecoration: 'underline' },
          onClick: (e) => { e.preventDefault(); void openPersona(p.id, 'memory'); },
        }, String(p.memoryCount || 0)),
        p.growthCount ? ` · 成长 ${p.growthCount}` : ''),
      p.tags && p.tags.length
        ? React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '4px', marginTop: '4px' } },
          p.tags.slice(0, 4).map((tag) => React.createElement('span', { key: tag, style: PERSONA_STYLE.badge }, tag)))
        : null),
    React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'flex-end' } },
      p.id !== list.activeId ? personaButton('切换', () => { void activate(p.id); }) : null,
      personaButton('进入', () => { void openPersona(p.id); }, { primary: p.id === list.activeId }),
      personaButton('删除', () => { void remove(p); }, { danger: true }))));

  const assistantTab = () => {
    const items = list.items.filter((p) => p.type === 'assistant');
    return React.createElement('div', null,
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between', margin: '4px 0 6px' } },
        React.createElement('div', { style: { fontSize: '11px', opacity: .72 } }, '从零开始养一个会记得你的助手。'),
        personaButton('＋ 新建助手', () => { setWizard({ step: 1, name: '', nickname: '', tone: '温柔', relation: '' }); setView('wizard'); }, { primary: true })),
      items.length ? items.map(personaListCard) : React.createElement('div', { className: 'we-picker__hint' }, '还没有助手。点「＋ 新建助手」开始。'));
  };

  const characterTab = () => {
    const items = list.items.filter((p) => p.type === 'character');
    return React.createElement('div', null,
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between', margin: '4px 0 6px' } },
        React.createElement('div', { style: { fontSize: '11px', opacity: .72 } }, '导入的角色卡，或从卡片库一键唤醒。'),
        React.createElement('div', { style: PERSONA_STYLE.row },
          personaButton('＋ 导入人设', () => {
            pickFile('.docx,.md,.markdown,.txt,.json,.png', (file, dataUrl) => importDocument(file, dataUrl));
          }, { primary: true }),
          personaButton('去卡片库', () => setListTab('library')))),
      items.length ? items.map(personaListCard) : React.createElement('div', { className: 'we-picker__hint' }, '还没有特殊人设。可以导入 docx/md/txt/JSON/PNG，或从卡片库挑一个。'));
  };

  const libraryTab = () => React.createElement('div', null,
    React.createElement('div', { style: { ...PERSONA_STYLE.row, marginBottom: '6px' } },
      personaInput({ value: library.q || '', placeholder: '搜索卡片…', onChange: (v) => { void loadLibrary(v, library.category); }, style: { flex: 1, minWidth: '140px' } }),
      personaButton('刷新', () => { void loadLibrary(library.q || '', library.category); })),
    React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '5px', marginBottom: '6px' } },
      (library.categories.length ? library.categories : [{ id: 'all', label: '全部' }, { id: 'roleplay', label: '角色扮演' }, { id: 'story', label: '互动故事' }])
        .map((cat) => personaButton(cat.label, () => { void loadLibrary(library.q || '', cat.id); }, {
          style: library.category === cat.id ? { borderColor: 'rgba(120,190,255,.65)' } : {},
        }))),
    library.loading ? React.createElement('div', { className: 'we-picker__hint' }, '正在读取卡片库…') : null,
    library.cards.length ? library.cards.map((card) => React.createElement('div', {
      key: card.id, style: { ...PERSONA_STYLE.card, padding: 0, overflow: 'hidden' },
    },
    React.createElement('div', {
      style: {
        height: '54px', background: card.cover || card.accent || 'linear-gradient(135deg,#333,#666)',
        display: 'flex', alignItems: 'center', padding: '0 12px', gap: '10px',
      },
    },
    React.createElement('div', { style: { fontSize: '26px' } }, card.avatar || '🎭'),
    React.createElement('div', null,
      React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, card.title),
      React.createElement('div', { style: { fontSize: '10px', opacity: .82 } }, `${card.sourceLabel || '官方'} · v${card.version || '1.0'} · ${card.mode === 'story' ? '互动故事' : '角色扮演'}`))),
    React.createElement('div', { style: { padding: '8px 12px' } },
      React.createElement('div', { style: { fontSize: '12px', opacity: .82 } }, card.summary || card.description || ''),
      React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '4px', marginTop: '4px' } },
        (card.tags || []).slice(0, 5).map((tag) => React.createElement('span', { key: tag, style: PERSONA_STYLE.badge }, tag))),
      React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '6px' } },
        personaButton('预览', () => { setPreviewCard(card); setView('library-preview'); }),
        personaButton('使用这个人设', () => { void useLibrary(card); }, { primary: true }))))) : React.createElement('div', { className: 'we-picker__hint' }, '没有匹配的卡片。'));

  if (view === 'list') {
    return React.createElement('div', { id: 'we-persona-section', style: { marginBottom: '14px' } },
      listHeader('人设', [globalBadge(), personaButton('刷新', () => { void loadList(); })]),
      openingCard(),
      React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '4px', marginBottom: '2px' } },
        LIST_TABS.map((tab) => personaButton(tab.label, () => {
          setListTab(tab.id);
          if (tab.id === 'library') void loadLibrary(library.q || '', library.category);
        }, { style: listTab === tab.id ? { borderColor: 'rgba(120,190,255,.7)' } : {} }))),
      listTab === 'assistants' ? assistantTab() : (listTab === 'characters' ? characterTab() : libraryTab()),
      note ? React.createElement('div', { className: 'we-picker__hint', style: { color: note.ok ? undefined : '#f87171', marginTop: '6px' } }, note.text) : null,
      globalOpen ? React.createElement(GlobalKeyModal, {
        form: globalForm, setForm: setGlobalForm, keyValue: globalKey, setKeyValue: setGlobalKey,
        info: globalInfo, busy, onSave: () => { void saveGlobal(); }, onTest: () => { void testGlobal(); },
        onClose: () => setGlobalOpen(false), note: globalNote,
      }) : null);
  }

  if (view === 'library-preview' && previewCard) {
    return React.createElement('div', { style: { marginBottom: '14px' } },
      listHeader('卡片预览', personaButton('返回卡片库', () => { setPreviewCard(null); setView('list'); })),
      React.createElement('div', { style: { ...PERSONA_STYLE.card, overflow: 'hidden', padding: 0 } },
        React.createElement('div', { style: { height: '100px', background: previewCard.cover || previewCard.accent, display: 'flex', alignItems: 'center', padding: '0 16px', gap: '12px' } },
          React.createElement('div', { style: { fontSize: '44px' } }, previewCard.avatar || '🎭'),
          React.createElement('div', null,
            React.createElement('div', { style: { fontSize: '18px', fontWeight: 700 } }, previewCard.title),
            React.createElement('div', { style: { fontSize: '11px', opacity: .85 } }, previewCard.subtitle || ''),
            React.createElement('div', { style: { fontSize: '10px', opacity: .75, marginTop: '2px' } }, `${previewCard.sourceLabel || '官方'} · v${previewCard.version || '1.0'}`))),
        React.createElement('div', { style: { padding: '10px 14px' } },
          React.createElement('div', { style: { fontSize: '12px', lineHeight: 1.55, whiteSpace: 'pre-wrap' } }, previewCard.description || previewCard.summary || ''),
          React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '4px', marginTop: '6px' } },
            (previewCard.tags || []).map((tag) => React.createElement('span', { key: tag, style: PERSONA_STYLE.badge }, tag))),
          previewCard.firstMes ? personaField('开场白', React.createElement('div', { style: { ...PERSONA_STYLE.card, background: 'rgba(255,255,255,.03)', whiteSpace: 'pre-wrap' } }, previewCard.firstMes)) : null,
          React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '4px' } },
            `使用后：继承全局 Key · 推荐音色 ${previewCard.recommendedVoice || '继承全局'} · 自动设为当前人设 · 特殊人设不使用工具`),
          React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '8px' } },
            personaButton('使用这个人设', () => { void useLibrary(previewCard); }, { primary: true, disabled: busy }),
            personaButton('返回', () => { setPreviewCard(null); setView('list'); })))));
  }

  if (view === 'wizard') {
    const step = wizard.step;
    return React.createElement('div', { style: { marginBottom: '14px' } },
      listHeader('新建助手', personaButton('取消', () => setView('list'))),
      React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '6px', marginBottom: '8px' } },
        [1, 2, 3].map((n) => React.createElement('span', {
          key: n, style: { ...PERSONA_STYLE.badge, ...(step === n ? PERSONA_STYLE.badgeOk : {}) },
        }, `第 ${n} 步`))),
      step === 1 ? React.createElement('div', null,
        personaField('名字', personaInput({ value: wizard.name, placeholder: '例如：小满', onChange: (v) => setWizard((prev) => ({ ...prev, name: v })) })),
        personaField('头像（emoji / URL，可留空）', personaInput({ value: wizard.avatar || '', onChange: (v) => setWizard((prev) => ({ ...prev, avatar: v })) }))) : null,
      step === 2 ? React.createElement('div', null,
        personaField('怎么称呼你', personaInput({ value: wizard.nickname, placeholder: '例如：老朱', onChange: (v) => setWizard((prev) => ({ ...prev, nickname: v })) })),
        personaField('语气', personaSelect({
          value: wizard.tone, onChange: (v) => setWizard((prev) => ({ ...prev, tone: v })),
          options: [{ value: '温柔', label: '温柔' }, { value: '活泼', label: '活泼' }, { value: '冷静', label: '冷静' }, { value: '毒舌', label: '毒舌' }],
        }))) : null,
      step === 3 ? React.createElement('div', null,
        personaField('你们的关系', personaInput({ value: wizard.relation, placeholder: '例如：一起生活的搭档', onChange: (v) => setWizard((prev) => ({ ...prev, relation: v })) })),
        React.createElement('div', { style: { ...PERSONA_STYLE.card, lineHeight: 1.6 } },
          `助手：${wizard.name || '未命名'} · 称呼：${wizard.nickname || '你'} · 语气：${wizard.tone}`,
          React.createElement('div', { style: { fontSize: '10px', opacity: .7, marginTop: '3px' } }, '创建后会继承全局 Key；想换模型/Key 再进详情。'))) : null,
      React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '8px' } },
        step > 1 ? personaButton('上一步', () => setWizard((prev) => ({ ...prev, step: prev.step - 1 }))) : null,
        step < 3 ? personaButton('下一步', () => setWizard((prev) => ({ ...prev, step: prev.step + 1 })), { primary: true })
          : personaButton('创建助手', () => { void createWizard(); }, { primary: true, disabled: busy })),
      note ? React.createElement('div', { className: 'we-picker__hint', style: { color: '#f87171' } }, note.text) : null);
  }

  if (view === 'import') {
    if (!doc) {
      return React.createElement('div', { style: { marginBottom: '14px' } },
        listHeader('导入人设', personaButton('返回', () => setView('list'))),
        React.createElement('div', { style: PERSONA_STYLE.card },
          React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, '上传人设文档或角色卡'),
          React.createElement('div', { className: 'we-picker__hint', style: { margin: '4px 0 8px' } },
            '支持 docx / md / txt / JSON / PNG；文档会抽文本、分块、卡片化，先给你预览，不会直接保存。'),
          personaButton('选择文件', () => pickFile('.docx,.md,.markdown,.txt,.json,.png', (file, dataUrl) => importDocument(file, dataUrl)), { primary: true })));
    }
    if (doc.loading) return React.createElement('div', { className: 'we-picker__hint' }, `正在读取「${doc.fileName}」并卡片化…`);
    if (!doc.card) return React.createElement('div', null, listHeader('导入人设', personaButton('返回', () => setView('list'))),
      React.createElement('div', { className: 'we-picker__hint', style: { color: '#f87171' } }, '文档读取/卡片化失败，换一份 docx/md/txt 再试。'));
    const data = doc.card.data || {};
    const setCardData = (key, value) => setDoc((prev) => { const next = clone(prev); next.card.data[key] = value; return next; });
    const entries = (data.character_book && data.character_book.entries) || [];
    return React.createElement('div', { style: { marginBottom: '14px' } },
      listHeader('预览卡片', personaButton('返回列表', () => { setDoc(null); setView('list'); })),
      React.createElement('div', { style: PERSONA_STYLE.row },
        React.createElement('div', { style: { flex: '1 1 280px', minWidth: 0 } },
          React.createElement('div', { style: { fontSize: '11px', opacity: .72, marginBottom: '3px' } }, `原文 · ${doc.fileName} · ${doc.chunks || 0} 块`),
          React.createElement('div', {
            style: { ...PERSONA_STYLE.card, maxHeight: '360px', overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '11px', opacity: .85 },
          }, String(doc.text || '').slice(0, 8000))),
        React.createElement('div', { style: { flex: '1 1 320px', minWidth: 0 } },
          React.createElement('div', { style: { fontSize: '11px', opacity: .72, marginBottom: '3px' } },
            `卡片字段 · ${doc.usedModel ? '模型卡片化' : '本地启发式'}${doc.warnings && doc.warnings.length ? ` · ${doc.warnings.join('；')}` : ''}`),
          personaField('名字', personaInput({ value: data.name || '', onChange: (v) => setCardData('name', v) })),
          personaField('设定 / 描述', personaTextarea({ rows: 5, value: data.description || '', onChange: (v) => setCardData('description', v) })),
          personaField('性格', personaTextarea({ rows: 3, value: data.personality || '', onChange: (v) => setCardData('personality', v) })),
          personaField('场景', personaTextarea({ rows: 2, value: data.scenario || '', onChange: (v) => setCardData('scenario', v) })),
          personaField('开场白 first_mes', personaTextarea({ rows: 3, value: data.first_mes || '', onChange: (v) => setCardData('first_mes', v) })),
          personaField('世界书（JSON entries）', personaTextarea({
            rows: 4, value: doc.worldBookText === undefined ? JSON.stringify(entries, null, 2) : doc.worldBookText,
            onChange: (v) => setDoc((prev) => ({ ...prev, worldBookText: v })),
          }), '保存时会使用这里的 JSON；键为 keys/content/insertion_order。'),
          React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '8px' } },
            personaButton('保存为特殊人设', () => { void saveDoc(); }, { primary: true, disabled: busy }),
            personaButton('重新选文件', () => { setDoc(null); pickFile('.docx,.md,.markdown,.txt,.json,.png', (file, dataUrl) => importDocument(file, dataUrl)); })))));
  }

  if (!draft) {
    return React.createElement('div', { className: 'we-picker__hint' }, '人设已关闭，点「返回列表」重新打开。');
  }
  const p = draft;
  const isCharacter = p.type === 'character';
  const tabs = isCharacter ? CHARACTER_TABS : PERSONA_BASE_TABS;
  const currentTab = tabs.some((tab) => tab.id === detailTab) ? detailTab : 'basic';
  const globalHasKey = Boolean(globalInfo && globalInfo.hasKey);
  const keyMode = p.model && p.model.apiKeyRef === 'inherit' ? 'inherit' : 'persona';
  const saveRow = React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '8px' } },
    personaButton('保存', () => { void saveDetail(); }, { primary: true, disabled: busy }),
    personaButton('返回列表', () => { setView('list'); setSelected(null); setDraft(null); setNote(null); void loadList(); }));

  const basicPage = React.createElement('div', null,
    personaField('名字', personaInput({ value: p.name, onChange: (v) => patchDraft((d) => { d.name = v; }) })),
    personaField('头像（URL / emoji / 留空）', personaInput({ value: p.avatar, onChange: (v) => patchDraft((d) => { d.avatar = v; }) })),
    isCharacter ? React.createElement('div', null,
      personaField('玩法模式', personaSelect({
        value: p.mode, onChange: (v) => patchDraft((d) => { d.mode = v; }),
        options: [{ value: 'roleplay', label: '角色扮演' }, { value: 'story', label: '互动故事' }],
      })),
      personaField('来源', personaInput({ value: `${p.card.source || 'user'}${p.card.sourceName ? ' · ' + p.card.sourceName : ''}${p.card.version ? ' · v' + p.card.version : ''}`, onChange: () => {}, disabled: true })))
      : React.createElement('div', null,
        personaField('称呼 / 关系（写进核心身份）', personaTextarea({ rows: 4, value: p.core.identity, onChange: (v) => patchDraft((d) => { d.core.identity = v; }) })),
        personaField('说话习惯（每行一条）', personaTextarea({ rows: 3, value: (p.core.speechHabits || []).join('\n'), onChange: (v) => patchDraft((d) => { d.core.speechHabits = v.split('\n').map((x) => x.trim()).filter(Boolean); }) }))),
    React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '2px' } },
      isCharacter ? '特殊人设不使用任何系统工具；删除会同时删除剧情记忆。' : '助手可以使用系统工具（换壁纸、提醒、桌宠设置等）。'));

  const modelPage = React.createElement('div', null,
    personaField('Key 归属', personaSelect({
      value: keyMode, onChange: (v) => patchDraft((d) => { d.model.apiKeyRef = v === 'inherit' ? 'inherit' : 'vault:' + p.id; }),
      options: [{ value: 'inherit', label: `继承全局${globalHasKey ? '（已配置）' : '（全局未配置）'}` }, { value: 'persona', label: '独立 Key' }],
    })),
    keyMode === 'inherit' ? React.createElement('div', { className: 'we-picker__hint' },
      `当前使用全局默认：${globalInfo ? `${globalInfo.provider} · ${globalInfo.model}` : '未读取到'}${globalHasKey ? '' : ' · 还没有 Key'}`)
      : React.createElement('div', null,
        personaField(keyInfo.hasKey ? `独立 Key（已保存：${keyInfo.maskedKey}）` : '独立 Key',
          React.createElement('div', { style: PERSONA_STYLE.row },
            personaInput({ type: 'password', value: keyValue, placeholder: '只写不读；留空不修改', onChange: setKeyValue, style: { flex: 1 } }),
            personaButton('保存 Key', () => { void saveKey('persona'); }, { primary: true, disabled: busy }),
            personaButton('清除', () => { setKeyValue(''); void saveKey('persona'); }, { danger: true }))),
        personaButton('测试独立 Key', () => { void testKey(); })),
    personaField('接口协议', personaSelect({
      value: p.model.provider || 'inherit', onChange: (v) => patchDraft((d) => { d.model.provider = v; }),
      options: [{ value: 'inherit', label: '继承全局' }, { value: 'openai', label: 'OpenAI 兼容' }, { value: 'ollama', label: 'Ollama' }],
    })),
    personaField('接口地址（留空继承）', personaInput({ value: p.model.baseUrl, onChange: (v) => patchDraft((d) => { d.model.baseUrl = v; }) })),
    personaField('模型名（留空继承）', personaInput({ value: p.model.model, onChange: (v) => patchDraft((d) => { d.model.model = v; }) })),
    personaField('温度', personaInput({ type: 'number', value: p.model.temperature, onChange: (v) => patchDraft((d) => { d.model.temperature = Number(v); }) })));

  const cardPage = React.createElement('div', null,
    personaField('核心身份', personaTextarea({ rows: 6, value: p.core.identity, onChange: (v) => patchDraft((d) => { d.core.identity = v; }) })),
    personaField('价值观（每行一条）', personaTextarea({ rows: 3, value: (p.core.values || []).join('\n'), onChange: (v) => patchDraft((d) => { d.core.values = v.split('\n').map((x) => x.trim()).filter(Boolean); }) })),
    personaField('边界（每行一条）', personaTextarea({ rows: 3, value: (p.core.boundaries || []).join('\n'), onChange: (v) => patchDraft((d) => { d.core.boundaries = v.split('\n').map((x) => x.trim()).filter(Boolean); }) })),
    personaField('说话习惯（每行一条）', personaTextarea({ rows: 3, value: (p.core.speechHabits || []).join('\n'), onChange: (v) => patchDraft((d) => { d.core.speechHabits = v.split('\n').map((x) => x.trim()).filter(Boolean); }) })),
    personaField('示例对话（空行分隔）', personaTextarea({ rows: 4, value: (p.core.exampleDialogues || []).join('\n\n'), onChange: (v) => patchDraft((d) => { d.core.exampleDialogues = v.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean); }) })),
    personaField('世界书（JSON 数组：keys/content/priority）', personaTextarea({
      rows: 5, value: JSON.stringify(p.core.worldBook || [], null, 2),
      onChange: (v) => patchDraft((d) => { try { d.core.worldBook = JSON.parse(v || '[]'); } catch { /* 输入中不报错 */ } }),
    })),
    personaField('开场白 first_mes', personaTextarea({ rows: 3, value: p.card.firstMes, onChange: (v) => patchDraft((d) => { d.card.firstMes = v; }) })),
    personaField('场景 scenario', personaTextarea({ rows: 2, value: p.card.scenario, onChange: (v) => patchDraft((d) => { d.card.scenario = v; }) })),
    personaField('角色卡系统提示', personaTextarea({ rows: 3, value: p.card.systemPrompt, onChange: (v) => patchDraft((d) => { d.card.systemPrompt = v; }) })),
    personaField('标签（逗号分隔）', personaInput({ value: (p.card.tags || []).join('，'), onChange: (v) => patchDraft((d) => { d.card.tags = v.split(/[，,]/).map((x) => x.trim()).filter(Boolean); }) })),
    React.createElement('div', { style: PERSONA_STYLE.row },
      personaButton('导出 CCv2 JSON', () => { try { window.open(apiUrl('/pet-chat/personas/' + encodeURIComponent(p.id) + '/export-card'), '_blank'); } catch { /* ignore */ } }),
      personaButton('导出 PNG 卡', () => { try { window.open(apiUrl('/pet-chat/personas/' + encodeURIComponent(p.id) + '/export-card.png'), '_blank'); } catch { /* ignore */ } })));

  const storyPage = React.createElement('div', null,
    personaField('章节', personaInput({ value: p.story.chapter, onChange: (v) => patchDraft((d) => { d.story.chapter = v; }) })),
    personaField('当前场景', personaTextarea({ rows: 3, value: p.story.scene, onChange: (v) => patchDraft((d) => { d.story.scene = v; }) })),
    personaField('地点', personaInput({ value: p.story.location, onChange: (v) => patchDraft((d) => { d.story.location = v; }) })),
    personaField('时间', personaInput({ value: p.story.time, onChange: (v) => patchDraft((d) => { d.story.time = v; }) })),
    personaField('章节选项（每行一条）', personaTextarea({ rows: 3, value: (p.story.choices || []).join('\n'), onChange: (v) => patchDraft((d) => { d.story.choices = v.split('\n').map((x) => x.trim()).filter(Boolean); }) })),
    personaField('好感 / 信任', React.createElement('div', { style: PERSONA_STYLE.row },
      personaInput({ type: 'number', value: p.growth.bond.affection, onChange: (v) => patchDraft((d) => { d.growth.bond.affection = Number(v); }), style: { width: '90px' } }),
      personaInput({ type: 'number', value: p.growth.bond.trust, onChange: (v) => patchDraft((d) => { d.growth.bond.trust = Number(v); }), style: { width: '90px' } }))),
    React.createElement('div', { className: 'we-picker__hint' }, '剧情状态会进入特殊人设的 system prompt；世界书在「人设卡」页。'));

  const personaTag = (text, kind) => React.createElement('span', {
    style: {
      ...PERSONA_STYLE.badge,
      ...(kind === 'ok' ? PERSONA_STYLE.badgeOk : kind === 'warn' ? PERSONA_STYLE.badgeWarn : {}),
      ...(kind === 'risk-high' ? { borderColor: 'rgba(248,113,113,.5)', color: '#fca5a5' } : {}),
      ...(kind === 'risk-medium' ? { borderColor: 'rgba(251,191,36,.45)', color: '#fcd34d' } : {}),
      ...(kind === 'risk-low' ? { borderColor: 'rgba(74,222,128,.4)', color: '#86efac' } : {}),
    },
  }, text);

  const voiceStatusText = (item) => {
    if (!item) return '';
    if (item.installed && item.runtimeReady === false) return '缺高清运行时';
    const percent = item.progress && item.progress.percent;
    if (item.status === 'downloading') return `下载中${percent == null ? '' : ' ' + percent + '%'}`;
    if (item.status === 'downloadable') return '未下载';
    if (item.status === 'rate-limited') return '暂不可用（429 限流）';
    if (item.status === 'needs-key') return '需配置';
    if (item.status === 'needs-test') return '需测试';
    if (item.status === 'error') return '安装失败';
    if (item.status === 'unavailable') return '暂不可用';
    return '可用';
  };

  const voiceStatusKind = (item) => {
    if (!item) return '';
    if (item.status === 'ready') return 'ok';
    if (item.status === 'downloading' || item.status === 'needs-test') return 'warn';
    return 'warn';
  };

  /** 音色卡片：分组 + 状态徽标 + ▶ 试听 + 选中。 */
  const voiceCard = (item, opts = {}) => {
    const selected = opts.selected === true;
    const isPreviewing = previewId === item.id;
    const needsKey = item.status === 'needs-key';
    const runtimeMissing = item.installed === true && item.runtimeReady === false;
    const downloadable = item.status === 'downloadable';
    const meta = [
      item.lang,
      item.gender === 'Female' ? '女声' : item.gender === 'Male' ? '男声' : '',
      item.hd ? '高清' : item.quality,
      item.sizeMB ? `${item.sizeMB}MB` : '',
    ].filter(Boolean).join(' · ');
    return React.createElement('div', {
      key: item.id,
      style: {
        ...PERSONA_STYLE.card,
        padding: '8px 10px',
        cursor: opts.onPick ? 'pointer' : 'default',
        ...(selected ? PERSONA_STYLE.cardActive : {}),
        ...(item.status === 'rate-limited' || item.status === 'unavailable' ? { opacity: .78 } : {}),
      },
      onClick: opts.onPick ? () => opts.onPick(item) : undefined,
    },
    React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between', gap: '6px' } },
      React.createElement('div', { style: { minWidth: 0 } },
        React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          item.label,
          selected ? personaTag('已选', 'ok') : null),
        React.createElement('div', { style: { fontSize: '10px', opacity: .7, marginTop: '1px' } }, meta || item.engine)),
      React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '4px', justifyContent: 'flex-end' } },
        personaTag(voiceStatusText(item), voiceStatusKind(item)),
        React.createElement('div', { onClick: (e) => { e.stopPropagation(); } },
          personaButton(isPreviewing ? '…' : (runtimeMissing ? '缺高清运行时' : (downloadable ? '▶ 下载并试听' : '▶ 试听')), () => {
            if (needsKey || runtimeMissing || isPreviewing) return;
            if (downloadable && item.packId) {
              void packAction('install', { id: item.packId, name: item.label, voiceId: item.id });
            } else {
              void previewVoice(item.id);
            }
          }, { disabled: needsKey || runtimeMissing || isPreviewing || item.status === 'downloading' })),
        opts.onDefault ? React.createElement('div', { onClick: (e) => { e.stopPropagation(); } },
          personaButton('设为默认', () => opts.onDefault(item), { disabled: item.status !== 'ready' })) : null)));
  };

  const packRow = (pack) => {
    const progress = pack.progress || {};
    const pct = progress.percent;
    const installed = pack.installed === true;
    const runtimeMissing = installed && pack.runtimeReady === false;
    return React.createElement('div', { key: pack.id, style: { ...PERSONA_STYLE.card, padding: '8px 10px' } },
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between', alignItems: 'flex-start' } },
        React.createElement('div', { style: { minWidth: 0 } },
          React.createElement('div', { style: { fontSize: '12px', fontWeight: 600 } },
            pack.name,
            personaTag(pack.quality || '', pack.hd ? 'ok' : ''),
            pack.recommended ? personaTag('推荐', 'ok') : null),
          React.createElement('div', { style: { fontSize: '10px', opacity: .7, marginTop: '2px' } },
            `${pack.lang} · ${pack.sizeMB}MB · ${pack.license} · ${pack.source}`),
          React.createElement('div', { className: 'we-picker__hint', style: { margin: '2px 0 0', fontSize: '10px' } }, pack.desc)),
        React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '4px', justifyContent: 'flex-end' } },
          personaTag(installed ? '已安装' : (pack.status === 'downloading' ? `下载中${pct == null ? '' : ' ' + pct + '%'}` : (pack.status === 'error' ? '失败' : '未安装')),
            installed ? 'ok' : 'warn'))),
      pack.status === 'downloading' ? React.createElement('div', {
        style: { height: '4px', borderRadius: '2px', background: 'rgba(255,255,255,.12)', marginTop: '6px', overflow: 'hidden' },
      }, React.createElement('div', {
        style: { width: `${pct == null ? 15 : pct}%`, height: '100%', background: 'rgba(120,190,255,.8)', transition: 'width 300ms' },
      })) : null,
      pack.status === 'error' && pack.reason
        ? React.createElement('div', { className: 'we-picker__hint', style: { color: '#f87171', margin: '3px 0 0' } }, pack.reason)
        : null,
      runtimeMissing
        ? React.createElement('div', { className: 'we-picker__hint', style: { color: '#fcd34d', margin: '3px 0 0' } },
          '模型已下载，但缺少 sherpa-onnx 高清运行时：试听会回落到内置音色（不假装出声）。')
        : null,
      React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '6px' } },
        installed ? personaButton(runtimeMissing ? '▶ 试听（回落）' : '▶ 试听', () => { void previewVoice(pack.voiceId); }, { disabled: previewId === pack.voiceId || runtimeMissing }) : null,
        !installed && pack.status !== 'downloading'
          ? personaButton(pack.status === 'error' ? '重试下载' : '下载', () => { void packAction('install', pack); }, { primary: true, disabled: voiceBusy === 'install:' + pack.id })
          : null,
        installed ? personaButton('设为全局默认', () => { void packAction('default', pack); }, { disabled: voiceBusy === 'default:' + pack.id }) : null,
        installed ? personaButton('删除', () => { void packAction('remove', pack); }, { danger: true, disabled: voiceBusy === 'remove:' + pack.id }) : null));
  };

  const edgeGroupBox = (label, items) => {
    if (!items.length) return null;
    return React.createElement('div', { key: 'edge-' + label, style: { marginBottom: '6px' } },
      React.createElement('div', { style: { fontSize: '11px', opacity: .78, margin: '6px 0 2px' } }, `${label}（${items.length}）`),
      React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: '6px' } },
        items.map((item) => voiceCard(item, { onDefault: (it) => { void setGlobalDefaultVoice(it.id, it.label); } }))));
  };

  const volcPanel = () => {
    const center = (voiceCatalog && voiceCatalog.center) || {};
    const volc = center.volcengine || {};
    const configured = volc.configured === true;
    const statusText = configured ? (volc.lastOk ? '已测试通过' : '已配置（未测试）') : '未配置';
    const howTo = (voiceCatalog && voiceCatalog.howTo) || volc.howTo || [];
    const howToRows = howTo.map((step) => React.createElement('div', { key: step.step, style: { ...PERSONA_STYLE.card, padding: '7px 9px' } },
      React.createElement('div', { style: { fontSize: '12px', fontWeight: 600 } }, `${step.step}. ${step.title}`),
      React.createElement('div', { style: { fontSize: '11px', opacity: .82, marginTop: '2px', lineHeight: 1.5 } }, step.body),
      step.link ? React.createElement('a', {
        href: step.link, target: '_blank', rel: 'noreferrer',
        style: { fontSize: '10px', color: '#93c5fd' },
      }, step.link) : null));
    const header = React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
      React.createElement('div', { style: { fontSize: '12px', fontWeight: 600 } }, '火山引擎（唯一在线供应商）',
        personaTag(statusText, configured ? (volc.lastOk ? 'ok' : 'warn') : 'warn')),
      personaButton(howToOpen ? '收起「如何获取」' : '如何获取 →', () => setHowToOpen((prev) => !prev)));
    const statusHint = configured
      ? React.createElement('div', { className: 'we-picker__hint', style: { margin: '2px 0 4px' } },
        `AppID ${volc.maskedAppId || '已保存'} · Token ${volc.maskedToken || '已保存'} · ${volc.cluster || ''} · ${volc.resourceId || ''}`)
      : null;
    const errorHint = volc.lastError
      ? React.createElement('div', { className: 'we-picker__hint', style: { color: '#f87171' } }, volc.lastError)
      : null;
    const credentialsGrid = React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' } },
      personaField('AppID', personaInput({
        value: volcForm.appId,
        placeholder: configured ? '留空不修改' : '火山控制台 → 应用管理',
        onChange: (v) => setVolcForm((prev) => ({ ...prev, appId: v })),
      })),
      personaField('Access Token', personaInput({
        type: 'password', value: volcForm.accessToken,
        placeholder: configured ? '留空不修改' : '应用详情 → Access Token',
        onChange: (v) => setVolcForm((prev) => ({ ...prev, accessToken: v })),
      })));
    const routingGrid = React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
      personaField('Cluster（传统 TTS）', personaInput({
        value: volcForm.cluster, placeholder: 'volcano_tts',
        onChange: (v) => setVolcForm((prev) => ({ ...prev, cluster: v })),
      })),
      personaField('Resource ID（Seed-TTS）', personaInput({
        value: volcForm.resourceId, placeholder: 'seed-tts-2.0',
        onChange: (v) => setVolcForm((prev) => ({ ...prev, resourceId: v })),
      })));
    const voiceGrid = React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
      personaField('适配器子类型', personaSelect({
        value: volcForm.subtype,
        onChange: (v) => setVolcForm((prev) => ({ ...prev, subtype: v })),
        options: [{ value: 'volc-seed-tts', label: 'volc-seed-tts（大模型）' }, { value: 'volc-tts', label: 'volc-tts（传统）' }],
      })),
      personaField('音色 ID', React.createElement('div', null,
        personaInput({
          value: volcForm.voiceId, placeholder: 'zh_female_..._uranus_bigtts',
          list: 'we-volc-voices',
          onChange: (v) => setVolcForm((prev) => ({ ...prev, voiceId: v })),
        }),
        React.createElement('datalist', { id: 'we-volc-voices' },
          (volc.voices || []).map((voice) => React.createElement('option', { key: voice.id, value: voice.id }, voice.label))))));
    const actions = React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '4px' } },
      personaButton('保存', () => { void saveVolc(); }, { primary: true, disabled: voiceBusy === 'volc-save' }),
      personaButton('测试', () => { void testVolc(); }, { disabled: voiceBusy === 'volc-test' }),
      personaButton('清除 Key', async () => {
        try {
          await apiPostJson('/pet-chat/voice/providers', { provider: 'volcengine', clearCredentials: true }, { parse: 'always' });
          setVolcNote({ ok: true, text: '已清除火山的 AppID / Token' });
          await loadVoiceCatalog();
        } catch { setVolcNote({ ok: false, text: '清除失败' }); }
      }, { danger: true }));
    const noteRow = volcNote
      ? React.createElement('div', { className: 'we-picker__hint', style: { color: volcNote.ok ? undefined : '#f87171', marginTop: '4px' } }, volcNote.text)
      : null;
    const howToBlock = howToOpen
      ? React.createElement('div', { style: { marginTop: '8px' } },
        React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '2px' } }, '如何获取（六步）'),
        howToRows)
      : null;
    return React.createElement('div', { style: { ...PERSONA_STYLE.card, padding: '10px' } },
      header, statusHint, errorHint, credentialsGrid, routingGrid, voiceGrid, actions, noteRow, howToBlock);
  };

  const permissionRow = (group) => {
    const current = group.permission || 'deny';
    const locked = group.available === false || permBusy;
    return React.createElement('div', { key: group.id, style: { ...PERSONA_STYLE.card, padding: '8px 10px', opacity: group.available === false ? .62 : 1 } },
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between', alignItems: 'flex-start' } },
        React.createElement('div', null,
          React.createElement('div', { style: { fontSize: '12px', fontWeight: 600 } },
            group.label,
            personaTag(group.riskLabel, group.risk === 'high' ? 'risk-high' : group.risk === 'medium' ? 'risk-medium' : 'risk-low'),
            group.advancedOnly ? personaTag('需高级权限', 'warn') : null),
          React.createElement('div', { className: 'we-picker__hint', style: { margin: '1px 0 0', fontSize: '10px' } }, group.desc)),
        React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '3px' } },
          [['allow', '允许'], ['ask', '询问'], ['deny', '禁止']].map(([value, label]) => personaButton(label, () => { void setPermissionGroup(group.id, value); }, {
            disabled: locked || current === value,
            style: current === value ? { borderColor: 'rgba(120,190,255,.7)', background: 'rgba(90,160,255,.16)' } : {},
          })))),
      group.available === false ? React.createElement('div', { className: 'we-picker__hint', style: { margin: '3px 0 0', fontSize: '10px' } },
        group.advancedOnly ? '打开下面的「高级权限」后才可用；打开后每个动作仍会二次确认。' : '当前不可用。') : null);
  };

  const permissionLog = () => {
    const items = (perm.toolLog && perm.toolLog.items) || [];
    if (!items.length) return React.createElement('div', { className: 'we-picker__hint' }, '还没有调用记录。');
    return items.map((item) => React.createElement('div', { key: String(item.ts) + item.tool, style: { ...PERSONA_STYLE.card, padding: '6px 9px' } },
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
        React.createElement('div', { style: { fontSize: '11px' } },
          `${new Date(item.ts).toLocaleString()} · ${item.tool}`,
          personaTag(item.permission || 'allow', item.permission === 'deny' ? 'risk-high' : item.permission === 'ask' ? 'risk-medium' : 'risk-low'),
          item.confirmed ? personaTag('已确认', 'ok') : null),
        React.createElement('div', { style: { fontSize: '10px', opacity: .72 } },
          `${item.result || ''}${item.verified ? ' · 已回读' : ''}`)),
      item.error ? React.createElement('div', { style: { fontSize: '10px', opacity: .7, marginTop: '1px' } }, item.error) : null));
  };

  const voicePage = (() => {
    const voiceData = (p.express && p.express.voice) || {};
    const mode = voiceData.mode === 'fixed' ? 'fixed' : 'inherit';
    const center = (voiceCatalog && voiceCatalog.center) || {};
    const groups = (voiceCatalog && voiceCatalog.groups) || [];
    const builtin = groups.find((group) => group.key === 'builtin') || { items: [] };
    const edge = groups.find((group) => group.key === 'edge') || { items: [] };
    const providers = groups.find((group) => group.key === 'providers') || { items: [] };
    const packs = (voiceCatalog && voiceCatalog.packs) || [];
    const preferredLabel = (voiceCatalog && voiceCatalog.preferredLabel) || (center.preferred ? center.preferred : '');
    const currentId = mode === 'fixed' ? String(voiceData.id || voiceData.name || '') : '';
    const currentItem = builtin.items.concat(edge.items, providers.items).find((item) => item.id === currentId);
    const edgeByLang = {};
    for (const item of edge.items) {
      const key = item.langGroup || '其他';
      if (!edgeByLang[key]) edgeByLang[key] = [];
      edgeByLang[key].push(item);
    }
    const setFixed = (item) => {
      patchDraft((d) => {
        d.express.voice = {
          engine: item.engine || 'edge',
          id: item.id,
          name: String(item.id || '').replace(/^[a-z0-9-]+:/i, ''),
          rate: Number(d.express.voice && d.express.voice.rate) || 0,
          mode: 'fixed',
        };
      });
      setVoiceNote(null);
    };
    const setInherit = () => {
      patchDraft((d) => {
        d.express.voice = {
          ...(d.express.voice || {}),
          engine: 'inherit', id: '', name: '', mode: 'inherit',
          rate: Number(d.express.voice && d.express.voice.rate) || 0,
        };
      });
    };
    return React.createElement('div', null,
      React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '2px' } }, '音色'),
      React.createElement('label', { style: { ...PERSONA_STYLE.row, gap: '6px', padding: '4px 0', cursor: 'pointer' } },
        React.createElement('input', {
          type: 'radio', name: 'we-persona-voice-mode', checked: mode === 'inherit',
          onChange: setInherit,
        }),
        React.createElement('span', null, '继承全局',
          React.createElement('span', { style: { opacity: .72 } }, `（当前：${preferredLabel || '未设置'}）`))),
      React.createElement('label', { style: { ...PERSONA_STYLE.row, gap: '6px', padding: '4px 0', cursor: 'pointer' } },
        React.createElement('input', {
          type: 'radio', name: 'we-persona-voice-mode', checked: mode === 'fixed',
          onChange: () => {
            if (mode === 'fixed') return;
            const fallback = currentItem
              || builtin.items.find((item) => item.status === 'ready')
              || edge.items.find((item) => item.status === 'ready')
              || edge.items[0];
            if (fallback) setFixed(fallback);
          },
        }),
        React.createElement('span', null, '指定音色',
          mode === 'fixed' && currentItem
            ? React.createElement('span', { style: { opacity: .72 } }, `（当前：${currentItem.label}）`)
            : null)),
      mode === 'fixed' ? React.createElement('div', { style: { marginTop: '4px' } },
        React.createElement('div', { style: { fontSize: '11px', fontWeight: 600, margin: '4px 0 2px' } }, '内置音色包'),
        React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))', gap: '6px' } },
          builtin.items.map((item) => voiceCard(item, { selected: item.id === currentId, onPick: setFixed }))),
        React.createElement('div', { style: { fontSize: '11px', fontWeight: 600, margin: '8px 0 2px' } },
          '免费在线 · Edge', personaTag('可能限流', 'warn')),
        voiceCatalog && voiceCatalog.edgeRateLimited
          ? React.createElement('div', { className: 'we-picker__hint', style: { color: '#fcd34d' } },
            `在线音色被限流（429）：已保留 ${voiceCatalog.rateLimitedCount || 0} 个并标注“暂不可用”，合成时会自动回落到内置音色。`)
          : null,
        Object.keys(edgeByLang).length
          ? Object.keys(edgeByLang).map((lang) => React.createElement('div', { key: 'pick-edge-' + lang },
            React.createElement('div', { style: { fontSize: '10px', opacity: .72, margin: '4px 0 2px' } }, lang),
            React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: '6px' } },
              edgeByLang[lang].map((item) => voiceCard(item, { selected: item.id === currentId, onPick: setFixed })))))
          : React.createElement('div', { className: 'we-picker__hint' }, '本机暂时拿不到 Edge 音色列表（可能被限流或断网）；内置音色仍可用。'),
        React.createElement('div', { style: { fontSize: '11px', fontWeight: 600, margin: '8px 0 2px' } }, '我的在线音色 · 火山引擎'),
        providers.items.length
          ? React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: '6px' } },
            providers.items.map((item) => voiceCard(item, { selected: item.id === currentId, onPick: setFixed })))
          : React.createElement('div', { className: 'we-picker__hint' }, '还没有配置火山：在下方「全局音色中心 → 火山引擎」填 AppID / Access Token。')) : null,
      personaField('语速（-10…10）', personaInput({
        type: 'number', value: p.express.voice.rate,
        onChange: (v) => patchDraft((d) => { d.express.voice.rate = Number(v); }),
      })),
      personaField('长度策略', personaSelect({
        value: p.express.lengthPolicy, onChange: (v) => patchDraft((d) => { d.express.lengthPolicy = v; }),
        options: [{ value: 'adaptive', label: '自适应' }, { value: 'short', label: '短' }, { value: 'long', label: '长' }],
      })),
      React.createElement('div', { className: 'we-picker__hint' },
        mode === 'fixed'
          ? '指定音色只影响这个人设；保存后下一句生效。音色不可用时会自动回落到“继承全局”的启用音色。'
          : '继承全局：下面「全局音色中心」的默认音色对所有“继承全局”的人设同时生效。'),
      React.createElement('div', { style: { ...PERSONA_STYLE.row, margin: '4px 0' } },
        personaButton('▶ 试听当前音色', () => {
          const id = mode === 'fixed' ? currentId : (voiceCatalog && voiceCatalog.preferred);
          if (id) void previewVoice(id);
        }, { disabled: !(mode === 'fixed' ? currentId : (voiceCatalog && voiceCatalog.preferred)) || Boolean(previewId) })),
      voiceNote ? React.createElement('div', { className: 'we-picker__hint', style: { color: voiceNote.ok ? undefined : '#f87171' } }, voiceNote.text) : null,

      React.createElement('div', { style: { marginTop: '14px', paddingTop: '10px', borderTop: '1px solid rgba(255,255,255,.10)' } },
        React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, '全局音色中心',
          personaTag('只对“继承全局”生效', 'warn')),
        React.createElement('div', { className: 'we-picker__hint', style: { margin: '2px 0 6px' } },
          `当前全局默认：${preferredLabel || '未设置'}。下载/删除只影响本机；设为默认会让所有“继承全局”的人设跟随。`),
        React.createElement('div', { style: { fontSize: '11px', fontWeight: 600, margin: '4px 0' } }, '内置音色包'),
        packs.map(packRow),
        React.createElement('div', { style: { fontSize: '11px', fontWeight: 600, margin: '8px 0 2px' } }, '免费在线 · Edge 分组'),
        Object.keys(edgeByLang).length
          ? Object.keys(edgeByLang).map((lang) => edgeGroupBox(lang, edgeByLang[lang]))
          : React.createElement('div', { className: 'we-picker__hint' }, '暂时没有可用的 Edge 音色列表。'),
        React.createElement('div', { style: { fontSize: '11px', fontWeight: 600, margin: '8px 0 2px' } }, '我的在线音色'),
        volcPanel(),
        React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '6px' } },
          personaButton('刷新音色目录', () => { void loadVoiceCatalog(); }),
          personaButton('试听全局默认', () => {
            const id = voiceCatalog && voiceCatalog.preferred;
            if (id) void previewVoice(id);
          }, { disabled: !(voiceCatalog && voiceCatalog.preferred) || Boolean(previewId) }))));
  })();

  const permissionsPage = React.createElement('div', null,
    perm.isCharacter
      ? React.createElement('div', { style: { ...PERSONA_STYLE.card, borderColor: 'rgba(251,191,36,.45)' } },
        React.createElement('div', { style: { fontSize: '13px', fontWeight: 600 } }, '特殊人设不能使用系统工具'),
        React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '3px' } },
          '这是代码层强制：即使提示词要求它换壁纸/卸载/读文件，工具层也会拒绝。声音页仍可正常选音色与试听。'))
      : React.createElement('div', null,
        React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '2px' } }, '工具组权限'),
        React.createElement('div', { className: 'we-picker__hint', style: { marginBottom: '4px' } },
          '允许 = 直接做；询问 = 先问一句，说「好」或在气泡点「允许」才做；禁止 = 明确拒绝。'),
        perm.loading ? React.createElement('div', { className: 'we-picker__hint' }, '正在读取权限…') : null,
        perm.groups.map(permissionRow),
        React.createElement('label', { style: { ...PERSONA_STYLE.row, gap: '6px', margin: '8px 0 2px', cursor: permBusy ? 'default' : 'pointer' } },
          React.createElement('input', {
            type: 'checkbox', checked: perm.advanced === true, disabled: permBusy,
            onChange: (e) => { void setAdvancedPermission(e.target.checked); },
          }),
          React.createElement('span', null, '高级权限',
            React.createElement('span', { style: { opacity: .72 } }, '（允许系统级操作；每个动作仍会二次确认）'))),
        permNote ? React.createElement('div', { className: 'we-picker__hint', style: { color: permNote.ok ? undefined : '#f87171' } }, permNote.text) : null,
        React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginTop: '10px' } },
          '最近调用记录', personaTag(`共 ${perm.toolLog ? perm.toolLog.total : 0} 条`, '')),
        React.createElement('div', { style: { ...PERSONA_STYLE.row, gap: '4px', margin: '3px 0 4px' } },
          personaButton('刷新', () => { if (draft) void loadPermissions(draft.id); }),
          personaButton('清空记录', () => { void clearToolLog(); }, { danger: true, disabled: permBusy })),
        permissionLog()));

  const memoryPage = React.createElement('div', null,
    React.createElement('div', { style: { ...PERSONA_STYLE.row, marginBottom: '6px' } },
      personaInput({ value: memory.q || '', placeholder: '搜索记忆…', onChange: (v) => { void loadMemory(p.id, v); }, style: { flex: 1 } }),
      personaButton('刷新', () => { void loadMemory(p.id, memory.q || ''); })),
    React.createElement('div', { style: { fontSize: '11px', opacity: .75 } }, `事件 ${memory.total} 条（无上限、不过期）`),
    memory.items.length ? memory.items.map((event) => React.createElement('div', { key: event.id, style: PERSONA_STYLE.card },
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
        React.createElement('div', { style: { fontSize: '11px' } }, `${new Date(event.ts).toLocaleString()} · ${event.kind}`),
        personaButton('删除', async () => {
          try { await apiFetch('/pet-chat/personas/' + encodeURIComponent(p.id) + '/memory/' + encodeURIComponent(event.id), { method: 'DELETE', parse: 'always' }); void loadMemory(p.id, memory.q || ''); } catch { /* ignore */ }
        })),
      React.createElement('div', { style: { marginTop: '3px', fontSize: '12px', whiteSpace: 'pre-wrap' } }, event.text)))
      : React.createElement('div', { className: 'we-picker__hint' }, '还没有记忆。'),
    React.createElement('div', { style: { marginTop: '12px', fontSize: '13px', fontWeight: 600 } }, '它最近学到的'),
    memory.growth.length ? memory.growth.map((trait) => React.createElement('div', { key: trait.at + trait.text, style: PERSONA_STYLE.card },
      React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
        React.createElement('div', null,
          React.createElement('div', null, trait.text),
          React.createElement('div', { style: { fontSize: '10px', opacity: .65 } }, `confidence=${trait.confidence} · ${new Date(trait.at).toLocaleString()}`)),
        personaButton('删除', async () => {
          try { await apiPostJson('/pet-chat/personas/' + encodeURIComponent(p.id) + '/growth/delete', { text: trait.text }, { parse: 'always' }); void loadMemory(p.id, memory.q || ''); } catch { /* ignore */ }
        })))) : React.createElement('div', { className: 'we-picker__hint' }, '还没有成长项。'),
    React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '8px' } },
      personaInput({ type: 'date', value: memory.rollbackDate || '', onChange: (v) => setMemory((prev) => ({ ...prev, rollbackDate: v })), style: { width: '150px' } }),
      personaButton('回滚到这一天', async () => {
        if (!memory.rollbackDate) return;
        setBusy(true);
        try {
          const data = unwrap(await apiPostJson('/pet-chat/personas/' + encodeURIComponent(p.id) + '/rollback', { date: memory.rollbackDate }, { parse: 'always' }));
          setNote({ ok: data.ok === true, text: data.ok ? '已回滚' : (data.hint || '回滚失败') });
          await openPersona(p.id, 'memory');
        } catch { setNote({ ok: false, text: '回滚失败' }); } finally { setBusy(false); }
      }, { disabled: busy })));

  const pages = { basic: basicPage, model: modelPage, card: cardPage, story: storyPage, memory: memoryPage, voice: voicePage, permissions: permissionsPage };
  return React.createElement('div', { id: 'we-persona-detail', style: { marginBottom: '14px' } },
    React.createElement('div', { style: { ...PERSONA_STYLE.row, justifyContent: 'space-between' } },
      React.createElement('div', null,
        React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, personaName(p), React.createElement(KeyBadge, { status: keyStatus })),
        React.createElement('div', { style: { fontSize: '11px', opacity: .75 } }, `${personaTypeLabel(p.type)} · ${personaModeLabel(p.mode)}`)),
      React.createElement('div', { style: PERSONA_STYLE.row },
        p.id !== list.activeId ? personaButton('设为当前', () => { void activate(p.id); }, { primary: true }) : null,
        personaButton('返回列表', () => { setView('list'); setSelected(null); setDraft(null); void loadList(); }))),
    React.createElement('div', { style: { ...PERSONA_STYLE.row, marginTop: '6px', gap: '4px' } },
      tabs.map((tab) => personaButton(tab.label, () => setDetailTab(tab.id), {
        style: currentTab === tab.id ? { borderColor: 'rgba(120,190,255,.7)' } : {},
      }))),
    React.createElement('div', { style: { marginTop: '8px' } }, pages[currentTab] || basicPage),
    currentTab === 'permissions' ? null : saveRow,
    note ? React.createElement('div', { className: 'we-picker__hint', style: { color: note.ok ? undefined : '#f87171', marginTop: '5px' } }, note.text) : null);
}

export { PersonaSection };
