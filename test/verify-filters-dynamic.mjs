// Verify the dynamic 标签 filter (4.23.9) —
// 「面板下拉改成动态」这件事的三层判据：**宿主透传** / **选项映射** / **持久化与回落**。
//
// 为什么这个守卫分「纯函数」与「源码事实」两段：
//   · 选项映射（分组 / 计数 / 隐藏同名标签 / OR 序列化 / 持久化）是纯函数，直接 import
//     `src/tag-facets.js` 断言 —— 不必起站点、不必渲染 React，跑得快且不会假绿。
//   · 「透传」发生在 `lib/routes/inventory.js` 的一次 HTTP 抓取里（要假站点 + 假缓存），
//     起真站点太脆；这一段用**源码事实 + 负对照**钉住最关键的那条不变量：
//     **任何请求都不许出现 `category≠wallpaper`**。
//
// Usage: node test/verify-filters-dynamic.mjs
import { readFileSync } from 'node:fs';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

// ── 真实风格 facets 夹具（与站点 `/api/public/wallpapers` 的形状一致）──
const FACETS = {
  categories: [
    { name: '助手皮肤', slug: 'assistant-skin', count: 61 },
    { name: '壁纸', slug: 'wallpaper', count: 46 },
    { name: '开机动画', slug: 'boot-animation', count: 3 },
  ],
  tags: [
    { name: '风景', count: 18 },
    { name: '壁纸', count: 46 },      // ← 必须被隐藏（与分类同名）
    { name: '皮肤', count: 61 },      // ← 必须被隐藏
    { name: '赛博朋克', count: 7 },
  ],
  subtags: [
    { name: '夜景', count: 5 },
    { name: '雨', count: 3 },
  ],
};

async function sectionPure() {
  const tf = await import('../src/tag-facets.js');

  // ① 分组：tags / subtags 两组，且**空组不出现**
  const groups = tf.tagOptionsFromFacets(FACETS);
  check('A1 facets → 两组（tags / subtags），顺序稳定',
    groups.length === 2 && groups[0].group === 'tags' && groups[1].group === 'subtags',
    groups.map((g) => g.group).join(','));

  // ② 计数：原样取自 facets（客户端不自己数）
  const scenery = groups[0].items.find((x) => x.value === '风景');
  check('A2 每个选项带**站点给的计数**（不是客户端本地数）',
    !!scenery && scenery.count === 18, scenery ? 'count=' + scenery.count : 'missing');

  // ③ 隐藏与分类同名的标签（选了不会变，只会让人以为筛选坏了）
  const tagValues = groups[0].items.map((x) => x.value);
  check('A3 隐藏与分类同名的标签（壁纸 / 皮肤）',
    !tagValues.includes('壁纸') && !tagValues.includes('皮肤'), tagValues.join(','));

  // ④ 子标签整组保留（不与 tags 混在一起）
  check('A4 子标签独立成组，值与计数都对',
    groups[1].items.map((x) => x.value).join(',') === '夜景,雨'
    && groups[1].items.every((x) => x.count > 0),
    groups[1].items.map((x) => x.value + ':' + x.count).join(' '));

  // ⑤ 兜底：facets 缺失 / 不是对象 / 空 / 形状不对 ⇒ 空数组（调用点据此整段不出）
  check('A5 facets 缺失 ⇒ 空数组（面板只剩原来的下拉，不空不报错）',
    tf.tagOptionsFromFacets(null).length === 0
    && tf.tagOptionsFromFacets(undefined).length === 0
    && tf.tagOptionsFromFacets({}).length === 0
    && tf.tagOptionsFromFacets({ tags: 'nope', subtags: 42 }).length === 0);
  check('A6 facets 只有 tags 时只出一组（空组不出现）',
    tf.tagOptionsFromFacets({ tags: [{ name: '风景', count: 2 }] }).length === 1);
  check('A7 坏条目被逐条丢掉，不影响其它条目', (() => {
    const g = tf.tagOptionsFromFacets({ tags: [{ name: '风景', count: 2 }, null, { count: 9 }, { name: '  ' }] });
    return g.length === 1 && g[0].items.length === 1 && g[0].items[0].value === '风景';
  })());

  // ⑥ 多选 = OR（`tag=a,b`）；空 = 不传
  check('A8 多选 OR 序列化为 `tag=a,b`（逗号分隔，顺序保持）',
    tf.tagQueryOf(['风景', '赛博朋克']) === '风景,赛博朋克');
  check('A9 空选择 ⇒ 空串（= 不传 tag，即「全部」）',
    tf.tagQueryOf([]) === '' && tf.tagQueryOf(null) === '' && tf.tagQueryOf(['', ' ']) === '');
  check('A10 去重/清洗：空项被丢掉，不会拼出 `a,,b`',
    tf.tagQueryOf(['a', '', ' b ']) === 'a,b');

  // ⑦ 下拉事件 → 已选数组（去掉占位 all）
  check('A11 selectedOptions → 已选数组（`all` 占位被剔除）', (() => {
    const ev = { target: { selectedOptions: [{ value: 'all' }, { value: '风景' }, { value: '雨' }] } };
    return tf.tagQueryOf(tf.tagPickedFromSelectEvent(ev)) === '风景,雨';
  })());
  check('A12 事件形状异常 ⇒ 空数组（不抛）',
    tf.tagPickedFromSelectEvent(null).length === 0
    && tf.tagPickedFromSelectEvent({ target: {} }).length === 0);

  // ⑧ 持久化：写读一致；清空也能被持久化（否则刷新会把旧的选回来）
  const mem = new Map();
  const storage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
  };
  check('A13 持久化写读一致（刷新保持）', (() => {
    tf.writeTagFilter(['风景', '夜景'], storage);
    const back = tf.readTagFilter(storage);
    return back.length === 2 && back[0] === '风景' && back[1] === '夜景';
  })());
  check('A14 清空也写进持久化（回到「全部」后刷新仍是全部）', (() => {
    tf.writeTagFilter([], storage);
    return tf.readTagFilter(storage).length === 0 && mem.get(tf.TAG_FILTER_KEY) === '[]';
  })());
  check('A15 持久化里是坏 JSON ⇒ 回落空数组（不崩）', (() => {
    mem.set(tf.TAG_FILTER_KEY, '{not json');
    return tf.readTagFilter(storage).length === 0;
  })());
  check('A16 没有 storage（精简环境）⇒ 空数组且不抛',
    tf.readTagFilter(null).length === 0 && tf.writeTagFilter(['x'], null) === false);
}

function sectionSource() {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const inv = read('../lib/routes/inventory.js');
  const client = read('../src/client.js');

  // ① 宿主：category 恒为 wallpaper，且**没有任何"从请求取 category"的分支**
  check('B1 宿主把 category 钉成常量 wallpaper（承重闸门）',
    /const FOLIA_API_CATEGORY = 'wallpaper';/.test(inv));
  check('B2 负对照：宿主**没有**任何"按请求参数取 category"的代码（不许有人日后拆掉闸门）',
    !/searchParams\.get\(\s*['"]category['"]\s*\)/.test(inv)
    && !/filter\.category/.test(inv));

  // ② 宿主：透传 tag / subtag 到站点 URL，且与 category/limit 同一处拼
  check('B3 宿主把 tag/subtag 拼进站点查询串（与 category 同一处）', (() => {
    const m = inv.match(/const siteScope = \(withCursor\) => \{[\s\S]*?\n {2}\};/);
    if (!m) return false;
    const body = m[0];
    return /category=/.test(body) && /FOLIA_API_CATEGORY/.test(body)
      && /tag=/.test(body) && /subtag=/.test(body);
  })());

  // ③ 宿主：facets 从站点读一次、随响应下发（字段名 facets）
  check('B4 宿主捕获站点的 data.facets 并随 inventory 响应下发',
    /doc\.data\.facets/.test(inv) && /withFacets/.test(inv) && /\bfacets\b/.test(inv));

  // ④ 宿主：带标签筛选时**不写缓存**（否则"全部"会拿到被筛过的列表）
  check('B5 带标签筛选时不污染缓存（filtered 时不写 foliaCache）',
    /if \(!filtered\) \{[\s\S]*?foliaCache = \{/.test(inv));

  // ⑤ 客户端：请求串只拼 tag/subtag，**永不**拼 category
  check('B6 客户端请求串只拼 tag/subtag/refresh', (() => {
    const m = client.match(/const qs = \[\];[\s\S]*?const invUrl = [^\n]*\n/);
    if (!m) return false;
    const body = m[0];
    return /tag=/.test(body) && /subtag=/.test(body) && !/category/.test(body);
  })());
  check('B7 负对照：客户端**永不在** inventory 请求里带 category',
    !/INVENTORY_URL\s*\+[^;]*category/.test(client));

  // ⑥ 客户端：facets 透传到 inventory store（面板据此现算选项）
  check('B8 客户端把 facets 收进 inventory store', /facets: data\.facets \|\| null/.test(client));
}

async function main() {
  await sectionPure();
  sectionSource();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length === 0
    ? 'ALL FILTERS-DYNAMIC CHECKS PASSED (' + results.length + ')'
    : failed.length + '/' + results.length + ' CHECK(S) FAILED'));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST ERROR:', err && err.stack ? err.stack : err);
  process.exit(1);
});
