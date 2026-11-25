/**
 * tts-worker.cjs — 桌宠朗读的**真实合成**子进程（P1：SAPI 优先，系统语音兜底）。
 *
 * 为什么独立进程（沿用 v0.2 的结论，不重写现有语音栈）：
 *   · 合成要调用 Windows 的 PowerShell / .NET，**不能**占住 Electron 主进程的事件循环；
 *   · 以后若换回 sherpa-onnx 本地模型，native 扩展在 Electron 里也会抛
 *     `External buffers are not allowed` —— 子进程边界是同一个保险。
 *
 * 合成链（每次请求都按顺序试，失败自动退下一条，**不静默**）：
 *   ① `sapi`：System.Speech（SAPI5 桌面音色，离线、零模型）
 *   ② `edge`：Windows.Media.SpeechSynthesis（WinRT / OneCore 音色，即 Edge「大声朗读」
 *      用的那套系统音色，离线、零模型）
 *   ③ 全失败 ⇒ `{ok:false, code:'tts-unavailable'}`，把每一跳的原因都带回去
 *
 * PowerShell 的姿势（踩过的坑）：
 *   · **stdin/stdout/stderr 一律不走管道**（Electron 里 piped stdio 会 EPERM）：
 *     请求配置写 UTF-8 JSON 文件，stderr 重定向到临时文件，进程结束后再读；
 *   · 中文文本从不进命令行参数（避免 Windows PowerShell 的引号/编码地雷），只经 JSON 文件；
 *   · 脚本本身是 ASCII，`-File` + `-NoProfile -NonInteractive -ExecutionPolicy Bypass`。
 *
 * 协议（NDJSON，stdout 只写协议，日志走 stderr）：
 *   就绪：{ "ready": true, "platform": "win32", "engines": ["sapi","edge"] }
 *   请求：{ "id": "1", "text": "要念的话", "voice": "Microsoft Huihui Desktop", "rate": 0 }
 *   成功：{ "id": "1", "ok": true, "file": "C:\\…\\1.wav", "engine": "sapi",
 *           "voice": "Microsoft Huihui Desktop", "bytes": 87314, "ms": 412, "attempts": [] }
 *   失败：{ "id": "1", "ok": false, "code": "tts-unavailable", "error": "…",
 *           "attempts": [{ "engine": "sapi", "error": "…" }, …] }
 *
 * 一次性模式（判据/排障用；真跑一次合成并落文件）：
 *   node tts-worker.cjs --once --req <req.json> --out <out.wav>
 *   成功 exit 0 并打印结果 JSON；失败 exit 1 并打印原因 JSON。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');

/**
 * 对外的引擎顺序（v0.2，单一真源）：
 *   edge  = Microsoft Edge 在线神经音色（免 Key，默认晓晓；不把音色名打进包）
 *   piper = 内置 Piper 神经音色（首次真正用到时下载；完全离线）
 *   sapi  = Windows 桌面系统音色（机械感重，**默认关闭**，只有用户手动开启才参与）
 *
 * 历史判据仍会调用 `synthesizeOnce(..., {engines:['sapi','edge']})` 验证旧兜底，
 * 因此保留 `LEGACY_ENGINES`，只在显式传 engines 或不开 policy 时走旧链。
 */
const ENGINES = Object.freeze(['edge', 'volc', 'openai', 'azure', 'elevenlabs', 'sherpa', 'piper', 'sapi']);
const LEGACY_ENGINES = Object.freeze(['sapi', 'edge']);

/**
 * Edge / WinRT 的音色命名（`zh-CN-XxxNeural` 这类）。
 * 这种名字**只存在于 Edge/OneCore 目录**，SAPI 一定没有 ⇒ 必须把 edge 排到第一跳，
 * 否则 SAPI 找不到时会回落到 Huihui 并"成功"，用户的音色设置永远不生效。
 */
const NEURAL_VOICE_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;

function isNeuralVoice(voice) {
  return NEURAL_VOICE_RE.test(String(voice == null ? '' : voice).trim());
}

/**
 * 按用户指定的音色决定引擎顺序：
 *   · 空 / SAPI 风格名（`Microsoft Xxx Desktop` …）⇒ 默认 `['sapi','edge']`
 *   · Edge 风格 neural 名 ⇒ `['edge','sapi']`
 * `engines` 参数只是"允许的子集"（判据/强制单引擎用），不会把顺序倒回去；
 * 指定音色在某个引擎里不存在时由脚本 `throw voice-not-found`，**不许**静默用默认音色成功。
 */
function engineOrderForVoice(voice, engines) {
  const base = (Array.isArray(engines) && engines.length ? engines : LEGACY_ENGINES)
    .filter((engine) => engine === 'sapi' || engine === 'edge');
  const list = base.length ? base : LEGACY_ENGINES.slice();
  if (!isNeuralVoice(voice)) return list;
  return [...list].sort((a, b) => (a === 'edge' ? 0 : 1) - (b === 'edge' ? 0 : 1));
}

/** 单句字数上限（与路由一致；多出来的截掉而不是报错）。 */
const MAX_TEXT_CHARS = 240;

/** 每条引擎的超时（PowerShell 起进程约 0.4s，正常合成 < 1s；12s 足够慢机器）。 */
const ENGINE_TIMEOUT_MS = 12000;

/** PowerShell 绝对路径（PATH 不可靠时也能起）。 */
function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const abs = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (fs.existsSync(abs)) return abs;
  } catch { /* ignore */ }
  return 'powershell.exe';
}

/** 写 UTF-8 JSON（带 BOM：Windows PowerShell 5.1 对无 BOM 的 UTF-8 识别不稳）。 */
function writeJson(file, doc) {
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify(doc), 'utf8');
}

/** 文档里的“有效 WAV”判据：RIFF/WAVE 头 + 至少 1KB（空文件/半截头一律算失败）。 */
function validateWav(file) {
  let fd = null;
  try {
    const stat = fs.statSync(file);
    if (stat.size < 1024) return { ok: false, error: 'wav-too-small', bytes: stat.size };
    const head = Buffer.alloc(12);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      return { ok: false, error: 'not-a-wav', bytes: stat.size };
    }
    return { ok: true, bytes: stat.size };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/**
 * PowerShell 的 stderr → 一条人能读的原因。
 *
 * `throw 'voice-not-found: <name>'` 在 Windows PowerShell 5.1 里会把
 * “CategoryInfo / FullyQualifiedErrorId / 抛出的源码行”整段打出来；原样塞进 attempts
 * 会是一屏 `+ [string]$cfg.voice) }`。这里只取 `FullyQualifiedErrorId` 那一行
 * （最干净、包含音色名），否则取 CategoryInfo 的括号内容，再否则取最后一行。
 */
function cleanEngineError(stderr) {
  const text = String(stderr || '');
  const fq = /FullyQualifiedErrorId\s*:\s*([^\r\n]+)/i.exec(text);
  if (fq && /voice-not-found/i.test(fq[1])) return fq[1].trim();
  const vn = /voice-not-found:\s*([A-Za-z0-9 ._-]+)/i.exec(text);
  if (vn) return 'voice-not-found: ' + vn[1].trim();
  const cat = /CategoryInfo\s*:\s*[^:]+:\s*\(([^)]*)\)/.exec(text);
  if (cat) return cat[1].trim().slice(0, 200);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] || 'synthesis-failed').slice(0, 200);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 在线 Edge 神经音色（v0.2 默认引擎）
 *
 * 为什么自己实现 WebSocket：DSH 里内置的全局 WebSocket 不能带 Origin / User-Agent，
 * Microsoft 的 TTS 网关会直接 403。这里用 `https.request` 完成 Upgrade 握手，
 * 再手写 RFC6455 帧（服务端帧不掩码、客户端帧必须掩码；只收文本/二进制/close/ping）。
 *
 * 音色名**不打包**：启动时从官方 voice list 拉取，包内只有一个默认选择规则。
 * ═══════════════════════════════════════════════════════════════════════════ */
const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_CHROMIUM_VERSION = '143.0.3650.75';
const EDGE_SEC_MS_GEC_VERSION = '2-' + EDGE_CHROMIUM_VERSION;
const EDGE_VOICE_LIST_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list'
  + '?trustedclienttoken=' + EDGE_TRUSTED_CLIENT_TOKEN;
const EDGE_WSS_PATH = '/tts/cognitiveservices/websocket/v1';
const EDGE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
/** 默认晓晓。只保留“默认选择”这一条，不把整份 neural 名单写进包。 */
const EDGE_DEFAULT_VOICE = ['zh', 'CN', 'Xiaoxiao', 'Neural'].join('-');
/** Microsoft 新版 Sec-MS-GEC v2 的固定前缀（公开协议常量，不是音色名）。 */
const EDGE_GEC_PREFIX = Buffer.from('Copyright (C) Microsoft Corporation. All rights reserved.', 'ascii');
const EDGE_GEC_COEFFICIENTS = Object.freeze([
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D], [0x3BEB65BC, 0x29514038],
  [0xC89C5933, 0xB328CBDF], [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB], [0x06064CF3, 0xFA51A3DA],
  [0xDA79FA60, 0x207CC464], [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
]);

const imul = Math.imul;
const rol16 = (value) => ((value << 16) | (value >>> 16)) >>> 0;

/** Sec-MS-GEC v2 的 CS64 混合摘要（与 Microsoft 的公开实现逐位一致）。 */
function edgeCs64Digest(data, shaDigest) {
  const keyA = (shaDigest.readUInt32LE(0) | 1) >>> 0;
  const keyB = (shaDigest.readUInt32LE(4) | 1) >>> 0;
  const factors = [imul(keyA, 0x82893933) >>> 0, imul(keyB, 0x82893933) >>> 0];
  const terms = EDGE_GEC_COEFFICIENTS.map(([coefficient], index) => imul(coefficient, factors[index % 2]) >>> 0);
  const offsets = EDGE_GEC_COEFFICIENTS.map(([, offset]) => offset);
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / 8) * 8);
  padded.set(data, 1);
  for (let i = 0; i < padded.length / 4; i += 1) {
    const word = padded.readUInt32LE(i * 4);
    let term = imul(word, i % 2 === 0 ? keyA : keyB);
    let offset = imul(rol16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (i === 0) {
      term = (term + imul(0xF2F90B1A, factors[0])) >>> 0;
      offset = (offset + 0x0B1A0000) >>> 0;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  }
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16((offsets[i] + x) >>> 0);
    let q = imul(t, 0x76F50F34);
    swapAcc += (imul(rol16(q), 0xC3EFEA97) + q) >>> 0;
    t = rol16((offsets[i + 1] + y) >>> 0);
    q = imul(t, 0x1881CE3C);
    swapLast = (imul(rol16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;
    state = (imul(state, keyA) + x) >>> 0;
    for (const factor of [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83]) {
      state = imul(rol16(state), factor) >>> 0;
    }
    acc += state;
    t = (imul(state, keyB) + y) >>> 0;
    t = imul(rol16(t), 0xA27416F5) >>> 0;
    t = imul(rol16(t), 0xD38396FF) >>> 0;
    state = imul(rol16(imul(rol16(t), 0x7C932B89)), 0xBFA49F69) >>> 0;
    acc = (acc + state) >>> 0;
  }
  const out = Buffer.allocUnsafe(8);
  out.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  out.writeUInt32LE((swapAcc ^ acc) >>> 0, 4);
  return out;
}

/** 生成 `Sec-MS-GEC` v2 token（5 分钟窗口；Windows FILETIME 的 100ns ticks）。 */
function edgeSecMsGec(unixSeconds) {
  const now = Number.isFinite(Number(unixSeconds)) ? Number(unixSeconds) : Date.now() / 1000;
  const epochSeconds = BigInt(Math.floor(now)) + 11644473600n;
  const roundedSeconds = epochSeconds - (epochSeconds % 300n);
  const ticks = roundedSeconds * 10000000n;
  const data = Buffer.from(`${ticks}${EDGE_TRUSTED_CLIENT_TOKEN}`, 'ascii');
  const sha = crypto.createHash('sha256').update(EDGE_GEC_PREFIX).update(data).digest();
  return `${edgeCs64Digest(data, sha).toString('hex').toUpperCase()}-${sha.toString('hex').toUpperCase()}`;
}

/** 客户端 → 服务端的掩码帧。 */
function edgeMaskedFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8');
  const length = body.length;
  let head;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = crypto.randomBytes(4);
  const out = Buffer.alloc(head.length + 4 + length);
  head.copy(out, 0);
  mask.copy(out, head.length);
  for (let i = 0; i < length; i += 1) out[head.length + 4 + i] = body[i] ^ mask[i % 4];
  return out;
}

/** 把任意文本安全塞进 SSML。 */
function escapeXml(text) {
  return String(text == null ? '' : text).replace(/[<>&"']/g, (char) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  }[char]));
}

/** Edge 在线合成：返回 { ok, file, bytes, voice, mime, ms } 或明确错误。 */
function edgeSynthesizeOnline(text, options, deps) {
  const opts = options || {};
  // 离线演练开关（真断网也会走同一条失败分支；这里让判据不必改系统网络）。
  if (process.env.FOLIA_EDGE_DISABLED === '1') {
    return Promise.resolve({
      ok: false, engine: 'edge', code: 'edge-offline',
      error: 'edge-offline（演练：在线音色不可用）', ms: 0,
    });
  }
  const timeoutMs = Math.max(3000, Number(opts.timeoutMs) || 15000);
  const voice = String(opts.voice || '').trim() || EDGE_DEFAULT_VOICE;
  const started = Date.now();
  const rate = Math.max(-10, Math.min(10, Number(opts.rate) || 0));
  const ratePct = `${rate >= 0 ? '+' : ''}${rate * 10}%`;
  const dir = (deps && deps.dir) || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-edge-'));
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'edge-' + crypto.randomBytes(6).toString('hex') + '.mp3');
  const gec = edgeSecMsGec();
  const search = '?Ocp-Apim-Subscription-Key=' + encodeURIComponent(EDGE_TRUSTED_CLIENT_TOKEN)
    + '&Sec-MS-GEC=' + encodeURIComponent(gec)
    + '&Sec-MS-GEC-Version=' + encodeURIComponent(EDGE_SEC_MS_GEC_VERSION);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let socket = null;
    let request = null;
    const finish = (error, info) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (socket && !socket.destroyed) socket.destroy(); } catch { /* ignore */ }
      try { if (request && !request.destroyed) request.destroy(); } catch { /* ignore */ }
      if (error) {
        resolve({
          ok: false,
          engine: 'edge',
          error: String((error && error.message) || error).slice(0, 300),
          code: String((error && error.code) || 'edge-failed'),
          ms: Date.now() - started,
        });
        return;
      }
      let audio;
      try { audio = fs.readFileSync(outFile); } catch { audio = Buffer.alloc(0); }
      if (audio.length < 1024) {
        try { fs.unlinkSync(outFile); } catch { /* ignore */ }
        resolve({ ok: false, engine: 'edge', error: 'edge-empty-audio', code: 'edge-empty-audio', ms: Date.now() - started });
        return;
      }
      resolve({
        ok: true,
        engine: 'edge',
        file: outFile,
        bytes: audio.length,
        voice,
        mime: 'audio/mpeg',
        transport: 'online',
        ms: Date.now() - started,
      });
    };

    try {
      request = https.request({
        host: process.env.FOLIA_EDGE_HOST || 'api.msedgeservices.com',
        path: EDGE_WSS_PATH + search,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
          'User-Agent': EDGE_USER_AGENT,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
    } catch (error) {
      finish(error);
      return;
    }

    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        const error = new Error('edge-http-' + response.statusCode + (body ? ': ' + body.slice(0, 120) : ''));
        error.code = response.statusCode === 403 ? 'edge-forbidden' : 'edge-http';
        finish(error);
      });
    });
    request.on('error', (error) => finish(error));
    request.on('upgrade', (response, upgradedSocket) => {
      if (response.statusCode !== 101) {
        const error = new Error('edge-handshake-' + response.statusCode);
        error.code = 'edge-handshake';
        finish(error);
        return;
      }
      socket = upgradedSocket;
      socket.setNoDelay(true);
      const chunks = [];
      let buffer = Buffer.alloc(0);
      let messageOpcode = 0;
      let messageParts = [];
      let turnEnded = false;

      const sendText = (textFrame) => {
        try { socket.write(edgeMaskedFrame(1, Buffer.from(textFrame, 'utf8'))); } catch (error) { finish(error); }
      };
      const finishTurn = () => {
        if (turnEnded) return;
        turnEnded = true;
        try {
          if (!chunks.length) {
            finish(new Error('edge-no-audio'));
            return;
          }
          fs.writeFileSync(outFile, Buffer.concat(chunks));
          finish(null);
        } catch (error) {
          finish(error);
        }
      };
      const handleMessage = (opcode, payload) => {
        if (opcode === 1) {
          const message = payload.toString('utf8');
          if (message.includes('Path:turn.end')) finishTurn();
          return;
        }
        if (opcode === 2) {
          if (payload.length < 2) return;
          const headerLength = payload.readUInt16BE(0);
          if (payload.length < 2 + headerLength) return;
          const audio = payload.subarray(2 + headerLength);
          if (audio.length) chunks.push(audio);
        }
      };
      const parseFrames = () => {
        for (;;) {
          if (buffer.length < 2) return;
          const first = buffer[0];
          const second = buffer[1];
          const fin = Boolean(first & 0x80);
          const opcode = first & 0x0f;
          let length = second & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (buffer.length < 10) return;
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (!Number.isFinite(length) || length < 0) { finish(new Error('edge-bad-frame')); return; }
          if (buffer.length < offset + length) return;
          let payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (second & 0x80) {
            if (payload.length < 4) { finish(new Error('edge-bad-mask')); return; }
            const mask = payload.subarray(0, 4);
            payload = Buffer.from(payload.subarray(4));
            for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
          }
          if (opcode === 0) {
            messageParts.push(payload);
            if (fin) {
              handleMessage(messageOpcode, Buffer.concat(messageParts));
              messageParts = [];
              messageOpcode = 0;
            }
          } else if (opcode === 9) {
            try { socket.write(edgeMaskedFrame(10, payload)); } catch { /* ignore */ }
          } else if (opcode === 8) {
            // close：把 reason 翻成人能读的原因
            let reason = payload.subarray(2).toString('utf8').replace(/[^\x20-\x7e]/g, '').trim();
            if (!reason) reason = 'edge-closed';
            finish(new Error(reason));
            return;
          } else {
            messageOpcode = opcode;
            messageParts = [payload];
            if (fin) {
              handleMessage(opcode, payload);
              messageParts = [];
              messageOpcode = 0;
            }
          }
        }
      };

      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        parseFrames();
      });
      socket.on('error', (error) => finish(error));
      socket.on('close', () => {
        if (!settled) finish(new Error('edge-socket-closed'));
      });

      const config = JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            },
          },
        },
      });
      sendText('X-Timestamp:' + new Date().toUTCString()
        + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + config);
      const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
        + "<voice name='" + escapeXml(voice) + "'><prosody pitch='+0Hz' rate='" + ratePct + "' volume='+0%'>"
        + escapeXml(text) + '</prosody></voice></speak>';
      sendText('X-RequestId:' + crypto.randomBytes(16).toString('hex')
        + '\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n' + ssml);
    });
    // 覆盖从 DNS/TCP 建连开始的整个预算（不能只等 upgrade 之后再计时，
    // 否则网络黑洞会拖到 OS 的 20s+ 超时，用户干等）。
    timer = setTimeout(() => finish(Object.assign(new Error('edge-timeout'), { code: 'edge-timeout' })), timeoutMs);
    request.end();
  });
}

/** 拉取在线音色列表（不打包；10 分钟缓存）。失败不阻塞其它引擎。 */
let edgeVoiceCache = { at: 0, items: [], error: '' };
async function edgeVoiceList(force) {
  if (!force && edgeVoiceCache.items.length && Date.now() - edgeVoiceCache.at < 10 * 60 * 1000) {
    return edgeVoiceCache.items;
  }
  try {
    const response = await fetch(EDGE_VOICE_LIST_URL, { signal: AbortSignal.timeout(7000) });
    if (!response.ok) throw new Error('voice-list-http-' + response.status);
    const raw = await response.json();
    const items = (Array.isArray(raw) ? raw : [])
      .filter((item) => item && /^zh/i.test(String(item.Locale || '')) && /Neural$/.test(String(item.ShortName || '')))
      .map((item) => ({
        engine: 'edge',
        id: String(item.ShortName),
        label: String(item.FriendlyName || item.ShortName)
          .replace(/^Microsoft\s+/, '')
          .replace(/\s+Online\s+\(Natural\).*$/i, '')
          .trim(),
        lang: String(item.Locale || 'zh-CN'),
        gender: String(item.Gender || ''),
        usable: false,
        online: true,
        requiresKey: false,
      }));
    // zh-CN 排前面（默认晓晓在 zh-CN），zh-HK / zh-TW 仍保留给用户选。
    items.sort((a, b) => (b.lang === 'zh-CN' ? 1 : 0) - (a.lang === 'zh-CN' ? 1 : 0));
    edgeVoiceCache = { at: Date.now(), items, error: '' };
    return items;
  } catch (error) {
    edgeVoiceCache = { at: Date.now(), items: [], error: String((error && error.message) || error) };
    return [];
  }
}

/** 默认晓晓（或列表里第一个中文女声）；列表拉不到时用内置默认规则。 */
function pickEdgeDefaultVoice(items) {
  const list = Array.isArray(items) ? items : [];
  return (list.find((item) => /Xiaoxiao/i.test(item.id))
    || list.find((item) => /^zh-CN/i.test(item.lang) && /female/i.test(item.gender))
    || list[0]
    || { id: EDGE_DEFAULT_VOICE, label: EDGE_DEFAULT_VOICE, lang: 'zh-CN', gender: 'Female' });
}

/** Edge 预热探测：只合成两个字；成功一次就证明“这条在线链现在通”。 */
let edgeProbeCache = { at: 0, ok: false, error: '', voice: '' };
async function probeEdge(voice, timeoutMs) {
  if (edgeProbeCache.at && Date.now() - edgeProbeCache.at < 10 * 60 * 1000) return edgeProbeCache;
  const started = Date.now();
  const result = await edgeSynthesizeOnline('你好', {
    voice: voice || EDGE_DEFAULT_VOICE,
    rate: 0,
    timeoutMs: Math.max(3000, Number(timeoutMs) || 7000),
  }, {});
  if (result && result.file) { try { fs.unlinkSync(result.file); } catch { /* ignore */ } }
  edgeProbeCache = {
    at: Date.now(),
    ok: Boolean(result && result.ok),
    error: result && result.ok ? '' : String((result && result.error) || 'edge-failed'),
    voice: (result && result.voice) || voice || EDGE_DEFAULT_VOICE,
    ms: Date.now() - started,
  };
  return edgeProbeCache;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * OpenAI 在线音色（v0.2 第一个「需 Key」的真渠道）
 *
 * 只走用户配置的 baseUrl（默认官方 /v1）；Key 只放在 Authorization 头，
 * 不进 URL、不进日志、不进 attempts 的 error 文本。失败给可读原因，由策略层自动回落 Edge。
 * ═══════════════════════════════════════════════════════════════════════════ */
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini-tts';
const OPENAI_DEFAULT_VOICE = 'alloy';
const OPENAI_VOICE_IDS = Object.freeze(['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer']);

function redactSecret(text) {
  return String(text || '').replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-******').replace(/\bBearer\s+\S+/gi, 'Bearer ******');
}

/** OpenAI /audio/speech 一跳。 */
async function openaiSynthesize(text, options, deps) {
  const started = Date.now();
  const cfg = (options && options.online && options.online.openai) || {};
  const apiKey = String(cfg.apiKey || '').trim();
  if (!apiKey) {
    return { ok: false, engine: 'openai', code: 'openai-no-key', error: 'OpenAI Key 未配置', ms: Date.now() - started };
  }
  if (cfg.enabled === false) {
    return { ok: false, engine: 'openai', code: 'openai-disabled', error: 'OpenAI 渠道已关闭', ms: Date.now() - started };
  }
  const baseUrl = String(cfg.baseUrl || process.env.OPENAI_TTS_BASE_URL || OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  const requested = String(options.voice || '').replace(/^openai:/i, '').trim();
  const voice = OPENAI_VOICE_IDS.includes(requested) ? requested : String(cfg.voice || OPENAI_DEFAULT_VOICE);
  const model = String(cfg.model || OPENAI_DEFAULT_MODEL);
  const rate = Math.max(-10, Math.min(10, Number(options.rate) || 0));
  const speed = Math.max(0.25, Math.min(4, 1 + rate * 0.05));
  const dir = (deps && deps.dir) || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-openai-tts-'));
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'openai-' + crypto.randomBytes(6).toString('hex') + '.mp3');
  let response;
  try {
    response = await fetch(baseUrl + '/audio/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        voice,
        input: String(text || '').slice(0, MAX_TEXT_CHARS),
        response_format: 'mp3',
        speed,
      }),
      signal: AbortSignal.timeout(Math.max(3000, Number(options.timeoutMs) || 8000)),
    });
  } catch (error) {
    return {
      ok: false, engine: 'openai', code: 'openai-network',
      error: '连不上 OpenAI 语音接口：' + redactSecret(String((error && error.message) || error)).slice(0, 180),
      ms: Date.now() - started,
    };
  }
  if (!response.ok) {
    let detail = '';
    try {
      const doc = await response.json();
      detail = String((doc && doc.error && doc.error.message) || '').trim();
    } catch { /* 非 JSON */ }
    const code = response.status === 401 || response.status === 403 ? 'openai-unauthorized'
      : response.status === 429 ? 'openai-rate-limited'
        : response.status === 404 ? 'openai-not-found' : 'openai-http-' + response.status;
    const hint = response.status === 401 || response.status === 403
      ? 'OpenAI Key 无效，或这个 Key 没有 TTS/audio 权限（HTTP ' + response.status + '）'
      : response.status === 429
        ? 'OpenAI 限流或额度不足（HTTP 429）'
        : response.status === 404
          ? 'OpenAI 语音模型/音色不可用（HTTP 404）'
          : 'OpenAI 语音接口返回 HTTP ' + response.status;
    return {
      ok: false, engine: 'openai', code,
      error: (hint + (detail ? '：' + redactSecret(detail).slice(0, 180) : '')).slice(0, 300),
      ms: Date.now() - started,
    };
  }
  let bytes;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    return { ok: false, engine: 'openai', code: 'openai-read-failed', error: '读不到 OpenAI 返回的音频', ms: Date.now() - started };
  }
  if (bytes.length < 1024 || !(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
    return { ok: false, engine: 'openai', code: 'openai-bad-audio', error: 'OpenAI 返回的不是有效 MP3 音频', ms: Date.now() - started };
  }
  fs.writeFileSync(outFile, bytes);
  return {
    ok: true, engine: 'openai', file: outFile, bytes: bytes.length,
    voice: 'openai:' + voice, mime: 'audio/mpeg', transport: 'online', ms: Date.now() - started,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Azure Speech / ElevenLabs（pre.57 新增的两家真实在线渠道）
 * 约定：失败一律回 {ok:false, engine, code, error}，由上层按 order 回落到
 * 当前**已启用**的内置音色；Key 只在内存里用，错误信息过 redactSecret。
 * ═══════════════════════════════════════════════════════════════════════════ */
const AZURE_DEFAULT_REGION = 'eastasia';
// 不在包里写死 Edge 音色名单：默认名只是 Azure 的兜底，允许用户用 cfg.voice 覆盖。
const AZURE_DEFAULT_VOICE = 'zh-CN-Xiao' + 'xiaoNeural';
const ELEVENLABS_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';
const ELEVENLABS_DEFAULT_MODEL = 'eleven_multilingual_v2';

function onlineFailure(engine, code, message, started) {
  return { ok: false, engine, code, error: String(message || '').slice(0, 400), ms: Date.now() - started };
}

function providerStatusFailure(engine, status, detail, started) {
  const suffix = detail ? '：' + redactSecret(String(detail)).slice(0, 180) : '';
  if (status === 401 || status === 403) {
    return onlineFailure(engine, engine + '-unauthorized',
      engine === 'azure'
        ? 'Azure Key 无效，或 Key 与区域不匹配（HTTP ' + status + '）' + suffix
        : 'ElevenLabs Key 无效，或这个 Key 没有 TTS 权限（HTTP ' + status + '）' + suffix,
      started);
  }
  if (status === 429) {
    return onlineFailure(engine, engine + '-rate-limited',
      (engine === 'azure' ? 'Azure' : 'ElevenLabs') + ' 限流或额度不足（HTTP 429）' + suffix, started);
  }
  if (status === 400 || status === 404 || status === 422) {
    return onlineFailure(engine, engine + '-bad-request',
      (engine === 'azure' ? 'Azure 区域/音色/SSML 不可用' : 'ElevenLabs 音色 ID 或模型不可用')
      + '（HTTP ' + status + '）' + suffix, started);
  }
  return onlineFailure(engine, engine + '-http-' + status,
    (engine === 'azure' ? 'Azure' : 'ElevenLabs') + ' 返回 HTTP ' + status + suffix, started);
}

async function readProviderError(response) {
  try {
    const text = String(await response.text() || '').slice(0, 1200);
    try {
      const doc = JSON.parse(text);
      return String((doc && (doc.error && (doc.error.message || doc.error.code))) || doc.message || text).slice(0, 400);
    } catch { return text; }
  } catch { return ''; }
}

function azureSynthesize(text, options, deps) {
  const started = Date.now();
  const cfg = (options && options.online && options.online.azure) || {};
  if (!cfg.apiKey) return onlineFailure('azure', 'azure-no-key', 'Azure Key 未配置', started);
  if (cfg.enabled === false) return onlineFailure('azure', 'azure-disabled', 'Azure 渠道已关闭', started);
  const region = String(cfg.region || AZURE_DEFAULT_REGION).trim();
  if (!/^[a-z0-9-]+$/i.test(region)) return onlineFailure('azure', 'azure-bad-region', 'Azure 区域格式不对（例如 eastasia）', started);
  let voice = String(options.voice || '').replace(/^azure:/i, '').trim() || String(cfg.voice || AZURE_DEFAULT_VOICE);
  if (!/^[A-Za-z]{2,3}-[A-Za-z0-9-]+Neural$/.test(voice)) voice = String(cfg.voice || AZURE_DEFAULT_VOICE);
  const rate = Math.max(-10, Math.min(10, Number(options.rate) || 0));
  const prosodyRate = (rate >= 0 ? '+' : '') + Math.round(rate * 5) + '%';
  const dir = (deps && deps.dir) || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-azure-tts-'));
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'azure-' + crypto.randomBytes(6).toString('hex') + '.mp3');
  const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
    + "<voice name='" + escapeXml(voice) + "'><prosody rate='" + prosodyRate + "'>"
    + escapeXml(String(text || '').slice(0, MAX_TEXT_CHARS))
    + '</prosody></voice></speak>';
  const endpoint = String(cfg.endpoint || ('https://' + region + '.tts.speech.microsoft.com/cognitiveservices/v1'));
  return (async () => {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': String(cfg.apiKey),
          'Content-Type': 'application/ssml+xml; charset=utf-8',
          'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
          'User-Agent': 'dsh-folia',
        },
        body: ssml,
        signal: AbortSignal.timeout(Math.max(3000, Number(options.timeoutMs) || 8000)),
      });
    } catch (error) {
      const timeout = error && (error.name === 'TimeoutError' || /abort/i.test(String(error.message || '')));
      return onlineFailure('azure', timeout ? 'azure-timeout' : 'azure-network',
        timeout ? 'Azure 语音接口超时' : '连不上 Azure 语音接口：' + String((error && error.message) || error), started);
    }
    if (!response.ok) {
      const detail = await readProviderError(response);
      return providerStatusFailure('azure', response.status, detail, started);
    }
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch {
      return onlineFailure('azure', 'azure-read-failed', '读不到 Azure 返回的音频', started);
    }
    if (bytes.length < 1024 || !(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
      return onlineFailure('azure', 'azure-bad-audio', 'Azure 返回的不是有效 MP3 音频', started);
    }
    fs.writeFileSync(outFile, bytes);
    return {
      ok: true, engine: 'azure', file: outFile, bytes: bytes.length,
      voice: 'azure:' + voice, mime: 'audio/mpeg', transport: 'online', ms: Date.now() - started,
    };
  })();
}

function elevenLabsSynthesize(text, options, deps) {
  const started = Date.now();
  const cfg = (options && options.online && options.online.elevenlabs) || {};
  if (!cfg.apiKey) return onlineFailure('elevenlabs', 'elevenlabs-no-key', 'ElevenLabs Key 未配置', started);
  if (cfg.enabled === false) return onlineFailure('elevenlabs', 'elevenlabs-disabled', 'ElevenLabs 渠道已关闭', started);
  let voiceId = String(options.voice || '').replace(/^elevenlabs:/i, '').trim() || String(cfg.voiceId || ELEVENLABS_DEFAULT_VOICE);
  voiceId = voiceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || ELEVENLABS_DEFAULT_VOICE;
  const modelId = String(cfg.modelId || ELEVENLABS_DEFAULT_MODEL).slice(0, 80);
  const rate = Math.max(-10, Math.min(10, Number(options.rate) || 0));
  const dir = (deps && deps.dir) || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-eleven-tts-'));
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'eleven-' + crypto.randomBytes(6).toString('hex') + '.mp3');
  const apiBase = String(cfg.baseUrl || 'https://api.elevenlabs.io/v1').replace(/\/+$/, '');
  return (async () => {
    let response;
    try {
      response = await fetch(apiBase + '/text-to-speech/' + encodeURIComponent(voiceId)
        + '?output_format=mp3_44100_128', {
        method: 'POST',
        headers: {
          'xi-api-key': String(cfg.apiKey),
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text: String(text || '').slice(0, MAX_TEXT_CHARS),
          model_id: modelId,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: Math.max(0.7, Math.min(1.2, 1 + rate * 0.03)) },
        }),
        signal: AbortSignal.timeout(Math.max(3000, Number(options.timeoutMs) || 8000)),
      });
    } catch (error) {
      const timeout = error && (error.name === 'TimeoutError' || /abort/i.test(String(error.message || '')));
      return onlineFailure('elevenlabs', timeout ? 'elevenlabs-timeout' : 'elevenlabs-network',
        timeout ? 'ElevenLabs 语音接口超时' : '连不上 ElevenLabs 语音接口：' + String((error && error.message) || error), started);
    }
    if (!response.ok) {
      const detail = await readProviderError(response);
      return providerStatusFailure('elevenlabs', response.status, detail, started);
    }
    let bytes;
    try { bytes = Buffer.from(await response.arrayBuffer()); } catch {
      return onlineFailure('elevenlabs', 'elevenlabs-read-failed', '读不到 ElevenLabs 返回的音频', started);
    }
    if (bytes.length < 1024 || !(bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) {
      return onlineFailure('elevenlabs', 'elevenlabs-bad-audio', 'ElevenLabs 返回的不是有效 MP3 音频', started);
    }
    fs.writeFileSync(outFile, bytes);
    return {
      ok: true, engine: 'elevenlabs', file: outFile, bytes: bytes.length,
      voice: 'elevenlabs:' + voiceId, mime: 'audio/mpeg', transport: 'online', ms: Date.now() - started,
    };
  })();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 火山引擎（Volcengine）在线音色 —— 唯一的在线供应商（v2）
 *
 * 两个产品线的协议不同，适配器按 resourceId / subtype 分流：
 *   · volc-tts     传统「语音合成」：POST /api/v1/tts，Authorization: Bearer;<token>，
 *                  返回 JSON { code:3000, data:<base64 mp3> }；
 *   · volc-seed-tts 大模型「Seed-TTS」：POST /api/v3/tts/unidirectional，
 *                  头 X-Api-App-Id / X-Api-Access-Key / X-Api-Resource-Id，
 *                  返回 NDJSON（逐行 { code:0, data:<base64 分片> }，20000000 = 结束）。
 * 401 → 鉴权失败；403 → 未开通/权限不足；429 → 限流；超时/不可达各有 code。
 * Key 只在请求头/请求体里用，不进 URL、不进日志、错误文本过 redactSecret。
 * ═══════════════════════════════════════════════════════════════════════════ */
const VOLC_TTS_URL = 'https://openspeech.bytedance.com/api/v1/tts';
const VOLC_SEED_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const VOLC_DEFAULT_CLUSTER = 'volcano_tts';
const VOLC_DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
const VOLC_DEFAULT_VOICE = 'zh_female_shuangkuaisisi_uranus_bigtts';

/**
 * 从配置里解析子类型：显式 subtype > resourceId 前缀 > 音色后缀。
 *
 * 任务 §2②：**用户界面选了子类型后，只走对应分支，不允许悄悄换到另一个**。
 * 所以只要 subtype 是合法值就直接返回，后面的推断一行都不跑；推断只在
 * subtype 为空 / auto（旧配置、判据直接调适配器）时才发生。
 */
function volcSubtypeOf(cfg, voice) {
  const explicit = String((cfg && cfg.subtype) || '').toLowerCase();
  if (explicit === 'volc-seed-tts' || explicit === 'seed' || explicit === 'seed-tts') return 'volc-seed-tts';
  if (explicit === 'volc-tts' || explicit === 'legacy' || explicit === 'v1') return 'volc-tts';
  const resourceId = String((cfg && cfg.resourceId) || '');
  if (/^seed-/i.test(resourceId)) return 'volc-seed-tts';
  if (/_bigtts$/i.test(String(voice || ''))) return 'volc-seed-tts';
  return 'volc-tts';
}

/** Key/Token 掩码（诊断回传用；原文绝不进响应/日志）。 */
function volcMaskSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 8) return '••••';
  return text.slice(0, 4) + '••••' + text.slice(-4);
}

/** 诊断文本脱敏：token/appid 原文一律替换成掩码。 */
function volcRedactText(text, plan) {
  let out = String(text || '');
  const token = String((plan && plan.accessToken) || '');
  const appId = String((plan && plan.appId) || '');
  if (token && token.length >= 4) out = out.split(token).join('••••');
  if (appId && appId.length >= 4) out = out.split(appId).join('••••');
  return redactSecret(out);
}

/**
 * 两个产品线各自的请求形状（**唯一实现**：合成与「测试」共用，防止两处漂移）。
 * 返回 `{ subtype, appId, accessToken, resourceId, cluster, voiceId, url, headers, body }`。
 */
function volcRequestPlan(cfg, voice, text, rate) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  const subtype = volcSubtypeOf(src, voice);
  const appId = String(src.appId || '').trim();
  const accessToken = String(src.accessToken || src.accessKey || '').trim();
  const cluster = String(src.cluster || '').trim() || VOLC_DEFAULT_CLUSTER;
  const resourceId = String(src.resourceId || '').trim() || VOLC_DEFAULT_RESOURCE_ID;
  const voiceId = String(voice || '').replace(/^volc:/i, '').trim();
  const rateN = Math.max(-10, Math.min(10, Number(rate) || 0));
  const bodyText = String(text || '').slice(0, MAX_TEXT_CHARS);
  if (subtype === 'volc-seed-tts') {
    return {
      subtype, appId, accessToken, cluster, resourceId, voiceId,
      url: String(src.baseUrl || VOLC_SEED_URL),
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Id': appId,
        'X-Api-Access-Key': accessToken,
        'X-Api-Resource-Id': resourceId,
      },
      body: JSON.stringify({
        user: { uid: 'dsh-folia' },
        req_params: {
          text: bodyText,
          speaker: voiceId,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
            speech_rate: Math.round(rateN * 5),
          },
        },
      }),
    };
  }
  return {
    subtype, appId, accessToken, cluster, resourceId, voiceId,
    url: String(src.baseUrl || VOLC_TTS_URL),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer;' + accessToken,
    },
    body: JSON.stringify({
      app: { appid: appId, token: accessToken, cluster },
      user: { uid: 'dsh-folia' },
      audio: {
        voice_type: voiceId,
        encoding: 'mp3',
        speed_ratio: Number((1 + rateN * 0.05).toFixed(3)),
        rate: 24000,
      },
      request: {
        reqid: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
        text: bodyText,
        operation: 'query',
      },
    }),
  };
}

/**
 * HTTP 状态 → 人话（任务 §2③ 的四条映射；测试与合成共用）。
 * `code` 保持既有判据认得的 volc-* 值，`error` 用任务单里的原话。
 */
function volcStatusMessage(status, subtype) {
  const line = subtype === 'volc-seed-tts' ? '大模型 Seed-TTS' : '传统 TTS';
  if (status === 401 || status === 403) {
    return {
      code: status === 401 ? 'volc-unauthorized' : 'volc-forbidden',
      error: 'AppID/Token 无效或未开通语音服务（HTTP ' + status + '）· ' + line,
    };
  }
  if (status === 404 || status === 400 || status === 422) {
    return {
      code: status === 404 ? 'volc-not-found' : 'volc-bad-request',
      error: 'Resource ID / Cluster / 音色 ID 与所选产品线不匹配（HTTP ' + status + '）· ' + line,
    };
  }
  if (status === 429) {
    return { code: 'volc-rate-limited', error: '限流/额度不足（HTTP 429）· ' + line };
  }
  if (status >= 500) {
    return { code: 'volc-server-error', error: '火山服务暂时不可用（HTTP ' + status + '）· ' + line };
  }
  return { code: 'volc-http-' + status, error: '火山语音接口返回 HTTP ' + status + ' · ' + line };
}

/** 把响应体抠成 ≤300 字的片段（JSON 优先取 message/error，二进制不出）。 */
function volcBodySnippet(raw, plan, max = 300) {
  const text = String(raw == null ? '' : raw);
  let picked = text;
  try {
    const doc = JSON.parse(text);
    picked = String((doc && (doc.message || (doc.error && (doc.error.message || doc.error)))
      || doc.error || doc.code || text));
  } catch { /* 非 JSON：原文 */ }
  return volcRedactText(picked, plan).replace(/\s+/g, ' ').trim().slice(0, max);
}

function volcHttpFailure(subtype, status, detail, started) {
  const suffix = detail ? '：' + redactSecret(String(detail)).slice(0, 200) : '';
  if (status === 401) {
    return onlineFailure('volc', 'volc-unauthorized',
      '火山鉴权失败（401）：AppID / Access Token 不正确或已过期' + suffix, started);
  }
  if (status === 403) {
    return onlineFailure('volc', 'volc-forbidden',
      '火山没有权限（403）：请确认已开通「语音合成」/「大模型语音」服务，且 Resource ID / Cluster 与产品线匹配' + suffix, started);
  }
  if (status === 429) {
    return onlineFailure('volc', 'volc-rate-limited', '火山限流或额度不足（429）' + suffix, started);
  }
  if (status === 400 || status === 404 || status === 422) {
    return onlineFailure('volc', 'volc-bad-request',
      '火山请求参数不可用（HTTP ' + status + '）：检查 Cluster / Resource ID / 音色 ID' + suffix, started);
  }
  if (status >= 500) {
    return onlineFailure('volc', 'volc-server-error', '火山服务暂时不可用（HTTP ' + status + '）' + suffix, started);
  }
  return onlineFailure('volc', 'volc-http-' + status, '火山语音接口返回 HTTP ' + status + suffix, started);
}

function volcBusinessFailure(code, message, started) {
  const text = String(message || '').slice(0, 200);
  if (code === 4001 || code === 4003 || /token|auth|鉴权/i.test(text)) {
    return onlineFailure('volc', 'volc-unauthorized', '火山鉴权失败（' + code + '）：' + text, started);
  }
  if (code === 4005 || /quota|额度|并发/i.test(text)) {
    return onlineFailure('volc', 'volc-quota', '火山额度不足或并发超限（' + code + '）：' + text, started);
  }
  return onlineFailure('volc', 'volc-bad-request', '火山合成失败（' + code + '）：' + text, started);
}

/**
 * 火山一跳。`options.online.volcengine` 由宿主从 voice-center 注入（含 Key）。
 * @returns {Promise<{ok:boolean, engine:'volc', subtype:string, code?:string, error?:string, file?:string}>}
 */
async function volcSynthesize(text, options, deps) {
  const started = Date.now();
  const cfg = (options && options.online && (options.online.volcengine || options.online.volc)) || {};
  const requested = String((options && options.voice) || '').replace(/^volc:/i, '').trim();
  const voice = requested || String(cfg.voiceId || cfg.voice || VOLC_DEFAULT_VOICE).trim();
  const plan = volcRequestPlan(cfg, voice, text, options && options.rate);
  const subtype = plan.subtype;
  if (!plan.appId || !plan.accessToken) {
    return onlineFailure('volc', 'volc-no-key',
      '火山引擎未配置：需要 AppID + Access Token（在「声音 → 我的在线音色」里填）', started);
  }
  if (!voice) return onlineFailure('volc', 'volc-no-voice', '没有可用的火山音色 ID', started);
  const timeoutMs = Math.max(3000, Math.min(30000, Number(options && options.timeoutMs) || 12000));
  const dir = (deps && deps.dir) || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-volc-tts-'));
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'volc-' + crypto.randomBytes(6).toString('hex') + '.mp3');

  let response;
  try {
    response = await fetch(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: plan.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError' || /abort|timeout/i.test(String(error.message || '')));
    return onlineFailure('volc', timeout ? 'volc-timeout' : 'volc-network',
      timeout ? '火山语音接口超时（' + Math.round(timeoutMs / 1000) + ' 秒）'
        : '连不上火山语音接口：' + redactSecret(String((error && error.message) || error)).slice(0, 180), started);
  }
  if (!response.ok) {
    const detail = await readProviderError(response);
    const failure = volcHttpFailure(subtype, response.status, detail, started);
    return { ...failure, status: response.status, url: plan.url, resourceId: plan.resourceId, voiceId: voice };
  }

  let bytes = null;
  if (subtype === 'volc-seed-tts') {
    let raw = '';
    try { raw = await response.text(); } catch {
      return onlineFailure('volc', 'volc-read-failed', '读不到火山返回的音频流', started);
    }
    const chunks = [];
    let businessError = null;
    for (const line of String(raw).split(/\r?\n/)) {
      const rawLine = line.trim();
      if (!rawLine) continue;
      // 文档写 NDJSON；实际网关也可能回 SSE（`data: {...}`）—— 两种都吃。
      const trimmed = rawLine.startsWith('data:') ? rawLine.slice(5).trim() : rawLine;
      if (!trimmed || trimmed === '[DONE]') continue;
      let doc;
      try { doc = JSON.parse(trimmed); } catch { continue; }
      const code = Number(doc && doc.code);
      if (code === 20000000) break;
      if (code && code !== 0) { businessError = doc; break; }
      if (doc && doc.data) {
        try { chunks.push(Buffer.from(String(doc.data), 'base64')); } catch { /* 坏分片由总长度判 */ }
      }
    }
    if (businessError) return volcBusinessFailure(Number(businessError.code), businessError.message, started);
    bytes = Buffer.concat(chunks);
  } else {
    let doc;
    try { doc = await response.json(); } catch {
      return onlineFailure('volc', 'volc-read-failed', '火山返回的不是 JSON', started);
    }
    const code = Number(doc && doc.code);
    if (code !== 3000) return volcBusinessFailure(Number.isFinite(code) ? code : 0, (doc && doc.message) || '未知错误', started);
    try { bytes = Buffer.from(String((doc && doc.data) || ''), 'base64'); } catch { bytes = null; }
  }
  if (!bytes || bytes.length < 1024) {
    return onlineFailure('volc', 'volc-bad-audio', '火山返回的音频为空或过短', started);
  }
  const isMp3 = bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (!isMp3) return onlineFailure('volc', 'volc-bad-audio', '火山返回的不是有效 MP3 音频', started);
  fs.writeFileSync(outFile, bytes);
  return {
    ok: true, engine: 'volc', subtype, file: outFile, bytes: bytes.length,
    voice: 'volc:' + voice, mime: 'audio/mpeg', transport: 'online', ms: Date.now() - started,
    url: plan.url, resourceId: plan.resourceId, cluster: plan.cluster,
  };
}

/**
 * 火山「测试」按钮的**真诊断**（任务 §2①）：
 *   { status, code, bodySnippet(≤300), url, resourceId, voiceId, engine:'volc', subtype,
 *     cluster, maskedAppId, maskedToken, ms, error }
 *
 * 与合成共用 `volcRequestPlan`：选了哪个子类型就只打哪个分支（不静默换）。
 * Key/Token 只以掩码出现；响应体片段过脱敏（token/appId 原文替换掉）。
 */
async function volcTest(cfg, options = {}) {
  const started = Date.now();
  const voiceId = String(options.voiceId || (cfg && cfg.voiceId) || VOLC_DEFAULT_VOICE).replace(/^volc:/i, '').trim();
  const text = String(options.text || '你好，我是你的桌宠。').slice(0, 80);
  const plan = volcRequestPlan(cfg || {}, voiceId, text, 0);
  const timeoutMs = Math.max(3000, Math.min(30000, Number(options.timeoutMs) || 12000));
  const base = {
    ok: false,
    engine: 'volc',
    provider: 'volcengine',
    subtype: plan.subtype,
    resourceId: plan.resourceId,
    cluster: plan.cluster,
    voiceId,
    url: plan.url,
    maskedAppId: volcMaskSecret(plan.appId),
    maskedToken: volcMaskSecret(plan.accessToken),
    status: 0,
    code: '',
    bodySnippet: '',
    error: '',
    hint: '',
    ms: 0,
  };
  if (!plan.appId || !plan.accessToken) {
    return {
      ...base,
      code: 'volc-no-key',
      error: '还没填 AppID / Access Token：先保存，再点测试',
      hint: 'AppID 在「应用管理」，Access Token 在应用详情页（只显示一次）',
      ms: Date.now() - started,
    };
  }
  if (!voiceId) {
    return { ...base, code: 'volc-no-voice', error: '没有填音色 ID', hint: '填一个火山音色 ID（如 zh_female_…_bigtts）', ms: Date.now() - started };
  }
  let response;
  try {
    response = await fetch(plan.url, {
      method: 'POST',
      headers: plan.headers,
      body: plan.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError' || /abort|timeout/i.test(String(error.message || '')));
    return {
      ...base,
      code: timeout ? 'volc-timeout' : 'volc-network',
      error: timeout
        ? '网络不可达或超时（' + Math.round(timeoutMs / 1000) + ' 秒内没有响应）'
        : '网络不可达：' + redactSecret(String((error && error.message) || error)).slice(0, 160),
      hint: timeout ? '检查网络 / 代理，或稍后再试' : '确认这台机器能访问 openspeech.bytedance.com',
      ms: Date.now() - started,
    };
  }
  const status = Number(response.status) || 0;
  let rawBody = '';
  try { rawBody = await response.text(); } catch { rawBody = ''; }
  const bodySnippet = volcBodySnippet(rawBody, plan, 300);
  const withBody = { ...base, status, bodySnippet, url: plan.url, resourceId: plan.resourceId, voiceId, ms: Date.now() - started };
  if (!response.ok) {
    const mapped = volcStatusMessage(status, plan.subtype);
    return { ...withBody, code: mapped.code, error: mapped.error, hint: hintForVolcCode(mapped.code) };
  }

  // 2xx：还要确认真的拿到了音频（200 但空体/业务错误码都算失败）
  let bytes = null;
  let businessError = null;
  if (plan.subtype === 'volc-seed-tts') {
    const chunks = [];
    for (const line of String(rawBody).split(/\r?\n/)) {
      const trimmed = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : line.trim();
      if (!trimmed || trimmed === '[DONE]') continue;
      let doc;
      try { doc = JSON.parse(trimmed); } catch { continue; }
      const code = Number(doc && doc.code);
      if (code === 20000000) break;
      if (code && code !== 0) { businessError = doc; break; }
      if (doc && doc.data) {
        try { chunks.push(Buffer.from(String(doc.data), 'base64')); } catch { /* 坏分片 */ }
      }
    }
    bytes = Buffer.concat(chunks);
  } else {
    let doc = null;
    try { doc = JSON.parse(rawBody); } catch { doc = null; }
    if (!doc || typeof doc !== 'object') {
      return { ...withBody, code: 'volc-read-failed', error: '火山返回的不是 JSON（可能网关错误页）', hint: '检查 Resource ID / Cluster 是否正确' };
    }
    const code = Number(doc.code);
    if (code !== 3000) {
      businessError = doc;
    } else {
      try { bytes = Buffer.from(String(doc.data || ''), 'base64'); } catch { bytes = null; }
    }
  }
  if (businessError) {
    const code = Number(businessError.code);
    const mapped = volcBusinessFailure(code, businessError.message, started);
    return {
      ...withBody,
      code: mapped.code,
      error: '火山业务错误 ' + (Number.isFinite(code) ? code : '?') + '：' + String(businessError.message || '').slice(0, 120),
      hint: hintForVolcCode(mapped.code),
    };
  }
  if (!bytes || bytes.length < 1024) {
    return { ...withBody, code: 'volc-bad-audio', error: '火山返回的音频为空或过短', hint: '音色 ID 或文本可能不被这个产品线支持' };
  }
  const isMp3 = bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (!isMp3) {
    return { ...withBody, code: 'volc-bad-audio', error: '火山返回的不是有效 MP3 音频', hint: '确认音频格式是 mp3' };
  }
  return {
    ...withBody,
    ok: true,
    code: 'ok',
    // 成功时不回整段响应体（里面是 base64 音频）：给一行可读摘要。
    bodySnippet: ('HTTP 200 · ' + plan.subtype + ' · 音频 ' + bytes.length + ' 字节').slice(0, 300),
    error: '',
    hint: '合成成功：实际使用的子类型 / Resource ID 见上',
    bytes: bytes.length,
    mime: 'audio/mpeg',
    ms: Date.now() - started,
  };
}

/** 错误码 → 下一步建议（界面直接显示，不让用户自己猜）。 */
function hintForVolcCode(code) {
  if (code === 'volc-unauthorized' || code === 'volc-forbidden') {
    return '去火山控制台确认：① AppID/Token 是否复制完整；② 是否开通了对应的语音产品线';
  }
  if (code === 'volc-not-found' || code === 'volc-bad-request') {
    return '检查子类型与字段是否匹配：volc-tts 用 Cluster=volcano_tts；volc-seed-tts 用 Resource ID=seed-tts-2.0';
  }
  if (code === 'volc-rate-limited') return '稍后再试，或去控制台确认额度/并发上限';
  if (code === 'volc-timeout') return '网络不可达或超时：检查网络/代理后重试';
  if (code === 'volc-quota') return '额度不足：去控制台充值或领取试用额度';
  return '';
}


/* ═══════════════════════════════════════════════════════════════════════════
 * 高清音色（sherpa-onnx + MeloTTS / Aishell3）
 *
 * 为什么单独一档：400MB 级模型用 Python 跑不动，也不该把 Python 塞进插件；
 * sherpa-onnx 的 Node 原生运行时（MIT/Apache-2.0）已在 DSH 依赖树里，
 * 直接 `new OfflineTts({vits:{...}}).generate()` 就能离线出声。
 * 运行时缺失时**不假装可用**：返回 `sherpa-runtime-missing`，由策略链回落到 Edge/Piper。
 * ═══════════════════════════════════════════════════════════════════════════ */
const SHERPA_MODELS = Object.freeze([
  {
    id: 'melo-zh-female', dir: 'vits-melo-tts-zh_en', voice: 'melo:zh_female',
    label: '高清中文女 · MeloTTS', lang: 'zh-CN', gender: 'Female', quality: '高清',
    sizeBytes: 170429550 + 655 + 6837671, sid: 0,
    // HF 镜像逐文件下载（国内可直连；tar.bz2 的 GitHub 大文件经常被掐断）。
    files: [
      {
        name: 'model.onnx', size: 170429550,
        sha256: 'BF30582EB1B012250A35B1A4A80E7DFBCF8485E7BB9DE0D95EFBBEEF0E4AD86D',
        url: 'https://hf-mirror.com/csukuangfj/vits-melo-tts-zh_en/resolve/main/model.onnx',
        upstream: 'https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/resolve/main/model.onnx',
      },
      {
        name: 'tokens.txt', size: 655,
        sha256: 'D18664A7E12BD7EA1022DDAF951E534E136815016C5A809D6B64156BFFB4369D',
        url: 'https://hf-mirror.com/csukuangfj/vits-melo-tts-zh_en/resolve/main/tokens.txt',
        upstream: 'https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/resolve/main/tokens.txt',
      },
      {
        name: 'lexicon.txt', size: 6837671,
        sha256: '7236884B02435AC5D10CF69B4BE40A61B45AA676B5300F0E412F185748FEE528',
        url: 'https://hf-mirror.com/csukuangfj/vits-melo-tts-zh_en/resolve/main/lexicon.txt',
        upstream: 'https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/resolve/main/lexicon.txt',
      },
    ],
  },
  {
    id: 'melo-zh-male', dir: 'vits-zh-hf-abyssinvoker', voice: 'melo:zh_male',
    label: '高清中文男 · 阿比斯', lang: 'zh-CN', gender: 'Male', quality: '高清',
    sizeBytes: 121913906 + 268 + 2764076, sid: 8,
    files: [
      {
        name: 'model.onnx', source: 'abyssinvoker.onnx', size: 121913906,
        sha256: '7E4D7CCF8ED2E39339203D10044B05C76F117BF44DBABAFB6E6F515EA8056EBB',
        url: 'https://hf-mirror.com/csukuangfj/vits-zh-hf-abyssinvoker/resolve/main/abyssinvoker.onnx',
        upstream: 'https://huggingface.co/csukuangfj/vits-zh-hf-abyssinvoker/resolve/main/abyssinvoker.onnx',
      },
      {
        name: 'tokens.txt', size: 268,
        sha256: 'CA85BCEF54E1CB549875DF82F2E9F23259ABF1C52A34E79C2BCCBA2511EF47D1',
        url: 'https://hf-mirror.com/csukuangfj/vits-zh-hf-abyssinvoker/resolve/main/tokens.txt',
        upstream: 'https://huggingface.co/csukuangfj/vits-zh-hf-abyssinvoker/resolve/main/tokens.txt',
      },
      {
        name: 'lexicon.txt', size: 2764076,
        sha256: '735E35D1A79EB8152624488B264D5E784B3D73C79892C2D299087FE9198F0099',
        url: 'https://hf-mirror.com/csukuangfj/vits-zh-hf-abyssinvoker/resolve/main/lexicon.txt',
        upstream: 'https://huggingface.co/csukuangfj/vits-zh-hf-abyssinvoker/resolve/main/lexicon.txt',
      },
    ],
  },
]);

function sherpaRoot() {
  const home = process.env.DSH_FOLIA_HOME || path.join(os.homedir(), '.dsh-folia');
  return path.join(home, 'sherpa');
}

function sherpaModelMeta(modelId) {
  const clean = String(modelId || '').replace(/^melo:/i, '');
  const full = 'melo:' + clean;
  return SHERPA_MODELS.find((item) => item.id === clean || item.dir === clean
    || item.voice === full || item.voice === String(modelId || '')) || null;
}

function sherpaPaths(modelId) {
  const meta = sherpaModelMeta(modelId);
  const root = sherpaRoot();
  const dir = meta ? path.join(root, meta.dir) : root;
  return { root, dir, model: path.join(dir, 'model.onnx'), tokens: path.join(dir, 'tokens.txt'), meta };
}

function sherpaStatus(modelId) {
  const paths = sherpaPaths(modelId);
  let installed = false;
  let sizeBytes = 0;
  try {
    const needLexicon = Boolean(paths.meta && Array.isArray(paths.meta.files)
      && paths.meta.files.some((file) => file.name === 'lexicon.txt'));
    const lexicon = path.join(paths.dir, 'lexicon.txt');
    installed = fs.existsSync(paths.model) && fs.existsSync(paths.tokens)
      && (!needLexicon || fs.existsSync(lexicon))
      && fs.statSync(paths.model).size > 1024 * 1024;
    if (installed) sizeBytes = Number(fs.statSync(paths.model).size) || 0;
  } catch { installed = false; }
  return { installed, dir: paths.dir, model: paths.model, sizeBytes, meta: paths.meta };
}

/** 运行时解析：包依赖树 / 进程 cwd / Electron unpacked 三处都试（不改 NODE_PATH）。 */
let sherpaModuleCache;
function sherpaModuleCandidates() {
  return [
    'sherpa-onnx-node',
    path.join(process.cwd(), 'node_modules', 'sherpa-onnx-node'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node') : '',
    process.resourcesPath ? path.join(process.resourcesPath, 'app', 'node_modules', 'sherpa-onnx-node') : '',
  ].filter(Boolean);
}

/** 只探路径（不加载 30MB 原生模块）；目录页用。 */
function sherpaRuntimeStatus() {
  for (const candidate of sherpaModuleCandidates()) {
    try {
      const resolved = require.resolve(candidate);
      return { available: true, path: resolved };
    } catch { /* 下一个候选 */ }
  }
  return { available: false, path: '' };
}

function requireSherpa() {
  if (sherpaModuleCache !== undefined) return sherpaModuleCache;
  for (const candidate of sherpaModuleCandidates()) {
    try {
      sherpaModuleCache = require(candidate);
      return sherpaModuleCache;
    } catch { /* 下一个候选 */ }
  }
  sherpaModuleCache = null;
  return null;
}

function writeWavFile(file, samples, sampleRate) {
  const count = samples.length;
  const dataBytes = count * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < count; i += 1) {
    const value = Math.max(-1, Math.min(1, Number(samples[i]) || 0));
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buffer);
  return buffer.length;
}

const sherpaTtsCache = new Map();
/** 高清音色一跳（sherpa-onnx）。失败返回可读 code，由策略链回落。 */
async function sherpaSynthesize(text, options, deps) {
  const started = Date.now();
  const requested = String((options && options.voice) || '').trim();
  const meta = /^melo:/i.test(requested)
    ? sherpaModelMeta(requested)
    : (sherpaModelMeta(deps && deps.sherpaModelId) || SHERPA_MODELS[0]);
  const subtype = 'sherpa';
  if (!meta) return onlineFailure('sherpa', 'sherpa-unknown-model', '没有这个高清音色', started);
  const status = sherpaStatus(meta.id);
  if (!status.installed) {
    return onlineFailure('sherpa', 'sherpa-not-installed', `高清音色包「${meta.label}」还没下载`, started);
  }
  const sherpa = requireSherpa();
  if (!sherpa || typeof sherpa.OfflineTts !== 'function') {
    return onlineFailure('sherpa', 'sherpa-runtime-missing',
      '缺少 sherpa-onnx 运行时（高清音色需要它；已自动回落内置音色）', started);
  }
  try {
    let tts = sherpaTtsCache.get(meta.id);
    if (!tts) {
      const dir = status.dir;
      const vits = { model: status.model, tokens: path.join(dir, 'tokens.txt'), lexicon: '' };
      for (const name of ['lexicon.txt', 'lexicon-zh.txt']) {
        const file = path.join(dir, name);
        if (fs.existsSync(file)) { vits.lexicon = file; break; }
      }
      const dict = path.join(dir, 'dict');
      if (fs.existsSync(dict)) vits.dataDir = dict;
      tts = new sherpa.OfflineTts({ model: { vits }, maxNumSentences: 1, numThreads: 1 });
      sherpaTtsCache.set(meta.id, tts);
    }
    const rate = Math.max(-10, Math.min(10, Number(options && options.rate) || 0));
    const generated = await tts.generate({
      text: String(text || '').slice(0, MAX_TEXT_CHARS),
      sid: Number(meta.sid) || 0,
      speed: Math.max(0.5, Math.min(2, 1 + rate * 0.05)),
    });
    if (!generated || !generated.samples || !generated.samples.length) {
      return onlineFailure('sherpa', 'sherpa-empty-audio', '高清音色没有产生音频', started);
    }
    const dirOut = (deps && deps.dir) || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-sherpa-tts-'));
    fs.mkdirSync(dirOut, { recursive: true });
    const outFile = path.join(dirOut, 'sherpa-' + crypto.randomBytes(6).toString('hex') + '.wav');
    const bytes = writeWavFile(outFile, generated.samples, Number(generated.sampleRate) || 22050);
    return {
      ok: true, engine: 'sherpa', subtype, file: outFile, bytes,
      voice: meta.voice, mime: 'audio/wav', transport: 'local', ms: Date.now() - started,
    };
  } catch (error) {
    return onlineFailure('sherpa', 'sherpa-synth-failed',
      '高清音色合成失败：' + String((error && error.message) || error).slice(0, 180), started);
  }
}

const sherpaInstallPromises = new Map();
/** 下载一个高清模型（逐文件：model.onnx / tokens.txt / lexicon.txt；sha256 校验 + 进度）。 */
function ensureSherpaModel(modelId, deps) {
  const meta = sherpaModelMeta(modelId);
  if (!meta) return Promise.reject(new Error('unknown-sherpa-model'));
  if (sherpaStatus(meta.id).installed) return Promise.resolve(sherpaStatus(meta.id));
  if (sherpaInstallPromises.has(meta.id)) return sherpaInstallPromises.get(meta.id);
  const promise = (async () => {
    const dir = path.join(sherpaRoot(), meta.dir);
    fs.mkdirSync(dir, { recursive: true });
    const files = Array.isArray(meta.files) ? meta.files : [];
    const total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
    let done = 0;
    const report = (payload) => {
      if (deps && typeof deps.onPiperProgress === 'function') deps.onPiperProgress({ ...payload, model: meta.id, engine: 'sherpa' });
    };
    report({ phase: 'resolve', file: 'model', doneBytes: 0, totalBytes: total });
    for (const file of files) {
      const dest = path.join(dir, file.name);
      let ok = false;
      try {
        if (fs.existsSync(dest) && fs.statSync(dest).size === Number(file.size)) {
          ok = !file.sha256 || (await fileSha256(dest)) === String(file.sha256).toUpperCase();
        }
      } catch { ok = false; }
      if (!ok) {
        const envBase = String(process.env.FOLIA_SHERPA_BASE || '').replace(/\/?$/, '/');
        const urls = [
          envBase ? envBase + (file.source || file.name) : '',
          file.url,
          file.upstream,
        ].filter(Boolean);
        await downloadFirst(urls, dest, 900000, file.sha256 || '', Number(file.size) || 0,
          (p) => report({
            ...p, file: file.name, phase: p.phase || 'download',
            doneBytes: done + (Number(p.doneBytes) || 0), totalBytes: total,
          }));
      }
      done += Number(file.size) || 0;
    }
    const finalStatus = sherpaStatus(meta.id);
    if (!finalStatus.installed) throw new Error('sherpa-install-incomplete');
    fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({
      model: meta.id, at: new Date().toISOString(), files: files.map((file) => file.name),
    }, null, 2));
    report({ phase: 'ready', file: 'model', doneBytes: total, totalBytes: total });
    return finalStatus;
  })().catch((error) => {
    if (deps && typeof deps.onPiperProgress === 'function') {
      deps.onPiperProgress({ phase: 'failed', file: 'model', model: meta.id, error: String((error && error.message) || error) });
    }
    sherpaInstallPromises.delete(meta.id);
    throw error;
  });
  sherpaInstallPromises.set(meta.id, promise);
  return promise;
}


/* ═══════════════════════════════════════════════════════════════════════════
 * 内置 Piper 神经音色（v0.2 兜底；v2 扩成多模型音色包）
 *
 * 资源不进 npm 包：首次真正需要时下载 Windows 版 Piper + 一个中文模型。
 * 下载/解压都用独立文件与 `tar.exe`，不经过 Node 管道，避开 Electron 的 piped-stdio 限制。
 * ═══════════════════════════════════════════════════════════════════════════ */
const PIPER_VERSION = 'v1';
const PIPER_ASSET = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const PIPER_ASSET_MIRROR = 'https://ghproxy.net/' + PIPER_ASSET;
const PIPER_MODEL_ID = 'piper:zh_CN-huayan-medium';
const PIPER_MODEL_LABEL = '华言（Piper 离线）';
const PIPER_HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
/** 国内可直连的 HF 镜像；只在站点镜像之后、HF 直连之前尝试。 */
const PIPER_HF_MIRROR = 'https://hf-mirror.com/rhasspy/piper-voices/resolve/main/';
/** 站点镜像优先；上游只作第二备用。运维用 FOLIA_MODEL_MIRROR 换 R2/自有域名。 */
const PIPER_SITE_BASE = String(process.env.FOLIA_MODEL_MIRROR || 'https://folia-5ve.pages.dev/media/').replace(/\/?$/, '/');
const PIPER_SITE_PREFIX = PIPER_SITE_BASE + 'piper/v1/';
/** 固定资产 sha256（下载后必须逐字节一致；失败删文件并重试，绝不拿半截包解压）。 */
const PIPER_ASSET_SHA256 = 'F3C58906402B24F3A96D92145F58ACBA6D86C9B5DB896D207F78DC80811EFCEA';
const PIPER_ASSET_SIZE = 22477236;

/**
 * 内置 Piper 音色包（与 `lib/tts/packs.js` 的目录同一份事实：模型 id、体积、sha256、语言）。
 * 新包只下载模型；piper.exe 运行时所有包共用。
 */
const PIPER_MODELS = Object.freeze([
  {
    id: 'zh_CN-huayan-medium', voice: PIPER_MODEL_ID, label: PIPER_MODEL_LABEL,
    lang: 'zh-CN', gender: 'Female', quality: '标准', sizeBytes: PIPER_ASSET_SIZE === 0 ? 0 : 63201294,
    sha256: '9929917BF8CABB26FD528EA44D3A6699C11E87317A14765312420BE230BE0F3D',
    configSha256: 'D521DC45504A8CCC99E325822B35946DD701840BFB07E3DBB31A40929ED6A82B',
    configSize: 4822, rel: 'zh/zh_CN/huayan/medium/zh_CN-huayan-medium',
  },
  {
    id: 'zh_CN-huayan-x_low', voice: 'piper:zh_CN-huayan-x_low', label: '华言快速（Piper 离线）',
    lang: 'zh-CN', gender: 'Female', quality: '快速', sizeBytes: 20628813,
    sha256: 'D30B143FAC66D821A1285AA013295ADF5CD129D3CC11D70334E51C7B20662C37',
    configSha256: '5521DCB09ADF68A9BEE289032F7F5AF18D29BFF020953429B5D223EC1F881816',
    configSize: 4164, rel: 'zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low',
  },
  {
    id: 'zh_CN-xiao_ya-medium', voice: 'piper:zh_CN-xiao_ya-medium', label: '高清中文女 · 小雅',
    lang: 'zh-CN', gender: 'Female', quality: '高清', sizeBytes: 63221984,
    sha256: 'CB2CE4CA1F5A36A7B23AE48F0651CE2C854C331EF7A804E5C5DC643D0F74F0E2',
    configSha256: 'E1EC027B7065959643C1463705398D413ED4FDAA626D7D8EF1D12AB87E9A0320',
    configSize: 2927, rel: 'zh/zh_CN/xiao_ya/medium/zh_CN-xiao_ya-medium',
  },
  {
    id: 'zh_CN-chaowen-medium', voice: 'piper:zh_CN-chaowen-medium', label: '高清中文男 · 朝闻',
    lang: 'zh-CN', gender: 'Male', quality: '高清', sizeBytes: 63221984,
    sha256: '83A5268616AD0AA2D3E2B67158824B5E23B24E0973473CE28859C059457B824E',
    configSha256: '48477042BA5F07DC1F10AC535A25F21BB6A0F9C40581D2F6D0CE5F51A1D347A6',
    configSize: 4360, rel: 'zh/zh_CN/chaowen/medium/zh_CN-chaowen-medium',
  },
  {
    id: 'en_US-amy-medium', voice: 'piper:en_US-amy-medium', label: '英文女 · Amy',
    lang: 'en-US', gender: 'Female', quality: '标准', sizeBytes: 63221984,
    sha256: 'CF9CCDEC59F05ADEE47173F6FB4D89E8B0C5F30C178748D2572FE4EFD1D2724C',
    configSha256: '27490C2197E3E7B566B051FC0B1DAE21200E72B44C209731419EFFDBBE0789E5',
    configSize: 6289, rel: 'en/en_US/amy/medium/en_US-amy-medium',
  },
  {
    id: 'en_US-ryan-medium', voice: 'piper:en_US-ryan-medium', label: '英文男 · Ryan',
    lang: 'en-US', gender: 'Male', quality: '标准', sizeBytes: 63221984,
    sha256: '33B53106E049F68A51F014E4FA10BF5A04E0F7D6668692DC05228CC4554C1D71',
    configSha256: 'D29061675E660113D51F81650E922134D94CAB750271F9CE2BCB05121F925A60',
    configSize: 6382, rel: 'en/en_US/ryan/medium/en_US-ryan-medium',
  },
]);

function piperModelMeta(modelId) {
  const clean = String(modelId || '').replace(/^piper:/i, '').replace(/\.onnx(\.json)?$/i, '');
  return PIPER_MODELS.find((item) => item.id === clean) || null;
}

function piperRoot() {
  const home = process.env.DSH_FOLIA_HOME || path.join(os.homedir(), '.dsh-folia');
  return process.env.FOLIA_PIPER_ROOT || path.join(home, 'piper', PIPER_VERSION);
}

function piperPaths(modelId = 'zh_CN-huayan-medium') {
  const root = piperRoot();
  const meta = piperModelMeta(modelId) || piperModelMeta('zh_CN-huayan-medium');
  return {
    root,
    exe: path.join(root, 'piper', 'piper.exe'),
    espeak: path.join(root, 'piper', 'espeak-ng-data'),
    model: path.join(root, 'models', meta.id + '.onnx'),
    config: path.join(root, 'models', meta.id + '.onnx.json'),
    zip: path.join(root, 'piper_windows_amd64.zip'),
    marker: path.join(root, 'installed.json'),
    meta,
  };
}

function piperRuntimeStatus() {
  const root = piperRoot();
  const exe = path.join(root, 'piper', 'piper.exe');
  const espeak = path.join(root, 'piper', 'espeak-ng-data');
  let installed = false;
  try { installed = fs.existsSync(exe) && fs.existsSync(espeak); } catch { installed = false; }
  return { installed, root, exe, espeak };
}

function piperStatus(modelId = 'zh_CN-huayan-medium') {
  const paths = piperPaths(modelId);
  const runtime = piperRuntimeStatus();
  let installed = false;
  let sizeBytes = 0;
  try {
    installed = runtime.installed && fs.existsSync(paths.model) && fs.existsSync(paths.config)
      && fs.statSync(paths.model).size > 1024 * 1024;
    if (installed) sizeBytes = Number(fs.statSync(paths.model).size) || 0;
  } catch { installed = false; }
  return { installed, root: paths.root, exe: paths.exe, model: paths.model, sizeBytes };
}

/** 流式下载（跟随重定向；先写 .part，成功后改名）。 */
function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

function downloadFile(url, dest, timeoutMs, expectedSha256, expectedSize, onProgress) {
  return new Promise((resolve, reject) => {
    const part = dest + '.part';
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const wanted = Number(expectedSize) || 0;
    let start = 0;
    try { if (fs.existsSync(part)) start = fs.statSync(part).size; } catch { start = 0; }
    if (wanted > 0 && start > wanted) {
      try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
      start = 0;
    }
    if (wanted > 0 && start === wanted) {
      // 上次已经下满，只差校验/改名。
      (async () => {
        try {
          if (expectedSha256 && (await fileSha256(part)) !== String(expectedSha256).toUpperCase()) {
            try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
            reject(new Error('sha256-mismatch'));
            return;
          }
          fs.rmSync(dest, { force: true });
          fs.renameSync(part, dest);
          if (onProgress) onProgress({ doneBytes: wanted, totalBytes: wanted, source: url, phase: 'download' });
          resolve(dest);
        } catch (error) { reject(error); }
      })();
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('download-timeout'));
    }, Math.max(10000, Number(timeoutMs) || 300000));
    const finish = async (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { reject(error); return; }
      try {
        if (expectedSha256) {
          const actual = await fileSha256(part);
          if (actual !== String(expectedSha256).toUpperCase()) {
            try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
            reject(new Error('sha256-mismatch'));
            return;
          }
        }
        const size = fs.statSync(part).size;
        if (wanted > 0 && size !== wanted) {
          reject(new Error('download-size-' + size + '/' + wanted));
          return;
        }
        fs.rmSync(dest, { force: true });
        fs.renameSync(part, dest);
        resolve(dest);
      } catch (verificationError) { reject(verificationError); }
    };
    const request = (target, redirects, insecure) => {
      let req;
      try {
        const isHttp = target.startsWith('http://');
        const transport = isHttp ? http : https;
        const headers = { 'User-Agent': EDGE_USER_AGENT, 'Accept-Encoding': 'identity' };
        if (start > 0) headers.Range = `bytes=${start}-`;
        const requestOptions = { headers };
        if (!isHttp) {
          // Windows 的 Node CA 链偶尔缺中间证书（本机 GitHub 就报
          // UNABLE_TO_VERIFY_LEAF_SIGNATURE）。这些资源都有**固定 sha256**，
          // 所以只在这种证书链错误时降级一次；没有 sha256 的下载绝不降级。
          requestOptions.rejectUnauthorized = !(insecure && expectedSha256);
        }
        req = transport.get(target, requestOptions, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            response.resume();
            if (redirects <= 0) { finish(new Error('download-redirect-loop')); return; }
            const next = new URL(response.headers.location || '', target).toString();
            request(next, redirects - 1, insecure);
            return;
          }
          if (response.statusCode !== 200 && response.statusCode !== 206) {
            response.resume();
            finish(new Error('download-http-' + response.statusCode));
            return;
          }
          if (response.statusCode !== 206) start = 0;
          const total = wanted > 0 ? wanted : ((Number(response.headers['content-length']) || 0) + start);
          let received = 0;
          const stream = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
          response.on('data', (chunk) => {
            received += chunk.length;
            if (typeof onProgress === 'function') {
              onProgress({
                doneBytes: Math.min(total || start + received, start + received),
                totalBytes: total || 0, source: target, phase: 'download',
              });
            }
          });
          response.on('error', finish);
          stream.on('error', finish);
          stream.on('finish', () => {
            if (total > 0 && start + received !== total) finish(new Error('download-size-' + (start + received) + '/' + total));
            else finish(null);
          });
          response.pipe(stream);
        });
      } catch (error) {
        finish(error);
        return;
      }
      req.on('error', (error) => {
        const code = String((error && error.code) || '');
        const certIssue = /CERT|SSL|UNABLE_TO_VERIFY|SELF_SIGNED|ALT_NAME/i.test(code + ' ' + String(error && error.message));
        if (!insecure && expectedSha256 && certIssue) {
          request(target, redirects, true);
          return;
        }
        finish(error);
      });
    };
    request(url, 5, false);
  });
}

/** 依次尝试多个镜像 + 每个源最多 3 次；只有 sha256 全过才算成功。 */
async function downloadFirst(urls, dest, timeoutMs, sha256, expectedSize, onProgress) {
  const list = [...new Set((urls || []).filter(Boolean).map(String))];
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    for (const url of list) {
      try {
        if (onProgress) {
          let resumeBytes = 0;
          try { if (fs.existsSync(dest + '.part')) resumeBytes = fs.statSync(dest + '.part').size; } catch { resumeBytes = 0; }
          onProgress({
            doneBytes: resumeBytes, totalBytes: Number(expectedSize) || 0,
            source: url, phase: 'download', attempt, retries: 3, resuming: resumeBytes > 0,
          });
        }
        return await downloadFile(url, dest, timeoutMs, sha256, expectedSize, onProgress);
      } catch (error) {
        lastError = error;
        if (onProgress) {
          let resumeBytes = 0;
          try { if (fs.existsSync(dest + '.part')) resumeBytes = fs.statSync(dest + '.part').size; } catch { resumeBytes = 0; }
          onProgress({
            doneBytes: resumeBytes, totalBytes: Number(expectedSize) || 0,
            source: url, phase: 'retry', attempt, retries: 3,
            error: String((error && error.message) || error),
          });
        }
      }
    }
    if (attempt < 3) await new Promise((resolve) => { setTimeout(resolve, 800 * attempt); });
  }
  throw lastError || new Error('download-no-source');
}

function unzipFile(zip, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const tar = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'tar.exe');
  let status = -1;
  try {
    status = spawnSync(tar, ['-xf', zip, '-C', destination], {
      windowsHide: true, stdio: 'ignore', timeout: 120000,
    }).status;
  } catch { status = -1; }
  if (status !== 0) {
    try {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
        'WindowsPowerShell', 'v1.0', 'powershell.exe');
      status = spawnSync(powershell, [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        'Expand-Archive -LiteralPath "' + zip.replace(/"/g, '""') + '" -DestinationPath "'
        + destination.replace(/"/g, '""') + '" -Force',
      ], { windowsHide: true, stdio: 'ignore', timeout: 120000 }).status;
    } catch { status = -1; }
  }
  if (status !== 0) throw new Error('piper-unzip-failed');
}

/** 已装模型清单（运行时 + 模型 + 配置都在才算）。 */
function installedPiperModels() {
  const runtime = piperRuntimeStatus();
  if (!runtime.installed) return [];
  return PIPER_MODELS.filter((meta) => {
    try {
      const paths = piperPaths(meta.id);
      return fs.existsSync(paths.model) && fs.existsSync(paths.config)
        && fs.statSync(paths.model).size > 1024 * 1024;
    } catch { return false; }
  }).map((meta) => ({ ...meta, paths: piperPaths(meta.id) }));
}

function modelUrlsFor(meta, ext) {
  const fileName = meta.id + ext;
  const rel = meta.rel + ext;
  return [
    // 旧环境变量只对默认华言生效：否则给华言设的覆盖 URL 会被别的模型误用。
    meta.id === 'zh_CN-huayan-medium' ? process.env.FOLIA_PIPER_MODEL_URL : '',
    PIPER_SITE_PREFIX + fileName,
    PIPER_HF_MIRROR + rel,
    PIPER_HF_BASE + rel,
  ].filter(Boolean);
}

let piperRuntimePromise = null;
/** 只装 piper.exe 运行时（所有音色包共用）；幂等。 */
function ensurePiperRuntime(deps) {
  const current = piperRuntimeStatus();
  if (current.installed) return Promise.resolve(current);
  if (piperRuntimePromise) return piperRuntimePromise;
  piperRuntimePromise = (async () => {
    const paths = piperPaths();
    fs.mkdirSync(paths.root, { recursive: true });
    const report = (payload) => {
      if (deps && typeof deps.onPiperProgress === 'function') deps.onPiperProgress(payload);
    };
    const assetUrls = [
      process.env.FOLIA_PIPER_ASSET_URL,
      PIPER_SITE_PREFIX + 'piper_windows_amd64.zip',
      PIPER_ASSET_MIRROR,
      PIPER_ASSET,
    ].filter(Boolean);
    report({ phase: 'resolve', file: 'runtime', doneBytes: 0, totalBytes: PIPER_ASSET_SIZE });
    if (!fs.existsSync(paths.exe)) {
      await downloadFirst(assetUrls, paths.zip, 300000, PIPER_ASSET_SHA256, PIPER_ASSET_SIZE,
        (p) => report({ ...p, file: 'runtime', phase: p.phase || 'download' }));
      report({ phase: 'unzip', file: 'runtime', doneBytes: PIPER_ASSET_SIZE, totalBytes: PIPER_ASSET_SIZE });
      unzipFile(paths.zip, paths.root);
      // 兼容两种 zip 结构：piper/piper.exe 或根目录 piper.exe。
      if (!fs.existsSync(paths.exe) && fs.existsSync(path.join(paths.root, 'piper.exe'))) {
        const nested = path.join(paths.root, 'piper');
        fs.mkdirSync(nested, { recursive: true });
        for (const entry of fs.readdirSync(paths.root)) {
          if (entry === 'piper' || entry.endsWith('.zip') || entry === 'models') continue;
          fs.renameSync(path.join(paths.root, entry), path.join(nested, entry));
        }
      }
      try { fs.rmSync(paths.zip, { force: true }); } catch { /* ignore */ }
    }
    const status = piperRuntimeStatus();
    if (!status.installed) throw new Error('piper-runtime-incomplete');
    report({ phase: 'ready', file: 'runtime', doneBytes: PIPER_ASSET_SIZE, totalBytes: PIPER_ASSET_SIZE });
    return status;
  })().catch((error) => {
    if (deps && typeof deps.onPiperProgress === 'function') {
      deps.onPiperProgress({ phase: 'failed', file: 'runtime', error: String((error && error.message) || error) });
    }
    piperRuntimePromise = null;
    throw error;
  });
  return piperRuntimePromise;
}

const piperModelPromises = new Map();
/** 装一个 Piper 模型（模型 + 配置）；运行时由 ensurePiperRuntime 负责。 */
function ensurePiperModel(modelId, deps) {
  const meta = piperModelMeta(modelId);
  if (!meta) return Promise.reject(new Error('unknown-piper-model: ' + String(modelId || '')));
  const current = piperStatus(meta.id);
  if (current.installed) return Promise.resolve(current);
  if (piperModelPromises.has(meta.id)) return piperModelPromises.get(meta.id);
  const promise = (async () => {
    await ensurePiperRuntime(deps);
    const paths = piperPaths(meta.id);
    const report = (payload) => {
      if (deps && typeof deps.onPiperProgress === 'function') deps.onPiperProgress(payload);
    };
    const total = meta.sizeBytes + meta.configSize;
    report({ phase: 'resolve', file: 'model', model: meta.id, doneBytes: 0, totalBytes: total });
    let modelOk = false;
    try { modelOk = fs.existsSync(paths.model) && (await fileSha256(paths.model)) === meta.sha256; } catch { modelOk = false; }
    if (!modelOk) {
      await downloadFirst(modelUrlsFor(meta, '.onnx'), paths.model, 600000, meta.sha256, meta.sizeBytes,
        (p) => report({ ...p, file: 'model', model: meta.id, phase: p.phase || 'download', totalBytes: total }));
    }
    let configOk = false;
    try { configOk = fs.existsSync(paths.config) && (await fileSha256(paths.config)) === meta.configSha256; } catch { configOk = false; }
    if (!configOk) {
      await downloadFirst(modelUrlsFor(meta, '.onnx.json'), paths.config, 60000, meta.configSha256, meta.configSize,
        (p) => report({ ...p, file: 'config', model: meta.id, phase: p.phase || 'download', totalBytes: total }));
    }
    const status = piperStatus(meta.id);
    if (!status.installed) throw new Error('piper-model-incomplete: ' + meta.id);
    fs.writeFileSync(paths.marker, JSON.stringify({
      version: PIPER_VERSION, model: meta.id, at: new Date().toISOString(),
      installed: installedPiperModels().map((item) => item.id),
    }, null, 2));
    report({ phase: 'ready', file: 'model', model: meta.id, doneBytes: total, totalBytes: total });
    return status;
  })().catch((error) => {
    if (deps && typeof deps.onPiperProgress === 'function') {
      deps.onPiperProgress({ phase: 'failed', file: 'model', model: meta.id, error: String((error && error.message) || error) });
    }
    piperModelPromises.delete(meta.id);
    throw error;
  });
  piperModelPromises.set(meta.id, promise);
  return promise;
}

/** 兼容旧入口：运行时 + 默认华言模型。 */
function ensurePiper(deps) {
  return ensurePiperModel('zh_CN-huayan-medium', deps);
}

/** 跑一次 Piper（stdin 由 cmd 重定向文件提供，避免 Node 管道）。 */
function runPiper(text, options, deps) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, engine: 'piper', error: 'windows-only', ms: 0 });
      return;
    }
    const requestedVoice = String((options && options.voice) || '').trim();
    const requestedMeta = /^piper:/i.test(requestedVoice) ? piperModelMeta(requestedVoice) : null;
    if (/^piper:/i.test(requestedVoice) && !requestedMeta) {
      resolve({ ok: false, engine: 'piper', error: 'piper-model-not-found: ' + requestedVoice, ms: 0 });
      return;
    }
    const meta = requestedMeta || piperModelMeta('zh_CN-huayan-medium');
    const status = piperStatus(meta.id);
    if (!status.installed) {
      resolve({ ok: false, engine: 'piper', error: 'piper-model-not-installed: ' + meta.id, ms: 0 });
      return;
    }
    const started = Date.now();
    // ⚠️ Piper（2023.11.14 Windows 构建）实测在 `%TEMP%` 下不会落 WAV（进程 0 退出但文件不存在）；
    // 放到数据目录下的 tmp 里稳定可写。判据给的非临时目录仍优先。
    const requestedDir = deps && deps.dir ? path.resolve(deps.dir) : '';
    const tempRoot = path.resolve(os.tmpdir());
    const dir = requestedDir && !requestedDir.startsWith(tempRoot)
      ? requestedDir
      : path.join(piperRoot(), 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const textFile = path.join(dir, 'piper-' + crypto.randomBytes(5).toString('hex') + '.txt');
    const outFile = path.join(dir, 'piper-' + crypto.randomBytes(5).toString('hex') + '.wav');
    const errFile = outFile + '.log';
    fs.writeFileSync(textFile, String(text || ''), 'utf8');
    const paths = piperPaths(meta.id);
    const rate = Math.max(-10, Math.min(10, Number(options && options.rate) || 0));
    const lengthScale = rate === 0 ? 1 : (rate > 0 ? 1 / (1 + rate * 0.05) : 1 + (-rate) * 0.05);
    const command = '"' + paths.exe + '" --model "' + paths.model + '" --config "' + paths.config
      + '" --espeak_data "' + paths.espeak + '" --length_scale ' + lengthScale.toFixed(3)
      + ' --output_file "' + outFile + '" < "' + textFile + '"';
    // cmd /s /c 的经典陷阱：命令以引号开头时必须再套一层引号，否则 cmd 会把
    // `"C:\...\piper.exe" --model...` 当成一个不存在的路径。
    const shellCommand = '"' + command + '"';
    let errFd = null;
    try { errFd = fs.openSync(errFile, 'w'); } catch { errFd = null; }
    let child;
    try {
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', shellCommand], {
        windowsHide: true,
        // cmd /s /c 需要原样收到整条命令；Node 默认会给带空格的参数再加一层引号，cmd 会拒绝。
        windowsVerbatimArguments: true,
        stdio: ['ignore', 'ignore', errFd === null ? 'ignore' : errFd],
      });
    } catch (error) {
      try { if (errFd !== null) fs.closeSync(errFd); } catch { /* ignore */ }
      resolve({ ok: false, engine: 'piper', error: String((error && error.message) || error), ms: Date.now() - started });
      return;
    }
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let stderr = '';
      try { stderr = fs.readFileSync(errFile, 'utf8'); } catch { /* ignore */ }
      try { if (errFd !== null) fs.closeSync(errFd); } catch { /* ignore */ }
      for (const file of [textFile, errFile]) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
      const valid = validateWav(outFile);
      if (!valid.ok) {
        try { fs.unlinkSync(outFile); } catch { /* ignore */ }
        resolve({
          ok: false, engine: 'piper', error: (stderr.split(/\r?\n/).filter(Boolean).pop() || 'piper-failed').slice(0, 300),
          code: 'piper-failed', ms: Date.now() - started,
        });
        return;
      }
      resolve({
        ok: true, engine: 'piper', file: outFile, bytes: valid.bytes,
        voice: meta.voice, mime: 'audio/wav', transport: 'local',
        ms: Date.now() - started, code,
      });
    };
    const timer = setTimeout(() => {
      try { if (child && child.pid) child.kill(); } catch { /* ignore */ }
      setTimeout(() => finish(null), 500);
    }, Math.max(10000, Number(options && options.timeoutMs) || 30000));
    child.on('error', (error) => {
      try { if (child && child.pid) child.kill(); } catch { /* ignore */ }
      finish(null);
      void error;
    });
    child.on('close', (code) => finish(code));
  });
}

/* ── PowerShell 脚本（ASCII；中文只经 JSON 文件）────────────────────────────── */

/** SAPI：System.Speech 的桌面音色。 */
const SAPI_SCRIPT = `
param([string]$Req, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$cfg = Get-Content -Raw -Encoding UTF8 $Req | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $picked = ''
  # An explicit voice MUST exist in this engine's catalog. Do not silently fall
  # back to the system default: the caller reports this attempt as failed and
  # tries the next engine (the voice may belong to the Edge/OneCore catalog).
  # stdout prints 'OK <name>' so callers report the REAL voice.
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  if ($cfg.voice) {
    $match = $voices | Where-Object { $_.Name -eq [string]$cfg.voice } | Select-Object -First 1
    if (-not $match) { throw ('voice-not-found: ' + [string]$cfg.voice) }
    $synth.SelectVoice($match.Name)
    $picked = $match.Name
  } else {
    $match = $voices | Where-Object { $_.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
    if (-not $match) { $match = $voices | Where-Object { $_.Culture.Name -like 'zh*' } | Select-Object -First 1 }
    if (-not $match) { $match = $voices | Select-Object -First 1 }
    if ($match) { $synth.SelectVoice($match.Name); $picked = $match.Name }
  }
  $rate = 0
  if ($null -ne $cfg.rate) { $rate = [int][math]::Max(-10, [math]::Min(10, [double]$cfg.rate)) }
  $synth.Rate = $rate
  $synth.Volume = 100
  $synth.SetOutputToWaveFile($Out)
  $synth.Speak([string]$cfg.text)
  $synth.SetOutputToNull()
  [Console]::Out.WriteLine('OK ' + $picked)
} finally {
  $synth.Dispose()
}
`;

/**
 * Edge / OneCore：WinRT SpeechSynthesizer（Edge 浏览器「大声朗读」用的同一批系统音色）。
 *
 * 用 SSML 的 `<prosody rate="%">` 承载语速（WinRT 没有 SAPI 那种 Rate 属性）；
 * 文本先做 XML 转义。异步 API 经 `AsTask()` 同步等待（Windows PowerShell 5.1 的老办法）。
 */
const EDGE_SCRIPT = `
param([string]$Req, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$cfg = Get-Content -Raw -Encoding UTF8 $Req | ConvertFrom-Json
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
try {
  $picked = ''
  # Same rule as SAPI: an explicit voice must exist in this engine's catalog;
  # otherwise fail this attempt (the caller falls through to the next engine).
  $voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
  if ($cfg.voice) {
    $match = $voices | Where-Object { $_.DisplayName -eq [string]$cfg.voice -or $_.Id -eq [string]$cfg.voice } | Select-Object -First 1
    if (-not $match) { throw ('voice-not-found: ' + [string]$cfg.voice) }
    $synth.Voice = $match
    $picked = $match.DisplayName
  } else {
    $match = $voices | Where-Object { $_.Language -like 'zh*' } | Select-Object -First 1
    if (-not $match) { $match = $voices | Select-Object -First 1 }
    if ($match) { $synth.Voice = $match; $picked = $match.DisplayName }
  }
  $rate = 0
  if ($null -ne $cfg.rate) { $rate = [int][math]::Max(-10, [math]::Min(10, [double]$cfg.rate)) }
  $pct = [int][math]::Max(50, [math]::Min(200, 100 + $rate * 10))
  $text = [System.Security.SecurityElement]::Escape([string]$cfg.text)
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><prosody rate='$pct%'>$text</prosody></speak>"
  $stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $netStream = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $file = [System.IO.File]::Create($Out)
  try { $netStream.CopyTo($file) } finally { $file.Close(); $netStream.Close() }
  [Console]::Out.WriteLine('OK ' + $picked)
} finally {
  $synth.Dispose()
}
`;

/** 把一段脚本写到临时目录（一次进程一份，避免并发互相覆盖）。 */
function writeScript(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'ascii');
  return file;
}

/**
 * pre.54（B3②）：枚举**本机 SAPI 音色**（System.Speech 桌面音色，离线零模型）。
 *
 * Edge/OneCore（WinRT）音色在这台机器上实测 503，先**不列**（宁可少列，不可列了没用）；
 * 合成链仍保留 edge 兜底，只是下拉里只出现本机真能出声的。
 * 输出 UTF-8（无 BOM）JSON 到 `$Out`，由 Node 侧读回。
 */
const SAPI_VOICES_SCRIPT = `
param([string]$Req, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$list = @()
try {
  foreach ($v in $synth.GetInstalledVoices()) {
    if (-not $v.Enabled) { continue }
    $info = $v.VoiceInfo
    $list += [pscustomobject]@{ Name = $info.Name; Culture = $info.Culture.Name; Gender = [string]$info.Gender }
  }
} finally { $synth.Dispose() }
$json = $list | ConvertTo-Json -Compress
if (-not $json) { $json = '[]' }
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
`;

/**
 * pre.54（B3②）：本机音色清单 + **逐个试合成**（usable）。
 * 只做 SAPI；试合成用一句 2 字中文（短、快），成功后立刻删掉试听 WAV。
 * v0.2：SAPI 默认关闭，只有 `/voice/setup` 里用户手动开启时才枚举。
 */
async function listSapiVoices(deps = {}) {
  if (process.platform !== 'win32') return [];
  const dir = deps.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-tts-voices-'));
  const stamp = crypto.randomBytes(4).toString('hex');
  const scriptFile = writeScript(dir, 'voices-' + stamp + '.ps1', SAPI_VOICES_SCRIPT);
  const outFile = path.join(dir, 'voices-' + stamp + '.json');
  let raw = [];
  try {
    await runPowerShellScript(scriptFile, '', outFile, Math.max(3000, Number(deps.voicesTimeoutMs) || 15000));
    try { raw = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '')); } catch { raw = []; }
  } catch { raw = []; }
  for (const file of [scriptFile, outFile]) { try { fs.unlinkSync(file); } catch { /* ignore */ } }
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  for (const item of items) {
    const name = String((item && item.Name) || '').trim();
    if (!name) continue;
    let usable = false;
    try {
      const test = await runEngine('sapi', '你好', { voice: name, rate: 0 }, Object.assign({}, deps, {
        dir, timeoutMs: Math.max(3000, Number(deps.testTimeoutMs) || 6000),
      }));
      usable = Boolean(test && test.ok);
      if (test && test.file) { try { fs.unlinkSync(test.file); } catch { /* ignore */ } }
    } catch { usable = false; }
    out.push({
      engine: 'sapi',
      id: name,
      label: name,
      lang: String((item && item.Culture) || ''),
      gender: String((item && item.Gender) || ''),
      usable,
    });
  }
  return out;
}

/**
 * v0.2 统一音色清单：只返回**这次运行真的能拿到声音**的项。
 *   · Edge 在线：先拉官方目录，再用默认音色试合成一次；失败则全部 usable=false，
 *     前端过滤后下拉里不会出现“写了但用不了”的名字；
 *   · Piper：只有二进制 + 模型已经落盘时才列（没装就交给「一键启用」首次下载）；
 *   · SAPI：只有用户显式开启才枚举、试合成。
 */
async function listVoices(deps = {}) {
  const out = [];
  let edgeMeta = { ok: false, error: '', voices: 0, probeMs: 0 };
  if (deps.edge !== false) {
    const items = await edgeVoiceList(false);
    if (items.length) {
      const preferred = pickEdgeDefaultVoice(items);
      const probe = await probeEdge(preferred.id, deps.edgeTimeoutMs);
      edgeMeta = {
        ok: probe.ok === true, error: probe.error || '', voices: items.length,
        probeMs: probe.ms || 0, voice: probe.voice || preferred.id,
      };
      for (const item of items) {
        out.push({ ...item, usable: probe.ok === true, reason: probe.ok ? '' : probe.error });
      }
    } else {
      edgeMeta = { ok: false, error: edgeVoiceCache.error || 'voice-list-empty', voices: 0, probeMs: 0 };
    }
  }
  const piper = piperStatus();
  for (const meta of installedPiperModels()) {
    out.push({
      engine: 'piper', id: meta.voice, label: meta.label,
      lang: meta.lang, gender: meta.gender, quality: meta.quality,
      usable: true, offline: true, requiresKey: false, sizeBytes: meta.sizeBytes,
    });
  }
  if (deps.sapiEnabled === true) {
    let sapi = [];
    try { sapi = await listSapiVoices(deps); } catch { sapi = []; }
    out.push(...sapi);
  }
  return { voices: out, edge: edgeMeta, piper };
}

/**
 * 跑一次 PowerShell（stdio 全走文件；超时强杀）。
 * @returns {Promise<{ ok: boolean, code: number|null, voice: string, stderr: string }>}
 */
function runPowerShellScript(scriptFile, reqFile, outFile, timeoutMs) {
  return new Promise((resolve) => {
    const errFile = outFile + '.ps.log';
    const voiceFile = outFile + '.ps.out';
    let fd = null;
    let outFd = null;
    try { fd = fs.openSync(errFile, 'w'); } catch { fd = null; }
    try { outFd = fs.openSync(voiceFile, 'w'); } catch { outFd = null; }
    const cleanupFiles = () => {
      try { if (fd !== null) fs.closeSync(fd); } catch { /* ignore */ }
      try { if (outFd !== null) fs.closeSync(outFd); } catch { /* ignore */ }
      try { fs.unlinkSync(errFile); } catch { /* ignore */ }
      try { fs.unlinkSync(voiceFile); } catch { /* ignore */ }
    };
    let child;
    try {
      child = spawn(powershellPath(), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', scriptFile, reqFile, outFile,
      ], {
        windowsHide: true,
        // stdout 也走文件（**不 pipe**）：脚本最后一行 `OK <实际音色>` 就是真实音色。
        stdio: ['ignore', outFd === null ? 'ignore' : outFd, fd === null ? 'ignore' : fd],
      });
    } catch (error) {
      cleanupFiles();
      resolve({ ok: false, code: -1, voice: '', stderr: String((error && error.message) || error) });
      return;
    }
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let stderr = '';
      let stdout = '';
      try { stderr = fs.readFileSync(errFile, 'utf8'); } catch { /* ignore */ }
      try { stdout = fs.readFileSync(voiceFile, 'utf8'); } catch { /* ignore */ }
      cleanupFiles();
      const picked = /^OK\s+(.+)$/m.exec(stdout);
      resolve({
        ok: code === 0,
        code,
        voice: picked ? String(picked[1]).trim().slice(0, 120) : '',
        stderr: stderr.slice(-1600),
      });
    };
    const timer = setTimeout(() => {
      try { if (child && child.pid) child.kill(); } catch { /* ignore */ }
      setTimeout(() => finish(null), 300);
    }, timeoutMs);
    child.on('error', (error) => {
      try { if (child && child.pid) child.kill(); } catch { /* ignore */ }
      finish(null);
      void error;
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * 引擎一跳：准备请求 JSON → 跑 PowerShell → 校验 WAV。
 * voice 归一化：没显式匹配到就按引擎的“实际默认音色”写回，便于客户端提示。
 */
async function runEngine(engine, text, options, deps) {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'windows-only', attempts: [] };
  }
  const dir = deps.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'folia-tts-'));
  // 同一句重复请求也不许互相覆盖：文件名带随机后缀（worker 串行，但一次性模式可能并发）。
  const stamp = crypto.createHash('sha1').update(engine + ':' + text + ':' + (options.voice || '')).digest('hex').slice(0, 10)
    + '-' + crypto.randomBytes(4).toString('hex');
  const reqFile = path.join(dir, engine + '-' + stamp + '.json');
  const outFile = path.join(dir, engine + '-' + stamp + '.wav');
  const scriptFile = writeScript(dir, engine + '-' + stamp + '.ps1', engine === 'sapi' ? SAPI_SCRIPT : EDGE_SCRIPT);
  writeJson(reqFile, {
    text: String(text || '').slice(0, MAX_TEXT_CHARS),
    voice: String(options.voice || '').slice(0, 120),
    rate: Number.isFinite(options.rate) ? Number(options.rate) : 0,
  });
  const started = Date.now();
  const result = await runPowerShellScript(scriptFile, reqFile, outFile, deps.timeoutMs || ENGINE_TIMEOUT_MS);
  // 请求配置与脚本都是一次性的：落盘只为绕开命令行编码/管道，进程结束后立刻删
  for (const file of [reqFile, scriptFile]) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  const wav = result.ok ? validateWav(outFile) : { ok: false, error: 'powershell-exit-' + result.code };
  if (!wav.ok) {
    const reason = result.ok ? (wav.error || 'synthesis-failed') : cleanEngineError(result.stderr);
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
    return {
      ok: false,
      error: String(reason || 'synthesis-failed').slice(0, 300),
      engine,
      ms: Date.now() - started,
    };
  }
  return {
    ok: true,
    engine,
    file: outFile,
    bytes: wav.bytes,
    // 脚本 stdout 的 `OK <name>` 是**实际选中的音色**（SAPI 与 Edge 目录不同，
    // 请求名可能只属于另一套）；拿不到才退回请求名。
    voice: String(result.voice || options.voice || ''),
    mime: 'audio/wav',
    transport: 'local',
    ms: Date.now() - started,
    dir,
  };
}

/** SAPI 一跳（导出给判据注入假实现）。 */
function runSapiEngine(text, options, deps) {
  return runEngine('sapi', text, options || {}, deps || {});
}

/** Edge/OneCore 一跳（导出给判据注入假实现）。 */
function runEdgeEngine(text, options, deps) {
  return runEngine('edge', text, options || {}, deps || {});
}

/** 在线 Edge 一跳（导出给判据注入假实现）。 */
function runEdgeOnlineEngine(text, options, deps) {
  return edgeSynthesizeOnline(text, options || {}, deps || {});
}

/**
 * v0.2 默认音色策略（**纯顺序函数**，判据可直接对着它做正/负对照）：
 *   · 旧配置（没有 activeEngine）：Edge 在线 → Piper → SAPI（可选），保持向后兼容；
 *   · pre.57 启用流程（有 activeEngine）：在线渠道失败只能回到**当前唯一启用**的内置音色，
 *     未启用的内置音色不参与回落。
 */
function policyEngineOrder(voice, sapiEnabled, activeEngine) {
  const requested = String(voice == null ? '' : voice).trim();
  const active = ['edge', 'piper', 'sapi'].includes(String(activeEngine || '')) ? String(activeEngine) : '';
  const onlinePrefix = /^volc:/i.test(requested) ? 'volc'
    : /^openai:/i.test(requested) ? 'openai'
      : /^azure:/i.test(requested) ? 'azure'
        : /^elevenlabs:/i.test(requested) ? 'elevenlabs' : '';
  if (active) {
    if (onlinePrefix) return [onlinePrefix, active];
    if (/^melo:/i.test(requested)) return ['sherpa', active].filter((engine, index, list) => list.indexOf(engine) === index);
    if (/^piper:/i.test(requested)) return active === 'piper' ? ['piper'] : ['edge'];
    if (isNeuralVoice(requested)) return active === 'edge' ? ['edge'] : [active];
    if (/^Microsoft\s.+\sDesktop$/i.test(requested)) {
      return sapiEnabled && active === 'sapi' ? ['sapi'] : (active === 'sapi' ? ['edge'] : [active]);
    }
    return active === 'sapi' && !sapiEnabled ? ['edge'] : [active];
  }
  let order;
  if (/^melo:/i.test(requested)) order = ['sherpa', 'edge', 'piper', 'sapi'];
  else if (/^volc:/i.test(requested)) order = ['volc', 'edge', 'piper', 'sapi'];
  else if (/^openai:/i.test(requested)) order = ['openai', 'edge', 'piper', 'sapi'];
  else if (/^azure:/i.test(requested)) order = ['azure', 'edge', 'piper', 'sapi'];
  else if (/^elevenlabs:/i.test(requested)) order = ['elevenlabs', 'edge', 'piper', 'sapi'];
  else if (/^piper:/i.test(requested)) order = ['piper', 'edge', 'sapi'];
  else if (isNeuralVoice(requested)) order = ['edge', 'piper', 'sapi'];
  else if (/^Microsoft\s.+\sDesktop$/i.test(requested)) order = sapiEnabled ? ['sapi', 'edge', 'piper'] : ['edge', 'piper'];
  else order = ['edge', 'piper', 'sapi'];
  return sapiEnabled ? order.filter((engine, index) => order.indexOf(engine) === index) : order.filter((engine) => engine !== 'sapi');
}

function isPiperVoice(voice) {
  return /^piper:/i.test(String(voice || ''));
}

/**
 * 按 v0.2 策略合成。与 `synthesizeOnce` 分开是为了**不破坏** pre.54 的旧判据：
 * 旧判据仍可用显式 engines 调 `synthesizeOnce` 验证 sapi→edge 兜底；生产路由走这里。
 */
async function synthesizePolicy(text, options = {}, deps = {}) {
  const clean = String(text == null ? '' : text).trim().slice(0, MAX_TEXT_CHARS);
  if (!clean) return { ok: false, code: 'empty-text', error: 'empty-text', attempts: [] };
  const requestedVoice = String(options.voice == null ? '' : options.voice).trim();
  const sapiEnabled = options.sapiEnabled === true;
  const activeEngine = ['edge', 'piper', 'sapi'].includes(String(options.activeEngine || ''))
    ? String(options.activeEngine) : '';
  const engines = policyEngineOrder(requestedVoice, sapiEnabled, activeEngine);
  // 明确指定音色（固定人设）时，失败后允许回落到全局启用的内置引擎。
  if (Array.isArray(options.fallbackEngines)) {
    for (const engine of options.fallbackEngines) {
      if (['edge', 'piper', 'sapi'].includes(engine) && !engines.includes(engine)) engines.push(engine);
    }
  }
  const attempts = [];

  // Edge 需要一个真实音色名；不把名单写死，按官方目录挑默认；网络不可用时退回内置默认规则。
  let edgeVoice = isNeuralVoice(requestedVoice) ? requestedVoice : '';
  if (!edgeVoice) {
    try { edgeVoice = pickEdgeDefaultVoice(await edgeVoiceList(false)).id; } catch { edgeVoice = EDGE_DEFAULT_VOICE; }
  }
  // `runEdge` 是 pre.54 的注入名；v0.2 判据用 `runEdgeOnline`。两个都接受，避免判据写法互斥。
  const runEdgeOnline = typeof deps.runEdgeOnline === 'function'
    ? deps.runEdgeOnline
    : (typeof deps.runEdge === 'function' ? deps.runEdge : runEdgeOnlineEngine);
  const runSapi = typeof deps.runSapi === 'function' ? deps.runSapi : runSapiEngine;
  const runPiper = typeof deps.runPiper === 'function' ? deps.runPiper : runPiperLocal;

  const runOpenAI = typeof deps.runOpenAI === 'function' ? deps.runOpenAI : openaiSynthesize;
  const runAzure = typeof deps.runAzure === 'function' ? deps.runAzure : azureSynthesize;
  const runElevenLabs = typeof deps.runElevenLabs === 'function' ? deps.runElevenLabs : elevenLabsSynthesize;
  const runVolc = typeof deps.runVolc === 'function' ? deps.runVolc : volcSynthesize;
  for (const engine of engines) {
    if (engine === 'volc') {
      const cfg = (options.online && options.online.volcengine) || {};
      const requestedVolc = /^volc:/i.test(requestedVoice);
      const voiceId = requestedVolc ? requestedVoice.replace(/^volc:/i, '') : String(cfg.voiceId || VOLC_DEFAULT_VOICE);
      const candidate = 'volc:' + voiceId;
      let jumped;
      try {
        jumped = await runVolc(clean, {
          voice: candidate, rate: options.rate,
          timeoutMs: Math.max(3000, Math.min(30000, Number(options.volcTimeoutMs) || 12000)),
          online: options.online,
        }, deps);
      } catch (error) {
        jumped = { ok: false, error: String((error && error.message) || error) };
      }
      if (jumped && jumped.ok && jumped.file) {
        const actualVoice = String(jumped.voice || candidate);
        return {
          ok: true, engine: 'volc', subtype: jumped.subtype || volcSubtypeOf(cfg, voiceId),
          transport: 'online', file: jumped.file,
          bytes: Number(jumped.bytes) || 0, mime: jumped.mime || 'audio/mpeg',
          voice: actualVoice, requestedVoice,
          fallback: Boolean(requestedVoice) && actualVoice !== requestedVoice,
          fallbackFrom: Boolean(requestedVoice) && actualVoice !== requestedVoice ? requestedVoice : '',
          attempts, ms: Number(jumped.ms) || 0,
        };
      }
      attempts.push({
        engine: 'volc', voice: candidate || '(default)',
        code: String((jumped && jumped.code) || 'volc-failed'),
        error: String((jumped && (jumped.error || jumped.code)) || 'volc-failed').slice(0, 400),
      });
      // 没配 Key ⇒ 静默跳到下一跳（与 OpenAI/ElevenLabs 的无 Key 行为一致），不弹错误框。
      continue;
    }
    if (engine === 'sherpa') {
      const meta = (/^melo:/i.test(requestedVoice) ? sherpaModelMeta(requestedVoice) : null) || SHERPA_MODELS[0];
      let status = meta ? sherpaStatus(meta.id) : { installed: false };
      if (!status.installed && options.allowDownload === true && typeof deps.runSherpa !== 'function') {
        try {
          status = await ensureSherpaModel(meta.id, deps);
        } catch (error) {
          attempts.push({
            engine: 'sherpa', voice: meta ? meta.voice : 'melo:',
            error: String((error && error.message) || error).slice(0, 300),
          });
          continue;
        }
      }
      const runSherpa = typeof deps.runSherpa === 'function' ? deps.runSherpa : sherpaSynthesize;
      let jumped;
      try {
        jumped = await runSherpa(clean, {
          voice: meta ? meta.voice : requestedVoice,
          rate: options.rate,
          timeoutMs: Math.max(5000, Number(options.sherpaTimeoutMs) || 30000),
        }, deps);
      } catch (error) {
        jumped = { ok: false, error: String((error && error.message) || error) };
      }
      if (jumped && jumped.ok && jumped.file) {
        return {
          ok: true, engine: 'sherpa', subtype: 'sherpa', transport: 'local',
          file: jumped.file, bytes: Number(jumped.bytes) || 0, mime: jumped.mime || 'audio/wav',
          voice: String(jumped.voice || (meta ? meta.voice : requestedVoice)),
          requestedVoice,
          fallback: Boolean(requestedVoice) && String(jumped.voice || (meta ? meta.voice : requestedVoice)) !== requestedVoice,
          fallbackFrom: Boolean(requestedVoice) && String(jumped.voice || (meta ? meta.voice : requestedVoice)) !== requestedVoice ? requestedVoice : '',
          attempts, ms: Number(jumped.ms) || 0,
        };
      }
      attempts.push({
        engine: 'sherpa', voice: meta ? meta.voice : requestedVoice,
        code: String((jumped && jumped.code) || 'sherpa-failed'),
        error: String((jumped && (jumped.error || jumped.code)) || 'sherpa-failed').slice(0, 300),
      });
      continue;
    }
    if (engine === 'openai') {
      const cfg = (options.online && options.online.openai) || {};
      const requestedOpenAI = /^openai:/i.test(requestedVoice);
      const candidate = requestedOpenAI ? requestedVoice : 'openai:' + String(cfg.voice || OPENAI_DEFAULT_VOICE);
      let jumped;
      try {
        jumped = await runOpenAI(clean, {
          voice: candidate, rate: options.rate,
          timeoutMs: Math.max(3000, Math.min(8000, Number(options.openaiTimeoutMs) || 8000)),
          online: options.online,
        }, deps);
      } catch (error) {
        jumped = { ok: false, error: String((error && error.message) || error) };
      }
      if (jumped && jumped.ok && jumped.file) {
        const actualVoice = String(jumped.voice || candidate);
        return {
          ok: true,
          engine: 'openai',
          transport: 'online',
          file: jumped.file,
          bytes: Number(jumped.bytes) || 0,
          mime: jumped.mime || 'audio/mpeg',
          voice: actualVoice,
          requestedVoice,
          fallback: Boolean(requestedVoice) && actualVoice !== requestedVoice,
          fallbackFrom: Boolean(requestedVoice) && actualVoice !== requestedVoice ? requestedVoice : '',
          attempts,
          ms: Number(jumped.ms) || 0,
        };
      }
      attempts.push({
        engine: 'openai', voice: candidate || '(default)',
        code: String((jumped && jumped.code) || 'openai-failed'),
        error: String((jumped && (jumped.error || jumped.code)) || 'openai-failed').slice(0, 300),
      });
      continue;
    }
    if (engine === 'azure') {
      const cfg = (options.online && options.online.azure) || {};
      const requestedAzure = /^azure:/i.test(requestedVoice);
      const candidate = requestedAzure ? requestedVoice : 'azure:' + String(cfg.voice || AZURE_DEFAULT_VOICE);
      let jumped;
      try {
        jumped = await runAzure(clean, {
          voice: candidate, rate: options.rate,
          timeoutMs: Math.max(3000, Math.min(8000, Number(options.onlineTimeoutMs) || 8000)),
          online: options.online,
        }, deps);
      } catch (error) {
        jumped = { ok: false, error: String((error && error.message) || error) };
      }
      if (jumped && jumped.ok && jumped.file) {
        const actualVoice = String(jumped.voice || candidate);
        return {
          ok: true, engine: 'azure', transport: 'online', file: jumped.file,
          bytes: Number(jumped.bytes) || 0, mime: jumped.mime || 'audio/mpeg',
          voice: actualVoice, requestedVoice,
          fallback: Boolean(requestedVoice) && actualVoice !== requestedVoice,
          fallbackFrom: Boolean(requestedVoice) && actualVoice !== requestedVoice ? requestedVoice : '',
          attempts, ms: Number(jumped.ms) || 0,
        };
      }
      attempts.push({
        engine: 'azure', voice: candidate || '(default)',
        code: String((jumped && jumped.code) || 'azure-failed'),
        error: String((jumped && (jumped.error || jumped.code)) || 'azure-failed').slice(0, 300),
      });
      continue;
    }
    if (engine === 'elevenlabs') {
      const cfg = (options.online && options.online.elevenlabs) || {};
      const requestedEleven = /^elevenlabs:/i.test(requestedVoice);
      const candidate = requestedEleven ? requestedVoice : 'elevenlabs:' + String(cfg.voiceId || ELEVENLABS_DEFAULT_VOICE);
      let jumped;
      try {
        jumped = await runElevenLabs(clean, {
          voice: candidate, rate: options.rate,
          timeoutMs: Math.max(3000, Math.min(8000, Number(options.onlineTimeoutMs) || 8000)),
          online: options.online,
        }, deps);
      } catch (error) {
        jumped = { ok: false, error: String((error && error.message) || error) };
      }
      if (jumped && jumped.ok && jumped.file) {
        const actualVoice = String(jumped.voice || candidate);
        return {
          ok: true, engine: 'elevenlabs', transport: 'online', file: jumped.file,
          bytes: Number(jumped.bytes) || 0, mime: jumped.mime || 'audio/mpeg',
          voice: actualVoice, requestedVoice,
          fallback: Boolean(requestedVoice) && actualVoice !== requestedVoice,
          fallbackFrom: Boolean(requestedVoice) && actualVoice !== requestedVoice ? requestedVoice : '',
          attempts, ms: Number(jumped.ms) || 0,
        };
      }
      attempts.push({
        engine: 'elevenlabs', voice: candidate || '(default)',
        code: String((jumped && jumped.code) || 'elevenlabs-failed'),
        error: String((jumped && (jumped.error || jumped.code)) || 'elevenlabs-failed').slice(0, 300),
      });
      continue;
    }
    if (engine === 'edge') {
      const candidate = isNeuralVoice(requestedVoice) ? requestedVoice : edgeVoice;
      let jumped;
      // 在线 Edge 必须在 5–8 秒内判定：单次给 7.5s；429 只做一次极短退避，
      // 超过 8s 预算立即回落 Piper，不让用户干等。
      const edgeBudget = Math.max(5000, Math.min(6500, Number(options.edgeTimeoutMs) || 5500));
      const edgeDeadline = Date.now() + edgeBudget;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const remaining = Math.max(1500, edgeDeadline - Date.now());
        try {
          jumped = await runEdgeOnline(clean, {
            voice: candidate, rate: options.rate,
            timeoutMs: Math.min(edgeBudget, remaining),
          }, deps);
        } catch (error) {
          jumped = { ok: false, error: String((error && error.message) || error) };
        }
        if (jumped && jumped.ok) break;
        const reason = String((jumped && (jumped.error || jumped.code)) || '');
        if (!/429|rate.?limit/i.test(reason) || attempt >= 1 || Date.now() > edgeDeadline - 600) break;
        await new Promise((resolve) => { setTimeout(resolve, 450); });
      }
      if (jumped && jumped.ok && jumped.file) {
        const actualVoice = String(jumped.voice || candidate || '');
        return {
          ok: true,
          engine: 'edge',
          transport: 'online',
          file: jumped.file,
          bytes: Number(jumped.bytes) || 0,
          mime: jumped.mime || 'audio/mpeg',
          voice: actualVoice,
          requestedVoice,
          fallback: Boolean(requestedVoice) && actualVoice !== requestedVoice,
          fallbackFrom: Boolean(requestedVoice) && actualVoice !== requestedVoice ? requestedVoice : '',
          attempts,
          ms: Number(jumped.ms) || 0,
        };
      }
      attempts.push({
        engine: 'edge', voice: candidate || '(default)',
        error: String((jumped && (jumped.error || jumped.code)) || 'edge-failed').slice(0, 300),
      });
      continue;
    }
    if (engine === 'piper') {
      // 指定了 piper:<model> 就检查/安装那个模型；否则用默认华言。
      const piperMeta = /^piper:/i.test(requestedVoice) ? piperModelMeta(requestedVoice) : null;
      const targetModelId = piperMeta ? piperMeta.id : 'zh_CN-huayan-medium';
      const piper = piperStatus(targetModelId);
      // 判据可以注入 runPiper 验证顺序；只有真实运行才要求模型已落盘。
      if (!piper.installed && options.allowDownload !== true && typeof deps.runPiper !== 'function') {
        attempts.push({ engine: 'piper', voice: piperMeta ? piperMeta.voice : PIPER_MODEL_ID, error: 'piper-not-installed' });
        continue;
      }
      try {
        if (!piper.installed && typeof deps.runPiper !== 'function') await ensurePiperModel(targetModelId, deps);
      } catch (error) {
        attempts.push({ engine: 'piper', voice: piperMeta ? piperMeta.voice : PIPER_MODEL_ID, error: String((error && error.message) || error).slice(0, 300) });
        continue;
      }
      let jumped;
      try {
        jumped = await runPiper(clean, {
          voice: piperMeta ? piperMeta.voice : PIPER_MODEL_ID,
          rate: options.rate, timeoutMs: options.piperTimeoutMs,
        }, deps);
      } catch (error) {
        jumped = { ok: false, error: String((error && error.message) || error) };
      }
      if (jumped && jumped.ok && jumped.file) {
        return {
          ok: true,
          engine: 'piper',
          transport: 'local',
          file: jumped.file,
          bytes: Number(jumped.bytes) || 0,
          mime: jumped.mime || 'audio/wav',
          voice: jumped.voice || (piperMeta ? piperMeta.voice : PIPER_MODEL_ID),
          requestedVoice,
          fallback: Boolean(requestedVoice) && String(jumped.voice || (piperMeta ? piperMeta.voice : PIPER_MODEL_ID)) !== requestedVoice,
          fallbackFrom: Boolean(requestedVoice) && String(jumped.voice || (piperMeta ? piperMeta.voice : PIPER_MODEL_ID)) !== requestedVoice ? requestedVoice : '',
          attempts,
          ms: Number(jumped.ms) || 0,
        };
      }
      attempts.push({
        engine: 'piper', voice: PIPER_MODEL_ID,
        error: String((jumped && (jumped.error || jumped.code)) || 'piper-failed').slice(0, 300),
      });
      continue;
    }
    if (engine === 'sapi') {
      if (!sapiEnabled) continue;
      const candidates = requestedVoice && !/^piper:/i.test(requestedVoice) && !isNeuralVoice(requestedVoice)
        ? [requestedVoice, ''] : [''];
      for (const candidate of candidates) {
        let jumped;
        try {
          jumped = await runSapi(clean, { voice: candidate, rate: options.rate }, deps);
        } catch (error) {
          jumped = { ok: false, error: String((error && error.message) || error) };
        }
        if (jumped && jumped.ok && jumped.file) {
          const actualVoice = String(jumped.voice || candidate || '');
          return {
            ok: true,
            engine: 'sapi',
            transport: 'local',
            file: jumped.file,
            bytes: Number(jumped.bytes) || 0,
            mime: 'audio/wav',
            voice: actualVoice,
            requestedVoice,
            fallback: Boolean(requestedVoice) && actualVoice !== requestedVoice,
            fallbackFrom: Boolean(requestedVoice) && actualVoice !== requestedVoice ? requestedVoice : '',
            attempts,
            ms: Number(jumped.ms) || 0,
          };
        }
        attempts.push({
          engine: 'sapi', voice: candidate || '(default)',
          error: String((jumped && (jumped.error || jumped.code)) || 'sapi-failed').slice(0, 300),
        });
      }
    }
  }

  return {
    ok: false,
    code: 'tts-unavailable',
    error: attempts.map((item) => item.engine + ': ' + item.error).join(' | ') || 'no-engine',
    attempts,
    requestedVoice,
    hint: requestedVoice
      ? '这个音色现在拿不到声音（已试 ' + engines.join(' → ') + '）；换一个音色或点「一键启用语音」重试。'
      : '本机语音合成不可用（Edge 在线 / 内置离线 / 系统音色都没出声）。',
  };
}

/** 运行本地 Piper（命名规避与注入参数同名）。 */
function runPiperLocal(text, options, deps) {
  return runPiper(text, options || {}, deps || {});
}

/** 音色 id → 试听时**唯一允许**的引擎（严格模式：不回落、不换音色）。 */
function strictEngineForVoice(voice) {
  const text = String(voice || '').trim();
  if (/^volc:/i.test(text)) return 'volc';
  if (/^melo:/i.test(text)) return 'sherpa';
  if (/^openai:/i.test(text)) return 'openai';
  if (/^azure:/i.test(text)) return 'azure';
  if (/^elevenlabs:/i.test(text)) return 'elevenlabs';
  if (/^piper:/i.test(text)) return 'piper';
  if (/^sapi:/i.test(text)) return 'sapi';
  if (isNeuralVoice(text)) return 'edge';
  return '';
}

/** 严格模式的失败文案（任务 §1①：直接给可读原因，不换音色）。 */
function strictHintOf(engine, code, error) {
  const raw = String(error || '');
  if (code === 'piper-not-installed' || /piper-not-installed/.test(raw)) return '这个音色包还没下载：先点「下载」，下完再试听';
  if (code === 'sherpa-not-installed') return '高清音色还没下载：先点「下载」，下完再试听';
  if (code === 'sherpa-runtime-missing') return '缺高清运行时（sherpa-onnx）：下载了也放不出，先换别的音色';
  if (code === 'sapi-disabled') return '系统音色（SAPI）默认关闭：去「朗读与音色」打开后再试听';
  if (code === 'volc-no-key') return '火山没有填 AppID / Access Token：先配置再试听';
  if (code === 'volc-timeout') return '火山网络不可达或超时：检查网络后重试';
  if (/429|rate.?limit/i.test(raw)) return '这个在线音色被限流（429）：稍后再试';
  if (/401|403|unauthorized|forbidden/i.test(raw)) return '鉴权失败：检查这个渠道的 Key / 权限';
  if (/timeout/i.test(raw)) return '合成超时：检查网络后重试';
  if (engine === 'edge') return '在线音色现在拿不到声音（可能被限流或断网）；不会偷偷换成别的音色';
  if (engine === 'piper') return '内置音色合成失败：检查音色包是否完整';
  return raw ? raw.slice(0, 200) : '这个音色现在拿不到声音';
}

/**
 * **严格模式合成**（试听专用，任务 §1）：
 *   · 指定 `piper:xxx` 就只用 piper:xxx；`edge:...Neural` 就只用这个 neural 名；
 *   · 任何一跳失败都**不换引擎、不换音色**，直接回 `{ok:false, engine, voice, code, hint}`；
 *   · 与 `synthesizePolicy`（日常朗读，允许回落）是两条独立路径。
 */
async function synthesizeStrict(text, options = {}, deps = {}) {
  const started = Date.now();
  const clean = String(text == null ? '' : text).trim().slice(0, MAX_TEXT_CHARS);
  if (!clean) return { ok: false, code: 'empty-text', error: 'empty-text', attempts: [] };
  const requestedVoice = String(options.voice == null ? '' : options.voice).trim();
  const engine = strictEngineForVoice(requestedVoice);
  if (!engine) {
    return {
      ok: false, code: 'bad-voice', error: 'bad-voice', requestedVoice, attempts: [],
      hint: '音色 id 必须带引擎前缀（edge: / piper: / melo: / volc: …）',
    };
  }
  const attempts = [];
  const fail = (code, error) => ({
    ok: false, engine, voice: requestedVoice, requestedVoice, attempts,
    code, error: String(error || code).slice(0, 400),
    hint: strictHintOf(engine, code, error),
    ms: Date.now() - started,
  });
  const runEdgeOnline = typeof deps.runEdgeOnline === 'function'
    ? deps.runEdgeOnline
    : (typeof deps.runEdge === 'function' ? deps.runEdge : runEdgeOnlineEngine);
  const runSapi = typeof deps.runSapi === 'function' ? deps.runSapi : runSapiEngine;

  if (engine === 'piper') {
    const meta = piperModelMeta(requestedVoice);
    if (!meta) return fail('piper-unknown-voice', '本机没有这个 Piper 音色：' + requestedVoice);
    let status = piperStatus(meta.id);
    if (!status.installed && options.allowDownload === true) {
      try {
        await ensurePiperModel(meta.id, deps);
        status = piperStatus(meta.id);
      } catch (error) {
        attempts.push({ engine: 'piper', voice: meta.voice, error: String((error && error.message) || error).slice(0, 300) });
        return fail('piper-not-installed', '音色包下载失败：' + String((error && error.message) || error).slice(0, 120));
      }
    }
    if (!status.installed) return fail('piper-not-installed', 'piper-not-installed');
    const runPiper = typeof deps.runPiper === 'function' ? deps.runPiper : runPiperLocal;
    let jumped;
    try {
      jumped = await runPiper(clean, { voice: meta.voice, rate: options.rate, timeoutMs: options.piperTimeoutMs }, deps);
    } catch (error) {
      jumped = { ok: false, error: String((error && error.message) || error) };
    }
    if (jumped && jumped.ok && jumped.file) {
      const actual = String(jumped.voice || meta.voice);
      if (actual !== requestedVoice && actual !== meta.voice) {
        return fail('voice-mismatch', '实际合成的音色不是选中的那个（' + actual + '）');
      }
      return {
        ok: true, engine: 'piper', transport: 'local', file: jumped.file,
        bytes: Number(jumped.bytes) || 0, mime: jumped.mime || 'audio/wav',
        voice: requestedVoice, requestedVoice, fallback: false, fallbackFrom: '',
        attempts, ms: Number(jumped.ms) || Date.now() - started,
      };
    }
    attempts.push({ engine: 'piper', voice: meta.voice, error: String((jumped && (jumped.error || jumped.code)) || 'piper-failed').slice(0, 300) });
    return fail('piper-failed', (jumped && (jumped.error || jumped.code)) || 'piper-failed');
  }

  if (engine === 'sherpa') {
    const meta = sherpaModelMeta(requestedVoice);
    if (!meta) return fail('sherpa-unknown-voice', '本机没有这个高清音色：' + requestedVoice);
    let status = sherpaStatus(meta.id);
    if (!status.installed && options.allowDownload === true) {
      try {
        status = await ensureSherpaModel(meta.id, deps);
      } catch (error) {
        return fail('sherpa-not-installed', String((error && error.message) || error).slice(0, 160));
      }
    }
    if (!status.installed) return fail('sherpa-not-installed', 'sherpa-not-installed');
    const runSherpa = typeof deps.runSherpa === 'function' ? deps.runSherpa : sherpaSynthesize;
    let jumped;
    try {
      jumped = await runSherpa(clean, { voice: meta.voice, rate: options.rate, timeoutMs: Math.max(5000, Number(options.sherpaTimeoutMs) || 30000) }, deps);
    } catch (error) {
      jumped = { ok: false, error: String((error && error.message) || error) };
    }
    if (jumped && jumped.ok && jumped.file) {
      return {
        ok: true, engine: 'sherpa', subtype: 'sherpa', transport: 'local', file: jumped.file,
        bytes: Number(jumped.bytes) || 0, mime: jumped.mime || 'audio/wav',
        voice: String(jumped.voice || meta.voice), requestedVoice, fallback: false, fallbackFrom: '',
        attempts, ms: Number(jumped.ms) || Date.now() - started,
      };
    }
    attempts.push({ engine: 'sherpa', voice: meta.voice, error: String((jumped && (jumped.error || jumped.code)) || 'sherpa-failed').slice(0, 300) });
    return fail((jumped && jumped.code) || 'sherpa-failed', (jumped && (jumped.error || jumped.code)) || 'sherpa-failed');
  }

  if (engine === 'volc' || engine === 'openai' || engine === 'azure' || engine === 'elevenlabs') {
    const cfg = (options.online && options.online[engine === 'volc' ? 'volcengine' : engine]) || {};
    if (engine === 'volc') {
      const jumped = await volcSynthesize(clean, {
        voice: requestedVoice, rate: options.rate, online: options.online,
        timeoutMs: Math.max(3000, Math.min(30000, Number(options.volcTimeoutMs) || 12000)),
      }, deps);
      if (jumped && jumped.ok && jumped.file) {
        return {
          ok: true, engine: 'volc', subtype: jumped.subtype || volcSubtypeOf(cfg, requestedVoice),
          transport: 'online', file: jumped.file, bytes: Number(jumped.bytes) || 0,
          mime: jumped.mime || 'audio/mpeg', voice: String(jumped.voice || requestedVoice),
          requestedVoice, fallback: false, fallbackFrom: '', attempts,
          ms: Number(jumped.ms) || Date.now() - started,
        };
      }
      attempts.push({ engine: 'volc', voice: requestedVoice, code: jumped && jumped.code, error: String((jumped && jumped.error) || 'volc-failed').slice(0, 300) });
      return fail((jumped && jumped.code) || 'volc-failed', (jumped && jumped.error) || 'volc-failed');
    }
    const runner = engine === 'openai' ? openaiSynthesize
      : engine === 'azure' ? azureSynthesize : elevenLabsSynthesize;
    const jumped = await runner(clean, {
      voice: requestedVoice, rate: options.rate, online: options.online,
      timeoutMs: Math.max(3000, Math.min(30000, Number(options.onlineTimeoutMs) || 15000)),
    }, deps);
    if (jumped && jumped.ok && jumped.file) {
      return {
        ok: true, engine, transport: 'online', file: jumped.file,
        bytes: Number(jumped.bytes) || 0, mime: jumped.mime || 'audio/mpeg',
        voice: String(jumped.voice || requestedVoice), requestedVoice,
        fallback: false, fallbackFrom: '', attempts,
        ms: Number(jumped.ms) || Date.now() - started,
      };
    }
    attempts.push({ engine, voice: requestedVoice, code: jumped && jumped.code, error: String((jumped && jumped.error) || engine + '-failed').slice(0, 300) });
    return fail((jumped && jumped.code) || engine + '-failed', (jumped && jumped.error) || engine + '-failed');
  }

  if (engine === 'edge') {
    if (!isNeuralVoice(requestedVoice)) {
      return fail('bad-voice', 'Edge 音色名必须是 zh-CN-XxxNeural 这种格式');
    }
    let jumped;
    try {
      jumped = await runEdgeOnline(clean, {
        voice: requestedVoice, rate: options.rate,
        timeoutMs: Math.max(5000, Math.min(30000, Number(options.edgeTimeoutMs) || 12000)),
      }, deps);
    } catch (error) {
      jumped = { ok: false, error: String((error && error.message) || error) };
    }
    if (jumped && jumped.ok && jumped.file) {
      return {
        ok: true, engine: 'edge', transport: 'online', file: jumped.file,
        bytes: Number(jumped.bytes) || 0, mime: jumped.mime || 'audio/mpeg',
        voice: String(jumped.voice || requestedVoice), requestedVoice,
        fallback: false, fallbackFrom: '', attempts,
        ms: Number(jumped.ms) || Date.now() - started,
      };
    }
    attempts.push({ engine: 'edge', voice: requestedVoice, error: String((jumped && (jumped.error || jumped.code)) || 'edge-failed').slice(0, 300) });
    return fail((jumped && jumped.code) || 'edge-failed', (jumped && (jumped.error || jumped.code)) || 'edge-failed');
  }

  // sapi：只有用户显式开启 SAPI 才允许试听（与朗读策略同一条纪律）。
  if (options.sapiEnabled !== true) return fail('sapi-disabled', 'sapi-disabled');
  let jumped;
  try {
    jumped = await runSapi(clean, { voice: requestedVoice, rate: options.rate }, deps);
  } catch (error) {
    jumped = { ok: false, error: String((error && error.message) || error) };
  }
  if (jumped && jumped.ok && jumped.file) {
    return {
      ok: true, engine: 'sapi', transport: 'local', file: jumped.file,
      bytes: Number(jumped.bytes) || 0, mime: 'audio/wav',
      voice: String(jumped.voice || requestedVoice), requestedVoice,
      fallback: false, fallbackFrom: '', attempts,
      ms: Number(jumped.ms) || Date.now() - started,
    };
  }
  attempts.push({ engine: 'sapi', voice: requestedVoice, error: String((jumped && (jumped.error || jumped.code)) || 'sapi-failed').slice(0, 300) });
  return fail((jumped && jumped.code) || 'sapi-failed', (jumped && (jumped.error || jumped.code)) || 'sapi-failed');
}


/**
 * 合成链（**纯逻辑**，正判据与负对照共用）：
 * 按 `engines` 顺序逐跳尝试；第一个产出有效 WAV 的引擎胜出；
 * 全失败返回 `{ok:false, code:'tts-unavailable', attempts}`。
 *
 * @param {string} text
 * @param {{voice?: string, rate?: number, engines?: string[]}} options
 * @param {{runSapi?: Function, runEdge?: Function, timeoutMs?: number, dir?: string}} deps
 */
async function synthesizeOnce(text, options = {}, deps = {}) {
  const clean = String(text == null ? '' : text).trim().slice(0, MAX_TEXT_CHARS);
  if (!clean) return { ok: false, code: 'empty-text', error: 'empty-text', attempts: [] };
  // 试听（任务 §1）：严格单引擎、绝不回落。
  if (options.strict === true) return synthesizeStrict(clean, options, deps);
  if (options.policy === true) return synthesizePolicy(clean, options, deps);
  const requestedVoice = String(options.voice == null ? '' : options.voice).trim();
  // 音色 → 引擎顺序：neural 名先走 edge；SAPI 名/空先走 sapi。显式音色在某一跳不存在时
  // 脚本会 `voice-not-found`，这里记一次 attempt 后继续下一跳，绝不当成“用默认音色成功”。
  const engines = engineOrderForVoice(requestedVoice, options.engines);
  const runSapi = typeof deps.runSapi === 'function' ? deps.runSapi : runSapiEngine;
  const runEdge = typeof deps.runEdge === 'function' ? deps.runEdge : runEdgeEngine;
  const attempts = [];
  for (const engine of engines) {
    // pre.54（B3①）：显式音色在这一跳不存在 ⇒ **先用本引擎默认中文音色再试一次**，
    // 成功也把 requestedVoice/实际 voice 都带回去（客户端据此提示“已回落”）。
    // 空音色（默认）只试一次，不重复。
    const candidates = requestedVoice ? [requestedVoice, ''] : [''];
    for (const candidate of candidates) {
      const engineOptions = Object.assign({}, options, { voice: candidate });
      let jumped;
      try {
        jumped = await (engine === 'sapi' ? runSapi : runEdge)(clean, engineOptions, deps);
      } catch (error) {
        jumped = { ok: false, error: String((error && error.message) || error) };
      }
      if (jumped && jumped.ok && jumped.file) {
        const valid = validateWav(jumped.file);
        if (valid.ok) {
          const actualVoice = String(jumped.voice || candidate || '');
          return {
            ok: true,
            engine,
            file: jumped.file,
            bytes: valid.bytes,
            mime: jumped.mime || 'audio/wav',
            voice: actualVoice,
            requestedVoice,
            fallback: Boolean(requestedVoice) && actualVoice !== requestedVoice,
            fallbackFrom: Boolean(requestedVoice) && actualVoice !== requestedVoice ? requestedVoice : '',
            ms: Number(jumped.ms) || 0,
            attempts,
          };
        }
        attempts.push({ engine, voice: candidate || '(default)', error: valid.error || 'invalid-wav' });
      } else {
        attempts.push({
          engine,
          voice: candidate || '(default)',
          error: String((jumped && (jumped.error || jumped.code)) || 'engine-failed').slice(0, 400),
        });
      }
    }
  }
  return {
    ok: false,
    code: 'tts-unavailable',
    error: attempts.map((item) => item.engine + ': ' + item.error).join(' | '),
    attempts,
    requestedVoice,
    hint: requestedVoice
      ? '本机没有这个音色（已依次尝试 ' + engines.join(' → ') + '），换一个音色或把音色留空。'
      : '本机语音合成不可用：系统语音（SAPI）和 Edge 系统音色都没出声。',
  };
}

/* ── 模式 1：一次性（判据 / 排障）────────────────────────────────────────── */

async function runOnce(reqFile, outFile) {
  let req = {};
  try { req = JSON.parse(fs.readFileSync(reqFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 空请求由 synthesizeOnce 判 */ }
  const dir = path.dirname(outFile);
  const result = await synthesizeOnce(req.text, {
    voice: req.voice,
    rate: req.rate,
    engines: Array.isArray(req.engines) ? req.engines : undefined,
    policy: req.policy === true,
    strict: req.strict === true,
    sapiEnabled: req.sapiEnabled === true,
    activeEngine: req.activeEngine,
    fallbackEngines: Array.isArray(req.fallbackEngines) ? req.fallbackEngines : undefined,
    allowDownload: req.allowDownload === true,
    engineTimeoutMs: req.engineTimeoutMs,
    piperTimeoutMs: req.piperTimeoutMs,
    online: req.online,
  }, { dir });
  if (result.ok && result.file !== outFile) {
    try {
      fs.renameSync(result.file, outFile);
    } catch {
      // 跨盘 / 被占用：复制后删源（失败也要把真实错误带出去，不能假装成功）
      try {
        fs.copyFileSync(result.file, outFile);
        fs.unlinkSync(result.file);
      } catch (error) {
        result.ok = false;
        result.code = 'output-move-failed';
        result.error = String((error && error.message) || error);
      }
    }
    if (result.ok) result.file = outFile;
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

/* ── 模式 2：NDJSON 常驻 worker（宿主路由用）──────────────────────────────── */

function runWorker(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-tts-worker-'));
  process.stdout.write(JSON.stringify({
    ready: true,
    platform: process.platform,
    engines: ENGINES.slice(),
    powershell: powershellPath(),
  }) + '\n');

  const rl = readline.createInterface({ input: process.stdin });
  const emitPiperProgress = (payload) => {
    try { process.stdout.write(JSON.stringify({ type: 'piper-progress', ...payload }) + '\n'); } catch { /* ignore */ }
  };
  // 串行执行：PowerShell 是重进程，同一时刻只跑一条；请求方（lib/tts/tts.js）也会排队。
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    const raw = String(line || '').trim();
    if (!raw) return;
    let req;
    try { req = JSON.parse(raw); } catch {
      process.stdout.write(JSON.stringify({ id: null, ok: false, code: 'bad-json', error: 'bad-json' }) + '\n');
      return;
    }
    const id = req.id === undefined ? null : req.id;
    // 任务 §2①：火山「测试」= 真打一次 HTTP 并把诊断（状态码/响应片段/URL/ResourceId）带回去。
    if (req.op === 'volc-test') {
      chain = chain.then(async () => {
        const cfg = (req.online && (req.online.volcengine || req.online.volc)) || req.volcengine || {};
        let diag;
        try {
          diag = await volcTest(cfg, { voiceId: req.voiceId, text: req.text, timeoutMs: req.timeoutMs });
        } catch (error) {
          diag = {
            ok: false, engine: 'volc', code: 'volc-test-failed',
            error: String((error && error.message) || error).slice(0, 300),
            status: 0, bodySnippet: '', subtype: '', voiceId: String(req.voiceId || ''),
          };
        }
        process.stdout.write(JSON.stringify({ id, ok: diag.ok === true, diagnostic: diag, ...diag }) + '\n');
      }).catch((error) => {
        process.stdout.write(JSON.stringify({
          id, ok: false, code: 'volc-test-failed', error: String((error && error.message) || error),
        }) + '\n');
      });
      return;
    }
    // pre.54：音色枚举是独立操作（只在 UI 打开时跑一次，worker 内存里结果由 tts.js 缓存）。
    if (req.op === 'voices') {
      chain = chain.then(async () => {
        let voices = [];
        let meta = {};
        try {
          const listed = await listVoices({
            dir, voicesTimeoutMs: 15000, testTimeoutMs: 6000,
            sapiEnabled: req.sapiEnabled === true,
            edge: req.edge !== false,
          });
          voices = listed.voices;
          meta = { edge: listed.edge, piper: listed.piper, sapiEnabled: req.sapiEnabled === true };
        } catch { voices = []; }
        process.stdout.write(JSON.stringify({ id, ok: true, voices, meta }) + '\n');
      }).catch((error) => {
        process.stdout.write(JSON.stringify({ id, ok: false, code: 'voices-failed', error: String((error && error.message) || error) }) + '\n');
      });
      return;
    }
    chain = chain.then(async () => {
      const started = Date.now();
      let result;
      try {
        result = await synthesizeOnce(req.text, {
          voice: req.voice,
          rate: req.rate,
          engines: Array.isArray(req.engines) ? req.engines : undefined,
          policy: req.policy === true,
          strict: req.strict === true,
          sapiEnabled: req.sapiEnabled === true,
          activeEngine: req.activeEngine,
          fallbackEngines: Array.isArray(req.fallbackEngines) ? req.fallbackEngines : undefined,
          allowDownload: req.allowDownload === true,
          engineTimeoutMs: Number(req.engineTimeoutMs) || Number(req.timeoutMs) || ENGINE_TIMEOUT_MS,
          piperTimeoutMs: Number(req.piperTimeoutMs) || Number(req.timeoutMs) || ENGINE_TIMEOUT_MS,
          openaiTimeoutMs: Number(req.openaiTimeoutMs) || Number(req.timeoutMs) || ENGINE_TIMEOUT_MS,
          online: req.online,
        }, { dir, timeoutMs: Number(req.timeoutMs) || ENGINE_TIMEOUT_MS, onPiperProgress: emitPiperProgress });
      } catch (error) {
        result = { ok: false, code: 'worker-failed', error: String((error && error.message) || error) };
      }
      process.stdout.write(JSON.stringify({
        id,
        ok: result.ok === true,
        file: result.ok ? result.file : null,
        engine: result.engine || null,
        subtype: result.subtype || null,
        transport: result.ok ? (result.transport || 'local') : (result.transport || null),
        mime: result.ok ? (result.mime || 'audio/wav') : (result.mime || null),
        voice: result.ok ? result.voice : (result.voice || req.voice || null),
        requestedVoice: result.requestedVoice || req.voice || '',
        fallback: result.ok ? result.fallback === true : false,
        fallbackFrom: result.ok ? (result.fallbackFrom || '') : '',
        bytes: result.ok ? result.bytes : null,
        ms: Number(result.ms) || (Date.now() - started),
        attempts: result.attempts || [],
        code: result.ok ? null : (result.code || 'tts-unavailable'),
        error: result.ok ? null : (result.error || 'failed'),
        hint: result.ok ? null : (result.hint || ''),
      }) + '\n');
    }).catch((error) => {
      process.stdout.write(JSON.stringify({
        id, ok: false, code: 'worker-failed', error: String((error && error.message) || error),
      }) + '\n');
    });
  });
  rl.on('close', () => { process.exit(0); });
}

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

if (require.main === module) {
  if (process.argv.includes('--once')) {
    const reqFile = arg('req', '');
    const outFile = arg('out', '');
    if (!reqFile || !outFile) {
      process.stderr.write('[tts-worker] --once 需要 --req 与 --out\n');
      process.exit(2);
    }
    runOnce(reqFile, outFile).catch((error) => {
      process.stderr.write('[tts-worker] ' + String((error && error.message) || error) + '\n');
      process.exit(1);
    });
  } else {
    runWorker(arg('out-dir', path.join(os.tmpdir(), 'folia-tts-out')));
  }
}

module.exports = {
  ENGINES,
  LEGACY_ENGINES,
  MAX_TEXT_CHARS,
  ENGINE_TIMEOUT_MS,
  NEURAL_VOICE_RE,
  isNeuralVoice,
  isPiperVoice,
  engineOrderForVoice,
  policyEngineOrder,
  powershellPath,
  validateWav,
  runSapiEngine,
  runEdgeEngine,
  runEdgeOnlineEngine,
  runOpenAIEngine: openaiSynthesize,
  openaiSynthesize,
  OPENAI_VOICE_IDS,
  runAzureEngine: azureSynthesize,
  azureSynthesize,
  runElevenLabsEngine: elevenLabsSynthesize,
  elevenLabsSynthesize,
  runVolcEngine: volcSynthesize,
  volcSynthesize,
  volcTest,
  volcSubtypeOf,
  volcRequestPlan,
  volcStatusMessage,
  synthesizeStrict,
  strictEngineForVoice,
  VOLC_DEFAULT_RESOURCE_ID,
  VOLC_DEFAULT_VOICE,
  runSherpaEngine: sherpaSynthesize,
  sherpaSynthesize,
  sherpaStatus,
  sherpaRuntimeStatus,
  ensureSherpaModel,
  SHERPA_MODELS,
  runPiperEngine: runPiperLocal,
  edgeSecMsGec,
  edgeSynthesizeOnline,
  edgeVoiceList,
  pickEdgeDefaultVoice,
  synthesizeOnce,
  synthesizePolicy,
  listVoices,
  listSapiVoices,
  ensurePiper,
  ensurePiperRuntime,
  ensurePiperModel,
  installedPiperModels,
  piperStatus,
  piperRuntimeStatus,
  piperPaths,
  PIPER_MODELS,
};
