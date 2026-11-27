/**
 * The portal asks to pick the next approval node before an application is really
 * submitted:
 *
 *   "请选择下一个节点审批人"        [ ] 全选
 *                                   [ ] 业务审核
 *                                       刘龙飞（计算中心）
 *                                              [返回] [确认]
 *
 * Without ticking the approver, 确认 does nothing. On 2026-11-27 20:38 the first
 * unattended run stopped exactly here (and wrongly reported success, because the
 * sidebar text contains "已提交"). This module ticks the approver, presses 确认
 * and requires the dialog to close.
 *
 * Kept portal-agnostic on purpose: keywords and button texts come from
 * config.browser, so another institution's flow can be adapted without touching
 * the code. `apply/test-approver.mjs` exercises it against a local fixture.
 */

const DIALOG = '[role=dialog],.n-modal,.n-dialog,.ant-modal,.el-dialog,.n-message-box';

/** Read the approver dialog: its rows (checkbox candidates) and its buttons. */
export async function probeApprover(page, config = {}) {
  const keywords = config.browser?.approverDialogKeywords ?? ['审批人', '审批节点'];
  const confirmTexts = config.browser?.approverConfirmTexts ?? ['确认', '确定', '提交'];
  return page.evaluate(`
    const keywords = ${JSON.stringify(keywords)};
    const confirmTexts = ${JSON.stringify(confirmTexts)};
    const vis = (el) => el && el.getClientRects().length > 0;
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const DIALOG = ${JSON.stringify(DIALOG)};
    const dialogs = Array.from(document.querySelectorAll(DIALOG)).filter(vis);
    let dlg = dialogs.find((d) => keywords.some((k) => norm(d.innerText).includes(k)));
    if (!dlg) {
      const hit = Array.from(document.querySelectorAll('div,section')).filter(vis)
        .find((el) => /下一个?节点审批人|选择审批人/.test(norm(el.innerText)) && norm(el.innerText).length < 800);
      if (hit) dlg = hit.closest(DIALOG + ',[class*=modal],[class*=dialog],[class*=drawer],[class*=popup]') || hit;
    }
    if (!dlg) return { found: false };
    const isChecked = (el) => el.getAttribute('aria-checked') === 'true'
      || (el.tagName === 'INPUT' && el.checked)
      || /(^|[\\s_-])checked([\\s_-]|$)/i.test(String(el.className))
      || Boolean(el.querySelector('input:checked,.n-checkbox-box--checked,.el-checkbox__input.is-checked,.ant-checkbox-checked'));
    const isDisabled = (el) => /disabled|readonly/i.test(String(el.className))
      || el.getAttribute('aria-disabled') === 'true'
      || el.getAttribute('disabled') !== null
      || (el.tagName === 'INPUT' && el.disabled);
    const selector = '[role=checkbox],[role=radio],input[type=checkbox],input[type=radio],'
      + '.n-checkbox,.n-radio,.el-checkbox,.el-radio,.ant-checkbox-wrapper,.ant-radio-wrapper,'
      + '[class*=checkbox],[class*=Checkbox],[class*=radio]';
    const all = Array.from(dlg.querySelectorAll(selector)).filter(vis);
    // Wrapper and inner box share one row; clicking both would toggle twice and
    // end up unchecked. Keep only the outermost element of each row, then drop
    // duplicates that sit on the same spot.
    const outer = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
    const seen = new Set();
    const rows = outer.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: norm(el.innerText || el.getAttribute('aria-label') || '').slice(0, 40),
        checked: isChecked(el),
        disabled: isDisabled(el),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }).filter((c) => {
      if (c.w < 6 || c.h < 6) return false;
      const key = Math.round(c.x / 3) + ':' + Math.round(c.y / 3);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const buttons = Array.from(dlg.querySelectorAll('button,a,[role=button]')).filter(vis).map((b) => {
      const r = b.getBoundingClientRect();
      return {
        text: norm(b.innerText),
        disabled: isDisabled(b),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
      };
    });
    const confirm = buttons.find((b) => confirmTexts.includes(b.text));
    return { found: true, dialogText: norm(dlg.innerText).slice(0, 200), rows, confirm };
  `);
}

/**
 * Tick the approver and press 确认. Resolves to
 *   { found, confirmed, reason?, selected?, dialogText? }
 * `confirmed` is only true once the dialog has actually closed.
 */
export async function handleApproverDialog(page, config = {}, sleep) {
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const first = await probeApprover(page, config);
  if (!first?.found) return { found: false, confirmed: false };

  if (!first.rows.some((r) => r.checked)) {
    const open = first.rows.filter((r) => !r.disabled && !r.checked);
    const selectAll = open.find((r) => /全选/.test(r.text));
    const targets = selectAll ? [selectAll] : open.filter((r) => !/全选/.test(r.text));
    if (!targets.length) {
      return { found: true, confirmed: false, reason: 'no-selectable-approver', dialogText: first.dialogText };
    }
    await page.activate();
    await wait(300);
    for (const target of targets.slice(0, 5)) {
      // eslint-disable-next-line no-await-in-loop
      await page.clickAt(target.x, target.y);
      // eslint-disable-next-line no-await-in-loop
      await wait(350);
    }
  }

  // Verify the tick landed; some layouts only react to the label.
  let state = await probeApprover(page, config);
  if (!state.rows.some((r) => r.checked)) {
    for (const row of state.rows.filter((r) => !r.disabled && !r.checked).slice(0, 3)) {
      // eslint-disable-next-line no-await-in-loop
      await page.clickAt(row.x, row.y);
      // eslint-disable-next-line no-await-in-loop
      await wait(400);
      // eslint-disable-next-line no-await-in-loop
      state = await probeApprover(page, config);
      if (state.rows.some((r) => r.checked)) break;
    }
  }
  if (!state.rows.some((r) => r.checked)) {
    return { found: true, confirmed: false, reason: 'approver-not-selected', dialogText: state.dialogText };
  }
  if (!state.confirm || state.confirm.disabled) {
    return { found: true, confirmed: false, reason: 'confirm-unavailable', dialogText: state.dialogText };
  }

  await page.clickAt(state.confirm.x, state.confirm.y);
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await wait(600);
    // eslint-disable-next-line no-await-in-loop
    const now = await probeApprover(page, config).catch(() => ({ found: true }));
    if (!now.found) return { found: true, confirmed: true, selected: true };
  }
  const stuck = await probeApprover(page, config).catch(() => null);
  return {
    found: true,
    confirmed: false,
    reason: 'dialog-still-open',
    selected: stuck?.rows?.some((r) => r.checked) ?? null,
    dialogText: stuck?.dialogText ?? null,
  };
}
