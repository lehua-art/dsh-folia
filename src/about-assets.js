/**
 * about-assets.js — 「关于」页签与「更新公告」用到的**静态数据**（仓库地址 + 随包图的路径）。
 *
 * 本仓自有版本：**不再包含上游的交流群二维码与赞赏码**（QQ 群 / 抖音群 / 原作者收款码）。
 * 「关于」页只剩项目简介 / Star / 贡献者致谢三节；联系方式指向仓库 Issues。
 * 图片仍走 `lib/about/` + 白名单路由直出（理由见 lib/components/about-notice/routes/about-qr.js），
 * 剩下的唯一一张是「更新公告」的配图。
 *
 * 契约（构建期由 scripts/build-client.mjs 内联进 bundle 的工厂作用域）：纯数据、零依赖，
 * 必须保持浏览器安全（无 import / require / Node API）。
 */

// 项目仓库（README / package.json 的同一条地址）：关于页的按钮与可复制文本都用它。
const ABOUT_REPO_URL = "https://github.com/lehua-art/dsh-folia";

// 「更新公告」一次弹窗的配图（JPEG 720×720，本仓自有素材）：
//   · 随包发布 lib/about/update-notice.jpg，由 /about-qr 路由族直出（同一白名单）
//   · 版本换图 = 替换 lib/about/update-notice.jpg 的字节，路径与产物都不动（ETag 会变）。
const NOTICE_ART_PATH = "/about-qr/update-notice.jpg";

export {
  ABOUT_REPO_URL,
  NOTICE_ART_PATH,
};
