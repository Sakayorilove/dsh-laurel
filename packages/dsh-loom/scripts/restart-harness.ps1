<#
  重启 DeepSeek Harness 桌面版（交付流程用；助手直接重启，不要求用户手动操作）。

  ⚠ 本脚本存在的唯一原因：**某些沙箱 shell 里带着 `ELECTRON_RUN_AS_NODE=1`**。
  带着它去 `Start-Process` Electron，应用会以 **Node 模式**运行 → 进程秒退、
  零日志、零窗口，看起来完全像「启动失败」（2026-10-06 实测，白折腾三轮）。
  脚本自己会清掉 `ELECTRON_RUN_AS_NODE` 与 `NODE_OPTIONS` 再启动。

  ⚠ 第二条：**从沙箱里启动的实例会在那一轮对话结束时被连带杀掉**（进程树回收，
  没有崩溃日志、事件日志里也没有 Application Error）。所以本脚本必须**在沙箱外**
  运行：调用方需要以「禁用沙箱」的方式执行本脚本，否则应用起得来、
  但下一次对话结束就没了。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-harness.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/restart-harness.ps1 -DryRun

  成功判据（脚本会打印）：进程数 ≥5 + 主窗口标题是真实会话名 + 插件状态文件版本/时间已更新 + laurel 记 ready。
#>
[CmdletBinding()]
param(
  [string]$Exe,
  [int]$CloseWaitSeconds = 25,
  [int]$StartWaitSeconds = 40,
  [string]$ProfileRoot,
  [string]$EvidenceRoot,
  [switch]$ScreenshotOnly,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$name = 'DeepSeek Harness'

if (-not $Exe) {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'),
    'D:\Users\<你的用户>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe',
    'C:\Users\<你的用户>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
  )
  $Exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Exe -or -not (Test-Path $Exe)) { throw "找不到 Harness 可执行文件；用 -Exe 指定" }
if (-not $ProfileRoot) { $ProfileRoot = Join-Path $env:USERPROFILE '.dsh' }
$statusFile = Join-Path $ProfileRoot 'loom\installation-status.json'
$laurelLog = Join-Path $ProfileRoot 'laurel\events.log'
if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path $PSScriptRoot '..\docs\dsh-loom\handoff\evidence' }

<#
  重启后的冒烟截图（S8 / P3-13）：把 **Harness 主窗口**存成 PNG 放到
  evidence\<版本>\screenshots\smoke-<时间戳>.png，供人工瞄一眼视觉回归。
  - 只截主窗口矩形，不截整屏：整屏会把用户桌面上的别的东西一起存进交付证据。
  - 先把窗口提到前台再截，否则截到的是压在上面的别的窗口。
  - 必须**在沙箱外**运行 —— 沙箱里 Add-Type / 图形接口会被拦（见技能
    windows-ui-evidence-ctypes），拿不到图。
#>
function Save-SmokeShot {
  try {
    $version = 'unknown'
    if (Test-Path $statusFile) { $version = (Get-Content $statusFile -Raw | ConvertFrom-Json).version }
    $dir = Join-Path (Join-Path $EvidenceRoot $version) 'screenshots'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $path = Join-Path $dir ("smoke-" + $stamp + ".png")
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    if (-not ('LoomWin32' -as [type])) {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public struct LoomRect { public int Left, Top, Right, Bottom; }
public class LoomWin32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out LoomRect rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
}
'@
    }
    $target = @(Get-Process -Name $name -ErrorAction SilentlyContinue) | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
    if (-not $target) { Write-Output 'SCREENSHOT_SKIPPED 没有带标题的主窗口'; return }
    [void][LoomWin32]::ShowWindow($target.MainWindowHandle, 9)   # SW_RESTORE
    [void][LoomWin32]::SetForegroundWindow($target.MainWindowHandle)
    Start-Sleep -Milliseconds 700
    $rect = New-Object LoomRect
    if (-not [LoomWin32]::GetWindowRect($target.MainWindowHandle, [ref]$rect)) { Write-Output 'SCREENSHOT_SKIPPED 拿不到窗口矩形'; return }
    $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
    if ($width -le 40 -or $height -le 40) { Write-Output 'SCREENSHOT_SKIPPED 窗口尺寸异常'; return }
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size $width, $height))
      $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      Write-Output ("SCREENSHOT " + $path + " (" + $width + "x" + $height + ")")
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
  } catch {
    Write-Output ("SCREENSHOT_FAILED " + $_.Exception.Message)
  }
}

# 关键一步：污染变量必须在启动前清掉（子进程继承本进程的环境块）。
$polluted = @()
foreach ($key in 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS') {
  $value = [Environment]::GetEnvironmentVariable($key, 'Process')
  if ($value) { $polluted += "$key=$value" }
  Remove-Item "Env:\$key" -ErrorAction SilentlyContinue
}
Write-Output ("POLLUTED_BEFORE=[" + ($polluted -join ' | ') + "]")

$before = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
Write-Output ("BEFORE_PIDS=" + (($before | ForEach-Object { $_.Id }) -join ','))
$mainBefore = $before | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
if ($mainBefore) { Write-Output ("BEFORE_MAIN_TITLE=" + $mainBefore.MainWindowTitle) }

if ($DryRun) {
  Write-Output ("DRY_RUN exe=" + $Exe + " status=" + $statusFile)
  exit 0
}

# 0) 只截图（不重启）：用来给交付证据补一张「重启后主窗口」的冒烟图。
if ($ScreenshotOnly) {
  Save-SmokeShot
  exit 0
}

# 1) 优雅关闭主窗口，让应用自己收尾（保住会话与输入）。
if ($mainBefore) { $mainBefore.CloseMainWindow() | Out-Null }
$deadline = (Get-Date).AddSeconds($CloseWaitSeconds)
while ((Get-Process -Name $name -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Seconds 1 }
# 2) 收尾残留（不连点、不早启，避免 Cordis INACTIVE_EFFECT）。
$left = Get-Process -Name $name -ErrorAction SilentlyContinue
if ($left) { $left | Stop-Process -Force; Start-Sleep -Seconds 3 }
Write-Output ("REMAINING_AFTER_CLOSE=" + (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count))

# 3) 干净启动。
Start-Process -FilePath $Exe -WorkingDirectory (Split-Path $Exe -Parent)
$deadline = (Get-Date).AddSeconds($StartWaitSeconds)
$after = @()
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $after = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  $titled = $after | Where-Object { $_.MainWindowTitle -ne '' }
  if ($after.Count -ge 3 -and $titled) { break }
}
Write-Output ("AFTER_PIDS=" + (($after | ForEach-Object { $_.Id }) -join ','))
Write-Output ("AFTER_COUNT=" + $after.Count)
foreach ($p in ($after | Where-Object { $_.MainWindowTitle -ne '' })) { Write-Output ("MAIN_WINDOW pid=" + $p.Id + " title=" + $p.MainWindowTitle) }

# 4) 硬指标：插件状态文件 + laurel ready。
if (Test-Path $statusFile) {
  $status = Get-Content $statusFile -Raw | ConvertFrom-Json
  Write-Output ("PLUGIN_STATUS version=" + $status.version + " active=" + $status.active + " at=" + $status.at + " pid=" + $status.pid)
} else { Write-Output "PLUGIN_STATUS missing" }
if (Test-Path $laurelLog) {
  $ready = Select-String -Path $laurelLog -Pattern '"kind":"ready"' | Select-Object -Last 1
  if ($ready) { Write-Output ("LAUREL_READY " + $ready.Line) }
}

if ($after.Count -eq 0) { throw '重启失败：没有 Harness 进程' }

# 5) 重启成功就留一张冒烟截图（失败不影响重启结论）。
Save-SmokeShot
