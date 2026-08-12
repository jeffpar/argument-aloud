/**
 * update_cases.js — Verify and update case metadata for SCOTUS cases.
 * Applies fixes (sorts, key reordering, refiled-case merging, vote data, etc.)
 * by default. Pass --dry-run to suppress all file writes.
 *
 * Usage:
 *   node update_cases.js [TERM [CASE]] [--checkurls] [--opinions] [--roles] [--speakers] [--reports [--volume N]] [--verbose] [--dry-run]
 *   node update_cases.js TERM CASE --votes win|loss [VOTE_STRING [AUTHOR]] [--minority NAMES...] [--recused NAMES...] [--dissent NAMES...] [--result STRING]
 *   node update_cases.js [TERM [CASE]] --scdb [--add] [--nocache] [--verbose]
 *   node update_cases.js [TERM [CASE]] --dates [--verbose]
 *   node update_cases.js [TERM [CASE]] --unargued
 *   node update_cases.js --audits                      # regenerate auto-computed groups in audits.json
 *   node update_cases.js --feeds                      # rebuild podcast feeds under courts/ussc/feeds/
 *   node update_cases.js [TERM [CASE]] --docket       # probe SCOTUS docket URLs; write docket_href to cases.json
 *   node update_cases.js [TERM] --docket --refetch    # re-probe even cases that already have docket_href
 *   node update_cases.js [TERM] --docket --old        # write old-format URLs (no probe); defaults to terms ≤ 2015-10
 *   node update_cases.js [TERM] --docket --new        # write new-format URLs (no probe); defaults to terms ≥ 2017-10
 *
 * Examples:
 *   node update_cases.js                            # verify + fix all terms
 *   node update_cases.js 2025-10                    # verify + fix one term
 *   node update_cases.js 2025-10 24-1260            # verify + fix one case
 *   node update_cases.js 2025-10 --checkurls        # also probe remote URLs
 *   node update_cases.js 2025-10 --checkurls --opinions
 *   node update_cases.js 2025-10 --dry-run          # report only, no writes
 *   node update_cases.js 2025-10 --verbose          # extra logging
 *   node update_cases.js --advocates                # rebuild advocate index only
 *   node update_cases.js 1979-10 --roles            # derive advocate roles for each
 *                                                   #   argument event (petitioner /
 *                                                   #   respondent / appellant / appellee /
 *                                                   #   plaintiff / defendant / complainant).
 *                                                   #   A trailing '*' on a role means it
 *                                                   #   was confirmed by only one source.
 *
 *   # Vote update: unanimous decision, author Roberts
 *   node update_cases.js 2024-10 2024-001 --votes win 9-0 roberts
 *
 *   # Vote update: 6-3 decision with Kagan writing dissent
 *   node update_cases.js 2025-10 24-109 --votes loss 6-3 alito --dissent kagan --minority sotomayor kagan jackson
 *
 *   # Vote update: per curiam (unsigned), unanimous — no VOTE_STRING/AUTHOR needed
 *   node update_cases.js 1926-10 297 --votes win
 *
 *   # Partial update: just mark Gorsuch as recused
 *   node update_cases.js 2024-10 23-975 --recused gorsuch
 *
 *   node update_cases.js --scdb                     # check SCDB cache + verify all terms
 *   node update_cases.js --scdb --nocache           # ignore SCDB cache
 *   node update_cases.js 1926-10 --scdb             # verify one term against SCDB
 *   node update_cases.js 1926-10 1926-011 --scdb --verbose
 *                                                   # verify one case; show extra detail
 *   node update_cases.js 2024-10 --scdb             # apply SCDB-derived fixes to cases.json
 *   node update_cases.js 2024-10 --scdb --dry-run   # report SCDB differences only
 *   node update_cases.js 2024-10 --scdb --debug     # also dump full ours/scdb JSON on mismatch
 *   node update_cases.js [TERM] --scdb --backfill   # list SCDB cases missing from cases.json
 *   node update_cases.js [TERM] --scdb --backfill --dry-run # preview missing cases without adding
 *
 * Exports helpers used by import_ussc.js / import_oyez.js:
 *   - REPO_ROOT, checkUrl, waybackPdfUrl, fetchOpinions, checkOpinionForCase
 *   - syncFilesCount, syncOpinionHrefFromFiles, setVerbose
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';

import {
    CASE_KEY_ORDER, EVENT_KEY_ORDER, ADVOCATE_KEY_ORDER,
    caseKeyOrder, reorderCase, reorderEvent, reorderAdvocate, reorderVote,
} from './schema.js';

import { syncAdvocates as _syncAdvocatesFromScript, computeArguedWithSkipSet } from './update_advocates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT   = path.resolve(__dirname, '..');
export const SCOTUS_BASE = 'https://www.supremecourt.gov';

/** Return the first pipe-delimited component of a case title for display. */
const firstTitle = (s) => { if (!s) return s; const i = s.indexOf('|'); return i === -1 ? s : s.slice(0, i); };

const _OPINIONS_CACHE = new Map();   // `${year2}|${checkUrls}` -> opinions dict
let _VERBOSE = false;
export const setVerbose = (v) => { _VERBOSE = !!v; };
let _DRY_RUN = false;
export const setDryRun = (v) => { _DRY_RUN = !!v; };

const _WAYBACK_CDX_URL   = 'https://web.archive.org/cdx/search/cdx';
const _WAYBACK_PREFIX_RE = /\/web\/\d{14}\/https?:\/\/www\.supremecourt\.gov/g;

const USER_AGENT = 'Mozilla/5.0';

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function _request(url, method = 'HEAD') {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
            const resp = await fetch(url, {
                method,
                redirect: 'follow',
                headers: { 'User-Agent': USER_AGENT },
                signal: ctrl.signal,
            });
            const headers = {};
            resp.headers.forEach((v, k) => {
                // Mimic Python's case-preserving header dict (Title-Case).
                const tc = k.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('-');
                headers[tc] = v;
            });
            if (resp.ok) return [true, headers];
            return [false, { _status: resp.status }];
        } finally {
            clearTimeout(t);
        }
    } catch (exc) {
        return [false, { _error: String(exc?.message || exc) }];
    }
}

export async function checkUrl(url) {
    let [ok, headers] = await _request(url, 'HEAD');
    if (!ok && (headers._status === 405 || headers._status === 501)) {
        [ok, headers] = await _request(url, 'GET');
    }
    return [ok, headers];
}

// ── Opinions index ──────────────────────────────────────────────────────────

export async function waybackPdfUrl(pdfUrl, maxTs = '') {
    let cdxApi = `${_WAYBACK_CDX_URL}?url=${encodeURIComponent(pdfUrl)}`
               + `&output=json&limit=1&statuscode=200&fl=timestamp`;
    if (maxTs) cdxApi += `&to=${maxTs}`;
    let rows;
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
            const resp = await fetch(cdxApi, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
            if (!resp.ok) return '';
            rows = await resp.json();
        } finally {
            clearTimeout(t);
        }
    } catch {
        return '';
    }
    if (!Array.isArray(rows) || rows.length < 2) return '';
    const ts = rows[1][0];
    return `https://web.archive.org/web/${ts}/${pdfUrl}`;
}

async function _fetchHtml(url, timeoutMs = 30000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.text();
    } finally {
        clearTimeout(t);
    }
}

async function _fixDeadOpinionPdfHrefs(opinions) {
    const replacements = new Map();   // base_url -> '' or wayback or base_url
    for (const op of Object.values(opinions)) {
        const base = String(op.href).split('#')[0];
        if (replacements.has(base)) continue;
        const [ok] = await checkUrl(base);
        if (ok) {
            replacements.set(base, base);
        } else {
            const wb = await waybackPdfUrl(base);
            if (wb) console.log(`    PDF 404 — using Wayback: ${base}`);
            replacements.set(base, wb);
        }
    }
    const result = {};
    for (const [docket, op] of Object.entries(opinions)) {
        const base = String(op.href).split('#')[0];
        const frag = String(op.href).slice(base.length);
        const newBase = replacements.get(base) || base;
        if (newBase && newBase !== base) {
            result[docket] = { ...op, href: newBase + frag };
        } else {
            result[docket] = op;
        }
    }
    return result;
}

// Matches "141, Orig." (comma) or "22O141" / "17O141" (term-prefixed) formats.
// In both cases capture the original case number (not the term prefix).
const _ORIG_DOCKET_RE = /^(?:(\d+),\s*orig\.?|\d{2}[Oo](\d+))$/i;
const _PAREN_RE       = /\s*\([^)]*\)\s*$/;

const _OPINIONS_PATTERN = new RegExp(
    `<td[^>]*>(\\d{1,2}/\\d{1,2}/\\d{2})</td>\\s*` +
    `<td[^>]*white-space[^>]*>([^<]+)</td>\\s*` +
    `<td[^>]*><a href=.(/opinions/[^\\s'">]+)[^>]*>([^<]+)</a>` +
    `[\\s\\S]*?<td[^>]*>(\\w+)</td>` +
    `(?:\\s*<td[^>]*>(?:<[^>]+>)?(\\d+/\\d+|\\d+ U\\.S\\.[ \\xa0]+\\d+)(?:</[^>]+>)?</td>)?`,
    'g'
);

function _parseOpinionsHtml(html, baseHrefPrefix, pattern = _OPINIONS_PATTERN) {
    const out = {};
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(html)) !== null) {
        const [, dateRaw, docketRaw, hrefPath, name, author, citeRaw] = m.map(g => (g || '').trim());
        let dateIso = dateRaw;
        const dm = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(dateRaw);
        if (dm) {
            const [, mm, dd, yy] = dm;
            dateIso = `20${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
        }
        const docket = docketRaw.replace(_PAREN_RE, '');
        const om = _ORIG_DOCKET_RE.exec(docket);
        const docketKey = om ? `${om[1] || om[2]}-orig` : docket.toLowerCase();
        const entry = {
            date:   dateIso,
            name,
            author,
            href:   baseHrefPrefix + hrefPath,
        };
        if (citeRaw) entry.cite = citeRaw;
        out[docketKey] = entry;
    }
    return out;
}

async function _fetchOpinionsViaWayback(year2digit) {
    const yearInt = 2000 + parseInt(year2digit, 10);
    // Use the end of the term as a lower bound so we don't pick up a
    // mid-term snapshot that lacks opinions issued after it.
    const minDate     = `${yearInt + 1}0701`;
    const opinionsUrl = `${SCOTUS_BASE}/opinions/slipopinion/${year2digit}`;

    // Target roughly 8 years after the term — late enough for usCite values to
    // have appeared in U.S. Reports, early enough to avoid later page shrinkage.
    const targetDate   = `${yearInt + 8}1201`;
    const cdxApi = `${_WAYBACK_CDX_URL}?url=${encodeURIComponent(opinionsUrl)}`
                 + `&output=json&from=${minDate}&to=${targetDate}&statuscode=200`
                 + `&fl=timestamp&limit=-1`;
    if (_VERBOSE) console.log(`  Querying Wayback CDX: ${cdxApi}`);

    let snapshotTs;
    try {
        const txt = await _fetchHtml(cdxApi);
        const rows = JSON.parse(txt);
        if (!Array.isArray(rows) || rows.length < 2) {
            if (_VERBOSE) console.log(`  No Wayback snapshot found for slipopinion/${year2digit} before ${targetDate}.`);
            return {};
        }
        const tsIdx = rows[0].indexOf('timestamp');
        snapshotTs = rows[rows.length - 1][tsIdx >= 0 ? tsIdx : 0];
    } catch (exc) {
        console.log(`    Warning: Wayback CDX query failed: ${exc.message || exc}`);
        return {};
    }
    const snapshotUrl = `https://web.archive.org/web/${snapshotTs}/${opinionsUrl}`;

    if (_VERBOSE) console.log(`  Fetching Wayback snapshot: ${snapshotUrl}`);
    else console.log(`Fetching Wayback snapshot (${snapshotTs.slice(0,8)}) for slipopinion/${year2digit} ...`);

    let html;
    try {
        html = await _fetchHtml(snapshotUrl);
    } catch (exc) {
        console.log(`    Warning: could not fetch Wayback snapshot ${snapshotUrl}: ${exc.message || exc}`);
        return {};
    }

    const waybackBase = `https://web.archive.org/web/${snapshotTs}/https://www.supremecourt.gov`;
    html = html.replace(_WAYBACK_PREFIX_RE, '');

    const patternNew = _OPINIONS_PATTERN;
    const patternOld = new RegExp(
        `<td[^>]*>(\\d{1,2}/\\d{1,2}/\\d{2})</td>\\s*` +
        `<td[^>]*>([^<]+)</td>\\s*` +
        `<td><a[^>]*href=.(/opinions/[^\\s'">]+)[^>]*>([^<]+)</a>` +
        `[\\s\\S]*?<td[^>]*>(\\w+)</td>` +
        `(?:\\s*<td[^>]*>(?:<[^>]+>)?(\\d+ U\\.S\\.[ \\xa0]+\\d+)(?:</[^>]+>)?</td>)?`,
        'g'
    );

    let opinions = _parseOpinionsHtml(html, waybackBase, patternNew);
    if (Object.keys(opinions).length === 0) {
        opinions = _parseOpinionsHtml(html, waybackBase, patternOld);
    }
    console.log(`Found ${Object.keys(opinions).length} opinion(s) via Wayback for ${yearInt}-10 term.`);
    return opinions;
}

export async function fetchOpinions(year2digit, checkUrls = false) {
    const cacheKey = `${year2digit}|${checkUrls ? 1 : 0}`;
    if (_OPINIONS_CACHE.has(cacheKey)) return _OPINIONS_CACHE.get(cacheKey);

    const url = `${SCOTUS_BASE}/opinions/slipopinion/${year2digit}`;
    if (_VERBOSE) console.log(`Fetching opinions index: ${url}`);

    let html = '';
    try {
        html = await _fetchHtml(url);
    } catch (exc) {
        console.log(`    Warning: could not fetch opinions index: ${exc.message || exc}`);
    }

    let opinions = _parseOpinionsHtml(html, SCOTUS_BASE);

    if (Object.keys(opinions).length === 0) {
        opinions = await _fetchOpinionsViaWayback(year2digit);
    } else {
        // Even when the live page works, supplement with Wayback to recover
        // opinions that have fallen off the live page over time, and to fill
        // in usCite values that post-date the original snapshots.
        // _fetchOpinionsViaWayback's minDate guard (year+1 July) means this
        // is a fast no-op (one CDX lookup, no HTML fetch) for current and
        // near-future terms where no qualifying snapshots exist yet.
        const wayback = await _fetchOpinionsViaWayback(year2digit);
        for (const [key, wp] of Object.entries(wayback)) {
            if (!opinions[key]) {
                opinions[key] = wp;
            } else if (!opinions[key].cite && wp.cite) {
                opinions[key].cite = wp.cite;
            }
        }
        if (checkUrls) {
            opinions = await _fixDeadOpinionPdfHrefs(opinions);
        }
    }

    _OPINIONS_CACHE.set(cacheKey, opinions);
    if (_VERBOSE) {
        const fullYear = String(2000 + parseInt(year2digit, 10));
        console.log(`  Found ${Object.keys(opinions).length} opinion(s) for term year ${fullYear}.`);
    }
    return opinions;
}

// ── files.json updates ──────────────────────────────────────────────────────

function _writeJson(p, data) {
    if (_DRY_RUN) { if (_VERBOSE) console.log(`  [dry-run] would write ${path.relative(REPO_ROOT, p)}`); return; }
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// Returns true if writing `data` as JSON to `p` would change the file.
function _jsonChanged(p, data) {
    const newStr = JSON.stringify(data, null, 2) + '\n';
    try { return fs.readFileSync(p, 'utf8') !== newStr; } catch { return true; }
}

// Returns true if writing raw text `str` to `p` would change the file.
function _textChanged(p, str) {
    try { return fs.readFileSync(p, 'utf8') !== str; } catch { return true; }
}

function _writeFileSync(p, data) {
    if (_DRY_RUN) { if (_VERBOSE) console.log(`  [dry-run] would write ${path.relative(REPO_ROOT, p)}`); return; }
    fs.writeFileSync(p, data);
}

function _unlinkSync(p) {
    if (_DRY_RUN) { if (_VERBOSE) console.log(`  [dry-run] would delete ${path.relative(REPO_ROOT, p)}`); return; }
    fs.unlinkSync(p);
}

function _mkdirSync(p, opts) {
    if (_DRY_RUN) { if (_VERBOSE) console.log(`  [dry-run] would mkdir ${path.relative(REPO_ROOT, p)}`); return; }
    fs.mkdirSync(p, opts);
}

function _renameSync(src, dst) {
    if (_DRY_RUN) { if (_VERBOSE) console.log(`  [dry-run] would rename ${path.relative(REPO_ROOT, src)} -> ${path.relative(REPO_ROOT, dst)}`); return; }
    fs.renameSync(src, dst);
}

function _readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export async function checkOpinionForCase(filesPath, caseNumber, term, printHeader = null) {
    try {
        if (parseInt(term.split('-')[0], 10) < 2012) return;
    } catch {}
    const year2 = term.split('-')[0].slice(-2);
    const opinions = await fetchOpinions(year2);
    const opinion = opinions[caseNumber.toLowerCase()];
    if (!opinion) return;

    let data;
    try { data = _readJson(filesPath); } catch { return; }
    if (!Array.isArray(data)) return;

    if (data.some(e => e?.type === 'opinion')) return;

    const newEntry = {
        type:   'opinion',
        group:  'other',
        title:  'Opinion in ' + opinion.name,
        date:   opinion.date,
        author: opinion.author,
        href:   opinion.href,
    };
    data.push(newEntry);
    _writeJson(filesPath, data);
    if (printHeader) printHeader();
    console.log(`    Opinion: added "${newEntry.title}" (${opinion.date}, J. ${opinion.author})`);
}

function _caseFolder(numberOrId) {
    return String(numberOrId || '').split(',')[0].trim();
}

// The web app resolves a case by its first docket number alone (or by id when
// there is no number) even for consolidated cases with several comma-joined
// numbers, so collection-style output files (noteworthy.json, transcripts.json,
// briefs.json, audits.json, the per-justice people/justices/*.json sets, etc.)
// only need to record that one number — never the full comma-joined list.
function _primaryCaseNumber(c) {
    return (c.number || c.id || '').split(',')[0].trim();
}

export function syncFilesCount(casesPath) {
    let data;
    try { data = _readJson(casesPath); } catch { return; }
    if (!Array.isArray(data)) return;

    const termDir = path.dirname(casesPath);
    let modified = false;

    for (const c of data) {
        const folderName = _caseFolder(c.number || c.id || '');
        const filesPath  = path.join(termDir, 'cases', folderName, 'files.json');
        let count = 0;
        if (fs.existsSync(filesPath)) {
            try {
                const files = _readJson(filesPath);
                if (Array.isArray(files)) count = files.length;
            } catch {}
        }
        const hasFiles = count > 0;
        if (c.files === hasFiles) continue;
        c.files = hasFiles;
        modified = true;
    }

    if (modified) {
        _writeJson(casesPath, data);
        if (_VERBOSE) console.log(` NOTICE: ${path.basename(termDir)}/cases.json: synced "files" counts`);
    }
}

function _classifyDecisionHref(url) {
    if ((url || '').includes('tile.loc.gov')) return 'decision_loc';
    return 'decision_ussc';
}

export function syncOpinionHrefFromFiles(casesPath) {
    let data;
    try { data = _readJson(casesPath); } catch { return; }
    if (!Array.isArray(data)) return;

    const termDir = path.dirname(casesPath);
    let modified = false;

    for (const c of data) {
        const hasDecisionHref = c.decision_loc || c.decision_ussc || c.decision_rep;
        const needsHref     = !hasDecisionHref;
        const needsDecision = !c.decision;
        if (!needsHref && !needsDecision) continue;

        const folderName = _caseFolder(c.number || c.id || '');
        if (!folderName) continue;
        const filesPath = path.join(termDir, 'cases', folderName, 'files.json');
        if (!fs.existsSync(filesPath)) continue;
        let filesData;
        try { filesData = _readJson(filesPath); } catch { continue; }
        if (!Array.isArray(filesData)) continue;
        const opinion = filesData.find(e => e?.type === 'opinion');
        if (!opinion) continue;

        const label = c.number || c.id || '?';
        let changed = false;
        if (needsHref && opinion.href) {
            const hrefKey = _classifyDecisionHref(opinion.href);
            c[hrefKey] = opinion.href;
            changed = true;
            console.log(`  ${label}: inserted ${hrefKey} from files.json`);
        }
        if (needsDecision && opinion.date) {
            c.decision = opinion.date;
            changed = true;
            console.log(`  ${label}: inserted decision date from files.json`);
        }
        if (changed) {
            const reordered = reorderCase(c);
            for (const k of Object.keys(c)) delete c[k];
            Object.assign(c, reordered);
            modified = true;
        }
    }

    if (modified) _writeJson(casesPath, data);
}

// ════════════════════
// Common small helpers
// ════════════════════

const _MONTHS = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];
const _DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

// Convert a YYYY-MM-DD string to "Weekday, Month Day, Year".
// Returns null for any string that doesn't parse as a valid date.
function _formatDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(d)) return null;
    return `${_DAYS[d.getUTCDay()]}, ${_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Build the "days" string for a comma-delimited date field (e.g. argument).
// Returns the semicolon-delimited formatted dates, or '' if none are valid.
function _computeDays(rawDateField) {
    if (!rawDateField) return '';
    const parts = String(rawDateField).split(',').map(s => s.trim()).filter(Boolean);
    return parts.map(_formatDay).filter(Boolean).join('; ');
}

const _DATE_DEC_PARSE_RE = new RegExp(
    '^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\\s+'
  + '(January|February|March|April|May|June|July|August|September|'
  + 'October|November|December)\\s+(\\d{1,2}),\\s+(\\d{4})$'
);

const TERMS_JSON   = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', 'terms.json');
const REPORTS_JSON = path.join(REPO_ROOT, 'data', 'ussc', 'reports.json');
const TERMS_DIR    = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const PDFS_DIR     = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'pdfs');
const OPINIONS_HTML_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'html');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
    try { return fs.statSync(p).isFile(); } catch { return false; }
}

function listDir(p) {
    try { return fs.readdirSync(p).sort(); } catch { return []; }
}

// Sort strings lexicographically (stable, locale-independent).
function _sortStr(arr) {
    return [...arr].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

function _splitNumbers(raw) {
    return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

function _parseDateField(value) {
    return String(value || '').split(',').map(d => d.trim()).filter(Boolean);
}

function _joinDates(dates) {
    return dates.join(',');
}

function _renameKey(obj, oldKey, newKey) {
    const items = Object.entries(obj);
    const idx = items.findIndex(([k]) => k === oldKey);
    if (idx < 0) return;
    items[idx] = [newKey, items[idx][1]];
    for (const k of Object.keys(obj)) delete obj[k];
    for (const [k, v] of items) obj[k] = v;
}

function _insertKeyBefore(c, newKey, newVal, before) {
    const out = {};
    let inserted = false;
    for (const [k, v] of Object.entries(c)) {
        if (k === before && !inserted) { out[newKey] = newVal; inserted = true; }
        out[k] = v;
    }
    if (!inserted) out[newKey] = newVal;
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, out);
}

function _isCurrentTerm(term) {
    try {
        const [ys, ms] = term.split('-');
        const year = parseInt(ys, 10), month = parseInt(ms, 10);
        const now = new Date();
        const start = new Date(year,     month - 1, 1);
        const end   = new Date(year + 1, month - 1, 1);
        return now >= start && now < end;
    } catch { return false; }
}

// ── Date helpers ──────────────────────────────────────────────────────────

function _datesAreConsecutive(dates) {
    if (dates.length < 2) return true;
    const parsed = [];
    for (const d of dates) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
        if (!m) return false;
        parsed.push(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    }
    parsed.sort((a, b) => a - b);
    const day = 86400000;
    for (let i = 0; i + 1 < parsed.length; i++) {
        if (parsed[i + 1] - parsed[i] !== day) return false;
    }
    return true;
}

function _termDateRange(term, allTerms) {
    const [ys, ms] = term.split('-');
    const year = +ys, month = +ms;
    const start = new Date(Date.UTC(year, month - 1, 1));
    let end;
    const idx = allTerms.indexOf(term);
    if (idx >= 0 && idx + 1 < allTerms.length) {
        const [ny, nm] = allTerms[idx + 1].split('-');
        end = new Date(Date.UTC(+ny, +nm - 1, 1) - 86400000);
    } else {
        let y = year, m = month + 11;
        if (m > 12) { m -= 12; y += 1; }
        end = new Date(Date.UTC(y, m - 1, 1) - 86400000);
    }
    const fmt = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    return [fmt(start), fmt(end)];
}

// ── Source/type detection ─────────────────────────────────────────────────

function _detectSourceType(audioHref) {
    const lower = String(audioHref || '').toLowerCase();
    let source;
    if (lower.includes('supremecourt.gov')) source = 'ussc';
    else if (lower.includes('nara'))        source = 'nara';
    else if (lower.includes('oyez'))        source = 'oyez';
    else                                    source = 'unknown';
    let type;
    if (source === 'oyez' && lower.includes('opinion'))         type = 'decision';
    else if (source === 'oyez' && lower.includes('reargument')) type = 'reargument';
    else                                                        type = 'argument';
    return [source, type];
}

function _isTranscriptAligned(transcriptPath) {
    if (!fs.existsSync(transcriptPath)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
        const turns = Array.isArray(data) ? data : (data?.turns || []);
        // A single-turn transcript is always aligned (no relative timing needed).
        // A multi-turn transcript is only aligned if at least one turn has a non-zero timestamp.
        return turns.length === 1 || turns.some(t => t && t.time && /[1-9]/.test(t.time));
    } catch { return false; }
}

// ── HTTP helpers (delays / framing / downloads) ───────────────────────────

const _DELAYS = [['supremecourt.gov', 2000]];
const _DEFAULT_DELAY = 500;

async function _politeDelay(url) {
    let host = '';
    try { host = new URL(url).hostname || ''; } catch {}
    for (const [domain, delay] of _DELAYS) {
        if (host === domain || host.endsWith('.' + domain)) { await sleep(delay); return; }
    }
    await sleep(_DEFAULT_DELAY);
}

function isFramingBlocked(headers) {
    const xfo = String(headers['X-Frame-Options'] || '').trim().toUpperCase();
    if (xfo === 'DENY' || xfo === 'SAMEORIGIN') return true;
    const csp = String(headers['Content-Security-Policy'] || '');
    for (let directive of csp.split(';')) {
        directive = directive.trim();
        if (directive.toLowerCase().startsWith('frame-ancestors')) {
            const sources = directive.split(/\s+/).slice(1);
            if (!sources.includes('*')) return true;
        }
    }
    return false;
}

function _localFilename(url) {
    let p = '';
    try { p = new URL(url).pathname; } catch { p = url; }
    const name = decodeURIComponent(path.basename(p));
    let safe = '';
    for (const c of name) {
        safe += /[a-zA-Z0-9._-]/.test(c) ? c : '_';
    }
    return safe || 'download.pdf';
}

function _uniqueDest(caseDir, name) {
    let dest = path.join(caseDir, name);
    if (!fs.existsSync(dest)) return dest;
    const ext  = path.extname(name);
    const stem = path.basename(name, ext);
    let i = 1;
    while (fs.existsSync(dest)) { dest = path.join(caseDir, `${stem}-${i}${ext}`); i++; }
    return dest;
}

async function _downloadFile(url, destPath) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': USER_AGENT },
            redirect: 'follow', signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        _writeFileSync(destPath, buf);
    } finally { clearTimeout(t); }
}

// ═══════════════════
// Speaker-map cleanup
// ═══════════════════

const _SPEAKERS_PATH = path.join(REPO_ROOT, 'data', 'ussc', 'speakers.json');
const _JUSTICES_PATH = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');

function _buildJusticeRenameEntries() {
    if (!fs.existsSync(_JUSTICES_PATH)) return [];
    let data;
    try { data = JSON.parse(fs.readFileSync(_JUSTICES_PATH, 'utf8')); }
    catch { return []; }
    const entries = [];
    for (const [canonical, info] of Object.entries(data)) {
        const u = canonical.toUpperCase();
        for (const alt of info?.alternates || []) {
            const a = alt.toUpperCase();
            if (a !== u) entries.push([a, null, null, u, 'justice', null]);
        }
    }
    return entries;
}

function loadSpeakerMap() {
    if (!fs.existsSync(_SPEAKERS_PATH)) return [];
    let data;
    try { data = JSON.parse(fs.readFileSync(_SPEAKERS_PATH, 'utf8')); }
    catch { return []; }
    const out = [];
    for (const [raw, corrected] of Object.entries(data.typos || {})) {
        out.push([raw.toUpperCase(), null, null, corrected.toUpperCase(), null, null]);
    }
    for (const [oldN, newN] of Object.entries(data.rename || {})) {
        out.push([oldN.toUpperCase(), null, null, newN.toUpperCase(), null, null]);
    }
    return out;
}

function filterSpeakerMap(entries, term) {
    const out = [];
    for (const e of entries) {
        const [, op, constraint] = e;
        if (op === null) out.push(e);
        else if (op === '<'  && term <  constraint) out.push(e);
        else if (op === '>=' && term >= constraint) out.push(e);
    }
    return out;
}

let _JUSTICE_INFO = null;  // upper-name -> { titles?: string[], tenures: [{dateStart, dateStop}] }
function _loadJusticeInfo() {
    if (_JUSTICE_INFO) return _JUSTICE_INFO;
    const map = new Map();
    if (!fs.existsSync(_JUSTICES_PATH)) { _JUSTICE_INFO = map; return map; }
    let data;
    try { data = JSON.parse(fs.readFileSync(_JUSTICES_PATH, 'utf8')); }
    catch { _JUSTICE_INFO = map; return map; }
    for (const [canonical, info] of Object.entries(data)) {
        const tenures = Array.isArray(info?.tenures)
            ? info.tenures.map(t => ({ dateStart: t.dateStart || '', dateStop: t.dateStop || '' }))
            : (info?.dateStart !== undefined
                ? [{ dateStart: info.dateStart || '', dateStop: info.dateStop || '' }]
                : []);
        const entry = { titles: info?.titles || null, tenures };
        map.set(canonical.toUpperCase(), entry);
        for (const alt of info?.alternates || []) map.set(alt.toUpperCase(), entry);
    }
    _JUSTICE_INFO = map;
    return map;
}

// True if `date` (YYYY-MM-DD) falls within any of the justice's tenure spans.
// If the justice has no tenure data (e.g. UNKNOWN JUSTICE), assume true.
function _isJusticeOnDate(info, date) {
    if (!info || !info.tenures || !info.tenures.length) return true;
    if (!date) return true;
    for (const { dateStart, dateStop } of info.tenures) {
        if (dateStart && date < dateStart) continue;
        if (dateStop  && date > dateStop)  continue;
        return true;
    }
    return false;
}

// Resolve the expected title ("JUSTICE" / "CHIEF JUSTICE") for a justice on a
// given YYYY-MM. Returns null if titles array is malformed and no match found.
function _resolveJusticeTitle(titles, yearMonth) {
    if (!titles || !titles.length) return 'JUSTICE';
    let unconditional = null;
    for (const spec of titles) {
        const m = String(spec).match(/^(.*?)\s*(<|>=|<=|>|=)\s*(\S+)\s*$/);
        if (!m) { unconditional = unconditional || String(spec).trim(); continue; }
        const [, title, op, constraint] = m;
        const t = title.trim();
        const c = constraint.trim();
        if (!yearMonth) continue;
        if (op === '<'  && yearMonth <  c) return t;
        if (op === '<=' && yearMonth <= c) return t;
        if (op === '>=' && yearMonth >= c) return t;
        if (op === '>'  && yearMonth >  c) return t;
        if (op === '='  && yearMonth === c) return t;
    }
    return unconditional || 'JUSTICE';
}

function checkUnmappedJustices(caseDir) {
    if (!isDir(caseDir)) return;
    const term = path.basename(path.dirname(path.dirname(caseDir)));
    const justiceInfo = _loadJusticeInfo();
    for (const name of listDir(caseDir).filter(n => n.endsWith('.json'))) {
        if (name === 'files.json') continue;
        const p = path.join(caseDir, name);
        let data;
        try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
        if (!data || typeof data !== 'object') continue;
        const speakers = data?.media?.speakers || [];
        // Derive YYYY-MM-DD from filename (e.g. 1969-12-08.json or 1969-12-08-oyez.json).
        const dm = name.match(/^(\d{4}-\d{2}-\d{2})/);
        const argDate = dm ? dm[1] : '';
        const yearMonth = argDate.slice(0, 7);
        let modified = false;
        const replacements = [];   // [origName] — speaker names to rename in turns
        const removeIdx    = [];   // indices in speakers[] to remove (duplicates)
        for (let i = 0; i < speakers.length; i++) {
            const sp = speakers[i];
            const spName  = (sp.name  || '').toUpperCase();
            const spTitle = (sp.title || '').toUpperCase();
            const titleIsJustice = spTitle === 'JUSTICE' || spTitle === 'CHIEF JUSTICE';
            const info = justiceInfo.get(spName);
            const nameIsJustice  = !!info && _isJusticeOnDate(info, argDate);
            if (titleIsJustice && !info) {
                console.log(`WARNING: ${term}/${path.basename(caseDir)}/${name}: title='${sp.title}' but name='${sp.name}' is not a known justice`);
            } else if (titleIsJustice && info && !nameIsJustice) {
                const verb = _DRY_RUN ? 'would replace' : 'replacing';
                console.log(`WARNING: ${term}/${path.basename(caseDir)}/${name}: title='${sp.title}' but '${sp.name}' was not on the Court on ${argDate} → ${verb} with 'UNKNOWN JUSTICE'`);
                if (!_DRY_RUN) {
                    const hasUnknown = speakers.some((s, j) =>
                        j !== i && (s.name || '').toUpperCase() === 'UNKNOWN JUSTICE');
                    if (hasUnknown) {
                        removeIdx.push(i);
                    } else {
                        sp.name  = 'UNKNOWN JUSTICE';
                        sp.title = 'JUSTICE';
                    }
                    replacements.push(spName);
                    modified = true;
                }
            } else if (!titleIsJustice && nameIsJustice) {
                const expected = _resolveJusticeTitle(info.titles, yearMonth);
                const verb = _DRY_RUN ? 'would set' : 'set';
                console.log(`WARNING: ${term}/${path.basename(caseDir)}/${name}: name='${sp.name}' title='${sp.title}' → ${verb} title='${expected}'`);
                if (!_DRY_RUN) {
                    sp.title = expected;
                    modified = true;
                }
            }
        }
        if (removeIdx.length) {
            for (const idx of removeIdx.sort((a, b) => b - a)) speakers.splice(idx, 1);
        }
        if (replacements.length && Array.isArray(data.turns)) {
            const renameSet = new Set(replacements);
            for (const turn of data.turns) {
                const tn = (turn.name || '').toUpperCase();
                if (renameSet.has(tn)) turn.name = 'UNKNOWN JUSTICE';
            }
        }
        if (modified) _writeJson(p, data);
    }
}

function applySpeakerMapToCase(caseDir, entries, dryRun = false) {
    if (!isDir(caseDir)) return;
    for (const name of listDir(caseDir).filter(n => n.endsWith('.json'))) {
        if (name === 'files.json') continue;
        const p = path.join(caseDir, name);
        let data;
        try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        let modified = false;
        const speakers = data?.media?.speakers || [];

        // Pre-mapping role snapshot (used by turn-name pass below).
        const speakerRoles = {};
        for (const sp of speakers) speakerRoles[sp.name || ''] = sp.role || '';

        // Rename speakers (first-match-wins).
        for (const sp of speakers) {
            const spName = sp.name || '', role = sp.role || '';
            for (const [base, , , newName, roleFilter, newRole] of entries) {
                if (spName !== base) continue;
                if (roleFilter !== null && role !== roleFilter) continue;
                sp.name = newName;
                if (newRole !== null && newRole !== undefined) sp.role = newRole;
                modified = true;
                break;
            }
        }

        // Rename turn names.
        for (const turn of data.turns || []) {
            const tName = turn.name || '';
            const tRole = speakerRoles[tName] || '';
            for (const [base, , , newName, roleFilter] of entries) {
                if (tName !== base) continue;
                if (roleFilter !== null && tRole !== roleFilter) continue;
                turn.name = newName;
                modified = true;
                break;
            }
        }

        if (modified) {
            const verb = (_DRY_RUN || dryRun) ? 'would apply' : 'applied';
            console.log(`  ${path.basename(caseDir)}: ${verb} speaker map to ${name}`);
            if (!dryRun) _writeJson(p, data);
        }
    }
    checkUnmappedJustices(caseDir);
}

// ═══════════════════════════════════════
// cases.json mutators (from verify_cases)
// ═══════════════════════════════════════

function migrateArgumentsToAudio(casesPath) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    let modified = false;
    for (const c of data) {
        if ('arguments' in c && !('audio' in c)) {
            c.audio = c.arguments;
            delete c.arguments;
            modified = true;
        }
    }
    if (modified) {
        _writeJson(casesPath, data);
        console.log('Migrated cases.json: renamed "arguments" → "audio".');
    }
}

function verifyCasesJsonArguments(casesPath, term = '', dryRun = false) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    const termDir = path.dirname(casesPath);
    let modified = false;
    for (const c of data) {
        const label = c.number || c.id || '?';
        let caseModified = false;
        const events = c.events || [];
        for (let i = 0; i < events.length; i++) {
            const arg = events[i];
            const audioHref = arg.audio_href || '';
            if (!audioHref) continue;
            const [srcInferred, typeInferred] = _detectSourceType(audioHref);
            const source   = arg.source || srcInferred;
            let typeVal    = arg.type   || typeInferred;
            if (typeVal === 'misc') typeVal = 'journal';

            const textHref = arg.text_href || '';
            const isAligned = !!(textHref
                && _isTranscriptAligned(path.join(termDir, 'cases', textHref)));

            const currentAligned = ('aligned' in arg) ? arg.aligned : null;
            const desiredAligned = isAligned ? true : null;

            if (arg.source === source && arg.type === typeVal
                    && currentAligned === desiredAligned) continue;

            const rebuilt = { ...arg, source, type: typeVal };
            if (isAligned) rebuilt.aligned = true;
            else delete rebuilt.aligned;
            events[i] = reorderEvent(rebuilt);
            modified = true;
            caseModified = true;
        }
        if (caseModified && _VERBOSE) console.log(` NOTICE: ${term}/${label}: set aligned on audio file(s)`);
    }
    if (modified && !dryRun) _writeJson(casesPath, data);
}

function normalizeAudioAlignedPosition(_casesPath) {
    // Key ordering (including 'aligned') is now managed by EVENT_KEY_ORDER and
    // fixKeyOrder() inside processTerm(); nothing to do here.
}

function removeRedundantTranscriptFiles(casesPath) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    const termDir = path.dirname(casesPath);
    let casesModified = false;

    for (const c of data) {
        const folderName = _caseFolder(c.number || c.id || '');
        const filesPath = path.join(termDir, 'cases', folderName, 'files.json');
        if (!fs.existsSync(filesPath)) continue;
        let files;
        try { files = JSON.parse(fs.readFileSync(filesPath, 'utf8')); } catch { continue; }
        if (!Array.isArray(files)) continue;

        const transcriptFileEntries = files.filter(f => f?.type === 'transcript');
        if (transcriptFileEntries.length === 0) continue;

        const label = c.number || c.id || '?';
        if (!c.events) c.events = [];
        let audioList = c.events;
        let audioModified = false;

        for (const tf of transcriptFileEntries) {
            const tfHref = tf.href || '';
            const tfDate = tf.date || '';
            if (!tfHref || !tfDate) continue;
            const matched = audioList.find(a => a.date === tfDate);
            if (matched) {
                if (!matched.transcript_href) {
                    const rawTitle = tf.title || '';
                    const argTitle = rawTitle.replace(/^Transcript of\s+/, '').trim() || rawTitle;
                    const rebuilt = {};
                    for (const [k, v] of Object.entries(matched)) rebuilt[k] = v;
                    if (!matched.title && argTitle) rebuilt.title = argTitle;
                    rebuilt.transcript_href = tfHref;
                    for (const k of Object.keys(matched)) delete matched[k];
                    Object.assign(matched, rebuilt);
                    console.log(`  ${label} (${tfDate}): added transcript_href to existing audio object`);
                    audioModified = true;
                } else if (!matched.title) {
                    const rawTitle = tf.title || '';
                    const argTitle = rawTitle.replace(/^Transcript of\s+/, '').trim() || rawTitle;
                    if (argTitle) {
                        const rebuilt = {};
                        for (const [k, v] of Object.entries(matched)) {
                            rebuilt[k] = v;
                            if (k === 'date') rebuilt.title = argTitle;
                        }
                        if (!('title' in rebuilt)) rebuilt.title = argTitle;
                        for (const k of Object.keys(matched)) delete matched[k];
                        Object.assign(matched, rebuilt);
                        audioModified = true;
                    }
                }
            } else {
                const rawTitle = tf.title || '';
                const argTitle = rawTitle.replace(/^Transcript of\s+/, '').trim() || rawTitle;
                const newAudio = {
                    source: 'ussc', type: 'argument',
                    title: argTitle, date: tfDate, transcript_href: tfHref,
                };
                audioList.push(newAudio);
                c.events = [...audioList].sort((a, b) =>
                    (a.date || '') < (b.date || '') ? -1 :
                    (a.date || '') > (b.date || '') ? 1 : 0);
                audioList = c.events;
                console.log(`  ${label} (${tfDate}): created audio object with transcript_href`);
                audioModified = true;
            }
        }
        if (audioModified) casesModified = true;

        const audioTranscripts = new Set();
        for (const a of audioList) {
            if (a.transcript_href && a.date) {
                audioTranscripts.add(`${a.transcript_href}\u0000${a.date}`);
            }
        }
        const isRedundant = f =>
            f?.type === 'transcript'
            && audioTranscripts.has(`${f.href || ''}\u0000${f.date || ''}`);
        if (!files.some(isRedundant)) continue;

        // Dropping an array element automatically shifts every later entry's
        // own implicit (position-based) id down — no gap-closing math needed.
        const newFiles = files.filter(f => !isRedundant(f));
        if (newFiles.length) {
            _writeJson(filesPath, newFiles);
        } else {
            _unlinkSync(filesPath);
            const caseDir = path.dirname(filesPath);
            const remaining = listDir(caseDir).filter(n => !n.startsWith('.'));
            if (remaining.length === 0) {
                try { fs.rmdirSync(caseDir); } catch {}
            }
        }
        const n = toRemove.length;
        console.log(`  ${label}: removed ${n} redundant transcript `
                  + `entr${n === 1 ? 'y' : 'ies'} from files.json`
                  + (newFiles.length ? '' : ' (files.json deleted)'));
        c.files = newFiles.length > 0;
        casesModified = true;
    }
    if (casesModified) _writeJson(casesPath, data);
}

function checkDecisionDates() {} // no-op: dateDecision field is obsolete

// Verbose-only: warn when a case's `votes[]` lists a justice who, by their
// `justices.json` tenure data, was not on the Court on the case's decision
// date. (UNKNOWN JUSTICE / unmapped names are silently skipped.) For each
// case with at least one such mismatch, also print the set of justices who
// *were* serving on the decision date but are absent from `votes[]` (or note
// that no other justices were on the Court that day).
function checkVoteTenures(casesPath, term) {
    if (!_VERBOSE) return;
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    const justiceInfo = _loadJusticeInfo();
    if (!justiceInfo.size) return;

    // Build a deduped catalogue (canonical-name -> tenures) so we don't double-
    // visit a justice through their `alternates` map entries. Preserve
    // insertion order from justices.json (≈ chronological).
    const catalogue = [];
    const seen = new Set();
    for (const [name, info] of justiceInfo.entries()) {
        if (!info || !info.tenures || !info.tenures.length) continue;
        if (seen.has(info)) continue;
        seen.add(info);
        catalogue.push({ name, info });
    }

    for (const c of data) {
        const decision = c.decision || '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(decision) || !Array.isArray(c.votes)) continue;
        const label = c.number || c.id || '?';

        const mismatches = [];   // [name, ranges]
        const listedNames = new Set();
        for (const v of c.votes) {
            if (!v || !v.name) continue;
            const nm = String(v.name).trim().toUpperCase();
            listedNames.add(nm);
            if (nm === 'UNKNOWN JUSTICE') continue;
            const info = justiceInfo.get(nm);
            if (!info || !info.tenures || !info.tenures.length) continue;
            if (_isJusticeOnDate(info, decision)) continue;
            const ranges = info.tenures
                .map(t => `${t.dateStart || '?'}–${t.dateStop || 'present'}`).join(', ');
            mismatches.push([v.name, ranges]);
        }
        if (!mismatches.length) continue;

        for (const [name, ranges] of mismatches) {
            console.log(` NOTICE: ${term}/${label}: vote lists '${name}' but tenure (${ranges}) does not include decision ${decision}`);
        }

        // Justices in service on the decision date who aren't in c.votes.
        const servingButUnlisted = [];
        for (const { name, info } of catalogue) {
            if (!_isJusticeOnDate(info, decision)) continue;
            if (listedNames.has(name)) continue;
            // Skip if any of this justice's alternates is already listed
            // (catalogue dedupes by info ref, so name == primary canonical).
            let alreadyListed = false;
            for (const [alt, altInfo] of justiceInfo.entries()) {
                if (altInfo === info && listedNames.has(alt)) { alreadyListed = true; break; }
            }
            if (alreadyListed) continue;
            servingButUnlisted.push(name);
        }
        if (servingButUnlisted.length) {
            console.log(` NOTICE: ${term}/${label}: justices serving on ${decision} but absent from votes: ${servingButUnlisted.join(', ')}`);
        } else {
            console.log(` NOTICE: ${term}/${label}: no other justices serving on ${decision} are missing from votes`);
        }
    }
}

// Warn when a case has a decision but no `votes` array — typically meaning
// we haven't yet pulled SCDB vote data for it. Checked for every term (no
// "active term" exemption — a case can pick up a decision, and so become
// eligible for this check, at any point). Cases with no oral argument (e.g.
// a cert-denial "relating to orders" entry — see importRelatingToOrdersCases
// in import_ussc.js) are common enough, and often enough not SCDB-trackable
// the same way, that they're only warned about with --verbose; unargued
// cases are still included in the returned count either way, so the
// top-level "N case(s) ... try --scdb" hint stays accurate.
function checkArgumentsHaveVotes(casesPath, term) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return 0;
    let count = 0;
    for (const c of data) {
        if (Array.isArray(c.votes) && c.votes.length) continue;
        if (!c.decision) continue;
        count++;
        const argued = !!(c.argument || c.reargument);
        if (!argued && !_VERBOSE) continue;
        const label = c.number || c.id || '?';
        const decisionUrl = c.decision_loc || c.decision_ussc || c.decision_rep || '';
        const suffix = decisionUrl ? ` (see ${decisionUrl})` : '';
        console.log(`WARNING: ${term}/${label}: has decision but no votes${suffix}`);
    }
    return count;
}

async function checkCaseHrefs(casesPath, term, opinionsOnly = false) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    let dirty = false;
    for (const c of data) {
        const caseLabel = c.number || c.id || '?';
        let headerPrinted = false;
        const printHeader = () => {
            if (!headerPrinted) { console.log(`${caseLabel}:`); headerPrinted = true; }
        };

        for (const [hrefKey, badKey, tag] of [
            ['decision_loc',  'decision_loc_bad',  'loc'],
            ['decision_ussc', 'decision_ussc_bad', 'ussc'],
            ['decision_rep', null,              'rpt'],
        ]) {
            const oh = c[hrefKey] || '';
            if (!oh || !/^https?:\/\//.test(oh)) continue;
            printHeader();
            const lbl = oh.length <= 80 ? oh : oh.slice(0, 77) + '…';
            process.stdout.write(`  [${tag}] ${lbl} `);
            const [ok, headers] = await checkUrl(oh);
            await _politeDelay(oh);
            if (!ok) {
                const status = headers._status || headers._error || 'unknown';
                if (badKey) {
                    console.log(`✗ UNREACHABLE (${status}) — renaming to ${badKey}`);
                    _renameKey(c, hrefKey, badKey);
                } else {
                    console.log(`✗ UNREACHABLE (${status})`);
                }
                dirty = true;
            } else {
                console.log('✓');
            }
        }

        if (opinionsOnly) continue;
        const tagMap = { audio_href: 'a', transcript_href: 't' };
        for (const entry of c.events || []) {
            for (const key of ['audio_href', 'transcript_href']) {
                const href = entry[key] || '';
                if (!href || !/^https?:\/\//.test(href)) continue;
                printHeader();
                const tag = tagMap[key];
                const lbl = href.length <= 80 ? href : href.slice(0, 77) + '…';
                process.stdout.write(`  [${tag}] ${lbl} `);
                const [ok, headers] = await checkUrl(href);
                await _politeDelay(href);
                if (!ok) {
                    const status = headers._status || headers._error || 'unknown';
                    const badKey = key + '_bad';
                    console.log(`✗ UNREACHABLE (${status}) — renaming to ${badKey}`);
                    _renameKey(entry, key, badKey);
                    dirty = true;
                } else {
                    console.log('✓');
                }
            }
        }
    }
    if (dirty) _writeJson(casesPath, data);
}

function _fileTypeFromName(name) {
    const lower = name.toLowerCase();
    if (lower.includes('amicus') || lower.includes('amici')) return 'amicus';
    if (lower.includes('petitioner') || lower.includes('appellant') || lower.includes('plaintiff') || lower.includes('complainant')) return 'petitioner';
    if (lower.includes('respondent') || lower.includes('appellee')  || lower.includes('defendant'))                                 return 'respondent';
    return null;
}

function _titleFromFilename(name) {
    const stem = path.basename(name, path.extname(name)).replace(/[-_]+/g, ' ');
    // Title case (mimic Python str.title): word characters split by non-letter.
    return stem.replace(/[A-Za-z]+('[A-Za-z]+)?/g,
        w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function backfillUntrackedFiles(casesPath, term, dryRun = false) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    const termDir = path.dirname(casesPath);
    for (const c of data) {
        const folderName = _caseFolder(c.number || c.id || '');
        if (!folderName) continue;
        const caseDir = path.join(termDir, 'cases', folderName);
        if (!isDir(caseDir)) continue;
        const filesPath = path.join(caseDir, 'files.json');
        let filesData = [];
        if (fs.existsSync(filesPath)) {
            try { filesData = JSON.parse(fs.readFileSync(filesPath, 'utf8')); }
            catch { continue; }
            if (!Array.isArray(filesData)) continue;
        }
        const relCase = 'cases/' + folderName;
        const tracked = new Set();
        for (const e of filesData) {
            const href = e.href || '';
            if (!/^https?:\/\//.test(href)) tracked.add(path.basename(href));
        }
        let filesModified = false;
        for (const fname of listDir(caseDir)) {
            const fpath = path.join(caseDir, fname);
            if (isDir(fpath) || fname.startsWith('.')) continue;
            const ext = path.extname(fname);
            if (ext === '.json' || ext === '.mp3') continue;
            if (tracked.has(fname)) continue;
            if (dryRun) {
                console.log(`  WARNING: ${folderName}: untracked file '${fname}' may need to be added to files.json`);
                continue;
            }
            const localHref = `/courts/ussc/terms/${term}/${relCase}/${fname}`;
            const rawType = _fileTypeFromName(fname);
            const [ftype, fgroup] = _fileTypeGroup(rawType);
            const newEntry = { type: ftype, group: fgroup, title: _titleFromFilename(fname), href: localHref };
            filesData.push(newEntry);
            tracked.add(fname);
            filesModified = true;
            console.log(`  ${folderName}: added untracked file '${fname}'`);
        }
        if (filesModified) {
            _writeJson(filesPath, filesData);
        }
    }
}

// Valid normalized type and group values for files.json entries.
// Type "reference" never carries a "group" — a reference entry is always
// implicitly grouped under "reference" (see explorer.js's type→group fallback),
// so the redundant property is omitted entirely.
const _FILE_TYPES  = new Set(['brief', 'opinion', 'reference', 'other', 'mp4', 'mp3']);
const _FILE_GROUPS = new Set(['petitioner', 'respondent', 'amicus', 'other', 'media']);

// Map a legacy files.json "type" to [normalizedType, group|null].
// Only called for entries that are NOT already in the normalized format.
// "petitioner"|"respondent"|"amicus" → ["brief",     <original>]
// "reference"                        → ["reference", null]
// "brief"|"opinion"                  → [<original>,  "other"]
// anything else (including missing)  → ["other",     "other"]
function _fileTypeGroup(rawType) {
    if (rawType === 'petitioner' || rawType === 'respondent' || rawType === 'amicus')
        return ['brief', rawType];
    if (rawType === 'reference')
        return ['reference', null];
    if (rawType === 'brief' || rawType === 'opinion')
        return [rawType, 'other'];
    return ['other', 'other'];
}

// Return the correct group for a given normalized type, or null when the
// group should be omitted. "reference" never has a group; everything else
// keeps its group.
function _canonicalGroup(type, group) {
    if (type === 'reference') return null;
    if (type === 'mp4' || type === 'mp3') return 'media';
    return group;
}

// Return a normalized copy of a files.json entry with property order:
// type → group → (remaining keys in original order). "group" is omitted for
// type "reference" entries.
// If the entry already has valid type+group values, they are preserved as-is
// (subject to _canonicalGroup); otherwise the legacy type is mapped via _fileTypeGroup().
function _normalizeFileEntry(entry) {
    if (!entry || typeof entry !== 'object') return entry;
    let newType, newGroup;
    if (_FILE_TYPES.has(entry.type) && (entry.type === 'reference' || _FILE_GROUPS.has(entry.group))) {
        newType  = entry.type;
        newGroup = _canonicalGroup(entry.type, entry.group);
    } else {
        [newType, newGroup] = _fileTypeGroup(entry.type || null);
    }
    const rebuilt = {};
    rebuilt.type = newType;
    if (newGroup != null) rebuilt.group = newGroup;
    for (const [k, v] of Object.entries(entry)) {
        if (k !== 'type' && k !== 'group') rebuilt[k] = v;
    }
    return rebuilt;
}

// Returns true if entry already has valid type, group, and property order.
function _fileEntryIsNormalized(entry) {
    if (!entry || typeof entry !== 'object') return true;
    if (!_FILE_TYPES.has(entry.type)) return false;
    const keys = Object.keys(entry);
    const ti = keys.indexOf('type');
    if (ti !== 0) return false;
    if (entry.type === 'reference') return !('group' in entry);
    if (!_FILE_GROUPS.has(entry.group)) return false;
    if (entry.group !== _canonicalGroup(entry.type, entry.group)) return false;
    const gi = keys.indexOf('group');
    return gi >= 0 && gi === ti + 1;
}

// Normalize every file entry in files.json across all cases in the given term(s).
// Property-order rule: type → group → (rest).
// Type-mapping rules: see _fileTypeGroup().
function cleanupFilesJson(termFilter, caseFilter, dryRun = false) {
    const termsDir = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
    const termDirs = termFilter
        ? [termFilter]
        : fs.readdirSync(termsDir).filter(n => /^\d{4}-\d{2}$/.test(n)).sort();

    let totalFiles = 0, totalChanged = 0;
    for (const term of termDirs) {
        const casesDir = path.join(termsDir, term, 'cases');
        if (!fs.existsSync(casesDir)) continue;
        const folders = fs.readdirSync(casesDir).filter(n => !n.startsWith('.'));
        for (const folder of folders) {
            if (caseFilter && folder !== caseFilter) continue;
            const filesPath = path.join(casesDir, folder, 'files.json');
            if (!fs.existsSync(filesPath)) continue;
            let data;
            try { data = _readJson(filesPath); } catch { continue; }
            if (!Array.isArray(data)) continue;

            let changed = false;
            const normalized = data.map(entry => {
                if (_fileEntryIsNormalized(entry)) return entry;
                changed = true;
                return _normalizeFileEntry(entry);
            });

            if (changed) {
                totalChanged++;
                console.log(`  ${term}/${folder}: updated files.json`);
                _writeJson(filesPath, normalized);
            }
            totalFiles++;
        }
    }
    console.log(`cleanupFilesJson: checked ${totalFiles} files.json, updated ${totalChanged}.`);
}

// For files.json files where every entry has type="brief" and group="other",
// reclassify: type → "file"; group → "briefs" if title contains "brief" (case-
// insensitive), otherwise "other".
function tidyFilesJson(termFilter, caseFilter) {
    const termsDir = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
    const termDirs = termFilter
        ? [termFilter]
        : fs.readdirSync(termsDir).filter(n => /^\d{4}-\d{2}$/.test(n)).sort();

    let totalFiles = 0, totalChanged = 0;
    for (const term of termDirs) {
        const casesDir = path.join(termsDir, term, 'cases');
        if (!fs.existsSync(casesDir)) continue;
        for (const folder of fs.readdirSync(casesDir).filter(n => !n.startsWith('.'))) {
            if (caseFilter && folder !== caseFilter) continue;
            const filesPath = path.join(casesDir, folder, 'files.json');
            if (!fs.existsSync(filesPath)) continue;
            let data;
            try { data = _readJson(filesPath); } catch { continue; }
            if (!Array.isArray(data) || !data.length) continue;

            // Only process files where every entry is type=brief, group=other.
            if (!data.every(e => e.type === 'brief' && e.group === 'other')) continue;

            const updated = data.map(e => ({
                ...e,
                type: 'file',
                group: /brief/i.test(e.title || '') ? 'briefs' : 'other',
            }));

            totalFiles++;
            if (!_jsonChanged(filesPath, updated)) continue;
            totalChanged++;
            console.log(`  ${term}/${folder}: tidied files.json`);
            _writeJson(filesPath, updated);
        }
    }
    console.log(`tidyFilesJson: checked ${totalFiles} qualifying files.json, updated ${totalChanged}.`);
}

function checkAudioDates(casesPath, term, dryRun = false) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    let modified = false;
    for (const c of data) {
        const label = c.number || c.id || '?';
        const title = firstTitle(c.title) || '';
        const argDates = [], reargDates = [], opDates = [];
        const events = c.events || [];
        for (let i = 0; i < events.length; i++) {
            const audio = events[i];
            const atype = audio.type || '';
            const date  = audio.date || '';
            if (atype === 'argument') {
                if (!date) console.log(`WARNING: ${term}/${label} (${title.slice(0,40)}): audio[${i}] (argument) missing date`);
                else argDates.push(date);
            } else if (atype === 'reargument') {
                if (!date) console.log(`WARNING: ${term}/${label} (${title.slice(0,40)}): audio[${i}] (reargument) missing date`);
                else reargDates.push(date);
            } else if (atype === 'decision') {
                if (!date) console.log(`WARNING: ${term}/${label} (${title.slice(0,40)}): audio[${i}] (opinion) missing date`);
                else opDates.push(date);
            }
        }

        // argument
        if (argDates.length) {
            const audioSet = new Set(argDates);
            const current  = c.argument || '';
            const currentDates = current ? new Set(current.split(',')) : new Set();
            const subset = [...audioSet].every(d => currentDates.has(d));
            if (!subset) {
                const union = _sortStr(new Set([...currentDates, ...audioSet]));
                const expected = union.join(',');
                const intersect = [...currentDates].some(d => audioSet.has(d));
                const prefix = (current && !intersect) ? 'WARNING' : ' NOTICE';
                if (prefix === 'WARNING' || _VERBOSE) console.log(`${prefix}: ${term}/${label} (${title.slice(0,40)}): argument='${current}' → should be '${expected}'`);
                if (!dryRun) {
                    if ('argument' in c) c.argument = expected;
                    else _insertKeyBefore(c, 'argument', expected, 'decision');
                    modified = true;
                }
            }
        }
        // reargument
        if (reargDates.length) {
            const audioSet = new Set(reargDates);
            const current  = c.reargument || '';
            const currentDates = current ? new Set(current.split(',')) : new Set();
            const subset = [...audioSet].every(d => currentDates.has(d));
            if (!subset) {
                const union = _sortStr(new Set([...currentDates, ...audioSet]));
                const expected = union.join(',');
                const intersect = [...currentDates].some(d => audioSet.has(d));
                const prefix = (current && !intersect) ? 'WARNING' : ' NOTICE';
                if (prefix === 'WARNING' || _VERBOSE) console.log(`${prefix}: ${term}/${label} (${title.slice(0,40)}): reargument='${current}' → should be '${expected}'`);
                if (!dryRun) {
                    if ('reargument' in c) c.reargument = expected;
                    else if ('argument' in c) {
                        const newCase = {};
                        for (const [k, v] of Object.entries(c)) {
                            newCase[k] = v;
                            if (k === 'argument') newCase.reargument = expected;
                        }
                        for (const k of Object.keys(c)) delete c[k];
                        Object.assign(c, newCase);
                    } else {
                        _insertKeyBefore(c, 'reargument', expected, 'decision');
                    }
                    modified = true;
                }
            }
        }
        // decision (from opinion audio)
        if (opDates.length) {
            const uniq = _sortStr(new Set(opDates));
            if (uniq.length > 1) {
                console.log(`WARNING: ${term}/${label} (${title.slice(0,40)}): multiple distinct opinion audio dates: [${uniq.map(d=>`'${d}'`).join(', ')}]`);
            }
            const expected = uniq[0];
            const current  = c.decision || '';
            if (current !== expected) {
                const prefix = current ? 'WARNING' : ' NOTICE';
                if (prefix === 'WARNING' || _VERBOSE) console.log(`${prefix}: ${term}/${label} (${title.slice(0,40)}): decision='${current}' → should be '${expected}' (from opinion audio)`);
                if (!dryRun) {
                    if ('decision' in c) c.decision = expected;
                    else _insertKeyBefore(c, 'decision', expected, 'volume');
                    modified = true;
                }
            }
        }
    }
    if (modified) {
        _writeJson(casesPath, data);
        if (_VERBOSE) console.log(` NOTICE: ${term}/cases.json: fixed argument/decision dates from audio`);
    }
}

function _hasDecisionHref(c) {
    return !!(c.decision_loc || c.decision_ussc || c.decision_rep);
}

function warnMissingOpinionHref(casesPath, term) {
    if (_isCurrentTerm(term)) return;
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    for (const c of data) {
        if (_hasDecisionHref(c)) continue;
        const label = c.number || c.id || '?';
        const title = firstTitle(c.title) || '';
        if (_VERBOSE) console.log(` NOTICE: ${term}/${label} (${title.slice(0,40)}): no decision href`);
    }
}

function warnOpinionHrefWithoutDecision(casesPath, term) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    for (const c of data) {
        if (!_hasDecisionHref(c) || c.decision) continue;
        const label = c.number || c.id || '?';
        const title = firstTitle(c.title) || '';
        console.log(`WARNING: ${term}/${label} (${title.slice(0,40)}): has decision href but no decision date`);
    }
}

// Convert a roman numeral string (e.g. "cxxv") to an integer, or NaN if the
// string contains non-roman characters.
function _parseRomanNumeral(s) {
    const vals = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
    let total = 0, prev = 0;
    for (const ch of s.toLowerCase().split('').reverse()) {
        const v = vals[ch];
        if (!v) return NaN;
        if (v < prev) total -= v; else total += v;
        prev = v;
    }
    return total > 0 ? total : NaN;
}

// Parse a pages string like "1:85,801:717" into a sorted array of
// {start, pdfPage} breakpoints. Roman numeral starts (e.g. "vi:490") are
// tagged with roman:true and startStr, and sorted after all arabic breakpoints.
function _parsePages(str) {
    if (!str) return [];
    const entries = [];
    for (const s of str.split(',')) {
        const t = s.trim();
        if (!t) continue;
        const colon = t.indexOf(':');
        if (colon < 0) continue;
        const startStr = t.slice(0, colon).trim();
        const pdfPage  = Number(t.slice(colon + 1).trim());
        if (!Number.isFinite(pdfPage) || pdfPage <= 0) continue;
        const startNum = Number(startStr);
        if (Number.isFinite(startNum) && startNum > 0) {
            entries.push({ start: startNum, pdfPage });
        } else {
            const romanVal = _parseRomanNumeral(startStr);
            if (Number.isFinite(romanVal) && romanVal > 0) {
                entries.push({ start: romanVal, pdfPage, roman: true, startStr });
            }
        }
    }
    // Arabic breakpoints first (sorted by start), then roman (sorted by start).
    return entries.sort((a, b) => {
        if (!!a.roman !== !!b.roman) return a.roman ? 1 : -1;
        return a.start - b.start;
    });
}

// Given parsed pages breakpoints and a US Reports page number, return
// the corresponding PDF page, or null if no applicable breakpoint is found.
// Pass roman=true to look up a roman-numeral page (e.g. "cxxv" → 125).
function _pdfPageFor(pages, reportPage, roman = false) {
    const bps = pages.filter(e => !!e.roman === roman);
    if (!bps.length) return null;
    let match = null;
    for (const e of bps) {
        if (e.start <= reportPage) match = e;
        else break;
    }
    if (!match) return null;
    return reportPage + (match.pdfPage - match.start);
}

// Convert a raw numeric page offset (PDF page of US Reports page 1, minus 1)
// to the "1:<offset+1>" pages string, or null if the offset is invalid.
function _offsetToPages(offset) {
    if (offset == null || offset < 0) return null;
    return `1:${offset + 1}`;
}

// Extract the numeric offset for the first breakpoint from a pages
// string (used to compute the cover page for US Reports page 1).
function _pagesToOffset(str) {
    const parsed = _parsePages(str).filter(e => !e.roman);
    if (!parsed.length) return null;
    return parsed[0].pdfPage - parsed[0].start;
}

// Read the pages value from a reports.json entry, supporting both the
// new {pages} format and the legacy {page_offset} format.
// Returns: a string (known mapping), null (tried but failed), or undefined (not in db).
function _reportsDbPages(entry) {
    if (!entry || typeof entry !== 'object') return undefined;
    if ('pages' in entry) return entry.pages;
    if (typeof entry.page_offset === 'number') {
        return entry.page_offset >= 0 ? _offsetToPages(entry.page_offset) : null;
    }
    return undefined;
}

// Build/update the decision_rep field on each case whose usCite contains
// "<volume> U.S. <page>" and whose volume matches an entry in the term's reports
// array. The value is reports[].href + "#page=<pdfPage>" where pdfPage is
// derived from the report's pages breakpoints.
function addDecisionReports(casesPath, termEntry, caseFilter = '') {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    const reports = termEntry?.reports || [];
    if (!reports.length) return;

    // Build a lookup from volume number to report entry.
    const byVolume = new Map();
    for (const r of reports) {
        if (r.volume != null) byVolume.set(Number(r.volume), r);
    }

    let modified = false;
    for (const c of data) {
        if (caseFilter && c.number !== caseFilter && c.id !== caseFilter) continue;
        // If decision_rep already carries an explicit #page=N, leave it alone.
        if (/#page=\d+$/.test(c.decision_rep || '')) continue;
        const usCite = (c.usCite || '').trim();
        if (!usCite) continue;
        const m = /^(\d+)\s+U\.S\.\s+(\d+|[ivxlcdmIVXLCDM]+)$/.exec(usCite);
        if (!m) continue;
        const vol    = parseInt(m[1], 10);
        const report = byVolume.get(vol);
        if (!report?.href) continue;
        const roman = !/^\d+$/.test(m[2]);
        const page  = roman ? _parseRomanNumeral(m[2]) : parseInt(m[2], 10);
        let url = report.href;
        if (isFinite(page) && report.pages) {
            const pdfPage = _pdfPageFor(_parsePages(report.pages), page, roman);
            if (pdfPage != null) url += `#page=${pdfPage}`;
        }
        if (c.decision_rep === url) continue;
        c.decision_rep = url;
        const reordered = reorderCase(c);
        for (const k of Object.keys(c)) delete c[k];
        Object.assign(c, reordered);
        modified = true;
    }
    if (modified) _writeJson(casesPath, data);
}

// Remove decision_loc links that reference a US Reports page in the second (or
// later) pages segment of a multi-book bound volume. The Library of
// Congress only digitized the first physical book, so those URLs do not exist.
// A LOC URL encodes volume and page as: usrep{vol3}{page}/usrep{vol3}{page}.pdf
function pruneSecondSegmentDecisionLoc(casesPath, termEntry, caseFilter = '') {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    const reports = termEntry?.reports || [];

    // Build a map from volume number → first US Reports page of the second segment.
    const secondSegmentStart = new Map();
    for (const r of reports) {
        if (!r.volume || !r.pages) continue;
        const bps = _parsePages(r.pages).filter(e => !e.roman);
        if (bps.length >= 2) secondSegmentStart.set(Number(r.volume), bps[1].start);
    }
    if (!secondSegmentStart.size) return;

    let modified = false;
    for (const c of data) {
        if (caseFilter && c.number !== caseFilter && c.id !== caseFilter) continue;
        const loc = c.decision_loc || '';
        if (!loc) continue;
        // Parse the LOC URL: ...usrep{vol3}{page}/usrep{vol3}{page}.pdf
        const m = /usrep(\d{3})(\d+)\/usrep\d+\.pdf$/i.exec(loc);
        if (!m) continue;
        const vol  = parseInt(m[1], 10);
        const page = parseInt(m[2], 10);
        const breakStart = secondSegmentStart.get(vol);
        if (breakStart !== undefined && page >= breakStart) {
            delete c.decision_loc;
            const reordered = reorderCase(c);
            for (const k of Object.keys(c)) delete c[k];
            Object.assign(c, reordered);
            modified = true;
        }
    }
    if (modified) _writeJson(casesPath, data);
}

// Remove redundant `volume`/`page` properties when they match the citation
// numbers derived from `usCite` (e.g. usCite "584 U.S. 1" with volume "584"
// and page "1"). For a roman-numeral page (e.g. "131 U.S. clxxxvi" — an
// appendix/table page), there's no second arabic number to compare against;
// the legacy `page` value for those is instead a numeric surrogate key of the
// form 9000 + <arabic value of the roman numeral>, so it's compared against
// that formula instead.
// Verbose mode reports any discrepancies between volume/page and usCite numbers.
function pruneRedundantCitation(casesPath, term, caseFilter = '') {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    let modified = false;
    for (const c of data) {
        if (caseFilter && c.number !== caseFilter && c.id !== caseFilter) continue;
        const usCite = c.usCite || '';
        if (!usCite) continue;
        const nums = usCite.match(/\d+/g);
        if (!nums || nums.length < 1) continue;
        let citeVol, citePage, romanPage = null;
        if (nums.length >= 2) {
            citeVol  = String(parseInt(nums[0], 10));
            citePage = String(parseInt(nums[1], 10));
        } else {
            const rm = /U\.S\.\s+([ivxlcdmIVXLCDM]+)\s*$/.exec(usCite.trim());
            const rv = rm ? _parseRomanNumeral(rm[1]) : NaN;
            if (!Number.isFinite(rv)) continue;
            citeVol   = String(parseInt(nums[0], 10));
            citePage  = String(9000 + rv);
            romanPage = rm[1];
        }
        const label    = c.number || c.id || '?';
        const hasVol   = 'volume' in c;
        const hasPage  = 'page'   in c;
        const vol      = hasVol  ? String(parseInt(c.volume, 10)) : null;
        const page     = hasPage ? String(parseInt(c.page,   10)) : null;
        const volMatch  = hasVol  && vol  === citeVol;
        const pageMatch = hasPage && page === citePage;
        if (hasVol && !volMatch && _VERBOSE) {
            console.log(` NOTICE: ${term}/${label}: volume='${c.volume}' but usCite='${usCite}' has volume ${citeVol}`);
        }
        if (hasPage && !pageMatch && _VERBOSE) {
            console.log(` NOTICE: ${term}/${label}: page='${c.page}' but usCite='${usCite}' has page ${citePage}${romanPage ? ` (roman '${romanPage}')` : ''}`);
        }
        if (volMatch || pageMatch) {
            const verb = _DRY_RUN ? 'would remove' : 'removed';
            const removed = [];
            if (volMatch)  { removed.push(`volume='${c.volume}'`);  if (!_DRY_RUN) delete c.volume; }
            if (pageMatch) { removed.push(`page='${c.page}'`);      if (!_DRY_RUN) delete c.page;   }
            if (_VERBOSE) console.log(` NOTICE: ${term}/${label}: ${verb} redundant ${removed.join(', ')} (usCite='${usCite}')`);
            if (!_DRY_RUN) modified = true;
        }
    }
    if (modified) _writeJson(casesPath, data);
}

async function verifyFilesJson(filesPath, caseDir, checkUrls, printHeader, opinionsOnly) {
    let data;
    try { data = JSON.parse(fs.readFileSync(filesPath, 'utf8')); } catch { return; }
    if (!Array.isArray(data)) return;
    if (!checkUrls || opinionsOnly) return;

    let modified = false;
    for (const [i, entry] of data.entries()) {
        const href = entry.href || '';
        const fileNum = i + 1;
        if (!/^https?:\/\//.test(href)) continue;
        if (entry.source) {
            if (printHeader) printHeader();
            console.log(`  [${fileNum}] already localized — skipped.`);
            continue;
        }
        if (printHeader) printHeader();
        const lbl = href.length <= 80 ? href : href.slice(0, 77) + '…';
        process.stdout.write(`  [${fileNum}] ${lbl} `);
        const [ok, headers] = await checkUrl(href);
        await _politeDelay(href);
        if (!ok) {
            const status = headers._status || headers._error || 'unknown';
            console.log(`✗ UNREACHABLE (${status}) — renaming to href_bad`);
            _renameKey(entry, 'href', 'href_bad');
            modified = true;
            continue;
        }
        if (isFramingBlocked(headers)) {
            const localName = _localFilename(href);
            const dest = _uniqueDest(caseDir, localName);
            process.stdout.write(`⚠ framing blocked → ${path.basename(dest)} ... `);
            try {
                await _downloadFile(href, dest);
                entry.source = entry.href;
                entry.href = '/' + path.relative(REPO_ROOT, dest).split(path.sep).join('/');
                modified = true;
                console.log('✓ downloaded');
            } catch (exc) {
                console.log(`ERROR: ${exc.message || exc}`);
            }
            await sleep(300);
        } else {
            console.log('✓');
        }
    }
    if (modified) {
        _writeJson(filesPath, data);
    }
}

async function verifyCase(termDir, caseNumber, checkUrls, opinionsOnly) {
    const filesPath = path.join(termDir, 'cases', caseNumber, 'files.json');
    if (!fs.existsSync(filesPath)) return;
    const printed = [false];
    const printHeader = () => {
        if (!printed[0]) { console.log(`${caseNumber}:`); printed[0] = true; }
    };
    await verifyFilesJson(filesPath, path.dirname(filesPath), checkUrls, printHeader, opinionsOnly);
    if (opinionsOnly) await checkOpinionForCase(filesPath, caseNumber, path.basename(termDir), printHeader);
}

function deduplicateCases(casesPath) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    const termDir = path.dirname(casesPath);
    const term = path.basename(termDir);

    const isStub = (c) => {
        if (c.id || c.votes) return false;
        return (c.events || []).every(a => !a.audio_href && a.transcript_href);
    };

    const compToIdx = {};
    const duplicates = [];
    for (let i = 0; i < data.length; i++) {
        const c = data[i];
        const raw = c.number || '';
        if (!raw) continue;
        for (const part of raw.split(',').map(p => p.trim()).filter(Boolean)) {
            if (part in compToIdx) {
                const otherIdx = compToIdx[part];
                const other = data[otherIdx];
                if (isStub(c) && !isStub(other)) duplicates.push([otherIdx, i]);
                else if (isStub(other) && !isStub(c)) duplicates.push([i, otherIdx]);
                else {
                    const stem = (t) => String(t || '').split('(')[0].trim().toLowerCase();
                    const sameTitle = stem(firstTitle(c.title)) && stem(firstTitle(c.title)) === stem(firstTitle(other.title));
                    if (sameTitle) {
                        // Same case split across multiple entries; skip silently.
                    } else if (term < '1955-10') {
                        if (_VERBOSE) console.log(` NOTICE: ${term}: '${raw}' and '${other.number}' share component '${part}' but neither is clearly a stub — skipping`);
                    } else {
                        console.log(`WARNING: ${term}: '${raw}' and '${other.number}' share component '${part}' but neither is clearly a stub — skipping`);
                    }
                }
            } else {
                compToIdx[part] = i;
            }
        }
    }
    if (!duplicates.length) return;

    const processedStubs = new Set();
    const toRemove = new Set();

    for (const [completeIdx, stubIdx] of duplicates) {
        if (processedStubs.has(stubIdx)) continue;
        processedStubs.add(stubIdx);
        const complete = data[completeIdx];
        const stub     = data[stubIdx];
        const label    = complete.number || complete.id || '?';
        const stubNum  = stub.number || stub.id || '?';
        const stubFolder = _caseFolder(stub.number || stub.id || '');
        const stubDir = path.join(termDir, 'cases', stubFolder);
        const stubFilesPath = path.join(stubDir, 'files.json');

        // Step 1
        if (fs.existsSync(stubFilesPath)) {
            let stubFiles = [];
            try { stubFiles = JSON.parse(fs.readFileSync(stubFilesPath, 'utf8')); } catch {}
            if (Array.isArray(stubFiles)) {
                const audioTHrefs = new Set(
                    (stub.events || []).filter(a => a.transcript_href).map(a => a.transcript_href));
                const cleaned = stubFiles.filter(f => !(
                    f?.type === 'transcript' && audioTHrefs.has(f.href || '')));
                if (cleaned.length < stubFiles.length) {
                    if (cleaned.length) {
                        _writeJson(stubFilesPath, cleaned);
                    } else {
                        _unlinkSync(stubFilesPath);
                    }
                    console.log(`  ${stubNum}: cleaned redundant transcript entries from files.json`);
                }
            }
        }

        // Step 2: merge audio
        if (!complete.events) complete.events = [];
        const compAudio = complete.events;
        for (const stubAudio of stub.events || []) {
            const date = stubAudio.date;
            const transcriptHref = stubAudio.transcript_href;
            const matchedComp = compAudio.find(a => a.date === date) || null;
            if (matchedComp !== null) {
                if (transcriptHref && !matchedComp.transcript_href) {
                    matchedComp.transcript_href = transcriptHref;
                    console.log(`  ${label} (${date}): merged transcript_href from stub ${stubNum}`);
                } else if (transcriptHref && matchedComp.transcript_href !== transcriptHref) {
                    const entry = { ...stubAudio };
                    if (!entry.title && transcriptHref) {
                        let stubFilesNow = [];
                        if (fs.existsSync(stubFilesPath)) {
                            try { stubFilesNow = JSON.parse(fs.readFileSync(stubFilesPath, 'utf8')); } catch {}
                        }
                        const tfm = (Array.isArray(stubFilesNow) ? stubFilesNow : []).find(
                            f => f?.type === 'transcript' && f.href === transcriptHref);
                        if (tfm) {
                            const rawT = tfm.title || '';
                            entry.title = rawT.replace(/^Transcript of\s+/, '').trim() || rawT;
                        }
                    }
                    compAudio.push(entry);
                    console.log(`  ${label} (${date}): appended distinct transcript audio from stub ${stubNum}`);
                }
            } else {
                const entry = { ...stubAudio };
                if (!entry.title && transcriptHref) {
                    let stubFilesNow = [];
                    if (fs.existsSync(stubFilesPath)) {
                        try { stubFilesNow = JSON.parse(fs.readFileSync(stubFilesPath, 'utf8')); } catch {}
                    }
                    const tfm = (Array.isArray(stubFilesNow) ? stubFilesNow : []).find(
                        f => f?.type === 'transcript' && f.href === transcriptHref);
                    if (tfm) {
                        const rawT = tfm.title || '';
                        entry.title = rawT.replace(/^Transcript of\s+/, '').trim() || rawT;
                    }
                }
                compAudio.push(entry);
                console.log(`  ${label} (${date}): appended unique audio entry from stub ${stubNum}`);
            }
        }
        complete.events = [...compAudio].sort((a, b) =>
            (a.date || '') < (b.date || '') ? -1 :
            (a.date || '') > (b.date || '') ? 1 : 0);

        // Step 3: merge remaining files.json entries
        if (fs.existsSync(stubFilesPath)) {
            let stubFiles = [];
            try { stubFiles = JSON.parse(fs.readFileSync(stubFilesPath, 'utf8')); } catch {}
            if (Array.isArray(stubFiles) && stubFiles.length) {
                const compFolder = _caseFolder(complete.number || complete.id || '');
                const compDir = path.join(termDir, 'cases', compFolder);
                const compFilesPath = path.join(compDir, 'files.json');
                _mkdirSync(compDir, { recursive: true });
                let compFiles = [];
                if (fs.existsSync(compFilesPath)) {
                    try { compFiles = JSON.parse(fs.readFileSync(compFilesPath, 'utf8')); } catch {}
                }
                const existingHrefs = new Set(compFiles.map(f => f.href));
                let added = 0;
                for (const sf of stubFiles) {
                    if (!existingHrefs.has(sf.href)) {
                        compFiles.push({ ...sf });
                        existingHrefs.add(sf.href);
                        added++;
                    }
                }
                if (added) {
                    _writeJson(compFilesPath, compFiles);
                    console.log(`  ${label}: merged ${added} file(s) from stub ${stubNum} into files.json`);
                }
                _unlinkSync(stubFilesPath);
            }
        }

        // Step 4
        if (fs.existsSync(stubDir)) {
            const remaining = listDir(stubDir).filter(n => !n.startsWith('.'));
            if (!remaining.length) {
                try { fs.rmdirSync(stubDir); console.log(`  Removed empty stub folder ${stubFolder}/`); }
                catch {}
            } else {
                console.log(`  WARNING: stub folder ${stubFolder}/ still has files: ${remaining.join(', ')}`);
            }
        }
        toRemove.add(stubIdx);
    }

    const kept = data.filter((_, i) => !toRemove.has(i));
    _writeJson(casesPath, kept);
    console.log(`  Removed ${toRemove.size} duplicate stub entry(ies) from ${path.basename(casesPath)}.`);
}

function checkDuplicateCaseIds(termDir, term) {
    const casesPath = path.join(termDir, 'cases.json');
    if (!fs.existsSync(casesPath)) return;
    const cases = _readJson(casesPath);
    const seen = {};
    for (const c of cases) {
        const id = c.id || '';
        if (!id) continue;
        if (id in seen) {
            console.log(`WARNING: ${term}: duplicate case id '${id}' in cases.json`);
        } else {
            seen[id] = true;
        }
    }
}

function checkDuplicateCaseNumbers(termDir, term, verbose = false) {
    const casesPath = path.join(termDir, 'cases.json');
    if (!fs.existsSync(casesPath)) return;
    const earlyTerm = term < '1950-10';
    const cases = _readJson(casesPath);
    const seen = {};
    const titleStem = (t) => String(t || '').split('(')[0].trim().toLowerCase();
    for (const c of cases) {
        const number = c.number || '';
        if (!number) continue;
        const key = number.toLowerCase();
        if (key in seen) {
            const prev = seen[key];
            const sameTitle = titleStem(firstTitle(c.title)) && titleStem(firstTitle(c.title)) === titleStem(firstTitle(prev.title));
            if (sameTitle) continue;
            if (earlyTerm) {
                if (verbose) console.log(` NOTICE: ${term}/${number}: duplicate case number in cases.json: '${prev.number}' and '${number}'`);
            } else {
                console.log(`WARNING: ${term}/${number}: duplicate case number in cases.json: '${prev.number}' and '${number}'`);
            }
        } else {
            seen[key] = c;
        }
    }
}

function checkDuplicateAudioHrefs(termDir) {
    const casesPath = path.join(termDir, 'cases.json');
    if (!fs.existsSync(casesPath)) return;
    const cases = _readJson(casesPath);
    for (const c of cases) {
        const number = c.number || '?';
        const seen = {};
        const events = c.events || [];
        for (let i = 0; i < events.length; i++) {
            const href = events[i].audio_href || '';
            if (!href) continue;
            const turn   = 'turn'   in events[i] ? events[i].turn   : undefined;
            const offset = 'offset' in events[i] ? events[i].offset : undefined;
            const key = `${href}\0${turn}`;
            if (key in seen) {
                if (seen[key].offset === offset) {
                    console.log(`WARNING: ${number}: duplicate audio_href at audio[${seen[key].i}] and audio[${i}]: '${href}'`);
                }
            } else {
                seen[key] = { i, offset };
            }
        }
    }
}

function checkCasesSync(termDir, verbose = false) {
    const casesPath = path.join(termDir, 'cases.json');
    const casesDir  = path.join(termDir, 'cases');
    if (!fs.existsSync(casesPath)) return;
    const term = path.basename(termDir);
    const cases = _readJson(casesPath);

    const jsonNumbers = {};   // number → case
    for (const c of cases) {
        const raw = c.number || '';
        if (!raw) continue;
        jsonNumbers[raw] = c;
    }
    const jsonFolders = {};
    for (const [num, c] of Object.entries(jsonNumbers)) {
        jsonFolders[_caseFolder(num)] = c;
    }
    const diskFolders = new Set(
        isDir(casesDir)
            ? fs.readdirSync(casesDir).filter(n => isDir(path.join(casesDir, n)))
            : []);

    // 1
    for (const number of _sortStr(Object.keys(jsonNumbers))) {
        const c = jsonNumbers[number];
        const folder = _caseFolder(number);
        if (!diskFolders.has(folder)) {
            // A case folder is only required when there's something to put in
            // it — either `files: true` (i.e. a non-empty files.json) or an
            // event with a local text_href that resolves into THIS folder.
            // text_hrefs that point at another case folder (e.g. consolidated
            // cases share a transcript file) don't require a folder here.
            const hasLocalText = (c.events || []).some(a => {
                const href = a.text_href;
                if (!href || href.startsWith('http')) return false;
                const slash = href.indexOf('/');
                if (slash < 0) return true; // bare filename → lives in this folder
                return href.slice(0, slash) === folder;
            });
            const hasContent = !!c.files || hasLocalText;
            if (hasContent) {
                console.log(`WARNING: ${term}: ${number} in cases.json but no folder at cases/${folder}/`);
            }
        }
    }
    // 2 (moved below — needs `allReferenced` built first)
    // 3 & 4
    const dateJsonRe = /^\d{4}-\d{2}-\d{2}.*\.json$/;
    const partTitleRe = /\bPart\s+(\d+)\b/i;
    const partFileRe  = /-(\d+)\.json$/;
    // Build a global set of referenced `<folder>/<file>` paths across ALL
    // cases — a file in one case folder may be referenced by another case's
    // event (e.g. consolidated cases share transcripts).
    const allReferenced = new Set();
    for (const c of cases) {
        const ownFolder = _caseFolder(c.number || '');
        for (const audio of c.events || []) {
            const th = audio.text_href || '';
            if (!th || /^https?:\/\//.test(th)) continue;
            const relPath = th.includes('/') ? th : `${ownFolder}/${th}`;
            allReferenced.add(relPath);
        }
    }
    // 2: orphan folders — only warn about files inside that aren't referenced
    // by any case's text_href; skip entirely if all transcripts are referenced.
    for (const folder of _sortStr(diskFolders)) {
        if (folder in jsonFolders) continue;
        const caseDir = path.join(casesDir, folder);
        const onDisk = fs.readdirSync(caseDir)
            .filter(f => isFile(path.join(caseDir, f)) && dateJsonRe.test(f))
            .map(f => `${folder}/${f}`);
        const unreferenced = onDisk.filter(rel => !allReferenced.has(rel));
        for (const rel of _sortStr(unreferenced)) {
            console.log(`WARNING: ${term}: cases/${rel} on disk but not referenced in any case's events`);
        }
    }
    for (const number of _sortStr(Object.keys(jsonNumbers))) {
        const c = jsonNumbers[number];
        const folder = _caseFolder(number);
        if (!diskFolders.has(folder)) continue;
        const caseDir = path.join(casesDir, folder);
        const referenced = new Set();
        for (const audio of c.events || []) {
            const th = audio.text_href || '';
            if (!th || /^https?:\/\//.test(th)) continue;
            const relPath = th.includes('/') ? th : `${folder}/${th}`;
            referenced.add(relPath);
            const tm = partTitleRe.exec(audio.title || '');
            if (tm) {
                const expected = tm[1];
                const fm = partFileRe.exec(th);
                const actual = fm ? fm[1] : null;
                if (actual !== expected) {
                    console.log(`WARNING: ${term}: ${number}: title says Part ${expected} but text_href '${th}' has suffix -${actual || 'none'}`);
                }
            }
        }
        const onDisk = isDir(caseDir)
            ? new Set(fs.readdirSync(caseDir).filter(f =>
                isFile(path.join(caseDir, f)) && dateJsonRe.test(f)
            ).map(f => `${folder}/${f}`))
            : new Set();
        for (const rel of _sortStr([...referenced].filter(x => !fs.existsSync(path.join(casesDir, x))))) {
            console.log(`WARNING: ${term}: ${number}: audio text_href '${rel}' not found on disk`);
        }
        for (const rel of _sortStr([...onDisk].filter(x => !allReferenced.has(x)))) {
            console.log(`WARNING: ${term}: ${number}: ${rel} on disk but not referenced in any case's events`);
        }
    }
}

// ═══════════════
// fix_cases logic
// ═══════════════

const _NON_TRANSCRIPT_NAMES    = new Set(['files.json']);
const _NON_TRANSCRIPT_SUFFIXES = ['--whisper'];

function _reorderWithUnknowns(obj, order) {
    const known = {};
    for (const k of order) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) known[k] = obj[k];
    }
    const orderSet = new Set(order);
    const unknownKeys = new Set();
    const extras = {};
    for (const k of Object.keys(obj)) {
        if (!orderSet.has(k)) { unknownKeys.add(k); extras[k] = obj[k]; }
    }
    return [{ ...known, ...extras }, unknownKeys];
}

function fixKeyOrder(term, cases, dryRun) {
    let casesChanged = 0, eventsChanged = 0;
    const unknownCaseKeys = new Set();
    const unknownEventKeys = new Set();
    for (const c of cases) {
        for (const event of c.events || []) {
            const [newEvent, evUnknown] = _reorderWithUnknowns(event, EVENT_KEY_ORDER);
            for (const k of evUnknown) unknownEventKeys.add(k);
            let advChanged = false;
            const advs = newEvent.advocates;
            if (Array.isArray(advs)) {
                const reordered = [];
                for (const adv of advs) {
                    if (adv && typeof adv === 'object' && !Array.isArray(adv)) {
                        const [na] = _reorderWithUnknowns(adv, ADVOCATE_KEY_ORDER);
                        reordered.push(na);
                        if (Object.keys(na).join('|') !== Object.keys(adv).join('|')) advChanged = true;
                    } else {
                        reordered.push(adv);
                    }
                }
                if (advChanged) newEvent.advocates = reordered;
            }
            const eventChanged = (Object.keys(newEvent).join('|') !== Object.keys(event).join('|')) || advChanged;
            if (eventChanged) {
                eventsChanged++;
                if (!dryRun) {
                    for (const k of Object.keys(event)) delete event[k];
                    Object.assign(event, newEvent);
                }
            }
        }
        const [newCase, unknown] = _reorderWithUnknowns(c, caseKeyOrder(c));
        for (const k of unknown) unknownCaseKeys.add(k);
        if (Object.keys(newCase).join('|') !== Object.keys(c).join('|')) {
            casesChanged++;
            if (!dryRun) {
                for (const k of Object.keys(c)) delete c[k];
                Object.assign(c, newCase);
            }
        }
    }
    if (dryRun && unknownCaseKeys.size) console.log(`  ${term}: unknown case keys: [${_sortStr(unknownCaseKeys).map(k=>`'${k}'`).join(', ')}]`);
    if (dryRun && unknownEventKeys.size) console.log(`  ${term}: unknown event keys: [${_sortStr(unknownEventKeys).map(k=>`'${k}'`).join(', ')}]`);
    return [casesChanged, eventsChanged, unknownCaseKeys, unknownEventKeys];
}

function checkDuplicateNumbers(term, cases) {
    const numberToCases = {};
    for (const c of cases) {
        const raw = c.number || '';
        for (const num of _splitNumbers(raw)) {
            (numberToCases[num] = numberToCases[num] || []).push(c);
        }
    }
    const duplicates = {};
    for (const [n, list] of Object.entries(numberToCases)) {
        if (list.length > 1) duplicates[n] = list;
    }
    const keys = Object.keys(duplicates);
    if (!keys.length) return 0;
    console.log(`${term}: ${keys.length} duplicate docket number(s)`);
    for (const num of _sortStr(keys)) {
        const titles = duplicates[num].map(c => `"${firstTitle(c.title) || '?'}" (${c.number || '?'})`).join(', ');
        console.log(`  ${num}  →  ${titles}`);
    }
    return keys.length;
}

// Verify "argument_consolidation" (see schema.js) is internally consistent:
// it must (a) include this case's own number, (b) name only cases that
// actually exist, (c) read identically on every case in the group (it's
// meant to be one shared, canonical value — not a pairwise back-reference),
// and (d) every case in the group must share the exact same events — same
// dates/types, with the same advocates in each — since the whole point of
// the field is that these separately tracked case objects were really one
// shared argument session. Read-only; returns the number of problems found
// (each printed as it's found).
function checkArgumentConsolidation(term, cases) {
    const numberToCase = new Map();
    for (const c of cases) {
        for (const n of _splitNumbers(c.number)) numberToCase.set(n, c);
    }
    const eventKey = (ev) => `${ev.date || ''}|${ev.type || ''}`;
    const advocateKey = (a) => `${a.name || ''} ${a.title || ''} ${a.role || ''}`;
    const advocatesEqual = (a, b) => {
        const as = (a || []).map(advocateKey).sort();
        const bs = (b || []).map(advocateKey).sort();
        return as.length === bs.length && as.every((v, i) => v === bs[i]);
    };

    let problems = 0;
    for (const c of cases) {
        if (!c.argument_consolidation) continue;
        const label = `${term}/${c.number || c.id} (${firstTitle(c.title) || c.id})`;
        const ownNumbers = new Set(_splitNumbers(c.number));
        const groupNumbers = _splitNumbers(c.argument_consolidation);

        if (!groupNumbers.some(n => ownNumbers.has(n))) {
            console.log(`  WARNING: ${label}: argument_consolidation "${c.argument_consolidation}" does not include this case's own number`);
            problems++;
        }

        for (const otherNum of groupNumbers) {
            if ([...ownNumbers].includes(otherNum)) continue;
            const other = numberToCase.get(otherNum);
            if (!other) {
                console.log(`  WARNING: ${label}: argument_consolidation references unknown case number "${otherNum}"`);
                problems++;
                continue;
            }
            if (other.argument_consolidation !== c.argument_consolidation) {
                console.log(`  WARNING: ${label}: argument_consolidation "${c.argument_consolidation}" does not match "${otherNum}" (${firstTitle(other.title) || other.id})'s own value "${other.argument_consolidation || ''}"`);
                problems++;
            }

            const cEvents = new Map((c.events || []).map(ev => [eventKey(ev), ev]));
            const oEvents = new Map((other.events || []).map(ev => [eventKey(ev), ev]));
            for (const k of new Set([...cEvents.keys(), ...oEvents.keys()])) {
                const ce = cEvents.get(k), oe = oEvents.get(k);
                if (!ce || !oe) {
                    console.log(`  WARNING: ${label}: argument_consolidation with "${otherNum}" — event ${k.replace('|', ' ')} present on only one side`);
                    problems++;
                } else if (!advocatesEqual(ce.advocates, oe.advocates)) {
                    console.log(`  WARNING: ${label}: argument_consolidation with "${otherNum}" — advocates differ for event ${k.replace('|', ' ')}`);
                    problems++;
                }
            }
        }
    }
    return problems;
}

function fixTextHrefs(term, cases, casesDir, dryRun) {
    let updated = 0, warned = 0;
    for (const c of cases) {
        const numberField = c.number || '';
        const numbers = _splitNumbers(numberField);
        for (const audio of c.events || []) {
            const th = audio.text_href || '';
            if (!th || th.startsWith('http') || th.includes('/')) continue;
            const foundNum = numbers.find(num => fs.existsSync(path.join(casesDir, num, th))) || null;
            if (foundNum === null) {
                console.log(`  WARNING: ${term}/${numberField}: cannot find '${th}' under any of [${numbers.map(n=>`'${n}'`).join(', ')}]`);
                warned++;
                continue;
            }
            const newHref = `${foundNum}/${th}`;
            if (dryRun) console.log(`  MIGRATE ${term}/${numberField}: '${th}' -> '${newHref}'`);
            audio.text_href = newHref;
            updated++;
        }
    }
    return [updated, warned];
}

// ── Redundant USSC transcript detection ───────────────────────────────────
//
// For each USSC argument/reargument event that has a text_href, check whether
// the non-justice advocates it lists are a subset of the advocates in the
// corresponding Oyez event (same date). If so, the USSC transcript contains
// no information beyond what Oyez already provides; delete the file, clear
// text_href, and set redundant: true.
//
// This mirrors the logic in import_ussc.js's _compareSingleUsscEvent /
// compareUsscOyezSpeakers, but is called from the regular update_cases run so
// it applies automatically to all terms, not just the current import term.

const _RDT_JUSTICE_TITLES = new Set(['JUSTICE', 'CHIEF JUSTICE', 'UNKNOWN JUSTICE']);
const _RDT_SUFFIX_WORDS   = new Set(['JR', 'SR', 'II', 'III', 'IV']);
const _RDT_FEMALE_TITLES  = new Set(['MS', 'MRS', 'MISS']);
const _RDT_SUFFIX_RE      = /^(.+?)(?:,\s*|\s+)(JR\.?|SR\.?|II|III|IV)\.?\s*$/i;

function _rdtJusticeLastNames() {
    const map = _loadJusticeInfo();   // already built in this file
    const lastNames = new Set();
    for (const name of map.keys()) {
        const words = name.toUpperCase().split(/\s+/);
        let last = words[words.length - 1];
        if (_RDT_SUFFIX_WORDS.has(last) && words.length > 1) last = words[words.length - 2];
        lastNames.add(last);
    }
    return lastNames;
}
let _RDT_JUSTICE_LAST_NAMES = null;

function _rdtNonJusticeSpeakers(transcriptPath) {
    if (!fs.existsSync(transcriptPath)) return [];
    let data;
    try { data = _readJson(transcriptPath); } catch { return []; }
    const speakers = data?.media?.speakers || [];
    return speakers
        .filter(sp => !_RDT_JUSTICE_TITLES.has(sp.title || ''))
        .map(sp => [sp.name || '', sp.title || '']);
}

function _rdtTitleIsFemale(title) {
    const tokens = (title || '').toUpperCase().match(/[A-Z]+/g) || [];
    return tokens.some(t => _RDT_FEMALE_TITLES.has(t));
}

function _rdtNameKeys(name) {
    const base = (name || '').split(/\s+/).filter(Boolean).join(' ');
    if (!base) return new Set();
    const keys = new Set([base]);
    const m = _RDT_SUFFIX_RE.exec(base);
    if (m) { const s = m[1].trim().replace(/,$/, ''); if (s) keys.add(s); }
    return keys;
}

function _rdtLevenshtein(a, b) {
    if (a === b) return 0;
    if (a.length > b.length) [a, b] = [b, a];
    const row = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
        let prev = j;
        for (let i = 1; i <= a.length; i++) {
            const cur = a[i-1] === b[j-1] ? row[i-1] : 1 + Math.min(row[i-1], row[i], prev);
            row[i-1] = prev; prev = cur;
        }
        row[a.length] = prev;
    }
    return row[a.length];
}

function _rdtLastToken(name) {
    const tokens = (name || '').toUpperCase().match(/[A-Z]+/g) || [];
    while (tokens.length && _RDT_SUFFIX_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
    return tokens.length ? tokens[tokens.length - 1] : '';
}

function _rdtIsLikelyJustice(name, title) {
    if (title) return false;
    if (!_RDT_JUSTICE_LAST_NAMES) _RDT_JUSTICE_LAST_NAMES = _rdtJusticeLastNames();
    const tokens = (name || '').toUpperCase().match(/[A-Z]+/g) || [];
    if (tokens.length !== 1) return false;
    for (const last of _RDT_JUSTICE_LAST_NAMES) {
        if (_rdtLevenshtein(tokens[0], last) <= 2) return true;
    }
    return false;
}

function _rdtFuzzyCandidates(name, oyezSpk) {
    const nameTokens = (name || '').toUpperCase().match(/[A-Z]+/g) || [];
    while (nameTokens.length && _RDT_SUFFIX_WORDS.has(nameTokens[nameTokens.length - 1])) nameTokens.pop();
    if (nameTokens.length !== 1 && nameTokens.length !== 2) return [];
    const query = nameTokens.join('');
    const out = [];
    for (const [n, t] of oyezSpk) {
        if (_rdtLevenshtein(query, _rdtLastToken(n)) <= 2) out.push(t);
    }
    return out;
}

function _rdtSpeakersSubset(usscSpk, oyezSpk) {
    const oyezByName = new Map();
    for (const [name, title] of oyezSpk) {
        for (const key of _rdtNameKeys(name)) {
            if (!oyezByName.has(key)) oyezByName.set(key, []);
            oyezByName.get(key).push(title);
        }
    }
    for (const [name, title] of usscSpk) {
        if (_rdtIsLikelyJustice(name, title)) continue;
        let candidates = [];
        for (const key of _rdtNameKeys(name)) {
            if (oyezByName.has(key)) candidates.push(...oyezByName.get(key));
        }
        if (!candidates.length) candidates = _rdtFuzzyCandidates(name, oyezSpk);
        if (!candidates.length) return false;
        if (!candidates.some(t => _rdtTitleIsFemale(t) === _rdtTitleIsFemale(title))) return false;
    }
    return true;
}

/**
 * For each USSC argument/reargument event with a text_href, checks whether
 * the same date has a matching Oyez event whose advocate set is a superset.
 * If so, marks the USSC event redundant: deletes the transcript file, clears
 * text_href, and sets redundant: true.
 *
 * Returns the number of events newly marked redundant.
 */
function markRedundantUsscEvents(term, cases, casesDir, dryRun = false) {
    let count = 0;
    for (const c of cases) {
        const label = c.number || c.id || '?';
        for (const ev of c.events || []) {
            if (ev.source !== 'ussc') continue;
            if (ev.type !== 'argument' && ev.type !== 'reargument') continue;
            if (ev.redundant) continue;
            if (!ev.text_href) continue;

            const date = ev.date || '';
            // Find all Oyez events on the same date with a transcript.
            const oyezEvs = (c.events || []).filter(o =>
                o.source === 'oyez' && o.date === date && o.text_href);
            if (!oyezEvs.length) continue;

            // Prefer the Oyez event whose title matches the same docket number.
            const docketM = (ev.title || '').match(/No\.\s*([\d-]+)/);
            const docketNum = docketM ? docketM[1] : null;
            const oyezEv = docketNum
                ? (oyezEvs.find(o => (o.title || '').includes(docketNum)) || oyezEvs[0])
                : oyezEvs[0];

            const usscPath = path.join(casesDir, ev.text_href);
            const oyezPath = path.join(casesDir, oyezEv.text_href);

            const usscSpk = _rdtNonJusticeSpeakers(usscPath);
            const oyezSpk = _rdtNonJusticeSpeakers(oyezPath);
            if (!usscSpk.length && !oyezSpk.length) continue;

            if (_rdtSpeakersSubset(usscSpk, oyezSpk)) {
                if (dryRun) {
                    console.log(`  WOULD MARK REDUNDANT: ${term}/${label} (${date}): ussc transcript is subset of oyez`);
                } else {
                    if (fs.existsSync(usscPath)) {
                        fs.unlinkSync(usscPath);
                    }
                    delete ev.text_href;
                    ev.redundant = true;
                    console.log(`  REDUNDANT: ${term}/${label} (${date}): ussc transcript deleted (redundant with oyez)`);
                }
                count++;
            }
        }
    }
    return count;
}

function checkMissingTextHrefs(term, cases, casesDir, dryRun = false) {
    let missing = 0, fixed = 0;
    for (const c of cases) {
        const numberField = c.number || '';
        for (const audio of c.events || []) {
            const th = audio.text_href || '';
            if (!th || th.startsWith('http') || !th.includes('/')) continue;
            if (!fs.existsSync(path.join(casesDir, th))) {
                if (audio.redundant) {
                    if (dryRun) console.log(`  WOULD FIX: ${term}/${numberField}: removing stale text_href '${th}' from redundant event`);
                    else { console.log(`  FIX: ${term}/${numberField}: removed stale text_href '${th}' from redundant event`); delete audio.text_href; }
                    fixed++;
                } else {
                    console.log(`  MISSING: ${term}/${numberField}: text_href '${th}' does not exist on disk`);
                    missing++;
                }
            }
        }
    }
    return [missing, fixed];
}

function checkOrphanedTranscripts(term, cases, casesDir) {
    const referenced = new Set();
    for (const c of cases) {
        for (const a of c.events || []) {
            const th = a.text_href || '';
            if (th && th.includes('/') && !th.startsWith('http')) referenced.add(th);
        }
    }
    const eventLookup = {};   // `${comp}\0${date}` → href
    for (const c of cases) {
        const components = _splitNumbers(c.number || '');
        for (const e of c.events || []) {
            const th = e.transcript_href || '';
            const date = e.date || '';
            if (!th || !date) continue;
            for (const comp of components) {
                const key = `${comp}\u0000${date}`;
                if (!(key in eventLookup)) eventLookup[key] = th;
            }
        }
    }
    const orphaned = [];
    if (isDir(casesDir)) {
        const folders = fs.readdirSync(casesDir).filter(n => isDir(path.join(casesDir, n))).sort();
        for (const folder of folders) {
            const fullDir = path.join(casesDir, folder);
            const files = fs.readdirSync(fullDir).filter(n => n.endsWith('.json')).sort();
            for (const fn of files) {
                if (_NON_TRANSCRIPT_NAMES.has(fn)) continue;
                const stem = path.basename(fn, '.json');
                if (_NON_TRANSCRIPT_SUFFIXES.some(s => stem.includes(s))) continue;
                const rel = `${folder}/${fn}`;
                if (referenced.has(rel)) continue;
                const date = stem.replace(/-\d+$/, '');
                const th = eventLookup[`${folder}\u0000${date}`] || '';
                orphaned.push([`${term}/${folder}`, date, th]);
            }
        }
    }
    return orphaned;
}

function checkDuplicateTextHrefs(term, cases) {
    const seen = {};
    let dupes = 0;
    for (const c of cases) {
        const numberField = c.number || '';
        for (const a of c.events || []) {
            const th = a.text_href || '';
            if (!th || th.startsWith('http') || !th.includes('/')) continue;
            if (th in seen) {
                console.log(`  DUPE:    ${term}/${numberField}: text_href '${th}' already used by ${seen[th]}`);
                dupes++;
            } else {
                seen[th] = numberField;
            }
        }
    }
    return dupes;
}

function fixOyezTranscriptHrefs(term, cases, dryRun) {
    let stripped = 0;
    for (const c of cases) {
        const numberField = c.number || '';
        const usscHrefs = new Set();
        for (const a of c.events || []) {
            const src = a.source || 'ussc';
            if (src === 'ussc' && a.transcript_href) usscHrefs.add(a.transcript_href);
        }
        if (!usscHrefs.size) continue;
        for (const a of c.events || []) {
            if (a.source !== 'oyez') continue;
            const th = a.transcript_href || '';
            if (th && usscHrefs.has(th)) {
                if (dryRun) console.log(`  STRIP transcript_href ${term}/${numberField} [oyez ${a.date || '?'}]: '${th}'`);
                else delete a.transcript_href;
                stripped++;
            }
        }
    }
    return stripped;
}

function checkDuplicateMediaHrefs(termsToCheck) {
    const seen = { audio_href: {}, transcript_href: {} };
    const caseLookup = {};
    for (const term of termsToCheck) {
        const cp = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases.json');
        if (!fs.existsSync(cp)) continue;
        let cases;
        try { cases = JSON.parse(fs.readFileSync(cp, 'utf8')); } catch { continue; }
        for (const c of cases) {
            const number = c.number || '?';
            caseLookup[`${term}\u0000${number}`] = c;
            for (const e of c.events || []) {
                const date = e.date || '', source = e.source || '';
                const turn = (e.turn === undefined || e.turn === null) ? '' : String(e.turn);
                for (const field of ['audio_href', 'transcript_href']) {
                    const url = e[field] || '';
                    if (url) {
                        (seen[field][url] = seen[field][url] || []).push([term, number, date, source, turn, e.type || '', e.offset !== undefined ? String(e.offset) : '']);
                    }
                }
            }
        }
    }
    const result = [];
    for (const field of Object.keys(seen)) {
        for (const url of _sortStr(Object.keys(seen[field]))) {
            const locs = seen[field][url];
            if (locs.length <= 1) continue;
            // Same case, same URL but distinct `turn` values on each
            // occurrence (treating a missing `turn` as the implicit start) →
            // consolidated multi-case audio split into per-case segments.
            // Not a duplicate.
            const tcSet = new Set(locs.map(([t, n]) => `${t}\u0000${n}`));
            if (tcSet.size === 1) {
                const turns = locs.map(l => l[4]);
                const hasExplicit = turns.some(t => t !== '');
                const distinct = new Set(turns).size === turns.length;
                if (hasExplicit && distinct) continue;
            }
            // Same case, same audio_href, all events are type=opinion, same
            // date, each with a distinct offset or turn → these are intentional split
            // events. Not a duplicate.
            if (field === 'audio_href' && tcSet.size === 1) {
                const allOpinion = locs.every(l => l[5] === 'decision');
                if (allOpinion) {
                    const dates = locs.map(l => l[2]);
                    const sameDates = new Set(dates).size === 1;
                    const offsets = locs.map(l => l[6]);
                    const distinctOffsets = new Set(offsets).size === offsets.length;
                    const turns2 = locs.map(l => l[4]);
                    const distinctTurns = new Set(turns2).size === turns2.length && turns2.some(t => t !== '');
                    if (sameDates && (distinctOffsets || distinctTurns)) continue;
                }
            }
            if (tcSet.size === 1) {
                const [t, n] = [...tcSet][0].split('\u0000');
                const eventDates = locs.map(l => l[2]).filter(Boolean);
                if (eventDates.length && _datesAreConsecutive(eventDates)) {
                    const c = caseLookup[`${t}\u0000${n}`] || {};
                    const argDates = new Set();
                    for (const fld of ['argument', 'reargument']) {
                        for (const d of _parseDateField(c[fld] || '')) argDates.add(d);
                    }
                    if (eventDates.every(d => argDates.has(d))) continue;
                }
            }
            // All entries share the same date → cases were argued together
            // (consolidated argument) but decided separately. Not a duplicate.
            const allDates = locs.map(l => l[2]);
            if (allDates.every(Boolean) && new Set(allDates).size === 1) continue;
            // Different offset values imply different portions of the same
            // audio are used across events — not a true duplicate.
            const offsets = locs.map(l => l[6] || '0');
            if (new Set(offsets).size === offsets.length && offsets.some(o => o !== '0')) continue;
            result.push([field, url, locs]);
        }
    }
    return result;
}

function fixArgumentDates(term, cases, dryRun) {
    let fixed = 0;
    for (const c of cases) {
        const number = c.number || '?';
        let changed = false;
        for (const field of ['argument', 'reargument']) {
            const raw = c[field];
            if (!raw) continue;
            const dates = _parseDateField(String(raw));
            const seen = new Set();
            const unique = [];
            for (const d of dates) { if (!seen.has(d)) { seen.add(d); unique.push(d); } }
            const sorted = _sortStr(unique);
            const newVal = _joinDates(sorted);
            if (newVal !== String(raw)) {
                if (dryRun) console.log(`  FIX ${field} ${term}/${number}: '${raw}' -> '${newVal}'`);
                else c[field] = newVal;
                changed = true;
            }
        }
        const argRaw = c.argument, reargRaw = c.reargument;
        if (argRaw && reargRaw) {
            const reargDates = new Set(_parseDateField(String(reargRaw)));
            const argDates = _parseDateField(String(c.argument || ''));
            const filtered = argDates.filter(d => !reargDates.has(d));
            if (filtered.length !== argDates.length) {
                const removed = _sortStr(new Set(argDates.filter(d => !filtered.includes(d))));
                if (dryRun) console.log(`  FIX argument ${term}/${number}: removing [${removed.map(d=>`'${d}'`).join(', ')}] (also in reargument)`);
                const newArg = filtered.length ? _joinDates(filtered) : '';
                if (!dryRun) {
                    if (newArg) c.argument = newArg;
                    else delete c.argument;
                }
                changed = true;
            }
        }
        if (changed) fixed++;
    }
    return fixed;
}

// Keep argument_day / reargument_day / decision_day in sync with their
// source date fields.  Adds the property when the source exists and has valid
// dates; removes it when the source is absent.
function fixDayLabels(term, cases, dryRun) {
    let fixed = 0;
    for (const c of cases) {
        let changed = false;
        for (const [src, dst] of [
            ['argument',   'argument_day'],
            ['reargument', 'reargument_day'],
            ['decision',   'decision_day'],
        ]) {
            const expected = c[src] ? _computeDays(c[src]) : undefined;
            if (expected === undefined) {
                if (Object.prototype.hasOwnProperty.call(c, dst)) {
                    if (!dryRun) delete c[dst];
                    changed = true;
                }
            } else if (c[dst] !== expected) {
                if (!dryRun) c[dst] = expected;
                changed = true;
            }
        }
        if (changed) fixed++;
    }
    return fixed;
}

function _cmpKeys(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}

function fixEventTypes(term, cases, dryRun) {
    let fixed = 0;
    for (const c of cases) {
        const number = c.number || '?';
        const titleSourceCounts = new Map();
        for (const ev of c.events || []) {
            if (ev.title) {
                const key = `${ev.source || ''}\0${ev.title}`;
                titleSourceCounts.set(key, (titleSourceCounts.get(key) || 0) + 1);
            }
        }
        for (const [key, count] of titleSourceCounts) {
            if (count > 1) {
                const [src, t] = key.split('\0');
                console.log(`WARNING: ${term}/${number}: event title "${t}" (source: ${src || 'none'}) appears ${count} times`);
            }
        }
        const argDates      = c.argument   ? new Set(_parseDateField(String(c.argument)))   : new Set();
        const reargDates    = c.reargument ? new Set(_parseDateField(String(c.reargument))) : new Set();
        const decisionDates = c.decision   ? new Set(_parseDateField(String(c.decision)))   : new Set();
        for (const event of c.events || []) {
            const date  = event.date || '';
            let etype = event.type || 'argument';
            const title = event.title || '';
            if (etype === 'misc') {
                console.log(`WARNING: ${term}/${number} ${date || '?'}: type 'misc' should be journal`);
                if (!dryRun) event.type = 'journal';
                etype = 'journal';
                fixed++;
            }
            if (reargDates.has(date)) {
                let changed = false;
                if (etype !== 'reargument') {
                    console.log(`WARNING: ${term}/${number} ${date}: type '${etype}' should be reargument`);
                    if (!dryRun) event.type = 'reargument';
                    changed = true;
                }
                if (title && !title.startsWith('Oral Reargument')) {
                    const newTitle = title.startsWith('Oral Argument')
                        ? 'Oral Reargument' + title.slice('Oral Argument'.length)
                        : 'Oral Reargument' + title;
                    console.log(`WARNING: ${term}/${number} ${date}: '${title}' -> '${newTitle}'`);
                    if (!dryRun) event.title = newTitle;
                    changed = true;
                }
                if (changed) fixed++;
            } else if (argDates.has(date)) {
                if (etype !== 'argument' && etype !== 'reargument') {
                    console.log(`WARNING: ${term}/${number} ${date}: event type '${etype}' on argument date (not auto-fixed)`);
                }
            } else if (decisionDates.has(date)) {
                if (etype !== 'decision') {
                    console.log(`WARNING: ${term}/${number} ${date}: event type '${etype}' on decision date (not auto-fixed)`);
                }
            }
            if (['argument', 'reargument', 'decision'].includes(etype) && date) {
                if (etype === 'argument' && !argDates.has(date))
                    console.log(`WARNING: ${term}/${number} ${date}: argument event date not in 'argument' field`);
                else if (etype === 'reargument' && !reargDates.has(date))
                    console.log(`WARNING: ${term}/${number} ${date}: reargument event date not in 'reargument' field`);
                else if (etype === 'decision' && !decisionDates.has(date))
                    console.log(`WARNING: ${term}/${number} ${date}: decision event date not in 'decision' field`);
            }
        }
    }
    return fixed;
}

// Extract a numeric sort key from a "No. X" fragment in an event title.
// Plain numbers return as-is; "YY-NNNN" form returns YY*10000+NNNN.
// Titles without a "No. X" return Infinity so they sort last.
function _eventTitleSortKey(title) {
    const m = /\bNo\.\s+(\d+(?:-\d+)?)/i.exec(title || '');
    if (!m) return Infinity;
    const parts = m[1].split('-');
    return parts.length === 2
        ? parseInt(parts[0], 10) * 10000 + parseInt(parts[1], 10)
        : parseInt(parts[0], 10);
}

// Matches YYYY-MM-DD[-source]-N.json — the suffix after the optional source tag.
// Does NOT match the day component of a bare YYYY-MM-DD.json name.
const _SUFFIX_FILE_RE = /^(\d{4}-\d{2}-\d{2}(?:-[a-z]+)?)-(\d+)\.json$/i;

function fixTranscriptSuffixes(term, cases, casesDir, dryRun) {
    let fixed = 0;
    if (!isDir(casesDir)) return fixed;

    // renameMap: old relative path → new relative path (folder/file)
    const renameMap = new Map();

    const folders = fs.readdirSync(casesDir).filter(n => isDir(path.join(casesDir, n))).sort();
    for (const folder of folders) {
        const folderPath = path.join(casesDir, folder);
        const files = fs.readdirSync(folderPath).filter(n => n.endsWith('.json')).sort();
        const fileSet = new Set(files);

        // Group suffixed files by their base name.
        const byBase = new Map();
        for (const f of files) {
            const m = _SUFFIX_FILE_RE.exec(f);
            if (!m) continue;
            const base = m[1];
            const suffix = parseInt(m[2], 10);
            if (!byBase.has(base)) byBase.set(base, []);
            byBase.get(base).push({ file: f, suffix });
        }

        for (const [base, suffixed] of byBase) {
            if (fileSet.has(`${base}.json`)) continue;  // unsuffixed already exists

            suffixed.sort((a, b) => a.suffix - b.suffix);
            const suffixNums = new Set(suffixed.map(s => s.suffix));
            const byNum     = new Map(suffixed.map(s => [s.suffix, s.file]));

            const doRename = (oldFile, newFile) => {
                const oldRel = `${folder}/${oldFile}`;
                const newRel = `${folder}/${newFile}`;
                renameMap.set(oldRel, newRel);
                if (dryRun) {
                    console.log(`  SUFFIX: ${term}/${folder}: would rename '${oldFile}' → '${newFile}'`);
                } else {
                    fs.renameSync(path.join(folderPath, oldFile), path.join(folderPath, newFile));
                }
                fixed++;
            };

            // Lone suffixed file with no unsuffixed version and no siblings → strip suffix
            if (suffixNums.size === 1) {
                doRename(suffixed[0].file, `${base}.json`);
                continue;
            }

            // -2 without -1 → rename -2 to -1
            if (suffixNums.has(2) && !suffixNums.has(1)) {
                const oldFile = byNum.get(2);
                const newFile = `${base}-1.json`;
                doRename(oldFile, newFile);
                suffixNums.delete(2);
                suffixNums.add(1);
            }

            // -3 without -2 → rename -3 to -2
            if (suffixNums.has(3) && !suffixNums.has(2)) {
                doRename(byNum.get(3), `${base}-2.json`);
            }
        }
    }

    // Update text_href references in cases for every renamed file.
    if (!dryRun && renameMap.size > 0) {
        for (const c of cases) {
            for (const ev of c.events || []) {
                if (ev.text_href && renameMap.has(ev.text_href)) {
                    ev.text_href = renameMap.get(ev.text_href);
                }
            }
        }
    }

    return fixed;
}

function sortEvents(term, cases, dryRun) {
    let changed = 0;
    for (const c of cases) {
        const events = c.events;
        if (!Array.isArray(events) || events.length < 2) continue;

        // Collect indices per (source, type, date) group.
        const groups = new Map();
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const key = `${ev.source || ''}\0${ev.type || ''}\0${ev.date || ''}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(i);
        }

        // Within each multi-event group, sort by "No. X" numeric value, then title.
        const newOrder = [...events];
        let caseChanged = false;
        for (const indices of groups.values()) {
            if (indices.length < 2) continue;
            const byTitle = [...indices].sort((a, b) => {
                const ka = _eventTitleSortKey(events[a].title);
                const kb = _eventTitleSortKey(events[b].title);
                if (ka !== kb) return ka - kb;
                return (events[a].title || '').localeCompare(events[b].title || '');
            });
            if (byTitle.some((si, pos) => si !== indices[pos])) {
                for (let pos = 0; pos < indices.length; pos++) {
                    newOrder[indices[pos]] = events[byTitle[pos]];
                }
                caseChanged = true;
            }
        }

        if (caseChanged) {
            if (dryRun) console.log(`  SORT events ${term}/${c.number || c.id || '?'}`);
            else c.events = newOrder;
            changed++;
        }
    }
    return changed;
}

function sortCases(term, cases, dryRun) {
    const indexed = cases.map((c, i) => [i, c]);
    const lastArgDate = (c) => {
        const dates = [c.argument, c.reargument].filter(Boolean);
        return dates.length ? dates.reduce((a, b) => b > a ? b : a) : '';
    };
    const firstDocketNum = (c) => {
        const raw = (c.number || '').split(',')[0].trim();
        const parts = raw.split('-');
        return parseInt(parts[parts.length - 1], 10) || 0;
    };
    const key = (c) => { const d = lastArgDate(c); return [d ? '0' : '1', d || (c.decision || '2199-12-31'), firstDocketNum(c)]; };
    const sorted = [...indexed].sort(([, a], [, b]) => _cmpKeys(key(a), key(b)));
    const orderChanged = sorted.some(([oi], i) => oi !== i);
    if (orderChanged) {
        if (dryRun) console.log(`  SORT cases ${term}`);
        else cases.splice(0, cases.length, ...sorted.map(([, c]) => c));
        return 1;
    }
    return 0;
}

function mergeRefiledCases(term, cases, allTerms, dryRun) {
    const termIdx = allTerms.indexOf(term);
    if (termIdx < 0) return 0;
    const laterTerms = allTerms.slice(termIdx + 1, termIdx + 3);
    if (!laterTerms.length) return 0;
    const laterCaseMap = new Map();
    const laterCasesLists = {};
    for (const lt of laterTerms) {
        const lp = path.join(TERMS_DIR, lt, 'cases.json');
        if (!fs.existsSync(lp)) continue;
        let lcases;
        try { lcases = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { continue; }
        laterCasesLists[lt] = lcases;
        for (const lc of lcases) {
            const tt = firstTitle(lc.title) || '', nn = lc.number || '';
            const key = `${tt}\u0000${nn}`;
            if (tt && nn && !laterCaseMap.has(key)) {
                laterCaseMap.set(key, [lt, lcases, lc]);
            }
        }
    }
    if (!laterCaseMap.size) return 0;

    const eventId = (ev) => ev.audio_href || `${ev.date || ''}|${ev.source || ''}|${ev.type || ''}`;

    const mergedTermsWritten = new Set();
    const casesToRemove = [];
    for (const oldCase of cases) {
        const title = firstTitle(oldCase.title) || '', number = oldCase.number || '';
        if (!title || !number) continue;
        const match = laterCaseMap.get(`${title}\u0000${number}`);
        if (!match) continue;
        const [laterTerm, , newCase] = match;
        const [ltStart, ltEnd] = _termDateRange(laterTerm, allTerms);
        const oldEventDates = (oldCase.events || []).map(e => e.date).filter(Boolean);
        if (!oldEventDates.some(d => d >= ltStart && d <= ltEnd)) continue;
        const oldEvents = oldCase.events || [];
        const newEventIds = new Set((newCase.events || []).map(eventId));
        const eventsToMove = oldEvents.filter(e => !newEventIds.has(eventId(e)));
        console.log(`  MERGE ${term}/${number} -> ${laterTerm}/${number} (${eventsToMove.length} of ${oldEvents.length} event(s) to move)`);
        if (!dryRun) {
            const oldCasesDir = path.join(TERMS_DIR, term,      'cases');
            const newCasesDir = path.join(TERMS_DIR, laterTerm, 'cases');
            for (const ev of eventsToMove) {
                const th = ev.text_href || '';
                if (th && !th.startsWith('http') && th.includes('/')) {
                    const src = path.join(oldCasesDir, th);
                    const dst = path.join(newCasesDir, th);
                    if (fs.existsSync(src)) {
                        _mkdirSync(path.dirname(dst), { recursive: true });
                        _renameSync(src, dst);
                        console.log(`    moved file ${th}`);
                    }
                }
            }
            const newEvents = newCase.events = newCase.events || [];
            newEvents.push(...eventsToMove);
            newCase.previouslyFiled = `${term}/${number}`;
            const [reordered] = _reorderWithUnknowns(newCase, caseKeyOrder(newCase));
            for (const k of Object.keys(newCase)) delete newCase[k];
            Object.assign(newCase, reordered);
            for (const ev of newCase.events || []) {
                const [newEv] = _reorderWithUnknowns(ev, EVENT_KEY_ORDER);
                if (Object.keys(newEv).join('|') !== Object.keys(ev).join('|')) {
                    for (const k of Object.keys(ev)) delete ev[k];
                    Object.assign(ev, newEv);
                }
            }
            mergedTermsWritten.add(laterTerm);
        }
        casesToRemove.push(oldCase);
    }
    if (!casesToRemove.length) return 0;
    if (!dryRun) {
        for (const c of casesToRemove) {
            const i = cases.indexOf(c);
            if (i >= 0) cases.splice(i, 1);
        }
        for (const lt of mergedTermsWritten) {
            const lp = path.join(TERMS_DIR, lt, 'cases.json');
            _writeJson(lp, laterCasesLists[lt]);
        }
    }
    return casesToRemove.length;
}

function processTerm(term, dryRun, checkDups, allTerms, sortOnly = false) {
    const casesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases.json');
    if (!fs.existsSync(casesPath)) {
        return { dupCount: 0, casesReordered: 0, eventsReordered: 0, unknownCaseKeys: new Set(), unknownEventKeys: new Set(),
                 hrefUpdated: 0, hrefWarned: 0, hrefMissing: 0, hrefRedundantFixed: 0, hrefOrphaned: [],
                 hrefDupes: 0, hrefStripped: 0, casesSorted: 0, eventsSorted: 0, suffixesFixed: 0,
                 argDatesFixed: 0, eventTypesFixed: 0, mergedCount: 0, usscRedundant: 0 };
    }
    const cases = _readJson(casesPath);
    if (!cases || !cases.length) {
        return { dupCount: 0, casesReordered: 0, eventsReordered: 0, unknownCaseKeys: new Set(), unknownEventKeys: new Set(),
                 hrefUpdated: 0, hrefWarned: 0, hrefMissing: 0, hrefRedundantFixed: 0, hrefOrphaned: [],
                 hrefDupes: 0, hrefStripped: 0, casesSorted: 0, eventsSorted: 0, suffixesFixed: 0,
                 argDatesFixed: 0, eventTypesFixed: 0, mergedCount: 0, usscRedundant: 0 };
    }
    const dupCount = (checkDups && !sortOnly) ? checkDuplicateNumbers(term, cases) : 0;
    const argConsolidationProblems = !sortOnly ? checkArgumentConsolidation(term, cases) : 0;
    // Normalize date fields and compute *_days labels before fixKeyOrder so the
    // new keys are present when key ordering runs and land in the right positions.
    const argDatesFixed   = !sortOnly ? fixArgumentDates(term, cases, dryRun) : 0;
    const dayLabelsFixed  = !sortOnly ? fixDayLabels(term, cases, dryRun)     : 0;
    let casesReordered = 0, eventsReordered = 0;
    let unknownCaseKeys = new Set(), unknownEventKeys = new Set();
    if (!sortOnly) {
        [casesReordered, eventsReordered, unknownCaseKeys, unknownEventKeys] = fixKeyOrder(term, cases, dryRun);
    }
    const casesDir = path.join(TERMS_DIR, term, 'cases');
    const [hrefUpdated, hrefWarned] = !sortOnly ? fixTextHrefs(term, cases, casesDir, dryRun) : [0, 0];
    const usscRedundant = !sortOnly ? markRedundantUsscEvents(term, cases, casesDir, dryRun) : 0;
    const [hrefMissing, hrefRedundantFixed] = !sortOnly ? checkMissingTextHrefs(term, cases, casesDir, dryRun) : [0, 0];
    const hrefOrphaned = !sortOnly ? checkOrphanedTranscripts(term, cases, casesDir) : [];
    for (const [label, date, th] of hrefOrphaned) {
        const detail = th ? `  ${date}  ${th}` : `  ${date}`;
        console.log(`  ORPHAN:  ${label}${detail}`);
    }
    const hrefDupes    = (checkDups && !sortOnly) ? checkDuplicateTextHrefs(term, cases) : 0;
    const hrefStripped  = !sortOnly ? fixOyezTranscriptHrefs(term, cases, dryRun) : 0;
    const suffixesFixed = !sortOnly ? fixTranscriptSuffixes(term, cases, casesDir, dryRun) : 0;
    const eventsSorted  = !sortOnly ? sortEvents(term, cases, dryRun) : 0;
    const casesSorted   = sortCases(term, cases, dryRun);
    const eventTypesFixed = !sortOnly ? fixEventTypes(term, cases, dryRun)    : 0;
    const mergedCount     = !sortOnly ? mergeRefiledCases(term, cases, allTerms || [], dryRun) : 0;
    const votesResorted   = !sortOnly ? verifyVoteSeniority(term, cases, !dryRun) : 0;

    if (!dryRun && (casesReordered || eventsReordered || hrefUpdated || hrefStripped
            || casesSorted || eventsSorted || suffixesFixed || argDatesFixed || dayLabelsFixed
            || eventTypesFixed || mergedCount || hrefRedundantFixed || votesResorted || usscRedundant)
            && _jsonChanged(casesPath, cases)) {
        _writeJson(casesPath, cases);
    }
    return { dupCount, casesReordered, eventsReordered, unknownCaseKeys, unknownEventKeys,
             hrefUpdated, hrefWarned, hrefMissing, hrefRedundantFixed, hrefOrphaned,
             hrefDupes, hrefStripped, casesSorted, eventsSorted, suffixesFixed,
             argDatesFixed, dayLabelsFixed, eventTypesFixed, mergedCount, usscRedundant };
}

// ═════════════════════════════════
// SCDB CSV post-processing (--scdb)
// ═════════════════════════════════
//
// For each SCDB download named in config.json under "scdb" (modern/legacy),
// reads the corresponding raw CSV from scdb/, converts MM/DD/YYYY date values
// to YYYY-MM-DD, removes unused columns, and writes <key>.csv (e.g.
// modern.csv / legacy.csv) into scdb/current/. The original SCDB_*.csv file
// is deleted on success.

const _SCDB_DROP_COLS = new Set([
    'sctCite', 'ledCite', 'lexisCite', 'docketId', 'caseIssuesId', 'voteId',
]);
const _SCDB_DATE_RE   = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const _SCDB_QUOTE_RE  = /[-,"]/;

function _scdbQuote(value) {
    return _SCDB_QUOTE_RE.test(value)
        ? '"' + value.replace(/"/g, '""') + '"'
        : value;
}

function _scdbConvertDate(value) {
    const m = _SCDB_DATE_RE.exec(value);
    if (!m) return value;
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// Minimal CSV-line splitter for the simple quoting style produced by SCDB.
function _splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQ = false;
            } else cur += ch;
        } else {
            if (ch === ',') { out.push(cur); cur = ''; }
            else if (ch === '"' && cur === '') inQ = true;
            else cur += ch;
        }
    }
    out.push(cur);
    return out;
}

function _readScdbSource(srcPath) {
    const buf = fs.readFileSync(srcPath);
    // Strip UTF-8 BOM if present.
    const start = (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0;
    const slice = start ? buf.subarray(start) : buf;
    try {
        const dec = new TextDecoder('utf-8', { fatal: true });
        return { text: dec.decode(slice), encoding: 'utf-8' };
    } catch {
        return { text: slice.toString('latin1'), encoding: 'latin1' };
    }
}

function _processScdbFile(srcPath, outPath) {
    const { text, encoding } = _readScdbSource(srcPath);
    if (encoding !== 'utf-8') console.log(`  (read ${path.basename(srcPath)} as ${encoding})`);
    const lines = text.split(/\r\n|\r|\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) {
        console.log(`  ERROR: ${path.basename(srcPath)} is empty`);
        return false;
    }
    const header = _splitCsvLine(lines[0]);
    const keepIdx = header.map((h, i) => _SCDB_DROP_COLS.has(h) ? -1 : i).filter(i => i >= 0);
    const outHeader = keepIdx.map(i => header[i]);

    const outLines = [outHeader.map(_scdbQuote).join(',')];
    let rowCount = 0;
    for (let i = 1; i < lines.length; i++) {
        const fields = _splitCsvLine(lines[i]);
        const row = keepIdx.map(idx => {
            const v = fields[idx] ?? '';
            return v ? _scdbConvertDate(v) : v;
        });
        outLines.push(row.map(_scdbQuote).join(','));
        rowCount++;
    }
    fs.writeFileSync(outPath, outLines.join('\n') + '\n', 'utf8');
    fs.unlinkSync(srcPath);
    console.log(`  -> Saved ${path.basename(outPath)} (${rowCount.toLocaleString()} rows), deleted original.`);
    return true;
}

function processScdbDownloads(verbose) {
    const configPath = path.join(REPO_ROOT, 'config.json');
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (e) {
        console.log(`SCDB: failed to read ${path.relative(REPO_ROOT, configPath)}: ${e.message}`);
        return;
    }
    const scdb = cfg?.scdb || {};
    const dataDir = path.join(REPO_ROOT, 'scdb');
    if (!fs.existsSync(_SCDB_CURRENT_DIR)) fs.mkdirSync(_SCDB_CURRENT_DIR, { recursive: true });
    let any = false;
    for (const [key, basename] of Object.entries(scdb)) {
        if (!basename) continue;
        const srcPath = path.join(dataDir, basename);
        const outPath = path.join(_SCDB_CURRENT_DIR, `${key}.csv`);
        if (!fs.existsSync(srcPath)) continue;
        any = true;
        console.log(`SCDB: processing ${basename}`);
        _processScdbFile(srcPath, outPath);
    }
    if (!any && verbose) console.log(`SCDB: no downloads found in ${path.relative(REPO_ROOT, dataDir)}.`);
}

// ════════════════════════════
// SCDB cases.json verification
// ════════════════════════════

const _SCDB_DATA_DIR    = path.join(REPO_ROOT, 'scdb');
// The processed/current SCDB export (modern.csv, legacy.csv, naturalCourts.csv,
// vars.json) lives in scdb/current/, separate from the raw SCDB_*.csv downloads
// (still dropped directly in scdb/) and the scdb/cache/ derived cache.
const _SCDB_CURRENT_DIR = path.join(_SCDB_DATA_DIR, 'current');
const _SCDB_TERMS_DIR   = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const _LD_CITES_PATH    = path.join(REPO_ROOT, 'data', 'ussc', 'citations.csv');
const _LD_DATES_PATH    = path.join(REPO_ROOT, 'data', 'ussc', 'dates.csv');
const _SCDB_VARS_PATH   = path.join(_SCDB_CURRENT_DIR, 'vars.json');
const _SCDB_JUSTICES    = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');
const _SCDB_MODERN_CSV  = path.join(_SCDB_CURRENT_DIR, 'modern.csv');
const _SCDB_LEGACY_CSV  = path.join(_SCDB_CURRENT_DIR, 'legacy.csv');
const _SCDB_CACHE_DIR   = path.join(_SCDB_DATA_DIR, 'cache');
const _SCDB_CACHE_PATH  = path.join(_SCDB_CACHE_DIR, 'scdb.json');
const _SCDB_CORRECTIONS_PATH = path.join(REPO_ROOT, 'data', 'scdb', 'corrections.json');
const _SCDB_NOT_INCLUDED_PAGE = path.join(REPO_ROOT, 'courts', 'ussc', 'collections', 'scdb', 'index.md');

const _US_CITE_RE       = /^(\d+)\s+U\.S\.\s+(\d+)$/i;
const _SCDB_ISO_RE      = /^\d{4}-\d{2}-\d{2}$/;

const _SCDB_JUSTICE_COLS = [
    'justice', 'justiceName', 'vote', 'opinion', 'direction',
    'majority', 'firstAgreement', 'secondAgreement',
];

const _SCDB_MAJ_VOTE_TYPES = new Set([
    'voted with majority or plurality',
    'majority opinion',
    'majority',
    'regular concurrence',
    'special concurrence',
    'judgment of the court',
    'justice participated in an equally divided vote',
]);
const _SCDB_MIN_VOTE_TYPES = new Set([
    'dissent',
    'minority',
    'dissent from a denial or dismissal of certiorari , or dissent from summary affirmation of an appeal',
    'jurisdictional dissent',
]);

const _DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const _MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function _readCsvRows(filePath, encoding = 'utf8') {
    const text = fs.readFileSync(filePath, encoding);
    const lines = text.split(/\r\n|\r|\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) return { fields: [], rows: [] };
    const fields = _splitCsvLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const cols = _splitCsvLine(lines[i]);
        const row = {};
        for (let j = 0; j < fields.length; j++) row[fields[j]] = cols[j] ?? '';
        rows.push(row);
    }
    return { fields, rows };
}

function _scdbDecodeEntities(s) {
    if (typeof s !== 'string' || s.indexOf('&') < 0) return s;
    const named = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
        sect: '\u00a7', para: '\u00b6', deg: '\u00b0', copy: '\u00a9',
        reg: '\u00ae', trade: '\u2122', mdash: '\u2014', ndash: '\u2013',
        lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
        hellip: '\u2026', laquo: '\u00ab', raquo: '\u00bb', middot: '\u00b7',
        bull: '\u2022', dagger: '\u2020', Dagger: '\u2021',
    };
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-zA-Z]+);/g, (m, ent) => {
        if (ent[0] === '#') {
            const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
            if (Number.isFinite(cp)) try { return String.fromCodePoint(cp); } catch { return m; }
            return m;
        }
        return Object.prototype.hasOwnProperty.call(named, ent) ? named[ent] : m;
    });
}

function _scdbLoadVarsMap() {
    if (!fs.existsSync(_SCDB_VARS_PATH)) return { map: {}, sets: {}, declared: new Set() };
    let raw; try { raw = JSON.parse(fs.readFileSync(_SCDB_VARS_PATH, 'utf8')); }
    catch { return { map: {}, sets: {}, declared: new Set() }; }
    const result = {};
    const sets = {};
    const declared = new Set(Object.keys(raw));
    for (const [col, spec] of Object.entries(raw)) {
        if (!spec) continue;
        if (Array.isArray(spec.values)) {
            sets[col] = new Set(spec.values.map(v => _scdbDecodeEntities(String(v))));
        } else if (typeof spec.values === 'object' && spec.values) {
            const m = {};
            for (const [k, v] of Object.entries(spec.values)) m[k] = _scdbDecodeEntities(typeof v === 'string' ? v : String(v));
            result[col] = m;
        }
    }
    for (const [col, spec] of Object.entries(raw)) {
        if (spec && typeof spec.values === 'string') {
            if (result[spec.values]) result[col] = result[spec.values];
            else if (sets[spec.values]) sets[col] = sets[spec.values];
        }
    }
    return { map: result, sets, declared };
}

function _scdbLoadJusticesMap() {
    if (!fs.existsSync(_SCDB_JUSTICES)) return {};
    let data; try { data = JSON.parse(fs.readFileSync(_SCDB_JUSTICES, 'utf8')); }
    catch { return {}; }
    const out = {};
    for (const [canonical, spec] of Object.entries(data)) {
        const c = canonical.toUpperCase();
        out[c] = c;
        for (const alt of (spec?.alternates || [])) out[String(alt).toUpperCase()] = c;
    }
    return out;
}

function _scdbNormalizeRow(row, varsMaps, varsSets, normIssues, unmappedFields, declaredCols) {
    const out = {};
    for (const [col, raw] of Object.entries(row)) {
        const val = String(raw ?? '').trim();
        const map = varsMaps[col];
        const set = varsSets ? varsSets[col] : null;
        if (map && val && val.toUpperCase() !== 'NULL') {
            const label = map[val];
            if (label === undefined) {
                normIssues.add(`${col}\u0000${val}`);
                out[col] = val;
            } else out[col] = label;
        } else {
            if (set && val && val.toUpperCase() !== 'NULL' && !set.has(val)) {
                normIssues.add(`${col}\u0000${val}`);
            }
            if (unmappedFields && val && val.toUpperCase() !== 'NULL' && !map && !set &&
                declaredCols && !declaredCols.has(col) && !_SCDB_JUSTICE_COLS.includes(col)) {
                let s = unmappedFields.get(col);
                if (!s) { s = new Set(); unmappedFields.set(col, s); }
                if (s.size < 20) s.add(val);
            }
            out[col] = val;
        }
    }
    return out;
}

function _scdbLoadCsv(csvPath, table, varsMaps, varsSets, normIssues, unmappedFields, declaredCols) {
    if (!fs.existsSync(csvPath)) return 0;
    const { rows } = _readCsvRows(csvPath, 'utf8');
    let added = 0;
    for (const row of rows) {
        const cid = (row.caseId || '').trim();
        if (!cid) continue;
        const norm = _scdbNormalizeRow(row, varsMaps, varsSets, normIssues, unmappedFields, declaredCols);
        const justice = {};
        for (const c of _SCDB_JUSTICE_COLS) if (c in norm) justice[c] = norm[c];
        if (!table[cid]) {
            const c = {};
            for (const [k, v] of Object.entries(norm)) {
                if (!_SCDB_JUSTICE_COLS.includes(k)) c[k] = v;
            }
            c.justices = [];
            table[cid] = c;
            added++;
        }
        table[cid].justices.push(justice);
    }
    return added;
}

function _scdbParseIso(s) {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (isNaN(dt.getTime())) return null;
    return dt;
}

function _scdbNormalizeDate(s) {
    s = (s || '').trim();
    if (!s) return '';
    if (_SCDB_ISO_RE.test(s)) return s;
    // Accept M/D/YYYY format too (defensive — modern.csv already converted)
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
    return s;
}

// audit_message is a single free-text string, multiple notes joined by "; "
// (the same convention assets/js/collections/warnings.js's messageParts()
// splits on). These two keep the "Case is missing from SCDB" note in sync
// with whether the case currently has an SCDB-matched `id`, without
// disturbing any other note already recorded there.
const SCDB_MISSING_MESSAGE = 'Case is missing from SCDB';
function _addAuditMessage(c, msg) {
    const parts = String(c.audit_message || '').split('; ').map(s => s.trim()).filter(Boolean);
    if (parts.includes(msg)) return false;
    parts.push(msg);
    c.audit_message = parts.join('; ');
    return true;
}
function _removeAuditMessage(c, msg) {
    if (!c.audit_message) return false;
    const parts = String(c.audit_message).split('; ').map(s => s.trim()).filter(Boolean);
    if (!parts.includes(msg)) return false;
    const kept = parts.filter(p => p !== msg);
    if (kept.length) c.audit_message = kept.join('; ');
    else delete c.audit_message;
    return true;
}

function _scdbDateList(val) {
    if (Array.isArray(val)) return val.map(v => _scdbNormalizeDate(String(v))).filter(Boolean);
    if (typeof val === 'string' && val.trim()) return val.split(',').map(p => _scdbNormalizeDate(p)).filter(Boolean);
    return [];
}
function _scdbContainsDate(ourValue, scdbDate) {
    const target = _scdbNormalizeDate(scdbDate);
    if (!target) return true;
    return _scdbDateList(ourValue).includes(target);
}
// Strict equality: SCDB never stores more than one date per field, so a
// comma-separated multi-day value on our side can never truly equal it. Used
// to decide when a scdb_check flag no longer represents a real
// mismatch (and can be pruned), as opposed to _scdbContainsDate's more
// permissive "is SCDB's date one of ours" check used when first adding one.
function _scdbStrictDateMatches(ourValue, scdbValue) {
    const ourStr = Array.isArray(ourValue) ? ourValue.join(', ') : (ourValue || '');
    return _scdbNormalizeDate(String(ourStr).trim()) === _scdbNormalizeDate(scdbValue || '');
}

// Refresh data/scdb/corrections.json from whatever scdb_check values
// currently exist on cases.json, independent of --scdb's much broader
// corrective pass (votes/result/decision syncing etc.) — so the plain
// default (no-flag) run keeps corrections.json in sync too, without any of
// that other behavior. Scoped to termsToProcess exactly like --scdb's own
// TERM filter: cases outside scope are left completely untouched, never
// pruned, so a single-term/case invocation can't wipe unrelated entries.
function refreshCorrectionsFromCases(termsToProcess, dryRun) {
    let scdb = {};
    try { scdb = _readJson(_SCDB_CACHE_PATH); } catch { return; }
    let correctionsMap = {};
    try { correctionsMap = _readJson(_SCDB_CORRECTIONS_PATH); } catch { /* none yet */ }
    const scdbSkipSet = new Set(Object.keys(correctionsMap).filter(k => correctionsMap[k].skip));

    const visitedCids = new Set();
    const correctionsAccum = {};

    for (const term of termsToProcess) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        for (const c of cases) {
            if (!c || !c.id || scdbSkipSet.has(c.id)) continue;
            const row = scdb[c.id];
            if (!row) continue;
            visitedCids.add(c.id);

            const scdbArg = _scdbNormalizeDate(row.dateArgument || '');
            const scdbRe  = _scdbNormalizeDate(row.dateRearg || row.datreRearg || '');
            const scdbDec = _scdbNormalizeDate(row.dateDecision || '');
            const ourDec  = _scdbNormalizeDate(c.decision || '');

            const errorFields = c.scdb_check
                ? new Set(String(c.scdb_check).split(',').map(s => s.trim()).filter(Boolean))
                : new Set();
            const entry = {};
            if (errorFields.has('argument')) {
                const ourArg = Array.isArray(c.argument) ? c.argument.join(', ') : (c.argument || '');
                if (_scdbNormalizeDate(ourArg.trim()) !== scdbArg) entry.dateArgument = `${scdbArg} -> ${ourArg}`;
            }
            if (errorFields.has('reargument')) {
                const ourRe = Array.isArray(c.reargument) ? c.reargument.join(', ') : (c.reargument || '');
                if (_scdbNormalizeDate(ourRe.trim()) !== scdbRe) entry.dateRearg = `${scdbRe} -> ${ourRe}`;
            }
            if (errorFields.has('decision') && ourDec !== scdbDec) {
                entry.dateDecision = `${scdbDec} -> ${ourDec}`;
            }
            correctionsAccum[c.id] = entry;
        }
    }

    if (!visitedCids.size) return;

    for (const cid of visitedCids) {
        const existing = correctionsMap[cid];
        const fresh = correctionsAccum[cid] || {};
        if (existing && existing.skip) {
            correctionsMap[cid] = { skip: true, note: existing.note, ...fresh };
        } else if (Object.keys(fresh).length) {
            correctionsMap[cid] = fresh;
        } else if (existing) {
            delete correctionsMap[cid];
        }
    }

    const sorted = {};
    for (const k of Object.keys(correctionsMap).sort()) sorted[k] = correctionsMap[k];
    if (dryRun) {
        console.log(`corrections.json: [dry-run] would refresh (${Object.keys(sorted).length} entries).`);
        return;
    }
    const dir = path.dirname(_SCDB_CORRECTIONS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _writeJson(_SCDB_CORRECTIONS_PATH, sorted);
    console.log(`corrections.json: refreshed (${Object.keys(sorted).length} entries).`);
}

function _scdbNormalizeCite(s) { return (s || '').split(/\s+/).filter(Boolean).join(' '); }

// Convert SCDB docket formats to our conventions:
//   "N ORIG" / "N, ORIG." / "N (ORIGINAL)" → "N-Orig"
//   "N MISC" / "N, MISC."                   → "N-Misc"
function _scdbNormalizeDocket(docket) {
    const s = (docket || '').trim();
    const m = s.match(/^(\d+)?\s*[,.(]?\s*(ORIGINAL|ORIG|MISC)\s*[.)]*$/i);
    if (!m) return s;
    const n      = (m[1] || '').trim();
    const suffix = /^orig/i.test(m[2]) ? 'Orig' : 'Misc';
    return n ? `${n}-${suffix}` : suffix;
}

function _scdbParseUsCite(usCite) {
    const m = _US_CITE_RE.exec(_scdbNormalizeCite(usCite));
    if (!m) return ['', ''];
    return [m[1], m[2]];
}

function _scdbLocOpinionHref(volume, page) {
    const v = (volume || '').replace(/\D+/g, '');
    const p = (page    || '').replace(/\D+/g, '');
    if (!v || !p) return '';
    const v3 = v.padStart(3, '0');
    const p3 = p.padStart(3, '0');
    const vp = `${v3}${p3}`;
    return `https://tile.loc.gov/storage-services/service/ll/usrep/usrep${v3}/usrep${vp}/usrep${vp}.pdf`;
}

function _scdbVoteToOurs(v) {
    const t = (v || '').trim().toLowerCase();
    if (t === 'majority' || t === '2') return 'majority';
    if (t === 'dissent' || t === 'minority' || t === '1') return 'minority';
    return t;
}
function _scdbVoteTypeToMajority(v) {
    const t = (v || '').trim().toLowerCase();
    if (_SCDB_MAJ_VOTE_TYPES.has(t)) return 'majority';
    if (_SCDB_MIN_VOTE_TYPES.has(t)) return 'minority';
    return '';
}

let _scdbJusticesMap = {};
let _scdbJusticesTenures = {}; // canonical UPPERCASE name -> [{start, stop}]
let _scdbJusticesChief = {};   // canonical UPPERCASE name -> [{start, stop}] (chief tenures)
let _scdbJusticesStart = {};   // canonical UPPERCASE name -> earliest dateStart (YYYY-MM-DD)

function _scdbLoadJusticesTenures() {
    if (!fs.existsSync(_SCDB_JUSTICES)) return {};
    let data; try { data = JSON.parse(fs.readFileSync(_SCDB_JUSTICES, 'utf8')); }
    catch { return {}; }
    const out = {};
    _scdbJusticesChief = {};
    _scdbJusticesStart = {};
    // "YYYY-MM" → "YYYY-MM-01" for comparison with ISO decision dates.
    const termToDate = (s) => /^\d{4}-\d{2}$/.test(s) ? `${s}-01` : s;
    for (const [canonical, spec] of Object.entries(data)) {
        const c = canonical.toUpperCase();
        const tenures = [];
        if (Array.isArray(spec?.tenures)) {
            for (const t of spec.tenures) tenures.push({ start: t.dateStart || '', stop: t.dateStop || '' });
        } else if (spec?.dateStart || spec?.dateStop) {
            tenures.push({ start: spec.dateStart || '', stop: spec.dateStop || '' });
        }
        if (tenures.length) out[c] = tenures;
        const starts = tenures.map(t => t.start).filter(Boolean).sort();
        if (starts.length) _scdbJusticesStart[c] = starts[0];

        // Parse titles to find chief-justice date ranges. Each entry like
        // "CHIEF JUSTICE", "CHIEF JUSTICE >= 1986-10", "JUSTICE < 1986-10".
        const titles = Array.isArray(spec?.titles) ? spec.titles : [];
        const chiefRanges = [];
        const baseStart = (tenures[0] && tenures[0].start) || '';
        const baseStop  = (tenures[tenures.length - 1] && tenures[tenures.length - 1].stop) || '';
        for (const t of titles) {
            const m = String(t).match(/^\s*CHIEF\s+JUSTICE\b(?:\s*(>=|<=|>|<)\s*(\S+))?/i);
            if (!m) continue;
            const op = m[1];
            const ref = m[2] ? termToDate(m[2]) : '';
            let start = baseStart, stop = baseStop;
            if (op === '>=' || op === '>') start = ref;
            else if (op === '<=' || op === '<') stop = ref;
            chiefRanges.push({ start, stop });
        }
        if (chiefRanges.length) _scdbJusticesChief[c] = chiefRanges;
    }
    return out;
}

// Resolve a vote-name to its canonical UPPERCASE name (via the alternates map).
function _scdbCanonName(name) {
    let nm = String(name || '').trim().toUpperCase();
    if (_scdbJusticesMap[nm]) nm = _scdbJusticesMap[nm];
    return nm;
}

function _scdbIsChiefOn(name, isoDate) {
    const ranges = _scdbJusticesChief[_scdbCanonName(name)];
    if (!ranges) return false;
    if (!isoDate) return ranges.length > 0;
    return ranges.some(r =>
        (!r.start || isoDate >= r.start) &&
        (!r.stop  || isoDate <= r.stop));
}

function _scdbIsServingOn(canonical, isoDate) {
    const tenures = _scdbJusticesTenures[canonical];
    if (!tenures) return false;
    if (!isoDate) return tenures.length > 0;
    return tenures.some(t =>
        (!t.start || isoDate >= t.start) &&
        (!t.stop || isoDate <= t.stop)
    );
}

// Sort a votes array by seniority for the given date: chief justice first,
// then associates by ascending dateStart (ties broken by name for stability).
function _scdbSortVotesBySeniority(votes, isoDate) {
    const decorated = votes.map((v, i) => {
        const nm = _scdbCanonName(v && v.name);
        return {
            v, i,
            chief: _scdbIsChiefOn(nm, isoDate) ? 0 : 1,
            start: _scdbJusticesStart[nm] || '9999-99-99',
            name:  nm,
        };
    });
    decorated.sort((a, b) =>
        a.chief - b.chief ||
        a.start.localeCompare(b.start) ||
        a.name.localeCompare(b.name) ||
        a.i - b.i);
    return decorated.map(d => d.v);
}

function _scdbVotesOrderEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (_scdbCanonName(a[i] && a[i].name) !== _scdbCanonName(b[i] && b[i].name)) return false;
    }
    return true;
}

let _seniorityLoaded = false;
function _ensureSeniorityLoaded() {
    if (_seniorityLoaded) return;
    _seniorityLoaded = true;
    if (!Object.keys(_scdbJusticesMap).length) _scdbJusticesMap = _scdbLoadJusticesMap();
    if (!Object.keys(_scdbJusticesTenures).length) _scdbJusticesTenures = _scdbLoadJusticesTenures();
}

// Verify each case's votes array is in seniority order (chief justice first,
// then associates by ascending dateStart). When `update` is true, re-sort.
// Returns the number of cases whose votes were re-sorted.
function verifyVoteSeniority(term, cases, update) {
    _ensureSeniorityLoaded();
    let resorted = 0;
    for (const c of cases) {
        if (!Array.isArray(c.votes) || c.votes.length < 2) continue;
        const decIso = _scdbNormalizeDate(c.decision || c.argument || '');
        const sorted = _scdbSortVotesBySeniority(c.votes, decIso);
        if (_scdbVotesOrderEqual(c.votes, sorted)) continue;
        const cid = c.id || c.number || c.title || '?';
        if (update) {
            c.votes = sorted;
            resorted++;
        } else {
            console.log(`WARNING: ${term}/${cid} (${firstTitle(c.title) || cid}): votes not in seniority order`);
        }
    }
    return resorted;
}

// Slugify a justice name (mirrors makeAdvocateId in update_advocates.js).
function _justiceSlug(name) {
    const ascii = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const noPunct = ascii.replace(/[^\w\s-]/g, '');
    return noPunct.replace(/[\s\-_]+/g, '_').replace(/^_+|_+$/g, '');
}

// Title-case a canonical UPPER-CASE justice name (e.g. "OLIVER ELLSWORTH" → "Oliver Ellsworth").
// Roman numeral suffixes after a comma (e.g. ", II") are fully uppercased.
// "Mc" surnames (e.g. "MCREYNOLDS") get their next letter capitalized too
// (→ "McReynolds"), not just the "M".
function _justiceDisplayName(canonical) {
    return String(canonical || '')
        .toLowerCase()
        .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
        .replace(/\bMc([a-z])/g, (_, c) => 'Mc' + c.toUpperCase())
        .replace(/,\s+([IVXivx]+)$/, (_, s) => ', ' + s.toUpperCase());
}

// Return all justices serving on `isoDate` sorted by seniority:
// Chief Justice first, then Associates by ascending dateStart.
function _getServingJusticesSorted(isoDate) {
    const result = [];
    for (const canonical of Object.keys(_scdbJusticesStart)) {
        if (!_scdbIsServingOn(canonical, isoDate)) continue;
        const isChief = _scdbIsChiefOn(canonical, isoDate);
        result.push({
            canonical,
            title:   isChief ? 'CHIEF JUSTICE' : 'JUSTICE',
            start:   _scdbJusticesStart[canonical] || '9999-99-99',
            isChief,
        });
    }
    result.sort((a, b) => {
        if (a.isChief !== b.isChief) return a.isChief ? -1 : 1;
        return a.start.localeCompare(b.start) || a.canonical.localeCompare(b.canonical);
    });
    return result;
}

// For each case (optionally filtered to `caseFilter`) in cases.json, open every
// text_href transcript and ensure every justice serving on the argument date is
// listed in media.speakers (as JUSTICE or CHIEF JUSTICE). Missing justices are
// inserted in seniority order (Chief first, then by dateStart). Non-justice
// speakers retain their original positions, appended after the justice block.
function verifySpeakersInTranscripts(casesPath, term, caseFilter, dryRun) {
    _ensureSeniorityLoaded();

    if (!fs.existsSync(casesPath)) return;
    let cases;
    try { cases = _readJson(casesPath); } catch { return; }
    if (!Array.isArray(cases)) return;

    const casesDir = path.join(path.dirname(casesPath), 'cases');

    for (const c of cases) {
        const folder = _caseFolder(c.number || c.id || '');
        if (caseFilter && folder !== caseFilter && c.id !== caseFilter &&
            !(c.number || '').split(',').map(s => s.trim()).includes(caseFilter)) continue;

        for (const ev of c.events || []) {
            const th = ev.text_href || '';
            if (!th || /^https?:\/\//.test(th)) continue;

            const relPath = th.includes('/') ? th : `${folder}/${th}`;
            const transcriptPath = path.join(casesDir, relPath);
            if (!fs.existsSync(transcriptPath)) continue;

            // Derive argument date from event field, falling back to filename.
            let argDate = ev.date || '';
            if (!argDate) {
                const dm = path.basename(th).match(/^(\d{4}-\d{2}-\d{2})/);
                if (dm) argDate = dm[1];
            }
            if (!argDate) continue;

            let transcript;
            try { transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')); }
            catch { continue; }
            if (!transcript || typeof transcript !== 'object' || !transcript.media) continue;
            if (!Array.isArray(transcript.media.speakers)) continue;

            const speakers = transcript.media.speakers;
            const turns    = Array.isArray(transcript.turns) ? transcript.turns : [];
            const label    = `${term}/${relPath}`;

            // Collect turn speaker names in first-appearance order.
            const turnSpeakerNames = [];
            const seenInTurns = new Set();
            for (const turn of turns) {
                const name = turn.name || '';
                if (name && !seenInTurns.has(name)) {
                    seenInTurns.add(name);
                    turnSpeakerNames.push(name);
                }
            }

            const hasUnknownInTurns = seenInTurns.has('UNKNOWN JUSTICE');

            // Map serving-justice canonical names → existing speaker objects.
            // Track UNKNOWN JUSTICE separately (it is not a resolvable canonical name).
            const existingCanonicals = new Map();
            let unknownJusticeSpeaker = null;
            for (const sp of speakers) {
                const t = (sp.title || '').toUpperCase();
                if (t !== 'JUSTICE' && t !== 'CHIEF JUSTICE') continue;
                if ((sp.name || '').toUpperCase() === 'UNKNOWN JUSTICE') {
                    unknownJusticeSpeaker = sp;
                    continue;
                }
                const canon = _scdbCanonName(sp.name);
                if (canon && !existingCanonicals.has(canon)) existingCanonicals.set(canon, sp);
            }

            const serving = _getServingJusticesSorted(argDate);

            // Sanity-check: more than 9 serving justices indicates a data problem.
            if (serving.length > 9) {
                console.log(`  WARNING: ${label}: ${serving.length} justices found serving on ${argDate} (expected ≤ 9) — skipping`);
                continue;
            }

            const missing     = serving.filter(j => !existingCanonicals.has(j.canonical));
            const needUnknown = (hasUnknownInTurns || unknownJusticeSpeaker) && !unknownJusticeSpeaker;

            // Build the complete expected justice block now (used for cross-check and
            // for writing). Serving justices in seniority order, UNKNOWN JUSTICE last.
            const justiceSpeakers = serving.map(j =>
                existingCanonicals.has(j.canonical)
                    ? existingCanonicals.get(j.canonical)
                    : { name: j.canonical, title: j.title }
            );
            if (hasUnknownInTurns || unknownJusticeSpeaker) {
                justiceSpeakers.push(unknownJusticeSpeaker || { name: 'UNKNOWN JUSTICE', title: 'JUSTICE' });
            }

            // Build the complete expected non-justice block. Ordered by first appearance
            // in turns, with speakers absent from turns appended at the end.
            // UNKNOWN SPEAKER is always placed last, regardless of turn order.
            const justiceCanonicalSet = new Set(serving.map(j => j.canonical));
            justiceCanonicalSet.add('UNKNOWN JUSTICE');

            const nonJusticeByName = new Map();
            let unknownSpeakerObj = null;
            for (const sp of speakers) {
                const t = (sp.title || '').toUpperCase();
                if (t === 'JUSTICE' || t === 'CHIEF JUSTICE') continue;
                const name = sp.name || '';
                if (!name) continue;
                if (name.toUpperCase() === 'UNKNOWN SPEAKER') {
                    unknownSpeakerObj = unknownSpeakerObj || sp;
                    continue;
                }
                if (!nonJusticeByName.has(name)) nonJusticeByName.set(name, sp);
            }

            const nonJusticeSpeakers = [];
            const seenNonJustice = new Set();
            for (const name of turnSpeakerNames) {
                if (justiceCanonicalSet.has(_scdbCanonName(name))) continue;
                if (name.toUpperCase() === 'UNKNOWN SPEAKER') continue; // always last
                if (seenNonJustice.has(name)) continue;
                seenNonJustice.add(name);
                const sp = nonJusticeByName.get(name);
                if (sp) { nonJusticeSpeakers.push(sp); nonJusticeByName.delete(name); }
            }
            // Append non-justice speakers absent from turns (preserve relative order).
            for (const sp of nonJusticeByName.values()) nonJusticeSpeakers.push(sp);
            // UNKNOWN SPEAKER always goes last.
            if (unknownSpeakerObj) nonJusticeSpeakers.push(unknownSpeakerObj);

            // Cross-check: every turn speaker must appear in the final speakers array.
            // Check against the fully-rebuilt list so we don't warn about justices we're
            // about to add.
            const finalSpeakerNames = new Set([
                ...justiceSpeakers.map(sp => sp.name || ''),
                ...nonJusticeSpeakers.map(sp => sp.name || ''),
            ]);
            for (const name of turnSpeakerNames) {
                if (!finalSpeakerNames.has(name)) {
                    console.log(`  WARNING: ${label}: turns speaker '${name}' not listed in speakers`);
                }
            }

            if (missing.length === 0 && !needUnknown) continue;

            if (dryRun) {
                const parts = [];
                if (missing.length) parts.push(`would add ${missing.length} missing justice(s): ${missing.map(j => j.canonical).join(', ')}`);
                if (needUnknown) parts.push('would add UNKNOWN JUSTICE');
                console.log(`  [dry-run] ${label}: ${parts.join('; ')}`);
            } else {
                transcript.media.speakers = [...justiceSpeakers, ...nonJusticeSpeakers];
                _writeJson(transcriptPath, transcript);
                if (_VERBOSE) {
                    const parts = [];
                    if (missing.length) parts.push(`added ${missing.length} missing justice(s): ${missing.map(j => j.canonical).join(', ')}`);
                    if (needUnknown) parts.push('added UNKNOWN JUSTICE');
                    console.log(`  ${label}: ${parts.join('; ')}`);
                }
            }
        }
    }
}

// Scan every term's cases.json, find cases with exactly one "minority" vote,
// and rebuild courts/ussc/people/lonedissent_justices.json plus per-justice
// files in courts/ussc/people/justices/.
function processLoneDissenters(termsToProcess, dryRun) {
    _ensureSeniorityLoaded();
    const PEOPLE_DIR    = path.join(REPO_ROOT, 'courts', 'ussc', 'people');
    const JUSTICES_DIR  = path.join(PEOPLE_DIR, 'justices', 'lone');
    const INDEX_FILE    = path.join(PEOPLE_DIR, 'justices', 'lone_dissents.json');

    // canonical name -> [case-entry, ...]
    const byJustice = new Map();

    for (const term of termsToProcess) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        for (const c of cases) {
            if (!Array.isArray(c.votes) || !c.votes.length) continue;
            const minorityVotes = c.votes.filter(v => v && v.vote === 'minority');
            if (minorityVotes.length !== 1) continue;
            const canonical = _scdbCanonName(minorityVotes[0].name);
            if (!canonical) continue;
            const baseTitle = firstTitle(c.title) || '';
            const decisionDate = c.decision || '';
            const yearMatch = /^(\d{4})/.exec(decisionDate);
            const titled = (baseTitle && yearMatch) ? `${baseTitle} (${yearMatch[1]})` : baseTitle;
            const entry = {
                title:    titled,
                term,
                number:   _primaryCaseNumber(c),
                argument: c.argument || '',
                decision: c.decision || '',
            };
            if (c.files) entry.files = c.files;
            if (!byJustice.has(canonical)) byJustice.set(canonical, []);
            byJustice.get(canonical).push(entry);
        }
    }

    if (!byJustice.size) {
        if (_VERBOSE) console.log('Lone dissenters: none found in scope.');
        return;
    }

    if (!fs.existsSync(JUSTICES_DIR)) _mkdirSync(JUSTICES_DIR, { recursive: true });

    // Build index entries.
    const index = [];
    for (const [canonical, list] of byJustice) {
        list.sort((a, b) =>
            (a.decision || a.argument || '').localeCompare(b.decision || b.argument || '') ||
            (a.argument || '').localeCompare(b.argument || '') ||
            (a.term || '').localeCompare(b.term || '') ||
            (a.title || '').localeCompare(b.title || ''));
        const caseCount = list.length;
        // list is sorted oldest→newest; [0] = oldest, [last] = newest.
        const dateStart = caseCount ? (list[0].decision || list[0].argument || '') : '';
        const dateStop  = caseCount ? (list[caseCount - 1].decision || list[caseCount - 1].argument || '') : '';
        const entry = {
            id:    _justiceSlug(canonical),
            name:  _justiceDisplayName(canonical),
            cases: caseCount,
        };
        if (dateStart) entry.dateStart = dateStart;
        if (dateStop)  entry.dateStop  = dateStop;
        index.push(entry);
    }
    const _lonLastName = (name) => (name || '').trim().split(/\s+/).pop() || '';
    index.sort((a, b) => {
        if (a.cases !== b.cases) return b.cases - a.cases;
        const la = _lonLastName(a.name), lb = _lonLastName(b.name);
        return la < lb ? -1 : la > lb ? 1 : 0;
    });

    const indexChanged = _jsonChanged(INDEX_FILE, index);
    if (indexChanged) _writeJson(INDEX_FILE, index);

    // Write per-justice files, preserving any existing details / highlights.
    const knownIds = new Set();
    for (const [canonical, list] of byJustice) {
        const id = _justiceSlug(canonical);
        knownIds.add(id);
        const file = path.join(JUSTICES_DIR, `${id}.json`);
        let details = {};
        let highlights = [];
        if (fs.existsSync(file)) {
            try {
                const raw = _readJson(file);
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    details    = raw.details    || {};
                    highlights = raw.highlights || [];
                }
            } catch { /* ignore */ }
        }
        const output = { details, highlights, cases: list };
        if (_jsonChanged(file, output)) _writeJson(file, output);
    }

    // Remove orphan per-justice files for justices no longer in the index.
    if (fs.existsSync(JUSTICES_DIR)) {
        for (const name of fs.readdirSync(JUSTICES_DIR)) {
            if (!name.endsWith('.json')) continue;
            const stem = name.slice(0, -5);
            if (knownIds.has(stem)) continue;
            _unlinkSync(path.join(JUSTICES_DIR, name));
            if (_VERBOSE) console.log(`  Removed stale lone-dissenter file: courts/ussc/people/justices/lone/${name}`);
        }
    }

    const verb = dryRun ? 'Would update' : 'Updated';
    if (_VERBOSE || indexChanged) {
        console.log(`Lone dissenters: ${verb} ${index.length} justice file(s) (${[...byJustice.values()].reduce((a, l) => a + l.length, 0)} case(s)).`);
    }
}

// Scan every term's cases.json, find cases where a justice has "opinion": true,
// and rebuild courts/ussc/people/justices/opinions.json plus per-justice
// files in courts/ussc/people/justices/op/.
function processOpinionAuthors(termsToProcess, dryRun) {
    _ensureSeniorityLoaded();
    const PEOPLE_DIR    = path.join(REPO_ROOT, 'courts', 'ussc', 'people');
    const JUSTICES_DIR  = path.join(PEOPLE_DIR, 'justices', 'opinions');
    const INDEX_FILE    = path.join(PEOPLE_DIR, 'justices', 'opinions.json');

    // canonical name -> [case-entry, ...]
    const byJustice = new Map();

    for (const term of termsToProcess) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        for (const c of cases) {
            if (!Array.isArray(c.votes) || !c.votes.length) continue;
            const opinionVotes = c.votes.filter(v => v && v.opinion === true);
            for (const vote of opinionVotes) {
                const canonical = _scdbCanonName(vote.name);
                if (!canonical) continue;
                const baseTitle = firstTitle(c.title) || '';
                const decisionDate = c.decision || '';
                const yearMatch = /^(\d{4})/.exec(decisionDate);
                const titled = (baseTitle && yearMatch) ? `${baseTitle} (${yearMatch[1]})` : baseTitle;
                const entry = {
                    title:    titled,
                    term,
                    number:   _primaryCaseNumber(c),
                    argument: c.argument || '',
                    decision: c.decision || '',
                };
                if (c.files) entry.files = c.files;
                if (!byJustice.has(canonical)) byJustice.set(canonical, []);
                byJustice.get(canonical).push(entry);
            }
        }
    }

    if (!byJustice.size) {
        if (_VERBOSE) console.log('Opinion authors: none found in scope.');
        return;
    }

    if (!fs.existsSync(JUSTICES_DIR)) _mkdirSync(JUSTICES_DIR, { recursive: true });

    // Build index entries.
    const index = [];
    for (const [canonical, list] of byJustice) {
        list.sort((a, b) =>
            (a.decision || a.argument || '').localeCompare(b.decision || b.argument || '') ||
            (a.argument || '').localeCompare(b.argument || '') ||
            (a.term || '').localeCompare(b.term || '') ||
            (a.title || '').localeCompare(b.title || ''));
        const caseCount = list.length;
        // list is sorted oldest→newest; [0] = oldest, [last] = newest.
        const dateStart = caseCount ? (list[0].decision || list[0].argument || '') : '';
        const dateStop  = caseCount ? (list[caseCount - 1].decision || list[caseCount - 1].argument || '') : '';
        const entry = {
            id:    _justiceSlug(canonical),
            name:  _justiceDisplayName(canonical),
            cases: caseCount,
        };
        if (dateStart) entry.dateStart = dateStart;
        if (dateStop)  entry.dateStop  = dateStop;
        index.push(entry);
    }
    const _opLastName = (name) => (name || '').trim().split(/\s+/).pop() || '';
    index.sort((a, b) => {
        if (a.cases !== b.cases) return b.cases - a.cases;
        const la = _opLastName(a.name), lb = _opLastName(b.name);
        return la < lb ? -1 : la > lb ? 1 : 0;
    });

    const indexChanged = _jsonChanged(INDEX_FILE, index);
    if (indexChanged) _writeJson(INDEX_FILE, index);

    // Write per-justice files, preserving any existing details / highlights.
    const knownIds = new Set();
    for (const [canonical, list] of byJustice) {
        const id = _justiceSlug(canonical);
        knownIds.add(id);
        const file = path.join(JUSTICES_DIR, `${id}.json`);
        let details = {};
        let highlights = [];
        if (fs.existsSync(file)) {
            try {
                const raw = _readJson(file);
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    details    = raw.details    || {};
                    highlights = raw.highlights || [];
                }
            } catch { /* ignore */ }
        }
        const output = { details, highlights, cases: list };
        if (_jsonChanged(file, output)) _writeJson(file, output);
    }

    // Remove orphan per-justice files for justices no longer in the index.
    if (fs.existsSync(JUSTICES_DIR)) {
        for (const name of fs.readdirSync(JUSTICES_DIR)) {
            if (!name.endsWith('.json')) continue;
            const stem = name.slice(0, -5);
            if (knownIds.has(stem)) continue;
            _unlinkSync(path.join(JUSTICES_DIR, name));
            if (_VERBOSE) console.log(`  Removed stale opinion-author file: courts/ussc/people/justices/op/${name}`);
        }
    }

    const verb = dryRun ? 'Would update' : 'Updated';
    if (_VERBOSE || indexChanged) {
        console.log(`Opinion authors: ${verb} ${index.length} justice file(s) (${[...byJustice.values()].reduce((a, l) => a + l.length, 0)} case(s)).`);
    }
}

// =====================================================================
// Vocal-justice aggregation
// =====================================================================

// Parse "HH:MM:SS.NN" (or "HH:MM:SS") to total seconds (float).
function _parseTimeSecs(s) {
    if (!s) return 0;
    const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(s).trim());
    if (!m) return 0;
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

// Format total seconds to "HH:MM:SS.NN".
function _formatTimeSecs(secs) {
    if (secs < 0) secs = 0;
    const h  = Math.floor(secs / 3600);
    const m  = Math.floor((secs % 3600) / 60);
    const s  = secs % 60;
    const ws = Math.floor(s);
    const nn = Math.min(99, Math.round((s - ws) * 100));
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ws).padStart(2, '0')}.${String(nn).padStart(2, '0')}`;
}

// Scan every term's cases.json, open every time-aligned text_href transcript,
// compute how long each justice spoke (sum of turn durations), and write:
//   courts/ussc/people/justices/vocal_justices.json          — index sorted by total desc
//   courts/ussc/people/justices/vocal/<id>.json     — per-justice, cases sorted by vocal desc
function processVocalJustices(allTerms, dryRun) {
    _ensureSeniorityLoaded();
    const PEOPLE_DIR   = path.join(REPO_ROOT, 'courts', 'ussc', 'people');
    const JUSTICES_DIR = path.join(PEOPLE_DIR, 'justices', 'vocal');
    const INDEX_FILE   = path.join(PEOPLE_DIR, 'justices', 'vocal_justices.json');

    // canonical → { totalSecs, cases: Map<caseUniqueKey, caseAccum> }
    // caseAccum: { meta (title/term/number/argument/decision), totalSecs, firstEventIdx, firstTurnNum }
    const byJustice = new Map();

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        const casesDir = path.join(TERMS_DIR, term, 'cases');

        for (const c of cases) {
            const folder     = _caseFolder(c.number || c.id || '');
            const baseTitle  = firstTitle(c.title) || '';
            const decMatch   = /^(\d{4})/.exec(c.decision || '');
            const titled     = (baseTitle && decMatch) ? `${baseTitle} (${decMatch[1]})` : baseTitle;
            const caseMeta   = {
                title:    titled,
                term,
                number:   _primaryCaseNumber(c),
                argument: c.argument || '',
                decision: c.decision || '',
            };
            if (c.files) caseMeta.files = c.files;

            // canonical → { totalSecs, firstEventIdx, firstTurnNum } — accumulated within this case
            const caseAccum = new Map();

            let eventIdx = 0;
            for (const ev of (c.events || [])) {
                eventIdx++;
                const evType = ev.type || 'argument';
                if (evType !== 'argument' && evType !== 'reargument') continue;
                const th = ev.text_href || '';
                if (!th || /^https?:\/\//.test(th)) continue;

                const relPath = th.includes('/') ? th : `${folder}/${th}`;
                const tPath   = path.join(casesDir, relPath);
                if (!fs.existsSync(tPath)) continue;

                let transcript;
                try { transcript = JSON.parse(fs.readFileSync(tPath, 'utf8')); } catch { continue; }
                if (!transcript || typeof transcript !== 'object' || Array.isArray(transcript)) continue;

                const rawTurns = Array.isArray(transcript.turns) ? transcript.turns : [];
                if (!rawTurns.length) continue;

                // Skip unaligned transcripts — all-zero times carry no duration information.
                const isAligned = rawTurns.length === 1 ||
                    rawTurns.some(t => t?.time && /[1-9]/.test(t.time));
                if (!isAligned) continue;

                // Build turn-name → canonical map from media.speakers.
                const nameToCanon = new Map();
                for (const sp of (transcript.media?.speakers || [])) {
                    const title = (sp.title || '').toUpperCase();
                    if (title !== 'JUSTICE' && title !== 'CHIEF JUSTICE') continue;
                    const nm = (sp.name || '').toUpperCase();
                    if (nm === 'UNKNOWN JUSTICE' || nm === 'UNKNOWN SPEAKER') continue;
                    const canon = _scdbCanonName(sp.name);
                    if (canon && _scdbJusticesTenures[canon]) nameToCanon.set(nm, canon);
                }

                // Parse all turn start times once. A turn occasionally has a bogus
                // timestamp (e.g. "00:00:00.00" from a failed alignment) sandwiched
                // between otherwise-correct times; left as-is, that turn's "duration"
                // (next turn's start minus its own) balloons to nearly the whole
                // transcript. Clamp each time to be no earlier than the previous one
                // so a bad reset can't manufacture a huge bogus gap.
                const times = rawTurns.map(t => _parseTimeSecs(t?.time));
                for (let i = 1; i < times.length; i++) {
                    if (times[i] < times[i - 1]) times[i] = times[i - 1];
                }

                for (let i = 0; i < rawTurns.length; i++) {
                    const turn = rawTurns[i];
                    const nm   = (turn?.name || '').toUpperCase();
                    if (!nm) continue;

                    const canon = nameToCanon.get(nm);
                    if (!canon) continue;

                    // Duration = next turn start − this turn start (last turn contributes 0).
                    const duration = (i + 1 < rawTurns.length)
                        ? Math.max(0, times[i + 1] - times[i])
                        : 0;

                    const turnNum = turn.turn ?? (i + 1);

                    if (!caseAccum.has(canon)) {
                        caseAccum.set(canon, { totalSecs: 0, firstEventIdx: eventIdx, firstTurnNum: turnNum });
                    }
                    caseAccum.get(canon).totalSecs += duration;
                }
            }

            // Merge this case's accum into the per-justice global map.
            for (const [canon, accum] of caseAccum) {
                if (accum.totalSecs <= 0) continue;
                if (!byJustice.has(canon)) byJustice.set(canon, { totalSecs: 0, cases: new Map() });
                const jEntry = byJustice.get(canon);
                jEntry.totalSecs += accum.totalSecs;
                jEntry.cases.set(`${term}/${folder}`, { meta: caseMeta, ...accum });
            }
        }
    }

    if (!byJustice.size) {
        if (_VERBOSE) console.log('Vocal justices: none found in scope.');
        return;
    }

    if (!fs.existsSync(JUSTICES_DIR)) _mkdirSync(JUSTICES_DIR, { recursive: true });

    // Build and write per-justice files.
    const knownIds = new Set();
    let totalCases = 0;
    for (const [canon, jEntry] of byJustice) {
        const id = _justiceSlug(canon);
        knownIds.add(id);

        // Sort cases by totalSecs desc.
        const sorted = [...jEntry.cases.values()]
            .sort((a, b) => b.totalSecs - a.totalSecs);
        totalCases += sorted.length;

        const cases = sorted.map(({ meta, totalSecs, firstEventIdx, firstTurnNum }) => ({
            ...meta,
            vocal: _formatTimeSecs(totalSecs),
            event: firstEventIdx,
            turn:  firstTurnNum,
        }));

        const file = path.join(JUSTICES_DIR, `${id}.json`);
        let details = {}, highlights = [];
        if (fs.existsSync(file)) {
            try {
                const raw = _readJson(file);
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    details    = raw.details    || {};
                    highlights = raw.highlights || [];
                }
            } catch { /* ignore */ }
        }
        const output = { details, highlights, cases };
        if (_jsonChanged(file, output)) _writeJson(file, output);
    }

    // Build index sorted by totalSecs desc.
    const index = [...byJustice.entries()]
        .sort(([, a], [, b]) => b.totalSecs - a.totalSecs)
        .map(([canon, jEntry]) => ({
            id:    _justiceSlug(canon),
            name:  _justiceDisplayName(canon),
            cases: jEntry.cases.size,
            total: _formatTimeSecs(jEntry.totalSecs),
        }));

    const indexChanged = _jsonChanged(INDEX_FILE, index);
    if (indexChanged) _writeJson(INDEX_FILE, index);

    // Remove orphan per-justice files.
    if (fs.existsSync(JUSTICES_DIR)) {
        for (const name of fs.readdirSync(JUSTICES_DIR)) {
            if (!name.endsWith('.json')) continue;
            const stem = name.slice(0, -5);
            if (knownIds.has(stem)) continue;
            _unlinkSync(path.join(JUSTICES_DIR, name));
            if (_VERBOSE) console.log(`  Removed stale vocal-justice file: courts/ussc/people/justices/vocal/${name}`);
        }
    }

    const verb = dryRun ? 'Would update' : 'Updated';
    if (_VERBOSE || indexChanged) {
        console.log(`Vocal justices: ${verb} ${index.length} justice file(s) (${totalCases} case(s)).`);
    }
}

// =====================================================================
// Bench groups
// =====================================================================

// Build courts/ussc/people/justices/benches.json: one entry per distinct
// composition of the Court.  A new bench is recorded each time the membership
// changes (a justice joins or departs).  The first bench starts the day after
// the Court's very first departure.
// Every photo for a bench: { path, desc? } — path to a jpg under this dir,
// desc from a same-named .txt when one exists (omitted otherwise; the front
// end falls back to its own generic "In seniority order: ..." description
// for any image lacking one). The primary photo is an exact "<id>.jpg" (e.g.
// "burger1.jpg"), else the chief-justice family's default "<slug>.jpg" (e.g.
// "burger.jpg", the id with its trailing bench number stripped); additional
// photos are "<id><letter>.jpg" (e.g. "chase2b.jpg", "chase2c.jpg" for bench
// "chase2"), in letter order. Returns [] if no photo exists at all.
const _BENCH_IMAGES_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'collections', 'benches');
function _benchImages(benchId) {
    const images = [];
    const addIfExists = (jpgName) => {
        if (!fs.existsSync(path.join(_BENCH_IMAGES_DIR, jpgName))) return false;
        const txtPath = path.join(_BENCH_IMAGES_DIR, jpgName.replace(/\.jpg$/, '.txt'));
        const desc = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : '';
        images.push({ path: `/courts/ussc/collections/benches/${jpgName}`, ...(desc ? { desc } : {}) });
        return true;
    };
    if (!addIfExists(`${benchId}.jpg`)) {
        const base = benchId.replace(/\d+$/, '');
        if (base !== benchId) addIfExists(`${base}.jpg`);
    }
    let files;
    try { files = fs.readdirSync(_BENCH_IMAGES_DIR); } catch { files = []; }
    const extraRe = new RegExp(`^${benchId}([b-z])\\.jpg$`);
    files.map(f => f.match(extraRe)).filter(Boolean)
        .sort((a, b) => a[1].localeCompare(b[1]))
        .forEach(m => addIfExists(m[0]));
    return images;
}

function processBenches(dryRun) {
    _ensureSeniorityLoaded();

    const OUT_FILE = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices', 'benches.json');

    if (!fs.existsSync(_SCDB_JUSTICES)) {
        console.log('processBenches: justices.json not found, skipping.');
        return;
    }
    const raw = JSON.parse(fs.readFileSync(_SCDB_JUSTICES, 'utf8'));

    // Build a flat list of every continuous period of service.
    const allTenures = [];
    for (const [canonical, spec] of Object.entries(raw)) {
        const canonUpper = canonical.toUpperCase();
        const id = _justiceSlug(canonical);
        const tenureList = Array.isArray(spec.tenures)
            ? spec.tenures.map(t => ({ dateStart: t.dateStart || '', dateStop: t.dateStop || '' }))
            : [{ dateStart: spec.dateStart || '', dateStop: spec.dateStop || '' }];
        for (const { dateStart, dateStop } of tenureList) {
            if (dateStart) allTenures.push({ canonical: canonUpper, id, dateStart, dateStop });
        }
    }

    // Add n days to an ISO date string.
    function addDays(isoDate, n) {
        const ms = Date.parse(isoDate + 'T12:00:00Z') + n * 86400000;
        return new Date(ms).toISOString().slice(0, 10);
    }

    // Return all tenures active on the given ISO date.
    function servingOn(date) {
        return allTenures.filter(t =>
            t.dateStart <= date && (!t.dateStop || t.dateStop >= date)
        );
    }

    // Stable sort key for a set of serving tenures.
    function compositionKey(tenures) {
        return tenures.map(t => t.canonical).sort().join('\0');
    }

    // Normalize same-day handoffs: if justice B's dateStart equals justice A's
    // dateStop (e.g. Breyer retired 2022-06-30, Jackson sworn in 2022-06-30),
    // push B's dateStart to A's dateStop+1 for all bench calculations.
    // This collapses what would be two separate change dates into one, preventing
    // a phantom 1-day bench and ensuring the outgoing court ends on its natural
    // last day while the incoming court starts the following day.
    const stopDateSet = new Set(allTenures.filter(t => t.dateStop).map(t => t.dateStop));
    for (const t of allTenures) {
        if (stopDateSet.has(t.dateStart)) {
            t.dateStart = addDays(t.dateStart, 1);
        }
    }

    // The first bench starts the day after the Court's first departure.
    const firstStop = allTenures
        .filter(t => t.dateStop)
        .map(t => t.dateStop)
        .sort()[0];
    if (!firstStop) { console.log('processBenches: no departures found, skipping.'); return; }
    const firstChangeDate = addDays(firstStop, 1);

    // Collect all composition-change dates from firstChangeDate onward:
    //   - dateStart: a justice joins on this day → bench changes on this day
    //   - dateStop+1: a justice's last day was dateStop → bench changes the next day
    const changeDates = new Set([firstChangeDate]);
    for (const t of allTenures) {
        if (t.dateStart >= firstChangeDate) changeDates.add(t.dateStart);
        if (t.dateStop) {
            const next = addDays(t.dateStop, 1);
            if (next >= firstChangeDate) changeDates.add(next);
        }
    }
    const sortedChangeDates = [...changeDates].sort();

    // True if `canonical` held the chief-justice title at any point within
    // the bench's date range [dateStart, dateStop].  Handles the case where a
    // sitting associate is elevated to CJ mid-bench without a membership change.
    function wasChiefDuring(canonical, dateStart, dateStop) {
        const ranges = _scdbJusticesChief[canonical];
        if (!ranges) return false;
        const effStop = dateStop || '9999-99-99';
        return ranges.some(r =>
            (!r.start || r.start <= effStop) &&
            (!r.stop  || r.stop  >= dateStart)
        );
    }

    // Phase 1: walk change dates, collecting raw bench spans {dateStart, dateStop, key}.
    const rawBenches = [];
    let prevKey   = null;
    let benchStart = null;

    for (const date of sortedChangeDates) {
        const serving = servingOn(date);
        if (!serving.length) continue;
        const key = compositionKey(serving);
        if (key === prevKey) continue;

        if (prevKey !== null && benchStart !== null) {
            rawBenches.push({ dateStart: benchStart, dateStop: addDays(date, -1), key: prevKey });
        }
        prevKey    = key;
        benchStart = date;
    }
    if (prevKey !== null && benchStart !== null) {
        rawBenches.push({ dateStart: benchStart, dateStop: '', key: prevKey });
    }

    // Phase 2: drop benches that are "incomplete precursor" compositions —
    // specifically any leading run of benches at the start where each bench's
    // members are a strict subset of the immediately following bench.
    // Example: the first post-departure bench has 5 justices; the next bench
    // has all 5 plus Johnson → the 5-member bench is redundant as a "first".
    function isStrictSubset(keyA, keyB) {
        const setA = new Set(keyA.split('\0'));
        const setB = new Set(keyB.split('\0'));
        if (setA.size >= setB.size) return false;
        for (const c of setA) if (!setB.has(c)) return false;
        return true;
    }
    // Find how many leading benches form a strictly-ascending membership chain.
    let skipCount = 0;
    while (
        skipCount < rawBenches.length - 1 &&
        isStrictSubset(rawBenches[skipCount].key, rawBenches[skipCount + 1].key)
    ) skipCount++;
    // Drop any remaining 0-or-1-day phantom benches.  After the same-day
    // normalization above, same-day handoffs no longer produce phantoms.
    // Any residual phantoms come from other edge cases (e.g. a justice
    // departing and an unrelated justice joining on consecutive days).
    const filteredBenches = rawBenches.slice(skipCount).filter(b =>
        !b.dateStop || b.dateStop > addDays(b.dateStart, 1)
    );

    // Phase 3: drop benches (with a known dateStop) that have no decision dates
    // within their date range — e.g. pure summer-recess or confirmation-gap
    // periods where the court never sat.  Also collect full case metadata here
    // so Phase 5 can write per-bench case files without a second pass — each
    // entry keeps a reference back to its own source case object/term (see
    // `case`/`term` below, stripped before anything is written) so the bench
    // assignment computed below can also be written onto the case's own
    // record (its `bench` prop — see schema.js) without a second file scan.
    const decisionDates = new Set();
    const allCases = [];
    const termCasesMap = new Map(); // term -> its full (not just decided) cases array, for the bench-writeback pass below
    for (const termName of fs.readdirSync(TERMS_DIR).sort()) {
        if (!/^\d{4}-\d{2}$/.test(termName)) continue;
        const casesPath = path.join(TERMS_DIR, termName, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases; try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        termCasesMap.set(termName, cases);
        for (const c of cases) {
            if (!c.decision) continue;
            const dec = c.decision.slice(0, 10);
            decisionDates.add(dec);
            const baseTitle = firstTitle(c.title) || '';
            const decMatch = /^(\d{4})/.exec(dec);
            const titled = (baseTitle && decMatch) ? `${baseTitle} (${decMatch[1]})` : baseTitle;
            const meta = { title: titled, term: termName, number: _primaryCaseNumber(c), argument: c.argument || '', decision: dec };
            if (c.files) meta.files = c.files;
            // Vote tally, when known — lets the per-bench case listing (see
            // Phase 5) offer the same Vote sort/display other case listings do.
            if (c.voteMajority != null && c.voteMinority != null) {
                meta.voteMajority = c.voteMajority;
                meta.voteMinority = c.voteMinority;
            }
            Object.defineProperty(meta, '_src', { value: { case: c, term: termName }, enumerable: false });
            allCases.push(meta);
        }
    }
    allCases.sort((a, b) => a.decision.localeCompare(b.decision) || (a.argument || '').localeCompare(b.argument || ''));
    const filteredBenches2 = filteredBenches.filter(b =>
        !b.dateStop ||   // always keep the currently-active bench
        [...decisionDates].some(d => d >= b.dateStart && d <= b.dateStop)
    );

    // Pre-Phase 4: assign each case to a bench.  After the phantom-merge above,
    // the only cases that can fall outside all bench ranges are those decided
    // before the first bench's dateStart (the court's very first sessions, before
    // any justice had departed).  Those go to bench 0.
    function assignCaseToBench(decision, benchDates) {
        for (let i = 0; i < benchDates.length; i++) {
            const { dateStart, dateStop } = benchDates[i];
            if (decision >= dateStart && (!dateStop || decision <= dateStop)) return i;
        }
        return 0; // pre-court cases → first bench
    }
    const benchDates = filteredBenches2.map(b => ({ dateStart: b.dateStart, dateStop: b.dateStop }));
    const benchCaseLists = filteredBenches2.map(() => []);
    for (const m of allCases) {
        benchCaseLists[assignCaseToBench(m.decision, benchDates)].push(m);
    }

    // Phase 4: assign IDs and names, then build final output.
    // ID:   {slug}{n}  (e.g. "jay1", "roberts15") — number always present, no underscore.
    // Name: {Display}{n} ({yearRange})             — omit end-year when same as start year.
    const chiefNameCount = {};
    let lastChiefSlug    = '';
    let lastChiefDisplay = '';

    const benches = filteredBenches2.map(({ dateStart, dateStop, key }, benchIdx) => {
        const canonicals = key.split('\0');

        // Look up the tenure record active on dateStart for each justice.
        const servingTenures = canonicals.map(c => {
            const t = allTenures.find(t2 =>
                t2.canonical === c &&
                t2.dateStart <= dateStart &&
                (!t2.dateStop || t2.dateStop >= dateStart)
            );
            return t || { canonical: c, id: _justiceSlug(c.toLowerCase()), dateStart: '9999-99-99', dateStop: '' };
        });

        // Sort: chief first (anyone who was CJ during any part of this bench),
        // then associates by ascending dateStart of their current tenure.
        servingTenures.sort((a, b) => {
            const aC = wasChiefDuring(a.canonical, dateStart, dateStop) ? 0 : 1;
            const bC = wasChiefDuring(b.canonical, dateStart, dateStop) ? 0 : 1;
            if (aC !== bC) return aC - bC;
            return a.dateStart.localeCompare(b.dateStart) ||
                   a.canonical.localeCompare(b.canonical);
        });

        // Identify chief (if any) — whoever was CJ at any point during this bench.
        const chiefCanonical = canonicals.find(c => wasChiefDuring(c, dateStart, dateStop));

        // Year range: omit end-year when it equals the start year.
        const startYear = dateStart.slice(0, 4);
        const stopYear  = dateStop ? dateStop.slice(0, 4) : '';
        const yearRange = !stopYear           ? `${startYear}–`
                        : stopYear === startYear ? startYear
                        : `${startYear}–${stopYear}`;

        let benchId, benchName;
        if (chiefCanonical) {
            const parts    = chiefCanonical.trim().split(/\s+/);
            const lastName = parts[parts.length - 1];
            const slug     = lastName.toLowerCase();
            const display  = lastName[0] + lastName.slice(1).toLowerCase();
            lastChiefSlug    = slug;
            lastChiefDisplay = display;
            chiefNameCount[slug] = (chiefNameCount[slug] || 0) + 1;
            const n = chiefNameCount[slug];
            benchId   = `${slug}${n}`;
            benchName = `${display} ${n} (${yearRange})`;
        } else {
            // No sitting CJ — continue numbering under the last known CJ's name.
            chiefNameCount[lastChiefSlug] = (chiefNameCount[lastChiefSlug] || 0) + 1;
            const n = chiefNameCount[lastChiefSlug];
            benchId   = `${lastChiefSlug}${n}`;
            benchName = `${lastChiefDisplay} ${n} (${yearRange})`;
        }

        const images = _benchImages(benchId);
        return {
            id: benchId, name: benchName, dateStart, dateStop,
            cases: benchCaseLists[benchIdx].length,
            justices: servingTenures.map(t => t.canonical),
            ...(images.length ? { images } : {}),
        };
    });

    // Write each case's own bench assignment back onto its cases.json record
    // (the `bench` prop — see schema.js, positioned right before
    // voteMajority) so the case page's vote-score link can point straight at
    // its bench without needing to fetch/walk benches.json. `m._src.case` is
    // the very object living inside termCasesMap's own per-term array, so
    // mutating it here is enough — no re-matching needed, just track which
    // terms actually changed so each cases.json is rewritten at most once.
    const changedTerms = new Set();
    for (let benchIdx = 0; benchIdx < benchCaseLists.length; benchIdx++) {
        const benchId = benches[benchIdx].id;
        for (const m of benchCaseLists[benchIdx]) {
            const { case: c, term: termName } = m._src;
            if (c.bench === benchId) continue;
            c.bench = benchId;
            changedTerms.add(termName);
        }
    }
    let benchPropTermsWritten = 0;
    for (const termName of changedTerms) {
        const casesPath = path.join(TERMS_DIR, termName, 'cases.json');
        const reordered = termCasesMap.get(termName).map(reorderCase);
        if (_jsonChanged(casesPath, reordered)) {
            _writeJson(casesPath, reordered);
            benchPropTermsWritten++;
        }
    }
    if (_VERBOSE || benchPropTermsWritten > 0) {
        const verb = dryRun ? 'Would update' : 'Updated';
        console.log(`${verb} bench assignments in ${benchPropTermsWritten} term(s)' cases.json`);
    }

    const changed = _jsonChanged(OUT_FILE, benches);
    if (changed) _writeJson(OUT_FILE, benches);
    if (_VERBOSE || changed) {
        const verb = dryRun ? 'Would write' : 'Wrote';
        console.log(`${verb} ${benches.length} bench(es) to ${path.relative(REPO_ROOT, OUT_FILE)}`);
    }

    // Phase 5: write per-bench case files to courts/ussc/people/justices/benches/
    const BENCHES_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices', 'benches');
    if (!fs.existsSync(BENCHES_DIR)) _mkdirSync(BENCHES_DIR, { recursive: true });

    const knownBenchIds = new Set(benches.map(b => b.id));
    let benchFilesWritten = 0;
    for (let bIdx = 0; bIdx < benches.length; bIdx++) {
        const bench = benches[bIdx];
        const benchCases = benchCaseLists[bIdx];
        const file = path.join(BENCHES_DIR, `${bench.id}.json`);
        let highlights = [];
        if (fs.existsSync(file)) {
            try {
                const raw = _readJson(file);
                if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                    highlights = raw.highlights || [];
                }
            } catch { /* ignore */ }
        }
        const details = { page: `/courts/ussc/collections/benches/?id=${bench.id}` };
        const output = { details, highlights, cases: benchCases };
        if (_jsonChanged(file, output)) { _writeJson(file, output); benchFilesWritten++; }
    }

    // Remove stale per-bench files.
    for (const name of fs.readdirSync(BENCHES_DIR)) {
        if (!name.endsWith('.json')) continue;
        const stem = name.slice(0, -5);
        if (knownBenchIds.has(stem)) continue;
        _unlinkSync(path.join(BENCHES_DIR, name));
        if (_VERBOSE) console.log(`  Removed stale bench file: courts/ussc/people/justices/benches/${name}`);
    }

    if (_VERBOSE || benchFilesWritten > 0) {
        const verb = dryRun ? 'Would write' : 'Wrote';
        console.log(`${verb} ${benchFilesWritten} per-bench case listing to courts/ussc/people/justices/benches/`);
    }
}

// =====================================================================
// Justice-advocate auto-discovery
// =====================================================================

// Scan every term's cases.json for event advocates whose names match a known
// justice (from data/ussc/justices.json) AND whose argument date predates that
// justice's appointment.  Adds any newly discovered cases to
// courts/ussc/people/advocates/justice/justice_advocates.json without
// disturbing entries that already exist there.
function processJusticeAdvocates(allTerms, dryRun) {
    const JUSTICE_ADVOCATES_FILE = path.join(
        REPO_ROOT, 'courts', 'ussc', 'people', 'advocates', 'justice', 'justice_advocates.json');

    // Build a name-key → canonical map from justices.json.
    // Name key: upper-case, first + last token only (strips middle initials /
    // generational suffixes), mirrors the logic in update_advocates.js.
    function _nameKey(name) {
        if (!name) return '';
        let s = String(name).toUpperCase().trim();
        s = s.replace(/,?\s+(JR|SR|II|III|IV)\.?\s*$/i, '');
        const tokens = s.replace(/[.,]/g, '').split(/\s+/).filter(Boolean);
        if (!tokens.length) return '';
        if (tokens.length === 1) return tokens[0];
        return `${tokens[0]} ${tokens[tokens.length - 1]}`;
    }

    let justicesData;
    try { justicesData = _readJson(_JUSTICES_PATH); } catch { return; }

    // Map: name-key → { canonical, dateStart }
    const nameKeyMap = new Map();
    for (const [canonical, info] of Object.entries(justicesData)) {
        if (!info) continue;
        const tenures = Array.isArray(info.tenures)
            ? info.tenures
            : (info.dateStart !== undefined ? [info] : []);
        if (!tenures.length) continue;
        const dateStart = tenures[0].dateStart || '';
        if (!dateStart) continue; // no appointment date → skip
        const entry = { canonical, dateStart };
        const key = _nameKey(canonical);
        if (key) nameKeyMap.set(key, entry);
        for (const alt of info.alternates || []) {
            const altKey = _nameKey(alt);
            if (altKey) nameKeyMap.set(altKey, entry);
        }
    }

    // Scan cases: canonical → Map<termNumber, {term, number, title, decision, dates[], eventIdxs[]}>
    const discovered = new Map();

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        // Cases argued together under an argument_consolidation group would
        // otherwise each contribute their own entry below for what was really
        // one shared appearance — skip every member but the canonical one
        // (same rule update_advocates.js applies to its own advocate lists).
        const skipConsolidated = computeArguedWithSkipSet(cases);

        for (const c of cases) {
            if (skipConsolidated.has(c)) continue;
            if (!Array.isArray(c.events)) continue;
            for (let ei = 0; ei < c.events.length; ei++) {
                const ev = c.events[ei];
                if (!ev || !['argument', 'reargument'].includes(ev.type)) continue;
                if (!Array.isArray(ev.advocates) || !ev.advocates.length) continue;

                for (const adv of ev.advocates) {
                    const advName = (typeof adv === 'object' && adv !== null) ? adv.name : adv;
                    if (typeof advName !== 'string') continue;

                    const key = _nameKey(advName);
                    const match = nameKeyMap.get(key);
                    if (!match) continue;

                    // Only count as a "pre-court" advocate if the argument predates
                    // the justice's appointment.
                    const argDate = ev.date || String(c.argument || '').split(',')[0];
                    if (!argDate || argDate >= match.dateStart) continue;

                    if (!discovered.has(match.canonical)) discovered.set(match.canonical, new Map());
                    const byCase = discovered.get(match.canonical);
                    // A case with no docket number (e.g. an original-jurisdiction
                    // "In re ___" petition) falls back to its own id — same
                    // convention used everywhere else this data is keyed/listed.
                    const caseNumber = String(c.number || c.id || '');
                    const caseKey = `${term}/${caseNumber}`;
                    if (!byCase.has(caseKey)) {
                        byCase.set(caseKey, {
                            term,
                            number: caseNumber,
                            title:  firstTitle(c.title) || String(c.title || ''),
                            decision: c.decision || '',
                            dates: [],
                            eventIdxs: [],
                        });
                    }
                    const cd = byCase.get(caseKey);
                    if (argDate && !cd.dates.includes(argDate)) cd.dates.push(argDate);
                    if (!cd.eventIdxs.includes(ei + 1)) cd.eventIdxs.push(ei + 1);
                }
            }
        }
    }

    if (!discovered.size) {
        if (_VERBOSE) console.log('Justice advocates: none discovered in case events.');
        return;
    }

    // Load existing file.
    let coll = [];
    if (fs.existsSync(JUSTICE_ADVOCATES_FILE)) {
        try { coll = _readJson(JUSTICE_ADVOCATES_FILE); } catch { coll = []; }
    }
    if (!Array.isArray(coll)) coll = [];

    const groupsByName = new Map(coll.map(g => [g.name, g]));
    let totalAdded = 0;
    const addedForNames = []; // only justices who actually got a new case this run

    for (const [canonical, byCase] of discovered) {
        let group = groupsByName.get(canonical);
        if (!group) {
            group = { id: _justiceSlug(canonical), name: canonical, cases: [] };
            coll.push(group);
            groupsByName.set(canonical, group);
        }
        if (!Array.isArray(group.cases)) group.cases = [];

        let addedForThisJustice = 0;
        for (const cd of byCase.values()) {
        // Check if already in group.cases (normalize to first docket number).
            const normNum = n => String(n || '').split(',')[0].trim();
            const already = group.cases.some(
                e => String(e.term) === cd.term && normNum(e.number) === normNum(cd.number));
            if (already) continue;

            cd.dates.sort();
            // Use the first docket number for consistency with README-built entries.
            const primaryNumber = normNum(cd.number);
            const entry = {
                title:  cd.title,
                term:   cd.term,
                number: primaryNumber,
            };
            if (cd.dates.length) entry.argument = cd.dates.join(',');
            if (cd.decision)     entry.decision  = cd.decision;
            // Point to the first event that lists this justice as an advocate.
            if (cd.eventIdxs.length) entry.event = cd.eventIdxs[0];

            group.cases.push(entry);
            totalAdded++;
            addedForThisJustice++;
        }
        if (addedForThisJustice) addedForNames.push(canonical);

        // Keep cases sorted chronologically.
        group.cases.sort((a, b) => {
            const da = String(a.argument || a.reargument || '').split(',')[0];
            const db = String(b.argument || b.reargument || '').split(',')[0];
            return da < db ? -1 : da > db ? 1 : 0;
        });
    }

    // Sort groups by case count descending, then last name ascending.
    const _jaLastName = n => (n || '').replace(/,?\s+(JR|SR|II|III|IV)\.?\s*$/i, '').trim().split(/\s+/).pop() || '';
    coll.sort((a, b) => {
        const ca = a.cases?.length ?? 0, cb = b.cases?.length ?? 0;
        if (ca !== cb) return cb - ca;
        return _jaLastName(a.name) < _jaLastName(b.name) ? -1 : _jaLastName(a.name) > _jaLastName(b.name) ? 1 : 0;
    });

    if (!totalAdded) {
        if (_VERBOSE) console.log('Justice advocates: already up to date.');
        return;
    }

    const verb = dryRun ? 'Would add' : 'Added';
    if (!dryRun) {
        _mkdirSync(path.dirname(JUSTICE_ADVOCATES_FILE), { recursive: true });
        _writeJson(JUSTICE_ADVOCATES_FILE, coll);
    }
    console.log(`Justice advocates: ${verb} ${totalAdded} case(s) for ${addedForNames.join(', ')}.`);
}

// =====================================================================
// Collection-set builders: transcripts.json / briefs.json
// =====================================================================

const _COLLECTIONS_DIR      = path.join(REPO_ROOT, 'courts', 'ussc', 'collections');
const _COLLECTIONS_REGISTRY = path.join(REPO_ROOT, 'courts', 'ussc', 'collections', 'collections.json');
const _INDEX_JSON            = path.join(REPO_ROOT, 'courts', 'ussc', 'index.json');
const _AUDITS_PATH           = path.join(_COLLECTIONS_DIR, 'audits', 'audits.json');

function _firstDate(s) {
    if (!s) return '';
    return String(s).split(',')[0].trim();
}

function _normalizeDocket(d) {
    if (!d) return '';
    let docket = String(d).split(',')[0].trim();
    docket = docket.replace(/^(\d+)\s+ORIG$/i, '$1-Orig');
    return docket;
}

function _decisionYearOf(c) {
    const dec = (c.decision || '').trim();
    return dec ? dec.slice(0, 4) : '';
}

// Canonical fields _setCaseEntry itself computes — anything else found on an
// existing collection entry is extra, hand-added data that must be carried
// forward rather than dropped on rebuild.
// 'turn' isn't set by _setCaseEntry itself, but _casesByConditions computes it
// dynamically for fileCount/eventMatch conditions, so it's canonical too —
// otherwise a stale value could leak in as "extra" from a prior run's group.
// 'gallery' (the orig.json Case Gallery thumbnail list) is likewise computed
// below, not hand-curated — see _buildOrigGallery.
const _CASE_ENTRY_FIELDS = new Set(
    ['title', 'term', 'number', 'argument', 'reargument', 'decision', 'files', 'event', 'transcript', 'turn', 'gallery']);

// For a case tagged "Original Jurisdiction Archive", build the orig.json
// "gallery" array ("<file id>|<href>|<title>" per files.json entry) driving
// the thumbnail grid on courts/ussc/collections/orig/index.md. Recomputed
// fresh on every rebuild from files.json — matching thumbnails are generated
// separately via `download.js --thumbs` (courts/ussc/collections/orig/<term>/<case>/<file>.jpg).
// "<file id>" is the entry's own 1-based array position (files.json entries
// no longer carry an explicit "file" prop) — must match the thumbnail
// filenames on disk, which are numbered the same way.
function _buildOrigGallery(c, term) {
    if (!c.files) return null;
    if (!(Array.isArray(c.tags) && c.tags.includes('Original Jurisdiction Archive'))) return null;
    const caseId = (c.number || '').split(',').map(s => s.trim()).find(n => /^\d+-Orig$/i.test(n));
    if (!caseId) return null;
    const filesPath = path.join(TERMS_DIR, term, 'cases', caseId, 'files.json');
    let entries;
    try { entries = _readJson(filesPath); } catch { return null; }
    if (!Array.isArray(entries)) return null;
    const gallery = entries
        .map((f, i) => ({ f, id: i + 1 }))
        .filter(({ f }) => f.href)
        .map(({ f, id }) => `${id}|${f.href}|${f.title || ''}`);
    return gallery.length ? gallery : null;
}

// `fields`, when given (a group's collections.json "fields" array — see
// _buildTagsCollection), copies those named properties straight from the
// source case `c` onto the entry, verbatim. This lets a collection surface
// extra per-case data (e.g. "scdb_message"/"audit_message" for the Audits
// collection) without a page having to separately fetch each case's own
// cases.json.
function _setCaseEntry(c, term, extra = null, fields = null) {
    const year = _decisionYearOf(c);
    const baseTitle = firstTitle(c.title) || '';
    const title = year ? `${baseTitle} (${year})` : baseTitle;
    const entry = { title, term };
    const numberVal = _primaryCaseNumber(c);
    if (numberVal) entry.number = numberVal;
    if (c.argument)   entry.argument   = c.argument;
    if (c.reargument) entry.reargument = c.reargument;
    if (c.decision)   entry.decision   = c.decision;
    if (c.files)      entry.files      = c.files;
    const events = Array.isArray(c.events) ? c.events : [];
    if (events.some(e => e.audio_href))  entry.event      = true;
    if (events.some(e => e.text_href))   entry.transcript = true;
    if (fields) for (const name of fields) if (c[name] != null) entry[name] = c[name];
    if (extra) Object.assign(entry, extra);
    const gallery = _buildOrigGallery(c, term);
    if (gallery) entry.gallery = gallery;
    else delete entry.gallery;
    return entry;
}

// Scan every group in an existing tags/conditions collection file and return a
// (term, first-docket-piece) -> {extra fields} map for any per-case properties
// beyond what _setCaseEntry computes (e.g. a hand-curated "gallery" array).
// _buildTagsCollection fully rebuilds its case entries from cases.json on every
// run, so without this, any such hand-added field would be silently dropped.
// `declaredFields` (the union of every group's collections.json "fields" list
// in this collection) is also excluded — those are freshly recomputed by
// _setCaseEntry itself on every run, so treating stale copies of them as
// "extra" would let a since-changed or since-removed value linger forever.
function _loadExtraFieldsByKey(filePath, declaredFields = null) {
    const map = new Map();
    let data;
    try { data = _readJson(filePath); } catch { return map; }
    if (!Array.isArray(data)) return map;
    for (const group of data) {
        for (const c of (group.cases || [])) {
            const term = (c.term   || '').trim();
            const num  = (c.number || '').split(',')[0].trim();
            if (!term || !num) continue;
            const extra = {};
            for (const k of Object.keys(c)) {
                if (_CASE_ENTRY_FIELDS.has(k) || declaredFields?.has(k)) continue;
                extra[k] = c[k];
            }
            if (Object.keys(extra).length) map.set(`${term}\u0000${num}`, extra);
        }
    }
    return map;
}

// ---- noteworthy (deck CSV) helpers ---------------------------------

function _decodeUnicodeEscapes(text) {
    return String(text || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)));
}

function _decodeHtmlEntitiesBasic(s) {
    if (typeof s !== 'string' || s.indexOf('&') < 0) return s;
    return s.replace(/&(amp|lt|gt|quot|apos|nbsp|#x[0-9a-fA-F]+|#\d+);/g, (m, ent) => {
        if (ent === 'amp')  return '&';
        if (ent === 'lt')   return '<';
        if (ent === 'gt')   return '>';
        if (ent === 'quot') return '"';
        if (ent === 'apos') return "'";
        if (ent === 'nbsp') return '\u00a0';
        if (ent[0] === '#') {
            const cp = ent[1] === 'x' || ent[1] === 'X'
                ? parseInt(ent.slice(2), 16)
                : parseInt(ent.slice(1), 10);
            return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
        }
        return m;
    });
}

function _titleCasePhrase(text) {
    return String(text || '').replace(/[A-Za-z][A-Za-z'-]*/g,
        m => m[0].toUpperCase() + m.slice(1).toLowerCase());
}

const _ARTICLE_SECTION_PAREN_RE = /^(Article\s+[A-Za-z0-9IVXLC]+,\s*Section\s+[A-Za-z0-9IVXLC]+),\s*Paragraph\s+[A-Za-z0-9IVXLC]+\s*\(([^)]+)\)\s*$/i;
const _PAREN_DESC_RE = /^(.+?)\s*\(([^)]+)\)\s*$/;

function _cleanSubsetName(name) {
    let s = _decodeHtmlEntitiesBasic(name || '');
    s = _decodeUnicodeEscapes(s);
    s = s.replace(/\\xa0/g, ' ').replace(/\\n/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    let m = _ARTICLE_SECTION_PAREN_RE.exec(s);
    if (m) {
        const base = m[1].replace(/\s+/g, ' ').trim();
        s = `${base}: ${_titleCasePhrase(m[2].trim())}`;
    } else {
        const pm = _PAREN_DESC_RE.exec(s);
        if (pm) s = `${pm[1].trim()}: ${_titleCasePhrase(pm[2].trim())}`;
    }
    if (s.includes(',') && !/^Article\b/i.test(s)) s = s.split(',', 1)[0].trim();
    return s;
}

function _formatDeckCaseName(row) {
    const p = (row.petitioner || '').trim();
    const r = (row.respondent || '').trim();
    if (p && r) return `${p} v. ${r}`;
    return p || r;
}

function _extractTermYear(termStr) {
    const m = /\b(\d{4})\b/.exec(String(termStr || '').trim());
    return m ? m[1] : '';
}

function _naturalSortKey(text) {
    return String(text || '').split(/(\d+)/).map(p =>
        /^\d+$/.test(p) ? p.padStart(12, '0') : p.toLowerCase()).join('|');
}

// Map a year to candidate (term, cases) pairs from termCases.
function _candidateTermsForYear(year, termCases) {
    const result = [];
    const y = parseInt(year, 10);
    for (const yc of [y, y - 1, y + 1]) {
        const prefix = `${yc}-`;
        const matchingTerms = Object.keys(termCases)
            .filter(t => t.startsWith(prefix))
            .sort();
        for (const t of matchingTerms) result.push([t, termCases[t]]);
    }
    return result;
}

function _findCaseInList(cases, row) {
    const csvScdbIds = new Set(
        String(row.scdb || '').split(',').map(s => s.trim()).filter(Boolean));
    let csvCitation = (row.citation || '').trim();
    if (csvCitation.includes('___')) csvCitation = '';
    const csvDocketNorm = _normalizeDocket(row.docket || '').toLowerCase();

    if (csvScdbIds.size) {
        for (const c of cases) {
            const cid = (c.id || '').trim();
            if (cid && csvScdbIds.has(cid)) return c;
        }
    }
    if (csvDocketNorm) {
        for (const c of cases) {
            const num = c.number || '';
            if (!num) continue;
            if (_normalizeDocket(num).toLowerCase() !== csvDocketNorm) continue;
            if (csvCitation) {
                if ((c.usCite || '').trim() === csvCitation) return c;
                continue;
            }
            return c;
        }
    }
    return null;
}

const _PAGE_KEY_ORDER = ['id', 'name', 'term', 'file', 'cases', 'dates', 'minutes', 'journal_cover', 'journal_href', 'journal_pages', 'reports', 'decided', 'argued', 'argDays', 'audio', 'unanimous'];

// One { cover } object per unique minutes cover thumbnail (courts/ussc/terms/
// <term>/m<XXX>-cover.jpg, generated by parse_minutes.js --thumbnails) a
// term's dates.json references, in first-appearance (chronological) order —
// the roll number embedded in each type:"minutes" group's own src template
// (".../M215-XXX/...") is the single source of truth for which cover a group
// belongs to, so this is derived fresh every run rather than read back from
// dates.json. Returns [] when the term has no dates.json, no minutes-scan
// data in it (it may now exist purely to hold cross-term case-detail
// entries — see syncCrossTermCaseDates below), or it's otherwise empty. The
// term's own "dates" boolean (set in syncTermsJson below from whether
// dates.json exists on disk at all) is what the front end actually checks
// before ever fetching it — "minutes" here is unrelated to that.
function _minutesCoversForTerm(datesPath) {
    if (!fs.existsSync(datesPath)) return [];
    let d;
    try { d = _readJson(datesPath); } catch { return []; }
    if (!d || typeof d !== 'object') return [];
    const covers = [];
    const seen = new Set();
    for (const iso of Object.keys(d).sort()) {
        const groups = d[iso];
        if (!Array.isArray(groups)) continue;
        for (const g of groups) {
            if (g.type !== 'minutes') continue;
            const m = /M215-(\d{3})/.exec(g.src || '');
            if (!m) continue;
            const cover = `m${m[1]}-cover.jpg`;
            if (!seen.has(cover)) { seen.add(cover); covers.push(cover); }
        }
    }
    return covers;
}

function syncTermsJson() {
    let tj;
    try { tj = _readJson(TERMS_JSON); } catch { return; }
    if (!Array.isArray(tj)) return;

    // Pre-read every term's cases.json (needed for cross-term lookups — a
    // pointer object recorded in term X's dates.json refers to a case filed
    // under a different term Y, so Y's own cases.json must already be in
    // hand regardless of which term is being processed) and every term's
    // dates.json case-detail pointer entries (see syncCrossTermCaseDates;
    // must have already run this pass). See _computeTermArgAudioStats.
    const termStarts = _loadTermStarts();
    const casesByTerm = new Map();
    const crossTermByTerm = new Map();
    for (const { term: tId } of termStarts) {
        try {
            const data = _readJson(path.join(TERMS_DIR, tId, 'cases.json'));
            if (Array.isArray(data)) casesByTerm.set(tId, data);
        } catch {}
        try {
            const dates = _readJson(path.join(TERMS_DIR, tId, 'dates.json'));
            if (dates && typeof dates === 'object' && !Array.isArray(dates)) {
                const entries = [];
                for (const iso of Object.keys(dates)) {
                    for (const g of dates[iso] || []) {
                        if (g.type === 'argument' || g.type === 'reargument') entries.push({ iso, obj: g });
                    }
                }
                if (entries.length) crossTermByTerm.set(tId, entries);
            }
        } catch {}
    }

    let modified = false;
    let totalDecided = 0, totalArgued = 0, totalArgDays = 0, totalAudio = 0, totalUnanimous = 0;

    for (const decade of tj) {
        for (let i = 0; i < (decade.groups || []).length; i++) {
            const page = decade.groups[i];
            // Support both old format (cases = URL string) and new format (file = URL string).
            const fileUrl = page.file || (typeof page.cases === 'string' ? page.cases : '');
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(fileUrl);
            if (!m) continue;

            const termId = m[1];
            // hasDates ("dates" below) is recorded so the front end can skip
            // ever fetching a dates.json that doesn't exist (most terms don't
            // have one) — see terms.js/explorer.js, which still fall back to
            // probing directly whenever this prop is altogether absent (e.g.
            // an older terms.json that predates this). Independent of
            // "minutes" below — a dates.json can now exist purely to hold
            // cross-term case-detail entries (see syncCrossTermCaseDates),
            // with no minutes-scan data (and so no cover thumbnails) at all.
            const datesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', termId, 'dates.json');
            const hasDates = fs.existsSync(datesPath);
            const minutesCovers = _minutesCoversForTerm(datesPath);
            let count = 0, decided = 0, argued = 0, argDays = 0, audio = 0, unanimous = 0;
            const data = casesByTerm.get(termId);
            if (Array.isArray(data)) {
                count   = data.length;
                // "decided"/"unanimous" only count cases that were actually
                // argued — a case resolved without argument (cert denial,
                // GVR, summary disposition) still carries a decision date but
                // shouldn't inflate these stats or the term=all history chart.
                const arguedData = data.filter(c => c.argument || c.reargument);
                decided = arguedData.filter(c => c.decision || c.dateDecision).length;
                unanimous = arguedData.filter(c => c.voteMinority === 0).length;
                ({ argued, argDays, audio } = _computeTermArgAudioStats(termId, termStarts, casesByTerm, crossTermByTerm));
            }
            totalDecided   += decided;
            totalArgued    += argued;
            totalArgDays   += argDays;
            totalAudio     += audio;
            totalUnanimous += unanimous;

            // Rebuild page with canonical key order, file=URL, cases=count, stats at end.
            const newPage = {};
            for (const k of _PAGE_KEY_ORDER) {
                if (k === 'id')      { newPage.id = termId; continue; }
                if (k === 'file')    { newPage.file = fileUrl; continue; }
                if (k === 'cases')   { newPage.cases = count; continue; }
                if (k === 'dates')   { newPage.dates = hasDates; continue; }
                if (k === 'minutes') { if (minutesCovers.length) newPage.minutes = minutesCovers.map(cover => ({ cover })); continue; }
                if (k === 'term')    { if (page.term) newPage.term = page.term; continue; }
                if (k === 'decided') { newPage.decided = decided; continue; }
                if (k === 'argued')  { newPage.argued  = argued;  continue; }
                if (k === 'argDays') { newPage.argDays = argDays; continue; }
                if (k === 'audio')   { newPage.audio   = audio;   continue; }
                if (k === 'unanimous') { newPage.unanimous = unanimous; continue; }
                if (Object.prototype.hasOwnProperty.call(page, k)) newPage[k] = page[k];
            }
            // Preserve extra keys not in the canonical order.
            for (const k of Object.keys(page)) {
                if (!_PAGE_KEY_ORDER.includes(k)) newPage[k] = page[k];
            }

            if (JSON.stringify(newPage) !== JSON.stringify(page)) {
                decade.groups[i] = newPage;
                modified = true;
            }
        }
    }

    // Strip any legacy bare all-terms entry (old format: {id:'all'} without groups).
    while (tj.length > 0 && tj[tj.length - 1].id === 'all' && !tj[tj.length - 1].groups) {
        tj.pop(); modified = true;
    }
    // Update or append the hidden all-terms container.
    const newSummaryGroup = { id: 'all', decided: totalDecided, argued: totalArgued, argDays: totalArgDays, audio: totalAudio, unanimous: totalUnanimous };
    const newContainer    = { name: 'All', hidden: true, groups: [newSummaryGroup] };
    const lastItem = tj[tj.length - 1];
    if (lastItem?.hidden === true && lastItem?.name === 'All' && Array.isArray(lastItem?.groups)) {
        if (JSON.stringify(lastItem.groups[0]) !== JSON.stringify(newSummaryGroup)) {
            tj[tj.length - 1] = newContainer;
            modified = true;
        }
    } else {
        tj.push(newContainer);
        modified = true;
    }

    if (modified) {
        const label = path.relative(REPO_ROOT, TERMS_JSON);
        if (!_DRY_RUN) _writeJson(TERMS_JSON, tj);
        console.log(`${_DRY_RUN ? 'Would update' : 'Updated'} ${label} (case counts)`);
    }
}

// [{ term, start: 'YYYY-MM-01' }, ...] ascending, from every term folder
// under courts/ussc/terms/ — same convention as scripts/parse_minutes.js's
// own loadTermStarts, kept as a separate copy here rather than shared since
// these are independent CLI scripts.
function _loadTermStarts() {
    return fs.readdirSync(TERMS_DIR)
        .filter(d => /^\d{4}-\d{2}$/.test(d))
        .map(d => ({ term: d, start: `${d.slice(0, 4)}-${d.slice(5, 7)}-01` }))
        .sort((a, b) => a.start.localeCompare(b.start));
}

// The term whose own start date is the latest one on/before dateStr, or null
// if dateStr predates every known term. termStarts must already be sorted
// ascending by start (see _loadTermStarts).
function _termForDate(dateStr, termStarts) {
    let found = null;
    for (const t of termStarts) {
        if (t.start <= dateStr) found = t.term;
        else break;
    }
    return found;
}

// Computes a term's own "argued"/"argDays"/"audio" counts the same way
// syncCrossTermCaseDates reasons about dates: an argument/reargument date
// only belongs to the term whose own calendar window (per _termForDate)
// actually contains it, not necessarily the term the case is filed/decided
// under. A case's own cases.json can carry an argument or reargument date
// that chronologically falls in an *earlier* term (see that function's own
// doc comment) — such dates are excluded here and instead picked up via the
// case-detail pointer objects syncCrossTermCaseDates already wrote into that
// earlier term's own dates.json (must have already run for this to see
// them). "decided"/"unanimous" are untouched by any of this — decision
// dates are never tracked cross-term.
//
// casesByTerm: Map<termId, caseArray> for every term (own + referenced).
// crossTermByTerm: Map<termId, [{iso, obj}, ...]> — this term's own
// dates.json case-detail entries (type "argument"/"reargument").
function _computeTermArgAudioStats(termId, termStarts, casesByTerm, crossTermByTerm) {
    const argDaySet   = new Set();
    const argCaseIds  = new Set();
    const audioCaseIds = new Set();

    for (const c of casesByTerm.get(termId) || []) {
        const caseKey = c.id || c.number;
        for (const field of ['argument', 'reargument']) {
            const raw = c[field];
            if (!raw) continue;
            for (const d of raw.split(',').map(s => s.trim()).filter(Boolean)) {
                if (_termForDate(d, termStarts) !== termId) continue; // belongs to an earlier term instead
                argDaySet.add(d);
                if (caseKey) argCaseIds.add(caseKey);
            }
        }
        // "audio" only counts cases that were actually argued — a case
        // resolved without argument (cert denial, GVR, summary disposition)
        // shouldn't count here even if it somehow carried an audio_href (e.g.
        // a decision-announcement recording). A decision-type (or other)
        // audio event otherwise always counts toward this term, same as
        // before — only an argument/reargument event whose own date resolves
        // elsewhere is excluded (its earlier term picks it up below via the
        // cross-term pointer instead).
        const hasQualifyingAudio = (c.argument || c.reargument) && (c.events || []).some(e => {
            if (!e.audio_href) return false;
            if ((e.type === 'argument' || e.type === 'reargument') && e.date && _termForDate(e.date, termStarts) !== termId) return false;
            return true;
        });
        if (hasQualifyingAudio && caseKey) audioCaseIds.add(caseKey);
    }

    for (const { iso, obj } of crossTermByTerm.get(termId) || []) {
        const caseKey = obj.id || obj.number;
        argDaySet.add(iso);
        if (caseKey) argCaseIds.add(caseKey);

        const srcCase = (casesByTerm.get(obj.term) || []).find(c => (c.id || c.number) === caseKey);
        if (caseKey && srcCase && (srcCase.events || []).some(e => e.type === obj.type && e.audio_href)) {
            audioCaseIds.add(caseKey);
        }
    }

    return { argued: argCaseIds.size, argDays: argDaySet.size, audio: audioCaseIds.size };
}

// Some cases were actually argued/reargued during an *earlier* term's own
// date range than the term they're filed/decided under — e.g. a case
// docketed in October Term 1880 reargued at the tail end of October Term
// 1879's own calendar window. That earlier term's own dates.json (see
// scripts/parse_minutes.js, which only ever knows about its own term's
// Minutes book) has no way to learn about it from its own cases.json alone,
// so this scans every term's cases.json for an argument/reargument date
// landing in a chronologically earlier term and records a case-detail
// object — { type, id, term, number, title, usCite } — under that date in
// the earlier term's own dates.json, creating the file (or just that date's
// own array) if neither exists yet. "term" here is the CASE's own term (not
// the earlier one whose dates.json this lands in); "type" is "argument" or
// "reargument", matching whichever date field it came from. A date
// resolving to a *later* term than the case's own (suggesting the case's
// own term field is itself wrong) is left alone for a human to sort out —
// only earlier terms are ever added here. Idempotent: a later re-run updates
// an existing matching entry (matched by id, falling back to number, plus
// type) in place rather than duplicating it.
//
// Every dates.json date's own array holds a mix of object kinds — a
// Minutes-scan group ({type: "minutes", href, src, pages}, see
// scripts/parse_minutes.js) or one of these case-detail objects — always
// distinguished by their own "type" prop, never by which other props happen
// to be present.
function syncCrossTermCaseDates() {
    const termStarts = _loadTermStarts();
    if (!termStarts.length) return;

    // earlierTerm -> Map<iso, [caseObj, ...]> — collected across every
    // term's cases.json before anything is read back or written.
    const additions = new Map();

    for (const { term: termId, start: ownStart } of termStarts) {
        let cases;
        try { cases = _readJson(path.join(TERMS_DIR, termId, 'cases.json')); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        for (const c of cases) {
            for (const [field, type] of [['argument', 'argument'], ['reargument', 'reargument']]) {
                const raw = c[field];
                if (!raw) continue;
                for (const d of raw.split(',').map(s => s.trim()).filter(Boolean)) {
                    const dTerm = _termForDate(d, termStarts);
                    if (!dTerm || dTerm === termId) continue;
                    const dStart = termStarts.find(t => t.term === dTerm).start;
                    if (dStart >= ownStart) continue; // a later term — out of scope, left for a human

                    if (!additions.has(dTerm)) additions.set(dTerm, new Map());
                    const byIso = additions.get(dTerm);
                    if (!byIso.has(d)) byIso.set(d, []);
                    byIso.get(d).push({ type, id: c.id, term: termId, number: c.number, title: c.title, usCite: c.usCite });
                }
            }
        }
    }

    if (!additions.size) return;

    let filesChanged = 0, entriesAdded = 0, entriesUpdated = 0;
    for (const [dTerm, byIso] of additions) {
        const datesPath = path.join(TERMS_DIR, dTerm, 'dates.json');
        let existing;
        try { existing = _readJson(datesPath); } catch { existing = null; }
        if (!existing || typeof existing !== 'object' || Array.isArray(existing)) existing = {};

        for (const [iso, caseObjs] of byIso) {
            if (!Array.isArray(existing[iso])) existing[iso] = [];
            for (const obj of caseObjs) {
                const matchKey = obj.id || obj.number;
                const idx = existing[iso].findIndex(e =>
                    e.type === obj.type && (e.id || e.number) === matchKey);
                if (idx === -1) {
                    existing[iso].push(obj);
                    entriesAdded++;
                    console.log(`  ${dTerm}/dates.json[${iso}]: added ${obj.type} case ${matchKey} (from ${obj.term})`);
                } else if (JSON.stringify(existing[iso][idx]) !== JSON.stringify(obj)) {
                    existing[iso][idx] = obj;
                    entriesUpdated++;
                    console.log(`  ${dTerm}/dates.json[${iso}]: updated ${obj.type} case ${matchKey} (from ${obj.term})`);
                }
            }
        }

        const sorted = {};
        for (const k of Object.keys(existing).sort()) sorted[k] = existing[k];
        if (_jsonChanged(datesPath, sorted)) {
            _writeJson(datesPath, sorted);
            filesChanged++;
        }
    }

    if (entriesAdded || entriesUpdated) {
        console.log(`${_DRY_RUN ? 'Would update' : 'Updated'} ${filesChanged} dates.json file(s) for cross-term case dates — ${entriesAdded} added, ${entriesUpdated} updated.`);
    }
}

// ── U.S. Reports sync ────────────────────────────────────────────────────────

// Cache: Map<pdfPath, pages string | null> so each PDF is scanned at most once per run.
const _PAGE_OFFSET_CACHE = new Map();

// Derive the canonical supremecourt.gov URL for a US Reports bound volume.
// Volumes 2–501 use the USREPORTS-NNN_PDFA.pdf path; 502+ use boundvolumes/NNNbv.pdf.
function _deriveReportHref(vol) {
    const v = Number(vol);
    if (v >= 502) return `${SCOTUS_BASE}/opinions/boundvolumes/${v}bv.pdf`;
    return `${SCOTUS_BASE}/pdfs/USReports/USREPORTS-${v}_PDFA.pdf`;
}

// Extract the text content of one page of a PDF via pdftotext.
async function _pdfPageText(pdfPath, pageNum) {
    try {
        const { stdout } = await _execFile('pdftotext', [
            '-f', String(pageNum), '-l', String(pageNum), pdfPath, '-',
        ], { timeout: 30000 });
        return stdout || '';
    } catch {
        return '';
    }
}

// Extract the leading page number from the OCR text of a US Reports PDF page.
// Returns an integer or null if no clear number is found.
function _extractLeadingPageNum(text) {
    const m = /^\s*(\d{1,4})\s/.exec((text || '').slice(0, 100));
    return m ? parseInt(m[1], 10) : null;
}

// Return the total page count of a PDF via pdfinfo, or null on failure.
async function _pdfPageCount(pdfPath) {
    try {
        const { stdout } = await _execFile('pdfinfo', [pdfPath], { timeout: 30000 });
        const m = /^Pages:\s+(\d+)/m.exec(stdout);
        return m ? parseInt(m[1], 10) : null;
    } catch {
        return null;
    }
}

// Detect the pages mapping for a US Reports bound volume PDF.
//
// Phase 1: scan for a page whose text contains the title pattern
//   "CASES/OASES/DECISIONS/REPORTS ... IN/OF THE ... SUPREME COURT OF THE
//   UNITED STATES". OASES is an OCR artefact for CASES; REPORTS covers the
//   "REPORTS OF THE DECISIONS ..." title form used in some early volumes.
//   That page IS page 1 of the volume, so the initial offset is p - 1.
//
// Phase 2 (fallback): look for three consecutive PDF pages whose text begins
//   with the page numbers 2, 3, and 4 respectively. If found, the PDF page
//   preceding the "2" page is volume page 1, so the initial offset is p - 2.
//
// Phase 3a: after finding the initial offset, check for secondary remappings
//   at fixed candidates 801 and 901 — the most common discontinuity points.
//   Read the PDF page expected under the current offset; if the printed page
//   number differs, compute the new offset and verify it by checking the page
//   that should be at the candidate under the new offset. If confirmed, add a
//   breakpoint to the pages string (e.g. "1:85,801:717").
// Phase 3b: fallback when 3a finds nothing. Use pdfinfo to get the total page
//   count, read the last page's printed number to detect any offset mismatch,
//   then binary-search for the first PDF page with the new offset and record it
//   as the second breakpoint.
async function _detectPages(pdfPath) {
    if (_PAGE_OFFSET_CACHE.has(pdfPath)) return _PAGE_OFFSET_CACHE.get(pdfPath);
    let offset = null;

    // Phase 1
    const titleRe = /(?:CASES\b|OASES\b|DECISIONS\b|REPORTS\b)[\s\S]{0,150}(?:IN|OF) THE[\s\S]{0,150}SUPREME COURT OF THE UNITED STATES/i;
    for (let p = 1; p <= 200; p++) {
        const text = await _pdfPageText(pdfPath, p);
        if (titleRe.test(text)) { offset = p - 1; break; }
    }

    // Phase 2 (fallback)
    if (offset === null) {
        const hasPageNum = (text, n) => new RegExp(`(?:^|\\n)\\s*${n}[\\s\\n]`).test(text.slice(0, 200));
        for (let p = 2; p <= 200; p++) {
            const t2 = await _pdfPageText(pdfPath, p);
            if (hasPageNum(t2, 2)) {
                const t3 = await _pdfPageText(pdfPath, p + 1);
                const t4 = await _pdfPageText(pdfPath, p + 2);
                if (hasPageNum(t3, 3) && hasPageNum(t4, 4)) { offset = p - 2; break; }
            }
        }
    }

    if (offset === null) {
        _PAGE_OFFSET_CACHE.set(pdfPath, null);
        return null;
    }

    const { breakpoints, phase3bSearched } = await _detectPhase3(pdfPath, offset);
    const base = breakpoints.map(b => `${b.start}:${b.pdfPage}`).join(',');
    // Append trailing comma when Phase 3b ran but found no secondary breakpoint,
    // so re-runs skip the expensive binary search for this volume.
    const pages = (phase3bSearched && breakpoints.length === 1) ? base + ',' : base;
    _PAGE_OFFSET_CACHE.set(pdfPath, pages);
    return pages;
}

// Find every "Reporter's Note ... purposely numbered N" marker in a volume.
// Modern notes read "The next page is purposely numbered N" (the target page
// follows the note); older ones (e.g. rules-amendments inserts) read "This
// page is purposely numbered N" (the note page itself IS page N). This is far
// more reliable than probing fixed candidate pages, since the printed page
// number on "orders" pages is often set in the footer rather than the header,
// and the discontinuity doesn't always land on a round hundred.
async function _detectNoteBreakpoints(pdfPath) {
    let stdout;
    try {
        ({ stdout } = await _execFile('pdftotext', [pdfPath, '-'], { timeout: 60000, maxBuffer: 1024 * 1024 * 64 }));
    } catch {
        return [];
    }
    const pages = (stdout || '').split('\f');
    const NOTE_RE = /(This page|The next page) is purposely numbered\s+(\d{2,4})/gi;
    const found = [];
    for (let i = 0; i < pages.length; i++) {
        NOTE_RE.lastIndex = 0;
        const m = NOTE_RE.exec(pages[i]);
        if (!m) continue;
        const isNextPage = /next/i.test(m[1]);
        found.push({ start: parseInt(m[2], 10), pdfPage: isNextPage ? i + 2 : i + 1 });
    }
    return found;
}

// Run Phase 3 (secondary breakpoint detection) given the initial PDF offset.
// Returns { breakpoints, phase3bSearched } where breakpoints is an array of
// {start, pdfPage} objects and phase3bSearched is true when Phase 3b ran.
async function _detectPhase3(pdfPath, offset) {
    const breakpoints = [{ start: 1, pdfPage: offset + 1 }];
    let currentOffset = offset;

    // Phase 3a-note: an explicit Reporter's Note beats any heuristic — use it
    // whenever present and skip the fixed-candidate/binary-search fallbacks
    // entirely (volumes can have more than one such note, e.g. a later
    // in-chambers-opinions section after the orders section).
    const noteBps = await _detectNoteBreakpoints(pdfPath);
    if (noteBps.length) {
        return { breakpoints: [...breakpoints, ...noteBps], phase3bSearched: false };
    }

    // Phase 3a: try fixed candidates near the known discontinuity range.
    for (const C of [801, 901]) {
        const expectedPdfPage = C + currentOffset;
        const text = await _pdfPageText(pdfPath, expectedPdfPage);
        if (!text) continue;
        const P = _extractLeadingPageNum(text);
        if (P === null || P === C) continue;
        const newOffset = expectedPdfPage - P;
        if (newOffset === currentOffset) continue;
        // Verify by checking the page that should hold C under the new offset.
        const actualPdfPage = C + newOffset;
        if (actualPdfPage < 1) continue;
        const verifyText = await _pdfPageText(pdfPath, actualPdfPage);
        if (_extractLeadingPageNum(verifyText) === C) {
            breakpoints.push({ start: C, pdfPage: actualPdfPage });
            currentOffset = newOffset;
        }
    }

    // Phase 3b: if no secondary breakpoint found via fixed candidates, check the
    // last page to detect any offset discontinuity, then binary-search for its start.
    let phase3bSearched = false;
    if (breakpoints.length === 1) {
        const totalPages = await _pdfPageCount(pdfPath);
        if (totalPages !== null) {
            phase3bSearched = true;
            // Find the last page with a readable printed page number.
            let lastPrinted = null, lastPdfPage = null;
            for (let p = totalPages; p >= Math.max(1, totalPages - 30); p--) {
                const n = _extractLeadingPageNum(await _pdfPageText(pdfPath, p));
                if (n !== null) { lastPrinted = n; lastPdfPage = p; break; }
            }
            if (lastPrinted !== null && lastPdfPage - lastPrinted !== currentOffset) {
                const newOffset = lastPdfPage - lastPrinted;
                // Binary search for the first PDF page whose printed number implies newOffset.
                const searchLo = Math.max(offset + 2, 500 + currentOffset);
                let lo = searchLo, hi = lastPdfPage;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    const n = _extractLeadingPageNum(await _pdfPageText(pdfPath, mid));
                    if (n !== null && mid - n === newOffset) hi = mid; else lo = mid + 1;
                }
                let bPrinted = _extractLeadingPageNum(await _pdfPageText(pdfPath, lo));
                // Require the break to start at a reasonable US Reports page (>= 500).
                if (bPrinted !== null && lo - bPrinted === newOffset && bPrinted >= 500) {
                    // The binary search skips unreadable pages by treating them as old-regime,
                    // so it may land on a page later than the true first page of the new segment.
                    // Scan backwards to find the actual first page with newOffset.
                    // For unreadable pages, assume they are in the new segment and use the
                    // implied printed number (p - newOffset) so the first page of a new
                    // physical book that lacks a legible page number is not skipped.
                    for (let p = lo - 1; p >= searchLo; p--) {
                        const pn = _extractLeadingPageNum(await _pdfPageText(pdfPath, p));
                        if (pn === null) { lo = p; bPrinted = p - newOffset; continue; } // unreadable — assume new segment
                        if (p - pn === newOffset) { lo = p; bPrinted = pn; continue; }   // confirmed new segment
                        break;                                                            // old-regime page — stop
                    }
                    breakpoints.push({ start: bPrinted, pdfPage: lo });
                    currentOffset = newOffset;
                }
            }
        }
    }

    return { breakpoints, phase3bSearched };
}

// Export page 1 of a PDF as a JPEG at outputJpgPath. Returns true on success.
async function _generateReportCover(pdfPath, outputJpgPath, pdfPage = 1) {
    // pdftoppm names the output <prefix>-NNN.jpg where NNN is the zero-padded
    // page number (padding width matches the total page count of the PDF).
    const prefix = outputJpgPath.slice(0, -4); // strip ".jpg"
    const dir    = path.dirname(prefix);
    const base   = path.basename(prefix);
    try {
        await _execFile('pdftoppm', [
            '-jpeg', '-r', '150',
            '-f', String(pdfPage), '-l', String(pdfPage),
            pdfPath, prefix,
        ], { timeout: 60000 });
        // Find the file pdftoppm actually created (suffix depends on total page count).
        const created = fs.readdirSync(dir).find(f => f.startsWith(base + '-') && f.endsWith('.jpg'));
        if (created) {
            const tmp = path.join(dir, created);
            if (tmp !== outputJpgPath) fs.renameSync(tmp, outputJpgPath);
            return true;
        }
    } catch (e) {
        console.log(`    Warning: pdftoppm failed for ${path.basename(pdfPath)}: ${e.message || e}`);
    }
    return false;
}

// For every term in terms.json, scan cases.json for U.S. Reports volume
// numbers (from usCite fields), cross-reference against the bound volumes
// listed on USReports.aspx, and build/maintain the "reports" array on
// each term group entry. Cover images are generated via pdftoppm if absent;
// pages values are computed via pdftotext if absent.
async function syncTermsReports(termFilter, volFilter = null) {
    let tj;
    try { tj = _readJson(TERMS_JSON); } catch { return; }
    if (!Array.isArray(tj)) return;

    // Load reports.json to seed the page_offset cache so PDFs are not
    // re-scanned on subsequent runs. -1 means detection was attempted but
    // failed; cache it as null so _detectPages skips it.
    // Volumes with a single-breakpoint pages and no trailing comma
    // (meaning Phase 3b hasn't run yet) are tracked in needsPhase3b and
    // NOT seeded into the cache, so _detectPhase3 runs fresh for them.
    let reportsDb = {};
    try {
        const raw = _readJson(REPORTS_JSON);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) reportsDb = raw;
    } catch { /* file may not exist yet */ }
    const needsPhase3b = new Set();
    const needsPhase3bVerify = new Set();
    for (const [key, val] of Object.entries(reportsDb)) {
        const pn = _reportsDbPages(val);
        if (pn === undefined) continue;
        if (typeof pn === 'string' && !pn.endsWith(',') && _parsePages(pn).length === 1) {
            // Single-breakpoint, not yet Phase-3b-searched — don't seed cache.
            needsPhase3b.add(key);
        } else {
            _PAGE_OFFSET_CACHE.set(path.join(PDFS_DIR, key + '.pdf'), pn);
            if (typeof pn === 'string' && !pn.endsWith(',') && _parsePages(pn).length === 2) {
                // Two-breakpoint entry — re-verify the second breakpoint start with the
                // current algorithm (binary search + backward scan) in case it was set
                // by an older version that may have landed on the wrong page.
                needsPhase3bVerify.add(key);
            }
        }
    }

    // Pre-pass: propagate any manual reports.json edits into terms.json pages.
    // decision_rep recomputation is handled by the standard update_cases.js flow.
    {
        let tjModified = false;
        for (const decade of tj) {
            for (const page of (decade.groups || [])) {
                const fileUrl = page.file || (typeof page.cases === 'string' ? page.cases : '');
                const termMatch = /\/terms\/([^/]+)\/cases\.json$/.exec(fileUrl);
                if (!termMatch) continue;
                const term = termMatch[1];
                if (termFilter && term !== termFilter) continue;
                if (!Array.isArray(page.reports)) continue;

                for (const r of page.reports) {
                    if (r.volume == null) continue;
                    const volKey = `v${String(r.volume).padStart(3, '0')}`;
                    const dbEntry = reportsDb[volKey];
                    if (!dbEntry) continue;
                    const dbPages = _reportsDbPages(dbEntry);
                    if (dbPages == null || dbPages === r.pages) continue;

                    const dbBps = _parsePages(dbPages || '').filter(e => !e.roman);
                    const tjBps = _parsePages(r.pages || '').filter(e => !e.roman);
                    const arabicMatch = dbBps.length === tjBps.length &&
                        dbBps.every((bp, i) => tjBps[i]?.start === bp.start && tjBps[i]?.pdfPage === bp.pdfPage);
                    if (arabicMatch) continue;
                    const tjExtends = tjBps.length > dbBps.length &&
                        dbBps.every((bp, i) => tjBps[i]?.start === bp.start && tjBps[i]?.pdfPage === bp.pdfPage);
                    if (tjExtends) continue;

                    console.log(`  ${term}: vol ${r.volume} pages: ${r.pages ?? '(none)'} → ${dbPages}`);
                    r.pages = dbPages;
                    tjModified = true;
                }
            }
        }
        if (tjModified) {
            if (!_DRY_RUN) _writeJson(TERMS_JSON, tj);
            console.log(`${_DRY_RUN ? 'Would update' : 'Updated'} terms.json (propagated reports.json pages)`);
        }
    }

    // Build a set of locally available volumes from the PDFs directory.
    const localVols = new Set();
    if (fs.existsSync(PDFS_DIR)) {
        for (const f of fs.readdirSync(PDFS_DIR)) {
            const m = /^v(\d{3})\.pdf$/i.exec(f);
            if (m) localVols.add(parseInt(m[1], 10));
        }
    }
    if (!localVols.size) {
        console.log(`No local US Reports PDFs found in ${path.relative(REPO_ROOT, PDFS_DIR)}`);
        return;
    }
    if (_VERBOSE)
        console.log(`  Found ${localVols.size} local PDFs (v${Math.min(...localVols)}–v${Math.max(...localVols)})`);

    // terms.json stores decades/terms newest-first; the "earliest term wins"
    // registry-building below needs chronological (oldest-first) order, so
    // iterate a reversed copy. The page objects inside are the same references
    // as in `tj`, so in-place mutations below still land in `tj` correctly.
    const tjAscending = tj.slice().reverse().map(d => ({ ...d, groups: (d.groups || []).slice().reverse() }));

    // Pre-pass: (1) build a registry of the earliest term where each volume's
    // cover image already exists on disk; (2) collect the best-known href for
    // each volume from existing terms.json entries so we don't need to derive
    // it for volumes already tracked.
    const coverRegistry = new Map();   // vol → { term, coverName }
    const existingHrefByVol = new Map(); // vol → href
    for (const decade of tjAscending) {
        for (const page of (decade.groups || [])) {
            const fileUrl = page.file || (typeof page.cases === 'string' ? page.cases : '');
            const termMatch = /\/terms\/([^/]+)\/cases\.json$/.exec(fileUrl);
            if (!termMatch) continue;
            const pageTerm = termMatch[1];
            const pageTermDir = path.join(TERMS_DIR, pageTerm);
            for (const r of (page.reports || [])) {
                if (!r.volume) continue;
                const v = Number(r.volume);
                if (r.href && !existingHrefByVol.has(v)) existingHrefByVol.set(v, r.href);
                if (coverRegistry.has(v)) continue;
                const cover = r.cover || '';
                if (cover.startsWith('../')) continue;
                if (fs.existsSync(path.join(pageTermDir, cover))) {
                    coverRegistry.set(v, { term: pageTerm, coverName: cover });
                }
            }
        }
    }

    let modified = false;

    for (const decade of tjAscending) {
        for (let i = 0; i < (decade.groups || []).length; i++) {
            const page = decade.groups[i];
            const fileUrl = page.file || (typeof page.cases === 'string' ? page.cases : '');
            const termMatch = /\/terms\/([^/]+)\/cases\.json$/.exec(fileUrl);
            if (!termMatch) continue;

            const term = termMatch[1];
            if (termFilter && term !== termFilter) continue;

            const termDir   = path.join(TERMS_DIR, term);
            const casesPath = path.join(termDir, 'cases.json');

            let cases = [];
            try {
                cases = _readJson(casesPath);
                if (!Array.isArray(cases)) cases = [];
            } catch { continue; }

            // Collect unique volume numbers referenced in usCite fields that
            // also have a local PDF available.
            const volSet = new Set();
            for (const c of cases) {
                const cm = /^(\d+)\s+U\.S\./.exec(c.usCite || '');
                if (cm) {
                    const vol = parseInt(cm[1], 10);
                    if (vol >= 2 && localVols.has(vol)) volSet.add(vol);
                }
            }
            if (!volSet.size) continue;

            const sortedVols = [...volSet].sort((a, b) => a - b);

            // Build lookup of existing report entries by volume number.
            const existingByVol = new Map();
            for (const r of (page.reports || [])) {
                if (r.volume != null) existingByVol.set(Number(r.volume), r);
            }

            const reports = [];
            for (const vol of sortedVols) {
                if (volFilter !== null && vol !== volFilter) continue;

                const volStr  = String(vol).padStart(3, '0');
                const pdfPath = path.join(PDFS_DIR, `v${volStr}.pdf`);
                const href    = existingHrefByVol.get(vol) ?? _deriveReportHref(vol);

                const coverName = `v${volStr}-cover.jpg`;
                const coverPath = path.join(termDir, coverName);

                // Resolve pages before computing the cover page.
                // Priority (highest to lowest):
                //   1. terms.json value that extends reports.json (user-added breakpoints):
                //      if terms.json has all of reports.json's breakpoints plus more, treat
                //      terms.json as authoritative and update reports.json to match.
                //   2. reports.json value (definitive for everything else).
                //   3. Phase 3b check for single-breakpoint volumes (needsPhase3b): run
                //      _detectPhase3 to find any secondary breakpoint, then write the
                //      result (possibly with trailing comma sentinel) to reports.json.
                //   4. Full detection for new volumes not yet in reports.json.
                const volKey = `v${volStr}`;
                let pages = existingByVol.get(vol)?.pages ?? null;
                // Save any roman bps from the original terms.json entry; they must
                // be preserved even when reports.json provides the arabic bps.
                const tjRomanBps = _parsePages(pages ?? '').filter(e => e.roman);
                const dbPages = _reportsDbPages(reportsDb[volKey]);

                const _writeReportsDb = () => {
                    const sorted = Object.fromEntries(Object.keys(reportsDb).sort().map(k => [k, reportsDb[k]]));
                    _writeJson(REPORTS_JSON, sorted);
                };
                const _deleteStaleCover = () => {
                    if (fs.existsSync(coverPath)) {
                        if (!_DRY_RUN) fs.unlinkSync(coverPath);
                        else console.log(`  [dry-run] would delete stale ${path.relative(REPO_ROOT, coverPath)}`);
                    }
                };
                const _setReportsEntry = (pn) => {
                    reportsDb[volKey] = { ...reportsDb[volKey], pages: pn };
                };

                if (dbPages !== undefined) {
                    if (pages !== null && pages !== dbPages) {
                        // Compare arabic-only bps; roman bps are user metadata and never
                        // written to reports.json.
                        const dbBps = _parsePages(dbPages || '').filter(e => !e.roman);
                        const tjBps = _parsePages(pages || '').filter(e => !e.roman);
                        const arabicMatch = dbBps.length === tjBps.length &&
                            dbBps.every((bp, i) => tjBps[i]?.start === bp.start && tjBps[i]?.pdfPage === bp.pdfPage);
                        const tjExtends = tjBps.length > dbBps.length &&
                            dbBps.every((bp, i) => tjBps[i]?.start === bp.start && tjBps[i]?.pdfPage === bp.pdfPage);
                        if (tjExtends) {
                            // terms.json has more arabic breakpoints; write arabic-only to
                            // reports.json and keep pages (with roman bps) for terms.json.
                            const arabicOnly = tjBps.map(b => `${b.start}:${b.pdfPage}`).join(',');
                            _setReportsEntry(arabicOnly);
                            _writeReportsDb();
                            needsPhase3b.delete(volKey);
                            console.log(`  ${term}: v${volStr} pages extended to ${arabicOnly} (from terms.json)`);
                        } else if (arabicMatch) {
                            // Same arabic bps; keep terms.json value (may have roman bps or
                            // trailing-comma difference). pages stays as-is.
                        } else {
                            // reports.json wins for arabic bps; cover may need regeneration.
                            pages = dbPages;
                            _deleteStaleCover();
                        }
                    } else {
                        pages = dbPages;
                    }
                } else if (volKey in reportsDb || pages == null) {
                    // Entry in reports.json has no pages (cleared to force
                    // re-detection), OR nothing known yet — scan the PDF.
                    const prevPages = pages;
                    console.log(`  ${term}: detecting page numbers for v${volStr} ...`);
                    pages = await _detectPages(pdfPath);
                    if (pages == null) {
                        console.log(`  ${term}: could not detect page numbers for v${volStr}`);
                    } else if (_VERBOSE) {
                        console.log(`  ${term}: v${volStr} pages = ${pages}`);
                    }
                    _setReportsEntry(pages);
                    _writeReportsDb();
                    if (pages !== prevPages) _deleteStaleCover();
                }

                // Phase 3b check: for volumes with a single-breakpoint mapping that
                // haven't yet been searched for a secondary discontinuity, run
                // _detectPhase3 now. The result (with trailing comma if nothing found)
                // is written to reports.json so future runs skip the expensive scan.
                if (needsPhase3b.has(volKey) && typeof pages === 'string' &&
                        !pages.endsWith(',') && _parsePages(pages).filter(e => !e.roman).length === 1) {
                    const bps = _parsePages(pages).filter(e => !e.roman);
                    const initialOffset = bps[0].pdfPage - bps[0].start;
                    console.log(`  ${term}: checking secondary pages for v${volStr} ...`);
                    const { breakpoints, phase3bSearched } = await _detectPhase3(pdfPath, initialOffset);
                    const base = breakpoints.map(b => `${b.start}:${b.pdfPage}`).join(',');
                    const newPages = (phase3bSearched && breakpoints.length === 1) ? base + ',' : base;
                    if (newPages !== pages) {
                        if (breakpoints.length > 1) {
                            console.log(`  ${term}: v${volStr} secondary breakpoint found: ${newPages}`);
                        } else if (_VERBOSE) {
                            console.log(`  ${term}: v${volStr} no secondary breakpoint (${newPages})`);
                        }
                        pages = newPages;
                        _deleteStaleCover();
                    }
                    _setReportsEntry(pages);
                    _writeReportsDb();
                    needsPhase3b.delete(volKey);
                }

                // Re-verify existing two-breakpoint mappings using the current algorithm
                // (backward scan may correct a second breakpoint that was set too late).
                if (needsPhase3bVerify.has(volKey) && typeof pages === 'string' &&
                        _parsePages(pages).filter(e => !e.roman).length === 2) {
                    const bps = _parsePages(pages).filter(e => !e.roman);
                    const initialOffset = bps[0].pdfPage - bps[0].start;
                    if (_VERBOSE) console.log(`  ${term}: re-verifying phase3 for v${volStr} ...`);
                    const { breakpoints } = await _detectPhase3(pdfPath, initialOffset);
                    if (breakpoints.length === 2) {
                        const verified = breakpoints.map(b => `${b.start}:${b.pdfPage}`).join(',');
                        const arabicPages = bps.map(b => `${b.start}:${b.pdfPage}`).join(',');
                        if (verified !== arabicPages) {
                            console.log(`  ${term}: v${volStr} corrected pages: ${arabicPages} → ${verified}`);
                            pages = verified; // roman bps reattached by post-process below
                            _setReportsEntry(verified);
                            _writeReportsDb();
                            _deleteStaleCover();
                        }
                    }
                    needsPhase3bVerify.delete(volKey);
                }

                // Re-attach any roman bps from the original terms.json entry that may
                // have been displaced by reports.json or Phase 3b detection.
                if (pages && tjRomanBps.length > 0 &&
                        !_parsePages(pages).some(e => e.roman)) {
                    const hasTrailing = pages.endsWith(',');
                    const base = hasTrailing ? pages.slice(0, -1) : pages;
                    const romanStr = tjRomanBps.map(e => `${e.startStr}:${e.pdfPage}`).join(',');
                    pages = `${base},${romanStr}${hasTrailing ? ',' : ''}`;
                }

                // If an earlier term already has the canonical cover for this
                // volume, point to it with a relative path and delete any local
                // duplicate. Otherwise generate the cover normally and register it.
                const priorCover = coverRegistry.get(vol);
                if (priorCover && priorCover.term !== term) {
                    if (fs.existsSync(coverPath)) {
                        if (!_DRY_RUN) {
                            fs.unlinkSync(coverPath);
                            console.log(`  ${term}: deleted duplicate ${coverName} (canonical in ${priorCover.term})`);
                        } else {
                            console.log(`  [dry-run] would delete duplicate ${path.relative(REPO_ROOT, coverPath)}`);
                        }
                    }
                    reports.push({ volume: vol, cover: `../${priorCover.term}/${priorCover.coverName}`, href, ...(pages && { pages: pages }) });
                } else {
                    // Generate (or regenerate) the cover image from the page
                    // numbered "1" in the volume.
                    if (!fs.existsSync(coverPath)) {
                        const coverPdfPage = _pdfPageFor(_parsePages(pages ?? ''), 1) ?? 1;
                        console.log(`  ${term}: generating ${coverName} (PDF page ${coverPdfPage}) ...`);
                        if (!_DRY_RUN) {
                            await _generateReportCover(pdfPath, coverPath, coverPdfPage);
                        } else {
                            console.log(`  [dry-run] would generate ${path.relative(REPO_ROOT, coverPath)}`);
                        }
                    }
                    if (!coverRegistry.has(vol)) {
                        coverRegistry.set(vol, { term, coverName });
                    }
                    reports.push({ volume: vol, cover: coverName, href, ...(pages && { pages: pages }) });
                }
            }

            if (!reports.length) continue;

            // When filtering by volume, merge only the updated entry back into the
            // existing page.reports array to preserve all other volume entries.
            const mergedReports = volFilter !== null && page.reports?.length
                ? page.reports.map(r => reports.find(nr => nr.volume === r.volume) || r)
                : reports;

            if (JSON.stringify(page.reports) !== JSON.stringify(mergedReports)) {
                page.reports = mergedReports;
                modified = true;
                _writeJson(TERMS_JSON, tj);
                console.log(`  ${term}: updated reports (volumes ${reports.map(r => r.volume).join(', ')})`);
            } else {
                // page.reports may already equal mergedReports textually, but
                // pages could have been updated in-memory above (Phase 3b
                // or tjExtends). Ensure page.reports reflects the latest values.
                page.reports = mergedReports;
            }

        }
    }

    if (modified) {
        console.log(`${_DRY_RUN ? 'Would update' : 'Updated'} ${path.relative(REPO_ROOT, TERMS_JSON)} (reports)`);
    } else {
        console.log('terms.json reports: no changes needed.');
    }
}

// Recursively collect all leaf collection entries (those with a 'file' key
// and either a 'tags' array or a 'groups' array) from the nested
// collections.json structure.
function _collectTaggedLeafEntries(entries) {
    const result = [];
    for (const entry of (entries || [])) {
        if (Array.isArray(entry.collections)) {
            result.push(..._collectTaggedLeafEntries(entry.collections));
        } else if (entry.file || entry.collection) {
            const hasTagsGroup = Array.isArray(entry.tags) && entry.tags.length;
            const hasGroups    = Array.isArray(entry.groups) && entry.groups.length;
            if (hasTagsGroup || hasGroups) result.push(entry);
        }
    }
    return result;
}

// ---- condition-based filtering helpers ------------------------------------

// Regex patterns for the supported condition forms:
//   property op value            e.g.  argument >= '1955-10-01'
//   property == undefined        e.g.  id == undefined  (property absent or null)
//   property != undefined        e.g.  id != undefined  (property present)
//   property contains 'v'        e.g.  scdb_check contains 'argument'
//   !property contains 'v'       e.g.  !scdb_check contains 'argument'
//   COUNT(event.prop) op value   e.g.  COUNT(event.audio_href) == 0
//   event sub-conditions (&&)    e.g.  event.source == 'oyez' && event.audio_href && !event.aligned
//   COUNT(file.prop == 'v') op n e.g.  COUNT(file.type == 'mp3') > 0
const _COND_PROP_RE        = /^(\w+)\s*(>=|<=|!=|==|>|<)\s*(?:'([^']*)'|(\d+(?:\.\d+)?))$/;
const _COND_UNDEF_RE       = /^(\w+)\s*(==|!=)\s*undefined$/;
const _COND_PROP_CONTAINS_RE     = /^(\w+)\s+contains\s+'([^']*)'$/;
const _COND_PROP_NOT_CONTAINS_RE = /^!(\w+)\s+contains\s+'([^']*)'$/;
const _COND_COUNT_RE       = /^COUNT\(event\.(\w+)\)\s*(>=|<=|!=|==|>|<)\s*(\d+(?:\.\d+)?)$/;
const _COND_FILE_COUNT_RE  = /^COUNT\(file\.(\w+)\s*(==|!=)\s*'([^']*)'\)\s*(>=|<=|!=|==|>|<)\s*(\d+(?:\.\d+)?)$/;
const _COND_EV_PROP_RE     = /^event\.(\w+)\s*(>=|<=|!=|==|>|<)\s*(?:'([^']*)'|(\d+(?:\.\d+)?))$/;
const _COND_EV_TRUTHY_RE   = /^event\.(\w+)$/;
const _COND_EV_FALSY_RE    = /^!event\.(\w+)$/;
// event.fileProp.singular.itemProp contains 'value'
// e.g. event.text_href.turn.name contains 'UNKNOWN'
// COUNT(event.fileProp.singular.itemProp contains 'value') op number
// e.g. COUNT(event.text_href.turn.name contains 'UNKNOWN') >= 100
const _COND_EV_FILE_RE       = /^event\.(\w+)\.(\w+)\.(\w+)\s+contains\s+'([^']*)'$/;
const _COND_EV_FILE_COUNT_RE = /^COUNT\(event\.(\w+)\.(\w+)\.(\w+)\s+contains\s+'([^']*)'\)\s*(>=|<=|!=|==|>|<)\s*(\d+(?:\.\d+)?)$/;

const _transcriptCache = new Map();

function _loadTranscriptCached(filePath) {
    if (_transcriptCache.has(filePath)) return _transcriptCache.get(filePath);
    let data = null;
    try { data = _readJson(filePath); } catch { /* file missing or invalid */ }
    _transcriptCache.set(filePath, data);
    return data;
}

const _filesCache = new Map();

function _loadFilesCached(filePath) {
    if (_filesCache.has(filePath)) return _filesCache.get(filePath);
    let data = null;
    try { data = _readJson(filePath); } catch { /* file missing or invalid */ }
    _filesCache.set(filePath, data);
    return data;
}

function _parseEventSubcondition(s) {
    s = s.trim();
    // singular (e.g. "turn") maps to arrayName (e.g. "turns") by appending 's'
    let m = _COND_EV_FILE_COUNT_RE.exec(s);
    if (m) return { type: 'eventFileCount', fileProp: m[1], arrayName: m[2] + 's', itemProp: m[3], value: m[4], op: m[5], threshold: parseFloat(m[6]) };
    m = _COND_EV_FILE_RE.exec(s);
    if (m) {
        return { type: 'eventFileContains', fileProp: m[1], arrayName: m[2] + 's', itemProp: m[3], value: m[4] };
    }
    m = _COND_EV_PROP_RE.exec(s);
    if (m) {
        const value = m[3] !== undefined ? m[3] : parseFloat(m[4]);
        return { type: 'eventProp', prop: m[1], op: m[2], value };
    }
    m = _COND_EV_FALSY_RE.exec(s);
    if (m) return { type: 'eventFalsy', prop: m[1] };
    m = _COND_EV_TRUTHY_RE.exec(s);
    if (m) return { type: 'eventTruthy', prop: m[1] };
    return null;
}

function _parseCaseCondition(str) {
    const s = (str || '').trim();
    let m = _COND_FILE_COUNT_RE.exec(s);
    if (m) return { type: 'fileCount', prop: m[1], condOp: m[2], condValue: m[3], op: m[4], threshold: parseFloat(m[5]) };
    m = _COND_COUNT_RE.exec(s);
    if (m) return { type: 'count', array: 'events', subprop: m[1], op: m[2], value: parseFloat(m[3]) };
    m = _COND_UNDEF_RE.exec(s);
    if (m) return { type: 'existence', prop: m[1], exists: m[2] === '!=' };
    m = _COND_PROP_RE.exec(s);
    if (m) {
        const value = m[3] !== undefined ? m[3] : parseFloat(m[4]);
        return { type: 'property', prop: m[1], op: m[2], value };
    }
    m = _COND_PROP_NOT_CONTAINS_RE.exec(s);
    if (m) return { type: 'propContains', prop: m[1], value: m[2], negate: true };
    m = _COND_PROP_CONTAINS_RE.exec(s);
    if (m) return { type: 'propContains', prop: m[1], value: m[2], negate: false };
    if (s.includes('event.')) {
        const parts = s.split(/\s*&&\s*/);
        const subconditions = parts.map(_parseEventSubcondition);
        if (subconditions.every(Boolean)) return { type: 'eventMatch', subconditions };
    }
    console.warn(`  WARNING: unrecognised condition syntax: ${JSON.stringify(str)}`);
    return null;
}

function _applyCompOp(lhs, op, rhs) {
    switch (op) {
        case '>=': return lhs >= rhs;
        case '<=': return lhs <= rhs;
        case '>':  return lhs >  rhs;
        case '<':  return lhs <  rhs;
        case '==': return lhs == rhs;  // intentional == for mixed types
        case '!=': return lhs != rhs;
    }
    return false;
}

// 'volume' is never stored on a case object — like 'page', it's derived from
// usCite at read time (see CLAUDE.md) — so any condition/field referencing it
// must re-derive it here rather than reading caseObj.volume directly.
function _deriveVolumeFromUsCite(caseObj) {
    const m = /^(\d+)\s/.exec(caseObj.usCite || '');
    return m ? parseInt(m[1], 10) : null;
}

function _matchesCaseConditions(c, conditions, termDir = '') {
    for (const cond of conditions) {
        if (!cond) continue;
        if (cond.type === 'fileCount') {
            const folder = (c.number || c.id || '').split(',')[0].trim();
            if (!folder) return false;
            const filesPath = path.join(termDir, 'cases', folder, 'files.json');
            const files = _loadFilesCached(filesPath);
            if (!Array.isArray(files)) return false;
            const count = files.filter(f =>
                f && typeof f === 'object' &&
                _applyCompOp(String(f[cond.prop] ?? ''), cond.condOp, cond.condValue)
            ).length;
            if (!_applyCompOp(count, cond.op, cond.threshold)) return false;
        } else if (cond.type === 'existence') {
            const present = c[cond.prop] != null;
            if (present !== cond.exists) return false;
        } else if (cond.type === 'property') {
            const val = cond.prop === 'term' && termDir
                ? path.basename(termDir)
                : cond.prop === 'volume'
                    ? _deriveVolumeFromUsCite(c)
                    : c[cond.prop];
            if (val == null) return false;
            if (!_applyCompOp(val, cond.op, cond.value)) return false;
        } else if (cond.type === 'count') {
            const arr = Array.isArray(c[cond.array]) ? c[cond.array] : [];
            const count = arr.filter(item => !!item[cond.subprop]).length;
            if (!_applyCompOp(count, cond.op, cond.value)) return false;
        } else if (cond.type === 'propContains') {
            const has = String(c[cond.prop] ?? '').includes(cond.value);
            if (has === cond.negate) return false;
        } else if (cond.type === 'eventMatch') {
            const events = Array.isArray(c.events) ? c.events : [];
            const matched = events.some(ev => cond.subconditions.every(sub => {
                if (sub.type === 'eventTruthy') return !!ev[sub.prop];
                if (sub.type === 'eventFalsy')  return !ev[sub.prop];
                if (sub.type === 'eventProp')   return _applyCompOp(ev[sub.prop], sub.op, sub.value);
                if (sub.type === 'eventFileContains') {
                    const href = ev[sub.fileProp];
                    if (!href) return false;
                    const filePath = path.join(termDir, 'cases', href);
                    const json = _loadTranscriptCached(filePath);
                    if (!json) return false;
                    const arr = Array.isArray(json[sub.arrayName]) ? json[sub.arrayName] : [];
                    return arr.some(item => String(item[sub.itemProp] || '').includes(sub.value));
                }
                if (sub.type === 'eventFileCount') {
                    const href = ev[sub.fileProp];
                    if (!href) return false;
                    const filePath = path.join(termDir, 'cases', href);
                    const json = _loadTranscriptCached(filePath);
                    if (!json) return false;
                    const arr = Array.isArray(json[sub.arrayName]) ? json[sub.arrayName] : [];
                    const count = arr.filter(item => String(item[sub.itemProp] || '').includes(sub.value)).length;
                    return _applyCompOp(count, sub.op, sub.threshold);
                }
                return false;
            }));
            if (!matched) return false;
        }
    }
    return true;
}

// For conditions containing an eventFileCount subcondition, find the 1-based
// index of the first chronological event that satisfies the full eventMatch,
// and the 1-based turn number of the first item in that event's file that
// matches the fileCount value.  Returns null if no event qualifies.
function _findFirstEventAndTurn(c, conditions, termDir) {
    for (const cond of conditions) {
        if (cond.type !== 'eventMatch') continue;
        const fileCountSub = cond.subconditions.find(sub => sub.type === 'eventFileCount');
        if (!fileCountSub) continue;
        const nonFileSubs = cond.subconditions.filter(sub => sub.type !== 'eventFileCount');
        const events = Array.isArray(c.events) ? c.events : [];
        const sorted = [...events].sort((a, b) =>
            (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0
        );
        for (let ei = 0; ei < sorted.length; ei++) {
            const ev = sorted[ei];
            const basicOk = nonFileSubs.every(sub => {
                if (sub.type === 'eventTruthy') return !!ev[sub.prop];
                if (sub.type === 'eventFalsy')  return !ev[sub.prop];
                if (sub.type === 'eventProp')   return _applyCompOp(ev[sub.prop], sub.op, sub.value);
                return false;
            });
            if (!basicOk) continue;
            const href = ev[fileCountSub.fileProp];
            if (!href) continue;
            const json = _loadTranscriptCached(path.join(termDir, 'cases', href));
            if (!json) continue;
            const arr = Array.isArray(json[fileCountSub.arrayName]) ? json[fileCountSub.arrayName] : [];
            const count = arr.filter(item =>
                String(item[fileCountSub.itemProp] || '').includes(fileCountSub.value)).length;
            if (!_applyCompOp(count, fileCountSub.op, fileCountSub.threshold)) continue;
            const firstIdx = arr.findIndex(item =>
                String(item[fileCountSub.itemProp] || '').includes(fileCountSub.value));
            if (firstIdx < 0) continue;
            return { event: events.indexOf(ev) + 1, turn: arr[firstIdx].turn ?? (firstIdx + 1) };
        }
    }
    return null;
}

// For an eventMatch condition without a fileCount subcondition, find the
// 1-based original index (in the events array) of the first chronological
// event that satisfies all subconditions.  Returns null if none qualifies.
function _findFirstMatchingEventOrigIdx(events, eventMatchCond) {
    if (!Array.isArray(events) || !events.length) return null;
    const sorted = [...events].sort((a, b) =>
        (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0
    );
    for (const ev of sorted) {
        const ok = eventMatchCond.subconditions.every(sub => {
            if (sub.type === 'eventTruthy') return !!ev[sub.prop];
            if (sub.type === 'eventFalsy')  return !ev[sub.prop];
            if (sub.type === 'eventProp')   return _applyCompOp(ev[sub.prop], sub.op, sub.value);
            return false;
        });
        if (ok) return events.indexOf(ev) + 1;
    }
    return null;
}

// Parse an "order" spec into an ordered list of { key, asc } tie-break rules.
// Accepts a single "key:direction" pair or a comma-separated compound spec
// (e.g. "argument:ascending,titles:ascending") for deterministic tie-breaking —
// the same convention read client-side in explorer.js's
// _populateCollectionGroups (which only consumes the first/primary rule; the
// rest exist purely to make the generated file's own order idempotent).
// Keys: "argument" (the argument date; legacy alias "argued"), "decision"
// (the decision date; legacy alias "decided"), and "titles" (plus legacy
// aliases "title"/"cases") which sorts alphabetically by title. The "argued"/
// "decided" spelling matches the UI's user-facing sort-option labels
// ("Argued"/"Decided"), but the underlying case fields are "argument" and
// "decision", so that's the spelling collections.json/topics.json should use.
// Returns null for an empty/"none" spec, so callers can fall back to their
// own default order.
function _parseOrderSpec(orderSpec) {
    const spec = String(orderSpec || '').trim();
    if (!spec || spec.toLowerCase() === 'none') return null;
    const rules = spec.split(',').map(part => {
        const [rawKey, rawDir] = part.split(':').map(s => (s || '').trim().toLowerCase());
        let key = rawKey;
        if (key === 'title' || key === 'cases') key = 'titles';
        else if (key === 'argued')  key = 'argument';
        else if (key === 'decided') key = 'decision';
        return { key, asc: rawDir !== 'descending' };
    }).filter(r => r.key);
    return rules.length ? rules : null;
}

// Sort a list of case entries (as built by _setCaseEntry) in place, honoring
// an optional "order" spec (see _parseOrderSpec). With no order spec, falls
// back to the previous fixed chronological order (term, argument, decision,
// title) so existing output is unaffected.
function _sortCaseEntriesByOrder(cases, orderSpec) {
    const rules = _parseOrderSpec(orderSpec);
    if (!rules) {
        cases.sort((a, b) =>
            (a.term      || '').localeCompare(b.term      || '') ||
            (a.argument  || '').localeCompare(b.argument  || '') ||
            (a.decision  || '').localeCompare(b.decision  || '') ||
            (a.title     || '').localeCompare(b.title     || ''));
        return cases;
    }
    const keyOf = (c, key) => {
        if (key === 'titles')   return _naturalSortKey(c.title || '');
        if (key === 'argument') return c.argument || '';
        if (key === 'decision') return c.decision || '';
        return c.term || '';
    };
    cases.sort((a, b) => {
        for (const { key, asc } of rules) {
            const av = keyOf(a, key), bv = keyOf(b, key);
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            if (cmp !== 0) return asc ? cmp : -cmp;
        }
        return 0;
    });
    return cases;
}

// Scan allTerms for cases that satisfy requiredTags, filter, AND all conditions.
// `conditions` is normally a flat array of parsed condition objects (AND
// semantics, as produced by _parseCaseCondition). It may also be an array of
// such arrays — one per OR branch — in which case a case matches if it
// satisfies ANY branch (each branch's own conditions still AND'ed together).
// This lets a group merge what would otherwise be several separate
// condition-based groups (e.g. "argument date wrong OR reargument date wrong").
function _casesByConditions(allTerms, requiredTags, conditions, filter = {}, extraByKey = null, orderSpec = null, fields = null, openFileSpec = null) {
  // "event.PROP" (collections.json's group.openFile, e.g. "event.date") names
  // a property of the matched event to expose as entry.event_PROP, for the
  // front end to jump straight to the right file (see explorer.js's
  // _buildCollectionCaseItem) — same dotted-path style already used by the
  // "event.PROP" truthy conditions this function's own eventMatchCond
  // branch below evaluates.
  const openFileMatch = /^event\.(\w+)$/.exec(openFileSpec || '');
    const isOrBranches = Array.isArray(conditions[0]);
    const flatConditions = isOrBranches ? conditions.flat() : conditions;
    const matchesConditions = (c, termDir) => isOrBranches
        ? conditions.some(set => _matchesCaseConditions(c, set, termDir))
        : _matchesCaseConditions(c, conditions, termDir);
    const hasFileCount = flatConditions.some(cond =>
        cond.type === 'eventMatch' &&
        cond.subconditions.some(sub => sub.type === 'eventFileCount')
    );
    // eventMatch without fileCount (e.g. "Cases with Unaligned Audio"):
    // find the first chronological event that satisfies the match.
    const eventMatchCond = !hasFileCount
        ? flatConditions.find(cond => cond.type === 'eventMatch')
        : null;
    // count == 0 condition (e.g. "Cases Missing Audio"):
    // find the first chronological event (since none have the counted property).
    const countZeroCond = flatConditions.find(cond =>
        cond.type === 'count' && cond.op === '==' && cond.value === 0
    );
    const cases = [];
    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let termCases;
        try { termCases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(termCases)) continue;
        const termDir = path.join(TERMS_DIR, term);
        for (const c of termCases) {
            if (requiredTags.length) {
                if (!Array.isArray(c.tags)) continue;
                if (!requiredTags.every(t => c.tags.includes(t))) continue;
            }
            if (filter.decision && !(c.decision || '').includes(filter.decision)) continue;
            if (!matchesConditions(c, termDir)) continue;
            const key = `${term}\u0000${(c.number || c.id || '').split(',')[0].trim()}`;
            const entry = _setCaseEntry(c, term, extraByKey?.get(key), fields);
            if (hasFileCount) {
                const info = _findFirstEventAndTurn(c, flatConditions, termDir);
                if (info) {
                    entry.event = info.event;
                    entry.turn  = info.turn;
                    delete entry.transcript;
                }
            } else if (eventMatchCond) {
                const events = Array.isArray(c.events) ? c.events : [];
                const idx = _findFirstMatchingEventOrigIdx(events, eventMatchCond);
                if (idx !== null) {
                    entry.event = idx;
                    // group.openFile (e.g. "event.date") lets the front end
                    // (see "Cases with Minutes References") jump straight to
                    // that event's file (?file=) without an extra round trip
                    // just to look up its value.
                    if (openFileMatch) {
                        const ev = events[idx - 1];
                        const val = ev?.[openFileMatch[1]];
                        if (val != null) entry['event_' + openFileMatch[1]] = val;
                    }
                }
                delete entry.transcript;
            } else if (countZeroCond) {
                const events = Array.isArray(c.events) ? c.events : [];
                if (events.length > 0) {
                    const sorted = [...events].sort((a, b) =>
                        (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0
                    );
                    entry.event = events.indexOf(sorted[0]) + 1;
                } else {
                    delete entry.event;
                }
                delete entry.transcript;
            }
            cases.push(entry);
        }
    }
    _sortCaseEntriesByOrder(cases, orderSpec);
    return cases;
}

// ---------------------------------------------------------------------------

// Scan allTerms for cases that match a set of required tags; return sorted
// case entries.
function _casesByTags(allTerms, requiredTags, filter = {}, extraByKey = null, orderSpec = null, fields = null) {
    const cases = [];
    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let termCases;
        try { termCases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(termCases)) continue;
        for (const c of termCases) {
            if (!Array.isArray(c.tags)) continue;
            if (!requiredTags.every(t => c.tags.includes(t))) continue;
            if (filter.decision && !(c.decision || '').includes(filter.decision)) continue;
            const key = `${term}\u0000${(c.number || c.id || '').split(',')[0].trim()}`;
            cases.push(_setCaseEntry(c, term, extraByKey?.get(key), fields));
        }
    }
    _sortCaseEntriesByOrder(cases, orderSpec);
    return cases;
}

// Build a tags-based collection. When collEntry has a 'groups' array each
// group becomes a separate { name, cases } entry in the output; when it has
// a flat 'tags' array the entire collection is one group named after the
// collection itself.
//
// Special case: when a group's "title" is "*", the group fans out into one
// output-group per unique tag found on matching cases that is NOT in the
// group's required "tags" list. This lets collections.json express "one group
// per topic tag, for every case tagged Noteworthy" without enumerating every
// topic in advance.
//
// A group/collection "name" may also contain "$first_decision_year" and/or
// "$last_decision_year" placeholders, replaced with the min/max decision year
// across that group's cases — e.g. "Briefs ($first_decision_year-$last_decision_year)"
// stays accurate as cases are added without hand-editing collections.json.
function _expandGroupName(name, cases) {
    if (typeof name !== 'string' || !/\$(first|last)_decision_year/.test(name)) return name;
    const years = cases
        .map(c => (c?.decision || '').slice(0, 4))
        .filter(y => /^\d{4}$/.test(y))
        .map(Number);
    if (!years.length) return name;
    const first = Math.min(...years);
    const last = Math.max(...years);
    return name.replace(/\$first_decision_year/g, first).replace(/\$last_decision_year/g, last);
}

function _buildTagsCollection(allTerms, collEntry, filePath = null) {
    // Union of every group's (plus the collection's own, for the flat form)
    // "fields" list — see _setCaseEntry — so _loadExtraFieldsByKey knows not
    // to treat those freshly-recomputed properties as hand-curated "extra".
    const declaredFields = new Set(collEntry.fields || []);
    if (Array.isArray(collEntry.groups)) {
        for (const g of collEntry.groups) for (const f of (g.fields || [])) declaredFields.add(f);
    }
    // Carry forward any hand-added per-case fields (e.g. "gallery") from the
    // collection's existing output, since every branch below rebuilds case
    // entries from scratch via _setCaseEntry.
    const extraByKey = filePath ? _loadExtraFieldsByKey(filePath, declaredFields) : null;
    if (Array.isArray(collEntry.groups) && collEntry.groups.length) {
        const output = [];
        for (const g of collEntry.groups) {
            // A group explicitly marked "enabled": false is dropped from the
            // output entirely — kept in the collections registry for whenever
            // it's re-enabled, but shouldn't take up space while disabled.
            if (g.enabled === false) continue;
            const requiredTags = Array.isArray(g.tags) && g.tags.length ? g.tags : [];
            if ((g.name ?? g.title) === '*') {
                // Fan-out: one group per unique non-required tag on matching cases.
                // "excludeTags" additionally omits tags that aren't real topic
                // categories (e.g. media-availability tags like "Historical Briefs").
                const filter = g.decision ? { decision: g.decision } : {};
                const excludeTags = Array.isArray(g.excludeTags) ? g.excludeTags : [];
                const fanOut = new Map(); // tag name -> [entry, ...]
                for (const term of allTerms) {
                    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
                    if (!fs.existsSync(casesPath)) continue;
                    let termCases;
                    try { termCases = _readJson(casesPath); } catch { continue; }
                    if (!Array.isArray(termCases)) continue;
                    for (const c of termCases) {
                        if (!Array.isArray(c.tags)) continue;
                        if (!requiredTags.every(t => c.tags.includes(t))) continue;
                        if (filter.decision && !(c.decision || '').includes(filter.decision)) continue;
                        const key = `${term}\u0000${(c.number || c.id || '').split(',')[0].trim()}`;
                        const entry = _setCaseEntry(c, term, extraByKey?.get(key), g.fields);
                        for (const tag of c.tags) {
                            if (requiredTags.includes(tag) || excludeTags.includes(tag)) continue;
                            if (!fanOut.has(tag)) fanOut.set(tag, []);
                            fanOut.get(tag).push(entry);
                        }
                    }
                }
                const sortedNames = [...fanOut.keys()].sort((a, b) =>
                    _naturalSortKey(a).localeCompare(_naturalSortKey(b)));
                // Fan-out sub-groups have no per-group "order" of their own (their
                // name is dynamically generated) — the "*" group's own order/the
                // collection's order applies to all of them.
                const fanoutOrder = g.order || collEntry.order || null;
                for (const name of sortedNames) {
                    const cases = fanOut.get(name);
                    _sortCaseEntriesByOrder(cases, fanoutOrder);
                    output.push({ name, cases });
                }
            } else {
                const filter = g.decision ? { decision: g.decision } : {};
                const groupOrder = g.order || collEntry.order || null;
                let cases;
                if (Array.isArray(g.conditions) && g.conditions.length) {
                    // A condition entry that is itself an array is an OR branch of
                    // AND'ed conditions (see _casesByConditions) rather than a single
                    // condition string.
                    const parsed = Array.isArray(g.conditions[0])
                        ? g.conditions.map(set => set.map(_parseCaseCondition).filter(Boolean))
                        : g.conditions.map(_parseCaseCondition).filter(Boolean);
                    cases = _casesByConditions(allTerms, requiredTags, parsed, filter, extraByKey, groupOrder, g.fields, g.openFile);
                } else {
                    cases = requiredTags.length ? _casesByTags(allTerms, requiredTags, filter, extraByKey, groupOrder, g.fields) : [];
                }
                const name = g.name || g.title || '';
                // g.id, when present, is propagated through to the built file so
                // consumers reading it directly (rather than cross-referencing
                // collections.json) still have it — explorer.js's own runtime
                // merge (see _ensureCollectionBuilt) already did this on the fly,
                // this just makes the static file self-describing too.
                output.push({ id: g.id, name: _expandGroupName(name, cases), cases });
            }
        }
        return output;
    }
    // Flat (single-group) form.
    const name = collEntry.name ?? collEntry.title ?? '';
    const cases = _casesByTags(allTerms, collEntry.tags || [], {}, extraByKey, collEntry.order || null, collEntry.fields);
    return [{ name: _expandGroupName(name, cases), cases }];
}

function processCollectionSets(allTerms, dryRun) {
    // Tags/conditions-based collections: walk index.json to discover all
    // collection-definition files (collections.json, topics.json, etc.), then
    // find all leaf entries with 'tags' or 'groups' and build each one.
    const taggedCollections = [];
    let indexEntries = [];
    try { indexEntries = _readJson(_INDEX_JSON); } catch { /* ignore */ }
    const collDefFiles = indexEntries
        .filter(e => e.file && !e.file.endsWith('terms.json'))
        .map(e => path.join(REPO_ROOT, e.file.replace(/^\//, '')));
    for (const collDefsPath of collDefFiles) {
        if (!fs.existsSync(collDefsPath)) continue;
        let collDefs;
        try { collDefs = _readJson(collDefsPath); } catch { continue; }
        for (const collEntry of _collectTaggedLeafEntries(collDefs)) {
            const fileUrl = collEntry.file || collEntry.collection;
            // Resolve the file URL (absolute path starting with '/') to a local path.
            const filePath = path.join(REPO_ROOT, fileUrl.replace(/^\//, ''));
            const output = _buildTagsCollection(allTerms, collEntry, filePath);
            taggedCollections.push({ collEntry, filePath, output });
        }
    }

    const verb = dryRun ? 'Would write' : 'Wrote';
    if (!dryRun) {
        _mkdirSync(_COLLECTIONS_DIR, { recursive: true });
        for (const { filePath, output } of taggedCollections) {
            if (_jsonChanged(filePath, output)) _writeJson(filePath, output);
        }
    }
    for (const { collEntry, filePath, output } of taggedCollections) {
        const changed = _jsonChanged(filePath, output);
        const count = output.reduce((s, g) => s + (g.cases?.length ?? 0), 0);
        const rel = path.relative(REPO_ROOT, filePath);
        if (_VERBOSE || changed) {
            const label = collEntry.groups ? `${output.length} group(s) / ${count} case(s)` : `${count} case(s)`;
            console.log(`Tags [${(collEntry.tags || collEntry.groups?.flatMap(g => g.tags || [])).join(',')}]: ${verb} ${label} → ${rel}`);
        }
    }
}

// ── Title word index ──────────────────────────────────────────────────────────
// Builds courts/ussc/indexes/cases/titles/{aa,ab,...,zz,1a,...}.json.
// Each file maps every word that begins with that two-letter prefix (across all
// case titles in every term) to a sorted array of ref strings.  For standard
// October terms where c.id starts with the term year (e.g. "2019-036" in
// "2019-10"), the ref is just the id; otherwise it is "term/id-or-number".
// Words are lowercased; any non-alphanumeric character is treated as a word
// break; words shorter than 3 characters are omitted.
// Within each file, words are ordered by frequency (most cases first).
// Files are written compact (no indentation).

function processTitleIndex(allTerms, dryRun) {
    const INDEX_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'indexes', 'cases', 'titles');
    if (!dryRun && !fs.existsSync(INDEX_DIR)) {
        fs.mkdirSync(INDEX_DIR, { recursive: true });
    }

    // word → Set of ref strings
    const wordRefs = new Map();

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        const termYYYY = term.slice(0, 4);
        const isOctoberTerm = term.endsWith('-10');

        for (const c of cases) {
            const title = c.title;
            if (!title) continue;
            const canShorten = isOctoberTerm && c.id && c.id.startsWith(termYYYY);
            const ref = canShorten ? c.id : `${term}/${c.id || c.number}`;
            const words = title.toLowerCase().split(/[^a-z0-9]+/);
            for (const word of words) {
                if (word.length < 3) continue;
                if (!/^[a-z1-9]/.test(word)) continue;
                if (!wordRefs.has(word)) wordRefs.set(word, new Set());
                wordRefs.get(word).add(ref);
            }
        }
    }

    // Group words by their first two characters, then write one file per prefix.
    const byPrefix = new Map();
    for (const [word, refs] of wordRefs) {
        const prefix = word.slice(0, 2);
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, {});
        byPrefix.get(prefix)[word] = [...refs].sort();
    }

    let written = 0;
    for (const [prefix, index] of byPrefix) {
        const outPath = path.join(INDEX_DIR, `${prefix}.json`);
        // Sort by frequency (number of refs) descending, then alphabetically.
        const sorted = Object.fromEntries(
            Object.keys(index)
                .sort((a, b) => index[b].length - index[a].length || a.localeCompare(b))
                .map(k => [k, index[k]])
        );
        const content = JSON.stringify(sorted);
        if (dryRun) {
            if (_VERBOSE) console.log(`  [dry-run] would write ${path.relative(REPO_ROOT, outPath)}`);
        } else {
            let changed = true;
            try { changed = fs.readFileSync(outPath, 'utf8') !== content; } catch { /* new file */ }
            if (changed) { fs.writeFileSync(outPath, content, 'utf8'); written++; }
        }
    }

    if (written) console.log(`Title index: wrote ${written} file(s) in courts/ussc/indexes/cases/titles/`);
}

// Builds courts/ussc/indexes/cases/numbers.json.
// Maps each individual docket number (from the comma-separated "number" field)
// to a sorted array of ref strings using the same shortened-ref convention as
// processTitleIndex.  Normalization: lowercase; a hyphen immediately before
// "Orig" or "Misc" is replaced with a space so that "22-Orig" and "22 orig"
// both resolve to the index key "22 orig".
// File is written compact (no indentation).

function processNumberIndex(allTerms, dryRun) {
    const OUT_FILE = path.join(REPO_ROOT, 'courts', 'ussc', 'indexes', 'cases', 'numbers.json');

    // normalized number → Set of ref strings
    const numRefs = new Map();

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        const termYYYY = term.slice(0, 4);
        const isOctoberTerm = term.endsWith('-10');

        for (const c of cases) {
            if (!c.number && !c.id) continue;
            const canShorten = isOctoberTerm && c.id && c.id.startsWith(termYYYY);
            const ref = canShorten ? c.id : `${term}/${c.id || c.number}`;

            const addKey = (key) => {
                if (!key) return;
                if (!numRefs.has(key)) numRefs.set(key, new Set());
                numRefs.get(key).add(ref);
            };

            // Index each comma-separated docket number.
            for (const part of (c.number || '').split(',')) {
                addKey(part.trim().replace(/-(?=Orig|Misc)/i, ' ').toLowerCase());
            }

            // Also index by case id so searches like "1972-161" resolve directly.
            if (c.id) addKey(c.id.toLowerCase());
        }
    }

    // Sort by frequency descending, then alphabetically.
    const sorted = Object.fromEntries(
        [...numRefs.entries()]
            .sort(([a, ra], [b, rb]) => rb.size - ra.size || a.localeCompare(b))
            .map(([key, refs]) => [key, [...refs].sort()])
    );

    const content = JSON.stringify(sorted);
    if (dryRun) {
        if (_VERBOSE) console.log(`  [dry-run] would write courts/ussc/indexes/cases/numbers.json`);
    } else {
        let changed = true;
        try { changed = fs.readFileSync(OUT_FILE, 'utf8') !== content; } catch { /* new file */ }
        if (changed) {
            fs.writeFileSync(OUT_FILE, content, 'utf8');
            console.log(`Number index: wrote courts/ussc/indexes/cases/numbers.json`);
        }
    }
}

// Lowercase, strip periods, collapse whitespace — so "384 U.S. 436" and the
// more succinct "384 US 436" both resolve to the same index key ("384 us
// 436"). Mirrors the normalization the Terms search box applies to a partial
// citation query (assets/js/explorer.js) so index keys and queries agree.
function _normalizeUsCite(s) {
    return String(s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

// Builds courts/ussc/indexes/cases/citations.json.
// Maps each case's normalized `usCite` to a sorted array of ref strings, using
// the same shortened-ref convention as processTitleIndex/processNumberIndex.
// A citation is occasionally shared by more than one case, hence the array
// value. File is written compact (no indentation).

function processCitationIndex(allTerms, dryRun) {
    const OUT_FILE = path.join(REPO_ROOT, 'courts', 'ussc', 'indexes', 'cases', 'citations.json');

    // normalized usCite → Set of ref strings
    const citeRefs = new Map();

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        const termYYYY = term.slice(0, 4);
        const isOctoberTerm = term.endsWith('-10');

        for (const c of cases) {
            const key = _normalizeUsCite(c.usCite);
            if (!key || (!c.id && !c.number)) continue;
            const canShorten = isOctoberTerm && c.id && c.id.startsWith(termYYYY);
            const ref = canShorten ? c.id : `${term}/${c.id || c.number}`;
            if (!citeRefs.has(key)) citeRefs.set(key, new Set());
            citeRefs.get(key).add(ref);
        }
    }

    // Sort by frequency descending, then alphabetically.
    const sorted = Object.fromEntries(
        [...citeRefs.entries()]
            .sort(([a, ra], [b, rb]) => rb.size - ra.size || a.localeCompare(b))
            .map(([key, refs]) => [key, [...refs].sort()])
    );

    const content = JSON.stringify(sorted);
    if (dryRun) {
        if (_VERBOSE) console.log(`  [dry-run] would write courts/ussc/indexes/cases/citations.json`);
    } else {
        let changed = true;
        try { changed = fs.readFileSync(OUT_FILE, 'utf8') !== content; } catch { /* new file */ }
        if (changed) {
            fs.writeFileSync(OUT_FILE, content, 'utf8');
            console.log(`Citation index: wrote courts/ussc/indexes/cases/citations.json`);
        }
    }
}

// Builds courts/ussc/indexes/cases/onthisday.json.
// Maps each calendar day ("MM-DD", zero-padded) to a sorted array of ref
// strings for every case with an argument, reargument, or decision date
// landing on that day in *any* year — same shortened-ref convention as
// processTitleIndex/processNumberIndex/processCitationIndex. Backs the
// action=onthisday URL param (see assets/js/explorer.js), which picks one
// entry from a given day's list deterministically (seeded by the date plus
// a "seed" param) rather than truly at random. A case is only ever added
// once per day even if e.g. its argument and decision both happen to fall
// on the same "MM-DD" in different years. Keys are sorted chronologically
// (a plain string sort already achieves this for zero-padded "MM-DD"), not
// by frequency like the other indexes — there's no search-relevance
// question here. File is written compact (no indentation).
function processOnThisDayIndex(allTerms, dryRun) {
    const OUT_FILE = path.join(REPO_ROOT, 'courts', 'ussc', 'indexes', 'cases', 'onthisday.json');

    // "MM-DD" → Set of ref strings
    const dayRefs = new Map();

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        const termYYYY = term.slice(0, 4);
        const isOctoberTerm = term.endsWith('-10');

        for (const c of cases) {
            if (!c.id && !c.number) continue;
            const canShorten = isOctoberTerm && c.id && c.id.startsWith(termYYYY);
            const ref = canShorten ? c.id : `${term}/${c.id || c.number}`;

            const addedDays = new Set(); // this case's own already-added "MM-DD"s
            for (const field of ['argument', 'reargument', 'decision']) {
                const raw = c[field];
                if (!raw) continue;
                for (const d of raw.split(',').map(s => s.trim()).filter(Boolean)) {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; // skip partial/malformed dates
                    const mmdd = d.slice(5, 10);
                    if (addedDays.has(mmdd)) continue;
                    addedDays.add(mmdd);
                    if (!dayRefs.has(mmdd)) dayRefs.set(mmdd, new Set());
                    dayRefs.get(mmdd).add(ref);
                }
            }
        }
    }

    const sorted = {};
    for (const mmdd of [...dayRefs.keys()].sort()) {
        sorted[mmdd] = [...dayRefs.get(mmdd)].sort();
    }

    const content = JSON.stringify(sorted);
    if (dryRun) {
        if (_VERBOSE) console.log(`  [dry-run] would write courts/ussc/indexes/cases/onthisday.json`);
    } else {
        let changed = true;
        try { changed = fs.readFileSync(OUT_FILE, 'utf8') !== content; } catch { /* new file */ }
        if (changed) {
            fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
            fs.writeFileSync(OUT_FILE, content, 'utf8');
            console.log(`On-this-day index: wrote courts/ussc/indexes/cases/onthisday.json (${Object.keys(sorted).length} days)`);
        }
    }
}

// Words excluded from the keyword (transcript) index.
// The 3-char minimum enforced during tokenisation already drops single-letter
// words and two-letter words (a, an, as, at, be, by, do, go, he, if, in, is,
// it, me, my, no, of, on, or, so, to, up, us, we), so only 3+ char words need
// to be listed here.
const KEYWORD_STOP_WORDS = new Set([
    // Articles / demonstratives
    'the', 'this', 'that', 'these', 'those',
    // Personal pronouns
    'you', 'your', 'yours', 'him', 'his', 'her', 'hers',
    'they', 'them', 'their', 'theirs', 'our', 'ours', 'its',
    // Relative / interrogative
    'who', 'whom', 'whose', 'what', 'which', 'how', 'why', 'when', 'where',
    // Forms of "to be"
    'was', 'are', 'were', 'been', 'being',
    // Modals / auxiliaries
    'can', 'did', 'has', 'had', 'have', 'will', 'would', 'shall', 'should',
    'may', 'might', 'must', 'could',
    // High-frequency verbs
    'get', 'got', 'let', 'put', 'set', 'say', 'said', 'use', 'used',
    'make', 'made', 'come', 'came', 'see', 'saw', 'look', 'know', 'think',
    'take', 'took', 'give', 'gave', 'mean', 'means', 'meant', 'need',
    'going', 'does', 'done',
    // Prepositions / conjunctions / adverbs (3+ chars)
    'for', 'from', 'with', 'out', 'off', 'per', 'not', 'nor', 'but',
    'and', 'then', 'than', 'all', 'any', 'few', 'own', 'due', 'now',
    'yet', 'too', 'also', 'just', 'even', 'back', 'only', 'well', 'very',
    'here', 'there', 'some', 'such', 'each', 'into', 'onto', 'over',
    'under', 'about', 'after', 'again', 'other', 'while', 'before',
    // Common transcript filler / courtesy words
    'sir', 'yes', 'right', 'okay', 'sure', 'sort',
    // Misc function words
    'one', 'two', 'three', 'new', 'more', 'most', 'much', 'many',
    'both', 'same', 'way', 'like', 'been',
]);

// Return the set of 1-based word positions (matching the `p` position used
// elsewhere — i.e. wIdx+1 from `text.toLowerCase().split(/[^a-z]+/)`) in `text`
// whose word looks like a person's (or case's) name: capitalized and either
// not preceded by a period (so not just ordinary sentence-initial
// capitalization), or preceded by "Mr.", "Mrs.", "Ms.", "Miss", or "v." (as in
// "Smith v. Jones") regardless of sentence position. Used only to keep names
// out of the rare-words list — the main keyword search index is unaffected
// and still indexes every word.
function _nameLikePositions(text) {
    const positions = new Set();
    const matches = [...text.matchAll(/[A-Za-z]+/g)];
    // split(/[^a-z]+/) inserts a leading empty-string entry (shifting every
    // later position by 1) whenever the text starts with a non-letter char —
    // replicate that offset so positions line up with the main tokenizer.
    const leadingOffset = /^[^A-Za-z]/.test(text) ? 1 : 0;
    const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'v']);
    for (let i = 0; i < matches.length; i++) {
        const word = matches[i][0];
        if (!/^[A-Z]/.test(word)) continue;
        const sentenceInitial = i === 0 || /\.\s*$/.test(text.slice(0, matches[i].index));
        const prevWord = i > 0 ? matches[i - 1][0].toLowerCase() : null;
        const precededByHonorific = prevWord != null && HONORIFICS.has(prevWord);
        if (!sentenceInitial || precededByHonorific) positions.add(i + 1 + leadingOffset);
    }
    return positions;
}

// Scan every term's cases.json, read all referenced transcript files, and
// rebuild courts/ussc/indexes/cases/keywords/{ch}.json.
//
// Index format:
//   { "word": { "term/ref": [e1,t1,p1,nid1, e2,t2,p2,nid2, ...], ... }, ... }
// Each group of 4 numbers is one (event, turn) occurrence of the word, sorted by
// (eventIdx, turnNum).  eventIdx is the 1-based position in c.events; turnNum is
// turn.turn from the transcript (also 1-based).  p is the 1-based word position
// within that turn (first occurrence of the word in the turn).  nid is the justice's
// numeric id when the speaker's title contains "JUSTICE", and 0 otherwise.
function processKeywordIndex(allTerms, dryRun) {
    const INDEX_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'indexes', 'cases', 'keywords');
    if (!dryRun && !fs.existsSync(INDEX_DIR)) {
        fs.mkdirSync(INDEX_DIR, { recursive: true });
    }

    // Load justices for nid lookup (name → nid).
    const justiceNidByName = new Map();
    try {
        const justicesData = _readJson(path.join(REPO_ROOT, 'data', 'ussc', 'justices.json'));
        for (const [name, j] of Object.entries(justicesData)) {
            if (j.nid) {
                justiceNidByName.set(name, j.nid);
                for (const alt of (j.alternates || [])) justiceNidByName.set(alt, j.nid);
            }
        }
    } catch { /* ignore — justice data is optional */ }

    // word → Map<ref, [e1,t1,p1,nid1, e2,t2,p2,nid2, ...]>
    // ref is a short id ("YYYY-NNN") when term is YYYY-10 and c.id starts with YYYY;
    // otherwise the full "term/id-or-number" string.
    const wordLocs = new Map();

    // Words seen at least once anywhere in the corpus at a name-like position
    // (see _nameLikePositions) — treated as a proper noun everywhere it
    // appears (even where a given occurrence looks innocuous) and excluded
    // wholesale from the rare-words collection built below.
    const properNounWords = new Set();

    // ref → { term, c } — needed to resolve rare-word case metadata below
    // without re-reading every term's cases.json a second time.
    const caseByRef = new Map();

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        const termYYYY = term.slice(0, 4);
        const isOctoberTerm = term.endsWith('-10');

        for (const c of cases) {
            if (!Array.isArray(c.events)) continue;

            // Use a short key (just c.id) when the term is a standard October term and
            // the id year matches; the lookup side can infer "YYYY-10" from the id prefix.
            const canShorten = isOctoberTerm && c.id && c.id.startsWith(termYYYY);
            const ref = canShorten ? c.id : `${term}/${c.id || c.number}`;
            caseByRef.set(ref, { term, c });

            // Dates that have an oyez transcript — used to skip redundant ussc transcripts.
            const oyezDates = new Set(
                c.events.filter(e => e.source === 'oyez' && e.text_href).map(e => e.date)
            );

            // word → Array of [eventIdx, turnNum, wordPos, nid] — one per occurrence.
            const caseWordOccurrences = new Map();
            // text_href -> parsed transcript (or null) — several events can share
            // the same transcript (e.g. "Oral Announcement by Justice X" events
            // pointing at the same file as the main opinion event), so cache the
            // parse per case instead of re-reading/re-parsing it for each one.
            const txCache = new Map();
            for (let evIdx = 0; evIdx < c.events.length; evIdx++) {
                const ev = c.events[evIdx];
                if (!ev.text_href) continue;
                // Only index oyez transcripts (the default/primary source) plus titled
                // non-oyez transcripts that have no oyez counterpart on the same date.
                if (ev.source !== 'oyez') {
                    if (!ev.title || oyezDates.has(ev.date)) continue;
                }
                let tx = txCache.get(ev.text_href);
                if (tx === undefined) {
                    const txPath = path.join(TERMS_DIR, term, 'cases', ev.text_href);
                    try { tx = fs.existsSync(txPath) ? _readJson(txPath) : null; } catch { tx = null; }
                    txCache.set(ev.text_href, tx);
                }
                if (!tx || !Array.isArray(tx.turns)) continue;
                // Normally this transcript's words are indexed under this event's own
                // position. But when this event has no audio_href, the front end's
                // dropdown (see sortedAudio in explorer.js) excludes it from the
                // selectable list in favor of a same-date/type sibling that borrows
                // this text_href via withTranscriptFallback() — so ?event=<this index>
                // never actually resolves to this transcript. Index the words under
                // that sibling's position instead, since that's the only reachable one.
                let effectiveEvIdx = evIdx;
                if (!ev.audio_href) {
                    const siblingIdx = c.events.findIndex(sib =>
                        sib !== ev && sib.date === ev.date && sib.type === ev.type && !sib.text_href && sib.audio_href
                    );
                    if (siblingIdx !== -1) effectiveEvIdx = siblingIdx;
                }
                const eventIdx = effectiveEvIdx + 1; // 1-based, matches ?event= URL param

                // Build name → title map from the transcript's speaker list.
                const speakerTitleMap = new Map();
                if (Array.isArray(tx.media?.speakers)) {
                    for (const s of tx.media.speakers) {
                        if (s.name && s.title) speakerTitleMap.set(s.name, s.title);
                    }
                }

                for (const turn of tx.turns) {
                    if (!turn.text) continue;
                    const speakerTitle = speakerTitleMap.get(turn.name) || '';
                    const isJustice = speakerTitle.includes('JUSTICE');
                    const nid = isJustice ? (justiceNidByName.get(turn.name) || 0) : 0;
                    const words = turn.text.toLowerCase().split(/[^a-z]+/);
                    const namePositions = _nameLikePositions(turn.text);
                    for (let wIdx = 0; wIdx < words.length; wIdx++) {
                        const word = words[wIdx];
                        if (word.length < 3) continue;
                        if (KEYWORD_STOP_WORDS.has(word)) continue;
                        if (!caseWordOccurrences.has(word)) caseWordOccurrences.set(word, []);
                        caseWordOccurrences.get(word).push([eventIdx, turn.turn, wIdx + 1, nid]);
                        if (namePositions.has(wIdx + 1)) properNounWords.add(word);
                    }
                }
            }

            for (const [word, tuples] of caseWordOccurrences) {
                if (!wordLocs.has(word)) wordLocs.set(word, new Map());
                const entry = tuples.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).flat();
                wordLocs.get(word).set(ref, entry);
            }
        }
    }

    // Words flagged as name-like anywhere in the corpus are excluded from the
    // rare-words collection wholesale — including occurrences that looked
    // innocuous on their own (e.g. "Bachowski" used mid-sentence without a
    // preceding "Mr."/"v." still gets treated as a proper noun everywhere).
    const rareWordLocs = new Map();
    for (const [word, locMap] of wordLocs) {
        if (!properNounWords.has(word)) rareWordLocs.set(word, locMap);
    }

    // Group words by their first two characters, then write one file per prefix.
    // Value for each word is a plain object { ref: [ev, turn], ... }
    // with refs sorted so the output is deterministic.
    const byPrefix = new Map();
    for (const [word, locMap] of wordLocs) {
        const prefix = word.slice(0, 2);
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, {});
        const sortedRefs = [...locMap.keys()].sort();
        byPrefix.get(prefix)[word] = Object.fromEntries(sortedRefs.map(r => [r, locMap.get(r)]));
    }

    // 2-letter prefix files over this size are split into 3-letter sub-files
    // (see below) to keep individual index files small enough to fetch quickly.
    const KEYWORD_MAX_BYTES = 1024 * 1024;

    const writeIfChanged = (outPath, content) => {
        if (dryRun) {
            if (_VERBOSE) console.log(`  [dry-run] would write ${path.relative(REPO_ROOT, outPath)}`);
            return false;
        }
        let changed = true;
        try { changed = fs.readFileSync(outPath, 'utf8') !== content; } catch { /* new file */ }
        if (changed) fs.writeFileSync(outPath, content, 'utf8');
        return changed;
    };

    let written = 0;
    for (const [prefix, index] of byPrefix) {
        const outPath = path.join(INDEX_DIR, `${prefix}.json`);
        // Sort by frequency (number of cases) descending, then alphabetically.
        const words = Object.keys(index)
            .sort((a, b) => Object.keys(index[b]).length - Object.keys(index[a]).length || a.localeCompare(b));
        const sorted = Object.fromEntries(words.map(k => [k, index[k]]));
        let content = JSON.stringify(sorted);

        if (Buffer.byteLength(content, 'utf8') > KEYWORD_MAX_BYTES) {
            // Split by the word's 3rd character. Every indexed word is ≥ 3 chars
            // (see the `word.length < 3` check above), so nothing is left behind —
            // the 2-letter file is replaced by a flat array naming the 3-letter
            // sub-prefixes, which the front end resolves per token
            // (see _fetchKeywordIndexForToken in explorer.js).
            const bySubPrefix = new Map();
            for (const word of words) {
                const subPrefix = word.slice(0, 3);
                if (!bySubPrefix.has(subPrefix)) bySubPrefix.set(subPrefix, {});
                bySubPrefix.get(subPrefix)[word] = index[word];
            }
            const subPrefixes = [...bySubPrefix.keys()].sort();
            for (const subPrefix of subPrefixes) {
                const subPath = path.join(INDEX_DIR, `${subPrefix}.json`);
                if (writeIfChanged(subPath, JSON.stringify(bySubPrefix.get(subPrefix)))) written++;
            }
            content = JSON.stringify(subPrefixes);
        }

        if (writeIfChanged(outPath, content)) written++;
    }

    if (written || _VERBOSE) console.log(`Keyword index: wrote ${written} file(s) in courts/ussc/indexes/cases/keywords/`);

    _writeRareWordsCollection(rareWordLocs, caseByRef, writeIfChanged);
}

// Lazily loaded Set of ~211k common English words (Webster's Second
// International — 1934 copyright lapsed, public domain), one per line, from
// scripts/dictionary.txt. Used by the rare-words collection below to split
// candidates into a "real dictionary word" list and a "everything else"
// list of likely typos/oddities.
let _dictionaryWords = null;
function _loadDictionaryWords() {
    if (_dictionaryWords) return _dictionaryWords;
    _dictionaryWords = new Set();
    try {
        const text = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'dictionary.txt'), 'utf8');
        for (const line of text.split('\n')) {
            const w = line.trim();
            if (w) _dictionaryWords.add(w);
        }
    } catch { /* dictionary is optional — everything falls into the non-dictionary list */ }
    return _dictionaryWords;
}

// Select the `count` rarest candidates (ascending total occurrences, then
// ascending case count), grouped into tiers of equal rarity. The very first
// tier is typically huge — thousands of words spoken only once or twice — so
// it alone can blow past `count`. Truncating that tier alphabetically would
// leave the whole selection stuck on words starting with "a"; instead, once a
// tier doesn't fully fit in the remaining budget, sample across it by
// bucketing words by their first letter and round-robining through the
// buckets, so the selection spans the alphabet instead of clustering at the
// front. Returns an array of the original candidate objects.
function _selectRarestSpread(candidates, count) {
    const tiers = new Map(); // "occurrences:caseCount" → candidates
    for (const cand of candidates) {
        const key = `${cand.totalOccurrences}:${cand.caseCount}`;
        if (!tiers.has(key)) tiers.set(key, []);
        tiers.get(key).push(cand);
    }
    const tierKeys = [...tiers.keys()].sort((a, b) => {
        const [aOcc, aCount] = a.split(':').map(Number);
        const [bOcc, bCount] = b.split(':').map(Number);
        return aOcc - bOcc || aCount - bCount;
    });

    const selected = [];
    let remaining = count;
    for (const key of tierKeys) {
        if (remaining <= 0) break;
        const tierWords = tiers.get(key);
        if (tierWords.length <= remaining) {
            selected.push(...tierWords);
            remaining -= tierWords.length;
            continue;
        }
        const byLetter = new Map();
        for (const cand of tierWords) {
            const letter = cand.word[0];
            if (!byLetter.has(letter)) byLetter.set(letter, []);
            byLetter.get(letter).push(cand);
        }
        for (const bucket of byLetter.values()) bucket.sort((a, b) => a.word.localeCompare(b.word));
        const letters = [...byLetter.keys()].sort();
        const picked = [];
        for (let round = 0; picked.length < remaining; round++) {
            let any = false;
            for (const letter of letters) {
                if (picked.length >= remaining) break;
                const bucket = byLetter.get(letter);
                if (round < bucket.length) { picked.push(bucket[round]); any = true; }
            }
            if (!any) break; // every bucket exhausted
        }
        selected.push(...picked);
        remaining -= picked.length;
    }
    return selected;
}

// Build courts/ussc/collections/rare/rare_words.json (an ordinary embedded-format
// collection: [{ name: <word>, cases: [...] }, ...], browsable the same way
// as e.g. orig.json) — two lists of RARE_WORD_COUNT words each, back to back:
// the rarest words that are real dictionary words (any case count, even a
// single one — dictionary membership is itself the quality signal), followed
// by the rarest words that are NOT in the dictionary (tagged "dictionary":
// false), which are mostly one-off transcription typos/ASR artifacts (e.g. a
// stutter transcribed as "aaainst") but occasionally legal/technical terms or
// other oddities the dictionary doesn't cover.
// courts/ussc/collections/rare/index.md renders this file client-side
// (fetch + DOM) as two labeled lists, rather than being regenerated here, so
// hand edits to that page's prose/markup are never overwritten.
function _writeRareWordsCollection(wordLocs, caseByRef, writeIfChanged) {
    const RARE_WORD_COUNT = 250;
    // A short dictionary match is excluded from the "real word" list because
    // a mid-word split (e.g. alignment/OCR turning "unreasonable" into
    // "unreaso" + "nable", or "secular" into "sec" + "ula" + "r") coincidentally
    // collides with real short dictionary headwords far more often than long
    // ones do — such a word instead falls into the non-dictionary list.
    const MIN_DICTIONARY_WORD_LENGTH = 5;
    const dictionary = _loadDictionaryWords();

    const dictCandidates = [];
    const nonDictCandidates = [];
    for (const [word, locMap] of wordLocs) {
        let totalOccurrences = 0;
        for (const tuples of locMap.values()) totalOccurrences += tuples.length / 4;
        const cand = { word, caseCount: locMap.size, totalOccurrences };
        const isDictionaryWord = word.length >= MIN_DICTIONARY_WORD_LENGTH && dictionary.has(word);
        (isDictionaryWord ? dictCandidates : nonDictCandidates).push(cand);
    }

    const buildGroup = (word, extra) => {
        // "find" is omitted here — it's always just the group's own "name"
        // repeated on every case, so consumers fall back to that instead
        // (see _buildCollectionCaseItem in explorer.js and rare/index.md).
        const cases = [...wordLocs.get(word).entries()].map(([ref, tuples]) => {
            const found = caseByRef.get(ref);
            if (!found) return null;
            const { term, c } = found;
            return {
                title: firstTitle(c.title) || '',
                term,
                number: _primaryCaseNumber(c),
                argument: c.argument || '',
                decision: c.decision || '',
                event: tuples[0],
                turn: tuples[1],
            };
        }).filter(Boolean).sort((a, b) =>
            (a.argument || '') < (b.argument || '') ? -1 : (a.argument || '') > (b.argument || '') ? 1 : 0
        );
        return { name: word, cases, ...extra };
    };
    const byCaseCountThenName = (a, b) => a.cases.length - b.cases.length || a.name.localeCompare(b.name);

    const dictGroups = _selectRarestSpread(dictCandidates, RARE_WORD_COUNT)
        .map(({ word }) => buildGroup(word, {}))
        .filter(g => g.cases.length)
        .sort(byCaseCountThenName);
    const nonDictGroups = _selectRarestSpread(nonDictCandidates, RARE_WORD_COUNT)
        .map(({ word }) => buildGroup(word, { dictionary: false }))
        .filter(g => g.cases.length)
        .sort(byCaseCountThenName);

    const rareWords = [...dictGroups, ...nonDictGroups];

    const jsonPath = path.join(REPO_ROOT, 'courts', 'ussc', 'collections', 'rare', 'rare_words.json');
    const jsonWritten = writeIfChanged(jsonPath, JSON.stringify(rareWords, null, 2) + '\n');

    if (jsonWritten || _VERBOSE) {
        console.log(`Rare words: wrote ${dictGroups.length} dictionary word(s) + ${nonDictGroups.length} non-dictionary word(s) → courts/ussc/collections/rare/rare_words.json`);
    }
}

function _scdbVotesSubset(row) {
    const out = [];

    for (const j of (row.justices || [])) {
        let name = (j.justiceName || '').trim().toUpperCase();
        if (_scdbJusticesMap[name]) name = _scdbJusticesMap[name];
        if (!name) continue;

        const majorityRaw = (j.majority || '').trim().toLowerCase();
        const voteRaw     = (j.vote     || '').trim().toLowerCase();
        const opinionRaw  = (j.opinion  || '').trim().toLowerCase();

        // Derive our vote value from the SCDB majority field (codes: 2=majority, 1=dissent).
        let vote;
        if (majorityRaw === 'majority' || majorityRaw === '2') {
            vote = 'majority';
        } else if (majorityRaw === 'dissent' || majorityRaw === '1') {
            vote = 'minority';
        } else {
            // majority is blank — expect vote code 8 (equally divided) or blank (none)
            if (voteRaw === 'justice participated in an equally divided vote' || voteRaw === '8') {
                vote = 'unknown';
            } else if (!voteRaw) {
                vote = 'none';
            } else if (_SCDB_MIN_VOTE_TYPES.has(voteRaw) || voteRaw.startsWith('dissent from')) {
                vote = 'minority';
            } else {
                console.log(`WARNING: ${name}: majority field is blank but vote="${j.vote}" (expected blank or equally-divided)`);
                vote = 'unknown';
            }
        }

        const entry = { name, vote };

        // Derive action from the SCDB opinion field (codes: 2=wrote, 3=co-authored).
        const voteLabel = j.vote.trim().replace(/^voted with majority or plurality$/i, 'majority or plurality');
        if (opinionRaw === 'justice wrote an opinion' || opinionRaw === '2') {
            entry.action = 'wrote an opinion' + (voteRaw ? ': ' + voteLabel : '');
        } else if (opinionRaw === 'justice co-authored an opinion' || opinionRaw === '3') {
            entry.action = 'co-authored an opinion' + (voteRaw ? ': ' + voteLabel : '');
        }

        out.push(entry);
    }
    return out;
}

// All justice names listed by SCDB for a case row, regardless of whether they
// participated. Used to suppress "ours only" mismatches when SCDB explicitly
// shows the justice as non-participating (blank vote/majority fields).
function _scdbAllJusticeNames(row) {
    const out = new Set();
    for (const j of (row.justices || [])) {
        let name = (j.justiceName || '').trim().toUpperCase();
        if (_scdbJusticesMap[name]) name = _scdbJusticesMap[name];
        if (name) out.add(name);
    }
    return out;
}

function _scdbOurVotesSubset(c) {
    if (!Array.isArray(c.votes)) return [];
    const out = [];
    for (const v of c.votes) {
        if (!v || typeof v !== 'object') continue;
        const name = (v.name || '').trim().toUpperCase();
        const raw  = (v.vote || '').trim().toLowerCase();
        if (!name) continue;
        // Accept the four canonical vote values directly.
        if (raw === 'majority' || raw === 'minority' || raw === 'unknown' || raw === 'none') {
            out.push({ name, vote: raw });
            continue;
        }
        // Normalize legacy vote strings for comparison with SCDB-derived data.
        const vote = _scdbVoteTypeToMajority(raw) || _scdbVoteToOurs(raw);
        if (vote === 'majority' || vote === 'minority') out.push({ name, vote });
    }
    return out;
}
function _scdbVotesSorted(votes) {
    return [...votes].sort((a, b) => a.name.localeCompare(b.name) || a.vote.localeCompare(b.vote));
}
function _scdbVotesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].name !== b[i].name || a[i].vote !== b[i].vote) return false;
    }
    return true;
}

function _scdbMajorityCounts(row) {
    const parse = (v) => {
        const s = (v || '').trim();
        if (!s) return null;
        const n = parseFloat(s);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    };
    const maj  = parse(row.majVotes);
    const minv = parse(row.minVotes);
    return [maj, minv];
}

function _scdbFieldPresent(c, key) {
    if (!(key in c)) return false;
    const v = c[key];
    if (typeof v === 'string') return !!v.trim();
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'number') return true;
    return false;
}

function _scdbHasImportedOpinion(c) {
    for (const k of ['volume','page','usCite','voteMajority','voteMinority','votes','decision_loc','decision_ussc','decision_rep']) {
        if (_scdbFieldPresent(c, k)) return true;
    }
    return false;
}

function _scdbMergeVotes(existing, fromScdb) {
    const list = Array.isArray(existing) ? existing.slice() : [];
    const seen = new Set();
    for (const v of list) {
        if (v && typeof v === 'object' && v.name) {
            seen.add(`${String(v.name).trim().toUpperCase()}\u0000${String(v.vote || '').trim().toLowerCase()}`);
        }
    }
    let added = 0;
    for (const v of fromScdb) {
        const key = `${v.name}\u0000${v.vote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ name: v.name, vote: v.vote });
        added++;
    }
    return { votes: list, added };
}

function _scdbApplyOpinionUpdate(c, row) {
    const usCite = _scdbNormalizeCite(row.usCite || '');
    const [volume, page] = _scdbParseUsCite(usCite);
    const [maj, minv]    = _scdbMajorityCounts(row);
    const votes          = _scdbVotesSubset(row);
    const opinionHref    = _scdbLocOpinionHref(volume, page);

    if (!(volume || page || usCite || maj !== null || minv !== null || votes.length || opinionHref)) return false;

    // If usCite is/will be present and parses to the same volume/page, don't write redundant keys.
    const effectiveUsCite = _scdbFieldPresent(c, 'usCite') ? c.usCite : usCite;
    const [citeVol, citePage] = _scdbParseUsCite(effectiveUsCite);

    const next = { ...c };
    if (usCite       && !_scdbFieldPresent(c, 'usCite'))       next.usCite = usCite;
    if (maj  !== null && !_scdbFieldPresent(c, 'voteMajority')) next.voteMajority = maj;
    if (minv !== null && !_scdbFieldPresent(c, 'voteMinority')) next.voteMinority = minv;
    if (votes.length) {
        if (!_scdbFieldPresent(c, 'votes')) {
            next.votes = votes;
        } else {
            const merged = _scdbMergeVotes(c.votes, votes);
            if (merged.added) next.votes = merged.votes;
        }
    }
    if (opinionHref  && !_scdbFieldPresent(c, 'decision_loc')) next.decision_loc = opinionHref;

    const reordered = reorderCase(next);
    if (JSON.stringify(reordered) === JSON.stringify(c)) return false;
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, reordered);
    return true;
}

// Build a human-readable scdb_message string describing each category
// currently flagged in scdb_check, using the raw SCDB row values.
// A category that isn't (or is no longer) present in scdb_check
// contributes no message. Multiple messages are joined with '; '.
function _scdbBuildMessage(c, row) {
    const categories = new Set(
        String(c.scdb_check || '').split(',').map(s => s.trim()).filter(Boolean)
    );
    const messages = [];

    if (categories.has('argument')) {
        const scdbArg = _scdbNormalizeDate(row.dateArgument || '');
        // A blank SCDB value gets its own "missing" message instead of
        // "incorrect"/"incomplete" — there's no date to compare against or
        // to say ours is a superset of.
        if (!scdbArg) {
            messages.push('SCDB argument date missing');
        } else {
            if (!_scdbContainsDate(c.argument, scdbArg)) {
                messages.push(`SCDB argument date (${scdbArg}) incorrect`);
            }
            if (String(c.argument || '').includes(',')) {
                messages.push('SCDB argument dates incomplete');
            }
        }
    }
    if (categories.has('reargument')) {
        const scdbRe = _scdbNormalizeDate(row.dateRearg || row.datreRearg || '');
        if (!scdbRe) {
            messages.push('SCDB reargument date missing');
        } else {
            if (!_scdbContainsDate(c.reargument, scdbRe)) {
                messages.push(`SCDB reargument date (${scdbRe}) incorrect`);
            }
            if (String(c.reargument || '').includes(',')) {
                messages.push('SCDB reargument dates incomplete');
            }
        }
    }
    if (categories.has('decision')) {
        const scdbDec = _scdbNormalizeDate(row.dateDecision || '');
        const ourDec  = _scdbNormalizeDate(c.decision || '');
        if (scdbDec && ourDec && scdbDec !== ourDec) {
            messages.push(`SCDB decision date (${scdbDec}) incorrect`);
        }
    }

    return messages.join('; ');
}

// Minimal corrective updates (used when --update is set). Trusts our data for
// date fields (records disagreement in scdb_check) and trusts SCDB for missing
// votes and vote counts.
function _scdbApplyXUpdate(c, row, mm) {
    let changed = false;

    const ignored = new Set(
        String(c.scdb_check || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
    );

    const addToErrors = (field) => {
        const cur = String(c.scdb_check || '').split(',').map(s => s.trim()).filter(Boolean);
        if (cur.includes(field)) return;
        cur.push(field);
        c.scdb_check = cur.join(',');
        changed = true;
    };
    const removeFromErrors = (field) => {
        const cur = String(c.scdb_check || '').split(',').map(s => s.trim()).filter(Boolean);
        const idx = cur.indexOf(field);
        if (idx === -1) return;
        cur.splice(idx, 1);
        if (cur.length) c.scdb_check = cur.join(',');
        else delete c.scdb_check;
        changed = true;
    };

    // A comma-separated (multi-day) value flags the field too, even absent a
    // genuine date mismatch: SCDB's single-date schema can never represent
    // it, so it's always "incomplete" relative to ours (see
    // _scdbBuildMessage's independent 'dates incomplete' message).
    const argIncomplete   = String(c.argument   || '').includes(',');
    const reargIncomplete = String(c.reargument || '').includes(',');

    if (mm.decision)                      addToErrors('decision');
    if (mm.argument   || argIncomplete)   addToErrors('argument');
    if (mm.reargument || reargIncomplete) addToErrors('reargument');

    // Prune flags that no longer represent a genuine mismatch or an
    // incomplete (multi-day) value, using strict equality (unlike the
    // lenient _scdbContainsDate check above used only to decide whether to
    // *add* a flag for a genuine mismatch in the first place). A
    // comma-separated value can never strictly equal SCDB's single date, so
    // this naturally leaves an incomplete-only flag in place until the
    // extra dates are removed.
    if (ignored.has('argument')   && _scdbStrictDateMatches(c.argument, row.dateArgument)) removeFromErrors('argument');
    if (ignored.has('reargument') && _scdbStrictDateMatches(c.reargument, row.dateRearg || row.datreRearg)) removeFromErrors('reargument');
    if (ignored.has('decision')   && _scdbStrictDateMatches(c.decision, row.dateDecision)) removeFromErrors('decision');

    const newMessage = _scdbBuildMessage(c, row);
    if (newMessage) {
        if (c.scdb_message !== newMessage) { c.scdb_message = newMessage; changed = true; }
    } else if (c.scdb_message !== undefined) {
        delete c.scdb_message;
        changed = true;
    }

    const votesToApply = mm.scdbVotes || mm.missingVotes;
    if (votesToApply && votesToApply.length && !ignored.has('votes')) {
        const list = Array.isArray(c.votes) ? c.votes.slice() : [];
        const idxByName = new Map();
        for (let i = 0; i < list.length; i++) {
            const n = String(list[i]?.name || '').trim().toUpperCase();
            if (n) idxByName.set(n, i);
        }
        for (const sv of votesToApply) {
            const idx = idxByName.get(sv.name);
            if (idx !== undefined) {
                if (list[idx].vote !== sv.vote) { list[idx].vote = sv.vote; changed = true; }
                if (sv.action && list[idx].action !== sv.action) { list[idx].action = sv.action; changed = true; }
                if (!sv.action && list[idx].action !== undefined) { delete list[idx].action; changed = true; }
                const _reorderedEntry = reorderVote(list[idx]);
                if (Object.keys(_reorderedEntry).join() !== Object.keys(list[idx]).join()) changed = true;
                list[idx] = _reorderedEntry;
            } else {
                const entry = { name: sv.name, vote: sv.vote };
                if (sv.action) entry.action = sv.action;
                list.push(reorderVote(entry));
                idxByName.set(sv.name, list.length - 1);
                changed = true;
            }
        }
        c.votes = list;
    }

    const [maj, minv] = _scdbMajorityCounts(row);
    if (mm.voteMajority !== null && maj  !== null && c.voteMajority !== maj
            && !ignored.has('voteMajority') && !ignored.has('votes')) {
        c.voteMajority = maj; changed = true;
    }
    if (mm.voteMinority !== null && minv !== null && c.voteMinority !== minv
            && !ignored.has('voteMinority') && !ignored.has('votes')) {
        c.voteMinority = minv; changed = true;
    }

    if (!('result' in c)) {
        const pw = String(row.partyWinning ?? '').trim();
        if (pw !== '' && pw.toUpperCase() !== 'NULL') {
            c.result = pw;
            changed = true;
        }
    }

    if (!ignored.has('usCite')) {
        const cur = String(c.usCite || '').trim();
        const scdbCite = _scdbNormalizeCite(row.usCite || '');
        if (!cur && scdbCite) {
            c.usCite = scdbCite;
            changed = true;
            if (!c.decision_loc && !ignored.has('decision_loc')) {
                const [vol, pg] = _scdbParseUsCite(scdbCite);
                const href = _scdbLocOpinionHref(vol, pg);
                if (href) { c.decision_loc = href; }
            }
        }
    }

    // majOpinWriter: mark the majority opinion author with "opinion": true.
    // Row-level majOpinWriter is a justice code; look it up in row.justices
    // to get the full name, then normalise via _scdbJusticesMap to match our
    // c.votes[].name values.
    if (!ignored.has('votes') && Array.isArray(c.votes) && c.votes.length) {
        const writerCode = (row.majOpinWriter || '').trim();
        if (writerCode) {
            const jEntry = (row.justices || []).find(j => (j.justice || '').trim() === writerCode);
            if (jEntry) {
                let writerName = (jEntry.justiceName || '').trim().toUpperCase();
                if (_scdbJusticesMap[writerName]) writerName = _scdbJusticesMap[writerName];
                if (writerName) {
                    const vote = c.votes.find(v => String(v.name || '').trim().toUpperCase() === writerName);
                    if (vote && !vote.opinion) {
                        vote.opinion = true;
                        changed = true;
                    }
                }
            }
        }
    }

    if (changed) {
        const reordered = reorderCase(c);
        for (const k of Object.keys(c)) delete c[k];
        Object.assign(c, reordered);
    }
    return changed;
}

function _scdbLoadLdTitles() {
    const out = {};
    if (!fs.existsSync(_LD_CITES_PATH)) return out;
    const { rows } = _readCsvRows(_LD_CITES_PATH, 'utf8');
    for (const r of rows) {
        const cite  = _scdbNormalizeCite(r.usCite || '');
        const title = (r.caseTitle || '').trim();
        const year  = (r.year || '').trim();
        if (!cite || !title) continue;
        if (!out[cite]) out[cite] = [];
        out[cite].push({ title, year });
    }
    return out;
}

function _scdbLoadLdDatesByCaseId() {
    const out = {};
    if (!fs.existsSync(_LD_DATES_PATH)) return out;
    const { rows } = _readCsvRows(_LD_DATES_PATH, 'utf8');
    for (const r of rows) {
        const cid = (r.caseId || '').trim();
        if (!cid) continue;
        (out[cid] = out[cid] || []).push(r);
    }
    return out;
}

function _scdbSplitCsvDates(raw) {
    const out = [];
    for (const part of (raw || '').split(',')) {
        const d = _scdbNormalizeDate(part);
        if (d && d !== '0' && !out.includes(d)) out.push(d);
    }
    return out;
}
function _scdbArgnum(r) {
    const n = parseInt((r.argumentNumber || '').trim(), 10);
    return Number.isFinite(n) ? n : 1;
}

// Acronyms that must remain ALL-CAPS in title-cased case names.
// Expand this list as new acronyms are encountered in practice.
const _SCDB_TITLE_ACRONYMS = new Set([
    // Federal agencies & regulatory bodies
    'CAA', 'CAB', 'CIA', 'EEOC', 'EPA', 'FAA', 'FBI', 'FCC', 'FDA', 'FDIC',
    'FERC', 'FHA', 'FPC', 'FRB', 'FTC', 'HEW', 'HHS', 'ICC', 'IRS', 'NASA',
    'NLRA', 'NLRB', 'NRSC', 'NSA', 'OSHA', 'SEC', 'SSA', 'TVA', 'VA',
    // Civil-rights & political organizations
    'ACLU', 'NAACP',
    // Labor organizations
    'AFL', 'CIO', 'CWA', 'FEC', 'IBEW', 'ILGWU', 'UAW', 'UMW',
    // Sports / other organizations
    'BNSF', 'PGA',
    // Business / legal abbreviations
    'DBA', 'LLC', 'RICO',
]);

// Articles, conjunctions, and short prepositions that are lowercase in title case
// (except when they are the first word of the title).
const _SCDB_TITLE_LOWERCASE = new Set([
    'and', 'as', 'at', 'but', 'by', 'for',
    'in', 'nor', 'of', 'on', 'or', 'so', 'to', 'up', 'yet',
]);

// Clean a raw SCDB case name for use as a title:
//   - removes all "et al." variants (with optional comma and/or period)
//   - title-cases each word (first letter upper, rest lower)
//   - common articles/conjunctions/prepositions stay lowercase (except first word)
//   - preserves acronyms in _SCDB_TITLE_ACRONYMS as all-caps
//   - preserves tokens that are already entirely lowercase (e.g. "v.", "ex", "rel.")
//   - handles hyphenated words by applying the same rules to each segment
function _scdbCleanTitle(title) {
    if (!title) return title;
    let s = title.replace(/,?\s*\bet\s+al\.?/gi, '').trim().replace(/\s+/g, ' ');
    const tokens = s.split(' ');
    const result = tokens.map((token, i) => {
        const m = token.match(/^([^A-Za-z0-9]*)([A-Za-z0-9][A-Za-z0-9'-]*)([^A-Za-z0-9]*)$/);
        if (!m) return token;
        const [, pre, word, post] = m;
        const cased = word.split('-').map(part => {
            if (_SCDB_TITLE_ACRONYMS.has(part.toUpperCase())) return part.toUpperCase();
            const lower = part.toLowerCase();
            if (lower.startsWith('mc') && lower.length > 2)
                return 'M' + 'c' + part.charAt(2).toUpperCase() + part.slice(3).toLowerCase();
            if (lower.startsWith("o'") && lower.length > 2)
                return "O'" + part.charAt(2).toUpperCase() + part.slice(3).toLowerCase();
            if (part === part.toLowerCase()) return part; // already lowercase (e.g. "v.", "ex")
            if (i > 0 && _SCDB_TITLE_LOWERCASE.has(lower)) return lower;
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }).join('-');
        return pre + cased + post;
    }).join(' ');
    // Capitalize the letter immediately following a Capital+apostrophe pair (e.g. D'Utricht).
    return result.replace(/([A-Z]')([a-z])/g, (_, cap, ch) => cap + ch.toUpperCase());
}

function _scdbBuildCaseFromSources(scdbCase, caseId, ldTitles, ldDates) {
    let usCite     = _scdbNormalizeCite(scdbCase.usCite || '');
    let docket     = (scdbCase.docket || '').trim();
    let argument   = _scdbNormalizeDate(scdbCase.dateArgument || '');
    let reargument = _scdbNormalizeDate(scdbCase.dateRearg || scdbCase.datreRearg || '');
    let decision   = _scdbNormalizeDate(scdbCase.dateDecision || '');
    let title      = (scdbCase.caseName || '').trim() || caseId;

    let ldArgDates = [], ldReargDates = [], ldDecision = '', ldTitle = '', ldUsCite = '', ldDocket = '';
    for (const r of [...ldDates].sort((a, b) => _scdbArgnum(a) - _scdbArgnum(b))) {
        if (!ldTitle)   ldTitle   = (r.caseTitle || '').trim();
        if (!ldUsCite)  ldUsCite  = _scdbNormalizeCite(r.usCite || '');
        if (!ldDocket)  ldDocket  = (r.docket || '').trim();
        if (!ldDecision) {
            const cand = _scdbNormalizeDate(r.dateDecision || '');
            if (cand && cand !== '0') ldDecision = cand;
        }
        const argDates = _scdbSplitCsvDates(r.dateArgument || '');
        if (!argDates.length) continue;
        const target = _scdbArgnum(r) <= 1 ? ldArgDates : ldReargDates;
        for (const d of argDates) if (!target.includes(d)) target.push(d);
    }

    if (!usCite && ldUsCite) usCite = ldUsCite;
    if ((!docket || docket === '0') && ldDocket && ldDocket !== '0') docket = ldDocket;

    if (usCite && ldTitles[usCite]) {
        const decYear = decision.slice(0, 4);
        const entries = ldTitles[usCite];
        const yearMatches = entries.filter(e => e.year === decYear);
        const candidates = yearMatches.length ? yearMatches : entries;
        if (candidates.length === 1) {
            title = candidates[0].title;
        } else if (ldTitle) {
            // Multiple cases share this cite — use the caseId-keyed ldTitle instead
            title = ldTitle;
        } else {
            title = candidates[0].title;
        }
    } else if (ldTitle) title = ldTitle;
    title = _scdbCleanTitle(title);

    if (ldArgDates.length) {
        const ldArg = ldArgDates.join(',');
        if (_scdbSplitCsvDates(ldArg).length >= _scdbSplitCsvDates(argument).length) argument = ldArg;
    }
    if (ldReargDates.length) {
        const ldRe = ldReargDates.join(',');
        if (_scdbSplitCsvDates(ldRe).length >= _scdbSplitCsvDates(reargument).length) reargument = ldRe;
    }
    if (ldDecision) decision = ldDecision;

    const [maj, minv] = _scdbMajorityCounts(scdbCase);
    const votes = _scdbVotesSubset(scdbCase);

    const obj = { id: caseId, title, files: false, votes };
    if (docket && docket !== '0')     obj.number = _scdbNormalizeDocket(docket);
    if (argument && argument !== '0') obj.argument = argument;
    if (reargument && reargument !== '0') obj.reargument = reargument;
    if (decision && decision !== '0') {
        obj.decision = decision;
    }
    if (maj  !== null) obj.voteMajority = maj;
    if (minv !== null) obj.voteMinority = minv;
    if (usCite) {
        obj.usCite = usCite;
        const [volume, page] = _scdbParseUsCite(usCite);
        const href = _scdbLocOpinionHref(volume, page);
        if (href)   obj.decision_loc = href;
    }
    return reorderCase(obj);
}

// Renders one "Cases Not Included from SCDB" list entry: title (re-capitalized
// by _scdbCleanTitle inside _scdbBuildCaseFromSources), docket number(s) in
// parens, then citation — e.g. "Smith v. Jones (No. 12-345), 400 U.S. 100 (1971)".
// Matches the "No./Nos." + raw-comma docket convention used for case listings
// elsewhere (see explorer.js's case-title-nav rendering).
function _scdbNotIncludedLine(c) {
    let line = c.title || c.id;
    if (c.number) {
        const label = c.number.includes(',') ? 'Nos.' : 'No.';
        line += ` (${label} ${c.number.replace(/-(?=Orig|Misc)/gi, ' ')})`;
    }
    if (c.usCite) {
        const year = (c.decision || '').slice(0, 4);
        line += `, ${c.usCite}${year ? ` (${year})` : ''}`;
    }
    return line;
}

// Regenerates courts/ussc/collections/scdb/index.md's case list from scratch —
// front matter (title/layout) is preserved as-is; only the body is replaced.
// `cases` is the list of built case objects for every SCDB caseId (argued or
// not) with no corresponding entry anywhere in courts/ussc/terms/*/cases.json
// (see the `notIncluded` collection param on _scdbVerifyTerms).
function _writeScdbNotIncludedPage(cases) {
    let existing = '';
    try { existing = fs.readFileSync(_SCDB_NOT_INCLUDED_PAGE, 'utf8'); } catch { /* use default below */ }
    const fmMatch = existing.match(/^(---\n[\s\S]*?\n---\n)/);
    const frontMatter = fmMatch ? fmMatch[1] : '---\nlayout: pane\ntitle: "Cases Not Included from SCDB"\n---\n';

    const lines = cases.map(c => `  - ${_scdbNotIncludedLine(c)}`);
    const body = [
        '',
        '# Cases Not Included from SCDB',
        '',
        `The [Supreme Court Database](https://scdb.la.psu.edu) (SCDB) includes ${cases.length.toLocaleString()} case(s) not yet present in Argument Aloud's own records:`,
        '',
        ...lines,
        '',
    ].join('\n');

    const text = frontMatter + body;
    if (existing === text) return;
    fs.writeFileSync(_SCDB_NOT_INCLUDED_PAGE, text, 'utf8');
    console.log(`Wrote ${cases.length} case(s) to ${path.relative(REPO_ROOT, _SCDB_NOT_INCLUDED_PAGE)}`);
}

function _scdbFirstArgDate(c) {
    const raw = (c.argument || '').trim();
    if (!raw) return '';
    return _scdbNormalizeDate(raw.split(',', 1)[0]);
}

function _scdbMergeMissing(existing, template) {
    let changed = false;
    for (const [k, v] of Object.entries(template)) {
        if (_scdbFieldPresent(existing, k)) continue;
        existing[k] = v;
        changed = true;
    }
    if (changed) {
        const re = reorderCase({ ...existing });
        for (const k of Object.keys(existing)) delete existing[k];
        Object.assign(existing, re);
    }
    return changed;
}

function _scdbAddCaseToTerm(scdb, termYear, caseId) {
    if (!/^\d{4}$/.test(termYear)) {
        console.error(`ERROR: --term expects YYYY, got ${JSON.stringify(termYear)}`);
        process.exit(1);
    }
    const casesPath = path.join(_SCDB_TERMS_DIR, `${termYear}-10`, 'cases.json');
    if (!fs.existsSync(casesPath)) {
        console.error(`ERROR: term cases file not found: ${casesPath}`);
        process.exit(1);
    }
    if (!scdb[caseId]) {
        console.error(`ERROR: caseId ${JSON.stringify(caseId)} not found in loaded SCDB data`);
        process.exit(1);
    }
    let cases;
    try { cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')); }
    catch (e) { console.error(`ERROR: Could not parse ${casesPath}: ${e.message}`); process.exit(1); }

    const ldTitles = _scdbLoadLdTitles();
    const ldDates  = _scdbLoadLdDatesByCaseId();
    const newCase  = _scdbBuildCaseFromSources(scdb[caseId], caseId, ldTitles, ldDates[caseId] || []);

    const existing = cases.find(c => (c.id || '').trim() === caseId);
    if (existing) {
        if (_scdbMergeMissing(existing, newCase)) {
            fs.writeFileSync(casesPath, JSON.stringify(cases, null, 2) + '\n', 'utf8');
            console.log(`Enriched existing ${caseId} in ${path.relative(REPO_ROOT, casesPath)}`);
            console.log(JSON.stringify(existing, null, 2));
        } else {
            console.log(`No change: ${caseId} already exists in ${path.relative(REPO_ROOT, casesPath)}`);
        }
        return;
    }

    const number = (newCase.number || '').trim();
    if (number && cases.some(c => (c.number || '').trim() === number)) {
        console.log(`No change: docket ${number} already exists in ${path.relative(REPO_ROOT, casesPath)} (new id would be ${caseId}).`);
        return;
    }

    const newArg = _scdbFirstArgDate(newCase);
    let insertAt = cases.length;
    if (newArg) {
        for (let i = 0; i < cases.length; i++) {
            const cur = _scdbFirstArgDate(cases[i]);
            if (cur && cur > newArg) { insertAt = i; break; }
        }
    }
    cases.splice(insertAt, 0, newCase);
    fs.writeFileSync(casesPath, JSON.stringify(cases, null, 2) + '\n', 'utf8');
    console.log(`Added ${caseId} to ${path.relative(REPO_ROOT, casesPath)}`);
    console.log(JSON.stringify(newCase, null, 2));
}

// `notIncluded`, when passed an array, is appended with the built case object
// for every unmatched-SCDB-case entry found across the run (see
// _writeScdbNotIncludedPage) — used for a read-only, all-terms harvest pass
// that never touches cases.json/corrections.json regardless of `update`.
function _scdbVerifyTerms(scdb, termFilter, caseFilter, update, verbose, debug, backfill, all, notIncluded) {
    let cases_files;
    if (termFilter) {
        const p = path.join(_SCDB_TERMS_DIR, termFilter, 'cases.json');
        if (!fs.existsSync(p)) {
            console.error(`ERROR: term cases file not found: ${p}`);
            process.exit(1);
        }
        cases_files = [p];
    } else {
        cases_files = [];
        for (const d of fs.readdirSync(_SCDB_TERMS_DIR).sort()) {
            const p = path.join(_SCDB_TERMS_DIR, d, 'cases.json');
            if (fs.existsSync(p)) cases_files.push(p);
        }
        if (!cases_files.length) console.log(`WARNING: No cases.json files found under ${_SCDB_TERMS_DIR}`);
    }

    let total = 0, skipped = 0, updates = 0;
    const errors = [];

    // Load corrections.json (skip set + prior entries to extend). Every
    // --scdb run refreshes date-correction entries for cases that currently
    // carry a scdb_check value; existing keys (esp. "skip"/"note") are
    // preserved and merged onto, never wholesale replaced or dropped.
    let correctionsMap = {};
    if (fs.existsSync(_SCDB_CORRECTIONS_PATH)) {
        try {
            correctionsMap = JSON.parse(fs.readFileSync(_SCDB_CORRECTIONS_PATH, 'utf8'));
        } catch (e) {
            console.log(`WARNING: could not read ${path.relative(REPO_ROOT, _SCDB_CORRECTIONS_PATH)}: ${e.message}`);
        }
    }
    const scdbSkipSet = new Set(Object.keys(correctionsMap).filter(k => correctionsMap[k].skip));
    const correctionsAccum = {};
    // Every caseId actually processed this run gets its date-correction fields
    // fully recomputed (and pruned if no longer a real mismatch); caseIds
    // outside the current term/case filter are left untouched in correctionsMap.
    const visitedCids = new Set();

    const ldTitles   = backfill ? _scdbLoadLdTitles()       : {};
    const ldDatesAll = backfill ? _scdbLoadLdDatesByCaseId() : {};

    let backfillDatesMap = null;
    if (backfill) {
        try { backfillDatesMap = _loadDatesCsv(); }
        catch (e) { console.log(`WARNING: could not load dates.csv for backfill date checks: ${e.message}`); }
    }

    // Pre-build a global set of every SCDB case id already tracked in ANY term
    // directory so backfill never re-adds a case that lives in a different term
    // (e.g. special terms like 1958-08 share the same year prefix as 1958-10).
    const allTrackedIds = new Set();
    if (backfill) {
        for (const d of fs.readdirSync(_SCDB_TERMS_DIR).sort()) {
            const p = path.join(_SCDB_TERMS_DIR, d, 'cases.json');
            if (!fs.existsSync(p)) continue;
            try {
                const cs = JSON.parse(fs.readFileSync(p, 'utf8'));
                for (const c of cs) if (c.id) allTrackedIds.add(c.id);
            } catch { /* ignore parse errors — they'll be caught per-term below */ }
        }
    }

    for (const cf of cases_files) {
        const term = path.basename(path.dirname(cf));
        let cases;
        try { cases = JSON.parse(fs.readFileSync(cf, 'utf8')); }
        catch (e) { errors.push(`[${term}] Could not parse ${cf}: ${e.message}`); continue; }

        let termChanged = false;

        // Build per-term SCDB lookup tables for matching cases that don't yet
        // have a c.id (e.g. recently imported terms).
        const termYear  = (term.match(/^(\d{4})/)      || [])[1] || '';
        const termMonth = (term.match(/^\d{4}-(\d{2})$/) || [])[1] || '';
        const scdbByCite       = new Map(); // normalized usCite -> caseId | null(=ambiguous)
        const scdbByDocketDate = new Map(); // "docket\u0000YYYY-MM-DD" -> caseId | null
        const scdbByDocket     = new Map(); // docket -> caseId | null
        const scdbByTitle      = new Map(); // squashed title -> caseId | null
        const scdbByDate       = new Map(); // YYYY-MM-DD -> [{ id, title, tokens:Set }, …]
        const scdbTermIds      = new Set(); // all caseIds in this term
        const splitDocket = (s) => String(s || '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
        const squashTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const STOPWORDS = new Set(['v','vs','et','al','the','of','a','an','and','co','company','inc','corp','corporation','llc','ltd','no']);
        const tokenize = (s) => {
            const out = new Set();
            for (const w of squashTitle(s).split(/\s+/)) {
                if (!w || STOPWORDS.has(w)) continue;
                out.add(w);
            }
            return out;
        };
        // Split a title into petitioner/respondent halves (around " v "/" vs ")
        // and tokenize each. Falls back to a single bag if no separator.
        const sidesOf = (s) => {
            const sq = ' ' + squashTitle(s) + ' ';
            const m = sq.match(/^(.*?)\s+(?:v|vs)\s+(.*)$/);
            if (m) return { left: tokenize(m[1]), right: tokenize(m[2]), both: tokenize(s) };
            return { left: new Set(), right: new Set(), both: tokenize(s) };
        };
        const jaccard = (a, b) => {
            if (!a.size && !b.size) return 0;
            let inter = 0;
            for (const w of a) if (b.has(w)) inter++;
            const union = a.size + b.size - inter;
            return union ? inter / union : 0;
        };
        if (termYear) {
            for (const [k, r] of Object.entries(scdb)) {
                if (!k.startsWith(`${termYear}-`)) continue;
                scdbTermIds.add(k);
                const cite = _scdbNormalizeCite(r.usCite || '');
                if (cite) {
                    if (scdbByCite.has(cite)) scdbByCite.set(cite, null);
                    else scdbByCite.set(cite, k);
                }
                const dec = _scdbNormalizeDate(r.dateDecision || '');
                for (const d of splitDocket(r.docket)) {
                    if (scdbByDocket.has(d)) scdbByDocket.set(d, null);
                    else scdbByDocket.set(d, k);
                    if (dec) {
                        const dk = `${d}\u0000${dec}`;
                        if (scdbByDocketDate.has(dk)) scdbByDocketDate.set(dk, null);
                        else scdbByDocketDate.set(dk, k);
                    }
                }
                const t = squashTitle(r.caseName);
                if (t) {
                    if (scdbByTitle.has(t)) scdbByTitle.set(t, null);
                    else scdbByTitle.set(t, k);
                }
                if (dec) {
                    if (!scdbByDate.has(dec)) scdbByDate.set(dec, []);
                    scdbByDate.get(dec).push({ id: k, title: r.caseName || '', sides: sidesOf(r.caseName) });
                }
            }
        }

        const matchedFromOurs = new Set();   // SCDB ids matched to one of our cases
        const matchInfo = [];                // {title, cid, how}
        const unmatchedOurs = [];            // titles of our cases that couldn't match

        for (const c of cases) {
            let cid = c.id;
            let matchHow = '';
            // A case can pick up an `id` some other way (e.g. a manual --votes edit)
            // without ever passing through the "matched" branch below that clears
            // this note -- so check it here too, regardless of how cid was set.
            if (cid && update && _removeAuditMessage(c, SCDB_MISSING_MESSAGE)) termChanged = true;
            if (!cid) {
                const cite = _scdbNormalizeCite(c.usCite || '');
                let cand = cite ? scdbByCite.get(cite) : null;
                if (cand) matchHow = 'usCite';
                if (!cand) {
                    const decIso = _scdbNormalizeDate(c.decision || '');
                    for (const d of splitDocket(c.number)) {
                        const got = decIso ? scdbByDocketDate.get(`${d}\u0000${decIso}`) : null;
                        if (got) { cand = got; matchHow = 'docket+decision'; break; }
                    }
                }
                if (!cand) {
                    for (const d of splitDocket(c.number)) {
                        const got = scdbByDocket.get(d);
                        if (got) { cand = got; matchHow = 'docket'; break; }
                    }
                }
                if (!cand) {
                    const t = squashTitle(firstTitle(c.title));
                    const got = t ? scdbByTitle.get(t) : null;
                    if (got) { cand = got; matchHow = 'title'; }
                }
                if (!cand) {
                    // Fuzzy fallback: among SCDB cases with the same decision
                    // date, pick one whose title is similar to ours, scoring
                    // petitioner and respondent halves separately so that
                    // "X v Y" doesn't tie with "Y v X".
                    const decIso = _scdbNormalizeDate(c.decision || '');
                    const candidates = decIso ? scdbByDate.get(decIso) : null;
                    if (candidates && candidates.length) {
                        const ours = sidesOf(firstTitle(c.title));
                        if (ours.both.size) {
                            let best = null, bestScore = 0, secondScore = 0;
                            for (const ent of candidates) {
                                let score;
                                if (ours.left.size && ent.sides.left.size) {
                                    const ls = jaccard(ours.left, ent.sides.left);
                                    const rs = jaccard(ours.right, ent.sides.right);
                                    score = (ls + rs) / 2;
                                } else {
                                    score = jaccard(ours.both, ent.sides.both);
                                }
                                if (score > bestScore) {
                                    secondScore = bestScore;
                                    bestScore = score; best = ent;
                                } else if (score > secondScore) {
                                    secondScore = score;
                                }
                            }
                            if (best && bestScore >= 0.6 && bestScore - secondScore >= 0.15) {
                                cand = best.id;
                                matchHow = `date+title~${bestScore.toFixed(2)}`;
                            }
                        }
                    }
                }
                if (!cand) {
                    const errs = String(c.scdb_check || '').split(',').map(s => s.trim());
                    if (!c.disposition && !errs.includes('missing')) {
                        const label = firstTitle(c.title) || '(untitled)';
                        const arg = Array.isArray(c.argument) ? c.argument[0] : c.argument;
                        const dec = c.decision || '';
                        const dates = [];
                        if (arg) dates.push(`argued ${arg}`);
                        if (dec) dates.push(`decided ${dec}`);
                        const datesStr = dates.length ? ` (${dates.join(', ')})` : '';
                        unmatchedOurs.push(`WARNING: ${term}/${c.number || '?'}: ${label}${datesStr}: no SCDB match`);
                    }
                    if (update && _addAuditMessage(c, SCDB_MISSING_MESSAGE)) {
                        const reordered = reorderCase(c);
                        for (const k of Object.keys(c)) delete c[k];
                        Object.assign(c, reordered);
                        termChanged = true;
                    }
                    skipped++;
                    continue;
                }
                cid = cand;
                if (update) {
                    c.id = cid;
                    _removeAuditMessage(c, SCDB_MISSING_MESSAGE);
                    const reordered = reorderCase(c);
                    for (const k of Object.keys(c)) delete c[k];
                    Object.assign(c, reordered);
                    termChanged = true;
                }
            }
            if (caseFilter) {
                const dockets = (c.number || '').split(',').map(s => s.trim());
                if (cid !== caseFilter && c.id !== caseFilter && !dockets.includes(caseFilter)) continue;
            }
            matchedFromOurs.add(cid);
            if (scdbSkipSet.has(cid)) { skipped++; continue; }
            if (matchHow) matchInfo.push({ title: firstTitle(c.title) || cid, cid, how: matchHow });
            total++;
            const prefix = `${term}/${cid} (${firstTitle(c.title) || cid})`;
            const noVoteData = (c.voteMajority === undefined &&
                                c.voteMinority === undefined &&
                                (!Array.isArray(c.votes) || c.votes.length === 0));

            const row = scdb[cid];
            if (!row) { errors.push(`${prefix}: caseId not found in SCDB`); continue; }
            visitedCids.add(cid);

            const caseErrors = [];
            const ignored = new Set(
                String(c.scdb_check || '')
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean)
            );
            const pushErr = (field, msg) => {
                if (ignored.has(field)) return;
                if (verbose) msg += `\n${' '.repeat(21)}${c.decision_loc || c.decision_ussc || ''}\n`;
                caseErrors.push(msg);
            };

            // Preliminary tenure precheck: every justice in c.votes must have
            // been serving on c.decision date.
            const decIso = _scdbNormalizeDate(c.decision || '');
            if (decIso && Array.isArray(c.votes)) {
                for (const v of c.votes) {
                    if (!v || !v.name) continue;
                    let nm = String(v.name).trim().toUpperCase();
                    if (_scdbJusticesMap[nm]) nm = _scdbJusticesMap[nm];
                    const ten = _scdbJusticesTenures[nm];
                    if (!ten) continue;
                    const ok = ten.some(t =>
                        (!t.start || decIso >= t.start) &&
                        (!t.stop  || decIso <= t.stop));
                    if (!ok && verbose) {
                        const ranges = ten.map(t => `${t.start || '?'}–${t.stop || 'present'}`).join(', ');
                        caseErrors.push(`${prefix}: justice "${v.name}" not serving on decision ${decIso} (tenure(s): ${ranges})`);
                    }
                }
            }

            const mm = { decision: false, argument: false, reargument: false,
                         voteMajority: null, voteMinority: null, missingVotes: [], scdbVotes: null };

            // A comma-separated (multi-day) value flags its field regardless of
            // whether SCDB's single date matches one of ours — SCDB's schema
            // can never record more than one date, so it's always "incomplete"
            // relative to ours. See _scdbApplyXUpdate/_scdbBuildMessage.
            const argIncomplete   = String(c.argument   || '').includes(',');
            const reargIncomplete = String(c.reargument || '').includes(',');

            const scdbArg = _scdbNormalizeDate(row.dateArgument || '');
            if (!scdbArg) {
                // A blank SCDB value only counts as a problem when we actually
                // claim an argument date ourselves — most cases correctly have
                // no reargument date on *either* side, which must stay a match,
                // not a false "missing" flag.
                if (String(c.argument || '').trim()) {
                    mm.argument = true;
                    pushErr('argument', `${prefix}: dateArgument missing from SCDB (ours=${JSON.stringify(c.argument)})`);
                }
            } else if (!_scdbContainsDate(c.argument, scdbArg)) {
                mm.argument = true;
                pushErr('argument', `${prefix}: dateArgument not contained by argument: scdb=${JSON.stringify(scdbArg)} ours=${JSON.stringify(c.argument)}`);
            }

            const scdbRe = _scdbNormalizeDate(row.dateRearg || row.datreRearg || '');
            if (!scdbRe) {
                if (String(c.reargument || '').trim()) {
                    mm.reargument = true;
                    pushErr('reargument', `${prefix}: dateRearg missing from SCDB (ours=${JSON.stringify(c.reargument)})`);
                }
            } else if (!_scdbContainsDate(c.reargument, scdbRe)) {
                mm.reargument = true;
                pushErr('reargument', `${prefix}: dateRearg not contained by reargument: scdb=${JSON.stringify(scdbRe)} ours=${JSON.stringify(c.reargument)}`);
            }

            const scdbDec = _scdbNormalizeDate(row.dateDecision || '');
            const ourDec  = _scdbNormalizeDate(c.decision || '');
            if (scdbDec && ourDec && scdbDec !== ourDec) {
                mm.decision = true;
                pushErr('decision', `${prefix}: decision mismatch: ours=${JSON.stringify(ourDec)} scdb=${JSON.stringify(scdbDec)}`);
            }

            // Recompute this case's correction entry from scratch every run,
            // using strict equality — SCDB never stores more than one date per
            // field, so a comma-separated multi-day value on our side can
            // never truly equal it. A field is only included when it's a
            // genuine, current mismatch; correctionsAccum[cid] is always set
            // (possibly {}) so the merge step below can prune stale entries.
            {
                // Union of any field already flagged from a prior run and any
                // field mm.* just detected as a fresh mismatch this run —
                // using c.scdb_check alone would miss a brand-new
                // mismatch here, since _scdbApplyXUpdate() (which is what
                // actually sets scdb_check on the case) hasn't run yet
                // at this point in the loop, and doesn't run at all under
                // --dry-run. Without the union, a newly-introduced mismatch
                // would need two full --scdb runs before its detail ever
                // reached corrections.json: one to flag the case, another to
                // notice it was flagged.
                const errorFields = c.scdb_check
                    ? new Set(String(c.scdb_check).split(',').map(s => s.trim()).filter(Boolean))
                    : new Set();
                if (mm.argument   || argIncomplete)   errorFields.add('argument');
                if (mm.reargument || reargIncomplete) errorFields.add('reargument');
                if (mm.decision)                      errorFields.add('decision');
                const entry = {};
                if (errorFields.has('argument')) {
                    const ourArg = Array.isArray(c.argument) ? c.argument.join(', ') : (c.argument || '');
                    if (_scdbNormalizeDate(ourArg.trim()) !== scdbArg) entry.dateArgument = `${scdbArg} -> ${ourArg}`;
                }
                if (errorFields.has('reargument')) {
                    const ourRe = Array.isArray(c.reargument) ? c.reargument.join(', ') : (c.reargument || '');
                    if (_scdbNormalizeDate(ourRe.trim()) !== scdbRe) entry.dateRearg = `${scdbRe} -> ${ourRe}`;
                }
                if (errorFields.has('decision') && ourDec !== scdbDec) {
                    entry.dateDecision = `${scdbDec} -> ${ourDec}`;
                }
                correctionsAccum[cid] = entry;
            }

            if (_scdbHasImportedOpinion(c) || noVoteData) {
                const [maj, minv] = _scdbMajorityCounts(row);
                if (noVoteData) {
                    if (maj !== null) mm.voteMajority = maj;
                    if (minv !== null) mm.voteMinority = minv;
                    const sVall = _scdbVotesSubset(row);
                    if (sVall.length) { mm.missingVotes = sVall; mm.scdbVotes = sVall; }
                    if (maj !== null || minv !== null || sVall.length) {
                        pushErr('votes', `${prefix}: missing vote data`);
                    }
                } else {
                if (maj  !== null && c.voteMajority !== maj) {
                    mm.voteMajority = maj;
                    pushErr('voteMajority', `${prefix}: voteMajority mismatch: ours=${JSON.stringify(c.voteMajority)} scdb=${JSON.stringify(maj)}`);
                }
                if (minv !== null && c.voteMinority !== minv) {
                    mm.voteMinority = minv;
                    pushErr('voteMinority', `${prefix}: voteMinority mismatch: ours=${JSON.stringify(c.voteMinority)} scdb=${JSON.stringify(minv)}`);
                }

                const sV = _scdbVotesSubset(row);
                // Always store sV so _scdbApplyXUpdate can reconcile action values
                // even when vote values already match.
                if (sV.length) mm.scdbVotes = sV;
                let oV = _scdbOurVotesSubset(c);
                // If SCDB explicitly lists a justice on the case but with no
                // participating vote, treat them as non-participating and drop
                // any matching entry from our side rather than flagging it.
                const scdbAll  = _scdbAllJusticeNames(row);
                const scdbVoted = new Set(sV.map(v => v.name));
                oV = oV.filter(v => !(scdbAll.has(v.name) && !scdbVoted.has(v.name)));
                if (sV.length && !_scdbVotesEqual(_scdbVotesSorted(oV), _scdbVotesSorted(sV))) {
                    const oNames = new Set(oV.map(v => v.name));
                    mm.missingVotes = sV.filter(v => !oNames.has(v.name));
                    let msg = `${prefix}: votes subset mismatch (name+vote).`;
                    if (verbose) {
                        const sSet = new Set(sV.map(v => `${v.name}\u0000${v.vote}`));
                        const oSet = new Set(oV.map(v => `${v.name}\u0000${v.vote}`));
                        const onlyScdb = [...sSet].filter(x => !oSet.has(x)).sort();
                        const onlyOurs = [...oSet].filter(x => !sSet.has(x)).sort();
                        const lines = [msg];
                        for (const x of onlyScdb) { const [n, v] = x.split('\u0000'); lines.push(`      scdb only:  ${n} / ${v}`); }
                        for (const x of onlyOurs) { const [n, v] = x.split('\u0000'); lines.push(`      ours only:  ${n} / ${v}`); }
                        msg = lines.join('\n');
                    }
                    pushErr('votes', msg);
                }
                }
            }

            if (caseErrors.length) {
                for (const e of caseErrors) errors.push(e);
                if (debug) {
                    console.log(`\n${prefix}: mismatch detail`);
                    console.log(`  ours:  ${JSON.stringify(c, null, 2).split('\n').join('\n  ')}`);
                    console.log(`  scdb:  ${JSON.stringify(row, null, 2).split('\n').join('\n  ')}`);
                }
            }

            if (update) {
                if (_scdbApplyXUpdate(c, row, mm)) { updates++; termChanged = true; }
            }
        }

        // Verify each case's votes array is in seniority order: chief justice
        // first, then associates by ascending dateStart. Re-sort if --update.
        const resorted = verifyVoteSeniority(term, cases, update);
        if (resorted) termChanged = true;

        // Verify cases array is sorted consistently with sortCases() — by last
        // argument date (max of argument/reargument), then first docket number.
        // Delegate to sortCases() directly so the key is always in sync.
        if (update) {
            if (sortCases(term, cases, false)) termChanged = true;
        } else {
            // Check-only: sort a shallow copy to detect order change without mutating.
            const copy = [...cases];
            if (sortCases(term, copy, false)) {
                errors.push(`${term}/cases.json: cases not in ascending argument-date order`);
            }
        }

        if (matchInfo.length) {
            const verb = update ? 'matched & assigned id' : 'could be matched';
            console.log(`[${term}] ${matchInfo.length} case(s) ${verb}:`);
            for (const m of matchInfo) console.log(`  ${m.cid}  via ${m.how}  — ${m.title}`);
        }
        if (unmatchedOurs.length) {
            for (const t of unmatchedOurs) console.log(t);
        }
        if (scdbTermIds.size && backfill) {
            // Collect every docket token from our existing cases in this term
            // so we can skip SCDB cases whose number is already represented.
            const ourDockets = new Set();
            for (const c of cases) {
                for (const d of splitDocket(c.number)) ourDockets.add(d);
            }
            const unmatchedScdb = [...scdbTermIds]
                .filter(k => !matchedFromOurs.has(k))
                .filter(k => !allTrackedIds.has(k))
                .filter(k => !scdbSkipSet.has(k))
                .filter(k => {
                    if (all) return true;
                    const r = scdb[k];
                    return (r.dateArgument || r.dateRearg || r.datreRearg);
                })
                .filter(k => {
                    // For special (non-October) terms, only include cases whose effective
                    // date falls within [YYYY-MM-01, YYYY-10-01). Effective date is the
                    // earliest argument date if the case was argued, otherwise the decision
                    // date. Cases with no usable date are excluded.
                    if (!termMonth || termMonth === '10') return true;
                    const r = scdb[k];
                    const argDate = _scdbNormalizeDate(r.dateArgument || r.dateRearg || r.datreRearg || '');
                    const decDate = _scdbNormalizeDate(r.dateDecision || '');
                    const effectiveDate = argDate || decDate;
                    if (!effectiveDate) return false;
                    const termStart = `${termYear}-${termMonth}-01`;
                    const termEnd   = `${termYear}-10-01`;
                    return effectiveDate >= termStart && effectiveDate < termEnd;
                })
                .filter(k => {
                    const r = scdb[k];
                    const normalizedDocket = _scdbNormalizeDocket((r.docket || '').trim());
                    return !splitDocket(normalizedDocket).some(d => ourDockets.has(d));
                })
                .sort();
            if (unmatchedScdb.length) {
                const verb = update ? 'adding' : 'would add';
                console.log(`[${term}] ${unmatchedScdb.length} SCDB case(s) ${verb} (missing from cases.json):`);
                for (const k of unmatchedScdb) {
                    let built = _scdbBuildCaseFromSources(scdb[k], k, ldTitles, ldDatesAll[k] || []);
                    // Check built dates against dates.csv (scotus source) and record/apply any differences.
                    if (backfillDatesMap && backfillDatesMap.has(k)) {
                        const csv = backfillDatesMap.get(k);
                        const errFields = [];
                        const errEntry = correctionsAccum[k] ? { ...correctionsAccum[k] } : {};

                        const csvDec = _scdbNormalizeDate(csv.dateDecision || '');
                        if (csvDec && built.decision && csvDec !== built.decision) {
                            errEntry.dateDecision = `${built.decision} -> ${csvDec}`;
                            errFields.push('decision');
                            built = reorderCase(Object.assign({}, built, { decision: csvDec }));
                        }

                        const csvArgDates = (csv.dateArguments || []).slice().sort();
                        const builtArgDates = _scdbSplitCsvDates(built.argument || '').sort();
                        if (csvArgDates.length && (
                            csvArgDates.length !== builtArgDates.length ||
                            csvArgDates.some((d, i) => d !== builtArgDates[i])
                        )) {
                            errEntry.dateArgument = `${built.argument || ''} -> ${csvArgDates.join(',')}`;
                            errFields.push('argument');
                            built = reorderCase(Object.assign({}, built, { argument: csvArgDates.join(',') }));
                        }

                        if (errFields.length) {
                            const existingErrs = String(built.scdb_check || '').split(',').map(s => s.trim()).filter(Boolean);
                            const combined = [...new Set([...existingErrs, ...errFields])].join(',');
                            built = reorderCase(Object.assign({}, built, { scdb_check: combined }));
                            correctionsAccum[k] = errEntry;
                        }
                    }
                    const dateStr = [built.argument, built.reargument].filter(Boolean).join(' / rearg: ');
                    console.log(`  ${k}  ${built.number || ''}  ${dateStr || built.decision || ''}  ${built.title || ''}`);
                    if (update) cases.push(built);
                    if (notIncluded) notIncluded.push(built);
                }
                if (update) {
                    sortCases(term, cases, false);
                    termChanged = true;
                }
            }
        }

        if (termChanged) {
            fs.writeFileSync(cf, JSON.stringify(cases, null, 2) + '\n', 'utf8');
            console.log(`Updated ${path.relative(REPO_ROOT, cf)}`);
        }
    }

    console.log(`Checked ${total} cases with SCDB ids (${skipped} cases skipped — no id).`);
    if (update) console.log(`Applied SCDB opinion metadata updates to ${updates} case(s).`);

    if (visitedCids.size) {
        // For every caseId actually processed this run: keep skip/note as-is
        // (never touched), replace any date-correction fields with the freshly
        // computed set (dropping ones that no longer represent a real
        // mismatch), and drop the entry entirely if nothing is left. CaseIds
        // outside this run's term/case filter are left completely untouched.
        for (const cid of visitedCids) {
            const existing = correctionsMap[cid];
            const fresh = correctionsAccum[cid] || {};
            if (existing && existing.skip) {
                correctionsMap[cid] = { skip: true, note: existing.note, ...fresh };
            } else if (Object.keys(fresh).length) {
                correctionsMap[cid] = fresh;
            } else if (existing) {
                delete correctionsMap[cid];
            }
        }
        const sorted = {};
        for (const k of Object.keys(correctionsMap).sort()) sorted[k] = correctionsMap[k];
        if (update) {
            const dir = path.dirname(_SCDB_CORRECTIONS_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(_SCDB_CORRECTIONS_PATH, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
            console.log(`Updated ${Object.keys(sorted).length} entries in ${path.relative(REPO_ROOT, _SCDB_CORRECTIONS_PATH)}.`);
        } else {
            console.log(`[dry-run] Would update ${Object.keys(sorted).length} entries in ${path.relative(REPO_ROOT, _SCDB_CORRECTIONS_PATH)}.`);
        }
    }

    if (errors.length) {
        console.log(`\n${errors.length} issue(s) found:\n`);
        for (const e of errors) console.log(`  ${e}`);
    } else {
        console.log('All checks passed.');
    }
}


function _scdbPrintCase(scdb, caseId) {
    const c = scdb[caseId];
    if (!c) { console.log(`caseId ${JSON.stringify(caseId)} not found in loaded SCDB data.`); return; }
    console.log(JSON.stringify(c, null, 2));
}

async function runScdb(opts) {
    // 1) First, migrate/condense any newly-downloaded SCDB CSVs.
    processScdbDownloads(opts.verbose);

    // 2) Load combined SCDB table — use cache when fresh.
    const scdb = {};
    const normIssues = new Set();
    const unmappedFields = new Map();
    let usedCache = false;

    if (fs.existsSync(_SCDB_CACHE_PATH) &&
        !opts.noCache &&
        fs.existsSync(_SCDB_MODERN_CSV) &&
        fs.existsSync(_SCDB_LEGACY_CSV)) {
        const cacheMtime  = fs.statSync(_SCDB_CACHE_PATH).mtimeMs;
        const modernMtime = fs.statSync(_SCDB_MODERN_CSV).mtimeMs;
        const legacyMtime = fs.statSync(_SCDB_LEGACY_CSV).mtimeMs;
        const varsMtime   = fs.existsSync(_SCDB_VARS_PATH) ? fs.statSync(_SCDB_VARS_PATH).mtimeMs : 0;
        if (cacheMtime >= modernMtime && cacheMtime >= legacyMtime && cacheMtime >= varsMtime) {
            try {
                const cached = JSON.parse(fs.readFileSync(_SCDB_CACHE_PATH, 'utf8'));
                Object.assign(scdb, cached);
                usedCache = true;
                if (opts.verbose) console.log(`Loaded SCDB cache (${Object.keys(scdb).length.toLocaleString()} cases) from ${path.relative(REPO_ROOT, _SCDB_CACHE_PATH)}.`);
            } catch (e) {
                console.log(`WARNING: failed to read SCDB cache (${e.message}); rebuilding.`);
            }
        }
    }

    _scdbJusticesMap = _scdbLoadJusticesMap();
    _scdbJusticesTenures = _scdbLoadJusticesTenures();
    if (Object.keys(_scdbJusticesMap).length) {
        if (opts.verbose) console.log(`Loaded justices.json (${Object.keys(_scdbJusticesMap).length} name entries, ${Object.keys(_scdbJusticesTenures).length} with tenures).`);
    } else console.log('WARNING: justices.json not found — justice names not normalized.');

    if (!usedCache) {
        const { map: varsMaps, sets: varsSets, declared: declaredCols } = _scdbLoadVarsMap();
        const mapCount = Object.keys(varsMaps).length;
        const setCount = Object.keys(varsSets).length;
        if (mapCount || setCount) console.log(`Loaded vars.json (${mapCount} value mappings, ${setCount} value whitelists).`);
        else console.log('WARNING: vars.json not found or empty — no normalization applied.');

        if (!fs.existsSync(_SCDB_MODERN_CSV)) { console.error(`ERROR: ${_SCDB_MODERN_CSV} not found`); process.exit(1); }
        if (!fs.existsSync(_SCDB_LEGACY_CSV)) { console.error(`ERROR: ${_SCDB_LEGACY_CSV} not found`); process.exit(1); }

        const mAdded = _scdbLoadCsv(_SCDB_MODERN_CSV, scdb, varsMaps, varsSets, normIssues, unmappedFields, declaredCols);
        const lAdded = _scdbLoadCsv(_SCDB_LEGACY_CSV, scdb, varsMaps, varsSets, normIssues, unmappedFields, declaredCols);
        console.log(`Loaded ${mAdded.toLocaleString()} cases from modern, ${lAdded.toLocaleString()} unique cases from legacy (${Object.keys(scdb).length.toLocaleString()} total).`);

        try {
            if (opts.noCache) {
                if (opts.verbose) console.log(`(skipping SCDB cache write because --nocache)`);
            } else {
                if (!fs.existsSync(_SCDB_CACHE_DIR)) fs.mkdirSync(_SCDB_CACHE_DIR, { recursive: true });
                const sorted = {};
                for (const k of Object.keys(scdb).sort()) sorted[k] = scdb[k];
                fs.writeFileSync(_SCDB_CACHE_PATH, JSON.stringify(sorted, null, 2));
                console.log(`Wrote SCDB cache to ${path.relative(REPO_ROOT, _SCDB_CACHE_PATH)}.`);
            }
        } catch (e) {
            console.log(`WARNING: failed to write SCDB cache (${e.message}).`);
        }
    }

    if (normIssues.size) {
        const items = [...normIssues].sort();
        const lawMinor = items.filter(x => x.startsWith('lawMinor\u0000'));
        const others   = items.filter(x => !x.startsWith('lawMinor\u0000'));
        if (others.length) {
            console.log(`\n${others.length} normalization issue(s) — unknown codes in mapped columns:`);
            for (const x of others) {
                const [col, val] = x.split('\u0000');
                console.log(`  ${col}: ${JSON.stringify(val)}`);
            }
        }
        if (lawMinor.length) {
            if (opts.verbose) {
                console.log(`\n${lawMinor.length} lawMinor value(s) not in vars.json whitelist:`);
                for (const x of lawMinor) {
                    const [col, val] = x.split('\u0000');
                    console.log(`  ${col}: ${JSON.stringify(val)}`);
                }
            } else {
                console.log(`\n${lawMinor.length} lawMinor value(s) not in vars.json whitelist (use --verbose to list).`);
            }
        }
    }
    if (unmappedFields.size) {
        console.log(`\n${unmappedFields.size} CSV column(s) not declared in vars.json (showing up to 20 distinct values each):`);
        for (const col of [...unmappedFields.keys()].sort()) {
            const vals = [...unmappedFields.get(col)].sort();
            console.log(`  ${col}: ${vals.map(v => JSON.stringify(v)).join(', ')}`);
        }
    }
    console.log();

    if (opts.add) {
        if (!opts.term || !opts.case) {
            console.error('ERROR: --add requires both TERM (positional, YYYY-10) and --case CASEID');
            process.exit(1);
        }
        const yearMatch = /^(\d{4})(?:-\d{2})?$/.exec(opts.term);
        if (!yearMatch) { console.error(`ERROR: TERM must be YYYY or YYYY-MM, got ${JSON.stringify(opts.term)}`); process.exit(1); }
        _scdbAddCaseToTerm(scdb, yearMatch[1], opts.case);
    } else if (opts.case && !opts.backfill) {
        _scdbPrintCase(scdb, opts.case);
    } else {
        _scdbVerifyTerms(scdb, opts.term || null, opts.caseFilter || null, !!opts.update, !!opts.verbose, !!opts.debug, !!opts.backfill, !!opts.all);
    }

    // Regenerate the "Cases Not Included from SCDB" reference page on every
    // full (unfiltered) --scdb run. Always a separate, forced read-only
    // (update=false), comprehensive (all=true — unlike --backfill, there's no
    // reason to hide unargued cases on a page that only ever documents, never
    // inserts, them) pass regardless of opts.update/opts.backfill/opts.all, so
    // this never risks adding these cases to cases.json — they're deliberately
    // excluded from courts/ussc/collections/audits/audits.json for that reason (see
    // courts/ussc/collections.json's "ignored-scdb-records" Audits group).
    if (!opts.term && !opts.caseFilter && !opts.add) {
        const notIncluded = [];
        _scdbVerifyTerms(scdb, null, null, false, false, false, true, true, notIncluded);
        _writeScdbNotIncludedPage(notIncluded);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// --dates: verify argument/decision dates and usCite against
//          data/ussc/dates.csv
// ═══════════════════════════════════════════════════════════════════════════

const _DATES_CSV_PATH = path.join(REPO_ROOT, 'data', 'ussc', 'dates.csv');

function _loadDatesCsv() {
    const text = fs.readFileSync(_DATES_CSV_PATH, 'utf8');
    const lines = text.split(/\r\n|\r|\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) throw new Error('dates.csv is empty');

    const header    = _splitCsvLine(lines[0]);
    const idIdx     = header.indexOf('caseId');
    const citeIdx   = header.indexOf('usCite');
    const argIdx    = header.indexOf('dateArgument');
    const decIdx    = header.indexOf('dateDecision');
    const sourceIdx = header.indexOf('source');
    if (idIdx < 0 || citeIdx < 0 || argIdx < 0 || decIdx < 0) {
        throw new Error('dates.csv missing expected columns (caseId, usCite, dateArgument, dateDecision)');
    }

    const map = new Map();
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const fields = _splitCsvLine(lines[i]);
        // Only trust rows from the official SCOTUS source.
        if (sourceIdx >= 0 && (fields[sourceIdx] || '').trim() !== 'scotus') continue;
        const caseId = (fields[idIdx] || '').trim();
        if (!caseId) continue;
        // A caseId may appear more than once (multiple argument dates for the
        // same case under separate rows). Only merge rows where both usCite and
        // dateDecision match the first-seen row — rows that differ on either
        // field are a different case that shares the caseId by error.
        const rowCite = (fields[citeIdx] || '').trim();
        const rowDec  = (fields[decIdx]  || '').trim();
        if (!map.has(caseId)) {
            map.set(caseId, {
                usCite:        rowCite,
                dateArguments: [],
                dateDecision:  rowDec,
            });
        }
        const entry = map.get(caseId);
        // Skip rows that belong to a different case sharing this caseId.
        if (rowCite !== entry.usCite || rowDec !== entry.dateDecision) continue;
        // dateArgument may be '0' (no date), a single YYYY-MM-DD, or a
        // quoted comma-separated list like "1792-08-08,1792-08-10".
        const rawArg = (fields[argIdx] || '').trim();
        if (rawArg && rawArg !== '0') {
            for (const d of rawArg.split(',').map(s => s.trim()).filter(Boolean)) {
                if (!entry.dateArguments.includes(d)) entry.dateArguments.push(d);
            }
        }
    }
    return map;
}

async function runDatesCheck(termFilter, caseFilter, update) {
    let datesMap;
    try {
        datesMap = _loadDatesCsv();
    } catch (e) {
        console.error(`ERROR: could not read dates.csv: ${e.message}`);
        process.exit(1);
    }
    console.log(`Loaded ${datesMap.size.toLocaleString()} cases from dates.csv.\n`);

    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
            if (page.term) return page.term;
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return m ? m[1] : null;
        })).filter(Boolean);
    } catch {}

    const termsToProcess = termFilter ? [termFilter] : allTerms;

    // Normalise a date-or-date-list value: strip blanks, treat '0'/''/null as empty string.
    const normDate = v => (v == null || v === '0') ? '' : String(v).trim();

    // Build a canonical sorted comma-joined string for comparison.
    const normDates = v => normDate(v).split(',').map(s => s.trim()).filter(Boolean).sort().join(',');

    let rl = null;
    const _ask = (q) => new Promise(resolve => rl.question(q, a => resolve(a.trim())));
    if (update) {
        rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }

    let totalChecked       = 0;
    let totalMissingInCsv  = 0;
    let totalDiscrepancies = 0;

    for (const term of termsToProcess) {
        const casesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        const filtered = caseFilter
            ? cases.filter(c => c && (
                c.id === caseFilter ||
                (c.number || '').split(',').map(s => s.trim()).includes(caseFilter)
              ))
            : cases;

        let casesModified = false;

        for (const c of filtered) {
            if (!c || !c.id) continue;
            totalChecked++;

            const row = datesMap.get(c.id);
            if (!row) {
                totalMissingInCsv++;
                if (_VERBOSE) console.log(`  ${term}/${c.id} (${firstTitle(c.title) || '?'}): not found in dates.csv`);
                continue;
            }

            const label = `${term}/${c.id} (${firstTitle(c.title) || '?'})`;
            let discrepancy = false;
            let fixArg = null;   // sorted CSV dates to set as c.argument, if accepted
            let fixDec = null;   // CSV decision date to set as c.decision, if accepted

            // usCite — also used as a sanity check: if it doesn't match,
            // the CSV row is for a different case and date checks are skipped.
            const ourCite = normDate(c.usCite);
            const csvCite = normDate(row.usCite);
            const citeConflict = ourCite && csvCite && !csvCite.includes('___') && ourCite !== csvCite;
            if (citeConflict) {
                console.log(`  ${label}: usCite   ours="${ourCite}"  csv="${csvCite}"`);
                discrepancy = true;
            }

            // argument date(s) and decision date: only checked when usCite
            // matches (or is absent), so a caseId collision in the CSV doesn't
            // produce spurious date discrepancies.
            if (!citeConflict) {

            // argument date(s): each CSV date must appear in our "argument" or "reargument" field
            const ourArgDates = new Set([
                ...normDates(c.argument).split(',').filter(Boolean),
                ...normDates(c.reargument).split(',').filter(Boolean),
            ]);
            const missingArgDates = row.dateArguments.filter(d => d && !ourArgDates.has(d));
            if (missingArgDates.length) {
                const ourAll = [...ourArgDates].sort().join(',') || '(none)';
                console.log(`  ${label}: argument csv="${missingArgDates.join(',')}" not found in ours="${ourAll}"`);
                discrepancy = true;
                fixArg = row.dateArguments.slice().sort().join(',');
            }

            // decision date
            const ourDec = normDate(c.decision);
            const csvDec = normDate(row.dateDecision);
            if (ourDec !== csvDec && (ourDec || csvDec)) {
                console.log(`  ${label}: decision ours="${ourDec || '(none)'}"  csv="${csvDec || '(none)'}"`);
                discrepancy = true;
                fixDec = csvDec || null;
            }

            } // end !citeConflict

            if (discrepancy) {
                totalDiscrepancies++;
                if (update) {
                    console.log(`                  ${c.decision_loc || c.decision_ussc || c.decision_rep || '(no decision href)'}`);
                    console.log();
                    const answer = await _ask('  Change to CSV date? (y/N) ');
                    if (answer.toLowerCase() === 'y') {
                        if (fixArg !== null) c.argument = fixArg;
                        if (fixDec !== null) c.decision = fixDec;
                        // Reorder keys to canonical position before writing.
                        const reordered = reorderCase(c);
                        Object.keys(c).forEach(k => delete c[k]);
                        Object.assign(c, reordered);
                        casesModified = true;
                        console.log('  -> Updated.');
                    }
                    console.log();
                }
            }
        }

        if (casesModified) {
            _writeJson(casesPath, cases);
            console.log(`Wrote ${path.relative(REPO_ROOT, casesPath)}`);
        }
    }

    if (rl) rl.close();

    console.log(`\nDates: ${totalChecked} case(s) checked, ${totalDiscrepancies} discrepancy/discrepancies, ${totalMissingInCsv} case(s) not in CSV.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// --split: detect opinion events whose transcript contains the majority
// opinion writer followed by additional speakers, and optionally insert a
// separate opinion event for each additional speaker.
// ═══════════════════════════════════════════════════════════════════════════

/** Convert HH:MM:SS.FF transcript time to floating-point seconds. */
function _splitParseTime(s) {
    if (!s) return 0;
    const dot = s.lastIndexOf('.');
    const hms = dot >= 0 ? s.slice(0, dot) : s;
    const frac = dot >= 0 ? parseFloat('0.' + s.slice(dot + 1)) : 0;
    const parts = hms.split(':').map(Number);
    const [h = 0, m = 0, sec = 0] = parts.length === 3 ? parts : [0, ...parts];
    return h * 3600 + m * 60 + sec + frac;
}

const _SPLIT_MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
];

/** Format "YYYY-MM-DD" → "Month D, YYYY". */
function _splitFormatDate(iso) {
    const [y, m, d] = (iso || '').split('-').map(Number);
    if (!y || !m || !d) return iso || '';
    return `${_SPLIT_MONTHS[m - 1]} ${d}, ${y}`;
}

/** Extract the first sentence (up to the first ". ") from a turn's text. */
function _splitFirstSentence(text) {
    const s = (text || '').trim();
    const end = s.search(/\.\s/);
    return end >= 0 ? s.slice(0, end + 1) : s.slice(0, 120);
}

/** True if transcript speaker name matches the votes[].name canonical name. */
function _splitSpeakerMatches(speakerName, voteName) {
    const sp = speakerName.trim().toUpperCase();
    const vn = voteName.trim().toUpperCase();
    if (sp === vn) return true;
    // Transcript may use last name only (e.g. "KAVANAUGH").
    const last = vn.split(' ').pop();
    return sp === last;
}

/** Return the name of the speaker who spoke the most words across all their turns. */
function _splitPrimarySpeaker(turns) {
    const wordCounts = new Map();
    for (const turn of turns) {
        const name = (turn.name || '').trim();
        if (!name) continue;
        const words = (turn.text || '').trim().split(/\s+/).filter(Boolean).length;
        wordCounts.set(name, (wordCounts.get(name) || 0) + words);
    }
    let best = '', bestCount = 0;
    for (const [name, count] of wordCounts) {
        if (count > bestCount) { bestCount = count; best = name; }
    }
    return best;
}

// ═══════════════════════════════════════════════════════════════════════════
// --unargued: list cases with argument-related anomalies
//
//   UNARGUED  term/number  title
//       Case has no argument/reargument date fields AND no argument/reargument
//       events — i.e. was never argued (decided on briefs, dismissed, etc.).
//
//   MISSING   term/number  title  [field date: reason]
//       Case has a declared argument or reargument date but the corresponding
//       event is missing, or exists but lacks audio and/or transcript.
//
//   MISDATED  term/number  title  [type event date: not in field 'dates']
//       Case has an argument/reargument event whose date does not appear in
//       the matching argument/reargument date field.
// ═══════════════════════════════════════════════════════════════════════════

function runUnargued(termFilter, caseFilter) {
    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
            if (page.term) return page.term;
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return m ? m[1] : null;
        })).filter(Boolean);
    } catch {}

    const termsToProcess = termFilter ? [termFilter] : allTerms;
    let total = 0;

    for (const term of termsToProcess) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        for (const c of cases) {
            const number = c.number || c.id || '?';
            if (caseFilter && c.id !== caseFilter
                    && !(c.number || '').split(',').map(s => s.trim()).includes(caseFilter)) continue;

            // Skip cases with a disposition — they were resolved without argument (GVRs, DIGs, etc.).
            if (c.disposition) continue;

            const title = (firstTitle(c.title) || '').slice(0, 60);
            const label = `${term}/${number}`;

            // Declared argument / reargument dates.
            const argDates   = new Set(c.argument   ? _parseDateField(String(c.argument))   : []);
            const reargDates = new Set(c.reargument ? _parseDateField(String(c.reargument)) : []);

            // Events that are argument or reargument type.
            const argEvents = (c.events || []).filter(e =>
                e && (e.type === 'argument' || e.type === 'reargument'));

            // ── UNARGUED ──────────────────────────────────────────────────
            // No declared dates and no argument/reargument events at all.
            if (argDates.size === 0 && reargDates.size === 0 && argEvents.length === 0) {
                console.log(`UNARGUED  ${label}  ${title}`);
                total++;
                continue;
            }

            // ── MISDATED ──────────────────────────────────────────────────
            // An argument/reargument event has audio/transcript but its date
            // is not in the corresponding declared field.
            for (const ev of argEvents) {
                const date = ev.date || '';
                if (!date) continue;
                const hasMedia = !!(ev.audio_href || ev.transcript_href || ev.text_href);
                if (!hasMedia) continue;
                const expectedSet = ev.type === 'reargument' ? reargDates : argDates;
                if (!expectedSet.has(date)) {
                    const declared = [...expectedSet].sort().join(',') || '(none)';
                    console.log(`MISDATED  ${label}  ${title}  [${ev.type} event ${date}: not in ${ev.type} field '${declared}']`);
                    total++;
                }
            }

            // ── MISSING ───────────────────────────────────────────────────
            // A declared date has no corresponding event, or its event lacks
            // audio and/or transcript coverage.
            const checkDates = [
                ...[...argDates].map(d => [d, 'argument']),
                ...[...reargDates].map(d => [d, 'reargument']),
            ];
            for (const [date, fieldName] of checkDates) {
                const eventsForDate = argEvents.filter(e => e.date === date);
                if (eventsForDate.length === 0) {
                    console.log(`MISSING   ${label}  ${title}  [${fieldName} ${date}: no event]`);
                    total++;
                    continue;
                }
                const hasAudio      = eventsForDate.some(e => !!e.audio_href);
                const hasTranscript = eventsForDate.some(e => !!(e.transcript_href || e.text_href));
                if (!hasAudio && !hasTranscript) {
                    console.log(`MISSING   ${label}  ${title}  [${fieldName} ${date}: no audio or transcript]`);
                    total++;
                } else if (!hasAudio) {
                    console.log(`MISSING   ${label}  ${title}  [${fieldName} ${date}: no audio]`);
                    total++;
                } else if (!hasTranscript) {
                    console.log(`MISSING   ${label}  ${title}  [${fieldName} ${date}: no transcript]`);
                    total++;
                }
            }
        }
    }

    console.log(`\nTotal anomalies: ${total}`);
}

/**
 * For each opinion event whose transcript has the majority opinion writer
 * followed by additional speakers:
 *   - print a report line
 *   - if update=true, insert a new "opinion" event for each additional speaker
 *     (same audio/transcript, different title, offset set to first turn time)
 */
async function runSplitCheck(termFilter, caseFilter, update) {
    const termsDir = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');

    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
            if (page.term) return page.term;
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return m ? m[1] : null;
        })).filter(Boolean);
    } catch {}

    const termsToProcess = termFilter
        ? [termFilter]
        : allTerms;

    // ── Phase 0: Convert offset→turn on already-split opinion events ─────────
    // For any opinion event that has an "offset" (time string from a prior
    // --split run), find the matching turn in the transcript and replace
    // "offset" with a 1-based "turn" number instead.
    let migrateFound   = 0;
    let migrateUpdated = 0;

    for (const term of termsToProcess) {
        const casesPath = path.join(termsDir, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        const cases = _readJson(casesPath);
        if (!Array.isArray(cases)) continue;

        let termChanged = false;

        for (const c of cases) {
            if (caseFilter && c.id !== caseFilter &&
                !(c.number || '').split(',').map(s => s.trim()).includes(caseFilter)) continue;
            if (!Array.isArray(c.events)) continue;

            const casesDir = path.join(termsDir, term, 'cases');

            for (const ev of c.events) {
                if (ev.type !== 'decision' || ev.offset === undefined || !ev.text_href) continue;

                const transcriptPath = path.join(casesDir, ev.text_href);
                if (!fs.existsSync(transcriptPath)) continue;

                let transcript;
                try { transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')); }
                catch { continue; }

                const turns = Array.isArray(transcript.turns) ? transcript.turns : [];
                if (!turns.length) continue;

                // Find the turn by matching the stored offset time string.
                let matchIdx = turns.findIndex(t => t.time === ev.offset);

                // Fallback: derive justice last name from title and find their
                // first turn after the offset time (by parsed seconds).
                if (matchIdx < 0) {
                    const m = /^(?:Oral )?Announcement by Justice (\S+)\b/i.exec(ev.title || '');
                    if (m) {
                        const lastName = m[1].toUpperCase();
                        const offsetSecs = _splitParseTime(String(ev.offset));
                        matchIdx = turns.findIndex(t =>
                            _splitParseTime(t.time) >= offsetSecs &&
                            t.name.trim().toUpperCase().endsWith(lastName));
                    }
                }

                if (matchIdx < 0) continue;

                // The transcript turn objects carry a 1-based `turn` field.
                const turnNumber = turns[matchIdx].turn ?? (matchIdx + 1);

                migrateFound++;
                const label = `${term}/${c.id} (${firstTitle(c.title) || c.id})`;
                console.log(`  ${label}: "${ev.title}" offset=${ev.offset} -> turn=${turnNumber}`);

                if (update) {
                    delete ev.offset;
                    ev.turn = turnNumber;
                    // Reorder keys in-place after mutation.
                    const reordered = reorderEvent({ ...ev });
                    for (const k of Object.keys(ev)) delete ev[k];
                    Object.assign(ev, reordered);
                    migrateUpdated++;
                    termChanged = true;
                }
            }
        }

        if (termChanged) {
            _writeJson(casesPath, cases);
            console.log(`Wrote ${path.relative(REPO_ROOT, casesPath)}`);
        }
    }

    console.log(`\nMigrate: ${migrateFound} offset(s) to convert, ${migrateUpdated} updated.`);

    // ── Phase 1: Rename "Opinion Announcement Part N ..." events ─────────────
    // For any case that has at least one opinion event with "Part N" in the
    // title, examine each opinion event's transcript to find the primary
    // speaker (most words). If the primary speaker is the opinion author,
    // strip "Part N" from the title; otherwise rename to
    // "Oral Announcement by Justice <Last> on <Date>".
    const _PART_N_RE = /\s+Part \d+/i;
    let renameFound   = 0;
    let renameUpdated = 0;

    for (const term of termsToProcess) {
        const casesPath = path.join(termsDir, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        const cases = _readJson(casesPath);
        if (!Array.isArray(cases)) continue;

        let termChanged = false;

        for (const c of cases) {
            if (caseFilter && c.id !== caseFilter &&
                !(c.number || '').split(',').map(s => s.trim()).includes(caseFilter)) continue;
            if (!Array.isArray(c.votes) || !Array.isArray(c.events)) continue;

            // Only process cases with at least one "Part N" opinion event title.
            const hasPartN = c.events.some(ev =>
                ev.type === 'decision' && _PART_N_RE.test(ev.title || ''));
            if (!hasPartN) continue;

            const opinionVote = c.votes.find(v => v.opinion === true);
            if (!opinionVote) continue;

            const casesDir = path.join(termsDir, term, 'cases');

            for (const ev of c.events) {
                if (ev.type !== 'decision' || !ev.text_href) continue;

                const transcriptPath = path.join(casesDir, ev.text_href);
                if (!fs.existsSync(transcriptPath)) continue;

                let transcript;
                try { transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')); }
                catch { continue; }

                const turns = Array.isArray(transcript.turns) ? transcript.turns : [];
                if (!turns.length) continue;

                const primarySpeaker = _splitPrimarySpeaker(turns);
                const isAuthor = _splitSpeakerMatches(primarySpeaker, opinionVote.name);

                let newTitle;
                if (isAuthor) {
                    newTitle = (ev.title || '').replace(_PART_N_RE, '');
                } else {
                    const lastName = primarySpeaker.trim().split(' ').pop();
                    const capitalized = lastName.charAt(0) + lastName.slice(1).toLowerCase();
                    newTitle = `Oral Announcement by Justice ${capitalized} on ${_splitFormatDate(ev.date)}`;
                }

                if (newTitle === ev.title) continue;

                renameFound++;
                const label = `${term}/${c.id} (${firstTitle(c.title) || c.id})`;
                console.log(`  ${label}: "${ev.title}" -> "${newTitle}"`);

                if (update) {
                    ev.title = newTitle;
                    renameUpdated++;
                    termChanged = true;
                }
            }
        }

        if (termChanged) {
            _writeJson(casesPath, cases);
            console.log(`Wrote ${path.relative(REPO_ROOT, casesPath)}`);
        }
    }

    console.log(`\nRename: ${renameFound} event title(s) to rename, ${renameUpdated} updated.`);

    // ── Phase 2: Insert split events for multi-speaker opinion transcripts ────
    let totalFound   = 0;
    let totalUpdated = 0;

    for (const term of termsToProcess) {
        const casesPath = path.join(termsDir, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        const cases = _readJson(casesPath);
        if (!Array.isArray(cases)) continue;

        let termChanged = false;

        for (const c of cases) {
            if (caseFilter && c.id !== caseFilter &&
                !(c.number || '').split(',').map(s => s.trim()).includes(caseFilter)) continue;
            if (!Array.isArray(c.votes) || !Array.isArray(c.events)) continue;

            // Find the majority opinion writer (the one vote with opinion:true).
            const opinionVote = c.votes.find(v => v.opinion === true);
            if (!opinionVote) continue;

            const casesDir = path.join(termsDir, term, 'cases');

            for (let evIdx = 0; evIdx < c.events.length; evIdx++) {
                const ev = c.events[evIdx];
                if (ev.type !== 'decision' || !ev.text_href) continue;

                const transcriptPath = path.join(casesDir, ev.text_href);
                if (!fs.existsSync(transcriptPath)) continue;

                let transcript;
                try { transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')); }
                catch { continue; }

                const turns = Array.isArray(transcript.turns) ? transcript.turns : [];
                if (!turns.length) continue;

                // Find the writer's first turn index in the transcript — used as
                // the anchor rather than their last turn, since the writer (often
                // the Chief Justice) may return for brief closing remarks *after*
                // other justices have delivered their own concurrence/dissent, and
                // anchoring on "last" would miss everyone in between.
                const writerName = opinionVote.name;
                let writerFirstTurnIdx = -1;
                for (let i = 0; i < turns.length; i++) {
                    if (_splitSpeakerMatches(turns[i].name, writerName)) {
                        writerFirstTurnIdx = i;
                        break;
                    }
                }
                if (writerFirstTurnIdx < 0) continue; // writer not in transcript

                // Build a set of speaker names whose title is CHIEF JUSTICE
                // (from media.speakers) — they are skipped as additional
                // speakers since they're making introductions/thank-yous.
                const chiefJusticeNames = new Set(
                    (transcript.media?.speakers || [])
                        .filter(s => (s.title || '').toUpperCase() === 'CHIEF JUSTICE')
                        .map(s => (s.name || '').trim().toUpperCase())
                );

                // Tally each additional speaker's turns (in order of first
                // appearance) from after the writer's first turn. Skip any chief
                // justice speaker, any of the writer's own later turns (e.g.
                // closing remarks after other justices have spoken), and any
                // individual "Thank you"/"Mr. Clerk" transitional turn.
                const speakerInfo = new Map(); // name -> { firstIdx, totalWords }
                for (let i = writerFirstTurnIdx + 1; i < turns.length; i++) {
                    const sp = turns[i].name;
                    if (chiefJusticeNames.has(sp.trim().toUpperCase())) continue;
                    if (_splitSpeakerMatches(sp, writerName)) continue;
                    const text = (turns[i].text || '').trim();
                    if (/^thank you\b|^mr\. clerk\b/i.test(text)) continue;
                    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
                    const info = speakerInfo.get(sp) || { firstIdx: i, totalWords: 0 };
                    info.totalWords += words;
                    speakerInfo.set(sp, info);
                }

                // Only treat a speaker as delivering a genuine separate announcement
                // — not a stray interjection, pronunciation aside, or cross-reference
                // to another case — if they said enough to matter: either a
                // substantial total word count, or a shorter remark backed by their
                // own "wrote an opinion" vote entry. (A justice reading on behalf of
                // an absent colleague may have no such entry themselves, but will
                // always say enough words to clear the length bar alone.)
                const additionalSpeakers = [];
                for (const [sp, info] of speakerInfo) {
                    const wroteOpinion = c.votes.some(v =>
                        _splitSpeakerMatches(sp, v.name) && /wrote an opinion/i.test(v.action || ''));
                    if (info.totalWords < 100 && !(info.totalWords >= 10 && wroteOpinion)) continue;
                    additionalSpeakers.push({ name: sp, turnIdx: info.firstIdx });
                }

                if (!additionalSpeakers.length) continue;

                // Check whether this event was already split (avoid duplicates).
                // Skip events that are themselves already split copies (have turn or offset set).
                if (ev.turn !== undefined || ev.offset !== undefined) continue;

                const alreadySplit = c.events.some((e, i) =>
                    i > evIdx &&
                    e.type === 'decision' &&
                    e.text_href === ev.text_href &&
                    (e.turn !== undefined || e.offset !== undefined)
                );
                if (alreadySplit) continue;

                totalFound++;
                const label = `${term}/${c.id} (${firstTitle(c.title) || c.id})`;
                console.log(`  ${label}: ${ev.text_href} — ${additionalSpeakers.length} additional speaker(s) after writer (${writerName})`);

                if (update) {
                    // Build the new events in speaker order, then splice them all
                    // in after the current event index in one shot.
                    const newEvents = [];
                    for (const sp of additionalSpeakers) {
                        const lastName = sp.name.trim().split(' ').pop();
                        const capitalized = lastName.charAt(0) + lastName.slice(1).toLowerCase();
                        const turnNumber = turns[sp.turnIdx].turn ?? (sp.turnIdx + 1);
                        const newEv = { ...ev };
                        newEv.title = `Oral Announcement by Justice ${capitalized} on ${_splitFormatDate(ev.date)}`;
                        newEv.turn  = turnNumber;
                        delete newEv.offset;
                        delete newEv.advocates;
                        newEvents.push(reorderEvent(newEv));
                        const firstSentence = _splitFirstSentence(turns[sp.turnIdx].text);
                        console.log(`    -> inserting "${newEv.title}" (turn=${turnNumber})`);
                        console.log(`       "${firstSentence}"`);
                        console.log();
                        totalUpdated++;
                    }
                    c.events.splice(evIdx + 1, 0, ...newEvents);
                    // Advance evIdx past the newly inserted events so the outer
                    // loop doesn't re-examine them.
                    evIdx += newEvents.length;
                    termChanged = true;
                } else {
                    for (const sp of additionalSpeakers) {
                        const turnNumber = turns[sp.turnIdx].turn ?? (sp.turnIdx + 1);
                        const firstSentence = _splitFirstSentence(turns[sp.turnIdx].text);
                        console.log(`    -> ${sp.name}  (turn ${turnNumber}, time=${turns[sp.turnIdx].time})`);
                        console.log(`       "${firstSentence}"`);
                        console.log();
                    }
                }
            } // end for evIdx
        } // end for c

        if (termChanged) {
            _writeJson(casesPath, cases);
            console.log(`Wrote ${path.relative(REPO_ROOT, casesPath)}`);
        }
    }

    console.log(`\nSplit: ${totalFound} event(s) need splitting, ${totalUpdated} new event(s) inserted.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Audio length checking via ffprobe — runs as part of normal verification.
// Requires ffprobe (part of ffmpeg). For well-formed MP3/audio files hosted
// over HTTP, ffprobe uses range requests and reads only the file header —
// it does not download the full audio file.
// ═══════════════════════════════════════════════════════════════════════════

const _execFile = promisify(execFile);

/** Format a duration in seconds as "HH:MM:SS.NN" (NN = hundredths of a second). */
function _formatLength(totalSecs) {
    const rounded = Math.round(totalSecs * 100) / 100;
    const h  = Math.floor(rounded / 3600);
    const m  = Math.floor((rounded % 3600) / 60);
    const s  = Math.floor(rounded % 60);
    const nn = Math.round((rounded % 1) * 100);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(nn).padStart(2, '0')}`;
}

/**
 * Call ffprobe on a URL and return `{ length, size, bitrate }` from the
 * format metadata. `length` is "HH:MM:SS.NN"; `size` is bytes (number);
 * `bitrate` is e.g. "128kbps". Fields are null/undefined when unavailable.
 * Returns null on complete failure.
 */
async function _ffprobeMeta(url) {
    try {
        const { stdout } = await _execFile('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_entries', 'format=duration,size,bit_rate',
            '-i', url,
        ], { timeout: 30000 });
        const obj = JSON.parse(stdout);
        const fmt = obj?.format;
        if (!fmt) return null;

        const dur = parseFloat(fmt.duration);
        if (!Number.isFinite(dur) || dur <= 0) return null;
        const length = _formatLength(dur);

        const rawSize = parseInt(fmt.size, 10);
        const size = (Number.isFinite(rawSize) && rawSize > 0) ? rawSize : null;

        const rawBr = parseInt(fmt.bit_rate, 10);
        const bitrate = (Number.isFinite(rawBr) && rawBr > 0)
            ? `${Math.round(rawBr / 1000)}kbps`
            : null;

        return { length, size, bitrate };
    } catch {
        return null;
    }
}

async function checkLengths(casesPath, caseFilter, update) {
    if (!fs.existsSync(casesPath)) return;
    const cases = _readJson(casesPath);
    if (!Array.isArray(cases)) return;
    let termChanged = false;
    let probed = 0, filled = 0, failed = 0;

    for (const c of cases) {
        if (caseFilter) {
            const nums = (c.number || '').split(',').map(s => s.trim());
            if (c.id !== caseFilter && !nums.includes(caseFilter)) continue;
        }
        if (!Array.isArray(c.events)) continue;

        for (const ev of c.events) {
            const audioHref = ev.audio_href || '';
            if (!audioHref) continue;
            // Skip only when length, size, and bitrate are all already set.
            if ('length' in ev && 'size' in ev && 'bitrate' in ev) continue;

            probed++;
            const label = `${c.number || c.id || '?'} (${ev.date || '?'})`;
            const urlShort = audioHref.length > 60 ? '…' + audioHref.slice(-59) : audioHref;
            process.stdout.write(`  ${label}: ${urlShort} `);

            const meta = await _ffprobeMeta(audioHref);
            if (!meta) {
                console.log('FAILED');
                failed++;
                continue;
            }
            const parts = [meta.length];
            if (meta.size    != null) parts.push(`${meta.size}B`);
            if (meta.bitrate != null) parts.push(meta.bitrate);
            console.log(parts.join('  '));
            filled++;

            if (update) {
                ev.length  = meta.length;
                if (meta.size    != null) ev.size    = meta.size;
                if (meta.bitrate != null) ev.bitrate = meta.bitrate;
                const reordered = reorderEvent({ ...ev });
                for (const k of Object.keys(ev)) delete ev[k];
                Object.assign(ev, reordered);
                termChanged = true;
            }
            // Brief courtesy delay between requests.
            await sleep(500);
        }
    }

    if (update && termChanged) {
        _writeJson(casesPath, cases);
        console.log(`Wrote ${path.relative(REPO_ROOT, casesPath)}`);
    }
    if (probed > 0) {
        console.log(`Lengths: ${probed} probed, ${filled} found, ${failed} failed.`);
    }
}

function checkAlignedTranscriptLengths(casesPath, caseFilter) {
    if (!fs.existsSync(casesPath)) return;
    const cases = _readJson(casesPath);
    if (!Array.isArray(cases)) return;
    const casesDir = path.join(path.dirname(casesPath), 'cases');
    const term = path.basename(path.dirname(casesPath));

    for (const c of cases) {
        if (caseFilter) {
            const nums = (c.number || '').split(',').map(s => s.trim());
            if (c.id !== caseFilter && !nums.includes(caseFilter)) continue;
        }
        for (const ev of c.events || []) {
            const evType = ev.type || '';
            if (evType !== 'argument' && evType !== 'reargument') continue;
            if (!ev.audio_href || !ev.text_href || !ev.aligned) continue;
            if (!ev.length) continue;

            const transcriptPath = path.join(casesDir, ev.text_href);
            if (!fs.existsSync(transcriptPath)) continue;

            const transcript = _readJson(transcriptPath);
            const turns = transcript?.turns;
            if (!Array.isArray(turns) || !turns.length) continue;

            let lastTime = null;
            for (let i = turns.length - 1; i >= 0; i--) {
                if (turns[i].time != null) { lastTime = turns[i].time; break; }
            }
            if (lastTime == null) continue;

            const audioSecs    = _parseTimeSecs(ev.length);
            const lastTurnSecs = _parseTimeSecs(String(lastTime));
            const label = `${term}/${c.number || c.id || '?'} "${c.title || '?'}" (${ev.date || '?'}) ${path.basename(ev.text_href)}`;

            if (_VERBOSE) {
                if (audioSecs < lastTurnSecs - 60) {
                    console.log(`WARNING: ${label}: audio length ${ev.length} is more than 1 minute shorter than last transcript timestamp ${lastTime}`);
                } else if (audioSecs > lastTurnSecs + 600) {
                    console.log(`WARNING: ${label}: audio length ${ev.length} exceeds last transcript timestamp ${lastTime} by more than 10 minutes`);
                }
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// --loc --backfill: fill missing pipe-separated sub-titles from LOC PDFs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract text from the first page of a PDF at `url` using pdftotext.
 * Returns null on failure.
 */
async function _pdfFirstPageText(url) {
    const tmp = path.join(REPO_ROOT, `_tmp_pdf_${process.pid}.pdf`);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (!res.ok) return null;
        fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
        const { stdout } = await _execFile('pdftotext', ['-f', '1', '-l', '1', tmp, '-']);
        return stdout;
    } catch {
        return null;
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
}

/**
 * Parse "Together with No. X, Title; No. Y, Title..." from the first-page
 * text of a SCOTUS opinion. Returns [{num, title}, ...].
 */
function _parseTogetherWith(text) {
    // Normalize whitespace (pdftotext may wrap lines mid-phrase).
    const flat = text.replace(/\s+/g, ' ');
    const anchor = /Together with\s+/i.exec(flat);
    if (!anchor) return [];

    // Search for "No. N, Title" segments in the text following the anchor.
    // Each title ends at the next "; No.", ", also on", ", all on", or the
    // end of the string.
    const content = flat.slice(anchor.index + anchor[0].length);
    const results = [];
    const re = /\bNo\.\s*(\d+(?:[-,]\s*(?:Orig|Misc)\.?)?),\s*(.+?)(?=[;,]\s*(?:and\s+)?\bNo\.\s*\d|,\s*(?:also|all)\s+on|$)/gi;
    let hit;
    while ((hit = re.exec(content)) !== null) {
        const num   = hit[1].trim().replace(/,\s*(Orig|Misc)\.?$/i, '-$1');
        const title = hit[2].trim()
            .replace(/[,.]\s*(?:also\s+)?on (?:appeals?|certiorari)\b.*/i, '')
            .replace(/,?\s*\bet al\.?/gi, '')
            .replace(/,?\s*\bet ux\.?/gi, '')
            .replace(/\.{2,}/g, '.')
            .replace(/,+$/, '').trim();
        if (num && title) results.push({ num, title });
    }
    return results;
}

/**
 * For cases in cases.json where the number field has more comma-separated
 * values than the title field has pipe-separated values, fetch the LOC
 * opinion PDF and parse "Together with" footnotes to fill in the gaps.
 */
async function backfillTitlesFromLoc(casesPath, term, caseFilter, dryRun) {
    if (!fs.existsSync(casesPath)) return;
    const cases = _readJson(casesPath);
    if (!Array.isArray(cases)) return;
    let termChanged = false;

    for (const c of cases) {
        if (caseFilter) {
            const nums = (c.number || '').split(',').map(s => s.trim());
            if (c.id !== caseFilter && !nums.includes(caseFilter)) continue;
        }

        const numbers = (c.number || '').split(',').map(s => s.trim()).filter(Boolean);
        const titles  = (c.title  || '').split('|');
        if (numbers.length <= titles.length) continue;

        const href = c.decision_loc || '';
        if (!href) {
            if (caseFilter) console.log(`  ${term}/${c.number || c.id}: no decision_loc, skipping`);
            continue;
        }

        const label = `${term}/${c.number || c.id}`;
        const text = await _pdfFirstPageText(href);
        if (!text) {
            console.log(`${label}: FAILED to fetch ${href}`);
            continue;
        }

        const found = _parseTogetherWith(text);
        if (!found.length) {
            console.log(`${label}: no "Together with" footnote found`);
            continue;
        }

        // Pad titles array to match numbers length, then fill gaps.
        const newTitles = [...titles];
        while (newTitles.length < numbers.length) newTitles.push('');

        let caseChanged = false;
        console.log(`${label}:`);
        for (const { num, title } of found) {
            const idx = numbers.indexOf(num);
            if (idx < 0) { console.log(`  No. ${num}: not in case number field (${numbers.join(',')}), skipping`); continue; }
            if (newTitles[idx]) continue;
            console.log(`  No. ${num}: ${title}`);
            newTitles[idx] = title;
            caseChanged = true;
        }

        if (!caseChanged) continue;

        // Drop any trailing empty slots.
        while (newTitles.length > 1 && !newTitles[newTitles.length - 1]) newTitles.pop();

        const newTitle = newTitles.join('|');
        if (dryRun) {
            console.log(`  [dry-run] would set title: "${newTitle}"`);
        } else {
            c.title = newTitle;
            termChanged = true;
        }
    }

    if (termChanged) {
        _writeJson(casesPath, cases);
        console.log(`Wrote ${path.relative(REPO_ROOT, casesPath)}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI / main
// ═══════════════════════════════════════════════════════════════════════════

const USAGE = `Usage: node update_cases.js                                # update all terms
       node update_cases.js [TERM [CASE]] [--checkurls] [--opinions] [--roles] [--speakers] [--reports [--volume N]] [--verbose] [--dry-run]
       node update_cases.js TERM CASE --votes win|loss [VOTE_STRING [AUTHOR]] [--minority NAMES...] [--recused NAMES...] [--dissent NAMES...] [--result STRING]
       node update_cases.js TERM CASE --minority NAMES...    # partial: change minority votes
       node update_cases.js TERM CASE --recused NAMES...     # partial: mark justices recused
       node update_cases.js [TERM [CASE]] --scdb [--add] [--nocache] [--verbose] [--debug]
       node update_cases.js [TERM [CASE]] --dates                              # verify dates vs dates.csv
       node update_cases.js [TERM [CASE]] --verify [--verbose] [--dry-run]
                                                                          # backfill missing events[] for recorded argument/reargument dates
       node update_cases.js [TERM [CASE]] --split [--dry-run]                  # detect/split multi-speaker opinion events
       node update_cases.js [TERM [CASE]] --unargued                            # list argument anomalies
       node update_cases.js [TERM]       --missing-cite                        # list decided cases without usCite
       node update_cases.js [TERM [CASE]] --loc --backfill [--dry-run]          # fill missing sub-titles from LOC opinion PDFs
       node update_cases.js [TERM [CASE]] --cleanup-files [--dry-run]          # normalize type/group in all files.json
       node update_cases.js TERM CASE --tag WORD_OR_PHRASE   # add a tag to one case
       node update_cases.js TERM CASE --date YYYY-MM-DD --minutes URL   # attach a NARA minutes reference
       node update_cases.js --minutes [--dry-run]              # backfill missing minutes_src values
       node update_cases.js TERM CASE --cites [--verbose] [--dry-run]  # scan opinion HTML, build opCite
       node update_cases.js [TERM] --cites [--verbose] [--dry-run]     #   ... or every case in a/all term(s)
       node update_cases.js --top-cites [--dry-run]            # rebuild courts/ussc/collections/cites/top_cites.json
       node update_cases.js --import FILE [--dry-run]        # import tags from a JSON file
       node update_cases.js --advocates                       # rebuild advocate index only
       node update_cases.js --feeds [--verbose]                # rebuild courts/ussc/feeds/ (podcast RSS)
       node update_cases.js --sitemap [--dry-run]              # rebuild courts/ussc/sitemap.xml

File changes happen by default. Pass --dry-run to suppress all writes and only
report what would change.

Examples:
  node update_cases.js 2025-10
  node update_cases.js 2025-10 24-1260
  node update_cases.js 2025-10 --checkurls --opinions
  node update_cases.js 2025-10 --dry-run                   # report only, no writes
  node update_cases.js 1979-10 --roles                     # derive event advocate roles
  node update_cases.js 1979-10 78-1014 --roles             #   ... and write them to cases.json
  node update_cases.js 2016-10 --speakers                  # add missing justices to transcript speakers
  node update_cases.js 2016-10 15-537 --speakers --dry-run #   ... preview changes without writing

  # Vote updates
  node update_cases.js 2025-10 24-109 --votes win 9-0 roberts
  node update_cases.js 2025-10 24-109 --votes loss 6-3 alito --dissent kagan --minority sotomayor kagan jackson
  node update_cases.js 1922-10 96 --votes loss 9-0 --result "dismissed for want of jurisdiction"
  node update_cases.js 1926-10 297 --votes win                              # per curiam, unanimous
  node update_cases.js 2024-10 23-975 --recused gorsuch
  node update_cases.js 2024-10 2024-001 --minority sotomayor kagan jackson

  # Build opCite from the opinion's cited-case links
  node update_cases.js 1965-10 759 --cites
  node update_cases.js 1965-10 759 --cites --verbose --dry-run
  node update_cases.js 1965-10 --cites                     # every case in that term with opinion HTML
  node update_cases.js --cites --dry-run                   # every case in every term (preview only)
  node update_cases.js --cites --prune --dry-run           # remove reference entries the current rules
                                                             #   would no longer generate (preview only)
  node update_cases.js --top-cites                         # rebuild the Top Cited Opinions collection

  node update_cases.js --scdb                              # rebuild cache + verify all terms
  node update_cases.js --scdb --nocache                    # ignore existing cache (don't read or write)
  node update_cases.js 1926-10 --scdb                      # verify one term vs SCDB
  node update_cases.js 1926-10 1926-011 --scdb --verbose   # verify one case; show extra detail
  node update_cases.js 2024-10 --scdb                      # apply SCDB-derived fixes to cases.json
                                                           #   (records date disagreements in scdb_check;
                                                           #    fills in missing votes / vote counts)
  node update_cases.js 2024-10 --scdb --dry-run            # report SCDB differences, no writes
  node update_cases.js 2024-10 --scdb --debug              # also dump full ours/scdb JSON on mismatch
  node update_cases.js [TERM] --scdb --backfill              # list argued SCDB cases missing from cases.json
  node update_cases.js [TERM] --scdb --backfill --all        # list ALL missing SCDB cases (including unargu cases)
  node update_cases.js [TERM] --scdb --backfill --dry-run    # preview missing cases without adding
  node update_cases.js [TERM] --scdb --backfill --all --dry-run

  node update_cases.js --dates                             # check all terms vs dates.csv
  node update_cases.js 1793-02 --dates                     # check one term vs dates.csv
  node update_cases.js 1793-02 1793-001 --dates            # check one case vs dates.csv
  node update_cases.js --dates --verbose                   # also list cases absent from CSV

  node update_cases.js --verify --dry-run                  # preview events backfill, all terms
  node update_cases.js 1892-10 --verify                    # run for one term
  node update_cases.js 1892-10 1 --verify --verbose        # run for one case; also log each case's added event(s)
                                                             # For every case in scope with a recorded
                                                             #    argument/reargument date but no events[] entry for
                                                             #    it, adds a bare one (source "scdb" pre-1955, else
                                                             #    "ussc"; never touches a date that already has some
                                                             #    event, regardless of its source).

  node update_cases.js --split                             # find opinion events needing a split
  node update_cases.js 2024-10 --split                     # check one term
  node update_cases.js 2024-10 --split --dry-run           # preview splits without writing

  node update_cases.js --dissents                          # rebuild courts/ussc/people/justices/oral_dissents.json
  node update_cases.js 2024-10 --dissents                  # rebuild for one term only

  node update_cases.js --unargued                          # list all argument anomalies across all terms
  node update_cases.js 2024-10 --unargued                  # list anomalies for one term
  node update_cases.js 2024-10 24-1260 --unargued          # check one case

  # Tag a single case
  node update_cases.js 2025-10 24-1260 --tag Noteworthy
  node update_cases.js 2025-10 24-1260 --tag "Fourth Amendment"
  node update_cases.js 2025-10 24-1260 --tag Noteworthy --dry-run

  # Attach a NARA "Minutes of the U.S. Supreme Court" (M215) page reference
  # to one event: minutes_href records the catalog URL, minutes_src the
  # resolved image URL (no local copy)
  node update_cases.js 1881-10 194 --date 1882-01-28 --minutes "https://catalog.archives.gov/id/178843742?objectPage=628"
  node update_cases.js 1881-10 194 --date 1882-01-28 --minutes "https://catalog.archives.gov/id/178843742?objectPage=628" --dry-run
  node update_cases.js --minutes                           # backfill minutes_src for existing minutes_href values
  node update_cases.js --minutes --dry-run                 # preview only

  # Import tags from a JSON file (must contain a "tags" object; file is deleted after import)
  node update_cases.js --import ~/Downloads/ussc-favorites.json
  node update_cases.js --import ~/Downloads/ussc-favorites.json --dry-run

  # Podcast feeds: one RSS feed per term, plus a combined "podcast.xml" (seasons = terms)
  node update_cases.js --feeds
  node update_cases.js --feeds --dry-run

  # Sitemap: one <url> per case/term/collection/topic, for search-engine discovery
  node update_cases.js --sitemap
  node update_cases.js --sitemap --dry-run`;


// ═══════════════════════════════════════════════════════════════════════════
// --import FILE: read a JSON file containing { tags: { "ussc:TERM:NUMBER": [tag, ...] } }
// and apply any new tags to the matching cases.json entries.  The input file
// is deleted after a successful (non-dry-run) import.

async function runImportTags(filePath, dryRun) {
    const absPath = path.resolve(filePath);
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    } catch (err) {
        console.error(`ERROR: Could not read ${absPath}: ${err.message}`);
        process.exit(1);
    }

    const tagsMap = parsed?.tags;
    if (!tagsMap || typeof tagsMap !== 'object' || Array.isArray(tagsMap)) {
        console.error(`ERROR: ${absPath} must contain a "tags" object.`);
        process.exit(1);
    }

    // Group entries by term so each cases.json is loaded and written at most once.
    const byTerm = new Map(); // term -> Map(number -> string[])
    for (const [key, tags] of Object.entries(tagsMap)) {
        if (!Array.isArray(tags) || !tags.length) continue;
        const parts = key.split(':');
        if (parts.length < 3) { console.log(`  WARNING: skipping malformed key "${key}"`); continue; }
        const [court, term, ...rest] = parts;
        if (court !== 'ussc') { console.log(`  WARNING: skipping non-ussc key "${key}"`); continue; }
        const number = rest.join(':');
        if (!byTerm.has(term)) byTerm.set(term, new Map());
        byTerm.get(term).set(number, tags);
    }

    if (!byTerm.size) {
        console.log('No tags to import.');
        if (!dryRun) fs.unlinkSync(absPath);
        return;
    }

    let totalAdded = 0;
    let totalCases = 0;

    for (const [term, numberMap] of [...byTerm].sort(([a], [b]) => a.localeCompare(b))) {
        const casesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases.json');
        let cases;
        try {
            cases = _readJson(casesPath);
        } catch {
            console.log(`  WARNING: could not read ${path.relative(REPO_ROOT, casesPath)} — skipping`);
            continue;
        }
        if (!Array.isArray(cases)) continue;

        let modified = false;
        for (const [number, newTags] of numberMap) {
            const c = cases.find(x => x && (x.number === number || x.id === number));
            if (!c) {
                console.log(`  WARNING: ${term}: case "${number}" not found`);
                continue;
            }
            const existing = Array.isArray(c.tags) ? c.tags : [];
            const toAdd = newTags.filter(t => typeof t === 'string' && t && !existing.includes(t));
            if (!toAdd.length) continue;

            const label = c.number || c.id || '?';
            console.log(`  ${term}/${label}: +[${toAdd.join(', ')}]`);
            c.tags = [...existing, ...toAdd];
            // Reorder keys in-place to keep tags in schema position.
            const reordered = reorderCase(c);
            for (const k of Object.keys(c)) delete c[k];
            Object.assign(c, reordered);
            modified = true;
            totalAdded += toAdd.length;
            totalCases++;
        }

        if (modified) _writeJson(casesPath, cases);
    }

    if (totalAdded) {
        console.log(`Tags: ${dryRun ? 'Would add' : 'Added'} ${totalAdded} tag(s) to ${totalCases} case(s).`);
    } else {
        console.log('Tags: all specified tags already present; nothing to do.');
    }

    if (!dryRun) {
        try { fs.unlinkSync(absPath); console.log(`Deleted ${absPath}`); }
        catch (err) { console.error(`WARNING: could not delete ${absPath}: ${err.message}`); }
    } else {
        console.log(`[dry-run] Would delete ${absPath}`);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// --tag: add a single tag (word or quoted phrase) to one case.
// node update_cases.js TERM CASE --tag "Some Phrase"

function runTagAdd(term, caseNumber, tagValue, dryRun) {
    const tag = (tagValue || '').trim();
    if (!tag) {
        console.error('ERROR: --tag requires a non-empty word or phrase');
        process.exit(1);
    }

    const casesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases.json');
    let cases;
    try {
        cases = _readJson(casesPath);
    } catch {
        console.error(`ERROR: could not read ${path.relative(REPO_ROOT, casesPath)}`);
        process.exit(1);
    }
    if (!Array.isArray(cases)) {
        console.error(`ERROR: ${path.relative(REPO_ROOT, casesPath)} is not an array`);
        process.exit(1);
    }

    const c = cases.find(x => x && (x.id === caseNumber || (x.number || '').split(',').map(s => s.trim()).includes(caseNumber)));
    if (!c) {
        console.error(`ERROR: ${term}: case "${caseNumber}" not found`);
        process.exit(1);
    }

    const label = c.number || c.id || '?';
    const existing = Array.isArray(c.tags) ? c.tags : [];
    if (existing.includes(tag)) {
        console.log(`Tags: ${term}/${label} already has "${tag}"; nothing to do.`);
        return;
    }

    console.log(`  ${term}/${label}: +[${tag}]`);
    if (dryRun) {
        console.log(`[dry-run] Would add tag "${tag}" to ${term}/${label}`);
        return;
    }

    c.tags = [...existing, tag];
    // Reorder keys in-place to keep tags in schema position.
    const reordered = reorderCase(c);
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, reordered);

    _writeJson(casesPath, cases);
    console.log(`Tags: added "${tag}" to ${term}/${label}.`);
}


// ─────────────────────────────────────────────────────────────────────────────
// --cites: scan a case's opinion HTML for citations to earlier opinions and
// record them in a new "opCite" array ({ title, ref, count }).
//
// Full citations are identified by an italicized (<em>) case name adjacent to
// a link to another /cases/federal/us/VOL/PAGE/ opinion (Justia links early
// reporter citations like "6 Wheat. 264" to their equivalent U.S. volume, so
// this covers both modern and pre-1875 citations uniformly). Once a case has
// been cited in full, later shorthand mentions (an italicized single name
// matching the first word before or after " v. " in an established title)
// just increment that entry's count. Pincite page numbers after the primary
// citation (e.g. the "392" in "251 U. S. 385, 392") are ignored — only the
// cited opinion's own starting page (from the href) is used.
// ─────────────────────────────────────────────────────────────────────────────

// vol -> page -> { term, id, title }, built from every case's usCite.
function _buildUsCiteIndex() {
    const idx = new Map();
    const terms = fs.readdirSync(TERMS_DIR).filter(d => /^\d{4}-\d{2}$/.test(d));
    for (const term of terms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        for (const c of cases) {
            const m = /^(\d+)\s+U\.?\s*S\.?\s+(\d+)$/.exec((c.usCite || '').trim());
            if (!m) continue;
            const vol = parseInt(m[1], 10), page = parseInt(m[2], 10);
            if (!idx.has(vol)) idx.set(vol, new Map());
            idx.get(vol).set(page, { term, id: c.id, title: c.title, decision: c.decision || null });
        }
    }
    return idx;
}

// reporter name (lowercase) -> number -> U.S. Reports volume, from reports.json's
// "alt_citation" field (e.g. "6 Wheaton" on volume key "v019" -> wheaton/6 -> 19).
function _buildReporterIndex() {
    let reports;
    try { reports = _readJson(REPORTS_JSON); } catch { return new Map(); }
    const idx = new Map();
    for (const [key, entry] of Object.entries(reports || {})) {
        if (!entry?.alt_citation) continue;
        const m = /^(\d+)\s+(.+)$/.exec(entry.alt_citation.trim());
        if (!m) continue;
        const num = parseInt(m[1], 10);
        const name = m[2].trim().toLowerCase();
        const vol = parseInt(key.replace(/^v/, ''), 10);
        if (!idx.has(name)) idx.set(name, new Map());
        idx.get(name).set(num, vol);
    }
    return idx;
}

const _OPCITE_REPORTER_ABBREV = {
    dall: 'dallas', dallas: 'dallas',
    cranch: 'cranch', cr: 'cranch',
    wheat: 'wheaton', wheaton: 'wheaton',
    pet: 'peters', peters: 'peters',
    how: 'howard', howard: 'howard',
    black: 'black',
    wall: 'wallace', wallace: 'wallace',
};

function _resolveOldReporter(reporterIdx, numStr, abbrev) {
    const name = _OPCITE_REPORTER_ABBREV[abbrev.toLowerCase().replace(/\.$/, '')];
    if (!name) return null;
    return reporterIdx.get(name)?.get(parseInt(numStr, 10)) ?? null;
}

// Bound the substantive syllabus+opinion HTML region, excluding nav/header/
// audio-materials/footer chrome that can contain unrelated italicized text.
function _boundOpinionContent(html) {
    let start = html.indexOf('id="tab-opinion-');
    if (start === -1) start = 0;
    let end = html.indexOf('id="tab-materials"');
    if (end === -1) end = html.indexOf('id="footer"');
    if (end === -1) end = html.length;
    return html.slice(start, end);
}

// Leading citation-signal words that aren't part of the case name itself
// (e.g. "Cf. Betts v. Brady" -> "Betts v. Brady").
function _stripCiteSignalPrefix(s) {
    let prev;
    do {
        prev = s;
        s = s.replace(/^(see,?\s+e\.g\.,?|see\s+also|see\s+generally|see|cf\.|accord,?|compare|contra|e\.g\.,?|with)\s+/i, '').trim();
    } while (s !== prev);
    return s;
}

// Procedural-history annotations ("aff'd, 381 U. S. 654") cite the case named
// in the preceding em-span, not the annotation word itself.
const _OPCITE_PROCEDURAL_RE = /^(aff'd|affirmed|rev'd|reversed|vacated|modified|remanded|denied|granted|aff'g|rev'g|quoting|quoted in|cited in|citing|overruled(?:\s+by)?|distinguished|explained in|on remand)\.?,?$/i;

function _extractOpCites(html, usCiteIdx, reporterIdx, selfRef, { verbose = false } = {}) {
    let content = _boundOpinionContent(html);

    // Replace federal US case links with a marker holding vol:page, keeping the
    // link's inner text in place (covers both "<em>Title</em> <a>VOL U.S. PAGE</a>"
    // and "<em><a>Title</a></em>, VOL U.S. PAGE" markup styles).
    content = content.replace(
        /<a\s+[^>]*href="\/cases\/federal\/us\/(\d+)\/(\d+)\/(?:#[^"]*)?"[^>]*>([\s\S]*?)<\/a>/g,
        (_, vol, page, inner) => `\x01${vol}:${page}\x01${inner}`
    );

    content = content.replace(/<em>/g, '\x02').replace(/<\/em>/g, '\x03');
    content = content.replace(/<[^>]+>/g, ' ');
    content = _decodeHtmlEntities(content);

    const results = new Map(); // ref -> { title, ref, count }
    const order = [];
    const OLD_REPORTER_RE = /^\s*,?\s*(\d+)\s+(Dall\.?|Cranch|Wheat\.?|Pet\.?|How\.?|Black|Wall\.?)\s+(\d+)/i;
    const US_RE = /^\s*,?\s*(\d+)\s+U\.?\s*S\.?\s+(\d+)/;

    const register = (title, vol, page) => {
        const hit = usCiteIdx.get(vol)?.get(page);
        const ref = hit ? `${hit.term}/${hit.id}` : null;
        if (!ref) {
            if (verbose) console.log(`  [unresolved] "${title}" -> ${vol} U.S. ${page} (no matching case in terms data)`);
            return;
        }
        if (ref === selfRef) return; // don't cite ourselves
        if (results.has(ref)) {
            results.get(ref).count++;
        } else {
            // Use the cited case's own canonical title (from cases.json) rather than
            // however this citing opinion happened to spell/style it in its text —
            // keeps opCite titles consistent across every opinion that cites a case,
            // and immune to that opinion's own OCR typos.
            const year = /^(\d{4})-/.exec(hit.decision || '')?.[1] || null;
            const canonicalTitle = firstTitle(hit.title) || title;
            const titled = year ? `${canonicalTitle} (${year})` : canonicalTitle;
            // matchTitle keeps the opinion's own first-seen text (whatever spelling/
            // abbreviation it used) so later repeat/shorthand mentions *within this
            // same opinion* still match consistently, even though the displayed
            // title is now the canonical one from cases.json.
            results.set(ref, { title: titled, matchTitle: title, term: hit.term, id: hit.id, decision: hit.decision, count: 1 });
            order.push(ref);
        }
    };

    const incrementByTitleMatch = (title) => {
        for (const entry of results.values()) {
            if (entry.matchTitle.toLowerCase() === title.toLowerCase()) { entry.count++; return true; }
        }
        return false;
    };

    const incrementByShorthand = (word) => {
        const wl = word.toLowerCase();
        for (const entry of results.values()) {
            const parts = entry.matchTitle.split(/\s+v\.?\s+/i);
            if (parts.length < 2) continue;
            const firstOfFirst  = parts[0].trim().split(/\s+/)[0].toLowerCase().replace(/[.,]$/, '');
            const firstOfSecond = parts[1].trim().split(/\s+/)[0].toLowerCase().replace(/[.,]$/, '');
            if (wl === firstOfFirst || wl === firstOfSecond) { entry.count++; return true; }
        }
        return false;
    };

    const emRe = /\x02([\s\S]*?)\x03/g;
    let m, lastTitleSeen = null;
    while ((m = emRe.exec(content))) {
        let inner = m[1];
        const after = content.slice(emRe.lastIndex, emRe.lastIndex + 150);

        let vol = null, page = null, title;

        // Marker at the very start of the em content (title text was inside <a>),
        // allowing for leading whitespace left behind by a stripped <span> wrapper.
        const markerAtStart = /^\s*\x01(\d+):(\d+)\x01([\s\S]*)$/.exec(inner);
        if (markerAtStart) {
            vol = parseInt(markerAtStart[1], 10);
            page = parseInt(markerAtStart[2], 10);
            title = markerAtStart[3];
        } else {
            title = inner;
            const adjMarker = /^([,:;]?\s{0,10})\x01(\d+):(\d+)\x01/.exec(after);
            if (adjMarker) {
                vol = parseInt(adjMarker[2], 10);
                page = parseInt(adjMarker[3], 10);
            }
        }

        title = title.replace(/\x01\d+:\d+\x01/g, '').replace(/\s+/g, ' ').trim();
        title = title.replace(/[,:;]+$/, '').trim();
        title = title.replace(/,?\s*supra\.?$/i, '').trim();
        title = _stripCiteSignalPrefix(title);

        const hasVPattern = / v\.? /i.test(title) || /\bv\.\s*$/i.test(title);
        if (hasVPattern) lastTitleSeen = title;

        if (vol != null && page != null) {
            const useTitle = (!hasVPattern && _OPCITE_PROCEDURAL_RE.test(title) && lastTitleSeen) ? lastTitleSeen : title;
            register(useTitle, vol, page);
            continue;
        }

        if (hasVPattern) {
            // No href — fall back to a trailing plain-text citation (old reporter
            // or a bare "NUM U.S. NUM" mention that Justia didn't link).
            const usM = US_RE.exec(after);
            const oldM = OLD_REPORTER_RE.exec(after);
            if (usM) { register(title, parseInt(usM[1], 10), parseInt(usM[2], 10)); continue; }
            if (oldM) {
                const resolvedVol = _resolveOldReporter(reporterIdx, oldM[1], oldM[2]);
                if (resolvedVol != null) { register(title, resolvedVol, parseInt(oldM[3], 10)); continue; }
            }
            // No nearby citation — maybe a repeat full-title mention; match by title text.
            if (incrementByTitleMatch(title)) continue;
            if (verbose) console.log(`  [skip] full title w/o resolvable cite: "${title}"`);
            continue;
        }

        // Shorthand candidate: a short italicized proper noun, no " v. ".
        const word = title.replace(/['’]s$/i, '').replace(/[.,:;'"’]+$/, '').trim();
        if (!word || !/^[A-Z]/.test(word)) continue; // skip Latin terms, "Held:", etc.
        incrementByShorthand(word);
    }

    return order.map(ref => {
        const { title, term, id, decision, count } = results.get(ref);
        return { id, title, term, decision, count };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// opCite -> files.json "reference" entries: scan a case's own oral-argument
// transcripts for mentions of the parties named in each opCite title, and
// record a "reference" file entry (with a "refs" list of the actual words/
// phrases found) for every cited opinion that turns out to be discussed by
// name in the argument itself.
// ─────────────────────────────────────────────────────────────────────────────

const _US_STATE_NAMES = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
    'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
    'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
    'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire',
    'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
    'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia',
    'Wisconsin', 'Wyoming',
];

// Party names/phrases to strip entirely before candidate extraction: they're
// too common as case parties (all 50 states, plus "United States") to make
// useful "refs" matches on their own.
const _OPCITE_REF_STOP_PHRASES = ['United States', ..._US_STATE_NAMES.filter(n => /\s/.test(n))];
const _OPCITE_REF_STOPWORDS = new Set(['A', 'An', 'The', ..._US_STATE_NAMES.filter(n => !/\s/.test(n))]);

// Common English words that make poor "refs" even though they're capitalized
// in the source title — they're capitalized only because a title-cased case
// name happens to start a word with them (e.g. "Organization" in "Smith v.
// Organization of Foster Families...", or "In" in "In re Primus"), not
// because they're a distinctive party name/surname like "Griswold" or
// "Shelton". Checked case-insensitively against the candidate word. Not
// exhaustive — extend as more false-positive matches turn up.
const _OPCITE_REF_COMMON_WORDS = new Set([
    'in', 're', 'for', 'of', 'and', 'or', 'the', 'to', 'on', 'at', 'by', 'is',
    'as', 'it', 'be', 'his', 'her', 'its', 'our', 'their', 'from', 'with',
    'organization', 'organizations', 'association', 'associations',
    'society', 'union', 'unions', 'board', 'boards', 'county', 'counties',
    'city', 'cities', 'state', 'states', 'national', 'federal', 'department',
    'commission', 'committee', 'company', 'companies', 'corporation', 'corp',
    'inc', 'reform', 'equality', 'foster', 'family', 'families',
    'international', 'district', 'general', 'services', 'service',
    'authority', 'agency', 'bureau', 'office', 'council', 'group', 'system',
]);

// Split a "Party v. Party (YEAR)" opCite title into its two party names.
function _titleParties(title) {
    const bare = title.replace(/\s*\(\d{4}\)$/, '').trim();
    return bare.split(/\s+v\.?\s+/i).map(s => s.trim()).filter(Boolean);
}

// Extract candidate capitalized words/phrases from an opCite title's party
// names, skipping "United States", U.S. state names, leading articles ("A",
// "An", "The"), words under 3 letters, and common English words — all too
// common (as case parties, or as ordinary vocabulary) to make useful "refs".
function _extractRefCandidates(title) {
    const candidates = new Set();
    for (const party of _titleParties(title)) {
        let cleaned = party;
        for (const phrase of _OPCITE_REF_STOP_PHRASES) {
            cleaned = cleaned.replace(new RegExp('\\b' + phrase + '\\b', 'g'), ' ');
        }
        const words = cleaned.split(/\s+/).filter(Boolean);
        let run = [];
        const flush = () => {
            if (run.length) candidates.add(run.join(' '));
            run = [];
        };
        for (const w of words) {
            const bare = w.replace(/[.,;:]+$/, '');
            const qualifies = bare.length >= 3
                && /^[A-Z]/.test(bare)
                && !_OPCITE_REF_STOPWORDS.has(bare)
                && !_OPCITE_REF_COMMON_WORDS.has(bare.toLowerCase());
            if (qualifies) run.push(bare);
            else flush();
        }
        flush();
    }
    return [...candidates];
}

function _escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Find every distinct word/phrase in `corpus` matching `candidate` — an exact
// match for multi-word phrases, or a word-prefix match for single words (so
// "Bruen" also picks up derived forms like "Bruenize" mentioned at argument).
function _findRefMatches(candidate, corpus) {
    const escaped = _escapeRegExp(candidate);
    const re = /\s/.test(candidate) ? new RegExp('\\b' + escaped + '\\b', 'g')
                                     : new RegExp('\\b' + escaped + '\\w*', 'g');
    const found = new Set();
    let m;
    while ((m = re.exec(corpus))) found.add(m[0]);
    return found;
}

// term -> Map(id -> case), lazily built and cached across opCite entries.
const _caseByRefCache = new Map();
function _loadCaseByRef(term, id) {
    if (!_caseByRefCache.has(term)) {
        const map = new Map();
        try {
            const cases = _readJson(path.join(TERMS_DIR, term, 'cases.json'));
            if (Array.isArray(cases)) for (const cc of cases) if (cc?.id) map.set(cc.id, cc);
        } catch {}
        _caseByRefCache.set(term, map);
    }
    return _caseByRefCache.get(term).get(id) || null;
}

// For each opCite entry, search the case's own argument transcript(s) for
// mentions of its parties, returning { title, href, refs } for every entry
// that's actually discussed by name (href comes from the cited case's own
// decision_loc / decision_ussc / decision_rep, in that preference order).
function _computeOpCiteRefs(term, c, opCite, { verbose = false } = {}) {
    if (!opCite.length || !Array.isArray(c.events)) return [];

    const casesDir = path.join(TERMS_DIR, term, 'cases');
    const texts = [];
    for (const ev of c.events) {
        if (!ev.text_href) continue;
        let transcript;
        try { transcript = _readJson(path.join(casesDir, ev.text_href)); } catch { continue; }
        for (const t of transcript.turns || []) if (t.text) texts.push(t.text);
    }
    if (!texts.length) return [];
    const corpus = texts.join(' ');

    const refEntries = [];
    for (const entry of opCite) {
        const matches = new Set();
        for (const cand of _extractRefCandidates(entry.title)) {
            for (const found of _findRefMatches(cand, corpus)) matches.add(found);
        }
        if (!matches.size) continue;

        const cited = _loadCaseByRef(entry.term, entry.id);
        const href = cited?.decision_loc || cited?.decision_ussc || cited?.decision_rep || null;
        if (!href) {
            if (verbose) console.log(`  [ref-skip] "${entry.title}" matched but has no decision href`);
            continue;
        }

        const refs = [...matches];
        refEntries.push({ title: entry.title, href, refs: refs.length === 1 ? refs[0] : refs });
    }
    return refEntries;
}

// Append new "reference" entries to the case's files.json, skipping any
// title that's already present so repeat runs stay idempotent.
function _addReferenceEntries(term, c, refEntries) {
    if (!refEntries.length) return;

    const folderName = _caseFolder(c.number || c.id || '');
    const filesPath = path.join(TERMS_DIR, term, 'cases', folderName, 'files.json');
    let files = [];
    if (fs.existsSync(filesPath)) {
        try { files = _readJson(filesPath); } catch { files = []; }
    }
    if (!Array.isArray(files)) files = [];

    const existingTitles = new Set(files.filter(f => f?.type === 'reference').map(f => f.title));
    let added = 0;

    for (const r of refEntries) {
        if (existingTitles.has(r.title)) continue;
        files.push({ type: 'reference', title: r.title, href: r.href, refs: r.refs });
        existingTitles.add(r.title);
        added++;
        console.log(`  [ref] added "${r.title}" (refs: ${Array.isArray(r.refs) ? r.refs.join(', ') : r.refs})`);
    }

    if (added) {
        _mkdirSync(path.dirname(filesPath), { recursive: true });
        _writeJson(filesPath, files);
        console.log(`Added ${added} reference(s) to ${path.relative(REPO_ROOT, filesPath)}.`);
    }
}

// Resolve a case's opinion HTML path from its usCite, or null if the case has
// no usable usCite or no cached opinion HTML file for it.
function _resolveOpinionPath(c) {
    const m = /^(\d+)\s+U\.?\s*S\.?\s+(\d+)$/.exec((c.usCite || '').trim());
    if (!m) return null;
    const vol = parseInt(m[1], 10), page = parseInt(m[2], 10);
    const volDir = 'us' + String(vol).padStart(3, '0');
    const opinionPath = path.join(OPINIONS_HTML_DIR, volDir, `${volDir}-${String(page).padStart(4, '0')}.html`);
    return fs.existsSync(opinionPath) ? opinionPath : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// --verify backfills missing events[] entries: any case in scope with a
// recorded argument/reargument date but no events[] entry at all for that
// date gets a bare metadata-only one added (no audio_href — these dates come
// from the case's own argument/reargument fields, not an actual recording).
// A date that already has *some* event, regardless of that event's source,
// is left alone — this only fills genuine gaps.
// ═══════════════════════════════════════════════════════════════════════════

function _eventTitle(type, iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return type === 'reargument' ? 'Oral Reargument' : 'Oral Argument';
    const dateLabel = `${_MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${parseInt(m[1], 10)}`;
    return type === 'reargument' ? `Oral Reargument on ${dateLabel}` : `Oral Argument on ${dateLabel}`;
}

// Pre-1955 term events default to "scdb" (this hub's own pre-1955 argument
// dates were originally sourced from SCDB); everything else defaults to the
// generic "ussc".
function _defaultEventSource(term, c) {
    const termYear = parseInt(term.slice(0, 4), 10);
    return (termYear < 1955 && c.id) ? 'scdb' : 'ussc';
}

// Add a bare argument/reargument event for any recorded date this case
// doesn't already have *some* event for. Returns the number of events added.
function _backfillCaseEvents(c, term) {
    const knownArg   = _parseDateField(c.argument   || '');
    const knownRearg = _parseDateField(c.reargument || '');
    if (!knownArg.length && !knownRearg.length) return 0;
    if (!Array.isArray(c.events)) c.events = [];

    let added = 0;
    const addMissing = (dates, type) => {
        for (const d of dates) {
            if (c.events.some(e => e && e.date === d)) continue;
            const ev = reorderEvent({
                source: _defaultEventSource(term, c),
                type,
                date: d,
                title: _eventTitle(type, d),
            });
            const insertAt = c.events.findIndex(e => e && e.date && e.date > d);
            if (insertAt === -1) c.events.push(ev); else c.events.splice(insertAt, 0, ev);
            added++;
        }
    };
    addMissing(knownArg, 'argument');
    addMissing(knownRearg, 'reargument');
    return added;
}

async function runVerifyBackfill(termFilter, caseFilter, dryRun, { verbose = false } = {}) {
    const allTerms = fs.readdirSync(TERMS_DIR).filter(n => /^\d{4}-\d{2}$/.test(n)).sort();
    const termsToProcess = termFilter ? [termFilter] : allTerms;

    let eventsBackfilledCases = 0, eventsBackfilledTotal = 0;

    for (const term of termsToProcess) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        const filtered = caseFilter
            ? cases.filter(c => c && (
                c.id === caseFilter ||
                (c.number || '').split(',').map(s => s.trim()).includes(caseFilter)
              ))
            : cases;

        let termModified = false;

        for (const c of filtered) {
            if (!c) continue;
            const added = _backfillCaseEvents(c, term);
            if (added) {
                eventsBackfilledCases++;
                eventsBackfilledTotal += added;
                termModified = true;
                if (verbose) console.log(`  ${term}/${c.id || c.number || '?'} (${firstTitle(c.title) || '?'}): +${added} event(s)`);
            }
        }

        if (termModified && !dryRun) _writeJson(casesPath, cases);
    }

    console.log(`\nEvents: ${dryRun ? 'would add' : 'added'} ${eventsBackfilledTotal} event(s) across ${eventsBackfilledCases} case(s) missing one for a recorded argument/reargument date.`);
}

function _buildOpCiteList(opinionPath, term, c, usCiteIdx, reporterIdx, { verbose = false } = {}) {
    const html = fs.readFileSync(opinionPath, 'utf8');
    const selfRef = `${term}/${c.id}`;
    return _extractOpCites(html, usCiteIdx, reporterIdx, selfRef, { verbose })
        .filter(entry => entry.count > 1)
        .sort((a, b) => (b.decision || '').localeCompare(a.decision || ''));
}

function runOpCites(term, caseArg, dryRun, { verbose = false } = {}) {
    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    if (!fs.existsSync(casesPath)) {
        console.error(`ERROR: cases.json not found at ${casesPath}`);
        process.exit(1);
    }
    const cases = _readJson(casesPath);
    const c = Array.isArray(cases) && cases.find(x =>
        x && (x.id === caseArg || (x.number || '').split(',').map(s => s.trim()).includes(caseArg))
    );
    if (!c) {
        console.error(`ERROR: ${term}: case "${caseArg}" not found`);
        process.exit(1);
    }
    const label = c.number || c.id || '?';

    if (!/^(\d+)\s+U\.?\s*S\.?\s+(\d+)$/.exec((c.usCite || '').trim())) {
        console.error(`ERROR: ${term}/${label} has no usable usCite ("${c.usCite || ''}")`);
        process.exit(1);
    }
    const opinionPath = _resolveOpinionPath(c);
    if (!opinionPath) {
        console.error(`ERROR: opinion HTML not found for ${term}/${label}`);
        process.exit(1);
    }

    const usCiteIdx = _buildUsCiteIndex();
    const reporterIdx = _buildReporterIndex();
    const opCite = _buildOpCiteList(opinionPath, term, c, usCiteIdx, reporterIdx, { verbose });

    console.log(`${term}/${label}: found ${opCite.length} cited opinion(s)`);
    for (const entry of opCite) {
        console.log(`  [${entry.count}x] ${entry.title} -> ${entry.term}/${entry.id}`);
    }

    const refEntries = _computeOpCiteRefs(term, c, opCite, { verbose });

    if (dryRun) {
        console.log(`[dry-run] Would ${opCite.length ? 'set' : 'clear'} opCite on ${term}/${label}`);
        for (const r of refEntries) {
            console.log(`[dry-run] Would add reference "${r.title}" (refs: ${Array.isArray(r.refs) ? r.refs.join(', ') : r.refs})`);
        }
        return;
    }

    if (opCite.length) c.opCite = opCite;
    else delete c.opCite;

    const reordered = reorderCase(c);
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, reordered);

    _writeJson(casesPath, cases);
    console.log(`Wrote opCite (${opCite.length} entries) to ${term}/${label}.`);

    _addReferenceEntries(term, c, refEntries);
}

// --cites over every case in a term (or every term) that has a resolvable
// usCite and a cached opinion HTML file. Reuses the same per-case extraction
// as the single-case path; the usCite index (built once, up front) is what
// keeps opCite entries limited to citations that match one of our own cases.
function runOpCitesBulk(termFilter, dryRun, { verbose = false } = {}) {
    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
            if (page.term) return page.term;
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return m ? m[1] : null;
        })).filter(Boolean);
    } catch {}

    const termsToProcess = termFilter ? [termFilter] : allTerms;
    const usCiteIdx = _buildUsCiteIndex();
    const reporterIdx = _buildReporterIndex();

    let scanned = 0, changed = 0;

    for (const term of termsToProcess) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        let termChanged = false;

        for (const c of cases) {
            const opinionPath = _resolveOpinionPath(c);
            if (!opinionPath) continue;
            scanned++;

            const label = c.number || c.id || '?';
            const opCite = _buildOpCiteList(opinionPath, term, c, usCiteIdx, reporterIdx, { verbose });

            const before = JSON.stringify(c.opCite || null);
            const after = JSON.stringify(opCite.length ? opCite : null);
            if (before === after) continue;
            changed++;

            console.log(`${term}/${label}: ${(c.opCite || []).length} -> ${opCite.length} cited opinion(s)`);
            const refEntries = _computeOpCiteRefs(term, c, opCite, { verbose });

            if (dryRun) {
                console.log(`[dry-run] Would ${opCite.length ? 'set' : 'clear'} opCite on ${term}/${label}`);
                for (const r of refEntries) {
                    console.log(`[dry-run] Would add reference "${r.title}" (refs: ${Array.isArray(r.refs) ? r.refs.join(', ') : r.refs})`);
                }
                continue;
            }

            if (opCite.length) c.opCite = opCite;
            else delete c.opCite;

            const reordered = reorderCase(c);
            for (const k of Object.keys(c)) delete c[k];
            Object.assign(c, reordered);
            termChanged = true;

            _addReferenceEntries(term, c, refEntries);
        }

        if (termChanged) {
            _writeJson(casesPath, cases);
            console.log(`Wrote ${path.relative(REPO_ROOT, casesPath)}.`);
        }
    }

    console.log(`Scanned ${scanned} case(s) with opinion HTML; updated opCite on ${changed} case(s).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// --cites --prune: one-time cleanup for reference entries that were added by
// an earlier, looser version of _extractRefCandidates (before it excluded
// sub-3-letter and common-English-word candidates — see
// _OPCITE_REF_COMMON_WORDS). --cites itself won't touch these on a normal
// re-run: _addReferenceEntries() only ever *adds* entries and skips any
// title it's already seen, and runOpCitesBulk() only recomputes refs for a
// case when its opCite list itself changed. This instead recomputes refs
// fresh for every case with existing "reference" file entries, regardless of
// whether opCite changed, and reconciles each one against the fresh result:
//   - a title the current rules no longer match at all (no surviving
//     candidate word) is removed entirely;
//   - a title that still matches, but whose stored refs list mixes a
//     legitimate word with now-filtered noise (e.g. "In re Oliver (1948)"
//     stored as refs: ["Oliver", "In", "Inaudible", "Indeed", ...]) has its
//     refs list replaced with the freshly computed one;
//   - a title with no existing entry that the fresh rules now match (e.g. an
//     opinion previously dropped for a generic-word-only match like
//     "National Association ...", which may still be legitimately discussed
//     by name via a different, better candidate from the same title, like
//     "Advancement") gets added — so a citation doesn't just disappear as a
//     side effect of cleaning up its old, badly-worded entry.
// ─────────────────────────────────────────────────────────────────────────────
function runPruneRefs(termFilter, caseFilter, dryRun, { verbose = false } = {}) {
    let allTerms = fs.readdirSync(TERMS_DIR).filter(n => /^\d{4}-\d{2}$/.test(n)).sort();
    if (termFilter) allTerms = allTerms.filter(t => t === termFilter);

    let scannedFiles = 0, removed = 0, updated = 0, added = 0, affectedFiles = 0;

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        for (const c of cases) {
            if (!c.opCite?.length) continue;
            const label = c.number || c.id || '?';
            if (caseFilter && label !== caseFilter && c.id !== caseFilter) continue;

            const folderName = _caseFolder(c.number || c.id || '');
            const filesPath = path.join(TERMS_DIR, term, 'cases', folderName, 'files.json');
            if (!fs.existsSync(filesPath)) continue;
            let files;
            try { files = _readJson(filesPath); } catch { continue; }
            if (!Array.isArray(files)) continue;
            const refFiles = files.filter(f => f?.type === 'reference');
            if (!refFiles.length) continue;
            scannedFiles++;

            const fresh = _computeOpCiteRefs(term, c, c.opCite, { verbose });
            const freshByTitle = new Map(fresh.map(r => [r.title, r]));
            const existingTitles = new Set(refFiles.map(f => f.title));

            let fileChanged = false;
            const staleFiles = new Set(); // object refs — same entries as in `files`
            for (const f of refFiles) {
                const freshEntry = freshByTitle.get(f.title);
                const oldRefsStr = JSON.stringify(f.refs);
                if (!freshEntry) {
                    staleFiles.add(f);
                    removed++;
                    fileChanged = true;
                    console.log(`${dryRun ? '[dry-run] Would remove' : '[prune] Removing'} "${f.title}" `
                        + `(refs: ${Array.isArray(f.refs) ? f.refs.join(', ') : f.refs}) from ${path.relative(REPO_ROOT, filesPath)}`);
                } else if (JSON.stringify(freshEntry.refs) !== oldRefsStr) {
                    updated++;
                    fileChanged = true;
                    console.log(`${dryRun ? '[dry-run] Would update' : '[prune] Updating'} "${f.title}" refs: `
                        + `${oldRefsStr} -> ${JSON.stringify(freshEntry.refs)} in ${path.relative(REPO_ROOT, filesPath)}`);
                    if (!dryRun) f.refs = freshEntry.refs;
                }
            }
            const toAdd = fresh.filter(r => !existingTitles.has(r.title));
            for (const r of toAdd) {
                added++;
                fileChanged = true;
                console.log(`${dryRun ? '[dry-run] Would add' : '[prune] Adding'} "${r.title}" `
                    + `(refs: ${Array.isArray(r.refs) ? r.refs.join(', ') : r.refs}) to ${path.relative(REPO_ROOT, filesPath)}`);
            }
            if (!fileChanged) continue;
            affectedFiles++;

            if (!dryRun) {
                let kept = files.filter(f => !(f?.type === 'reference' && staleFiles.has(f)));
                for (const r of toAdd) {
                    kept.push({ type: 'reference', title: r.title, href: r.href, refs: r.refs });
                }
                _writeJson(filesPath, kept);
            }
        }
    }

    const verb = dryRun ? 'Would remove/update/add' : 'Removed/updated/added';
    console.log(`Scanned ${scannedFiles} files.json with reference entries. `
        + `${verb} ${removed}/${updated}/${added} entry(ies) across ${affectedFiles} file(s).`);
}

// ─────────────────────────────────────────────────────────────────────────────
// --top-cites: build courts/ussc/collections/cites/top_cites.json — an ordinary
// embedded-format collection (like rare_words.json/oral_dissents.json:
// [{ name, link, cases: [...] }, ...]) of the most-cited opinions across
// every term, ranked by how many *other* cases' opCite array references them
// (not the per-citing-opinion mention count — see --cites above). Each
// entry's "name" is looked up fresh from the cited case's own title/decision
// (not copied from a citing opinion's opCite entry) so it's always
// canonical, its "link" opens the cited opinion itself, and
// its "cases" array — the citing opinions — is sorted by title ascending.
// ─────────────────────────────────────────────────────────────────────────────

const TOP_CITES_COUNT = 250;

function runTopCites(dryRun) {
    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
            if (page.term) return page.term;
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return m ? m[1] : null;
        })).filter(Boolean);
    } catch {}

    const caseByRef = new Map(); // "term/id" -> case
    const citedBy   = new Map(); // "term/id" -> [ { title, term, number, argument, decision }, ... ]

    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        for (const c of cases) {
            caseByRef.set(`${term}/${c.id}`, c);
            if (!Array.isArray(c.opCite) || !c.opCite.length) continue;

            const decMatch = /^(\d{4})/.exec(c.decision || '');
            const baseTitle = firstTitle(c.title) || '';
            const citerEvents = Array.isArray(c.events) ? c.events : [];
            const citerEntry = {
                title: decMatch ? `${baseTitle} (${decMatch[1]})` : baseTitle,
                term,
                number: _primaryCaseNumber(c),
                argument: c.argument || '',
                decision: c.decision || '',
            };
            if (citerEvents.some(e => e.audio_href)) citerEntry.event      = true;
            if (citerEvents.some(e => e.text_href))  citerEntry.transcript = true;
            for (const entry of c.opCite) {
                const ref = `${entry.term}/${entry.id}`;
                if (!citedBy.has(ref)) citedBy.set(ref, []);
                citedBy.get(ref).push(citerEntry);
            }
        }
    }

    const ranked = [...citedBy.entries()]
        .map(([ref, citers]) => {
            const cited = caseByRef.get(ref);
            if (!cited) return null;
            const decMatch = /^(\d{4})/.exec(cited.decision || '');
            const baseTitle = firstTitle(cited.title) || '';
            const name = decMatch ? `${baseTitle} (${decMatch[1]})` : baseTitle;
            const refTerm = ref.slice(0, ref.indexOf('/'));
            const link = `/courts/ussc/?term=${refTerm}&case=${_primaryCaseNumber(cited)}`;
            return { name, link, cases: citers.slice().sort((a, b) => a.title.localeCompare(b.title)) };
        })
        .filter(Boolean)
        .sort((a, b) => b.cases.length - a.cases.length || a.name.localeCompare(b.name))
        .slice(0, TOP_CITES_COUNT);

    const jsonPath = path.join(REPO_ROOT, 'courts', 'ussc', 'collections', 'cites', 'top_cites.json');
    const content = JSON.stringify(ranked, null, 2) + '\n';

    if (dryRun) {
        console.log(`[dry-run] Would write ${ranked.length} opinion(s) to courts/ussc/collections/cites/top_cites.json`);
        return;
    }

    let changed = true;
    try { changed = fs.readFileSync(jsonPath, 'utf8') !== content; } catch { /* new file */ }
    if (changed) fs.writeFileSync(jsonPath, content, 'utf8');
    console.log(`Top cites: wrote ${ranked.length} opinion(s) → courts/ussc/collections/cites/top_cites.json`);
}


// ─────────────────────────────────────────────────────────────────────────────
// --missing-cite: list decided cases that have no usCite
// ─────────────────────────────────────────────────────────────────────────────

function runMissingCite(termFilter, { argued = false } = {}) {
    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
            if (page.term) return page.term;
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return m ? m[1] : null;
        })).filter(Boolean);
    } catch {}

    const termsToProcess = termFilter ? [termFilter] : allTerms;
    let total = 0;

    for (const term of termsToProcess) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        for (const c of cases) {
            if (!c.decision || c.usCite) continue;
            if (argued) {
                const hasArgDate = !!(c.argument || c.reargument ||
                    (c.events || []).some(e => e && (e.type === 'argument' || e.type === 'reargument') && e.date));
                if (!hasArgDate) continue;
            }
            const number = c.number || c.id || '?';
            const title  = (firstTitle(c.title) || '').slice(0, 60);
            console.log(`${term}/${number}  ${title}`);
            total++;
        }
    }

    console.log(`${total} case(s) missing usCite.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// --dissents: build courts/ussc/people/justices/oral_dissents.json
// Contains sets per term for any "opinion" event whose title does not start
// with "Opinion". Each set is named "October Term YYYY" and its cases list
// objects: { title, term, number, decision, event (1-based index) }.
// ═══════════════════════════════════════════════════════════════════════════

async function runDissentCheck(termFilter) {
    const termsDir   = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
    const outPath    = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices', 'oral_dissents.json');

    // Build term→title map from terms.json.
    let termTitleMap = {};
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        for (const decade of tj) {
            for (const page of (decade.groups || [])) {
                const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
                const termKey = page.term || (m ? m[1] : null);
                if (termKey && (page.name || page.title)) termTitleMap[termKey] = page.name || page.title;
            }
        }
    } catch {}

    // Collect all terms in chronological (oldest-first) order — terms.json
    // itself stores decades/terms newest-first, so this output's per-term
    // group order (and the "group=" URL param it defines) doesn't depend on
    // that file's storage order.
    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        allTerms = tj.slice().reverse().flatMap(decade => (decade.groups || []).slice().reverse().map(page => {
            if (page.term) return page.term;
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return m ? m[1] : null;
        })).filter(Boolean);
    } catch {}

    const termsToProcess = termFilter ? [termFilter] : allTerms;

    // If we're only rebuilding one term, load existing output to merge.
    let existingSets = [];
    if (termFilter && fs.existsSync(outPath)) {
        try { existingSets = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
    }

    const newSets = [];

    for (const term of termsToProcess) {
        const casesPath = path.join(termsDir, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        const cases = _readJson(casesPath);
        if (!Array.isArray(cases)) continue;

        const termCases = [];
        for (const c of cases) {
            if (!Array.isArray(c.events)) continue;
            for (let i = 0; i < c.events.length; i++) {
                const ev = c.events[i];
                if (ev.type !== 'decision') continue;
                const title = ev.title || '';
                if (title.startsWith('Opinion')) continue;
                // This opinion event's title is non-standard. A case can have
                // more than one (e.g. separate "Oral Announcement by Justice X"
                // events for several dissenting/concurring justices), so each
                // qualifying event gets its own entry rather than stopping at
                // the first match.
                termCases.push({
                    title:    `${firstTitle(c.title) || c.id}: ${title}`,
                    term,
                    number:   _primaryCaseNumber(c) || undefined,
                    decision: c.decision || undefined,
                    event:    i + 1,
                });
            }
        }

        if (!termCases.length) continue;

        const setTitle = termTitleMap[term] || term;
        newSets.push({ name: setTitle, cases: termCases });
    }

    // Merge: replace or append sets for processed terms.
    let finalSets;
    if (termFilter) {
        // Remove any existing set for this term, then append new one.
        finalSets = existingSets.filter(s => s.name !== (termTitleMap[termFilter] || termFilter));
        finalSets.push(...newSets);
    } else {
        finalSets = newSets;
    }

    const dissentsChanged = _jsonChanged(outPath, finalSets);
    if (dissentsChanged) fs.writeFileSync(outPath, JSON.stringify(finalSets, null, 2) + '\n', 'utf8');
    if (_VERBOSE || dissentsChanged) console.log(`Wrote ${path.relative(REPO_ROOT, outPath)} (${finalSets.length} set(s))`);}

// ═══════════════════════════════════════════════════════════════════════════
// --roles: derive event advocate roles from transcript JSON, raw transcript
// text, and the per-year SCOTUS journal. A role is appended with "*" when
// only one source confirms it; with two or more sources it's left bare.
// ═══════════════════════════════════════════════════════════════════════════

const PARTY_PETITIONER_TERMS = ['petitioner', 'appellant', 'plaintiff', 'complainant'];
const PARTY_RESPONDENT_TERMS = ['respondent', 'appellee', 'defendant'];
const PARTY_ALL_ROLE_TERMS   = [...PARTY_PETITIONER_TERMS, ...PARTY_RESPONDENT_TERMS];
const PARTY_JUSTICE_TITLES   = new Set(['JUSTICE', 'CHIEF JUSTICE']);
// Hyphen-like characters that may appear in journal text in place of "-".
const PARTY_HYPHEN_CLASS = '[-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212]';

function _partyRoleSide(role) {
    if (!role) return null;
    const r = String(role).toLowerCase().replace(/\*$/, '');
    if (PARTY_PETITIONER_TERMS.includes(r)) return 'petitioner';
    if (PARTY_RESPONDENT_TERMS.includes(r)) return 'respondent';
    return null;
}

function _partySurname(name) {
    if (!name) return '';
    const cleaned = String(name).replace(/[.,]/g, ' ').trim();
    if (!cleaned) return '';
    const parts = cleaned.split(/\s+/).filter(p => !/^(JR|SR|II|III|IV|ESQ)$/i.test(p));
    return (parts[parts.length - 1] || '').replace(/[^A-Za-z\-']/g, '');
}

function _partyEscapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _partyHyphenVariants(num) {
    return _partyEscapeRegex(num).replace(/-/g, PARTY_HYPHEN_CLASS);
}

// Read the transcript envelope and return the ordered list of non-justice
// speakers (in the order they first appear in turns) plus a name->title map.
function _partyReadTranscript(transcriptPath) {
    let env;
    try { env = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')); }
    catch { return null; }
    if (!env || typeof env !== 'object') return null;
    const speakers = Array.isArray(env?.media?.speakers) ? env.media.speakers : [];
    const titles = {};
    for (const sp of speakers) titles[sp.name || ''] = sp.title || '';
    const turns = Array.isArray(env.turns) ? env.turns
                : Array.isArray(env)        ? env
                : [];
    const seen = new Set();
    const order = [];
    for (const t of turns) {
        const n = (t && t.name) || '';
        if (!n || seen.has(n)) continue;
        const title = (titles[n] || '').toUpperCase();
        if (PARTY_JUSTICE_TITLES.has(title)) continue;
        if (title.includes('NP')) continue;
        if (/^UNKNOWN/i.test(n)) continue;
        // Exclude court officials (e.g. "THE MARSHAL") from advocate lists.
        if (n.toUpperCase() === 'THE MARSHAL') continue;
        seen.add(n);
        order.push(n);
    }
    return { order, titles };
}

// Search the (raw) transcript text for "<surname> ... on behalf of (the) <role>".
// Allows up to two capitalised modifier words before the role term so that
// "on behalf of the Federal Respondents" matches "respondent". If the
// appearance line continues with "...supporting the <other-role>...",
// the supporting-role wins — e.g. an amicus "on behalf of the Federal
// Respondents, supporting the Petitioners" should map to petitioner.
function _partyFindRoleInText(text, surname) {
    if (!text || !surname) return null;
    const esc = _partyEscapeRegex(surname);
    const roleAlt = PARTY_ALL_ROLE_TERMS
        .map(r => `[${r[0].toUpperCase()}${r[0]}]${r.slice(1)}`)
        .join('|');
    // Soft whitespace: tolerates the line-number columns ("\n\n6   ") that
    // pdftotext leaves inside multi-line appearance blocks.
    const ws = `(?:\\s+\\d{1,3}\\s+|\\s+)`;
    // Optional "the " plus 0-2 capitalised modifier words (e.g. "Federal").
    const lead = `(?:[Tt]he${ws})?(?:[A-Z][a-zA-Z]+${ws}){0,2}`;
    const supportRe = new RegExp(
        `^[\\s\\S]{0,200}?[Ss]upporting${ws}(?:[Tt]he${ws}|[Nn]either${ws})?(${roleAlt})s?`,
        '',
    );
    const resolve = (matchedRole, tail) => {
        const sm = supportRe.exec(tail || '');
        return (sm ? sm[1] : matchedRole).toLowerCase();
    };
    // Forward search: name precedes role mention.
    const fwd = new RegExp(
        `\\b${esc}\\b[\\s\\S]{0,400}?on${ws}behalf${ws}of${ws}${lead}(${roleAlt})s?`,
        '',
    );
    let m = fwd.exec(text);
    if (m) return resolve(m[1], text.slice(m.index + m[0].length));
    // Reverse search: role mention precedes name (e.g. "ORAL ARGUMENT OF X ON BEHALF OF THE PETITIONER").
    const back = new RegExp(
        `on${ws}behalf${ws}of${ws}${lead}(${roleAlt})s?([\\s\\S]{0,400}?)\\b${esc}\\b`,
        '',
    );
    m = back.exec(text);
    if (!m) return null;
    const afterRole = m[2] || '';
    const sm1 = supportRe.exec(afterRole);
    if (sm1) return sm1[1].toLowerCase();
    return resolve(m[1], text.slice(m.index + m[0].length));
}

// Scan a journal year file for a "No. <docket>." block and extract
// "...by <Honorific> <Name> for (the) <role>..." pairings.
function _partyFindRolesInJournal(journalText, docket) {
    if (!journalText || !docket) return [];
    const numRe = new RegExp(
        `No\\.\\s*${_partyHyphenVariants(docket)}(?![\\d${PARTY_HYPHEN_CLASS.slice(1, -1)}])[\\s\\S]{0,1200}`,
        'g',
    );
    const out = [];
    let m;
    while ((m = numRe.exec(journalText)) !== null) {
        const block = m[0];
        // Stop block at the next "No. <docket>." entry to avoid leaking
        // into the following case.
        const nextIdx = block.search(/\bNo\.\s*\d/i);
        const slice = nextIdx > 40 ? block.slice(0, nextIdx) : block;
        // by [honorific] First [Middle] LastName ... for (the) ROLE
        // NB: case-sensitive (no /i) so [A-Z] really means uppercase — the
        // journal uses Title-Case honorifics ("Mrs.") and lowercase roles
        // ("for the petitioner").
        const partRe = new RegExp(
            `by\\s+(?:Mr\\.?|Mrs\\.?|Ms\\.?|Miss|Dr\\.?|General|Solicitor\\s+General|Attorney\\s+General)\\s+` +
            `((?:[A-Z][A-Za-z'\\-]*\\.?\\s+){0,4}[A-Z][A-Za-z'\\-]+)` +
            `[^A-Za-z]{1,80}?for\\s+(?:the\\s+)?(${PARTY_ALL_ROLE_TERMS.join('|')})s?`,
            'g',
        );
        let pm;
        while ((pm = partRe.exec(slice)) !== null) {
            const surname = _partySurname(pm[1]);
            const role    = pm[2].toLowerCase();
            if (surname) out.push([surname, role]);
        }
        if (out.length) break;
    }
    return out;
}

function _partyVerifyTerm(termDir, term, caseFilter, dryRun) {
    const casesPath = path.join(termDir, 'cases.json');
    if (!fs.existsSync(casesPath)) return 0;
    const cases = _readJson(casesPath);
    if (!Array.isArray(cases)) return 0;
    const casesDir = path.join(termDir, 'cases');

    const journalDir = path.join(REPO_ROOT, 'courts', 'ussc', 'journals', 'text');
    const transcriptDir = path.join(REPO_ROOT, 'courts', 'ussc', 'transcripts', 'text');
    const journalCache = {};
    const loadJournal = (year) => {
        if (year in journalCache) return journalCache[year];
        const p = path.join(journalDir, `${year}.txt`);
        try { journalCache[year] = fs.readFileSync(p, 'utf8'); }
        catch { journalCache[year] = null; }
        return journalCache[year];
    };

    let casesChanged = 0;
    let modifiedFile = false;

    for (const c of cases) {
        if (caseFilter) {
            const nums = (c.number || '').split(',').map(s => s.trim());
            if (c.id !== caseFilter && !nums.includes(caseFilter)) continue;
        }
        if (!Array.isArray(c.events)) continue;
        const docket = (c.number || '').split(',')[0].trim();
        if (!docket) continue;

        let caseModified = false;
        // For early terms (≤1999-10), prefer the Oyez transcript when both
        // sources cover the same date — and skip the USSC event entirely so
        // we don't seed ev.advocates with USSC-transcript-only name variants
        // (e.g. "ANN M. KAPPLER") that would later collide with the Oyez
        // variant ("ANN MARY KAPPLER") in update_advocates.js. Mirrors the
        // skipUsscTranscript logic in scripts/update_advocates.js.
        const isEarlyTerm = term <= '1999-10';
        const oyezDates = new Set();
        if (isEarlyTerm) {
            for (const e of c.events) {
                if (e && e.source === 'oyez' && e.text_href) {
                    const d = e.date || c.argument || '';
                    if (d) oyezDates.add(d);
                }
            }
        }
        for (const ev of c.events) {
            if (ev.type !== 'argument' && ev.type !== 'reargument') continue;
            if (!ev.text_href) continue;
            const evDate = ev.date || c.argument || '';
            if (isEarlyTerm && ev.source === 'ussc' && oyezDates.has(evDate)) continue;
            const transcriptPath = path.join(casesDir, ev.text_href);
            const info = _partyReadTranscript(transcriptPath);
            if (!info || info.order.length === 0) continue;

            const date = ev.date || '';
            const year = date.slice(0, 4);

            // Raw transcript text (cached PDF-extracted) — limit search to the
            // first ~12 KB which covers the appearances + opening pages.
            let rawText = null;
            if (year && docket) {
                const candidates = [
                    path.join(transcriptDir, year, `${docket}_${date}.txt`),
                ];
                for (const p of candidates) {
                    if (fs.existsSync(p)) {
                        try { rawText = fs.readFileSync(p, 'utf8').slice(0, 12000); }
                        catch {}
                        break;
                    }
                }
            }

            const journalText = year ? loadJournal(year) : null;
            const journalEntries = journalText ? _partyFindRolesInJournal(journalText, docket) : [];

            // Heuristic: first non-justice speaker = petitioner-side;
            // last different non-justice speaker = respondent-side.
            const petitionerName = info.order[0] || null;
            const respondentName = info.order.slice(1).reverse()
                                       .find(n => n && n !== petitionerName) || null;
            const heuristicRole = {};
            if (petitionerName) heuristicRole[petitionerName] = 'petitioner';
            if (respondentName) heuristicRole[respondentName] = 'respondent';

            const computed = [];
            for (const name of info.order) {
                const surname = _partySurname(name);
                // role -> Set of source labels
                const votes = {};
                const add = (role, src) => {
                    if (!role) return;
                    (votes[role] = votes[role] || new Set()).add(src);
                };
                if (heuristicRole[name]) add(heuristicRole[name], 'heuristic');
                if (rawText)             add(_partyFindRoleInText(rawText, surname), 'text');
                if (journalEntries.length) {
                    for (const [jSurname, jRole] of journalEntries) {
                        if (jSurname && jSurname.toLowerCase() === surname.toLowerCase()) {
                            add(jRole, 'journal');
                            break;
                        }
                    }
                }
                const entries = Object.entries(votes);
                if (!entries.length) {
                    // No role detected — still record the speaker so they
                    // appear in ev.advocates (with no role). Court officials
                    // like "THE MARSHAL" are filtered out earlier.
                    computed.push({ name, title: info.titles[name] || '', _sources: [] });
                    continue;
                }
                // Pick the role with the most distinct sources; on ties prefer
                // the one *not* coming solely from the heuristic.
                entries.sort((a, b) => {
                    if (b[1].size !== a[1].size) return b[1].size - a[1].size;
                    const aH = a[1].has('heuristic') && a[1].size === 1 ? 1 : 0;
                    const bH = b[1].has('heuristic') && b[1].size === 1 ? 1 : 0;
                    return aH - bH;
                });
                const [role, sources] = entries[0];
                const finalRole = sources.size >= 2 ? role : `${role}*`;
                computed.push({ name, title: info.titles[name] || '', role: finalRole, _sources: [...sources] });
            }
            if (!computed.length) continue;

            // Decide whether it's safe to (re)write ev.advocates.
            //
            // If an "advocates" array already exists, we only overwrite it when
            // every existing entry maps to a computed entry by name. Extra
            // existing names not in the transcript leave the array untouched
            // and emit a single WARNING.
            //
            // Role conflicts (existing role vs. computed role on a different
            // side) are *not* warnings: with --update we overwrite them with
            // the newer computed role; without --update we log what would
            // change so the user can review before re-running.
            const existing = Array.isArray(ev.advocates) ? ev.advocates : [];
            const computedByName = new Map(computed.map(c => [c.name || '', c]));
            const conflicts = [];
            const roleOverrides = [];   // [{name, oldRole, newRole, sources}]
            for (const ex of existing) {
                const exName = ex.name || '';
                const cand = computedByName.get(exName);
                if (!cand) {
                    conflicts.push(`existing advocate '${exName}' not found among transcript speakers`);
                    continue;
                }
                const exRoleRaw = ex.role || '';
                if (!exRoleRaw) continue;            // missing role: fine to fill in
                const candRoleRaw = cand.role || '';
                if (!candRoleRaw) continue;          // computed has no role: keep existing
                const exRole  = exRoleRaw.replace(/\*$/, '').toLowerCase();
                const newRole = candRoleRaw.replace(/\*$/, '').toLowerCase();
                if (exRole === newRole) continue;    // same alias: fine
                const exSide  = _partyRoleSide(exRoleRaw);
                const newSide = _partyRoleSide(cand.role);
                if (exSide && newSide && exSide === newSide) continue; // same side, different alias: fine
                roleOverrides.push({
                    name: exName,
                    oldRole: exRoleRaw,
                    newRole: candRoleRaw,
                    sources: cand._sources,
                });
            }
            if (conflicts.length) {
                console.log(`[roles] ${term}/${docket} ${ev.date}: WARNING — leaving existing advocates unchanged:`);
                for (const msg of conflicts) console.log(`    ${msg}`);
                continue;
            }
            if (roleOverrides.length) {
                const verb = dryRun ? 'would override' : 'overriding';
                console.log(`[roles] ${term}/${docket} ${ev.date}: ${verb} existing role(s):`);
                for (const o of roleOverrides) {
                    const tag = o.sources && o.sources.length ? `  (${o.sources.join(',')})` : '';
                    console.log(`    '${o.name}': '${o.oldRole}' → '${o.newRole}'${tag}`);
                }
            }

            // Build the replacement list. For each computed advocate, prefer
            // an existing entry's role when it's already confirmed (no '*')
            // and on the same side; otherwise use the computed role.
            const merged = [];
            const existingByName = new Map(existing.map(a => [a.name || '', a]));
            for (const cand of computed) {
                const ex = existingByName.get(cand.name);
                if (ex) {
                    const exRoleRaw = ex.role || '';
                    const exConfirmed = exRoleRaw && !exRoleRaw.endsWith('*');
                    const exSide  = _partyRoleSide(exRoleRaw);
                    const newSide = _partyRoleSide(cand.role);
                    const useExisting = exRoleRaw && (
                        !cand.role ||
                        (exConfirmed && exSide && newSide && exSide === newSide)
                    );
                    const finalRole = useExisting ? exRoleRaw : (cand.role || '');
                    const entry = { name: cand.name, title: ex.title || cand.title };
                    if (finalRole) entry.role = finalRole;
                    merged.push(entry);
                } else {
                    const entry = { name: cand.name, title: cand.title };
                    if (cand.role) entry.role = cand.role;
                    merged.push(entry);
                }
            }

            const beforeJson = JSON.stringify(existing.map(reorderAdvocate));
            const afterJson  = JSON.stringify(merged.map(reorderAdvocate));
            if (beforeJson === afterJson) continue;

            const verb = dryRun ? 'would set' : 'set';
            console.log(`[roles] ${term}/${docket} ${ev.date}: ${verb} advocates`);
            for (const a of merged) {
                const sources = computed.find(x => x.name === a.name)?._sources || [];
                const tag = sources.length ? `  (${sources.join(',')})` : '';
                console.log(`    ${a.role || '?'}\t${a.title || ''} ${a.name}${tag}`);
            }
            ev.advocates = merged.map(reorderAdvocate);
            caseModified = true;
        }
        if (caseModified) {
            casesChanged++;
            modifiedFile = true;
        }
    }

    if (modifiedFile && !dryRun) _writeJson(casesPath, cases);
    return casesChanged;
}

async function processOneTerm(term, opts) {
    const { checkUrls, opinionsOnly, verbose, dryRun, allTerms, speakerMapBase, roles, speakers } = opts;
    let { caseFilter } = opts;
    const termDir = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term);
    if (!isDir(termDir)) {
        console.log(`Skipping ${term}: directory not found.`);
        return null;
    }

    // Resolve a caseFilter that's an `id` (e.g. "1986-091") to the case directory
    // name (the docket number, e.g. "85-2099"), so verifyCase / applySpeakerMapToCase
    // operate on the right folder.
    if (caseFilter) {
        const casesPathForLookup = path.join(termDir, 'cases.json');
        const casesDir = path.join(termDir, 'cases');
        const dirExists = isDir(path.join(casesDir, caseFilter));
        if (!dirExists && fs.existsSync(casesPathForLookup)) {
            const arr = _readJson(casesPathForLookup);
            if (Array.isArray(arr)) {
                const match = arr.find(c => c && (c.id === caseFilter || (c.number || '').split(',').map(s => s.trim()).includes(caseFilter)));
                if (match && match.number) {
                    const primary = match.number.split(',')[0].trim();
                    if (primary && isDir(path.join(casesDir, primary))) {
                        caseFilter = primary;
                    }
                }
            }
        }
    }

    if (!caseFilter) {
        checkDuplicateCaseIds(termDir, term);
        checkDuplicateCaseNumbers(termDir, term, verbose);
        checkDuplicateAudioHrefs(termDir);
        checkCasesSync(termDir, verbose);
    }

    let missingVotes = 0;
    const casesPath = path.join(termDir, 'cases.json');
    if (fs.existsSync(casesPath)) {
        if (!caseFilter) {
            migrateArgumentsToAudio(casesPath);
            if (!dryRun) removeRedundantTranscriptFiles(casesPath);
            deduplicateCases(casesPath);
            verifyCasesJsonArguments(casesPath, term, dryRun);
            normalizeAudioAlignedPosition(casesPath);
            checkAudioDates(casesPath, term, dryRun);
            checkDecisionDates(casesPath, term);
            checkVoteTenures(casesPath, term);
            missingVotes = checkArgumentsHaveVotes(casesPath, term);
            backfillUntrackedFiles(casesPath, term, dryRun);
        }
        pruneRedundantCitation(casesPath, term, caseFilter || '');
        if (!dryRun) {
            const _tj = (() => { try { return _readJson(TERMS_JSON); } catch { return []; } })();
            const _termEntry = _tj.flatMap(d => d.groups || []).find(g => {
                const m = /\/terms\/([^/]+)\/cases\.json$/.exec(g.file || '');
                return m && m[1] === term;
            });
            if (_termEntry?.reports?.length) {
                // Patch pages from reports.json (may have been manually updated
                // since the last --reports run) so decision_rep uses current values.
                let _reportsDb = {};
                try { const raw = _readJson(REPORTS_JSON); if (raw && !Array.isArray(raw)) _reportsDb = raw; } catch {}
                let _tjModified = false;
                for (const r of _termEntry.reports) {
                    if (r.volume == null) continue;
                    const volKey = `v${String(r.volume).padStart(3, '0')}`;
                    const dbPn = _reportsDbPages(_reportsDb[volKey]);
                    if (dbPn == null || dbPn === r.pages) continue;
                    const dbBps = _parsePages(dbPn).filter(e => !e.roman);
                    const tjBps = _parsePages(r.pages || '').filter(e => !e.roman);
                    const same = dbBps.length === tjBps.length &&
                        dbBps.every((bp, i) => tjBps[i]?.start === bp.start && tjBps[i]?.pdfPage === bp.pdfPage);
                    const tjExt = !same && tjBps.length > dbBps.length &&
                        dbBps.every((bp, i) => tjBps[i]?.start === bp.start && tjBps[i]?.pdfPage === bp.pdfPage);
                    if (!same && !tjExt) { r.pages = dbPn; _tjModified = true; }
                }
                if (_tjModified) _writeJson(TERMS_JSON, _tj);
                addDecisionReports(casesPath, _termEntry, caseFilter || '');
            }
        }
        if (checkUrls && !caseFilter) await checkCaseHrefs(casesPath, term, opinionsOnly);
    }

    const speakerMap = [...speakerMapBase, ...filterSpeakerMap(loadSpeakerMap(), term)];

    if (caseFilter) {
        await verifyCase(termDir, caseFilter, checkUrls, opinionsOnly);
        applySpeakerMapToCase(path.join(termDir, 'cases', caseFilter), speakerMap, dryRun);
    } else {
        const casesDir = path.join(termDir, 'cases');
        const caseDirs = isDir(casesDir)
            ? fs.readdirSync(casesDir).filter(n => isDir(path.join(casesDir, n))).sort()
            : [];
        for (const d of caseDirs) {
            await verifyCase(termDir, d, checkUrls, opinionsOnly);
            applySpeakerMapToCase(path.join(casesDir, d), speakerMap, dryRun);
        }
        // Sync files counts, decision hrefs, and decision dates after verifyCase
        // loop, since --opinions may have added new opinion entries.
        if (fs.existsSync(casesPath)) {
            if (!dryRun) syncFilesCount(casesPath);
            syncOpinionHrefFromFiles(casesPath);
            warnMissingOpinionHref(casesPath, term);
            warnOpinionHrefWithoutDecision(casesPath, term);
        }
    }

    if (roles) {
        _partyVerifyTerm(termDir, term, caseFilter, dryRun);
    }

    if (speakers && fs.existsSync(casesPath)) {
        verifySpeakersInTranscripts(casesPath, term, caseFilter, dryRun);
    }

    await checkLengths(casesPath, caseFilter, !dryRun);
    checkAlignedTranscriptLengths(casesPath, caseFilter);

    const result = caseFilter ? runPerCaseChecks(casesPath, term, caseFilter, dryRun) : processTerm(term, dryRun, false, allTerms, false);
    if (result && typeof result === 'object') result.missingVotes = missingVotes;
    return result;
}

// Subset of processTerm checks that are safe / meaningful when scoped to a
// single case. Returns null (so totals aren't accumulated) but performs
// per-case warnings + writes when --update is given.
function runPerCaseChecks(casesPath, term, caseFilter, dryRun) {
    if (!fs.existsSync(casesPath)) return null;
    const cases = _readJson(casesPath);
    if (!Array.isArray(cases)) return null;
    const matches = cases.filter(c =>
        c && (c.id === caseFilter || (c.number || '').split(',').map(s => s.trim()).includes(caseFilter))
    );
    if (!matches.length) return null;
    const resorted = verifyVoteSeniority(term, matches, !dryRun);
    if (!dryRun && resorted) _writeJson(casesPath, cases);
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// --votes / --minority / --recused / --dissent: update vote data for a case
// ═══════════════════════════════════════════════════════════════════════════

function _parseVoteString(voteString) {
    const match = voteString.match(/^(\d+)-(\d+)$/);
    if (!match) {
        console.error(`ERROR: Invalid vote string "${voteString}". Expected format: N-N (e.g., "6-3")`);
        process.exit(1);
    }
    return { majority: parseInt(match[1], 10), minority: parseInt(match[2], 10) };
}

// ── Add a case stub from the SCOTUS slip-opinions page ────────────────────
// Returns the opinion entry (date/name/author/href) if the case was found on
// the opinions page, or null if not. If the case was not yet in cases.json
// it is inserted (or, in dry-run mode, the insertion is reported without
// writing). If the case already exists in cases.json the opinion entry is
// still returned so callers can proceed.
async function _addCaseFromOpinions(term, caseNumber, dryRun) {
    const year4 = term.split('-')[0];
    if (!year4 || parseInt(year4, 10) < 2012) return null;
    const year2 = year4.slice(-2);
    const opinions = await fetchOpinions(year2);
    const opinion  = opinions[caseNumber.toLowerCase()];
    if (!opinion) return null;

    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    let cases = [];
    if (fs.existsSync(casesPath)) {
        try { cases = _readJson(casesPath); } catch {}
    }
    if (!Array.isArray(cases)) cases = [];

    // If already present, return the opinion data without re-adding.
    const already = cases.some(c => c && (
        c.id === caseNumber ||
        (c.number || '').split(',').map(s => s.trim()).includes(caseNumber)
    ));
    if (already) return opinion;

    // Build a minimal case entry from what the opinions page provides.
    const entry = { number: caseNumber, title: opinion.name, decision: opinion.date };
    if (opinion.cite) {
        const cm = /^(\d+)\s+U\.S\.[\s\xa0]+(\d+)$/.exec(opinion.cite.trim());
        if (cm) {
            entry.usCite = `${cm[1]} U.S. ${cm[2]}`;
        }
    }
    entry.decision_ussc = opinion.href;
    entry.files        = false;

    const ordered = reorderCase(entry);
    if (dryRun) {
        console.log(`[dry-run] Would add to ${term}/cases.json: ${caseNumber} — ${opinion.name} (decided ${opinion.date})`);
    } else {
        cases.push(ordered);
        _writeJson(casesPath, cases);
        console.log(`Added "${opinion.name}" (${caseNumber}, decided ${opinion.date}) to ${term}/cases.json`);
    }
    return opinion;
}

async function runVotesUpdate(term, caseId, argv, dryRun) {
    _ensureSeniorityLoaded();

    // Parse --votes, --minority, --recused, --dissent from raw argv.
    // Each flag consumes all subsequent non-flag tokens as its values.
    const getValues = (flag) => {
        const idx = argv.indexOf(flag);
        if (idx === -1) return [];
        const end = argv.findIndex((a, i) => i > idx && a.startsWith('--'));
        return argv.slice(idx + 1, end === -1 ? undefined : end);
    };

    const votesIdx  = argv.indexOf('--votes');
    const minority  = getValues('--minority');
    const recused   = getValues('--recused');
    const dissent   = getValues('--dissent');
    const resultValues = getValues('--result');
    const resultOverride = resultValues.length ? resultValues.join(' ').trim() : null;

    const partialUpdate = votesIdx === -1;
    if (partialUpdate && minority.length === 0 && recused.length === 0 && dissent.length === 0) {
        console.error('ERROR: Must specify --votes for a full update, or --minority/--recused/--dissent for a partial update');
        process.exit(1);
    }

    // Load cases.json, auto-adding the entry from the opinions page if absent.
    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    if (!fs.existsSync(casesPath)) {
        console.error(`ERROR: cases.json not found at ${casesPath}`);
        process.exit(1);
    }
    let cases = _readJson(casesPath);
    let caseIndex = cases.findIndex(c =>
        c && (c.id === caseId || (c.number || '').split(',').map(s => s.trim()).includes(caseId))
    );
    if (caseIndex === -1) {
        if (dryRun) {
            // The _explicitCase block in main() already attempted the add and
            // reported it. Just verify the case is on the opinions page.
            const year2 = term.split('-')[0].slice(-2);
            const opinions = await fetchOpinions(year2);
            if (!opinions[caseId.toLowerCase()]) {
                console.error(`ERROR: Case "${caseId}" not found in ${term}/cases.json and not on SCOTUS opinions page.`);
                process.exit(1);
            }
            console.log(`[dry-run] Would then apply vote update.`);
            return;
        }
        // Non-dry-run: add the case entry, then reload.
        const opinion = await _addCaseFromOpinions(term, caseId, false);
        if (!opinion) {
            console.error(`ERROR: Case "${caseId}" not found in ${term}/cases.json and not on SCOTUS opinions page.`);
            process.exit(1);
        }
        cases = _readJson(casesPath);
        caseIndex = cases.findIndex(c =>
            c && (c.id === caseId || (c.number || '').split(',').map(s => s.trim()).includes(caseId))
        );
        if (caseIndex === -1) {
            console.error(`ERROR: Failed to locate newly-added case "${caseId}".`);
            process.exit(1);
        }
    }
    const theCase = cases[caseIndex];
    const decisionDate = _scdbNormalizeDate(theCase.decision || theCase.argument || '');
    if (!decisionDate) {
        console.error(`ERROR: Case "${caseId}" has no decision or argument date`);
        process.exit(1);
    }

    // Get all justices serving on the decision date, in seniority order.
    const servingJustices = Object.keys(_scdbJusticesTenures)
        .filter(c => _scdbIsServingOn(c, decisionDate))
        .sort((a, b) => {
            const chiefA = _scdbIsChiefOn(a, decisionDate) ? 0 : 1;
            const chiefB = _scdbIsChiefOn(b, decisionDate) ? 0 : 1;
            return chiefA - chiefB ||
                (_scdbJusticesStart[a] || '9999-99-99').localeCompare(_scdbJusticesStart[b] || '9999-99-99') ||
                a.localeCompare(b);
        });
    if (servingJustices.length === 0) {
        console.error(`ERROR: No justices found serving on ${decisionDate}`);
        process.exit(1);
    }
    console.log(`Justices serving on ${decisionDate}: ${servingJustices.length}`);
    console.log(`  ${servingJustices.map(_justiceDisplayName).join(', ')}`);

    // Resolve a last-name token to a canonical justice name.
    function resolveName(name, context) {
        let canonical = _scdbCanonName(name);
        if (_scdbJusticesTenures[canonical] && _scdbIsServingOn(canonical, decisionDate)) return canonical;
        // Fall back to last-name match among serving justices. Strip
        // generational suffixes (Jr., Sr., II, III, IV) and commas so e.g.
        // "harlan" matches canonical "JOHN HARLAN, II".
        const target = name.trim().toUpperCase();
        const _SUFFIX_RE = /^(JR\.?|SR\.?|I{1,3}|IV)$/;
        const matches = servingJustices.filter(c => {
            const parts = c.replace(/,/g, '').split(/\s+/).filter(p => !_SUFFIX_RE.test(p));
            return parts[parts.length - 1] === target;
        });
        if (matches.length === 0) {
            console.error(`ERROR: ${context} "${name}" not found among justices serving on ${decisionDate}`);
            console.error(`Serving: ${servingJustices.map(_justiceDisplayName).join(', ')}`);
            process.exit(1);
        } else if (matches.length > 1) {
            console.error(`ERROR: Ambiguous ${context} "${name}" matches: ${matches.map(_justiceDisplayName).join(', ')}`);
            process.exit(1);
        }
        return matches[0];
    }

    if (partialUpdate) {
        // ── Partial update: modify existing votes ──────────────────────────
        if (!Array.isArray(theCase.votes)) theCase.votes = [];
        console.log('\nPartial update mode — modifying existing votes');

        const minorityCanonical = minority.map(n => resolveName(n, 'Minority justice'));
        const recusedCanonical  = recused.map(n => resolveName(n, 'Recused justice'));
        const dissentCanonical  = dissent.map(n => resolveName(n, 'Dissent author'));

        const voteMap = new Map();
        for (const v of theCase.votes) voteMap.set(_scdbCanonName(v.name), v);

        const minoritySet = new Set(minorityCanonical);
        const recusedSet  = new Set(recusedCanonical);
        const dissentSet  = new Set(dissentCanonical);

        for (const c of minorityCanonical) {
            if (voteMap.has(c)) voteMap.get(c).vote = 'minority';
            else voteMap.set(c, { name: c, vote: 'minority' });
        }
        for (const c of recusedCanonical) {
            if (voteMap.has(c)) voteMap.get(c).vote = 'none';
            else voteMap.set(c, { name: c, vote: 'none' });
        }
        for (const c of dissentCanonical) {
            const entry = voteMap.get(c);
            if (!entry) { console.error(`ERROR: Dissent author ${_justiceDisplayName(c)} not found in votes`); process.exit(1); }
            if (entry.vote !== 'minority') { console.error(`ERROR: Dissent author ${_justiceDisplayName(c)} must be in the minority`); process.exit(1); }
            entry.dissent = true;
        }
        // Ensure all serving justices have an entry (default majority).
        for (const c of servingJustices) {
            if (!voteMap.has(c)) voteMap.set(c, { name: c, vote: 'majority' });
        }

        theCase.votes = _scdbSortVotesBySeniority(
            Array.from(voteMap.values()).map(v => reorderVote(v)),
            decisionDate
        );
        theCase.voteMajority = theCase.votes.filter(v => v.vote === 'majority').length;
        theCase.voteMinority = theCase.votes.filter(v => v.vote === 'minority').length;
        const noneCount      = theCase.votes.filter(v => v.vote === 'none').length;

        console.log(`\nUpdated vote breakdown:`);
        console.log(`  Majority: ${theCase.voteMajority}`);
        console.log(`  Minority: ${theCase.voteMinority}`);
        console.log(`  None:     ${noneCount}`);
        console.log(`  Total:    ${theCase.voteMajority + theCase.voteMinority + noneCount} of ${servingJustices.length} serving`);

    } else {
        // ── Full update: replace all vote data ─────────────────────────────
        let afterVotes = getValues('--votes');
        if (afterVotes.length < 1) {
            console.error('ERROR: --votes requires: win|loss [VOTE_STRING [AUTHOR]]');
            process.exit(1);
        }
        // Accept both "win|loss N-N" and "N-N win|loss" orderings.
        if (afterVotes.length >= 2 && /^\d+-\d+$/.test(afterVotes[0]) && (afterVotes[1] === 'win' || afterVotes[1] === 'loss')) {
            afterVotes = [afterVotes[1], afterVotes[0], ...afterVotes.slice(2)];
        }
        const [outcome, voteStringRaw, authorRaw] = afterVotes;
        if (outcome !== 'win' && outcome !== 'loss') {
            console.error(`ERROR: Outcome must be "win" or "loss", got "${outcome}"`);
            process.exit(1);
        }

        const authorCanonical   = authorRaw ? resolveName(authorRaw, 'Author') : null;
        const minorityCanonical = minority.map(n => resolveName(n, 'Minority justice'));
        const recusedCanonical  = recused.map(n => resolveName(n, 'Recused justice'));
        const dissentCanonical  = dissent.map(n => resolveName(n, 'Dissent author'));
        const allMinority       = [...new Set([...minorityCanonical, ...dissentCanonical])];

        // No VOTE_STRING supplied: treat as a per curiam (unsigned) opinion —
        // every serving justice not recused or in the minority is recorded
        // as a majority vote.
        const perCuriam  = voteStringRaw === undefined;
        const voteString = perCuriam
            ? `${servingJustices.length - recusedCanonical.length - allMinority.length}-${allMinority.length}`
            : voteStringRaw;

        const votes = _parseVoteString(voteString);
        const result = resultOverride ??
            (outcome === 'win'
                ? 'petitioning party received a favorable disposition'
                : 'no favorable disposition for petitioning party apparent');

        if (votes.minority > 0 && allMinority.length !== votes.minority) {
            console.error(`ERROR: Vote string indicates ${votes.minority} minority vote(s), but ${allMinority.length} justice(s) provided`);
            process.exit(1);
        }
        const expectedTotal = votes.majority + votes.minority + recusedCanonical.length;
        if (expectedTotal > servingJustices.length) {
            console.error(`ERROR: Total votes (${votes.majority + votes.minority}) + recused (${recusedCanonical.length}) = ${expectedTotal} exceeds justices serving (${servingJustices.length})`);
            process.exit(1);
        }

        const minoritySet = new Set(allMinority);
        const recusedSet  = new Set(recusedCanonical);
        const dissentSet  = new Set(dissentCanonical);

        const voteEntries = servingJustices.map(c => {
            const vote = recusedSet.has(c) ? 'none' : minoritySet.has(c) ? 'minority' : 'majority';
            const entry = { name: c, vote };
            if (authorCanonical && c === authorCanonical && vote === 'majority') entry.opinion = true;
            if (dissentSet.has(c) && vote === 'minority') entry.dissent = true;
            return reorderVote(entry);
        });

        const sorted = _scdbSortVotesBySeniority(voteEntries, decisionDate);
        const majorityCount = sorted.filter(v => v.vote === 'majority').length;
        const minorityCount = sorted.filter(v => v.vote === 'minority').length;
        const noneCount     = sorted.filter(v => v.vote === 'none').length;

        if (majorityCount !== votes.majority) {
            console.error(`ERROR: Expected ${votes.majority} majority votes, got ${majorityCount}`);
            process.exit(1);
        }
        if (minorityCount !== votes.minority) {
            console.error(`ERROR: Expected ${votes.minority} minority votes, got ${minorityCount}`);
            process.exit(1);
        }

        console.log(`\nVote breakdown:`);
        console.log(`  Majority: ${majorityCount}`);
        console.log(`  Minority: ${minorityCount}`);
        console.log(`  None:     ${noneCount}`);
        console.log(`  Total:    ${majorityCount + minorityCount + noneCount} of ${servingJustices.length} serving`);
        console.log(`\nOpinion author: ${authorCanonical ? _justiceDisplayName(authorCanonical) : 'Per curiam'}`);

        theCase.result       = result;
        theCase.voteMajority = votes.majority;
        theCase.voteMinority = votes.minority;
        theCase.votes        = sorted;
    }

    cases[caseIndex] = reorderCase(theCase);

    if (dryRun) {
        console.log(`\n[dry-run] Would update ${term}/${caseId} in cases.json`);
    } else {
        _writeJson(casesPath, cases);
        console.log(`\n✓ Updated ${term}/${caseId} in cases.json`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// --add: manually add a new case entry to a term's cases.json
// ═══════════════════════════════════════════════════════════════════════════

async function runAddCase(term, title, argv, dryRun) {
    _ensureSeniorityLoaded();

    const getValues = (flag) => {
        const idx = argv.indexOf(flag);
        if (idx === -1) return [];
        const end = argv.findIndex((a, i) => i > idx && a.startsWith('--'));
        return argv.slice(idx + 1, end === -1 ? undefined : end);
    };
    const getValue = (flag) => getValues(flag)[0] || null;

    const numberRaw     = getValue('--number');
    if (!numberRaw) {
        console.error('ERROR: --add requires --number');
        process.exit(1);
    }
    const argumentRaw   = getValue('--argument');
    const reargumentRaw = getValue('--reargument');
    const decisionRaw   = getValue('--decision');

    // Parse speaker options and build advocates list. Scan argv linearly so
    // that repeated flags (e.g. two --petitioner entries) are each captured.
    const _TITLE_RE = /^(Mr|Mrs|Miss|Ms)\.?$/i;
    const _SPEAKER_ROLES_SET = new Set(['petitioner', 'respondent', 'appellant', 'appellee', 'plaintiff', 'defendant', 'complainant']);
    const speakers = [];
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const role = argv[i].slice(2);
        if (!_SPEAKER_ROLES_SET.has(role)) continue;
        const tokens = [];
        while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) tokens.push(argv[++i]);
        if (!tokens.length) {
            console.error(`ERROR: --${role} requires a name`);
            process.exit(1);
        }
        let titleStr = '';
        let nameTokens = tokens;
        if (_TITLE_RE.test(tokens[0])) {
            titleStr = tokens[0].replace(/\.?$/, '.').toUpperCase();
            nameTokens = tokens.slice(1);
        }
        const name = nameTokens.join(' ').toUpperCase();
        if (!name) {
            console.error(`ERROR: --${role} requires a name`);
            process.exit(1);
        }
        speakers.push({ role, name, title: titleStr });
    }

    // Build event objects — one per argument date, one per reargument date.
    const _makeEventTitle = (type, date) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
        if (!m) return type === 'reargument' ? 'Oral Reargument' : 'Oral Argument';
        const label = `${_MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${parseInt(m[1], 10)}`;
        return type === 'reargument' ? `Oral Reargument on ${label}` : `Oral Argument on ${label}`;
    };

    const events = [];
    if (speakers.length > 0) {
        const advocates = speakers.map(s => {
            const adv = { name: s.name };
            if (s.title) adv.title = s.title;
            adv.role = s.role;
            return reorderAdvocate(adv);
        });
        const argDates   = argumentRaw   ? argumentRaw.split(',').map(s => s.trim()).filter(Boolean)   : [];
        const reargDates = reargumentRaw ? reargumentRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
        for (const date of argDates) {
            events.push(reorderEvent({ type: 'argument',   date, title: _makeEventTitle('argument',   date), advocates }));
        }
        for (const date of reargDates) {
            events.push(reorderEvent({ type: 'reargument', date, title: _makeEventTitle('reargument', date), advocates }));
        }
    }

    // Assemble case entry with computed day labels and files placeholder.
    const entry = { title, number: numberRaw };
    if (argumentRaw) {
        entry.argument = argumentRaw;
        const argDays = _computeDays(argumentRaw);
        if (argDays) entry.argument_day = argDays;
    }
    if (reargumentRaw) {
        entry.reargument = reargumentRaw;
        const reargDays = _computeDays(reargumentRaw);
        if (reargDays) entry.reargument_day = reargDays;
    }
    if (decisionRaw) {
        entry.decision = decisionRaw;
        const decDays = _computeDays(decisionRaw);
        if (decDays) entry.decision_day = decDays;
    }
    const citeRaw = getValues('--cite').join(' ').trim();
    if (citeRaw) {
        const cm = /^(\d+)\s+U\.S\.\s+(\d+)$/.exec(citeRaw);
        if (!cm) {
            console.error(`ERROR: --cite value must be "N U.S. N" (e.g. "344 U.S. 923"), got "${citeRaw}"`);
            process.exit(1);
        }
        entry.usCite = `${cm[1]} U.S. ${cm[2]}`;
        const vol = Number(cm[1]), page = parseInt(cm[2], 10);
        try {
            const tj = _readJson(TERMS_JSON);
            if (Array.isArray(tj)) {
                const termEntry = tj.flatMap(d => d.groups || []).find(p =>
                    /\/terms\/([^/]+)\/cases\.json$/.exec(p.file || (typeof p.cases === 'string' ? p.cases : '') || '')?.[1] === term
                );
                const report = (termEntry?.reports || []).find(r => Number(r.volume) === vol);
                const pdfPage = _pdfPageFor(_parsePages(report.pages), page);
                if (report && pdfPage != null) {
                    entry.decision_rep = report.href + '#page=' + pdfPage;
                }
            }
        } catch {}
    }
    entry.files = false;
    if (events.length) entry.events = events;
    const orderedEntry = reorderCase(entry);

    // Load (or create) cases.json and check for duplicates.
    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    let cases = [];
    if (fs.existsSync(casesPath)) {
        try { cases = _readJson(casesPath); } catch {}
    }
    if (!Array.isArray(cases)) cases = [];

    const numbers = numberRaw.split(',').map(s => s.trim()).filter(Boolean);
    const exists = cases.some(c => c && numbers.some(n =>
        c.id === n || (c.number || '').split(',').map(s => s.trim()).includes(n)
    ));
    if (exists) {
        console.error(`ERROR: Case with number "${numberRaw}" already exists in ${term}/cases.json`);
        process.exit(1);
    }

    const hasVoteArgs = argv.some(a => ['--votes', '--minority', '--recused', '--dissent'].includes(a));

    if (dryRun) {
        console.log(`[dry-run] Would add to ${term}/cases.json: ${numberRaw} — ${firstTitle(title)}`);
        if (events.length) {
            console.log(`[dry-run] Would create ${events.length} event(s) with ${speakers.length} advocate(s) each`);
        }
        if (hasVoteArgs) {
            console.log(`[dry-run] Would apply vote update for ${numbers[0]}.`);
        }
        console.log(`[dry-run] Would update title indexes and terms.json`);
        return;
    }

    // Push, sort into canonical position, write.
    cases.push(orderedEntry);
    sortCases(term, cases, false);
    _writeJson(casesPath, cases);
    console.log(`Added "${firstTitle(title)}" (${numberRaw}) to ${term}/cases.json`);

    // Apply vote data if vote-related flags are present.
    if (hasVoteArgs) {
        await runVotesUpdate(term, numbers[0], argv, false);
    }

    // Rebuild title word indexes (requires all terms so each char file is complete).
    let allTerms = [];
    try {
        const tj = _readJson(TERMS_JSON);
        if (Array.isArray(tj)) {
            allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
                if (page.term) return page.term;
                const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
                return m ? m[1] : null;
            })).filter(Boolean);
        }
    } catch {}
    processTitleIndex(allTerms, false);
    processNumberIndex(allTerms, false);
    processCitationIndex(allTerms, false);
    processOnThisDayIndex(allTerms, false);

    // Cross-term argument/reargument dates first, since syncTermsJson below
    // reads dates.json's own existence (and minutes-cover contents) back
    // into terms.json — must see any dates.json this just created/updated.
    syncCrossTermCaseDates();
    syncTermsJson();
}


// ── --advocate: add one or more advocates to a case's journal-sourced event
// for a given argument/reargument day, creating the events array and/or the
// day's event object as needed. Meant for backfilling advocate/journal-page
// detail onto cases whose argument/reargument date(s) are already recorded
// at the case level but whose per-day event detail was never captured.
function runAddAdvocate(term, caseArg, argv, dryRun) {
    // Scan argv directly (not the generic single-value flagValues) so a
    // repeated --advocate flag captures every occurrence, matching the
    // pattern runAddCase() already uses for its own repeatable role flags.
    const getValues = (flag) => {
        const out = [];
        for (let i = 0; i < argv.length; i++) {
            if (argv[i] !== flag) continue;
            const tokens = [];
            let j = i + 1;
            while (j < argv.length && !argv[j].startsWith('--')) tokens.push(argv[j++]);
            out.push(tokens.join(' '));
        }
        return out;
    };
    const getValue = (flag) => getValues(flag)[0] || null;

    const date = getValue('--date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.error('ERROR: --advocate requires --date YYYY-MM-DD');
        process.exit(1);
    }
    const journalRef = (getValue('--journal') || '').trim();
    if (!/^\d{4}\.\d+$/.test(journalRef)) {
        console.error('ERROR: --advocate requires --journal YYYY.N (the journal volume year and page number)');
        process.exit(1);
    }
    const advocateRaws = getValues('--advocate');
    if (!advocateRaws.length) {
        console.error('ERROR: at least one --advocate "NAME|TITLE|ROLE" is required');
        process.exit(1);
    }
    const advocatesToAdd = advocateRaws.map(raw => {
        const parts = raw.split('|');
        if (parts.length !== 3) {
            console.error(`ERROR: --advocate value must be "NAME|TITLE|ROLE", got ${JSON.stringify(raw)}`);
            process.exit(1);
        }
        const [nameRaw, titleRaw, roleRaw] = parts.map(s => s.trim());
        if (!nameRaw || !roleRaw) {
            console.error(`ERROR: --advocate value must include a name and a role: ${JSON.stringify(raw)}`);
            process.exit(1);
        }
        const adv = { name: nameRaw.toUpperCase() };
        if (titleRaw) adv.title = titleRaw.toUpperCase();
        adv.role = roleRaw;
        return reorderAdvocate(adv);
    });

    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    let cases;
    try { cases = _readJson(casesPath); } catch {
        console.error(`ERROR: could not read ${path.relative(REPO_ROOT, casesPath)}`);
        process.exit(1);
    }
    if (!Array.isArray(cases)) {
        console.error(`ERROR: ${path.relative(REPO_ROOT, casesPath)} is not an array`);
        process.exit(1);
    }
    const c = cases.find(x => x && (x.id === caseArg || (x.number || '').split(',').map(s => s.trim()).includes(caseArg)));
    if (!c) {
        console.error(`ERROR: ${term}: case "${caseArg}" not found`);
        process.exit(1);
    }

    // A case's "argument_consolidation" (see schema.js) means every case it
    // names was really the same shared argument session — a journal-page /
    // advocate backfill for one of them applies identically to the rest, so
    // apply this same update to every case in the group, not just the one
    // named on the command line.
    const targets = [c];
    if (c.argument_consolidation) {
        const ownNumbers = new Set((c.number || '').split(',').map(s => s.trim()).filter(Boolean));
        for (const num of _splitNumbers(c.argument_consolidation)) {
            if (ownNumbers.has(num)) continue;
            const other = cases.find(x => x && (x.number || '').split(',').map(s => s.trim()).includes(num));
            if (other && !targets.includes(other)) targets.push(other);
        }
    }

    let anyChanged = false;
    const changedLabels = [];
    for (const target of targets) {
        const label = target.number || target.id || '?';

        // The case's argument/reargument date field(s) are the source of
        // truth for whether this case was actually argued on --date —
        // refuse to fabricate an event for a date the case itself doesn't
        // already record. For a consolidated group member (not the case
        // named on the command line) this is a warning, not a hard error,
        // since the rest of the group may still need the update applied.
        const knownArgDates   = new Set(_parseDateField(target.argument   || ''));
        const knownReargDates = new Set(_parseDateField(target.reargument || ''));
        if (!knownArgDates.has(date) && !knownReargDates.has(date)) {
            const msg = `${term}/${label}: ${date} is not among this case's argument/reargument date(s) `
                + `(argument=${JSON.stringify(target.argument || '')}, reargument=${JSON.stringify(target.reargument || '')})`;
            if (target === c) { console.error(`ERROR: ${msg}`); process.exit(1); }
            console.log(`  WARNING: ${msg} — skipped`);
            continue;
        }

        if (!Array.isArray(target.events)) target.events = [];

        let event = target.events.find(e => e && e.date === date);
        let createdEvent = false;
        if (!event) {
            const type = knownReargDates.has(date) ? 'reargument' : 'argument';
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
            const dateLabel = `${_MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${parseInt(m[1], 10)}`;
            event = reorderEvent({
                source: 'journal',
                type,
                date,
                title: type === 'reargument' ? `Oral Reargument on ${dateLabel}` : `Oral Argument on ${dateLabel}`,
                journal_ref: journalRef,
                advocates: [],
            });
            // Insert in chronological order rather than blindly appending, so a
            // backfilled early day doesn't land after later days already present.
            const insertAt = target.events.findIndex(e => e && e.date && e.date > date);
            if (insertAt === -1) target.events.push(event);
            else target.events.splice(insertAt, 0, event);
            createdEvent = true;
        } else if (!Array.isArray(event.advocates)) {
            event.advocates = [];
        }

        const existingNames = new Set(event.advocates.map(a => String(a?.name || '').toUpperCase()));
        const added = [];
        for (const adv of advocatesToAdd) {
            if (existingNames.has(adv.name)) continue;
            event.advocates.push(adv);
            existingNames.add(adv.name);
            added.push(adv.name);
        }

        if (!added.length) {
            console.log(`${term}/${label}: all specified advocate(s) already present on ${date}; nothing to do.`);
            continue;
        }

        console.log(`  ${term}/${label}: ${createdEvent ? '+event, ' : ''}+advocate(s) [${added.join(', ')}] on ${date}`);
        anyChanged = true;
        changedLabels.push(label);

        if (!dryRun) {
            const reordered = reorderCase(target);
            for (const k of Object.keys(target)) delete target[k];
            Object.assign(target, reordered);
        }
    }

    if (!anyChanged) return;
    if (dryRun) {
        console.log(`[dry-run] Would update ${path.relative(REPO_ROOT, casesPath)}`);
        return;
    }

    _writeJson(casesPath, cases);
    console.log(`Added advocate(s) [${advocatesToAdd.map(a => a.name).join(', ')}] to ${term}/${changedLabels.join(', ')} (${date}).`);
}


// ── --minutes: attach a NARA "Minutes of the U.S. Supreme Court" (M215)   ──
// ── microfilm-page reference to an event (metadata only — no local copy) ──

// The document-library path segment of every M215 media URL we've checked
// (M215-014 and M215-017, covering two different terms/naIds) is identical
// — confirmed against archives.gov directly before hardcoding it here — so
// only the roll ("M215-NNN") and zero-padded page number actually vary.
const NARA_MINUTES_MEDIA_BASE = 'https://catalog.archives.gov/medialz/dc-metro/rg-267/607809';

// Parses a catalog.archives.gov minutes URL like
// "https://catalog.archives.gov/id/178843742?objectPage=628" into its naId
// and (1-based) page number (defaulting to page 1 if objectPage is absent).
function _parseNaraMinutesUrl(url) {
    const idMatch = /\/id\/(\d+)/.exec(url);
    if (!idMatch) return null;
    const pageMatch = /[?&]objectPage=(\d+)/.exec(url);
    return { naId: idMatch[1], objectPage: pageMatch ? parseInt(pageMatch[1], 10) : 1 };
}

// Finds a roll name (e.g. "M215-014") already in use anywhere in this
// term's cases.json, via a sibling event's minutes_src — every case in a
// term's minutes are on the same physical roll, so this is what makes the
// cheap guess in _resolveMinutesAsset() below worth trying at all.
function _findKnownMinutesRoll(cases) {
    for (const c of cases) {
        for (const ev of (c.events || [])) {
            const m = /\/(M\d+-\d+)\/\1-\d+\.jpg$/.exec(ev.minutes_src || '');
            if (m) return m[1];
        }
    }
    return null;
}

// Resolves a catalog.archives.gov minutes URL to its downloadable image URL
// and filename ({objectUrl, objectFilename}), or null if nothing at all
// could be resolved (malformed URL, or NARA's own record lacks that page).
//
// First tries a cheap guess: reusing a roll name already known for this
// term (see _findKnownMinutesRoll()) with the page number from the URL
// zero-padded into NARA_MINUTES_MEDIA_BASE's template, verified with a HEAD
// request — NARA's media host doesn't 404 a wrong guess, it serves the
// catalog's own SPA shell (text/html, HTTP 200) instead, so success is
// judged by the response actually being an image, not by status code.
// Only when there's no known roll to guess from yet, or the guess doesn't
// pan out, does this fall back to resolving the *real* roll via the same
// JSON search API import_nara.js already uses for this host (the catalog
// page itself is a client-rendered SPA with nothing to scrape — confirmed
// directly: its raw HTML is just the app shell, no server-rendered data).
async function _resolveMinutesAsset(url, knownRoll) {
    const parsed = _parseNaraMinutesUrl(url);
    if (!parsed) return null;
    const page4 = String(parsed.objectPage).padStart(4, '0');

    if (knownRoll) {
        const filename = `${knownRoll}-${page4}.jpg`;
        const guessUrl = `${NARA_MINUTES_MEDIA_BASE}/${knownRoll}/${filename}`;
        try {
            const res = await fetch(guessUrl, { method: 'HEAD' });
            if ((res.headers.get('content-type') || '').startsWith('image/')) {
                return { objectUrl: guessUrl, objectFilename: filename };
            }
        } catch { /* fall through to the API below */ }
    }

    const apiUrl = `https://catalog.archives.gov/proxy/records/search?naId=${parsed.naId}`;
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${apiUrl}`);
    const data = await res.json();
    const objs = data?.body?.hits?.hits?.[0]?._source?.record?.digitalObjects;
    if (!Array.isArray(objs) || !objs.length) return null;
    const obj = objs[parsed.objectPage - 1];
    if (!obj?.objectUrl) return null;
    return { objectUrl: obj.objectUrl, objectFilename: obj.objectFilename };
}

async function runAddMinutes(term, caseArg, argv, dryRun) {
    const getValue = (flag) => {
        const i = argv.indexOf(flag);
        return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
    };

    const date = getValue('--date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        console.error('ERROR: --minutes requires --date YYYY-MM-DD');
        process.exit(1);
    }
    const url = getValue('--minutes');
    if (!url || !/^https:\/\/catalog\.archives\.gov\/id\//.test(url)) {
        console.error('ERROR: --minutes requires a catalog.archives.gov/id/... URL');
        process.exit(1);
    }

    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    let cases;
    try { cases = _readJson(casesPath); } catch {
        console.error(`ERROR: could not read ${path.relative(REPO_ROOT, casesPath)}`);
        process.exit(1);
    }
    if (!Array.isArray(cases)) {
        console.error(`ERROR: ${path.relative(REPO_ROOT, casesPath)} is not an array`);
        process.exit(1);
    }
    const c = cases.find(x => x && (x.id === caseArg || (x.number || '').split(',').map(s => s.trim()).includes(caseArg)));
    if (!c) {
        console.error(`ERROR: ${term}: case "${caseArg}" not found`);
        process.exit(1);
    }
    const label = c.number || c.id || '?';

    const event = (c.events || []).find(e => e && e.date === date);
    if (!event) {
        console.error(`ERROR: ${term}/${label}: no events[] entry dated ${date}`);
        process.exit(1);
    }

    const asset = await _resolveMinutesAsset(url, _findKnownMinutesRoll(cases));
    if (!asset) {
        console.error(`ERROR: could not resolve an image URL from ${url}`);
        process.exit(1);
    }

    console.log(`  ${term}/${label}: minutes_href=${url}, minutes_src=${asset.objectUrl}`);
    if (dryRun) {
        console.log(`[dry-run] Would update ${path.relative(REPO_ROOT, casesPath)}`);
        return;
    }

    event.minutes_href = url;
    event.minutes_src = asset.objectUrl;
    const idx = c.events.indexOf(event);
    c.events[idx] = reorderEvent(event);

    const reordered = reorderCase(c);
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, reordered);

    _writeJson(casesPath, cases);
    console.log(`Added minutes reference to ${term}/${label} (${date}).`);
}

// Sweeps every term's cases.json for an event with minutes_href but no
// minutes_src, and resolves+fills in minutes_src — e.g. for minutes_href
// values that were entered by hand before this field existed. Metadata
// only — no network fetch of the image itself, just the small API lookup
// needed to resolve its URL.
async function runMinutesBackfill(dryRun) {
    const terms = fs.readdirSync(TERMS_DIR)
        .filter(d => fs.existsSync(path.join(TERMS_DIR, d, 'cases.json')))
        .sort();

    let checked = 0, filled = 0, skipped = 0, failed = 0;
    for (const term of terms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        const knownRoll = _findKnownMinutesRoll(cases);
        let changed = false;

        for (const c of cases) {
            const label = c.number || c.id || '?';
            for (const ev of (c.events || [])) {
                if (!ev.minutes_href) continue;
                checked++;
                if (ev.minutes_src) { skipped++; continue; }

                try {
                    const asset = await _resolveMinutesAsset(ev.minutes_href, knownRoll);
                    if (!asset) {
                        console.log(`  WARNING: ${term}/${label}: could not resolve ${ev.minutes_href}`);
                        failed++;
                        continue;
                    }

                    console.log(`  ${term}/${label}: minutes_src=${asset.objectUrl}`);
                    if (!dryRun) {
                        ev.minutes_src = asset.objectUrl;
                        changed = true;
                    }
                    filled++;
                } catch (e) {
                    console.log(`  WARNING: ${term}/${label}: ${e.message || e}`);
                    failed++;
                }
            }
        }

        if (changed) {
            for (const c of cases) {
                if (!c.events) continue;
                c.events = c.events.map(reorderEvent);
                const reordered = reorderCase(c);
                for (const k of Object.keys(c)) delete c[k];
                Object.assign(c, reordered);
            }
            _writeJson(casesPath, cases);
        }
    }

    console.log(`\nChecked ${checked} minutes reference(s): ${filled} filled in, ${skipped} already had minutes_src, ${failed} failed.`);
    if (dryRun) console.log('(dry run — no files written)');
}


// ── --justia: scan downloaded Justia HTML opinions for cases missing in cases.json ──

function _decodeHtmlEntities(str) {
    return str
        .replace(/&amp;/gi,  '&')
        .replace(/&lt;/gi,   '<')
        .replace(/&gt;/gi,   '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&nbsp;/gi, ' ')
        .replace(/&#(\d+);/g,      (_, n) => String.fromCodePoint(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

function _isAllCapsTitle(title) {
    // True when the title (ignoring the " v. " separator) is entirely uppercase.
    if (!title) return false;
    const stripped = title.replace(/\s+v\.\s*/gi, ' ').trim();
    return /[A-Z]/.test(stripped) && stripped === stripped.toUpperCase();
}

function _parseJustiaDate(s) {
    // "March 14-15, 1889" | "December 6, 2021" → "YYYY-MM-DD" (first day of range)
    if (!s) return null;
    const MONTHS = {
        january:1, february:2, march:3, april:4, may:5, june:6,
        july:7, august:8, september:9, october:10, november:11, december:12,
    };
    const m = /^(\w+)\s+(\d+)(?:-\d+)?,\s*(\d{4})/.exec(s.trim());
    if (!m) return null;
    const mo = MONTHS[m[1].toLowerCase()];
    if (!mo) return null;
    return `${m[3]}-${String(mo).padStart(2,'0')}-${String(parseInt(m[2],10)).padStart(2,'0')}`;
}

function _matchesOtherCourt(text) {
    // Any court name that mentions a US state (e.g. "Supreme Court of Pennsylvania",
    // "High Court of Errors and Appeals of Pennsylvania", "Circuit Court, Pennsylvania District").
    if (/\bCourt\b.{0,80}Pennsylvania\b/i.test(text)) return true;
    // Catch circuit courts by state (e.g. "Circuit Court, Virginia District") but NOT
    // "Circuit Court of..." or "Circuit Court for..." which appear in SCOTUS "appeal from" headers.
    if (/\bCircuit\s+Court(?!\s+(?:of|for)\b)/i.test(text)) return true;
    return false;
}

function _isOtherCourtHtml(html) {
    // Join all headertext span content so split-element patterns like
    // "SUPREME COURT" / "OF PENNSYLVANIA" merge into one string.
    const spanRe = /<span\b[^>]+class="headertext"[^>]*>([\s\S]*?)<\/span>/gi;
    const parts = [];
    let m;
    while ((m = spanRe.exec(html)) !== null) {
        parts.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }
    if (_matchesOtherCourt(parts.join(' ').replace(/\s+/g, ' '))) return true;

    // Also scan the first 15 non-empty <p> tags — some court names appear in plain
    // paragraphs without the headertext class but adjacent to headertext paragraphs.
    const pRe = /<p(?:\s[^>]*)?>([^]*?)<\/p>/gi;
    let pCount = 0;
    while ((m = pRe.exec(html)) !== null && pCount < 15) {
        const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (_matchesOtherCourt(text)) return true;
        pCount++;
    }
    return false;
}

function _parseJustiaOpinionHtml(html) {
    const info = { title: null, usCite: null, year: null, numbers: [], argued: [], reargued: [], decided: null };

    // <title>Case Name | VOL U.S. PAGE (YEAR) | Justia...</title>
    const titleM = /<title>([^<]+)<\/title>/i.exec(html);
    if (titleM) {
        const raw = titleM[1].trim();
        const m = /^(.+?)\s*\|\s*(\d+\s+U\.S\.\s+[\d_]+)\s*\((\d{4})\)/.exec(raw);
        if (m) {
            info.title  = m[1].trim();
            info.usCite = m[2].replace(/\s+/g, ' ').trim();
            info.year   = parseInt(m[3], 10);
        }
    }

    // Old format: <p class="headertext">TEXT</p>
    const htRe = /<p\b[^>]+class="headertext"[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = htRe.exec(html)) !== null) {
        const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
        const noM    = /^Nos?\.\s+(.+)$/i.exec(text);
        if (noM)   { info.numbers.push(...noM[1].split(/\s*,\s*/).map(s => s.trim()).filter(Boolean)); continue; }
        const argM   = /^Argued:?\s+(.+)$/i.exec(text);
        if (argM)  { info.argued.push(argM[1].trim()); continue; }
        const reargM = /^Re-?argued:?\s+(.+)$/i.exec(text);
        if (reargM){ info.reargument.push(reargM[1].trim()); continue; }
        const decM   = /^Decided:?\s+(.+)$/i.exec(text);
        if (decM)  { info.decided = decM[1].trim(); }
    }

    // Newer format: <strong>LABEL</strong>...<span>VALUE</span>
    if (!info.numbers.length && !info.argued.length && !info.decided) {
        const strongRe = /<strong>([\s\S]*?)<\/strong>[\s\S]*?<span>([\s\S]*?)<\/span>/gi;
        while ((m = strongRe.exec(html)) !== null) {
            const key = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().replace(/:$/, '').toLowerCase();
            const val = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (!val) continue;
            if (/^docket\s+no\.?$/.test(key) || /^nos?\.?$/.test(key)) {
                info.numbers.push(...val.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean));
            } else if (key === 'argued')         { info.argued.push(val); }
            else if (/^re-?argued$/.test(key))  { info.reargument.push(val); }
            else if (key === 'decided')          { info.decided = val; }
        }
    }

    return info;
}

async function runJustiaCheck(volFilter, opts) {
    const { backfill, verbose } = opts;
    const OPINIONS_HTML = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'html');

    // Collect usNNN subdirectories.
    let subDirs;
    try {
        subDirs = fs.readdirSync(OPINIONS_HTML).filter(n => /^us\d+$/.test(n)).sort();
    } catch (err) {
        console.error(`Cannot read ${OPINIONS_HTML}: ${err.message}`); return;
    }

    if (volFilter) {
        const norm = volFilter.startsWith('us')
            ? volFilter
            : `us${String(parseInt(volFilter, 10)).padStart(3, '0')}`;
        subDirs = subDirs.filter(d => d === norm);
        if (!subDirs.length) { console.error(`Volume '${volFilter}' not found`); return; }
    }

    // Build lookup tables from all terms' cases.json.
    const knownCites   = new Map(); // usCite  → { term, id }
    const knownNumbers = new Map(); // number  → [{ term, id }, ...]
    try {
        const termNames = fs.readdirSync(TERMS_DIR).filter(n => /^\d{4}-\d{2}$/.test(n)).sort();
        for (const termName of termNames) {
            const cp = path.join(TERMS_DIR, termName, 'cases.json');
            try {
                const cases = JSON.parse(fs.readFileSync(cp, 'utf8'));
                for (const c of cases) {
                    if (c.usCite) knownCites.set(c.usCite, { term: termName, id: c.id });
                    if (c.number) {
                        for (const num of c.number.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean)) {
                            if (!knownNumbers.has(num)) knownNumbers.set(num, []);
                            knownNumbers.get(num).push({ term: termName, id: c.id });
                        }
                    }
                }
            } catch {}
        }
    } catch (err) {
        console.error(`Cannot load terms: ${err.message}`); return;
    }

    const missing    = [];
    const foundCases = [];

    for (const subDir of subDirs) {
        const dirPath = path.join(OPINIONS_HTML, subDir);
        let htmlFiles;
        try {
            htmlFiles = fs.readdirSync(dirPath).filter(f => /^us\d+-.+\.html$/.test(f)).sort();
        } catch { continue; }

        for (const file of htmlFiles) {
            const basename = file.replace(/\.html$/, '');
            let html;
            try { html = fs.readFileSync(path.join(dirPath, file), 'utf8'); } catch { continue; }

            if (_isOtherCourtHtml(html)) {
                if (verbose) console.log(`  skip  ${basename}  (other court)`);
                continue;
            }

            const info = _parseJustiaOpinionHtml(html);
            if (!info.usCite) {
                if (verbose) console.log(`  skip  ${basename}  (no usCite parsed)`);
                continue;
            }

            let found = false;
            if (!info.usCite.includes('_')) {
                // Known citation — match exactly.
                found = knownCites.has(info.usCite);
            } else {
                // Unreported (___) — fall back to case-number match.
                for (const num of info.numbers) {
                    if (knownNumbers.has(num)) { found = true; break; }
                }
            }

            if (found) foundCases.push({ basename, info });
            else       missing.push({ basename, info });
        }
    }

    // Decode HTML entities and normalize all-caps titles before printing.
    for (const { info } of [...foundCases, ...missing]) {
        if (info.title) info.title = _decodeHtmlEntities(info.title);
        if (_isAllCapsTitle(info.title)) info.title = _scdbCleanTitle(info.title);
    }

    // Print report: found cases first, then missing.
    function _printCaseLine({ basename, info }, suffix) {
        const dates = [];
        for (const d of info.argued)   dates.push(`Argued ${d}`);
        for (const d of info.reargument) dates.push(`Reargued ${d}`);
        if (info.decided)   dates.push(`Decided ${info.decided}`);
        else if (info.year) dates.push(`Decided ${info.year}`);
        const datePart = dates.length ? ` (${dates.join('; ')})` : '';
        console.log(`${basename}: ${info.title}${datePart}${suffix}`);
    }

    if (verbose) for (const entry of foundCases) _printCaseLine(entry, ' (found)');
    for (const entry of missing) {
        const ignored = entry.info.year && entry.info.year < 1791 ? ' (ignored)' : '';
        if (ignored) { if (verbose) _printCaseLine(entry, ignored); continue; }
        _printCaseLine(entry, '');
    }

    const actionable = missing.filter(({ info }) => !info.year || info.year >= 1791);
    const parts = [];
    if (foundCases.length) parts.push(`${foundCases.length} found`);
    if (actionable.length) parts.push(`${actionable.length} missing`);
    if (missing.length > actionable.length) parts.push(`${missing.length - actionable.length} ignored`);
    console.log(`\n${parts.length ? parts.join(', ') : 'No cases'}`);
    if (actionable.length && !backfill) console.log('(Re-run with --backfill to add the missing ones.)');
}

// =====================================================================
// --docket: probe SCOTUS docket URLs and store docket_href on each case
// =====================================================================

const _DOCKET_NEW = n => `https://www.supremecourt.gov/docket/docketfiles/html/public/${n}.html`;
const _DOCKET_OLD = n => `https://www.supremecourt.gov/search.aspx?filename=/docketfiles/${n}.htm`;

// Markers that distinguish a real docket page from a blank "Search Results" shell.
const _DOCKET_CONTENT_RE = /v\.\s+[A-Z]|Petition for|Cert Granted|Argued|Decided/i;

// Return the docket_href for a given primary docket number, or null if neither format works.
async function _probeDocketNum(num) {
    // New format: a 200 HEAD means the file exists and has real content.
    const [newOk] = await _request(_DOCKET_NEW(num), 'HEAD');
    if (newOk) return _DOCKET_NEW(num);

    // Old format always returns 200 (even for blank "Search Results"),
    // so we need to GET and verify body content.
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
            const resp = await fetch(_DOCKET_OLD(num), {
                redirect: 'follow',
                headers: { 'User-Agent': USER_AGENT },
                signal: ctrl.signal,
            });
            if (resp.ok) {
                const text = await resp.text();
                if (_DOCKET_CONTENT_RE.test(text)) return _DOCKET_OLD(num);
            }
        } finally { clearTimeout(t); }
    } catch {}

    return null;
}

async function runDocketScan(termFilter, caseFilter, { refetch = false, dryRun = false, verbose = false, assumeOld = false, assumeNew = false } = {}) {
    const termsDir = TERMS_DIR;
    const allTerms = fs.readdirSync(termsDir).filter(n => /^\d{4}-\d{2}$/.test(n)).sort();
    let termDirs;
    if (termFilter) {
        termDirs = [termFilter];
    } else if (assumeOld) {
        termDirs = allTerms.filter(t => t >= '2000-10' && t <= '2015-10');
    } else if (assumeNew) {
        termDirs = allTerms.filter(t => t >= '2017-10');
    } else {
        termDirs = allTerms;
    }

    let scanned = 0, updated = 0, skipped = 0, failed = 0;
    const CONCURRENCY = 3;

    for (const term of termDirs) {
        const casesPath = path.join(termsDir, term, 'cases.json');
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        // Collect candidates: cases with a standard docket number (DD-NNNN) or
        // original jurisdiction ("N-Orig" / "No. N, Orig.") → converted to "YYO<N>".
        const candidates = [];
        const termYY = term.slice(2, 4);
        for (const c of cases) {
            const rawNum = c.number || '';
            const firstNum = rawNum.split(',')[0].trim();
            let docketNum;
            if (/^\d{2}-\d+$/.test(firstNum)) {
                docketNum = firstNum;
            } else {
                const origM = /(?:No\.\s*)?(\d+)[-,]\s*Orig\.?$/i.exec(rawNum);
                if (origM) docketNum = `${termYY}O${origM[1]}`;
                else continue; // skip non-standard numbers (Misc, etc.)
            }
            if (caseFilter && firstNum !== caseFilter && c.id !== caseFilter &&
                !(c.number || '').split(',').map(s => s.trim()).includes(caseFilter)) continue;
            if (!refetch && c.docket_href) { skipped++; continue; }
            candidates.push({ c, firstNum, docketNum });
        }

        if (!candidates.length) continue;
        const action = assumeOld ? 'writing old-format' : assumeNew ? 'writing new-format' : 'probing';
        console.log(`${term}: ${action} ${candidates.length} case(s)…`);

        // Process in batches (or write directly when format is assumed).
        let modified = false;
        for (let i = 0; i < candidates.length; i += CONCURRENCY) {
            const batch = candidates.slice(i, i + CONCURRENCY);
            let results;
            if (assumeOld) {
                results = batch.map(({ docketNum }) => _DOCKET_OLD(docketNum));
            } else if (assumeNew) {
                results = batch.map(({ docketNum }) => _DOCKET_NEW(docketNum));
            } else {
                results = await Promise.all(batch.map(({ docketNum }) => _probeDocketNum(docketNum)));
            }
            for (let j = 0; j < batch.length; j++) {
                const { c, firstNum, docketNum } = batch[j];
                const href = results[j];
                scanned++;
                if (href) {
                    if (verbose || !dryRun) {
                        const verb = dryRun ? 'would set' : 'set';
                        const label = `${term}/${docketNum !== firstNum ? docketNum : firstNum}`;
                        if (verbose) console.log(`  ${verb} docket_href  ${label}  ${href}`);
                    }
                    if (!dryRun) {
                        c.docket_href = href;
                        const reordered = reorderCase(c);
                        Object.keys(c).forEach(k => delete c[k]);
                        Object.assign(c, reordered);
                        modified = true;
                        updated++;
                    }
                } else {
                    failed++;
                    if (verbose) console.log(`  no docket found  ${term}/${docketNum !== firstNum ? docketNum : firstNum}`);
                }
            }
            // Pause between batches when probing to avoid rate-limiting.
            if (!assumeOld && !assumeNew && i + CONCURRENCY < candidates.length) await sleep(500);
        }

        if (modified) _writeJson(casesPath, cases);
    }

    const verb = dryRun ? 'Would update' : 'Updated';
    console.log(`\nScanned ${scanned}, ${verb.toLowerCase()} ${updated}, no page found ${failed}, already set ${skipped}.`);
}

// =====================================================================
// --audits: regenerate condition-based groups in audits.json
// =====================================================================

// Resolve a field name to its value, supporting computed fields.
// Computed: 'volume' → first integer in caseObj.usCite (e.g. "601 U.S. 1" → 601)
function _resolveAuditField(field, caseObj, term) {
    if (field === 'term')   return { value: term, numeric: false };
    if (field === 'volume') return { value: _deriveVolumeFromUsCite(caseObj), numeric: true };
    return { value: caseObj[field], numeric: false };
}

function _evalAuditCondition(cond, caseObj, term) {
    const s = cond.trim();
    // "FIELD == undefined"
    let m = /^(\w+)\s*==\s*undefined$/.exec(s);
    if (m) {
        const { value: v } = _resolveAuditField(m[1], caseObj, term);
        return v === undefined || v === null || v === '';
    }
    // "FIELD != undefined"
    m = /^(\w+)\s*!=\s*undefined$/.exec(s);
    if (m) {
        const { value: v } = _resolveAuditField(m[1], caseObj, term);
        return v !== undefined && v !== null && v !== '';
    }
    // "FIELD OP NUMBER" (numeric comparison)
    m = /^(\w+)\s*(<=|>=|<|>|==|!=)\s*(\d+)$/.exec(s);
    if (m) {
        const { value: v } = _resolveAuditField(m[1], caseObj, term);
        if (v === null || v === undefined) return false;
        const lhs = Number(v), rhs = Number(m[3]), op = m[2];
        if (op === '<=') return lhs <= rhs;
        if (op === '>=') return lhs >= rhs;
        if (op === '<')  return lhs <  rhs;
        if (op === '>')  return lhs >  rhs;
        if (op === '==') return lhs === rhs;
        if (op === '!=') return lhs !== rhs;
    }
    // "FIELD OP 'VALUE'" (string comparison)
    m = /^(\w+)\s*(<=|>=|<|>|==|!=)\s*'([^']*)'$/.exec(s);
    if (m) {
        const { value: raw } = _resolveAuditField(m[1], caseObj, term);
        const v = String(raw ?? ''), rhs = m[3], op = m[2];
        if (op === '<=') return v <= rhs;
        if (op === '>=') return v >= rhs;
        if (op === '<')  return v <  rhs;
        if (op === '>')  return v >  rhs;
        if (op === '==') return v === rhs;
        if (op === '!=') return v !== rhs;
    }
    return false;
}

function runGenerateAudits(dryRun) {
    // Read the collections registry to find condition-based groups
    let registry;
    try { registry = _readJson(_COLLECTIONS_REGISTRY); } catch { registry = []; }
    const auditsEntry = registry.find(c => {
        const f = c.file || c.collection || '';
        return f.endsWith('audits.json') || f.endsWith('/audits.json');
    });
    if (!auditsEntry) {
        console.log('No Audits entry found in collections.json');
        return;
    }

    // Only process groups whose conditions are all simple (top-level field comparisons).
    // Complex conditions using COUNT(), event.*, &&, !, contains, etc. are left to manual
    // curation. `conditions` may be a flat AND'ed array, or (like _casesByConditions
    // elsewhere) an array of OR'ed branches, each internally AND'ed — same nesting rule
    // applies when checking simplicity, so a branch array is never handed to _isSimpleCond
    // itself (which expects a string and would throw on .trim()).
    const _isSimpleCond = c => /^[\w]+\s*(==|!=|<=|>=|<|>)\s*('.*'|undefined|\d+)$/.test(c.trim());
    const _isSimpleCondGroup = (conditions) => Array.isArray(conditions[0])
        ? conditions.every(set => Array.isArray(set) && set.every(_isSimpleCond))
        : conditions.every(_isSimpleCond);
    const condGroups = (auditsEntry.groups || []).filter(
        g => g.enabled !== false && Array.isArray(g.conditions) && g.conditions.length > 0 &&
             _isSimpleCondGroup(g.conditions)
    );
    if (!condGroups.length) {
        console.log('No auto-generatable condition groups found');
        return;
    }

    // A group explicitly marked "enabled": false is dropped from the output
    // entirely (not just skipped for regeneration) — kept in collections.json
    // for whenever it's re-enabled, but shouldn't take up space in audits.json
    // while disabled.
    const disabledNames = new Set(
        (auditsEntry.groups || []).filter(g => g.enabled === false).map(g => g.name)
    );

    // Read all cases.json files
    const termDirs = fs.readdirSync(TERMS_DIR)
        .filter(n => /^\d{4}-\d{2}$/.test(n)).sort();
    const allEntries = [];
    for (const term of termDirs) {
        const cp = path.join(TERMS_DIR, term, 'cases.json');
        let cases;
        try { cases = _readJson(cp); } catch { continue; }
        for (const c of (Array.isArray(cases) ? cases : [])) {
            allEntries.push({ term, c });
        }
    }
    console.log(`Scanned ${termDirs.length} terms, ${allEntries.length} total cases`);

    // Read existing audits.json; preserve groups not being auto-generated
    let existing = [];
    try { existing = _readJson(_AUDITS_PATH); } catch {}
    const genNames = new Set(condGroups.map(g => g.name));
    const preserved = Array.isArray(existing)
        ? existing.filter(g => !genNames.has(g.name) && !disabledNames.has(g.name))
        : [];

    // Mirrors the OR-branches/flat-AND nesting rule used by _casesByConditions:
    // an array-of-arrays matches if ANY branch matches (each branch's own
    // conditions still AND'ed together); a flat array matches if ALL do.
    const _matchesAuditConditions = (conditions, c, term) => Array.isArray(conditions[0])
        ? conditions.some(set => set.every(cond => _evalAuditCondition(cond, c, term)))
        : conditions.every(cond => _evalAuditCondition(cond, c, term));

    // Build generated groups
    const generated = [];
    for (const grpDef of condGroups) {
        const matching = allEntries.filter(({ term, c }) => _matchesAuditConditions(grpDef.conditions, c, term));

        const orderRules = _parseOrderSpec(grpDef.order) || [{ key: 'term', asc: true }];
        const orderKeyOf = ({ term, c }, key) => {
            if (key === 'titles')   return _naturalSortKey(c.title || '');
            if (key === 'argument') return c.argument || '';
            if (key === 'decision') return c.decision || '';
            return term || '';
        };
        matching.sort((a, b) => {
            for (const { key, asc } of orderRules) {
                const av = orderKeyOf(a, key), bv = orderKeyOf(b, key);
                const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                if (cmp !== 0) return asc ? cmp : -cmp;
            }
            return 0;
        });

        const cases = matching.map(({ term, c }) => {
            const year = (c.decision || c.argument || '').slice(0, 4);
            const ref = {
                title: c.title + (year ? ` (${year})` : ''),
                term,
                number: _primaryCaseNumber(c),
            };
            if (c.argument) ref.argument = c.argument.split(',')[0].trim();
            if (c.decision) ref.decision = c.decision;
            return ref;
        });

        generated.push({ name: grpDef.name, cases });
        console.log(`  "${grpDef.name}": ${cases.length} cases`);
    }

    // Rebuild: preserved (manually curated) groups first, then generated groups
    const updated = [...preserved, ...generated];
    if (!dryRun) {
        _writeJson(_AUDITS_PATH, updated);
        console.log(`Wrote ${path.relative(REPO_ROOT, _AUDITS_PATH)}`);
    } else {
        console.log(`[dry-run] Would write ${path.relative(REPO_ROOT, _AUDITS_PATH)}`);
    }
}

// =====================================================================
// Podcast feeds: courts/ussc/feeds/ (--feeds)
// =====================================================================
//
// Builds one podcast RSS feed per term (every audio_href-bearing event across
// every case, chronologically) plus a master feed combining every term as an
// iTunes "season" — so a single URL lets a podcast app discover the entire
// archive. Fully derived from cases.json: audio byte size (`size`) and
// duration (`length`, "HH:MM:SS.FF") are already recorded on each event by
// import_ussc.js/import_oyez.js, so no network access is needed to build
// valid <enclosure> tags.

const FEEDS_DIR        = path.join(REPO_ROOT, 'courts', 'ussc', 'feeds');
const FEEDS_TERMS_DIR  = path.join(FEEDS_DIR, 'terms');
const FEEDS_INDEX_JSON = path.join(FEEDS_DIR, 'index.json');
const PODCAST_XML_PATH = path.join(FEEDS_DIR, 'podcast.xml');

const FEED_SITE_URL    = 'https://argumentaloud.org';
const FEED_TITLE       = 'Argument Aloud';
const FEED_DESCRIPTION = 'Oral arguments and opinion announcements before the U.S. Supreme Court, in chronological order.';
const FEED_LANGUAGE    = 'en-us';
const FEED_AUTHOR      = 'argumentaloud.org';
const FEED_EMAIL       = 'jeff@pcjs.org';
// 1909x1909 square crop of assets/img/aa_exterior1.jpg (min 1400x1400 for
// Apple Podcasts/Spotify).
const FEED_IMAGE_URL   = FEED_SITE_URL + '/assets/img/podcast-cover.jpg';
// TODO: verify against Apple's current podcast category list before
// submitting for directory listing — this doesn't affect the ability to
// subscribe directly by URL in any podcast app.
const FEED_CATEGORY    = { main: 'News', sub: 'Government' };
const FEED_XSL_HREF    = '/assets/xsl/podcast.xsl';

const EVENT_TYPE_LABELS = { argument: 'Oral Argument', reargument: 'Reargument', decision: 'Opinion Announcement' };

// Source priority used only when the same (type, date, title) audio is
// available from more than one source and neither copy was ever flagged
// `redundant` by import_ussc.js/import_oyez.js (rare — a few dozen cases
// where both an ussc and an oyez copy of the same argument survived) —
// oyez's re-encoded copies are cleanest and usually carry aligned advocate
// metadata, so they win.
const _FEED_SOURCE_PRIORITY = { oyez: 0, ussc: 1, nara: 2 };

// "HH:MM:SS.FF" -> seconds (float); the ".FF" frame count is treated as a
// decimal fraction of a second, matching parseTime() in explorer.js.
function _parseDurationSecs(s) {
    if (!s) return null;
    const [h, m, sec] = String(s).split(':');
    const secs = parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(sec);
    return Number.isFinite(secs) ? secs : null;
}

// seconds -> "H:MM:SS", the format itunes:duration expects.
function _formatDurationHMS(secs) {
    if (secs == null || !Number.isFinite(secs)) return null;
    const total = Math.round(secs);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function _xmlEscape(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
    ));
}

// RFC 2822 pubDate. Event dates carry no time-of-day (see EVENT_KEY_ORDER's
// unused time/timezone fields), so anchor at noon UTC to avoid the date
// shifting a day in either direction for any reader's local timezone.
function _rssPubDate(isoDate) {
    if (!isoDate) return null;
    const d = new Date(`${isoDate}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d.toUTCString();
}

// Build every podcast episode for one term's cases.json, oldest first.
function _buildTermEpisodes(term, termCases) {
    const groups = new Map(); // "type|date|title" -> {event, caseEntry}
    for (const c of termCases) {
        for (const ev of (c.events || [])) {
            if (!ev.audio_href || ev.redundant) continue;
            const key = `${ev.type || 'argument'}|${ev.date || ''}|${ev.title || ''}`;
            const existing = groups.get(key);
            if (!existing || (_FEED_SOURCE_PRIORITY[ev.source] ?? 9) < (_FEED_SOURCE_PRIORITY[existing.event.source] ?? 9)) {
                groups.set(key, { event: ev, caseEntry: c });
            }
        }
    }
    const episodes = [...groups.values()].map(({ event, caseEntry }) => {
        const num         = _primaryCaseNumber(caseEntry);
        const evIdx       = caseEntry.events.indexOf(event) + 1;
        const durationSecs = _parseDurationSecs(event.length);
        const typeLabel   = EVENT_TYPE_LABELS[event.type] || 'Oral Argument';
        const titlePart   = firstTitle(caseEntry.title) || '';
        const descParts   = [`${event.title || typeLabel}.`, `No. ${num}, ${titlePart}${/[.!?]$/.test(titlePart) ? '' : '.'}`];
        // A few advocate titles store compound roles comma-joined (e.g.
        // "MS.,GENERAL" for a Solicitor General) — render as space-separated.
        const advocateNames = (event.advocates || []).map(a =>
            `${a.title ? a.title.replace(/,/g, ' ') + ' ' : ''}${a.name}`.trim());
        if (advocateNames.length) descParts.push('Arguing: ' + advocateNames.join(', ') + '.');
        return {
            guid:        event.audio_href,
            title:       `${firstTitle(caseEntry.title)} — ${event.title || typeLabel}`,
            date:        event.date || caseEntry.decision || caseEntry.argument || '',
            type:        event.type || 'argument',
            case:        num,
            caseId:      caseEntry.id || num,
            link:        `${FEED_SITE_URL}/courts/ussc/?term=${term}&case=${num}&event=${evIdx}`,
            audio_href:  event.audio_href,
            size:        event.size ?? null,
            duration:    _formatDurationHMS(durationSecs),
            durationSecs,
            source:      event.source || null,
            advocates:   event.advocates || undefined,
            description: descParts.join(' '),
        };
    });
    episodes.sort((a, b) => (a.date  || '').localeCompare(b.date  || '')
                          || (a.type  || '').localeCompare(b.type  || '')
                          || (a.title || '').localeCompare(b.title || ''));
    return episodes;
}

function _rssItemXml(ep, { season, episodeNum } = {}) {
    const lines = ['    <item>'];
    lines.push(`      <title>${_xmlEscape(ep.title)}</title>`);
    lines.push(`      <link>${_xmlEscape(ep.link)}</link>`);
    lines.push(`      <guid isPermaLink="false">${_xmlEscape(ep.guid)}</guid>`);
    const pubDate = _rssPubDate(ep.date);
    if (pubDate) lines.push(`      <pubDate>${pubDate}</pubDate>`);
    lines.push(`      <description>${_xmlEscape(ep.description)}</description>`);
    lines.push(`      <enclosure url="${_xmlEscape(ep.audio_href)}" length="${ep.size ?? 0}" type="audio/mpeg"/>`);
    if (ep.duration) lines.push(`      <itunes:duration>${_xmlEscape(ep.duration)}</itunes:duration>`);
    lines.push('      <itunes:explicit>false</itunes:explicit>');
    if (season     != null) lines.push(`      <itunes:season>${season}</itunes:season>`);
    if (episodeNum != null) lines.push(`      <itunes:episode>${episodeNum}</itunes:episode>`);
    lines.push('      <itunes:episodeType>full</itunes:episodeType>');
    lines.push('    </item>');
    return lines.join('\n');
}

function _rssChannelHeader(title, description, link, selfUrl) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<?xml-stylesheet type="text/xsl" href="${FEED_XSL_HREF}"?>`,
        '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom">',
        '  <script src="/assets/js/xslt-polyfill.min.js" xmlns="http://www.w3.org/1999/xhtml"></script>',
        '  <channel>',
        `    <title>${_xmlEscape(title)}</title>`,
        `    <link>${_xmlEscape(link)}</link>`,
        `    <atom:link href="${_xmlEscape(selfUrl)}" rel="self" type="application/rss+xml"/>`,
        `    <description>${_xmlEscape(description)}</description>`,
        `    <language>${FEED_LANGUAGE}</language>`,
        `    <itunes:author>${_xmlEscape(FEED_AUTHOR)}</itunes:author>`,
        `    <itunes:summary>${_xmlEscape(description)}</itunes:summary>`,
        '    <itunes:owner>',
        `      <itunes:name>${_xmlEscape(FEED_AUTHOR)}</itunes:name>`,
        `      <itunes:email>${_xmlEscape(FEED_EMAIL)}</itunes:email>`,
        '    </itunes:owner>',
        `    <itunes:image href="${_xmlEscape(FEED_IMAGE_URL)}"/>`,
        `    <image><url>${_xmlEscape(FEED_IMAGE_URL)}</url><title>${_xmlEscape(title)}</title><link>${_xmlEscape(link)}</link></image>`,
        `    <itunes:category text="${_xmlEscape(FEED_CATEGORY.main)}"><itunes:category text="${_xmlEscape(FEED_CATEGORY.sub)}"/></itunes:category>`,
        '    <itunes:explicit>false</itunes:explicit>',
        '    <itunes:type>episodic</itunes:type>',
    ].join('\n');
}

// `items` is an array of already-rendered <item> XML blocks (see _rssItemXml),
// in the order they should appear in the file (newest-first, by convention).
function _rssFeedXml(channel, items) {
    return _rssChannelHeader(channel.title, channel.description, channel.link, channel.selfUrl)
        + '\n' + items.join('\n') + '\n  </channel>\n</rss>\n';
}

function runGenerateFeeds(dryRun) {
    let termMeta = new Map(); // term id -> terms.json group entry ({name, ...})
    try {
        const tj = _readJson(TERMS_JSON);
        for (const decade of tj) for (const g of (decade.groups || [])) if (g.id) termMeta.set(g.id, g);
    } catch {}

    const allTerms = fs.readdirSync(TERMS_DIR)
        .filter(n => /^\d{4}-\d{2}$/.test(n))
        .sort(); // chronological (YYYY-MM sorts correctly as a string)

    const perTermEpisodes = []; // [{term, episodes}], oldest term first
    let jsonWrites = 0, xmlWrites = 0;
    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let termCases;
        try { termCases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(termCases)) continue;

        const episodes = _buildTermEpisodes(term, termCases);
        if (!episodes.length) continue;
        perTermEpisodes.push({ term, episodes });

        const termName = termMeta.get(term)?.name || term;
        const termJsonPath = path.join(FEEDS_TERMS_DIR, `${term}.json`);
        const termJsonOut  = { term, name: termName, generated: new Date().toISOString(), episodes };
        if (_jsonChanged(termJsonPath, termJsonOut)) {
            jsonWrites++;
            if (!dryRun) { _mkdirSync(FEEDS_TERMS_DIR, { recursive: true }); _writeJson(termJsonPath, termJsonOut); }
            else if (_VERBOSE) console.log(`  [dry-run] would write ${path.relative(REPO_ROOT, termJsonPath)}`);
        }

        const termXmlPath = path.join(FEEDS_TERMS_DIR, `${term}.xml`);
        const termItems = episodes.slice().reverse().map(ep => _rssItemXml(ep)); // newest-first, per RSS convention
        const termXml = _rssFeedXml({
            title:       `${FEED_TITLE} — ${termName}`,
            description: FEED_DESCRIPTION,
            link:        `${FEED_SITE_URL}/courts/ussc/?term=${term}`,
            selfUrl:     `${FEED_SITE_URL}/courts/ussc/feeds/terms/${term}.xml`,
        }, termItems);
        if (_textChanged(termXmlPath, termXml)) {
            xmlWrites++;
            if (!dryRun) { _mkdirSync(FEEDS_TERMS_DIR, { recursive: true }); _writeFileSync(termXmlPath, termXml); }
            else if (_VERBOSE) console.log(`  [dry-run] would write ${path.relative(REPO_ROOT, termXmlPath)}`);
        }
    }

    // Master feed: every term becomes an iTunes "season" (1 = earliest term
    // with any audio) and each episode is numbered chronologically within its
    // season, so one subscribe URL surfaces the whole archive in order.
    const seasonNumOf = new Map(perTermEpisodes.map(({ term }, i) => [term, i + 1]));
    const masterItems = perTermEpisodes
        .flatMap(({ term, episodes }) => episodes.map((ep, i) =>
            _rssItemXml(ep, { season: seasonNumOf.get(term), episodeNum: i + 1 })))
        .reverse(); // newest-first, per RSS convention
    const masterXml = _rssFeedXml({
        title:       FEED_TITLE,
        description: FEED_DESCRIPTION,
        link:        `${FEED_SITE_URL}/courts/ussc/`,
        selfUrl:     `${FEED_SITE_URL}/courts/ussc/feeds/podcast.xml`,
    }, masterItems);
    if (_textChanged(PODCAST_XML_PATH, masterXml)) {
        xmlWrites++;
        if (!dryRun) { _mkdirSync(FEEDS_DIR, { recursive: true }); _writeFileSync(PODCAST_XML_PATH, masterXml); }
        else if (_VERBOSE) console.log(`  [dry-run] would write ${path.relative(REPO_ROOT, PODCAST_XML_PATH)}`);
    }

    // Manifest of every per-term feed, for a directory/browse page.
    const index = perTermEpisodes.map(({ term, episodes }) => ({
        term,
        name:      termMeta.get(term)?.name || term,
        season:    seasonNumOf.get(term),
        count:     episodes.length,
        firstDate: episodes[0]?.date || null,
        lastDate:  episodes[episodes.length - 1]?.date || null,
        json:      `/courts/ussc/feeds/terms/${term}.json`,
        xml:       `/courts/ussc/feeds/terms/${term}.xml`,
    }));
    if (_jsonChanged(FEEDS_INDEX_JSON, index)) {
        if (!dryRun) { _mkdirSync(FEEDS_DIR, { recursive: true }); _writeJson(FEEDS_INDEX_JSON, index); }
        else if (_VERBOSE) console.log(`  [dry-run] would write ${path.relative(REPO_ROOT, FEEDS_INDEX_JSON)}`);
    }

    const totalEpisodes = perTermEpisodes.reduce((s, t) => s + t.episodes.length, 0);
    const verb = dryRun ? 'Would write' : 'Wrote';
    console.log(`Feeds: ${verb} ${jsonWrites} term JSON file(s), ${xmlWrites} XML feed(s) `
        + `(${perTermEpisodes.length} term(s), ${totalEpisodes} episode(s) total) → courts/ussc/feeds/`);
}

// =====================================================================
// Sitemap: courts/ussc/sitemap.xml (--sitemap)
// =====================================================================
//
// Every case/term/collection "page" on this site is really one static HTML
// shell (courts/ussc/index.html) whose content is resolved entirely
// client-side from URL query params, so search engines have no way to
// discover the ~29,000 individual case URLs short of an explicit sitemap.
// Lists one <url> per case (?term=X&case=Y, using the case's own unique
// "id" so consolidated/shared docket numbers can't collide), per term
// (?term=X), and per collection/topic (?collection=X / ?topic=X), plus the
// site root and the SPA entry point. Fully derived from cases.json/
// collections.json/topics.json — no network access needed.

const SITEMAP_PATH = path.join(REPO_ROOT, 'courts', 'ussc', 'sitemap.xml');
// The sitemap protocol caps a single file at 50,000 URLs/50MB — warn well
// before that so a future growth spurt doesn't silently produce a truncated
// or rejected sitemap.
const SITEMAP_URL_WARN_THRESHOLD = 45000;

function _sitemapUrlXml({ loc, lastmod }) {
    return `  <url>\n    <loc>${_xmlEscape(loc)}</loc>${lastmod ? `\n    <lastmod>${_xmlEscape(lastmod)}</lastmod>` : ''}\n  </url>`;
}

// Blog posts (courts/ussc/blog/**/*.md) are plain Jekyll pages, not a
// collection/case derived from JSON, so the sitemap has to discover them by
// scanning front matter directly — the same source `blog/posts.json` uses
// (via Liquid's site.pages) to build the in-site "more posts" list.
const BLOG_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'blog');

// Minimal front-matter reader: front matter here is always flat `key: value`
// scalars (see blog/*.md), so a full YAML parser would be overkill.
function _readFrontMatter(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split('\n')) {
        const kv = /^(\w+):\s*(.*)$/.exec(line);
        if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
    return out;
}

// Recursively collect every blog post's sitemap entry, plus the blog index
// page itself. New posts need no registration anywhere else — dropping a
// dated .md file with a `permalink` under courts/ussc/blog/ is enough for it
// to show up here the next time --sitemap runs.
//
// Blog posts use the "pane" layout, like every other page wrapped by the
// SPA's doc-viewer iframe (/courts/ussc/?link=<path>) — nothing on this site
// ever links to one at its own bare URL, so the sitemap shouldn't submit that
// bare URL either (robots.txt disallows crawling it directly). ?link= drops
// the target's own trailing slash, matching the convention already used by
// blog/index.md's own post links.
function _collectSitemapBlogUrls(buildDate) {
    const urls = [{ loc: `${FEED_SITE_URL}/courts/ussc/?link=/courts/ussc/blog`, lastmod: buildDate }];
    const walk = (dir) => {
        for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, name.name);
            if (name.isDirectory()) { walk(full); continue; }
            if (!name.isFile() || !name.name.endsWith('.md') || name.name === 'index.md') continue;
            const fm = _readFrontMatter(full);
            if (!fm.date || !fm.permalink) continue;
            const target = fm.permalink.replace(/\/$/, '');
            urls.push({ loc: `${FEED_SITE_URL}/courts/ussc/?link=${target}`, lastmod: fm.date });
        }
    };
    if (fs.existsSync(BLOG_DIR)) walk(BLOG_DIR);
    return urls;
}

// Every other "pane"-layout page on the site — courts/ussc/collections/*,
// courts/ussc/sources/*, courts/ussc/terms/index.md, the individual
// justice/advocate bio pages under courts/ussc/people/**, nara/*, the
// scdb/archive/* snapshots, etc. — is reachable only via
// /courts/ussc/?link=<path> and has its own bare URL blocked in robots.txt,
// exactly like a blog post, but isn't part of any JSON registry the sitemap
// already walks (collections.json/topics.json cover the ?collection=/
// ?topic= browsing views, a related but different thing from these pages'
// own narrative content). Without this, none of it has any path into the
// sitemap. Every one of these is always an index.md (Jekyll's directory-
// style URL), so the target is simply the file's own directory — no
// front-matter permalink needed, unlike blog posts.
const SITEMAP_PANE_SKIP_DIRS = new Set([
    '.git', '.github', '.history', '.playwright-profile', 'node_modules', '_site',
    'scripts', 'tests', 'data',
    'courts/ussc/blog', // handled separately, by _collectSitemapBlogUrls
    'courts/ussc/cache', 'courts/ussc/indexes', 'courts/ussc/journals', 'courts/ussc/opinions',
    'courts/ussc/transcripts/pdfs', 'courts/ussc/transcripts/text',
    'scdb/cache', 'scdb/current',
].map(p => p.split('/').join(path.sep)));

function _collectSitemapPaneUrls(buildDate) {
    const urls = [];
    const walk = (dir) => {
        const rel = path.relative(REPO_ROOT, dir);
        if (SITEMAP_PANE_SKIP_DIRS.has(rel)) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                // Per-term case data (courts/ussc/terms/YYYY-MM/...): thousands of
                // files, no pane pages of its own ever nested inside.
                if (/^\d{4}-\d{2}$/.test(entry.name)) continue;
                walk(full);
                continue;
            }
            if (entry.name !== 'index.md') continue;
            const fm = _readFrontMatter(full);
            if (fm.layout !== 'pane') continue;
            const target = '/' + rel.split(path.sep).join('/') + '/';
            urls.push({ loc: `${FEED_SITE_URL}/courts/ussc/?link=${target}`, lastmod: buildDate });
        }
    };
    walk(REPO_ROOT);
    return urls;
}

// Walk a collections.json/topics.json-shaped registry and return every leaf
// entry's derived collection id (its "file"/"collection" URL's basename,
// minus ".json" — the same value _findCollectionEntry() in explorer.js
// matches ?collection=/?topic= against) plus its display name.
function _collectSitemapCollectionIds(entries) {
    const out = [];
    for (const entry of (entries || [])) {
        if (Array.isArray(entry.collections)) {
            out.push(..._collectSitemapCollectionIds(entry.collections));
        } else {
            const fileUrl = entry.file || entry.collection;
            if (fileUrl) out.push(entry.id || fileUrl.split('/').pop().replace(/\.json$/, ''));
        }
    }
    return out;
}

function runGenerateSitemap(dryRun) {
    const allTerms = fs.readdirSync(TERMS_DIR).filter(n => /^\d{4}-\d{2}$/.test(n)).sort();

    // Case "decision"/"argument" dates are frequently partial (many pre-20th-century
    // cases only record "YYYY-MM", no day) or otherwise inconsistent, which trips up
    // Google's sitemap date validator ("An invalid date was found"). lastmod is just a
    // freshness hint, not load-bearing metadata, so stamp every entry with today's
    // (build) date instead of trying to derive/validate a per-case date.
    const buildDate = new Date().toISOString().slice(0, 10);

    const urls = [{ loc: `${FEED_SITE_URL}/`, lastmod: buildDate }, { loc: `${FEED_SITE_URL}/courts/ussc/`, lastmod: buildDate }];
    let caseCount = 0;
    for (const term of allTerms) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let termCases;
        try { termCases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(termCases)) continue;
        urls.push({ loc: `${FEED_SITE_URL}/courts/ussc/?term=${term}`, lastmod: buildDate });
        for (const c of termCases) {
            // Prefer the case's own unique "id" (avoids collisions when a docket
            // number is shared across consolidated cases); only the rare case
            // lacking an "id" falls back to its (term-scoped) docket number.
            const caseId = c.id || _primaryCaseNumber(c);
            if (!caseId) continue;
            urls.push({ loc: `${FEED_SITE_URL}/courts/ussc/?term=${term}&case=${encodeURIComponent(caseId)}`, lastmod: buildDate });
            caseCount++;
        }
    }

    let collDefs = [];
    try { collDefs = _readJson(_COLLECTIONS_REGISTRY); } catch {}
    for (const id of _collectSitemapCollectionIds(collDefs)) {
        urls.push({ loc: `${FEED_SITE_URL}/courts/ussc/?collection=${encodeURIComponent(id)}`, lastmod: buildDate });
    }
    let topicDefs = [];
    try { topicDefs = _readJson(path.join(REPO_ROOT, 'courts', 'ussc', 'topics', 'topics.json')); } catch {}
    for (const id of _collectSitemapCollectionIds(topicDefs)) {
        urls.push({ loc: `${FEED_SITE_URL}/courts/ussc/?topic=${encodeURIComponent(id)}`, lastmod: buildDate });
    }

    urls.push(..._collectSitemapBlogUrls(buildDate));
    urls.push(..._collectSitemapPaneUrls(buildDate));

    if (urls.length > SITEMAP_URL_WARN_THRESHOLD) {
        console.warn(`WARNING: sitemap has ${urls.length} URLs, approaching the sitemap protocol's `
            + `50,000-URL-per-file cap — split into a sitemap index before this grows further.`);
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n`
        + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
        + urls.map(_sitemapUrlXml).join('\n')
        + `\n</urlset>\n`;

    const verb = dryRun ? 'Would write' : 'Wrote';
    if (_textChanged(SITEMAP_PATH, xml)) {
        if (!dryRun) _writeFileSync(SITEMAP_PATH, xml);
        console.log(`Sitemap: ${verb} ${urls.length} URL(s) (${caseCount} case(s), ${allTerms.length} term(s)) → courts/ussc/sitemap.xml`);
    } else if (_VERBOSE) {
        console.log(`Sitemap: unchanged (${urls.length} URL(s)) → courts/ussc/sitemap.xml`);
    }
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(USAGE);
        return;
    }
    // Banner: record what was invoked so logged output is self-describing.
    {
        const scriptName = path.basename(process.argv[1] || 'verify_cases.js');
        const quoted = argv.map(a => /[\s"'\\$`]/.test(a) ? JSON.stringify(a) : a);
        console.log(`$ ${scriptName}${quoted.length ? ' ' + quoted.join(' ') : ''}`);
    }
    // Parse flag values: support both `--key value` and `--key=value`.
    const flagValues = {};
    const boolFlags  = new Set();
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq >= 0) {
                flagValues[a.slice(2, eq)] = a.slice(eq + 1);
            } else {
                const key = a.slice(2);
                // Flags that take a value
                if (['case', 'import', 'add', 'volume', 'tag'].includes(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                    flagValues[key] = argv[++i];
                } else {
                    boolFlags.add(key);
                }
            }
        } else {
            // Shorthand: split TERM/CASE in a single positional arg.
            if (a.includes('/') && /^\d{4}-\d{2}\//.test(a)) {
                const [t, ...rest] = a.split('/');
                positional.push(t);
                if (rest.length && rest[0]) positional.push(rest.join('/'));
            } else {
                positional.push(a);
            }
        }
    }
    const flags = new Set([...boolFlags].map(f => `--${f}`));
    const checkUrls    = flags.has('--checkurls');
    const opinionsOnly = flags.has('--opinions');
    const verbose      = flags.has('--verbose');
    // File changes happen by default; --dry-run suppresses all writes.
    const dryRun       = flags.has('--dry-run') || flags.has('--dry_run');
    const scdb         = flags.has('--scdb');
    const roles        = flags.has('--roles');
    const speakers     = flags.has('--speakers');
    setVerbose(verbose);
    setDryRun(dryRun);

    // Validate that an explicit case filter actually exists in the term's
    // cases.json (either as a stand-alone case `id`/`number`, or as part of a
    // consolidated `number` like "23-456,23-457"). Runs for both default and
    // --scdb modes.
    const _explicitCase = positional[1] || flagValues.case || null;
    if (_explicitCase && positional[0] && !flagValues.add) {
        const cp = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', positional[0], 'cases.json');
        if (fs.existsSync(cp)) {
            try {
                const arr = _readJson(cp);
                if (Array.isArray(arr)) {
                    const found = arr.some(c => c && (
                        c.id === _explicitCase ||
                        (c.number || '').split(',').map(s => s.trim()).includes(_explicitCase)
                    ));
                    if (!found) {
                        // Not yet in cases.json — try to add it from the SCOTUS
                        // slip-opinions page (handles per-curiam decisions and
                        // other cases never imported by import_ussc.js).
                        if (!scdb && !flags.has('--dates') && !flags.has('--split') &&
                            !flags.has('--unargued') && !flags.has('--dissents')) {
                            const opinion = await _addCaseFromOpinions(
                                positional[0], _explicitCase, dryRun);
                            if (!opinion) {
                                console.log(`WARNING: ${positional[0]}: case '${_explicitCase}' not found in cases.json`);
                            }
                        } else {
                            console.log(`WARNING: ${positional[0]}: case '${_explicitCase}' not found in cases.json`);
                        }
                    }
                }
            } catch {}
        }
    }

    // Add-case mode: --add TITLE
    if (flagValues.add) {
        if (!positional[0]) {
            console.error('ERROR: --add requires a TERM (e.g. 1952-10)');
            process.exit(1);
        }
        await runAddCase(positional[0], flagValues.add, argv, dryRun);
        return;
    }

    // Vote-update mode: --votes/--minority/--recused/--dissent
    const voteUpdateMode = flags.has('--votes') || flags.has('--minority') ||
                           flags.has('--recused') || flags.has('--dissent');
    if (voteUpdateMode) {
        if (positional.length < 2) {
            console.error('Usage: node update_cases.js TERM CASE --votes win|loss VOTE_STRING [AUTHOR] [--minority NAMES...] [--recused NAMES...] [--dissent NAMES...]');
            process.exit(1);
        }
        await runVotesUpdate(positional[0], positional[1], argv, dryRun);
        return;
    }

    if (scdb) {
        await runScdb({
            term:     positional[0] || null,
            case:     flagValues.case || null,
            caseFilter: positional[1] || null,
            update:   !dryRun,
            add:      flags.has('--add'),
            backfill: flags.has('--backfill'),
            all:      flags.has('--all'),
            noCache:  flags.has('--nocache') || flags.has('--no-cache'),
            verbose,
            debug:    flags.has('--debug'),
        });
        return;
    }

    if (flags.has('--dates')) {
        await runDatesCheck(positional[0] || null, positional[1] || null, !dryRun);
        return;
    }

    if (flags.has('--verify')) {
        await runVerifyBackfill(positional[0] || null, positional[1] || null, dryRun, { verbose });
        return;
    }

    if (flags.has('--split')) {
        await runSplitCheck(positional[0] || null, positional[1] || null, !dryRun);
        return;
    }

    if (flags.has('--dissents')) {
        await runDissentCheck(positional[0] || null);
        return;
    }

    if (flags.has('--unargued')) {
        runUnargued(positional[0] || null, positional[1] || null);
        return;
    }

    if (flags.has('--missing-cite')) {
        runMissingCite(positional[0] || null, { argued: flags.has('--argued') });
        return;
    }

    if (flags.has('--justia')) {
        await runJustiaCheck(positional[0] || null, {
            backfill: flags.has('--backfill'),
            verbose,
        });
        return;
    }

    if (flags.has('--audits')) {
        runGenerateAudits(dryRun);
        return;
    }

    if (flags.has('--feeds')) {
        runGenerateFeeds(dryRun);
        return;
    }

    if (flags.has('--sitemap')) {
        runGenerateSitemap(dryRun);
        return;
    }

    if (flags.has('--docket')) {
        await runDocketScan(positional[0] || null, positional[1] || null, {
            refetch: flags.has('--refetch'),
            assumeOld: flags.has('--old'),
            assumeNew: flags.has('--new'),
            dryRun,
            verbose,
        });
        return;
    }

    if (flags.has('--loc') && flags.has('--backfill')) {
        const termFilter = positional[0] || null;
        const cf         = positional[1] || null;
        const termsDir   = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
        const termDirs   = termFilter
            ? [termFilter]
            : fs.readdirSync(termsDir).filter(n => /^\d{4}-\d{2}$/.test(n)).sort();
        for (const t of termDirs) {
            const cp = path.join(termsDir, t, 'cases.json');
            await backfillTitlesFromLoc(cp, t, cf, dryRun);
        }
        return;
    }

    if (flagValues.tag) {
        if (positional.length < 2) {
            console.error('Usage: node update_cases.js TERM CASE --tag WORD_OR_PHRASE');
            process.exit(1);
        }
        runTagAdd(positional[0], positional[1], flagValues.tag, dryRun);
        return;
    }

    if (flags.has('--advocate')) {
        if (positional.length < 2) {
            console.error('Usage: node update_cases.js TERM CASE --date YYYY-MM-DD --journal YYYY.N --advocate "NAME|TITLE|ROLE" [--advocate ...]');
            process.exit(1);
        }
        runAddAdvocate(positional[0], positional[1], argv, dryRun);
        return;
    }

    if (flags.has('--minutes')) {
        if (positional.length >= 2) {
            await runAddMinutes(positional[0], positional[1], argv, dryRun);
        } else if (positional.length === 0) {
            await runMinutesBackfill(dryRun);
        } else {
            console.error('Usage: node update_cases.js TERM CASE --date YYYY-MM-DD --minutes URL   # attach one reference');
            console.error('       node update_cases.js --minutes [--dry-run]                        # backfill missing minutes_src values');
            process.exit(1);
        }
        return;
    }

    if (flags.has('--cites') && flags.has('--prune')) {
        runPruneRefs(positional[0] || null, positional[1] || null, dryRun, { verbose });
        return;
    }

    if (flags.has('--cites')) {
        if (positional.length >= 2) {
            runOpCites(positional[0], positional[1], dryRun, { verbose });
        } else {
            runOpCitesBulk(positional[0] || null, dryRun, { verbose });
        }
        return;
    }

    if (flags.has('--top-cites')) {
        runTopCites(dryRun);
        return;
    }

    if (flags.has('--collections')) {
        let allTerms = [];
        try {
            const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
            // terms.json stores decades/terms newest-first (for display); reverse to
            // chronological (oldest-first) order to match the full-run allTerms below —
            // collection builds use insertion order as a tie-break when cases share a
            // sort key (e.g. two undated-argument cases), so this must stay consistent
            // regardless of which code path computed allTerms.
            allTerms = tj.slice().reverse().flatMap(decade => (decade.groups || []).slice().reverse().map(page => {
                if (page.term) return page.term;
                const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
                return m ? m[1] : null;
            })).filter(Boolean);
        } catch {}
        processCollectionSets(allTerms, dryRun);
        return;
    }

    if (flagValues.import) {
        await runImportTags(flagValues.import, dryRun);
        return;
    }

    if (positional.length > 2) {
        console.log(USAGE);
        process.exit(1);
    }

    if (flags.has('--reports')) {
        const volFilter = flagValues.volume ? parseInt(flagValues.volume, 10) : null;
        await syncTermsReports(positional[0] || null, volFilter);
        return;
    }

    if (flags.has('--cleanup-files')) {
        cleanupFilesJson(positional[0] || null, positional[1] || null, dryRun);
        return;
    }

    if (flags.has('--files')) {
        tidyFilesJson(positional[0] || null, positional[1] || null);
        return;
    }

    if (flags.has('--advocates')) {
        const allTermDirs = fs.readdirSync(TERMS_DIR)
            .filter(n => /^\d{4}-\d{2}$/.test(n)).sort()
            .map(n => path.join(TERMS_DIR, n));
        await _syncAdvocatesFromScript(allTermDirs, { verbose });
        return;
    }

    if (flags.has('--keyword-index') || flags.has('--title-index') || flags.has('--number-index') || flags.has('--citation-index') || flags.has('--onthisday-index')) {
        let allTerms = [];
        try {
            const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
            allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
                if (page.term) return page.term;
                const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
                return m ? m[1] : null;
            })).filter(Boolean);
        } catch {}
        if (flags.has('--title-index'))     processTitleIndex(allTerms, false);
        if (flags.has('--number-index'))    processNumberIndex(allTerms, false);
        if (flags.has('--citation-index'))  processCitationIndex(allTerms, false);
        if (flags.has('--onthisday-index')) processOnThisDayIndex(allTerms, false);
        if (flags.has('--keyword-index'))   processKeywordIndex(allTerms, false);
        return;
    }

    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        // terms.json is decade-grouped: [{title, pages:[{title, file, cases(count), term?},...]}]
        // Derive the term key from the file URL: /courts/ussc/terms/YYYY-MM/cases.json
        // terms.json itself stores decades/terms newest-first (for display), so
        // reverse to chronological (oldest-first) order — the term-processing
        // loop and downstream aggregations (vocal justices, lone dissents, etc.)
        // depend on this order, including as an insertion-order tie-break.
        allTerms = tj.slice().reverse().flatMap(decade => (decade.groups || []).slice().reverse().map(page => {
            if (page.term) return page.term;
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return m ? m[1] : null;
        })).filter(Boolean);
    } catch {}

    // Decide scope.
    //   0 args        → all terms
    //   1 arg (TERM)  → single term
    //   2 args        → TERM CASE
    let termsToProcess = [];
    let caseFilter = null;
    if (positional.length === 0) {
        termsToProcess = [...allTerms];
    } else if (positional.length === 1) {
        termsToProcess = [positional[0]];
    } else {
        termsToProcess = [positional[0]];
        caseFilter = positional[1];
    }

    if (!termsToProcess.length) {
        console.log('No terms to process.');
        process.exit(0);
    }

    const speakerMapBase = _buildJusticeRenameEntries();

    const totals = {
        casesReordered: 0, eventsReordered: 0,
        unknownCaseKeys: new Set(), unknownEventKeys: new Set(),
        hrefUpdated: 0, hrefWarned: 0, hrefMissing: 0, hrefRedundantFixed: 0,
        hrefOrphaned: [], hrefDupes: 0, hrefStripped: 0,
        casesSorted: 0, eventsSorted: 0, suffixesFixed: 0,
        argDatesFixed: 0, eventTypesFixed: 0, mergedCount: 0,
        missingVotes: 0, usscRedundant: 0,
    };

    for (const term of termsToProcess) {
        const r = await processOneTerm(term, {
            checkUrls, opinionsOnly, verbose, dryRun, allTerms,
            caseFilter: termsToProcess.length === 1 ? caseFilter : null,
            speakerMapBase, roles, speakers,
        });
        if (!r) continue;
        totals.casesReordered    += r.casesReordered;
        totals.eventsReordered   += r.eventsReordered;
        for (const k of r.unknownCaseKeys)  totals.unknownCaseKeys.add(k);
        for (const k of r.unknownEventKeys) totals.unknownEventKeys.add(k);
        totals.hrefUpdated         += r.hrefUpdated;
        totals.hrefWarned          += r.hrefWarned;
        totals.hrefMissing         += r.hrefMissing;
        totals.hrefRedundantFixed  += r.hrefRedundantFixed;
        totals.hrefOrphaned.push(...r.hrefOrphaned);
        totals.hrefDupes           += r.hrefDupes;
        totals.hrefStripped        += r.hrefStripped;
        totals.casesSorted         += r.casesSorted;
        totals.eventsSorted        += (r.eventsSorted || 0);
        totals.suffixesFixed       += (r.suffixesFixed || 0);
        totals.argDatesFixed       += r.argDatesFixed;
        totals.eventTypesFixed     += r.eventTypesFixed;
        totals.mergedCount         += r.mergedCount;
        totals.missingVotes        += (r.missingVotes || 0);
        totals.usscRedundant       += (r.usscRedundant || 0);
    }

    // Keep corrections.json in sync with whatever scdb_check values are
    // currently on cases.json — independent of --scdb's much heavier
    // corrective pass, so a plain default run (however it got interrupted)
    // always catches it back up. Scoped to termsToProcess, same as --scdb's
    // filter.
    refreshCorrectionsFromCases(termsToProcess, dryRun);

    // Cross-scope media-href dedup check (always runs across full scope).
    const mediaDupes = checkDuplicateMediaHrefs(termsToProcess);

    // Lone-dissenter aggregation: always rebuild from the full set of terms
    // (so partial-scope runs don't yield a partial index). Skipped on --dry-run.
    if (!dryRun) {
        processLoneDissenters(allTerms, false);
        processOpinionAuthors(allTerms, false);
        processVocalJustices(allTerms, false);
        processBenches(false);
        processJusticeAdvocates(allTerms, false);
        processCollectionSets(allTerms, false);
        processTitleIndex(allTerms, false);
        processNumberIndex(allTerms, false);
        processCitationIndex(allTerms, false);
        processOnThisDayIndex(allTerms, false);
        processKeywordIndex(allTerms, false);
        await runDissentCheck(null);
        // Advocate index rebuild (final phase).
        const _allTermDirs = allTerms.map(t => path.join(TERMS_DIR, t));
        await _syncAdvocatesFromScript(_allTermDirs, { verbose });
    }

    if (!caseFilter) {
        // Cross-term argument/reargument dates first — see the other call
        // site's own comment for why this must come before syncTermsJson.
        syncCrossTermCaseDates();
        syncTermsJson();
    }

    const r = totals;
    if (r.casesReordered || r.eventsReordered) {
        const verb = dryRun ? 'Would reorder' : 'Reordered';
        const parts = [];
        if (r.casesReordered)  parts.push(`${r.casesReordered} case(s)`);
        if (r.eventsReordered) parts.push(`${r.eventsReordered} event(s)`);
        console.log(`Key order: ${verb} ${parts.join(' and ')}.`);
    }
    if (dryRun && r.unknownCaseKeys.size) {
        console.log(`Key order: unknown case keys found: [${_sortStr(r.unknownCaseKeys).map(k=>`'${k}'`).join(', ')}]`);
    }
    if (r.unknownEventKeys.size) {
        console.log(`Key order: unknown event keys found: [${_sortStr(r.unknownEventKeys).map(k=>`'${k}'`).join(', ')}]`);
    }
    if (r.hrefUpdated) {
        console.log(`text_href: ${dryRun ? 'Would migrate' : 'Migrated'} ${r.hrefUpdated} bare filename(s).`);
    }
    if (r.hrefWarned) {
        console.log(`text_href: ${r.hrefWarned} bare filename(s) could not be resolved.`);
    }
    if (r.hrefRedundantFixed) {
        console.log(`text_href: ${dryRun ? 'Would remove' : 'Removed'} stale text_href from ${r.hrefRedundantFixed} redundant event(s).`);
    }
    if (r.hrefMissing) console.log(`text_href: ${r.hrefMissing} reference(s) point to missing files.`);
    if (r.hrefOrphaned.length) {
        console.log(`text_href: ${r.hrefOrphaned.length} transcript file(s) have no reference.`);
        for (const [label, date, th] of r.hrefOrphaned) {
            const detail = th ? `  ${date}  ${th}` : `  ${date}`;
            console.log(`  ${label}${detail}`);
        }
    }
    if (r.hrefDupes)    console.log(`text_href: ${r.hrefDupes} duplicate value(s) found.`);
    if (r.hrefStripped) console.log(`transcript_href: ${dryRun ? 'Would strip' : 'Stripped'} duplicate from ${r.hrefStripped} oyez audio object(s).`);
    if (r.casesSorted)   console.log(`Case order: ${dryRun ? 'Would sort' : 'Sorted'} cases in ${r.casesSorted} term(s).`);
    if (r.eventsSorted)  console.log(`Event order: ${dryRun ? 'Would sort' : 'Sorted'} events in ${r.eventsSorted} case(s).`);
    if (r.suffixesFixed) console.log(`Transcript suffixes: ${dryRun ? 'Would fix' : 'Fixed'} ${r.suffixesFixed} file(s).`);
    if (r.argDatesFixed) console.log(`Argument dates: ${dryRun ? 'Would fix' : 'Fixed'} ${r.argDatesFixed} case(s).`);
    if (r.eventTypesFixed) console.log(`Event types: ${dryRun ? 'Would fix' : 'Fixed'} ${r.eventTypesFixed} event(s).`);
    if (r.mergedCount) console.log(`Refiled cases: ${dryRun ? 'Would merge' : 'Merged'} ${r.mergedCount} case(s) into later term(s).`);
    if (r.missingVotes) console.log(`Missing votes: ${r.missingVotes} case(s) have decision but no votes (try --scdb).`);
    if (mediaDupes.length) {
        console.log(`Media hrefs: ${mediaDupes.length} duplicate URL(s) found across scope.`);
        for (const [field, url, locs] of mediaDupes) {
            console.log(`  [${field}] ${url}`);
            for (const [t, n, d, s] of locs) {
                const lbl = d ? `${s} ${d}` : s;
                console.log(`    ${t}/${n}  [${lbl}]`);
            }
        }
    }
}

// Run main only when invoked directly (not when imported as a library).
const _isMain = (() => {
    try { return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); }
    catch { return false; }
})();

if (_isMain) {
    if (!process.env.__UPDATE_CASES_BIG_HEAP) {
        // A full run builds a keyword index across the entire transcript corpus
        // (700MB+ of JSON and growing) in memory, which can exceed Node's default
        // ~4GB heap ceiling. Re-exec once with a larger heap rather than relying
        // on every caller to remember a --max-old-space-size flag.
        const result = spawnSync(process.execPath,
            ['--max-old-space-size=8192', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
            { stdio: 'inherit', env: { ...process.env, __UPDATE_CASES_BIG_HEAP: '1' } });
        process.exit(result.status ?? 1);
    }
    main().catch(err => { console.error(err); process.exit(1); });
}

// Export newly added utilities so other scripts can reuse them.
export {
    loadSpeakerMap, filterSpeakerMap, applySpeakerMapToCase,
    migrateArgumentsToAudio, verifyCasesJsonArguments, normalizeAudioAlignedPosition,
    removeRedundantTranscriptFiles, checkCaseHrefs,
    backfillUntrackedFiles, checkAudioDates, warnMissingOpinionHref,
    verifyFilesJson, verifyCase, deduplicateCases,
    checkDuplicateCaseIds, checkDuplicateCaseNumbers, checkDuplicateAudioHrefs, checkCasesSync,
    fixKeyOrder, fixTextHrefs, checkMissingTextHrefs, checkOrphanedTranscripts,
    checkDuplicateTextHrefs, fixOyezTranscriptHrefs, checkDuplicateMediaHrefs,
    fixArgumentDates, fixDayLabels, fixEventTypes, sortCases,
    mergeRefiledCases, processTerm, syncTermsJson, syncCrossTermCaseDates,
};
