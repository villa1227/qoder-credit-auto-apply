/**
 * Passive credit watcher for Qoder Desktop.
 *
 * Detection source: Qoder Desktop itself refreshes GET /sash/api/v2/me/usage and writes the
 * full normalized quota JSON into its local log as a "用量响应摘要" line. We only read that
 * file locally - no polling of the quota API, no LLM turn, no credit cost.
 *
 * Usage:
 *   node credit-watch.mjs --once            # single evaluation, prints the verdict
 *   node credit-watch.mjs --watch           # long-running passive watcher
 *   node credit-watch.mjs --status          # print state.json
 *   node credit-watch.mjs --reset           # reset the state machine to idle
 *   node credit-watch.mjs --mark <stage> [--application-id x] [--note x]
 *   node credit-watch.mjs --once --dry-run  # never dispatch, only report
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, unlinkSync, renameSync, appendFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(HERE, 'config.json');
const STATE_FILE = join(HERE, 'state.json');
const MARKER = '用量响应摘要';

function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  // Environment overrides exist for testing (synthetic logs / stub submission script).
  if (process.env.QODER_CREDIT_LOG_DIR) config.logDir = process.env.QODER_CREDIT_LOG_DIR;
  if (process.env.QODER_CREDIT_THRESHOLD) config.threshold = Number(process.env.QODER_CREDIT_THRESHOLD);
  if (process.env.QODER_CREDIT_MAX_SNAPSHOT_AGE_HOURS) {
    config.maxSnapshotAgeHours = Number(process.env.QODER_CREDIT_MAX_SNAPSHOT_AGE_HOURS);
  }
  config.threshold = Number(config.threshold ?? 150);
  config.pollIntervalMs = Number(config.pollIntervalMs ?? 60000);
  config.maxSnapshotAgeHours = Number(config.maxSnapshotAgeHours ?? 6);
  config.applyScript = process.env.QODER_CREDIT_APPLY_SCRIPT || join(HERE, 'apply-pku.mjs');
  config.stateFile = process.env.QODER_CREDIT_STATE_FILE || STATE_FILE;
  config.lockFile = process.env.QODER_CREDIT_LOCK_FILE || DEFAULT_LOCK_FILE;
  config.heartbeatFile = process.env.QODER_CREDIT_HEARTBEAT_FILE || join(HERE, 'watch.heartbeat');
  config.watchLogFile = process.env.QODER_CREDIT_WATCH_LOG_FILE || join(HERE, 'watch.log');
  config.watchLockFile = process.env.QODER_CREDIT_WATCH_LOCK_FILE || join(HERE, 'watch.lock');
  // Log files are bounded: the watcher appends one line per minute forever, so
  // they are trimmed to their tail once they pass the cap.
  config.maxLogBytes = Number(process.env.QODER_CREDIT_MAX_LOG_BYTES ?? config.maxLogBytes ?? 1024 * 1024);
  config.keepLogBytes = Number(process.env.QODER_CREDIT_KEEP_LOG_BYTES ?? config.keepLogBytes ?? 256 * 1024);
  return config;
}

/** True when a long-running watcher refreshed its heartbeat recently. */
function watcherAlive(config, maxAgeMs = 180000) {
  try {
    return Date.now() - statSync(config.heartbeatFile).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
}

function loadState(stateFile = STATE_FILE) {
  if (!existsSync(stateFile)) {
    return {
      stage: 'idle',
      cycleKey: null,
      effectiveRemaining: null,
      breakdown: null,
      snapshotAt: null,
      lastCheckedAt: null,
      triggeredAt: null,
      dispatchedAt: null,
      appliedAt: null,
      applicationId: null,
      lastError: null,
      note: null,
    };
  }
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return { stage: 'idle', cycleKey: null, effectiveRemaining: null, note: 'state.json unreadable, recreated' };
  }
}

function saveState(state, stateFile = STATE_FILE) {
  // Atomic write: a concurrent reader (the 6h fallback task) must never observe a
  // half-written file, which would look like a lost state machine and could cause
  // a duplicate application.
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    renameSync(tmp, stateFile);
  } catch {
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

const TERMINAL_STAGES = new Set(['submitted']);

/**
 * Persist the state without clobbering a newer, terminal state written by the
 * submission script (which marks the state as "submitted" on its own).
 * A quota cycle change is an intentional reset, so it is never merged.
 */
function mergeSave(state, stateFile = STATE_FILE) {
  const disk = loadState(stateFile);
  if (disk.cycleKey !== state.cycleKey) {
    saveState(state, stateFile);
    return state;
  }
  const merged = { ...disk, ...state };
  if (TERMINAL_STAGES.has(disk.stage) && !TERMINAL_STAGES.has(state.stage)) {
    merged.stage = disk.stage;
    merged.appliedAt = disk.appliedAt;
    merged.applicationId = disk.applicationId;
  }
  saveState(merged, stateFile);
  return merged;
}

/**
 * Keep a log file bounded. The watcher appends one line per minute for as long
 * as the machine is on, so the file grows without limit. Once it passes the
 * cap, only its tail (the newest lines) is kept.
 */
function rotateLogFile(file, maxBytes, keepBytes) {
  try {
    const size = statSync(file).size;
    if (size <= maxBytes) return false;
    const fd = openSync(file, 'r');
    let text = '';
    try {
      const start = Math.max(0, size - keepBytes);
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
    // cut at a line boundary so the first kept line stays readable
    const cut = text.indexOf('\n');
    const kept = cut === -1 ? text : text.slice(cut + 1);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `--- log truncated, older lines dropped ---\n${kept}`, 'utf8');
    try {
      renameSync(tmp, file);
    } catch {
      writeFileSync(file, `--- log truncated, older lines dropped ---\n${kept}`, 'utf8');
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The watcher writes its own log file instead of relying on a shell redirect:
 * a shell redirect holds watch.log open for the whole process lifetime, which
 * makes every other writer (and any restart) fail with "file in use".
 * Appending per line keeps the handle short-lived.
 */
let logFileSink = null;
let logLimits = { maxBytes: 1024 * 1024, keepBytes: 256 * 1024 };

function setLogFileSink(file) {
  logFileSink = file;
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .join(' ')}`;
  console.log(line);
  if (logFileSink) {
    try {
      rotateLogFile(logFileSink, logLimits.maxBytes, logLimits.keepBytes);
      appendFileSync(logFileSink, `${line}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }
}

/** Locate the newest Qoder Desktop log directory that contains main.log. */
function findLatestLogFile(config) {
  const roots = [];
  if (config.logDir) roots.push(config.logDir);
  else {
    const appData = process.env.APPDATA;
    if (appData) roots.push(join(appData, 'com.qodercn.app.stable', 'logs'));
  }
  const candidates = [];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const mainLog = join(root, dir, 'main.log');
      if (!existsSync(mainLog)) continue;
      try {
        candidates.push({ file: mainLog, mtime: statSync(mainLog).mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0];
}

/** Read the tail of a log file and return the newest quota snapshot. */
function readQuotaSnapshot(logFile) {
  const size = statSync(logFile).size;
  const maxBytes = 8 * 1024 * 1024;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(logFile, 'r');
  let text = '';
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    text = buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const idx = line.indexOf(MARKER);
    if (idx === -1) continue;
    const json = line.slice(idx + MARKER.length).trim();
    if (!json.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(json);
      const timestamp = /^\[([^\]]+)\]/.exec(line)?.[1] ?? null;
      return { parsed, timestamp, line };
    } catch {
      /* keep scanning older lines */
    }
  }
  return null;
}

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Effective remaining credits. The quota response may carry several pools; the log encodes
 * absent fields as the string "missing", which must be treated as absent rather than 0/undefined.
 */
function computeEffectiveRemaining(qoderUsage) {
  const breakdown = {};
  const userQuota = qoderUsage?.userQuota;
  breakdown.userQuota = num(userQuota?.remaining);

  const org = qoderUsage?.orgResourcePackage;
  breakdown.orgResourcePackage = org && org !== 'missing' && org.available === true ? num(org.remaining) : 0;

  const addOn = qoderUsage?.addOnQuota;
  breakdown.addOnQuota = addOn && addOn !== 'missing' ? num(addOn.remaining) : 0;

  const dedicated = Array.isArray(qoderUsage?.dedicatedResourcePackages)
    ? qoderUsage.dedicatedResourcePackages
    : [];
  breakdown.dedicatedResourcePackages = dedicated.reduce((sum, pack) => {
    if (!pack || pack === 'missing') return sum;
    if (pack.available === false) return sum;
    return sum + num(pack.remaining);
  }, 0);

  const effective =
    breakdown.userQuota +
    breakdown.orgResourcePackage +
    breakdown.addOnQuota +
    breakdown.dedicatedResourcePackages;
  return { effective, breakdown };
}


const DEFAULT_LOCK_FILE = join(HERE, 'apply.lock');

/**
 * Only one submission may be in flight. The lock is a file created exclusively;
 * a lock older than 60 minutes is considered stale (crashed run) and taken over.
 */
function acquireLock(lockFile = DEFAULT_LOCK_FILE) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(lockFile).mtimeMs;
      } catch {
        age = 0;
      }
      if (age > 60 * 60000) {
        try {
          unlinkSync(lockFile);
        } catch {
          /* ignore */
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(lockFile = DEFAULT_LOCK_FILE) {
  try {
    unlinkSync(lockFile);
  } catch {
    /* ignore */
  }
}

/**
 * Only one resident watcher may run. A lock is stale when its recorded pid is
 * gone (killed watcher) or when it stopped being refreshed (crashed watcher);
 * the mtime is refreshed on every tick by refreshWatcherLock().
 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function acquireWatcherLock(lockFile, staleMs = 600000) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      let owner = null;
      try {
        age = Date.now() - statSync(lockFile).mtimeMs;
        owner = JSON.parse(readFileSync(lockFile, 'utf8'));
      } catch {
        /* ignore */
      }
      const ownerGone = owner && !processAlive(Number(owner.pid));
      if (ownerGone || age > staleMs) {
        try {
          unlinkSync(lockFile);
        } catch {
          /* ignore */
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function refreshWatcherLock(lockFile) {
  try {
    const now = new Date();
    utimesSync(lockFile, now, now);
  } catch {
    /* ignore */
  }
}

async function dispatchApply(config, state, snapshotInfo) {
  // The submission itself is done by a local script driving a local Edge over CDP.
  // No Agent turn, no Qoder credits - the application still goes out when the
  // credit balance is already exhausted.
  const { spawn } = await import('node:child_process');
  const logFile = join(HERE, 'apply.log');
  // apply.log only grows when an application is actually submitted, but keep it
  // bounded all the same.
  rotateLogFile(logFile, logLimits.maxBytes, logLimits.keepBytes);
  const out = openSync(logFile, 'a');
  const child = spawn(process.execPath, [config.applyScript], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, REMAINING_CREDITS: String(snapshotInfo.effective) },
  });
  child.unref();
  closeSync(out);
  return { pid: child.pid, logFile };
}

async function evaluate(config, options = {}) {
  const state = loadState(config.stateFile);
  const entry = findLatestLogFile(config);
  if (!entry) {
    log('no main.log found under', config.logDir || 'default logs dir');
    return { ok: false, reason: 'no-log' };
  }
  const snapshot = readQuotaSnapshot(entry.file);
  if (!snapshot) {
    log('no quota snapshot found in', entry.file);
    return { ok: false, reason: 'no-snapshot' };
  }
  const qoderUsage = snapshot.parsed?.qoderUsage;
  if (!qoderUsage) {
    log('snapshot has no qoderUsage block');
    return { ok: false, reason: 'no-qoder-usage' };
  }
  const { effective, breakdown } = computeEffectiveRemaining(qoderUsage);
  const cycleKey = String(qoderUsage.expiresAt ?? 'unknown');
  const cycleExpiresAtIso = Number.isFinite(qoderUsage.expiresAt)
    ? new Date(qoderUsage.expiresAt).toISOString()
    : 'unknown';

  // New quota cycle -> reset the state machine so a new application becomes possible.
  if (state.cycleKey !== null && state.cycleKey !== cycleKey) {
    log(`quota cycle changed ${state.cycleKey} -> ${cycleKey}, resetting state`);
    state.stage = 'idle';
    state.triggeredAt = null;
    state.dispatchedAt = null;
    state.appliedAt = null;
    state.applicationId = null;
    state.note = 'new quota cycle';
  }
  state.cycleKey = cycleKey;
  state.effectiveRemaining = effective;
  state.breakdown = breakdown;
  state.snapshotAt = snapshot.timestamp;
  state.lastCheckedAt = new Date().toISOString();

  const threshold = config.threshold;
  const below = effective <= threshold;

  // Freshness guard: never trigger on a stale snapshot.
  const snapshotAgeMs = snapshot.timestamp ? Date.now() - Date.parse(snapshot.timestamp) : Infinity;
  const stale = snapshotAgeMs > config.maxSnapshotAgeHours * 3600 * 1000;
  if (stale) {
    state.note = `snapshot stale (${Math.round(snapshotAgeMs / 60000)} min old)`;
    log(`snapshot is stale (${Math.round(snapshotAgeMs / 60000)} min) - not triggering`);
    mergeSave(state, config.stateFile);
    return { ok: true, effective, breakdown, stale: true, stage: state.stage };
  }

  if (!below) {
    if (state.stage !== 'idle') {
      state.stage = 'idle';
      state.note = null;
    }
    mergeSave(state, config.stateFile);
    log(`effective remaining ${effective} > threshold ${threshold} - idle`);
    return { ok: true, effective, breakdown, below: false, stage: state.stage };
  }

  if (state.stage === 'idle') {
    state.stage = 'triggered';
    state.triggeredAt = new Date().toISOString();
    state.note = 'threshold reached';
    log(`effective remaining ${effective} <= threshold ${threshold} - TRIGGERED`);
  } else {
    log(`effective remaining ${effective} <= threshold ${threshold} - stage=${state.stage}`);
  }

  if (options.dryRun) {
    state.note = 'dry-run';
    mergeSave(state, config.stateFile);
    return { ok: true, effective, breakdown, below: true, stage: state.stage, dryRun: true };
  }

  // Dispatch only when the state machine still owns the un-dispatched trigger.
  const retryMs = Number(config.escalation?.dispatchRetryMs ?? 600000);
  const lastDispatch = state.dispatchedAt ? Date.parse(state.dispatchedAt) : 0;
  const sinceDispatch = Date.now() - lastDispatch;
  let mayDispatch = false;
  if (state.stage === 'triggered') mayDispatch = true;
  else if (state.stage === 'failed' && sinceDispatch > retryMs) mayDispatch = true;
  else if (state.stage === 'dispatched' && sinceDispatch > 45 * 60000 && !state.applicationId) {
    // the submission script stalled (e.g. waiting for a login that never happened)
    mayDispatch = true;
  }

  if (mayDispatch) {
    // Re-read the state: the submission script may have finished and marked the
    // state as "submitted" between our first read and this point.
    const disk = loadState(config.stateFile);
    if (disk.stage === 'submitted' && disk.cycleKey === state.cycleKey) {
      log('already submitted in this cycle - skipping dispatch');
      mergeSave(state, config.stateFile);
      return { ok: true, effective, breakdown, below: true, stage: disk.stage, skipped: true };
    }
    if (!acquireLock(config.lockFile)) {
      log('another submission is already in flight, skipping dispatch');
      mergeSave(state, config.stateFile);
      return { ok: true, effective, breakdown, below: true, stage: state.stage, locked: true };
    }
    // Persist the dispatch BEFORE spawning the submission script: the script marks
    // the state as "submitted" on its own, and it must not overwrite the
    // dispatchedAt/dispatch bookkeeping with a stale copy of the state file.
    state.stage = 'dispatched';
    state.dispatchedAt = new Date().toISOString();
    state.note = 'local browser submission started';
    state.lastError = null;
    mergeSave(state, config.stateFile);
    try {
      const result = await dispatchApply(config, state, { effective, cycleExpiresAtIso });
      log('dispatched local browser application, pid', result.pid);
      // The state file is already up to date; do not write it again here, the
      // submission script may have advanced it to "submitted" in the meantime.
      return { ok: true, effective, breakdown, below: true, stage: state.stage, dispatched: true };
    } catch (error) {
      state.stage = 'failed';
      state.lastError = String(error.message || error);
      state.note = 'dispatch failed, will retry';
      log('dispatch failed:', state.lastError);
      releaseLock(config.lockFile);
    }
  }

  mergeSave(state, config.stateFile);
  return { ok: true, effective, breakdown, below: true, stage: state.stage };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      if (key === 'mark') {
        args.mark = argv[i + 1];
        i += 1;
      } else if (key === 'application-id') {
        args.applicationId = argv[i + 1];
        i += 1;
      } else if (key === 'note') {
        args.note = argv[i + 1];
        i += 1;
      } else if (key === 'log-file') {
        args['log-file'] = argv[i + 1];
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(item);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  logLimits = { maxBytes: config.maxLogBytes, keepBytes: config.keepLogBytes };
  // Scheduled tasks have no console, so the run can be asked to mirror its
  // output into a file (the watcher writes watch.log by itself).
  if (args['log-file']) setLogFileSink(args['log-file']);

  if (args.mark) {
    const state = loadState(config.stateFile);
    const stage = args.mark;
    if (!['idle', 'triggered', 'dispatched', 'submitted', 'failed'].includes(stage)) {
      console.error(`invalid stage: ${stage}`);
      process.exit(2);
    }
    state.stage = stage;
    if (args.applicationId) state.applicationId = args.applicationId;
    if (args.note) state.note = args.note;
    if (stage === 'submitted') state.appliedAt = new Date().toISOString();
    saveState(state, config.stateFile);
    console.log(`state.stage = ${stage}`);
    return;
  }

  if (args.status) {
    console.log(JSON.stringify(loadState(config.stateFile), null, 2));
    return;
  }

  if (args.reset) {
    const state = loadState(config.stateFile);
    state.stage = 'idle';
    state.triggeredAt = null;
    state.dispatchedAt = null;
    state.appliedAt = null;
    state.applicationId = null;
    state.note = 'manually reset';
    saveState(state, config.stateFile);
    releaseLock(config.lockFile);
    console.log('state reset to idle');
    return;
  }

  if (args.watch) {
    setLogFileSink(config.watchLogFile);
    if (!acquireWatcherLock(config.watchLockFile)) {
      log('another watcher instance is already running - exiting');
      return;
    }
    const shutdown = () => {
      try {
        unlinkSync(config.watchLockFile);
      } catch {
        /* ignore */
      }
    };
    process.on('exit', shutdown);
    log('watcher started, interval', config.pollIntervalMs, 'ms');
    const tick = async () => {
      try {
        await evaluate(config, {});
      } catch (error) {
        log('evaluation error:', error.message || error);
      }
      try {
        writeFileSync(config.heartbeatFile, new Date().toISOString(), 'utf8');
      } catch {
        /* ignore */
      }
      refreshWatcherLock(config.watchLockFile);
    };
    await tick();
    setInterval(tick, config.pollIntervalMs);
    return;
  }

  // Fallback check (scheduled task): if the resident watcher is alive, do nothing
  // so the two processes never fight over state.json.
  if (args.fallback && watcherAlive(config)) {
    log('watcher alive - fallback check skipped');
    return;
  }

  const result = await evaluate(config, { dryRun: Boolean(args['dry-run']) });
  const text = JSON.stringify(result, null, 2);
  console.log(text);
  if (logFileSink) {
    try {
      rotateLogFile(logFileSink, logLimits.maxBytes, logLimits.keepBytes);
      appendFileSync(logFileSink, `${text}\n`, 'utf8');
    } catch {
      /* ignore */
    }
  }
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
