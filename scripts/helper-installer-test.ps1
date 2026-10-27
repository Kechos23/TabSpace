param([string]$NodeExecutable='node')
$ErrorActionPreference='Stop'
$projectPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testId='installer-'+[guid]::NewGuid().ToString('N')
$fixture=Join-Path $projectPath "artifacts\helper-installer\acceptance-$testId"
$installDirectory=Join-Path $fixture 'installed χώρος'
if(-not [IO.Path]::GetFullPath($fixture).StartsWith((Join-Path $projectPath 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Fixture outside workspace'}
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$registry=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
$registry64=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry64)
$hostKey="Software\TabSpace\InstallerTests\$testId\NativeHost"
$realKey='Software\Google\Chrome\NativeMessagingHosts\com.tabspace.draggroup'
function Read-Value([string]$keyPath){$key=$registry.OpenSubKey($keyPath);try{if($key){$key.GetValue('',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}finally{if($key){$key.Dispose()}}}
function Write-Value([string]$value){$key=$registry.CreateSubKey($hostKey);try{$key.SetValue('',$value,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}}
function Assert-True([bool]$value,[string]$message){if(-not $value){throw $message}}
$originalReal=Read-Value $realKey
$real64=$registry64.OpenSubKey($realKey)
try{$originalReal64=if($real64){$real64.GetValue('')}}finally{if($real64){$real64.Dispose()}}
$results=[Collections.Generic.List[string]]::new()
$counter=0
$helperProcess=$null
$setup=Join-Path $projectPath "artifacts\helper-installer\tests\DragGroup-Helper-Setup-TEST-$testId.exe"
$expectedManifest=Join-Path $installDirectory 'native\com.tabspace.draggroup.json'
$statePath=Join-Path $installDirectory 'registration.ini'
function Run-Installer([string[]]$extra=@()){
    $script:counter++
    $arguments=@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-',('/DIR="'+$installDirectory+'"'),('/LOG="'+(Join-Path $fixture "setup-$script:counter.log")+'"'))+$extra
    $process=Start-Process -FilePath $setup -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
    $process.ExitCode
}
function Run-Uninstaller {
    $script:counter++
    $uninstaller=Join-Path $installDirectory 'unins000.exe'
    Assert-True (Test-Path -LiteralPath $uninstaller) 'Expected managed uninstaller'
    $process=Start-Process -FilePath $uninstaller -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="'+(Join-Path $fixture "uninstall-$script:counter.log")+'"')) -WindowStyle Hidden -Wait -PassThru
    $process.ExitCode
}
try {
    Push-Location $projectPath
    try {& $NodeExecutable scripts/build-helper-installer.mjs --test-id $testId *> (Join-Path $fixture 'build.log');if($LASTEXITCODE -ne 0){throw 'Isolated installer build failed'}}finally{Pop-Location}
    Assert-True ((Run-Installer @('/TESTMISSINGRUNTIME=1')) -ne 0) 'Missing runtime must block installation'
    Assert-True ($null -eq (Read-Value $hostKey)) 'Missing runtime changed registration'
    $results.Add('Missing .NET blocks installation without changing registration')

    Assert-True ((Run-Installer) -eq 0) 'Fresh install failed'
    Assert-True ((Read-Value $hostKey) -eq $expectedManifest) 'Fresh registration mismatch'
    $manifest=Get-Content -LiteralPath $expectedManifest -Raw | ConvertFrom-Json
    Assert-True ($manifest.name -eq 'com.tabspace.draggroup' -and $manifest.allowed_origins.Count -eq 2) 'Native manifest origin inventory mismatch'
    Assert-True ($manifest.path -eq (Join-Path $installDirectory 'native\DragGroup.Native.exe')) 'Unicode executable path was corrupted'
    $results.Add('Fresh per-user install writes exact two-origin manifest and Unicode paths')

    $payload=Get-Content -LiteralPath ($setup+'.json') -Raw | ConvertFrom-Json
    [IO.File]::WriteAllText((Join-Path $installDirectory 'native\DragGroup.Core.dll'),'broken fixture')
    $stateBefore=[IO.File]::ReadAllText($statePath)
    Assert-True ((Run-Installer) -eq 0) 'Repair failed'
    foreach($file in $payload.payload){Assert-True ((Get-FileHash -LiteralPath (Join-Path $installDirectory $file.file) -Algorithm SHA256).Hash.ToLowerInvariant() -eq $file.sha256) ("Repair hash mismatch: "+$file.file)}
    Assert-True ([IO.File]::ReadAllText($statePath) -eq $stateBefore) 'Repair changed original rollback information'
    $results.Add('Repair replaces a corrupted payload and preserves original rollback state')

    $previousNativeDirectory=$env:DRAG_GROUP_NATIVE_DIR
    $env:DRAG_GROUP_NATIVE_DIR=Join-Path $installDirectory 'native'
    Push-Location $projectPath
    try {& $NodeExecutable --test tests/drag-group-native.test.mjs *> (Join-Path $fixture 'installed-protocol.log');if($LASTEXITCODE -ne 0){throw 'Installed native protocol checks failed'}}finally{Pop-Location;$env:DRAG_GROUP_NATIVE_DIR=$previousNativeDirectory}
    $results.Add('Installed helper passes all six native protocol checks, including both allowed origins and rejection cases')

    $start=[Diagnostics.ProcessStartInfo]::new((Join-Path $installDirectory 'native\DragGroup.Native.exe'),$manifest.allowed_origins[0])
    $start.UseShellExecute=$false;$start.CreateNoWindow=$true
    $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    $helperProcess=[Diagnostics.Process]::Start($start)
    Start-Sleep -Milliseconds 500
    Assert-True (-not $helperProcess.HasExited) 'Isolated helper did not stay alive for the busy-file test'
    Assert-True ((Run-Installer) -ne 0) 'Repair must refuse an active helper'
    Assert-True ((Run-Uninstaller) -ne 0) 'Uninstall must refuse an active helper'
    Assert-True (Test-Path -LiteralPath $manifest.path) 'Active helper files were removed'
    $helperProcess.StandardInput.Close()
    Assert-True ($helperProcess.WaitForExit(10000)) 'Isolated helper failed to stop after stdin close'
    $helperProcess.Dispose();$helperProcess=$null
    $results.Add('Repair and uninstall refuse a running helper without terminating it')

    $savedState=[IO.File]::ReadAllBytes($statePath)
    Remove-Item -LiteralPath $statePath
    Assert-True ((Run-Uninstaller) -ne 0) 'Uninstall must refuse a missing ownership record'
    Assert-True (Test-Path -LiteralPath $manifest.path) 'Ownership failure removed files'
    [IO.File]::WriteAllBytes($statePath,$savedState)
    $results.Add('Missing ownership state blocks uninstall before file removal')

    $unknown=Join-Path $installDirectory 'user-owned.txt'
    [IO.File]::WriteAllText($unknown,'preserve this unrelated file')
    Assert-True ((Run-Uninstaller) -eq 0) 'Clean uninstall failed'
    Assert-True ($null -eq (Read-Value $hostKey)) 'Owned registration remained after uninstall'
    Assert-True (Test-Path -LiteralPath $unknown) 'Uninstall deleted an unrelated user file'
    $results.Add('Clean uninstall removes only its registration and files, preserving unknown files')

    $legacy=Join-Path $fixture 'legacy-manifest.json'
    [IO.File]::WriteAllText($legacy,'{}')
    Write-Value $legacy
    Assert-True ((Run-Installer) -ne 0) 'Portable replacement must require explicit confirmation'
    Assert-True ((Read-Value $hostKey) -eq $legacy) 'Unconfirmed replacement changed registration'
    Assert-True ((Run-Installer @('/REPLACEEXISTING=1')) -eq 0) 'Confirmed migration failed'
    Assert-True ((Run-Installer) -eq 0) 'Migration repair failed'
    Assert-True ((Run-Uninstaller) -eq 0) 'Migration uninstall failed'
    Assert-True ((Read-Value $hostKey) -eq $legacy) 'Original portable registration was not restored'
    Assert-True (Test-Path -LiteralPath $legacy) 'Legacy manifest was modified or deleted'
    $results.Add('Portable migration requires confirmation; repair retains backup; uninstall restores it')

    Assert-True ((Run-Installer @('/REPLACEEXISTING=1')) -eq 0) 'Foreign takeover setup failed'
    $foreign=Join-Path $fixture 'foreign-manifest.json'
    [IO.File]::WriteAllText($foreign,'{}')
    Write-Value $foreign
    Assert-True ((Run-Uninstaller) -eq 0) 'Uninstall after foreign takeover failed'
    Assert-True ((Read-Value $hostKey) -eq $foreign) 'Uninstall overwrote another installation registration'
    $results.Add('Uninstall preserves a registration taken over by another installation')

    Write-Value $legacy
    Assert-True ((Run-Installer @('/REPLACEEXISTING=1','/TESTFAILAFTERREGISTER=1')) -ne 0) 'Injected failure unexpectedly succeeded'
    Assert-True ((Read-Value $hostKey) -eq $legacy) 'Failed installation did not restore previous registration'
    Assert-True (-not(Test-Path -LiteralPath $manifest.path)) 'Failed fresh install left an active native payload'
    $results.Add('Failure after registry write rolls registration back to its prior value')

    Assert-True ((Run-Installer @('/REPLACEEXISTING=1')) -eq 0) 'Failure repair setup failed'
    $savedState=[IO.File]::ReadAllBytes($statePath)
    Assert-True ((Run-Installer @('/TESTFAILAFTERREGISTER=1')) -ne 0) 'Injected repair failure unexpectedly succeeded'
    Assert-True ((Read-Value $hostKey) -eq $expectedManifest) 'Failed repair lost managed registration'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($statePath)) -eq [Convert]::ToBase64String($savedState)) 'Failed repair changed backup bytes'
    foreach($file in $payload.payload){Assert-True ((Get-FileHash -LiteralPath (Join-Path $installDirectory $file.file) -Algorithm SHA256).Hash.ToLowerInvariant() -eq $file.sha256) ("Failed repair did not restore bytes: "+$file.file)}
    $results.Add('Failed repair restores installed payload bytes, managed registration and rollback state')

    Remove-Item -LiteralPath $legacy
    Assert-True ((Run-Uninstaller) -eq 0) 'Uninstall with missing previous manifest failed'
    Assert-True ($null -eq (Read-Value $hostKey)) 'Uninstall restored a dangling previous manifest'
    $results.Add('Missing previous manifest removes owned registration instead of restoring a dangling path')
    Assert-True ((Read-Value $realKey) -eq $originalReal) 'Personal Chrome helper registration changed'
    $results.Add('Personal Chrome registration remains unchanged throughout isolated acceptance')
    $report=[ordered]@{date=[DateTime]::UtcNow.ToString('o');installerVersion='1.0.0';helperVersion='0.1.21';testId=$testId;passed=$true;scope='Real installer/uninstaller executable with compile-time sandbox registry key and workspace files; no real Chrome registration';checks=$results;manualLimits=@('Clean-machine/VM and other Windows versions','SmartScreen and signing acceptance','Future version-to-version payload upgrade')}
    $report|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $fixture 'acceptance.json') -Encoding utf8
    $report|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $projectPath 'docs\VALIDATION_HELPER_INSTALLER.json') -Encoding utf8
    $results|ForEach-Object {Write-Output "PASS $_"}
} finally {
    if($helperProcess){$helperProcess.StandardInput.Close();$helperProcess.WaitForExit(10000)|Out-Null;$helperProcess.Dispose()}
    try {if(Test-Path -LiteralPath (Join-Path $installDirectory 'unins000.exe')){Run-Uninstaller|Out-Null}}catch{Write-Warning 'Isolated fixture retained for diagnosis; personal registration was not used.'}
    $registry.DeleteSubKeyTree("Software\TabSpace\InstallerTests\$testId",$false)
    $uninstallRoot=$registry64.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall',$true)
    if($uninstallRoot){try{foreach($keyName in $uninstallRoot.GetSubKeyNames()){
        if(-not $keyName.StartsWith('TabSpace.HelperInstallerTest.')){continue}
        $entry=$uninstallRoot.OpenSubKey($keyName)
        try{$owned=$entry.GetValue('DisplayName') -eq "Drag Group Helper TEST $testId" -and $entry.GetValue('InstallLocation').TrimEnd('\') -eq $installDirectory.TrimEnd('\')}finally{$entry.Dispose()}
        if($owned){$uninstallRoot.DeleteSubKeyTree($keyName,$false)}
    }}finally{$uninstallRoot.Dispose()}}
    $unchanged=(Read-Value $realKey) -eq $originalReal
    $real64=$registry64.OpenSubKey($realKey)
    try{$unchanged=$unchanged -and $(if($real64){$real64.GetValue('')}else{$null}) -eq $originalReal64}finally{if($real64){$real64.Dispose()}}
    $registry.Dispose();$registry64.Dispose()
    if(-not $unchanged){throw 'Personal registration changed unexpectedly'}
}
