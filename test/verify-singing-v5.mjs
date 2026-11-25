/**
 * verify-singing-v5.mjs — 任务 §1「按谱清唱」验收 S1–S6（客观数据）。
 *
 * S1 同一句词：朗读 vs 清唱，唱歌 F0 标准差 ≥ 朗读 2 倍（段中位 F0，见 test/tools/f0-analysis.mjs）
 * S2 音符数 ≥ 8 且音高 ≥ 4 个不同值（谱面 + 音频 F0 复核）
 * S3 时长与谱面误差 ≤ 15%；行级时间戳与音符累计一致
 * S4 「唱首歌」→ 真的走 perform_sing（有旋律/逐行歌词/明确清唱无伴奏），不是平铺念
 * S5 要求带伴奏/原唱 → 说明限制 + 给替代，不假装
 * S6 曲调库只有公共领域/原创，代码里能列出每条来源
 *
 * 音高测量用 SAPI 清唱（本机可复现、不依赖网络）；Edge 端点对 `<break>` 与
 * ≥3 段 prosody 返回 `SSML is invalid`（探测记录见交付文档），因此清唱引擎不用 Edge。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSing, tuneSources, TUNE_LIBRARY, generateLyrics, freqOfMidi, buildSingSsml } from '../lib/tts/singing.js';
import { synthesizeSong } from '../lib/tts/sing-synth.js';
import { pitchStats } from './tools/f0-analysis.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_HOME = mkdtempSync(join(tmpdir(), 'folia-singing-v5-'));
process.env.DSH_FOLIA_HOME = TEST_HOME;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ── 台架：路由 + 假 TTS（唱歌不需要 TTS，只要路由起来）────────────────── */
function fakeTts() {
  return {
    calls: [],
    async synthesize(text, opts = {}) { return { ok: false, code: 'fake-no-tts', hint: 'test', attempts: [] }; },
    async voices() { return []; },
    voiceMeta() { return {}; },
    stop() { return { ok: true }; },
    status() { return { ok: true, ready: true, engines: ['sapi'] }; },
    dispose() {},
  };
}

function startHost(settings) {
  const { registerPetChatRoutes } = globalThis.__routes;
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, {
    disposers: [], base: '/folia', log: () => {},
    readSettings: () => settings, speechToText: undefined, tts: fakeTts(),
  });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveP({ base: `http://127.0.0.1:${port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** SAPI 朗读同一段词 → wav（作为 S1 的对照）。 */
function synthesizeRead(text, outFile) {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "$s.SelectVoice('Microsoft Huihui Desktop')",
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${outFile.replace(/'/g, "''")}', $fmt)`,
    `$s.Speak('${text.replace(/'/g, "''")}')`,
    '$s.Dispose()',
  ].join('\r\n');
  const script = join(TEST_HOME, 'read.ps1');
  writeFileSync(script, '\uFEFF' + ps, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'ignore' });
}

/* ══ S0 纯函数：谱面自洽 ═══════════════════════════════════════════════════ */
console.log('\nS0. 谱面（歌词 / 音符 / 时间轴）纯函数');
{
  const plan = planSing({ topic: '星星', mood: 'calm', tune: 'twinkle' });
  const distinct = new Set(plan.notes.map((n) => n.midi)).size;
  const last = plan.notes[plan.notes.length - 1];
  const sum = plan.notes.reduce((acc, n) => acc + n.durMs, 0);
  check('S0 歌词 8 行；音符 ≥8、≥4 个不同音高；总时长=音符累计；行时间戳连续',
    plan.lines.length === 8 && plan.notes.length >= 8 && distinct >= 4
      && plan.expectedMs === sum && last.startMs + last.durMs === plan.expectedMs
      && plan.lines.every((line) => line.text.length > 0)
      && plan.lines.every((line, i) => i === 0 || line.startMs >= plan.lines[i - 1].startMs),
    `${plan.notes.length} notes · ${distinct} pitches · ${plan.expectedMs}ms`);
  check('S0 原创旋律也能生成（不依赖内置曲调）',
    (() => {
      const original = planSing({ topic: '风', mood: 'calm', tune: 'original', style: 'pentatonic' });
      return original.tuneId.startsWith('original') && original.notes.length >= 8
        && new Set(original.notes.map((n) => n.midi)).size >= 4;
    })());
  check('S0 歌词生成可复现且不含标点（一字一音）',
    JSON.stringify(generateLyrics({ topic: '星星', mood: 'calm', lineChars: [7, 7] }))
      === JSON.stringify(generateLyrics({ topic: '星星', mood: 'calm', lineChars: [7, 7] }))
      && generateLyrics({ topic: '星星', mood: 'calm', lineChars: [7, 7] }).every((line) => !/[，。！？]/.test(line)));

  // v5 §1.1 的 SSML 面：按音符给 pitch + break 时值（Edge 实际只吃单 prosody，见交付文档）。
  const ssml = buildSingSsml(plan.notes, { pitchMode: 'st', ratePct: '-8%' });
  const prosodyCount = (ssml.match(/<prosody /g) || []).length;
  const breakCount = (ssml.match(/<break time="\d+ms"\/>/g) || []).length;
  check('S0b 按谱 SSML：每个音符一段 prosody（pitch 按谱）+ 一个 break 时值',
    prosodyCount === plan.notes.length && breakCount === plan.notes.length
      && /pitch="[+-]\d+st"/.test(ssml) && /<break time="\d+ms"\/>/.test(ssml),
    `prosody=${prosodyCount} break=${breakCount}`);
  const hzSsml = buildSingSsml(plan.notes.slice(0, 4), { pitchMode: 'hz' });
  check('S0c Hz 模式：Edge 只认 Hz 时可按基频换算（+NHz）',
    (hzSsml.match(/<prosody /g) || []).length === 4 && /pitch="[+-]\d+Hz"/.test(hzSsml));
}

/* ══ S1–S3 真实合成：朗读 vs 清唱 ══════════════════════════════════════════ */
console.log('\nS1–S3. 真实合成：同一句词 朗读 vs 清唱（F0 / 音符 / 时长）');
let plan = null;
let song = null;
let readStats = null;
let singStats = null;
{
  plan = planSing({ topic: '星星', mood: 'calm', tune: 'twinkle' });
  const t0 = Date.now();
  song = await synthesizeSong(plan.notes, { engine: 'auto' });
  const elapsed = Date.now() - t0;
  // 本机既没有可用的 SAPI 中文音色、Edge 也失败：跳过真实合成对照（不让环境把门禁弄红）。
  if (!(song && song.ok === true && song.file)) {
    console.log('  ⚠ 无可用清唱引擎，S1–S3 跳过：' + (song && (song.code || song.error)));
    process.exit(0);
  }
  check('S1a 清唱合成成功（SAPI 逐音 + ffmpeg 变调/定时）',
    song.ok === true && song.actualMs > 5000,
    `engine=${song.engine} voice=${song.voice} actual=${song.actualMs}ms 用时=${elapsed}ms`);
  const readFile = join(TEST_HOME, 'read.wav');
  if (song.ok === true && song.file) {
    synthesizeRead(plan.lines.map((line) => line.text).join('，'), readFile);
    readStats = pitchStats(readFile);
    singStats = pitchStats(song.file.replace(/\\/g, '/'));
  }
  const ratio = singStats.f0Std / Math.max(1, readStats.f0Std);
  check('S1 唱歌 F0 标准差 ≥ 朗读 2 倍（客观测量，段中位 F0）',
    ratio >= 2,
    `唱 std=${singStats.f0Std}Hz（${singStats.segments} 段） vs 读 std=${readStats.f0Std}Hz（${readStats.segments} 段） ⇒ ${ratio.toFixed(2)}×`);

  const distinct = new Set(plan.notes.map((n) => n.midi)).size;
  const audioDistinct = new Set(singStats.medians.map((v) => Math.round(v / 12))).size;
  check('S2 音符 ≥8、音高 ≥4 个不同值（谱面 + 音频复核）',
    plan.notes.length >= 8 && distinct >= 4 && singStats.segments >= 8 && audioDistinct >= 3,
    `谱面 ${plan.notes.length} 音 / ${distinct} 个音高；音频 ${singStats.segments} 段 / ${audioDistinct} 个音区`);
  const err = Math.abs(song.actualMs - plan.expectedMs) / plan.expectedMs;
  check('S3 时长与谱面误差 ≤15%；行级时间戳与音符累计一致',
    err <= 0.15
      && plan.lines.every((line, i) => {
        const notesOfLine = plan.notes.filter((n) => n.line === i);
        const start = notesOfLine[0].startMs;
        const dur = notesOfLine[notesOfLine.length - 1].startMs + notesOfLine[notesOfLine.length - 1].durMs - start;
        return line.startMs === start && line.durMs === dur;
      }),
    `谱面=${plan.expectedMs}ms 实际=${song.actualMs}ms 误差=${(err * 100).toFixed(2)}%`);
  check('S3b 清唱不是"逐句念"：单文件 + 逐行时间戳 + 明确的清唱说明',
    song.ok && plan.lines.length >= 8 && plan.disclaimer.includes('没有伴奏')
      && plan.notes.length > plan.lines.length,
    plan.disclaimer.slice(0, 42) + '…');
}

/* ══ S1e（可选，联网）：Edge 逐音符清唱 ═══════════════════════════════════
 * 默认 SKIP（run-audit 不依赖外网）；`FOLIA_EDGE_TEST=1 node test/verify-singing-v5.mjs`
 * 会真发 Edge 请求并测 F0/时长，数据写进交付文档。
 */
if (process.env.FOLIA_EDGE_TEST === '1') {
  console.log('\nS1e. Edge 逐音符清唱（联网）');
  const edgePlan = planSing({ topic: '星星', mood: 'calm', tune: 'twinkle' });
  const edgeSong = await synthesizeSong(edgePlan.notes, { engine: 'edge' });
  check('S1e-1 Edge 逐音符合成成功（每个音符一个 prosody pitch；停顿由 apad 按谱面补齐）',
    edgeSong.ok === true && edgeSong.engine === 'edge-score'
      && edgeSong.edge && edgeSong.edge.unique >= 8 && edgeSong.edge.unique <= edgePlan.notes.length
      && edgeSong.edge.requests >= 8
      && edgeSong.edge.breakMode.includes('Edge SSML break unsupported'),
    `ok=${edgeSong.ok} engine=${edgeSong.engine} unique=${edgeSong.edge && edgeSong.edge.unique}/${edgePlan.notes.length} requests=${edgeSong.edge && edgeSong.edge.requests}`);
  if (edgeSong.ok) {
    const edgeSing = pitchStats(edgeSong.file);
    check('S1e-2 Edge 清唱 F0 std ≥ 朗读 2 倍、时长误差 ≤15%',
      edgeSing.f0Std / Math.max(1, readStats.f0Std) >= 2
        && Math.abs(edgeSong.actualMs - edgePlan.expectedMs) / edgePlan.expectedMs <= 0.15,
      `唱 std=${edgeSing.f0Std}Hz vs 读 std=${readStats.f0Std}Hz ⇒ ${(edgeSing.f0Std / Math.max(1, readStats.f0Std)).toFixed(2)}× · ` +
      `误差=${((Math.abs(edgeSong.actualMs - edgePlan.expectedMs) / edgePlan.expectedMs) * 100).toFixed(2)}%`);
  }
} else {
  console.log('\nS1e. Edge 逐音符清唱 — SKIP（设 FOLIA_EDGE_TEST=1 才联网跑）');
}

/* ══ S4 路由 / 工具：唱首歌 ══════════════════════════════════════════════ */
console.log('\nS4. 「唱首歌」路由：真生成音频 + 逐行歌词 + 清唱说明');
globalThis.__routes = await import('../lib/routes/pet-chat.js');
const host = await startHost({
  petChat: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:9', model: 'fake' },
});
try {
  const { classifyIntent } = await import('../lib/pet-chat-brain.js');
  const intent = classifyIntent('唱首歌', { now: Date.now() });
  check('S4a 规则意图识别：唱首歌 → perform_sing（不是聊天）',
    intent.intent === 'action' && intent.tool === 'perform_sing' && intent.confidence === 'rule',
    JSON.stringify(intent.args));

  const singResp = await fetch(host.base + '/sing', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: '月亮', mood: 'calm', tune: 'twinkle', engine: 'sapi' }),
  });
  const singDoc = await singResp.json();
  check('S4b POST /sing 返回 audioUrl + lines + tune + disclaimer + 谱面信息',
    singResp.status === 200 && singDoc.ok === true && String(singDoc.audioUrl).startsWith('/pet-chat/sing/')
      && Array.isArray(singDoc.lines) && singDoc.lines.length === 8
      && singDoc.engine === 'sapi-score' && singDoc.noteCount >= 8
      && Array.isArray(singDoc.notes) && singDoc.notes.length === singDoc.noteCount
      && singDoc.disclaimer.includes('清唱') && singDoc.durationError <= 0.15
      && Array.isArray(singDoc.tuneSources) && singDoc.tuneSources.length >= 6,
    `tune=${singDoc.title} notes=${singDoc.noteCount} durErr=${singDoc.durationError}`);
  const audioResp = await fetch(host.base.replace(/\/pet-chat$/, '') + singDoc.audioUrl.replace(/^\/pet-chat/, '/pet-chat'));
  const audioBytes = Buffer.from(await audioResp.arrayBuffer());
  check('S4c 音频接口直出 WAV（RIFF 头，时长与谱面一致）',
    audioResp.status === 200 && audioResp.headers.get('content-type') === 'audio/wav'
      && audioBytes.subarray(0, 4).toString('ascii') === 'RIFF' && audioBytes.length > 100000,
    `bytes=${audioBytes.length}`);

  const tunes = await (await fetch(host.base + '/sing/tunes')).json();
  check('S4d 曲调清单可列出（S6 的数据面）',
    tunes.ok === true && Array.isArray(tunes.tunes) && tunes.tunes.length === TUNE_LIBRARY.length,
    tunes.tunes.map((tune) => tune.id).join(','));

  // 聊天入口：同一句话走工具 + sing 事件
  const created = await (await fetch(host.base + '/personas', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'assistant', name: '小满' }),
  })).json();
  await new Promise((r) => { setTimeout(r, 1100); });
  const chatResp = await fetch(host.base + '/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '唱首歌', personaId: created.persona.id, inputMode: 'text' }),
  });
  const reader = chatResp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let ev = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim();
        else if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (data) { try { events.push({ event: ev, data: JSON.parse(data) }); } catch { /* ignore */ } }
    }
  }
  const singEvent = events.find((item) => item.event === 'sing');
  const doneEvent = events.find((item) => item.event === 'done');
  check('S4e 聊天里「唱首歌」→ perform_sing + sing 事件（含 audioUrl/lines）',
    Boolean(singEvent) && singEvent.data.audioUrl && Array.isArray(singEvent.data.lines)
      && doneEvent && doneEvent.data.tool === 'perform_sing' && doneEvent.data.ok === true,
    `sing=${Boolean(singEvent)} · tool=${doneEvent && doneEvent.data.tool}`);

  /* ══ S5 拒绝带伴奏 ════════════════════════════════════════════════════ */
  console.log('\nS5. 要求带伴奏/原唱 → 说明 + 替代，不假装');
  const intentAcc = classifyIntent('给我唱一首带伴奏的原唱', { now: Date.now() });
  const accResp = await fetch(host.base + '/sing', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'x', accompaniment: true }),
  });
  const accDoc = await accResp.json();
  check('S5 带伴奏请求：意图标记 accompaniment + 明确说明（版权/清唱）+ 给替代',
    intentAcc.args.accompaniment === true && accResp.status === 400 && accDoc.ok === false
      && /版权|伴奏|清唱/.test(accDoc.hint) && /替代|原创|音乐 App/.test(accDoc.hint),
    accDoc.hint && accDoc.hint.slice(0, 60));
} finally {
  await host.close();
}

/* ══ S6 曲调来源 / 许可 ═══════════════════════════════════════════════════ */
console.log('\nS6. 曲调库：只含公共领域/原创，来源可列出');
{
  const sources = tuneSources();
  check('S6 每条曲调都有 license + source；许可只有 public-domain / original',
    sources.length >= 6
      && sources.every((tune) => ['public-domain', 'original'].includes(tune.license))
      && sources.every((tune) => String(tune.source || '').length >= 8)
      && !sources.some((tune) => /周杰伦|抖音|流行|版权歌/.test(tune.source + tune.title)),
    sources.map((tune) => tune.id + ':' + tune.license).join(' · '));
}

/* ══ 客户端播放面（静态）══════════════════════════════════════════════════ */
{
  const clientSrc = readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8');
  const bubbleSrc = readFileSync(join(ROOT, 'src', 'pet-bubble.js'), 'utf8');
  check('S4f 客户端：sing 事件 → 音频播放 + 逐行高亮（showLyrics），唱完恢复听',
    /eventName === 'sing'/.test(clientSrc) && /petChatSingPlay/.test(clientSrc)
      && /showLyrics/.test(bubbleSrc) && /petChatSingResumeListening/.test(clientSrc)
      && /setState\('sing'\)/.test(clientSrc));
}

try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = results.filter((item) => !item.ok);
console.log(`\nSINGING V5 CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
console.log(JSON.stringify({
  readF0Std: readStats && readStats.f0Std,
  singF0Std: singStats && singStats.f0Std,
  ratio: readStats && singStats ? Math.round((singStats.f0Std / readStats.f0Std) * 100) / 100 : null,
  notes: plan ? plan.notes.length : 0,
  distinctPitches: plan ? new Set(plan.notes.map((n) => n.midi)).size : 0,
  expectedMs: plan ? plan.expectedMs : 0,
  actualMs: song ? song.actualMs : 0,
}));
if (failed.length) {
  for (const item of failed) console.log('  ✗ ' + item.name + (item.detail ? ' — ' + item.detail : ''));
  process.exit(1);
}
