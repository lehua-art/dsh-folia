/**
 * lib/env.js — 环境**唯一真源**：站点基址与 DSH 数据目录。
 *
 * 为什么要有它：`siteBase()` 曾在 boot / modules / pets / skins / site-thumb 五个路由文件里
 * 各写一遍（连 `DEFAULT_SITE` 常量都各一份），`$DSH_HOME` 的解析也在 pets 与 skins 各写一遍。
 * 这些是**契约级**的东西 —— 五份实现里只要有一份对 `DSH_FOLIA_SITE=off` 或尾斜杠处理不同，
 * 症状就是"某个页签能用、另一个页签说站点不可达"，而排查时看的是不同的文件。
 *
 * 纪律：
 *   · 这里只做**纯读**（不看 ctx、不写文件、不缓存），所以任何模块在任何时机调用都安全；
 *   · 参数可注入（`env`），测试能构造各种取值而不污染 process.env；
 *   · `dshHome()` 与皮肤中心 / 桌宠的解析**同口径**（`$DSH_HOME` → `%APPDATA%/dsh-desktop/harness`）。
 */
import { homedir } from 'node:os';

/** 站点默认基址（可用 `DSH_FOLIA_SITE` 覆盖；`off` 表示彻底关闭站点数据源）。 */
export const DEFAULT_SITE = 'https://folia-5ve.pages.dev';

/**
 * 站点基址。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null} `null` = 站点被显式关闭
 */
export function siteBase(env = process.env) {
  const raw = env && env.DSH_FOLIA_SITE;
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'off') return null;
  const base = (typeof raw === 'string' && raw.trim()) ? raw.trim() : DEFAULT_SITE;
  return base.replace(/\/+$/, '');
}

/**
 * DSH 数据目录（`$DSH_HOME`）。
 *
 * Windows 桌面端是 `%APPDATA%\dsh-desktop\harness`；其它平台回落 `~/.dsh`。
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function dshHome(env = process.env) {
  const e = env || {};
  const raw = e.DSH_HOME;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  const appData = e.APPDATA;
  if (typeof appData === 'string' && appData.trim()) return appData.trim() + '/dsh-desktop/harness';
  const home = e.USERPROFILE || e.HOME || (() => { try { return homedir(); } catch { return ''; } })();
  return home + '/.dsh';
}
