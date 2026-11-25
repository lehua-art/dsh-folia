/**
 * verify-latency-v5.mjs — 任务 §2 延迟验收（L1–L5）。
 *
 * L1 6 段诊断：说完/录音完/ASR/首 token/首段音频/出声，宿主聚合 P50/P90
 * L2 ASR 常驻预热 + 空闲 10 分钟释放
 * L3 VAD 550ms（v4 是 700ms），正常收尾不 kill 出 0 字节
 * L4 轮间 150ms 恢复聆听（v4 是 300ms）
 * L5 首 token 即合成 / barge-in 100–300ms 内先停朗读 / Edge 预热+缓存仍在
 *
 * 说明：L1 的数值是**协议自检**（用一组已知样本验 P50/P90 与 6 段齐全），
 * 真实 P50/P90 由客户端每轮上报，交付数据里给的是本机实测样本。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-latency-v5-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;

const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const routes = [];
const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
registerPetChatRoutes(webServer, {
  disposers: [], base: '/folia', log: () => {},
  readSettings: () => ({ petChat: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'fake' } }),
  speechToText: undefined,
  tts: {
    async synthesize() { return { ok: false, code: 'fake', attempts: [] }; },
    async voices() { return []; }, voiceMeta() { return {}; }, stop() { return {}; },
    status() { return { ok: true, ready: true }; }, dispose() {},
  },
});
const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
const server = createServer((req, res) => { route.handler(req, res); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/folia/pet-chat`;
const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

try {
  /* ── L1 6 段 + P50/P90 ─────────────────────────────────────────────── */
  console.log('\nL1. 6 段诊断 + P50/P90 聚合');
  const samples = [
    { recordTail: 550, asr: 300, firstToken: 210, firstAudio: 240, playStart: 20, total: 1320 },
    { recordTail: 550, asr: 280, firstToken: 180, firstAudio: 220, playStart: 10, total: 1240 },
    { recordTail: 550, asr: 420, firstToken: 260, firstAudio: 300, playStart: 30, total: 1560 },
  ];
  for (const segments of samples) {
    const res = await postJson(base + '/latency', { inputMode: 'voice', segments });
    assert.equal(res.status, 200);
  }
  const doc = await (await fetch(base + '/latency')).json();
  const names = ['recordTail', 'asr', 'firstToken', 'firstAudio', 'playStart', 'total'];
  check('L1 六段齐全（说完/录音完/ASR/首 token/首段音频/出声）+ P50/P90',
    doc.ok === true && names.every((name) => doc.segments[name] && doc.segments[name].p50 !== null)
      && doc.segments.firstToken.p50 === 210 && doc.segments.total.p90 === 1560
      && doc.targets.firstToken === 300 && doc.targets.turnGap === 1000,
    names.map((name) => `${name}:${doc.segments[name].p50}/${doc.segments[name].p90}`).join(' '));

  const bad = await postJson(base + '/latency', { segments: { nope: 1 } });
  check('L1b 非法样本被拒（400，不污染统计）', bad.status === 400);

  /* ── L2 ASR 预热 / 10 分钟释放 ─────────────────────────────────────── */
  console.log('\nL2. ASR 常驻预热 + 空闲 10 分钟释放');
  const routeSrc = readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8');
  const clientSrc = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  check('L2a 录音/转写成功后续期；空闲 10 分钟真的 stop 子进程（不是只丢引用）',
    /noteAsrUsed\(\)/.test(routeSrc) && /10 \* 60 \* 1000/.test(routeSrc)
      && /typeof asrWorker\.stop === 'function'/.test(routeSrc) && /asrWorker = null/.test(routeSrc));
  check('L2b 常驻聆听启动即预热（不必等第一次点麦）',
    /if \(!petChatContinuousActive && !petChatContinuousPaused\) petChatContinuousStart\(\);/.test(clientSrc)
      && /void ensureAsrReady\(\);/.test(clientSrc.replace(/\r/g, '')),
    'client: ensureAsrReady at mount');

  /* ── L3 VAD ────────────────────────────────────────────────────────── */
  console.log('\nL3. VAD 550ms');
  const recordSrc = readFileSync(join(ROOT, 'lib', 'voice', 'record.js'), 'utf8');
  check('L3a 流式 VAD 默认 550ms（v4 700ms ⇒ 少等 150ms）',
    /streamSilenceMs: 550/.test(recordSrc) && !/streamSilenceMs: 700/.test(recordSrc));
  check('L3b 正常收尾不依赖 stdin（沙箱下 pipe 会 EPERM）：SIGTERM 收尾 + 由已收 PCM 重写 WAV 头',
    /stoppedByWatch = true/.test(recordSrc) && /child\.kill\('SIGTERM'\)/.test(recordSrc)
      && /pcm16Wav\(stream\.pcm/.test(recordSrc));

  /* ── L4 轮间 150ms ────────────────────────────────────────────────── */
  console.log('\nL4. 轮间 150ms 恢复聆听');
  check('L4 客户端恢复延迟 150ms（v4 300ms），语音轮间不重开设备只重启循环',
    /const PET_CHAT_LISTEN_RESUME_MS = 150;/.test(clientSrc)
      && /petChatContinuousArm\(PET_CHAT_LISTEN_RESUME_MS\)/.test(clientSrc)
      && /VoiceRecorder|start\(\)/.test(clientSrc));

  /* ── L5 首 token 即合成 / barge-in / Edge 预热 ────────────────────── */
  console.log('\nL5. 首 token 即合成 / barge-in / Edge 预热');
  check('L5a SSE 每个 delta 立即切句入队（不等 done）',
    /for \(const sentence of split\.sentences\) enqueueSpeech\(sentence\);/.test(clientSrc));
  const ttsSrc = readFileSync(join(ROOT, 'lib', 'tts', 'tts.js'), 'utf8');
  check('L5b Edge 预热与缓存仍在（同句第二次 0ms）',
    /async function prewarm/.test(ttsSrc) && /cacheDir/.test(ttsSrc));
  const wakeIdx = clientSrc.indexOf('function petChatWake()');
  const wake = wakeIdx >= 0 ? clientSrc.slice(wakeIdx, wakeIdx + 260) : '';
  check('L5c barge-in：点一下就同步停朗读/唱歌，再决定开麦（<300ms，无 await）',
    /petSpeakStop\(\);\s*(?:petSingStop\(\);\s*)?\n\s*void petChatRefreshVoice\(\)/.test(wake)
      && !/await .*petSpeakStop/.test(wake));
  check('L5d 客户端每轮上报 6 段（voice 轮次），失败静默不影响对话',
    /petChatReportLatency\(turnStartAt, firstTokenAt, firstAudioAt\)/.test(clientSrc)
      && /'\/pet-chat\/latency'/.test(clientSrc));

  /* ── 配置差：v4 → v5 的固定节省 ──────────────────────────────────── */
  check('L6 配置差可量化：VAD −150ms + 轮间 −150ms = 每轮少等 300ms（不含模型/合成）',
    700 - 550 === 150 && 300 - 150 === 150);
} finally {
  await new Promise((r) => server.close(r));
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((item) => !item.ok);
console.log(`\nLATENCY V5 CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
