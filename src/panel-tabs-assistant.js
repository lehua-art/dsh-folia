/**
 * panel-tabs-assistant.js — 「智能大肥鱼」一级设置项（v0.2 三分页）。
 *
 * 用户口径（pre.55 / 任务 D）：
 *   · 助手          —— 模型 Key / 名字 / 称呼 / 状态；
 *   · 朗读与音色    —— 朗读开关在上、内置音色在中、在线 Key 音色卡在下；
 *   · 工作能力      —— 随插件携带的工作能力与冲突提示。
 *
 * 音色纪律（任务 C）：
 *   · 下拉只列 `/pet-chat/tts/voices` 里 `usable === true` 的、**本次运行真的能出声**的音色；
 *   · Edge neural 名单不打包：由宿主联网拉官方目录；
 *   · 默认策略 Edge 在线（免 Key，默认晓晓）→ 内置 Piper（首次自动下载）→ SAPI（默认关闭）；
 *   · 在线音色卡只把真正接通的写「已接通」；其余一律「即将支持」，不谎称可用。
 *
 * 契约：构建期内联进主 bundle 的工厂作用域，浏览器安全（无 import / require / Node API）。
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
  // v0.2：朗读 = voice.muted 取反；音色 = voice.name；SAPI = voice.sapiEnabled（默认 false）。
  voice: { name: '', muted: false, rate: 0, sapiEnabled: false, enabledEngine: 'edge', continuous: true, listenPaused: false },
  // v1.2：会话模式 / 语音长度 / 主动思维 / 屏幕感知 / 树洞热线（默认全关高风险项）
  conversationMode: 'chat',
  voiceLength: 8,
  proactive: { enabled: false, intervalMin: 15, quietFrom: '23:00', quietTo: '08:00' },
  screen: { mode: 'off', confirmed: false },
  treehole: { hotline: '12356' },
};

/** apiJson 的返回是 { ok, status, data }，而 /pet-chat/* 的 data 里还套一层 { ok, data }。 */
const unwrapPetChat = (resp) => (resp && resp.data && resp.data.data) || (resp && resp.data) || {};

/** 本机音色里选默认：先中文在线 Edge，再离线 Piper，最后才是系统 SAPI。 */
function assistantDefaultVoice(list) {
  const items = (Array.isArray(list) ? list : []).filter((v) => v && v.usable === true);
  return items.find((v) => v.engine === 'edge' && /^zh-CN/i.test(String(v.lang || '')))
    || items.find((v) => v.engine === 'edge')
    || items.find((v) => v.engine === 'piper')
    || items.find((v) => /^zh/i.test(String(v.lang || '')))
    || items[0]
    || null;
}

function assistantVoiceGroup(engine) {
  if (engine === 'edge') return weT('在线 · 免 Key');
  if (engine === 'piper') return weT('内置 · 离线');
  if (engine === 'sapi') return weT('系统 · SAPI');
  if (engine === 'openai') return 'OpenAI';
  if (engine === 'azure') return weT('Azure 语音');
  if (engine === 'elevenlabs') return 'ElevenLabs';
  return weT('其它');
}

function assistantVoiceTag(item) {
  if (!item) return '';
  if (item.engine === 'edge') return weT('在线神经音色');
  if (item.engine === 'piper') return weT('内置离线音色');
  if (item.engine === 'sapi') return weT('系统音色');
  if (item.engine === 'openai' || item.engine === 'azure' || item.engine === 'elevenlabs') return weT('在线 · 需 Key');
  return '';
}

/**
 * 在线音色卡。pre.57 起 OpenAI / Azure / ElevenLabs 已真实接通；
 * MiniMax / 火山 / 讯飞保持 coming-soon，并在卡片里写清“为什么接不了”。
 */
const ASSISTANT_ONLINE_PROVIDERS = [
  {
    id: 'azure',
    name: weT('Azure 语音'),
    available: true,
    pros: [weT('音色多、稳定，长文朗读不容易崩。'), weT('支持 SSML 与多语言。'), weT('企业级服务，适合正式场景。')],
    steps: [weT('填 Azure Speech Key 与区域。'), weT('点「保存并测试」真调一次。'), weT('听到测试句后再选音色。')],
    howTo: [
      weT('打开 Azure 门户 portal.azure.com，登录或注册账号。'),
      weT('搜索「Speech」→ 创建「Azure AI 服务 / 语音」资源，区域建议 East Asia。'),
      weT('创建完成后进入资源 →「密钥和端点」，复制 KEY 1 或 KEY 2。'),
      weT('区域填资源所在的 location，例如 eastasia；Key 和区域必须匹配。'),
      weT('免费层 F0 每月约 50 万字符（以官网当前额度为准），个人试用够用。'),
      weT('回到这里填 Key + 区域，点「保存并测试」；成功会显示真实合成的音色。'),
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI TTS',
    available: true,
    pros: [weT('语气自然，短句表现好。'), weT('一个 Key 同时覆盖模型与语音。'), weT('中英文混读顺滑。')],
    steps: [weT('填 OpenAI API Key。'), weT('点「保存并测试」真调一次。'), weT('选音色并听一下。')],
    howTo: [
      weT('打开 platform.openai.com，登录后进入 API keys 页面。'),
      weT('点「Create new secret key」，复制以 sk- 开头的 Key（只显示一次）。'),
      weT('在 Billing 里确认账户有可用额度；TTS 按字符计费。'),
      weT('模型建议 gpt-4o-mini-tts，音色可选 alloy / nova / shimmer 等。'),
      weT('回到这里填 Key，点「保存并测试」；401 表示 Key 无效或没有 audio 权限。'),
    ],
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    available: true,
    pros: [weT('情绪与停顿最像真人。'), weT('多语言音色库大。'), weT('适合有声内容与角色扮演。')],
    steps: [weT('填 ElevenLabs API Key。'), weT('点「保存并测试」真调一次。'), weT('按音色 ID 选择声音。')],
    howTo: [
      weT('打开 elevenlabs.io 注册账号，进入 Profile → API Keys。'),
      weT('点「Create API Key」，复制生成的 Key（以 sk_ 开头）。'),
      weT('在 Voice Library 或 Voice Lab 选一个声音，复制它的 Voice ID。'),
      weT('模型填 eleven_multilingual_v2 可读中文；免费额度以官网当前政策为准。'),
      weT('回到这里填 Key 和 Voice ID，点「保存并测试」；401/429 会显示明确原因。'),
    ],
  },
  {
    id: 'minimax',
    name: weT('MiniMax 语音'),
    available: false,
    reason: weT('官方语音接口需要 GroupId + 签名鉴权，当前版本尚未实现签名链路，不假装支持。'),
    pros: [weT('中文自然，适合日常对话。'), weT('生成速度快。'), weT('价格相对友好。')],
    steps: [weT('准备 MiniMax Key 与 GroupId。'), weT('等这个渠道接通后填入。'), weT('选择中文音色。')],
  },
  {
    id: 'volcengine',
    name: weT('火山引擎语音'),
    available: false,
    reason: weT('需要 AppId / Access Token / Cluster 三件套与官方签名，当前版本尚未接通。'),
    pros: [weT('中文音色多，角色声线丰富。'), weT('低延迟，适合实时对话。'), weT('国内网络稳定。')],
    steps: [weT('开通火山语音合成服务。'), weT('准备 AppId / Token / Cluster。'), weT('等接通后填入并选音色。')],
  },
  {
    id: 'iflytek',
    name: weT('讯飞语音'),
    available: false,
    reason: weT('需要 AppId / ApiKey / ApiSecret 与 WebSocket 鉴权，当前版本尚未接通。'),
    pros: [weT('中文发音与方言覆盖好。'), weT('教育/播报场景成熟。'), weT('支持离线方案。')],
    steps: [weT('准备讯飞 AppId / ApiKey / ApiSecret。'), weT('等接通后填入。'), weT('选择发音人并听一下。')],
  },
];

/** 通用小卡片：状态 + 优点 + 怎么用 + 详情（可展开）+ 操作区。 */
function assistantVoiceCard(props) {
  const p = props || {};
  const statusColor = p.tone === 'ok' ? '#4ade80' : (p.tone === 'warn' ? '#d9a13b' : 'rgba(235,235,245,.55)');
  const rows = [];
  rows.push(React.createElement('div', { key: 'head', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
    p.checkbox
      ? React.createElement('input', {
        key: 'check', type: 'checkbox', checked: p.checked === true, disabled: p.disabled === true,
        onChange: p.onToggle, title: weT('勾选这个音色'), style: { margin: 0 },
      })
      : null,
    React.createElement('div', { key: 'name', style: { fontSize: '12px', fontWeight: 600 } }, p.name),
    React.createElement('span', { key: 'status', style: { marginLeft: 'auto', fontSize: '11px', color: statusColor } }, p.status)));
  if (p.note) {
    rows.push(React.createElement('div', {
      key: 'note', className: 'we-picker__hint', style: { margin: '3px 0 0', fontSize: '11px' },
    }, p.note));
  }
  if (p.reason) {
    rows.push(React.createElement('div', {
      key: 'reason', className: 'we-picker__hint', style: { margin: '4px 0 0', fontSize: '11px', color: '#d9a13b' },
    }, p.reason));
  }
  if (Array.isArray(p.pros) && p.pros.length) {
    rows.push(React.createElement('div', { key: 'pros-head', style: { marginTop: '6px', fontSize: '11px', opacity: .85 } }, weT('优点')));
    rows.push(React.createElement('ul', { key: 'pros', style: { margin: '2px 0 0', paddingLeft: '16px', fontSize: '11px', lineHeight: 1.6 } },
      p.pros.map((line, index) => React.createElement('li', { key: 'p' + index }, line))));
  }
  if (Array.isArray(p.steps) && p.steps.length) {
    rows.push(React.createElement('div', { key: 'steps-head', style: { marginTop: '5px', fontSize: '11px', opacity: .85 } }, weT('怎么用')));
    rows.push(React.createElement('ol', { key: 'steps', style: { margin: '2px 0 0', paddingLeft: '18px', fontSize: '11px', lineHeight: 1.6 } },
      p.steps.map((line, index) => React.createElement('li', { key: 's' + index }, line))));
  }
  if (p.extra) rows.push(React.createElement('div', { key: 'extra', style: { marginTop: '8px' } }, p.extra));
  if (Array.isArray(p.details) && p.details.length) {
    rows.push(React.createElement('div', { key: 'detail-row', style: { marginTop: '6px' } },
      React.createElement('button', {
        type: 'button', className: 'we-picker__btn',
        style: { padding: '2px 8px', fontSize: '11px' },
        onClick: p.onDetail,
      }, p.detailOpen ? weT('收起') : weT('详情'))));
    if (p.detailOpen) {
      rows.push(React.createElement('ol', {
        key: 'details', style: { margin: '5px 0 0', paddingLeft: '18px', fontSize: '11px', lineHeight: 1.7 },
      }, p.details.map((line, index) => React.createElement('li', { key: 'd' + index }, line))));
    }
  }
  return React.createElement('div', {
    key: p.cardKey || p.name,
    style: {
      border: p.checked === true ? '1px solid rgba(120,190,255,.55)' : '1px solid rgba(255,255,255,.09)',
      borderRadius: '10px', padding: '8px 10px',
      margin: '6px 0', background: p.checked === true ? 'rgba(90,160,255,.08)' : 'rgba(255,255,255,.025)', fontSize: '12px',
    },
  }, rows);
}

/** 设置页：三分页 + 音色库 + 一键启用。 */
function PetChatSettings() {
  const [draft, setDraft] = React.useState(CHAT_DEFAULTS);
  const [status, setStatus] = React.useState({ ok: null, text: '' });
  const [note, setNote] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState('assistant');
  const [workPlugins, setWorkPlugins] = React.useState(null);
  const [voices, setVoices] = React.useState(null);
  /** v1.2：Edge 429 等“在线音色暂时不可用”的提示（列表里不再堆灰项）。 */
  const [voiceNotice, setVoiceNotice] = React.useState('');
  const [voiceMeta, setVoiceMeta] = React.useState({});
  const [voiceCfg, setVoiceCfg] = React.useState({ sapiEnabled: false, enabledEngine: 'edge', continuous: true, listenPaused: false });
  const [setupBusy, setSetupBusy] = React.useState(false);
  const [setupReport, setSetupReport] = React.useState(null);
  // pre.62：录音组件（ffmpeg）供给状态；下载中时轮询 /voice/diagnose 显示百分比。
  const [ffmpeg, setFfmpeg] = React.useState(null);
  const [enabledEngine, setEnabledEngine] = React.useState('edge');
  const [checkedEngine, setCheckedEngine] = React.useState('edge');
  const [enableBusy, setEnableBusy] = React.useState('');
  const [enableNote, setEnableNote] = React.useState(null);
  const [detailOpen, setDetailOpen] = React.useState({});
  // v1.2：屏幕感知二次确认 / 观察记录 / 记忆回滚 / 用户音色包
  const [screenArmed, setScreenArmed] = React.useState('');
  const [observeList, setObserveList] = React.useState(null);
  const [memoryInfo, setMemoryInfo] = React.useState(null);
  const [memoryNote, setMemoryNote] = React.useState(null);
  const [rollbackDate, setRollbackDate] = React.useState('');
  const [userPacks, setUserPacks] = React.useState([]);
  const [systemSounds, setSystemSounds] = React.useState([]);
  const [packForm, setPackForm] = React.useState({ name: '', license: '', author: '', refText: '', engine: 'gpt-sovits' });
  const [packNote, setPackNote] = React.useState(null);
  const [providers, setProviders] = React.useState(null);
  const [providerBusy, setProviderBusy] = React.useState(false);
  const [providerNote, setProviderNote] = React.useState(null);
  const [providerFocus, setProviderFocus] = React.useState('');
  const [piperBusy, setPiperBusy] = React.useState(false);
  const [piperNote, setPiperNote] = React.useState(null);
  const [openai, setOpenai] = React.useState({
    apiKey: '', model: 'gpt-4o-mini-tts', voice: 'alloy',
    hasKey: false, maskedKey: '', lastError: '',
  });
  const [azure, setAzure] = React.useState({
    apiKey: '', region: 'eastasia', voice: 'zh-CN-Xiao' + 'xiaoNeural',
    hasKey: false, maskedKey: '', lastError: '',
  });
  const [eleven, setEleven] = React.useState({
    apiKey: '', voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_multilingual_v2',
    hasKey: false, maskedKey: '', lastError: '',
  });
  const update = React.useCallback((patch) => setDraft((prev) => ({ ...prev, ...patch })), []);
  /** pre.63：把设置页的连续对话开关同步给右键菜单（同一 voice.continuous）。 */
  const publishContinuous = React.useCallback((enabled) => {
    try {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('we-pet-continuous-state', { detail: { enabled: enabled === true } }));
      }
    } catch { /* 菜单同步是增强 */ }
  }, []);
  React.useEffect(() => {
    const onState = (event) => {
      const detail = (event && event.detail) || {};
      if (typeof detail.enabled === 'boolean') {
        setVoiceCfg((prev) => ({ ...prev, continuous: detail.enabled }));
      }
    };
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    window.addEventListener('we-pet-continuous-state', onState);
    return () => window.removeEventListener('we-pet-continuous-state', onState);
  }, []);

  const load = React.useCallback(async () => {
    try {
      const resp = await apiJson('/pet-chat/config', { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc && doc.ok !== false) {
        const voice = Object.assign({}, CHAT_DEFAULTS.voice, (doc && doc.voice && typeof doc.voice === 'object') ? doc.voice : {});
        voice.sapiEnabled = voice.sapiEnabled === true;
        voice.enabledEngine = ['edge', 'piper', 'sapi'].includes(String(voice.enabledEngine || '')) ? voice.enabledEngine : 'edge';
        voice.continuous = voice.continuous !== false;
        voice.listenPaused = voice.listenPaused === true;
        setDraft({ ...CHAT_DEFAULTS, ...doc, voice, apiKey: '' });
        setVoiceCfg({ sapiEnabled: voice.sapiEnabled, enabledEngine: voice.enabledEngine, continuous: voice.continuous, listenPaused: voice.listenPaused });
        publishContinuous(voice.continuous !== false);
        setEnabledEngine(voice.enabledEngine);
        setCheckedEngine(voice.enabledEngine);
        setStatus(doc.hasApiKey
          ? { ok: true, text: weT('已保存的 Key：{mask}', { mask: doc.apiKeyMasked || '••••' }) }
          : { ok: null, text: weT('还没有填 API Key') });
      }
    } catch { /* 首次加载失败不打扰 */ }
  }, [publishContinuous]);

  const loadVoices = React.useCallback(async () => {
    const resp = await apiJson('/pet-chat/tts/voices', { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    const items = (doc && Array.isArray(doc.voices) ? doc.voices : []).filter((v) => v && v.usable === true);
    setVoices(items);
    setVoiceNotice(doc && doc.rateLimited === true
      ? weT('在线音色暂不可用（429 限流）：先用本地音色，稍后再试。')
      : '');
    setVoiceMeta((doc && doc.meta) || {});
    const engine = ['edge', 'piper', 'sapi'].includes(String(doc && doc.enabledEngine || '')) ? doc.enabledEngine : 'edge';
    setEnabledEngine(engine);
    setCheckedEngine(engine);
    setVoiceCfg((prev) => ({
      ...prev,
      sapiEnabled: (doc && doc.sapiEnabled === true) || items.some((v) => v.engine === 'sapi'),
      enabledEngine: engine,
      continuous: doc && doc.continuous !== undefined ? doc.continuous !== false : prev.continuous !== false,
    }));
    const fallback = assistantDefaultVoice(items);
    if (fallback) {
      setDraft((prev) => {
        const cur = prev.voice || {};
        if (cur.name && items.some((v) => v.id === cur.name)) return prev;
        return { ...prev, voice: Object.assign({}, cur, { name: fallback.id }) };
      });
    }
  }, []);

  /* ── v1.2：观察记录 / 记忆 / 用户音色包（设置页直接查看与清理）─────────── */

  const loadObserveRecords = React.useCallback(async () => {
    const resp = await apiJson('/pet-chat/observe/records?limit=20', { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    setObserveList(Array.isArray(doc.items) ? doc.items : []);
  }, []);

  const clearObserveRecords = async () => {
    await apiFetch('/pet-chat/observe/records', { method: 'DELETE' }).catch(() => null);
    setObserveList([]);
    setMemoryNote({ ok: true, text: weT('观察记录已清空') });
  };

  const loadMemoryInfo = React.useCallback(async () => {
    const resp = await apiJson('/pet-chat/memory', { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    setMemoryInfo(doc && doc.memory ? { personaId: doc.personaId, events: doc.memory.events || [], line: doc.line || '' } : null);
  }, []);

  const memoryRollback = async () => {
    if (!memoryInfo || !memoryInfo.personaId || !/^\d{4}-\d{2}-\d{2}$/.test(rollbackDate)) {
      setMemoryNote({ ok: false, text: weT('先填日期（YYYY-MM-DD）') });
      return;
    }
    const resp = await apiFetch(`/pet-chat/personas/${encodeURIComponent(memoryInfo.personaId)}/memory/by-date?date=${encodeURIComponent(rollbackDate)}`, {
      method: 'DELETE',
    }).catch(() => null);
    const doc = (resp && resp.data) || {};
    setMemoryNote({ ok: doc.ok === true, text: doc.ok === true ? weT('已回滚 {n} 条', { n: doc.deleted || 0 }) : weT('回滚失败') });
    await loadMemoryInfo();
  };

  const memoryExport = async () => {
    if (!memoryInfo || !memoryInfo.personaId) return;
    const resp = await apiFetch(`/pet-chat/personas/${encodeURIComponent(memoryInfo.personaId)}/memory/export`, { parse: false }).catch(() => null);
    try {
      const blob = await resp.response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = memoryInfo.personaId + '-memory.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch { setMemoryNote({ ok: false, text: weT('导出失败') }); }
  };

  const loadUserPacks = React.useCallback(async () => {
    const resp = await apiJson('/pet-chat/voice/user-packs', { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    setUserPacks(Array.isArray(doc.userPacks) ? doc.userPacks : []);
  }, []);
  React.useEffect(() => {
    if (tab === 'voice') void loadUserPacks();
  }, [tab, loadUserPacks]);
  React.useEffect(() => {
    if (tab !== 'voice') return;
    void apiJson('/pet-chat/system-sounds', { parse: 'always' }).then((resp) => {
      const doc = unwrapPetChat(resp);
      setSystemSounds(Array.isArray(doc.sounds) ? doc.sounds : []);
    }).catch(() => {});
  }, [tab]);

  const adminVoicePacks = async () => {
    const resp = await apiJson('/pet-chat/voice/user-packs', { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    setUserPacks(Array.isArray(doc.userPacks) ? doc.userPacks : []);
    return doc;
  };

  const importUserPack = async (file) => {
    if (!file) return;
    if (!packForm.name || !packForm.license || !packForm.author) {
      setPackNote({ ok: false, text: weT('先填名字、许可证、作者/来源——没有授权的音色不要导入') });
      return;
    }
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    if (!base64) { setPackNote({ ok: false, text: weT('读不到这个音频文件') }); return; }
    const resp = await apiPostJson('/pet-chat/voice/user-packs/import', { ...packForm, audioBase64: base64 }, { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    if (doc && doc.ok) {
      setPackNote({ ok: true, text: weT('已导入：{n}', { n: doc.pack && doc.pack.name ? doc.pack.name : packForm.name }) });
      setPackForm({ name: '', license: '', author: '', refText: '', engine: 'gpt-sovits' });
      await adminVoicePacks();
    } else {
      setPackNote({ ok: false, text: (doc && doc.hint) || weT('导入失败') });
    }
  };

  const removeUserPack = async (id) => {
    await apiPostJson('/pet-chat/voice/user-packs/remove', { id }, { parse: 'always' }).catch(() => null);
    await adminVoicePacks();
  };

  const loadFfmpeg = React.useCallback(async () => {    const resp = await apiJson('/pet-chat/voice/diagnose?light=1', { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    const st = doc && doc.steps && doc.steps.ffmpeg;
    if (st && st.phase) setFfmpeg(st);
  }, []);

  const loadProviders = React.useCallback(async () => {
    const resp = await apiJson('/pet-chat/voice/providers', { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    const list = doc && Array.isArray(doc.providers) ? doc.providers : [];
    setProviders(list);
    const oa = list.find((item) => item && item.id === 'openai');
    if (oa) {
      setOpenai((prev) => ({
        ...prev,
        model: oa.model || prev.model,
        voice: oa.voice || prev.voice,
        hasKey: oa.hasKey === true,
        maskedKey: oa.maskedKey || '',
        lastError: oa.lastError || '',
      }));
    }
    const az = list.find((item) => item && item.id === 'azure');
    if (az) {
      setAzure((prev) => ({
        ...prev,
        region: az.region || prev.region,
        voice: az.voice || prev.voice,
        hasKey: az.hasKey === true,
        maskedKey: az.maskedKey || '',
        lastError: az.lastError || '',
      }));
    }
    const el = list.find((item) => item && item.id === 'elevenlabs');
    if (el) {
      setEleven((prev) => ({
        ...prev,
        voiceId: el.voiceId || prev.voiceId,
        modelId: el.modelId || prev.modelId,
        hasKey: el.hasKey === true,
        maskedKey: el.maskedKey || '',
        lastError: el.lastError || '',
      }));
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { void loadVoices(); }, [loadVoices]);
  React.useEffect(() => { void loadFfmpeg(); }, [loadFfmpeg]);
  React.useEffect(() => { void loadProviders(); }, [loadProviders]);
  // 下载期间 800ms 刷一次进度；ready/failed/idle 不再轮询。
  React.useEffect(() => {
    const phase = ffmpeg && ffmpeg.phase;
    if (phase !== 'preparing' && phase !== 'download') return undefined;
    const timer = setInterval(() => { void loadFfmpeg(); }, 800);
    return () => clearInterval(timer);
  }, [ffmpeg && ffmpeg.phase, loadFfmpeg]);
  React.useEffect(() => {
    void (async () => {
      const resp = await apiJson('/pet-chat/work-plugins', { parse: 'always' }).catch(() => null);
      setWorkPlugins(unwrapPetChat(resp));
    })();
  }, []);

  const saveTestOpenAI = async () => {
    setProviderFocus('openai');
    setProviderBusy(true);
    setProviderNote({ ok: true, text: weT('正在保存并真调一次 OpenAI TTS…') });
    try {
      if (openai.apiKey || !openai.hasKey) {
        const saveResp = await apiPostJson('/pet-chat/voice/providers', {
          provider: 'openai',
          apiKey: openai.apiKey || '',
          model: openai.model,
          voice: openai.voice,
          enabled: true,
        }, { parse: 'always' });
        const saved = unwrapPetChat(saveResp);
        if (!saved || saved.ok === false) {
          setProviderNote({ ok: false, text: (saved && saved.error) || weT('OpenAI Key 保存失败') });
          return;
        }
      }
      const testResp = await apiPostJson('/pet-chat/voice/providers/test', { provider: 'openai' }, { parse: 'always' });
      const doc = unwrapPetChat(testResp);
      if (doc && doc.ok) {
        setProviderNote({ ok: true, text: weT('OpenAI 已接通，真实合成成功：{v}', { v: doc.actualVoice || openai.voice }) });
        if (doc.actualVoice) update({ voice: Object.assign({}, voice, { name: String(doc.actualVoice) }) });
      } else {
        const fallback = doc && doc.fallback ? weT('（已自动回落 {e} 并出声）', { e: doc.engine || 'Edge' }) : '';
        setProviderNote({ ok: false, text: weT('OpenAI 未接通：{e}{f}', { e: (doc && doc.error) || '调用失败', f: fallback }) });
      }
      setOpenai((prev) => ({ ...prev, apiKey: '' }));
      await loadProviders();
      await loadVoices();
    } catch (e) {
      setProviderNote({ ok: false, text: weT('OpenAI 测试失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally { setProviderBusy(false); }
  };

  const enableVoice = async (engine) => {
    setEnableBusy(engine);
    setEnableNote({ ok: true, text: weT('正在准备 {e} 并合成测试句…', { e: engine }) });
    try {
      const resp = await apiPostJson('/pet-chat/voice/enable', { engine }, { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc && doc.ok) {
        setEnabledEngine(engine);
        setCheckedEngine(engine);
        setVoiceCfg((prev) => ({ ...prev, enabledEngine: engine, sapiEnabled: engine === 'sapi' }));
        setDraft((prev) => ({
          ...prev,
          voice: Object.assign({}, prev.voice || {}, {
            name: doc.voice || (prev.voice && prev.voice.name),
            enabledEngine: engine,
            sapiEnabled: engine === 'sapi',
          }),
        }));
        setEnableNote({ ok: true, text: weT('已启用 {e}，测试句：{t}', { e: engine, t: doc.testText || '' }) });
        await loadVoices();
      } else {
        setEnableNote({ ok: false, text: weT('{e} 启用失败：{m}', { e: engine, m: (doc && doc.error) || '没有合成出测试句' }) });
      }
    } catch (e) {
      setEnableNote({ ok: false, text: weT('{e} 启用失败：{m}', { e: engine, m: (e && e.message) || '' }) });
    } finally { setEnableBusy(''); }
  };

  const saveTestAzure = async () => {
    setProviderFocus('azure');
    setProviderBusy(true);
    setProviderNote({ ok: true, text: weT('正在保存并真调一次 Azure TTS…') });
    try {
      if (azure.apiKey || !azure.hasKey) {
        const saveResp = await apiPostJson('/pet-chat/voice/providers', {
          provider: 'azure', apiKey: azure.apiKey || '', region: azure.region,
          voice: azure.voice, enabled: true,
        }, { parse: 'always' });
        const saved = unwrapPetChat(saveResp);
        if (!saved || saved.ok === false) {
          setProviderNote({ ok: false, text: (saved && saved.error) || weT('Azure Key 保存失败') });
          return;
        }
      }
      const testResp = await apiPostJson('/pet-chat/voice/providers/test', { provider: 'azure' }, { parse: 'always' });
      const doc = unwrapPetChat(testResp);
      if (doc && doc.ok) {
        setProviderNote({ ok: true, text: weT('Azure 已接通，真实合成成功：{v}', { v: doc.actualVoice || azure.voice }) });
        if (doc.actualVoice) update({ voice: Object.assign({}, voice, { name: String(doc.actualVoice) }) });
      } else {
        const fallback = doc && doc.fallback ? weT('（已自动回落 {e} 并出声）', { e: doc.engine || '当前内置音色' }) : '';
        setProviderNote({ ok: false, text: weT('Azure 未接通：{e}{f}', { e: (doc && doc.error) || '调用失败', f: fallback }) });
      }
      setAzure((prev) => ({ ...prev, apiKey: '' }));
      await loadProviders();
      await loadVoices();
    } catch (e) {
      setProviderNote({ ok: false, text: weT('Azure 测试失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally { setProviderBusy(false); }
  };

  const saveTestEleven = async () => {
    setProviderFocus('elevenlabs');
    setProviderBusy(true);
    setProviderNote({ ok: true, text: weT('正在保存并真调一次 ElevenLabs TTS…') });
    try {
      if (eleven.apiKey || !eleven.hasKey) {
        const saveResp = await apiPostJson('/pet-chat/voice/providers', {
          provider: 'elevenlabs', apiKey: eleven.apiKey || '', voiceId: eleven.voiceId,
          modelId: eleven.modelId, enabled: true,
        }, { parse: 'always' });
        const saved = unwrapPetChat(saveResp);
        if (!saved || saved.ok === false) {
          setProviderNote({ ok: false, text: (saved && saved.error) || weT('ElevenLabs Key 保存失败') });
          return;
        }
      }
      const testResp = await apiPostJson('/pet-chat/voice/providers/test', { provider: 'elevenlabs' }, { parse: 'always' });
      const doc = unwrapPetChat(testResp);
      if (doc && doc.ok) {
        setProviderNote({ ok: true, text: weT('ElevenLabs 已接通，真实合成成功：{v}', { v: doc.actualVoice || eleven.voiceId }) });
        if (doc.actualVoice) update({ voice: Object.assign({}, voice, { name: String(doc.actualVoice) }) });
      } else {
        const fallback = doc && doc.fallback ? weT('（已自动回落 {e} 并出声）', { e: doc.engine || '当前内置音色' }) : '';
        setProviderNote({ ok: false, text: weT('ElevenLabs 未接通：{e}{f}', { e: (doc && doc.error) || '调用失败', f: fallback }) });
      }
      setEleven((prev) => ({ ...prev, apiKey: '' }));
      await loadProviders();
      await loadVoices();
    } catch (e) {
      setProviderNote({ ok: false, text: weT('ElevenLabs 测试失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally { setProviderBusy(false); }
  };

  const preparePiper = async () => {
    setPiperBusy(true);
    setPiperNote({ ok: true, text: weT('正在下载并解压离线音色（约 85 MB）…') });
    const poll = setInterval(async () => {
      const resp = await apiJson('/pet-chat/voice/piper/progress', { parse: 'always' }).catch(() => null);
      const p = unwrapPetChat(resp);
      if (!p || p.phase === 'idle') return;
      if (p.phase === 'failed') {
        setPiperNote({ ok: false, text: weT('下载失败：{e}', { e: p.error || '网络不可达' }) });
        return;
      }
      const pct = p.percent === null || p.percent === undefined ? '' : ` ${p.percent}%`;
      if (p.phase === 'retry') {
        setPiperNote({ ok: true, text: weT('下载中断，正在重试（第 {n}/{m} 次）', { n: p.attempt || 1, m: p.retries || 3 }) });
      } else {
        setPiperNote({ ok: true, text: weT('正在下载离线音色{n}', { n: pct }) + (p.file ? ' · ' + p.file : '') });
      }
    }, 800);
    try {
      const resp = await apiPostJson('/pet-chat/voice/piper/prepare', {}, { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc && doc.ok) {
        setPiperNote({ ok: true, text: weT('离线音色已就绪：{v}', { v: doc.voice || 'Piper' }) });
      } else {
        setPiperNote({ ok: false, text: weT('离线音色准备失败：{e}', { e: (doc && doc.error) || '下载失败' }) });
      }
      await loadVoices();
      await loadProviders();
    } catch (e) {
      setPiperNote({ ok: false, text: weT('离线音色准备失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally { clearInterval(poll); setPiperBusy(false); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const voice = Object.assign({}, CHAT_DEFAULTS.voice, draft.voice || {}, {
        sapiEnabled: voiceCfg.sapiEnabled === true,
        enabledEngine,
        continuous: voiceCfg.continuous !== false,
        listenPaused: voiceCfg.listenPaused === true,
      });
      if (!voice.name) {
        const fallback = assistantDefaultVoice(voices);
        if (fallback) voice.name = fallback.id;
      }
      const body = {
        ...draft, voice,
        apiKey: draft.apiKey || '',
        enabled: Boolean(draft.apiKey) || Boolean(draft.hasApiKey),
      };
      const resp = await apiPostJson('/pet-chat/config', body, { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc.saved) {
        await apiPostJson('/pet-chat/voice/config', {
          sapiEnabled: voice.sapiEnabled,
          enabledEngine,
          continuous: voiceCfg.continuous !== false,
          listenPaused: voiceCfg.listenPaused === true,
          muted: voice.muted === true,
        }, { parse: 'always' }).catch(() => null);
        if (voice.muted === true) {
          try { petSpeakStop(); } catch { /* 朗读是增强：停不下来也不能影响保存 */ }
        }
        try { void petChatRefreshVoice(); } catch { /* 刷新失败下次唤醒会再读 */ }
        setNote({ ok: true, text: voice.muted === true ? weT('已保存（朗读已关闭）') : weT('已保存') });
        await load();
        await loadVoices();
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

  const runSetup = async () => {
    setSetupBusy(true);
    setSetupReport(null);
    setNote({ ok: true, text: weT('正在准备录音组件、检测麦克风、预热语音识别与合成…（首次会下载）') });
    // setup 是长请求（ffmpeg 70MB / ASR 模型）：并行轮询 diagnose 把 ffmpeg 进度显示出来。
    const progressTimer = setInterval(() => { void loadFfmpeg(); }, 800);
    try {
      const resp = await apiPostJson('/pet-chat/voice/setup', {
        sapiEnabled: voiceCfg.sapiEnabled === true,
        maxMs: 2500,
      }, { parse: 'always' });
      const doc = unwrapPetChat(resp);
      setSetupReport(doc && Array.isArray(doc.steps) ? doc : null);
      if (doc && doc.ffmpeg) setFfmpeg(doc.ffmpeg);
      if (doc && doc.voice) {
        setDraft((prev) => ({ ...prev, voice: Object.assign({}, prev.voice || {}, { name: doc.voice, sapiEnabled: voiceCfg.sapiEnabled === true }) }));
      }
      await loadVoices();
      await loadFfmpeg();
      setNote({
        ok: Boolean(doc && doc.ok),
        text: doc && doc.ok ? weT('一键启用完成：能听、能说。') : weT('一键启用有未通过项，见下面的报告。'),
      });
    } catch (e) {
      setNote({ ok: false, text: weT('一键启用失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally {
      clearInterval(progressTimer);
      setSetupBusy(false);
    }
  };

  const row = (key, label, node) => React.createElement('label', {
    key, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0' },
  }, weT(label), node);

  const voice = Object.assign({}, CHAT_DEFAULTS.voice, draft.voice || {});
  const voiceOn = voice.muted !== true;
  const usableVoices = (Array.isArray(voices) ? voices : []).filter((v) => v && v.usable === true);
  const currentVoiceName = voice.name || (assistantDefaultVoice(usableVoices) || {}).id || '';
  const voiceKnown = usableVoices.some((v) => String(v.id) === currentVoiceName);
  const edgeOk = usableVoices.some((v) => v.engine === 'edge') || Boolean(voiceMeta && voiceMeta.edge && voiceMeta.edge.ok);
  const piperInstalled = Boolean(voiceMeta && voiceMeta.piper && voiceMeta.piper.installed);
  const listenOn = voiceCfg.listenPaused !== true;
  // 下拉只列“当前已启用的内置引擎”+ 已测试通过的在线渠道，避免选到不参与回落的音色。
  const selectableVoices = usableVoices.filter((v) => v.engine === enabledEngine
    || ['openai', 'azure', 'elevenlabs'].includes(v.engine));

  const child = [];
  const ffmpegPhase = (ffmpeg && ffmpeg.phase) || 'idle';
  const ffmpegPct = Math.max(0, Math.min(100, Number(ffmpeg && ffmpeg.percent) || 0));
  const ffmpegReady = ffmpegPhase === 'ready' || Boolean(ffmpeg && ffmpeg.ok === true);
  const ffmpegErr = String((ffmpeg && ffmpeg.error) || '').slice(0, 80) || '未知错误';
  const ffmpegText = ffmpegReady
    ? weT('语音运行环境：ffmpeg 已就绪')
    : (ffmpegPhase === 'failed'
      ? weT('语音运行环境：准备失败（{err}）', { err: ffmpegErr })
      : (ffmpegPhase === 'preparing' || ffmpegPhase === 'download'
        ? weT('正在准备录音组件 {pct}%', { pct: ffmpegPct })
        : weT('语音运行环境：尚未准备')));
  const ffmpegRow = (key) => React.createElement('div', {
    key, className: 'we-picker__hint', style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '4px 0', color: ffmpegPhase === 'failed' ? '#f87171' : undefined },
  },
  React.createElement('span', null, ffmpegText),
  !ffmpegReady && !setupBusy
    ? React.createElement('button', {
      type: 'button', className: 'we-picker__btn', style: { fontSize: '11px', padding: '1px 8px' },
      onClick: runSetup,
    }, weT('重试'))
    : null);
  child.push(React.createElement('div', { key: 'title', style: { fontWeight: 600, margin: '14px 0 4px', fontSize: '13px' } }, weT('智能大肥鱼')));
  child.push(React.createElement('div', { key: 'hint', className: 'we-picker__hint', style: { margin: '0 0 6px' } },
    weT('填 Key、起名字、选音色；对话模式、主动搭话、屏幕感知都在「对话与隐私」里，默认全关。')));

  const tabs = [
    ['assistant', weT('助手')],
    ['behavior', weT('对话与隐私')],
    ['voice', weT('朗读与音色')],
    ['work', weT('工作能力')],
  ];
  child.push(React.createElement('div', {
    key: 'tabs', style: { display: 'flex', gap: '4px', margin: '8px 0 10px', borderBottom: '1px solid rgba(255,255,255,.08)' },
  }, tabs.map(([id, label]) => React.createElement('button', {
    key: id,
    type: 'button',
    className: 'we-picker__btn',
    onClick: () => setTab(id),
    style: {
      marginBottom: '-1px', borderRadius: '8px 8px 0 0', fontSize: '12px',
      background: tab === id ? 'rgba(255,255,255,.12)' : 'transparent',
      borderBottom: tab === id ? '2px solid currentColor' : '2px solid transparent',
      opacity: tab === id ? 1 : .72,
    },
  }, label))));

  if (tab === 'assistant') {
    child.push(React.createElement('div', { key: 'assistant-page' },
      React.createElement('div', { key: 'key', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0' } },
        weT('模型 Key'),
        React.createElement('input', {
          type: 'password', value: draft.apiKey || '',
          placeholder: draft.hasApiKey ? (draft.apiKeyMasked || '••••••••') : weT('填 DeepSeek API Key'),
          disabled: busy, style: { flex: 1, minWidth: 0 },
          onChange: (e) => update({ apiKey: e.target.value }),
        })),
      row('name', '名字', React.createElement('input', {
        type: 'text', value: draft.petName || '', placeholder: weT('桌宠叫什么（也是唤醒词）'), disabled: busy,
        style: { flex: 1, minWidth: 0 }, onChange: (e) => update({ petName: e.target.value }),
      })),
      row('owner', '称呼', React.createElement('input', {
        type: 'text', value: draft.ownerName || '', placeholder: weT('它该怎么称呼你'), disabled: busy,
        style: { flex: 1, minWidth: 0 }, onChange: (e) => update({ ownerName: e.target.value }),
      })),
      React.createElement('div', { key: 'assistant-note', className: 'we-picker__hint', style: { margin: '6px 0' } },
        weT('填完 Key 后去「朗读与音色」点一次「一键启用语音」，麦克风、音色和识别模型会自动准备好。')),
      ffmpegRow('ffmpeg-env'),
    ));
    child.push(React.createElement(MicTestBlock, { key: 'mic-test' }));
  }

  if (tab === 'behavior') {
    const mode = ['chat', 'story', 'treehole', 'observe'].includes(String(draft.conversationMode))
      ? draft.conversationMode : 'chat';
    const pro = Object.assign({}, CHAT_DEFAULTS.proactive, draft.proactive || {});
    const screen = Object.assign({}, CHAT_DEFAULTS.screen, draft.screen || {});
    const behaviorPage = [];
    const selectOf = (key, value, options, onChange, disabled) => React.createElement('select', {
      key, value, disabled: busy || disabled === true,
      onChange: (e) => onChange(e.target.value),
      style: { minWidth: '128px' },
    }, options.map(([val, label]) => React.createElement('option', { key: val, value: val }, label)));
    const toggle = (key, checked, onChange, label) => React.createElement('label', {
      key, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '4px 0' },
    }, React.createElement('input', {
      type: 'checkbox', checked, disabled: busy, onChange: (e) => onChange(e.target.checked),
    }), weT(label));

    behaviorPage.push(row('conversation-mode', '对话模式', selectOf('mode', mode, [
      ['chat', weT('聊天')], ['story', weT('讲故事')], ['treehole', weT('树洞')], ['observe', weT('只观察')],
    ], (value) => update({ conversationMode: value }))));
    behaviorPage.push(React.createElement('div', { key: 'mode-hint', className: 'we-picker__hint', style: { margin: '0 0 6px' } },
      weT('聊天＝日常短答；讲故事＝不按句数截断；树洞＝先接情绪；只观察＝不回答、只记不说。')));

    behaviorPage.push(row('voice-length', '语音回答长度', selectOf('vlen', String(draft.voiceLength), [
      ['3', weT('3 句')], ['8', weT('8 句')], ['0', weT('不限')],
    ], (value) => update({ voiceLength: Number(value) }))));

    behaviorPage.push(toggle('pro-enabled', pro.enabled === true, (checked) => update({
      proactive: Object.assign({}, pro, { enabled: checked, intervalMin: checked && !pro.intervalMin ? 15 : pro.intervalMin }),
    }), '主动搭话（默认关）'));
    behaviorPage.push(row('pro-interval', '搭话间隔', selectOf('pint', String(pro.intervalMin || 15), [
      ['15', weT('15 分钟')], ['30', weT('30 分钟')], ['60', weT('60 分钟')],
    ], (value) => update({ proactive: Object.assign({}, pro, { intervalMin: Number(value) }) }), pro.enabled !== true)));
    if (pro.enabled !== true) {
      behaviorPage.push(React.createElement('div', { key: 'pro-off', className: 'we-picker__hint', style: { margin: '0 0 6px' } },
        weT('关着的时候它只在你主动说话时回应；打开后每小时最多主动 2 次。')));
    }
    behaviorPage.push(row('quiet-from', '勿扰时段', React.createElement('div', { key: 'q', style: { display: 'flex', gap: '4px', alignItems: 'center' } },
      React.createElement('input', {
        type: 'time', value: pro.quietFrom, disabled: busy,
        onChange: (e) => update({ proactive: Object.assign({}, pro, { quietFrom: e.target.value }) }),
      }),
      React.createElement('span', null, '–'),
      React.createElement('input', {
        type: 'time', value: pro.quietTo, disabled: busy,
        onChange: (e) => update({ proactive: Object.assign({}, pro, { quietTo: e.target.value }) }),
      }))));

    behaviorPage.push(React.createElement('div', { key: 'privacy-head', style: { marginTop: '12px', fontSize: '12px', fontWeight: 600 } },
      weT('屏幕感知（默认关）')));
    behaviorPage.push(React.createElement('div', { key: 'privacy-hint', className: 'we-picker__hint', style: { margin: '2px 0 6px' } },
      weT('只读前台应用名与窗口标题（可选再加屏幕 OCR）；读不到别的 App 内部数据，绝不上传截图或 OCR 原文。')));
    behaviorPage.push(row('screen-mode', '屏幕感知', selectOf('screen', screen.mode, [
      ['off', weT('关')], ['app', weT('前台应用')], ['ocr', weT('前台 + OCR')],
    ], (value) => {
      if (value === 'off') {
        setScreenArmed('');
        update({ screen: { mode: 'off', confirmed: false } });
      } else {
        // 第一下只“上膛”，看说明再确认（不直接开）。
        setScreenArmed(value);
      }
    })));
    if (screenArmed) {
      behaviorPage.push(React.createElement('div', {
        key: 'screen-confirm', style: {
          border: '1px solid rgba(251,191,36,.45)', background: 'rgba(251,191,36,.08)',
          borderRadius: '8px', padding: '6px 8px', margin: '2px 0 6px', fontSize: '11px',
        },
      },
      React.createElement('div', { style: { marginBottom: '4px' } },
        weT('开启后它会知道你当前在用哪个应用、窗口标题是什么（前台+OCR 还会定时读取屏幕文字）。所有记录只存在本机记忆里，可随时查看、删除。')),
      React.createElement('div', { key: 'btn-row', style: { display: 'flex', gap: '6px' } },
        React.createElement('button', {
          type: 'button', className: 'we-picker__btn', disabled: busy,
          onClick: () => { update({ screen: { mode: screenArmed, confirmed: true } }); setScreenArmed(''); },
        }, weT('确认开启')),
        React.createElement('button', {
          type: 'button', className: 'we-picker__btn', disabled: busy,
          onClick: () => setScreenArmed(''),
        }, weT('取消')))));
    }
    behaviorPage.push(React.createElement('div', { key: 'status-line', className: 'we-picker__hint', style: { margin: '0 0 4px' } },
      screen.mode === 'off' ? weT('当前：关（不读前台窗口，也不截屏）') : weT('当前：已开启（可随时关）')));
    behaviorPage.push(React.createElement('div', { key: 'observe-row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '4px 0' } },
      React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => { void loadObserveRecords(); } }, weT('查看观察记录')),
      React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => { void clearObserveRecords(); } }, weT('清空观察记录'))));
    if (observeList !== null) {
      behaviorPage.push(React.createElement('div', { key: 'observe-list', className: 'we-picker__hint', style: { margin: '0 0 6px' } },
        observeList.length
          ? observeList.slice(0, 8).map((item) => React.createElement('div', { key: item.id }, '· ' + String(item.text || '').slice(0, 80)))
          : weT('还没有观察记录')));
    }

    behaviorPage.push(React.createElement('div', { key: 'memory-head', style: { marginTop: '12px', fontSize: '12px', fontWeight: 600 } },
      weT('记忆')));
    behaviorPage.push(React.createElement('div', { key: 'memory-row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '4px 0' } },
      React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => { void loadMemoryInfo(); } }, weT('查看记忆')),
      React.createElement('button', { type: 'button', className: 'we-picker__btn', onClick: () => { void memoryExport(); } }, weT('导出记忆'))));
    if (memoryInfo) {
      behaviorPage.push(React.createElement('div', { key: 'memory-info', className: 'we-picker__hint', style: { margin: '0 0 6px' } },
        weT('最近 {n} 条事件', { n: (memoryInfo.events || []).length })));
    }
    behaviorPage.push(row('memory-rollback', '按日期回滚', React.createElement('div', { key: 'r', style: { display: 'flex', gap: '4px' } },
      React.createElement('input', {
        type: 'date', value: rollbackDate, disabled: busy,
        onChange: (e) => setRollbackDate(e.target.value),
      }),
      React.createElement('button', { type: 'button', className: 'we-picker__btn', disabled: busy, onClick: () => { void memoryRollback(); } }, weT('回滚')))));
    if (memoryNote) {
      behaviorPage.push(React.createElement('div', {
        key: 'memory-note', className: 'we-picker__hint',
        style: { margin: '0 0 6px', color: memoryNote.ok ? '#4ade80' : '#f87171' },
      }, memoryNote.text));
    }
    behaviorPage.push(row('hotline', '树洞求助热线', React.createElement('input', {
      type: 'text', value: (draft.treehole && draft.treehole.hotline) || '12356', disabled: busy,
      onChange: (e) => update({ treehole: { hotline: e.target.value } }),
    })));
    child.push(React.createElement('div', { key: 'behavior-page' }, behaviorPage));
  }

  if (tab === 'voice') {
    const voicePage = [];
    voicePage.push(React.createElement('div', {
      key: 'voice-center-moved', className: 'we-picker__hint', style: { margin: '0 0 6px', opacity: .85 },
    }, weT('音色库与全局音色中心已移到人物详情里的「声音」页：内置音色包、Edge 分组、火山引擎配置都在那里；这里保留朗读开关与一键启用。')));
    voicePage.push(React.createElement('label', {
      key: 'speak-toggle',
      style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '6px 0 2px' },
    },
    React.createElement('input', {
      type: 'checkbox', checked: voiceOn, disabled: busy,
      onChange: (e) => update({ voice: Object.assign({}, voice, { muted: !e.target.checked }) }),
    }),
    weT('🔊 朗读回答')));
    voicePage.push(React.createElement('div', {
      key: 'speak-hint', className: 'we-picker__hint', style: { margin: '0 0 6px' },
    }, weT('关闭后只显示字幕、不合成语音（=「暂停说话」）；聆听与字幕不中断，保存后立刻生效。')));

    voicePage.push(React.createElement('label', {
      key: 'listen-toggle', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '6px 0 2px' },
    },
    React.createElement('input', {
      type: 'checkbox', checked: listenOn, disabled: busy,
      onChange: (e) => {
        const listening = e.target.checked;
        setVoiceCfg((prev) => ({ ...prev, listenPaused: !listening }));
        publishContinuous(listening);
        try {
          if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('we-pet-continuous', { detail: { action: listening ? 'resume' : 'pause' } }));
          }
        } catch { /* ignore */ }
      },
    }),
    weT('🎤 常驻聆听')));
    voicePage.push(React.createElement('div', {
      key: 'listen-hint', className: 'we-picker__hint', style: { margin: '0 0 6px' },
    }, weT('装好就在听（不用点桌宠）：朗读时自动闭麦，播完 300ms 恢复；取消勾选 =「暂停聆听」（临时关麦，重启后仍记住）。')));

    voicePage.push(ffmpegRow('ffmpeg-voice'));
    voicePage.push(React.createElement('div', { key: 'setup', style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '6px 0' } },
      React.createElement('button', {
        type: 'button', className: 'we-picker__btn', disabled: setupBusy || busy, onClick: runSetup,
      }, setupBusy ? weT('正在启用…') : weT('一键启用语音')),
      React.createElement('span', { className: 'we-picker__hint', style: { fontSize: '11px' } },
        weT('自动准备 ffmpeg、选麦克风、选音色、预热 ASR/TTS。'))));
    if (setupReport && Array.isArray(setupReport.steps)) {
      voicePage.push(React.createElement('div', {
        key: 'setup-report', style: {
          border: '1px solid rgba(255,255,255,.1)', borderRadius: '10px',
          padding: '6px 10px', margin: '4px 0 8px', fontSize: '11px',
        },
      }, setupReport.steps.map((step) => React.createElement('div', {
        key: step.id, style: { display: 'flex', gap: '6px', padding: '2px 0', color: step.ok ? undefined : '#f87171' },
      },
      React.createElement('span', null, step.ok ? '✓' : '✗'),
      React.createElement('span', { style: { minWidth: '54px' } }, step.label),
      React.createElement('span', { className: 'we-picker__hint', style: { margin: 0 } }, step.detail || ''),
      ))));
    }

    voicePage.push(React.createElement('div', {
      key: 'local-head', style: { marginTop: '10px', fontSize: '12px', fontWeight: 600 },
    }, weT('音色（只列本机真实可用）')));
    if (voiceNotice) {
      voicePage.push(React.createElement('div', {
        key: 'voice-notice', className: 'we-picker__hint',
        style: { margin: '2px 0', color: '#fbbf24' },
      }, voiceNotice));
    }
    if (selectableVoices.length) {
      const groups = [];
      for (const engine of ['edge', 'piper', 'sapi', 'openai', 'azure', 'elevenlabs']) {
        const items = selectableVoices.filter((v) => v.engine === engine);
        if (!items.length) continue;
        groups.push(React.createElement('optgroup', { key: 'g-' + engine, label: assistantVoiceGroup(engine) },
          items.map((v) => React.createElement('option', { key: v.id, value: v.id },
            v.label + (v.lang ? ' · ' + v.lang : '') + ' · ' + assistantVoiceTag(v)))));
      }
      voicePage.push(row('voice', '音色', React.createElement('select', {
        className: 'we-picker__playlist-select',
        disabled: busy || !selectableVoices.length,
        value: currentVoiceName,
        onChange: (e) => update({ voice: Object.assign({}, voice, { name: e.target.value }) }),
      },
      !voiceKnown && currentVoiceName
        ? React.createElement('option', { key: 'stale', value: currentVoiceName }, currentVoiceName + ' ' + weT('（当前不可用，将自动切换）'))
        : null,
      ...groups)));
      voicePage.push(React.createElement('div', {
        key: 'voice-hint', className: 'we-picker__hint', style: { margin: '2px 0' },
      }, weT('下拉只列当前已启用音色与已通过测试的在线音色；在线失败会回落到当前内置音色。')));
    } else {
      voicePage.push(React.createElement('div', {
        key: 'voice-empty', className: 'we-picker__hint', style: { margin: '4px 0' },
      }, voices === null ? weT('正在读取本机音色…') : weT('还没有可用音色，点上面的「一键启用语音」。')));
    }

    voicePage.push(React.createElement('div', {
      key: 'builtin-head', style: { marginTop: '12px', fontSize: '12px', fontWeight: 600 },
    }, weT('内置音色（勾选一个 → 点启用）')));
    voicePage.push(React.createElement('div', {
      key: 'builtin-hint', className: 'we-picker__hint', style: { margin: '2px 0 4px' },
    }, weT('同一时间只有一个音色处于「已启用」；未启用的音色不参与回落。')));
    if (enableNote && enableNote.text) {
      voicePage.push(React.createElement('div', {
        key: 'enable-note', className: 'we-picker__hint',
        style: { margin: '2px 0 4px', color: enableNote.ok ? '#4ade80' : '#f87171' },
      }, enableNote.text));
    }

    const builtinDetails = {
      edge: [
        weT('确认电脑能正常上网；Edge 在线音色不需要任何 Key。'),
        weT('勾选本卡的方框，再点「启用」。'),
        weT('宿主会先用默认中文神经音色真合成一句测试话；能出声才算启用。'),
        weT('听到测试句后，下拉里只显示 Edge 音色，换人不会影响其他引擎。'),
        weT('若失败：检查代理/防火墙是否拦截 speech.platform.bing.com，或稍后重试。'),
        weT('Edge 不可用时不会再偷偷切到 Piper/SAPI；请先启用另一个内置音色。'),
      ],
      piper: [
        weT('勾选本卡的方框，再点「启用」。'),
        weT('第一次启用会自动下载 Piper 运行时（约 22 MB）和中文模型（约 63 MB）。'),
        weT('下载完会做 sha256 校验、解压，然后用华言音色合成测试句。'),
        weT('测试句播放成功后才标为「已启用」；失败会保留原来的启用音色。'),
        weT('完全离线可用，不填 Key、不联网也能读。'),
        weT('想提前下载可点「下载离线音色」，它和启用流程共用同一个下载器。'),
      ],
      sapi: [
        weT('勾选本卡的方框，再点「启用」。'),
        weT('启用会显式打开 SAPI（voice.sapiEnabled=true），并枚举本机系统音色。'),
        weT('宿主挑一个可用 SAPI 音色真合成测试句；没有可用音色会如实报错。'),
        weT('系统音色机械感明显，只建议在 Edge/Piper 都不可用时使用。'),
        weT('启用 SAPI 会自动关闭其他内置音色的「已启用」标记。'),
      ],
    };

    voicePage.push(assistantVoiceCard({
      cardKey: 'edge', name: weT('Edge 在线音色'), checkbox: true,
      checked: checkedEngine === 'edge', disabled: Boolean(enableBusy), onToggle: () => setCheckedEngine('edge'),
      status: enabledEngine === 'edge' ? weT('已启用') : (edgeOk ? weT('未启用') : weT('当前不可用')),
      tone: enabledEngine === 'edge' ? 'ok' : (edgeOk ? 'muted' : 'warn'),
      note: edgeOk ? weT('免 Key；名字由宿主联网拉取，不随包分发。') : weT('需要联网；失败不会自动借用未启用的音色。'),
      pros: [weT('免 Key，装好就能用。'), weT('中文自然，默认晓晓。'), weT('音色多，可随时切换。')],
      steps: [weT('保持联网。'), weT('勾选后点「启用」。'), weT('听到测试句即启用成功。')],
      details: builtinDetails.edge,
      detailOpen: detailOpen.edge === true,
      onDetail: () => setDetailOpen((prev) => ({ ...prev, edge: prev.edge !== true })),
      extra: React.createElement('div', { key: 'edge-actions', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        React.createElement('button', {
          type: 'button', className: 'we-picker__btn', disabled: Boolean(enableBusy) || busy || enabledEngine === 'edge',
          onClick: () => { setCheckedEngine('edge'); void enableVoice('edge'); },
        }, enableBusy === 'edge' ? weT('正在准备…') : (enabledEngine === 'edge' ? weT('已启用') : weT('启用')))),
    }));
    voicePage.push(assistantVoiceCard({
      cardKey: 'piper', name: weT('内置神经音色（Piper）'), checkbox: true,
      checked: checkedEngine === 'piper', disabled: Boolean(enableBusy), onToggle: () => setCheckedEngine('piper'),
      status: enabledEngine === 'piper' ? weT('已启用') : (piperInstalled ? weT('未启用') : weT('未下载')),
      tone: enabledEngine === 'piper' ? 'ok' : (piperInstalled ? 'muted' : 'warn'),
      note: piperInstalled ? weT('完全离线，不再依赖网络。') : weT('首次启用会下载运行时与模型，约 85 MB。'),
      pros: [weT('完全离线，不依赖 Key。'), weT('声音比系统 SAPI 自然。'), weT('一次下载，之后都能用。')],
      steps: [weT('勾选本卡。'), weT('点「启用」，首次会自动下载。'), weT('听到测试句即启用成功。')],
      details: builtinDetails.piper,
      detailOpen: detailOpen.piper === true,
      onDetail: () => setDetailOpen((prev) => ({ ...prev, piper: prev.piper !== true })),
      extra: React.createElement('div', { key: 'piper-actions', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          React.createElement('button', {
            type: 'button', className: 'we-picker__btn', disabled: Boolean(enableBusy) || busy || enabledEngine === 'piper',
            onClick: () => { setCheckedEngine('piper'); void enableVoice('piper'); },
          }, enableBusy === 'piper' ? weT('正在准备…') : (enabledEngine === 'piper' ? weT('已启用') : weT('启用'))),
          React.createElement('button', {
            type: 'button', className: 'we-picker__btn', disabled: piperBusy || piperInstalled, onClick: preparePiper,
          }, piperInstalled ? weT('已下载') : (piperBusy ? weT('正在下载…') : weT('下载离线音色')))),
        piperNote && piperNote.text
          ? React.createElement('span', {
            className: 'we-picker__hint', style: { color: piperNote.ok ? undefined : '#f87171' },
          }, piperNote.text)
          : null),
    }));
    voicePage.push(assistantVoiceCard({
      cardKey: 'sapi', name: weT('系统音色（SAPI）'), checkbox: true,
      checked: checkedEngine === 'sapi', disabled: Boolean(enableBusy), onToggle: () => setCheckedEngine('sapi'),
      status: enabledEngine === 'sapi' ? weT('已启用') : weT('未启用'),
      tone: enabledEngine === 'sapi' ? 'warn' : 'muted',
      note: weT('零下载，但机械感明显；启用后才会参与朗读。'),
      pros: [weT('系统自带，不占空间。'), weT('离线可用。'), weT('兼容性最好。')],
      steps: [weT('勾选本卡。'), weT('点「启用」，宿主会显式打开 SAPI。'), weT('听到测试句即启用成功。')],
      details: builtinDetails.sapi,
      detailOpen: detailOpen.sapi === true,
      onDetail: () => setDetailOpen((prev) => ({ ...prev, sapi: prev.sapi !== true })),
      extra: React.createElement('button', {
        type: 'button', className: 'we-picker__btn', disabled: Boolean(enableBusy) || busy || enabledEngine === 'sapi',
        onClick: () => { setCheckedEngine('sapi'); void enableVoice('sapi'); },
      }, enableBusy === 'sapi' ? weT('正在准备…') : (enabledEngine === 'sapi' ? weT('已启用') : weT('启用'))),
    }));

    voicePage.push(React.createElement('div', {
      key: 'online-head', style: { marginTop: '14px', fontSize: '12px', fontWeight: 600 },
    }, weT('在线音色（需 Key）')));
    voicePage.push(React.createElement('div', {
      key: 'online-note', className: 'we-picker__hint', style: { margin: '2px 0 4px' },
    }, weT('已真实接通 OpenAI / Azure / ElevenLabs；其余渠道如实标「即将支持」，不读取也不上传 Key。')));
    for (const provider of ASSISTANT_ONLINE_PROVIDERS) {
      const pv = (Array.isArray(providers) ? providers : []).find((item) => item && item.id === provider.id) || {};
      const detailKey = 'provider:' + provider.id;
      const detailProps = {
        details: Array.isArray(provider.howTo) ? provider.howTo : [provider.reason || weT('当前版本尚未接通。')],
        detailOpen: detailOpen[detailKey] === true,
        onDetail: () => setDetailOpen((prev) => ({ ...prev, [detailKey]: prev[detailKey] !== true })),
      };
      if (!provider.available) {
        voicePage.push(assistantVoiceCard({
          cardKey: provider.id, name: provider.name, status: weT('即将支持'), tone: 'muted',
          reason: provider.reason || weT('当前版本尚未接通。'),
          note: weT('当前版本尚未接通，不会读取或上传你的 Key。'),
          pros: provider.pros, steps: provider.steps, ...detailProps,
        }));
        continue;
      }
      const connected = pv.lastOk === true;
      const configured = pv.hasKey === true;
      const status = connected ? weT('已接通 · 已验证') : (configured ? weT('已保存 Key，待测试') : weT('未配置'));
      const cfgState = provider.id === 'openai' ? openai : (provider.id === 'azure' ? azure : eleven);
      const apiField = React.createElement('label', { key: 'key', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
        provider.id === 'azure' ? weT('Azure Key') : (provider.id === 'elevenlabs' ? weT('ElevenLabs Key') : weT('OpenAI Key')),
        React.createElement('input', {
          type: 'password', value: cfgState.apiKey || '',
          placeholder: cfgState.hasKey ? (cfgState.maskedKey || '••••••••') : (provider.id === 'elevenlabs' ? 'sk_…' : 'sk-…'),
          disabled: providerBusy, style: { flex: 1, minWidth: 0 },
          onChange: (e) => {
            const value = e.target.value;
            if (provider.id === 'openai') setOpenai((prev) => ({ ...prev, apiKey: value }));
            else if (provider.id === 'azure') setAzure((prev) => ({ ...prev, apiKey: value }));
            else setEleven((prev) => ({ ...prev, apiKey: value }));
          },
        }));
      const fields = [apiField];
      if (provider.id === 'openai') {
        fields.push(React.createElement('label', { key: 'model', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('模型'), React.createElement('input', {
            type: 'text', value: openai.model || 'gpt-4o-mini-tts', disabled: providerBusy,
            style: { flex: 1, minWidth: 0 },
            onChange: (e) => setOpenai((prev) => ({ ...prev, model: e.target.value })),
          })));
        fields.push(React.createElement('label', { key: 'voice', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('音色'), React.createElement('select', {
            value: openai.voice || 'alloy', disabled: providerBusy, style: { flex: 1, minWidth: 0 },
            onChange: (e) => setOpenai((prev) => ({ ...prev, voice: e.target.value })),
          }, ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map((name) =>
            React.createElement('option', { key: name, value: name }, name)))));
      } else if (provider.id === 'azure') {
        fields.push(React.createElement('label', { key: 'region', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('区域'), React.createElement('input', {
            type: 'text', value: azure.region || 'eastasia', disabled: providerBusy,
            placeholder: 'eastasia', style: { flex: 1, minWidth: 0 },
            onChange: (e) => setAzure((prev) => ({ ...prev, region: e.target.value })),
          })));
        fields.push(React.createElement('label', { key: 'voice', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('音色'), React.createElement('input', {
            type: 'text', value: azure.voice || '', disabled: providerBusy,
            placeholder: weT('中文神经音色 ID'), style: { flex: 1, minWidth: 0 },
            onChange: (e) => setAzure((prev) => ({ ...prev, voice: e.target.value })),
          })));
      } else {
        fields.push(React.createElement('label', { key: 'voiceId', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('音色 ID'), React.createElement('input', {
            type: 'text', value: eleven.voiceId || '', disabled: providerBusy,
            placeholder: '21m00Tcm4TlvDq8ikWAM', style: { flex: 1, minWidth: 0 },
            onChange: (e) => setEleven((prev) => ({ ...prev, voiceId: e.target.value })),
          })));
        fields.push(React.createElement('label', { key: 'modelId', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('模型 ID'), React.createElement('input', {
            type: 'text', value: eleven.modelId || 'eleven_multilingual_v2', disabled: providerBusy,
            style: { flex: 1, minWidth: 0 },
            onChange: (e) => setEleven((prev) => ({ ...prev, modelId: e.target.value })),
          })));
      }
      fields.push(React.createElement('div', { key: 'actions', style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
        React.createElement('button', {
          type: 'button', className: 'we-picker__btn', disabled: providerBusy,
          style: { whiteSpace: 'nowrap' },
          onClick: provider.id === 'openai' ? saveTestOpenAI : (provider.id === 'azure' ? saveTestAzure : saveTestEleven),
        }, providerBusy ? weT('正在测试…') : weT('保存并测试')),
        React.createElement('span', { className: 'we-picker__hint', style: { margin: 0, fontSize: '11px', flex: '1 1 140px' } },
          weT('真调一次；失败会给 401/429/超时原因，并回落到当前内置音色。'))));
      fields.push(providerNote && providerNote.text && providerFocus === provider.id
        ? React.createElement('div', {
          key: 'note', className: 'we-picker__hint', style: { margin: 0, color: providerNote.ok ? undefined : '#f87171' },
        }, providerNote.text)
        : null);
      voicePage.push(assistantVoiceCard({
        cardKey: provider.id, name: provider.name, status,
        tone: connected ? 'ok' : (configured ? 'warn' : 'muted'),
        note: pv.lastError ? weT('上次失败：{e}', { e: pv.lastError }) : weT('Key 只存本机；只在你点「保存并测试」时发起一次真实调用。'),
        pros: provider.pros,
        steps: provider.steps,
        extra: React.createElement('div', {
          key: 'form-' + provider.id, style: { display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11px' },
        }, fields),
        ...detailProps,
      }));
    }
    // v1.2：角色音色只走「用户下载/导入」；内置只有 4 个系统音效。
    voicePage.push(React.createElement('div', {
      key: 'pack-head', style: { marginTop: '14px', fontSize: '12px', fontWeight: 600 },
    }, weT('用户音色包（角色语音只走导入）')));
    voicePage.push(React.createElement('div', {
      key: 'pack-policy', className: 'we-picker__hint', style: { margin: '2px 0 6px' },
    }, weT('本插件不携带角色/声优素材。导入前请确认你有权使用这段参考音频，并填写许可证与作者/来源。')));
    if (userPacks.length) {
      voicePage.push(React.createElement('div', { key: 'pack-list', style: { display: 'flex', flexDirection: 'column', gap: '3px', margin: '0 0 6px' } },
        userPacks.map((pack) => React.createElement('div', { key: pack.id, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px' } },
          React.createElement('span', { style: { flex: 1 } }, `${pack.name} · ${pack.engine} · ${pack.license || weT('未填许可证')}`),
          React.createElement('button', {
            type: 'button', className: 'we-picker__btn', onClick: () => { void removeUserPack(pack.id); },
          }, weT('删除'))))));
    }
    const packInput = (key, placeholder, value, onChange, type) => React.createElement('input', {
      key, type: type || 'text', value, placeholder, disabled: busy,
      onChange: (e) => onChange(e.target.value),
      style: { fontSize: '11px', padding: '2px 6px', minWidth: '0' },
    });
    voicePage.push(React.createElement('div', {
      key: 'pack-form', style: { display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 0 6px' },
    },
    packInput('pname', weT('音色包名字'), packForm.name, (v) => setPackForm((prev) => ({ ...prev, name: v }))),
    packInput('plicense', weT('许可证（如：本人录制，仅自用）'), packForm.license, (v) => setPackForm((prev) => ({ ...prev, license: v }))),
    packInput('pauthor', weT('作者 / 来源'), packForm.author, (v) => setPackForm((prev) => ({ ...prev, author: v }))),
    packInput('pref', weT('参考音频对应的文字（可选）'), packForm.refText, (v) => setPackForm((prev) => ({ ...prev, refText: v }))),
    React.createElement('div', { key: 'import-row', style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
      React.createElement('input', {
        key: 'file', type: 'file', accept: 'audio/*',
        onChange: (e) => { const file = e.target.files && e.target.files[0]; void importUserPack(file); },
      }),
      React.createElement('span', { className: 'we-picker__hint', style: { margin: 0 } },
        weT('参考音频只存本机用户目录，不进 npm 包、不上传。')))));
    if (packNote && packNote.text) {
      voicePage.push(React.createElement('div', {
        key: 'pack-note', className: 'we-picker__hint',
        style: { margin: '0 0 6px', color: packNote.ok ? '#4ade80' : '#f87171' },
      }, packNote.text));
    }
    voicePage.push(React.createElement('div', { key: 'sound-head', className: 'we-picker__hint', style: { margin: '2px 0' } },
      weT('内置系统音效（4 个，MIT，本项目合成；不含角色语音）')));
    if (systemSounds.length) {
      voicePage.push(React.createElement('div', { key: 'sound-list', style: { display: 'flex', flexDirection: 'column', gap: '3px', margin: '0 0 6px' } },
        systemSounds.map((sound) => React.createElement('div', { key: sound.id, style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px' } },
          React.createElement('span', null, `${sound.name} · ${sound.license || ''}`),
          React.createElement('audio', {
            controls: true, preload: 'none', style: { height: '22px' },
            src: apiUrl('/pet-chat/system-sounds/' + encodeURIComponent(sound.id) + '.wav'),
          })))));
    }
    child.push(React.createElement('div', { key: 'voice-page' }, voicePage));
  }

  if (tab === 'work') {
    const workPage = [];
    const workItems = (workPlugins && Array.isArray(workPlugins.items)) ? workPlugins.items : [];
    workPage.push(React.createElement('div', {
      key: 'work-head', style: { marginTop: '4px', fontSize: '12px', fontWeight: 600 },
    }, weT('可选工作能力（已安装才可用）')));
    if (!workItems.length) {
      workPage.push(React.createElement('div', { key: 'work-empty', className: 'we-picker__hint' }, weT('正在读取…')));
    } else {
      workItems.forEach((item) => {
        workPage.push(React.createElement('div', {
          key: 'work-' + item.id, className: 'we-picker__hint', style: { margin: '3px 0' },
        }, (item.installed ? '✓ ' : '· ') + item.label
          + (item.version ? ' ' + item.version : '')
          + (item.needs ? '（' + item.needs + '）' : '')));
      });
    }
    if (workPlugins && workPlugins.conflict) {
      workPage.push(React.createElement('div', {
        key: 'work-conflict', className: 'we-picker__hint', style: { marginTop: '4px', color: '#d9a13b' },
      }, weT('冲突提醒：') + workPlugins.conflict.note));
    }
    child.push(React.createElement('div', { key: 'work-page' }, workPage));
  }

  child.push(React.createElement('div', {
    key: 'status', className: 'we-picker__hint', style: { margin: '8px 0 6px', color: status.ok === false ? '#f87171' : undefined },
  }, status.text || weT('未连接')));
  if (note && note.text) {
    child.push(React.createElement('div', {
      key: 'note', className: 'we-picker__hint', style: { minHeight: '18px', margin: '2px 0 4px', color: note.ok ? undefined : '#f87171' },
    }, note.text));
  } else {
    child.push(React.createElement('div', { key: 'note-empty', style: { minHeight: '18px' } }));
  }
  child.push(React.createElement('div', { key: 'save', style: { display: 'flex', gap: '6px', marginTop: '4px' } },
    React.createElement('button', { type: 'button', className: 'we-picker__btn', disabled: busy, onClick: save }, weT('保存')),
  ));

  return React.createElement('div', { id: 'we-pet-chat-settings', style: { ...PET_STYLE.card, marginTop: '10px' } }, child);
}

/**
 * 麦克风测试：录 3 秒 → 直接播回给用户。
 * 用途：让用户自己确认“到底是没说话，还是插件没录到”。
 */
function MicTestBlock() {
  const [state, setState] = React.useState({ text: '', busy: false, ok: null });
  const run = async () => {
    setState({ text: weT('正在录音 3 秒…对着麦说话'), busy: true, ok: null });
    try {
      const res = await apiFetch('/pet-chat/voice/mic-test', { parse: false, cache: 'no-store' });
      if (!res.ok) {
        // apiFetch 返回 { ok, status, data, error, response }：非 2xx 时体在 response 里，不是 res.json()
        let body = {};
        try { body = await res.response.text().then((x) => (x ? JSON.parse(x) : {})); } catch { body = {}; }
        setState({ text: weT('没录到：') + (body.hint || body.code || res.status || res.error || ''), busy: false, ok: false });
        return;
      }
      const response = res.response;
      const blob = await response.blob();
      const bytes = Number(response.headers.get('X-Folia-Mic-Bytes') || blob.size || 0);
      const rms = response.headers.get('X-Folia-Mic-Rms') || '';
      const url = URL.createObjectURL(blob);
      try {
        const audio = new Audio(url);
        audio.onended = () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } };
        await audio.play();
      } catch { /* 播放被拒就保留 URL，不影响结论 */ }
      setState({ text: weT('录到 {kb}KB，正在播回你的声音（RMS {rms}）', { kb: Math.round(bytes / 1024), rms }), busy: false, ok: true });
    } catch (error) {
      setState({ text: weT('测试失败：') + String((error && error.message) || error), busy: false, ok: false });
    }
  };
  return React.createElement('div', { style: { marginTop: '10px', padding: '8px', border: '1px solid rgba(255,255,255,.10)', borderRadius: '8px' } },
    React.createElement('div', { style: { fontSize: '12px', fontWeight: 600, marginBottom: '4px' } }, weT('麦克风测试')),
    React.createElement('div', { className: 'we-picker__hint', style: { marginBottom: '6px' } }, weT('点一下录 3 秒，会直接播回你刚说的话。')),
    React.createElement('button', { type: 'button', className: 'we-picker__btn', disabled: state.busy, onClick: run },
      state.busy ? weT('录音中…') : weT('测试麦克风')),
    state.text ? React.createElement('div', { className: 'we-picker__hint', style: { marginTop: '4px', color: state.ok === false ? '#f87171' : undefined } }, state.text) : null,
  );
}

/**
 * 「智能大肥鱼」一级设置页。只做版面装配：标题 + 三分页表单。
 * 设置导航的注册在 `src/client.js`（id=folia-assistant，order 502）。
 */
function AssistantSection() {
  return React.createElement('div', { className: 'we-assistant-section', style: { padding: '4px 2px' } },
    React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, weT('智能大肥鱼')),
    React.createElement(PersonaSection, null),
  );
}

export { AssistantSection, PetChatSettings };
