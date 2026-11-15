/**
 * tts/catalog.js — 可下载的离线 TTS 音色目录（站点镜像优先）。
 *
 * 纪律：
 *   · Edge neural（`zh-CN-XxxNeural`）是云端音色，没有本地模型、也不允许再分发
 *     ⇒ 不进目录、不进包、不进下拉；
 *   · 这里只列开源、可离线、许可允许再分发的方案；
 *   · 下载地址**以站点镜像为默认**（运维可换 R2/自有域名），上游地址只作第二备用；
 *   · 每个文件带 sha256；下载器必须先校验再解压/使用。
 *
 * 镜像覆盖（任选）：
 *   环境变量 FOLIA_MODEL_MIRROR / FOLIA_PIPER_ASSET_URL / FOLIA_PIPER_MODEL_URL
 *   或运行时把 catalog 里的 url 换成自己的镜像。
 */
export const TTS_MODEL_MIRROR = String(
  process.env.FOLIA_MODEL_MIRROR || 'https://folia-5ve.pages.dev/media/',
).replace(/\/?$/, '/');

const SITE_PIPER = TTS_MODEL_MIRROR + 'piper/v1/';
const UPSTREAM_PIPER = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/';
const UPSTREAM_MODEL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/';

export const TTS_CATALOG = Object.freeze([
  {
    id: 'piper-zh',
    name: 'Piper 中文音色（华言）',
    engine: 'piper',
    license: 'MIT',
    size: '约 85 MB（运行时 + 模型）',
    homepage: 'https://github.com/rhasspy/piper',
    available: false,
    status: 'coming-soon',
    note: '离线开源；下载与解压走站点镜像，失败自动切上游备用源。',
    voiceId: 'piper:zh_CN-huayan-medium',
    runtime: {
      sha256: 'F3C58906402B24F3A96D92145F58ACBA6D86C9B5DB896D207F78DC80811EFCEA',
      downloadUrls: [
        SITE_PIPER + 'piper_windows_amd64.zip',
        UPSTREAM_PIPER + 'piper_windows_amd64.zip',
      ],
    },
    model: {
      sha256: '9929917BF8CABB26FD528EA44D3A6699C11E87317A14765312420BE230BE0F3D',
      downloadUrls: [
        SITE_PIPER + 'zh_CN-huayan-medium.onnx',
        UPSTREAM_MODEL + 'zh_CN-huayan-medium.onnx',
      ],
    },
    config: {
      sha256: 'D521DC45504A8CCC99E325822B35946DD701840BFB07E3DBB31A40929ED6A82B',
      downloadUrls: [
        SITE_PIPER + 'zh_CN-huayan-medium.onnx.json',
        UPSTREAM_MODEL + 'zh_CN-huayan-medium.onnx.json',
      ],
    },
  },
  {
    id: 'sherpa-onnx-zh',
    name: 'sherpa-onnx 中文 TTS',
    engine: 'sherpa',
    license: 'Apache-2.0',
    size: '约 140–200 MB / 模型',
    homepage: 'https://github.com/k2-fsa/sherpa-onnx',
    available: false,
    status: 'coming-soon',
    note: '离线开源；本版只接目录，合成尚未接通。',
  },
  {
    id: 'melo-zh',
    name: 'MeloTTS 中文',
    engine: 'melo',
    license: 'MIT',
    size: '约 300–500 MB',
    homepage: 'https://github.com/myshell-ai/MeloTTS',
    available: false,
    status: 'coming-soon',
    note: '体积较大，计划首次使用时下载；本版只接目录。',
  },
]);

/** 运行时可直接用 catalog 的 URL；环境变量可覆盖第一个地址。 */
export function piperAssetUrls(item, env = process.env) {
  const entry = item || TTS_CATALOG.find((x) => x.id === 'piper-zh');
  if (!entry || !entry.runtime) return [];
  const first = String(env.FOLIA_PIPER_ASSET_URL || '').trim();
  return [...(first ? [first] : []), ...(entry.runtime.downloadUrls || [])].filter(Boolean);
}

export function piperModelUrls(item, env = process.env) {
  const entry = item || TTS_CATALOG.find((x) => x.id === 'piper-zh');
  if (!entry || !entry.model) return [];
  const first = String(env.FOLIA_PIPER_MODEL_URL || '').trim();
  return [...(first ? [first] : []), ...(entry.model.downloadUrls || [])].filter(Boolean);
}
