# 打包全量便携版：程序 + 插件 + 数据 + 说明
# 用法：powershell -ExecutionPolicy Bypass -File tools\make-portable.ps1
# 编码：UTF-8 with BOM
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = 'C:\dev\whale-girl' }
$stamp = Get-Date -Format 'yyyyMMdd'
$name = "鲸鲸-portable-$stamp"
$stage = Join-Path $env:TEMP $name
$dist = Join-Path $root 'dist'
$zip = Join-Path $dist "$name.zip"

Write-Host "== 打包 $name ==" -ForegroundColor Cyan
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path $dist -Force | Out-Null

# 1) 程序本体（app），排除 data 与日志
Write-Host '复制 app\ ...'
$appDst = Join-Path $stage 'app'
robocopy (Join-Path $root 'app') $appDst /E /NFL /NDL /NJH /NJS /XD data /XF '*.log' 'npm-debug.log*' | Out-Null

# 2) 插件源码
Write-Host '复制 custom\plugins\ ...'
$plugDst = Join-Path $stage 'custom\plugins'
robocopy (Join-Path $root 'custom\plugins') $plugDst /E /NFL /NDL /NJH /NJS /XD tests node_modules /XF '*.zip' | Out-Null

# 3) 数据（排除账号/密钥/日志）
Write-Host '复制 data\ ...'
$dataSrc = Join-Path $root 'app\data'
$dataDst = Join-Path $stage 'data'
robocopy $dataSrc $dataDst /E /NFL /NDL /NJH /NJS /XD 'logs' 'run-*' /XF 'accounts.json' 'settings.json' 'weibo.cookie' '*.log' | Out-Null

# 4) 说明 + 启动脚本
Write-Host '复制 docs\install\ ...'
robocopy (Join-Path $root 'docs\install') (Join-Path $stage 'docs\install') /E /NFL /NDL /NJH /NJS | Out-Null
robocopy (Join-Path $root 'tools') (Join-Path $stage 'tools') /E /NFL /NDL /NJH /NJS /XF '*.ps1' | Out-Null

@'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 启动鲸鲸内核...
start "" "app\runtime\node.exe" "app\server.js"
timeout /t 2 >nul
echo 打开界面...
start "" "app\WhaleLauncher.exe"
'@ | Set-Content -Path (Join-Path $stage '启动.cmd') -Encoding OEM

@"
# 鲸鲸便携版（$stamp）

1. 双击 `启动.cmd`（或先开 `app\WhaleLauncher.exe` 再点「启动」）
2. 扫码登录微信
3. 设置里填 DeepSeek Key
4. 设置 → 权限 → 填主人 wxid

- 数据在 `data\`，账号与 Key 故意没打包，第一次要重登重填。
- 插件在 `custom\plugins\`，已装的在 `data\plugins\`。
- 环境要求见 `docs\install\00-环境准备.md`。
"@ | Set-Content -Path (Join-Path $stage 'README.md') -Encoding UTF8

# 5) 打 zip
Write-Host '压缩 ...'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "完成：$zip（$mb MB）" -ForegroundColor Green
Write-Host "临时目录：$stage（可删）" -ForegroundColor DarkGray
