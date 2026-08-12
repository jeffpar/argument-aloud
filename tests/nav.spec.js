// Regression tests for the sidebar nav accordion behavior in assets/js/explorer.js:
// a click anywhere on an expandable row (triangle through label) closes it when the
// row is both open AND the current selection; otherwise it opens/selects it.
//
// Requires the Jekyll dev server to already be running (npm run start / bundle exec
// jekyll serve) at BASE_URL below. This suite does not start or stop the server.
//
// Usage: npm test

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE_URL = process.env.AA_BASE_URL || 'http://localhost:4008/courts/ussc/';
const WAIT_MS = 5000;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('term: label click opens, second label click closes (open + selected)', async (page) => {
  await openTermsSection(page);
  const { termGroup, termLabel } = await firstTermInFirstDecade(page);

  await termLabel.click();
  await waitForOpen(termGroup, true, 'term should open on first click');

  await termLabel.click();
  await waitForOpen(termGroup, false, 'term should close on second click (open + selected)');
});

test('decade: any click on an open decade row closes it (no selection concept)', async (page) => {
  await openTermsSection(page);
  const decadeHeader = page.locator('.decade-header').first();
  const decadeLabel = decadeHeader.locator('.decade-label');
  const decLi = page.locator('.decade-group').first();

  await decadeLabel.click();
  await waitForOpen(decLi, true, 'decade should open on first click');

  await decadeLabel.click();
  await waitForOpen(decLi, false, 'decade should close on second click');
});

test('collection: label click opens+selects, second label click closes (open + selected)', async (page) => {
  await openCollectionsSection(page);
  // "Briefs" lives inside the collapsed "Historical" sub-group container; open that first.
  const historicalGroup = page.locator('.term-group').filter({ hasText: 'Historical' }).first();
  if (!(await isOpen(historicalGroup))) {
    await historicalGroup.locator('.term-header .term-label').first().click();
    await waitForOpen(historicalGroup, true, 'Historical sub-group should open');
  }
  const collItem = page.locator('.term-group[data-collection-url="/courts/ussc/collections/briefs/briefs.json"]').first();
  const collLabel = collItem.locator('.term-label').first();

  await collLabel.click();
  await waitForOpen(collItem, true, 'collection should open on first click');

  await collLabel.click();
  await waitForOpen(collItem, false, 'collection should close on second click (open + selected)');
});

test('collection with a page: closing then reopening does not reload the page-viewer iframe', async (page) => {
  // Regression for a flicker bug: /courts/ussc/collections/benches redirects (adds a
  // trailing slash), so the iframe's post-load location never literally matched a
  // freshly-built target href, causing a needless reload every time the page-viewer
  // pane was re-shown for a collection that was already displaying it.
  await openCollectionsSection(page);
  // "Benches" lives inside the collapsed "Justices" sub-group container; open that first.
  const justicesGroup = page.locator('.term-group').filter({ hasText: 'Justices' }).first();
  if (!(await isOpen(justicesGroup))) {
    await justicesGroup.locator('.term-header .term-label').first().click();
    await waitForOpen(justicesGroup, true, 'Justices sub-group should open');
  }
  const collItem = page.locator('.term-group[data-collection-url="/courts/ussc/people/justices/benches.json"]').first();
  const collLabel = collItem.locator('.term-label').first();

  await collLabel.click();
  await waitForOpen(collItem, true, 'Benches should open on first click');
  // Let the initial page-viewer load (and its server-side redirect) settle.
  await page.waitForLoadState('networkidle');

  await collLabel.click();
  await waitForOpen(collItem, false, 'Benches should close on second click (open + selected)');

  let childFrameNavigated = false;
  const onFrameNav = (f) => { if (f !== page.mainFrame()) childFrameNavigated = true; };
  page.on('framenavigated', onFrameNav);
  await collLabel.click();
  await waitForOpen(collItem, true, 'Benches should reopen on third click');
  await page.waitForTimeout(500); // give a would-be reload time to fire
  page.off('framenavigated', onFrameNav);

  assert.equal(childFrameNavigated, false, 'reopening a collection already showing its page should not reload the page-viewer iframe');
});

test('case item: re-clicking the active case title toggles its file list, not the selection', async (page) => {
  await openTermsSection(page);
  const { termGroup, termLabel } = await firstTermInFirstDecade(page);
  await termLabel.click();
  await waitForOpen(termGroup, true, 'term should open before selecting a case');

  const caseTitle = termGroup.locator('.case-item .case-title-nav').first();
  await caseTitle.waitFor({ timeout: 10000 });
  const caseItem = caseTitle.locator('xpath=ancestor::li[contains(@class,"case-item")][1]');

  await caseTitle.click();
  await waitForClass(caseItem, 'active', true, 'case should become active (selected) on first click');
  const fileOpenBefore = await hasClass(caseItem, 'open');

  await caseTitle.click();
  await waitForClass(caseItem, 'open', !fileOpenBefore, 're-clicking the title should toggle the file list open/closed');
  assert.equal(await hasClass(caseItem, 'active'), true, 'case should remain selected after re-clicking its title');
});

test('regression: an open-but-not-selected term selects on click instead of closing', async (page) => {
  await openTermsSection(page);
  const { termGroup: term1, termLabel: term1Label } = await firstTermInFirstDecade(page);
  await term1Label.click();
  await waitForOpen(term1, true, 'term1 should open on first click');

  const termGroups = page.locator('.term-group[data-term]');
  const count = await termGroups.count();
  assert.ok(count >= 2, 'need at least two terms in the first decade to run this check');
  const term2 = termGroups.nth(1);
  const term2Label = term2.locator('.term-label').first();
  await term2Label.click();
  await waitForOpen(term2, true, 'term2 should open on first click');

  // term1 should still be open (it was never explicitly closed) but no longer selected.
  assert.equal(await isOpen(term1), true, 'term1 should remain open after selecting term2');

  await term1Label.click();
  await waitForUrlParam(page, 'term', await term1.getAttribute('data-term'), 'URL should now reflect term1 as selected');
  assert.equal(await isOpen(term1), true, 'clicking an open-but-unselected term should select it, not close it');
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function isOpen(locator) {
  return locator.evaluate(el => el.classList.contains('open'));
}
async function hasClass(locator, cls) {
  return locator.evaluate((el, cls) => el.classList.contains(cls), cls);
}
// Polls (rather than trusting a fixed sleep) until the element's class state
// matches what's expected, so tests don't flake under variable system load.
async function waitForClass(locator, cls, expected, message) {
  const deadline = Date.now() + WAIT_MS;
  let last;
  while (Date.now() < deadline) {
    last = await hasClass(locator, cls);
    if (last === expected) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(last, expected, message);
}
async function waitForOpen(locator, expected, message) {
  return waitForClass(locator, 'open', expected, message);
}
async function waitForUrlParam(page, key, expected, message) {
  const deadline = Date.now() + WAIT_MS;
  let last;
  while (Date.now() < deadline) {
    last = new URL(page.url()).searchParams.get(key);
    if (last === expected) return;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(last, expected, message);
}
async function openTermsSection(page) {
  const termsLi = page.locator('.terms-group').filter({ hasText: 'Terms' }).first();
  const termsHeader = termsLi.locator('.terms-header').first();
  if (!(await isOpen(termsLi))) {
    await termsHeader.click();
    await waitForOpen(termsLi, true, 'Terms section should open');
  }
}
async function openCollectionsSection(page) {
  const collSectionLi = page.locator('.terms-group').filter({ hasText: 'Collections' }).first();
  const collSectionHeader = collSectionLi.locator('.terms-header').first();
  if (!(await isOpen(collSectionLi))) {
    await collSectionHeader.click();
    await waitForOpen(collSectionLi, true, 'Collections section should open');
  }
}
async function firstTermInFirstDecade(page) {
  const decadeHeader = page.locator('.decade-header').first();
  const decLi = page.locator('.decade-group').first();
  if (!(await isOpen(decLi))) {
    await decadeHeader.locator('.decade-label').click();
    await waitForOpen(decLi, true, 'first decade should open');
  }
  const termGroup = page.locator('.term-group[data-term]').first();
  await termGroup.waitFor({ timeout: 10000 });
  return { termGroup, termLabel: termGroup.locator('.term-label').first() };
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function checkServerUp() {
  try {
    const res = await fetch(BASE_URL, { method: 'GET' });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

(async () => {
  if (!(await checkServerUp())) {
    console.error(
      `\nJekyll dev server not reachable at ${BASE_URL}.\n` +
      `Start it first (bundle exec jekyll serve --host 0.0.0.0 --port 4008) and re-run npm test.\n`,
    );
    process.exit(2);
  }

  const browser = await chromium.launch();
  let failures = 0;

  for (const { name, fn } of tests) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', err => consoleErrors.push(String(err)));
    try {
      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.waitForSelector('#term-list', { timeout: 15000 });
      await fn(page);
      if (consoleErrors.length) throw new Error(`console errors during test: ${consoleErrors.join('; ')}`);
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${name}`);
      console.log(`      ${err.message}`);
    } finally {
      await page.close();
    }
  }

  await browser.close();

  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  process.exit(failures ? 1 : 0);
})();
