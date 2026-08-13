// One-time cleanup: our case titles sometimes abbreviate a word (or a run of
// consecutive words) of a corporate name down to single capital letters +
// periods (e.g. "R." for "Railroad", or "St. P. R." for "St. Paul Railway")
// — more terse than we'd like. This script cross-references each case's
// title against the SCDB CSV's fully-spelled-out caseName (scdb/cache/
// scdb.json) to recover what those letters stand for, and expands them in
// place. It leaves multi-letter abbreviations (Co., Ry., Corp., etc.)
// untouched — those are out of scope here — and only changes runs it can
// confirm with both a preceding AND following anchor word aligning exactly
// (see "confidence" below).
//
// Algorithm: tokenize our title and the SCDB caseName. Find each maximal run
// of consecutive single-letter abbreviations (tokens like "St. P. R." form
// one 2-slot run — "P." and "R." — since "St." is itself a real anchor word,
// not an abbreviation; "&" inside a run is a pass-through, consuming no
// slot). For the anchor word immediately before and after the run (a small
// EQUIV table recognizes common suffixes like "Co."/"Ry." as anchors,
// accepting either their literal form or spelled-out form — SCDB doesn't
// always spell those out either — without ever rewriting them), if each
// anchor appears exactly once in the SCDB title and the words between them
// exactly match the run's slot count, that's a high-confidence expansion,
// slot by slot. (An exception: adjacent slots resolving to the *same* word
// are a repeat-for-emphasis idiom — "S. S." = "Steamship", not "Steamship
// Steamship" — and collapse to one.) A single-sided, uniquely-matching
// anchor is "medium" confidence — reported for manual review, never
// auto-applied, since prototyping this against the real corpus turned up a
// few false positives there (personal initials landing on an unrelated
// nearby word).
//
// A second, independent pass then syncs every case's opCite[].title against
// whatever the case it cites is titled *now* (after any fix above, or any
// earlier one already sitting in cases.json) — see the "opCite title sync"
// section below. It reuses the exact "<title> (<decision year>)" format
// _buildOpCiteList in scripts/update_cases.js already writes, so a synced
// entry is indistinguishable from a freshly generated one.
//
// Read-only by default (prints a report); pass --write to apply the
// high-confidence title changes and opCite syncs to cases.json. Pass
// --interactive to additionally walk through every medium-confidence
// candidate one at a time (y/n/q) — an accepted one is applied exactly like
// a high-confidence change (and written if --write is also given); a
// declined or never-reached one still lands in the usual medium-confidence
// report at the end. 'q' stops asking (treating everything from then on as
// declined) without aborting the rest of the run.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';
import { reorderCase } from '../scripts/schema.js';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TERMS_DIR = path.join(REPO_ROOT, 'courts/ussc/terms');
const SCDB_CACHE_PATH = path.join(REPO_ROOT, 'scdb/cache/scdb.json');
const WRITE = process.argv.includes('--write');
const INTERACTIVE = process.argv.includes('--interactive');

let _rl = null;
let _quitInteractive = false;
function getRl() {
    if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return _rl;
}
// Prompts once per medium-confidence run (not per slot — a multi-slot run
// like "St. P." is one combined decision) and returns whether to apply it.
// Always false once the visitor has typed 'q' (or interactive mode is off),
// so the rest of the pass runs to completion silently instead of aborting.
// readline/promises' own question() never settles if the input stream ends
// (EOF/closed pipe) while it's pending — it just hangs forever, which is
// what "Detected unsettled top-level await" at process exit means. Racing
// it against the interface's own 'close' event (using a distinct sentinel
// rather than e.g. 'q', so a genuine EOF can't be confused with an empty
// Enter-key answer) means an unexpectedly-closed/short input stream degrades
// to "stop asking" instead of hanging or crashing.
const _CLOSED = Symbol('closed');
async function confirmMedium(promptText) {
    if (!INTERACTIVE || _quitInteractive) return false;
    const rl = getRl();
    let onClose;
    const closed = new Promise(resolve => { onClose = () => resolve(_CLOSED); rl.once('close', onClose); });
    const result = await Promise.race([rl.question(promptText + '\n  Apply? [y/N/q] '), closed]);
    rl.off('close', onClose);
    if (result === _CLOSED) { _quitInteractive = true; return false; }
    const answer = result.trim().toLowerCase();
    if (answer === 'q') { _quitInteractive = true; return false; }
    return answer === 'y';
}

const STOPWORDS = new Set(['THE', 'A', 'AN', 'AND', 'OF', 'IN', 'ET', 'AL', 'ETC',
    'PLAINTIFF', 'PLAINTIFFS', 'DEFENDANT', 'DEFENDANTS', 'APPELLANT', 'APPELLANTS',
    'APPELLEE', 'APPELLEES', 'PETITIONER', 'PETITIONERS', 'RESPONDENT', 'RESPONDENTS',
    'ERROR', 'ERRORS', 'STATE', 'V', 'VS']);

// Legal/corporate suffixes our titles abbreviate — recognized as anchors
// (mapped to their spelled-out SCDB form) but never themselves rewritten.
const EQUIV = {
    CO: 'COMPANY', CORP: 'CORPORATION', RY: 'RAILWAY', RR: 'RAILROAD',
    INS: 'INSURANCE', MFG: 'MANUFACTURING', ASSN: 'ASSOCIATION', INC: 'INCORPORATED',
    LTD: 'LIMITED', BROS: 'BROTHERS', DEPT: 'DEPARTMENT',
    NATL: 'NATIONAL', MUT: 'MUTUAL', TR: 'TRUST', ADMR: 'ADMINISTRATOR',
    EXR: 'EXECUTOR', EXRX: 'EXECUTRIX', ADMX: 'ADMINISTRATRIX', GDN: 'GUARDIAN',
};

// A fixed, unambiguous dictionary of common terms and single-word U.S. state
// abbreviations, keyed by exact original text (case- and punctuation-
// sensitive — e.g. "La." always means Louisiana, but bare "La" is the French
// name-particle in titles like "La Crosse" or "La Follette" and must never
// match). Two-word states are handled separately below (KNOWN_STATE_PAIRS) —
// they're written as two single-letter tokens ("N. Y.", not one "N.Y."
// token), and some of those letter-pairs are genuinely ambiguous in this
// corpus (see that dictionary's comment), so they need their own per-case
// verification rather than blending into this single-token one. Unlike
// EQUIV, entries here ARE themselves rewritten — verified per-occurrence
// against SCDB (see resolveKnownAbbrev) rather than via positional
// alignment, since the mapping itself is already unambiguous.
const KNOWN_ABBREVS = {
    "Comm'n": 'Commission', "Comm'rs": 'Commissioners', "Commr's": 'Commissioners',
    'Cty.': 'County', 'Dist.': 'District', 'Ed.': 'Education',
    'Comm.': 'Committee', 'Bd.': 'Board', 'Ins.': 'Insurance', 'Mut.': 'Mutual',
    'Nat.': 'National', 'Mfg.': 'Manufacturing', 'Nav.': 'Navigation',
    'Univ.': 'University', 'Assn.': 'Association', 'Elec.': 'Electric',
    'Ala.': 'Alabama', 'Ariz.': 'Arizona', 'Ark.': 'Arkansas', 'Cal.': 'California',
    'Colo.': 'Colorado', 'Conn.': 'Connecticut', 'Del.': 'Delaware', 'Fla.': 'Florida',
    'Ga.': 'Georgia', 'Ill.': 'Illinois', 'Ind.': 'Indiana', 'Kan.': 'Kansas', 'Kans.': 'Kansas',
    'Ky.': 'Kentucky', 'La.': 'Louisiana', 'Md.': 'Maryland', 'Mass.': 'Massachusetts',
    'Mich.': 'Michigan', 'Minn.': 'Minnesota', 'Miss.': 'Mississippi', 'Mo.': 'Missouri',
    'Mont.': 'Montana', 'Neb.': 'Nebraska', 'Nebr.': 'Nebraska', 'Nev.': 'Nevada',
    'Okla.': 'Oklahoma', 'Ore.': 'Oregon', 'Oreg.': 'Oregon', 'Pa.': 'Pennsylvania',
    'Penn.': 'Pennsylvania', 'Tenn.': 'Tennessee', 'Tex.': 'Texas', 'Va.': 'Virginia',
    'Vt.': 'Vermont', 'Wash.': 'Washington', 'Wis.': 'Wisconsin', 'Wisc.': 'Wisconsin',
    'Wyo.': 'Wyoming',
};

// Two-word state names abbreviated as two adjacent single-letter tokens.
// Genuinely ambiguous in this corpus — "N. H." is "New Haven" (of "New York,
// New Haven & Hartford Railroad") in every occurrence here, never "New
// Hampshire"; "R. I." is "Rock Island" in a railroad's own name as often as
// "Rhode Island"; "S. C." even shows up as a ship's name ("The 'S. C.
// Tryon'"). So unlike KNOWN_ABBREVS this is *not* applied on containment
// alone — resolveStatePair requires the two expansion words to appear
// adjacently, in order, in that specific case's SCDB title.
// A 4th element, when present, is a connector word ("of") that our own title
// needs INSERTED between the two expansions — unlike "New York", the full
// name "District of Columbia" has a preposition in the middle that "D. C."
// never carried in the first place. SCDB's filtered tokens still read
// DISTRICT immediately followed by COLUMBIA (its own "of"/"the" get stripped
// as stopwords same as everywhere else), so detection is unaffected; only
// reconstruction needs to know to add the word back in.
const KNOWN_STATE_PAIRS = [
    [['N.', 'H.'], ['New', 'Hampshire']],
    [['N.', 'J.'], ['New', 'Jersey']],
    [['N.', 'M.'], ['New', 'Mexico']],
    [['N.', 'Y.'], ['New', 'York']],
    [['N.', 'C.'], ['North', 'Carolina']],
    [['N.', 'D.'], ['North', 'Dakota']],
    [['S.', 'C.'], ['South', 'Carolina']],
    [['S.', 'D.'], ['South', 'Dakota']],
    [['R.', 'I.'], ['Rhode', 'Island']],
    [['D.', 'C.'], ['District', 'Columbia'], 'of'],
];
function resolveStatePair(w1, w2, scdbTokens) {
    for (const [[tok1, tok2], [exp1, exp2], connector] of KNOWN_STATE_PAIRS) {
        if (w1 !== tok1 || w2 !== tok2) continue;
        const E1 = exp1.toUpperCase(), E2 = exp2.toUpperCase();
        for (let k = 0; k < scdbTokens.length - 1; k++) {
            if (scdbTokens[k] === E1 && scdbTokens[k + 1] === E2) return [E1, E2, connector];
        }
        return null;
    }
    return null;
}

// A few known OCR/typo misspellings in the SCDB source itself (verified by
// hand against scdb/legacy.csv) — corrected to the canonical spelling rather
// than reproducing the typo into our own data.
const CANONICAL_WORDS = ['RAILROAD', 'RAILWAY', 'STEAMSHIP', 'STEAMBOAT'];
function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[a.length][b.length];
}
function correctSpelling(word) {
    for (const canon of CANONICAL_WORDS) {
        if (word === canon || word === canon + 'S') return word; // exact or legitimate plural
        if (word[0] === canon[0] && Math.abs(word.length - canon.length) <= 2 && levenshtein(word, canon) <= 1) return canon;
    }
    return word;
}

function isAbbrev(tok) { return /^[A-Z]\.$/.test(tok); }
function cleanWord(tok) { return tok.replace(/[^A-Za-z]/g, '').toUpperCase(); }
// Returns the set of forms SCDB might use for this anchor word — usually
// just itself, but a legal suffix like "Co."/"Corp." might appear in SCDB
// either abbreviated the same way we write it ("CO") or spelled out
// ("COMPANY"); accept either rather than assuming SCDB always spells it out.
// Also recognizes KNOWN_ABBREVS tokens (e.g. "Va.", "Dist.") as anchors,
// same dual-form treatment — separate from whether that token also gets
// rewritten itself (see resolveKnownAbbrev).
function anchorForms(tok) {
    if (isAbbrev(tok)) return null;
    if (KNOWN_ABBREVS[tok]) return new Set([cleanWord(tok), KNOWN_ABBREVS[tok].toUpperCase()]);
    const c = cleanWord(tok);
    // Stopwords (of, the, v., etc.) are filtered out of the SCDB side too
    // (filteredScdbTokens), so they can never truly be found there — treating
    // one as an anchor would just dead-end the search instead of skipping
    // past it to a real neighbor (e.g. "Comm'n of W. Va." — "of" must not
    // block the scan from reaching "Comm'n"/"Va.").
    if (!c || STOPWORDS.has(c)) return null;
    return EQUIV[c] ? new Set([c, EQUIV[c]]) : new Set([c]);
}
// A KNOWN_ABBREVS token's expansion is already unambiguous by construction
// (it's a fixed dictionary, not something being *discovered*) — so rather
// than requiring positional alignment like resolveRun, just confirm the
// expansion word actually appears somewhere in this case's SCDB title before
// applying it, as a sanity check against the rare exception.
function resolveKnownAbbrev(tok, scdbTokens) {
    const expansion = KNOWN_ABBREVS[tok];
    if (!expansion) return null;
    return scdbTokens.includes(expansion.toUpperCase()) ? expansion.toUpperCase() : null;
}
// vIndex is where "V"/"VS" itself would have landed in `tokens` (i.e. the
// count of kept tokens before it) — petitioner-side tokens are
// tokens.slice(0, vIndex), respondent-side tokens.slice(vIndex). A case
// naming the same party-type word on both sides of "v." (e.g. two different
// "PHILADELPHIA"-named parties) is common enough that resolveRun scopes its
// anchor search to just one side (see below) rather than the whole title —
// otherwise a same-side-unique anchor reads as ambiguous just because its
// twin exists on the *other* side of an unrelated party's name. -1 (rather
// than tokens.length) when no "v."/"vs." is found at all, so a caller can
// tell "no split point" apart from "split point is at the very end".
function filteredScdbTokens(caseName) {
    const tokens = [], abbrevFlags = [];
    let vIndex = -1;
    for (const raw of caseName.split(/\s+/)) {
        const c = cleanWord(raw);
        if (vIndex === -1 && (c === 'V' || c === 'VS')) { vIndex = tokens.length; continue; }
        if (!c || STOPWORDS.has(c)) continue;
        tokens.push(c);
        // A raw token with an internal period (e.g. "T.V.", "R.R.") means
        // SCDB itself left this abbreviated rather than spelling it out —
        // cleanWord's punctuation-stripping makes "T.V." and a genuine short
        // word like "Fe" (Santa Fe) indistinguishable by text alone, so this
        // flag lets resolveRun refuse to treat an SCDB abbreviation as if it
        // were our answer (see resolveRun's candAbbrev check).
        abbrevFlags.push(/\./.test(raw));
    }
    return { tokens, abbrevFlags, vIndex };
}
// Title-cases each word, keeping connector words lowercase after the first
// (matches this corpus's own convention — "Board of Education", not "Board
// Of Education"). A plain single word behaves exactly as before.
const LOWERCASE_CONNECTORS = new Set(['OF', 'THE', 'AND']);
function properCase(text) {
    return text.split(' ').map((w, i) => (i > 0 && LOWERCASE_CONNECTORS.has(w))
        ? w.toLowerCase()
        : w.charAt(0) + w.slice(1).toLowerCase()
    ).join(' ');
}

// Find every occurrence of any of `forms` in scdbTokens.
function findAll(scdbTokens, forms) {
    const hits = [];
    for (let k = 0; k < scdbTokens.length; k++) if (forms.has(scdbTokens[k])) hits.push(k);
    return hits;
}

// Resolves a single anchor (whichever side it's on) by taking the
// `slotsLen` SCDB words immediately after it (prev-side) or before it
// (next-side, reversed back into reading order) — only when that anchor
// itself has exactly one match, so there's no ambiguity about *which*
// occurrence to count from. Shared by resolveRun's own single-sided
// fallback below, whichever side ends up needing it.
function resolveSingleAnchor(anchor, isPrevSide, slotsLen, scdbTokens, scdbAbbrevFlags) {
    if (!anchor) return null;
    const hits = findAll(scdbTokens, anchor);
    if (hits.length !== 1) return null;
    const k = hits[0];
    return isPrevSide
        ? { gapWords: scdbTokens.slice(k + 1, k + 1 + slotsLen), gapAbbrev: scdbAbbrevFlags.slice(k + 1, k + 1 + slotsLen) }
        : { gapWords: scdbTokens.slice(Math.max(0, k - slotsLen), k).reverse(), gapAbbrev: scdbAbbrevFlags.slice(Math.max(0, k - slotsLen), k).reverse() };
}

// A "run" is a maximal stretch of tokens that are each either a single-letter
// abbreviation or "&" (a pass-through — SCDB spells it "AND"/"&", either way
// it consumes no slot), bounded by ordinary anchor words on each side. Runs
// of >1 slot happen whenever a multi-word proper name is abbreviated letter
// by letter ("St. P. R. Co." -> "St. Paul Railway Co."; "S. F. & T. R. Co."
// -> "San Francisco & Texas Railway Co."). Each slot maps positionally to
// the corresponding SCDB word once the anchors line up. Returns
// { candidates: (string|null)[], confidence } aligned with `slots`, or null.
function resolveRun(words, slots, prevAnchor, nextAnchor, scdbTokens, scdbAbbrevFlags) {
    let gapWords = null, gapAbbrev = null, confidence = null;

    if (prevAnchor && nextAnchor) {
        const prevHits = findAll(scdbTokens, prevAnchor);
        if (prevHits.length === 1) {
            const k = prevHits[0];
            const nextHits = findAll(scdbTokens, nextAnchor).filter(m => m > k);
            if (nextHits.length) {
                const m = Math.min(...nextHits);
                gapWords = scdbTokens.slice(k + 1, m);
                gapAbbrev = scdbAbbrevFlags.slice(k + 1, m);
                confidence = 'high';
            }
        }
    }
    if (!gapWords) {
        // Either only one anchor was ever available, or both were but the
        // two-sided match above didn't pan out — most often because
        // nextAnchor is a corporate suffix like "Co."/"Corp." that SCDB
        // simply omits for this party (e.g. our "New York Elevated R. Co."
        // vs. SCDB's own "NEW YORK ELEVATED RAILROAD", no "COMPANY" word at
        // all) rather than any real ambiguity. Either way, falls back to
        // whichever single anchor uniquely resolves — same "medium"
        // (reported, never auto-applied) treatment as always, since a lone
        // anchor is still just extrapolating forward/backward by slot count
        // rather than confirming both ends.
        const prevResult = resolveSingleAnchor(prevAnchor, true, slots.length, scdbTokens, scdbAbbrevFlags);
        const result = prevResult || resolveSingleAnchor(nextAnchor, false, slots.length, scdbTokens, scdbAbbrevFlags);
        if (result) {
            gapWords = result.gapWords;
            gapAbbrev = result.gapAbbrev;
            confidence = 'medium';
        }
    }
    if (!gapWords || !gapWords.length) return null;

    let candidates, candAbbrev;
    if (gapWords.length === slots.length) {
        candidates = gapWords;
        candAbbrev = gapAbbrev;
    } else if (gapWords.length === 1 && slots.every(i => words[i][0] === words[slots[0]][0])) {
        // "S. S. Galveston" idiom: repeated identical letter = one word said
        // once (not once per letter). Only sensible when every slot shares
        // the same abbreviated letter.
        candidates = slots.map(() => gapWords[0]);
        candAbbrev = slots.map(() => gapAbbrev[0]);
    } else {
        return null;
    }

    for (let s = 0; s < slots.length; s++) {
        const cand = candidates[s];
        // A candidate sourced from SCDB's own abbreviated token (e.g.
        // "T.V." or "R.R." — see filteredScdbTokens) isn't a genuine
        // expansion; reject the whole run rather than substitute one
        // abbreviation for another.
        if (candAbbrev[s]) return null;
        // A high-confidence run is bounded by anchors on both sides — already
        // a strong signal — so a real short word (e.g. "Fe" in "Santa Fe") is
        // accepted; medium confidence (single-sided anchor) keeps the
        // stricter 3-letter floor, since a short word there is more likely a
        // coincidental nearby-word match than a genuine expansion (see the
        // "few false positives" note in the file banner comment).
        const minLen = confidence === 'high' ? 2 : 3;
        if (!/^[A-Z]+$/.test(cand) || cand.length < minLen || cand[0] !== words[slots[s]][0]) return null;
    }
    if (confidence === 'high') candidates = candidates.map(correctSpelling);
    return { candidates, confidence };
}

const scdb = JSON.parse(fs.readFileSync(SCDB_CACHE_PATH, 'utf8'));
const firstTitle = (s) => { if (!s) return s; const i = s.indexOf('|'); return i === -1 ? s : s.slice(0, i); };

// Load every term's cases.json into memory up front — the opCite sync pass
// below (which runs after title expansion) needs every case's *final* title
// available before it can check any *other* case's citations against it,
// including citations from a different term's file than the one being cited.
const termsData = []; // { term, casesPath, cases }
for (const term of fs.readdirSync(TERMS_DIR).sort()) {
    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    if (!fs.existsSync(casesPath)) continue;
    let cases;
    try { cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')); } catch { continue; }
    if (!Array.isArray(cases)) continue;
    termsData.push({ term, casesPath, cases });
}

const caseById = new Map();    // id -> case object (for opCite's decision-year lookup)
const titleOverride = new Map(); // id -> proposed new title (populated even in dry-run, for accurate opCite preview)
const changedFiles = new Set(); // casesPath of any file touched by either pass

const highChanges = [];   // { term, id, oldTitle, newTitle }
const mediumReport = [];  // { term, id, titlePart, letter, candidate }
let casesChanged = 0;

for (const { term, casesPath, cases } of termsData) {
    for (const c of cases) {
        if (c.id) caseById.set(c.id, c);
    }

    for (const c of cases) {
        if (!c.id || !c.title) continue;
        const row = scdb[c.id];
        if (!row || !row.caseName) continue;
        const { tokens: scdbTokens, abbrevFlags: scdbAbbrevFlags, vIndex: scdbVIndex } = filteredScdbTokens(row.caseName);

        const oldTitle = c.title;
        const titleParts = String(c.title).split('|');
        let titleTouched = false;
        const newTitleParts = [];
        for (const part of titleParts) {
            // Preserve exact whitespace: split into alternating [word, sep, word, sep, ...].
            const rawParts = part.split(/(\s+)/);
            const wordIdx = [];
            for (let i = 0; i < rawParts.length; i += 2) wordIdx.push(i);
            const words = wordIdx.map(i => rawParts[i]);

            // Where "v."/"vs." falls in *our* words — petitioner-side words
            // come before it, respondent-side after. Scopes every SCDB
            // anchor search below to the matching side of SCDB's own "v."
            // (scdbVIndex — see filteredScdbTokens), so a same-side-unique
            // anchor isn't rejected as ambiguous just because an unrelated
            // party on the *other* side happens to share a word (e.g. two
            // different "PHILADELPHIA..."-named parties in one caption).
            // Falls back to the whole (unsplit) token list whenever either
            // side lacks a "v."/"vs." to split on, same as before this fix.
            let ourVIdx = -1;
            for (let i = 0; i < words.length; i++) {
                const c = cleanWord(words[i]);
                if (c === 'V' || c === 'VS') { ourVIdx = i; break; }
            }
            function sideTokensFor(wordPos) {
                if (ourVIdx === -1 || scdbVIndex === -1) return [scdbTokens, scdbAbbrevFlags];
                return wordPos < ourVIdx
                    ? [scdbTokens.slice(0, scdbVIndex), scdbAbbrevFlags.slice(0, scdbVIndex)]
                    : [scdbTokens.slice(scdbVIndex), scdbAbbrevFlags.slice(scdbVIndex)];
            }

            const resolved = new Array(words.length).fill(null);
            const deleted = new Set();
            const locked = new Set(); // positions state-pair-resolved; run-detection must not reprocess them

            // Two-word state abbreviations ("N. Y." -> "New York") first —
            // ambiguous in this corpus (see KNOWN_STATE_PAIRS), so they need
            // their own stricter check before the generic run/anchor
            // machinery below gets a chance to (mis)resolve either half.
            for (let ki = 0; ki < words.length - 1; ki++) {
                const [sideTokens] = sideTokensFor(ki);
                const pair = resolveStatePair(words[ki], words[ki + 1], sideTokens);
                if (!pair) continue;
                const [e1, e2, connector] = pair;
                if (connector) {
                    resolved[ki] = `${e1} ${connector.toUpperCase()} ${e2}`;
                    deleted.add(ki + 1); // second token absorbed into the first's combined text
                } else {
                    resolved[ki] = e1;
                    resolved[ki + 1] = e2;
                }
                locked.add(ki);
                locked.add(ki + 1);
                ki++; // consume both tokens
            }

            // Fixed-dictionary terms (state abbreviations, Comm'n/Cty./Dist./
            // Ed.) resolve independently of the run/anchor machinery below —
            // see resolveKnownAbbrev's doc comment.
            for (let ki = 0; ki < words.length; ki++) {
                if (locked.has(ki)) continue;
                const [sideTokens] = sideTokensFor(ki);
                const known = resolveKnownAbbrev(words[ki], sideTokens);
                if (known) resolved[ki] = known;
            }

            // Find maximal runs of consecutive abbreviation/"&" tokens and
            // resolve each as a unit — a run's slots must be filled together
            // since they map positionally to the SCDB words between the same
            // pair of anchors (see resolveRun's doc comment).
            let wi = 0;
            while (wi < words.length) {
                if (!isAbbrev(words[wi]) || locked.has(wi)) { wi++; continue; }
                let end = wi;
                while (end + 1 < words.length && !locked.has(end + 1) && (isAbbrev(words[end + 1]) || words[end + 1] === '&')) end++;
                const slots = [];
                for (let k = wi; k <= end; k++) if (isAbbrev(words[k])) slots.push(k);

                // Bounded at ourVIdx (our own "v."/"vs.") so a run right at
                // the start of one side never walks past "v." and picks an
                // anchor that actually belongs to the *other* party's name.
                const prevBound = (ourVIdx !== -1 && wi > ourVIdx) ? ourVIdx + 1 : 0;
                const nextBound = (ourVIdx !== -1 && end < ourVIdx) ? ourVIdx : words.length;
                let prevAnchor = null;
                for (let j = wi - 1; j >= prevBound; j--) { const a = anchorForms(words[j]); if (a) { prevAnchor = a; break; } }
                let nextAnchor = null;
                for (let j = end + 1; j < nextBound; j++) { const a = anchorForms(words[j]); if (a) { nextAnchor = a; break; } }

                const [runScdbTokens, runScdbAbbrevFlags] = sideTokensFor(wi);
                const r = resolveRun(words, slots, prevAnchor, nextAnchor, runScdbTokens, runScdbAbbrevFlags);
                if (r) {
                    if (r.confidence === 'medium') {
                        const label = slots.map((slotIdx, s) => `${words[slotIdx]} -> ${properCase(r.candidates[s])}?`).join(', ');
                        // Same repeat-idiom collapse as the real applied
                        // change below ("S. S." -> one "Steamship", not
                        // "Steamship Steamship") — otherwise the preview
                        // shown here would be misleading.
                        const previewWords = [];
                        for (let i = 0; i < words.length; i++) {
                            const s = slots.indexOf(i);
                            if (s === -1) { previewWords.push(words[i]); continue; }
                            if (s > 0 && r.candidates[s] === r.candidates[s - 1]) continue;
                            previewWords.push(properCase(r.candidates[s]));
                        }
                        const accepted = await confirmMedium(
                            `\n${term}  ${c.id}\n  "${part}"\n  ${label}\n  -> "${previewWords.join(' ')}"`
                        );
                        if (accepted) {
                            for (let s = 0; s < slots.length; s++) resolved[slots[s]] = r.candidates[s];
                            for (let s = 1; s < slots.length; s++) {
                                if (r.candidates[s] === r.candidates[s - 1]) deleted.add(slots[s]);
                            }
                        } else {
                            for (let s = 0; s < slots.length; s++) {
                                mediumReport.push({ term, id: c.id, titlePart: part, letter: words[slots[s]][0], candidate: r.candidates[s] });
                            }
                        }
                    } else {
                        for (let s = 0; s < slots.length; s++) resolved[slots[s]] = r.candidates[s];
                        // Repeat-idiom collapse ("S. S." -> one "Steamship"):
                        // when consecutive slots resolved to the same word,
                        // keep only the first occurrence.
                        for (let s = 1; s < slots.length; s++) {
                            if (r.candidates[s] === r.candidates[s - 1]) deleted.add(slots[s]);
                        }
                    }
                }
                wi = end + 1;
            }

            if (resolved.every(r => r === null)) { newTitleParts.push(part); continue; } // nothing to change

            titleTouched = true;
            const out = [];
            for (let i = 0; i < rawParts.length; i++) {
                if (i % 2 === 1) { out.push(rawParts[i]); continue; } // separator, pushed tentatively
                const wi = i / 2;
                if (deleted.has(wi)) { if (out.length) out.pop(); continue; } // drop it + its leading separator
                out.push(resolved[wi] ? properCase(resolved[wi]) : rawParts[i]);
            }
            newTitleParts.push(out.join(''));
        }

        if (titleTouched) {
            const newTitle = newTitleParts.join('|');
            highChanges.push({ term, id: c.id, oldTitle, newTitle });
            titleOverride.set(c.id, newTitle);
            if (WRITE) {
                c.title = newTitle;
                const reordered = reorderCase(c);
                for (const k of Object.keys(c)) delete c[k];
                Object.assign(c, reordered);
                changedFiles.add(casesPath);
                casesChanged++;
            }
        }
    }
}

// ── opCite title sync ──────────────────────────────────────────────────────
// Every opCite entry stores "<canonical title of cited case> (<decision
// year>)" as of whenever it was generated (see _buildOpCiteList in
// scripts/update_cases.js, whose exact format this mirrors). Any title fix
// above — or any earlier one already sitting in cases.json — leaves every
// *other* case's citation of it stale until re-synced here.
const opCiteChanges = []; // { term, citingId, oldEntryTitle, newEntryTitle }
let opCiteCasesChanged = 0;

for (const { term, casesPath, cases } of termsData) {
    for (const c of cases) {
        if (!Array.isArray(c.opCite) || !c.opCite.length) continue;
        let caseTouched = false;
        for (const entry of c.opCite) {
            const hit = entry.id ? caseById.get(entry.id) : null;
            if (!hit) continue;
            const hitTitle = titleOverride.get(entry.id) || hit.title;
            const canonicalTitle = firstTitle(hitTitle) || entry.title;
            const year = /^(\d{4})-/.exec(hit.decision || '')?.[1] || null;
            const expected = year ? `${canonicalTitle} (${year})` : canonicalTitle;
            if (entry.title === expected) continue;
            opCiteChanges.push({ term, citingId: c.id, oldEntryTitle: entry.title, newEntryTitle: expected });
            if (WRITE) {
                entry.title = expected;
                caseTouched = true;
            }
        }
        if (caseTouched) { opCiteCasesChanged++; changedFiles.add(casesPath); }
    }
}

if (WRITE) {
    for (const casesPath of changedFiles) {
        const entry = termsData.find(t => t.casesPath === casesPath);
        fs.writeFileSync(casesPath, JSON.stringify(entry.cases, null, 2) + '\n', 'utf8');
    }
}

console.log(`${highChanges.length} high-confidence title change(s) found${WRITE ? ', applying...' : ' (dry run — pass --write to apply):'}\n`);
for (const { term, id, oldTitle, newTitle } of highChanges) {
    console.log(`  ${term}  ${id}`);
    console.log(`    - ${oldTitle}`);
    console.log(`    + ${newTitle}`);
}

console.log(`\n${opCiteChanges.length} opCite citation title(s) out of sync with the case they cite${WRITE ? ', applying...' : ':'}\n`);
for (const { term, citingId, oldEntryTitle, newEntryTitle } of opCiteChanges) {
    console.log(`  ${term}  ${citingId}`);
    console.log(`    - ${oldEntryTitle}`);
    console.log(`    + ${newEntryTitle}`);
}

if (WRITE) {
    console.log(`\nUpdated ${casesChanged} case title(s) and ${opCiteCasesChanged} case(s)' opCite entries, across ${changedFiles.size} file(s) total.`);
}
// Shown regardless of --write — interactive mode can leave some candidates
// declined/un-reviewed even after a write, and dry-run always wants this.
if (mediumReport.length) {
    const seen = new Set();
    const deduped = mediumReport.filter(r => {
        const k = `${r.id}|${r.titlePart}|${r.letter}|${r.candidate}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    console.log(`\n${deduped.length} medium-confidence candidate(s) found but NOT applied (single-sided anchor match only — review manually):`);
    for (const { term, id, titlePart, letter, candidate } of deduped) {
        console.log(`  ${term}  ${id}  "${titlePart}"  ${letter}. -> ${properCase(candidate)}?`);
    }
}

if (_rl) _rl.close();
