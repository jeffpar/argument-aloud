// Randomized stress test for the explorer.js SPA: repeatedly clicks around
// the sidebar (terms/decades/cases/files/citations/icons/sort menus) and
// exercises both search features (case-title nav search and in-transcript
// search), pausing a randomized 1-5s between actions, and after every
// action verifies:
//
//   1. No unexpected browser console error/pageerror fired (see ALLOWLIST
//      below for known-benign noise this already tolerates).
//   2. Whenever the app itself opens something in the document viewer (a
//      PDF, a Minutes/gallery image, a pane page, audio/video, ...), the
//      panel actually shows it -- not stale content left over from a
//      previous case/file. This is checked by monkeypatching the page's
//      own showDocViewer() (see installDocViewerProbe) so we compare
//      against exactly what the app itself asked to display, rather than
//      guessing hrefs from the DOM ourselves.
//
// Every random choice (which action, which candidate element, how long to
// wait) is drawn from a seeded PRNG, so a run is reproducible: two runs
// with the same --seed against the same page content make the same
// sequence of choices. The seed used is always printed at the top of the
// run (and again next to any violation) so a failure can be replayed with
// --seed <n> --steps <n> to stop right after it.
//
// Requires the Jekyll dev server to already be running (npm start / bundle
// exec jekyll serve) at BASE_URL below. This script does not start or stop
// the server, and does not modify any data.
//
// Usage:
//   node scripts/tests/stress.js [--seed N] [--steps N] [--base-url URL]
//                                [--min-delay MS] [--max-delay MS]
//                                [--headed] [--fail-fast] [--out-dir DIR]
//
// Examples:
//   node scripts/tests/stress.js                        # quick default run
//   node scripts/tests/stress.js --steps 500             # a longer soak
//   node scripts/tests/stress.js --seed 12345 --steps 40  # replay a failure
//   node scripts/tests/stress.js --headed --min-delay 200 --max-delay 400  # watch it live, faster

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.AA_BASE_URL || 'http://localhost:4010/courts/ussc/',
    seed: null, // null = pick a random one and print it
    steps: 60,
    minDelayMs: 1000,
    maxDelayMs: 5000,
    headed: false,
    failFast: false,
    outDir: path.join(__dirname, 'output'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url') opts.baseUrl = argv[++i];
    else if (a === '--seed') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--steps') opts.steps = parseInt(argv[++i], 10);
    else if (a === '--min-delay') opts.minDelayMs = parseInt(argv[++i], 10);
    else if (a === '--max-delay') opts.maxDelayMs = parseInt(argv[++i], 10);
    else if (a === '--headed') opts.headed = true;
    else if (a === '--fail-fast') opts.failFast = true;
    else if (a === '--out-dir') opts.outDir = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (opts.seed == null) opts.seed = (Math.random() * 0xffffffff) >>> 0;
  if (!opts.baseUrl.endsWith('/')) opts.baseUrl += '/';
  return opts;
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n')
    .filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}

// ── Seeded PRNG (mulberry32) — deterministic given the same seed ───────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randInt(rng, minInclusive, maxInclusive) {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}
function choice(rng, arr) {
  return arr.length ? arr[randInt(rng, 0, arr.length - 1)] : undefined;
}

// ── Known-benign console noise ───────────────────────────────────────────
// Reviewed and kept intentionally short — the point of this test is to
// catch real regressions, not to fight the browser's own normal behavior.
// Tighten/extend this list as real (non-)findings come in.
const CONSOLE_ALLOWLIST = [
  /ResizeObserver loop/i,                       // benign Chrome quirk, unrelated to app code
  /favicon\.ico/i,
  // Deliberately switching cases/audio faster than a previous media fetch
  // can complete triggers a legitimate, expected "interrupted by a new
  // load request" rejection from the <audio>/<video> element's own
  // play()/load() — this is a real consequence of rapid random testing,
  // not an app bug.
  /The play\(\) request was interrupted/i,
  /The fetching process for the media resource was aborted/i,
];

// ── Small helpers ────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function visibleLocators(page, selector) {
  const all = page.locator(selector);
  const count = await all.count();
  const out = [];
  for (let i = 0; i < count; i++) {
    const el = all.nth(i);
    if (await el.isVisible().catch(() => false)) out.push(el);
  }
  return out;
}

// ── Doc-viewer probe ─────────────────────────────────────────────────────
// explorer.js is loaded as a plain (non-module) <script>, so its top-level
// function declarations (showDocViewer among them) are real `window`
// properties, sharing the same binding every other function in that file
// calls through — reassigning window.showDocViewer here transparently
// intercepts every call the app makes internally, not just ones we trigger.
// Re-run this after any full page navigation (a fresh load re-declares the
// original function and wipes the patch).
async function installDocViewerProbe(page) {
  await page.evaluate(() => {
    if (window.__stressPatched) return;
    window.__stressPatched = true;
    window.__stressLog = [];
    const orig = window.showDocViewer;
    window.showDocViewer = function (link, opts) {
      const result = orig.apply(this, arguments);
      const urlEl = document.getElementById('doc-viewer-url');
      window.__stressLog.push({
        requestedHref: link?.href ?? null,
        requestedSrc: link?.src ?? null,
        requestedView: link?.view ?? null,
        resolvedExternalHref: urlEl ? urlEl.href : null,
        t: Date.now(),
      });
      return result;
    };
  });
}

// Reads the doc-viewer's actual visible content and compares it against the
// probe's most recent log entry (if the log grew since `sinceLen`). Returns
// null when nothing new was shown (nothing to verify), or a finding object
// describing a mismatch, or { ok: true, ... } on a verified match.
async function verifyDocViewer(page, sinceLen) {
  const info = await page.evaluate((sinceLen) => {
    const log = window.__stressLog || [];
    if (log.length <= sinceLen) return { grew: false };
    const last = log[log.length - 1];
    const panel = document.getElementById('doc-viewer');
    const urlEl = document.getElementById('doc-viewer-url');
    const video = document.getElementById('doc-viewer-video');
    const audio = document.getElementById('doc-viewer-audio');
    const card = document.getElementById('doc-viewer-card');
    const iframe = [...document.querySelectorAll('iframe.pdf-iframe')]
      .find((f) => f.style.display === 'block');
    let visibleKind = null, visibleSrc = null;
    if (video && video.style.display === 'block') { visibleKind = 'video'; visibleSrc = video.src; }
    else if (audio && audio.style.display === 'block') { visibleKind = 'audio'; visibleSrc = audio.src; }
    else if (iframe) { visibleKind = 'iframe'; visibleSrc = iframe.src; }
    else if (card && card.style.display !== 'none') {
      visibleKind = 'card';
      visibleSrc = document.getElementById('doc-viewer-card-link')?.href ?? null;
    }
    return {
      grew: true,
      panelHidden: panel ? panel.hidden : null,
      requested: last,
      currentExternalHref: urlEl ? urlEl.href : null,
      visibleKind,
      visibleSrc,
    };
  }, sinceLen);

  if (!info.grew) return null;

  const findings = [];
  if (info.panelHidden) findings.push('doc-viewer panel is hidden after showDocViewer was called');
  if (info.requested.resolvedExternalHref && info.currentExternalHref !== info.requested.resolvedExternalHref) {
    findings.push(`#doc-viewer-url now points at ${info.currentExternalHref}, but the last request resolved to ${info.requested.resolvedExternalHref}`);
  }
  // For iframe/video/audio content (not the plain "card" fallback, which
  // has no embeddable src of its own), the visible element's own src should
  // agree with what was requested on at least path+basename — pooled PDF
  // iframes append #page=/#pagemode= fragments, so compare loosely.
  if (info.visibleKind && info.visibleKind !== 'card' && info.requested.resolvedExternalHref) {
    const pathOf = (u) => { try { return new URL(u).pathname; } catch { return u; } };
    // A single image (or multi-page gallery) is routed through our own
    // same-origin img-viewer.html wrapper (see showDocViewer) rather than
    // linking the raw image URL directly — that wrapper's own pathname is
    // the correct thing to see here, not the external image/gallery href.
    const isImageWrapper = pathOf(info.visibleSrc || '') === '/assets/img-viewer.html';
    if (info.visibleSrc && !isImageWrapper && pathOf(info.visibleSrc) !== pathOf(info.requested.resolvedExternalHref)) {
      findings.push(`visible ${info.visibleKind} src is ${info.visibleSrc}, expected something matching ${info.requested.resolvedExternalHref}`);
    }
  }
  return { ok: findings.length === 0, findings, info };
}

// showDocViewer defers revealing a brand-new PDF iframe until its own 'load'
// event fires (see explorer.js), specifically so the previous document stays
// on screen — with nothing blank in between — instead of flashing a loading
// placeholder; the previous document is exactly what verifyDocViewer would
// see if it checked the instant an action returns. Poll for a bit instead of
// checking once, so that legitimate (bounded) settle time isn't mistaken for
// a stale/stuck doc viewer — a real staleness bug still gets caught once
// pollMs is exhausted and the mismatch never resolves.
async function verifyDocViewerSettled(page, sinceLen, pollMs) {
  const deadline = Date.now() + pollMs;
  let last = null;
  for (;;) {
    last = await verifyDocViewer(page, sinceLen);
    if (!last || last.ok || Date.now() >= deadline) return last;
    await sleep(120);
  }
}

// ── Action pool ───────────────────────────────────────────────────────────
// Each action inspects the live page for candidates and either performs one
// interaction (returning a short description) or returns null when nothing
// applicable is currently on screen, so the runner can just try another.

const ACTIONS = [];
function action(name, weight, fn) { ACTIONS.push({ name, weight, fn }); }

action('expand sidebar section', 3, async (page, rng) => {
  const candidates = await visibleLocators(page,
    '.terms-header:not(.open) , .decade-label, .term-label, .case-title-nav');
  // The selector above intentionally includes already-open items too (a
  // second click on an open term/decade closes it) — real user behavior,
  // and exercises the toggle-closed path as well.
  const el = choice(rng, candidates);
  if (!el) return null;
  await el.click({ timeout: 5000 }).catch(() => {});
  return 'toggled a sidebar section';
});

action('toggle case file list', 3, async (page, rng) => {
  const toggles = await visibleLocators(page, '.case-toggle');
  const el = choice(rng, toggles);
  if (!el) return null;
  await el.click({ timeout: 5000 }).catch(() => {});
  return 'toggled a case file list';
});

action('click file item', 4, async (page, rng) => {
  const items = await visibleLocators(page, '.file-item, .citation-title');
  const el = choice(rng, items);
  if (!el) return null;
  const label = (await el.textContent().catch(() => ''))?.trim().slice(0, 60);
  await el.click({ timeout: 5000 }).catch(() => {});
  return `clicked file/citation "${label}"`;
});

action('toggle file-type group', 2, async (page, rng) => {
  const headers = await visibleLocators(page, '.file-type-header');
  const el = choice(rng, headers);
  if (!el) return null;
  await el.click({ timeout: 5000 }).catch(() => {});
  return 'toggled a file-type group';
});

action('click case audio/scales icon', 3, async (page, rng) => {
  const icons = await visibleLocators(page,
    '[data-audio-icon], .case-scales-icon, .case-scales-ring, .case-scales-ring-empty');
  const el = choice(rng, icons);
  if (!el) return null;
  await el.click({ timeout: 5000, force: true }).catch(() => {});
  return 'clicked a case audio/scales icon';
});

action('pick a file-select option', 4, async (page, rng) => {
  const select = page.locator('#file-select');
  if (!(await select.isVisible().catch(() => false))) return null;
  const optionValues = await select.locator('option').evaluateAll((els) => els.map((e) => e.value));
  if (optionValues.length < 2) return null;
  const value = choice(rng, optionValues);
  const label = await select.evaluate((el, v) => {
    el.value = v;
    return el.options[el.selectedIndex]?.textContent || v;
  }, value);
  await select.dispatchEvent('change');
  return `selected file-select option "${label}"`;
});

action('case-cite click', 2, async (page, rng) => {
  const cite = page.locator('#case-cite');
  if (!(await cite.isVisible().catch(() => false))) return null;
  await cite.click({ timeout: 5000 }).catch(() => {});
  await sleep(200);
  // #case-cite either opens the doc directly or a small picker menu — if a
  // menu appeared, pick a random entry from it.
  const menuItems = await visibleLocators(page, '.term-sort-menu.cite-menu .term-sort-option');
  const item = choice(rng, menuItems);
  if (item) await item.click({ timeout: 5000 }).catch(() => {});
  return 'clicked case citation';
});

action('doc-viewer back/forward', 2, async (page, rng) => {
  const buttons = await visibleLocators(page, '#doc-viewer-back, #doc-viewer-forward');
  const el = choice(rng, buttons);
  if (!el) return null;
  await el.click({ timeout: 5000 }).catch(() => {});
  return 'clicked doc-viewer back/forward';
});

action('open sort menu and pick', 2, async (page, rng) => {
  const buttons = await visibleLocators(page, '.term-case-count');
  const btn = choice(rng, buttons);
  if (!btn) return null;
  // .term-case-count is reused for term/decade/collection-group headers alike
  // (see explorer.js) — only some of them actually open a sort menu, so name
  // which row this one belongs to (its own text, e.g. "68 Cases", plus the
  // sibling label, e.g. "October Term 2024") for a readable log line either way.
  const countText = (await btn.textContent().catch(() => ''))?.trim();
  const labelText = await btn.evaluate((el) => {
    const row = el.closest('.term-header, .decade-header, .terms-header');
    return row?.querySelector('.term-label, .decade-label, .terms-label')?.textContent?.trim() || null;
  }).catch(() => null);
  const rowDesc = labelText ? `${labelText} (${countText})` : countText;
  await btn.click({ timeout: 5000 }).catch(() => {});
  await sleep(150);
  const options = await visibleLocators(page, '.term-sort-menu .term-sort-option');
  const opt = choice(rng, options);
  if (opt) {
    const optText = (await opt.textContent().catch(() => ''))?.trim();
    await opt.click({ timeout: 5000 }).catch(() => {});
    return `picked sort "${optText}" for ${rowDesc}`;
  }
  return `clicked count/sort button for ${rowDesc} (no menu appeared)`;
});

action('nav search', 3, async (page, rng) => {
  const query = await pickNavSearchQuery(page, rng);
  if (!query) return null;
  const btn = page.locator('#nav-search-btn');
  if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 5000 }).catch(() => {});
  const input = page.locator('#nav-search-input');
  if (!(await input.isVisible().catch(() => false))) return null;
  await input.fill(query);
  await sleep(400); // debounce
  const results = await visibleLocators(page, '#nav-search-results .case-title-nav');
  const result = choice(rng, results);
  if (result) {
    await result.click({ timeout: 5000 }).catch(() => {});
    return `nav-searched "${query}" and picked a result`;
  }
  return `nav-searched "${query}" (no results)`;
});

// The home page's own "Searches" card demonstrates the find= deep-link
// syntax directly (?term=all&find=...) rather than typing into the search
// box — number/title/docket/citation/text examples, real <a href>s read off
// the live page rather than duplicated here, so this tracks the copy if it
// ever changes. A real full-page navigation (unlike every other action,
// which stays inside the SPA), so the doc-viewer probe needs reinstalling
// once it lands back in /courts/ussc/.
action('home page search-card link', 2, async (page, rng) => {
  const origin = new URL(page.url()).origin;
  await page.goto(origin + '/', { waitUntil: 'networkidle' }).catch(() => {});
  const card = page.locator('.hp-card', { has: page.locator('.hp-card-title', { hasText: 'Searches' }) });
  if (!(await card.isVisible().catch(() => false))) return null;
  const links = await card.locator('.hp-card-desc a').all();
  const link = choice(rng, links);
  if (!link) return null;
  const label = (await link.textContent().catch(() => ''))?.trim();
  await link.click({ timeout: 5000 }).catch(() => {});
  await page.waitForSelector('#term-list', { timeout: 20000 }).catch(() => {});
  await installDocViewerProbe(page);
  return `followed home page Searches example "${label}"`;
});

action('transcript search', 3, async (page, rng) => {
  const query = await pickTranscriptSearchQuery(page, rng);
  if (!query) return null;
  const trigger = page.locator('#search-btn');
  if (!(await trigger.isVisible().catch(() => false))) return null;
  await trigger.click({ timeout: 5000 }).catch(() => {});
  const input = page.locator('#search-input');
  await input.fill(query);
  await sleep(400);
  const nextBtn = page.locator('#search-next');
  if (await nextBtn.isVisible().catch(() => false)) {
    const hops = randInt(rng, 1, 3);
    for (let i = 0; i < hops; i++) await nextBtn.click({ timeout: 3000 }).catch(() => {});
  }
  const closeBtn = page.locator('#search-close');
  if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click({ timeout: 3000 }).catch(() => {});
  return `transcript-searched "${query}"`;
});

// The nav search box (#nav-search-input, reparented into the "Terms"
// section header — see explorer.js) understands several distinct query
// styles, demonstrated by the home page's own "Searches" card: a bare title
// fragment, a "#docket-number" or "#Orig" prefix, a "VOL US PAGE" citation,
// a "quoted phrase" full-text search, and a quoted phrase followed by a
// speaker's last name. Exercise a realistic mix of all of them, built from
// real data on the page rather than fixed strings, so each run's queries
// vary with whatever cases/transcript happen to be loaded.
async function pickNavSearchQuery(page, rng) {
  const modeRoll = rng();
  if (modeRoll < 0.2) {
    const q = await pickDocketQuery(page, rng);
    if (q) return q;
  } else if (modeRoll < 0.35) {
    const q = await pickCitationQuery(page);
    if (q) return q;
  } else if (modeRoll < 0.55) {
    const q = await pickQuotedPhraseQuery(page, rng, /* withSpeaker */ true);
    if (q) return q;
  } else if (modeRoll < 0.7) {
    const q = await pickQuotedPhraseQuery(page, rng, /* withSpeaker */ false);
    if (q) return q;
  }
  // Falls through to a plain title fragment — both as the default 30% case
  // and as the fallback when a fancier mode above found nothing to build from.
  const titles = await page.locator('.case-title-nav').allTextContents();
  const pool = titles.map((t) => t.trim()).filter((t) => t.length > 4);
  const title = choice(rng, pool);
  if (!title) return null;
  const words = title.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const start = randInt(rng, 0, Math.max(0, words.length - 1));
  const len = randInt(rng, 1, Math.min(3, words.length - start));
  return words.slice(start, start + len).join(' ');
}

// "#<docket number>" — pulls a real docket from a visible case-item's own
// data-case-key ("term/number"); occasionally "#Orig" instead, matching the
// home page's own literal Docket example (a stable, real suffix shared by
// every Original Jurisdiction case).
async function pickDocketQuery(page, rng) {
  if (rng() < 0.2) return '#Orig';
  const keys = await page.locator('.case-item[data-case-key]').evaluateAll(
    (els) => els.map((el) => el.dataset.caseKey));
  const pool = keys.filter(Boolean);
  const key = choice(rng, pool);
  if (!key) return null;
  const number = key.slice(key.indexOf('/') + 1);
  return number ? '#' + number : null;
}

// "VOL US PAGE" — reads the currently-open case's own citation off #case-cite
// (rendered as "(NNN U.S. NNN)"), only available once a decided case is loaded.
async function pickCitationQuery(page) {
  const text = await page.locator('#case-cite').textContent().catch(() => null);
  const m = text && /\((\d+)\s+U\.S\.\s+(\d+)\)/.exec(text);
  return m ? `${m[1]} US ${m[2]}` : null;
}

// A quoted phrase pulled from the currently-rendered transcript (full-text
// search), optionally followed by one of that transcript's own speakers'
// last names — mirrors the home page's "broccoli scalia" example.
async function pickQuotedPhraseQuery(page, rng, withSpeaker) {
  const texts = await page.locator('.turn-text').allTextContents().catch(() => []);
  const words = texts.join(' ').split(/\s+/).map((w) => w.replace(/[^a-zA-Z']/g, '')).filter((w) => w.length > 3);
  if (!words.length) return null;
  const start = randInt(rng, 0, words.length - 1);
  const len = randInt(rng, 1, Math.min(2, words.length - start));
  const phrase = `"${words.slice(start, start + len).join(' ')}"`;
  if (!withSpeaker) return phrase;
  const speakers = await page.locator('.speaker').allTextContents().catch(() => []);
  const lastNames = speakers.map((s) => s.trim().split(/\s+/).pop()?.replace(/[^a-zA-Z]/g, '')).filter((s) => s && s.length > 2);
  const speaker = choice(rng, lastNames);
  return speaker ? `${phrase} ${speaker.toLowerCase()}` : phrase;
}

// Picks a word out of the currently-rendered transcript, if any is loaded.
async function pickTranscriptSearchQuery(page, rng) {
  const texts = await page.locator('.turn-text').allTextContents().catch(() => []);
  const pool = texts.join(' ').split(/\s+/).map((w) => w.replace(/[^a-zA-Z']/g, '')).filter((w) => w.length > 4);
  return choice(rng, pool) ?? null;
}

// ── Runner ────────────────────────────────────────────────────────────────

async function runStep(page, rng, stepIndex, opts) {
  const totalWeight = ACTIONS.reduce((s, a) => s + a.weight, 0);
  const tried = new Set();
  let outcome = null, actionName = null;

  // Try weighted-random actions until one actually applies; fall back to
  // "expand sidebar section" (almost always applicable) if everything else
  // whiffs. Bounded so a broken page can't spin forever.
  for (let attempt = 0; attempt < ACTIONS.length * 2 && outcome == null; attempt++) {
    let r = rng() * totalWeight;
    let picked = ACTIONS[0];
    for (const a of ACTIONS) { if (r < a.weight) { picked = a; break; } r -= a.weight; }
    if (tried.has(picked.name) && tried.size < ACTIONS.length) continue;
    tried.add(picked.name);
    actionName = picked.name;
    outcome = await picked.fn(page, rng).catch((e) => `ERROR: ${e.message}`);
  }
  if (outcome == null) {
    actionName = 'expand sidebar section (fallback)';
    outcome = await ACTIONS[0].fn(page, rng).catch((e) => `ERROR: ${e.message}`);
  }
  return { actionName, outcome };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`stress test — seed=${opts.seed} steps=${opts.steps} base=${opts.baseUrl}`);
  console.log(`(reproduce with: node scripts/tests/stress.js --seed ${opts.seed} --steps <n> --base-url ${opts.baseUrl})\n`);

  fs.mkdirSync(opts.outDir, { recursive: true });
  const rng = mulberry32(opts.seed);

  const browser = await chromium.launch({ headless: !opts.headed });
  const page = await browser.newPage();

  // The doc viewer routinely embeds third-party pages (a case's decision on
  // supremecourt.gov, an archived opinion on web.archive.org, a cited
  // reference site, ...) in a same-page iframe — Playwright's console/
  // pageerror events fire for every frame on the page, not just the top-
  // level one, so a script error thrown by *that site's own* broken
  // analytics/jQuery/whatever would otherwise get attributed to us. Console
  // messages carry a location().url naming the frame they came from; a
  // pageerror's stack (only available frame-identifying signal it carries)
  // names the frame's URL the same way — both are checked against our own
  // origin below before anything is treated as a violation.
  const pageOrigin = new URL(opts.baseUrl).origin;
  const isOwnOrigin = (url) => { try { return new URL(url).origin === pageOrigin; } catch { return true; /* no/unparseable location — err on the side of treating it as ours */ } };

  const consoleLog = [];
  page.on('console', (msg) => consoleLog.push({ kind: msg.type(), text: msg.text(), url: msg.location()?.url || '' }));
  page.on('pageerror', (err) => consoleLog.push({ kind: 'pageerror', text: String(err), url: (err.stack && /https?:\/\/\S+/.exec(err.stack)?.[0]) || '' }));

  await page.goto(opts.baseUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('#term-list', { timeout: 20000 });
  await installDocViewerProbe(page);

  const violations = [];

  for (let step = 1; step <= opts.steps; step++) {
    const before = consoleLog.length;
    // Read fresh right before the action (rather than carrying a count over
    // from the previous step) so an action that does a full page navigation
    // (e.g. "home page search-card link") — which resets window.__stressLog
    // to empty on the newly-loaded page — can't leave this comparing against
    // a now-meaningless count from the page that no longer exists.
    const preLogLen = await page.evaluate(() => (window.__stressLog || []).length).catch(() => 0);
    const { actionName, outcome } = await runStep(page, rng, step, opts);

    const delayMs = randInt(rng, opts.minDelayMs, opts.maxDelayMs);
    // Settle-poll for up to 4s (generous for a real PDF/image load) rather
    // than a single fixed sleep — see verifyDocViewerSettled's own comment.
    // If that finishes before the randomized between-clicks delay is up,
    // sleep out the remainder so pacing still averages 1-5s as requested;
    // if settling itself took longer, that time already covers the delay.
    const settleStart = Date.now();
    const docCheck = await verifyDocViewerSettled(page, preLogLen, 4000).catch((e) => ({ ok: false, findings: [`probe threw: ${e.message}`] }));
    const remaining = delayMs - (Date.now() - settleStart);
    if (remaining > 0) await sleep(remaining);

    // New-console-message check for this step only. Third-party frame noise
    // (see isOwnOrigin's own comment) is dropped before anything else — it's
    // never ours to fix, no matter how alarming it looks.
    const sinceStep = consoleLog.slice(before).filter((m) => isOwnOrigin(m.url));
    const thirdPartyMsgs = consoleLog.slice(before).filter((m) => !isOwnOrigin(m.url));
    const newMsgs = sinceStep.filter((m) => {
      if (m.kind === 'pageerror') return true;
      if (m.kind !== 'error') return false; // warnings/logs are informational only, see header comment
      return !CONSOLE_ALLOWLIST.some((re) => re.test(m.text));
    });

    const stepOk = newMsgs.length === 0 && (!docCheck || docCheck.ok);
    console.log(`[${String(step).padStart(4)}/${opts.steps}] ${actionName} — ${outcome}${stepOk ? '' : '  ✗ VIOLATION'}`);
    if (thirdPartyMsgs.length) {
      console.log(`         (ignored ${thirdPartyMsgs.length} console message(s) from an embedded third-party page: ${[...new Set(thirdPartyMsgs.map((m) => { try { return new URL(m.url).origin; } catch { return m.url || '(no location)'; } }))].join(', ')})`);
    }

    if (!stepOk) {
      const violation = {
        step, seed: opts.seed, actionName, outcome, url: page.url(),
        consoleMessages: newMsgs,
        docViewer: docCheck && !docCheck.ok ? docCheck : null,
      };
      violations.push(violation);
      const shotPath = path.join(opts.outDir, `violation-${opts.seed}-step${step}.png`);
      await page.screenshot({ path: shotPath }).catch(() => {});
      const jsonPath = path.join(opts.outDir, `violation-${opts.seed}-step${step}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(violation, null, 2));
      console.log(`         details: ${jsonPath}`);
      if (newMsgs.length) for (const m of newMsgs) console.log(`         console(${m.kind}): ${m.text.slice(0, 200)}`);
      if (docCheck && !docCheck.ok) for (const f of docCheck.findings) console.log(`         doc-viewer: ${f}`);
      if (opts.failFast) break;
    }
  }

  await browser.close();

  console.log(`\n${opts.steps - violations.length}/${opts.steps} steps clean`);
  if (violations.length) {
    console.log(`${violations.length} violation(s) — see ${opts.outDir}`);
    console.log(`replay the first one with: node scripts/tests/stress.js --seed ${opts.seed} --steps ${violations[0].step} --base-url ${opts.baseUrl}`);
  }
  process.exit(violations.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(2);
});
