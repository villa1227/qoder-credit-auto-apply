/**
 * Submit the Qoder credit quota application on the PKU service portal (办事大厅).
 *
 * This is the "apply layer": the only part of the project that knows a concrete
 * portal. The monitoring layer (monitor/) is school agnostic and calls this
 * script when the credit balance is low. Anyone who wants a different portal
 * replaces this folder, or points config.paths.applyScript at their own script -
 * see apply/README.md.
 *
 * Flow (verified against the live site on 2026-11-27):
 *   1. open https://wsyy.pku.edu.cn/fe/site/matterDetails?app_id=575
 *   2. click "立即申请" -> the same tab navigates to
 *      https://wsyy.pku.edu.cn/fe/taskCenter/matterApplication?app_id=575
 *   3. fill the 申请事由 textarea (placeholder "请输入申请事由") with "剩余<NNN>credits"
 *   4. click "立即提交"
 *
 * The browser is a local Edge instance driven over CDP (no npm dependencies),
 * so no Agent turn and no Qoder credits are consumed - the application still goes
 * out even when the credit balance is exhausted.
 *
 * The page also carries an AI chat box ("边聊边办") and a "保存草稿" button;
 * both are explicitly avoided when picking the reason field and the submit button.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Browser, Page, launchBrowser, isPortAlive, sleep } from './browser-driver.mjs';
import { handleApproverDialog } from './approver-dialog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The application root is the parent of this folder; the config, the runtime
// files and the artifacts directory all live there.
const APP_ROOT = dirname(HERE);
const CONFIG_FILE = join(APP_ROOT, 'config.json');
const ARTIFACT_DIR = join(APP_ROOT, 'artifacts');

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
}

/** Resolve a config path against the application root. */
function appPath(value, fallback) {
  const target = value || fallback;
  if (!target) return null;
  return isAbsolute(target) ? target : resolve(APP_ROOT, target);
}

/**
 * Keep the artifacts directory bounded: every run drops screenshots and page
 * dumps there. The files have fixed names, so they are overwritten rather than
 * accumulated, but the directory still gets a hard size cap - the oldest files
 * are deleted once the cap is exceeded.
 */
function pruneArtifacts(dir, maxBytes = 20 * 1024 * 1024) {
  try {
    const files = [];
    let total = 0;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        files.push({ path, size: stat.size, mtime: stat.mtimeMs });
        total += stat.size;
      } catch {
        /* ignore */
      }
    }
    if (total <= maxBytes) return { total, removed: 0 };
    files.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const file of files) {
      if (total <= maxBytes) break;
      try {
        unlinkSync(file.path);
        total -= file.size;
        removed += 1;
      } catch {
        /* ignore */
      }
    }
    return { total, removed };
  } catch {
    return { total: 0, removed: 0 };
  }
}

/**
 * Report the outcome back to the monitoring layer, so the state machine knows
 * whether the application went through. The monitoring script is looked up in
 * the config (config.paths.monitorScript) - the apply layer never hardcodes it.
 */
function markState(stage, { note, applicationId } = {}) {
  const args = ['--mark', stage];
  if (note) args.push('--note', note);
  if (applicationId) args.push('--application-id', applicationId);
  const monitor = appPath(loadConfig().paths?.monitorScript, join('monitor', 'credit-watch.mjs'));
  spawnSync(process.execPath, [monitor, ...args], { stdio: 'inherit' });
}

/** Ensure a browser with our dedicated profile is running and connected. */
async function ensureBrowser(config) {
  const port = config.browser.port ?? 9333;
  const profileDir = appPath(config.browser.profileDir, 'browser-profile');
  if (!(await isPortAlive(port))) {
    log('launching browser...');
    await launchBrowser({ port, profileDir, headless: Boolean(config.browser.headless) });
    log('browser started on port', port, 'profile', profileDir);
  } else {
    log('reusing running browser on port', port);
  }
  const browser = await Browser.connect(port);
  return { browser, profileDir };
}

/**
 * Click an element by its visible text using a real (trusted) mouse event.
 * Exact match wins over "starts with", which wins over "contains" - the portal
 * offers both "立即提交" and "保存草稿", and "提交" must never hit "保存草稿".
 */
async function clickByText(page, text, { timeoutMs = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const script = `
      const wanted = ${JSON.stringify(text)};
      const nodes = Array.from(document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit],span,div,i,li'));
      const visible = nodes.filter((el) => el.getClientRects().length > 0);
      const label = (el) => (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
      const candidates = visible
        .map((el) => ({ el, text: label(el) }))
        .filter((c) => c.text && !c.text.includes('\\n'));
      const exact = candidates.find((c) => c.text === wanted);
      const starts = candidates.find((c) => c.text.startsWith(wanted));
      const loose = candidates.find((c) => c.text.includes(wanted));
      const hit = exact || starts || loose;
      if (!hit) return { clicked: false, visibleTexts: candidates.slice(0, 40).map((c) => c.text) };
      const target = hit.el.closest('button,a,[role=button]') || hit.el;
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      return {
        clicked: false,
        pending: true,
        text: hit.text,
        tag: target.tagName,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    `;
    const found = await page.evaluate(script);
    if (found?.pending) {
      // let the SPA finish attaching its handlers before clicking
      await sleep(600);
      // a background tab silently drops input events - make sure it is in front
      await page.activate();
      await sleep(300);
      await page.clickAt(found.x, found.y);
      return { clicked: true, text: found.text, tag: found.tag };
    }
    if (Date.now() >= deadline) return found;
    await sleep(700);
  }
}

/**
 * Watch for human interaction on the page.
 * The script and a human in the same browser window fight over the form: the
 * human edits the reason field while the script clicks, and the result looks
 * like "the script did not submit". The watcher is armed AFTER the form has
 * been filled, so the script's own input events are not counted.
 */
async function armActivityWatcher(page) {
  return page.evaluate(`
    window.__qoderUserActivity = 0;
    if (!window.__qoderActivityArmed) {
      window.__qoderActivityArmed = true;
      for (const evt of ['pointerdown', 'keydown', 'input']) {
        document.addEventListener(evt, () => { window.__qoderUserActivity += 1; }, true);
      }
    }
    return true;
  `);
}

async function readUserActivity(page) {
  const count = await page.evaluate('return Number(window.__qoderUserActivity || 0);');
  return Number(count) || 0;
}

/**
 * Wait until the page is left alone for a few seconds.
 * Returns { idle: false } when a human keeps working on it - the caller then
 * gives up for now and lets the state machine retry later.
 */
async function waitForIdleUser(page, timeoutMs = 30000) {
  let last = await readUserActivity(page);
  if (last === 0) return { idle: true, activity: 0 };
  log(`a human touched the form (${last} event(s)) - waiting for it to be idle`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(2500);
    // eslint-disable-next-line no-await-in-loop
    const now = await readUserActivity(page);
    if (now === last) return { idle: true, activity: now };
    last = now;
  }
  return { idle: false, activity: last };
}

/**
 * Locate the submit button and report its state.
 * "Found" is not enough: a disabled button or a stale coordinate means the
 * click would go nowhere, so the state is captured right before the click.
 */
async function probeSubmitButton(page, text) {
  const script = `
    const wanted = ${JSON.stringify(text)};
    const nodes = Array.from(document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]'));
    const visible = nodes.filter((el) => el.getClientRects().length > 0);
    const label = (el) => (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    const candidates = visible.map((el) => ({ el, text: label(el) })).filter((c) => c.text);
    const hit = candidates.find((c) => c.text === wanted)
      || candidates.find((c) => c.text.startsWith(wanted))
      || candidates.find((c) => c.text.includes(wanted));
    if (!hit) return { found: false, texts: candidates.map((c) => c.text).slice(0, 40) };
    const target = hit.el.closest('button,a,[role=button]') || hit.el;
    target.scrollIntoView({ block: 'center' });
    const rect = target.getBoundingClientRect();
    return {
      found: true,
      text: hit.text,
      tag: target.tagName,
      disabled: Boolean(target.disabled) || target.getAttribute('aria-disabled') === 'true',
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  `;
  return page.evaluate(script);
}

/**
 * Arm a capture-phase interceptor on the submit button.
 * The click is swallowed and counted, so the portal never receives it: this
 * proves that the synthetic mouse event really reaches the button, without
 * creating an application.
 */
async function armSubmitInterceptor(page, texts) {
  const script = `
    const texts = ${JSON.stringify(texts)};
    const nodes = Array.from(document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]'));
    const visible = nodes.filter((el) => el.getClientRects().length > 0);
    const label = (el) => (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim();
    const labelled = visible.map((el) => ({ el, text: label(el) }));
    let hit = null;
    for (const wanted of texts) {
      hit = labelled.find((c) => c.text === wanted) || labelled.find((c) => c.text.startsWith(wanted));
      if (hit) break;
    }
    if (!hit) return { ok: false };
    const target = hit.el.closest('button,a,[role=button]') || hit.el;
    window.__qoderSubmitHits = 0;
    target.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      window.__qoderSubmitHits += 1;
    }, true);
    target.scrollIntoView({ block: 'center' });
    const rect = target.getBoundingClientRect();
    return {
      ok: true,
      button: {
        text: hit.text,
        tag: target.tagName,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      },
    };
  `;
  return page.evaluate(script);
}

/** How often the interceptor caught a click. */
async function readInterceptorCount(page) {
  const count = await page.evaluate('return Number(window.__qoderSubmitHits || 0);');
  return Number(count) || 0;
}

const SUBMIT_OK_PATTERN = /(提交成功|申请成功|提交申请成功|受理成功|已成功提交)/;
const SUBMIT_REJECT_PATTERN = /(请输入申请事由|请填写|不能为空|必填|格式不正确|请完善)/;

/**
 * What does the portal currently say about the submission?
 *
 * The whole body text must NOT be used: the "边聊边办" sidebar contains
 * "查看已提交申请的审批状态" and "检查必填项", which made the first unattended
 * run report a success that never happened. Only real message/toast elements
 * (and the disappearance of the form) are trusted.
 */
async function probeSubmitOutcome(page) {
  const script = `
    const vis = (el) => el && el.getClientRects().length > 0;
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const DIALOG = '[role=dialog],.n-modal,.n-dialog,.ant-modal,.el-dialog,.n-message-box';
    const dialogs = Array.from(document.querySelectorAll(DIALOG)).filter(vis);
    const approverDialog = dialogs.some((d) => /审批人|审批节点/.test(norm(d.innerText)));
    const messages = Array.from(document.querySelectorAll(
      '.n-message,.n-notification,.n-alert,.ant-message,.ant-notification,.el-message,.el-notification,[role=alert],[class*=toast],[class*=Toast]'
    )).filter((el) => vis(el) && !el.closest(DIALOG))
      .map((el) => norm(el.innerText)).filter(Boolean).join(' | ');
    const textarea = Array.from(document.querySelectorAll('textarea')).some(vis);
    const submitButton = Array.from(document.querySelectorAll('button,a,[role=button]'))
      .some((b) => vis(b) && /立即提交/.test(norm(b.innerText)));
    return { approverDialog, messages, formOpen: textarea || submitButton, url: location.href };
  `;
  return page.evaluate(script);
}

/**
 * Wait until the portal says what happened. A dispatched click is not a
 * submission - only the page itself can tell the two apart.
 *
 * `needsApprover` is returned as soon as the "请选择下一个节点审批人" modal
 * appears; that step must be handled before any success can be expected.
 */
async function waitForSubmitOutcome(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  let formClosedStreak = 0;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const seen = await probeSubmitOutcome(page).catch(() => null);
    if (seen) {
      text = seen.messages || text;
      if (seen.approverDialog) return { ok: false, rejected: false, needsApprover: true, text };
      if (SUBMIT_OK_PATTERN.test(seen.messages)) return { ok: true, rejected: false, text };
      if (SUBMIT_REJECT_PATTERN.test(seen.messages)) return { ok: false, rejected: true, text };
      // Two consecutive polls without the form: the portal navigated away
      // (usually to the list of applications), which means it was accepted.
      formClosedStreak = seen.formOpen ? 0 : formClosedStreak + 1;
      if (formClosedStreak >= 2) return { ok: true, rejected: false, text: `form closed (${seen.url})` };
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(700);
  }
  return { ok: false, rejected: false, text };
}

/**
 * Open the application form: click "立即申请" and wait for the form page.
 * The portal either navigates in place or opens a new tab; both are handled.
 */
async function openForm(browser, page, config) {
  const applyText = config.browser.applyButtonText ?? '立即申请';
  const formPattern = config.application?.formUrlPattern ?? 'matterApplication';
  const deadline = Date.now() + 90000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const tabsBefore = new Set((await browser.listPages()).map((t) => t.targetId));
    // A leftover draft prompt covers the button; a click that lands on the
    // dialog is swallowed and the form never opens. Clear it before clicking.
    // eslint-disable-next-line no-await-in-loop
    await dismissDialogs(page, config);
    const clicked = await clickByText(page, applyText, { timeoutMs: 10000 });
    if (clicked?.clicked) {
      log('clicked', applyText, `(attempt ${attempt})`);
      const formDeadline = Date.now() + 15000;
      while (Date.now() < formDeadline) {
        await sleep(800);
        const tabs = await browser.listPages();
        const httpTabs = tabs.filter((t) => /^https?:/.test(t.url || ''));
        const formTab = httpTabs.find((t) => !tabsBefore.has(t.targetId) && (t.url || '').includes(formPattern))
          ?? httpTabs.find((t) => (t.url || '').includes(formPattern));
        if (formTab) {
          const attached = await attachWithRetry(browser, formTab.targetId);
          await sleep(1500);
          return attached;
        }
      }
      log('form did not open after clicking - retrying');
    }
    await sleep(1500);
  }
  throw new Error('FORM_NOT_OPEN');
}

/** Dump the visible structure of the page (for form discovery / diagnostics). */
async function inspectPage(page) {
  const script = `
    const fields = Array.from(document.querySelectorAll('input,textarea,select')).map((el) => ({
      tag: el.tagName,
      type: el.type || null,
      name: el.name || null,
      id: el.id || null,
      placeholder: el.placeholder || null,
      aria: el.getAttribute('aria-label') || null,
      value: el.value ? String(el.value).slice(0, 60) : '',
      visible: el.getClientRects().length > 0,
      label: (() => {
        const wrapper = el.closest('.el-form-item,.ant-form-item,label,.form-item,[class*=form-item],tr');
        return wrapper ? wrapper.innerText.replace(/\\s+/g, ' ').trim().slice(0, 100) : null;
      })(),
    }));
    const buttons = Array.from(document.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]'))
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ tag: el.tagName, text: (el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().slice(0, 40) }))
      .filter((item) => item.text);
    const bodyText = document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 2000);
    return { title: document.title, url: location.href, fields, buttons, bodyText };
  `;
  return page.evaluate(script);
}

/**
 * Fill the 申请事由 field.
 * 1) explicit placeholder/aria selector (most reliable)
 * 2) keyword score over name/id/placeholder/label, ignoring the "边聊边办" chat box
 * 3) fallback: the first visible textarea that is not the chat box
 */
async function fillReasonField(page, value, keywords, selectors = []) {
  const script = `
    const value = ${JSON.stringify(value)};
    const keywords = ${JSON.stringify(keywords)};
    const selectors = ${JSON.stringify(selectors)};
    const CHAT = /输入消息|Enter ?发送|智能填写|边聊边办/;
    const setValue = (el, next) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, next);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const all = Array.from(document.querySelectorAll('textarea,input[type=text],input:not([type]),input[type=search]'))
      .filter((el) => el.getClientRects().length > 0 && !el.disabled && !el.readOnly);
    if (!all.length) return { ok: false, reason: 'no-input' };
    const meta = (el) => ({
      el,
      placeholder: el.placeholder || '',
      aria: el.getAttribute('aria-label') || '',
      name: el.name || '',
      id: el.id || '',
      label: (el.closest('.el-form-item,.ant-form-item,label,.form-item,[class*=form-item],tr')?.innerText || '').replace(/\\s+/g, ' ').trim(),
    });
    const items = all.map(meta);
    let pick = null;
    let how = null;
    const bySelector = items.find((m) => selectors.some((s) => m.placeholder.includes(s) || m.aria.includes(s)));
    if (bySelector) {
      pick = bySelector;
      how = 'selector';
    } else {
      const score = (m) => {
        if (CHAT.test(m.placeholder) || CHAT.test(m.label)) return -1;
        const hay = [m.name, m.id, m.placeholder, m.aria, m.label].join(' ').toLowerCase();
        return keywords.reduce((sum, key) => sum + (hay.includes(key.toLowerCase()) ? 1 : 0), 0);
      };
      const ranked = items.map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s);
      if (ranked[0].s > 0) {
        pick = ranked[0].m;
        how = 'keyword';
      }
    }
    if (!pick) {
      const areas = items.filter((m) => m.el.tagName === 'TEXTAREA' && !CHAT.test(m.placeholder) && !CHAT.test(m.label));
      if (!areas.length) return { ok: false, reason: 'no-reason-field' };
      pick = areas[0];
      how = 'fallback';
    }
    setValue(pick.el, value);
    return {
      ok: true,
      how,
      tag: pick.el.tagName,
      placeholder: pick.placeholder,
      name: pick.name || pick.id || null,
      value: pick.el.value,
    };
  `;
  return page.evaluate(script);
}

/**
 * The portal shows a modal when a draft exists:
 *   "已记录您在 ... 填写过内容，重新开始还是继续填写？" [重新开始] [继续填写]
 * It blocks the form, so it must be dismissed before anything can be filled.
 */
async function handleDialog(page, choices) {
  const script = `
    const choices = ${JSON.stringify(choices)};
    const containers = Array.from(document.querySelectorAll('[role=dialog],.n-modal,.n-dialog,.ant-modal,.el-dialog,.n-message-box'));
    for (const c of containers) {
      if (!c.getClientRects().length) continue;
      const btns = Array.from(c.querySelectorAll('button,a,[role=button]'))
        .filter((b) => b.getClientRects().length > 0)
        .map((b) => ({ b, text: (b.innerText || b.value || '').replace(/\\s+/g, ' ').trim() }))
        .filter((x) => x.text);
      for (const want of choices) {
        const hit = btns.find((x) => x.text === want) || btns.find((x) => x.text.includes(want));
        if (hit) {
          const r = hit.b.getBoundingClientRect();
          return { found: true, text: hit.text, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    return { found: false };
  `;
  const found = await page.evaluate(script);
  if (!found.found) return null;
  await page.activate();
  await sleep(300);
  await page.clickAt(found.x, found.y);
  return found.text;
}

/** Dismiss every modal the portal puts in the way (draft prompt, confirmations). */
async function dismissDialogs(page, config) {
  const choices = [
    config.browser.draftDialogChoice ?? '重新开始',
    '继续填写',
    // A leftover "请选择下一个节点审批人" modal from an earlier attempt belongs to
    // nobody now: back out of it instead of confirming an approval blindly.
    '返回',
    '确定',
    '确认',
  ];
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const clicked = await handleDialog(page, choices);
    if (!clicked) return i > 0;
    log('handled dialog ->', clicked);
    // eslint-disable-next-line no-await-in-loop
    await sleep(2500);
  }
  return true;
}

/** Wait until the 申请事由 field is present in the DOM. */
async function waitForReasonField(page, selectors, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await page.evaluate(`
      const selectors = ${JSON.stringify(selectors)};
      const all = Array.from(document.querySelectorAll('textarea,input[type=text],input:not([type]),input[type=search]'));
      const visible = all.filter((el) => el.getClientRects().length > 0 && !el.disabled && !el.readOnly);
      const hit = visible.find((el) => selectors.some((s) => (el.placeholder || '').includes(s) || (el.getAttribute('aria-label') || '').includes(s)));
      return { count: visible.length, hit: Boolean(hit) };
    `);
    if (found?.hit) return true;
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}

async function readPageText(page, limit = 1200) {
  return page.evaluate(`return document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, ${limit});`);
}

/** Attach to a target, retrying while the browser is still swapping the tab. */
async function attachWithRetry(browser, targetId, attempts = 8) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await browser.attach(targetId);
    } catch (error) {
      lastError = error;
      // eslint-disable-next-line no-await-in-loop
      await sleep(800);
    }
  }
  throw lastError;
}

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);
  const mode = args.includes('--inspect')
    ? 'inspect'
    : args.includes('--verify-click')
      ? 'verify-click'
      : 'apply';
  const dryRun = args.includes('--dry-run');
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  // The remaining credits come from the monitoring layer. 0 is a perfectly
  // meaningful value (the quota ran out completely), so only a missing or
  // unparsable value falls back to the threshold - a truthy check would turn
  // "0 credits left" into "150 credits left" in the application reason.
  const rawRemaining = process.env.REMAINING_CREDITS;
  const parsedRemaining = rawRemaining === undefined || rawRemaining === '' ? NaN : Number(rawRemaining);
  const remaining = Number.isFinite(parsedRemaining) ? parsedRemaining : Number(config.threshold ?? 0);
  const artifactMaxBytes = Number(config.artifactMaxBytes ?? config.browser?.artifactMaxBytes ?? 20 * 1024 * 1024);
  const prunedBefore = pruneArtifacts(ARTIFACT_DIR, artifactMaxBytes);
  if (prunedBefore.removed) {
    log(`artifacts pruned before run: removed ${prunedBefore.removed} file(s), now ${prunedBefore.total} bytes`);
  }
  const { browser } = await ensureBrowser(config);
  let exitCode = 0;
  try {
    const url = config.application.url;
    const portalHosts = config.application?.portalHosts ?? ['wsyy.pku.edu.cn', 'iaaa.pku.edu.cn'];
    const loginPattern = config.application?.loginUrlPattern ?? 'iaaa.pku.edu.cn';
    // Prefer a tab that shows the matter details page; otherwise reuse any portal
    // tab (that is the window the user is logging in on); otherwise open a new one.
    let page = null;
    const openTabs = await browser.listPages();
    const detailsPattern = config.application?.detailsUrlPattern ?? 'matterDetails';
    const detailsTab = openTabs.find((t) => (t.url || '').includes(detailsPattern));
    const anyPortalTab = openTabs.find((t) => portalHosts.some((host) => (t.url || '').includes(host)));
    if (detailsTab) {
      page = await browser.attach(detailsTab.targetId);
      log('reusing tab at', detailsTab.url.slice(0, 90));
    } else if (anyPortalTab) {
      page = await browser.attach(anyPortalTab.targetId);
      log('reusing portal tab at', anyPortalTab.url.slice(0, 90));
    } else {
      page = await browser.newPage('about:blank');
    }
    await page.navigate(url);
    log('opened', await page.url());

    // 1. login handling
    let currentUrl = (await page.url()) || '';
    if (currentUrl.includes(loginPattern)) {
      const waitMinutes = config.browser.waitLoginMinutes ?? 20;
      log('login required - complete it in the browser window; waiting up to', waitMinutes, 'min');
      const deadline = Date.now() + waitMinutes * 60000;
      while (Date.now() < deadline) {
        await sleep(3000);
        currentUrl = (await page.url().catch(() => currentUrl)) || currentUrl;
        if (!currentUrl.includes(loginPattern)) break;
      }
      if (currentUrl.includes(loginPattern)) {
        await page.screenshot(join(ARTIFACT_DIR, 'login-timeout.png'));
        throw new Error('LOGIN_TIMEOUT');
      }
      await page.navigate(url);
      log('logged in, back at', await page.url());
    }

    if (mode === 'inspect') {
      const structure = await inspectPage(page);
      const file = join(ARTIFACT_DIR, 'matter-structure.json');
      writeFileSync(file, JSON.stringify(structure, null, 2), 'utf8');
      console.log(JSON.stringify(structure, null, 2));
      log('structure written to', file);
      await page.screenshot(join(ARTIFACT_DIR, 'matter.png'));
      return;
    }

    // 2. open the application form
    page = await openForm(browser, page, config);
    log('form url', await page.url());
    // the portal may show a "resume the draft?" modal that hides the form
    await dismissDialogs(page, config);

    // 3. fill 申请事由
    const reason = (config.browser.reasonTemplate ?? '剩余{remaining}credits').replace(
      '{remaining}',
      String(remaining),
    );
    const keywords = config.browser.reasonFieldKeywords
      ?? ['事由', '原因', '理由', 'reason', 'cause', 'content', 'remark', 'description'];
    const selectors = config.browser.reasonFieldSelectors ?? ['请输入申请事由'];
    // the form renders asynchronously - wait for the reason field to appear
    const hasField = await waitForReasonField(page, selectors, 30000);
    log('reason field present:', hasField);
    const filled = await fillReasonField(page, reason, keywords, selectors);
    log('filled reason:', JSON.stringify(filled));
    if (!filled.ok) {
      const dump = await inspectPage(page);
      writeFileSync(join(ARTIFACT_DIR, 'no-reason-field.json'), JSON.stringify(dump, null, 2), 'utf8');
      throw new Error('REASON_FIELD_NOT_FOUND');
    }
    await page.screenshot(join(ARTIFACT_DIR, 'before-submit.png'));

    // From here on, any input on the page comes from a human.
    await armActivityWatcher(page);

    const submitTexts = config.browser.submitButtonTexts ?? ['立即提交'];

    if (dryRun) {
      log('dry-run: not submitting');
      console.log(`DRY_RUN_FILLED reason=${reason} field=${JSON.stringify(filled)}`);
      exitCode = 0;
      return;
    }

    // Do not fight a human over the same form: if someone is still working in
    // the window, wait for them to stop and only then submit.
    const idle = await waitForIdleUser(page);
    if (!idle.idle) {
      log('the form is still being edited by a human - skipping this submission');
      console.log(`SKIPPED_USER_ACTIVE reason=${reason}`);
      throw new Error('USER_ACTIVITY');
    }
    if (idle.activity > 0) {
      log(`the form was edited by a human (${idle.activity} event(s)) - submitting the current content`);
    }

    if (mode === 'verify-click') {
      // Verify the synthetic click without creating an application: the button
      // gets a capture-phase interceptor that swallows the click and counts it.
      // If the counter goes up, the mouse event really reached the button.
      const armed = await armSubmitInterceptor(page, submitTexts);
      if (!armed.ok) {
        throw new Error('SUBMIT_BUTTON_NOT_FOUND');
      }
      log('interceptor armed on', JSON.stringify(armed.button));
      await page.activate();
      await sleep(400);
      await page.clickAt(armed.button.x, armed.button.y);
      await sleep(1500);
      const hits = await readInterceptorCount(page);
      await page.screenshot(join(ARTIFACT_DIR, 'verify-click.png'));
      writeFileSync(
        join(ARTIFACT_DIR, 'verify-click.json'),
        JSON.stringify({ armed, hits, reason }, null, 2),
        'utf8',
      );
      if (hits > 0) {
        log('VERIFY_CLICK_OK - the click reached the button, the portal did not see it');
        console.log(`VERIFY_CLICK_OK hits=${hits} reason=${reason}`);
        exitCode = 0;
      } else {
        log('VERIFY_CLICK_FAILED - the click never reached the button');
        console.log(`VERIFY_CLICK_FAILED hits=${hits} reason=${reason}`);
        exitCode = 4;
      }
      return;
    }

    // 4. submit
    let submitted = false;
    const attempts = [];
    for (const text of submitTexts) {
      for (let attempt = 1; attempt <= 2 && !submitted; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const probe = await probeSubmitButton(page, text);
        attempts.push({ text, attempt, ...probe });
        if (!probe.found) break;
        if (probe.disabled) {
          log(`submit button "${text}" is disabled - waiting (attempt ${attempt})`);
          // eslint-disable-next-line no-await-in-loop
          await sleep(2000);
          continue;
        }
        log(
          `clicking submit button "${text}" (attempt ${attempt}) at`,
          Math.round(probe.x), Math.round(probe.y),
        );
        // eslint-disable-next-line no-await-in-loop
        await page.activate();
        // eslint-disable-next-line no-await-in-loop
        await sleep(300);
        // eslint-disable-next-line no-await-in-loop
        await page.clickAt(probe.x, probe.y);
        // eslint-disable-next-line no-await-in-loop
        await page.screenshot(join(ARTIFACT_DIR, `submit-click-${attempt}.png`));
        // Do not assume the click did something: wait for the portal to say so.
        // eslint-disable-next-line no-await-in-loop
        let outcome = await waitForSubmitOutcome(page, 15000);
        if (outcome.needsApprover) {
          // 提交前的最后一步：选择下一个审批节点并确认。
          log('approver selection dialog appeared - ticking the approver');
          // eslint-disable-next-line no-await-in-loop
          const handled = await handleApproverDialog(page, config, sleep);
          // eslint-disable-next-line no-await-in-loop
          await page.screenshot(join(ARTIFACT_DIR, `approver-${attempt}.png`));
          writeFileSync(join(ARTIFACT_DIR, 'approver.json'), JSON.stringify(handled, null, 2), 'utf8');
          log('approver dialog result:', JSON.stringify(handled));
          if (handled.confirmed) {
            // eslint-disable-next-line no-await-in-loop
            outcome = await waitForSubmitOutcome(page, 30000);
          } else {
            outcome = {
              ok: false,
              rejected: true,
              text: `APPROVER_NOT_CONFIRMED ${JSON.stringify(handled)}`,
            };
          }
        }
        if (outcome.ok) {
          submitted = true;
          log('portal confirmed the submission');
          break;
        }
        if (outcome.rejected) {
          log('portal rejected the form:', outcome.text.slice(0, 200));
        } else {
          log('no confirmation after the click, retrying');
        }
        // eslint-disable-next-line no-await-in-loop
        await dismissDialogs(page, config);
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
      }
      if (submitted) break;
    }
    writeFileSync(
      join(ARTIFACT_DIR, 'submit-attempts.json'),
      JSON.stringify(attempts, null, 2),
      'utf8',
    );
    if (!submitted) {
      const dump = await inspectPage(page);
      writeFileSync(join(ARTIFACT_DIR, 'no-submit-button.json'), JSON.stringify(dump, null, 2), 'utf8');
      const clickedAnything = attempts.some((a) => a.found);
      throw new Error(clickedAnything ? 'SUBMIT_NOT_CONFIRMED' : 'SUBMIT_BUTTON_NOT_FOUND');
    }

    // 4b. a confirmation dialog may pop up -> confirm it (dialogs only)
    await dismissDialogs(page, config);

    const after = await readPageText(page);
    await page.screenshot(join(ARTIFACT_DIR, 'after-submit.png'));
    writeFileSync(join(ARTIFACT_DIR, 'after-submit.txt'), after, 'utf8');

    // Never trust the raw body text here: the sidebar contains words like
    // "已提交", which once turned a blocked submission into a fake success.
    const finalState = await probeSubmitOutcome(page).catch(() => null);
    const ok = Boolean(
      finalState
      && !finalState.approverDialog
      && (!finalState.formOpen || SUBMIT_OK_PATTERN.test(finalState.messages)),
    );
    const stillOnForm = Boolean(finalState?.formOpen && !finalState?.approverDialog);
    if (ok) {
      log('SUBMIT SUCCESS');
      console.log(`SUBMIT_SUCCESS reason=${reason}`);
      markState('submitted', { note: `申请已提交，事由：${reason}` });
      exitCode = 0;
    } else if (stillOnForm) {
      // The form is still on screen and nothing confirmed it: the application did
      // NOT go through. Mark it failed so the next tick retries (10 minutes).
      log('the form is still open after submitting - the application did not go through');
      console.log(`SUBMIT_FAILED reason=${reason} text=${after.slice(0, 300)}`);
      markState('failed', { note: '提交未完成（表单仍在页面上），稍后自动重试' });
      exitCode = 1;
    } else {
      log('submit result uncertain, page text:', after.slice(0, 400));
      console.log(`SUBMIT_UNCERTAIN reason=${reason} text=${after.slice(0, 300)}`);
      // Treat as submitted to avoid a duplicate application; the user can verify in the portal.
      markState('submitted', { note: '提交结果不确定（页面无明确成功提示），请人工核实，未重复提交' });
      exitCode = 3;
    }
  } catch (error) {
    log('FAILED:', error.message || error);
    console.log(`FAILED ${error.message || error}`);
    // A dry run and a click verification must not touch the state machine, and
    // they must not release the lock of a submission that may be running now.
    if (!dryRun && mode !== 'verify-click') {
      markState('failed', { note: String(error.message || error).slice(0, 300) });
    }
    exitCode = 1;
  } finally {
    browser.close();
    if (!dryRun && mode !== 'verify-click') {
      try {
        unlinkSync(join(APP_ROOT, 'apply.lock'));
      } catch {
        /* ignore */
      }
    }
    const pruned = pruneArtifacts(ARTIFACT_DIR, artifactMaxBytes);
    if (pruned.removed) {
      log(`artifacts pruned after run: removed ${pruned.removed} file(s), now ${pruned.total} bytes`);
    }
  }
  process.exit(exitCode);
}

main();
