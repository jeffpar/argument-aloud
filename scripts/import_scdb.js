#!/usr/bin/env node
/**
 * import_scdb.js
 *
 * Pulls a deliberately narrow slice of SCDB data (sources/scdb/cache/scdb.json,
 * as refreshed by scripts/ingest_scdb.js) into courts/ussc/terms/*\/cases.json.
 *
 * This is NOT the full SCDB reconciliation that `update_cases.js --scdb` does —
 * it is the conservative version that never overwrites a hand-correction:
 *
 *   PART 1  (writes, every term EXCEPT the report term)
 *     The ONLY field it touches is a case's `number`. When the matched SCDB
 *     record's `docket` lists docket number(s) our `number` doesn't already
 *     carry, those extra numbers are appended (in SCDB's order, normalized to
 *     our "N-Orig"/"N-Misc" house style via scdbNormalizeDocket). Nothing is
 *     ever removed or reordered, and a case whose `number` is empty is reported
 *     rather than filled. If an extra docket already belongs to a different
 *     case in the same term, it is skipped and flagged (never duplicated).
 *
 *   PART 2  (report only, the report term — 2025-10 by default)
 *     Writes nothing. For every case that matches an SCDB record it prints a
 *     field-by-field diff of our case object against what the standard SCDB
 *     import would produce (title, number, argument, reargument, decision,
 *     score, citation, decision_loc, votes — the fields
 *     update_cases.js's _scdbBuildCaseFromSources emits, minus the
 *     data/ussc/citations.csv + dates.csv title/date enrichment, which this
 *     script intentionally does not consult). It also lists SCDB records in
 *     that term with no case of ours, and our cases with no SCDB match.
 *
 * Case ↔ SCDB matching: by `c.id` when present, otherwise by docket number
 * within the same term year (an ambiguous docket → no match).
 *
 * Usage:
 *   node scripts/import_scdb.js [--dry-run] [--report-term YYYY-MM] [TERM]
 *
 *   --dry-run            Do Part 1's matching and print what it would change,
 *                        but write no files.
 *   --report-term Y-M    Term handled as report-only (default 2025-10).
 *   TERM (positional)    Restrict Part 1 to this one term (still skips the
 *                        report term). Useful for spot checks.
 *
 * A copy of everything printed is also written to
 * sources/scdb/cache/import_scdb_report.md.
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitDockets } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SCDB_JSON    = path.join(REPO_ROOT, 'sources', 'scdb', 'cache', 'scdb.json');
const JUSTICES_JSON = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');
const TERMS_DIR    = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const REPORT_PATH  = path.join(REPO_ROOT, 'sources', 'scdb', 'cache', 'import_scdb_report.md');

const DEFAULT_REPORT_TERM = '2025-10';

// SCDB's "modern" era. Part 1's docket data comes from ingest_scdb.js's
// aggregation, which only rebuilds the modern half of scdb.json; legacy
// (pre-1946) docket values are messy hand-entered strings ("261 and 262",
// stray extra numbers) that must not be merged in, so Part 1 skips them.
const MODERN_MIN_YEAR = 1946;

// ── ported SCDB→case helpers (mirror scripts/update_cases.js) ─────────────────

const US_CITE_RE = /^(\d+)\s+U\.S\.\s+(\d+)$/i;
const ISO_RE     = /^\d{4}-\d{2}-\d{2}$/;

function scdbNormalizeCite(s) {
    return (s || '').split(/\s+/).filter(Boolean).join(' ');
}

function scdbNormalizeDate(s) {
    s = (s || '').trim();
    if (!s || s === '0') return '';
    if (ISO_RE.test(s)) return s;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
    return s;
}

// Fold every SCDB spelling of an original-/miscellaneous-docket number to our
// house style: "N ORIG" / "N, ORIG." / "N (ORIGINAL)" / "N Orig." → "N-Orig";
// "N MISC" / "N M" / "NM" / "N M." → "N-Misc". A superset of update_cases.js's
// _scdbNormalizeDocket (which doesn't fold the bare "M" shorthand). ordinary
// dockets ("24-809", "261 and 262") are returned unchanged.
// U+2010..U+2015 (hyphen, non-breaking hyphen, figure/en/em dash, horizontal
// bar) and U+2212 (minus) all normalize to an ASCII "-" so "21-707" and
// "21–707" compare equal and every docket we append is plain ASCII.
const DASHES_RE = /[‐-―−]/g;

function scdbNormalizeDocket(docket) {
    const s = (docket || '').trim().replace(DASHES_RE, '-');
    // SCDB's modern original-jurisdiction encoding, e.g. "22O141" = No. 141, Orig.
    const o = s.match(/^\d+O(\d+)$/i);
    if (o) return `${o[1]}-Orig`;
    const m = s.match(/^(\d+)?\s*[,.()\-]*\s*(ORIGINAL|ORIG|MISC|M)\s*[.)]*$/i);
    if (!m) return s;
    const n = (m[1] || '').trim();
    const suffix = /^orig/i.test(m[2]) ? 'Orig' : 'Misc';
    return n ? `${n}-${suffix}` : suffix;
}

function scdbParseCitation(citation) {
    const m = US_CITE_RE.exec(scdbNormalizeCite(citation));
    return m ? [m[1], m[2]] : ['', ''];
}

function scdbLocOpinionHref(volume, page) {
    const v = (volume || '').replace(/\D+/g, '');
    const p = (page || '').replace(/\D+/g, '');
    if (!v || !p) return '';
    const v3 = v.padStart(3, '0');
    const p3 = p.padStart(3, '0');
    const vp = `${v3}${p3}`;
    return `https://tile.loc.gov/storage-services/service/ll/usrep/usrep${v3}/usrep${vp}/usrep${vp}.pdf`;
}

const SCDB_TITLE_ACRONYMS = new Set([
    'CAA', 'CAB', 'CIA', 'EEOC', 'EPA', 'FAA', 'FBI', 'FCC', 'FDA', 'FDIC',
    'FERC', 'FHA', 'FPC', 'FRB', 'FTC', 'HEW', 'HHS', 'ICC', 'IRS', 'NASA',
    'NLRA', 'NLRB', 'NRSC', 'NSA', 'OSHA', 'SEC', 'SSA', 'TVA', 'VA',
    'ACLU', 'NAACP',
    'AFL', 'CIO', 'CWA', 'FEC', 'IBEW', 'ILGWU', 'UAW', 'UMW',
    'BNSF', 'PGA',
    'DBA', 'LLC', 'RICO',
]);
const SCDB_TITLE_LOWERCASE = new Set([
    'and', 'as', 'at', 'but', 'by', 'for',
    'in', 'nor', 'of', 'on', 'or', 'so', 'to', 'up', 'yet',
]);

function scdbCleanTitle(title) {
    if (!title) return title;
    const s = title.replace(/,?\s*\bet\s+al\.?/gi, '').trim().replace(/\s+/g, ' ');
    const tokens = s.split(' ');
    const result = tokens.map((token, i) => {
        const m = token.match(/^([^A-Za-z0-9]*)([A-Za-z0-9][A-Za-z0-9'-]*)([^A-Za-z0-9]*)$/);
        if (!m) return token;
        const [, pre, word, post] = m;
        const cased = word.split('-').map(part => {
            if (SCDB_TITLE_ACRONYMS.has(part.toUpperCase())) return part.toUpperCase();
            const lower = part.toLowerCase();
            if (lower.startsWith('mc') && lower.length > 2)
                return 'Mc' + part.charAt(2).toUpperCase() + part.slice(3).toLowerCase();
            if (lower.startsWith("o'") && lower.length > 2)
                return "O'" + part.charAt(2).toUpperCase() + part.slice(3).toLowerCase();
            if (part === part.toLowerCase()) return part;
            if (i > 0 && SCDB_TITLE_LOWERCASE.has(lower)) return lower;
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        }).join('-');
        return pre + cased + post;
    }).join(' ');
    return result.replace(/([A-Z]')([a-z])/g, (_, cap, ch) => cap + ch.toUpperCase());
}

function scdbMajorityCounts(row) {
    const parse = (v) => {
        const t = (v || '').trim();
        if (!t) return null;
        const n = parseFloat(t);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    };
    return [parse(row.majVotes), parse(row.minVotes)];
}

const SCDB_MIN_VOTE_TYPES = new Set([
    'dissent',
    'minority',
    'dissent from a denial or dismissal of certiorari , or dissent from summary affirmation of an appeal',
    'jurisdictional dissent',
]);

function loadJusticesMap() {
    if (!fs.existsSync(JUSTICES_JSON)) return {};
    let data;
    try { data = JSON.parse(fs.readFileSync(JUSTICES_JSON, 'utf8')); }
    catch { return {}; }
    const out = {};
    for (const [canonical, spec] of Object.entries(data)) {
        const c = canonical.toUpperCase();
        out[c] = c;
        for (const alt of (spec?.alternates || [])) out[String(alt).toUpperCase()] = c;
    }
    return out;
}

let JUSTICES_MAP = {};

function scdbVotesSubset(row) {
    const out = [];
    for (const j of (row.justices || [])) {
        let name = (j.justiceName || '').trim().toUpperCase();
        if (JUSTICES_MAP[name]) name = JUSTICES_MAP[name];
        if (!name) continue;

        const majorityRaw = (j.majority || '').trim().toLowerCase();
        const voteRaw     = (j.vote || '').trim().toLowerCase();
        const opinionRaw  = (j.opinion || '').trim().toLowerCase();

        let side;
        if (majorityRaw === 'majority' || majorityRaw === '2') side = 'majority';
        else if (majorityRaw === 'dissent' || majorityRaw === '1') side = 'minority';
        else if (voteRaw === 'justice participated in an equally divided vote' || voteRaw === '8') side = 'unknown';
        else if (!voteRaw) side = 'none';
        else if (SCDB_MIN_VOTE_TYPES.has(voteRaw) || voteRaw.startsWith('dissent from')) side = 'minority';
        else side = 'unknown';

        const entry = { name, side };
        const voteLabel = (j.vote || '').trim().replace(/^voted with majority or plurality$/i, 'majority or plurality');
        if (opinionRaw === 'justice wrote an opinion' || opinionRaw === '2')
            entry.action = 'wrote an opinion' + (voteRaw ? ': ' + voteLabel : '');
        else if (opinionRaw === 'justice co-authored an opinion' || opinionRaw === '3')
            entry.action = 'co-authored an opinion' + (voteRaw ? ': ' + voteLabel : '');
        out.push(entry);
    }
    return out;
}

/** The fields the standard SCDB import would set on a case, from an scdb.json
 *  record. Compact port of update_cases.js's _scdbBuildCaseFromSources (no
 *  citations.csv / dates.csv enrichment). */
function scdbImportedFields(rec) {
    const fields = {};
    const title = scdbCleanTitle((rec.caseName || '').trim());
    if (title) fields.title = title;

    const docket = (rec.docket || '').trim();
    if (docket && docket !== '0') {
        fields.number = splitDockets(docket).map(scdbNormalizeDocket).join(';');
    }

    const argument = scdbNormalizeDate(rec.dateArgument);
    if (argument) fields.argument = argument;
    const reargument = scdbNormalizeDate(rec.dateRearg || rec.datreRearg);
    if (reargument) fields.reargument = reargument;
    const decision = scdbNormalizeDate(rec.dateDecision);
    if (decision) fields.decision = decision;

    const [maj, minv] = scdbMajorityCounts(rec);
    if (maj !== null && minv !== null) fields.score = `${maj}-${minv}`;

    const citation = scdbNormalizeCite(rec.usCite || '');
    if (citation) {
        fields.citation = citation;
        const [volume, page] = scdbParseCitation(citation);
        const href = scdbLocOpinionHref(volume, page);
        if (href) fields.decision_loc = href;
    }

    const votes = scdbVotesSubset(rec);
    if (votes.length) fields.votes = votes;

    return fields;
}

// ── docket comparison ───────────────────────────────────────────────────────

/** Canonical key for docket equality: unifies "48-Orig" / "48 Orig." /
 *  "48 ORIG" / "No. 48, Original", leaves ordinary dockets ("24-809") intact. */
/** Drop SCDB's non-docket sentinels ("NA", "0", "") from a docket list. */
function realDockets(value) {
    return splitDockets(value).filter(d => d && d !== '0' && !/^na$/i.test(d));
}

function docketKey(d) {
    let s = String(d || '').trim().toLowerCase().replace(DASHES_RE, '-');
    s = s.replace(/^no\.\s*/, '');
    // SCDB modern original-jurisdiction encoding "22o141" -> "141-orig"
    const o = s.match(/^\d+o(\d+)$/);
    if (o) return `${o[1]}-orig`;
    // "48 ORIG" / "48-Orig" / "No. 12, Original" -> "48-orig"
    // "133M" / "71 M" / "5-Misc" / "5 misc."     -> "133-misc"
    const m = s.match(/^(\d+)?[\s,.()\-]*(orig(?:inal)?|misc|m)\.?\)?$/);
    if (m) {
        const kind = (m[2] === 'orig' || m[2] === 'original') ? 'orig' : 'misc';
        return `${m[1] || ''}-${kind}`;
    }
    return s.replace(/\s+/g, ' ');
}

// ── report buffer ───────────────────────────────────────────────────────────

const REPORT = [];
function say(line = '') { console.log(line); REPORT.push(line); }

// ── main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = { dryRun: false, reportTerm: DEFAULT_REPORT_TERM, onlyTerm: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--report-term') opts.reportTerm = argv[++i];
        else if (a.startsWith('--report-term=')) opts.reportTerm = a.slice('--report-term='.length);
        else if (a === '-h' || a === '--help') opts.help = true;
        else if (!a.startsWith('-')) opts.onlyTerm = a;
        else { console.error(`Unknown argument: ${a}`); process.exit(2); }
    }
    return opts;
}

function loadCases(term) {
    const p = path.join(TERMS_DIR, term, 'cases.json');
    if (!fs.existsSync(p)) return null;
    return { path: p, cases: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

/** year -> Map(docket -> caseId | null(ambiguous)) built from every SCDB
 *  record in that term year. */
function buildScdbDocketIndex(scdb) {
    const byYear = new Map();
    for (const [cid, rec] of Object.entries(scdb)) {
        const year = cid.slice(0, 4);
        let m = byYear.get(year);
        if (!m) { m = new Map(); byYear.set(year, m); }
        for (const d of splitDockets(rec.docket)) {
            m.set(d, m.has(d) ? null : cid);
        }
    }
    return byYear;
}

/** Resolve one of our cases to an scdb.json record. */
function matchCase(c, termYear, scdb, scdbDocketIndex) {
    if (c.id) return scdb[c.id] ? { id: c.id, rec: scdb[c.id], how: 'id' } : null;
    const m = scdbDocketIndex.get(termYear);
    if (!m) return null;
    for (const d of splitDockets(c.number)) {
        const hit = m.get(d);
        if (hit) return { id: hit, rec: scdb[hit], how: `docket ${d}` };
    }
    return null;
}

function jsonEq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        say(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
            .split('\n').filter(l => l.startsWith(' *') || l.startsWith('/**')).join('\n'));
        return;
    }

    if (!fs.existsSync(SCDB_JSON)) {
        console.error(`ERROR: ${path.relative(REPO_ROOT, SCDB_JSON)} not found — run \`node scripts/ingest_scdb.js\` first`);
        process.exit(1);
    }
    const scdb = JSON.parse(fs.readFileSync(SCDB_JSON, 'utf8'));
    JUSTICES_MAP = loadJusticesMap();
    const scdbDocketIndex = buildScdbDocketIndex(scdb);

    const allTerms = fs.readdirSync(TERMS_DIR)
        .filter(d => /^\d{4}-\d{2}$/.test(d) && fs.existsSync(path.join(TERMS_DIR, d, 'cases.json')))
        .sort();

    say(`# SCDB import report`);
    say('');
    say(`- Generated: ${new Date().toISOString()}`);
    say(`- scdb.json: ${Object.keys(scdb).length.toLocaleString()} records`);
    say(`- Report-only term: ${opts.reportTerm}`);
    if (opts.onlyTerm) say(`- Part 1 restricted to: ${opts.onlyTerm}`);
    if (opts.dryRun) say(`- **--dry-run:** no files will be written`);
    say('');

    // ── PART 1 ──────────────────────────────────────────────────────────────
    say(`## Part 1 — additive \`number\` merge`);
    say('');

    const part1Terms = allTerms.filter(t =>
        t !== opts.reportTerm &&
        Number(t.slice(0, 4)) >= MODERN_MIN_YEAR &&
        (!opts.onlyTerm || t === opts.onlyTerm));
    let totalUpdated = 0, totalEmpty = 0, totalConflicts = 0, totalUnmatched = 0;

    for (const term of part1Terms) {
        const termYear = term.slice(0, 4);
        const loaded = loadCases(term);
        if (!loaded) continue;
        const { path: casesPath, cases } = loaded;

        // dockets already claimed by some case in this term (for conflict check)
        const claimed = new Map(); // docketKey -> case title/id
        for (const c of cases) {
            for (const d of splitDockets(c.number)) claimed.set(docketKey(d), c.id || c.title || '?');
        }

        const changes = [];
        const emptyNumber = [];
        let termChanged = false;

        for (const c of cases) {
            const match = matchCase(c, termYear, scdb, scdbDocketIndex);
            if (!match) { totalUnmatched++; continue; }

            const ours = realDockets(c.number);
            const theirs = realDockets(match.rec.docket);
            if (!theirs.length) continue;

            const ourKeys = new Set(ours.map(docketKey));

            // An `id` match that shares no docket with our `number` is a
            // case-identity mismatch (our id ↔ SCDB caseId disagree), not a
            // consolidation — never merge across it.
            if (match.how === 'id' && ours.length && !theirs.some(d => ourKeys.has(docketKey(d)))) {
                changes.push(`  MISMATCH ${c.title || c.id}: id ${match.id} shares no docket with our ${JSON.stringify(c.number)} (SCDB: ${JSON.stringify(match.rec.docket)}) — skipped`);
                totalConflicts++;
                continue;
            }

            const missing = theirs.filter(d => !ourKeys.has(docketKey(d)));
            if (!missing.length) continue;

            if (!ours.length) {
                emptyNumber.push({ title: c.title || c.id, id: match.id, add: missing });
                totalEmpty++;
                continue;
            }

            const toAdd = [];
            for (const d of missing) {
                const norm = scdbNormalizeDocket(d);
                const owner = claimed.get(docketKey(d));
                if (owner && owner !== (c.id || c.title || '?')) {
                    changes.push(`  CONFLICT ${c.title || c.id}: SCDB docket ${JSON.stringify(norm)} already belongs to "${owner}" — skipped`);
                    totalConflicts++;
                    continue;
                }
                toAdd.push(norm);
                claimed.set(docketKey(d), c.id || c.title || '?');
            }
            if (!toAdd.length) continue;

            const before = c.number || '';
            c.number = [...ours, ...toAdd].join(';'); // in-place: key order unchanged
            changes.push(`  ${c.title || c.id} [${match.id} via ${match.how}]: ${JSON.stringify(before)} -> ${JSON.stringify(c.number)}`);
            termChanged = true;
            totalUpdated++;
        }

        if (changes.length || emptyNumber.length) {
            say(`### ${term}`);
            for (const line of changes) say(line);
            for (const e of emptyNumber) {
                say(`  EMPTY number ${e.title} [${e.id}]: SCDB has ${JSON.stringify(e.add.join(';'))} — not filled (report only)`);
            }
            say('');
        }

        if (termChanged && !opts.dryRun) {
            fs.writeFileSync(casesPath, JSON.stringify(cases, null, 2) + '\n', 'utf8');
        }
    }

    say(`**Part 1 totals:** ${totalUpdated} case(s) ${opts.dryRun ? 'would be' : ''} updated, ` +
        `${totalConflicts} docket conflict(s) skipped, ${totalEmpty} empty-\`number\` case(s) reported, ` +
        `${totalUnmatched} case(s) with no SCDB match (left untouched).`);
    say('');

    // ── PART 2 ──────────────────────────────────────────────────────────────
    say(`## Part 2 — ${opts.reportTerm} differences (report only, nothing written)`);
    say('');

    const loaded = loadCases(opts.reportTerm);
    if (!loaded) {
        say(`_No cases.json for ${opts.reportTerm}._`);
    } else {
        const termYear = opts.reportTerm.slice(0, 4);
        const { cases } = loaded;
        const matchedScdbIds = new Set();
        let diffCount = 0, cleanCount = 0;

        const FIELD_ORDER = ['title', 'number', 'argument', 'reargument', 'decision', 'score', 'citation', 'decision_loc', 'votes'];

        for (const c of cases) {
            const match = matchCase(c, termYear, scdb, scdbDocketIndex);
            if (!match) continue;
            matchedScdbIds.add(match.id);

            const want = scdbImportedFields(match.rec);
            const diffs = [];

            for (const f of FIELD_ORDER) {
                if (!(f in want)) continue;               // SCDB wouldn't set it → not a diff
                if (f === 'number') {
                    const ourKeys = new Set(realDockets(c.number).map(docketKey));
                    const add = realDockets(match.rec.docket)
                        .filter(d => !ourKeys.has(docketKey(d))).map(scdbNormalizeDocket);
                    if (add.length) {
                        diffs.push(`number: ${JSON.stringify(c.number || '')} -> would add ${JSON.stringify(add.join(';'))}`);
                    }
                    continue;
                }
                if (f === 'votes') {
                    const vd = diffVotes(c.votes, want.votes);
                    if (vd.length) diffs.push('votes:\n' + vd.map(x => `      ${x}`).join('\n'));
                    continue;
                }
                if (!jsonEq(c[f], want[f])) {
                    const cur = c[f] === undefined ? '(absent)' : JSON.stringify(c[f]);
                    diffs.push(`${f}: ${cur} -> ${JSON.stringify(want[f])}`);
                }
            }

            if (diffs.length) {
                diffCount++;
                say(`### ${c.title || c.number} [${match.id} via ${match.how}]`);
                for (const d of diffs) say(`  - ${d}`);
                say('');
            } else {
                cleanCount++;
            }
        }

        // SCDB records in this term with no case of ours
        const missingCases = Object.keys(scdb)
            .filter(cid => cid.startsWith(`${termYear}-`) && !matchedScdbIds.has(cid))
            .sort();
        // our cases with no SCDB match
        const unmatchedOurs = cases
            .filter(c => !matchCase(c, termYear, scdb, scdbDocketIndex))
            .map(c => `${c.title || '?'} (${c.number || 'no number'})`);

        say(`### SCDB records in ${opts.reportTerm} not present in our cases.json (${missingCases.length})`);
        say('');
        for (const cid of missingCases) say(`- \`${cid}\` — ${scdb[cid].caseName || ''}`);
        say('');
        say(`### Our ${opts.reportTerm} cases with no SCDB match (${unmatchedOurs.length})`);
        say('');
        for (const t of unmatchedOurs) say(`- ${t}`);
        say('');
        say(`**Part 2 totals:** ${diffCount} matched case(s) differ, ${cleanCount} match cleanly, ` +
            `${missingCases.length} SCDB record(s) unmatched, ${unmatchedOurs.length} of our cases unmatched.`);
    }

    say('');
    fs.writeFileSync(REPORT_PATH, REPORT.join('\n') + '\n', 'utf8');
    console.log(`\nreport → ${path.relative(REPO_ROOT, REPORT_PATH)}`);
}

/** Compare our votes[] with SCDB-derived votes[], keyed by justice name.
 *  Returns human-readable difference lines (empty = equivalent). */
function diffVotes(ours, theirs) {
    const o = new Map((Array.isArray(ours) ? ours : []).map(v => [String(v.name || '').toUpperCase(), v]));
    const t = new Map((theirs || []).map(v => [String(v.name || '').toUpperCase(), v]));
    const lines = [];
    for (const [name, tv] of t) {
        const ov = o.get(name);
        if (!ov) { lines.push(`${name}: (missing on our side) -> side ${tv.side}${tv.action ? `, ${tv.action}` : ''}`); continue; }
        if ((ov.side || '') !== (tv.side || '')) lines.push(`${name}: side ${JSON.stringify(ov.side)} -> ${JSON.stringify(tv.side)}`);
        const oa = ov.action || (ov.opinion ? 'wrote an opinion' : '');
        if (tv.action && !oa) lines.push(`${name}: action (none) -> ${JSON.stringify(tv.action)}`);
    }
    for (const name of o.keys()) if (!t.has(name)) lines.push(`${name}: on our side but not in SCDB record`);
    return lines;
}

main();
