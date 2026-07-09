#!/usr/bin/env node
/**
 * Downloads Oyez oral argument and opinion announcement audio for a SCOTUS term.
 *
 * Usage:
 *   node scripts/import_oyez.js TERM [CASE] [--cases]
 *   node scripts/import_oyez.js OYEZ_URL [--cases]
 *
 * Examples:
 *   node scripts/import_oyez.js 2025-10
 *   node scripts/import_oyez.js 2025          # same as 2025-10
 *   node scripts/import_oyez.js 2025-10 24-1063
 *   node scripts/import_oyez.js https://www.oyez.org/cases/1961/2
 *
 * A case that Oyez's docket_number can't match to any local case (common in
 * older terms originally filed from a different source) is not immediately
 * treated as new: if a local case decided the same day already has every one
 * of that Oyez case's audio files — and matching transcript content, where
 * Oyez has a transcript — filed under a different event, it's skipped as
 * already imported rather than risk creating a duplicate. See
 * caseFullyFiledOn().
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reorderEvent } from './schema.js';
import { syncFilesCount } from './update_cases.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const OYEZ_API   = 'https://api.oyez.org';
const _SPEAKERS_PATH = path.join(REPO_ROOT, 'data', 'ussc', 'speakers.json');
const _JUSTICES_PATH = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');

// Set by --cases; gates creation of new case objects.
let ADD_CASES = false;

// ── Small fs helpers ───────────────────────────────────────────────────────
const exists    = (p) => fs.existsSync(p);
const readText  = (p) => fs.readFileSync(p, 'utf8');
const writeText = (p, s) => fs.writeFileSync(p, s, 'utf8');
const readJson  = (p) => JSON.parse(readText(p));
const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function relRepo(p) {
    const r = path.relative(REPO_ROOT, p);
    return r.startsWith('..') ? p : r;
}

// A case's oyez_href is a single URL string, or (for cases consolidated from
// multiple Oyez case pages) an array of URL strings. Normalize either form
// to an array for iteration.
function oyezHrefList(oyezHref) {
    if (!oyezHref) return [];
    return Array.isArray(oyezHref) ? oyezHref : [oyezHref];
}

// ── Async-aware writeStdout helper for trailing newlines ───────────────────
function writeOut(s) { process.stdout.write(s); }

// ── HTTP ───────────────────────────────────────────────────────────────────

async function fetchJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'import_oyez/1.0' },
            signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        return await resp.json();
    } finally {
        clearTimeout(t);
    }
}

// ── Speakers / justices maps ───────────────────────────────────────────────

function loadSpeakerMap() {
    if (!exists(_SPEAKERS_PATH)) return [];
    let data;
    try { data = readJson(_SPEAKERS_PATH); } catch { return []; }
    const out = [];
    for (const [raw, corrected] of Object.entries(data.typos || {})) {
        out.push([raw.toUpperCase(), null, null, corrected.toUpperCase(), null]);
    }
    for (const [oldN, newN] of Object.entries(data.rename || {})) {
        out.push([oldN.toUpperCase(), null, null, newN.toUpperCase(), null]);
    }
    return out;
}

function resolveSpeakerMap(entries, term) {
    const out = {};
    for (const [base, op, constraint, newName, roleFilter] of entries) {
        if (op === null) out[base] = [newName, roleFilter];
        else if (op === '<' && term < constraint) out[base] = [newName, roleFilter];
        else if (op === '>=' && term >= constraint) out[base] = [newName, roleFilter];
    }
    return out;
}

function loadTitleMap() {
    if (!exists(_SPEAKERS_PATH)) return {};
    let data;
    try { data = readJson(_SPEAKERS_PATH); } catch { return {}; }
    const out = {};
    for (const [k, v] of Object.entries(data.title || {})) {
        out[k.toUpperCase()] = String(v).toUpperCase();
    }
    return out;
}

function loadJustices() {
    if (!exists(_JUSTICES_PATH)) return {};
    let data;
    try { data = readJson(_JUSTICES_PATH); } catch { return {}; }
    const out = {};
    for (const [canonical, info] of Object.entries(data)) {
        out[canonical.toUpperCase()] = canonical;
        for (const alt of info?.alternates || []) {
            out[alt.toUpperCase()] = canonical;
        }
    }
    return out;
}

function applySpeakerMap(envelope, speakerMap, titleMap) {
    if (!titleMap) return;
    for (const sp of envelope?.media?.speakers || []) {
        if (!sp.title) {
            const t = titleMap[sp.name || ''];
            if (t) sp.title = t;
        }
    }
}

const _TITLE_MENTION_RE = /\b(General|Mr\.|Ms\.|Mrs\.|Miss)\s+([A-Z][a-z]+)/g;

function detectTitlesFromTurns(turns, speakers) {
    const lastToTitle = {};
    for (const turn of turns) {
        const text = turn.text || '';
        let m;
        _TITLE_MENTION_RE.lastIndex = 0;
        while ((m = _TITLE_MENTION_RE.exec(text)) !== null) {
            const title = m[1].toUpperCase();
            const last  = m[2].toUpperCase();
            if (!(last in lastToTitle)) lastToTitle[last] = title;
        }
    }
    for (const sp of speakers) {
        if (sp.title) continue;
        const name = (sp.name || '').toUpperCase();
        if (!name) continue;
        const last = name.split(/\s+/).pop();
        if (last in lastToTitle) sp.title = lastToTitle[last];
    }
}

function mergeSpeakers(existing, fresh) {
    const freshByName = Object.fromEntries(fresh.map(sp => [sp.name, sp]));
    const seen = new Set();
    const result = [];
    for (const sp of existing) {
        const name = sp.name;
        if (!(name in freshByName)) continue;
        const merged = { ...sp };
        if (!merged.title && freshByName[name].title) merged.title = freshByName[name].title;
        result.push(merged);
        seen.add(name);
    }
    for (const sp of fresh) {
        if (!seen.has(sp.name)) result.push(sp);
    }
    return result;
}

function mergeEnvelopeSpeakers(outPath, envelope) {
    if (!exists(outPath)) return;
    let oldData;
    try { oldData = readJson(outPath); } catch { return; }
    const oldSpeakers = oldData?.media?.speakers || [];
    if (oldSpeakers.length) {
        envelope.media.speakers = mergeSpeakers(oldSpeakers, envelope.media.speakers);
    }
}

// ── Term/case helpers ──────────────────────────────────────────────────────

function loadTermNumbers(casesPath) {
    if (!exists(casesPath)) return new Set();
    let data;
    try { data = readJson(casesPath); } catch { return new Set(); }
    const out = new Set();
    for (const c of data) {
        for (const part of (c.number || '').split(',')) {
            const n = part.trim();
            if (n) out.add(n);
        }
    }
    return out;
}

function loadLaterTermNumbers(termsRoot, yearStr, lookahead = 2) {
    const result = {};
    const year = parseInt(yearStr, 10);
    for (let offset = 1; offset <= lookahead; offset++) {
        const laterTerm = `${year + offset}-10`;
        const laterPath = path.join(termsRoot, laterTerm, 'cases.json');
        for (const num of loadTermNumbers(laterPath)) {
            if (!(num in result)) result[num] = laterTerm;
        }
    }
    return result;
}

const _laterTermDataCache = {};

function checkPreviouslyFiled(currentTerm, caseNumber, laterTerm, termsRoot) {
    const laterPath = path.join(termsRoot, laterTerm, 'cases.json');
    if (!(laterTerm in _laterTermDataCache)) {
        if (!exists(laterPath)) return;
        try { _laterTermDataCache[laterTerm] = readJson(laterPath); }
        catch { return; }
    }
    const data = _laterTermDataCache[laterTerm];
    for (const c of data) {
        const nums = (c.number || '').split(',').map(s => s.trim());
        if (!nums.includes(caseNumber)) continue;
        const pf = c.previouslyFiled;
        if (!pf) {
            console.log(`  WARNING: ${caseNumber} appears in ${laterTerm} but previouslyFiled is not set on that entry`);
            return;
        }
        if (!String(pf).includes('/')) {
            const fixed = `${pf}/${caseNumber}`;
            c.previouslyFiled = fixed;
            console.log(`  Fixed previouslyFiled for ${caseNumber} in ${laterTerm}: '${pf}' -> '${fixed}'`);
            writeText(laterPath, JSON.stringify(data, null, 2) + '\n');
        }
        return;
    }
}

async function fetchOyezCases(year) {
    const cases = [];
    let page = 0;
    const perPage = 300;
    while (true) {
        const url = `${OYEZ_API}/cases?filter=term:${year}&page=${page}&per_page=${perPage}`;
        const batch = await fetchJson(url);
        if (!batch || batch.length === 0) break;
        cases.push(...batch);
        if (batch.length < perPage) break;
        page++;
    }
    return cases;
}

function isJustice(speaker) {
    for (const role of speaker?.roles || []) {
        if (role && role.type === 'scotus_justice') return true;
    }
    return false;
}

function speakerName(speaker, justices) {
    const raw = speaker?.name || speaker?.last_name || '';
    if (!raw) return isJustice(speaker) ? 'UNKNOWN JUSTICE' : 'UNKNOWN SPEAKER';
    let name = raw.toUpperCase();
    if (justices) name = justices[name] || name;
    return name;
}

function oyezJusticeTitle(speaker) {
    for (const role of speaker?.roles || []) {
        if (!role) continue;
        if (role.type === 'scotus_justice') {
            if ((role.role_title || '').includes('Chief Justice')) return 'CHIEF JUSTICE';
            return 'JUSTICE';
        }
    }
    return null;
}

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

const _MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const _MONTH_INDEX = Object.fromEntries(_MONTHS.map((n, i) => [n, i]));

function parseOyezDate(title) {
    const m = /([A-Z][a-z]+ \d{1,2},\s+\d{4})/.exec(title || '');
    if (!m) return null;
    const m2 = /^([A-Z][a-z]+) (\d{1,2}),\s+(\d{4})$/.exec(m[1].trim());
    if (!m2) return null;
    const monthIdx = _MONTH_INDEX[m2[1]];
    if (monthIdx === undefined) return null;
    const day = parseInt(m2[2], 10);
    const year = parseInt(m2[3], 10);
    if (Number.isNaN(day) || Number.isNaN(year)) return null;
    return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function oyezArgType(title) {
    if ((title || '').toLowerCase().includes('reargument')) return 'reargument';
    return 'argument';
}

function needsFormatRefresh(p) {
    try {
        const data = readJson(p);
        const speakers = data?.media?.speakers || [];
        return speakers.some(s => s.role);
    } catch { return false; }
}

function turnsAreAligned(data) {
    const turns = Array.isArray(data) ? data : (data?.turns || []);
    return turns.some(t => t.time);
}

function audioTitle(typeVal, dateStr, part = 0, caseNum = '') {
    let dateLabel = dateStr || '?';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (m) {
        const monthIdx = parseInt(m[2], 10) - 1;
        if (monthIdx >= 0 && monthIdx < 12) {
            dateLabel = `${_MONTHS[monthIdx]} ${parseInt(m[3], 10)}, ${parseInt(m[1], 10)}`;
        }
    }
    const partStr = part ? ` Part ${part}` : '';
    const caseStr = caseNum ? ` in No. ${caseNum}` : '';
    if (typeVal === 'reargument') return `Oral Reargument${caseStr}${partStr} on ${dateLabel}`;
    if (typeVal === 'opinion') return `Opinion Announcement${partStr} on ${dateLabel}`;
    return `Oral Argument${caseStr}${partStr} on ${dateLabel}`;
}

function caseNumFromHref(textHref, audioHref = '') {
    if (textHref && textHref.includes('/')) return textHref.split('/')[0];
    if (audioHref) {
        const m = /\/case_data\/\d+\/([^/]+)\//.exec(audioHref);
        if (m) return m[1];
    }
    return '';
}

function parseUnixDate(ts) {
    if (!ts) return null;
    const n = Number(ts);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function timelineDecisionDate(timeline) {
    for (const entry of timeline || []) {
        if ((entry || {}).event === 'Decided') {
            const dates = entry.dates || [];
            if (dates.length) return parseUnixDate(dates[0]);
        }
    }
    return null;
}

function setDecision(c, decisionDate) {
    if ('decision' in c) return false;
    const out = {};
    for (const [k, v] of Object.entries(c)) {
        out[k] = v;
        if (k === 'number') out.decision = decisionDate;
    }
    if (!('decision' in out)) out.decision = decisionDate;
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, out);
    return true;
}

function setOyezUrl(c, url) {
    if ('oyez_href' in c) return false;
    const out = {};
    for (const [k, v] of Object.entries(c)) {
        out[k] = v;
        if (k === 'number') out.oyez_href = url;
    }
    if (!('oyez_href' in out)) out.oyez_href = url;
    for (const k of Object.keys(c)) delete c[k];
    Object.assign(c, out);
    return true;
}

function oyezFilename(dateStr, part = 0) {
    const suffix = part ? `-${part}` : '';
    return `${dateStr}-oyez${suffix}.json`;
}

async function fetchOyezTranscript(argHref, justices) {
    const detail = await fetchJson(argHref);
    const mediaFiles = (detail.media_file || []).filter(f => f);
    const mp3Url = (mediaFiles.find(f => f.mime === 'audio/mpeg') || {}).href || '';

    const transcript = detail.transcript;
    if (!transcript) return [null, mp3Url];

    const sections = transcript.sections || [];
    const speakerCache = new Map();          // sp_id -> name
    const justiceTitleCache = new Map();     // sp_id -> 'CHIEF JUSTICE'/'JUSTICE'/null
    const turnsOut = [];
    let turnNum = 0;

    for (const section of sections) {
        if (!section) continue;
        for (const turn of section.turns || []) {
            if (!turn) continue;
            const sp = turn.speaker || {};
            const spId = sp.ID || 0;
            if (!speakerCache.has(spId)) {
                speakerCache.set(spId, speakerName(sp, justices));
                justiceTitleCache.set(spId, oyezJusticeTitle(sp));
            }
            const name = speakerCache.get(spId);

            const blocks = turn.text_blocks || [];
            const text = blocks.filter(b => b && b.text).map(b => b.text.trim()).join(' ');
            if (!text) continue;

            turnNum++;
            turnsOut.push({
                turn: turnNum,
                name,
                text,
                time: formatTime(turn.start || 0.0),
            });
        }
    }
    if (turnsOut.length === 0) return [null, mp3Url];

    const nameToTitle = {};
    for (const [spId, name] of speakerCache) {
        if (!(name in nameToTitle)) nameToTitle[name] = justiceTitleCache.get(spId) || '';
    }
    const seenNames = new Set();
    const speakers = [];
    for (const t of turnsOut) {
        if (!seenNames.has(t.name)) {
            seenNames.add(t.name);
            speakers.push({ name: t.name, title: nameToTitle[t.name] || '' });
        }
    }
    detectTitlesFromTurns(turnsOut, speakers);

    return [{ media: { url: mp3Url, speakers }, turns: turnsOut }, mp3Url];
}

// ── Case-number normalisation ──────────────────────────────────────────────

function normalizeCaseNum(raw) {
    const s = (raw || '').trim().toUpperCase();
    let m = /^(\d+)O(\d+)$/.exec(s);
    if (m) return `${m[2]}-Orig`;
    m = /^(.+?)[\s-]+(ORIG(?:INAL)?)$/i.exec(s);
    if (m) return `${m[1]}-Orig`;
    m = /^(.+?)[\s-]+(MISC(?:ELLANEOUS)?)$/i.exec(s);
    if (m) return `${m[1]}-Misc`;
    return s;
}

function listOyezFiles(dir) {
    if (!exists(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir)
        .filter(n => /-oyez(?:-\d+)?\.json$/.test(n))
        .map(n => path.join(dir, n))
        .sort();
}

function isDir(p) {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ── Already-filed detection (docket-number mismatch guard) ─────────────────
//
// Some terms were originally populated from a source other than Oyez's own
// docket_number (e.g. NARA/USSC listings), so a case can fail to match by
// docket number even though it's already fully filed under a different
// number. Before treating such a case as new, we check whether every one of
// its Oyez audio files — and, where Oyez has a transcript, its content — is
// already accounted for on some local case decided the same day. Only when
// every item can be matched do we consider the case "already filed" and
// skip it outright, rather than risk creating a duplicate.

function readLocalTurns(termCasesDir, textHref) {
    if (!textHref) return null;
    const p = path.join(termCasesDir, textHref);
    if (!exists(p)) return null;
    try {
        const data = readJson(p);
        return Array.isArray(data?.turns) ? data.turns : null;
    } catch { return null; }
}

// Compares the first few turns' text, ignoring whitespace/case, so minor
// re-transcription or speaker-name cleanup doesn't cause a false mismatch.
function turnsMatch(oyezTurns, localTurns, sampleSize = 3) {
    if (!Array.isArray(oyezTurns) || !Array.isArray(localTurns)) return false;
    if (oyezTurns.length === 0 || localTurns.length === 0) return false;
    const norm = (s) => (s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const n = Math.min(sampleSize, oyezTurns.length, localTurns.length);
    for (let i = 0; i < n; i++) {
        if (norm(oyezTurns[i].text) !== norm(localTurns[i].text)) return false;
    }
    return true;
}

// Returns true only if EVERY oral-argument/opinion audio file Oyez lists for
// this case is already present on `candidate` (matched by audio_href on a
// source:'oyez' event), and — for any of those Oyez items that has its own
// transcript — the matched event already has a text_href whose stored turns
// agree with Oyez's. A single unmatched or unverifiable item means we can't
// be sure it's the same case, so the caller should fall back to normal
// new-case handling.
async function caseFullyFiledOn(detail, candidate, termCasesDir, justices) {
    const items = [];
    for (const oa of detail.oral_argument_audio || []) {
        if (oa && !oa.unavailable) items.push(oa);
    }
    for (const oa of detail.opinion_announcement || []) {
        if (oa && !oa.unavailable) items.push(oa);
    }
    if (!items.length) return false; // nothing to compare against — can't confirm

    const oyezEvents = (candidate.events || []).filter(a => a.source === 'oyez' && a.audio_href);
    if (!oyezEvents.length) return false;

    for (const item of items) {
        let envelope, mp3Url;
        try {
            [envelope, mp3Url] = await fetchOyezTranscript(item.href, justices);
            await sleep(200);
        } catch {
            return false; // can't verify this item — don't risk a false match
        }
        const matchedEvent = mp3Url ? oyezEvents.find(a => a.audio_href === mp3Url) : null;
        if (!matchedEvent) return false; // this audio file isn't accounted for

        if (envelope) {
            // Oyez has a transcript for this item — it only counts as filed if
            // the matched event already has one too, and the content agrees.
            if (!matchedEvent.text_href) return false;
            const localTurns = readLocalTurns(termCasesDir, matchedEvent.text_href);
            if (!turnsMatch(envelope.turns, localTurns)) return false;
        }
    }
    return true;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const flags    = process.argv.slice(2).filter(a => a.startsWith('--'));
    const posArgs  = process.argv.slice(2).filter(a => !a.startsWith('--'));
    ADD_CASES = flags.includes('--cases');

    if (posArgs.length < 1 || posArgs.length > 2) {
        console.log('Usage: node scripts/import_oyez.js TERM [CASE] [--cases]');
        console.log('       node scripts/import_oyez.js OYEZ_URL [--cases]');
        process.exit(1);
    }

    const arg = posArgs[0].trim();

    // Single-case URL form: https://www.oyez.org/cases/YYYY/DOCKET
    //                  or:  https://api.oyez.org/cases/YYYY/DOCKET
    let singleCaseUrl = null;
    const urlMatch = /^https?:\/\/(?:www\.|api\.)?oyez\.org\/cases\/(\d{4})\/([^/?#]+)\/?/.exec(arg);

    let yearStr, term, caseFilter;
    if (urlMatch) {
        if (posArgs.length !== 1) {
            console.log('Error: when passing an Oyez URL, do not also pass a CASE argument');
            process.exit(1);
        }
        yearStr = urlMatch[1];
        term = `${yearStr}-10`;
        caseFilter = normalizeCaseNum(decodeURIComponent(urlMatch[2]));
        singleCaseUrl = `${OYEZ_API}/cases/${yearStr}/${urlMatch[2]}`;
    } else {
        caseFilter = posArgs.length === 2 ? posArgs[1].trim() : null;
        if (/^\d{4}$/.test(arg)) {
            yearStr = arg; term = `${arg}-10`;
        } else {
            const m = /^(\d{4})-(\d{2})$/.exec(arg);
            if (!m) {
                console.log(`Error: expected YYYY, YYYY-MM, or an oyez.org URL, got '${arg}'`);
                process.exit(1);
            }
            yearStr = m[1]; term = arg;
        }
    }

    const casesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases.json');
    const _termMonth     = term.split('-')[1];
    const termStart      = `${yearStr}-${_termMonth}-01`;
    const nextTermStart  = `${parseInt(yearStr, 10) + 1}-${_termMonth}-01`;

    let ourCases;
    if (exists(casesPath)) {
        ourCases = readJson(casesPath);
    } else {
        ensureDir(path.dirname(casesPath));
        ourCases = [];
        console.log(`Creating new ${relRepo(casesPath)}`);
    }

    const ourByNum = {};
    for (const c of ourCases) {
        if (!('number' in c)) continue;
        ourByNum[normalizeCaseNum(c.number)] = c;
    }
    for (const c of ourCases) {
        if (!('number' in c)) continue;
        const parts = c.number.split(',');
        if (parts.length > 1) {
            for (const n of parts) {
                const nn = normalizeCaseNum(n.trim());
                if (!(nn in ourByNum)) ourByNum[nn] = c;
            }
        }
    }

    const termsRoot = path.dirname(path.dirname(casesPath));
    const laterTermNumbers = loadLaterTermNumbers(termsRoot, yearStr);

    let oyezCases;
    if (singleCaseUrl) {
        console.log(`Fetching single Oyez case ${singleCaseUrl} ...`);
        const detail = await fetchJson(singleCaseUrl);
        oyezCases = [detail];
    } else {
        console.log(`Fetching Oyez case list for ${yearStr} term ...`);
        oyezCases = await fetchOyezCases(yearStr);
    }
    console.log(`  ${oyezCases.length} case(s) from Oyez`);
    console.log(`  ${Object.keys(ourByNum).length} case(s) in local cases.json`);

    const oyezByNum = {};
    for (const c of oyezCases) oyezByNum[normalizeCaseNum(c.docket_number)] = c;

    const inBoth   = Object.keys(ourByNum).filter(n => n in oyezByNum);
    const oyezOnly = Object.keys(oyezByNum).filter(n => !(n in ourByNum));
    const ourOnly  = Object.keys(ourByNum).filter(n => !(n in oyezByNum));

    console.log(`  In both: ${inBoth.length}`);
    if (oyezOnly.length) console.log(`  Oyez only (${oyezOnly.length}): ${[...oyezOnly].sort().join(', ')}`);
    if (ourOnly.length)  console.log(`  Local only (${ourOnly.length}): ${[...ourOnly].sort().join(', ')}`);

    console.log('');
    let downloaded = 0, skipped = 0, errors = 0;
    let casesModified = false;
    const _redirFiles = new Map();
    const _redirectSnapshots = []; // [laterCasesPath, caseRef, snapshotJson]

    const rawSpeakerMap = loadSpeakerMap();
    const speakerMap = resolveSpeakerMap(rawSpeakerMap, term);
    const titleMap   = loadTitleMap();
    const justices   = loadJustices();

    // Stable JSON snapshot for redirect-write detection.
    const stableJson = (o) => JSON.stringify(o, Object.keys(o).sort());

    const partNumRe = /Part\s+(\d+)/i;

    for (const number of Object.keys(oyezByNum).sort()) {
        if (caseFilter && number !== caseFilter) continue;
        const oyezCase = oyezByNum[number];
        let caseDir = path.join(path.dirname(casesPath), 'cases', number);

        let localCase = ourByNum[number] || null;
        // Docket numbers are reused across terms (e.g. "6" is Baker v. Carr
        // in 1960-10 and Gibson in 1961-10) and across cases within a term
        // (e.g. 1961's docket "2" is Kennedy v. Mendoza-Martinez while
        // "2_0" is Metlakatla v. Egan). If the local match's oyez_href
        // points at a different /cases/YYYY/DOCKET than the current oyez
        // case, treat it as not found so the laterTermNumbers redirect
        // path can run instead.
        if (localCase && localCase.oyez_href) {
            const oyezDocket = normalizeCaseNum(oyezCase.docket_number || number);
            const anyMatches = oyezHrefList(localCase.oyez_href).some(url => {
                const m = /\/cases\/(\d{4})\/([^/?#]+)/.exec(url);
                if (!m) return true;
                return m[1] === yearStr && normalizeCaseNum(decodeURIComponent(m[2])) === oyezDocket;
            });
            if (!anyMatches) localCase = null;
        }
        const localNumber = localCase ? (localCase.number || '') : '';
        const isConsolidated = localNumber.includes(',');
        let caseNumForTitle = '';
        if (isConsolidated) {
            const comps = localNumber.split(',').map(n => normalizeCaseNum(n.trim()));
            const oyezComps = comps.filter(cn => cn in oyezByNum);
            caseNumForTitle = oyezComps.length > 1 ? number : '';
        }

        // existingOyezFilenames tracks by text_href/filename; existingOyezAudioHrefs
        // tracks by the actual audio_href regardless of filename, so a recording
        // already filed under a different date/name (a known issue in some
        // historical terms) is recognized as filed rather than downloaded again
        // under a second name — see caseAlreadyHasAudio() below.
        const existingOyezFilenames = new Set();
        const existingOyezAudioHrefs = new Set();
        if (localCase) {
            for (const a of localCase.events || []) {
                let src = a.source;
                if (!src) {
                    const href = (a.audio_href || '').toLowerCase();
                    if (href.includes('supremecourt.gov')) src = 'ussc';
                    else if (href.includes('nara'))         src = 'nara';
                    else if (href.includes('oyez'))         src = 'oyez';
                }
                if (src === 'oyez') {
                    const th = a.text_href;
                    if (th) existingOyezFilenames.add(th);
                    else if (a.audio_href) existingOyezFilenames.add(a.audio_href);
                    if (a.audio_href) existingOyezAudioHrefs.add(a.audio_href);
                    if (!a.title) {
                        const cn = caseNumFromHref(a.text_href || '', a.audio_href || '');
                        a.title = audioTitle(a.type || 'argument', a.date || '',
                            0, isConsolidated ? cn : '');
                        casesModified = true;
                    }
                }
            }

            if (isDir(caseDir)) {
                for (const oyezPath of listOyezFiles(caseDir).filter(p => /-oyez\.json$/.test(p))) {
                    const fname = path.basename(oyezPath);
                    const oyezHref = number + '/' + fname;
                    if (existingOyezFilenames.has(oyezHref)) continue;
                    const m = /^(\d{4}-\d{2}-\d{2})-oyez\.json$/.exec(fname);
                    if (!m) continue;
                    const dateStr = m[1];
                    let audioHref = '', data = {};
                    try { data = readJson(oyezPath); audioHref = data?.media?.url || ''; }
                    catch { /* ignore */ }
                    const aLower = (audioHref || '').toLowerCase();
                    const typeVal = aLower.includes('opinion') ? 'opinion'
                        : aLower.includes('reargument') ? 'reargument' : 'argument';
                    const newArg = reorderEvent({
                        source: 'oyez',
                        type: typeVal,
                        date: dateStr,
                        title: audioTitle(typeVal, dateStr, 0, caseNumForTitle),
                        audio_href: audioHref,
                        text_href: oyezHref,
                        aligned: turnsAreAligned(data) ? true : null,
                    });
                    if (newArg.aligned === null) delete newArg.aligned;
                    (localCase.events = localCase.events || []).push(newArg);
                    existingOyezFilenames.add(oyezHref);
                    if (audioHref) existingOyezAudioHrefs.add(audioHref);
                    casesModified = true;
                }
            }
        }

        // Always fetch the case detail.
        let detail;
        try {
            detail = await fetchJson(oyezCase.href);
            await sleep(200);
        } catch (exc) {
            console.log(`  ${number}: ERROR fetching case detail: ${exc.message}`);
            errors++;
            continue;
        }

        const argsList = detail.oral_argument_audio || [];

        if (argsList.length === 0 && !localCase) continue;

        if (!localCase) {
            if (number in laterTermNumbers) {
                const foundTerm = laterTermNumbers[number];
                checkPreviouslyFiled(term, number, foundTerm, termsRoot);
                const laterCasesPath = path.join(termsRoot, foundTerm, 'cases.json');
                if (!_redirFiles.has(laterCasesPath) && exists(laterCasesPath)) {
                    _redirFiles.set(laterCasesPath, readJson(laterCasesPath));
                }
                const laterData = _redirFiles.get(laterCasesPath) || [];
                const oyezDocket = normalizeCaseNum(oyezCase.docket_number || number);
                const laterLocal = laterData.find(c => {
                    const nums = (c.number || '').split(',')
                        .map(s => normalizeCaseNum(s.trim()))
                        .filter(Boolean);
                    if (!nums.includes(number)) return false;
                    // Same /cases/YYYY/DOCKET guard as above.
                    if (c.oyez_href) {
                        const anyMatches = oyezHrefList(c.oyez_href).some(url => {
                            const m = /\/cases\/(\d{4})\/([^/?#]+)/.exec(url);
                            if (!m) return true;
                            return m[1] === yearStr && normalizeCaseNum(decodeURIComponent(m[2])) === oyezDocket;
                        });
                        if (!anyMatches) return false;
                    }
                    return true;
                }) || null;
                if (!laterLocal) {
                    console.log(`  ${number}: found in ${foundTerm} — no matching case, skipping`);
                    continue;
                }
                console.log(`  ${number}: redirecting Oyez events to ${foundTerm}`);
                localCase = laterLocal;
                caseDir = path.join(path.dirname(laterCasesPath), 'cases', number);
                _redirectSnapshots.push([laterCasesPath, laterLocal, stableJson(laterLocal)]);

                existingOyezFilenames.clear();
                existingOyezAudioHrefs.clear();
                for (const ra of localCase.events || []) {
                    let rsrc = ra.source;
                    if (!rsrc) {
                        const rah = (ra.audio_href || '').toLowerCase();
                        if (rah.includes('supremecourt.gov')) rsrc = 'ussc';
                        else if (rah.includes('nara'))         rsrc = 'nara';
                        else if (rah.includes('oyez'))         rsrc = 'oyez';
                    }
                    if (rsrc === 'oyez') {
                        if (ra.text_href) existingOyezFilenames.add(ra.text_href);
                        else if (ra.audio_href) existingOyezFilenames.add(ra.audio_href);
                        if (ra.audio_href) existingOyezAudioHrefs.add(ra.audio_href);
                    }
                }
                if (isDir(caseDir)) {
                    for (const rp of listOyezFiles(caseDir).filter(p => /-oyez\.json$/.test(p))) {
                        const fname = path.basename(rp);
                        const rh = number + '/' + fname;
                        if (existingOyezFilenames.has(rh)) continue;
                        const m = /^(\d{4}-\d{2}-\d{2})-oyez\.json$/.exec(fname);
                        if (!m) continue;
                        const rd = m[1];
                        let rdata = {}, rurl = '';
                        try { rdata = readJson(rp); rurl = rdata?.media?.url || ''; }
                        catch { /* ignore */ }
                        const rl = (rurl || '').toLowerCase();
                        const rtype = rl.includes('opinion') ? 'opinion'
                            : rl.includes('reargument') ? 'reargument' : 'argument';
                        const rnew = reorderEvent({
                            source: 'oyez', type: rtype, date: rd,
                            title: audioTitle(rtype, rd),
                            audio_href: rurl, text_href: rh,
                            aligned: turnsAreAligned(rdata) ? true : null,
                        });
                        if (rnew.aligned === null) delete rnew.aligned;
                        (localCase.events = localCase.events || []).push(rnew);
                        if (rurl) existingOyezAudioHrefs.add(rurl);
                        existingOyezFilenames.add(rh);
                        casesModified = true;
                    }
                }
            } else {
                const oyezDecisionDate = timelineDecisionDate(detail.timeline)
                    || timelineDecisionDate(oyezCase.timeline);
                let alreadyFiledAs = null;
                if (oyezDecisionDate) {
                    const termCasesDir = path.join(path.dirname(casesPath), 'cases');
                    for (const candidate of ourCases) {
                        if (candidate.decision !== oyezDecisionDate) continue;
                        if (await caseFullyFiledOn(detail, candidate, termCasesDir, justices)) {
                            alreadyFiledAs = candidate;
                            break;
                        }
                    }
                }
                if (alreadyFiledAs) {
                    console.log(`  ${number} (${oyezCase.name || ''}): already filed as ${alreadyFiledAs.number || alreadyFiledAs.id} (decided ${oyezDecisionDate}) — skipping`);
                    continue;
                } else if (!ADD_CASES) {
                    console.log(`  WARNING: ${number} (${oyezCase.name || ''}) is a new case not in cases.json; pass --cases to add it`);
                    continue;
                } else {
                    localCase = { title: oyezCase.name, number, audio: [] };
                    ourCases.push(localCase);
                    ourByNum[number] = localCase;
                    casesModified = true;
                }
            }
        }

        // Oyez www URL
        const oyezWww = (oyezCase.href || '').replace('api.oyez.org', 'www.oyez.org');
        if (oyezWww && setOyezUrl(localCase, oyezWww)) casesModified = true;

        // Decision date
        const decisionDate = timelineDecisionDate(detail.timeline)
            || timelineDecisionDate(oyezCase.timeline);
        if (decisionDate && setDecision(localCase, decisionDate)) casesModified = true;

        const decisionDateStr = localCase ? (localCase.decision || '') : '';

        // ── Oral arguments ──
        const argsByDate = {};
        for (const oyezArg of argsList) {
            if (oyezArg.unavailable) continue;
            const dateStr = parseOyezDate(oyezArg.title || '');
            if (!dateStr) {
                console.log(`  ${number}: cannot parse date from '${oyezArg.title}' — skipped`);
                continue;
            }
            if (decisionDateStr && dateStr > decisionDateStr) {
                console.log(`  ${number}: skipping audio on ${dateStr} (after decision ${decisionDateStr})`);
                continue;
            }
            (argsByDate[dateStr] = argsByDate[dateStr] || []).push(oyezArg);
        }

        for (const dateStr of Object.keys(argsByDate)) {
            argsByDate[dateStr].sort((a, b) => {
                const ma = partNumRe.exec(a.title || '');
                const mb = partNumRe.exec(b.title || '');
                return (ma ? +ma[1] : 0) - (mb ? +mb[1] : 0);
            });
        }

        for (const [dateStr, parts] of Object.entries(argsByDate)) {
            // Note: an existing unnumbered file for this date is never renamed to
            // "-1" here, even when Oyez now shows multiple parts — a file already
            // on disk under any name is assumed already filed and is left alone.
            // Only parts whose audio isn't matched anywhere on the case (checked
            // below via existingOyezAudioHrefs) are treated as missing and fetched.
            const useParts = parts.length > 1;

            for (let partIdx = 0; partIdx < parts.length; partIdx++) {
                const oyezArg = parts[partIdx];
                const partNum = useParts ? partIdx + 1 : 0;
                const outFname = oyezFilename(dateStr, partNum);
                const outPath  = path.join(caseDir, outFname);
                const outHref  = number + '/' + outFname;

                if (existingOyezFilenames.has(outHref) && !needsFormatRefresh(outPath)) {
                    skipped++;
                    continue;
                }
                const label = useParts ? `Part ${partNum} ` : '';
                writeOut(`  ${number} (${dateStr}) ${label}... `);
                try {
                    const [envelope, mp3Url] = await fetchOyezTranscript(oyezArg.href, justices);
                    if (envelope === null) {
                        if (!mp3Url) {
                            console.log('no transcript data');
                        } else if (existingOyezAudioHrefs.has(mp3Url) || existingOyezFilenames.has(outHref)) {
                            const matched = (localCase.events || []).find(a => a.source === 'oyez' && a.audio_href === mp3Url);
                            console.log(`already filed as ${matched?.text_href || matched?.date || 'an existing entry'} — skipping`);
                        } else {
                            const typeVal = oyezArgType(oyezArg.title || '');
                            const newArg = reorderEvent({
                                source: 'oyez', type: typeVal, date: dateStr,
                                title: audioTitle(typeVal, dateStr, partNum, caseNumForTitle),
                                audio_href: mp3Url,
                            });
                            (localCase.events = localCase.events || []).push(newArg);
                            existingOyezFilenames.add(mp3Url);
                            existingOyezAudioHrefs.add(mp3Url);
                            casesModified = true;
                            console.log('no transcript — audio entry added');
                        }
                        continue;
                    }
                    const audioHref = envelope?.media?.url || '';
                    if (audioHref && existingOyezAudioHrefs.has(audioHref)) {
                        const matched = (localCase.events || []).find(a => a.source === 'oyez' && a.audio_href === audioHref);
                        console.log(`already filed as ${matched?.text_href || matched?.date || 'an existing entry'} — skipping`);
                        continue;
                    }
                    applySpeakerMap(envelope, speakerMap, titleMap);
                    mergeEnvelopeSpeakers(outPath, envelope);
                    ensureDir(caseDir);
                    writeText(outPath, JSON.stringify(envelope, null, 2) + '\n');
                    console.log(`${envelope.turns.length} turns -> ${relRepo(outPath)}`);
                    downloaded++;

                    if (!existingOyezFilenames.has(outHref)) {
                        const typeVal = oyezArgType(oyezArg.title || '');
                        const newArg = reorderEvent({
                            source: 'oyez', type: typeVal, date: dateStr,
                            title: audioTitle(typeVal, dateStr, partNum, caseNumForTitle),
                            audio_href: audioHref,
                            text_href: outHref,
                            aligned: turnsAreAligned(envelope) ? true : null,
                        });
                        if (newArg.aligned === null) delete newArg.aligned;
                        (localCase.events = localCase.events || []).push(newArg);
                        existingOyezFilenames.add(outHref);
                        if (audioHref) existingOyezAudioHrefs.add(audioHref);
                        casesModified = true;
                    }
                    await sleep(300);
                } catch (exc) {
                    console.log(`ERROR: ${exc.message}`);
                    errors++;
                }
            }
        }

        // Set argument/reargument fields for newly created cases.
        if (localCase && localCase.number && !('argument' in localCase)) {
            const argDates = Object.keys(argsByDate)
                .filter(d => argsByDate[d].every(a => oyezArgType(a.title || '') === 'argument'))
                .sort();
            const reargDates = Object.keys(argsByDate)
                .filter(d => argsByDate[d].some(a => oyezArgType(a.title || '') === 'reargument'))
                .sort();
            if (argDates.length) { localCase.argument = argDates.join(','); casesModified = true; }
            if (reargDates.length) { localCase.reargument = reargDates.join(','); casesModified = true; }
        }

        // ── Opinion announcements ──
        if (localCase) {
            const hasUnique = (localCase.events || []).some(a => a.unique);
            const isSecondary = isConsolidated
                && number !== normalizeCaseNum(localNumber.split(',')[0].trim());
            const existingOpinionDates = new Set();
            if (isSecondary) {
                for (const a of localCase.events || []) {
                    if (a.type === 'opinion' && a.date) existingOpinionDates.add(a.date);
                }
            }
            const opinionsByDate = {};
            for (const oyezOp of detail.opinion_announcement || []) {
                if (!oyezOp || oyezOp.unavailable) continue;
                const dateStr = parseOyezDate(oyezOp.title || '');
                if (!dateStr) {
                    console.log(`  ${number}: cannot parse opinion date from '${oyezOp.title}' — skipped`);
                    continue;
                }
                (opinionsByDate[dateStr] = opinionsByDate[dateStr] || []).push(oyezOp);
            }
            for (const dateStr of Object.keys(opinionsByDate)) {
                opinionsByDate[dateStr].sort((a, b) => {
                    const ma = partNumRe.exec(a.title || '');
                    const mb = partNumRe.exec(b.title || '');
                    return (ma ? +ma[1] : 0) - (mb ? +mb[1] : 0);
                });
            }

            for (const [dateStr, parts] of Object.entries(opinionsByDate)) {
                // See the matching comment in the oral-arguments loop above: an
                // existing unnumbered file is never renamed to "-1" here either.
                const useParts = parts.length > 1;
                if (hasUnique) { skipped += parts.length; continue; }
                if (isSecondary && existingOpinionDates.has(dateStr)) {
                    skipped += parts.length; continue;
                }

                for (let partIdx = 0; partIdx < parts.length; partIdx++) {
                    const oyezOp = parts[partIdx];
                    const partNum = useParts ? partIdx + 1 : 0;
                    const outFname = oyezFilename(dateStr, partNum);
                    const outPath  = path.join(caseDir, outFname);
                    const outHref  = number + '/' + outFname;

                    if (existingOyezFilenames.has(outHref) && !needsFormatRefresh(outPath)) {
                        skipped++; continue;
                    }
                    if (exists(outPath) && !needsFormatRefresh(outPath)) {
                        skipped++; continue;
                    }

                    const label = useParts ? `Part ${partNum} ` : '';
                    writeOut(`  ${number} opinion (${dateStr}) ${label}... `);
                    try {
                        const [envelope, mp3Url] = await fetchOyezTranscript(oyezOp.href, justices);
                        if (envelope === null) {
                            if (!mp3Url) {
                                console.log('no transcript data');
                            } else if (existingOyezAudioHrefs.has(mp3Url) || existingOyezFilenames.has(outHref)) {
                                const matched = (localCase.events || []).find(a => a.source === 'oyez' && a.audio_href === mp3Url);
                                console.log(`already filed as ${matched?.text_href || matched?.date || 'an existing entry'} — skipping`);
                            } else {
                                const newEntry = reorderEvent({
                                    source: 'oyez', type: 'opinion', date: dateStr,
                                    title: audioTitle('opinion', dateStr, partNum, caseNumForTitle),
                                    audio_href: mp3Url,
                                });
                                (localCase.events = localCase.events || []).push(newEntry);
                                existingOyezFilenames.add(mp3Url);
                                existingOyezAudioHrefs.add(mp3Url);
                                casesModified = true;
                                console.log('no transcript — audio entry added');
                            }
                            continue;
                        }
                        const audioHref = envelope?.media?.url || '';
                        if (audioHref && existingOyezAudioHrefs.has(audioHref)) {
                            const matched = (localCase.events || []).find(a => a.source === 'oyez' && a.audio_href === audioHref);
                            console.log(`already filed as ${matched?.text_href || matched?.date || 'an existing entry'} — skipping`);
                            continue;
                        }
                        applySpeakerMap(envelope, speakerMap, titleMap);
                        mergeEnvelopeSpeakers(outPath, envelope);
                        ensureDir(caseDir);
                        writeText(outPath, JSON.stringify(envelope, null, 2) + '\n');
                        console.log(`${envelope.turns.length} turns -> ${relRepo(outPath)}`);
                        downloaded++;

                        if (!existingOyezFilenames.has(outHref)) {
                            const newEntry = reorderEvent({
                                source: 'oyez', type: 'opinion', date: dateStr,
                                title: audioTitle('opinion', dateStr, partNum, caseNumForTitle),
                                audio_href: audioHref, text_href: outHref,
                                aligned: turnsAreAligned(envelope) ? true : null,
                            });
                            if (newEntry.aligned === null) delete newEntry.aligned;
                            (localCase.events = localCase.events || []).push(newEntry);
                            existingOyezFilenames.add(outHref);
                            if (audioHref) existingOyezAudioHrefs.add(audioHref);
                            casesModified = true;
                        }
                        await sleep(300);
                    } catch (exc) {
                        console.log(`ERROR: ${exc.message}`);
                        errors++;
                    }
                }
            }
        }
    }

    // ── Supplementary pass: consolidated cases ──
    for (const localCase of ourCases) {
        const localNumber = localCase.number || '';
        if (!localNumber.includes(',')) continue;
        const componentNums = localNumber.split(',').map(n => normalizeCaseNum(n.trim()));
        const oyezComponentNums = componentNums.filter(cn => cn in oyezByNum);
        const useCaseNums = oyezComponentNums.length > 1;
        // Note: existing events' titles are never rewritten here to add/remove an
        // " in No. N" qualifier based on Oyez's current docket listing — titles on
        // already-filed events are assumed to reflect deliberate preferences and
        // are left alone. useCaseNums is only used below for newly-added events.

        // Add missing audio from each component number.
        for (const compNum of componentNums) {
            const oyezCase = oyezByNum[compNum];
            if (!oyezCase) continue;
            if (caseFilter && compNum !== caseFilter && localNumber !== caseFilter) continue;

            const compDir = path.join(path.dirname(casesPath), 'cases', compNum);
            const compDecision = localCase.decision || '';

            const existingComp = new Set(
                (localCase.events || [])
                    .filter(a => a.source === 'oyez' && (a.text_href || '').startsWith(compNum + '/'))
                    .map(a => a.text_href)
            );
            const existingOyezAudioHrefs = new Set(
                (localCase.events || [])
                    .filter(a => a.source === 'oyez' && a.audio_href)
                    .map(a => a.audio_href)
            );
            const existingCompMp3s = new Set(
                (localCase.events || [])
                    .filter(a => a.source === 'oyez' && !a.text_href && a.audio_href)
                    .map(a => a.audio_href)
            );

            let detail;
            try {
                detail = await fetchJson(oyezCase.href);
                await sleep(200);
            } catch (exc) {
                console.log(`  ${localNumber} / ${compNum}: ERROR fetching: ${exc.message}`);
                errors++;
                continue;
            }

            const compDates = [];
            for (const sectionKey of ['oral_argument_audio', 'opinion_announcement']) {
                for (const oa of detail[sectionKey] || []) {
                    if (!oa || oa.unavailable) continue;
                    compDates.push(parseOyezDate(oa.title || ''));
                }
            }
            if (compDates.some(d => d && (d < termStart || d >= nextTermStart))) {
                console.log(`  ${localNumber} / ${compNum}: has audio outside term range (${termStart} – ${nextTermStart}) — skipping component`);
                continue;
            }

            for (const [sectionKey, baseType] of [
                ['oral_argument_audio', 'argument'],
                ['opinion_announcement', 'opinion'],
            ]) {
                const argList = detail[sectionKey] || [];
                const compByDate = {};
                for (const oyezArg of argList) {
                    if (!oyezArg || oyezArg.unavailable) continue;
                    const dateStr = parseOyezDate(oyezArg.title || '');
                    if (!dateStr) continue;
                    if (compDecision && dateStr > compDecision) {
                        console.log(`  ${localNumber} / ${compNum}: skipping audio on ${dateStr} (after decision ${compDecision})`);
                        continue;
                    }
                    (compByDate[dateStr] = compByDate[dateStr] || []).push(oyezArg);
                }

                for (const [dateStr, parts] of Object.entries(compByDate)) {
                    const useParts = parts.length > 1;
                    for (let partIdx = 0; partIdx < parts.length; partIdx++) {
                        const oyezArg = parts[partIdx];
                        const partNum = useParts ? partIdx + 1 : 0;
                        const outFname = oyezFilename(dateStr, partNum);
                        const outHref  = compNum + '/' + outFname;
                        const outPath  = path.join(compDir, outFname);
                        const typeVal  = (baseType === 'opinion')
                            ? 'opinion' : oyezArgType(oyezArg.title || '');

                        if (typeVal === 'opinion'
                                && (localCase.events || []).some(a => a.unique)) {
                            skipped++; continue;
                        }
                        if (existingComp.has(outHref) && exists(outPath)
                                && !needsFormatRefresh(outPath)) {
                            skipped++; continue;
                        }

                        const label = useParts ? `Part ${partNum} ` : '';
                        writeOut(`  ${localNumber} / ${compNum} (${dateStr}) ${label}... `);
                        try {
                            let mp3 = '', algnd = false;
                            if (exists(outPath) && !needsFormatRefresh(outPath)) {
                                let _d = {};
                                try {
                                    _d = readJson(outPath);
                                    mp3 = _d?.media?.url || '';
                                    algnd = turnsAreAligned(_d);
                                } catch { mp3 = ''; algnd = false; }
                                if (mp3 && existingOyezAudioHrefs.has(mp3)) {
                                    skipped++;
                                    console.log('already tracked — skipped');
                                    continue;
                                }
                                console.log('already on disk — adding reference');
                            } else {
                                const [envelope, mp3Url] = await fetchOyezTranscript(oyezArg.href, justices);
                                mp3 = mp3Url;
                                if (envelope === null) {
                                    if (!mp3) {
                                        console.log('no transcript data');
                                    } else if (existingCompMp3s.has(mp3) || existingOyezAudioHrefs.has(mp3)) {
                                        skipped++;
                                        console.log('already tracked — skipped');
                                    } else {
                                        const newEntry = reorderEvent({
                                            source: 'oyez', type: typeVal, date: dateStr,
                                            title: audioTitle(typeVal, dateStr, partNum, useCaseNums ? compNum : ''),
                                            audio_href: mp3,
                                        });
                                        (localCase.events = localCase.events || []).push(newEntry);
                                        existingCompMp3s.add(mp3);
                                        existingOyezAudioHrefs.add(mp3);
                                        casesModified = true;
                                        console.log('no transcript — audio entry added');
                                    }
                                    continue;
                                }
                                mp3 = envelope?.media?.url || '';
                                if (mp3 && existingOyezAudioHrefs.has(mp3)) {
                                    skipped++;
                                    console.log('already tracked — skipped');
                                    continue;
                                }
                                applySpeakerMap(envelope, speakerMap, titleMap);
                                mergeEnvelopeSpeakers(outPath, envelope);
                                ensureDir(compDir);
                                writeText(outPath, JSON.stringify(envelope, null, 2) + '\n');
                                algnd = turnsAreAligned(envelope);
                                console.log(`${envelope.turns.length} turns -> ${relRepo(outPath)}`);
                                downloaded++;
                                await sleep(300);
                            }

                            const newEntry = reorderEvent({
                                source: 'oyez', type: typeVal, date: dateStr,
                                title: audioTitle(typeVal, dateStr, partNum, useCaseNums ? compNum : ''),
                                audio_href: mp3, text_href: outHref,
                                aligned: algnd ? true : null,
                            });
                            if (newEntry.aligned === null) delete newEntry.aligned;
                            (localCase.events = localCase.events || []).push(newEntry);
                            existingComp.add(outHref);
                            if (mp3) existingOyezAudioHrefs.add(mp3);
                            casesModified = true;
                        } catch (exc) {
                            console.log(`ERROR: ${exc.message}`);
                            errors++;
                        }
                    }
                }
            }
        }
    }

    if (casesModified) {
        writeText(casesPath, JSON.stringify(ourCases, null, 2) + '\n');
        console.log(`Updated ${relRepo(casesPath)}`);
    }

    for (const [rpath, lcase, snap] of _redirectSnapshots) {
        if (stableJson(lcase) !== snap) {
            writeText(rpath, JSON.stringify(_redirFiles.get(rpath), null, 2) + '\n');
            console.log(`Updated ${relRepo(rpath)} (via redirect)`);
        }
    }

    syncFilesCount(casesPath);

    console.log('');
    console.log(`Done.  Downloaded: ${downloaded}  |  Already existed: ${skipped}  |  Errors: ${errors}`);
}

// Run main only when invoked directly (not when imported as a library).
const _isMain = (() => {
    try { return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); }
    catch { return false; }
})();

if (_isMain) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

export { caseFullyFiledOn, turnsMatch, readLocalTurns, fetchOyezTranscript, loadJustices };
