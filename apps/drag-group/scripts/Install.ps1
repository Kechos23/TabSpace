param([switch]$Apply,[switch]$Status,[switch]$ReplaceExisting)
$ErrorActionPreference='Stop'
$bundle=[IO.Path]::GetFullPath($PSScriptRoot)
$identity=Get-Content -Raw -LiteralPath (Join-Path $bundle 'identity.json') | ConvertFrom-Json
$ids=if($identity.extensionIds){@($identity.extensionIds)}else{@($identity.extensionId)}
if($ids.Count -lt 1 -or $ids.Count -gt 2 -or @($ids | Where-Object {$_ -notmatch '^[a-p]{32}$'}).Count -or @($ids | Select-Object -Unique).Count -ne $ids.Count){throw 'Invalid packaged extension identities'}
$hostPath=Join-Path $bundle 'native\DragGroup.Native.exe'
$manifestPath=Join-Path $bundle 'native\com.tabspace.draggroup.json'
$backupPath=Join-Path $bundle 'registration-backup.json'
if(-not(Test-Path -LiteralPath $hostPath -PathType Leaf)){throw 'The native helper is missing. Extract the entire ZIP first.'}
$keyPath='Software\Google\Chrome\NativeMessagingHosts\com.tabspace.draggroup'
$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
try{
 $existing=$base.OpenSubKey($keyPath)
 $old=if($existing){$existing.GetValue('')}else{$null}
 if($existing){$existing.Dispose()}
 if($Status){[pscustomobject]@{RegisteredManifest=$old;ExpectedManifest=$manifestPath;ExtensionIds=$ids};exit}
 if($old -and $old -ne $manifestPath -and -not $ReplaceExisting){throw 'Another Drag Group installation is registered. Use -ReplaceExisting explicitly to back up and replace its registration, or uninstall it first; nothing changed.'}
 $manifest=[ordered]@{name='com.tabspace.draggroup';description='Drag Group Windows helper';path=$hostPath;type='stdio';allowed_origins=@($ids | ForEach-Object {"chrome-extension://$_/"})}
 if(-not $Apply){$manifest|ConvertTo-Json -Depth 4;Write-Output "Dry run only. Apply registers one HKCU Registry32 entry: $keyPath";exit}
 if(-not(Test-Path -LiteralPath $backupPath)){
  [ordered]@{schemaVersion=1;manifestPath=$manifestPath;previousRegistration=$old;previousManifest=if(Test-Path -LiteralPath $manifestPath){Get-Content -Raw -LiteralPath $manifestPath}else{$null}}|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $backupPath -Encoding utf8
 }
 $manifest|ConvertTo-Json -Depth 4|Set-Content -LiteralPath $manifestPath -Encoding utf8
 $key=$base.CreateSubKey($keyPath)
 try{$key.SetValue('',$manifestPath,[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}
 Write-Output 'Registered this user only. Enable Drag Group in TabSpace Settings or load the standalone extension from this bundle, if included. Use one edition at a time.'
 Write-Output 'No Windows startup task, service or administrator registration was created. Normal Chrome windows start automatically once enabled. Pause from TabSpace Settings or the standalone popup.'
}finally{$base.Dispose()}
