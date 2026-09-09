#!/usr/bin/env node
/**
 * One-off: normalise wasc case titles in courts/wasc/terms/YYYY/{cases,dates}.json.
 *
 *   node scripts/tests/normalize_wasc_titles.js [--write]
 *
 * Rules (agreed with Jeff):
 *  - "In re [the] <family> of ..." -> "In re <Family> of ..." with the family
 *    word spelled out and Title-cased, leading "the" dropped:
 *      Personal Restraint (incl. "Pers. Restraint", "... Petition"),
 *      Estate, Dependency, Detention (incl. "Det."), Marriage, Custody, Recall,
 *      Welfare, Parentage, Paternity, Adoption, Guardianship, Termination.
 *  - A party that is exactly "State" -> "State of Washington"
 *    (skipped, and listed, for the broken 1997-99 tofj titles where the OTHER
 *     party is junk: "State", "them", "and", "officer", "Mother", lowercase, …).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TERMS = path.join(ROOT, 'courts/wasc/terms');
const WRITE = process.argv.includes('--write');

const IN_RE_FAMILY = [
    ['Personal Restraint', /^(?:personal|pers\.?)\s+restraint(?:\s+petition)?$/i],
    ['Estate',        /^estate$/i],
    ['Dependency',    /^dependency$/i],
    ['Detention',     /^(?:detention|det\.?)$/i],
    ['Marriage',      /^marriage$/i],
    ['Custody',       /^custody$/i],
    ['Recall',        /^recall$/i],
    ['Welfare',       /^welfare$/i],
    ['Parentage',     /^parentage$/i],
    ['Paternity',     /^paternity$/i],
    ['Adoption',      /^adoption$/i],
    ['Guardianship',  /^guardianship$/i],
    ['Termination',   /^termination$/i],
];

// the OTHER party is junk -> the "State" side is really a broken title, skip it
const JUNK_PARTY = /^(?:state|them|and|it|the|us|him|her|officer|individual|mother|father|a|an|petitioner|respondent|appellant|appellee)$/i;

function normTitle(raw) {
    let s = String(raw || '');
    const skips = [];

    // ── "In re ..." family ──
    const m = /^in\s+re\s+(?:the\s+)?(.+?)\s+of\b(.*)$/i.exec(s);
    if (m) {
        for (const [canon, re] of IN_RE_FAMILY) {
            if (re.test(m[1].trim())) { s = `In re ${canon} of${m[2]}`; break; }
        }
    }

    // Older tofj titles for the same thing without the "In re" prefix:
    //   "Personal Restraint Petition of X, Petitioner"
    //   "In the Matter of the Personal Restraint [Petition] of[:] X"
    // -> "In re Personal Restraint of X"  (drop a trailing ", Petitioner").
    const pr = /^(?:in\s+the\s+matter\s+of\s+the\s+)?(?:personal|pers\.?)\s+restraint(?:\s+petition)?\s+of:?\s+(.+?)(?:,\s*Petitioners?\.?)?$/i.exec(s);
    if (pr && !/^in re /i.test(s)) s = `In re Personal Restraint of ${pr[1].trim()}`;

    // ── bare "State" party -> "State of Washington" ──
    if (/(^|\sv\.?\s)state(\sv\.?\s|$)/i.test(s)) {
        const segs = s.split(/(\s+v\.?\s+)/i);           // [party, sep, party, sep, …]
        const parties = segs.filter((_, i) => i % 2 === 0);
        const others = parties.filter((p) => !/^\s*state\s*$/i.test(p)).map((p) => p.trim());
        const broken = parties.some((p) => /^\s*state\s*$/i.test(p))
            && (others.length === 0 || others.every((o) => JUNK_PARTY.test(o) || /^[a-z]/.test(o) || o === ''));
        if (broken) {
            skips.push(s);
        } else {
            s = segs.map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/^(\s*)State(\s*)$/, '$1State of Washington$2'))).join('');
        }
    }

    return { s, skips };
}

let changed = 0, filesChanged = 0;
const allSkips = new Set();
const sample = [];

for (const y of fs.readdirSync(TERMS).sort()) {
    for (const fname of ['cases.json', 'dates.json']) {
        const p = path.join(TERMS, y, fname);
        if (!fs.existsSync(p)) continue;
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        let fileHits = 0;

        const fix = (obj) => {
            if (!obj || typeof obj.title !== 'string') return;
            const { s, skips } = normTitle(obj.title);
            for (const k of skips) allSkips.add(`${y}  ${obj.id ? obj.id + '  ' : ''}${k}`);
            if (s !== obj.title) {
                if (process.argv.includes('--all') || sample.length < 40) sample.push(`  ${obj.title}\n     -> ${s}`);
                obj.title = s; fileHits++; changed++;
            }
        };

        if (Array.isArray(j)) j.forEach(fix);                       // cases.json
        else for (const k of Object.keys(j)) j[k].forEach(fix);     // dates.json

        if (fileHits) {
            filesChanged++;
            if (WRITE) fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
            console.log(`${WRITE ? 'wrote' : 'would fix'}  ${path.relative(ROOT, p)}  (${fileHits})`);
        }
    }
}

console.log(`\n${changed} title(s) ${WRITE ? 'changed' : 'would change'} across ${filesChanged} file(s)`);
if (sample.length) console.log('\nsample:\n' + sample.join('\n'));
if (allSkips.size) {
    console.log(`\n${allSkips.size} broken "State ..." title(s) skipped (fix by hand):`);
    [...allSkips].sort().forEach((l) => console.log('  ' + l));
}
