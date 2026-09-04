#!/usr/bin/env node
/**
 * Imports "Curiae" landmark-case tags from the Yale Law School curiae.law.yale.edu
 * case-ranking pages (now only reachable via the Internet Archive).
 *
 * The ranking page scores every case by how many of 15 canonical
 * constitutional-law reference works cite it. Each row lists a case (title +
 * "N U.S. P" citation + year) followed by 15 columns, one per work; a column is
 * filled iff that work cites the case. This script parses those rows and, for
 * every case it can match to a local cases.json entry by citation, adds one tag
 * per citing work:
 *
 *     Biskupic and Witt, The Supreme Court at Work        -> "Curiae: Biskupic & Witt"
 *     Currie, The Constitution in the Supreme Court        -> "Curiae: Currie"
 *     Lewis, Encyclopedia of the ... Supreme Court         -> "Curiae: Lewis"
 *     Farber et al, Cases and Materials on Const. Law      -> "Curiae: Farber"
 *     Fisher, American Constitutional Law                  -> "Curiae: Fisher"
 *     Gunther, Constitutional Law                          -> "Curiae: Gunther"
 *     Lockhart, Constitutional Law                         -> "Curiae: Lockhart"
 *     Nowak and Rotunda, Constitutional Law               -> "Curiae: Nowak & Rotunda"
 *     The Oxford Guide to ... Supreme Court Decisions      -> "Curiae: Oxford Guide"
 *     Rehnquist, The Supreme Court                         -> "Curiae: Rehnquist"
 *     Schwartz, A History of the Supreme Court             -> "Curiae: Schwartz"
 *     Stone et al, Constitutional Law                      -> "Curiae: Stone"
 *     Tribe, American Constitutional Law, V. 1             -> "Curiae: Tribe"
 *     Landmark Briefs and Arguments of the Supreme Court   -> "Curiae: Landmark Briefs"
 *     Legal Information Institute                          -> "Curiae: LII"
 *
 * Tags are written straight into courts/ussc/terms/YYYY-MM/cases.json (keys
 * reordered via reorderCase). Existing tags are preserved; only missing ones
 * are added. Citations with no local match are listed at the end so they can be
 * handled by hand.
 *
 * Usage:
 *   node scripts/import_curiae.js <url-or-html-file> [more ...] [--dry-run] [--save DIR]
 *
 * Examples:
 *   node scripts/import_curiae.js "https://web.archive.org/web/20051210070533/http://curiae.law.yale.edu/ranking/?bsize=50"
 *   node scripts/import_curiae.js page1.html page2.html --dry-run
 *   node scripts/import_curiae.js "<url>" --save sources/curiae
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reorderCase, splitDockets } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TERMS_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');

// Exact <img alt="..."> text on the ranking page -> tag written to the case.
// Keyed by the alt text so that a future page introducing a new work fails
// loudly (see UNKNOWN handling) rather than being silently dropped.
const WORK_TAGS = {
    'Biskupic and Witt, The Supreme Court at Work':              'Curiae: Biskupic & Witt',
    'Currie, The Constitution in the Supreme Court':             'Curiae: Currie',
    'Lewis, Encyclopedia of the United States Supreme Court':    'Curiae: Lewis',
    'Farber et al, Cases and Materials on Constitutional Law':   'Curiae: Farber',
    'Fisher, American Constitutional Law':                       'Curiae: Fisher',
    'Gunther, Constitutional Law':                               'Curiae: Gunther',
    'Lockhart, Constitutional Law':                              'Curiae: Lockhart',
    'Nowak and Rotunda, Constitutional Law':                     'Curiae: Nowak & Rotunda',
    'The Oxford Guide to United States Supreme Court Decisions': 'Curiae: Oxford Guide',
    'Rehnquist, The Supreme Court':                              'Curiae: Rehnquist',
    'Schwartz, A History of the Supreme Court':                  'Curiae: Schwartz',
    'Stone et al, Constitutional Law':                           'Curiae: Stone',
    'Tribe, American Constitutional Law, V. 1':                  'Curiae: Tribe',
    'Landmark Briefs and Arguments of the Supreme Court':        'Curiae: Landmark Briefs',
    'Legal Information Institute':                               'Curiae: LII',
};

// ── tiny helpers ───────────────────────────────────────────────────────────

const readJson  = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const relRepo   = (p) => { const r = path.relative(REPO_ROOT, p); return r.startsWith('..') ? p : r; };

function decodeEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#0?39;/g, "'")
        .replace(/&#0?38;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

// "381 U. S. 479", "381+U.S.+479" -> "381 U.S. 479" (the cases.json form).
function normCitation(raw) {
    return decodeEntities(String(raw).replace(/\+/g, ' '))
        .replace(/U\.\s*S\./gi, 'U.S.')
        .replace(/\s+/g, ' ')
        .trim();
}

async function loadHtml(src) {
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        return { html: fs.readFileSync(src, 'utf8'), label: relRepo(path.resolve(src)) };
    }
    if (!/^https?:\/\//i.test(src)) {
        throw new Error(`not a URL and not an existing file: ${src}`);
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    try {
        const resp = await fetch(src, {
            headers: { 'User-Agent': 'import_curiae/1.0 (argument-aloud)' },
            redirect: 'follow',
            signal: ctrl.signal,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${src}`);
        return { html: await resp.text(), label: src };
    } finally {
        clearTimeout(t);
    }
}

// ── page parsing ───────────────────────────────────────────────────────────

// Returns [{ citation, title, year, statedCount, statedTotal, works: [alt,...],
//            tags: [tag,...], unknownWorks: [alt,...] }]
function parseRanking(html) {
    const records = [];
    // Each case is one <tr>. Split on the tag open so a chunk holds exactly one row.
    const chunks = html.split(/<tr\b[^>]*>/i);
    for (const raw of chunks) {
        const m = raw.match(/casecitation=([^"&]+)"[^>]*>([^<]*)<\/a>/i);
        if (!m) continue;
        const seg = raw.slice(0, (raw.indexOf('</tr>') + 1) || undefined);

        // The casecitation= query param is the volume's *report-entry* page,
        // which for early volumes differs from the opinion's own page shown in
        // the link text ("Calder v. Bull, 3 U.S. 386" vs. casecitation=3+U.S.+385).
        // Our cases.json uses the opinion page, so prefer the displayed one and
        // keep the param as a fallback.
        const citationAlt = normCitation(m[1]);
        const label = decodeEntities(m[2]);
        // label looks like "Griswold v. Connecticut, 381 U.S. 479 (1965)"
        const yearM = label.match(/\((\d{4})\)\s*$/);
        const year = yearM ? Number(yearM[1]) : null;
        const dispM = label.match(/,\s*(\d+\s+U\.?\s*S\.?\s+\d+)\s*(?:\(\d{4}\))?\s*$/i);
        const citation = dispM ? normCitation(dispM[1]) : citationAlt;
        let title = label.replace(/\s*\(\d{4}\)\s*$/, '').trim();
        // strip the trailing ", <citation>" the page appends to the title
        for (const cit of [citation, citationAlt]) {
            const citEsc = cit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            title = title.replace(new RegExp(`,?\\s*${citEsc}\\s*$`), '').trim();
        }

        // "13 of 15" (denominator varies — some works don't span all cases)
        const cntM = seg.match(/(\d+)\s*of\s*(\d+)/i);
        const statedCount = cntM ? Number(cntM[1]) : null;
        const statedTotal = cntM ? Number(cntM[2]) : null;

        const works = [...seg.matchAll(/<img\b[^>]*\balt="([^"]+)"/gi)].map(x => decodeEntities(x[1]));
        const tags = [];
        const unknownWorks = [];
        for (const w of works) {
            if (WORK_TAGS[w]) tags.push(WORK_TAGS[w]);
            else if (!/^(blank|zope logo|.*logo)$/i.test(w)) unknownWorks.push(w);
        }
        records.push({ citation, citationAlt, title, year, statedCount, statedTotal, works, tags, unknownWorks });
    }
    return records;
}

// ── case index ─────────────────────────────────────────────────────────────

// citation string -> [{ term, ref }]  (ref = case id, falling back to number)
function buildCitationIndex() {
    const index = new Map();
    if (!fs.existsSync(TERMS_DIR)) return index;
    for (const term of fs.readdirSync(TERMS_DIR).sort()) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = readJson(casesPath); } catch { continue; }
        if (!Array.isArray(cases)) continue;
        for (const c of cases) {
            if (!c || !c.citation) continue;
            const key = normCitation(c.citation);
            const ref = c.id || c.number;
            if (!ref) continue;
            if (!index.has(key)) index.set(key, []);
            index.get(key).push({ term, ref, title: c.title || '' });
        }
    }
    return index;
}

// Meaningful title tokens, for tie-breaking a citation that matches more than
// one local case (early volumes reuse a page number across opinions).
const TITLE_STOPWORDS = new Set([
    'v', 'vs', 'the', 'of', 'a', 'an', 'and', 'in', 're', 'ex', 'parte', 'rel',
    'et', 'al', 'co', 'inc', 'corp', 'llc', 'ltd', 'company', 'appeal', 'case',
    'cases', 'i', 'ii', 'iii',
]);
function titleTokens(s) {
    return new Set(
        decodeEntities(s).toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w && !TITLE_STOPWORDS.has(w))
    );
}
// Given the page's case title and every local case sharing its citation,
// return the subset whose titles clearly correspond. Falls back to all hits
// when nothing stands out (caller then tags all + warns).
function resolveHits(pageTitle, hits) {
    if (hits.length <= 1) return hits;
    const want = titleTokens(pageTitle);
    if (!want.size) return hits;
    const scored = hits.map(h => {
        const have = titleTokens(h.title);
        let overlap = 0;
        for (const w of want) if (have.has(w)) overlap++;
        return { h, overlap };
    });
    const best = Math.max(...scored.map(s => s.overlap));
    if (best === 0) return hits;
    const winners = scored.filter(s => s.overlap === best).map(s => s.h);
    // Only trust the tie-break when it actually narrows things down.
    return winners.length < hits.length ? winners : hits;
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');
    let saveDir = null;
    const sources = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') continue;
        if (a === '--save') { saveDir = argv[++i]; continue; }
        sources.push(a);
    }
    if (!sources.length) {
        console.error('Usage: node scripts/import_curiae.js <url-or-html-file> [more ...] [--dry-run] [--save DIR]');
        process.exit(1);
    }

    // Parse every page, merging per-citation tag sets (a case can appear across
    // pages — dedupe on the way in).
    const byCitation = new Map(); // citation -> { title, year, tags:Set, seenOn:Set }
    const unknownWorks = new Set();
    let mismatchWarnings = 0;

    for (const src of sources) {
        let html, label;
        try {
            ({ html, label } = await loadHtml(src));
        } catch (err) {
            console.error(`ERROR: could not load ${src}: ${err.message}`);
            process.exitCode = 1;
            continue;
        }
        if (saveDir) {
            fs.mkdirSync(saveDir, { recursive: true });
            const fname = `curiae-${new Date().toISOString().replace(/[:.]/g, '-')}-${sources.indexOf(src) + 1}.html`;
            const out = path.join(saveDir, fname);
            if (!dryRun) fs.writeFileSync(out, html);
            console.log(`${dryRun ? '[dry-run] would save' : 'saved'} ${relRepo(path.resolve(out))}`);
        }

        const records = parseRanking(html);
        console.log(`${label}: ${records.length} case row(s)`);
        for (const r of records) {
            for (const w of r.unknownWorks) unknownWorks.add(w);
            if (r.statedCount != null && r.statedCount !== r.tags.length) {
                console.log(`  ! ${r.citation} (${r.title}): page says ${r.statedCount}` +
                    `${r.statedTotal ? '/' + r.statedTotal : ''} works, parsed ${r.tags.length}`);
                mismatchWarnings++;
            }
            if (!r.tags.length) continue;
            let entry = byCitation.get(r.citation);
            if (!entry) {
                entry = { title: r.title, year: r.year, citationAlt: r.citationAlt, tags: new Set(), seenOn: new Set() };
                byCitation.set(r.citation, entry);
            }
            for (const t of r.tags) entry.tags.add(t);
            entry.seenOn.add(label);
        }
    }

    if (unknownWorks.size) {
        console.error('\nERROR: unrecognized reference work(s) on the page — add them to WORK_TAGS:');
        for (const w of unknownWorks) console.error(`  "${w}"`);
        console.error('Aborting without writing.');
        process.exit(1);
    }
    if (!byCitation.size) {
        console.log('\nNothing to do — no taggable case rows found.');
        return;
    }

    // Match citations to local cases and group the work by term.
    const index = buildCitationIndex();
    const perTerm = new Map(); // term -> Map(ref -> Set(tags))
    const unmatched = [];
    const ambiguous = [];

    for (const [citation, entry] of byCitation) {
        const allHits = index.get(citation) ||
            (entry.citationAlt && entry.citationAlt !== citation ? index.get(entry.citationAlt) : null);
        if (!allHits || !allHits.length) {
            unmatched.push({ citation, title: entry.title, year: entry.year });
            continue;
        }
        const hits = resolveHits(entry.title, allHits);
        if (hits.length > 1) {
            ambiguous.push({ citation, title: entry.title, hits: hits.map(h => `${h.term}/${h.ref} (${h.title})`) });
        }
        for (const { term, ref } of hits) {
            if (!perTerm.has(term)) perTerm.set(term, new Map());
            const refMap = perTerm.get(term);
            if (!refMap.has(ref)) refMap.set(ref, new Set());
            const s = refMap.get(ref);
            for (const t of entry.tags) s.add(t);
        }
    }

    if (ambiguous.length) {
        console.log(`\n${ambiguous.length} citation(s) match more than one local case — tagging all:`);
        for (const a of ambiguous) console.log(`  ${a.citation} (${a.title}) -> ${a.hits.join(', ')}`);
    }

    // Apply, one cases.json per term.
    let totalCases = 0, totalTags = 0;
    for (const [term, refMap] of [...perTerm].sort(([a], [b]) => a.localeCompare(b))) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        let cases;
        try { cases = readJson(casesPath); }
        catch { console.log(`  WARNING: could not read ${relRepo(casesPath)} — skipping`); continue; }
        if (!Array.isArray(cases)) continue;

        let modified = false;
        for (const [ref, tagSet] of refMap) {
            const c = cases.find(x => x && (x.id === ref || splitDockets(x.number).includes(ref)));
            if (!c) { console.log(`  WARNING: ${term}: case "${ref}" not found`); continue; }

            const existing = Array.isArray(c.tags) ? c.tags : [];
            const toAdd = [...tagSet].filter(t => !existing.includes(t)).sort();
            if (!toAdd.length) continue;

            console.log(`  ${term}/${c.number || c.id}  ${c.title}`);
            console.log(`      +${toAdd.join(', ')}`);
            c.tags = [...existing, ...toAdd];
            const reordered = reorderCase(c);
            for (const k of Object.keys(c)) delete c[k];
            Object.assign(c, reordered);
            modified = true;
            totalCases++;
            totalTags += toAdd.length;
        }

        if (modified && !dryRun) {
            fs.writeFileSync(casesPath, JSON.stringify(cases, null, 2) + '\n', 'utf8');
        }
    }

    // Report.
    console.log('\n──────────────────────────────────────────────');
    console.log(`${dryRun ? 'Would add' : 'Added'} ${totalTags} tag(s) across ${totalCases} case(s).`);
    if (mismatchWarnings) console.log(`${mismatchWarnings} row(s) had a work-count mismatch (see "!" lines above).`);
    if (unmatched.length) {
        console.log(`\n${unmatched.length} citation(s) with no local case (handle by hand):`);
        for (const u of unmatched.sort((a, b) => (a.year || 0) - (b.year || 0))) {
            console.log(`  ${u.citation.padEnd(14)} ${u.title}${u.year ? ` (${u.year})` : ''}`);
        }
    }
    if (dryRun) console.log('\n[dry-run] no files written.');
}

main().catch(err => { console.error(err); process.exit(1); });
