; GPL-3.0-only. One per-user installation shared by TabSpace and Drag Group.
; Payload.iss is generated from the exact staged files and public extension keys.
#include PayloadDir + "\Payload.iss"
#ifndef InstallerTestId
  #define ProductAppId "TabSpace.DragGroupHelper"
  #define HostKey "Software\Google\Chrome\NativeMessagingHosts\com.tabspace.draggroup"
  #define ProductName "Drag Group Helper"
  #define SetupFileName "DragGroup-Helper-Setup-" + InstallerVersion
#else
  #define ProductAppId "TabSpace.HelperInstallerTest." + InstallerTestId
  #define HostKey "Software\TabSpace\InstallerTests\" + InstallerTestId + "\NativeHost"
  #define ProductName "Drag Group Helper TEST " + InstallerTestId
  #define SetupFileName "DragGroup-Helper-Setup-TEST-" + InstallerTestId
#endif

[Setup]
AppId={#ProductAppId}
AppName={#ProductName}
AppVersion={#InstallerVersion}
AppVerName={#ProductName} {#InstallerVersion}
AppPublisher=kechos
AppCopyright=Copyright (C) 2026 kechos
DefaultDirName={localappdata}\TabSpace\DragGroupHelper
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
WizardStyle=modern dynamic
WizardSizePercent=115
DisableWelcomePage=no
SetupIconFile={#PayloadDir}\helper.ico
WizardImageFile={#PayloadDir}\wizard.bmp
WizardImageFileDynamicDark={#PayloadDir}\wizard.bmp
WizardSmallImageFile={#PayloadDir}\wizard-small.bmp
WizardSmallImageFileDynamicDark={#PayloadDir}\wizard-small-dark.bmp
UninstallDisplayIcon={app}\helper.ico
LicenseFile={#PayloadDir}\LICENSE.txt
OutputDir={#OutputDir}
OutputBaseFilename={#SetupFileName}
VersionInfoVersion={#InstallerVersion}.0
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
AllowCancelDuringInstall=no
SetupMutex=TabSpaceHelperSetup{#ProductAppId}
UninstallDisplayName={#ProductName}
ChangesEnvironment=no
ChangesAssociations=no
UninstallLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PayloadDir}\native\DragGroup.Native.exe"; DestDir: "{app}\native"; Flags: ignoreversion
Source: "{#PayloadDir}\native\DragGroup.Native.dll"; DestDir: "{app}\native"; Flags: ignoreversion
Source: "{#PayloadDir}\native\DragGroup.Native.deps.json"; DestDir: "{app}\native"; Flags: ignoreversion
Source: "{#PayloadDir}\native\DragGroup.Native.runtimeconfig.json"; DestDir: "{app}\native"; Flags: ignoreversion
Source: "{#PayloadDir}\native\DragGroup.Core.dll"; DestDir: "{app}\native"; Flags: ignoreversion
Source: "{#PayloadDir}\identity.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\THIRD_PARTY_NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\SetupGuide.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#PayloadDir}\helper.ico"; DestDir: "{app}"; Flags: ignoreversion; AfterInstall: CommitRegistration

[Run]
Filename: "{app}\SetupGuide.html"; Description: "Open the setup guide"; Flags: shellexec postinstall skipifsilent unchecked; Check: InstallationSucceeded

[UninstallDelete]
Type: files; Name: "{app}\native\com.tabspace.draggroup.json"
Type: files; Name: "{app}\native\com.tabspace.draggroup.json.new"
Type: files; Name: "{app}\registration.ini"

[Code]
const
  NativeHostKey = '{#HostKey}';
var
  ChecksPage: TWizardPage;
  StatusText, ExistingText: TNewStaticText;
  ReplaceCheck: TNewCheckBox;
  RuntimeButton, RefreshButton: TNewButton;
  BeforeRegistration: String;
  BeforeExists, RegistrationWritten, InstallCommitted: Boolean;
  OldState, OldManifest: AnsiString;
  HadState, HadManifest, MetadataTouched: Boolean;
  InstallFailed, RolledBack: Boolean;
  InstallationError: String;

#include PayloadDir + "\RollbackPayload.iss"

function InstallationSucceeded: Boolean;
begin
  Result := not InstallFailed;
end;

function ManifestPath: String;
begin
  Result := ExpandConstant('{app}\native\com.tabspace.draggroup.json');
end;

function StatePath: String;
begin
  Result := ExpandConstant('{app}\registration.ini');
end;

function SamePath(A, B: String): Boolean;
begin
  Result := CompareText(A, B) = 0;
end;

function ReadRegistration(var Value: String; var Exists: Boolean): Boolean;
begin
  Value := '';
  Exists := RegValueExists(HKCU32, NativeHostKey, '');
  Result := (not Exists) or RegQueryStringValue(HKCU32, NativeHostKey, '', Value);
end;

function WriteRegistration(Value: String; Exists: Boolean): Boolean;
begin
  if Exists then
    Result := RegWriteStringValue(HKCU32, NativeHostKey, '', Value)
  else begin
    Result := (not RegValueExists(HKCU32, NativeHostKey, '')) or
      RegDeleteValue(HKCU32, NativeHostKey, '');
    RegDeleteKeyIfEmpty(HKCU32, NativeHostKey);
  end;
end;

function RuntimeAvailable: Boolean;
var
  Location, Line, Version: String;
  I, SpaceAt, ExitCode: Integer;
  Output: TExecOutput;
  PackedVersion: Int64;
begin
  Result := False;
#ifdef InstallerTestId
  if ExpandConstant('{param:TESTMISSINGRUNTIME|0}') = '1' then exit;
#endif
  Location := GetEnv('DOTNET_ROOT_X64');
  if Location = '' then Location := GetEnv('DOTNET_ROOT');
  if Location = '' then
    if not RegQueryStringValue(HKLM64, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64', 'InstallLocation', Location) then
      Location := ExpandConstant('{commonpf64}\dotnet');
  if not FileExists(AddBackslash(Location) + 'dotnet.exe') then exit;
  try
    if not ExecAndCaptureOutput(AddBackslash(Location) + 'dotnet.exe', '--list-runtimes', '', SW_HIDE, ewWaitUntilTerminated, ExitCode, Output) then exit;
    if (ExitCode <> 0) or Output.Error then exit;
  except
    Log(GetExceptionMessage);
    exit;
  end;
  for I := 0 to GetArrayLength(Output.StdOut) - 1 do begin
    Line := Output.StdOut[I];
    if Pos('Microsoft.WindowsDesktop.App ', Line) = 1 then begin
      Version := Copy(Line, Length('Microsoft.WindowsDesktop.App ') + 1, Length(Line));
      SpaceAt := Pos(' ', Version);
      if SpaceAt > 0 then Version := Copy(Version, 1, SpaceAt - 1);
      if (Pos('10.', Version) = 1) and StrToVersion(Version, PackedVersion) and
         FileExists(AddBackslash(Location) + 'shared\Microsoft.WindowsDesktop.App\' + Version + '\PresentationFramework.dll') then begin
        Result := True;
        exit;
      end;
    end;
  end;
end;

function RunningHelperError: String;
var
  Locator, Services, Processes, Process: Variant;
  I: Integer;
  Current, Candidate, Path: String;
  Exists: Boolean;
begin
  Result := '';
  if not ReadRegistration(Current, Exists) then begin
    Result := 'The current Chrome helper registration could not be read safely.';
    exit;
  end;
  Candidate := '';
  if Exists and (Current <> '') then
    Candidate := AddBackslash(ExtractFileDir(Current)) + 'DragGroup.Native.exe';
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Services := Locator.ConnectServer('', 'root\CIMV2');
    Processes := Services.ExecQuery('SELECT ExecutablePath FROM Win32_Process WHERE Name=''DragGroup.Native.exe''');
    for I := 0 to Processes.Count - 1 do begin
      Process := Processes.ItemIndex(I);
      if not VarIsNull(Process.ExecutablePath) then begin
        Path := Process.ExecutablePath;
        if SamePath(Path, ExpandConstant('{app}\native\DragGroup.Native.exe')) or
           ((Candidate <> '') and SamePath(Path, Candidate)) then begin
          Result := 'Drag Group is still running. Pause it in TabSpace or standalone Drag Group, or close Chrome completely, then try again. Setup never closes Chrome or kills the helper.';
          exit;
        end;
      end;
    end;
  except
    Log(GetExceptionMessage);
    Result := 'Windows could not check whether the helper is running. Close Chrome and try again. No registration was changed.';
  end;
end;

procedure RefreshChecks;
var
  Current, Expected: String;
  Exists: Boolean;
begin
  Expected := AddBackslash(WizardDirValue) + 'native\com.tabspace.draggroup.json';
  if RuntimeAvailable then
    StatusText.Caption := '.NET 10 Desktop Runtime x64 is installed.'
  else
    StatusText.Caption := '.NET 10 Desktop Runtime x64 is required. Use the Microsoft download below, install the x64 Desktop Runtime, then click Check again.';
  RuntimeButton.Visible := not RuntimeAvailable;
  if RuntimeButton.Visible then RefreshButton.Left := ScaleX(215)
  else RefreshButton.Left := 0;
  if not ReadRegistration(Current, Exists) then
    ExistingText.Caption := 'The existing Chrome registration could not be read.'
  else if Exists and not SamePath(Current, Expected) then
    ExistingText.Caption := 'A portable or different helper installation is registered. Its registration will be backed up; its files will remain untouched.'
  else if Exists then
    ExistingText.Caption := 'A managed installation is registered. Running Setup again repairs or updates the installed files and registration.'
  else
    ExistingText.Caption := 'Ready for a new per-user installation. One helper supports both TabSpace and standalone Drag Group.';
  ReplaceCheck.Visible := Exists and not SamePath(Current, Expected);
end;

procedure RefreshClick(Sender: TObject);
begin
  RefreshChecks;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = ChecksPage.ID then RefreshChecks;
end;

procedure RuntimeClick(Sender: TObject);
var
  ErrorCode: Integer;
begin
  ShellExec('open', 'https://dotnet.microsoft.com/download/dotnet/10.0', '', '', SW_SHOWNORMAL, ewNoWait, ErrorCode);
end;

procedure InitializeWizard;
begin
  WizardForm.WelcomeLabel1.Caption := 'Drag Group Helper';
  WizardForm.WelcomeLabel2.Caption := 'For TabSpace and standalone Drag Group' + #13#10#13#10 +
    'A small local bridge for drag-to-group in Chrome.' + #13#10#13#10 +
    'Installs for your Windows account. No administrator access, startup task or background service.' + #13#10#13#10 +
    'Pause Drag Group before updating. Your browser data and Spaces stay untouched.';
  ChecksPage := CreateCustomPage(wpLicense, 'Ready for your browser', 'Check the runtime and any existing helper installation.');
  StatusText := TNewStaticText.Create(ChecksPage);
  StatusText.Parent := ChecksPage.Surface;
  StatusText.SetBounds(0, 0, ChecksPage.SurfaceWidth, ScaleY(64));
  StatusText.AutoSize := False;
  StatusText.WordWrap := True;
  RuntimeButton := TNewButton.Create(ChecksPage);
  RuntimeButton.Parent := ChecksPage.Surface;
  RuntimeButton.SetBounds(0, ScaleY(72), ScaleX(205), ScaleY(28));
  RuntimeButton.Caption := 'Get .NET from Microsoft';
  RuntimeButton.OnClick := @RuntimeClick;
  RefreshButton := TNewButton.Create(ChecksPage);
  RefreshButton.Parent := ChecksPage.Surface;
  RefreshButton.SetBounds(ScaleX(215), ScaleY(72), ScaleX(110), ScaleY(28));
  RefreshButton.Caption := 'Check again';
  RefreshButton.OnClick := @RefreshClick;
  ExistingText := TNewStaticText.Create(ChecksPage);
  ExistingText.Parent := ChecksPage.Surface;
  ExistingText.SetBounds(0, ScaleY(122), ChecksPage.SurfaceWidth, ScaleY(70));
  ExistingText.AutoSize := False;
  ExistingText.WordWrap := True;
  ReplaceCheck := TNewCheckBox.Create(ChecksPage);
  ReplaceCheck.Parent := ChecksPage.Surface;
  ReplaceCheck.SetBounds(0, ScaleY(198), ChecksPage.SurfaceWidth, ScaleY(45));
  ReplaceCheck.Caption := 'Replace the previous registration, keeping its files and rollback information';
  ReplaceCheck.Checked := ExpandConstant('{param:REPLACEEXISTING|0}') = '1';
  RefreshChecks;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = ChecksPage.ID then begin
    RefreshChecks;
    if not RuntimeAvailable then begin
      SuppressibleMsgBox('Install .NET 10 Desktop Runtime x64, then click Check again.', mbInformation, MB_OK, IDOK);
      Result := False;
    end else if ReplaceCheck.Visible and not ReplaceCheck.Checked then begin
      SuppressibleMsgBox('Confirm replacement of the existing helper registration to continue.', mbInformation, MB_OK, IDOK);
      Result := False;
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Current: String;
  Exists: Boolean;
begin
  Result := '';
  if not RuntimeAvailable then begin
    Result := '.NET 10 Desktop Runtime x64 is missing. Install it from Microsoft and run Setup again.';
    exit;
  end;
  if not ReadRegistration(Current, Exists) then begin
    Result := 'Unsupported Chrome registration. Nothing was changed.';
    exit;
  end;
  if Exists and not SamePath(Current, ManifestPath) and not ReplaceCheck.Checked then begin
    Result := 'Existing helper registration changed. Confirm replacement before continuing. Silent installs require /REPLACEEXISTING=1.';
    exit;
  end;
  if FileExists(StatePath) then begin
    if (GetIniInt('Registration', 'Schema', 0, 0, 0, StatePath) <> 1) or
       not SamePath(GetIniString('Registration', 'Manifest', '', StatePath), ManifestPath) then begin
      Result := 'The installation ownership record is invalid. Nothing was changed.';
      exit;
    end;
  end else if Exists and SamePath(Current, ManifestPath) then begin
    Result := 'This path is registered but its ownership record is missing. Setup will not invent rollback information. Restore the ownership record or unregister the old installation first.';
    exit;
  end;
  Result := RunningHelperError;
  if Result <> '' then exit;
  BeforeRegistration := Current;
  BeforeExists := Exists;
  HadState := FileExists(StatePath);
  HadManifest := FileExists(ManifestPath);
  if HadState and not LoadStringFromFile(StatePath, OldState) then
    Result := 'Could not back up the installation ownership record.';
  if HadManifest and not LoadStringFromFile(ManifestPath, OldManifest) then
    Result := 'Could not back up the native manifest.';
  if Result = '' then begin
    try
      SnapshotInstalledPayload;
    except
      Result := 'Could not back up installed files: ' + GetExceptionMessage;
    end;
  end;
end;

function JsonEscape(Value: String): String;
begin
  StringChangeEx(Value, '\', '\\', True);
  StringChangeEx(Value, '"', '\"', True);
  Result := Value;
end;

#include PayloadDir + "\VerifyPayload.iss"

procedure RollbackInstallation;
var
  Current: String;
begin
  if RolledBack then exit;
  if RegistrationWritten and RegQueryStringValue(HKCU32, NativeHostKey, '', Current) and SamePath(Current, ManifestPath) then
    if not WriteRegistration(BeforeRegistration, BeforeExists) then
      RaiseException('Could not restore the previous Chrome registration.');
  RestoreInstalledPayload;
  if MetadataTouched then begin
    if HadState then begin
      if not SaveStringToFile(StatePath, OldState, False) then RaiseException('Could not restore ownership record.');
    end else DeleteFile(StatePath);
    if HadManifest then begin
      if not SaveStringToFile(ManifestPath, OldManifest, False) then RaiseException('Could not restore native manifest.');
    end else DeleteFile(ManifestPath);
    DeleteFile(ManifestPath + '.new');
  end;
  RolledBack := True;
end;

procedure CommitRegistration;
var
  Current, Manifest: String;
  Exists: Boolean;
begin
  { Script callback exceptions are not fatal in Inno. Handle the rollback and
    exit status explicitly instead of displaying a false success. }
  try
    VerifyInstalledPayload;
    if not ReadRegistration(Current, Exists) or (Exists <> BeforeExists) or
       (Current <> BeforeRegistration) then
      RaiseException('Chrome registration changed during installation. Setup will not overwrite it.');
    MetadataTouched := True;
    if not (HadState and BeforeExists and SamePath(BeforeRegistration, ManifestPath)) then begin
      if not SetIniInt('Registration', 'Schema', 1, StatePath) or
         not SetIniString('Registration', 'Manifest', ManifestPath, StatePath) or
         not SetIniString('Registration', 'Previous', BeforeRegistration, StatePath) or
         not SetIniBool('Registration', 'PreviousExists', BeforeExists, StatePath) then
        RaiseException('Could not save rollback information.');
    end;
    Manifest := '{"name":"com.tabspace.draggroup","description":"Drag Group helper for TabSpace and standalone Drag Group","path":"' +
      JsonEscape(ExpandConstant('{app}\native\DragGroup.Native.exe')) + '","type":"stdio","allowed_origins":{#AllowedOrigins}}';
    if not SaveStringToFile(ManifestPath + '.new', UTF8Encode(Manifest), False) then
      RaiseException('Could not write the Chrome native manifest.');
    if FileExists(ManifestPath) and not DeleteFile(ManifestPath) then
      RaiseException('Could not replace the previous native manifest.');
    if not RenameFile(ManifestPath + '.new', ManifestPath) then
      RaiseException('Could not finalize the Chrome native manifest.');
    if not WriteRegistration(ManifestPath, True) then
      RaiseException('Could not register the helper for this Windows account.');
    RegistrationWritten := True;
#ifdef InstallerTestId
    if ExpandConstant('{param:TESTFAILAFTERREGISTER|0}') = '1' then
      RaiseException('Injected isolated installation failure.');
#endif
    if not RegQueryStringValue(HKCU32, NativeHostKey, '', Current) or not SamePath(Current, ManifestPath) then
      RaiseException('Chrome registration verification failed.');
  except
    InstallFailed := True;
    InstallationError := GetExceptionMessage;
    Log('HELPER INSTALL FAILED: ' + InstallationError);
    try
      RollbackInstallation;
    except
      InstallationError := InstallationError + #13#10 + 'Rollback needs attention: ' + GetExceptionMessage;
      Log(InstallationError);
    end;
    SuppressibleMsgBox('The helper could not be installed.' + #13#10#13#10 + InstallationError + #13#10#13#10 +
      'Run Setup again to repair. An incomplete entry can be removed from Windows Settings > Apps.', mbError, MB_OK, IDOK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssDone then InstallCommitted := not InstallFailed;
  if (CurStep = ssPostInstall) and not InstallFailed then begin
    WizardForm.FinishedHeadingLabel.Caption := 'Your helper is installed';
    WizardForm.FinishedLabel.Caption := 'Files, .NET runtime and Chrome registration have been checked.' + #13#10#13#10 +
      'Enable Drag Group in TabSpace Settings or the standalone popup. Use one active edition at a time.' + #13#10#13#10 +
      'To repair or update later, run Setup again. To remove it, use Windows Settings > Apps. Your Spaces and Chrome data are never removed.';
  end;
  if (CurStep = ssPostInstall) and InstallFailed then begin
    WizardForm.FinishedHeadingLabel.Caption := 'Setup needs attention';
    WizardForm.FinishedLabel.Caption := 'The helper installation did not complete.' + #13#10#13#10 + InstallationError + #13#10#13#10 +
      'The previous files and registration were restored where possible. Run Setup again to repair, or remove the incomplete helper from Windows Settings > Apps.';
  end;
end;

function GetCustomSetupExitCode: Integer;
begin
  if InstallFailed then Result := 20 else Result := 0;
end;

procedure DeinitializeSetup;
begin
  if not InstallCommitted then
    try RollbackInstallation;
    except Log('ROLLBACK ERROR: ' + GetExceptionMessage);
    end;
end;

function InitializeUninstall: Boolean;
var
  Error, Current: String;
  Exists: Boolean;
begin
  Error := RunningHelperError;
  if (Error = '') and ReadRegistration(Current, Exists) and Exists and SamePath(Current, ManifestPath) then
    if (GetIniInt('Registration', 'Schema', 0, 0, 0, StatePath) <> 1) or
       not SamePath(GetIniString('Registration', 'Manifest', '', StatePath), ManifestPath) then
      Error := 'The owned registration backup is missing or invalid. Restore it before uninstalling. No files were removed.';
  Result := Error = '';
  if not Result then
    SuppressibleMsgBox(Error, mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Current, Previous: String;
  Exists, PreviousExists: Boolean;
begin
  if CurUninstallStep = usUninstall then begin
    if not ReadRegistration(Current, Exists) then
      RaiseException('The Chrome registration could not be read. No files were removed.');
    if Exists and SamePath(Current, ManifestPath) then begin
      if (GetIniInt('Registration', 'Schema', 0, 0, 0, StatePath) <> 1) or
         not SamePath(GetIniString('Registration', 'Manifest', '', StatePath), ManifestPath) then
        RaiseException('The owned registration backup is missing or invalid. No files were removed.');
      Previous := GetIniString('Registration', 'Previous', '', StatePath);
      PreviousExists := GetIniBool('Registration', 'PreviousExists', False, StatePath);
      if PreviousExists and ((Previous = '') or not FileExists(Previous)) then begin
        Log('Previous manifest no longer exists; removing only the owned registration.');
        PreviousExists := False;
      end;
      if not WriteRegistration(Previous, PreviousExists) then
        RaiseException('The owned registration could not be restored or removed.');
    end else
      Log('Chrome registration belongs to another installation; preserving it.');
  end;
end;
