# 下载完整性保障（4.23.7）

> 为什么有这一页：4.23.6 修的是「下载完成了但装不上」，4.23.7 修的是更坏的一类 ——
> **下载"成功"了，但文件内容是坏的**。后者不会报错：job 报 `done`、长度和站点声明的一致、
> 面板上进度条也走完了，直到用户双击那个 zip 才发现打不开。

## 1. 事故现场（真实复现，不是构造）

站点对**同一个 URL** 有两个对象：

| 请求形态 | 返回的版本 | 长度 | ETag |
|---|---|---|---|
| 全量 GET（无 `Range`） | 旧版 | `17,509,106` | `"v1-…"` |
| `Range: bytes=a-b` | 新版 | `17,414,581` | `"v2-…"` |

旧的多连接实现（`lib/download-queue.js` 的 `fetchRanged`）把这 8 段**混着拼**进同一个
`.part`：

- 每段都只校验 `status === 206`；
- 每段的"实收字节"写的是 `return end - start + 1`（**请求长度**，不是收到的字节）；
- `base === 0` 时先 `truncateSync(part, total)` 把文件预填成 `total` 个 `0x00`。

于是：

```
落盘大小 = 17,509,106（和站点声明一致）
内容     = 旧版字节 + 新版字节 + 尾部 94,525 个 0x00
job      = done
```

`17,509,106 - 17,414,581 = 94,525` —— 尾巴上那截 0 就是"新版比旧版短的那一段"。

### 三行代码，三种"恒真"

| 位置（4.23.6 的 `lib/download-queue.js`） | 写法 | 后果 |
|---|---|---|
| `:387` | `return end - start + 1` | 收尾 `written !== span` **恒不成立**（永远等于请求总长） |
| `:369-373` | 只判 `r.status !== 206` | 双版本对象的字节被当成"同一份" |
| `:354-357` | `truncateSync(part, total)` | 收尾 `onDisk !== total` **恒不成立**（预填已把文件撑到 total） |
| `:378-385` | 无逐片计数 | 短读（body 少于请求）被静默吞掉 |

一句话：**长度判据被预填骗、总量判据被自己写死**，两个"校验"在这条路上从来没生效过。

## 2. 三层校验（现在的判据）

下载完成的定义从"文件长度对"扩成三道，**从传输到内容逐层收紧**：

### 第一层：长度（每片 + 收尾）

```js
let got = 0;                       // ① 逐片**实收**字节
src.on('data', (c) => { got += c.length; ... });
src.on('end', () => got !== want ? reject(new Error('range-short')) : resolve());
```

- 每片：`got === end - start + 1`，否则 `range-short:<got>/<want> @<start>-<end>`；
- 收尾：`Σ got === span`，再核 `statSync(part).size === total`。
- **不再预填** `0x00`：`base === 0` 只建空文件，写多少涨多少 ⇒ 落盘长度重新成为证据。
  （选择"按实际长度定长"而不是"维护已收区间"：区间在①已经逐片核对过、分片按构造连续覆盖
  `[base, total-1]`，再来一份区间账只是重复证据；而"文件长度"原本是唯一的独立证据，
  必须先让它恢复可信。）

### 第二层：`Content-Range` + `ETag`（是不是同一个对象）

```js
const cr = parseContentRange(r.headers.get('content-range'));
if (cr.start !== start || cr.end !== end) throw 'range-version-mismatch';
if (cr.total !== null && cr.total !== total) throw 'range-version-mismatch';
const etag = r.headers.get('etag');
if (etag && expectedEtag && etag !== expectedEtag) throw 'range-etag-mismatch';
```

- `start` / `end` 必须是**我们请求的那一段**；
- `/total` 必须是**全量响应给出的那个总量**（`*` 视为未知，不据此放行/拒绝）；
- 全量响应那次的 `ETag` 是"这一版对象"的见证人，各 206 的 `ETag` 若存在必须与它一致。

单流续传（`resumeSingle`）也吃同一条总量判据：从 `from` 续的 206 若报另一个 `/total`，
宁可明确失败，也不从那里往后写。

### 第三层：内容哈希（是不是那个文件）

站点清单里皮肤包 / 壁纸 / 开机动画 / 桌宠的条目带 `sha256`（**部分为空**）：

- 为空 ⇒ 这一层不设防（前两层仍然生效），绝不因为一条脏字段把下载判失败；
- 非空 ⇒ 落地前流式计算 `.part` 的 sha256，**不一致即判失败**。
  例：同一 URL 下站点重传了内容、CDN 回源到另一个构建、代理把 200 全量响应当 206 交付 ——
  前两层拦不住这些，只有哈希能答"这是不是那个文件"。
- 顺带修了"上次留下的坏文件"：HEAD 命中"大小 + ETag 一致"时，若清单给了 sha256
  **也会验一次已有文件**；对不上就当它不存在、照常重下（否则 4.23.6 之前拼坏的 zip 会永久留在本地）。

## 3. 失败回落路径（任何一步 throw 都不许停在中间态）

```
                        ┌──────────────── 单流下载（默认，auto 下 3 秒评估）
        fetchRanged ────┤
     （range-short /    │  任一 throw
      version-mismatch /│        │
      etag-mismatch /   └────────▼
      range-unsupported）  truncateSync(part, from)  ← 分片是并发按偏移写的，必须先截回切换点
                                    │
                                    ▼
                           resumeSingle(from)  单流续传（startAt=0 时清空重下）
                                    │
                      ┌─────────────┴─────────────┐
                  成功 │                           │ 失败 / 内容对不上
                      ▼                           ▼
                    done              failed(reason=...) —— 明确原因，可 retry
```

**hash-mismatch 是唯一一条"自动重下一次"的路径**（且只一次）：

1. 删掉 `.part` 与已落地的目标文件（坏文件一个字节都不留）；
2. `failed`，`error = "hash-mismatch"`；
3. 自动把 job 放回队列，置 `singleOnly`（**换单流**重取同一批字节 —— 重试的意义是换一条
   传输路径，而不是把同一组分片判据再跑一遍）；`job.hashRetry` 记账，只此一次；
4. 仍然不一致 ⇒ `failed`，`error = "hash-mismatch: 传输内容与站点不一致"`，不再自动重试
   （用户手动再点一次是**新的一轮**，仍可再享受一次自动重下）。

## 4. 对应测试

`test/verify-ranged-integrity.mjs`（**33 条**，进门禁 `npm run verify`）：

| # | 假站点的行为 | 断言 |
|---|---|---|
| ① | 全量 `17,509,106`（旧版）/ Range `17,414,581`（新版，总量不同） | 不产出 ranged `done`；错误含 `range-version-mismatch`；回落单流后落地文件 sha256 = 全量响应那份；`received/total` 只来自单流 |
| ② | 某片短读（body 少于请求，`Content-Range` 仍声称整段） | 错误含 `range-short`；回落后内容正确 |
| ③ | Range 正常 | `mode = ranged:4` 成功、`verified = sha256`、4 条 Range / 0 次回落（**正向不回归**） |
| ④ | 206 的 ETag ≠ 全量响应的 ETag | 错误含 `range-etag-mismatch`；回落后正确 |
| ⑤ | 第一次给坏内容、之后给好内容（清单已给 sha256） | `hash-mismatch` → 自动单流重下一次 → `done` + `verified=sha256`；**共 2 次全量请求** |
| ⑤b | 永远给坏内容 | `failed`，文案含「传输内容与站点不一致」；**共 2 次请求**（不无限循环）；dest / `.part` 都已删除 |
| ⑥ | 负对照（**旧实现必须红**） | 见下 |

### 4.1 「旧实现会红」的证据（不是"我相信"）

⑥ 由三部分组成，缺一条都不算：

- **⑥a 源码级判据**：取出真 `fetchRanged` 的函数体，要求同时具备
  `got += buf.length` / `got !== want` / `range-short` / `content-range`（start、end、`/total`
  三项）/ `range-etag-mismatch` / "只建空文件"，且**不得**出现
  `return end - start + 1` 与 `truncateSync(part, total)`。
- **⑥b 变异**：把上面六处逐个"贴回旧写法"喂给**同一个判据函数**，每一处都必须被判红且
  指对位置（证明判据不是恒真）。
- **⑥c/⑥d/⑥e 行为级**：把 4.23.6 的旧算法原样内嵌成 `legacyFetchRanged()`，对**同一个**
  双版本假站点跑一遍：
  - 它**不抛错**（"成功"）；
  - 产物大小 = `17,509,106`（长度"对"）；
  - 产物尾部恰好 `94,525` 个 `0x00`，sha256 与正确内容不同；
  - 把本测试 ① 的断言（`done && sha256 === 正确哈希`）喂给这个产物 ⇒ **判红**。

也就是说：把 `lib/download-queue.js` 回滚到 4.23.6，这条回归测试会闪红 —— 这正是 P0 回归该有的样子。

## 5. 缓存管理面板（同一版的另一半）

`GET /folia/cache/usage` + `POST /folia/cache/clear { targets }`（`lib/routes/cache.js`）：
五层用量（媒体库 / 站点媒体 / 皮肤包 / 已装皮肤 / Electron）与**分目标**清理。安全边界：

- 请求体里**只有目标名**（白名单），路径一律由宿主自己按 `DSH_HOME` 与 `%APPDATA%\dsh-desktop`
  算出；`..`、绝对路径、盘符、UNC 都不是合法目标 ⇒ **整单 400**（一个坏名字就一个都不执行）；
- 算出的每个目录必须落在允许根之内（`isWithin`，用 `relative` 而不是字符串前缀）；
- **不跟随符号链接**：统计用 `lstat`、软链只计"跳过的链接"；清理只删链接本身；
- 删不掉（被占用）的文件进 `failed`、其余照删、响应 `partial:true`，**不 500**；
- `skins` 必须**显式点名**才清（清掉 = 皮肤中心的皮肤全部卸载），面板上是唯一一个两段式确认的按钮；
- 清完把 `downloads.json` 里**对应 kind 且 done** 的记录摘掉，避免"done 但文件已经没了"。

判据在 `test/verify-cache-manager.mjs`（**67 条**）：各 target 只删自己、诱饵目录一个字节不动、
路径穿越 400、符号链接不跟随、操作系统级"被占用"文件进 failed（Windows 用
`FileShare.None` 真占用，POSIX 用父目录去写位）、`skins` 只有点名才清、面板五个按钮各自
只发自己的 targets、两段式确认（第一下只上膛）、toast 报"释放 X"。
