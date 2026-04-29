/**
 * Verify file entries and case metadata for SCOTUS cases — and apply fixes
 * (sorts, key reordering, refiled-case merging, etc.) unless --dry-run.
 *
 * Usage:
 *   node verify_cases.js [TERM [CASE]] [--checkurls] [--opinions] [--verbose] [--dry-run]
 *   node verify_cases.js [TERM [CASE]] --scdb [--update] [--ussc-deck] [--add] [--nocache] [--verbose]
 *
 * Examples:
 *   node verify_cases.js                            # verify all terms
 *   node verify_cases.js 2025-10                    # verify one term
 *   node verify_cases.js 2025-10 24-1260            # verify one case
 *   node verify_cases.js 2025-10 --checkurls        # also probe remote URLs
 *   node verify_cases.js 2025-10 --checkurls --opinions
 *   node verify_cases.js 2025-10 --verbose          # extra logging
 *   node verify_cases.js 2025-10 --dry-run          # report only, no writes
 *
 *   node verify_cases.js --scdb                     # check SCDB cache + verify all terms
 *   node verify_cases.js --scdb --nocache           # ignore SCDB cache
 *   node verify_cases.js 1926-10 --scdb             # verify one term against SCDB
 *   node verify_cases.js 1926-10 1926-011 --scdb --verbose
 *                                                           # verify one case; dump mismatching JSON
 *   node verify_cases.js --scdb --ussc-deck         # also rebuild data/aa/ussc_deck.csv
 *   node verify_cases.js 2024-10 --scdb --update    # apply SCDB-derived fixes to cases.json
 *
 * Combines the logic of:
 *   scripts/python/validate_cases.py
 *   scripts/python/fix_cases.py
 *
 * Also exports helpers used by import_ussc.js / import_oyez.js:
 *   - REPO_ROOT, checkUrl, waybackPdfUrl, fetchOpinions, checkOpinionForCase
 *   - syncFilesCount, syncOpinionHrefFromFiles, setVerbose
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CASE_KEY_ORDER, EVENT_KEY_ORDER, ADVOCATE_KEY_ORDER,
    reorderCase, reorderEvent,
} from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT   = path.resolve(__dirname, '..');
export const SCOTUS_BASE = 'https://www.supremecourt.gov';

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
    `(?:\\s*<td[^>]*>(?:<[^>]+>)?(\\d+ U\\.S\\.[ \\xa0]+\\d+)(?:</[^>]+>)?</td>)?`,
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
        const keys = Object.keys(c);
        if (keys[keys.length - 1] === 'files' && c.files === count) continue;
        delete c.files;
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
        if (c.opinion_href) continue;
        const folderName = _caseFolder(c.number || c.id || '');
        if (!folderName) continue;
        const filesPath = path.join(termDir, 'cases', folderName, 'files.json');
        if (!fs.existsSync(filesPath)) continue;
        let filesData;
        try { filesData = _readJson(filesPath); } catch { continue; }
        if (!Array.isArray(filesData)) continue;
        const opinion = filesData.find(e => e?.type === 'opinion');
        if (!opinion?.href) continue;

        const newCase = {};
        let inserted = false;
        for (const [k, v] of Object.entries(c)) {
            if (k === 'files' && !inserted) {
                newCase.opinion_href = opinion.href;
                inserted = true;
            }
            newCase[k] = v;
        }
        if (!inserted) newCase.opinion_href = opinion.href;
        for (const k of Object.keys(c)) delete c[k];
        Object.assign(c, newCase);
        modified = true;
        const label = c.number || c.id || '?';
        console.log(`  ${label}: inserted opinion_href from files.json`);
    }

    if (modified) _writeJson(casesPath, data);
}

// ═══════════════════════════════════════════════════════════════════════════
// Common small helpers
// ═══════════════════════════════════════════════════════════════════════════

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

function _isoToDateDecision(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    const year = +m[1], month = +m[2], day = +m[3];
    const d = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(d.getTime())
            || d.getUTCFullYear() !== year
            || d.getUTCMonth()    !== month - 1
            || d.getUTCDate()     !== day) return null;
    return `${_DAYS[d.getUTCDay()]}, ${_MONTHS[month - 1]} ${day}, ${year}`;
}

function _dateDecisionToIso(s) {
    const m = _DATE_DEC_PARSE_RE.exec(String(s || '').trim());
    if (!m) return null;
    const monthIdx = _MONTHS.indexOf(m[1]);
    if (monthIdx < 0) return null;
    const day = +m[2], year = +m[3];
    const d = new Date(Date.UTC(year, monthIdx, day));
    if (Number.isNaN(d.getTime())
            || d.getUTCFullYear() !== year
            || d.getUTCMonth()    !== monthIdx
            || d.getUTCDate()     !== day) return null;
    return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

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
        return turns.some(t => t && t.time);
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

// ═══════════════════════════════════════════════════════════════════════════
// Speaker-map cleanup
// ═══════════════════════════════════════════════════════════════════════════

const _SPEAKERS_PATH = path.join(__dirname, 'speakers.json');
const _JUSTICES_PATH = path.join(__dirname, 'justices.json');

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

// ═══════════════════════════════════════════════════════════════════════════
// cases.json mutators (from verify_cases.py)
// ═══════════════════════════════════════════════════════════════════════════

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

function normalizeAudioAlignedPosition(casesPath) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    let modified = false;
    for (const c of data) {
        for (const arg of c.events || []) {
            if (!('aligned' in arg)) continue;
            const keys = Object.keys(arg);
            if (keys[keys.length - 1] === 'aligned') continue;
            const v = arg.aligned;
            delete arg.aligned;
            arg.aligned = v;
            modified = true;
        }
    }
    if (modified) {
        _writeJson(casesPath, data);
        if (_VERBOSE) console.log(` NOTICE: ${path.basename(path.dirname(casesPath))}/cases.json: moved "aligned" to last position in audio objects`);
    }
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

function checkDecisionDates(casesPath, term) {
    const data = _readJson(casesPath);
    if (!Array.isArray(data)) return;
    let modified = false;
    for (const c of data) {
        const decision = c.decision || '';
        const dateDec  = c.dateDecision || '';
        const label    = c.number || c.id || '?';
        const title    = c.title || '';
        if (!decision) continue;
        const generated = _isoToDateDecision(decision);
        if (generated === null) {
            console.log(`WARNING: ${term}/${label} (${title.slice(0,40)}): cannot parse decision='${decision}'`);
            continue;
        }
        if (!dateDec) {
            const newCase = {};
            for (const [k, v] of Object.entries(c)) {
                newCase[k] = v;
                if (k === 'decision') newCase.dateDecision = generated;
            }
            for (const k of Object.keys(c)) delete c[k];
            Object.assign(c, newCase);
            modified = true;
            console.log(`WARNING: ${term}/${label}: inserted dateDecision='${generated}'`);
        } else {
            const parsedBack = _dateDecisionToIso(dateDec);
            if (parsedBack !== decision) {
                console.log(`WARNING: ${term}/${label} (${title.slice(0,40)}): `
                  + `decision='${decision}' but dateDecision parses to '${parsedBack}' (stored: '${dateDec}')`);
            }
        }
    }
    if (modified) {
        _writeJson(casesPath, data);
        console.log(`WARNING: ${term}/cases.json: inserted missing dateDecision values`);
    }
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
        const title = c.title || '';
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
        const title = c.title || '';
        if (_VERBOSE) console.log(` NOTICE: ${term}/${label} (${title.slice(0,40)}): no opinion_href`);
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
                    if (term < '1955-10') {
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

function checkDuplicateCaseNumbers(termDir, term, verbose = false) {
    const casesPath = path.join(termDir, 'cases.json');
    if (!fs.existsSync(casesPath)) return;
    const earlyTerm = term < '1950-10';
    const cases = _readJson(casesPath);
    const seen = {};
    for (const c of cases) {
        const number = c.number || '';
        if (!number) continue;
        const key = number.toLowerCase();
        if (key in seen) {
            if (earlyTerm) {
                if (verbose) console.log(` NOTICE: ${term}/${number}: duplicate case number in cases.json: '${seen[key]}' and '${number}'`);
            } else {
                console.log(`WARNING: ${term}/${number}: duplicate case number in cases.json: '${seen[key]}' and '${number}'`);
            }
        } else {
            seen[key] = number;
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
            if (href in seen) {
                console.log(`WARNING: ${number}: duplicate audio_href at audio[${seen[href]}] and audio[${i}]: '${href}'`);
            } else {
                seen[href] = i;
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
            const hasLocalText = (c.events || []).some(a =>
                a.text_href && !a.text_href.startsWith('http'));
            const hasContent = !!c.files || hasLocalText;
            if (hasContent || verbose) {
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

// ═══════════════════════════════════════════════════════════════════════════
// fix_cases.py logic
// ═══════════════════════════════════════════════════════════════════════════

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
        const titles = duplicates[num].map(c => `"${c.title || '?'}" (${c.number || '?'})`).join(', ');
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
                for (const field of ['audio_href', 'transcript_href']) {
                    const url = e[field] || '';
                    if (url) {
                        (seen[field][url] = seen[field][url] || []).push([term, number, date, source]);
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
            const tcSet = new Set(locs.map(([t, n]) => `${t}\u0000${n}`));
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
    const key = (c) => [(c.argument ? '0' : '1'), c.argument || ''];
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
            const tt = lc.title || '', nn = lc.number || '';
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
        const title = oldCase.title || '', number = oldCase.number || '';
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
                 argDatesFixed: 0, eventTypesFixed: 0, mergedCount: 0 };
    }
    const cases = _readJson(casesPath);
    if (!cases || !cases.length) {
        return { dupCount: 0, casesReordered: 0, eventsReordered: 0, unknownCaseKeys: new Set(), unknownEventKeys: new Set(),
                 hrefUpdated: 0, hrefWarned: 0, hrefMissing: 0, hrefRedundantFixed: 0, hrefOrphaned: [],
                 hrefDupes: 0, hrefStripped: 0, eventsSorted: 0, casesSorted: 0,
                 argDatesFixed: 0, eventTypesFixed: 0, mergedCount: 0 };
    }
    const dupCount = (checkDups && !sortOnly) ? checkDuplicateNumbers(term, cases) : 0;
    let casesReordered = 0, eventsReordered = 0;
    let unknownCaseKeys = new Set(), unknownEventKeys = new Set();
    if (!sortOnly) {
        [casesReordered, eventsReordered, unknownCaseKeys, unknownEventKeys] = fixKeyOrder(term, cases, dryRun);
    }
    const casesDir = path.join(TERMS_DIR, term, 'cases');
    const [hrefUpdated, hrefWarned] = !sortOnly ? fixTextHrefs(term, cases, casesDir, dryRun) : [0, 0];
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

    if (!dryRun && (casesReordered || eventsReordered || hrefUpdated || hrefStripped
            || eventsSorted || casesSorted || argDatesFixed || eventTypesFixed
            || mergedCount || hrefRedundantFixed)) {
        _writeJson(casesPath, cases);
    }
    return { dupCount, casesReordered, eventsReordered, unknownCaseKeys, unknownEventKeys,
             hrefUpdated, hrefWarned, hrefMissing, hrefRedundantFixed, hrefOrphaned,
             hrefDupes, hrefStripped, eventsSorted, casesSorted,
             argDatesFixed, eventTypesFixed, mergedCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCDB CSV post-processing (--scdb)
// ═══════════════════════════════════════════════════════════════════════════
//
// Migrated from scripts/scdb/post_download.py. For each SCDB download named
// in config.json under "scdb" (modern/legacy), reads the corresponding
// CSV in data/scdb/, converts MM/DD/YYYY date values to YYYY-MM-DD, removes
// unused columns, and writes <key>.csv (e.g. modern.csv / legacy.csv). The
// original SCDB_*.csv file is deleted on success.

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

function processScdbDownloads() {
    const configPath = path.join(REPO_ROOT, 'config.json');
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (e) {
        console.log(`SCDB: failed to read ${path.relative(REPO_ROOT, configPath)}: ${e.message}`);
        return;
    }
    const scdb = cfg?.scdb || {};
    const dataDir = path.join(REPO_ROOT, 'data', 'scdb');
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
    if (!any) console.log(`SCDB: no downloads found in ${path.relative(REPO_ROOT, dataDir)}.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCDB cases.json verification (migrated from scripts/scdb/verify_cases.py)
// ═══════════════════════════════════════════════════════════════════════════

const _SCDB_DATA_DIR    = path.join(REPO_ROOT, 'data', 'scdb');
const _SCDB_TERMS_DIR   = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const _SCDB_DECK_PATH   = path.join(REPO_ROOT, 'data', 'aa', 'ussc_deck.csv');
const _LD_CITES_PATH    = path.join(REPO_ROOT, 'data', 'aa', 'ussc_citations.csv');
const _LD_DATES_PATH    = path.join(REPO_ROOT, 'data', 'aa', 'ussc_dates.csv');
const _SCDB_VARS_PATH   = path.join(_SCDB_DATA_DIR, 'vars.json');
const _SCDB_JUSTICES    = path.join(__dirname, 'justices.json');
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

function _scdbFormatLongDate(iso) {
    const dt = _scdbParseIso(iso);
    if (!dt) return '';
    return `${_DOW[dt.getUTCDay()]}, ${_MON[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
}

function _scdbIsoFromLongDate(s) {
    const m = /^(?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day,\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})$/.exec((s||'').trim());
    if (!m) return '';
    const monthIdx = _MON.indexOf(m[1]);
    if (monthIdx < 0) return '';
    return `${m[3]}-${String(monthIdx + 1).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}`;
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

function _scdbVotesSubset(row) {
    const out = [];
    for (const j of (row.justices || [])) {
        let name = (j.justiceName || '').trim().toUpperCase();
        if (_scdbJusticesMap[name]) name = _scdbJusticesMap[name];
        const maj = _scdbVoteToOurs(j.majority || '');
        if (!name || (maj !== 'majority' && maj !== 'minority')) continue;
        out.push({ name, vote: maj });
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
        const vote = _scdbVoteTypeToMajority(raw) || _scdbVoteToOurs(raw);
        if (!name || (vote !== 'majority' && vote !== 'minority')) continue;
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
    return [parse(row.majVotes), parse(row.minVotes)];
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

function _scdbApplyOpinionUpdate(c, row) {
    const usCite = _scdbNormalizeCite(row.usCite || '');
    const [volume, page] = _scdbParseUsCite(usCite);
    const [maj, minv]    = _scdbMajorityCounts(row);
    const votes          = _scdbVotesSubset(row);
    const opinionHref    = _scdbLocOpinionHref(volume, page);

    if (!(volume || page || usCite || maj !== null || minv !== null || votes.length || opinionHref)) return false;

    const next = { ...c };
    if (volume       && !_scdbFieldPresent(c, 'volume'))       next.volume = volume;
    if (page         && !_scdbFieldPresent(c, 'page'))         next.page = page;
    if (usCite       && !_scdbFieldPresent(c, 'usCite'))       next.usCite = usCite;
    if (maj  !== null && !_scdbFieldPresent(c, 'voteMajority')) next.voteMajority = maj;
    if (minv !== null && !_scdbFieldPresent(c, 'voteMinority')) next.voteMinority = minv;
    if (votes.length && !_scdbFieldPresent(c, 'votes'))        next.votes = votes;
    if (opinionHref  && !_scdbFieldPresent(c, 'opinion_href')) next.opinion_href = opinionHref;

    const reordered = reorderCase(next);
    if (JSON.stringify(reordered) === JSON.stringify(c)) return false;
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, reordered);
    return true;
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
        const longD = _scdbFormatLongDate(decision);
        if (longD) obj.dateDecision = longD;
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
    if (_scdbFieldPresent(existing, 'decision') && !_scdbFieldPresent(existing, 'dateDecision')) {
        const longD = _scdbFormatLongDate(_scdbNormalizeDate(existing.decision || ''));
        if (longD) { existing.dateDecision = longD; changed = true; }
    }
    if (_scdbFieldPresent(existing, 'dateDecision') && !_scdbFieldPresent(existing, 'decision')) {
        const raw = (existing.dateDecision || '').trim();
        let iso = _scdbNormalizeDate(raw);
        if (!_SCDB_ISO_RE.test(iso)) iso = _scdbIsoFromLongDate(raw);
        if (iso) { existing.decision = iso; changed = true; }
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

function _scdbVerifyTerms(scdb, termFilter, caseFilter, update, verbose) {
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

    for (const cf of cases_files) {
        const term = path.basename(path.dirname(cf));
        let cases;
        try { cases = JSON.parse(fs.readFileSync(cf, 'utf8')); }
        catch (e) { errors.push(`[${term}] Could not parse ${cf}: ${e.message}`); continue; }

        let termChanged = false;

        for (const c of cases) {
            const cid = c.id;
            if (!cid) { skipped++; continue; }
            if (caseFilter && cid !== caseFilter) continue;
            total++;
            const prefix = `[${term}] ${cid} (${c.title || cid})`;

            const row = scdb[cid];
            if (!row) { errors.push(`${prefix}: caseId not found in SCDB`); continue; }

            const caseErrors = [];

            const scdbArg = _scdbNormalizeDate(row.dateArgument || '');
            if (scdbArg && !_scdbContainsDate(c.argument, scdbArg))
                caseErrors.push(`${prefix}: dateArgument not contained by argument: scdb=${JSON.stringify(scdbArg)} ours=${JSON.stringify(c.argument)}`);

            const scdbRe = _scdbNormalizeDate(row.dateRearg || row.datreRearg || '');
            if (scdbRe && !_scdbContainsDate(c.reargument, scdbRe))
                caseErrors.push(`${prefix}: dateRearg not contained by reargument: scdb=${JSON.stringify(scdbRe)} ours=${JSON.stringify(c.reargument)}`);

            const scdbDec = _scdbNormalizeDate(row.dateDecision || '');
            const ourDec  = _scdbNormalizeDate(c.decision || '');
            if (scdbDec && ourDec && scdbDec !== ourDec)
                caseErrors.push(`${prefix}: decision mismatch: ours=${JSON.stringify(ourDec)} scdb=${JSON.stringify(scdbDec)}`);

            if (_scdbHasImportedOpinion(c)) {
                const [maj, minv] = _scdbMajorityCounts(row);
                if (maj  !== null && c.voteMajority !== maj)
                    caseErrors.push(`${prefix}: voteMajority mismatch: ours=${JSON.stringify(c.voteMajority)} scdb=${JSON.stringify(maj)}`);
                if (minv !== null && c.voteMinority !== minv)
                    caseErrors.push(`${prefix}: voteMinority mismatch: ours=${JSON.stringify(c.voteMinority)} scdb=${JSON.stringify(minv)}`);

                const sV = _scdbVotesSubset(row);
                const oV = _scdbOurVotesSubset(c);
                if (sV.length && !_scdbVotesEqual(_scdbVotesSorted(oV), _scdbVotesSorted(sV))) {
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
                    caseErrors.push(msg);
                }
            }

            if (caseErrors.length) {
                for (const e of caseErrors) errors.push(e);
                if (verbose) {
                    console.log(`\n${prefix}: mismatch detail`);
                    console.log(`  ours:  ${JSON.stringify(c, null, 2).split('\n').join('\n  ')}`);
                    console.log(`  scdb:  ${JSON.stringify(row, null, 2).split('\n').join('\n  ')}`);
                }
            }

            if (update && _scdbApplyOpinionUpdate(c, row)) {
                updates++;
                termChanged = true;
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

function _scdbVerifyUsscDeck(scdb) {
    if (!fs.existsSync(_SCDB_DECK_PATH)) {
        console.error(`ERROR: ussc_deck.csv not found at ${_SCDB_DECK_PATH}`);
        process.exit(1);
    }
    const yearCache = new Map();
    const getCaseIdsForYear = (year) => {
        if (yearCache.has(year)) return yearCache.get(year);
        const ids = new Set();
        const y = parseInt(year, 10);
        for (const yr of [y - 1, y, y + 1]) {
            const dirs = fs.readdirSync(_SCDB_TERMS_DIR).filter(d => d.startsWith(`${yr}-`));
            for (const d of dirs) {
                const p = path.join(_SCDB_TERMS_DIR, d, 'cases.json');
                if (!fs.existsSync(p)) continue;
                try {
                    const cases = JSON.parse(fs.readFileSync(p, 'utf8'));
                    for (const c of cases) if (c.id) ids.add(c.id);
                } catch {}
            }
        }
        yearCache.set(year, ids);
        return ids;
    };

    let checked = 0;
    const notInScdb = [], notInCases = [];
    const { rows } = _readCsvRows(_SCDB_DECK_PATH, 'utf8');
    for (const r of rows) {
        const raw = (r.scdb || '').trim();
        if (!raw) continue;
        const term = (r.term || '').trim();
        for (const sid of raw.split(',').map(s => s.trim()).filter(Boolean)) {
            checked++;
            if (!scdb[sid]) { notInScdb.push(`  ${sid}: ${term}`); continue; }
            const s = scdb[sid];
            const year = (s.term || '').trim();
            if (!/^\d{4}$/.test(year)) {
                notInCases.push(`  ${sid}: unrecognized SCDB term value ${JSON.stringify(year)}`);
                continue;
            }
            const ids = getCaseIdsForYear(year);
            if (!ids.size) {
                notInCases.push(`  ${sid}: no cases.json found for ${+year - 1}-*, ${year}-*, or ${+year + 1}-*`);
                continue;
            }
            if (!ids.has(sid)) {
                const summary = `${year} | ${s.caseName || ''} | docket=${s.docket || ''} | decided=${s.dateDecision || ''}`;
                notInCases.push(`  ${sid}: ${summary}`);
            }
        }
    }
    console.log(`Checked ${checked} SCDB id(s) across ussc_deck rows.`);
    if (notInScdb.length) {
        console.log(`\n${notInScdb.length} caseId(s) not found in SCDB:`);
        for (const m of notInScdb) console.log(m);
    } else console.log('All SCDB ids found in SCDB data.');
    if (notInCases.length) {
        console.log(`\n${notInCases.length} caseId(s) not found in our cases.json:`);
        for (const m of notInCases) console.log(m);
    } else console.log('All SCDB ids found in cases.json.');
}

function _scdbPrintCase(scdb, caseId) {
    const c = scdb[caseId];
    if (!c) { console.log(`caseId ${JSON.stringify(caseId)} not found in loaded SCDB data.`); return; }
    console.log(JSON.stringify(c, null, 2));
}

async function runScdb(opts) {
    // 1) First, migrate/condense any newly-downloaded SCDB CSVs.
    processScdbDownloads();

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
                console.log(`Loaded SCDB cache (${Object.keys(scdb).length.toLocaleString()} cases) from ${path.relative(REPO_ROOT, _SCDB_CACHE_PATH)}.`);
            } catch (e) {
                console.log(`WARNING: failed to read SCDB cache (${e.message}); rebuilding.`);
            }
        }
    }

    _scdbJusticesMap = _scdbLoadJusticesMap();
    if (Object.keys(_scdbJusticesMap).length) console.log(`Loaded justices.json (${Object.keys(_scdbJusticesMap).length} name entries).`);
    else console.log('WARNING: justices.json not found — justice names not normalized.');

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
    } else if (opts.case) {
        _scdbPrintCase(scdb, opts.case);
    } else if (opts.usscDeck) {
        _scdbVerifyUsscDeck(scdb);
    } else {
        _scdbVerifyTerms(scdb, opts.term || null, opts.caseFilter || null, !!opts.update, !!opts.verbose);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI / main
// ═══════════════════════════════════════════════════════════════════════════

const USAGE = `Usage: node verify_cases.js                                # verify all terms
       node verify_cases.js [TERM [CASE]] [--checkurls] [--opinions] [--verbose] [--dry-run]
       node verify_cases.js [TERM [CASE]] --scdb [--update] [--ussc-deck] [--add] [--nocache] [--verbose]

Examples:
  node verify_cases.js 2025-10
  node verify_cases.js 2025-10 24-1260
  node verify_cases.js 2025-10 --checkurls --opinions
  node verify_cases.js 2025-10 --dry-run

  node verify_cases.js --scdb                              # rebuild cache + verify all terms
  node verify_cases.js --scdb --nocache                    # ignore existing cache (don't read or write)
  node verify_cases.js 1926-10 --scdb                      # verify one term vs SCDB
  node verify_cases.js 1926-10 1926-011 --scdb --verbose   # verify one case; dump mismatching JSON
  node verify_cases.js --scdb --ussc-deck                  # also rebuild data/aa/ussc_deck.csv
  node verify_cases.js 2024-10 --scdb --update             # apply SCDB-derived fixes to cases.json`;

async function processOneTerm(term, opts) {
    const { checkUrls, opinionsOnly, verbose, dryRun, allTerms, caseFilter, speakerMapBase } = opts;
    const termDir = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term);
    if (!isDir(termDir)) {
        console.log(`Skipping ${term}: directory not found.`);
        return null;
    }

    checkDuplicateCaseNumbers(termDir, term, verbose);
    checkDuplicateAudioHrefs(termDir);
    checkCasesSync(termDir, verbose);

    const casesPath = path.join(termDir, 'cases.json');
    if (fs.existsSync(casesPath)) {
        migrateArgumentsToAudio(casesPath);
        if (!dryRun) removeRedundantTranscriptFiles(casesPath);
        deduplicateCases(casesPath);
        verifyCasesJsonArguments(casesPath, term, dryRun);
        normalizeAudioAlignedPosition(casesPath);
        checkAudioDates(casesPath, term, dryRun);
        checkDecisionDates(casesPath, term);
        backfillUntrackedFiles(casesPath, term, dryRun);
        if (!dryRun) syncFilesCount(casesPath);
        syncOpinionHrefFromFiles(casesPath);
        warnMissingOpinionHref(casesPath, term);
        pruneRedundantCitation(casesPath, term, caseFilter || '');
        if (checkUrls) await checkCaseHrefs(casesPath, term, opinionsOnly);
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
        if (!caseDirs.length && verbose) console.log(`NOTICE: ${term}: no case directories found`);
        for (const d of caseDirs) {
            await verifyCase(termDir, d, checkUrls, opinionsOnly);
            applySpeakerMapToCase(path.join(casesDir, d), speakerMap, dryRun);
        }
    }

    return processTerm(term, dryRun, false, allTerms, false);
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(USAGE);
        return;
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
            positional.push(a);
        }
    }
    const flags = new Set([...boolFlags].map(f => `--${f}`));
    const checkUrls    = flags.has('--checkurls');
    const opinionsOnly = flags.has('--opinions');
    const verbose      = flags.has('--verbose');
    const dryRun       = flags.has('--dry-run');
    const scdb         = flags.has('--scdb');
    setVerbose(verbose);
    setDryRun(dryRun);

    if (scdb) {
        await runScdb({
            term:     positional[0] || null,
            case:     flagValues.case || null,
            caseFilter: positional[1] || null,
            update:   flags.has('--update'),
            add:      flags.has('--add'),
            usscDeck: flags.has('--ussc-deck') || flags.has('--ussc_deck'),
            noCache:  flags.has('--nocache') || flags.has('--no-cache'),
            verbose,
        });
        return;
    }

    if (positional.length > 2) {
        console.log(USAGE);
        process.exit(1);
    }

    let allTerms = [];
    try {
        const tj = JSON.parse(fs.readFileSync(TERMS_JSON, 'utf8'));
        allTerms = tj.map(e => e.term);
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
    };

    for (const term of termsToProcess) {
        const r = await processOneTerm(term, {
            checkUrls, opinionsOnly, verbose, dryRun, allTerms,
            caseFilter: termsToProcess.length === 1 ? caseFilter : null,
            speakerMapBase,
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
    }

    // Cross-scope media-href dedup check (always runs across full scope).
    const mediaDupes = checkDuplicateMediaHrefs(termsToProcess);

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
    removeRedundantTranscriptFiles, checkDecisionDates, checkCaseHrefs,
    backfillUntrackedFiles, checkAudioDates, warnMissingOpinionHref,
    verifyFilesJson, verifyCase, deduplicateCases,
    checkDuplicateCaseNumbers, checkDuplicateAudioHrefs, checkCasesSync,
    fixKeyOrder, fixTextHrefs, checkMissingTextHrefs, checkOrphanedTranscripts,
    checkDuplicateTextHrefs, fixOyezTranscriptHrefs, checkDuplicateMediaHrefs,
    fixArgumentDates, fixEventTypes, sortEvents, sortCases,
    mergeRefiledCases, processTerm,
};
