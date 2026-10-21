$ErrorActionPreference = 'Stop'
$relayRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$relayPort = if ($env:RELAY_PORT) { [int]$env:RELAY_PORT } else { 4319 }
$relayUrl = "http://127.0.0.1:$relayPort"
try {
  $health = Invoke-RestMethod "$relayUrl/api/health" -TimeoutSec 2
  if ($health.ok -and $health.version -eq '0.1.0') { Write-Output $relayUrl; exit 0 }
} catch {}
$relayData = if ($env:RELAY_DATA_DIR) { $env:RELAY_DATA_DIR } else { Join-Path $relayRoot 'data' }
New-Item -ItemType Directory -Path $relayData -Force | Out-Null
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$relayProcess = Start-Process -FilePath $nodePath -ArgumentList 'src/server.mjs' -WorkingDirectory $relayRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $relayData 'server.log') -RedirectStandardError (Join-Path $relayData 'server-error.log') -PassThru
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 250
  try { $health = Invoke-RestMethod "$relayUrl/api/health" -TimeoutSec 1; if ($health.ok) { Write-Output $relayUrl; exit 0 } } catch {}
  if ($relayProcess.HasExited) { throw 'Relay exited. Read data/server-error.log.' }
}
throw 'Relay did not become ready. Read data/server-error.log.'
