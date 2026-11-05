#!/usr/bin/env node
/**
 * verify-dead-code.mjs — **死代码不许重新长出来**（4.24.1，P0-4）。
 *
 * ## 为什么需要它
 *
 * 4.24.0 之前的两轮清理都出现过同一形态：删了函数、**留了注释/半截常量**，或者反过来
 * 只删了调用点、把实现留在文件里。后者不会自己变红 —— 没人调用的函数、没人读的导出，
 * 编译器不报、既有守卫也不管（`test/verify-dead-declarations.mjs` 只扫**独立脚本**
 * `test/verify-*.mjs`，明确不扫 `lib/**` 与 `src/**`，理由见那个文件头）。
 *
 * 所以这里补上 `lib/**` + `src/**` + `scripts/**` 这一面，并且把本轮删掉的东西列成**黑名单**：
 * 它们任何一个重新出现都说明"旧实现被贴回来了"，必须红。
 *
 * ## 判据
 *
 *   A 黑名单符号不得重新出现（**只看代码**：先剥注释，否则一句"旧实现见 xxx"就会误报 / 漏报）
 *   B 本轮新增的唯一实现必须**在位**（删过头也要红：黑名单只证明"没了"，不证明"替代品在"）
 *   C `lib/**` / `src/**` / `scripts/**` 里没有**零引用**的顶层声明（"声明孤儿"）
 *   D 负对照：把黑名单里的名字塞进一份合成源码 ⇒ A 的判据必须为假（判据不是恒真）
 *
 * 扫描面与判据口径都写在代码里，不靠人记。隔离 home：本守卫只读文件，不写任何东西。
 *
 * Usage: `node test/verify-dead-code.mjs`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './tools/js-text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: String(detail == null ? '' : detail) });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? ' — ' + detail : ''));
};

/** 不扫的目录：生成物 / 依赖 / 这个仓库里**不属于本包**的站点后台。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.artifacts', '.test-cache', '.recon-site-src', 'folia-admin', 'assets', 'docs']);

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** 扫描面：三处源码根（`lib/**` 宿主、`src/**` 客户端片段、`scripts/**` 构建/发布脚本）。 */
const SCAN_ROOTS = ['lib', 'src', 'scripts'].map((d) => join(ROOT, d)).filter((d) => {
  try { return statSync(d).isDirectory(); } catch { return false; }
});
const FILES = SCAN_ROOTS.flatMap((d) => walk(d));
const RAW = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]));
/** 判据一律看**代码**：注释换成等长空格（行号不变）。 */
const CODE = new Map([...RAW].map(([f, s]) => [f, stripComments(s)]));

/**
 * 4.24.1 删掉的符号 —— **每一个都必须保持不存在**。
 *
 * 每一项都写明"当初为什么删"：只写名字的黑名单过半年就没人敢动。
 */
const DEAD = [
  {
    name: 'LF_PREFETCH_COUNT',
    re: /\bLF_PREFETCH_COUNT(_DOWNLOAD_FIRST)?\b/,
    why: '预取张数的旧实现：按 playbackPolicy 自己算 2/3 且**默认开着**（P0-3 的根因）。'
      + '现在唯一真源是宿主的 prefetchCount()（默认 0 / 上限 3）。',
  },
  {
    name: 'localMediaJobId',
    re: /\blocalMediaJobId\b/,
    why: 'lib/media-state.js 里从本地播放地址反解 jobId 的导出，零引用；'
      + '客户端那份 `lfLocalMediaJobId` 才是活的（同一个职责不许两份实现）。',
  },
  {
    name: 'isMp4Name',
    re: /\bisMp4Name\b/,
    why: 'lib/media-verify.js 的后缀判定包装，零引用；同文件内直接用 `MP4_EXT_RE`（唯一判据）。',
  },
  {
    name: 'mediaStateSummary',
    re: /\bmediaStateSummary\b/,
    why: 'lib/routes/downloads.js 的导出，零引用；`/diag/media-state` 自己调 reconciler.summary()。',
  },
  {
    name: 'siteApiVersionOf',
    re: /\bsiteApiVersionOf\b/,
    why: 'lib/site-list.js 的单族读数导出，零引用；`siteApiVersions()`（全族快照）是唯一出口。',
  },
  {
    name: 'assertPrebuiltBundle',
    re: /\bassertPrebuiltBundle\b/,
    why: 'scripts/build-client.mjs 的预构建对账函数，零引用 —— 单包化形态在配方层就'
      + '`process.exit(1)` 拒绝 prebuilt（见 recipes() 分支），这个函数永远到不了。',
  },
  {
    name: 'migrationStats',
    re: /\bmigrationStats\b/,
    why: '4.23.18 的"期望值迁移"统计；4.23.22 起 job 不再持久化期望值，迁移整体消失（4.23.23 已删）。',
  },
  {
    name: 'download-queue migrate()',
    re: /function\s+migrate\s*\(/,
    why: '4.23.18 的 `migrate()`（把旧 job 的 expectSha 改成当前清单值）。4.23.22 起不需要，已删；'
      + '文件里只留了"为什么没有它"的说明。',
  },
  /* ── 4.25.5：用户要求彻底删掉「改用边下边播」（点开即播站点流的那一档）───────────
   * 下面四条是本轮拆掉的整条链路。任何一条回来都说明"秒开档"被贴回去了：
   * 它会让 `<video>` 在下载完成前指向站点媒体地址 —— 正是用户明确不要的形态。 */
  {
    name: 'useStreamingNow()',
    re: /\buseStreamingNow\b/,
    why: '4.23.23 的"改用边下边播"处理器（按钮点击 → 写 streaming 态 → 按 forceStream 重挂）。'
      + '4.25.5 按用户要求整条删除：播放只有"下载完 + 校验通过 ⇒ 本地播"一条链。',
  },
  {
    name: 'dfUseStream()',
    re: /\bdfUseStream\b/,
    why: '上面的处理器在状态机里的那一半（caching/failed → idle + streaming）。同上删除。',
  },
  {
    name: 'stream-first 第二档',
    re: /\bstream-first\b|\bDF_POLICY_STREAM\b|\bdfNormalizePolicy\b|\bdfPolicyOf\b|\bdfPolicyLabel\b/,
    why: '播放策略的第二档（回滚到"点击即站点流"）。4.25.5 收敛为唯一路径 `download-first`：'
      + '设置键保留、白名单只剩一档（老存档由 sanitize 夹回默认），代码里不再有任何分支读它。',
  },
  {
    name: 'dfLongWait() 长等待保护',
    re: /\bdfLongWait\b|\bDF_LONG_WAIT_/,
    why: '长等待（>12s / >40MB 且 <1MB/s）→ 显示「改用边下边播」按钮的阈值判据。'
      + '按钮删除后它就没有消费者了；留着就是"零引用的实现"。',
  },
  {
    name: '「边下边播」界面文案',
    re: /边下边播/,
    why: '用户明确要求删掉的词（按钮 / 提示 / 标题栏状态）。4.25.5 起界面上不再出现；'
      + '源码里只允许出现在注释（本守卫已剥注释）。',
  },
];

/** 旧实现里对 **job 上持久化期望值** 的读取（4.23.22 结构性删除）。 */
const DEAD_PATTERNS = [
  {
    name: 'job.expectSha 读取',
    re: /job\.(expectSha|expectBytes|hashSource)\b/,
    why: 'job 不再持有校验输入（4.23.22）。读到它就等于把"入队那天的期望"复用回来 —— '
      + '那正是 4.23.21 hash-mismatch 的根因。',
  },
  {
    name: 'we-switch-hint 浮层节点',
    re: /(['"`])we-switch-hint\1|className:\s*"we-switch-hint"|class="we-switch-hint"/,
    why: '4.24.0 把这枚屏幕中央的 fixed 胶囊**整体退役**（缓存进度只进标题栏）。'
      + '状态读数（weSwitchHintTextOf）保留，DOM 不许回来。',
  },
];

/* ══ A. 黑名单 ═══════════════════════════════════════════════════════════════ */
console.log('\nA. 已删符号不得重新出现（只看代码，注释不算）');
{
  const hits = [];
  for (const item of DEAD) {
    for (const [f, code] of CODE) {
      if (!item.re.test(code)) continue;
      hits.push(relative(ROOT, f) + ' → ' + item.name);
    }
  }
  for (const item of DEAD_PATTERNS) {
    for (const [f, code] of CODE) {
      if (!item.re.test(code)) continue;
      hits.push(relative(ROOT, f) + ' → ' + item.name);
    }
  }
  check('A1 ' + DEAD.length + ' 个已删符号 + ' + DEAD_PATTERNS.length + ' 条已删形态一处都不剩', hits.length === 0,
    hits.length ? hits.slice(0, 8).join(' | ') : '0 处');
  check('A2 扫描面非空（找不到源码 = 判据失效，必须红）',
    FILES.length >= 100 && CODE.size === FILES.length,
    FILES.length + ' file(s)');
}

/* ══ B. 替代实现必须在位 ═══════════════════════════════════════════════════ */
console.log('\nB. 替代实现/新增判据在位（删过头也要红）');
{
  const lf = RAW.get(join(ROOT, 'src', 'local-first.js')) || '';
  const dq = RAW.get(join(ROOT, 'lib', 'download-queue.js')) || '';
  const skins = RAW.get(join(ROOT, 'lib', 'routes', 'skins.js')) || '';
  const routes = RAW.get(join(ROOT, 'lib', 'routes', 'downloads.js')) || '';
  check('B1 预取张数唯一真源：宿主 prefetchCount() + PREFETCH_MAX，客户端 lfPrefetchCount(hostValue)',
    /export function prefetchCount\(\)/.test(routes)
      && /export const PREFETCH_MAX = 3;/.test(routes)
      && /function lfPrefetchCount\(hostValue\)/.test(lf)
      && /const LF_PREFETCH_MAX = 3;/.test(lf));
  check('B2 `.part` 体检：bytesOf / discardPart / planResume / isRange416 四个都在',
    /function bytesOf\(/.test(dq) && /function discardPart\(/.test(dq)
      && /async function planResume\(/.test(dq) && /function isRange416\(/.test(dq));
  check('B3 启动清理：sweepLocalResidue + sweepStats 都在（判据在 verify-download-recovery 的 C 组）',
    /function sweepLocalResidue\(/.test(dq) && /sweepStats: \(\) =>/.test(dq));
  check('B4 皮肤缓存校验：verifyCachedZip + dropCachedZip 都在（且已导出给守卫）',
    /async function verifyCachedZip\(/.test(skins) && /function dropCachedZip\(/.test(skins)
      && /export \{ verifyCachedZip, dropCachedZip \};/.test(skins));
  check('B5 请求头只有一份（UA 常量，三处共用 `...UA`）',
    /const UA = \{ 'user-agent': 'dsh-folia\/download-queue' \};/.test(dq)
      && (dq.match(/\.\.\.UA/g) || []).length >= 3
      && (dq.match(/'user-agent': 'dsh-folia\/download-queue'/g) || []).length === 1);
}

/* ══ C. 零引用声明（lib / src / scripts）════════════════════════════════════ */
console.log('\nC. 顶层声明没有"孤儿"（零引用 = 死代码）');
{
  const DECL_RES = [
    /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/gm,
    /^\s*(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=/gm,
  ];
  /**
   * 裸 `const` 里有一大类**不是"实现"而是"形状"**的声明：纯数据表（枚举、URL 前缀、
   * 默认值对象）。它们零引用同样可疑，所以**不豁免** —— 本仓的实测结果是 0 条，
   * 豁免表一旦存在就会变成垃圾桶。
   */
  const decls = new Map();
  for (const [f, code] of CODE) {
    for (const re of DECL_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(code))) {
        const name = m[1];
        if (!name || name === 'constructor') continue;
        const prev = decls.get(f + '|' + name);
        if (prev) continue;
        decls.set(f + '|' + name, {
          f, name, line: code.slice(0, m.index).split('\n').length,
        });
      }
    }
  }
  // 引用计数看**全仓代码**（含 test/ 与 docs 之外的脚本），不只扫描根 —— 导出本来就是给别人用的。
  const ALL_CODE = (() => {
    const extra = [];
    for (const d of ['test', 'packages']) {
      const abs = join(ROOT, d);
      try { if (statSync(abs).isDirectory()) extra.push(...walk(abs)); } catch { /* 没有这个目录 */ }
    }
    const map = new Map(CODE);
    for (const f of extra) { try { map.set(f, stripComments(readFileSync(f, 'utf8'))); } catch { /* 读不了就跳过 */ } }
    return map;
  })();
  const orphans = [];
  for (const d of decls.values()) {
    const re = new RegExp('\\b' + d.name.replace(/\$/g, '\\$') + '\\b', 'g');
    let total = 0;
    for (const code of ALL_CODE.values()) {
      const n = (code.match(re) || []).length;
      total += n;
      if (total > 1) break;
    }
    if (total <= 1) orphans.push(relative(ROOT, d.f) + ':' + d.line + ' ' + d.name);
  }
  check('C1 零引用的顶层声明为 0（已删 5 个；本仓实测 0）', orphans.length === 0,
    orphans.length ? orphans.slice(0, 10).join(' | ') : decls.size + ' declaration(s) 全部有引用');
}

/* ══ D. 负对照 ═════════════════════════════════════════════════════════════ */
console.log('\nD. 负对照：判据必须有牙');
{
  // ① 黑名单：把已删名字塞回合成源码 ⇒ 必须命中。
  const synthetic = 'function lfPrefetchCount() { return LF_PREFETCH_COUNT_DOWNLOAD_FIRST; }\n'
    + 'export function localMediaJobId(u) { return u; }\n'
    + 'const x = job.expectSha;\n';
  const code = stripComments(synthetic);
  const hitNames = DEAD.filter((d) => d.re.test(code)).map((d) => d.name);
  check('D1 合成源码里贴回旧实现 ⇒ 黑名单命中（A1 不是恒真）',
    hitNames.includes('LF_PREFETCH_COUNT') && hitNames.includes('localMediaJobId'),
    'hits=' + hitNames.join(','));
  const pat = DEAD_PATTERNS.filter((p) => p.re.test(code)).map((p) => p.name);
  check('D2 合成源码里贴回 `job.expectSha` ⇒ 形态黑名单命中', pat.includes('job.expectSha 读取'),
    'hits=' + pat.join(','));

  // ② 剥注释：同一段旧实现放在注释里 ⇒ **不许**命中（否则一处文档就会把判据打成噪音）。
  const commented = stripComments('// 旧实现：function lfPrefetchCount() { return LF_PREFETCH_COUNT_DOWNLOAD_FIRST; }\n'
    + '/* const x = job.expectSha; */\nexport const keep = 1;\n');
  const noisy = DEAD.filter((d) => d.re.test(commented)).map((d) => d.name)
    .concat(DEAD_PATTERNS.filter((p) => p.re.test(commented)).map((p) => p.name));
  check('D3 旧实现只出现在**注释**里 ⇒ 不算命中（只判代码，不判散文）', noisy.length === 0,
    'hits=' + noisy.join(','));

  // ③ 零引用判据：合成一个只有声明没有引用的片段 ⇒ 必须被判成孤儿。
  const lone = 'function nobodyCallsMe() {}\nconst alsoNobody = 1;\nexport const keep = 2;\n';
  const names = [...lone.matchAll(/^function (\w+)\(/gm)].map((m) => m[1])
    .concat([...lone.matchAll(/^const (\w+)/gm)].map((m) => m[1]));
  const found = names.filter((n) => (lone.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length <= 1);
  check('D4 零引用判据：合成声明的引用计数为 1 ⇒ 判成孤儿（C1 不是恒真）',
    found.includes('nobodyCallsMe') && found.includes('alsoNobody') && !found.includes('keep'),
    'orphans=' + found.join(','));
}

const failed = results.filter((r) => !r.ok).length;
console.log('\n' + (failed ? '✗ ' + failed + ' / ' + results.length + ' 条判据未通过'
  : '✓ 全部 ' + results.length + ' 条判据通过'));
process.exit(failed ? 1 : 0);
