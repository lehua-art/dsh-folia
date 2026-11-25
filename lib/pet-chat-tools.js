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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
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
  if (name === 'doc_write') return '要写工作区里的文件吗？我会先备份原文件；确认就说「好」，或在气泡里点「允许」。';
  if (name === 'search_query') return '要我联网搜一下吗？确认就说「好」，或在气泡里点「允许」。';
  if (name === 'open_url') return '要在浏览器里打开这个网页吗？确认就说「好」，或在气泡里点「允许」。';
  if (name === 'app_launch') return '要启动这个应用吗？确认就说「好」，或在气泡里点「允许」。';
  if (name === 'notify') return '要发一条桌面通知吗？确认就说「好」，或在气泡里点「允许」。';
  if (name === 'clipboard_get') return '要我读一下剪贴板吗（可能有隐私内容）？确认就说「好」。';
  if (name === 'clipboard_set') return '要把内容写进剪贴板吗（会覆盖原内容）？确认就说「好」。';
  return '这一步会改动本机文件，确认吗？';
}

/* ── 白名单（任务 §6②：open_url 白名单域名 / app_launch 仅白名单）──────────── */

/** 默认允许的网页域名（用户可在设置里增删；只允许 https）。 */
export const DEFAULT_OPEN_URL_DOMAINS = Object.freeze([
  'bilibili.com', 'youtube.com', 'github.com', 'baidu.com', 'zhihu.com',
  'weibo.com', 'wikipedia.org', 'google.com', 'deepseek.com', 'feishu.cn',
]);

/** 默认允许启动的应用（id → 平台命令由宿主解析；用户可在设置里改）。 */
export const DEFAULT_APP_WHITELIST = Object.freeze([
  { id: 'notepad', label: '记事本' },
  { id: 'calc', label: '计算器' },
  { id: 'mspaint', label: '画图' },
  { id: 'explorer', label: '资源管理器' },
  { id: 'browser', label: '默认浏览器' },
]);

function whitelistPath() {
  return join(baseDir(), 'pet-chat', 'tool-whitelist.json');
}

/** 读用户可编辑的白名单（坏文件回落默认；域名/应用都做去重与裁剪）。 */
export function readToolWhitelist() {
  const doc = readJson(whitelistPath(), {});
  const domains = Array.isArray(doc.domains) && doc.domains.length
    ? doc.domains.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : DEFAULT_OPEN_URL_DOMAINS.slice();
  const apps = Array.isArray(doc.apps) && doc.apps.length
    ? doc.apps.map((item) => (typeof item === 'string'
      ? { id: item.trim(), label: item.trim() }
      : { id: String((item && item.id) || '').trim(), label: String((item && item.label) || (item && item.id) || '').trim() }))
      .filter((item) => item.id)
    : DEFAULT_APP_WHITELIST.map((item) => ({ ...item }));
  return {
    domains: [...new Set(domains)].slice(0, 60),
    apps: apps.slice(0, 40),
    // v5 §4：能力白名单（只列不调用 ⇒ 这里是"允许调用"的显式开关）
    capabilities: Array.isArray(doc.capabilities)
      ? [...new Set(doc.capabilities.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 60)
      : [],
  };
}

/** 写白名单（只接受数组；不合法回落当前值）。 */
export function writeToolWhitelist(patch = {}) {
  const current = readToolWhitelist();
  const next = { ...current };
  if (Array.isArray(patch.domains)) {
    next.domains = [...new Set(patch.domains.map((item) => String(item || '').trim().toLowerCase())
      .map((item) => item.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter((item) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(item)))].slice(0, 60);
  }
  if (Array.isArray(patch.apps)) {
    next.apps = patch.apps.map((item) => (typeof item === 'string'
      ? { id: item.trim(), label: item.trim() }
      : { id: String((item && item.id) || '').trim(), label: String((item && item.label) || (item && item.id) || '').trim() }))
      .filter((item) => item.id).slice(0, 40);
  }
  if (Array.isArray(patch.capabilities)) {
    next.capabilities = [...new Set(patch.capabilities.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 60);
  }
  writeJson(whitelistPath(), next);
  return readToolWhitelist();
}

/** 域名是否落在白名单（子域名算命中；必须 https）。 */
export function hostAllowed(url, domains) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return { ok: false, reason: 'bad-url' }; }
  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not-https' };
  const host = parsed.hostname.toLowerCase();
  const list = Array.isArray(domains) ? domains : DEFAULT_OPEN_URL_DOMAINS;
  const hit = list.some((domain) => host === domain || host.endsWith('.' + domain));
  return hit ? { ok: true, host } : { ok: false, reason: 'not-whitelisted', host };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * v5 §4：已安装插件 / 技能的能力发现与调用
 *
 * 调研结论（2026-11-25，A 机器）：DSH 宿主里有 `ctx.skills`（list/get）、
 * `ctx.tools`（注册表/execute）、`pluginInventory`（只读快照）、`subagents`。
 * 但 Folia 的插件入口只把 speechToText 传进路由，**没有把 ctx 服务传进来**；
 * 且 `/api/*` 需要运行时 token（本机探测 401，token 只注入可信 Web 客户端）。
 * 因此这里用**与 DSH 自己的 skill-filesystem provider 同口径的文件面**：
 *   ~/.dsh/skills、<project>/.dsh/skills、<project>/.agents/skills、随包 office-skills
 * 技能 = SKILL.md（frontmatter + 指令正文）；调用 = 读出正文交给模型照做。
 * 插件 = 已安装 package（只读列出；没有通用 invoke 接口的不假装能调）。
 * 若宿主以后把 ctx 服务传进来（deps.services.skills/tools），优先用服务。
 * ═══════════════════════════════════════════════════════════════════════════ */

function parseSkillMarkdown(text) {
  const raw = String(text || '');
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (match) {
    body = match[2];
    for (const line of match[1].split(/\r?\n/)) {
      const hit = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (hit) meta[hit[1]] = hit[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return { meta, body: body.trim() };
}

/** 技能根目录（按 DSH skill-filesystem 的默认 rank；同一路径去重）。 */
export function discoverSkillRoots(deps = {}) {
  const roots = [];
  const envRoots = String(process.env.FOLIA_SKILL_ROOTS || '').split(process.env.PATH_SEPARATOR || ';').filter(Boolean);
  roots.push(...envRoots);
  if (Array.isArray(deps.skillRoots)) roots.push(...deps.skillRoots);
  const home = homedir();
  roots.push(join(home, '.dsh', 'skills'));
  roots.push(join(process.cwd(), '.dsh', 'skills'));
  roots.push(join(process.cwd(), '.agents', 'skills'));
  // 随包/运行时技能（office-skills）：从 Electron resources 或 node 可执行文件旁推断。
  const bundled = [
    process.env.DSH_BUNDLED_SKILL_DIR,
    process.resourcesPath ? join(process.resourcesPath, 'runtime', 'office-skills') : '',
    join(dirname(process.execPath || ''), '..', 'resources', 'runtime', 'office-skills'),
    join(dirname(process.execPath || ''), 'resources', 'runtime', 'office-skills'),
  ].filter(Boolean);
  roots.push(...bundled);
  const seen = new Set();
  return roots.map((root) => resolve(root)).filter((root) => {
    if (!root || seen.has(root)) return false;
    seen.add(root);
    return existsSync(root);
  });
}

function readSkillAt(dir) {
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return null;
  try {
    const { meta, body } = parseSkillMarkdown(readFileSync(file, 'utf8'));
    const name = String(meta.name || dir.split(/[\\/]/).pop() || '').trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return null;
    return {
      id: 'skill:' + name,
      kind: 'skill',
      name,
      label: String(meta.description || name).slice(0, 120),
      description: String(meta.description || '').slice(0, 240),
      source: dir,
      callable: true,
      content: body.slice(0, 4000),
    };
  } catch { return null; }
}

/** 已安装插件（profile 的 dependencies + dsh.profile.bundles；只读）。 */
function installedPlugins() {
  const items = [];
  const home = homedir();
  const profilesRoot = join(home, '.dsh', 'profiles');
  let profiles = [];
  try { profiles = readdirSync(profilesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(profilesRoot, entry.name)); } catch { profiles = []; }
  for (const dir of profiles) {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch { pkg = null; }
    if (!pkg) continue;
    const names = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...((pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles)) ? pkg.dsh.profile.bundles : []),
    ]);
    for (const name of names) {
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(String(name))) continue;
      let meta = null;
      try { meta = JSON.parse(readFileSync(join(dir, 'node_modules', String(name), 'package.json'), 'utf8')); } catch { meta = null; }
      items.push({
        id: 'plugin:' + name,
        kind: 'plugin',
        name: String(name),
        label: String((meta && (meta.displayName || meta.description || name)) || name).slice(0, 120),
        version: String((meta && meta.version) || '').slice(0, 20),
        description: String((meta && meta.description) || '').slice(0, 200),
        source: 'profile:' + dir.split(/[\\/]/).pop(),
        callable: false,
        reason: '插件没有通用调用面：只能读它的技能（如果有 SKILL.md）',
      });
    }
  }
  const seen = new Set();
  return items.filter((item) => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
}

/**
 * 能力清单：文件面技能 + 已安装插件（+ 宿主传入的 ctx.skills 摘要）。
 * @returns {{ok:boolean, skills:Array, plugins:Array, enabled:string[], roots:string[]}}
 */
export function listCapabilities(deps = {}) {
  const roots = discoverSkillRoots(deps);
  const skills = [];
  const seen = new Set();
  const serviceSkills = deps.services && deps.services.skills;
  if (serviceSkills && typeof serviceSkills.list === 'function') {
    try {
      const rows = serviceSkills.list({}) || [];
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const name = String((row && row.name) || '').trim();
        if (!name || seen.has('skill:' + name)) continue;
        seen.add('skill:' + name);
        skills.push({
          id: 'skill:' + name, kind: 'skill', name,
          label: String(row.description || name).slice(0, 120),
          description: String(row.description || '').slice(0, 240),
          source: 'ctx.skills', callable: true, content: '',
        });
      }
    } catch { /* 服务不可用 ⇒ 文件面兜底 */ }
  }
  for (const root of roots) {
    let dirs = [];
    try { dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name)); } catch { continue; }
    for (const dir of dirs) {
      const skill = readSkillAt(dir);
      if (!skill || seen.has(skill.id)) continue;
      seen.add(skill.id);
      skills.push(skill);
    }
  }
  const whitelist = (deps.toolWhitelist && Array.isArray(deps.toolWhitelist.capabilities))
    ? deps.toolWhitelist.capabilities
    : readToolWhitelist().capabilities;
  return {
    ok: true,
    skills,
    plugins: installedPlugins(),
    enabled: whitelist,
    roots,
  };
}

async function capabilityListTool(args, deps) {
  const list = listCapabilities(deps);
  const skills = list.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    source: skill.source.split(/[\\/]/).slice(-2).join('/'),
    enabled: list.enabled.includes(skill.id),
    callable: true,
  }));
  return {
    ok: true,
    say: skills.length
      ? `已安装能力：${skills.length} 个技能（默认只列不调用，去「权限 → 已安装插件与技能」开启）`
      : '没有发现已安装的技能（插件可以列出来，但没有通用调用面）',
    verified: true,
    data: { skills, plugins: list.plugins, enabled: list.enabled, roots: list.roots.length },
  };
}

async function capabilityCallTool(args, deps) {
  let id = String(args && args.id || '').trim();
  const list = listCapabilities(deps);
  // 用户说"用表情包插件"时模型可能只给空 id：按名字/描述在已安装能力里找。
  if (!id) {
    const haystack = String((args && args.input) || deps.sourceText || '');
    const byName = list.skills.find((item) => haystack.includes(item.name))
      || list.skills.find((item) => item.name.length >= 4 && haystack.includes(item.name.split('-')[0]));
    if (byName) id = byName.id;
  }
  if (!id) return fail('要调用哪个能力？先用「列出插件和技能」看看有什么。', {});
  const skill = list.skills.find((item) => item.id === id || item.name === id || item.id === 'skill:' + id);
  if (!skill) {
    const plugin = list.plugins.find((item) => item.id === id || item.name === id);
    if (plugin) {
      return fail(`「${plugin.label}」是插件，没有通用调用面（只能看它的技能）；换一个技能类能力试试。`, { id, kind: 'plugin' });
    }
    return fail(`没有这个能力：${clip(id, 40)}（先列一下已安装能力）`, { id });
  }
  const enabled = list.enabled.includes(skill.id);
  // 默认"只列不调用"：没启用时必须由用户明确确认这一次（确认即一次性放行）；
  // 启用之后仍受插件组权限（默认 ask）约束。
  if (!enabled && deps.confirmed !== true) {
    return fail(`「${skill.name}」还没启用：去「权限 → 已安装插件与技能」把它打开，或者直接说「确认」让我这一次调用。`, {
      id: skill.id, needEnable: true,
    });
  }
  if (!skill.content && deps.services && deps.services.skills && typeof deps.services.skills.get === 'function') {
    try {
      const loaded = await deps.services.skills.get(skill.name, {});
      if (loaded && loaded.content) skill.content = String(loaded.content).slice(0, 4000);
    } catch { /* 服务失败 ⇒ 报可读错误 */ }
  }
  if (!skill.content) return fail(`技能「${skill.name}」读不到正文（文件缺失或服务不可用）`, { id: skill.id });
  return {
    ok: true,
    say: `已加载技能「${skill.name}」，我按它的步骤来。`,
    verified: true,
    data: {
      capability: {
        id: skill.id,
        kind: 'skill',
        name: skill.name,
        description: skill.description,
        source: skill.source,
        content: skill.content,
        input: clip(args.input || '', 400),
      },
    },
  };
}

async function performTeach(args, deps) {
  // 教学本身由路由带着"教学提示"调用模型；这里只做参数校验与标记。
  const concept = clip(args && args.concept || '', 40);
  if (!concept) return fail('要讲哪个概念？给我一个词。', {});
  return { ok: true, say: `好，我讲讲「${concept}」。`, verified: true, data: { teach: { concept } } };
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

/* ── v3 新增：音量 / 通知 / 打开网页 / 启动应用 / 写文件 / 剪贴板 ─────────── */

const VOLUME_TARGET_LABEL = Object.freeze({ pet: '桌宠音量', wallpaper: '壁纸音量' });

function volumeSet(args, deps) {
  const target = String(args.target || 'pet');
  if (!Object.prototype.hasOwnProperty.call(VOLUME_TARGET_LABEL, target)) {
    return fail('要调桌宠音量还是壁纸音量？', { target });
  }
  const percent = Math.max(0, Math.min(100, Math.round(Number(args.percent) || 0)));
  if (target === 'pet') {
    writePetConfig({ volume: percent / 100, ...(typeof args.muted === 'boolean' ? { sound: !args.muted } : {}) });
    const read = readPetConfig();
    const actual = Math.round(read.volume * 100);
    if (Math.abs(actual - percent) > 1) return fail('音量没调成，再试一次。', { target, percent, actual });
    return { ok: true, say: `桌宠音量调到 ${actual}% 了。`, verified: true, data: { target, percent: actual } };
  }
  if (typeof deps.setWallpaperVolume !== 'function') {
    return fail('这个版本还没接通壁纸音量：先在壁纸设置里调。', { target });
  }
  return Promise.resolve(deps.setWallpaperVolume(percent)).then((ack) => {
    if (!ack || ack.ok === false) {
      return fail('壁纸音量没调成，再试一次。', { target, percent, error: (ack && ack.error) || 'volume-failed' });
    }
    const actual = Math.round(Number(ack.percent));
    return {
      ok: true, say: `壁纸音量调到 ${Number.isFinite(actual) ? actual : percent}% 了。`,
      verified: ack.verified !== false, data: { target, percent: Number.isFinite(actual) ? actual : percent },
    };
  }).catch(() => fail('壁纸音量没调成，再试一次。', { target, percent }));
}

async function performSing(args, deps) {
  if (args && args.accompaniment === true) {
    return fail('带伴奏/原唱我做不到：① 版权不让我内置流行歌伴奏；② 我只有合成音清唱。'
      + ' 想要的话我可以按原创旋律清唱，或者你打开音乐 App 放原唱、我陪你听。', {
      accompaniment: true, alternative: 'original-sing',
    });
  }
  if (typeof deps.performSing !== 'function') return fail('这个版本还没接通清唱。', {});
  let result;
  try { result = await deps.performSing(args || {}); } catch (error) {
    result = { ok: false, hint: String((error && error.message) || error).slice(0, 160) };
  }
  if (!result || result.ok !== true) {
    return fail((result && result.hint) || '这次没唱成（合成服务没就绪），再试一次。', { code: result && result.code });
  }
  return {
    ok: true,
    say: clip(result.say || '唱给你听：这首是清唱，没有伴奏。', 120),
    verified: true,
    data: { sing: result.sing },
  };
}

async function notifyTool(args, deps) {
  const title = clip(args.title || '桌宠', 40);
  const text = clip(args.text || '', 200);
  if (!text) return fail('要通知什么？给我一句话。', {});
  if (typeof deps.notify !== 'function') return fail('这个版本还没接通桌面通知。', {});
  let ack;
  try { ack = await deps.notify({ title, text }); } catch { ack = { ok: false, error: 'notify-failed' }; }
  if (!ack || ack.ok === false) return fail('通知没发出去。', { title, text, error: (ack && ack.error) || 'notify-failed' });
  return { ok: true, say: `通知发了：${clip(text, 40)}`, verified: ack.verified === true, data: { title, text, channel: ack.channel || '' } };
}

async function openUrl(args, deps) {
  const raw = String(args.url || '').trim();
  if (!raw) return fail('要打开哪个网页？给我一个链接。', {});
  const domains = Array.isArray(deps.openUrlDomains) && deps.openUrlDomains.length
    ? deps.openUrlDomains : ((deps.toolWhitelist && deps.toolWhitelist.domains) || readToolWhitelist().domains);
  const check = hostAllowed(raw, domains);
  if (!check.ok) {
    const why = check.reason === 'not-https'
      ? '只打开 https 链接（http 不开）。'
      : check.reason === 'not-whitelisted'
        ? `「${check.host || raw}」不在白名单里：先在设置里把它加进允许的域名。`
        : '这个链接格式不对。';
    return fail(why, { url: raw, reason: check.reason });
  }
  if (typeof deps.openUrl !== 'function') return fail('这个版本还没接通打开网页。', { url: raw });
  let ack;
  try { ack = await deps.openUrl(raw); } catch { ack = { ok: false, error: 'open-failed' }; }
  if (!ack || ack.ok === false) return fail('网页没打开。', { url: raw, error: (ack && ack.error) || 'open-failed' });
  return { ok: true, say: `用浏览器打开 ${check.host} 了。`, verified: ack.verified !== false, data: { url: raw, host: check.host } };
}

async function appLaunch(args, deps) {
  const raw = String(args.app || '').trim();
  if (!raw) return fail('要打开哪个应用？白名单里有记事本、计算器、画图、资源管理器、浏览器。', {});
  const whitelist = Array.isArray(deps.appWhitelist) && deps.appWhitelist.length
    ? deps.appWhitelist : ((deps.toolWhitelist && deps.toolWhitelist.apps) || readToolWhitelist().apps);
  const key = raw.toLowerCase();
  const hit = whitelist.find((item) => {
    const app = typeof item === 'string' ? { id: item, label: item } : item;
    return String(app.id).toLowerCase() === key || String(app.label).toLowerCase() === key
      || (app.aliases || []).some((alias) => String(alias).toLowerCase() === key);
  });
  const app = typeof hit === 'string' ? { id: hit, label: hit } : hit;
  if (!app) {
    return fail(`「${clip(raw, 20)}」不在白名单里：先在设置里加进允许的应用。`, { app: raw, reason: 'not-whitelisted' });
  }
  if (typeof deps.launchApp !== 'function') return fail('这个版本还没接通启动应用。', { app: app.id });
  let ack;
  try { ack = await deps.launchApp(app.id); } catch { ack = { ok: false, error: 'launch-failed' }; }
  if (!ack || ack.ok === false) return fail('应用没启动起来。', { app: app.id, error: (ack && ack.error) || 'launch-failed' });
  return { ok: true, say: `打开${app.label || app.id}了。`, verified: ack.verified !== false, data: { app: app.id, label: app.label || app.id } };
}

function docWrite(args, deps) {
  const raw = String(args.path || '').trim();
  const content = String(args.content == null ? '' : args.content);
  if (!raw) return fail('要写到哪个文件？给我一个相对路径，比如 notes/today.md。', {});
  if (!content) return fail('要写什么内容？', { path: raw });
  if (raw.includes('\u0000') || isAbsolute(raw) || raw.split(/[\\/]/).includes('..')) {
    return fail('只能写工作区里的相对路径。', { path: raw });
  }
  const ext = extname(raw).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) {
    return fail('只支持写文本文件（md/txt/json/js/ts/css/html/log/csv 等）。', { path: raw, ext });
  }
  if (Buffer.byteLength(content, 'utf8') > 512 * 1024) {
    return fail('内容太大了（上限 512KB）。', { path: raw, bytes: Buffer.byteLength(content, 'utf8') });
  }
  const root = resolve(String(deps.workspaceRoot || process.cwd()));
  const target = resolve(root, raw);
  if (target !== root && !target.startsWith(root + sep)) {
    return fail('只能写工作区里的文件。', { path: raw });
  }
  // 不可撤销动作：路由层已强制二次确认；这里再确认一次调用方确实拿到了确认。
  if (deps.confirmed !== true) {
    return {
      ok: false, say: confirmAsk('doc_write'), verified: false, needsConfirm: true,
      permission: 'ask', group: 'docs', data: { path: raw },
    };
  }
  let backup = '';
  const existed = existsSync(target);
  try {
    if (existed) {
      backup = target + '.bak-' + Date.now().toString(36);
      writeFileSync(backup, readFileSync(target));
    }
    mkdirSync(dirname(target), { recursive: true });
    if (args.append === true && existed) writeFileSync(target, content, { flag: 'a' });
    else writeFileSync(target, content, 'utf8');
  } catch (error) {
    return fail('文件没写进去（可能没有写权限）。', { path: raw, error: String((error && error.message) || error).slice(0, 160) });
  }
  let readBack = '';
  try { readBack = readFileSync(target, 'utf8'); } catch { readBack = ''; }
  const verified = args.append === true
    ? readBack.endsWith(content)
    : readBack === content;
  if (!verified) return fail('写完了但回读不一致，先别用这个文件。', { path: raw, backup });
  return {
    ok: true,
    say: clip(`写好了「${clip(raw, 40)}」（${[...content].length} 字）${backup ? '，原文件已备份' : ''}。`, 120),
    verified: true,
    data: { path: raw, bytes: Buffer.byteLength(content, 'utf8'), backup, created: !existed },
  };
}

async function clipboardGet(args, deps) {
  if (typeof deps.clipboardRead !== 'function') return fail('这个版本还没接通剪贴板。', {});
  let ack;
  try { ack = await deps.clipboardRead(); } catch { ack = { ok: false, error: 'clipboard-failed' }; }
  if (!ack || ack.ok === false) return fail('剪贴板读不出来。', { error: (ack && ack.error) || 'clipboard-failed' });
  const text = String(ack.text || '');
  if (!text) return { ok: true, say: '剪贴板是空的。', verified: true, data: { text: '', chars: 0 } };
  return {
    ok: true,
    say: clip(`剪贴板里是：${text.replace(/\s+/g, ' ').trim()}`, 120),
    verified: true,
    data: { text: clip(text, 4000), chars: [...text].length },
  };
}

async function clipboardSet(args, deps) {
  const text = String(args.text == null ? '' : args.text);
  if (!text) return fail('要往剪贴板放什么？', {});
  if (deps.confirmed !== true) {
    return {
      ok: false, say: confirmAsk('clipboard_set'), verified: false, needsConfirm: true,
      permission: 'ask', group: 'clipboard', data: { chars: [...text].length },
    };
  }
  if (typeof deps.clipboardWrite !== 'function') return fail('这个版本还没接通剪贴板。', {});
  let ack;
  try { ack = await deps.clipboardWrite(text); } catch { ack = { ok: false, error: 'clipboard-failed' }; }
  if (!ack || ack.ok === false) return fail('剪贴板写不进去。', { error: (ack && ack.error) || 'clipboard-failed' });
  return { ok: true, say: `已复制到剪贴板（${[...text].length} 字）。`, verified: ack.verified !== false, data: { chars: [...text].length } };
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
    return fail('这个版本没有删除文件/壁纸的工具，我没有动任何东西。想清理的话，告诉我改哪个文件或提醒我。', {}, false);
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
  if (toolName === 'perform_sing') return performSing(args, deps);
  if (toolName === 'perform_teach') return performTeach(args, deps);
  if (toolName === 'capability_list') return capabilityListTool(args, deps);
  if (toolName === 'capability_call') return capabilityCallTool(args, deps);
  if (toolName === 'task_plan') return { ok: true, say: '把目标拆成计划的请求由对话层处理。', verified: false, data: {} };
  if (toolName === 'task_run') return { ok: true, say: '执行计划由对话层处理。', verified: false, data: {} };
  if (toolName === 'wallpaper_cycle') return wallpaperCycle(args, deps);
  if (toolName === 'pet_toggle') return petToggle(args);
  if (toolName === 'pet_scale') return petScale(args);
  if (toolName === 'pet_volume') return petVolume(args);
  if (toolName === 'volume_set') return volumeSet(args, deps);
  if (toolName === 'tts_toggle') return ttsToggle(args, deps);
  if (toolName === 'reminder_create') return reminderCreate(args);
  if (toolName === 'reminder_list') return reminderList();
  if (toolName === 'media_control') return mediaControl(args, deps);
  if (toolName === 'status_query') return statusQuery(args, deps);
  if (toolName === 'doc_read') return docRead(args, deps);
  if (toolName === 'doc_write') return docWrite(args, deps);
  if (toolName === 'notify') return notifyTool(args, deps);
  if (toolName === 'open_url') return openUrl(args, deps);
  if (toolName === 'app_launch') return appLaunch(args, deps);
  if (toolName === 'clipboard_get') return clipboardGet(args, deps);
  if (toolName === 'clipboard_set') return clipboardSet(args, deps);
  if (toolName === 'search_query') return searchQuery(args, deps);
  if (toolName === 'memory_note') return fail('记忆由当前人设的事件流管理，请在人设页查看。', {}, false);
  if (toolName === 'memory_clear') return fail('清空记忆请到「人设 → 记忆」页操作。', {}, false);
  if (toolName === 'reminder_clear') return reminderClear();
  if (toolName === 'skin_uninstall') return skinUninstall(args, deps);
  return fail('这个我还不会。', { tool: toolName });
}
