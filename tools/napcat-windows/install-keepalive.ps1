# 注册 DSH-QQBot 常驻计划任务（需要管理员权限，会弹一次 UAC）
#
#   powershell -ExecutionPolicy Bypass -File install-keepalive.ps1
#
# 效果：
#   - 每次你登录 Windows，自动（隐藏窗口、最高权限）拉起 keepalive.ps1
#   - 看门狗保证 NapCat 常驻，崩了自动拉起
#   - 因为任务本身是最高权限，启动 NapCat 不会再弹 UAC
#   - 关掉任何窗口都不会杀死机器人

$ErrorActionPreference = 'Stop'

$LogDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$InstallLog = Join-Path $LogDir 'install-keepalive.log'

function Write-InstallLog {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $InstallLog -Value $line -Encoding UTF8
}

Write-InstallLog ('==== 开始安装 (PID {0}) ====' -f $PID)
Write-InstallLog ('是否管理员: {0}' -f ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))

try {

$TaskName = 'DSH-QQBot-KeepAlive'
$Root     = $PSScriptRoot
$Script   = Join-Path $Root 'keepalive.ps1'

if (-not (Test-Path -LiteralPath $Script)) { throw "找不到 $Script" }

# 优先用 PowerShell 7，没有就用系统自带的
$shell = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = (Get-Command powershell.exe).Source }
Write-InstallLog "解释器: $shell"

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$account   = $identity.Name
$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Highest
Write-InstallLog "账户: $account"

$action = New-ScheduledTaskAction `
    -Execute $shell `
    -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $Script) `
    -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account
$trigger.Delay = 'PT20S'

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$settings.DisallowStartIfOnBatteries = $false

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description '让 NapCat（QQ 机器人）常驻：登录时自动启动，崩溃自动拉起。配合 DSH 的 dsh-qq-bridge 插件使用。' `
    -Force | Out-Null

Write-InstallLog "已注册计划任务 $TaskName"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and $existing.State -ne 'Running') {
    Start-ScheduledTask -TaskName $TaskName
    Write-InstallLog '已立即启动看门狗'
}
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-InstallLog "任务状态: $state"
Write-InstallLog '==== 安装成功 ===='
}
catch {
    Write-InstallLog ('安装失败: {0}' -f $_.Exception.Message)
    Write-InstallLog ('调用栈: {0}' -f $_.ScriptStackTrace)
    Write-InstallLog '==== 安装失败 ===='
}

