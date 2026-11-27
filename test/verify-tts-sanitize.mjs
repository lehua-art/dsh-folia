/**
 * verify-tts-sanitize.mjs — v1.2 判据 V3/V4/V5 的**纯函数面**：
 *   合成输入不含 Markdown / URL / emoji / 句读标点；3.14 与 10:30 不被破坏；
 *   歌词只去 Markdown/URL；缓存键按清洗后文本；queue 句间有 200–350ms 静音。
 * 不依赖 TTS 引擎（SAPI/Edge 实听是人工验收项 V4）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizeForSpeech, sanitizeLyrics, normalizeTtsText, ttsCacheKey, TTS_MAX_CHARS,
} from '../lib/tts/tts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

/* ① 附录 A 的样例逐字对齐 */
const appendix = sanitizeForSpeech('**好消息**！我帮你查到了：https://example.com，耗时 3.14 秒。');
check('V3① 附录样例：去 Markdown/URL/标点，保留 3.14',
  appendix === '好消息 我帮你查到了 链接 耗时 3.14 秒', appendix);

/* ② 各类符号都不进合成 */
const dirty = '## 标题\n- 第一项\n> 引用\n`code` **粗** _斜_ [文字](https://a.b) me@example.com 😀✨（叹气）';
const clean = sanitizeForSpeech(dirty);
check('V3② Markdown/链接/邮箱/emoji/括号都不念',
  !/[#*_`|>[\]]/.test(clean) && !clean.includes('https') && !clean.includes('@')
  && !clean.includes('😀') && clean.includes('文字') && clean.includes('叹气'), clean);

/* ③ 数字保护 */
const numbers = sanitizeForSpeech('时间 10:30，价格 1,000 元，版本 1.2.0，比例 3.14%。');
check('V3③ 时间/千分位/小数/版本不被标点清洗破坏',
  numbers.includes('10:30') && numbers.includes('1,000') && numbers.includes('3.14') && numbers.includes('1.2.0'),
  numbers);

/* ④ 代码块：不把代码念出来 */
const code = sanitizeForSpeech('```js\nconst a = 1;\n```\n代码后面的话');
check('V3④ 代码块 → 一段代码，代码内容不念', code.includes('一段代码') && !code.includes('const'), code);

/* ⑤ 空串不合成 */
check('V3⑤ 纯符号/空串 → 空串（调用方不合成）',
  sanitizeForSpeech('***') === '' && sanitizeForSpeech('   ') === '' && sanitizeForSpeech(null) === '');

/* ⑥ 截断仍受 TTS_MAX_CHARS 约束 */
const long = sanitizeForSpeech('字'.repeat(400));
check('V3⑥ 清洗后仍按 ' + TTS_MAX_CHARS + ' 字截断', [...long].length === TTS_MAX_CHARS, 'len=' + [...long].length);

/* ⑦ 缓存键：不同标点、同一朗读文本 ⇒ 同一个 key */
const keyA = ttsCacheKey('sapi', 'v', 0, '你好，世界。');
const keyB = ttsCacheKey('sapi', 'v', 0, '你好 世界');
check('V3⑦ 缓存键用清洗后文本（不同标点不重复合成）', keyA === keyB, keyA.slice(0, 12) + ' / ' + keyB.slice(0, 12));

/* ⑧ normalizeTtsText 与 sanitize 同源 */
check('V3⑧ normalizeTtsText 走 sanitize（不再只折叠空白）',
  normalizeTtsText('**嗨**！https://x.y 3.14') === '嗨 链接 3.14', normalizeTtsText('**嗨**！https://x.y 3.14'));

/* ⑨ 歌词只去 Markdown/URL，保留标点与文字 */
const lyric = sanitizeLyrics('# 第一行 **歌词** https://a.b，第二句。');
check('V5① 歌词只去 Markdown/URL（标点保留）',
  lyric.includes('第一行') && lyric.includes('歌词') && !lyric.includes('http') && lyric.includes('，'), lyric);

/* ⑩ 句间静音：队列在两句之间插 200–350ms（源码常量 + 调用点） */
const ttsClient = readFileSync(join(ROOT, 'src', 'pet-tts.js'), 'utf8');
const gap = Number((ttsClient.match(/PET_TTS_GAP_MS\s*=\s*(\d+)/) || [])[1]);
check('V4① 句间静音 200–350ms（不靠标点让引擎停顿）',
  gap >= 200 && gap <= 350 && /setTimeout\(resolve, PET_TTS_GAP_MS\)/.test(ttsClient), 'gap=' + gap);

/* ⑪ 所有入口统一：/tts、/tts/preview、/speak 都走 normalizeTtsText */
const route = readFileSync(join(ROOT, 'lib', 'routes', 'pet-chat.js'), 'utf8');
const ttsEntry = route.slice(route.indexOf('async function handleTts('), route.indexOf('function handleTtsStop('));
const previewEntry = route.slice(route.indexOf('async function handleVoicePreview('), route.indexOf('async function handleTts('));
check('V3⑨ /tts 与 /tts/preview 都在路由层清洗',
  /normalizeTtsText\(/.test(ttsEntry) && /normalizeTtsText\(/.test(previewEntry),
  `tts=${/normalizeTtsText\(/.test(ttsEntry)} preview=${/normalizeTtsText\(/.test(previewEntry)}`);

/* ⑫ 故事模式分批：客户端有 group + 批次，宿主单次 240 字上限不被突破 */
check('V5② 故事 TTS 分批（2 句一段 + group 合并）',
  /speechBatch/.test(readFileSync(join(ROOT, 'src', 'pet-chat.js'), 'utf8'))
  && /group: 2/.test(readFileSync(join(ROOT, 'src', 'pet-tts.js'), 'utf8')),
  'client batch + tts group');

const failed = results.filter((item) => !item.ok);
console.log(`\nTTS SANITIZE CHECKS ${failed.length ? 'FAILED' : 'PASSED'} — ${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
