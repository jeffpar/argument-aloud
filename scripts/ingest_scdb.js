#!/usr/bin/env node
/**
 * ingest_scdb.js
 *
 * Ingests a fresh SCDB "modern" release into the repo's derived SCDB data.
 *
 * Given a release id (e.g. 2026_01), this script reads two raw SCDB downloads
 * from sources/scdb/cache/ ...
 *
 *   SCDB_<release>_justiceCentered_Citation.csv   (one row per justice per case,
 *                                                  cases consolidated by citation)
 *   SCDB_<release>_justiceCentered_Docket.csv     (same, but one row group per
 *                                                  docket number — so a case
 *                                                  consolidated from several
 *                                                  dockets appears more than once)
 *
 * ... and produces:
 *
 *   1. sources/scdb/current/modern.csv
 *      The Citation CSV with the same post-processing the old
 *      scripts/python/scdb_download.py applied (and that
 *      scripts/update_cases.js's processScdbDownloads() still applies):
 *        - drop the sctCite / ledCite / lexisCite / docketId / caseIssuesId /
 *          voteId columns
 *        - convert every MM/DD/YYYY date value to YYYY-MM-DD
 *        - re-quote minimally: a field is quoted only if it contains -, ", or ,
 *      PLUS one new step: the single `docket` value SCDB keeps on the
 *      citation-consolidated row is replaced with every unique docket number
 *      that case was filed under, joined with ";" (the repo's canonical
 *      multi-docket delimiter — see scripts/schema.js splitDockets()). The
 *      docket numbers and their order come from the Docket CSV, keyed by
 *      `caseId`. Original-jurisdiction docket numbers — which SCDB writes a
 *      dozen inconsistent ways ("48 ORIG", "137, Orig.", "No. 12, Original",
 *      "5 (Original)", ...) — are folded to a single canonical "<n> Orig."
 *      form with no embedded comma and no "No. " prefix (see
 *      normalizeDocketField); several such numbers sharing one field are
 *      split onto ";" like any other multi-docket case.
 *
 *      NOTE ON THE JOIN KEY: the task described this as "cases with the same
 *      citation but different docket numbers". SCDB's own consolidation unit is
 *      `caseId` (identical across every docket row for one consolidated case),
 *      so that is what we key on. Keying on `usCite` instead would wrongly
 *      merge the ~14 historic memorandum pages that carry two or three
 *      unrelated per-curiam cases at the same U.S. Reports page, and would
 *      collapse every not-yet-reported case (blank usCite) into one bucket.
 *      Every citation-row docket in this release is already present in its
 *      caseId's docket set, so no information is lost.
 *
 *   2. sources/scdb/cache/scdb.json  (updated in place)
 *      The combined, vars.json-normalized SCDB table keyed by caseId that
 *      scripts/update_cases.js builds and caches. This script re-derives the
 *      "modern" half from the new modern.csv (same normalization as
 *      update_cases.js's _scdbLoadCsv/_scdbNormalizeRow) and merges it in:
 *      new caseIds are added, changed caseIds are overwritten, and everything
 *      else — the entire "legacy" half, plus any modern caseId that has since
 *      dropped out of SCDB — is left untouched.
 *
 *   3. sources/scdb/cache/scdb_ingest_report.md  (+ a console summary)
 *      Lists every caseId whose scdb.json object changed and which prop(s)
 *      changed (old -> new), and every brand-new caseId with its caseName.
 *
 * Usage:
 *   node scripts/ingest_scdb.js [--release <id>] [--dry-run] [--quiet]
 *
 * Options:
 *   --release <id>   SCDB release id, e.g. 2026_01. Default: the newest
 *                    SCDB_*_justiceCentered_Citation.csv present in
 *                    sources/scdb/cache/ (by year, then revision).
 *   --dry-run        Compute everything and write the report, but do not write
 *                    modern.csv or scdb.json.
 *   --quiet          Suppress the per-case console listing (still written to
 *                    the report file).
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SCDB_DIR      = path.join(REPO_ROOT, 'sources', 'scdb');
const CACHE_DIR     = path.join(SCDB_DIR, 'cache');
const CURRENT_DIR   = path.join(SCDB_DIR, 'current');
const MODERN_CSV    = path.join(CURRENT_DIR, 'modern.csv');
const VARS_PATH     = path.join(CURRENT_DIR, 'vars.json');
const SCDB_JSON     = path.join(CACHE_DIR, 'scdb.json');
const REPORT_PATH   = path.join(CACHE_DIR, 'scdb_ingest_report.md');

// Columns dropped from the raw Citation CSV on the way to modern.csv. Mirrors
// _SCDB_DROP_COLS in scripts/update_cases.js and COLS_TO_DELETE in the old
// scripts/python/scdb_download.py.
const DROP_COLS = new Set([
    'sctCite', 'ledCite', 'lexisCite', 'docketId', 'caseIssuesId', 'voteId',
]);

// Per-justice columns (one row per justice per case). Everything before
// `justice` is case-level and identical across a case's rows. Mirrors
// _SCDB_JUSTICE_COLS in scripts/update_cases.js.
const JUSTICE_COLS = [
    'justice', 'justiceName', 'vote', 'opinion', 'direction',
    'majority', 'firstAgreement', 'secondAgreement',
];

const DATE_CELL_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const QUOTE_RE     = /[-,"]/;

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = { release: null, dryRun: false, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--quiet') opts.quiet = true;
        else if (a === '--release') opts.release = argv[++i];
        else if (a.startsWith('--release=')) opts.release = a.slice('--release='.length);
        else if (a === '-h' || a === '--help') { opts.help = true; }
        else { console.error(`Unknown argument: ${a}`); process.exit(2); }
    }
    return opts;
}

// ── CSV helpers ──────────────────────────────────────────────────────────────

/** Read a raw SCDB CSV, stripping a UTF-8 BOM and falling back to latin1 for
 *  older exports that were never UTF-8. Mirrors _readScdbSource in
 *  scripts/update_cases.js. */
function readCsvText(srcPath) {
    const buf = fs.readFileSync(srcPath);
    const start = (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0;
    const slice = start ? buf.subarray(start) : buf;
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(slice);
    } catch {
        console.log(`  (read ${path.basename(srcPath)} as latin1)`);
        return slice.toString('latin1');
    }
}

/** Split one CSV line using SCDB's simple quoting style. Mirrors
 *  _splitCsvLine in scripts/update_cases.js. */
function splitCsvLine(line) {
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

function splitCsvLines(text) {
    const lines = text.split(/\r\n|\r|\n/);
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
}

function quoteField(v) {
    return QUOTE_RE.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function convertDateCell(v) {
    const m = DATE_CELL_RE.exec(v);
    if (!m) return v;
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

// ── release discovery ────────────────────────────────────────────────────────

function discoverRelease(explicit) {
    if (explicit) return explicit;
    const re = /^SCDB_(\d{4})_(\d+)_justiceCentered_Citation\.csv$/;
    let best = null;
    for (const name of fs.readdirSync(CACHE_DIR)) {
        const m = re.exec(name);
        if (!m) continue;
        const key = [Number(m[1]), Number(m[2])];
        if (!best || key[0] > best.key[0] || (key[0] === best.key[0] && key[1] > best.key[1])) {
            best = { key, id: `${m[1]}_${m[2]}` };
        }
    }
    if (!best) {
        console.error(`ERROR: no SCDB_*_justiceCentered_Citation.csv found in ${path.relative(REPO_ROOT, CACHE_DIR)}`);
        process.exit(1);
    }
    return best.id;
}

// ── step 1+2: docket aggregation + modern.csv ────────────────────────────────

// SCDB records original-jurisdiction docket numbers in a dozen inconsistent
// shapes — "48 ORIG", "9 ORIG", "137, Orig.", "126, ORIG.", "13, Original",
// "No. 12, Original", "10 Original", "15 orig.", "5 (Original)", the odd
// doubled "15 ORIG ORIG" — and joins several of them with ", ". We fold every
// such token to a single canonical form: "<n> Orig." with no embedded comma
// and no leading "No. ", and join multiple numbers that shared one field with
// ";" (the repo's docket delimiter — see scripts/schema.js splitDockets()).
// A bare "ORIG" carrying no number is left untouched.
const ORIG_INDICATOR_RE = /\(?\s*orig(?:inal|\.)?\.?\s*\)?/ig;

/** Canonicalize one docket token. Returns an array because a single SCDB field
 *  can pack several original-jurisdiction numbers ("1, 2, Orig." -> two). */
function normalizeOrigToken(token) {
    const tok = token.trim();
    if (!/orig/i.test(tok)) return [tok];
    const stripped = tok.replace(/^\s*no\.\s*/i, '');
    const nums = stripped.replace(ORIG_INDICATOR_RE, ' | ').match(/\d+/g);
    if (!nums || !nums.length) return [tok];        // bare "ORIG" — leave as-is
    return nums.map(n => `${n} Orig.`);
}

/** Canonicalize a whole docket field (possibly already ";"-joined), folding
 *  every original-jurisdiction token and de-duplicating while preserving
 *  order. Non-original docket numbers pass through untouched. */
function normalizeDocketField(value) {
    const out = [];
    for (const part of String(value ?? '').split(';')) {
        const p = part.trim();
        if (!p) continue;
        for (const t of normalizeOrigToken(p)) if (t && !out.includes(t)) out.push(t);
    }
    return out.join(';');
}

/** caseId -> ordered list of unique docket numbers, from the Docket CSV.
 *  Order follows docketId ascending (SCDB's own "-01", "-02", ... suffixes),
 *  which is the natural order of the consolidated dockets. */
function buildDocketMap(docketCsvPath) {
    const text = readCsvText(docketCsvPath);
    const lines = splitCsvLines(text);
    if (!lines.length) { console.error(`ERROR: ${path.basename(docketCsvPath)} is empty`); process.exit(1); }
    const header = splitCsvLine(lines[0]);
    const ci = header.indexOf('caseId');
    const di = header.indexOf('docket');
    const idi = header.indexOf('docketId');
    if (ci < 0 || di < 0 || idi < 0) {
        console.error(`ERROR: ${path.basename(docketCsvPath)} missing caseId/docket/docketId columns`);
        process.exit(1);
    }
    // caseId -> Map(docket -> lowest docketId seen), so we can sort by docketId.
    const seen = new Map();
    for (let i = 1; i < lines.length; i++) {
        const f = splitCsvLine(lines[i]);
        const cid = (f[ci] || '').trim();
        if (!cid) continue;
        const docket = (f[di] || '').trim();
        if (!docket) continue;                 // SCDB sub-case with no docket number
        const docketId = (f[idi] || '').trim();
        let m = seen.get(cid);
        if (!m) { m = new Map(); seen.set(cid, m); }
        if (!m.has(docket) || docketId < m.get(docket)) m.set(docket, docketId);
    }
    const out = new Map();
    for (const [cid, m] of seen) {
        const dockets = [...m.entries()]
            .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
            .map(e => e[0]);
        out.set(cid, dockets);
    }
    return out;
}

/** Process the Citation CSV into modern.csv rows (array of field arrays, header
 *  first), applying column drops, date conversion and docket aggregation.
 *  Returns { header, rows, multiDocketCount }. */
function buildModernRows(citationCsvPath, docketMap) {
    const text = readCsvText(citationCsvPath);
    const lines = splitCsvLines(text);
    if (!lines.length) { console.error(`ERROR: ${path.basename(citationCsvPath)} is empty`); process.exit(1); }

    const srcHeader = splitCsvLine(lines[0]);
    const keepIdx = srcHeader.map((h, i) => (DROP_COLS.has(h) ? -1 : i)).filter(i => i >= 0);
    const header = keepIdx.map(i => srcHeader[i]);
    const caseIdOut = header.indexOf('caseId');
    const docketOut = header.indexOf('docket');
    if (caseIdOut < 0 || docketOut < 0) {
        console.error(`ERROR: ${path.basename(citationCsvPath)} missing caseId/docket columns`);
        process.exit(1);
    }

    const rows = [];
    const multiDocket = new Set();
    const missingFromDocketFile = new Set();
    for (let i = 1; i < lines.length; i++) {
        const src = splitCsvLine(lines[i]);
        const row = keepIdx.map(idx => {
            const v = src[idx] ?? '';
            return v ? convertDateCell(v) : v;
        });
        const cid = (row[caseIdOut] || '').trim();
        const dockets = docketMap.get(cid);
        if (dockets && dockets.length) {
            // Union in the citation row's own docket if (defensively) absent.
            const own = (row[docketOut] || '').trim();
            const all = dockets.includes(own) || !own ? dockets : [...dockets, own];
            row[docketOut] = normalizeDocketField(all.join(';'));
        } else if (cid) {
            row[docketOut] = normalizeDocketField(row[docketOut]);
            missingFromDocketFile.add(cid);
        }
        if ((row[docketOut] || '').includes(';')) multiDocket.add(cid);
        rows.push(row);
    }
    if (missingFromDocketFile.size) {
        console.log(`  WARNING: ${missingFromDocketFile.size} caseId(s) absent from the Docket CSV — kept their citation-row docket as-is`);
    }
    return { header, rows, multiDocketCount: multiDocket.size };
}

function serializeCsv(header, rows) {
    const out = [header.map(quoteField).join(',')];
    for (const row of rows) out.push(row.map(v => quoteField(v ?? '')).join(','));
    return out.join('\n') + '\n';
}

// ── step 3: vars.json normalization (mirrors update_cases.js) ─────────────────

function decodeEntities(s) {
    if (typeof s !== 'string' || s.indexOf('&') < 0) return s;
    const named = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
        sect: '§', para: '¶', deg: '°', copy: '©',
        reg: '®', trade: '™', mdash: '—', ndash: '–',
        lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
        hellip: '…', laquo: '«', raquo: '»', middot: '·',
        bull: '•', dagger: '†', Dagger: '‡',
    };
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-zA-Z]+);/g, (m, ent) => {
        if (ent[0] === '#') {
            const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
            if (Number.isFinite(cp)) { try { return String.fromCodePoint(cp); } catch { return m; } }
            return m;
        }
        return Object.prototype.hasOwnProperty.call(named, ent) ? named[ent] : m;
    });
}

/** col -> { code: label } value maps from vars.json, with string aliases
 *  ("respondent" -> "petitioner" etc.) resolved. Mirrors _scdbLoadVarsMap. */
function loadVarsMap() {
    if (!fs.existsSync(VARS_PATH)) {
        console.log('  WARNING: vars.json not found — no normalization applied');
        return {};
    }
    let raw;
    try { raw = JSON.parse(fs.readFileSync(VARS_PATH, 'utf8')); }
    catch (e) { console.log(`  WARNING: vars.json unreadable (${e.message}) — no normalization`); return {}; }

    const maps = {};
    for (const [col, spec] of Object.entries(raw)) {
        if (spec && typeof spec.values === 'object' && spec.values && !Array.isArray(spec.values)) {
            const m = {};
            for (const [k, v] of Object.entries(spec.values)) {
                m[k] = decodeEntities(typeof v === 'string' ? v : String(v));
            }
            maps[col] = m;
        }
    }
    for (const [col, spec] of Object.entries(raw)) {
        if (spec && typeof spec.values === 'string' && maps[spec.values]) maps[col] = maps[spec.values];
    }
    return maps;
}

/** Normalize one CSV row dict through the vars.json maps. Mirrors the
 *  output-affecting half of _scdbNormalizeRow (whitelist/unmapped tracking is
 *  diagnostic only and omitted). */
function normalizeRow(row, varsMaps) {
    const out = {};
    for (const [col, raw] of Object.entries(row)) {
        const val = String(raw ?? '').trim();
        const map = varsMaps[col];
        if (map && val && val.toUpperCase() !== 'NULL') {
            const label = map[val];
            out[col] = label === undefined ? val : label;
        } else {
            out[col] = val;
        }
    }
    return out;
}

/** Build the normalized, caseId-keyed "modern" table from processed modern.csv
 *  rows. Mirrors _scdbLoadCsv: case-level fields come from a caseId's first
 *  row; every row contributes one justices[] entry. */
function buildModernTable(header, rows, varsMaps) {
    const table = {};
    for (const cols of rows) {
        const row = {};
        for (let j = 0; j < header.length; j++) row[header[j]] = cols[j] ?? '';
        const cid = (row.caseId || '').trim();
        if (!cid) continue;
        const norm = normalizeRow(row, varsMaps);
        const justice = {};
        for (const c of JUSTICE_COLS) if (c in norm) justice[c] = norm[c];
        if (!table[cid]) {
            const c = {};
            for (const [k, v] of Object.entries(norm)) if (!JUSTICE_COLS.includes(k)) c[k] = v;
            c.justices = [];
            table[cid] = c;
        }
        table[cid].justices.push(justice);
    }
    return table;
}

// ── step 4: diff + merge into scdb.json ─────────────────────────────────────

/** Compare two normalized case objects. Returns an array of human-readable
 *  change descriptions ("field: old -> new"), empty when identical. */
function diffCase(oldObj, newObj) {
    const changes = [];
    const fmt = v => (v === undefined ? '(absent)' : JSON.stringify(v));

    const scalarKeys = new Set([
        ...Object.keys(oldObj).filter(k => k !== 'justices'),
        ...Object.keys(newObj).filter(k => k !== 'justices'),
    ]);
    for (const k of scalarKeys) {
        if (oldObj[k] !== newObj[k]) changes.push(`${k}: ${fmt(oldObj[k])} -> ${fmt(newObj[k])}`);
    }

    // Justice rows are matched by the `justice` code, not by array position:
    // SCDB's row order within a case is not stable across releases (and is not
    // meaningful to us), so an index-wise diff would report a bare reordering
    // as though every justice's vote had changed. A justice with no code (not
    // expected for modern data) falls back to a positional key.
    const oj = Array.isArray(oldObj.justices) ? oldObj.justices : [];
    const nj = Array.isArray(newObj.justices) ? newObj.justices : [];
    const keyOf = (j, i) => (j && j.justice ? `code:${j.justice}` : `idx:${i}`);
    const oMap = new Map(oj.map((j, i) => [keyOf(j, i), j]));
    const nMap = new Map(nj.map((j, i) => [keyOf(j, i), j]));

    for (const [k, a] of oMap) {
        if (!nMap.has(k)) changes.push(`justices: ${a.justice || k} removed`);
    }
    for (const [k, b] of nMap) {
        if (!oMap.has(k)) {
            changes.push(`justices: ${b.justice || k} added${b.justiceName ? ` (${b.justiceName})` : ''}`);
        }
    }
    for (const [k, b] of nMap) {
        const a = oMap.get(k);
        if (!a) continue;
        const who = b.justice || a.justice || k;
        const jk = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const f of jk) {
            if (a[f] !== b[f]) changes.push(`justices ${who} ${f}: ${fmt(a[f])} -> ${fmt(b[f])}`);
        }
    }
    return changes;
}

// ── report ──────────────────────────────────────────────────────────────────

function buildReport(meta, added, changed, staleModern) {
    const L = [];
    L.push('# SCDB ingest report');
    L.push('');
    L.push(`- Release: **${meta.release}**`);
    L.push(`- Generated: ${meta.now}`);
    L.push(`- Citation CSV: ${meta.citationName} (${meta.srcRowCount.toLocaleString()} justice rows)`);
    L.push(`- Docket CSV: ${meta.docketName}`);
    L.push(`- modern.csv: ${meta.outRowCount.toLocaleString()} rows, ${meta.modernCaseCount.toLocaleString()} caseIds`);
    L.push(`- caseIds with an aggregated multi-docket value: ${meta.multiDocketCount.toLocaleString()}`);
    L.push(`- scdb.json before: ${meta.scdbBefore.toLocaleString()} caseIds → after: ${meta.scdbAfter.toLocaleString()}`);
    L.push('');
    L.push(`- **New caseIds:** ${added.length.toLocaleString()}`);
    L.push(`- **Changed caseIds:** ${changed.length.toLocaleString()}` +
        (meta.docketOnlyChanged ? ` (${meta.docketOnlyChanged.toLocaleString()} are docket-field-only)` : ''));
    L.push(`- Unchanged modern caseIds: ${meta.unchanged.toLocaleString()}`);
    L.push(`- Modern caseIds in scdb.json no longer in this release (left untouched): ${staleModern.length.toLocaleString()}`);
    if (meta.dryRun) L.push('');
    if (meta.dryRun) L.push('> **--dry-run:** modern.csv and scdb.json were NOT written.');
    L.push('');

    L.push('## New caseIds');
    L.push('');
    if (!added.length) {
        L.push('_None._');
    } else {
        for (const { caseId, caseName } of added) L.push(`- \`${caseId}\` — ${caseName || '(no caseName)'}`);
    }
    L.push('');

    L.push('## Changed caseIds');
    L.push('');
    if (!changed.length) {
        L.push('_None._');
    } else {
        for (const { caseId, caseName, changes } of changed) {
            L.push(`### \`${caseId}\` — ${caseName || '(no caseName)'}`);
            for (const c of changes) L.push(`- ${c}`);
            L.push('');
        }
    }

    if (staleModern.length) {
        L.push('## Modern caseIds no longer in SCDB (not modified, not removed)');
        L.push('');
        for (const cid of staleModern) L.push(`- \`${cid}\``);
        L.push('');
    }

    return L.join('\n') + '\n';
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')
            .filter(l => l.startsWith(' *') || l.startsWith('/**')).join('\n'));
        return;
    }

    const release = discoverRelease(opts.release);
    const citationName = `SCDB_${release}_justiceCentered_Citation.csv`;
    const docketName   = `SCDB_${release}_justiceCentered_Docket.csv`;
    const citationPath = path.join(CACHE_DIR, citationName);
    const docketPath   = path.join(CACHE_DIR, docketName);

    for (const [label, p] of [['Citation', citationPath], ['Docket', docketPath]]) {
        if (!fs.existsSync(p)) {
            console.error(`ERROR: ${label} CSV not found: ${path.relative(REPO_ROOT, p)}`);
            process.exit(1);
        }
    }

    console.log(`SCDB ingest — release ${release}${opts.dryRun ? '  (dry run)' : ''}`);
    console.log(`  Citation: ${path.relative(REPO_ROOT, citationPath)}`);
    console.log(`  Docket:   ${path.relative(REPO_ROOT, docketPath)}`);

    // 1. docket aggregation
    const docketMap = buildDocketMap(docketPath);
    console.log(`  Docket map: ${docketMap.size.toLocaleString()} caseIds`);

    // 2. modern.csv rows
    const { header, rows, multiDocketCount } = buildModernRows(citationPath, docketMap);
    const modernCaseIds = new Set(rows.map(r => r[header.indexOf('caseId')]).filter(Boolean));
    console.log(`  modern.csv: ${rows.length.toLocaleString()} rows, ${modernCaseIds.size.toLocaleString()} caseIds, ${multiDocketCount.toLocaleString()} multi-docket`);

    const csvText = serializeCsv(header, rows);
    if (opts.dryRun) {
        console.log(`  (dry run) would write ${path.relative(REPO_ROOT, MODERN_CSV)}`);
    } else {
        fs.writeFileSync(MODERN_CSV, csvText, 'utf8');
        console.log(`  wrote ${path.relative(REPO_ROOT, MODERN_CSV)}`);
    }

    // 3. normalize into a fresh "modern" table
    const varsMaps = loadVarsMap();
    const newModern = buildModernTable(header, rows, varsMaps);

    // 4. merge into scdb.json
    if (!fs.existsSync(SCDB_JSON)) {
        console.error(`ERROR: ${path.relative(REPO_ROOT, SCDB_JSON)} not found — build it once with \`node scripts/update_cases.js --scdb --nocache\` first`);
        process.exit(1);
    }
    const scdb = JSON.parse(fs.readFileSync(SCDB_JSON, 'utf8'));
    const scdbBefore = Object.keys(scdb).length;

    const added = [];
    const changed = [];
    let unchanged = 0;
    let docketOnlyChanged = 0;

    for (const cid of Object.keys(newModern).sort()) {
        const next = newModern[cid];
        const prev = scdb[cid];
        if (!prev) {
            added.push({ caseId: cid, caseName: next.caseName || '' });
            scdb[cid] = next;
            continue;
        }
        const changes = diffCase(prev, next);
        if (changes.length) {
            changed.push({ caseId: cid, caseName: next.caseName || prev.caseName || '', changes });
            if (changes.every(c => c.startsWith('docket: '))) docketOnlyChanged++;
            scdb[cid] = next;
        } else {
            unchanged++;
        }
    }

    // Modern caseIds present in scdb.json but gone from this release — leave be.
    const staleModern = Object.keys(scdb)
        .filter(cid => !newModern[cid] && modernCaseIdRange(cid))
        .sort();

    const sorted = {};
    for (const k of Object.keys(scdb).sort()) sorted[k] = scdb[k];

    if (opts.dryRun) {
        console.log(`  (dry run) would write ${path.relative(REPO_ROOT, SCDB_JSON)} (${Object.keys(sorted).length.toLocaleString()} caseIds)`);
    } else {
        fs.writeFileSync(SCDB_JSON, JSON.stringify(sorted, null, 2));
        console.log(`  wrote ${path.relative(REPO_ROOT, SCDB_JSON)} (${Object.keys(sorted).length.toLocaleString()} caseIds)`);
    }

    // 5. report
    const meta = {
        release,
        now: new Date().toISOString(),
        citationName, docketName,
        srcRowCount: rows.length,
        outRowCount: rows.length,
        modernCaseCount: modernCaseIds.size,
        multiDocketCount,
        scdbBefore,
        scdbAfter: Object.keys(sorted).length,
        unchanged,
        docketOnlyChanged,
        dryRun: opts.dryRun,
    };
    const report = buildReport(meta, added, changed, staleModern);
    fs.writeFileSync(REPORT_PATH, report, 'utf8');

    console.log('');
    console.log(`  NEW      ${added.length.toLocaleString()} caseId(s)`);
    console.log(`  CHANGED  ${changed.length.toLocaleString()} caseId(s)` +
        (docketOnlyChanged ? ` (${docketOnlyChanged.toLocaleString()} docket-only)` : ''));
    console.log(`  SAME     ${unchanged.toLocaleString()} caseId(s)`);
    if (staleModern.length) console.log(`  STALE    ${staleModern.length.toLocaleString()} modern caseId(s) in scdb.json not in release (untouched)`);
    console.log(`  report → ${path.relative(REPO_ROOT, REPORT_PATH)}`);

    if (!opts.quiet) {
        if (added.length) {
            console.log('\nNew caseIds:');
            for (const { caseId, caseName } of added) console.log(`  ${caseId}  ${caseName}`);
        }
        if (changed.length) {
            console.log('\nChanged caseIds:');
            for (const { caseId, changes } of changed) {
                console.log(`  ${caseId}`);
                for (const c of changes) console.log(`    ${c}`);
            }
        }
    }
}

/** True for a caseId in SCDB's "modern" era (1946 term onward) — used only to
 *  scope the "stale" listing so legacy caseIds are never flagged. */
function modernCaseIdRange(caseId) {
    const m = /^(\d{4})-/.exec(caseId);
    return m ? Number(m[1]) >= 1946 : false;
}

main();
