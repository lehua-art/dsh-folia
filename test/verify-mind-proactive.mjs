/**
 * verify-mind-proactive.mjs — v1.2 判据 P1：
 *   主动思维 tick（默认 15 分钟，可配）；45 分钟连续工作能触发一次；
 *   勿扰/朗读中/录音中/静默时不打扰；每小时 ≤2 次；不重复最近 3 句。
 */
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT || 'C:/Windows/Temp/folia-asr-none';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'folia-mind-'));
process.env.DSH_FOLIA_HOME = HOME;
const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
const store = await import('../lib/persona-store.js');
const mind = await import('../lib/pet-chat-mind.js');
const proactive = await import('../lib/pet-chat-proactive.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const persona = store.createPersona({ type: 'assistant', name: '思维' });
store.setActivePersona(persona.id);
const settings = {
  petChat: {
    enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'x',
    proactive: { enabled: false, intervalMin: 15, quietFrom: '00:00', quietTo: '00:00' },
  },
};

function startHost() {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, { disposers: [], base: '/folia', log: () => {}, readSettings: () => settings, speechToText: null });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => resolveP({ base: `http://127.0.0.1:${server.address().port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) }));
  });
}
const post = async (base, path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return res.json();
};

/* ① 默认关 + 闸门 */
mind.clearMindState();
check('P1① 默认关：enabled=false 时 reason=disabled',
  mind.mindAllowed({ enabled: false }).reason === 'disabled');
const noon = new Date(2026, 10, 26, 12, 0).getTime();
const lateNight = new Date(2026, 10, 26, 23, 30).getTime();
const gate = mind.mindAllowed({ now: lateNight, enabled: true, quietFrom: '23:00', quietTo: '08:00', state: mind.emptyMindState(lateNight) });
check('P1② 勿扰时段不触发', gate.reason === 'quiet-hours', gate.reason);
check('P1③ 朗读中 / 录音中 / 一轮回答中 / 静音 都不打扰',
  mind.mindAllowed({ now: noon, enabled: true, speaking: true, quietFrom: '00:00', quietTo: '00:00' }).reason === 'speaking'
  && mind.mindAllowed({ now: noon, enabled: true, listening: true, quietFrom: '00:00', quietTo: '00:00' }).reason === 'listening'
  && mind.mindAllowed({ now: noon, enabled: true, turnBusy: true, quietFrom: '00:00', quietTo: '00:00' }).reason === 'turn-busy'
  && mind.mindAllowed({ now: noon, enabled: true, muted: true, quietFrom: '00:00', quietTo: '00:00' }).reason === 'muted');

/* ② 间隔 / 每小时上限 / 静默 */
const fresh = mind.emptyMindState(noon);
const soonState = { ...fresh, lastTickAt: noon - 5 * 60000 };
check('P1④ 间隔不足 15 分钟不 tick', mind.mindAllowed({ now: noon, enabled: true, quietFrom: '00:00', quietTo: '00:00', state: soonState }).reason === 'too-soon');
const capState = { ...fresh, saidAt: [noon - 60000, noon - 120000] };
check('P1⑤ 每小时最多 2 次主动', mind.mindAllowed({ now: noon, enabled: true, quietFrom: '00:00', quietTo: '00:00', state: capState }).reason === 'hour-cap');
check('P1⑥ 静默口令（silent）优先于一切',
  mind.mindAllowed({ now: noon, enabled: true, silent: true, quietFrom: '00:00', quietTo: '00:00' }).reason === 'silent');

/* ③ 45 分钟连续工作 → 主动问一次（可配置） */
const working = mind.mindTick({
  now: noon, enabled: true, quietFrom: '00:00', quietTo: '00:00', state: fresh,
  app: 'Code', activeMinutes: 45,
});
check('P1⑦ 连续写代码 45 分钟 ⇒ 主动提问（整理文档）',
  (working.action === 'ask' || working.action === 'speak') && working.line.includes('整理成文档') && [...working.line].length <= 60,
  `${working.action}: ${working.line}`);
check('P1⑧ 应用识别：Code / VLC / Zoom',
  mind.appKind('Code') === 'code' && mind.appKind('vlc.exe') === 'video' && mind.appKind('zoom') === 'meeting',
  'appKind');

/* ④ 不重复最近 3 句 */
mind.clearMindState();
mind.markMindSaid(noon, working.line, 'work');
const afterSaid = mind.mindTick({ now: noon + 16 * 60000, enabled: true, quietFrom: '00:00', quietTo: '00:00', state: mind.readMindState(noon + 16 * 60000), app: 'Code', activeMinutes: 50 });
check('P1⑨ 不重复最近 3 次说过的话', afterSaid.line !== working.line, afterSaid.line);

/* ⑤ 路由：默认关 / 静默 / 勿扰 / 开启后可触发并记事件 */
const host = await startHost();
const disabledTick = await post(host.base, '/mind/tick', {});
check('P1⑩ 路由默认关：/mind/tick ⇒ disabled', disabledTick.ok === false && disabledTick.reason === 'disabled', disabledTick.reason);
settings.petChat.proactive.enabled = true;
proactive.enterSilence();
const silentTick = await post(host.base, '/mind/tick', {});
check('P1⑪ 静默后：/mind/tick ⇒ silent（不主动）', silentTick.ok === false && silentTick.reason === 'silent', silentTick.reason);
proactive.clearSilence();
settings.petChat.proactive.quietFrom = '00:00';
settings.petChat.proactive.quietTo = '23:59';
const quietTick = await post(host.base, '/mind/tick', {});
check('P1⑫ 勿扰时段：/mind/tick ⇒ quiet-hours', quietTick.ok === false && quietTick.reason === 'quiet-hours', quietTick.reason);
// 让 tick 可以说话：改成“永不勿扰”的时间窗，等过间隔
settings.petChat.proactive.quietFrom = '00:00';
settings.petChat.proactive.quietTo = '00:00';
await new Promise((r) => setTimeout(r, 50));
const speakTick = await post(host.base, '/mind/tick', { activeMinutes: 45 });
check('P1⑬ 开启后：/mind/tick 能说一句并记账（气泡链路复用 /events）',
  speakTick.ok === true && Boolean(speakTick.line) && speakTick.usage.state.saidAt.length >= 1,
  `${speakTick.action || ''}:${speakTick.line || ''}`);
check('P1⑭ 状态接口暴露规则（15 分钟 / 每小时 2 次）',
  mind.MIND_RULES.defaultIntervalMin === 15 && mind.MIND_RULES.perHourCap === 2, 'rules');
// 事件触发（壁纸）不受主动开关影响（用户动作驱动）
const eventTick = await post(host.base, '/proactive/tick', { event: 'wallpaper', wallpaperTitle: '星空', sinceMs: 30000 });
check('P1⑮ 事件 tick 仍工作（用户换壁纸的点评不是“主动打扰”开关管的）',
  eventTick.ok === true || eventTick.reason === 'quiet-hours',
  `${eventTick.ok ? eventTick.line : eventTick.reason}`);

await host.close();
mind.clearMindState();
proactive.clearProactiveState();
const failed = results.filter((item) => !item.ok);
console.log(`\nMIND PROACTIVE CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
