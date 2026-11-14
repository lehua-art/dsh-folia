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
  // pre.53：朗读回答 = voice.muted 取反；音色 = voice.name（与 /pet-chat/config 同结构）。
  // pre.54：默认**空串** = 宿主自动选本机第一个可用中文音色（这台是 Microsoft Huihui Desktop）；
  // 不再写死 Edge neural（云端音色，不能随包分发，本机也没有本地模型）。
  voice: { name: '', muted: false },
};

/**
 * 设置页：模型 Key / 名字 / 称呼 / 音色 / **朗读回答开关** / 保存。
 *
 * 朗读开关是 pre.53 补的：对应 `voice.muted`（旧版只有默认不静音，没有界面入口）。
 * 关闭后只出字幕、不合成语音（客户端 petTts 在 `speak()` 入口直接跳过，省算力）。
 */
/** apiJson 的返回是 { ok, status, data }，而 /pet-chat/* 的 data 里还套一层 { ok, data }。
 * 各调用点各写一遍「多解一层」就是 P1 那个"保存成功却显示保存失败"的来源 —— 统一到这里解。 */
const unwrapPetChat = (resp) => (resp && resp.data && resp.data.data) || (resp && resp.data) || {};

/** 本机音色里选默认：优先中文，其次第一个 usable。 */
function assistantDefaultVoice(list) {
  const items = (Array.isArray(list) ? list : []).filter((v) => v && v.usable === true);
  return items.find((v) => /^zh/i.test(String(v.lang || ''))) || items[0] || null;
}

function PetChatSettings() {
  const [draft, setDraft] = React.useState(CHAT_DEFAULTS);
  const [status, setStatus] = React.useState({ ok: null, text: '' });
  const [note, setNote] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  // 工作能力插件（聚合携带）的安装状态；只读展示，不加开关
  const [workPlugins, setWorkPlugins] = React.useState(null);
  // pre.54：本机真实可用音色（/tts/voices）与可下载目录（/tts/catalog）。
  const [voices, setVoices] = React.useState(null);
  const [catalog, setCatalog] = React.useState(null);
  const update = React.useCallback((patch) => setDraft((prev) => ({ ...prev, ...patch })), []);

  const load = React.useCallback(async () => {
    try {
      const resp = await apiJson('/pet-chat/config', { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc && doc.ok !== false) {
        // voice 是嵌套对象：缺字段时补默认，避免 draft.voice 变 undefined 后开关读不了。
        const voice = Object.assign({}, CHAT_DEFAULTS.voice, (doc && doc.voice && typeof doc.voice === 'object') ? doc.voice : {});
        setDraft({ ...CHAT_DEFAULTS, ...doc, voice, apiKey: '' });
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
  // pre.54：只列本机真实可用音色；默认选第一个可用中文音色。
  React.useEffect(() => {
    void (async () => {
      const resp = await apiJson('/pet-chat/tts/voices', { parse: 'always' }).catch(() => null);
      const doc = unwrapPetChat(resp);
      const items = (doc && Array.isArray(doc.voices) ? doc.voices : []).filter((v) => v && v.usable === true);
      setVoices(items);
      const firstZh = assistantDefaultVoice(items);
      if (firstZh) {
        setDraft((prev) => {
          const cur = prev.voice || {};
          if (cur.name) return prev;
          return { ...prev, voice: Object.assign({}, cur, { name: firstZh.id }) };
        });
      }
    })();
  }, []);
  React.useEffect(() => {
    void (async () => {
      const resp = await apiJson('/pet-chat/tts/catalog', { parse: 'always' }).catch(() => null);
      const doc = unwrapPetChat(resp);
      if (doc && Array.isArray(doc.items)) setCatalog(doc.items);
    })();
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      // 填了 Key 就启用：面板不放"开启对话"开关，语义由 Key 的有无决定。
      // pre.53：voice 必须显式带上（宿主保存时会整体替换 voice 对象）。
      const voice = Object.assign({}, CHAT_DEFAULTS.voice, draft.voice || {});
      // pre.54：空音色 ⇒ 落成当前本机默认（列表没加载出来时仍保持空串，由宿主自动选）。
      if (!voice.name) {
        const fallback = assistantDefaultVoice(voices);
        if (fallback) voice.name = fallback.id;
      }
      const body = {
        ...draft, voice,
        apiKey: draft.apiKey || '',
        enabled: Boolean(draft.apiKey) || Boolean(draft.hasApiKey),
      };
      // ⚠️ 必须用 apiPostJson：apiJson 只拼 URL，不做 JSON.stringify，
      //    传对象会被浏览器发成 "[object Object]" ⇒ 宿主回 400 bad-json ⇒ 界面永远"保存失败"。
      const resp = await apiPostJson('/pet-chat/config', body, { parse: 'always' });
      const doc = unwrapPetChat(resp);
      if (doc.saved) {
        // pre.53：保存后**立刻**生效 —— 静音时停掉正在念的那句，并刷新客户端缓存的 voice。
        if (voice.muted === true) {
          try { petSpeakStop(); } catch { /* 朗读是增强：停不下来也不能影响保存 */ }
        }
        try { void petChatRefreshVoice(); } catch { /* 刷新失败下次唤醒会再读 */ }
        setNote({ ok: true, text: voice.muted === true ? weT('已保存（朗读已关闭）') : weT('已保存') });
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
  const voice = Object.assign({}, CHAT_DEFAULTS.voice, draft.voice || {});
  const voiceOn = voice.muted !== true;
  child.push(React.createElement('div', { key: 'title', style: { fontWeight: 600, margin: '14px 0 4px', fontSize: '13px' } }, weT('桌宠语音助手')));
  child.push(React.createElement('div', { key: 'hint', className: 'we-picker__hint', style: { margin: '0 0 6px' } },
    weT('填 Key、起名字、选音色，再决定要不要朗读。主动搭话与记忆是固定策略；停止/恢复对它说一声就行。')));

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

  // pre.53：朗读开关 = voice.muted 取反。关闭后只出字幕、不合成语音（客户端入口直接跳过）。
  child.push(React.createElement('label', {
    key: 'speak-toggle',
    style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', margin: '6px 0 2px' },
  },
  React.createElement('input', {
    type: 'checkbox',
    checked: voiceOn,
    disabled: busy,
    onChange: (e) => update({ voice: Object.assign({}, voice, { muted: !e.target.checked }) }),
  }),
  weT('🔊 朗读回答'),
  ));
  child.push(React.createElement('div', {
    key: 'speak-hint', className: 'we-picker__hint', style: { margin: '0 0 4px' },
  }, weT('关闭后只显示字幕、不合成语音（省算力）；保存后立刻生效。')));

  // pre.54（B3③）：音色下拉只列**本机真实可用**（/tts/voices 的 usable=true）。
  // 不再有 4 个硬编码 Edge neural；默认选第一个可用中文音色（这台是 Microsoft Huihui Desktop）。
  const usableVoices = (Array.isArray(voices) ? voices : []).filter((v) => v && v.usable === true);
  const defaultVoice = assistantDefaultVoice(usableVoices);
  const currentVoiceName = voice.name || (defaultVoice ? defaultVoice.id : '');
  const voiceKnown = usableVoices.some((v) => String(v.id) === currentVoiceName);
  if (usableVoices.length || currentVoiceName) {
    child.push(row('voice', '音色', React.createElement('select', {
      className: 'we-picker__playlist-select',
      disabled: busy || !usableVoices.length,
      value: currentVoiceName,
      onChange: (e) => update({ voice: Object.assign({}, voice, { name: e.target.value }) }),
    },
    // 旧配置里的音色不在本机（或读取失败）也保留一行，避免下拉显示为空；
    // 真正合成时宿主会回落并在状态条提示。
    !voiceKnown && currentVoiceName
      ? React.createElement('option', { key: 'stale', value: currentVoiceName }, currentVoiceName + ' ' + weT('（本机未检测到，将回落）'))
      : null,
    ...usableVoices.map((v) => React.createElement('option', { key: v.id, value: v.id },
      v.label + (v.lang ? ' · ' + v.lang : '') + ' ' + weT('（系统音色，离线）'))),
    )));
  } else {
    child.push(React.createElement('div', {
      key: 'voice-empty', className: 'we-picker__hint', style: { margin: '4px 0' },
    }, voices === null ? weT('正在读取本机音色…') : weT('未检测到可用音色（系统 TTS 不可用）')));
  }
  child.push(React.createElement('div', {
    key: 'voice-hint', className: 'we-picker__hint', style: { margin: '0 0 4px' },
  }, weT('只列本机真实可用的系统音色（离线）；云端音色不随包分发。')));

  // pre.54（任务 C 骨架）：可下载离线音色目录 —— 本版**只列目录，不谎称已支持**。
  if (Array.isArray(catalog) && catalog.length) {
    child.push(React.createElement('div', {
      key: 'catalog-head', style: { marginTop: '12px', fontSize: '12px', fontWeight: 600 },
    }, weT('可下载音色（即将支持）')));
    catalog.forEach((item) => {
      child.push(React.createElement('div', {
        key: 'cat-' + item.id, className: 'we-picker__hint', style: { margin: '2px 0' },
      }, (item.name || item.id) + ' · ' + (item.license || '') + ' · ' + (item.size || '')
        + ' · ' + weT('即将支持')));
    });
    child.push(React.createElement('div', {
      key: 'catalog-hint', className: 'we-picker__hint', style: { margin: '2px 0 0' },
    }, weT('这些是开源离线方案，本版只接目录；合成接通后才会出现在上面的音色下拉里。')));
  }

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
