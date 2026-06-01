#!/usr/bin/env node
/**
 * Builds/updates courts/ussc/people/advocates/all_advocates.json (index),
 * courts/ussc/people/advocates/top_advocates.json (top 100 by case count), and
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
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Paths ──────────────────────────────────────────────────────────────────

const REPO_ROOT         = path.resolve(__dirname, '..');
const TERMS_DIR         = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const ADVOCATES_BASE    = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'advocates');
const OUTPUT_FILE       = path.join(ADVOCATES_BASE, 'all_advocates.json');
const TOP_OUTPUT_FILE   = path.join(ADVOCATES_BASE, 'top', 'top_advocates.json');
const WOMEN_OUTPUT_FILE = path.join(ADVOCATES_BASE, 'women', 'women_advocates.json');
const WOMEN_CSV_FILE    = path.join(REPO_ROOT, 'data', 'aa', 'ussc_women.csv');
const TRANS_OUTPUT_FILE = path.join(ADVOCATES_BASE, 'transgender', 'transgender_advocates.json');
const ADVOCATES_DIR     = path.join(ADVOCATES_BASE, 'all');
const FEATURED_DIR      = path.join(ADVOCATES_BASE, 'featured');
const JUSTICES_README   = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices', 'README.md');
const JUSTICE_ADVOCATES_FILE = path.join(ADVOCATES_BASE, 'justices', 'justice_advocates.json');
const JOURNALS_DIR      = path.join(REPO_ROOT, 'courts', 'ussc', 'journals', 'text');
const _SPEAKERS_FILE    = path.join(REPO_ROOT, 'data', 'ussc', 'speakers.json');

// ── Small helpers ──────────────────────────────────────────────────────────

/** Return the first pipe-delimited component of a case title for display. */
const firstTitle = (s) => { if (!s) return s; const i = s.indexOf('|'); return i === -1 ? s : s.slice(0, i); };

const exists    = (p) => fs.existsSync(p);
const readText  = (p) => fs.readFileSync(p, 'utf8');
const writeText = (p, s) => fs.writeFileSync(p, s, 'utf8');
const readJson  = (p) => JSON.parse(readText(p));
const writeJson = (p, d) => { const s = JSON.stringify(d, null, 2) + '\n'; if (exists(p) && readText(p) === s) return; writeText(p, s); };
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const unlinkSafe = (p) => { try { fs.unlinkSync(p); } catch {} };

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
// purpose of choosing the family (cert/appeal/civil).
function summarizeResult(fullResult, role) {
    if (!fullResult) return '';
    const r = (role || '').replace(/\*$/, '').toLowerCase();
    let family = 'cert';            // petitioner / respondent
    if (r === 'appellant' || r === 'appellee')      family = 'appeal';
    else if (r === 'plaintiff' || r === 'defendant') family = 'civil';
    const won = fullResult === 'petitioning party received a favorable disposition';
    const lost = fullResult === 'no favorable disposition for petitioning party apparent';
    if (!won && !lost) return '';
    if (family === 'appeal') return won ? 'appellant' : 'appellee';
    if (family === 'civil')  return won ? 'plaintiff' : 'defendant';
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

// ── Justice longest-name map (justices.json) ───────────────────────────────
// Maps every multi-word form of a justice's name to the longest multi-word
// form so that advocates who were also justices get stored under their full
// name (e.g. "JOHN ROBERTS" → "JOHN G. ROBERTS, JR.").

function loadJusticeCanonicalNames(p) {
    const map = {};
    if (!exists(p)) return map;
    let data;
    try { data = readJson(p); } catch { return map; }
    for (const [key, entry] of Object.entries(data)) {
        const allForms = [key, ...(entry.alternates || [])];
        // Keep only multi-word forms; single-word entries are typos handled by speakers.json.
        const multiWord = allForms.filter(n => /\s/.test(n.trim()));
        if (multiWord.length <= 1) continue; // canonical key is already the only/longest multi-word form
        const longest = multiWord.reduce((a, b) => a.length >= b.length ? a : b);
        const longestUpper = longest.trim().toUpperCase();
        for (const form of multiWord) {
            const upper = form.trim().toUpperCase();
            if (upper !== longestUpper) map[upper] = longestUpper;
        }
    }
    return map;
}
const JUSTICE_LONGEST_NAME = loadJusticeCanonicalNames(path.join(REPO_ROOT, 'data', 'ussc', 'justices.json'));

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
    // Remove punctuation except hyphens, then collapse whitespace/-/_ to single _.
    const noPunct = ascii.replace(/[^\w\s-]/g, '');
    return noPunct.replace(/[\s\-_]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── Suffix normalisation ───────────────────────────────────────────────────

const _SUFFIX_JR_SR_RE = /,?\s+(JR|SR)\.?\s*$/i;
const _SUFFIX_ROMAN_RE = /,?\s+(II|III|IV)\s*$/i;

function normalizeNameSuffix(name) {
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

// ── Justice-advocates sync (from courts/ussc/people/justices/README.md) ────

const _JM_HEADING_RE  = /^## ((?:CHIEF )?JUSTICE .+)$/;
const _JM_OYEZ_URL_RE = /https:\/\/www\.oyez\.org\/cases\/(\d{4})\/([^\s)]+)/g;
const _JM_LOC_RE      = /https:\/\/tile\.loc\.gov\/[^)]+\/usrep(\d+)\/usrep\d+(\d{3})\/[^)]+\.pdf/;
const _JM_OYEZ_MULTI_RE = /https:\/\/www\.oyez\.org\/cases\/\d{4}-\d{4}\/(\d+)us(\d+)/;
const _JM_JUSTIA_RE   = /https:\/\/supreme\.justia\.com\/cases\/federal\/us\/(\d+)\/(\d+)\//;
const _JM_CASE_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
const _JM_SUFFIX_RE   = /,?\s+(?:JR|SR|II|III|IV)\.?$/i;
const _JM_YEAR_SUFFIX_RE = /\s+\((\d{4})\)$/;
const _JM_MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December',
                    'Jan','Feb','Mar','Apr','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const _JM_MONTHS_PAT = _JM_MONTHS.join('|');
const _JM_ARGUED_DATE_RE = new RegExp(
    '(?:[Aa]rgued\\s+)?((?:' + _JM_MONTHS_PAT + ')\\s+\\d+' +
    '(?:\\s*[\\-\\u2013]\\s*(?:\\d+|(?:' + _JM_MONTHS_PAT + ')\\s+\\d+))?' +
    '(?:\\s+and\\s+\\d+)?' +
    ',\\s*\\d{4})',
    'i',
);

function _jmDecodeEntities(s) {
    return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function _jmDisplayName(upper) {
    return upper.toUpperCase();
}

function _jmParseHeading(heading) {
    let prefix, fullName;
    if (heading.startsWith('CHIEF JUSTICE ')) {
        prefix = 'CHIEF JUSTICE';
        fullName = heading.slice('CHIEF JUSTICE '.length).trim();
    } else {
        prefix = 'JUSTICE';
        fullName = heading.slice('JUSTICE '.length).trim();
    }
    return { prefix, fullName, displayName: _jmDisplayName(fullName) };
}

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

function _jmOyezTermCase(url) {
    const m = url.match(/https:\/\/www\.oyez\.org\/cases\/(\d{4})\/([^\s)]+)/);
    if (!m) return null;
    const year = m[1];
    let cs = m[2].replace(/_([a-z])/g, (_, c) => '-' + c.toUpperCase());
    return [`${year}-10`, cs];
}

function _jmVolPageFromUrl(url) {
    for (const re of [_JM_LOC_RE, _JM_OYEZ_MULTI_RE, _JM_JUSTIA_RE]) {
        const m = url.match(re);
        if (m) return [String(parseInt(m[1], 10)), String(parseInt(m[2], 10))];
    }
    return null;
}

function _jmParseFirstArgDateIso(note) {
    if (!note) return null;
    const m = note.match(_JM_ARGUED_DATE_RE);
    if (!m) return null;
    let raw = m[1];
    raw = raw.replace(
        new RegExp('(\\d+)\\s*[\\-\\u2013]\\s*(?:\\d+|(?:' + _JM_MONTHS_PAT + ')\\s+\\d+)', 'i'),
        '$1');
    raw = raw.replace(/(\d+)\s+and\s+\d+/, '$1');
    raw = raw.trim().replace(/^,/, '').trim();
    const dm = raw.match(/^(\w+)\s+(\d+),\s*(\d{4})$/);
    if (!dm) return null;
    const mi = _JM_MONTHS.indexOf(dm[1]);
    if (mi === -1) return null;
    const monthIdx = (mi % 12) + 1;
    return `${dm[3]}-${String(monthIdx).padStart(2, '0')}-${String(parseInt(dm[2], 10)).padStart(2, '0')}`;
}

/** Walk justices README for [{ displayName, cases:[{name, url, note}] }]. */
function _jmLoadJustices() {
    if (!exists(JUSTICES_README)) return [];
    const text = readText(JUSTICES_README);
    const out = [];
    let cur = null;
    let inCases = false;
    for (const line of text.split('\n')) {
        const hm = line.match(_JM_HEADING_RE);
        if (hm) {
            if (cur) out.push(cur);
            cur = { ..._jmParseHeading(hm[1].trim()), cases: [] };
            inCases = false;
        } else if (cur) {
            if (line.trim() === '### Cases Argued') inCases = true;
            else if (inCases) {
                const lm = line.match(_JM_CASE_LINK_RE);
                if (lm) {
                    const note = line.slice(line.indexOf(lm[0]) + lm[0].length).trim();
                    cur.cases.push({
                        name: _jmDecodeEntities(lm[1].trim()),
                        url:  lm[2].trim(),
                        note,
                    });
                }
            }
        }
    }
    if (cur) out.push(cur);
    return out;
}

/** Pick the best argument event index (1-based into events[]). */
function _jmBestEventIndex(events, isoDate, forcedPosition) {
    const argTypes = new Set(['argument', 'reargument']);
    const argIdxs = [];
    for (let i = 0; i < (events || []).length; i++) {
        if (argTypes.has(events[i].type)) argIdxs.push(i);
    }
    if (argIdxs.length === 0) return null;
    if (forcedPosition) {
        const i = forcedPosition - 1;
        if (i >= 0 && i < argIdxs.length) return argIdxs[i] + 1;
        return argIdxs[0] + 1;
    }
    let cands = argIdxs;
    if (isoDate) {
        const dm = argIdxs.filter(i => events[i].date === isoDate);
        if (dm.length) cands = dm;
    }
    const aligned = cands.filter(i => events[i].aligned);
    if (aligned.length) return aligned[0] + 1;
    const withAudio = cands.filter(i => events[i].audio_href);
    if (withAudio.length) return withAudio[0] + 1;
    return cands[0] + 1;
}

function _jmEventDateForIndex(events, idx) {
    if (!events || !idx || idx < 1 || idx > events.length) return null;
    return events[idx - 1].date || null;
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
            byKey.set(`${term}/${number}`, c);
            const cite = String(c.usCite || '').trim();
            if (cite) byUsCite.set(cite, [term, String(c.number || '')]);
            const title = firstTitle(String(c.title || '').trim());
            if (title) {
                if (!byTitle.has(title)) byTitle.set(title, []);
                byTitle.get(title).push([term, number]);
            }
        }
    }
    return { byKey, byUsCite, byTitle };
}

function syncJusticeAdvocates(termDirs, { verbose = false } = {}) {
    if (exists(JUSTICE_ADVOCATES_FILE)) return;
    if (verbose) console.log('\n── Building justice_advocates.json ──');
    const justices = _jmLoadJustices();
    if (!justices.length) {
        console.log(`  No justices loaded from ${relRepo(JUSTICES_README)}`);
        return;
    }

    const { byKey, byUsCite, byTitle } = _jmBuildCaseIndices(termDirs);

    let coll = [];
    if (exists(JUSTICE_ADVOCATES_FILE)) {
        try { coll = readJson(JUSTICE_ADVOCATES_FILE); } catch { coll = []; }
    }
    if (!Array.isArray(coll)) coll = [];

    const groupsByName = new Map(coll.map(g => [g.name, g]));
    let totalAdded = 0;

    for (const j of justices) {
        const disp = j.displayName;
        const justiceUpper = (j.fullName || disp).toUpperCase();

        // Resolve each markdown case to one or more {name, term, number, type, dates}
        // entries. The split between argument vs. reargument (and the dates kept
        // for each) comes from the case's events[]: every argument/reargument
        // event whose advocates list names this justice contributes its date.
        const mdCases = [];
        for (const c of j.cases) {
            let term, number;
            const tc = _jmOyezTermCase(c.url);
            if (tc) {
                term = tc[0];
                number = _jmNormalizeCaseNumber(tc[1]);
            } else {
                const vp = _jmVolPageFromUrl(c.url);
                if (!vp) continue;
                const cite = `${vp[0]} U.S. ${vp[1]}`;
                const hit = byUsCite.get(cite);
                if (!hit) {
                    console.log(`  [${disp}] WARN: no local case for ${cite} (${c.name})`);
                    continue;
                }
                term = hit[0];
                number = _jmNormalizeCaseNumber(hit[1]);
            }

            // If the (term, number) doesn't resolve, or resolves to a case
            // whose title doesn't match the README's, try to find the case by
            // title. Required for cases where the README's oyez URL points at
            // a different term than where the case actually lives (e.g. the
            // 1958-08 special-session cases referenced via /cases/1958/1) or
            // to a different case entirely (oyez sometimes reuses a docket).
            const stripped = c.name.replace(_JM_YEAR_SUFFIX_RE, '').trim();
            const resolved = byKey.get(`${term}/${number}`);
            if (!resolved || (resolved.title || '') !== stripped) {
                const hits = byTitle.get(stripped) || [];
                if (hits.length === 1) {
                    [term, number] = hits[0];
                } else if (hits.length > 1) {
                    // Prefer a hit whose term year matches the README's year suffix.
                    const ym = c.name.match(_JM_YEAR_SUFFIX_RE);
                    const wantedYear = ym ? ym[1] : null;
                    const liveHit = hits
                        .map(([t, n]) => [t, n, byKey.get(`${t}/${n}`)])
                        .find(([, , l]) => l && wantedYear
                              && (l.decision || '').slice(0, 4) === wantedYear);
                    if (liveHit) [term, number] = [liveHit[0], liveHit[1]];
                    else         [term, number] = hits[0];
                }
            }
            const live = byKey.get(`${term}/${number}`);
            const events = (live && live.events) || [];
            const termDir = path.join(TERMS_DIR, term);
            const justiceKey = _jmNameKey(justiceUpper);
            const datesByType = { argument: [], reargument: [] };
            const eventsByType = { argument: [], reargument: [] };
            for (let i = 0; i < events.length; i++) {
                const ev = events[i];
                if (!ev || (ev.type !== 'argument' && ev.type !== 'reargument')) continue;
                let matched = (ev.advocates || []).some(a => {
                    const n = (typeof a === 'object' && a !== null) ? a.name : a;
                    return typeof n === 'string' && _jmNameKey(n) === justiceKey;
                });
                // Fall back to scanning the transcript's media.speakers for
                // cases where events[].advocates is empty (e.g. older imports).
                if (!matched && ev.text_href) {
                    const tp = path.join(termDir, 'cases', ev.text_href);
                    if (exists(tp)) {
                        try {
                            const tj = readJson(tp);
                            for (const sp of tj?.media?.speakers || []) {
                                if (_JUSTICE_SPEAKER_TITLES.has(sp.title || '')) continue;
                                if (_jmNameKey(sp.name || '') === justiceKey) {
                                    matched = true; break;
                                }
                            }
                        } catch { /* ignore */ }
                    }
                }
                if (!matched || !ev.date) continue;
                const bucket = datesByType[ev.type];
                if (!bucket.includes(ev.date)) bucket.push(ev.date);
                eventsByType[ev.type].push(i);
            }
            for (const t of ['argument', 'reargument']) datesByType[t].sort();

            // Pick the best event index (1-based) per type: prefer aligned,
            // then audio_href, else the first matched event.
            const bestEventIdx = {};
            for (const t of ['argument', 'reargument']) {
                const idxs = eventsByType[t];
                if (!idxs.length) continue;
                const aligned   = idxs.filter(i => events[i].aligned);
                const withAudio = idxs.filter(i => events[i].audio_href);
                bestEventIdx[t] = (aligned[0] ?? withAudio[0] ?? idxs[0]) + 1;
            }

            const haveAny = datesByType.argument.length || datesByType.reargument.length;
            if (haveAny) {
                for (const t of ['argument', 'reargument']) {
                    if (datesByType[t].length) {
                        mdCases.push({
                            name: c.name, term, number: String(number),
                            type: t, dates: datesByType[t],
                            event: bestEventIdx[t] ?? null,
                        });
                    }
                }
            } else {
                // No events list this justice — fall back to a single
                // argument-typed entry using the case-level argument date.
                mdCases.push({
                    name: c.name, term, number: String(number),
                    type: 'argument',
                    dates: live && live.argument ? [live.argument] : [],
                    event: events.length ? 1 : null,
                });
            }
        }
        if (!mdCases.length) continue;

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
        const existing = group.cases || [];

        // A "slot" is keyed by (term, number, type). Existing entries are
        // classified by which date field they carry (reargument vs. argument).
        const slotKey = (term, number, type) =>
            `${term}/${_jmNormalizeCaseNumber(String(number))}#${type}`;
        const existingType = (e) => (e && 'reargument' in e) ? 'reargument' : 'argument';

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
                delete entry.audio;    delete entry.opinion_href;
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
            // Verify opinion_href if both present.
            if (live.opinion_href && entry.opinion_href && live.opinion_href !== entry.opinion_href) {
                console.log(`  WARNING: opinion_href mismatch for ${lookupKey}`);
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

    // Sort groups by last name, stripping generational suffixes.
    coll.sort((a, b) => {
        const aLast = (a.name || '').replace(_JM_SUFFIX_RE, '').trim().split(/\s+/).pop() || '';
        const bLast = (b.name || '').replace(_JM_SUFFIX_RE, '').trim().split(/\s+/).pop() || '';
        return aLast < bLast ? -1 : aLast > bLast ? 1 : 0;
    });

    const newJson = JSON.stringify(coll, null, 2) + '\n';
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
                // Every event advocate should be a participating transcript speaker
                for (const name of advNames) {
                    if (name === 'UNKNOWN JUSTICE' || name === 'UNKNOWN SPEAKER') continue;
                    const inTranscript = speakers.some(sp => (sp.name || '').toUpperCase() === name);
                    const participating = inTranscript && !isNP(speakers.find(sp => (sp.name || '').toUpperCase() === name));
                    if (!inTranscript) {
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);
    const verbose       = argv.includes('--verbose') || argv.includes('-v');
    const showWomen     = argv.includes('--women');
    const markdownMode  = argv.includes('--markdown');

    // ── Term-specific single-name advocate fix ────────────────────────────
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

    const termDirs = listSubdirs(TERMS_DIR);
    if (termDirs.length === 0) {
        console.error(`No term directories found under ${TERMS_DIR}`);
        process.exit(1);
    }

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
                    // Normalize justice names to their longest known form so advocates
                    // who were also justices are stored under their full name.
                    const justiceCanonical = JUSTICE_LONGEST_NAME[nameKey];
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
                    const caseEntry = {
                        title,
                        term,
                        number: subKey || number,
                        [dateFieldName]: audioDate,
                    };
                    // Internal-only: original consolidated number (used for
                    // citation lookup, dedup, and URL building); stripped
                    // before the case entry is serialized to disk.
                    if (subKey) Object.defineProperty(caseEntry, '_fullNumber', { value: number, enumerable: false });
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
                    const fileCount = c.files || 0;
                    if (fileCount) caseEntry.files = fileCount;
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

    // Output sorted by cases (descending) then last name.
    const _advLastName = (name) => (name || '').replace(_JM_SUFFIX_RE, '').trim().split(/\s+/).pop() || '';
    let output = Object.values(advocates)
        .filter(e => e.cases.length > 0)
        .sort((a, b) => {
            const ca = a.cases.length, cb = b.cases.length;
            if (ca !== cb) return cb - ca;
            const la = _advLastName(a.name), lb = _advLastName(b.name);
            return la < lb ? -1 : la > lb ? 1 : 0;
        });

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
        let existingDetails = {};
        let existingHighlights = [];
        if (exists(caseFile)) {
            try {
                const raw = readJson(caseFile);
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    existingDetails = raw.details || {};
                    existingHighlights = raw.highlights || [];
                }
            } catch { /* ignore */ }
        }
        // Auto-derive page link from featured folder if an index.md exists there.
        const featuredDir = path.join(FEATURED_DIR, advId);
        const featuredLink = exists(path.join(featuredDir, 'index.md'))
            ? '/courts/ussc/people/advocates/featured/' + advId
            : null;
        // featuredLink takes precedence; fall back to whatever is already in details.page.
        const resolvedLink = featuredLink ?? existingDetails.page ?? null;
        const mergedDetails = { ...existingDetails };
        if (resolvedLink != null) mergedDetails.page = resolvedLink;
        else delete mergedDetails.page;
        const envelope = {
            details: mergedDetails,
            highlights: existingHighlights,
        };
        if (entry.previously) {
            envelope.previously = [...new Set(entry.previously)].sort();
        }
        // Assign entry numbers (1 = earliest argument, N = most recent) and
        // insert after `event` in the key order.
        const total = entry.cases.length;
        envelope.cases = entry.cases.map((c, i) => {
            const entryNum = total - i; // cases are sorted most-recent-first
            const rebuilt = {};
            for (const k of Object.keys(c)) {
                rebuilt[k] = c[k];
                if (k === 'event') rebuilt.entry = entryNum;
            }
            if (!('entry' in rebuilt)) rebuilt.entry = entryNum;
            return rebuilt;
        });
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
    ensureDir(path.dirname(OUTPUT_FILE));
    writeJson(OUTPUT_FILE, index);
    console.log(`Wrote ${output.length} advocates to ${relRepo(OUTPUT_FILE)} and ${relRepo(ADVOCATES_DIR)}/`);

    // Top 100 advocates index.
    const topIndex = index.slice(0, 100);
    writeJson(TOP_OUTPUT_FILE, topIndex);
    console.log(`Wrote ${topIndex.length} advocates to ${relRepo(TOP_OUTPUT_FILE)}`);

    // Women advocates index.
    const womenIndex = index.filter(e => nameFeminine.get(e.name.toUpperCase()));
    writeJson(WOMEN_OUTPUT_FILE, womenIndex);
    console.log(`Wrote ${womenIndex.length} women advocates to ${relRepo(WOMEN_OUTPUT_FILE)}`);

    // Transgender advocates index (anyone whose transcript speaker entry
    // carries a 'transgender' tag).
    const transIndex = index.filter(e => {
        const tags = nameTags.get(e.name.toUpperCase());
        return tags && tags.has('transgender');
    });
    writeJson(TRANS_OUTPUT_FILE, transIndex);
    console.log(`Wrote ${transIndex.length} transgender advocates to ${relRepo(TRANS_OUTPUT_FILE)}`);

    // ── ussc_women.csv ──────────────────────────────────────────
    let womenRows = [];
    for (const [nameUpper, entry] of Object.entries(advocates)) {
        if (!nameFeminine.get(nameUpper)) continue;
        if (entry.name.split(/\s+/).length <= 1) continue;
        const advName = entry.name;
        const sortedCases = entry.cases.slice().sort((a, b) =>
            (a.argument || a.reargument || '') < (b.argument || b.reargument || '') ? -1
            : (a.argument || a.reargument || '') > (b.argument || b.reargument || '') ? 1 : 0);
        let argNum = 0;
        for (const c of sortedCases) {
            argNum++;
            const fullNum = c._fullNumber || c.number;
            const cit = caseCitation.get(ckCite(firstTitle(c.title), c.term, fullNum)) || '';
            const audioIdx = c.audio;
            let url = `https://argumentaloud.org/courts/ussc/?term=${c.term}&case=${fullNum.replace(/,/g, '%2C')}`;
            if (audioIdx) url += `&event=${audioIdx}`;
            const caseKey = ckCase(nameUpper, firstTitle(c.title), c.term, fullNum);
            let allDates = [];
            const anchor = c.argument || c.reargument || '';
            if (!Number.isNaN(isoToDays(anchor))) {
                const dates = [...(allAppearanceDates.get(caseKey) || [])]
                    .filter(d => daysAbsDiff(d, anchor) <= 7)
                    .sort();
                allDates = dates;
            }
            const argDate = allDates.length ? allDates.join(',') : (c.argument || c.reargument || '');
            womenRows.push([advName, argNum, argDate, c.term, c.number, firstTitle(c.title), cit, url]);
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
            .filter(r => (r['Advocate No.'] || '').trim() !== '-1')
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
            const refFullUpper = normalizeName(r['Advocate Name'] || '').toUpperCase();
            const aliasUpper = NAME_ALIASES[`${r._first} ${r._last}`] || NAME_ALIASES[refFullUpper];
            if (aliasUpper) {
                const [af, al] = nameParts(aliasUpper);
                if (`${af}|${al}` !== `${r._first}|${r._last}`) addLookup(`${af}|${al}`, r);
            }
        }

        const refMatched = new Set();
        const updatedRows = [];
        const ourUnmatched = [];
        for (const row of womenRows) {
            const [advName, argNum, argDate, term, caseNum, title, cit, url] = row;
            const [first, last] = nameParts(advName);
            const candidates = refNameLookup.get(`${first}|${last}`) || [];
            const ourDates = new Set(argDate.split(','));
            const dateMatches = candidates.filter(r => [...ourDates].some(d => r._iso_set.has(d)));
            const matchedRef = dateMatches[0] || null;
            if (matchedRef) {
                for (const r of dateMatches) refMatched.add(r);
                let canonical = (matchedRef['Advocate Name'] || '')
                    .replace(_FORMERLY_RE, '')
                    .replace(_ORDINAL_RE, '')
                    .split(',')[0].trim();
                updatedRows.push([canonical, argNum, argDate, term, caseNum, title, cit, url]);
            } else {
                updatedRows.push(row);
                ourUnmatched.push(row);
            }
        }
        womenRows = updatedRows;

        const refUnmatched = refRows.filter(r =>
            !refMatched.has(r) && r._iso_set.size > 0 &&
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
                    const [advName, , argDate, term, caseNum, title] = row;
                    const advId = makeAdvocateId(advName);
                    const advUrl = `https://argumentaloud.org/courts/ussc/?collection=women_advocates&id=${advId}`;
                    const caseNumUrl = caseNum.replace(/,/g, '%2C');
                    const caseUrl = `https://argumentaloud.org/courts/ussc/?term=${term}&case=${caseNumUrl}`;
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
        'Term', 'Case Number', 'Case Title', 'Citation', 'URL'];
    writeText(WOMEN_CSV_FILE, writeCsvNonnumeric(csvHeaders, womenRows));
    console.log(`Wrote ${womenRows.length} rows to ${relRepo(WOMEN_CSV_FILE)}`);

    // ── Justice-advocates collection sync ────────────────────────────────
    syncJusticeAdvocates(termDirs, { verbose });

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
            !caseFeminineSeen.get(ckCase(nameUpper, firstTitle(c.title), c.term, c._fullNumber || c.number))
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

main().catch(err => {
    console.error(err);
    process.exit(1);
});
