#!/usr/bin/env node
/**
 * Builds/updates courts/ussc/people/advocates/all_advocates.json (index),
 * courts/ussc/people/advocates/top100_advocates.json (top 100 by case count),
 * courts/ussc/people/advocates/top21st_advocates.json (top advocates by 21st-century case count), and
 * courts/ussc/people/advocates/all/{id}.json (per-advocate case lists) from
 * transcript files.
 *
 * For every case in every cases.json under courts/ussc/terms/, follows each
 * audio entry's text_href to its transcript file, extracts speakers whose role
 * is "advocate", and records which case/date they appeared in.
 *
 * Usage:
 *   node scripts/update_advocates.js [--verbose|-v] [--women] [--markdown]
 *                                    [TERM] [--replace OLD NEW]
 *                                    [--add "ADVOCATE NAME"]
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { reorderEvent, reorderCase } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Paths ──────────────────────────────────────────────────────────────────

const REPO_ROOT         = path.resolve(__dirname, '..');
const TERMS_DIR         = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const ADVOCATES_BASE    = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'advocates');
const OUTPUT_FILE       = path.join(ADVOCATES_BASE, 'all_advocates.json');
const TOP100_OUTPUT_FILE  = path.join(ADVOCATES_BASE, 'top100',  'top100_advocates.json');
const TOP21ST_OUTPUT_FILE = path.join(ADVOCATES_BASE, 'top21st', 'top21st_advocates.json');
const WOMEN_OUTPUT_FILE = path.join(ADVOCATES_BASE, 'women', 'women_advocates.json');
const WOMEN_CSV_FILE    = path.join(REPO_ROOT, 'data', 'ussc', 'women.csv');
const TRANS_OUTPUT_FILE = path.join(ADVOCATES_BASE, 'transgender', 'transgender_advocates.json');
const ADVOCATES_DIR     = path.join(ADVOCATES_BASE, 'all');
const FEATURED_DIR      = path.join(ADVOCATES_BASE, 'featured');
const JUSTICES_ALL_DIR  = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices', 'all');
const JUSTICE_ADVOCATES_FILE = path.join(ADVOCATES_BASE, 'justice', 'justice_advocates.json');
const JOURNALS_DIR      = path.join(REPO_ROOT, 'courts', 'ussc', 'journals', 'text');
const _SPEAKERS_FILE    = path.join(REPO_ROOT, 'data', 'ussc', 'speakers.json');
const REPORTS_JSON      = path.join(REPO_ROOT, 'data', 'ussc', 'reports.json');

// ── Small helpers ──────────────────────────────────────────────────────────

/** Return the first pipe-delimited component of a case title for display. */
const firstTitle = (s) => { if (!s) return s; const i = s.indexOf('|'); return i === -1 ? s : s.slice(0, i); };

/**
 * Preferred `case=` URL value for a case — its first docket number when
 * that's unique among its term's sibling cases, else its own id (matching
 * the client-side _caseUrlId() in explorer.js). Avoids both raw comma-joined
 * consolidated numbers and needlessly using id where the number alone
 * already resolves unambiguously.
 */
function caseUrlNumber(c, siblingCases) {
    const num = (c.number || '').split(',')[0].trim();
    if (num && siblingCases.filter(s => (s.number || '').split(',')[0].trim() === num).length === 1) {
        return num;
    }
    return c.id || num;
}

const exists    = (p) => fs.existsSync(p);
const readText  = (p) => fs.readFileSync(p, 'utf8');
const writeText = (p, s) => fs.writeFileSync(p, s, 'utf8');
const readJson  = (p) => JSON.parse(readText(p));
const writeJson = (p, d) => { const s = JSON.stringify(d, null, 2) + '\n'; if (exists(p) && readText(p) === s) return; writeText(p, s); };
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const unlinkSafe = (p) => { try { fs.unlinkSync(p); } catch {} };

/** Capitalise the first letter of a name and any letter that follows a space
 *  or apostrophe; lowercase everything else. Input is typically all-uppercase. */
function properCase(name) {
    let out = '';
    for (let i = 0; i < name.length; i++) {
        const ch = name[i];
        if (!/[a-zA-Z]/.test(ch)) { out += ch; continue; }
        out += (i === 0 || name[i - 1] === ' ' || name[i - 1] === "'")
            ? ch.toUpperCase() : ch.toLowerCase();
    }
    return out.replace(/,\s+([IVXivx]+)$/, (_, s) => ', ' + s.toUpperCase());
}

/** Template used when auto-creating a featured advocate index.md. */
const FEATURED_TEMPLATE = `\
---
title: TBD
layout: pane
---

# {{ page.title }}

As of {{ site.time | date: "%B %-d, %Y" }}, {{ page.title }} argued {{ page.case_count }} {% if page.case_count == 1 %}case{% else %}cases{% endif %}, the last argument occurring on {{ page.last_argument }}.
`;

function relRepo(p) {
    const r = path.relative(REPO_ROOT, p);
    return r.startsWith('..') ? p : r;
}

/** Recursively list files matching predicate. */
function walkFiles(dir, pred) {
    const out = [];
    if (!exists(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkFiles(full, pred));
        else if (!pred || pred(full)) out.push(full);
    }
    return out;
}

function listSubdirs(dir) {
    if (!exists(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => path.join(dir, e.name))
        .sort();
}

function listJsonFiles(dir) {
    if (!exists(dir)) return [];
    return fs.readdirSync(dir)
        .filter(n => n.endsWith('.json'))
        .map(n => path.join(dir, n))
        .sort();
}

// ── Feminine-title detection ───────────────────────────────────────────────

const _FEMININE_TITLE_PARTS = ['MS.', 'MRS.', 'MISS'];
function isFeminineTitle(title) {
    const upper = (title || '').toUpperCase();
    return _FEMININE_TITLE_PARTS.some(p => upper.includes(p));
}

// ── Result summarisation ───────────────────────────────────────────────────
//
// Map the verbose `c.result` string and an advocate's role to a short side
// label. Roles ending in '*' (low-confidence) are accepted as-is for the
// purpose of choosing the family (cert/appeal/civil/complaint). "defendant"
// is shared between the civil (plaintiff/defendant) and complaint
// (complainant/defendant) pairs, so a bare "defendant" role always resolves
// to the more common civil family — only an explicit "complainant" role
// picks the complaint family.
function summarizeResult(fullResult, role) {
    if (!fullResult) return '';
    const r = (role || '').replace(/\*$/, '').toLowerCase();
    let family = 'cert';            // petitioner / respondent
    if (r === 'appellant' || r === 'appellee')       family = 'appeal';
    else if (r === 'complainant')                    family = 'complaint';
    else if (r === 'plaintiff' || r === 'defendant') family = 'civil';
    const won = fullResult.includes('petitioning party received a favorable disposition');
    // A "dismissed"/"dismissed as improvidently granted" result carries no
    // partyWinning text of its own (see schema.js / the SCDB result migration),
    // but SCDB's partyWinning for that caseDisposition is "no favorable
    // disposition for petitioning party apparent" in all but a handful of
    // cases, so treat it as a loss for the petitioning party here too.
    const lost = fullResult.includes('no favorable disposition for petitioning party apparent')
        || /^dismissed\b/i.test(fullResult);
    if (!won && !lost) return '';
    if (family === 'appeal')    return won ? 'appellant'   : 'appellee';
    if (family === 'complaint') return won ? 'complainant' : 'defendant';
    if (family === 'civil')     return won ? 'plaintiff'   : 'defendant';
    return won ? 'petitioner' : 'respondent';
}

// ── Name aliases (from speakers.json) ──────────────────────────────────────

function loadNameAliases(p) {
    const aliases = {};
    if (!exists(p)) return aliases;
    let data;
    try { data = readJson(p); } catch { return aliases; }
    for (const [oldN, newN] of Object.entries(data.alias || {})) {
        aliases[oldN.trim().toUpperCase()] = newN.trim().toUpperCase();
    }
    return aliases;
}
const NAME_ALIASES = loadNameAliases(_SPEAKERS_FILE);

// ── Justice canonical-name map (justices.json) ───────────────────────────────
// Maps each multi-word alternate form of a justice's name to the canonical
// (short) key so that advocates who were also justices are stored under their
// short name (e.g. "SAMUEL A. ALITO, JR." → "SAMUEL ALITO").

function loadJusticeCanonicalNames(p) {
    const map = {};
    if (!exists(p)) return map;
    let data;
    try { data = readJson(p); } catch { return map; }
    for (const [key, entry] of Object.entries(data)) {
        const canonicalUpper = key.trim().toUpperCase();
        for (const alt of (entry.alternates || [])) {
            // Skip single-word entries (typos handled by speakers.json).
            if (!/\s/.test(alt.trim())) continue;
            const altUpper = alt.trim().toUpperCase();
            if (altUpper !== canonicalUpper) map[altUpper] = canonicalUpper;
        }
    }
    return map;
}
const JUSTICE_CANONICAL_NAME = loadJusticeCanonicalNames(path.join(REPO_ROOT, 'data', 'ussc', 'justices.json'));

// Set of every last name that belongs to a justice, used to catch OCR-corrupted
// speaker entries like "JUSTIC DOUGLAS" or "JUSTTICE WHITE" whose title field
// was misread as "MR." instead of "JUSTICE".
function loadJusticeLastNames(p) {
    const lastNames = new Set();
    if (!exists(p)) return lastNames;
    let data;
    try { data = readJson(p); } catch { return lastNames; }
    for (const [key, entry] of Object.entries(data)) {
        for (const form of [key, ...(entry.alternates || [])]) {
            const tokens = form.trim().toUpperCase().replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
            const filtered = tokens.filter(t => !/^(?:JR|SR|II|III|IV)$/.test(t));
            if (filtered.length >= 1) lastNames.add(filtered[filtered.length - 1]);
        }
    }
    return lastNames;
}
const JUSTICE_LAST_NAMES = loadJusticeLastNames(path.join(REPO_ROOT, 'data', 'ussc', 'justices.json'));

// Maps uppercase justice name → dateStart string (ISO), used for seniority ordering.
function loadJusticeSeniority(p) {
    const map = new Map();
    if (!exists(p)) return map;
    let data;
    try { data = readJson(p); } catch { return map; }
    for (const [key, entry] of Object.entries(data)) {
        if (!entry.dateStart) continue;
        for (const form of [key, ...(entry.alternates || [])]) {
            map.set(form.trim().toUpperCase(), entry.dateStart);
        }
    }
    return map;
}
const JUSTICE_SENIORITY = loadJusticeSeniority(path.join(REPO_ROOT, 'data', 'ussc', 'justices.json'));

// ── OCR corruptions of "JUSTICE" that slip through as bogus advocates ──────
// These appear in OCR'd USSC transcripts when the alignment parser mistakes
// a justice's speaker cue for an advocate. Check first word only; last name
// is irrelevant because the whole name is bogus.
const _JUSTICE_CORRUPTION_PREFIXES = new Set([
    'JUSTICE', 'CHIEF',    // exact (caught elsewhere, but cheap to include)
    'JUSTIC', 'JUSITCE', 'JUSTTICE', 'JUTICE',  // known OCR variants
]);

/** Return true if `name` looks like a corruption of "(CHIEF) JUSTICE LASTNAME". */
function isJusticeCorruptionName(name) {
    if (!name) return false;
    const toks = name.trim().toUpperCase().split(/\s+/);
    // "CHIEF JUSTICE X" or "CHIEF JUS* X"
    if (toks.length >= 3 && toks[0] === 'CHIEF') {
        const second = toks[1].replace(/[.,]/g, '');
        return _JUSTICE_CORRUPTION_PREFIXES.has(second) ||
               (second.length >= 5 && second.length <= 9 && /^JU[ST]/i.test(second) && !/N$/i.test(second));
    }
    // "JUSTICE X" or "JUS* X"
    if (toks.length >= 2) {
        const first = toks[0].replace(/[.,]/g, '');
        return _JUSTICE_CORRUPTION_PREFIXES.has(first) ||
               (first.length >= 5 && first.length <= 9 && /^JU[ST]/i.test(first) && !/N$/i.test(first) &&
                JUSTICE_LAST_NAMES.has(toks[toks.length - 1].replace(/[.,]/g, '')));
    }
    return false;
}

/** Strip combining marks (NFD-decomposed accents). */
function stripDiacritics(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function makeAdvocateId(name) {
    const ascii = stripDiacritics(name).toLowerCase();
    // Consecutive single-letter initials are written without a space between
    // them (e.g. "A.C. EPPS", "D.P.S. PAUL") — but the id must stay the same
    // regardless of that display convention, so re-insert the space between
    // each such pair before tokenizing, whether or not it was there already.
    const spacedInitials = ascii.replace(/\b([a-z])\.(?=[a-z]\.)/g, '$1. ');
    // Remove punctuation except hyphens, then collapse whitespace/-/_ to single _.
    const noPunct = spacedInitials.replace(/[^\w\s-]/g, '');
    return noPunct.replace(/[\s\-_]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── Suffix normalisation ───────────────────────────────────────────────────

const _SUFFIX_JR_SR_RE = /,?\s+(JR|SR)\.?\s*$/i;
const _SUFFIX_ROMAN_RE = /,?\s+(II|III|IV)\s*$/i;

function normalizeNameSuffix(name) {
    // Normalize curly/smart apostrophes to straight apostrophe so that
    // "O’TOOLE" and "O’TOOLE" produce the same advocate key.
    name = name.replace(/[‘’ʼ]/g, "'");
    let m = _SUFFIX_JR_SR_RE.exec(name);
    if (m) {
        const base = name.slice(0, m.index);
        const suffix = m[1].toUpperCase();
        const out = `${base}, ${suffix}.`;
        if (out !== name) return out;
        return name;
    }
    m = _SUFFIX_ROMAN_RE.exec(name);
    if (m) {
        const base = name.slice(0, m.index);
        const suffix = m[1].toUpperCase();
        const out = `${base}, ${suffix}`;
        if (out !== name) return out;
    }
    return name;
}

/** Normalise speaker-name suffixes throughout a transcript dict, in place.
 *  Returns rename map (old -> new) of changed names. */
function normalizeTranscript(transcript) {
    const rename = {};
    const speakers = transcript?.media?.speakers || [];
    for (const sp of speakers) {
        const oldN = sp.name || '';
        const newN = normalizeNameSuffix(oldN);
        if (newN !== oldN) rename[oldN] = newN;
    }
    for (const turn of transcript?.turns || []) {
        const oldN = turn.name || '';
        if (!(oldN in rename)) {
            const newN = normalizeNameSuffix(oldN);
            if (newN !== oldN) rename[oldN] = newN;
        }
    }
    if (Object.keys(rename).length === 0) return rename;
    for (const sp of speakers) {
        if (sp.name in rename) sp.name = rename[sp.name];
    }
    for (const turn of transcript?.turns || []) {
        if (turn.name in rename) turn.name = rename[turn.name];
    }
    return rename;
}

// ── Other helpers ──────────────────────────────────────────────────────────

function caseFolderNumber(s) {
    return (s || '').split(',')[0].trim();
}

function loadExisting() {
    if (!exists(OUTPUT_FILE)) return {};
    let index;
    try { index = readJson(OUTPUT_FILE); } catch { return {}; }
    const result = {};
    for (const entry of index) {
        let name = entry.name;
        const normalised = normalizeNameSuffix(name);
        if (normalised !== name) {
            console.log(`  Normalised existing name: ${JSON.stringify(name)} -> ${JSON.stringify(normalised)}`);
            name = normalised;
        }
        const advId = makeAdvocateId(name);
        name = name.split(/\s+/).filter(Boolean).join(' ');
        const data = { id: advId, name, cases: [] };
        if (entry.previously) data.previously = entry.previously;
        result[name.toUpperCase()] = data;
    }
    return result;
}

// ── Date helpers (ISO YYYY-MM-DD only) ─────────────────────────────────────

function isoToDays(s) {
    // s = "YYYY-MM-DD"
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
    const ms = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
    if (Number.isNaN(ms)) return NaN;
    return Math.round(ms / 86400000);
}

function daysAbsDiff(a, b) {
    return Math.abs(isoToDays(a) - isoToDays(b));
}

// ── CSV utilities ──────────────────────────────────────────────────────────

/** Minimal CSV parser supporting quoted fields and embedded commas/newlines. */
function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { row.push(field); field = ''; }
            else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
            else if (ch === '\r') { /* skip */ }
            else field += ch;
        }
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

/** Parse CSV to array of dicts using first row as headers. */
function parseCsvDict(text) {
    const rows = parseCsv(text);
    if (rows.length === 0) return [];
    const headers = rows[0];
    const out = [];
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (row.length === 1 && row[0] === '') continue;
        const obj = {};
        for (let c = 0; c < headers.length; c++) obj[headers[c]] = row[c] ?? '';
        out.push(obj);
    }
    return out;
}

/** Write CSV with QUOTE_NONNUMERIC semantics (every string field quoted). */
function writeCsvNonnumeric(headers, rows) {
    const quoteField = (v) => {
        if (typeof v === 'number') return String(v);
        const s = String(v ?? '');
        return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [];
    lines.push(headers.map(quoteField).join(','));
    for (const row of rows) lines.push(row.map(quoteField).join(','));
    return lines.join('\r\n') + '\r\n';
}

// ── Justice-advocates sync (event-driven) ────────────────────────────────────

const _JM_YEAR_SUFFIX_RE = /\s+\((\d{4})\)$/;

function _jmNormalizeCaseNumber(raw) {
    const first = String(raw).split(',')[0].trim();
    const m = first.match(/^(\d+)\s*[-\u2013]?\s*(Misc|Orig)\.?$/i);
    if (m) return `${m[1]}-${m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()}`;
    return first;
}

const _JUSTICE_SPEAKER_TITLES = new Set(['JUSTICE', 'CHIEF JUSTICE']);

/** Reduce a name to a comparison key: uppercase first + last token, no
 *  middle initials, no Jr./Sr./roman suffixes. So "JOHN G. ROBERTS, JR."
 *  matches "JOHN ROBERTS". */
function _jmNameKey(name) {
    if (!name) return '';
    let s = String(name).toUpperCase().trim();
    s = s.replace(/,?\s+(JR|SR|II|III|IV)\.?\s*$/i, '');
    const tokens = s.replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return '';
    if (tokens.length === 1) return tokens[0];
    return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}

// Returns true only when advocateName is compatible with canonicalName after suffix/period
// normalization: the advocate may have FEWER tokens than the canonical (e.g. "WILLIAM REHNQUIST"
// matching "WILLIAM H. REHNQUIST"), but NOT more — so "JOHN E. ROBERTS" never matches "JOHN ROBERTS".
function _jmNameMatchesCanonical(advocateName, canonicalName) {
    const norm = (s) => {
        s = String(s).toUpperCase().trim();
        s = s.replace(/,?\s+(JR|SR|II|III|IV)\.?\s*$/i, '');
        return s.replace(/\./g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    };
    const adv = norm(advocateName);
    const can = norm(canonicalName);
    if (adv.length < 2 || can.length < 2) return false;
    if (adv[0] !== can[0] || adv[adv.length - 1] !== can[can.length - 1]) return false;
    if (adv.length > can.length) return false;
    for (let i = 1; i < adv.length - 1; i++) {
        if (adv[i] !== can[i]) return false;
    }
    return true;
}

/** Build {(term,number)→case}, {usCite→[term,number]}, and {titleStripped→[term,number]} indices. */
function _jmBuildCaseIndices(termDirs) {
    const byKey = new Map();
    const byUsCite = new Map();
    const byTitle = new Map();
    for (const termDir of termDirs) {
        const term = path.basename(termDir);
        const cf = path.join(termDir, 'cases.json');
        if (!exists(cf)) continue;
        let cases;
        try { cases = readJson(cf); } catch { continue; }
        for (const c of cases) {
            const raw = String(c.number || '').trim();
            const number = raw.split(',')[0].trim();
            const effectiveKey = number || String(c.id || '').trim();
            byKey.set(`${term}/${effectiveKey}`, c);
            const cite = String(c.usCite || '').trim();
            if (cite) byUsCite.set(cite, [term, String(c.number || '')]);
            const title = firstTitle(String(c.title || '').trim());
            if (title) {
                if (!byTitle.has(title)) byTitle.set(title, []);
                byTitle.get(title).push([term, effectiveKey]);
            }
        }
    }
    return { byKey, byUsCite, byTitle };
}

/** Build a map from _jmNameKey(name) → canonical uppercase justice display name,
 *  covering all name variants in justices.json. */
function _jmBuildJusticeMap() {
    const justicesPath = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');
    const map = new Map();
    let data;
    try { data = readJson(justicesPath); } catch { return map; }
    for (const [canonicalName, entry] of Object.entries(data)) {
        const upper = canonicalName.trim().toUpperCase();
        map.set(_jmNameKey(upper), upper);
        for (const alt of (entry.alternates || [])) {
            const altUpper = alt.trim().toUpperCase();
            if (!map.has(_jmNameKey(altUpper))) map.set(_jmNameKey(altUpper), upper);
        }
    }
    return map;
}

function syncJusticeAdvocates(termDirs, { verbose = false } = {}) {
    if (verbose) console.log('\n── Building justice_advocates.json ──');

    // Map from _jmNameKey(name) → canonical uppercase justice display name.
    const justiceByKey = _jmBuildJusticeMap();

    const { byKey } = _jmBuildCaseIndices(termDirs);

    let coll = [];
    if (exists(JUSTICE_ADVOCATES_FILE)) {
        try { coll = readJson(JUSTICE_ADVOCATES_FILE); } catch { coll = []; }
    }
    if (!Array.isArray(coll)) coll = [];

    const groupsByName = new Map(coll.map(g => [g.name, g]));
    let totalAdded = 0;

    // Scan every argument/reargument event across all terms to discover
    // cases argued by people who later became justices.
    // mdCasesByJustice: justiceDisplayName -> [{name, term, number, type, dates[], event}]
    const mdCasesByJustice = new Map();

    for (const termDir of termDirs) {
        const term = path.basename(termDir);
        const cf = path.join(termDir, 'cases.json');
        if (!exists(cf)) continue;
        let cases;
        try { cases = readJson(cf); } catch { continue; }

        for (const c of cases) {
            const events = c.events || [];
            const number = String(c.number || '').split(',')[0].trim();
            // Accumulate per-justice, per-type: dates and event indices for this case.
            const accumByJustice = new Map(); // justiceDisp -> {argument:{dates,idxs}, reargument:{dates,idxs}}

            for (let i = 0; i < events.length; i++) {
                const ev = events[i];
                if (!ev?.date) continue;
                if (ev.type !== 'argument' && ev.type !== 'reargument') continue;

                const matchedJustices = new Set();

                for (const a of (ev.advocates || [])) {
                    const n = typeof a === 'object' && a !== null ? a.name : a;
                    if (typeof n !== 'string') continue;
                    const jDisp = justiceByKey.get(_jmNameKey(n.toUpperCase()));
                    if (jDisp && _jmNameMatchesCanonical(n, jDisp)) matchedJustices.add(jDisp);
                }

                // Fall back to transcript speakers when the advocates list is empty.
                if (!matchedJustices.size && ev.text_href) {
                    const tp = path.join(termDir, 'cases', ev.text_href);
                    if (exists(tp)) {
                        try {
                            const tj = readJson(tp);
                            for (const sp of tj?.media?.speakers || []) {
                                if (_JUSTICE_SPEAKER_TITLES.has(sp.title || '')) continue;
                                const jDisp = justiceByKey.get(_jmNameKey((sp.name || '').toUpperCase()));
                                if (jDisp && _jmNameMatchesCanonical(sp.name || '', jDisp)) matchedJustices.add(jDisp);
                            }
                        } catch { /* ignore */ }
                    }
                }

                for (const jDisp of matchedJustices) {
                    if (!accumByJustice.has(jDisp)) {
                        accumByJustice.set(jDisp, {
                            argument:   { dates: [], idxs: [] },
                            reargument: { dates: [], idxs: [] },
                        });
                    }
                    const bucket = accumByJustice.get(jDisp)[ev.type];
                    if (!bucket.dates.includes(ev.date)) bucket.dates.push(ev.date);
                    bucket.idxs.push(i);
                }
            }

            for (const [jDisp, byType] of accumByJustice) {
                for (const type of ['argument', 'reargument']) {
                    const { dates, idxs } = byType[type];
                    if (!dates.length) continue;
                    const aligned   = idxs.filter(i => events[i].aligned);
                    const withAudio = idxs.filter(i => events[i].audio_href);
                    const bestIdx   = (aligned[0] ?? withAudio[0] ?? idxs[0]) + 1;
                    if (!mdCasesByJustice.has(jDisp)) mdCasesByJustice.set(jDisp, []);
                    mdCasesByJustice.get(jDisp).push({
                        name: firstTitle(String(c.title || '')),
                        term, number, type,
                        dates: [...dates].sort(),
                        event: bestIdx,
                    });
                }
            }
        }
    }

    for (const [disp, mdCases] of mdCasesByJustice) {
        let group = groupsByName.get(disp);
        if (!group) {
            group = { id: makeAdvocateId(disp), name: disp, cases: [] };
            coll.push(group);
            groupsByName.set(disp, group);
        } else {
            // Ensure id is present and current.
            const desiredId = makeAdvocateId(disp);
            if (group.id !== desiredId) {
                // Rebuild with id first, name second, preserving remaining keys.
                const { id: _oldId, name: _oldName, ...rest } = group;
                for (const k of Object.keys(group)) delete group[k];
                group.id = desiredId;
                group.name = disp;
                Object.assign(group, rest);
            }
        }
        // A "slot" is keyed by (term, number, type). Existing entries are
        // classified by which date field they carry (reargument vs. argument).
        const slotKey = (term, number, type) =>
            `${term}/${_jmNormalizeCaseNumber(String(number))}#${type}`;
        const existingType = (e) => (e && 'reargument' in e) ? 'reargument' : 'argument';

        // Drop existing entries that have no event support (e.g. formerly
        // added from the README with no transcript evidence).
        const mdSlots = new Set(mdCases.map(mc => slotKey(mc.term, mc.number, mc.type)));
        const existing = (group.cases || []).filter(e =>
            mdSlots.has(slotKey(e.term || '', e.number || '', existingType(e)))
        );

        // Counts to compute deficit (per slot).
        const mdCounts = new Map();
        for (const mc of mdCases) {
            const k = slotKey(mc.term, mc.number, mc.type);
            mdCounts.set(k, (mdCounts.get(k) || 0) + 1);
        }
        const existingCounts = new Map();
        for (const e of existing) {
            const k = slotKey(e.term || '', e.number || '', existingType(e));
            existingCounts.set(k, (existingCounts.get(k) || 0) + 1);
        }

        const seen = new Map();
        const toAdd = [];
        for (const mc of mdCases) {
            const k = slotKey(mc.term, mc.number, mc.type);
            const need = mdCounts.get(k);
            const have = existingCounts.get(k) || 0;
            const s = seen.get(k) || 0;
            if (s < need - have) toAdd.push(mc);
            seen.set(k, s + 1);
        }

        // Insert new entries in (term, type) order — reargument follows argument.
        const newExisting = [...existing];
        for (const nc of toAdd) {
            let pos = newExisting.length;
            for (let i = 0; i < newExisting.length; i++) {
                const eTerm = newExisting[i].term || '';
                if (eTerm > nc.term) { pos = i; break; }
                if (eTerm === nc.term && nc.type === 'argument'
                    && existingType(newExisting[i]) === 'reargument') {
                    pos = i; break;
                }
            }
            const inserted = { title: nc.name, term: nc.term, number: nc.number };
            if (nc.type === 'reargument') inserted.reargument = '';
            else inserted.argument = '';
            newExisting.splice(pos, 0, inserted);
        }

        // Build per-slot date plan in markdown order.
        const datePlan = new Map();
        for (const mc of mdCases) {
            const k = slotKey(mc.term, mc.number, mc.type);
            if (!datePlan.has(k)) datePlan.set(k, []);
            datePlan.get(k).push({ dates: mc.dates || [], event: mc.event ?? null });
        }

        const before = JSON.stringify(newExisting);
        const seenByKey = new Map();
        for (const entry of newExisting) {
            const term   = entry.term || '';
            const number = String(entry.number || '');
            const type   = existingType(entry);
            const lookupKey = `${term}/${number}`;
            const live = byKey.get(lookupKey);
            const sk = seenByKey.get(slotKey(term, number, type)) || 0;
            seenByKey.set(slotKey(term, number, type), sk + 1);
            if (!live) {
                console.log(`  [${disp}] WARNING: case not found in cases.json: ${lookupKey}`);
                delete entry.argument; delete entry.reargument;
                delete entry.decision; delete entry.event;
                delete entry.audio;    delete entry.decision_loc; delete entry.decision_ussc; delete entry.decision_rep;
                continue;
            }

            // Strip " (YYYY)" from title; warn on year mismatch.
            const rawTitle = entry.title || '';
            const ym = rawTitle.match(_JM_YEAR_SUFFIX_RE);
            const titleYear = ym ? ym[1] : null;
            const cleanTitle = ym ? rawTitle.slice(0, ym.index) : rawTitle;
            const decision = live.decision;
            if (titleYear && decision && titleYear !== decision.slice(0, 4)) {
                console.log(`  WARNING: year mismatch for ${lookupKey}: title year=${titleYear}, decision=${decision}`);
            }
            // Verify decision_ussc if both present.
            if (live.decision_ussc && entry.decision_ussc && live.decision_ussc !== entry.decision_ussc) {
                console.log(`  WARNING: decision_ussc mismatch for ${lookupKey}`);
            }

            // Pick the dates and event for this slot.
            const plan = datePlan.get(slotKey(term, number, type)) || [];
            const planEntry = sk < plan.length ? plan[sk] : { dates: [], event: null };
            const dates = planEntry.dates || [];
            const eventVal = planEntry.event ?? null;
            let dateStr = '';
            if (dates.length) {
                dateStr = dates.join(',');
            } else if (type === 'argument' && live.argument) {
                dateStr = live.argument;
            } else if (type === 'reargument' && live.reargument) {
                dateStr = live.reargument;
            }

            // Rebuild entry with canonical field order.
            for (const k2 of Object.keys(entry)) delete entry[k2];
            entry.title  = firstTitle(cleanTitle);
            entry.term   = term;
            entry.number = number;
            if (dateStr) entry[type] = dateStr;
            if (decision) entry.decision = decision;
            if (eventVal !== null) entry.event = eventVal;
        }
        // Sort cases by the entry's argument-or-reargument date (first ISO
        // date if comma-joined). Stable: ties keep insertion order.
        const dateKey = (e) => {
            const s = String(e.argument || e.reargument || '');
            return s.split(',')[0];
        };
        newExisting.sort((a, b) => {
            const da = dateKey(a), db = dateKey(b);
            return da < db ? -1 : da > db ? 1 : 0;
        });
        const after = JSON.stringify(newExisting);
        const annotationsChanged = before !== after;

        if (!toAdd.length && !annotationsChanged) continue;

        group.cases = newExisting;
        totalAdded += toAdd.length;
        if (toAdd.length && verbose) {
            const names = toAdd.slice(0, 4).map(c => c.name).join(', ')
                + (toAdd.length > 4 ? `, … (+${toAdd.length - 4} more)` : '');
            console.log(`  [${disp}] Added ${toAdd.length}: ${names}`);
        }
    }

    // Remove groups that ended up with no event-supported cases.
    for (let i = coll.length - 1; i >= 0; i--) {
        if (!coll[i].cases?.length) coll.splice(i, 1);
    }

    // Sort groups by case count descending, then first name ascending.
    coll.sort((a, b) => {
        const ca = a.cases?.length ?? 0, cb = b.cases?.length ?? 0;
        if (ca !== cb) return cb - ca;
        return (a.name || '').localeCompare(b.name || '');
    });

    // Rebuild each group with canonical field order: id, name, details, highlights, cases.
    // details.page always points to the justice's page; highlights preserves any
    // hand-authored entries that may have been added to an existing file.
    const outputColl = coll.map(g => {
        const id        = g.id || makeAdvocateId(g.name);
        const details   = g.details   || { page: `/courts/ussc/people/justices/all/${id}` };
        const highlights = g.highlights || [];
        return { id, name: g.name, details, highlights, cases: g.cases };
    });

    const newJson = JSON.stringify(outputColl, null, 2) + '\n';
    const oldJson = exists(JUSTICE_ADVOCATES_FILE) ? readText(JUSTICE_ADVOCATES_FILE) : '';
    if (newJson !== oldJson) {
        writeText(JUSTICE_ADVOCATES_FILE, newJson);
        console.log(`Wrote ${relRepo(JUSTICE_ADVOCATES_FILE)} (+${totalAdded} cases, annotations updated)`);
    } else {
        console.log(`${relRepo(JUSTICE_ADVOCATES_FILE)} is already up to date.`);
    }
}

// ── Journal helpers (single-name advocate lookup) ──────────────────────────

const _JNL_WEEKDAYS = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
const _JNL_MONTHS   = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE',
                       'JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];

/** Convert ISO date to journal heading style, e.g. "THURSDAY, JANUARY 13, 1972". */
function _jnlDateStr(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return `${_JNL_WEEKDAYS[dt.getUTCDay()]}, ${_JNL_MONTHS[m - 1]} ${d}, ${y}`;
}

/** Return the journal text section for the given date, or null. */
function _jnlDateSection(journalText, isoDate) {
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
    const heading = _jnlDateStr(isoDate);
    const headingRe = new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const m = headingRe.exec(journalText);
    if (!m) return null;
    const headingUpper = heading.toUpperCase();
    const nextDayRe = /(?:MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY),\s+(?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d+,\s+\d{4}/gi;
    // The same date heading may appear many times (once per page). Skip repeated
    // occurrences of the same date to find where a genuinely different date begins.
    nextDayRe.lastIndex = m.index + heading.length;
    let next;
    while ((next = nextDayRe.exec(journalText)) !== null) {
        if (next[0].toUpperCase() !== headingUpper) break;
    }
    return journalText.slice(m.index, next ? next.index : journalText.length);
}

/** Test whether a journal section contains a reference to any of the case's numbers.
 *  Handles consolidated numbers ("70-161,70-5211") and Orig suffixes ("59-Orig"). */
function _jnlHasCaseNum(section, caseNumber) {
    const parts = caseNumber.split(',').map(s => s.trim()).filter(Boolean);
    for (const part of parts) {
        const origMatch = part.match(/^(\d+)-Orig(?:in(?:al)?)?$/i);
        let re;
        if (origMatch) {
            re = new RegExp(`No\\.\\s*${origMatch[1]}[,\\s]+Orig(?:in(?:al)?)?`, 'i');
        } else {
            const escaped = part
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/[-\u2013]+/g, '[-\u2013]');
            re = new RegExp(`Nos?\\.\\s*${escaped}`, 'i');
        }
        if (re.test(section)) return true;
    }
    return false;
}

/** Return the last significant token (uppercase) from a full name, stripping suffixes. */
function _jnlLastName(fullName) {
    let s = fullName.trim().replace(/,?\s*(?:Jr\.|Sr\.|III?|IV)\s*$/i, '').trim();
    s = s.replace(/,\s*$/, '').trim();
    const words = s.split(/\s+/).filter(Boolean);
    return words.length ? words[words.length - 1].toUpperCase().replace(/[.,]/g, '') : '';
}

/** Compound official titles that may follow a personal title (Mr./Ms./etc.) in the journal. */
const _JNL_COMPOUND_TITLES = [
    { re: /^Acting\s+Solicitor\s+General\s+/i,   label: 'ACTING SOLICITOR GENERAL' },
    { re: /^Solicitor\s+General\s+/i,            label: 'SOLICITOR GENERAL' },
    { re: /^Acting\s+Attorney\s+General\s+/i,    label: 'ACTING ATTORNEY GENERAL' },
    { re: /^Assistant\s+Attorney\s+General\s+/i, label: 'ASSISTANT ATTORNEY GENERAL' },
    { re: /^Deputy\s+Attorney\s+General\s+/i,    label: 'DEPUTY ATTORNEY GENERAL' },
    { re: /^Attorney\s+General\s+/i,             label: 'ATTORNEY GENERAL' },
];

const _JNL_PERSONAL_TITLE = {
    'MR.': 'MR.', 'MS.': 'MS.', 'MRS.': 'MR.', 'MISS': 'MS.', 'GEN.': 'GENERAL', 'GENERAL': 'GENERAL',
};

/** Search a journal section for a titled-name matching lastNameUpper.
 *  Returns { name, title } in uppercase (e.g. { name: "L. PATRICK GRAY, III", title: "MR." }), or null. */
function _jnlFindFullName(section, lastNameUpper) {
    const titlePat = /(Mr\.|Ms\.|Mrs\.|Miss\b|Gen\.|General)\s+([A-Za-z][A-Za-z.]*(?:[\s\n]+[A-Za-z][A-Za-z.]*)*(?:\s*,\s*(?:Jr\.|Sr\.|III?|IV))?)/gi;
    let m;
    while ((m = titlePat.exec(section)) !== null) {
        const personalTitle = _JNL_PERSONAL_TITLE[m[1].toUpperCase()] || (m[1].toUpperCase() + '.');
        // Trim at role separator "for …" before further processing
        let rest = m[2].replace(/[\s\n]*\bfor\b[\s\S]*$/i, '').trim().replace(/,\s*$/, '').trim();
        let titleLabel = personalTitle;
        for (const ct of _JNL_COMPOUND_TITLES) {
            const cm = ct.re.exec(rest);
            if (cm) { titleLabel = ct.label; rest = rest.slice(cm[0].length).trim().replace(/,\s*$/, '').trim(); break; }
        }
        // Normalise internal whitespace (collapse newlines within hyphenated names)
        rest = rest.replace(/[\s\n]+/g, ' ').trim();
        // Ensure suffix has a preceding comma: "NABRIT III" → "NABRIT, III"
        rest = rest.replace(/,?\s+(Jr\.|Sr\.|II|III|IV)$/i, ', $1');
        if (_jnlLastName(rest) === lastNameUpper) return { name: rest.toUpperCase(), title: titleLabel };
    }
    return null;
}

/** Apply old→new name replacement in a term's cases.json and associated transcripts. */
function applyReplace(term, oldName, newName) {
    if (!oldName || !newName) {
        console.error('--replace requires two arguments: old name and new name');
        return;
    }
    const termDir   = path.join(TERMS_DIR, term);
    const casesFile = path.join(termDir, 'cases.json');
    if (!exists(casesFile)) {
        console.error(`Cases file not found: ${relRepo(casesFile)}`);
        return;
    }
    let cases;
    try { cases = readJson(casesFile); }
    catch (e) { console.error(`Could not parse ${relRepo(casesFile)}: ${e.message}`); return; }

    const oldUpper = oldName.toUpperCase();
    const newUpper = newName.toUpperCase();
    let count = 0;

    for (const c of cases) {
        for (const ev of c.events || []) {
            for (let ai = 0; ai < (ev.advocates || []).length; ai++) {
                const adv = ev.advocates[ai];
                const cur = typeof adv === 'object' ? adv.name : adv;
                if ((cur || '').toUpperCase() !== oldUpper) continue;
                if (typeof adv === 'object') adv.name = newUpper;
                else ev.advocates[ai] = newUpper;
                count++;
                if (ev.text_href) {
                    const tp = path.join(termDir, 'cases', ev.text_href);
                    if (exists(tp)) {
                        try {
                            const t = readJson(tp);
                            let changed = false;
                            for (const sp of t?.media?.speakers || []) {
                                if ((sp.name || '').toUpperCase() === oldUpper) { sp.name = newUpper; changed = true; }
                            }
                            for (const turn of t?.turns || []) {
                                if ((turn.name || '').toUpperCase() === oldUpper) { turn.name = newUpper; changed = true; }
                            }
                            if (changed) {
                                writeText(tp, JSON.stringify(t, null, 2) + '\n');
                                console.log(`  Updated transcript: ${relRepo(tp)}`);
                            }
                        } catch (e) { console.error(`  ERROR updating transcript ${relRepo(tp)}: ${e.message}`); }
                    }
                }
            }
        }
    }

    if (count) {
        writeJson(casesFile, cases);
        console.log(`Replaced "${oldName}" → "${newName}" (${count} occurrence(s)) in ${relRepo(casesFile)}`);
    } else {
        console.log(`No occurrences of "${oldName}" found in ${relRepo(casesFile)}`);
    }
}

/** Check single-name advocates in a term's cases.json, look them up in the journal, and
 *  interactively prompt for replacement. Returns true if all were resolved (or none found). */
async function checkAndFixSingleNames(term, { verbose = false } = {}) {
    const termDir   = path.join(TERMS_DIR, term);
    const casesFile = path.join(termDir, 'cases.json');
    if (!exists(casesFile)) {
        console.error(`Term not found: ${relRepo(casesFile)}`);
        return true;
    }
    let cases;
    try { cases = readJson(casesFile); }
    catch (e) { console.error(`Could not parse ${relRepo(casesFile)}: ${e.message}`); return true; }

    // Collect all single-name advocate occurrences across all events
    const hits = [];
    for (let ci = 0; ci < cases.length; ci++) {
        const c = cases[ci];
        for (let ei = 0; ei < (c.events || []).length; ei++) {
            const ev = c.events[ei];
            for (let ai = 0; ai < (ev.advocates || []).length; ai++) {
                const adv = ev.advocates[ai];
                const name = ((typeof adv === 'object' ? adv.name : adv) || '').trim();
                if (name && name.split(/\s+/).filter(Boolean).length === 1) {
                    hits.push({ ci, ei, ai, name, ev, c });
                }
            }
        }
    }

    if (!hits.length) {
        return 'clean';
    }

    console.log(`\nFound ${hits.length} single-name advocate(s) in term ${term}.`);

    // Journal texts are loaded on demand per event date (keyed by October Term year).
    // An event on 1969-02-25 belongs to the Oct 1968 term → 1968.txt.
    const journalCache = new Map();
    const getJournal = (isoDate) => {
        const [y, m] = isoDate.split('-').map(Number);
        const jYear = m >= 10 ? y : y - 1;
        if (journalCache.has(jYear)) return journalCache.get(jYear);
        const jp = path.join(JOURNALS_DIR, `${jYear}.txt`);
        let text = null;
        if (exists(jp)) {
            try { text = readText(jp); } catch { /* ignore */ }
        }
        if (!text) console.warn(`  WARNING: Journal not found: ${relRepo(jp)}`);
        journalCache.set(jYear, text);
        return text;
    };

    let allFixed = true;
    let casesModified = false;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(res => rl.question(q, res));
    // Pending deletions: `${ci}|${ei}` -> Set<name.toUpperCase()>
    const pendingDeletions = new Map();

    try {
        for (const { ci, ei, ai, name, ev, c } of hits) {
            const isoDate = ev.date || c.argument || '';
            console.log(`\n  "${name}" — case ${c.number} (${firstTitle(c.title || '')}) on ${isoDate}`);

            let fullName = null;
            if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
                const journalText = getJournal(isoDate);
                if (journalText) {
                    const section = _jnlDateSection(journalText, isoDate);
                    if (section) {
                        if (_jnlHasCaseNum(section, c.number || '')) {
                            fullName = _jnlFindFullName(section, name.toUpperCase());
                            if (!fullName) {
                                console.log(`    No titled-name match for "${name}" near case ${c.number} on ${_jnlDateStr(isoDate)}.`);
                            }
                        } else {
                            console.log(`    Case ${c.number} not found in journal section for ${_jnlDateStr(isoDate)}.`);
                        }
                    } else {
                        console.log(`    No journal section found for ${_jnlDateStr(isoDate)}.`);
                    }
                }
            }

            if (!fullName) {
                // If this single-name only appears in a ussc source event (and no non-ussc
                // event for the same case lists this name), offer to delete it.
                if (ev.source === 'ussc') {
                    const nameUpper = name.toUpperCase();
                    const alsoInOther = (c.events || []).some((oe, oei) =>
                        oei !== ei && oe.source !== 'ussc' &&
                        (oe.advocates || []).some(a => {
                            const n = ((typeof a === 'object' ? a.name : a) || '').trim().toUpperCase();
                            return n === nameUpper;
                        })
                    );
                    if (!alsoInOther) {
                        let answer;
                        try { answer = (await ask(`    Cannot resolve in journal. Delete "${name}" from ussc event advocates? [y/n]: `)).trim().toLowerCase(); }
                        catch { answer = 'n'; }
                        if (answer === 'y') {
                            const delKey = `${ci}|${ei}`;
                            if (!pendingDeletions.has(delKey)) pendingDeletions.set(delKey, new Set());
                            pendingDeletions.get(delKey).add(nameUpper);
                            casesModified = true;
                            console.log(`    Deleted "${name}" from ussc event advocates (transcript unchanged).`);
                            continue;
                        }
                    }
                }
                console.warn(`    WARNING: Cannot resolve "${name}" in journal — skipping.`);
                allFixed = false;
                continue;
            }

            const suggestedName  = fullName.name;
            const suggestedTitle = fullName.title;
            console.log(`    Journal suggests: ${suggestedName} [title: ${suggestedTitle}]`);
            let answer;
            try { answer = (await ask(`    Replace "${name}" with "${suggestedName}" [title: ${suggestedTitle}]? [y/n]: `)).trim().toLowerCase(); }
            catch { answer = 'n'; }

            if (answer !== 'y') { allFixed = false; continue; }

            // Apply in cases array (in place)
            const adv = cases[ci].events[ei].advocates[ai];
            if (typeof adv === 'object') { adv.name = suggestedName; adv.title = suggestedTitle; }
            else cases[ci].events[ei].advocates[ai] = suggestedName;
            casesModified = true;

            // Apply in associated transcript
            if (ev.text_href) {
                const tp = path.join(termDir, 'cases', ev.text_href);
                if (exists(tp)) {
                    try {
                        const t = readJson(tp);
                        let changed = false;
                        for (const sp of t?.media?.speakers || []) {
                            if ((sp.name || '').toUpperCase() === name.toUpperCase()) {
                                sp.name = suggestedName; sp.title = suggestedTitle; changed = true;
                            }
                        }
                        for (const turn of t?.turns || []) {
                            if ((turn.name || '').toUpperCase() === name.toUpperCase()) { turn.name = suggestedName; changed = true; }
                        }
                        if (changed) {
                            writeText(tp, JSON.stringify(t, null, 2) + '\n');
                            console.log(`    Updated transcript: ${relRepo(tp)}`);
                        }
                    } catch (e) { console.error(`    ERROR updating transcript ${relRepo(tp)}: ${e.message}`); }
                }
            }

            console.log(`    Replaced "${name}" → "${suggestedName}" [title: ${suggestedTitle}]`);
        }

        // Apply pending deletions (filter out deleted names from each event's advocates array).
        for (const [key, names] of pendingDeletions) {
            const [ci, ei] = key.split('|').map(Number);
            cases[ci].events[ei].advocates = cases[ci].events[ei].advocates.filter(a => {
                const n = ((typeof a === 'object' ? a.name : a) || '').trim().toUpperCase();
                return !names.has(n);
            });
        }
    } finally {
        rl.close();
    }

    if (casesModified) {
        writeJson(casesFile, cases);
        console.log(`\nUpdated ${relRepo(casesFile)}`);
    }

    return allFixed;
}

/** Verify advocate/speaker consistency and fix speaker ordering in all transcript
 *  files for a term. Returns true if any mismatches were reported or files were
 *  rewritten. Speaker ordering rule:
 *    1. CHIEF JUSTICE (original order)
 *    2. Named JUSTICEs (original order, UNKNOWN JUSTICE last among justices)
 *    3. Non-justice speakers (original order)
 *    4. UNKNOWN SPEAKER (always last)
 *  NP speakers (in media.speakers but with no turns) are ignored for mismatch
 *  checking but retained in the output file. */
function checkAndFixTranscriptSpeakers(term, { verbose = false } = {}) {
    const termDir   = path.join(TERMS_DIR, term);
    const casesFile = path.join(termDir, 'cases.json');
    if (!exists(casesFile)) return false;
    let cases;
    try { cases = readJson(casesFile); } catch { return false; }

    const isJusticeTitle = t => t === 'CHIEF JUSTICE' || t === 'JUSTICE';
    let anyChange = false;

    for (const c of cases) {
        for (const ev of c.events || []) {
            if (!ev.text_href) continue;
            const advNames = new Set(
                (ev.advocates || [])
                    .map(a => ((typeof a === 'object' ? a.name : a) || '').toUpperCase())
                    .filter(Boolean)
            );
            const tp = path.join(termDir, 'cases', ev.text_href);
            if (!exists(tp)) continue;
            let t;
            try { t = readJson(tp); } catch { continue; }
            if (!Array.isArray(t?.media?.speakers)) continue;

            const speakers = t.media.speakers;

            const isNP = sp => /,\s*NP$/i.test(sp.title || '');

            // ── Mismatch checks (skip UNKNOWN_* placeholders) ────────────────
            const label = `case ${c.number} (${ev.date}) ${relRepo(tp)}`;
            if (advNames.size) {
                // For ussc events, build a set of speaker names present in any
                // oyez transcript for the same case, and also note whether any
                // oyez event covers the same date (audio-only oyez events still
                // validate that the ussc OCR transcript may be incomplete).
                let oyezSpeakerNames = null;
                let oyezDatesForCase = null;
                if (ev.source === 'ussc') {
                    oyezSpeakerNames = new Set();
                    oyezDatesForCase = new Set();
                    for (const oe of c.events || []) {
                        if (oe.source !== 'oyez') continue;
                        if (oe.date) oyezDatesForCase.add(oe.date);
                        if (!oe.text_href) continue;
                        const op = path.join(termDir, 'cases', oe.text_href);
                        if (!exists(op)) continue;
                        try {
                            const ot = readJson(op);
                            for (const sp of ot?.media?.speakers || []) {
                                const n = (sp.name || '').toUpperCase();
                                if (n) oyezSpeakerNames.add(n);
                            }
                        } catch { /* ignore */ }
                    }
                }

                // Every event advocate should be a participating transcript speaker
                for (const name of advNames) {
                    if (name === 'UNKNOWN JUSTICE' || name === 'UNKNOWN SPEAKER') continue;
                    const inTranscript = speakers.some(sp => (sp.name || '').toUpperCase() === name);
                    const participating = inTranscript && !isNP(speakers.find(sp => (sp.name || '').toUpperCase() === name));
                    if (!inTranscript) {
                        // Suppress warning for ussc transcripts when an oyez transcript
                        // for the same case includes this speaker, or when an oyez event
                        // covers the same date (OCR gap in the ussc transcript, not a real error).
                        if (oyezSpeakerNames !== null &&
                            (oyezSpeakerNames.has(name) || oyezDatesForCase.has(ev.date || ''))) continue;
                        console.warn(`  MISMATCH: advocate "${name}" missing from transcript speakers in ${label}`);
                        anyChange = true;
                    } else if (!participating && verbose) {
                        console.log(`  NOTE: advocate "${name}" is NP in transcript ${label}`);
                    }
                }
                // Every participating non-justice transcript speaker should be an event advocate
                // (or appear as an advocate in another event of the same case)
                const allCaseAdvNames = new Set(
                    (c.events || []).flatMap(e => (e.advocates || [])
                        .map(a => ((typeof a === 'object' ? a.name : a) || '').toUpperCase())
                        .filter(Boolean))
                );
                for (const sp of speakers) {
                    if (isJusticeTitle(sp.title)) continue;
                    if (sp.name === 'UNKNOWN SPEAKER') continue;
                    if (isNP(sp)) continue;
                    // Skip single-name speakers in ussc events (likely OCR artifacts).
                    if (ev.source === 'ussc' && (sp.name || '').trim().split(/\s+/).filter(Boolean).length === 1) continue;
                    const name = (sp.name || '').toUpperCase();
                    if (!advNames.has(name) && !allCaseAdvNames.has(name)) {
                        console.warn(`  MISMATCH: participating speaker "${sp.name}" in transcript not in event advocates for ${label}`);
                        anyChange = true;
                    }
                }
            }

            // ── Reorder speakers ────────────────────────────────────────────
            const chiefs         = speakers.filter(sp => sp.title === 'CHIEF JUSTICE');
            const namedJustices  = speakers.filter(sp => sp.title === 'JUSTICE' && sp.name !== 'UNKNOWN JUSTICE');
            const unknownJustice = speakers.filter(sp => sp.name === 'UNKNOWN JUSTICE');
            const namedAdvocs    = speakers.filter(sp => !isJusticeTitle(sp.title) && sp.name !== 'UNKNOWN SPEAKER');
            const unknownSpeaker = speakers.filter(sp => sp.name === 'UNKNOWN SPEAKER');

            // Sort named justices by seniority (earlier dateStart = more senior)
            namedJustices.sort((a, b) => {
                const da = JUSTICE_SENIORITY.get((a.name || '').toUpperCase()) || '9999';
                const db = JUSTICE_SENIORITY.get((b.name || '').toUpperCase()) || '9999';
                return da < db ? -1 : da > db ? 1 : 0;
            });

            const reordered = [...chiefs, ...namedJustices, ...unknownJustice, ...namedAdvocs, ...unknownSpeaker];

            const needsReorder = reordered.length !== speakers.length ||
                reordered.some((sp, i) => sp !== speakers[i]);

            if (needsReorder) {
                t.media.speakers = reordered;
                writeText(tp, JSON.stringify(t, null, 2) + '\n');
                if (verbose) console.log(`  Reordered speakers in ${relRepo(tp)}`);
                anyChange = true;
            }
        }
    }

    return anyChange;
}

// ── Featured advocate front matter ────────────────────────────────────────────

/** Parse featured advocate front matter (between --- delimiters).
 *  Handles the simple structure used in featured advocate index.md files:
 *  - "details:" — a mapping of scalar string values (e.g. web, twitter)
 *  - "highlights:" — a sequence of string-valued mappings
 *  Returns { details: {}, highlights: [] }. */
function parseFrontMatter(text) {
    const result = { details: {}, highlights: [] };
    const m = /^---\r?\n([\s\S]*?)\n---/.exec(text);
    if (!m) return result;
    const yaml = m[1];

    /** Slice the indented block that follows a top-level key. */
    const blockAfter = (key) => {
        const idx = yaml.search(new RegExp(`^${key}\\s*:`, 'm'));
        if (idx === -1) return null;
        return yaml.slice(idx).replace(/^[^\n]*\n/, '');
    };

    const unquote = (s) => s.replace(/^"|"$/g, '').replace(/^'|'$/g, '').trim();

    // ── details mapping ───────────────────────────────────────────────────────
    const detailsBlock = blockAfter('details');
    if (detailsBlock) {
        for (const line of detailsBlock.split('\n')) {
            if (line.trim() === '') continue;
            if (/^\S/.test(line)) break;                      // next top-level key
            const kv = /^[ \t]+([\w]+)\s*:\s*(.+)/.exec(line);
            if (kv) result.details[kv[1]] = unquote(kv[2]);
        }
    }

    // ── highlights sequence ───────────────────────────────────────────────────
    const hlBlock = blockAfter('highlights');
    if (hlBlock) {
        let current = null;
        for (const line of hlBlock.split('\n')) {
            if (line.trim() === '') continue;
            if (/^\S/.test(line)) break;                      // next top-level key
            const itemStart = /^[ \t]+-\s*(.*)/.exec(line);
            if (itemStart) {
                if (current) result.highlights.push(current);
                current = {};
                const kv = /^([\w]+)\s*:\s*(.+)/.exec(itemStart[1]);
                if (kv) current[kv[1]] = unquote(kv[2]);
            } else if (current) {
                const kv = /^[ \t]+([\w]+)\s*:\s*(.+)/.exec(line);
                if (kv) current[kv[1]] = unquote(kv[2]);
            }
        }
        if (current) result.highlights.push(current);
    }

    return result;
}

/** Set (add or update) a scalar key in the front matter of an index.md.
 *  Inserts after `insertAfter` key if the key is new; appends if anchor absent.
 *  Returns the new file text, or the original text if nothing changed. */
function removeFrontMatterKey(text, key) {
    const m = /^---\r?\n([\s\S]*?)\n---/.exec(text);
    if (!m) return text;
    const newYaml = m[1].replace(new RegExp(`^${key}\\s*:.*\\n?`, 'm'), '');
    if (newYaml === m[1]) return text;
    return text.slice(0, m.index) + `---\n${newYaml}\n---` + text.slice(m.index + m[0].length);
}

function setFrontMatterScalar(text, key, value, insertAfter = 'layout') {
    const m = /^---\r?\n([\s\S]*?)\n---/.exec(text);
    if (!m) return text;
    const yaml = m[1];
    const strVal = String(value);
    let newYaml;
    if (new RegExp(`^${key}\\s*:`, 'm').test(yaml)) {
        newYaml = yaml.replace(new RegExp(`^${key}\\s*:.*$`, 'm'), `${key}: ${strVal}`);
    } else {
        const anchorRe = new RegExp(`^(${insertAfter}\\s*:[^\\n]*)$`, 'm');
        if (anchorRe.test(yaml)) {
            newYaml = yaml.replace(anchorRe, `$1\n${key}: ${strVal}`);
        } else {
            newYaml = yaml.trimEnd() + `\n${key}: ${strVal}`;
        }
    }
    if (newYaml === yaml) return text;
    return text.slice(0, m.index) + `---\n${newYaml}\n---` + text.slice(m.index + m[0].length);
}

const _FULL_MONTHS = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];

/** Convert the first ISO date in a possibly comma-joined string to "Month D, YYYY". */
function isoToFullDate(iso) {
    if (!iso) return '';
    const d = iso.split(',').at(-1).trim();  // take last date if multi-day
    const mm = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    if (!mm) return '';
    return `${_FULL_MONTHS[+mm[2] - 1]} ${+mm[3]}, ${mm[1]}`;
}

// ── Justice pages sync ────────────────────────────────────────────────────────

/** Parse a "HH:MM:SS[.ss]" vocal total string into whole seconds. */
function _parseTotalSecs(total) {
    const m = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(total || '');
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

const _MS_PER_DAY = 86400000;

// Tenure durations are inclusive of both the start and stop day (a justice
// sworn in and retiring the same day served 1 day, not 0), so add one day's
// worth of ms to the raw difference before converting to days/years.
function _inclusiveDurationMs(startMs, stopMs) {
    return Math.max(0, stopMs - startMs) + _MS_PER_DAY;
}

/** Sum tenure durations in fractional years (open tenures use today's date). */
function _computeYearsServed(tenures) {
    let totalMs = 0;
    const now = Date.now();
    for (const t of tenures) {
        if (!t.dateStart) continue;
        const start = Date.parse(t.dateStart);
        const stop  = t.dateStop ? Date.parse(t.dateStop) : now;
        if (isNaN(start) || isNaN(stop)) continue;
        totalMs += _inclusiveDurationMs(start, stop);
    }
    return totalMs / (365.25 * _MS_PER_DAY);
}

/** Return the HTML body for a justice page.
 *  servedBase is the "Served from X to Y" sentence WITHOUT a trailing period. */
function _justiceBody(servedBase) {
    return [
        '<div style="display:flex; gap:1em;">',
        '<div style="flex:2; min-width:0; overflow:hidden;">',
        '<h1>{{ page.title }}</h1>',
        '<p>' + servedBase + '{% if page.years_served %}{% assign yr_str = page.years_served | append: "" | remove: ".0" %} ({{ yr_str }} year{% unless yr_str == "1" %}s{% endunless %} or {{ page.days_served }} days){% elsif page.date_start %} <span id="jp-dur"></span>{% endif %}.</p>',
        '{% if page.date_start %}<script>(function(){var e=document.getElementById("jp-dur");if(!e)return;var ms=Date.now()-Date.parse("{{ page.date_start }}")+86400000;var d=Math.floor(ms/86400000);var y=(ms/(365.25*86400000)).toFixed(1).replace(/\\.0$/,"");e.textContent="("+y+" year"+(y==="1"?"":"s")+" or "+d.toLocaleString()+" days)";}());</script>{% endif %}',
        '{% if page.case_count %}<p>Also argued {{ page.case_count }} {% if page.case_count == 1 %}<a href="/courts/ussc/?collection=justice_advocates&id={{ page.justice_id }}">case</a> on {{ page.last_argument }}{% else %}<a href="/courts/ussc/?collection=justice_advocates&id={{ page.justice_id }}">cases</a> from {{ page.first_argument }} to {{ page.last_argument }}{% endif %}.</p>{% endif %}',
        '{% if page.opinions or page.lone_dissents or page.vocal_secs %}<p>{% if page.opinions or page.lone_dissents %}Wrote {% if page.opinions %}{{ page.opinions }} majority <a href="/courts/ussc/?collection=opinions&id={{ page.justice_id }}">opinion{% if page.opinions != 1 %}s{% endif %}</a>{% endif %}{% if page.opinions and page.lone_dissents %} and {% endif %}{% if page.lone_dissents %}{{ page.lone_dissents }} lone <a href="/courts/ussc/?collection=lone_dissents&id={{ page.justice_id }}">dissent{% if page.lone_dissents != 1 %}s{% endif %}</a>{% endif %}{% if page.vocal_secs %}, and spoke for {{ page.vocal_secs | divided_by: 3600.0 | round: 1 }} hours in <a href="/courts/ussc/?collection=vocal_justices&id={{ page.justice_id }}">oral arguments</a>{% endif %}{% elsif page.vocal_secs %}Spoke for {{ page.vocal_secs | divided_by: 3600.0 | round: 1 }} hours in <a href="/courts/ussc/?collection=vocal_justices&id={{ page.justice_id }}">oral arguments</a>{% endif %}.</p>{% endif %}',
        '</div>',
        '<div class="jp-frame"><img src="portrait.jpg" alt="{{ page.title }}" onerror="this.parentElement.style.display=\'none\'"></div>',
        '</div>',
    ].join('\n');
}

/** Create/update courts/ussc/people/justices/all/<id>/index.md for every justice
 *  in data/ussc/justices.json. */
function syncJusticePages({ verbose = false } = {}) {
    const justicesJsonPath = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');
    if (!exists(justicesJsonPath)) {
        console.log('  NOTE: data/ussc/justices.json not found, skipping justice pages');
        return;
    }
    let justicesData;
    try { justicesData = readJson(justicesJsonPath); }
    catch (e) { console.error(`  ERROR reading justices.json: ${e.message}`); return; }

    // Build id -> advocacy stats from justice_advocates.json.
    let justiceAdvocates = [];
    if (exists(JUSTICE_ADVOCATES_FILE)) {
        try { justiceAdvocates = readJson(JUSTICE_ADVOCATES_FILE); } catch { justiceAdvocates = []; }
    }
    const advocateStats = new Map();
    for (const adv of justiceAdvocates) {
        const dates = [];
        for (const c of adv.cases || []) {
            for (const field of ['argument', 'reargument']) {
                const raw = c[field] || '';
                for (const part of raw.split(',')) {
                    const d = part.trim();
                    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.push(d);
                }
            }
        }
        dates.sort();
        advocateStats.set(adv.id, {
            caseCount: adv.cases.length,
            firstArgument: dates.length ? isoToFullDate(dates[0]) : '',
            lastArgument: dates.length ? isoToFullDate(dates[dates.length - 1]) : '',
        });
    }

    // Build per-justice stats maps (opinions, lone dissents, vocal).
    const justicesBase = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices');
    const _loadCounts = (file) => {
        const m = new Map();
        try { for (const e of readJson(path.join(justicesBase, file))) if (e.id) m.set(e.id, e.cases || 0); }
        catch {}
        return m;
    };
    const opinionsMap = _loadCounts('opinions.json');
    const loneMap     = _loadCounts('lone_dissents.json');
    const vocalMap    = new Map();
    try {
        for (const e of readJson(path.join(justicesBase, 'vocal_justices.json'))) {
            if (e.id) vocalMap.set(e.id, _parseTotalSecs(e.total));
        }
    } catch {}
    const wikiMap = new Map();
    try {
        for (const e of readJson(path.join(justicesBase, 'gallery.json'))) {
            if (e.id && e.wikipedia) wikiMap.set(e.id, e.wikipedia);
        }
    } catch {}

    ensureDir(JUSTICES_ALL_DIR);
    let created = 0, updated = 0;
    const galleryEntries = [];

    for (const [canonicalName, entry] of Object.entries(justicesData)) {
        const id        = makeAdvocateId(canonicalName);
        const isChief   = (entry.titles || []).some(t => t.startsWith('CHIEF JUSTICE'));
        const prefix    = isChief ? 'Chief Justice ' : 'Justice ';
        const title     = prefix + properCase(canonicalName);
        const dir       = path.join(JUSTICES_ALL_DIR, id);
        const mdPath    = path.join(dir, 'index.md');
        const stats     = advocateStats.get(id) || {};
        const caseCount = stats.caseCount || 0;
        const firstArg  = stats.firstArgument || '';
        const lastArg   = stats.lastArgument || '';

        // Per-justice stats.
        const opCount   = opinionsMap.get(id) || 0;
        const loneCount = loneMap.get(id) || 0;
        const vocalSecs = vocalMap.get(id) || 0;

        // Build tenure text and compute years served.
        const tenures = entry.tenures
            ? entry.tenures
            : [{ dateStart: entry.dateStart || '', dateStop: entry.dateStop || '' }];
        const servedPhrases = tenures.map(t => {
            const from = isoToFullDate(t.dateStart || '');
            const to   = t.dateStop ? isoToFullDate(t.dateStop) : 'present';
            return `from ${from} to ${to}`;
        });
        const servedBase = 'Served ' + (servedPhrases.length > 1
            ? servedPhrases.slice(0, -1).join(', ') + ' and ' + servedPhrases.at(-1)
            : servedPhrases[0]);
        const yrs      = _computeYearsServed(tenures);
        const yrsStr   = yrs > 0 ? yrs.toFixed(1) : '';
        const isActive = tenures.length > 0 && !tenures[tenures.length - 1].dateStop;
        const dateStartIso = isActive ? (tenures[0].dateStart || '') : '';
        const daysMs   = tenures.reduce((sum, t) => {
            if (!t.dateStart) return sum;
            const s = Date.parse(t.dateStart), e = t.dateStop ? Date.parse(t.dateStop) : Date.now();
            return sum + _inclusiveDurationMs(s, e);
        }, 0);
        const daysStr  = yrs > 0 ? Math.round(daysMs / _MS_PER_DAY).toLocaleString('en-US') : '';
        const wikiUrl  = wikiMap.get(id) || '';

        // Gallery entry (skip placeholder entries like "Unknown Justice" that
        // carry no known tenure start date).
        const galleryDateStart = tenures[0]?.dateStart || '';
        if (galleryDateStart) {
            const galleryEntry = {
                id,
                name: properCase(canonicalName),
                dateStart: galleryDateStart,
                dateStop: isActive ? '' : (tenures.at(-1)?.dateStop || ''),
                hasOp: opCount > 0,
            };
            if (!isActive) galleryEntry.yearsServed = Math.round(yrs * 10000) / 10000;
            if (loneCount) galleryEntry.loneDissents = loneCount;
            if (vocalSecs) galleryEntry.vocalSecs = vocalSecs;
            galleryEntry.page = `/courts/ussc/people/justices/all/${id}`;
            galleryEntry.cases = [];
            if (wikiUrl) galleryEntry.wikipedia = wikiUrl;
            galleryEntry.title = isChief ? 'Chief Justice' : 'Justice';
            galleryEntries.push(galleryEntry);
        }

        const body = _justiceBody(servedBase);

        if (!exists(mdPath)) {
            ensureDir(dir);
            let text = `---\ntitle: ${title}\nlayout: pane\njustice_id: ${id}`;
            if (dateStartIso) text += `\ndate_start: ${dateStartIso}`;
            if (wikiUrl)      text += `\nwikipedia_url: ${wikiUrl}`;
            if (yrsStr && !isActive)  text += `\nyears_served: ${yrsStr}`;
            if (daysStr && !isActive) text += `\ndays_served: "${daysStr}"`;
            if (opCount)              text += `\nopinions: ${opCount}`;
            if (loneCount) text += `\nlone_dissents: ${loneCount}`;
            if (vocalSecs) text += `\nvocal_secs: ${vocalSecs}`;
            if (caseCount) text += `\ncase_count: ${caseCount}`;
            if (firstArg)  text += `\nfirst_argument: ${firstArg}`;
            if (lastArg)   text += `\nlast_argument: ${lastArg}`;
            text += `\n---\n${body}\n`;
            writeText(mdPath, text);
            created++;
            if (verbose) console.log(`  Created justice page: ${relRepo(mdPath)}`);
        } else {
            let mdText = readText(mdPath);
            const original = mdText;

            // Update frontmatter fields.
            mdText = setFrontMatterScalar(mdText, 'justice_id', id, 'layout');
            if (dateStartIso) mdText = setFrontMatterScalar(mdText, 'date_start', dateStartIso, 'justice_id');
            if (wikiUrl)      mdText = setFrontMatterScalar(mdText, 'wikipedia_url', wikiUrl, dateStartIso ? 'date_start' : 'justice_id');
            if (isActive) {
                mdText = removeFrontMatterKey(mdText, 'years_served');
                mdText = removeFrontMatterKey(mdText, 'days_served');
            } else {
                if (yrsStr)  mdText = setFrontMatterScalar(mdText, 'years_served', yrsStr, wikiUrl ? 'wikipedia_url' : (dateStartIso ? 'date_start' : 'justice_id'));
                if (daysStr) mdText = setFrontMatterScalar(mdText, 'days_served', `"${daysStr}"`, 'years_served');
            }
            const _opAnchor = isActive ? (wikiUrl ? 'wikipedia_url' : 'date_start') : 'years_served';
            if (opCount)   mdText = setFrontMatterScalar(mdText, 'opinions', opCount, _opAnchor);
            if (loneCount) mdText = setFrontMatterScalar(mdText, 'lone_dissents', loneCount, 'opinions');
            if (vocalSecs) mdText = setFrontMatterScalar(mdText, 'vocal_secs', vocalSecs, 'lone_dissents');
            if (caseCount) {
                mdText = setFrontMatterScalar(mdText, 'case_count', caseCount);
                if (firstArg) mdText = setFrontMatterScalar(mdText, 'first_argument', firstArg, 'case_count');
                if (lastArg)  mdText = setFrontMatterScalar(mdText, 'last_argument', lastArg, 'first_argument');
            }

            // Migrate body if frame is absent, still carries the old inline <style> block,
            // is an active justice whose body predates the dynamic duration span,
            // has the old unlinked "argued N cases" text, or still carries the
            // now-removed inclusive-service-calculation note (also catches stale
            // copies of the pre-fix, non-inclusive jp-dur duration script).
            const needsDynDuration  = isActive && !mdText.includes('id="jp-dur"');
            const needsCasesLink    = mdText.includes('{% else %}cases from {{ page.first_argument }}');
            const needsCombinedP    = mdText.includes('View vocal statistics');
            const needsNoteRemoved  = mdText.includes('All service calculations are inclusive');
            if (!mdText.includes('class="jp-frame"') || mdText.includes('<style>\n.jp-frame') || needsDynDuration || needsCasesLink || needsCombinedP || needsNoteRemoved) {
                const fmEnd = /^---\r?\n[\s\S]*?\n---\r?\n/.exec(mdText);
                if (fmEnd) mdText = mdText.slice(0, fmEnd[0].length) + body + '\n';
            }

            if (mdText !== original) {
                writeText(mdPath, mdText);
                updated++;
                if (verbose) console.log(`  Updated justice page: ${relRepo(mdPath)}`);
            }
        }
    }

    if (created || updated) {
        console.log(`Justice pages: created ${created}, updated ${updated}`);
    } else {
        console.log('Justice pages: all up to date');
    }

    // Rebuild the Justice Gallery index (courts/ussc/collections/gallery/index.md
    // fetches this directly) so it stays in sync with opinions/lone-dissent/vocal
    // stats instead of drifting stale.
    galleryEntries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const galleryFile = path.join(justicesBase, 'gallery.json');
    const galleryChanged = !exists(galleryFile) || readText(galleryFile) !== JSON.stringify(galleryEntries, null, 2) + '\n';
    writeJson(galleryFile, galleryEntries);
    console.log(galleryChanged
        ? `Justice gallery: updated (${galleryEntries.length} entries)`
        : 'Justice gallery: all up to date');
}

// ── Bulk advocate sync (exported for use by update_cases.js) ─────────────────

export async function syncAdvocates(termDirs, { verbose = false, showWomen = false, markdownMode = false } = {}) {
    const advocates = loadExisting();
    // Purge any bogus justice-corruption names that may have been persisted
    // from a previous run before this filter existed.
    for (const key of Object.keys(advocates)) {
        if (isJusticeCorruptionName(advocates[key].name)) delete advocates[key];
    }
    ensureDir(ADVOCATES_DIR);

    /** key: name|title|term|number  -> array of date strings */
    const recordedDates = new Map();
    /** key: name|title|term|number  -> Set<date string> */
    const allAppearanceDates = new Map();
    /** `${nameKey}||${audio_href}` -> caseId of first recording — prevents
     *  duplicate case entries when two separate cases share the same
     *  consolidated argument audio. Intra-case duplicates (same audio_href
     *  appearing twice within a single case) are intentional and are allowed. */
    const seenAdvAudio = new Map();
    /** key: name|title|term|number -> bool */
    const caseFeminineSeen = new Map();
    /** name_upper -> bool */
    const nameFeminine = new Map();
    /** name_upper -> Set<tag-lowercase> aggregated across transcripts */
    const nameTags = new Map();
    /** key: title|term|number -> citation */
    const caseCitation = new Map();

    const ckCase  = (n, t, term, num) => `${n}|${t}|${term}|${num}`;
    const ckCite  = (t, term, num)    => `${t}|${term}|${num}`;

    const _JUSTICE_TITLES = new Set(['JUSTICE', 'CHIEF JUSTICE']);

    for (const termDir of termDirs) {
        const term = path.basename(termDir);
        const casesFile = path.join(termDir, 'cases.json');
        if (!exists(casesFile)) continue;

        let cases;
        try { cases = readJson(casesFile); }
        catch (e) {
            console.error(`  WARNING: could not parse ${casesFile}: ${e.message}`);
            continue;
        }

        for (const c of cases) {
            const title       = firstTitle(c.title) || '';
            const numberRaw   = c.number || '';
            const number      = numberRaw;
            const audioEntries = c.events || [];
            const decision    = c.decision || null;

            const usCite = c.usCite || '';
            const citeYear = (decision || '').slice(0, 4);
            let citation = '';
            if (usCite && citeYear) citation = `${usCite} (${citeYear})`;
            else if (usCite) citation = usCite;
            caseCitation.set(ckCite(title, term, number), citation);

            // The advocate JSON persists the 1-based index into the original
            // `events[]` array (matching the on-disk cases.json schema and the
            // URL `event` param). No per-iteration sort is needed here; the
            // `preferredOrigIdx` / `bestOrigIdxForDate` maps below disambiguate
            // siblings that share a date.

            // For terms <= 1999-10 prefer oyez transcripts when both sources cover the same date.
            const isEarlyTerm = term <= '1999-10';

            // For consolidated dockets (number contains comma), an event
            // whose title names a specific sub-docket (e.g. "in No. 54")
            // represents a separate argument and should be counted on its
            // own. Returns '' for non-consolidated cases or events whose
            // title doesn't isolate one of the listed sub-dockets (e.g.
            // multi-part argument blocks).
            const eventSubDocket = (ev) => {
                if (!number || !number.includes(',')) return '';
                const m = (ev.title || '').match(/\bNo\.\s*([\w-]+)/i);
                if (!m) return '';
                const sub = m[1];
                const parts = number.split(',').map(s => s.trim());
                return parts.includes(sub) ? sub : '';
            };

            // Keyed as `${date}|${subDocket}` so that USSC events for a
            // different sub-docket than the covering Oyez event are NOT skipped.
            // A USSC sub-docket event is also suppressed when Oyez has a
            // non-sub-docket entry on the same date (i.e. Oyez covers the full
            // consolidated argument without naming a specific docket).
            const oyezDates = new Set();
            if (isEarlyTerm) {
                for (const a of audioEntries) {
                    if (a.source === 'oyez' && a.text_href) {
                        const d = a.date || c.argument || '';
                        if (d) oyezDates.add(`${d}|${eventSubDocket(a)}`);
                    }
                }
            }

            // Returns true if oyezDates covers this event (same date + same or
            // unspecified sub-docket).
            const oyezCovers = (ev, date) => {
                const sub = eventSubDocket(ev);
                return oyezDates.has(`${date}|${sub}`) ||
                       (sub !== '' && oyezDates.has(`${date}|`));
            };
            const audioEntryAdvocates = new Map(); // origIdx -> Set<upper-name>
            // Tracks advocates seen in argument/reargument events so journal
            // events don't generate a duplicate entry for the same advocate.
            const advocateArgSeen = new Set(); // nameKey||term||number
            for (let preIdx = 0; preIdx < audioEntries.length; preIdx++) {
                const preAudio = audioEntries[preIdx];
                const names = new Set();
                for (const raw of preAudio.advocates || []) {
                    const rawName = (typeof raw === 'object' && raw !== null) ? raw.name : raw;
                    const n = normalizeNameSuffix((rawName || '').trim()).split(/\s+/).filter(Boolean).join(' ');
                    if (n) names.add(n.toUpperCase());
                }
                const preText = preAudio.text_href;
                const preDate = preAudio.date || c.argument || '';
                const skipUsscPre = isEarlyTerm && preAudio.source === 'ussc' && oyezCovers(preAudio, preDate);
                const hasExplicitPreAdvocates = (preAudio.advocates || []).length > 0;
                if (preText && !skipUsscPre && !hasExplicitPreAdvocates) {
                    const prePath = path.join(termDir, 'cases', preText);
                    if (exists(prePath)) {
                        try {
                            const preT = readJson(prePath);
                            for (const sp of preT?.media?.speakers || []) {
                                const spTitle = sp.title || '';
                                if (!_JUSTICE_TITLES.has(spTitle) && !spTitle.toUpperCase().includes('NP')) {
                                    const n = normalizeNameSuffix(sp.name || '').split(/\s+/).filter(Boolean).join(' ');
                                    // Skip single-name speakers from ussc transcript files (likely OCR artifacts).
                                    if (n && preAudio.source === 'ussc' && n.split(/\s+/).length === 1) continue;
                                    if (n) names.add(n.toUpperCase());
                                }
                            }
                        } catch { /* ignore */ }
                    }
                }
                if (names.size) audioEntryAdvocates.set(preIdx, names);
            }

            // For each (date, advocate) appearing in multiple entries, pick best position.
            const preferredOrigIdx = new Map(); // `${date}|${nameUpper}` -> origIdx
            const dateToIdxs = new Map();
            for (let i = 0; i < audioEntries.length; i++) {
                const d = audioEntries[i].date || c.argument || '';
                if (!dateToIdxs.has(d)) dateToIdxs.set(d, []);
                dateToIdxs.get(d).push(i);
            }
            const bestOrigIdxForDate = new Map();
            for (const [d, idxs] of dateToIdxs) {
                if (idxs.length <= 1) continue;
                const aligned   = idxs.filter(i => audioEntries[i].aligned);
                const withAudio = idxs.filter(i => audioEntries[i].audio_href);
                const bestI     = ([...aligned, ...withAudio, ...idxs])[0];
                bestOrigIdxForDate.set(d, bestI);
            }
            for (const [d, idxs] of dateToIdxs) {
                const allAdv = new Set();
                for (const i of idxs) {
                    for (const a of (audioEntryAdvocates.get(i) || [])) allAdv.add(a);
                }
                for (const adv of allAdv) {
                    const cands = idxs.filter(i => (audioEntryAdvocates.get(i) || new Set()).has(adv));
                    if (!cands.length) continue;
                    const aligned   = cands.filter(i => audioEntries[i].aligned);
                    const withAudio = cands.filter(i => audioEntries[i].audio_href);
                    let best = aligned[0] ?? withAudio[0] ?? cands[0];
                    // If the best candidate has no audio_href, prefer a sibling
                    // that has audio_href but no text_href (e.g. an Oyez entry
                    // added for audio coverage before a transcript is available).
                    if (!audioEntries[best].audio_href) {
                        const audioOnlySibling = idxs.find(
                            i => audioEntries[i].audio_href && !audioEntries[i].text_href,
                        );
                        if (audioOnlySibling != null) best = audioOnlySibling;
                    }
                    preferredOrigIdx.set(`${d}|${adv}`, best);
                }
            }

            for (let origIdx = 0; origIdx < audioEntries.length; origIdx++) {
                const audio = audioEntries[origIdx];
                const audioDate = audio.date || c.argument || '';

                // Map of upper-case advocate name -> role string (if any)
                // for this event's explicit advocates list. Used to attach
                // role/result to advocates discovered via the transcript.
                const audioRoles = new Map();
                for (const raw of audio.advocates || []) {
                    if (!raw || typeof raw !== 'object') continue;
                    const rn = (raw.name || '').trim();
                    if (!rn) continue;
                    const role = (raw.role || '').trim();
                    if (!role) continue;
                    const key = normalizeNameSuffix(rn).split(/\s+/).filter(Boolean).join(' ').toUpperCase();
                    if (key && !audioRoles.has(key)) audioRoles.set(key, role);
                }

                const recordAdvocate = (rawName, advocateTitle = '', explicitRole = '') => {
                    let name = (rawName || '').split(/\s+/).filter(Boolean).join(' ');
                    if (!name || !audioDate) return;
                    let nameKey = name.toUpperCase();
                    const preAliasKey = nameKey;
                    const canonicalKey = NAME_ALIASES[nameKey];
                    if (canonicalKey) {
                        const oldDisplay = name;
                        name = canonicalKey.split(/\s+/).filter(Boolean).join(' ');
                        nameKey = canonicalKey;
                        if (!(nameKey in advocates)) {
                            advocates[nameKey] = { id: makeAdvocateId(name), name, cases: [], previously: [] };
                        }
                        const prevList = advocates[nameKey].previously = advocates[nameKey].previously || [];
                        const oldUpper = oldDisplay.toUpperCase();
                        if (!prevList.map(p => p.toUpperCase()).includes(oldUpper)) {
                            prevList.push(oldUpper);
                        }
                    }
                    // Normalize justice names to their canonical (short) form so advocates
                    // who were also justices are stored under their short name.
                    const justiceCanonical = JUSTICE_CANONICAL_NAME[nameKey];
                    if (justiceCanonical) {
                        if (!(justiceCanonical in advocates)) {
                            advocates[justiceCanonical] = { id: makeAdvocateId(justiceCanonical), name: justiceCanonical, cases: [], previously: [] };
                        }
                        const prevList = advocates[justiceCanonical].previously = advocates[justiceCanonical].previously || [];
                        if (!prevList.map(p => p.toUpperCase()).includes(nameKey)) {
                            prevList.push(nameKey);
                        }
                        name = justiceCanonical;
                        nameKey = justiceCanonical;
                    }
                    // Skip journal-sourced events when an argument/reargument
                    // event already recorded this advocate for the same case.
                    const _argSeenKey = `${nameKey}||${term}||${number}`;
                    if (audio.source === 'journal') {
                        if (advocateArgSeen.has(_argSeenKey)) return;
                    } else {
                        advocateArgSeen.add(_argSeenKey);
                    }
                    const subKey = eventSubDocket(audio);
                    const caseKey = ckCase(nameKey, title, term, number + (subKey ? `#${subKey}` : ''));
                    // Feminine tracking ignores subKey: the warning is per
                    // (name, case) and a feminine title on any sub-event
                    // should satisfy the check for the whole case.
                    const femKey = ckCase(nameKey, title, term, number);
                    const isFem = isFeminineTitle(advocateTitle);
                    if (isFem) {
                        caseFeminineSeen.set(femKey, true);
                        nameFeminine.set(nameKey, true);
                    } else {
                        if (!caseFeminineSeen.has(femKey)) caseFeminineSeen.set(femKey, false);
                        if (!nameFeminine.has(nameKey)) nameFeminine.set(nameKey, false);
                    }
                    if (Number.isNaN(isoToDays(audioDate))) return;
                    if (!allAppearanceDates.has(caseKey)) allAppearanceDates.set(caseKey, new Set());
                    allAppearanceDates.get(caseKey).add(audioDate);
                    const prior = recordedDates.get(caseKey) || [];
                    if (prior.some(d => daysAbsDiff(d, audioDate) <= 7)) return;
                    if (!recordedDates.has(caseKey)) recordedDates.set(caseKey, []);
                    recordedDates.get(caseKey).push(audioDate);
                    if (!(nameKey in advocates)) {
                        advocates[nameKey] = { id: makeAdvocateId(name), name, cases: [] };
                    }
                    // When an event isolates a sub-docket, trust this event's
                    // own index — sibling resolution (preferredOrigIdx /
                    // bestOrigIdxForDate) would collapse the sub-cases.
                    const resolvedOrigIdx = subKey
                        ? origIdx
                        : (preferredOrigIdx.get(`${audioDate}|${nameKey}`)
                           ?? bestOrigIdxForDate.get(audioDate)
                           ?? origIdx);
                    const resolvedAudio = audioEntries[resolvedOrigIdx] || audio;
                    const dateFieldName = resolvedAudio.type === 'reargument' ? 'reargument' : 'argument';
                    let entryTitle = title;
                    if (subKey) {
                        const numParts   = number.split(',').map(n => n.trim());
                        const titleParts = (c.title || '').split('|');
                        const subIdx     = numParts.indexOf(subKey);
                        if (subIdx !== -1 && subIdx < titleParts.length) entryTitle = titleParts[subIdx];
                    }
                    const caseEntry = {
                        title: entryTitle,
                        term,
                        number: subKey || number || c.id,
                        [dateFieldName]: audioDate,
                    };
                    // Internal-only: original consolidated number (used for
                    // citation lookup, dedup, and URL building); stripped
                    // before the case entry is serialized to disk.
                    if (subKey) {
                        Object.defineProperty(caseEntry, '_fullNumber', { value: number,        enumerable: false });
                        Object.defineProperty(caseEntry, '_fullTitle',  { value: c.title || '', enumerable: false });
                    }
                    // Internal-only: the value to use when building this
                    // entry's case= URL — subKey when a specific consolidated
                    // docket was resolved (already unambiguous on its own),
                    // else the term-unique leading number or (if that's
                    // ambiguous) the case's own id. Never the raw comma-joined
                    // number.
                    Object.defineProperty(caseEntry, '_urlCase', { value: subKey || caseUrlNumber(c, cases), enumerable: false });
                    if (decision) caseEntry.decision = decision;
                    const advRole = (explicitRole
                        || audioRoles.get(nameKey)
                        || audioRoles.get(preAliasKey)
                        || '').trim();
                    if (advRole) caseEntry.role = advRole;
                    const summarized = summarizeResult(c.result, advRole);
                    if (summarized) caseEntry.result = summarized;
                    const sameDateEntries = (dateToIdxs.get(audioDate) || []).map(i => audioEntries[i]);
                    if (sameDateEntries.some(e => e.transcript_href)) caseEntry.transcript = true;
                    if (resolvedAudio.audio_href || resolvedAudio.transcript_href) {
                        caseEntry.event = resolvedOrigIdx + 1;
                    }
                    if (c.files) caseEntry.files = true;
                    // De-dup: two separate cases sharing the same audio_href
                    // represent a single consolidated argument; record it once
                    // per advocate. Intra-case duplicates (same audio_href used
                    // twice within one case to denote separate sub-arguments)
                    // are intentional and are NOT suppressed.
                    const _advAudioKey = resolvedAudio.audio_href
                        ? `${nameKey}||${resolvedAudio.audio_href}` : null;
                    if (_advAudioKey) {
                        const _firstCaseId = seenAdvAudio.get(_advAudioKey);
                        if (_firstCaseId !== undefined && _firstCaseId !== c.id) return;
                        if (_firstCaseId === undefined) seenAdvAudio.set(_advAudioKey, c.id);
                    }
                    advocates[nameKey].cases.push(caseEntry);
                };

                // For early terms, prefer the Oyez transcript when both
                // sources cover the same date — and skip the USSC event's
                // explicit advocates list too, so we don't double-record
                // the same appearance under a slightly-different name
                // variant (e.g. "ANN M. KAPPLER" vs "ANN MARY KAPPLER").
                const skipUsscTranscript = isEarlyTerm && audio.source === 'ussc' && oyezCovers(audio, audioDate);

                // Explicit advocates list
                if (!skipUsscTranscript) {
                    for (const raw of audio.advocates || []) {
                        const rawName  = (typeof raw === 'object' && raw !== null) ? raw.name  : raw;
                        const rawTitle = (typeof raw === 'object' && raw !== null) ? (raw.title || '') : '';
                        const rawRole  = (typeof raw === 'object' && raw !== null) ? (raw.role  || '') : '';
                        const rawTags  = (typeof raw === 'object' && raw !== null) ? (raw.tags  || null) : null;
                        recordAdvocate(normalizeNameSuffix((rawName || '').trim()), rawTitle, rawRole);
                        if (rawName && rawTags && (Array.isArray(rawTags) || typeof rawTags === 'string')) {
                            const tagList = Array.isArray(rawTags) ? rawTags : rawTags.split(',');
                            const norm = normalizeNameSuffix((rawName || '').trim()).split(/\s+/).filter(Boolean).join(' ').toUpperCase();
                            const key  = NAME_ALIASES[norm] || norm;
                            if (!nameTags.has(key)) nameTags.set(key, new Set());
                            const set = nameTags.get(key);
                            for (const t of tagList) {
                                if (typeof t === 'string' && t.trim()) set.add(t.trim().toLowerCase());
                            }
                        }
                    }
                }

                // Transcript-based speakers
                const textHref = audio.text_href;
                const hasExplicitAdvocates = (audio.advocates || []).length > 0;
                if (!textHref || !audioDate || skipUsscTranscript || hasExplicitAdvocates) continue;
                const transcriptPath = path.join(termDir, 'cases', textHref);
                if (!exists(transcriptPath)) continue;

                let transcript;
                try { transcript = readJson(transcriptPath); }
                catch (e) {
                    console.error(`  WARNING: could not parse ${transcriptPath}: ${e.message}`);
                    continue;
                }
                const renameMap = normalizeTranscript(transcript);
                if (Object.keys(renameMap).length) {
                    for (const [oldN, newN] of Object.entries(renameMap)) {
                        console.log(`  Normalised name in ${relRepo(transcriptPath)}: ${JSON.stringify(oldN)} -> ${JSON.stringify(newN)}`);
                    }
                    writeText(transcriptPath, JSON.stringify(transcript, null, 2) + '\n');
                }

                for (const speaker of transcript?.media?.speakers || []) {
                    const speakerTitle = speaker.title || '';
                    if (!speakerTitle || _JUSTICE_TITLES.has(speakerTitle)) continue;
                    if (speakerTitle.toUpperCase().includes('NP')) continue;
                    const spRaw = (speaker.name || '').trim();
                    // OCR'd USSC transcripts sometimes embed the full title cue
                    // in the name field (e.g. "CHIEF JUSTICE BURGER" with title
                    // "MR."). Skip any name that is itself a justice title form
                    // (exact or OCR corruption like "JUSITCE", "JUSTTICE", etc.).
                    if (isJusticeCorruptionName(spRaw)) continue;
                    recordAdvocate(spRaw, speakerTitle);
                    if (spRaw && (Array.isArray(speaker.tags) || typeof speaker.tags === 'string')) {
                        const tagList = Array.isArray(speaker.tags)
                            ? speaker.tags
                            : speaker.tags.split(',');
                        const norm = normalizeNameSuffix(spRaw).split(/\s+/).filter(Boolean).join(' ').toUpperCase();
                        const key  = NAME_ALIASES[norm] || norm;
                        if (!nameTags.has(key)) nameTags.set(key, new Set());
                        const set = nameTags.get(key);
                        for (const t of tagList) {
                            if (typeof t === 'string' && t.trim()) set.add(t.trim().toLowerCase());
                        }
                    }
                }
            }
        }
    }

    // Sort each advocate's cases by argument/reargument date, most recent first.
    for (const e of Object.values(advocates)) {
        e.cases.sort((a, b) => {
            const da = a.argument || a.reargument || a.date || '';
            const db = b.argument || b.reargument || b.date || '';
            return da < db ? 1 : da > db ? -1 : 0;
        });
    }

    // Drop advocates with no cases (orphaned).
    for (const e of Object.values(advocates)) {
        if (e.cases.length === 0) {
            const advId = e.id || makeAdvocateId(e.name);
            const orphan = path.join(ADVOCATES_DIR, `${advId}.json`);
            if (exists(orphan)) {
                fs.unlinkSync(orphan);
                console.log(`  Removed orphaned advocate file: ${relRepo(orphan)}`);
            }
        }
    }

    // Output sorted by cases (descending) then first name.
    let output = Object.values(advocates)
        .filter(e => e.cases.length > 0)
        .sort((a, b) => {
            const ca = a.cases.length, cb = b.cases.length;
            if (ca !== cb) return cb - ca;
            return (a.name || '').localeCompare(b.name || '');
        });

    // Merge entries that map to the same file ID (e.g., "G.J." vs "GJ", or
    // straight vs curly apostrophes that slipped through normalization).
    // The entry that sorts first (most cases, then alphabetically) is canonical;
    // its cases list is extended with any unique cases from the duplicate(s).
    {
        const seenIds = new Map(); // advId -> canonical entry
        const merged = [];
        for (const entry of output) {
            const advId = entry.id || makeAdvocateId(entry.name);
            if (!seenIds.has(advId)) {
                seenIds.set(advId, entry);
                merged.push(entry);
            } else {
                const canon = seenIds.get(advId);
                for (const c of entry.cases) {
                    const ck = `${c.term}|${c.number}|${c.argument || c.reargument || ''}`;
                    if (!canon.cases.some(x => `${x.term}|${x.number}|${x.argument || x.reargument || ''}` === ck)) {
                        canon.cases.push(c);
                    }
                }
                if (entry.previously) {
                    canon.previously = [...new Set([...(canon.previously || []), ...entry.previously])].sort();
                }
                console.log(`  Merged duplicate advocate "${entry.name}" into "${canon.name}" (same id: ${advId})`);
            }
        }
        output = merged;
    }

    // Skip one-word names.
    const skipped = output.filter(e => e.name.split(/\s+/).length === 1);
    output = output.filter(e => e.name.split(/\s+/).length > 1);

    let _isShadowWoman = () => false;
    if (skipped.length) {
        const multiWordWomenDates = new Set();
        for (const e of output) {
            if (nameFeminine.get(e.name.toUpperCase())) {
                const last = e.name.toUpperCase().split(/\s+/).pop();
                for (const cs of e.cases) {
                    multiWordWomenDates.add(`${last}|${cs.argument || ''}`);
                }
            }
        }
        _isShadowWoman = (entry) => {
            const nameUp = entry.name.toUpperCase();
            return entry.cases.some(cs => multiWordWomenDates.has(`${nameUp}|${cs.argument || ''}`));
        };

        const skippedWomen = skipped.filter(e =>
            nameFeminine.get(e.name.toUpperCase()) && !_isShadowWoman(e)
        );
        const womenSuffix = skippedWomen.length ? `, ${skippedWomen.length} possibly women` : '';

        if (verbose) {
            const header = `\nSkipped ${skipped.length} one-word advocate name(s) (likely incomplete matches${womenSuffix}):`;
            const entryLines = [];
            for (const entry of skipped) {
                const advId = entry.id || makeAdvocateId(entry.name);
                const stale = path.join(ADVOCATES_DIR, `${advId}.json`);
                const isFem = nameFeminine.get(entry.name.toUpperCase()) && !_isShadowWoman(entry);
                const femTag = isFem ? '  [possibly woman]' : '';
                const sortedCases = entry.cases.slice().sort((a, b) =>
                    (a.argument || a.reargument || '') < (b.argument || b.reargument || '') ? -1
                    : (a.argument || a.reargument || '') > (b.argument || b.reargument || '') ? 1 : 0);
                const casesStr = sortedCases.map(c => `${c.term}/${c.number}`).join('; ');
                if (verbose && exists(stale)) {
                    fs.unlinkSync(stale);
                    entryLines.push(`  ${entry.name} [${advId}.json removed]${femTag}: ${casesStr}`);
                } else {
                    entryLines.push(`  ${entry.name}${femTag}: ${casesStr}`);
                }
            }
            console.log(header);
            for (const line of entryLines) console.log(line);
            console.log('');
        } else {
            for (const entry of skipped) {
                const advId = entry.id || makeAdvocateId(entry.name);
                const stale = path.join(ADVOCATES_DIR, `${advId}.json`);
                if (exists(stale)) fs.unlinkSync(stale);
            }
            console.log(`Skipped ${skipped.length} one-word advocate name(s)${womenSuffix} (use --verbose to list them)`);
        }
    }

    // Write per-advocate case files.
    for (const entry of output) {
        const advId = entry.id || makeAdvocateId(entry.name);
        const caseFile = path.join(ADVOCATES_DIR, `${advId}.json`);
        // Derive details and highlights from the featured folder (if any).
        const featuredDir = path.join(FEATURED_DIR, advId);
        const featuredMd  = path.join(featuredDir, 'index.md');
        const hasFeatured = exists(featuredMd);
        const featuredMdText = hasFeatured ? readText(featuredMd) : null;
        const fm          = featuredMdText ? parseFrontMatter(featuredMdText) : null;
        const details     = hasFeatured
            ? { page: '/courts/ussc/people/advocates/featured/' + advId, ...fm.details }
            : {};
        const highlights  = fm ? fm.highlights : [];
        if (hasFeatured) {
            const lastCase = entry.cases[0];  // cases[] is newest-first
            const lastDate = lastCase ? isoToFullDate(lastCase.argument || lastCase.reargument || '') : '';
            let mdText = featuredMdText;
            mdText = setFrontMatterScalar(mdText, 'case_count', entry.cases.length);
            if (lastDate) mdText = setFrontMatterScalar(mdText, 'last_argument', lastDate, 'case_count');
            if (mdText !== featuredMdText) writeText(featuredMd, mdText);
        }
        const envelope = {
            details,
            highlights,
        };
        if (entry.previously) {
            envelope.previously = [...new Set(entry.previously)].sort();
        }
        // Assign appearance numbers: 1 = first (oldest) appearance, N = most recent.
        // cases[] is sorted newest-first so index 0 maps to appearance N.
        const _n = entry.cases.length;
        for (let _i = 0; _i < _n; _i++) {
            delete entry.cases[_i].appearance;
            entry.cases[_i].appearance = _n - _i;
        }
        envelope.cases = entry.cases;
        writeJson(caseFile, envelope);
    }

    // Remove orphan advocate files.
    const knownIds = new Set(output.map(e => e.id || makeAdvocateId(e.name)));
    for (const orphan of listJsonFiles(ADVOCATES_DIR)) {
        const stem = path.basename(orphan, '.json');
        if (!knownIds.has(stem)) {
            fs.unlinkSync(orphan);
            console.log(`  Removed stale advocate file: ${relRepo(orphan)}`);
        }
    }

    // Write the index.
    const index = output.map(e => {
        const caseCount = e.cases.length;
        // cases[] is sorted most-recent-first, so [0] = newest, [last] = oldest.
        const dateLast  = caseCount ? (e.cases[0].argument || e.cases[0].reargument || '')             : '';
        const dateFirst = caseCount ? (e.cases[caseCount - 1].argument || e.cases[caseCount - 1].reargument || '') : '';
        const entry = {
            id: e.id || makeAdvocateId(e.name),
            name: e.name,
            cases: caseCount,
        };
        if (dateFirst) entry.dateFirst = dateFirst;
        if (dateLast)  entry.dateLast  = dateLast;
        if (e.previously) entry.previously = [...new Set(e.previously)].sort();
        return entry;
    });
    // Top 100 advocates index (preserves cases-descending sort from `output`).
    const topIndex = index.slice(0, 100);
    writeJson(TOP100_OUTPUT_FILE, topIndex);
    console.log(`Wrote ${topIndex.length} advocates to ${relRepo(TOP100_OUTPUT_FILE)}`);

    // Top advocates for 21st-century terms (2000-10 onward), ranked by 21st-century argument count.
    const TOP21ST_TERM_START = '2000-10';
    const top21stIndex = output
        .map(e => {
            const c21 = e.cases.filter(c => (c.term || '') >= TOP21ST_TERM_START);
            if (!c21.length) return null;
            // e.cases is sorted newest-first, so c21 preserves that order.
            const dateLast21  = c21[0].argument || c21[0].reargument || '';
            const dateFirst21 = c21[c21.length - 1].argument || c21[c21.length - 1].reargument || '';
            const entry = {
                id:    e.id || makeAdvocateId(e.name),
                name:  e.name,
                cases: c21.length,
            };
            if (dateFirst21) entry.dateFirst = dateFirst21;
            if (dateLast21)  entry.dateLast  = dateLast21;
            if (e.previously) entry.previously = [...new Set(e.previously)].sort();
            return entry;
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (a.cases !== b.cases) return b.cases - a.cases;
            return (a.name || '').localeCompare(b.name || '');
        });
    ensureDir(path.dirname(TOP21ST_OUTPUT_FILE));
    writeJson(TOP21ST_OUTPUT_FILE, top21stIndex.slice(0, 100));
    console.log(`Wrote ${Math.min(top21stIndex.length, 100)} advocates to ${relRepo(TOP21ST_OUTPUT_FILE)}`);

    // Auto-create a featured index.md for any top advocate that doesn't have one yet.
    let featuredCreated = 0;
    for (const adv of topIndex) {
        const featuredDir = path.join(FEATURED_DIR, adv.id);
        const featuredMd  = path.join(featuredDir, 'index.md');
        if (!exists(featuredMd)) {
            ensureDir(featuredDir);
            writeText(featuredMd, FEATURED_TEMPLATE.replace('TBD', properCase(adv.name)));
            featuredCreated++;
            if (verbose) console.log(`  Created featured page: ${relRepo(featuredMd)}`);
        }
    }
    if (featuredCreated) console.log(`Created ${featuredCreated} featured index.md file(s)`);

    // Women and transgender indices preserve the cases-descending sort from `output`.
    const womenIndex = index.filter(e => nameFeminine.get(e.name.toUpperCase()));
    writeJson(WOMEN_OUTPUT_FILE, womenIndex);
    console.log(`Wrote ${womenIndex.length} women advocates to ${relRepo(WOMEN_OUTPUT_FILE)}`);

    const transIndex = index.filter(e => {
        const tags = nameTags.get(e.name.toUpperCase());
        return tags && tags.has('transgender');
    });
    writeJson(TRANS_OUTPUT_FILE, transIndex);
    console.log(`Wrote ${transIndex.length} transgender advocates to ${relRepo(TRANS_OUTPUT_FILE)}`);

    // All-advocates index sorted by name.
    index.sort((a, b) => a.name.localeCompare(b.name));
    ensureDir(path.dirname(OUTPUT_FILE));
    writeJson(OUTPUT_FILE, index);
    console.log(`Wrote ${output.length} advocates to ${relRepo(OUTPUT_FILE)}`);

    // ── women.csv ──────────────────────────────────────────
    let womenRows = [];
    for (const [nameUpper, entry] of Object.entries(advocates)) {
        if (!nameFeminine.get(nameUpper)) continue;
        if (entry.name.split(/\s+/).length <= 1) continue;
        const aliasedUpper = NAME_ALIASES[nameUpper];
        const canonicalUpper = aliasedUpper || nameUpper;
        const advName = canonicalUpper.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase());
        const sortedCases = entry.cases.slice().sort((a, b) =>
            (a.argument || a.reargument || '') < (b.argument || b.reargument || '') ? -1
            : (a.argument || a.reargument || '') > (b.argument || b.reargument || '') ? 1 : 0);
        let argNum = 0;
        for (const c of sortedCases) {
            argNum++;
            const fullNum = c._fullNumber || c.number;
            const lookupTitle = firstTitle(c._fullTitle || c.title);
            const cit = caseCitation.get(ckCite(lookupTitle, c.term, fullNum)) || '';
            const audioIdx = c.audio;
            let url = `https://argumentaloud.org/courts/ussc/?term=${c.term}&case=${encodeURIComponent(c._urlCase)}`;
            if (audioIdx) url += `&event=${audioIdx}`;
            const caseKey = ckCase(nameUpper, lookupTitle, c.term, fullNum);
            let allDates = [];
            const anchor = c.argument || c.reargument || '';
            if (!Number.isNaN(isoToDays(anchor))) {
                const dates = [...(allAppearanceDates.get(caseKey) || [])]
                    .filter(d => daysAbsDiff(d, anchor) <= 7)
                    .sort();
                allDates = dates;
            }
            const argDate = allDates.length ? allDates.join(',') : (c.argument || c.reargument || '');
            womenRows.push([advName, argNum, argDate, c.term, c.number, c.title, cit, url, '']);
        }
    }
    womenRows.sort((a, b) => {
        const an = a[0].toLowerCase(), bn = b[0].toLowerCase();
        if (an < bn) return -1; if (an > bn) return 1;
        return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
    });

    // ── Cross-check against reference CSV ────────────────────────────────
    const REF_CSV = path.join(REPO_ROOT, 'data', 'misc', 'women', 'Women Advocates Through October Term 2024.csv');
    const _ORDINAL_RE   = /\s*\(\d+\)\s*$/;
    const _FORMERLY_RE  = /\s*\(formerly\s+[^)]+\)/ig;
    const _MONTH_ABBR_MAP = {
        jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
        jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const monthNum = (token) => {
        const key = token.toLowerCase().replace(/\.$/, '').trim().slice(0, 3);
        return _MONTH_ABBR_MAP[key] || '';
    };
    const refDatesToIsoSet = (dateStr) => {
        let s = (dateStr || '').trim();
        if (!s) return new Set();
        s = s.replace(/^reargued\s*/i, '');
        const ym = /\b(\d{4})\s*$/.exec(s);
        if (!ym) return new Set();
        const year = ym[1];
        let body = s.slice(0, ym.index).trim().replace(/,$/, '').trim();
        const results = new Set();
        // Cross-month range
        let m = /^([A-Za-z]+\.?)\s*(\d+)\s*-\s*([A-Za-z]+\.?)\s*(\d+)$/.exec(body);
        if (m) {
            const m1 = monthNum(m[1]), d1 = m[2].padStart(2, '0');
            const m2 = monthNum(m[3]), d2 = m[4].padStart(2, '0');
            if (m1) results.add(`${year}-${m1}-${d1}`);
            if (m2) results.add(`${year}-${m2}-${d2}`);
            return results;
        }
        // Same-month
        m = /^([A-Za-z]+\.?)\s+([\d,\s-]+)$/.exec(body);
        if (m) {
            const month = monthNum(m[1]);
            if (month) {
                for (const tok of m[2].split(/[,\-]+/)) {
                    const t = tok.trim();
                    if (/^\d+$/.test(t)) results.add(`${year}-${month}-${t.padStart(2, '0')}`);
                }
                if (results.size) return results;
            }
        }
        // Plain
        m = /^([A-Za-z]+\.?)\s+(\d+)$/.exec(body);
        if (m) {
            const month = monthNum(m[1]);
            if (month) results.add(`${year}-${month}-${m[2].padStart(2, '0')}`);
        }
        return results;
    };
    const normalizeName = (n) => stripDiacritics((n || '').replace(/[\u2018\u2019]/g, "'"));
    const nameParts = (n) => {
        let s = (n || '').replace(_ORDINAL_RE, '').trim();
        s = s.replace(_FORMERLY_RE, '').trim();
        s = s.split(',')[0].trim();
        s = normalizeName(s);
        const words = s.split(/\s+/).filter(Boolean);
        if (words.length === 0) return ['', ''];
        return [words[0].toUpperCase(), words[words.length - 1].toUpperCase()];
    };

    if (exists(REF_CSV)) {
        const refRows = parseCsvDict(readText(REF_CSV))
            .map(r => {
                const isoSet = refDatesToIsoSet(r['Argument Date'] || '');
                const [first, last] = nameParts(r['Advocate Name'] || '');
                return { ...r, _iso_set: isoSet, _first: first, _last: last };
            });

        const refNameLookup = new Map(); // `${first}|${last}` -> [rows]
        const addLookup = (k, r) => {
            if (!refNameLookup.has(k)) refNameLookup.set(k, []);
            const lst = refNameLookup.get(k);
            if (!lst.includes(r)) lst.push(r);
        };
        for (const r of refRows) {
            if (r._iso_set.size === 0) continue;
            addLookup(`${r._first}|${r._last}`, r);
            const refFullUpper = normalizeName((r['Advocate Name'] || '').replace(_ORDINAL_RE, '')).toUpperCase();
            const aliasUpper = NAME_ALIASES[`${r._first} ${r._last}`] || NAME_ALIASES[refFullUpper];
            if (aliasUpper) {
                const [af, al] = nameParts(aliasUpper);
                if (`${af}|${al}` !== `${r._first}|${r._last}`) addLookup(`${af}|${al}`, r);
            }
        }

        // Title-similarity helpers for disambiguating multiple date matches.
        // Extract "significant" words: capitalized, length >= 2, not common legal/connector words.
        const _TITLE_STOPWORDS = new Set(['Inc','LLC','Ltd','Corp','Co','The','And','For','Of','In','At','By','To','An','Or','Vs','United','States']);
        const _titleSigWords = (s) =>
            (s || '').split(/[\s,.()\[\]\/&+]+/)
                .map(w => w.replace(/[^A-Za-z0-9]/g, ''))
                .filter(w => w.length >= 2 && /^[A-Z]/.test(w) && !_TITLE_STOPWORDS.has(w));
        const _titleSimilarity = (a, b) => {
            const wa = new Set(_titleSigWords(a).map(w => w.toUpperCase()));
            const wb = new Set(_titleSigWords(b).map(w => w.toUpperCase()));
            if (wa.size === 0 || wb.size === 0) return 0;
            let overlap = 0;
            for (const w of wa) if (wb.has(w)) overlap++;
            return overlap / Math.min(wa.size, wb.size);
        };

        // Citation-based fallback lookup: `${first}|${last}|${vol}|${pg}` -> [rows]
        // Covers refRows with unparseable dates and any row missed by date matching.
        const _US_CITE_RE = /\b(\d+)\s+U\.S\.[\s\xa0]+(\d+)\b/;
        const refCiteLookup = new Map();
        for (const r of refRows) {
            const m = _US_CITE_RE.exec(r['Case Name'] || '');
            if (!m) continue;
            const key = `${r._first}|${r._last}|${m[1]}|${m[2]}`;
            if (!refCiteLookup.has(key)) refCiteLookup.set(key, []);
            refCiteLookup.get(key).push(r);
        }

        // Case-number lookup from ref's Case Name: `${first}|${last}|${num}` -> [rows]
        // Parses "(No. 330)", "(Nos. 38 & 39)", "(No. 69-5003)", etc.
        const _CASE_NUM_RE = /\(\s*Nos?\.\s*([\d][^)]*?)\s*\)/i;
        const _parseCaseNums = (caseName) => {
            const m = _CASE_NUM_RE.exec(caseName || '');
            if (!m) return [];
            return m[1].split(/[\s,&]+/).map(s => s.trim()).filter(s => /^\d[\d-]*$/.test(s));
        };
        const refCaseNumLookup = new Map();
        for (const r of refRows) {
            for (const num of _parseCaseNums(r['Case Name'] || '')) {
                const key = `${r._first}|${r._last}|${num}`;
                if (!refCaseNumLookup.has(key)) refCaseNumLookup.set(key, []);
                const lst = refCaseNumLookup.get(key);
                if (!lst.includes(r)) lst.push(r);
            }
        }

        const refMatched = new Set();
        const updatedRows = [];
        const ourUnmatched = [];
        // refRow (with Source) → array of indices into updatedRows
        const refSourceMatches = new Map();
        for (const row of womenRows) {
            const [advName, argNum, argDate, term, caseNum, title, cit, url] = row;
            const [first, last] = nameParts(advName);
            const candidates = refNameLookup.get(`${first}|${last}`) || [];
            const ourDates = new Set(argDate.split(','));
            let dateMatches = candidates.filter(r => [...ourDates].some(d => r._iso_set.has(d)));
            // Fallback: if no date match, try matching by citation extracted from Case Name.
            if (dateMatches.length === 0) {
                const cm = _US_CITE_RE.exec(cit || '');
                if (cm) {
                    const citeKey = `${first}|${last}|${cm[1]}|${cm[2]}`;
                    dateMatches = refCiteLookup.get(citeKey) || [];
                }
            }
            // Disambiguate multiple matches by case number from ref's Case Name.
            if (dateMatches.length > 1) {
                const ourNums = new Set(caseNum.split(',').map(s => s.trim()));
                const numMatches = dateMatches.filter(r =>
                    _parseCaseNums(r['Case Name'] || '').some(n => ourNums.has(n))
                );
                if (numMatches.length === 1) dateMatches = numMatches;
            }
            // Disambiguate multiple matches by title similarity.
            if (dateMatches.length > 1) {
                const scored = dateMatches.map(r => ({ r, score: _titleSimilarity(title, r['Case Name'] || '') }));
                const best = scored.reduce((a, b) => a.score >= b.score ? a : b);
                const tied = scored.filter(x => x.score === best.score);
                if (tied.length === 1 && best.score > 0) dateMatches = [best.r];
            }
            // If the sole remaining match explicitly names case numbers and ours isn't among them,
            // reject it — but only when the titles are also dissimilar (guards against ref-CSV typos
            // where the case number is off by one but the party name is the same).
            // Expand short ranges like "54-57" → ["54","55","56","57"] (but leave modern docket
            // numbers like "69-5003" intact since their range span would be enormous).
            if (dateMatches.length === 1) {
                const refNums = _parseCaseNums(dateMatches[0]['Case Name'] || '');
                if (refNums.length > 0) {
                    const expanded = new Set();
                    for (const n of refNums) {
                        const rm = /^(\d{1,3})-(\d{1,3})$/.exec(n);
                        if (rm) {
                            const lo = parseInt(rm[1], 10), hi = parseInt(rm[2], 10);
                            if (lo < hi && hi - lo <= 20) {
                                for (let i = lo; i <= hi; i++) expanded.add(String(i));
                                continue;
                            }
                        }
                        expanded.add(n);
                    }
                    const ourNums = new Set(caseNum.split(',').map(s => s.trim()));
                    if (![...ourNums].some(n => expanded.has(n))) {
                        const sim = _titleSimilarity(title, dateMatches[0]['Case Name'] || '');
                        if (sim < 0.5) dateMatches = [];
                    }
                }
            }
            const matchedRef = dateMatches[0] || null;
            if (matchedRef) {
                for (const r of dateMatches) refMatched.add(r);
                let canonical = (matchedRef['Advocate Name'] || '')
                    .replace(_FORMERLY_RE, '')
                    .replace(_ORDINAL_RE, '')
                    .split(',')[0].trim();
                // Apply speakers.json alias normalization to the ref CSV name too.
                const canonicalAliasUpper = NAME_ALIASES[canonical.toUpperCase().replace(/\s+/g, ' ')];
                if (canonicalAliasUpper) {
                    canonical = canonicalAliasUpper.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase());
                }
                const refSrc = (matchedRef['Source'] || '').trim();
                if (refSrc) {
                    const idx = updatedRows.length;
                    if (!refSourceMatches.has(matchedRef)) refSourceMatches.set(matchedRef, []);
                    refSourceMatches.get(matchedRef).push(idx);
                }
                updatedRows.push([canonical, argNum, argDate, term, caseNum, title, cit, url, refSrc]);
            } else {
                updatedRows.push([...row.slice(0, 8), '']);
                ourUnmatched.push(row);
            }
        }
        womenRows = updatedRows;

        // ── Source warnings + journal_ref updates ─────────────────────────
        // Regex for journal sources: YYYY J.? Sup.? Ct.? U.S.? PAGE
        const _JOURNAL_SRC_RE = /^(\d{4})\s+J\.?\s*Sup\.?\s*Ct\.?\s*U\.S\.?\s*(\d+)/i;
        const applyJournalRef = (src, idxList) => {
            const m = _JOURNAL_SRC_RE.exec(src);
            if (!m) return;
            const journalTerm = `${m[1]}-10`;
            const page = m[2];
            // Group indices by cases.json path so each file is read/written once.
            const byPath = new Map();
            for (const idx of idxList) {
                const [, , argDate, caseTerm, caseNum] = updatedRows[idx];
                const casesPath = path.join(TERMS_DIR, caseTerm, 'cases.json');
                if (!exists(casesPath)) continue;
                if (!byPath.has(casesPath)) byPath.set(casesPath, []);
                byPath.get(casesPath).push({ argDate, caseTerm, caseNum });
            }
            for (const [casesPath, entries] of byPath) {
                let caseData;
                try { caseData = readJson(casesPath); } catch { continue; }
                let changed = false;
                for (const { argDate, caseTerm, caseNum } of entries) {
                    const journalRef = journalTerm === caseTerm ? page : `${journalTerm}:${page}`;
                    const argDates = new Set(argDate.split(',').map(s => s.trim()).filter(Boolean));
                    for (const c of caseData) {
                        const nums = (c.number || '').split(',').map(s => s.trim());
                        if (!nums.includes(caseNum)) continue;
                        for (let ei = 0; ei < (c.events || []).length; ei++) {
                            const ev = c.events[ei];
                            if (ev.type !== 'argument' && ev.type !== 'reargument') continue;
                            if (!argDates.has(ev.date || '')) continue;
                            if ('journal_ref' in ev) break;
                            c.events[ei] = reorderEvent({ ...ev, journal_ref: journalRef });
                            changed = true;
                        }
                        if (changed) break;
                    }
                    if (changed) console.log(`  journal_ref ${journalRef} → ${caseTerm}/${caseNum} (${argDate})`);
                }
                if (changed) writeJson(casesPath, caseData);
            }
        };
        for (const r of refRows) {
            const src = (r['Source'] || '').trim();
            if (!src) continue;
            const matches = refSourceMatches.get(r) || [];
            if (matches.length === 0) {
                if ((r['Advocate No.'] || '').trim() === '-1') continue;
                console.log(`  WARNING: Source row unmatched in our data — ${r['Advocate Name']}  ${r['Argument Date'] || ''}`);
            } else {
                if (matches.length > 1)
                    console.log(`  NOTE: ref row covers ${matches.length} of our cases — ${r['Advocate Name']}  ${r['Argument Date'] || ''}`);
                applyJournalRef(src, matches);
            }
        }

        const refUnmatched = refRows.filter(r =>
            !refMatched.has(r) && r._iso_set.size > 0 &&
            (r['Advocate No.'] || '').trim() !== '-1' &&
            !(normalizeName((r['Advocate Name'] || '').replace(_ORDINAL_RE, '')).toUpperCase() in NAME_ALIASES)
        );

        if (ourUnmatched.length) {
            if (showWomen && markdownMode) {
                console.log(`\n### Our records not matched in reference CSV (${ourUnmatched.length})\n`);
                const sorted = ourUnmatched.slice().sort((a, b) => {
                    if (a[2] < b[2]) return -1; if (a[2] > b[2]) return 1;
                    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
                });
                for (const row of sorted) {
                    const [advName, , argDate, , caseNum, title, , caseUrl] = row;
                    const advId = makeAdvocateId(advName);
                    const advUrl = `https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=${advId}`;
                    const firstIso = argDate.split(',')[0];
                    let dateStr = firstIso;
                    if (!Number.isNaN(isoToDays(firstIso))) {
                        const months = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'];
                        const y = +firstIso.slice(0, 4);
                        const mo = +firstIso.slice(5, 7);
                        const d = +firstIso.slice(8, 10);
                        dateStr = `${months[mo - 1]} ${d}, ${y}`;
                    }
                    console.log(`- [${advName}](${advUrl}) argued on ${dateStr} in [${title} (No. ${caseNum})](${caseUrl})`);
                }
            } else if (showWomen) {
                console.log(`\nOur records not matched in reference CSV (${ourUnmatched.length}):`);
                const sorted = ourUnmatched.slice().sort((a, b) => {
                    if (a[0] < b[0]) return -1; if (a[0] > b[0]) return 1;
                    return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
                });
                for (const row of sorted) console.log(`  ${row[0]}  ${row[2]}  ${row[4]}  ${row[5]}`);
            } else {
                console.log(`Found ${ourUnmatched.length} records not matched in reference CSV (use --women to list)`);
            }
        }

        if (refUnmatched.length) {
            if (verbose) {
                console.log(`\nReference CSV records not matched in our data (${refUnmatched.length}):`);
                for (const r of refUnmatched) {
                    console.log(`  ${r['Advocate Name']}  ${r['Argument Date'] || ''}  ${r['Case Name'] || ''}`);
                }
            } else {
                console.log(`Reference CSV records not matched in our data: ${refUnmatched.length} (use --verbose to list)`);
            }
        }
    } else {
        console.log(`  NOTE: Reference CSV not found, skipping cross-check: ${relRepo(REF_CSV)}`);
    }

    ensureDir(path.dirname(WOMEN_CSV_FILE));
    const csvHeaders = ['Advocate Name', 'Advocate Argument Number', 'Argument Date',
        'Term', 'Case Number', 'Case Title', 'Citation', 'URL', 'Source'];
    writeText(WOMEN_CSV_FILE, writeCsvNonnumeric(csvHeaders, womenRows));
    console.log(`Wrote ${womenRows.length} rows to ${relRepo(WOMEN_CSV_FILE)}`);

    // ── Justice-advocates collection sync ────────────────────────────────
    syncJusticeAdvocates(termDirs, { verbose });
    syncJusticePages({ verbose });

    // Duplicate-argument check.
    const dupSeen = new Map();
    womenRows.forEach((row, rowIdx) => {
        const [advName, , argDate, , number, title] = row;
        const dupKey = `${advName.toLowerCase()}|${argDate}|${number}|${title.toLowerCase()}`;
        if (dupSeen.has(dupKey)) {
            console.log(`  WARNING: duplicate argument — "${advName}" on ${argDate} in "${title}" (rows ${dupSeen.get(dupKey) + 1} and ${rowIdx + 1} of CSV)`);
        } else {
            dupSeen.set(dupKey, rowIdx);
        }
    });

    // Failed feminine-title cases.
    const failed = {};
    for (const [nameUpper, entry] of Object.entries(advocates)) {
        if (!nameFeminine.get(nameUpper)) continue;
        if (entry.name.split(/\s+/).length <= 1) continue;
        const badCases = entry.cases.filter(c =>
            !caseFeminineSeen.get(ckCase(nameUpper, firstTitle(c._fullTitle || c.title), c.term, c._fullNumber || c.number))
        );
        if (badCases.length) failed[entry.name] = badCases;
    }
    const failedNames = Object.keys(failed).sort();
    if (failedNames.length) {
        console.log(`\nWomen advocates with cases not meeting feminine-title criteria (${failedNames.length} advocate(s)):`);
        for (const advName of failedNames) {
            console.log(`  ${advName}:`);
            for (const c of failed[advName]) console.log(`    ${c.term}  ${firstTitle(c.title)}  [${c.argument}]`);
        }
    }

    // ── Anomaly report ────────────────────────────────────────────────────
    const _suffixStripRe = /,.*$/;
    const advTokens = (n) => n.replace(_suffixStripRe, '').trim().split(/\s+/).filter(Boolean);

    const bareInitial = [];
    for (const entry of Object.values(advocates)) {
        const tokens = advTokens(entry.name);
        if (tokens.length < 3) continue;
        for (const tok of tokens.slice(1, -1)) {
            if (tok.length === 1 && /^[A-Za-z]$/.test(tok)) {
                bareInitial.push(entry.name);
                break;
            }
        }
    }

    const sim = new Map(); // `${first}|${last}|${midCh}` -> [names]
    const twoToken = new Map(); // `${first}|${last}` -> [names]
    const addToMap = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const entry of Object.values(advocates)) {
        const tokens = advTokens(entry.name);
        if (tokens.length === 2) {
            addToMap(twoToken, `${tokens[0].toUpperCase()}|${tokens[1].toUpperCase()}`, entry.name);
        } else if (tokens.length >= 3) {
            const first = tokens[0].toUpperCase();
            const last = tokens[tokens.length - 1].toUpperCase();
            const midCh = tokens[1][0].toUpperCase();
            if (/^[A-Z]$/.test(midCh)) addToMap(sim, `${first}|${last}|${midCh}`, entry.name);
        }
    }
    for (const [key, twoNames] of twoToken) {
        const [first, last] = key.split('|');
        const matchedKeys = [...sim.keys()].filter(k => {
            const [f, l] = k.split('|'); return f === first && l === last;
        });
        if (matchedKeys.length) {
            for (const k of matchedKeys) sim.get(k).push(...twoNames);
        } else if (twoNames.length > 1) {
            sim.set(`${first}|${last}|`, [...twoNames]);
        }
    }

    let similar = new Map();
    for (const [k, v] of sim) {
        if (v.length > 1) similar.set(k, v.slice().sort());
    }
    const groupResolved = (names) => {
        for (const cand of names) {
            const canonical = cand.toUpperCase();
            const others = names.filter(n => n !== cand);
            if (others.every(n => NAME_ALIASES[n.toUpperCase()] === canonical)) return true;
        }
        return false;
    };
    similar = new Map([...similar].filter(([, v]) => !groupResolved(v)));

    if (bareInitial.length || similar.size) {
        if (verbose) {
            console.log('\n── Advocate name anomalies ──────────────────────────────────────────────');
            if (bareInitial.length) {
                console.log(`\nAdvocates with bare middle initial (no period) (${bareInitial.length}):`);
                for (const name of bareInitial.slice().sort()) console.log(`  ${name}`);
            }
            if (similar.size) {
                console.log(`\nAdvocates similar by first/last/middle-initial (${similar.size} group(s)):`);
                for (const [key, names] of [...similar].sort()) {
                    const [first, last, midCh] = key.split('|');
                    const label = midCh ? `${first} ${midCh}. ${last}` : `${first} ${last}`;
                    console.log(`  ${label}:`);
                    for (const name of names) console.log(`    ${name}`);
                }
            }
        } else {
            const parts = [];
            if (bareInitial.length) parts.push(`${bareInitial.length} bare-initial`);
            if (similar.size) parts.push(`${similar.size} similar-name group(s)`);
            console.log(`Advocate name anomalies: ${parts.join(', ')} (use --verbose to list)`);
        }
    }

}

// ── Main (CLI wrapper) ────────────────────────────────────────────────────────

// ── --add: add a featured advocate's cases to cases.json files ────────────

// Normalize an OCR-corrupted volume-number string (e.g. "1o" → "10", "IT" →
// "11", dotless-ı → 1, "g" → "9") and return the integer value.
function _normalizeNomVol(s) {
    const n = parseInt(
        s.replace(/ı/g, '1')  // dotless ı → 1
         .replace(/I/g, '1')       // uppercase I → 1  (IT → 11)
         .replace(/T/g, '1')       // uppercase T → 1
         .replace(/[oO]/g, '0')    // letter o/O → 0   (1o → 10)
         .replace(/g/g, '9'),      // letter g → 9
        10
    );
    return Number.isFinite(n) && n > 0 ? n : null;
}

// Format an ISO date string as "Month D, YYYY".
function _fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    return `${MONTHS[m - 1]} ${d}, ${y}`;
}

// Build a map from lowercased alt_citation (e.g. "8 cranch") → US volume number.
function _buildAltCiteMap() {
    const map = new Map();
    const db = exists(REPORTS_JSON) ? readJson(REPORTS_JSON) : {};
    for (const [key, entry] of Object.entries(db)) {
        if (entry.alt_citation) {
            map.set(entry.alt_citation.toLowerCase(), parseInt(key.slice(1), 10));
        }
    }
    return map;
}

// Parse an index.md file's markdown list items into an array of objects:
//   { lineIdx, indent, prefix, title, usCites[], alreadyLinked }
// 'indent'       = the "  - " list prefix
// 'prefix'       = leading asterisks before the title (e.g. "**")
// 'title'        = the case title text (stripped of asterisks and bracket notes)
// 'usCites'      = resolved US Report citation strings (e.g. "17 U.S. 316")
// 'alreadyLinked'= true if the title is already wrapped in a markdown link
function _parseIndexMdItems(text, altCiteMap) {
    const CITE_RE = /([0-9ıoOiITg]+)\s+(Cranch|Wheaton|Peters|Howard|Black|Wallace|Dallas)\s+(\d+)/gi;

    const lines = text.split('\n');
    const items = [];

    for (let i = 0; i < lines.length; i++) {
        const line      = lines[i];
        const listMatch = /^(\s*-\s+)(.*)/.exec(line);
        if (!listMatch) continue;

        const indent  = listMatch[1];
        const content = listMatch[2];

        // Detect already-linked titles: "**[Title](url)" or "[Title](url)"
        const alreadyLinked = /^\*{0,2}\[/.test(content);

        // Extract leading asterisks
        const prefixMatch = /^(\*+)/.exec(content);
        const prefix      = prefixMatch ? prefixMatch[1] : '';
        const afterPrefix = content.slice(prefix.length);

        // Find where the title ends: first citation or bracket note
        CITE_RE.lastIndex = 0;
        const firstCiteMatch = CITE_RE.exec(afterPrefix);
        CITE_RE.lastIndex = 0;
        const bracketPos = afterPrefix.indexOf('[');
        let titleEnd = afterPrefix.length;
        if (firstCiteMatch && firstCiteMatch.index < titleEnd) titleEnd = firstCiteMatch.index;
        if (bracketPos !== -1 && bracketPos < titleEnd) titleEnd = bracketPos;

        // Strip trailing separators (, space) to get clean title; do NOT strip
        // trailing periods so that abbreviations like "Co." stay intact.
        const rawTitle = afterPrefix.slice(0, titleEnd).replace(/[,\s]+$/, '').trim();
        // Strip any residual bracket note from raw title
        const title = rawTitle.replace(/\s*\[.*$/, '').trim();

        // Collect all resolved usCites from this line
        const usCites = [];
        CITE_RE.lastIndex = 0;
        let m;
        while ((m = CITE_RE.exec(afterPrefix)) !== null) {
            const nomVol = _normalizeNomVol(m[1]);
            if (nomVol == null) continue;
            const lookupKey = `${nomVol} ${m[2].toLowerCase()}`;
            const usVol = altCiteMap.get(lookupKey);
            if (usVol == null) continue;
            usCites.push(`${usVol} U.S. ${m[3]}`);
        }
        CITE_RE.lastIndex = 0;

        items.push({ lineIdx: i, indent, prefix, title, usCites, alreadyLinked });
    }

    return items;
}

// Add an advocate to a case's argument or reargument event, creating the event
// if it doesn't exist yet. Returns true if the case was modified.
function _addAdvocateEvent(c, type, advocateName, source = 'manual') {
    const dateField = c[type];
    if (!dateField) return false;
    const firstDate = dateField.split(',')[0].trim();

    if (!c.events) c.events = [];
    let ev = c.events.find(e => e.type === type);

    if (ev) {
        if ((ev.advocates || []).some(a => a.name === advocateName)) return false;
        if (!ev.advocates) ev.advocates = [];
        ev.advocates.push({ name: advocateName });
        const idx = c.events.indexOf(ev);
        c.events[idx] = reorderEvent(ev);
        return true;
    }

    const label = type === 'reargument' ? 'Reargument' : 'Argument';
    const newEv = reorderEvent({
        source,
        type,
        date: firstDate,
        title: `Oral ${label} on ${_fmtDate(firstDate)}`,
        advocates: [{ name: advocateName }],
    });
    c.events.push(newEv);
    // Keep events sorted by date.
    c.events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    return true;
}

// Process "--add NAME": find the featured folder for NAME, parse its index.md,
// resolve every nominative citation to a usCite, then add advocate events to
// the matching cases in the terms/ tree.  Also rewrites index.md to wrap each
// matched case title in a markdown link.
async function addFeaturedAdvocate(name, { verbose = false } = {}) {
    if (!name) {
        console.error('--add requires a name argument, e.g. --add "DANIEL WEBSTER"');
        process.exit(1);
    }

    const advocateName = name.trim().toUpperCase();
    const folderKey    = advocateName.toLowerCase().replace(/\s+/g, '_');
    const featuredDir  = path.join(FEATURED_DIR, folderKey);
    const indexMdPath  = path.join(featuredDir, 'index.md');

    if (!exists(indexMdPath)) {
        console.error(`index.md not found: ${relRepo(indexMdPath)}`);
        process.exit(1);
    }

    console.log(`Adding advocate: ${advocateName}`);

    const indexMdText = readText(indexMdPath);
    const sourceMatch = /Source\s+ID:\s*`(\S+)`/i.exec(indexMdText)
                     || /^Source:\s*(\S+)/mi.exec(indexMdText);
    const source      = sourceMatch ? sourceMatch[1] : 'manual';
    if (sourceMatch) console.log(`Source: ${source}`);

    const altCiteMap = _buildAltCiteMap();
    const items      = _parseIndexMdItems(indexMdText, altCiteMap);
    console.log(`Parsed ${items.length} list items from ${relRepo(indexMdPath)}`);

    // Build usCite → [{term, casesPath, caseIdx, caseId, caseTitle}] index and
    // normalized title → [{…}] index across all terms.
    const usCiteIndex = new Map();
    const titleIndex  = new Map();
    for (const termDir of listSubdirs(TERMS_DIR)) {
        const casesPath = path.join(termDir, 'cases.json');
        if (!exists(casesPath)) continue;
        const cases = readJson(casesPath);
        const term  = path.basename(termDir);
        for (let i = 0; i < cases.length; i++) {
            const c         = cases[i];
            const caseId    = String(c.id || '').trim();
            const caseTitle = String(c.title || '').split('|')[0].trim();
            const entry     = { term, casesPath, caseIdx: i, caseId, caseTitle };
            const cite      = c.usCite;
            if (cite) {
                if (!usCiteIndex.has(cite)) usCiteIndex.set(cite, []);
                usCiteIndex.get(cite).push({ ...entry, usCite: cite });
            }
            if (caseTitle) {
                const norm = caseTitle.toLowerCase().replace(/\s+/g, ' ');
                if (!titleIndex.has(norm)) titleIndex.set(norm, []);
                titleIndex.get(norm).push({ ...entry, usCite: cite });
            }
        }
    }

    // For each list item, match by citation first, then by title.
    const pending   = new Map();  // casesPath → Set<caseIdx>
    const lineLinks = new Map();  // lineIdx → url (for index.md link insertion)
    let matched = 0, notFound = 0;

    for (const item of items) {
        let primaryHit  = null;
        let matchMethod = null;

        // ── Citation match ──────────────────────────────────────────────────
        for (const usCite of item.usCites) {
            const hits = usCiteIndex.get(usCite);
            if (!hits?.length) {
                console.log(`  NOT FOUND: ${usCite}  («${item.title}»)`);
                notFound++;
                continue;
            }
            if (!primaryHit) {
                primaryHit  = hits[0];
                matchMethod = 'citation';
            }
            matched++;
            for (const { casesPath, caseIdx } of hits) {
                if (!pending.has(casesPath)) pending.set(casesPath, new Set());
                pending.get(casesPath).add(caseIdx);
            }
        }

        // ── Title match (fallback when no citation produced a hit) ──────────
        if (!primaryHit && item.title) {
            const norm      = item.title.toLowerCase().replace(/\s+/g, ' ');
            const titleHits = titleIndex.get(norm);
            if (titleHits?.length) {
                primaryHit  = titleHits[0];
                matchMethod = 'title';
                for (const { casesPath, caseIdx } of titleHits) {
                    if (!pending.has(casesPath)) pending.set(casesPath, new Set());
                    pending.get(casesPath).add(caseIdx);
                }
                // Verify there is also a citation match when matched by title.
                const hitCites  = titleHits.map(h => h.usCite).filter(Boolean);
                const confirmed = item.usCites.some(u => hitCites.includes(u));
                if (!confirmed) {
                    console.log(`  WARNING [title match, no citation confirm]: «${item.title}» → ${primaryHit.term}/${primaryHit.caseId}`);
                }
                matched++;
            }
        }

        // ── Warn on title mismatch when matched by citation ─────────────────
        if (primaryHit && matchMethod === 'citation' && item.title) {
            const normOur  = primaryHit.caseTitle.toLowerCase().replace(/\s+/g, ' ');
            const normItem = item.title.toLowerCase().replace(/\s+/g, ' ');
            if (normOur !== normItem) {
                console.log(`  WARNING [title mismatch]: «${item.title}» → «${primaryHit.caseTitle}» (${primaryHit.term}/${primaryHit.caseId})`);
            }
        }

        // ── Record link for index.md update ────────────────────────────────
        if (primaryHit && !item.alreadyLinked) {
            lineLinks.set(item.lineIdx, `/courts/ussc?term=${primaryHit.term}&case=${primaryHit.caseId}`);
        }
    }
    console.log(`Matched: ${matched}  Not found: ${notFound}`);

    // Apply event updates, one cases.json at a time.
    let filesChanged = 0;
    for (const [casesPath, indices] of pending) {
        const cases  = readJson(casesPath);
        let changed  = false;
        for (const idx of indices) {
            const c  = cases[idx];
            let mod  = false;
            for (const type of ['argument', 'reargument']) {
                if (_addAdvocateEvent(c, type, advocateName, source)) mod = true;
            }
            if (mod) {
                cases[idx] = reorderCase(c);
                changed = true;
                if (verbose) console.log(`  ${c.usCite}  ${relRepo(casesPath)}`);
            }
        }
        if (changed) {
            writeJson(casesPath, cases);
            filesChanged++;
            console.log(`  wrote ${relRepo(casesPath)}`);
        }
    }
    console.log(`Done — updated ${filesChanged} cases.json file(s)`);

    // Rewrite index.md, wrapping matched case titles in markdown links.
    if (lineLinks.size > 0) {
        const lines = indexMdText.split('\n');
        for (const [lineIdx, url] of lineLinks) {
            const item = items.find(it => it.lineIdx === lineIdx);
            if (!item) continue;
            const afterPrefix = lines[lineIdx].slice(item.indent.length + item.prefix.length);
            lines[lineIdx] = item.indent + item.prefix
                + `[${item.title}](${url})`
                + afterPrefix.slice(item.title.length);
        }
        writeText(indexMdPath, lines.join('\n'));
        console.log(`Updated ${lineLinks.size} link(s) in ${relRepo(indexMdPath)}`);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const verbose       = argv.includes('--verbose') || argv.includes('-v');
    const showWomen     = argv.includes('--women');
    const markdownMode  = argv.includes('--markdown');

    const addIdx      = argv.indexOf('--add');
    if (addIdx !== -1) {
        await addFeaturedAdvocate((argv[addIdx + 1] || '').trim(), { verbose });
        return;
    }

    const termArg     = argv.find(a => /^\d{4}-\d{2}$/.test(a));
    const replaceIdx  = argv.indexOf('--replace');
    const replaceMode = replaceIdx !== -1;
    const replaceOld  = replaceMode ? (argv[replaceIdx + 1] || '').trim() : '';
    const replaceNew  = replaceMode ? (argv[replaceIdx + 2] || '').trim() : '';

    if (termArg) {
        if (replaceMode) {
            applyReplace(termArg, replaceOld.toUpperCase(), replaceNew.toUpperCase());
            return;
        } else {
            const speakerIssues = checkAndFixTranscriptSpeakers(termArg, { verbose });
            const result = await checkAndFixSingleNames(termArg, { verbose });
            if (result === 'clean' && !speakerIssues) {
                console.log(`No problems found in term ${termArg}`);
                return;
            }
            if (speakerIssues) {
                console.log('\nSkipping advocate file updates due to speaker mismatches.');
                return;
            }
            if (!result) {
                console.log('\nSkipping advocate file updates due to unresolved single-name advocates.');
                return;
            }
        }
    }

    const dirs = listSubdirs(TERMS_DIR);
    if (dirs.length === 0) {
        console.error(`No term directories found under ${TERMS_DIR}`);
        process.exit(1);
    }
    await syncAdvocates(dirs, { verbose, showWomen, markdownMode });
}

const _isMain = (() => {
    try { return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); }
    catch { return false; }
})();

if (_isMain) {
    main().catch(err => { console.error(err); process.exit(1); });
}
