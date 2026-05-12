#!/usr/bin/env node
/**
 * Verify that all cases listed in a saved Oyez advocate page are present in
 * our local advocate JSON file, and/or that the journal text files for a range
 * of years account for all expected advocate appearances.
 *
 * Usage:
 *   node scripts/verify_advocates.js \
 *     --name "PAUL D. CLEMENT" \
 *     --page "courts/ussc/people/advocates/featured/paul_d_clement/cases-oyez.html"
 *
 *   node scripts/verify_advocates.js \
 *     --name "PAUL D. CLEMENT" \
 *     --journals "2001-2022"
 *
 *   node scripts/verify_advocates.js \
 *     --name "PAUL D. CLEMENT" \
 *     --page "…/cases-oyez.html" --journals "2001-2022" [--verbose]
 *
 * How the --page check works:
 *   1. Derives the advocate JSON path from --name using the same ID logic as
 *      update_advocates.js (e.g. "PAUL D. CLEMENT" → paul_d_clement.json).
 *   2. Reads the local HTML file given by --page and extracts all Oyez case
 *      links of the form href="cases/YEAR/NUMBER" together with their title
 *      text (e.g. <a href="cases/2025/24-568">Bost v. Illinois …</a>).
 *   3. For each case found on the page, checks whether that case number appears
 *      in our JSON.  The Oyez term year Y maps to our term Y-10 (October Term);
 *      ±1 year is also accepted to handle scheduling edge cases.
 *   4. Reports cases listed on the page but absent from our JSON.
 *
 * How the --journals check works:
 *   1. Parses the journal text files in courts/ussc/journals/text/ for the
 *      specified year range (e.g. "2001-2022" reads 2001.txt … 2022.txt).
 *      Each file corresponds to an October Term (year N = term "N-10").
 *   2. Finds all "Oral Arguments" entries where the advocate's name appears
 *      in the "Argued by …" attribution text.
 *   3. Extracts the docket number(s) and case title from each such entry.
 *   4. Reports journal entries found in those years but absent from our JSON.
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADVOCATES_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'advocates', 'all');
const JOURNALS_TEXT_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'journals', 'text');

// ── Small helpers ──────────────────────────────────────────────────────────

const exists   = (p) => fs.existsSync(p);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readText = (p) => fs.readFileSync(p, 'utf8');

/** Return the first pipe-delimited component of a case title for display. */
const firstTitle = (s) => { if (!s) return s; const i = s.indexOf('|'); return i === -1 ? s : s.slice(0, i); };

function relRepo(p) {
    const r = path.relative(REPO_ROOT, p);
    return r.startsWith('..') ? p : r;
}

/** Convert an advocate full name (ALL CAPS) to a file-system-safe ID. */
function stripDiacritics(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function makeAdvocateId(name) {
    const ascii = stripDiacritics(name).toLowerCase();
    const noPunct = ascii.replace(/[^\w\s-]/g, '');
    return noPunct.replace(/[\s\-_]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── Case link extraction ───────────────────────────────────────────────────

/**
 * Extract unique {year, number, title} entries from the saved Oyez HTML.
 *
 * The page contains anchors like:
 *   <a ng-href="cases/2025/24-568" … href="cases/2025/24-568">Bost v. Illinois …</a>
 *
 * We match the href attribute and capture the visible anchor text as title.
 * Duplicate year/number pairs (Oyez lists each case twice in the DOM) are
 * deduplicated — the first non-empty title wins.
 */
function extractCaseLinks(html) {
    // Match: href="cases/YEAR/NUMBER">TITLE</a>
    // The href may appear as ng-href or plain href; we look for the plain href.
    const re = /href="cases\/(\d{4})\/([^"]+)"[^>]*>([^<]*)<\/a>/gi;
    const seen = new Map();
    let m;
    while ((m = re.exec(html)) !== null) {
        const year   = m[1];
        const number = decodeURIComponent(m[2].trim());
        const title  = m[3].trim();
        const key = `${year}/${number}`;
        if (!seen.has(key) || (!seen.get(key).title && title)) {
            seen.set(key, { year, number, title: title || null });
        }
    }
    return [...seen.values()];
}

// ── Journal parsing ────────────────────────────────────────────────────────

/**
 * Parse a year range string like "1990-2019" into [startYear, endYear].
 * Single year "2004" is accepted as [2004, 2004].
 */
function parseYearRange(rangeStr) {
    const single = /^(\d{4})$/.exec(rangeStr.trim());
    if (single) { const y = parseInt(single[1], 10); return [y, y]; }
    const range = /^(\d{4})-(\d{4})$/.exec(rangeStr.trim());
    if (!range) throw new Error(`Invalid --journals range "${rangeStr}". Expected "YYYY" or "YYYY-YYYY".`);
    return [parseInt(range[1], 10), parseInt(range[2], 10)];
}

/**
 * Clean a raw journal text by removing typographical page-break artifacts so
 * that argument descriptions spanning a page boundary read as continuous text.
 *
 * Three kinds of noise are removed:
 *   1. Lines starting with "JNL" — production/typesetting markers
 *      e.g.  JNL04$1005—07-18-05 14:01:23     JOURNAPGT          MILES
 *   2. Lines of the form  "NNN  DAY, MONTH D, YYYY"  (page number + date)
 *      e.g.  "149                    TUESDAY, OCTOBER 5, 2004"
 *   3. Lines that are just "(JOURNAL)"  (section label sometimes on its own)
 *
 * After stripping those lines we collapse runs of 3+ blank lines to 2 so the
 * resulting text can still be split on double-newlines into paragraphs.
 */
function cleanJournalText(raw) {
    return raw
        .replace(/^JNL[^\n]*/gm, '')
        .replace(/^\d+\s{2,}(?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)[^\n]*/gm, '')
        .replace(/^\(JOURNAL\)\s*$/gm, '')
        .replace(/^SUPREME COURT OF THE UNITED STATES\s*$/gm, '')
        .replace(/\n{3,}/g, '\n\n');
}

/**
 * Normalise a docket string to our canonical format:
 *   - Replace Unicode hyphens/dashes with ASCII "-"
 *   - Trim whitespace
 * Does NOT uppercase (caller can do that for map keys).
 */
function normDocket(s) {
    // U+2013 en-dash, U+2014 em-dash, U+2010 hyphen, U+00AD soft-hyphen → "-"
    return s.replace(/[\u2010\u2011\u2013\u2014\u00AD]/g, '-').trim();
}

/**
 * Extract all docket numbers from a raw argument entry block.
 *
 * Matches patterns like:
 *   "No. 04–104."   "No. 04-104."   "No. 105, Original."   "No. 10M32."
 *   "No. A–123."
 *
 * Returns an array of normalised docket strings (ASCII hyphens, trimmed).
 */
function extractDockets(block) {
    const re = /\bNo\.\s+([\w\u2013\u2014\u2010\u00AD,\-]+?)(?=\.|$|\s{2,}|\n)/g;
    const out = [];
    let m;
    while ((m = re.exec(block)) !== null) {
        const d = normDocket(m[1]).replace(/,$/, '').trim();
        if (d && !out.includes(d)) out.push(d);
    }
    return out;
}

/**
 * Extract a short case title from a raw argument entry block.
 *
 * The title is the text between the first docket number and "Argued by"
 * (or end of first "No." sentence), collapsed to a single line and trimmed.
 * Returns null if nothing useful can be extracted.
 */
function extractTitle(block) {
    // Find end of first "No. DOCKET." prefix
    const noEnd = block.search(/\bNo\.\s+[\w\u2013\u2014\u2010\u00AD,\-]+\.\s*/);
    if (noEnd === -1) return null;
    const afterNo = block.slice(noEnd).replace(/\bNo\.\s+[\w\u2013\u2014\u2010\u00AD,\-]+\.\s*/, '');
    // Take text up to "Argued by" or "; and" (second case) or end of first sentence
    let title = afterNo.split(/\bArgued\b/i)[0]
        .split(/;\s+and\b/i)[0]
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.,;]\s*$/, '')
        .trim();
    return title || null;
}

/**
 * Scan a single journal text file and return an array of argument entries
 * where the given advocate name appears in the "Argued by" attribution.
 *
 * Each returned entry is: { dockets: string[], title: string|null, year: number }
 *
 * @param {string} raw    - raw contents of e.g. 2004.txt
 * @param {number} year   - the calendar year / October Term year
 * @param {string} name   - advocate name in ALL CAPS, e.g. "PAUL D. CLEMENT"
 */
function parseJournalForAdvocate(raw, year, name) {
    const nameLower = name.trim().toLowerCase();
    const results = [];
    const seenKeys = new Set();

    // Month name → zero-padded number for date parsing.
    const MONTH_NUM = {
        JANUARY:'01', FEBRUARY:'02', MARCH:'03',    APRIL:'04',
        MAY:'05',     JUNE:'06',     JULY:'07',      AUGUST:'08',
        SEPTEMBER:'09', OCTOBER:'10', NOVEMBER:'11', DECEMBER:'12',
    };

    // Extract "YYYY-MM-DD" from any line containing "MONTH D, YYYY", or null.
    const parseDateLine = (line) => {
        const m = line.match(/\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+(\d{1,2}),\s+(\d{4})\b/);
        return m ? `${m[3]}-${MONTH_NUM[m[1]]}-${String(m[2]).padStart(2, '0')}` : null;
    };

    // Line-based state machine.
    //
    // Journal oral-argument entries look like:
    //
    //   No. 04–104. United States, Petitioner v. Freddie J. Booker; and
    //   No. 04–105. United States, Petitioner v. Ducan Fanfan. Argued by
    //   Mr. Paul D. Clement for the petitioner, by Mr. T. Christopher Kelly
    //   for the respondent in No. 04–104, …
    //   Adjourned until Tuesday, October 5, 2004, at 10 o'clock.
    //
    // Multiple dockets joined by "; and" form one cluster.
    //
    // Clusters are bounded by:
    //   - An independent new "No." line (not chained by "; and")
    //   - An "Adjourned" line (explicit end-of-session)
    //   - A "(JOURNAL)" header (new calendar day)
    //
    // This prevents bar-admission sections (which appear between Adjourned
    // and the next day's arguments, and may mention the advocate as a bar
    // sponsor) from leaking into an argument cluster.
    //
    // Dates are extracted from "(JOURNAL)  DAY, MONTH D, YYYY  NNN" lines and
    // "NNN   DAY, MONTH D, YYYY" page-number lines.  Each result entry carries
    // the session date so that argument and reargument on different days are
    // treated as separate events (the dedup key includes the date).

    let clusterLines = [];
    let prevNonBlank = '';
    let currentDate  = null;   // most-recently-seen session date
    let clusterDate  = null;   // date when the current cluster started

    const flushCluster = () => {
        if (!clusterLines.length) return;
        const block = clusterLines.join('\n');
        // Only keep clusters with an "Argued" attribution mentioning our advocate.
        if (/\bArgued\b/i.test(block) && block.toLowerCase().includes(nameLower)) {
            const dockets = extractDockets(block);
            if (dockets.length) {
                // Include date in key so argument + reargument (same dockets,
                // different days) are NOT deduplicated.
                const key = [...dockets].sort().join('|') + '::' + (clusterDate || '');
                if (!seenKeys.has(key)) {
                    seenKeys.add(key);
                    const title = extractTitle(block);
                    results.push({ dockets, title, year, date: clusterDate });
                }
            }
        }
        clusterLines = [];
        clusterDate  = null;
    };

    for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();   // trim() also removes \f, \r

        // ── Page-break artifacts ────────────────────────────────────────────
        // JNL typesetting lines (sometimes preceded by \f on the same line).
        if (/^JNL/.test(trimmed)) continue;

        // "(JOURNAL)  DAY, MONTH D, YYYY  NNN" — new calendar-day boundary.
        // Flush the open cluster; extract and record the new session date.
        if (/^\(JOURNAL\)/.test(trimmed)) {
            flushCluster();
            const d = parseDateLine(trimmed);
            if (d) currentDate = d;
            continue;
        }

        // "NNN   DAY, MONTH D, YYYY" — page-number + date within a session.
        if (/^\d+\s{2,}(?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)/i.test(trimmed)) {
            const d = parseDateLine(trimmed);
            if (d) currentDate = d;
            continue;   // strip from cluster output
        }

        // Standalone "SUPREME COURT OF THE UNITED STATES" section header.
        if (/^SUPREME COURT OF THE UNITED STATES\s*$/.test(trimmed)) continue;

        // Blank / whitespace-only lines.
        if (!trimmed) {
            if (clusterLines.length) clusterLines.push(rawLine);
            continue;
        }

        // "Adjourned…" — explicit end of the day's argument session.
        if (/^\s*Adjourned\b/i.test(rawLine)) {
            flushCluster();
            prevNonBlank = trimmed;
            continue;
        }

        // ── Cluster accumulation ────────────────────────────────────────────
        const isNoLine     = /^\s*No\.\s+/i.test(rawLine);
        const isContinuation = /;\s*and\s*$/.test(prevNonBlank);

        if (isNoLine && !isContinuation && clusterLines.length) {
            // Independent new "No." — flush the completed cluster first.
            flushCluster();
        }

        if (clusterLines.length > 0 || isNoLine) {
            // Record the session date when the cluster's first line is seen.
            if (isNoLine && clusterDate === null && clusterLines.length === 0) {
                clusterDate = currentDate;
            }
            clusterLines.push(rawLine);
        }

        prevNonBlank = trimmed;
    }
    flushCluster();

    return results;
}

/**
 * Scan journal files for the given year range and return all argument entries
 * where the advocate appears.
 *
 * @param {string} name        - advocate name, ALL CAPS
 * @param {number} startYear
 * @param {number} endYear
 * @param {boolean} verbose
 * @returns {{ entries: Array, yearsScanned: number }}
 */
function scanJournals(name, startYear, endYear, verbose) {
    const entries = [];
    let yearsScanned = 0;
    for (let y = startYear; y <= endYear; y++) {
        // Try the exact year file first, then a partial file.
        const candidates = [
            path.join(JOURNALS_TEXT_DIR, `${y}.txt`),
            path.join(JOURNALS_TEXT_DIR, `${y}-partial.txt`),
        ];
        const filePath = candidates.find(p => fs.existsSync(p));
        if (!filePath) {
            if (verbose) console.log(`  [journals] ${y}: file not found, skipping`);
            continue;
        }
        if (verbose) process.stdout.write(`  [journals] scanning ${y}…`);
        const raw = readText(filePath);
        const found = parseJournalForAdvocate(raw, y, name);
        if (verbose) console.log(` ${found.length} entry(ies)`);
        entries.push(...found);
        yearsScanned++;
    }
    return { entries, yearsScanned };
}

// ── Term helpers ───────────────────────────────────────────────────────────

/**
 * Candidate term strings for a given Oyez term year.
 * Oyez year 2025 → ["2025-10", "2024-10", "2026-10"]  (±1 for edge cases)
 */
function candidateTerms(oyezYear) {
    const y = parseInt(oyezYear, 10);
    return [`${y}-10`, `${y - 1}-10`, `${y + 1}-10`];
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
    // ── Parse args ──────────────────────────────────────────────────────────
    const args = process.argv.slice(2);
    let name     = null;
    let page     = null;
    let journals = null;
    let dates    = false;
    let verbose  = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--name'     && args[i + 1]) { name     = args[++i]; continue; }
        if (args[i] === '--page'     && args[i + 1]) { page     = args[++i]; continue; }
        if (args[i] === '--journals' && args[i + 1]) { journals = args[++i]; continue; }
        if (args[i] === '--dates')                   { dates    = true;      continue; }
        if (args[i] === '--verbose'  || args[i] === '-v') { verbose = true; continue; }
    }

    if (!name || (!page && !journals)) {
        console.error('Usage: node scripts/verify_advocates.js --name "PAUL D. CLEMENT" [--page PATH] [--journals "YYYY-YYYY"] [--dates] [--verbose]');
        process.exit(1);
    }

    // Resolve --page relative to REPO_ROOT if not absolute
    const pagePath = page ? (path.isAbsolute(page) ? page : path.join(REPO_ROOT, page)) : null;

    const advocateId = makeAdvocateId(name.toUpperCase());
    const jsonPath   = path.join(ADVOCATES_DIR, `${advocateId}.json`);

    console.log(`Advocate: ${name}`);
    console.log(`JSON: ${relRepo(jsonPath)}`);
    if (pagePath) console.log(`HTML: ${relRepo(pagePath)}`);
    if (journals) console.log(`Journals: ${journals}`);
    console.log();

    // ── Load advocate JSON ──────────────────────────────────────────────────
    if (!exists(jsonPath)) {
        console.error(`ERROR: Advocate JSON not found: ${relRepo(jsonPath)}`);
        process.exit(1);
    }
    const advocateData = readJson(jsonPath);
    const ourCases = advocateData.cases || [];

    // Build lookup: normalised case number → array of case entries.
    // Case numbers may be comma-separated (consolidated); index every one.
    const ourByNumber = new Map();
    for (const c of ourCases) {
        const numbers = (c.number || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const num of numbers) {
            const key = normDocket(num).toUpperCase();
            if (!ourByNumber.has(key)) ourByNumber.set(key, []);
            ourByNumber.get(key).push(c);
        }
    }
    console.log(`JSON: ${ourCases.length} case(s)`);

    // ── --page check ────────────────────────────────────────────────────────
    if (pagePath) {
        if (!exists(pagePath)) {
            console.error(`ERROR: HTML page not found: ${relRepo(pagePath)}`);
            process.exit(1);
        }
        const html = readText(pagePath);
        const pageCases = extractCaseLinks(html);

        if (pageCases.length === 0) {
            console.error('\nERROR: No Oyez case links found in the HTML file.');
            console.error('Expected anchors of the form: href="cases/YEAR/NUMBER"');
            process.exit(1);
        }
        console.log(`HTML: ${pageCases.length} unique case link(s) found`);
        console.log();

        // Compare page → JSON
        const missing   = [];   // on page, not in our JSON
        const found     = [];   // on page and in our JSON
        const ambiguous = [];   // number matches but term year is off

        for (const pc of pageCases) {
            const numKey = normDocket(pc.number).toUpperCase();
            const matches = ourByNumber.get(numKey) || [];

            if (matches.length === 0) {
                missing.push(pc);
                continue;
            }
            const candTerms = new Set(candidateTerms(pc.year));
            const termMatch = matches.find(m => candTerms.has(m.term));
            if (termMatch) {
                found.push({ page: pc, ours: termMatch });
            } else {
                ambiguous.push({ page: pc, ours: matches });
            }
        }

        // Compare JSON → page
        const pageNumbers = new Set(pageCases.map(pc => normDocket(pc.number).toUpperCase()));
        const jsonOnly = ourCases.filter(c => {
            const numbers = (c.number || '').split(',').map(s => s.trim()).filter(Boolean);
            return numbers.every(n => !pageNumbers.has(normDocket(n).toUpperCase()));
        });
        jsonOnly.sort((a, b) => b.term.localeCompare(a.term));

        // Report
        const anyIssues = missing.length > 0 || ambiguous.length > 0 || jsonOnly.length > 0;
        if (!anyIssues) {
            console.log(`✓ All ${found.length} page case(s) present in our JSON; all ${ourCases.length} JSON case(s) present on page.\n`);
        } else {
            console.log(`Page results: ${found.length} matched, ${missing.length} missing from JSON, ${jsonOnly.length} not on page, ${ambiguous.length} term-mismatch\n`);
        }

        if (missing.length > 0) {
            console.log(`MISSING FROM JSON (${missing.length}) — on page but not in our JSON:`);
            for (const pc of missing) {
                const label = pc.title ? `${pc.title} (${pc.year})` : `No.${pc.number} (${pc.year})`;
                console.log(`  ${label}`);
                console.log(`  → https://www.oyez.org/cases/${pc.year}/${pc.number}`);
            }
            console.log();
        }

        if (jsonOnly.length > 0) {
            console.log(`NOT ON PAGE (${jsonOnly.length}) — in our JSON but not listed on the Oyez page:`);
            for (const c of jsonOnly) {
                const termYear = c.term.split('-')[0];
                const label = c.title ? `${firstTitle(c.title)} (${termYear})` : `No.${c.number} (${termYear})`;
                console.log(`  ${label}  [term: ${c.term}]`);
            }
            console.log();
        }

        if (ambiguous.length > 0) {
            console.log(`TERM MISMATCH (${ambiguous.length}) — number found but expected term ≈${pageCases[0]?.year}-10:`);
            for (const { page: pc, ours: ourMatches } of ambiguous) {
                const label    = pc.title ? `${pc.title} (${pc.year})` : `No.${pc.number} (${pc.year})`;
                const ourTerms = ourMatches.map(m => m.term).join(', ');
                console.log(`  ${label}  [our term: ${ourTerms}]`);
                console.log(`  → https://www.oyez.org/cases/${pc.year}/${pc.number}`);
            }
            console.log();
        }

        if (verbose && found.length > 0) {
            console.log(`FOUND (${found.length}):`);
            for (const { page: pc } of found) {
                const label = pc.title ? `${pc.title} (${pc.year})` : `No.${pc.number} (${pc.year})`;
                console.log(`  ${label}`);
            }
            console.log();
        }
    }

    // ── --journals check ────────────────────────────────────────────────────
    if (journals) {
        let startYear, endYear;
        try {
            [startYear, endYear] = parseYearRange(journals);
        } catch (e) {
            console.error(`ERROR: ${e.message}`);
            process.exit(1);
        }

        if (verbose) console.log(`Scanning journal files ${startYear}–${endYear}…`);
        const { entries, yearsScanned } = scanJournals(name.toUpperCase(), startYear, endYear, verbose);
        if (verbose) console.log();
        console.log(`Journals: scanned ${yearsScanned} year(s), found ${entries.length} argument entry(ies) mentioning ${name}`);
        console.log();

        // For each journal entry, check if it's in our JSON.
        const journalMissing      = [];   // in journals, not in our JSON
        const journalDateMismatch = [];   // docket found but argument date differs
        const journalFound        = [];   // in journals and in our JSON

        for (const entry of entries) {
            // Match any of the entry's dockets against ourByNumber.
            // Also try year-prefixed variants for short dockets (e.g. journal
            // "No. 970" in 2009 → try "08-970", "09-970" since the journal may
            // omit the year component).
            const matches = [];
            const docketsToTry = [...entry.dockets];
            for (const d of entry.dockets) {
                // If docket has no hyphen (e.g. "970"), add year-prefixed guesses
                if (!d.includes('-')) {
                    const yy2 = String(entry.year).slice(2);       // "09" for 2009
                    const prev = String(entry.year - 1).slice(2);  // "08"
                    docketsToTry.push(`${prev}-${d}`, `${yy2}-${d}`);
                }
            }
            for (const d of docketsToTry) {
                const key = d.toUpperCase();
                const hits = ourByNumber.get(key) || [];
                for (const h of hits) {
                    if (!matches.includes(h)) matches.push(h);
                }
            }

            // Narrow by term year (±1).
            const candTerms = new Set([
                `${entry.year}-10`,
                `${entry.year - 1}-10`,
                `${entry.year + 1}-10`,
            ]);
            const termMatches = matches.filter(m => candTerms.has(m.term));
            const candidates  = termMatches.length ? termMatches : matches;

            // Prefer a case whose argument date exactly matches the journal entry
            // date (so argument and reargument are matched to the right event).
            let found = null;
            if (candidates.length) {
                if (entry.date) {
                    found = candidates.find(c => c.argument === entry.date) || null;
                }
                // Fallback: any docket match (date unknown or no exact date hit).
                if (!found) found = candidates[0];
            }

            if (found) {
                const dateOk = !entry.date || found.argument === entry.date;
                if (dateOk) {
                    journalFound.push({ entry, ours: found });
                } else {
                    journalDateMismatch.push({ entry, ours: found });
                }
            } else {
                journalMissing.push(entry);
            }
        }

        const journalAnyIssues = journalMissing.length > 0 || journalDateMismatch.length > 0;
        if (!journalAnyIssues) {
            console.log(`✓ All ${journalFound.length} journal entry(ies) present in our JSON.\n`);
        } else {
            const parts = [`${journalFound.length} matched`];
            if (journalDateMismatch.length) parts.push(`${journalDateMismatch.length} date mismatch`);
            if (journalMissing.length)      parts.push(`${journalMissing.length} missing from JSON`);
            console.log(`Journal results: ${parts.join(', ')}\n`);
        }

        if (journalMissing.length > 0) {
            console.log(`MISSING FROM JSON (${journalMissing.length}) — in journals but not in our JSON:`);
            for (const entry of journalMissing) {
                const termStr   = `${entry.year}-10`;
                const docketStr = entry.dockets.join(', ');
                const dateStr   = entry.date ? `  ${entry.date}` : '';
                const titleStr  = entry.title ? `  "${entry.title}"` : '';
                console.log(`  [${termStr}] No. ${docketStr}${dateStr}${titleStr}`);
            }
            console.log();
        }

        if (journalDateMismatch.length > 0) {
            console.log(`DATE MISMATCH (${journalDateMismatch.length}) — docket found but argument date differs:`);
            for (const { entry, ours } of journalDateMismatch) {
                const docketStr = entry.dockets.join(', ');
                const titleStr  = ours.title ? `  "${firstTitle(ours.title)}"` : '';
                console.log(`  [${ours.term}] No. ${docketStr}  journal: ${entry.date}, ours: ${ours.argument}${titleStr}`);
            }
            console.log();
        }

        if (verbose && journalFound.length > 0) {
            console.log(`FOUND IN JOURNALS (${journalFound.length}):`);
            for (const { entry, ours } of journalFound) {
                const termYear = ours.term.split('-')[0];
                const label    = ours.title ? `${firstTitle(ours.title)} (${termYear})` : `No. ${entry.dockets[0]} (${termYear})`;
                const dateStr  = entry.date ? `  ${entry.date}` : '';
                console.log(`  ${label}  [No. ${entry.dockets.join(', ')}]${dateStr}`);
            }
            console.log();
        }

        // ── --dates sub-mode ──────────────────────────────────────────────
        // When --dates is passed, cross-reference purely by date:
        // build the set of dates when the advocate appeared in journals and
        // compare against the set of argument dates in the JSON.
        if (dates) {
            // Journal dates: one entry per journal appearance that has a date.
            const journalDates = new Map();  // date → array of {dockets, title}
            for (const entry of entries) {
                if (!entry.date) continue;
                if (!journalDates.has(entry.date)) journalDates.set(entry.date, []);
                journalDates.get(entry.date).push(entry);
            }

            // JSON dates: all argument dates across all case entries.
            const jsonDates = new Map();     // date → array of case entries
            for (const c of ourCases) {
                if (!c.argument) continue;
                if (!jsonDates.has(c.argument)) jsonDates.set(c.argument, []);
                jsonDates.get(c.argument).push(c);
            }

            const inJournalNotJson = [...journalDates.keys()]
                .filter(d => !jsonDates.has(d))
                .sort();
            const inJsonNotJournal = [...jsonDates.keys()]
                .filter(d => {
                    // Only flag JSON dates that fall within the scanned year range.
                    const y = parseInt(d.slice(0, 4), 10);
                    return y >= startYear && y <= endYear + 1
                        && !journalDates.has(d);
                })
                .sort();

            console.log('── Date comparison ──────────────────────────────');
            console.log(`  Journal dates for ${name}: ${journalDates.size}`);
            console.log(`  JSON argument dates (in range): ${[...jsonDates.keys()].filter(d => { const y = parseInt(d.slice(0,4),10); return y >= startYear && y <= endYear+1; }).length}`);
            console.log();

            if (inJournalNotJson.length === 0 && inJsonNotJournal.length === 0) {
                console.log('✓ All dates match.\n');
            }

            if (inJournalNotJson.length > 0) {
                console.log(`IN JOURNALS, NOT IN JSON (${inJournalNotJson.length}) — argued this day per journal but no matching date in our JSON:`);
                for (const d of inJournalNotJson) {
                    const items = journalDates.get(d);
                    for (const item of items) {
                        const docketStr = item.dockets.join(', ');
                        const titleStr  = item.title ? `  "${item.title.slice(0, 60)}${item.title.length > 60 ? '…' : ''}"` : '';
                        console.log(`  ${d}  No. ${docketStr}${titleStr}`);
                    }
                }
                console.log();
            }

            if (inJsonNotJournal.length > 0) {
                console.log(`IN JSON, NOT IN JOURNALS (${inJsonNotJournal.length}) — date in our JSON with no journal entry found:`);
                for (const d of inJsonNotJournal) {
                    const cases = jsonDates.get(d);
                    for (const c of cases) {
                        const docketStr = c.number || '?';
                        const titleStr  = c.title ? `  "${firstTitle(c.title).slice(0, 60)}"` : '';
                        console.log(`  ${d}  No. ${docketStr}  [${c.term}]${titleStr}`);
                    }
                }
                console.log();
            }
        }
    }
}

main();
