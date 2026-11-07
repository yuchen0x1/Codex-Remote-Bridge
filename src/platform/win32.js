'use strict';

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PS_PREAMBLE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class CodexMiniWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }
}
"@

function Get-CodexWindow {
  try {
    $mainProcess = Get-Process -Name Codex -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -eq 'Codex' } |
      Select-Object -First 1
    if ($mainProcess -ne $null) {
      return [IntPtr]$mainProcess.MainWindowHandle
    }
  } catch {}

  $script:codexMiniBestWindow = [IntPtr]::Zero
  $script:codexMiniBestScore = -1
  [CodexMiniWin32]::EnumWindows({
    param([IntPtr]$hwnd, [IntPtr]$lparam)
    if (-not [CodexMiniWin32]::IsWindowVisible($hwnd)) { return $true }
    $procId = 0
    [void][CodexMiniWin32]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    if ($procId -le 0) { return $true }
    $processName = ''
    $processPath = ''
    try {
      $process = Get-Process -Id $procId -ErrorAction Stop
      $processName = [string]$process.ProcessName
      try { $processPath = [string]$process.Path } catch {}
    } catch {}
    $titleBuilder = New-Object System.Text.StringBuilder 512
    [void][CodexMiniWin32]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity)
    $title = $titleBuilder.ToString()
    $descriptor = "$title $processName $processPath"
    if ($descriptor -match '(?i)Codex Max') { return $true }
    $score = 0
    if ($processName -match '^(Codex|OpenAI Codex|codex)') { $score += 10 }
    if ($title -match 'Codex') { $score += 6 }
    if ($score -le 0) { return $true }
    if ($score -gt $script:codexMiniBestScore) {
      $script:codexMiniBestWindow = $hwnd
      $script:codexMiniBestScore = $score
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($script:codexMiniBestScore -lt 6) { return [IntPtr]::Zero }
  return $script:codexMiniBestWindow
}

function Invoke-CodexLink([string]$url) {
  Start-Process $url
}

function Reset-KeyboardModifiers {
  $keys = @(0x10, 0x11, 0x12, 0x5B, 0x5C)
  $events = New-Object 'CodexMiniWin32+INPUT[]' $keys.Length
  for ($i = 0; $i -lt $keys.Length; $i++) {
    $events[$i].type = 1
    $events[$i].u.ki.wVk = [UInt16]$keys[$i]
    $events[$i].u.ki.dwFlags = 2
  }
  [void][CodexMiniWin32]::SendInput([uint32]$events.Length, $events, [Runtime.InteropServices.Marshal]::SizeOf([type][CodexMiniWin32+INPUT]))
}

function Set-CodexForeground([IntPtr]$hwnd) {
  $targetPid = 0
  $targetThread = [CodexMiniWin32]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
  $foreground = [CodexMiniWin32]::GetForegroundWindow()
  $foregroundPid = 0
  $foregroundThread = if ($foreground -ne [IntPtr]::Zero) { [CodexMiniWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid) } else { 0 }
  $currentThread = [CodexMiniWin32]::GetCurrentThreadId()
  $attachedTarget = $false
  $attachedForeground = $false
  try {
    if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
      $attachedTarget = [CodexMiniWin32]::AttachThreadInput($currentThread, $targetThread, $true)
    }
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread -and $foregroundThread -ne $targetThread) {
      $attachedForeground = [CodexMiniWin32]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }
    [void][CodexMiniWin32]::ShowWindow($hwnd, 9)
    [void][CodexMiniWin32]::BringWindowToTop($hwnd)
    [void][CodexMiniWin32]::SetActiveWindow($hwnd)
    [void][CodexMiniWin32]::SetForegroundWindow($hwnd)
  } finally {
    if ($attachedForeground) { [void][CodexMiniWin32]::AttachThreadInput($currentThread, $foregroundThread, $false) }
    if ($attachedTarget) { [void][CodexMiniWin32]::AttachThreadInput($currentThread, $targetThread, $false) }
  }
}

function Activate-CodexWindow {
  $hwnd = Get-CodexWindow
  if ($hwnd -eq [IntPtr]::Zero) {
    throw '没有找到 Codex Desktop 主窗口。请确认 Codex Desktop 已安装并能通过 codex:// 打开。'
  }
  [void][CodexMiniWin32]::ShowWindow($hwnd, 9)
  Start-Sleep -Milliseconds 70
  Reset-KeyboardModifiers
  for ($i = 0; $i -lt 8; $i++) {
    Set-CodexForeground $hwnd
    Start-Sleep -Milliseconds 80
    if ([CodexMiniWin32]::GetForegroundWindow() -eq $hwnd) {
      Reset-KeyboardModifiers
      return $hwnd
    }
    [CodexMiniWin32]::SwitchToThisWindow($hwnd, $true)
    Start-Sleep -Milliseconds 110
    if ([CodexMiniWin32]::GetForegroundWindow() -eq $hwnd) {
      Reset-KeyboardModifiers
      return $hwnd
    }
  }
  throw '没能把 Codex Desktop 激活为前台窗口，已停止发送，避免按键落到其他窗口。'
}

function Focus-CodexProseMirrorComposer {
  $hwnd = Activate-CodexWindow
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($root -eq $null) {
    throw '没有读取到 Codex Desktop 窗口结构，无法定位输入框。'
  }
  $windowRect = $root.Current.BoundingRectangle
  $items = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $best = $null
  $bestScore = -1
  foreach ($item in $items) {
    $className = [string]$item.Current.ClassName
    if ($className -ne 'ProseMirror') { continue }
    if (-not $item.Current.IsKeyboardFocusable) { continue }
    $rect = $item.Current.BoundingRectangle
    $score = [int]$rect.Bottom + [int]($rect.Width / 10)
    if ($score -gt $bestScore) {
      $best = $item
      $bestScore = $score
    }
  }
  if ($best -eq $null) {
    $buttons = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Button
      ))
    )
    $leftEdge = 0
    $rightEdge = 0
    $toolbarTop = 0
    $toolbarBottom = 0
    foreach ($button in $buttons) {
      $buttonRect = $button.Current.BoundingRectangle
      if ($buttonRect.Width -lt 12 -or $buttonRect.Height -lt 12) { continue }
      if ($buttonRect.Y -lt ($windowRect.Top + ($windowRect.Height * 0.55)) -or $buttonRect.Bottom -gt ($windowRect.Bottom + 8)) { continue }
      $name = [string]$button.Current.Name
      if ($name -match '(添加文件|自定义|听写|停止|发送|模型|推理|[0-9](?:\.[0-9])?\s*(低|中|高|超高)?)') {
        if ($toolbarTop -eq 0 -or $buttonRect.Top -lt $toolbarTop) { $toolbarTop = $buttonRect.Top }
        if ($buttonRect.Bottom -gt $toolbarBottom) { $toolbarBottom = $buttonRect.Bottom }
        if ($name -match '(添加文件|自定义)') {
          if ($buttonRect.Right -gt $leftEdge) { $leftEdge = $buttonRect.Right }
        } else {
          if ($rightEdge -eq 0 -or $buttonRect.X -lt $rightEdge) { $rightEdge = $buttonRect.X }
        }
      }
    }
    if ($toolbarTop -gt 0 -and $toolbarBottom -gt $toolbarTop) {
      $x = if ($leftEdge -gt 0 -and $rightEdge -gt 0 -and ($rightEdge - $leftEdge) -gt 80) {
        [int](($leftEdge + $rightEdge) / 2)
      } else {
        [int]($windowRect.Left + ($windowRect.Width * 0.50))
      }
      $y = [int]($toolbarTop - 28)
      if ($y -lt ($windowRect.Top + ($windowRect.Height * 0.55))) {
        $y = [int]($toolbarTop - 12)
      }
      Invoke-MouseClick $x $y 120
      return
    }
    throw '没有找到 Codex Desktop 的输入区。请确认当前线程页面已经加载完成。'
  }
  $best.SetFocus()
  Start-Sleep -Milliseconds 120
}

function Invoke-MouseClick([int]$x, [int]$y, [int]$settleMs = 140) {
  [void][CodexMiniWin32]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 40
  [void][CodexMiniWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [void][CodexMiniWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds $settleMs
}

function Click-CodexComposerFallback([IntPtr]$hwnd) {
  $rect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw 'Codex 窗口尺寸异常，无法计算输入框位置。' }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($root -ne $null) {
    try {
      $buttons = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button
        ))
      )
      $leftEdge = 0
      $rightEdge = 0
      $toolbarTop = 0
      $toolbarBottom = 0
      foreach ($button in $buttons) {
        $buttonRect = $button.Current.BoundingRectangle
        if ($buttonRect.Width -lt 12 -or $buttonRect.Height -lt 12) { continue }
        if ($buttonRect.X -lt $rect.Left -or $buttonRect.Right -gt $rect.Right -or
            $buttonRect.Y -lt ($rect.Top + ($height * 0.65)) -or $buttonRect.Bottom -gt $rect.Bottom) { continue }
        $name = [string]$button.Current.Name
        if ($name -match '(添加文件|自定义|听写|停止|发送|模型|推理|GPT|gpt|[0-9](?:\\.[0-9])?\\s*(低|中|高|超高)?)') {
          if ($toolbarTop -eq 0 -or $buttonRect.Top -lt $toolbarTop) { $toolbarTop = $buttonRect.Top }
          if ($buttonRect.Bottom -gt $toolbarBottom) { $toolbarBottom = $buttonRect.Bottom }
          if ($name -match '(添加文件|自定义)') {
            if ($buttonRect.Right -gt $leftEdge) { $leftEdge = $buttonRect.Right }
          } else {
            if ($rightEdge -eq 0 -or $buttonRect.X -lt $rightEdge) { $rightEdge = $buttonRect.X }
          }
        }
      }
      if ($toolbarTop -gt 0 -and $toolbarBottom -gt $toolbarTop) {
        $toolbarHeight = $toolbarBottom - $toolbarTop
        $textOffset = [Math]::Max(26, [Math]::Min(54, $toolbarHeight + 20))
        $y = [int]($toolbarTop - $textOffset)
        if ($y -lt ($rect.Top + ($height * 0.52))) {
          $y = [int]($toolbarTop - [Math]::Max(18, [Math]::Min(32, $toolbarHeight)))
        }
        if ($leftEdge -gt 0 -and $rightEdge -gt 0 -and ($rightEdge - $leftEdge) -gt 120) {
          $x = [int](($leftEdge + $rightEdge) / 2)
        } else {
          $x = [int]($rect.Left + ($width * 0.50))
        }
        Invoke-MouseClick $x $y 180
        return
      }
    } catch {}
  }

  $x = [int]($rect.Left + ($width * 0.50))
  $y = [int]($rect.Bottom - [Math]::Max(82, [Math]::Min(138, $height * 0.10)))
  Invoke-MouseClick $x $y 160
}

function Click-CodexComposerActionButton {
  $hwnd = Activate-CodexWindow
  $rect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) { throw 'Codex 窗口尺寸异常，无法计算停止按钮位置。' }
  $x = [int]($rect.Right - [Math]::Max(44, [Math]::Min(86, $width * 0.055)))
  $y = [int]($rect.Bottom - [Math]::Max(86, [Math]::Min(170, $height * 0.11)))
  Invoke-MouseClick $x $y 180
}

function Focus-CodexComposerOnce {
  $hwnd = Activate-CodexWindow
  $windowRect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$windowRect)
  $windowWidth = $windowRect.Right - $windowRect.Left
  $windowHeight = $windowRect.Bottom - $windowRect.Top
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($root -ne $null) {
    $controls = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty,
        $true
      ))
    )
    $best = $null
    $bestScore = -1
    foreach ($item in $controls) {
      $rect = $item.Current.BoundingRectangle
      if ($rect.Width -lt 180 -or $rect.Height -lt 18) { continue }
      if ($rect.X -lt $windowRect.Left -or $rect.Y -lt $windowRect.Top -or
          $rect.Right -gt $windowRect.Right -or $rect.Bottom -gt $windowRect.Bottom) { continue }
      if ($rect.Bottom -lt ($windowRect.Top + ($windowHeight * 0.45))) { continue }
      $controlType = $item.Current.ControlType
      $name = [string]$item.Current.Name
      $automationId = [string]$item.Current.AutomationId
      $className = [string]$item.Current.ClassName
      $descriptor = "$name $automationId $className"
      $hasComposerSignal = $descriptor -match '(input|message|composer|prompt|chat|ask|textarea|editor|输入|消息|提问|询问)'
      $isTextControl = $controlType -eq [System.Windows.Automation.ControlType]::Edit -or $hasComposerSignal
      if (-not $isTextControl) { continue }
      $score = [int]$rect.Bottom
      if ($controlType -eq [System.Windows.Automation.ControlType]::Edit) { $score += 800 }
      if ($hasComposerSignal) { $score += 1000 }
      if ($rect.X -gt ($windowRect.Left + ($windowWidth * 0.12))) { $score += 120 }
      if ($score -gt $bestScore) {
        $best = $item
        $bestScore = $score
      }
    }
    if ($best -ne $null) {
      try {
        $best.SetFocus()
        $bestRect = $best.Current.BoundingRectangle
        Invoke-MouseClick ([int]($bestRect.X + ($bestRect.Width / 2))) ([int]($bestRect.Y + ($bestRect.Height / 2))) 140
        return
      } catch {}
    }
  }

  Click-CodexComposerFallback $hwnd
}

function Focus-CodexComposer {
  $lastError = $null
  for ($i = 0; $i -lt 3; $i++) {
    try {
      Focus-CodexComposerOnce
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 220
    }
  }
  if ($lastError -ne $null) { throw $lastError }
}

function Prime-CodexComposerFocus {
  $hwnd = Activate-CodexWindow
  $windowRect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$windowRect)
  $windowWidth = $windowRect.Right - $windowRect.Left
  $windowHeight = $windowRect.Bottom - $windowRect.Top
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($root -eq $null) { return $false }

  try {
    $controls = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty,
        $true
      ))
    )
    $best = $null
    $bestScore = -1
    foreach ($item in $controls) {
      $rect = $item.Current.BoundingRectangle
      if ($rect.Width -lt 180 -or $rect.Height -lt 18) { continue }
      if ($rect.X -lt $windowRect.Left -or $rect.Y -lt $windowRect.Top -or
          $rect.Right -gt $windowRect.Right -or $rect.Bottom -gt $windowRect.Bottom) { continue }
      if ($rect.Bottom -lt ($windowRect.Top + ($windowHeight * 0.45))) { continue }
      $controlType = $item.Current.ControlType
      $name = [string]$item.Current.Name
      $automationId = [string]$item.Current.AutomationId
      $className = [string]$item.Current.ClassName
      $descriptor = "$name $automationId $className"
      $hasComposerSignal = $descriptor -match '(input|message|composer|prompt|chat|ask|textarea|editor|输入|消息|提问|询问|要求后续变更)'
      $isTextControl = $controlType -eq [System.Windows.Automation.ControlType]::Edit -or $hasComposerSignal
      if (-not $isTextControl) { continue }
      $score = [int]$rect.Bottom
      if ($controlType -eq [System.Windows.Automation.ControlType]::Edit) { $score += 800 }
      if ($hasComposerSignal) { $score += 1000 }
      if ($rect.X -gt ($windowRect.Left + ($windowWidth * 0.12))) { $score += 120 }
      if ($score -gt $bestScore) {
        $best = $item
        $bestScore = $score
      }
    }
    if ($best -ne $null) {
      $best.SetFocus()
      Start-Sleep -Milliseconds 45
      return $true
    }
  } catch {}

  return $false
}

function Get-CodexToolbarState {
  $hwnd = Get-CodexWindow
  if ($hwnd -eq [IntPtr]::Zero) {
    @{
      raw = ''
      modelLabel = ''
      reasoningLabel = ''
    } | ConvertTo-Json -Compress
    return
  }
  $windowRect = New-Object CodexMiniWin32+RECT
  [void][CodexMiniWin32]::GetWindowRect($hwnd, [ref]$windowRect)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $state = @{
    raw = ''
    modelLabel = ''
    reasoningLabel = ''
  }
  if ($root -eq $null) {
    $state | ConvertTo-Json -Compress
    return
  }
  $buttons = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button
    ))
  )
  $best = $null
  $bestX = -1
  foreach ($button in $buttons) {
    $rect = $button.Current.BoundingRectangle
    if ($rect.Width -lt 24 -or $rect.Height -lt 18) { continue }
    if ($rect.Y -lt ($windowRect.Bottom - 150) -or $rect.Y -gt $windowRect.Bottom) { continue }
    if ($rect.X -lt ($windowRect.Left + 250) -or $rect.X -gt $windowRect.Right) { continue }
    $name = ([string]$button.Current.Name).Trim()
    if ($name -match '^(.+?)\\s+(低|中|高|超高)$') {
      if ($rect.X -gt $bestX) {
        $best = $name
        $bestX = $rect.X
      }
    }
  }
  if ($best) {
    $parts = $best -split '\\s+'
    $state.raw = $best
    $state.reasoningLabel = $parts[$parts.Length - 1]
    $state.modelLabel = ($parts[0..($parts.Length - 2)] -join ' ')
  }
  $state | ConvertTo-Json -Compress
}

function Send-KeyChord([int[]]$keys) {
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  $events = New-Object 'CodexMiniWin32+INPUT[]' ($keys.Length * 2)
  $index = 0
  foreach ($key in $keys) {
    $events[$index].type = 1
    $events[$index].u.ki.wVk = [UInt16]$key
    $events[$index].u.ki.dwFlags = 0
    $index++
  }
  for ($i = $keys.Length - 1; $i -ge 0; $i--) {
    $events[$index].type = 1
    $events[$index].u.ki.wVk = [UInt16]$keys[$i]
    $events[$index].u.ki.dwFlags = 2
    $index++
  }
  $sent = [CodexMiniWin32]::SendInput([uint32]$events.Length, $events, [Runtime.InteropServices.Marshal]::SizeOf([type][CodexMiniWin32+INPUT]))
  if ($sent -ne $events.Length) { throw "SendInput failed: sent $sent of $($events.Length)" }
  Start-Sleep -Milliseconds 40
  Reset-KeyboardModifiers
}

function Send-UnicodeText([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return }
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  foreach ($ch in $text.ToCharArray()) {
    $events = New-Object 'CodexMiniWin32+INPUT[]' 2
    $events[0].type = 1
    $events[0].u.ki.wVk = 0
    $events[0].u.ki.wScan = [UInt16][char]$ch
    $events[0].u.ki.dwFlags = 0x0004
    $events[1].type = 1
    $events[1].u.ki.wVk = 0
    $events[1].u.ki.wScan = [UInt16][char]$ch
    $events[1].u.ki.dwFlags = 0x0004 -bor 0x0002
    $sent = [CodexMiniWin32]::SendInput([uint32]$events.Length, $events, [Runtime.InteropServices.Marshal]::SizeOf([type][CodexMiniWin32+INPUT]))
    if ($sent -ne $events.Length) { throw "SendInput text failed: sent $sent of $($events.Length)" }
    Start-Sleep -Milliseconds 5
  }
  Reset-KeyboardModifiers
}

function Send-WinFormsKeys([string]$keys, [int]$settleMs = 80) {
  Activate-CodexWindow | Out-Null
  Reset-KeyboardModifiers
  Start-Sleep -Milliseconds 35
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds $settleMs
  Reset-KeyboardModifiers
}

function Paste-TextAndEnter([string]$text) {
  Paste-TextOnly $text
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 180
  Reset-KeyboardModifiers
}

function Paste-TextAndEnterToThread([string]$url, [string]$text, [int]$settleMs) {
  if (-not [string]::IsNullOrWhiteSpace($url)) {
    Invoke-CodexLink $url
    Start-Sleep -Milliseconds $settleMs
  }
  Paste-TextAndEnter $text
}

function Paste-TextOnly([string]$text) {
  [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
  Focus-CodexProseMirrorComposer
  Reset-KeyboardModifiers
  Start-Sleep -Milliseconds 45
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 260
  Reset-KeyboardModifiers
}

function Paste-CommandSelection([string]$command, [string]$selection, [int]$commandSettleMs, [int]$selectionSettleMs) {
  Paste-TextOnly $command
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 180
  Reset-KeyboardModifiers
  Start-Sleep -Milliseconds $commandSettleMs
  Paste-TextOnly $selection
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 180
  Reset-KeyboardModifiers
  Start-Sleep -Milliseconds $selectionSettleMs
}

function Convert-Key([string]$key) {
  switch ($key.ToLowerInvariant()) {
    'enter' { return 0x0D }
    'esc' { return 0x1B }
    'escape' { return 0x1B }
    '.' { return 0xBE }
    default {
      if ($key.Length -eq 1) { return [int][char]$key.ToUpperInvariant() }
      throw "Unsupported key: $key"
    }
  }
}
`;

const PS_HELPER_LOOP = `
$ProgressPreference = 'SilentlyContinue'
function Write-CodexMiniResponse([object]$payload) {
  [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 12))
  [Console]::Out.Flush()
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $request = $null
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = $request.id
    $action = [string]$request.action
    $result = @{}
    switch ($action) {
      'ping' {
      }
      'invokeLink' {
        Invoke-CodexLink ([string]$request.deepLink)
      }
      'activate' {
        Activate-CodexWindow | Out-Null
      }
      'focusComposer' {
        Focus-CodexComposer
      }
      'primeComposer' {
        Prime-CodexComposerFocus | Out-Null
      }
      'setClipboardText' {
        [System.Windows.Forms.Clipboard]::SetText([string]$request.text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
      }
      'getClipboardText' {
        $text = ''
        try {
          if ([System.Windows.Forms.Clipboard]::ContainsText()) { $text = [System.Windows.Forms.Clipboard]::GetText() }
        } catch {}
        $result.text = [string]$text
      }
      'copyImage' {
        $img = [System.Drawing.Image]::FromFile([string]$request.filePath)
        try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
      }
      'pasteTextAndEnter' {
        Paste-TextAndEnter ([string]$request.text)
      }
      'pasteTextAndEnterToThread' {
        Paste-TextAndEnterToThread ([string]$request.deepLink) ([string]$request.text) ([int]$request.settleMs)
      }
      'pasteTextOnly' {
        Paste-TextOnly ([string]$request.text)
      }
      'commandSelection' {
        Paste-CommandSelection ([string]$request.command) ([string]$request.selection) ([int]$request.commandSettleMs) ([int]$request.selectionSettleMs)
      }
      'pressPaste' {
        Send-WinFormsKeys '^v' 140
      }
      'pressEnter' {
        Send-WinFormsKeys '{ENTER}' 120
      }
      'pressShortcut' {
        $keys = @()
        foreach ($value in $request.keys) { $keys += [int]$value }
        Send-KeyChord $keys
      }
      'pressCancel' {
        Send-WinFormsKeys '{ESC}' 100
        Start-Sleep -Milliseconds 80
        Send-WinFormsKeys '^.' 160
        Start-Sleep -Milliseconds 160
        Click-CodexComposerActionButton
      }
      'getToolbarState' {
        $json = Get-CodexToolbarState
        $result = $json | ConvertFrom-Json
      }
      'snapshotClipboard' {
        $meta = @{ type = 'empty' }
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
          [System.IO.File]::WriteAllText(([string]$request.textFile), [System.Windows.Forms.Clipboard]::GetText(), (New-Object System.Text.UTF8Encoding($false)))
          $meta.type = 'text'
        } elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
          $img = [System.Windows.Forms.Clipboard]::GetImage()
          if ($img -ne $null) {
            $img.Save(([string]$request.imageFile), [System.Drawing.Imaging.ImageFormat]::Png)
            $img.Dispose()
            $meta.type = 'image'
          }
        } elseif ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
          $files = @()
          foreach ($item in [System.Windows.Forms.Clipboard]::GetFileDropList()) { $files += [string]$item }
          $meta.type = 'files'
          $meta.files = $files
        }
        [System.IO.File]::WriteAllText(([string]$request.metaFile), ($meta | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
      }
      'restoreClipboard' {
        $meta = [System.IO.File]::ReadAllText(([string]$request.metaFile)) | ConvertFrom-Json
        if ($meta.type -eq 'text') {
          $text = [System.IO.File]::ReadAllText(([string]$request.textFile))
          [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
        } elseif ($meta.type -eq 'image') {
          $img = [System.Drawing.Image]::FromFile([string]$request.imageFile)
          try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
        } elseif ($meta.type -eq 'files') {
          $list = New-Object System.Collections.Specialized.StringCollection
          foreach ($file in $meta.files) { [void]$list.Add([string]$file) }
          [System.Windows.Forms.Clipboard]::SetFileDropList($list)
        } else {
          [System.Windows.Forms.Clipboard]::Clear()
        }
      }
      default {
        throw "Unsupported helper action: $action"
      }
    }
    Write-CodexMiniResponse @{ id = $id; ok = $true; result = $result }
  } catch {
    Write-CodexMiniResponse @{ id = $id; ok = $false; error = [string]($_.Exception.Message) }
  }
}
`;

function runPowerShell(script, input, options = {}) {
  return new Promise((resolve, reject) => {
    const timeoutMs = Number(options.timeoutMs || process.env.CODEX_MAX_WIN32_POWERSHELL_TIMEOUT_MS || process.env.CODEX_MINI_WIN32_POWERSHELL_TIMEOUT_MS || 12000);
    let settled = false;
    const child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `${PS_PREAMBLE}\n${script}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      finish(() => {
        try { child.kill(); } catch {}
        reject(Object.assign(new Error(`Windows 自动化超时（${timeoutMs}ms）。`), { code: 'WIN32_AUTOMATION_TIMEOUT', stdout, stderr }));
      });
    }, timeoutMs) : null;
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(Object.assign(new Error(stderr.trim() || stdout.trim() || `powershell.exe exited with code ${code}`), { code, stdout, stderr }));
      });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function createPowerShellHelper() {
  let child = null;
  let nextId = 1;
  let buffer = '';
  const pending = new Map();

  function rejectAll(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function stop() {
    const current = child;
    child = null;
    buffer = '';
    if (current && current.exitCode === null && !current.killed) {
      try { current.kill(); } catch {}
    }
    rejectAll(new Error('Windows helper stopped.'));
  }

  function ensureStarted() {
    if (child && child.exitCode === null && !child.killed) return child;
    child = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `${PS_PREAMBLE}\n${PS_HELPER_LOOP}`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.ok) item.resolve(message.result || {});
        else item.reject(new Error(message.error || 'Windows helper action failed.'));
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', error => {
      const failed = child;
      if (failed === child) child = null;
      rejectAll(error);
    });
    child.on('exit', () => {
      child = null;
      rejectAll(new Error('Windows helper exited.'));
    });
    return child;
  }

  function sendAction(action, payload = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs || process.env.CODEX_MAX_WIN32_HELPER_TIMEOUT_MS || process.env.CODEX_MINI_WIN32_HELPER_TIMEOUT_MS || 8000);
    return new Promise((resolve, reject) => {
      const proc = ensureStarted();
      const id = nextId++;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Windows helper timeout (${timeoutMs}ms): ${action}`));
      }, timeoutMs) : null;
      pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`);
      } catch (error) {
        pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  return { sendAction, stop };
}

function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function win32KeyCode(key) {
  const normalized = String(key || '').toLowerCase();
  if (normalized === 'enter') return 0x0D;
  if (normalized === 'esc' || normalized === 'escape') return 0x1B;
  if (normalized === '.') return 0xBE;
  if (normalized.length === 1) return normalized.toUpperCase().charCodeAt(0);
  throw new Error(`Unsupported key: ${key}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

async function runPowerShellJson(script, timeoutMs = 12000) {
  const { stdout } = await runPowerShell(`${script}
`, '', { timeoutMs });
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw makeError(`PowerShell returned invalid JSON: ${error.message}`, 'WIN32_BAD_JSON');
  }
}

function normalizeHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHost(hostname) {
  const host = normalizeHost(hostname);
  if (host === 'localhost' || host === '::1') return true;
  return net.isIP(host) === 4 && host.startsWith('127.');
}

function validateCdpHost(host) {
  const normalized = String(host || '').trim();
  if (!isLoopbackHost(normalized)) {
    throw makeError('CDP host must be a loopback address.', 'CDP_INVALID_HOST');
  }
  return normalized;
}

function validateCodexDeepLink(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw makeError('Codex deep link is invalid.', 'CODEX_DEEPLINK_INVALID');
  }
  if (parsed.protocol !== 'codex:' || parsed.hostname !== 'threads') {
    throw makeError('Codex deep link must target a Codex thread route.', 'CODEX_DEEPLINK_INVALID');
  }
  if (!/^\/(new|[a-f0-9]{8}-[a-f0-9-]{27,})$/i.test(parsed.pathname)) {
    throw makeError('Codex deep link path is not allowed.', 'CODEX_DEEPLINK_INVALID');
  }
  return parsed.toString();
}

function validateCdpPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw makeError('CDP port must be between 1 and 65535.', 'CDP_INVALID_PORT');
  }
  return value;
}

function validateCdpUrl(value, scheme, expectedHost, expectedPort) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw makeError('CDP returned an invalid WebSocket URL.', 'CDP_INVALID_WS_URL');
  }
  if (parsed.protocol !== `${scheme}:` || !isLoopbackHost(parsed.hostname)) {
    throw makeError('CDP WebSocket URL must use a loopback host.', 'CDP_INVALID_WS_URL');
  }
  if (expectedHost && parsed.hostname.toLowerCase() !== String(expectedHost).toLowerCase()) {
    throw makeError('CDP WebSocket URL host does not match the configured host.', 'CDP_INVALID_WS_URL');
  }
  const port = validateCdpPort(parsed.port || (scheme === 'wss' ? 443 : 80));
  if (expectedPort && port !== expectedPort) {
    throw makeError('CDP WebSocket URL port does not match the configured port.', 'CDP_INVALID_WS_URL');
  }
  return parsed;
}

function cdpJson(host, port, pathname, timeoutMs = 1800) {
  const safeHost = validateCdpHost(host);
  const safePort = validateCdpPort(port);
  const safePath = String(pathname || '');
  if (!/^\/json\/(list|version)$/.test(safePath)) {
    throw makeError('CDP HTTP path is not allowed.', 'CDP_INVALID_URL');
  }
  return new Promise((resolve, reject) => {
    const cdpRequest = http.get({
      protocol: 'http:',
      hostname: normalizeHost(safeHost),
      port: safePort,
      path: safePath,
      timeout: timeoutMs,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(makeError(`CDP HTTP ${response.statusCode}: ${safePath}`, 'CDP_HTTP_FAILED'));
          return;
        }
        try {
          resolve(JSON.parse(body || 'null'));
        } catch (error) {
          reject(makeError(`CDP returned invalid JSON: ${error.message}`, 'CDP_BAD_JSON'));
        }
      });
    });
    cdpRequest.on('timeout', () => {
      cdpRequest.destroy(makeError(`CDP HTTP timed out: ${safePath}`, 'CDP_TIMEOUT'));
    });
    cdpRequest.on('error', reject);
  });
}

function encodeWsFrame(text) {
  const payload = Buffer.from(String(text), 'utf8');
  const headerLength = payload.length < 126 ? 6 : payload.length <= 0xffff ? 8 : 14;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x81;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
    crypto.randomBytes(4).copy(frame, 2);
    for (let i = 0; i < payload.length; i += 1) frame[6 + i] = payload[i] ^ frame[2 + (i % 4)];
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
    crypto.randomBytes(4).copy(frame, 4);
    for (let i = 0; i < payload.length; i += 1) frame[8 + i] = payload[i] ^ frame[4 + (i % 4)];
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
    crypto.randomBytes(4).copy(frame, 10);
    for (let i = 0; i < payload.length; i += 1) frame[14 + i] = payload[i] ^ frame[10 + (i % 4)];
  }
  return frame;
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw makeError('CDP WebSocket frame is too large.', 'CDP_FRAME_TOO_LARGE');
      length = Number(bigLength);
      headerLength = 10;
    }
    const maskOffset = offset + headerLength;
    const payloadOffset = maskOffset + (masked ? 4 : 0);
    const frameEnd = payloadOffset + length;
    if (buffer.length < frameEnd) break;
    let payload = buffer.subarray(payloadOffset, frameEnd);
    if (masked) {
      const mask = buffer.subarray(maskOffset, maskOffset + 4);
      const unmasked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) unmasked[i] = payload[i] ^ mask[i % 4];
      payload = unmasked;
    }
    frames.push({ opcode, text: payload.toString('utf8') });
    offset = frameEnd;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class RawCdpSocket {
  constructor(wsUrl, timeoutMs = 3000, expectedHost = null, expectedPort = null) {
    this.wsUrl = validateCdpUrl(wsUrl, 'ws', expectedHost, expectedPort);
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.connected = false;
  }

  async connect() {
    if (this.connected) return this;
    const port = validateCdpPort(this.wsUrl.port || 80);
    this.socket = net.createConnection({ host: this.wsUrl.hostname, port });
    this.socket.setNoDelay(true);
    await new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const timer = setTimeout(() => {
        cleanup();
        reject(makeError('CDP WebSocket handshake timed out.', 'CDP_TIMEOUT'));
      }, this.timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('error', onError);
        this.socket.off('data', onData);
      };
      const onError = error => {
        cleanup();
        reject(error);
      };
      const onData = chunk => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = this.buffer.subarray(0, headerEnd).toString('utf8');
        if (!/^HTTP\/1\.[01] 101\b/.test(header)) {
          cleanup();
          reject(makeError(`CDP WebSocket handshake failed: ${header.split('\r\n')[0] || 'no response'}`, 'CDP_WS_FAILED'));
          return;
        }
        this.buffer = this.buffer.subarray(headerEnd + 4);
        cleanup();
        resolve();
      };
      this.socket.on('error', onError);
      this.socket.on('data', onData);
      this.socket.write([
        `GET ${this.wsUrl.pathname}${this.wsUrl.search} HTTP/1.1`,
        `Host: ${this.wsUrl.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
    this.connected = true;
    this.socket.on('data', chunk => this.handleData(chunk));
    this.socket.on('error', error => this.failAll(error));
    this.socket.on('close', () => this.failAll(makeError('CDP WebSocket closed.', 'CDP_CLOSED')));
    if (this.buffer.length) {
      const existing = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.handleData(existing);
    }
    return this;
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let decoded;
    try {
      decoded = decodeWsFrames(this.buffer);
    } catch (error) {
      this.failAll(error);
      this.close();
      return;
    }
    this.buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode !== 0x1) continue;
      let message;
      try {
        message = JSON.parse(frame.text);
      } catch {
        continue;
      }
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(makeError(message.error.message || 'CDP command failed.', 'CDP_COMMAND_FAILED'));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  send(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.socket || !this.connected) return Promise.reject(makeError('CDP WebSocket is not connected.', 'CDP_NOT_CONNECTED'));
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeError(`CDP command timed out: ${method}`, 'CDP_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeWsFrame(payload), error => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  failAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  close() {
    this.connected = false;
    if (this.socket) {
      try { this.socket.end(); } catch {}
      try { this.socket.destroy(); } catch {}
    }
  }
}

function jsString(value) {
  return JSON.stringify(String(value || ''));
}

function createCodexCdpController(options = {}) {
  const port = validateCdpPort(process.env.CODEX_MAX_CDP_PORT || process.env.CODEX_MINI_CDP_PORT || options.port || 9222);
  const host = validateCdpHost(process.env.CODEX_MAX_CDP_HOST || process.env.CODEX_MINI_CDP_HOST || '127.0.0.1');
  const baseUrl = `http://${host}:${port}`;
  const timeoutMs = Number(process.env.CODEX_MAX_CDP_TIMEOUT_MS || process.env.CODEX_MINI_CDP_TIMEOUT_MS || 4500);

  async function getTarget() {
    const targets = await cdpJson(host, port, '/json/list', Math.min(timeoutMs, 2500));
    const rows = Array.isArray(targets) ? targets : [];
    const target = rows.find(item => item.type === 'page' && /^app:\/\/-\/index\.html/.test(String(item.url || ''))) ||
      rows.find(item => item.type === 'page' && String(item.title || '').toLowerCase().includes('codex')) ||
      rows.find(item => item.type === 'page');
    if (!target || !target.webSocketDebuggerUrl) {
      throw makeError('CDP 已连接，但没有找到 Codex 页面 target。请用 --remote-debugging-port 重启 Codex Desktop。', 'CDP_TARGET_MISSING');
    }
    return target;
  }

  async function withPage(fn) {
    const target = await getTarget();
    const socketUrl = validateCdpUrl(target.webSocketDebuggerUrl, 'ws', host, port);
    const socket = await new RawCdpSocket(socketUrl.toString(), timeoutMs, host, port).connect();
    try {
      await socket.send('Runtime.enable', {}, timeoutMs);
      return await fn(socket, target);
    } finally {
      socket.close();
    }
  }

  async function evaluateOnSocket(socket, expression, timeout = timeoutMs) {
    const result = await socket.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeout);
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'CDP JavaScript evaluation failed.';
      throw makeError(text, 'CDP_EVALUATE_FAILED');
    }
    return result.result ? result.result.value : undefined;
  }

  async function dispatchMouseClick(socket, rect) {
    const x = Number(rect && rect.x) + (Number(rect && rect.w) / 2);
    const y = Number(rect && rect.y) + (Number(rect && rect.h) / 2);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw makeError('CDP 鼠标点击坐标无效。', 'CDP_BAD_RECT');
    }
    await socket.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
    }, timeoutMs);
    await socket.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    }, timeoutMs);
    await socket.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    }, timeoutMs);
  }

  async function evaluate(expression, timeout = timeoutMs) {
    return withPage(socket => evaluateOnSocket(socket, expression, timeout));
  }

  async function probe() {
    try {
      const version = await cdpJson(host, port, '/json/version', Math.min(timeoutMs, 1800));
      const target = await getTarget();
      return {
        available: true,
        port,
        browser: version.Browser || '',
        targetTitle: target.title || '',
        targetUrl: target.url || '',
      };
    } catch (error) {
      return {
        available: false,
        port,
        // 连接类错误统一归为 CDP_UNAVAILABLE，避免把网络错误码暴露给客户端
        code: /ECONNREFUSED|EHOSTUNREACH|ENOTFOUND|ETIMEDOUT|ECONNRESET/.test(error.code || '') ? 'CDP_UNAVAILABLE' : (error.code || 'CDP_UNAVAILABLE'),
        message: error.message || 'CDP 不可用。',
      };
    }
  }

  async function launchCodexCdp(options = {}) {
    const forceRestart = options.forceRestart !== false;
    const waitMs = Math.max(1000, Number(options.waitMs || process.env.CODEX_MAX_CDP_LAUNCH_WAIT_MS || 20000));
    const current = await probe();
    if (current.available && !forceRestart) {
      return {
        ok: true,
        restarted: false,
        alreadyAvailable: true,
        port,
        cdp: current,
        message: 'Codex 已经处于 CDP 受控模式。',
      };
    }

    const forceLiteral = forceRestart ? '$true' : '$false';
    const ps = `
$port = ${port}
$forceRestart = ${forceLiteral}
function Resolve-CodexExe {
  $process = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq 'Codex.exe' -and $_.ExecutablePath } |
    Select-Object -First 1
  if ($process -and (Test-Path -LiteralPath $process.ExecutablePath)) {
    return $process.ExecutablePath
  }

  $pkg = Get-AppxPackage OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pkg) {
    $candidate = Join-Path $pkg.InstallLocation 'app\\Codex.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\\Codex\\Codex.exe'),
    (Join-Path $env:LOCALAPPDATA 'OpenAI\\Codex\\Codex.exe'),
    (Join-Path $env:ProgramFiles 'Codex\\Codex.exe')
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw '没有找到 Codex.exe。请先安装或启动一次 Codex Desktop。'
}
function Get-CodexProcesses {
  @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ieq 'Codex.exe' })
}

$existing = @(Get-CodexProcesses)
$exe = Resolve-CodexExe
$stopped = @()
if ($existing.Count -gt 0) {
  if (-not $forceRestart) {
    [PSCustomObject]@{
      ok = $false
      needsRestart = $true
      message = 'Codex 已经运行；需要重启才能附加 CDP 参数。'
      existingProcessIds = @($existing | ForEach-Object { $_.ProcessId })
    } | ConvertTo-Json -Depth 5 -Compress
    exit 0
  }
  foreach ($proc in $existing) {
    $stopped += $proc.ProcessId
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 1200
}

$argsList = @(
  "--remote-debugging-port=$port",
  "--remote-allow-origins=http://127.0.0.1:$port"
)
$started = Start-Process -FilePath $exe -ArgumentList $argsList -PassThru
[PSCustomObject]@{
  ok = $true
  exe = $exe
  port = $port
  processId = $started.Id
  stoppedProcessIds = $stopped
  arguments = $argsList
} | ConvertTo-Json -Depth 5 -Compress
`;
    const launch = await runPowerShellJson(ps, 15000);
    if (!launch || launch.ok === false) {
      throw makeError(launch?.message || '没有启动 Codex CDP 受控版本。', 'CDP_LAUNCH_FAILED');
    }

    const startedAt = Date.now();
    let lastProbe = null;
    while (Date.now() - startedAt <= waitMs) {
      await delay(500);
      lastProbe = await probe();
      if (lastProbe.available) {
        return {
          ok: true,
          restarted: Boolean(forceRestart),
          alreadyAvailable: false,
          port,
          launch,
          cdp: lastProbe,
          message: '已启动 Codex CDP 受控版本。',
        };
      }
    }

    const error = makeError(lastProbe?.message || 'Codex 已启动，但 CDP 页面 target 没有在限定时间内就绪。', 'CDP_LAUNCH_PROBE_FAILED');
    error.launch = launch;
    error.cdp = lastProbe;
    throw error;
  }

  async function activateThread(threadId = '', deepLink = '', settleMs = 700) {
    if (deepLink) {
      await evaluate(`location.href = ${jsString(deepLink)}; true`, timeoutMs);
      await delay(settleMs);
    }
  }

  async function clickNewThreadForProject(cwd = '', fallbackDeepLink = '', settleMs = 900) {
    const result = await evaluate(`(() => {
      const cwd = ${jsString(cwd)};
      const normPath = value => String(value || '').replace(/\\\\/g, '/').replace(/\\/+$/g, '').toLowerCase();
      const projectName = cwd ? cwd.split(/[\\\\/]+/).filter(Boolean).pop() : '';
      const labels = projectName ? [
        '在 ' + projectName + ' 中开始新对话',
        '在 ' + projectName + ' 中开始新對話',
        'Start new chat in ' + projectName,
        'Start new thread in ' + projectName
      ] : [];
      const buttons = [...document.querySelectorAll('button')];
      let btn = null;
      if (labels.length) {
        btn = buttons.find(el => labels.includes(el.getAttribute('aria-label') || ''));
      }
      if (!btn && cwd) {
        const wanted = normPath(cwd);
        const projects = [...document.querySelectorAll('[role="listitem"]')];
        const row = projects.find(el => normPath(el.innerText || el.getAttribute('aria-label') || '').includes(wanted) || (projectName && (el.getAttribute('aria-label') || '').trim() === projectName));
        if (row) btn = [...row.querySelectorAll('button')].find(el => /开始新|Start new/i.test(el.getAttribute('aria-label') || ''));
      }
      if (!btn) return { ok: false, reason: 'project new-thread button not found', projectName };
      btn.click();
      return { ok: true, aria: btn.getAttribute('aria-label') || '', projectName };
    })()`, timeoutMs);
    if (!result || !result.ok) {
      if (!fallbackDeepLink) throw makeError(result?.reason || '没有找到项目的新对话按钮。', 'CDP_PROJECT_BUTTON_MISSING');
      await evaluate(`location.href = ${jsString(fallbackDeepLink)}; true`, timeoutMs);
    }
    await delay(settleMs);
    return result || { ok: true };
  }

  async function newProjectlessThread(fallbackDeepLink = '', settleMs = 900) {
    const result = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const btn = buttons.find(el => /^(新对话|新對話|New chat|New thread)/i.test((el.innerText || '').trim())) ||
        buttons.find(el => /new.*(chat|thread)|新对话|新對話/i.test(el.getAttribute('aria-label') || ''));
      if (!btn) return { ok: false, reason: 'global new-thread button not found' };
      btn.click();
      return { ok: true, text: btn.innerText || '', aria: btn.getAttribute('aria-label') || '' };
    })()`, timeoutMs);
    if ((!result || !result.ok) && fallbackDeepLink) {
      await evaluate(`location.href = ${jsString(fallbackDeepLink)}; true`, timeoutMs);
    } else if (!result || !result.ok) {
      throw makeError(result?.reason || '没有找到新对话按钮。', 'CDP_NEW_THREAD_BUTTON_MISSING');
    }
    await delay(settleMs);
    return result || { ok: true };
  }

  async function focusComposer() {
    const result = await evaluate(`(() => {
      const composer = document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror');
      if (!composer) return { ok: false, reason: 'composer not found' };
      composer.focus();
      return { ok: true, text: (composer.innerText || '').trim() };
    })()`, timeoutMs);
    if (!result || !result.ok) throw makeError(result?.reason || '没有找到 Codex 输入框。', 'CDP_COMPOSER_MISSING');
    return result;
  }

  async function insertText(text) {
    await focusComposer();
    return withPage(async socket => {
      await socket.send('Input.insertText', { text: String(text || '') }, timeoutMs);
      await delay(120);
      const result = await socket.send('Runtime.evaluate', {
        expression: `(() => {
          const composer = document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror');
          return { ok: Boolean(composer), text: composer ? (composer.innerText || '').trim() : '' };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      }, timeoutMs);
      return result.result ? result.result.value : null;
    });
  }

  async function clickSend() {
    const result = await evaluate(`(() => {
      const composer = document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror');
      const cr = composer && composer.getBoundingClientRect();
      if (!cr) return { ok: false, reason: 'composer not found' };
      const buttons = [...document.querySelectorAll('button')].map((button, index) => ({ button, index, rect: button.getBoundingClientRect() }));
      let candidate = buttons
        .filter(item => item.rect.width >= 20 && item.rect.height >= 20)
        .filter(item => item.rect.top >= cr.bottom - 90 && item.rect.top <= cr.bottom + 95 && item.rect.left > cr.left)
        .filter(item => !item.button.disabled && item.button.getAttribute('aria-disabled') !== 'true')
        .sort((a, b) => b.rect.left - a.rect.left)[0];
      if (!candidate) {
        candidate = buttons
          .filter(item => !item.button.disabled && item.button.getAttribute('aria-disabled') !== 'true')
          .filter(item => /发送|Send/i.test(item.button.getAttribute('aria-label') || item.button.title || item.button.innerText || ''))
          .sort((a, b) => b.rect.left - a.rect.left)[0];
      }
      if (!candidate) return { ok: false, reason: 'send button not found' };
      candidate.button.click();
      return {
        ok: true,
        index: candidate.index,
        aria: candidate.button.getAttribute('aria-label') || '',
        text: candidate.button.innerText || ''
      };
    })()`, timeoutMs);
    if (!result || !result.ok) throw makeError(result?.reason || '没有找到发送按钮。', 'CDP_SEND_BUTTON_MISSING');
    return result;
  }

  async function switchReasoningMode(targetKey = '') {
    const aliases = {
      low: 'low',
      '低': 'low',
      medium: 'medium',
      med: 'medium',
      normal: 'medium',
      '中': 'medium',
      high: 'high',
      '高': 'high',
      xhigh: 'xhigh',
      'x-high': 'xhigh',
      ultra: 'xhigh',
      max: 'xhigh',
      '超高': 'xhigh',
    };
    const labels = {
      low: '低',
      medium: '中',
      high: '高',
      xhigh: '超高',
    };
    const raw = String(targetKey || '').trim();
    const key = aliases[raw.toLowerCase()] || aliases[raw] || raw.toLowerCase();
    const label = labels[key];
    if (!label) throw makeError(`不支持的推理等级：${raw || '(empty)'}`, 'CDP_BAD_REASONING_TARGET');

    return withPage(async socket => {
      const trigger = await evaluateOnSocket(socket, `(() => {
        const button = document.querySelector('[data-codex-intelligence-trigger="true"]');
        if (!button) return { ok: false, reason: 'reasoning trigger not found' };
        const rect = button.getBoundingClientRect();
        return {
          ok: true,
          text: (button.innerText || button.textContent || '').trim(),
          selected: button.getAttribute('data-selected-reasoning-effort') || '',
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        };
      })()`);
      if (!trigger || !trigger.ok) {
        throw makeError(trigger?.reason || '没有找到 Codex 推理等级按钮。', 'CDP_REASONING_TRIGGER_MISSING');
      }

      await dispatchMouseClick(socket, trigger.rect);
      await delay(250);

      const item = await evaluateOnSocket(socket, `(() => {
        const label = ${jsString(label)};
        const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const items = [...document.querySelectorAll('[role="menuitem"]')];
        const match = items.find(el => normalize(el.innerText || el.textContent) === label);
        if (!match) {
          return {
            ok: false,
            reason: 'reasoning menu item not found',
            menuText: normalize([...document.querySelectorAll('[role="menu"]')].map(el => el.innerText || '').join('\\n'))
          };
        }
        const rect = match.getBoundingClientRect();
        return {
          ok: true,
          text: normalize(match.innerText || match.textContent),
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        };
      })()`);
      if (!item || !item.ok) {
        throw makeError(item?.reason || '没有找到目标推理等级菜单项。', 'CDP_REASONING_ITEM_MISSING');
      }

      await dispatchMouseClick(socket, item.rect);
      await delay(450);

      const selected = await evaluateOnSocket(socket, `(() => {
        const button = document.querySelector('[data-codex-intelligence-trigger="true"]');
        if (!button) return { ok: false, reason: 'reasoning trigger missing after click' };
        return {
          ok: true,
          selected: button.getAttribute('data-selected-reasoning-effort') || '',
          text: (button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim()
        };
      })()`);
      if (!selected || !selected.ok) {
        throw makeError(selected?.reason || '切换后没有读到推理等级状态。', 'CDP_REASONING_VERIFY_FAILED');
      }
      if (selected.selected !== key && !String(selected.text || '').includes(label)) {
        throw makeError(`推理等级切换后验证失败：当前 ${selected.selected || selected.text || 'unknown'}，目标 ${label}。`, 'CDP_REASONING_VERIFY_FAILED');
      }
      return {
        ok: true,
        key,
        label,
        previous: trigger.selected || trigger.text || '',
        selected: selected.selected,
        text: selected.text,
      };
    });
  }

  async function sendText(text) {
    await insertText(text);
    return clickSend();
  }

  async function pressEnter() {
    return withPage(async socket => {
      await focusComposer();
      await socket.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, timeoutMs);
      await socket.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, timeoutMs);
      return { ok: true };
    });
  }

  async function stopResponse() {
    return withPage(async socket => {
      const result = await evaluateOnSocket(socket, `(() => {
        const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = rect => rect && rect.width >= 16 && rect.height >= 16 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
        const blocked = button => button.disabled || button.getAttribute('aria-disabled') === 'true';
        const describe = button => normalize([
          button.getAttribute('aria-label'),
          button.getAttribute('title'),
          button.getAttribute('data-testid'),
          button.id,
          button.className,
          button.innerText,
          button.textContent
        ].filter(Boolean).join(' '));
        const rectOf = button => {
          const rect = button.getBoundingClientRect();
          return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        };
        const buttons = [...document.querySelectorAll('button')].map(button => ({ button, rect: rectOf(button), label: describe(button) }))
          .filter(item => visible(item.rect) && !blocked(item.button));
        const explicit = buttons.find(item => /停止|中止|终止|取消|Stop|Cancel|Interrupt|Abort/i.test(item.label));
        if (explicit) return { ok: true, via: 'explicit', rect: explicit.rect, label: explicit.label };

        const composer = document.querySelector('.ProseMirror[contenteditable="true"], .ProseMirror');
        const cr = composer ? composer.getBoundingClientRect() : null;
        const nearComposer = buttons
          .filter(item => {
            const rect = item.rect;
            if (cr) {
              return rect.top >= cr.top - 40 && rect.bottom <= cr.bottom + 120 && rect.left >= cr.left + (cr.width * 0.45);
            }
            return rect.bottom >= innerHeight - 180 && rect.left >= innerWidth * 0.45;
          })
          .filter(item => !/模型|推理|GPT|添加|文件|自定义|低|中|高|超高|model|reason|attach|file/i.test(item.label))
          .sort((a, b) => b.rect.left - a.rect.left || b.rect.top - a.rect.top);
        const candidate = nearComposer.find(item => item.rect.w <= 72 && item.rect.h <= 72) || nearComposer[0];
        if (candidate) return { ok: true, via: 'composer-action', rect: candidate.rect, label: candidate.label };
        return { ok: false, reason: 'stop button not found' };
      })()`);

      if (result && result.ok && result.rect) {
        await dispatchMouseClick(socket, result.rect);
        await delay(180);
        return result;
      }

      await socket.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
        key: 'Escape',
        code: 'Escape',
      }, timeoutMs);
      await socket.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
        key: 'Escape',
        code: 'Escape',
      }, timeoutMs);
      return { ok: true, via: 'escape', reason: result?.reason || 'stop button not found' };
    });
  }

  async function captureScreenshot() {
    return withPage(async (socket) => {
      const result = await socket.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        fromSurface: true,
      }, timeoutMs);
      if (!result || typeof result.data !== 'string' || !result.data) {
        throw makeError('CDP 截图失败：未返回图像数据。', 'CDP_SCREENSHOT_EMPTY');
      }
      return { data: result.data, format: 'png', width: Number(result.width) || 0, height: Number(result.height) || 0 };
    });
  }

  return {
    port,
    baseUrl,
    probe,
    launchCodexCdp,
    activateThread,
    clickNewThreadForProject,
    newProjectlessThread,
    focusComposer,
    insertText,
    sendText,
    switchReasoningMode,
    pressEnter,
    stopResponse,
    captureScreenshot,
  };
}

function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

module.exports = function createWin32Platform(env) {
  const {
    isCodexThreadId,
    codexThreadDeepLink,
    codexNewThreadDeepLink,
    CODEX_DEEPLINK_SETTLE_MS,
    CODEX_APP_FOCUS_SETTLE_MS,
    CODEX_THREAD_SYNC_FRESH_MS,
  } = env;

  const enqueue = createQueue();
  const helper = createPowerShellHelper();
  const cdp = createCodexCdpController();
  const warmupTimer = setTimeout(() => {
    helper.sendAction('ping', {}, { timeoutMs: 6000 }).catch(() => {});
  }, 50);
  if (warmupTimer.unref) warmupTimer.unref();
  let lastCodexThreadActivation = { threadId: '', at: 0 };
  let keepAwakeProcess = null;
  let keepAwakeStartedAt = '';

  function hasFreshCodexThreadActivation(threadId) {
    return Boolean(
      isCodexThreadId(threadId) &&
      lastCodexThreadActivation.threadId === threadId &&
      Date.now() - lastCodexThreadActivation.at <= CODEX_THREAD_SYNC_FRESH_MS
    );
  }

  async function activateCodexThread(threadId = '', options = {}) {
    if (options.preferCdp !== false && !isCodexThreadId(threadId)) {
      const deepLink = codexThreadDeepLink(threadId);
      try {
        await cdp.activateThread(threadId, deepLink, CODEX_DEEPLINK_SETTLE_MS);
        if (isCodexThreadId(threadId)) lastCodexThreadActivation = { threadId, at: Date.now() };
        return;
      } catch (error) {
        if (options.requireCdp) throw error;
      }
    }

    if (options.allowCached && hasFreshCodexThreadActivation(threadId)) {
      await helper.sendAction('activate', {}, { timeoutMs: 5000 });
      await delay(CODEX_APP_FOCUS_SETTLE_MS);
      lastCodexThreadActivation = { threadId, at: Date.now() };
      return;
    }

    const deepLink = codexThreadDeepLink(threadId);
    if (deepLink) {
      await helper.sendAction('invokeLink', {
        deepLink: validateCodexDeepLink(deepLink),
      }, { timeoutMs: 5000 });
      await delay(CODEX_DEEPLINK_SETTLE_MS);
    } else {
      await helper.sendAction('invokeLink', { deepLink: validateCodexDeepLink('codex://threads/new') }, { timeoutMs: 5000 });
      await delay(CODEX_DEEPLINK_SETTLE_MS);
    }
    await helper.sendAction('activate', {}, { timeoutMs: 5000 });
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    if (isCodexThreadId(threadId)) lastCodexThreadActivation = { threadId, at: Date.now() };
  }

  async function activateNewCodexThread(cwd = '') {
    try {
      await cdp.clickNewThreadForProject(cwd, codexNewThreadDeepLink(cwd), CODEX_DEEPLINK_SETTLE_MS + 220);
      lastCodexThreadActivation = { threadId: '', at: 0 };
      return;
    } catch {}

    const deepLink = validateCodexDeepLink(codexNewThreadDeepLink(cwd));
    await helper.sendAction('invokeLink', { deepLink }, { timeoutMs: 5000 });
    await delay(CODEX_DEEPLINK_SETTLE_MS + 220);
    await helper.sendAction('activate', {}, { timeoutMs: 5000 });
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    lastCodexThreadActivation = { threadId: '', at: 0 };
  }

  async function activateNewProjectlessCodexThread() {
    try {
      await cdp.newProjectlessThread('codex://threads/new', CODEX_DEEPLINK_SETTLE_MS + 220);
      lastCodexThreadActivation = { threadId: '', at: 0 };
      return;
    } catch {}
    await activateNewCodexThread('');
  }

  async function focusTarget(target, threadId = '', options = {}) {
    if (target !== 'codex') return;
    if (options.preferCdp !== false) {
      const shouldReloadThread = options.reloadThread !== false && isCodexThreadId(threadId);
      try {
        if (shouldReloadThread) {
          await activateCodexThread(threadId, {
            allowCached: shouldReloadThread ? false : Boolean(options.assumeThreadSynced),
            requireCdp: true,
            preferCdp: true,
          });
        }
        await cdp.focusComposer();
        return;
      } catch (error) {
        if (options.requireCdp) throw error;
      }
    }
    const shouldReloadThread = options.reloadThread !== false && isCodexThreadId(threadId);
    if (shouldReloadThread && options.bounceViaNewThread) {
      await activateNewCodexThread('');
      await delay(160);
    }
    await activateCodexThread(threadId, {
      allowCached: shouldReloadThread ? false : Boolean(options.assumeThreadSynced),
    });
    if (options.skipComposerClick) {
      await helper.sendAction('primeComposer', {}, { timeoutMs: 5000 });
      return;
    }
    await helper.sendAction('focusComposer', {}, { timeoutMs: 6000 });
  }

  async function copyTextToClipboard(text) {
    await helper.sendAction('setClipboardText', { text: String(text || '') }, { timeoutMs: 4000 });
  }

  async function readClipboardText() {
    const { result = {} } = await helper.sendAction('getClipboardText', {}, { timeoutMs: 4000 });
    return String(result.text || '');
  }

  async function copyImageToClipboard(file) {
    const filePath = file && file.filePath;
    if (!filePath || !fs.existsSync(filePath)) throw new Error(`图片文件不存在：${filePath || ''}`);
    await helper.sendAction('copyImage', { filePath }, { timeoutMs: 6000 });
  }

  async function typeText(text) {
    await runPowerShell(`Send-UnicodeText ${psLiteral(String(text || ''))}`);
  }

  async function pasteTextAndEnter(text) {
    try {
      await cdp.sendText(String(text || ''));
      return;
    } catch {}
    await helper.sendAction('pasteTextAndEnter', { text: String(text || '') }, { timeoutMs: 6000 });
  }

  async function pasteTextAndEnterToThread(threadId, text) {
    const deepLink = codexThreadDeepLink(threadId);
    if (!isCodexThreadId(threadId)) {
      try {
        await cdp.sendText(String(text || ''));
        return;
      } catch {}
    }
    if (!deepLink) {
      await pasteTextAndEnter(text);
      return;
    }
    await helper.sendAction('pasteTextAndEnterToThread', {
      deepLink: validateCodexDeepLink(deepLink),
      text: String(text || ''),
      settleMs: CODEX_DEEPLINK_SETTLE_MS,
    }, { timeoutMs: Math.max(8000, CODEX_DEEPLINK_SETTLE_MS + 5000) });
    lastCodexThreadActivation = { threadId, at: Date.now() };
  }

  async function pasteTextOnly(text) {
    try {
      await cdp.focusComposer();
      await cdp.insertText(String(text || ''));
      return;
    } catch {}
    await helper.sendAction('pasteTextOnly', { text: String(text || '') }, { timeoutMs: 6000 });
  }

  async function runCodexCommandSelection(command, selection, options = {}) {
    await helper.sendAction('commandSelection', {
      command: String(command || ''),
      selection: String(selection || ''),
      commandSettleMs: Number(options.commandSettleMs || 700),
      selectionSettleMs: Number(options.selectionSettleMs || 700),
    }, { timeoutMs: Number(options.timeoutMs || 9000) });
  }

  async function pressPaste() {
    await helper.sendAction('pressPaste', {}, { timeoutMs: 5000 });
  }

  async function pressEnter() {
    try {
      await cdp.pressEnter();
      return;
    } catch {}
    await helper.sendAction('pressEnter', {}, { timeoutMs: 5000 });
  }

  async function pressCodexShortcut(key, modifiers = []) {
    const codes = [];
    for (const modifier of modifiers) {
      const normalized = String(modifier || '').toLowerCase();
      if (normalized === 'command' || normalized === 'control' || normalized === 'ctrl') codes.push(0x11);
      else if (normalized === 'shift') codes.push(0x10);
      else if (normalized === 'option' || normalized === 'alt') codes.push(0x12);
    }
    codes.push(win32KeyCode(key));
    await helper.sendAction('pressShortcut', { keys: codes }, { timeoutMs: 5000 });
  }

  async function pressCancelCodexResponse() {
    try {
      await cdp.stopResponse();
      return;
    } catch {}
    await helper.sendAction('pressCancel', {}, { timeoutMs: 7000 });
  }

  async function switchReasoningMode(targetKey) {
    return cdp.switchReasoningMode(targetKey);
  }

  async function cdpStatus() {
    return cdp.probe();
  }

  async function captureCdpScreenshot() {
    return cdp.captureScreenshot();
  }

  async function launchCodexCdp(options = {}) {
    return cdp.launchCodexCdp(options);
  }

  async function getToolbarState() {
    return helper.sendAction('getToolbarState', {}, { timeoutMs: 5000 });
  }

  async function snapshotClipboard() {
    const dir = path.join(os.tmpdir(), `codex-max-clipboard-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, 'meta.json');
    const textFile = path.join(dir, 'text.txt');
    const imageFile = path.join(dir, 'image.png');
    await helper.sendAction('snapshotClipboard', { metaFile, textFile, imageFile }, { timeoutMs: 5000 });
    return { dir, metaFile, textFile, imageFile };
  }

  async function restoreClipboard(snapshot) {
    if (!snapshot || !fs.existsSync(snapshot.metaFile)) return;
    await helper.sendAction('restoreClipboard', {
      metaFile: snapshot.metaFile,
      textFile: snapshot.textFile,
      imageFile: snapshot.imageFile,
    }, { timeoutMs: 5000 });
  }

  async function withClipboardPreserved(fn) {
    return enqueue(async () => {
      const snapshot = await snapshotClipboard();
      try {
        return await fn();
      } finally {
        await delay(Number(process.env.CODEX_MAX_WIN32_CLIPBOARD_RESTORE_DELAY_MS || process.env.CODEX_MINI_WIN32_CLIPBOARD_RESTORE_DELAY_MS || 900));
        try { await restoreClipboard(snapshot); } finally { fs.rmSync(snapshot.dir, { recursive: true, force: true }); }
      }
    });
  }

  async function runExclusive(fn) {
    return enqueue(fn);
  }

  function keepAwakeStatus() {
    const enabled = Boolean(keepAwakeProcess && keepAwakeProcess.exitCode === null && !keepAwakeProcess.killed);
    return {
      enabled,
      startedAt: enabled ? keepAwakeStartedAt : '',
      command: 'SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED)',
    };
  }

  function startKeepAwake() {
    return enqueue(async () => {
      const current = keepAwakeStatus();
      if (current.enabled) return current;
      const script = `${PS_PREAMBLE}
        # PowerShell parses 0x80000000 as Int32 (-2147483648). The P/Invoke
        # signature expects UInt32, so use the positive decimal value.
        $ES_CONTINUOUS = [uint32]2147483648
        $ES_SYSTEM_REQUIRED = 0x00000001
        $ES_DISPLAY_REQUIRED = 0x00000002
        [void][CodexMiniWin32]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED)
        while ($true) {
          Start-Sleep -Seconds 45
          [void][CodexMiniWin32]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_DISPLAY_REQUIRED)
        }
      `;
      keepAwakeProcess = spawn('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '-'
      ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      keepAwakeProcess.stdin.end(script);
      keepAwakeStartedAt = new Date().toISOString();
      keepAwakeProcess.on('exit', () => {
        keepAwakeProcess = null;
        keepAwakeStartedAt = '';
      });
      keepAwakeProcess.on('error', () => {
        keepAwakeProcess = null;
        keepAwakeStartedAt = '';
      });
      return keepAwakeStatus();
    });
  }

  function stopKeepAwake() {
    return enqueue(async () => {
      const child = keepAwakeProcess;
      keepAwakeProcess = null;
      keepAwakeStartedAt = '';
      if (child && child.exitCode === null && !child.killed) {
        try { child.kill(); } catch {}
      }
      await runPowerShell(`
        $ES_CONTINUOUS = [uint32]2147483648
        [void][CodexMiniWin32]::SetThreadExecutionState($ES_CONTINUOUS)
      `);
      return keepAwakeStatus();
    });
  }

  function cleanup() {
    helper.stop();
    const child = keepAwakeProcess;
    keepAwakeProcess = null;
    keepAwakeStartedAt = '';
    if (child && child.exitCode === null && !child.killed) {
      try { child.kill(); } catch {}
    }
  }

  return {
    name: 'win32',
    focusTarget,
    activateCodexThread,
    activateNewCodexThread,
    activateNewProjectlessCodexThread,
    copyTextToClipboard,
    readClipboardText,
    typeText,
    pasteTextAndEnter,
    pasteTextAndEnterToThread,
    pasteTextOnly,
    runCodexCommandSelection,
    copyImageToClipboard,
    pressPaste,
    pressEnter,
    pressCodexShortcut,
    pressCancelCodexResponse,
    switchReasoningMode,
    cdpStatus,
    launchCodexCdp,
    captureCdpScreenshot,
    getToolbarState,
    keepAwakeStatus,
    startKeepAwake,
    stopKeepAwake,
    withClipboardPreserved,
    runExclusive,
    cleanup,
  };
};
