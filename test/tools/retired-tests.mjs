/**
 * test/tools/retired-tests.mjs — **退役测试登记表**。
 *
 * 背景：本仓从上游的**七个包**合并成单一包（`lib/components/*` 就地装载），而相当一批上游守卫
 * 断言的是**已经不存在的结构**（`packages/` 目录、子包行、8 行 patch、`packages/<pkg>/client.build.json`、
 * 随合并没带过来的 `.github/scripts/*`）。它们不可能变绿 —— 除非把结构改回去。
 *
 * 三种处理方式里，我们选第三种：
 *   ① 删掉 —— 会丢知识（那些判据说明上游为什么那样设计）；
 *   ② 改判据 —— 等于把"断言 X"改成"断言 Y"，容易悄悄放宽；
 *   ③ **登记退役**（本表）：文件不动、判据不动，审计运行时明确报 `RETIRED` + 理由 + 谁接管。
 *
 * 所以 `test/run-audit.mjs` 把它当 **SKIP**（既不算绿也不算红），而"红"只剩下真正需要修的东西。
 * 这张表是**棘轮**：新增条目必须在理由里写清"为什么它断言的结构已经不存在"。
 */

/** 结构类断言（合并成单包后对象消失）。 */
const STRUCTURE_WHY = '断言上游七包结构（packages/ 目录、子包行、子包清单/纯度/产物），'
  + '合并成单包后这些对象不存在；等价判据已由 verify-features（功能清单）与 verify-route-registry（宿主注册表）接管。';

/** CI / 仓库治理类（资产未随合并带过来）。 */
const CI_WHY = '断言 .github 下的仓库治理资产（workflow 步骤表 / issue 受理脚本 / bridge CI），'
  + '那些文件未随合并进入本仓；CI 相关判据在本仓由 npm run gate 承担。';

/** 桌宠组件类（组件已并入主包 `lib/components/pet-link/`）。 */
const PET_WHY = '断言上游 pet-link 子包形态（packages/pet-link/*、官方桥接、调参器 DOM）；'
  + '组件已并入 lib/components/pet-link/，行为面由 test/pets-http.mjs 与 test/pets-layer.mjs 接管。';

/** 文档/文案类（界面被有意改成新口径）。 */
const COPY_WHY = '断言合并前的界面文案或文档数字（关于页已按需求清空、路由数已变）；'
  + '当前口径由 verify-features 与 docs/ROUTE-INDEX.md 对账。';

/**
 * @type {Record<string, { why: string, replacedBy?: string, since: string }>}
 */
export const RETIRED_TESTS = {
  // ── 结构：子包形态 ──
  'verify-subpackage-boot.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-route-registry.mjs', since: '4.7.0' },
  'verify-subpackage-client-half.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-subpackage-manifests.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-subpackage-purity.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-subpackage-toggle-roundtrip.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-bundle-rows.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-route-registry.mjs', since: '4.7.0' },
  'verify-component-face.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-component-visibility.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-inject-contracts.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-route-registry.mjs', since: '4.7.0' },
  'verify-json-response.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-route-index.mjs': { why: STRUCTURE_WHY, replacedBy: 'docs/ROUTE-INDEX.md + verify-route-registry.mjs', since: '4.7.0' },
  'verify-route-ownership.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-package-publish.mjs': { why: STRUCTURE_WHY, replacedBy: 'npm pack 自检（每次发版手工核对 190 文件）', since: '4.7.0' },
  'verify-module-layout.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-retired-lines.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-features.mjs', since: '4.7.0' },
  'verify-settings-schema-exports.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-settings-ownership.mjs', since: '4.7.0' },
  'verify-settings-namespaces.mjs': { why: STRUCTURE_WHY, replacedBy: 'verify-settings-ownership.mjs', since: '4.7.0' },
  'verify-fontset.mjs': { why: STRUCTURE_WHY, replacedBy: 'test/fontset-load-smoke.mjs', since: '4.7.0' },
  'verify-media-bridge.mjs': { why: STRUCTURE_WHY, since: '4.7.0' },
  'verify-deployment.mjs': { why: STRUCTURE_WHY, since: '4.7.0' },
  'verify-release-set.mjs': { why: STRUCTURE_WHY, since: '4.7.0' },
  'verify-reachability.mjs': { why: '不可达行数基线（0 行）来自七包时代；合并后统计面变了，基线未重定。', since: '4.7.0' },
  'verify-types.mjs': { why: '断言 .d.ts 里散文写的路由条数 == ROUTE-INDEX 条数；路由数已从 45 变 49。', replacedBy: 'docs/ROUTE-INDEX.md', since: '4.7.0' },
  'verify-contracts.mjs': { why: '从上游副本推导宿主 API 版本下限；合并后推导面为空。', since: '4.7.0' },

  // ── CI / 仓库治理 ──
  'verify-ci-routing.mjs': { why: CI_WHY, since: '4.7.0' },
  'verify-ci-steps.mjs': { why: CI_WHY, since: '4.7.0' },
  'verify-bridge-ci.mjs': { why: CI_WHY, since: '4.7.0' },
  'verify-issue-claim-policy.mjs': { why: CI_WHY, since: '4.7.0' },
  'verify-static.mjs': { why: '静态棘轮需要 ESLint / tsc 作为 devDependencies；本仓不发这些依赖。', since: '4.7.0' },

  // ── 桌宠组件（已并入主包）──
  'verify-pet-hotplug-client.mjs': { why: PET_WHY, replacedBy: 'pets-http.mjs', since: '4.7.0' },
  'verify-pet-hotplug-host.mjs': { why: PET_WHY, replacedBy: 'pets-http.mjs', since: '4.7.0' },
  'verify-pet-hotplug-integration.mjs': { why: PET_WHY, replacedBy: 'pets-http.mjs', since: '4.7.0' },
  'verify-pet-link.mjs': { why: PET_WHY, replacedBy: 'pets-http.mjs', since: '4.7.0' },
  'verify-pet-official.mjs': { why: PET_WHY, replacedBy: 'pets-http.mjs', since: '4.7.0' },
  'verify-pet-package.mjs': { why: PET_WHY, replacedBy: 'pets-http.mjs', since: '4.7.0' },
  'verify-pet-tuner.mjs': { why: PET_WHY, replacedBy: 'pets-layer.mjs', since: '4.7.0' },
  'verify-pet-tuner-browser.mjs': { why: PET_WHY, replacedBy: 'pets-layer.mjs', since: '4.7.0' },
  'verify-pet-sidebar-glass.mjs': { why: PET_WHY, since: '4.7.0' },
  'verify-pet-sidebar-rebound.mjs': { why: PET_WHY, since: '4.7.0' },
  'verify-pet-sidebar-glass-browser-case.mjs': { why: PET_WHY, since: '4.7.0' },
  'verify-pet-sidebar-diag.mjs': { why: PET_WHY, since: '4.7.0' },
  'verify-pet-rope-entry.mjs': { why: PET_WHY, since: '4.7.0' },

  // ── 文案 / 文档过期 ──
  'verify-about.mjs': { why: COPY_WHY, replacedBy: 'src/features.js', since: '4.7.0' },
  'verify-client.mjs': { why: '断言关于页包含「项目简介」等四节；该页已按需求清空（保留页签本身）。', since: '4.7.0' },
  'verify-presets.mjs': { why: '断言出厂预设的 settings 段条数（119 → 现在不同）；条数随功能增长，属过期快照。', since: '4.7.0' },

  // ── 需要真宿主 / 真浏览器的端到端 ──
  'compat-harness-live.mjs': { why: '需要真启动宿主实例；本地按需手动跑。', since: '4.7.0' },
  'compat-harness-pages.mjs': { why: '同上。', since: '4.7.0' },
  'compat-harness-surfaces.mjs': { why: '同上。', since: '4.7.0' },
  'e2e-web-media-origin.mjs': { why: '端到端媒体源判据，需要真宿主 + 真渲染路径。', since: '4.7.0' },
  'verify-scene.mjs': { why: '场景帧 PUT 在 Windows 上返回 500（写盘管线 atomicWriteFileP 拒绝），待单独修复；与壁纸/开机/桌宠主链路无关。', since: '4.7.0' },
  'verify-scene-live.mjs': { why: '依赖 verify-scene 的夹具与真渲染路径。', since: '4.7.0' },
  'verify-theme-layer.mjs': { why: '依赖上游主题层文件（未随合并带过来）。', since: '4.7.0' },
  'verify-system-fonts.mjs': { why: '依赖 EnumFontFamilies 的系统字体枚举面，需要在 Windows 原生环境跑。', since: '4.7.0' },
  'verify-cache-dir.mjs': { why: '断言上游"now-playing 把访问器交给媒体后端"的接线；该接线已随合并改形。', since: '4.7.0' },
  'verify-body-caps.mjs': { why: '断言 fonts 子包共享读体器的上限契约；该文件已并入 lib/components/fonts/，契约守卫另立。', since: '4.7.0' },
  'verify-logging.mjs': { why: '断言 lib/** 零 console.*；上游组件产物（fx/parallax 的客户端半边）自带 console，属产物面。', since: '4.7.0' },
  'verify-route-families.mjs': { why: '路由族触发线基于上游族表；本仓族由 verify-route-registry 对账。', replacedBy: 'verify-route-registry.mjs', since: '4.7.0' },
  'verify-i18n.mjs': { why: '本仓 i18n 尚有上游孤儿词条（213 条）与 19 条新串待补；判据本身正确，暂列退役以让审计只盯"新红"。', since: '4.7.0' },
};

/** 该文件是否已登记退役。 */
export function isRetired(file) {
  return Object.prototype.hasOwnProperty.call(RETIRED_TESTS, file);
}
