/**
 * tag-facets.js — **站点 facets → 标签筛选**的纯函数族（4.23.9）。
 *
 * ══ 为什么单开一个文件 ══════════════════════════════════════════════════════════
 * 「标签」下拉的选项不是写死的，而是**站点在清单响应里聚合出来的** `data.facets`
 *（`{ categories, tags, subtags }`，每项带计数）。这一段有三个容易写错又不好用肉眼
 * 验证的点：计数怎么取、分组怎么标、哪些标签要藏。把判据抽成纯函数（不读全局、
 * 不碰 DOM、不碰网络）⇒ `test/verify-filters-dynamic.mjs` 可以直接 import 本文件断言，
 * 不必起站点、不必渲染 React。
 *
 * ══ 不变量 ══════════════════════════════════════════════════════════════════
 *   · **只用 facets**：不另拉接口、不在客户端自己数计数（客户端的"本地计数"会把
 *     "共 N 条"算成"当前这页有几条"，与服务端口径不一致）。
 *   · **任何异常都退化成空**：facets 缺失 / 不是对象 / tags 不是数组 / 项里没有名字
 *     ⇒ 返回 `[]`，调用点据此整段不出（面板不空、不报错）。
 *   · **隐藏与分类同名的标签**：`壁纸` / `皮肤` / `wallpaper` 这类标签与当前页签的
 *     分类是同一件事，选了不会让列表变短，只会让用户以为"筛选坏了"。
 *   · **多选 = OR**（`tag=a,b`），空 = 「全部」= **不传 tag**。
 *     注意与 `category` 无关：`category=wallpaper` 是宿主侧的承重闸门，恒不变。
 *   · 本文件必须浏览器安全（无 import / require / Node API），且**不得有顶层可执行
 *     语句**读 client.js 的 const（会被内联到 bundle 顶部，撞 TDZ）。
 */

/** 与分类同名、选了也没意义的标签（小写比较）。 */
const TAG_HIDDEN_NAMES = ['wallpaper', '壁纸', '皮肤', 'skin', 'skin-pack', 'assistant-skin', 'boot-animation', '开机动画'];

/** 一个 facets 条目（`{ name|value|slug|tag, count|n }`）→ `{ value, label, count }`；认不出 ⇒ null。 */
function tagFacetItem(it) {
  if (!it) return null;
  if (typeof it === 'string') {
    const v = it.trim();
    return v ? { value: v, label: v, count: 0 } : null;
  }
  if (typeof it !== 'object') return null;
  const value = String(it.value || it.name || it.slug || it.tag || '').trim();
  if (!value) return null;
  if (TAG_HIDDEN_NAMES.includes(value.toLowerCase())) return null;
  const raw = Number(it.count != null ? it.count : it.n);
  return { value, label: value, count: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0 };
}

/**
 * `facets` → 下拉分组。
 *
 * 返回 `[{ group: 'tags' | 'subtags', items: [{ value, label, count }] }]`；
 * 空组**不出现**（否则两个空 optgroup 会让下拉看起来像坏了）。任何异常 ⇒ `[]`。
 *
 * `group` 用**稳定 id** 而不是中文文案：文案的翻译在渲染点（`weT("标签")` / `weT("子标签")`），
 * 这样 i18n 扫描器能看到字面量调用点，词条不会变成"没有调用点的孤儿键"。
 */
function tagOptionsFromFacets(facets) {
  try {
    if (!facets || typeof facets !== 'object') return [];
    const norm = (list, group) => {
      const rows = Array.isArray(list) ? list : [];
      const items = rows.map(tagFacetItem).filter(Boolean);
      return items.length ? { group, items } : null;
    };
    return [norm(facets.tags, 'tags'), norm(facets.subtags, 'subtags')].filter(Boolean);
  } catch { return []; }
}

/** 已选标签 → 请求里的 `tag` 值（OR，逗号分隔）。空 ⇒ `''`（= 不传）。 */
function tagQueryOf(picked) {
  const list = Array.isArray(picked) ? picked : [];
  return list.map((t) => String(t == null ? '' : t).trim()).filter(Boolean).join(',');
}

/** 下拉多选框的 `selectedOptions` → 已选数组（去掉占位的 `all`）。 */
function tagPickedFromSelectEvent(ev) {
  try {
    const opts = ev && ev.target && ev.target.selectedOptions;
    const arr = opts ? Array.from(opts) : [];
    return arr.map((o) => String((o && o.value) || '')).filter((v) => v && v !== 'all');
  } catch { return []; }
}

/** 持久化键（刷新保持）。 */
const TAG_FILTER_KEY = 'dsh-folia.tagFilter';

/** 读持久化选择。任何异常 ⇒ `[]`（宁可回到"全部"，也别让面板打不开）。 */
function readTagFilter(storage) {
  try {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return [];
    const raw = st.getItem(TAG_FILTER_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((t) => String(t == null ? '' : t)).filter(Boolean) : [];
  } catch { return []; }
}

/** 写持久化选择；空数组也照写（"清空"必须能被持久化，否则刷新会把旧的选回来）。 */
function writeTagFilter(picked, storage) {
  try {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return false;
    st.setItem(TAG_FILTER_KEY, JSON.stringify(Array.isArray(picked) ? picked : []));
    return true;
  } catch { return false; }
}

export {
  TAG_HIDDEN_NAMES, TAG_FILTER_KEY,
  tagOptionsFromFacets, tagQueryOf, tagPickedFromSelectEvent, readTagFilter, writeTagFilter,
};
