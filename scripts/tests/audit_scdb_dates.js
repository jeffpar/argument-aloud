// Refined SCDB argument/reargument audit + fixer.
//
// Scope: every case whose id matches a row in scdb/current/{legacy,modern}.csv,
// checked independently for "argument" and "reargument".
//
// For each such (case, prop):
//   - csvIso = the CSV's dateArgument/dateRearg (first/only date SCDB stores),
//     normalized to YYYY-MM-DD, or null if blank.
//   - ourDates = c[prop] split on comma.
//   - matched = csvIso is one of ourDates.
//
//   Expected state (audit condition):
//     csvIso present  & matched     -> no "SCDB <prop> date (X) incorrect" message
//     csvIso present  & !matched    -> exactly that message, citing csvIso
//     csvIso blank                  -> scdb_check has <prop>, and scdb_message
//                                       has "SCDB <prop> date missing" (renamed
//                                       from the old "SCDB <prop> dates incomplete"
//                                       wording if that's what's already there,
//                                       otherwise newly added).
//   Anything else is an audit failure (reported, not auto-fixed, since it
//   means the existing scdb_check/message machinery disagrees with itself).
//   (As of the update_cases.js fix for this same logic, this branch should
//   always come back clean — kept here as a standing consistency check.)
//
// Independently, per EVENT of type "argument"/"reargument" (regardless of its
// current source): its date is compared against csvIso.
//   - date === csvIso   -> that's the one date SCDB actually attests to, so
//     the event's source should be "scdb" (retagged if it currently isn't —
//     e.g. imported as "ussc" but happens to match SCDB's own date, as with
//     1876-240's March 26 event).
//   - date !== csvIso    -> the opposite: an event still tagged "scdb" whose
//     own date SCDB doesn't corroborate gets retagged to "journal" (if it has
//     journal_ref), "minutes" (if it has minutes_src), or "ussc" otherwise.
//
// Also flags (report-only, no auto-fix — resolving this needs a human to
// figure out whether a date or an event is the thing that's actually wrong)
// any case where the number of comma-split dates in "argument"/"reargument"
// doesn't equal the number of *eligible* events of that type (see below) —
// but only among audio-less citation-only cases. An audio-bearing case has
// too many legitimate reasons for the count to differ for this check to mean
// anything there: Oyez sometimes splits one day's argument into multiple
// "Part 1"/"Part 2" events, a consolidated docket can carry one event per
// sub-case for a single shared date, and a `redundant: true` event is a
// deliberate second (e.g. "ussc") copy of a date already covered by a
// primary "oyez" audio event (see EVENT_KEY_ORDER's `redundant` in
// schema.js) — none of which mean a date or event is actually missing.
//
// Source re-tagging is scoped the same way: only bare, audio-less citation
// entries (scdb/journal/minutes/ussc/etc. with no audio_url/video_url and
// not redundant) are eligible. An oyez/nara/otd event's "source" records
// where its actual audio/video came from, not "what backs up this date" —
// touching those would be wrong even if the date happens to equal SCDB's.
//
// Run with --apply to write changes; without it, this only reports.
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { reorderCase } from '../schema.js';

const APPLY = process.argv.includes('--apply');
const ROOT = new URL('..', import.meta.url).pathname;
const TERMS_DIR = join(ROOT, 'courts/ussc/terms');

function parseCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false; }
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function loadScdbDates(csvPath) {
  const text = readFileSync(csvPath, 'utf8');
  const lines = text.split('\n').filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const idxCaseId = header.indexOf('caseId');
  const idxArg = header.indexOf('dateArgument');
  const idxRearg = header.indexOf('dateRearg');
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const caseId = cols[idxCaseId];
    if (!caseId || map.has(caseId)) continue;
    map.set(caseId, { argument: cols[idxArg] || null, rearg: cols[idxRearg] || null });
  }
  return map;
}

function toIso(raw) {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!m) return null;
  const [, mo, d, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const legacy = loadScdbDates(join(ROOT, 'scdb/current/legacy.csv'));
const modern = loadScdbDates(join(ROOT, 'scdb/current/modern.csv'));
const scdbLookup = (caseId) => legacy.get(caseId) || modern.get(caseId) || null;

const PROPS = ['argument', 'reargument'];
const partCategory = (part) => /^SCDB argument/.test(part) ? 0 : /^SCDB reargument/.test(part) ? 1 : /^SCDB decision/.test(part) ? 2 : 3;

const report = []; // { term, id, title, number, prop, dateValue, kinds: Set }

const termDirs = readdirSync(TERMS_DIR).filter(d => /^\d{4}-10$/.test(d)).sort();
for (const termDir of termDirs) {
  const casesPath = join(TERMS_DIR, termDir, 'cases.json');
  let cases;
  try { cases = JSON.parse(readFileSync(casesPath, 'utf8')); } catch { continue; }
  let fileChanged = false;

  for (const c of cases) {
    const row = scdbLookup(c.id);
    if (!row) continue;

    for (const prop of PROPS) {
      const propEvents = (c.events || []).filter(e => e.type === prop);
      // Only a bare citation entry (no content of its own — no audio/video,
      // no transcript in any form, no advocate list) has a "source" that
      // really just means "which record backs up this date". Anything with
      // real content keeps its own provenance regardless of what SCDB says —
      // including an Oyez entry with an *empty* audio_url (audio missing but
      // still a genuine aligned transcript, e.g. 2019-016) — and a redundant
      // duplicate is never the canonical record for its date either way.
      // Same bare-citation set is used for the date/event count check below:
      // an audio-or-transcript-bearing case has too many legitimate reasons
      // (Oyez multi-part splits, one event per consolidated docket, etc.) for
      // its raw event count to differ from its date count.
      const isBareCitation = (e) => !e.redundant && !e.audio_url && !e.video_url
        && !e.text_file && !e.transcript_url && !e.advocates && !e.aligned;
      const eligibleEvents = propEvents.filter(isBareCitation);
      const hasContentEvents = propEvents.some(e => !isBareCitation(e));
      const ourDates = String(c[prop] || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!propEvents.length && !ourDates.length) continue;

      const csvRaw = prop === 'argument' ? row.argument : row.rearg;
      const csvIso = toIso(csvRaw);
      const matched = csvIso != null && ourDates.includes(csvIso);

      const kinds = new Set();

      // Structural consistency: one citation-only event per date. Skipped
      // entirely for audio-bearing cases (see eligibleEvents comment above).
      if (!hasContentEvents && ourDates.length !== eligibleEvents.length) {
        kinds.add(`FAIL: ${ourDates.length} date(s) in ${prop} (${ourDates.join(',') || '(none)'}) but ${eligibleEvents.length} ${prop} event(s)`);
      }

      let msgParts = String(c.scdb_message || '').split(';').map(s => s.trim()).filter(Boolean);
      const incorrectRe = new RegExp(`^SCDB ${prop} date \\((\\d{4}-\\d{2}-\\d{2})\\) incorrect$`);
      const incompleteMsg = `SCDB ${prop} dates incomplete`;
      const missingMsg = `SCDB ${prop} date missing`;
      const incorrectPart = msgParts.find(p => incorrectRe.test(p));

      if (csvIso) {
        const expected = `SCDB ${prop} date (${csvIso}) incorrect`;
        if (matched && incorrectPart) {
          kinds.add(`FAIL: stale "${incorrectPart}" despite SCDB ${prop} date ${csvIso} matching ours`);
        } else if (!matched && !incorrectPart) {
          kinds.add(`FAIL: SCDB ${prop} date ${csvIso} disagrees with ours (${ourDates.join(',')}) but no incorrect-date message present`);
        } else if (!matched && incorrectPart && incorrectPart !== expected) {
          kinds.add(`FAIL: message "${incorrectPart}" does not match expected "${expected}"`);
        }
      } else if (ourDates.length) {
        // SCDB has nothing at all for this prop, but we claim a date of our
        // own — a blank on both sides (e.g. a case never reargued) is a
        // match, not a problem, so this only applies when ourDates is non-empty.
        const checks = new Set(String(c.scdb_check || '').split(',').map(s => s.trim()).filter(Boolean));
        let changed = false;
        if (msgParts.includes(incompleteMsg)) {
          msgParts = msgParts.map(p => p === incompleteMsg ? missingMsg : p);
          changed = true;
        } else if (!msgParts.includes(missingMsg)) {
          msgParts.push(missingMsg);
          changed = true;
        }
        if (!checks.has(prop)) { checks.add(prop); changed = true; c.scdb_check = [...checks].join(','); }
        if (changed) {
          msgParts.sort((a, b) => partCategory(a) - partCategory(b));
          c.scdb_message = msgParts.join('; ');
          kinds.add(`MESSAGE UPDATED: scdb_message now "${c.scdb_message}"`);
          fileChanged = true;
        }
      }

      // Per-event source re-tagging: whichever event's own date literally
      // equals csvIso is the one SCDB actually attests to, so it (and only
      // it) should be tagged "scdb" -- in either direction. Scoped to
      // eligibleEvents only (see above) so audio/video/redundant events are
      // never touched.
      for (const ev of eligibleEvents) {
        const isMatch = csvIso != null && ev.date === csvIso;
        if (isMatch && ev.source !== 'scdb') {
          kinds.add(`SOURCE CHANGED: [${prop}: ${ev.date}] ${ev.source} -> scdb`);
          if (APPLY) ev.source = 'scdb';
          fileChanged = true;
        } else if (!isMatch && ev.source === 'scdb') {
          const newSource = ev.journal_ref ? 'journal' : (ev.minutes_src ? 'minutes' : 'ussc');
          kinds.add(`SOURCE CHANGED: [${prop}: ${ev.date}] scdb -> ${newSource}`);
          if (APPLY) ev.source = newSource;
          fileChanged = true;
        }
      }

      if (kinds.size) {
        report.push({
          term: termDir, id: c.id, title: c.title, number: c.number,
          prop, dateValue: c[prop] || '(none)', kinds: [...kinds],
        });
      }
    }
  }

  if (APPLY && fileChanged) {
    const reordered = cases.map(c => reorderCase(c));
    writeFileSync(casesPath, JSON.stringify(reordered, null, 2) + '\n', 'utf8');
  }
}

console.log(APPLY ? '=== APPLIED ===\n' : '=== DRY RUN (pass --apply to write changes) ===\n');
for (const r of report) {
  console.log(`${r.term} ${r.id} (No. ${r.number}) — ${r.title} [${r.prop}: ${r.dateValue}]`);
  for (const k of r.kinds) console.log(`    ${k}`);
}
console.log(`\n${report.length} case/prop combination(s) flagged.`);
