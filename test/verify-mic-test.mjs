/**
 * verify-mic-test.mjs — 麦克风"获取不到声音"专项（pre.58）
 *
 * 纪律（本轮要钉死的）：
 *   ① 探针静音**绝不允许**当成"没有麦克风"（no-signal 必须消失）
 *   ② 点桌宠立刻开录：probeMs 默认 0，探测只用于排序
 *   ③ 失败也保留录音（lastWav / lastWavBytes），供界面回放
 *   ④ 有 /pet-chat/voice/mic-test：固定 3 秒原声，返回 audio/wav + 诊断头
 *   ⑤ 只有"设备打不开"才允许 open-failed
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const record = read('lib/voice/record.js');
const route = read('lib/routes/pet-chat.js');
const panel = read('src/panel-tabs-assistant.js');
const i18n = read('src/i18n-copy-panel.js');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ① no-signal 彻底消失
check('① record.js 里不再有 no-signal 判定', !/code:\s*'no-signal'/.test(record));
check('① 路由提示里也不再宣传 no-signal', !/'no-signal'/.test(route));

// ② 探针默认关闭，只用于排序
check('② probeMs 默认 0（点完立刻录）', /probeMs:\s*0/.test(record));
check('② 探测只在 probeMs > 0 时执行', /if\s*\(opts\.probeMs\s*>\s*0\)/.test(record));

// ③ 失败保留录音
check('③ 失败分支里有 lastWav', /lastWav:/.test(record) && /lastWav:/.test(route));
check('③ 路由把 attempts/devices 回给前端', /attempts:\s*result\.attempts/.test(route));

// ④ mic-test 接口
check('④ 存在 /voice/mic-test 分发', /\/voice\/mic-test/.test(route));
check('④ mic-test 返回 audio/wav', /audio\/wav/.test(route));
check('④ mic-test 带 RMS 响应头', /X-Folia-Mic-Rms/.test(route));
check('④ recorder 暴露 recordFixed', /recordFixed/.test(record));

// ⑤ 只有设备打不开才 open-failed
check('⑤ open-failed 只在 bytes < 1024 时出现', /open-failed/.test(record) && /bytes\s*<\s*1024/.test(record));

// ⑥ 前端有「测试麦克风」并会播回
check('⑥ 前端有 MicTestBlock', /MicTestBlock/.test(panel));
check('⑥ 前端调 /voice/mic-test', /pet-chat\/voice\/mic-test/.test(panel));
check('⑥ 文案进 i18n', /"测试麦克风":/.test(i18n) && /"麦克风测试":/.test(i18n));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  console.log('失败项：' + failed.map((r) => r.name).join('、'));
  process.exitCode = 1;
}
