/**
 * verify-intent-first.mjs — v1.3 判据 S1–S7：
 *   讲故事 / 继续讲 / 共情 / 静音 / 危机 全部按**当轮文本意图**自动判定；
 *   没有“模式”可切，故事按钮只在本轮 story 出现；说完自动回到 chat。
 * 真 http + 自建假模型端点（不依赖外网/Ollama）。
 */
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT || 'C:/Windows/Temp/folia-asr-none';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'folia-intent-'));
process.env.DSH_FOLIA_HOME = HOME;
const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const store = await import('../lib/persona-store.js');
const { resolveTurnPolicy } = await import('../lib/pet-chat-brain.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const persona = store.createPersona({ type: 'assistant', name: '意图' });
store.setActivePersona(persona.id);
const settings = {
  petChat: { enabled: true, provider: 'ollama', baseUrl: '', model: 'fake', voiceLength: 8, treehole: { hotline: '12356' } },
};

function startHost() {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, { disposers: [], base: '/folia', log: () => {}, readSettings: () => settings, speechToText: null });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  assert.ok(route, '路由已注册');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => resolveP({ base: `http://127.0.0.1:${server.address().port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) }));
  });
}

const storyPiece = () => {
  const out = [];
  for (let i = 0; i < 14; i += 1) {
    out.push(`第${i + 1}章，他把旧地图摊在桌上，沿着那条被雨水泡皱的线往前走。风从门缝里挤进来，灯焰晃了一下，他压低声音把剩下的事说完，才听见远处有人敲门。`);
  }
  return out;
};
function startModel() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      seen.push({ url: req.url, body: parsed });
      const msgs = (parsed && parsed.messages) || [];
      const lastUser = String((msgs.filter((m) => m.role === 'user').pop() || {}).content || '');
      let pieces;
      if (/故事|继续讲|接着|后来|然后呢/.test(lastUser)) pieces = storyPiece();
      else if (/累|烦|难受|压力/.test(lastUser)) pieces = ['听起来今天真的挺累的。', '是工作上的事，还是别的什么让你最难受？'];
      else if (/天气/.test(lastUser)) pieces = ['明天晴，18–25 度，风不大。'];
      else pieces = ['嗯，我在。'];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of pieces) res.write(JSON.stringify({ message: { content: piece }, done: false }) + '\n');
      res.end();
    });
  });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => resolveP({ base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) }));
  });
}

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
    }
  }
  return events;
}
const textOf = (events) => events.filter((item) => item.event === 'delta').map((item) => item.data.t).join('');
const metaOf = (events) => events.filter((item) => item.event === 'meta').at(-1)?.data || {};
const doneOf = (events) => events.filter((item) => item.event === 'done').at(-1)?.data || {};

/** 发一句话；每次之间等 1.1s（宿主限频 1 次/秒）。 */
async function say(base, text, inputMode = 'text') {
  const res = await fetch(`${base}/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, inputMode }),
  });
  const events = await readSse(res);
  return { events, text: textOf(events), meta: metaOf(events), done: doneOf(events) };
}
const wait = () => new Promise((r) => setTimeout(r, 1100));

/* ① 纯判定函数（S1/S3/S5/S6/S7 的规则面） */
check('S1① “讲个故事” ⇒ story；“继续讲” ⇒ story 续写',
  resolveTurnPolicy('讲个故事').policy === 'story'
  && resolveTurnPolicy('继续讲', { lastWasStory: true }).policy === 'story'
  && resolveTurnPolicy('继续讲', { lastWasStory: true }).storyContinue === true);
check('S1② “讲个笑话/讲一下这个代码” ⇒ chat（不是 story）',
  resolveTurnPolicy('讲个笑话').policy === 'chat' && resolveTurnPolicy('讲一下这个代码').policy === 'chat');
check('S3② 技术/礼貌语境的“压力/烦”不抢共情（压力测试/函数压力/烦请）',
  resolveTurnPolicy('做个压力测试').policy === 'chat'
  && resolveTurnPolicy('这个函数压力很大').policy === 'chat'
  && resolveTurnPolicy('烦请确认一下').policy === 'chat');
check('S3① “今天好累” ⇒ empathy；“好累，怎么办” ⇒ chat（明确求建议）',
  resolveTurnPolicy('今天好累').policy === 'empathy' && resolveTurnPolicy('好累，怎么办').policy === 'chat');
check('S5① “帮我查下天气” ⇒ chat（不被故事/情绪抢走）',
  resolveTurnPolicy('帮我查下天气').policy === 'chat');
check('S7① 危机词 ⇒ empathy（随后走固定安全回应）',
  resolveTurnPolicy('我不想活了').policy === 'empathy');

const model = await startModel();
settings.petChat.baseUrl = model.base;
const host = await startHost();

/* ② S1：真跑 800+ 字故事，不需要模式开关 */
const s1 = await say(host.base, '讲个故事');
const s1System = String((model.seen.at(-1).body.messages || [])[0].content || '');
const s1Options = model.seen.at(-1).body.options || {};
check('S1③ “讲个故事” ⇒ 800+ 字、完整到结尾，meta/done 标 story',
  s1.meta.policy === 'story' && s1.done.story === true && [...s1.text].length >= 800
  && (s1.text.match(/[。！？!?]/g) || []).length >= 14,
  `chars=${[...s1.text].length} policy=${s1.meta.policy}`);
check('S1④ story prompt 写清 800–1500 字 / 开头发展结尾 / 不要问要不要继续',
  /800–1500 字/.test(s1System) && /开头、发展、结尾/.test(s1System) && /不要问“要不要继续”/.test(s1System));
check('S1⑤ story 轮放宽输出上限（num_predict=6000）且不按句数截断',
  s1Options.num_predict === 6000 && !/最多 8 句/.test(s1System), JSON.stringify(s1Options));

/* ③ S2：继续讲 + 按钮只在本轮 story */
await wait();
const s2 = await say(host.base, '继续讲');
const s2System = String((model.seen.at(-1).body.messages || [])[0].content || '');
check('S2① “继续讲” ⇒ 接着上一段（system 带上一段结尾），仍走 story',
  s2.meta.policy === 'story' && s2.meta.storyContinue === true && /上一段故事结尾/.test(s2System)
  && /第14章/.test(s2System),
  `continue=${s2.meta.storyContinue} sysHas=${/上一段故事结尾/.test(s2System)}`);
const clientSrc = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
check('S2② 故事按钮只在本轮 story 出现（继续讲 / 重讲 / 缩短）',
  /weT\('继续讲'\)/.test(clientSrc) && /weT\('重讲'\)/.test(clientSrc) && /weT\('缩短'\)/.test(clientSrc)
  && /petChatTurnPolicy === 'story' && petChatLastReply/.test(clientSrc)
  && /petChatStoryBarHide\(\);\s*\n\s*const turnStartAt/.test(clientSrc),
  'buttons gated by turn policy');

/* ④ S5：故事之后问天气 ⇒ 回到 chat，不再继续讲故事 */
await wait();
const s5 = await say(host.base, '帮我查下天气');
check('S5② 故事后问天气 ⇒ 正常 chat/tool（不继续讲故事）',
  s5.done.story !== true && s5.meta.policy !== 'story'
  && (s5.meta.policy === 'chat' || s5.done.confirm === true || s5.done.intent === 'action'),
  `policy=${s5.meta.policy} done=${JSON.stringify(s5.done)} text=${s5.text.slice(0, 16)}`);

/* ⑤ S3：情绪倾诉 ⇒ 先共情+提问，不列 1/2/3 */
await wait();
const s3 = await say(host.base, '今天好累');
const s3System = String((model.seen.at(-1).body.messages || [])[0].content || '');
check('S3② “今天好累” ⇒ empathy prompt（先接情绪 + 开放问题 + 不列 1/2/3）',
  s3.meta.policy === 'empathy' && /情绪优先/.test(s3System) && /不要列 1\/2\/3/.test(s3System)
  && /开放问题/.test(s3System),
  `policy=${s3.meta.policy}`);
check('S3③ 本轮回答没有机械编号/建议清单', !/(^|\n)\s*1[.、)]/.test(s3.text), s3.text.slice(0, 40));

/* ⑥ S4：静音只切 TTS，不改策略；恢复同理 */
await wait();
const beforeQuiet = model.seen.length;
const s4a = await say(host.base, '别说话了');
const stateQuiet = await (await fetch(`${host.base}/state`)).json();
const quietModelCalled = model.seen.slice(beforeQuiet).some((item) => {
  const msgs = ((item.body || {}).messages) || [];
  const last = String((msgs.filter((m) => m.role === 'user').pop() || {}).content || '');
  return last.includes('别说话了');
});
check('S4① “别说话了” ⇒ muted=true、有字幕、不调模型',
  s4a.done.muted === true && /安静/.test(s4a.text) && !quietModelCalled
  && stateQuiet.voice && stateQuiet.voice.muted === true,
  `muted=${s4a.done.muted} stateMuted=${stateQuiet.voice && stateQuiet.voice.muted} calls=${quietModelCalled ? 1 : 0} text=${s4a.text}`);
await wait();
const s4b = await say(host.base, '可以说了');
const stateResume = await (await fetch(`${host.base}/state`)).json();
check('S4② “可以说了” ⇒ muted=false、恢复朗读、仍不进入任何模式',
  s4b.done.muted === false && /回来/.test(s4b.text)
  && stateResume.voice && stateResume.voice.muted === false
  && s4b.done.policy === undefined,
  `muted=${s4b.done.muted}`);

/* ⑦ S7：危机词固定安全回应（不调模型） */
await wait();
const beforeCrisis = model.seen.length;
const s7 = await say(host.base, '我不想活了');
check('S7② 危机词 ⇒ 固定安全回应 + 热线 + 不调模型',
  s7.done.safety === true && /12356/.test(s7.text) && /不是心理治疗/.test(s7.text)
  && model.seen.length === beforeCrisis,
  `safety=${s7.done.safety} modelCalls=${model.seen.length - beforeCrisis}`);

/* ⑧ S6：用户可见的“模式”已删除 */
const assistantSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-assistant.js'), 'utf8');
const layerSrc = readFileSync(join(ROOT, 'src', 'pet-layer.js'), 'utf8');
const schemaSrc = readFileSync(join(ROOT, 'lib', 'settings-schema.js'), 'utf8');
check('S6① 设置页不再有「对话模式」下拉',
  !/conversation-mode/.test(assistantSrc) && !/row\('conversation-mode'/.test(assistantSrc)
  && !/对话模式：/.test(assistantSrc));
check('S6② 右键菜单不再有「模式」分组',
  !/we-pet-mode/.test(layerSrc) && !/modeHead/.test(layerSrc) && !/\["chat", weT\("聊天"\)\]/.test(layerSrc));
check('S6③ 客户端不再有模式状态/切换 API',
  !/petChatConversationMode/.test(clientSrc) && !/petChatSetMode/.test(clientSrc) && !/getMode:/.test(clientSrc));
check('S6④ 旧字段兼容但运行时强制 auto',
  /conversationMode: 'auto'/.test(schemaSrc) && /conversationMode: 'auto'/.test(readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8')));

await host.close();
await model.close();
const failed = results.filter((item) => !item.ok);
console.log(`\nINTENT FIRST CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
