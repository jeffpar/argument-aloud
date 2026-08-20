// Crawls the published argumentaloud.org site and verifies every same-origin
// page/resource it references is reachable, plus (non-recursively) every
// external link discovered in real page HTML.
//
// Two complementary phases:
//
//   Phase 1 (structural): BFS over real <a href>/<img src>/<link href>/
//   <script src>/... tags, seeded from the homepage plus every Jekyll source
//   page in this repo (so pages nobody links to aren't missed). explorer.js
//   drives the whole /courts/ussc/ SPA client-side, so every ?term=...&case=...
//   URL under a given pathname serves byte-identical server-rendered HTML —
//   same-origin URLs are therefore deduped by pathname alone; re-fetching the
//   same shell 29,000 times with a different query string would test nothing.
//
//   Phase 2 (data-driven): walks terms.json -> cases.json -> events[], plus
//   collections.json/topics.json, to validate every same-origin resource the
//   SPA actually references per case (aligned transcript envelopes, journal
//   cover/stats images, files.json, collection/topic data files) -- this is
//   where the site's real per-case variation lives, which a pathname-deduped
//   crawl can't see on its own.
//
// External hrefs referenced *from case data* (supremecourt.gov PDFs, Oyez
// audio, docket briefs, ...) are deliberately NOT checked here -- that's
// already `node scripts/update_cases.js --checkurls`'s job, and the volume
// (100k+, across many cases x many files each) risks getting this crawler
// rate-limited by those hosts for little benefit. External links found via
// real on-page <a href> (e.g. a "See also: Wikipedia" link) ARE checked,
// HEAD-only, no recursion -- pass --no-external to skip even those.
//
// Successful checks are cached to disk (scripts/tests/.crawl-cache.json by default) and
// trusted for --cache-ttl seconds (default 1 day) on the next run, so repeat
// runs only pay for what's new or previously broken -- failures are never
// served from cache, they're always re-verified. Pass --no-cache to disable.
//
// The full JSON report is written to scripts/tests/output/crawl-report.json
// by default (that whole directory is gitignored, and shared with
// stress.js's own violation output) -- pass --out FILE for a different
// path, or --no-out to skip writing one.
//
// Usage:
//   node scripts/tests/crawl-links.js [--base URL] [--concurrency N] [--timeout MS]
//                              [--no-external] [--no-data] [--limit N] [--out FILE] [--no-out]
//                              [--cache FILE] [--no-cache] [--cache-ttl SECONDS]
//
// Examples:
//   node scripts/tests/crawl-links.js                          # full exhaustive run against production
//   node scripts/tests/crawl-links.js --limit 5                # quick smoke test (5 terms' worth of cases)
//   node scripts/tests/crawl-links.js --base http://localhost:4008 --no-external
//   node scripts/tests/crawl-links.js --no-cache                # force a fully fresh re-check of everything

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseHtml } from 'node-html-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ── CLI args ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    base: 'https://argumentaloud.org',
    concurrency: 16,
    timeout: 15000,
    external: true,
    data: true,
    limit: null,   // cap on number of terms walked in Phase 2, for quick runs
    out: path.join(__dirname, 'output', 'crawl-report.json'),
    cache: path.join(__dirname, '.crawl-cache.json'),
    cacheTtlMs: 24 * 60 * 60 * 1000, // successful checks are trusted for 1 day
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') opts.base = argv[++i];
    else if (a === '--concurrency') opts.concurrency = parseInt(argv[++i], 10);
    else if (a === '--timeout') opts.timeout = parseInt(argv[++i], 10);
    else if (a === '--no-external') opts.external = false;
    else if (a === '--no-data') opts.data = false;
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--no-out') opts.out = null;
    else if (a === '--cache') opts.cache = argv[++i];
    else if (a === '--no-cache') opts.cache = null;
    else if (a === '--cache-ttl') opts.cacheTtlMs = parseInt(argv[++i], 10) * 1000;
  }
  opts.base = opts.base.replace(/\/+$/, '');
  return opts;
}

const OPTS = parseArgs(process.argv.slice(2));
const ORIGIN = new URL(OPTS.base).origin;

// ── Concurrency limiter ──────────────────────────────────────────────────

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  function pump() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; pump(); });
  }
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
const limit = createLimiter(OPTS.concurrency);

// Every checkUrl() call that actually schedules new work (as opposed to
// returning a cached result) is tracked here, so the report can wait for
// every in-flight check to settle -- including the "fire and forget" ones
// (images, files.json, external links) that callers don't individually await.
const pending = [];
async function waitForAll() {
  while (pending.length) {
    const batch = pending.splice(0, pending.length);
    await Promise.allSettled(batch);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

// Node's default fetch User-Agent ("node") gets flagged by anti-scraping
// rules on some third-party sites (seen consistently on courtlistener.com,
// nytimes.com, loc.gov, justia.com -- all 403, all otherwise-fine external
// links), producing false-positive "broken link" reports. A browser-like UA
// avoids that class of false positive without changing what's actually checked.
const USER_AGENT = 'Mozilla/5.0 (compatible; ArgumentAloudLinkChecker/1.0; +https://argumentaloud.org)';

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, ...(init && init.headers) },
    });
  } finally {
    clearTimeout(timer);
  }
}

// Results are deduped by a "check key" (see checkKey()) so the same physical
// resource is never verified twice within a run, however many pages reference it.
const results = new Map(); // checkKey -> { url, method, status, ok, error, referrers: string[], external }
let checked = 0, fromCache = 0;

// Cross-run cache: URLs that came back OK recently are trusted without a
// fresh network round-trip (bodies aren't persisted, so page/JSON fetches
// that need a body always re-fetch -- this mainly short-circuits the bulk
// leaf checks: images, transcript JSON, files.json, external links).
// Failures are never trusted from cache -- always re-verified.
let diskCache = new Map();
function loadCache() {
  if (!OPTS.cache) return;
  try {
    const raw = JSON.parse(fs.readFileSync(OPTS.cache, 'utf8'));
    for (const [k, v] of Object.entries(raw)) diskCache.set(k, v);
  } catch { /* no cache yet, or unreadable -- start fresh */ }
}
function saveCache() {
  if (!OPTS.cache) return;
  const out = {};
  for (const [key, entry] of results) {
    out[key] = {
      url: entry.url, method: entry.method, status: entry.status, ok: entry.ok,
      error: entry.error, external: entry.external,
      checkedAt: entry.fromCache ? entry.checkedAt : Date.now(),
    };
  }
  // Preserve cache entries this run never touched (e.g. --limit runs, or Phase 1 assets not reached).
  for (const [key, entry] of diskCache) if (!(key in out)) out[key] = entry;
  fs.writeFileSync(OPTS.cache, JSON.stringify(out));
}

function checkKey(u) {
  // Same-origin: dedupe by pathname only (query strings don't change what
  // GitHub Pages serves). Cross-origin: dedupe by the full URL, since query
  // strings there usually *do* select different content.
  return u.origin === ORIGIN ? u.origin + u.pathname : u.href;
}

async function checkUrl(rawUrl, referrer, { method = 'HEAD', needBody = false } = {}) {
  let u;
  try { u = new URL(rawUrl, OPTS.base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null; // skip mailto:, tel:, javascript:, data:, #anchors
  const external = u.origin !== ORIGIN;
  if (external && !OPTS.external) return null;

  const key = checkKey(u);
  let entry = results.get(key);
  if (entry) {
    if (referrer && entry.referrers.length < 5 && !entry.referrers.includes(referrer)) entry.referrers.push(referrer);
    // Already checked (or in flight) -- if a GET-with-body was requested but we
    // only did a HEAD so far, upgrade it; otherwise reuse the cached result.
    if (!needBody || entry.body !== undefined) return entry;
  }

  if (!needBody) {
    const cached = diskCache.get(key);
    if (cached && cached.ok && (Date.now() - cached.checkedAt) < OPTS.cacheTtlMs) {
      entry = { ...cached, referrers: referrer ? [referrer] : [], body: undefined, fromCache: true };
      results.set(key, entry);
      fromCache++;
      return entry;
    }
  }

  const task = limit(async () => {
    // Re-check the cache after acquiring a slot: another task may have
    // finished the same URL while this one was queued.
    entry = results.get(key);
    if (entry && (!needBody || entry.body !== undefined)) {
      if (referrer && entry.referrers.length < 5 && !entry.referrers.includes(referrer)) entry.referrers.push(referrer);
      return entry;
    }
    entry = entry || { url: u.href, method, status: null, ok: false, error: null, referrers: [], external, body: undefined };
    if (referrer && !entry.referrers.includes(referrer)) entry.referrers.push(referrer);
    results.set(key, entry);

    const httpMethod = needBody ? 'GET' : method;
    // Network errors and 5xx are frequently transient noise (a CDN briefly
    // rate-limiting a sustained high-concurrency crawl, not a truly broken
    // resource -- confirmed by spot-checking failures from an unretried run,
    // every one of which came back 200 seconds later). 4xx is never retried:
    // a 404/403 is a stable, meaningful answer.
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        let res = await fetchWithTimeout(u.href, { method: httpMethod }, OPTS.timeout);
        // Some servers (esp. third-party) don't support HEAD well; fall back to GET.
        if (!needBody && (res.status === 405 || res.status === 501)) {
          res = await fetchWithTimeout(u.href, { method: 'GET' }, OPTS.timeout);
        }
        if (res.status >= 500 && attempt < 2) {
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        entry.status = res.status;
        entry.ok = res.ok;
        entry.contentType = res.headers.get('content-type') || '';
        if (needBody) entry.body = res.ok ? await res.text() : '';
        entry.error = null;
        break;
      } catch (err) {
        entry.ok = false;
        entry.error = err.name === 'AbortError' ? `timeout after ${OPTS.timeout}ms` : err.message;
        if (attempt < 2) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
      }
    }
    checked++;
    if (checked % 250 === 0) process.stderr.write(`  ...${checked} resources checked\n`);
    return entry;
  });
  pending.push(task);
  return task;
}

// ── Phase 1: static page enumeration (so orphaned pages aren't missed) ────

const EXCLUDED_PREFIXES = [
  '_site', 'node_modules', '.git', '.history', '.playwright-profile',
  'scripts', 'sources', 'tests',
  'courts/ussc/cache', 'courts/ussc/indexes', 'courts/ussc/journals', 'courts/ussc/opinions',
  'courts/ussc/transcripts/pdfs', 'courts/ussc/transcripts/text',
  'data/misc', 'scdb/cache', 'scdb/current',
];
const EXCLUDED_BASENAMES = new Set(['CLAUDE.md', 'README.md']);

function isExcluded(relPath) {
  const posix = relPath.split(path.sep).join('/');
  if (EXCLUDED_PREFIXES.some(p => posix === p || posix.startsWith(p + '/'))) return true;
  const segments = posix.split('/');
  if (segments.some(s => s.startsWith('_'))) return true; // _layouts, _includes, _data, _sass, etc.
  return false;
}

function extractFrontMatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  return text.slice(3, end);
}

function urlForSourceFile(relPath, frontMatter) {
  const permalinkMatch = frontMatter.match(/^permalink:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (permalinkMatch) {
    let p = permalinkMatch[1].trim();
    if (!p.startsWith('/')) p = '/' + p;
    return p;
  }
  const posix = relPath.split(path.sep).join('/');
  const dir = path.posix.dirname(posix);
  const base = path.posix.basename(posix);
  const dirPart = dir === '.' ? '' : '/' + dir;
  if (base === 'index.md' || base === 'index.html' || base === 'index.markdown') {
    return dirPart + '/';
  }
  const noExt = base.replace(/\.(md|markdown|html)$/, '');
  return dirPart + '/' + noExt + '.html';
}

function collectSourcePages(root) {
  const urls = new Set();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs);
      if (isExcluded(rel)) continue;
      if (ent.isDirectory()) { walk(abs); continue; }
      if (!/\.(md|markdown|html)$/.test(ent.name)) continue;
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const fm = extractFrontMatter(text);
      if (fm === null) continue; // no front matter -> not a Jekyll page
      urls.add(urlForSourceFile(rel, fm));
    }
  }
  walk(root);
  return urls;
}

// ── Phase 1: structural BFS crawl ──────────────────────────────────────────

const LINK_ATTRS = [
  ['a', 'href'], ['img', 'src'], ['link', 'href'], ['script', 'src'],
  ['source', 'src'], ['audio', 'src'], ['video', 'src'], ['iframe', 'src'], ['track', 'src'],
];

async function crawlPage(pageUrl, referrer, visitedPathnames, pageQueue) {
  const entry = await checkUrl(pageUrl, referrer, { method: 'GET', needBody: true });
  if (!entry || entry.body === undefined) return;
  if (!/text\/html/.test(entry.contentType) && !/text\/css/.test(entry.contentType)) return;

  if (/text\/css/.test(entry.contentType)) {
    for (const m of entry.body.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const ref = m[2];
      if (ref.startsWith('data:')) continue;
      checkUrl(ref, pageUrl).catch(() => {});
    }
    return;
  }

  let root;
  try { root = parseHtml(entry.body); } catch { return; }
  for (const [tag, attr] of LINK_ATTRS) {
    for (const el of root.querySelectorAll(tag)) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      let u;
      try { u = new URL(val, pageUrl); } catch { continue; }
      if (!/^https?:$/.test(u.protocol)) continue;
      const isSameOrigin = u.origin === ORIGIN;
      const isPageLink = tag === 'a' || tag === 'iframe';
      if (isSameOrigin && isPageLink) {
        const pn = u.pathname;
        if (!visitedPathnames.has(pn)) {
          visitedPathnames.add(pn);
          pageQueue.push({ url: u.href, referrer: pageUrl });
        }
      } else {
        checkUrl(u.href, pageUrl).catch(() => {});
      }
    }
  }
}

async function runPhase1() {
  console.log(`Phase 1: structural crawl from ${OPTS.base}`);
  const seeds = new Set([OPTS.base + '/', OPTS.base + '/courts/ussc/']);
  for (const p of collectSourcePages(REPO_ROOT)) seeds.add(OPTS.base + p);

  const visitedPathnames = new Set([...seeds].map(s => new URL(s).pathname));
  const pageQueue = [...seeds].map(url => ({ url, referrer: null }));
  let pagesCrawled = 0;

  while (pageQueue.length) {
    const batch = pageQueue.splice(0, pageQueue.length);
    await Promise.all(batch.map(async ({ url, referrer }) => {
      await crawlPage(url, referrer, visitedPathnames, pageQueue);
      pagesCrawled++;
    }));
  }
  console.log(`  crawled ${pagesCrawled} distinct pages (by pathname), discovering ${results.size} resource URLs so far`);
}

// ── Phase 2: data-driven exhaustive same-origin resource check ────────────

async function fetchJson(pathOrUrl, referrer) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : OPTS.base + pathOrUrl;
  const entry = await checkUrl(url, referrer, { method: 'GET', needBody: true });
  if (!entry || !entry.ok || !entry.body) return null;
  try { return JSON.parse(entry.body); } catch { return null; }
}

async function runPhase2() {
  console.log('Phase 2: data-driven same-origin resource check (terms/cases/collections/topics)');

  const decades = await fetchJson('/courts/ussc/terms/terms.json', OPTS.base + '/courts/ussc/');
  if (!decades) { console.log('  ! could not load terms.json -- skipping Phase 2 term/case checks'); }

  let termGroups = [];
  // Skip the "all" pseudo-entry (an aggregate rollup with no per-term cases.json of its own).
  if (decades) for (const decade of decades) for (const g of decade.groups || []) if (g.file) termGroups.push(g);
  if (OPTS.limit) termGroups = termGroups.slice(0, OPTS.limit);

  let casesChecked = 0, eventsChecked = 0, filesJsonChecked = 0;

  await Promise.all(termGroups.map(async (g) => {
    const termRef = `${OPTS.base}/courts/ussc/?term=${g.id}`;
    if (g.journal_cover) {
      checkUrl(path.posix.dirname(g.file) + '/' + g.journal_cover, termRef).catch(() => {});
    }
    const cases = await fetchJson(g.file, termRef);
    if (!cases) return;
    const termDir = path.posix.dirname(g.file); // e.g. /courts/ussc/terms/2024-10
    for (const c of cases) {
      casesChecked++;
      const caseRef = `${OPTS.base}/courts/ussc/?term=${g.id}&case=${encodeURIComponent(c.id || c.number || '')}`;
      let caseDir = null;
      for (const ev of c.events || []) {
        eventsChecked++;
        if (ev.text_href) {
          caseDir = caseDir || ev.text_href.split('/')[0];
          checkUrl(`${termDir}/cases/${ev.text_href}`, caseRef).catch(() => {});
        }
      }
      if (c.files) {
        filesJsonChecked++;
        // files.json always lives under the *first* docket's directory (matching
        // import_oyez.js's convention), even for a consolidated case whose transcript
        // events point at a different docket's text_href -- don't reuse caseDir here.
        const dir = (c.number || '').split(',')[0].trim() || caseDir || c.id;
        if (dir) checkUrl(`${termDir}/cases/${dir}/files.json`, caseRef).catch(() => {});
      }
    }
  }));
  console.log(`  walked ${termGroups.length} terms / ${casesChecked} cases / ${eventsChecked} events (${filesJsonChecked} with files.json)`);

  const collRef = OPTS.base + '/courts/ussc/collections/';
  const collections = await fetchJson('/courts/ussc/collections/collections.json', collRef);
  let collFilesChecked = 0;
  if (collections) {
    for (const category of collections) {
      for (const coll of category.collections || []) {
        if (coll.file) { checkUrl(coll.file, collRef).catch(() => {}); collFilesChecked++; }
      }
    }
  }
  const topics = await fetchJson('/courts/ussc/topics/topics.json', OPTS.base + '/courts/ussc/topics/');
  if (topics) {
    for (const t of topics) {
      if (t.file) { checkUrl(t.file, OPTS.base + '/courts/ussc/topics/').catch(() => {}); collFilesChecked++; }
    }
  }
  console.log(`  queued ${collFilesChecked} collection/topic data files`);
}

// ── Report ──────────────────────────────────────────────────────────────

function printReport() {
  const all = [...results.values()];
  const broken = all.filter(e => !e.ok);
  const ok = all.length - broken.length;

  console.log('\n' + '='.repeat(72));
  console.log('CRAWL REPORT');
  console.log('='.repeat(72));
  console.log(`Base URL:          ${OPTS.base}`);
  console.log(`Total links/resources checked: ${all.length}`);
  console.log(`  OK:              ${ok}`);
  console.log(`  Broken:          ${broken.length}`);
  console.log(`  Same-origin:     ${all.filter(e => !e.external).length}`);
  console.log(`  External:        ${all.filter(e => e.external).length}`);
  if (OPTS.cache) {
    console.log(`  Reused from cache: ${fromCache} (skipped a fresh check; cache TTL ${Math.round(OPTS.cacheTtlMs / 60000)}m)`);
    console.log(`  Freshly checked:   ${checked}`);
  }

  if (broken.length) {
    console.log('\nBroken links/resources:\n');
    const byStatus = new Map();
    for (const e of broken) {
      const label = e.error ? `ERROR: ${e.error}` : `HTTP ${e.status}`;
      if (!byStatus.has(label)) byStatus.set(label, []);
      byStatus.get(label).push(e);
    }
    for (const [label, entries] of [...byStatus.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${label}  (${entries.length})`);
      for (const e of entries) {
        console.log(`    ${e.url}`);
        for (const r of e.referrers) console.log(`        <- ${r}`);
      }
    }
  } else {
    console.log('\nNo broken links or missing resources found.');
  }
  console.log('='.repeat(72));

  if (OPTS.out) {
    // Never serialize `body` -- it holds the full fetched text (HTML pages, and
    // every term's cases.json) for anything checked with needBody, which bloats
    // the report from KBs to hundreds of MBs for no benefit.
    const slim = all.map(({ body, ...rest }) => rest);
    fs.mkdirSync(path.dirname(OPTS.out), { recursive: true });
    fs.writeFileSync(OPTS.out, JSON.stringify({ base: OPTS.base, checked: all.length, broken: broken.length, results: slim }, null, 2));
    console.log(`Full JSON report written to ${OPTS.out}`);
  }

  saveCache();
  if (OPTS.cache) console.log(`Cache written to ${OPTS.cache} (${results.size} entries)`);

  return broken.length;
}

// ── Main ────────────────────────────────────────────────────────────────

(async () => {
  console.log(`argumentaloud.org link crawler`);
  console.log(`  base=${OPTS.base} concurrency=${OPTS.concurrency} timeout=${OPTS.timeout}ms external=${OPTS.external} data=${OPTS.data}${OPTS.limit ? ` limit=${OPTS.limit} terms` : ''}${OPTS.cache ? ` cache=${OPTS.cache}` : ' cache=off'}\n`);

  loadCache();

  try {
    const res = await fetchWithTimeout(OPTS.base + '/', { method: 'GET' }, OPTS.timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.error(`Cannot reach ${OPTS.base}/ (${err.message}). Aborting.`);
    process.exit(2);
  }

  await runPhase1();
  await waitForAll(); // flush images/css/scripts/external links discovered during Phase 1
  if (OPTS.data) {
    await runPhase2();
    await waitForAll(); // flush transcript/files.json/collection checks fired during Phase 2
  }

  const brokenCount = printReport();
  process.exit(brokenCount ? 1 : 0);
})();
