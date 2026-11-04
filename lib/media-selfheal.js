/**
 * media-selfheal.js — **本地副本自愈**（4.23.15）：发现坏文件就修，发现"解不了"就换档。
 *
 * ══ 为什么需要它（真实故障）════════════════════════════════════════════════════
 * 另一台机器：壁纸播放报「视频解码失败（文件可能已损坏）」，而面板同时说"缓存命中 4/5"。
 * 播放路径**直接读本地文件、没有任何自检** —— 于是 4.23.6 之前 ranged 静默损坏遗留的
 * 坏成品会永久留在 library 里，每次点都是那句错误，用户没有任何自愈手段。
 *
 * 三条入口（对应需求的三段）：
 *   ① `heal()`   —— **播放失败时**由客户端报上来：验这条本地副本，坏 ⇒ 删+单流重下；
 *                   内容没问题但本机解不了 ⇒ 切 1080p 变体（有的话）或明确告知。
 *   ② `runStartupSampleP()` —— **挂载后 30s** 对 library 里**最近 20 个**做轻量校验
 *                   （size 优先；≤20 MB 全量 sha256；大文件只做 size + moov）。
 *                   采样、不阻塞启动、不弹窗：坏的就后台清掉并排回下载队列。
 *   ③ `verifyAllP()` —— 用户点「校验并修复本地媒体」时跑**全量**版（同一套判据，不另写一份）。
 *
 * ══ 不变量 ══════════════════════════════════════════════════════════════════════
 *   · **判定只看 `lib/media-verify.js`**：本文件负责"发现之后做什么"，判据一行都不重写
 *     （否则"面板说好、自愈说坏"这类自相矛盾迟早出现）。
 *   · **启动自检不阻塞、不打扰**：30s 延迟 + `unref()` 定时器 + 逐条串行 + 全程 try/catch。
 *     它跑在别人已经能用的应用里，任何一条坏文件都只影响它自己。
 *   · **不给用户"正在检查"的模态**：计数走 `/folia/media/health`，面板轮询时自然看见。
 *   · **串行**：一次只验一条 —— 20 个 10 MB 文件并发算哈希会把磁盘打到 100%，
 *     而这件事本来就没有交付时限。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  decideHeal, invalidMediaReason, scanMp4Boxes, verifyMediaFileP, VERDICT, SHA_FULL_LIMIT_BYTES,
} from './media-verify.js';
import { normalizeSha256 } from './download-queue.js';
import { decodePlan, normalizeVariants, pick1080 } from './variant-pick.js';

/** 挂载后多久开始采样（毫秒）。30s = 让启动、首屏、首播都先跑完。 */
export const STARTUP_SAMPLE_DELAY_MS = 30000;
/** 采样条数：最近 20 个成品（用户最近看的那些才最可能被撞上）。 */
export const STARTUP_SAMPLE_SIZE = 20;
/** 兜底扫 library 的上限（防止几千个文件的库把启动 IO 打满）。 */
export const SWEEP_MAX_FILES = 500;

/** `DSH_FOLIA_SELFCHECK_DELAY_MS`：把 30s 窗口调小（测试与排障用；非法值回落默认）。 */
function delayFromEnv() {
  const raw = Number(process.env.DSH_FOLIA_SELFCHECK_DELAY_MS);
  if (!Number.isFinite(raw) || raw < 0) return STARTUP_SAMPLE_DELAY_MS;
  return Math.round(raw);
}

/** mtime 毫秒（取不到 ⇒ 0，让它排到后面；**不抛**）。 */
function mtimeOf(file) {
  try { return statSync(file).mtimeMs || 0; } catch { return 0; }
}

/**
 * @param {{ queue: any, log?: (m: string) => void,
 *   delayMs?: number,
 *   destFor?: (url: string, kind: string) => string,
 *   transcodeToPlayable?: (abs: string) => Promise<string>,
 *   transcodeProgressOf?: (abs: string) => ({ percent?: number, eta?: number | null } | null),
 *   transcodeWaitMs?: number }} opts
 */
export function createMediaSelfHeal(opts) {
  /**
   * `Object.assign` 归一成 `any`：注入面是"调用方可选给"的口袋（见上面的 JSDoc），
   * 逐键可选 ⇒ tsc 会把 `opts || {}` 推成联合类型，每个 `o.xxx` 都变成 TS2339。
   * 归一成一份**扁平对象**（与既有的 `createDownloadQueue` 同一手法）既让类型可读，
   * 也让"少传一个键"的默认值只有一处。
   */
  const o = /** @type {any} */ (Object.assign({}, opts));
  const queue = o.queue;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const delayMs = Number.isFinite(Number(o.delayMs)) ? Math.max(0, Number(o.delayMs)) : delayFromEnv();
  /** `destFor(url, kind)`：由路由层注入（`libraryDest` 住在那里，两处各写一份散列就会漂）。 */
  const destFor = typeof o.destFor === 'function' ? o.destFor : null;
  /** 救援转码（没有变体时的最后一档）；缺席 ⇒ 该档视为不可用（行为与 4.23.14 等价）。 */
  const transcodeToPlayable = typeof o.transcodeToPlayable === 'function' ? o.transcodeToPlayable : null;
  /** 转码进度的只读查询（`(abs) => ({ percent, eta })`）；缺席 ⇒ 只说"正在生成"，不报数字。 */
  const transcodeProgressOf = typeof o.transcodeProgressOf === 'function' ? o.transcodeProgressOf : null;
  /**
   * 救援转码**最多等多久**再回 `transcoding`（让客户端轮询）。
   * 为什么不一次等到底：整片重编码是**几十秒到几分钟**级，把 HTTP 请求挂在那里会让
   * 客户端那条 `fetch` 落到浏览器的默认超时/切换即断开；而转码本身在宿主侧继续跑，
   * 下一次调用直接命中同一份 in-flight promise（`transcodeToPlayable` 自己去重）。
   */
  const transcodeWaitMs = Number.isFinite(Number(o.transcodeWaitMs))
    ? Math.max(0, Number(o.transcodeWaitMs))
    : 2500;

  /**
   * 健康账本（`/folia/media/health` 的唯一真源）。
   * `damaged` 是**累计发现**的坏文件数（面板要的就是"这台机器上有过几个坏文件"），
   * `cleaned` 是其中已经删掉并排回队列的，`pending` 是还没修好的（= 仍在队列里等重下）。
   */
  const state = {
    checkedAt: 0,       // 最近一次校验的时间戳（0 = 还没跑过）
    checked: 0,         // 最近一次校验覆盖的文件数
    damaged: 0,         // 累计发现坏文件数
    cleaned: 0,         // 其中已删除并排回下载队列的
    pending: 0,         // 仍未修好的（坏文件已删、下载还没完成）
    running: false,     // 此刻是否在跑
    sampled: true,      // 最近一次是采样还是全量
    last: [],           // 最近一次发现的坏文件（最多 20 条，面板/排障用）
  };

  /**
   * 一次写入一组账本字段。
   * 为什么用 `Object.assign` 而不是逐字段赋值：这些赋值都发生在 `await` 之后，
   * `require-atomic-updates` 会把"读旧状态 → 写新状态"判成竞态。这里实际是**单写者**
   * （同一时刻只有一条校验在跑，见 `state.running`），用一次 `Object.assign` 表达
   * "这一步一起改这几个数"的意图，规则也就不再误报（与 `download-queue.js` 的 setJob 同法）。
   * @param {Record<string, any>} patch
   */
  function setState(patch) { Object.assign(state, patch); }

  /** 已落地 job 的**按 mtime 倒序**快照（"最近 20 个文件"的取法）。 */
  function doneRowsNewestFirst(limit) {
    /** @type {any[]} */
    let rows;
    try { rows = queue.snapshot(); } catch { rows = []; }
    const done = rows.filter((r) => r && r.status === 'done' && r.dest);
    const scored = done.map((r) => ({ row: r, at: mtimeOf(r.dest) || Number(r.at) || 0 }));
    scored.sort((a, b) => (b.at - a.at) || (String(a.row.id) < String(b.row.id) ? -1 : 1));
    const n = Number(limit) > 0 ? Number(limit) : scored.length;
    return scored.slice(0, n).map((x) => x.row);
  }

  /** 一条坏文件的自愈动作：删成品 + 作废完成记录 + 排回队列（单流重下）。 */
  function cleanOne(row, verdict, reason) {
    const done = queue.invalidate(row.id);
    if (done) {
      state.cleaned += 1;
      state.pending += 1;
      log('media-selfheal: ' + verdict + ' ' + row.dest + ' (' + reason + ') ⇒ removed & requeued');
    }
    const hit = {
      id: String(row.id || ''), url: String(row.url || ''), verdict: String(verdict || ''),
      reason: String(reason || ''), size: Number(row.total) || 0,
    };
    state.last = [hit, ...state.last].slice(0, 20);
    return hit;
  }

  /**
   * 串行校验一批 job。返回 `{ checked, damaged, items }`。
   * 任何单条的 IO 失败都不会中断整批（`verifyMediaFileP` 自身不抛）。
   */
  async function checkRowsP(rows) {
    const items = [];
    let damaged = 0;
    for (const row of rows) {
      let v;
      try {
        v = await verifyMediaFileP({
          file: String(row.dest || ''),
          // job 自己记下的期望 sha256（4.23.7 起入队时带进来）；旧 job 可能没有。
          sha256: String(row.sha256 || ''),
          bytes: Number(row.total) || 0,
        });
      } catch { continue; }
      if (v.verdict === VERDICT.OK) continue;
      damaged += 1;
      items.push(cleanOne(row, v.verdict, v.reason));
    }
    state.checked = rows.length;
    state.damaged = damaged;
    state.checkedAt = Date.now();
    return { checked: rows.length, damaged, items };
  }

  /** ② 启动采样：最近 `STARTUP_SAMPLE_SIZE` 个成品，**30s 后**、非阻塞。 */
  async function runStartupSampleP() {
    if (state.running) return { skipped: true, reason: 'running' };
    setState({ running: true });
    state.sampled = true;
    try {
      const rows = doneRowsNewestFirst(STARTUP_SAMPLE_SIZE);
      log('media-selfheal: startup sample ' + rows.length + ' file(s)');
      const out = await checkRowsP(rows);
      // P0-5（4.23.15）：**清掉 library 里认不出的媒体** —— 包括没有 job 的野文件
      //（污染事故里那些"测试写进来的合成占位视频"正是这一类：有 job 的上面那步能判出来，
      // 没有 job 的只能靠这一步）。判据与队列那道闸同源（`invalidMediaReason`）。
      const swept = sweepLibrary();
      if (swept.removed.length) {
        state.damaged += swept.removed.length;
        state.cleaned += swept.removed.length;
      }
      return { ...out, swept };
    } catch (e) {
      log('media-selfheal: startup sample failed — ' + String((e && e.message) || e));
      return { checked: 0, damaged: 0, items: [] };
    } finally {
      setState({ running: false });
    }
  }

  /**
   * 扫一遍 `<home>/library/**` 的**野文件**：没有对应 job、且判据说它是无效媒体的，直接删掉
   *（"用户看到无法解码"那批占位文件的特征）。
   *
   * 不变量：
   *   · **只删无效的**（`invalidMediaReason` 非空）。判据说"看不出问题"的一律留着 ——
   *     清垃圾不能顺手动用户的藏品。
   *   · 有 job 的文件不在这里删（那条由 `checkRowsP` 按 size/sha/结构负责，两处都删会让
   *     账本重复计数）。
   *   · 有上限 `SWEEP_MAX_FILES`：library 可能几千个文件，这一步是"兜底扫"。
   * @returns {{ scanned: number, removed: string[] }}
   */
  function sweepLibrary() {
    const out = { scanned: 0, removed: /** @type {string[]} */ ([]) };
    const home = (() => {
      try {
        const sp = String(queue.statePath || '');
        return sp ? dirname(sp) : '';
      } catch { return ''; }
    })();
    if (!home) return out;
    const root = join(home, 'library');
    /** @type {Map<string, boolean>} */
    const known = new Map();
    try {
      for (const r of queue.snapshot()) {
        if (r && r.dest) known.set(String(r.dest), true);
      }
    } catch { /* 快照拿不到 ⇒ 只按结构判据走 */ }
    const walk = (dir, depth) => {
      if (depth > 3 || out.scanned >= SWEEP_MAX_FILES) return;
      let names;
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (out.scanned >= SWEEP_MAX_FILES) return;
        const abs = join(dir, name);
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.isDirectory()) { walk(abs, depth + 1); continue; }
        out.scanned += 1;
        if (known.has(abs)) continue;
        const why = invalidMediaReason(abs);
        if (!why) continue;
        try { rmSync(abs, { force: true }); out.removed.push(abs); } catch { /* 占用中：下次再删 */ }
        try { rmSync(abs + '.etag', { force: true }); } catch { /* ignore */ }
        log('media-selfheal: swept stray invalid media ' + abs + ' (' + why + ')');
      }
    };
    walk(root, 0);
    return out;
  }

  /** ③ 全量校验（面板「校验并修复本地媒体」按钮）。判据与采样**同一条代码路径**。 */
  async function verifyAllP() {
    if (state.running) return { skipped: true, reason: 'running' };
    setState({ running: true });
    state.sampled = false;
    // 全量是用户主动发起的：累计数字从这一轮重新起算（否则"损坏 N 个"会永远带着历史）。
    state.damaged = 0;
    state.cleaned = 0;
    state.pending = 0;
    state.last = [];
    try {
      const rows = doneRowsNewestFirst(0);
      log('media-selfheal: verify all ' + rows.length + ' file(s)');
      return await checkRowsP(rows);
    } catch (e) {
      log('media-selfheal: verify all failed — ' + String((e && e.message) || e));
      return { checked: 0, damaged: 0, items: [] };
    } finally {
      setState({ running: false });
    }
  }

  /** 排一次启动采样（幂等：模拟"挂载后 30s 内"，且**不阻塞挂载**）。 */
  function scheduleStartupSample() {
    if (typeof setTimeout !== 'function') return null;
    const t = setTimeout(() => {
      Promise.resolve().then(() => runStartupSampleP()).catch(() => { /* 已内部兜底 */ });
    }, delayMs);
    try { if (t && typeof t.unref === 'function') t.unref(); } catch { /* ignore */ }
    return t;
  }

  /**
   * ① **播放失败自愈**（客户端 `<video>` 报错时调的那条）。
   *
   * @param {{ id?: string, localUrl?: string, originUrl?: string, sha256?: string,
   *   variants?: any, base?: string, title?: string, playing1080p?: boolean }} [inp]
   * @returns {Promise<{ verdict: string, message: string, jobId?: string, url?: string, detail?: any }>}
   */
  async function heal(inp) {
    const p = inp || {};
    // id 优先取显式字段；否则从 `/folia/local-media/<id>` 尾段取（客户端手里只有播放地址）。
    let id = String(p.id || '');
    if (!id) {
      const m = String(p.localUrl || '').match(/\/local-media\/([^/?#]+)/);
      if (m) { try { id = decodeURIComponent(m[1]); } catch { id = m[1]; } }
    }
    if (!id) return { verdict: 'unknown', message: '没有本地副本 id' };
    const row = queue.jobById(id);
    if (!row) return { verdict: 'unknown', message: '找不到这条本地副本的记录（可能已换库）' };
    // 期望哈希：job 自己那份优先（它是"当时按哪条清单下的"），客户端上报的兜底。
    const wantSha = normalizeSha256(row.sha256) || normalizeSha256(p.sha256 || '');
    const v = await verifyMediaFileP({
      file: String(row.dest || ''),
      sha256: wantSha,
      bytes: Number(row.total) || 0,
    });
    const structuralOk = v.verdict === VERDICT.OK;
    const shaMatch = v.hashed ? (v.sha256 === wantSha) : structuralOk;
    const playing1080p = row.chosenVariant === '1080p' || p.playing1080p === true;
    const v1080 = pick1080(normalizeVariants(p.variants, p.base));
    const verdict = decideHeal({
      localMissing: v.verdict === VERDICT.MISSING,
      shaKnown: Boolean(wantSha),
      shaMatch,
      sizeMatch: v.verdict !== VERDICT.SIZE && v.verdict !== VERDICT.MISSING,
      structOk: v.verdict !== VERDICT.STRUCT,
      playing1080p,
      hasVariant: Boolean(v1080 && v1080.url),
    });
    const detail = {
      id: row.id, size: v.size, hashed: v.hashed, sampled: v.sampled,
      sha256: v.sha256, verdict: v.verdict, reason: v.reason, wantSha: wantSha || null,
    };

    // (a) 内容对不上 / 结构坏 / 文件没了 ⇒ 删掉重下（**单流**，见 queue.invalidate）。
    if (verdict === 'corrupt') {
      queue.invalidate(row.id);
      log('media-selfheal: heal corrupt ' + row.id + ' — ' + (v.reason || v.verdict));
      return { verdict, jobId: row.id, message: '文件已损坏，已重新下载', detail };
    }

    // (b) 内容没问题、本机解不了、但有 1080p 变体 ⇒ 换档（原画那份保留，只是不再选它播）。
    if (verdict === 'variant' && v1080 && destFor) {
      let dest;
      try { dest = destFor(String(v1080.url), String(row.kind || 'wallpaper')); } catch { dest = ''; }
      if (dest) {
        const r = queue.add({
          url: String(v1080.url), dest, kind: String(row.kind || 'wallpaper'),
          priority: 'high', chosenVariant: '1080p',
          // 变体的 sha256 站点清单里通常不给 ⇒ 空 = 不设内容判据（长度 + 结构仍然生效）。
          sha256: normalizeSha256(v1080.sha256 || ''),
        });
        queue.markDecodeUnsupported(row.id, true);
        const jid = r && r.job ? String(r.job.id) : '';
        log('media-selfheal: heal variant ' + row.id + ' ⇒ 1080p ' + jid);
        return {
          verdict, jobId: jid, url: jid ? '/folia/local-media/' + jid : '',
          message: '已切换到 1080p（原画超出本机解码上限）', detail,
        };
      }
    }

    // (c) **没有变体（或变体不可用）⇒ 本地转码**（4.23.15 的最后一档，也是"以前能播、
    //     现在不能播"那条回归的兜底）：用 ffmpeg 产出一份确定能播的副本。
    //     模式由 `decodePlan` 决定（用户最终口径"降帧优先、尽量不降画质"）：
    //       · 只有 fps 超标 ⇒ `fps` 模式：**同分辨率**降到 30fps（4K@60 → 4K@30，画质不损）；
    //       · 分辨率超限 ⇒ `rescue` 模式：缩到 ≤1920×1080 再降到 30fps。
    //     已经在 1080p 上仍失败 ⇒ 不再试（用户明确要求："已是 1080p 仍 decode 错 ⇒
    //     提示本机不支持该编码"）；重编码同样救不了一个 1080p 都解不了的解码器。
    if (!playing1080p && transcodeToPlayable && (verdict === 'undecodable-no-variant' || verdict === 'variant')) {
      const out = await rescueTranscodeP(row, detail, p);
      // `failed` = 试过转码但没成功。这时**不能**再说"分辨率超限"（我们已经换掉了分辨率/
      // 编码/像素格式这三样），只能老实说"这台机器就是解不了这种内容"。
      if (out && out.failed) {
        log('media-selfheal: transcode failed for ' + row.id + ' ⇒ undecodable');
        return { verdict: 'undecodable', message: '本机不支持该编码', detail };
      }
      if (out) return out;
    }

    // (d) 已经 1080p 还解不了 / 转码不可用 / 转码失败 ⇒ 只说清原因，不重下、不换档。
    const noVariant = verdict !== 'undecodable';
    log('media-selfheal: heal ' + verdict + ' ' + row.id);
    return {
      // 调用方（客户端）按 verdict 取文案；这里把"没有变体"与"已在 1080p"分开，
      // 因为对用户是两句不同的话（"换个档试试"vs"这条机器上就是解不了"）。
      verdict: noVariant ? 'undecodable-no-variant' : 'undecodable',
      message: noVariant ? '该壁纸分辨率/编码超出本机解码能力' : '本机不支持该编码',
      detail,
    };
  }

  /**
   * 救援转码的那一段（c）：产出一份可播副本并**验证产物**，再把它交给播放。
   *
   * 三个不变量：
   *   · **产物也要过完整性判据**（需求 c）：没有 sha256 可比，但至少必须
   *     `size > 0`、MP4 结构完整（有 `moov`、box 不越界）—— 转码写一半留下的残片
   *     如果被当成"救回来的文件"，用户会看到同一个错误再来一次，而我们会以为已经修好了。
   *   · **绝不回退成播原片**：失败就说失败（返回 null，由调用点给"本机不支持该编码"）。
   *   · **不阻塞 HTTP 太久**：超过 `transcodeWaitMs` 就回 `transcoding`，让客户端轮询；
   *     转码在宿主侧继续跑，下一次调用命中同一份在途 promise。
   *
   * @param {any} row job 快照
   * @param {any} detail 证据（回给客户端排障用）
   * @param {any} payload 客户端上报的原始字段
   * @returns {Promise<any>} `null` = 转码管线不可用；`{failed:true}` = 试过但失败；
   *   否则是回给客户端的响应体（`transcoded` / `transcoding`）。
   */
  async function rescueTranscodeP(row, detail, payload) {
    const src = String(row.dest || '');
    const sourceLabel = String((payload && payload.title) || row.id || '');
    /**
     * 转码模式 = **决策树**（`lib/variant-pick.js` 的 `decodePlan`）。
     * 只有 fps 超标 ⇒ `fps`（同分辨率）；分辨率超限 ⇒ `rescue`（缩到 ≤1920×1080）。
     * 客户端可以把源的宽/高/帧率报上来；没报就在这里按"尺寸未知"走 rescue（安全方向）。
     */
    const plan = (() => {
      try {
        return decodePlan({
          width: Number((payload && (payload.width || payload.originalWidth)) || 0),
          height: Number((payload && (payload.height || payload.originalHeight)) || 0),
          fps: Number((payload && (payload.fps || payload.originalFps)) || 0),
          hasVariant: false,
        });
      } catch { return { action: 'rescue', reason: 'unknown' }; }
    })();
    const mode = plan && plan.action === 'decimate' ? 'fps' : 'rescue';
    /** @type {any} */
    let p;
    try { p = transcodeToPlayable(src, { mode }); } catch (e) {
      log('media-selfheal: transcode unavailable for ' + row.id + ' — ' + String((e && e.message) || e));
      return null;
    }
    if (!p || typeof p.then !== 'function') return null;
    const settled = p.then((file) => ({ kind: 'done', file }))
      .catch((err) => ({ kind: 'failed', err }));
    let raced = settled;
    if (transcodeWaitMs > 0 && typeof setTimeout === 'function') {
      raced = Promise.race([
        settled,
        new Promise((resolve) => {
          const t = setTimeout(() => resolve({ kind: 'pending' }), transcodeWaitMs);
          try { if (t && typeof t.unref === 'function') t.unref(); } catch { /* ignore */ }
        }),
      ]);
    }
    const r = await raced;
    if (r.kind === 'pending') {
      // 「转码期间必须有可见进度」：percent 由转码族按**产物文件增长**实时算（见
      // `transcodePlayableProgress`），eta 按剩余字节/近段速率估。拿不到就只报方向，
      // 不编数字（编出来的进度比没有进度更让人不敢信）。
      let progress;
      try { progress = transcodeProgressOf ? transcodeProgressOf(String(row.dest || '')) : null; } catch { progress = null; }
      log('media-selfheal: transcoding ' + row.id + ' ⇒ ask client to poll'
        + (progress ? ' (' + progress.percent + '%)' : ''));
      return {
        verdict: 'transcoding', retryAfterMs: 1500, progress, mode,
        message: mode === 'fps' ? '正在把原画降到 30fps（分辨率不变）…' : '原画超出本机解码上限，正在生成可播放副本…', detail,
      };
    }
    if (r.kind === 'failed') {
      log('media-selfheal: transcode failed for ' + row.id + ' — ' + String((r.err && r.err.message) || r.err));
      return { failed: true };
    }
    // 产物完整性（需求 c）：算一遍 sha 没意义（清单里没有这一份的哈希），但结构与体积必须成立。
    const v2 = await verifyMediaFileP({ file: String(r.file || ''), sha256: '', bytes: 0, probeMoov: true });
    const usable = v2.verdict === VERDICT.OK && v2.size > 0 && v2.moov === true;
    if (!usable) {
      log('media-selfheal: transcode output rejected for ' + row.id + ' — ' + (v2.reason || v2.verdict));
      return { failed: true };
    }
    const out = '/folia/local-media/' + encodeURIComponent(String(row.id)) + '?playable=1';
    log('media-selfheal: transcode ready for ' + row.id + ' (' + sourceLabel + ') ⇒ ' + r.file);
    return {
      verdict: 'transcoded', url: out, mode,
      message: mode === 'fps' ? '已切换到 30fps 副本（原画 60fps 超出本机解码能力，分辨率不变）' : '已切换到 1080p（原画超出本机解码上限）',
      detail: { ...detail, playable: { size: v2.size, moov: v2.moov } },
    };
  }

  /** 面板读数（`/folia/media/health`）。只读、不触发任何检查。 */
  function health() {
    return {
      checkedAt: state.checkedAt, checked: state.checked, damaged: state.damaged,
      cleaned: state.cleaned, pending: state.pending, running: state.running,
      sampled: state.sampled, last: state.last.slice(0, 20),
      shaFullLimitBytes: SHA_FULL_LIMIT_BYTES, sampleSize: STARTUP_SAMPLE_SIZE,
      sampleDelayMs: delayMs,
    };
  }

  return {
    heal, health, runStartupSampleP, verifyAllP, scheduleStartupSample,
    doneRowsNewestFirst, scanMp4Boxes,
  };
}
