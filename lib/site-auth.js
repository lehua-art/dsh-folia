/**
 * site-auth.js — 站点访问凭据（**为"接口只给我们的插件用"预留的开关**）。
 *
 * 背景：`/api/public/wallpapers` 与 `/media/*` 目前是公开的，任何人 curl 就能拉。
 * 目标形态是"只有装了插件、且持有有效订阅的用户能拉"。在订阅系统落地之前，
 * 先把**凭据注入**这一层做好：站点一开校验，插件立刻就能通，不用再发版。
 *
 * 取值顺序（先到先用）：
 *   ① 环境变量 `DSH_FOLIA_SITE_KEY`      —— 临时调试/CI 用
 *   ② `$DSH_HOME/site-key.txt`           —— 用户级安装态（第一行非空即 key）
 *   ③ 都没有 ⇒ 返回空对象（**向后兼容**：现在的公开站点照常工作）
 *
 * 明确不做：不内置任何固定密钥。客户端里的密钥一定可被提取，
 * 真正安全的是"每用户 token + 服务端验签"（见 docs/SITE-DOWNLOAD-API.md 的订阅章节）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 站点 key 文件位置（与插件其它状态同一口径）。 */
export function siteKeyPath() {
  const home = process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
  return join(home, 'site-key.txt');
}

/** 当前生效的站点 key（没有就返回空串）。每次调用都读，便于用户改完即时生效。 */
export function siteApiKey() {
  const env = process.env.DSH_FOLIA_SITE_KEY;
  if (env && String(env).trim()) return String(env).trim();
  try {
    const p = siteKeyPath();
    if (existsSync(p)) {
      const first = readFileSync(p, 'utf8').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first) return first;
    }
  } catch { /* 读不到就当没有 */ }
  return '';
}

/**
 * 给站点请求附加的头：有 key 就带 `authorization`，没有就只带 accept。
 * 统一入口，避免四个路由各写一遍、将来漏一个。
 */
export function siteRequestHeaders(extra = {}) {
  const headers = { accept: 'application/json', ...extra };
  const key = siteApiKey();
  // 用展开而不是 `headers.authorization = ...`：后者会把对象推断成 `{ accept: string }`
  // 而多出一条 TS2339（渲染期无差异，但静态棘轮会红）。运行时行为与之前完全一致。
  return key ? { ...headers, authorization: 'Bearer ' + key } : headers;
}
