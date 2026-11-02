param([int]$Port = 3210)
$ErrorActionPreference = 'Stop'
$piRestartRoot = Split-Path -Parent $PSScriptRoot
$piRestartEntry = Join-Path $piRestartRoot 'server.mjs'
$piRestartBuild = Join-Path $piRestartRoot 'frontend\dist\index.html'
$piRestartPidFile = Join-Path $piRestartRoot 'server.pid'
if (-not (Test-Path -LiteralPath $piRestartBuild)) { throw 'Build the frontend first: npm run build:frontend' }
if (-not (Test-Path -LiteralPath $piRestartPidFile)) { throw 'server.pid is missing; verify the running server before restarting.' }
$piRestartId = [int](Get-Content -LiteralPath $piRestartPidFile)
$piRestartListener = Get-NetTCPConnection -LocalPort $Port -State Listen
if (@($piRestartListener | Where-Object OwningProcess -ne $piRestartId).Count -gt 0) { throw 'Port owner does not match server.pid.' }
$piRestartProcess = Get-Process -Id $piRestartId
if ($piRestartProcess.ProcessName -ne 'node') { throw 'The process is not Node.js.' }
$piRestartCommand = Get-CimInstance Win32_Process -Filter "ProcessId=$piRestartId"
if ($piRestartCommand.CommandLine -notlike "*$piRestartEntry*") { throw 'The process does not run this project. Restart it in its original terminal.' }
$piRestartOrigin = "http://127.0.0.1:$Port"
$piRestartCredentials = Get-Credential -UserName 'admin' -Message 'Enter the Pi administrator account to check for active tasks.'
if (-not $piRestartCredentials) { throw 'Restart cancelled.' }
$piRestartSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
    $piRestartBody = @{ username = $piRestartCredentials.UserName; password = $piRestartCredentials.GetNetworkCredential().Password } | ConvertTo-Json
    $piRestartAuth = Invoke-RestMethod -Uri "$piRestartOrigin/api/auth/login" -Method Post -WebSession $piRestartSession -Headers @{ Origin = $piRestartOrigin } -ContentType 'application/json' -Body $piRestartBody
} finally { $piRestartBody = $null; $piRestartCredentials = $null }
if ($piRestartAuth.user.role -ne 'admin') { throw 'An administrator account is required.' }
$piRestartGroups = Invoke-RestMethod -Uri "$piRestartOrigin/api/sessions?limit=200" -WebSession $piRestartSession
$piRestartRuns = Invoke-RestMethod -Uri "$piRestartOrigin/api/admin/task-runs?limit=100" -WebSession $piRestartSession
if (@($piRestartGroups.sessions | Where-Object running).Count -gt 0 -or @($piRestartRuns.runs | Where-Object { $_.status -in @('running', 'starting', 'cancelling') }).Count -gt 0) { throw 'A task is running. Wait for completion or stop the task before restarting.' }
$piRestartRuntime = $piRestartProcess.Path
$env:PI_WEB_HOST = '0.0.0.0'
$env:PI_WEB_PORT = [string]$Port
Stop-Process -Id $piRestartId
$piRestartNew = Start-Process -FilePath $piRestartRuntime -ArgumentList $piRestartEntry -WorkingDirectory $piRestartRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $piRestartRoot 'server-v014.log') -RedirectStandardError (Join-Path $piRestartRoot 'server-v014.error.log') -PassThru
Set-Content -LiteralPath $piRestartPidFile -Value $piRestartNew.Id -Encoding ascii
$piRestartReady = $false
for ($piRestartAttempt = 0; $piRestartAttempt -lt 40; $piRestartAttempt++) {
    try {
        $piRestartStatus = Invoke-RestMethod -Uri "$piRestartOrigin/api/status" -WebSession $piRestartSession -TimeoutSec 2
        if ($piRestartStatus.version -eq '0.14.0') { $piRestartReady = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 250
}
if (-not $piRestartReady) { throw 'Check server-v014.error.log: the service did not become ready.' }
Write-Host "Pi Web v0.14.0 ready: $piRestartOrigin/"
