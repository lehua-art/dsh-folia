/**
 * verify-settings-ownership.mjs — 设置键归属守卫。
 *
 * 判据（每条正反都咬）：
 *   ① DEFAULTS 与 KINDS 里的**每个键恰好一个归属**（没归属 / 两个归属都判红）；
 *   ② 每条 pattern（精确键或前缀）**真的匹配到键**（写错的模式会被判红，不许空转）；
 *   ③ 五个功能桶都非空（不许把全表塞进一个兜底桶）；
 *   ④ 允许清单 UNOWNED_WHY 是棘轮：只许缩小 —— 登记了但已经被模式覆盖的，要删掉；
 *   ⑤ 负对照：合成一个没归属的键、一个重复归属的键、一个空转的模式，判据都要变红。
 *
 * 为什么值得守：这张表是"拆 settings-schema.js"的前提 —— 没有归属对账，拆出来的文件
 * 谁也不敢保证没漏键。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { SETTINGS_OWNERS, UNOWNED_WHY } = await import('../lib/settings/ownership.js');

const schemaSrc = readFileSync(join(ROOT, 'lib', 'settings-schema.js'), 'utf8');

/** 从 `const NAME = { … }` 里取顶层键（括号配对 + 只在深度 0 记键）。 */
function topKeysOf(name) {
  const at = schemaSrc.indexOf('const ' + name + ' = {');
  if (at < 0) return [];
  const start = schemaSrc.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = start; i < schemaSrc.length; i += 1) {
    const ch = schemaSrc[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return [];
  const body = schemaSrc.slice(start + 1, end);
  const keys = [];
  let d = 0;
  for (const line of body.split('\n')) {
    const m = /^ {2}([A-Za-z_$][\w$]*)\s*:/.exec(line);
    if (m && d === 0) keys.push(m[1]);
    d += (line.match(/[{[(]/g) || []).length - (line.match(/[}\])]/g) || []).length;
  }
  return keys;
}

const keys = { DEFAULTS: topKeysOf('DEFAULTS'), KINDS: topKeysOf('KINDS') };
const allKeys = [...new Set([...keys.DEFAULTS, ...keys.KINDS])].sort();

const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

/* ── 归属计算（正判据与负对照共用同一份实现）────────────────────────────── */
function matches(pattern, key) {
  return key === pattern || key.startsWith(pattern);
}
function ownersOf(list, key) {
  const out = [];
  for (const feat of list) {
    const hit = (feat.keys || []).some((k) => k === key) || (feat.prefixes || []).some((p) => matches(p, key));
    if (hit) out.push(feat.id);
  }
  return out;
}
function unowned(list, keySet, allowed = UNOWNED_WHY) {
  return keySet.filter((k) => ownersOf(list, k).length === 0 && !(k in allowed));
}
function duplicated(list, keySet) {
  return keySet.filter((k) => ownersOf(list, k).length > 1);
}
function stalePatterns(list, keySet) {
  const stale = [];
  for (const feat of list) {
    for (const p of [...(feat.keys || []), ...(feat.prefixes || [])]) {
      if (!keySet.some((k) => matches(p, k))) stale.push(feat.id + ':' + p);
    }
  }
  return stale;
}

/* ── ① 覆盖与唯一 ───────────────────────────────────────────────────────── */
{
  const missing = unowned(SETTINGS_OWNERS, allKeys);
  check('每个设置键都有归属', missing.length === 0, '未归属: ' + missing.slice(0, 8).join(','));
  const dup = duplicated(SETTINGS_OWNERS, allKeys);
  check('没有键被两个功能同时认领', dup.length === 0, '重复: ' + dup.slice(0, 8).join(','));
  check('键面足够大（判据不在空集上恒真）', allKeys.length >= 120, 'keys=' + allKeys.length);
}

/* ── ② 模式不许空转 ─────────────────────────────────────────────────────── */
{
  const stale = stalePatterns(SETTINGS_OWNERS, allKeys);
  check('每条键/前缀模式都真的匹配到键（没有空转模式）', stale.length === 0, stale.slice(0, 8).join(','));
}

/* ── ③ 五个桶都非空 ─────────────────────────────────────────────────────── */
{
  const empty = SETTINGS_OWNERS.filter((f) => ![...(f.keys || []), ...(f.prefixes || [])].length);
  check('每个功能桶都声明了键或前缀', empty.length === 0, empty.map((f) => f.id).join(','));
  const counts = SETTINGS_OWNERS.map((f) => allKeys.filter((k) => ownersOf([f], k).length > 0).length);
  check('没有哪个桶吃掉全部键（防止归属退化成"一个大兜底"）',
    Math.max(...counts) < allKeys.length, JSON.stringify(SETTINGS_OWNERS.map((f, i) => f.id + ':' + counts[i])));
  check('至少有三个桶各自持有 ≥3 个键',
    counts.filter((c) => c >= 3).length >= 3, JSON.stringify(counts));
}

/* ── ④ 允许清单是棘轮 ───────────────────────────────────────────────────── */
{
  const nowCovered = Object.keys(UNOWNED_WHY).filter((k) => ownersOf(SETTINGS_OWNERS, k).length > 0);
  check('允许清单不空转（登记了却已被模式覆盖的，该删）', nowCovered.length === 0, nowCovered.join(','));
  const shortReasons = Object.entries(UNOWNED_WHY).filter(([, why]) => !why || why.trim().length < 10);
  check('允许清单每条都有理由（≥10 字）', shortReasons.length === 0, shortReasons.map(([k]) => k).join(','));
}

/* ── ⑤ 负对照 ───────────────────────────────────────────────────────────── */
{
  const probe = ['rotationInterval', 'glassAlpha', 'fxEnabled'];
  // 负对照①：一个没人认领的新键必须被判出
  check('negative control: 合成一个没归属的键会被判出',
    unowned(SETTINGS_OWNERS, ['__brand_new_key__']).includes('__brand_new_key__'));
  // 负对照②：把它登记到某个桶里之后，同一条判据必须放行（判据不是恒真）
  const fake = JSON.parse(JSON.stringify(SETTINGS_OWNERS));
  fake.push({ id: 'ghost', name: '鬼', why: '负对照用', keys: ['__brand_new_key__'] });
  check('negative control 的反方向: 登记之后不再判出',
    !unowned(fake, ['__brand_new_key__']).includes('__brand_new_key__'));
  check('正对照: 已归属的键本来就不在未归属集合里',
    unowned(SETTINGS_OWNERS, probe).length === 0, unowned(SETTINGS_OWNERS, probe).join(','));
  const dupList = [...SETTINGS_OWNERS, { id: 'ghost2', name: '鬼2', why: '负对照用', keys: ['rotationInterval'] }];
  check('negative control: 同一个键被两个功能认领 ⇒ 判红', duplicated(dupList, probe).includes('rotationInterval'));
  const staleList = [...SETTINGS_OWNERS, { id: 'ghost3', name: '鬼3', why: '负对照用', prefixes: ['zzzNoSuchPrefix'] }];
  check('negative control: 空转的模式 ⇒ 判红', stalePatterns(staleList, allKeys).some((s) => s.includes('zzzNoSuchPrefix')));
}

/* ── 汇总 ───────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
const perFeature = SETTINGS_OWNERS
  .map((f) => f.id + '=' + allKeys.filter((k) => ownersOf([f], k).length > 0).length)
  .join(' ');
process.stdout.write('\n  设置键 ' + allKeys.length + ' 个（DEFAULTS ' + keys.DEFAULTS.length + ' / KINDS ' + keys.KINDS.length + '）\n');
process.stdout.write('  归属分布: ' + perFeature + '\n');
process.stdout.write('  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
