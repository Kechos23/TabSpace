param()
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputExe=[IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts\drag-group\native\DragGroup.Native.exe'))
if(@(Get-Process -Name 'DragGroup.Native' -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq $outputExe}).Count){throw 'Pause Drag Group everywhere from its popup before rebuilding; active controllers reconnect automatically and keep the native files in use.'}
$env:DOTNET_CLI_HOME=Join-Path $projectRoot '.cache\dotnet-home'
$env:NUGET_PACKAGES=Join-Path $projectRoot '.cache\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE='false'
$sdk=Join-Path $projectRoot '.cache\dotnet\dotnet.exe'
& $sdk publish (Join-Path $projectRoot 'apps\drag-group\native\DragGroup.Native.csproj') -c Release -r win-x64 --self-contained false -o (Join-Path $projectRoot 'artifacts\drag-group\native')
if($LASTEXITCODE -ne 0){throw 'Drag Group native build failed'}
