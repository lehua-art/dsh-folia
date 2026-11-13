#!/usr/bin/env node
/**
 * run-guards.mjs —— 守卫链的**显式有序清单 + 执行器**（`package.json` 的四条 scripts 都指向它）。
 *
 * ## 为什么需要它
 *
 * 此前 `verify` / `verify:docs` / `smoke` 各自是 `package.json` 里的一行 `&&` 链：
 * `verify` 一行 1.6KB / 43 条 `node test/xxx.mjs && …`。那行有两个问题：
 *   ① **不可读**：一条守卫的档位（硬 / 软）、它的参数（`--probe-spawn` / `--allow-skip`）、
 *      它在链里的位置，全都要人肉在 `&&` 之间数。
 *   ② **不可判**：想断言"链里有没有漏掉某条守卫"，只能去正则抠那行字符串（`verify-package-files`
 *      的 P5 就是这么干的）。字符串一改，判据就静默缩水。
 * 清单落到本文件后，链的形状成为**机器可读的数据**：`--list-json` 直接输出有序步骤表。
 *
 * ## 清单即真源
 *
 * `MANIFEST` 是这条链的**唯一真源**，本文件**不读 `package.json`**（否则 runner 与
 * package.json 互为循环、等价证明无从谈起）。`package.json` 那一侧只留一行
 * `node test/run-guards.mjs [group]`，由 `test/verify-package-files.mjs` 的 P5 从
 * `--list-json` 取有序清单与档位。
 *
 * ## 逐条等价（对旧 `&&` 链）
 *
 * | 旧写法 | 本 runner |
 * |---|---|
 * | `node test/a.mjs && node test/b.mjs` | 硬档步骤**串行**执行；任一步非 0 ⇒ 立即以**同一个退出码**退出（`&&` 的短路语义） |
 * | `node test/warn-only.mjs test/soft.mjs` | 软档步骤 → `node test/warn-only.mjs <file> [args…]`，**逐字复用现入口**：退出码降级、`[warn-only] 软档守卫原退出码 = N`、具名 `SKIP` 全都不重写 |
 * | `node test/warn-only.mjs --probe-spawn test/x.mjs --allow-skip` | 软档 + `probeSpawn: true` ⇒ 原样带上 `--probe-spawn` |
 * | `npm run build`（`verify:all` 首步） | `npmStep` ⇒ `npm run build`，与旧串一字不差 |
 *
 * 子进程一律 `stdio: 'inherit'`，与 `&&` 链一样把守卫自己的 `✓` / `✗` / `PASS |` 明细
 * 直接接到父进程的终端上。
 *
 * ## 退役项自动降档（4.23.21，P0-A）
 *
 * 真实缺陷：`verify` 的第 3 步 `verify-client.mjs` 断言的是**关于页四节**，而关于页早已按需求
 * 清空 —— 它**永久红**，于是 `&&` 式的硬短路让后面 118 步（含本轮新写的 7 条判据）**一次都没跑**。
 * 而同样这几条守卫在 `test/tools/retired-tests.mjs` 里**早就登记为退役**（`run-audit` 对它们
 * 既不算绿也不算红）。两个入口对同一批守卫给出两套结论，正是"门禁看起来在、实际是死的"的形态。
 *
 * 修法（口径统一，不硬编码名单）：
 *   · 本 runner **读退役登记表**，凡 `file` 的 basename 在表里的步骤，加载时**自动把档位降为
 *     `soft`**（经 `warn-only` 跑 ⇒ 原退出码照样打印、照样可见，但不决定本组红绿、**不短路**）。
 *   · 硬短路语义**不变**：真正的红（未登记退役）仍然立即终止整组并以同一退出码退出。
 *   · `--list-json` 输出的是**降档后的真实档位**（`retired: true` 也一并给出），于是
 *     `verify-guard-chain` 的冻结 fixture 与 `verify-package-files` 的地板看到的是同一事实。
 *   · 判据：`test/verify-gate-no-shortcircuit.mjs`（退役项不参与硬短路 + 执行器自检）。
 *   · `--selfcheck` 是给那条守卫用的**执行器自检**：用两个内联子进程证明「软档红 ⇒ 继续」
 *     与「硬档红 ⇒ 仍短路」，不是拿真链去循环。
 *
 * ## 用法
 *
 *   node test/run-guards.mjs [verify|docs|smoke|all]   跑一组（缺省 verify）
 *   node test/run-guards.mjs [group] --list            打印该组的等价命令串（**不执行**）
 *   node test/run-guards.mjs [group] --list-json       打印该组的机器可读步骤表（**不执行**）
 *
 * `--list` 的口径与旧 `package.json` 字符串**逐字等价**：把同组每一步渲染成
 * `node <file> <args…>` / `npm run <step>`，再用 ` && ` 连起来 —— 于是"清单有没有漂"
 * 可以拿旧字符串做一次纯文本 diff（见交付报告里的等价证明）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// 退役登记表是**唯一真源**：本 runner 不再自己维护"哪些守卫已经永久红"的名单（见文件头
// 「退役项自动降档」）。`test/run-audit.mjs` 读的是同一份表 —— 两个入口对"退役"必须同口径。
import { isRetired } from './tools/retired-tests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = 'test/run-guards.mjs';

/**
 * npm 步骤的子进程姿势（Windows 上的实测坑，别再试别的写法）。
 *
 * 本 runner 的 `npmStep`（`all` 组的首步 `npm run build`）此前直接 `spawnSync('npm', …)`，
 * 在 Node ≥ 18.20.2（CVE-2024-27980 的修法）之后于 Windows 上**必然起不来**：
 *   · 裸 `'npm'` ⇒ ENOENT（PATH 上只有 `npm` bash 脚本与 `npm.cmd` 垫片，没有可执行体）；
 *   · `'npm.cmd'` ⇒ EINVAL（Node 明确拒绝不经 shell 直接起 `.cmd`）；
 *   · `'npm.cmd' + shell:true` 能跑，但会带 DEP0190 告警（args 不转义）且多一层壳。
 * 可靠姿势：**用当前 node 直接跑 npm 自己的 CLI 入口 `npm-cli.js`**。
 * 先试 `npm_execpath`（npm 起的进程自带、就是那个入口），再试 Node 官方安装布局
 * `<nodeDir>/node_modules/npm/bin/npm-cli.js`（实测本机 D:\Nodejs 即此布局）。
 * 两者都找不到时退 `npm.cmd + shell:true`：还能跑，只是带一层 shell（POSIX 上 `npm` 本来
 * 就是脚本，同样的退路在那里也无副作用）。
 */
function npmLaunch(args) {
  const candidates = [];
  if (process.env.npm_execpath && /\.m?js$/.test(process.env.npm_execpath)) {
    candidates.push(process.env.npm_execpath);
  }
  candidates.push(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const c of candidates) {
    if (existsSync(c)) return { exe: process.execPath, argv: [c, ...args], shell: false };
  }
  return { exe: process.platform === 'win32' ? 'npm.cmd' : 'npm', argv: args, shell: process.platform === 'win32' };
}

/**
 * 一条步骤。
 *   `file`     —— 仓库根相对的守卫路径。
 *   `args`     —— 该守卫的参数（按旧链逐字抄）。
 *   `tier`     —— `'hard'`（挡 PR，失败即整组失败）/ `'soft'`（经 `warn-only` 降级，永不让组红）。
 *   `probe`    —— 软档专用：是否带 `--probe-spawn`（环境起不了子进程时点名 SKIP）。
 *   `kind`     —— 缺省 `'guard'`；`'npm'` 表示这一步是 npm 脚本（`verify:all` 的 `build`）。
 *   `retired`  —— **加载期算出来的**：该 `file` 在 `test/tools/retired-tests.mjs` 里登记过退役
 *                 ⇒ 档位已被强制降为 `soft`（见文件头「退役项自动降档」）。手写的步骤表里不填它。
 *   `inline`   —— **只给 `--selfcheck` 用**：不落盘的 `node -e` 子进程，证明执行器的短路语义。
 */
const step = (file, args = [], tier = 'hard', probe = false) => ({ file, args, tier, probe });
const npmStep = (script) => ({ file: null, npm: script, args: [], tier: 'hard', probe: false });

// ── 各组的步骤表。**顺序 = 执行顺序 = 旧 `&&` 链的顺序**，不得重排：
// `verify` 与 `smoke` 里有依赖前一步副作用的守卫（如 `verify-client-sync` 重建产物后
// `verify-client` 才读它），重排会改变结论。

/**
 * `npm run verify` —— 硬档（挡 PR），本组的唯一真源。
 *
 * ⚠️ 这 5 条**必须在链上**：`verify-inject-contracts` / `verify-component-face` /
 * `verify-route-ownership` / `verify-settings-namespaces` / `js-text selftest`。
 * 它们是契约类强判据（注入面 M8、内核分级面、实现归属 M10、设置分区、文本工具自检）；
 * 少了它们**不会有任何东西变红** —— 链的短路特性会让"链外的强判据"变成摆设。
 * 它们零依赖、干净检出下全部 exit 0 ⇒ 全部挂 **hard**，不需要 SKIP。
 * 链成员一变，必须重算 `test/fixtures/verify-chain.json`（`node test/verify-guard-chain.mjs --write-fixture`）
 * 并把 `test/verify-package-files.mjs` 的 `CHAIN_FLOOR` 收紧到实测值（那里有"删一步即红"的负对照）。
 */
const VERIFY_STEPS = [
  // ⓪ **行尾契约**（D-G1，2026-10-16 收口）：`.gitattributes:9` 的 `* text=auto eol=lf` 此前
  //    **零判据** —— 而它坏了不会报错，只会让下面一大批"按行锚定的字面替换"负对照**假红**
  //    （本仓真踩过：一次整轮改动被 CRLF 污染，靠人眼在 `git diff` 里找 `^M` 才发现；Windows 上
  //    `core.autocrlf=true` 会把文本文件检出成 CRLF）。它是**字节级前提**，故放链首：破了就不该
  //    继续往下跑（链的短路特性在这里是特性，不是缺陷）。判据 = `git ls-files` 全部入库文件减去
  //    `.gitattributes` 的 `binary` 白名单与含 NUL 者，逐一验零 `0x0D`；含纯函数负对照。
  step('test/verify-eol.mjs'),
  step('test/verify-client-sync.mjs'),
  step('test/verify-client.mjs'),
  // ⚠️ D3 可见面判据必须留在链上：它不在链里时，一次取上游 panel-tabs.js 就能把 D3 gate 丢掉
  // 而长期没人跑到（链的短路特性会让"链外的强判据"变成摆设）。
  // 在链上：只要 gate 落点与声明表对不上，链就在这里断。
  step('test/verify-component-visibility.mjs'),
  step('test/verify-windows-caption.mjs'),
  step('test/verify-transcode-state.mjs'),
  step('test/verify-playback-controls.mjs'),
  // 4.23.8：已缓存壁纸的切换手感 —— 缓存族归一化 / 双元素池（元素身份）/
  // 切换状态机 / 点击反馈 / switchLatencyMs 与 clickFeedbackMs 度量。
  step('test/verify-switch-smooth.mjs'),
  // 4.23.12：**首帧四段式**与终态保证 —— 代理头的 content-length/accept-ranges/206、
  // 200 KB/s 慢速上游下"出首帧所需的字节 ≤ 1.5s"、300ms 缓冲提示与覆盖层、
  // last-click-wins（慢视频切换中点本机场景不许被吞）、五类连点全部生效、切本地副本的时间对齐。
  step('test/verify-first-frame.mjs'),
  // 4.23.9：面板「标签」下拉改为**动态**（站点 facets → 分组多选 OR），判据含
  // 「任何请求不得出现 category≠wallpaper」的负对照（护住壁纸库的承重闸门）。
  step('test/verify-filters-dynamic.mjs'),
  step('test/verify-scene.mjs'),
  step('test/verify-scene-frame-master.mjs'),
  step('test/verify-scene-live.mjs'),
  step('test/verify-scene-live-occlusion.mjs'),
  step('test/verify-scene-probe.mjs'),
  step('test/verify-occlusion-hub.mjs'),
  step('test/verify-occlusion-client.mjs'),
  step('test/verify-adapter.mjs'),
  step('test/verify-theme-follow.mjs'),
  step('test/verify-logging.mjs'),
  step('test/verify-media-bridge.mjs', ['--allow-skip'], 'soft', true),
  step('test/verify-media-probe.mjs'),
  step('test/verify-softrender.mjs'),
  step('test/verify-readability.mjs'),
  step('test/verify-glass-compositing.mjs'),
  step('test/verify-glass-surfaces.mjs'),
  step('test/verify-glass-compat.mjs'),
  step('test/verify-glass-runtime.mjs'),
  step('test/verify-glass-runtime-browser.mjs'),
  step('test/verify-extra-glass.mjs'),
  step('test/verify-package-files.mjs'),
  step('test/verify-package-publish.mjs'),
  step('test/verify-deployment.mjs'),
  // 发布集**字节**（P2-7）：真打一次发布集，解出八个 tarball，判"主包声明的七个子包 = 精确版本且在
  // 集内""主包不带开发面目录""每个子包 tarball 真有自己 exports["./client"] 的浏览器半边"。
  // 归硬档：主包少声一条依赖 / 子包漏打客户端半边 ⇒ 用户 `pnpm add` 在**他的机器上**以
  // ERR_PNPM_FETCH_404 或静默缺半边失败（"只拿到母包"的唯一形态），仓库内此前只有散文可依。
  step('test/verify-release-set.mjs'),
  step('test/verify-contracts.mjs'),
  step('test/verify-body-caps.mjs'),
  step('test/verify-json-response.mjs'),
  step('test/verify-i18n.mjs'),
  step('test/verify-types.mjs'),
  step('test/verify-host-paint-scope.mjs'),
  step('test/verify-route-index.mjs'),
  step('test/verify-route-families.mjs'),
  step('test/verify-inject-contracts.mjs'),   // ← 还原（旧链位：route-families 之后、cache-dir 之前）
  step('test/verify-cache-dir.mjs'),
  step('test/verify-cache-prune.mjs'),
  // 4.23.7：面板内「缓存管理」—— 五层用量 + 分目标清理。判据按"能删错什么"组织：
  // 各 target 只删自己、诱饵不动、`..`/绝对路径 400（整单拒绝）、符号链接不跟随、
  // 被占用的文件进 failed 且不拖垮整层、`skins` 必须显式点名、面板两段式确认。
  step('test/verify-cache-manager.mjs'),
  step('test/verify-we-install-probe.mjs'),
  step('test/verify-wallpaper-scan.mjs'),
  step('test/verify-inventory-index.mjs'),
  step('test/verify-mp4-vfs.mjs'),
  step('test/verify-theme-layer.mjs'),
  step('test/verify-api-client.mjs'),
  step('test/verify-component-fonts.mjs'),
  step('test/verify-component-face.mjs'),     // ← 还原（旧链位：component-fonts 之后、fontset 之前）
  step('test/verify-fontset.mjs'),
  step('test/verify-avatar-interval-and-rotation.mjs'), // ← #231 间隔旋钮 + #230 轮播间隔 / 视频播完档 + #240 缩略图
  step('test/verify-presets.mjs'),
  step('test/verify-settings-namespaces.mjs'), // ← 还原（旧链位：presets 之后、system-fonts 之前）
  step('test/verify-system-fonts.mjs'),
  step('test/verify-picker-upload.mjs'),
  step('test/verify-picker-model.mjs'),
  step('test/verify-picker-props.mjs'),
  step('test/verify-about.mjs'),
  step('test/verify-token-contract.mjs'),
  step('test/verify-route-ownership.mjs'),    // ← 还原（旧链位：token-contract 之后、链尾附近）
  step('test/verify-config-store.mjs'),
  step('test/verify-steam-discovery.mjs'),
  step('test/verify-child-kill.mjs'),
  step('test/verify-host-diag.mjs'),
  step('test/verify-upload-store.mjs'),
  step('test/verify-video-preview.mjs'),
  step('test/verify-asset-paths.mjs'),
  step('test/verify-settings-schema-exports.mjs'),
  // BUNDLE-SPLIT 7.6 的四条新判据（P2-5b）。全部 hard：
  //   ① 启动自检：主包 apply 必须先 resolve 每个子包与其行，失败大声报错（I5 是行级静默失败）；
  //   ② 浏览器半边在场：声明 dsh.client 的子包，其行必须被主 patch 插入、产物按 id 注册且只注册一份；
  //   ③ 跨包纯度：子包只许 import 主包叶子 subpackage-boot.js + node: 内置，子包之间零 import；
  //   ④ 开关往返：对 patch 里的每一行做 关 -> 开 -> 再关（整族在场/缺席、互不相交、只动自己那一行、零残留），
  //      附真源码变异负对照（handOffTeardown -> 恒等 = 只 return dispose 必须变红）。
  // ②③④ 目前对 P-A 范围数据驱动；缺构建产物时的报错文案会提示"先跑 npm run build"。
  step('test/verify-subpackage-boot.mjs'),
  step('test/verify-subpackage-client-half.mjs'),
  step('test/verify-subpackage-purity.mjs'),
  step('test/verify-subpackage-toggle-roundtrip.mjs'),
  // ⑤ 子包包面（P2-5；2026-10-15 收口时**由软档升 hard**）：`lib/components/*/package.json` 的
  //    name/version/main/exports/peer 与自带 patch 行、根 `exports` 三连对账（组件行 + 独立子包行两段）。
  //    按 ADR-0004 的分档判据，它守的是**发布面 / 打包面**：版本漂离主包、peer 范围与主包不逐字相等
  //    （I6：宿主整次安装被拒 + 回滚）、`dsh.client` ⟺ `exports['./client']` 失配（C2：浏览器半边静默不加载）
  //    —— 每一条都是"用户会撞上"的后果，不是仓库内务 ⇒ 硬档。判据面与档位依据见 adr/0014 S3。
  step('test/verify-subpackage-manifests.mjs'),
  // ⑦ 主包 apply() 的**交接位置**（R-1 的真实形态；P2-6 gate-r1）：出货宿主的 `register` 判重在
  //    插入**之前** ⇒ 文档点名的"40 处单表达式兜底"没有可失败的中间态（那 20 个文件安全、零改动）；
  //    真缺陷是 `handOffTeardown(ctx, dispose)` 原本排在 `apply()` 最后一行 —— 中途抛错（最现实：
  //    上次装载残留撞 `duplicate … route`）那一行永不执行 ⇒ `ctx.effect` 从未登记 ⇒ fiber 不回滚、
  //    前序各族已注册路由全部残留。判据 = 源码序 + 行为（真 lib/index.js × 正序 mock 宿主，
  //    残留 31 → 0、注册面 32 条两臂同序逐字节相等），另有 6 条负对照（NC1–NC5 带牙 + 1 条前提②负对照）
  //    与 4 条覆盖面地板。
  //    真 cordis 往返仍未跑（`@deepseek-ai/cordis` 是 peer，本轮口径 `npm ci --omit=peer`）⇒
  //    fiber 回滚语义是**源码推读**，守卫只在文件头如实标注，不升级为"已验证"。
  step('test/verify-host-teardown.mjs'),
  // 官方协议的协调、真实 HTTP、自有气泡和四排播；不加载或修改第三方客户端。
  step('test/verify-pet-package.mjs'),
  step('test/verify-pet-hotplug-host.mjs'),
  step('test/verify-pet-hotplug-client.mjs'),
  step('test/verify-pet-rope-entry.mjs'),
  step('test/verify-pet-tuner.mjs'),
  step('test/verify-pet-official.mjs'),
  step('test/verify-pet-sidebar-rebound.mjs'),
  step('test/verify-pet-sidebar-diag.mjs'),
  step('test/verify-pet-sidebar-glass.mjs'),
  // ⑥ 包发现层 `test/tools/packages.mjs` 的**自检**（P-B 基石）：上面这一批"包面"判据
  //    （client-sync 的产物集合 / bundle-rows 的行⇄包对账 / subpackage-manifests 的清单面 /
  //    host-route-index 一族的行·包解析）与 `scripts/build-client.mjs` 都读它 ⇒ 它自己坏了会
  //    连带整批判据失真（与下面 js-text 同理，属"判据底座的底座"）。11 条负对照全部经同一个
  //    `enumerateViolations`，另有 `FLOORS` 地板防"包 / 产物 / 行数静默缩水"。
  step('test/tools/packages.mjs', ['selftest']),
  // ← 还原（旧链最末一步）：`js-text` 的**自检**（字符串感知的剥注释/作用域/函数体提取，
  // 是上面一批"文本判据"的共同底座 ⇒ 它自己坏了会连带整批判据失真）。
  step('test/tools/js-text.mjs', ['selftest']),
  // ⑧ 链的**形状自检**（R-4 收口：由 docs 软档升 hard）。它把 MANIFEST 与
  //    `test/fixtures/verify-chain.json` 逐条对账（顺序 / 档位 / 参数 / 文件名），另判每组硬档地板、
  //    每个 file 真实存在、`all` = build + 三组有序拼接，以及 ⑤「守卫面上脱链者必须有代码内理由」。
  //    原先它挂在 docs 组，而 CI 的 `verify:docs` 步是 `continue-on-error: true` ⇒ 把链上头两步
  //    交换一下，**硬档可以全绿**、只有软档出声。"链的形状"是发布面（静默掉一条守卫 = 一条硬档
  //    判据无声脱离 PR 门禁）⇒ 按 ADR-0004 归硬档，放本组末尾（它是全组的自检，读的是 MANIFEST
  //    而非某一步的产物；`--list-json` 只打印不执行，不会递归）。
  step('test/verify-guard-chain.mjs'),
  // ⑧b 门禁不许被退役项短路（4.23.21，P0-A）。真实缺陷：第 3 步 `verify-client.mjs`（关于页四节，
  //    页面已按需求清空）永久红 ⇒ 硬短路让后面 121 步一次都没跑。本 runner 现在读
  //    `test/tools/retired-tests.mjs` 把退役步骤自动降为软档；本守卫钉住「退役项一律软档」
  //    + 反向对照（名字相近未退役的仍 hard）+ 执行器自检（软档红继续 / 硬档红仍短路）。
  //    归硬档：门禁能不能跑到 = 发布面；它自己坏了，"门禁全绿"就又可以是一句空话。
  step('test/verify-gate-no-shortcircuit.mjs'),
  // ⑨ CI 步骤表自检（R-7，task-11 交付）：`test/tools/ci-workflow.mjs` 的行扫描 + 判据（序列 / 脚本
  //    存在性 / `continue-on-error` 只在 verify:docs / 产物出库与无尾随空白两步真的在跑 / install 在
  //    第一条 npm run 之前），正判据与 10 条负对照共用一个纯函数（变异喂内存文本，不碰真 workflow）。
  //    与 ⑧ 同理归硬档：删掉 `verify:static` 或 `verify:bridge` 这类改动只有它能拦。
  step('test/verify-ci-steps.mjs'),
  // ⑩ CI 分流接线最小守卫（CI 阶段一）：verify.yml 必须带固定名 `ci/result` 汇总且真的在跑
  //    `scripts/ci-routing.mjs` —— 工作流被整体换回旧单 verify 矩阵时，只有它能当场红。
  //    归硬档：分支保护的勾被静默摘走 = 全部 CI 判据无声脱离 PR 门禁（发布面）。
  step('test/tools/ci-routing-red.mjs'),
  // ⑪ ci-routing CLI 的隔离 git 库端到端（CI 阶段一）：`os.tmpdir()` 现造一次性仓库驱动
  //    `scripts/ci-routing.mjs` 的真实管道（staged / unstaged / untracked 三通道、docs 于 full
  //    差异 exit 3 拒绝、git 取不到差异 exit 2 阻断、judgeResult 放行/拒绝、参数严格解析）。
  //    归硬档：分类器误判 docs / fail-closed 失效 = 代码改动走快通道绕过全量门禁（安全面）。
  step('test/verify-ci-routing.mjs'),
  // ⑫ 公告快通道（CI 的 `notice` 模式）：只改更新公告文案的提交绕过全量链 —— 这是**唯一**
  //    一条能放行 `src/client.js`（整份浏览器半边）改动的捷径，因此它的判据必须是**内容级**
  //    而不是按文件名：两个公告文件的 `UPDATE NOTICE COPY` 区块**外**逐字节一致、区块**内**
  //    代码骨架一致（只许改引号里的字）。本守卫 33 条，其中 20 条是负对照（区块外加代码 /
  //    区块内增删条目 / 改 props / 少改一个文件 / 标记被删 …），另有一条拿**真 src/client.js**
  //    在区块外插一行代码断言判红 —— 判据恒真时这条会静默变绿，所以必须有真数据对照。
  //    归硬档：这条通道写宽 = 整份客户端免检（安全面，比 docs 通道更贵）。
  step('test/verify-notice-routing.mjs'),
  step('test/verify-issue-claim-policy.mjs'),
  // ⑬ 模块化守卫：功能清单（lib/features.js）与实际文件/路由/页签逐条对账 ——
  //    加功能漏登记、路由成孤儿、页签没归属，都到这里断。免费、零依赖，归硬档。
  step('test/verify-features.mjs'),
  // ⑮ 宿主侧注册表：已迁移族 / 未迁移棘轮 / 覆盖 lib/routes/*.js —— 与客户端注册表对称。
  step('test/verify-route-registry.mjs'),
  // ⑯ 设置键归属：每个键恰好一个功能（拆 settings-schema 的前提对账）。
  step('test/verify-settings-ownership.mjs'),
  // ⑯b 皮肤中心随包：`package.json` 声明依赖 + patch 插一条唯一 id 的 row —— 少任一半，
  //     皮肤页签都会「在、但点不动」，且只会静默失败（跨包契约，两个方向都是负对照）。
  step('test/verify-skin-center-bundle.mjs'),
  // ⑰ 交互手感：开关不绑选片状态、幂等设置合并响应、提示行占位（用户实测报过的两类闪动/点不动）。
  step('test/verify-panel-interactions.mjs'),
  // 面板不许再整片变白：畸形数据归一 + 单卡/整页错离（真实故障的守卫）。
  step('test/verify-panel-defensive.mjs'),
  // ㉔ 出货包不许带本机隐私路径 / 不许带 token（机械判据，不靠人记得检查）。
  step('test/verify-no-local-paths.mjs'),
  // ⑱ 站点条目类型：zip 工程包不得判成视频（实测踩过：56MB zip 塞进 <video>）。
  step('test/inventory-types.mjs'),
  // 4.24.0：**消费站点素材网 v1 的新字段**（站点 2026-11 上线）。判据矩阵：
  //   ① inventory 透传 fps/codec/pixFmt/hasAudio/posterUrl/license/source(→sourceUrl)/author
  //      + variants[].width/fps（站点端名字一字不改）；
  //   ② 选档改用真实数据：{4K@30}⇒original · {4K@60+4K30}⇒4k30 · {HEVC+1080p}⇒1080p ·
  //      {fps 缺失+width 3840}⇒宽度兜底（fpsSource=width-fallback）；
  //   ③ 静态封面 posterUrl 优先、thumbUrl 回退（断言最终 poster 来源）；
  //   ④ 端点偏好 v1：真 HTTP 替身，v1 回 400/404/字段缺失 ⇒ 自动回退 v0 且功能不降级，
  //      v1 可用 ⇒ siteApiVersion='v1'（同时进 inventory 响应与 /diag/media-state 的同一张表）；
  //   ⑤ 负对照：站点字段全 null 时行为与 4.23.24 逐字段相等。
  // 归硬档：选档错 ⇒ 用户点开壁纸当场「无法解码」；端点回退漏了 ⇒ 旧站点直接空库。
  step('test/verify-site-v1-sync.mjs'),
  // 4.24.0：**壁纸链路端到端稳定性**（十条不变量 I1–I10）。真 HTTP 字节 + 真队列 + 真路由 +
  // 隔离 home，覆盖 a–h 矩阵：未缓存点击→海报→下完校验→local-media→播、清空媒体三段一致
  // （含 negative control：不失效清单 ⇒ 角标仍"已缓存"）、清单说谎时第一次点击即自愈、
  // 切走降 low 不丢字节/点回升 high、选档（4K30/1080p/HEVC）、AbortError 连发不报错、
  // 截断文件重下、哈希不符 hash-mismatch、重启 done+缺失→pending。
  // 归硬档：这条链的每一段都对应一个用户可见故障（角标说谎 / 第一次点不开 / 坏文件上屏）。
  step('test/verify-wallpaper-chain.mjs'),
  // ⑭ 我们自己的三条功能级测试：开机动画路由 / 桌宠路由 / 桌宠渲染层。
  //    它们是真 http.Server + 假 DOM，不依赖外部进程或网络，适合进链。
  step('test/boot-http.mjs'),
  step('test/pets-http.mjs'),
  // ⑳ 助手皮肤：装/卸/幂等/路径穿越/白名单（真 http + 真 zip）。
  step('test/skins-http.mjs'),
  // ㉑ 站点远程媒体的**本机缓存代理**：白名单 / 命中 / 302 降级 / 只读盘 / 上限淘汰 / 并发去重。
  //    这条路由是"给别人用的加速器"，判据必须覆盖"任何一环坏掉都还能播"。
  step('test/verify-site-media.mjs'),
  // ㉒ 站点资源本地化队列：并发上限 / 幂等 / 续传 / 原子 / 可失败（点击即下载的那条链路）。
  step('test/verify-downloads.mjs'),
  // ㉗ 4.23.7：**多连接 Range 的静默损坏**（P0）回归 + 下载后内容哈希。
  //    事故现场原样：全量响应 17,509,106（旧版）/ Range 回源 17,414,581（新版）⇒ 旧实现拼出
  //    "size 对、尾部 94,525 个 0"的坏 zip 且报 done。判据：不产出 ranged done、错误必须落在
  //    range-version-mismatch / range-short / range-etag-mismatch 上、回落单流后 sha256 正确、
  //    哈希不符只自动单流重下一次；另有"把旧实现贴回来必须红"的源码级 + 行为级负对照。
  step('test/verify-ranged-integrity.mjs'),
  // ㉕ 4.23.6：**下载/安装状态机的流程级回归** —— 14 行覆盖表（本地 × 队列 × 已装 × 时长
  //    ⇒ 展示状态 + 是否可点）+ 4 条端到端（真站点替身 + 真路由 + 真队列 + 真 zip，含
  //    "宿主重启 job 表被清空"与"站点 500"两条故障注入）。对应 docs/INSTALL-FLOW.md 的防复发清单。
  step('test/verify-install-flow.mjs'),
  // 4.23.14：**「第一下点击必然有可见变化」**（用户实测：皮肤卡片「安装」第一下没反应、第二下才有）。
  // 判据按"用户能看到的第一帧"组织：点击同一 tick 的 pressed/aria-busy + 零网络、预检查只在
  // installed===true 时做且 1.5s 超时后照常发请求、300ms 未进队列出「提交中…（正在准备）」占位、
  // 四类入口（皮肤/开机动画/桌宠/壁纸）各一条 + 旧顺序负对照。对应 docs/INSTALL-FLOW.md 第 9 节。
  step('test/verify-first-click-feedback.mjs'),
  // pre.46：**下载完成但没落地**的卡片自愈（boot/skin 挂载 0s/3s/8s 三次退避；
  // 自愈期间显示「正在补收尾… 第 a/t 次」而不是干等 90 秒；成功就地 done、失败才红字）。
  step('test/verify-stall-heal.mjs'),
  // 4.23.15：**本地副本自愈**（P0）。真实故障：壁纸报「视频解码失败（文件可能已损坏）」/
  // 「浏览器无法解码这段视频」，而面板同时说"缓存命中 4/5" —— 播放路径直接读本地文件、
  // 没有任何自检。判据：坏文件（长度对 sha 错）⇒ 删 + **单流**重下 ⇒ 字节与站点一致；
  // 好文件解不了 ⇒ 不重下、切 1080p；无变体 ⇒ 本地转码/明说解不了；启动自检"最近 20 个"
  // 采样 + 全量校验抓住两种坏文件；另有"摘掉 sha 校验只比长度"与"只按速度选档"两条**源码级**
  // 负对照。对应 docs/DOWNLOAD-INTEGRITY.md 的「本地副本自愈」一节。
  step('test/verify-media-selfheal.mjs'),
  // 4.23.15（P0-4）：**测试/脚本不得写用户真实 home**。真实事故：跑测试把 30 个合成占位视频
  // 写进了 `%APPDATA%\dsh-desktop\harness\library\wallpaper\`，用户看到的所有「浏览器无法解码」
  // 正是那些假文件。判据：静态面（解析 home 的测试/脚本必须有隔离证据）+ 行为面（拿真实
  // harness 当 DSH_HOME 起子进程必须被拒，退出码 3）。
  step('test/verify-test-isolation.mjs'),
  // ㉖ 4.23.6：**整条链路**（清单→选档→下载→落位→安装→启用）的端到端回归 —— 6 个场景逐段断言 + 计时：
  //    快链路选原画/0 Range/<2s、慢链路 3 秒切 ranged:8 且吞吐 ≥2.5×、清单陈旧回落、缓存命中 0 请求、
  //    落位安装幂等、故障注入（重启/500/磁盘写失败）。数字给在 docs/DOWNLOAD-CHAIN-REPORT.md。
  step('test/verify-download-chain.mjs'),
  // ㉓ 1080p 变体选档（4.23.4，策略 A 自动）：纯函数逐条（无变体 / 慢链路 / 大文件小屏 /
  //    强制原画 / 非法 url）+ `/downloads/add` 真的按选档入队 + `job.chosenVariant` 出现在
  //    `/downloads/list` + inventory 透传 `variants`。站点还没上线该字段时的回退（原画）也在其中。
  step('test/verify-variants.mjs'),
  // 4.23.17（P0-6）：**哈希来源的单一真相源**。真实事故：选档决定下 1080p 变体，校验却用
  // 原画的 sha256 ⇒ 15 条 job 全 hash-mismatch（用户看到"点了壁纸不显示"）。
  // 判据：源码扫描（入队点不许直接取 item.sha256，白名单在文件头）+ {原画,变体}×{sha 有,无}×
  // {bytes 一致,不一致} 矩阵 + 三条负对照（旧写法 / resolve 退化 / 丢变体 sha）。
  step('test/verify-hash-source.mjs'),
  // 4.23.17：变体哈希**行为**（真 HTTP 源 + 真路由 + 真队列：变体+变体哈希 ⇒ done；变体+原画
  // 哈希 ⇒ hash-mismatch 负对照）、ENOENT 自愈（.part 被外部清 ⇒ 重排并 done；连续两次 ⇒
  // file-vanished）、旧 downloads.json 升级（done 但成品缺失 ⇒ 重置 / 缺字段不崩）。
  step('test/verify-variant-hash.mjs'),
  // 4.23.17：壁纸缓存进度（首次点击后「缓存中 62%」，下完「已缓存」，切走再切回接着显示真实
  // 进度；卡片与顶部标题栏两处一致；只通知变化的卡；负对照=把"切回来从 0 开始"贴回即红）。
  step('test/verify-wallpaper-progress.mjs'),
  // 4.23.18：**队列优先级 / 启动限流 / 运维 / 旧 job 迁移**。用户实测：当前在看的壁纸排在
  // 31 条 low 之后（启动批量重置）；标题栏 N 来自全局 queuePos（跨 kind 串号）；4.23.17 之前
  // 的 failed job 还带着"变体 URL + 原画哈希"的错误期望。本守卫覆盖：点击/在播 high + 队首、
  // 30 条 done-缺失 ⇒ 全 pending（queuedCount=0）、预取**默认 0 张**（4.24.1 起宿主下发、上限 3）
  // 且 low、N=queuedAhead（假队列含跨 kind）、清空未开始、暂停/恢复、当前清单校验（真源下载 done /
  // 幂等 / 清单不可达 / 刷新复核 / 变异负对照）。
  step('test/verify-queue-priority.mjs'),
  // 4.23.23 / 4.25.5：**download-first 是唯一播放路径** —— 点未缓存壁纸先整份下载 + 校验，再从本地播；
  // 期间 `<video>` 不得指向站点媒体地址；进度 + 等待文案（total 未知 ⇒「正在连接…（已等待 N 秒）」）；
  // 4.25.5 起**没有**「改用边下边播」按钮 / `stream-first` 第二档 / 长等待保护（用户明确要求删除，
  // 负对照：贴回 stream-first 档或旧文案 ⇒ A/B 组必红）。切走 ⇒ 该 job 降 low 继续下载
  //（不暂停/不取消、字节不归零），点回 ⇒ 升 high / 直接播本地；预取**默认 0 张**（4.24.1 起宿主下发、上限 3）。
  // 判据 69 条，含同版合并的错误分类重试 / 期望值不持久化 / 清单刷新复核。
  step('test/verify-download-first.mjs'),
  // 4.23.19（P0）：**本地副本 404 的假"无法解码"** —— 用户按「清空媒体」步骤踩到。
  // 判据：启动 3 条 done-缺失 ⇒ pending；/local-media 命中 done 但文件缺失 ⇒ 404 + 复位 pending；
  // 清空媒体 ⇒ 内存队列 done=0 + clearedJobs（负对照：只删文件/JSON 不改内存队列）；
  // 客户端 local-media 404/error 4 ⇒ 站点代理重挂 + /downloads/requeue（最终 src 不是 local-media）。
  step('test/verify-local-media-heal.mjs'),
  // 4.23.19：**单一状态模型 / 单一解析器 / 对账**（这一类问题的一次性收口）。
  // 判据矩阵 58 条：纯状态机 8（含"下载中即使盘上有文件也不是 local"）、宿主解析器 6 + 负对照、
  // 客户端解析器 6 + 负对照、对账器（30 条 done-缺失 / 幂等 / deep sha 删文件 / 提升）、
  // 清缓存同一事务（clearedFiles+resetJobs）、/local-media 缺失 ⇒ pending、/diag/media-state、
  // 源码扫描（唯一拼法/唯一解析器/唯一写入口/`.part` 不进播放路径）、文案矩阵。
  // 合同：docs/MEDIA-LIFECYCLE.md（13 状态 × 10 事件 + 15 条文案 + 12 条绕过）。
  step('test/verify-media-state.mjs'),
  // 4.23.19：**混沌测试** —— 随机折腾 100 轮（删文件/改记录/只写一半/校验不符/清缓存/重启），
  // 逐轮断言 I1 无 done-缺失 · I2 local 只指完整有效文件 · I3 下载中必 proxy ·
  // I4 完成即 local · I5 失败有具体文案 · I6 UI 与队列一致。复现靠 seed。
  step('test/verify-media-chaos.mjs'),
  // 4.24.1（P0-1/P0-2）：**本地残留的恢复判据**（21 条）。A 组 `.part` 体检矩阵（==total 直接
  // 落位 / 内容无效重下 / >total 重下 / 半截续传 / 416 自愈一次 / 416 两次才 failed + 负对照
  // "`Range: bytes=<total>-` 必 416"）；B 组皮肤缓存 zip 与清单 sha 不符 ⇒ 删三件套后**继续下载**
  // （负对照：不删缓存 ⇒ 队列复用 done 记录、盘上仍是旧内容）；C 组启动 sweep 的四个删除面与统计。
  step('test/verify-download-recovery.mjs'),
  // 4.24.1（P0-3）：**未点击就不许自己下**（24 条）。宿主 prefetchCount() 默认 0 / 上限 3、
  // 客户端同一套夹取（真跑源码）、70 条 pending ⇒ queuedCount=0、点 1 张只排 1 张、
  // 连点 3 张只排 3 张、prefetchCount=3 才允许额外 3 条 low 且 high 排在前；
  // 负对照三条：默认值改回 3 / 启动把 queued 放回 / 批量 promote 的形态。
  step('test/verify-no-auto-enqueue.mjs'),
  // 4.25.0：**核心 6 条行为 + 3 条质量判据**（64 条）—— B1 不点恒 0 / B2 点 1 只排 1 /
  // B3 点第 2 张前一张 low 且字节不归零 / B4 切回读 /downloads/list 快照 / B5 角标数 ==
  // localReady 数 / B6 4K@60→4k30、超分辨率→1080p、HEVC→1080p；Q2 错误文案分流与清空；
  // Q3 进度只在标题栏且 DOM 无 `.we-switch-hint`。每条配一条"旧实现贴回必红"的负对照。
  step('test/verify-wallpaper-core.mjs'),
  // 4.25.0（Q1）：**死代码不许长回来**（12 条）。8 个已删符号 + 2 条已删形态的黑名单
  // （只看代码、先剥注释）、替代实现的在位判据、`lib/src/scripts` 零引用顶层声明为 0、
  // 负面/正面/剥注释三类对照。补的是 `verify-dead-declarations` 明确不扫的 lib/src 面。
  step('test/verify-dead-code.mjs'),
  step('test/pets-layer.mjs'),
  // 门 2：桌宠对话的九条判据（SSE 逐字 / 无模型兜底 / 401 / 超时 / 上下文 8 条 /
  // 超长 / 限频 / 情绪兜底 / key 不外泄）。模型端点是自建的，不依赖 Ollama 或站点。
  step('test/verify-pet-chat.mjs'),
  // 桌宠对话设置区（6 条）：控件齐全 / 保存生效 / 切 Ollama / 测试失败原因 / 记忆清空 / 关对话不弹气泡
  step('test/verify-pet-settings.mjs'),
  // G1 入口加载冒烟：最小 fake ctx 真跑 apply（不抛错 / 基础路由在 / 语音未就绪不崩）
  step('test/verify-entry-load.mjs'),
  // G2 ctx 访问静态扫描：ctx.<服务> 必须先在 inject 里（负例自检保证"改回去会红"）
  step('test/verify-ctx-access.mjs'),
  // S2 头顶气泡（6 条：锚定 / 跟随 / 逐字 / 3s 淡出 / 点击重开 / 超长换行）
  step('test/verify-pet-bubble.mjs'),
  // 语音输入（6 条：全链路 / 权限 / asr-not-ready / 15s 上限 / 静音结束 / 打字兜底）
  step('test/verify-pet-voice.mjs'),
  step('test/verify-asr-local.mjs'),
  // P1 智能语音闭环：真合成（SAPI → Edge 系统音色 → 明确错误）/ /tts 与 /tts/stop 路由 /
  // stop 幂等 / barge-in 调用顺序 / 分句排队 / 三态气泡 / 工作联动 speak 通道。
  step('test/verify-voice-tts.mjs'),
  step('test/verify-capabilities.mjs'),
  step('test/verify-boot-pool.mjs'),
];

/** `npm run verify:docs` —— 软档（只出声）。全部经 warn-only 降级。 */
const DOCS_STEPS = [
  step('test/verify-module-layout.mjs', [], 'soft'),
  step('test/verify-reachability.mjs', [], 'soft'),
  step('test/verify-retired-lines.mjs', [], 'soft'),
  step('test/verify-dead-declarations.mjs', [], 'soft'),
  // 未定义引用普查（"用了但没 import/声明"）：先按软档出声若干轮，再有据可依地议升 hard
  // （这一类；`node --check` 与聚焦判据都照不到它）。
  step('test/verify-undefined-refs.mjs', [], 'soft'),
  step('test/verify-guard-map.mjs', [], 'soft'),
];

/** `npm run smoke` —— 节点级行为冒烟（硬档）。 */
const SMOKE_STEPS = [
  step('test/rotation-smoke.mjs'),
  step('test/rotation-live-smoke.mjs'),
  step('test/rotation-prepared-leak-smoke.mjs'),
  step('test/live-frame-backfill-smoke.mjs'),
  step('test/live-frame-async-identity-smoke.mjs'),
  step('test/fontset-load-smoke.mjs'),
];

/**
 * 四组的清单（**唯一真源**）。
 *
 * `verify:all` 是纯组合（旧串 = `npm run build && npm run verify && npm run verify:docs && npm run smoke`）：
 * 直接**引用同一批步骤对象**（不复制 —— 复制会让"改一处、漏一处"重新变成可能）。
 * `build` 留在 npm 侧（`package.json` 的 `build` 键是本步的真源，P5 的 build 地板仍从那里取），
 * 且**必须不经过** `verify` 组，否则跑 `all` 之外的组时会被意外触发产物重写。
 */
const MANIFEST = {
  verify: { chainKey: 'verify', steps: VERIFY_STEPS },
  docs: { chainKey: 'verify:docs', steps: DOCS_STEPS },
  smoke: { chainKey: 'smoke', steps: SMOKE_STEPS },
  all: { chainKey: 'verify:all', steps: [npmStep('build'), ...VERIFY_STEPS, ...DOCS_STEPS, ...SMOKE_STEPS] },
};

/**
 * **退役项自动降档**（4.23.21，P0-A）：读 `test/tools/retired-tests.mjs`，把已登记退役的步骤
 * 的档位从 `hard` 强制改成 `soft`（幂等；`all` 组引用的是同一批对象，故只改一次即处处生效）。
 *
 * 为什么必须"读表"而不是在步骤表里逐条标 `soft`：登记表是**判据**（谁退役了、为什么、谁接管），
 * 步骤表是**形状**（跑哪些、什么顺序）。两处各写一份 ⇒ 下次有人登记退役却忘了改档位，门禁会
 * 再死一次，而"门禁是死的"和"门禁全绿"在报告里长得一样。本函数是那条耦合的唯一实现点。
 *
 * ⚠️ 只降 `hard → soft`，**不改顺序、不删步骤**：退役项仍然每一步都跑（经 `warn-only`），
 * 它们的原退出码照样打印在终端上 —— 只是不再决定本组红绿。
 * 返回被降档的 `file`（按组收集，启动横幅与判据读同一个数）。
 */
const RETIRED_NAME = (file) => (file ? basename(file) : '');
function downgradeRetired(steps) {
  const out = [];
  for (const s of steps) {
    if (!s.file || !isRetired(RETIRED_NAME(s.file))) continue;
    // `retired` 是"登记过退役"这个**事实**；`tier==='soft'` 是"执行时不许短路"的**后果**。
    // 两者分开记：本来就软档的退役项（如 `verify-media-bridge.mjs` 要探测环境）没有"被降档"，
    // 但它一样必须带 `retired:true` —— 否则 `--list-json` 的读者分不清它是不是漏登记了。
    s.retired = true;
    if (s.tier === 'soft') continue;
    s.tier = 'soft';
    out.push(s.file);
  }
  return out;
}
downgradeRetired(VERIFY_STEPS);
downgradeRetired(DOCS_STEPS);
downgradeRetired(SMOKE_STEPS);
downgradeRetired(MANIFEST.all.steps);

/** 把一条步骤渲染成旧链里的等价命令串（`--list` 用）。 */
function commandOf(s) {
  if (s.inline) return 'node -e <selfcheck:' + s.inline.slice(0, 40) + '>';
  if (s.npm) return 'npm run ' + s.npm;
  const guard = ['node', s.file, ...s.args].join(' ');
  if (s.tier !== 'soft') return guard;
  return ['node', 'test/warn-only.mjs', ...(s.probe ? ['--probe-spawn'] : []), s.file, ...s.args].join(' ');
}

/** 组名 → 步骤数组。未知组返回 null（调用方负责报错与退出码 2）。 */
function stepsOf(group) {
  const entry = MANIFEST[group];
  return entry ? entry.steps : null;
}

/** 组名 → `package.json` 的脚本键（`chainKey`）。 */
function chainKeyOf(group) {
  const entry = MANIFEST[group];
  return entry ? entry.chainKey : null;
}

/** `--list-json` 的载荷：有序步骤表，P5 与外部判据据此取"链上到底跑哪些文件"。 */
function listJson(group) {
  return {
    group,
    chainKey: chainKeyOf(group),
    steps: stepsOf(group).map((s, i) => ({
      index: i + 1,
      kind: s.inline ? 'inline' : (s.npm ? 'npm' : 'guard'),
      npm: s.npm || null,
      file: s.file,
      args: s.args,
      tier: s.tier,
      probe: s.probe,
      // 退役降档是**运行期事实**，必须跟着档位一起输出：冻结 fixture / P5 地板 / 新守卫
      // (`verify-gate-no-shortcircuit`) 都靠它区分"本来就是软档"与"因为退役才降的软档"。
      retired: Boolean(s.retired),
      command: commandOf(s),
    })),
  };
}

/** 执行一步：硬档直接起守卫，软档经 `warn-only.mjs` 起守卫。返回子进程 status（null = 没起来）。 */
function runStep(s) {
  // `--selfcheck` 的内联步骤：不落盘、不经 warn-only（它要证明的正是执行器自己的档位语义，
  // 而不是 warn-only 的降级文案）。真实链上永远不会有 inline 步骤。
  if (s.inline) {
    const r = spawnSync(process.execPath, ['-e', s.inline], { cwd: ROOT, stdio: 'inherit' });
    return r.status;
  }
  // ⚠️ 软档必须传**仓库根相对路径**，不能传绝对路径：`test/warn-only.mjs` 自己按
  // `join(ROOT, target)` 解析目标（它的契约就是"收相对路径"），给绝对路径会被它拼成
  // `<ROOT>/<绝对路径>` ⇒ 前置缺失，全组以合成码 2 退出（实测踩过）。硬档那侧直接执行，
  // 传绝对路径无所谓。
  if (s.npm) {
    // npm 步骤的姿势见 `npmLaunch()`：直接 spawn `'npm'` 在 Windows 上必然 ENOENT/EINVAL。
    const l = npmLaunch(['run', s.npm]);
    const r = spawnSync(l.exe, l.argv, { cwd: ROOT, stdio: 'inherit', shell: l.shell });
    return r.status;
  }
  const argv = s.tier === 'soft'
    ? [join(ROOT, 'test', 'warn-only.mjs'), ...(s.probe ? ['--probe-spawn'] : []), s.file, ...s.args]
    : [join(ROOT, s.file), ...s.args];
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, stdio: 'inherit' });
  return r.status;
}

/**
 * 执行一份步骤表（`&&` 链语义的**唯一实现点**）。返回结构化结果而不是直接 `process.exit`：
 * 真实链用它决定退出码，`--selfcheck` 用它验证「软档红继续 / 硬档红仍短路」两条语义。
 *
 * @returns {{ ok: boolean, code: number, at: number|null, reason: 'spawn'|'red'|null,
 *   results: { index: number, tier: string, file: string|null, status: number|null }[] }}
 */
function executePlan(steps) {
  const results = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const extra = s.retired ? '  [退役 → 软档：不参与硬短路]' : '';
    console.log('\n── [' + (i + 1) + '/' + steps.length + '] ' + commandOf(s) + extra);
    const status = runStep(s);
    results.push({ index: i + 1, tier: s.tier, file: s.file, status });
    if (status === null) {
      // 与 `package.json` 的 `&&` 链同形：子进程起不来时 `&&` 链终止且 npm 以非 0 退出。
      console.error('✗ [' + (i + 1) + '/' + steps.length + '] 没能起来：' + commandOf(s));
      return { ok: false, code: 1, at: i + 1, reason: 'spawn', results };
    }
    if (status !== 0 && s.tier !== 'soft') {
      // 短路语义：与 `&&` 一致 —— 后续步骤不再执行，退出码与原命令一致。
      console.error('✗ [' + (i + 1) + '/' + steps.length + '] 退出码 = ' + status + ' ⇒ 链在此短路');
      return { ok: false, code: status, at: i + 1, reason: 'red', results };
    }
    if (status !== 0) {
      console.log('⚠ [' + (i + 1) + '/' + steps.length + '] 软档守卫原退出码 = ' + status
        + '（已由 warn-only 降级，不决定本组红绿）');
    }
  }
  return { ok: true, code: 0, at: null, reason: null, results };
}

/**
 * `--selfcheck` 的两个场景（**给 `test/verify-gate-no-shortcircuit.mjs` 用**）。
 *
 * 为什么要有它：P0-A 的判据不能只是"清单里档位是 soft"（那是数据，不是行为）。这里用两个
 * 内联子进程把执行器本身跑一遍，证明：
 *   A. 软档步骤红 ⇒ **继续**执行下一步（退役项不会再掐死链）；
 *   B. 硬档步骤红 ⇒ **仍然短路**、退出码 = 子进程退出码（真红不许被吞）。
 * 场景 B 是 A 的反面：只有 B 也在，才能说明"跑完全程"不是因为短路被整体删掉了。
 */
const SELFCHECK = [
  {
    id: 'A', name: '软档红不短路',
    steps: [
      { file: null, args: [], tier: 'soft', probe: false, retired: true, inline: 'process.exit(3)' },
      { file: null, args: [], tier: 'hard', probe: false, inline: "console.log('SELFCHECK-SOFT-STEP2-RAN')" },
    ],
    want: { ok: true, code: 0, ran: 2 },
  },
  {
    id: 'B', name: '硬档红仍短路',
    steps: [
      { file: null, args: [], tier: 'hard', probe: false, inline: 'process.exit(7)' },
      { file: null, args: [], tier: 'hard', probe: false, inline: "console.log('SELFCHECK-HARD-STEP2-RAN')" },
    ],
    want: { ok: false, code: 7, ran: 1 },
  },
];

function runSelfcheck() {
  let bad = 0;
  for (const sc of SELFCHECK) {
    console.log('\n▶ selfcheck ' + sc.id + '：' + sc.name);
    const r = executePlan(sc.steps);
    const ran = r.results.length;
    const ok = r.ok === sc.want.ok && r.code === sc.want.code && ran === sc.want.ran;
    if (!ok) {
      bad++;
      console.error('✗ selfcheck ' + sc.id + ' 失败：ok=' + r.ok + '（want ' + sc.want.ok + '）· code='
        + r.code + '（want ' + sc.want.code + '）· 执行了 ' + ran + ' 步（want ' + sc.want.ran + '）');
    } else {
      console.log('✓ selfcheck ' + sc.id + '（' + sc.name + '）：' + ran + ' 步 · code=' + r.code);
    }
  }
  console.log(bad ? '\n✗ selfcheck 失败 ' + bad + ' 项' : '\n✓ selfcheck 两场景全部符合预期（软档不短路 / 硬档仍短路）');
  process.exit(bad ? 1 : 0);
}

const USAGE = '用法：node ' + HERE + ' [verify|docs|smoke|all] [--list|--list-json] | --selfcheck';
const GROUPS = Object.keys(MANIFEST);

const rawArgs = process.argv.slice(2);
const wantList = rawArgs.includes('--list');
const wantJson = rawArgs.includes('--list-json');
const wantSelfcheck = rawArgs.includes('--selfcheck');
const positional = rawArgs.filter((a) => !a.startsWith('--'));
const unknownFlags = rawArgs.filter((a) => a.startsWith('--')
  && a !== '--list' && a !== '--list-json' && a !== '--selfcheck');

if (unknownFlags.length) {
  console.error('✗ 未知参数：' + unknownFlags.join(' ') + '\n' + USAGE);
  process.exit(2);
}
if (wantSelfcheck) {
  if (positional.length) {
    console.error('✗ --selfcheck 不接受组名\n' + USAGE);
    process.exit(2);
  }
  runSelfcheck();
}
if (positional.length > 1) {
  console.error('✗ 只接受一个组名，收到：' + positional.join(' ') + '\n' + USAGE);
  process.exit(2);
}
const group = positional[0] || 'verify';
const steps = stepsOf(group);
if (!steps) {
  console.error('✗ 未知组：' + group + '（可选：' + GROUPS.join(' / ') + '）\n' + USAGE);
  process.exit(2);
}

// ── 只读模式：打印清单，不执行 ────────────────────────────────────────────────
if (wantJson) {
  console.log(JSON.stringify(listJson(group), null, 2));
  process.exit(0);
}
if (wantList) {
  for (const s of steps) console.log(commandOf(s));
  process.exit(0);
}

// ── 执行模式 ──────────────────────────────────────────────────────────────────
// 清单完整性先自检：清单漂成死路径时**当场**报出来，而不是等 npm 报一个难读的
// "Cannot find module"（这条与 P5 的"清单里每个 file 真实存在"同源，但本处是运行期兜底）。
const deadFiles = steps.filter((s) => s.file && !existsSync(join(ROOT, s.file)));
if (deadFiles.length) {
  console.error('✗ 清单里有 ' + deadFiles.length + ' 条指向不存在的文件（清单漂了）：');
  for (const s of deadFiles) console.error('    ' + s.file);
  process.exit(2);
}

console.log('▶ ' + group + ' —— ' + steps.length + ' 步（硬档 '
  + steps.filter((s) => s.tier !== 'soft').length + ' / 软档 '
  + steps.filter((s) => s.tier === 'soft').length + '；其中登记退役 '
  + steps.filter((s) => s.retired).length + '）');
if (steps.some((s) => s.retired)) {
  console.log('  登记退役（读 test/tools/retired-tests.mjs；原退出码照打，不参与硬短路）：');
  for (const s of steps.filter((x) => x.retired)) console.log('    · ' + s.file);
}

const plan = executePlan(steps);
if (!plan.ok) process.exit(plan.code);

console.log('\n✓ ' + group + ' 全部 ' + steps.length + ' 步执行完毕');
process.exit(0);
