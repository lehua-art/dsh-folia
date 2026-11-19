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
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isKnownTool, toolNeedsConfirm, personaToolAllowed } from './pet-chat-brain.js';

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
  if (toolNeedsConfirm(toolName) && deps.confirmed !== true) {
    return { ok: false, say: confirmAsk(toolName), verified: false, needsConfirm: true, data: { tool: toolName, args } };
  }
  if (toolName === 'wallpaper_switch') return wallpaperSwitch(args, deps);
  if (toolName === 'pet_toggle') return petToggle(args);
  if (toolName === 'pet_scale') return petScale(args);
  if (toolName === 'pet_volume') return petVolume(args);
  if (toolName === 'tts_toggle') return ttsToggle(args, deps);
  if (toolName === 'reminder_create') return reminderCreate(args);
  if (toolName === 'reminder_list') return reminderList();
  if (toolName === 'memory_note') return fail('记忆由当前人设的事件流管理，请在人设页查看。', {}, false);
  if (toolName === 'memory_clear') return fail('清空记忆请到「人设 → 记忆」页操作。', {}, false);
  if (toolName === 'reminder_clear') return reminderClear();
  if (toolName === 'skin_uninstall') return skinUninstall(args, deps);
  return fail('这个我还不会。', { tool: toolName });
}
