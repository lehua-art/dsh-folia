/**
 * verify-capabilities.mjs — 「能力」设置页签的判据。
 *
 * 守四件事（都是这次接线时实际踩过/易漏的点）：
 *   C1 组件文件存在且三个构建标记齐全（build-client 按标记做结构校验）
 *   C2 构建内联清单里登记了该文件（漏了 ⇒ 产物里没有这段代码）
 *   C3 宿主路由 /pet-chat/capabilities 已注册
 *   C4 一级设置项 id=folia-capabilities 已在 client.js 注册
 *   C5 weT 用到的中文词都在 i18n 表里（漏词 ⇒ 英文环境显示中文）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');

// ── C1 组件与标记 ─────────────────────────────────────────────────────────────
const panel = read('src/panel-tabs-work.js');
check('C1a src/panel-tabs-work.js 存在', panel.length > 0);
for (const marker of ['function CapabilitiesSection()', 'function CapabilityCard(', 'const CAP_STATUS_TEXT = ']) {
  check(`C1b 组件标记存在：${marker}`, panel.includes(marker));
}
check('C1c 组件不做一键安装（不出现 install 接口调用）',
  !/dsh-market\/install|\/pet-chat\/.*install/i.test(panel));
check('C1d 组件不用 JSX / 裸 fetch',
  !/<[A-Z][A-Za-z]*\s/.test(panel) && !/\bfetch\s*\(/.test(panel));

// ── C2 构建清单 ───────────────────────────────────────────────────────────────
const build = read('scripts/build-client.mjs');
check('C2 构建内联清单登记了 src/panel-tabs-work.js', build.includes("src/panel-tabs-work.js"));

// ── C3 宿主路由 ───────────────────────────────────────────────────────────────
const route = read('lib/routes/pet-chat.js');
check('C3 路由 /pet-chat/capabilities 已注册', route.includes("tail === '/capabilities'"));
check('C3b 路由处理器 handleCapabilities 存在', route.includes('function handleCapabilities('));

// ── C4 一级设置项 ─────────────────────────────────────────────────────────────
const client = read('src/client.js');
check('C4 一级设置项 folia-capabilities 已注册', client.includes('folia-capabilities'));

// ── C5 i18n 词 ────────────────────────────────────────────────────────────────
const i18n = read('src/i18n-copy-panel.js');
const words = [...panel.matchAll(/weT\('([^']+)'\)/g)].map((m) => m[1]);
const unique = [...new Set(words)];
const missing = unique.filter((w) => !i18n.includes(`"${w}":`));
check('C5 组件里所有 weT 词都在 i18n 表里', missing.length === 0,
  missing.length ? '缺：' + missing.join(', ') : `${unique.length} 个词全在册`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exitCode = 1;
