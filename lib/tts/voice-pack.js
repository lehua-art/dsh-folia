/**
 * tts/voice-pack.js — 用户音色包导入（v1.2 需求九）+ 4 个内置系统音效。
 *
 * 授权边界（写进代码也写进界面提示）：
 *   · 本仓库**不携带任何角色语音/声优素材**（不复制 Shinsekai，也不内置社区包）；
 *   · 角色音色只能由用户「下载 / 本地导入」，导入时必须填 license + 作者/来源；
 *   · 内置的只有 **4 个系统音效**（本项目用代码合成的提示音，MIT，可再分发）。
 *
 * voice pack 格式（任务书 §10）：
 *   { id, name, engine, refAudio, refText, model?, license, author, sha256 }
 *   · engine：'gpt-sovits' | 'http' | 'piper-ref'（都是「用户自带服务/模型」）
 *   · refAudio 是**本地文件路径**（用户自己拥有权利）；导入时复制到
 *     `<DSH_FOLIA_HOME>/voices/packs/<id>/ref.wav`，原文件不动。
 *   · sha256 校验参考音频（不给就现算并回填）。
 *
 * 存储在用户目录，**不进 npm 包、不上传**；删除包 = 删这个目录。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 内置系统音效：4 个，代码合成、MIT，不涉及角色/声优版权。 */
export const SYSTEM_SOUNDS = Object.freeze([
  { id: 'system-ding', name: '提示', file: 'ding.wav', desc: '一条提醒/消息落地的轻提示音', license: 'MIT（本仓库合成）', author: 'dsh-folia', licenseUrl: '' },
  { id: 'system-ok', name: '完成', file: 'ok.wav', desc: '任务/安装完成的确认音', license: 'MIT（本仓库合成）', author: 'dsh-folia', licenseUrl: '' },
  { id: 'system-warn', name: '提醒', file: 'warn.wav', desc: '失败/需要注意的短提示', license: 'MIT（本仓库合成）', author: 'dsh-folia', licenseUrl: '' },
  { id: 'system-tap', name: '轻触', file: 'tap.wav', desc: '点桌宠/切换动作的触感音', license: 'MIT（本仓库合成）', author: 'dsh-folia', licenseUrl: '' },
]);

const SOUND_DIR = new URL('../../assets/system/sound/', import.meta.url);

export function systemSoundPath(id) {
  const sound = SYSTEM_SOUNDS.find((item) => item.id === String(id || ''));
  if (!sound) return '';
  try { return new URL(sound.file, SOUND_DIR).pathname.replace(/^\/([A-Za-z]:)/, '$1'); } catch { return ''; }
}

export function listSystemSounds() {
  return SYSTEM_SOUNDS.map((sound) => ({
    ...sound,
    bundled: true,
    path: '',
    exists: (() => { try { return existsSync(systemSoundPath(sound.id)); } catch { return false; } })(),
  }));
}

/** 用户音色包根目录。 */
export function voicePacksDir() {
  const home = process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
  return join(home, 'voices', 'packs');
}

export const VOICE_PACK_ENGINES = Object.freeze(['gpt-sovits', 'http', 'piper-ref']);
const ID_RE = /^vp_[a-z0-9]{4,40}$/;
const MAX_REF_BYTES = 8 * 1024 * 1024;

const clip = (value, max) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 读一个包的 meta（readdir 用）。 */
function readMeta(dir) {
  try {
    const doc = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'));
    if (!doc || typeof doc !== 'object') return null;
    if (!ID_RE.test(String(doc.id || ''))) return null;
    return {
      id: String(doc.id),
      name: clip(doc.name, 60),
      engine: VOICE_PACK_ENGINES.includes(doc.engine) ? doc.engine : 'gpt-sovits',
      refText: clip(doc.refText, 500),
      model: clip(doc.model, 200),
      license: clip(doc.license, 200),
      author: clip(doc.author, 120),
      source: clip(doc.source, 200),
      sha256: String(doc.sha256 || ''),
      serviceUrl: clip(doc.serviceUrl, 300),
      refAudio: String(doc.refAudio || ''),
      importedAt: Number(doc.importedAt) || 0,
      bytes: Number(doc.bytes) || 0,
    };
  } catch {
    return null;
  }
}

/** 已导入的用户音色包（不含本机绝对路径）。 */
export function listUserVoicePacks() {
  const root = voicePacksDir();
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const meta = readMeta(join(root, name.name));
    if (!meta) continue;
    out.push({
      ...meta,
      refAudio: meta.refAudio ? meta.refAudio.replace(/^.*[\\/]/, '') : '',
      installed: existsSync(join(root, name.name, 'ref.wav')),
      dir: '',
    });
  }
  return out.sort((a, b) => b.importedAt - a.importedAt);
}

/** 校验并导入一个 voice pack。 */
export function importVoicePack(input = {}, options = {}) {
  const root = options.dir || voicePacksDir();
  const name = clip(String(input.name || '').trim(), 60);
  const engine = String(input.engine || 'gpt-sovits');
  const license = clip(String(input.license || '').trim(), 200);
  const author = clip(String(input.author || input.source || '').trim(), 120);
  const refText = clip(String(input.refText || '').trim(), 500);
  const model = clip(String(input.model || '').trim(), 200);
  const serviceUrl = clip(String(input.serviceUrl || '').trim(), 300);

  // 授权是硬门槛：没有 license / 作者（或来源），一律拒绝 —— 不替用户承担版权风险。
  if (!name) return { ok: false, error: 'missing-name', hint: '音色包需要一个名字' };
  if (!VOICE_PACK_ENGINES.includes(engine)) {
    return { ok: false, error: 'bad-engine', hint: '只支持用户自带的 gpt-sovits / http / piper-ref' };
  }
  if (!license) return { ok: false, error: 'missing-license', hint: '必须填写素材许可证（例如「本人录制，仅自用」）' };
  if (!author) return { ok: false, error: 'missing-author', hint: '必须填写作者/来源，便于追溯授权' };
  if (serviceUrl && !/^https?:\/\//i.test(serviceUrl)) {
    return { ok: false, error: 'bad-service-url', hint: 'GPT-SoVITS 服务地址必须是 http(s)://' };
  }

  let audio = null;
  if (typeof input.audioBase64 === 'string' && input.audioBase64) {
    try { audio = Buffer.from(input.audioBase64.replace(/^data:[^;]+;base64,/, ''), 'base64'); } catch { audio = null; }
  } else if (typeof input.refAudioPath === 'string' && input.refAudioPath) {
    try {
      const stat = statSync(input.refAudioPath);
      if (stat.size > MAX_REF_BYTES) return { ok: false, error: 'ref-too-large', hint: '参考音频最大 8MB' };
      audio = readFileSync(input.refAudioPath);
    } catch { audio = null; }
  }
  if (!audio || !audio.length) {
    return { ok: false, error: 'missing-ref-audio', hint: '需要一个参考音频（wav/mp3，用户自己拥有权利）' };
  }
  if (audio.length > MAX_REF_BYTES) return { ok: false, error: 'ref-too-large', hint: '参考音频最大 8MB' };
  const digest = sha256(audio);
  if (input.sha256 && String(input.sha256).toLowerCase() !== digest) {
    return { ok: false, error: 'sha256-mismatch', hint: '参考音频的 sha256 与声明不一致' };
  }

  const id = 'vp_' + digest.slice(0, 12);
  const dir = join(root, id);
  if (existsSync(join(dir, 'pack.json'))) {
    return { ok: false, error: 'already-imported', hint: '这个音色包已经导入过', id };
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ref.wav'), audio);
  const meta = {
    id, name, engine, refAudio: 'ref.wav', refText, model, license, author,
    source: clip(String(input.source || author), 200), sha256: digest,
    serviceUrl, importedAt: Date.now(), bytes: audio.length,
    // 明确记录“这是用户导入的素材，不是本仓库随包分发”
    origin: 'user-import',
  };
  writeFileSync(join(dir, 'pack.json'), JSON.stringify(meta, null, 2));
  return { ok: true, pack: { ...meta, installed: true } };
}

export function removeUserVoicePack(id) {
  const clean = String(id || '');
  if (!ID_RE.test(clean)) return { ok: false, error: 'bad-id' };
  const dir = join(voicePacksDir(), clean);
  if (!existsSync(dir)) return { ok: false, error: 'not-found' };
  try { rmSync(dir, { recursive: true, force: true }); } catch { return { ok: false, error: 'remove-failed' }; }
  return { ok: true, id: clean };
}

/** 汇总：内置 4 个音效 + 用户导入包（供设置页展示授权/来源）。 */
export function voicePackSummary() {
  const user = listUserVoicePacks();
  return {
    ok: true,
    builtinSounds: listSystemSounds(),
    builtinCount: SYSTEM_SOUNDS.length,
    userPacks: user,
    userCount: user.length,
    // 明确口径：角色语音不走内置
    policy: {
      builtinSoundsOnly: true,
      characterVoices: 'user-download-or-import',
      note: '本仓库只内置 4 个系统音效；角色音色须由用户下载/导入，并自带 license 与来源。',
    },
  };
}
