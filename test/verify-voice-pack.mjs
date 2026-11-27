/**
 * verify-voice-pack.mjs — v1.2 判据 V2：
 *   内置只有 4 个系统音效（本仓库合成、MIT）；角色音色只能走用户下载/导入；
 *   导入必须带 license + 作者/来源；参考音频只落用户目录，不进 npm 包、不上传。
 */
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT || 'C:/Windows/Temp/folia-asr-none';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'folia-voicepack-'));
process.env.DSH_FOLIA_HOME = HOME;
const vp = await import('../lib/tts/voice-pack.js');
const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ① 内置只有 4 个系统音效 */
const sounds = vp.listSystemSounds();
const assetDir = join(ROOT, 'assets', 'system', 'sound');
const files = existsSync(assetDir) ? readdirSync(assetDir).filter((name) => name.endsWith('.wav')) : [];
check('V2① 内置音效 = 4 个（文件与清单一一对应）',
  vp.SYSTEM_SOUNDS.length === 4 && sounds.length === 4 && files.length === 4
  && new Set(vp.SYSTEM_SOUNDS.map((item) => item.id)).size === 4,
  `manifest=${vp.SYSTEM_SOUNDS.length} files=${files.length}`);
check('V2② 4 个音效都随包发布（package.json files + 文件存在）',
  vp.SYSTEM_SOUNDS.every((item) => existsSync(join(assetDir, item.file)))
  && JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).files.includes('assets/system/sound/'),
  'assets packaged');

/* ② 角色语音不进包：assets 下只有这 4 个音频 */
const assetsAudio = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(wav|mp3|ogg|flac)$/i.test(entry.name)) assetsAudio.push(full);
  }
};
walk(join(ROOT, 'assets'));
check('V2③ assets 里没有角色语音/声优素材（只有 4 个系统音效）',
  assetsAudio.length === 4, `audio=${assetsAudio.length}`);

/* ③ 导入硬门槛：license / author / 参考音频 */
const base64 = Buffer.from('RIFF....WAVEfmt ').toString('base64');
const noLicense = vp.importVoicePack({ name: 'x', author: 'me', audioBase64: base64 });
const noAuthor = vp.importVoicePack({ name: 'x', license: 'self', audioBase64: base64 });
const noAudio = vp.importVoicePack({ name: 'x', license: 'self', author: 'me' });
check('V2④ 导入必须带 license + 作者/来源 + 参考音频',
  noLicense.error === 'missing-license' && noAuthor.error === 'missing-author' && noAudio.error === 'missing-ref-audio',
  `${noLicense.error}/${noAuthor.error}/${noAudio.error}`);
const badEngine = vp.importVoicePack({ name: 'x', license: 'self', author: 'me', engine: 'shinsekai', audioBase64: base64 });
check('V2⑤ 只接受用户自带的引擎（不接第三方角色包格式）',
  badEngine.error === 'bad-engine', badEngine.error);

/* ④ 正常导入：落用户目录、带 sha256、可列出、可删除 */
const wav = readFileSync(join(assetDir, 'ding.wav'));
const imported = vp.importVoicePack({
  name: '我的参考音', engine: 'gpt-sovits', license: '本人录制，仅自用', author: '本地用户',
  refText: '这是一段参考音频', audioBase64: wav.toString('base64'),
});
check('V2⑥ 导入成功：存本机用户目录（不在仓库/npm 包内）',
  imported.ok === true && imported.pack.origin === 'user-import' && imported.pack.sha256.length === 64
  && existsSync(join(vp.voicePacksDir(), imported.pack.id, 'ref.wav'))
  && !vp.voicePacksDir().startsWith(ROOT),
  imported.pack.id);
const listed = vp.listUserVoicePacks();
check('V2⑦ 已导入包可列出（含 license/作者，供界面提示）',
  listed.length === 1 && listed[0].license.includes('本人录制') && listed[0].author === '本地用户',
  `${listed.length} pack`);
const mismatch = vp.importVoicePack({
  name: '坏哈希', license: 'x', author: 'y', sha256: 'f'.repeat(64), audioBase64: wav.toString('base64'),
});
check('V2⑧ sha256 不匹配 ⇒ 拒绝（防止参考音频被换）', mismatch.error === 'sha256-mismatch', mismatch.error);

/* ⑤ 路由：/system-sounds 4 条 + 音频直出；导入缺 license 返回 400 */
const settings = { petChat: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'x' } };
const routes = [];
const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
registerPetChatRoutes(webServer, { disposers: [], base: '/folia', log: () => {}, readSettings: () => settings, speechToText: null });
const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
const server = createServer((req, res) => route.handler(req, res));
await new Promise((resolveP) => server.listen(0, '127.0.0.1', resolveP));
const base = `http://127.0.0.1:${server.address().port}/folia/pet-chat`;
const soundDoc = await (await fetch(`${base}/system-sounds`)).json();
const audioRes = await fetch(`${base}/system-sounds/system-ding.wav`);
const audioBuf = Buffer.from(await audioRes.arrayBuffer());
check('V2⑨ 路由：内置 4 条 + 音频可播放（RIFF，白名单）',
  soundDoc.ok === true && soundDoc.count === 4 && audioRes.status === 200
  && audioBuf.toString('ascii', 0, 4) === 'RIFF', `bytes=${audioBuf.length}`);
const badImport = await fetch(`${base}/voice/user-packs/import`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'x', audioBase64: base64 }),
});
const badDoc = await badImport.json();
check('V2⑩ 路由：缺 license 的导入被拒（400 + 授权口径提示）',
  badImport.status === 400 && badDoc.ok === false && /角色语音必须由你拥有权利/.test(badDoc.policy || ''),
  `${badImport.status} ${badDoc.code}`);
const goodDoc = await (await fetch(`${base}/voice/user-packs`)).json();
check('V2⑪ 路由：用户包列表里含刚导入的包',
  goodDoc.ok === true && goodDoc.userCount === 1 && goodDoc.builtinCount === 4
  && goodDoc.policy.characterVoices === 'user-download-or-import',
  `user=${goodDoc.userCount} builtin=${goodDoc.builtinCount}`);
const removed = vp.removeUserVoicePack(imported.pack.id);
check('V2⑫ 删除用户包只删用户目录', removed.ok === true && vp.listUserVoicePacks().length === 0, removed.id);

const panelSrc = readFileSync(join(ROOT, 'src/panel-tabs-personas.js'), 'utf8');
check('V2⑬ 声音页把不可用音色从主列表隐藏（429/不可用 continue）',
  panelSrc.includes("item.status === 'rate-limited' || item.status === 'unavailable') continue")
  && panelSrc.includes('不可用项已隐藏'));
server.close();
const failed = results.filter((item) => !item.ok);
console.log(`\nVOICE PACK CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
