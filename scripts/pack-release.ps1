# pack-release.ps1 —— 一键生成"可以发给别人"的干净包
#
# 用途：把插件打成①插件包 .tgz（推荐，按 package.json 白名单）与②净化源码 zip（含 test/docs，便于别人改）。
# 关键：**排除厂商手册 PDF、抽取结果、node_modules、临时产物** —— 手册是受版权文档，不能随包外发。
#
# 用法：
#   pwsh -File scripts\pack-release.ps1                    # 两种都生成
#   pwsh -File scripts\pack-release.ps1 -NoSource          # 只生成 .tgz
#   pwsh -File scripts\pack-release.ps1 -OutDir D:\out     # 指定输出目录
#
param(
  [string]$OutDir = '',
  [switch]$NoSource
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $OutDir) {
  $OutDir = Join-Path (Split-Path $root -Parent) 'dist'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# 绝不外发的东西：厂商手册原文目录 / 抽取产物 / 依赖 / 临时
$excludeDirs = @('huawei', 'inspur', 'manuals', 'node_modules', 'dist', '.git', '.vscode', 'out')
$excludeFiles = @('*.tgz', '*.zip', '*.log', '*.bak', '*.tmp')

$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
Write-Host "插件：$($pkg.name) v$version" -ForegroundColor Cyan
Write-Host "源码：$root"

# ── ① 插件包 .tgz（npm 白名单打包，内容由 package.json 的 files 决定） ──
$node = 'node'
$pnpmPath = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
if (Test-Path $pnpmPath) {
  $nodeExe = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $nodeExe) { $node = $nodeExe }
  Write-Host "`n[1/2] 生成插件包 .tgz ..." -ForegroundColor Yellow
  & $node $pnpmPath --dir $root pack --pack-destination $OutDir | Out-Null
} else {
  Write-Host "`n[1/2] 未找到 pnpm，改用 npm pack ..." -ForegroundColor Yellow
  Push-Location $root
  npm pack --pack-destination $OutDir | Out-Null
  Pop-Location
}
$tgz = Get-ChildItem (Join-Path $OutDir "*.tgz") | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "  → $($tgz.FullName)（$([math]::Round($tgz.Length/1KB)) KB）"

# ── ② 净化源码 zip（排除手册与产物） ──
if (-not $NoSource) {
  Write-Host "`n[2/2] 生成净化源码 zip ..." -ForegroundColor Yellow
  $stage = Join-Path ([IO.Path]::GetTempPath()) ("slz-pack-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $target = Join-Path $stage $pkg.name
  New-Item -ItemType Directory -Force -Path $target | Out-Null

  $robocopyArgs = @($root, $target, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:0', '/W:0')
  foreach ($dir in $excludeDirs) { $robocopyArgs += @('/XD', (Join-Path $root $dir)) }
  foreach ($pattern in $excludeFiles) { $robocopyArgs += @('/XF', $pattern) }
  & robocopy @robocopyArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（exit $LASTEXITCODE）" }

  $zip = Join-Path $OutDir "$($pkg.name)-$version-source.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path $target -DestinationPath $zip -CompressionLevel Optimal
  Remove-Item $stage -Recurse -Force
  Write-Host "  → $zip（$([math]::Round((Get-Item $zip).Length/1KB)) KB）"
}

# ── ③ 自检：确认没有手册 PDF / 大文件混进去 ──
Write-Host "`n[校验] 检查外发内容是否干净 ..." -ForegroundColor Yellow
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-ArchiveEntries([string]$Path) {
  # .tgz 是 tar.gz（npm pack 产物），必须用 tar 列内容；.zip 才用 ZipFile
  if ($Path -match '\.tgz$' -or $Path -match '\.tar\.gz$') {
    $rows = & tar -tvzf $Path
    if ($LASTEXITCODE -ne 0) { throw "tar 读取失败：$Path" }
    # bsdtar 输出：权限 链接 用户 组 大小 月 日 时间 名称 —— 用命名捕获，避免"日期里有空格"把字段数搞乱
    $pattern = '^(?<perm>[\-dl][rwxslStT\-]{9})\s+(?<links>\d+)\s+(?<user>\S+)\s+(?<group>\S+)\s+(?<size>\d+)\s+(?<date>.+?)\s+(?<name>.+)$'
    return $rows | ForEach-Object {
      $m = [regex]::Match($_, $pattern)
      if (-not $m.Success) { return }
      [pscustomobject]@{ Name = ($m.Groups['name'].Value -replace '^\./', ''); Size = [int64]$m.Groups['size'].Value }
    }
  }
  $zip = [IO.Compression.ZipFile]::OpenRead($Path)
  try {
    return $zip.Entries | ForEach-Object { [pscustomobject]@{ Name = $_.FullName; Size = $_.Length } }
  } finally { $zip.Dispose() }
}

$targets = @()
$tgzItem = Get-ChildItem (Join-Path $OutDir '*.tgz') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($tgzItem) { $targets += $tgzItem }
$zipItem = Get-Item (Join-Path $OutDir "$($pkg.name)-$version-source.zip") -ErrorAction SilentlyContinue
if ($zipItem) { $targets += $zipItem }

$problems = @()
foreach ($archive in $targets) {
  $entries = @(Get-ArchiveEntries $archive.FullName)
  $pdf = @($entries | Where-Object { $_.Name -match '\.pdf$' })
  $leaks = @($entries | Where-Object { $_.Name -match '(^|/)(huawei|inspur|manuals)/' })
  $big = @($entries | Where-Object { $_.Size -gt 3MB })
  $totalMB = [math]::Round(($entries | Measure-Object Size -Sum).Sum / 1MB, 2)
  Write-Host ("  {0}：{1} 个条目，解压后约 {2} MB" -f $archive.Name, $entries.Count, $totalMB)
  if ($pdf.Count) { $problems += "$($archive.Name) 含 PDF：$($pdf.Name -join ', ')" }
  if ($leaks.Count) { $problems += "$($archive.Name) 含手册目录：$($leaks.Name -join ', ')" }
  if ($big.Count) { $problems += "$($archive.Name) 含 >3MB 文件：$($big.Name -join ', ')" }
}
if ($problems.Count) {
  Write-Host "  ✖ 发现问题：" -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
  exit 1
}
Write-Host "  ✔ 干净：无厂商手册 PDF、无手册目录、无超大文件，可以外发" -ForegroundColor Green
Write-Host "`n提示：对方安装方式见 docs\install-for-others.md（发 .tgz 让对方执行 dsh plugin add 即可）" -ForegroundColor Cyan
