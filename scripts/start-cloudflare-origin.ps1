[CmdletBinding()]
param(
    [string]$PublicUrl = 'https://ai.junweirpa.asia',
    [string]$BindAddress = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$Port = 3210,
    [switch]$Foreground
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$piPublicUri = $null
if (-not [Uri]::TryCreate($PublicUrl, [UriKind]::Absolute, [ref]$piPublicUri) -or
    $piPublicUri.Scheme -ne 'https' -or $piPublicUri.UserInfo -or
    $piPublicUri.AbsolutePath -ne '/' -or $piPublicUri.Query -or $piPublicUri.Fragment) {
    throw 'PublicUrl must be a complete HTTPS origin without credentials, a path, a query, or a fragment.'
}
if ($BindAddress -notin @('127.0.0.1', '0.0.0.0')) {
    throw 'BindAddress must be 127.0.0.1 or 0.0.0.0.'
}

$piPublicRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$piPublicEntry = [IO.Path]::GetFullPath((Join-Path $piPublicRoot 'server.mjs'))
$piPublicStart = Join-Path $piPublicRoot 'start.ps1'
$piPublicOrigin = $piPublicUri.GetLeftPart([UriPartial]::Authority)
$piPublicLocal = "http://127.0.0.1:$Port"

function Assert-PiPublicOrigin {
    Add-Type -AssemblyName System.Net.Http
    $piOriginHandler = [Net.Http.HttpClientHandler]::new()
    $piOriginHandler.AllowAutoRedirect = $false
    $piOriginHandler.UseProxy = $false
    $piOriginClient = [Net.Http.HttpClient]::new($piOriginHandler)
    $piOriginClient.Timeout = [TimeSpan]::FromSeconds(8)
    $piOriginRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "$piPublicLocal/api/auth/status")
    $piOriginResponse = $null
    try {
        $piOriginRequest.Headers.Host = $piPublicUri.Authority
        $null = $piOriginRequest.Headers.TryAddWithoutValidation('Origin', $piPublicOrigin)
        $piOriginResponse = $piOriginClient.SendAsync($piOriginRequest).GetAwaiter().GetResult()
        if ([int]$piOriginResponse.StatusCode -ne 200) {
            throw "Pi Web is listening on port $Port but does not accept $piPublicOrigin (HTTP $([int]$piOriginResponse.StatusCode)). Wait for current jobs to finish, then restart this project's Pi Web with this script. No running process was stopped."
        }
        $piOriginResult = $piOriginResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        if ($piOriginResult.PSObject.Properties.Name -notcontains 'setupRequired' -or
            $piOriginResult.PSObject.Properties.Name -notcontains 'authenticated' -or
            $piOriginResult.PSObject.Properties.Name -notcontains 'workspace') {
            throw 'The origin response is not a Pi Web authentication status response.'
        }
        if ($piOriginResult.setupRequired) {
            throw 'Pi Web requires its initial administrator. Complete initialization at localhost before exposing the tunnel.'
        }
    }
    finally {
        if ($null -ne $piOriginResponse) { $piOriginResponse.Dispose() }
        $piOriginRequest.Dispose()
        $piOriginClient.Dispose()
    }
}

$piPublicListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($piPublicListeners.Count -gt 0) {
    foreach ($piPublicListener in $piPublicListeners) {
        $piPublicProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($piPublicListener.OwningProcess)"
        $piPublicCommand = [string]$piPublicProcess.CommandLine
        if ($piPublicProcess.Name -ne 'node.exe' -or
            $piPublicCommand.Replace('\', '/').IndexOf($piPublicEntry.Replace('\', '/'), [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            throw "Port $Port belongs to another application. It was left running."
        }
    }
    Assert-PiPublicOrigin
    Write-Host "Pi Web is already ready for $piPublicOrigin/"
    Write-Host 'The existing process was left running.'
    return
}

# These explicit arguments are applied on every launch; no global environment or
# credential file is required. Point the persistent launcher at this script.
$env:PI_WEB_PUBLIC_URL = $piPublicOrigin
$env:PI_WEB_HOST = $BindAddress
$env:PI_WEB_PORT = [string]$Port

if ($Foreground) {
    & $piPublicStart -BindAddress $BindAddress -Port $Port -PublicUrl $piPublicOrigin
    exit $LASTEXITCODE
}

& $piPublicStart -BindAddress $BindAddress -Port $Port -PublicUrl $piPublicOrigin -Background
Assert-PiPublicOrigin
Write-Host "Pi Web origin is ready for $piPublicOrigin/"
Write-Host "Configure the tunnel origin as $piPublicLocal and preserve the public Host header."
