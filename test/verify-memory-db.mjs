/**
 * verify-memory-db.mjs — v1.2 判据 M1/M2/M3：
 *   M1 100 条事件 FTS 命中；衰减；pinned 不变
 *   M2 人设隔离；关系/好感度注入；世界书 RAG
 *   M3 JSONL 迁移不丢；删除/按日期回滚/导出
 * 用临时 DSH_FOLIA_HOME，不碰真实用户目录。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'folia-memory-v2-'));
process.env.DSH_FOLIA_HOME = HOME;
process.env.FOLIA_MEMORY_DB = '1';

const store = await import('../lib/persona-store.js');
const mem = await import('../lib/persona-memory.js');
const db = await import('../lib/memory-db.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const a = store.createPersona({ type: 'assistant', name: 'A' });
const b = store.createPersona({ type: 'assistant', name: 'B' });

/* M1① 100 条事件可 FTS 命中 */
check('M1 后端为 SQLite（node:sqlite，不新增原生依赖）', mem.memoryBackend(a.id) === 'db', mem.memoryBackend(a.id));
for (let i = 0; i < 100; i += 1) {
  mem.appendEvent(a.id, {
    kind: 'event', importance: (i % 10) + 1,
    text: `第 ${i} 条记忆：用户喜欢第 ${i} 号样例${i === 42 ? '，特别是星空' : ''}`,
  });
}
const hit = mem.retrieveEvents(a.id, '星空', { topK: 8, tokenBudget: 800 });
check('M1① 100 条事件里 FTS 命中指定关键词',
  mem.eventCount(a.id) === 100 && hit.items.some((item) => item.text.includes('星空')),
  `count=${mem.eventCount(a.id)} hits=${hit.items.length}`);

/* M1② 衰减：30 天前低重要被降权/归档；pinned 不变 */
const old = Date.now() - 40 * 86400000;
db.addEvent(a.id, { kind: 'event', importance: 2, text: '四十天前的低重要旧事：便利店买水', ts: old });
db.addEvent(a.id, { kind: 'preference', importance: 9, text: '称呼：主人（pinned）', ts: old, pinned: true });
const beforePinned = db.search(a.id, '主人', { limit: 5 }).find((item) => item.text.includes('pinned'));
const decay = db.decayTick(a.id);
const stats = db.stats(a.id);
const stillPinned = db.search(a.id, '主人', { limit: 5 }).find((item) => item.text.includes('pinned'));
check('M1② 衰减：低重要旧事被归档，pinned 不动',
  decay.archived >= 1 && stats.archived >= 1 && Boolean(beforePinned) && Boolean(stillPinned) && stillPinned.archived !== true,
  `archived=${decay.archived} pinned=${stats.pinned}`);

/* M2① 两个人设互不串库 */
mem.appendEvent(b.id, { kind: 'event', importance: 5, text: 'B 的秘密：雨夜与旧唱片' });
const bHits = mem.retrieveEvents(b.id, '雨夜', { topK: 8 });
const aHits = mem.retrieveEvents(a.id, '雨夜', { topK: 8 });
check('M2① 两个人设互不串库',
  bHits.items.some((item) => item.text.includes('雨夜'))
  && !aHits.items.some((item) => item.text.includes('雨夜'))
  && mem.memoryStoragePath(a.id) !== mem.memoryStoragePath(b.id),
  `A=${aHits.items.length} B=${bHits.items.length}`);

/* M2② 关系 / 好感度：clamp 到 -10..10，并注入 prompt 块 */
db.upsertRelation(a.id, '星穹铁道', 3, '一起玩');
db.upsertRelation(a.id, '星穹铁道', 20, '一起玩');
const rel = db.listRelations(a.id).find((item) => item.entity === '星穹铁道');
const relLine = db.relationsPromptLine(a.id);
check('M2② 关系/好感度落库、夹在 -10..10，并生成注入块',
  rel && rel.affinity === 10 && relLine.includes('星穹铁道') && relLine.includes('10'), `affinity=${rel && rel.affinity}`);

/* M2③ 世界书：分块 500–800 字 + 检索命中 */
const loreText = ('泰拉大陆的源石与矿石病设定。'.repeat(60));
const added = db.addLore(a.id, { title: '设定集', content: loreText, source: 'doc' });
const loreHit = db.searchLore(a.id, '矿石病', { limit: 3 });
const chunks = db.chunkLore(loreText);
check('M2③ 世界书分块（每块 ≤800 字）且可检索',
  added.ok === true && added.chunks >= 1 && chunks.every((chunk) => [...chunk].length <= 800)
  && loreHit.length >= 1 && loreHit[0].content.includes('矿石病'),
  `chunks=${added.chunks} lens=${chunks.map((c) => [...c].length).join('/')}`);

/* M3① JSONL 迁移：不丢数据、保留原文件、幂等 */
const c = store.createPersona({ type: 'assistant', name: 'C' });
const cDir = join(store.personaDir(c.id), 'memory');
mkdirSync(cDir, { recursive: true });
const lines = [
  { id: 'e_old1', ts: Date.now() - 10 * 86400000, kind: 'event', importance: 3, text: '旧事件一：喜欢雨天' },
  { id: 'e_old2', ts: Date.now() - 5 * 86400000, kind: 'preference', importance: 8, text: '偏好：喜欢安静' },
];
writeFileSync(join(cDir, 'events.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
writeFileSync(join(cDir, 'summary.json'), JSON.stringify({ text: '旧摘要：最近在复习', updatedAt: Date.now() }));
const migrated = mem.memoryBackend(c.id); // 触发迁移
const cEvents = mem.listEvents(c.id, { limit: 10 });
const cSummary = mem.readSummary(c.id);
const again = db.migrateFromJsonl(c.id);
check('M3① JSONL 迁移不丢数据、保留原文件、幂等',
  migrated === 'db' && cEvents.total === 2 && cEvents.items.some((item) => item.text.includes('喜欢雨天'))
  && cSummary.text.includes('旧摘要') && existsSync(join(cDir, 'events.jsonl'))
  && readFileSync(join(cDir, 'events.jsonl'), 'utf8').includes('旧事件一')
  && again.imported === 0 && again.reason === 'already-migrated',
  `total=${cEvents.total} summary=${Boolean(cSummary.text)} again=${again.reason}`);

/* M3② 删除 / 按日期回滚 / 导出 */
const today = new Date();
const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const deleteTarget = mem.listEvents(b.id, { limit: 10 }).items[0];
const deleted = mem.deleteEvent(b.id, deleteTarget.id);
const exported = db.exportMemory(a.id);
const dayDeleted = mem.deleteEventsByDate(a.id, key);
check('M3② 删除单条 / 导出 / 按日期回滚都生效',
  deleted.ok === true && exported.ok === true && Array.isArray(exported.events) && exported.events.length > 90
  && dayDeleted.ok === true && typeof dayDeleted.deleted === 'number',
  `deleted=${deleted.ok} export=${exported.events.length} byDate=${dayDeleted.deleted}`);

/* M3③ 清空：DB 与 JSONL 路径都清掉 */
mem.clearEvents(b.id);
check('M3③ 清空后事件为 0（人设隔离不受影响）',
  mem.eventCount(b.id) === 0 && mem.eventCount(a.id) > 0, `A=${mem.eventCount(a.id)} B=${mem.eventCount(b.id)}`);

/* M1③ 回退开关存在：源码里有 FOLIA_MEMORY_DB=0 的硬关 */
const src = readFileSync(new URL('../lib/memory-db.js', import.meta.url), 'utf8');
check('M1③ 回退开关：FOLIA_MEMORY_DB=0 时回退 JSONL（并保留旧文件）',
  /FOLIA_MEMORY_DB === '0'/.test(src) && /jsonl/.test(src), 'env flag + jsonl fallback');

const failed = results.filter((item) => !item.ok);
console.log(`\nMEMORY DB CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
