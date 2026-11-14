/**
 * lib/tts/tts.js — 桌宠朗读的**宿主侧服务**（P1）。
 *
 * 职责边界：
 *   · 进程管理：懒启动 `tts-worker.cjs`（NDJSON），请求串行、超时、崩溃重启；
 *   · 缓存：`<DSH_FOLIA_HOME>/tts/cache/<sha256>.wav`（同一句话第二次是 0ms）；
 *   · **stop 语义**：`stop()` 只递增 generation —— 正在合成的结果回来后会被丢弃，
 *     路由回 `tts-stopped`；不为了“停”去杀正在跑 0.4s 的 PowerShell（下一句还会用到）。
 *
 * 合成链本身在 worker 里（SAPI → Edge/OneCore 系统音色 → 明确错误）。
 * 本文件不 import 任何 Electron / native 模块，可在普通 node 与判据里直接跑。
 *
 * 依赖注入（判据用）：
 *   spawn / workerPath / nodePath / cacheDir / requestTimeoutMs / cacheMax
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 与 worker / 路由同一口径。 */
export const TTS_MAX_CHARS = 240;
/** 合成链（与 worker 的 ENGINES 对齐；路由状态里会回给界面）。 */
export const TTS_ENGINES = Object.freeze(['sapi', 'edge']);

/** Edge / WinRT 音色命名（`zh-CN-XxxNeural`）—— 这类名字只存在于 Edge 目录。 */
export const NEURAL_VOICE_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;

export function isNeuralVoice(voice) {
  return NEURAL_VOICE_RE.test(String(voice == null ? '' : voice).trim());
}

/** 用户音色 → 首选引擎（缓存 key 与路由状态都用它；实际引擎仍以合成结果为准）。 */
export function preferredEngineForVoice(voice) {
  return isNeuralVoice(voice) ? 'edge' : 'sapi';
}

/**
 * 缓存 key 的**唯一实现**（判据直接喂它做负对照）。
 * 必须带 `engine`：同一句话用 SAPI 与 Edge 得到的是**不同音色**，不加引擎会互相命中。
 */
export function ttsCacheKey(engine, voice, rate, text) {
  return sha256('v1|' + String(engine || '') + '|' + String(voice || '') + '|' + normalizeTtsRate(rate) + '|' + normalizeTtsText(text));
}

const WORKER_FILE = fileURLToPath(new URL('./tts-worker.cjs', import.meta.url));

/** 去掉控制字符、折叠空白；超过上限截断（路由已先做一次，这里是兜底）。 */
export function normalizeTtsText(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TTS_MAX_CHARS);
}

/** 语速：SAPI 的 -10..10（0 = 正常）。非数字当 0。 */
export function normalizeTtsRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-10, Math.min(10, Math.round(n)));
}

function defaultCacheDir() {
  const home = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(home, 'tts', 'cache');
}

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

/**
 * @param {{
 *   log?: (line: string) => void,
 *   cacheDir?: string,
 *   cacheMax?: number,
 *   workerPath?: string,
 *   nodePath?: string,
 *   spawn?: Function,
 *   requestTimeoutMs?: number,
 * }} options
 */
export function createTtsService(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const cacheDir = options.cacheDir || defaultCacheDir();
  const cacheMax = Math.max(10, Number(options.cacheMax) || 240);
  const workerPath = options.workerPath || WORKER_FILE;
  const nodePath = options.nodePath || process.execPath;
  const spawnImpl = typeof options.spawn === 'function' ? options.spawn : spawn;
  const requestTimeoutMs = Math.max(3000, Number(options.requestTimeoutMs) || 15000);

  /** `ready` 只在首单词启动时置一次；worker 崩溃后清空，下次请求重启。 */
  let child = null;
  let stdoutBuffer = '';
  let stderrTail = '';
  let seq = 0;
  let generation = 0;
  let disposed = false;
  const pending = new Map();

  /** 串行队列：PowerShell 是重进程，同一时刻只跑一条（也是“分句入队”的宿主侧支点）。 */
  let tail = Promise.resolve();
  const serialize = (task) => {
    const run = tail.then(task, task);
    tail = run.then(() => {}, () => {});
    return run;
  };

  function rejectAll(reason) {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(id);
      item.reject(new Error(reason));
    }
  }

  function attachWorker() {
    if (child) return child;
    const env = { ...process.env };
    // Electron 的 process.execPath 是 DSH Desktop.exe：必须让它以 node 身份跑 worker。
    if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const proc = spawnImpl(nodePath, [workerPath, '--out-dir', join(tmpdir(), 'folia-tts-worker')], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    child = proc;
    stdoutBuffer = '';
    stderrTail = '';
    log('[tts] worker 启动 pid=' + (proc.pid || '?'));
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const cut = stdoutBuffer.indexOf('\n');
        if (cut < 0) break;
        const line = stdoutBuffer.slice(0, cut).trim();
        stdoutBuffer = stdoutBuffer.slice(cut + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!msg) continue;
        if (msg.ready) { log('[tts] worker ready engines=' + (msg.engines || []).join(',')); continue; }
        const key = msg.id === undefined || msg.id === null ? '' : String(msg.id);
        const entry = key ? pending.get(key) : null;
        if (!entry) continue;
        clearTimeout(entry.timer);
        pending.delete(key);
        entry.resolve(msg);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-2000); });
    const fail = (reason) => {
      if (child !== proc) return;
      child = null;
      rejectAll(reason);
    };
    proc.on('error', (error) => {
      const message = String((error && error.message) || error);
      log('[tts] worker 错误：' + message);
      fail('worker-error: ' + message);
    });
    proc.on('close', (code) => {
      log('[tts] worker 退出 code=' + code + (stderrTail ? ' stderr=' + stderrTail.slice(-300) : ''));
      fail('worker-exited: ' + code);
    });
    return proc;
  }

  /** 发一条 NDJSON 请求；超时 reject（调用方按错误处理）。 */
  function request(payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new Error('disposed')); return; }
      let proc;
      try { proc = attachWorker(); } catch (error) {
        reject(error);
        return;
      }
      const id = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('tts-timeout'));
      }, timeoutMs || requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n', (error) => {
          if (!error) return;
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  /* ── 缓存（命中即 0ms；上限按最近使用时间淘汰）────────────────────────── */

  function cachePaths(key) {
    return { wav: join(cacheDir, key + '.wav'), meta: join(cacheDir, key + '.json') };
  }

  function readCache(key, requestedVoice) {
    const { wav, meta } = cachePaths(key);
    try {
      if (!existsSync(wav)) return null;
      const stat = statSync(wav);
      if (stat.size < 1024) { unlinkSync(wav); return null; }
      const bytes = readFileSync(wav);
      let info = {};
      try { info = JSON.parse(readFileSync(meta, 'utf8')); } catch { info = {}; }
      const wantVoice = String(requestedVoice || '').trim().toLowerCase();
      const gotVoice = String(info.voice || '').trim().toLowerCase();
      // 用户明确指定了音色 ⇒ 缓存里的**实际音色**必须就是它；否则这是修复前留下的
      // “回落到 Huihui 却按成功缓存”的旧条目 —— 不许复用，删掉让本轮重新合成。
      if (wantVoice && gotVoice && wantVoice !== gotVoice) {
        try { unlinkSync(wav); } catch { /* ignore */ }
        try { unlinkSync(meta); } catch { /* ignore */ }
        return null;
      }
      if (wantVoice && !gotVoice) return null;
      return {
        ok: true,
        wav: bytes,
        engine: info.engine || 'cache',
        voice: info.voice || '',
        requestedVoice: info.requestedVoice || String(requestedVoice || ''),
        fallback: false,
        fallbackFrom: '',
        attempts: [],
        ms: 0,
        cached: true,
        bytes: bytes.length,
      };
    } catch {
      return null;
    }
  }

  function pruneCache() {
    try {
      const names = readdirSync(cacheDir).filter((name) => name.endsWith('.wav'));
      if (names.length <= cacheMax) return;
      const items = names.map((name) => {
        const file = join(cacheDir, name);
        let mtime = 0;
        try { mtime = statSync(file).mtimeMs; } catch { /* ignore */ }
        return { file, mtime, meta: file.replace(/\.wav$/, '.json') };
      }).sort((a, b) => a.mtime - b.mtime);
      for (const item of items.slice(0, Math.max(1, items.length - cacheMax))) {
        try { unlinkSync(item.file); } catch { /* ignore */ }
        try { unlinkSync(item.meta); } catch { /* ignore */ }
      }
    } catch { /* 缓存清理失败不影响合成 */ }
  }

  function writeCache(key, wav, info) {
    try {
      mkdirSync(cacheDir, { recursive: true });
      const { wav: wavFile, meta } = cachePaths(key);
      const tmp = wavFile + '.' + process.pid + '.tmp';
      writeFileSync(tmp, wav);
      writeFileSync(meta, JSON.stringify({ ...info, at: new Date().toISOString() }), 'utf8');
      try {
        // 先写临时文件再改名：并发/崩溃时不会留下半截“命中”
        try { rmSync(wavFile, { force: true }); } catch { /* ignore */ }
        renameSync(tmp, wavFile);
      } catch (error) {
        try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw error;
      }
      pruneCache();
    } catch { /* ignore */ }
  }

  /* ── 对外：合成 / 停止 / 状态 ───────────────────────────────────────── */

  /**
   * 合成一句话。
   * @returns {Promise<{ok:true,wav:Buffer,engine:string,voice:string,ms:number,cached:boolean,bytes:number}
   *   | {ok:false,code:string,error?:string,attempts?:object[],hint?:string}>}
   */
  async function synthesize(text, speech = {}) {
    const clean = normalizeTtsText(text);
    if (!clean) return { ok: false, code: 'empty-text', hint: '没有要读的文字' };
    const voice = String(speech.voice || '').trim().slice(0, 120);
    const rate = normalizeTtsRate(speech.rate);
    const engines = Array.isArray(speech.engines)
      ? speech.engines.filter((engine) => engine === 'sapi' || engine === 'edge')
      : null;
    // 缓存 key 带**引擎**：neural 音色路由到 edge，SAPI 音色/空路由到 sapi；
    // 同一句话在两条引擎下是不同音色，绝不允许互相命中（pre.45 的实际缺陷）。
    const engineTag = engines && engines.length ? engines.join('+') : preferredEngineForVoice(voice);
    const key = ttsCacheKey(engineTag, voice, rate, clean);
    const cached = readCache(key, voice);
    if (cached) return cached;

    const gen = generation;
    return serialize(async () => {
      // 排队期间被 stop：不要再合成
      if (gen !== generation) return { ok: false, code: 'tts-stopped' };
      let msg;
      try {
        msg = await request({
          text: clean,
          voice,
          rate,
          ...(engines && engines.length ? { engines } : {}),
        });
      } catch (error) {
        const message = String((error && error.message) || error);
        return {
          ok: false,
          code: message === 'tts-timeout' ? 'tts-timeout' : 'tts-worker-failed',
          error: message,
          requestedVoice: voice,
          attempts: [],
          hint: message === 'tts-timeout' ? '语音合成超时，稍后再试' : '语音合成进程没起来',
        };
      }
      // 关键：stop 之后回来的结果一律丢弃（客户端已经停了，不能再补一句）
      if (gen !== generation) {
        if (msg && msg.file) { try { rmSync(msg.file, { force: true }); } catch { /* ignore */ } }
        return { ok: false, code: 'tts-stopped', requestedVoice: voice };
      }
      if (!msg || msg.ok !== true || !msg.file) {
        return {
          ok: false,
          code: (msg && msg.code) || 'tts-unavailable',
          error: (msg && msg.error) || 'tts-unavailable',
          requestedVoice: voice,
          attempts: (msg && msg.attempts) || [],
          hint: (msg && msg.hint) || '本机语音合成不可用（系统语音与 Edge 系统音色都失败了）',
        };
      }
      let wav;
      try {
        wav = readFileSync(msg.file);
      } catch (error) {
        return { ok: false, code: 'tts-read-failed', error: String((error && error.message) || error), requestedVoice: voice };
      } finally {
        try { rmSync(msg.file, { force: true }); } catch { /* ignore */ }
      }
      if (!wav || wav.length < 1024 || wav.toString('ascii', 0, 4) !== 'RIFF') {
        return { ok: false, code: 'tts-bad-wav', error: 'worker 返回的不是有效 WAV', requestedVoice: voice };
      }
      const info = {
        engine: msg.engine || 'system',
        voice: msg.voice || voice,
        requestedVoice: voice,
        rate,
        text: clean,
      };
      const fallback = Boolean(voice) && String(info.voice || '') !== voice;
      // pre.54：回落得到的音频**不按请求音色缓存** —— 否则下一次会拿“别人的音色”当命中。
      if (!fallback) writeCache(key, wav, info);
      return {
        ok: true,
        wav,
        engine: info.engine,
        voice: info.voice,
        requestedVoice: info.requestedVoice,
        fallback,
        fallbackFrom: fallback ? voice : '',
        attempts: (msg && msg.attempts) || [],
        ms: Number(msg.ms) || 0,
        cached: false,
        bytes: wav.length,
      };
    });
  }

  /** 停止当前播报：递增 generation（在途结果作废）；幂等。 */
  function stop() {
    generation += 1;
    return { ok: true, generation };
  }

  /**
   * pre.54（B3②）：本机可用音色清单（worker 枚举 + 试合成）。
   * 结果缓存 10 分钟：UI 每次打开不重复跑 PowerShell。
   */
  let voicesCache = { at: 0, items: null };
  async function voices() {
    if (voicesCache.items && Date.now() - voicesCache.at < 10 * 60 * 1000) return voicesCache.items;
    let msg;
    try {
      msg = await request({ op: 'voices' }, Math.max(20000, requestTimeoutMs));
    } catch {
      return [];
    }
    const items = msg && msg.ok === true && Array.isArray(msg.voices) ? msg.voices : [];
    voicesCache = { at: Date.now(), items };
    return items;
  }

  /** 路由 `/tts/state` 用（不触发任何合成）。 */
  function status() {
    return {
      ok: true,
      ready: Boolean(child),
      platform: process.platform,
      engines: TTS_ENGINES.slice(),
      generation,
      worker: workerPath,
      cacheDir,
    };
  }

  function dispose() {
    disposed = true;
    generation += 1;
    rejectAll('disposed');
    if (child) {
      const proc = child;
      child = null;
      try { proc.stdin.end(); } catch { /* ignore */ }
      // pid 落地才 kill（未起来时裸 kill 会让事件循环挂死；verify-child-kill 的判据）
      try { if (proc.pid !== undefined) proc.kill(); } catch { /* ignore */ }
    }
  }

  return { synthesize, stop, status, voices, dispose, cacheDir, workerPath };
}
