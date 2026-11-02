$ErrorActionPreference='Stop'
$piAndroidTools=Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.tools\android'
foreach($piAndroidPackage in @(@{Zip='jdk-zulu.zip';Folder='jdk'},@{Zip='build-tools.zip';Folder='build-tools'},@{Zip='platform.zip';Folder='platform'})){
    $piAndroidOutput=Join-Path $piAndroidTools $piAndroidPackage.Folder
    New-Item -ItemType Directory -Path $piAndroidOutput -Force | Out-Null
    & tar.exe -xf (Join-Path $piAndroidTools $piAndroidPackage.Zip) -C $piAndroidOutput
    if($LASTEXITCODE -ne 0){throw "Failed extracting $($piAndroidPackage.Zip)"}
}
Write-Output 'Project-local JDK and Android build tools extracted.'
