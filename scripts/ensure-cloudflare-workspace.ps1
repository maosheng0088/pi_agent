[CmdletBinding()]
param(
    [string]$PublicUrl = 'https://ai.junweirpa.asia',
    [ValidateSet('127.0.0.1', '0.0.0.0')]
    [string]$BindAddress = '0.0.0.0',
    [ValidateSet('auto', 'http2', 'quic')]
    [string]$Protocol = 'auto',
    [string]$TokenFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$cfKeeperRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cfKeeperHash = [Security.Cryptography.SHA256]::Create()
try {
    $cfKeeperDigest = [BitConverter]::ToString($cfKeeperHash.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($cfKeeperRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
}
finally { $cfKeeperHash.Dispose() }

# Task Scheduler also uses IgnoreNew. This mutex additionally protects manual
# launches and repeated logon triggers in this user's interactive session.
$cfKeeperMutex = [Threading.Mutex]::new($false, "Local\PiWebCloudflare-$cfKeeperDigest")
$cfKeeperAcquired = $false
try {
    try { $cfKeeperAcquired = $cfKeeperMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $cfKeeperAcquired = $true }
    if (-not $cfKeeperAcquired) { exit 0 }

    $cfKeeperArguments = @{ PublicUrl = $PublicUrl; BindAddress = $BindAddress; Protocol = $Protocol }
    if ($TokenFile) { $cfKeeperArguments.TokenFile = $TokenFile }
    # These launchers validate ownership and health. They never stop a running
    # Pi instance or a connector, so a periodic check cannot interrupt a task.
    & (Join-Path $PSScriptRoot 'start-cloudflare-tunnel.ps1') @cfKeeperArguments *> $null
    exit 0
}
catch {
    # Routine successful checks stay quiet. Record failures locally without
    # dumping arguments, process command lines, credentials, or script output.
    try {
        $cfKeeperLogDirectory = Join-Path $cfKeeperRoot '.data\logs'
        New-Item -ItemType Directory -Path $cfKeeperLogDirectory -Force | Out-Null
        $cfKeeperLog = Join-Path $cfKeeperLogDirectory 'cloudflare-keepalive.error.log'
        if ((Test-Path -LiteralPath $cfKeeperLog) -and (Get-Item -LiteralPath $cfKeeperLog).Length -gt 1048576) {
            Copy-Item -LiteralPath $cfKeeperLog -Destination "$cfKeeperLog.previous" -Force
            [IO.File]::WriteAllText($cfKeeperLog, '')
        }
        $cfKeeperMessage = ([string]$_.Exception.Message) -replace '[\r\n]+', ' '
        Add-Content -LiteralPath $cfKeeperLog -Value ("{0} {1}" -f [DateTimeOffset]::Now.ToString('o'), $cfKeeperMessage) -Encoding UTF8
    }
    catch { }
    exit 1
}
finally {
    if ($cfKeeperAcquired) { $cfKeeperMutex.ReleaseMutex() }
    $cfKeeperMutex.Dispose()
}
