param([Parameter(Mandatory=$true)][ValidatePattern('^[a-p]{32}$')][string]$ExtensionId,[string]$HelperDirectory=$(if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'TabSpace.Native.exe')){$PSScriptRoot}else{Join-Path $PSScriptRoot '..\artifacts\native-win-x64'}),[switch]$Apply,[switch]$Status)
$ErrorActionPreference='Stop'
$helperPath=[IO.Path]::GetFullPath($HelperDirectory)
$exePath=Join-Path $helperPath 'TabSpace.Native.exe'
$manifestPath=Join-Path $helperPath 'com.tabspace.native.json'
$statePath=Join-Path $helperPath 'registration-backup.json'
if(-not (Test-Path -LiteralPath $exePath -PathType Leaf)){throw 'Build the helper first; executable is missing'}
$registryPath='Software\Google\Chrome\NativeMessagingHosts\com.tabspace.native'
$baseKey=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
try {
 $existing=$baseKey.OpenSubKey($registryPath)
 $oldValue=if($existing){$existing.GetValue('')}else{$null}
 if($existing){$existing.Dispose()}
 if($Status){[pscustomobject]@{RegisteredManifest=$oldValue;ExpectedManifest=$manifestPath;RegistryView='CurrentUser / Registry32';AllowedOrigin="chrome-extension://$ExtensionId/"};exit}
 if($oldValue -and $oldValue -ne $manifestPath){
  if(-not (Test-Path -LiteralPath $oldValue -PathType Leaf)){throw 'Existing host registration cannot be verified; left untouched'}
  $oldManifest=Get-Content -Raw -LiteralPath $oldValue | ConvertFrom-Json
  if($oldManifest.name -ne 'com.tabspace.native' -or $oldManifest.description -notlike 'TabSpace*'){throw 'Existing registration is not verifiably TabSpace-owned; left untouched'}
 }
 $manifest=[ordered]@{name='com.tabspace.native';description='TabSpace optional diagnostic host';path=$exePath;type='stdio';allowed_origins=@("chrome-extension://$ExtensionId/")}
 if(-not $Apply){$manifest | ConvertTo-Json -Depth 4;Write-Output "Dry run. Registry32 HKCU target: $registryPath";exit}
 if(-not (Test-Path -LiteralPath $statePath)){
  [ordered]@{schemaVersion=1;manifestPath=$manifestPath;previousRegistration=$oldValue;previousManifest=if(Test-Path -LiteralPath $manifestPath){Get-Content -Raw -LiteralPath $manifestPath}else{$null}} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding utf8
 }
 $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8
 $ownedKey=$baseKey.CreateSubKey($registryPath)
 try{$ownedKey.SetValue('',$manifestPath,[Microsoft.Win32.RegistryValueKind]::String)}finally{$ownedKey.Dispose()}
 Write-Output "Registered exact origin chrome-extension://$ExtensionId/ in HKCU Registry32. Host remains diagnostic only."
}finally{$baseKey.Dispose()}
