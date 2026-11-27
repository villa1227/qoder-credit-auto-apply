/**
 * Offline test of the passive detection + state machine + dispatch path.
 * Uses a synthetic log file and a stub submission script, so nothing is
 * submitted to the real portal and no real quota is involved.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const MONITOR = join(HERE, 'credit-watch.mjs');
const TMP = join(HERE, 'test-tmp');
const LOG_DIR = join(TMP, 'logs', '20261127-000000.000-test');
const STATE = join(TMP, 'state.json');
const LOCK = join(TMP, 'apply.lock');
const HEARTBEAT = join(TMP, 'watch.heartbeat');
const STUB = join(TMP, 'stub-apply.mjs');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(LOG_DIR, { recursive: true });

// The stub mimics apply-pku.mjs: it marks the state as submitted and releases the lock.
// It also records the REMAINING_CREDITS it was handed, so the test can check
// that a balance of exactly 0 is passed on as 0 (and not replaced by a fallback).
writeFileSync(
  STUB,
  `import { spawnSync } from 'node:child_process';\n` +
    `import { unlinkSync, writeFileSync } from 'node:fs';\n` +
    `import { join, dirname } from 'node:path';\n` +
    `import { fileURLToPath } from 'node:url';\n` +
    `const here = dirname(fileURLToPath(import.meta.url));\n` +
    `writeFileSync(join(here, 'last-remaining.txt'), String(process.env.REMAINING_CREDITS ?? ''));\n` +
    `spawnSync(process.execPath, [join(here, '..', 'credit-watch.mjs'), '--mark', 'submitted', '--note', 'stub applied'], { stdio: 'inherit' });\n` +
    `try { unlinkSync(process.env.QODER_CREDIT_LOCK_FILE); } catch {}\n`,
  'utf8',
);

function writeSnapshot(remaining, expiresAt, cap = 2000) {
  const payload = {
    operation: 'account.getQuotaUsage',
    status: 200,
    qoderUsage: {
      userType: 'teams',
      usageType: 'credits',
      expiresAt,
      isQuotaExceeded: false,
      userQuota: { total: 750, used: 750, remaining: 0, percentage: 1, unit: 'credits' },
      addOnQuota: 'missing',
      orgResourcePackage: {
        used: cap - remaining,
        remaining,
        percentage: 0.5,
        cap,
        available: true,
        unit: 'credits',
      },
      dedicatedResourcePackages: [],
    },
    enterpriseUsage: 'missing',
  };
  const line = `[${new Date().toISOString()}] [INFO] [main] [Auth] [AccountUsage] 用量响应摘要 ${JSON.stringify(payload)}`;
  writeFileSync(join(LOG_DIR, 'main.log'), `${line}\n`, 'utf8');
}

function runWatcher(extraArgs = [], extraEnv = {}) {
  const result = spawnSync(
    process.execPath,
    [MONITOR, '--once', ...extraArgs],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        QODER_CREDIT_LOG_DIR: join(TMP, 'logs'),
        QODER_CREDIT_STATE_FILE: STATE,
        QODER_CREDIT_LOCK_FILE: LOCK,
        QODER_CREDIT_HEARTBEAT_FILE: HEARTBEAT,
        QODER_CREDIT_WATCH_LOG_FILE: join(TMP, 'watch.log'),
        QODER_CREDIT_APPLY_LOG_FILE: join(TMP, 'apply.log'),
        QODER_CREDIT_APPLY_SCRIPT: STUB,
        // The tests must not depend on Qoder Desktop actually running.
        QODER_CREDIT_GUARD: '0',
        ...extraEnv,
      },
    },
  );
  if (result.status !== 0) {
    console.log('--- watcher stdout ---\n' + result.stdout + '\n--- watcher stderr ---\n' + result.stderr);
  }
  return result;
}

/** Run the scheduled entry point (--tick) with a specific guard setting. */
function runTick(env = {}) {
  const result = spawnSync(process.execPath, [MONITOR, '--tick'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      QODER_CREDIT_LOG_DIR: join(TMP, 'logs'),
      QODER_CREDIT_STATE_FILE: STATE,
      QODER_CREDIT_LOCK_FILE: LOCK,
      QODER_CREDIT_HEARTBEAT_FILE: HEARTBEAT,
      QODER_CREDIT_WATCH_LOG_FILE: join(TMP, 'watch.log'),
      QODER_CREDIT_APPLY_LOG_FILE: join(TMP, 'apply.log'),
      QODER_CREDIT_APPLY_SCRIPT: STUB,
      ...env,
    },
  });
  if (result.status !== 0) {
    console.log('--- tick stdout ---\n' + result.stdout + '\n--- tick stderr ---\n' + result.stderr);
  }
  return result;
}

function resetState() {
  spawnSync(process.execPath, [MONITOR, '--reset'], {
    env: {
      ...process.env,
      QODER_CREDIT_STATE_FILE: STATE,
      QODER_CREDIT_LOCK_FILE: LOCK,
      QODER_CREDIT_HEARTBEAT_FILE: HEARTBEAT,
    },
    encoding: 'utf8',
  });
}

function state() {
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

/** Overwrite a few fields of the state file (to age a timestamp, for example). */
function patchState(patch) {
  const next = { ...state(), ...patch };
  writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** Wait until the stub submission script has advanced the state. */
async function waitForStage(target, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = state().stage;
    if (current === target) return current;
    if (Date.now() >= deadline) return current;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    console.log(`FAIL  ${name} ${detail ?? ''}`);
    failures.push(name);
  }
}

// 1) healthy balance -> idle, no dispatch
writeSnapshot(900, 1796054400000);
runWatcher();
check('healthy balance stays idle', state().stage === 'idle', JSON.stringify(state()));
check('healthy balance not dispatched', !existsSync(LOCK));

// 2) balance below threshold -> triggered + dispatched exactly once
writeSnapshot(120, 1796054400000);
runWatcher();
check('low balance triggers', ['triggered', 'dispatched'].includes(state().stage), JSON.stringify(state()));
check('dispatch recorded', Boolean(state().dispatchedAt), JSON.stringify(state()));
check('effective remaining computed', state().effectiveRemaining === 120, JSON.stringify(state()));
const firstDispatch = state().dispatchedAt;

// the stub marks the state as submitted
await waitForStage('submitted');
check('state after stub', state().stage === 'submitted', JSON.stringify(state()));
check('dispatch bookkeeping survives the stub', state().dispatchedAt === firstDispatch, JSON.stringify(state()));

// 3) same cycle -> no second dispatch
writeSnapshot(100, 1796054400000);
runWatcher();
check('same cycle does not resubmit', state().stage === 'submitted', JSON.stringify(state()));
check('same cycle keeps one dispatch', state().dispatchedAt === firstDispatch, JSON.stringify(state()));

// 4) new cycle -> state machine resets and can trigger again
writeSnapshot(100, 1798214400000);
runWatcher();
check('new cycle dispatches again', Boolean(state().dispatchedAt) && state().dispatchedAt !== firstDispatch, JSON.stringify(state()));
check('cycle key updated', state().cycleKey === '1798214400000', JSON.stringify(state()));
await waitForStage('submitted');
check('new cycle reaches submitted', state().stage === 'submitted', JSON.stringify(state()));

// 5) stale snapshot must not trigger
writeSnapshot(100, 1798214400000);
const staleLog = join(LOG_DIR, 'main.log');
const content = readFileSync(staleLog, 'utf8');
// NOTE: in JS `[^]]` is NOT "not ]" - the escaped form `[^\]]` is required.
const staleContent = content.replace(/\[\d{4}-\d{2}-\d{2}T[^\]]+\]/, '[2020-01-01T00:00:00.000Z]');
check('stale timestamp rewritten', staleContent.includes('2020-01-01'), staleContent.slice(0, 80));
writeFileSync(staleLog, staleContent, 'utf8');
resetState();
runWatcher();
check('stale snapshot does not trigger', state().stage === 'idle', JSON.stringify(state()));
check('stale snapshot noted', String(state().note).includes('stale'), JSON.stringify(state()));
check('stale snapshot not dispatched', !state().dispatchedAt && !existsSync(LOCK), JSON.stringify(state()));

// 6) dry run never dispatches
writeSnapshot(100, 1798214400000);
resetState();
runWatcher(['--dry-run']);
check('dry run does not dispatch', state().stage === 'triggered', JSON.stringify(state()));
check('dry run records no dispatch', !state().dispatchedAt, JSON.stringify(state()));
check('dry run leaves no lock', !existsSync(LOCK));

// 7) the scheduled tick only monitors while Qoder Desktop is running
resetState();
writeSnapshot(100, 1798214400000);
const tickClosed = runTick({
  QODER_CREDIT_GUARD: '1',
  QODER_CREDIT_GUARD_PROCESSES: 'this-process-does-not-exist-9d1f.exe',
});
check('tick with qoder closed does not trigger', state().stage === 'idle', JSON.stringify(state()));
check('tick with qoder closed does not dispatch', !state().dispatchedAt, JSON.stringify(state()));
check('tick with qoder closed exits cleanly', tickClosed.status === 0, String(tickClosed.status));
const beatClosed = existsSync(HEARTBEAT) ? JSON.parse(readFileSync(HEARTBEAT, 'utf8')) : null;
check('heartbeat records qoder closed', beatClosed && beatClosed.qoderRunning === false, JSON.stringify(beatClosed));

// 8) with the guard open (qoder running) the very same tick does trigger
resetState();
writeSnapshot(100, 1798214400000);
const tickOpen = runTick({ QODER_CREDIT_GUARD: '1', QODER_CREDIT_GUARD_PROCESSES: 'explorer.exe' });
check('tick with qoder running triggers', ['triggered', 'dispatched'].includes(state().stage), JSON.stringify(state()));
check('tick with qoder running dispatches', Boolean(state().dispatchedAt), JSON.stringify(state()));
const beatOpen = existsSync(HEARTBEAT) ? JSON.parse(readFileSync(HEARTBEAT, 'utf8')) : null;
check('heartbeat records qoder running', beatOpen && beatOpen.qoderRunning === true, JSON.stringify(beatOpen));
await waitForStage('submitted');
check('tick dispatch reaches submitted', state().stage === 'submitted', JSON.stringify(state()));

// 9) an exhausted balance of exactly 0 must reach the submission script as 0,
//    not as a fallback value - the reason text on the portal depends on it.
resetState();
writeSnapshot(0, 1798214400000);
runWatcher();
await waitForStage('submitted');
const handedOver = existsSync(join(TMP, 'last-remaining.txt'))
  ? readFileSync(join(TMP, 'last-remaining.txt'), 'utf8').trim()
  : null;
check('exhausted balance is handed over as 0', handedOver === '0', String(handedOver));
check('exhausted balance triggers', state().stage === 'submitted', JSON.stringify(state()));

// 10) there is no "one application per quota cycle" rule. A submitted state only
//     suppresses a second application while the previous one is fresh and no new
//     credits have been granted: within the cooldown it must not resubmit.
const afterExhausted = state().dispatchedAt;
writeSnapshot(100, 1798214400000, 2000);
runWatcher();
check('within cooldown no second application', state().dispatchedAt === afterExhausted, JSON.stringify(state()));
check('within cooldown stays submitted', state().stage === 'submitted', JSON.stringify(state()));

// 11) once the cooldown has passed (grant assumed lost/rejected) a fresh
//     application is allowed even though the balance never recovered.
patchState({ appliedAt: new Date(Date.now() - 7 * 3600 * 1000).toISOString() });
writeSnapshot(100, 1798214400000, 2000);
runWatcher();
check('after cooldown a fresh application dispatches', Boolean(state().dispatchedAt) && state().dispatchedAt !== afterExhausted, JSON.stringify(state()));
await waitForStage('submitted');
const afterCooldown = state().dispatchedAt;

// 12) as soon as the granted credits bring the balance back above the threshold,
//     the machine re-arms to idle - the next shortage must apply again.
writeSnapshot(900, 1798214400000, 2000);
runWatcher();
check('credits replenished re-arms to idle', state().stage === 'idle', JSON.stringify(state()));
check('re-arm keeps the last application on record', Boolean(state().appliedAt), JSON.stringify(state()));

// 13) the re-armed machine triggers a new application on the next dip.
writeSnapshot(120, 1798214400000, 2000);
runWatcher();
check('next dip after re-arm dispatches', Boolean(state().dispatchedAt) && state().dispatchedAt !== afterCooldown, JSON.stringify(state()));
await waitForStage('submitted');
const afterRearm = state().dispatchedAt;

// 14) a grant can also land while the balance is still below the threshold: the
//     cap grows, which proves new credits arrived, so another application is
//     allowed immediately - again without any monthly limit.
check('dispatch recorded the grant level', state().appliedCap === 2000, JSON.stringify(state()));
writeSnapshot(80, 1798214400000, 4000);
runWatcher();
check('grown cap allows another application', Boolean(state().dispatchedAt) && state().dispatchedAt !== afterRearm, JSON.stringify(state()));
check('appliedCap follows the grant level', state().appliedCap === 4000, JSON.stringify(state()));
await waitForStage('submitted');
check('grant-triggered application reaches submitted', state().stage === 'submitted', JSON.stringify(state()));

// 15) the offline suite must never write into the production logs.
const watchLogPath = join(TMP, 'watch.log');
check('watch log kept inside the test dir', existsSync(watchLogPath), watchLogPath);

if (!process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true });
console.log(failures.length === 0 ? '\nALL TESTS PASSED' : `\nFAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
