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
const ENGINES = Object.freeze(['edge', 'openai', 'piper', 'sapi']);
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
 * 内置 Piper 神经音色（v0.2 兜底）
 *
 * 资源不进 npm 包：首次真正需要时下载 Windows 版 Piper + 一个中文模型。
 * 下载/解压都用独立文件与 `tar.exe`，不经过 Node 管道，避开 Electron 的 piped-stdio 限制。
 * ═══════════════════════════════════════════════════════════════════════════ */
const PIPER_VERSION = 'v1';
const PIPER_ASSET = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const PIPER_MODEL_ID = 'piper:zh_CN-huayan-medium';
const PIPER_MODEL_LABEL = '华言（Piper 离线）';
const PIPER_MODEL_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium';
/** 站点镜像优先；上游只作第二备用。运维用 FOLIA_MODEL_MIRROR 换 R2/自有域名。 */
const PIPER_SITE_BASE = String(process.env.FOLIA_MODEL_MIRROR || 'https://folia-5ve.pages.dev/media/').replace(/\/?$/, '/');
const PIPER_SITE_PREFIX = PIPER_SITE_BASE + 'piper/v1/';
/** 固定资产 sha256（下载后必须逐字节一致；失败删文件并重试，绝不拿半截包解压）。 */
const PIPER_ASSET_SHA256 = 'F3C58906402B24F3A96D92145F58ACBA6D86C9B5DB896D207F78DC80811EFCEA';
const PIPER_MODEL_SHA256 = '9929917BF8CABB26FD528EA44D3A6699C11E87317A14765312420BE230BE0F3D';
const PIPER_CONFIG_SHA256 = 'D521DC45504A8CCC99E325822B35946DD701840BFB07E3DBB31A40929ED6A82B';
const PIPER_ASSET_SIZE = 22477236;
const PIPER_MODEL_SIZE = 63201294;
const PIPER_CONFIG_SIZE = 4822;

function piperRoot() {
  const home = process.env.DSH_FOLIA_HOME || path.join(os.homedir(), '.dsh-folia');
  return process.env.FOLIA_PIPER_ROOT || path.join(home, 'piper', PIPER_VERSION);
}

function piperPaths() {
  const root = piperRoot();
  return {
    root,
    exe: path.join(root, 'piper', 'piper.exe'),
    espeak: path.join(root, 'piper', 'espeak-ng-data'),
    model: path.join(root, 'models', 'zh_CN-huayan-medium.onnx'),
    config: path.join(root, 'models', 'zh_CN-huayan-medium.onnx.json'),
    zip: path.join(root, 'piper_windows_amd64.zip'),
    marker: path.join(root, 'installed.json'),
  };
}

function piperStatus() {
  const paths = piperPaths();
  let installed = false;
  let sizeBytes = 0;
  try {
    installed = fs.existsSync(paths.exe) && fs.existsSync(paths.model) && fs.existsSync(paths.config)
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

let piperInstallPromise = null;
function ensurePiper(deps) {
  if (piperStatus().installed) return Promise.resolve(piperStatus());
  if (piperInstallPromise) return piperInstallPromise;
  piperInstallPromise = (async () => {
    const paths = piperPaths();
    fs.mkdirSync(paths.root, { recursive: true });
    const assetUrls = [
      process.env.FOLIA_PIPER_ASSET_URL,
      PIPER_SITE_PREFIX + 'piper_windows_amd64.zip',
      PIPER_ASSET,
    ];
    const modelUrls = [
      process.env.FOLIA_PIPER_MODEL_URL,
      PIPER_SITE_PREFIX + 'zh_CN-huayan-medium.onnx',
      PIPER_MODEL_BASE + '.onnx',
    ];
    const configUrls = [
      process.env.FOLIA_PIPER_CONFIG_URL,
      PIPER_SITE_PREFIX + 'zh_CN-huayan-medium.onnx.json',
      PIPER_MODEL_BASE + '.onnx.json',
    ];
    const report = (payload) => {
      if (deps && typeof deps.onPiperProgress === 'function') deps.onPiperProgress(payload);
    };
    report({ phase: 'resolve', file: 'runtime', doneBytes: 0, totalBytes: PIPER_ASSET_SIZE + PIPER_MODEL_SIZE + PIPER_CONFIG_SIZE });
    if (!fs.existsSync(paths.exe)) {
      await downloadFirst(assetUrls, paths.zip, 300000, PIPER_ASSET_SHA256, PIPER_ASSET_SIZE,
        (p) => report({ ...p, file: 'runtime', phase: p.phase || 'download' }));
      report({ phase: 'unzip', file: 'runtime', doneBytes: PIPER_ASSET_SIZE, totalBytes: PIPER_ASSET_SIZE + PIPER_MODEL_SIZE + PIPER_CONFIG_SIZE });
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
    }
    let modelOk = false;
    try { modelOk = fs.existsSync(paths.model) && (await fileSha256(paths.model)) === PIPER_MODEL_SHA256; } catch { modelOk = false; }
    if (!modelOk) {
      await downloadFirst(modelUrls, paths.model, 600000, PIPER_MODEL_SHA256, PIPER_MODEL_SIZE,
        (p) => report({ ...p, file: 'model', phase: p.phase || 'download' }));
    }
    let configOk = false;
    try { configOk = fs.existsSync(paths.config) && (await fileSha256(paths.config)) === PIPER_CONFIG_SHA256; } catch { configOk = false; }
    if (!configOk) {
      await downloadFirst(configUrls, paths.config, 60000, PIPER_CONFIG_SHA256, PIPER_CONFIG_SIZE,
        (p) => report({ ...p, file: 'config', phase: p.phase || 'download' }));
    }
    const status = piperStatus();
    if (!status.installed) throw new Error('piper-install-incomplete');
    fs.writeFileSync(paths.marker, JSON.stringify({
      version: PIPER_VERSION, model: PIPER_MODEL_ID, at: new Date().toISOString(),
    }, null, 2));
    try { fs.rmSync(paths.zip, { force: true }); } catch { /* ignore */ }
    report({ phase: 'ready', file: 'model', doneBytes: PIPER_MODEL_SIZE, totalBytes: PIPER_MODEL_SIZE });
    return status;
  })().catch((error) => {
    if (deps && typeof deps.onPiperProgress === 'function') {
      deps.onPiperProgress({ phase: 'failed', error: String((error && error.message) || error) });
    }
    piperInstallPromise = null;
    throw error;
  });
  return piperInstallPromise;
}

/** 跑一次 Piper（stdin 由 cmd 重定向文件提供，避免 Node 管道）。 */
function runPiper(text, options, deps) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, engine: 'piper', error: 'windows-only', ms: 0 });
      return;
    }
    const status = piperStatus();
    if (!status.installed) {
      resolve({ ok: false, engine: 'piper', error: 'piper-not-installed', ms: 0 });
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
    const paths = piperPaths();
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
        voice: PIPER_MODEL_ID, mime: 'audio/wav', transport: 'local',
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
  if (piper.installed) {
    out.push({
      engine: 'piper', id: PIPER_MODEL_ID, label: PIPER_MODEL_LABEL,
      lang: 'zh-CN', gender: 'Female', usable: true, offline: true, requiresKey: false,
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
 *   1. Edge 在线神经音色（免 Key；空音色 = 默认晓晓）
 *   2. 内置 Piper 神经音色（离线；没装时由 setup 下载）
 *   3. 系统 SAPI（**默认不参与**，只有 sapiEnabled=true 才追加）
 *
 * 显式选了 SAPI 名但 SAPI 关闭时，不偷偷用机械音：先走 Edge，并在结果里标 fallback。
 */
function policyEngineOrder(voice, sapiEnabled) {
  const requested = String(voice == null ? '' : voice).trim();
  let order;
  if (/^openai:/i.test(requested)) order = ['openai', 'edge', 'piper', 'sapi'];
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
  const engines = policyEngineOrder(requestedVoice, sapiEnabled);
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
  for (const engine of engines) {
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
      const piper = piperStatus();
      // 判据可以注入 runPiper 验证顺序；只有真实运行才要求模型已落盘。
      if (!piper.installed && options.allowDownload !== true && typeof deps.runPiper !== 'function') {
        attempts.push({ engine: 'piper', voice: PIPER_MODEL_ID, error: 'piper-not-installed' });
        continue;
      }
      try {
        if (!piper.installed && typeof deps.runPiper !== 'function') await ensurePiper(deps);
      } catch (error) {
        attempts.push({ engine: 'piper', voice: PIPER_MODEL_ID, error: String((error && error.message) || error).slice(0, 300) });
        continue;
      }
      let jumped;
      try {
        jumped = await runPiper(clean, { rate: options.rate, timeoutMs: options.piperTimeoutMs }, deps);
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
          voice: jumped.voice || PIPER_MODEL_ID,
          requestedVoice,
          fallback: Boolean(requestedVoice) && String(jumped.voice || PIPER_MODEL_ID) !== requestedVoice,
          fallbackFrom: Boolean(requestedVoice) && String(jumped.voice || PIPER_MODEL_ID) !== requestedVoice ? requestedVoice : '',
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
    sapiEnabled: req.sapiEnabled === true,
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
          sapiEnabled: req.sapiEnabled === true,
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
        engine: result.ok ? result.engine : null,
        transport: result.ok ? (result.transport || 'local') : null,
        mime: result.ok ? (result.mime || 'audio/wav') : null,
        voice: result.ok ? result.voice : null,
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
  piperStatus,
};
