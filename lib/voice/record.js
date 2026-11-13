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

/** 默认参数（工单给的数）。 */
export const RECORD_DEFAULTS = Object.freeze({
  maxMs: 15000,
  silenceDb: -35,
  silenceMs: 1200,
  sampleRate: 16000,
});

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
  const minSpeechMs = Number.isFinite(options.minSpeechMs) ? options.minSpeechMs : 250;
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
  return [
    '-hide_banner', '-y',
    '-f', 'dshow', '-i', `audio=${device}`,
    '-ar', String(opts.sampleRate), '-ac', '1',
    '-t', String(Math.ceil(opts.maxMs / 1000) + 5),
    '-af', `silencedetect=noise=${opts.silenceDb}dB:d=${opts.silenceMs / 1000}`,
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

  /**
   * 录一段：返回 { audioPath, ms, speech }。
   * 失败码：no-device / ffmpeg-missing / timeout / no-speech
   */
  async function record(options = {}) {
    const opts = { ...RECORD_DEFAULTS, ...options };
    // 非 Windows：没有 dshow，宿主录音不可用（浏览器模式请用前端 getUserMedia 通道）
    if (process.platform !== 'win32') return { ok: false, code: 'unsupported-platform' };
    let devices;
    try {
      devices = await listDevices();
    } catch {
      return { ok: false, code: 'ffmpeg-missing' };
    }
    const preferred = pickDevice(devices);
    if (!preferred) return { ok: false, code: 'no-device' };
    // 跨机器：不同机器的第一个"像麦克风"的设备不一定真能开（被占用/驱动不同）
    // ⇒ 依次尝试最多 3 个音频设备，任一成功即返回。
    const candidates = [preferred, ...devices.filter((d) => d !== preferred)].slice(0, 3);
    let lastCode = 'no-speech';
    for (const device of candidates) {
      const dir = mkdtempSync(join(tmpdir(), 'folia-voice-'));
      const audioPath = join(dir, 'input.wav');
      const startedAt = Date.now();
      let result;
      let usedPlain = false;
      try {
      const ff = await resolveFfmpeg(null);
      const watch = { stopOnSpeechEnd: { silenceMs: opts.silenceMs } };
      result = await runFfmpeg(ff, [...dshowArgs(device, opts), audioPath], opts.maxMs + 8000, watch);
      // 兜底：某些环境（实测 dsh web / Electron 主进程）里 ffmpeg 不接受 -af silencedetect，
      // 会立刻非零退出。这时退化成"固定时长采集"：宁可少一点智能，也不能录不到。
      if (result && result.code !== 0) {
        const args = dshowArgs(device, opts);
        const cut = args.indexOf('-af');
        const plain = cut >= 0 ? args.slice(0, cut).concat(args.slice(cut + 2)) : args;
        const retry = await runFfmpeg(ff, [...plain, audioPath], opts.maxMs + 8000);
        if (retry && retry.code === 0) { result = retry; usedPlain = true; }
      }
      } catch {
        rmSync(dir, { recursive: true, force: true });
        lastCode = 'ffmpeg-missing';
        continue;
      }
      const ms = Date.now() - startedAt;
      const stderr = String((result && result.stderr) || '');
      if (result && result.code !== 0) {
        // 这个设备打不开（占用/驱动）⇒ 换下一个
        rmSync(dir, { recursive: true, force: true });
        lastCode = 'no-device';
        continue;
      }
      let ended = detectSpeechEnd(stderr);
      // 自动停机（VAD）可能发生在“一开口就说话”的场景：日志里没有前置 silence_end，
      // 用执行器回报的 stoppedByWatch / speechEnd 兜住，不能把已经录好的话判成 no-speech。
      if (!ended && result && result.stoppedByWatch) {
        ended = { speechEnd: Number(result.speechEnd) || 0, auto: true };
      }
      // 固定时长兜底采集里没有 silencedetect 标记 ⇒ 直接按 maxMs 当语音段，别误判成 no-speech
      if (!ended && usedPlain) ended = { speechEnd: opts.maxMs / 1000 };
      if (!ended) {
        rmSync(dir, { recursive: true, force: true });
        lastCode = 'no-speech';
        continue;
      }
      const size = probeSize(audioPath);
      if (!size) { rmSync(dir, { recursive: true, force: true }); lastCode = 'no-speech'; continue; }
      return { ok: true, audioPath, dir, ms, device, speech: ended, audioSeconds: Number((ended.speechEnd || 0).toFixed(2)) };
    }
    return { ok: false, code: lastCode };  }

  return { listDevices, record };
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
      // stdin 必须是 pipe：自动停机靠写 `q`（stdout/stderr 仍然走文件，避开 EPERM）
      stdio: ['pipe', 'ignore', fd === null ? 'ignore' : fd],
    });
    let settled = false;
    let stoppedByWatch = false;
    let speechEnd = 0;
    let poll = null;
    let stopSent = false;
    const requestStop = () => {
      if (stopSent) return;
      stopSent = true;
      try { child.stdin.write('q\n'); } catch { /* 进程可能已退出 */ }
    };
    if (watch) {
      poll = setInterval(() => {
        if (settled || stopSent) return;
        let text;
        try { text = readFileSync(errFile, 'utf8'); } catch { return; }
        const decided = detectAutoStop(text, { silenceMs: watch.silenceMs });
        if (!decided) return;
        if (Date.now() - startedAt < decided.readyAtMs) return;
        stoppedByWatch = true;
        speechEnd = decided.speechEnd;
        requestStop();
      }, 120);
      if (typeof poll.unref === 'function') poll.unref();
    }
    try { child.stdin.on('error', () => { /* EPIPE：ffmpeg 已退出 */ }); } catch { /* ignore */ }
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      let stderr = '';
      try { stderr = readFileSync(errFile, 'utf8'); } catch { /* ignore */ }
      try { if (fd !== null) closeSync(fd); } catch { /* ignore */ }
      try { rmSync(errFile, { force: true }); } catch { /* ignore */ }
      resolve({ code, stderr, stoppedByWatch, speechEnd });
    };
    const timer = setTimeout(() => {
      // 超时也先试优雅退出（保住已录的 WAV 头），1.2s 后再强杀
      requestStop();
      setTimeout(() => {
        if (settled) return;
        if (child.pid !== undefined) { try { child.kill(); } catch { /* ignore */ } }
      }, 1200);
    }, timeoutMs);
    child.on('error', () => finish(-1));
    child.on('close', (code) => finish(code));
  });
}
