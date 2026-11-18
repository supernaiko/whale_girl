# 环境体检：缺什么、装哪里
# 用法：powershell -ExecutionPolicy Bypass -File tools\env-bootstrap.ps1
# 编码：UTF-8 with BOM（Windows PowerShell 5.1 需要）
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = 'C:\dev\whale-girl' }
Write-Host "== 鲸鲸环境体检 ==" -ForegroundColor Cyan
Write-Host "仓库：$root`n"

$tools = 'C:\dev\tools'

function Probe($name, $pathOrCmd, $flag, $hint) {
  $exe = $null
  if ($pathOrCmd -like '*\*') {
    if (Test-Path $pathOrCmd) { $exe = $pathOrCmd }
  } else {
    $c = Get-Command $pathOrCmd -ErrorAction SilentlyContinue
    if ($c) { $exe = $c.Source }
  }
  if (-not $exe) {
    Write-Host ("[缺失] {0,-10} {1}" -f $name, $hint) -ForegroundColor Yellow
    return
  }
  $job = Start-Job { param($e, $f) & $e $f 2>&1 | Select-Object -First 1 } -ArgumentList $exe, $flag
  if (Wait-Job $job -Timeout 5) {
    $v = Receive-Job $job
    Write-Host ("[OK]   {0,-10} {1}" -f $name, ($v -join ' ')) -ForegroundColor Green
  } else {
    Write-Host ("[超时] {0,-10} 命令无响应，可用但建议手动确认" -f $name) -ForegroundColor Yellow
  }
  Remove-Job $job -Force
}

# 包内运行时
$appNode = Join-Path $root 'app\runtime\node.exe'
$appPy   = Join-Path $root 'app\runtime\python\python.exe'
if (Test-Path $appNode) { Probe '内置Node'  $appNode '-v' '' } else { Write-Host '[缺失] 内置Node   app\runtime\node.exe' -ForegroundColor Yellow }
if (Test-Path $appPy)   { Probe '内置Python' $appPy '-V' '' } else { Write-Host '[提示] 内置Python 不在 app\runtime\python' -ForegroundColor DarkGray }

# 开发工具：先看 C:\dev\tools，再看 PATH
Probe 'dotnet' (Join-Path $tools 'dotnet\dotnet.exe') '--version' '装 .NET SDK 10 到 C:\dev\tools\dotnet'
Probe 'git'    (Join-Path $tools 'git\cmd\git.exe') '--version' '装 MinGit 2.x 到 C:\dev\tools\git'
Probe '系统Node' 'node' '-v' '装 Node 22/24'
Probe 'codex'  'codex' '--version' 'npm i -g @openai/codex 然后 codex login'

Write-Host "`n== 关键文件 ==" -ForegroundColor Cyan
foreach ($f in 'app\server.js','app\WhaleLauncher.exe','custom\plugins\whale-ops\plugin.js','docs\install\00-环境准备.md') {
  $p = Join-Path $root $f
  if (Test-Path $p) { Write-Host "[OK]   $f" -ForegroundColor Green } else { Write-Host "[缺失] $f" -ForegroundColor Red }
}

Write-Host "`n== 运行状态 ==" -ForegroundColor Cyan
try {
  $s = Invoke-RestMethod 'http://127.0.0.1:8787/api/status' -TimeoutSec 3
  Write-Host "[在线] 内核 $($s.version)" -ForegroundColor Green
  $pl = Invoke-RestMethod 'http://127.0.0.1:8787/api/plugins/status' -TimeoutSec 3
  $on = @($pl.items | ForEach-Object { $_.id }) -join ', '
  Write-Host "[在线] 已启用插件：$on" -ForegroundColor Green
} catch {
  Write-Host '[离线] 内核未启动（app\runtime\node.exe server.js 或 启动.cmd）' -ForegroundColor Yellow
}

Write-Host "`n完成。缺的按 docs\install\00-环境准备.md 装。" -ForegroundColor Cyan
