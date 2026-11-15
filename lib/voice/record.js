/**
 * voice/record.js — 宿主侧录音（v0.1 语音输入）。
 *
 * 为什么不在前端录：DSH 的 Electron 只放行 clipboard/notifications 权限，
 * `getUserMedia` 一律被拒且没有弹窗 ⇒ 前端录音必然失败（工单「追加决定 3」）。
 * 所以改成宿主用 ffmpeg 的 dshow 抓麦克风，前端只负责"点一下、等结果"。
 *
 * 依赖注入（判据用假 runFfmpeg，不需要真麦克风）：
 *   resolveFfmpeg(job) → Promise<string>   来自 lib/media/transcode.js
 *   runFfmpeg(ff, args, timeoutMs) → Promise<{ code, stderr }>
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 默认参数（pre.57：听清优先，宁慢一点也要采到完整句子）。 */
export const RECORD_DEFAULTS = Object.freeze({
  maxMs: 15000,
  silenceDb: -40,
  silenceMs: 1000,
  minSpeechMs: 500,
  onsetWaitMs: 8000,
  sampleRate: 16000,
  probeMs: 0, // probe only ranks, default off (silent probe must never reject a device)
  /** 1 秒探测阈值（约 -48 dBFS）：低于它视为“这个设备没信号”。 */
  probeMinRms: 0.004,
  /** 整段录音阈值（约 -38 dBFS）：太低先提示“太小声”，不送 ASR。 */
  minSpeechRms: 0.012,
});

/** 采集滤镜链：去低频轰鸣/高频嘶声/底噪，再把小音量拉平。 */
export const VOICE_FILTER_CHAIN = 'highpass=f=80,lowpass=f=8000,afftdn=nf=-25,dynaudnorm=f=150:g=15';

/** 读 16-bit PCM WAV 的 RMS（0..1）；读不到/不是 PCM16 返回 null（未知，不当成静音）。 */
export function wavRms(file) {
  try {
    const buf = readFileSync(file);
    if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
    let pos = 12;
    let fmt = null;
    let data = null;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      const body = pos + 8;
      if (id === 'fmt ') {
        fmt = {
          channels: buf.readUInt16LE(body + 2),
          bits: buf.readUInt16LE(body + 14),
        };
      } else if (id === 'data') {
        data = buf.subarray(body, Math.min(body + size, buf.length));
      }
      pos = body + size + (size % 2);
    }
    if (!fmt || !data || fmt.bits !== 16 || !fmt.channels) return null;
    const frames = Math.floor(data.length / (2 * fmt.channels));
    if (!frames) return null;
    let sum = 0;
    for (let i = 0; i < frames; i += 1) {
      const sample = data.readInt16LE(i * 2 * fmt.channels) / 32768;
      sum += sample * sample;
    }
    return Math.sqrt(sum / frames);
  } catch { return null; }
}

/** stderr 末尾几行（诊断用）。 */
function stderrTailOf(text) {
  return String(text || '').trim().split(/\r?\n/).slice(-4).join(' | ').slice(0, 400);
}

export function rmsToDb(rms) {
  const n = Number(rms);
  if (!Number.isFinite(n) || n <= 0) return -Infinity;
  return Math.round(20 * Math.log10(n) * 10) / 10;
}

/**
 * 从 ffmpeg `-list_devices` 的 stderr 里解析音频设备名。
 *
 * 两种输出格式都要认（实测两代 ffmpeg 不一样）：
 *   ① 老式分段：`DirectShow audio devices` … `"麦克风"` … `DirectShow video devices`
 *   ② 新式带类型：`[dshow @ …] "麦克风 (C-Media(R) Audio)" (audio)`
 *      —— 本仓自带的 ffmpeg 就是这种，**没有** "DirectShow audio devices" 字样，
 *         只按 ① 解析会得到空列表 ⇒ /record 恒回 no-device（真机踩过）。
 * `Alternative name` 行同样是引号包裹，但它不是设备名，必须排除。
 */
export function parseDevices(stderr) {
  const text = String(stderr || '');
  const devices = [];
  const seen = new Set();
  const push = (name) => {
    const clean = String(name || '').trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    devices.push(clean);
  };

  // ② 新式：`[dshow @ …] "设备名" (audio|video)` —— 只收 audio
  const typed = /\[dshow[^\]]*\]\s+"([^"]+)"\s+\((audio|video)\)/gi;
  let m;
  while ((m = typed.exec(text)) !== null) {
    if (m[2].toLowerCase() === 'audio') push(m[1]);
  }
  if (devices.length) return devices;

  // ① 老式：先截出 audio 段，再取引号内容（排除 Alternative name）
  const audioStart = text.search(/DirectShow audio devices/i);
  if (audioStart < 0) return [];
  const section = text.slice(audioStart);
  const end = section.search(/DirectShow video devices/i);
  const body = end >= 0 ? section.slice(0, end) : section;
  const pattern = /^\s*(?:\[[^\]]*\]\s*)?"([^"]+)"/gm;
  while ((m = pattern.exec(body)) !== null) push(m[1]);
  return devices;
}

/** 优先含 Microphone/麦克风/USB 的设备，否则第一个。 */
export function pickDevice(devices) {
  const list = Array.isArray(devices) ? devices.filter(Boolean) : [];
  if (!list.length) return null;
  const preferred = list.find((name) => /microphone|麦克风|usb/i.test(name));
  return preferred || list[0];
}

/**
 * 从 silencedetect 的 stderr 判断"说完了"：
 * 先出现 silence_end（用户开口），之后又出现 silence_start（停下来了）⇒ 结束。
 */
export function detectSpeechEnd(stderr) {
  const text = String(stderr || '');
  const ends = [...text.matchAll(/silence_end:\s*([0-9.]+)/g)];
  const starts = [...text.matchAll(/silence_start:\s*([0-9.]+)/g)];
  if (!ends.length || !starts.length) return null;
  const lastEnd = Number(ends[ends.length - 1][1]);
  const startAfter = starts.map((m) => Number(m[1])).find((value) => value >= lastEnd);
  return startAfter == null ? null : { speechEnd: lastEnd, silenceStart: startAfter };
}

/**
 * 从 silencedetect 的 stderr 判断"**可以自动停机**了"：
 * 与 `detectSpeechEnd` 的区别是它覆盖「一开口就说话、没有前导静音」的场景 ——
 * 那种录音的日志里只有 `silence_start`、没有前置 `silence_end`，只按前者会永远停不下来。
 *
 * 判据（返回 null = 还不能停）：
 *   · 最后一个事件必须是 `silence_start`（正在静音）；
 *   · 它之前出现过 `silence_end`（说过话又停了），或者 `silence_start` 的时间点已经晚于
 *     `minSpeechMs`（从录音开始就在说话，然后停了）；
 *   · `readyAtMs` = 静音起点 + silenceMs + 120ms 余量，调用方用墙钟比对这个点。
 */
export function detectAutoStop(stderr, options = {}) {
  const silenceMs = Number(options.silenceMs) || RECORD_DEFAULTS.silenceMs;
  const minSpeechMs = Number.isFinite(options.minSpeechMs) ? options.minSpeechMs : RECORD_DEFAULTS.minSpeechMs;
  const text = String(stderr || '');
  const events = [];
  for (const match of text.matchAll(/silence_(start|end):\s*([0-9.]+)/g)) {
    events.push({ kind: match[1], at: Number(match[2]) });
  }
  if (!events.length) return null;
  const last = events[events.length - 1];
  if (last.kind !== 'start') return null;
  const hadSpeech = events.some((event) => event.kind === 'end') || last.at * 1000 >= minSpeechMs;
  if (!hadSpeech) return null;
  return {
    silenceStart: last.at,
    silenceMs,
    speechEnd: last.at,
    readyAtMs: Math.round(last.at * 1000 + silenceMs + 120),
  };
}

/** 生成 dshow 输入参数（Windows）；其它平台没有 dshow，直接报 no-device。 */
export function dshowArgs(device, options = {}) {
  const opts = { ...RECORD_DEFAULTS, ...options };
  // 路由会把没传的参数显式传成 undefined：
  // { ...DEFAULTS, ...{ maxMs: undefined } } 会把默认值覆盖成 undefined，
  // 接着 timeoutMs = NaN ⇒ setTimeout(NaN) 立刻触发 ⇒ /record 0.2s 就回“录音超时”。
  // 这里逐项兜底成默认值（0 是合法值，只认真正的非数字）。
  for (const key of ['maxMs', 'silenceDb', 'silenceMs', 'sampleRate', 'minSpeechMs', 'onsetWaitMs']) {
    const n = Number(opts[key]);
    if (!Number.isFinite(n) || n <= 0) opts[key] = RECORD_DEFAULTS[key];
  }
  return [
    '-hide_banner', '-y',
    '-f', 'dshow', '-i', `audio=${device}`,
    '-t', String(Math.ceil(opts.maxMs / 1000) + 5),
    '-ar', String(opts.sampleRate), '-ac', '1',
    '-af', `${VOICE_FILTER_CHAIN},silencedetect=noise=${opts.silenceDb}dB:d=${opts.silenceMs / 1000}`,
  ];
}

/** 每个设备先录 1 秒（不加重滤镜）测 RMS；只用来选设备，不算正式录音。 */
export function probeArgs(device, options = {}) {
  const opts = { ...RECORD_DEFAULTS, ...options };
  const seconds = Math.max(0.3, Math.min(3, Number(opts.probeMs) / 1000 || 1));
  return [
    '-hide_banner', '-y',
    '-f', 'dshow', '-i', `audio=${device}`,
    '-t', String(seconds),
    '-ar', '16000', '-ac', '1',
  ];
}

export function createVoiceRecorder(deps) {
  const { resolveFfmpeg, runFfmpeg } = deps || {};
  const probeSize = typeof deps.probeSize === 'function' ? deps.probeSize : (path) => { try { return statSync(path).size; } catch { return 0; } };

  async function listDevices() {
    const ff = await resolveFfmpeg(null);
    const result = await runFfmpeg(ff, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 8000);
    return parseDevices(result && result.stderr);
  }

  /** 录 1 秒测 RMS；读不到 WAV 时回 unknown（不能把测试注入/异常环境判成没信号）。 */
  async function probeDevice(device, options) {
    const dir = mkdtempSync(join(tmpdir(), 'folia-voice-probe-'));
    const file = join(dir, 'probe.wav');
    try {
      const ff = await resolveFfmpeg(null);
      const result = await runFfmpeg(ff, [...probeArgs(device, options), file], 6000);
      if (!result || (result.code !== 0 && result.code !== null)) return { device, rms: null, unknown: true };
      const rms = wavRms(file);
      return { device, rms, unknown: rms === null };
    } catch {
      return { device, rms: null, unknown: true };
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

/**
 * 录一段。失败也保留 wav 供回放（用户能听见自己）。
 * 纪律：绝不拿"探测静音"当拒绝理由；探测默认关闭，只用于排序。
 */
async function record(options = {}) {
  const opts = { ...RECORD_DEFAULTS, ...options };

  // 路由会把没传的参数显式传成 undefined；逐项兜底，避免 timeout=NaN。
  for (const key of ['maxMs', 'silenceDb', 'silenceMs', 'sampleRate', 'minSpeechMs', 'onsetWaitMs', 'probeMs']) {
    const n = Number(opts[key]);
    if (!Number.isFinite(n) || n < 0) opts[key] = RECORD_DEFAULTS[key];
  }
  if (process.platform !== 'win32') return { ok: false, code: 'unsupported-platform' };
  let devices;
  try {
    devices = await listDevices();
  } catch {
    return { ok: false, code: 'ffmpeg-missing' };
  }
  const preferred = pickDevice(devices);
  if (!preferred) return { ok: false, code: 'no-device' };

  // 探测只用于排序，且默认关闭（probeMs=0）。
  // 用户是"点完才开口"，探测那 1 秒通常是静音，绝不能据此判定没有麦克风。
  let rankedDevices = [preferred, ...devices.filter((d) => d !== preferred)];
  const probes = [];
  if (opts.probeMs > 0) {
    for (const device of devices) {
      probes.push(await probeDevice(device, opts)); // eslint-disable-line no-await-in-loop
    }
    const measured = probes.filter((item) => !item.unknown);
    const signaled = measured
      .filter((item) => item.rms >= opts.probeMinRms)
      .sort((a, b) => b.rms - a.rms)
      .map((item) => item.device);
    rankedDevices = [...new Set([...signaled, preferred, ...devices])];
  }
  const candidates = rankedDevices.slice(0, 4);
  const attempts = [];
  let lastCode = 'no-speech';
  let kept = null; // 最近一次失败但保留的录音（供回放）
  const dropKept = () => {
    if (!kept) return;
    try { rmSync(kept.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    kept = null;
  };

  for (const device of candidates) {
    const dir = mkdtempSync(join(tmpdir(), 'folia-voice-'));
    const audioPath = join(dir, 'input.wav');
    const startedAt = Date.now();
    let result;
    let usedPlain = false;
    let watchStopped = false;
    let interrupted = false;
    try {
      const ff = await resolveFfmpeg(null);
      const watch = {
        stopOnSpeechEnd: { silenceMs: opts.silenceMs, minSpeechMs: opts.minSpeechMs },
        onsetWaitMs: opts.onsetWaitMs,
      };
      result = await runFfmpeg(ff, [...dshowArgs(device, opts), audioPath], opts.maxMs + 8000, watch);
      watchStopped = Boolean(result && result.stoppedByWatch);
      interrupted = watchStopped || Boolean(result && (result.timedOut === true || result.signal === 'SIGTERM'));
      if (result && result.code !== 0 && !interrupted) {
        const args = dshowArgs(device, opts);
        const cut = args.indexOf('-af');
        const plain = cut >= 0 ? args.slice(0, cut).concat(args.slice(cut + 2)) : args;
        const retry = await runFfmpeg(ff, [...plain, audioPath], opts.maxMs + 8000);
        if (retry && retry.code === 0) { result = retry; usedPlain = true; }
      }
    } catch {
      rmSync(dir, { recursive: true, force: true });
      attempts.push({ device, code: 'ffmpeg-missing' });
      lastCode = 'ffmpeg-missing';
      continue;
    }
    const ms = Date.now() - startedAt;
    const stderr = String((result && result.stderr) || '');
    const bytes = probeSize(audioPath) || 0;
    const audioRms = wavRms(audioPath);
    const diag = {
      device,
      ms,
      bytes,
      audioRms: audioRms === null ? null : Math.round(audioRms * 10000) / 10000,
      audioDb: rmsToDb(audioRms),
      ffmpegExit: result ? result.code : null,
      timedOut: Boolean(result && result.timedOut),
      signal: (result && result.signal) || '',
      noOnset: Boolean(result && result.noOnset === true),
      stderrTail: stderrTailOf(stderr),
    };
    // 只有"设备打不开"才算 no-device/open-failed；与静音无关。
    if (result && result.code !== 0 && !interrupted && bytes < 1024) {
      rmSync(dir, { recursive: true, force: true });
      attempts.push({ ...diag, code: 'open-failed' });
      lastCode = 'open-failed';
      continue;
    }
    if (result && result.noOnset === true) {
      dropKept();
      kept = { dir, audioPath, ...diag };
      attempts.push({ ...diag, code: 'no-speech' });
      lastCode = 'no-speech';
      continue;
    }
    if (!bytes || bytes < 1024) {
      rmSync(dir, { recursive: true, force: true });
      attempts.push({ ...diag, code: 'open-failed' });
      lastCode = 'open-failed';
      continue;
    }
    let ended = detectSpeechEnd(stderr);
    if (!ended && interrupted) {
      ended = {
        speechEnd: Number(result && result.speechEnd) || Number((ms / 1000).toFixed(2)),
        auto: true,
        signal: (result && result.signal) || '',
      };
    }
    if (!ended && usedPlain) ended = { speechEnd: opts.maxMs / 1000 };
    if (!ended) {
      dropKept();
      kept = { dir, audioPath, ...diag };
      attempts.push({ ...diag, code: 'no-speech' });
      lastCode = 'no-speech';
      continue;
    }
    // 太小声不再直接拒绝：保留录音，返回 too-quiet 让界面提示并允许回放/重试。
    if (audioRms !== null && audioRms < opts.minSpeechRms) {
      dropKept();
      kept = { dir, audioPath, ...diag };
      attempts.push({ ...diag, code: 'too-quiet' });
      lastCode = 'too-quiet';
      continue;
    }
    dropKept();
    return {
      ok: true,
      audioPath,
      dir,
      ms,
      device,
      bytes,
      speech: ended,
      audioSeconds: Number((ended.speechEnd || 0).toFixed(2)),
      audioRms: diag.audioRms,
      audioDb: diag.audioDb,
      attempts,
    };
  }
  return {
    ok: false,
    code: lastCode,
    hint: lastCode === 'too-quiet'
      ? '声音太小了：靠近麦克风（30–50cm）再说一次，或先点「测试麦克风」听听录音'
      : (lastCode === 'open-failed' ? '麦克风打不开：可能被其它程序占用，或设备已禁用' : '没听到声音，再说一次'),
    attempts,
    devices,
    lastWav: kept ? kept.audioPath : null,
    lastWavBytes: kept ? kept.bytes : 0,
    lastWavRms: kept ? kept.audioRms : null,
  };
}

/** 固定时长原声录制（麦克风测试用）：不跑 VAD，录完就返回。 */
async function recordFixed(ms = 3000) {
  if (process.platform !== 'win32') return { ok: false, code: 'unsupported-platform' };
  let devices;
  try { devices = await listDevices(); } catch { return { ok: false, code: 'ffmpeg-missing' }; }
  const device = pickDevice(devices);
  if (!device) return { ok: false, code: 'no-device' };
  const dir = mkdtempSync(join(tmpdir(), 'folia-mictest-'));
  const audioPath = join(dir, 'mic-test.wav');
  try {
    const ff = await resolveFfmpeg(null);
    const args = dshowArgs(device, { maxMs: ms, silenceDb: -60, silenceMs: 1 });
    const cut = args.indexOf('-af');
    const plain = cut >= 0 ? args.slice(0, cut).concat(args.slice(cut + 2)) : args;
    const result = await runFfmpeg(ff, [...plain, audioPath], ms + 8000);
    const bytes = probeSize(audioPath) || 0;
    const rms = wavRms(audioPath);
    return {
      ok: Boolean(result && result.code === 0 && bytes > 1024),
      code: result && result.code === 0 ? null : 'open-failed',
      audioPath,
      dir,
      device,
      bytes,
      audioRms: rms === null ? null : Math.round(rms * 10000) / 10000,
      audioDb: rmsToDb(rms),
      stderrTail: stderrTailOf(String((result && result.stderr) || '')),
    };
  } catch (error) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, code: 'ffmpeg-missing', error: String((error && error.message) || error) };
  }
}
  return { listDevices, record, recordFixed };
}

/**
 * 默认 ffmpeg 解析：环境变量 → 本地缓存（~/.dsh-folia/ffmpeg/ffmpeg.exe，用户已有 77MB 那个）
 * → 系统 PATH。**不触发下载**（工单要求复用现有资产）。
 */
export async function defaultResolveFfmpeg() {
  const env = process.env.DSH_FOLIA_FFMPEG;
  if (env && env.trim()) return env.trim();
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const { existsSync } = await import('node:fs');
  const candidates = [
    join(process.env.USERPROFILE || process.env.HOME || '', '.dsh-folia', 'ffmpeg', exe),
    join(process.env.APPDATA || '', 'dsh-desktop', 'ffmpeg', exe),
  ];
  for (const p of candidates) { if (p && existsSync(p)) return p; }
  // 交给 PATH：调用方会用 spawn 试一次，ENOENT 时会明确回 ffmpeg-missing
  return exe;
}

/**
 * 默认执行器：spawn + 收集 stderr（silencedetect 的输出在这里），超时强杀。
 *
 * **自动停机（VAD）**：`options.stopOnSpeechEnd = { silenceMs }` 时，边录边轮询 stderr 文件；
 * 一旦 `detectAutoStop` 判定“说完了”，就往 ffmpeg 的 stdin 写 `q\n` —— ffmpeg 收到 `q`
 * 会**优雅退出并补好 WAV 头**（实测：直接 kill 会留下 0 字节/半截文件，浏览器放不出来）。
 * 这就是“说完自动停”的实现点；不轮询时行为与旧版逐字相同。
 *
 * 关键：**stderr 不能走 pipe**。
 * dsh web 跑在 Electron 主进程里，这个受约束的 spawn 上下文里 piped stdio 会失败
 * （本仓 transcode.js 记录过同一现象：piped stdio EPERM / 子进程启动即死），
 * 表现为 ffmpeg 立刻退出 ⇒ record() 误判成 no-device / timeout。
 * 因此 stderr 重定向到临时文件，等进程结束后再读回来解析 silencedetect。
 */
export function defaultRunFfmpeg(ff, args, timeoutMs = 30000, options = {}) {
  const watch = options && options.stopOnSpeechEnd ? options.stopOnSpeechEnd : null;
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const errFile = join(tmpdir(), 'folia-ffmpeg-' + process.pid + '-' + Date.now() + '.log');
    let fd = null;
    try { fd = openSync(errFile, 'w'); } catch { fd = null; }
    const child = spawn(ff, args, {
      windowsHide: true,
      detached: true,
      // stdin/stdout/stderr 一律**不走管道**：DSH 沙箱下 spawn 开 pipe 会 EPERM
      //（实测 /record 恒 no-device）。stderr 走临时文件，自动停机用 SIGTERM。
      stdio: ['ignore', 'ignore', fd === null ? 'ignore' : fd],
    });
    let settled = false;
    let stoppedByWatch = false;
    let speechEnd = 0;
    let poll = null;
    let stopSent = false;
    let timedOut = false;
    let noOnset = false;
    const requestStop = () => {
      if (stopSent) return;
      stopSent = true;
      // 用 SIGTERM 结束（不依赖 stdin 管道）；ffmpeg 被信号结束时通常 code!=0，
      // 由 `stoppedByWatch=true` 在 record() 里认成成功。
      // pid 落地才 kill：未起来时裸 kill 会让事件循环挂死（verify-child-kill 的同一条判据）。
      try { if (child.pid !== undefined) child.kill('SIGTERM'); } catch { /* 已退出 */ }
    };
    if (watch) {
      poll = setInterval(() => {
        if (settled || stopSent) return;
        let text;
        try { text = readFileSync(errFile, 'utf8'); } catch { return; }
        const decided = detectAutoStop(text, { silenceMs: watch.silenceMs, minSpeechMs: watch.minSpeechMs });
        if (!decided) {
          // 开口等待：8 秒内既没说完一句、也没有任何语音结束事件 ⇒ 当作没开口，
          // 不再干录到 15 秒。已经有 silence_start（正在静音）时交给 detectAutoStop 判断。
          const onsetWaitMs = Math.max(1000, Number(options.onsetWaitMs) || RECORD_DEFAULTS.onsetWaitMs);
          if (Date.now() - startedAt >= onsetWaitMs && !/silence_end:/.test(text)) {
            noOnset = true;
            requestStop();
          }
          return;
        }
        if (Date.now() - startedAt < decided.readyAtMs) return;
        stoppedByWatch = true;
        speechEnd = decided.speechEnd;
        requestStop();
      }, 120);
      if (typeof poll.unref === 'function') poll.unref();
    }
    // stdio[0] 是 ignore ⇒ 没有 stdin；写 `q` 的旧路径已改成 SIGTERM（见 requestStop）。
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      let stderr = '';
      try { stderr = readFileSync(errFile, 'utf8'); } catch { /* ignore */ }
      try { if (fd !== null) closeSync(fd); } catch { /* ignore */ }
      try { rmSync(errFile, { force: true }); } catch { /* ignore */ }
      // SIGTERM/超时之后，ffmpeg 最后一段 silencedetect 日志可能还没写完，或者
      // 根本没走到 `silence_end`（一开口就说话）。这里用同一份 stderr 做兜底，
      // 把“已经录到的语音结束点”带出去；record() 再用实际已录时长兜最后一层。
      if (!speechEnd) {
        const opts = watch ? { silenceMs: watch.silenceMs, minSpeechMs: watch.minSpeechMs } : {};
        const decided = detectAutoStop(stderr, opts) || detectSpeechEnd(stderr);
        if (decided) speechEnd = Number(decided.speechEnd || decided.silenceStart) || 0;
      }
      resolve({
        code,
        signal: signal || '',
        timedOut,
        stderr,
        stoppedByWatch,
        noOnset,
        speechEnd,
      });
    };
    const timer = setTimeout(() => {
      // 超时也先试优雅退出（保住已录的 WAV 头），1.2s 后再强杀
      timedOut = true;
      requestStop();
      setTimeout(() => {
        if (settled) return;
        if (child.pid !== undefined) { try { child.kill(); } catch { /* ignore */ } }
      }, 1200);
    }, timeoutMs);
    child.on('error', () => finish(-1, ''));
    child.on('close', (code, signal) => finish(code, signal));
  });
}
