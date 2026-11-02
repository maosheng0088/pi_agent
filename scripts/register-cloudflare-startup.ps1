[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidatePattern('^[^\\/\r\n]{1,180}$')]
    [string]$TaskName = 'PiWeb-Cloudflare-Workspace',
    [string]$PublicUrl = 'https://ai.junweirpa.asia',
    [ValidateSet('127.0.0.1', '0.0.0.0')]
    [string]$BindAddress = '0.0.0.0',
    [ValidateSet('auto', 'http2', 'quic')]
    [string]$Protocol = 'auto',
    [string]$TokenFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$cfStartupRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cfStartupEntry = Join-Path $PSScriptRoot 'ensure-cloudflare-workspace.ps1'
$cfStartupShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$cfStartupIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($cfStartupIdentity.IsSystem -or -not $cfStartupIdentity.User) {
    throw 'Register this task as the Windows user who runs Pi Web, not SYSTEM.'
}
foreach ($cfStartupPath in @($cfStartupEntry, $cfStartupShell)) {
    if (-not (Test-Path -LiteralPath $cfStartupPath -PathType Leaf)) { throw "Required launcher is missing: $cfStartupPath" }
}
$cfStartupUri = $null
if (-not [Uri]::TryCreate($PublicUrl, [UriKind]::Absolute, [ref]$cfStartupUri) -or
    $cfStartupUri.Scheme -ne 'https' -or $cfStartupUri.UserInfo -or
    $cfStartupUri.AbsolutePath -ne '/' -or $cfStartupUri.Query -or $cfStartupUri.Fragment) {
    throw 'PublicUrl must be a complete HTTPS origin without credentials, a path, a query, or a fragment.'
}
$cfStartupOrigin = $cfStartupUri.GetLeftPart([UriPartial]::Authority)

function Quote-CfStartupArgument([string]$Value) {
    if ($Value -match '["\r\n]') { throw 'Task arguments cannot contain double quotes or newlines.' }
    return '"' + $Value + '"'
}

$cfStartupHash = [Security.Cryptography.SHA256]::Create()
try {
    $cfStartupDigest = [BitConverter]::ToString($cfStartupHash.ComputeHash(
        [Text.Encoding]::UTF8.GetBytes($cfStartupRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
}
finally { $cfStartupHash.Dispose() }
$cfStartupBinding = "PiWebCloudflareProject=$cfStartupDigest"
$cfStartupArguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' +
    (Quote-CfStartupArgument $cfStartupEntry) + ' -PublicUrl ' +
    (Quote-CfStartupArgument $cfStartupOrigin) + ' -BindAddress ' + $BindAddress + ' -Protocol ' + $Protocol
if ($TokenFile) {
    $cfStartupTokenPath = [IO.Path]::GetFullPath($TokenFile)
    if (-not (Test-Path -LiteralPath $cfStartupTokenPath -PathType Leaf)) { throw 'The tunnel token file does not exist.' }
    # Only a file path is stored in Task Scheduler, never the token content.
    $cfStartupArguments += ' -TokenFile ' + (Quote-CfStartupArgument $cfStartupTokenPath)
}

$cfStartupExisting = @(Get-ScheduledTask -TaskPath '\' -ErrorAction Stop | Where-Object TaskName -eq $TaskName)
if ($cfStartupExisting.Count -gt 1) { throw 'Multiple matching scheduled tasks were found; no task was changed.' }
if ($cfStartupExisting.Count -eq 1) {
    $cfStartupPrevious = $cfStartupExisting[0]
    $cfStartupActions = @($cfStartupPrevious.Actions)
    $cfStartupPreviousUser = [string]$cfStartupPrevious.Principal.UserId
    if ($cfStartupPreviousUser -notmatch '^S-1-') {
        try {
            $cfStartupPreviousUser = ([Security.Principal.NTAccount]::new($cfStartupPreviousUser)).Translate(
                [Security.Principal.SecurityIdentifier]).Value
        }
        catch { throw 'The existing task owner could not be verified. No task was changed.' }
    }
    # Require our ownership marker AND exact launcher binding. A matching display
    # name alone never authorizes replacing another application's scheduled task.
    if ($cfStartupPrevious.Description -notlike "*$cfStartupBinding*" -or
        $cfStartupPreviousUser -ne $cfStartupIdentity.User.Value -or
        $cfStartupActions.Count -ne 1 -or
        -not [string]::Equals([string]$cfStartupActions[0].Execute, $cfStartupShell, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$cfStartupActions[0].WorkingDirectory, $cfStartupRoot, [StringComparison]::OrdinalIgnoreCase) -or
        ([string]$cfStartupActions[0].Arguments).IndexOf('-File ' + (Quote-CfStartupArgument $cfStartupEntry), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'The task name is already used by an unverified project or account. No task was changed; choose another TaskName.'
    }
}

$cfStartupAction = New-ScheduledTaskAction -Execute $cfStartupShell -Argument $cfStartupArguments -WorkingDirectory $cfStartupRoot
$cfStartupLogon = New-ScheduledTaskTrigger -AtLogOn -User $cfStartupIdentity.User.Value
$cfStartupLogon.Delay = 'PT15S'
# Omitting RepetitionDuration means repeat indefinitely, including future days.
$cfStartupKeepalive = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$cfStartupPrincipal = New-ScheduledTaskPrincipal -UserId $cfStartupIdentity.User.Value -LogonType Interactive -RunLevel Limited
$cfStartupSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -Hidden -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$cfStartupDescription = "Pi Web origin and Cloudflare connector; current-user logon and one-minute idempotent recovery. $cfStartupBinding; Project=$cfStartupRoot"
$cfStartupTask = New-ScheduledTask -Action $cfStartupAction -Trigger @($cfStartupLogon, $cfStartupKeepalive) `
    -Settings $cfStartupSettings -Principal $cfStartupPrincipal -Description $cfStartupDescription

if ($PSCmdlet.ShouldProcess("$TaskName ($($cfStartupIdentity.Name))", 'Register Pi Web and Cloudflare logon/keepalive task')) {
    $null = Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -InputObject $cfStartupTask -Force
    Write-Host "Registered: $TaskName"
    Write-Host "Account: $($cfStartupIdentity.Name) (interactive, limited privileges; no stored password)"
    Write-Host 'Starts 15 seconds after this user logs in; checks every minute while the user is logged in.'
    Write-Host 'This script does not stop or restart any running process.'
}
