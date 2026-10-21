$relayHosts = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' -or $_.ExecutablePath -like '*deepseek*' }
$relayHostIds = @($relayHosts.ProcessId)
if ($relayHostIds.Count -eq 0) { Write-Output '[]'; exit }
$relayPorts = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $relayHostIds -and $_.LocalAddress -in '127.0.0.1','::1' } | Select-Object -ExpandProperty LocalPort -Unique
ConvertTo-Json -InputObject @($relayPorts) -Compress
