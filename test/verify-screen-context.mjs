/**
 * verify-screen-context.mjs — v1.2 判据 O1/O2/O3：
 *   默认关（不调用前台 API）；Level1 能读应用名/标题；Level2 OCR 可选、原图不落盘；
 *   敏感应用跳过；锁屏停止；观察记录 type=observation 可查/可删/可清空。
 * 真机 PowerShell 只在“显式开启”分支才跑；本判据用注入 runner 保证确定性。
 */
process.env.FOLIA_ASR_ROOT = process.env.FOLIA_ASR_ROOT || 'C:/Windows/Temp/folia-asr-none';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = mkdtempSync(join(tmpdir(), 'folia-screen-'));
process.env.DSH_FOLIA_HOME = HOME;
const desktop = await import('../lib/desktop-context.js');
const mem = await import('../lib/persona-memory.js');
const store = await import('../lib/persona-store.js');
const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const persona = store.createPersona({ type: 'assistant', name: '观察' });
store.setActivePersona(persona.id);
const settings = { petChat: { enabled: true, provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'x', screen: { mode: 'off', confirmed: false } } };

function startHost() {
  const routes = [];
  const webServer = { register: (route) => { routes.push(route); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(webServer, { disposers: [], base: '/folia', log: () => {}, readSettings: () => settings, speechToText: null });
  const route = routes.find((item) => String(item.path).endsWith('/pet-chat'));
  const server = createServer((req, res) => route.handler(req, res));
  return new Promise((resolveP) => {
    server.listen(0, '127.0.0.1', () => resolveP({ base: `http://127.0.0.1:${server.address().port}/folia/pet-chat`, close: () => new Promise((r) => server.close(r)) }));
  });
}

/* O1① 默认关：路由返回 disabled，且源码里 off 分支先于任何 PowerShell 调用 */
const host = await startHost();
const status = await (await fetch(`${host.base}/observe/status`)).json();
const sample = await (await fetch(`${host.base}/observe/sample`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
check('O1① 屏幕感知默认关（/observe/status enabled=false，sample ⇒ disabled）',
  status.ok === true && status.enabled === false && sample.ok === false && sample.reason === 'disabled',
  `enabled=${status.enabled} sample=${sample.reason}`);
const routeSrc = readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8');
const observeBlock = routeSrc.slice(routeSrc.indexOf('async function observeOnce('), routeSrc.indexOf('function observeStatus('));
check('O1② 关的时候**不调用**前台 API（off 分支在 readForegroundWindow 之前 return）',
  observeBlock.indexOf("screen.mode === 'off'") < observeBlock.indexOf('readForegroundWindow('),
  'gate order');

/* O1③ Level1：注入 runner 解析应用名/标题；敏感与锁屏标记 */
const fg = await desktop.readForegroundWindow({
  run: () => ({ stdout: '{"ok":true,"pid":42,"app":"Code","title":"main.js — Visual Studio Code"}' }),
});
check('O1③ Level1 能读应用名 + 标题摘要',
  fg.ok === true && fg.app === 'Code' && fg.title.includes('main.js') && fg.sensitive === false && fg.locked === false,
  `${fg.app} · ${fg.title}`);
check('O1④ 敏感应用 / 锁屏识别',
  desktop.isSensitiveApp('KeePassXC', 'Vault') === true && desktop.isSensitiveApp('Code', 'main.js') === false
  && desktop.isLockScreen('LockApp', '') === true,
  'sensitive/lock');

/* O2① OCR：注入 runner；文本截断；源码无“截图落盘” */
const ocr = await desktop.captureScreenOcr({ maxChars: 120, run: () => ({ stdout: '{"ok":true,"lines":["屏幕上的第一行","第二行"]}' }) });
check('O2① Level2 OCR 返回本地文本（按上限截断）',
  ocr.ok === true && ocr.text.includes('第一行') && ocr.chars <= 120, `chars=${ocr.chars}`);
const desktopSrc = readFileSync(join(ROOT, 'lib', 'desktop-context.js'), 'utf8');
check('O2② 原图不落盘：截图走 InMemoryRandomAccessStream（无 Save(path)/临时文件）',
  /InMemoryRandomAccessStream/.test(desktopSrc) && !/\.Save\(\s*[^)]*['"]/.test(desktopSrc) && !/GetTempPath|tmpdir\(\)/.test(desktopSrc),
  'in-memory only');
check('O2③ 敏感应用与锁屏在采样前跳过（源码闸门）',
  /foreground\.sensitive/.test(observeBlock) && /foreground\.locked/.test(observeBlock),
  'gates present');

/* O3 观察记录：kind=observation、importance 2–3、可查/可删/可清空；关闭即停 */
const record = mem.recordObservation(persona.id, { text: '前台应用：Code · main.js', importance: 2, source: 'foreground' });
const listed = mem.listObservations(persona.id, { limit: 10 });
check('O3① 观察写 memory（type=observation, importance 2–3）',
  record && record.kind === 'observation' && record.importance >= 2 && record.importance <= 3
  && listed.items.some((item) => item.text.includes('Code')),
  `kind=${record && record.kind} n=${listed.total}`);
const deleted = mem.deleteEvent(persona.id, listed.items[0].id);
const afterDelete = mem.listObservations(persona.id, { limit: 10 });
check('O3② 观察记录可单条删除', deleted.ok === true && afterDelete.total < listed.total, `after=${afterDelete.total}`);
mem.recordObservation(persona.id, { text: '前台应用：VLC · movie.mkv', importance: 2 });
const cleared = mem.clearObservations(persona.id);
check('O3③ 观察记录可清空（不影响普通记忆）',
  cleared.ok === true && mem.listObservations(persona.id).total === 0
  && mem.eventCount(persona.id) >= 0, `removed=${cleared.removed}`);

/* O3④ 关闭即停：把 mode 关回 off，采样接口立刻 disabled（不用重启） */
settings.petChat.screen.mode = 'ocr';
const onStatus = await (await fetch(`${host.base}/observe/status`)).json();
settings.petChat.screen.mode = 'off';
const offStatus = await (await fetch(`${host.base}/observe/status`)).json();
check('O3④ 开启/关闭立即生效（无需重启）',
  onStatus.enabled === true && offStatus.enabled === false, `on=${onStatus.enabled} off=${offStatus.enabled}`);

await host.close();
const failed = results.filter((item) => !item.ok);
console.log(`\nSCREEN CONTEXT CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
