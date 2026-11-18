$publish = "C:\dev\whale-girl\publish"
$app = "C:\dev\whale-girl\app"
$files = @("WhaleLauncher.exe","WhaleLauncher.dll","WhaleLauncher.deps.json","WhaleLauncher.runtimeconfig.json","System.Speech.dll","runtimes\win\lib\net9.0\System.Speech.dll")
for ($i=0; $i -lt 400; $i++) {
  $running = Get-Process WhaleLauncher -ErrorAction SilentlyContinue
  if (-not $running) {
    foreach ($f in $files) {
      $src = Join-Path $publish $f
      $dst = Join-Path $app $f
      if (Test-Path $src) {
        $dir = Split-Path $dst -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item $src $dst -Force -ErrorAction SilentlyContinue
      }
    }
    Write-Output ("replaced at " + (Get-Date -Format o))
    exit 0
  }
  Start-Sleep -Seconds 3
}
Write-Output "timeout"
