/**
 * verify-curated.mjs — 能力页「精选」A–K 判据。
 *
 * 只读静态数据 + 源码检查 + 一个本地 HTTP 路由探针；不联网、不装任何插件。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURATED_BUNDLES, CURATED_FAMILIES, curatedCommands, curatedRecommend, curatedExport,
} from '../lib/capabilities-curated.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-work.js'), 'utf8');
const dataSrc = readFileSync(join(ROOT, 'lib', 'capabilities-curated.js'), 'utf8');
const i18nSrc = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* A. 精选 tab 默认打开；工作能力/娱乐仍可用 */
check('A 精选默认打开，三个 tab 都在',
  /page:\s*["']curated["']/.test(workSrc)
    && workSrc.includes('id: "curated"') && workSrc.includes('id: "work"') && workSrc.includes('id: "fun"')
    && workSrc.includes('weT("精选")'),
  'curated default + 3 tabs');

/* B. 20 套全部、字段齐全 */
{
  const ids = CURATED_BUNDLES.map((b) => b.id);
  const families = new Set(CURATED_BUNDLES.map((b) => b.family));
  const missing = CURATED_BUNDLES.filter((b) => !b.icon || !b.name || !b.goal || !b.requires
    || !b.risk || !Array.isArray(b.budget) || !Array.isArray(b.steps) || !b.steps.length
    || b.steps.some((s) => !s.pkg || !s.why));
  check('B 20 套组合、id 唯一、6 家族、卡片字段齐全',
    CURATED_BUNDLES.length === 20 && new Set(ids).size === 20
      && families.size === 6 && missing.length === 0,
    `bundles=${CURATED_BUNDLES.length} families=${families.size} missing=${missing.length}`);
}

/* C. 6 家族筛选 + 只看收藏 */
check('C 6 家族筛选 + 只看收藏 + 搜索组合',
  CURATED_FAMILIES.length === 7
    && workSrc.includes('CURATED_FAMILY_LABELS')
    && workSrc.includes('只看收藏') && workSrc.includes('搜索组合')
    && /selected.*family|family === id|family !== 'all'/.test(workSrc),
  'families=all+6');

/* D. 场景向导：规则映射 + 只高亮不折叠 */
{
  check('D 场景向导映射（工作/开发/创作/生活/安全）',
    eq(curatedRecommend('work', ''), ['starter', 'office'])
      && eq(curatedRecommend('work', 'excel'), ['data', 'ops-report'])
      && eq(curatedRecommend('dev', ''), ['coding', 'starter'])
      && eq(curatedRecommend('dev', 'blender'), ['gamedev', 'coding'])
      && eq(curatedRecommend('creative', 'ps'), ['design', 'content'])
      && eq(curatedRecommend('creative', 'pr'), ['video', 'content'])
      && eq(curatedRecommend('life', ''), ['companion', 'learn'])
      && eq(curatedRecommend('secure', ''), ['security', 'starter'])
      && eq(curatedRecommend('', ''), ['starter']),
    'mapping');
  check('D 向导只高亮推荐，列表不折叠其它组合',
    workSrc.includes('recommended: recommended.includes(bundle.id)')
      && workSrc.includes('只高亮推荐，不折叠其它组合')
      && !/filter\([^)]*recommended/.test(workSrc),
    'recommended highlight');
}

/* E. 复制全部命令顺序 / 单条复制 */
{
  const starter = CURATED_BUNDLES.find((b) => b.id === 'starter');
  const gamedev = CURATED_BUNDLES.find((b) => b.id === 'gamedev');
  const wantStarter = [
    'dsh plugin --profile web add dsh-unlag',
    'dsh plugin --profile web add dsh-cost-meter',
    'dsh plugin --profile web add dsh-trust-check',
    'dsh plugin --profile web add dsh-config-manager',
  ];
  check('E 复制全部命令按步骤顺序、每行可执行',
    eq(curatedCommands(starter), wantStarter)
      && curatedCommands(gamedev)[1] === 'dsh plugin --profile web add dsh-unity-mcp-bridge'
      && workSrc.includes('复制全部命令') && workSrc.includes('CURATED_PREFIX'),
    JSON.stringify(curatedCommands(starter)));
  check('E 单条复制（展开步骤里每项右侧按钮）',
    workSrc.includes('CuratedStep') && workSrc.includes('复制') && workSrc.includes('copyPlainText(command)'),
    'step copy');
}

/* F. 导出 PowerShell / bash / JSON */
{
  const bundle = CURATED_BUNDLES.find((b) => b.id === 'office');
  const ps = curatedExport(bundle, 'powershell');
  const sh = curatedExport(bundle, 'bash');
  const json = curatedExport(bundle, 'json');
  let parsed = null;
  try { parsed = JSON.parse(json); } catch { parsed = null; }
  check('F 导出 PowerShell/bash/JSON 可用（JSON 可解析、命令完整）',
    /^\$ErrorActionPreference = 'Stop'\n/.test(ps)
      && ps.includes('dsh plugin --profile web add @deepseek-ai/dsh-skill-office')
      && /^#!\/usr\/bin\/env bash\n/.test(sh)
      && parsed && parsed.id === 'office' && Array.isArray(parsed.commands)
      && parsed.commands.length === bundle.steps.length,
    `ps=${ps.split('\n').length - 1}line sh=${sh.split('\n').length - 1}line json=${json.length}B`);
}

/* G. 已装检测（本地路由；读 profile node_modules，不联网） */
{
  const { registerPetChatRoutes } = await import('../lib/routes/pet-chat.js');
  const disposers = [];
  const routes = [];
  const host = { register: (route) => { routes.push(route); disposers.push(() => {}); return () => {}; }, status: () => ({}) };
  registerPetChatRoutes(host, {
    disposers, base: '/folia', log: () => {},
    readSettings: () => ({ petChat: { voice: { name: '', muted: false } } }),
    speechToText: undefined,
    tts: {
      async synthesize() { return { ok: false, code: 'unavailable' }; },
      stop() { return { ok: true }; }, status() { return { ok: true, engines: [] }; },
      voices() { return []; }, dispose() {},
    },
  });
  const route = routes.find((r) => String(r.path).endsWith('/pet-chat'));
  const server = createServer((req, res) => route.handler(req, res));
  await new Promise((resolveP) => server.listen(0, '127.0.0.1', resolveP));
  try {
    const resp = await fetch(`http://127.0.0.1:${server.address().port}/folia/pet-chat/capabilities/curated`);
    const doc = await resp.json();
    const keys = Object.keys(doc.installed || {});
    check('G /capabilities/curated 回 20 套 + installed（版本或 null）',
      resp.status === 200 && doc.ok === true && doc.bundles.length === 20
        && keys.length >= 20 && keys.every((k) => doc.installed[k] === null || typeof doc.installed[k] === 'string'),
      `bundles=${doc.bundles && doc.bundles.length} installedKeys=${keys.length}`);
  } finally {
    server.close();
    for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  }
}

/* H. 风险 / 预算 / 冲突标签 */
{
  const byId = Object.fromEntries(CURATED_BUNDLES.map((b) => [b.id, b]));
  check('H 标签：gamedev 中风险+正版软件+Unity/UE 冲突；video high+PR MCP；companion 冲突',
    byId.gamedev.risk === 'medium' && byId.gamedev.budget.includes('software')
      && byId.gamedev.conflicts.some((x) => /Unity|Unreal/.test(x))
      && byId.video.risk === 'high' && byId.video.budget.includes('software')
      && byId.companion.conflicts.some((x) => /dsh-pet/.test(x))
      && workSrc.includes('第三方 MCP，先 trust-check'),
    'tags');
}

/* I. 收藏持久化 */
check('I 收藏写 localStorage（we-curated-favorites），刷新可读',
  workSrc.includes('CURATED_FAV_KEY') && workSrc.includes("'we-curated-favorites'")
    && workSrc.includes('localStorage.setItem') && workSrc.includes('readCuratedFavorites()')
    && workSrc.includes('new Set(readCuratedFavorites())'),
  'localStorage');

/* J. i18n 齐全 */
{
  const keys = [...workSrc.matchAll(/weT\((['"])(.*?)\1/g)].map((m) => m[2]);
  const missing = [...new Set(keys)].filter((k) => !i18nSrc.includes(JSON.stringify(k) + ':'));
  check('J i18n：精选页所有 weT 词条都在词表里',
    missing.length === 0, missing.length ? missing.join('、') : `keys=${new Set(keys).size}`);
}

/* K. 没有安装按钮 / 不扫描路径 */
check('K 无“开始安装”按钮；精选数据不扫路径/注册表',
  !workSrc.includes('开始安装') && !dataSrc.includes('开始安装')
    && !/(node:fs|HKEY|readdirSync|C:\\\\|reg\s+query|scanRegistry|readRegistry)/i.test(dataSrc),
  'copy-only');

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
