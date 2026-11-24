/**
 * pet-chat-tools.js — 桌宠「办事」工具的最小集（v2 大脑的第二层）。
 *
 * 设计：`runTool(name, args, deps)` 是唯一入口；每个工具都按同一个契约返回
 *   `{ ok, say, verified, data, needsConfirm? }`
 * —— `verified` 必须来自**回读**（设置文件 / 记忆文件 / 提醒文件 / 皮肤列表），
 * 不是“调用没抛错”。这是「验证成功才说成功」的承重墙：`say` 只在 verified 时用
 * 肯定句，否则统一走承认失败的那一句。
 *
 * 复用边界：本文件不重写业务 —— 壁纸切换交给客户端现有 `applySelection`（经路由的
 * SSE action 通道），皮肤卸载走现有 `/skins/remove` HTTP 路由，朗读开关写现有覆盖层
 * （`pet-chat/settings.json`），桌宠配置读写的形状与 `lib/routes/pets.js` 完全一致。
 *
 * 依赖注入：`deps` 里可给 `readSettings` / `switchWallpaper` / `readOverlay` /
 * `writeOverlay` / `skinsActive` / `skinsRemove` / `skinsList` / `verifyTimeoutMs` /
 * `sleep`；没给的部分（记忆、桌宠配置、提醒）本文件自己按 `DSH_FOLIA_HOME` 读写。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { isKnownTool, toolNeedsConfirm, personaToolAllowed, toolPolicy } from './pet-chat-brain.js';

/** 回读等待上限：设置是 200ms 防抖落盘的，给 3 秒足够（不把聊天卡到 20 秒）。 */
const DEFAULT_VERIFY_TIMEOUT_MS = 3000;

const clip = (value, max = 80) => {
  const chars = [...String(value == null ? '' : value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
};

function baseDir() {
  return process.env.DSH_FOLIA_HOME || join(homedir(), '.dsh-folia');
}

function petConfigPath() {
  return join(baseDir(), 'pet-config.json');
}

function remindersPath() {
  return join(baseDir(), 'pet-chat', 'reminders.json');
}

function overlayPath() {
  return join(baseDir(), 'pet-chat', 'settings.json');
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' ? doc : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
  return value;
}

/** 桌宠配置（与 `lib/routes/pets.js` 的 readConfig 同一形状）。 */
export function readPetConfig() {
  const raw = readJson(petConfigPath(), {});
  return {
    enabled: raw.enabled === true,
    petId: typeof raw.petId === 'string' ? raw.petId : '',
    scale: Number.isFinite(Number(raw.scale)) ? Math.min(3, Math.max(0.5, Number(raw.scale))) : 1,
    sound: raw.sound === true,
    volume: Number.isFinite(Number(raw.volume)) ? Math.min(1, Math.max(0, Number(raw.volume))) : 0.6,
  };
}

/** 合并写桌宠配置（与 pets 路由同一条钳位规则）。 */
export function writePetConfig(patch = {}) {
  const cur = readPetConfig();
  const merged = {
    enabled: patch.enabled === undefined ? cur.enabled : Boolean(patch.enabled),
    petId: patch.petId === undefined ? cur.petId : String(patch.petId || ''),
    scale: patch.scale === undefined ? cur.scale : Math.min(3, Math.max(0.5, Number(patch.scale) || 1)),
    sound: patch.sound === undefined ? cur.sound : Boolean(patch.sound),
    volume: patch.volume === undefined ? cur.volume : Math.min(1, Math.max(0, Number(patch.volume) || 0)),
  };
  return writeJson(petConfigPath(), merged);
}

/** 覆盖层原始对象（朗读开关写这里，与 `/voice/config` 同一份文件）。 */
function readOverlayFile() {
  return readJson(overlayPath(), {});
}

function writeOverlayFile(patch) {
  const current = readOverlayFile();
  return writeJson(overlayPath(), { ...current, ...patch });
}

/** 提醒列表（按时间升序；坏条目静默丢弃）。 */
export function readReminders() {
  const doc = readJson(remindersPath(), { items: [] });
  const items = (Array.isArray(doc.items) ? doc.items : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || ''),
      at: String(item.at || ''),
      text: clip(item.text, 60),
      createdAt: Number(item.createdAt) || 0,
      fired: item.fired === true,
      firedAt: Number(item.firedAt) || 0,
    }))
    .filter((item) => item.id && item.at && item.text)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { items };
}

function writeReminders(doc) {
  return writeJson(remindersPath(), { items: Array.isArray(doc.items) ? doc.items : [] });
}

/** 到点且还没播过的提醒（路由的轮询用）。 */
export function dueReminders(now = Date.now()) {
  return readReminders().items.filter((item) => {
    if (item.fired) return false;
    const at = new Date(item.at).getTime();
    return Number.isFinite(at) && at <= now;
  });
}

/** 把一条提醒标成已播（按 id；找不到就原样返回）。 */
export function markReminderFired(id, now = Date.now()) {
  const doc = readReminders();
  const items = doc.items.map((item) => (item.id === id ? { ...item, fired: true, firedAt: now } : item));
  writeReminders({ items });
  return items.find((item) => item.id === id) || null;
}

function readSettingsSafe(deps) {
  try {
    return (deps && typeof deps.readSettings === 'function' && deps.readSettings()) || {};
  } catch {
    return {};
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 轮询直到 predicate 为真或超时；返回最后一次的值。 */
async function waitFor(predicate, timeoutMs, sleeper) {
  const wait = typeof sleeper === 'function' ? sleeper : sleep;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) return value;
    // eslint-disable-next-line no-await-in-loop -- 回读必须按时间顺序轮询
    await wait(120);
  }
}

function fail(say, data = {}, verified = false) {
  return { ok: false, say, verified, data };
}

/** 危险动作的统一追问文案（路由与工具共用一份，避免两处漂移）。 */
export function confirmAsk(name) {
  if (name === 'skin_uninstall') return '要卸载当前皮肤吗？确认就说「确认」，不想就说「取消」。';
  if (name === 'memory_clear') return '要清空长期记忆吗？确认就说「确认」，不想就说「取消」。';
  if (name === 'reminder_clear') return '要清空所有提醒吗？确认就说「确认」，不想就说「取消」。';
  if (name === 'media_control') return '要我控制正在播放的媒体吗？确认就说「好」，或在气泡里点「允许」。';
  if (name === 'doc_read') return '要我读一下工作区里的文件吗？确认就说「好」，或在气泡里点「允许」。';
  if (name === 'search_query') return '要我联网搜一下吗？确认就说「好」，或在气泡里点「允许」。';
  return '这一步会改动本机文件，确认吗？';
}

async function wallpaperSwitch(args, deps) {
  const mode = String(args.mode || '');
  const name = String(args.name || '').trim();
  if (!['random', 'next', 'dark', 'byName'].includes(mode)) return fail('想换成哪张？可以说「随机」「下一张」「暗色的」或壁纸名字。');
  if (mode === 'byName' && !name) return fail('要换成哪张壁纸？告诉我名字就行。');
  if (typeof deps.switchWallpaper !== 'function') {
    return fail('现在没有能换壁纸的界面，等桌面端连上再试。');
  }
  let ack;
  try {
    ack = await deps.switchWallpaper({ mode, name });
  } catch {
    ack = { ok: false, error: 'action-failed' };
  }
  if (!ack || ack.ok === false) {
    const why = ack && ack.error === 'no-match'
      ? `没找到叫「${name}」的壁纸，换个名字试试？`
      : '换壁纸没成功，我再试一次。';
    return fail(why, { mode, name, error: (ack && ack.error) || 'switch-failed' });
  }
  const targetId = String(ack.targetId || '');
  const title = clip(ack.title || name || '这张', 20);
  if (!targetId) return fail('换了但没生效，我再试一次。', { mode, name });
  const settings = readSettingsSafe(deps);
  const timeout = Number(deps.verifyTimeoutMs) > 0 ? Number(deps.verifyTimeoutMs) : DEFAULT_VERIFY_TIMEOUT_MS;
  const verified = await waitFor(() => String(readSettingsSafe(deps).id || '') === targetId, timeout, deps.sleep);
  const currentId = String(readSettingsSafe(deps).id || settings.id || '');
  if (verified) {
    return { ok: true, say: `换成「${title}」了。`, verified: true, data: { mode, name, targetId, title, currentId } };
  }
  return fail('换了但没生效，我再试一次。', { mode, name, targetId, title, currentId }, false);
}

function petToggle(args) {
  const visible = args.visible !== false;
  writePetConfig({ enabled: visible });
  const read = readPetConfig();
  const verified = read.enabled === visible;
  if (!verified) return fail('桌宠状态没写进去，再试一次。', { visible });
  return { ok: true, say: visible ? '桌宠出来了。' : '桌宠先藏起来了。', verified: true, data: { visible } };
}

function petScale(args) {
  const percent = Math.max(60, Math.min(120, Math.round(Number(args.percent) || 100)));
  writePetConfig({ scale: percent / 100 });
  const read = readPetConfig();
  const actual = Math.round(read.scale * 100);
  const verified = Math.abs(actual - percent) <= 1;
  if (!verified) return fail('大小没调成，再试一次。', { percent, actual });
  return { ok: true, say: `桌宠调到 ${actual}% 了。`, verified: true, data: { percent: actual } };
}

function petVolume(args) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(args.percent) || 0)));
  writePetConfig({ volume: percent / 100 });
  const read = readPetConfig();
  const actual = Math.round(read.volume * 100);
  const verified = Math.abs(actual - percent) <= 1;
  if (!verified) return fail('音量没调成，再试一次。', { percent, actual });
  return { ok: true, say: `音量调到 ${actual}% 了。`, verified: true, data: { percent: actual } };
}

function ttsToggle(args, deps) {
  const enabled = args.enabled !== false;
  const current = typeof deps.readOverlay === 'function' ? (deps.readOverlay() || {}) : readOverlayFile();
  const voice = current.voice && typeof current.voice === 'object' ? current.voice : {};
  const patch = { voice: { ...voice, muted: !enabled } };
  if (typeof deps.writeOverlay === 'function') deps.writeOverlay(patch);
  else writeOverlayFile(patch);
  const read = typeof deps.readOverlay === 'function' ? (deps.readOverlay() || {}) : readOverlayFile();
  const muted = Boolean(read.voice && read.voice.muted === true);
  const verified = muted === !enabled;
  if (!verified) return fail('朗读开关没写进去，再试一次。', { enabled });
  return { ok: true, say: enabled ? '朗读打开了。' : '好，我不念了。', verified: true, data: { enabled } };
}

function reminderCreate(args) {
  const at = String(args.at || '').trim();
  const text = clip(args.text || '该做的事', 40);
  const when = at ? new Date(at) : null;
  if (!when || !Number.isFinite(when.getTime())) {
    return fail('几点提醒你？说个时间，比如「8 点半提醒我开会」。', { at, text });
  }
  const item = {
    id: 'rm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    at: when.toISOString(),
    text,
    createdAt: Date.now(),
    fired: false,
  };
  const doc = readReminders();
  writeReminders({ items: [...doc.items, item] });
  const read = readReminders();
  const verified = read.items.some((row) => row.id === item.id && row.at === item.at);
  if (!verified) return fail('提醒没写进去，再试一次。', { at, text });
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  return { ok: true, say: `好，${hh}:${mm} 提醒你${text}。`, verified: true, data: { id: item.id, at: item.at, text } };
}

function reminderList() {
  const items = readReminders().items.filter((item) => !item.fired);
  if (!items.length) return { ok: true, say: '现在没有待办的提醒。', verified: true, data: { items: [] } };
  const shown = items.slice(0, 3).map((item) => {
    const date = new Date(item.at);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm} ${item.text}`;
  });
  const more = items.length > shown.length ? `，还有 ${items.length - shown.length} 条` : '';
  return {
    ok: true,
    say: clip(`提醒：${shown.join('；')}${more}。`, 100),
    verified: true,
    data: { items },
  };
}

function reminderClear() {
  try { rmSync(remindersPath(), { force: true }); } catch { /* 删不掉由回读判 */ }
  const verified = readReminders().items.length === 0;
  if (!verified) return fail('提醒没清掉，再试一次。');
  return { ok: true, say: '提醒都清空了。', verified: true, data: {} };
}

async function skinUninstall(args, deps) {
  let active = String(args.id || '');
  if (!active && typeof deps.skinsActive === 'function') {
    try { active = String(await deps.skinsActive() || ''); } catch { active = ''; }
  }
  if (!active) return fail('现在没有正在使用的皮肤，不用卸载。', {});
  if (typeof deps.skinsRemove !== 'function' || typeof deps.skinsList !== 'function') {
    return fail('这个版本还没接通皮肤卸载，先不动它。', { id: active });
  }
  let removed;
  try { removed = await deps.skinsRemove(active); } catch { removed = { ok: false }; }
  if (!removed || removed.ok !== true) return fail('卸载没成功，皮肤还在。', { id: active });
  let list;
  try { list = await deps.skinsList(); } catch { list = []; }
  const normalized = (id) => String(id || '').replace(/^skin-/, '');
  const stillThere = list.some((item) => normalized(item && (item.dirId || item.id)) === normalized(active));
  if (stillThere) return fail('卸载命令发了，但皮肤还在列表里。', { id: active });
  return { ok: true, say: '皮肤卸掉了。', verified: true, data: { id: active } };
}

/* ── v2 新增：媒体 / 状态 / 文档 / 搜索 / 轮播 ────────────────────────────── */

const MEDIA_ACTION_LABEL = Object.freeze({ play: '播放', pause: '暂停', next: '下一首', prev: '上一首' });

async function mediaControl(args, deps) {
  const action = String(args.action || '');
  if (!Object.prototype.hasOwnProperty.call(MEDIA_ACTION_LABEL, action)) {
    return fail('要播放、暂停、下一首还是上一首？', { action });
  }
  if (typeof deps.mediaControl !== 'function') {
    return fail('这个版本还没接通系统媒体控制。', { action });
  }
  let ack;
  try { ack = await deps.mediaControl(action); } catch { ack = { ok: false, error: 'media-failed' }; }
  if (!ack || ack.ok === false) {
    return fail('媒体控制没成功，可能是没有正在播放的内容。', { action, error: (ack && ack.error) || 'media-failed' });
  }
  const label = MEDIA_ACTION_LABEL[action];
  return { ok: true, say: `${label}好了。`, verified: true, data: { action, title: String(ack.title || ''), artist: String(ack.artist || '') } };
}

async function statusQuery(args, deps) {
  if (typeof deps.statusSnapshot !== 'function') {
    return fail('现在读不到系统状态。', {});
  }
  let snapshot;
  try { snapshot = await deps.statusSnapshot(); } catch { snapshot = null; }
  if (!snapshot || typeof snapshot !== 'object') return fail('现在读不到系统状态。', {});
  const parts = [];
  parts.push(`壁纸：${clip(snapshot.wallpaperTitle || '未选择', 20)}`);
  parts.push(`音色：${clip(snapshot.voice || '继承全局', 24)}`);
  parts.push(`音量：${Math.round(Number(snapshot.volume) || 0)}%`);
  if (snapshot.playing && (snapshot.playing.title || snapshot.playing.artist)) {
    parts.push(`正在播放：${clip([snapshot.playing.title, snapshot.playing.artist].filter(Boolean).join(' - '), 30)}`);
  } else {
    parts.push('正在播放：无');
  }
  return { ok: true, say: clip(parts.join('；') + '。', 120), verified: true, data: snapshot };
}

const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.css', '.html', '.yml', '.yaml', '.log', '.csv', '.xml', '.ini', '.toml', '.py']);
const DOC_MAX_BYTES = 256 * 1024;

function docRead(args, deps) {
  const raw = String(args.path || '').trim();
  if (!raw) return fail('要读哪个文件？给我一个相对路径，比如 README.md。', {});
  if (raw.includes('\u0000') || isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    return fail('只能读工作区里的相对路径。', { path: raw });
  }
  const root = resolve(String(deps.workspaceRoot || process.cwd()));
  const target = resolve(root, raw);
  if (target !== root && !target.startsWith(root + sep)) {
    return fail('只能读工作区里的文件。', { path: raw });
  }
  const ext = extname(target).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) {
    return fail('只支持读取文本文件（md/txt/json/js/ts/css/html/log/csv 等）。', { path: raw, ext });
  }
  let stat;
  try { stat = statSync(target); } catch {
    return fail(`工作区里没有「${clip(raw, 60)}」这个文件。`, { path: raw });
  }
  if (!stat.isFile()) return fail('这个路径不是文件。', { path: raw });
  if (stat.size > DOC_MAX_BYTES) {
    return fail(`文件太大了（${Math.round(stat.size / 1024)}KB），只读 256KB 以内的文本。`, { path: raw, size: stat.size });
  }
  let text = '';
  try { text = readFileSync(target, 'utf8'); } catch {
    return fail('文件读不出来（可能不是 UTF-8 文本）。', { path: raw });
  }
  const clean = text.replace(/^\uFEFF/, '');
  const head = clip(clean.replace(/\s+/g, ' ').trim(), 60);
  return {
    ok: true,
    say: clip(`读到了「${clip(raw, 40)}」：${head}`, 120),
    verified: true,
    data: { path: raw, bytes: stat.size, chars: [...clean].length, text: clip(clean, 12000) },
  };
}

function searchResultsOf(doc) {
  const out = [];
  const abstract = String((doc && doc.AbstractText) || '').trim();
  if (abstract) out.push({ title: String((doc && doc.Heading) || '摘要'), snippet: abstract, url: String((doc && doc.AbstractURL) || '') });
  const walk = (list, depth) => {
    if (!Array.isArray(list) || depth > 2) return;
    for (const item of list) {
      if (out.length >= 5) return;
      if (item && Array.isArray(item.Topics)) { walk(item.Topics, depth + 1); continue; }
      if (item && item.Text) out.push({ title: clip(item.Text, 80), snippet: clip(item.Text, 120), url: String(item.FirstURL || '') });
    }
  };
  walk((doc && doc.RelatedTopics) || [], 0);
  return out.slice(0, 5);
}

async function searchQuery(args, deps) {
  const query = clip(String(args.query || '').trim(), 80);
  if (!query) return fail('要搜什么？说个关键词。', {});
  if (typeof deps.search === 'function') {
    let result;
    try { result = await deps.search(query); } catch { result = null; }
    if (!result || result.ok === false) return fail('搜索没成功，稍后再试。', { query, error: (result && result.error) || 'search-failed' });
    const items = Array.isArray(result.items) ? result.items.slice(0, 5) : [];
    const first = items[0];
    return {
      ok: true,
      say: first ? clip(`搜到：${first.title || first.snippet || ''}`, 120) : '没搜到相关结果。',
      verified: items.length > 0,
      data: { query, items },
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = 'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' + encodeURIComponent(query);
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'dsh-folia' } });
    if (!response.ok) return fail('搜索服务暂时不可用（HTTP ' + response.status + '）。', { query });
    const doc = await response.json();
    const items = searchResultsOf(doc);
    return {
      ok: true,
      say: items.length ? clip(`搜到：${items[0].title || items[0].snippet}`, 120) : '没搜到相关结果。',
      verified: items.length > 0,
      data: { query, items },
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return fail(aborted ? '搜索超时了。' : '连不上搜索服务。', { query, error: String((error && error.message) || error) });
  } finally {
    clearTimeout(timer);
  }
}

async function wallpaperCycle(args, deps) {
  const enabled = args.enabled !== false;
  if (typeof deps.toggleRotation !== 'function') {
    return fail('这个版本还没接通轮播开关。', { enabled });
  }
  let ack;
  try { ack = await deps.toggleRotation(enabled); } catch { ack = { ok: false, error: 'cycle-failed' }; }
  if (!ack || ack.ok === false) return fail('轮播开关没切成功。', { enabled, error: (ack && ack.error) || 'cycle-failed' });
  const timeout = Number(deps.verifyTimeoutMs) > 0 ? Number(deps.verifyTimeoutMs) : DEFAULT_VERIFY_TIMEOUT_MS;
  const verified = await waitFor(() => {
    try {
      const settings = readSettingsSafe(deps);
      return settings.rotationEnabled === enabled;
    } catch { return false; }
  }, timeout, deps.sleep);
  if (!verified) return fail('轮播开关没生效，再试一次。', { enabled });
  return { ok: true, say: enabled ? '轮播打开了，我会隔一会儿换一张。' : '轮播关掉了。', verified: true, data: { enabled } };
}


/**
 * 执行一个工具。
 *
 * @param {string} name
 * @param {object} args
 * @param {{
 *   sourceText?: string,
 *   confirmed?: boolean,
 *   readSettings?: Function,
 *   switchWallpaper?: Function,
 *   readOverlay?: Function,
 *   writeOverlay?: Function,
 *   skinsActive?: Function,
 *   skinsRemove?: Function,
 *   skinsList?: Function,
 *   verifyTimeoutMs?: number,
 *   sleep?: Function,
 * }} [deps]
 * @returns {Promise<{ok:boolean, say:string, verified:boolean, data:object, needsConfirm?:boolean}>}
 */
export async function runTool(name, args = {}, deps = {}) {
  const toolName = String(name || '');
  // 特殊人设：不管调用方是谁，工具层再拦一道（路由层已拦，这里是双保险）。
  if (deps.persona && !personaToolAllowed(deps.persona)) {
    return fail('特殊人设不使用系统工具。', {}, false);
  }
  if (toolName === 'unsupported_danger') {
    return fail('这个版本还不会删壁纸或缓存，先不动它。', {}, false);
  }
  if (!isKnownTool(toolName)) return fail('这个我还不会。', { tool: toolName });
  // v2：权限组三档（allow / ask / deny）在工具层再判一次；system 组还要求 advanced。
  const policy = deps.persona
    ? toolPolicy(deps.persona, toolName)
    : { allowed: true, permission: 'allow', group: '', tool: toolName };
  if (!policy.allowed) {
    return {
      ok: false,
      say: policy.reason === 'character-no-tools' ? '特殊人设不使用系统工具。' : '这个我不能做。',
      verified: false,
      permission: policy.permission,
      group: policy.group,
      data: { tool: toolName, permission: policy.permission, group: policy.group, reason: policy.reason },
    };
  }
  // ask 档必须先问；高危工具（system）即使 allow 也强制二次确认。
  const needsConfirm = policy.permission === 'ask' || toolNeedsConfirm(toolName);
  if (needsConfirm && deps.confirmed !== true) {
    return {
      ok: false,
      say: confirmAsk(toolName),
      verified: false,
      needsConfirm: true,
      permission: policy.permission,
      group: policy.group,
      data: { tool: toolName, args, permission: policy.permission, group: policy.group },
    };
  }
  if (toolName === 'wallpaper_switch') return wallpaperSwitch(args, deps);
  if (toolName === 'wallpaper_cycle') return wallpaperCycle(args, deps);
  if (toolName === 'pet_toggle') return petToggle(args);
  if (toolName === 'pet_scale') return petScale(args);
  if (toolName === 'pet_volume') return petVolume(args);
  if (toolName === 'tts_toggle') return ttsToggle(args, deps);
  if (toolName === 'reminder_create') return reminderCreate(args);
  if (toolName === 'reminder_list') return reminderList();
  if (toolName === 'media_control') return mediaControl(args, deps);
  if (toolName === 'status_query') return statusQuery(args, deps);
  if (toolName === 'doc_read') return docRead(args, deps);
  if (toolName === 'search_query') return searchQuery(args, deps);
  if (toolName === 'memory_note') return fail('记忆由当前人设的事件流管理，请在人设页查看。', {}, false);
  if (toolName === 'memory_clear') return fail('清空记忆请到「人设 → 记忆」页操作。', {}, false);
  if (toolName === 'reminder_clear') return reminderClear();
  if (toolName === 'skin_uninstall') return skinUninstall(args, deps);
  return fail('这个我还不会。', { tool: toolName });
}
