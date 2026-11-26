/**
 * verify-curated-personal.mjs — 「精选 → 个人工具」扩展 A–H。
 *
 * 静态数据 + UI 源码 + 本地路由探针；不联网、不装任何工具。
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAL_TOOLS, PERSONAL_CATEGORIES } from '../lib/curated-personal.js';
import { CURATED_BUNDLES } from '../lib/capabilities-curated.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workSrc = readFileSync(join(ROOT, 'src', 'panel-tabs-work.js'), 'utf8');
const personalSrc = readFileSync(join(ROOT, 'lib', 'curated-personal.js'), 'utf8');
const i18nSrc = readFileSync(join(ROOT, 'src', 'i18n-copy-panel.js'), 'utf8');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const EXPECTED = {
  ai: 13, 'speech-doc': 7, media: 8, docs: 5, notes: 9, home: 6,
  ops: 8, backup: 4, privacy: 4, finance: 3, creative: 5, dev: 3,
};
const counts = {};
for (const t of PERSONAL_TOOLS) counts[t.category] = (counts[t.category] || 0) + 1;

/* A. 精选顶部有 [场景组合][个人工具]，默认场景组合 */
check('A 精选顶部 [场景组合][个人工具]，默认场景组合',
  workSrc.includes("curatedTab: \"bundles\"")
    && workSrc.includes('weT("场景组合")') && workSrc.includes('weT("个人工具")')
    && /state\.curatedTab === "personal"/.test(workSrc)
    && workSrc.includes('个人工具')
    && workSrc.includes('CuratedPanel') && workSrc.includes('PersonalPanel'),
  'segments + default bundles');

/* B. ≥60 项、12 类、字段齐全 */
{
  const missing = PERSONAL_TOOLS.filter((t) => t.kind !== 'oss-tool' || !t.id || !t.name || !t.category
    || !t.desc || !t.detail || !t.repo || !t.license || !t.requires
    || !['low', 'medium', 'high'].includes(t.risk));
  const ids = PERSONAL_TOOLS.map((t) => t.id);
  check('B 个人工具 ≥60、12 类、每项字段齐全、id 唯一',
    PERSONAL_TOOLS.length >= 60 && PERSONAL_CATEGORIES.length === 13
      && Object.keys(EXPECTED).every((k) => counts[k] === EXPECTED[k])
      && new Set(ids).size === ids.length && missing.length === 0,
    `tools=${PERSONAL_TOOLS.length} categories=${PERSONAL_CATEGORIES.length - 1} missing=${missing.length}`);
}

/* C. 详情字段：一句话 + detail（≥2 句）+ 仓库 + license + 前置 */
{
  const bad = PERSONAL_TOOLS.filter((t) => {
    const sentences = String(t.detail || '').split(/[。！？!?]/).filter((s) => s.trim()).length;
    return sentences < 2 || !/^https:\/\/github\.com\//.test(t.repo)
      || !t.license || !t.requires;
  });
  check('C 每项 detail ≥2 句、repo/license/requires 齐全',
    bad.length === 0, bad.length ? bad.slice(0, 3).map((t) => t.id).join(',') : '75/75');
  check('C UI 详情展开含一句话 + detail + 仓库 + license + 前置',
    workSrc.includes('PersonalToolCard') && workSrc.includes('tool.detail')
      && workSrc.includes('weT(\'许可：\')') && workSrc.includes('weT(\'前置：\')')
      && workSrc.includes('tool.repos'),
    'detail panel');
}

/* D. 复制命令/复制地址 + 粘贴提示 */
check('D 插件复制安装命令；工具复制仓库地址 + 打开 GitHub；复制后提示助手安装',
  workSrc.includes('复制安装命令') && workSrc.includes('复制仓库地址')
    && workSrc.includes('打开 GitHub')
    && workSrc.includes('已复制。粘贴到 DSH 对话，让助手帮你安装（会先确认）。'),
  'copy copy');

/* E. 20 套组合每个 step 都有 detail + 仓库 */
{
  const steps = CURATED_BUNDLES.flatMap((b) => b.steps || []);
  const bad = steps.filter((s) => !s.detail || !/^https:\/\/(github\.com|www\.npmjs\.com)\//.test(String(s.repo || '')));
  check('E 20 套组合每步 detail + 仓库/包页面齐全',
    bad.length === 0 && steps.length >= 41,
    `steps=${steps.length} missing=${bad.length}`);
}

/* F. 顶部安装话术 */
{
  const intro = '这些是可选的插件与个人工具。安装方式：复制包名命令或 GitHub 地址 → 粘贴到 DSH 对话 → 让助手帮你下载安装（会先确认）。已装插件可由助手交给 DSH 执行；未装的只能看说明。非 DSH 插件的个人工具（Docker/Windows 应用）需要按 README 安装，助手只给步骤。';
  check('F 顶部安装话术已替换（无“一键安装”承诺）',
    workSrc.includes(intro),
    'intro');
}

/* G. 非 DSH 插件标记 + 不做盲装 */
check('G 个人工具明确“非 DSH 插件 / 需按 README 安装”，无开始安装/一键盲装',
  workSrc.includes('非 DSH 插件') && workSrc.includes('需按 README 安装；助手只给步骤，不盲装。')
    && !workSrc.includes('开始安装')
    && !personalSrc.includes('开始安装')
    && !/一键盲装|blindInstall|installNow/i.test(personalSrc),
  'README-only');

/* H. i18n 全；路由返回 personalTools/agentsAvailable/installed */
{
  const keys = [...workSrc.matchAll(/weT\((['"])(.*?)\1/g)].map((m) => m[2]);
  const missing = [...new Set(keys)].filter((k) => !i18nSrc.includes(JSON.stringify(k) + ':'));
  check('H i18n 全（精选/个人工具词条）', missing.length === 0,
    missing.length ? missing.join('、') : `keys=${new Set(keys).size}`);

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
    check('H 路由回 bundles + personalTools(75) + installed + agentsAvailable',
      resp.status === 200 && doc.ok === true && doc.bundles.length === 20
        && doc.personalTools.length === PERSONAL_TOOLS.length
        && doc.installed && typeof doc.installed === 'object'
        && typeof doc.agentsAvailable === 'boolean',
      `bundles=${doc.bundles && doc.bundles.length} personal=${doc.personalTools && doc.personalTools.length} agents=${doc.agentsAvailable}`);
  } finally {
    server.close();
    for (const dispose of disposers) { try { dispose(); } catch { /* ignore */ } }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
