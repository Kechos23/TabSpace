param([switch]$SelfContained)
$ErrorActionPreference='Stop'
$repoPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputPath=[IO.Path]::GetFullPath((Join-Path $repoPath 'artifacts\native-win-x64'))
if(-not $outputPath.StartsWith($repoPath+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Native output outside repository'}
$dotnetPath=Join-Path $repoPath '.cache\dotnet\dotnet.exe'
if(-not (Test-Path -LiteralPath $dotnetPath)){$dotnetPath='dotnet'}
$env:DOTNET_CLI_HOME=Join-Path $repoPath '.cache\dotnet-home'
$env:NUGET_PACKAGES=Join-Path $repoPath '.cache\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
& $dotnetPath run --project (Join-Path $repoPath 'apps\native-helper\tests\TabSpace.Native.Tests.csproj') -c Release
if($LASTEXITCODE -ne 0){throw 'Native tests failed'}
& $dotnetPath publish (Join-Path $repoPath 'apps\native-helper\src\TabSpace.Native\TabSpace.Native.csproj') -c Release -r win-x64 --self-contained $SelfContained.IsPresent.ToString().ToLowerInvariant() -o $outputPath
if($LASTEXITCODE -ne 0){throw 'Native build failed'}
Get-FileHash -LiteralPath (Join-Path $outputPath 'TabSpace.Native.exe') -Algorithm SHA256
