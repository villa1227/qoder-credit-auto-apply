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
#      for the whole run. conhost.exe --headless gives the child a console
#      without a visible window. The Edge window that appears during an actual
#      quota submission is a separate GUI app and still shows, which is
#      intended - you can see the submission happen.
#
# The monitor never runs on its own: the scheduled task is a short "tick" that
# first asks whether Qoder Desktop is running and only then looks at the
# quota in Qoder's local log. Qoder closed -> the tick returns immediately.
#
# Note on paths: node itself handles non-ASCII script paths fine when Task
# Scheduler calls it directly (verified). Two earlier problems were caused by
# other things and are avoided here: a .cmd action is launched through cmd.exe,
# which cannot resolve non-ASCII characters, and a non-ASCII WorkingDirectory
# is rejected with 0x8007010B. So no .cmd wrapper is used as an action, and
# the working directory stays $env:USERPROFILE.

$ErrorActionPreference = 'Stop'

$base = $PSScriptRoot
$monitor = Join-Path $base 'monitor\credit-watch.mjs'
if (-not (Test-Path $monitor)) { throw "monitor script not found: $monitor" }

# How often the scheduled tick wakes up. Qoder writes its quota snapshot in
# short second-level bursts, and the balance can fall from "just above 150"
# to 0 inside one such burst, so a single look per minute would miss it.
# Each wake-up therefore runs a short burst: --burst re-reads the log every
# few seconds for ~40 seconds (config.json "burst"), then exits. That gives a
# ~5 s granularity while still leaving no resident process behind.
$tickMinutes = 1

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
Write-Output "tick   = every $tickMinutes minute(s)"

# Stop any running instance before dropping the tasks: a leftover tick would
# keep writing into the old state file.
foreach ($name in 'QoderCreditWatch','QoderCreditCheck') {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
}
foreach ($name in 'QoderCreditWatch','QoderCreditCheck') {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}

# Stop-ScheduledTask only kills the task's own process (conhost), so the node
# process it spawned has to be stopped explicitly. The match is loose on
# purpose: an install from an older layout put the script straight into the
# root folder, and those leftovers must die as well.
$leftovers = Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$base*credit-watch.mjs*" }
if ($leftovers) {
  Write-Output "stopping $($leftovers.Count) leftover watcher process(es)"
  $leftovers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# A lock left behind by a killed instance would make a new run think it is a
# duplicate, and a stale heartbeat would hide a broken task.
foreach ($stale in 'watch.lock','watch.heartbeat','apply.lock') {
  $path = Join-Path $base $stale
  if (Test-Path $path) { Remove-Item $path -Force -ErrorAction SilentlyContinue }
}

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# The scheduled tick. It writes watch.log itself, so stdout is irrelevant.
# --burst: wake every minute, then poll the log ~every 5 s for ~40 s. Each
# iteration first checks whether Qoder is running; if it has closed, the burst
# stops immediately.
$watch = New-ScheduledTaskAction `
  -Execute $conhost `
  -Argument "--headless `"$node`" `"$monitor`" --tick --burst" `
  -WorkingDirectory $env:USERPROFILE
# A pure time trigger: the tick must not depend on a logon event, it simply
# runs every minute and checks whether Qoder Desktop is open.
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $tickMinutes)
$watchSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(10)) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'QoderCreditWatch' -Action $watch -Trigger $watchTrigger -Settings $watchSettings -Principal $principal -Description 'Passive Qoder credit monitor: ticks every minute, bursts for ~40 s, and only looks at the quota while Qoder Desktop is running' -Force -ErrorAction Stop | Out-Null

# Low-frequency fallback check: no-op while the scheduled tick is alive.
$check = New-ScheduledTaskAction `
  -Execute $conhost `
  -Argument "--headless `"$node`" `"$monitor`" --once --fallback --log-file `"$base\check.log`"" `
  -WorkingDirectory $env:USERPROFILE
$checkTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 6)
$checkSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::FromMinutes(10)) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'QoderCreditCheck' -Action $check -Trigger $checkTrigger -Settings $checkSettings -Principal $principal -Description 'Low-frequency fallback credit check (every 6h, no-op unless credits are low)' -Force -ErrorAction Stop | Out-Null

Get-ScheduledTask -TaskName 'QoderCreditWatch','QoderCreditCheck' | Select-Object TaskName, State | Format-Table -AutoSize

# Run one tick right away so the setup can be verified without waiting.
Start-ScheduledTask -TaskName 'QoderCreditWatch'
Start-Sleep -Seconds 5
Get-ScheduledTask -TaskName 'QoderCreditWatch' | Select-Object TaskName, State | Format-Table -AutoSize
$log = Join-Path $base 'watch.log'
if (Test-Path $log) {
  Write-Output '--- watch.log ---'
  Get-Content $log -Tail 5
}
