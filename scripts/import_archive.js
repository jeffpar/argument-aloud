#!/usr/bin/env node
/**
 * Surveys the Internet Archive's "us-supreme-court" collection
 * (https://archive.org/details/us-supreme-court) for one year's items and
 * matches them against our own cases.
 *
 * Each archive.org item is a single microfiche/record bundle for one case
 * (briefs, statements as to jurisdiction, petitions, etc.), titled like:
 *
 *     Pan American World Airways, Inc. v. United States, 371 U.S. 296 (1963) (No. 23)
 *
 * with a description carrying the opinion-filed date, docket number(s) and
 * citation(s). A case often has several items (one per microfiche record).
 * Note that archive.org's "year" is the year the opinion/order was filed, so one
 * year spans two of our terms (e.g. 1963 → 1962-10 and 1963-10).
 *
 * By default this script is read-only: it lists every case of ours that
 * archive.org has items for (term folder, case id, docket, title, item URLs),
 * optionally followed by the archive.org items it couldn't match (mostly
 * cert-denied orders for cases we don't track).
 *
 * With a docket NUMBER and --add, it instead adds that one
 * unmatched case to our data: provided the year's items with that docket
 * describe exactly one case, and the term containing the decision date has no
 * case with that docket yet, it inserts a new case object into that term's
 * cases.json (in sortCases order; no "id", since such a case presumably isn't
 * in SCDB) and writes cases/<docket>/files.json with one "brief" entry per
 * document PDF in the case's archive.org item(s). Each item holds one PDF per
 * document ("<identifier> 2. Jurisdictional Statement.pdf", ...) plus
 * "<identifier>.pdf", a concatenation of them all, which is skipped unless
 * there's nothing else. If the case was decided by a per curiam printed in
 * U.S. Reports, its disposition (read from our local copy of the volume's
 * text) also sets the case's "result".
 *
 * Matching: first by U.S. Reports citation (narrowed by docket number when a
 * citation is shared, e.g. an orders-list page), then by docket number within
 * the terms that year spans (requiring the decision date or some distinctive
 * title word to agree as well). A docket match may surface an item for an
 * earlier proceeding in the same case (e.g. a per curiam before reargument).
 *
 * Usage:
 *   node scripts/import_archive.js YEAR [--unmatched [--denied]] [--json]
 *   node scripts/import_archive.js YEAR NUMBER --add [--decision YYYY-MM-DD] [--dry-run]
 *
 *   --unmatched   also list the archive.org items that matched none of our cases
 *   --denied      include every unmatched "Denied" item (cert. or rehearing denied);
 *                 without it, only those decided by a printed per curiam are listed
 *                 (see "per curiam dispositions" below), tagged with the disposition
 *   --json        print the results as JSON instead of text
 *   --add         add case NUMBER (see above)
 *   --decision    the case's decision date, which also selects its term; by
 *                 default, the "Decided" date in its per curiam's heading in our
 *                 copy of the volume, else archive.org's "Opinion filed" date
 *   --dry-run     show what --add would write without writing it
 *
 * Examples:
 *   node scripts/import_archive.js 1963
 *   node scripts/import_archive.js 1963 244 --add
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitDockets, primaryDocket, reorderCase } from './schema.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const TERMS_DIR  = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const TERMS_JSON = path.join(TERMS_DIR, 'terms.json');
const REPORTS_JSON = path.join(REPO_ROOT, 'data', 'ussc', 'reports.json');
const BENCHES_JSON = path.join(REPO_ROOT, 'courts', 'ussc', 'people', 'justices', 'benches.json');
const COLLECTION = 'us-supreme-court';
const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const DETAILS    = 'https://archive.org/details/';
const LOCAL_SITE = 'http://localhost:4010';
const METADATA   = 'https://archive.org/metadata/';
const DOWNLOAD   = 'https://archive.org/download/';
const PAGE_ROWS  = 1000;

// ── tiny helpers ───────────────────────────────────────────────────────────

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, data) => fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
const asText   = (v) => [].concat(v ?? []).join(' ');
const normCite = (s) => s.replace(/\s+/g, ' ').trim();

// Distinctive words of a case title (ignoring common party/entity words), for
// sanity-checking a docket-only match.
const COMMON_WORDS = new Set(['united', 'states', 'state', 'city', 'county', 'company', 'corp',
    'corporation', 'inc', 'railroad', 'railway', 'commission', 'board', 'national', 'american',
    'department', 'district', 'local', 'union', 'international', 'people', 'from', 'with']);
const titleWords = (s) => new Set((String(s).toLowerCase().match(/[a-z]+/g) || [])
    .filter(w => w.length > 3 && !COMMON_WORDS.has(w)));
const titlesAgree = (a, b) => { const wa = titleWords(a); return [...titleWords(b)].some(w => wa.has(w)); };

// ── archive.org ────────────────────────────────────────────────────────────

async function fetchItems(year) {
    const items = [];
    for (let page = 1; ; page++) {
        const params = new URLSearchParams({
            q: `collection:${COLLECTION} AND year:${year}`,
            rows: String(PAGE_ROWS), page: String(page), output: 'json',
        });
        for (const f of ['identifier', 'title', 'description', 'subject', 'date']) params.append('fl[]', f);
        const res = await fetch(`${SEARCH_URL}?${params}`);
        if (!res.ok) throw new Error(`archive.org search failed: HTTP ${res.status}`);
        const { response } = await res.json();
        items.push(...response.docs);
        if (!response.docs.length || items.length >= response.numFound) break;
    }
    return items.map(parseItem);
}

// Pull citations, docket numbers and the filed date out of an item's
// description (falling back to its title).
function parseItem(doc) {
    const title = asText(doc.title);
    const desc  = asText(doc.description);
    const text  = desc || title;

    const cites = [...new Set([...`${desc} ${title}`.matchAll(/\b(\d+)\s+U\.\s?S\.\s+(\d+)\b/g)]
        .map(m => `${m[1]} U.S. ${m[2]}`))];

    let dockets = [];
    const dm = desc.match(/Docket No\.:\s*(.*?)\s*(?:Related Docket Nos\.:|Citations:|$)/)
            || title.match(/\(Nos?\.\s*([^)]*)\)\s*$/);
    if (dm) {
        for (const tok of dm[1].split(/[,;&]|\band\b/).map(t => t.trim()).filter(Boolean)) {
            const r = tok.match(/^(\d+)\s*-\s*(\d+)$/);
            if (r && +r[2] > +r[1] && +r[2] - +r[1] <= 20) {
                for (let n = +r[1]; n <= +r[2]; n++) dockets.push(String(n));
            } else {
                dockets.push(tok.replace(/^No\.\s*/, ''));
            }
        }
    }
    const filed = (text.match(/Opinion filed:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const name  = ((desc.match(/Case name:\s*(.*?)\s*(?:Full case name:|Opinion filed:|Docket No\.:|Citations:|$)/) || [])[1]
        || title.replace(/\s*\(Nos?\.[^)]*\)\s*$/, '').replace(/,\s*\d+\s+U\.\s?S\.\s+\d+.*$/, '')).trim();
    return {
        identifier: doc.identifier,
        url: DETAILS + doc.identifier,
        title, name, subject: asText(doc.subject), cites, dockets, filed,
    };
}

// ── our cases ──────────────────────────────────────────────────────────────

function loadCases() {
    const all = [];
    for (const term of fs.readdirSync(TERMS_DIR).sort()) {
        const p = path.join(TERMS_DIR, term, 'cases.json');
        if (!/^\d{4}-\d{2}$/.test(term) || !fs.existsSync(p)) continue;
        for (const c of readJson(p)) all.push({ term, c, folder: primaryDocket(c.number || c.id || '') });
    }
    return all;
}

function matchItem(item, byCite, yearCases) {
    const docketHit = (e) => splitDockets(e.c.number).some(n => item.dockets.includes(n));

    let cands = [];
    for (const cite of item.cites) cands.push(...(byCite.get(cite) || []));
    cands = [...new Set(cands)];
    if (cands.length > 1 && item.dockets.length) {
        const narrowed = cands.filter(docketHit);
        if (narrowed.length) cands = narrowed;
    }
    if (cands.length) return { how: 'citation', cands };

    if (item.dockets.length) {
        // Docket numbers repeat from term to term, so when the item has a filed
        // date, only consider the latest term that began on or before it.
        let pool = yearCases;
        if (item.filed) {
            const term = yearCases.map(e => e.term).filter(t => `${t}-01` <= item.filed).sort().pop();
            pool = yearCases.filter(e => e.term === term);
        }
        cands = pool.filter(e => docketHit(e) &&
            ((item.filed && e.c.decision === item.filed) || titlesAgree(e.c.title, item.title)));
        if (cands.length) return { how: 'docket', cands };
    }
    return null;
}

// ── per curiam dispositions ────────────────────────────────────────────────
//
// archive.org marks many summary dispositions "Cert. Denied" even when they
// were appeals decided by a printed per curiam (e.g. Butler v. Dunbar, 375
// U.S. 11: "the appeal is dismissed for want of jurisdiction. Treating the
// papers ... as a petition for a writ of certiorari, certiorari is denied"),
// including outright DWSFQs ("dismissed for want of a substantial federal
// question"). Plain orders-list denials are printed in the orders section at
// the back of each volume, so an item cited to a page before that section was
// decided by a per curiam, and the volume's own text (courts/ussc/opinions/
// text/vNNN.txt) says what it was.

const TEXT_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'text');
const volKey = (vol) => `v${String(vol).padStart(3, '0')}`;

let _reports;
const volumes = new Map();

// A volume's arabic-page breakpoints from reports.json ("<reportPage>:<pdfPage>",
// optionally "*"-marked; roman front-matter breakpoints are skipped).
function breakpoints(vol) {
    _reports ??= readJson(REPORTS_JSON);
    return (_reports[volKey(vol)]?.pages || '').split(',').map(bp => bp.trim().match(/^(\d+):\s*(\d+)\s*(\*?)$/))
        .filter(Boolean).map(m => ({ start: +m[1], pdfPage: +m[2], marked: !!m[3] }));
}

// The breakpoint segment a report page falls in (the latest one starting at
// or before it, as in update_cases.js's _pdfPageFor/_isOrdersCase), whether
// that segment is an orders section (isOrdersBreakpoint: "*"-marked, or
// starting at a ×00+1 page above 800), and the page's PDF page number.
function locatePage(vol, page) {
    let seg = null;
    for (const bp of breakpoints(vol)) { if (bp.start <= page) seg = bp; else break; }
    if (!seg) return null;
    return { orders: seg.marked || (seg.start > 800 && seg.start % 100 === 1),
             pdfPage: page + seg.pdfPage - seg.start };
}

// A volume's text (pdftotext of its PDF, so one form feed per PDF page),
// with the character offset where each PDF page starts, and its case headings.
function volume(vol) {
    if (!volumes.has(vol)) {
        const p = path.join(TEXT_DIR, `${volKey(vol)}.txt`);
        const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
        const pageStarts = [0];
        for (let i = text.indexOf('\f'); i >= 0; i = text.indexOf('\f', i + 1)) pageStarts.push(i + 1);
        volumes.set(vol, { text, pageStarts, heads: text ? headings(text) : [] });
    }
    return volumes.get(vol);
}

// Case headings look like "No. 244.     Decided October 14, 1963." (or
// "Nos. 450 and 451. ...", "No. 647, Misc. ..."), though the date is often
// OCR'd loosely (",January 14, 1963", ".Tune 10, 1()63", "March 18,1963"), and
// a consolidated case's heading ends in a footnote "*" ("Together with No.
// 451, ...") in place of the year.
const HEADING_RE = /\bNos?\.\s+((?:\d+(?:,\s*(?:Misc|Orig)\.)?(?:\s*,\s*|\s+and\s+)?)+?)\s*\.?\s+Decided\s+[.,]?([A-Za-z]+)\s*(\d{1,2})\s*,\s*(\d{4})?/g;
const monthNum = (w) => {
    const i = MONTHS.findIndex(m => m.slice(0, 3) === w.replace(/^T/, 'J').slice(0, 3));
    return i >= 0 ? String(i + 1).padStart(2, '0') : '';
};

// Classify a per curiam's opening text, returning a short label and (when it
// maps to one) a result string in our cases.json convention.
function classify(text) {
    const t = text.toLowerCase();
    const NOT_FAVORABLE = 'no favorable disposition for petitioning party apparent';
    const FAVORABLE = 'petitioning party received a favorable disposition';
    if (/substantial federal question/.test(t)) {
        return { label: 'DWSFQ', result: `dismissed for want of a substantial federal question; ${NOT_FAVORABLE}` };
    }
    if (/appeals? (?:is |are )?dismissed|motion to dismiss is granted/.test(t)) {
        const juris = /want of jurisdiction/.test(t) ? ' for want of jurisdiction' : '';
        const cert = /certiorari (?:is |are )?denied/.test(t);
        return { label: `appeal dismissed${juris}${cert ? '; cert denied' : ''}`,
                 result: `dismissed${juris}${cert ? ' and certiorari denied' : ''}; ${NOT_FAVORABLE}` };
    }
    if (/\baffirmed\b/.test(t)) return { label: 'affirmed', result: `affirmed; ${NOT_FAVORABLE}` };
    if (/\breversed\b/.test(t)) {
        const r = /remanded/.test(t) ? 'reversed and remanded' : 'reversed';
        return { label: r, result: `${r}; ${FAVORABLE}` };
    }
    if (/\bvacated\b/.test(t)) {
        const r = /remanded/.test(t) ? 'vacated and remanded' : 'vacated';
        return { label: r, result: `${r}; ${FAVORABLE}` };
    }
    if (/certiorari (?:is |are )?denied/.test(t)) return { label: 'cert denied' };
    return { label: text.slice(0, 60) };
}

// For an item cited to the opinions section of its volume, find its heading
// in the volume's text (by docket number, preferring the item's filed date
// when the same number appears more than once) and classify its per curiam.
// Returns null for an item cited to the orders section (or with no citation).
function headings(text) {
    return [...text.matchAll(HEADING_RE)].map((h, i, all) => {
        const body = text.slice(h.index + h[0].length, all[i + 1]?.index ?? h.index + 4000);
        const nums = [...h[1].matchAll(/(\d+)(,\s*(?:Misc|Orig)\.)?/g)].filter(n => !n[2]).map(n => n[1]);
        const also = body.match(/Together with Nos?\.\s*((?:\d+(?:\s*,\s*|\s+and\s+)?)+)/);
        if (also) nums.push(...also[1].match(/\d+/g));
        return { index: h.index, nums, monthDay: `${monthNum(h[2])}-${h[3].padStart(2, '0')}`,
                 date: h[4] && monthNum(h[2]) ? `${h[4]}-${monthNum(h[2])}-${h[3].padStart(2, '0')}` : '', body };
    });
}

function perCuriam(item) {
    const m = (item.cites[0] || '').match(/^(\d+) U\.S\. (\d+)$/);
    const loc = m && locatePage(+m[1], +m[2]);
    if (!loc || loc.orders) return null;
    const out = { cite: item.cites[0] };
    const { text, pageStarts, heads } = volume(+m[1]);
    if (!text) return out;

    // Prefer a heading on the cited page itself (reports.json maps it to its
    // PDF page, i.e. its form-feed-delimited page of text), then one a page
    // either side; failing that, one anywhere in the volume decided on the
    // item's filed date (or its month and day, when the year's OCR is
    // garbled), else the volume's only heading with that docket.
    const hits = heads.filter(h => h.nums.some(n => item.dockets.includes(n)));
    const onPages = (from, to) => hits.find(h =>
        h.index >= (pageStarts[from - 1] ?? Infinity) && h.index < (pageStarts[to] ?? text.length));
    const head = onPages(loc.pdfPage, loc.pdfPage)
        || onPages(loc.pdfPage - 1, loc.pdfPage + 1)
        || hits.find(h => h.date && h.date === item.filed)
        || hits.find(h => !h.date && item.filed.endsWith(h.monthDay))
        || (hits.length === 1 ? hits[0] : null);
    if (!head) return out;

    // The first paragraph of the per curiam itself (its "PER CURIAM." line
    // stands alone, unlike the "371 U.S.   Per Curiam." running page headers,
    // and is often OCR'd oddly, e.g. "PER CuRIAM."), else the summary line(s)
    // right after the heading (e.g. "Appeal dismissed and certiorari denied.").
    const paras = (s) => s.replace(/^[\s.]+/, '').split(/\n\s*\n/).slice(0, 3)
        .map(p => p.replace(/-\n\s*/g, '').replace(/\s+/g, ' ').trim().slice(0, 1000));
    const pc = head.body.match(/^[ \t]*Per\s+Cu\s*riam\s*\.[ \t]*$/im);
    // Classify the first paragraph that says what happened (the opening one
    // is sometimes procedural, e.g. a motion to substitute a party).
    const candidates = [...(pc ? paras(head.body.slice(pc.index + pc[0].length)) : []), paras(head.body)[0]];
    const pcText = candidates.find(t => classify(t).result) || candidates[0];
    const c = classify(pcText);
    return { ...out, decided: head.date, text: pcText, ...c };
}

// ── --add ──────────────────────────────────────────────────────────────────

const DAYS   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

// Same format as update_cases.js's _formatDay, e.g. "Monday, October 14, 1963".
function formatDay(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return `${DAYS[dt.getUTCDay()]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

// Same ordering as update_cases.js's sortCases: argued cases by last argument
// date, then unargued cases by decision date, then by first docket number.
function sortKey(c) {
    const args = [c.argument, c.reargument].filter(Boolean).join(',').split(',').filter(Boolean).sort();
    const last = args.pop() || '';
    const parts = primaryDocket(c.number).split('-');
    return [last ? '0' : '1', last || c.decision || '2199-12-31', parseInt(parts[parts.length - 1], 10) || 0];
}
function cmpKeys(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return -1;
        if (a[i] > b[i]) return 1;
    }
    return 0;
}

// One "brief" files.json entry per numbered document PDF in an item, e.g.
// "micro_IA40385001_0377 3. Motion to  Dismiss .pdf" -> "Motion to Dismiss".
async function fetchBriefs(item) {
    const res = await fetch(METADATA + item.identifier);
    if (!res.ok) throw new Error(`archive.org metadata for ${item.identifier} failed: HTTP ${res.status}`);
    const pdfs = ((await res.json()).files || []).filter(f => /\.pdf$/i.test(f.name));
    const href = (name) => `${DOWNLOAD}${item.identifier}/${encodeURIComponent(name)}`;
    const prefix = `${item.identifier} `;
    const docs = [];
    for (const f of pdfs) {
        if (!f.name.startsWith(prefix)) continue;
        const m = f.name.slice(prefix.length).match(/^(\d+)\.\s*(.*?)\s*\.pdf$/i);
        if (!m) continue;
        docs.push({ seq: +m[1], entry: { type: 'brief', title: m[2].replace(/\s+/g, ' '), href: href(f.name) } });
    }
    docs.sort((a, b) => a.seq - b.seq);
    if (!docs.length) {
        const whole = pdfs.find(f => f.name === `${item.identifier}.pdf`);
        if (whole) docs.push({ entry: { type: 'brief', title: 'Briefs', href: href(whole.name) } });
    }
    return docs.map(d => d.entry);
}

async function addCase(items, number, decisionArg, dryRun) {
    // The year's items for this docket must all describe one case.
    let hits = items.filter(it => it.dockets.includes(number));
    const distinct = (list) => [...new Set(list.map(it => it.name))];
    if (distinct(hits).length > 1 && decisionArg) {
        const sameDay = hits.filter(it => it.filed === decisionArg);
        if (distinct(sameDay).length === 1) hits = sameDay;
    }
    if (!hits.length) throw new Error(`No archive.org items for docket ${number}`);
    if (distinct(hits).length > 1) {
        throw new Error(`Docket ${number} matches more than one archive.org case:\n` +
            hits.map(it => `    ${it.url}  ${it.title}`).join('\n') +
            (decisionArg ? '' : '\nPass --decision YYYY-MM-DD to pick the one filed that day.'));
    }
    const item = hits[0];

    // The decision date: --decision if given, else the "Decided" date in the
    // per curiam's heading in our copy of the volume, else archive.org's own
    // "Opinion filed" date.
    const pc = perCuriam(item);
    const decision = decisionArg || pc?.decided || item.filed;
    if (!decision) throw new Error(`No decision date found for docket ${number}; pass --decision YYYY-MM-DD`);
    for (const it of hits) {
        if (it.filed && it.filed !== decision) console.warn(`Warning: ${it.url} says opinion filed ${it.filed}, not ${decision}`);
    }
    if (pc?.decided && pc.decided !== decision) console.warn(`Warning: ${pc.cite} says decided ${pc.decided}, not ${decision}`);

    // The term containing the decision date: the latest one that began on or before it.
    const termEntries = readJson(TERMS_JSON).flatMap(g => g.groups || []);
    const termEntry = termEntries.filter(t => `${t.id}-01` <= decision)
        .sort((a, b) => a.id.localeCompare(b.id)).pop();
    if (!termEntry) throw new Error(`No term found for decision date ${decision}`);
    const term = termEntry.id;
    const termDir = path.join(TERMS_DIR, term);
    const casesPath = path.join(termDir, 'cases.json');
    const cases = fs.existsSync(casesPath) ? readJson(casesPath) : [];

    const dockets = [...new Set(hits.flatMap(it => it.dockets))];
    const dockets0 = [number, ...dockets.filter(n => n !== number)];
    const existing = cases.find(c => splitDockets(c.number).some(n => dockets0.includes(n)));
    if (existing) {
        throw new Error(`${term} already has docket ${dockets0.join(", ")}: ${existing.id || existing.number} ${existing.title}`);
    }
    const folder = path.join(termDir, 'cases', number);
    if (fs.existsSync(folder)) throw new Error(`${path.relative(REPO_ROOT, folder)} already exists`);

    const briefs = [];
    for (const it of hits) briefs.push(...await fetchBriefs(it));
    if (!briefs.length) throw new Error(`No PDFs found in ${hits.map(it => it.url).join(', ')}`);

    const c = { title: item.name, number: dockets0.join(';'), files: true, references: false,
        decision, decision_day: formatDay(decision) };
    const citation = item.cites[0];
    if (citation) {
        c.citation = citation;
        const vol = +citation.split(' ')[0];
        const href = (termEntry.reports || []).find(r => +r.volume === vol)?.href
            || readJson(REPORTS_JSON)[`v${String(vol).padStart(3, '0')}`]?.href;
        if (href) c.decision_vol = href;
    }
    const bench = readJson(BENCHES_JSON).find(b => b.dateStart <= decision && decision <= b.dateStop);
    if (bench) c.bench = bench.id;
    if (pc?.text) {
        if (pc.result) c.result = pc.result;
        else console.warn(`Warning: couldn't map that disposition to a result; none set`);
    } else if (pc) {
        console.warn(`Warning: couldn't find ${pc.cite}'s per curiam in ${volKey(pc.cite.split(' ')[0])}.txt; no result set`);
    }
    const newCase = reorderCase(c);

    const key = sortKey(newCase);
    let at = cases.findIndex(x => cmpKeys(sortKey(x), key) > 0);
    if (at < 0) at = cases.length;
    cases.splice(at, 0, newCase);

    if (!dryRun) {
        writeJson(casesPath, cases);
        fs.mkdirSync(folder, { recursive: true });
        writeJson(path.join(folder, 'files.json'), briefs);
    }

    // One summary line in the listing's layout, then the new case's local URL
    // and its archive.org item(s), for comparing the two.
    const plural = briefs.length === 1 ? '' : 's';
    console.log(`${term}  ${number.padEnd(8)} ${newCase.title}` +
        (newCase.citation ? `, ${newCase.citation}` : '') + `, decided ${decision}` +
        `, ${briefs.length} file${plural} ${dryRun ? 'would be added' : 'added'}` +
        (pc?.label ? `  [per curiam: ${pc.label}]` : ''));
    console.log(`    ${LOCAL_SITE}/courts/ussc/?term=${term}&case=${encodeURIComponent(number)}`);
    for (const it of hits) console.log(`    ${it.url}`);
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    const decision = opt('--decision');
    const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--decision');
    const [year, number] = positional;
    const adding = args.includes('--add');
    if (!/^\d{4}$/.test(year || '') || (adding && !number) || (decision && !/^\d{4}-\d{2}-\d{2}$/.test(decision))) {
        console.error('Usage: node scripts/import_archive.js YEAR [--unmatched [--denied]] [--json]\n' +
                      '       node scripts/import_archive.js YEAR NUMBER --add [--decision YYYY-MM-DD] [--dry-run]');
        process.exit(1);
    }
    if (adding) {
        await addCase(await fetchItems(year), number, decision, args.includes('--dry-run'));
        return;
    }
    const showUnmatched = args.includes('--unmatched');
    const showDenied = args.includes('--denied');
    const asJson = args.includes('--json');

    const cases = loadCases();
    const byCite = new Map();
    for (const e of cases) {
        if (!e.c.citation) continue;
        const k = normCite(e.c.citation);
        if (!byCite.has(k)) byCite.set(k, []);
        byCite.get(k).push(e);
    }
    // Terms whose opinions could be filed during YEAR: those starting in YEAR-1 or YEAR.
    const yearCases = cases.filter(e => [String(year - 1), year].includes(e.term.slice(0, 4)));

    const items = await fetchItems(year);
    const matched = new Map();      // "term/id" -> { term, id, folder, number, title, how, items[] }
    const unmatched = [];
    for (const item of items) {
        const m = matchItem(item, byCite, yearCases);
        if (!m) { unmatched.push(item); continue; }
        for (const e of m.cands) {
            const key = `${e.term}/${e.c.id || e.folder}`;
            if (!matched.has(key)) {
                matched.set(key, { term: e.term, id: e.c.id || '', folder: e.folder,
                    number: e.c.number || '', title: e.c.title, how: m.how, items: [] });
            }
            matched.get(key).items.push({ identifier: item.identifier, url: item.url, title: item.title, subject: item.subject });
        }
    }
    const results = [...matched.values()].sort((a, b) =>
        a.term.localeCompare(b.term) || a.folder.localeCompare(b.folder, undefined, { numeric: true }));

    // Unless --denied, leave cert./rehearing-denied items out of the unmatched
    // listing, except those actually decided by a printed per curiam.
    for (const it of unmatched) it.perCuriam = perCuriam(it);
    const listed = showDenied ? unmatched
        : unmatched.filter(it => !/\bDenied\b/i.test(it.subject) || it.perCuriam);

    if (asJson) {
        const out = { year: +year, items: items.length, cases: results };
        if (showUnmatched) out.unmatched = listed;
        console.log(JSON.stringify(out, null, 2));
        return;
    }

    console.log(`archive.org ${COLLECTION}, year ${year}: ${items.length} items, ` +
        `${items.length - unmatched.length} matched to ${results.length} of our cases, ${unmatched.length} unmatched\n`);
    for (const r of results) {
        console.log(`${r.term}  ${r.folder.padEnd(8)} ${r.id.padEnd(10)} ${r.title}` + (r.how === 'docket' ? '  [by docket]' : ''));
        for (const it of r.items) console.log(`    ${it.url}${it.subject ? `  (${it.subject})` : ''}`);
    }
    if (showUnmatched && listed.length) {
        // Same layout as the matched cases, with dashes for our term and case id
        // (the docket column shows archive.org's own docket number), grouping
        // items that share a title.
        const groups = new Map();
        for (const it of listed) {
            if (!groups.has(it.title)) groups.set(it.title, []);
            groups.get(it.title).push(it);
        }
        const hidden = unmatched.length - listed.length;
        console.log(`\nUnmatched archive.org items (${listed.length}` +
            (hidden ? `; ${hidden} orders-list "Denied" items omitted, use --denied to include them` : '') + '):\n');
        for (const [title, its] of groups) {
            console.log(`${'-'.repeat(7)}  ${(its[0].dockets.join(';') || '-').padEnd(8)} ${'-'.repeat(10)} ${title}`);
            for (const it of its) {
                const pc = it.perCuriam;
                const tag = pc ? `  [per curiam${pc.label ? `: ${pc.label}` : ''}]` : '';
                console.log(`    ${it.url}${it.subject ? `  (${it.subject})` : ''}${tag}`);
            }
        }
    }
}

main().catch(err => { console.error(err.message); process.exit(1); });
