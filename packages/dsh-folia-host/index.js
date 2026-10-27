/**
 * dsh-folia-host
 *
 * 这个包没有自己的实现，只做一件事：把 `dsh-folia` 的宿主半边重新导出成
 * 一个**独立的插件包**。
 *
 * 为什么需要它：cordis.patch.yml 的宿主行 name 不能指向 patch 自己所属的
 * bundle 包（会被当成重复项跳过，wallpaperEngineHost 服务不注册，7 个子模块
 * 永久 pending）。宿主行必须指向另一个包名。
 */
export * from 'dsh-folia'
export { default } from 'dsh-folia'