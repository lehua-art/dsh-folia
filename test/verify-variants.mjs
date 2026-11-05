/**
 * verify-variants.mjs — **1080p 变体选档**（4.23.4，策略 A 自动）的判据。
 *
 * 背景（站点 d960c62 起带 `variants`）：视频壁纸常常另有一档 1080p 轻量版。
 * 用户确认的策略是**先原画、必要时才降档**：
 *   · 前 3 秒实测 < 0.6 MB/s（与下载队列的自适应阈值**同一个数**）；
 *   · 或 原画 > 20 MB 且屏幕高度 ≤ 1440（看起来没差别，但省一半流量与解码）；
 *   · `videoQuality=original` 永远原画；变体缺失 / url 非法一律原画。
 *
 * 判据分三层（每层都配负对照）：
 *   ① **纯函数**：`pickVariant` / `pick1080` / `normalizeVariants` 真跑（假数据驱动）；
 *   ② **行为**：`/folia/downloads/add` 真的按选档入队，且 `job.chosenVariant` 出现在
 *      `/folia/downloads/list`（排障与面板读同一个事实）；
 *   ③ **透传**：inventory 条目必须带 `variants`（站点一上线字段就能用，无需再改客户端）。
 *
 * 站点上 variants 还没出现时的回退结论也在 ① 里逐条钉住：**没有字段 ⇒ 原画 ⇒ 与 4.23.3 等价**。
 */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  pickVariant, pick1080, pick4k30, normalizeVariants, pickQuality, resolveMediaExpectation,
  SLOW_MBPS, BIG_ORIGINAL_BYTES, SAVER_SCREEN_MAX, QUALITY_MODES,
} from '../lib/variant-pick.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, cond, detail) { results.push({ name, ok: Boolean(cond), detail }); }

/* ── ① 纯函数 ─────────────────────────────────────────────────────────────── */
{
  const ORIG = 'https://site.example/media/original.mp4';
  const V1080 = { label: '1080p', height: 1080, bytes: 5 * 1024 * 1024, url: 'https://site.example/media/original-1080.mp4' };
  const base = { originalUrl: ORIG, originalBytes: 33 * 1024 * 1024, variants: [V1080], quality: 'auto', screenHeight: 2160, hostSlow: false };

  check('① 站点没有 variants 字段 ⇒ 原画（4.23.3 行为）',
    (() => { const r = pickVariant({ originalUrl: ORIG, originalBytes: 33 * 1024 * 1024 }); return r.chosen === 'original' && r.url === ORIG && r.reason === 'no-variant'; })(),
    JSON.stringify(pickVariant({ originalUrl: ORIG })));
  check('① variants 是空数组 ⇒ 原画', pickVariant({ ...base, variants: [] }).chosen === 'original');
  check('① variants 全是非法 url ⇒ 原画（不因为一条坏数据整单失败）',
    (() => {
      const r = pickVariant({ ...base, variants: [{ height: 1080, url: 'javascript:alert(1)' }, { height: 1080, url: 'not a url' }] });
      return r.chosen === 'original' && r.url === ORIG;
    })());
  check('① 慢链路（队列 3 秒实测 < 0.6 MB/s）+ 有 1080p ⇒ 1080p',
    (() => { const r = pickVariant({ ...base, hostSlow: true }); return r.chosen === '1080p' && r.url === V1080.url && r.height === 1080 && r.reason === 'slow-link'; })(),
    JSON.stringify(pickVariant({ ...base, hostSlow: true })));
  check('① 原画 > 20 MB 且屏幕高度 = 1440 ⇒ 1080p（差一像素也要判得对）',
    (() => {
      const r1440 = pickVariant({ ...base, screenHeight: 1440 });
      const r1441 = pickVariant({ ...base, screenHeight: 1441 });
      return r1440.chosen === '1080p' && r1440.reason === 'big-file-small-screen' && r1441.chosen === 'original';
    })());
  check('① 原画 ≤ 20 MB（哪怕屏幕很小）⇒ 原画（不为小文件白折腾）',
    pickVariant({ ...base, originalBytes: BIG_ORIGINAL_BYTES, screenHeight: 1080 }).chosen === 'original');
  check('① 屏幕高度未知（0）⇒ 只按速度判，不猜',
    pickVariant({ ...base, screenHeight: 0 }).chosen === 'original'
    && pickVariant({ ...base, screenHeight: 0, hostSlow: true }).chosen === '1080p');

  /* ── 4.23.19：同分辨率 30fps 变体（站点 label `4K30`）────────────────────── */
  const V4K30 = {
    label: '4K30', height: 2160, fps: 30, bytes: 12 * 1024 * 1024,
    url: 'https://site.example/media/original-4k30.mp4', sha256: 'b'.repeat(64),
  };
  check('① normalizeVariants 保留 label 与 fps（4K30 的识别依据）',
    (() => { const v = normalizeVariants([V4K30])[0]; return Boolean(v) && v.label === '4K30' && v.fps === 30; })(),
    JSON.stringify(normalizeVariants([V4K30])));
  check('① 原画 3840×2160@60 + 变体 {label:4K30,height:2160,fps:30} ⇒ 选 4k30（hifps-variant）',
    (() => {
      const r = pickVariant({
        originalUrl: ORIG, originalBytes: 40 * 1024 * 1024, variants: [V4K30],
        originalWidth: 3840, originalHeight: 2160, originalFps: 60, quality: 'auto',
      });
      return r.chosen === '4k30' && r.url === V4K30.url && r.height === 2160 && r.reason === 'hifps-variant';
    })(),
    JSON.stringify(pickVariant({
      originalUrl: ORIG, originalBytes: 40 * 1024 * 1024, variants: [V4K30],
      originalWidth: 3840, originalHeight: 2160, originalFps: 60, quality: 'auto',
    })));
  check('① 4K@60 + 只有 1080p ⇒ 原画（不把 4K 降成 1080p 来治帧率）',
    (() => {
      const r = pickVariant({
        originalUrl: ORIG, originalBytes: 40 * 1024 * 1024, variants: [V1080],
        originalWidth: 3840, originalHeight: 2160, originalFps: 60, quality: 'auto',
      });
      return r.chosen === 'original' && r.reason === 'high-fps';
    })());
  check('① 5916×2530 + {4K30,1080p} ⇒ 仍 1080p（decode-limit 优先于降帧）',
    (() => {
      const r = pickVariant({
        originalUrl: ORIG, originalBytes: 40 * 1024 * 1024, variants: [V4K30, V1080],
        originalWidth: 5916, originalHeight: 2530, originalFps: 60, quality: 'auto',
      });
      return r.chosen === '1080p' && r.url === V1080.url && r.reason === 'decode-limit';
    })());
  check('① 无匹配变体（只有 720p）⇒ 原画（回落，绝不顺手降 720p）',
    (() => {
      const r = pickVariant({
        originalUrl: ORIG, variants: [{ label: '720p', height: 720, url: 'https://site.example/media/x-720.mp4' }],
        originalWidth: 3840, originalHeight: 2160, originalFps: 60, quality: 'auto',
      });
      return r.chosen === 'original';
    })());
  /* ── 4.23.21（P0-B）：「1080p 档」是**矩形**，不是 height===1080 ─────────────
   * QA 实测：「原神 钟离」4320×2160，站点唯一变体 1920×960（url 名 .1080p.mp4）。
   * 旧判据只认 height===1080 ⇒ 不命中 ⇒ chosenVariant=original ⇒ 4K@60 仍靠客户端转码。 */
  const V960 = {
    height: 960, width: 1920, bytes: 4 * 1024 * 1024,
    url: 'https://site.example/media/original.1080p.mp4',
  };
  const orig4320 = {
    originalUrl: ORIG, originalBytes: 40 * 1024 * 1024, variants: [V960],
    originalWidth: 4320, originalHeight: 2160, originalFps: 60, quality: 'auto',
  };
  check('P0-B 4320×2160 + 唯一变体 {height:960,width:1920} ⇒ 选它，chosenVariant=1080p',
    (() => {
      const r = pickVariant(orig4320);
      return r.chosen === '1080p' && r.url === V960.url && r.reason === 'decode-limit';
    })(), JSON.stringify(pickVariant(orig4320)));
  check('P0-B pick1080 直接命中 1920×960（几何落在 1080p 档内：宽≤1920 且 高≤1080）',
    (() => { const v = pick1080(normalizeVariants([V960])); return Boolean(v) && v.url === V960.url; })(),
    JSON.stringify(pick1080(normalizeVariants([V960]))));
  check('P0-B normalizeVariants 保留 width（没有它分不开 1920×960 与 720p）',
    normalizeVariants([V960])[0].width === 1920);
  check('P0-B 1920×1080 原画 + 无变体 ⇒ original（小屏原画不许白折腾）',
    (() => {
      const r = pickVariant({
        originalUrl: 'https://site.example/media/fhd.mp4', originalBytes: 8 * 1024 * 1024,
        variants: [], originalWidth: 1920, originalHeight: 1080, originalFps: 30, quality: 'auto',
      });
      return r.chosen === 'original' && r.reason === 'no-variant';
    })());
  check('P0-B 3840×2160 + 变体 {height:2160,fps:30,label:4K30} ⇒ 选 4k30（1080p 矩形不抢这一档）',
    (() => {
      const r = pickVariant({
        originalUrl: ORIG, originalBytes: 40 * 1024 * 1024, variants: [V4K30],
        originalWidth: 3840, originalHeight: 2160, originalFps: 60, quality: 'auto',
      });
      return r.chosen === '4k30' && r.url === V4K30.url;
    })());
  check('P0-B 720p（1280×720，几何完整）仍在档外 —— 面积下限挡住"顺手降 720p"',
    pick1080(normalizeVariants([{ height: 720, width: 1280, url: 'https://site.example/media/x-720.mp4' }])) === null);
  check('P0-B 多档命中取**面积最大**：{1280×720, 1920×960} ⇒ 1920×960',
    (() => {
      const v = pick1080(normalizeVariants([
        { height: 720, width: 1280, url: 'https://site.example/media/x-720.mp4' },
        V960,
      ]));
      return Boolean(v) && v.url === V960.url;
    })());
  check('P0-B 负对照：把旧判据 `height===1080` 贴回 ⇒ 上面第一条会红（1920×960 不命中）',
    (() => {
      const legacyPick1080 = (list) => {
        const l = Array.isArray(list) ? list : [];
        if (!l.length) return null;
        return l.find((v) => v && Number(v.height) === 1080)
          || l.find((v) => v && /1080/.test(String(v.label || ''))) || null;
      };
      const old = legacyPick1080(normalizeVariants([V960]));
      return old === null && pick1080(normalizeVariants([V960])) !== null;
    })());
  check('① 负对照：**去掉 label 与 fps 保留** ⇒ 2160 变体认不出（回到原画）',
    (() => {
      const bare = { height: 2160, bytes: 12 * 1024 * 1024, url: 'https://site.example/media/bare-2160.mp4' };
      const r = pickVariant({
        originalUrl: ORIG, variants: [bare], originalWidth: 3840, originalHeight: 2160, originalFps: 60,
      });
      return pick4k30(normalizeVariants([bare]), 2160) === null && r.chosen === 'original';
    })());
  check('① 4k30 的期望值取**变体自己**的 sha/bytes（不是原画）',
    (() => {
      const e = resolveMediaExpectation({
        url: ORIG, bytes: 40 * 1024 * 1024, sha256: 'a'.repeat(64),
        variants: [V4K30], chosenUrl: V4K30.url,
      }, '4k30');
      return e.source === 'variant' && e.url === V4K30.url && e.sha256 === 'b'.repeat(64) && e.bytes === V4K30.bytes;
    })());

  check('① videoQuality=original ⇒ **永远**原画（慢链路/大文件都不许降）',
    (() => {
      const slow = pickVariant({ ...base, quality: 'original', hostSlow: true, screenHeight: 900 });
      const big = pickVariant({ ...base, quality: 'original', screenHeight: 1080 });
      return slow.chosen === 'original' && slow.url === ORIG && slow.reason === 'quality-original'
        && big.chosen === 'original' && big.url === ORIG;
    })());
  check('① videoQuality=saver ⇒ 只要有合法变体就降',
    pickVariant({ ...base, quality: 'saver', originalBytes: 1024, screenHeight: 2160 }).chosen === '1080p');
  check('① 非法/缺失的 quality 一律按 auto（不偷偷改画质）',
    pickQuality('ORIGINAL?') === 'auto' && pickQuality(undefined) === 'auto' && QUALITY_MODES.join(',') === 'auto,original,saver');
  check('① 变体相对 url 按站点基址补全（站点若给相对地址也能用）',
    pickVariant({ ...base, base: 'https://site.example', hostSlow: true, variants: [{ height: 1080, url: '/media/v1080.mp4' }] }).url === 'https://site.example/media/v1080.mp4');
  check('① 只有 720p 一档时**不冒充** 1080p（不降档也降不到 1080）',
    pick1080(normalizeVariants([{ height: 720, url: 'https://x/y.mp4' }])) === null);
  check('① 阈值与队列的自适应阈值是**同一个数**（两处各写一个 0.6 就会自相矛盾）',
    (() => {
      const q = readFileSync(join(ROOT, 'lib', 'download-queue.js'), 'utf8');
      const m = /const ADAPTIVE_SLOW_MBPS = ([0-9.]+);/.exec(q);
      return Boolean(m) && Number(m[1]) === SLOW_MBPS && SAVER_SCREEN_MAX === 1440 && BIG_ORIGINAL_BYTES === 20 * 1024 * 1024;
    })(), 'SLOW_MBPS=' + SLOW_MBPS);
  check('① negative control: 慢链路判定基于布尔上报，不靠"自己再量一次"（源码里没有第二处 0.6）',
    !/0\.6\s*\*\s*1024/.test(readFileSync(join(ROOT, 'lib', 'variant-pick.js'), 'utf8')));
}

/* ── ② 行为：/downloads/add 真的按选档入队，job.chosenVariant 出现在 list ──── */
{
  const home = mkdtempSync(join(tmpdir(), 'folia-variants-'));
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { registerDownloadsRoutes } = await import('../lib/routes/downloads.js');
    const routes = [];
    const deps = {
      disposers: [], base: '/folia', log: () => {},
      serveFile: () => { /* 本判据不读字节 */ },
    };
    registerDownloadsRoutes({ register: (spec) => { routes.push(spec); return () => {}; } }, deps);
    const find = (p) => routes.find((r) => r.path === p);

    const call = (route, { method = 'POST', body = null } = {}) => new Promise((resolveCall) => {
      const resObj = {
        statusCode: 0, headers: {},
        setHeader(k, v) { this.headers[k] = v; },
        end(s) { resolveCall({ status: this.statusCode, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }); },
      };
      const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))];
      const req = {
        method, url: route.path, headers: {},
        on(ev, fn) {
          if (ev === 'data') for (const c of chunks) fn(c);
          if (ev === 'end') setTimeout(fn, 0);
          if (ev === 'error') { /* 不触发 */ }
          return this;
        },
      };
      route.handler(req, resObj);
    });

    const ORIG = 'https://site.example/media/a.mp4';
    const V1080 = { label: '1080p', height: 1080, bytes: 5 * 1024 * 1024, url: 'https://site.example/media/a-1080.mp4' };

    // (a) 有 1080p 变体 + 慢域 + 屏幕 1440 ⇒ 入队的是变体 url，job 记 1080p
    const slow = await call(find('/folia/downloads/add'), {
      body: { items: [{ kind: 'wallpaper', url: ORIG, variants: [V1080], bytes: 33 * 1024 * 1024, screenHeight: 1440 }], quality: 'saver' },
    });
    const slowItem = slow.json && slow.json.items && slow.json.items[0];
    check('② 选档结论回在 add 的响应里（chosenVariant + reason + originalUrl）',
      Boolean(slowItem && slowItem.chosenVariant === '1080p' && slowItem.variantReason === 'quality-saver' && slowItem.originalUrl === ORIG),
      JSON.stringify(slowItem && { chosen: slowItem.chosenVariant, reason: slowItem.variantReason, url: slowItem.url }));
    check('② 入队的是**变体**地址（不是原画）',
      Boolean(slowItem && String(slowItem.url).includes('a-1080.mp4')), slowItem && slowItem.url);

    // (b) 同一张再以 quality=original 入队 ⇒ 换回原画（「用原画」走的就是这条）
    const forced = await call(find('/folia/downloads/add'), {
      body: { items: [{ kind: 'wallpaper', url: ORIG, variants: [V1080], bytes: 33 * 1024 * 1024, screenHeight: 1440, quality: 'original' }] },
    });
    const forcedItem = forced.json && forced.json.items && forced.json.items[0];
    check('② 「用原画」= 单项 quality=original ⇒ 原画地址入队、结论是 original',
      Boolean(forcedItem && forcedItem.chosenVariant === 'original' && forcedItem.variantReason === 'quality-original'),
      JSON.stringify(forcedItem && { chosen: forcedItem.chosenVariant, reason: forcedItem.variantReason }));

    // (c) 没有 variants ⇒ 原画，且与 4.23.3 的响应形状一致（不多报错）
    const plain = await call(find('/folia/downloads/add'), { body: { items: [{ kind: 'wallpaper', url: 'https://site.example/media/b.mp4' }] } });
    const plainItem = plain.json && plain.json.items && plain.json.items[0];
    check('② 没有 variants 的站点 ⇒ 原画入队且照常成功（线上字段缺席时的回退）',
      Boolean(plain.json && plain.json.ok === true && plainItem && plainItem.chosenVariant === 'original'
        && plainItem.url === 'https://site.example/media/b.mp4'),
      JSON.stringify(plainItem && { ok: plain.json.ok, chosen: plainItem.chosenVariant, url: plainItem.url }));

    // (d) /downloads/list 里能看到 chosenVariant（面板与排障读同一个事实）
    const list = await new Promise((resolveCall) => {
      const resObj = {
        statusCode: 0, headers: {},
        setHeader() { /* ignore */ },
        end(s) { resolveCall({ status: this.statusCode, json: (() => { try { return JSON.parse(s); } catch { return null; } })() }); },
      };
      find('/folia/downloads/list').handler({ method: 'GET', url: '/folia/downloads/list', headers: {}, on() { return this; } }, resObj);
    });
    const jobs = (list.json && list.json.jobs) || [];
    check('② `/downloads/list` 每条 job 都带 chosenVariant（可识别，不是 null）',
      jobs.length > 0 && jobs.every((j) => j.chosenVariant === 'original' || j.chosenVariant === '1080p'),
      JSON.stringify(jobs.map((j) => ({ url: j.url, v: j.chosenVariant }))));
    check('② 那条 1080p 的 job 在 list 里也是 1080p（不是只有 add 的响应里对）',
      jobs.some((j) => j.chosenVariant === '1080p' && String(j.url).includes('a-1080.mp4')));
    check('② 负对照：list 里不存在"没有 chosenVariant 字段"的 job',
      !jobs.some((j) => !Object.prototype.hasOwnProperty.call(j, 'chosenVariant')));
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ── ③ 透传：inventory 条目必须带 variants ────────────────────────────────── */
{
  const inv = readFileSync(join(ROOT, 'lib', 'routes', 'inventory.js'), 'utf8');
  check('③ inventory 条目透传 variants（站点一上线字段就能用）',
    /variants: \(pick && pick\.variants\) \|\| \[\]/.test(inv) && /chosenVariant:/.test(inv));
  check('③ 透传走同一个纯函数（清单时刻与入队时刻不会各判一套）',
    /pickVariant\(\{/.test(inv) && /variant-pick\.js/.test(inv));
  check('③ variants 为空时字段仍存在（[] / original），客户端不用做存在性判断',
    /variants: \(pick && pick\.variants\) \|\| \[\]/.test(inv) && /'original'/.test(inv));
  check('③ negative control: 把 variants 写成固定空数组的回头写法会被判出来',
    !/variants: \[\],\s*\n\s*chosenVariant: 'original',/.test(inv));
  const panel = readFileSync(join(ROOT, 'src', 'quick-panel.js'), 'utf8');
  check('③ 面板显示「1080p」小标 + 提供「用原画」切换',
    /chosenVariant === "1080p"/.test(panel) && /lfUseOriginal\(/.test(panel) && /lfPreferOriginal\(/.test(panel));
  check('③ 「用原画」写入的是**本地覆盖**（重新入队原画，不是一次性请求）',
    /lfPreferOriginalMap/.test(readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8'))
    && /quality = "original"|entry\.quality = "original"/.test(readFileSync(join(ROOT, 'src', 'local-first.js'), 'utf8')));
}

/* ── 汇总 ────────────────────────────────────────────────────────────────── */
let failed = 0;
for (const r of results) {
  if (r.ok) process.stdout.write('  ✓ ' + r.name + '\n');
  else { failed += 1; process.stdout.write('  ✗ ' + r.name + (r.detail ? ' — ' + r.detail : '') + '\n'); }
}
process.stdout.write('\n  ' + (results.length - failed) + ' 通过 / ' + failed + ' 失败\n');
if (failed) process.exit(1);
assert.ok(true);
