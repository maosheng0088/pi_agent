# Run manually to load the prepared backend update after the UI update.
$ErrorActionPreference = 'Stop'
$piUpdateRoot = Split-Path -Parent $PSScriptRoot
$piUpdateEntry = Join-Path $piUpdateRoot 'server.mjs'
$piUpdateListeners = @(Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue)
if ($piUpdateListeners.Count -ne 1) { throw 'Expected exactly one Pi Web listener on port 3210.' }
$piUpdateId = [int]$piUpdateListeners[0].OwningProcess
$piUpdateProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$piUpdateId"
if ($piUpdateProcess.Name -ne 'node.exe' -or $piUpdateProcess.CommandLine -notlike "*$piUpdateEntry*") { throw 'Port 3210 does not belong to this Pi Web project.' }
& $piUpdateProcess.ExecutablePath (Join-Path $PSScriptRoot 'check-workspace-restart.mjs')
if ($LASTEXITCODE -ne 0) { throw 'An active task prevents restarting.' }
$env:PI_WEB_HOST = '0.0.0.0'
$env:PI_WEB_PORT = '3210'
$env:PI_WEB_PUBLIC_URL = 'https://ai.junweirpa.asia'
$env:PI_WEB_DATA_DIR = Join-Path $piUpdateRoot '.data'
Stop-Process -Id $piUpdateId
$piUpdateNew = Start-Process -FilePath $piUpdateProcess.ExecutablePath -ArgumentList $piUpdateEntry -WorkingDirectory $piUpdateRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $piUpdateRoot 'server-workspace.log') -RedirectStandardError (Join-Path $piUpdateRoot 'server-workspace.error.log') -PassThru
Set-Content -LiteralPath (Join-Path $piUpdateRoot 'server.pid') -Value $piUpdateNew.Id -Encoding ascii
for ($piUpdateAttempt=0; $piUpdateAttempt -lt 40; $piUpdateAttempt++) {
 try {
  $piUpdateStatus = Invoke-RestMethod 'http://127.0.0.1:3210/api/auth/status' -TimeoutSec 2
  if ($piUpdateStatus.PSObject.Properties.Name -contains 'authenticated') { Write-Output 'Pi Web is ready. Refresh the workspace.'; exit 0 }
 } catch {}
 Start-Sleep -Milliseconds 250
}
throw 'Pi Web has not become ready. See server-workspace.error.log.'
