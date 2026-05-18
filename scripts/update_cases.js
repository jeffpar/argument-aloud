#!/usr/bin/env node

/**
 * update_cases.js — Update vote data for a specific case
 *
 * Usage:
 *   node scripts/update_cases.js TERM CASE --votes OUTCOME VOTE_STRING AUTHOR [--minority NAMES...] [--recused NAMES...] [--dissent NAMES...]
 *   node scripts/update_cases.js TERM CASE --recused NAMES...
 *   node scripts/update_cases.js TERM CASE --minority NAMES...
 *
 * Full Update Mode (with --votes):
 *   TERM          Term identifier (e.g., "2024-10")
 *   CASE          Case ID or number (e.g., "2024-001" or "23-583")
 *   --votes       Begins vote specification
 *     OUTCOME     Either "win" or "loss"
 *                   win  = "petitioning party received a favorable disposition"
 *                   loss = "no favorable disposition for petitioning party apparent"
 *     VOTE_STRING Vote tally in format "N-N" (e.g., "6-3", "9-0")
 *                 First number is majority, second is minority
 *     AUTHOR      Last name of opinion author (must be in majority)
 *   --minority    (optional) Last names of justices in the minority
 *   --recused     (optional) Last names of justices who recused
 *   --dissent     (optional) Last names of justices who wrote dissents
 *                 Dissent authors are automatically added to minority, so you
 *                 don't need to list them in both --dissent and --minority
 *
 * Partial Update Mode (without --votes):
 *   Updates only the specified justices' vote status, preserving all other data.
 *   Automatically recalculates voteMajority/voteMinority counts.
 *
 *   --recused NAMES...   Mark these justices as recused
 *   --minority NAMES...  Mark these justices as minority
 *   --dissent NAMES...   Mark these justices as dissent authors (must be in minority)
 *
 * Name Resolution:
 *   - Justice names can be specified by last name only (e.g., "kavanaugh", "jackson")
 *   - Names are matched against justices serving on the decision date
 *   - If a last name is ambiguous, an error is reported
 *
 * Examples:
 *   # Full update: unanimous decision, author Roberts
 *   node scripts/update_cases.js 2024-10 2024-001 --votes win 9-0 roberts
 *
 *   # Full update: 6-3 decision with liberal minority
 *   node scripts/update_cases.js 2024-10 2024-001 --votes win 6-3 roberts --minority sotomayor kagan jackson
 *
 *   # Full update: 6-3 decision with Kagan writing dissent
 *   node scripts/update_cases.js 2025-10 24-109 --votes loss 6-3 alito --dissent kagan --minority sotomayor kagan jackson
 *
 *   # Partial update: just mark Gorsuch as recused
 *   node scripts/update_cases.js 2024-10 23-975 --recused gorsuch
 *
 *   # Partial update: change minority justices
 *   node scripts/update_cases.js 2024-10 2024-001 --minority sotomayor kagan jackson
 *
 * Features:
 *   - Automatically determines which justices were serving on the decision date
 *   - Sorts votes by seniority (Chief Justice first, then associates by dateStart)
 *   - Marks opinion author with "opinion": true
 *   - Marks dissent authors with "dissent": true (must be in minority)
 *   - Validates vote counts match provided names
 *   - Updates result, voteMajority, voteMinority, and votes fields
 *   - Preserves all other case fields and maintains canonical key order
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { reorderCase, reorderVote } from './schema.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, '..');
const TERMS_DIR  = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
const JUSTICES_PATH = path.join(REPO_ROOT, 'data', 'ussc', 'justices.json');

// ── Helpers ────────────────────────────────────────────────────────────────

const _readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const _writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');

function parseArgs() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: update_cases.js TERM CASE [--votes win|loss VOTE_STRING AUTHOR] [--minority NAMES...] [--recused NAMES...] [--dissent NAMES...]');
        process.exit(1);
    }

    const term = args[0];
    const caseId = args[1];

    // Parse minority justices
    const minorityIdx = args.indexOf('--minority');
    const recusedIdx = args.indexOf('--recused');
    const dissentIdx = args.indexOf('--dissent');
    const votesIdx = args.indexOf('--votes');

    // Determine end index for each section
    const getEndIdx = (startIdx, ...otherIndices) => {
        const validIndices = otherIndices.filter(i => i > startIdx);
        return validIndices.length > 0 ? Math.min(...validIndices) : args.length;
    };

    let minority = [];
    if (minorityIdx !== -1) {
        const endIdx = getEndIdx(minorityIdx, recusedIdx, dissentIdx, votesIdx);
        minority = args.slice(minorityIdx + 1, endIdx);
    }

    let recused = [];
    if (recusedIdx !== -1) {
        const endIdx = getEndIdx(recusedIdx, minorityIdx, dissentIdx, votesIdx);
        recused = args.slice(recusedIdx + 1, endIdx);
    }

    let dissent = [];
    if (dissentIdx !== -1) {
        const endIdx = getEndIdx(dissentIdx, minorityIdx, recusedIdx, votesIdx);
        dissent = args.slice(dissentIdx + 1, endIdx);
    }

    // Check if this is a partial update (no --votes) or full update
    if (votesIdx === -1) {
        // Partial update mode
        if (minority.length === 0 && recused.length === 0 && dissent.length === 0) {
            console.error('ERROR: Must specify either --votes for full update, or --minority/--recused/--dissent for partial update');
            process.exit(1);
        }
        return {
            term,
            caseId,
            partialUpdate: true,
            minority,
            recused,
            dissent
        };
    }

    // Full update mode
    if (votesIdx + 4 > args.length) {
        console.error('ERROR: --votes requires: win|loss VOTE_STRING AUTHOR');
        process.exit(1);
    }

    const outcome = args[votesIdx + 1]; // win or loss
    const voteString = args[votesIdx + 2]; // e.g., "6-3" or "9-0"
    const author = args[votesIdx + 3]; // last name

    return {
        term,
        caseId,
        partialUpdate: false,
        outcome,
        voteString,
        author,
        minority,
        recused,
        dissent
    };
}

function parseVoteString(voteString) {
    const match = voteString.match(/^(\d+)-(\d+)$/);
    if (!match) {
        console.error(`ERROR: Invalid vote string "${voteString}". Expected format: N-N (e.g., "6-3")`);
        process.exit(1);
    }
    return { majority: parseInt(match[1], 10), minority: parseInt(match[2], 10) };
}

// ── Justice data loading ───────────────────────────────────────────────────

let _justicesData = null;
let _justicesMap = {}; // UPPERCASE -> canonical name
let _justicesTenures = {}; // canonical -> {start, stop}
let _justicesChief = {}; // canonical -> [{start, stop}]
let _justicesStart = {}; // canonical -> earliest start date

function loadJusticesData() {
    if (_justicesData) return;

    if (!fs.existsSync(JUSTICES_PATH)) {
        console.error(`ERROR: justices.json not found at ${JUSTICES_PATH}`);
        process.exit(1);
    }

    _justicesData = _readJson(JUSTICES_PATH);

    // Build maps for name lookup and seniority ordering
    for (const [canonical, spec] of Object.entries(_justicesData)) {
        const c = canonical.toUpperCase();
        _justicesMap[c] = c;
        for (const alt of (spec?.alternates || [])) {
            _justicesMap[String(alt).toUpperCase()] = c;
        }

        // Build tenure info
        const tenures = [];
        if (Array.isArray(spec?.tenures)) {
            for (const t of spec.tenures) {
                tenures.push({ start: t.dateStart || '', stop: t.dateStop || '' });
            }
        } else if (spec?.dateStart || spec?.dateStop) {
            tenures.push({ start: spec.dateStart || '', stop: spec.dateStop || '' });
        }
        if (tenures.length) _justicesTenures[c] = tenures;

        const starts = tenures.map(t => t.start).filter(Boolean).sort();
        if (starts.length) _justicesStart[c] = starts[0];

        // Parse chief justice ranges from titles
        const titles = Array.isArray(spec?.titles) ? spec.titles : [];
        const chiefRanges = [];
        const baseStart = (tenures[0] && tenures[0].start) || '';
        const baseStop = (tenures[tenures.length - 1] && tenures[tenures.length - 1].stop) || '';

        const termToDate = (s) => /^\d{4}-\d{2}$/.test(s) ? `${s}-01` : s;

        for (const t of titles) {
            const m = String(t).match(/^\s*CHIEF\s+JUSTICE\b(?:\s*(>=|<=|>|<)\s*(\S+))?/i);
            if (!m) continue;
            const op = m[1];
            const ref = m[2] ? termToDate(m[2]) : '';
            let start = baseStart, stop = baseStop;
            if (op === '>=' || op === '>') start = ref;
            else if (op === '<=' || op === '<') stop = ref;
            chiefRanges.push({ start, stop });
        }
        if (chiefRanges.length) _justicesChief[c] = chiefRanges;
    }
}

function canonicalName(name) {
    const upper = String(name || '').trim().toUpperCase();
    return _justicesMap[upper] || upper;
}

function isServingOn(canonical, isoDate) {
    const tenures = _justicesTenures[canonical];
    if (!tenures) return false;
    return tenures.some(t =>
        (!t.start || isoDate >= t.start) &&
        (!t.stop || isoDate <= t.stop)
    );
}

function isChiefOn(canonical, isoDate) {
    const ranges = _justicesChief[canonical];
    if (!ranges) return false;
    return ranges.some(r =>
        (!r.start || isoDate >= r.start) &&
        (!r.stop || isoDate <= r.stop)
    );
}

function justicesServingOn(isoDate) {
    const serving = [];
    for (const canonical of Object.keys(_justicesTenures)) {
        if (isServingOn(canonical, isoDate)) {
            serving.push(canonical);
        }
    }
    return serving;
}

function sortVotesBySeniority(votes, isoDate) {
    const decorated = votes.map((v, i) => {
        const nm = canonicalName(v && v.name);
        return {
            v, i,
            chief: isChiefOn(nm, isoDate) ? 0 : 1,
            start: _justicesStart[nm] || '9999-99-99',
            name: nm,
        };
    });
    decorated.sort((a, b) =>
        a.chief - b.chief ||
        a.start.localeCompare(b.start) ||
        a.name.localeCompare(b.name) ||
        a.i - b.i
    );
    return decorated.map(d => d.v);
}

function titleCase(upperName) {
    return upperName
        .split(/\s+/)
        .map(w => w.charAt(0) + w.slice(1).toLowerCase())
        .join(' ');
}

// ── Main logic ─────────────────────────────────────────────────────────────

function main() {
    const parsedArgs = parseArgs();
    const { term, caseId, partialUpdate, minority, recused, dissent } = parsedArgs;

    loadJusticesData();

    // Load cases.json
    const casesPath = path.join(TERMS_DIR, term, 'cases.json');
    if (!fs.existsSync(casesPath)) {
        console.error(`ERROR: cases.json not found at ${casesPath}`);
        process.exit(1);
    }

    let cases = _readJson(casesPath);
    const caseIndex = cases.findIndex(c => c.id === caseId || c.number === caseId);

    if (caseIndex === -1) {
        console.error(`ERROR: Case "${caseId}" not found in ${term}/cases.json`);
        process.exit(1);
    }

    const theCase = cases[caseIndex];
    const decisionDate = theCase.decision || theCase.argument || '';

    if (!decisionDate) {
        console.error(`ERROR: Case "${caseId}" has no decision or argument date`);
        process.exit(1);
    }

    // Get all justices serving on decision date
    const servingJustices = justicesServingOn(decisionDate);

    if (servingJustices.length === 0) {
        console.error(`ERROR: No justices found serving on ${decisionDate}`);
        process.exit(1);
    }

    console.log(`Justices serving on ${decisionDate}: ${servingJustices.length}`);
    console.log(`  ${servingJustices.map(titleCase).join(', ')}`);

    // Helper to resolve a name (tries exact match, then last name among serving justices)
    function resolveName(name, context) {
        let canonical = canonicalName(name);
        if (_justicesTenures[canonical] && isServingOn(canonical, decisionDate)) {
            return canonical;
        }

        // Try matching by last name among justices serving on the date
        const targetLast = name.trim().toUpperCase();
        const matches = servingJustices.filter(c => {
            const parts = c.split(/\s+/);
            const lastName = parts[parts.length - 1];
            return lastName === targetLast;
        });

        if (matches.length === 0) {
            console.error(`ERROR: ${context} "${name}" not found among justices serving on ${decisionDate}`);
            console.error(`Serving: ${servingJustices.map(titleCase).join(', ')}`);
            process.exit(1);
        } else if (matches.length > 1) {
            console.error(`ERROR: Ambiguous ${context} "${name}" matches multiple justices:`);
            console.error(`  ${matches.map(titleCase).join(', ')}`);
            process.exit(1);
        }
        return matches[0];
    }

    if (partialUpdate) {
        // PARTIAL UPDATE MODE: modify existing votes
        if (!Array.isArray(theCase.votes)) {
            theCase.votes = [];
        }

        console.log(`\nPartial update mode - modifying existing votes`);

        // Normalize names
        const minorityCanonical = minority.map(n => resolveName(n, 'Minority justice'));
        const recusedCanonical = recused.map(n => resolveName(n, 'Recused justice'));
        const dissentCanonical = dissent.map(n => resolveName(n, 'Dissent author'));

        // Build a map of existing votes by canonical name
        const existingVotesMap = new Map();
        for (const voteEntry of theCase.votes) {
            const canonical = canonicalName(voteEntry.name);
            existingVotesMap.set(canonical, voteEntry);
        }

        // Update or add votes for minority and recused justices
        const minoritySet = new Set(minorityCanonical);
        const recusedSet = new Set(recusedCanonical);
        const dissentSet = new Set(dissentCanonical);

        for (const canonical of minorityCanonical) {
            if (existingVotesMap.has(canonical)) {
                existingVotesMap.get(canonical).vote = 'minority';
            } else {
                existingVotesMap.set(canonical, { name: canonical, vote: 'minority' });
            }
        }

        for (const canonical of recusedCanonical) {
            if (existingVotesMap.has(canonical)) {
                existingVotesMap.get(canonical).vote = 'recused';
            } else {
                existingVotesMap.set(canonical, { name: canonical, vote: 'recused' });
            }
        }

        // Mark dissent authors
        for (const canonical of dissentCanonical) {
            const entry = existingVotesMap.get(canonical);
            if (entry) {
                if (entry.vote !== 'minority') {
                    console.error(`ERROR: Dissent author ${titleCase(canonical)} must be in the minority`);
                    process.exit(1);
                }
                entry.dissent = true;
            } else {
                console.error(`ERROR: Dissent author ${titleCase(canonical)} not found in votes`);
                process.exit(1);
            }
        }

        // If there are serving justices not yet in the votes, add them as majority
        for (const canonical of servingJustices) {
            if (!existingVotesMap.has(canonical)) {
                existingVotesMap.set(canonical, { name: canonical, vote: 'majority' });
            }
        }

        // Rebuild votes array from map (with reordered keys)
        theCase.votes = Array.from(existingVotesMap.values()).map(v => reorderVote(v));

        // Recalculate counts
        const majorityCount = theCase.votes.filter(v => v.vote === 'majority').length;
        const minorityCount = theCase.votes.filter(v => v.vote === 'minority').length;
        const recusedCount = theCase.votes.filter(v => v.vote === 'recused').length;

        theCase.voteMajority = majorityCount;
        theCase.voteMinority = minorityCount;

        // Re-sort by seniority
        theCase.votes = sortVotesBySeniority(theCase.votes, decisionDate);

        console.log(`\nUpdated vote breakdown:`);
        console.log(`  Majority: ${majorityCount}`);
        console.log(`  Minority: ${minorityCount}`);
        console.log(`  Recused: ${recusedCount}`);
        console.log(`  Total: ${majorityCount + minorityCount + recusedCount} of ${servingJustices.length} serving`);

        // Find opinion author (if any)
        const opinionAuthor = theCase.votes.find(v => v.opinion === true);
        if (opinionAuthor) {
            console.log(`\nOpinion author: ${titleCase(canonicalName(opinionAuthor.name))}`);
        }

        // Reorder keys
        cases[caseIndex] = reorderCase(theCase);

        // Write back
        _writeJson(casesPath, cases);

        console.log(`\n✓ Updated ${term}/${caseId} in cases.json`);
        console.log(`  Vote: ${majorityCount}-${minorityCount}`);
        if (theCase.result) {
            console.log(`  Result: ${theCase.result}`);
        }

    } else {
        // FULL UPDATE MODE: replace all vote data
        const { outcome, voteString, author } = parsedArgs;

        const votes = parseVoteString(voteString);
        const totalVotes = votes.majority + votes.minority;

        // Validate outcome
        if (outcome !== 'win' && outcome !== 'loss') {
            console.error(`ERROR: Outcome must be "win" or "loss", got "${outcome}"`);
            process.exit(1);
        }

        const result = outcome === 'win'
            ? 'petitioning party received a favorable disposition'
            : 'no favorable disposition for petitioning party apparent';

        // Normalize author name
        const authorCanonical = resolveName(author, 'Author');

        // Normalize minority, recused, and dissent names
        const minorityCanonical = minority.map(n => resolveName(n, 'Minority justice'));
        const recusedCanonical = recused.map(n => resolveName(n, 'Recused justice'));
        const dissentCanonical = dissent.map(n => resolveName(n, 'Dissent author'));

        // Dissent authors are automatically in the minority - combine them
        const allMinorityCanonical = [...new Set([...minorityCanonical, ...dissentCanonical])];

        // Validate counts
        if (votes.minority > 0 && allMinorityCanonical.length !== votes.minority) {
            console.error(`ERROR: Vote string indicates ${votes.minority} minority vote(s), but ${allMinorityCanonical.length} justice(s) provided (${minorityCanonical.length} from --minority, ${dissentCanonical.length} from --dissent)`);
            process.exit(1);
        }

        const expectedTotal = totalVotes + recusedCanonical.length;
        if (expectedTotal > servingJustices.length) {
            console.error(`ERROR: Total votes (${totalVotes}) + recused (${recusedCanonical.length}) = ${expectedTotal} exceeds justices serving (${servingJustices.length})`);
            process.exit(1);
        }

        // Build votes array
        const voteEntries = [];
        const minoritySet = new Set(allMinorityCanonical);
        const recusedSet = new Set(recusedCanonical);
        const dissentSet = new Set(dissentCanonical);

        for (const canonical of servingJustices) {
            let vote;
            if (recusedSet.has(canonical)) {
                vote = 'recused';
            } else if (minoritySet.has(canonical)) {
                vote = 'minority';
            } else {
                vote = 'majority';
            }

            const entry = {
                name: canonical,
                vote: vote,
            };

            // Mark opinion author
            if (canonical === authorCanonical && vote === 'majority') {
                entry.opinion = true;
            }

            // Mark dissent author
            if (dissentSet.has(canonical) && vote === 'minority') {
                entry.dissent = true;
            }

            voteEntries.push(reorderVote(entry));
        }

        // Sort by seniority
        const sortedVotes = sortVotesBySeniority(voteEntries, decisionDate);

        // Validate that we didn't miss anyone or double-count
        const majorityCount = sortedVotes.filter(v => v.vote === 'majority').length;
        const minorityCount = sortedVotes.filter(v => v.vote === 'minority').length;
        const recusedCount = sortedVotes.filter(v => v.vote === 'recused').length;

        if (majorityCount !== votes.majority) {
            console.error(`ERROR: Expected ${votes.majority} majority votes, got ${majorityCount}`);
            process.exit(1);
        }
        if (minorityCount !== votes.minority) {
            console.error(`ERROR: Expected ${votes.minority} minority votes, got ${minorityCount}`);
            process.exit(1);
        }

        console.log(`\nVote breakdown:`);
        console.log(`  Majority: ${majorityCount}`);
        console.log(`  Minority: ${minorityCount}`);
        console.log(`  Recused: ${recusedCount}`);
        console.log(`  Total: ${majorityCount + minorityCount + recusedCount} of ${servingJustices.length} serving`);
        console.log(`\nOpinion author: ${titleCase(authorCanonical)}`);

        // Update case
        theCase.result = result;
        theCase.voteMajority = votes.majority;
        theCase.voteMinority = votes.minority;
        theCase.votes = sortedVotes;

        // Reorder keys
        cases[caseIndex] = reorderCase(theCase);

        // Write back
        _writeJson(casesPath, cases);

        console.log(`\n✓ Updated ${term}/${caseId} in cases.json`);
        console.log(`  Result: ${result}`);
        console.log(`  Vote: ${votes.majority}-${votes.minority}`);
    }
}

main();
