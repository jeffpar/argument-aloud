/**
 * tag_cases.js — Apply tags from noteworthy.json to the matching case objects in
 * each term's cases.json.
 *
 * For every group in noteworthy.json, each case entry's "name" value is added to a
 * "tags" array on the matching case object. Cases are matched by "term" + "number"
 * when a number is present; otherwise by title (after stripping any trailing
 * " (YYYY)" year suffix). The "tags" property is inserted immediately after "title"
 * if it doesn't already exist. A "Noteworthy" tag is also added to every matched
 * case (before the group-specific tag) so all noteworthy cases share a common tag.
 *
 * Usage:
 *   node tag_cases.js [--dry-run] [--verbose]
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const ROOT            = path.resolve(__dirname, '..');
const NOTEWORTHY_PATH = path.join(ROOT, 'courts', 'ussc', 'collections', 'noteworthy.json');
const TERMS_DIR       = path.join(ROOT, 'courts', 'ussc', 'terms');

const NOTEWORTHY_TAG  = 'Noteworthy';

function readJSON(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSON(p, data) {
    const str = JSON.stringify(data, null, 2) + '\n';
    if (!DRY_RUN) fs.writeFileSync(p, str, 'utf8');
}

/**
 * Return a new object identical to `obj` but with `key` inserted immediately
 * after `afterKey`. If `key` already exists in `obj`, the object is returned
 * as-is (position unchanged). If `afterKey` is not found, `key` is appended.
 */
function insertAfter(obj, afterKey, key, value) {
    if (key in obj) return obj;
    const result = {};
    let inserted = false;
    for (const k of Object.keys(obj)) {
        result[k] = obj[k];
        if (k === afterKey && !inserted) {
            result[key] = value;
            inserted = true;
        }
    }
    if (!inserted) result[key] = value;
    return result;
}

/** Strip a trailing " (YYYY)" year from a title string. */
function stripYear(title) {
    return title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

const noteworthy = readJSON(NOTEWORTHY_PATH);

// Load each term's cases.json on first access and cache it.
const termCache = {};   // term -> { cases: [...], path: string, dirty: bool }

function getTermData(term) {
    if (termCache[term]) return termCache[term];
    const p = path.join(TERMS_DIR, term, 'cases.json');
    if (!fs.existsSync(p)) {
        console.warn(`  WARNING: cases.json not found for term ${term}`);
        return null;
    }
    const cases = readJSON(p);
    termCache[term] = { cases, path: p, dirty: false };
    return termCache[term];
}

/**
 * Ensure `c.tags` is an array placed right after "title", then add each of
 * `tagsToAdd` (in order) if not already present. Returns the (possibly new)
 * case object and the count of tags actually added.
 */
function applyTags(c, idx, termData, tagsToAdd) {
    if (!Array.isArray(c.tags)) {
        const existing = typeof c.tags === 'string' ? [c.tags] : [];
        const { tags: _old, ...rest } = c;
        c = insertAfter(rest, 'title', 'tags', existing);
        termData.cases[idx] = c;
        if (_old !== undefined) termData.dirty = true;
    }

    let added = 0;
    for (const tag of tagsToAdd) {
        if (!c.tags.includes(tag)) {
            c.tags.push(tag);
            termData.dirty = true;
            added++;
        }
    }
    return { c, added };
}

let totalTagged = 0;

for (const group of noteworthy) {
    const tag = group.name;
    for (const entry of (group.cases || [])) {
        const { term, number, title } = entry;
        if (!term) {
            console.warn(`  WARNING: missing term in group "${tag}":`, entry);
            continue;
        }

        const termData = getTermData(term);
        if (!termData) continue;

        let idx = -1;

        if (number) {
            // Exact match first.
            idx = termData.cases.findIndex(c => c.number === number);
            if (idx === -1) {
                // Fall back: the stored number may be a comma-separated list (e.g. "142,119").
                // Accept if exactly one case contains the target number as one of its tokens.
                const matches = termData.cases.reduce((acc, c, i) => {
                    const tokens = (c.number || '').split(',').map(t => t.trim());
                    if (tokens.includes(number)) acc.push(i);
                    return acc;
                }, []);
                if (matches.length === 1) {
                    idx = matches[0];
                } else if (matches.length > 1) {
                    console.warn(`  WARNING: case number "${number}" is ambiguous in term ${term} (${matches.length} matches)`);
                    continue;
                } else {
                    console.warn(`  WARNING: case number "${number}" not found in term ${term}`);
                    continue;
                }
            }
        } else {
            // Fall back to title matching (strip trailing year before comparing).
            const bare = stripYear(title || '').toLowerCase();
            if (!bare) {
                console.warn(`  WARNING: missing term/number/title in group "${tag}":`, entry);
                continue;
            }
            idx = termData.cases.findIndex(c => stripYear(c.title || '').toLowerCase() === bare);
            if (idx === -1) {
                // Second fallback: match by argument date + decision date + shared
                // significant title words (ignore articles and single-letter tokens like "v.").
                const IGNORE = new Set(['the', 'a', 'an', 'of', 'in', 'v', 'v.']);
                const sigWords = bare.split(/\W+/).filter(w => w.length > 1 && !IGNORE.has(w));
                if (sigWords.length > 0 && (entry.argument || entry.decision)) {
                    const fuzzyMatches = termData.cases.reduce((acc, c, i) => {
                        // c.argument may be a comma-separated multi-date string; treat each
                        // date as a token and require entry.argument to be one of them.
                        if (entry.argument) {
                            const argTokens = (c.argument || '').split(',').map(d => d.trim());
                            if (!argTokens.includes(entry.argument)) return acc;
                        }
                        if (entry.decision && c.decision !== entry.decision) return acc;
                        const cWords = stripYear(c.title || '').toLowerCase().split(/\W+/);
                        const shared = sigWords.some(w => cWords.includes(w));
                        if (shared) acc.push(i);
                        return acc;
                    }, []);
                    if (fuzzyMatches.length === 1) {
                        idx = fuzzyMatches[0];
                    } else if (fuzzyMatches.length > 1) {
                        console.warn(`  WARNING: fuzzy match for "${title}" in term ${term} is ambiguous (${fuzzyMatches.length} matches)`);
                        continue;
                    }
                }
                if (idx === -1) {
                    console.warn(`  WARNING: no title match for "${title}" in term ${term}`);
                    continue;
                }
            }
        }

        const label = number || `"${title}"`;
        const { c: updated, added } = applyTags(
            termData.cases[idx], idx, termData,
            [NOTEWORTHY_TAG, tag]
        );
        if (added > 0) {
            totalTagged += added;
            if (VERBOSE) console.log(`  + [${[NOTEWORTHY_TAG, tag].join(', ')}] -> ${term}/${label}`);
        }
    }
}

// Write back any modified term files.
let filesWritten = 0;
for (const [term, termData] of Object.entries(termCache)) {
    if (!termData.dirty) continue;
    if (VERBOSE || DRY_RUN) console.log(`${DRY_RUN ? '[dry-run] ' : ''}Writing ${termData.path}`);
    writeJSON(termData.path, termData.cases);
    filesWritten++;
}

console.log(`Done. ${totalTagged} tag addition(s) across ${filesWritten} file(s).${DRY_RUN ? ' (dry run — no files written)' : ''}`);
