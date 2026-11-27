$base = 'C:\Users\villa\Desktop\credit-apply'
$node = 'C:\nvm4w\nodejs\node.exe'
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Overwriting an existing task needs elevation, so always drop them first.
foreach ($name in 'QoderCreditWatch','QoderCreditCheck') {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}

# The actions call node.exe directly instead of the .cmd wrappers: Task Scheduler
# launches a batch file through cmd.exe, which cannot resolve the non-ASCII
# characters of the old install directory (待处理) and exits with code 1 without
# running it. The whole app therefore lives in an ASCII directory.
# The working directory must be ASCII too - Task Scheduler rejects a non-ASCII
# one with 0x8007010B (invalid directory). Every script path is resolved from
# the script's own location, so the working directory is irrelevant.

# Resident watcher. The script writes watch.log itself.
$watch = New-ScheduledTaskAction -Execute $node -Argument "`"$base\credit-watch.mjs`" --watch" -WorkingDirectory $env:USERPROFILE
# The AtLogOn trigger must name the user explicitly; a trigger without -User
# applies to every user and registration then fails with 0x80070005.
$watchTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$watchSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'QoderCreditWatch' -Action $watch -Trigger $watchTrigger -Settings $watchSettings -Principal $principal -Description 'Passive Qoder credit watcher (reads local Qoder log, submits PKU quota application when credits run low)' -Force -ErrorAction Stop | Out-Null

# Low-frequency fallback check: no-op while the resident watcher is alive.
$check = New-ScheduledTaskAction -Execute $node -Argument "`"$base\credit-watch.mjs`" --once --fallback --log-file `"$base\check.log`"" -WorkingDirectory $env:USERPROFILE
$checkTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 6)
$checkSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
Register-ScheduledTask -TaskName 'QoderCreditCheck' -Action $check -Trigger $checkTrigger -Settings $checkSettings -Principal $principal -Description 'Low-frequency fallback credit check (every 6h, no-op unless credits are low)' -Force -ErrorAction Stop | Out-Null

Get-ScheduledTask -TaskName 'QoderCreditWatch','QoderCreditCheck' | Select-Object TaskName, State | Format-Table -AutoSize
