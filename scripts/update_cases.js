/**
 * update_cases.js — Verify and update case metadata for SCOTUS cases.
 * Applies fixes (sorts, key reordering, refiled-case merging, vote data, etc.)
 * by default. Pass --dry-run to suppress all file writes.
 *
 * Usage:
 *   node update_cases.js [TERM [CASE]] [--checkurls] [--opinions] [--roles] [--speakers] [--verbose] [--dry-run]
 *   node update_cases.js TERM CASE --votes win|loss VOTE_STRING [AUTHOR] [--minority NAMES...] [--recused NAMES...] [--dissent NAMES...] [--result STRING]
 *   node update_cases.js TERM CASE --minority NAMES...
 *   node update_cases.js TERM CASE --recused NAMES...
 *   node update_cases.js [TERM [CASE]] --scdb [--add] [--nocache] [--verbose]
 *   node update_cases.js [TERM [CASE]] --dates [--verbose]
 *   node update_cases.js [TERM [CASE]] --unargued
 *
 * Examples:
 *   node update_cases.js                            # verify + fix all terms
 *   node update_cases.js 2025-10                    # verify + fix one term
 *   node update_cases.js 2025-10 24-1260            # verify + fix one case
 *   node update_cases.js 2025-10 --checkurls        # also probe remote URLs
 *   node update_cases.js 2025-10 --checkurls --opinions
 *   node update_cases.js 2025-10 --dry-run          # report only, no writes
 *   node update_cases.js 2025-10 --verbose          # extra logging
 *   node update_cases.js 1979-10 --roles            # derive advocate roles for each
 *                                                   #   argument event (petitioner /
 *                                                   #   respondent / appellant / appellee /
 *                                                   #   plaintiff / defendant). A trailing
 *                                                   #   '*' on a role means it was confirmed
 *                                                   #   by only one source.
 *
 *   # Vote update: unanimous decision, author Roberts
 *   node update_cases.js 2024-10 2024-001 --votes win 9-0 roberts
 *
 *   # Vote update: 6-3 decision with Kagan writing dissent
 *   node update_cases.js 2025-10 24-109 --votes loss 6-3 alito --dissent kagan --minority sotomayor kagan jackson
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
 *   node update_cases.js [TERM] --scdb --backfill           # list SCDB cases missing from cases.json
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
    CASE_KEY_ORDER, EVENT_KEY_ORDER, ADVOCATE_KEY_ORDER,
    reorderCase, reorderEvent, reorderAdvocate, reorderVote,
} from './schema.js';

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

const _ORIG_DOCKET_RE = /^(\d+),\s*orig\.?$/i;
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
        const docketKey = om ? `${om[1]}-orig` : docket.toLowerCase();
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
    const minDate     = `${yearInt + 1}0701`;
    const maxDate     = `${yearInt + 1}0930235959`;
    const opinionsUrl = `${SCOTUS_BASE}/opinions/slipopinion/${year2digit}`;

    const cdxApi = `${_WAYBACK_CDX_URL}?url=${encodeURIComponent(opinionsUrl)}`
                 + `&output=json&from=${minDate}&to=${maxDate}&limit=5&statuscode=200`;
    if (_VERBOSE) console.log(`  Querying Wayback CDX: ${cdxApi}`);

    let cdxRows;
    try {
        const txt = await _fetchHtml(cdxApi);
        cdxRows = JSON.parse(txt);
    } catch (exc) {
        console.log(`    Warning: Wayback CDX query failed: ${exc.message || exc}`);
        return {};
    }
    if (!Array.isArray(cdxRows) || cdxRows.length < 2) {
        if (_VERBOSE) console.log(`  No Wayback snapshot found for slipopinion/${year2digit} in ${minDate.slice(0,8)}–${maxDate.slice(0,8)}.`);
        return {};
    }

    const header = cdxRows[0];
    const tsIdx  = header.indexOf('timestamp') >= 0 ? header.indexOf('timestamp') : 1;
    const snapshotTs  = cdxRows[1][tsIdx];
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
    } else if (checkUrls) {
        opinions = await _fixDeadOpinionPdfHrefs(opinions);
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

    let maxId = 0;
    for (const e of data) {
        if (typeof e?.file === 'number' && e.file > maxId) maxId = e.file;
    }
    const newEntry = {
        file:   maxId + 1,
        type:   'opinion',
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
        if (c.files === count) continue;
        c.files = count;
        modified = true;
    }

    if (modified) {
        _writeJson(casesPath, data);
        if (_VERBOSE) console.log(` NOTICE: ${path.basename(termDir)}/cases.json: synced "files" counts`);
    }
}

export function syncOpinionHrefFromFiles(casesPath) {
    let data;
    try { data = _readJson(casesPath); } catch { return; }
    if (!Array.isArray(data)) return;

    const termDir = path.dirname(casesPath);
    let modified = false;

    for (const c of data) {
        const needsHref     = !c.opinion_href;
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
            c.opinion_href = opinion.href;
            changed = true;
            console.log(`  ${label}: inserted opinion_href from files.json`);
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

const _DATE_DEC_PARSE_RE = new RegExp(
    '^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\\s+'
  + '(January|February|March|April|May|June|July|August|September|'
  + 'October|November|December)\\s+(\\d{1,2}),\\s+(\\d{4})$'
);

const TERMS_JSON = path.join(REPO_ROOT, 'courts', 'ussc', 'terms.json');
const TERMS_DIR  = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');

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
    if (source === 'oyez' && lower.includes('opinion'))         type = 'opinion';
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
        const toRemove = files.filter(f =>
            f?.type === 'transcript'
            && audioTranscripts.has(`${f.href || ''}\u0000${f.date || ''}`));
        if (toRemove.length === 0) continue;

        const removeIds = new Set(toRemove.filter(f => 'file' in f).map(f => f.file));
        const newFiles = [];
        let gap = 0;
        for (const f of files) {
            const fid = f.file;
            if (fid !== undefined && removeIds.has(fid)) { gap++; continue; }
            if (gap && fid !== undefined) {
                newFiles.push({ ...f, file: fid - gap });
            } else {
                newFiles.push(f);
            }
        }
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
        c.files = newFiles.length;
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

// Warn when a case has audio/transcript media (audio_href, transcript_href,
// or text_href on any event) but no `votes` array — typically meaning we
// haven't yet pulled SCDB vote data for it. Returns the count of warned
// cases so the top-level driver can suggest re-running with --scdb.
function checkArgumentsHaveVotes(casesPath, term) {
    // Don't warn for active terms (term year + 1 October hasn't arrived yet).
    const termYear = parseInt(term.slice(0, 4), 10);
    if (!isNaN(termYear) && new Date() < new Date(`${termYear + 1}-10-01`)) return 0;
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return 0;
    let count = 0;
    for (const c of data) {
        if (Array.isArray(c.votes) && c.votes.length) continue;
        if (!c.decision) continue;
        const label = c.number || c.id || '?';
        console.log(`WARNING: ${term}/${label}: has decision but no votes (try --scdb)`);
        count++;
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

        const oh = c.opinion_href || '';
        if (oh && /^https?:\/\//.test(oh)) {
            printHeader();
            const lbl = oh.length <= 80 ? oh : oh.slice(0, 77) + '…';
            process.stdout.write(`  [o] ${lbl} `);
            const [ok, headers] = await checkUrl(oh);
            await _politeDelay(oh);
            if (!ok) {
                const status = headers._status || headers._error || 'unknown';
                console.log(`✗ UNREACHABLE (${status}) — renaming to opinion_href_bad`);
                _renameKey(c, 'opinion_href', 'opinion_href_bad');
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
    if (lower.includes('petitioner') || lower.includes('appellant')) return 'petitioner';
    if (lower.includes('respondent') || lower.includes('appellee'))  return 'respondent';
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
            let maxId = 0;
            for (const e of filesData) {
                if (typeof e.file === 'number' && e.file > maxId) maxId = e.file;
            }
            const localHref = `/courts/ussc/terms/${term}/${relCase}/${fname}`;
            const newEntry = { file: maxId + 1, title: _titleFromFilename(fname) };
            const ftype = _fileTypeFromName(fname);
            if (ftype) newEntry.type = ftype;
            newEntry.href = localHref;
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
            } else if (atype === 'opinion') {
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

function warnMissingOpinionHref(casesPath, term) {
    if (_isCurrentTerm(term)) return;
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    for (const c of data) {
        if (c.opinion_href) continue;
        const label = c.number || c.id || '?';
        const title = firstTitle(c.title) || '';
        if (_VERBOSE) console.log(` NOTICE: ${term}/${label} (${title.slice(0,40)}): no opinion_href`);
    }
}

function warnOpinionHrefWithoutDecision(casesPath, term) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    for (const c of data) {
        if (!c.opinion_href || c.decision) continue;
        const label = c.number || c.id || '?';
        const title = firstTitle(c.title) || '';
        console.log(`WARNING: ${term}/${label} (${title.slice(0,40)}): has opinion_href but no decision date`);
    }
}

// Remove redundant `volume`/`page` properties when they match the first/second
// numbers of `usCite` (e.g. usCite "584 U.S. 1" with volume "584" and page "1").
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
        if (!nums || nums.length < 2) continue;
        const citeVol  = String(parseInt(nums[0], 10));
        const citePage = String(parseInt(nums[1], 10));
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
            console.log(` NOTICE: ${term}/${label}: page='${c.page}' but usCite='${usCite}' has page ${citePage}`);
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
    for (const entry of data) {
        const href = entry.href || '';
        const fileNum = entry.file ?? '?';
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
    await checkOpinionForCase(filesPath, caseNumber, path.basename(termDir), printHeader);
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
                let nextId = compFiles.reduce((m, f) => Math.max(m, f.file || 0), 0) + 1;
                let added = 0;
                for (const sf of stubFiles) {
                    if (!existingHrefs.has(sf.href)) {
                        const entry = { ...sf, file: nextId };
                        nextId++;
                        compFiles.push(entry);
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
            // it — either a `files` count (i.e. files.json entries) or an
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
const _SOURCE_ORDER = { ussc: 0, nara: 1, oyez: 2 };

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
        const [newCase, unknown] = _reorderWithUnknowns(c, CASE_KEY_ORDER);
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
                const allOpinion = locs.every(l => l[5] === 'opinion');
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

function _eventSortKey(event) {
    const date   = event.date || '';
    const source = event.source || '';
    return [date, _SOURCE_ORDER[source] ?? 99, source];
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
                if (etype !== 'opinion') {
                    console.log(`WARNING: ${term}/${number} ${date}: event type '${etype}' on decision date (not auto-fixed)`);
                }
            }
            if (['argument', 'reargument', 'opinion'].includes(etype) && date) {
                if (etype === 'argument' && !argDates.has(date))
                    console.log(`WARNING: ${term}/${number} ${date}: argument event date not in 'argument' field`);
                else if (etype === 'reargument' && !reargDates.has(date))
                    console.log(`WARNING: ${term}/${number} ${date}: reargument event date not in 'reargument' field`);
                else if (etype === 'opinion' && !decisionDates.has(date))
                    console.log(`WARNING: ${term}/${number} ${date}: opinion event date not in 'decision' field`);
            }
        }
    }
    return fixed;
}

function sortEvents(term, cases, dryRun) {
    let changed = 0;
    for (const c of cases) {
        const events = c.events;
        if (!events || events.length < 2) continue;
        const indexed = events.map((e, i) => [i, e]);
        const sorted = [...indexed].sort(([, a], [, b]) =>
            _cmpKeys(_eventSortKey(a), _eventSortKey(b)));
        const orderChanged = sorted.some(([oi], i) => oi !== i);
        if (orderChanged) {
            changed++;
            if (dryRun) console.log(`  SORT events ${term}/${c.number || '?'}`);
            else c.events = sorted.map(([, e]) => e);
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
    const key = (c) => { const d = lastArgDate(c); return [d ? '0' : '1', d, firstDocketNum(c)]; };
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
            newEvents.sort((a, b) => _cmpKeys(_eventSortKey(a), _eventSortKey(b)));
            newCase.previouslyFiled = `${term}/${number}`;
            const [reordered] = _reorderWithUnknowns(newCase, CASE_KEY_ORDER);
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
                 hrefDupes: 0, hrefStripped: 0, eventsSorted: 0, casesSorted: 0,
                 argDatesFixed: 0, eventTypesFixed: 0, mergedCount: 0, usscRedundant: 0 };
    }
    const cases = _readJson(casesPath);
    if (!cases || !cases.length) {
        return { dupCount: 0, casesReordered: 0, eventsReordered: 0, unknownCaseKeys: new Set(), unknownEventKeys: new Set(),
                 hrefUpdated: 0, hrefWarned: 0, hrefMissing: 0, hrefRedundantFixed: 0, hrefOrphaned: [],
                 hrefDupes: 0, hrefStripped: 0, eventsSorted: 0, casesSorted: 0,
                 argDatesFixed: 0, eventTypesFixed: 0, mergedCount: 0, usscRedundant: 0 };
    }
    const dupCount = (checkDups && !sortOnly) ? checkDuplicateNumbers(term, cases) : 0;
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
    const hrefStripped = !sortOnly ? fixOyezTranscriptHrefs(term, cases, dryRun) : 0;
    const eventsSorted = sortEvents(term, cases, dryRun);
    const casesSorted  = sortCases(term, cases, dryRun);
    const argDatesFixed   = !sortOnly ? fixArgumentDates(term, cases, dryRun) : 0;
    const eventTypesFixed = !sortOnly ? fixEventTypes(term, cases, dryRun)    : 0;
    const mergedCount     = !sortOnly ? mergeRefiledCases(term, cases, allTerms || [], dryRun) : 0;
    const votesResorted   = !sortOnly ? verifyVoteSeniority(term, cases, !dryRun) : 0;

    if (!dryRun && (casesReordered || eventsReordered || hrefUpdated || hrefStripped
            || eventsSorted || casesSorted || argDatesFixed || eventTypesFixed
            || mergedCount || hrefRedundantFixed || votesResorted || usscRedundant)
            && _jsonChanged(casesPath, cases)) {
        _writeJson(casesPath, cases);
    }
    return { dupCount, casesReordered, eventsReordered, unknownCaseKeys, unknownEventKeys,
             hrefUpdated, hrefWarned, hrefMissing, hrefRedundantFixed, hrefOrphaned,
             hrefDupes, hrefStripped, eventsSorted, casesSorted,
             argDatesFixed, eventTypesFixed, mergedCount, usscRedundant };
}

// ═════════════════════════════════
// SCDB CSV post-processing (--scdb)
// ═════════════════════════════════
//
// For each SCDB download named in config.json under "scdb" (modern/legacy),
// reads the corresponding CSV in scdb/, converts MM/DD/YYYY date values to
// YYYY-MM-DD, removes unused columns, and writes <key>.csv (e.g. modern.csv /
// legacy.csv). The original SCDB_*.csv file is deleted on success.

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
    let any = false;
    for (const [key, basename] of Object.entries(scdb)) {
        if (!basename) continue;
        const srcPath = path.join(dataDir, basename);
        const outPath = path.join(dataDir, `${key}.csv`);
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
const _SCDB_TERMS_DIR   = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const _LD_CITES_PATH    = path.join(REPO_ROOT, 'data', 'aa', 'ussc_citations.csv');
const _LD_DATES_PATH    = path.join(REPO_ROOT, 'data', 'aa', 'ussc_dates.csv');
const _SCDB_VARS_PATH   = path.join(_SCDB_DATA_DIR, 'vars.json');
const _SCDB_JUSTICES    = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');
const _SCDB_MODERN_CSV  = path.join(_SCDB_DATA_DIR, 'modern.csv');
const _SCDB_LEGACY_CSV  = path.join(_SCDB_DATA_DIR, 'legacy.csv');
const _SCDB_CACHE_DIR   = path.join(_SCDB_DATA_DIR, 'cache');
const _SCDB_CACHE_PATH  = path.join(_SCDB_CACHE_DIR, 'scdb.json');

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

function _scdbNormalizeCite(s) { return (s || '').split(/\s+/).filter(Boolean).join(' '); }

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
function _justiceDisplayName(canonical) {
    return String(canonical || '')
        .toLowerCase()
        .replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
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
    const INDEX_FILE    = path.join(PEOPLE_DIR, 'justices', 'lone_justices.json');

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
                number:   c.number || c.id || '',
                argument: c.argument || '',
                decision: c.decision || '',
            };
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
            (a.term || '').localeCompare(b.term || '') ||
            (a.title || '').localeCompare(b.title || ''));
        const caseCount = list.length;
        // list is sorted oldest→newest; [0] = oldest, [last] = newest.
        const dateFirst = caseCount ? (list[0].decision || list[0].argument || '') : '';
        const dateLast  = caseCount ? (list[caseCount - 1].decision || list[caseCount - 1].argument || '') : '';
        const entry = {
            id:    _justiceSlug(canonical),
            name:  _justiceDisplayName(canonical),
            cases: caseCount,
        };
        if (dateFirst) entry.dateFirst = dateFirst;
        if (dateLast)  entry.dateLast  = dateLast;
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
// and rebuild courts/ussc/people/justices/author_justices.json plus per-justice
// files in courts/ussc/people/justices/author/.
function processOpinionAuthors(termsToProcess, dryRun) {
    _ensureSeniorityLoaded();
    const PEOPLE_DIR    = path.join(REPO_ROOT, 'courts', 'ussc', 'people');
    const JUSTICES_DIR  = path.join(PEOPLE_DIR, 'justices', 'author');
    const INDEX_FILE    = path.join(PEOPLE_DIR, 'justices', 'author_justices.json');

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
                    number:   c.number || c.id || '',
                    argument: c.argument || '',
                    decision: c.decision || '',
                };
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
            (a.term || '').localeCompare(b.term || '') ||
            (a.title || '').localeCompare(b.title || ''));
        const caseCount = list.length;
        // list is sorted oldest→newest; [0] = oldest, [last] = newest.
        const dateFirst = caseCount ? (list[0].decision || list[0].argument || '') : '';
        const dateLast  = caseCount ? (list[caseCount - 1].decision || list[caseCount - 1].argument || '') : '';
        const entry = {
            id:    _justiceSlug(canonical),
            name:  _justiceDisplayName(canonical),
            cases: caseCount,
        };
        if (dateFirst) entry.dateFirst = dateFirst;
        if (dateLast)  entry.dateLast  = dateLast;
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
            if (_VERBOSE) console.log(`  Removed stale opinion-author file: courts/ussc/people/justices/author/${name}`);
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
                number:   c.number || c.id || '',
                argument: c.argument || '',
                decision: c.decision || '',
            };

            // canonical → { totalSecs, firstEventIdx, firstTurnNum } — accumulated within this case
            const caseAccum = new Map();

            let eventIdx = 0;
            for (const ev of (c.events || [])) {
                eventIdx++;
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

                // Parse all turn start times once.
                const times = rawTurns.map(t => _parseTimeSecs(t?.time));

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
// Justice-advocate auto-discovery
// =====================================================================

// Scan every term's cases.json for event advocates whose names match a known
// justice (from data/ussc/justices.json) AND whose argument date predates that
// justice's appointment.  Adds any newly discovered cases to
// courts/ussc/people/advocates/justices/justice_advocates.json without
// disturbing entries that already exist there.
function processJusticeAdvocates(allTerms, dryRun) {
    const JUSTICE_ADVOCATES_FILE = path.join(
        REPO_ROOT, 'courts', 'ussc', 'people', 'advocates', 'justices', 'justice_advocates.json');

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

        for (const c of cases) {
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
                    const caseKey = `${term}/${String(c.number || '')}`;
                    if (!byCase.has(caseKey)) {
                        byCase.set(caseKey, {
                            term,
                            number: String(c.number || ''),
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

    for (const [canonical, byCase] of discovered) {
        let group = groupsByName.get(canonical);
        if (!group) {
            group = { id: _justiceSlug(canonical), name: canonical, cases: [] };
            coll.push(group);
            groupsByName.set(canonical, group);
        }
        if (!Array.isArray(group.cases)) group.cases = [];

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
        }

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
    console.log(`Justice advocates: ${verb} ${totalAdded} case(s) for ${[...discovered.keys()].join(', ')}.`);
}

// =====================================================================
// Collection-set builders: transcripts.json / briefs.json / noteworthy.json
// =====================================================================

const _COLLECTIONS_DIR  = path.join(REPO_ROOT, 'courts', 'ussc', 'collections');
const _INDEX_JSON       = path.join(REPO_ROOT, 'courts', 'ussc', 'index.json');
const _TRANSCRIPTS_PATH = path.join(_COLLECTIONS_DIR, 'transcripts.json');
const _BRIEFS_PATH      = path.join(_COLLECTIONS_DIR, 'briefs.json');
const _NOTEWORTHY_PATH  = path.join(_COLLECTIONS_DIR, 'noteworthy.json');

const _TRANSCRIPTS_SET_BASENAME = 'Transcripts';
const _BRIEFS_SET_BASENAME      = 'Briefs';

// Upper-bound term year for each curated set (no lower bound: the earliest
// term containing matching files defines the start of the range).
const _TRANSCRIPTS_MAX_YEAR = 1967;
const _BRIEFS_MAX_YEAR      = 1999;

function _termYearAtMost(term, maxYear) {
    const y = parseInt(String(term).split('-')[0], 10);
    return Number.isFinite(y) && y <= maxYear;
}

// Derive a "Name (minYear-maxYear)" set name from the cases that ended up in
// a collection, using each case's decision-year prefix from the title (the
// browser-facing entries are already formatted like "Title (YYYY)").
function _setNameFromCases(baseName, cases) {
    const years = [];
    for (const c of cases) {
        const m = /\((\d{4})\)\s*$/.exec(c?.title || '');
        if (m) years.push(parseInt(m[1], 10));
        else {
            const dy = (c?.decision || '').slice(0, 4);
            if (/^\d{4}$/.test(dy)) years.push(parseInt(dy, 10));
        }
    }
    if (!years.length) return baseName;
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    return lo === hi ? `${baseName} (${lo})` : `${baseName} (${lo}-${hi})`;
}

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

function _setCaseEntry(c, term) {
    const year = _decisionYearOf(c);
    const baseTitle = firstTitle(c.title) || '';
    const title = year ? `${baseTitle} (${year})` : baseTitle;
    const entry = { title, term };
    const numberVal = c.number || c.id || '';
    if (numberVal) entry.number = numberVal;
    if (c.argument)   entry.argument   = c.argument;
    if (c.reargument) entry.reargument = c.reargument;
    if (c.decision)   entry.decision   = c.decision;
    if (c.files)      entry.files      = c.files;
    const events = Array.isArray(c.events) ? c.events : [];
    if (events.some(e => e.audio_href))  entry.event      = true;
    if (events.some(e => e.text_href))   entry.transcript = true;
    return entry;
}

function _loadExistingSet(filePath) {
    if (!fs.existsSync(filePath)) return { existingCases: [], existingKeys: new Set() };
    let data;
    try { data = _readJson(filePath); } catch { return { existingCases: [], existingKeys: new Set() }; }
    if (!Array.isArray(data) || !data.length) return { existingCases: [], existingKeys: new Set() };
    const cases = Array.isArray(data[0]?.cases) ? data[0].cases : [];
    const keys  = new Set();
    for (const c of cases) {
        // Identify entries by (term, first-docket-piece) — matches the
        // case-folder convention used when discovering local entries.
        const term = (c.term   || '').trim();
        const num  = (c.number || '').split(',')[0].trim();
        if (term && num) keys.add(`${term}\u0000${num}`);
    }
    return { existingCases: cases, existingKeys: keys };
}

// Find LD-source argument events and build the transcripts collection.
// Existing entries in transcripts.json are preserved verbatim; any new local
// LD events are appended.
function _buildTranscriptsCollection(allTerms) {
    const { existingCases, existingKeys } = _loadExistingSet(_TRANSCRIPTS_PATH);
    const added = [];
    for (const term of allTerms) {
        if (!_termYearAtMost(term, _TRANSCRIPTS_MAX_YEAR)) continue;
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        for (const c of cases) {
            if (!Array.isArray(c.events)) continue;
            const hasLd = c.events.some(e =>
                e && typeof e === 'object'
                && (e.type === 'argument' || e.type === 'reargument')
                && (e.source === 'ld'
                    || /^https?:\/\/(?:[\w-]+\.)*lonedissent\.org\//i.test(String(e.transcript_href || ''))));
            if (!hasLd) continue;
            const num = (c.number || c.id || '').split(',')[0].trim();
            const key = `${term}\u0000${num}`;
            if (existingKeys.has(key)) continue;
            added.push(_setCaseEntry(c, term));
        }
    }
    added.sort((a, b) =>
        (a.term      || '').localeCompare(b.term      || '') ||
        (a.argument  || '').localeCompare(b.argument  || '') ||
        (a.decision  || '').localeCompare(b.decision  || '') ||
        (a.title     || '').localeCompare(b.title     || ''));
    const cases = existingCases.concat(added);
    return [{ name: _setNameFromCases(_TRANSCRIPTS_SET_BASENAME, cases), cases }];
}

// Find cases that have a files.json with at least one brief entry; build
// the briefs collection. Existing entries in briefs.json are preserved
// verbatim; any new local entries are appended.
function _buildBriefsCollection(allTerms) {
    const { existingCases, existingKeys } = _loadExistingSet(_BRIEFS_PATH);
    const added = [];
    for (const term of allTerms) {
        if (!_termYearAtMost(term, _BRIEFS_MAX_YEAR)) continue;
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = _readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        const termCasesDir = path.join(TERMS_DIR, term, 'cases');
        for (const c of cases) {
            const folder = (c.number || c.id || '').split(',')[0].trim();
            if (!folder) continue;
            const filesPath = path.join(termCasesDir, folder, 'files.json');
            if (!fs.existsSync(filesPath)) continue;
            let files;
            try { files = _readJson(filesPath); } catch { continue; }
            if (!Array.isArray(files) || !files.length) continue;
            const hasBrief = files.some(f => f && typeof f === 'object'
                && /^https?:\/\/briefs\d*\.lonedissent\.org\//i.test(String(f.href || '')));
            if (!hasBrief) continue;
            const key = `${term}\u0000${folder}`;
            if (existingKeys.has(key)) continue;
            added.push(_setCaseEntry(c, term));
        }
    }
    added.sort((a, b) =>
        (a.decision || a.argument || '').localeCompare(b.decision || b.argument || '') ||
        (a.term  || '').localeCompare(b.term  || '') ||
        (a.title || '').localeCompare(b.title || ''));
    const cases = existingCases.concat(added);
    return [{ name: _setNameFromCases(_BRIEFS_SET_BASENAME, cases), cases }];
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

function _buildNoteworthyCollection(allTerms) {
    // Delegate to _buildTagsCollection using the same definition that
    // collections.json uses: groups:[{ title:"*", tags:["Noteworthy"] }].
    // This ensures both paths (explicit call here and the taggedCollections
    // loop) produce identical output so the second write is always a no-op.
    const output = _buildTagsCollection(allTerms, {
        groups: [{ title: '*', tags: ['Noteworthy'] }],
    });
    return { output, skipped: 0, unmatched: 0 };
}

const _PAGE_KEY_ORDER = ['name', 'term', 'file', 'cases', 'journal_cover', 'journal_href'];

function syncTermsJson() {
    let tj;
    try { tj = _readJson(TERMS_JSON); } catch { return; }
    if (!Array.isArray(tj)) return;

    let modified = false;
    for (const decade of tj) {
        for (let i = 0; i < (decade.groups || []).length; i++) {
            const page = decade.groups[i];
            // Support both old format (cases = URL string) and new format (file = URL string).
            const fileUrl = page.file || (typeof page.cases === 'string' ? page.cases : '');
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(fileUrl);
            if (!m) continue;

            const casesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', m[1], 'cases.json');
            let count = 0;
            if (fs.existsSync(casesPath)) {
                try {
                    const data = _readJson(casesPath);
                    if (Array.isArray(data)) count = data.length;
                } catch {}
            }

            // Rebuild page with canonical key order, file=URL, cases=count.
            const newPage = {};
            for (const k of _PAGE_KEY_ORDER) {
                if (k === 'file') { newPage.file = fileUrl; continue; }
                if (k === 'cases') { newPage.cases = count; continue; }
                if (k === 'term') { if (page.term) newPage.term = page.term; continue; }
                if (Object.prototype.hasOwnProperty.call(page, k)) newPage[k] = page[k];
            }
            // Preserve any extra keys not in the canonical order.
            for (const k of Object.keys(page)) {
                if (!_PAGE_KEY_ORDER.includes(k)) newPage[k] = page[k];
            }

            if (JSON.stringify(newPage) !== JSON.stringify(page)) {
                decade.groups[i] = newPage;
                modified = true;
            }
        }
    }

    if (modified) {
        const label = path.relative(REPO_ROOT, TERMS_JSON);
        if (!_DRY_RUN) _writeJson(TERMS_JSON, tj);
        console.log(`${_DRY_RUN ? 'Would update' : 'Updated'} ${label} (case counts)`);
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
//   COUNT(event.prop) op value   e.g.  COUNT(event.audio_href) == 0
//   event sub-conditions (&&)    e.g.  event.source == 'oyez' && event.audio_href && !event.aligned
const _COND_PROP_RE        = /^(\w+)\s*(>=|<=|!=|==|>|<)\s*(?:'([^']*)'|(\d+(?:\.\d+)?))$/;
const _COND_COUNT_RE       = /^COUNT\(event\.(\w+)\)\s*(>=|<=|!=|==|>|<)\s*(\d+(?:\.\d+)?)$/;
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
    let m = _COND_COUNT_RE.exec(s);
    if (m) return { type: 'count', array: 'events', subprop: m[1], op: m[2], value: parseFloat(m[3]) };
    m = _COND_PROP_RE.exec(s);
    if (m) {
        const value = m[3] !== undefined ? m[3] : parseFloat(m[4]);
        return { type: 'property', prop: m[1], op: m[2], value };
    }
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

function _matchesCaseConditions(c, conditions, termDir = '') {
    for (const cond of conditions) {
        if (!cond) continue;
        if (cond.type === 'property') {
            const val = c[cond.prop];
            if (val == null) return false;
            if (!_applyCompOp(val, cond.op, cond.value)) return false;
        } else if (cond.type === 'count') {
            const arr = Array.isArray(c[cond.array]) ? c[cond.array] : [];
            const count = arr.filter(item => !!item[cond.subprop]).length;
            if (!_applyCompOp(count, cond.op, cond.value)) return false;
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

// Scan allTerms for cases that satisfy requiredTags, filter, AND all conditions.
function _casesByConditions(allTerms, requiredTags, conditions, filter = {}) {
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
            if (!_matchesCaseConditions(c, conditions, termDir)) continue;
            cases.push(_setCaseEntry(c, term));
        }
    }
    cases.sort((a, b) =>
        (a.term      || '').localeCompare(b.term      || '') ||
        (a.argument  || '').localeCompare(b.argument  || '') ||
        (a.decision  || '').localeCompare(b.decision  || '') ||
        (a.title     || '').localeCompare(b.title     || ''));
    return cases;
}

// ---------------------------------------------------------------------------

// Scan allTerms for cases that match a set of required tags; return sorted
// case entries.
function _casesByTags(allTerms, requiredTags, filter = {}) {
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
            cases.push(_setCaseEntry(c, term));
        }
    }
    cases.sort((a, b) =>
        (a.term      || '').localeCompare(b.term      || '') ||
        (a.argument  || '').localeCompare(b.argument  || '') ||
        (a.decision  || '').localeCompare(b.decision  || '') ||
        (a.title     || '').localeCompare(b.title     || ''));
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
function _buildTagsCollection(allTerms, collEntry) {
    if (Array.isArray(collEntry.groups) && collEntry.groups.length) {
        const output = [];
        for (const g of collEntry.groups) {
            const requiredTags = Array.isArray(g.tags) && g.tags.length ? g.tags : [];
            if ((g.name ?? g.title) === '*') {
                // Fan-out: one group per unique non-required tag on matching cases.
                const filter = g.decision ? { decision: g.decision } : {};
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
                        const entry = _setCaseEntry(c, term);
                        for (const tag of c.tags) {
                            if (requiredTags.includes(tag)) continue;
                            if (!fanOut.has(tag)) fanOut.set(tag, []);
                            fanOut.get(tag).push(entry);
                        }
                    }
                }
                const sortedNames = [...fanOut.keys()].sort((a, b) =>
                    _naturalSortKey(a).localeCompare(_naturalSortKey(b)));
                for (const name of sortedNames) {
                    const cases = fanOut.get(name);
                    cases.sort((a, b) =>
                        (a.term      || '').localeCompare(b.term      || '') ||
                        (a.argument  || '').localeCompare(b.argument  || '') ||
                        (a.decision  || '').localeCompare(b.decision  || '') ||
                        (a.title     || '').localeCompare(b.title     || ''));
                    output.push({ name, cases });
                }
            } else {
                const filter = g.decision ? { decision: g.decision } : {};
                let cases;
                if (Array.isArray(g.conditions) && g.conditions.length) {
                    const parsed = g.conditions.map(_parseCaseCondition).filter(Boolean);
                    cases = _casesByConditions(allTerms, requiredTags, parsed, filter);
                } else {
                    cases = requiredTags.length ? _casesByTags(allTerms, requiredTags, filter) : [];
                }
                output.push({ name: g.name || g.title || '', cases });
            }
        }
        return output;
    }
    // Flat (single-group) form.
    return [{ name: collEntry.name ?? collEntry.title ?? '', cases: _casesByTags(allTerms, collEntry.tags || []) }];
}

function processCollectionSets(allTerms, dryRun) {
    const transcripts = _buildTranscriptsCollection(allTerms);
    const briefs      = _buildBriefsCollection(allTerms);
    const noteworthy  = _buildNoteworthyCollection(allTerms);

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
            const output = _buildTagsCollection(allTerms, collEntry);
            taggedCollections.push({ collEntry, filePath, output });
        }
    }

    const tCount = transcripts[0].cases.length;
    const bCount = briefs[0].cases.length;
    const nGroups = noteworthy ? noteworthy.output.length : 0;
    const nCount  = noteworthy ? noteworthy.output.reduce((a, g) => a + g.cases.length, 0) : 0;

    const tChanged = _jsonChanged(_TRANSCRIPTS_PATH, transcripts);
    const bChanged = _jsonChanged(_BRIEFS_PATH, briefs);
    const nChanged = noteworthy ? _jsonChanged(_NOTEWORTHY_PATH, noteworthy.output) : false;

    const verb = dryRun ? 'Would write' : 'Wrote';
    if (!dryRun) {
        _mkdirSync(_COLLECTIONS_DIR, { recursive: true });
        if (tChanged) _writeJson(_TRANSCRIPTS_PATH, transcripts);
        if (bChanged) _writeJson(_BRIEFS_PATH,      briefs);
        if (noteworthy && nChanged) _writeJson(_NOTEWORTHY_PATH, noteworthy.output);
        for (const { filePath, output } of taggedCollections) {
            if (_jsonChanged(filePath, output)) _writeJson(filePath, output);
        }
    }
    if (_VERBOSE || tChanged) console.log(`Transcripts: ${verb} ${tCount} case(s) → courts/ussc/collections/transcripts.json`);
    if (_VERBOSE || bChanged) console.log(`Briefs:      ${verb} ${bCount} case(s) → courts/ussc/collections/briefs.json`);
    if (noteworthy && (_VERBOSE || nChanged)) {
        console.log(`Noteworthy:  ${verb} ${nGroups} subset(s) / ${nCount} case(s) → courts/ussc/collections/noteworthy.json`);
        if (noteworthy.skipped || noteworthy.unmatched) {
            console.log(`Noteworthy:  skipped ${noteworthy.skipped} row(s), unmatched ${noteworthy.unmatched} case(s).`);
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

function _scdbVotesSubset(row) {
    const out = [];
    const processed = new Set(); // track which justices we've already processed

    for (const j of (row.justices || [])) {
        let name = (j.justiceName || '').trim().toUpperCase();
        if (_scdbJusticesMap[name]) name = _scdbJusticesMap[name];
        if (!name) continue;

        processed.add(name);

        const voteRaw = (j.vote || '').trim().toLowerCase();
        if (voteRaw === 'jurisdictional dissent') {
            out.push({ name, vote: 'jurisdictional dissent' });
            continue;
        }
        // SCDB sometimes leaves `majority` blank for procedural dissents
        // (e.g. "dissent from a denial or dismissal of certiorari, or dissent
        // from summary affirmation of an appeal"). Treat as minority.
        if (voteRaw.startsWith('dissent from')) {
            out.push({ name, vote: 'minority' });
            continue;
        }
        const maj = _scdbVoteToOurs(j.majority || '');
        if (maj === 'majority' || maj === 'minority') {
            out.push({ name, vote: maj });
            continue;
        }

        // No valid vote - check if justice was serving on decision date
        // If so, mark as recused
        const decisionDate = _scdbNormalizeDate(row.dateDecision || '');
        if (decisionDate && _scdbIsServingOn(name, decisionDate)) {
            out.push({ name, vote: 'recused' });
        }
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
        if (raw === 'jurisdictional dissent') {
            out.push({ name, vote: 'jurisdictional dissent' });
            continue;
        }
        const vote = _scdbVoteTypeToMajority(raw) || _scdbVoteToOurs(raw);
        if (vote !== 'majority' && vote !== 'minority') continue;
        out.push({ name, vote });
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
    for (const k of ['volume','page','usCite','voteMajority','voteMinority','votes','opinion_href']) {
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
    if (volume       && !_scdbFieldPresent(c, 'volume') && volume !== citeVol)  next.volume = volume;
    if (page         && !_scdbFieldPresent(c, 'page')   && page   !== citePage) next.page = page;
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
    if (opinionHref  && !_scdbFieldPresent(c, 'opinion_href')) next.opinion_href = opinionHref;

    // Strip redundant volume/page if usCite already implies them.
    if (_scdbFieldPresent(next, 'usCite')) {
        const [nvCv, nvCp] = _scdbParseUsCite(next.usCite);
        if (nvCv && next.volume === nvCv) delete next.volume;
        if (nvCp && next.page === nvCp) delete next.page;
    }

    const reordered = reorderCase(next);
    if (JSON.stringify(reordered) === JSON.stringify(c)) return false;
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, reordered);
    return true;
}

// Minimal corrective updates (used when --update is set). Trusts our data for
// date fields (records disagreement in scdb_errors) and trusts SCDB for missing
// votes and vote counts.
function _scdbApplyXUpdate(c, row, mm) {
    let changed = false;

    const ignored = new Set(
        String(c.scdb_errors || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
    );

    const addToErrors = (field) => {
        const cur = String(c.scdb_errors || '').split(',').map(s => s.trim()).filter(Boolean);
        if (cur.includes(field)) return;
        cur.push(field);
        c.scdb_errors = cur.join(',');
        changed = true;
    };

    if (mm.decision)   addToErrors('decision');
    if (mm.argument)   addToErrors('argument');
    if (mm.reargument) addToErrors('reargument');

    if (mm.missingVotes && mm.missingVotes.length && !ignored.has('votes')) {
        const list = Array.isArray(c.votes) ? c.votes.slice() : [];
        const seen = new Set(
            list.filter(v => v && v.name).map(v => String(v.name).trim().toUpperCase())
        );
        for (const v of mm.missingVotes) {
            if (seen.has(v.name)) continue;
            seen.add(v.name);
            list.push({ name: v.name, vote: v.vote });
            changed = true;
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
            if (!c.opinion_href && !ignored.has('opinion_href')) {
                const [vol, pg] = _scdbParseUsCite(scdbCite);
                const href = _scdbLocOpinionHref(vol, pg);
                if (href) { c.opinion_href = href; }
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
        const cite = _scdbNormalizeCite(r.usCite || '');
        const title = (r.caseTitle || '').trim();
        if (cite && title && !out[cite]) out[cite] = title;
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

    if (usCite && ldTitles[usCite]) title = ldTitles[usCite];
    else if (ldTitle) title = ldTitle;

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

    const obj = { id: caseId, title, files: 0, votes };
    if (docket && docket !== '0')     obj.number = docket;
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
        if (volume) obj.volume = volume;
        if (page)   obj.page = page;
        const href = _scdbLocOpinionHref(volume, page);
        if (href)   obj.opinion_href = href;
    }
    return reorderCase(obj);
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

function _scdbVerifyTerms(scdb, termFilter, caseFilter, update, verbose, debug, backfill) {
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

    const ldTitles   = (backfill && update) ? _scdbLoadLdTitles()       : {};
    const ldDatesAll = (backfill && update) ? _scdbLoadLdDatesByCaseId() : {};

    for (const cf of cases_files) {
        const term = path.basename(path.dirname(cf));
        let cases;
        try { cases = JSON.parse(fs.readFileSync(cf, 'utf8')); }
        catch (e) { errors.push(`[${term}] Could not parse ${cf}: ${e.message}`); continue; }

        let termChanged = false;

        // Build per-term SCDB lookup tables for matching cases that don't yet
        // have a c.id (e.g. recently imported terms).
        const termYear = (term.match(/^(\d{4})/) || [])[1] || '';
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
                    const errs = String(c.scdb_errors || '').split(',').map(s => s.trim());
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
                    skipped++;
                    continue;
                }
                cid = cand;
                if (update) {
                    c.id = cid;
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
            if (matchHow) matchInfo.push({ title: firstTitle(c.title) || cid, cid, how: matchHow });
            total++;
            const prefix = `${term}/${cid} (${firstTitle(c.title) || cid})`;
            const noVoteData = (c.voteMajority === undefined &&
                                c.voteMinority === undefined &&
                                (!Array.isArray(c.votes) || c.votes.length === 0));

            const row = scdb[cid];
            if (!row) { errors.push(`${prefix}: caseId not found in SCDB`); continue; }

            const caseErrors = [];
            const ignored = new Set(
                String(c.scdb_errors || '')
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean)
            );
            const pushErr = (field, msg) => {
                if (ignored.has(field)) return;
                if (verbose) msg += `\n${' '.repeat(21)}${c.opinion_href || ''}\n`;
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
                         voteMajority: null, voteMinority: null, missingVotes: [] };

            const scdbArg = _scdbNormalizeDate(row.dateArgument || '');
            if (scdbArg && !_scdbContainsDate(c.argument, scdbArg)) {
                mm.argument = true;
                pushErr('argument', `${prefix}: dateArgument not contained by argument: scdb=${JSON.stringify(scdbArg)} ours=${JSON.stringify(c.argument)}`);
            }

            const scdbRe = _scdbNormalizeDate(row.dateRearg || row.datreRearg || '');
            if (scdbRe && !_scdbContainsDate(c.reargument, scdbRe)) {
                mm.reargument = true;
                pushErr('reargument', `${prefix}: dateRearg not contained by reargument: scdb=${JSON.stringify(scdbRe)} ours=${JSON.stringify(c.reargument)}`);
            }

            const scdbDec = _scdbNormalizeDate(row.dateDecision || '');
            const ourDec  = _scdbNormalizeDate(c.decision || '');
            if (scdbDec && ourDec && scdbDec !== ourDec) {
                mm.decision = true;
                pushErr('decision', `${prefix}: decision mismatch: ours=${JSON.stringify(ourDec)} scdb=${JSON.stringify(scdbDec)}`);
            }

            if (_scdbHasImportedOpinion(c) || noVoteData) {
                const [maj, minv] = _scdbMajorityCounts(row);
                if (noVoteData) {
                    if (maj !== null) mm.voteMajority = maj;
                    if (minv !== null) mm.voteMinority = minv;
                    const sVall = _scdbVotesSubset(row);
                    if (sVall.length) mm.missingVotes = sVall;
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
            // Map any docket appearing in our cases.json (including
            // consolidated case numbers) to its disposition string, if any.
            const ourDocketDisposition = new Map();
            for (const c of cases) {
                if (!c.disposition) continue;
                for (const d of splitDocket(c.number)) {
                    if (!ourDocketDisposition.has(d)) ourDocketDisposition.set(d, c.disposition);
                }
            }
            const unmatchedScdb = [...scdbTermIds]
                .filter(k => !matchedFromOurs.has(k))
                .filter(k => {
                    const r = scdb[k];
                    return (r.dateArgument || r.dateRearg || r.datreRearg);
                })
                .filter(k => {
                    const r = scdb[k];
                    return !splitDocket(r.docket).some(d => ourDocketDisposition.has(d));
                })
                .sort();
            if (unmatchedScdb.length) {
                const verb = update ? 'adding' : 'would add';
                console.log(`[${term}] ${unmatchedScdb.length} SCDB case(s) ${verb} (missing from cases.json):`);
                for (const k of unmatchedScdb) {
                    const r = scdb[k];
                    console.log(`  ${k}  ${r.docket || ''}  ${r.dateArgument || r.dateRearg || r.datreRearg || ''}  ${r.caseName || ''}`);
                }
                if (update) {
                    for (const k of unmatchedScdb) {
                        const newCase = _scdbBuildCaseFromSources(scdb[k], k, ldTitles, ldDatesAll[k] || []);
                        cases.push(newCase);
                    }
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
        _scdbVerifyTerms(scdb, opts.term || null, opts.caseFilter || null, !!opts.update, !!opts.verbose, !!opts.debug, !!opts.backfill);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// --dates: verify argument/decision dates and usCite against
//          data/aa/ussc_dates.csv
// ═══════════════════════════════════════════════════════════════════════════

const _DATES_CSV_PATH = path.join(REPO_ROOT, 'data', 'aa', 'ussc_dates.csv');

function _loadDatesCsv() {
    const text = fs.readFileSync(_DATES_CSV_PATH, 'utf8');
    const lines = text.split(/\r\n|\r|\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) throw new Error('ussc_dates.csv is empty');

    const header    = _splitCsvLine(lines[0]);
    const idIdx     = header.indexOf('caseId');
    const citeIdx   = header.indexOf('usCite');
    const argIdx    = header.indexOf('dateArgument');
    const decIdx    = header.indexOf('dateDecision');
    const sourceIdx = header.indexOf('source');
    if (idIdx < 0 || citeIdx < 0 || argIdx < 0 || decIdx < 0) {
        throw new Error('ussc_dates.csv missing expected columns (caseId, usCite, dateArgument, dateDecision)');
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
        console.error(`ERROR: could not read ussc_dates.csv: ${e.message}`);
        process.exit(1);
    }
    console.log(`Loaded ${datesMap.size.toLocaleString()} cases from ussc_dates.csv.\n`);

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
                if (_VERBOSE) console.log(`  ${term}/${c.id} (${firstTitle(c.title) || '?'}): not found in ussc_dates.csv`);
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
                    console.log(`                  ${c.opinion_href || '(no opinion_href)'}`);
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
                if (ev.type !== 'opinion' || ev.offset === undefined || !ev.text_href) continue;

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
                    const m = /^Announcement by Justice (\S+)\b/i.exec(ev.title || '');
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
    // "Announcement by Justice <Last> on <Date>".
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
                ev.type === 'opinion' && _PART_N_RE.test(ev.title || ''));
            if (!hasPartN) continue;

            const opinionVote = c.votes.find(v => v.opinion === true);
            if (!opinionVote) continue;

            const casesDir = path.join(termsDir, term, 'cases');

            for (const ev of c.events) {
                if (ev.type !== 'opinion' || !ev.text_href) continue;

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
                    newTitle = `Announcement by Justice ${capitalized} on ${_splitFormatDate(ev.date)}`;
                }

                if (newTitle === ev.title) continue;

                renameFound++;
                const label = `${term}/${c.id} (${c.title || c.id})`;
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
                if (ev.type !== 'opinion' || !ev.text_href) continue;

                const transcriptPath = path.join(casesDir, ev.text_href);
                if (!fs.existsSync(transcriptPath)) continue;

                let transcript;
                try { transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')); }
                catch { continue; }

                const turns = Array.isArray(transcript.turns) ? transcript.turns : [];
                if (!turns.length) continue;

                // Find the writer's last turn index in the transcript.
                const writerName = opinionVote.name;
                let writerLastTurnIdx = -1;
                for (let i = 0; i < turns.length; i++) {
                    if (_splitSpeakerMatches(turns[i].name, writerName)) {
                        writerLastTurnIdx = i;
                    }
                }
                if (writerLastTurnIdx < 0) continue; // writer not in transcript

                // Build a set of speaker names whose title is CHIEF JUSTICE
                // (from media.speakers) — they are skipped as additional
                // speakers since they're making introductions/thank-yous.
                const chiefJusticeNames = new Set(
                    (transcript.media?.speakers || [])
                        .filter(s => (s.title || '').toUpperCase() === 'CHIEF JUSTICE')
                        .map(s => (s.name || '').trim().toUpperCase())
                );

                // Collect additional speakers (in order of first appearance)
                // from turns that come after the writer's last turn.
                // Skip any chief justice speaker.
                const additionalSpeakers = [];
                const seenAdditional = new Set();
                for (let i = writerLastTurnIdx + 1; i < turns.length; i++) {
                    const sp = turns[i].name;
                    if (chiefJusticeNames.has(sp.trim().toUpperCase())) continue;
                    if (_splitSpeakerMatches(sp, writerName)) continue;
                    if (seenAdditional.has(sp)) continue;
                    // If this speaker's first post-writer turn opens with "Thank you" or "Mr. Clerk",
                    // treat them as a closing/thank-you speaker and skip.
                    if (/^thank you\b|^mr\. clerk\b/i.test((turns[i].text || '').trim())) continue;
                    seenAdditional.add(sp);
                    // First occurrence of this speaker after the writer.
                    additionalSpeakers.push({ name: sp, turnIdx: i });
                }

                if (!additionalSpeakers.length) continue;

                // Check whether this event was already split (avoid duplicates).
                // Skip events that are themselves already split copies (have turn or offset set).
                if (ev.turn !== undefined || ev.offset !== undefined) continue;

                const alreadySplit = c.events.some((e, i) =>
                    i > evIdx &&
                    e.type === 'opinion' &&
                    e.text_href === ev.text_href &&
                    (e.turn !== undefined || e.offset !== undefined)
                );
                if (alreadySplit) continue;

                totalFound++;
                const label = `${term}/${c.id} (${c.title || c.id})`;
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
                        newEv.title = `Announcement by Justice ${capitalized} on ${_splitFormatDate(ev.date)}`;
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

// ═══════════════════════════════════════════════════════════════════════════
// CLI / main
// ═══════════════════════════════════════════════════════════════════════════

const USAGE = `Usage: node update_cases.js                                # update all terms
       node update_cases.js [TERM [CASE]] [--checkurls] [--opinions] [--roles] [--speakers] [--verbose] [--dry-run]
       node update_cases.js TERM CASE --votes win|loss VOTE_STRING [AUTHOR] [--minority NAMES...] [--recused NAMES...] [--dissent NAMES...] [--result STRING]
       node update_cases.js TERM CASE --minority NAMES...    # partial: change minority votes
       node update_cases.js TERM CASE --recused NAMES...     # partial: mark justices recused
       node update_cases.js [TERM [CASE]] --scdb [--add] [--nocache] [--verbose] [--debug]
       node update_cases.js [TERM [CASE]] --dates                              # verify dates vs ussc_dates.csv
       node update_cases.js [TERM [CASE]] --split [--dry-run]                  # detect/split multi-speaker opinion events
       node update_cases.js [TERM [CASE]] --unargued                            # list argument anomalies

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
  node update_cases.js 2024-10 23-975 --recused gorsuch
  node update_cases.js 2024-10 2024-001 --minority sotomayor kagan jackson

  node update_cases.js --scdb                              # rebuild cache + verify all terms
  node update_cases.js --scdb --nocache                    # ignore existing cache (don't read or write)
  node update_cases.js 1926-10 --scdb                      # verify one term vs SCDB
  node update_cases.js 1926-10 1926-011 --scdb --verbose   # verify one case; show extra detail
  node update_cases.js 2024-10 --scdb                      # apply SCDB-derived fixes to cases.json
                                                           #   (records date disagreements in scdb_errors;
                                                           #    fills in missing votes / vote counts)
  node update_cases.js 2024-10 --scdb --dry-run            # report SCDB differences, no writes
  node update_cases.js 2024-10 --scdb --debug              # also dump full ours/scdb JSON on mismatch
  node update_cases.js [TERM] --scdb --backfill              # list SCDB cases missing from cases.json
  node update_cases.js [TERM] --scdb --backfill --dry-run    # preview missing cases without adding

  node update_cases.js --dates                             # check all terms vs ussc_dates.csv
  node update_cases.js 1793-02 --dates                     # check one term vs ussc_dates.csv
  node update_cases.js 1793-02 1793-001 --dates            # check one case vs ussc_dates.csv
  node update_cases.js --dates --verbose                   # also list cases absent from CSV

  node update_cases.js --split                             # find opinion events needing a split
  node update_cases.js 2024-10 --split                     # check one term
  node update_cases.js 2024-10 --split --dry-run           # preview splits without writing

  node update_cases.js --dissents                          # rebuild courts/ussc/people/justices/oral_dissents.json
  node update_cases.js 2024-10 --dissents                  # rebuild for one term only

  node update_cases.js --unargued                          # list all argument anomalies across all terms
  node update_cases.js 2024-10 --unargued                  # list anomalies for one term
  node update_cases.js 2024-10 24-1260 --unargued          # check one case`;

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

    // Collect all terms in order.
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
                if (ev.type !== 'opinion') continue;
                const title = ev.title || '';
                if (title.startsWith('Opinion')) continue;
                // This opinion event's title is non-standard.
                termCases.push({
                    title:    `${c.title || c.id}: ${title}`,
                    term,
                    number:   c.number || c.id || undefined,
                    decision: c.decision || undefined,
                    event:    i + 1,
                });
                // Only take the first matching event per case.
                break;
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

const PARTY_PETITIONER_TERMS = ['petitioner', 'appellant', 'plaintiff'];
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
        // Sync files counts, opinion hrefs, and decision dates after verifyCase
        // loop, since checkOpinionForCase may have added new opinion entries.
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
            entry.volume = cm[1];
            entry.page   = cm[2];
            entry.usCite = `${cm[1]} U.S. ${cm[2]}`;
        }
    }
    entry.opinion_href = opinion.href;
    entry.files        = 0;

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
        // Fall back to last-name match among serving justices.
        const target = name.trim().toUpperCase();
        const matches = servingJustices.filter(c => {
            const parts = c.split(/\s+/);
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
            if (voteMap.has(c)) voteMap.get(c).vote = 'recused';
            else voteMap.set(c, { name: c, vote: 'recused' });
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
        const recusedCount   = theCase.votes.filter(v => v.vote === 'recused').length;

        console.log(`\nUpdated vote breakdown:`);
        console.log(`  Majority: ${theCase.voteMajority}`);
        console.log(`  Minority: ${theCase.voteMinority}`);
        console.log(`  Recused:  ${recusedCount}`);
        console.log(`  Total:    ${theCase.voteMajority + theCase.voteMinority + recusedCount} of ${servingJustices.length} serving`);

    } else {
        // ── Full update: replace all vote data ─────────────────────────────
        const afterVotes = getValues('--votes');
        if (afterVotes.length < 2) {
            console.error('ERROR: --votes requires: win|loss VOTE_STRING [AUTHOR]');
            process.exit(1);
        }
        const [outcome, voteString, authorRaw] = afterVotes;
        if (outcome !== 'win' && outcome !== 'loss') {
            console.error(`ERROR: Outcome must be "win" or "loss", got "${outcome}"`);
            process.exit(1);
        }

        const votes = _parseVoteString(voteString);
        const result = resultOverride ??
            (outcome === 'win'
                ? 'petitioning party received a favorable disposition'
                : 'no favorable disposition for petitioning party apparent');

        const authorCanonical   = authorRaw ? resolveName(authorRaw, 'Author') : null;
        const minorityCanonical = minority.map(n => resolveName(n, 'Minority justice'));
        const recusedCanonical  = recused.map(n => resolveName(n, 'Recused justice'));
        const dissentCanonical  = dissent.map(n => resolveName(n, 'Dissent author'));
        const allMinority       = [...new Set([...minorityCanonical, ...dissentCanonical])];

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
            const vote = recusedSet.has(c) ? 'recused' : minoritySet.has(c) ? 'minority' : 'majority';
            const entry = { name: c, vote };
            if (authorCanonical && c === authorCanonical && vote === 'majority') entry.opinion = true;
            if (dissentSet.has(c) && vote === 'minority') entry.dissent = true;
            return reorderVote(entry);
        });

        const sorted = _scdbSortVotesBySeniority(voteEntries, decisionDate);
        const majorityCount = sorted.filter(v => v.vote === 'majority').length;
        const minorityCount = sorted.filter(v => v.vote === 'minority').length;
        const recusedCount  = sorted.filter(v => v.vote === 'recused').length;

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
        console.log(`  Recused:  ${recusedCount}`);
        console.log(`  Total:    ${majorityCount + minorityCount + recusedCount} of ${servingJustices.length} serving`);
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
                if (['case'].includes(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
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
    if (_explicitCase && positional[0]) {
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

    if (positional.length > 2) {
        console.log(USAGE);
        process.exit(1);
    }

    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        // terms.json is decade-grouped: [{title, pages:[{title, file, cases(count), term?},...]}]
        // Derive the term key from the file URL: /courts/ussc/terms/YYYY-MM/cases.json
        allTerms = tj.flatMap(decade => (decade.groups || []).map(page => {
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
        eventsSorted: 0, casesSorted: 0,
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
        totals.eventsSorted        += r.eventsSorted;
        totals.casesSorted         += r.casesSorted;
        totals.argDatesFixed       += r.argDatesFixed;
        totals.eventTypesFixed     += r.eventTypesFixed;
        totals.mergedCount         += r.mergedCount;
        totals.missingVotes        += (r.missingVotes || 0);
        totals.usscRedundant       += (r.usscRedundant || 0);
    }

    // Cross-scope media-href dedup check (always runs across full scope).
    const mediaDupes = checkDuplicateMediaHrefs(termsToProcess);

    // Lone-dissenter aggregation: always rebuild from the full set of terms
    // (so partial-scope runs don't yield a partial index). Skipped on --dry-run.
    if (!dryRun) {
        processLoneDissenters(allTerms, false);
        processOpinionAuthors(allTerms, false);
        processVocalJustices(allTerms, false);
        processJusticeAdvocates(allTerms, false);
        processCollectionSets(allTerms, false);
        await runDissentCheck(null);
    }

    if (!caseFilter) {
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
    if (r.eventsSorted) console.log(`Event order: ${dryRun ? 'Would sort' : 'Sorted'} events in ${r.eventsSorted} case(s).`);
    if (r.casesSorted)  console.log(`Case order: ${dryRun ? 'Would sort' : 'Sorted'} cases in ${r.casesSorted} term(s).`);
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
    fixArgumentDates, fixEventTypes, sortEvents, sortCases,
    mergeRefiledCases, processTerm,
};
