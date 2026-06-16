#!/usr/bin/env node
/**
 * Fetches oral argument listings from supremecourt.gov for an entire term,
 * producing a cases.json, and generating transcript JSON files from the PDF
 * transcripts.
 *
 * Usage:
 *   node scripts/import_ussc.js TERM [CASE]
 *     [--docket] [--reparse] [--verbose] [--cases] [--checkurls] [--prompt]
 *
 * Examples:
 *   node scripts/import_ussc.js 2025-10
 *   node scripts/import_ussc.js 2024-10 --docket
 *   node scripts/import_ussc.js 2010-10 09-5801
 *
 * JS port of scripts/import_ussc.py — see that file (and copilot-instructions.md)
 * for full step-by-step documentation.
 *
 * Requires: pdftotext (poppler-utils) on PATH.
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseHtml } from 'node-html-parser';

import { reorderCase, reorderEvent } from './schema.js';
import {
    REPO_ROOT, checkUrl, waybackPdfUrl, fetchOpinions, checkOpinionForCase,
    syncFilesCount, syncOpinionHrefFromFiles, setVerbose as setVcVerbose, sortCases,
} from './update_cases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Regex constants ────────────────────────────────────────────────────────

const CASE_RE = /^(\d+(?:-\d+|-Orig|A\d+))\s*(.+)$/i;
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;
const ORIG_RE = /^(\d+)[\s-]Orig\.?$/i;

const _TRANSCRIPT_CASE_RE = /^(\d+(?:-\d+|[\s-]?Orig\.?|A\d+)?)\.?\s*(.+)$/i;
const _ORIG_NORM_RE       = /[\s-]*Orig\.?$/i;

const _SPEAKERS_PATH = path.join(REPO_ROOT, 'data', 'ussc', 'speakers.json');
const _JUSTICES_PATH = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');

// ── Module-level flags / state ─────────────────────────────────────────────

let VERBOSE     = false;
let ADD_CASES   = false;
let CHECK_URLS  = false;
let PROMPT      = false;
let _anyChanges = false;

function vprint(...args)        { if (VERBOSE) console.log(...args); }
function reportChange(...args)  { _anyChanges = true; console.log(...args); }

const BASE_URL         = 'https://www.supremecourt.gov';
const _WAYBACK_CDX_URL = 'https://web.archive.org/cdx/search/cdx';
const _WAYBACK_REWRITE_RE = /https?:\/\/web\.archive\.org\/web\/\d{14}\//g;

const USER_AGENT = 'Mozilla/5.0';

// ── Small fs/json helpers ──────────────────────────────────────────────────

const exists       = (p) => fs.existsSync(p);
const readText     = (p) => fs.readFileSync(p, 'utf8');
const writeText    = (p, s) => fs.writeFileSync(p, s, 'utf8');
const readJson     = (p) => JSON.parse(readText(p));
const writeJson    = (p, d) => writeText(p, JSON.stringify(d, null, 2) + '\n');
const ensureDir    = (p) => fs.mkdirSync(p, { recursive: true });
const unlinkSafe   = (p) => { try { fs.unlinkSync(p); } catch {} };

function relRepo(p) {
    const r = path.relative(REPO_ROOT, p);
    return r.startsWith('..') ? p : r;
}

// ── Docket number map ──────────────────────────────────────────────────────

function _loadDocketMap() {
    const p = path.join(REPO_ROOT, 'config.json');
    const result = new Map();   // key: `${term}|${case}`
    if (!exists(p)) return result;
    let data;
    try { data = readJson(p); } catch { return result; }
    const docket = data?.ussc?.docket || {};
    for (const [key, value] of Object.entries(docket)) {
        const colon = key.split(':');
        if (colon.length !== 2) continue;
        const [term, c] = colon;
        result.set(`${term.trim()}|${c.trim()}`, String(value).trim());
    }
    return result;
}
const _DOCKET_MAP = _loadDocketMap();

function _docketNumber(caseNumber, termYear) {
    const m = ORIG_RE.exec(caseNumber);
    if (m) {
        const override = _DOCKET_MAP.get(`${termYear}|${caseNumber}`);
        if (override) return override;
        const yy = termYear.slice(-2);
        return `${yy}o${m[1]}`;
    }
    return caseNumber;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function _safeUrl(url) {
    // Equivalent to urllib.parse.quote(url, safe=":/?#[]@!$&'()*+,;=%")
    return encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, '%$1');
}

async function _fetchWithUA(url, { method = 'GET', timeoutMs = 30000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(_safeUrl(url), {
            method,
            redirect: 'follow',
            headers: { 'User-Agent': USER_AGENT },
            signal: ctrl.signal,
        });
    } finally { clearTimeout(t); }
}

async function fetchHtml(url) {
    const resp = await _fetchWithUA(url, { timeoutMs: 30000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    return await resp.text();
}

async function _fetchHtmlViaWayback(originalUrl, yearStr) {
    const yearInt = parseInt(yearStr, 10);
    const minDate = `${yearInt + 1}0901`;
    const cdxApi = `${_WAYBACK_CDX_URL}?url=${encodeURIComponent(originalUrl)}`
                 + `&output=json&from=${minDate}&limit=5&statuscode=200`;
    const resp = await _fetchWithUA(cdxApi, { timeoutMs: 30000 });
    if (!resp.ok) throw new Error(`Wayback CDX HTTP ${resp.status}`);
    const cdxRows = await resp.json();
    if (!Array.isArray(cdxRows) || cdxRows.length < 2) {
        throw new Error(`No Wayback snapshot found for ${originalUrl} after ${minDate}`);
    }
    const header = cdxRows[0];
    const tsIdx  = header.indexOf('timestamp') >= 0 ? header.indexOf('timestamp') : 1;
    const ts     = cdxRows[1][tsIdx];
    const snapshotUrl = `https://web.archive.org/web/${ts}/${originalUrl}`;
    console.log(`Fetching Wayback snapshot (${ts.slice(0,8)}) for ${originalUrl} ...`);
    let html = await fetchHtml(snapshotUrl);
    return html.replace(_WAYBACK_REWRITE_RE, '');
}

async function downloadFile(url, dest) {
    const resp = await _fetchWithUA(url, { timeoutMs: 60000 });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(dest, buf);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Date conversion ────────────────────────────────────────────────────────

function parseDate(s) {
    const m = DATE_RE.exec((s || '').trim());
    if (!m) return null;
    const [, mo, da, yy] = m;
    return `20${yy}-${String(parseInt(mo, 10)).padStart(2, '0')}-${String(parseInt(da, 10)).padStart(2, '0')}`;
}

const DOCKET_DATE_RE = /^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/;
const MONTH_MAP = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04',
    May: '05', Jun: '06', Jul: '07', Aug: '08',
    Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

function parseDocketDate(s) {
    const m = DOCKET_DATE_RE.exec((s || '').trim());
    if (!m) return null;
    const monthKey = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
    const month = MONTH_MAP[monthKey];
    if (!month) return null;
    return `${m[3]}-${month}-${m[2].padStart(2, '0')}`;
}

const ARCHIVED_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
function parseArchivedDate(s) {
    const m = ARCHIVED_DATE_RE.exec((s || '').trim());
    if (!m) return null;
    const [, mo, da, yr] = m;
    return `${yr}-${String(parseInt(mo, 10)).padStart(2, '0')}-${String(parseInt(da, 10)).padStart(2, '0')}`;
}

const parseAnyDate = (s) => parseDate(s) || parseArchivedDate(s);

const _ANY_DATE_TOKEN_RE = /\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})/g;

function parseAnyDates(s) {
    const raw = (s || '').trim();
    if (!raw) return [];
    const single = parseAnyDate(raw);
    if (single) return [single];
    const out = [];
    const seen = new Set();
    for (const tok of raw.match(_ANY_DATE_TOKEN_RE) || []) {
        const iso = parseAnyDate(tok);
        if (iso && !seen.has(iso)) {
            out.push(iso);
            seen.add(iso);
        }
    }
    return out;
}

function _normalizeNumber(num) {
    let n = (num || '').trim().replace(/\.$/, '');
    // "22O142" (SCOTUS original-jurisdiction docket format) → "142-Orig"
    const origO = /^\d{2}[Oo](\d+)$/.exec(n);
    if (origO) return `${origO[1]}-Orig`;
    n = n.replace(_ORIG_NORM_RE, '-Orig');
    return n;
}

function _caseFolder(number) {
    return String(number || '').split(',')[0].trim();
}

const _USSC_HREF_NUM_RE = /\/(?:argument_transcripts|transcripts)\/\d+\/([^/]+)\.pdf/i;

function _ussCcaseNumFromHref(transcriptHref = '', textHref = '') {
    if (textHref && textHref.includes('/')) return textHref.split('/')[0];
    if (transcriptHref) {
        const m = _USSC_HREF_NUM_RE.exec(transcriptHref);
        if (m) {
            let raw = m[1].replace(/_[a-z0-9]{4}$/i, '');
            return _normalizeNumber(raw);
        }
    }
    return '';
}

function _usscAudioTitle(typeVal, dateStr, caseNum = '') {
    let dateLabel;
    try {
        const [y, mo, d] = (dateStr || '').split('-');
        const monthName  = ['January','February','March','April','May','June',
                            'July','August','September','October','November','December'][parseInt(mo, 10) - 1];
        if (!monthName || !y || !d) throw new Error('bad');
        dateLabel = `${monthName} ${parseInt(d, 10)}, ${y}`;
    } catch {
        dateLabel = dateStr || '?';
    }
    const caseStr = caseNum ? ` in No. ${caseNum}` : '';
    if (typeVal === 'reargument') return `Oral Reargument${caseStr} on ${dateLabel}`;
    return `Oral Argument${caseStr} on ${dateLabel}`;
}

// ── Speaker name resolution ────────────────────────────────────────────────

const _APPEARANCES_NAME_RE = new RegExp(
    `^([A-Z][A-Za-z'\\.\\-]+(?:\\s+[A-Z][A-Za-z'\\.\\-]+){1,}` +
    `(?:,\\s*(?:JR|SR|II|III|IV)\\.?)?)[\\s,]`
);
const _SUFFIX_WORDS = new Set(['JR', 'SR', 'II', 'III', 'IV']);
const _SUFFIX_NORM_RE = /^(.+?)(?:,\s*|\s+)(JR\.|SR\.|JR|SR|II|III|IV)\s*$/i;

function _normalizeNameSuffix(name) {
    const m = _SUFFIX_NORM_RE.exec(name);
    if (!m) return name;
    const base = m[1].trim();
    let suffix = m[2].toUpperCase().replace(/\.$/, '');
    if (suffix === 'JR' || suffix === 'SR') suffix += '.';
    return `${base}, ${suffix}`;
}

function _buildJusticeLastNameMap() {
    if (!exists(_JUSTICES_PATH)) return new Map();
    const data = readJson(_JUSTICES_PATH);
    const result = new Map();   // last → [{canonical, dateStart, dateStop}]
    const addEntry = (last, canonical, dateStart, dateStop) => {
        if (!result.has(last)) result.set(last, []);
        result.get(last).push({ canonical, dateStart: dateStart || '', dateStop: dateStop || '' });
    };
    const lastNameOf = (s) => {
        const words = s.toUpperCase().split(/\s+/);
        let last = words[words.length - 1];
        if (_SUFFIX_WORDS.has(last) && words.length > 1) last = words[words.length - 2];
        return last;
    };
    for (const [canonical, entry] of Object.entries(data)) {
        const u = canonical.toUpperCase();
        const last = lastNameOf(canonical);
        const tenures = Array.isArray(entry?.tenures) && entry.tenures.length
            ? entry.tenures
            : [{ dateStart: entry?.dateStart || '', dateStop: entry?.dateStop || '' }];
        for (const t of tenures) addEntry(last, u, t.dateStart, t.dateStop);
        for (const alt of (entry?.alternates || [])) {
            const aLast = lastNameOf(alt);
            for (const t of tenures) addEntry(aLast, u, t.dateStart, t.dateStop);
        }
    }
    return result;
}

// Pick the canonical justice name for `last` whose tenure includes `date`
// (YYYY-MM-DD). If no date is given or no tenure matches, fall back to the
// first registered entry (preserves prior behavior).
function _resolveJusticeForDate(last, date) {
    const entries = _JUSTICE_LAST_NAME_MAP.get(last);
    if (!entries || !entries.length) return null;
    if (date) {
        for (const e of entries) {
            const okStart = !e.dateStart || e.dateStart <= date;
            const okStop  = !e.dateStop  || date <= e.dateStop;
            if (okStart && okStop) return e.canonical;
        }
    }
    return entries[0].canonical;
}

function _buildJusticeCanonicalSet() {
    if (!exists(_JUSTICES_PATH)) return new Set();
    const data = readJson(_JUSTICES_PATH);
    return new Set(Object.keys(data).map(c => c.toUpperCase()));
}

const _JUSTICE_LAST_NAME_MAP = _buildJusticeLastNameMap();
const _JUSTICE_CANONICAL_SET = _buildJusticeCanonicalSet();
const _JUSTICE_LAST_NAMES    = new Set(_JUSTICE_LAST_NAME_MAP.keys());

function _loadSpeakersSection(section) {
    if (!exists(_SPEAKERS_PATH)) return new Map();
    const data = readJson(_SPEAKERS_PATH);
    const result = new Map();
    const sect = data[section] || {};
    for (const [k, v] of Object.entries(sect)) {
        result.set(k.toUpperCase(), v.toUpperCase());
    }
    return result;
}

const _TYPO_SPEAKER_MAP   = _loadSpeakersSection('typos');
const _RENAME_SPEAKER_MAP = _loadSpeakersSection('rename');

const _ADVOCATE_TITLE_PREFIX_RE = /^(MR\.|MS\.|MRS\.|MISS|GENERAL|GEN\.)\s+(.+)$/;

function _stripTitlePrefix(name) {
    const m = _ADVOCATE_TITLE_PREFIX_RE.exec(name);
    if (!m) return [name, ''];
    let t = m[1];
    if (t === 'GEN.') t = 'GENERAL';
    return [m[2], t];
}

const _APPEARANCES_ESQ_RE             = /^(.+?)(?:,\s*|\s+)(?:ESQUIRE|ESQ\.)/i;
const _APPEARANCES_HEADER_PREFIX_RE   = /^(?:ORAL\s+)?(?:ARGUMENT|REBUTTAL\s+ARGUMENT)\s+(?:OF|BY)\s+/i;

const _FEMALE_FIRST_NAMES = new Set([
    'ABIGAIL','ADRIENNE','AILEEN','AIMEE','ALEXIS','ALICE','ALICIA','ALISON','ALLISON','ALYSSA',
    'AMANDA','AMBER','AMY','ANDREA','ANGELA','ANN','ANNA','ANNE','ANNETTE','ARIEL','ASHLEY',
    'AUDREY','AUTUMN','BARBARA','BETTY','BEVERLY','BRENDA','BRIANNA','BRITTANY','BROOKE',
    'CANDICE','CAROL','CARLY','CAROLYN','CASSANDRA','CECILIA','CHARLOTTE','CHELSEA','CHERYL',
    'CHRISTY','CINDY','CLAIRE','CLAUDIA','COLLEEN','CONSTANCE','COURTNEY','CRYSTAL','CYNTHIA',
    'DANA','DAWN','DEBORAH','DEBRA','DENISE','DIANA','DIANE','DONNA','DOROTHY','ELENA','ELEANOR',
    'ELIZABETH','EMILY','EMMA','ERIN','EVA','FAITH','FELICIA','FLORENCE','FRANCES','GLORIA',
    'GRACE','HANNAH','HEATHER','HELEN','HOLLY','HOPE','IRENE','IVY','JACKIE','JACQUELINE','JADE',
    'JANET','JASMINE','JEAN','JENNIFER','JESSICA','JOANNA','JOANNE','JOY','JOYCE','JUDITH','JULIA',
    'JULIE','JUNE','JUSTINE','KAREN','KATHERINE','KATHLEEN','KATHRYN','KATRINA','KELLY','KIMBERLY',
    'KRISTIN','LACEY','LAURA','LAURIE','LEAH','LEILA','LENA','LESLIE','LILY','LINDA','LISA',
    'LORENA','LORI','LORRAINE','LUCY','LYDIA','MACKENZIE','MADELINE','MARGARET','MARIA','MARIE',
    'MARTHA','MARY','MAYA','MEGAN','MELISSA','MICHELLE','MILA','MIRANDA','MOLLY','MONIQUE','NAOMI',
    'NATALIE','NANCY','NINA','NORA','NORMA','OLIVIA','PAIGE','PAMELA','PATRICIA','PEGGY','PHYLLIS',
    'RACHEL','REBECCA','REBEKAH','RENEE','RHONDA','ROBIN','ROSA','ROSE','ROSEMARY','RUTH','SAMANTHA',
    'SANDRA','SARA','SARAH','SHARON','SHEILA','SHELLEY','SIERRA','SONYA','SOPHIA','STACEY','STACY',
    'STELLA','STEPHANIE','SUMMER','SUSAN','SYLVIA','TAMARA','TAMMY','TANYA','TARA','TERESA','THERESA',
    'TIFFANY','TINA','TRACY','VANESSA','VERONICA','VIOLET','VIRGINIA','VIVIAN','WANDA','WENDY',
    'WHITNEY','YVONNE','ZOE',
]);

function _pickCandidate(candidates, title) {
    if (candidates.length === 1) return candidates[0];
    const isFemale = title === 'MS.' || title === 'MRS.' || title === 'MISS';
    const isMale   = title === 'MR.';
    for (const cand of candidates) {
        const [stripped] = _stripTitlePrefix(cand);
        const first = stripped.split(/\s+/)[0];
        if (isFemale && _FEMALE_FIRST_NAMES.has(first)) return cand;
        if (isMale && !_FEMALE_FIRST_NAMES.has(first)) return cand;
    }
    return candidates[0];
}

const _APPEARANCES_LINE_RE = /^\s*\d{1,2}\s{2,}(.+)/;

function parseAppearances(rawText) {
    let inAppearances = false;
    const names = [];
    for (const line of rawText.split('\n')) {
        const m = _APPEARANCES_LINE_RE.exec(line);
        if (!m) continue;
        const content = m[1].trim();
        if (/^APPEARANCES:?$/.test(content)) { inAppearances = true; continue; }
        if (!inAppearances) continue;
        const collapsed = content.replace(/ /g, '');
        if (collapsed.startsWith('CONTENTS') || collapsed.startsWith('PROCEEDINGS')) break;
        const esq = _APPEARANCES_ESQ_RE.exec(content);
        if (esq) { names.push(esq[1].trim()); continue; }
        const nm = _APPEARANCES_NAME_RE.exec(content);
        if (nm) names.push(nm[1].trim());
    }
    const result = new Map();
    for (let nm of names) {
        let nameUpper = nm.toUpperCase();
        nameUpper = nameUpper.replace(_APPEARANCES_HEADER_PREFIX_RE, '').trim();
        if (!nameUpper) continue;
        const parts = nameUpper.split(/\s+/).map(p => p.replace(/^[.,]+|[.,]+$/g, ''));
        let last = parts[parts.length - 1];
        if (_SUFFIX_WORDS.has(last) && parts.length > 1) last = parts[parts.length - 2];
        if (!result.has(last)) result.set(last, []);
        result.get(last).push(nameUpper);
    }
    return result;
}

const _RESOLVE_TITLE_RE = /^(CHIEF JUSTICE|JUSTICE|MR\.|MS\.|MRS\.|MISS|GENERAL|GEN\.)\s+(.+)/;

function _resolveSpeaker(rawName, appearances, argDate = '') {
    const rawUpper = rawName.toUpperCase().trim();
    if (rawUpper === 'QUESTION' || rawUpper === 'Q') return ['UNKNOWN JUSTICE', 'JUSTICE'];
    if (_JUSTICE_CANONICAL_SET.has(rawUpper)) return [rawUpper, 'JUSTICE'];
    const m = _RESOLVE_TITLE_RE.exec(rawUpper);
    if (m) {
        let title = m[1];
        if (title === 'GEN.') title = 'GENERAL';
        const rest = m[2].trim();
        const words = rest.split(/\s+/);
        let last = words[words.length - 1].replace(/[.,]+$/, '');
        if (_SUFFIX_WORDS.has(last) && words.length > 1) {
            last = words[words.length - 2].replace(/[.,]+$/, '');
        }
        if (title === 'CHIEF JUSTICE' || title === 'JUSTICE') {
            const resolved = _resolveJusticeForDate(last, argDate);
            if (resolved) return [resolved, title];
            const corrected = _TYPO_SPEAKER_MAP.get(rawUpper);
            if (corrected) {
                const cm = /^(CHIEF JUSTICE|JUSTICE)\s+(.+)/.exec(corrected);
                const cTitle = cm ? cm[1] : title;
                const cName  = cm ? cm[2] : corrected;
                const cWords = cName.split(/\s+/);
                let cLast = cWords[cWords.length - 1].replace(/[.,]+$/, '');
                if (_SUFFIX_WORDS.has(cLast) && cWords.length > 1) {
                    cLast = cWords[cWords.length - 2].replace(/[.,]+$/, '');
                }
                const cResolved = _resolveJusticeForDate(cLast, argDate);
                if (cResolved) return [cResolved, cTitle];
                return [cName, cTitle];
            }
            title = '';
        }
        const candidates = appearances.get(last);
        let full = candidates ? _pickCandidate(candidates, title) : rest;
        const [stripped, extra] = _stripTitlePrefix(full);
        if (extra) {
            full = stripped;
            if (title && extra !== title) title = `${title},${extra}`;
            else if (!title) title = extra;
        }
        return [full, title];
    }
    const bare = rawUpper.replace(/[.,]+$/, '');
    if (!bare.includes(' ')) {
        const candidates = appearances.get(bare);
        const full = candidates && candidates[0];
        if (full) {
            const [stripped, extra] = _stripTitlePrefix(full);
            return [extra ? stripped : full, extra];
        }
    }
    return [rawName, ''];
}

// ── Transcript extraction ──────────────────────────────────────────────────

const SKIP_PATTERNS = [
    /^ORAL (?:ARGUMENT|REBUTTAL) OF\b/,
    /^ON BEHALF OF\b/,
    /^FOR THE UNITED\b/,
    /^REBUTTAL ARGUMENT OF\b/,
    /^P R O C E E D I N G S$/,
    /^C O N T E N T S$/,
    /^APPEARANCES:?$/,
    /^\(.*\)$/,
    /^[\s\-]+$/,
];

const TERMINATOR_PATTERNS = [
    /^\(Whereupon\b/,
    /\[\d+\]\s+\d+:\d+/,
];

const CONTENT_LINE_RE = /^\s{0,3}(\d{1,2})\s{2,}(.+)/;

const SPEAKER_RE = new RegExp(
    `^((?:CHIEF JUSTICE|JUSTICE|MR\\.|MS\\.|MRS\\.|MISS|GENERAL|GEN\\.)` +
    `\\s+[A-Z][A-Za-z'\\.]+(?:\\s+[A-Z][A-Za-z'\\.]+)*` +
    `|QUESTION|Q):\\s*([\\s\\S]*)`
);

function _buildTranscriptEnvelope(turns, audioHref = '', speakers = null) {
    if (speakers === null) {
        const seen = new Set();
        const speakerNames = [];
        for (const t of turns) {
            if (!seen.has(t.name)) { seen.add(t.name); speakerNames.push(t.name); }
        }
        speakers = speakerNames.map(n => ({ name: n }));
    }
    return { media: { url: audioHref, speakers }, turns };
}

const _TEXT_CACHE_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'transcripts', 'text');

function _cachedTextPath(caseNumber, date, term) {
    const year = term.split('-')[0];
    const filename = `${_caseFolder(caseNumber)}_${date}.txt`;
    return path.join(_TEXT_CACHE_DIR, year, filename);
}

function _mergeSpeakerTitles(newSpeakers, existingSpeakers, label = '') {
    const existingByName = new Map(existingSpeakers.map(s => [s.name, s.title || '']));
    const result = [];
    for (const sp of newSpeakers) {
        const exTitle = existingByName.has(sp.name) ? existingByName.get(sp.name) : undefined;
        if (exTitle !== undefined && exTitle !== (sp.title || '')) {
            result.push({ name: sp.name, title: exTitle });
        } else {
            result.push(sp);
        }
    }
    const newNames = new Set(newSpeakers.map(s => s.name));
    for (const sp of existingSpeakers) {
        if ((sp.title || '').includes('MS.') && !newNames.has(sp.name)) {
            const prefix = label ? `${label}: ` : '';
            console.log(`WARNING: ${prefix}existing MS. speaker `
                      + `"${sp.name}" (title: "${sp.title}") `
                      + `not found in reparsed transcript`);
        }
    }
    return result;
}

const _JUSTICE_TITLE_SET = new Set(['JUSTICE', 'CHIEF JUSTICE', 'UNKNOWN JUSTICE']);

function _nonJusticeSpeakers(transcriptPath) {
    if (!exists(transcriptPath)) return [];
    let data;
    try { data = readJson(transcriptPath); } catch { return []; }
    const speakers = data?.media?.speakers || [];
    return speakers
        .filter(sp => !_JUSTICE_TITLE_SET.has(sp.title || ''))
        .map(sp => [sp.name || '', sp.title || '']);
}

const _FEMALE_TITLE_TOKENS = new Set(['MS', 'MRS', 'MISS']);

function _titleIsFemale(title) {
    const tokens = (title || '').toUpperCase().match(/[A-Z]+/g) || [];
    return tokens.some(t => _FEMALE_TITLE_TOKENS.has(t));
}

const _SPEAKER_MATCH_SUFFIX_RE = /^(.+?)(?:,\s*|\s+)(JR\.?|SR\.?|II|III|IV)\.?\s*$/i;

function _speakerNameMatchKeys(name) {
    const base = (name || '').split(/\s+/).filter(Boolean).join(' ');
    if (!base) return new Set();
    const keys = new Set([base]);
    const m = _SPEAKER_MATCH_SUFFIX_RE.exec(base);
    if (m) {
        const stripped = m[1].trim().replace(/,$/, '');
        if (stripped) keys.add(stripped);
    }
    return keys;
}

function _levenshtein(a, b) {
    if (a === b) return 0;
    if (a.length > b.length) [a, b] = [b, a];
    const row = new Array(a.length + 1);
    for (let i = 0; i <= a.length; i++) row[i] = i;
    for (let j = 1; j <= b.length; j++) {
        let prev = j;
        for (let i = 1; i <= a.length; i++) {
            const cur = a[i - 1] === b[j - 1]
                ? row[i - 1]
                : 1 + Math.min(row[i - 1], row[i], prev);
            row[i - 1] = prev;
            prev = cur;
        }
        row[a.length] = prev;
    }
    return row[a.length];
}

function _nameLastToken(name) {
    const tokens = (name || '').toUpperCase().match(/[A-Z]+/g) || [];
    while (tokens.length && _SUFFIX_WORDS.has(tokens[tokens.length - 1])) tokens.pop();
    return tokens.length ? tokens[tokens.length - 1] : '';
}

function _isLikelyJusticeName(name, title) {
    if (title) return false;
    const tokens = (name || '').toUpperCase().match(/[A-Z]+/g) || [];
    if (tokens.length !== 1) return false;
    const word = tokens[0];
    for (const last of _JUSTICE_LAST_NAMES) {
        if (_levenshtein(word, last) <= 2) return true;
    }
    return false;
}

function _fuzzyOyezCandidates(name, oyezSpk) {
    const nameTokens = (name || '').toUpperCase().match(/[A-Z]+/g) || [];
    while (nameTokens.length && _SUFFIX_WORDS.has(nameTokens[nameTokens.length - 1])) nameTokens.pop();
    if (nameTokens.length !== 1 && nameTokens.length !== 2) return [];
    const query = nameTokens.join('');
    const out = [];
    for (const [n, t] of oyezSpk) {
        if (_levenshtein(query, _nameLastToken(n)) <= 2) out.push(t);
    }
    return out;
}

function _speakersSubset(usscSpk, oyezSpk) {
    const oyezByName = new Map();
    for (const [name, title] of oyezSpk) {
        for (const key of _speakerNameMatchKeys(name)) {
            if (!oyezByName.has(key)) oyezByName.set(key, []);
            oyezByName.get(key).push(title);
        }
    }
    for (const [name, title] of usscSpk) {
        if (_isLikelyJusticeName(name, title)) continue;
        let candidates = [];
        for (const key of _speakerNameMatchKeys(name)) {
            if (oyezByName.has(key)) candidates.push(...oyezByName.get(key));
        }
        if (!candidates.length) candidates = _fuzzyOyezCandidates(name, oyezSpk);
        if (!candidates.length) return false;
        const usscFemale = _titleIsFemale(title);
        if (!candidates.some(t => _titleIsFemale(t) === usscFemale)) return false;
    }
    return true;
}

function _pdfToText(pdfPath) {
    return execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
}

function _parseRawText(rawText, outputPath, audioHref = '', _term = '', existingSpeakers = null) {
    const appearances = parseAppearances(rawText);
    const dm = path.basename(outputPath || '').match(/^(\d{4}-\d{2}-\d{2})/);
    const argDate = dm ? dm[1] : '';

    const tokens = [];
    for (const line of rawText.split('\n')) {
        const m = CONTENT_LINE_RE.exec(line);
        if (!m) continue;
        const content = m[2].trim();
        if (!content) continue;
        if (TERMINATOR_PATTERNS.some(p => p.test(content))) break;
        if (SKIP_PATTERNS.some(p => p.test(content))) continue;
        const sm = SPEAKER_RE.exec(content);
        if (sm) tokens.push(['SPEAKER', sm[1].trim(), sm[2].trim()]);
        else tokens.push(['TEXT', content]);
    }

    let turns = [];
    let currentSpeaker = null;
    let currentParts = [];
    const flush = () => {
        if (currentSpeaker !== null) {
            const text = currentParts.join(' ').replace(/\s+/g, ' ').trim();
            if (text) turns.push({ name: currentSpeaker, text });
        }
    };
    for (const tok of tokens) {
        if (tok[0] === 'SPEAKER') {
            flush();
            currentSpeaker = tok[1];
            currentParts = tok[2] ? [tok[2]] : [];
        } else if (currentSpeaker !== null) {
            currentParts.push(tok[1]);
        }
    }
    flush();

    const rawToResolved = new Map();
    for (const turn of turns) {
        if (!rawToResolved.has(turn.name)) {
            let [name, title] = _resolveSpeaker(turn.name, appearances, argDate);
            name = name.toUpperCase().split(/\s+/).filter(Boolean).join(' ');
            rawToResolved.set(turn.name, [name, title]);
        }
    }
    for (const turn of turns) {
        turn.name = rawToResolved.get(turn.name)[0];
    }

    if (_RENAME_SPEAKER_MAP.size) {
        for (const turn of turns) {
            if (_RENAME_SPEAKER_MAP.has(turn.name)) turn.name = _RENAME_SPEAKER_MAP.get(turn.name);
        }
    }

    for (const turn of turns) turn.name = _normalizeNameSuffix(turn.name);
    for (const [raw, [full, title]] of rawToResolved) {
        rawToResolved.set(raw, [_normalizeNameSuffix(full), title]);
    }

    turns = turns.map((t, i) => ({ turn: i + 1, ...t }));

    const seenFull = new Map();   // full_name -> title (insertion ordered)
    for (const [, [fullName, title]] of rawToResolved) {
        const renamed = _RENAME_SPEAKER_MAP.get(fullName) || fullName;
        if (!seenFull.has(renamed)) seenFull.set(renamed, title);
    }
    let speakers = [...seenFull].map(([name, title]) => ({ name, title }));

    if (existingSpeakers) {
        speakers = _mergeSpeakerTitles(speakers, existingSpeakers, path.basename(outputPath));
    }

    if (turns.length === 0 && speakers.length === 0) return [];

    const envelope = _buildTranscriptEnvelope(turns, audioHref, speakers);
    ensureDir(path.dirname(outputPath));
    writeJson(outputPath, envelope);
    return turns;
}

function extractTranscriptPdf(pdfPath, outputPath, audioHref = '', term = '') {
    return _parseRawText(_pdfToText(pdfPath), outputPath, audioHref, term);
}

// ── HTML parsing helpers (DOM-based) ───────────────────────────────────────

function _resolveHref(href, baseUrl) {
    if (!href) return null;
    try { return new URL(href, baseUrl).toString(); } catch { return null; }
}

function _cellText(td) {
    return (td.text || '').split(/\s+/).filter(Boolean).join(' ');
}

function _firstTdAnchorHref(td, baseUrl, predicate = null) {
    const anchors = td.querySelectorAll('a');
    for (const a of anchors) {
        const href = a.getAttribute('href');
        if (!href) continue;
        if (predicate && !predicate(href)) continue;
        return _resolveHref(href, baseUrl);
    }
    return null;
}

// ── Listing page parsing ───────────────────────────────────────────────────

function parseListing(html, baseUrl) {
    const root = parseHtml(html);
    const cases = [];
    for (const tr of root.querySelectorAll('tr')) {
        const tds = tr.querySelectorAll('td');
        if (tds.length !== 2) continue;
        const caseText = _cellText(tds[0]);
        const dateText = _cellText(tds[1]);
        const m = CASE_RE.exec(caseText);
        const dateIsos = parseAnyDates(dateText);
        if (!m || dateIsos.length === 0) continue;
        const number = _normalizeNumber(m[1]);
        const title  = m[2].trim();
        const detailUrl = _firstTdAnchorHref(tds[0], baseUrl);
        for (const dateIso of dateIsos) {
            cases.push({ number, title, date: dateIso, detail_url: detailUrl });
        }
    }
    return cases;
}

function parseDetail(html) {
    const root = parseHtml(html);
    let mp3Url = null, pdfUrl = null;
    for (const a of root.querySelectorAll('a')) {
        const href = a.getAttribute('href');
        if (!href) continue;
        const lower = href.toLowerCase();
        if (mp3Url === null && lower.includes('mp3files') && lower.endsWith('.mp3')) {
            mp3Url = href.startsWith('http') ? href : BASE_URL + href;
        } else if (pdfUrl === null
                && lower.includes('/oral_arguments/argument_transcripts/')
                && lower.endsWith('.pdf')) {
            pdfUrl = href.startsWith('http') ? href : BASE_URL + href;
        }
    }
    return { mp3Url, pdfUrl };
}

function parseTranscriptListing(html, baseUrl) {
    const root = parseHtml(html);
    const transcripts = [];
    for (const tr of root.querySelectorAll('tr')) {
        const tds = tr.querySelectorAll('td');
        if (tds.length !== 2) continue;
        const caseText = _cellText(tds[0]);
        const dateText = _cellText(tds[1]);
        const m = _TRANSCRIPT_CASE_RE.exec(caseText);
        const dateIsos = parseAnyDates(dateText);
        const pdfUrl = _firstTdAnchorHref(tds[0], baseUrl,
            href => href.toLowerCase().endsWith('.pdf'));
        if (!m || dateIsos.length === 0 || !pdfUrl) continue;
        let number = _normalizeNumber(m[1]);
        if (/orig/i.test(pdfUrl)) {
            const yyNn = /^\d{2}-(\d+)$/.exec(number);
            if (yyNn) number = `${yyNn[1]}-Orig`;
        }
        const title = m[2].trim();
        for (const dateIso of dateIsos) {
            transcripts.push({ number, title, date: dateIso, pdf_url: pdfUrl });
        }
    }
    return transcripts;
}

function parseDocket(html, pageUrl) {
    const root = parseHtml(html);
    let questionsHref = null;
    const proceedings = [];

    // First pass: pull out the questions_href and opinion PDF link anywhere on the page.
    let opinionHref = null;
    for (const a of root.querySelectorAll('a')) {
        const text = (a.text || '').trim();
        const rawHref = a.getAttribute('href') || '';
        if (text === 'Questions Presented') {
            const href = _resolveHref(rawHref, pageUrl);
            if (href && questionsHref === null) questionsHref = href;
        }
        if (opinionHref === null && /\/opinions\/\d+pdf\//i.test(rawHref)) {
            opinionHref = _resolveHref(rawHref, pageUrl);
        }
    }

    // Walk every <tr>; collect first two cells' text + named anchors.
    for (const tr of root.querySelectorAll('tr')) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 2) continue;

        const dateCell  = _cellText(tds[0]);
        const titleCell = _cellText(tds[1]);
        const date  = parseDocketDate(dateCell);
        const title = titleCell;
        if (!date || !title) continue;

        // Build a map of link_text -> resolved_href across this row.
        const rowLinks = new Map();
        for (const a of tr.querySelectorAll('a')) {
            const text = (a.text || '').trim();
            if (!text) continue;
            const href = _resolveHref(a.getAttribute('href'), pageUrl);
            if (!href) continue;
            rowLinks.set(text, href);
        }

        if (rowLinks.has('Main Document')) {
            proceedings.push({ date, title, href: rowLinks.get('Main Document') });
        }
        if (rowLinks.has('Petition')) {
            proceedings.push({
                date, title,
                href: rowLinks.get('Petition'),
                type: 'petitioner',
            });
        }
    }
    return { questionsHref, opinionHref, proceedings };
}

// ── Network entry points ───────────────────────────────────────────────────

async function fetchCasesFromUrl(url, yearStr = '') {
    console.log('Checking arguments page for missing cases...');
    vprint(`  ${url}`);
    let html;
    try {
        html = await fetchHtml(url);
    } catch (exc) {
        if (!yearStr) throw exc;
        console.log(`Live page unavailable (${exc.message || exc}); trying Wayback Machine ...`);
        html = await _fetchHtmlViaWayback(url, yearStr);
    }
    return parseListing(html, url);
}

async function fetchArgumentUrls(detailUrl) {
    if (!detailUrl) return {};
    let html;
    try {
        html = await fetchHtml(detailUrl);
    } catch (exc) {
        console.log(`Warning: could not fetch detail page ${detailUrl}: ${exc.message || exc}`);
        return {};
    }
    const { mp3Url, pdfUrl } = parseDetail(html);
    const out = {};
    if (mp3Url) out.audio_href = mp3Url;
    if (pdfUrl) out.transcript_href = pdfUrl;
    return out;
}

function _transcriptListingUrl(yearStr) {
    const year = parseInt(yearStr, 10);
    if (year < 2000) return `${BASE_URL}/oral_arguments/archived_transcripts/${yearStr}`;
    return `${BASE_URL}/oral_arguments/argument_transcript/${yearStr}`;
}

async function fetchTranscriptsFromUrl(url, yearStr = '') {
    console.log('Checking transcripts page for missing cases...');
    vprint(`  ${url}`);
    let html;
    try {
        html = await fetchHtml(url);
    } catch (exc) {
        if (!yearStr) {
            console.log(`Warning: could not fetch transcript listing: ${exc.message || exc}`);
            return [];
        }
        console.log(`Live page unavailable (${exc.message || exc}); trying Wayback Machine ...`);
        try {
            html = await _fetchHtmlViaWayback(url, yearStr);
        } catch (wbExc) {
            console.log(`Warning: Wayback fallback also failed: ${wbExc.message || wbExc}`);
            return [];
        }
    }
    return parseTranscriptListing(html, url);
}

async function fetchDocketInfo(number, termYear = '') {
    const primary = number.split(',')[0].trim();
    const internal = _docketNumber(primary, termYear);
    const yearInt = /^\d+$/.test(termYear) ? parseInt(termYear, 10) : 0;
    const isOrig  = ORIG_RE.test(primary);
    const url = yearInt >= 2017 && !isOrig
        ? `${BASE_URL}/docket/docketfiles/html/public/${internal}.html`
        : yearInt >= 2017
        ? `${BASE_URL}/search.aspx?filename=/docket/docketfiles/html/public/${internal}.html`
        : `${BASE_URL}/search.aspx?filename=/docketfiles/${internal}.htm`;
    vprint(`  ${url}`);
    let html;
    try {
        html = await fetchHtml(url);
    } catch (exc) {
        console.log(`Warning: could not fetch docket for ${number}: ${exc.message || exc}`);
        return {};
    }
    const { questionsHref, opinionHref, proceedings } = parseDocket(html, url);
    return { questions_href: questionsHref, decision_ussc: opinionHref, proceedings };
}

// ── cases.json updates ─────────────────────────────────────────────────────

function _loadTermNumbers(casesPath) {
    if (!exists(casesPath)) return new Set();
    let data;
    try { data = readJson(casesPath); } catch { return new Set(); }
    const numbers = new Set();
    for (const c of data) {
        for (const part of (c.number || '').split(',')) {
            const n = part.trim();
            if (n) numbers.add(n);
        }
    }
    return numbers;
}

function _loadLaterTermNumbers(termsRoot, yearStr, lookahead = 2) {
    const result = new Map();
    const year = parseInt(yearStr, 10);
    for (let offset = 1; offset <= lookahead; offset++) {
        const laterTerm = `${year + offset}-10`;
        const laterPath = path.join(termsRoot, laterTerm, 'cases.json');
        for (const num of _loadTermNumbers(laterPath)) {
            if (!result.has(num)) result.set(num, laterTerm);
        }
    }
    return result;
}

const _laterTermDataCache = new Map();   // term -> {data, path}

function _checkPreviouslyFiled(_currentTerm, caseNumber, laterTerm, termsRoot) {
    const laterPath = path.join(termsRoot, laterTerm, 'cases.json');
    if (!_laterTermDataCache.has(laterTerm)) {
        if (!exists(laterPath)) return;
        try {
            _laterTermDataCache.set(laterTerm, { data: readJson(laterPath), path: laterPath });
        } catch { return; }
    }
    const { data } = _laterTermDataCache.get(laterTerm);
    for (const c of data) {
        const nums = (c.number || '').split(',').map(s => s.trim());
        if (!nums.includes(caseNumber)) continue;
        const pf = c.previouslyFiled;
        if (!pf) {
            console.log(`  WARNING: ${caseNumber} appears in ${laterTerm} `
                      + `but previouslyFiled is not set on that entry`);
            return;
        }
        if (!String(pf).includes('/')) {
            const fixed = `${pf}/${caseNumber}`;
            c.previouslyFiled = fixed;
            console.log(`  Fixed previouslyFiled for ${caseNumber} in ${laterTerm}: `
                      + `${JSON.stringify(pf)} -> ${JSON.stringify(fixed)}`);
            writeJson(laterPath, data);
        }
        return;
    }
}

async function updateCasesJson(casesPath, newCases, year, laterTermNumbers = null) {
    let existing;
    if (exists(casesPath)) {
        existing = readJson(casesPath);
    } else {
        ensureDir(path.dirname(casesPath));
        existing = [];
    }

    const scrapedByNum = new Map(newCases.map(c => [c.number, c]));
    const groupedNew = new Map();
    for (const c of newCases) {
        if (!groupedNew.has(c.number)) groupedNew.set(c.number, []);
        groupedNew.get(c.number).push(c);
    }
    const existingNumbers = new Set();
    for (const c of existing) {
        for (const part of (c.number || '').split(',')) existingNumbers.add(part.trim());
    }

    let modified = false;
    const added = [];
    const termsRoot = path.dirname(path.dirname(casesPath));

    for (const [number, rowsRaw] of groupedNew) {
        const rows = [...rowsRaw].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        const seenDates = new Set();
        const uniqueRows = [];
        for (const r of rows) {
            const d = r.date;
            if (d && seenDates.has(d)) continue;
            if (d) seenDates.add(d);
            uniqueRows.push(r);
        }
        if (uniqueRows.length === 0) continue;

        const sample = uniqueRows[0];
        if (existingNumbers.has(number)) continue;
        if (laterTermNumbers && laterTermNumbers.has(number)) {
            const found = laterTermNumbers.get(number);
            console.log(`Skipping ${number} (already in ${found})`);
            _checkPreviouslyFiled(year, number, found, termsRoot);
            continue;
        }
        if (!ADD_CASES) {
            console.log(`  WARNING: ${number} (${sample.date || '?'}) is a new case `
                      + `not in cases.json; pass --cases to add it`);
            continue;
        }

        const dateLabel = uniqueRows.map(r => r.date || '?').join(',');
        process.stdout.write(`Adding ${number} (${dateLabel}) ... `);
        const argUrls = await fetchArgumentUrls(sample.detail_url);
        await sleep(300);

        let events = uniqueRows.map(r => {
            const title = _usscAudioTitle('argument', r.date);
            return { source: 'ussc', type: 'argument', date: r.date, title, ...argUrls };
        });
        events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

        let status;
        if (Object.keys(argUrls).length) {
            status = ('transcript_href' in argUrls) ? 'audio+transcript' : 'audio only';
        } else {
            status = 'no media URLs found';
        }
        console.log(status);

        existing.push({ title: sample.title, number, events });
        existingNumbers.add(number);
        added.push(number);
    }

    // Backfill missing audio/transcript hrefs.
    for (const c of existing) {
        const scraped = scrapedByNum.get(c.number);
        if (!scraped || !scraped.detail_url) {
            // Consolidated case fallback
            if ((c.number || '').includes(',')) {
                for (const arg of (c.events || [])) {
                    if ((arg.source || 'ussc') !== 'ussc') continue;
                    if (arg.audio_href || !arg.transcript_href) continue;
                    const cn = _ussCcaseNumFromHref(arg.transcript_href);
                    const compScraped = cn ? scrapedByNum.get(cn) : null;
                    if (!compScraped || !compScraped.detail_url) continue;
                    process.stdout.write(`Backfilling audio for ${c.number} (${cn}, ${arg.date || '?'}) ... `);
                    const argUrls = await fetchArgumentUrls(compScraped.detail_url);
                    await sleep(300);
                    if (argUrls.audio_href) {
                        const newArg = {};
                        for (const [k, v] of Object.entries(arg)) {
                            newArg[k] = v;
                            if (k === 'title') newArg.audio_href = argUrls.audio_href;
                        }
                        if (!('audio_href' in newArg)) newArg.audio_href = argUrls.audio_href;
                        for (const k of Object.keys(arg)) delete arg[k];
                        Object.assign(arg, newArg);
                        modified = true;
                        console.log('audio_href set');
                    } else {
                        console.log('no audio found');
                    }
                }
            }
            continue;
        }
        for (const arg of (c.events || [])) {
            if ((arg.source || 'ussc') !== 'ussc') continue;
            if (arg.transcript_href) continue;
            process.stdout.write(`Backfilling URLs for ${c.number} (${arg.date || '?'}) ... `);
            const argUrls = await fetchArgumentUrls(scraped.detail_url);
            await sleep(300);
            if (Object.keys(argUrls).length) {
                const newArg = {};
                for (const [k, v] of Object.entries(arg)) {
                    newArg[k] = v;
                    if (k === 'title') {
                        for (const [uk, uv] of Object.entries(argUrls)) {
                            if (!(uk in newArg)) newArg[uk] = uv;
                        }
                    }
                }
                for (const [uk, uv] of Object.entries(argUrls)) {
                    if (!(uk in newArg)) newArg[uk] = uv;
                }
                for (const k of Object.keys(arg)) delete arg[k];
                Object.assign(arg, newArg);
                modified = true;
                console.log(('transcript_href' in argUrls) ? 'audio+transcript' : 'audio only');
            } else {
                console.log('no media URLs found');
            }
        }
    }

    if (added.length || modified) {
        writeJson(casesPath, existing);
        if (added.length) {
            reportChange(`\nAdded ${added.length} case(s) to ${casesPath}.`);
            if (parseInt(year, 10) >= 2001) {
                console.log('Fetching docket info for newly added case(s) ...');
                await updateDocketInfo(casesPath, year, new Set(added));
            }
        }
    } else {
        vprint(`No new cases to add to ${casesPath}`);
    }
}

// ── Step 4: docket info ────────────────────────────────────────────────────

async function updateDocketInfo(casesPath, termYear = '', caseNumbers = null) {
    const existing = readJson(casesPath);
    let casesModified = false;

    for (const c of existing) {
        const number = c.number;
        if (caseNumbers && !caseNumbers.has(number)) continue;
        const filesPath = path.join(path.dirname(casesPath), 'cases', _caseFolder(number), 'files.json');

        process.stdout.write(`Fetching docket for ${number} ... `);
        const subNumbers = number.split(',').map(n => n.trim()).filter(Boolean);
        const infos = [];
        for (const sub of subNumbers) {
            const subInfo = await fetchDocketInfo(sub, termYear);
            await sleep(300);
            if (subInfo) infos.push(subInfo);
        }
        // Merge results: first questions_href wins; proceedings are combined.
        const info = {
            questions_href: infos.map(i => i.questions_href).find(Boolean) || '',
            proceedings: infos.flatMap(i => i.proceedings || []),
        };

        if (!info.questions_href && !info.proceedings.length) {
            console.log('skipped');
            continue;
        }
        const changed = [];

        if (info.questions_href && !c.questions_href) {
            const reordered = reorderCase({ ...c, questions_href: info.questions_href });
            for (const k of Object.keys(c)) delete c[k];
            Object.assign(c, reordered);
            casesModified = true;
            changed.push('questions_href');
        }

        const proceedings = info.proceedings || [];
        if (proceedings.length) {
            const caseDir = path.join(path.dirname(casesPath), 'cases', _caseFolder(number));
            const fp      = path.join(caseDir, 'files.json');
            ensureDir(caseDir);

            let files = exists(fp) ? readJson(fp) : [];
            const existingHrefs = new Set(files.filter(f => f.href).map(f => f.href));
            const audioTranscriptHrefs = new Set();
            for (const a of (c.events || [])) {
                if (a.transcript_href) audioTranscriptHrefs.add(a.transcript_href);
            }
            let nextFileId = files.reduce((m, f) => (typeof f.file === 'number' && f.file > m ? f.file : m), 0) + 1;
            let added = 0;
            for (const p of proceedings) {
                if (audioTranscriptHrefs.has(p.href)) continue;
                if (existingHrefs.has(p.href)) continue;
                const entry = { file: nextFileId, title: p.title, date: p.date, href: p.href };
                if (p.type) entry.type = p.type;
                files.push(entry);
                existingHrefs.add(p.href);
                nextFileId++;
                added++;
            }
            if (added) {
                writeJson(fp, files);
                changed.push(`${added} filings -> files.json`);
            }
        }

        console.log(changed.length ? changed.join(', ') : 'nothing new');
    }

    if (casesModified) {
        writeJson(casesPath, existing);
        reportChange('Updated cases.json with questions_href entries.');
    }
}

// ── Step 3: generate missing transcripts ───────────────────────────────────

async function generateMissingTranscripts(casesPath, caseFilter = null, force = false) {
    const existing = readJson(casesPath);
    const term = path.basename(path.dirname(casesPath));
    let modified = false;

    // Collision pre-pass.
    for (const c of existing) {
        if (!('number' in c)) continue;
        if (caseFilter && !c.number.split(',').map(n => n.trim()).includes(caseFilter)) continue;
        const folder = _caseFolder(c.number);
        const caseNorms = c.number.split(',').map(n => _normalizeNumber(n.trim()));
        const byDate = new Map();
        for (const arg of (c.events || [])) {
            if ((arg.source || 'ussc') !== 'ussc') continue;
            if (arg.redundant) continue;
            const t = arg.type;
            if (!(t === undefined || t === null || t === 'argument' || t === 'reargument')) continue;
            if (!arg.transcript_href || !arg.date) continue;
            if (!byDate.has(arg.date)) byDate.set(arg.date, []);
            byDate.get(arg.date).push(arg);
        }
        for (const [dateKey, args] of byDate) {
            if (args.length < 2) continue;
            const compNums = args.map(a => _ussCcaseNumFromHref(a.transcript_href || ''));
            const allDistinct = compNums.every(cn => cn && caseNorms.includes(cn))
                              && new Set(compNums).size === compNums.length;
            const deleted = new Set();
            if (allDistinct) {
                for (let i = 0; i < args.length; i++) {
                    const arg = args[i], cn = compNums[i];
                    const newTh = `${cn}/${dateKey}.json`;
                    if (arg.text_href !== newTh) {
                        const oldTh = arg.text_href || '';
                        if (oldTh) {
                            const oldFile = path.join(path.dirname(casesPath), 'cases', oldTh);
                            if (!deleted.has(oldFile) && exists(oldFile)) {
                                unlinkSafe(oldFile);
                                deleted.add(oldFile);
                            }
                        }
                        arg.text_href = newTh;
                        modified = true;
                    }
                }
            } else {
                for (let i = 0; i < args.length; i++) {
                    const arg = args[i];
                    const newTh = `${folder}/${dateKey}-${i + 1}.json`;
                    if (arg.text_href !== newTh) {
                        const oldTh = arg.text_href || '';
                        if (oldTh) {
                            const oldFile = path.join(path.dirname(casesPath), 'cases', oldTh);
                            if (!deleted.has(oldFile) && exists(oldFile)
                                    && path.basename(oldFile) === `${dateKey}.json`) {
                                unlinkSafe(oldFile);
                                deleted.add(oldFile);
                            }
                        }
                        arg.text_href = newTh;
                        modified = true;
                    }
                }
            }
        }

        if (!('number' in c)) continue;
        if (caseFilter && !c.number.split(',').map(n => n.trim()).includes(caseFilter)) continue;

        for (const arg of (c.events || [])) {
            if ((arg.source || 'ussc') !== 'ussc') continue;
            if (arg.redundant) continue;
            const pdfUrl = arg.transcript_href;
            const date   = arg.date;
            if (!pdfUrl || !date) continue;

            const existingTh = arg.text_href || '';
            let componentNum = _ussCcaseNumFromHref(pdfUrl, existingTh);
            const _caseNorms = c.number.split(',').map(n => _normalizeNumber(n.trim()));
            if (!componentNum || !_caseNorms.includes(componentNum)) {
                componentNum = _caseFolder(c.number);
            }

            if (pdfUrl.includes('/pdfs/transcripts/')) {
                if (!exists(_cachedTextPath(componentNum, date, term))) continue;
            }

            const caseDir = path.join(path.dirname(casesPath), 'cases', componentNum);
            let transcriptOut = path.join(caseDir, `${date}.json`);
            const thFile = existingTh ? path.join(path.dirname(casesPath), 'cases', existingTh) : null;
            if (thFile) transcriptOut = thFile;

            if (existingTh && !caseFilter && !force) {
                if (exists(transcriptOut) || (thFile && exists(thFile))) continue;
            }

            process.stdout.write(`Extracting ${c.number} (${date})`);

            let existingSpeakers = null;
            if (exists(transcriptOut)) {
                try {
                    const ex = readJson(transcriptOut);
                    existingSpeakers = ex?.media?.speakers || null;
                } catch {}
            }

            const cachedTxt = _cachedTextPath(componentNum, date, term);
            const audioHref = arg.audio_href || '';
            let tmpPath = null;
            let cacheTag = '';
            try {
                let turns;
                if (exists(cachedTxt)) {
                    cacheTag = ' (cached)';
                    const rawText = fs.readFileSync(cachedTxt, 'utf8');
                    turns = _parseRawText(rawText, transcriptOut, audioHref, term, existingSpeakers);
                } else {
                    tmpPath = path.join(os.tmpdir(), `import_ussc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
                    await downloadFile(pdfUrl, tmpPath);
                    const rawText = _pdfToText(tmpPath);
                    ensureDir(path.dirname(cachedTxt));
                    fs.writeFileSync(cachedTxt, rawText, 'utf8');
                    turns = _parseRawText(rawText, transcriptOut, audioHref, term, existingSpeakers);
                    await sleep(300);
                }

                console.log(`${cacheTag}: ${turns.length} turns -> ${relRepo(transcriptOut)}`);

                if (!turns.length) {
                    if (exists(transcriptOut)) {
                        unlinkSafe(transcriptOut);
                        console.log(`Deleted empty transcript: ${relRepo(transcriptOut)}`);
                    }
                    if (arg.text_href) { delete arg.text_href; modified = true; }
                    continue;
                }

                const newTextHref = `${componentNum}/${date}.json`;
                if (!arg.text_href) {
                    arg.text_href = newTextHref;
                    modified = true;
                }
            } catch (exc) {
                if (exc?.stderr) console.log(`ERROR (pdftotext): ${String(exc.stderr).trim()}`);
                else console.log(`ERROR: ${exc.message || exc}`);
            } finally {
                if (tmpPath) unlinkSafe(tmpPath);
            }
        }
    }

    // Supplementary pass: backfill/strip "in No. N" for consolidated cases.
    for (const c of existing) {
        if (!('number' in c)) continue;
        if (caseFilter && !c.number.split(',').map(n => n.trim()).includes(caseFilter)) continue;
        if (!(c.number || '').includes(',')) continue;
        const comps = c.number.split(',').map(n => _normalizeNumber(n.trim()));
        const dateCounts = new Map();
        for (const a of (c.events || [])) {
            if ((a.source || 'ussc') !== 'ussc') continue;
            const t = a.type;
            if (!(t === undefined || t === null || t === 'argument' || t === 'reargument')) continue;
            const d = a.date || '';
            dateCounts.set(d, (dateCounts.get(d) || 0) + 1);
        }
        const useCaseNums = [...dateCounts.values()].some(v => v > 1);
        for (const a of (c.events || [])) {
            if ((a.source || 'ussc') !== 'ussc') continue;
            const t = a.type;
            if (!(t === undefined || t === null || t === 'argument' || t === 'reargument')) continue;
            const title = a.title || '';
            let cn = _ussCcaseNumFromHref(a.transcript_href || '');
            if (!(cn && comps.includes(cn))) cn = _ussCcaseNumFromHref('', a.text_href || '');
            if (!(cn && comps.includes(cn))) continue;
            const typeV = a.type || 'argument';
            const dateV = a.date || '';
            const autoWith    = _usscAudioTitle(typeV, dateV, cn);
            const autoWithout = _usscAudioTitle(typeV, dateV, '');
            const isAuto = (title === autoWith || title === autoWithout
                || comps.some(other => other !== cn && title === _usscAudioTitle(typeV, dateV, other)));
            if (!isAuto) continue;
            if (useCaseNums && a.title !== autoWith) {
                a.title = autoWith; modified = true;
            } else if (!useCaseNums && a.title !== autoWithout) {
                a.title = autoWithout; modified = true;
            }
        }
    }

    if (modified) {
        writeJson(casesPath, existing);
        reportChange('Updated cases.json with new text_href entries.');
    }
}

async function _ensureEventTranscript(casesPath, c, arg, term) {
    if (!arg.transcript_href || !arg.date) return false;
    const existingTh = arg.text_href || '';
    if (existingTh) {
        const thFile = path.join(path.dirname(casesPath), 'cases', existingTh);
        if (exists(thFile)) return true;
    }
    const pdfUrl = arg.transcript_href;
    const date   = arg.date;
    const caseNorms = c.number.split(',').map(n => _normalizeNumber(n.trim()));
    let componentNum = _ussCcaseNumFromHref(pdfUrl, existingTh);
    if (!componentNum || !caseNorms.includes(componentNum)) componentNum = _caseFolder(c.number);
    if (pdfUrl.includes('/pdfs/transcripts/')) {
        if (!exists(_cachedTextPath(componentNum, date, term))) return false;
    }
    const transcriptOut = existingTh
        ? path.join(path.dirname(casesPath), 'cases', existingTh)
        : path.join(path.dirname(casesPath), 'cases', componentNum, `${date}.json`);
    process.stdout.write(`  Extracting ${c.number} (${date})`);
    let existingSpeakers = null;
    if (exists(transcriptOut)) {
        try {
            const ex = readJson(transcriptOut);
            existingSpeakers = ex?.media?.speakers || null;
        } catch {}
    }
    const cachedTxt = _cachedTextPath(componentNum, date, term);
    const audioHref = arg.audio_href || '';
    let tmpPath = null;
    try {
        let turns;
        if (exists(cachedTxt)) {
            const rawText = fs.readFileSync(cachedTxt, 'utf8');
            turns = _parseRawText(rawText, transcriptOut, audioHref, term, existingSpeakers);
        } else {
            tmpPath = path.join(os.tmpdir(), `import_ussc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
            await downloadFile(pdfUrl, tmpPath);
            const rawText = _pdfToText(tmpPath);
            ensureDir(path.dirname(cachedTxt));
            fs.writeFileSync(cachedTxt, rawText, 'utf8');
            turns = _parseRawText(rawText, transcriptOut, audioHref, term, existingSpeakers);
            await sleep(300);
        }
        if (!turns.length) {
            if (exists(transcriptOut)) unlinkSafe(transcriptOut);
            if (arg.text_href) delete arg.text_href;
            console.log(' (empty — skipped)');
            return false;
        }
        console.log(`: ${turns.length} turns -> ${relRepo(transcriptOut)}`);
        if (!arg.text_href) arg.text_href = `${componentNum}/${date}.json`;
        return true;
    } catch (exc) {
        if (exc?.stderr) console.log(` ERROR (pdftotext): ${String(exc.stderr).trim()}`);
        else console.log(` ERROR: ${exc.message || exc}`);
        return false;
    } finally {
        if (tmpPath) unlinkSafe(tmpPath);
    }
}

// ── Step 3b: migrate transcripts ───────────────────────────────────────────

function migrateTranscripts(casesPath) {
    const existing = readJson(casesPath);
    const audioMap = new Map();
    for (const c of existing) {
        if (!('number' in c)) continue;
        for (const arg of (c.events || [])) {
            audioMap.set(`${c.number}|${arg.date || ''}`, arg.audio_href || '');
        }
    }
    let total = 0;
    for (const c of existing) {
        if (!('number' in c)) continue;
        const number = c.number;
        const caseDir = path.join(path.dirname(casesPath), 'cases', _caseFolder(number));
        for (const arg of (c.events || [])) {
            const date = arg.date || '';
            const transcriptPath = path.join(caseDir, `${date}.json`);
            if (!exists(transcriptPath)) continue;
            let data;
            try { data = readJson(transcriptPath); } catch { continue; }
            if (Array.isArray(data)) {
                const audioHref = audioMap.get(`${number}|${date}`) || '';
                const envelope = _buildTranscriptEnvelope(data, audioHref);
                writeJson(transcriptPath, envelope);
                console.log(`Migrated ${relRepo(transcriptPath)}`);
                total++;
            }
        }
    }
    if (!total) vprint('All transcripts already in new format.');
    else reportChange(`  Migrated ${total} transcript(s).`);
}

// ── Step 5: clean files.json ───────────────────────────────────────────────

const _FILED_RE = /\s+filed\..*$/is;

// Trailing boilerplate attachment-type labels appended by the SCOTUS docket
// system, with or without a preceding period:
//   ". Main Document Proof of Service Certificate of Word Count"
//   " Main Document Proof of Service"
//   " Certificate of Word Count Proof of Service"
const _ATTACH_TERM = '(?:Main\\s+Document|Proof\\s+of\\s+Service|Certificate\\s+of\\s+(?:Word\\s+Count|Compliance)|Petition\\s+Appendix|Exhibits?|Other|Lower\\s+Court\\s+Orders/Opinions)';
const _STATUS_MARK  = '(?:\\([^)]+\\)|VIDED\\.?)';
const _ATTACH_SUFFIX_RE = new RegExp(`\\.?(?:\\s+${_STATUS_MARK})*\\s+${_ATTACH_TERM}(?:\\s+${_ATTACH_TERM})*\\s*$`, 'i');

const _TYPE_PREFIXES = [
    ['amicus',     ['Brief amicus ', 'Brief amici ']],
    ['respondent', ['Brief of respondent', 'Reply of respondent']],
    ['petitioner', ['Brief of petitioner', 'Reply of petitioner']],
];

function _cleanTitle(title) {
    let s = title.replace(_FILED_RE, '').trim();
    s = s.replace(_ATTACH_SUFFIX_RE, '').trim();
    return s;
}

function _inferType(title) {
    const lower = title.toLowerCase();
    for (const [typeVal, prefixes] of _TYPE_PREFIXES) {
        if (prefixes.some(p => lower.startsWith(p.toLowerCase()))) return typeVal;
    }
    return null;
}

function _walkFilesJson(termDir) {
    const out = [];
    const casesDir = path.join(termDir, 'cases');
    if (!exists(casesDir)) return out;
    for (const entry of fs.readdirSync(casesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const fp = path.join(casesDir, entry.name, 'files.json');
        if (exists(fp)) out.push(fp);
    }
    return out.sort();
}

function cleanFilesJson(casesPath) {
    const termDir = path.dirname(casesPath);
    let totalChanged = 0;
    for (const fp of _walkFilesJson(termDir)) {
        const files = readJson(fp);
        let changed = false;
        for (const entry of files) {
            const title = entry.title || '';
            let clean = _cleanTitle(title);
            if (entry.type !== 'opinion') clean = clean.replace(/\.+$/, '');
            if (clean !== title) {
                entry.title = clean;
                changed = true;
            }
            if (!entry.type) {
                const inferred = _inferType(entry.title || '');
                if (inferred) { entry.type = inferred; changed = true; }
            }
        }
        if (changed) {
            writeJson(fp, files);
            totalChanged++;
            reportChange(`  Cleaned ${relRepo(fp)}`);
        }
    }
    if (!totalChanged) vprint('Nothing to clean.');
}

// ── Step 6: extract questions presented ────────────────────────────────────

const _QP_START_RE = /(?:QUESTIONS?\s+PRESENTED\s*:?|[Tt]he\s+questions?\s+presented\s+(?:is|are)\s*:?)/;
const _QP_END_RE   = /\n\s*(?:CERT\.\s+GRANTED|ORDER\s+OF\s+\w)[\s\S]*$/i;

function _extractQuestionsFromText(text) {
    const m = _QP_START_RE.exec(text);
    if (!m) return null;
    let body = text.slice(m.index + m[0].length);
    body = body.replace(_QP_END_RE, '');
    body = body.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    return body || null;
}

async function extractQuestions(casesPath) {
    const existing = readJson(casesPath);
    let modified = false;
    for (const c of existing) {
        if (c.questions || !c.questions_href) continue;
        const number = c.number;
        const pdfUrl = c.questions_href;
        process.stdout.write(`Extracting questions for ${number} ... `);
        let tmpPath = null;
        try {
            tmpPath = path.join(os.tmpdir(), `import_ussc-q-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
            await downloadFile(pdfUrl, tmpPath);
            const text = execFileSync('pdftotext', ['-layout', tmpPath, '-'], { encoding: 'utf8' });
            const questions = _extractQuestionsFromText(text);
            if (questions) {
                const reordered = reorderCase({ ...c, questions });
                for (const k of Object.keys(c)) delete c[k];
                Object.assign(c, reordered);
                modified = true;
                console.log(`${questions.length} chars`);
            } else {
                console.log('not found');
            }
            await sleep(300);
        } catch (exc) {
            if (exc?.stderr) console.log(`ERROR (pdftotext): ${String(exc.stderr).trim()}`);
            else console.log(`ERROR: ${exc.message || exc}`);
        } finally {
            if (tmpPath) unlinkSafe(tmpPath);
        }
    }
    if (modified) {
        writeJson(casesPath, existing);
        reportChange('Updated cases.json with questions.');
    } else {
        vprint('Nothing to extract.');
    }
}

// ── Step 2b: import transcript PDFs ────────────────────────────────────────

function _findCaseInLaterTerms(termsRoot, currentYear, rowNorm, rowDate, lookahead = 2) {
    const year = parseInt(currentYear, 10);
    for (let offset = 1; offset <= lookahead; offset++) {
        const checkTerm = `${year + offset}-10`;
        const cp = path.join(termsRoot, checkTerm, 'cases.json');
        if (!exists(cp)) continue;
        let cases;
        try { cases = readJson(cp); } catch { continue; }
        for (const c of cases) {
            if (!('number' in c)) continue;
            const caseNorms = c.number.split(',').map(n => _normalizeNumber(n.trim()));
            if (!caseNorms.includes(rowNorm)) continue;
            const argDates = new Set();
            for (const field of ['argument', 'reargument']) {
                const v = c[field];
                if (typeof v === 'string') {
                    for (let d of v.split(',')) {
                        d = d.trim();
                        if (d) argDates.add(d);
                    }
                } else if (Array.isArray(v)) {
                    for (const d of v) argDates.add(d);
                }
            }
            if (argDates.size === 0) {
                for (const ev of (c.events || [])) {
                    const t = ev.type;
                    if ((t === undefined || t === null || t === 'argument' || t === 'reargument') && ev.date) {
                        argDates.add(ev.date);
                    }
                }
            }
            if (argDates.has(rowDate)) {
                return { term: checkTerm, case: c, allCases: cases, casesPath: cp };
            }
        }
    }
    return null;
}

let _rl = null;
function _ask(question) {
    if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => _rl.question(question, ans => resolve(ans)));
}

async function _compareSingleUsscEvent(casesPath, _allCases, c, arg, _term) {
    const usscTh = arg.text_href || '';
    const date   = arg.date || '';
    if (!usscTh || !date) return false;
    // For consolidated cases (e.g. "13-1074,13-1075") there may be multiple
    // Oyez events on the same date — one per docket.  Collect all of them so
    // we compare the USSC transcript against the right counterpart.
    const oyezEvs = (c.events || []).filter(ev =>
        ev.source === 'oyez' && ev.date === date && ev.text_href);
    if (!oyezEvs.length) return false;
    // Prefer the Oyez event whose title mentions the same docket number as
    // this USSC event, if that pattern is identifiable.
    const docketMatch = (arg.title || '').match(/No\.\s*([\d-]+)/);
    const docketNum   = docketMatch ? docketMatch[1] : null;
    let oyezEv = docketNum
        ? (oyezEvs.find(ev => (ev.title || '').includes(docketNum)) || oyezEvs[0])
        : oyezEvs[0];
    const usscPath = path.join(path.dirname(casesPath), 'cases', usscTh);
    const oyezPath = path.join(path.dirname(casesPath), 'cases', oyezEv.text_href);
    const usscSpk  = _nonJusticeSpeakers(usscPath);
    const oyezSpk  = _nonJusticeSpeakers(oyezPath);
    if (!usscSpk.length && !oyezSpk.length) return false;
    if (_speakersSubset(usscSpk, oyezSpk)) {
        if (exists(usscPath)) unlinkSafe(usscPath);
        delete arg.text_href;
        arg.redundant = true;
        console.log(`${c.number} (${date}): ussc transcript deleted (redundant with oyez)`);
        return true;
    }
    console.log(`\n${c.number} (${date}): ussc and oyez non-justice speakers differ:`);
    console.log('  oyez:');
    for (const [name, title] of [...oyezSpk].sort()) {
        console.log(title ? `    [${title}] ${name}` : `    ${name}`);
    }
    console.log('  ussc:');
    for (const [name, title] of [...usscSpk].sort()) {
        const usscKeys = _speakerNameMatchKeys(name);
        let candidates = [];
        for (const [n, t] of oyezSpk) {
            const k = _speakerNameMatchKeys(n);
            for (const x of k) if (usscKeys.has(x)) { candidates.push(t); break; }
        }
        if (!candidates.length) candidates = _fuzzyOyezCandidates(name, oyezSpk);
        const matched = candidates.some(t => _titleIsFemale(t) === _titleIsFemale(title));
        const suffix = matched ? ' (matched)' : '';
        console.log(title ? `    [${title}] ${name}${suffix}` : `    ${name}${suffix}`);
    }
    if (!PROMPT) {
        console.log('  Retaining ussc transcript (pass --prompt to decide interactively).');
        return false;
    }
    const ans = (await _ask('Retain ussc transcript? [Y/n] ')).trim().toLowerCase();
    if (ans === 'n' || ans === 'no') {
        if (exists(usscPath)) unlinkSafe(usscPath);
        delete arg.text_href;
        arg.redundant = true;
        console.log('  ussc transcript deleted.');
        return true;
    }
    return false;
}

async function importTranscriptPdfs(casesPath, yearStr, laterTermNumbers = null) {
    const url = _transcriptListingUrl(yearStr);
    const transcripts = await fetchTranscriptsFromUrl(url, yearStr);
    if (!transcripts.length) {
        console.log('No transcripts found on listing page.');
        return;
    }
    console.log(`Found ${transcripts.length} transcript(s).`);

    const byNumber = new Map();
    for (const t of transcripts) {
        if (!byNumber.has(t.number)) byNumber.set(t.number, []);
        byNumber.get(t.number).push(t);
    }

    if (!exists(casesPath)) {
        ensureDir(path.dirname(casesPath));
        writeText(casesPath, '[]\n');
    }
    let existing = readJson(casesPath);
    let casesModified = false;
    const currentTerm = path.basename(path.dirname(casesPath));
    /** @type {Array<{cp:string, cl:any[], c:any, a:any, t:string}>} */
    const newlyMatched = [];
    /** @type {Map<string,{lt:string, cl:any[]}>} */
    const laterModified = new Map();

    const matchedRows = new Set();   // `${number}|${date}`

    for (const c of existing) {
        if (!('number' in c)) continue;
        const caseNorms = c.number.split(',').map(n => _normalizeNumber(n));
        const seenRowKeys = new Set();
        const rows = [];
        for (const cn of caseNorms) {
            for (const r of (byNumber.get(cn) || [])) {
                const k = `${r.number}|${r.date}`;
                if (!seenRowKeys.has(k)) { seenRowKeys.add(k); rows.push(r); }
            }
        }
        if (!rows.length) continue;
        for (const row of rows) {
            const key = `${row.number}|${row.date}`;
            matchedRows.add(key);
            let assigned = false;
            const rowComp = _normalizeNumber(row.number);
            for (const arg of (c.events || [])) {
                if ((arg.source || 'ussc') !== 'ussc') continue;
                const t = arg.type;
                if (!(t === undefined || t === null || t === 'argument' || t === 'reargument')) continue;
                const argDate = arg.date || '';
                if (!(argDate === row.date || (!argDate && rows.length === 1))) continue;
                if (caseNorms.length > 1) {
                    const existingComp = _ussCcaseNumFromHref(arg.transcript_href || '', arg.text_href || '');
                    if (existingComp && existingComp !== rowComp) continue;
                }
                assigned = true;
                if (arg.transcript_href) {
                    // The transcript listing is fetched on every run, so always
                    // refresh transcript_href if SCOTUS has rewritten the
                    // hashed filename (no extra network cost).
                    if (arg.transcript_href !== row.pdf_url) {
                        console.log(`${c.number} (${row.date}): transcript_href changed`);
                        console.log(`  old: ${arg.transcript_href}`);
                        console.log(`  new: ${row.pdf_url}`);
                        arg.transcript_href = row.pdf_url;
                        casesModified = true;
                        // SCOTUS rewrites the URL when they re-publish the
                        // PDF (corrections etc.), so drop our cached PDF text
                        // and parsed transcript JSON; the later
                        // _ensureEventTranscript pass will redownload and
                        // re-parse from the new PDF.
                        const cn = _ussCcaseNumFromHref(arg.transcript_href, arg.text_href || '')
                            || _caseFolder(c.number);
                        const cachedTxt = _cachedTextPath(cn, row.date, `${yearStr}-10`);
                        if (exists(cachedTxt)) {
                            unlinkSafe(cachedTxt);
                            console.log(`  invalidated cached text: ${relRepo(cachedTxt)}`);
                        }
                        if (arg.text_href) {
                            const thFile = path.join(path.dirname(casesPath), 'cases', arg.text_href);
                            if (exists(thFile)) {
                                unlinkSafe(thFile);
                                console.log(`  invalidated transcript JSON: ${relRepo(thFile)}`);
                            }
                        }
                    }
                    break;
                }
                const insertAfter = ('audio_href' in arg) ? 'audio_href' : 'date';
                const newArg = {};
                let inserted = false;
                for (const [k, v] of Object.entries(arg)) {
                    newArg[k] = v;
                    if (!inserted && k === insertAfter) {
                        newArg.transcript_href = row.pdf_url;
                        inserted = true;
                    }
                }
                if (!inserted) newArg.transcript_href = row.pdf_url;
                for (const k of Object.keys(arg)) delete arg[k];
                Object.assign(arg, newArg);
                newlyMatched.push({ cp: casesPath, cl: existing, c, a: arg, t: currentTerm });
                casesModified = true;
                console.log(`${c.number} (${row.date}): transcript_href added`);
                break;
            }
            if (!assigned) {
                const audioList = c.events || (c.events = []);
                const already = audioList.some(a =>
                    (a.source || 'ussc') === 'ussc'
                    && a.date === row.date
                    && a.transcript_href === row.pdf_url);
                if (!already) {
                    const usscCompsWith = new Set(caseNorms.filter(cn => byNumber.has(cn)));
                    const caseNumForTitle = usscCompsWith.size > 1 ? row.number : '';
                    const title = _usscAudioTitle('argument', row.date, caseNumForTitle);
                    const newAudio = reorderEvent({
                        source: 'ussc', type: 'argument', date: row.date, title,
                        transcript_href: row.pdf_url,
                    });
                    audioList.push(newAudio);
                    audioList.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                    newlyMatched.push({ cp: casesPath, cl: existing, c, a: newAudio, t: currentTerm });
                    casesModified = true;
                    console.log(`${c.number} (${row.date}): created transcript-only audio object`);
                }
            }
        }
    }

    // Pass 2: new cases
    const existingNumbers = new Set();
    for (const c of existing) {
        if (!('number' in c)) continue;
        for (const n of c.number.split(',')) existingNumbers.add(_normalizeNumber(n.trim()));
    }
    const newByNum = new Map();
    const termsRoot = path.dirname(path.dirname(casesPath));
    for (const row of transcripts) {
        const key = `${row.number}|${row.date}`;
        if (matchedRows.has(key) || existingNumbers.has(row.number)) continue;
        const rowNorm = _normalizeNumber(row.number);
        const laterMatch = _findCaseInLaterTerms(termsRoot, yearStr, rowNorm, row.date);
        if (laterMatch) {
            const { term: ltStr, case: ltCase, allCases: ltCases, casesPath: ltCp } = laterMatch;
            let ltAssigned = false;
            for (const ltArg of (ltCase.events || [])) {
                if ((ltArg.source || 'ussc') !== 'ussc') continue;
                const t = ltArg.type;
                if (!(t === undefined || t === null || t === 'argument' || t === 'reargument')) continue;
                if (ltArg.date !== row.date) continue;
                ltAssigned = true;
                if (!ltArg.transcript_href) {
                    const ltInsert = ('audio_href' in ltArg) ? 'audio_href' : 'date';
                    const newLt = {};
                    let _ins = false;
                    for (const [k, v] of Object.entries(ltArg)) {
                        newLt[k] = v;
                        if (!_ins && k === ltInsert) {
                            newLt.transcript_href = row.pdf_url;
                            _ins = true;
                        }
                    }
                    if (!_ins) newLt.transcript_href = row.pdf_url;
                    for (const k of Object.keys(ltArg)) delete ltArg[k];
                    Object.assign(ltArg, newLt);
                    laterModified.set(ltCp, { lt: ltStr, cl: ltCases });
                    newlyMatched.push({ cp: ltCp, cl: ltCases, c: ltCase, a: ltArg, t: ltStr });
                    console.log(`${ltCase.number} (${row.date}): `
                              + `transcript_href added in ${ltStr}`);
                }
                break;
            }
            if (!ltAssigned) {
                const ltAlready = (ltCase.events || []).some(a =>
                    (a.source || 'ussc') === 'ussc'
                    && a.date === row.date
                    && a.transcript_href === row.pdf_url);
                if (!ltAlready) {
                    const ltTitle = _usscAudioTitle('argument', row.date);
                    const ltEv = reorderEvent({
                        source: 'ussc', type: 'argument', date: row.date, title: ltTitle,
                        transcript_href: row.pdf_url,
                    });
                    if (!ltCase.events) ltCase.events = [];
                    ltCase.events.push(ltEv);
                    ltCase.events.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
                    laterModified.set(ltCp, { lt: ltStr, cl: ltCases });
                    newlyMatched.push({ cp: ltCp, cl: ltCases, c: ltCase, a: ltEv, t: ltStr });
                    console.log(`${ltCase.number} (${row.date}): `
                              + `transcript event created in ${ltStr}`);
                }
            }
            matchedRows.add(key);
            continue;
        }
        if (laterTermNumbers && laterTermNumbers.has(row.number)) {
            const found = laterTermNumbers.get(row.number);
            console.log(`Skipping ${row.number} (already in ${found})`);
            _checkPreviouslyFiled(yearStr, row.number, found, termsRoot);
            continue;
        }
        if (!ADD_CASES) {
            console.log(`  WARNING: ${row.number} is a new case `
                      + `not in cases.json; pass --cases to add it`);
            continue;
        }
        if (!newByNum.has(row.number)) newByNum.set(row.number, []);
        newByNum.get(row.number).push(row);
    }

    const sortedKeys = [...newByNum.keys()].sort();
    for (const norm of sortedKeys) {
        const rows = newByNum.get(norm);
        const title = rows[0].title;
        const audioEntries = rows.map(r => reorderEvent({
            source: 'ussc', type: 'argument', date: r.date,
            title: _usscAudioTitle('argument', r.date),
            transcript_href: r.pdf_url,
        }));
        const newCase = { title, number: norm, events: audioEntries };
        existing.push(newCase);
        existingNumbers.add(norm);
        for (const newEv of audioEntries) {
            newlyMatched.push({ cp: casesPath, cl: existing, c: newCase, a: newEv, t: currentTerm });
        }
        casesModified = true;
        reportChange(`  ${norm}: new case added with ${audioEntries.length} audio entry(ies)`);
    }

    if (casesModified) {
        writeJson(casesPath, existing);
        reportChange('  Updated cases.json.');
        const newNumbers = new Set(newByNum.keys());
        if (newNumbers.size) {
            const yearInt = parseInt(path.basename(path.dirname(casesPath)).split('-')[0], 10);
            if (yearInt >= 2001) {
                console.log('Fetching docket info for newly added case(s) ...');
                await updateDocketInfo(casesPath, String(yearInt), newNumbers);
            }
        }
    } else {
        vprint('No changes needed.');
    }

    for (const [ltCp, { lt: ltStr, cl: ltCases }] of laterModified) {
        writeJson(ltCp, ltCases);
        reportChange(`  Updated ${ltStr}/cases.json.`);
        const ltYear = parseInt(ltStr.split('-')[0], 10);
        const ltNewNums = new Set();
        for (const m of newlyMatched) {
            if (m.cp === ltCp && 'number' in m.c) ltNewNums.add(m.c.number);
        }
        if (ltYear >= 2001 && ltNewNums.size) {
            console.log(`Fetching docket info for newly added ${ltStr} case(s) ...`);
            await updateDocketInfo(ltCp, String(ltYear), ltNewNums);
        }
    }

    if (!newlyMatched.length) return;

    const uniqueCps = new Map();
    for (const { cp, cl, t } of newlyMatched) {
        if (!uniqueCps.has(cp)) uniqueCps.set(cp, { cl, t });
    }

    const ensureChanged = new Set();
    for (const { cp, c, a, t } of newlyMatched) {
        if (await _ensureEventTranscript(cp, c, a, t)) ensureChanged.add(cp);
    }
    for (const cp of ensureChanged) {
        const { cl } = uniqueCps.get(cp);
        writeJson(cp, cl);
        reportChange(`  Updated ${path.basename(path.dirname(cp))}/cases.json with text_href.`);
    }

    const compareChanged = new Set();
    for (const { cp, cl, c, a, t } of newlyMatched) {
        if (a.text_href && await _compareSingleUsscEvent(cp, cl, c, a, t)) {
            compareChanged.add(cp);
        }
    }
    for (const cp of compareChanged) {
        const { cl } = uniqueCps.get(cp);
        writeJson(cp, cl);
        reportChange(`  Updated ${path.basename(path.dirname(cp))}/cases.json after speaker comparison.`);
    }
}

// ── Step 3c: compare ussc vs oyez speakers ─────────────────────────────────

async function compareUsscOyezSpeakers(casesPath, caseFilter = null) {
    const existing = readJson(casesPath);
    const term = path.basename(path.dirname(casesPath));
    let modified = false;
    for (const c of existing) {
        if (!('number' in c)) continue;
        if (caseFilter) {
            const caseNorms = c.number.split(',').map(n => _normalizeNumber(n.trim()));
            if (!caseNorms.includes(_normalizeNumber(caseFilter))) continue;
        }
        for (const arg of (c.events || [])) {
            if ((arg.source || 'ussc') !== 'ussc') continue;
            if (arg.redundant) continue;
            if (!arg.text_href) continue;
            if (await _compareSingleUsscEvent(casesPath, existing, c, arg, term)) {
                modified = true;
            }
        }
    }
    if (modified) {
        writeJson(casesPath, existing);
        reportChange('Updated cases.json after ussc/oyez speaker comparison.');
    } else {
        vprint('No redundant ussc transcripts found.');
    }
}

// ── usCite formatting helpers ──────────────────────────────────────────────

function _isUsCitePlaceholder(cite) {
    return /\bU\.S\.\s+___/.test(cite || '');
}

// Convert a raw citation string (as returned by the opinions page) to the
// canonical usCite format stored in cases.json.
//   "608/2"      → "608 U.S. ___"   (slip-citation: volume known, page not yet)
//   "608 U.S. 5" → "608 U.S. 5"     (final paginated citation)
//   other/empty  → ""
function _formatUsCite(rawCite) {
    if (!rawCite) return '';
    // Final paginated form (may contain NBSP): "608 U.S. 1"
    if (/^\d+ U\.S\.[\s\xa0]+\d+$/.test(rawCite)) return rawCite.replace(/\xa0/g, ' ');
    // Slip form: "608/2" → volume known, page TBD
    const slipM = /^(\d+)\/\d+$/.exec(rawCite);
    if (slipM) return `${slipM[1]} U.S. ___`;
    return '';
}

// Return true if the existing usCite should be replaced with newCite.
// Never downgrades a real page number to a placeholder.
function _shouldUpdateUsCite(existingCite, newCite) {
    if (!newCite) return false;
    if (!existingCite) return true;
    if (existingCite === newCite) return false;
    // Don't overwrite a real page number with a placeholder
    if (!_isUsCitePlaceholder(existingCite) && _isUsCitePlaceholder(newCite)) return false;
    return true;
}

// Convert a lowercase docketKey (as stored in fetchOpinions output) back to the
// canonical normalized case number used in cases.json, e.g.:
//   "25-580"  → "25-580"
//   "22-orig" → "22-Orig"
//   "25a1314" → "25A1314"
function _docketKeyToNumber(docketKey) {
    const origO = /^\d{2}[Oo](\d+)$/.exec(docketKey);
    if (origO) return `${origO[1]}-Orig`;
    const origM = /^(\d+)-orig$/.exec(docketKey);
    if (origM) return `${origM[1]}-Orig`;
    const aM = /^(\d+)(a)(\d+)$/i.exec(docketKey);
    if (aM) return `${aM[1]}A${aM[3]}`;
    return docketKey;
}

// ── Step 2c: add cases from opinions page ─────────────────────────────────

async function importOpinionCases(casesPath, term) {
    const year2 = term.split('-')[0].slice(-2);
    const opinions = await fetchOpinions(year2, CHECK_URLS);
    if (!opinions || !Object.keys(opinions).length) {
        vprint('No opinions found for term; skipping opinion-based case import.');
        return;
    }

    if (!exists(casesPath)) {
        ensureDir(path.dirname(casesPath));
        writeText(casesPath, '[]\n');
    }
    const data = readJson(casesPath);

    // Build a lowercase set of all normalized case numbers already present.
    const existingLower = new Set();
    for (const c of data) {
        for (const part of (c.number || '').split(',')) {
            existingLower.add(_normalizeNumber(part.trim()).toLowerCase());
        }
    }

    const termsRoot = path.dirname(path.dirname(casesPath));
    const yearStr   = term.split('-')[0];
    const laterTermNumbers = _loadLaterTermNumbers(termsRoot, yearStr);
    const laterTermLower   = new Map();
    for (const [n, t] of laterTermNumbers) laterTermLower.set(n.toLowerCase(), t);

    const addedNumbers = new Set();

    for (const [docketKey, opinion] of Object.entries(opinions)) {
        if (existingLower.has(docketKey)) continue;

        const number = _docketKeyToNumber(docketKey);
        const numberLower = _normalizeNumber(number).toLowerCase();

        // docketKey may differ from the stored case number (e.g. "22o141" vs
        // "141-orig"), so check both forms before treating this as a new case.
        if (existingLower.has(numberLower)) continue;

        if (laterTermLower.has(docketKey) || laterTermLower.has(numberLower)) {
            const laterTerm = laterTermLower.get(docketKey) || laterTermLower.get(numberLower);
            vprint(`Skipping opinion ${docketKey} (already in ${laterTerm})`);
            continue;
        }

        if (!ADD_CASES) {
            console.log(`  WARNING: ${number} has an opinion but is not in cases.json; pass --cases to add it`);
            continue;
        }
        const cite   = _formatUsCite(opinion.cite || '');

        const newCaseObj = { title: opinion.name, number };
        if (opinion.date)  newCaseObj.decision     = opinion.date;
        if (cite)          newCaseObj.usCite        = cite;
        if (opinion.href)  newCaseObj.decision_ussc  = opinion.href;

        data.push(reorderCase(newCaseObj));
        existingLower.add(docketKey);
        addedNumbers.add(number);
        console.log(`  ${number}: added from opinions page (${opinion.date || '?'})${cite ? `, usCite=${cite}` : ''}`);
    }

    if (addedNumbers.size) {
        sortCases(term, data, false);
        writeJson(casesPath, data);
        reportChange(`Added ${addedNumbers.size} case(s) from opinions page to cases.json.`);
        const yearInt = parseInt(yearStr, 10);
        if (yearInt >= 2001) {
            console.log('Fetching docket info for newly added opinion case(s) ...');
            await updateDocketInfo(casesPath, String(yearInt), addedNumbers);
        }
    } else {
        vprint('No new opinion-only cases to add.');
    }
}

// ── Step 7: decision_ussc / decision_loc maintenance ──────────────────────

async function upgradeDeadOpinionHrefs(casesPath) {
    const data = readJson(casesPath);
    let casesModified = false;

    let waybackMaxTs = '';
    try {
        const termYear = parseInt(path.basename(path.dirname(casesPath)).split('-')[0], 10);
        waybackMaxTs = `${termYear + 1}0930235959`;
    } catch {}

    const baseUrls = new Set();
    for (const c of data) {
        const href = c.decision_ussc || '';
        if (href && !href.startsWith('https://web.archive.org/')) {
            baseUrls.add(href.split('#')[0]);
        }
    }
    if (!baseUrls.size) {
        vprint('No live decision_ussc values to verify.');
    } else {
        const replacements = new Map();
        for (const base of [...baseUrls].sort()) {
            const [ok] = await checkUrl(base);
            if (ok) {
                replacements.set(base, '');
            } else {
                const wb = await waybackPdfUrl(base, waybackMaxTs);
                if (wb) console.log(`PDF 404 — upgrading to Wayback: ${base}`);
                else console.log(`PDF 404 — no Wayback snapshot found: ${base}`);
                replacements.set(base, wb);
            }
        }
        for (const c of data) {
            const href = c.decision_ussc || '';
            if (!href || href.startsWith('https://web.archive.org/')) continue;
            const base = href.split('#')[0];
            const frag = href.slice(base.length);
            const wb   = replacements.get(base) || '';
            if (wb) {
                c.decision_ussc = wb + frag;
                casesModified = true;
            }
        }
    }
    for (const c of data) {
        const href = c.decision_loc || '';
        if (!href) continue;
        const [ok] = await checkUrl(href.split('#')[0]);
        if (!ok) {
            console.log(`loc.gov URL invalid — marking as decision_loc_bad: ${href}`);
            delete c.decision_loc;
            c.decision_loc_bad = href;
            casesModified = true;
        }
    }
    if (casesModified) {
        writeJson(casesPath, data);
        reportChange('Updated cases.json: replaced dead decision href values.');
    } else {
        vprint('All decision href values are reachable.');
    }
}

async function backfillOpinionHrefs(casesPath, term) {
    const year2 = term.split('-')[0].slice(-2);
    const opinions = await fetchOpinions(year2, CHECK_URLS);
    if (!opinions || !Object.keys(opinions).length) {
        console.log('No slip opinions found.');
        return;
    }
    const data = readJson(casesPath);
    let casesModified = false;

    for (const c of data) {
        const number = c.number || '';
        if (!number) continue;
        let opinion = null;
        for (const part of number.split(',')) {
            opinion = opinions[part.trim().toLowerCase()];
            if (opinion) break;
        }
        if (!opinion) continue;
        let href = opinion.href;
        const cite = _formatUsCite(opinion.cite || '');
        const date = opinion.date || '';
        const existingHref = c.decision_ussc || '';
        const existingCite = c.usCite || '';
        const existingDate = c.decision || '';

        // The slip-opinions index for older terms may now link to preliminary
        // print PDFs (e.g. /opinions/preliminaryprint/584US1PP_final.pdf#page=N)
        // which are no longer accessible. Fall back to the docket page to get
        // the individual opinion PDF (/opinions/YYpdf/DOCKET_hash.pdf).
        if (href && href.includes('/preliminaryprint/')) {
            const termYear = term.split('-')[0];
            const docketInfo = await fetchDocketInfo(number, termYear);
            if (docketInfo.decision_ussc) {
                vprint(`  ${number}: replacing preliminaryprint href with docket opinion PDF`);
                href = docketInfo.decision_ussc;
            }
        }

        const updateHref = (
            !existingHref.startsWith('https://web.archive.org/')
            && !c.decision_ussc_bad
            && existingHref !== href
        );
        const updateCite = _shouldUpdateUsCite(existingCite, cite);
        const updateDate = !!(date && existingDate !== date);

        if (!updateHref && !updateCite && !updateDate) continue;

        const updated = { ...c };
        if (updateDate) updated.decision      = date;
        if (updateCite) updated.usCite        = cite;
        if (updateHref) updated.decision_ussc = href;
        // Strip fields being removed (updateX but value is falsy)
        if (updateHref && !href) delete updated.decision_ussc;

        const reordered = reorderCase(updated);
        for (const k of Object.keys(c)) delete c[k];
        Object.assign(c, reordered);
        casesModified = true;
        if (updateHref) console.log(`  ${number}: decision_ussc → ${href}`);
        if (updateCite) console.log(`  ${number}: usCite → ${cite}`);
        if (updateDate) console.log(`  ${number}: decision → ${date}`);

        const filesPath = path.join(path.dirname(casesPath), 'cases', _caseFolder(number), 'files.json');
        if (exists(filesPath)) {
            await checkOpinionForCase(filesPath, number, term);
        }
    }
    if (casesModified) {
        writeJson(casesPath, data);
        reportChange('Updated cases.json with decision_ussc entries.');
    } else {
        vprint('decision_ussc values already up to date.');
    }
}

// ── Step N: import media files from supremecourt.gov/media/media.aspx ────────

const _MEDIA_PAGE_URL = 'https://www.supremecourt.gov/media/media.aspx';

async function importMediaFiles(termsRoot) {
    const fullHtml = await fetchHtml(_MEDIA_PAGE_URL);

    // Extract just the MediaCase section using table-depth counting, so the
    // </tr> fix below doesn't corrupt other tables on the page.
    const divStart   = fullHtml.indexOf('<div id="MediaCase">');
    const tableStart = fullHtml.indexOf('<table', divStart);
    if (divStart === -1 || tableStart === -1) {
        console.log('importMediaFiles: could not find #MediaCase table');
        return;
    }
    let depth = 0, pos = tableStart;
    while (pos < fullHtml.length) {
        const nextOpen  = fullHtml.indexOf('<table', pos);
        const nextClose = fullHtml.indexOf('</table>', pos);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 6; }
        else { depth--; pos = nextClose + 8; if (depth === 0) break; }
    }
    let section = fullHtml.slice(divStart, pos) + '</div>';

    // The page uses CRLF and some data rows omit their closing </tr>; insert
    // the missing tag so node-html-parser doesn't detach those rows' <td> children.
    section = section.replace(/(<\/td>)([ \t]*\r?\n[ \t]*)(<tr\b)/gi, '$1$2</tr>$2$3');

    const root  = parseHtml(section);
    const table = root.querySelector('#MediaCase table');
    if (!table) {
        console.log('importMediaFiles: could not find #MediaCase table');
        return;
    }

    // Cache loaded terms so we only read each cases.json once.
    const termCasesCache = new Map();

    function getCases(term) {
        if (!termCasesCache.has(term)) {
            const cp = path.join(termsRoot, term, 'cases.json');
            termCasesCache.set(term, exists(cp) ? readJson(cp) : []);
        }
        return termCasesCache.get(term);
    }

    let currentTerm = null;

    for (const tr of table.querySelectorAll('tr')) {
        // Term header row: <td class="termyearTD">
        const termTd = tr.querySelector('td.termyearTD');
        if (termTd) {
            // Inner text like "2020 Term" → "2020-10"
            const termMatch = /(\d{4})\s+Term/i.exec(termTd.text || '');
            currentTerm = termMatch ? `${termMatch[1]}-10` : null;
            continue;
        }

        // Data row must have exactly 4 tds
        const tds = tr.querySelectorAll('td');
        if (tds.length < 4 || !currentTerm) continue;

        const rawDate = (tds[0].text || '').trim();
        const docket  = (tds[1].text || '').trim();
        const mediaTd = tds[2];

        if (!docket) continue;

        // Determine file type and href
        let fileType = null;
        let fileHref = null;
        let fileTitle = null;

        // MP4: direct <a href="...mp4">
        const mp4a = mediaTd.querySelector('a[href*=".mp4"]');
        if (mp4a) {
            fileType  = 'mp4';
            fileHref  = mp4a.getAttribute('href') || '';
            fileTitle = 'MP4 File';
        } else {
            // MP3: <source src="...mp3"> inside a modal
            const src = mediaTd.querySelector('source[src*=".mp3"]');
            if (src) {
                fileType  = 'mp3';
                fileHref  = src.getAttribute('src') || '';
                fileTitle = 'MP3 Audio File';
            }
        }

        if (!fileType || !fileHref) continue;

        const fileDate = parseDate(rawDate);
        if (!fileDate) {
            console.log(`  importMediaFiles: could not parse date '${rawDate}' for docket ${docket}`);
            continue;
        }

        // Find matching case in the term's cases.json
        const cases = getCases(currentTerm);
        const matchedCase = cases.find(c => {
            const numbers = String(c.number || '').split(',').map(s => s.trim());
            return numbers.includes(docket);
        });

        if (!matchedCase) {
            console.log(`  importMediaFiles: no case found for docket ${docket} in term ${currentTerm}`);
            continue;
        }

        const caseNumber = matchedCase.number;
        const caseDir    = path.join(termsRoot, currentTerm, 'cases', _caseFolder(caseNumber));
        const filesPath  = path.join(caseDir, 'files.json');

        let files = exists(filesPath) ? readJson(filesPath) : [];

        // Skip if an entry with the same href already exists
        if (files.some(f => f.href === fileHref)) continue;

        const maxId  = files.reduce((m, f) => Math.max(m, f.file || 0), 0);
        const newEntry = {
            file:  maxId + 1,
            type:  fileType,
            group: 'media',
            title: fileTitle,
            date:  fileDate,
            href:  fileHref,
        };

        files.push(newEntry);
        if (!exists(caseDir)) fs.mkdirSync(caseDir, { recursive: true });
        writeJson(filesPath, files);
        reportChange(`  Added ${fileType.toUpperCase()} entry to ${path.relative(termsRoot, filesPath)}`);
    }
}

// ── Step N+1: import cited URLs from supremecourt.gov/opinions/cited_urls/NN ──

async function importCitedUrls(casesPath, term) {
    const year2 = term.split('-')[0].slice(-2);
    const pageUrl = `${BASE_URL}/opinions/cited_urls/${year2}`;

    let html;
    try {
        html = await fetchHtml(pageUrl);
    } catch (exc) {
        console.log(`Warning: could not fetch cited_urls page: ${exc.message || exc}`);
        return;
    }

    const data = exists(casesPath) ? readJson(casesPath) : [];

    const caseByNumber = new Map();
    for (const c of data) {
        for (const part of (c.number || '').split(',')) {
            const n = _normalizeNumber(part.trim());
            if (n) caseByNumber.set(n.toLowerCase(), c);
        }
    }

    const root = parseHtml(html);
    const table = root.querySelector('table.table');
    if (!table) {
        vprint('importCitedUrls: could not find data table');
        return;
    }

    for (const tr of table.querySelectorAll('tr')) {
        const tds = tr.querySelectorAll('td');
        if (tds.length < 2) continue;

        const caseNumText = (tds[0].text || '').trim();
        if (!caseNumText) continue;

        const caseNum = _normalizeNumber(caseNumText);
        const matchedCase = caseByNumber.get(caseNum.toLowerCase());
        if (!matchedCase) continue;

        const ul = tds[1].querySelector('ul');
        if (!ul) continue;

        const items = [];
        for (const li of ul.querySelectorAll('li')) {
            const a = li.querySelector('a');
            if (!a) continue;
            const rawHref = (a.getAttribute('href') || '').trim();
            const source  = (a.getAttribute('title') || '').trim();
            if (!rawHref || !source) continue;
            const href = _resolveHref(rawHref, BASE_URL);
            if (href) items.push({ href, source });
        }
        if (!items.length) continue;

        const decisionDate = matchedCase.decision || '';
        const caseDir  = path.join(path.dirname(casesPath), 'cases', _caseFolder(matchedCase.number));
        const filesPath = path.join(caseDir, 'files.json');

        let files = exists(filesPath) ? readJson(filesPath) : [];
        const existingHrefs = new Set(files.filter(f => f.href).map(f => f.href));
        let maxId = files.reduce((m, f) => Math.max(m, f.file || 0), 0);
        let added = 0;

        for (const { href, source } of items) {
            if (existingHrefs.has(href)) continue;
            let title;
            try { title = new URL(source).hostname; } catch { title = source; }
            const newEntry = { file: ++maxId, type: 'url', group: 'reference', title };
            if (decisionDate) newEntry.date = decisionDate;
            newEntry.href = href;
            newEntry.source = source;
            files.push(newEntry);
            existingHrefs.add(href);
            added++;
        }

        if (added) {
            ensureDir(caseDir);
            writeJson(filesPath, files);
            reportChange(`  Added ${added} cited URL(s) to ${path.relative(path.dirname(casesPath), filesPath)}`);
        }
    }
}

// ── Main ───────────────────────────────────────────────────────────────────

function _printUsage() {
    console.log('Usage: node scripts/import_ussc.js TERM [CASE]');
    console.log('  Flags: --docket --reparse --verbose --cases --checkurls --prompt --cited-urls');
}

async function main() {
    _anyChanges = false;
    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter(a => a.startsWith('--')));
    const args  = argv.filter(a => !a.startsWith('--'));

    const fetchDocket   = flags.has('--docket');
    const forceReparse  = flags.has('--reparse');
    const citedUrlsOnly = flags.has('--cited-urls');
    VERBOSE     = flags.has('--verbose');
    ADD_CASES   = flags.has('--cases');
    CHECK_URLS  = flags.has('--checkurls');
    PROMPT      = flags.has('--prompt');
    setVcVerbose(VERBOSE);

    if (args.length < 1 || args.length > 2) {
        _printUsage();
        process.exit(1);
    }

    const term = args[0].trim();
    const caseFilter = args.length > 1 ? args[1].trim() : null;

    const m = /^(\d{4})-10$/.exec(term);
    if (!m) {
        console.log(`Error: expected a term in YYYY-10 format (e.g. 2025-10), got '${term}'`);
        process.exit(1);
    }
    const yearStr = m[1];
    const casesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases.json');

    if (citedUrlsOnly) {
        console.log(`Importing cited URLs for ${term} ...`);
        await importCitedUrls(casesPath, term);
        syncFilesCount(casesPath);
        if (!_anyChanges) console.log('Nothing added/updated.');
        if (_rl) _rl.close();
        return;
    }

    if (caseFilter) {
        console.log(`Single-case mode: ${term} / ${caseFilter}`);
        if (!exists(casesPath)) {
            console.log(`Error: ${casesPath} does not exist. Run without a case filter first.`);
            process.exit(1);
        }
        console.log();
        console.log(`Re-generating transcript for ${caseFilter} ...`);
        await generateMissingTranscripts(casesPath, caseFilter);
        await compareUsscOyezSpeakers(casesPath, caseFilter);
        if (_rl) _rl.close();
        return;
    }

    const url = `https://www.supremecourt.gov/oral_arguments/argument_audio/${yearStr}`;

    const termsRoot = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
    const laterTermNumbers = _loadLaterTermNumbers(termsRoot, yearStr);
    if (laterTermNumbers.size) {
        const byTerm = new Map();
        for (const [, t] of laterTermNumbers) byTerm.set(t, (byTerm.get(t) || 0) + 1);
        const summary = [...byTerm].sort().map(([t, c]) => `${c} in ${t}`).join(', ');
        vprint(`Loaded later-term cases for cross-term dedup: ${summary}.`);
    }

    let scraped = [];
    try {
        scraped = await fetchCasesFromUrl(url, yearStr);
    } catch (exc) {
        console.log(`Audio listing page not available (${exc.message || exc}); will rely on transcript listing.`);
    }

    if (scraped.length) {
        console.log(`Found ${scraped.length} case(s).`);
        await updateCasesJson(casesPath, scraped, yearStr, laterTermNumbers);
    } else {
        console.log('No audio cases found.');
        if (!exists(casesPath)) {
            ensureDir(path.dirname(casesPath));
            writeText(casesPath, '[]\n');
        }
    }

    if (yearStr >= '1968') {   // YYYY-10 → 1968-10 cutoff; string compare on YYYY works
        vprint('Importing transcript PDFs from supremecourt.gov listing ...');
        await importTranscriptPdfs(casesPath, yearStr, laterTermNumbers);
    }

    if (forceReparse) console.log('Reparsing all transcripts (--reparse)...');
    else vprint('Checking for missing transcripts ...');
    await generateMissingTranscripts(casesPath, null, forceReparse);

    vprint('Migrating old-format transcripts ...');
    migrateTranscripts(casesPath);

    vprint('Comparing ussc vs oyez speakers ...');
    await compareUsscOyezSpeakers(casesPath);

    if (!fetchDocket) {
        console.log('Skipping docket check (pass --docket to enable).');
    } else if (parseInt(yearStr, 10) >= 2001) {
        console.log('Fetching docket info for all cases...');
        await updateDocketInfo(casesPath, yearStr);
    } else {
        vprint('Skipping docket check (not available before 2001 term).');
    }

    console.log('Checking opinions page for missing cases...');
    await importOpinionCases(casesPath, term);

    vprint('Cleaning up files.json entries ...');
    cleanFilesJson(casesPath);

    vprint('Extracting questions presented ...');
    await extractQuestions(casesPath);

    console.log('Updating opinion references...');
    await backfillOpinionHrefs(casesPath, term);
    if (CHECK_URLS) {
        await upgradeDeadOpinionHrefs(casesPath);
    }

    console.log('Importing media files from supremecourt.gov/media/media.aspx...');
    await importMediaFiles(termsRoot);

    console.log('Importing cited URLs from supremecourt.gov/opinions/cited_urls...');
    await importCitedUrls(casesPath, term);

    syncFilesCount(casesPath);
    if (!_anyChanges) {
        console.log('Nothing added/updated.');
    }

    if (_rl) _rl.close();
}

// Touch unused exports so future modules can reuse them.
export {
    extractTranscriptPdf,
    syncOpinionHrefFromFiles,
};

main().catch(err => {
    console.error(err?.stack || err);
    process.exit(1);
});
