#!/usr/bin/env node
/**
 * scripts/parse_minutes.js
 *
 * Given a NARA "Minutes of the U.S. Supreme Court" (M215)
 * volume URL (e.g. https://catalog.archives.gov/id/178847707), fetches
 * every page's own "Extracted Text" (NARA's OCR, via the same proxy API
 * catalog.archives.gov's own frontend uses — the catalog page itself is a
 * client-rendered SPA with nothing to scrape) and saves each to
 * courts/ussc/minutes/text/<year>/<basename>.txt, where:
 *   - <year> is parsed from the date at the top of that page's own text
 *     (a volume can span a year boundary, so this is done per page, not
 *     once for the whole volume) — falling back to the last year
 *     successfully parsed from an earlier page in this same run when a
 *     given page's OCR text doesn't show one (e.g. a garbled or blank page),
 *     or when the extracted year falls outside the volume's own valid
 *     range (see below)
 *   - <basename> matches the page's own image filename (e.g. "M215-018-0006"
 *     — the basename of what would be its Download link) with .txt instead
 *     of .jpg
 *
 * The record's own catalog title (e.g. "Volumes 54 - 57; May 13, 1889 -
 * March 7, 1892") gives the valid year range for every page in the volume;
 * any OCR year found outside that range is treated the same as no year
 * found at all (falls back to the previous page's year).
 *
 * Pages whose output .txt file already exists (in any year folder) are not
 * re-fetched — re-running this script against the same volume is cheap and
 * safe. Loaded-from-disk pages still go through date extraction below, so
 * dates.json can be rebuilt/extended without re-fetching anything.
 *
 * For every page (freshly fetched or loaded from disk), a full date is
 * parsed from the top of its text (e.g. "May 13th, 1889" -> "1889-05-13").
 * These per-page raw dates are then reconciled in a second, page-order-only
 * pass (see smoothDates()): a page whose date disagrees with the current
 * "frontier" date is only trusted if more of the next few pages agree with
 * it than agree with the frontier — otherwise it's dropped in favor of the
 * frontier, same as a page with no date at all. This catches not just an
 * isolated misread (no corroboration either way, frontier wins) but also a
 * single garbled page whose OCR jumps far from its neighbors and would
 * otherwise become a false new frontier that every subsequent *correct*
 * page then looks like it's "going backward" from — when a look-ahead
 * confirms the earlier frontier was itself the mistake, the pages already
 * assigned to it are retroactively corrected too. It's then recorded in
 * courts/ussc/terms/<term>/dates.json — <term> being
 * whichever term's own start date is the latest one on/before that date —
 * as:
 *   { "1889-05-13": [
 *       { "type": "minutes",
 *         "href": "https://catalog.archives.gov/id/178847707?objectPage=$page",
 *         "src": ".../M215-018/M215-018-$page:4.jpg",
 *         "pages": "6-7" }
 *     ] }
 * Each date maps to an *array* of objects, every one of which starts with a
 * "type" prop identifying what kind it is — "minutes" for a Minutes-scan
 * group (this script's own concern), or "argument"/"reargument" for a
 * cross-term case-detail pointer (see update_cases.js's
 * syncCrossTermCaseDates) — checked everywhere a date's array is read,
 * rather than inferring the kind from which props happen to be present.
 * A date maps to an *array* of Minutes groups rather than a single one
 * because a calendar day's minutes occasionally spans two different
 * physical volumes (NARA splits a session's pages across consecutive
 * volumes at whatever point the microfilm roll ends) — grouping by source
 * keeps href/src accurate per page instead of one group's template getting
 * wrongly applied to another volume's page numbers. The common case is
 * still just a one-element array. pages holds a "<first>-<last>" range
 * string of the page's 1-based position(s) within ITS volume (matching the
 * `objectPage` query param NARA's own catalog URLs use) — every group's own
 * pages are always a gap-free consecutive run in practice, so this is more
 * compact than an array while staying just as exact; "" for an empty/
 * tombstone group (see handleMinutesDrop in terms.js). This script
 * (loadDatesJson/writeDatesJson/parsePagesRange/formatPagesRange below),
 * terms.js, and explorer.js each expand it back into a plain array of page
 * numbers for their own processing, converting back to this string only
 * when writing/serializing. href is that volume's catalog URL with a
 * literal "$page" placeholder, and src the direct image download URL with a
 * literal "$page:4" placeholder (the ":4" meaning zero-padded to 4 digits,
 * since — unlike the catalog URL's plain query-string page number — the
 * image filename itself embeds the page number that way) — both for the
 * frontend to substitute per page.
 * dates.json is created if missing; existing Minutes-scan entries are
 * rewritten in this same {type, href, src, pages} key order every time
 * they're touched, so older entries (including pre-this-shape ones) self-
 * heal into the current shape as new pages come in for the same date. A
 * group written by applying a downloaded overrides file (see below) instead
 * carries a trailing "modified": true — this run's own OCR-derived Pass 3
 * (further down) always leaves such a group untouched, even if it disagrees
 * with what the OCR text on this run says, so a manual browser correction
 * can never be silently re-overwritten by a later re-run of this script.
 *
 * Usage:
 *   node scripts/parse_minutes.js <volume-url> [--dry-run] [--limit N]
 *   node scripts/parse_minutes.js --thumbnails [--dry-run]
 *   node scripts/parse_minutes.js <overrides-file.json> [--dry-run]
 *   node scripts/parse_minutes.js [TERM] [--dry-run]
 *   node scripts/parse_minutes.js --verify [TERM]
 *   node scripts/parse_minutes.js --backfill [TERM] [--dry-run]
 *
 *   --dry-run     Report what would be saved without writing any files
 *   --limit N     Only process the first N pages (for a quick test run —
 *                 a full volume can be 1000+ pages)
 *   --thumbnails  Separate mode (no volume-url): for every term with a
 *                 dates.json, generate one cover thumbnail per unique
 *                 src template found in it (i.e. one per physical
 *                 roll referenced by that term, not one per date/page) —
 *                 courts/ussc/terms/<term>/m<XXX>-cover.jpg, a 1340px-tall
 *                 proportional resize (via macOS's `sips`) of the first
 *                 page number seen for that template, where <XXX> is the
 *                 3-digit roll number in "M215-XXX". dates.json itself is
 *                 never modified by this mode — the roll number embedded in
 *                 each group's own src is enough to derive its cover
 *                 filename on demand; update_cases.js's syncTermsJson reads
 *                 that back into terms.json's own per-term "minutes" array
 *                 (see there).
 *
 * Applying a downloaded overrides file: the term stats page's Minutes Pages
 * list (assets/js/terms.js) lets a visitor drag a page number onto a
 * calendar day to reassign it (and every later page in its source group) to
 * that date — these edits are kept in that browser's own localStorage and
 * can be exported via the site's "Download Dates" menu item into a flat
 * JSON file: { "<ISO date>": <array-of-groups> | null, ... }, one entry per
 * date the visitor touched, `null` meaning that date's entry should be
 * removed entirely. Passing that file as the positional argument here
 * (instead of a volume URL) looks up each date's own term (same "latest
 * term starting on/before this date" rule used everywhere else in this
 * script) and applies the change directly to that term's own dates.json —
 * across as many different terms' files as the overrides touch.
 *
 * Backfilling the local text cache (no volume-url, no overrides file): with
 * no positional argument at all (or just a bare TERM like "1888-10", to
 * scope it to one term instead of every term with a dates.json), this
 * reconciles courts/ussc/minutes/text/<year>/ against dates.json's own,
 * already-resolved dates rather than re-deriving them — dates.json is only
 * ever read here, never rewritten. For every unique href a term's
 * dates.json references (its own "?..." query string stripped back down to
 * a bare volume URL first), and every page number dates.json says belongs to
 * it: if <year>/<basename>.txt already exists where dates.json's own
 * resolved date for that page says it should (<year> being that date's
 * calendar year), nothing to do. Otherwise, since an earlier, less accurate
 * run of the OCR date-parsing above may have originally filed it under a
 * different year within the volume's own valid range (see the record's
 * title-derived year range above), every other year in that range is
 * checked first — if found there, the file is moved into the expected year
 * folder instead of being re-downloaded. Only if it's genuinely missing
 * everywhere in that range is it fetched fresh from NARA.
 *
 * Verifying consistency (--verify [TERM]): read-only sanity check of every
 * term's (or just TERM's) dates.json — see verifyMinutesConsistency's own
 * doc comment for the exact four invariants it checks. Nothing is ever
 * written; problems are only reported.
 *
 * Backfilling missing pages (--backfill [TERM]): for every gap --verify's
 * own 4th invariant would report, tries to work out which date it actually
 * belongs to (from cached or freshly-fetched OCR text, narrowed to the date
 * range the two surrounding known pages already bound it to) and adds it —
 * see runBackfill's own doc comment for exactly how a date gets picked, and
 * what happens when none can be extracted at all.
 */

import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MINUTES_DIR = join(ROOT, 'courts', 'ussc', 'minutes', 'text');
const TERMS_DIR = join(ROOT, 'courts', 'ussc', 'terms');

// M215 covers 1790-1950; matched against just the first ~200 characters of
// a page's text ("at the top"), not the whole thing, so a case citation or
// other later-appearing year deeper in the page can't be mistaken for it.
const YEAR_RE = /\b(1[789]\d{2}|19[0-4]\d|1950)\b/;

// Matches any 4-digit year in the record's own catalog title, e.g.
// "Volumes 54 - 57; May 13, 1889 - March 7, 1892" -> [1889, 1892]. The
// "Volumes 54 - 57" part never matches (only 2 digits), so no need to
// anchor on month names here.
const TITLE_YEAR_RE = /\b(1[6-9]\d{2}|20\d{2})\b/g;

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).join('|');
// A full date near the top of a page's OCR text, e.g. "May 13th, 1889" or
// "March 7, 1892" — the weekday that usually precedes it is skipped since
// OCR garbles it too unreliably to match on (e.g. "Wouday" for "Monday").
// The comma is optional and can land on either side of the day (OCR is
// inconsistent about it — "March 7, 1892" and "march, 7th, 1892" both
// occur), so it's matched loosely on both sides rather than anchored once
// after the day the way a hand-typed date reliably would be. The gap
// between the day and the year also tolerates stray OCR noise beyond just
// comma/whitespace — an apostrophe, a stray quote, a degree/ordinal-
// indicator sign (all typically standing in for a garbled "nd"/"th"
// superscript, e.g. "May 2°, 1887" or "May 2', 1887") — since without it
// that page's own duplicate, more-garbled heading line ("May 20 1887",
// "2nd" misread as "20") matches instead and produces a wrong date weeks
// off from the correct one.
const FULL_DATE_RE = new RegExp(`\\b(${MONTH_NAMES})\\s*,?\\s*(\\d{1,2})(?:st|nd|rd|th)?[.,'"°ºª\\s]*(\\d{4})\\b`, 'i');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseVolumeUrl(url) {
  const m = /\/id\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

async function fetchRecordMeta(naId) {
  const url = `https://catalog.archives.gov/proxy/records/search?naId=${naId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching record ${naId}`);
  const data = await res.json();
  const record = data?.body?.hits?.hits?.[0]?._source?.record;
  const objs = record?.digitalObjects;
  if (!Array.isArray(objs) || !objs.length) throw new Error(`No digitalObjects found for naId ${naId}`);
  return { objs, title: record?.title || null };
}

async function fetchExtractedText(naId, objectId) {
  const url = `https://catalog.archives.gov/proxy/extractedText/${naId}?objectId=${objectId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching extracted text for object ${objectId}`);
  const data = await res.json();
  return data?.digitalObjects?.[0]?.extractedText || null;
}

// { min, max } from every 4-digit year mentioned in the volume's own
// catalog title, or null if the title has none (unrestricted matching).
function parseVolumeYearRange(title) {
  if (!title) return null;
  const years = [...title.matchAll(TITLE_YEAR_RE)].map(m => parseInt(m[1], 10));
  if (!years.length) return null;
  return { min: Math.min(...years), max: Math.max(...years) };
}

// basename (no extension) -> year, for every .txt file already on disk
// under MINUTES_DIR, so already-fetched pages can be skipped on a rerun.
function buildExistingIndex() {
  const index = new Map();
  if (!existsSync(MINUTES_DIR)) return index;
  for (const year of readdirSync(MINUTES_DIR)) {
    const yearDir = join(MINUTES_DIR, year);
    if (!statSync(yearDir).isDirectory()) continue;
    for (const file of readdirSync(yearDir)) {
      if (file.endsWith('.txt')) index.set(file.slice(0, -4), year);
    }
  }
  return index;
}

// [{ term, start: 'YYYY-MM-01' }, ...] ascending, from every term folder
// that actually exists (skips index.md and any other stray entry).
function loadTermStarts() {
  return readdirSync(TERMS_DIR)
    .filter(d => /^\d{4}-\d{2}$/.test(d))
    .map(d => ({ term: d, start: `${d.slice(0, 4)}-${d.slice(5, 7)}-01` }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

// The term whose own start date is the latest one on/before dateStr, or
// null if dateStr predates every known term.
function termForDate(dateStr, termStarts) {
  let found = null;
  for (const t of termStarts) {
    if (t.start <= dateStr) found = t.term;
    else break;
  }
  return found;
}

// yearRange (from the volume title, see parseVolumeYearRange) guards against
// OCR garbage producing a wild year (e.g. "6710" misread from "1870") that
// would otherwise misfile this page into a completely unrelated term via
// termForDate()'s "latest term starting on/before this date" lookup.
function extractFullDate(text, yearRange) {
  const m = FULL_DATE_RE.exec(text.slice(0, 300));
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (day < 1 || day > 31) return null;
  if (yearRange && (year < yearRange.min || year > yearRange.max)) return null;
  if (year < 1600 || year > 2099) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// On disk, a Minutes-scan group's "pages" is a "<first>-<last>" range string
// (every group's own pages are always a gap-free consecutive run — see the
// audit behind this format), or "" for an empty/tombstone group (see
// handleMinutesDrop in terms.js). Every array-based read/mutate site in this
// script (and terms.js's own drag-and-drop editor) works with the expanded
// array form instead — these two convert at the read/write boundary
// (loadDatesJson/writeDatesJson below) so nothing else has to change.
function parsePagesRange(v) {
  if (Array.isArray(v)) return v.slice(); // tolerate not-yet-migrated data
  if (typeof v !== 'string' || !v) return [];
  const m = /^(\d+)-(\d+)$/.exec(v);
  if (!m) return [];
  const first = parseInt(m[1], 10), last = parseInt(m[2], 10);
  if (last < first) return [];
  const out = [];
  for (let p = first; p <= last; p++) out.push(p);
  return out;
}
function formatPagesRange(pages) {
  if (!Array.isArray(pages) || !pages.length) return '';
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  return `${sorted[0]}-${sorted[sorted.length - 1]}`;
}

// Loads a term's dates.json, migrating any pre-array-format entry (a bare
// object, from before a date's pages could span more than one source
// volume) into a one-element array; self-healing an old-shape Minutes group
// (minutes_url/minutes_src/minutes_pages, no "type") into the current
// {type: "minutes", href, src, pages} shape; and expanding every Minutes
// group's own "pages" range string back into an array (see parsePagesRange
// above) for this script's own array-based processing. Every dates.json
// object is identified by its own "type" prop — "minutes" for a Minutes-scan
// group, "argument"/"reargument" for a cross-term case-detail pointer (see
// update_cases.js's syncCrossTermCaseDates) — never by which props happen to
// be present.
function loadDatesJson(term) {
  const p = join(TERMS_DIR, term, 'dates.json');
  if (!existsSync(p)) return {};
  let data;
  try { data = JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
  for (const k of Object.keys(data)) {
    if (!Array.isArray(data[k])) data[k] = [data[k]];
    for (const g of data[k]) {
      if (!g || typeof g !== 'object') continue;
      if (g.type == null && ('minutes_url' in g || 'minutes_src' in g || 'minutes_pages' in g)) {
        g.type = 'minutes';
        if ('minutes_url' in g) { g.href = g.minutes_url; delete g.minutes_url; }
        if ('minutes_src' in g) { g.src = g.minutes_src; delete g.minutes_src; }
        if ('minutes_pages' in g) { g.pages = g.minutes_pages; delete g.minutes_pages; }
      }
      if (g.type === 'minutes') g.pages = parsePagesRange(g.pages);
    }
  }
  return data;
}

// Writes a term's full in-memory dates object back to dates.json — sorted by
// ISO date key, and collapsing every Minutes-scan group's own array-form
// "pages" (see loadDatesJson above) back into its on-disk "<first>-<last>"
// range string (formatPagesRange above). The single write path for every
// mode that touches dates.json, so the array/string conversion boundary
// only has to live in one place.
function writeDatesJson(term, dates) {
  const sorted = {};
  for (const k of Object.keys(dates).sort()) {
    const groups = Array.isArray(dates[k]) ? dates[k] : [dates[k]];
    sorted[k] = groups.map((g) => {
      if (!g || typeof g !== 'object' || g.type !== 'minutes') return g;
      return { ...g, pages: formatPagesRange(g.pages) };
    });
  }
  const p = join(TERMS_DIR, term, 'dates.json');
  writeFileSync(p, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

// Reconciles every page's raw candidate date (records[i].rawDate, possibly
// null) into a final resolved date, in page order. A candidate that
// disagrees with the current "frontier" (the date most recently accepted)
// is only trusted if more of the next LOOKAHEAD non-null candidates agree
// with it than agree with the frontier — otherwise it's rejected, falling
// back to the frontier just like a page with no date at all.
//
// This is what lets a single garbled page's misread (e.g. "2nd" -> "20",
// jumping three weeks ahead) get outvoted by the many correct pages that
// follow it, rather than becoming a false new frontier that poisons every
// subsequent *correct* page as "going backward" from it. When a look-ahead
// confirms a *smaller* candidate over the current frontier, every page
// already assigned to that (now-recognized-as-wrong) frontier is
// retroactively corrected back to the confirmed value.
function smoothDates(records) {
  const LOOKAHEAD = 5;
  const resolved = new Array(records.length).fill(null);
  let lastAccepted = null;
  let frontierRun = []; // indices already resolved to lastAccepted

  const countMatches = (fromIdx, value) => {
    let count = 0, seen = 0;
    for (let j = fromIdx; j < records.length && seen < LOOKAHEAD; j++) {
      const d = records[j].rawDate;
      if (d == null) continue;
      seen++;
      if (d === value) count++;
    }
    return count;
  };

  for (let i = 0; i < records.length; i++) {
    const { label, rawDate: raw } = records[i];

    if (raw == null) {
      if (lastAccepted == null) {
        console.log(`  ${label}: no full date found, and no earlier page to fall back to; skipping dates.json`);
      } else {
        console.log(`  ${label}: no full date found; using previous page's ${lastAccepted}`);
        resolved[i] = lastAccepted;
        frontierRun.push(i);
      }
      continue;
    }

    if (lastAccepted == null || raw === lastAccepted) {
      lastAccepted = raw;
      resolved[i] = raw;
      frontierRun.push(i);
      continue;
    }

    const newCount = countMatches(i + 1, raw);
    const oldCount = countMatches(i + 1, lastAccepted);
    if (newCount > oldCount) {
      if (raw < lastAccepted && frontierRun.length) {
        console.log(`  ${label}: ${raw} confirmed by ${newCount} of the next page(s) — correcting ${frontierRun.length} earlier page(s) back from ${lastAccepted}`);
        for (const j of frontierRun) resolved[j] = raw;
      }
      lastAccepted = raw;
      frontierRun = [i];
      resolved[i] = raw;
    } else {
      console.log(`  ${label}: extracted date ${raw} conflicts with ${lastAccepted} (${newCount} vs ${oldCount} supporting page(s) ahead); ignoring`);
      resolved[i] = lastAccepted;
      frontierRun.push(i);
    }
  }

  return resolved;
}

// One cover thumbnail per unique src template (i.e. per physical roll),
// across every term that has a dates.json — see the --thumbnails doc
// comment at the top of this file for the exact naming/placement rules.
async function runThumbnails(dryRun) {
  const terms = readdirSync(TERMS_DIR)
    .filter(d => /^\d{4}-\d{2}$/.test(d) && existsSync(join(TERMS_DIR, d, 'dates.json')))
    .sort();

  let created = 0, existing = 0, failed = 0;

  for (const term of terms) {
    const dates = loadDatesJson(term);

    // First page number seen for each unique src template, walking dates in
    // sorted (chronological) order so "first" is deterministic.
    const firstPageByTemplate = new Map();
    for (const iso of Object.keys(dates).sort()) {
      const groups = dates[iso];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (g.type !== 'minutes' || !g.src || !Array.isArray(g.pages) || !g.pages.length) continue;
        if (!firstPageByTemplate.has(g.src)) {
          firstPageByTemplate.set(g.src, Math.min(...g.pages));
        }
      }
    }
    if (!firstPageByTemplate.size) continue;

    for (const [template, firstPage] of firstPageByTemplate) {
      const rollMatch = /M215-(\d{3})/.exec(template);
      if (!rollMatch) {
        console.log(`  ${term}: could not parse a roll number from ${template}`);
        failed++;
        continue;
      }
      const xxx = rollMatch[1];
      const coverName = `m${xxx}-cover.jpg`;
      const coverPath = join(TERMS_DIR, term, coverName);

      if (existsSync(coverPath)) {
        existing++;
        continue;
      }
      const page4 = String(firstPage).padStart(4, '0');
      const imgUrl = template.replace('$page:4', page4);
      console.log(`  ${term}: fetching ${imgUrl} -> ${coverName}`);
      if (!dryRun) {
        const tmpPath = join(TERMS_DIR, term, `.${coverName}.raw`);
        try {
          const res = await fetch(imgUrl);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          writeFileSync(tmpPath, Buffer.from(await res.arrayBuffer()));
          execFileSync('sips', ['--resampleHeight', '1340', tmpPath, '--out', coverPath], { stdio: 'ignore' });
        } catch (e) {
          console.log(`  ${term}: ERROR ${e.message || e}`);
          failed++;
          continue;
        } finally {
          if (existsSync(tmpPath)) unlinkSync(tmpPath);
        }
      }
      created++;
    }
  }

  console.log(`\nThumbnails: ${created} created, ${existing} already existed, ${failed} failed.`);
  if (dryRun) console.log('(dry run — no files written)');
}

// Normalizes one override value (a single group object, an array of them,
// possibly hand-edited or from an older format) into the same
// {type, href, src, pages} key order the rest of this script writes, plus a
// trailing `modified: true` — this marks the group as a deliberate,
// browser-made edit so a later re-run of the normal <volume-url> flow
// (Pass 3 below) never overwrites it with a fresh OCR-derived result. A
// downloaded override's own array can also carry a case-detail object (see
// update_cases.js's syncCrossTermCaseDates) alongside any minutes groups,
// exported as-is from the browser's own in-memory copy — identified by
// type !== "minutes" and passed through completely untouched, never coerced
// into minutes-group shape.
//
// A single minutes group's own "pages" is split here into one output group
// per gap-free consecutive run, rather than trusting the override's array to
// already be one contiguous run — terms.js's own drag-and-drop editing can
// legitimately leave a *merged* group non-contiguous (e.g. a middle chunk of
// pages dragged away on one day, then a separate, non-adjacent chunk dragged
// back onto the same date on another day), and writeDatesJson's own
// formatPagesRange can only ever store a single "<first>-<last>" range
// string per group. Left unsplit, that silent min–max collapse would smear
// over the gap and re-absorb pages that already legitimately belong to other
// dates elsewhere in the same file — and since loadDatesJson expands that
// collapsed string back into the *full* contiguous array on the next run,
// the comparison in applyDateOverrides below would never converge: every
// re-run of the very same, unchanged download would keep reporting this
// date as "updated" forever.
function normalizeOverrideGroups(val) {
  const groups = Array.isArray(val) ? val : [val];
  const out = [];
  for (const g of groups) {
    if (g.type !== 'minutes') { out.push(g); continue; }
    const pages = [...new Set(g.pages || [])].sort((a, b) => a - b);
    if (!pages.length) {
      out.push({ type: 'minutes', href: g.href, src: g.src, pages: [], modified: true });
      continue;
    }
    let runStart = pages[0], prev = pages[0];
    const flushRun = (first, last) => {
      const runPages = [];
      for (let p = first; p <= last; p++) runPages.push(p);
      out.push({ type: 'minutes', href: g.href, src: g.src, pages: runPages, modified: true });
    };
    for (let i = 1; i < pages.length; i++) {
      if (pages[i] === prev + 1) { prev = pages[i]; continue; }
      flushRun(runStart, prev);
      runStart = pages[i]; prev = pages[i];
    }
    flushRun(runStart, prev);
  }
  return out;
}

// Applies a downloaded date-overrides file (see the doc comment at the top
// of this file) — a flat { "<ISO date>": <groups>|null } map, possibly
// spanning several terms — directly to each affected term's own dates.json.
// Returns true if every entry resolved to a known term (regardless of
// whether it actually changed anything — "already matched" still counts as
// resolved) — main() below deletes the source file on a clean, non-dry-run
// pass, since a downloaded overrides file has no further purpose once fully
// applied. False if any entry's date fell outside every known term's range,
// which is the only real per-entry failure mode here.
async function applyDateOverrides(filePath, dryRun) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const termStarts = loadTermStarts();
  const datesByTerm = new Map();
  const getDates = (term) => {
    if (!datesByTerm.has(term)) datesByTerm.set(term, loadDatesJson(term));
    return datesByTerm.get(term);
  };

  const changedTerms = new Set();
  let applied = 0, skipped = 0, unresolvable = 0;

  for (const iso of Object.keys(raw)) {
    const term = termForDate(iso, termStarts);
    if (!term) {
      console.log(`  ${iso}: matches no known term; skipping`);
      unresolvable++;
      continue;
    }
    const dates = getDates(term);
    const val = raw[iso];

    if (val === null) {
      if (dates[iso] === undefined) {
        console.log(`  ${iso}: already absent from ${term}/dates.json`);
        skipped++;
        continue;
      }
      delete dates[iso];
      changedTerms.add(term);
      console.log(`  ${iso}: removed from ${term}/dates.json`);
      applied++;
      continue;
    }

    const groups = normalizeOverrideGroups(val);
    if (JSON.stringify(dates[iso]) === JSON.stringify(groups)) {
      console.log(`  ${iso}: already up to date in ${term}/dates.json`);
      skipped++;
      continue;
    }
    dates[iso] = groups;
    changedTerms.add(term);
    console.log(`  ${iso}: updated in ${term}/dates.json`);
    applied++;
  }

  if (!dryRun) {
    for (const term of changedTerms) writeDatesJson(term, datesByTerm.get(term));
  }

  console.log(`\nOverrides: ${applied} applied across ${changedTerms.size} term(s), ${skipped} already matched, ${unresolvable} unresolvable.`);
  if (dryRun) console.log('(dry run — no files written)');
  return unresolvable === 0;
}

// Reconciles courts/ussc/minutes/text/<year>/ against one term's (or every
// term's) already-resolved dates.json — see the "Backfilling the local text
// cache" doc comment at the top of this file. dates.json is only ever read
// here, never rewritten.
async function syncMinutesText(termFilter, dryRun) {
  const terms = readdirSync(TERMS_DIR)
    .filter(d => /^\d{4}-\d{2}$/.test(d) && (!termFilter || d === termFilter) && existsSync(join(TERMS_DIR, d, 'dates.json')))
    .sort();
  if (termFilter && !terms.length) {
    console.error(`ERROR: no dates.json found for term ${termFilter}`);
    process.exit(1);
  }

  // base volume URL (query string stripped) -> Map<pageNum, isoDate>, merged
  // across every term that references it (in practice always one term, but
  // nothing stops two adjacent terms' dates.json from citing the same
  // volume right at a term boundary).
  const pagesByHref = new Map();
  for (const term of terms) {
    const dates = loadDatesJson(term);
    for (const iso of Object.keys(dates)) {
      const groups = dates[iso];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (g.type !== 'minutes' || !g.href || !Array.isArray(g.pages)) continue;
        const baseHref = g.href.split('?')[0];
        if (!pagesByHref.has(baseHref)) pagesByHref.set(baseHref, new Map());
        const pageMap = pagesByHref.get(baseHref);
        for (const pageNum of g.pages) pageMap.set(pageNum, iso);
      }
    }
  }

  let ok = 0, moved = 0, downloaded = 0, skipped = 0, failed = 0;

  for (const [baseHref, pageMap] of pagesByHref) {
    const naId = parseVolumeUrl(baseHref);
    if (!naId) {
      console.log(`${baseHref}: could not parse a naId; skipping ${pageMap.size} page(s)`);
      skipped += pageMap.size;
      continue;
    }
    console.log(`\n${baseHref} (naId ${naId}): checking ${pageMap.size} page(s)...`);
    let objs, title;
    try {
      ({ objs, title } = await fetchRecordMeta(naId));
    } catch (e) {
      console.log(`  ERROR fetching record metadata: ${e.message || e}`);
      failed += pageMap.size;
      continue;
    }
    const yearRange = parseVolumeYearRange(title);
    // Bounded by the volume's own valid range — never a blind scan of every
    // year folder on disk, so a misfiled page can only ever be "found" among
    // years this exact volume could plausibly cover.
    const rangeYears = yearRange
      ? Array.from({ length: yearRange.max - yearRange.min + 1 }, (_, i) => String(yearRange.min + i))
      : [];

    const pages = [...pageMap.entries()].sort((a, b) => a[0] - b[0]);
    for (const [pageNum, iso] of pages) {
      const obj = objs[pageNum - 1];
      const base = obj && obj.objectFilename ? basename(obj.objectFilename, '.jpg') : null;
      if (!base || !obj.objectId) {
        console.log(`  [page ${pageNum}] SKIP (missing filename/objectId in volume listing)`);
        skipped++;
        continue;
      }
      const expectedYear = iso.slice(0, 4);
      const expectedPath = join(MINUTES_DIR, expectedYear, `${base}.txt`);
      if (existsSync(expectedPath)) {
        ok++;
        continue;
      }

      const foundYear = rangeYears.find(y => y !== expectedYear && existsSync(join(MINUTES_DIR, y, `${base}.txt`)));
      if (foundYear) {
        console.log(`  [page ${pageNum}] ${base}.txt: found under ${foundYear}/ — moving to ${expectedYear}/ (dates.json says ${iso})`);
        moved++;
        if (!dryRun) {
          mkdirSync(join(MINUTES_DIR, expectedYear), { recursive: true });
          writeFileSync(expectedPath, readFileSync(join(MINUTES_DIR, foundYear, `${base}.txt`), 'utf8'), 'utf8');
          unlinkSync(join(MINUTES_DIR, foundYear, `${base}.txt`));
        }
        continue;
      }

      console.log(`  [page ${pageNum}] ${base}.txt: missing everywhere in range; fetching from NARA...`);
      try {
        const text = await fetchExtractedText(naId, obj.objectId);
        if (!text || !text.trim()) {
          console.log('    no extracted text available');
          failed++;
        } else {
          downloaded++;
          if (!dryRun) {
            mkdirSync(join(MINUTES_DIR, expectedYear), { recursive: true });
            writeFileSync(expectedPath, text, 'utf8');
          }
        }
      } catch (e) {
        console.log(`    ERROR ${e.message || e}`);
        failed++;
      }
      await sleep(150); // be polite to NARA's API
    }
  }

  console.log(`\nMinutes text cache: ${ok} already correct, ${moved} moved, ${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);
  if (dryRun) console.log('(dry run — no files moved or written)');
}

// Smallest/largest of an array without Math.max/min(...arr) — safe even for
// a pathologically large pages array, which would risk overflowing the call
// stack via the spread operator.
function arrMin(arr) { return arr.reduce((m, v) => (v < m ? v : m), Infinity); }
function arrMax(arr) { return arr.reduce((m, v) => (v > m ? v : m), -Infinity); }

// Reads every term's dates.json and aggregates each Minutes context's own
// pages GLOBALLY, across the whole corpus — a single physical volume/roll's
// page numbering essentially always continues across many terms (every
// context currently in the corpus spans at least 2, and up to 11), so
// working out a context's own gaps/duplicates/backward-progression from just
// one term's own dates.json produces false positives at what only looks
// like a "boundary" from that one term's narrow view — a "missing" page is
// very often simply recorded under a different (adjacent, or not even
// adjacent) term instead. Shared by verifyMinutesConsistency and
// runBackfill below so both operate on the exact same picture.
// Returns { terms, contexts, duplicates }:
//   terms       — every term (sorted) with a dates.json.
//   contexts    — Map<ctxKey, { href, src, pageOwners }>, ctxKey being
//                 "href\0src". pageOwners is Map<pageNum, Array<{iso, term}>>
//                 — normally one owner per page; more than one means the
//                 same page number is recorded at multiple dates (see
//                 verifyMinutesConsistency's own invariant 2).
//   duplicates  — [{ term, iso, page, href }] for a page number repeated
//                 within one single group's own pages array.
function loadMinutesContexts() {
  const terms = readdirSync(TERMS_DIR)
    .filter(d => /^\d{4}-\d{2}$/.test(d) && existsSync(join(TERMS_DIR, d, 'dates.json')))
    .sort();

  const contexts = new Map();
  const duplicates = [];

  for (const term of terms) {
    const dates = loadDatesJson(term);

    for (const iso of Object.keys(dates)) {
      const groups = dates[iso];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (g.type !== 'minutes' || !g.href || !Array.isArray(g.pages)) continue;

        const seenInGroup = new Set();
        for (const p of g.pages) {
          if (seenInGroup.has(p)) duplicates.push({ term, iso, page: p, href: g.href });
          seenInGroup.add(p);
        }
        if (!seenInGroup.size) continue; // a tombstone (see handleMinutesDrop in terms.js) — nothing to check

        const ctxKey = `${g.href}\0${g.src || ''}`;
        if (!contexts.has(ctxKey)) contexts.set(ctxKey, { href: g.href, src: g.src, pageOwners: new Map() });
        const pageOwners = contexts.get(ctxKey).pageOwners;
        for (const p of seenInGroup) {
          if (!pageOwners.has(p)) pageOwners.set(p, []);
          pageOwners.get(p).push({ iso, term });
        }
      }
    }
  }

  return { terms, contexts, duplicates };
}

// Checks four invariants across the whole corpus's dates.json files,
// read-only (termFilter, if given, only limits which problems get printed —
// see loadMinutesContexts above for why every term still has to be read
// regardless):
//   1. No single group's own pages array repeats a page number.
//   2. For a given context (href AND src together — the
//      same physical volume), a page number never appears at more than one
//      date, EXCEPT when it appears at exactly two dates that are
//      immediately adjacent among that context's own dates (no third date
//      with real pages for that same context falls between them) — a page
//      whose proceedings genuinely straddle the end of one court day and
//      the start of the next (see the Minutes drag-and-drop editor's
//      Shift+drag feature in assets/js/terms.js, which leaves the dragged
//      page at both dates while still moving any pages after it on to the
//      target). Anything else — 3+ dates, or 2 non-adjacent dates — is
//      reported as a problem.
//   3. Within a given context, page numbers only ever increase from one of
//      its dates to the next (i.e. moving forward through time never moves
//      backward through the volume's own pages) — a date's lowest page must
//      be >= the previous date's own highest page. A volume's pages
//      resetting to a low number is only ever legitimate at a genuine
//      change of context (a new physical volume/roll), which this can't
//      mistake for a same-context regression since it's checked separately
//      per context, never by comparing across two different ones.
//   4. No gaps: across every date recorded for a given context — across
//      every term that cites it — every integer between its lowest and
//      highest recorded page must actually appear somewhere. A missing page
//      usually means a date's own group never got it added (e.g. a drag-
//      and-drop edit or an OCR misread dropped it), not that the page
//      itself doesn't exist.
function verifyMinutesConsistency(termFilter) {
  const { terms, contexts, duplicates } = loadMinutesContexts();
  if (termFilter && !terms.includes(termFilter)) {
    console.error(`ERROR: no dates.json found for term ${termFilter}`);
    process.exit(1);
  }
  const isRelevant = (t) => !termFilter || t === termFilter;

  let problems = 0;

  for (const { term, iso, page, href } of duplicates) {
    if (!isRelevant(term)) continue;
    console.log(`  ${term}/dates.json[${iso}]: page ${page} repeated within the same group (${href})`);
    problems++;
  }

  for (const { href, pageOwners } of contexts.values()) {
    const allPages = [...pageOwners.keys()].sort((a, b) => a - b);

    // Every date that actually carries a page for this context, across
    // every term that cites it, in chronological order — "adjacent" below
    // means adjacent within this list, not adjacent on the calendar at large.
    const contextDates = [...new Set(allPages.flatMap(p => pageOwners.get(p).map(o => o.iso)))].sort();

    for (const p of allPages) {
      const owners = pageOwners.get(p);
      if (owners.length <= 1) continue;
      if (!owners.some(o => isRelevant(o.term))) continue;
      if (owners.length === 2) {
        const isos = owners.map(o => o.iso).sort();
        if (contextDates[contextDates.indexOf(isos[0]) + 1] === isos[1]) continue; // legitimate straddle
      }
      const termsInvolved = [...new Set(owners.map(o => o.term))].join('/');
      console.log(`  ${termsInvolved}: page ${p} (${href}) appears at ${owners.length} date(s) — ${owners.map(o => o.iso).join(', ')}`);
      problems++;
    }

    // iso -> { term, pages[] }, for the backward-progression check below.
    const byIso = new Map();
    for (const p of allPages) {
      for (const o of pageOwners.get(p)) {
        if (!byIso.has(o.iso)) byIso.set(o.iso, { term: o.term, pages: [] });
        byIso.get(o.iso).pages.push(p);
      }
    }
    const isos = [...byIso.keys()].sort();
    for (let i = 1; i < isos.length; i++) {
      const prevEntry = byIso.get(isos[i - 1]);
      const currEntry = byIso.get(isos[i]);
      const prevMax = arrMax(prevEntry.pages);
      const currMin = arrMin(currEntry.pages);
      if (currMin < prevMax) {
        if (!isRelevant(prevEntry.term) && !isRelevant(currEntry.term)) continue;
        console.log(`  page numbers go backward for ${href} — ${prevEntry.term}/${isos[i - 1]} reaches ${prevMax}, then ${currEntry.term}/${isos[i]} starts at ${currMin}`);
        problems++;
      }
    }

    for (let i = 1; i < allPages.length; i++) {
      const prev = allPages[i - 1], curr = allPages[i];
      if (curr - prev <= 1) continue;
      const prevTerm = pageOwners.get(prev)[0].term;
      const currTerm = pageOwners.get(curr)[0].term;
      if (!isRelevant(prevTerm) && !isRelevant(currTerm)) continue;
      const gapStart = prev + 1, gapEnd = curr - 1;
      const range = gapStart === gapEnd ? String(gapStart) : `${gapStart}-${gapEnd}`;
      const span = currTerm === prevTerm ? prevTerm : `${prevTerm}→${currTerm}`;
      console.log(`  ${span}: ${href} is missing page(s) ${range} (between page ${prev} and ${curr})`);
      problems += gapEnd - gapStart + 1;
    }
  }

  console.log(`\nVerify: ${problems} problem(s) found${termFilter ? ` involving ${termFilter}` : ` across ${terms.length} term(s)`}.`);
}

// For every gap identified the same way --verify's 4th invariant does (a
// missing page number strictly between two already-recorded pages of the
// same context — see loadMinutesContexts above for why that's checked
// across every term that cites the context, not just one), tries to
// determine which date it actually belongs to and adds it there — every
// page in a minutes volume should be accounted for somewhere. Uses whatever
// OCR text is already cached locally (in *any* year folder — a misfiled
// page is exactly the kind of thing that causes it to have been skipped
// from dates.json in the first place), fetching it fresh from NARA
// otherwise. A date is only trusted if FULL_DATE_RE actually finds one AND
// it falls within (inclusive) the two bounding pages' own dates — much
// narrower, and so more reliable, than the whole volume's own title-derived
// year range, since a small gap can't legitimately land outside that tight
// a window; the resolved date's own term (which, per the above, isn't
// necessarily either bounding page's term) is where the page actually gets
// added. When no such date can be extracted (common for a docket/index
// page, which often carries no date of its own at all), the page is instead
// added to the earlier bounding page's own date, logged as a guess rather
// than a confident read, so it's still accounted for while remaining easy
// to find and correct later (see terms.js's Minutes Pages drag-and-drop
// editor) — but only when the whole gap it's part of is no wider than
// MAX_GUESS_GAP; a page that can't be dated by OCR *and* sits in a much
// wider gap (e.g. an entire multi-hundred-page index/appendix section) is
// left unresolved instead, since guessing would just wrongly pile the whole
// thing onto one date rather than actually account for it. A target date
// whose own group for this context is already "modified": true (a
// deliberate human correction) is left alone either way, same as the normal
// <volume-url> flow's own Pass 3. termFilter, if given, only limits which
// gaps get acted on (either bounding page's own term must match) — every
// term is still read, for the same reason loadMinutesContexts always reads
// everything.
const MAX_GUESS_GAP = 10;

async function runBackfill(termFilter, dryRun) {
  const { terms, contexts } = loadMinutesContexts();
  if (termFilter && !terms.includes(termFilter)) {
    console.error(`ERROR: no dates.json found for term ${termFilter}`);
    process.exit(1);
  }
  const termStarts = loadTermStarts();

  const existingIndex = buildExistingIndex();
  // naId -> Promise<{objs, title}|null>, memoized so a volume with many gap
  // pages only ever triggers one record-metadata fetch.
  const metaCache = new Map();
  const getMeta = (naId) => {
    if (!metaCache.has(naId)) metaCache.set(naId, fetchRecordMeta(naId).catch(() => null));
    return metaCache.get(naId);
  };

  // Loaded lazily, mutated in place, and only written back for a term that
  // actually changed — a single run can touch several terms' dates.json,
  // since a context's gaps can resolve to any term along its own span.
  const datesByTerm = new Map();
  const getDates = (term) => {
    if (!datesByTerm.has(term)) datesByTerm.set(term, loadDatesJson(term));
    return datesByTerm.get(term);
  };
  const changedTerms = new Set();

  let confident = 0, guessed = 0, unresolved = 0;

  for (const { href, src, pageOwners } of contexts.values()) {
    const allPages = [...pageOwners.keys()].sort((a, b) => a - b);
    const gaps = []; // { page, beforeP, afterP }
    for (let i = 1; i < allPages.length; i++) {
      for (let p = allPages[i - 1] + 1; p < allPages[i]; p++) {
        gaps.push({ page: p, beforeP: allPages[i - 1], afterP: allPages[i] });
      }
    }
    if (!gaps.length) continue;

    const naId = parseVolumeUrl(href);
    const rollMatch = /\/([^/]+)\/[^/]+-\$page:4\.jpg$/.exec(src || '');
    if (!naId || !rollMatch) {
      const relevant = gaps.filter(({ beforeP, afterP }) =>
        isRelevantGap(pageOwners, beforeP, afterP, termFilter));
      if (relevant.length) console.log(`  can't parse volume/roll from ${href} — skipping its ${relevant.length} gap page(s)`);
      unresolved += relevant.length;
      continue;
    }
    const roll = rollMatch[1];

    for (const { page: p, beforeP, afterP } of gaps) {
      const beforeOwner = pageOwners.get(beforeP)[0];
      const afterOwner = pageOwners.get(afterP)[0];
      if (termFilter && beforeOwner.term !== termFilter && afterOwner.term !== termFilter) continue;

      const beforeIso = beforeOwner.iso, afterIso = afterOwner.iso;
      const base = `${roll}-${String(p).padStart(4, '0')}`;
      const span = afterOwner.term === beforeOwner.term ? beforeOwner.term : `${beforeOwner.term}→${afterOwner.term}`;
      const label = `${span}: ${base}`;

      // Read from cache (any year folder — see doc comment above) or fetch fresh.
      let text = null;
      let fetchedFresh = false;
      const cachedYear = existingIndex.get(base);
      if (cachedYear) {
        try { text = readFileSync(join(MINUTES_DIR, cachedYear, `${base}.txt`), 'utf8'); } catch { text = null; }
      }
      if (text === null) {
        const meta = await getMeta(naId);
        const obj = meta?.objs?.[p - 1];
        if (!obj?.objectId) {
          console.log(`  ${label}: could not locate this page on NARA (naId ${naId}); skipping`);
          unresolved++;
          continue;
        }
        try {
          text = await fetchExtractedText(naId, obj.objectId);
        } catch (e) {
          console.log(`  ${label}: ERROR fetching text — ${e.message || e}`);
          unresolved++;
          await sleep(150);
          continue;
        }
        fetchedFresh = true;
        await sleep(150); // be polite to NARA's API
      }
      text = text || '';

      // Narrow, gap-specific year range — much tighter (and more reliable)
      // than the whole volume's own title-derived range, since a small
      // gap can't legitimately land outside it.
      const beforeYear = parseInt(beforeIso.slice(0, 4), 10);
      const afterYear = parseInt(afterIso.slice(0, 4), 10);
      const yearRange = { min: Math.min(beforeYear, afterYear), max: Math.max(beforeYear, afterYear) };
      let resolvedDate = text ? extractFullDate(text, yearRange) : null;
      // Must also fall within the two bounding dates themselves, not just
      // their year(s) — a same-year OCR misread elsewhere on the page
      // could otherwise still slip through.
      if (resolvedDate && (resolvedDate < beforeIso || resolvedDate > afterIso)) resolvedDate = null;

      if (!resolvedDate && (afterP - beforeP - 1) > MAX_GUESS_GAP) {
        console.log(`  ${label}: no extractable date, and this gap runs ${afterP - beforeP - 1} pages (> ${MAX_GUESS_GAP}) — too wide to guess; leaving unresolved`);
        unresolved++;
        continue;
      }

      const targetIso = resolvedDate || beforeIso; // best guess — see doc comment above
      const isGuess = !resolvedDate;
      const targetTerm = resolvedDate ? termForDate(resolvedDate, termStarts) : beforeOwner.term;
      if (!targetTerm) {
        console.log(`  ${label}: resolved date ${resolvedDate} matches no known term; leaving unresolved`);
        unresolved++;
        continue;
      }

      const dates = getDates(targetTerm);
      if (!Array.isArray(dates[targetIso])) dates[targetIso] = [];
      const targetGroups = dates[targetIso];
      let group = targetGroups.find(g => g.type === 'minutes' && g.href === href && g.src === src);
      if (group && group.modified) {
        console.log(`  ${label}: ${targetTerm}/dates.json[${targetIso}] is marked modified; leaving page ${p} out`);
        unresolved++;
        continue;
      }
      if (!group) {
        group = { type: 'minutes', href, src, pages: [] };
        targetGroups.push(group);
      }
      group.pages = [...new Set([...group.pages, p])].sort((a, b) => a - b);
      changedTerms.add(targetTerm);

      console.log(`  ${label}: ${isGuess ? 'guessed' : 'resolved'} -> ${targetTerm}/${targetIso}${isGuess ? ' (no extractable date; nearest earlier page)' : ''}`);
      if (isGuess) guessed++; else confident++;

      if (fetchedFresh && !dryRun && text) {
        const outPath = join(MINUTES_DIR, targetIso.slice(0, 4), `${base}.txt`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, text, 'utf8');
      }
    }
  }

  if (!dryRun) {
    for (const term of changedTerms) {
      writeDatesJson(term, datesByTerm.get(term));
      console.log(`  ${term}: updated dates.json`);
    }
  }

  console.log(`\nBackfill: ${confident} resolved via OCR, ${guessed} guessed (no extractable date), ${unresolved} left unresolved, across ${changedTerms.size} dates.json file(s) updated.`);
  if (dryRun) console.log('(dry run — no files written)');
}

// Whether a gap between beforeP/afterP (both already-known pages, per
// pageOwners) is even worth reporting/counting for termFilter — used only by
// runBackfill's own "can't parse volume/roll" bailout above, since that path
// skips every gap in the context at once rather than looking at them
// individually the way the main loop below does inline.
function isRelevantGap(pageOwners, beforeP, afterP, termFilter) {
  if (!termFilter) return true;
  return pageOwners.get(beforeP)[0].term === termFilter || pageOwners.get(afterP)[0].term === termFilter;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (args.includes('--thumbnails')) {
    await runThumbnails(dryRun);
    return;
  }

  if (args.includes('--verify')) {
    const termArg = args.find(a => /^\d{4}-\d{2}$/.test(a));
    verifyMinutesConsistency(termArg || null);
    return;
  }

  if (args.includes('--backfill')) {
    const termArg = args.find(a => /^\d{4}-\d{2}$/.test(a));
    await runBackfill(termArg || null, dryRun);
    return;
  }

  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const positional = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a));

  // No volume URL, overrides file, or term given at all — reconcile every
  // term's local Minutes text cache against its existing dates.json (see
  // syncMinutesText's own doc comment) rather than erroring out.
  if (!positional) {
    await syncMinutesText(null, dryRun);
    return;
  }

  // A downloaded overrides file is a local path, never a URL — distinguish
  // it from <volume-url> that way rather than requiring a separate flag.
  if (!/^https?:\/\//.test(positional) && existsSync(positional)) {
    const ok = await applyDateOverrides(positional, dryRun);
    // Nothing left to keep it around for once every entry has been cleanly
    // applied (or was already applied) — skipped on --dry-run, since nothing
    // was actually written, and on any unresolvable entry, so its dates stay
    // available to retry (e.g. against a term added since).
    if (ok && !dryRun) {
      unlinkSync(positional);
      console.log(`Deleted ${positional} (all overrides applied cleanly).`);
    }
    return;
  }

  // A bare term (e.g. "1888-10", never a valid URL or an existing local
  // file) scopes the same text-cache reconciliation to just that term.
  if (/^\d{4}-\d{2}$/.test(positional)) {
    await syncMinutesText(positional, dryRun);
    return;
  }

  const volumeUrl = positional;
  const naId = parseVolumeUrl(volumeUrl);
  if (!naId) {
    console.error(`ERROR: could not parse a naId from ${volumeUrl}`);
    process.exit(1);
  }

  const minutesHrefTemplate = `https://catalog.archives.gov/id/${naId}?objectPage=$page`;

  console.log(`Fetching page list for naId ${naId}...`);
  const { objs: allObjs, title } = await fetchRecordMeta(naId);
  const yearRange = parseVolumeYearRange(title);
  if (yearRange) {
    console.log(`Volume title: "${title}" -> valid year range ${yearRange.min}-${yearRange.max}`);
  } else {
    console.log(`Volume title: ${title ? `"${title}"` : '(none)'} -> no year range found; OCR years won't be range-checked`);
  }

  let objs = allObjs;
  if (limit) objs = objs.slice(0, limit);
  console.log(`Processing ${objs.length} page(s).\n`);

  const existingIndex = buildExistingIndex();
  const termStarts = loadTermStarts();
  const datesByTerm = new Map(); // term -> dates.json object, loaded lazily
  const getDates = (term) => {
    if (!datesByTerm.has(term)) datesByTerm.set(term, loadDatesJson(term));
    return datesByTerm.get(term);
  };

  let saved = 0, cached = 0, skipped = 0, failed = 0;
  let datesAdded = 0, datesSkipped = 0, datesProtected = 0;
  let lastYear = null;
  const changedTerms = new Set();
  const records = []; // {pageNum, label, minutesSrcTemplate, rawDate} per successfully-read page

  // ── Pass 1: gather every page's text (fetch or cache) and its own,
  // independent raw candidate date — no cross-page reasoning yet. ──────────
  for (let i = 0; i < objs.length; i++) {
    const obj = objs[i];
    const pageNum = i + 1;
    const base = obj.objectFilename ? basename(obj.objectFilename, '.jpg') : null;
    const label = `[${pageNum}/${objs.length}] ${base || obj.objectId || '?'}`;

    if (!base || !obj.objectId) {
      console.log(`  ${label}: SKIP (missing filename/objectId)`);
      skipped++;
      continue;
    }

    let text, year;
    const existingYear = existingIndex.get(base);
    if (existingYear) {
      try {
        text = readFileSync(join(MINUTES_DIR, existingYear, `${base}.txt`), 'utf8');
        year = existingYear;
        console.log(`  ${label}: already have ${year}/${base}.txt`);
        cached++;
      } catch (e) {
        console.log(`  ${label}: ERROR reading cached file: ${e.message || e}`);
        failed++;
        continue;
      }
    } else {
      try {
        text = await fetchExtractedText(naId, obj.objectId);
        if (!text || !text.trim()) {
          console.log(`  ${label}: no extracted text`);
          skipped++;
          await sleep(150);
          continue;
        }

        const yearMatch = YEAR_RE.exec(text.slice(0, 200));
        let matchedYear = yearMatch ? parseInt(yearMatch[1], 10) : null;
        if (matchedYear !== null && yearRange && (matchedYear < yearRange.min || matchedYear > yearRange.max)) {
          console.log(`  ${label}: extracted year ${matchedYear} outside valid range ${yearRange.min}-${yearRange.max}; ignoring`);
          matchedYear = null;
        }

        year = matchedYear !== null ? String(matchedYear) : lastYear;
        if (!year) {
          console.log(`  ${label}: SKIP (no valid year found, and no earlier page to fall back to)`);
          skipped++;
          await sleep(150);
          continue;
        }
        if (matchedYear === null) console.log(`  ${label}: no valid year found; using previous page's ${year}`);
        lastYear = year;

        const outPath = join(MINUTES_DIR, year, `${base}.txt`);
        console.log(`  ${label} -> ${year}/${base}.txt`);
        if (!dryRun) {
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, text, 'utf8');
        }
        saved++;
      } catch (e) {
        console.log(`  ${label}: ERROR ${e.message || e}`);
        failed++;
        await sleep(150);
        continue;
      }

      await sleep(150); // be polite to NARA's API
    }

    // The roll ("M215-018") is just this page's own basename with the page
    // number dropped — derived per page (not once for the whole volume)
    // since nothing here actually guarantees a volume never crosses a roll
    // boundary, even though in practice it hasn't for any volume seen so far.
    const roll = base.replace(/-\d+$/, '');
    const minutesSrcTemplate = `https://catalog.archives.gov/medialz/dc-metro/rg-267/607809/${roll}/${roll}-$page:4.jpg`;

    records.push({ pageNum, label, minutesSrcTemplate, rawDate: extractFullDate(text, yearRange) });
  }

  // ── Pass 2: reconcile raw candidates into a final date per page ─────────
  const resolved = smoothDates(records);

  // ── Pass 3: build/merge dates.json entries from the resolved dates ──────
  for (let i = 0; i < records.length; i++) {
    const { pageNum, label, minutesSrcTemplate } = records[i];
    const fullDate = resolved[i];
    if (!fullDate) { datesSkipped++; continue; }

    const term = termForDate(fullDate, termStarts);
    if (!term) {
      console.log(`  ${label}: ${fullDate} matches no known term; skipping dates.json`);
      datesSkipped++;
      continue;
    }

    const dates = getDates(term);
    const groups = Array.isArray(dates[fullDate]) ? dates[fullDate] : [];
    // A date's pages can span more than one physical volume (see the
    // format note above) — the volume this page came from is identified by
    // its own href template, so pages from a different volume land in their
    // own group instead of corrupting an existing group's links.
    let group = groups.find(g => g.type === 'minutes' && g.href === minutesHrefTemplate);

    // A group already carrying modified:true was written by applyDateOverrides
    // above from a downloaded browser edit — a deliberate correction, not an
    // OCR artifact — so it's left completely alone here, even if this page's
    // freshly re-extracted OCR date disagrees with it.
    if (group && group.modified) {
      console.log(`  ${label}: ${term}/dates.json[${fullDate}] is marked modified; leaving it as-is`);
      datesProtected++;
      continue;
    }

    const isNewGroup = !group;
    if (isNewGroup) {
      group = { type: 'minutes', href: minutesHrefTemplate, src: minutesSrcTemplate, pages: [] };
      groups.push(group);
    }
    const hadPage = group.pages.includes(pageNum);
    const hadSrc  = !!group.src;

    // The group is always rebuilt (rather than mutated in place) so the key
    // order stays {type, href, src, pages} even for a group that predates
    // src, self-healing it into the current shape.
    const pages = new Set(group.pages);
    pages.add(pageNum);
    const newGroup = {
      type: 'minutes',
      href: group.href || minutesHrefTemplate,
      src: group.src || minutesSrcTemplate,
      pages: [...pages].sort((a, b) => a - b),
    };
    groups[groups.indexOf(group)] = newGroup;
    // A date's own array can now also hold a case-detail object (see
    // update_cases.js's syncCrossTermCaseDates) with type "argument"/
    // "reargument" instead — the fallback keeps those sorting to the front
    // rather than throwing.
    groups.sort((a, b) => (a.href || '').localeCompare(b.href || ''));
    dates[fullDate] = groups;

    if (isNewGroup || !hadPage || !hadSrc) {
      changedTerms.add(term);
      if (isNewGroup) {
        console.log(`  ${label}: ${term}/dates.json[${fullDate}] gained a new source group (${minutesHrefTemplate})`);
      }
      if (!hadPage) {
        datesAdded++;
        console.log(`  ${label}: ${term}/dates.json[${fullDate}].pages += ${pageNum}`);
      } else if (!hadSrc) {
        console.log(`  ${label}: ${term}/dates.json[${fullDate}] gained src`);
      }
    }
  }

  if (!dryRun) {
    for (const term of changedTerms) writeDatesJson(term, datesByTerm.get(term));
  }

  console.log(`\nText: ${saved} saved, ${cached} already cached, ${skipped} skipped, ${failed} failed.`);
  console.log(`Dates: ${datesAdded} minutes page(s) recorded across ${changedTerms.size} term(s), ${datesSkipped} page(s) had no usable date, ${datesProtected} page(s) skipped (modified group).`);
  if (dryRun) console.log('(dry run — no files written)');
}

main();
