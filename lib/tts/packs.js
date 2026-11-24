/**
 * tts/packs.js — 内置音色包目录与安装器（v2）。
 *
 * 两种包：
 *   · piper  —— Piper 离线模型（模型/配置各一个文件；piper.exe 运行时共享）；
 *   · sherpa —— 高清模型（sherpa-onnx 运行时 + tar.bz2 模型包；MeloTTS / Aishell3）。
 *
 * 单一事实源：
 *   · 模型 id / 体积 / sha256 来自 `tts-worker.cjs` 的 `PIPER_MODELS` / `SHERPA_MODELS`
 *     （下载器与合成器同一份）；
 *   · 本文件只补「用户可见的包」这一层：包 id、名称、许可、语言、音质标签、推荐顺序。
 *
 * 纪律：
 *   · 不新增下载器 —— 复用 worker 的 `ensurePiperRuntime` / `ensurePiperModel` /
 *     `ensureSherpaModel`（Range 续传、sha256 校验、多源重试、进度上报都在那里）；
 *   · 进度是**进程内实时状态**，安装完成后落盘判断以文件为准，不信任内存；
 *   · 删除只删模型，不删共享运行时。
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const worker = require('./tts-worker.cjs');

/** 包目录（用户可见）。顺序即界面顺序。 */
export const VOICE_PACKS = Object.freeze([
  {
    id: 'piper-zh-huayan',
    engine: 'piper',
    modelId: 'zh_CN-huayan-medium',
    name: '华言',
    desc: '内置中文女声，离线可用；装机后默认音色。',
    lang: 'zh-CN', gender: 'Female', quality: '标准', hd: false, recommended: true,
    license: 'MIT', source: 'Piper',
  },
  {
    id: 'piper-zh-huayan-fast',
    engine: 'piper',
    modelId: 'zh_CN-huayan-x_low',
    name: '华言快速',
    desc: '低配机器专用：体积约为标准版的三分之一，速度更快，音质略低。',
    lang: 'zh-CN', gender: 'Female', quality: '快速', hd: false,
    license: 'MIT', source: 'Piper',
  },
  {
    id: 'piper-en-female',
    engine: 'piper',
    modelId: 'en_US-amy-medium',
    name: '英文女',
    desc: '英文人设用；美式发音，离线。',
    lang: 'en-US', gender: 'Female', quality: '标准', hd: false,
    license: 'MIT', source: 'Piper',
  },
  {
    id: 'piper-en-male',
    engine: 'piper',
    modelId: 'en_US-ryan-medium',
    name: '英文男',
    desc: '英文人设用；美式发音，离线。',
    lang: 'en-US', gender: 'Male', quality: '标准', hd: false,
    license: 'MIT', source: 'Piper',
  },
  {
    id: 'melo-zh-female',
    engine: 'sherpa',
    sherpaId: 'melo-zh-female',
    name: '高清中文女',
    desc: 'MeloTTS 高清中文女声（约 160MB），离线；需要下载高清运行时，音质明显更自然。',
    lang: 'zh-CN', gender: 'Female', quality: '高清', hd: true,
    license: 'MIT', source: 'MeloTTS · sherpa-onnx',
  },
  // 高清中文男（abyssinvoker）模型非商用许可，不随插件分发；如需男声请等待 MIT 模型。
]);

const BY_ID = new Map(VOICE_PACKS.map((pack) => [pack.id, pack]));

function sherpaMetaOf(pack) {
  return worker.SHERPA_MODELS.find((item) => item.id === pack.sherpaId) || null;
}

/** 包定义 + worker 里的模型元信息（体积 / sha / 文件路径 / 音色 id）。 */
export function packDetail(packOrId) {
  const pack = typeof packOrId === 'string' ? BY_ID.get(packOrId) : packOrId;
  if (!pack) return null;
  if (pack.engine === 'sherpa') {
    const meta = sherpaMetaOf(pack);
    return {
      ...pack,
      model: meta ? { ...meta, voice: meta.voice, sha256: '' } : null,
      voiceId: meta ? meta.voice : '',
    };
  }
  const meta = worker.PIPER_MODELS.find((item) => item.id === pack.modelId) || null;
  return { ...pack, model: meta ? { ...meta } : null, voiceId: meta ? meta.voice : '' };
}

export function packById(id) {
  const pack = BY_ID.get(String(id || ''));
  return pack ? packDetail(pack) : null;
}

function modelFiles(pack) {
  if (!pack || pack.engine !== 'piper') return { model: '', config: '' };
  const paths = worker.piperPaths(pack.modelId);
  return { model: paths.model, config: paths.config };
}

/** 已装判定：文件在 + 体积大于 1MB（sha 校验在安装时做；读取时不反复算大文件）。 */
export function packInstalled(packOrId) {
  const pack = typeof packOrId === 'string' ? packById(packOrId) : packOrId;
  if (!pack) return false;
  try {
    if (pack.engine === 'sherpa') return worker.sherpaStatus(pack.sherpaId).installed === true;
    if (!worker.piperRuntimeStatus().installed) return false;
    const files = modelFiles(pack);
    return existsSync(files.model) && existsSync(files.config) && statSync(files.model).size > 1024 * 1024;
  } catch {
    return false;
  }
}

/** 实时进度（install 期间由 worker 的 onPiperProgress 更新）。 */
const progressTable = new Map();

function normalizeProgress(pack, payload) {
  const done = Number(payload && payload.doneBytes) || 0;
  const total = Number(payload && payload.totalBytes) || 0;
  return {
    packId: pack.id,
    phase: String((payload && payload.phase) || 'download'),
    file: String((payload && payload.file) || ''),
    model: pack.modelId || pack.sherpaId || '',
    engine: pack.engine,
    doneBytes: done,
    totalBytes: total,
    percent: total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null,
    source: String((payload && payload.source) || ''),
    attempt: Number(payload && payload.attempt) || 0,
    retries: Number(payload && payload.retries) || 3,
    resuming: payload && payload.resuming === true,
    error: String((payload && payload.error) || ''),
    at: Date.now(),
  };
}

function setProgress(pack, payload) {
  const row = normalizeProgress(pack, payload);
  progressTable.set(pack.id, row);
  return row;
}

/** 当前安装进度（没有记录时按文件状态给 idle/ready）。 */
export function packProgress(id) {
  const pack = packById(id);
  if (!pack) return null;
  const current = progressTable.get(pack.id);
  const total = pack.model ? pack.model.sizeBytes : 0;
  if (current && current.phase !== 'ready' && current.phase !== 'failed') return { ...current };
  if (packInstalled(pack)) {
    return {
      packId: pack.id, phase: 'ready', file: 'model', model: pack.modelId || pack.sherpaId || '',
      engine: pack.engine, doneBytes: total, totalBytes: total,
      percent: 100, source: '', attempt: 0, retries: 3, resuming: false, error: '', at: Date.now(),
    };
  }
  if (current) return { ...current };
  return {
    packId: pack.id, phase: 'idle', file: '', model: pack.modelId || pack.sherpaId || '',
    engine: pack.engine, doneBytes: 0, totalBytes: total,
    percent: null, source: '', attempt: 0, retries: 3, resuming: false, error: '', at: 0,
  };
}

/** 正在安装的 promise（同一包并发调用只跑一次）。 */
const installing = new Map();

/**
 * 安装一个包（后台进行；调用方可轮询 `packProgress`）。
 * 复用 worker 的下载器：runtime 共享，模型/配置按包下载；Range 续传 + sha256。
 */
export function installPack(id) {
  const pack = packById(id);
  if (!pack) return Promise.reject(new Error('unknown-pack: ' + String(id || '')));
  if (packInstalled(pack)) {
    setProgress(pack, { phase: 'ready', file: 'model', doneBytes: pack.model.sizeBytes, totalBytes: pack.model.sizeBytes });
    return Promise.resolve(packProgress(pack.id));
  }
  if (installing.has(pack.id)) return installing.get(pack.id);
  const total = pack.model ? pack.model.sizeBytes : 0;
  setProgress(pack, { phase: 'resolve', file: pack.engine === 'sherpa' ? 'archive' : 'model', doneBytes: 0, totalBytes: total });
  const promise = (pack.engine === 'sherpa'
    ? worker.ensureSherpaModel(pack.sherpaId, {
      onPiperProgress: (payload) => setProgress(pack, payload),
    })
    : worker.ensurePiperRuntime({
      onPiperProgress: (payload) => setProgress(pack, {
        ...payload, totalBytes: total, doneBytes: payload.phase === 'ready' ? 0 : payload.doneBytes,
      }),
    }).then(() => worker.ensurePiperModel(pack.modelId, {
      onPiperProgress: (payload) => setProgress(pack, payload),
    }))
  ).then(() => {
    setProgress(pack, { phase: 'ready', file: 'model', doneBytes: total, totalBytes: total });
    return packProgress(pack.id);
  }).catch((error) => {
    setProgress(pack, { phase: 'failed', file: pack.engine === 'sherpa' ? 'archive' : 'model', error: String((error && error.message) || error) });
    throw error;
  }).finally(() => {
    installing.delete(pack.id);
  });
  installing.set(pack.id, promise);
  return promise;
}

/** 删除一个包的模型/配置（幂等；不动共享运行时）。 */
export function removePack(id) {
  const pack = packById(id);
  if (!pack) return { ok: false, error: 'unknown-pack' };
  if (pack.engine === 'sherpa') {
    const status = worker.sherpaStatus(pack.sherpaId);
    try { if (status.dir) rmSync(status.dir, { recursive: true, force: true }); } catch { /* 删不掉由回读判 */ }
  } else {
    const files = modelFiles(pack);
    for (const file of [files.model, files.config, files.model + '.part', files.config + '.part']) {
      try { if (file) rmSync(file, { force: true }); } catch { /* 删不掉由回读判 */ }
    }
  }
  progressTable.delete(pack.id);
  return { ok: !packInstalled(pack), packId: pack.id, installed: packInstalled(pack) };
}

/** 全部包的公开视图（不含本机绝对路径）。 */
export function listPacks() {
  return VOICE_PACKS.map((pack) => {
    const detail = packDetail(pack);
    const progress = packProgress(pack.id);
    const installed = packInstalled(pack);
    return {
      id: pack.id,
      name: pack.name,
      desc: pack.desc,
      lang: pack.lang,
      gender: pack.gender,
      quality: pack.quality,
      hd: pack.hd === true,
      recommended: pack.recommended === true,
      license: pack.license,
      source: pack.source,
      engine: pack.engine,
      voiceId: detail.voiceId || '',
      runtimeReady: pack.engine === 'sherpa' ? worker.sherpaRuntimeStatus().available === true : true,
      sizeMB: detail.model ? Math.round(detail.model.sizeBytes / (1024 * 1024) * 10) / 10 : 0,
      sizeBytes: detail.model ? detail.model.sizeBytes : 0,
      sha256: pack.engine === 'piper' && detail.model ? detail.model.sha256 : '',
      installed,
      status: installed ? 'ready' : (progress.phase === 'failed' ? 'error' : (progress.phase === 'idle' ? 'downloadable' : 'downloading')),
      reason: progress.phase === 'failed' ? progress.error : '',
      progress,
      previewable: installed,
    };
  });
}
