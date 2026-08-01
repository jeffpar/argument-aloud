#!/usr/bin/env node
/**
 * tests/extract_minutes_text.js
 *
 * Test script: given a NARA "Minutes of the U.S. Supreme Court" (M215)
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
 * parsed from the top of its text (e.g. "May 13th, 1889" -> "1889-05-13"),
 * falling back to the last full date successfully parsed from an earlier
 * page in this same run when a given page has no date of its own (e.g. a
 * "Continued" page) — and treating an extracted date that's earlier than
 * that last one as an OCR misread rather than an actual step backward in
 * time, falling back the same way. It's then recorded in
 * courts/ussc/terms/<term>/dates.json — <term> being
 * whichever term's own start date is the latest one on/before that date —
 * as:
 *   { "1889-05-13": { "minutes_href": "https://catalog.archives.gov/id/178847707?objectPage=$page",
 *                      "minutes_src": ".../M215-018/M215-018-$page:4.jpg",
 *                      "minutes_pages": [6, 7] } }
 * minutes_pages holds the page's 1-based position in the volume (matching
 * the `objectPage` query param NARA's own catalog URLs use); minutes_href
 * is that same volume's catalog URL with a literal "$page" placeholder, and
 * minutes_src the direct image download URL with a literal "$page:4"
 * placeholder (the ":4" meaning zero-padded to 4 digits, since — unlike the
 * catalog URL's plain query-string page number — the image filename itself
 * embeds the page number that way) — both for the frontend to substitute
 * per page. dates.json is created if missing; existing entries are
 * rewritten in this same {minutes_href, minutes_src, minutes_pages} key
 * order every time they're touched, so older entries self-heal into the
 * current shape as new pages come in for the same date.
 *
 * Usage:
 *   node tests/extract_minutes_text.js <volume-url> [--dry-run] [--limit N]
 *
 *   --dry-run   Report what would be saved without writing any files
 *   --limit N   Only process the first N pages (for a quick test run —
 *               a full volume can be 1000+ pages)
 */

import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

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
// after the day the way a hand-typed date reliably would be.
const FULL_DATE_RE = new RegExp(`\\b(${MONTH_NAMES})\\s*,?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b`, 'i');

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

function loadDatesJson(term) {
  const p = join(TERMS_DIR, term, 'dates.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const volumeUrl = args.find(a => !a.startsWith('--') && !/^\d+$/.test(a));
  if (!volumeUrl) {
    console.error('Usage: node tests/extract_minutes_text.js <volume-url> [--dry-run] [--limit N]');
    process.exit(1);
  }
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
  let datesAdded = 0, datesSkipped = 0;
  let lastYear = null;
  let lastFullDate = null;
  const changedTerms = new Set();

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

    let fullDate = extractFullDate(text, yearRange);
    // Minutes pages are bound in date order — a "full date" earlier than the
    // last one we accepted is almost certainly an OCR misread, not an actual
    // step backward in time, so it's treated the same as finding no date at
    // all (fall back to the previous page's date) rather than trusted as-is.
    if (fullDate && lastFullDate && fullDate < lastFullDate) {
      console.log(`  ${label}: extracted date ${fullDate} precedes previous page's ${lastFullDate}; ignoring`);
      fullDate = null;
    }
    if (!fullDate) {
      if (!lastFullDate) {
        console.log(`  ${label}: no full date found, and no earlier page to fall back to; skipping dates.json`);
        datesSkipped++;
        continue;
      }
      console.log(`  ${label}: no full date found; using previous page's ${lastFullDate}`);
      fullDate = lastFullDate;
    }
    lastFullDate = fullDate;

    const term = termForDate(fullDate, termStarts);
    if (!term) {
      console.log(`  ${label}: ${fullDate} matches no known term; skipping dates.json`);
      datesSkipped++;
      continue;
    }

    const dates = getDates(term);
    const existingEntry = dates[fullDate] || {};
    const existingPages = new Set(Array.isArray(existingEntry.minutes_pages) ? existingEntry.minutes_pages : []);
    const hadPage = existingPages.has(pageNum);
    const hadSrc  = !!existingEntry.minutes_src;
    existingPages.add(pageNum);

    // Always rebuilt (rather than mutated in place) so the key order stays
    // {minutes_href, minutes_src, minutes_pages} even for an entry that
    // predates minutes_src, self-healing it into the current shape.
    dates[fullDate] = {
      minutes_href: existingEntry.minutes_href || minutesHrefTemplate,
      minutes_src: existingEntry.minutes_src || minutesSrcTemplate,
      minutes_pages: [...existingPages].sort((a, b) => a - b),
    };

    if (!hadPage || !hadSrc) {
      changedTerms.add(term);
      if (!hadPage) {
        datesAdded++;
        console.log(`  ${label}: ${term}/dates.json[${fullDate}].minutes_pages += ${pageNum}`);
      } else {
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
  console.log(`Dates: ${datesAdded} minutes page(s) recorded across ${changedTerms.size} term(s), ${datesSkipped} page(s) had no usable date.`);
  if (dryRun) console.log('(dry run — no files written)');
}

main();
