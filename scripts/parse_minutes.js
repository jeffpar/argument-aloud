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
 *       { "minutes_href": "https://catalog.archives.gov/id/178847707?objectPage=$page",
 *         "minutes_src": ".../M215-018/M215-018-$page:4.jpg",
 *         "minutes_pages": [6, 7] }
 *     ] }
 * Each date maps to an *array* of source groups rather than a single one,
 * because a calendar day's minutes occasionally spans two different
 * physical volumes (NARA splits a session's pages across consecutive
 * volumes at whatever point the microfilm roll ends) — grouping by source
 * keeps minutes_href/minutes_src accurate per page instead of one group's
 * template getting wrongly applied to another volume's page numbers. The
 * common case is still just a one-element array. minutes_pages holds the
 * page's 1-based position within ITS volume (matching the `objectPage`
 * query param NARA's own catalog URLs use); minutes_href is that volume's
 * catalog URL with a literal "$page" placeholder, and minutes_src the
 * direct image download URL with a literal "$page:4" placeholder (the ":4"
 * meaning zero-padded to 4 digits, since — unlike the catalog URL's plain
 * query-string page number — the image filename itself embeds the page
 * number that way) — both for the frontend to substitute per page.
 * dates.json is created if missing; existing entries are rewritten in this
 * same {minutes_href, minutes_src, minutes_pages} key order every time
 * they're touched, so older entries (including pre-array-format ones) self-
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
 *
 *   --dry-run     Report what would be saved without writing any files
 *   --limit N     Only process the first N pages (for a quick test run —
 *                 a full volume can be 1000+ pages)
 *   --thumbnails  Separate mode (no volume-url): for every term with a
 *                 dates.json, generate one cover thumbnail per unique
 *                 minutes_src template found in it (i.e. one per physical
 *                 roll referenced by that term, not one per date/page) —
 *                 courts/ussc/terms/<term>/m<XXX>-cover.jpg, a 1340px-tall
 *                 proportional resize (via macOS's `sips`) of the first
 *                 page number seen for that template, where <XXX> is the
 *                 3-digit roll number in "M215-XXX". Every group sharing
 *                 that minutes_src gets a "minutes_cover" prop (right after
 *                 minutes_src) pointing at it, e.g.
 *                 "/courts/ussc/terms/1888-10/m017-cover.jpg".
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
 * ever read here, never rewritten. For every unique minutes_href a term's
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
 * doc comment for the exact two invariants it checks. Nothing is ever
 * written; problems are only reported.
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

// Loads a term's dates.json, migrating any pre-array-format entry (a bare
// {minutes_href, minutes_src, minutes_pages} object, from before a date's
// pages could span more than one source volume) into a one-element array.
function loadDatesJson(term) {
  const p = join(TERMS_DIR, term, 'dates.json');
  if (!existsSync(p)) return {};
  let data;
  try { data = JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
  for (const k of Object.keys(data)) {
    if (!Array.isArray(data[k])) data[k] = [data[k]];
  }
  return data;
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

// One cover thumbnail per unique minutes_src template (i.e. per physical
// roll), across every term that has a dates.json — see the --thumbnails
// doc comment at the top of this file for the exact naming/placement rules.
async function runThumbnails(dryRun) {
  const terms = readdirSync(TERMS_DIR)
    .filter(d => /^\d{4}-\d{2}$/.test(d) && existsSync(join(TERMS_DIR, d, 'dates.json')))
    .sort();

  let created = 0, existing = 0, failed = 0;

  for (const term of terms) {
    const datesPath = join(TERMS_DIR, term, 'dates.json');
    let dates;
    try { dates = JSON.parse(readFileSync(datesPath, 'utf8')); } catch { continue; }

    // First page number seen for each unique minutes_src template, walking
    // dates in sorted (chronological) order so "first" is deterministic.
    const firstPageByTemplate = new Map();
    for (const iso of Object.keys(dates).sort()) {
      const groups = dates[iso];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g.minutes_src || !Array.isArray(g.minutes_pages) || !g.minutes_pages.length) continue;
        if (!firstPageByTemplate.has(g.minutes_src)) {
          firstPageByTemplate.set(g.minutes_src, Math.min(...g.minutes_pages));
        }
      }
    }
    if (!firstPageByTemplate.size) continue;

    let changed = false;
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
      const coverRef = `/courts/ussc/terms/${term}/${coverName}`;

      if (existsSync(coverPath)) {
        existing++;
      } else {
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

      // Every group sharing this exact minutes_src template shows the same
      // physical roll, so they all get the same cover — not just whichever
      // group's page happened to be used to fetch it.
      for (const iso of Object.keys(dates)) {
        const groups = dates[iso];
        if (!Array.isArray(groups)) continue;
        for (let gi = 0; gi < groups.length; gi++) {
          const g = groups[gi];
          if (g.minutes_src !== template || g.minutes_cover === coverRef) continue;
          console.log(`  ${term}/dates.json[${iso}] gained minutes_cover=${coverRef}`);
          if (!dryRun) {
            groups[gi] = {
              minutes_href: g.minutes_href,
              minutes_src: g.minutes_src,
              minutes_cover: coverRef,
              minutes_pages: g.minutes_pages,
            };
          }
          changed = true;
        }
      }
    }

    if (changed && !dryRun) {
      writeFileSync(datesPath, JSON.stringify(dates, null, 2) + '\n', 'utf8');
      console.log(`  ${term}: updated dates.json`);
    }
  }

  console.log(`\nThumbnails: ${created} created, ${existing} already existed, ${failed} failed.`);
  if (dryRun) console.log('(dry run — no files written)');
}

// Normalizes one override value (a single group object, an array of them,
// possibly hand-edited or from an older format) into the same
// {minutes_href, minutes_src, minutes_cover?, minutes_pages} key order the
// rest of this script writes, plus a trailing `modified: true` — this marks
// the group as a deliberate, browser-made edit so a later re-run of the
// normal <volume-url> flow (Pass 3 below) never overwrites it with a fresh
// OCR-derived result.
function normalizeOverrideGroups(val) {
  const groups = Array.isArray(val) ? val : [val];
  return groups.map((g) => {
    const out = { minutes_href: g.minutes_href, minutes_src: g.minutes_src };
    if (g.minutes_cover) out.minutes_cover = g.minutes_cover;
    out.minutes_pages = [...new Set(g.minutes_pages || [])].sort((a, b) => a - b);
    out.modified = true;
    return out;
  });
}

// Applies a downloaded date-overrides file (see the doc comment at the top
// of this file) — a flat { "<ISO date>": <groups>|null } map, possibly
// spanning several terms — directly to each affected term's own dates.json.
async function applyDateOverrides(filePath, dryRun) {
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  const termStarts = loadTermStarts();
  const datesByTerm = new Map();
  const getDates = (term) => {
    if (!datesByTerm.has(term)) datesByTerm.set(term, loadDatesJson(term));
    return datesByTerm.get(term);
  };

  const changedTerms = new Set();
  let applied = 0, skipped = 0;

  for (const iso of Object.keys(raw)) {
    const term = termForDate(iso, termStarts);
    if (!term) {
      console.log(`  ${iso}: matches no known term; skipping`);
      skipped++;
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
    for (const term of changedTerms) {
      const dates = datesByTerm.get(term);
      const sorted = {};
      for (const k of Object.keys(dates).sort()) sorted[k] = dates[k];
      const p = join(TERMS_DIR, term, 'dates.json');
      writeFileSync(p, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
    }
  }

  console.log(`\nOverrides: ${applied} applied across ${changedTerms.size} term(s), ${skipped} already matched or unresolvable.`);
  if (dryRun) console.log('(dry run — no files written)');
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
    let dates;
    try { dates = JSON.parse(readFileSync(join(TERMS_DIR, term, 'dates.json'), 'utf8')); } catch { continue; }
    for (const iso of Object.keys(dates)) {
      const groups = dates[iso];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g.minutes_href || !Array.isArray(g.minutes_pages)) continue;
        const baseHref = g.minutes_href.split('?')[0];
        if (!pagesByHref.has(baseHref)) pagesByHref.set(baseHref, new Map());
        const pageMap = pagesByHref.get(baseHref);
        for (const pageNum of g.minutes_pages) pageMap.set(pageNum, iso);
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
// a pathologically large minutes_pages array, which would risk overflowing
// the call stack via the spread operator.
function arrMin(arr) { return arr.reduce((m, v) => (v < m ? v : m), Infinity); }
function arrMax(arr) { return arr.reduce((m, v) => (v > m ? v : m), -Infinity); }

// Checks three invariants across one term's (or every term's) dates.json,
// read-only:
//   1. No single group's own minutes_pages array repeats a page number.
//   2. For a given context (minutes_href AND minutes_src together — the
//      same physical volume), a page number never appears at more than one
//      date, EXCEPT when it appears at exactly two dates that are
//      immediately adjacent among that context's own dates (no third date
//      with real pages for that same context falls between them) — a page
//      whose proceedings genuinely straddle the end of one court day and
//      the start of the next (see the Minutes drag-and-drop editor's
//      Shift+drag "copy" feature in assets/js/terms.js). Anything else —
//      3+ dates, or 2 non-adjacent dates — is reported as a problem.
//   3. Within a given context, page numbers only ever increase from one of
//      its dates to the next (i.e. moving forward through time never moves
//      backward through the volume's own pages) — a date's lowest page must
//      be >= the previous date's own highest page. A volume's pages
//      resetting to a low number is only ever legitimate at a genuine
//      change of context (a new physical volume/roll), which this can't
//      mistake for a same-context regression since it's checked separately
//      per context, never by comparing across two different ones.
function verifyMinutesConsistency(termFilter) {
  const terms = readdirSync(TERMS_DIR)
    .filter(d => /^\d{4}-\d{2}$/.test(d) && (!termFilter || d === termFilter) && existsSync(join(TERMS_DIR, d, 'dates.json')))
    .sort();
  if (termFilter && !terms.length) {
    console.error(`ERROR: no dates.json found for term ${termFilter}`);
    process.exit(1);
  }

  let problems = 0;

  for (const term of terms) {
    let dates;
    try { dates = JSON.parse(readFileSync(join(TERMS_DIR, term, 'dates.json'), 'utf8')); } catch { continue; }

    // context key (href + "\0" + src) -> Map<pageNum, isoDate[]>
    const pageLocations = new Map();
    // context key -> Map<isoDate, pages[]> — every page recorded for that
    // context on that date, across however many groups share it (normally
    // just one group per date per context).
    const datePagesByContext = new Map();

    for (const iso of Object.keys(dates).sort()) {
      const groups = dates[iso];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (!g.minutes_href || !Array.isArray(g.minutes_pages)) continue;

        const seenInGroup = new Set();
        for (const p of g.minutes_pages) {
          if (seenInGroup.has(p)) {
            console.log(`  ${term}/dates.json[${iso}]: page ${p} repeated within the same group (${g.minutes_href})`);
            problems++;
          }
          seenInGroup.add(p);
        }
        if (!seenInGroup.size) continue; // a tombstone (see handleMinutesDrop in terms.js) — nothing to check

        const ctxKey = `${g.minutes_href}\0${g.minutes_src || ''}`;

        if (!pageLocations.has(ctxKey)) pageLocations.set(ctxKey, new Map());
        const locMap = pageLocations.get(ctxKey);
        for (const p of seenInGroup) {
          if (!locMap.has(p)) locMap.set(p, []);
          locMap.get(p).push(iso);
        }

        if (!datePagesByContext.has(ctxKey)) datePagesByContext.set(ctxKey, new Map());
        const dateMap = datePagesByContext.get(ctxKey);
        dateMap.set(iso, (dateMap.get(iso) || []).concat([...seenInGroup]));
      }
    }

    for (const [ctxKey, locMap] of pageLocations) {
      const href = ctxKey.split('\0')[0];
      // Every date that actually carries a page for this context, in
      // chronological order — "adjacent" below means adjacent within this
      // list, not adjacent on the calendar at large.
      const contextDates = [...new Set([].concat(...locMap.values()))].sort();
      for (const [page, isos] of locMap) {
        if (isos.length <= 1) continue;
        if (isos.length === 2) {
          const [a, b] = [...isos].sort();
          if (contextDates[contextDates.indexOf(a) + 1] === b) continue; // legitimate straddle
        }
        console.log(`  ${term}: page ${page} (${href}) appears at ${isos.length} date(s) — ${isos.join(', ')}`);
        problems++;
      }
    }

    for (const [ctxKey, dateMap] of datePagesByContext) {
      const href = ctxKey.split('\0')[0];
      const isos = [...dateMap.keys()].sort();
      for (let i = 1; i < isos.length; i++) {
        const prevMax = arrMax(dateMap.get(isos[i - 1]));
        const currMin = arrMin(dateMap.get(isos[i]));
        if (currMin < prevMax) {
          console.log(`  ${term}: page numbers go backward for ${href} — ${isos[i - 1]} reaches ${prevMax}, then ${isos[i]} starts at ${currMin}`);
          problems++;
        }
      }
    }
  }

  console.log(`\nVerify: ${problems} problem(s) found across ${terms.length} term(s).`);
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
    await applyDateOverrides(positional, dryRun);
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
    // its own minutes_href template, so pages from a different volume land
    // in their own group instead of corrupting an existing group's links.
    let group = groups.find(g => g.minutes_href === minutesHrefTemplate);

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
      group = { minutes_href: minutesHrefTemplate, minutes_src: minutesSrcTemplate, minutes_pages: [] };
      groups.push(group);
    }
    const hadPage = group.minutes_pages.includes(pageNum);
    const hadSrc  = !!group.minutes_src;

    // The group is always rebuilt (rather than mutated in place) so the key
    // order stays {minutes_href, minutes_src, minutes_pages} even for a
    // group that predates minutes_src, self-healing it into the current shape.
    const pages = new Set(group.minutes_pages);
    pages.add(pageNum);
    const newGroup = {
      minutes_href: group.minutes_href || minutesHrefTemplate,
      minutes_src: group.minutes_src || minutesSrcTemplate,
      minutes_pages: [...pages].sort((a, b) => a - b),
    };
    groups[groups.indexOf(group)] = newGroup;
    groups.sort((a, b) => a.minutes_href.localeCompare(b.minutes_href));
    dates[fullDate] = groups;

    if (isNewGroup || !hadPage || !hadSrc) {
      changedTerms.add(term);
      if (isNewGroup) {
        console.log(`  ${label}: ${term}/dates.json[${fullDate}] gained a new source group (${minutesHrefTemplate})`);
      }
      if (!hadPage) {
        datesAdded++;
        console.log(`  ${label}: ${term}/dates.json[${fullDate}].minutes_pages += ${pageNum}`);
      } else if (!hadSrc) {
        console.log(`  ${label}: ${term}/dates.json[${fullDate}] gained minutes_src`);
      }
    }
  }

  if (!dryRun) {
    for (const term of changedTerms) {
      const dates = datesByTerm.get(term);
      const sorted = {};
      for (const k of Object.keys(dates).sort()) sorted[k] = dates[k];
      const p = join(TERMS_DIR, term, 'dates.json');
      writeFileSync(p, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
    }
  }

  console.log(`\nText: ${saved} saved, ${cached} already cached, ${skipped} skipped, ${failed} failed.`);
  console.log(`Dates: ${datesAdded} minutes page(s) recorded across ${changedTerms.size} term(s), ${datesSkipped} page(s) had no usable date, ${datesProtected} page(s) skipped (modified group).`);
  if (dryRun) console.log('(dry run — no files written)');
}

main();
