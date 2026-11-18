$src='C:\dev\whale-girl\publish'; $dst='C:\dev\whale-girl\app'
$names=@('WhaleLauncher.exe','WhaleLauncher.dll','WhaleLauncher.deps.json','WhaleLauncher.runtimeconfig.json','System.Speech.dll')
for($i=0;$i -lt 400;$i++){
  try{
    foreach($n in $names){ Copy-Item (Join-Path $src $n) (Join-Path $dst $n) -Force -ErrorAction Stop }
    "swapped $(Get-Date -Format HH:mm:ss)"; break
  }catch{ Start-Sleep -Seconds 3 }
}
