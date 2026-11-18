$src='C:\dev\whale-girl\publish'; $dst='C:\dev\whale-girl\app'; $names=@('WhaleLauncher.exe' 'WhaleLauncher.dll' 'WhaleLauncher.deps.json' 'WhaleLauncher.runtimeconfig.json' 'System.Speech.dll' -join ',')
for ($i=0; $i -lt 240; $i++) {
  if (-not (Get-Process WhaleLauncher -ErrorAction SilentlyContinue)) {
    foreach ($n in $names) { Copy-Item (Join-Path $src $n) (Join-Path $dst $n) -Force }
    'swapped'; break
  }
  Start-Sleep -Seconds 5
}
