/**
 * verify-pet-chat-brain.mjs — v2「大脑」验收（A–H 的前七项 + 纯函数判据）。
 *
 * 为什么单独一个文件：`verify-pet-chat.mjs` 覆盖的是**旧版对话/记忆/语音**九条判据；
 * 这一份只测 v2 新增的意图 / 事件记忆 / 环境 / 情绪 / 主动 / 校验 / 危险确认。
 * 两份都用真 http.Server + 假模型端点，不依赖本机 Ollama 或外网。
 *
 * A 意图：讲笑话不调工具；换壁纸调 wallpaper_switch 并回读
 * B 记忆：memory.json 出现 likes + events，下一轮 system 注入
 * C 环境：时间查询用宿主时钟，不编造
 * D 情绪：深夜「好累」⇒ mood=tired / rate=-1，system 带情绪提示
 * E 主动：事件触发 ≤30 字、每日上限、朗读中不插嘴（纯函数 + 路由）
 * F 校验：客户端回 no-match ⇒ 承认失败，不谎报成功
 * G 危险：卸载先确认；回答「取消」不执行
 */
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT
  || (process.platform === 'win32' ? 'C:/Windows/Temp/folia-asr-none' : '/tmp/folia-asr-none');
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-pet-brain-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const {
  classifyIntent, detectMood, buildEnvContext, toolRegistry,
  timeAnswer, parseReminderArgs, shouldUseModelIntent, normalizeModelIntent,
} = await import('../lib/pet-chat-brain.js');
const {
  sanitizeMemory, memoryEventsLine, MEMORY_EVENT_TTL_MS,
} = await import('../lib/pet-chat-memory.js');
const {
  clearProactiveState, canEventSpeak, buildEventLine, markSaid, PROACTIVE_RULES, EVENT_RULES,
} = await import('../lib/pet-chat-proactive.js');
const { readPetConfig, writePetConfig, runTool } = await import('../lib/pet-chat-tools.js');
const { getActivePersona, updatePersona } = await import('../lib/persona-store.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const wait = (ms) => new Promise((resolveP) => { setTimeout(resolveP, ms); });
const MEMORY_FILE = join(TEST_HOME, 'pet-chat', 'memory.json');

/* ── 台架：假宿主 + 假模型端点 ─────────────────────────────────────────── */

function startHost(settings, clock) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [],
    base: '/folia',
    log: () => {},
    readSettings: () => settings,
    speechToText: undefined,
    clock,
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  assert.ok(route, '路由已注册');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({
        base: `http://127.0.0.1:${port}/folia/pet-chat`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function startModel() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      seen.push({ url: req.url, body: parsed });
      if (parsed && parsed.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { content: '{"intent":"chat","tool":null,"args":{}}' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of ['我在', '呢。']) {
        res.write(JSON.stringify({ message: { content: piece }, done: false }) + '\n');
      }
      res.end();
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({ base: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** 发一句聊天；遇到 action 事件就调 onAction（返回回执），并继续读流。 */
async function chat(host, text, onAction) {
  const response = await fetch(`${host.base}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- 流式读取必须逐块等
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const cut = buffer.indexOf('\n\n');
      if (cut < 0) break;
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (!data) continue;
      const payload = JSON.parse(data);
      events.push({ event, data: payload });
      if (event === 'action' && typeof onAction === 'function') {
        // eslint-disable-next-line no-await-in-loop -- 回执要在宿主超时前送到
        const ack = await onAction(payload);
        // eslint-disable-next-line no-await-in-loop -- 同上
        await fetch(`${host.base}/tool-result`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: payload.id, ...ack }),
        });
      }
    }
  }
  return events;
}

const deltaText = (events) => events.filter((e) => e.event === 'delta').map((e) => e.data.t).join('');
const doneEvent = (events) => events.find((e) => e.event === 'done') || { data: {} };

/* ── 纯函数底座 ─────────────────────────────────────────────────────────── */
{
  const env = buildEnvContext({
    now: new Date(2026, 10, 16, 21, 34).getTime(),
    wallpaper: { title: '星空' },
    pet: { visible: true, scalePercent: 100 },
    volume: 60,
    playing: { title: '夜曲', artist: '周杰伦' },
  });
  check('① 环境串 ≤120 字且含时间/壁纸/桌宠/音量/正在播放',
    [...env].length <= 120 && env.includes('21:34') && env.includes('星空')
      && env.includes('桌宠：显示') && env.includes('音量 60%') && env.includes('夜曲 - 周杰伦'),
    `${env.length} 字：${env}`);

  const memory = sanitizeMemory({
    likes: ['深色壁纸'],
    events: [
      ...Array.from({ length: 10 }, (_, i) => ({ ts: Date.now() - i * 1000, kind: 'event', text: '事件' + i })),
      { ts: Date.now() - MEMORY_EVENT_TTL_MS - 1000, kind: 'event', text: '三十天以前的事件' },
    ],
  });
  const line = memoryEventsLine(memory);
  const eventItems = line.replace(/^最近发生：/, '').split('；').filter(Boolean);
  check('② 事件记忆：30 天过期 + 注入最近 8 条（每条 ≤30 字）',
    memory.events.length === 10 && !line.includes('三十天以前') && eventItems.length === 8
      && eventItems.every((item) => [...item].length <= 30),
    `events=${memory.events.length} · 注入=${eventItems.length} · line=${line}`);

  const tools = toolRegistry();
  check('③ 工具清单含本版最小集', ['wallpaper_switch', 'pet_toggle', 'pet_scale', 'pet_volume', 'tts_toggle',
    'reminder_create', 'reminder_list', 'memory_note', 'skin_uninstall'].every((name) => tools.some((t) => t.name === name)),
  tools.map((t) => t.name).join(','));
}

/* ── A 意图 ─────────────────────────────────────────────────────────────── */
{
  const joke = classifyIntent('讲个笑话');
  const wallpaper = classifyIntent('把壁纸换成暗色的');
  check('A1 意图规则：「讲个笑话」= chat，不调工具',
    joke.intent === 'chat' && !joke.tool, JSON.stringify(joke));
  check('A2 意图规则：「把壁纸换成暗色的」= action:wallpaper_switch/dark',
    wallpaper.intent === 'action' && wallpaper.tool === 'wallpaper_switch' && wallpaper.args.mode === 'dark',
    JSON.stringify(wallpaper));

  const fallbackWanted = shouldUseModelIntent('帮我弄一下那个', { confidence: 'default' });
  const fallbackNotForChat = shouldUseModelIntent('讲个笑话', joke);
  const modelIntent = normalizeModelIntent({ intent: 'action', tool: 'wallpaper_switch', args: { mode: 'next' } });
  check('A3 模型兜底只对“未命中规则 + 含动作动词”生效，且只接合法工具',
    fallbackWanted === true && fallbackNotForChat === false
      && modelIntent && modelIntent.intent === 'action' && modelIntent.tool === 'wallpaper_switch',
    `wanted=${fallbackWanted} · chat=${fallbackNotForChat} · model=${JSON.stringify(modelIntent)}`);

  const model = await startModel();
  const host = await startHost({
    petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, model: 'fake' },
    id: 'wp-old',
  });
  const jokeEvents = await chat(host, '讲个笑话');
  check('A4 「讲个笑话」走模型流式回答，没有 action/tool 事件',
    deltaText(jokeEvents).includes('我在呢') && !jokeEvents.some((e) => e.event === 'action')
      && model.seen.length === 1,
    `deltas=${deltaText(jokeEvents)} · 模型调用=${model.seen.length}`);

  const settingsWal = {
    petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, model: 'fake' },
    id: 'wp-old',
  };
  const host2 = await startHost(settingsWal, () => new Date(2026, 10, 16, 21, 34).getTime());
  const callsBefore = model.seen.length;
  const walEvents = await chat(host2, '把壁纸换成暗色的', async (payload) => {
    assert.equal(payload.tool, 'wallpaper_switch');
    settingsWal.id = 'wp-dark';
    return { ok: true, targetId: 'wp-dark', title: '暗夜' };
  });
  const walDone = doneEvent(walEvents);
  check('A5 「把壁纸换成暗色的」→ action 下发 + 回读 settings.id ⇒ verified',
    walDone.data.tool === 'wallpaper_switch' && walDone.data.verified === true
      && deltaText(walEvents).includes('换成「暗夜」了') && model.seen.length === callsBefore,
    `done=${JSON.stringify(walDone.data)} · deltas=${deltaText(walEvents)}`);
  await host.close();
  await host2.close();
  await model.close();
}

/* ── B 长期记忆（persona 事件流；旧 memory.json 不再参与）────────────────── */
{
  const { getActivePersona } = await import('../lib/persona-store.js');
  const { listEvents } = await import('../lib/persona-memory.js');
  const model = await startModel();
  const settings = { petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, model: 'fake' } };
  const host = await startHost(settings);
  const events = await chat(host, '记住我喜欢深色壁纸');
  const done = doneEvent(events);
  const persona = getActivePersona();
  const stored = listEvents(persona.id);
  check('B1 「记住我喜欢深色壁纸」→ 写当前 persona 的事件流',
    done.data.intent === 'memory' && done.data.verified === true
      && stored.items.some((item) => item.text.includes('深色壁纸')),
    `events=${JSON.stringify(stored.items.map((item) => item.text))}`);

  await wait(1100);
  const chatEvents = await chat(host, '我喜欢什么');
  const lastSystem = String(model.seen[model.seen.length - 1].body.messages[0].content || '');
  check('B2 下一轮 system 注入该 persona 的召回记忆',
    lastSystem.includes('深色壁纸') && chatEvents.some((e) => e.event === 'delta'),
    `system 含记忆=${lastSystem.includes('深色壁纸')}`);
  await host.close();
  await model.close();
  try { rmSync(MEMORY_FILE, { force: true }); } catch { /* ignore */ }
}

/* ── C 环境：时间查询不编造 ─────────────────────────────────────────────── */
{
  const model = await startModel();
  const night = new Date(2026, 10, 16, 21, 34).getTime();
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, model: 'fake' } }, () => night);
  const events = await chat(host, '现在几点了');
  const done = doneEvent(events);
  check('C 「现在几点了」→ 用注入时钟回答（21:34），不调模型',
    deltaText(events).includes('21:34') && done.data.intent === 'query' && model.seen.length === 0,
    `回答=${deltaText(events)} · 模型调用=${model.seen.length} · 期望=${timeAnswer(night)}`);
  await host.close();
  await model.close();
}

/* ── D 情绪 / 语速 ──────────────────────────────────────────────────────── */
{
  const model = await startModel();
  const late = new Date(2026, 10, 16, 23, 30).getTime();
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, model: 'fake' } }, () => late);
  const events = await chat(host, '好累');
  const done = doneEvent(events);
  const system = String(model.seen[0].body.messages[0].content || '');
  const mood = detectMood('好累', late);
  check('D 深夜「好累」→ mood=tired、语速 -1、system 带情绪/深夜/环境',
    mood.mood === 'tired' && mood.rate === -1 && done.data.mood === 'tired' && done.data.rate === -1
      && system.includes('用户现在累') && system.includes('深夜') && system.includes('当前环境：现在是'),
    `mood=${mood.mood} rate=${mood.rate} · done=${JSON.stringify(done.data)} · 环境注入=${system.includes('当前环境：现在是')}`);
  await host.close();
  await model.close();
}

/* ── E 主动发起 ─────────────────────────────────────────────────────────── */
{
  const now = new Date(2026, 10, 16, 15, 0).getTime();
  clearProactiveState();
  const wall = buildEventLine({ event: 'wallpaper', wallpaperTitle: '星空', now });
  check('E1 换壁纸点评 ≤30 字且带壁纸名',
    [...wall.line].length <= PROACTIVE_RULES.maxChars && wall.line.includes('星空'),
    `${wall.line}（${[...wall.line].length} 字）`);

  const allow = canEventSpeak({ event: 'wallpaper', now, sinceMs: 30000 });
  const speaking = canEventSpeak({ event: 'wallpaper', now, sinceMs: 30000, speaking: true });
  const tooSoon = canEventSpeak({ event: 'wallpaper', now, sinceMs: 5000 });
  check('E2 事件触发：30 秒后可以；正在朗读/太早不插嘴',
    allow.ok === true && speaking.reason === 'speaking' && tooSoon.reason === 'too-soon',
    `ok=${allow.reason} · speaking=${speaking.reason} · tooSoon=${tooSoon.reason}`);

  clearProactiveState();
  markSaid(now, 'a');
  markSaid(now, 'b');
  markSaid(now, 'c');
  const capped = canEventSpeak({ event: 'wallpaper', now: now + 60000, sinceMs: 30000 });
  check('E3 每日上限 3 条（事件与空闲搭话共用额度）',
    PROACTIVE_RULES.dailyCap === 3 && capped.reason === 'daily-cap',
    `cap=${PROACTIVE_RULES.dailyCap} · reason=${capped.reason}`);

  clearProactiveState();
  const morning = new Date(2026, 10, 16, 9, 0).getTime();
  const night = new Date(2026, 10, 16, 23, 0).getTime();
  const workLine = buildEventLine({ event: 'work', activeMinutes: 45, now });
  const workOk = canEventSpeak({ event: 'work', now, activeMinutes: 45 });
  const morningOk = canEventSpeak({ event: 'greeting', now: morning });
  const nightOk = canEventSpeak({ event: 'night', now: night });
  check('E3b 三类事件：连续工作 45 分钟 / 早上问候 / 22 点后休息',
    EVENT_RULES.workMinutes === 45 && workLine.line.includes('45')
      && workOk.ok === true && morningOk.ok === true && nightOk.ok === true,
    `${workLine.line} · work=${workOk.reason} morning=${morningOk.reason} night=${nightOk.reason}`);

  const model = await startModel();
  const host = await startHost({ petChat: { enabled: true } }, () => now);
  clearProactiveState();
  const tick = await fetch(`${host.base}/proactive/tick`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'wallpaper', wallpaperTitle: '星空', sinceMs: 30000 }),
  });
  const tickDoc = await tick.json();
  check('E4 主动路由：事件 tick 返回 ≤30 字的点评并记账',
    tickDoc.ok === true && tickDoc.line && [...tickDoc.line].length <= 30 && tickDoc.usage.said === 1,
    `line=${tickDoc.line} · usage=${JSON.stringify(tickDoc.usage)}`);

  const clientSrc = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  check('E5 前端：换壁纸 30 秒后触发 + 朗读/录音时主动让路',
    EVENT_RULES.wallpaperDelayMs === 30000
      && /petChatWatchWallpaper/.test(clientSrc)
      && /petTts\.isSpeaking\(\)/.test(clientSrc)
      && /petChatTurnBusy/.test(clientSrc),
    `delay=${EVENT_RULES.wallpaperDelayMs}ms`);
  check('E6 前端动作链：SSE action → applySelection → /tool-result；环境与语速都随聊天上报',
    /eventName === 'action'/.test(clientSrc)
      && /petChatHandleAction/.test(clientSrc)
      && /applySelection\(String\(target\.id\)/.test(clientSrc)
      && /\/pet-chat\/tool-result/.test(clientSrc)
      && /body: JSON\.stringify\(\{[\s\S]{0,160}inputMode: petChatInputMode/.test(clientSrc)
      && /rate: petChatSpeechRate \+/.test(clientSrc),
    'action/context/rate 四处锚点');
  await host.close();
  await model.close();
  clearProactiveState();
}

/* ── F 自我校验：失败不谎报 ─────────────────────────────────────────────── */
{
  const model = await startModel();
  const settings = { petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, model: 'fake' }, id: 'wp-old' };
  const host = await startHost(settings, () => new Date(2026, 10, 16, 21, 34).getTime());
  const events = await chat(host, '把壁纸换成不存在的名字', async () => ({ ok: false, error: 'no-match' }));
  const done = doneEvent(events);
  const text = deltaText(events);
  check('F 不存在的壁纸 ⇒ 承认失败（verified=false，不出现“成功/换成了”）',
    done.data.tool === 'wallpaper_switch' && done.data.verified === false
      && text.includes('没找到') && !/成功|换成了|换好了/.test(text),
    `verified=${done.data.verified} · deltas=${text}`);

  // 客户端真回执成功、但宿主回读 settings.id 没变 ⇒ 同样不能报成功。
  settings.id = 'wp-old';
  await wait(1100);
  const events2 = await chat(host, '把壁纸换成暗色的', async () => ({ ok: true, targetId: 'wp-other', title: '暗夜' }));
  const done2 = doneEvent(events2);
  check('F2 回执成功但回读不一致 ⇒ verified=false（回读是唯一裁判）',
    done2.data.verified === false && deltaText(events2).includes('没生效'),
    `verified=${done2.data.verified} · deltas=${deltaText(events2)}`);
  await host.close();
  await model.close();
}

/* ── G 危险动作确认 ─────────────────────────────────────────────────────── */
{
  const model = await startModel();
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', baseUrl: model.base, model: 'fake' } });
  // v2：系统操作默认被「高级权限」挡在外面（任务 J）。
  const off = await chat(host, '卸载当前皮肤');
  const offDone = doneEvent(off);
  check('G1 高级权限关闭 ⇒ 系统工具不可用，明确拒绝（不弹确认、不执行）',
    offDone.data.toolRefused === true && offDone.data.permission === 'deny'
      && !off.some((e) => e.event === 'action')
      && deltaText(off).includes('不能做'),
    `done=${JSON.stringify(offDone.data)} · deltas=${deltaText(off)}`);

  const active = getActivePersona();
  updatePersona(active.id, {
    permissions: { ...(active.permissions || {}), advanced: true, system: 'ask' },
  });
  await wait(1100);
  const first = await chat(host, '卸载当前皮肤');
  const ask = doneEvent(first);
  check('G2 打开高级权限 ⇒ 先问确认，不执行（高危强制二次确认）',
    ask.data.confirm === true && ask.data.tool === 'skin_uninstall'
      && deltaText(first).includes('确认') && !first.some((e) => e.event === 'action'),
    `done=${JSON.stringify(ask.data)} · deltas=${deltaText(first)}`);

  await wait(1100);
  const cancel = await chat(host, '取消');
  const cancelled = doneEvent(cancel);
  check('G3 回答「取消」→ 不执行（cancelled=true）',
    cancelled.data.cancelled === true && deltaText(cancel).includes('不办了'),
    `done=${JSON.stringify(cancelled.data)} · deltas=${deltaText(cancel)}`);

  const refused = await runTool('skin_uninstall', {}, { confirmed: false });
  check('G4 工具层双保险：未确认直接返回 needsConfirm',
    refused.needsConfirm === true && refused.ok === false,
    `needsConfirm=${refused.needsConfirm}`);

  // 回到默认（advanced=false）：工具层必须直接拒绝，而不是弹确认。
  const locked = getActivePersona();
  updatePersona(locked.id, { permissions: { ...(locked.permissions || {}), advanced: false } });
  const lockedResult = await runTool('skin_uninstall', {}, { persona: getActivePersona(), confirmed: true });
  check('G5 高级权限关闭 ⇒ 工具层代码级拒绝（即使 confirmed=true）',
    lockedResult.ok === false && lockedResult.permission === 'deny',
    `ok=${lockedResult.ok} permission=${lockedResult.permission}`);
  await host.close();
  await model.close();
}

/* ── 补充：解析与工具持久化 ─────────────────────────────────────────────── */
{
  const parsed = parseReminderArgs('提醒我 8 点半开会', new Date(2026, 10, 16, 9, 0).getTime());
  const pet = readPetConfig();
  writePetConfig({ enabled: true, volume: 0.5, scale: 1.2 });
  const petRead = readPetConfig();
  check('H1 提醒时间解析 + 桌宠配置回读',
    parsed.text === '开会' && /T08:30:00$/.test(parsed.at)
      && petRead.enabled === true && Math.round(petRead.volume * 100) === 50 && Math.round(petRead.scale * 100) === 120,
    `at=${parsed.at} text=${parsed.text} · pet=${JSON.stringify(petRead)}`);

  const toolPet = await runTool('pet_toggle', { visible: true }, {});
  check('H2 pet_toggle 回读配置后 verified=true',
    toolPet.ok === true && toolPet.verified === true,
    `say=${toolPet.say} verified=${toolPet.verified}`);
  // 还原默认，避免测试写入影响后续（临时 home 会被删，但保持整齐）
  writePetConfig({ enabled: false, volume: pet.volume, scale: pet.scale });
}

/* ── 收账 ──────────────────────────────────────────────────────────────── */
const failed = results.filter((item) => !item.ok);
console.log(`\nPET BRAIN CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
