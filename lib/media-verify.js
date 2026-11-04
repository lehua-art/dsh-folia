/**
 * media-verify.js — **本地成品文件的完整性判据**（4.23.15，「本地副本自愈」的判据层）。
 *
 * ══ 为什么需要它 ══════════════════════════════════════════════════════════════
 * 另一台机器实测：壁纸播放报「视频解码失败（文件可能已损坏）」，面板同时说"缓存命中 4/5"。
 * 两条信息并不矛盾 —— 面板数的是**有没有 job、job 是不是 done**，而播放器读的是**盘上那些字节**。
 * 4.23.6 之前的 ranged 静默损坏会留下"长度对、内容错"的文件，且 job 照样 done ⇒
 * 面板说命中、播放器说坏，谁都没说谎，但**没有任何一层去验内容**。
 *
 * 本模块补的就是那一层，且只有三档判据（越往下越贵，按需取用）：
 *   ① **size**：与 job 记下的总长度比。最便宜，能抓住截断 / 半截写。
 *   ② **sha256**：与站点清单的 sha256 比。**唯一能证明"这就是站点那个文件"的判据**，
 *      只在 ≤ `SHA_FULL_LIMIT_BYTES`（20 MB）时做全量 —— 大文件整读一遍是几百 ms 级 IO，
 *      不能放进播放失败的关键路径（见下面 `verifyMediaFileP` 的分档）。
 *   ③ **结构**：大文件只做 MP4 的 `moov` 存在性 + box 不越界的扫描（**不解码、不整读**）。
 *      它能抓住"尾部截断"与"拼接成不是 mp4 的东西"，代价是 O(box 数) 次 seek。
 *
 * ══ 判据（改之前先想清楚）════════════════════════════════════════════════════
 *   · **有 sha256 就以 sha256 为准**。size 对、内容错正是 4.23.6 事故的形态，
 *     只比长度会把坏文件判成"好的"（负对照见 `test/verify-media-selfheal.mjs` 的 N1）。
 *   · **没有 sha256 时不谎称"坏"**：只能给出结构结论（`size` / `struct`），
 *     能证明坏 ⇒ 坏；不能证明坏 ⇒ 交给解码那条腿（`decideHeal` 返回 decode 档）。
 *   · **判据不抛**：任何 IO 异常都折成 `missing` 之类的结论 —— 一次校验失败不该让面板或
 *     播放路径炸掉（调用方是"播放已经坏了"的现场，最不能雪上加霜）。
 *
 * 纯逻辑与 IO 分开：`scanMp4Boxes` / `decideHeal` 是纯函数（可被守卫直接喂合成输入），
 * `verifyMediaFileP` 才读盘。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * 站点清单给的 sha256（只认 64 位十六进制）。
 *
 * ⚠️ 这里**不 import** `download-queue.js` 的同名函数：队列反过来要 import 本模块的
 * `scanMp4Boxes`（4.23.15 的"无效媒体不入库"），互相 import 会把两个模块绑成一个环。
 * 三行正则重复一次，换掉的是"模块图里一个真环"，账是划算的。
 */
function normalizeSha256(raw) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : '';
}

/** 全量算 sha256 的体积上限（20 MB）。超过它只做 size + 结构判据（见文件头）。 */
export const SHA_FULL_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * 判据结论词表（**唯一真源**：宿主路由、面板计数、守卫都读这几个字符串）。
 *   ok       —— 没发现问题（可能是"只验了 size/结构"，`sampled` 会说明）
 *   missing  —— 文件不在 / 不是文件
 *   size     —— 长度与 job 记的对不上（截断 / 半截写）
 *   sha      —— 内容哈希与站点清单不符（4.23.6 事故的形态：长度对、内容错）
 *   struct   —— MP4 结构坏了（box 越界 ⇒ 截断；没有 moov ⇒ 不是完整 mp4）
 */
export const VERDICT = {
  OK: 'ok', MISSING: 'missing', SIZE: 'size', SHA: 'sha', STRUCT: 'struct',
};

/** MP4 家族后缀：只有这几个才用 `moov` 判据（zip / jpg 没有 box 结构）。 */
const MP4_EXT_RE = /\.(mp4|m4v|mov)$/i;

/** 这个后缀是不是 MP4 家族（只有它们才做 box 判据）。 */
export function isMp4Name(file) {
  return MP4_EXT_RE.test(String(file || ''));
}

/**
 * 会被这条判据审的**媒体后缀**（视频/图片）。.zip 等打包产物**不在**其中 ——
 * 皮肤包可以小到几百字节，把 1 KiB 规则套上去会把正常安装判成坏文件。
 */
const MEDIA_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|jpg|jpeg|png|webp|avif|gif)$/i;

/** 一个"媒体文件"至少得有这么多字节；小于它的一定是占位/错误产物。 */
export const MIN_MEDIA_BYTES = 1024;

/**
 * **无效媒体判据**（4.23.15，P0-5）：下载完成、rename **之前**的最后一道闸。
 *
 * 为什么需要它（真实事故）：测试/脚本把合成占位视频（4–65 KB 的 `ftyp isom … mdat`、
 * ffprobe 认不出任何 stream）写进了用户的 library，用户看到的所有「浏览器无法解码」
 * 正是这些假文件。长度、sha256（站点没给时）、HTTP 状态全都"正常" —— 只有**内容**不正常。
 *
 * 两条判据（都不需要 ffmpeg，纯字节/结构）：
 *   · `< MIN_MEDIA_BYTES`（1 KiB）⇒ 任何类型都算无效（一张正常缩略图都远大于它）；
 *   · MP4 家族 ⇒ 顶层 box 必须走得通且有 `moov`、不许越界（`scanMp4Boxes`）。
 *
 * @param {string} file 待判定的文件（通常是 `.part`）
 * @returns {string} `''` = 通过；否则是人读原因（`too-small:…` / `no-moov` / `truncated`）
 */
export function invalidMediaReason(file) {
  const p = String(file || '');
  if (!p) return 'no-path';
  // 只判**媒体**后缀：.zip（皮肤/开机动画/桌宠包）可以只有几百字节，套 1 KiB 规则会误杀。
  if (!MEDIA_EXT_RE.test(p)) return '';
  let size;
  try { size = statSync(p).size; } catch { return 'unreadable'; }
  if (size < MIN_MEDIA_BYTES) return 'too-small:' + size + 'B';
  if (!MP4_EXT_RE.test(p)) return '';
  const scan = scanMp4Boxes(p);
  if (scan.truncated) return 'truncated';
  if (!scan.moov) return 'no-moov';
  return '';
}

/**
 * 流式计算文件 sha256（1 MB 块，不把十几 MB 整读进内存）。
 * @param {string} file
 * @returns {Promise<string>}
 */
export function sha256FileP(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(file, { highWaterMark: 1024 * 1024 });
    s.on('data', (b) => h.update(b));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 扫一遍 MP4 的**顶层 box**，回答"有没有 moov"与"是不是被截断了"。
 *
 * 为什么要它（而不是 fs 整读）：moov 可以在文件尾部（非 faststart 的 mp4 就是这样），
 * 也可能有一个几十 MB 的 mdat 排在中间。按 box 跳过 mdat 只花几次 seek，
 * 而整读一份 45 MB 的文件放进"播放刚失败"的路径上是不可接受的。
 *
 * 判据三条：
 *   · 每个 box 的 `size` 若超出文件尾 ⇒ `truncated`（截断最可靠的信号）；
 *   · 见 `moov` ⇒ `moov:true`（长度够、结构全）—— 但**不早退**，见下面那处注释；
 *   · box 链走到头（或撞到 size<8 的坏头）⇒ 结束。
 * `size === 0` 按规范表示"到文件尾"，`size === 1` 表示后 8 字节才是 64 位长度。
 *
 * 不抛：读不到 / 打不开 ⇒ `{ moov:false, truncated:true }`（当作坏结构，由调用方决定怎么用）。
 *
 * @param {string} file
 * @returns {{ moov: boolean, truncated: boolean, boxes: number }}
 */
export function scanMp4Boxes(file) {
  const out = { moov: false, truncated: false, boxes: 0 };
  let fd = -1;
  try {
    fd = openSync(file, 'r');
    const total = statSync(file).size;
    let off = 0;
    const head = Buffer.alloc(16);
    for (let guard = 0; guard < 100000; guard += 1) {
      if (off + 8 > total) break;                    // 正常收尾：没有更多 box
      const got = readSync(fd, head, 0, 16, off);
      if (got < 8) { out.truncated = true; break; }
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (size === 1) {
        if (got < 16) { out.truncated = true; break; }
        // 64 位长度：只用低 32 位就够判"越界"，高位非零说明文件 > 4 GB（我们不关心）。
        const hi = head.readUInt32BE(8);
        const lo = head.readUInt32BE(12);
        size = hi > 0 ? Number.MAX_SAFE_INTEGER : lo;
      }
      out.boxes += 1;
      // ⚠️ **见到 moov 不能立刻收工**：moov 在文件头、mdat 却被截断，正是"能解复用、
      // 一播就崩"的形态（下载中断 / 磁盘写一半）。所以要一路走到最后一个 box，
      // 让"box 越界"这条判据有机会开口 —— 早退会把截断判成完好。
      if (type === 'moov') out.moov = true;
      if (size === 0) break;                         // 到文件尾
      if (size < 8) break;                           // 坏头（避免 size=0 死循环）
      if (off + size > total) { out.truncated = true; break; }
      off += size;
    }
  } catch {
    out.truncated = true;
    return out;
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  return out;
}

/**
 * 验一个已落地的媒体文件。**分档**执行（越贵越少做）：
 *   · 文件不在 ⇒ `missing`；
 *   · 已知期望长度且不等 ⇒ `size`（最便宜，先做）；
 *   · 已知 sha256 且 `size <= 20 MB` ⇒ 全量 sha256，不符 ⇒ `sha`；
 *   · 其余（大文件 / 没有 sha256）⇒ MP4 才有结构判据（`struct`），非 MP4 只到 size 为止。
 *
 * 返回值里三枚字段是**证据**，不是结论：
 *   `hashed` 全量算过哈希了吗 · `sampled` 只验了 size/结构吗 · `sha256` 算出来的值（没算为 null）。
 *
 * @param {{ file?: string, sha256?: string, bytes?: number, probeMoov?: boolean }} [inp]
 * @returns {Promise<{ file: string, verdict: string, reason: string, size: number,
 *   expectedBytes: number, sha256: string | null, hashed: boolean, sampled: boolean,
 *   moov: boolean | null }>}
 */
export async function verifyMediaFileP(inp) {
  const o = inp || {};
  const file = String(o.file || '');
  const want = normalizeSha256(o.sha256 || '');
  const expectBytes = Number(o.bytes) || 0;
  /** @type {{ file: string, verdict: string, reason: string, size: number, expectedBytes: number, sha256: string | null, hashed: boolean, sampled: boolean, moov: boolean | null }} */
  const out = {
    file, verdict: VERDICT.OK, reason: '', size: 0, expectedBytes: expectBytes,
    sha256: null, hashed: false, sampled: false, moov: null,
  };
  let size;
  try {
    const st = statSync(file);
    if (!st.isFile()) { out.verdict = VERDICT.MISSING; out.reason = 'not-a-file'; return out; }
    size = st.size;
  } catch {
    out.verdict = VERDICT.MISSING;
    out.reason = 'not-found';
    return out;
  }
  out.size = size;
  // ① 长度：最便宜的判据，先做（截断文件在这一格就出结论）。
  if (expectBytes > 0 && size !== expectBytes) {
    out.verdict = VERDICT.SIZE;
    out.reason = 'size ' + size + '/' + expectBytes;
    return out;
  }
  // ② 内容哈希：**只在 ≤ 20 MB 时做全量**（大文件全读是几百 ms 级 IO，不进关键路径）。
  if (want && size <= SHA_FULL_LIMIT_BYTES) {
    out.hashed = true;
    let got;
    try { got = await sha256FileP(file); } catch { out.reason = 'hash-unreadable'; return out; }
    out.sha256 = got;
    if (got === want) return out;                    // 内容与站点逐字节一致 ⇒ 一定不是坏文件
    out.verdict = VERDICT.SHA;
    out.reason = 'sha ' + got.slice(0, 12) + '… ≠ ' + want.slice(0, 12) + '…';
    return out;
  }
  // ③ 结构：大文件 / 没有 sha256 时唯一还能做的（不解码、不整读）。
  const mp4 = MP4_EXT_RE.test(file) || o.probeMoov === true;
  if (!mp4) { out.sampled = want === ''; return out; }
  out.sampled = true;
  const scan = scanMp4Boxes(file);
  out.moov = scan.moov;
  if (scan.truncated) { out.verdict = VERDICT.STRUCT; out.reason = 'box-overflow'; return out; }
  if (!scan.moov) { out.verdict = VERDICT.STRUCT; out.reason = 'no-moov'; return out; }
  return out;
}

/**
 * **播放失败之后该干什么**（纯函数，判据见 `test/verify-media-selfheal.mjs`）。
 *
 * 输入是"已经验过的证据"，输出是四选一的处置结论 —— 这也是面板文案的唯一来源：
 *   corrupt              —— 文件内容与站点清单不符（或结构坏）⇒ **删掉重下**
 *   variant              —— 内容没问题，只是本机解不了，且有 1080p 变体 ⇒ **切变体**
 *   undecodable          —— 已经在 1080p 上仍然解不了 ⇒ 「本机不支持该编码」
 *   undecodable-no-variant —— 内容没问题、没有变体、原画解不了 ⇒ 「分辨率/编码超出本机解码能力」
 *
 * ⚠️ **有 sha256 时必须看 sha256，不能只比长度**：4.23.6 事故的坏文件"长度完全正确、
 * 内容错"，只比长度会把它判成 variant/undecodable ⇒ 用户点了"跳过"却永远看不到正确的
 * 那张图（负对照 N1 就是按这条判的：把 sha 那一段换成"只比重" ⇒ 第一条用例红）。
 *
 * @param {{ shaKnown?: boolean, shaMatch?: boolean, sizeMatch?: boolean, structOk?: boolean,
 *   playing1080p?: boolean, hasVariant?: boolean, localMissing?: boolean }} [inp]
 * @returns {'corrupt' | 'variant' | 'undecodable' | 'undecodable-no-variant'}
 */
export function decideHeal(inp) {
  const o = inp || {};
  const decodeVerdict = () => {
    if (o.playing1080p === true) return 'undecodable';
    return o.hasVariant === true ? 'variant' : 'undecodable-no-variant';
  };
  if (o.localMissing === true) return 'corrupt';       // 文件都不在了 ⇒ 等于坏，重下
  if (o.shaKnown === true) {
    // 唯一的强判据：清单里那条 sha256。
    if (o.shaMatch !== true) return 'corrupt';
    return decodeVerdict();
  }
  // 没有 sha256：只能靠长度 + 结构。**证明不了坏就不许说坏**（见文件头判据第二条）。
  if (o.sizeMatch !== true) return 'corrupt';
  if (o.structOk === false) return 'corrupt';
  return decodeVerdict();
}
