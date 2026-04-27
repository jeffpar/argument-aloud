/**
 * Subset of validate_cases.py ported to JavaScript — the helpers required by
 * import_ussc.js:
 *   - checkUrl(url)
 *   - waybackPdfUrl(pdfUrl, maxTs)
 *   - fetchOpinions(year2digit, checkUrls)
 *   - checkOpinionForCase(filesPath, caseNumber, term)
 *   - syncFilesCount(casesPath)
 *   - syncOpinionHrefFromFiles(casesPath)
 *
 * This is NOT a full port of validate_cases.py — only the pieces import_ussc
 * imports are implemented.  The remaining functionality of validate_cases
 * remains in the original Python script for now.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT   = path.resolve(__dirname, '..');
export const SCOTUS_BASE = 'https://www.supremecourt.gov';

const _OPINIONS_CACHE = new Map();   // `${year2}|${checkUrls}` -> opinions dict
let _VERBOSE = false;
export const setVerbose = (v) => { _VERBOSE = !!v; };

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
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
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
        console.log('Updated cases.json: synced "files" counts.');
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
