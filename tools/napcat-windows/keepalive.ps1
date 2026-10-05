# DSH-QQBot 看门狗：保证 NapCat 常驻
#
# 由计划任务 DSH-QQBot-KeepAlive 以「最高权限」在用户登录时拉起，因此：
#   - 启动 launcher.bat 不会再弹 UAC
#   - 只有它能杀掉高权限的 NapCat / 机器人 QQ 进程
#
# 状态机（重要）：
#   healthy       引导进程在 + 3000 端口通          -> 什么都不做
#   login-pending 引导进程在 + 6099 通 + 3000 不通  -> QQ 在等登录，【绝不重启】
#                                                     反复重启会把登录窗口反复关掉
#   starting      刚发出启动命令，还没起来          -> 等
#   dead          没有引导进程                      -> 拉起（带指数退避）
#
# 暂停/恢复不需要管理员：见同目录 stop-bot.bat / start-bot.bat

$ErrorActionPreference = 'SilentlyContinue'

$Root              = $PSScriptRoot   # 脚本所在目录 = NapCat 安装目录
$LogDir            = Join-Path $Root 'logs'
$Log               = Join-Path $LogDir 'keepalive.log'
$PauseFlag         = Join-Path $Root 'bot-pause.flag'
$CheckSeconds      = 15
$StartGraceSeconds = 120      # 发出启动命令后给它多久变成 healthy
$LoginGraceSeconds = 900      # 等登录最多等这么久，之后才考虑重新拉起
$MaxBackoff        = 900

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log {
    param([string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
    if ((Get-Item -LiteralPath $Log -ErrorAction SilentlyContinue).Length -gt 1048576) {
        $tail = Get-Content -LiteralPath $Log -Tail 400
        Set-Content -LiteralPath $Log -Value $tail -Encoding UTF8
    }
}

function Test-PortOpen {
    param([int]$Port)
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Get-BotState {
    if (-not (Get-Process -Name NapCatWinBootMain -ErrorAction SilentlyContinue)) { return 'dead' }
    if (Test-PortOpen -Port 3000) { return 'healthy' }
    if (Test-PortOpen -Port 6099) { return 'login-pending' }
    return 'starting'
}

# 机器人的 QQ 进程整棵树都挂在 NapCatWinBootMain 之下，
# 而你自己的 QQ 挂在 explorer 之下 —— 用这个特征只杀机器人，绝不碰主号。
function Get-BotProcessIds {
    $ids = New-Object System.Collections.Generic.HashSet[int]

    foreach ($boot in @(Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'" -ErrorAction SilentlyContinue)) {
        [void]$ids.Add([int]$boot.ProcessId)
    }
    foreach ($port in 3000, 6099) {
        foreach ($conn in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
            [void]$ids.Add([int]$conn.OwningProcess)
        }
    }
    if ($ids.Count -eq 0) { return @() }

    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $byParent = @{}
    foreach ($proc in $all) {
        $parentKey = [string]$proc.ParentProcessId
        if (-not $byParent.ContainsKey($parentKey)) { $byParent[$parentKey] = New-Object System.Collections.ArrayList }
        [void]$byParent[$parentKey].Add([int]$proc.ProcessId)
    }
    $queue = New-Object System.Collections.Generic.Queue[int]
    foreach ($rootId in @($ids)) { $queue.Enqueue($rootId) }
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        $children = $byParent[[string]$current]
        if (-not $children) { continue }
        foreach ($child in $children) {
            if ($ids.Add([int]$child)) { $queue.Enqueue([int]$child) }
        }
    }
    return @($ids)
}

function Stop-Bot {
    $ids = Get-BotProcessIds
    if ($ids.Count -eq 0) {
        Write-Log '没有发现正在运行的机器人进程，无需停止'
        return
    }
    Write-Log ('正在停止机器人，目标进程: {0}' -f ($ids -join ', '))
    foreach ($procId in $ids) { & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null }
    Start-Sleep -Seconds 3
    foreach ($procId in (Get-BotProcessIds)) { & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null }
    Write-Log ('机器人已停止（剩余目标进程: {0}）' -f (Get-BotProcessIds).Count)
}

function Start-Bot {
    # 只隐藏**本看门狗自己启动的** launcher 控制台（-WindowStyle Hidden）。
    $cmd = Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/c', (Join-Path $Root 'launcher.bat') `
        -WorkingDirectory $Root -WindowStyle Hidden -PassThru
    Write-Log ('已发出启动命令（launcher PID {0}）' -f $cmd.Id)
}

# 隐藏机器人自己那些窗口（QQ 会弹主窗口 / 缩略图等）。
#
# ⚠️ 两道独立判定，缺一不可 —— 曾经因为只按进程名 'QQ' 匹配，把主号自己的
# QQ 一起隐藏了：
#   ① 主判定 Get-BotProcessIds：父子关系（挂在 NapCatWinBootMain 之下）+ 占用
#      3000/6099 的进程。机器人的 QQ 挂在 NapCatWinBootMain 下，主号的挂在 explorer 下。
#   ② 第二道保险：逐个向上追溯父进程，只要碰到 explorer.exe 就判定为主号的
#      进程并跳过。
# 目标列表为空时直接返回：宁可漏隐藏，也绝不误伤任何东西。
Add-Type -Namespace DshQq -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
'@ -ErrorAction SilentlyContinue

function Hide-BotWindows {
    $byId = @{}
    foreach ($proc in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
        $byId[[int]$proc.ProcessId] = $proc
    }

    $targets = @()
    foreach ($candidate in @(Get-BotProcessIds)) {
        $cur = [int]$candidate
        $belongsToUser = $false
        for ($hop = 0; $hop -lt 12; $hop++) {
            if (-not $byId.ContainsKey($cur)) { break }
            $proc = $byId[$cur]
            if ($proc.Name -ieq 'explorer.exe') { $belongsToUser = $true; break }
            $next = [int]$proc.ParentProcessId
            if ($next -eq 0 -or $next -eq $cur) { break }
            $cur = $next
        }
        if ($belongsToUser) {
            Write-Log ('跳过 PID {0}：能追溯到 explorer.exe，属于主号自己的进程' -f $candidate)
            continue
        }
        $targets += [int]$candidate
    }
    if ($targets.Count -eq 0) { return }

    $script:hiddenNow = 0
    $callback = [DshQq.Win32+EnumWindowsProc] {
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        try {
            $owner = 0
            [void][DshQq.Win32]::GetWindowThreadProcessId($hWnd, [ref]$owner)
            if (($targets -contains [int]$owner) -and [DshQq.Win32]::IsWindowVisible($hWnd)) {
                [void][DshQq.Win32]::ShowWindow($hWnd, 0)   # SW_HIDE
                $script:hiddenNow++
            }
        } catch {
            # 窗口可能刚好在这时销毁，忽略。
        }
        return $true
    }
    try {
        [void][DshQq.Win32]::EnumWindows($callback, [IntPtr]::Zero)
    } catch {
        Write-Log ('隐藏窗口时出错：{0}' -f $_.Exception.Message)
    }
    if ($script:hiddenNow -gt 0) {
        Write-Log ('已隐藏机器人 {0} 个窗口（判定为机器人的 PID：{1}）' -f $script:hiddenNow, ($targets -join ','))
    }
}

Write-Log ('看门狗启动 (PID {0})，检查间隔 {1}s，当前状态 {2}' -f $PID, $CheckSeconds, (Get-BotState))

$lastStart          = [datetime]::MinValue
$loginPendingSince  = $null
$consecutiveFailure = 0
$wasPaused          = $false

while ($true) {
    if (Test-Path -LiteralPath $PauseFlag) {
        if (-not $wasPaused) {
            Write-Log '检测到暂停标记：停止机器人并挂起自愈'
            Stop-Bot
            $wasPaused = $true
            $loginPendingSince = $null
        }
        Start-Sleep -Seconds $CheckSeconds
        continue
    }
    if ($wasPaused) {
        Write-Log '暂停标记已移除，恢复自愈'
        $wasPaused = $false
        $lastStart = [datetime]::MinValue
        $consecutiveFailure = 0
    }

    $state = Get-BotState
    # 只隐藏判定为机器人自己的窗口（两道判定见 Hide-BotWindows 上方注释）。
    # 主号的 QQ 与机器人同为 QQ.exe，因此绝不能按进程名匹配。
    Hide-BotWindows

    switch ($state) {
        'healthy' {
            if ($consecutiveFailure -gt 0) { Write-Log '机器人已恢复健康' }
            $consecutiveFailure = 0
            $loginPendingSince = $null
            $lastStart = [datetime]::MinValue
        }

        'login-pending' {
            # NapCat 在等 QQ 登录。反复重启只会把登录窗口一次次关掉，所以这里按兵不动。
            if (-not $loginPendingSince) {
                $loginPendingSince = Get-Date
                Write-Log 'NapCat 在运行但 QQ 尚未登录（可能在等扫码）。保持不动，等待登录完成，不会反复重启。'
            }
            elseif (((Get-Date) - $loginPendingSince).TotalSeconds -gt $LoginGraceSeconds) {
                Write-Log ('等待登录已超过 {0} 分钟，重新拉起一次试试' -f [int]($LoginGraceSeconds / 60))
                $loginPendingSince = $null
                $lastStart = Get-Date
                Stop-Bot
                Start-Bot
            }
        }

        default {
            # dead / starting
            $loginPendingSince = $null
            $elapsed = ((Get-Date) - $lastStart).TotalSeconds
            $grace = if ($state -eq 'starting') { $StartGraceSeconds } else { 0 }
            $backoff = [Math]::Min(90 * [Math]::Pow(2, $consecutiveFailure), $MaxBackoff)
            $threshold = [Math]::Max($grace, $backoff)

            if ($elapsed -ge $threshold) {
                $consecutiveFailure++
                if ($state -eq 'dead') {
                    Write-Log ('机器人不在线（第 {0} 次拉起，退避 {1}s）' -f $consecutiveFailure, [int]$backoff)
                }
                else {
                    Write-Log ('启动后 {0}s 仍未就绪（状态: {1}），重新拉起' -f [int]$elapsed, $state)
                }
                $lastStart = Get-Date
                Stop-Bot
                Start-Bot
            }
        }
    }

    Start-Sleep -Seconds $CheckSeconds
}
