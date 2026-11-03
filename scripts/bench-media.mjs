#!/usr/bin/env node
/**
 * bench-media.mjs — **媒体下载基准**：先量差距，再决定要不要上 HTTP/2。
 *
 * 为什么单独一个脚本、而且**不进门禁**：它要真连站点、真下载几 MB、真跑 curl。
 * 放进 `test/` 会被 `test/run-audit.mjs` 自动捡起来跑，既慢又依赖网络 ——
 * 基准是"决定要不要改传输层"的取证工具，不是每次发版都得复现的判据。
 *
 * 量两件事：
 *   A. **同一张站点壁纸**：`curl` 单流 vs 插件队列（`lib/download-queue.js`）下载耗时/吞吐。
 *      这是"我们比别人慢吗"的直接对照（curl 是同一条 CDN 上能做到的上限）。
 *   B. **3 个文件并行**：HTTP/1.1（现状，每条连接一个请求） vs HTTP/2（单连接多路复用）。
 *      用 `node:http2` 直连站点（ALPN 协商 h2）。若协商不到 h2 / 出错 ⇒ 如实报「未验证」，
 *      **不**编一个数字。
 *
 * 结论判据（写死在这里，避免"看数字挑结论"）：HTTP/2 并行吞吐比 HTTP/1.1 高出 **>10%**
 * 才值得改传输层；否则明确放弃，保留 HTTP/1.1。
 *
 * 用法：
 *   node scripts/bench-media.mjs                 # 自动从站点清单挑 3 个小文件
 *   node scripts/bench-media.mjs --url <URL>     # 指定单流对照用的 URL
 *   node scripts/bench-media.mjs --max-mb 8      # 允许挑到多大的文件（默认 6 MB）
 *   node scripts/bench-media.mjs --json          # 只输出机器可读结果
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { connect as h2connect } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDownloadQueue } from '../lib/download-queue.js';

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const AS_JSON = args.includes('--json');
const MAX_MB = Number(argOf('max-mb', '6')) || 6;
const SITE = (process.env.DSH_FOLIA_SITE && process.env.DSH_FOLIA_SITE !== 'off'
  ? process.env.DSH_FOLIA_SITE : 'https://folia-5ve.pages.dev').replace(/\/+$/, '');
const HOME = join(tmpdir(), 'folia-bench-' + Date.now());
const say = (...a) => { if (!AS_JSON) process.stdout.write(a.join(' ') + '\n'); };
const mb = (n) => (n / 1048576).toFixed(2);
const mbs = (bytes, ms) => (ms > 0 ? (bytes / 1048576) / (ms / 1000) : 0);

/** 站点清单里挑"够大能测吞吐、又不大到拖时间"的几条。 */
async function pickUrls() {
  const forced = argOf('url', '');
  const r = await fetch(SITE + '/api/public/wallpapers?limit=100', { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error('site-http-' + r.status);
  const doc = await r.json();
  const items = (doc && doc.data && doc.data.items) || [];
  const cap = MAX_MB * 1048576;
  const usable = items
    // 下限 1 MB：更小的文件里**延迟**（DNS+TLS+TTFB）压过吞吐，量出来的是 RTT 不是带宽。
    .filter((it) => it && it.url && Number(it.bytes) >= 1048576 && Number(it.bytes) <= cap)
    .sort((a, b) => Number(a.bytes) - Number(b.bytes));
  if (!usable.length) throw new Error('no-candidate-between-1MB-and-' + MAX_MB + 'MB');
  // 单流对照用**最大**的一条（吞吐才占主导）；并行用最大的 3 条（量级接近才可比）。
  const biggest = usable[usable.length - 1];
  const single = forced || biggest.url;
  const parallel = (forced ? [single, ...usable.slice(-2).map((u) => u.url)] : usable.slice(-3).map((u) => u.url)).slice(0, 3);
  return { single, parallel, bytes: Number(biggest.bytes) || 0 };
}

/** curl 单流：返回 { ms, bytes }。curl 是"这条线路上别人能做到的"参照物。 */
function curlOnce(url, out) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const p = spawn('curl', ['-sS', '-L', '--max-time', '120', '-o', out, '-w', '%{size_download}', url], { windowsHide: true });
    let acc = '';
    p.stdout.on('data', (d) => { acc += String(d); });
    p.stderr.on('data', () => { /* 进度/告警不入账 */ });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) { reject(new Error('curl-exit-' + code)); return; }
      resolve({ ms: Date.now() - started, bytes: Number(acc.trim()) || 0 });
    });
  });
}

/** 插件队列单流：与产品里**同一份实现**（含 HEAD 预检 / Range / 原子 rename）。 */
async function queueOnce(url) {
  const home = join(HOME, 'queue');
  mkdirSync(home, { recursive: true });
  const dest = join(HOME, 'queue', 'bench.bin');
  const q = createDownloadQueue({ home, log: () => {} });
  const started = Date.now();
  q.add({ url, dest, kind: 'wallpaper', priority: 'high' });
  for (;;) {
    const j = q.snapshot().find((x) => x.dest === dest);
    if (j && j.status === 'done') {
      return { ms: Date.now() - started, bytes: j.total || (() => { try { return statSync(dest).size; } catch { return 0; } })() };
    }
    if (j && (j.status === 'failed' || j.status === 'cancelled')) throw new Error('queue-' + j.status + ':' + (j.error || ''));
    if (Date.now() - started > 120000) throw new Error('queue-timeout');
    await new Promise((res) => { setTimeout(res, 50); });
  }
}

/** HTTP/1.1 并行：3 条连接各一个请求（= 我们队列今天的形态）。 */
async function h1Parallel(urls) {
  const started = Date.now();
  const bytes = await Promise.all(urls.map(async (u) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('http-' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length;
  }));
  return { ms: Date.now() - started, bytes: bytes.reduce((a, b) => a + b, 0) };
}

/** HTTP/2 并行：**一条** TLS 连接上多路复用 3 条流（ALPN 协商不到 h2 就抛）。 */
async function h2Parallel(urls) {
  const origin = new URL(urls[0]).origin;
  const started = Date.now();
  const client = h2connect(origin);
  try {
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    if (!client.remoteSettings) throw new Error('no-h2-settings');
    const bytes = await Promise.all(urls.map((u) => new Promise((resolve, reject) => {
      const path = new URL(u).pathname + (new URL(u).search || '');
      const req = client.request({ ':method': 'GET', ':path': path });
      let n = 0;
      req.on('response', (headers) => {
        if (Number(headers[':status']) >= 400) { reject(new Error('h2-http-' + headers[':status'])); return; }
      });
      req.on('data', (chunk) => { n += chunk.length; });
      req.on('end', () => resolve(n));
      req.on('error', reject);
      req.end();
    })));
    return { ms: Date.now() - started, bytes: bytes.reduce((a, b) => a + b, 0) };
  } finally {
    try { client.close(); } catch { /* ignore */ }
  }
}

async function main() {
  mkdirSync(HOME, { recursive: true });
  const picked = await pickUrls();
  say('站点：' + SITE);
  say('样本：' + picked.single + '（清单声明 ' + mb(picked.bytes) + ' MB）');
  say('');

  // ── A. 单流：curl vs 插件队列 ──────────────────────────────────────────
  let a;
  try {
    const curlOut = join(HOME, 'curl.bin');
    const c = await curlOnce(picked.single, curlOut);
    const q = await queueOnce(picked.single);
    const curlMbs = mbs(c.bytes, c.ms);
    const queueMbs = mbs(q.bytes, q.ms);
    a = {
      curl: { ms: c.ms, bytes: c.bytes, mbs: +curlMbs.toFixed(3) },
      queue: { ms: q.ms, bytes: q.bytes, mbs: +queueMbs.toFixed(3) },
      ratio: curlMbs > 0 ? +(queueMbs / curlMbs).toFixed(2) : null,
    };
  } catch (e) { a = { error: String((e && e.message) || e) }; }

  // ── B. 并行：HTTP/1.1 vs HTTP/2 ───────────────────────────────────────
  let b;
  try {
    const h1 = await h1Parallel(picked.parallel);
    let h2 = null;
    let h2err = null;
    try { h2 = await h2Parallel(picked.parallel); } catch (e) { h2err = String((e && e.message) || e); }
    b = {
      files: picked.parallel.length,
      h1: { ms: h1.ms, bytes: h1.bytes, mbs: +mbs(h1.bytes, h1.ms).toFixed(3) },
      h2: h2 ? { ms: h2.ms, bytes: h2.bytes, mbs: +mbs(h2.bytes, h2.ms).toFixed(3) } : null,
      h2Error: h2err,
      gain: h2 && h1.ms > 0 ? +(((h1.ms - h2.ms) / h1.ms) * 100).toFixed(1) : null,
    };
  } catch (e) { b = { error: String((e && e.message) || e) }; }

  // ── 结论（判据写死在文件头）───────────────────────────────────────────
  const h2Gain = (b.h1 && b.h2) ? ((b.h1.ms - b.h2.ms) / b.h1.ms) * 100 : null;
  const h2Worth = Boolean(h2Gain !== null && h2Gain > 10);
  const verdict = b.error ? 'HTTP/2：未验证（并行对照失败：' + b.error + '）⇒ 保留 HTTP/1.1'
    : !b.h2 ? 'HTTP/2：未验证（' + (b.h2Error || 'no h2') + '）⇒ 保留 HTTP/1.1'
      : h2Worth ? 'HTTP/2：并行快 ' + b.gain + '%（>10%）⇒ 值得跟进'
        : 'HTTP/2：并行反而' + (b.gain <= 0 ? '慢 ' + Math.abs(b.gain) + '%' : '只快 ' + b.gain + '%')
          + '（判据 >10% 才换）⇒ **放弃**，保留 HTTP/1.1';

  const out = { at: new Date().toISOString(), site: SITE, singleUrl: picked.single, a, b, h2Worth, h2Gain, verdict };
  if (AS_JSON) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); }
  else {
    say('── A. 同一文件：curl 单流 vs 插件队列 ──');
    if (a.error) say('  失败：' + a.error);
    else {
      say('  curl  ：' + a.curl.ms + ' ms  ' + mb(a.curl.bytes) + ' MB  ' + a.curl.mbs + ' MB/s');
      say('  queue ：' + a.queue.ms + ' ms  ' + mb(a.queue.bytes) + ' MB  ' + a.queue.mbs + ' MB/s');
      say('  比值  ：' + a.ratio + '×  curl（1.0 = 同速；<1 = 我们更慢）');
    }
    say('');
    say('── B. 3 个文件并行：HTTP/1.1 vs HTTP/2 ──');
    if (b.error) say('  失败：' + b.error);
    else {
      say('  HTTP/1.1：' + b.h1.ms + ' ms  ' + b.h1.mbs + ' MB/s');
      say('  HTTP/2  ：' + (b.h2 ? b.h2.ms + ' ms  ' + b.h2.mbs + ' MB/s' : '未验证（' + b.h2Error + '）'));
      if (b.h2) say('  提速    ：' + b.gain + '%');
    }
    say('');
    say('结论：' + verdict);
  }
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((e) => {
  process.stderr.write('bench 失败：' + ((e && e.message) || e) + '\n');
  try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
