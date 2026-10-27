param([switch]$Download)
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = '7.1.0'
$toolDirectory = Join-Path $projectPath ".cache\inno-$version"
$url = 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe'
$expectedHash = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'
if (-not $Download) {
    [pscustomobject]@{Version=$version; Url=$url; Target=$toolDirectory; SHA256=$expectedHash}
    exit
}
New-Item -ItemType Directory -Force -Path $toolDirectory | Out-Null
$downloadPath = Join-Path $toolDirectory "innosetup-$version-x64.exe"
Invoke-WebRequest -Uri $url -OutFile $downloadPath
if ((Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Official Inno Setup download checksum mismatch'
}
$signature = Get-AuthenticodeSignature -LiteralPath $downloadPath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Pyrsys B.V.') {
    throw 'Inno Setup Authenticode publisher validation failed'
}
$compilerDirectory = Join-Path $toolDirectory 'compiler'
$process = Start-Process -FilePath $downloadPath -ArgumentList @('/PORTABLE=1', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/NOICONS', ('/DIR="'+$compilerDirectory+'"')) -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Portable compiler extraction failed: $($process.ExitCode)" }
if (-not (Test-Path -LiteralPath (Join-Path $compilerDirectory 'ISCC.exe'))) { throw 'Compiler missing after extraction' }
Write-Output "Portable Inno Setup $version ready in $compilerDirectory"
