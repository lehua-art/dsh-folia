#!/usr/bin/env node
/**
 * check-site-contract.mjs — **站点 API 契约体检**（只读，不改任何数据）。
 *
 * 站点正在从「旧公开清单」升级到「v1 + 新元数据」。插件两侧都吃：
 * 升级前只读 `/api/public/*`，升级后还要读 v1、`fps/codec/hasAudio/posterUrl/license/source`
 * 以及 `variants[]` 上的 `width/fps`。升级窗口里最容易出的事**不是 500，而是字段悄悄变了**：
 * url 换了域、sha256 没了、variants 顺序反了、facets 计数对不上 —— 这些都不会报错，
 * 只会在用户点下载时变成「播不出来」或「同一份内容重复下几十 MB」。
 *
 * 所以这一页只做一件事：**把契约逐条验一遍，并说清哪一条不成立**。
 *
 * ## 只读保证
 * 全程只有 GET：不登录、不写库、不 PUT/POST；除 `--json <file>` 指定的结果文件外不落盘。
 *
 * ## 用法
 *   node scripts/check-site-contract.mjs
 *   node scripts/check-site-contract.mjs --base https://folia-5ve.pages.dev --limit 100
 *   node scripts/check-site-contract.mjs --samples 3 --json out.json
 *   node scripts/check-site-contract.mjs --watch-v1     # 部署期间等 v1 出现再体检
 *
 * ## 检查项（a–g）
 *   a 端点可达性          旧 4 条 + v1 2 条；不存在 ⇒ v1 WARN / 旧路径 FAIL
 *   b 旧路径 vs v1        同一批条目按 id 匹配，逐字段比较（slug/kind/category/url/bytes/
 *                         sha256/width/height/durationMs/thumbUrl/variants/tags）；
 *                         差异会**复测一次**，能复现才算 FAIL（排除回填/切部署的写入竞态）
 *   c 必填字段非空率       id/slug/kind/category.slug/url/bytes/width/height/thumbUrl
 *   d 新元数据字段         fps/codec/hasAudio/posterUrl/license/source + variants 的 width/label/fps
 *                         （fps/codec/hasAudio/posterUrl 只对音视频适用；zip 资源包不适用，不计缺失）
 *   e 变体一致性           url/bytes/sha256/label/height 必填；有 width/fps 就一并查
 *   f 内容抽样校验         随机取主对象与一个变体，真下载、算 sha256 与 API 值比对
 *   g facets 一致性        sum(facets.categories.count) 与 total 的差额（允许「未分类」解释）
 *
 * ## 判定口径（写死在这里，避免"看结果挑结论"）
 *   · 2xx 且能解析 JSON                     → PASS
 *   · 端点不存在（404/410）                  → 旧路径 FAIL / v1 WARN（站点还没上线）
 *   · 401/403                               → 旧路径 FAIL（插件拿不到清单）/ v1 WARN（门禁未放行）
 *   · 200 但返回 HTML / 非 JSON              → FAIL（`docs/SITE-FIX-SPEC.md` 记过这种"假 200"）
 *   · 5xx / 网络失败（重试 2 次后）           → FAIL
 *   · 新字段整体缺席                          → WARN（站点尚未上线该字段，不算契约破坏）
 *   · width/height 在 zip 资源包上为 null      → **不适用**，不计缺失（见 fieldApplicable）
 *
 * ## 认证（可选，绝不打印）
 * 站点门禁可能连 v1 一起拦。若要在放行**之前**先验 v1，可以给一枚管理员会话 Cookie：
 *   FOLIA_COOKIE="<cookie>" node scripts/check-site-contract.mjs
 * 它只进请求头：不落盘、不打印、不进 `--json`（结果里只记 `auth: true/false`）。
 *
 * ## 退出码
 *   0 = 没有 FAIL（只有 WARN 也是 0）  1 = 至少一条 FAIL（或 --watch-v1 超时）
 *   2 = 用法错误 / 脚本自身出错
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const SCHEMA_ID = 'folia-site-contract/1';
const DEFAULT_BASE = 'https://folia-5ve.pages.dev';
/** 站点 `limit` 上限是 100（见 `folia-admin/tests/api-cache-limit.test.js`），再大就得按 page 翻。 */
const MAX_PAGE_SIZE = 100;
const JSON_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 180000;
const RETRIES = 2;
const MAX_PAGES = 20;
/** 明细里最多列多少条差异（全量在 --json 里）。 */
const DIFF_LIMIT = 40;

const USAGE = [
  '用法：',
  '  node scripts/check-site-contract.mjs [--base <url>] [--limit <n>] [--json [file]]',
  '                                       [--samples <n>] [--max-sample-mb <n>] [--seed <n>]',
  '                                       [--watch-v1] [--watch-interval <s>] [--watch-timeout <min>]',
  '',
  '  --base              站点根地址（默认 ' + DEFAULT_BASE + '）',
  '  --limit             每侧取样条目上限（默认 100；超过 100 会自动翻页）',
  '  --json [file]       输出结构化结果；带 file 时写文件并照常打印人类可读表格',
  '  --samples           内容抽样条数（默认 3；0 = 不下载）',
  '  --max-sample-mb     单个文件抽样上限（默认 64 MB，超限跳过并注明）',
  '  --seed              抽样随机种子（默认取当前时间；输出里会打印，便于复现）',
  '  --watch-v1          轮询等 v1 上线（默认每 30s、最多 30 分钟），出现后再体检',
  '  --watch-interval    --watch-v1 的轮询间隔秒数（默认 30）',
  '  --watch-timeout     --watch-v1 的最长等待分钟数（默认 30）',
  '  --help              显示本帮助',
].join('\n');

// ── 1. 命令行 ──────────────────────────────────────────────────────────────

const OPT = {
  base: DEFAULT_BASE,
  limit: 100,
  samples: 3,
  maxSampleMb: 64,
  seed: 0,
  jsonPath: '',
  jsonOnly: false,
  watchV1: false,
  watchInterval: 30,
  watchTimeout: 30,
  help: false,
};

function usageError(message) {
  process.stderr.write('参数错误：' + message + '\n\n' + USAGE + '\n');
  process.exit(2);
}

function needValue(argv, index, name) {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) usageError(name + ' 需要一个取值');
  return next;
}

function intArg(name, raw, min, max) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    usageError(name + ' 需要 ' + min + '..' + max + ' 之间的整数，收到「' + raw + '」');
  }
  return value;
}

/**
 * 归一化站点根地址：允许省略 scheme，去掉尾部斜杠，保留可能存在的路径前缀。
 * @param {string} raw
 * @returns {string}
 */
function normalizeBase(raw) {
  const text = String(raw || '').trim();
  if (!text) usageError('--base 不能为空');
  const withScheme = /^https?:\/\//i.test(text) ? text : 'https://' + text;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    usageError('--base 不是合法 URL：「' + raw + '」');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') usageError('--base 只支持 http(s)：' + raw);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function parseArgs(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name === '--help' || name === '-h') OPT.help = true;
    else if (name === '--base') { OPT.base = needValue(argv, i, name); i += 1; }
    else if (name === '--limit') { OPT.limit = intArg(name, needValue(argv, i, name), 1, 5000); i += 1; }
    else if (name === '--samples') { OPT.samples = intArg(name, needValue(argv, i, name), 0, 50); i += 1; }
    else if (name === '--max-sample-mb') { OPT.maxSampleMb = intArg(name, needValue(argv, i, name), 1, 4096); i += 1; }
    else if (name === '--seed') { OPT.seed = intArg(name, needValue(argv, i, name), 0, 4294967295); i += 1; }
    else if (name === '--watch-interval') { OPT.watchInterval = intArg(name, needValue(argv, i, name), 1, 3600); i += 1; }
    else if (name === '--watch-timeout') { OPT.watchTimeout = intArg(name, needValue(argv, i, name), 1, 1440); i += 1; }
    else if (name === '--watch-v1') OPT.watchV1 = true;
    else if (name === '--json') {
      // `--json` 可带一个路径（`--json out.json`），不带就是只输出 JSON
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { OPT.jsonPath = next; i += 1; } else OPT.jsonOnly = true;
    } else usageError('未知参数「' + name + '」');
  }
}

// ── 2. 基础工具 ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 重试退避：600ms、1200ms……各带 ±20% 抖动，避免同一秒内对同一路径打满。 */
function backoffMs(attempt) {
  const base = 600 * 2 ** (attempt - 1);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function describeError(error) {
  if (!error) return '未知错误';
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时';
  const name = error.name ? String(error.name) : 'Error';
  return name + ': ' + String(error.message || error);
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB';
  return (n / 1073741824).toFixed(2) + 'GB';
}

function fmtSec(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}

function fmtRate(bytes, ms) {
  if (!Number.isFinite(bytes) || !Number.isFinite(ms) || ms <= 0) return '?';
  return (bytes / 1048576 / (ms / 1000)).toFixed(1) + 'MB/s';
}

/** 中英文混排的显示宽度（全角算 2）。表格对齐靠它，`padEnd` 对 CJK 会错位。 */
const WIDE_CHAR_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

function textWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return width;
}

function padDisplay(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - textWidth(value)));
}

function wrapDisplay(text, width) {
  const source = String(text);
  if (!source) return [''];
  const lines = [];
  let current = '';
  let currentWidth = 0;
  for (const ch of source) {
    const w = WIDE_CHAR_RE.test(ch) ? 2 : 1;
    if (currentWidth + w > width && current) {
      lines.push(current);
      current = '';
      currentWidth = 0;
    }
    current += ch;
    currentWidth += w;
  }
  if (current) lines.push(current);
  return lines;
}

/** 可复现的伪随机（mulberry32）：`--seed` 相同 ⇒ 抽样集合相同。 */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ── 3. HTTP（GET + 重试 + 退避；401/403 语义集中在这里）───────────────────────

/** 只从环境变量取，且**从不回显**（不进日志、不进 --json）。 */
const AUTH_HEADERS = (() => {
  const cookie = String(process.env.FOLIA_COOKIE || '').trim();
  return cookie ? { cookie } : {};
})();

async function request(url, options = {}) {
  const timeoutMs = options.timeoutMs || JSON_TIMEOUT_MS;
  const attempts = options.attempts === undefined ? RETRIES : options.attempts;
  const headers = { accept: '*/*', 'user-agent': 'dsh-folia-contract-check', ...AUTH_HEADERS, ...(options.headers || {}) };
  let lastError = new Error('request-failed');
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // 5xx 才重试；4xx 是确定性的（重试只会把 401 变成更慢的 401）
      if (res.status >= 500 && attempt < attempts) {
        await res.arrayBuffer().catch(() => {});
        lastError = new Error('HTTP ' + res.status);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError;
}

async function getJson(origin, path, options = {}) {
  const url = /^https?:\/\//i.test(path) ? path : origin + path;
  const started = Date.now();
  try {
    const res = await request(url, { timeoutMs: options.timeoutMs || JSON_TIMEOUT_MS });
    const text = await res.text();
    let doc = null;
    let parseError = '';
    if (text) {
      try {
        doc = JSON.parse(text);
      } catch (error) {
        parseError = describeError(error);
      }
    }
    return { ok: res.ok, status: res.status, ms: Date.now() - started, url, text, doc, parseError };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, url, text: '', doc: null, parseError: '', networkError: describeError(error) };
  }
}

function errorCode(doc) {
  const code = doc && doc.error && typeof doc.error === 'object' ? doc.error.code : doc && doc.code;
  return typeof code === 'string' && code.trim() ? code.trim() : '';
}

/** 401/403 一律明确说「该端点需要登录」，并带上站点自己的错误码。 */
function httpReason(res) {
  const code = errorCode(res.doc);
  if (res.status === 401 || res.status === 403) {
    return 'HTTP ' + res.status + ' 该端点需要登录' + (code ? '（' + code + '）' : '');
  }
  if (res.status === 404 || res.status === 410) return 'HTTP ' + res.status + ' 端点不存在';
  return 'HTTP ' + res.status;
}

function describeHttp(res) {
  if (res.networkError) return '网络失败（已重试 ' + RETRIES + ' 次）：' + res.networkError;
  return httpReason(res);
}

// ── 4. 响应形状归一（v1 的长相是站点说了算，这里只做保守探测）─────────────────

/**
 * 从响应里取出 `{ items, total, facets }`。
 * 兼容 `data.items`（现状）、裸数组、`manifest.json` 的顶层 `items`、
 * 以及 v1 可能换的名字（wallpapers/entries/list/catalog）。
 * @returns {{ items: any[], total: number|null, facets: any|null }}
 */
function extractView(doc) {
  let node = doc;
  if (node && typeof node === 'object' && !Array.isArray(node) && node.data !== undefined) node = node.data;
  let items = [];
  if (Array.isArray(node)) items = node;
  else if (node && typeof node === 'object') {
    for (const key of ['items', 'wallpapers', 'entries', 'list', 'catalog']) {
      if (Array.isArray(node[key])) { items = node[key]; break; }
    }
  }
  let total = null;
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const key of ['total', 'totalCount', 'count']) {
      const value = Number(node[key]);
      if (Number.isFinite(value)) { total = value; break; }
    }
    if (total === null && node.meta && typeof node.meta === 'object') {
      const value = Number(node.meta.total);
      if (Number.isFinite(value)) total = value;
    }
  }
  const facets = node && typeof node === 'object' && node.facets && typeof node.facets === 'object' ? node.facets : null;
  return { items, total, facets };
}

function itemId(item) {
  const id = item && item.id;
  return id == null ? '' : String(id).trim();
}

function shapeNote(doc) {
  const view = extractView(doc);
  if (view.items.length) return 'items=' + view.items.length + (view.total == null ? '' : ' total=' + view.total);
  const node = doc && typeof doc === 'object' ? doc : null;
  const payload = node && node.data && typeof node.data === 'object' ? node.data : node;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const keys = Object.keys(payload).slice(0, 6).join(',');
    return keys ? 'keys=' + keys : 'JSON';
  }
  return 'JSON';
}

function withParams(path, params) {
  const url = new URL(path, 'https://placeholder.invalid');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.pathname + url.search;
}

/**
 * 拉一页或多页清单（站点单页上限 100，`--limit` 更大时按 page 翻）。
 * @returns {Promise<{ ok: boolean, status: number, reason: string, errorCode: string, items: any[], total: number|null, facets: any|null, pages: number, ms: number }>}
 */
async function fetchDataset(origin, path, limit) {
  const started = Date.now();
  const items = [];
  const seen = new Set();
  let total = null;
  let facets = null;
  let pages = 0;
  let status = 0;
  const fail = (reason, code) => ({
    ok: false, status, reason, errorCode: code || '', items, total, facets, pages, ms: Date.now() - started,
  });

  while (items.length < limit && pages < MAX_PAGES) {
    pages += 1;
    const pageSize = Math.min(MAX_PAGE_SIZE, limit);
    const res = await getJson(origin, withParams(path, { limit: pageSize, page: pages }));
    status = res.status || status;
    if (res.networkError) return fail(describeHttp(res));
    if (!res.ok) return fail(describeHttp(res), errorCode(res.doc));
    if (!res.doc) return fail('HTTP 200 但返回的不是 JSON（' + (res.parseError || '空响应') + '）');

    const view = extractView(res.doc);
    if (pages === 1) {
      total = view.total;
      facets = view.facets;
    }
    if (!view.items.length) break;

    let added = 0;
    for (const item of view.items) {
      const id = itemId(item);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      items.push(item);
      added += 1;
      if (items.length >= limit) break;
    }
    if (!added) break; // 站点忽略了 page：别死循环
    if (view.items.length < pageSize) break;
    if (total !== null && items.length >= total) break;
  }

  return { ok: true, status, reason: '', errorCode: '', items, total, facets, pages, ms: Date.now() - started };
}

function describeDataset(dataset) {
  if (!dataset.ok) return dataset.reason || '不可用';
  const total = dataset.total == null ? '' : ' / total=' + dataset.total;
  return dataset.items.length + ' 条' + total + '（' + dataset.pages + ' 页，' + fmtSec(dataset.ms) + '）';
}

// ── 5. 检查项 ──────────────────────────────────────────────────────────────

const STATUS_RANK = { PASS: 0, WARN: 1, FAIL: 2 };

function worse(a, b) {
  return STATUS_RANK[b] > STATUS_RANK[a] ? b : a;
}

function makeCheck(id, name, status, detail, data) {
  return { id, name, status, detail: detail.filter((line) => line != null && line !== ''), data: data == null ? null : data };
}

const ENDPOINTS = [
  { path: '/api/public/wallpapers', probe: '/api/public/wallpapers?limit=1', required: true },
  { path: '/api/public/categories', probe: '/api/public/categories', required: true },
  { path: '/api/public/tags', probe: '/api/public/tags', required: true },
  { path: '/api/public/subtags', probe: '/api/public/subtags', required: true },
  { path: '/api/v1/public/wallpapers', probe: '/api/v1/public/wallpapers?limit=1', required: false },
  { path: '/api/v1/public/manifest.json', probe: '/api/v1/public/manifest.json', required: false },
];

/**
 * 单条端点的判定。旧路径是插件的**现役依赖**，不存在/要登录都算 FAIL；
 * v1 还没上线是预期的，所以同样的状态只 WARN。
 * @returns {{ status: 'PASS'|'WARN'|'FAIL', text: string, hint: string }}
 */
function classifyEndpoint(res, endpoint) {
  const absent = endpoint.required ? 'FAIL' : 'WARN';
  if (res.networkError) return { status: 'FAIL', text: describeHttp(res), hint: '' };
  if (res.status === 404 || res.status === 410) {
    return {
      status: absent,
      text: 'HTTP ' + res.status + ' 端点不存在' + (endpoint.required ? '（插件的只读清单不可用）' : '（站点尚未上线）'),
      hint: '',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      status: absent,
      text: httpReason(res) + (endpoint.required ? '：插件只读清单拿不到数据' : '：站点门禁尚未放行该路径（部署期间属预期）'),
      hint: endpoint.required ? '' : 'v1 放行前可带 FOLIA_COOKIE 先验内容；放行后重跑本脚本',
    };
  }
  if (!res.ok) return { status: 'FAIL', text: httpReason(res), hint: '' };
  if (!res.doc) {
    return { status: 'FAIL', text: 'HTTP 200 但返回的不是 JSON（' + (res.parseError || '空响应') + '）', hint: '可能是错误页套了 200' };
  }
  return { status: 'PASS', text: 'HTTP 200  ' + fmtSec(res.ms) + '  ' + shapeNote(res.doc), hint: '' };
}

async function checkEndpoints(origin) {
  const lines = [];
  const rows = [];
  const hints = new Set();
  let status = 'PASS';
  for (const endpoint of ENDPOINTS) {
    const res = await getJson(origin, endpoint.probe);
    const verdict = classifyEndpoint(res, endpoint);
    status = worse(status, verdict.status);
    if (verdict.hint) hints.add(verdict.hint);
    rows.push({ path: endpoint.path, required: endpoint.required, status: res.status, ms: res.ms, verdict: verdict.status, errorCode: errorCode(res.doc) });
    lines.push(endpoint.path + ' → ' + verdict.text);
  }
  for (const hint of hints) lines.push('提示：' + hint);
  return makeCheck('a', '端点可达性', status, lines, { endpoints: rows });
}

// —— 归一化：比较前先把「空」统一成 '', 把「数字」统一成 number ——

function normText(value) {
  return value == null ? '' : String(value).trim();
}

function normNumber(value) {
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : String(value);
}

function normHash(value) {
  return normText(value).toLowerCase();
}

function normTags(value) {
  const list = Array.isArray(value) ? value : [];
  return JSON.stringify(list.map(normText).sort());
}

/**
 * variants 的归一化。
 *
 * 比较口径：**以旧路径已经声明的字段为准**。v1 给变体补 `width/fps` 是升级要干的事，
 * 不该被判成"旧 vs v1 不一致"（它们由 d/e 单独检查）；只有两边都声明了的字段才逐值比。
 * 顺序按「多重集」比较：契约另有「按 bytes 升序」的检查，排序本身不在这里判。
 *
 * @param {boolean} compareWidth 旧路径的变体是否声明了 width
 * @param {boolean} compareFps 旧路径的变体是否声明了 fps
 */
function makeVariantsNorm(compareWidth, compareFps) {
  return (value) => {
    const list = Array.isArray(value) ? value : [];
    const rows = list.map((item) => {
      const row = [
        normText(item && item.url),
        normNumber(item && item.bytes),
        normHash(item && item.sha256),
        normText(item && item.label),
        normNumber(item && item.height),
      ];
      if (compareWidth) row.push(normNumber(item && item.width));
      if (compareFps) row.push(normNumber(item && item.fps));
      return row;
    });
    rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify(rows);
  };
}

function shortValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 90 ? text.slice(0, 87) + '…' : text;
}

const PARITY_FIELDS = [
  { key: 'slug', read: (item) => item && item.slug, norm: normText },
  { key: 'kind', read: (item) => item && item.kind, norm: normText },
  {
    key: 'category.slug',
    read: (item) => (item && item.category && typeof item.category === 'object' ? item.category.slug : item && item.category),
    norm: normText,
  },
  { key: 'url', read: (item) => item && item.url, norm: normText },
  { key: 'bytes', read: (item) => item && item.bytes, norm: normNumber },
  { key: 'sha256', read: (item) => item && item.sha256, norm: normHash },
  { key: 'width', read: (item) => item && item.width, norm: normNumber },
  { key: 'height', read: (item) => item && item.height, norm: normNumber },
  { key: 'durationMs', read: (item) => item && item.durationMs, norm: normNumber },
  { key: 'thumbUrl', read: (item) => item && item.thumbUrl, norm: normText },
  { key: 'variants', read: (item) => item && item.variants, norm: makeVariantsNorm(false, false) },
  { key: 'tags', read: (item) => item && item.tags, norm: normTags },
];

/** 旧路径的变体声明了哪些字段 —— 决定 variants 比对要不要把 width/fps 算进去。 */
function parityFieldsFor(oldSet) {
  let width = false;
  let fps = false;
  for (const item of oldSet.items) {
    for (const variant of variantsOf(item)) {
      if (Object.prototype.hasOwnProperty.call(variant, 'width')) width = true;
      if (Object.prototype.hasOwnProperty.call(variant, 'fps')) fps = true;
    }
  }
  if (!width && !fps) return PARITY_FIELDS;
  return PARITY_FIELDS.map((field) => (
    field.key === 'variants' ? { ...field, norm: makeVariantsNorm(width, fps) } : field
  ));
}

/**
 * 差异复测：把两侧清单各重新拉一次，只重算**有差异的那几项**。
 *
 * 为什么必须有这一步：站点回填 `width/fps` 或切换部署时，两次请求相隔 0.5 秒就可能
 * 读到不同版本 —— 那会在逐字段比对里造出「假差异」，把一次成功的升级判成契约破坏。
 * 判据因此收紧成「**能复现的差异才算破坏**」；复测失败（网络/门禁）则保守地按破坏处理。
 */
async function recheckDiffs(diffs, fields, origin, limit) {
  const [oldAgain, v1Again] = await Promise.all([
    fetchDataset(origin, '/api/public/wallpapers', limit),
    fetchDataset(origin, '/api/v1/public/wallpapers', limit),
  ]);
  if (!oldAgain.ok || !v1Again.ok) {
    return { unavailable: true, reason: describeDataset(!oldAgain.ok ? oldAgain : v1Again), transient: [], persisted: diffs };
  }
  const oldMap = new Map();
  for (const item of oldAgain.items) {
    const key = itemId(item);
    if (key) oldMap.set(key, item);
  }
  const v1Map = new Map();
  for (const item of v1Again.items) {
    const key = itemId(item);
    if (key) v1Map.set(key, item);
  }
  const transient = [];
  const persisted = [];
  for (const diff of diffs) {
    const left = oldMap.get(diff.id);
    const right = v1Map.get(diff.id);
    const field = fields.find((candidate) => candidate.key === diff.field);
    if (!left || !right || !field) { persisted.push(diff); continue; }
    if (field.norm(field.read(left)) === field.norm(field.read(right))) transient.push(diff);
    else persisted.push(diff);
  }
  return { unavailable: false, reason: '', transient, persisted };
}

async function checkParity(oldSet, v1Set, origin, limit) {
  const id = 'b';
  const name = '旧路径 vs v1 逐字段一致';
  if (!oldSet.ok) return makeCheck(id, name, 'WARN', ['旧清单不可用（' + describeDataset(oldSet) + '），无法比对'], { skipped: true });

  const v1Lines = [
    '旧路径：' + describeDataset(oldSet),
    'v1：' + describeDataset(v1Set),
  ];
  if (!v1Set.ok) {
    v1Lines.push('→ 逐字段比对未执行（v1 未上线时属预期）');
    v1Lines.push('→ v1 上线后重跑；若只是门禁拦，可带 FOLIA_COOKIE 或 --watch-v1');
    return makeCheck(id, name, 'WARN', v1Lines, { skipped: true, reason: v1Set.reason });
  }

  const oldById = new Map();
  for (const item of oldSet.items) {
    const key = itemId(item);
    if (key) oldById.set(key, item);
  }
  const v1ById = new Map();
  for (const item of v1Set.items) {
    const key = itemId(item);
    if (key) v1ById.set(key, item);
  }

  const matched = [...oldById.keys()].filter((key) => v1ById.has(key));
  const onlyOld = [...oldById.keys()].filter((key) => !v1ById.has(key));
  const onlyV1 = [...v1ById.keys()].filter((key) => !oldById.has(key));

  const diffs = [];
  const fields = parityFieldsFor(oldSet);
  for (const key of matched) {
    const left = oldById.get(key);
    const right = v1ById.get(key);
    for (const field of fields) {
      const before = field.norm(field.read(left));
      const after = field.norm(field.read(right));
      if (before === after) continue;
      diffs.push({ id: key, field: field.key, old: shortValue(before), v1: shortValue(after) });
    }
  }

  let status = 'PASS';
  const lines = v1Lines.slice();
  lines.push('按 id 匹配 ' + matched.length + ' 条（旧 ' + oldSet.items.length + ' / v1 ' + v1Set.items.length + '）');

  let recheck = null;
  if (!matched.length) {
    status = 'FAIL';
    lines.push('FAIL：按 id 匹配不到任何条目 —— 两侧清单不是同一批数据（sort/过滤/分页语义变了？）');
  } else if (diffs.length) {
    status = 'FAIL';
    lines.push('字段差异 ' + diffs.length + ' 处：');
    for (const diff of diffs.slice(0, DIFF_LIMIT)) {
      lines.push('  · ' + diff.id + ' · ' + diff.field + '：旧=' + diff.old + ' / v1=' + diff.v1);
    }
    if (diffs.length > DIFF_LIMIT) lines.push('  · …另有 ' + (diffs.length - DIFF_LIMIT) + ' 处，见 --json');
    recheck = await recheckDiffs(diffs, fields, origin, limit);
    if (recheck.unavailable) {
      lines.push('→ 复测失败（' + recheck.reason + '），无法排除写入竞态 ⇒ 按契约破坏处理');
    } else {
      lines.push('→ 复测：瞬时 ' + recheck.transient.length + ' 处 / 仍然不一致 ' + recheck.persisted.length + ' 处');
      if (!recheck.persisted.length) {
        status = 'WARN';
        lines.push('→ 差异复测后消失（部署/回填正在写入的竞态），不算契约破坏；稳定后重跑应转 PASS');
      }
    }
  } else {
    lines.push(fields.length + ' 个字段逐条一致');
  }

  if (onlyOld.length || onlyV1.length) {
    status = worse(status, 'WARN');
    lines.push('只在一侧出现：旧 ' + onlyOld.length + ' 条 / v1 ' + onlyV1.length + ' 条' + sampleIds(onlyOld.length ? onlyOld : onlyV1));
  }
  if (oldSet.total != null && v1Set.total != null && oldSet.total !== v1Set.total) {
    status = worse(status, 'WARN');
    lines.push('total 不一致：旧=' + oldSet.total + ' / v1=' + v1Set.total);
  }

  return makeCheck(id, name, status, lines, {
    matched: matched.length,
    diffs,
    recheck: recheck
      ? { unavailable: Boolean(recheck.unavailable), transient: recheck.transient, persisted: recheck.persisted }
      : null,
    onlyOld,
    onlyV1,
    totals: { old: oldSet.total, v1: v1Set.total },
  });
}

function sampleIds(ids) {
  if (!ids.length) return '';
  const head = ids.slice(0, 5).join(', ');
  return '（如 ' + head + (ids.length > 5 ? ' …' : '') + '）';
}

/** 非空判定：null/undefined/空串/非有限数/≤0 的数字都算空（bytes、宽高为 0 是坏数据）。 */
function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  return true;
}

/** 只有音视频/图片才有像素尺寸；zip / 皮肤包这类资源包宽高本来就不存在（不是缺字段）。 */
function fieldApplicable(item) {
  const mime = normText(item && item.mime).toLowerCase();
  if (mime) return mime.startsWith('video/') || mime.startsWith('image/') || mime.startsWith('audio/');
  return normText(item && item.kind) === 'dynamic';
}

/** 只有音视频才有帧率/编码/音轨/首帧海报；图片与 zip 资源包本来就没有这些字段。 */
function avApplicable(item) {
  const mime = normText(item && item.mime).toLowerCase();
  if (mime) return mime.startsWith('video/') || mime.startsWith('audio/');
  return normText(item && item.kind) === 'dynamic';
}

const REQUIRED_FIELDS = [
  { key: 'id', read: (item) => item && item.id },
  { key: 'slug', read: (item) => item && item.slug },
  { key: 'kind', read: (item) => item && item.kind },
  {
    key: 'category.slug',
    read: (item) => (item && item.category && typeof item.category === 'object' ? item.category.slug : item && item.category),
  },
  { key: 'url', read: (item) => item && item.url },
  { key: 'bytes', read: (item) => item && item.bytes },
  { key: 'width', read: (item) => item && item.width, applicable: fieldApplicable },
  { key: 'height', read: (item) => item && item.height, applicable: fieldApplicable },
  { key: 'thumbUrl', read: (item) => item && item.thumbUrl },
];

function coverageOf(dataset, field) {
  const applicable = field.applicable ? dataset.items.filter(field.applicable) : dataset.items;
  const missing = applicable.filter((item) => !isFilled(field.read(item)));
  const filled = applicable.length - missing.length;
  return {
    key: field.key,
    total: dataset.items.length,
    applicable: applicable.length,
    filled,
    missing: missing.map(itemId).filter(Boolean).slice(0, 8),
    missingCount: missing.length,
  };
}

function coverageLine(stat) {
  const pct = stat.applicable ? ((stat.filled / stat.applicable) * 100).toFixed(1) : '0.0';
  const rate = stat.filled + '/' + stat.applicable + ' ' + pct + '%';
  const skipped = stat.applicable < stat.total ? '（全量 ' + stat.filled + '/' + stat.total + '；' + (stat.total - stat.applicable) + ' 条不适用）' : '';
  const missing = stat.missingCount ? '  缺失：' + stat.missing.slice(0, 5).join(', ') + (stat.missingCount > 5 ? ' …共 ' + stat.missingCount + ' 条' : '') : '';
  return padDisplay(stat.key, 14) + padDisplay(rate, 16) + skipped + missing;
}

function checkRequired(oldSet, v1Set) {
  const id = 'c';
  const name = '必填字段非空率';
  const sets = [];
  if (oldSet.ok) sets.push({ label: '旧路径', set: oldSet });
  if (v1Set.ok) sets.push({ label: 'v1', set: v1Set });
  if (!sets.length) return makeCheck(id, name, 'WARN', ['两侧清单都拿不到，跳过（' + describeDataset(oldSet) + '）'], { skipped: true });

  const lines = [];
  let status = 'PASS';
  const data = {};
  for (const { label, set } of sets) {
    lines.push('▸ ' + label + '（' + set.items.length + ' 条）');
    const stats = [];
    for (const field of REQUIRED_FIELDS) {
      const stat = coverageOf(set, field);
      stats.push(stat);
      lines.push('  ' + coverageLine(stat));
      if (stat.missingCount > 0) {
        status = 'FAIL';
        lines.push('    ↳ ' + field.key + ' 在适用条目上出现空值，属契约破坏');
      }
    }
    data[label] = stats;
    if (set.total != null && set.items.length < set.total) {
      lines.push('  注：只取了 ' + set.items.length + '/' + set.total + ' 条（加大 --limit 可全量）');
    }
  }
  return makeCheck(id, name, status, lines, data);
}

/**
 * 新元数据字段。`applicable` 的含义是「这条数据本来该不该有这个字段」：
 * 把「不适用」算进分母，会把升级后的站点误判成残缺 —— 49 条视频有 fps、61 条 zip 没有，
 * 不是覆盖 44.5%，而是适用面 100%。缺在视频上才算真缺口。
 */
const NEW_FIELDS = [
  { key: 'fps', applicable: avApplicable },
  { key: 'codec', applicable: avApplicable },
  { key: 'hasAudio', applicable: avApplicable },
  { key: 'posterUrl', applicable: avApplicable },
  { key: 'license' },
  { key: 'source' },
];

/** 字段「存在且有值」：false / 0 是合法值（hasAudio:false 不是缺失）。 */
function isPresent(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function checkNewMetadata(dataset) {
  const id = 'd';
  const name = '新元数据字段';
  if (!dataset.ok) return makeCheck(id, name, 'WARN', ['清单不可用（' + describeDataset(dataset) + '），跳过后置检查'], { skipped: true });

  const items = dataset.items;
  const lines = [];
  let status = 'PASS';
  const fields = {};
  const absent = [];

  for (const field of NEW_FIELDS) {
    const applicable = field.applicable ? items.filter(field.applicable) : items;
    const present = applicable.filter((item) => isPresent(item && item[field.key])).length;
    fields[field.key] = { present, applicable: applicable.length, total: items.length };
    const pct = applicable.length ? ((present / applicable.length) * 100).toFixed(1) : '0.0';
    const rate = present + '/' + applicable.length + ' ' + pct + '%';
    const skipped = applicable.length < items.length
      ? '（全量 ' + present + '/' + items.length + '；' + (items.length - applicable.length) + ' 条不适用）'
      : '';
    let note = '';
    if (!present) { note = '站点尚未上线该字段'; absent.push(field.key); }
    else if (present < applicable.length) { note = '部分缺失（' + (applicable.length - present) + ' 条）'; }
    const tail = [skipped, note].filter(Boolean).join('  ');
    lines.push(padDisplay(field.key, 14) + padDisplay(rate, 17) + tail);
  }

  const variants = items.flatMap((item) => (Array.isArray(item && item.variants) ? item.variants : []));
  const variantMeta = {};
  if (variants.length) {
    const parts = [];
    for (const key of ['label', 'width', 'fps']) {
      const present = variants.filter((variant) => isPresent(variant && variant[key])).length;
      variantMeta[key] = { present, total: variants.length };
      if (!present) { parts.push(key + ' 0/' + variants.length + '（未上线）'); absent.push('variants.' + key); }
      else if (present < variants.length) { parts.push(key + ' ' + present + '/' + variants.length + '（部分缺失）'); }
      else parts.push(key + ' ' + present + '/' + variants.length);
    }
    lines.push('▸ variants 元数据：' + parts.join(' · '));
  } else {
    lines.push('▸ variants：站点暂无变体，子字段检查跳过');
  }

  if (absent.length) {
    status = 'WARN';
    lines.push('→ ' + absent.length + ' 项缺失，均为「站点尚未上线该字段」，不算契约破坏（升级后应逐项转 PASS）');
  }
  const partial = Object.entries(fields).filter(([, stat]) => stat.present > 0 && stat.present < stat.applicable);
  if (partial.length) status = 'WARN';
  return makeCheck(id, name, status, lines, { fields, variants: variantMeta, absent });
}

const VARIANT_REQUIRED = ['url', 'bytes', 'sha256', 'label', 'height'];

function checkVariantSet(oldSet, v1Set) {
  const id = 'e';
  const name = '变体一致性';
  const sets = [];
  if (oldSet.ok) sets.push({ label: '旧路径', set: oldSet });
  if (v1Set.ok) sets.push({ label: 'v1', set: v1Set });
  if (!sets.length) return makeCheck(id, name, 'WARN', ['两侧清单都拿不到，跳过'], { skipped: true });

  const lines = [];
  let status = 'PASS';
  const data = {};
  let anyVariants = false;

  for (const { label, set } of sets) {
    const rows = [];
    for (const item of set.items) {
      const list = Array.isArray(item && item.variants) ? item.variants : [];
      list.forEach((variant, index) => rows.push({ itemId: itemId(item), index, variant }));
    }
    if (!rows.length) {
      lines.push('▸ ' + label + '：暂无 variants（该分类没有降档档位）');
      continue;
    }
    anyVariants = true;
    const itemsWithVariants = set.items.filter((item) => Array.isArray(item && item.variants) && item.variants.length).length;
    lines.push('▸ ' + label + '：' + itemsWithVariants + ' 条含 variants，共 ' + rows.length + ' 档');

    const missing = {};
    for (const key of VARIANT_REQUIRED) {
      const bad = rows.filter(({ variant }) => !isFilled(variant && variant[key]));
      missing[key] = bad.length;
      if (bad.length) {
        status = 'FAIL';
        lines.push('  ↳ ' + key + ' 缺失 ' + bad.length + ' 档（如 ' + bad.slice(0, 3).map((row) => row.itemId + '#v' + row.index).join(', ') + '）');
      }
    }
    const optional = {};
    for (const key of ['width', 'fps']) {
      const qualified = rows.filter(({ variant }) => variant && Object.prototype.hasOwnProperty.call(variant, key));
      const present = qualified.filter(({ variant }) => isFilled(variant && variant[key])).length;
      optional[key] = { declared: qualified.length, present, total: rows.length };
      if (!qualified.length) {
        // 未声明 ≠ 不一致：e 只对「声明了却是空」判红，整体缺席留给 d 报 WARN
        lines.push('  ↳ ' + key + ' 未声明（站点尚未上线该字段；存在时才校验）');
      } else if (present < qualified.length) {
        status = worse(status, 'WARN');
        lines.push('  ↳ ' + key + ' 声明了但有空值（' + (qualified.length - present) + '/' + qualified.length + '）');
      }
    }

    // 契约要求 variants 按 bytes 升序（插件按顺序挑档）
    let unsorted = 0;
    for (const item of set.items) {
      const list = Array.isArray(item && item.variants) ? item.variants : [];
      const values = list.map((variant) => normNumber(variant && variant.bytes));
      for (let i = 1; i < values.length; i += 1) {
        if (typeof values[i] === 'number' && typeof values[i - 1] === 'number' && values[i] < values[i - 1]) { unsorted += 1; break; }
      }
    }
    if (unsorted) {
      status = worse(status, 'WARN');
      lines.push('  ↳ ' + unsorted + ' 条的 variants 未按 bytes 升序（契约要求升序）');
    }

    if (!Object.values(missing).some((count) => count > 0)) {
      lines.push('  必填 url/bytes/sha256/label/height：' + rows.length + '/' + rows.length + ' 档齐全');
    }
    data[label] = { itemsWithVariants, variants: rows.length, missing, optional, unsorted };
  }

  if (!anyVariants) status = worse(status, 'WARN');
  return makeCheck(id, name, status, lines, data);
}

// —— f：内容抽样 ——

function variantsOf(item) {
  return Array.isArray(item && item.variants) ? item.variants.filter((variant) => normText(variant && variant.url)) : [];
}

/**
 * 抽 `count` 条：先保证至少一条带变体（主对象 + 变体都要验），其余从池子里随机补。
 * 超过 `capBytes` 的条目**不进池子**（一次体检不该下几百 MB）。
 */
function pickSamples(items, count, rng, capBytes) {
  const eligible = items.filter((item) => normText(item && item.url) && Number(item && item.bytes) <= capBytes);
  const shuffled = shuffle(eligible, rng);
  const withVariants = shuffled.filter((item) => variantsOf(item).length);
  const plain = shuffled.filter((item) => !variantsOf(item).length);
  const picked = [];
  if (withVariants.length) picked.push(withVariants.shift());
  for (const candidate of [...withVariants, ...plain]) {
    if (picked.length >= count) break;
    picked.push(candidate);
  }
  return { picked: picked.slice(0, count), pool: eligible.length, skipped: items.length - eligible.length };
}

/** 流式下载并算 sha256（不落盘、不整块读进内存）。 */
async function hashRemote(url, options = {}) {
  const capBytes = options.capBytes || 0;
  let lastError = '下载失败';
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { accept: '*/*', 'user-agent': 'dsh-folia-contract-check', ...AUTH_HEADERS },
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) {
        lastError = 'HTTP ' + res.status;
        if (res.status >= 500 && attempt < RETRIES) { await res.arrayBuffer().catch(() => {}); continue; }
        return { ok: false, status: res.status, error: lastError, ms: Date.now() - started };
      }
      const declared = Number(res.headers.get('content-length') || 0);
      if (capBytes > 0 && declared > capBytes) {
        if (res.body) await res.body.cancel().catch(() => {});
        return { ok: false, status: res.status, oversize: true, error: 'content-length ' + fmtBytes(declared) + ' 超过抽样上限 ' + fmtBytes(capBytes), ms: Date.now() - started };
      }
      if (!res.body) return { ok: false, status: res.status, error: '响应没有 body', ms: Date.now() - started };
      const hash = createHash('sha256');
      let bytes = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        hash.update(value);
      }
      return { ok: true, status: res.status, bytes, sha256: hash.digest('hex'), ms: Date.now() - started };
    } catch (error) {
      lastError = describeError(error);
    }
  }
  return { ok: false, status: 0, error: lastError };
}

function verifyArtifact(artifact, capBytes) {
  return hashRemote(artifact.url, { capBytes }).then((got) => {
    if (!got.ok) {
      return { artifact, got, shaMatch: null, bytesMatch: null, verdict: got.oversize ? 'skip' : 'error' };
    }
    const expectedSha = normHash(artifact.sha256);
    const expectedBytes = Number(artifact.bytes);
    const shaMatch = expectedSha ? got.sha256 === expectedSha : null;
    const bytesMatch = Number.isFinite(expectedBytes) && expectedBytes > 0 ? got.bytes === expectedBytes : null;
    const verdict = shaMatch === false || bytesMatch === false ? 'bad' : 'ok';
    return { artifact, got, shaMatch, bytesMatch, verdict };
  });
}

function describeArtifactResult(result) {
  if (result.verdict === 'skip') return '跳过（' + result.got.error + '）';
  if (result.verdict === 'error') return '下载失败：' + result.got.error;
  const parts = [];
  if (result.shaMatch === null) parts.push('sha256 未提供（只能比字节数）');
  else parts.push(result.shaMatch ? 'sha256 ✓' : 'sha256 ✗ API=' + shortValue(result.artifact.sha256) + ' 实际=' + result.got.sha256);
  if (result.bytesMatch === null) parts.push('bytes 未提供');
  else parts.push(result.bytesMatch ? 'bytes ✓' : 'bytes ✗ API=' + result.artifact.bytes + ' 实际=' + result.got.bytes);
  parts.push(fmtBytes(result.got.bytes) + ' ' + fmtSec(result.got.ms) + ' ' + fmtRate(result.got.bytes, result.got.ms));
  return parts.join(' · ');
}

/** --json 里的抽样记录：只留对账需要的字段，不把整条清单塞进去。 */
function sampleRecord(idValue, role, artifact, result) {
  const got = result.got || {};
  return {
    id: idValue,
    role,
    variantLabel: role === 'variant' ? normText(artifact.label) : '',
    url: artifact.url,
    expectedSha256: normHash(artifact.sha256) || null,
    expectedBytes: Number.isFinite(Number(artifact.bytes)) ? Number(artifact.bytes) : null,
    actualSha256: got.sha256 || null,
    actualBytes: Number.isFinite(got.bytes) ? got.bytes : null,
    ms: Number.isFinite(got.ms) ? got.ms : null,
    shaMatch: result.shaMatch,
    bytesMatch: result.bytesMatch,
    verdict: result.verdict,
    error: got.ok ? '' : (got.error || ''),
  };
}

async function checkSamples(oldSet, rng) {
  const id = 'f';
  const name = '内容抽样校验';
  if (OPT.samples <= 0) return makeCheck(id, name, 'WARN', ['--samples 0：本次没有下载任何文件'], { skipped: true });
  if (!oldSet.ok) return makeCheck(id, name, 'WARN', ['清单不可用（' + describeDataset(oldSet) + '），无法抽样'], { skipped: true });

  const capBytes = OPT.maxSampleMb * 1048576;
  const selection = pickSamples(oldSet.items, OPT.samples, rng, capBytes);
  if (!selection.picked.length) {
    return makeCheck(id, name, 'WARN', ['没有可抽样的条目（' + oldSet.items.length + ' 条都超过 ' + OPT.maxSampleMb + 'MB 或没有 url）'], { skipped: true });
  }

  const lines = [
    '抽样 ' + selection.picked.length + ' 条 · 池内 ' + selection.pool + ' 条 · 跳过 ' + selection.skipped + ' 条超 ' + OPT.maxSampleMb + 'MB',
  ];
  let status = 'PASS';
  const samples = [];
  let index = 0;
  for (const item of selection.picked) {
    index += 1;
    const label = itemId(item) || ('#' + index);
    progress('抽样 ' + index + '/' + selection.picked.length + '：' + label + ' ' + fmtBytes(Number(item.bytes)));
    const main = await verifyArtifact(item, capBytes);
    samples.push(sampleRecord(label, 'main', item, main));
    lines.push('#' + index + ' ' + label + ' 主对象 ' + fmtBytes(Number(item.bytes)) + ' → ' + describeArtifactResult(main));
    if (main.verdict === 'bad' || main.verdict === 'error') status = 'FAIL';
    else if (main.verdict === 'skip') status = worse(status, 'WARN');

    const variants = variantsOf(item);
    if (!variants.length) {
      lines.push('   └ 无变体，只验了主对象');
      continue;
    }
    // 随机挑一档变体（通常只有 1080p 一档）
    const variant = variants[Math.floor(rng() * variants.length) % variants.length];
    progress('抽样 ' + index + '/' + selection.picked.length + '：' + label + ' 变体 ' + normText(variant.label));
    const variantResult = await verifyArtifact(variant, capBytes);
    samples.push(sampleRecord(label, 'variant', variant, variantResult));
    lines.push('   └ 变体 ' + (normText(variant.label) || '?') + ' ' + fmtBytes(Number(variant.bytes)) + ' → ' + describeArtifactResult(variantResult));
    if (variantResult.verdict === 'bad' || variantResult.verdict === 'error') status = 'FAIL';
    else if (variantResult.verdict === 'skip') status = worse(status, 'WARN');
  }
  return makeCheck(id, name, status, lines, { samples, seed: OPT.seed });
}

// —— g：facets ——

function checkFacets(oldSet) {
  const id = 'g';
  const name = 'facets 计数一致';
  if (!oldSet.ok) return makeCheck(id, name, 'WARN', ['清单不可用（' + describeDataset(oldSet) + '），跳过'], { skipped: true });
  const total = oldSet.total != null ? oldSet.total : oldSet.items.length;
  const categories = oldSet.facets && Array.isArray(oldSet.facets.categories) ? oldSet.facets.categories : null;
  if (!categories) return makeCheck(id, name, 'WARN', ['清单没有 facets.categories（站点尚未上线 facets 统计）'], { skipped: true });

  const sum = categories.reduce((acc, item) => acc + (Number(item && item.count) || 0), 0);
  const diff = total - sum;
  const uncategorized = oldSet.items.filter((item) => !(item && item.category)).length;
  const lines = ['facets.categories ' + categories.length + ' 项，sum=' + sum + '，total=' + total + '，差额 ' + diff];

  let status = 'PASS';
  if (diff === 0) {
    lines.push('计数相加与 total 完全一致');
  } else if (diff > 0) {
    if (uncategorized >= diff) {
      lines.push('差额 ' + diff + ' 条可解释为「未分类」（抽样里 ' + uncategorized + ' 条无 category）');
    } else {
      status = 'WARN';
      lines.push('差额 ' + diff + ' 条无法用「未分类」解释（抽样里只有 ' + uncategorized + ' 条无 category）');
    }
  } else {
    status = 'FAIL';
    lines.push('facets 计数比 total 多 ' + Math.abs(diff) + ' —— 分类统计串了');
  }
  return makeCheck(id, name, status, lines, { total, sum, diff, uncategorized, categories });
}

// ── 6. 输出 ────────────────────────────────────────────────────────────────

function humanMode() {
  return !OPT.jsonOnly;
}

function progress(text) {
  if (humanMode()) process.stderr.write('  · ' + text + '\n');
}

function printHeader(origin, seed, startedAt) {
  if (!humanMode()) return;
  const auth = Object.keys(AUTH_HEADERS).length ? '已提供 FOLIA_COOKIE（内容不打印）' : '无（只用公开只读接口）';
  const lines = [
    'Folia 站点 API 契约体检（只读）',
    '  站点    ' + origin,
    '  时间    ' + startedAt.toLocaleString('zh-CN', { hour12: false }),
    '  范围    limit=' + OPT.limit + ' · samples=' + OPT.samples + ' · max-sample=' + OPT.maxSampleMb + 'MB · seed=' + seed,
    '  运行    Node ' + process.version + ' · ' + process.platform,
    '  认证    ' + auth,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function renderTable(rows) {
  const checkWidth = Math.max(14, ...rows.map((row) => textWidth(row.name)));
  const statusWidth = 4;
  const terminal = Number(process.stdout.columns) || 100;
  const detailWidth = Math.max(40, Math.min(96, terminal - checkWidth - 14));
  const widths = [checkWidth, statusWidth, detailWidth];
  const border = (left, middle, right) => left + widths.map((width) => '─'.repeat(width + 2)).join(middle) + right;
  const renderCells = (cells) => '│ ' + cells.map((cell, index) => padDisplay(cell, widths[index])).join(' │ ') + ' │';
  const lines = [border('┌', '┬', '┐'), renderCells(['检查', '结果', '明细']), border('├', '┼', '┤')];

  rows.forEach((row, rowIndex) => {
    const wrapped = row.lines.length ? row.lines.flatMap((line) => wrapDisplay(line, detailWidth)) : [''];
    wrapped.forEach((line, lineIndex) => {
      lines.push(renderCells([lineIndex === 0 ? row.name : '', lineIndex === 0 ? row.status : '', line]));
    });
    if (rowIndex < rows.length - 1) lines.push(border('├', '┼', '┤'));
  });
  lines.push(border('└', '┴', '┘'));
  return lines.join('\n');
}

function printReport(checks, summary, extra) {
  if (!humanMode()) return;
  process.stdout.write('\n' + renderTable(checks.map((check) => ({
    name: check.id + ' ' + check.name,
    status: check.status,
    lines: check.detail,
  }))) + '\n\n');
  if (extra.length) process.stdout.write(extra.join('\n') + '\n\n');
  process.stdout.write(
    'PASS ' + summary.pass + ' · WARN ' + summary.warn + ' · FAIL ' + summary.fail + ' → 退出码 ' + summary.exitCode + '\n',
  );
  process.stdout.write('（只有 WARN 时退出码为 0；任何 FAIL 都会以 1 退出）\n');
}

function writeJsonFile(path, result) {
  try {
    writeFileSync(path, JSON.stringify(result, null, 2) + '\n', 'utf8');
    if (humanMode()) process.stdout.write('\nJSON 已写入：' + path + '\n');
    return true;
  } catch (error) {
    process.stderr.write('写 --json 文件失败：' + describeError(error) + '\n');
    return false;
  }
}

function summarize(checks) {
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const check of checks) counts[check.status] += 1;
  return { pass: counts.PASS, warn: counts.WARN, fail: counts.FAIL, exitCode: counts.FAIL > 0 ? 1 : 0 };
}

// ── 7. 主流程 ──────────────────────────────────────────────────────────────

async function watchForV1(origin) {
  const interval = OPT.watchInterval * 1000;
  const deadline = Date.now() + OPT.watchTimeout * 60000;
  const stamp = () => new Date().toTimeString().slice(0, 8);
  let round = 0;
  for (;;) {
    round += 1;
    const manifest = await getJson(origin, '/api/v1/public/manifest.json');
    const manifestUp = manifest.ok && Boolean(manifest.doc);
    process.stderr.write('[watch-v1 ' + stamp() + '] 第 ' + round + ' 次探测 manifest.json → ' + (manifestUp ? '已上线' : describeHttp(manifest)) + '\n');
    if (manifestUp) {
      const list = await getJson(origin, '/api/v1/public/wallpapers?limit=1');
      const listUp = list.ok && Boolean(list.doc);
      process.stderr.write('[watch-v1 ' + stamp() + '] 清单端点 → ' + (listUp ? '已上线，开始体检' : describeHttp(list)) + '\n');
      if (listUp) return true;
    }
    if (Date.now() >= deadline) return false;
    const wait = Math.min(interval, Math.max(1000, deadline - Date.now()));
    process.stderr.write('[watch-v1 ' + stamp() + '] ' + Math.round(wait / 1000) + 's 后再试（最晚 ' + new Date(deadline).toTimeString().slice(0, 8) + '）\n');
    await sleep(wait);
  }
}

async function main() {
  parseArgs(process.argv.slice(2));
  if (OPT.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  const origin = normalizeBase(OPT.base);
  const seed = OPT.seed || ((Date.now() % 1000000000) >>> 0);
  OPT.seed = seed;
  const rng = makeRng(seed);
  const startedAt = new Date();

  printHeader(origin, seed, startedAt);

  if (OPT.watchV1) {
    const up = await watchForV1(origin);
    if (!up) {
      process.stderr.write('\n[watch-v1] ' + OPT.watchTimeout + ' 分钟内没有等到 v1 上线 —— 部署还没完成，本次不出报告。\n');
      return 1;
    }
    // 等到了：头部的时间戳更新一下，再照常体检
    if (humanMode()) printHeader(origin, seed, new Date());
  }

  progress('探测端点可达性…');
  const checks = [await checkEndpoints(origin)];

  progress('拉取旧清单 /api/public/wallpapers（limit=' + OPT.limit + '）…');
  const oldSet = await fetchDataset(origin, '/api/public/wallpapers', OPT.limit);
  progress('拉取 v1 清单 /api/v1/public/wallpapers（limit=' + OPT.limit + '）…');
  const v1Set = await fetchDataset(origin, '/api/v1/public/wallpapers', OPT.limit);

  checks.push(await checkParity(oldSet, v1Set, origin, OPT.limit));
  checks.push(checkRequired(oldSet, v1Set));
  checks.push(checkNewMetadata(v1Set.ok ? v1Set : oldSet));
  checks.push(checkVariantSet(oldSet, v1Set));
  checks.push(await checkSamples(oldSet, rng));
  checks.push(checkFacets(oldSet));

  const summary = summarize(checks);
  const result = {
    schema: SCHEMA_ID,
    generatedAt: startedAt.toISOString(),
    base: origin,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    options: {
      limit: OPT.limit,
      samples: OPT.samples,
      maxSampleMb: OPT.maxSampleMb,
      seed,
      watchV1: OPT.watchV1,
    },
    auth: Object.keys(AUTH_HEADERS).length > 0,
    summary,
    datasets: {
      old: { ok: oldSet.ok, status: oldSet.status, reason: oldSet.reason, count: oldSet.items.length, total: oldSet.total, pages: oldSet.pages, ms: oldSet.ms },
      v1: { ok: v1Set.ok, status: v1Set.status, reason: v1Set.reason, count: v1Set.items.length, total: v1Set.total, pages: v1Set.pages, ms: v1Set.ms },
    },
    checks,
  };

  const extra = [];
  if (oldSet.ok && oldSet.total != null && oldSet.items.length < oldSet.total) {
    extra.push('注：旧清单只取了 ' + oldSet.items.length + '/' + oldSet.total + ' 条（--limit ' + oldSet.total + ' 可全量）。');
  }
  printReport(checks, summary, extra);

  if (OPT.jsonPath && !writeJsonFile(OPT.jsonPath, result)) return 2;
  if (OPT.jsonOnly) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return summary.exitCode;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write('脚本自身出错：' + (error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = 2;
  });
