import { spawnSync } from "node:child_process";
import path from "node:path";

const inspectProcessesScript = String.raw`
$ErrorActionPreference = 'Stop'
$app = $env:CODEX_TASKBOARD_CODEX_APP_PATH
$name = [IO.Path]::GetFileName($app)
$processes = @(Get-CimInstance Win32_Process -Filter "Name = '$name'" |
  Where-Object { $_.ExecutablePath -eq $app } |
  Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine)
[Console]::Out.Write(($processes | ConvertTo-Json -Compress))
`;

const activatePackagedAppScript = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IApplicationActivationManager
{
    [PreserveSig]
    int ActivateApplication(
        [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
        [MarshalAs(UnmanagedType.LPWStr)] string arguments,
        uint options,
        out uint processId);
}

[ComImport]
[Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
class ApplicationActivationManager {}

public static class PackagedAppActivator
{
    public static uint Activate(string appUserModelId, string arguments)
    {
        var manager = (IApplicationActivationManager)new ApplicationActivationManager();
        try
        {
            uint processId;
            var result = manager.ActivateApplication(appUserModelId, arguments, 0, out processId);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return processId;
        }
        finally
        {
            Marshal.FinalReleaseComObject(manager);
        }
    }
}
'@
Add-Type -TypeDefinition $source

$app = $env:CODEX_TASKBOARD_CODEX_APP_PATH
$profile = $env:CODEX_TASKBOARD_CODEX_PROFILE
$port = $env:CODEX_TASKBOARD_CODEX_PORT
$package = Get-AppxPackage | Where-Object {
  $app.StartsWith(($_.InstallLocation + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)
} | Select-Object -First 1
if ($null -eq $package) { throw "Unable to find the Codex package for $app" }

$relativeExecutable = $app.Substring($package.InstallLocation.Length).TrimStart('\', '/').Replace('\', '/')
$manifest = $package | Get-AppxPackageManifest
$application = @($manifest.Package.Applications.Application) | Where-Object {
  ([string]$_.Executable).Replace('\', '/') -eq $relativeExecutable
} | Select-Object -First 1
if ($null -eq $application) { throw "Unable to find the Codex application manifest entry" }

$appUserModelId = $package.PackageFamilyName + '!' + $application.Id
$escapedProfile = $profile.Replace('"', '\"')
$arguments = '--user-data-dir="' + $escapedProfile + '"' +
  ' --remote-debugging-address=127.0.0.1' +
  ' --remote-debugging-port=' + $port +
  ' --remote-allow-origins=http://127.0.0.1:' + $port
$processId = [PackagedAppActivator]::Activate($appUserModelId, $arguments)
[Console]::Out.Write($processId)
`;

function runWindowsPowerShell(script, environment, run = spawnSync) {
  const result = run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "Windows PowerShell command failed");
  }
  return result.stdout.trim();
}

export function windowsCodexProcesses(appPath, environment, run = spawnSync) {
  const output = runWindowsPowerShell(
    inspectProcessesScript,
    { ...environment, CODEX_TASKBOARD_CODEX_APP_PATH: appPath },
    run,
  );
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((record) => ({
    pid: Number(record.ProcessId),
    parentPid: Number(record.ParentProcessId),
    executable: record.ExecutablePath || appPath,
    command: record.CommandLine || record.ExecutablePath || appPath,
  }));
}

export function activateWindowsCodex(appPath, profilePath, port, environment, run = spawnSync) {
  const output = runWindowsPowerShell(
    activatePackagedAppScript,
    {
      ...environment,
      CODEX_TASKBOARD_CODEX_APP_PATH: appPath,
      CODEX_TASKBOARD_CODEX_PROFILE: profilePath,
      CODEX_TASKBOARD_CODEX_PORT: String(port),
    },
    run,
  );
  const pid = Number(output);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Packaged Codex activation returned an invalid process ID: ${output}`);
  }
  return pid;
}

export function stopWindowsCodex(pid, environment, run = spawnSync) {
  runWindowsPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TaskboardNormalClose {
  [StructLayout(LayoutKind.Sequential)]
  public struct UniqueProcess {
    public uint ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  private static extern int RmRegisterResources(uint session, uint files, string[] names, uint count, UniqueProcess[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmShutdown(uint session, uint flags, IntPtr callback);
  [DllImport("rstrtmgr.dll")]
  private static extern int RmEndSession(uint session);
  public static bool Request(uint pid, long startTime) {
    uint session;
    int result = RmStartSession(out session, 0, new StringBuilder(33));
    if (result != 0) throw new InvalidOperationException("RmStartSession: " + result);
    try {
      var target = new UniqueProcess { ProcessId = pid };
      target.StartTime.dwLowDateTime = unchecked((int)startTime);
      target.StartTime.dwHighDateTime = (int)(startTime >> 32);
      result = RmRegisterResources(session, 0, null, 1, new[] { target }, 0, null);
      if (result != 0) throw new InvalidOperationException("RmRegisterResources: " + result);
      // Zero flags requests normal shutdown; RmForceShutdown is never used.
      result = RmShutdown(session, 0, IntPtr.Zero);
      if (result != 0) throw new InvalidOperationException("Codex rejected normal shutdown: " + result);
      return true;
    } finally { RmEndSession(session); }
  }
}
'@
$targetId = [int]$env:CODEX_TASKBOARD_STOP_PID
$target = Get-Process -Id $targetId -ErrorAction SilentlyContinue
if ($null -eq $target) { return }
try {
  if ($target.HasExited) { return }
  if (-not [TaskboardNormalClose]::Request($targetId, $target.StartTime.ToUniversalTime().ToFileTimeUtc())) {
    throw "Codex did not accept a normal close request; restart canceled to preserve the conversation."
  }
  if (-not $target.WaitForExit(30000)) {
    throw "Codex is still saving or waiting for confirmation; restart canceled without forcing it to exit."
  }
} finally {
  $target.Dispose()
}
`, { ...environment, CODEX_TASKBOARD_STOP_PID: String(pid) }, run);
}

export function windowsCodexProfileArgument(command, profilePath) {
  const normalizedCommand = command.toLocaleLowerCase("en-US");
  return normalizedCommand.includes("--user-data-dir")
    && normalizedCommand.includes(path.win32.resolve(profilePath).toLocaleLowerCase("en-US"));
}

export function windowsRootProcesses(processes) {
  const processIds = new Set(processes.map((record) => record.pid));
  return processes.filter((record) => !processIds.has(record.parentPid));
}

export function focusWindowsCodex(pid, environment = process.env, run = spawnSync) {
  if (!pid) return;
  runWindowsPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TaskboardFocus {
  private delegate bool Visitor(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Visitor visitor, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
  public static void Focus(uint pid) {
    EnumWindows((window, parameter) => {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner == pid && IsWindowVisible(window)) {
        ShowWindowAsync(window, 9);
        SetForegroundWindow(window);
        return false;
      }
      return true;
    }, IntPtr.Zero);
  }
}
'@
[TaskboardFocus]::Focus([uint32]$env:CODEX_TASKBOARD_FOCUS_PID)
`, { ...environment, CODEX_TASKBOARD_FOCUS_PID: String(pid) }, run);
}
