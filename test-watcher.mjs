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
const TMP = join(HERE, 'test-tmp');
const LOG_DIR = join(TMP, 'logs', '20261127-000000.000-test');
const STATE = join(TMP, 'state.json');
const LOCK = join(TMP, 'apply.lock');
const STUB = join(TMP, 'stub-apply.mjs');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(LOG_DIR, { recursive: true });

// The stub mimics apply-pku.mjs: it marks the state as submitted and releases the lock.
writeFileSync(
  STUB,
  `import { spawnSync } from 'node:child_process';\n` +
    `import { unlinkSync } from 'node:fs';\n` +
    `import { join, dirname } from 'node:path';\n` +
    `import { fileURLToPath } from 'node:url';\n` +
    `const here = dirname(fileURLToPath(import.meta.url));\n` +
    `spawnSync(process.execPath, [join(here, '..', 'credit-watch.mjs'), '--mark', 'submitted', '--note', 'stub applied'], { stdio: 'inherit' });\n` +
    `try { unlinkSync(process.env.QODER_CREDIT_LOCK_FILE); } catch {}\n`,
  'utf8',
);

function writeSnapshot(remaining, expiresAt) {
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
        used: 2000 - remaining,
        remaining,
        percentage: 0.5,
        cap: 2000,
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
    [join(HERE, 'credit-watch.mjs'), '--once', ...extraArgs],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        QODER_CREDIT_LOG_DIR: join(TMP, 'logs'),
        QODER_CREDIT_STATE_FILE: STATE,
        QODER_CREDIT_LOCK_FILE: LOCK,
        QODER_CREDIT_APPLY_SCRIPT: STUB,
        ...extraEnv,
      },
    },
  );
  if (result.status !== 0) {
    console.log('--- watcher stdout ---\n' + result.stdout + '\n--- watcher stderr ---\n' + result.stderr);
  }
  return result;
}

function resetState() {
  spawnSync(process.execPath, [join(HERE, 'credit-watch.mjs'), '--reset'], {
    env: { ...process.env, QODER_CREDIT_STATE_FILE: STATE, QODER_CREDIT_LOCK_FILE: LOCK },
    encoding: 'utf8',
  });
}

function state() {
  return JSON.parse(readFileSync(STATE, 'utf8'));
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

if (!process.env.KEEP_TMP) rmSync(TMP, { recursive: true, force: true });
console.log(failures.length === 0 ? '\nALL TESTS PASSED' : `\nFAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
