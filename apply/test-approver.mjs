/**
 * Offline test of the approver-selection step.
 *
 * The real portal modal cannot be exercised without filing an application, so
 * the exact same handler is run against a local fixture that mimics the portal:
 * a "请选择下一个节点审批人" modal with a disabled 全选, one 业务审核 row, a 返回
 * button and a 确认 button that refuses to close while nothing is ticked.
 *
 * It drives the automation Edge over CDP (the same driver the apply layer uses),
 * so the clicks are real trusted mouse events. The fixture runs in its own tab
 * inside the dedicated automation profile - no portal page, no login, no
 * application is touched.
 */
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Browser, isPortAlive, launchBrowser, sleep } from './browser-driver.mjs';
import { handleApproverDialog } from './approver-dialog.mjs';

const PORT = 9333;
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'approver-fixture-'));
const file = join(dir, 'modal.html');

const fixture = `<!doctype html>
<html><head><meta charset="utf-8"><title>approver fixture</title>
<style>
  body{margin:0;font-family:sans-serif}
  .n-modal{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
  .n-modal-body{background:#fff;width:520px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.3)}
  .n-modal-header{font-size:16px;margin-bottom:16px}
  .n-checkbox{display:flex;align-items:center;gap:8px;padding:8px;cursor:pointer;width:200px}
  .n-checkbox-box{width:16px;height:16px;border:1px solid #bbb;display:inline-block}
  .n-checkbox-box--checked{background:#c8161d;border-color:#c8161d}
  .n-checkbox--disabled{opacity:.4;pointer-events:none}
  .n-modal-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
  button{padding:6px 22px;border:1px solid #c8161d;background:#fff;color:#c8161d;cursor:pointer}
  #confirm{background:#c8161d;color:#fff}
</style></head>
<body>
<div class="n-modal">
  <div class="n-modal-body">
    <div class="n-modal-header">请选择下一个节点审批人</div>
    <div class="n-checkbox n-checkbox--disabled" data-key="all"><span class="n-checkbox-box"></span><span>全选</span></div>
    <div class="n-checkbox" data-key="biz"><span class="n-checkbox-box"></span><span>业务审核</span></div>
    <div style="padding-left:32px;color:#1f4fd8">刘龙飞（计算中心）</div>
    <div class="n-modal-footer"><button id="back">返回</button><button id="confirm">确认</button></div>
  </div>
</div>
<script>
  window.__confirmClicks = 0;
  window.__errors = [];
  document.querySelectorAll('.n-checkbox').forEach((el) => el.addEventListener('click', () => {
    if (el.classList.contains('n-checkbox--disabled')) return;
    el.querySelector('.n-checkbox-box').classList.toggle('n-checkbox-box--checked');
  }));
  document.getElementById('back').addEventListener('click', () => { window.__back = true; });
  document.getElementById('confirm').addEventListener('click', () => {
    window.__confirmClicks += 1;
    const checked = document.querySelectorAll('.n-checkbox-box--checked').length;
    if (!checked) { window.__errors.push('请选择审批人'); return; }
    window.__confirmed = true;
    document.querySelector('.n-modal').style.display = 'none';
  });
</script>
</body></html>`;

writeFileSync(file, fixture, 'utf8');

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`PASS  ${name}`);
  else {
    console.log(`FAIL  ${name} ${detail ?? ''}`);
    failures.push(name);
  }
}

if (!(await isPortAlive(PORT))) {
  await launchBrowser({ port: PORT, profileDir: join(APP_ROOT, 'browser-profile'), headless: false });
  await sleep(2500);
}
const browser = await Browser.connect(PORT);
const page = await browser.newPage('about:blank');
try {
  await page.navigate(pathToFileURL(file).href, { waitMs: 10000 });
  await page.activate();
  await sleep(400);

  const handled = await handleApproverDialog(page, {}, sleep);
  console.log('handler result:', JSON.stringify(handled));
  check('dialog was found', handled.found === true, JSON.stringify(handled));
  check('approver was ticked and confirmed', handled.confirmed === true, JSON.stringify(handled));

  const result = await page.evaluate(`
    return {
      confirmed: Boolean(window.__confirmed),
      confirmClicks: Number(window.__confirmClicks || 0),
      errors: window.__errors || [],
      back: Boolean(window.__back),
      modalVisible: document.querySelector('.n-modal').getClientRects().length > 0,
    };
  `);
  check('fixture saw exactly one confirm click', result.confirmClicks === 1, JSON.stringify(result));
  check('fixture reported success', result.confirmed === true, JSON.stringify(result));
  check('confirm was never pressed without a selection', result.errors.length === 0, JSON.stringify(result));
  check('the back button was not used', result.back === false, JSON.stringify(result));
  check('the dialog is gone', result.modalVisible === false, JSON.stringify(result));
} finally {
  await page.close().catch(() => {});
  browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nALL TESTS PASSED' : `\nFAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
