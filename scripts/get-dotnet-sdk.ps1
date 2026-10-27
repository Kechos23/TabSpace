param([switch]$Download)
$ErrorActionPreference='Stop'
$repoPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sdkPath=[IO.Path]::GetFullPath((Join-Path $repoPath '.cache\dotnet'))
if(-not $sdkPath.StartsWith($repoPath+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'SDK target outside repository'}
$metadata=Invoke-RestMethod 'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json'
$release=$metadata.releases | Where-Object { $_.sdk.version -eq $metadata.'latest-sdk' } | Select-Object -First 1
$file=$release.sdk.files | Where-Object { $_.rid -eq 'win-x64' -and $_.name -like '*.zip' } | Select-Object -First 1
if(-not $file -or -not $file.url.StartsWith('https://builds.dotnet.microsoft.com/')){throw 'Unexpected official SDK metadata'}
if(-not $Download){[pscustomobject]@{Version=$release.sdk.version;Url=$file.url;Target=$sdkPath};exit}
New-Item -ItemType Directory -Path $sdkPath -Force | Out-Null
$archive=Join-Path $repoPath '.cache\dotnet-sdk.zip'
Invoke-WebRequest $file.url -OutFile $archive
$hash=(Get-FileHash -LiteralPath $archive -Algorithm SHA512).Hash
if($hash -ne $file.hash){throw 'Official SDK SHA512 verification failed'}
Expand-Archive -LiteralPath $archive -DestinationPath $sdkPath -Force
& (Join-Path $sdkPath 'dotnet.exe') --version
