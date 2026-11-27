# Registers the two scheduled tasks that keep the credit watcher alive.
#
# Two properties this script has to guarantee:
#
#   1. The install directory may move. Everything below is derived from
#      $PSScriptRoot, so after moving the folder you just run this script
#      again from the new location and the tasks point at the new path.
#      Only the node executable is looked up on the machine.
#
#   2. No console window may appear. A console app started by Task Scheduler
#      in the interactive session opens a terminal window that stays on screen
#      for the whole run (the resident watcher runs forever). conhost.exe
#      --headless gives the child a console without a visible window, which
#      keeps the watcher running invisibly. The Edge window that appears during
#      an actual quota submission is a separate GUI app and still shows, which
#      is intended - you can see the submission happen.
#
# Note on paths: node itself handles non-ASCII script paths fine when Task
# Scheduler calls it directly (verified). Two earlier problems were caused by
# other things and are avoided here: a .cmd action is launched through cmd.exe,
# which cannot resolve non-ASCII characters, and a non-ASCII WorkingDirectory
# is rejected with 0x8007010B. So no .cmd wrapper is used as an action, and
# the working directory stays $env:USERPROFILE.

$ErrorActionPreference = 'Stop'

$base = $PSScriptRoot

# Resolve node from the machine rather than hardcoding a path.
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($candidate in @(
    'C:\nvm4w\nodejs\node.exe',
    "$env:APPDATA\nvm\node.exe",
    "$env:ProgramFiles\nodejs\node.exe"
  )) {
    if (Test-Path $candidate) { $node = $candidate; break }
  }
}
if (-not $node) { throw 'node.exe not found - install Node.js or put it on PATH, then run this script again.' }

$conhost = "$env:SystemRoot\System32\conhost.exe"
if (-not (Test-Path $conhost)) { throw "conhost.exe not found at $conhost" }

Write-Output "base   = $base"
Write-Output "node   = $node"

# Stop any running instance before dropping the tasks: the resident watcher
# holds watch.lock, and an orphaned copy would block the new one from starting.
# Stop-ScheduledTask only kills the task's own process (conhost), so the node
# process it spawned has to be stopped explicitly.
$leftovers = Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$base\credit-watch.mjs*" }
if ($leftovers) {
  Write-Output "stopping $($leftovers.Count) leftover watcher process(es)"
  $leftovers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
foreach ($name in 'QoderCreditWatch','QoderCreditCheck') {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
}
foreach ($name in 'QoderCreditWatch','QoderCreditCheck') {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}

# A lock left behind by a killed instance would make the new watcher quit with
# "another watcher instance is already running".
foreach ($stale in 'watch.lock','watch.heartbeat') {
  $path = Join-Path $base $stale
  if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
}

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Resident watcher. It writes watch.log itself, so stdout is irrelevant.
$watch = New-ScheduledTaskAction `
  -Execute $conhost `
  -Argument "--headless `"$node`" `"$base\credit-watch.mjs`" --watch" `
  -WorkingDirectory $env:USERPROFILE
# The AtLogOn trigger must name the user explicitly; a trigger without -User
# applies to every user and registration then fails with 0x80070005.
$watchTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'QoderCreditWatch' -Action $watch -Trigger $watchTrigger -Settings $watchSettings -Principal $principal -Description 'Passive Qoder credit watcher (reads local Qoder log, submits PKU quota application when credits run low)' -Force -ErrorAction Stop | Out-Null

# Low-frequency fallback check: no-op while the resident watcher is alive.
$check = New-ScheduledTaskAction `
  -Execute $conhost `
  -Argument "--headless `"$node`" `"$base\credit-watch.mjs`" --once --fallback --log-file `"$base\check.log`"" `
  -WorkingDirectory $env:USERPROFILE
$checkTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 6)
$checkSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(10)) -StartWhenAvailable
Register-ScheduledTask -TaskName 'QoderCreditCheck' -Action $check -Trigger $checkTrigger -Settings $checkSettings -Principal $principal -Description 'Low-frequency fallback credit check (every 6h, no-op unless credits are low)' -Force -ErrorAction Stop | Out-Null

Get-ScheduledTask -TaskName 'QoderCreditWatch','QoderCreditCheck' | Select-Object TaskName, State | Format-Table -AutoSize

# Start the resident watcher right away so that re-running this script after a
# move leaves the setup working without a sign-out.
Start-ScheduledTask -TaskName 'QoderCreditWatch'
Start-Sleep -Seconds 3
Get-ScheduledTask -TaskName 'QoderCreditWatch' | Select-Object TaskName, State | Format-Table -AutoSize
