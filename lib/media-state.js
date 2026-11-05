/**
 * media-state.js — **「这份本地副本现在到底能不能播」的唯一状态模型与对账器**。
 *
 * ══ 为什么需要它（2026-11-04 的现场）══════════════════════════════════════════
 * 用户反复撞上的不是四个独立 bug，而是**同一个 bug 的四种长相**：
 *   · 「清空媒体」删了文件但 done 记录还在 ⇒ 客户端以为已缓存 ⇒ `/local-media` 404 ⇒
 *     `<video>` 得到 SRC_NOT_SUPPORTED ⇒ 界面写"浏览器无法解码这段视频"；
 *   · 4.23.18 把「done 但成品缺失」折成 `pending` 之后**永不重下** ⇒ 同一个 404 从"几秒"
 *     变成"永久"（见 docs/POSTMORTEM-2026-11-04.md 的二分结论）；
 *   · 下载进行中，`/site-media` 把**正在增长的 `.part`** 按 `content-length=总量` 端给播放器
 *     ⇒ 半截字节被当成成品解码 ⇒ "视频解码失败（文件可能已损坏）"；
 *   · 站点清单缓存（60s + 落盘）里存的是**已富化**的条目（`mediaProxy` 已写成 `/local-media/…`）
 *     ⇒ 重启后首屏拿到的仍是旧本地地址。
 *
 * 它们的共同点：**没有一处代码对"盘上那份字节"负责**。job 说 done、清单说 localReady、
 * 播放器说解码失败，三方各说各的，谁都没说谎。
 *
 * ══ 本模块的两条纪律（改之前先读）════════════════════════════════════════════
 *   ① **`localReady` 只有一个产地**：`reconcile()`（经 `createMediaReconciler`）。
 *      其它模块不许自己拼"job.status === done ⇒ 可播" —— 那正是上面四条的起点。
 *   ② **播哪个地址只有一个出口**：`resolvePlaySrc(state, entry)`。
 *      判据只有一条：**文件存在 + 内容有效 + job 是 done** 才允许返回本地地址；
 *      其余一切（downloading / pending / failed / done-但缺失 / sha 不符 / 结构坏）一律站点流。
 *      「绝不允许返回一个 fileExists=false 的 local 地址」—— 这条由本函数独占保证。
 *
 * ══ 状态机 ══════════════════════════════════════════════════════════════════
 *   job.status + 盘上证据 → MediaState → 对账动作（幂等、可重入）：
 *
 *   done    + 存在 + 有效                  ⇒ 保持 done，localReady=true
 *   done    + 缺失                         ⇒ pending（不占队列）+ 记异常
 *   done    + 存在但 sha/结构不符           ⇒ 删文件 + pending + 记异常
 *   pending + 存在 + 有效且长度相符         ⇒ 提升 done（记录丢了但字节是对的）
 *   pending + 缺失 / 其它                  ⇒ 保持 pending，localReady=false
 *   running / queued                       ⇒ 不动，localReady=false（**下载中绝不当本地成品**）
 *   failed / cancelled                     ⇒ 不动状态，localReady=false
 *
 * 纯逻辑（`decideReconcile` / `resolvePlaySrc` / `startupStatusFor`）与 IO 分开：
 * 守卫可以直接喂合成输入，不需要起 http、不需要真文件。
 *
 * ══ ⚠️ 两份实现必须同步（4.23.21，P1-B）════════════════════════════════════════
 * 客户端那份是同名的 `src/media-state.js`（`resolvePlaySrc(entry)`，只认客户端持有的状态）。
 * **为什么不能抽成一份**（评审过，结论是受控重复）：
 *   · 本文件 `import { rmSync, statSync } from 'node:fs'`（对账器要探盘）—— 浏览器里没有 fs；
 *   · 客户端那份由 `scripts/build-client.mjs` 按文件内联进 `lib/client.js`（src/*.js 是有序片段，
 *     不是可 import 的模块），两边都不能 import 对方；而 `src/` 不进发布集（`files` 里没有它）。
 *   · 另立一个"零依赖第三份"会同时打破内联片段序与发布面 —— 风险大于重复。
 *
 * 同步由判据保证：`test/verify-media-state.mjs` 的 **M9** 拿同一输入矩阵同时喂两份实现，
 * 逐字段比对 `source / url / jobId / mode`，并带"改坏客户端副本 ⇒ 必须红"的负对照。
 * **改这里任何一条分支（四个 ready 条件 / 候选顺序 / mode 映射），M9 都会当场断。**
 */
import { rmSync, statSync } from 'node:fs';
import { invalidMediaReason, verifyMediaFileP } from './media-verify.js';

/** 播放源只有两种（面板/诊断/判据读这两个字符串，别新造词）。 */
/** @type {{ LOCAL: 'local', PROXY: 'proxy' }} */
export const MEDIA_SOURCE = { LOCAL: 'local', PROXY: 'proxy' };

/** 状态键：URL 去空白（job 的 `url` 是幂等键，与 `urlKey()` 同一口径的语义）。 */
export function mediaKeyOf(url) {
  return String(url == null ? '' : url).trim();
}

/** `/folia/local-media/<jobId>` —— **本地播放地址的唯一拼法**（客户端/宿主/测试都读它）。 */
export function localMediaUrl(jobId) {
  return '/folia/local-media/' + encodeURIComponent(String(jobId || ''));
}

/** 这个地址是不是本地副本地址（客户端据此决定 `error` 后要不要换代理）。 */
export function isLocalMediaUrl(url) {
  return /\/local-media\//.test(String(url || ''));
}

/** 从本地播放地址里取 jobId（不是本地地址 ⇒ 空串）。 */
export function localMediaJobId(url) {
  const m = /\/local-media\/([^/?#]+)/.exec(String(url || ''));
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/**
 * **启动时的状态映射**（4.23.19 起是唯一口径，`download-queue.load()` 只调它）。
 *
 * 4.23.17：done+缺失 ⇒ `queued` ⇒ 启动瞬间几十条一起入队（用户实测"前面还有 50 个"）。
 * 4.23.18：done+缺失 ⇒ `pending` ⇒ 不批量入队，但**也永不重下** ⇒ `/local-media` 永久 404。
 * 4.23.19：保留 `pending`（不占队列），把"重下"交给对账后的**按需**入口（点击/在播/预取），
 *          同时播放侧立刻走站点流 —— 两边都不再依赖"文件会自己回来"。
 *
 * @param {string} persistedStatus 落盘时的 status
 * @param {boolean} onDisk         成品此刻是否真的在盘上
 * @returns {'done'|'pending'|'failed'|'cancelled'}
 */
export function startupStatusFor(persistedStatus, onDisk) {
  const s = String(persistedStatus || '');
  if (s === 'done') return onDisk ? 'done' : 'pending';
  if (s === 'failed') return 'failed';
  if (s === 'cancelled') return 'cancelled';
  return 'pending';
}

/**
 * 空状态（任何字段都不猜：没有 job 就是 proxy）。
 * @returns {any}
 */
function emptyState(job) {
  return {
    key: mediaKeyOf(job && job.url),
    jobId: String((job && job.id) || ''),
    kind: String((job && job.kind) || ''),
    expectSha: String((job && job.expectSha) || ''),
    expectBytes: Number(job && job.expectBytes) || 0,
    jobStatus: String((job && job.status) || ''),
    fileExists: false,
    fileBytes: 0,
    fileValid: false,
    localReady: false,
    source: MEDIA_SOURCE.PROXY,
    reason: '',
  };
}

/**
 * **单条 job 的对账判定（纯函数）**。
 *
 * @param {any} job 队列快照行：`{ id, url, kind, status, dest, expectSha, expectBytes, total }`
 * @param {{ exists: boolean, bytes?: number, valid?: boolean, reason?: string }} file 盘上证据
 * @param {{ deep?: boolean }} [opts]
 * @returns {{ state: any, patch: any, removeFile: boolean, anomaly: any }}
 */
export function decideReconcile(job, file, opts) {
  const o = opts || {};
  const state = emptyState(job);
  const f = file || { exists: false };
  const status = String(state.jobStatus || '');
  // 只有 done / pending 参与"能不能播"的判定。running / queued 是**下载中** ——
  // 无论盘上有多少字节都不许当成本地成品（半截 .part 正是"文件可能已损坏"的来源）。
  const relevant = status === 'done' || status === 'pending';
  if (!relevant) {
    return { state, patch: null, removeFile: false, anomaly: null };
  }
  state.fileExists = f.exists === true;
  state.fileBytes = Number(f.bytes) || 0;
  state.fileValid = state.fileExists && f.valid !== false;
  state.reason = String(f.reason || '');

  // ① done 但文件没了 ⇒ pending（不占队列）。这正是 4.23.18 引入的那条没有出口的分支：
  //    现在同一条分支还会**留下异常记录**，`/diag/media-state` 与日志能回答"修了几条"。
  if (status === 'done' && !state.fileExists) {
    return {
      state,
      patch: resetPatch(),
      removeFile: false,
      anomaly: {
        reason: 'done-but-missing',
        detail: 'done 记录在、成品不在（外部清理 / 清空媒体 / 4.23.18 遗留）',
      },
    };
  }

  // ② done 且存在但内容无效 ⇒ 删文件 + pending（坏的字节不能继续端出去）。
  if (status === 'done' && state.fileExists && !state.fileValid) {
    return {
      state,
      patch: resetPatch(),
      removeFile: true,
      anomaly: {
        reason: 'invalid-file',
        detail: '成品存在但校验不过（' + (state.reason || 'unknown') + '）',
      },
    };
  }

  // ③ pending 但盘上确实有一份**有效且长度相符**的成品 ⇒ 记录丢了、字节是对的，提升 done。
  //    （清空媒体删文件失败 / 手工删 downloads.json / 老版本遗留都会长成这样。）
  if (status === 'pending' && state.fileExists && state.fileValid && state.fileBytes > 0) {
    const bytesOk = state.expectBytes === 0 || state.fileBytes === state.expectBytes;
    if (bytesOk) {
      state.jobStatus = 'done';
      state.localReady = true;
      state.source = MEDIA_SOURCE.LOCAL;
      state.reason = 'orphan-promoted';
      return {
        state,
        patch: { status: 'done', error: null, received: state.fileBytes },
        removeFile: false,
        anomaly: {
          reason: 'pending-but-complete',
          detail: 'pending 记录对应一份完整成品 ⇒ 提升 done',
        },
      };
    }
  }

  // ④ done + 存在 + 有效 ⇒ 唯一允许 localReady 的形态。
  if (status === 'done') {
    state.localReady = true;
    state.source = MEDIA_SOURCE.LOCAL;
    if (!o.deep) state.reason = state.reason || 'struct-ok';
    return { state, patch: null, removeFile: false, anomaly: null };
  }

  // ⑤ 其余 pending 一律不可播。
  return { state, patch: null, removeFile: false, anomaly: null };
}

/** 对账时把一条 job 退回"未缓存"的统一 patch（与 `resetDoneForKinds` 同一口径）。 */
function resetPatch() {
  return {
    status: 'pending', error: null, received: 0,
    hashVerified: null, hashRetry: false, singleOnly: false, enoentRetries: 0,
    boostSeq: 0, pauseRequested: false,
  };
}
export { resetPatch as mediaResetPatch };

/**
 * **这一条该用哪种渲染器**（4.23.19 P1）：客户端拿去分派 `<video>` / `<img>` / 静态封面。
 * `scene` / `web` 是**预留分支**（本次不改现有渲染，按 poster 返回）。
 * @param {any} entry
 * @param {string} url
 * @returns {'video'|'image'|'poster'}
 */
export function playModeOf(entry, url) {
  const t = String((entry && entry.type) || '');
  if (t === 'image') return 'image';
  if (t === 'scene' || t === 'web' || t === 'live') return 'poster';
  if (!String(url || '')) return 'poster';
  return 'video';
}

/**
 * **播哪个地址 —— 全仓唯一出口**（宿主 inventory / 客户端 / 自愈都读它）。
 *
 * @param {any} state   `reconcile()` 产出的 MediaState（可空 = 没有这条 job）
 * @param {any} [entry] 清单条目（`mediaProxy` / `media` / `originUrl` / `type`）
 * @returns {{ source: 'local'|'proxy', url: string, jobId: string, mode: 'video'|'image'|'poster' }}
 */
export function resolvePlaySrc(state, entry) {
  const e = entry || {};
  const jobId = String((state && state.jobId) || '');
  const localUrl = jobId ? localMediaUrl(jobId) : '';
  // ⚠️ **四个条件缺一不可**：job 是 done（下载中/未下完不算）、文件在、内容有效、有 jobId。
  //    「拿掉 fileExists / fileValid 的任一条件」都会被 test/verify-media-state.mjs 的负对照判红。
  const ready = Boolean(state && state.jobStatus === 'done'
    && state.fileExists === true && state.fileValid === true && localUrl);
  if (ready) return { source: MEDIA_SOURCE.LOCAL, url: localUrl, jobId, mode: playModeOf(e, localUrl) };
  // 站点流：候选里**任何本地地址都跳过** —— 否则"换了个 URL 还是 404"。
  const candidates = [e.mediaProxy, e.proxyUrl, e.media, e.originUrl];
  for (const cand of candidates) {
    const s = String(cand == null ? '' : cand).trim();
    if (!s || isLocalMediaUrl(s)) continue;
    return { source: MEDIA_SOURCE.PROXY, url: s, jobId, mode: playModeOf(e, s) };
  }
  return { source: MEDIA_SOURCE.PROXY, url: '', jobId, mode: playModeOf(e, '') };
}

/** 盘上证据（默认实现；测试可注入替身，见 createMediaReconciler）。 */
export function defaultProbe(file, opts) {
  const o = opts || {};
  let st;
  try { st = statSync(file); } catch { return { exists: false }; }
  if (!st.isFile()) return { exists: false };
  const bytes = st.size;
  if (bytes <= 0) return { exists: true, bytes, valid: false, reason: 'empty' };
  if (o.expectBytes > 0 && bytes !== o.expectBytes) {
    return { exists: true, bytes, valid: false, reason: 'size ' + bytes + '/' + o.expectBytes };
  }
  const bad = invalidMediaReason(file);
  if (bad) return { exists: true, bytes, valid: false, reason: bad };
  return { exists: true, bytes, valid: true, reason: '' };
}

/** 深度证据：≤20MB 的媒体算 sha256，大文件只做长度 + mp4 结构（见 media-verify 的分档）。 */
async function deepProbe(file, opts) {
  const o = opts || {};
  try {
    const v = await verifyMediaFileP({ file, sha256: o.expectSha, bytes: o.expectBytes });
    if (v.verdict === 'ok') return { exists: true, bytes: v.size, valid: true, reason: '' };
    if (v.verdict === 'missing') return { exists: false };
    return { exists: true, bytes: v.size, valid: false, reason: v.verdict + (v.reason ? ':' + v.reason : '') };
  } catch {
    // 校验本身失败**不等于**文件坏；交给结构判据兜（绝不因为一次 IO 抖动删文件）。
    return defaultProbe(file, o);
  }
}

/**
 * 造一个**对账器**（进程内单例，由 `lib/routes/downloads.js` 持有）。
 *
 * 四个时机各调一次（都由调用方触发，本模块不自己挂定时器 —— 时机是产品决策，不是库行为）：
 *   ① 启动（`reason:'startup'`，先 quick，再择机 deep）；
 *   ② 清缓存之后（`reason:'cache-clear'`）；
 *   ③ `/local-media` 命中缺失（`noteMissing`）；
 *   ④ 下载完成（`noteDone`，由队列的 `onDone` 注入）。
 *
 * 幂等、可重入：同一份盘上证据跑两遍 ⇒ 第二遍 `reset/deleted/promoted` 全 0。
 *
 * @param {{ queue: any, log?: Function, probe?: Function, removeFile?: Function, deepProbe?: Function }} opts
 *   `queue` 是 `createDownloadQueue()` 的实例；其余是注入位（测试用；生产走默认实现）。
 */
export function createMediaReconciler(opts) {
  /** @type {any} */
  const o = opts || {};
  const queue = o.queue;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const probe = typeof o.probe === 'function' ? o.probe : defaultProbe;
  const deep = typeof o.deepProbe === 'function' ? o.deepProbe : deepProbe;
  const remove = typeof o.removeFile === 'function'
    ? o.removeFile
    : (file) => { try { rmSync(file, { force: true }); } catch { /* 占用中：状态照旧重置 */ } };

  /** id → MediaState（本进程最近一次对账的事实）。 */
  const byId = new Map();
  /** 最近一次对账统计（`/diag/media-state` 读它）。 */
  let last = { reason: '', at: 0, checked: 0, kept: 0, reset: 0, deleted: 0, promoted: 0, deep: false };
  /** 最近 20 条异常（含原因 + 处置）—— 诊断面板与排障直接读。 */
  const anomalies = [];

  function noteAnomaly(job, a) {
    anomalies.unshift({
      at: Date.now(), id: String(job.id || ''), url: String(job.url || ''),
      kind: String(job.kind || ''), reason: String(a.reason || ''), detail: String(a.detail || ''),
    });
    if (anomalies.length > 20) anomalies.length = 20;
  }

  function jobRow(id) {
    if (typeof queue.jobById === 'function') {
      const j = queue.jobById(id);
      if (j) return j;
    }
    const rows = typeof queue.snapshot === 'function' ? queue.snapshot() : [];
    return rows.find((x) => x && String(x.id) === String(id)) || null;
  }

  /**
   * 全量对账。返回统计 `{checked, kept, reset, deleted, promoted}`。
   * @param {{ reason?: string, deep?: boolean, kinds?: string[] }} [inp]
   */
  async function reconcileAll(inp) {
    const arg = inp || {};
    const reason = String(arg.reason || 'manual');
    const wantDeep = arg.deep === true;
    const kinds = Array.isArray(arg.kinds) && arg.kinds.length
      ? new Set(arg.kinds.map((k) => String(k || '').trim().toLowerCase()))
      : null;
    const rows = (typeof queue.snapshot === 'function' ? queue.snapshot() : [])
      .filter((j) => j && j.id && j.url && j.dest);
    const stats = { reason, at: Date.now(), checked: 0, kept: 0, reset: 0, deleted: 0, promoted: 0, deep: wantDeep };
    /** @type {{ id: string, patch: object }[]} */
    const patches = [];
    for (const job of rows) {
      if (kinds && !kinds.has(String(job.kind || '').trim().toLowerCase())) {
        // 不在这次范围里的 job 也要留下状态，否则清单可能读不到它（读不到 = 退回 proxy，安全）。
        continue;
      }
      const probeOpts = { expectSha: String(job.expectSha || ''), expectBytes: Number(job.expectBytes) || 0 };
      let file;
      try {
        // ⚠️ quick 路径**不 await**：`probe` 必须是同步的（stat + 结构扫描）。启动对账因此
        // 在 `reconcileAll()` 的同步段内完成 —— 调用方（路由挂载）不必 await 也能立刻拿到
        // 正确状态，测试也不会与"后台任务跑到一半"竞态。深度校验才走 `await deep()`。
        file = wantDeep ? await deep(job.dest, probeOpts) : probe(job.dest, probeOpts);
      } catch {
        file = { exists: false };
      }
      const verdict = decideReconcile(job, file, { deep: wantDeep });
      byId.set(String(job.id), verdict.state);
      stats.checked += 1;
      if (verdict.removeFile) {
        remove(job.dest);
        remove(job.dest + '.part');
        remove(job.dest + '.etag');
        stats.deleted += 1;
      }
      if (verdict.patch) {
        patches.push({ id: String(job.id), patch: verdict.patch });
        if (String(verdict.patch.status) === 'done') stats.promoted += 1;
        else stats.reset += 1;
      } else {
        stats.kept += 1;
      }
      if (verdict.anomaly) noteAnomaly(job, verdict.anomaly);
    }
    if (patches.length && typeof queue.applyReconcile === 'function') {
      try { queue.applyReconcile(patches); } catch { /* 状态写失败不影响已产出的 state */ }
    }
    last = stats;
    if (stats.reset || stats.deleted || stats.promoted) {
      try {
        log('media-state: 对账(' + reason + ') 检查 ' + stats.checked + ' 条 · 重置 ' + stats.reset
          + ' · 删文件 ' + stats.deleted + ' · 提升 ' + stats.promoted + ' · 保持 ' + stats.kept);
      } catch { /* 日志失败不影响对账 */ }
    }
    return stats;
  }

  /** 单条：拿到最新事实（不做整体对账）。`null` = 没有这条 job。 */
  function stateOfId(id) {
    const key = String(id || '');
    if (!key) return null;
    const cached = byId.get(key);
    const job = jobRow(key);
    if (!job) return cached || null;
    // 缓存只在"job 状态没变"时可信：状态一变（queued→done / done→pending）必须重新取证据，
    // 否则面板会拿着上一轮的快照说"可播"。文件被外部删掉要等下一次对账或 404 自愈（可接受：
    // 真正的安全边界在 `resolvePlaySrc` 与实际读盘的 `/local-media`）。
    if (cached && cached.jobStatus === String(job.status || '')) return cached;
    const file = probe(job.dest, { expectBytes: Number(job.expectBytes) || 0 });
    const v = decideReconcile(job, file, { deep: false });
    byId.set(key, v.state);
    return v.state;
  }

  /** 单条：按 URL 拿（inventory / 播放源解析用）。 */
  function stateOfUrl(url) {
    const key = mediaKeyOf(url);
    if (!key) return null;
    for (const st of byId.values()) if (st.key === key) return st;
    // 4.23.19：URL → id 用队列自己的键（与 `add()` 同一个 `urlKey`），
    // 不再为清单里的每个条目 `snapshot()` 一次（那是 100×O(n)）。
    if (typeof queue.idForUrl === 'function') {
      const id = queue.idForUrl(key);
      if (id) {
        const st = stateOfId(id);
        if (st) return st;
      }
    }
    const rows = typeof queue.snapshot === 'function' ? queue.snapshot() : [];
    const hit = rows.find((j) => j && mediaKeyOf(j.url) === key);
    return hit ? stateOfId(hit.id) : null;
  }

  /**
   * **`/local-media` 命中缺失**（③）：job 若是 done ⇒ 复位 pending（不重下、不占队列），
   * 并留下异常。返回复位后的状态（调用方据此回 404 的 `reset` 字段）。
   */
  function noteMissing(id, why) {
    const job = jobRow(id);
    if (!job) return null;
    const reason = String(why || 'local-media-404');
    if (String(job.status) === 'done') {
      const patch = resetPatch();
      if (typeof queue.applyReconcile === 'function') queue.applyReconcile([{ id: String(job.id), patch }]);
      noteAnomaly(job, { reason, detail: '本地副本请求命中缺失 ⇒ 复位 pending' });
      last = Object.assign({}, last, { at: Date.now(), reset: (Number(last.reset) || 0) + 1 });
    }
    const st = Object.assign(emptyState(job), {
      jobStatus: 'pending', fileExists: false, fileValid: false, localReady: false,
      source: MEDIA_SOURCE.PROXY, reason,
    });
    byId.set(String(job.id), st);
    return st;
  }

  /**
   * **下载完成**（④）：队列已经做完长度 / sha 校验，这里只补一次"盘上确实可播"的证据，
   * 并把状态刷成 localReady。发现无效 ⇒ 删 + pending（不让坏字节被端出去）。
   */
  async function noteDone(id) {
    const job = jobRow(id);
    if (!job) return null;
    const probeOpts = { expectSha: String(job.expectSha || ''), expectBytes: Number(job.expectBytes) || 0 };
    let file;
    try { file = await probe(job.dest, probeOpts); } catch { file = { exists: false }; }
    const v = decideReconcile(Object.assign({}, job, { status: 'done' }), file, { deep: false });
    if (v.removeFile) {
      remove(job.dest);
      remove(job.dest + '.part');
      remove(job.dest + '.etag');
    }
    if (v.patch && typeof queue.applyReconcile === 'function') {
      queue.applyReconcile([{ id: String(job.id), patch: v.patch }]);
    }
    if (v.anomaly) noteAnomaly(job, v.anomaly);
    byId.set(String(job.id), v.state);
    return v.state;
  }

  /** `/diag/media-state` 的载荷：总数 / 本地可用 / 待下载 / 上次对账 / 最近异常。 */
  function summary() {
    const rows = typeof queue.snapshot === 'function' ? queue.snapshot() : [];
    let localReady = 0;
    let downloading = 0;
    let pending = 0;
    let failed = 0;
    for (const job of rows) {
      const st = byId.get(String(job.id)) || stateOfId(job.id);
      const status = String(job.status || '');
      if (st && st.localReady) localReady += 1;
      else if (status === 'running' || status === 'queued') downloading += 1;
      else if (status === 'pending') pending += 1;
      else if (status === 'failed' || status === 'cancelled') failed += 1;
    }
    return {
      total: rows.length,
      localReady,
      downloading,
      pending,
      failed,
      last: Object.assign({}, last),
      anomalies: anomalies.slice(0, 20),
    };
  }

  return {
    reconcileAll,
    stateOfId,
    stateOfUrl,
    noteMissing,
    noteDone,
    summary,
    stats: () => Object.assign({}, last),
    anomalies: () => anomalies.slice(0, 20),
  };
}
