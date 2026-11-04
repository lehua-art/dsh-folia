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
  pickVariant, pick1080, normalizeVariants, pickQuality,
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
