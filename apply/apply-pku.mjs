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
  const mode = args.includes('--inspect') ? 'inspect' : 'apply';
  const dryRun = args.includes('--dry-run');
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const remaining = Number(process.env.REMAINING_CREDITS ?? '0');
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
      String(remaining || config.threshold),
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

    if (dryRun) {
      log('dry-run: not submitting');
      console.log(`DRY_RUN_FILLED reason=${reason} field=${JSON.stringify(filled)}`);
      exitCode = 0;
      return;
    }

    // 4. submit
    let submitted = false;
    for (const text of config.browser.submitButtonTexts ?? ['立即提交']) {
      // eslint-disable-next-line no-await-in-loop
      const result = await clickByText(page, text, { timeoutMs: 5000 });
      if (result?.clicked) {
        submitted = true;
        log('clicked submit button', text);
        break;
      }
    }
    if (!submitted) {
      const dump = await inspectPage(page);
      writeFileSync(join(ARTIFACT_DIR, 'no-submit-button.json'), JSON.stringify(dump, null, 2), 'utf8');
      throw new Error('SUBMIT_BUTTON_NOT_FOUND');
    }
    await sleep(3000);

    // 4b. a confirmation dialog may pop up -> confirm it (dialogs only)
    await dismissDialogs(page, config);

    const after = await readPageText(page);
    await page.screenshot(join(ARTIFACT_DIR, 'after-submit.png'));
    writeFileSync(join(ARTIFACT_DIR, 'after-submit.txt'), after, 'utf8');

    const ok = /(提交成功|申请成功|提交申请成功|已提交|受理成功|申请已提交)/.test(after);
    if (ok) {
      log('SUBMIT SUCCESS');
      console.log(`SUBMIT_SUCCESS reason=${reason}`);
      markState('submitted', { note: `申请已提交，事由：${reason}` });
      exitCode = 0;
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
    // A dry run must not touch the state machine, and it must not release the
    // lock of a submission that may be running right now.
    if (!dryRun) {
      markState('failed', { note: String(error.message || error).slice(0, 300) });
    }
    exitCode = 1;
  } finally {
    browser.close();
    if (!dryRun) {
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
