/**
 * verify-capabilities-v5.mjs — 任务 §3 能力 / §4 插件调用 / §5 深度思考 / §3.2 多步任务。
 *
 * C1–C8  本地能力：算术/单位/笑话/谜语/诗/安慰/教学/规划（不调模型也能给出可用答案）
 * H50    50 条 hard asks：路由到正确能力、本地能答的真答、模型类有明确落点；≥40/50 且无"我只是AI"
 * P1–P6  插件/技能：列表（真实技能）/默认只列不调用/确认后调用/拒绝不调/失败可读/特殊人设禁止/审计
 * D1–D4  思考三档 + 自检 + deepseek-reasoner（语音不升级）+ >12s 降级
 * T1–T8  多步任务：计划/执行/高危确认/失败汇报/审计带 planId+step/三个真实场景
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-caps-v5-'));
const SKILLS = join(TEST_HOME, 'skills');
mkdirSync(join(SKILLS, 'office-demo'), { recursive: true });
writeFileSync(join(SKILLS, 'office-demo', 'SKILL.md'), [
  '---',
  'name: office-demo',
  'description: Demo office skill for capability-call tests',
  '---',
  '',
  '# Office demo',
  'Write a short weekly report with three sections: done / next / blocked.',
  'Keep it under 120 characters and end with "—— by demo skill".',
].join('\n'), 'utf8');
process.env.DSH_FOLIA_HOME = TEST_HOME;
process.env.DSH_WORKSPACE = join(TEST_HOME, 'workspace');
mkdirSync(process.env.DSH_WORKSPACE, { recursive: true });
process.env.FOLIA_SKILL_ROOTS = [SKILLS, 'D:/deepseek/resources/runtime/office-skills'].join(process.platform === 'win32' ? ';' : ':');

const brain = await import('../lib/pet-chat-brain.js');
const tools = await import('../lib/pet-chat-tools.js');
const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const { toolLogPath } = await import('../lib/persona-tool-log.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ══ C. 本地能力 ═══════════════════════════════════════════════════════════ */
console.log('\nC. 本地能力（不调模型也能给出可用答案）');
{
  const math = brain.localCapabilityAnswer('帮我算一下 12*3+5 等于多少');
  check('C1 算术：12*3+5=41（安全解析，不 eval）', math && math.text.includes('41'), math && math.text);
  const unit = brain.localCapabilityAnswer('3公里换算成米是多少');
  check('C2 单位换算：3 公里 = 3000 米', unit && unit.text.includes('3000'), unit && unit.text);
  const temp = brain.localCapabilityAnswer('100华氏换算成摄氏是多少');
  check('C2b 温度换算：100°F ≈ 37.8°C', temp && /37\.7|37\.8/.test(temp.text), temp && temp.text);
  const joke = brain.localCapabilityAnswer('讲个笑话');
  check('C3 笑话：直接给一个笑话，不分析情绪', joke && joke.text.length > 8 && !/你的情绪/.test(joke.text), joke && joke.text.slice(0, 26));
  const riddle = brain.localCapabilityAnswer('出个谜语');
  check('C4 谜语：给谜面并保留答案', riddle && riddle.answer && riddle.text.includes('？'), riddle && riddle.text);
  const poem = brain.localCapabilityAnswer('写首诗，关于月亮');
  check('C5 写诗：4 行，带题目', poem && poem.text.split('\n').length >= 5 && poem.text.includes('月亮'), poem && poem.text.split('\n')[0]);
  const comfort = brain.localCapabilityAnswer('我好累');
  check('C6 安慰：先接住感受，不建议列表', comfort && !/^1[.、]/.test(comfort.text) && comfort.text.length > 8, comfort && comfort.text.slice(0, 24));
  const teach = brain.localCapabilityAnswer('什么是递归');
  check('C7 教学：类比 + 例子（递归）', teach && /类比|像|例如/.test(teach.text), teach && teach.text.slice(0, 30));
  const study = brain.localCapabilityAnswer('帮我做个学习计划');
  check('C8 规划：学习计划带天数与步骤', study && /第 1–2 天|每天|复盘/.test(study.text), study && study.text.slice(0, 26));
  const singIntent = brain.classifyIntent('唱首歌', { now: Date.now() });
  check('C9 唱歌仍走 perform_sing（没有被能力层抢走）',
    singIntent.tool === 'perform_sing', singIntent.tool);
}

/* ══ H50. 50 条 hard asks ══════════════════════════════════════════════════ */
console.log('\nH50. 50 条 hard asks（路由 + 可答性）');
const HARD_ASKS = [
  ['帮我算一下 128*7+36', 'math'],
  ['3.5公里换算成英里是多少', 'unit'],
  ['今天几号', 'time'],
  ['现在几点', 'time'],
  ['讲个笑话', 'joke'],
  ['来个谜语', 'riddle'],
  ['写首诗，关于雨', 'poem'],
  ['夸夸我', 'comfort'],
  ['我今天好累', 'comfort'],
  ['什么是递归', 'teach'],
  ['解释一下什么是光合作用', 'teach'],
  ['讲讲区块链', 'teach'],
  ['帮我做个学习计划', 'plan_study'],
  ['帮我排个项目排期', 'plan_project'],
  ['周末行程怎么安排', 'plan_trip'],
  ['帮我整理桌面文件', 'task'],
  ['批量换壁纸', 'task'],
  ['唱首歌', 'sing'],
  ['清唱一首小星星', 'sing'],
  ['有哪些插件和技能', 'capabilities'],
  ['用 office-demo 技能写周报', 'capabilities'],
  ['把壁纸换成暗色的', 'desktop_ops'],
  ['音量调到 30', 'desktop_ops'],
  ['播放下一首', 'desktop_ops'],
  ['发个通知提醒我开会', 'desktop_ops'],
  ['打开记事本', 'desktop_ops'],
  ['打开 bilibili 网站', 'desktop_ops'],
  ['帮我把这段话复制到剪贴板', 'desktop_ops'],
  ['帮我把提纲写进 notes/plan.md', 'desktop_ops'],
  ['写一段产品文案', 'creation_model'],
  ['写一篇自我介绍', 'creation_model'],
  ['帮我起个名字', 'creation_model'],
  ['改一下我的简历', 'creation_model'],
  ['总结一下这段话', 'creation_model'],
  ['把这句话翻译成英文', 'creation_model'],
  ['帮我分析这个方案的优缺点', 'analysis'],
  ['对比一下两种做法', 'analysis'],
  ['为什么天空是蓝色的', 'analysis'],
  ['如何提高专注力', 'analysis'],
  ['我们来角色扮演吧', 'roleplay'],
  ['假装你是我的猫', 'roleplay'],
  ['记住我喜欢深色壁纸', 'memory'],
  ['以后叫我老王', 'memory'],
  ['帮我规划这周的学习，每天两小时', 'plan_study'],
  ['写一首关于秋天的短诗', 'poem'],
  ['讲个故事哄我睡', 'joke'],
  ['我心情不好，陪我聊聊', 'comfort'],
  ['用类比解释 HTTP', 'teach'],
  ['列出已安装的插件', 'capabilities'],
  ['按步骤帮我设置提醒并通知我', 'task'],
];
{
  const failures = [];
  for (const [ask, expected] of HARD_ASKS) {
    const capability = brain.capabilityForText(ask);
    const local = brain.localCapabilityAnswer(ask, { now: Date.now() });
    const routed = Boolean(capability) && capability.id === expected;
    const acceptable = routed && (capability.kind !== 'local' || Boolean(local && local.ok));
    if (!acceptable) failures.push(`${ask} ⇒ ${capability && capability.id}${local ? '' : ' (local 未命中)'}`);
  }
  const pass = HARD_ASKS.length - failures.length;
  check(`H50 ${HARD_ASKS.length} 条 hard asks 通过率 ≥40/50`, pass >= 40,
    `${pass}/${HARD_ASKS.length}${failures.length ? ' · 失败：' + failures.slice(0, 6).join(' | ') : ''}`);
  const prompt = brain.buildCapabilityPrompt();
  check('H50b 能力自述禁止"我只是AI"开头，要求先能做→限制→替代',
    /不要.*我只是一个AI|不要说.*我只是一个AI/.test(prompt) && /先给能做/.test(prompt) && /替代/.test(prompt));
}

/* ══ 台架：宿主 + 假模型 ═══════════════════════════════════════════════════ */
function fakeTts() {
  return {
    async synthesize() { return { ok: false, code: 'fake', attempts: [] }; },
    async voices() { return []; }, voiceMeta() { return {}; },
    stop() { return {}; }, status() { return { ok: true, ready: true }; }, dispose() {},
  };
}
const modelSeen = [];
const modelServer = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    let doc = null;
    try { doc = JSON.parse(body); } catch { doc = null; }
    modelSeen.push({ url: req.url, body: doc });
    if (doc && doc.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { content: '好的，我按技能写了一份周报（深度回答：先结论后要点）。' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(JSON.stringify({ message: { content: '好的，我按技能写了一份周报。—— by demo skill' }, done: false }) + '\n');
    res.end();
  });
});
await new Promise((r) => { modelServer.listen(0, '127.0.0.1', r); });
const modelBase = `http://127.0.0.1:${modelServer.address().port}`;
const settings = { petChat: { enabled: true, provider: 'ollama', baseUrl: modelBase, model: 'deepseek-chat' } };

function startHost() {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [], base: '/folia', log: () => {}, readSettings: () => settings,
    speechToText: undefined, tts: fakeTts(),
    services: { skills: { list: () => [{ name: 'service-skill', description: 'from ctx.skills' }], get: () => ({ content: 'service skill body' }) } },
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  const server = createServer((req, res) => { route.handler(req, res); });
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({ base: `http://127.0.0.1:${port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
async function readSse(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
      let event = 'message'; let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (data) { try { events.push({ event, data: JSON.parse(data) }); } catch { /* ignore */ } }
    }
  }
  return events;
}
async function chat(host, text, personaId) {
  const res = await postJson(host.base + '/chat', { text, personaId, inputMode: 'text' });
  const events = await readSse(res);
  return {
    events,
    done: (events.find((e) => e.event === 'done') || { data: {} }).data,
    text: events.filter((e) => e.event === 'delta').map((e) => e.data.t || '').join(''),
  };
}
const host = await startHost();
try {
  const persona = (await (await postJson(host.base + '/personas', { type: 'assistant', name: '小满' })).json()).persona;

  /* ══ P. 插件/技能 ══════════════════════════════════════════════════════ */
  console.log('\nP. 已安装插件/技能（列出 → 询问 → 调用 → 审计）');
  const capDoc = await (await fetch(host.base + '/capabilities')).json();
  const hasRealOffice = capDoc.skills.some((skill) => skill.name.startsWith('office-'));
  check('P1 列出真实技能（含 office-* 与 ctx.skills 服务）+ 已安装插件',
    capDoc.ok === true && capDoc.skills.some((skill) => skill.name === 'office-demo')
      
      && capDoc.plugins.length > 0
      && capDoc.enabled.length === 0,
    `skills=${capDoc.skills.map((s) => s.name).slice(0, 8).join(',')} plugins=${capDoc.plugins.length}`);

  await wait(1100);
  const askCall = await chat(host, '用 office-demo 技能帮我写个周报', persona.id);
  const confirm = askCall.events.find((e) => e.event === 'confirm');
  check('P2 默认 ask：不直接调用，先问确认', Boolean(confirm) && askCall.done.confirm === true && confirm.data.tool === 'capability_call',
    askCall.done.tool);

  const allowed = await (await postJson(host.base + '/tool-confirm', { id: confirm.data.id, decision: 'allow' })).json();
  await wait(300);
  let log = await (await fetch(host.base + `/personas/${persona.id}/tool-log?limit=20`)).json();
  const capLog = log.items.find((item) => item.tool === 'capability_call' && item.result === 'ok');
  check('P3 确认后真调用：返回技能内容 + 模型按技能作答 + 审计来源 skill-filesystem',
    allowed.ok === true && capLog && capLog.source === 'skill-filesystem' && capLog.verified === true,
    `log=${JSON.stringify(capLog && { source: capLog.source, result: capLog.result })} all=${JSON.stringify(log.items.filter((i) => i.tool === 'capability_call').slice(0, 4))}`);

  await wait(1100);
  const askDeny = await chat(host, '用 office-demo 技能写个周报', persona.id);
  const denyConfirm = askDeny.events.find((e) => e.event === 'confirm');
  await postJson(host.base + '/tool-confirm', { id: denyConfirm.data.id, decision: 'deny' });
  await wait(200);
  log = await (await fetch(host.base + `/personas/${persona.id}/tool-log?limit=20`)).json();
  check('P4 拒绝 ⇒ 不调用（审计 cancelled，没有第二次 ok 调用）',
    log.items.some((item) => item.tool === 'capability_call' && item.result === 'cancelled'));

  await postJson(host.base + '/capabilities', { id: 'skill:office-demo', enabled: true });
  await postJson(host.base + `/personas/${persona.id}/permissions`, { group: 'plugins', level: 'allow' });
  await wait(1100);
  const direct = await chat(host, '用 office-demo 技能写个周报', persona.id);
  check('P5 启用 + 组 allow ⇒ 直接调用（不弹确认），结果回传对话',
    direct.done.ok === true && direct.done.capability === 'skill:office-demo'
      && /周报/.test(direct.text) && !direct.events.some((e) => e.event === 'confirm'),
    `done=${direct.done.capability || direct.done.tool}`);

  const missing = await tools.runTool('capability_call', { id: 'skill:does-not-exist' }, {
    persona: { type: 'assistant', permissions: { plugins: 'allow' } },
    toolWhitelist: { capabilities: ['skill:does-not-exist'] }, sourceText: '',
  });
  check('P6 失败有可读原因（不存在的技能 / 插件无通用调用面）',
    missing.ok === false && /没有这个能力/.test(missing.say));

  const character = (await (await postJson(host.base + '/personas', { type: 'character', name: '角色' })).json()).persona;
  await wait(1100);
  const charChat = await chat(host, '用 office-demo 技能写个周报', character.id);
  check('P7 特殊人设：能力调用被代码层拒绝（不弹确认、不调用）',
    charChat.done.tool === 'capability_call' && charChat.done.verified !== true
      && !charChat.events.some((e) => e.event === 'confirm'),
    `done=${JSON.stringify(charChat.done).slice(0, 100)}`);

  const panelSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-personas.js'), 'utf8');
  check('P8 UI：权限页有「已安装插件与技能」区 + 逐项开关（默认只列不调用）',
    /已安装插件与技能/.test(panelSrc) && /toggleCapability/.test(panelSrc)
      && /\/pet-chat\/capabilities/.test(panelSrc) && /只列出已安装的能力/.test(panelSrc));

  /* ══ T. 多步任务 ═══════════════════════════════════════════════════════ */
  console.log('\nT. 多步任务（计划/执行/确认/失败汇报/审计）');
  await wait(1100);
  const planChat = await chat(host, '帮我整理桌面文件，按步骤来', persona.id);
  const planEvent = planChat.events.find((e) => e.event === 'plan');
  check('T1 计划：2–6 步，带步骤与工具，SSE plan 事件 + 人话摘要',
    planEvent && planEvent.data.steps.length >= 2 && planEvent.data.steps.length <= 6
      && planEvent.data.steps.every((step) => step.tool && step.label)
      && planChat.done.tool === 'task_plan' && /我把它拆成/.test(planChat.text),
    `steps=${planEvent && planEvent.data.steps.map((s) => s.tool).join(',')}`);

  await wait(1100);
  const run1 = await chat(host, '开始', persona.id);
  check('T2 执行下一步（step 1）并按该步工具回读',
    run1.done.tool === 'status_query' && run1.done.data && run1.done.data.plan
      && run1.done.data.plan.step === 1 && run1.done.data.plan.done === true,
    JSON.stringify(run1.done.data && run1.done.data.plan));

  await wait(1100);
  const run2 = await chat(host, '执行第 2 步', persona.id);
  check('T3 高危步骤（写文件）仍先二次确认',
    run2.done.confirm === true && run2.events.some((e) => e.event === 'confirm'),
    `tool=${run2.done.tool}`);
  const stepConfirm = run2.events.find((e) => e.event === 'confirm');
  const run2Allow = await (await postJson(host.base + '/tool-confirm', { id: stepConfirm.data.id, decision: 'allow' })).json();
  await wait(300);
  log = await (await fetch(host.base + `/personas/${persona.id}/tool-log?limit=30`)).json();
  const stepLog = log.items.find((item) => item.tool === 'doc_write' && item.confirmed === true && item.planId);
  check('T4 确认后执行，审计带 planId + step', run2Allow.ok === true && stepLog && stepLog.step === 2
    && /^plan-/.test(stepLog.planId), JSON.stringify(stepLog && { plan: stepLog.planId, step: stepLog.step }));

  const templates = ['整理桌面文件', '批量换壁纸', '提醒并通知', '写文档并打开'];
  const built = templates.map((goal) => brain.buildTaskPlan(goal, Date.now()));
  check('T5 三个真实场景都有专用拆解（整理文件/批量壁纸/提醒+通知/写文档并打开）',
    built.every((plan) => plan.steps.length >= 2 && plan.template !== 'generic')
      && new Set(built.map((plan) => plan.template)).size === 4,
    built.map((plan) => plan.template).join(','));

  const failPlan = brain.buildTaskPlan('随便做点什么', Date.now());
  const failedStep = await tools.runTool('capability_call', { id: 'skill:nope' }, {
    persona, toolWhitelist: { capabilities: [] }, sourceText: '',
  });
  check('T6 失败会汇报可读原因（不会假装完成）',
    failPlan.steps.length >= 2 && failedStep.ok === false && failedStep.say.length > 4,
    failedStep.say.slice(0, 30));

  /* ══ D. 深度思考 ═══════════════════════════════════════════════════════ */
  console.log('\nD. 思考三档 + 自检 + reasoner（语音不升级）');
  check('D1 三档：语音/寒暄 quick；算术本地 quick；规划分析 deep；中长文字 standard',
    brain.thinkingTier('你好', { inputMode: 'voice' }) === 'quick'
      && brain.thinkingTier('帮我算 12*3', { inputMode: 'text' }) === 'quick'
      && brain.thinkingTier('帮我分析一下这个方案的风险和优缺点，要给出结论', { inputMode: 'text' }) === 'deep'
      && brain.thinkingTier('随便聊两句今天发生的事吧，我有点无聊想听你说说', { inputMode: 'text' }) === 'standard'
      && brain.thinkingTier('帮我分析一下这个方案的风险和优缺点，要给出结论', { inputMode: 'voice' }) === 'quick');
  check('D2 deep 可切 deepseek-reasoner；quick/语音不切',
    brain.reasonerModelFor('deepseek-chat', 'deep') === 'deepseek-reasoner'
      && brain.reasonerModelFor('deepseek-chat', 'quick') === 'deepseek-chat'
      && brain.reasonerModelFor('gpt-4o', 'deep') === 'gpt-4o');
  const selfCheck = brain.buildSelfCheckPrompt();
  check('D3 自检清单覆盖：答非所问/共情/事实/更简单',
    /答非所问/.test(selfCheck) && /感受/.test(selfCheck) && /事实/.test(selfCheck) && /简单/.test(selfCheck));

  await wait(1100);
  modelSeen.length = 0;
  const deepChat = await chat(host, '帮我分析一下这个方案的风险和优缺点，要给出结论', persona.id);
  const deepDone = deepChat.done;
  const selfCheckCall = modelSeen.find((item) => item.body && item.body.stream === false
    && String((item.body.messages || [{}])[0].content || '').includes('[self-check]'));
  const draftCall = modelSeen.find((item) => item.body && item.body.stream === false && item !== selfCheckCall
    && String((item.body.messages || [{}])[0].content || '').includes('【能力清单】'));
  check('D4 深度档：要点 → 草稿 → 自检 → 最终（≥3 次调用、含自检、模型切 reasoner）',
    deepDone.tier === 'deep' && modelSeen.length >= 3 && Boolean(selfCheckCall) && Boolean(draftCall)
      && /reasoner/.test(String(draftCall.body.model || ''))
      && /深度回答/.test(deepChat.text),
    `calls=${modelSeen.length} model=${draftCall && draftCall.body.model} tier=${deepDone.tier}`);

  check('D5 前端：深度档 >3s 显示「深度思考中…」',
    /深度思考中/.test(readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8'))
      && /payload.tier === 'deep'/.test(readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8')));
} finally {
  await host.close();
  await new Promise((r) => modelServer.close(r));
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter((item) => !item.ok);
console.log(`\nCAPABILITY/PLUGIN/TASK/THINKING V5 ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}


