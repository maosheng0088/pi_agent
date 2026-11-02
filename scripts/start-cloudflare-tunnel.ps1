[CmdletBinding()]
param(
    [string]$PublicUrl = 'https://ai.junweirpa.asia',
    [string]$TokenFile,
    [string]$BindAddress = '0.0.0.0',
    [ValidateSet('auto', 'http2', 'quic')]
    [string]$Protocol = 'auto'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$cfProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cfExecutable = Join-Path $cfProjectRoot 'tools\cloudflared\cloudflared.exe'
$cfRuntime = Join-Path $cfProjectRoot '.data\cloudflare'
if (-not $TokenFile) { $TokenFile = Join-Path $cfRuntime 'tunnel-token.txt' }
$cfTokenPath = [IO.Path]::GetFullPath($TokenFile)
if (-not (Test-Path -LiteralPath $cfExecutable -PathType Leaf)) { throw 'cloudflared is not installed in tools/cloudflared.' }
if (-not (Test-Path -LiteralPath $cfTokenPath -PathType Leaf)) { throw 'The Cloudflare tunnel token has not been configured. Complete Cloudflare sign-in and tunnel setup first.' }
if ((Get-Item -LiteralPath $cfTokenPath).Length -eq 0) { throw 'The Cloudflare tunnel token file is empty.' }

# Validate the existing Pi instance without stopping it or accepting a different
# process on the same port. New instances inherit the fixed HTTPS public origin.
& (Join-Path $PSScriptRoot 'start-cloudflare-origin.ps1') -PublicUrl $PublicUrl -BindAddress $BindAddress

New-Item -ItemType Directory -Path $cfRuntime -Force | Out-Null
$cfPidPath = Join-Path $cfRuntime 'cloudflared.pid'
if (Test-Path -LiteralPath $cfPidPath) {
    $cfPreviousId = 0
    $cfPreviousText = [IO.File]::ReadAllText($cfPidPath).Trim()
    if ([int]::TryParse($cfPreviousText, [ref]$cfPreviousId)) {
        $cfPreviousProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$cfPreviousId" -ErrorAction SilentlyContinue
        if ($cfPreviousProcess) {
            $cfPreviousCommand = ([string]$cfPreviousProcess.CommandLine).Replace('\', '/')
            if ($cfPreviousProcess.Name -ne 'cloudflared.exe' -or
                $cfPreviousCommand.IndexOf($cfTokenPath.Replace('\', '/'), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
                throw 'The saved tunnel PID belongs to another process; it was left running.'
            }
            Write-Host "The Pi Cloudflare connector is already running (PID $cfPreviousId)."
            return
        }
    }
}

$cfLogRoot = Join-Path $cfProjectRoot '.data\logs'
New-Item -ItemType Directory -Path $cfLogRoot -Force | Out-Null
$cfStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$cfOutput = Join-Path $cfLogRoot "cloudflare-$cfStamp.log"
$cfError = Join-Path $cfLogRoot "cloudflare-$cfStamp.error.log"
# Only the token's file path appears in the command line, never the token itself.
$cfArguments = @('tunnel', '--no-autoupdate', '--loglevel', 'info', 'run', '--protocol', $Protocol, '--token-file', ('"' + $cfTokenPath + '"'))
$cfStarted = Start-Process -FilePath $cfExecutable -ArgumentList $cfArguments -WorkingDirectory $cfProjectRoot -WindowStyle Hidden -RedirectStandardOutput $cfOutput -RedirectStandardError $cfError -PassThru
[IO.File]::WriteAllText($cfPidPath, [string]$cfStarted.Id, [Text.Encoding]::ASCII)
Start-Sleep -Milliseconds 800
$cfStarted.Refresh()
if ($cfStarted.HasExited) { throw "The tunnel exited during startup. See $cfError" }
Write-Host "Cloudflare connector started (PID $($cfStarted.Id))."
Write-Host "Public address: $PublicUrl/"
Write-Host 'Confirm tunnel health and public login before reporting external access as ready.'
Write-Host "Connector log: $cfError"
