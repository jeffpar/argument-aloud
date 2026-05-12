#!/usr/bin/env node
/**
 * Verify that all cases listed in a saved Oyez advocate page are present in
 * our local advocate JSON file.
 *
 * Usage:
 *   node scripts/verify_advocates.js \
 *     --name "PAUL D. CLEMENT" \
 *     --page "courts/ussc/people/advocates/featured/paul_d_clement/cases-oyez.html"
 *
 *   node scripts/verify_advocates.js \
 *     --name "PAUL D. CLEMENT" \
 *     --page "courts/ussc/people/advocates/featured/paul_d_clement/cases-oyez.html" \
 *     [--verbose]
 *
 * How it works:
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
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const ADVOCATES_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'advocates', 'all');

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
    let name    = null;
    let page    = null;
    let verbose = false;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--name'    && args[i + 1]) { name    = args[++i]; continue; }
        if (args[i] === '--page'    && args[i + 1]) { page    = args[++i]; continue; }
        if (args[i] === '--verbose' || args[i] === '-v') { verbose = true; continue; }
    }

    if (!name || !page) {
        console.error('Usage: node scripts/verify_advocates.js --name "PAUL D. CLEMENT" --page "courts/ussc/people/advocates/featured/paul_d_clement/cases-oyez.html"');
        process.exit(1);
    }

    // Resolve --page relative to REPO_ROOT if not absolute
    const pagePath = path.isAbsolute(page) ? page : path.join(REPO_ROOT, page);

    const advocateId = makeAdvocateId(name.toUpperCase());
    const jsonPath   = path.join(ADVOCATES_DIR, `${advocateId}.json`);

    console.log(`Advocate: ${name}`);
    console.log(`JSON: ${relRepo(jsonPath)}`);
    console.log(`HTML: ${relRepo(pagePath)}`);
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
            const key = num.toUpperCase();
            if (!ourByNumber.has(key)) ourByNumber.set(key, []);
            ourByNumber.get(key).push(c);
        }
    }
    console.log(`JSON: ${ourCases.length} case(s)`);

    // ── Read & parse the HTML page ──────────────────────────────────────────
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

    // ── Compare page → JSON ──────────────────────────────────────────────────
    // Page order is newest-first (same as Oyez listing)
    const missing   = [];   // on page, not in our JSON
    const found     = [];   // on page and in our JSON
    const ambiguous = [];   // number matches but term year is off

    for (const pc of pageCases) {
        const numKey = pc.number.toUpperCase();
        const matches = ourByNumber.get(numKey) || [];

        if (matches.length === 0) {
            missing.push(pc);
            continue;
        }

        // At least one match — check whether the term year is compatible (±1)
        const candTerms = new Set(candidateTerms(pc.year));
        const termMatch = matches.find(m => candTerms.has(m.term));
        if (termMatch) {
            found.push({ page: pc, ours: termMatch });
        } else {
            ambiguous.push({ page: pc, ours: matches });
        }
    }

    // ── Compare JSON → page ──────────────────────────────────────────────────
    // Cases in our JSON whose number(s) don't appear on the page at all
    const pageNumbers = new Set(pageCases.map(pc => pc.number.toUpperCase()));
    const jsonOnly = ourCases.filter(c => {
        const numbers = (c.number || '').split(',').map(s => s.trim()).filter(Boolean);
        return numbers.every(n => !pageNumbers.has(n.toUpperCase()));
    });
    jsonOnly.sort((a, b) => b.term.localeCompare(a.term));

    // ── Report ───────────────────────────────────────────────────────────────
    const anyIssues = missing.length > 0 || ambiguous.length > 0 || jsonOnly.length > 0;

    if (!anyIssues) {
        console.log(`✓ All ${found.length} page case(s) present in our JSON; all ${ourCases.length} JSON case(s) present on page.\n`);
    } else {
        console.log(`Results: ${found.length} matched, ${missing.length} missing from JSON, ${jsonOnly.length} not on page, ${ambiguous.length} term-mismatch\n`);
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

main();
