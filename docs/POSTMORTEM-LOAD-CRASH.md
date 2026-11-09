# 崩溃复盘 + 发布前必须加的「加载冒烟」门禁

> 事故：`4.26.0-pre.3` 在用户机器上**阻断 DSH 启动**
> `Error: cannot get property "speechToText" without inject`（lib/index.js apply 阶段抛出）
> 影响面：插件被安全模式自动禁用，用户只能点"一键修复"再装回 4.25.5。
> 已修：commit `354546f`（改用 `ctx.get('speechToText')`）→ `4.26.0-pre.4`。
> 本文档 = 根因 + 为什么门禁没挡住 + 必须补的测试与流程。

---

## 1. 根因（一句话）

```
插件把 DSH 的**可选实验服务** `speechToText` 当成普通属性直接读（ctx.speechToText）；
cordis 对"顶层 inject 未声明的服务"直接抛错 ⇒ apply 抛错 ⇒ 插件加载失败 ⇒ DSH 启动被阻断。
```

```
为什么不能简单把 speechToText 加进顶层 inject：
  语音输入是 DSH 的实验特性（voice-input-bundle），用户没启用时服务不存在；
  声明为必需 ⇒ 没启用语音的机器上插件直接加载失败（同样的崩溃，只是换了一批人）
⇒ 正确写法只有一条：`ctx.get('speechToText')`（cordis 文档：Read a service without the inject requirement）
```

## 2. 为什么现有门禁没挡住（三个缺口）

```
① 只有"模块级 DEPS 对账"，没有"入口级 apply 冒烟"
   verify-inject-contracts 检查的是各路由族 export const DEPS 与消费键是否一致，
   管不到 lib/index.js 里 `ctx.xxx` 这种直读。
② 没有 fake-host 加载测试
   没有任何测试真的 import lib/index.js 并用一个"最小 ctx"跑 apply()；
   所以"缺少服务时 throw"这种错误 100% 漏过。
③ 发布流程缺"真机安装验证"
   pre.3 我先发 next、又临时把 latest 指过去 ⇒ 用户直接撞上；
   应该在 latest 之前由主机器在真实 DSH 装一次、重启确认能进界面。
```

---

## 3. 必须补的门禁（按优先级）

### G1（最高）入口加载冒烟：`test/verify-entry-load.mjs`

```
目标：用最小 fake ctx 加载 lib/index.js 并 apply，**不允许抛错**
要求：
  · fake ctx 只提供 `webServer`（最小宿主），故意**不提供** speechToText / 其它可选服务
  · apply 后断言：
      ① 不抛错
      ② 路由表里有 /folia/inventory 这类基础路由
      ③ 语音路由存在但 state 返回 asr-not-ready（服务缺席不崩）
  · 再跑一遍"提供了 speechToText"的 ctx，断言语音路由可用（正向路径）
  · 两个用例都进 run-audit（算红绿）
```

### G2 静态扫描：禁止"未声明 inject 的 ctx.服务名 直读"

```
扫描 lib/index.js 与 lib/routes/*.js：
  · 命中 `ctx.<name>`（点号直读）时，<name> 必须在顶层 `export const inject` 里；
  · 否则必须是 `ctx.get('<name>')`；
  · 例外白名单显式列出（如 ctx.effect / ctx.get / ctx.logger），并在文件里注释原因。
实现：新增 test/verify-ctx-access.mjs，纳入 run-audit
```

### G3 发布纪律（流程，不是代码）

```
发 latest 之前，必须由**有 DSH Desktop 的机器**完成：
  ① 安装该版本 → 重启 DSH → 能进界面（不出现"启动遇到问题"）
  ② 打开插件面板 → 桌宠页签 → 点宠物弹气泡
  ③ 任一基础功能可用（壁纸列表能拉）
只发 next 时不强制；但**任何要指到 latest 的版本必须先过这三步**。
```

### G4 回滚演练

```
每次发 latest 前确认：
  · stable-<version> 标签存在且指向上一稳定版
  · 回滚命令已写入发布说明（npm dist-tag add dsh-folia@<stable> latest）
```

---

## 4. 让那台机器做的事（一次交付）

```
1) 复核 354546f 的修法是否正确（ctx.get 版本），并在 lib/index.js 注释里写清原因（已写，可校对）
2) 新增 G1：test/verify-entry-load.mjs（两个用例：无 speechToText / 有 speechToText）
3) 新增 G2：test/verify-ctx-access.mjs（静态扫描 + 白名单）
4) 把这两条接进 run-audit（必须能在输出里看到它们通过）
5) 自检：故意把 ctx.get('speechToText') 改回 ctx.speechToText，确认 G2/G1 会红（负例验证）
6) 提交信息写：fix(load): 入口不再直读可选服务 + 新增加载冒烟与 ctx 访问白名单门禁
```

## 5. 主机器（这边）补充

```
· 任何版本指到 latest 前，我在真机装一次 + 重启确认（这次是我的流程缺口）
· 发布前把 `stable-<上一版>` 标签打好；发布说明里写回滚命令
```
