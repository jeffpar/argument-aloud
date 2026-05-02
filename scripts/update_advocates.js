#!/usr/bin/env node
/**
 * Builds/updates courts/ussc/people/all_advocates.json (index) and
 * courts/ussc/people/advocates/{id}.json (per-advocate case lists) from
 * transcript files.
 *
 * For every case in every cases.json under courts/ussc/terms/, follows each
 * audio entry's text_href to its transcript file, extracts speakers whose role
 * is "advocate", and records which case/date they appeared in.
 *
 * JS port of scripts/python/update_advocates.py — see that file for full
 * documentation. Behaviour and outputs (advocates index, per-advocate JSON,
 * women_advocates.json, ussc_women.csv, anomaly report, --repair
 * interactive flow, --fix one-word repair) are intended to match.
 *
 * Usage:
 *   node scripts/update_advocates.js [--verbose|-v] [--women] [--repair]
 *                                    [--markdown] [--singles] [--fix]
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
const OUTPUT_FILE       = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'all_advocates.json');
const WOMEN_OUTPUT_FILE = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'women_advocates.json');
const WOMEN_CSV_FILE    = path.join(REPO_ROOT, 'data', 'aa', 'ussc_women.csv');
const TRANS_OUTPUT_FILE = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'transgender_advocates.json');
const ADVOCATES_DIR     = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'advocates');
const JUSTICES_README   = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices', 'README.md');
const JUSTICE_ADVOCATES_FILE = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justice_advocates.json');
const SINGLES_FILE      = path.join(REPO_ROOT, 'scripts', 'python', 'singles.txt');
const _SPEAKERS_FILE    = path.join(__dirname, 'speakers.json');

// ── Small helpers ──────────────────────────────────────────────────────────

const exists    = (p) => fs.existsSync(p);
const readText  = (p) => fs.readFileSync(p, 'utf8');
const writeText = (p, s) => fs.writeFileSync(p, s, 'utf8');
const readJson  = (p) => JSON.parse(readText(p));
const writeJson = (p, d) => writeText(p, JSON.stringify(d, null, 2) + '\n');
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

// ── Advocate ID ────────────────────────────────────────────────────────────

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

// ── Repair helpers ─────────────────────────────────────────────────────────

/** Rename advocate names in all transcript JSON files. Returns # files modified. */
function repairRenameInTranscripts(renames) {
    let modified = 0;
    const transcripts = walkFiles(TERMS_DIR, (p) =>
        p.endsWith('.json') && /\/cases\/[^/]+\/[^/]+\.json$/.test(p)
    ).sort();
    for (const tp of transcripts) {
        let data;
        try { data = readJson(tp); } catch { continue; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        let changed = false;
        for (const sp of data?.media?.speakers || []) {
            const newN = renames[(sp.name || '').toUpperCase()];
            if (newN && sp.name !== newN) { sp.name = newN; changed = true; }
        }
        for (const turn of data?.turns || []) {
            const newN = renames[(turn.name || '').toUpperCase()];
            if (newN && turn.name !== newN) { turn.name = newN; changed = true; }
        }
        if (changed) {
            writeText(tp, JSON.stringify(data, null, 2) + '\n');
            modified++;
        }
    }
    return modified;
}

function repairUpdateSpeakersJson(renames) {
    if (!exists(_SPEAKERS_FILE)) return;
    const data = readJson(_SPEAKERS_FILE);
    const aliases = (data.alias = data.alias || {});
    for (const [oldUpper, newName] of Object.entries(renames)) {
        const newUpper = newName.toUpperCase();
        if (oldUpper !== newUpper) aliases[oldUpper] = newUpper;
    }
    writeText(_SPEAKERS_FILE, JSON.stringify(data, null, 2) + '\n');
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
            const title = String(c.title || '').trim();
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
            entry.title  = cleanTitle;
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);
    const verbose       = argv.includes('--verbose') || argv.includes('-v');
    const showWomen     = argv.includes('--women');
    const repairMode    = argv.includes('--repair');
    const markdownMode  = argv.includes('--markdown');
    const singlesMode   = argv.includes('--singles');
    const fixMode       = argv.includes('--fix');

    const termDirs = listSubdirs(TERMS_DIR);
    if (termDirs.length === 0) {
        console.error(`No term directories found under ${TERMS_DIR}`);
        process.exit(1);
    }

    const advocates = loadExisting();
    ensureDir(ADVOCATES_DIR);

    /** key: name|title|term|number  -> array of date strings */
    const recordedDates = new Map();
    /** key: name|title|term|number  -> Set<date string> */
    const allAppearanceDates = new Map();
    /** key: name|title|term|number -> bool */
    const caseFeminineSeen = new Map();
    /** name_upper -> bool */
    const nameFeminine = new Map();
    /** name_upper -> Set<tag-lowercase> aggregated across transcripts */
    const nameTags = new Map();
    /** key: title|term|number -> citation */
    const caseCitation = new Map();
    /** name_upper -> Set<transcript_path> */
    const singleNamePaths = new Map();

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
            const title       = c.title || '';
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
            const oyezDates = new Set();
            if (isEarlyTerm) {
                for (const a of audioEntries) {
                    if (a.source === 'oyez' && a.text_href) {
                        const d = a.date || c.argument || '';
                        if (d) oyezDates.add(d);
                    }
                }
            }

            // Pre-load advocate names per audio entry.
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
                const skipUsscPre = isEarlyTerm && preAudio.source === 'ussc' && oyezDates.has(preDate);
                if (preText && !skipUsscPre) {
                    const prePath = path.join(termDir, 'cases', preText);
                    if (exists(prePath)) {
                        try {
                            const preT = readJson(prePath);
                            for (const sp of preT?.media?.speakers || []) {
                                if (!_JUSTICE_TITLES.has(sp.title || '')) {
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
                    const best = aligned[0] ?? withAudio[0] ?? cands[0];
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
                    const caseEntry = {
                        title,
                        term,
                        number: subKey || number,
                        argument: audioDate,
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
                    advocates[nameKey].cases.push(caseEntry);
                };

                // For early terms, prefer the Oyez transcript when both
                // sources cover the same date — and skip the USSC event's
                // explicit advocates list too, so we don't double-record
                // the same appearance under a slightly-different name
                // variant (e.g. "ANN M. KAPPLER" vs "ANN MARY KAPPLER").
                const skipUsscTranscript = isEarlyTerm && audio.source === 'ussc' && oyezDates.has(audioDate);

                // Explicit advocates list
                if (!skipUsscTranscript) {
                    for (const raw of audio.advocates || []) {
                        const rawName  = (typeof raw === 'object' && raw !== null) ? raw.name  : raw;
                        const rawTitle = (typeof raw === 'object' && raw !== null) ? (raw.title || '') : '';
                        const rawRole  = (typeof raw === 'object' && raw !== null) ? (raw.role  || '') : '';
                        recordAdvocate(normalizeNameSuffix((rawName || '').trim()), rawTitle, rawRole);
                    }
                }

                // Transcript-based speakers
                const textHref = audio.text_href;
                if (!textHref || !audioDate || skipUsscTranscript) continue;
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
                    const spRaw = (speaker.name || '').trim();
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
                    if (spRaw && spRaw.split(/\s+/).length === 1) {
                        const key = spRaw.toUpperCase();
                        if (!singleNamePaths.has(key)) singleNamePaths.set(key, new Set());
                        singleNamePaths.get(key).add(transcriptPath);
                    }
                }
            }
        }
    }

    // Sort each advocate's cases by argument date, most recent first.
    for (const e of Object.values(advocates)) {
        e.cases.sort((a, b) => {
            const da = a.argument || a.date || '';
            const db = b.argument || b.date || '';
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

    // Output sorted by name.
    let output = Object.values(advocates)
        .filter(e => e.cases.length > 0)
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

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

        if (fixMode) {
            const _JT_FIX = new Set(['JUSTICE', 'CHIEF JUSTICE']);
            for (const fixEntry of skipped) {
                const fixNameUpper = fixEntry.name.toUpperCase();
                const tpaths = [...(singleNamePaths.get(fixNameUpper) || [])].sort();
                for (const tpath of tpaths) {
                    const caseFolder = path.dirname(tpath);
                    const siblings = listJsonFiles(caseFolder).filter(p => p !== tpath);
                    const candidates = {}; // upper -> display
                    for (const sib of siblings) {
                        try {
                            const sibData = readJson(sib);
                            for (const s of sibData?.media?.speakers || []) {
                                if (_JT_FIX.has(s.title || '')) continue;
                                const sname = (s.name || '').trim();
                                if (!sname) continue;
                                const sup = sname.toUpperCase();
                                const words = sup.split(/\s+/);
                                if (words.length > 1 && words[words.length - 1] === fixNameUpper) {
                                    candidates[sup] = sname;
                                }
                            }
                        } catch { /* ignore */ }
                    }
                    const candEntries = Object.entries(candidates);
                    if (candEntries.length === 1) {
                        const [, fullDisplay] = candEntries[0];
                        try {
                            const t = readJson(tpath);
                            let changed = false;
                            for (const s of t?.media?.speakers || []) {
                                if ((s.name || '').trim().toUpperCase() === fixNameUpper) {
                                    s.name = fullDisplay; changed = true;
                                }
                            }
                            for (const turn of t?.turns || []) {
                                if ((turn.name || '').trim().toUpperCase() === fixNameUpper) {
                                    turn.name = fullDisplay; changed = true;
                                }
                            }
                            if (changed) {
                                writeText(tpath, JSON.stringify(t, null, 2) + '\n');
                                console.log(`    Fixed ${relRepo(tpath)}: ${fixEntry.name} → ${fullDisplay}`);
                            }
                        } catch (e) {
                            console.error(`    ERROR fixing ${tpath}: ${e.message}`);
                        }
                    }
                }
            }
        }

        if (verbose || singlesMode) {
            const header = `\nSkipped ${skipped.length} one-word advocate name(s) (likely incomplete matches${womenSuffix}):`;
            const entryLines = [];
            for (const entry of skipped) {
                const advId = entry.id || makeAdvocateId(entry.name);
                const stale = path.join(ADVOCATES_DIR, `${advId}.json`);
                const isFem = nameFeminine.get(entry.name.toUpperCase()) && !_isShadowWoman(entry);
                const femTag = isFem ? '  [possibly woman]' : '';
                const sortedCases = entry.cases.slice().sort((a, b) =>
                    (a.argument || '') < (b.argument || '') ? -1
                    : (a.argument || '') > (b.argument || '') ? 1 : 0);
                const casesStr = sortedCases.map(c => `${c.term}/${c.number}`).join('; ');
                if (verbose && exists(stale)) {
                    fs.unlinkSync(stale);
                    entryLines.push(`  ${entry.name} [${advId}.json removed]${femTag}: ${casesStr}`);
                } else {
                    entryLines.push(`  ${entry.name}${femTag}: ${casesStr}`);
                }
            }
            if (singlesMode) {
                writeText(SINGLES_FILE, header + '\n' + entryLines.join('\n') + '\n\n');
                console.log(`Wrote ${skipped.length} single-name advocate(s) to ${relRepo(SINGLES_FILE)}`);
            } else {
                console.log(header);
                for (const line of entryLines) console.log(line);
                console.log('');
            }
        } else {
            for (const entry of skipped) {
                const advId = entry.id || makeAdvocateId(entry.name);
                const stale = path.join(ADVOCATES_DIR, `${advId}.json`);
                if (exists(stale)) fs.unlinkSync(stale);
            }
            console.log(`Skipped ${skipped.length} one-word advocate name(s)${womenSuffix} (use --verbose to list them)`);
        }
    }

    if (singlesMode) return;

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
        const envelope = {
            details: existingDetails,
            highlights: existingHighlights,
        };
        if (entry.previously) {
            envelope.previously = [...new Set(entry.previously)].sort();
        }
        envelope.cases = entry.cases;
        writeText(caseFile, JSON.stringify(envelope, null, 2) + '\n');
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
        const entry = {
            id: e.id || makeAdvocateId(e.name),
            name: e.name,
            cases: e.cases.length,
        };
        if (e.previously) entry.previously = [...new Set(e.previously)].sort();
        return entry;
    });
    ensureDir(path.dirname(OUTPUT_FILE));
    writeText(OUTPUT_FILE, JSON.stringify(index, null, 2) + '\n');
    console.log(`Wrote ${output.length} advocates to ${relRepo(OUTPUT_FILE)} and ${relRepo(ADVOCATES_DIR)}/`);

    // Women advocates index.
    const womenIndex = index.filter(e => nameFeminine.get(e.name.toUpperCase()));
    writeText(WOMEN_OUTPUT_FILE, JSON.stringify(womenIndex, null, 2) + '\n');
    console.log(`Wrote ${womenIndex.length} women advocates to ${relRepo(WOMEN_OUTPUT_FILE)}`);

    // Transgender advocates index (anyone whose transcript speaker entry
    // carries a 'transgender' tag).
    const transIndex = index.filter(e => {
        const tags = nameTags.get(e.name.toUpperCase());
        return tags && tags.has('transgender');
    });
    writeText(TRANS_OUTPUT_FILE, JSON.stringify(transIndex, null, 2) + '\n');
    console.log(`Wrote ${transIndex.length} transgender advocates to ${relRepo(TRANS_OUTPUT_FILE)}`);

    // ── ussc_women.csv ──────────────────────────────────────────
    let womenRows = [];
    for (const [nameUpper, entry] of Object.entries(advocates)) {
        if (!nameFeminine.get(nameUpper)) continue;
        if (entry.name.split(/\s+/).length <= 1) continue;
        const advName = entry.name;
        const sortedCases = entry.cases.slice().sort((a, b) =>
            (a.argument || '') < (b.argument || '') ? -1
            : (a.argument || '') > (b.argument || '') ? 1 : 0);
        let argNum = 0;
        for (const c of sortedCases) {
            argNum++;
            const fullNum = c._fullNumber || c.number;
            const cit = caseCitation.get(ckCite(c.title, c.term, fullNum)) || '';
            const audioIdx = c.audio;
            let url = `https://argumentaloud.org/courts/ussc/?term=${c.term}&case=${fullNum.replace(/,/g, '%2C')}`;
            if (audioIdx) url += `&event=${audioIdx}`;
            const caseKey = ckCase(nameUpper, c.title, c.term, fullNum);
            let allDates = [];
            const anchor = c.argument || '';
            if (!Number.isNaN(isoToDays(anchor))) {
                const dates = [...(allAppearanceDates.get(caseKey) || [])]
                    .filter(d => daysAbsDiff(d, anchor) <= 7)
                    .sort();
                allDates = dates;
            }
            const argDate = allDates.length ? allDates.join(',') : (c.argument || '');
            womenRows.push([advName, argNum, argDate, c.term, c.number, c.title, cit, url]);
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
            !caseFeminineSeen.get(ckCase(nameUpper, c.title, c.term, c._fullNumber || c.number))
        );
        if (badCases.length) failed[entry.name] = badCases;
    }
    const failedNames = Object.keys(failed).sort();
    if (failedNames.length) {
        console.log(`\nWomen advocates with cases not meeting feminine-title criteria (${failedNames.length} advocate(s)):`);
        for (const advName of failedNames) {
            console.log(`  ${advName}:`);
            for (const c of failed[advName]) console.log(`    ${c.term}  ${c.title}  [${c.argument}]`);
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

    // ── Interactive repair ───────────────────────────────────────────────
    if (repairMode && similar.size) {
        const allRenames = {};
        const groupsSorted = [...similar].sort();
        console.log(`\n── Repair mode: ${groupsSorted.length} group(s) to review ─────────────────────`);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q) => new Promise(res => rl.question(q, res));
        try {
            for (const [key, names] of groupsSorted) {
                const [first, last, midCh] = key.split('|');
                const namesSorted = names.slice().sort();
                let abbrev, options;
                if (midCh) {
                    abbrev = `${first} ${midCh}. ${last}`;
                    if (!namesSorted.some(n => n.toUpperCase() === abbrev.toUpperCase())) {
                        options = [abbrev, ...namesSorted];
                    } else {
                        options = namesSorted;
                    }
                } else {
                    abbrev = `${first} ${last}`;
                    options = namesSorted;
                }
                console.log(`\n  ${abbrev}:`);
                options.forEach((name, i) => console.log(`    ${i + 1}. ${name}`));
                while (true) {
                    let raw;
                    try { raw = (await ask(`  Preferred name [1-${options.length}, 0=skip]: `)).trim(); }
                    catch { raw = '0'; }
                    if (raw === '0') break;
                    const n = Number(raw);
                    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
                        const preferred = options[n - 1];
                        const renamed = options.filter(name => name !== preferred);
                        for (const name of renamed) allRenames[name.toUpperCase()] = preferred;
                        console.log(`    → will rename ${renamed.length} name(s) to: ${preferred}`);
                        break;
                    }
                    console.log(`    Please enter a number between 0 and ${options.length}.`);
                }
            }
        } finally {
            rl.close();
        }

        if (Object.keys(allRenames).length) {
            console.log(`\nApplying ${Object.keys(allRenames).length} rename(s) to transcript files…`);
            const nFiles = repairRenameInTranscripts(allRenames);
            console.log(`  Modified ${nFiles} transcript file(s).`);
            repairUpdateSpeakersJson(allRenames);
            console.log(`  Updated ${relRepo(_SPEAKERS_FILE)} with new aliases.`);
            console.log('  Re-run update_advocates.js (without --repair) to rebuild the index.');
        } else {
            console.log('\nNo renames selected; nothing changed.');
        }
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
