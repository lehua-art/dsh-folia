/**
 * transcode.js — 抽帧转码族（ffmpeg 供给链 / 并发闸 / 落盘缓存 / 进度账本）。
 *
 * 从 `lib/index.js` **纯搬移**（P0 库化）：函数体、常量、注释、错误文案逐字未改，只把族外依赖
 * 收进一个工厂 `createTranscodeKit(deps)`。门面在**模块作用域**建一次并解构出与原来同名的绑定，
 * 所以门面里所有调用点逐字未变。
 *
 * ⚠️ 为什么实例建在**模块作用域**（而不是像 lib/routes/*.js 那样在 apply() 里建一次）：
 * 这一族有**模块级**调用者 —— 门面的 `generateVideoPreview()` 直接调 `resolveFfmpeg()` /
 * `spawnFfmpeg()`，而 `ensureDirOnce()` 还被非转码族使用（customFrameDir / avatarDir /
 * mascotDir / liveFrameDir / ensureUploadDir 以及 fontsets / presets 两个路由族）。建在 apply()
 * 里这些模块级调用点就拿不到同名绑定（要么改签名、要么靠未初始化的 let 兜底）。模块作用域实例的
 * 生命周期与原实现完全一致：同一模块实例被再次 apply 时状态保留（与原来的模块级 Map/Set 同），
 * 卸载时由 `dispose()` 逐项清空。
 *
 * deps 契约（键名 → 门面来源 / 原因）：
 *   · cacheBaseDir()         → `transcodeCacheDir()` = join(<cache>, 'transcodes')
 *   · configPath()           → `ffmpegDataDir()`     = join(dirname(configPath()), 'ffmpeg')
 *   · videoPreviewCacheDir() → `sweepTranscodeArtifacts()` 扫的第三个目录（唯一一个不属本族的
 *                              目录，见该函数头）
 *   · getMediaInfo(abs)      → 源分辨率 / 时长（码率换算与 `-t` 输出时长上限）
 *   · atomicTmpPath(p)       → 唯一 `.tmp<pid><递增序号>` 临时名（`transcodeToFps` 的取消语义
 *                              依赖它，见那里的 ⚠️）
 *   · pluginRoot             → 本地 ./ffmpeg/ffmpeg(.exe) 的查找根。搬移前是
 *                              `join(dirname(fileURLToPath(import.meta.url)), '..')`（即 bundle 根）；
 *                              注入后本模块不需要 `import.meta.url`。
 *
 * 本模块**绝不** import `lib/index.js`（会成环），只 import `node:` 内置。
 */

import { dirname, join } from 'node:path';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

/**
 * 建一次抽帧转码套件。deps 见文件头；返回门面要用的面 + `dispose()`。
 */
export function createTranscodeKit(deps) {
  const { cacheBaseDir, configPath, videoPreviewCacheDir, getMediaInfo, atomicTmpPath, pluginRoot } = deps;

  // ── Frame-skip transcode (抽帧转码, ffmpeg) ──────────────────────────────────
  // The decode-side fps cap is implemented as a re-encode, NOT playbackRate:
  // playbackRate is a speed multiplier, so slowing decode also slows motion.
  // Instead the host transcodes the wallpaper ONCE to the capped frame rate
  // (4K120 → 4K60: ffmpeg drops every other frame, timeline stays 1.0x, reference
  // chains are re-encoded intact) and the browser plays a normal capped-fps file.
  // Output is AV1 via NVENC (decode throughput ≈ 2× H.264 on NVDEC, so decode
  // util roughly halves again), falling back to H.264 when AV1 encode is missing.
  // ffmpeg resolution: DSH_FOLIA_FFMPEG env → a local ./ffmpeg/ffmpeg(.exe) next to
  // the bundle → system PATH. Missing ffmpeg ⇒ the transcode route errors and the
  // client transparently keeps the original file (feature degrades gracefully).
  const TRANSCODE_INFLIGHT = new Map();
  // Hard deadline for ONE ffmpeg transcode job (covers ALL encoder attempts of
  // that job — the timer no longer restarts per attempt — so a hung encode can
  // never leave /transcoded waiting forever: the child is killed and the route
  // answers 502, and the client falls back to the original). Queue wait behind
  // the concurrency gate below does NOT consume the budget; the deadline starts
  // when the job actually begins encoding. Overridable via
  // DSH_FOLIA_TRANSCODE_TIMEOUT_MS (ms).
  const TRANSCODE_TIMEOUT_MS = Number(process.env.DSH_FOLIA_TRANSCODE_TIMEOUT_MS) || 15 * 60 * 1000;
  /** Active ffmpeg child processes, so a job deadline can kill them. */
  const ACTIVE_FFMPEG = new Set();

  // 全局转码并发闸：ffmpeg 重编码吃满 CPU/GPU 解码器，N 个并发只会一起变慢，
  // 不会变快。最多 `TRANSCODE_MAX_CONCURRENT` 个并发，其余排队（排队不计入 TRANSCODE_TIMEOUT_MS，
  // deadline 从拿到闸、开始编码起算）。
  const TRANSCODE_MAX_CONCURRENT = 2;
  let transcodeActive = 0;
  const transcodeWaiters = [];
  function acquireTranscodeSlot() {
    if (transcodeActive < TRANSCODE_MAX_CONCURRENT) {
      transcodeActive += 1;
      return Promise.resolve();
    }
    return new Promise((resolveSlot) => { transcodeWaiters.push(resolveSlot); });
  }
  function releaseTranscodeSlot() {
    const next = transcodeWaiters.shift();
    // 有等待者：名额直接移交（计数不变）；无等待者：名额归还。
    if (next) next();
    else transcodeActive -= 1;
  }

  function transcodeCacheDir() {
    return join(cacheBaseDir(), 'transcodes');
  }

  // 目录创建记忆化：recursive mkdirSync 每次都要走一串同步 syscall（逐层
  // stat），而 ensure*Dir 都在请求热路径上。同一路径只 mkdir 一次。
  const ensuredDirs = new Set();
  function ensureDirOnce(dir) {
    if (!ensuredDirs.has(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
      ensuredDirs.add(dir);
    }
    return dir;
  }

  function ensureTranscodeCacheDir() {
    return ensureDirOnce(transcodeCacheDir());
  }

  // ── Lazy ffmpeg provisioning (B + C + D) ─────────────────────────────────────
  // Resolution chain (each level falls through to the next):
  //   B. system PATH (bare name)                       ← last resort
  //   C. lazy download cache ~/.dsh-folia/ffmpeg/ffmpeg[.exe]
  //      (pinned single-file ffmpeg-static release asset, magic-byte + size
  //      verified, atomic rename; runs once per machine, then cached)
  //   env DSH_FOLIA_FFMPEG  /  plugin-local ./ffmpeg/     ← explicit overrides
  // Downloaded binaries are pinned by sha256 (FFMPEG_STATIC_SHA256, computed from
  // the b6.0 release bytes) — a mismatch aborts before anything is executed; the
  // magic-byte + size checks remain as a second layer.
  const FFMPEG_STATIC_TAG = 'b6.0';
  // process.platform → process.arch → release asset name (ffmpeg-static naming).
  const FFMPEG_STATIC_ASSETS = {
    win32: { x64: 'ffmpeg-win32-x64', ia32: 'ffmpeg-win32-ia32' },
    linux: { x64: 'ffmpeg-linux-x64', ia32: 'ffmpeg-linux-ia32', arm: 'ffmpeg-linux-arm', arm64: 'ffmpeg-linux-arm64' },
    darwin: { x64: 'ffmpeg-darwin-x64', arm64: 'ffmpeg-darwin-arm64' },
  };
  // Pinned sha256 for every asset in FFMPEG_STATIC_ASSETS (ffmpeg-static b6.0).
  // Computed from the exact release bytes served by both registry.npmmirror.com
  // and github.com/eugeneware/ffmpeg-static releases/download/b6.0 (cross-verified
  // on win32-x64; npmmirror mirrors the GitHub asset byte-for-byte). A mismatch
  // aborts the download instead of executing an unverified binary.
  const FFMPEG_STATIC_SHA256 = {
    'ffmpeg-win32-x64': 'e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1',
    'ffmpeg-win32-ia32': 'fb3766af5cc193ca863e15cd4554a33732973209dad5e3c1433b5e291bceb16c',
    'ffmpeg-linux-x64': 'ed652b2f32e0851d1946894fb8333f5b677c1b2ce6b9d187910a67f8b99da028',
    'ffmpeg-linux-ia32': '103500b65ccb78c3c804088d6e17111d85e2bd03f5a0c61c349dc2d05e165f09',
    'ffmpeg-linux-arm': '1a9ddc19d0e071b6e1ff6f8f34dc05ec6dd4d8f3e79a649f5a9ec0e8c929c4cb',
    'ffmpeg-linux-arm64': '237800b37bb65a81ad47871c6c8b7c45c0a3ca62a5b3f9d2a7a9a2dd9a338271',
    'ffmpeg-darwin-x64': 'cfe20936c83ecf5d68e424b87e8cc45b24dd6be81787810123bb964a0df686f9',
    'ffmpeg-darwin-arm64': 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
  };

  function ffmpegDataDir() {
    const dir = join(dirname(configPath()), 'ffmpeg');
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return dir;
  }
  function ffmpegExeName() {
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  }

  // Startup-only sweep of orphaned transcode/download artifacts (see apply()).
  // Matches: `*.tmp<pid>` transcode outputs, `*.prog` progress files (legacy),
  // `*.part*` download partials, `ffmpeg-err-*.log` spawn logs. Runs once before
  // any route is served, so nothing of the current process is ever touched.
  function sweepTranscodeArtifacts() {
    const dirs = [transcodeCacheDir(), ffmpegDataDir(), videoPreviewCacheDir()];
    // A plugin HMR/re-apply re-runs this sweep while the SAME process may still be
    // mid-transcode; never delete artifacts owned by the current pid (the ffmpeg
    // child keeps writing to `.tmp<pid>` — removing it would corrupt the job).
    // ⚠️ 尾部要允许**递增序号**：转码临时名走 `atomicTmpPath`（`.tmp<pid><6 位序号>`），
    // 只认 `.tmp<pid>` 结尾会让"保护本进程在途写"这条在改名后静默失效（HMR 时删掉正在写的产物）。
    const ownTmpRe = new RegExp('\\.tmp' + process.pid + '\\d*$');
    for (const dir of dirs) {
      /** @type {string[]} */
      let entries;
      try { entries = readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        if (ownTmpRe.test(name)) continue;
        if (!(/\.tmp\d*$/.test(name) || /\.part\d*$/.test(name)
          || /\.prog$/.test(name) || /^ffmpeg-err-/.test(name))) continue;
        try { unlinkSync(join(dir, name)); } catch { /* ignore */ }
      }
    }
  }

  /**
   * 自定义画面目录的孤儿 `.tmp` 清扫。
   *
   * `/custom-frame` 的"中途放弃"已由 `req 'close'` 收口（见 `routes/scene-frame.js` 文件头的不变量）
   * ⇒ 正常路径不再留孤儿。剩下的来源是**进程被强杀 / 崩溃**：写流随进程消失，`.tmp` 留在盘上。
   * 而读取侧（`customFramePath` / `listCustomFrameIds`）只认 `.png|.jpg|.webp` ⇒ 那种垃圾
   * **看不见**、只会累积（`sweepTranscodeArtifacts` 扫的三个目录都不含自定义画面目录）。
   *
   * ⚠️ 只清**够旧**的：HMR 重新 apply 会再跑一次本清扫，而同一进程里可能正有一个上传在写那个
   * 确定性的 `.tmp` 名 —— 按年龄设限就不会误删在途写（与 `sweepTranscodeArtifacts` 的
   * `ownTmpSuffix` 是同一类保护，这里是时间口径）。
   */
  const CUSTOM_FRAME_TMP_STALE_MS = 10 * 60 * 1000;
  function sweepCustomFrameTmp(dir) {
    /** @type {string[]} */
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - CUSTOM_FRAME_TMP_STALE_MS;
    for (const name of entries) {
      if (!name.endsWith('.tmp')) continue;
      const abs = join(dir, name);
      try { if (statSync(abs).mtimeMs > cutoff) continue; } catch { continue; }
      try { unlinkSync(abs); } catch { /* ignore */ }
    }
  }

  function ffmpegMagicOk(buf) {
    if (buf.length < 4) return false;
    // PE (Windows): "MZ"; ELF: 0x7F 'ELF'; Mach-O 64: CF FA ED FE.
    const mz = buf[0] === 0x4d && buf[1] === 0x5a;
    const elf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    const mach = buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe;
    return mz || elf || mach;
  }

  let ffmpegDownloadPromise = null;
  // Last download failure (URL + reason) surfaced in the transcode 502 detail,
  // so a bad tag/URL, blocked network or missing fetch is diagnosable instead of
  // looking like a spawn problem.
  let lastFfmpegDownloadError = null;

  // Active transcode-job progress, keyed by abs|fps, polled by the picker's
  // progress bar via GET /transcode-progress/<token>?fps=N:
  //   phase 'download'  — bytes/total (content-length when the mirror sends it)
  //   phase 'transcode' — output-file growth (see runFfmpegTranscode)
  //   phase 'done'      — cached file is ready to serve
  //   phase 'error'     — the job failed (client falls back to the original)
  // Per-JOB entries (not a single global slot), so rotation can run several
  // transcodes in parallel and each wallpaper still sees its own progress.
  const transcodeJobs = new Map();
  const TRANSCODE_JOBS_MAX = 64;
  function setTranscodeJob(job) {
    transcodeJobs.set(job.key, job);
    if (transcodeJobs.size > TRANSCODE_JOBS_MAX) {
      const first = transcodeJobs.keys().next().value;
      if (first !== undefined) transcodeJobs.delete(first);
    }
  }

  // Download sources, raced in parallel (first success wins — the fastest mirror
  // for THIS user wins automatically, no region pre-sorting):
  //   npmmirror  — fast for CN users (validated ~2 min for the 70MB binary)
  //   GitHub     — fast for everyone else
  // `DSH_FOLIA_FFMPEG_URL` replaces the list (user-chosen mirror / self-hosted).
  function ffmpegDownloadUrls(asset) {
    const env = process.env.DSH_FOLIA_FFMPEG_URL && process.env.DSH_FOLIA_FFMPEG_URL.trim();
    if (env) return [env];
    return [
      'https://registry.npmmirror.com/-/binary/ffmpeg-static/' + FFMPEG_STATIC_TAG + '/' + asset,
      'https://github.com/eugeneware/ffmpeg-static/releases/download/' + FFMPEG_STATIC_TAG + '/' + asset,
    ];
  }

  // Stream one source to its .part file (visible progress on disk, no 70MB
  // in-memory buffer), computing a streaming sha256. The caller owns the abort
  // signal (per-source timeout / loser cancellation).
  async function downloadFfmpegToFile(url, tmp, ctrl, job) {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'dsh-folia' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!res.body) throw new Error('no response body');
    const reader = res.body.getReader();
    const fd = openSync(tmp, 'w');
    let total = 0;
    const totalBytes = Number(res.headers.get('content-length')) || 0;
    if (job && job.phase === 'download') {
      job.total = totalBytes;
      job.source = url;
    }
    const hash = createHash('sha256');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          let off = 0;
          while (off < value.length) {
            off += writeSync(fd, value, off, value.length - off);
          }
          hash.update(value);
          total += value.length;
          if (job && job.phase === 'download') {
            job.downloaded = total;
          }
        }
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (total < 20 * 1024 * 1024) throw new Error('implausible size ' + total);
    const head = Buffer.alloc(8);
    const rfd = openSync(tmp, 'r');
    try {
      let got = 0;
      while (got < 8) { const n = readSync(rfd, head, got, 8 - got, got); if (n <= 0) break; got += n; }
    } finally {
      closeSync(rfd);
    }
    if (!ffmpegMagicOk(head)) throw new Error('unrecognized binary magic');
    return { total, sha256: hash.digest('hex') };
  }

  async function ensureDownloadedFfmpeg(job) {
    const target = join(ffmpegDataDir(), ffmpegExeName());
    if (existsSync(target)) return target;
    const assets = FFMPEG_STATIC_ASSETS[process.platform];
    const asset = assets && assets[process.arch];
    if (!asset) {
      lastFfmpegDownloadError = 'unsupported platform ' + process.platform + '/' + process.arch;
      return null;
    }
    if (typeof fetch !== 'function') {
      lastFfmpegDownloadError = 'fetch unavailable (Node < 18?)';
      return null;
    }
    if (ffmpegDownloadPromise) return ffmpegDownloadPromise;
    ffmpegDownloadPromise = (async () => {
      const urls = ffmpegDownloadUrls(asset);
      const ctrls = urls.map(() => new AbortController());
      const tmpFiles = urls.map((u, i) => target + '.part' + i);
      const timers = ctrls.map((c) => setTimeout(() => c.abort(), 5 * 60 * 1000));
      const errors = [];
      const cleanup = () => timers.forEach(clearTimeout);
      const win = await new Promise((resolve) => {
        let done = false;
        let remaining = urls.length;
        urls.forEach((url, i) => {
          downloadFfmpegToFile(url, tmpFiles[i], ctrls[i], job)
            .then((r) => {
              if (done) return;
              const want = FFMPEG_STATIC_SHA256[asset];
              if (want && r.sha256 !== want) {
                errors.push(url + ' → sha256 mismatch');
                try { unlinkSync(tmpFiles[i]); } catch { /* ignore */ }
                remaining--; if (remaining === 0) { done = true; resolve(-1); }
                return;
              }
              done = true;
              resolve(i);
            })
            .catch((err) => {
              if (done) return;
              errors.push(url + ' → ' + String(err && err.message ? err.message : err));
              remaining--; if (remaining === 0) { done = true; resolve(-1); }
            });
        });
      });
      cleanup();
      if (win < 0) {
        try { tmpFiles.forEach((f) => { try { unlinkSync(f); } catch { /* ignore */ } }); } catch { /* ignore */ }
        lastFfmpegDownloadError = errors.join('; ') || 'all sources failed';
        return null;
      }
      for (let i = 0; i < ctrls.length; i++) {
        if (i !== win) {
          ctrls[i].abort();
          try { unlinkSync(tmpFiles[i]); } catch { /* ignore */ }
        }
      }
      if (process.platform !== 'win32') { try { chmodSync(tmpFiles[win], 0o755); } catch { /* ignore */ } }
      renameSync(tmpFiles[win], target);
      lastFfmpegDownloadError = null;
      return target;
    })().catch((err) => {
      lastFfmpegDownloadError = 'download internal error: ' + String(err && err.message ? err.message : err);
      return null;
    }).finally(() => {
      ffmpegDownloadPromise = null;
    });
    return ffmpegDownloadPromise;
  }

  // Async resolution chain (the C level may download on first use).
  async function resolveFfmpeg(job) {
    if (process.env.DSH_FOLIA_FFMPEG && process.env.DSH_FOLIA_FFMPEG.trim()) {
      return process.env.DSH_FOLIA_FFMPEG.trim();
    }
    try {
      const local = join(pluginRoot, 'ffmpeg', ffmpegExeName());
      if (existsSync(local)) return local;
    } catch { /* ignore */ }
    const dl = await ensureDownloadedFfmpeg(job);
    if (dl) return dl;
    return ffmpegExeName(); // system PATH
  }

  // Spawn ffmpeg for the (potentially long) background transcode. The dsh web
  // process runs in a constrained spawn context (observed: console-app children
  // dying at startup with 0xFFFFFFEA = -22, and piped stdio failing with EPERM).
  // We therefore: (1) never use pipes — stderr is redirected to a temp FILE so
  // its content survives into the 502 detail; (2) try, in order: a detached
  // process group (own hidden console), then a plain direct spawn; (3) keep
  // EVERY attempt's error so the final message shows the full picture.
  // `timeoutMs` is the per-attempt budget handed down from the JOB deadline
  // (runFfmpegTranscode computes it as the remaining time, so all encoder
  // attempts share one 15min wall-clock budget instead of 15min each).
  // opts.signal (AbortSignal) additionally cancels the running ffmpeg (client
  // disconnect / wallpaper switch).
  /** @returns {Promise<void>} 子进程正常退出（code 0）⇒ resolve(void)；失败/超时 ⇒ reject */
  function spawnFfmpeg(ff, args, timeoutMs, opts = {}) {
    const limit = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : TRANSCODE_TIMEOUT_MS;
    const signal = (opts && opts.signal) || null;
    return new Promise((resolve, reject) => {
      const errLog = join(ensureTranscodeCacheDir(), 'ffmpeg-err-' + process.pid + '-' + Date.now() + '.log');
      const attempts = [
        { name: 'detached', opts: { detached: true, windowsHide: true } },
        { name: 'plain', opts: { windowsHide: true } },
      ];
      let idx = 0;
      let curProc = null;
      const onAbort = () => {
        if (curProc && curProc.pid !== undefined) { try { curProc.kill(); } catch { /* ignore */ } }
      };
      // 监听器无条件挂一次 (不能因 signal.aborted 为真就 return): abort 已在
      // 「检查」与「spawn」之间发生时, 第二次尝试会 spawn 出一个没有任何 abort 监听
      // 的子进程 —— 无人取消, 它就一直编码到超时。abort 后再挂监听不会触发,
      // 由下面的 spawn 后复查兜底。
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const errors = [];
      const runNext = () => {
        if (idx >= attempts.length) {
          if (signal) signal.removeEventListener('abort', onAbort);
          let detail = errors.join('; ');
          try {
            const t = readFileSync(errLog, 'utf8').trim();
            if (t) detail += ' | stderr: ' + t.split('\n').slice(-4).join(' | ');
          } catch { /* ignore */ }
          try { unlinkSync(errLog); } catch { /* ignore */ }
          reject(new Error('ffmpeg spawn failed' + (detail ? ': ' + detail : '')));
          return;
        }
        const a = attempts[idx++];
        let errFd = null;
        try { errFd = openSync(errLog, 'w'); } catch { /* ignore */ }
        let proc = null;
        try {
          // cwd: Windows 用 SystemRoot (console-app 启动稳定性, 见上方注释);
          // 非 Windows 必须给真实存在的目录 — 回退 'C:\\' 在 Linux/macOS 上不存在
          // → spawn ENOENT → ffmpeg 必然启动失败（cwd 必须是真实存在的目录）。
          const spawnCwd = process.env.SystemRoot
            || (process.platform === 'win32' ? 'C:\\' : undefined);
          proc = spawn(a.file || ff, a.args || args,
            { ...a.opts, cwd: spawnCwd, stdio: errFd ? ['ignore', 'ignore', errFd] : 'ignore' });
        } catch (err) {
          if (errFd) { try { closeSync(errFd); } catch { /* ignore */ } }
          errors.push(a.name + ' spawn throw ' + (err && err.code ? err.code : err));
          runNext();
          return;
        }
        curProc = proc;
        // Track the child so a job deadline (see TRANSCODE_TIMEOUT_MS) can kill it
        // even while it is detached / mid-encode.
        ACTIVE_FFMPEG.add(proc);
        // spawn 与上面的 signal 检查之间的 abort 竞态: 此时 onAbort 早已返回
        // (curProc 还是 null), 该子进程不会收到任何取消 → 刚起的进程立刻杀掉并
        // 结束整个尝试链 (不 spawn 第二次), 避免切换壁纸后它继续编码到超时。
        if (signal && signal.aborted) {
          if (proc.pid !== undefined) { try { proc.kill(); } catch { /* ignore */ } }
          ACTIVE_FFMPEG.delete(proc);
          curProc = null;
          if (errFd) { try { closeSync(errFd); } catch { /* ignore */ } }
          signal.removeEventListener('abort', onAbort);
          try { unlinkSync(errLog); } catch { /* ignore */ }
          reject(new Error('ffmpeg aborted'));
          return;
        }
        let done = false;
        let timedOut = false;
        const settle = (msg) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ACTIVE_FFMPEG.delete(proc);
          if (curProc === proc) curProc = null;
          if (errFd) { try { closeSync(errFd); } catch { /* ignore */ } }
          errors.push(msg);
          runNext();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          if (proc.pid !== undefined) { try { proc.kill(); } catch { /* ignore */ } }
          settle(a.name + ' timed out after ' + limit + 'ms');
        }, limit);
        proc.on('error', (err) => {
          // 收窄：`child_process` 的 'error' 监听形参在声明里是 `Error`，而真实抛出的是 errno
          // 异常（带 `code`）—— 不这么写，IDE 的 TS 会判 `类型"Error"上不存在属性"code"`。
          const e = /** @type {NodeJS.ErrnoException} */ (err);
          settle(a.name + ' spawn error ' + (e && e.code ? e.code + ' ' + e.message : e));
        });
        proc.on('exit', (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ACTIVE_FFMPEG.delete(proc);
          if (curProc === proc) curProc = null;
          if (errFd) { try { closeSync(errFd); } catch { /* ignore */ } }
          if (code === 0) {
            try { unlinkSync(errLog); } catch { /* ignore */ }
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve();
            return;
          }
          errors.push(a.name + ' exit ' + code + (timedOut ? ' (killed by timeout)' : ''));
          runNext();
        });
      };
      runNext();
    });
  }

  async function runFfmpegTranscode(abs, out, fps, signal, opts) {
    const o = opts || {};
    const key = abs + '|' + fps;
    // Download phase: resolveFfmpeg may lazy-download ffmpeg (bytes/total).
    const job = { key, phase: 'download', downloaded: 0, total: 0, source: '' };
    setTranscodeJob(job);
    const ff = await resolveFfmpeg(job);
    const mi = getMediaInfo(abs);
    // Real-time progress source: ffmpeg's `-progress FILE` output is BUFFERED and
    // invisible until the process exits on this platform, so instead we encode at
    // a fixed bitrate (size ∝ time) and derive percent/ETA from the OUTPUT FILE
    // size, which the muxer grows continuously. Bitrate scales with resolution.
    // 救援转码（4.23.15）输出的是 **≤1080p** 的副本 ⇒ 码率按目标尺寸算，不按源尺寸，
    // 否则一份 5916×2530 的源会被算成 20 Mbps、产物反而比能播的那份还大。
    const pix = o.targetPixels && o.targetPixels > 0 ? o.targetPixels
      : (mi && mi.width && mi.height ? mi.width * mi.height : 3840 * 2160);
    const pixels = pix;
    const bitrate = Math.round(Math.min(20e6, Math.max(4e6, 20e6 * pixels / (3840 * 2160))));
    job.phase = 'transcode';
    job.downloaded = 0;
    job.total = 0;
    job.source = ff;
    job.outFile = out;
    job.expectedBytes = mi && mi.duration ? Math.round((bitrate / 8) * mi.duration) : null;
    job.samples = []; // [{t, size}] rolling samples for growth-rate / ETA
    // `vf` 缺省仍是抽帧（`fps=<cap>`）；救援转码走 `opts.vf`（缩放），见 transcodeToPlayable。
    const vf = typeof o.vf === 'string' && o.vf ? o.vf : 'fps=' + String(fps);
    const gop = Math.max(2, Math.min(240, Math.round(Number(fps) || 30) * 2));
    const base = ['-y', '-hide_banner', '-loglevel', 'error', '-i', abs,
      '-map', '0:v:0', '-an',
      '-vf', vf, '-g', String(gop)];
    // 救援转码必须落成 **8-bit 4:2:0**：10-bit（yuv420p10le）与 4:2:2 在 Chromium 上
    // 就是"无法解码"的那一类源 —— 只缩分辨率不管像素格式等于没修。
    if (o.pixFmt) base.push('-pix_fmt', String(o.pixFmt));
    // ★ 质量参数必须**按编码器**给：`-preset p1` 是 NVENC 专属，软件编码器会直接报
    //   `x264 [error]: invalid preset 'p1'` ⇒ 光把 -c:v 换成 libx264 也是死。
    //   自动下载的 ffmpeg-static（johnvansickle）**不含 NVENC**（`-encoders` 里没有
    //   h264_nvenc/av1_nvenc），所以在没有系统 ffmpeg 的机器上，软件兜底是唯一出路。
    const ENC_TUNE = {
      av1_nvenc: ['-preset', 'p1', '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2)],
      h264_nvenc: ['-preset', 'p1', '-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2)],
      // 软件兜底：capped CRF（不叠 -b:v，避免与 crf 语义打架）。一次性缓存，慢一点可接受。
      libx264: ['-preset', 'veryfast', '-crf', '20'],
    };
    // 输出时长限制: 部分源视频容器帧率信息异常 (实测 100k fps/100k tbn),
    // 这种输入下 `-r fps` 纠正不了 → ffmpeg 按输入帧率解码并大量复制帧 (5 万帧)
    // 卡死 + 长时间占满 CPU。fps 滤镜做正确 CFR 采样 + -t 限制输出时长。
    if (mi && mi.duration && isFinite(mi.duration) && mi.duration > 0) {
      base.push('-t', String(mi.duration));
    }
    // 整个任务所有编码尝试共享一个 deadline（见 TRANSCODE_TIMEOUT_MS 注释）：
    // 每次 spawn 只拿到剩余预算，避免「每种编码器各 15 分钟」的预算重计。
    const deadline = Date.now() + TRANSCODE_TIMEOUT_MS;
    let lastErr = null;
    // 顺序：AV1(NVENC) → H.264(NVENC) → **软件兜底 libx264**（救援转码只给 H.264，
    // 见 transcodeToPlayable —— AV1 在旧 Chromium 上反而解不了，救援不能赌）。
    const encoders = Array.isArray(o.encoders) && o.encoders.length
      ? o.encoders : ['av1_nvenc', 'h264_nvenc', 'libx264'];
    for (const enc of encoders) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        lastErr = new Error('transcode deadline exceeded (' + TRANSCODE_TIMEOUT_MS + 'ms total)');
        break;
      }
      try {
        // -f mp4 is REQUIRED: the temp output path ends in ".tmp<pid>", which
        // ffmpeg cannot map to a muxer by extension (it exits -22 on that).
        // `+faststart` 把 moov 挪到文件头：这几张源实测 moov 在**尾部**
        //（moovStart≈EOF，见 probeMp4），播放器要先把尾巴取回来才能开始解复用 ——
        // 产物若同样把 moov 留在尾部，就等于把这笔成本原样交给下一次播放。
        const tune = ENC_TUNE[enc] || [];
        await spawnFfmpeg(ff, [...base, ...tune, '-c:v', enc, '-movflags', '+faststart', '-f', 'mp4', out],
          remaining, { signal });
        return;
      } catch (err) {
        lastErr = err; // try the next encoder (e.g. AV1 encode unsupported)
      }
    }
    throw new Error('ffmpeg transcode failed (ff=' + ff + ')'
      + (lastErr ? ': ' + lastErr.message : '')
      + (lastFfmpegDownloadError ? ' | download: ' + lastFfmpegDownloadError : ''));
  }

  /**
   * 抽帧缓存的**键**：`abs | round(mtimeMs) | fps` 的 sha256 前 20 位（纯函数）。
   * 转码（写）与"这个上限有没有缓存"（读）必须共用它 —— 两处各算一份就会漂移，
   * 而漂移的症状是"客户端被告知有缓存、请求却打不中"（或反过来：永远轮不到缓存）。
   */
  function transcodeCacheKey(abs, mtimeMs, fps) {
    return createHash('sha256')
      .update(abs + '|' + Math.round(mtimeMs) + '|' + fps)
      .digest('hex').slice(0, 20);
  }

  /**
   * 只读地问"这个 (源, 上限) 的抽帧版在不在盘上" —— **绝不转码、绝不建目录**。
   *
   * 用途：`/media-info?fps=` 把它答给客户端，客户端于是能在**建层之前**就知道该用
   * 抽帧版当 `src`（见 src/video-layer.js 的 refreshMediaInfo / buildVideoMedia），
   * 不必"先取原片、再等探针回来换源"。源文件不可 stat（已删/无权限）⇒ null（当作没缓存）。
   */
  function transcodeCachePathFor(abs, fps) {
    /** @type {import('node:fs').Stats} */
    let st;
    try { st = statSync(abs); } catch { return null; }
    return join(transcodeCacheDir(), 'tc_' + transcodeCacheKey(abs, st.mtimeMs, fps) + '.mp4');
  }

  /** Transcode to <fps> with a disk cache keyed by abs-path + mtime + fps. */
  function transcodeToFps(abs, fps, onEntry) {
    const st = statSync(abs);
    const key = transcodeCacheKey(abs, st.mtimeMs, fps);
    const cachePath = join(ensureTranscodeCacheDir(), 'tc_' + key + '.mp4');
    if (existsSync(cachePath)) return Promise.resolve(cachePath);
    let entry = TRANSCODE_INFLIGHT.get(cachePath);
    if (entry) {
      // 在途命中：加入者也要过 onEntry（路由在它里面 registerTranscodeWaiter）。
      // 直接 `return entry.promise` 会让加入者永远进不了账本 ⇒ waiters 只算发起者一个
      // ⇒ 发起者一断开就 cancel（kill ffmpeg + 删 tmp），而仍在等的其他客户端拿到 502。
      // 账本语义（见 registerTranscodeWaiter）本来就是「**所有**等待者断开才 cancel」。
      if (typeof onEntry === 'function') onEntry(entry);
      return entry.promise;
    }
    // 取消: 所有等待者断开 (切换壁纸) 时终止转码 — kill ffmpeg 释放 CPU + 删 tmp
    // (没有这条取消, 卡死的转码要等 15 分钟硬超时才被杀, 期间占满 CPU)
    const ctrl = new AbortController();
    // ⚠️ 临时名必须**每次调用唯一**（`atomicTmpPath` = `.tmp<pid><递增序号>`），且在**开跑之前**
    // 就定下来，好让 `cancel()` 与任务体共用同一个路径。
    // 若用同一个确定性名（如 `cachePath + '.tmp' + pid`）会有一处"删兄弟产物"的静默缺陷：
    // `cancel()` 会立刻把条目从 `TRANSCODE_INFLIGHT` 删掉 ⇒ 新任务能在旧任务收尾**之前**用同一
    // 路径开跑，而旧任务 `catch` 里那句 `unlinkSync(tmp)` 删掉的正是**新任务正在写的产物**。
    const tmp = atomicTmpPath(cachePath);
    const cancel = () => {
      if (ctrl.signal.aborted) return;
      ctrl.abort();
      try { unlinkSync(tmp); } catch { /* ignore */ }
      TRANSCODE_INFLIGHT.delete(cachePath);
    };
    const p = (async () => {
      const progKey = abs + '|' + fps;
      // 并发闸：排队等待期间 deadline 未启动（deadline 在 runFfmpegTranscode
      // 内、拿到闸之后才开始计时）。
      await acquireTranscodeSlot();
      try {
        await runFfmpegTranscode(abs, tmp, fps, ctrl.signal);
        renameSync(tmp, cachePath);
        const job = transcodeJobs.get(progKey);
        if (job) job.phase = 'done';
        return cachePath;
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        const job = transcodeJobs.get(progKey);
        if (job) job.phase = 'error';
        throw err; // surface the real ffmpeg error in the route's 502 detail
      } finally {
        releaseTranscodeSlot();
        if (TRANSCODE_INFLIGHT.get(cachePath) === entry) TRANSCODE_INFLIGHT.delete(cachePath);
      }
    })();
    entry = { promise: p, waiters: 0, cancel };
    TRANSCODE_INFLIGHT.set(cachePath, entry);
    if (typeof onEntry === 'function') onEntry(entry);
    return entry.promise;
  }

  // transcode 请求等待者注册: 路由 res close 时调用, 全部断开 → 取消转码
  function registerTranscodeWaiter(entry, res) {
    if (!entry) return;
    entry.waiters++;
    const onClose = () => {
      entry.waiters--;
      if (entry.waiters <= 0) entry.cancel();
    };
    res.once('close', onClose);
  }

  // ── 救援转码：**超出本机解码能力**的源 → 一份确定能播的 H.264 ≤1080p 副本（4.23.15）──
  // 与抽帧转码的区别（**别混用缓存**）：
  //   · 目的不同：抽帧是"压解码占用"（时间线/分辨率都不变）；救援是"让这份源能解出来"
  //     （分辨率 + 像素格式 + 编码三重保证），所以键、缓存目录前缀、编码器清单都不同；
  //   · 触发不同：抽帧由用户设的 `fpsCap` 驱动；救援由**播放失败**驱动；
  //   · 判据不同：救援**只接受 H.264 / yuv420p**。AV1 在旧 Chromium 上本身就是"解不了"
  //     的一员，救援拿它当首选等于赌用户的浏览器够新 —— 这不是救援该有的形式。
  const PLAYABLE_MAX_WIDTH = 1920;
  const PLAYABLE_MAX_HEIGHT = 1080;
  /** 救援产物的帧率上限（= 站点 1080p 变体那一档，实测可播；见 playableScaleFilter 的注释）。 */
  const PLAYABLE_FPS_CAP = 30;

  /**
   * 救援转码的缩放滤镜 + **帧率上限 30**（纯函数，判据见 `test/verify-media-selfheal.mjs`）。
   *
   * 为什么必须同时降帧（4.23.15 真机定因）：用户报"无法解码"的高画质壁纸**全是 4K@60**
   *（h264 High / yuv420p / 3840×2160@60 与 4320×2160@60）。4K 的**像素吞吐**才是瓶颈，
   * 而站点自己的 1080p 变体实测是 **1080p@30**、可以直接播 ⇒ 救援产物必须同档：
   * 只缩分辨率、帧率留在 60，等于把同一笔解码开销换个尺寸再赌一次。
   *
   * ⚠️ 这里的逗号是**滤镜之间的分隔符**（`scale=…,fps=30` 是两个滤镜串联，正解）；
   * 危险的是滤镜**参数内部**的逗号（`min(1920,iw)`），那种必须转义 —— 所以宽高算成
   * 两个整数，参数里一个逗号都没有。
   *
   * 规则：等比缩到 1920×1080 以内、宽高取偶数，再接 `fps=30`。
   * 尺寸未知 ⇒ `scale=1920:-2`（-2 = 按比例且保证偶数）。
   * @param {{ width?: number, height?: number } | null} mi
   * @returns {string}
   */
  function playableScaleFilter(mi, mode) {
    const w = Number(mi && mi.width) || 0;
    const h = Number(mi && mi.height) || 0;
    // ② 只降帧（用户口径：降帧优先、**分辨率不变**）—— 4K@60 ⇒ 4K@30。
    if (mode === 'fps') return 'fps=' + PLAYABLE_FPS_CAP;
    // ③ 缩分辨率（分辨率超限且没有 1080p 变体）：等比缩到 ≤1920×1080，同时降到 30fps。
    if (!(w > 0) || !(h > 0)) return 'scale=' + PLAYABLE_MAX_WIDTH + ':-2,fps=' + PLAYABLE_FPS_CAP;
    const k = Math.min(1, PLAYABLE_MAX_WIDTH / w, PLAYABLE_MAX_HEIGHT / h);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    return 'scale=' + even(w * k) + ':' + even(h * k) + ',fps=' + PLAYABLE_FPS_CAP;
  }

  /** 救援产物的缓存键：`abs | round(mtimeMs) | x1080-playable`（与抽帧键**不同前缀**，永不撞车）。 */
  function playableCacheKey(abs, mtimeMs, mode) {
    return createHash('sha256')
      .update(abs + '|' + Math.round(mtimeMs) + '|x1080-playable|' + String(mode || 'rescue'))
      .digest('hex').slice(0, 20);
  }

  /** 只读地问"这份源的救援副本在不在盘上"（**绝不转码、绝不建目录**）。 */
  function transcodePlayablePathFor(abs, opts) {
    const mode = (opts && opts.mode === 'fps') ? 'fps' : 'rescue';
    /** @type {import('node:fs').Stats} */
    let st;
    try { st = statSync(abs); } catch { return null; }
    return join(transcodeCacheDir(), 'tp_' + playableCacheKey(abs, st.mtimeMs, mode) + '.mp4');
  }

  /**
   * 产出一份"一定能播"的副本（缓存键 = 源路径 + mtime）。已在盘上 ⇒ 直接返回路径。
   *
   * 不做的事：**不判断该不该转**。判据（宽度/像素量/播放失败）在 `lib/media-verify.js`
   * 与调用点；这里只负责"给定源，给我一份 ≤1080p / H.264 / yuv420p 的 mp4"。
   * 失败一律抛（调用方据此给"本机不支持该编码"，绝不静默回退成"播原片"）。
   * @param {string} abs
   * @returns {Promise<string>}
   */
  function transcodeToPlayable(abs, opts) {
    const o = opts || {};
    /** `fps` = 只降帧（同分辨率）；`rescue` = 缩到 ≤1920×1080 再降帧。 */
    const mode = o.mode === 'fps' ? 'fps' : 'rescue';
    const st = statSync(abs);
    const cachePath = join(ensureTranscodeCacheDir(), 'tp_' + playableCacheKey(abs, st.mtimeMs, mode) + '.mp4');
    if (existsSync(cachePath)) return Promise.resolve(cachePath);
    const hit = TRANSCODE_INFLIGHT.get(cachePath);
    if (hit) return hit.promise;
    const ctrl = new AbortController();
    const tmp = atomicTmpPath(cachePath);
    const cancel = () => {
      if (ctrl.signal.aborted) return;
      ctrl.abort();
      try { unlinkSync(tmp); } catch { /* ignore */ }
      TRANSCODE_INFLIGHT.delete(cachePath);
    };
    const mi = getMediaInfo(abs);
    const targetPixels = (() => {
      const w = Number(mi && mi.width) || 0;
      const h = Number(mi && mi.height) || 0;
      if (!(w > 0) || !(h > 0)) return PLAYABLE_MAX_WIDTH * PLAYABLE_MAX_HEIGHT;
      const k = Math.min(1, PLAYABLE_MAX_WIDTH / w, PLAYABLE_MAX_HEIGHT / h);
      return Math.max(2, Math.round(w * k)) * Math.max(2, Math.round(h * k));
    })();
    /**
     * 在途条目：**先声明再赋值**（`let`），因为任务体的 `finally` 要读它。
     * 写成 `const entry = …` 在 IIFE 之后，会让 finally 在"任务比 IIFE 收尾更快"时
     * 撞上 TDZ（tsc 直接报 TS2448；运行期是 ReferenceError，而它发生在错误路径里
     * —— 那正是最难复现的一种）。
     * @type {null | { promise: Promise<string>, waiters: number, cancel: () => void }}
     */
    let entry = null;
    const p = (async () => {
      await acquireTranscodeSlot();
      try {
        await runFfmpegTranscode(abs, tmp, 0, ctrl.signal, {
          // 保住源时间线的节奏：救援只缩尺寸、不抽帧（抽帧是另一个功能）。
          vf: playableScaleFilter(mi, mode),
          pixFmt: 'yuv420p',
          encoders: ['h264_nvenc', 'libx264'],
          targetPixels,
        });
        renameSync(tmp, cachePath);
        return cachePath;
      } catch (err) {
        try { unlinkSync(tmp); } catch { /* ignore */ }
        throw err;
      } finally {
        releaseTranscodeSlot();
        if (entry && TRANSCODE_INFLIGHT.get(cachePath) === entry) TRANSCODE_INFLIGHT.delete(cachePath);
      }
    })();
    entry = { promise: p, waiters: 0, cancel };
    TRANSCODE_INFLIGHT.set(cachePath, entry);
    return p;
  }

  /**
   * 救援转码的**只读进度**（`{ percent, eta }`，拿不到就给 0/null）。
   *
   * 口径与抽帧那条 `GET /transcode-progress` **逐字相同**（percent = 产物文件增长 /
   * 期望字节，eta = 剩余字节 ÷ 近段速率）：两处各写一个估算法，就会出现"面板说 60%、
   * 实际已经收尾"这类互相矛盾。区别只有"键"：救援任务的键是 `abs|0`（不按 fps 分档）。
   *
   * 为什么需要它（用户明确要求）：转码是**几十秒到几分钟**级，而壁纸此时是黑的 ——
   * 没有数字的等待与卡死没有区别。
   * @param {string} abs
   * @returns {{ percent: number, eta: number | null, phase: string, finalizing: boolean }}
   */
  function transcodePlayableProgress(abs, expectedBytes) {
    const out = { percent: 0, eta: /** @type {number | null} */ (null), phase: 'idle', finalizing: false };
    const p = transcodeJobs.get(String(abs || '') + '|0');
    if (!p) return out;
    out.phase = String(p.phase || 'idle');
    if (out.phase === 'done') { out.percent = 100; return out; }
    if (out.phase !== 'transcode' || !p.outFile) return out;
    let size = 0;
    try { size = statSync(p.outFile).size; } catch { /* 还没建 */ }
    const want = Number(expectedBytes) || Number(p.expectedBytes) || 0;
    if (want > 0) out.percent = Math.min(99, Math.round((size / want) * 100));
    const now = Date.now();
    if (!Array.isArray(p.samples)) p.samples = [];
    p.samples.push({ t: now, size });
    if (p.samples.length > 24) p.samples.shift();
    if (p.samples.length >= 3 && want > 0) {
      const a = p.samples[0];
      const b = p.samples[p.samples.length - 1];
      const dt = (b.t - a.t) / 1000;
      const rate = dt > 0 ? (b.size - a.size) / dt : 0;
      if (rate > 0) {
        const rem = want - b.size;
        if (rem > 0) out.eta = Math.max(1, Math.round(rem / rate));
      }
    }
    if (out.percent >= 99) out.finalizing = true;
    return out;
  }

  // ── 门面接口面（其余全是族内私有）──────────────────────────────────────────
  // 门面在模块作用域同名解构，所以那边所有调用点逐字未变。
  return {
    ensureDirOnce,
    transcodeCacheDir,
    sweepTranscodeArtifacts,
    sweepCustomFrameTmp,
    resolveFfmpeg,
    spawnFfmpeg,
    transcodeToFps,
    // 4.23.15：救援转码（超解码上限的源 → 确定能播的 H.264 ≤1080p 副本）。
    transcodeToPlayable,
    transcodePlayablePathFor,
    transcodePlayableProgress,
    playableScaleFilter,
    registerTranscodeWaiter,
    transcodeCachePathFor,
    transcodeJobs,

    /** 卸载收尾（门面 fiber disposer 调用）；逐条理由注释与原 lib/index.js 的 disposer 相同。 */
    dispose() {
      // 目录创建记忆化 (ensureDirOnce) 只对本次 apply 的路径有意义, 卸载后同一
      // 模块实例可能被再次 apply 且路径不同 → 清空, 避免 Set 无界增长。
      ensuredDirs.clear();
      // 杀掉所有在途 ffmpeg 子进程：插件卸载 / HMR 后宿主再无权管理它们，
      // 不杀就是孤儿进程继续吃 CPU/GPU（detached 模式下尤甚）。它们写一半
      // 的 .tmp<pid> 输出留给下次 apply 的 sweepTranscodeArtifacts 清理。
      for (const proc of ACTIVE_FFMPEG) {
        if (proc.pid !== undefined) { try { proc.kill(); } catch { /* ignore */ } }
      }
      ACTIVE_FFMPEG.clear();
      // 在途转码任务置 error：正在轮询 transcode-progress 的客户端立刻看到
      // 失败并回退原始文件，而不是等一个永远不会 done 的任务。
      for (const job of transcodeJobs.values()) {
        if (job.phase === 'download' || job.phase === 'transcode') job.phase = 'error';
      }
      // 在途 Promise 本身无法取消，但其 finally 的 delete 对空 Map 是 no-op；
      // 清空后新 apply 的同名任务不会被旧的 inflight 条目误命中。
      TRANSCODE_INFLIGHT.clear();
    },
  };
}
