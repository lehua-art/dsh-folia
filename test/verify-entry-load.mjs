/**
 * verify-entry-load.mjs — G1：**入口加载冒烟**。
 *
 * 事故（docs/POSTMORTEM-LOAD-CRASH.md）：`lib/index.js` 里直读 `ctx.speechToText`
 * （不在 inject 里）⇒ cordis 抛 "cannot get property … without inject" ⇒
 * 插件加载失败，用户连界面都进不去。所以这里用**最小 fake ctx** 真跑一遍 apply：
 *
 *   ① ctx 只给 webServer（故意不给 speechToText）⇒ 不抛错 + 基础路由在 +
 *     `/pet-chat/transcribe` 回 asr-not-ready（未就绪是功能状态，不是崩溃）
 *   ② ctx 额外提供 speechToText（就绪的 mock）⇒ 转写能通
 *
 * 两条都在 run-audit 里跑，红绿可见。
 */
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT || (process.platform === 'win32' ? 'C:/Windows/Temp/folia-asr-none' : '/tmp/folia-asr-none');
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const results = [];
function check(name, ok, detail) { results.push({ name, ok: Boolean(ok), detail }); }

const { default: plugin } = await import('../lib/index.js');

/** 最小 fake ctx：只实现插件真正用到的那几个面。 */
function makeCtx({ services = {} } = {}) {
  const routes = [];
  const effects = [];
  const logs = [];
  const ctx = {
    webServer: {
      register: (route) => { routes.push(route); return () => {}; },
      status: () => ({}),
    },
    effect: (fn) => { effects.push(fn); return () => {}; },
    get: (name) => services[name],
    logger: {
      info: (line) => logs.push(['info', line]),
      warn: (line) => logs.push(['warn', line]),
      error: (line) => logs.push(['error', line]),
      debug: () => {},
    },
    on: () => () => {},
    emit: () => {},
  };
  return { ctx, routes, effects, logs };
}

/** 把某族路由挂到真 http.Server 上（判据要发真请求）。 */
function serve(routes, suffix) {
  const route = routes.find((item) => String(item.path).endsWith(suffix));
  assert.ok(route, `路由 ${suffix} 已注册`);
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const wav = (() => {
  const frames = 16000; // 1 秒
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const put = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  put(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, frames * 2, true);
  return new Uint8Array(buffer);
})();

/* ① 只给 webServer：必须能加载，且语音路由回 asr-not-ready */
{
  let threw = null;
  let host = null;
  let routes = [];
  try {
    const fake = makeCtx({ services: {} });
    routes = fake.routes;
    await plugin.apply(fake.ctx);
    host = await serve(routes, '/pet-chat');
  } catch (error) {
    threw = String((error && error.message) || error);
  }

  const routePaths = routes.map((item) => String(item.path));
  const hasBase = routePaths.some((path) => path.endsWith('/pet-chat'))
    && routePaths.some((path) => path.endsWith('/pets/list'));
  let code = '';
  if (host) {
    const response = await fetch(`${host.base}/folia/pet-chat/transcribe`, {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
    });
    code = (await response.json()).code || '';
    await host.close();
  }
  check('① 最小 ctx（无 speechToText）加载不抛错，基础路由在，语音回 asr-not-ready',
    threw === null && hasBase && code === 'asr-not-ready',
    threw ? `抛错：${threw}` : `路由 ${routePaths.length} 条 · transcribe=${code || '未请求'}`);
}

/* ② 提供 speechToText（就绪）⇒ 转写能通 */
{
  const speech = {
    snapshot: () => ({
      providers: [{ id: 'sensevoice-local', name: 'SenseVoice', location: 'host-local', languages: ['zh'], preparation: { phase: 'ready' } }],
      selection: { providerId: 'sensevoice-local', language: 'zh' },
    }),
    resolve: (request) => ({ ...request, providerId: 'sensevoice-local' }),
    transcribe: async () => ({ text: '你好呀', audioSeconds: 1, inferenceSeconds: 0.2 }),
  };
  let threw = null;
  let doc = null;
  try {
    const fake = makeCtx({ services: { speechToText: speech } });
    await plugin.apply(fake.ctx);
    const host = await serve(fake.routes, '/pet-chat');
    const response = await fetch(`${host.base}/folia/pet-chat/transcribe`, {
      method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav,
    });
    doc = await response.json();
    await host.close();
  } catch (error) {
    threw = String((error && error.message) || error);
  }
  check('② 提供 speechToText ⇒ 转写返回文本（语音可用）',
    threw === null && doc && doc.ok === true && doc.text === '你好呀',
    threw ? `抛错：${threw}` : `ok=${doc && doc.ok} · text=${doc && doc.text}`);
}

/* 汇总 */
let failed = 0;
for (const item of results) {
  if (item.ok) process.stdout.write(`  ✓ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`);
  else { failed += 1; process.stdout.write(`  ✗ ${item.name}${item.detail ? ' — ' + item.detail : ''}\n`); }
}
process.stdout.write(`\n  ${results.length - failed} 通过 / ${failed} 失败\n`);
// apply() 会挂上插件自己的定时器/队列（真实宿主里由 ctx.effect 收走，fake ctx 里没人收），
// 判据跑完就显式退出，别让 runner 挂住。
process.exit(failed ? 1 : 0);
