param(
    [string]$BindAddress = $(if ($env:PI_WEB_HOST) { $env:PI_WEB_HOST } else { '0.0.0.0' }),
    [int]$Port = $(if ($env:PI_WEB_PORT) { [int]$env:PI_WEB_PORT } else { 3210 }),
    [string]$PublicUrl = $env:PI_WEB_PUBLIC_URL,
    [switch]$Background
)

$ErrorActionPreference = 'Stop'
$piWebRoot = $PSScriptRoot
$piWebNode = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $piWebNode) {
    $piWebCandidates = @(
        'C:\Users\32062\Documents\ChatGPT\dsh\.tools\node_modules\node-win-x64\bin\node.exe',
        'C:\Users\32062\Documents\ChatGPT\dsh\.tools\node\node.exe',
        'C:\Program Files\nodejs\node.exe'
    )
    $piWebNode = $piWebCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $piWebNode) { throw 'Node.js >= 22.19 is required. Install Node.js or add node.exe to PATH.' }
$piWebVersion = (& $piWebNode -p 'process.versions.node').Trim()
if ([version]$piWebVersion -lt [version]'22.19.0') { throw "Node.js >= 22.19 is required. Current version: $piWebVersion" }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
$env:PI_WEB_HOST = $BindAddress
$env:PI_WEB_PORT = [string]$Port
if ($PublicUrl) { $env:PI_WEB_PUBLIC_URL = $PublicUrl }
if ($Background) {
    $piWebEntry = Join-Path $piWebRoot 'server.mjs'
    $piWebListener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($piWebListener.Count) {
        foreach ($piWebExisting in $piWebListener) {
            $piWebOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$($piWebExisting.OwningProcess)"
            if ($piWebOwner.Name -ne 'node.exe' -or $piWebOwner.CommandLine -notlike "*$piWebEntry*") {
                throw "Port $Port belongs to another application; it was left running."
            }
        }
        Write-Host "Pi Web is already running: http://127.0.0.1:$Port/"
        return
    }
    $piWebLogDirectory = Join-Path $piWebRoot '.data\logs'
    New-Item -ItemType Directory -Path $piWebLogDirectory -Force | Out-Null
    $piWebLogStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $piWebOutput = Join-Path $piWebLogDirectory "server-$piWebLogStamp.log"
    $piWebErrors = Join-Path $piWebLogDirectory "server-$piWebLogStamp.error.log"
    $piWebStarted = Start-Process -FilePath $piWebNode -ArgumentList @($piWebEntry) -WorkingDirectory $piWebRoot -WindowStyle Hidden -RedirectStandardOutput $piWebOutput -RedirectStandardError $piWebErrors -PassThru
    [IO.File]::WriteAllText((Join-Path $piWebRoot 'server.pid'), [string]$piWebStarted.Id, [Text.Encoding]::ASCII)
    for ($piWebAttempt = 0; $piWebAttempt -lt 40; $piWebAttempt++) {
        if ($piWebStarted.HasExited) { throw "Pi Web exited during startup. See $piWebErrors" }
        try {
            $piWebHealth = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/auth/status" -UseBasicParsing -TimeoutSec 2
            if ($piWebHealth.StatusCode -eq 200) {
                Write-Host "Pi Web is running in background (PID $($piWebStarted.Id)): http://127.0.0.1:$Port/"
                Write-Host "Log: $piWebOutput"
                return
            }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    throw "Pi Web did not become ready. See $piWebErrors"
}
Write-Host "Pi Web: http://127.0.0.1:$Port"
Write-Host "Listen: ${BindAddress}:$Port. Press Ctrl+C to stop."
if ($BindAddress -eq '0.0.0.0') {
    Write-Host 'Shared mode: employees can connect through this computer''s LAN IP.'
}
& $piWebNode (Join-Path $piWebRoot 'server.mjs')
exit $LASTEXITCODE
