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
  voice: { name: '', muted: false, rate: 0, sapiEnabled: false },
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
  return weT('其它');
}

function assistantVoiceTag(item) {
  if (!item) return '';
  if (item.engine === 'edge') return weT('在线神经音色');
  if (item.engine === 'piper') return weT('内置离线音色');
  if (item.engine === 'sapi') return weT('系统音色');
  return '';
}

/**
 * 需 Key 的在线音色卡。v0.2 **尚未接通**，状态固定「即将支持」；
 * 这里只写“擅长什么 + 接通后怎么用”，不出现任何“已经能用”的假话。
 */
const ASSISTANT_ONLINE_PROVIDERS = [
  {
    id: 'azure',
    name: weT('Azure 语音'),
    pros: [weT('音色多、稳定，长文朗读不容易崩。'), weT('支持 SSML 与多语言。'), weT('企业级服务，适合正式场景。')],
    steps: [weT('准备 Azure Speech Key 与区域。'), weT('等这个渠道接通后，在卡片里填入 Key。'), weT('选一个中文音色听一下，再保存。')],
  },
  {
    id: 'openai',
    name: 'OpenAI TTS',
    pros: [weT('语气自然，短句表现好。'), weT('一个 Key 同时覆盖模型与语音。'), weT('中英文混读顺滑。')],
    steps: [weT('准备 OpenAI API Key。'), weT('等这个渠道接通后，在卡片里填入 Key。'), weT('选音色并听一下。')],
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    pros: [weT('情绪与停顿最像真人。'), weT('多语言音色库大。'), weT('适合有声内容与角色扮演。')],
    steps: [weT('准备 ElevenLabs API Key。'), weT('等这个渠道接通后填入 Key。'), weT('按音色 ID 选择声音。')],
  },
  {
    id: 'minimax',
    name: weT('MiniMax 语音'),
    pros: [weT('中文自然，适合日常对话。'), weT('生成速度快。'), weT('价格相对友好。')],
    steps: [weT('准备 MiniMax Key 与 GroupId。'), weT('等这个渠道接通后填入。'), weT('选择中文音色。')],
  },
  {
    id: 'volcengine',
    name: weT('火山引擎语音'),
    pros: [weT('中文音色多，角色声线丰富。'), weT('低延迟，适合实时对话。'), weT('国内网络稳定。')],
    steps: [weT('开通火山语音合成服务。'), weT('准备 AppId / Token / Cluster。'), weT('等接通后填入并选音色。')],
  },
  {
    id: 'iflytek',
    name: weT('讯飞语音'),
    pros: [weT('中文发音与方言覆盖好。'), weT('教育/播报场景成熟。'), weT('支持离线方案。')],
    steps: [weT('准备讯飞 AppId / ApiKey / ApiSecret。'), weT('等接通后填入。'), weT('选择发音人并听一下。')],
  },
];

/** 通用小卡片：优点 2–3 条 + 怎么用 2–4 步 + 状态。 */
function assistantVoiceCard(props) {
  const p = props || {};
  const statusColor = p.tone === 'ok' ? '#4ade80' : (p.tone === 'warn' ? '#d9a13b' : 'rgba(235,235,245,.55)');
  const rows = [];
  rows.push(React.createElement('div', { key: 'head', style: { display: 'flex', gap: '6px', alignItems: 'baseline' } },
    React.createElement('div', { key: 'name', style: { fontSize: '12px', fontWeight: 600 } }, p.name),
    React.createElement('span', { key: 'status', style: { marginLeft: 'auto', fontSize: '11px', color: statusColor } }, p.status)));
  if (p.note) {
    rows.push(React.createElement('div', {
      key: 'note', className: 'we-picker__hint', style: { margin: '3px 0 0', fontSize: '11px' },
    }, p.note));
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
  return React.createElement('div', {
    key: p.cardKey || p.name,
    style: {
      border: '1px solid rgba(255,255,255,.09)', borderRadius: '10px', padding: '8px 10px',
      margin: '6px 0', background: 'rgba(255,255,255,.025)', fontSize: '12px',
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
  const [voiceMeta, setVoiceMeta] = React.useState({});
  const [voiceCfg, setVoiceCfg] = React.useState({ sapiEnabled: false });
  const [setupBusy, setSetupBusy] = React.useState(false);
  const [setupReport, setSetupReport] = React.useState(null);
  const [providers, setProviders] = React.useState(null);
  const [providerBusy, setProviderBusy] = React.useState(false);
  const [providerNote, setProviderNote] = React.useState(null);
  const [piperBusy, setPiperBusy] = React.useState(false);
  const [piperNote, setPiperNote] = React.useState(null);
  const [openai, setOpenai] = React.useState({
    apiKey: '', model: 'gpt-4o-mini-tts', voice: 'alloy',
    hasKey: false, maskedKey: '', lastError: '',
  });
  const update = React.useCallback((patch) => setDraft((prev) => ({ ...prev, ...patch })), []);

  const load = React.useCallback(async () => {
    try {
      const resp = await apiJson('/pet-chat/config', { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc && doc.ok !== false) {
        const voice = Object.assign({}, CHAT_DEFAULTS.voice, (doc && doc.voice && typeof doc.voice === 'object') ? doc.voice : {});
        voice.sapiEnabled = voice.sapiEnabled === true;
        setDraft({ ...CHAT_DEFAULTS, ...doc, voice, apiKey: '' });
        setVoiceCfg({ sapiEnabled: voice.sapiEnabled });
        setStatus(doc.hasApiKey
          ? { ok: true, text: weT('已保存的 Key：{mask}', { mask: doc.apiKeyMasked || '••••' }) }
          : { ok: null, text: weT('还没有填 API Key') });
      }
    } catch { /* 首次加载失败不打扰 */ }
  }, []);

  const loadVoices = React.useCallback(async () => {
    const resp = await apiJson('/pet-chat/tts/voices', { parse: 'always' }).catch(() => null);
    const doc = unwrapPetChat(resp);
    const items = (doc && Array.isArray(doc.voices) ? doc.voices : []).filter((v) => v && v.usable === true);
    setVoices(items);
    setVoiceMeta((doc && doc.meta) || {});
    setVoiceCfg({ sapiEnabled: (doc && doc.sapiEnabled === true) || items.some((v) => v.engine === 'sapi') });
    const fallback = assistantDefaultVoice(items);
    if (fallback) {
      setDraft((prev) => {
        const cur = prev.voice || {};
        if (cur.name && items.some((v) => v.id === cur.name)) return prev;
        return { ...prev, voice: Object.assign({}, cur, { name: fallback.id }) };
      });
    }
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
  }, []);

  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => { void loadVoices(); }, [loadVoices]);
  React.useEffect(() => { void loadProviders(); }, [loadProviders]);
  React.useEffect(() => {
    void (async () => {
      const resp = await apiJson('/pet-chat/work-plugins', { parse: 'always' }).catch(() => null);
      setWorkPlugins(unwrapPetChat(resp));
    })();
  }, []);

  const setSapiEnabled = async (enabled) => {
    const voice = Object.assign({}, CHAT_DEFAULTS.voice, draft.voice || {}, { sapiEnabled: enabled });
    update({ voice });
    setVoiceCfg({ sapiEnabled: enabled });
    try {
      await apiPostJson('/pet-chat/voice/config', { sapiEnabled: enabled }, { parse: 'always' });
      await loadVoices();
    } catch {
      setNote({ ok: false, text: weT('系统音色开关保存失败') });
    }
  };

  const saveTestOpenAI = async () => {
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
      const voice = Object.assign({}, CHAT_DEFAULTS.voice, draft.voice || {}, { sapiEnabled: voiceCfg.sapiEnabled === true });
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
        await apiPostJson('/pet-chat/voice/config', { sapiEnabled: voice.sapiEnabled }, { parse: 'always' }).catch(() => null);
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
    setNote({ ok: true, text: weT('正在检测麦克风、预热语音识别与合成…（首次会下载模型）') });
    try {
      const resp = await apiPostJson('/pet-chat/voice/setup', {
        sapiEnabled: voiceCfg.sapiEnabled === true,
        maxMs: 2500,
      }, { parse: 'always' });
      const doc = unwrapPetChat(resp);
      setSetupReport(doc && Array.isArray(doc.steps) ? doc : null);
      if (doc && doc.voice) {
        setDraft((prev) => ({ ...prev, voice: Object.assign({}, prev.voice || {}, { name: doc.voice, sapiEnabled: voiceCfg.sapiEnabled === true }) }));
      }
      await loadVoices();
      setNote({
        ok: Boolean(doc && doc.ok),
        text: doc && doc.ok ? weT('一键启用完成：能听、能说。') : weT('一键启用有未通过项，见下面的三步报告。'),
      });
    } catch (e) {
      setNote({ ok: false, text: weT('一键启用失败：{msg}', { msg: (e && e.message) || '' }) });
    } finally { setSetupBusy(false); }
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

  const child = [];
  child.push(React.createElement('div', { key: 'title', style: { fontWeight: 600, margin: '14px 0 4px', fontSize: '13px' } }, weT('智能大肥鱼')));
  child.push(React.createElement('div', { key: 'hint', className: 'we-picker__hint', style: { margin: '0 0 6px' } },
    weT('填 Key、起名字、选音色，再决定要不要朗读。主动搭话与记忆是固定策略；停止/恢复对它说一声就行。')));

  const tabs = [
    ['assistant', weT('助手')],
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
    ));
  }

  if (tab === 'voice') {
    const voicePage = [];
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
    }, weT('关闭后只显示字幕、不合成语音（省算力）；保存后立刻生效。')));

    voicePage.push(React.createElement('div', { key: 'setup', style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '6px 0' } },
      React.createElement('button', {
        type: 'button', className: 'we-picker__btn', disabled: setupBusy || busy, onClick: runSetup,
      }, setupBusy ? weT('正在启用…') : weT('一键启用语音')),
      React.createElement('span', { className: 'we-picker__hint', style: { fontSize: '11px' } },
        weT('自动选麦克风、选音色、预热 ASR/TTS。'))));
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
    if (usableVoices.length) {
      const groups = [];
      for (const engine of ['edge', 'piper', 'sapi']) {
        const items = usableVoices.filter((v) => v.engine === engine);
        if (!items.length) continue;
        groups.push(React.createElement('optgroup', { key: 'g-' + engine, label: assistantVoiceGroup(engine) },
          items.map((v) => React.createElement('option', { key: v.id, value: v.id },
            v.label + (v.lang ? ' · ' + v.lang : '') + ' · ' + assistantVoiceTag(v)))));
      }
      voicePage.push(row('voice', '音色', React.createElement('select', {
        className: 'we-picker__playlist-select',
        disabled: busy || !usableVoices.length,
        value: currentVoiceName,
        onChange: (e) => update({ voice: Object.assign({}, voice, { name: e.target.value }) }),
      },
      !voiceKnown && currentVoiceName
        ? React.createElement('option', { key: 'stale', value: currentVoiceName }, currentVoiceName + ' ' + weT('（当前不可用，将自动切换）'))
        : null,
      ...groups)));
      voicePage.push(React.createElement('div', {
        key: 'voice-hint', className: 'we-picker__hint', style: { margin: '2px 0' },
      }, weT('默认用 Edge 在线音色（免 Key）；失败自动退到内置离线音色。')));
    } else {
      voicePage.push(React.createElement('div', {
        key: 'voice-empty', className: 'we-picker__hint', style: { margin: '4px 0' },
      }, voices === null ? weT('正在读取本机音色…') : weT('还没有可用音色，点上面的「一键启用语音」。')));
    }

    voicePage.push(React.createElement('label', {
      key: 'sapi-toggle', style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '8px 0 2px' },
    },
    React.createElement('input', {
      type: 'checkbox', checked: voiceCfg.sapiEnabled === true, disabled: busy,
      onChange: (e) => { void setSapiEnabled(e.target.checked); },
    }),
    weT('使用系统音色（SAPI）')));
    voicePage.push(React.createElement('div', {
      key: 'sapi-hint', className: 'we-picker__hint', style: { margin: '0 0 6px' },
    }, weT('默认关闭。系统音色机械感重，只有你手动打开才会参与朗读。')));

    voicePage.push(React.createElement('div', {
      key: 'builtin-head', style: { marginTop: '12px', fontSize: '12px', fontWeight: 600 },
    }, weT('内置音色')));
    voicePage.push(assistantVoiceCard({
      cardKey: 'edge', name: weT('Edge 在线音色'), status: edgeOk ? weT('已接通 · 免 Key') : weT('当前不可用'),
      tone: edgeOk ? 'ok' : 'warn',
      note: edgeOk ? weT('默认晓晓；名字由宿主联网拉取，不随包分发。') : weT('需要联网；失败会自动尝试内置离线音色。'),
      pros: [weT('免 Key，装好就能用。'), weT('中文自然，默认晓晓。'), weT('音色多，可随时切换。')],
      steps: [weT('保持联网。'), weT('点「一键启用语音」。'), weT('在上面的音色下拉里换人。')],
    }));
    voicePage.push(assistantVoiceCard({
      cardKey: 'piper', name: weT('内置神经音色（Piper）'),
      status: piperInstalled ? weT('已内置 · 离线') : weT('未下载 · 断网兜底'),
      tone: piperInstalled ? 'ok' : 'warn',
      note: piperInstalled ? weT('完全离线，不再依赖网络。') : weT('Edge 断网时的兜底；点下面的按钮下载，约 85 MB。'),
      pros: [weT('完全离线，不依赖 Key。'), weT('声音比系统 SAPI 自然。'), weT('一次下载，之后都能用。')],
      steps: [weT('在网络正常时点「下载离线音色」。'), weT('下载、解压、sha256 校验完成后自动可用。'), weT('Edge 断网时自动切到它；恢复后自动回在线。')],
      extra: React.createElement('div', { key: 'piper-actions', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement('button', {
          type: 'button', className: 'we-picker__btn', disabled: piperBusy || piperInstalled, onClick: preparePiper,
        }, piperInstalled ? weT('已下载') : (piperBusy ? weT('正在下载…') : weT('下载离线音色'))),
        piperNote && piperNote.text
          ? React.createElement('span', {
            className: 'we-picker__hint', style: { color: piperNote.ok ? undefined : '#f87171' },
          }, piperNote.text)
          : null),
    }));
    voicePage.push(assistantVoiceCard({
      cardKey: 'sapi', name: weT('系统音色（SAPI）'),
      status: voiceCfg.sapiEnabled ? weT('已开启') : weT('默认关闭'),
      tone: voiceCfg.sapiEnabled ? 'warn' : 'muted',
      note: weT('零下载，但机械感明显；只作为你手动开启后的最后兜底。'),
      pros: [weT('系统自带，不占空间。'), weT('离线可用。'), weT('兼容性最好。')],
      steps: [weT('打开上面的「使用系统音色」开关。'), weT('保存后，本机 SAPI 音色才会出现在下拉里。'), weT('不需要时可随时关掉。')],
    }));

    voicePage.push(React.createElement('div', {
      key: 'online-head', style: { marginTop: '14px', fontSize: '12px', fontWeight: 600 },
    }, weT('在线音色（需 Key）')));
    voicePage.push(React.createElement('div', {
      key: 'online-note', className: 'we-picker__hint', style: { margin: '2px 0 4px' },
    }, weT('只有状态为「已接通」的渠道才会出现在音色下拉里；其余如实标「即将支持」，不会假装能用。')));
    for (const provider of ASSISTANT_ONLINE_PROVIDERS) {
      if (provider.id === 'openai') {
        const oa = (Array.isArray(providers) ? providers : []).find((item) => item && item.id === 'openai') || {};
        const connected = oa.lastOk === true;
        const configured = oa.hasKey === true;
        const status = connected ? weT('已接通 · 已验证')
          : configured ? weT('已保存 Key，待测试') : weT('未配置');
        const form = React.createElement('div', {
          key: 'openai-form', style: { display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '11px' },
        },
        React.createElement('label', { key: 'key', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('OpenAI Key'),
          React.createElement('input', {
            type: 'password', value: openai.apiKey || '',
            placeholder: openai.hasKey ? (openai.maskedKey || '••••••••') : 'sk-…',
            disabled: providerBusy,
            style: { flex: 1, minWidth: 0 },
            onChange: (e) => setOpenai((prev) => ({ ...prev, apiKey: e.target.value })),
          })),
        React.createElement('label', { key: 'model', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('模型'),
          React.createElement('input', {
            type: 'text', value: openai.model || 'gpt-4o-mini-tts', disabled: providerBusy,
            style: { flex: 1, minWidth: 0 },
            onChange: (e) => setOpenai((prev) => ({ ...prev, model: e.target.value })),
          })),
        React.createElement('label', { key: 'voice', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          weT('音色'),
          React.createElement('select', {
            value: openai.voice || 'alloy', disabled: providerBusy, style: { flex: 1, minWidth: 0 },
            onChange: (e) => setOpenai((prev) => ({ ...prev, voice: e.target.value })),
          }, ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map((name) =>
            React.createElement('option', { key: name, value: name }, name)))),
        React.createElement('div', { key: 'actions', style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          React.createElement('button', {
            type: 'button', className: 'we-picker__btn', disabled: providerBusy, onClick: saveTestOpenAI,
          }, providerBusy ? weT('正在测试…') : weT('保存并测试')),
          React.createElement('span', { className: 'we-picker__hint', style: { margin: 0, fontSize: '11px' } },
            weT('测试会真调一次 OpenAI TTS；失败自动回落 Edge 并给出原因。'))),
        providerNote && providerNote.text
          ? React.createElement('div', {
            key: 'note', className: 'we-picker__hint', style: { margin: 0, color: providerNote.ok ? undefined : '#f87171' },
          }, providerNote.text)
          : null);
        voicePage.push(assistantVoiceCard({
          cardKey: provider.id,
          name: provider.name,
          status,
          tone: connected ? 'ok' : (configured ? 'warn' : 'muted'),
          note: oa.lastError ? weT('上次失败：{e}', { e: oa.lastError }) : weT('Key 只存本机；只在你点「保存并测试」时发起一次真实调用。'),
          pros: provider.pros,
          steps: provider.steps,
          extra: form,
        }));
        continue;
      }
      voicePage.push(assistantVoiceCard({
        cardKey: provider.id,
        name: provider.name,
        status: weT('即将支持'),
        tone: 'muted',
        note: weT('当前版本尚未接通，不会读取或上传你的 Key。'),
        pros: provider.pros,
        steps: provider.steps,
      }));
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
 * 「智能大肥鱼」一级设置页。只做版面装配：标题 + 三分页表单。
 * 设置导航的注册在 `src/client.js`（id=folia-assistant，order 502）。
 */
function AssistantSection() {
  return React.createElement('div', { className: 'we-assistant-section', style: { padding: '4px 2px' } },
    React.createElement('div', { style: { fontSize: '14px', fontWeight: 600 } }, weT('智能大肥鱼')),
    React.createElement(PetChatSettings, null),
  );
}

export { AssistantSection, PetChatSettings };
