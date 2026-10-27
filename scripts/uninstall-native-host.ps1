param([string]$HelperDirectory=$(if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'TabSpace.Native.exe')){$PSScriptRoot}else{Join-Path $PSScriptRoot '..\artifacts\native-win-x64'}),[switch]$Apply)
$ErrorActionPreference='Stop'
$helperPath=[IO.Path]::GetFullPath($HelperDirectory)
$manifestPath=Join-Path $helperPath 'com.tabspace.native.json'
$statePath=Join-Path $helperPath 'registration-backup.json'
if(-not (Test-Path -LiteralPath $statePath -PathType Leaf)){
 $probeBase=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
 try{
  $probeKey=$probeBase.OpenSubKey('Software\Google\Chrome\NativeMessagingHosts\com.tabspace.native')
  if(-not $probeKey){Write-Output 'TabSpace native host is not registered; no changes needed.';exit}
  $probeKey.Dispose()
 }finally{$probeBase.Dispose()}
 throw 'No owned registration backup; existing registration left untouched'
}
$state=Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if($state.schemaVersion -ne 1 -or $state.manifestPath -ne $manifestPath){throw 'Registration backup target mismatch'}
$registryPath='Software\Google\Chrome\NativeMessagingHosts\com.tabspace.native'
$baseKey=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
try{
 $key=$baseKey.OpenSubKey($registryPath)
 $current=if($key){$key.GetValue('')}else{$null}
 if($key){$key.Dispose()}
 if($current -ne $manifestPath){throw 'Registration changed externally; no removal performed'}
 if(-not $Apply){Write-Output 'Dry run: restore previous owned registration, leave helper files and external backups intact.';exit}
 if($state.previousRegistration){$key=$baseKey.CreateSubKey($registryPath);try{$key.SetValue('',$state.previousRegistration)}finally{$key.Dispose()}}
 else{$baseKey.DeleteSubKey($registryPath,$false)}
 if($state.previousManifest){$state.previousManifest | Set-Content -LiteralPath $manifestPath -Encoding utf8}
 Write-Output 'Registration restored/removed. Disconnect the helper in TabSpace; no helper files or backups were deleted.'
}finally{$baseKey.Dispose()}
