# 发布：八包发布集（npm 与 GitHub Release）

> ## 0. 铁律：**先在本机验证，再对外发版**（2026-10-30 起，用户明确要求）
>
> npm 上的版本号是**单向门**：号发出去就收不回来（`unpublish` 有 24h 限制、还会破坏装过它的人）。
> 2026-10-30 那次连锁事故就是这么来的 —— 皮肤切换从 401 修到 404 再修到 404，**六连发里有四次
> 是"我这边看起来对、用户真机不对"**，每次都把一个坏版本留在了 registry 上。
>
> 所以现在的发布分**两段**，中间必须过一道真机验证：
>
> | 段 | 做什么 | 允许碰 registry 吗 |
> |---|---|---|
> | A 本机验证 | `node --check` → 构建 → 门禁 → 审计 → `pnpm pack` → **只装进本机 profile** → **等用户真机点过并确认** | ❌ 不升版本号、不 publish、不 push 到 main 也行（可以先在本地提交） |
> | B 对外发布 | 用户确认后才 `bump version` → `pnpm publish` → `git push` | ✅ 此时才发 |
>
> 判定"验证通过"的唯一标准是**用户在真机上看到了正确行为**，不是我读代码觉得应该对。
> 我不能替用户判断"能用了"；我只能给出可复现的验证步骤与他该看到的现象。
>
> 本机安装的写法（不 publish 也能让桌面端加载）：
>
> ```powershell
> # 1) 打包（版本号保持不动，可以带 -dev 后缀，但不发）
> pnpm pack --config.ignore-scripts=true
> # 2) 覆盖装进 profile（先删旧目录，再解压）
> tar -xzf dsh-folia-<ver>.tgz --strip-components=1 -C <profile>\node_modules\dsh-folia
> # 3) 让用户重启桌面端 → 实测 → 回报
> ```
>
> 一个附带纪律：**失败症状必须先能分类，再改代码**。这次连环 bug 的共同点是"一个 404 其实有
> 四五种成因（没加载/没会话/URL 拼错/id 不认/来源不对）"，我却每轮只堵一种。先让界面把状态分类
> 显示出来（`present` / `absent` / `auth-gated` / `unknown`），再谈修。

本插件在 [BUNDLE-SPLIT](../adr/) 之后由**一个主包 + 七个子包**组成，八个包版本锁步、主包把七个子包
声明成**精确版本运行依赖**。所以"发布"从来不是发一个包，而是发**一个发布集**：

| 通道 | 用户侧入口 | 需要先满足 |
|---|---|---|
| npm（推荐，DSH 桌面"添加插件"直接可用） | 包名 `dsh-plugin-folia`（可带 `@1.4.0`） | 八个包**同版本**全部在 registry 上 |
| GitHub Release（镜像 / 离线） | 八个 tarball + `release-set.json` | Release 资产**必须是八件套**，离线安装用 `scripts/install-release.mjs` |

两条通道共用同一份产物：`npm run pack:release`。

---

## 1. 为什么"只挂母包"必然失败（实测，别再试）

发布形态的主包 `dependencies` 里是七条裸精确版本（如 `dsh-plugin-folia-fx: "1.3.3"`）。
pnpm 会拿这些版本去 **registry** 解析，与"主包 tgz 从哪来"无关。2026-10-22 在隔离 profile 上实测：

```text
# 探针 A：只装发布形态主包 tarball
[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-plugin-folia-media-bridge: Not Found - 404
This error happened while installing the dependencies of dsh-plugin-folia@1.3.3
```

```text
# 探针 B：把八个 tarball 全部当顶层 file: 依赖一次装
[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-plugin-folia-fonts: Not Found - 404
```

```text
# 探针 C2：profile 的 pnpm-workspace.yaml 里写 overrides（子包名 → file:<tgz>）+ 主包 file: 依赖
Progress: resolved 13, added 13, done            # exit 0
ALL 8 top-level packages present; createRequire(profile/cordis.yml).resolve() OK ×8
```

结论：

- 顶层 `file:` **不能满足**传递依赖的 registry 版本范围（探针 B）⇒ "把八个 tgz 一次 `pnpm add`"不是安装办法。
- 唯一能让离线八件套装上的机制是 profile 的 `overrides:`（探针 C2）。这也是 DSH 自己的兼容性
  实跑走的路（`test/compat-harness-live.mjs:207-219`）。
- 2026-10-15 发布的 `v1.3.3` 就是**旧形态**：Release 只有一个 3.37 MB 的主包 tgz、npm 上也只有主包
  （`npm view` 七个子包全部 E404），当时能装只是因为那时还没有子包。这一份资产**不能**作为今后
  Release 的模板。

---

## 2. 发布前

### 2.1 升版本（八处，锁步）

根 `package.json` 与 `packages/*/package.json` 八处版本必须逐字相等，子包之间、子包对主包都不得
声明版本依赖（`test/verify-subpackage-manifests.mjs` 会拦版本漂离）。`1.3.3` 与 `1.4.0` 都已被占用：
`npm publish` 会以 `EPUBLISHCONFLICT` 拒绝，Release 也不该覆盖同名 tag。八处一起改完还要
`npm install --package-lock-only --ignore-scripts` 重算锁（`test/verify-package-publish.mjs` ⑧ 逐字比
根清单与锁的 version / 依赖规格，只改清单不重锁必红）。

### 2.2 生成发布集

```sh
npm run pack:release                      # → .test-cache/release/set-<随机>/（八个 tgz + release-set.json）
npm run pack:release -- --output <目录>    # 指定输出目录
```

产物（2026-10-22 实测，版本 1.3.3）：主包 4.29 MB、`pet-link` 19.60 MB（带 `assets/`）、其余五个
0.19–0.22 MB。`release-set.json` 的 `publishOrder` 即发布顺序：**七个子包在前，主包最后**。

`pack:release` 只打包、绝不发布；源码根目录直接 `npm pack` 得到的是**开发清单**（带 scripts 与
devDependencies，`files` 不含子包），不能当发布集用。

### 2.3 发布集自检（硬档守卫）

```sh
node test/verify-release-set.mjs
```

它真打一次包、解开八个 tarball 的字节，判四件事（五条负对照共用同一判据）：

1. 发布集 = 主包 + 仓库里每个子包各一个，名字与版本与源码清单逐字相等，主包在最后；
2. 主包 tarball 的 `dependencies` 里七个子包值 = 子包真实版本、**不带 `^`/`~`/`*`**，且不多不少；
3. 主包 tarball 不带 `packages/` `src/` `test/` `scripts/` `docs/` 等开发面目录，但必须有
   `lib/subpackage-boot.js` 与 `cordis.patch.yml`；
4. 每个子包 tarball 都有 `lib/index.js`、`cordis.patch.yml`，声明 `dsh.client` 的还必须有
   `exports['./client']` 指向的那个文件。

---

## 3. 通道 A：npm（DSH 桌面"添加插件"可用）

### 3.1 发布（严格按 `publishOrder`）

```sh
set_dir=.test-cache/release/set-XXXXXX
# 1) 七个子包
for f in $(node -e "console.log(require('./$set_dir/release-set.json').publishOrder.slice(0,-1).join(' '))"); do
  npm publish "$set_dir/$f" --access public
done
# 2) 全部成功后再发主包
npm publish "$set_dir/$(node -e "const s=require('./$set_dir/release-set.json');console.log(s.publishOrder.at(-1))")" --access public
```

Windows PowerShell 等价写法见 §5 的脚本片段（Git Bash 不可用时）。

### 3.2 为什么要"先子后主、且中间不中断"

主包先发而某个子包没发 = **灾难路径**：用户 `pnpm add dsh-plugin-folia` 会在安装期
以 `ERR_PNPM_FETCH_404` 失败并整体回滚。DSH 会把这类失败分类成 `not-found` 并在 UI 上报错，用户
看到的是"这个插件装不上"。已发布的主包**不能**靠重发同版本修好（同版本不可覆盖）——只能补发子包
（补发后立刻恢复可用），或升版本重发主包。

本轮发布前请先 `npm view <每个包>@<版本> version` 确认八个包都还没被占用；中断后恢复时只补发缺的。

### 3.3 发布后自证（三步都要过）

```sh
# ① registry 上八个版本都在
for p in dsh-plugin-folia dsh-plugin-folia-{about-notice,fonts,fx,mascot-avatar,media-bridge,parallax,pet-link}; do
  npm view "$p@1.4.0" version || echo "MISSING $p"
done
```

```sh
# ② 空白 profile 真装一次（子包必须由 registry 解析出来，而不是本机残留）
mkdir -p /tmp/rel-check && cd /tmp/rel-check
printf '{"name":"rel-check","private":true,"version":"0.0.0"}\n' > package.json
printf 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n' > pnpm-workspace.yaml
pnpm add dsh-plugin-folia@1.4.0
node -e "const{createRequire}=require('node:module');const r=createRequire(process.cwd()+'/cordis.yml');for(const n of ['dsh-plugin-folia','dsh-plugin-folia-fonts','dsh-plugin-folia-fx','dsh-plugin-folia-parallax','dsh-plugin-folia-pet-link','dsh-plugin-folia-media-bridge','dsh-plugin-folia-mascot-avatar','dsh-plugin-folia-about-notice'])r.resolve(n);console.log('8/8 OK')"
```

```sh
# ③ DSH 桌面端到端：新建 profile → 添加插件 → 贴包名 → 装完后确认八个目录都在
ls "<DSH_HOME>/profiles/<profile>/node_modules" | grep dsh-plugin-folia
```

### 3.4 npmmirror 镜像

DSH 安装源可选 `registry.npmjs.org` / `registry.npmmirror.com` / 自定义。镜像**异步同步**：主包先被
镜像、子包还没到时，选镜像源的用户会撞探针 A 那种 404。发布后逐个确认
`https://registry.npmmirror.com/<包名>/<版本>` 返回 200，再对外宣布版本可用。

---

## 4. 通道 B：GitHub Release（镜像与离线安装）

### 4.1 资产必须是八件套 + 清单

```sh
gh release create v1.4.0 \
  .test-cache/release/set-XXXXXX/*.tgz \
  .test-cache/release/set-XXXXXX/release-set.json \
  --title v1.4.0 --notes-file CHANGELOG.md
```

选配 `SHA256SUMS.txt`（`sha256sum *.tgz > SHA256SUMS.txt`）。**不要**只挂主包 tgz —— 那是一个装不上的
包（§1 探针 A）。Release 只是 npm 的镜像：同一批字节、同一个版本。

### 4.2 离线安装（走 overrides，不走 `pnpm add` 单文件）

```sh
node scripts/install-release.mjs --set <解包的发布集目录> --profile web --dsh-home <DSH_HOME> --app-closed
node scripts/install-release.mjs ... --dry-run     # 只打印将要写入的 overrides
```

它做四件事：校验发布集（清单 ↔ tarball 一一对应、主包在最后）→ 备份 profile 的 `package.json` 与
`pnpm-workspace.yaml` → 把七条 `overrides`（子包名 → 同目录 tgz）写进 `pnpm-workspace.yaml` 并补上
`nodeLinker: hoisted` / `autoInstallPeers: false` → `dsh plugin add <主包 tgz>`，最后逐个
`require.resolve` 自证八个包（含 `dsh.client` 的 `./client` 入口）与版本。

边界：profile 里**已有** `overrides:` 时脚本拒绝执行并打印要手工合并的行（两份 override 的交集不可
自动合并）；它不发布、不改版本。

### 4.3 为什么不能指望 DSH UI 直接吃 Release 的 tgz

DSH 插件管理器只执行 `pnpm add <spec>`（`parseInstallSpec` 接受 registry 包名 / git / tarball 路径 /
本地目录）。贴主包 tgz → 探针 A；贴八个 tgz 也不会一次装（管理器要求这次 add **恰好改变一个**依赖，
否则抛 `ambiguous-install`，而且顶层 `file:` 仍不满足传递范围）。所以离线八件套必须由脚本先把
overrides 落到 profile，再由管理器执行安装。

---

## 5. PowerShell 版发布片段（Windows 本机）

```powershell
$set = ".test-cache\release\set-XXXXXX"
$index = Get-Content "$set\release-set.json" -Raw | ConvertFrom-Json
$env:npm_config_cache = "$PWD\.test-cache\npm-cache"   # 沙箱/受限环境下默认缓存在 workspace 外会 EPERM
foreach ($file in $index.publishOrder) {
  npm publish "$set\$file" --access public
  if ($LASTEXITCODE -ne 0) { throw "publish failed: $file" }
}
```

---

## 6. 失败处理

| 症状 | 含义 | 处理 |
|---|---|---|
| `EPUBLISHCONFLICT` | 该版本已存在 | 不能覆盖；补发其它包，或升版本整组重发 |
| 子包发到一半中断 | 主包若已发 = 用户装不上 | 先补发缺的子包（立刻恢复），不要动已发版本 |
| 用户装完只有主包 / 报 404 | 该版本子包缺失或镜像未同步 | `npm view` 查缺哪个；补发或等镜像同步 |
| `ERR_PNPM_MISSING_TARBALL_INTEGRITY` | pnpm 11.0–11.8 在 hoisted 下对裸 URL 无 integrity | 用 11.9+（本机 11.22.0 正常）；离线装走 `install-release.mjs` |
| DSH 报 `ambiguous-install` | 一次 add 改变了多个依赖 | 一次只装一个 spec；八件套用脚本 |
| 装完界面出现重复行 | 子包被单独选成 bundle | 只选主包（`retainMainBundle` 逻辑，脚本已自动处理） |

回滚：用 `npm deprecate <包>@<版本> "原因"` 宣告，**不要** `npm unpublish`；GitHub Release 可标记为
`--prerelease` 或删资产，但已发布到 npm 的版本不可撤回。

---

## 7. 发布检查表

- [ ] 八处版本锁步提升，`grep -r '"version"' package.json packages/*/package.json` 全一致
- [ ] `npm run verify` 全绿（含 `test/verify-release-set.mjs`）
- [ ] `npm run pack:release`，确认八个 tgz + `release-set.json`
- [ ] 按 `publishOrder` 发七个子包 → 发主包
- [ ] `npm view` 八个版本全部可查
- [ ] 空白 profile 真装 + 八个 `require.resolve`
- [ ] npmmirror 八个版本全部 200
- [ ] DSH 桌面新建 profile 端到端装一次
- [ ] GitHub Release 挂**八件套**（+ `release-set.json`/`SHA256SUMS.txt`）
- [ ] Release notes 写明"从源码装见 CONTRIBUTING §2 / 离线安装见 RELEASING §4.2"
