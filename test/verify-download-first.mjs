#!/usr/bin/env node
/**
 * verify-download-first.mjs — **download-first：站点壁纸唯一播放路径 + 切走降级**。
 *
 * 用户口径（4.23.23 拍板，4.25.5 收敛为**唯一路径**）：
 *   ① 点未缓存壁纸 ⇒ 卡片 pressed + **海报立刻上屏**（不黑屏）；
 *   ② 进度行「正在缓存 x%（a/b MB · 约剩 N 秒）」；
 *   ③ **整份下载完 + 校验通过后**才从 `/folia/local-media/<id>` 播；期间 `<video>` 的 src
 *      绝不指向站点媒体地址（站点流不是播放源）；
 *   ④ 4.25.5：用户明确要求**删掉「改用边下边播」** ⇒ 「长等待保护」按钮、`stream-first` 档、
 *      `useStreamingNow()` / `dfUseStream()` / `dfPolicyOf()` / `dfLongWait()` 整条链路一并删除。
 *      设置键 `playbackPolicy` 保留但白名单只剩 `download-first`（老存档的 `stream-first`
 *      由 sanitize 夹回默认值 —— 键消失才是"配置读错"）。
 *   ⑤ 切走 ⇒ 该条降为 **low 继续下载**（不暂停/不取消，job id 与已下字节不变）；
 *      点回 ⇒ 升回 **high**；已完成 ⇒ 直接播本地。
 *
 * 判据组织：
 *   A. 判定（纯函数；唯一策略）· B. 进度/等待文案（纯函数）· C. 状态机 + 假 DOM（caching 不建 video）
 *   D. 切走/切回（优先级 low / 回到 high / 字节不归零）· E. 宿主队列真实行为（setPriority）
 *   F. 设置项 + 面板 + 预取 3 + 结构接线（负对照：把"第二档策略"贴回去 ⇒ A/F 组必红）
 *   G. 同版合并：错误分类（AbortError / NotAllowedError / 其它保留 name）+ 期望值不持久化。
 *
 * Usage: `node test/verify-download-first.mjs`
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDownloadQueue } from '../lib/download-queue.js';
import * as DF from '../src/download-first.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// 客户端在被内联后可以直接用 weT / dlFailReason / msLocalMediaUrl；单独 import 时用最小等价物。
globalThis.weT = (key, vars) => String(key).replace(/\{(\w+)\}/g, (m, name) => (
  vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
globalThis.dlFailReason = (code) => (code === 'http-404'
  ? '站点上没有这个文件（404）' : '下载失败：' + String(code || 'failed'));
globalThis.msLocalMediaUrl = (id) => '/folia/local-media/' + encodeURIComponent(String(id || ''));

const ITEM_A = {
  id: 'a', type: 'video', title: 'A', media: 'https://site.test/media/a.mp4',
  mediaProxy: '/folia/site-media/a.mp4', preview: 'https://site.test/thumb/a.jpg', localReady: false,
};
const ITEM_B = {
  id: 'b', type: 'video', title: 'B', media: 'https://site.test/media/b.mp4',
  mediaProxy: '/folia/site-media/b.mp4', preview: 'https://site.test/thumb/b.jpg', localReady: false,
};

/** 假 DOM：只实现 download-first / buildMedia 需要的最小子集。 */
function installFakeDom() {
  const created = [];
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), src: '', poster: '', dataset: {}, style: {},
      children: [], parentElement: null,
      setAttribute(k, v) { this[k] = String(v); },
      removeAttribute(k) { delete this[k]; },
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
      removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentElement = null; },
      querySelector(sel) {
        const want = String(sel).toUpperCase().replace(/^\./, '');
        return this.children.find((c) => c.tagName === want) || null;
      },
      load() {}, play() { return Promise.resolve(); }, pause() {},
      classList: { add() {}, remove() {}, contains() { return false; } },
    };
    created.push(el);
    return el;
  };
  const prev = globalThis.document;
  globalThis.document = {
    createElement: (tag) => make(tag),
    getElementById: () => null,
  };
  return { created, make, restore: () => { globalThis.document = prev; } };
}

/** 层计划 → 假层（唯一要判的是"caching 时有没有 video / video.src 是什么"）。 */
function buildLayerStub(item, sel, snap) {
  const layer = { tag: 'div', children: [], appendChild(c) { this.children.push(c); return c; } };
  const plan = DF.dfLayerPlan(item, sel, snap);
  if (plan.mode === 'poster') {
    const img = { tag: 'img', src: plan.src || '' };
    layer.appendChild(img);
  } else {
    const video = { tag: 'video', src: plan.src || '' };
    layer.appendChild(video);
  }
  return { layer, plan };
}

function isSiteMediaUrl(url) {
  const s = String(url || '');
  return s.indexOf('/site-media') >= 0 || s.indexOf('/media/wallpapers') >= 0;
}

/* ══ A. 判定（纯函数）：只有一档策略 ═════════════════════════════════════════ */
console.log('\nA. 判定：未缓存的站点视频 ⇒ download-first（**唯一**策略，没有第二档）');
{
  check('A1 未缓存的站点视频 ⇒ 该走 download-first',
    DF.dfShouldCache(ITEM_A) === true);
  check('A2 已缓存（localReady/local）⇒ 不再拦截',
    DF.dfShouldCache({ ...ITEM_A, localReady: true }) === false
    && DF.dfShouldCache({ ...ITEM_A, local: true }) === false);
  check('A3 本机条目 / 图片 ⇒ 不拦截',
    DF.dfShouldCache({ ...ITEM_A, mediaProxy: '' }) === false
    && DF.dfShouldCache({ ...ITEM_A, type: 'image' }) === false);
  check('A4 完成后交接（fromDownloadFirst）不重复拦截',
    DF.dfShouldCache(ITEM_A, { fromDownloadFirst: true }) === false);
  check('A5 判定不再读播放策略（传什么都一样：唯一路径）',
    DF.dfShouldCache(ITEM_A, { playbackPolicy: 'stream-first' }) === true
    && DF.dfShouldCache(ITEM_A, { playbackPolicy: 'download-first' }) === true);
  /* ── 源码级：第二条路（策略/长等待/秒开）的符号一个都不许留 ── */
  const src = read('src/download-first.js');
  const schema = read('lib/settings-schema.js');
  const STREAM_SYMBOLS = ['dfNormalizePolicy', 'dfPolicyOf', 'dfPolicyLabel', 'dfLongWait', 'dfUseStream',
    'DF_POLICY_DEFAULT', 'DF_POLICY_STREAM', 'DF_LONG_WAIT'];
  const left = STREAM_SYMBOLS.filter((s) => new RegExp('\\b' + s + '\\b').test(src));
  check('A6 源码级：策略/长等待/秒开这些符号在 src/download-first.js 里一个都不剩',
    left.length === 0, left.join(',') || '0 个');
  check('A7 设置项保留但白名单只剩 download-first（老存档 stream-first 由 sanitize 夹回默认）',
    /const PLAYBACK_POLICY_VALUES = \['download-first'\];/.test(schema)
    && /playbackPolicy: "download-first"/.test(schema)
    && /playbackPolicy: \{ kind: 'enum', values: PLAYBACK_POLICY_VALUES \}/.test(schema));
  /* ── 负对照：把"第二档策略"贴回源码 ⇒ A6/A7 的判据必须变假 ── */
  const legacySrc = src + '\nconst DF_POLICY_STREAM = "stream-first";\nfunction dfUseStream() { return 1; }\n';
  const legacySchema = schema.replace(
    "const PLAYBACK_POLICY_VALUES = ['download-first'];",
    "const PLAYBACK_POLICY_VALUES = ['download-first', 'stream-first'];");
  check('A8 负对照：贴回 stream-first 档 ⇒ A6 命中 2 个符号、A7 的白名单判据为假',
    STREAM_SYMBOLS.filter((s) => new RegExp('\\b' + s + '\\b').test(legacySrc)).length >= 2
    && !/const PLAYBACK_POLICY_VALUES = \['download-first'\];/.test(legacySchema));
}

/* ══ B. 进度文案 / 等待文案（纯函数）═════════════════════════════════════════ */
console.log('\nB. 进度 + 等待文案（total 已知给百分比；未知给阶段；pending 不说"正在缓存"）');
{
  const text = DF.dfProgressText(12.3 * 1048576, 45.8 * 1048576, 18);
  check('B1 完整文案：正在缓存 x%（a/b MB · 约剩 N 秒）',
    text === '正在缓存 27%（12.3/45.8 MB · 约剩 18 秒）', text);
  check('B2 总量未知且无状态 ⇒ 只给「正在缓存…」（点击瞬间的乐观形态）',
    DF.dfProgressText(1024, 0, 0) === '正在缓存…');
  check('B3 没有速度样本 ⇒ 省略「约剩 N 秒」',
    DF.dfProgressText(1048576, 4194304, 0) === '正在缓存 25%（1.0/4.0 MB）',
    DF.dfProgressText(1048576, 4194304, 0));
  check('B4 百分比钳在 0..100',
    DF.dfProgressText(2 * 1048576, 1048576, 0) === '正在缓存 100%（2.0/1.0 MB）');
  check('B5 running + total 未知 ⇒「正在连接…」（不是「已下载 X MB」冒充进度）',
    DF.dfProgressText(0, 0, 0, 'running') === '正在连接…', DF.dfProgressText(0, 0, 0, 'running'));
  check('B6 已等待秒数来自服务端 job.at ⇒「正在连接…（已等待 5 秒）」',
    DF.dfProgressText(0, 0, 0, 'running', 5) === '正在连接…（已等待 5 秒）',
    DF.dfProgressText(0, 0, 0, 'running', 5));
  check('B7 pending（被 burst 上限挤回）⇒「未缓存（点击继续）」，绝不说「正在缓存」',
    DF.dfProgressText(0, 0, 0, 'pending') === '未缓存（点击继续）'
    && !/正在缓存/.test(DF.dfProgressText(0, 0, 0, 'pending')),
    DF.dfProgressText(0, 0, 0, 'pending'));
  check('B8 dfWaitSecOf 只认服务端 at：有 at ⇒ 秒数；没 at / 未来时间 ⇒ 0（不编数字）',
    DF.dfWaitSecOf({ at: 1000 }, 6000) === 5
    && DF.dfWaitSecOf({}, 6000) === 0
    && DF.dfWaitSecOf({ at: 9000 }, 6000) === 0,
    JSON.stringify([DF.dfWaitSecOf({ at: 1000 }, 6000), DF.dfWaitSecOf({}, 6000)]));
  /* ── 负对照：旧实现 pending 也给「正在缓存…」/ total 未知只说「正在缓存…」── */
  const legacyText = (status) => (status === 'running' ? '连接中' : '正在缓存…');
  check('B9 负对照：旧实现 pending ⇒「正在缓存…」、running ⇒「连接中」（B5/B7 必红）',
    legacyText('pending') === '正在缓存…' && legacyText('running') === '连接中'
    && DF.dfProgressText(0, 0, 0, 'pending') !== legacyText('pending')
    && DF.dfProgressText(0, 0, 0, 'running') !== legacyText('running'));
}

/* ══ C. 状态机：caching → 进度 → done+verified → playing（本地地址）════════ */
console.log('\nC. 状态机：caching 不建 <video>；完成 + verified ⇒ local-media 播放');
const dom = installFakeDom();
try {
  DF.dfBegin(ITEM_A);
  // 用一个"假选择器"对象让 dfPolicyOf 读得到策略。
  let snap = DF.dfSnapshot();
  const builtCache = buildLayerStub(ITEM_A, { playbackPolicy: 'download-first' }, snap);
  check('C1 点击未缓存 ⇒ state=caching（不是 playing）', snap.state === 'caching', snap.state);
  check('C2 海报立即上屏：层里是 <img>，src = 条目预览图',
    builtCache.layer.children[0].tag === 'img'
    && builtCache.layer.children[0].src === ITEM_A.preview,
    builtCache.layer.children[0].tag + ':' + builtCache.layer.children[0].src);
  check('C3 进度文案出现（正在缓存…）', /^正在缓存/.test(snap.text || ''), snap.text);
  check('C4 未下完时层里**没有** <video>（不可能拿站点流边下边播）',
    !builtCache.layer.children.some((c) => c.tag === 'video'));
  check('C5 未下完时不存在任何 video.src（负对照：不是站点媒体地址）',
    !builtCache.layer.children.some((c) => c.tag === 'video' && isSiteMediaUrl(c.src)));

  // 下到 45%：progress + ETA（模拟 1s 增量 1MB，剩余 48MB ⇒ ~48s）
  const t0 = Date.now();
  DF.dfApplyJob({ id: 'j1', status: 'running', received: 1 * 1048576, total: 100 * 1048576 }, t0);
  DF.dfApplyJob({ id: 'j1', status: 'running', received: 2 * 1048576, total: 100 * 1048576 }, t0 + 1000);
  snap = DF.dfSnapshot();
  check('C6 running 时进度前进且给出 ETA',
    snap.percent >= 1 && snap.etaSec > 12 && /约剩 \d+ 秒/.test(snap.text),
    snap.percent + '% / eta=' + snap.etaSec + ' / ' + snap.text);
  check('C7 快照里**没有**"可切流"的字段（4.25.5：那条路整体删除）',
    !('showStream' in snap) && !('canStream' in snap) && !('streaming' in snap),
    Object.keys(snap).join(','));
  check('C8 负对照：把 showStream 塞回快照 ⇒ C7 的判据变假',
    (() => { const legacy = { ...snap, showStream: true }; return 'showStream' in legacy; })());

  // 完成 + verified：3 秒内 → playing（local-media）
  const tDone = Date.now();
  DF.dfApplyJob({
    id: 'j1', status: 'done', received: 100 * 1048576, total: 100 * 1048576,
    verified: 'sha256', fileValid: true, fileExists: true,
  }, tDone + 1000);
  snap = DF.dfSnapshot();
  const builtDone = buildLayerStub(ITEM_A, { playbackPolicy: 'download-first' }, snap);
  check('C9 done + verified ⇒ state=playing（不是 caching）', snap.state === 'playing', snap.state);
  check('C10 本地播放地址 = /folia/local-media/<jobId>',
    snap.localUrl === '/folia/local-media/j1', snap.localUrl);
  check('C11 完成后 <video>.src 是 local-media（不是站点流）',
    builtDone.layer.children[0].tag === 'video'
    && builtDone.layer.children[0].src.indexOf('/folia/local-media/') === 0
    && !isSiteMediaUrl(builtDone.layer.children[0].src),
    builtDone.layer.children[0].src);
  check('C12 从下载完成到 local 播放 ≤ 3 秒（同步迁移）', Date.now() - tDone < 3000,
    (Date.now() - tDone) + 'ms');

  // 失败：原因 + 重试（4.25.5：没有"切流"那颗备用按钮了）
  DF.dfBegin(ITEM_A);
  DF.dfApplyJob({ id: 'j2', status: 'failed', error: 'http-404' });
  snap = DF.dfSnapshot();
  check('C13 下载失败 ⇒ state=failed + 明确原因（不是裸 failed）',
    snap.state === 'failed' && /404/.test(snap.error), snap.error);
  check('C14 失败 ⇒ 只剩「重试」（showRetry），没有可切的流分支',
    snap.showRetry === true && !('showStream' in snap));
  check('C15 失败后不会自己走站点流：state 仍是 failed（只有用户点重试才重新入队）',
    snap.state === 'failed' && !('streaming' in snap));

  // 切走 + 切回（未完成 ⇒ 继续显示进度；已完成 ⇒ 直接本地）
  DF.dfBegin(ITEM_A);
  DF.dfApplyJob({ id: 'j3', status: 'running', received: 5 * 1048576, total: 10 * 1048576 });
  const jobA = { id: 'j3', status: 'running', received: 5 * 1048576, total: 10 * 1048576 };
  const demotions = [];
  const leave = DF.dfLeaveSelection(ITEM_B.id, { demote: (p) => demotions.push(p) });
  check('D1 切走 ⇒ 发出 priority=low 的降级请求（不是 cancel/pause）',
    demotions.length === 1 && demotions[0].priority === 'low' && demotions[0].id === 'j3',
    JSON.stringify(demotions));
  check('D2 切走 ⇒ 显示状态清空，但 job 本身仍在跑、已下字节不归零',
    leave && leave.jobId === 'j3' && leave.received === 5 * 1048576
    && jobA.status === 'running' && jobA.received === 5 * 1048576);
  check('D3 切走不取消：降级请求里没有 cancel / paused 字段',
    !('cancel' in demotions[0]) && !('paused' in demotions[0]));
  // 切回：同一个 id ⇒ 预填上次进度（继续显示，不回到 0）
  const resumed = DF.dfBegin(ITEM_A);
  check('D4 切回未完成的 A ⇒ 继续显示上次进度（不从 0 重来）',
    resumed.state === 'caching' && resumed.received === 5 * 1048576 && resumed.percent === 50,
    resumed.percent + '%');
  check('D5 切回后轮询到 running ⇒ 仍按 caching 展示',
    DF.dfApplyJob({ ...jobA, received: 6 * 1048576 }).state === 'caching');
  // 切回时已完成 ⇒ 直接播本地
  const doneJob = {
    id: 'j3', url: ITEM_A.media, status: 'done',
    received: 10 * 1048576, total: 10 * 1048576, verified: 'sha256', fileValid: true,
  };
  // 点回 A：客户端同样走 dfBegin → 第一次轮询就拿到 done job（不是先播站点流再等）。
  DF.dfBegin(ITEM_A);
  const resumeDone = DF.dfApplyJob(doneJob);
  check('D6 切回时已完成 + verified ⇒ 直接播本地（play-local）',
    resumeDone.state === 'playing' && resumeDone.localUrl === '/folia/local-media/j3',
    resumeDone.state + ':' + resumeDone.localUrl);

  // pending 快照：层里同样只有海报（任务在、但没在排队 ⇒ 绝不建 <video>）
  const pendingSnap = { state: 'pending', localUrl: '' };
  const builtPending = buildLayerStub(ITEM_A, null, pendingSnap);
  check('C16 pending 快照同样只放海报（不建 <video>、不碰站点流）',
    builtPending.plan.mode === 'poster'
    && !builtPending.layer.children.some((c) => c.tag === 'video'),
    builtPending.plan.mode + ' / ' + JSON.stringify(builtPending.layer.children.map((c) => c.tag)));
  check('C16b 负对照：把 pending 当 idle（dfLayerPlan 不看它）⇒ 会建一个指向站点流的 <video>',
    (() => {
      const legacy = { state: 'idle', localUrl: '' };
      const l = buildLayerStub(ITEM_A, null, legacy);
      return l.plan.mode === 'video' && isSiteMediaUrl(l.layer.children[0].src);
    })());

  // 负对照：把"点击即用站点流"贴回媒体层 ⇒ C2/C5 的那条判据必须红。
  const mediaPrep = read('src/media-prep.js');
  const guardOf = (src) => /const dfGate = [\s\S]{0,260}dfShouldCache\(w, opts\)/.test(src)
    && /if \(dfGate\) \{[\s\S]{0,700}playMode = dfPlan\.mode/.test(src);
  check('C17 真实源码在 caching 分支前有 dfShouldCache 拦截', guardOf(mediaPrep) === true);
  check('C18 负对照：把拦截条件改成 false ⇒ 判据当场变红',
    guardOf(mediaPrep.replace('? dfShouldCache(w, opts) : false', '? false : false')) === false);
} finally {
  dom.restore();
}

/* ══ E. 宿主队列：setPriority（切走 low 继续下 / 点回 high 回队首）════════ */
console.log('\nE. 宿主队列 setPriority：降级不取消、字节不归零、点回升 high');
{
  const home = mkdtempSync(join(tmpdir(), 'folia-df-q-'));
  /** 慢速上游：分块写，保证有 running + received > 0 的窗口。 */
  async function slowServer(totalMs = 1200) {
    const body = Buffer.alloc(512 * 1024, 9);
    const srv = createServer((req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'video/mp4');
      res.setHeader('content-length', String(body.length));
      let at = 0;
      const timer = setInterval(() => {
        if (at >= body.length) { clearInterval(timer); try { res.end(); } catch { /* ignore */ } return; }
        const chunk = body.subarray(at, at + 32 * 1024);
        at += chunk.length;
        try { res.write(chunk); } catch { clearInterval(timer); }
      }, Math.max(1, Math.round(totalMs / (body.length / (32 * 1024)))));
      req.on('close', () => { try { clearInterval(timer); } catch { /* ignore */ } });
    });
    await new Promise((ok) => { srv.listen(0, '127.0.0.1', ok); });
    return { origin: 'http://127.0.0.1:' + srv.address().port, close: () => { try { srv.close(); } catch { /* ignore */ } } };
  }
  const up = await slowServer();
  const q = createDownloadQueue({ home, log: () => {} });
  try {
    // 一条正在跑的 high：拿到 received > 0 后降级 ⇒ 仍在跑、字节保持、job id 不变。
    const running = q.add({
      url: up.origin + '/media/running.mp4', dest: join(home, 'running.mp4'),
      kind: 'wallpaper', priority: 'high',
    }).job;
    const seen = await (async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const row = q.snapshot().find((j) => j.id === running.id);
        if (row && row.status === 'running' && Number(row.received) > 0) return row;
        await sleep(30);
      }
      return null;
    })();
    check('E1 用户点击的 job 是 high 且在跑', Boolean(seen) && seen.priority === 'high', seen ? seen.status + '/' + seen.priority : 'none');
    const before = seen ? Number(seen.received) : 0;
    const after = q.setPriority({ id: running.id, priority: 'low' });
    check('E2 切走降级 ⇒ priority=low，status 仍是 running（不暂停/不取消）',
      after && after.priority === 'low' && after.status === 'running',
      after ? after.status + '/' + after.priority : 'null');
    check('E3 降级后 job id 不变、已下字节不归零',
      after && after.id === running.id && Number(after.received) >= before && Number(after.received) > 0,
      'before=' + before + ' after=' + (after ? after.received : 'null'));
    const back = q.add({
      url: up.origin + '/media/running.mp4', dest: join(home, 'running.mp4'),
      kind: 'wallpaper', priority: 'high',
    }).job;
    check('E4 点回 ⇒ 立刻升回 high（同一个 job，不新建）',
      back && back.id === running.id && back.priority === 'high', back ? back.priority : 'null');

    // 队首语义：多条 low 排队时，点 high + 显式升 high 都排到 queuePos=1。
    const queued = [];
    for (let i = 0; i < 6; i += 1) {
      queued.push(q.add({
        url: up.origin + '/media/q-' + i + '.mp4', dest: join(home, 'q-' + i + '.mp4'),
        kind: 'wallpaper', priority: 'low',
      }).job);
    }
    const target = queued[queued.length - 1];
    const boosted = q.setPriority({ id: target.id, priority: 'high' });
    check('E5 显式升 high ⇒ queuePos=1（队首）', boosted && boosted.priority === 'high' && boosted.queuePos === 1,
      boosted ? 'pos=' + boosted.queuePos : 'null');
    const demoted = q.setPriority({ id: target.id, priority: 'low' });
    check('E6 再切走 ⇒ 降 low、仍在队列里（status 不是 cancelled/failed）',
      demoted && demoted.priority === 'low'
      && demoted.status !== 'cancelled' && demoted.status !== 'failed',
      demoted ? demoted.status + '/' + demoted.priority : 'null');
    // 负对照：普通 low 重复入队**不许**降级（证明"切走降级"必须走显式端点）。
    const highJob = q.add({
      url: up.origin + '/media/q-0.mp4', dest: join(home, 'q-0.mp4'), kind: 'wallpaper', priority: 'high',
    }).job;
    q.add({ url: up.origin + '/media/q-0.mp4', dest: join(home, 'q-0.mp4'), kind: 'wallpaper', priority: 'low' });
    const stillHigh = q.snapshot().find((j) => j.id === highJob.id);
    check('E7 负对照：普通 low 入队不降级（只有显式 setPriority 才能降）',
      stillHigh && stillHigh.priority === 'high', stillHigh ? stillHigh.priority : 'null');
  } finally {
    try { q.setPaused(true); } catch { /* ignore */ }
    up.close();
    // 服务器晚一拍才真正关；临时目录删不掉不是判据，最多重试几次。
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 }); }
    catch { /* 临时目录残留不影响判据 */ }
  }
}

/* ══ F. 设置项 / 面板 / 预取 / 结构接线 ═════════════════════════════════════ */
console.log('\nF. playbackPolicy 键保留（白名单一档）+ 面板无该控件 + 预取 3 + 结构接线');
{
  const schema = read('lib/settings-schema.js');
  const effects = read('src/panel-tabs-effects.js');
  const lf = read('src/local-first.js');
  const build = read('scripts/build-client.mjs');
  const host = read('lib/routes/downloads.js');
  check('F1 DEFAULTS.playbackPolicy = download-first（唯一默认）',
    /playbackPolicy: "download-first"/.test(schema));
  check('F2 KINDS 白名单只剩一档（键保留；老存档的 stream-first 会被 sanitize 夹回默认）',
    /PLAYBACK_POLICY_VALUES = \['download-first'\];/.test(schema)
    && /playbackPolicy: \{ kind: 'enum', values: PLAYBACK_POLICY_VALUES \}/.test(schema));
  check('F3 设置分区 core + 页签重置 playback 都登记了该键（键没被删）',
    /SETTINGS_NAMESPACES = \{[\s\S]{0,700}'playbackRate', 'playbackPolicy'/.test(schema)
    && /playback: \[[\s\S]{0,260}'playbackRate', 'playbackPolicy'/.test(schema));
  check('F4 面板「播放」页签**没有**播放策略控件（一档没有可选项 ⇒ 整行不画）',
    !/key: "playback-policy"/.test(effects)
    && !/onPlaybackPolicy/.test(effects)
    && !/dfPolicyLabel/.test(effects)
    && !/dfPolicyLabel/.test(read('src/download-first.js')));
  check('F4b 负对照：把旧控件贴回渲染器 ⇒ F4 的判据变假',
    /key: "playback-policy"/.test(effects + '\nkey: "playback-policy"'));
  check('F5 预取（4.24.1 起）：默认 0 张、只认宿主下发、上限 3，且一律 low',
    /const LF_PREFETCH_MAX = 3;/.test(lf)
    && /function lfPrefetchCount\(hostValue\)/.test(lf)
    && /hostCount = lfPrefetchCount\(doc\.prefetchCount\);/.test(lf)
    && /if \(hostCount <= 0\) return;/.test(lf)
    && /priority: "low"/.test(lf));
  check('F6 src/download-first.js 已登记进 INLINE_MODULES',
    build.includes("file: 'src/download-first.js'"));
  check('F7 宿主注册 POST /downloads/priority（显式降级端点）',
    /path: `\$\{BASE\}\/downloads\/priority`/.test(host));
  check('F8 媒体层 caching 分支在站点播放路径之前，且写 playMode=poster',
    (() => {
      const at = read('src/media-prep.js');
      const gateAt = at.indexOf('const dfGate =');
      const streamAt = at.indexOf('const playableSrc =');
      return gateAt >= 0 && streamAt > gateAt && /playMode = dfPlan\.mode/.test(at);
    })());
  check('F9 完成交接走 applySelection(fromDownloadFirst) 且不重入站点流',
    /applySelection\(selection\.id, \{ fromDownloadFirst: true \}\)/.test(read('src/client.js')));
  check('F10 切走时降级调用在同一入口（applySelection）里，且不是 cancel',
    /dfLeaveSelection\(id \|\| ""/.test(read('src/media-prep.js'))
    && !/downloads\/cancel/.test(read('src/download-first.js')));
}

/* ══ G. 同版合并：错误分类 + 期望值不再持久化 ═══════════════════════════════ */
console.log('\nG. 同版合并：错误分类重试 + 期望值不持久化 + 清单刷新复核');
{
  const audio = read('src/client-audio-playback.js');
  const client = read('src/client.js');
  const queue = read('lib/download-queue.js');
  const routes = read('lib/routes/downloads.js');
  check('G1 AbortError ⇒ 当前元素会重试一次；旧元素直接忽略（不显示错误）',
    /name === "AbortError"/.test(audio)
    && /isCurrentVideoEl\(video\)/.test(audio)
    && /video\.load\(\)/.test(audio));
  check('G2 NotAllowedError ⇒ 静音重试（muted=true）后才提示',
    /name === "NotAllowedError"/.test(audio) && /video\.muted = true/.test(audio));
  check('G3 其它错误保留 name（不吞成一句泛化文案）',
    /wePlayRefused = name \|\| "1"/.test(audio)
    && /播放失败（\{name\}）/.test(client));
  check('G4 SecurityError 不特殊吞掉（落到保留 name 的通用分支）',
    !/SecurityError/.test(audio) && /wePlayRefused = name/.test(audio));
  check('G5 入队不再接收 / 持久化 sha / expectSha / hashSource（只剩「最近一次校验实际用了什么」）',
    !/expectSha: j\.expectSha/.test(queue)
    && !/hashSource: j\.hashSource/.test(queue)
    && !/sha256: job\.sha256/.test(queue)
    && /function add\(\{[\s\S]{0,240}?itemKey[\s\S]{0,240}?relatedUrls/.test(queue)
    && /expectSha: normalizeSha256\(j\.verifiedSha\)/.test(queue));
  check('G6 完成那一刻问当前清单；不符时强制刷新复核一次',
    /resolveExpectation/.test(queue) && /refreshExpectation/.test(queue)
    && /refreshAttempted/.test(queue));
  check('G7 宿主注册四类清单源（wallpaper / skin / boot / pet）',
    /registerManifestSource\('boot'/.test(read('lib/routes/boot.js'))
    && /registerManifestSource\('skin'/.test(read('lib/routes/skins.js'))
    && /registerManifestSource\('pet'/.test(read('lib/routes/pets.js'))
    && /registerManifestSource\('wallpaper'/.test(read('lib/routes/inventory.js')));
  check('G8 队列行带 verified（客户端据此判"校验通过"）',
    /verified: j\.verified \|\| null/.test(queue) && /verifiedAt/.test(queue));
  check('G9 /downloads/list 不再有 migration 字段（期望值不迁移）',
    !/migration:/.test(routes));
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0
  ? 'ALL DOWNLOAD-FIRST CHECKS PASSED (' + results.length + ')'
  : failed.length + '/' + results.length + ' CHECK(S) FAILED'));
process.exit(failed.length === 0 ? 0 : 1);
