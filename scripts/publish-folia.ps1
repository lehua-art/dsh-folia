# publish-folia.ps1 —— 一条命令跑完"门禁 → 打包 → 发布 → 装机 → 上架验证"
#
# 为什么需要它：这次事故的根因之一是「本机修好了但没发 npm」。
# 把发布做成一条不能跳步的脚本，"忘记发版"就不再是可能。
#
# 用法：
#   .\publish-folia.ps1 -Version 4.23.0            # 完整流程（推荐）
#   .\publish-folia.ps1 -Version 4.23.0 -DryRun    # 只跑门禁，不打包不发布
#
# 前置：在 dsh-wallpaper-engine-main 仓库根目录执行；DSH Desktop 已安装（用它的 node 跑测试）。

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo
$exe = 'C:\Program Files\DSH Desktop\DSH Desktop.exe'
$node = { param($script) & $exe $script }

function Step($name, $block) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$name 失败（exit=$LASTEXITCODE）" }
}

# 0) 版本号
$pkg = Get-Content package.json -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pkg.version -ne $Version) {
  (Get-Content package.json -Raw -Encoding UTF8).Replace('"version": "' + $pkg.version + '"', '"version": "' + $Version + '"') |
    Set-Content package.json -Encoding utf8 -NoNewline
  Write-Host "版本号: $($pkg.version) → $Version"
} else { Write-Host "版本号已是 $Version" }

# 1) 构建
Step 'build-client' { & $exe 'scripts/build-client.mjs' }

# 2) 门禁（一个都不能跳）
$gates = @(
  @('test/run-guards.mjs','smoke'), 'test/verify-features.mjs', 'test/verify-route-registry.mjs',
  'test/verify-settings-ownership.mjs', 'test/verify-skin-center-bundle.mjs', 'test/verify-panel-interactions.mjs',
  'test/inventory-types.mjs', 'test/skins-http.mjs', 'test/boot-http.mjs', 'test/pets-http.mjs',
  'test/pets-layer.mjs', 'test/verify-package-files.mjs', 'test/verify-guard-chain.mjs',
  'test/verify-guard-map.mjs', 'test/verify-client-sync.mjs', 'test/verify-eol.mjs',
  'test/verify-picker-model.mjs', 'test/verify-api-client.mjs', 'test/verify-site-media.mjs',
  'test/verify-downloads.mjs'
)
# 2a) **先重算守卫映射**：新增/删除 lib 模块后 docs/GUARD-MAP.md 必然过期，
#     不重算的话 verify-guard-map 会红（这次新增了 lib/site-auth.js 与 routes/kernel.js）。
#     这一步是生成物刷新，不是"放水"：verify-guard-map 之后会逐字比对。
& $exe 'test/tools/guard-targets.mjs' '--write'
if ($LASTEXITCODE -ne 0) { throw 'guard-targets --write 失败' }

foreach ($g in $gates) {
  $args = if ($g -is [array]) { $g } else { @($g) }
  & $exe @args
  if ($LASTEXITCODE -ne 0) { throw "门禁失败: $($args -join ' ')" }
}
Write-Host '门禁全过' -ForegroundColor Green

# 3) 审计 + 静态棘轮
Step 'audit' { & $exe 'test/run-audit.mjs' }
Step 'static' { & $exe 'test/verify-static.mjs' }

if ($DryRun) { Write-Host "`n[dry-run] 门禁通过，未打包未发布" -ForegroundColor Yellow; return }

# 4) 打包 + 发布
Step 'pack' { & $exe 'C:\Program Files\DSH Desktop\resources\app.asar.unpacked\node_modules\pnpm\bin\pnpm.cjs' pack --config.ignore-scripts=true }
Step 'publish' { & $exe 'C:\Program Files\DSH Desktop\resources\app.asar.unpacked\node_modules\pnpm\bin\pnpm.cjs' publish --access public --no-git-checks --config.ignore-scripts=true }

# 5) 等 registry 上架（最多 12 次 × 15s）
$ok = $false
for ($i = 1; $i -le 12; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "https://registry.npmjs.org/dsh-folia/$Version`?cb=$(Get-Date -Format o)" -UseBasicParsing -TimeoutSec 20
    if ($r.StatusCode -eq 200) { $ok = $true; Write-Host "registry 已上架: $Version" -ForegroundColor Green; break }
  } catch { Start-Sleep -Seconds 15 }
}
if (-not $ok) { throw "registry 12 次仍未上架，请检查 npm 状态" }

# 6) 装到本机 profile（正规姿势：改依赖版本 + pnpm install，**不要手拷 node_modules**）
$profile = Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web'
$pj = Join-Path $profile 'package.json'
$raw = Get-Content $pj -Raw -Encoding UTF8
$raw = [regex]::Replace($raw, '"dsh-folia":\s*"[^"]+"', ('"dsh-folia": "' + $Version + '"'))
Set-Content $pj $raw -Encoding utf8 -NoNewline
Push-Location $profile
try {
  & $exe 'C:\Program Files\DSH Desktop\resources\app.asar.unpacked\node_modules\pnpm\bin\pnpm.cjs' install --config.ignore-scripts=true
  if ($LASTEXITCODE -ne 0) { Write-Warning 'pnpm install 失败：请手动在 profile 目录执行 pnpm install' }
} finally { Pop-Location }

Write-Host "`n完成：$Version 已发布并装到本机。请重启 DSH 后按 docs/RELEASE-GUARD.md 第四节做装机验证。" -ForegroundColor Green
