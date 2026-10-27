param([string]$OutputPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$report=@()
foreach($proc in (Get-Process chrome -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0)){
 try{
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::TabItem)
  $tabs=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,$condition)
  $bounds=@($tabs | Where-Object {-not $_.Current.IsOffscreen} | ForEach-Object { $b=$_.Current.BoundingRectangle;[pscustomobject]@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height} })
  $report += [pscustomobject]@{tabItems=$tabs.Count;visible=$bounds.Count;bounds=$bounds}
 }catch{$report += [pscustomobject]@{error='UIA unavailable; no identities inferred'}}
}
$json=[ordered]@{capturedAt=[DateTime]::UtcNow.ToString('o');windowsVersion=[Environment]::OSVersion.Version.ToString();windows=$report;gestureAcceptance='Pending'} | ConvertTo-Json -Depth 6
if($OutputPath){$json | Set-Content -LiteralPath ([IO.Path]::GetFullPath($OutputPath)) -Encoding utf8}else{$json}
