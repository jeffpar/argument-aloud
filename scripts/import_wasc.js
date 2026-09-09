#!/usr/bin/env node
/**
 * import_wasc.js — build/maintain courts/wasc/terms/YYYY/cases.json (and the
 * cross-year courts/wasc/terms/YYYY/dates.json) from courts.wa.gov.
 *
 * Usage:
 *   node scripts/import_wasc.js YYYY  [--dry-run] [--verbose] [--no-args]
 *   node scripts/import_wasc.js YYYY-MM-DD     [--dry-run] [--verbose] [--refetch]
 *   node scripts/import_wasc.js --sync         [--dry-run] [--verbose]
 *   node scripts/import_wasc.js --justices     [--dry-run] [--verbose]
 *   node scripts/import_wasc.js --fix-titles   [--dry-run] [--verbose] [--refetch]
 *   node scripts/import_wasc.js --tvw [YYYY]   [--dry-run] [--verbose] [--refetch]
 *   node scripts/import_wasc.js --verify [YYYY] [--fix] [--dry-run] [--verbose]
 *
 * Examples:
 *   node scripts/import_wasc.js 2013           # published opinions for 2013
 *   node scripts/import_wasc.js 2005 --dry-run # argument dockets for 2005
 *   node scripts/import_wasc.js 2020-09-24     # re-import one argument session
 *   node scripts/import_wasc.js --sync         # refile + renumber + dates.json only
 *   node scripts/import_wasc.js --fix-titles   # "State"/"Washington" party -> "State of Washington"
 *   node scripts/import_wasc.js --tvw 2025     # fill bare TVW events (page_url only) from Invintus
 *   node scripts/import_wasc.js --verify 2025 --fix   # check (and fix) broken docket_url values
 *
 * DATE mode (YYYY-MM-DD): scrape one calendar date's docket sheet, import all
 * of that day's argued cases (create any that are missing; leave existing
 * titles untouched), then match each of the session's TVW oral-argument videos
 * to its correct case — moving a mis-attached tvw event to the right case and
 * deleting strays. Runs the whole-dataset normalisation afterwards like the
 * per-year modes.
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
 * `--fix-titles` is a standalone one-off pass (no --sync): for every case
 * whose title is "X v. State" / "State v. X" (or "… v. Washington" / etc.),
 * it rewrites that bare party to the canonical "State of Washington" — but
 * only where the case's own docket sheet caption confirms that party is the
 * State. See fixTitlesPass for the exact verification rule.
 *
 * `--tvw [YYYY]` finds source:"tvw" events that carry only a page_url and fills
 * video_url / hls_url / length / size / captions_url from the Invintus media
 * API (the same API courts-tvw.php in ~/Sites/archives/tofj/tofj1 uses).
 *
 * `--verify [YYYY]` runs data-integrity checks (report-only; `--fix` applies
 * corrections). Currently: docket_url — probes each stored value and, when
 * dead, the direct-PDF / HTML calendar URLs for that session date, preferring
 * the PDF form (courts.wa.gov retired most per-date HTML calendars).
 *
 * Re-running is idempotent. `courts/wasc/` is git-ignored here; publish.sh
 * syncs it to the argument-aloud-wasc repo.
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { reorderCase, reorderEvent, splitDockets } from './schema.js';
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
const _DASH        = '[-\\u2010-\\u2015\\u2212]';   // hyphen-minus, hyphen..horiz-bar, minus sign
const _CASE_RE     = new RegExp(`Case\\s*No\\.?\\s*\\d+\\s*${_DASH}?\\s*(\\d[\\d,]*-\\d)\\b([\\s\\S]*?)(?=Case\\s*No\\.?\\s*\\d+\\s*${_DASH}|SYNOPSIS|$)`, 'gi');

function parseCalendarCases(html, defaultIso = null) {
    const text = stripTags(decodeEntities(html));
    const headers = [];
    for (const h of text.matchAll(_DATE_HDR_RE)) {
        const mi = _monthIdx(h[1]);
        if (mi < 0) continue;
        headers.push({ at: h.index, iso: `${h[3]}-${String(mi + 1).padStart(2, '0')}-${String(+h[2]).padStart(2, '0')}` });
    }
    // A single-date docket sheet ("…&file=YYYYMMDD") has no weekday-prefixed
    // date header for _DATE_HDR_RE to catch — DATE mode passes the known iso.
    const isoAt = (pos) => {
        let iso = null;
        for (const h of headers) { if (h.at <= pos) iso = h.iso; else break; }
        return iso || defaultIso;
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

// One calendar page's PLAIN TEXT (tag-stripped HTML, or `pdftotext -layout`
// output) -> Map<normNum(docket) -> { left, right }> of the raw
// (un-title-cased) party names in each case's caption — used by --fix-titles
// to check a stored title's "State" / "Washington" party against the docket.
function parseCalendarCaptionsRaw(plainText) {
    const text = stripTags(plainText);
    const map = new Map();
    for (const m of text.matchAll(_CASE_RE)) {
        const parties = _captionParties((m[2] || '').replace(/^\s*\([^)]*\)\s*/, '').trim());
        const k = normNum(m[1].trim());
        if (parties && !map.has(k)) map.set(k, parties);
    }
    return map;
}

// One side of a docket-sheet caption ("STATE OF WASHINGTON v. LELAND HONN KNAPP
// IV Hon. Andrew Kelvin Miller …") -> a clean title-cased party name. The
// current HTML docket-sheet layout runs the Title-Case COUNSEL names straight
// on after party B with NO delimiter, so captionToTitle drags them into the
// title. Exploit that the caption itself is ALL-CAPS: keep only the leading run
// of ALL-CAPS tokens (plus lowercase connectors) and stop at the first
// Title-Case word (the first counsel name). A trailing roman-numeral
// generational suffix ("KNAPP IV") is preserved uppercase.
const _SHEET_CONN = /^(?:of|the|and|&|for|von|van|de|la|el|du|des|di)$/i;
const _SHEET_ROMAN = /^(?:I{1,3}|IV|VI{0,3}|IX|X{1,3})$/;
function _sheetTitleSide(raw) {
    const toks = String(raw || '').trim().split(/\s+/).filter(Boolean);
    const kept = [];
    for (const tok of toks) {
        const bare = tok.replace(/^[("']+/, '').replace(/[.,;:)"']+$/, '');
        if (!bare) continue;
        const caps = /[A-Z0-9]/.test(bare) && !/[a-z]/.test(bare);
        const conn = _SHEET_CONN.test(bare);
        if (!kept.length) { if (!caps) break; }        // must start on an ALL-CAPS token
        else if (!caps && !conn) break;                // hit a Title-Case counsel name
        kept.push(bare);
    }
    if (!kept.length) return '';
    let suffix = '';
    if (kept.length > 1 && _SHEET_ROMAN.test(kept[kept.length - 1])) suffix = ' ' + kept.pop();
    let x = kept.join(' ').toLowerCase()
        .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
        .replace(/\b(Of|The|And|A|An|In|On|For|To|V)\b/g, (w) => w.toLowerCase());
    x = x.charAt(0).toUpperCase() + x.slice(1);
    return (x + suffix).replace(/\s+/g, ' ').trim();
}

// One single-date docket sheet's PLAIN TEXT -> [{ iso, docket, title }] for
// every argued case, using _sheetTitleSide so the run-on counsel names are
// dropped. `title` is '' when the block has no "X v. Y" shape (e.g. an
// "In re Personal Restraint Petition of: …" caption). Used by DATE mode.
function parseDocketSheetCases(plainText, iso) {
    const text = stripTags(decodeEntities(plainText));
    const out = [];
    for (const m of text.matchAll(_CASE_RE)) {
        const docket = m[1].trim();
        let body = (m[2] || '').replace(/^\s*\([^)]*\)\s*/, '').trim().split(/\bSYNOPSIS\b/i)[0];
        const cAt = body.search(/\bCOUNSEL\b/i);
        const vAt = body.search(/\sv\.?\s/i);
        if (cAt >= 0 && vAt >= 0 && cAt < vAt) body = body.slice(cAt + 'COUNSEL'.length);
        const vm = /^(.*?)\s+v\.?\s+(.*)$/i.exec(body.trim());
        let title = '';
        if (vm) {
            const a = _sheetTitleSide(vm[1]), b = _sheetTitleSide(vm[2]);
            if (a && b) title = `${a} v. ${b}`;
        }
        out.push({ iso, docket, title });
    }
    return out;
}

// A calendar caption block -> { left, right } — each the raw (still ALL-CAPS,
// role words stripped) first-named party on that side, or null if the block
// has no "X v. Y" shape. Two layouts occur on courts.wa.gov:
//   - older HTML: "…COUNSEL <A> v. <B> …"                (parties AFTER "COUNSEL")
//   - current PDF: "PETITIONER RESPONDENT <A> v. <B> COUNSEL COUNSEL …"
//     (a column header, then the parties, then the counsel block)
// so slice relative to whichever of "COUNSEL" / " v. " comes first.
function _captionParties(body) {
    let s = String(body).split(/\bSYNOPSIS\b/i)[0];
    const cAt = s.search(/\bCOUNSEL\b/i);
    const vAt = s.search(/\sv\.?\s/i);
    if (vAt < 0) return null;
    if (cAt >= 0 && cAt < vAt) s = s.slice(cAt + 'COUNSEL'.length);   // parties after COUNSEL
    else if (cAt > vAt)        s = s.slice(0, cAt);                    // parties before COUNSEL
    s = s.replace(/\b\d+\s*MINUTES?\s+PER\s+SIDE\b/gi, ' ')
         .replace(/\b(PETITIONERS?|RESPONDENTS?|APPELLANTS?|APPELLEES?|PLAINTIFFS?|DEFENDANTS?|CROSS[-\s]*(?:PETITIONERS?|RESPONDENTS?|APPELLANTS?|APPELLEES?))\b/gi, ' ')
         .replace(/\bCONSOLIDATED\b|\bPRO\s*TEM\b[\s\S]*$/gi, ' ')
         .replace(/\b(petition for review granted|passed to the merits|without oral argument)\b/gi, ' ')
         .replace(/\bCOUNSEL\b[\s\S]*$/i, ' ')                        // any trailing counsel block
         .replace(/\s+/g, ' ').trim();
    const vm = /^(.*?)\s+v\.?\s+(.*)$/i.exec(s);
    if (!vm) return null;
    const rawSide = (p) => {
        let x = p.split(/[;,]/)[0].trim();                       // first named party
        x = x.replace(/\b(petitioner|respondent|appellant|appellee|plaintiff|defendant|petitioners|respondents|appellants|appellees|et al\.?)\b\.?/gi, '').trim();
        return x.replace(/\s+/g, ' ').replace(/[.,]+$/, '').trim();
    };
    return { left: rawSide(vm[1]), right: rawSide(vm[2]) };
}

// Best-effort case title from a calendar caption block. Stubs are rare; a
// human/enrich pass can tidy. "PARTY A, Petitioner, v. PARTY B, Respondent."
// -> "Party A v. Party B". "State of Washington" is kept verbatim (the
// canonical WA party name) — see --fix-titles, which normalises the reverse
// ("State" / "Washington" -> "State of Washington") against docket sheets.
function captionToTitle(body) {
    const parts = _captionParties(body);
    if (!parts) return '';
    const tc = (x) => {
        if (x === x.toUpperCase()) {                             // title-case ALL-CAPS, leave mixed-case alone
            x = x.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
                 .replace(/\b(Of|The|And|A|An|In|On|For|To|V)\b/g, (w) => w.toLowerCase());
            x = x.charAt(0).toUpperCase() + x.slice(1);
        }
        return x;
    };
    const a = tc(parts.left), b = tc(parts.right);
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
    { caps: 'BARBARA A. MADSEN',  surname: 'MADSEN',    start: '2010-01-11', end: '2017-01-09' },
    { caps: 'MARY E. FAIRHURST',  surname: 'FAIRHURST', start: '2017-01-09', end: '2020-11-30' },
    { caps: 'STEVEN C. GONZÁLEZ', surname: 'GONZÁLEZ',  start: '2021-01-11', end: '2025-01-13' },
    { caps: 'DEBRA L. STEPHENS',  surname: 'STEPHENS',  start: '2025-01-13', end: '' },
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

// ── --fix-titles: canonicalise "State" / "Washington" party names ─────────
// For every wasc case whose title splits into exactly two parties and one of
// them is exactly "State" or "Washington", rewrite that party to the canonical
// "State of Washington" — but ONLY where the case's own docket sheet confirms
// that party really is the State (its caption shows STATE OF WASHINGTON / THE
// STATE OF WASHINGTON / STATE / WASHINGTON on that side). Cases with no
// docket_url, an unfetchable/unparseable docket sheet, a caption that doesn't
// confirm it, or a docket the sheet doesn't list are left untouched. Calendar
// pages are cached under courts/wasc/cache/calendar/ (git-ignored) so a
// --dry-run then a real run only hit the network once; --refetch ignores it.
const CAL_CACHE_DIR = path.join(REPO_ROOT, 'courts', 'wasc', 'cache', 'calendar');

// A stored title -> { left, right } on its single " v. " / " vs. ", or null.
function splitTitleParties(title) {
    const m = String(title || '').split(/\s+vs?\.?\s+/i);
    if (m.length !== 2) return null;
    const clean = (x) => x.trim().replace(/,?\s+et\s+al\.?$/i, '').trim();
    return { left: clean(m[0]), right: clean(m[1]) };
}
const _isStateParty      = (s) => /^(state|washington)$/i.test(String(s || '').trim());
// Does a raw caption party name denote the State of Washington in some form?
function _captionIsState(raw) {
    const x = String(raw || '').trim().replace(/[.,]+$/, '').replace(/\s+/g, ' ');
    return /^(the\s+)?state(\s+of\s+wash(ington)?)?$/i.test(x)
        || /^washington$/i.test(x)
        || /^(the\s+)?state\s+of\s+wash(ington)?\b.*\bex\s+rel\b/i.test(x);
}
const _alphaTokens = (s) => (String(s || '').toUpperCase().match(/[A-Z]{3,}/g) || []);
// ubiquitous words in a WA caption's "v. <party>" tail — carry no signal for
// telling one same-day argument's video from another's.
const _TAIL_STOP = new Set(['state', 'of', 'washington', 'the', 'a', 'an', 'in', 're',
    'dep', 'dept', 'department', 'city', 'county', 'personal', 'restraint', 'petition',
    'matter', 'dependency', 'marriage', 'welfare', 'det', 'detention', 'pers', 'estate',
    'ex', 'rel', 'and', 'co', 'inc', 'llc', 'corp']);
// true iff `a` and `b` differ by exactly one inserted / deleted character
// (a transcription typo like the WA calendar's "976652-0" for "97652-0").
function _oneCharApart(a, b) {
    if (Math.abs(a.length - b.length) !== 1) return false;
    const s = a.length < b.length ? a : b;
    const l = a.length < b.length ? b : a;
    let i = 0, j = 0, skipped = false;
    while (i < s.length && j < l.length) {
        if (s[i] === l[j]) { i++; j++; }
        else { if (skipped) return false; skipped = true; j++; }
    }
    return true;
}
// Loose "same case" check: our non-State party shares a name token with the
// caption's corresponding party — guards against a wrong docket/caption match.
function _corroborates(ourOther, capOther) {
    const ours = _alphaTokens(ourOther);
    if (!ours.length) return true;
    const theirs = _alphaTokens(capOther);
    return ours.some((t) => theirs.some((c) => c === t || c.includes(t) || t.includes(c)));
}
let _pdftotextOk = null;
function _havePdftotext() {
    if (_pdftotextOk === null) {
        try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); _pdftotextOk = true; }
        catch { _pdftotextOk = false; }
    }
    return _pdftotextOk;
}
// Fetch one calendar page and return it as PLAIN TEXT (tag-stripped for HTML,
// `pdftotext -layout` for a PDF — courts.wa.gov moved recent session dockets
// from per-date HTML to PDF). Cached under courts/wasc/cache/calendar/ as .txt.
async function _fetchCalendarText(url, refetch) {
    const key = url.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 180);
    const cf = path.join(CAL_CACHE_DIR, key + '.txt');
    if (!refetch && exists(cf)) return fs.readFileSync(cf, 'utf8');
    const wait = 350 - (Date.now() - _lastFetch);
    if (wait > 0) await sleep(wait);
    _lastFetch = Date.now();
    let text = '';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
        const resp = await fetch(encodeURI(url), { redirect: 'follow', headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
        if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.slice(0, 5).toString('latin1') === '%PDF-') {
                if (_havePdftotext()) {
                    try { text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: buf, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'); }
                    catch { text = ''; }
                }
            } else {
                text = stripTags(decodeEntities(buf.toString('utf8')));
            }
        }
    } finally { clearTimeout(t); }
    // Only cache a real hit — an empty result is a fetch failure (404, timeout,
    // WA rate-limit) and must stay retryable on the next run.
    if (text) { fs.mkdirSync(CAL_CACHE_DIR, { recursive: true }); fs.writeFileSync(cf, text, 'utf8'); }
    return text;
}
// Given a stored (HTML) docket_url with a file=YYYYMMDD param, the current
// direct-PDF URL for that same session date.
function _pdfCalendarUrl(docketUrl) {
    const ymd = (/[?&]file=(\d{8})\b/.exec(docketUrl || '') || [])[1];
    return ymd ? `${BASE}/appellate_trial_courts/supreme/calendar/${ymd.slice(0, 4)}/${ymd}.pdf` : null;
}

async function fixTitlesPass(refetch) {
    console.log(`import_wasc --fix-titles${DRY_RUN ? ' [dry-run]' : ''}${refetch ? ' [refetch]' : ''}`);
    const files = loadAllYears();

    // Collect candidates: two-party title, a "State"/"Washington" party, a docket_url.
    const byUrl = new Map();   // docket_url -> [{ f, c, parts, sides, dockets }]
    let noSplit = 0, notStateParty = 0, noDocketUrl = 0;
    for (const f of files.values()) {
        for (const c of f.cases) {
            const parts = splitTitleParties(c.title);
            if (!parts) { noSplit++; continue; }
            const sides = ['left', 'right'].filter((s) => _isStateParty(parts[s]));
            if (!sides.length) { notStateParty++; continue; }
            if (!c.docket_url) { noDocketUrl++; continue; }
            if (!byUrl.has(c.docket_url)) byUrl.set(c.docket_url, []);
            byUrl.get(c.docket_url).push({ f, c, parts, sides, dockets: splitDockets(c.number).map(normNum) });
        }
    }
    const totalCand = [...byUrl.values()].reduce((n, a) => n + a.length, 0);
    console.log(`  ${totalCand} candidate case(s) across ${byUrl.size} docket sheet(s)`
        + ` (skipped: ${noDocketUrl} with no docket_url, ${notStateParty + noSplit} with no bare State/Washington party)`);

    const changes = [];
    const stats = { docketMissing: 0, notConfirmed: 0, ambiguous: 0, fromPdf: 0 };
    let done = 0;
    for (const [url, list] of byUrl) {
        // Try the stored docket_url (HTML) first; if it yields no caption for
        // some candidate on this sheet, fall back to the current direct-PDF URL
        // for the same session date (WA retired the old per-date HTML pages).
        const needed = new Set(list.flatMap(({ c }) => splitDockets(c.number).map(normNum)));
        const captions = new Map();
        for (const src of [url, _pdfCalendarUrl(url)]) {
            if (!src) continue;
            let m;
            try { m = parseCalendarCaptionsRaw(await _fetchCalendarText(src, refetch)); }
            catch (e) { vprint(`  [fetch fail] ${src} — ${e.message}`); continue; }
            for (const [k, v] of m) if (!captions.has(k)) { captions.set(k, v); if (src !== url) stats.fromPdf++; }
            if ([...needed].every((d) => captions.has(d))) break;
        }
        if (++done % 100 === 0) console.log(`  …${done}/${byUrl.size} sheets`);

        for (const { f, c, parts, sides } of list) {
            // A title that's "State"/"Washington" on BOTH sides is a garbled
            // parse (the non-State side is really a person the old importer
            // failed to name) — leave it for manual repair, don't half-fix it.
            if (sides.length === 2) { stats.ambiguous++; vprint(`  [both sides State] ${c.id} "${c.title}"`); continue; }
            const s = sides[0];
            const other = s === 'left' ? 'right' : 'left';
            // The other party must read like a real name (has a capital) —
            // else the whole title is broken ("State v. issues", "775 v. State")
            // and needs a proper fix, not just the State half canonicalised.
            if (!/[A-Z]/.test(parts[other])) { stats.notConfirmed++; vprint(`  [other side not a name] ${c.id} "${c.title}"`); continue; }

            let capParties = null;
            for (const d of splitDockets(c.number).map(normNum)) { if (captions.has(d)) { capParties = captions.get(d); break; } }
            if (!capParties) { stats.docketMissing++; vprint(`  [not on sheet] ${c.id} "${c.title}" (${c.number})`); continue; }

            const next = { ...parts };
            let hit = false;
            if (_captionIsState(capParties[s])) {
                if (_corroborates(parts[other], capParties[other])) { next[s] = 'State of Washington'; hit = true; }
                else vprint(`  [no corroboration] ${c.id} "${c.title}" — our "${parts[other]}" vs caption "${capParties[other]}"`);
            }
            if (!hit) { stats.notConfirmed++; continue; }
            if (next.left === next.right) { stats.ambiguous++; vprint(`  [would self-collide] ${c.id} "${c.title}"`); continue; }

            const newTitle = `${next.left} v. ${next.right}`;
            if (newTitle === c.title) continue;
            changes.push({ year: f.year, id: c.id, from: c.title, to: newTitle });
            c.title = newTitle;
            f.changed = true;
        }
    }

    changes.sort((a, b) => (a.year - b.year) || a.id.localeCompare(b.id));
    for (const ch of changes) console.log(`  ${ch.id}  "${ch.from}"  ->  "${ch.to}"`);
    console.log(`\n  ${changes.length} title(s) ${DRY_RUN ? 'would change' : 'changed'}`
        + `  (not on sheet: ${stats.docketMissing}, caption didn't confirm: ${stats.notConfirmed},`
        + ` ambiguous: ${stats.ambiguous}; ${stats.fromPdf} caption(s) read from PDF calendars)`);

    let wrote = 0;
    for (const f of files.values()) {
        if (!f.changed) continue;
        if (!DRY_RUN) writeJson(f.path, f.cases);
        wrote++;
    }
    console.log(`  ${wrote} cases.json ${DRY_RUN ? 'would be' : ''} written`);
}

// ── --tvw: fill a bare TVW event (page_url only) from the Invintus API ────
// A wasc `events[]` entry with source "tvw" carries a page_url (the tvw.org
// watch/video page) plus, when we've resolved them, the real playable media:
// video_url (a Backblaze B2 .mp4), hls_url, length ("HH:MM:SS"), size (bytes),
// captions_url (.vtt). This pass finds events that have ONLY page_url and asks
// the Invintus media API (the same one courts-tvw.php in ~/Sites/archives/tofj
// uses) to fill the rest. Old pre-~2015 broadcasts aren't in that API and are
// reported as unresolved. Scope with an optional YYYY.
const INVINTUS_CLIENT = '9375922947';
const INVINTUS_KEY     = '7WhiEBzijpritypp8bqcU7pfU9uicDR';
const INVINTUS_URL     = 'https://api.v3.invintus.com/v2/Event/getDetailed';
const TVW_CACHE_DIR    = path.join(REPO_ROOT, 'courts', 'wasc', 'cache', 'tvw');

// eventID out of a tvw.org page URL:
//   https://tvw.org/watch/?eventID=2012090012B   -> 2012090012B
//   https://tvw.org/video/washington-state-supreme-court-2025051142/ -> 2025051142
function tvwEventId(pageUrl) {
    const u = String(pageUrl || '');
    let m = /[?&]eventID=([0-9A-Za-z]+)/.exec(u);
    if (m) return m[1];
    m = /tvw\.org\/video\/[^/]*?-(\d{8,12}[A-Z]?)\/?(?:[?#].*)?$/i.exec(u);
    return m ? m[1] : '';
}

async function invintusEvent(eid, refetch) {
    const cf = path.join(TVW_CACHE_DIR, `${eid}.json`);
    if (!refetch && exists(cf)) {
        try { const j = JSON.parse(fs.readFileSync(cf, 'utf8')); return j && j.data ? j.data : null; } catch { /* refetch */ }
    }
    const wait = 350 - (Date.now() - _lastFetch);
    if (wait > 0) await sleep(wait);
    _lastFetch = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    let j = null;
    try {
        const resp = await fetch(INVINTUS_URL, {
            method: 'POST', signal: ctrl.signal,
            headers: { 'Content-Type': 'application/json', 'authorization': 'embedder', 'wsc-api-key': INVINTUS_KEY },
            body: JSON.stringify({ eventID: String(eid), clientID: INVINTUS_CLIENT, showStreams: true, showDownloadLinks: true, showMediaAssets: true }),
        });
        j = await resp.json().catch(() => null);
    } finally { clearTimeout(t); }
    fs.mkdirSync(TVW_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cf, JSON.stringify(j || {}, null, 1), 'utf8');
    return (j && !(j.errors && j.errors.hasError) && j.data && j.data.eventID) ? j.data : null;
}

// HEAD/Range-probe a media URL for its byte length (Invintus fileSize is
// sometimes 0 — or a bogus tiny value — for older archives).
async function probeSize(url) {
    if (!url) return 0;
    try {
        const r = await fetch(encodeURI(url), { headers: { 'User-Agent': USER_AGENT, Range: 'bytes=0-0' }, redirect: 'follow' });
        const cr = r.headers.get('content-range');
        if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) return +m[1]; }
        const cl = r.headers.get('content-length');
        if (cl && r.status === 200) return +cl;
    } catch { /* fall through to HEAD */ }
    try {
        const r = await fetch(encodeURI(url), { method: 'HEAD', headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
        const cl = r.headers.get('content-length');
        return r.ok && cl ? +cl : 0;
    } catch { return 0; }
}

// Invintus getDetailed `data` -> the five media props we store (only the ones
// we could actually determine). Mirrors courts-tvw.php's invintus_media_from_event.
async function tvwMediaFromEvent(d, eid) {
    const out = {};
    const vids = (d.mediaAssets || []).filter((a) => a.type === 'video');
    const vAsset = vids.find((a) => a.currentStatus === 'archive') || vids[0];
    const dl = d.downloadLinks || {};

    // video_url: prefer a Backblaze B2 progressive .mp4.
    const hashOf = (s) => (/([0-9a-f]{40})\.(?:mp4|m4a)\b/i.exec(String(s || '')) || [])[1];
    let videoUrl = '';
    if (vAsset && /f005\.backblazeb2\.com/i.test(vAsset.fileUrl || '')) videoUrl = vAsset.fileUrl;
    if (!videoUrl) {
        const h = hashOf(vAsset && vAsset.fileUrl) || hashOf(dl.videoDownloadURI);
        if (h) videoUrl = `https://f005.backblazeb2.com/file/invintus-client-media/${INVINTUS_CLIENT}/${h}.mp4`;
    }
    if (!videoUrl && dl.videoDownloadURI) videoUrl = dl.videoDownloadURI;
    if (videoUrl) out.video_url = videoUrl;

    let hls = (d.streamingURIs && d.streamingURIs.main) || '';
    if (hls && hls.includes('//media.m3u8')) hls = hls.replace('//media.m3u8', `/${eid}/media.m3u8`);
    if (hls) out.hls_url = hls;

    if (vAsset && /^\d{1,2}:\d{2}:\d{2}$/.test(vAsset.totalRunTime || '')) out.length = vAsset.totalRunTime;

    // Invintus fileSize is 0 — or a bogus sub-kB placeholder — on legacy media;
    // an oral-argument video is never under ~1 MB, so re-probe in that case.
    let size = +(vAsset && vAsset.fileSize) || 0;
    if (size < 1_000_000 && out.video_url) size = await probeSize(out.video_url);
    if (size >= 1_000_000) out.size = size;

    const capAsset = (d.mediaAssets || []).find((a) => a.type === 'caption');
    const vtt = d.captionPath || (capAsset && capAsset.fileUrl) || '';
    if (/\.vtt(\?|$)/i.test(vtt)) out.captions_url = vtt;

    return out;
}

async function tvwPass(yearArg, refetch) {
    console.log(`import_wasc --tvw${yearArg ? ' ' + yearArg : ''}${DRY_RUN ? ' [dry-run]' : ''}`);
    const files = loadAllYears();
    const MEDIA_KEYS = ['video_url', 'hls_url', 'length', 'size', 'captions_url'];

    let bare = 0, resolved = 0, unresolved = 0, partial = 0;
    for (const f of files.values()) {
        if (yearArg && f.year !== +yearArg) continue;
        for (const c of f.cases) {
            for (let i = 0; i < (c.events || []).length; i++) {
                const e = c.events[i];
                if (e.source !== 'tvw' || !e.page_url) continue;
                if (MEDIA_KEYS.some((k) => e[k] != null && e[k] !== '')) continue;   // not bare
                bare++;
                const eid = tvwEventId(e.page_url);
                if (!eid) { unresolved++; console.log(`  [no eventID] ${c.id} ${e.page_url}`); continue; }
                let data;
                try { data = await invintusEvent(eid, refetch); }
                catch (err) { unresolved++; console.log(`  [api error] ${c.id} ${eid} — ${err.message}`); continue; }
                if (!data) { unresolved++; console.log(`  [not in Invintus] ${c.id} ${eid}  (${e.page_url})`); continue; }
                const media = await tvwMediaFromEvent(data, eid);
                const got = MEDIA_KEYS.filter((k) => media[k] != null);
                if (!got.length) { unresolved++; console.log(`  [nothing playable] ${c.id} ${eid}`); continue; }
                c.events[i] = reorderEvent({ ...e, ...media });
                f.changed = true;
                if (got.length === MEDIA_KEYS.length) resolved++; else partial++;
                console.log(`  ${c.id}  ${eid}  +[${got.join(', ')}]${got.length < MEDIA_KEYS.length ? `  (missing ${MEDIA_KEYS.filter((k) => !media[k]).join(', ')})` : ''}`);
            }
        }
    }
    console.log(`\n  ${bare} bare tvw event(s): ${resolved} fully resolved, ${partial} partially, ${unresolved} unresolved`);

    let wrote = 0;
    for (const f of files.values()) {
        if (!f.changed) continue;
        if (!DRY_RUN) writeJson(f.path, f.cases);
        wrote++;
    }
    console.log(`  ${wrote} cases.json ${DRY_RUN ? 'would be' : ''} written`);
}

// ── DATE mode (YYYY-MM-DD): one argument session from its docket sheet ────
// The TVW WP-REST day window rejects the bare `Mozilla/5.0` UA with an HTML
// block; a full browser UA returns JSON.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// TVW oral-argument videos in the [date-1, date+2) window -> [{ eid, date,
// link, name, text }] for WA Supreme Court sessions only. Ports courts-tvw.php's
// day_videos(). Cached under courts/wasc/cache/tvw/ as window-YYYY-MM-DD.json.
async function _tvwDayVideos(dateIso, refetch) {
    const cf = path.join(TVW_CACHE_DIR, `window-${dateIso}.json`);
    let arr = null;
    if (!refetch && exists(cf)) { try { arr = JSON.parse(fs.readFileSync(cf, 'utf8')); } catch { arr = null; } }
    if (!Array.isArray(arr)) {
        const d = new Date(`${dateIso}T00:00:00Z`).getTime();
        const after  = new Date(d - 86400e3).toISOString().slice(0, 10) + 'T00:00:00';
        const before = new Date(d + 2 * 86400e3).toISOString().slice(0, 10) + 'T00:00:00';
        const url = 'https://tvw.org/wp-json/wp/v2/invintus_video?per_page=80&orderby=date&order=asc&search=court'
            + `&after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}`
            + `&_fields=${encodeURIComponent('id,date,link,title.rendered,content.rendered')}`;
        const wait = 350 - (Date.now() - _lastFetch);
        if (wait > 0) await sleep(wait);
        _lastFetch = Date.now();
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        try {
            const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' }, signal: ctrl.signal });
            arr = await resp.json().catch(() => null);
        } finally { clearTimeout(t); }
        if (Array.isArray(arr)) { fs.mkdirSync(TVW_CACHE_DIR, { recursive: true }); fs.writeFileSync(cf, JSON.stringify(arr, null, 1), 'utf8'); }
    }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const v of arr) {
        const vt = (v.title && v.title.rendered) || '';
        const vcRaw = (v.content && v.content.rendered) || '';
        if (!/supreme court/i.test(vt)) continue;
        const vc = stripTags(decodeEntities(vcRaw)).split(/\bRelated Videos\b/i)[0].trim();
        if (!/oral argument/i.test(vc)) continue;
        let eid = '';
        let em = /data-eventid=["']([0-9]{8,12}[A-Z]?)["']/i.exec(vcRaw);
        if (em) eid = em[1].toUpperCase();
        if (!eid) { em = /-(\d{8,12}[A-Z]?)\/?$/.exec(String(v.link || '').replace(/[?#].*$/, '')); if (em) eid = em[1]; }
        if (!eid) continue;
        const nm = /oral arguments?:\s*(.+?)\s*(?:\(|$)/i.exec(vc);
        out.push({ eid, date: String(v.date || '').slice(0, 10), link: v.link || '', name: nm ? nm[1].trim() : vc, text: vc });
    }
    return out;
}

// Scrape one calendar date's docket sheet, import every argued case on it
// (create the missing ones, leave existing titles untouched), then match the
// session's TVW oral-argument videos to their cases — attaching each to the
// right case and deleting strays. Mutates `files`; main() runs syncWasc after.
async function datePass(dateIso, files, refetch) {
    console.log(`import_wasc ${dateIso}${DRY_RUN ? ' [dry-run]' : ''}${refetch ? ' [refetch]' : ''}`);
    const y = +dateIso.slice(0, 4);
    const ymd = dateIso.replace(/-/g, '');
    // courts.wa.gov retired the per-date HTML calendars (~2021+) for PDFs; try
    // the HTML form first (older sessions), fall back to the PDF.
    const htmlUrl = wascDocketUrl(dateIso);
    const pdfUrl = `${BASE}/appellate_trial_courts/supreme/calendar/${y}/${ymd}.pdf`;
    let text = await _fetchCalendarText(htmlUrl, refetch);
    let sheet = _isValidCalendar(text) ? parseDocketSheetCases(text, dateIso) : [];
    if (!sheet.length) {
        const pdfText = await _fetchCalendarText(pdfUrl, refetch);
        if (_isValidCalendar(pdfText)) { text = pdfText; sheet = parseDocketSheetCases(pdfText, dateIso); }
    }
    if (!text) { console.log(`  no calendar text for ${dateIso}  (${htmlUrl})`); return; }
    if (!sheet.length) { console.log(`  no cases parsed from the ${dateIso} docket sheet`); return; }
    console.log(`  ${sheet.length} case(s) on the ${dateIso} docket sheet`);

    // 1. import / reconcile each sheet case
    const session = []; // [{ docket, sheetTitle, ref }]
    for (const sc of sheet) {
        const found = findCase(files, [sc.docket]);
        if (found) {
            const c = found.case;
            let touched = false;
            if (!c.argument) { c.argument = dateIso; c.argument_day = isoToDayLabel(dateIso); touched = true; }
            if (!c.docket_url) { c.docket_url = wascDocketUrl(dateIso); touched = true; }
            if (touched) found.file.changed = true;
            console.log(`  = ${c.id}  ${c.title}  (No. ${sc.docket})${touched ? '  [dates filled]' : ''}`);
            session.push({ docket: sc.docket, sheetTitle: sc.title, ref: found });
        } else {
            const c = {
                id: null,
                title: sc.title || `[${sc.docket}]`,
                number: sc.docket,
                docket_url: wascDocketUrl(dateIso),
                argument: dateIso,
                argument_day: isoToDayLabel(dateIso),
            };
            const yf = ensureYear(files, y);
            yf.cases.push(c);
            yf.changed = true;
            console.log(`  + new case  ${c.title}  (No. ${c.number}, argued ${dateIso})`
                + (sc.title ? '' : '  [no caption parsed — needs a title]'));
            session.push({ docket: sc.docket, sheetTitle: sc.title, ref: findCase(files, [sc.docket]) });
        }
    }

    // 2. TVW videos for the session
    let videos = [];
    try { videos = await _tvwDayVideos(dateIso, refetch); }
    catch (e) { console.log(`  [tvw] day-window fetch failed: ${e.message}`); }
    console.log(`  ${videos.length} TVW oral-argument video(s) in the ${dateIso} window`);

    // "v. <party>" tail tokens, initials kept (so "State of Washington v. D.L."
    // and "... v. M.S." are still distinguishable — _alphaTokens drops both).
    const _partyTail = (s) => {
        const tail = String(s || '').toLowerCase().split(/\bv\.?\s+/).pop();
        return new Set((tail.match(/[a-z0-9]+/g) || []).filter((t) => !_TAIL_STOP.has(t)));
    };

    // score every (video, sheet-case) pair, assign greedily (1:1)
    const pairs = [];
    for (const v of videos) {
        const vtoks = new Set(_alphaTokens(`${v.name} ${v.text}`));
        const vdig = v.text.match(/\d{4,}/g) || [];
        const vtail = _partyTail(v.name);
        for (const s of session) {
            const title = `${s.ref ? s.ref.case.title : ''} ${s.sheetTitle || ''}`;
            const ctoks = _alphaTokens(title);
            const ctail = _partyTail(s.sheetTitle || (s.ref ? s.ref.case.title : ''));
            const dk = normNum(s.docket).replace(/\D/g, '');
            const dkHit = dk.length >= 5 && vdig.some((n) => n.includes(dk));
            const hit = ctoks.filter((w) => vtoks.has(w)).length;
            const frac = ctoks.length ? hit / ctoks.length : 0;
            const tailHit = [...vtail].filter((t) => ctail.has(t)).length;
            let score = 0;
            if (dkHit) score += 60;
            if (ctoks.length) score += Math.round(40 * frac);
            if (tailHit) score += 25 + 10 * tailHit;   // distinctive party (incl. initials)
            if (v.date === dateIso) score += 10;
            pairs.push({ v, s, score, hit, frac, tailHit, dkHit });
        }
    }
    // higher score first; break ties toward the stronger distinctive-party match
    pairs.sort((a, b) => b.score - a.score || b.tailHit - a.tailHit);
    const eidByDocket = new Map(), caseByEid = new Map(), takenVid = new Set();
    for (const p of pairs) {
        if (takenVid.has(p.v.eid) || eidByDocket.has(p.s.docket)) continue;
        if (p.score < 12) continue;
        if (!p.dkHit && !p.tailHit && (p.hit < 2 || p.frac < 0.55)) continue;   // weak name-only overlap
        takenVid.add(p.v.eid);
        eidByDocket.set(p.s.docket, p.v.eid);
        caseByEid.set(p.v.eid, p.s.docket);
    }

    // 3. attach each assigned video; rebuild only if bare / missing / eid changed
    for (const s of session) {
        const ref = s.ref || findCase(files, [s.docket]);
        if (!ref) continue;
        const c = ref.case;
        const eid = eidByDocket.get(s.docket);
        if (!eid) { console.log(`  · ${c.id || s.docket}  no TVW video this session`); continue; }
        c.events = c.events || [];
        const idx = c.events.findIndex((e) => e.source === 'tvw');
        const existing = idx >= 0 ? c.events[idx] : null;
        if (existing && tvwEventId(existing.page_url) === eid && (existing.video_url || existing.hls_url)) {
            console.log(`  ✓ ${c.id || s.docket}  keeps TVW ${eid}`);
            continue;
        }
        let data = null;
        try { data = await invintusEvent(eid, refetch); }
        catch (e) { console.log(`  [tvw] ${s.docket} ${eid} api error: ${e.message}`); }
        const media = data ? await tvwMediaFromEvent(data, eid) : {};
        const ev = reorderEvent({
            source: 'tvw', type: 'argument', date: dateIso,
            title: `Oral Argument on ${isoToDayLabel(dateIso)}`,
            page_url: `https://tvw.org/video/washington-state-supreme-court-${eid}/`,
            ...media,
        });
        if (idx >= 0) c.events[idx] = ev; else c.events.push(ev);
        ref.file.changed = true;
        console.log(`  ${existing ? '~' : '+'} ${c.id || s.docket}  TVW ${eid}  [${Object.keys(media).join(', ') || 'no media'}]`);
    }

    // 4. stray sweep — any case holding a session eid that was assigned elsewhere
    const sessionEids = new Set(videos.map((v) => v.eid));
    for (const f of files.values()) {
        for (const c of f.cases) {
            if (!Array.isArray(c.events)) continue;
            for (let i = c.events.length - 1; i >= 0; i--) {
                const e = c.events[i];
                if (e.source !== 'tvw') continue;
                const eid = tvwEventId(e.page_url);
                if (!eid || !sessionEids.has(eid) || !caseByEid.has(eid)) continue;
                const ownerDocket = caseByEid.get(eid);
                if (splitDockets(c.number).map(normNum).includes(normNum(ownerDocket))) continue; // correct
                c.events.splice(i, 1);
                if (!c.events.length) delete c.events;
                f.changed = true;
                const owner = findCase(files, [ownerDocket]);
                console.log(`  - stray TVW ${eid} removed from ${c.id} (belongs to ${owner ? owner.case.id || ownerDocket : ownerDocket})`);
            }
        }
    }
}

// ── --verify: data-integrity checks (report-only unless --fix) ────────────
// A place for assorted correctness sweeps over the whole dataset. For now:
//   docket_url — courts.wa.gov retired most per-date HTML calendars in favour
//     of PDFs (/calendar/YYYY/YYYYMMDD.pdf), so many stored docket_url values
//     (the "?fa=…display&…&file=…" form) now 404. This probes the stored URL
//     and, if it's dead, the PDF and HTML forms for the same session date, and
//     (with --fix) rewrites docket_url to whichever resolves — PDF preferred.
//   docket-number typos — a pair of cases whose numbers differ by exactly one
//     inserted/deleted digit is almost always one case split in two by a
//     transcription error (e.g. the WA calendar printed "976652-0" for docket
//     "97652-0", so the argued case never matched its own opinion). Report-only
//     — which digit is wrong can't be guessed safely.
// Scope with an optional YYYY. Calendar fetches reuse the --fix-titles cache.
function _isValidCalendar(text) {
    return /Case\s*No\.?\s*\d/i.test(text || '') && !/Could not find the included template/i.test(text);
}
function _docketYmd(c) {
    const fromUrl = (/[?&]file=(\d{8})\b/.exec(c.docket_url || '') || /\/(\d{8})\.pdf(?:$|[?#])/.exec(c.docket_url || '') || [])[1];
    if (fromUrl) return fromUrl;
    const iso = fullIso(c.argument) || fullIso(c.reargument);
    return iso ? iso.replace(/-/g, '') : '';
}

async function verifyPass(yearArg, doFix) {
    console.log(`import_wasc --verify${yearArg ? ' ' + yearArg : ''}${doFix ? (DRY_RUN ? ' --fix [dry-run]' : ' --fix') : ''}`);
    const files = loadAllYears();

    const st = { checked: 0, ok: 0, fixedTo: { pdf: 0, html: 0 }, broken: 0, noDate: 0 };
    for (const f of files.values()) {
        if (yearArg && f.year !== +yearArg) continue;
        for (const c of f.cases) {
            if (!c.docket_url) continue;
            st.checked++;
            const ymd = _docketYmd(c);
            // does the stored URL still resolve to a real calendar?
            let storedOk = false;
            try { storedOk = _isValidCalendar(await _fetchCalendarText(c.docket_url, false)); } catch { /* treat as dead */ }
            if (storedOk) { st.ok++; continue; }
            if (!ymd) { st.noDate++; console.log(`  [docket_url dead, no date] ${c.id}  ${c.docket_url}`); continue; }

            const yr = ymd.slice(0, 4);
            const pdfUrl  = `https://www.courts.wa.gov/appellate_trial_courts/supreme/calendar/${yr}/${ymd}.pdf`;
            const htmlUrl = `https://www.courts.wa.gov/appellate_trial_courts/supreme/calendar/?fa=atc_supreme_calendar.display&year=${yr}&file=${ymd}`;
            let replacement = '', via = '';
            try { if (_isValidCalendar(await _fetchCalendarText(pdfUrl, false)))  { replacement = pdfUrl;  via = 'pdf';  } } catch { /* try html */ }
            if (!replacement) { try { if (_isValidCalendar(await _fetchCalendarText(htmlUrl, false))) { replacement = htmlUrl; via = 'html'; } } catch { /* none */ } }

            if (!replacement) { st.broken++; console.log(`  [docket_url broken, no working source] ${c.id}  ${c.docket_url}`); continue; }
            if (replacement === c.docket_url) { st.ok++; continue; }
            st.fixedTo[via]++;
            console.log(`  ${doFix ? 'FIX ' : 'would fix '}${c.id}  docket_url:\n      - ${c.docket_url}\n      + ${replacement}`);
            if (doFix) { c.docket_url = replacement; f.changed = true; }
        }
    }
    console.log(`\n  docket_url: ${st.checked} checked, ${st.ok} ok, ${st.fixedTo.pdf + st.fixedTo.html} ${doFix ? 'fixed' : 'fixable'}`
        + ` (${st.fixedTo.pdf} -> PDF, ${st.fixedTo.html} -> HTML), ${st.broken} broken with no source, ${st.noDate} dead with no date`);

    // docket-number typos: cases whose numbers are one inserted/deleted digit
    // apart. Only the modern well-formed shape (NNNNN-C / NNNNNN-C, comma
    // stripped) — on the irregular pre-2000 / bar-matter numbers a one-char
    // difference is just zero-padding or coincidence, not a typo.
    const numbered = [];
    for (const f of files.values()) {
        if (yearArg && f.year !== +yearArg) continue;
        for (const c of f.cases) for (const n of splitDockets(c.number)) {
            const x = normNum(n);
            if (/^\d{5,6}-\d$/.test(x)) numbered.push({ c, n: x });
        }
    }
    let typoPairs = 0;
    for (let i = 0; i < numbered.length; i++) {
        for (let j = i + 1; j < numbered.length; j++) {
            if (numbered[i].n === numbered[j].n) continue;
            if (!_oneCharApart(numbered[i].n, numbered[j].n)) continue;
            typoPairs++;
            const A = numbered[i], B = numbered[j];
            console.log(`  [docket typo?] ${A.c.id} (${A.n}) "${A.c.title}"\n               ~ ${B.c.id} (${B.n}) "${B.c.title}"`);
        }
    }
    console.log(`  docket-number: ${typoPairs} suspicious one-digit-apart pair(s)`);

    if (doFix) {
        let wrote = 0;
        for (const f of files.values()) { if (!f.changed) continue; if (!DRY_RUN) writeJson(f.path, f.cases); wrote++; }
        console.log(`  ${wrote} cases.json ${DRY_RUN ? 'would be' : ''} written`);
    }
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
    const fixTitlesOnly = argv.includes('--fix-titles');
    const tvwOnly = argv.includes('--tvw');
    const verifyOnly = argv.includes('--verify');
    const noSync = argv.includes('--no-sync'); // batch: scrape only, run --sync once at the end
    const year = positional[0];
    const yearArg = /^\d{4}$/.test(year || '') ? year : '';
    const dateArg = /^\d{4}-\d{2}-\d{2}$/.test(year || '') ? year : '';

    if (justicesOnly) { await justicesPass(); return; }
    if (fixTitlesOnly) { await fixTitlesPass(argv.includes('--refetch')); return; }
    if (tvwOnly)       { await tvwPass(yearArg, argv.includes('--refetch')); return; }
    if (verifyOnly)    { await verifyPass(yearArg, argv.includes('--fix')); return; }

    if (dateArg) {
        const files = loadAllYears();
        await datePass(dateArg, files, argv.includes('--refetch'));
        if (noSync) {
            let n = 0;
            for (const f of files.values()) {
                if (!f.changed) continue;
                if (!DRY_RUN) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); writeJson(f.path, f.cases); }
                n++;
            }
            console.log(`  --no-sync: ${n} cases.json ${DRY_RUN ? 'would be' : ''} written raw; run --sync to normalise`);
        } else {
            syncWasc(files);
        }
        return;
    }

    if (!syncOnly && !/^\d{4}$/.test(year || '')) {
        console.error('Usage: node scripts/import_wasc.js YYYY  [--dry-run] [--verbose] [--no-args] [--no-sync]');
        console.error('       node scripts/import_wasc.js YYYY-MM-DD     [--dry-run] [--verbose] [--refetch] [--no-sync]');
        console.error('       node scripts/import_wasc.js --sync         [--dry-run] [--verbose]');
        console.error('       node scripts/import_wasc.js --justices     [--dry-run] [--verbose]');
        console.error('       node scripts/import_wasc.js --fix-titles   [--dry-run] [--verbose] [--refetch]');
        console.error('       node scripts/import_wasc.js --tvw [YYYY]   [--dry-run] [--verbose] [--refetch]');
        console.error('       node scripts/import_wasc.js --verify [YYYY] [--fix] [--dry-run] [--verbose]');
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
