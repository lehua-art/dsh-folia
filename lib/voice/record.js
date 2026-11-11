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
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
    let devices;
    try {
      devices = await listDevices();
    } catch {
      return { ok: false, code: 'ffmpeg-missing' };
    }
    const device = pickDevice(devices);
    if (!device) return { ok: false, code: 'no-device' };

    const dir = mkdtempSync(join(tmpdir(), 'folia-voice-'));
    const audioPath = join(dir, 'input.wav');
    const startedAt = Date.now();
    let result;
    try {
      result = await runFfmpeg(await resolveFfmpeg(null), [...dshowArgs(device, opts), audioPath], opts.maxMs + 8000);
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, code: 'timeout' };
    }
    const ms = Date.now() - startedAt;
    const stderr = String((result && result.stderr) || '');
    const ended = detectSpeechEnd(stderr);
    if (!ended) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, code: result && result.code !== 0 ? 'timeout' : 'no-speech' };
    }
    const size = probeSize(audioPath);
    if (!size) { rmSync(dir, { recursive: true, force: true }); return { ok: false, code: 'no-speech' }; }
    return { ok: true, audioPath, dir, ms, speech: ended, audioSeconds: Number((ended.speechEnd || 0).toFixed(2)) };
  }

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
  const cached = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh-folia', 'ffmpeg', exe);
  const { existsSync } = await import('node:fs');
  if (existsSync(cached)) return cached;
  return exe;
}

/** 默认执行器：spawn + 收集 stderr（silencedetect 的输出在这里），超时强杀。 */
export function defaultRunFfmpeg(ff, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(ff, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      // 先确认 pid 落地再 kill：spawn 失败时 pid 是 undefined，直接 kill 会抛（守卫 verify-child-kill）
      if (child.pid !== undefined) { try { child.kill(); } catch { /* ignore */ } }
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
}
