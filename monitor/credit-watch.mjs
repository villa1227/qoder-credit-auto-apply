/**
 * Passive credit watcher for Qoder Desktop.  (monitoring layer - school agnostic)
 *
 * This file knows nothing about any university portal. It reads the quota that
 * Qoder Desktop itself writes into its local log and, when the balance drops
 * below the threshold, hands over to the submission script named in
 * config.paths.applyScript (the "apply layer", a separate folder).
 *
 * Detection source: Qoder Desktop itself refreshes GET /sash/api/v2/me/usage and writes the
 * full normalized quota JSON into its local log as a "用量响应摘要" line. We only read that
 * file locally - no polling of the quota API, no LLM turn, no credit cost.
 *
 * Usage:
 *   node monitor/credit-watch.mjs --tick           # scheduled entry point (see below)
 *   node monitor/credit-watch.mjs --once           # single evaluation, prints the verdict
 *   node monitor/credit-watch.mjs --watch          # long-running passive watcher
 *   node monitor/credit-watch.mjs --status         # print state.json
 *   node monitor/credit-watch.mjs --reset          # reset the state machine to idle
 *   node monitor/credit-watch.mjs --mark <stage> [--application-id x] [--note x]
 *   node monitor/credit-watch.mjs --once --dry-run # never dispatch, only report
 *
 * --tick is what the scheduled task runs every couple of minutes: it first
 * checks whether Qoder Desktop is actually running and only then looks at the
 * log. While Qoder is closed nothing is monitored and no work is done.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, unlinkSync, renameSync, appendFileSync, utimesSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
// The application root is the parent of this folder (monitor/ and apply/ are
// siblings); the config and all runtime files live there.
const APP_ROOT = dirname(HERE);
const CONFIG_FILE = join(APP_ROOT, 'config.json');
const STATE_FILE = join(APP_ROOT, 'state.json');
const MARKER = '用量响应摘要';

/** Resolve a config path against the application root. */
function appPath(value, fallback) {
  const target = value || fallback;
  if (!target) return null;
  return isAbsolute(target) ? target : resolve(APP_ROOT, target);
}

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
  // The apply layer is a separate, replaceable program. The monitoring layer
  // only knows its path and hands over the remaining credits through the
  // REMAINING_CREDITS environment variable.
  config.applyScript = process.env.QODER_CREDIT_APPLY_SCRIPT
    || appPath(config.paths?.applyScript, join('apply', 'apply-pku.mjs'));
  config.stateFile = process.env.QODER_CREDIT_STATE_FILE || STATE_FILE;
  config.lockFile = process.env.QODER_CREDIT_LOCK_FILE || DEFAULT_LOCK_FILE;
  config.heartbeatFile = process.env.QODER_CREDIT_HEARTBEAT_FILE || join(APP_ROOT, 'watch.heartbeat');
  config.watchLogFile = process.env.QODER_CREDIT_WATCH_LOG_FILE || join(APP_ROOT, 'watch.log');
  config.watchLockFile = process.env.QODER_CREDIT_WATCH_LOCK_FILE || join(APP_ROOT, 'watch.lock');
  config.applyLogFile = process.env.QODER_CREDIT_APPLY_LOG_FILE
    || appPath(config.paths?.applyLogFile, 'apply.log');
  // Log files are bounded: the watcher appends one line per minute forever, so
  // they are trimmed to their tail once they pass the cap.
  config.maxLogBytes = Number(process.env.QODER_CREDIT_MAX_LOG_BYTES ?? config.maxLogBytes ?? 1024 * 1024);
  config.keepLogBytes = Number(process.env.QODER_CREDIT_KEEP_LOG_BYTES ?? config.keepLogBytes ?? 256 * 1024);
  // Which process means "Qoder Desktop is open". An empty list disables the guard.
  config.guard = config.guard ?? {};
  config.guard.enabled = process.env.QODER_CREDIT_GUARD
    ? process.env.QODER_CREDIT_GUARD !== '0'
    : config.guard.enabled !== false;
  config.guard.processNames = process.env.QODER_CREDIT_GUARD_PROCESSES
    ? process.env.QODER_CREDIT_GUARD_PROCESSES.split(',').map((s) => s.trim()).filter(Boolean)
    : (config.guard.processNames ?? ['Qoder CN.exe', 'Qoder.exe']);
  return config;
}

/**
 * Is Qoder Desktop running right now?
 *
 * Only the local process list is consulted; nothing is polled over the network.
 * If tasklist cannot answer, the check falls back to "the Qoder log was written
 * recently", which is a good enough proxy: that log only grows while Qoder runs.
 */
function qoderRunning(config) {
  const guard = config.guard ?? {};
  if (!guard.enabled) return true;
  const names = guard.processNames ?? [];
  if (!names.length) return true;
  let listed = false;
  for (const name of names) {
    let out = '';
    try {
      out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      });
    } catch {
      continue;
    }
    listed = true;
    for (const line of out.split(/\r?\n/)) {
      const match = /^"([^"]+)"/.exec(line.trim());
      if (match && match[1].toLowerCase() === name.toLowerCase()) return true;
    }
  }
  if (listed) return false;
  const entry = findLatestLogFile(config);
  if (!entry) return false;
  const maxAgeMs = Number(guard.logActivityFallbackMinutes ?? 10) * 60000;
  return Date.now() - entry.mtime < maxAgeMs;
}

/** True when a recent run of the watcher refreshed its heartbeat. */
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
      appliedCap: null,
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
 *
 * `force` is used for one deliberate downgrade: when the credits come back
 * above the threshold, the machine is re-armed so that the next shortage can
 * trigger a new application. That downgrade must survive the "submitted"
 * protection, otherwise a single application would block the rest of the
 * month.
 */
function mergeSave(state, stateFile = STATE_FILE, options = {}) {
  const disk = loadState(stateFile);
  if (disk.cycleKey !== state.cycleKey) {
    saveState(state, stateFile);
    return state;
  }
  const merged = { ...disk, ...state };
  // The audit trail of the last application survives every rewrite.
  if (merged.appliedAt === undefined) merged.appliedAt = disk.appliedAt;
  if (merged.applicationId === undefined) merged.applicationId = disk.applicationId;
  if (
    !options.force
    && TERMINAL_STAGES.has(disk.stage)
    && !TERMINAL_STAGES.has(state.stage)
  ) {
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Sum of the numeric quota caps. Every granted batch enlarges the cap (observed
 * 2000 -> 4000 -> 6000 inside a single quota cycle), so a growing cap proves
 * that new credits were granted after the last application - which is the
 * signal used to tell "still waiting for the grant" from "the grant landed,
 * and the balance dropped again".
 */
function computeCapSignal(qoderUsage) {
  const caps = [];
  const add = (pack) => {
    if (!pack || pack === 'missing' || typeof pack !== 'object') return;
    if (Number.isFinite(pack.cap)) caps.push(pack.cap);
  };
  add(qoderUsage?.userQuota);
  add(qoderUsage?.orgResourcePackage);
  add(qoderUsage?.addOnQuota);
  const dedicated = Array.isArray(qoderUsage?.dedicatedResourcePackages)
    ? qoderUsage.dedicatedResourcePackages
    : [];
  for (const pack of dedicated) add(pack);
  return caps.length ? caps.reduce((sum, cap) => sum + cap, 0) : null;
}


const DEFAULT_LOCK_FILE = join(APP_ROOT, 'apply.lock');

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
  const logFile = config.applyLogFile || join(APP_ROOT, 'apply.log');
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
  const capNow = computeCapSignal(qoderUsage);
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
    state.appliedCap = null;
    state.note = 'new quota cycle';
  }
  // Captured before the state is overwritten: in a burst the same snapshot is
  // re-read every few seconds, and an identical result must not be logged or
  // written again.
  const previousEffective = state.effectiveRemaining;
  const previousSnapshotAt = state.snapshotAt;

  state.cycleKey = cycleKey;
  state.effectiveRemaining = effective;
  state.breakdown = breakdown;
  state.snapshotAt = snapshot.timestamp;
  state.lastCheckedAt = new Date().toISOString();

  const threshold = config.threshold;
  const below = effective <= threshold;
  // Save options for this run: `force` lets a deliberate downgrade win over the
  // "submitted" mark of an earlier application.
  let saveOptions = {};
  // In a burst the same value is looked at every few seconds; repeating the
  // identical line and the identical state write adds only noise.
  const unchanged = previousEffective === effective && previousSnapshotAt === snapshot.timestamp;
  const quiet = Boolean(options.quietIdle) && unchanged;
  // When the last application was made, against which cap level.
  const appliedAtMs = state.appliedAt ? Date.parse(state.appliedAt) : 0;
  const sinceApplied = appliedAtMs ? Date.now() - appliedAtMs : Infinity;
  const capAdvanced =
    Number.isFinite(state.appliedCap) && Number.isFinite(capNow) && capNow > state.appliedCap;

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
      const wasSubmitted = state.stage === 'submitted';
      state.stage = 'idle';
      state.note = wasSubmitted
        ? 'credits replenished - re-armed, the next shortage applies again'
        : null;
      if (wasSubmitted) {
        log('credits replenished above the threshold - re-armed (no monthly application limit)');
      }
      // "submitted" is only terminal while the shortage it answered is still
      // current. Once the balance recovered, the downgrade to "idle" must win.
      mergeSave(state, config.stateFile, { force: true });
    } else if (!quiet) {
      mergeSave(state, config.stateFile);
    }
    if (!quiet) log(`effective remaining ${effective} > threshold ${threshold} - idle`);
    return { ok: true, effective, breakdown, below: false, stage: state.stage };
  }

  if (state.stage === 'idle') {
    state.stage = 'triggered';
    state.triggeredAt = new Date().toISOString();
    state.note = 'threshold reached';
    log(`effective remaining ${effective} <= threshold ${threshold} - TRIGGERED`);
  } else if (state.stage === 'submitted') {
    // An application for this shortage is already out. A new one is allowed as
    // soon as the granted batch arrived (the cap grew) or after the cooldown,
    // in case the previous application was rejected or never processed.
    const cooldownMs = Number(config.escalation?.resubmitCooldownMs ?? 6 * 3600 * 1000);
    if (capAdvanced || sinceApplied > cooldownMs) {
      state.stage = 'triggered';
      state.triggeredAt = new Date().toISOString();
      state.note = capAdvanced
        ? 'new credits granted and the balance is low again - applying again'
        : 'the previous application did not arrive - applying again';
      // From here on the new application owns the state: the "submitted" mark of
      // the previous run must not win over the deliberate downgrade.
      saveOptions = { force: true };
      log(
        `effective remaining ${effective} <= threshold ${threshold} - RE-APPLYING (${state.note})`,
      );
    } else {
      const waitMin = Math.max(0, Math.round((cooldownMs - sinceApplied) / 60000));
      if (!quiet) {
        log(
          `effective remaining ${effective} <= threshold ${threshold} - stage=submitted `
          + `(waiting for the granted batch, next attempt allowed in ~${waitMin} min)`,
        );
        mergeSave(state, config.stateFile);
      }
      return { ok: true, effective, breakdown, below: true, stage: state.stage, skipped: true };
    }
  } else if (!quiet) {
    log(`effective remaining ${effective} <= threshold ${threshold} - stage=${state.stage}`);
  }

  if (options.dryRun) {
    state.note = 'dry-run';
    mergeSave(state, config.stateFile, saveOptions);
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
    const diskAppliedAtMs = disk.appliedAt ? Date.parse(disk.appliedAt) : 0;
    if (
      disk.stage === 'submitted'
      && disk.cycleKey === state.cycleKey
      && diskAppliedAtMs > appliedAtMs
    ) {
      log('a submission finished in the meantime - skipping dispatch');
      mergeSave(state, config.stateFile, saveOptions);
      return { ok: true, effective, breakdown, below: true, stage: disk.stage, skipped: true };
    }
    if (!acquireLock(config.lockFile)) {
      log('another submission is already in flight, skipping dispatch');
      mergeSave(state, config.stateFile, saveOptions);
      return { ok: true, effective, breakdown, below: true, stage: state.stage, locked: true };
    }
    // Persist the dispatch BEFORE spawning the submission script: the script marks
    // the state as "submitted" on its own, and it must not overwrite the
    // dispatchedAt/dispatch bookkeeping with a stale copy of the state file.
    state.stage = 'dispatched';
    state.dispatchedAt = new Date().toISOString();
    state.note = 'local browser submission started';
    state.lastError = null;
    // Remember the grant level this application was made against, so a later
    // cap increase can be recognised as "new credits arrived".
    if (Number.isFinite(capNow)) state.appliedCap = capNow;
    mergeSave(state, config.stateFile, saveOptions);
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

  mergeSave(state, config.stateFile, saveOptions);
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

/**
 * Record that the monitor ran. The fallback task uses this to tell "the
 * scheduled monitor is alive" from "it died and nobody noticed".
 */
function writeHeartbeat(config, extra = {}) {
  try {
    writeFileSync(
      config.heartbeatFile,
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...extra }),
      'utf8',
    );
  } catch {
    /* ignore */
  }
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
    state.appliedCap = null;
    state.note = 'manually reset';
    saveState(state, config.stateFile);
    releaseLock(config.lockFile);
    console.log('state reset to idle');
    return;
  }

  if (args.tick) {
    // Scheduled entry point. Everything the monitor does is gated on Qoder
    // Desktop actually running: while Qoder is closed there is no fresh quota
    // in the log, and the point of the task is to never monitor on its own.
    setLogFileSink(config.watchLogFile);
    // `--burst`: the task wakes up once a minute and then keeps looking for ~40
    // seconds instead of a single glance, so the balance is sampled every few
    // seconds. Still no resident process - the burst ends by itself, and if
    // Qoder is closed the very first check stops it immediately. The ~20 s gap
    // left before the next wake-up matters: with IgnoreNew, a still-running
    // burst makes Task Scheduler refuse the next trigger.
    const burst = Boolean(args.burst);
    const burstIntervalMs = Number(
      process.env.QODER_CREDIT_BURST_INTERVAL_MS ?? config.burst?.intervalMs ?? 5000,
    );
    const burstDurationMs = Number(
      process.env.QODER_CREDIT_BURST_DURATION_MS ?? config.burst?.durationMs ?? 40000,
    );
    const deadline = burst ? Date.now() + burstDurationMs : 0;
    let checks = 0;
    let result = null;
    for (;;) {
      checks += 1;
      const running = qoderRunning(config);
      writeHeartbeat(config, { qoderRunning: running, burst, checks });
      if (!running) {
        log(checks === 1
          ? 'qoder is not running - nothing to monitor'
          : 'qoder was closed mid-burst - stopping');
        return;
      }
      result = await evaluate(config, { quietIdle: burst });
      if (result.dispatched) break;
      if (!burst || Date.now() + burstIntervalMs > deadline) break;
      await sleep(burstIntervalMs);
    }
    log(
      `tick finished: effective=${result?.effective ?? 'n/a'} stage=${result?.stage ?? 'n/a'}`
      + (checks > 1 ? ` (${checks} checks in this burst)` : ''),
    );
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
    let idleTicks = 0;
    const tick = async () => {
      try {
        if (qoderRunning(config)) {
          idleTicks = 0;
          await evaluate(config, {});
        } else {
          idleTicks += 1;
          log('qoder is not running - skipping evaluation');
          if (idleTicks >= 5) {
            log('qoder stayed closed - stopping the resident watcher');
            process.exit(0);
          }
        }
      } catch (error) {
        log('evaluation error:', error.message || error);
      }
      writeHeartbeat(config, { qoderRunning: idleTicks === 0 });
      refreshWatcherLock(config.watchLockFile);
    };
    await tick();
    setInterval(tick, config.pollIntervalMs);
    return;
  }

  // Fallback check (scheduled task): if the resident watcher is alive, do nothing
  // so the two processes never fight over state.json.
  if (args.fallback) {
    if (watcherAlive(config, Number(config.heartbeatAliveMs ?? 300000))) {
      log('watcher alive - fallback check skipped');
      return;
    }
    if (!qoderRunning(config)) {
      log('qoder is not running - fallback check skipped');
      return;
    }
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
