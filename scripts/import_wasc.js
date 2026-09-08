#!/usr/bin/env node
/**
 * import_wasc.js — build/maintain courts/wasc/terms/YYYY/cases.json (and the
 * cross-year courts/wasc/terms/YYYY/dates.json) from courts.wa.gov.
 *
 * Usage:
 *   node scripts/import_wasc.js YYYY  [--dry-run] [--verbose] [--no-args]
 *   node scripts/import_wasc.js --sync [--dry-run] [--verbose]
 *
 * Examples:
 *   node scripts/import_wasc.js 2013           # published opinions for 2013
 *   node scripts/import_wasc.js 2005 --dry-run # argument dockets for 2005
 *   node scripts/import_wasc.js --sync         # refile + renumber + dates.json only
 *
 * Two per-year modes, picked by year:
 *   - YYYY >= 2013  OPINION mode: the published-opinions listing
 *       https://www.courts.wa.gov/opinions/index.cfm?fa=opinions.byYear&fileYear=YYYY&crtLevel=S&pubStatus=PUB
 *     Sets decision / decision_day and decision_gov (the opinion PDF URL) on
 *     the matching case, or creates a stub for a docket with no case yet.
 *   - 2000 <= YYYY <= 2012  DOCKET mode: the per-date argument calendars for
 *     YYYY. Creates a stub for any argued docket with no case yet; fills
 *     argument / argument_day from the calendar. No opinion PDFs exist for
 *     these years. (1996-1999 have no machine-readable calendar data — their
 *     cases.json are already complete via the tofj export — so those years
 *     only participate in the whole-dataset normalisation below.)
 *
 * Every per-year run — and `--sync` on its own — then normalises the whole
 * wasc dataset:
 *   - REFILE: a case is filed under its DECISION year (a full YYYY-MM-DD),
 *     else its ARGUMENT year. A case whose current folder disagrees is moved.
 *   - RENUMBER: every touched YYYY/cases.json is re-sorted (sortCases) and its
 *     ids reassigned YYYY-001..NNN in that order.
 *   - docket_url: computed from the argument date for any case missing one.
 *   - dates.json: for a case argued in an earlier year than its filed year, a
 *     {type:"argument"|"reargument", id, term, number, title} entry is written
 *     into that earlier year's dates.json, keyed by the ISO date — the same
 *     "cross-term case-detail object" convention as courts/ussc (see
 *     update_cases.js's syncCrossTermCaseDates).
 *   - terms.json: each year's `dates` flag is set to match dates.json existence.
 *
 * Re-running is idempotent. `courts/wasc/` is git-ignored here; publish.sh
 * syncs it to the argument-aloud-wasc repo.
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';

import { reorderCase, splitDockets } from './schema.js';
import { REPO_ROOT, sortCases } from './update_cases.js';

// courts.wa.gov pages are hand-authored ColdFusion HTML with unclosed td/tr
// tags and stray nested tables — a DOM parser silently drops most rows. The
// structure is rigidly consistent, so everything here is scraped with regexes.
const stripTags = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
const decodeEntities = (s) => (s || '')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/gi, '-')
    .replace(/&#8216;|&#8217;|&lsquo;|&rsquo;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&nbsp;/gi, ' ');

const WASC_TERMS_DIR = path.join(REPO_ROOT, 'courts', 'wasc', 'terms');
const TERMS_JSON     = path.join(WASC_TERMS_DIR, 'terms.json');
const BASE           = 'https://www.courts.wa.gov';
const OPINIONS_URL   = (yr) => `${BASE}/opinions/index.cfm?fa=opinions.byYear&fileYear=${yr}&crtLevel=S&pubStatus=PUB`;
const CAL_YEAR_URL   = (yr) => `${BASE}/appellate_trial_courts/supreme/calendar/?fa=atc_supreme_calendar.display_file&fileID=dspCalYear&yr=${yr}`;
const CAL_BASE       = `${BASE}/appellate_trial_courts/supreme/calendar/`;
const USER_AGENT     = 'Mozilla/5.0';

const MONTHS = ['january','february','march','april','may','june',
                'july','august','september','october','november','december'];

let VERBOSE = false;
let DRY_RUN = false;
let NO_ARGS = false;
const vprint = (...a) => { if (VERBOSE) console.log(...a); };

// ── small fs/json helpers ─────────────────────────────────────────────────
const readJson  = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n', 'utf8');
const exists    = (p) => fs.existsSync(p);
const sleep     = (ms) => new Promise((r) => setTimeout(r, ms));
const rel       = (p) => path.relative(REPO_ROOT, p);

// ── network ──────────────────────────────────────────────────────────────
async function fetchHtml(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
        const resp = await fetch(encodeURI(url), {
            redirect: 'follow', headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
        return await resp.text();
    } finally { clearTimeout(t); }
}
let _lastFetch = 0;
async function fetchHtmlThrottled(url) {
    const wait = 350 - (Date.now() - _lastFetch);
    if (wait > 0) await sleep(wait);
    _lastFetch = Date.now();
    return fetchHtml(url);
}

// ── date helpers ─────────────────────────────────────────────────────────
const _monthIdx = (name) => MONTHS.findIndex((mn) => mn.startsWith(String(name).toLowerCase().slice(0, 3)));

// "Feb. 28, 2013" / "Sept. 26, 2013" / "May 2, 2013" -> "2013-02-28"
function listingDateToIso(s) {
    const m = /([A-Za-z]+)\.?\s+(\d{1,2}),\s+(\d{4})/.exec((s || '').trim());
    if (!m) return null;
    const mi = _monthIdx(m[1]);
    if (mi < 0) return null;
    return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
}
// "2013-02-28" -> "Thursday, February 28, 2013"
function isoToDayLabel(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
}
const isoYear   = (iso) => (/^(\d{4})-\d{2}-\d{2}$/.exec(iso || '') || [])[1] || null;
const fullIso   = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

// docket number, comparison-normalised: lowercase, commas (thousands
// separators, see schema.js) stripped. "200,262-5" == "200262-5".
const normNum = (n) => String(n || '').toLowerCase().replace(/,/g, '').trim();

// The courts.wa.gov calendar URL a case's docket number links to — ported
// verbatim from wasc-export.php's docket_url() (kept http:, matching existing
// data). 2000+ is a flat YYYYMMDD token; 1996-1999 need a &season= plus a
// year-specific date token; nothing exists before 1996.
function wascDocketUrl(argIso) {
    if (!fullIso(argIso)) return '';
    const year = +argIso.slice(0, 4), mm = argIso.slice(5, 7), dd = argIso.slice(8, 10);
    if (year < 1996) return '';
    if (year >= 2000) {
        return `${CAL_BASE}?fa=atc_supreme_calendar.display&year=${year}&file=${argIso.replace(/-/g, '')}`;
    }
    const month = +mm;
    const season = month >= 9 ? 'f' : (month >= 5 ? 's' : 'w');
    let date;
    if (year === 1998)      date = `${argIso.slice(2, 4)}-${mm}-${dd}`;   // YY-MM-DD
    else if (year === 1997) date = `${mm}-${dd}`;                          // MM-DD
    else if (year === 1996) {
        date = `${month}-${+dd}`;
        if (['10-22', '10-23', '10-24'].includes(date)) date += '-96';
    } else                  date = `${argIso.slice(2, 4)}${mm}${dd}`;      // 1999: YYMMDD
    return `${CAL_BASE}?fa=atc_supreme_calendar.display&year=${year}&season=${season}&file=${date}`;
}

// ── opinion-listing parsing (>= 2013) ────────────────────────────────────
// Rows: <td>Feb. 28, 2013</td>
//       <td> <A HREF="...showOpinion&filename=871051MAJ">87105-1</A>
//            <A HREF="/opinions/pdf/871051.pdf">…</a> </td>
//       <td width="60%"><strong class="warning">*</strong> Klem v. Wash. Mut. Bank</td>
//       <td width="15%">Maj., and Con. Opinions</td>
function parseOpinionListing(html) {
    const out = [];
    for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const row = m[1];
        if (!/showOpinion&filename=/i.test(row)) continue;

        const dm = /width=["']?12%["']?[^>]*>\s*([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})/i.exec(row)
                || />\s*([A-Za-z]{3,5}\.?\s+\d{1,2},\s+\d{4})\s*</i.exec(row);
        const dateIso = dm ? listingDateToIso(dm[1]) : null;
        if (!dateIso) continue;

        const numbers = [];
        let showOpinionUrl = null;
        for (const am of row.matchAll(/<a\b[^>]*href=["']([^"']*showOpinion&filename=[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
            const docket = stripTags(decodeEntities(am[2]));
            if (/^\d[\d,]*-\d/.test(docket) && !numbers.some((n) => normNum(n) === normNum(docket))) numbers.push(docket);
            if (!showOpinionUrl) showOpinionUrl = new URL(decodeEntities(am[1]), `${BASE}/opinions/`).href;
        }
        if (!numbers.length) continue;

        const pdfHrefs = [...row.matchAll(/href=["']([^"']+\.pdf)["']/gi)].map((x) => decodeEntities(x[1]));
        const pdfHref = pdfHrefs.find((h) => !/_\d+\.pdf$/i.test(h)) || pdfHrefs[0] || null;
        const pdfUrl = pdfHref ? new URL(pdfHref, `${BASE}/opinions/`).href : null;

        const tm = /width=["']?60%["']?[^>]*>([\s\S]*?)<\/td>/i.exec(row);
        const title = tm ? stripTags(decodeEntities(tm[1])).replace(/^\*\s*/, '').trim() : '';

        out.push({ dateIso, numbers, title, pdfUrl, showOpinionUrl });
    }
    return out;
}
function parsePdfFromShowOpinion(html) {
    const m = /href=["'](\/?[^"']*\/opinions\/pdf\/[^"']+\.pdf)["']/i.exec(html);
    return m ? new URL(decodeEntities(m[1]), BASE).href : null;
}

// ── argument-calendar parsing ────────────────────────────────────────────
// dspCalYear index -> per-argument-date page URLs (2000+; empty for <=1999).
function parseCalYearDayUrls(html) {
    const seen = new Set(), out = [];
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
        const href = decodeEntities(m[1]);
        const d = /[?&]file=(\d{8})\b/.exec(href);
        if (!d || seen.has(d[1])) continue;
        seen.add(d[1]);
        out.push({ iso: `${d[1].slice(0, 4)}-${d[1].slice(4, 6)}-${d[1].slice(6, 8)}`, url: new URL(href, CAL_BASE).href });
    }
    return out;
}

// One calendar page (a per-date page, or a seasonal page holding several
// dates) -> [{ iso, docket, caption }] for every argued case listed:
//   "… Wednesday, January 19, 2005 … Case No. 1 - 74971-0 … A v. B … SYNOPSIS: …"
// This is the 2000+ per-date layout. The 1997-1999 seasonal pages use a bare
// "DOCKET (trialCourt#) …" layout that also intermixes Court-of-Appeals
// petition-for-review items with the same 5-digit number shape — not reliably
// separable — so those years are left to the tofj export (their cases.json
// are already complete anyway). 1996 has no calendar data at all.
const _DATE_HDR_RE = /(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/gi;
const _CASE_RE     = /Case\s*No\.?\s*\d+\s*[-–—]?\s*(\d[\d,]*-\d)\b([\s\S]*?)(?=Case\s*No\.?\s*\d+\s*[-–—]|SYNOPSIS|$)/gi;

function parseCalendarCases(html) {
    const text = stripTags(decodeEntities(html));
    const headers = [];
    for (const h of text.matchAll(_DATE_HDR_RE)) {
        const mi = _monthIdx(h[1]);
        if (mi < 0) continue;
        headers.push({ at: h.index, iso: `${h[3]}-${String(mi + 1).padStart(2, '0')}-${String(+h[2]).padStart(2, '0')}` });
    }
    const isoAt = (pos) => {
        let iso = null;
        for (const h of headers) { if (h.at <= pos) iso = h.iso; else break; }
        return iso;
    };
    const out = [];
    for (const m of text.matchAll(_CASE_RE)) {
        const iso = isoAt(m.index);
        if (!iso) continue;
        out.push({
            iso,
            docket: m[1].trim(),
            caption: captionToTitle((m[2] || '').replace(/^\s*\([^)]*\)\s*/, '').trim()),
        });
    }
    return out;
}

// Best-effort case title from a calendar caption block. Stubs are rare; a
// human/enrich pass can tidy. Reduces "PARTY A, Petitioner, v. PARTY B,
// Respondent." -> "Party A v. Party B", "State of Washington" -> "State".
function captionToTitle(body) {
    // caption sits between "COUNSEL" and "SYNOPSIS"; before COUNSEL is just
    // "Case No. N -" leftovers, after SYNOPSIS is the summary.
    let s = body;
    const cm = /\bCOUNSEL\b/i.exec(s);
    if (cm) s = s.slice(cm.index + cm[0].length);
    s = s.split(/\bSYNOPSIS\b/i)[0];
    s = s.replace(/\b\d+\s*MINUTES?\s+PER\s+SIDE\b/gi, ' ')
         .replace(/\bCONSOLIDATED\b|\bPRO\s*TEM\b[\s\S]*$/gi, ' ')
         .replace(/\b(petition for review granted|passed to the merits|without oral argument)\b/gi, ' ')
         .replace(/\s+/g, ' ').trim();
    const vm = /^(.*?)\s+v\.?\s+(.*)$/i.exec(s);
    if (!vm) return '';
    const side = (p) => {
        let x = p.split(/[;,]/)[0].trim();                       // first named party
        x = x.replace(/\b(petitioner|respondent|appellant|appellee|plaintiff|defendant|petitioners|respondents|et al\.?)\b\.?/gi, '').trim();
        x = x.replace(/\s+/g, ' ').replace(/[.,]+$/, '').trim();
        if (/^state of washington$/i.test(x)) x = 'State';
        // title-case ALL-CAPS words, leave already-mixed-case alone
        if (x === x.toUpperCase()) {
            x = x.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
                 .replace(/\b(Of|The|And|A|An|In|On|For|To|V)\b/g, (w) => w.toLowerCase());
            x = x.charAt(0).toUpperCase() + x.slice(1);
        }
        return x;
    };
    const a = side(vm[1]), b = side(vm[2]);
    return a && b ? `${a} v. ${b}` : '';
}

// ── cases.json dataset ───────────────────────────────────────────────────
const yearDirs = () => fs.readdirSync(WASC_TERMS_DIR)
    .filter((n) => /^\d{4}$/.test(n) && exists(path.join(WASC_TERMS_DIR, n, 'cases.json')))
    .sort();

function loadAllYears() {
    const files = new Map(); // year(number) -> { year, path, cases, changed }
    for (const n of yearDirs()) {
        const p = path.join(WASC_TERMS_DIR, n, 'cases.json');
        let cases; try { cases = readJson(p); } catch { cases = []; }
        files.set(+n, { year: +n, path: p, cases: Array.isArray(cases) ? cases : [], changed: false });
    }
    return files;
}
function ensureYear(files, y) {
    if (!files.has(y)) {
        files.set(y, { year: y, path: path.join(WASC_TERMS_DIR, String(y), 'cases.json'), cases: [], changed: false });
    }
    return files.get(y);
}
function findCase(files, numbers) {
    for (const f of [...files.values()].sort((a, b) => a.year - b.year)) {
        const idx = f.cases.findIndex((c) => {
            const have = splitDockets(c.number).map(normNum);
            return numbers.some((n) => have.includes(normNum(n)));
        });
        if (idx !== -1) return { file: f, idx, case: f.cases[idx] };
    }
    return null;
}
// year a case belongs in: its decision year (full date) else its argument year.
const filedYearOf = (c) => +(isoYear(c.decision) || isoYear(c.argument) || 0) || null;

// ── per-year: OPINION mode (>= 2013) ─────────────────────────────────────
async function opinionPass(y, files) {
    console.log(`  opinion mode: ${OPINIONS_URL(y)}`);
    const rows = parseOpinionListing(await fetchHtmlThrottled(OPINIONS_URL(y)));
    console.log(`  ${rows.length} published opinion row(s)`);

    let calIndex = null;
    const argFor = async (numbers, docketUrl) => {
        const fromUrl = (/[?&]file=(\d{8})\b/.exec(docketUrl || '') || [])[1];
        if (fromUrl) return `${fromUrl.slice(0, 4)}-${fromUrl.slice(4, 6)}-${fromUrl.slice(6, 8)}`;
        if (NO_ARGS) return null;
        if (!calIndex) {
            console.log('  building argument-calendar index …');
            calIndex = await buildDocketArgIndex([y, y - 1, y - 2]);
        }
        for (const n of numbers) if (calIndex.has(normNum(n))) return calIndex.get(normNum(n));
        return null;
    };

    let created = 0, touched = 0;
    for (const row of rows) {
        let pdfUrl = row.pdfUrl;
        if (!pdfUrl && row.showOpinionUrl) {
            try { pdfUrl = parsePdfFromShowOpinion(await fetchHtmlThrottled(row.showOpinionUrl)); }
            catch (e) { vprint(`  [pdf] ${row.numbers[0]}: ${e.message}`); }
        }
        let found = findCase(files, row.numbers);
        let c;
        if (found) { c = found.case; }
        else {
            c = { id: null, title: row.title, number: row.numbers.join(';') };
            ensureYear(files, y).cases.push(c);
            ensureYear(files, y).changed = true;
            created++;
            console.log(`  + new case  ${c.title}  (No. ${c.number})`);
        }
        const snap = JSON.stringify(c);
        c.decision = row.dateIso;
        c.decision_day = isoToDayLabel(row.dateIso);
        if (pdfUrl) c.decision_gov = pdfUrl;
        if (!c.argument) {
            const argIso = await argFor(row.numbers, c.docket_url);
            if (argIso) { c.argument = argIso; c.argument_day = isoToDayLabel(argIso); }
        }
        if (JSON.stringify(c) !== snap) {
            (found ? found.file : ensureYear(files, y)).changed = true;
            if (found) touched++;
        }
    }
    console.log(`  opinion pass: ${created} created, ${touched} updated`);
}

// docket -> argument-date ISO, from the argument calendars for `years`.
async function buildDocketArgIndex(years) {
    const map = new Map();
    for (const yr of years) {
        let idxHtml;
        try { idxHtml = await fetchHtmlThrottled(CAL_YEAR_URL(yr)); }
        catch (e) { vprint(`  [cal] ${yr}: ${e.message}`); continue; }
        for (const { url } of parseCalYearDayUrls(idxHtml)) {
            try { for (const c of parseCalendarCases(await fetchHtmlThrottled(url))) if (!map.has(normNum(c.docket))) map.set(normNum(c.docket), c.iso); }
            catch (e) { vprint(`  [cal] ${url}: ${e.message}`); }
        }
    }
    return map;
}

// ── per-year: DOCKET mode (2000-2012) ────────────────────────────────────
async function docketPass(y, files) {
    console.log(`  docket mode: ${CAL_YEAR_URL(y)}`);
    let idxHtml;
    try { idxHtml = await fetchHtmlThrottled(CAL_YEAR_URL(y)); }
    catch (e) { console.log(`  calendar index unavailable (${e.message}) — nothing to do`); return; }
    const pages = parseCalYearDayUrls(idxHtml).map((d) => d.url);
    console.log(`  ${pages.length} calendar page(s)`);
    if (!pages.length) { console.log('  (no per-date calendar data for this year)'); return; }

    const calCases = [];
    for (const url of pages) {
        try { calCases.push(...parseCalendarCases(await fetchHtmlThrottled(url))); }
        catch (e) { vprint(`  [cal] ${url}: ${e.message}`); }
    }
    // de-dupe by docket, keep earliest date
    const byDocket = new Map();
    for (const c of calCases) {
        const k = normNum(c.docket);
        if (!byDocket.has(k) || c.iso < byDocket.get(k).iso) byDocket.set(k, c);
    }
    console.log(`  ${byDocket.size} distinct argued docket(s) on the calendars`);

    let created = 0, argFixed = 0;
    for (const cc of byDocket.values()) {
        const found = findCase(files, [cc.docket]);
        if (found) {
            const c = found.case;
            if (!c.argument && fullIso(cc.iso)) {
                c.argument = cc.iso;
                c.argument_day = isoToDayLabel(cc.iso);
                found.file.changed = true;
                argFixed++;
            }
            continue;
        }
        if (!fullIso(cc.iso)) continue;
        const c = {
            id: null,
            title: cc.caption || `[${cc.docket}]`,
            number: cc.docket,
            argument: cc.iso,
            argument_day: isoToDayLabel(cc.iso),
        };
        ensureYear(files, y).cases.push(c);
        ensureYear(files, y).changed = true;
        created++;
        console.log(`  + new case  ${c.title}  (No. ${c.number}, argued ${c.argument})`
            + (cc.caption ? '' : '  [no caption parsed — needs a title]'));
    }
    console.log(`  docket pass: ${created} created, ${argFixed} argument date(s) filled`);
}

// ── whole-dataset normalisation ─────────────────────────────────────────
function syncWasc(files) {
    // 1. REFILE
    let refiled = 0;
    for (const f of [...files.values()]) {
        for (let i = f.cases.length - 1; i >= 0; i--) {
            const c = f.cases[i];
            const want = filedYearOf(c);
            if (!want || want === f.year) continue;
            f.cases.splice(i, 1);
            ensureYear(files, want).cases.push(c);
            f.changed = true;
            files.get(want).changed = true;
            refiled++;
            vprint(`  refile ${c.number || c.id}: ${f.year} -> ${want}`);
        }
    }

    // 2. docket_url fill
    let docketUrls = 0;
    for (const f of files.values()) {
        for (const c of f.cases) {
            if (!c.docket_url && c.argument) {
                const u = wascDocketUrl(c.argument);
                if (u) { c.docket_url = u; f.changed = true; docketUrls++; }
            }
        }
    }

    // 3. RENUMBER every file whose sorted-order ids would differ
    let renumbered = 0;
    for (const f of files.values()) {
        sortCases(String(f.year), f.cases, false);
        let any = false;
        f.cases.forEach((c, i) => {
            const want = `${f.year}-${String(i + 1).padStart(3, '0')}`;
            if (c.id !== want) { c.id = want; any = true; }
        });
        f.cases.splice(0, f.cases.length, ...f.cases.map((c) => reorderCase(c)));
        if (any) { f.changed = true; renumbered++; }
    }

    // 4. dates.json — a case argued in an earlier year than its filed year
    const datesByYear = new Map(); // year -> { iso -> [entry] }
    for (const f of files.values()) {
        for (const c of f.cases) {
            for (const [field, type] of [['argument', 'argument'], ['reargument', 'reargument']]) {
                const iso = fullIso(c[field]);
                if (!iso) continue;
                const dy = +iso.slice(0, 4);
                if (dy >= f.year) continue; // same or later year — not a cross-year pointer
                if (!datesByYear.has(dy)) datesByYear.set(dy, {});
                const byIso = datesByYear.get(dy);
                (byIso[iso] ||= []).push({ type, id: c.id, term: String(f.year), number: c.number, title: c.title });
            }
        }
    }
    let datesWritten = 0, datesRemoved = 0;
    const yearsWithDates = new Set(datesByYear.keys());
    const scanDatesYears = new Set([...yearsWithDates, ...yearDirs().map(Number)]);
    for (const dy of scanDatesYears) {
        const p = path.join(WASC_TERMS_DIR, String(dy), 'dates.json');
        const want = datesByYear.get(dy);
        if (want) {
            const sorted = {};
            for (const k of Object.keys(want).sort()) {
                sorted[k] = want[k].sort((a, b) => (a.id || '').localeCompare(b.id || ''));
            }
            const next = JSON.stringify(sorted, null, 2) + '\n';
            if (!exists(p) || fs.readFileSync(p, 'utf8') !== next) {
                if (!DRY_RUN) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, next); }
                datesWritten++;
                vprint(`  ${DRY_RUN ? 'would write' : 'wrote'} ${rel(p)} (${Object.keys(sorted).length} date(s))`);
            }
        } else if (exists(p)) {
            if (!DRY_RUN) fs.unlinkSync(p);
            datesRemoved++;
            vprint(`  ${DRY_RUN ? 'would remove' : 'removed'} stale ${rel(p)}`);
        }
    }

    // 5. write cases.json (an emptied year keeps a "[]" so its dir/dates.json
    //    and terms.json group stay valid — same as a Minutes-only ussc term).
    let filesWritten = 0;
    for (const f of files.values()) {
        if (!f.changed) continue;
        if (DRY_RUN) { console.log(`  [dry-run] would write ${rel(f.path)} (${f.cases.length} case(s))`); }
        else { fs.mkdirSync(path.dirname(f.path), { recursive: true }); writeJson(f.path, f.cases); }
        filesWritten++;
    }

    // 6. rebuild terms.json from the final year set (cases + dates-only years),
    //    decade-grouped, ascending — mirrors wasc-export.php's own builder.
    let termsChanged = false;
    const termYears = [...new Set([
        ...[...files.values()].map((f) => f.year),
        ...yearsWithDates,
    ])].sort((a, b) => a - b);
    const byDecade = new Map();
    for (const yr of termYears) {
        const f = files.get(yr);
        const g = {
            id: String(yr), name: String(yr),
            file: `/courts/wasc/terms/${yr}/cases.json`,
            cases: f ? f.cases.length : 0,
        };
        if (yearsWithDates.has(yr)) g.dates = true;
        const dec = Math.floor(yr / 10) * 10;
        if (!byDecade.has(dec)) byDecade.set(dec, []);
        byDecade.get(dec).push(g);
    }
    const terms = [...byDecade.keys()].sort((a, b) => a - b)
        .map((dec) => ({ name: `${dec}s`, groups: byDecade.get(dec) }));
    const nextTerms = JSON.stringify(terms, null, 2) + '\n';
    if (!exists(TERMS_JSON) || fs.readFileSync(TERMS_JSON, 'utf8') !== nextTerms) {
        if (!DRY_RUN) writeJson(TERMS_JSON, terms);
        termsChanged = true;
    }

    console.log(`sync: ${refiled} refiled, ${renumbered} file(s) renumbered, ${docketUrls} docket_url(s) filled, `
        + `${datesWritten} dates.json written${datesRemoved ? `, ${datesRemoved} removed` : ''}`
        + `${termsChanged ? ', terms.json rebuilt' : ''} — ${filesWritten} cases.json ${DRY_RUN ? 'would change' : 'written'}.`);
}

// ── --justices: justices.json gap-fill + benches.json rebuild ────────────
const JUSTICES_JSON = path.join(REPO_ROOT, 'data', 'wasc', 'justices.json');
const BENCHES_JSON  = path.join(REPO_ROOT, 'courts', 'wasc', 'people', 'justices', 'benches.json');
const WIKI_JUSTICES = 'https://en.wikipedia.org/wiki/List_of_justices_of_the_Washington_Supreme_Court';
// Chief-justice terms since 2010 — neither justices.json's cj_term1_* nor the
// Wikipedia historical table carries these, so bench naming would otherwise
// stall on "Madsen N" through the present. Curated from courts.wa.gov.
const RECENT_CHIEFS = [
    { caps: 'BARBARA MADSEN',  surname: 'MADSEN',    start: '2010-01-11', end: '2017-01-09' },
    { caps: 'MARY FAIRHURST',  surname: 'FAIRHURST', start: '2017-01-09', end: '2020-11-30' },
    { caps: 'STEVEN GONZALEZ', surname: 'GONZALEZ',  start: '2021-01-11', end: '2025-01-13' },
    { caps: 'DEBRA STEPHENS',  surname: 'STEPHENS',  start: '2025-01-13', end: '' },
];
// canonical justice-record key order (mirrors wasc-export.php's $METAKEYS)
const JUSTICE_KEY_ORDER = [
    'id', 'full_name', 'born', 'died', 'birthplace', 'party', 'religion', 'education',
    'career', 'seniority', 'governor', 'governor_party',
    'service_started', 'service_ended', 'term2_started', 'term2_ended',
    'cj_term1_start', 'cj_term1_stop',
];
const reorderJustice = (o) => {
    const out = {};
    for (const k of JUSTICE_KEY_ORDER) if (k in o) out[k] = o[k];
    for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k];
    return out;
};

const _MONTHS_FULL = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));
// "January 1, 2008" -> "2008-01-01"; "1995" -> "1995"; "present"/"—"/"" -> ''
function wikiDate(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    const md = /([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(s);
    if (md) {
        const mi = _monthIdx(md[1]);
        if (mi >= 0) return `${md[3]}-${String(mi + 1).padStart(2, '0')}-${String(+md[2]).padStart(2, '0')}`;
    }
    const y = /\b(1[89]\d{2}|20\d{2})\b/.exec(s);
    return y ? y[1] : '';
}
// normalise a justice name to "FIRST LAST" upper-case (drop middle initials,
// role suffixes, honorifics) for matching wiki rows to justices.json keys.
function nameKey(name) {
    let n = String(name || '')
        .replace(/,.*/, '')                 // ", Chief Justice"
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b[A-Z]\.\s*/g, ' ')      // middle/leading initials "L." "G."
        .replace(/\b(Jr|Sr|II|III)\b\.?/gi, ' ')
        .replace(/[^A-Za-zÀ-ɏ\s'-]/g, ' ')
        .replace(/\s+/g, ' ').trim().toUpperCase();
    return n;
}
const lastKey = (name) => { const p = nameKey(name).split(' '); return p.length ? `${p[0][0] || ''} ${p[p.length - 1]}` : ''; };

async function fetchWikiJustices() {
    const html = await fetchHtml(WIKI_JUSTICES);
    const tables = html.match(/<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>/gi) || [];
    const dec = (s) => decodeEntities(String(s || '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const rowsOf = (t) => (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(
        (r) => (r.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || []).map((c) => dec(c.replace(/^<t[dh][^>]*>|<\/t[dh]>$/gi, ''))));
    const byKey = new Map();      // nameKey -> { start, end, cjStart, cjEnd }
    const put = (k, v) => { if (!k) return; const e = byKey.get(k) || {}; byKey.set(k, { ...e, ...v }); };

    // "current justices" table (precise start dates + chief-term ranges): the
    // one whose header has both "Chief term" and a start-date column.
    const cur = tables.find((t) => /Chief\s*term/i.test(t) && /Start\b/i.test(t));
    if (cur) {
        for (const cells of rowsOf(cur).slice(1)) {
            if (cells.length < 5) continue;
            const nm = cells[1];
            if (!nm) continue;
            const start = wikiDate(cells[3]);
            const cjm = /(1[89]\d{2}|20\d{2})\s*[–-]\s*(present|(?:1[89]\d{2}|20\d{2}))/i.exec(cells[4] || '');
            const rec = { start };
            if (cjm) { rec.cjStart = cjm[1]; if (!/present/i.test(cjm[2])) rec.cjEnd = cjm[2]; }
            put(nameKey(nm), rec);
            put(lastKey(nm), rec);
        }
    }
    // full historical list: header "Name | Began service | Ended service".
    const hist = tables.find((t) => /Began\s*service/i.test(t));
    if (hist) {
        for (const cells of rowsOf(hist).slice(1)) {
            if (cells.length < 3 || !cells[0]) continue;
            const s = wikiDate(cells[1]), e = /present/i.test(cells[2] || '') ? '' : wikiDate(cells[2]);
            const cur2 = byKey.get(nameKey(cells[0])) || {};
            put(nameKey(cells[0]), { start: cur2.start || s, end: e || undefined });
            put(lastKey(cells[0]), { start: (byKey.get(lastKey(cells[0])) || {}).start || s });
        }
    }
    return byKey;
}

// Fill only missing service_started / service_ended / cj_term1_* from the wiki
// map, never overwriting an existing (often more precise) value.
function gapFillJustices(justices, wiki) {
    let filled = 0;
    for (const [caps, j] of Object.entries(justices)) {
        const w = wiki.get(nameKey(j.full_name || caps)) || wiki.get(lastKey(j.full_name || caps));
        if (!w) continue;
        const set = (k, v) => { if (v && !j[k]) { j[k] = v; filled++; vprint(`  [justice] ${caps}.${k} = ${v}`); } };
        set('service_started', w.start);
        set('service_ended', w.end);
        set('cj_term1_start', w.cjStart);
        set('cj_term1_stop', w.cjEnd);
        justices[caps] = reorderJustice(j);
    }
    return filled;
}

// Sweep every roster-change date; each distinct roster is one bench. The bench
// name is the sitting chief's surname + a per-surname ordinal (carrying the
// last known chief forward across gaps in the cj_term data), matching
// courts/ussc's benches.json convention.
function rebuildBenches(justices, decisionIsos) {
    const D = (v) => String(v || '').slice(0, 10);   // tolerate "YYYY" and "YYYY-MM-DD"
    const NOW = new Date().toISOString().slice(0, 10);
    const list = Object.entries(justices).map(([caps, j]) => ({ caps, j }));

    // roster-change events
    const ev = new Map(); // date -> { add:Set, del:Set }
    const bump = (date, kind, caps) => {
        if (!date) return;
        if (!ev.has(date)) ev.set(date, { add: new Set(), del: new Set() });
        ev.get(date)[kind].add(caps);
    };
    for (const { caps, j } of list) {
        for (const [s, e] of [[j.service_started, j.service_ended], [j.term2_started, j.term2_ended]]) {
            if (!s) continue;
            bump(D(s), 'add', caps);
            bump(D(e) || NOW, 'del', caps);
        }
    }
    // chief timeline: [{ start, end, surname }], from justices.json's cj_term1_*
    // plus RECENT_CHIEFS (the tofj/Wikipedia data carries no term for post-2010
    // chiefs), then each term's end clamped to the next term's start.
    const chiefByCaps = new Map();
    for (const { caps, j } of list) {
        if (j.cj_term1_start) chiefByCaps.set(caps, { start: D(j.cj_term1_start), end: D(j.cj_term1_stop), surname: nameKey(j.full_name || caps).split(' ').pop() });
    }
    const deburr = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    for (const rc of RECENT_CHIEFS) {
        for (const [k, v] of chiefByCaps) if (deburr(v.surname) === rc.surname) chiefByCaps.delete(k);
        chiefByCaps.set(rc.caps, { start: rc.start, end: rc.end, surname: rc.surname });
    }
    const chiefs = [...chiefByCaps.values()].sort((a, b) => a.start.localeCompare(b.start));
    for (let i = 0; i < chiefs.length - 1; i++) {
        if (!chiefs[i].end || chiefs[i].end > chiefs[i + 1].start) chiefs[i].end = chiefs[i + 1].start;
    }
    if (chiefs.length && !chiefs[chiefs.length - 1].end) chiefs[chiefs.length - 1].end = NOW;
    const chiefAt = (date) => {
        let inTerm = null, lastBefore = null;
        for (const c of chiefs) {
            if (c.start <= date && date < c.end) inTerm = c;
            if (c.start <= date) lastBefore = c;
        }
        return inTerm || lastBefore;
    };
    const casesIn = (a, b) => decisionIsos.reduce((n, d) => n + (d >= a && (!b || d < b) ? 1 : 0), 0);

    const dates = [...ev.keys()].sort();
    const roster = new Set();
    const seg = [];                 // raw roster intervals, pre-naming
    let openAt = null;
    const bySeniority = () => [...roster].sort((a, b) => (+justices[a].seniority || 999) - (+justices[b].seniority || 999));
    const closeBench = (endDate) => {
        if (openAt === null || !roster.size) return;
        const c = chiefAt(openAt);
        const surname = c ? c.surname
            : nameKey(justices[bySeniority()[0]].full_name).split(' ').pop();
        seg.push({ surname, dateStart: openAt, dateStop: endDate || '', justices: bySeniority() });
    };
    for (const date of dates) {
        const { add, del } = ev.get(date);
        if (openAt !== null && roster.size && (add.size || del.size)) closeBench(date);
        for (const c of del) roster.delete(c);
        for (const c of add) roster.add(c);
        openAt = roster.size ? date : null;
    }
    if (openAt !== null && roster.size) closeBench('');

    // Merge away transient segments: a run shorter than ~25 days that holds no
    // decided cases is an artifact of mixing year-only ("2020") and precise
    // ("2020-01-06") service dates — fold it forward into the next segment.
    const spanDays = (a, b) => {
        const pad = (s) => s.length === 4 ? `${s}-01-01` : s;
        return b ? (Date.parse(pad(b)) - Date.parse(pad(a))) / 864e5 : Infinity;
    };
    const merged = [];
    for (const s of seg) {
        s.cases = casesIn(s.dateStart, s.dateStop && s.dateStop < NOW ? s.dateStop : '');
        const prev = merged[merged.length - 1];
        if (prev && prev.cases === 0 && spanDays(prev.dateStart, prev.dateStop) < 25) {
            s.dateStart = prev.dateStart;
            s.cases = casesIn(s.dateStart, s.dateStop && s.dateStop < NOW ? s.dateStop : '');
            merged[merged.length - 1] = s;
        } else {
            merged.push(s);
        }
    }
    // drop a trailing/opening stub roster or a same-day swap that survived
    const kept = merged.filter((b) => b.justices.length >= 3 && (spanDays(b.dateStart, b.dateStop) >= 25 || b.cases > 0));

    // assign per-surname ordinals + names now that the segment set is final
    const cap = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
    const ordinal = new Map();
    return kept.map((b) => {
        const n = (ordinal.get(b.surname) || 0) + 1;
        ordinal.set(b.surname, n);
        const y2 = b.dateStop && b.dateStop < NOW ? b.dateStop.slice(0, 4) : '';
        return {
            id: `${b.surname.toLowerCase()}${n}`,
            name: `${cap(b.surname)} ${n} (${b.dateStart.slice(0, 4)}–${y2})`,
            dateStart: b.dateStart,
            dateStop: y2 ? b.dateStop : '',
            cases: b.cases,
            justices: b.justices,
        };
    });
}

async function justicesPass() {
    console.log(`import_wasc --justices${DRY_RUN ? ' [dry-run]' : ''}`);
    const justices = readJson(JUSTICES_JSON);

    let wiki = new Map();
    try { wiki = await fetchWikiJustices(); console.log(`  wikipedia: ${wiki.size} name key(s)`); }
    catch (e) { console.log(`  wikipedia fetch failed (${e.message}) — gap-fill skipped`); }
    const filled = gapFillJustices(justices, wiki);
    console.log(`  justices.json: ${filled} field(s) gap-filled`);

    // decision dates across every wasc case, for bench case counts
    const decisionIsos = [];
    for (const f of loadAllYears().values()) for (const c of f.cases) if (fullIso(c.decision)) decisionIsos.push(c.decision);

    const benches = rebuildBenches(justices, decisionIsos);
    console.log(`  benches.json: ${benches.length} bench(es) (${benches.reduce((n, b) => n + b.cases, 0)} case-assignments)`);

    if (DRY_RUN) {
        for (const b of benches.slice(0, 6)) console.log(`    ${b.name}  ${b.dateStart}..${b.dateStop || 'present'}  ${b.justices.length}J ${b.cases}c`);
        console.log(`  [dry-run] would write ${rel(JUSTICES_JSON)}, ${rel(BENCHES_JSON)}`);
        return;
    }
    const jSorted = {};
    for (const k of Object.keys(justices).sort()) jSorted[k] = justices[k];
    writeJson(JUSTICES_JSON, jSorted);
    fs.mkdirSync(path.dirname(BENCHES_JSON), { recursive: true });
    writeJson(BENCHES_JSON, benches);
    console.log(`  wrote ${rel(JUSTICES_JSON)} and ${rel(BENCHES_JSON)}`);
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
    const argv = process.argv.slice(2);
    VERBOSE = argv.includes('--verbose') || argv.includes('-v');
    DRY_RUN = argv.includes('--dry-run');
    NO_ARGS = argv.includes('--no-args');
    const positional = argv.filter((a) => !a.startsWith('-'));
    const syncOnly = argv.includes('--sync');
    const justicesOnly = argv.includes('--justices');
    const noSync = argv.includes('--no-sync'); // batch: scrape only, run --sync once at the end
    const year = positional[0];

    if (justicesOnly) { await justicesPass(); return; }

    if (!syncOnly && !/^\d{4}$/.test(year || '')) {
        console.error('Usage: node scripts/import_wasc.js YYYY  [--dry-run] [--verbose] [--no-args] [--no-sync]');
        console.error('       node scripts/import_wasc.js --sync [--dry-run] [--verbose]');
        console.error('       node scripts/import_wasc.js --justices [--dry-run] [--verbose]');
        process.exit(1);
    }

    const files = loadAllYears();

    if (!syncOnly) {
        const y = +year;
        console.log(`import_wasc ${y}${DRY_RUN ? ' [dry-run]' : ''}`);
        if (y >= 2013)       await opinionPass(y, files);
        else if (y >= 2000)  await docketPass(y, files);
        else                 console.log(`  ${y}: no machine-readable calendar/opinion data on courts.wa.gov (<=1999); sync only`);
    } else {
        console.log(`import_wasc --sync${DRY_RUN ? ' [dry-run]' : ''}`);
    }

    if (noSync && !syncOnly) {
        // scrape-only: persist raw cases.json edits, defer normalisation
        let n = 0;
        for (const f of files.values()) {
            if (!f.changed) continue;
            if (!DRY_RUN) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); writeJson(f.path, f.cases); }
            n++;
        }
        console.log(`  --no-sync: ${n} cases.json ${DRY_RUN ? 'would be' : ''} written raw; run --sync to normalise`);
        return;
    }
    syncWasc(files);
}

main().catch((e) => { console.error(e); process.exit(1); });
