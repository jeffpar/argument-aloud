#!/usr/bin/env node
/**
 * Downloads and caches external assets referenced in cases.json and files.json files.
 *
 * Default mode (cases.json assets):
 *   - decision_loc / decision_ussc / decision_rep  → PDF opinion
 *   - audio_href    → MP3 audio (from each event)
 *   - transcript_href → PDF transcript (from each event)
 *
 * --files mode (files.json assets):
 *   Scans every terms/<term>/cases/<case>/files.json and downloads the href
 *   of each entry to courts/ussc/cache/terms/<term>/<case>/<filename>.
 *
 * --thumbs mode (Original Jurisdiction Archive cover thumbnails):
 *   For every case tagged "Original Jurisdiction Archive", renders page 1 of
 *   each files.json PDF (via pdftoppm) as a JPEG scaled to 400px tall, saved
 *   as courts/ussc/collections/orig/<term>/<case>/<file>.jpg — <file> is the
 *   entry's "file" id, matching the existing hand-curated thumbnails in that
 *   collection. Self-sufficient: downloads/caches the source PDF on demand
 *   (same as --files) if it isn't already cached, so this is the only step
 *   needed after fetching a case's document list via `import_ussc.js --orig`.
 *
 * All assets are stored under courts/ussc/cache/terms/<term>/<case-number>/<filename>.
 * At the end, reports which URLs are no longer reachable.
 *
 * Usage:
 *   node tests/download_media.js [TERM [CASE]] [--files] [--dry-run] [--refetch] [--verbose]
 *   node tests/download_media.js [TERM [CASE]] --thumbs [--dry-run] [--refetch] [--verbose]
 *   node tests/download_media.js [VOLUME] --justia [--dry-run] [--refetch] [--verbose]
 *
 * Options:
 *   TERM       Term in YYYY-10 format (default: all terms)
 *   CASE       Docket number to limit to a single case
 *   VOLUME     Volume number or "usXXX" name to limit --justia to one volume
 *   --files    Download assets from files.json entries instead of cases.json
 *   --thumbs   Generate Original Jurisdiction Archive cover thumbnails (requires pdftoppm)
 *   --justia   Download opinion HTML from supreme.justia.com using the index
 *              files in courts/ussc/opinions/html/usXXX.html.  Each opinion is
 *              saved as courts/ussc/opinions/html/usXXX/usXXX-NNNN.html where
 *              NNNN is the 4-digit 0-padded page number from the citation.
 *              Uses Playwright/Chromium to bypass Cloudflare bot protection.
 *              Combined with --refetch, first fetches fresh volume index pages
 *              from supreme.justia.com/cases/federal/us/volume/ before
 *              downloading opinions (existing files kept on fetch failure).
 *   --dry-run  Show what would be downloaded without fetching anything
 *   --refetch  Re-download even if the file already exists in cache
 *   --verbose  Print skipped files in addition to downloads
 *
 * © 2026 by Jeff Parsons
 */

import fs                from 'node:fs';
import path              from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline }      from 'node:stream/promises';
import { execFile }      from 'node:child_process';
import { promisify }     from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT      = path.resolve(__dirname, '..');
const TERMS_DIR      = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const CACHE_DIR      = path.join(REPO_ROOT, 'courts', 'ussc', 'cache', 'terms');
const OPINIONS_HTML  = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'html');
const ORIG_COLLECTION_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'collections', 'orig');
const _execFile = promisify(execFile);
const PW_PROFILE_DIR = path.join(REPO_ROOT, '.playwright-profile');
const JUSTIA_BASE    = 'https://supreme.justia.com';

const USER_AGENT = 'Mozilla/5.0 argument-aloud/download';
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;   // parallel downloads per term
const DELAY_MS    = 200; // polite pause between requests (ms)

// ── Small helpers ────────────────────────────────────────────────────────────

const exists   = (p) => fs.existsSync(p);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function relRepo(p) {
    const r = path.relative(REPO_ROOT, p);
    return r.startsWith('..') ? p : r;
}

/** Strip #page=N (and any other fragment) from a URL string. */
function stripFragment(url) {
    try { return new URL(url).href.split('#')[0]; } catch { return url.split('#')[0]; }
}

// POSIX NAME_MAX is 255 bytes on macOS APFS/HFS+ and Linux ext4.
// During download the script writes to `destPath + '.tmp'` first, so the
// filename on disk is temporarily 4 bytes longer.  Clamp to 251 so the
// .tmp file also stays within the limit.
const NAME_MAX_BYTES = 251;

/**
 * Return `name` truncated so its UTF-8 encoding fits within NAME_MAX_BYTES,
 * while preserving the file extension and not splitting a multi-byte char.
 */
function safeFname(name) {
    const ext    = path.extname(name);                      // e.g. '.pdf'
    const extLen = Buffer.byteLength(ext, 'utf8');
    const limit  = NAME_MAX_BYTES - extLen;
    const stem   = name.slice(0, name.length - ext.length);
    const stemBuf = Buffer.from(stem, 'utf8');
    if (stemBuf.length <= limit) return name;               // already fits
    // Slice at byte boundary, then drop any trailing incomplete multi-byte char.
    return stemBuf.subarray(0, limit).toString('utf8').replace(/�$/, '') + ext;
}

/** Derive the cache filename from a URL (last path segment, URL-decoded). */
function filenameFromUrl(url) {
    try {
        const u = new URL(url);
        const seg = u.pathname.split('/').filter(Boolean).pop() || 'file';
        return safeFname(decodeURIComponent(seg));
    } catch {
        return safeFname(url.split('/').pop().split('#')[0] || 'file');
    }
}

// ── Case ID / folder-name helpers ────────────────────────────────────────────

/**
 * Return the primary docket number for a case — the first number before any
 * comma in the "number" field, or the "id" if number is absent.
 */
function primaryNumber(c) {
    const n = (c.number || '').split(',')[0].trim();
    return n || c.id || 'unknown';
}

/**
 * Build a map of primary-number → case for a term's case list, falling back to
 * id-based keys for any collisions.
 */
function buildCaseKeyMap(cases) {
    const seen = new Map();   // primaryNumber → count
    for (const c of cases) {
        const k = primaryNumber(c);
        seen.set(k, (seen.get(k) || 0) + 1);
    }
    const map = new Map();    // case → cache folder name
    for (const c of cases) {
        const k = primaryNumber(c);
        map.set(c, seen.get(k) > 1 ? (c.id || k) : k);
    }
    return map;
}

// ── Download state ───────────────────────────────────────────────────────────

const results = {
    downloaded: 0,
    skipped:    0,
    failed:     0,
    missing:    [],   // { term, caseKey, url, reason }
};

// ── Per-directory dead-URL registry ──────────────────────────────────────────
// Dead URLs (permanent HTTP errors like 404) are recorded in a '.skipped' JSON
// file inside each cache directory.  This avoids polluting the directory with
// per-file sentinels while still preventing futile retries on subsequent runs.

const SKIPPED_FILE = '.skipped';
const _skippedSets = new Map();   // cacheDir → Set<url>

function _loadSkipped(cacheDir) {
    if (_skippedSets.has(cacheDir)) return _skippedSets.get(cacheDir);
    const p = path.join(cacheDir, SKIPPED_FILE);
    let set;
    try   { set = new Set(JSON.parse(fs.readFileSync(p, 'utf8'))); }
    catch { set = new Set(); }
    _skippedSets.set(cacheDir, set);
    return set;
}

function _saveSkipped(cacheDir) {
    const set = _skippedSets.get(cacheDir);
    if (!set) return;
    ensureDir(cacheDir);
    fs.writeFileSync(
        path.join(cacheDir, SKIPPED_FILE),
        JSON.stringify([...set].sort(), null, 2),
    );
}

function isSkipped(cacheDir, url)   { return _loadSkipped(cacheDir).has(url); }
function markSkipped(cacheDir, url) { _loadSkipped(cacheDir).add(url); _saveSkipped(cacheDir); }

// ── HTTP fetch with timeout ───────────────────────────────────────────────────

async function fetchWithTimeout(url, method = 'GET') {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        return await fetch(url, {
            method,
            headers: { 'User-Agent': USER_AGENT },
            signal: ctrl.signal,
        });
    } finally {
        clearTimeout(t);
    }
}

// ── Download one asset ────────────────────────────────────────────────────────

/**
 * Download `url` to `destPath`.
 * Returns 'downloaded', 'skipped' (already exists), or { status:'failed', permanent, reason }.
 */
async function downloadAsset(url, destPath, { force, verbose, dryRun }) {
    const rel = relRepo(destPath);
    if (!force && exists(destPath)) {
        if (verbose) console.log(`  skip  ${url}\n         → ${rel}`);
        return 'skipped';
    }
    if (dryRun) {
        console.log(`  ${url}\n    → ${rel}  [dry-run]`);
        return 'downloaded';
    }
    console.log(`  ${url}\n    → ${rel}`);
    let resp;
    try {
        resp = await fetchWithTimeout(url);
    } catch (err) {
        return { status: 'failed', permanent: false, reason: String(err?.message || err) };
    }
    if (!resp.ok) {
        // 404 / 410 are permanent; other codes (5xx, 429…) may succeed later.
        const permanent = resp.status === 404 || resp.status === 410;
        return { status: 'failed', permanent, reason: `HTTP ${resp.status}` };
    }
    ensureDir(path.dirname(destPath));
    try {
        const tmp = destPath + '.tmp';
        const dest = fs.createWriteStream(tmp);
        await pipeline(resp.body, dest);
        fs.renameSync(tmp, destPath);
    } catch (err) {
        try { fs.unlinkSync(destPath + '.tmp'); } catch {}
        return { status: 'failed', permanent: false, reason: String(err?.message || err) };
    }
    return 'downloaded';
}

// ── Process a single asset URL for a case ────────────────────────────────────

async function processUrl(url, cacheDir, term, caseKey, opts) {
    const cleanUrl = stripFragment(url);

    // Skip URLs that permanently failed in a previous run.
    if (!opts.force && isSkipped(cacheDir, cleanUrl)) {
        results.skipped++;
        await sleep(DELAY_MS);
        return;
    }

    const fname    = filenameFromUrl(cleanUrl);
    const destPath = path.join(cacheDir, fname);
    const outcome  = await downloadAsset(cleanUrl, destPath, opts);

    if (typeof outcome === 'object' && outcome.status === 'failed') {
        results.failed++;
        results.missing.push({ term, caseKey, url: cleanUrl, reason: outcome.reason });
        if (opts.verbose || !opts.quiet) {
            console.log(`  FAIL  ${cleanUrl}  (${outcome.reason})`);
        }
        if (outcome.permanent && !opts.dryRun) markSkipped(cacheDir, cleanUrl);
    } else if (outcome === 'downloaded') {
        results.downloaded++;
    } else {
        results.skipped++;
    }

    await sleep(DELAY_MS);
}

// ── Process one case ──────────────────────────────────────────────────────────

async function processCase(term, c, folderKey, opts) {
    const cacheDir = path.join(CACHE_DIR, term, folderKey);
    const label    = `${term}/${folderKey}`;

    if (opts.verbose) console.log(`\n[${label}]`);

    const tasks = [];

    // decision hrefs
    if (c.decision_loc)     tasks.push({ url: c.decision_loc });
    if (c.decision_ussc)    tasks.push({ url: c.decision_ussc });
    if (c.decision_rep) tasks.push({ url: c.decision_rep });

    // event assets: audio_href, transcript_href
    for (const ev of c.events || []) {
        if (ev.audio_href)      tasks.push({ url: ev.audio_href });
        if (ev.transcript_href) tasks.push({ url: ev.transcript_href });
    }

    if (!tasks.length) return;

    if (!opts.verbose && !opts.dryRun) {
        process.stdout.write(`  ${label}: ${tasks.length} asset(s)\r`);
    }

    // Process with limited concurrency
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.all(
            batch.map(({ url }) => processUrl(url, cacheDir, term, folderKey, opts))
        );
    }
}

// ── Process one term ──────────────────────────────────────────────────────────

async function processTerm(term, caseFilter, opts) {
    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    if (!exists(casesPath)) {
        if (opts.verbose) console.log(`[${term}] no cases.json — skipping`);
        return;
    }

    let cases;
    try {
        cases = readJson(casesPath);
    } catch (err) {
        console.error(`[${term}] failed to parse cases.json: ${err.message}`);
        return;
    }

    const keyMap = buildCaseKeyMap(cases);

    // Apply case filter if given
    const filtered = caseFilter
        ? cases.filter(c =>
            c.id === caseFilter ||
            (c.number || '').split(',').map(n => n.trim()).includes(caseFilter)
          )
        : cases;

    if (caseFilter && !filtered.length) {
        console.warn(`[${term}] case '${caseFilter}' not found`);
        return;
    }

    console.log(`\n── ${term} (${filtered.length} case(s)) ──`);

    for (const c of filtered) {
        await processCase(term, c, keyMap.get(c), opts);
    }
}

// ── Process one case's files.json ─────────────────────────────────────────────

async function processFilesForCase(term, caseId, opts) {
    const filesJsonPath = path.join(TERMS_DIR, term, 'cases', caseId, 'files.json');
    if (!exists(filesJsonPath)) return;

    let entries;
    try {
        entries = readJson(filesJsonPath);
    } catch (err) {
        console.error(`  error reading ${relRepo(filesJsonPath)}: ${err.message}`);
        return;
    }

    const tasks = entries.filter(e => e.href);
    if (!tasks.length) return;

    const cacheDir = path.join(CACHE_DIR, term, caseId);

    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.all(
            batch.map(({ href }) => processUrl(href, cacheDir, term, caseId, opts))
        );
    }
}

// ── Process one term's files.json assets ──────────────────────────────────────

async function processTermFilesMode(term, caseFilter, opts) {
    const casesDir = path.join(TERMS_DIR, term, 'cases');
    if (!exists(casesDir)) {
        if (opts.verbose) console.log(`[${term}] no cases/ directory — skipping`);
        return;
    }

    let caseIds;
    try {
        caseIds = fs.readdirSync(casesDir)
            .filter(d => exists(path.join(casesDir, d, 'files.json')));
    } catch (err) {
        console.error(`[${term}] failed to read cases directory: ${err.message}`);
        return;
    }

    if (caseFilter) {
        caseIds = caseIds.filter(id => id === caseFilter);
        if (!caseIds.length) {
            console.warn(`[${term}] case '${caseFilter}' not found`);
            return;
        }
    }

    if (!caseIds.length) return;

    console.log(`\n── ${term} (${caseIds.length} case(s) with files.json) ──`);

    for (const caseId of caseIds.sort()) {
        if (opts.verbose) console.log(`\n[${term}/${caseId}]`);
        await processFilesForCase(term, caseId, opts);
    }
}

// ── Original Jurisdiction Archive thumbnails ───────────────────────────────────
//
// For every case tagged "Original Jurisdiction Archive", render page 1 of each
// cached files.json PDF as a JPEG (height 400px, width proportional — matching
// the existing hand-curated thumbnails under courts/ussc/collections/orig/),
// stored at courts/ussc/collections/orig/<term>/<caseId>/<file>.jpg, where
// <file> is the entry's "file" id from files.json (not derived from the URL).

async function _generateThumbnail(pdfPath, outputJpgPath) {
    const prefix = outputJpgPath.slice(0, -4); // strip ".jpg"
    const dir    = path.dirname(prefix);
    const base   = path.basename(prefix);
    ensureDir(dir);
    try {
        await _execFile('pdftoppm', [
            '-jpeg', '-f', '1', '-l', '1',
            '-scale-to-y', '400', '-scale-to-x', '-1',
            pdfPath, prefix,
        ], { timeout: 60000 });
        // pdftoppm names the output <prefix>-N.jpg (padding width depends on -l).
        const created = fs.readdirSync(dir).find(f => f.startsWith(base + '-') && f.endsWith('.jpg'));
        if (created) {
            const tmp = path.join(dir, created);
            if (tmp !== outputJpgPath) fs.renameSync(tmp, outputJpgPath);
            return true;
        }
    } catch (e) {
        console.log(`  Warning: pdftoppm failed for ${path.basename(pdfPath)}: ${e.message || e}`);
    }
    return false;
}

async function processThumbsForCase(term, caseId, opts) {
    const filesJsonPath = path.join(TERMS_DIR, term, 'cases', caseId, 'files.json');
    if (!exists(filesJsonPath)) return;

    let entries;
    try { entries = readJson(filesJsonPath); } catch { return; }

    const cacheDir = path.join(CACHE_DIR, term, caseId);

    for (let i = 0; i < entries.length; i += CONCURRENCY) {
        const batch = entries.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(e => processThumbEntry(e, term, caseId, cacheDir, opts)));
    }
}

async function processThumbEntry(e, term, caseId, cacheDir, opts) {
    if (!e.href || e.file == null) return;

    const outJpg = path.join(ORIG_COLLECTION_DIR, term, caseId, `${e.file}.jpg`);
    if (!opts.force && exists(outJpg)) {
        if (opts.verbose) console.log(`  skip  ${relRepo(outJpg)}`);
        results.skipped++;
        return;
    }

    // Ensure the PDF is cached locally, downloading it on demand if not
    // (mirrors --files mode, so --thumbs doesn't require a separate pass).
    const cleanUrl = stripFragment(e.href);
    const pdfPath  = path.join(cacheDir, filenameFromUrl(cleanUrl));
    if (!exists(pdfPath)) {
        if (!opts.force && isSkipped(cacheDir, cleanUrl)) {
            results.skipped++;
            await sleep(DELAY_MS);
            return;
        }
        const outcome = await downloadAsset(cleanUrl, pdfPath, opts);
        if (typeof outcome === 'object' && outcome.status === 'failed') {
            results.failed++;
            results.missing.push({ term, caseKey: caseId, url: cleanUrl, reason: outcome.reason });
            console.log(`  FAIL  ${cleanUrl}  (${outcome.reason})`);
            if (outcome.permanent && !opts.dryRun) markSkipped(cacheDir, cleanUrl);
            await sleep(DELAY_MS);
            return;
        }
        await sleep(DELAY_MS);
    }

    if (opts.dryRun) {
        console.log(`  ${relRepo(pdfPath)}\n    → ${relRepo(outJpg)}  [dry-run]`);
        results.downloaded++;
        return;
    }

    console.log(`  ${relRepo(pdfPath)}\n    → ${relRepo(outJpg)}`);
    const ok = await _generateThumbnail(pdfPath, outJpg);
    if (ok) results.downloaded++; else results.failed++;
}

async function processTermThumbsMode(term, caseFilter, opts) {
    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    if (!exists(casesPath)) return;

    let cases;
    try { cases = readJson(casesPath); } catch { return; }

    const targets = [];
    for (const c of cases) {
        if (!(Array.isArray(c.tags) && c.tags.includes('Original Jurisdiction Archive'))) continue;
        const nums   = (c.number || '').split(',').map(s => s.trim());
        const caseId = nums.find(n => /^\d+-Orig$/i.test(n));
        if (!caseId) continue;
        if (caseFilter && caseId !== caseFilter) continue;
        targets.push(caseId);
    }
    if (!targets.length) return;

    console.log(`\n── ${term} (${targets.length} Original Jurisdiction Archive case(s)) ──`);
    for (const caseId of targets.sort()) {
        if (opts.verbose) console.log(`\n[${term}/${caseId}]`);
        await processThumbsForCase(term, caseId, opts);
    }
}

// ── Justia volume-index mode ──────────────────────────────────────────────────

/**
 * Parse a volume index HTML file and return an array of
 * { url, destPath } for every opinion linked within it.
 *
 * The href pattern inside these files is:
 *   href="/cases/federal/us/{vol}/{page}[/{suffix}]/"  class="case-name"
 * For volumes ≤ 577 the page segment is a plain number (zero-padded to 4 digits):
 *   us001.html  →  us001/us001-0005.html  for page 5
 * For volumes > 577 the segment may be a case number (e.g. "18-556"), used as-is:
 *   us589.html  →  us589/us589-18-556.html
 * Original jurisdiction cases have an extra "orig" path segment:
 *   us585.html  →  us585/us585-0142-orig.html  for /585/142/orig/
 */
function parseJustiaVolume(htmlFile) {
    const basename = path.basename(htmlFile, '.html');   // e.g. "us001"
    const html = fs.readFileSync(htmlFile, 'utf8');
    const re = /href="(\/cases\/federal\/us\/\d+\/([\d-]+)(?:\/(orig))?\/)" class="case-name"/g;
    const entries = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        const relPath = m[1];
        const pageStr = m[2];                            // e.g. "5", "18-556", or "142"
        const suffix  = m[3] || '';                      // e.g. "orig" or ""
        const key     = suffix ? `${pageStr}/${suffix}` : pageStr;
        if (seen.has(key)) continue;
        seen.add(key);
        // Pure numeric pages are zero-padded to 4 digits; hyphenated case numbers are used as-is.
        const pagePart = /^\d+$/.test(pageStr) ? String(parseInt(pageStr, 10)).padStart(4, '0') : pageStr;
        const filePart = suffix ? `${pagePart}-${suffix}` : pagePart;
        const url      = JUSTIA_BASE + relPath;
        const destDir  = path.join(OPINIONS_HTML, basename);
        const destPath = path.join(destDir, `${basename}-${filePart}.html`);
        entries.push({ url, destPath });
    }
    return entries;
}

// ── Playwright browser (shared across all Justia downloads) ──────────────────
// Uses a persistent Chrome profile so Cloudflare clearance cookies survive
// across runs.  If challenged on first use, solve the CAPTCHA once in the
// visible window; subsequent requests (and future runs) reuse the saved cookies.

let _pwContext = null;
let _pwPage    = null;

async function getPWPage() {
    if (_pwPage) {
        try { await _pwPage.title(); return _pwPage; } catch { _pwContext = null; _pwPage = null; }
    }
    const { chromium } = await import('playwright');
    _pwContext = await chromium.launchPersistentContext(PW_PROFILE_DIR, {
        headless: false,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled'],
    });
    _pwPage = await _pwContext.newPage();
    return _pwPage;
}

async function closePWBrowser() {
    if (_pwContext) { await _pwContext.close(); _pwContext = null; _pwPage = null; }
}

// Cloudflare challenge titles that require waiting (with or without user action).
const CF_CHALLENGE_TITLES = ['Just a moment...', 'Verify you are human'];

/**
 * If the current page is a Cloudflare challenge, print a notice and wait
 * indefinitely for it to clear (either auto-resolve or manual CAPTCHA solve).
 */
async function waitForCloudflare(page, url) {
    const title = await page.title();
    if (!CF_CHALLENGE_TITLES.includes(title)) return;
    process.stdout.write('\x07');  // terminal bell
    console.log(`\n  [Cloudflare challenge detected for ${url}]`);
    console.log('  → Solve the verification in the Chrome window; the script will resume automatically.\n');
    await page.waitForFunction(
        (titles) => !titles.includes(document.title),
        CF_CHALLENGE_TITLES,
        { timeout: 0 },  // wait indefinitely
    );
}

async function playwrightDownload(url, destPath) {
    const page = await getPWPage();
    try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const status = response?.status() ?? 0;
        if (status === 404 || status === 410) {
            return { status: 'failed', permanent: true, reason: `HTTP ${status}` };
        }
        await waitForCloudflare(page, url);
        const html = await page.content();
        ensureDir(path.dirname(destPath));
        const tmp = destPath + '.tmp';
        fs.writeFileSync(tmp, html, 'utf8');
        fs.renameSync(tmp, destPath);
        return 'downloaded';
    } catch (err) {
        return { status: 'failed', permanent: false, reason: err.message.split('\n')[0] };
    }
}

async function downloadJustiaEntry({ url, destPath }, basename, opts) {
    const cacheDir = path.dirname(destPath);
    if (!opts.force && isSkipped(cacheDir, url)) {
        results.skipped++;
        return;
    }
    if (!opts.force && exists(destPath)) {
        if (opts.verbose) console.log(`  skip  ${url}`);
        results.skipped++;
        return;
    }
    const rel = relRepo(destPath);
    if (opts.dryRun) {
        console.log(`  ${url}\n    → ${rel}  [dry-run]`);
        results.downloaded++;
        return;
    }
    console.log(`  ${url}\n    → ${rel}`);
    const outcome = await playwrightDownload(url, destPath);
    if (typeof outcome === 'object' && outcome.status === 'failed') {
        results.failed++;
        results.missing.push({ term: basename, caseKey: path.basename(destPath), url, reason: outcome.reason });
        console.log(`  FAIL  ${url}  (${outcome.reason})`);
        if (outcome.permanent) markSkipped(cacheDir, url);
    } else {
        results.downloaded++;
    }
    await sleep(DELAY_MS);
}

async function processJustiaVolume(htmlFile, opts) {
    const basename = path.basename(htmlFile, '.html');
    const entries  = parseJustiaVolume(htmlFile);
    if (!entries.length) return;

    console.log(`\n── ${basename} (${entries.length} opinion(s)) ──`);

    // Sequential — Playwright uses a single shared page/context
    for (const e of entries) {
        await downloadJustiaEntry(e, basename, opts);
    }
}

/**
 * Phase 1 of --justia --refetch: fetch fresh volume index pages (usXXX.html)
 * by reading the Justia volume listing and downloading each volume's index page.
 * Existing files are never overwritten unless the fetch succeeds.
 */
async function fetchJustiaVolumePages(volFilter, opts) {
    const listingUrl = `${JUSTIA_BASE}/cases/federal/us/volume/`;
    const label = opts.force ? 'refreshing all volume index pages' : 'fetching missing volume index pages';
    console.log(`\n── Phase 1: ${label} ──`);
    console.log(`  ${listingUrl}`);

    // Fetch the volume listing to discover all volume numbers.
    let listingHtml;
    if (!opts.dryRun) {
        const page = await getPWPage();
        try {
            await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await waitForCloudflare(page, listingUrl);
            listingHtml = await page.content();
        } catch (err) {
            console.error(`  FAIL  ${listingUrl}  (${err.message.split('\n')[0]})`);
            return;
        }
    }

    // Parse volume numbers from the listing page links.
    const re = /href="\/cases\/federal\/us\/(\d+)\/"/g;
    const volNums = new Set();
    if (listingHtml) {
        let m;
        while ((m = re.exec(listingHtml)) !== null) {
            const n = parseInt(m[1], 10);
            if (n >= 1 && n <= 700) volNums.add(n);
        }
    }

    if (!opts.dryRun && !volNums.size) {
        console.error('  Could not parse any volume links from the listing page');
        return;
    }

    let volumes = [...volNums].sort((a, b) => a - b);

    if (volFilter) {
        const norm = volFilter.startsWith('us')
            ? parseInt(volFilter.replace(/^us0*/, ''), 10)
            : parseInt(volFilter, 10);
        volumes = volumes.filter(v => v === norm);
        if (!volumes.length && !opts.dryRun) {
            console.error(`  Volume '${volFilter}' not found in the Justia listing`);
            return;
        }
    }

    // When not force-refetching, skip volumes that already have a local HTML file.
    const toFetch = opts.force ? volumes : volumes.filter(v => {
        const padded = String(v).padStart(3, '0');
        return !fs.existsSync(path.join(OPINIONS_HTML, `us${padded}`, `us${padded}.html`));
    });

    if (!opts.dryRun) {
        const newNote = opts.force ? '' : ` (${toFetch.length} missing)`;
        console.log(`  Found ${volNums.size} volumes${newNote}`);
        if (!toFetch.length) {
            console.log('  All volume index pages already on disk — nothing to fetch');
            return;
        }
    }

    for (const volNum of toFetch) {
        const padded   = String(volNum).padStart(3, '0');
        const basename = `us${padded}`;
        const destDir  = path.join(OPINIONS_HTML, basename);
        const destPath = path.join(destDir, `${basename}.html`);
        const stagePath = destPath + '.new';
        const url      = `${JUSTIA_BASE}/cases/federal/us/${volNum}/`;
        const rel      = relRepo(destPath);

        if (opts.dryRun) {
            console.log(`  ${url}\n    → ${rel}  [dry-run]`);
            continue;
        }

        console.log(`  ${url}\n    → ${rel}`);
        ensureDir(destDir);
        const outcome = await playwrightDownload(url, stagePath);
        if (typeof outcome === 'object' && outcome.status === 'failed') {
            console.log(`  FAIL  ${url}  (${outcome.reason})`);
            try { fs.unlinkSync(stagePath); } catch {}
            try { fs.unlinkSync(stagePath + '.tmp'); } catch {}
        } else {
            fs.renameSync(stagePath, destPath);
        }

        await sleep(DELAY_MS);
    }
}

async function processJustiaAll(volFilter, opts) {
    // Phase 1: read the Justia volume listing to discover all volumes; fetch any
    // that are missing locally (or all of them when --refetch is specified).
    await fetchJustiaVolumePages(volFilter, opts);

    // Phase 2: download individual opinions from each volume index file.
    console.log(`\n── Phase 2: downloading opinions ──`);

    let htmlFiles;
    try {
        htmlFiles = fs.readdirSync(OPINIONS_HTML)
            .filter(d => /^us\d+$/.test(d))
            .sort()
            .map(d => path.join(OPINIONS_HTML, d, `${d}.html`))
            .filter(f => fs.existsSync(f));
    } catch (err) {
        console.error(`Cannot read ${relRepo(OPINIONS_HTML)}: ${err.message}`);
        process.exit(1);
    }

    if (volFilter) {
        // Accept either "us001" or "1" as a filter
        const norm = volFilter.startsWith('us') ? volFilter : 'us' + volFilter.padStart(3, '0');
        htmlFiles = htmlFiles.filter(f => path.basename(f, '.html') === norm);
        if (!htmlFiles.length) {
            console.error(`No HTML file found for volume '${volFilter}'`);
            process.exit(1);
        }
    }

    for (const htmlFile of htmlFiles) {
        await processJustiaVolume(htmlFile, opts);
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── --checkloc: probe every decision_loc URL for 404s ────────────────────────

async function checkDecisionLoc(termArg, { verbose }) {
    let terms;
    if (termArg) {
        terms = [termArg];
    } else {
        try {
            terms = fs.readdirSync(TERMS_DIR).filter(d => /^\d{4}-\d{2}$/.test(d)).sort();
        } catch (err) {
            console.error(`Cannot read ${TERMS_DIR}: ${err.message}`); return;
        }
    }

    // Collect unique base URLs (strip #fragment) with their first-seen case reference.
    const entries = [];
    const seen = new Set();
    for (const term of terms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        let cases;
        try { cases = readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        for (const c of cases) {
            if (!c.decision_loc) continue;
            const url = stripFragment(c.decision_loc);
            if (seen.has(url)) continue;
            seen.add(url);
            entries.push({ url, term, ref: c.id || c.number || '?' });
        }
    }

    if (!entries.length) { console.log('No decision_loc URLs found.'); return; }
    console.log(`Checking ${entries.length} decision_loc URL(s)...`);

    const failed = [];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
        await Promise.all(entries.slice(i, i + CONCURRENCY).map(async ({ url, term, ref }) => {
            try {
                const resp = await fetchWithTimeout(url, 'HEAD');
                if (resp.status === 404) {
                    failed.push({ url, term, ref });
                    console.log(`  404  ${url}  [${term}/${ref}]`);
                } else if (verbose) {
                    console.log(`  ${resp.status}  ${url}`);
                }
            } catch (err) {
                if (verbose) console.log(`  ERR  ${url}  (${err.message.split('\n')[0]})`);
            }
        }));
        if (i + CONCURRENCY < entries.length) await sleep(DELAY_MS);
    }

    console.log(`\n${failed.length} of ${entries.length} URL(s) returned 404.`);
}

async function main() {
    const argv   = process.argv.slice(2);
    const flags  = new Set(argv.filter(a => a.startsWith('--')));
    const args   = argv.filter(a => !a.startsWith('--'));

    const filesMode  = flags.has('--files');
    const thumbsMode = flags.has('--thumbs');
    const justiaMode = flags.has('--justia');
    const dryRun     = flags.has('--dry-run');
    const force      = flags.has('--refetch');
    const verbose    = flags.has('--verbose');
    const quiet      = !verbose;
    const opts       = { dryRun, force, verbose, quiet };

    const termArg = args[0] || null;
    const caseArg = args[1] || null;

    // ── Check 404 mode ───────────────────────────────────────────────────────
    if (flags.has('--check404')) {
        if (!termArg) {
            console.error('Usage: download.js --check404 <file>');
            process.exit(1);
        }
        const filePath = path.resolve(termArg);
        let lines;
        try {
            lines = fs.readFileSync(filePath, 'utf8').split('\n')
                .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        } catch (err) {
            console.error(`Cannot read ${filePath}: ${err.message}`);
            process.exit(1);
        }
        if (!lines.length) { console.log('No URLs found in file.'); return; }
        console.log(`Checking ${lines.length} URL(s) from ${path.basename(filePath)}...`);
        const recovered = [];
        for (let i = 0; i < lines.length; i += CONCURRENCY) {
            await Promise.all(lines.slice(i, i + CONCURRENCY).map(async url => {
                try {
                    const resp = await fetchWithTimeout(url, 'HEAD');
                    if (resp.status !== 404) {
                        recovered.push({ url, status: resp.status });
                        console.log(`  ${resp.status}  ${url}`);
                    } else if (verbose) {
                        console.log(`  404  ${url}`);
                    }
                } catch (err) {
                    if (verbose) console.log(`  ERR  ${url}  (${err.message.split('\n')[0]})`);
                }
            }));
            if (i + CONCURRENCY < lines.length) await sleep(DELAY_MS);
        }
        console.log(`\n${recovered.length} of ${lines.length} URL(s) no longer return 404.`);
        return;
    }

    // ── Check LOC mode ────────────────────────────────────────────────────────
    if (flags.has('--checkloc')) {
        await checkDecisionLoc(termArg, opts);
        return;
    }

    // ── Justia mode ───────────────────────────────────────────────────────────
    if (justiaMode) {
        if (dryRun) console.log('[dry-run mode — no files will be written]');
        console.log('[justia mode — downloading opinion HTML from supreme.justia.com]');
        const startTime = Date.now();
        try {
            await processJustiaAll(termArg, opts);
        } finally {
            await closePWBrowser();
        }
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('\n');
        console.log('══════════════════════════════════════════');
        console.log('  Justia download summary');
        console.log('══════════════════════════════════════════');
        console.log(`  Downloaded : ${results.downloaded}`);
        console.log(`  Skipped    : ${results.skipped} (already cached)`);
        console.log(`  Failed     : ${results.failed}`);
        console.log(`  Time       : ${elapsed}s`);
        return;
    }

    if (!exists(CACHE_DIR)) {
        console.error(`Cache directory not found: ${relRepo(CACHE_DIR)}`);
        console.error('Create courts/ussc/cache/terms (or symlink it to your storage location) before running this script.');
        process.exit(1);
    }

    // Collect terms to process
    let terms;
    if (termArg) {
        if (!/^\d{4}-\d{2}$/.test(termArg)) {
            console.error(`Invalid term format '${termArg}' — expected YYYY-MM (e.g. 2025-10)`);
            process.exit(1);
        }
        terms = [termArg];
    } else {
        terms = fs.readdirSync(TERMS_DIR)
            .filter(d => /^\d{4}-\d{2}$/.test(d))
            .sort();
    }

    if (dryRun) console.log('[dry-run mode — no files will be written]');
    if (filesMode)  console.log('[files mode — downloading files.json assets]');
    if (thumbsMode) console.log('[thumbs mode — generating Original Jurisdiction Archive thumbnails]');

    const startTime = Date.now();

    for (const term of terms) {
        if (thumbsMode)     await processTermThumbsMode(term, caseArg, opts);
        else if (filesMode) await processTermFilesMode(term, caseArg, opts);
        else                await processTerm(term, caseArg, opts);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n');
    console.log('══════════════════════════════════════════');
    console.log('  Download summary');
    console.log('══════════════════════════════════════════');
    console.log(`  Downloaded : ${results.downloaded}`);
    console.log(`  Skipped    : ${results.skipped} (already cached)`);
    console.log(`  Failed     : ${results.failed}`);
    console.log(`  Time       : ${elapsed}s`);

    if (results.missing.length) {
        console.log('\n── Unavailable assets ──────────────────────────────');
        // Group by term
        const byTerm = {};
        for (const m of results.missing) {
            (byTerm[m.term] = byTerm[m.term] || []).push(m);
        }
        for (const [t, items] of Object.entries(byTerm)) {
            console.log(`\n  ${t}:`);
            for (const { caseKey, url, reason } of items) {
                console.log(`    [${caseKey}] ${url}`);
                console.log(`             ${reason}`);
            }
        }
    } else if (!dryRun) {
        console.log('\n  All assets accounted for — nothing unavailable.');
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
