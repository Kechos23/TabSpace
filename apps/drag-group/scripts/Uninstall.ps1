param([switch]$Apply)
$ErrorActionPreference='Stop'
$manifestPath=Join-Path $PSScriptRoot 'native\com.tabspace.draggroup.json'
$backupPath=Join-Path $PSScriptRoot 'registration-backup.json'
$keyPath='Software\Google\Chrome\NativeMessagingHosts\com.tabspace.draggroup'
$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
try{
 $key=$base.OpenSubKey($keyPath)
 $current=if($key){$key.GetValue('')}else{$null}
 if($key){$key.Dispose()}
 if(-not$current){Write-Output 'Drag Group is not registered. No changes needed.';exit}
 if(-not(Test-Path -LiteralPath $backupPath)){throw 'No owned registration backup; nothing changed.'}
 $state=Get-Content -Raw -LiteralPath $backupPath|ConvertFrom-Json
 if($state.schemaVersion -ne 1 -or $state.manifestPath -ne $manifestPath -or $current -ne $manifestPath){throw 'Registration ownership changed; nothing changed.'}
 if(-not $Apply){Write-Output 'Dry run. Disable the controller, then use -Apply to restore/remove this owned HKCU registration.';exit}
 if($state.previousRegistration){$key=$base.CreateSubKey($keyPath);try{$key.SetValue('',$state.previousRegistration)}finally{$key.Dispose()}}
 else{$base.DeleteSubKey($keyPath,$false)}
 if($state.previousManifest){$state.previousManifest|Set-Content -LiteralPath $manifestPath -Encoding utf8}
 Write-Output 'Registration restored/removed. No browser tabs, profiles, files or other native hosts were removed.'
}finally{$base.Dispose()}
