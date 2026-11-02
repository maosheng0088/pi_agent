#Requires -RunAsAdministrator
param([int]$Port = 3210)
$ErrorActionPreference = 'Stop'
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Port must be between 1 and 65535.' }
$piWebListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -First 1
$piWebProgram = (Get-Process -Id $piWebListener.OwningProcess -ErrorAction Stop).Path
if (-not $piWebProgram -or [IO.Path]::GetFileName($piWebProgram) -ne 'node.exe') { throw 'Start Pi Web before adding its firewall rule.' }
$piWebRuleName = "PiWebSharedWorkspace-$Port"
$piWebRule = Get-NetFirewallRule -Name $piWebRuleName -ErrorAction SilentlyContinue
if ($piWebRule) {
    Set-NetFirewallRule -Name $piWebRuleName -Enabled True -Direction Inbound -Action Allow -Profile Private -Program $piWebProgram | Out-Null
    $piWebRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $Port | Out-Null
    $piWebRule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet | Out-Null
} else {
    New-NetFirewallRule -Name $piWebRuleName -DisplayName "Pi Web shared workspace (TCP $Port)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -Profile Private -RemoteAddress LocalSubnet -Program $piWebProgram | Out-Null
}
Write-Host "Pi Web TCP $Port is allowed on Private networks from the local subnet."
