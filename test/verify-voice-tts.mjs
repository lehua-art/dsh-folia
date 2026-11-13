/**
 * verify-voice-tts.mjs — 桌宠「智能语音闭环」P1 的判据。
 *
 * 覆盖（与工单 ①–⑦ 一一对应）：
 *   ① 真合成：worker 一次性模式真跑 PowerShell，**真落一个 >10KB 的 WAV**（Windows）；
 *   ② 兜底链：注入假引擎证明「SAPI 失败 → Edge/OneCore 成功」「两个都失败 → 明确错误 + 每跳原因」；
 *   ③ 路由：真 http.Server 上 GET /pet-chat/tts 回 200 + audio/wav + >10KB；400/409/503 语义；
 *   ④ stop 幂等：POST /tts/stop 连打两次都回 `{ok:true}`；
 *   ⑤ 打断顺序：petVoiceInput.start() 必须 **先 onBeforeRecord 再 postRecord**（运行时断言，
 *      不只扫源码）；petChatWake / 打字入口也先停朗读；
 *   ⑥ 分句队列：petTtsCreate 按句请求、顺序播放、stop 清队列并暂停当前音频；
 *   ⑦ 三态气泡：listen/think/speak 的 `data-state` + “说”时的波形 CSS；
 *   ⑧ 工作联动：`window.__dshFoliaPet.speak` / `we-pet-speak` 事件 / `/pet-chat/speak` + `/events`。
 *
 * 真合成档在非 Windows 上打印 SKIP（本功能只支持 Windows 系统语音），其余判据照跑。
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 合成文件的临时 home：绝不能写用户真实 `~/.dsh-folia`。 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-voice-tts-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;
process.env.FOLIA_ASR_ROOT = join(TEST_HOME, 'asr-none');

/** 造一个合法 WAV（RIFF/WAVE + 指定字节数），用于假引擎/路由夹具。 */
function makeWav(bytes = 12000) {
  const size = Math.max(44, Number(bytes) || 12000);
  const buf = Buffer.alloc(size);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(size - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(size - 44, 40);
  return buf;
}

const wavFixture = join(TEST_HOME, 'fixture.wav');
writeFileSync(wavFixture, makeWav(12000));

/* ── ⑧ 静态面：路由 / 客户端通道 / 打包面 ──────────────────────────────── */

const routeSrc = readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8');
const clientSrc = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
const voiceSrc = readFileSync(join(ROOT, 'src', 'pet-voice-input.js'), 'utf8');
const ttsClientSrc = readFileSync(join(ROOT, 'src', 'pet-tts.js'), 'utf8');
const bubbleSrc = readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8');
const ttsServiceSrc = readFileSync(join(ROOT, 'lib', 'tts', 'tts.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const petChatRoutes = await import('../lib/routes/pet-chat.js');
const { registerPetChatRoutes, DEPS, OPTIONAL_DEPS } = petChatRoutes;

{
  const routeBits = ['/tts', '/tts/stop', '/tts/state', '/events', '/speak', 'audio/wav'];
  const missing = routeBits.filter((bit) => !routeSrc.includes(bit));
  check('① 路由族存在（/tts · /tts/stop · /tts/state · /events · /speak · audio/wav）',
    missing.length === 0, missing.length ? '缺：' + missing.join(',') : routeBits.join(' '));
  check('① TTS 是**可选注入**（DEPS 不膨胀；判据可传假服务）',
    !DEPS.includes('tts') && OPTIONAL_DEPS.includes('tts'), `DEPS=${DEPS.join(',')} OPTIONAL=${OPTIONAL_DEPS.join(',')}`);  const files = Array.isArray(pkg.files) ? pkg.files : [];
  check('① 发布面覆盖 lib/tts/（tts.js + tts-worker.cjs 都要随包）',
    files.includes('lib/tts/') && !files.includes('lib/tts/tts-worker.cjs'), JSON.stringify(files.filter((f) => String(f).startsWith('lib/tts'))));
  check('① 宿主 TTS 服务导出 createTtsService / normalizeTtsText / TTS_MAX_CHARS / 音色路由 / 缓存 key',
    /export function createTtsService\(/.test(ttsServiceSrc)
      && /export function normalizeTtsText\(/.test(ttsServiceSrc)
      && /export const TTS_MAX_CHARS/.test(ttsServiceSrc)
      && /export function preferredEngineForVoice\(/.test(ttsServiceSrc)
      && /export function ttsCacheKey\(/.test(ttsServiceSrc), 'lib/tts/tts.js');
}

/* ── ② 兜底链（真 worker 模块 + 注入假引擎）──────────────────────────────── */

{
  const workerPath = join(ROOT, 'lib', 'tts', 'tts-worker.cjs');
  const worker = require(workerPath);
  const dir = join(TEST_HOME, 'chain');
  const fs = require('node:fs');
  fs.mkdirSync(dir, { recursive: true });

  const edgeOnly = await worker.synthesizeOnce('兜底链测试。', { voice: '', rate: 0 }, {
    dir,
    runSapi: async () => ({ ok: false, error: 'sapi-forced-fail' }),
    runEdge: async () => ({ ok: true, file: wavFixture, bytes: 12000, voice: 'Microsoft Yaoyao', ms: 7 }),
  });
  check('② SAPI 失败 ⇒ 自动退 Edge/OneCore 系统音色（engine=edge）',
    edgeOnly.ok === true && edgeOnly.engine === 'edge' && edgeOnly.attempts.length === 1
      && edgeOnly.attempts[0].engine === 'sapi',
    `engine=${edgeOnly.engine} · attempts=${JSON.stringify(edgeOnly.attempts)}`);

  const bothFail = await worker.synthesizeOnce('都失败。', {}, {
    dir,
    runSapi: async () => ({ ok: false, error: 'sapi-forced-fail' }),
    runEdge: async () => ({ ok: false, error: 'edge-forced-fail' }),
  });
  check('② 两条引擎都失败 ⇒ 明确 tts-unavailable + 每跳原因（不静默）',
    bothFail.ok === false && bothFail.code === 'tts-unavailable'
      && bothFail.attempts.length === 2
      && bothFail.attempts[0].engine === 'sapi' && bothFail.attempts[1].engine === 'edge'
      && /sapi/.test(bothFail.error) && /edge/.test(bothFail.error),
    `code=${bothFail.code} · attempts=${JSON.stringify(bothFail.attempts)}`);

  // pre.46 修复 A：neural 音色先走 edge；SAPI 名/空先走 sapi。
  check('② 音色→引擎：neural 名 edge 优先、SAPI 名/空 sapi 优先',
    eq(worker.engineOrderForVoice('zh-CN-XiaoxiaoNeural', ['sapi', 'edge']), ['edge', 'sapi'])
      && eq(worker.engineOrderForVoice('Microsoft Huihui Desktop', ['sapi', 'edge']), ['sapi', 'edge'])
      && eq(worker.engineOrderForVoice('', ['sapi', 'edge']), ['sapi', 'edge'])
      && eq(worker.engineOrderForVoice('zh-CN-XiaoxiaoNeural', ['sapi']), ['sapi']),
    JSON.stringify({
      neural: worker.engineOrderForVoice('zh-CN-XiaoxiaoNeural', ['sapi', 'edge']),
      sapi: worker.engineOrderForVoice('Microsoft Huihui Desktop', ['sapi', 'edge']),
    }));

  const routed = [];
  const neuralHit = await worker.synthesizeOnce('音色路由。', { voice: 'zh-CN-XiaoxiaoNeural', rate: 0 }, {
    dir,
    runSapi: async () => { routed.push('sapi'); return { ok: false, error: 'voice-not-found: x' }; },
    runEdge: async () => { routed.push('edge'); return { ok: true, file: wavFixture, bytes: 12000, voice: 'zh-CN-XiaoxiaoNeural', ms: 5 }; },
  });
  check('② neural 名 ⇒ **先调 edge**（SAPI 的默认回落不许抢在用户音色前面）',
    neuralHit.ok === true && neuralHit.engine === 'edge' && eq(routed, ['edge']),
    `engine=${neuralHit.engine} · calls=${routed.join('→')}`);

  const strict = await worker.synthesizeOnce('缺音色。', { voice: 'zh-CN-NoSuchNeural', rate: 0 }, {
    dir,
    runSapi: async () => ({ ok: false, error: 'voice-not-found: zh-CN-NoSuchNeural' }),
    runEdge: async () => ({ ok: false, error: 'voice-not-found: zh-CN-NoSuchNeural' }),
  });
  check('② 明确指定的音色两条引擎都没有 ⇒ 失败 + attempts 两条（禁止默认音色静默成功）',
    strict.ok === false && strict.code === 'tts-unavailable'
      && strict.attempts.length === 2
      && strict.attempts.every((item) => /voice-not-found/.test(item.error))
      && strict.requestedVoice === 'zh-CN-NoSuchNeural',
    `code=${strict.code} · attempts=${JSON.stringify(strict.attempts)}`);
}

/* ── ③ 真合成：worker 一次性模式（Windows）───────────────────────────────── */

const workerPath = join(ROOT, 'lib', 'tts', 'tts-worker.cjs');
if (process.platform !== 'win32') {
  console.log('  — 真合成档跳过：系统语音只支持 Windows');
} else {
  const dir = mkdtempSync(join(TEST_HOME, 'once-'));
  const reqFile = join(dir, 'req.json');
  const outFile = join(dir, 'out.wav');
  writeFileSync(reqFile, JSON.stringify({ text: '测试一句话，今天也要好好休息。', voice: '', rate: 0 }), 'utf8');
  const run = spawnSync(process.execPath, [workerPath, '--once', '--req', reqFile, '--out', outFile], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });
  let doc;
  try { doc = JSON.parse(String(run.stdout || '').trim().split('\n').pop()); } catch { doc = null; }
  const bytes = (() => { try { return statSync(outFile).size; } catch { return 0; } })();
  let riff;
  try {
    const head = readFileSync(outFile).subarray(0, 12).toString('ascii');
    riff = head.slice(0, 4) === 'RIFF' && head.slice(8, 12) === 'WAVE';
  } catch { riff = false; }
  check('③ worker 真能生成文件（exit 0 · RIFF/WAVE · >10KB · engine=sapi/edge）',
    run.status === 0 && Boolean(doc && doc.ok) && riff && bytes > 10240
      && (doc.engine === 'sapi' || doc.engine === 'edge'),
    `exit=${run.status} · engine=${doc && doc.engine} · bytes=${bytes} · riff=${riff}`
      + (run.status !== 0 ? ' · stderr=' + String(run.stderr || '').slice(0, 200) : ''));

  // pre.46 修复 A 的真机面：明确指定一个不存在的音色 ⇒ 必须失败并回两条 attempts，
  // 绝不静默用 Huihui 合成（这正是用户“设置里选了音色却听不到它”的根因）。
  const strictDir = mkdtempSync(join(TEST_HOME, 'strict-'));
  const strictReq = join(strictDir, 'req.json');
  const strictOut = join(strictDir, 'out.wav');
  writeFileSync(strictReq, JSON.stringify({
    text: '这个音色不存在。', voice: 'Microsoft DefinitlyNoSuchVoice Desktop', rate: 0,
  }), 'utf8');
  const strictRun = spawnSync(process.execPath, [workerPath, '--once', '--req', strictReq, '--out', strictOut], {
    cwd: ROOT, encoding: 'utf8', timeout: 60000,
  });
  let strictDoc;
  try { strictDoc = JSON.parse(String(strictRun.stdout || '').trim().split('\n').pop()); } catch { strictDoc = null; }
  const strictBytes = (() => { try { return statSync(strictOut).size; } catch { return 0; } })();
  check('③ 真机：明确指定不存在的音色 ⇒ exit 1 + 两条 voice-not-found + 不产出 WAV（不静默）',
    strictRun.status === 1 && strictDoc && strictDoc.ok === false
      && strictDoc.attempts.length === 2
      && strictDoc.attempts.every((item) => /voice-not-found/.test(String(item.error || '')))
      && strictBytes === 0,
    `exit=${strictRun.status} · attempts=${JSON.stringify(strictDoc && strictDoc.attempts)} · bytes=${strictBytes}`);

  // pre.46 修复 A 的缓存面：同句在 sapi / edge 下必须写成两个缓存条目，第二次同引擎命中。
  {
    const { createTtsService, ttsCacheKey, preferredEngineForVoice } = await import('../lib/tts/tts.js');
    const cacheDir = mkdtempSync(join(TEST_HOME, 'cache-'));
    const svc = createTtsService({ cacheDir });
    try {
      const sapi = await svc.synthesize('缓存引擎测试。', { voice: '', rate: 0, engines: ['sapi'] });
      const edge = await svc.synthesize('缓存引擎测试。', { voice: '', rate: 0, engines: ['edge'] });
      const sapiAgain = await svc.synthesize('缓存引擎测试。', { voice: '', rate: 0, engines: ['sapi'] });
      const files = readdirSync(cacheDir).filter((name) => name.endsWith('.wav'));
      check('③ 缓存 key 含引擎：sapi 与 edge 同句 ⇒ 两个缓存文件、第二次同引擎 <50ms 命中',
        sapi.ok === true && edge.ok === true && sapi.engine === 'sapi' && edge.engine === 'edge'
          && files.length === 2 && sapiAgain.cached === true && sapiAgain.ms === 0
          && ttsCacheKey('sapi', '', 0, 'x') !== ttsCacheKey('edge', '', 0, 'x')
          && preferredEngineForVoice('zh-CN-XiaoxiaoNeural') === 'edge'
          && preferredEngineForVoice('Microsoft Huihui Desktop') === 'sapi',
        `sapi=${sapi.engine}/${sapi.voice} · edge=${edge.engine}/${edge.voice} · files=${files.length} · cached=${sapiAgain.cached}`);
    } finally {
      svc.dispose();
    }
  }
}

/* ── ③/④ 路由：真 http.Server（假 TTS 注入；不依赖麦克风/模型）──────────── */

function startHost(settings, tts) {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [],
    base: '/folia',
    log: () => {},
    readSettings: () => settings,
    speechToText: undefined,
    tts,
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  if (!route) throw new Error('路由未注册');
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({
        base: `http://127.0.0.1:${port}/folia/pet-chat`,
        close: () => new Promise((r) => {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
          server.close(r);
        }),
      });
    });
  });
}

function fakeTts() {
  let generation = 0;
  const calls = [];
  return {
    calls,
    stopCalls: 0,
    async synthesize(text, opts) {
      calls.push({ text, opts });
      const requestedVoice = String((opts && opts.voice) || '');
      const neural = /Neural$/.test(requestedVoice);
      if (text === '失败文本') {
        return {
          ok: false, code: 'tts-unavailable', hint: '两跳都失败',
          requestedVoice,
          attempts: [
            { engine: neural ? 'edge' : 'sapi', error: 'voice-not-found: ' + requestedVoice },
            { engine: neural ? 'sapi' : 'edge', error: 'voice-not-found: ' + requestedVoice },
          ],
        };
      }
      return {
        ok: true, wav: makeWav(12000),
        engine: neural ? 'edge' : 'sapi',
        voice: requestedVoice || 'Microsoft Huihui Desktop',
        requestedVoice,
        attempts: [],
        ms: 12,
        cached: false,
      };
    },
    stop() { generation += 1; this.stopCalls += 1; return { ok: true, generation }; },
    status() { return { ok: true, ready: true, engines: ['sapi', 'edge'], generation }; },
    dispose() {},
  };
}

{
  const tts = fakeTts();
  const host = await startHost({ petChat: { enabled: true, provider: 'ollama', voice: { name: 'zh-CN-XiaoxiaoNeural', muted: false } } }, tts);
  try {
    const sapiVoice = encodeURIComponent('Microsoft Huihui Desktop');
    const ok = await fetch(`${host.base}/tts?text=${encodeURIComponent('测试')}&voice=${sapiVoice}&rate=0`);
    const bytes = new Uint8Array(await ok.arrayBuffer());
    check('③ GET /pet-chat/tts → 200 + audio/wav + >10KB',
      ok.status === 200 && /audio\/wav/i.test(String(ok.headers.get('content-type') || '')) && bytes.byteLength > 10240
        && ok.headers.get('x-folia-tts-engine') === 'sapi'
        && decodeURIComponent(String(ok.headers.get('x-folia-tts-requested-voice') || '')) === 'Microsoft Huihui Desktop',
      `status=${ok.status} · bytes=${bytes.byteLength} · engine=${ok.headers.get('x-folia-tts-engine')}`
        + ` · requested=${decodeURIComponent(String(ok.headers.get('x-folia-tts-requested-voice') || ''))}`);

    // pre.46 A：配置里的 neural 音色 ⇒ 响应头必须给出 requested / actual / engine / attempts。
    const neural = await fetch(`${host.base}/tts?text=${encodeURIComponent('音色路由')}&rate=0`);
    await neural.arrayBuffer();
    const header = (name) => String(neural.headers.get(name) || '');
    let attemptsHeader = null;
    try { attemptsHeader = JSON.parse(decodeURIComponent(header('x-folia-tts-attempts'))); } catch { attemptsHeader = null; }
    check('③ 配置 neural 音色 ⇒ X-Folia-TTS-Engine=edge、Voice/Requested=zh-CN-XiaoxiaoNeural、Attempts 可解析',
      neural.status === 200 && header('x-folia-tts-engine') === 'edge'
        && decodeURIComponent(header('x-folia-tts-voice')) === 'zh-CN-XiaoxiaoNeural'
        && decodeURIComponent(header('x-folia-tts-requested-voice')) === 'zh-CN-XiaoxiaoNeural'
        && Array.isArray(attemptsHeader),
      `engine=${header('x-folia-tts-engine')} · actual=${decodeURIComponent(header('x-folia-tts-voice'))}`
        + ` · requested=${decodeURIComponent(header('x-folia-tts-requested-voice'))} · attempts=${JSON.stringify(attemptsHeader)}`);

    // 紧跟在一次成功合成之后取 state：它要给出“上一次实际用的音色/引擎”（failure 之后会被清空）。
    const state = await (await fetch(`${host.base}/tts/state`)).json();
    check('④ GET /tts/state 回合成链、requested/actual/engine/attempts（不触发合成）',
      state.ok === true && Array.isArray(state.engines) && state.engines.includes('sapi')
        && state.engines.includes('edge') && state.voice && state.voice.muted === false
        && state.requestedVoice === 'zh-CN-XiaoxiaoNeural'
        && state.actualVoice === 'zh-CN-XiaoxiaoNeural'
        && state.engine === 'edge'
        && Array.isArray(state.attempts),
      `engines=${(state.engines || []).join(',')} · requested=${state.requestedVoice}`
        + ` · actual=${state.actualVoice} · engine=${state.engine}`);

    const head = await fetch(`${host.base}/tts?text=${encodeURIComponent('测试')}`, { method: 'HEAD' });
    check('③ HEAD /pet-chat/tts 不合成、只回头（空体）',
      head.status === 200 && /audio\/wav/i.test(String(head.headers.get('content-type') || '')),
      `status=${head.status}`);

    const empty = await fetch(`${host.base}/tts?text=`);
    const emptyDoc = await empty.json();
    check('③ 空 text ⇒ 400 bad-request（不触发合成）',
      empty.status === 400 && emptyDoc.code === 'bad-request', `status=${empty.status} code=${emptyDoc.code}`);

    const fail = await fetch(`${host.base}/tts?text=${encodeURIComponent('失败文本')}`);
    const failDoc = await fail.json();
    check('③ 合成失败 ⇒ 503 + tts-unavailable + attempts + requestedVoice（不静默）',
      fail.status === 503 && failDoc.code === 'tts-unavailable'
        && Array.isArray(failDoc.attempts) && failDoc.attempts.length === 2
        && failDoc.requestedVoice === 'zh-CN-XiaoxiaoNeural',
      `status=${fail.status} code=${failDoc.code} requested=${failDoc.requestedVoice}`);

    const stop1 = await fetch(`${host.base}/tts/stop`, { method: 'POST' });
    const stopDoc1 = await stop1.json();
    const stop2 = await fetch(`${host.base}/tts/stop`, { method: 'POST' });
    const stopDoc2 = await stop2.json();
    check('④ POST /tts/stop 幂等：连打两次都 {ok:true}',
      stop1.status === 200 && stop2.status === 200 && stopDoc1.ok === true && stopDoc2.ok === true && tts.stopCalls === 2,
      `#1=${JSON.stringify(stopDoc1)} #2=${JSON.stringify(stopDoc2)}`);

    // ⑧ 工作联动：没有客户端时先排队，客户端连上 /events 立刻补发
    const speak = await fetch(`${host.base}/speak`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '提醒：该喝水了' }),
    });
    const speakDoc = await speak.json();
    const controller = new AbortController();
    const events = await fetch(`${host.base}/events`, { signal: controller.signal });
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let payload = null;
    const deadline = Date.now() + 3000;
    while (!payload && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- 读 SSE 必须逐块等
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const frame of buffer.split('\n\n')) {
        const line = frame.split('\n').find((item) => item.startsWith('data:'));
        if (!line) continue;
        try { payload = JSON.parse(line.slice(5).trim()); } catch { payload = null; }
        if (payload) break;
      }
    }
    controller.abort();
    check('⑧ 工作联动：POST /speak 无客户端时排队，/events 连上即补发 speak',
      speak.status === 200 && speakDoc.ok === true && speakDoc.queued >= 1
        && payload && payload.type === 'speak' && payload.text === '提醒：该喝水了',
      `queued=${speakDoc.queued} · event=${payload && payload.type}:${payload && payload.text}`);
  } finally {
    await host.close();
  }
}

/* ── ⑤ 打断顺序：先停朗读再开录（运行时 + 源码）────────────────────────── */

{
  const factory = new Function(`${voiceSrc}; return { petVoiceInputCreate };`)().petVoiceInputCreate;
  const order = [];
  const api = factory({
    onBeforeRecord: () => { order.push('before'); },
    postRecord: async () => { order.push('record'); return { ok: false, code: 'no-device' }; },
    postChat: async () => { order.push('chat'); },
    onError: () => {},
  });
  await api.start();
  check('⑤ 录音一开始先调 onBeforeRecord（petSpeakStop），再 postRecord',
    order[0] === 'before' && order[1] === 'record', order.join(' → '));

  const wakeIdx = clientSrc.indexOf('function petChatWake()');
  const wakeBody = wakeIdx >= 0 ? clientSrc.slice(wakeIdx, wakeIdx + 500) : '';
  check('⑤ petChatWake 先 petSpeakStop()（点一下就打断），挂载提供 onBeforeRecord',
    /petSpeakStop\(\);\s*\n\s*void petChatRefreshVoice\(\)/.test(wakeBody)
      && /onBeforeRecord: \(\) => \{ petSpeakStop\(\); \}/.test(clientSrc),
    'wake 第一行 = petSpeakStop()');
  check('⑤ 打字入口也先 petSpeakStop()（新的一轮不叠音）',
    /const send = \(\) => \{[\s\S]{0,400}petSpeakStop\(\);[\s\S]{0,200}petVoiceIn\.postChat/.test(clientSrc));
}

/* ── ⑥ 分句 / 排队 / stop（假播放器 + 假 apiFetch）──────────────────────── */

const ttsModule = new Function(`${ttsClientSrc}; return { petTtsSplit, petTtsSentences, petTtsCreate };`)();
{
  const split = ttsModule.petTtsSplit('第一句。第二句！第三句？');
  check('⑥ petTtsSplit 按句切（3 句）', split.length === 3 && split[0].includes('第一句'),
    JSON.stringify(split));
  const streaming = ttsModule.petTtsSentences('第一句。第二');
  check('⑥ petTtsSentences 只把完整句交出去、尾巴留在 rest',
    streaming.sentences.length === 1 && streaming.sentences[0] === '第一句。' && streaming.rest === '第二',
    JSON.stringify(streaming));
}

function makeFakeAudio() {
  const audios = [];
  class FakeAudio {
    constructor(url) { this.url = url; this.played = false; this.paused = false; audios.push(this); }
    play() { this.played = true; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  return { FakeAudio, audios };
}

function makeFakeUrl() {
  let n = 0;
  return { createObjectURL: () => 'blob:' + (++n), revokeObjectURL: () => {} };
}

async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    // eslint-disable-next-line no-await-in-loop -- 轮询假播放器的异步状态
    await new Promise((resolveP) => { setTimeout(resolveP, 20); });
  }
  return false;
}

{
  const { FakeAudio, audios } = makeFakeAudio();
  const requests = [];
  const sentences = [];
  const states = [];
  const stops = [];
  const tts = ttsModule.petTtsCreate({
    apiFetch: async (url) => {
      requests.push(url);
      return { ok: true, status: 200, response: { blob: async () => ({ size: 12000 }) } };
    },
    apiPostJson: async (url) => { stops.push(url); return { ok: true, data: { ok: true } }; },
    Audio: FakeAudio,
    URL: makeFakeUrl(),
    getVoice: () => ({ name: 'Microsoft Huihui Desktop', muted: false, rate: 0 }),
    onSentence: (text) => sentences.push(text),
    onState: (kind) => states.push(kind),
    onError: () => {},
  });
  const queued = tts.speak('第一句。第二句！');
  const firstArrived = await waitFor(() => audios.length >= 1);
  audios[0].onended();
  const secondArrived = await waitFor(() => audios.length >= 2);
  audios[1].onended();
  await waitFor(() => tts.state().queued === 0 && !tts.state().playing);
  check('⑥ petSpeak 按句请求、顺序播放、句字幕与 speak 态都在',
    queued === true && firstArrived && secondArrived && requests.length >= 2
      && sentences.length === 2 && sentences[0].includes('第一句') && sentences[1].includes('第二句')
      && states.includes('speak'),
    `requests=${requests.length} sentences=${JSON.stringify(sentences)} states=${states.join(',')}`);

  const { FakeAudio: FakeAudio2, audios: audios2 } = makeFakeAudio();
  const errors2 = [];
  const stops2 = [];
  const tts2 = ttsModule.petTtsCreate({
    apiFetch: async () => ({ ok: true, status: 200, response: { blob: async () => ({ size: 12000 }) } }),
    apiPostJson: async (url) => { stops2.push(url); return { ok: true }; },
    Audio: FakeAudio2,
    URL: makeFakeUrl(),
    getVoice: () => ({ name: '', muted: false }),
    onSentence: () => {},
    onState: () => {},
    onError: (error) => errors2.push(error),
  });
  tts2.speak('甲。乙。丙。');
  await waitFor(() => audios2.length >= 1);
  tts2.stop();
  const stoppedState = tts2.state();
  const countAfterStop = audios2.length;
  await new Promise((resolveP) => { setTimeout(resolveP, 120); });
  check('⑥ stop：当前音频被 pause、队列清空、不会再冒出下一句、且通知宿主 /tts/stop',
    audios2[0].paused === true && stoppedState.queued === 0
      && audios2.length === countAfterStop && stops2.includes('/pet-chat/tts/stop'),
    `paused=${audios2[0].paused} queued=${stoppedState.queued} audios=${audios2.length} stops=${JSON.stringify(stops2)}`);

  const { FakeAudio: FakeAudio3 } = makeFakeAudio();
  const errors3 = [];
  const tts3 = ttsModule.petTtsCreate({
    apiFetch: async () => ({
      ok: false,
      status: 503,
      response: { json: async () => ({ ok: false, code: 'tts-unavailable', hint: '两跳都失败' }) },
    }),
    Audio: FakeAudio3,
    URL: makeFakeUrl(),
    getVoice: () => ({ muted: false }),
    onError: (error) => errors3.push(error),
  });
  tts3.speak('这句会失败。');
  await waitFor(() => errors3.length > 0);
  check('⑥ 宿主 503 ⇒ onError 带回原因（不静默、不弹窗）',
    errors3.length === 1 && errors3[0].code === 'tts-failed' && /两跳都失败/.test(String(errors3[0].hint || '')),
    JSON.stringify(errors3[0] || null));

  const mutedCalls = [];
  const tts4 = ttsModule.petTtsCreate({
    apiFetch: async (url) => { mutedCalls.push(url); return { ok: true }; },
    Audio: FakeAudio3,
    URL: makeFakeUrl(),
    getVoice: () => ({ muted: true }),
  });
  check('⑥ 静音时不请求合成、不播（speak 返回 false）', tts4.speak('别念。') === false && mutedCalls.length === 0);
}

/* ── ⑦ 气泡三态 + 波形 ───────────────────────────────────────────────────── */

{
  const bubbleFactory = new Function(`${bubbleSrc}; return { petBubbleCreate };`)().petBubbleCreate;
  const headChildren = [];
  const makeDoc = () => ({
    head: { appendChild: (node) => headChildren.push(node) },
    body: { appendChild: () => {} },
    createElement: () => ({
      style: {}, dataset: {}, textContent: '', className: '', children: [],
      setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {},
    }),
  });
  const bubble = bubbleFactory({
    document: makeDoc(),
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {},
    getAnchor: () => ({ left: 0, top: 100, width: 80, height: 80, scale: 1 }),
  });
  const seen = [];
  for (const state of ['listen', 'think', 'speak', 'idle']) {
    bubble.setState(state);
    seen.push(bubble.element.dataset.state);
  }
  const css = headChildren.map((node) => String(node.textContent || '')).join('\n');
  check('⑦ 气泡三态：listen / think / speak 都落在 data-state 上',
    seen[0] === 'listen' && seen[1] === 'think' && seen[2] === 'speak' && seen[3] === 'idle',
    seen.join(' → '));
  check('⑦ “说”时带简单波形（CSS 伪元素 + 动画；不弹窗、不加新组件）',
    /we-pet-bubble\[data-state="speak"\]::after/.test(css)
      && /@keyframes we-pet-bubble-wave/.test(css)
      && /currentColor/.test(css),
    `style 节点=${headChildren.length}`);
}

/* ── ⑧ 工作联动（客户端静态面）───────────────────────────────────────────── */

{
  check('⑧ 客户端暴露 speak 通道：window.__dshFoliaPet + we-pet-speak + EventSource',
    /window\.__dshFoliaPet\s*=\s*\{/.test(clientSrc)
      && /speak:\s*\(text, speech\)\s*=>\s*petSpeak/.test(clientSrc)
      && /we-pet-speak/.test(clientSrc)
      && /new EventSource\(/.test(clientSrc)
      && /petChatEventsStart\(\)/.test(clientSrc));
  check('⑧ 反向通道收 speak 后走 petSpeak（事件类型/文本都判）',
    /doc\.type !== 'speak'/.test(clientSrc) && /petSpeak\(String\(doc\.text\)/.test(clientSrc));
}

/* ── 汇总 ───────────────────────────────────────────────────────────────── */

try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter((item) => !item.ok);
console.log(`\n  ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
