#!/usr/bin/env node
/**
 * fork-rename.mjs —— 把本仓从当前身份整体切换成另一个身份（改名 / 换仓库地址）。
 *
 * 用法：
 *   node scripts/fork-rename.mjs --slug folia --name "Folia Wallpaper" --dry-run
 *   node scripts/fork-rename.mjs --slug folia --repo https://github.com/lehua-art/dsh-wallpaper-engine
 *
 * 设计要点（踩过的坑都在这）：
 *   1. **当前身份从根 package.json 现读**，不写死 token。
 *      上一版把上游 slug 写死成常量，结果脚本把自己也改了 ⇒ 第二次跑时旧值变成了新值，
 *      语义静默漂移。现在换成「从 package.json 推导 currentSlug」。
 *   2. **脚本自身与 FORK.json 不参与替换**（SKIP_FILES）：否则脚本会重写自己。
 *   3. `--repo` 只替换**仓库主页**这种 URL：仓库名后面必须紧跟 `.git` / 引号 / 空白 / 结尾。
 *      `.../pull/173`、`.../graphs/contributors` 这类**上游贡献记录**必须原样保留 ——
 *      那是 MIT 署名义务的一部分，改写等于抹掉上游作者。
 *
 * 改完必须重建：
 *   node scripts/build-client.mjs
 * 因为子包 bundle 里的 `require("<主包名>")` 是构建期按根 package.json 的 name 生成的。
 *
 * 二进制资源（png/jpg/webm/ttf…）不在此脚本处理范围内 —— 图标、吉祥物立绘、字体属于
 * 素材授权范畴，见 FORK-PLAN.md 的「素材」一节，需要人工替换。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/fork-rename.mjs';
const FORK_JSON = 'FORK.json';

const SKIP_DIRS = new Set(['node_modules', '.git', '.github', 'dist', 'coverage', '.test-cache', '.npm-cache']);
const SKIP_FILES = new Set([SELF, FORK_JSON, 'package-lock.json']);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.webm', '.mp4', '.zip',
  '.ttf', '.otf', '.woff', '.woff2', '.pdf', '.gz', '.tgz',
]);
/** 构建产物：由 build-client.mjs 重新生成，不在这里改。 */
const isBuildArtifact = (rel) =>
  /^lib\/client.*\.js$/.test(rel) || /^packages\/[^/]+\/lib\/client\..*\.js$/.test(rel);

function parseArgs(argv) {
  const out = { slug: '', name: '', repo: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--slug') out.slug = argv[++i] || '';
    else if (a === '--name') out.name = argv[++i] || '';
    else if (a === '--repo') out.repo = argv[++i] || '';
    else throw new Error('Unknown argument: ' + a);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(out.slug || '')) {
    throw new Error('--slug must be kebab-case, e.g. --slug folia');
  }
  out.name = out.name || out.slug;
  if (out.repo && !/^https?:\/\/\S+$/.test(out.repo)) {
    throw new Error('--repo must be an absolute URL');
  }
  return out;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, acc);
    } else if (entry.isFile()) {
      acc.push(rel);
    }
  }
  return acc;
}

/** 从包名推导 slug：`dsh-plugin-folia` → `folia`（容忍 scope 前缀）。 */
function slugOfPackageName(name) {
  const bare = name.replace(/^@[^/]+\//, '');
  const m = /^dsh-plugin-(.+)$/.exec(bare);
  return m ? m[1] : bare;
}

function buildCfg(opts, rootPkg) {
  const currentSlug = slugOfPackageName(rootPkg.name);
  const prior = existsSync(join(ROOT, FORK_JSON))
    ? JSON.parse(readFileSync(join(ROOT, FORK_JSON), 'utf8'))
    : null;
  return {
    currentSlug,
    slug: opts.slug,
    ENV: opts.slug.replace(/-/g, '_').toUpperCase(),
    OLD_ENV: 'DSH_' + currentSlug.replace(/-/g, '_').toUpperCase() + '_',
    BRAND: opts.name.toUpperCase().replace(/[^A-Z0-9]+/g, ''),
    repo: opts.repo,
    fromRepo: (prior && prior.repo) || '',
  };
}

function apply(text, cfg) {
  let next = text;
  const hits = [];

  const bump = (label, from, to) => {
    if (!from || from === to) return;
    const n = next.split(from).length - 1;
    if (n > 0) {
      next = next.split(from).join(to);
      hits.push(`${label} ×${n}`);
    }
  };

  // 顺序敏感：先长后短，避免把包名前缀切碎。
  bump('env', cfg.OLD_ENV, 'DSH_' + cfg.ENV + '_');
  bump('slug', cfg.currentSlug, cfg.slug);
  bump('brand', cfg.currentSlug.replace(/-/g, '').toUpperCase(), cfg.BRAND);
  bump('brand', cfg.currentSlug, cfg.slug);

  if (cfg.repo) {
    // 只换「仓库主页」：仓库名后面必须紧跟 .git / 引号 / 空白 / 结尾。
    // .../pull/173、.../issues/122、.../graphs/contributors 这类上游贡献记录必须原样保留。
    const repoRe = /https:\/\/github\.com\/(?:elysia395|Fish-under-sea|lehua-art)\/[A-Za-z0-9._-]+?(?=\.git|["')\s]|$)/g;
    let n = 0;
    next = next.replace(repoRe, () => { n++; return cfg.repo; });
    if (n) hits.push(`repo ×${n}`);

    // 二次切换：把上一次记在 FORK.json 里的地址也一起换掉。
    if (cfg.fromRepo && cfg.fromRepo !== cfg.repo) {
      const esc = cfg.fromRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const again = new RegExp(esc + '(?=\\.git|["\')\\s]|$)', 'g');
      let k = 0;
      next = next.replace(again, () => { k++; return cfg.repo; });
      if (k) hits.push(`repo(re-switch) ×${k}`);
    }
  }
  return { next, hits };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(join(ROOT, 'package.json'))) throw new Error('run from the repo root');

  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const cfg = buildCfg(opts, rootPkg);

  if (cfg.currentSlug === cfg.slug && !opts.repo) {
    console.log(`current slug is already "${cfg.slug}" and no --repo given — nothing to do.`);
    return;
  }

  const files = walk(ROOT).filter((rel) => {
    if (SKIP_FILES.has(rel)) return false;
    if (isBuildArtifact(rel)) return false;
    if (SKIP_EXT.has(extname(rel).toLowerCase())) return false;
    return true;
  });

  const changed = [];
  for (const rel of files) {
    const abs = join(ROOT, rel);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const { next, hits } = apply(text, cfg);
    if (next === text) continue;
    changed.push({ rel, hits });
    if (!opts.dryRun) writeFileSync(abs, next, 'utf8');
  }

  const warnings = [];
  const manifests = [
    'package.json',
    ...readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => `packages/${d.name}/package.json`),
  ];
  const expected = 'dsh-plugin-' + cfg.slug;
  for (const rel of manifests) {
    const p = JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
    const want = rel === 'package.json' ? expected : `${expected}-${rel.split('/')[1]}`;
    if (p.name !== want) warnings.push(`${rel}: name is "${p.name}", expected "${want}"`);
  }

  console.log(opts.dryRun ? '=== DRY RUN (nothing written) ===' : '=== APPLIED ===');
  console.log(`slug: ${cfg.currentSlug} -> ${cfg.slug}   env: ${cfg.ENV}` + (cfg.repo ? `   repo: ${cfg.repo}` : ''));
  console.log(`files changed: ${changed.length}`);
  for (const c of changed.slice(0, 30)) console.log(`  ${c.rel}  [${c.hits.join(', ')}]`);
  if (changed.length > 30) console.log(`  … and ${changed.length - 30} more`);
  if (warnings.length) {
    console.log('WARNINGS:');
    for (const w of warnings) console.log('  ' + w);
  }

  if (!opts.dryRun) {
    const prior = existsSync(join(ROOT, FORK_JSON))
      ? JSON.parse(readFileSync(join(ROOT, FORK_JSON), 'utf8'))
      : {};
    writeFileSync(
      join(ROOT, FORK_JSON),
      JSON.stringify(
        {
          ...prior,
          upstream: 'https://github.com/elysia395/dsh-wallpaper-engine',
          license: 'MIT',
          slug: cfg.slug,
          envPrefix: 'DSH_' + cfg.ENV + '_',
          repo: cfg.repo || prior.repo || '',
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    console.log('\nnext:  node scripts/build-client.mjs   # 重建 8 个客户端产物');
  }
}

main();
