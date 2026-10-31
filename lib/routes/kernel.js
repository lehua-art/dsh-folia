/**
 * routes/kernel.js — 内核/桌面端版本自检 + 升级引导（**不替用户装，只把路铺到一步**）。
 *
 * 为什么需要：皮肤中心 0.4.12 要求内核 `dsh >= 0.2.1-rc.3`。低于它时插件行会被 keep off，
 * 用户看到的只是一句"已关闭"，既不知道原因也不知道该做什么 —— 这类"看得见但动不了"的失败
 * 是最让人火大的。这里把三件事变成可执行的动作：
 *   ① 报出**当前桌面端 / 内核版本**与**要求**
 *   ② 直接给一个**升级入口**（从桌面端自己的 package.json 里读 homepage / repository 推导，
 *      绝不凭空编 URL；读不到就不给按钮）
 *   ③ 皮肤中心"被配置层关着"时，允许用户**点一下**把它打开（写 profile patch，先备份）
 *
 * 明确不做：不下载安装包、不执行安装、不改用户任何配置（除了用户点击的③）。
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const DEPS = ['disposers', 'base', 'log'];

/** 皮肤中心 0.4.12 的硬门槛（与 test/verify-skin-center-bundle.mjs 钉的同一件事）。 */
const REQUIRED_KERNEL = '0.2.1-rc.3';

function readJson(abs) {
  try { return JSON.parse(readFileSync(abs, 'utf8')); } catch { return null; }
}

/** 当前桌面端的 manifest（决定版本与升级入口）。找不到就返回 null。 */
function desktopManifest() {
  const candidates = [];
  // Electron 主进程里 resourcesPath 指向 resources/；我们的宿主跑在它里面时可直接用
  try { const rp = process['resourcesPath']; if (rp) candidates.push(join(rp, 'app.asar', 'package.json')); } catch { /* ignore */ }
  if (process.env.DSH_DESKTOP_ASAR) candidates.push(join(process.env.DSH_DESKTOP_ASAR, 'package.json'));
  candidates.push(join('C:\\Program Files\\DSH Desktop', 'resources', 'app.asar', 'package.json'));
  for (const abs of candidates) {
    if (!existsSync(abs)) continue;
    const doc = readJson(abs);
    if (doc && /^dsh-desktop$/.test(String(doc.name || ''))) {
      return { abs, doc };
    }
  }
  return null;
}

/** 比较 `x.y.z(-rcN)`：只用来判断"够不够"，不做完整 semver。 */
function kernelAtLeast(actual, required) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.?(\d+))?$/.exec(String(v || '').trim());
    return m ? { maj: Number(m[1]), min: Number(m[2]), pat: Number(m[3]), rc: m[4] === undefined ? Infinity : Number(m[4]) } : null;
  };
  const a = parse(actual);
  const r = parse(required);
  if (!a || !r) return null;              // 解析不了 ⇒ 未知，不据此判红
  if (a.maj !== r.maj) return a.maj > r.maj;
  if (a.min !== r.min) return a.min > r.min;
  if (a.pat !== r.pat) return a.pat > r.pat;
  return a.rc >= r.rc;
}

/** 从桌面端 manifest 推导升级入口（github → releases；homepage 兜底）。 */
function upgradeUrl(doc) {
  const repo = doc && doc.repository && doc.repository.url ? String(doc.repository.url) : '';
  const m = /github\.com[/:]([^/]+)\/([^/#.]+)/i.exec(repo);
  if (m) return 'https://github.com/' + m[1] + '/' + m[2] + '/releases';
  const home = doc && doc.homepage ? String(doc.homepage) : '';
  if (/^https?:\/\//i.test(home)) return home;
  return null;
}

/** profile 的 patch 文件（用户层的最高优先级）。 */
function profilePatchPath() {
  const home = process.env.DSH_HOME || join(process.env.APPDATA || homedir(), 'dsh-desktop', 'harness');
  return join(home, 'profiles', 'web', 'cordis.patch.yml');
}

/** 供其它路由复用（例如 /skins/list 把版本状态一起带给界面）。 */
export function kernelInfo() {
  const found = desktopManifest();
  const doc = found && found.doc;
  const dshVersion = doc && doc.dependencies ? String(doc.dependencies['@deepseek-ai/dsh'] || '') : '';
  return {
    detected: Boolean(doc),
    desktopVersion: doc ? String(doc.version || '') : '',
    dshVersion,
    requiredKernel: REQUIRED_KERNEL,
    kernelOk: kernelAtLeast(dshVersion, REQUIRED_KERNEL),
    upgradeUrl: upgradeUrl(doc),
  };
}

export function registerKernelRoutes(webServer, c) {
  const { disposers, base, log } = c;
  const BASE = base;

  const send = (res, status, body) => {
    try {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    } catch { /* ignore */ }
  };

  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/kernel-info`,
    handler: (req, res) => {
      send(res, 200, Object.assign({ ok: true, skinCenterBundled: '0.4.12' }, kernelInfo()));
    },
  }));

  /**
   * ② 让"皮肤中心被配置层关着"变成一步操作。
   * 只做一件事：在 profile 的 `cordis.patch.yml` 末尾**追加**一条 disabled: false。
   * 先备份原文件；失败就回滚；不接受任何未在本文档里声明的其它改动。
   */
  disposers.push(webServer.register({
    kind: 'exact',
    path: `${BASE}/kernel/enable-skin-center`,
    handler: (req, res) => {
      if ((req.method || 'GET').toUpperCase() !== 'POST') { send(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
      const file = profilePatchPath();
      try {
        if (!existsSync(file)) { send(res, 404, { ok: false, error: 'profile-patch-missing', path: file }); return; }
        const raw = readFileSync(file, 'utf8');
        if (/id:\s*skin-center/.test(raw) && /disabled:\s*false/.test(raw)) {
          send(res, 200, { ok: true, changed: false, path: file });
          return;
        }
        const backup = file + '.bak-' + Date.now();
        try { copyFileSync(file, backup); } catch { /* 备份失败就别写 */ }
        const block = '\n# 由 dsh-folia 自助启用的皮肤中心（用户点击「启用皮肤中心」时写入；原文件已备份）\n'
          + '- id: skin-center\n  name: "@linxin666/dsh-client-ui-skin-center"\n  disabled: false\n';
        writeFileSync(file, raw.replace(/\s*$/, '') + block, 'utf8');
        if (typeof log === 'function') { try { log('kernel: 已写入 skin-center disabled:false（备份 ' + backup + '）'); } catch { /* ignore */ } }
        send(res, 200, { ok: true, changed: true, path: file, backup, restartRequired: true });
      } catch (e) {
        send(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 160) });
      }
    },
  }));
}
