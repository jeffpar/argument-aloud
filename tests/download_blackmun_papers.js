#!/usr/bin/env node
/**
 * Downloads every PDF referenced in Harry Blackmun's docket/memo archive
 * pages — courts/ussc/people/justices/all/harry_blackmun/_private/YYYY.html,
 * saved copies of pages from blackmun.wustl.edu — into a sibling YYYY/
 * folder.
 *
 * Each page's PDF hrefs are relative (e.g.
 * "./blackmunDockets/1989/Paid/docket-89-4.pdf" or
 * "./BlackmunMemos1987/87Memos-pdf/87-193.pdf"), resolved against
 * http://blackmun.wustl.edu/. The local path is derived by taking the
 * portion of the href's path that follows the page's own YYYY string —
 * e.g. "1989/Paid/docket-89-4.pdf" or "1987/87Memos-pdf/87-193.pdf" — which
 * drops the source site's inconsistent top-level folder naming while
 * keeping every file's path unique within its year.
 *
 * A tiny handful of hrefs don't contain the year at all (one known instance,
 * in 1986.html — a stray/duplicate link to a file also linked correctly
 * elsewhere); those are reported and skipped rather than guessed at.
 *
 * Usage:
 *   node scripts/download_blackmun_papers.js [YEAR] [--dry-run] [--refetch] [--verbose]
 *
 * Options:
 *   YEAR       Limit to one year, e.g. 1989 (default: every YYYY.html found)
 *   --dry-run  Show what would be downloaded without fetching anything
 *   --refetch  Re-download even if the local file already exists
 *   --verbose  Print skipped (already-downloaded) files too
 */

import fs                from 'node:fs';
import path              from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline }      from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT   = path.resolve(__dirname, '..');
const PRIVATE_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices', 'all', 'harry_blackmun', '_private');
const BASE_URL    = 'http://blackmun.wustl.edu/';

const USER_AGENT  = 'Mozilla/5.0 argument-aloud/download';
const TIMEOUT_MS  = 30_000;
const CONCURRENCY = 4;     // parallel downloads per year
const DELAY_MS    = 200;   // polite pause between requests (ms)

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function relRepo(p) {
    const r = path.relative(REPO_ROOT, p);
    return r.startsWith('..') ? p : r;
}

function unescapeHtml(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

// Extract every unique href="....pdf" from raw HTML (case-insensitive extension).
function extractPdfHrefs(html) {
    const out = new Set();
    const re = /href\s*=\s*"([^"]+\.pdf)"/gi;
    let m;
    while ((m = re.exec(html))) out.add(unescapeHtml(m[1]));
    return [...out];
}

// Return the portion of href's path after the first occurrence of `year`,
// with any leading slashes stripped — e.g. splitAfterYear(
// "./blackmunDockets/1989/Paid/docket-89-4.pdf", "1989") -> "Paid/docket-89-4.pdf".
// Returns null if `year` doesn't appear in href at all.
function splitAfterYear(href, year) {
    const idx = href.indexOf(year);
    if (idx === -1) return null;
    return href.slice(idx + year.length).replace(/^\/+/, '');
}

// Strip a trailing "-pdf" from directory segments only, never the filename —
// e.g. "MissedMemos-pdf/86-2.pdf" -> "MissedMemos/86-2.pdf". The source
// site's own folder naming is inconsistent about this suffix (some years use
// "MissedMemos", others "MissedMemos-pdf" for the same kind of folder), so
// this keeps local folder names uniform.
function stripPdfDirSuffix(rel) {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length - 1; i++) parts[i] = parts[i].replace(/-pdf$/, '');
    return parts.join('/');
}

async function fetchWithTimeout(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        return await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
    } finally {
        clearTimeout(t);
    }
}

// ── Per-year dead-URL registry (avoids futile retries of permanent 404s) ────

const SKIPPED_FILE = '.skipped';
function loadSkipped(yearDir) {
    try { return new Set(JSON.parse(fs.readFileSync(path.join(yearDir, SKIPPED_FILE), 'utf8'))); }
    catch { return new Set(); }
}
function saveSkipped(yearDir, set) {
    ensureDir(yearDir);
    fs.writeFileSync(path.join(yearDir, SKIPPED_FILE), JSON.stringify([...set].sort(), null, 2));
}

// ── Download one file ────────────────────────────────────────────────────

async function downloadOne(url, destPath, opts, skipSet) {
    if (!opts.refetch && fs.existsSync(destPath)) {
        if (opts.verbose) console.log(`  skip  ${relRepo(destPath)}`);
        return 'skipped';
    }
    if (!opts.refetch && skipSet.has(url)) {
        if (opts.verbose) console.log(`  dead  ${url}`);
        return 'skipped';
    }
    if (opts.dryRun) {
        console.log(`  ${url}\n    -> ${relRepo(destPath)}  [dry-run]`);
        return 'downloaded';
    }
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
    const tmp = destPath + '.tmp';
    try {
        await pipeline(resp.body, fs.createWriteStream(tmp));
        fs.renameSync(tmp, destPath);
    } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        return { status: 'failed', permanent: false, reason: String(err?.message || err) };
    }
    console.log(`  ${relRepo(destPath)}`);
    return 'downloaded';
}

// ── Process one YYYY.html page ───────────────────────────────────────────

async function processYear(year, opts) {
    const htmlPath = path.join(PRIVATE_DIR, `${year}.html`);
    const html = fs.readFileSync(htmlPath, 'utf8');
    const hrefs = extractPdfHrefs(html);

    const yearDir  = path.join(PRIVATE_DIR, year);
    const skipSet  = loadSkipped(yearDir);

    const tasks = [];
    const orphans = [];
    for (const href of hrefs) {
        const rel = splitAfterYear(href, year);
        if (rel === null) { orphans.push(href); continue; }
        const url = new URL(href, BASE_URL).href;
        tasks.push({ url, destPath: path.join(yearDir, stripPdfDirSuffix(rel)) });
    }

    for (const href of orphans) {
        console.warn(`  WARN  [${year}] no "${year}" found in href, skipping: ${href}`);
    }

    console.log(`\n── ${year}: ${tasks.length} unique PDF(s) ──`);

    let downloaded = 0, skipped = 0, failed = 0;
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async ({ url, destPath }) => {
            const outcome = await downloadOne(url, destPath, opts, skipSet);
            if (typeof outcome === 'object') {
                failed++;
                console.log(`  FAIL  ${url}  (${outcome.reason})`);
                if (outcome.permanent && !opts.dryRun) { skipSet.add(url); saveSkipped(yearDir, skipSet); }
            } else if (outcome === 'downloaded') {
                downloaded++;
            } else {
                skipped++;
            }
            // Only throttle requests that actually hit the network — a local
            // already-exists/dead-URL skip costs nothing and shouldn't be
            // artificially delayed (this matters a lot on a re-run, where
            // nearly every file is already downloaded).
            if (!opts.dryRun && outcome !== 'skipped') await sleep(DELAY_MS);
        }));
        if (!opts.verbose && !opts.dryRun) {
            process.stdout.write(`  ${year}: ${Math.min(i + CONCURRENCY, tasks.length)}/${tasks.length}\r`);
        }
    }
    console.log(`${year}: downloaded ${downloaded}, skipped ${skipped}, failed ${failed}`);
}

async function main() {
    const args = process.argv.slice(2);
    const opts = {
        dryRun:  args.includes('--dry-run'),
        refetch: args.includes('--refetch'),
        verbose: args.includes('--verbose'),
    };
    const yearArg = args.find(a => /^\d{4}$/.test(a));

    if (!fs.existsSync(PRIVATE_DIR)) {
        console.error(`ERROR: not found: ${relRepo(PRIVATE_DIR)}`);
        process.exit(1);
    }

    const years = yearArg
        ? [yearArg]
        : fs.readdirSync(PRIVATE_DIR)
            .filter(f => /^\d{4}\.html$/.test(f))
            .map(f => f.slice(0, 4))
            .sort();

    if (!years.length) {
        console.error(`ERROR: no YYYY.html files found in ${relRepo(PRIVATE_DIR)}`);
        process.exit(1);
    }

    for (const year of years) {
        await processYear(year, opts);
    }
}

main();
