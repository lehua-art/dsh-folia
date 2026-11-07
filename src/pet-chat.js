/**
 * pet-chat.js（客户端）— **桌宠对话气泡**（门 2 / 任务 A3）。
 *
 * 契约：宿主 `/folia/pet-chat/*`（见 lib/routes/pet-chat.js）。
 *   · 点桌面上的宠物 → 气泡（输入框 + 最近 6 条）；Enter 发送 / Esc 关闭 / Ctrl+Alt+P 唤起
 *   · 回复走 SSE（delta 逐字追加），done 里带 emotion → 映射成宠物动作
 *   · 设置里没开（enabled=false）⇒ 不谈模型，直接给**预设台词库**（30+ 句，按情绪分组）
 *
 * 为什么自己读 SSE 而不用 EventSource：聊天是 POST（要带请求体），EventSource 只支持 GET。
 * 所以用 fetch + response.body 的 reader，按 `\n\n` 切帧自己解 —— 二十来行，换来不被协议绑死。
 *
 * 不变量：
 *   · **不碰模型的 key**：key 只在宿主设置里，客户端连读都不读。
 *   · **不自己拼模型端点**：所有请求都打本机 `/folia/pet-chat/*`。
 *   · 气泡是 `position: fixed` 的独立层，不参与面板重渲染（与 pet-layer 同一套思路）。
 */
const PET_CHAT_PRESET_LINES = [
  // happy
  '嘿嘿，今天也要一起看壁纸吗？',
  '刚换的那张 4K 好好看，我盯着看了好久！',
  '你来啦！我正想找你说话呢～',
  '被你发现了，我在偷偷看桌面上的风景。',
  '好耶，又是陪你摸鱼的一天！',
  '要不要换一张更亮的壁纸？我觉得那张不错。',
  '今天心情不错吧？我都感觉出来了。',
  '嘿嘿，被你点到了，有点开心。',
  // calm
  '在的，慢慢来。',
  '嗯，我先在这儿待着。',
  '不着急，想好了再说。',
  '桌面挺安静的，挺好的。',
  '有什么想换的壁纸吗？',
  '我就在角落，喊我一声就行。',
  '要不要试试轮播？每半小时换一张。',
  '今天的桌面配色我很喜欢。',
  // tired
  '困了就歇会儿吧，壁纸又不会跑。',
  '记得喝水，眼睛也该休息了。',
  '夜深了，要不明天再弄？',
  '我把动作放慢一点，陪你安静会儿。',
  '要不要换成暗一点的壁纸？眼睛舒服些。',
  '忙了一整天了吧，辛苦了。',
  '我先趴一会儿，有事叫我。',
  '别熬太晚呀。',
  // angry（轻微闹别扭，不说教）
  '哼，你先忙吧，我不打扰。',
  '刚刚点我那么多次，是想让我转圈吗？',
  '这张壁纸你都看了一周了，换换嘛。',
  '好吧好吧，随你。',
  '再不理我，我就去角落待着了。',
  '我可是有脾气的宠物哦。',
  // 无模型提示
  '（还没接上模型，先陪你聊聊天）',
  '（在设置里打开「桌宠对话」，我就能正经回你了）',
];

/** 情绪 → 宠物动作轨道（缺轨道时回落 idle，见 petApplyEmotion）。 */
const PET_CHAT_EMOTION_TRACK = { happy: 'wave', tired: 'sleep', angry: 'idle', calm: 'idle' };
/** 气泡里保留的最近条数（工单：最近 6 条）。 */
const PET_CHAT_KEEP_LINES = 6;

let petChatEls = null;
let petChatLines = [];
let petChatBusy = false;

/** 气泡 DOM（懒建：不点宠物就不建，免得影响启动）。 */
function petChatBuild() {
  if (petChatEls) return petChatEls;
  const root = document.createElement('div');
  root.id = 'we-pet-chat';
  root.style.cssText = [
    'position:fixed', 'right:24px', 'bottom:172px', 'width:320px', 'max-height:420px',
    'display:none', 'flex-direction:column', 'gap:8px', 'padding:12px', 'z-index:2147483000',
    'background:rgba(24,24,28,.92)', 'color:#f2f2f5', 'border:1px solid rgba(255,255,255,.12)',
    'border-radius:14px', 'box-shadow:0 12px 32px rgba(0,0,0,.45)', 'backdrop-filter:blur(10px)',
    'font-size:13px', 'line-height:1.5',
  ].join(';');

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';
  const title = document.createElement('strong');
  title.textContent = weT('桌宠对话');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = weT('关闭');
  close.style.cssText = 'background:none;border:0;color:#c9c9d1;font-size:18px;cursor:pointer;line-height:1';
  close.addEventListener('click', () => petChatHide());
  head.append(title, close);

  const log = document.createElement('div');
  log.style.cssText = 'flex:1 1 auto;overflow:auto;display:flex;flex-direction:column;gap:6px;min-height:80px';

  const status = document.createElement('div');
  status.style.cssText = 'font-size:11px;color:#9a9aa5;min-height:14px';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = weT('和我说点什么…');
  input.style.cssText = 'flex:1 1 auto;min-width:0;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;outline:none';
  const send = document.createElement('button');
  send.type = 'button';
  send.textContent = weT('发送');
  send.style.cssText = 'padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:rgba(124,92,255,.35);color:inherit;cursor:pointer';
  send.addEventListener('click', () => petChatSend());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); petChatSend(); }
  });
  row.append(input, send);

  root.append(head, log, status, row);
  document.body.appendChild(root);
  petChatEls = { root, log, status, input, send };
  return petChatEls;
}

/** 渲染最近 N 条（role=user 靠右、assistant 靠左）。 */
function petChatRender() {
  const els = petChatBuild();
  els.log.textContent = '';
  for (const line of petChatLines) {
    const bubble = document.createElement('div');
    bubble.textContent = line.text;
    bubble.style.cssText = 'max-width:86%;padding:6px 9px;border-radius:10px;white-space:pre-wrap;word-break:break-word;'
      + (line.role === 'user'
        ? 'align-self:flex-end;background:rgba(124,92,255,.42)'
        : 'align-self:flex-start;background:rgba(255,255,255,.08)');
    els.log.appendChild(bubble);
  }
  els.log.scrollTop = els.log.scrollHeight;
}

function petChatPush(role, text) {
  petChatLines.push({ role, text });
  if (petChatLines.length > PET_CHAT_KEEP_LINES) petChatLines = petChatLines.slice(-PET_CHAT_KEEP_LINES);
  petChatRender();
}

function petChatStatus(text) {
  const els = petChatBuild();
  els.status.textContent = text || '';
}

function petChatShow() {
  const els = petChatBuild();
  els.root.style.display = 'flex';
  els.input.focus();
  petChatSyncState();
}

function petChatHide() {
  if (!petChatEls) return;
  petChatEls.root.style.display = 'none';
}

function petChatToggle() {
  const els = petChatBuild();
  if (els.root.style.display === 'none' || !els.root.style.display) petChatShow();
  else petChatHide();
}

/** 没有模型时的兜底：随机一句预设台词。 */
function petChatPresetLine() {
  return PET_CHAT_PRESET_LINES[Math.floor(Math.random() * PET_CHAT_PRESET_LINES.length)];
}

/** 问宿主"配好没"（失败就当作没配，不弹错误框）。 */
async function petChatSyncState() {
  try {
    const probe = await apiJson('/pet-chat/state', { parse: 'always' });
    const doc = probe && probe.data;
    if (!doc || doc.enabled !== true) {
      petChatStatus(weT('未开启对话（设置 → 桌宠 → 桌宠对话）'));
      return null;
    }
    if (doc.reachable === false) {
      petChatStatus(weT('连不上模型端点') + (doc.lastError ? '：' + doc.lastError : ''));
      return doc;
    }
    petChatStatus(weT('已连接') + ' · ' + String(doc.provider || '') + ' · ' + String(doc.model || ''));
    return doc;
  } catch {
    petChatStatus(weT('宿主没有响应'));
    return null;
  }
}

/** 情绪 → 动作：优先用宿主暴露的播放钩子，没有就保持 idle（不报错）。 */
function petChatApplyEmotion(emotion) {
  const track = PET_CHAT_EMOTION_TRACK[emotion] || 'idle';
  const host = typeof window !== 'undefined' ? window : null;
  if (!host) return;
  try {
    if (typeof host.__wePetPlay === 'function') host.__wePetPlay(track);
  } catch { /* 播放失败不影响聊天 */ }
}

/** 按 `\n\n` 切 SSE 帧；每帧里 `event: x` + `data: {...}`。 */
function petChatParseFrame(frame) {
  let event = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch { return null; }
}

/** 发送一句（SSE 流式）。 */
async function petChatSend() {
  if (petChatBusy) return;
  const els = petChatBuild();
  const text = String(els.input.value || '').trim();
  if (!text) return;
  if ([...text].length > 400) { petChatStatus(weT('一次最多 400 字')); return; }
  els.input.value = '';
  petChatPush('user', text);
  petChatBusy = true;
  petChatStatus(weT('思考中…'));

  const state = await petChatSyncState();
  if (!state || state.enabled !== true) {
    // 没有模型：不假装在对话，直接给预设台词
    petChatPush('assistant', petChatPresetLine());
    petChatStatus(weT('未开启对话（设置 → 桌宠 → 桌宠对话）'));
    petChatBusy = false;
    return;
  }

  let assistant = '';
  const ensureBubble = () => {
    if (!assistant) { petChatPush('assistant', ''); }
  };
  try {
    const call = await apiFetch('/pet-chat/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      parse: false,
    });
    const response = call && call.response;
    if (!call || !call.ok || !response || !response.body) {
      petChatStatus(weT('宿主拒绝了这次请求') + '（HTTP ' + response.status + '）');
      petChatBusy = false;
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- 流式读取必须逐块等
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const parsed = petChatParseFrame(frame);
        if (!parsed) continue;
        if (parsed.event === 'delta' && parsed.data && typeof parsed.data.t === 'string') {
          assistant += parsed.data.t;
          ensureBubble();
          petChatLines[petChatLines.length - 1] = { role: 'assistant', text: assistant };
          petChatRender();
        } else if (parsed.event === 'done') {
          petChatApplyEmotion(parsed.data && parsed.data.emotion);
          petChatStatus('');
        } else if (parsed.event === 'error') {
          const code = parsed.data && parsed.data.code ? parsed.data.code : 'error';
          const hint = parsed.data && parsed.data.hint ? parsed.data.hint : '';
          petChatStatus(hint || code);
          if (code === 'no-model') petChatPush('assistant', petChatPresetLine());
        }
      }
    }
  } catch {
    petChatStatus(weT('发送失败，重试一次？'));
  } finally {
    petChatBusy = false;
    if (!assistant) petChatStatus('');
  }
}

/**
 * 常驻挂载（`WE_FEATURE_MOUNTS` 的一项）：绑定点宠物 / 快捷键。
 * 返回 cleanup —— 卸载时要摘掉监听、删掉 DOM。
 */
function mountPetChat() {
  // 宿主 / 测试替身里可能没有 DOM 能力：没有就安静地不挂，而不是让装配层炸掉
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function'
    || typeof document.createElement !== 'function') {
    return () => {};
  }
  const onDocumentClick = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('#we-pet-layer')) petChatShow();
  };
  const onKeyDown = (event) => {
    if (event.altKey && event.ctrlKey && String(event.key).toLowerCase() === 'p') {
      event.preventDefault();
      petChatToggle();
      return;
    }
    if (event.key === 'Escape' && petChatEls && petChatEls.root.style.display === 'flex') petChatHide();
  };
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    if (petChatEls && petChatEls.root.parentNode) petChatEls.root.parentNode.removeChild(petChatEls.root);
    petChatEls = null;
    petChatLines = [];
  };
}
