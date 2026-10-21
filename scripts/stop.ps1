$ErrorActionPreference = 'Stop'
$relayRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$relayData = if ($env:RELAY_DATA_DIR) { $env:RELAY_DATA_DIR } else { Join-Path $relayRoot 'data' }
$relayInstance = Get-Content -LiteralPath (Join-Path $relayData 'instance.json') -Raw | ConvertFrom-Json
$relayUri = [uri]$relayInstance.url
if ($relayUri.Scheme -ne 'http' -or $relayUri.Host -ne '127.0.0.1') { throw 'Invalid relay URL.' }
$relayKey = [System.IO.File]::ReadAllText((Join-Path $relayData 'control.key')).Trim()
Invoke-RestMethod "$($relayInstance.url)/api/shutdown" -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $relayKey" } -Body '{}' | Out-Null
Write-Output 'Relay stopped; queued messages remain saved.'
