# Moves the installation to another folder and re-points the scheduled tasks.
#
#   .\migrate.ps1 -Target 'D:\apps\credit-apply'
#
# What happens:
#   1. Both scheduled tasks are stopped and unregistered, so the running
#      watcher releases watch.lock and the browser profile directory.
#   2. The folder is copied to the target (robocopy keeps the browser profile
#      with its PKU login cookie intact, so you do not have to log in again).
#   3. register-tasks.ps1 is run from the new location. It derives every path
#      from its own location, so the tasks point at the new folder.
#   4. The watcher is started again and the new copy is verified.
#
# The old folder is NOT deleted - delete it yourself once you have confirmed
# the new one works. Keeping it is harmless as long as its tasks are gone.

param(
  [Parameter(Mandatory = $true)]
  [string]$Target,
  # Overwrite an existing install instead of refusing. Use this to roll back to
  # an older location or to re-copy a partially damaged install.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$source = $PSScriptRoot

# Resolve the target without requiring it to exist yet: split off the leaf
# name, resolve the parent (creating nothing), then re-attach the leaf.
$full = [System.IO.Path]::GetFullPath($Target)
$parent = Split-Path -Parent $full
$leaf = Split-Path -Leaf $full
if (-not (Test-Path -LiteralPath $parent)) {
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$Target = Join-Path (Resolve-Path -LiteralPath $parent).Path $leaf

if ($Target.TrimEnd('\') -ieq $source.TrimEnd('\')) {
  throw "Target is the same as the current location ($source)."
}
if (Test-Path -LiteralPath $Target) {
  $existing = Get-ChildItem -LiteralPath $Target -Force | Select-Object -First 1
  if ($existing -and -not $Force) {
    throw "Target already exists and is not empty: $Target (use -Force to overwrite)"
  }
  if ($existing) {
    Write-Output "Target exists - overwriting (existing files are replaced)."
  } else {
    Write-Output "Target exists and is empty - using it."
  }
}

Write-Output "source = $source"
Write-Output "target = $Target"

# 1. Stop and drop the tasks.
foreach ($name in 'QoderCreditWatch','QoderCreditCheck') {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
}
foreach ($name in 'QoderCreditWatch','QoderCreditCheck') {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# Stop-ScheduledTask only kills the task's own process (conhost), not the node
# process it spawned. A leftover watcher would keep the old install alive and
# would also make the copied watch.lock point at a still-running pid, which
# makes the new instance think it is a duplicate and quit. The match is loose on
# purpose: leftovers from an older layout point at a script in the root folder.
$leftovers = Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like "*$source*credit-watch.mjs*" }
if ($leftovers) {
  Write-Output "stopping $($leftovers.Count) leftover watcher process(es) from $source"
  $leftovers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# Edge may hold the profile directory open; close only the instances that use
# this install's profile, never the user's own browser windows.
$profileDirs = Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
  Where-Object { $_.CommandLine -like "*$source\browser-profile*" }
if ($profileDirs) {
  Write-Output "closing $($profileDirs.Count) Edge process(es) that use this profile"
  $profileDirs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

# 2. Copy the folder. /MOVE would delete the source, which is not wanted.
# Runtime files are excluded: watch.lock carries the pid of the instance that
# just got killed, and copying it would make the new instance refuse to start.
# The .git folder travels along, so the install stays a git checkout.
$null = robocopy $source $Target /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP `
  /XF 'watch.lock' 'watch.heartbeat' 'check.lock' 'apply.lock'
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
Write-Output 'copy done'

# 3. Re-register the tasks from the new location.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Target 'register-tasks.ps1')
if ($LASTEXITCODE -ne 0) { throw "register-tasks.ps1 failed with exit code $LASTEXITCODE" }

# 4. Verify.
Start-Sleep -Seconds 4
$task = Get-ScheduledTask -TaskName 'QoderCreditWatch'
Write-Output "QoderCreditWatch state: $($task.State)"
Write-Output "action: $((Get-ScheduledTask -TaskName 'QoderCreditWatch').Actions.Arguments)"
$log = Join-Path $Target 'watch.log'
if (Test-Path $log) {
  Write-Output '--- new watch.log ---'
  Get-Content $log -Tail 3
}
Write-Output ''
Write-Output "Done. The old folder is still at $source - delete it after verifying the new setup."
