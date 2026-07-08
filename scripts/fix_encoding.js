/**
 * fix_encoding.js — Classify U+FFFD replacement-character occurrences in the
 * generated opinion XML (courts/ussc/opinions/xml) and record fixes for the
 * confident ones into data/ussc/corrections/opinions.json, so update_opinions.js
 * applies them on every future regeneration. Anything not confidently resolved
 * is logged instead to data/ussc/corrections/opinions-review.json for a human
 * to look at.
 *
 * These bytes (ef bf bd) are already baked into Justia's served HTML — not an
 * artifact of our own pipeline (download.js streams raw bytes to disk, no
 * decoding happens) — so the original character is gone from the source; we
 * recover it by context into one of a handful of recurring categories. The
 * source HTML itself is never modified — the fix lives entirely in the
 * corrections ledger, layered onto freshly generated XML at write time.
 *
 * Usage:
 *   node scripts/fix_encoding.js [--dry-run] [--verbose]
 */
import {
    listAllCaseFiles, buildCitationIndex, convertCase,
    addCorrection, getCorrectionEntry,
    addReviewEntry, resetReview,
} from './update_opinions.js';

const MARK = '�';
const STRIP_TAG_RE = /<[^>]+>/g;

const DEGREE_TEMP_WORDS = /Fahrenheit|Celsius|\bdegrees?\b/i;
const DEGREE_TEMP_ABBREV_AFTER = /^\s*[FC]\.\s/;
const COMPASS_AFTER = /^\s*(north|south|east|west)\b/i;
const COMPASS_BEFORE = /\b(north|south|east|west)\s*$/i;
// Degree-minute-second survey bearings: "N 32°30'38\"", "S. 67°50' E.", "29°17'06.6\"" —
// the giveaway is a run of digits immediately followed by an apostrophe (minutes mark).
const DMS_AFTER = /^\s*\d+['’]/;
// Micrograms per cubic meter (cotton-dust/air-quality standards): "200 �g/m^3".
const MICRO_AFTER = /^\s*g\/m\^?3/;

const CENTS_WORDS = new RegExp(
    'per\\s+(gallon|bushel|barrel|pound|ton|mile|hundredweight|unit|hour|copy|m\\.?c\\.?f\\.?|cubic\\s+yard|annum)' +
    '|per\\s+(one\\s+)?(100|hundred)\\s+pounds?' + // freight-rate cents, e.g. "49¢ per 100 pounds"
    '|\\ba\\s+(gallon|barrel|bushel|pound|cubic\\s+yard)\\b' +
    '|\\bcents?\\b|\\bmargin\\b|\\bnickel\\b',
    'i');
const FRACTION_ADJ = /\d\s*\d?\/\d\s*$/;

// Unambiguous currency signals — "sterling"/"pence"/etc. never means anything
// else, so these are checked before the (overlapping) cents-rate phrasing.
const STERLING_STRONG = new RegExp(
    'sterling|\\bEngland\\b|\\bBritish\\b|\\bLondon\\b|\\bshillings?\\b|\\bpence\\b|' +
    '\\d+\\s*s\\.\\s*\\d+\\s*[dp]\\.|colonial currency|Maryland currency|\\d+\\s*s\\.\\s*(per|\\d)',
    'i');
// Plural "pounds" alone is ambiguous with the weight unit ("10 cents per 100
// pounds"), so it's only consulted as a fallback *after* the cents-rate check
// has had first refusal — that ordering is what correctly resolves things
// like "appraised the iron at six pounds per ton" (currency, not a per-ton
// cents rate) without clobbering genuine "X cents per pound" weight rates
// (which use the singular and don't match this).
const STERLING_WEAK = /\bpounds\b/i;

const SECTION_HINT = new RegExp(
    'U\\.S\\.C\\.|Rev\\.?\\s?Stat\\.|Revised Statutes|Const\\.|Stat\\.\\s*\\d|Code\\b|' +
    'Art\\.\\s*[IVXLC]+|ch\\.\\s*\\d|cl\\.\\s*\\d|Comp\\.\\s*Laws|Gen\\.\\s*Stat',
    'i');

const CCH_HINT = /C\.?C\.?H\.?/i;
const COMMA_THOUSANDS = /^\s*\d{1,3},\d{3}/;

// ¶ almost always follows a citation to a numbered paragraph of a pleading
// ("Complaint ¶ 9"), or of a looseleaf/treatise reporter that numbers its own
// paragraphs rather than sections ("CCH ... ¶ 54,562", "Moore's Federal
// Practice ¶ .325[4]") — as opposed to § which cites a statute/constitution
// "section". Both trigger lists were built from patterns actually observed in
// this corpus, not guessed blind.
const PINPOINT_PILCROW = new RegExp(
    '(complaint|answer|counterclaim|stipulation|affidavit|deposition|declaration|' +
    'petition|brief|record|id\\.\\s*at\\s*\\d+|app\\.\\s*\\d+)[,:]?\\s*$',
    'i');
const PILCROW_TREATISE = new RegExp(
    'Moore|Weinstein|Trade Cas\\.|AFTR|USTC|Stand\\.?\\s*Fed\\.?\\s*Tax|' +
    '\\bBCA\\b|\\bMCM\\b|\\bTPS\\b|Rule Crim\\.?\\s*Proc\\.?|Fed\\.?\\s*Practice',
    'i');
// Treatise/reporter paragraph numbers have their own idiosyncratic formats
// (leading decimal, trailing letter, bracketed sub-part) that a statute
// section number never does: ".325[4]", "0.401", "79d(3)", "141b".
const PILCROW_NUMBER_SUFFIX = /^\s*\.\d|^\s*\d+[a-z]\b|^\s*\d+\s*\[\d+\]|^\s*\d+\(\w+\)/;

const REPL = {
    nbsp: ' ',
    degree: '°',
    cents: '¢',
    sterling: '£',
    section: '§',
    pilcrow: '¶',
    micro: 'µ',
};

/**
 * Classify one U+FFFD occurrence at `pos` within `text` (the full, freshly
 * generated XML for a case — tags intact). Mirrors the original HTML-based
 * classifier (see git history), with one structural adaptation: the "cosmetic
 * lead-in" check was keyed off Justia's raw "headertext"/"heading-N" CSS
 * classes, which no longer exist once update_opinions.js has collapsed them
 * into plain <h1>/<h2>/<h4> tags — so that check now looks for those instead.
 */
function classifyOccurrence(text, pos) {
    const rawBefore = text.slice(Math.max(0, pos - 40), pos);

    const narrowBeforeTagged = text.slice(Math.max(0, pos - 100), pos);
    const narrowAfterTagged = text.slice(pos + 1, pos + 100);
    const narrowBefore = narrowBeforeTagged.replace(STRIP_TAG_RE, '');
    const narrowAfter = narrowAfterTagged.replace(STRIP_TAG_RE, '');

    const wide = text.slice(Math.max(0, pos - 400), pos + 400).replace(STRIP_TAG_RE, ' ');

    const digitBefore = /\d\s*$/.test(narrowBefore);
    const digitAfter = /^\s*\d/.test(narrowAfter);

    // --- 1. cosmetic nbsp lead-in (heading area) ---
    // These caption fragments ("Argued...", "Decided...", a repeated case
    // name) sit right after a tag close or a "(1920)" year parenthetical, with
    // no digit touching the mark itself — the surrounding digits belong to
    // the citation/date text, not to the mark.
    const headArea = /<h[124]\b/.test(text.slice(Math.max(0, pos - 300), pos));
    const strippedBack = rawBefore.replace(/\s+$/, '');
    const leadsIn = strippedBack.endsWith('>') || strippedBack.endsWith(')');
    if (headArea && leadsIn && !digitBefore && !digitAfter) return 'nbsp';

    if (!(digitBefore || digitAfter)) return 'unknown';

    // --- 2. micrograms (air-quality standards): "200 �g/m^3" ---
    if (MICRO_AFTER.test(narrowAfter)) return 'micro';

    // --- 2b. degree: temperature or compass/survey bearing ---
    if (DEGREE_TEMP_WORDS.test(wide) || DEGREE_TEMP_ABBREV_AFTER.test(narrowAfter)) return 'degree';
    if (COMPASS_AFTER.test(narrowAfter) || COMPASS_BEFORE.test(narrowBefore)) return 'degree';
    if (DMS_AFTER.test(narrowAfter)) return 'degree';

    // --- 3. pilcrow: CCH paragraph citation, or Id./Complaint/App. pinpoint ---
    // (strip a trailing run of already-seen mark chars so a doubled "¶¶" or
    // "§§" propagates from the first symbol's own trigger phrase)
    const beforeSansMarks = narrowBefore.replace(new RegExp(`${MARK}+$`), '');
    if (CCH_HINT.test(text.slice(Math.max(0, pos - 200), pos)) && COMMA_THOUSANDS.test(narrowAfter)) return 'pilcrow';
    if (PINPOINT_PILCROW.test(beforeSansMarks)) return 'pilcrow';
    if (PILCROW_TREATISE.test(wide) && PILCROW_NUMBER_SUFFIX.test(narrowAfter)) return 'pilcrow';

    // --- 4. sterling (strong signal): sterling/England/British/shillings-pence —
    // checked ahead of the cents-rate phrasing below since "sterling"/"pence"/a
    // shillings-and-pence amount is never anything else, whereas a bare "per
    // ton"/"per pound" is ambiguous between a cents rate and an old pounds-per-
    // unit-weight valuation (e.g. "appraised ... at six pounds per ton").
    if (STERLING_STRONG.test(wide)) return 'sterling';

    // --- 5. cents: rate/price phrasing, incl. fractions of a cent ---
    if (FRACTION_ADJ.test(narrowBefore) || CENTS_WORDS.test(wide)) return 'cents';

    // --- 5b. sterling (weak signal): plural "pounds" with no cents phrasing to compete with it ---
    if (STERLING_WEAK.test(wide)) return 'sterling';

    // --- 6. section: statute-citation context, incl. an already-correct § nearby ---
    if (SECTION_HINT.test(wide) || wide.includes('§')) return 'section';

    // --- 7. weak fallback: a correctly-encoded ¶ already present nearby ---
    if (wide.includes('¶')) return 'pilcrow';

    return 'unknown';
}

/** { lines, starts } — starts[i] is the absolute offset where lines[i] begins. */
function buildLineIndex(text) {
    const lines = text.split('\n');
    const starts = [];
    let offset = 0;
    for (const line of lines) {
        starts.push(offset);
        offset += line.length + 1;
    }
    return { lines, starts };
}

function posToLineCol(starts, pos) {
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= pos) { ans = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return { lineIdx: ans, col: pos - starts[ans] };
}

function main() {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');
    const verbose = argv.includes('--verbose');

    const citationIndex = buildCitationIndex(verbose);
    const ctx = { citationIndex };
    const files = listAllCaseFiles();

    if (!dryRun) resetReview();

    const totals = {};
    let filesTouched = 0, occurrencesFixed = 0, reviewCount = 0;

    for (const { volDir, file } of files) {
        let result;
        try {
            result = convertCase(volDir, file, ctx);
        } catch {
            continue;
        }
        if (result.error || !result.xml.includes(MARK)) continue;

        const xml = result.xml;
        const outName = file.replace(/\.html$/, '.xml');

        const positions = [];
        let idx = xml.indexOf(MARK);
        while (idx !== -1) {
            positions.push(idx);
            idx = xml.indexOf(MARK, idx + 1);
        }
        const classes = positions.map(p => classifyOccurrence(xml, p));

        // Per-file propagation: if a clear majority of this file's *classified*
        // (non-unknown) occurrences agree on sterling/cents/degree, apply that
        // category to remaining digit-adjacent unknowns in the same file — old
        // bond cases / oil-price cases / survey descriptions use the same
        // corrupted symbol consistently throughout, even where the local
        // 400-char window doesn't happen to repeat the trigger keyword.
        const classified = classes.filter(c => c !== 'unknown');
        if (classified.length) {
            const counts = {};
            for (const c of classified) counts[c] = (counts[c] || 0) + 1;
            const [topCat, topN] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            if (['sterling', 'cents', 'degree'].includes(topCat) && topN / classified.length >= 0.8) {
                positions.forEach((p, i) => {
                    if (classes[i] !== 'unknown') return;
                    const nb = xml.slice(Math.max(0, p - 40), p).replace(STRIP_TAG_RE, '');
                    const na = xml.slice(p + 1, p + 10).replace(STRIP_TAG_RE, '');
                    if (/\d\s*$/.test(nb) || /^\s*\d/.test(na)) classes[i] = topCat;
                });
            }
        }

        for (const c of classes) totals[c] = (totals[c] || 0) + 1;

        const { lines, starts } = buildLineIndex(xml);
        const byLine = new Map(); // lineIdx -> [{col, cat}]
        const unknownsByLine = new Map(); // lineIdx -> [col]
        positions.forEach((p, i) => {
            const { lineIdx, col } = posToLineCol(starts, p);
            if (classes[i] === 'unknown') {
                if (!unknownsByLine.has(lineIdx)) unknownsByLine.set(lineIdx, []);
                unknownsByLine.get(lineIdx).push(col);
            } else {
                if (!byLine.has(lineIdx)) byLine.set(lineIdx, []);
                byLine.get(lineIdx).push({ col, cat: classes[i] });
            }
        });

        let fileChanged = false;
        for (const [lineIdx, marks] of byLine) {
            const lineNo = lineIdx + 1;
            const oldLine = lines[lineIdx];

            // Never overwrite a line some other process already claimed —
            // e.g. a hand-made content fix like the missing "9s." in
            // us002-0402.xml. A line can carry several independent marks
            // (some resolved here, some still 'unknown'), so there's no
            // reliable way to tell, after the fact, which of an existing
            // correction's effects were "ours" to safely recompute — safer to
            // just leave any already-claimed line alone. A human adding a
            // content fix to a line an earlier run of this script already
            // corrected can compose onto it deliberately with
            // getCorrectionEntry/applyLineCorrection; this script never does
            // that automatically, so re-running it can only ever add new
            // corrections, never revise or clobber existing ones.
            if (getCorrectionEntry(outName, lineNo)) continue;

            marks.sort((a, b) => a.col - b.col);
            let newLine = '';
            let last = 0;
            for (const { col, cat } of marks) {
                newLine += oldLine.slice(last, col) + REPL[cat];
                last = col + 1;
            }
            newLine += oldLine.slice(last);

            if (!dryRun) addCorrection(outName, lineNo, oldLine, newLine);
            fileChanged = true;
            occurrencesFixed += marks.length;
        }
        if (fileChanged) filesTouched++;

        for (const [lineIdx, cols] of unknownsByLine) {
            for (const col of cols) {
                if (!dryRun) addReviewEntry(outName, lineIdx + 1, lines[lineIdx], col);
                reviewCount++;
            }
        }
    }

    console.log('=== classification totals ===');
    for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${k.padEnd(10)} ${v}`);
    }
    console.log(`  ${'TOTAL'.padEnd(10)} ${Object.values(totals).reduce((a, b) => a + b, 0)}`);

    if (!dryRun) {
        console.log(`\nRecorded corrections for ${filesTouched} file(s), ${occurrencesFixed} occurrence(s).`);
        console.log(`Logged ${reviewCount} undetermined occurrence(s) to data/ussc/corrections/opinions-review.json for review.`);
    } else {
        console.log(`\n(dry run — would record ${occurrencesFixed} correction(s) across some files, ${reviewCount} undetermined)`);
    }
}

main();
