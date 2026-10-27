$ErrorActionPreference='Stop'
$repoPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot=[IO.Path]::GetFullPath((Join-Path $repoPath 'artifacts'))
$profiles=@(Get-ChildItem -LiteralPath $artifactRoot -Directory -Filter 'drag-group-test-profile-*' | Where-Object {$_.FullName.StartsWith($artifactRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)})
$processes=Get-CimInstance Win32_Process
$testBrowsers=@($processes | Where-Object {$_.Name -eq 'chrome.exe' -and $_.CommandLine -and ($_.CommandLine.Contains('--user-data-dir='))} | Where-Object {$line=$_.CommandLine;@($profiles | Where-Object {$line.Contains('--user-data-dir='+$_.FullName) -or $line.Contains('--user-data-dir="'+$_.FullName+'"')}).Count -gt 0})
$testNodes=@($processes | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Contains('scripts/try-drag-group.mjs')})
foreach($process in @($testBrowsers)+@($testNodes)){Stop-Process -Id $process.ProcessId -ErrorAction SilentlyContinue}
Write-Output "Stopped $($testBrowsers.Count) disposable-profile Chrome processes and $($testNodes.Count) Drag Group test runners. No ordinary profiles or files were removed."
