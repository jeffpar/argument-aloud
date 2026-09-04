#!/usr/bin/env node
/**
 * scripts/parse_journals.js
 *
 * By default, parses each local journal PDF's extracted text into an XML
 * file under courts/ussc/journals/xml/ — see buildXmlForYear() below.
 *
 * With --pages, instead scans local journal PDFs to detect how many
 * front-matter pages precede the journal's actual "Page 1", then stores
 * that as a `journal_pages` breakpoint string (e.g. "1:11") in terms.json
 * for any term where the offset is > 0 — the same "<journal page>:<pdf
 * page>" format used by the "pages" field on U.S. Reports entries, so it
 * also supports additional comma-separated breakpoints for journals with
 * a mid-volume renumbering (preserved as-is; this script only ever
 * detects/updates the first one).
 *
 * Detection strategy (--pages):
 *   1. Extract text from first 40 PDF pages via pdftotext.
 *   2. Find pages that contain a day-of-week word (MONDAY, TUESDAY…) on
 *      the page or an adjacent page — indicating journal body content.
 *   3. Among those pages, find any with a standalone small integer (1–5).
 *   4. Use the lowest such integer to work backward and compute offset:
 *        offset = pdfPageIndex_of_that_page − (pageNum − 1)
 *   5. For PDFs shared between a special term and an October term,
 *      month-keyword filtering selects the right section.
 *
 * With --verify-case-dates (requires YEAR), cross-checks the October Term
 * YEAR's cases.json against the already-generated YYYY.xml: for every case,
 * every date in its argument/reargument/decision fields that falls on or
 * after the journal XML's first recorded date must appear as a <case> tag
 * (matching that case's docket number) under a <date> tag for that same
 * date — see runVerifyCaseDates() below. Read-only; reports mismatches
 * without writing anything.
 *
 * With --verify-journal-dates (requires YEAR), the inverse check: scans the
 * already-generated YYYY.xml for every case whose disposition text mentions
 * an argument or reargument, confirms cases.json has that case with the
 * date present in its argument/reargument field(s) and a matching events[]
 * entry, and prints a best-effort extraction of the advocates named in that
 * text as <NAME>|<TITLE>|<ROLE> lines (a diagnostic for how well that
 * extraction is working) — see runVerifyJournalDates() below. Add --prompt
 * to interactively write those extracted advocates onto the matching
 * events[] entry (asks first, per case; never overwrites one that already
 * has advocates). Otherwise read-only.
 *
 * Editorial <br> marker: a court-wide order/announcement with no case
 * number of its own (e.g. "The Chief Justice announced the following
 * order: ...") would otherwise be silently absorbed into whichever case's
 * <text> happened to precede it — there's nothing in the source text a
 * parser could use to tell those apart on its own. Hand-inserting a bare
 * <br> line into the source .txt right before such a passage tells the
 * parser to close out whatever's currently open and start a new top-level
 * <text> instead (a sibling of <case>, not nested inside one), running
 * until the next case start. See parseJournalText()'s `standalone` handling
 * and renderJournalXml()'s top-level 'text' branch.
 *
 * Usage:
 *   node scripts/parse_journals.js [YEAR] [--dry-run] [--verbose]
 *   node scripts/parse_journals.js [YEAR] --pages [--dry-run] [--verbose]
 *   node scripts/parse_journals.js YEAR --verify-case-dates
 *   node scripts/parse_journals.js YEAR --verify-journal-dates [--prompt]
 *
 *   YEAR                    Only process that journal year (e.g. 1971); the
 *                           year may be given anywhere among the options.
 *   --pages                 Run the journal_pages offset-detection pass
 *                           instead of generating XML (see above)
 *   --verify-case-dates     Cross-check YEAR's cases.json against YYYY.xml
 *                           (see above)
 *   --verify-journal-dates  Cross-check YYYY.xml against YEAR's cases.json,
 *                           the other direction (see above)
 *   --prompt                With --verify-journal-dates, interactively
 *                           write extracted advocates into cases.json
 *   --dry-run               Report changes without writing terms.json / XML
 *                           files
 *   --verbose               Also print unchanged terms / per-file XML stats
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { reorderEvent, reorderAdvocate } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TERMS_PATH = join(ROOT, 'courts/ussc/terms/terms.json');
const PDF_DIR = join(ROOT, 'courts/ussc/journals/pdfs');
const TEXT_DIR = join(ROOT, 'courts/ussc/journals/text');
const XML_DIR = join(ROOT, 'courts/ussc/journals/xml');

const DAYS = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract the journal year from a journal_url URL. */
function yearFromHref(href) {
  // Old scanned journals: .../YYYY_journal.pdf
  let m = href.match(/(\d{4})_journal\.pdf/i);
  if (m) return parseInt(m[1], 10);
  // Modern journals: .../JnlYY.pdf or .../jnlYY.pdf
  // 2-digit years: 93-99 → 19XX, 00-25 → 20XX
  m = href.match(/[Jj]nl(\d{2})\.pdf/);
  if (m) {
    const yy = parseInt(m[1], 10);
    return yy >= 88 ? 1900 + yy : 2000 + yy;
  }
  // Self-hosted (e.g. "{{ indexes_base_url }}/.../pdfs/YYYY.pdf" or "YYYY-partial.pdf"):
  // same filename convention as pdfFilename() below.
  m = href.match(/(\d{4})(?:-partial)?\.pdf$/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** Local PDF filename for a given year. */
function pdfFilename(year) {
  if (year === 2025) return '2025-partial.pdf';
  return `${year}.pdf`;
}

/**
/**
 * Month keywords to narrow the search to this term's section of the PDF.
 * Shared PDFs (e.g. 1942, 1953, 1958) contain both a special term and an
 * October term; keywords let us pick the right page-1.
 * Returns { keywords: Set, allowFallback: boolean }.
 */
function termMonthInfo(file) {
  const m = file.match(/\/\d{4}-(\d{2})\//);
  const month = m ? parseInt(m[1], 10) : 0;
  // For October terms, allow falling back to unfiltered candidates when the
  // month filter finds nothing.  Very old scanned PDFs open mid-term so the
  // word "OCTOBER" may not appear near the journal's first page.
  // For all other terms, do NOT fall back — it would return the October
  // section's offset for a special term sharing the same PDF.
  const allowFallback = (month === 10);
  switch (month) {
    case 10: return { keywords: new Set(['OCTOBER','NOVEMBER','DECEMBER']), allowFallback };
    case  7: return { keywords: new Set(['JULY']),                          allowFallback };
    case  6: return { keywords: new Set(['JUNE']),                          allowFallback };
    case  8: return { keywords: new Set(['AUGUST','SEPTEMBER']),            allowFallback };
    case 12: return { keywords: new Set(['DECEMBER','JANUARY']),            allowFallback };
    case  2: return { keywords: new Set(['FEBRUARY','MARCH']),              allowFallback };
    case  1: return { keywords: new Set(['JANUARY','FEBRUARY']),            allowFallback };
    default: return { keywords: null,                                       allowFallback: true };
  }
}

/** Run pdftotext and return an array of per-page text strings. */
function extractPages(pdfPath, maxPages = 50) {
  try {
    const buf = execSync(
      `pdftotext -f 1 -l ${maxPages} "${pdfPath}" -`,
      { maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return buf.toString('utf8').split('\f');
  } catch {
    return [];
  }
}

/**
 * Find the journal page offset for one term inside the extracted page array.
 *
 * monthKeywords: Set of uppercase month names for this term's section.
 * allowFallback: When the month filter finds no results, fall back to all
 *   day-adjacent candidates.  Should be true only for October terms, where
 *   very old scanned PDFs may open mid-term (e.g. "Monday, March 3, 1890")
 *   so the month "OCTOBER" never appears near page 1.  For special terms that
 *   share a PDF, the fallback would return the October section's offset instead.
 *
 * Returns 0 if page 1 is the first PDF page, null if detection failed.
 */
function findOffset(pages, monthKeywords, allowFallback = true) {
  // First 10 lines of each page, uppercased — the dateline "MONDAY, OCTOBER
  // 4, 1943" always appears there. Used for both the day-word and (below)
  // month-keyword checks so neither is fooled by incidental day/month names
  // in front-matter prose (e.g. a REFERENCE INDEX entry mentioning "a
  // Saturday" or "August Special Term").
  const headerOf = (idx) => pages[idx].split('\n').slice(0, 10).join(' ').toUpperCase();
  const headers = pages.map((_, i) => headerOf(i));

  // Pre-compute which pages have a day-of-week word in their header.
  const hasDay = headers.map(h => DAYS.some(d => h.includes(d)));

  // Collect candidates: pages with a day word nearby AND a standalone small int
  const candidates = [];
  for (let i = 0; i < pages.length; i++) {
    // Accept if THIS page or the PREVIOUS page has a day word.
    // We deliberately do NOT check the next page: index pages that immediately
    // precede journal content would otherwise become false candidates.
    const dayNearby = hasDay[i] || (i > 0 && hasDay[i - 1]);
    if (!dayNearby) continue;

    for (const line of pages[i].split('\n')) {
      const t = line.trim();
      if (/^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        if (n >= 1 && n <= 5) {
          candidates.push({ idx: i, pageNum: n });
          break; // one small number per PDF page is enough
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  // Filter to this term's section using month keywords (for shared PDFs).
  // Check only the header (first 10 lines) of the candidate page — not the
  // full body text, which may contain cross-references to other terms
  // (e.g. "August Special Term").
  let filtered = candidates;
  if (monthKeywords && monthKeywords.size > 0) {
    const withMonth = candidates.filter(({ idx }) =>
      [...monthKeywords].some(m => headers[idx].includes(m))
    );
    if (withMonth.length > 0) {
      filtered = withMonth;
    } else if (!allowFallback) {
      // Month filter found nothing and fallback is disabled (special terms in
      // shared PDFs) — we can't reliably locate this term's page 1.
      return null;
    }
    // else: allowFallback=true, keep unfiltered candidates
  }

  filtered.sort((a, b) => a.idx - b.idx);

  // Use the EARLIEST candidate (by PDF page index) to compute the offset.
  // We deliberately do NOT use the minimum page number across all candidates:
  // later pages often contain incidental small numbers (case references like
  // "No. 1", footnotes, etc.) that would produce a falsely large offset.
  // The "work backward" logic handles cases where the first detected page
  // number is 2 or 3 rather than 1.
  const anchor = filtered[0]; // already sorted by idx

  const page1PdfIdx = anchor.idx - (anchor.pageNum - 1);
  return Math.max(0, page1PdfIdx);
}

/**
 * Extract the numeric offset for the first breakpoint from a journal_pages
 * string (e.g. "1:11" → 10, "1:11,300:295" → 10), for comparison against a
 * freshly detected offset.
 */
function firstBreakpointOffset(str) {
  if (!str) return null;
  const first = str.split(',')[0].trim();
  const colon = first.indexOf(':');
  if (colon < 0) return null;
  const start = Number(first.slice(0, colon));
  const pdfPage = Number(first.slice(colon + 1));
  if (!Number.isFinite(start) || !Number.isFinite(pdfPage)) return null;
  return pdfPage - start;
}

/**
 * Return a new term object with journal_pages set (offset > 0) or removed
 * (offset === 0), inserted right after the journal_url key. Any additional
 * comma-separated breakpoints already present past the first are carried
 * over unchanged — this script only ever detects/updates the first one.
 */
function applyOffset(term, offset) {
  const rest = (term.journal_pages || '').split(',').slice(1).join(',');
  const newValue = offset > 0 ? `1:${offset + 1}${rest ? ',' + rest : ''}` : null;

  const result = {};
  let placed = false;
  for (const [k, v] of Object.entries(term)) {
    if (k === 'journal_pages') continue; // drop old value
    result[k] = v;
    if (k === 'journal_url') {
      if (newValue) {
        result.journal_pages = newValue;
        placed = true;
      }
    }
  }
  if (!placed && newValue) result.journal_pages = newValue;
  return result;
}

// ── XML generation (default mode) ───────────────────────────────────────────
//
// Walks a journal's extracted text top to bottom and emits, in the order
// encountered:
//   <date value="YYYY-MM-DD">Weekday, Month D, YYYY</date>
//   <case number="N">Title</case>
//   <text>Disposition prose</text>
// One <date> per calendar date (repeats of the same running-header date,
// printed at the top of every continuation page, are collapsed into the
// first occurrence). Everything between a date heading and the first "No."
// case entry (roll call, admissions to the bar, etc.) is discarded — only
// date and case/text content is kept. A <text> block holds every paragraph
// following one or more <case> tags, up to the next case or date; several
// consecutive <case> tags with no text of their own (a consolidated group,
// e.g. "Nos. 1274–1276") share the one <text> block attached to the last of
// them.

const DAY_NAMES_UPPER = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];
const DAY_NAMES_DISPLAY = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTH_NAMES_DISPLAY = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_NUMBER = Object.fromEntries(MONTH_NAMES_DISPLAY.map((m, i) => [m.toUpperCase(), i + 1]));

// Matches a running-header date heading anywhere in a line — the day name
// must appear in ALL CAPS (as it always does for genuine headings, in every
// era of journal sampled) to avoid false positives from ordinary prose that
// happens to mention a date in passing (e.g. a reference-index entry reading
// "...opinion released at 10 p.m., Tuesday, December 12, 2000...", or "...
// adjourned until Monday, April 21st next..." — both Title Case, both real
// running text, neither a page heading).
// The day-of-month suffix also needs to tolerate the 19th-century printing
// convention of abbreviating "2nd"/"3rd"/"22nd"/"23rd" (etc.) down to a bare
// "d" — e.g. "MONDAY, MARCH 2d, 1891." Unlike the day name and month, which
// are always printed (and matched) in caps, this bare suffix is set in
// lowercase even inside an all-caps heading, so it's matched case-
// insensitively while ST/ND/RD/TH stay caps-only like the rest of the line.
const DATE_HEADING_RE = new RegExp(
  `\\b(${DAY_NAMES_UPPER.join('|')}),?\\s+([A-Za-z]+)\\.?\\s+(\\d{1,2})(?:ST|ND|RD|TH|[dD])?,?\\s+(\\d{4})\\b`
);

// "No. 195. Title..." — the leading "No."/"Nos." marker for a case-start
// line. The number token itself is parsed separately by parseCaseStart()
// below since it comes in several eras' worth of formats.
const CASE_START_LEAD_RE = /^Nos?\.\s*(.+)$/;

// Case-number token formats, tried in this order:
//   1. Modern emergency/shadow-docket style: "24A61", "24M3" (term-year
//      digits, a single A/M letter, then digits) — must come before the
//      plain-numeric alternative below, which would otherwise just grab the
//      leading digits and strand the letter+digits in the title text.
//   2. Application-docket style: "A-483" (a bare letter, dash, digits).
//   3. Classic numeric, optionally comma/dash-joined for a rare jointly
//      numbered entry (e.g. "1274-1276").
const CASE_NUMBER_RE = /^(\d+[AM]\d+|[A-Z]-\d+|\d[\d,\-–—]*)/;

// Old-style docket suffix immediately after the number: "9 Original" / "45,
// Original" / "5. Original." / "7.-Original." / "1070 Misc" / "648, Misc" —
// normalized onto the number as "9-Orig" / "45-Orig" / "5-Orig" / "7-Orig" /
// "1070-Misc" / "648-Misc". The punctuation/dash prefix covers older
// journals (e.g. 1889's "No. 5. Original. Ex parte..." or "No. 7.-Original.
// The State...") that separate the suffix from the number with a sentence-
// ending period (optionally followed by the usual number-to-title dash)
// rather than a comma. On a joint entry ("Nos. 6 and 7. Original."), the
// suffix applies to each number individually: "6-Orig,7-Orig", not "6,7-Orig".
// The extra (?!') (on top of \b) keeps an abbreviation like "orig'l" (a real
// day-call-list token, not our suffix) from matching just its "orig" prefix —
// \b alone treats the apostrophe as a word boundary and would accept it.
// Deliberately narrower than excluding all letters: \b already rejects a
// continuation into more letters (e.g. "Originally") just fine on its own,
// and duplicating that exclusion here (e.g. via a lookahead against all
// letters) changes whether the optional trailing period gets backtracked
// away in "Misc., ..." — which then falsely trips the day-call-list comma
// check below and truncates a real case's disposition text mid-sentence.
// A second alternative handles the suffix wrapped in parens instead — e.g.
// "No. 5 (original).-Title" or "No. 8.—(Original.) Title" — where the
// closing ")" itself unambiguously ends the token, so no \b/(?!') guard is
// needed there the way the bare-word alternative needs one.
const CASE_SUFFIX_RE = /^[.,:;\-–—\s]*(?:\((Original|Orig|Misc)\.?\)|(Original|Orig\.?|Misc\.?)\b(?!'))/i;

/**
 * Parse a "No. ..."/"Nos. ..." case-start line into { number, rest }, where
 * rest is everything left over (leading punctuation trimmed) for the title
 * text to build from. Returns null if the line doesn't actually start a
 * case (e.g. "No." with nothing recognizable as a number after it).
 */
function parseCaseStart(line) {
  const lead = CASE_START_LEAD_RE.exec(line);
  if (!lead) return null;
  let rest = lead[1];

  const numMatch = CASE_NUMBER_RE.exec(rest);
  if (!numMatch) return null;
  rest = rest.slice(numMatch[0].length);
  // The classic-numeric alternative's trailing-comma allowance is there for
  // an old-style docket suffix ("17, Original"); a lone trailing comma
  // isn't part of the number itself either way.
  const hadTrailingComma = /,$/.test(numMatch[0]);
  let number = numMatch[0].replace(/,$/, '');
  // Likewise a trailing dash: the same alternative's dash allowance exists
  // for a genuine joint-number range ("1274-1276"), which always has a
  // digit right after the dash — the regex is greedy, so it only stops
  // exactly on a dash when nothing digit-like follows, meaning this is
  // really the usual number-to-title separator dash rendered with no space
  // ("No. 1164-The United States..."), not part of the number.
  number = number.replace(/[-–—]$/, '');

  // "Nos. X and Y.—Title" / "Nos. W, X, Y, and Z.—Title" — up to three further
  // numbers sharing this one entry, folded into the number attribute
  // ("X,Y" / "W,X,Y,Z"). A day-call schedule line that happens to start the
  // same way ("Nos. 252 and 1537, 1224, 253, 256, ...") runs on far longer,
  // so finding a 5th number (checked right after the loop, below) is itself
  // a signal that this is a list, not a case. Deliberately capped at 4
  // total rather than higher still: a *decision* disposition narrating a
  // companion group can itself read "...in Nos. 8, 9, 10, 11, and 12.
  // Dissenting..." mid-sentence, wrapped onto its own physical line — with a
  // 5-total cap that reads as a brand new (bogus) 5-number case-start
  // instead of the disposition prose it actually is; capping at 4 leaves
  // that specific pattern one number short, so it still trips the
  // pending-number check below instead.
  const MORE_NUMBER_RE = /^(?:,\s*|\s+)(?:and\s+)?(\d+)\b/i;
  let extraNumbers = 0;
  for (; extraNumbers < 3; extraNumbers++) {
    const more = MORE_NUMBER_RE.exec(rest);
    if (!more) break;
    number += ',' + more[1];
    rest = rest.slice(more[0].length);
  }
  if (MORE_NUMBER_RE.test(rest)) return null;

  const suffixMatch = CASE_SUFFIX_RE.exec(rest);
  if (suffixMatch) {
    // Group 1 is the parenthesized form, group 2 the bare-word form — only
    // one of the two ever actually matches (see CASE_SUFFIX_RE above).
    const tag = /orig/i.test(suffixMatch[1] || suffixMatch[2]) ? '-Orig' : '-Misc';
    // A joint entry's suffix applies to every one of its numbers individually
    // ("Nos. 6 and 7. Original." -> "6-Orig,7-Orig"), not just the last one.
    number = number.split(',').map(n => n + tag).join(',');
    rest = rest.slice(suffixMatch[0].length);
    // A day-call schedule line can itself start "Nos. 2 original, 253,
    // 256, ..." — the suffix matches, but a comma right after means this
    // is really that list, not a title.
    if (/^,/.test(rest)) return null;
  }
  let usedEtc = false;
  if (!suffixMatch) {
    // "No. 1126, etc.—Title" / "No. 1126., etc. Title" — a case reargued or
    // re-called on a later day is often re-announced with a trailing "etc."
    // standing in for its consolidated companions, in place of a repeated
    // joint-number list or Original/Misc suffix. Strip it here so it neither
    // trips the trailing-comma rejection below nor leaks into the title.
    // The period is mandatory (not "\.?") so this can't also match a bare
    // capitalized acronym that happens to spell "ETC" as an actual party
    // name (e.g. "No. 17-422. ETC Marketing, Ltd., Petitioner v. ...") —
    // every genuine "etc." abbreviation in these journals is followed by
    // its period; a real party name isn't.
    const etcMatch = /^[.,:;\-–—\s]*etc\./i.exec(rest);
    if (etcMatch) {
      usedEtc = true;
      rest = rest.slice(etcMatch[0].length);
    } else if (hadTrailingComma && extraNumbers === 0) {
      // The comma was consumed as part of the greedy number match, but
      // nothing recognizable followed it (no further joint-case number, no
      // Original/Orig/Misc suffix, no "etc.") — so it wasn't part of this
      // entry at all. This is a mid-sentence cross-reference to an
      // already-open case (e.g. "...for the appellant in\nNo. 70-161, and
      // the appellee in No. 70-5211...") that just happens to land at the
      // start of a wrapped line, not a new case-start; treating it as one
      // would wrongly cut off the sentence it's actually part of.
      return null;
    }
  }

  // Drop a trailing period/colon/semicolon/comma and/or dash(es) before the
  // title text begins (OCR sometimes renders the em dash after the period
  // as one or more hyphens, e.g. "No. 1195.-Title" or "No. 294.--Title"; a
  // docket suffix is sometimes punctuated as "Original:", "Original;", or
  // "Original," followed by more punctuation of its own — e.g. "210, Misc.,
  // October Term, 1947. Title" — leaving that leftover punctuation here).
  rest = rest.replace(/^[.,:;\-–—\s]*/, '');
  // A genuine case entry's title always starts right on this same line —
  // nothing left (e.g. a bare "Nos. 520 and 521." that's actually a
  // mid-sentence cross-reference to an already-open case, not a new one)
  // means this wasn't really a case-start line at all.
  if (!rest.trim()) return null;
  // A joint entry (multiple numbers, no Original/Misc suffix) or an "etc."
  // continuation still risks being something else that merely *looks* like
  // one at the point the number loop (or the etc. match) gave up — e.g.
  // "...252, 1537, 1224, 2 orig'l, 253, ..." stops right at the
  // un-abbreviated "orig'l" token, leaving exactly that as a bogus "title".
  // A real title here always starts with a capitalized word (a party name,
  // "The", "Ex parte", "In re", ...); anything else at this point is
  // leftover list/sentence debris, not a case.
  if ((extraNumbers > 0 || usedEtc) && !suffixMatch) {
    const trimmed = rest.trim();
    if (!/^[A-Z]/.test(trimmed)) return null;
    // "etc." specifically also shows up mid-sentence inside an entity's own
    // name ("...Trust No. 140, etc. Petition for writ of..." — "No. 140" is
    // the trust's own number, not a docket, and just happens to start a
    // wrapped line) — a genuine title never opens with disposition language,
    // so require the DISPOSITION_RE trigger vocabulary not appear right at
    // its start either.
    if (usedEtc) {
      const dispMatch = DISPOSITION_RE.exec(trimmed);
      if (dispMatch && dispMatch.index === 0) return null;
    }
  }
  return { number, rest };
}

// Lines that are pure pagination/printing noise and never real case content.
const NOISE_LINE_RE = /^(?:[\d-]{6,}|SUPREME COURT OF THE UNITED STATES\.?|\(JOURNAL\)|JOURNAL)$/;

// A bare, standalone integer is usually the journal's own printed page
// number for whatever page follows — see PAGE_NUM_RE's use in
// parseJournalText() below. (Handled separately from NOISE_LINE_RE since,
// unlike genuine noise, we want to capture its value rather than discard it.)
const PAGE_NUM_RE = /^\d+$/;

// Earliest occurrence of any of these (case-insensitive) phrases splits a
// closed case entry's raw text into <case> (before) and <text> (from the
// match onward). If none is found, the whole entry is the case title and no
// <text> is emitted (e.g. one entry of a consolidated group whose
// disposition is only stated once, on the last entry).
const DISPOSITION_RE = new RegExp(
  '\\b(' + [
    // Procedural-posture phrases (how the case reached the Court).
    'in error to', 'on error to', 'in equity', 'on appeals? from', 'appeals? from',
    'apppeals? from', 'appeals? fro', 'on writ of error', 'on writs? of certiorari',
    'on writs? of', 'on (?:a )?certificate', 'on motion', 'on bill of', 'on petition',
    'petitions?', 'petitioner for', 'application for',
    // OCR mangles "Petition" a lot in these scanned journals — the same
    // handful of dropped/doubled/misordered letters recur often enough to
    // list: "Petion" (dropped middle "ti"), "Petiton" (dropped "i"),
    // "Petititon" (extra "t"), "Petitition" (doubled "ti"), "Peition"
    // (dropped first "t"), "Peittion" ("t"/"i" transposed).
    'petions? for', 'petitons? for', 'petititons? for', 'petititions? for',
    'peitions? for', 'peittions? for',
    'original motion', 'motions? of', 'motions? for', 'motions? to', 'motions? that',
    'suggestions? of', 'deaths? of', 'rules? to show', 'submitted by', 'submitted on',
    'submitted under',
    'ordered by', 'questions? of', 'printed arguments',
    // A leading "The"/"These" here is always the start of a new narrative
    // sentence ("... et al. The motion of the United States...", "...
    // These cases are severally denied."), never part of a case caption, so
    // these are matched with the article/pronoun included rather than
    // relying on the generic leading-article pullback below.
    'the motions?', 'the appeal', 'the judgment', 'the report of',
    'the requests? of', 'the requests? for', 'the applications? of',
    'the applications? to', 'the applications? for', 'the order of',
    'the chief[\\s-]justice announced', 'these cases are',
    // Disposition/outcome phrases.
    'leave granted', 'it is ordered', 'it having been',
    'judgment affirmed', 'judgment reversed', 'judgment vacated',
    'decree', 'order affirmed', 'per curiam', 'opinion by',
    // Argument-calendar verbs — always narrate what happened next, never
    // part of a case caption.
    'argument commenced', 'argument continued', 'argument concluded',
    'reargued', 'argued', 'dismissed', 'continued', 'passed', 'advanced',
    'ordered to', 'one hour',
  ].join('|') + ')\\b',
  'i'
);

// A disposition trigger splits mid-sentence (e.g. right at "in error to...",
// lowercase because it was originally the middle of the case's own opening
// sentence) — capitalize the split-off text's first letter now that it
// stands alone as its own <text>.
function capitalizeFirst(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inverse of xmlEscape() — for re-reading text back out of generated XML. */
function xmlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function formatDateDisplay(d) {
  return `${DAY_NAMES_DISPLAY[d.getUTCDay()]}, ${MONTH_NAMES_DISPLAY[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function formatDateISO(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function monthNumberFromToken(token) {
  const upper = token.toUpperCase().replace(/[^A-Z]/g, '');
  if (MONTH_NUMBER[upper]) return MONTH_NUMBER[upper];
  // Tolerate OCR noise beyond a simple case fix (e.g. a dropped/garbled
  // letter) by matching on a distinguishing prefix.
  const hit = Object.keys(MONTH_NUMBER).find(name => name.startsWith(upper.slice(0, 3)) || upper.startsWith(name.slice(0, 3)));
  return hit ? MONTH_NUMBER[hit] : null;
}

/**
 * Try to parse+validate one regex match into a Date. The printed day-of-week
 * name is deliberately NOT used as a gating check — cross-checked against a
 * handful of real journals, it is itself sometimes the OCR-garbled field
 * (e.g. "THURSDAY, OCTOBER 31, 1990" printed for a date that was actually a
 * Wednesday), so trusting it over forward chronological progress caused far
 * worse damage: a wrong "corrected" year (chosen only because it happened to
 * land on the asserted weekday) would poison every date for the rest of the
 * file, since everything genuinely later would then look like it was going
 * backward relative to that bad anchor. Forward-or-equal progress against
 * the last accepted date is the one invariant enforced here.
 * Returns null if no plausible forward (or same-day) date can be found.
 */
function resolveHeadingDate(match, lastDate) {
  const [, , monthToken, dayNumStr, yearStr] = match;
  const month = monthNumberFromToken(monthToken);
  if (!month) return null;
  const dayNum = parseInt(dayNumStr, 10);
  const year = parseInt(yearStr, 10);

  const makeDate = (y, m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 ? dt : null; // null if it rolled over (e.g. Feb 30)
  };

  const naive = makeDate(year, month, dayNum);
  if (!naive) return null;
  if (!lastDate) return naive; // nothing to compare against yet — accept on faith

  if (daysBetween(lastDate, naive) >= 0) return naive;

  // Naive reading goes backward — try a single-digit OCR misread of the day
  // number only (the most common, most narrowly-scoped error) and accept it
  // solely if that lands within a plausible ~6-week forward window; anything
  // wider (e.g. guessing a different year) risks a false, cascading match.
  for (const dd of [dayNum - 1, dayNum + 1, dayNum - 2, dayNum + 2]) {
    const alt = makeDate(year, month, dd);
    if (!alt) continue;
    const delta = daysBetween(lastDate, alt);
    if (delta >= 0 && delta <= 45) return alt;
  }
  return null;
}

/** Split one closed case entry's accumulated raw text into title + text. */
// A whole self-contained sentence with a wildly variable opening ("One and
// one half hours allowed for oral argument.", "Two hours allowed for
// argument.", "One hour and twenty minutes allowed for reargument.") but a
// fixed, reliable tail. Rather than enumerate every duration phrasing, this
// is matched by its tail and then backed up to the start of ITS sentence —
// see findSentenceStart() below — instead of the fixed point the trigger
// itself matched at.
const ARGUMENT_TIME_RE = /\ballowed for (?:oral )?(?:re)?argument\b/i;

// Same idea for counsel-invitation sentences ("Thomas H. Kuchel, Esquire, of
// Beverly Hills, California, a member of the Bar of this Court, is invited
// to brief and argue this case..."): the opening is an arbitrary name/city,
// but the sentence always contains one of these fixed phrases somewhere in
// its back half.
const AMICUS_INVITATION_RE = /\b(?:members? of the Bar of this Court|is invited to)\b/i;

// Same again for "<Name>, <title>, announced..." sentences ("Mr.
// Solicitor General Taft announced to the court that an order had
// been..."): the opening name/title is arbitrary, but every such sentence
// contains the word "announced".
const ANNOUNCED_RE = /\bannounced\b/i;

const SENTENCE_BACKUP_TRIGGERS = [ARGUMENT_TIME_RE, AMICUS_INVITATION_RE, ANNOUNCED_RE];

// A period preceded by a single letter is a middle-initial abbreviation
// ("Thomas H. Kuchel"), not a sentence end; likewise a short list of common
// title/legal abbreviations that happen to end a "word" in this text.
const ABBREV_TOKEN_RE = /^(?:[A-Za-z]|Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|Inc|Co|Nos?|U\.?S|Esq)$/i;

/** Index right after the last sentence-ending punctuation before `beforeIndex`, or 0. */
function findSentenceStart(str, beforeIndex) {
  const re = /[.!?]\s+/g;
  let boundary = 0;
  let mm;
  while ((mm = re.exec(str))) {
    const end = mm.index + mm[0].length;
    if (end > beforeIndex) break;
    if (str[mm.index] === '.') {
      const wordBefore = /([A-Za-z]+)\.$/.exec(str.slice(0, mm.index + 1));
      if (wordBefore && ABBREV_TOKEN_RE.test(wordBefore[1])) continue;
    }
    boundary = end;
  }
  return boundary;
}

// Trims trailing connective "cruft" left over once a case entry's title
// text has been isolated: a lone trailing comma/semicolon, and — since a
// list of jointly-disposed-of cases is often punctuated "No. 1031... et
// al.; and\nNo. 1054...", where "; and" (or ", and") is pure connective
// tissue between list entries rather than part of any one title — that
// connective itself.
// `stripPeriod` controls whether a trailing period is fair game too: when a
// case entry has no disposition text at all, a trailing period is that
// entry's own terminator and should go; but when splitting title from text
// at a disposition trigger, a period right at the cut usually belongs to an
// abbreviation in the title itself (e.g. "...et al." before ", in error
// to...") and must be preserved, so only the comma/semicolon separator
// after it is stripped there.
function stripTitleTrailer(s, { stripPeriod = false } = {}) {
  let out = s.replace(/[,;]\s+and\s*$/i, '').trim();
  out = stripPeriod ? out.replace(/[.,;]+$/, '') : out.replace(/[,;]+$/, '');
  return out.trim();
}

// Expands common 19th-century docket-role abbreviations — but only within a
// case's TITLE, never its disposition <text> — e.g. "James D. Crenshaw,
// app., vs. United States" -> "James D. Crenshaw, appellant, vs. United
// States". Order matters: plural forms first, since a boundary-anchored
// singular pattern (e.g. \bapp't\b) already can't match inside "app'ts"
// (no word break before the trailing "s"), but checking plurals first keeps
// that invariant even if the patterns below are ever loosened.
function expandTitleAbbreviations(title) {
  return title
    .replace(/\bapp['’]ts\b\.?/g, 'appellants')
    .replace(/\bappts\b\.?/g, 'appellants')
    .replace(/\bapp['’]t\b\.?/g, 'appellant')
    .replace(/\bappt\b\.?/g, 'appellant')
    .replace(/\bapp\./g, 'appellant')
    .replace(/\bpl['’]ffs\b\.?/g, 'plaintiffs')
    .replace(/\bplffs\b\.?/g, 'plaintiffs')
    .replace(/\bpl['’]ffin\b/g, 'plaintiff in') // run-together OCR: "pl'ffin error"
    .replace(/\bpl['’]ff\b\.?/g, 'plaintiff')
    .replace(/\bplff\b\.?/g, 'plaintiff')
    .replace(/\bp\. ?e\.?\b/g, 'plaintiff in error');
}

// Older journals hyphenate a handful of terms no longer written that way;
// normalize throughout (title and text alike, unlike the title-only
// abbreviation expansion above — these are spelling conventions, not role
// abbreviations tied to a party's title). Used for both ordinary case text
// (via splitCaseEntry()) and standalone <br>-marked text (via
// parseJournalText()'s flushStandalone()), so it's shared here rather than
// folded into splitCaseEntry() alone.
function normalizeJournalText(s) {
  return s.replace(/\s+/g, ' ').trim()
    .replace(/\bChief-Justice\b/g, 'Chief Justice')
    .replace(/\bAttorney-General\b/g, 'Attorney General')
    .replace(/\bSolicitor-General\b/g, 'Solicitor General')
    .replace(/\bto-morrow\b/g, 'tomorrow');
}

function splitCaseEntry(raw) {
  const cleaned = normalizeJournalText(raw);

  // A handful of trigger words (bare "Petition", "Decree") are also how some
  // entries' own titles legitimately begin ("Petition of Oliver Lee York
  // and Margaret Edna York...", an original-jurisdiction habeas petition
  // that IS the case name). Scan candidates in order and skip any whose
  // split point would leave nothing (or only leftover punctuation) in front
  // of it as the title, rather than trusting the first match blindly.
  let splitIndex = -1;
  const dispositionRe = new RegExp(DISPOSITION_RE.source, 'gi');
  let dm;
  while ((dm = dispositionRe.exec(cleaned))) {
    let idx = dm.index;
    // A noun-phrase trigger ("application for...", "petition for...") is
    // often the object of a new sentence ("... et al. The application for
    // an injunction...") — pull a leading article back into the
    // disposition text rather than leaving it dangling at the title's end.
    const article = /\b(?:The|A|An)\s+$/i.exec(cleaned.slice(0, idx));
    if (article) idx -= article[0].length;
    if (stripTitleTrailer(cleaned.slice(0, idx))) {
      splitIndex = idx;
      break;
    }
    // Empty title — this occurrence is this entry's own opening phrase, not
    // a disposition; keep scanning for a later, genuine trigger instead.
  }

  for (const triggerRe of SENTENCE_BACKUP_TRIGGERS) {
    const tm = triggerRe.exec(cleaned);
    if (!tm) continue;
    const sentenceStart = findSentenceStart(cleaned, tm.index);
    // Only use it if it actually backs up past wherever the title would
    // otherwise end, and leaves a non-empty title.
    if (sentenceStart > 0 && cleaned.slice(0, sentenceStart).trim() &&
        (splitIndex < 0 || sentenceStart < splitIndex)) {
      splitIndex = sentenceStart;
    }
  }

  if (splitIndex < 0) {
    // No disposition text at all — the whole entry is the title, so a
    // trailing period/connective is this entry's own sentence-ending
    // punctuation (or, for a joint listing, "; and" tying it to the next).
    return { title: expandTitleAbbreviations(stripTitleTrailer(cleaned, { stripPeriod: true })), text: null };
  }

  // The disposition trigger is always introduced by a comma/semicolon (or
  // starts a new sentence right after one) — strip only that separator (and
  // a trailing "; and"), not a period, since a period right at the split
  // point usually belongs to an abbreviation in the title itself (e.g.
  // "...et al." before ", in error to...") rather than a mark to discard.
  const title = expandTitleAbbreviations(stripTitleTrailer(cleaned.slice(0, splitIndex)));
  const text = cleaned.slice(splitIndex).trim();
  return { title, text: text ? capitalizeFirst(text) : null };
}

/**
 * Parse one journal's full text into an ordered list of
 * {type:'date',...} / {type:'case', number, title, text} entries.
 *
 * Each <date> entry also carries the printed page number (our best guess,
 * from whichever bare standalone integer most recently preceded it — see
 * PAGE_NUM_RE) it believes it starts on. A page change partway through a
 * date section — signalled by a later standalone integer differing from
 * the open section's page, whether or not a new date heading (repeat or
 * not) intervened — closes out that section and opens a fresh <date> entry
 * for the *same* calendar date with the updated page, rather than mutating
 * the page of an entry that already has content: the XML is a page-by-page
 * transcription first, a per-date grouping second.
 */
// Rejoin a word hyphenated across the original print layout's line break
// (e.g. "Missis-" / "sippi") instead of leaving a stray "- ". Gated on the
// continuation starting lowercase: that's the signal a wrap broke mid-word,
// as opposed to a genuine hyphenated compound that happens to fall at a
// line boundary and continues with a new capitalized word (e.g. "Aerojet-"
// / "General"), where the hyphen is meaningful and should stay — but even
// then, join directly with no extra space, since the hyphen itself is
// already the separator.
function appendContinuation(buffer, line) {
  if (/[A-Za-z]-$/.test(buffer)) {
    return /^[a-z]/.test(line) ? buffer.replace(/-$/, '') + line : buffer + line;
  }
  return buffer + ' ' + line;
}

function parseJournalText(text) {
  const lines = text.split('\n');
  const entries = [];

  let lastDate = null;         // Date of the currently-open date section
  let openCase = null;         // {number, raw} currently accumulating text
  let standalone = null;       // text accumulating outside any case (after a
                                // <br> marker), pending flush as a top-level
                                // <text> entry once the next case/date/EOF
                                // arrives — see the module doc comment's
                                // note on manual editorial extractions
  let currentDateEntry = null; // the <date> entry object currently open
  let currentPage = null;      // its page number (null if never detected)
  let pageHasContent = false;  // has it received any case yet?
  let pendingPage = null;      // most recent standalone page number seen
                                // since the last real content line

  const closeOpenCase = () => {
    if (!openCase) return;
    const { title, text: caseText } = splitCaseEntry(openCase.raw);
    entries.push({ type: 'case', number: openCase.number, title });
    if (caseText) entries.push({ type: 'text', text: caseText });
    openCase = null;
  };

  const flushStandalone = () => {
    if (standalone == null) return;
    const trimmed = normalizeJournalText(standalone);
    if (trimmed) entries.push({ type: 'text', text: trimmed });
    standalone = null;
  };

  const openDateEntry = (dateObj, page) => {
    const entry = { type: 'date', value: formatDateISO(dateObj), display: formatDateDisplay(dateObj) };
    if (page != null) entry.page = page;
    entries.push(entry);
    currentDateEntry = entry;
    currentPage = page ?? null;
    pageHasContent = false;
  };

  // Only safe to call when nothing is currently accumulating (no open case,
  // no open standalone block): closing one here to start a new page's
  // <date> entry would cut off whatever continuation text (a case split
  // across the page break, e.g. "...Ap-" / "peals...") hasn't arrived yet.
  // Callers gate on that for exactly this reason; the caseMatch branch
  // calls it right after its own closeOpenCase()/flushStandalone(), once
  // whatever was open is safely out of the way.
  const applyPendingPage = () => {
    if (lastDate && pendingPage != null && pendingPage !== currentPage) {
      if (pageHasContent) {
        openDateEntry(lastDate, pendingPage);
      } else if (currentDateEntry) {
        // Nothing's been attached to this date/page section yet (e.g. the
        // page number appears after the heading but before the first case,
        // or two standalone integers appeared back to back with the later
        // one being the real page) — just correct it in place instead of
        // opening a second, empty <date> entry.
        currentDateEntry.page = pendingPage;
        currentPage = pendingPage;
      }
    }
    pendingPage = null;
  };

  for (const rawLine of lines) {
    // "☐" is OCR noise from a left-margin mark (a hole-punch, ruled line,
    // etc.) that recurs at the start of essentially any line on certain
    // pages, regardless of content — never meaningful, so it's stripped
    // before any other line handling below (case-start/date-heading
    // detection would otherwise fail to match right past it).
    const line = rawLine.trim().replace(/^☐+\s*/, '');
    if (!line) continue;

    if (PAGE_NUM_RE.test(line)) {
      pendingPage = parseInt(line, 10);
      continue;
    }
    if (NOISE_LINE_RE.test(line)) continue;

    // A hand-inserted <br> marker (see the module doc comment): everything
    // from here up to the next case start is a manual editorial call that a
    // date's cases don't cover — a court-wide order or announcement with no
    // case number of its own — and belongs in its own top-level <text>,
    // never as a case's own text. Whatever's already accumulating (an open
    // case, or an earlier standalone run — a second <br> before any case
    // intervened) is closed out first; text before/after the marker on the
    // same line still belongs to the run it's part of.
    if (line.includes('<br>')) {
      const idx = line.indexOf('<br>');
      const before = line.slice(0, idx).trim();
      const after = line.slice(idx + 4).trim();
      if (before) {
        if (openCase) openCase.raw = appendContinuation(openCase.raw, before);
        else if (standalone != null) standalone = appendContinuation(standalone, before);
      }
      closeOpenCase();
      flushStandalone();
      standalone = after;
      continue;
    }

    const dateMatch = DATE_HEADING_RE.exec(line);
    if (dateMatch) {
      const resolved = resolveHeadingDate(dateMatch, lastDate);
      if (resolved) {
        const isRepeat = lastDate && daysBetween(lastDate, resolved) === 0;
        if (!isRepeat) {
          closeOpenCase();
          flushStandalone();
          openDateEntry(resolved, pendingPage);
          lastDate = resolved;
          pendingPage = null;
        }
        // On a repeat (a continuation page's running-header restating the
        // same date), leave pendingPage as-is: it's handled by the
        // page-boundary check below on whatever real content line follows.
        continue; // heading line itself never contributes to case text
      }
      // Unresolvable heading-shaped line (garbled OCR, or a genuine backward
      // date we can't correct) — fall through and treat it as ordinary text
      // below, same as any other line.
    }

    const caseMatch = parseCaseStart(line);
    if (caseMatch) {
      closeOpenCase();
      flushStandalone();
      applyPendingPage(); // safe now: whatever was open is closed and pushed
      pageHasContent = true;
      openCase = { number: caseMatch.number, raw: caseMatch.rest };
      continue;
    }

    if (!openCase && standalone == null) {
      // Not mid-case and not mid-standalone-block (either before the first
      // case of a date section, or a stray discardable line between cases)
      // — safe to apply a pending page change right away; nothing risks
      // being split by it.
      applyPendingPage();
    }

    if (openCase) {
      openCase.raw = appendContinuation(openCase.raw, line);
    } else if (standalone != null) {
      standalone = appendContinuation(standalone, line);
    }
    // else: content before the first case of a date section (roll call,
    // admissions to the bar, etc.) or before the very first date — discard.
  }
  closeOpenCase();
  flushStandalone();

  return entries;
}

/**
 * Render parsed entries as the journal's XML document text. Each <date>
 * is a container for every <case> that followed it (up to the next <date>),
 * rather than a standalone sibling marker; and each <case> is in turn a
 * container for its own <text> (parseJournalText() always emits a case's
 * <text>, if any, as the very next entry, so a one-entry lookahead is all
 * that's needed to nest it).
 */
function renderJournalXml(year, entries) {
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<journal year="${year}">`];
  let inDate = false;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type === 'date') {
      if (inDate) lines.push('</date>');
      const pageAttr = e.page != null ? ` page="${e.page}"` : '';
      lines.push(`<date value="${e.value}" day="${xmlEscape(e.display)}"${pageAttr}>`);
      inDate = true;
    } else if (e.type === 'case') {
      const next = entries[i + 1];
      if (next && next.type === 'text') {
        lines.push(`  <case number="${xmlEscape(e.number)}">${xmlEscape(e.title)}`);
        lines.push(`    <text>${xmlEscape(next.text)}</text>`);
        lines.push('  </case>');
        i++; // this text entry is now nested; don't visit it again
      } else {
        lines.push(`  <case number="${xmlEscape(e.number)}">${xmlEscape(e.title)}</case>`);
      }
    } else if (e.type === 'text') {
      // A standalone <text> not preceded by its own <case> — a manual <br>-
      // marked editorial extraction (see parseJournalText()) rather than
      // one of parseCaseStart()'s ordinary case/disposition pairs.
      lines.push(`  <text>${xmlEscape(e.text)}</text>`);
    }
  }
  if (inDate) lines.push('</date>');
  lines.push('</journal>');
  return lines.join('\n') + '\n';
}

/** Local extracted-text filename for a given PDF basename (no extension). */
function textFileFor(base) {
  return join(TEXT_DIR, `${base}.txt`);
}

/**
 * Fallback when no cached extracted text exists for a PDF: run pdftotext
 * over the whole document. Quality is noticeably worse than the cached
 * courts/ussc/journals/text/*.txt files (which come from a cleaner OCR
 * pipeline), so this is only a safety net.
 */
function extractFullText(pdfPath) {
  try {
    const buf = execSync(`pdftotext "${pdfPath}" -`, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return buf.toString('utf8').replace(/\f/g, '\n');
  } catch {
    return null;
  }
}

function buildXmlForYear(base, { dryRun, verbose }) {
  const txtPath = textFileFor(base);
  let text;
  if (existsSync(txtPath)) {
    text = readFileSync(txtPath, 'utf8');
  } else {
    const pdfPath = join(PDF_DIR, `${base}.pdf`);
    console.log(`[WARN] No cached text for ${base}; falling back to pdftotext on the PDF directly (lower quality).`);
    text = extractFullText(pdfPath);
    if (text == null) {
      console.log(`[ERROR] Could not extract text for: ${base}`);
      return null;
    }
  }

  const entries = parseJournalText(text);
  const dateCount = entries.filter(e => e.type === 'date').length;
  const caseCount = entries.filter(e => e.type === 'case').length;

  if (verbose || dateCount === 0) {
    console.log(`${dryRun ? '[DRY]' : '[XML]'} ${base}: ${dateCount} date(s), ${caseCount} case(s)`);
  }

  if (!dryRun) {
    mkdirSync(XML_DIR, { recursive: true });
    writeFileSync(join(XML_DIR, `${base}.xml`), renderJournalXml(base, entries));
  }
  return { dateCount, caseCount };
}

// ── Main ───────────────────────────────────────────────────────────────────

function runPagesMode({ dryRun, verbose, yearFilter }) {
  const data = JSON.parse(readFileSync(TERMS_PATH, 'utf8'));

  // Group term entries by journal year so we only extract each PDF once
  const termsByYear = new Map();
  for (const group of data) {
    for (const term of (group.groups || [])) {
      if (!term.journal_url) continue;
      const year = yearFromHref(term.journal_url);
      if (!year) continue;
      if (yearFilter && year !== parseInt(yearFilter, 10)) continue;
      if (!termsByYear.has(year)) termsByYear.set(year, []);
      termsByYear.get(year).push(term);
    }
  }

  let updated = 0, unchanged = 0, noPdf = 0, failed = 0;

  for (const [year, terms] of [...termsByYear.entries()].sort((a, b) => a[0] - b[0])) {
    const pdfPath = join(PDF_DIR, pdfFilename(year));

    if (!existsSync(pdfPath)) {
      noPdf += terms.length;
      if (verbose) {
        for (const t of terms) console.log(`[SKIP] No local PDF for: ${t.name}`);
      }
      continue;
    }

    const pages = extractPages(pdfPath, 50);
    if (pages.length === 0) {
      failed += terms.length;
      console.log(`[ERROR] pdftotext failed for: ${pdfFilename(year)}`);
      continue;
    }

    for (const term of terms) {
      const { keywords, allowFallback } = termMonthInfo(term.file);
      const offset  = findOffset(pages, keywords, allowFallback);

      if (offset === null) {
        failed++;
        console.log(`[WARN] Could not detect page 1 for: ${term.name}`);
        continue;
      }

      const prev = term.journal_pages ? firstBreakpointOffset(term.journal_pages) : null;
      const want = offset > 0 ? offset : null;

      if (prev === want) {
        unchanged++;
        if (verbose) console.log(`[OK]   ${term.name}: offset=${offset}`);
        continue;
      }

      if (offset > 0) {
        console.log(`[SET]  ${term.name}: offset=${offset}${prev !== null ? ` (was ${prev})` : ''}`);
      } else {
        console.log(`[CLR]  ${term.name}: offset removed (was ${prev})`);
      }
      updated++;

      if (!dryRun) {
        const updatedTerm = applyOffset(term, offset);
        for (const k of Object.keys(term)) delete term[k];
        Object.assign(term, updatedTerm);
      }
    }
  }

  if (!dryRun && updated > 0) {
    writeFileSync(TERMS_PATH, JSON.stringify(data, null, 2) + '\n');
  }

  console.log(`\nDone: ${updated} updated, ${unchanged} unchanged, ${noPdf} no local PDF, ${failed} failed.`);
  if (dryRun && updated > 0) console.log('(dry run — no changes written)');
}

function runXmlMode({ dryRun, verbose, yearFilter }) {
  const bases = readdirSync(PDF_DIR)
    .filter(f => f.endsWith('.pdf'))
    .map(f => basename(f, '.pdf'))
    .filter(base => !yearFilter || base.startsWith(String(yearFilter)))
    .sort();

  if (bases.length === 0) {
    console.log('No journal PDFs found.');
    return;
  }

  let totalDates = 0, totalCases = 0, failedCount = 0;
  for (const base of bases) {
    const result = buildXmlForYear(base, { dryRun, verbose });
    if (!result) { failedCount++; continue; }
    totalDates += result.dateCount;
    totalCases += result.caseCount;
  }

  console.log(`\nDone: ${bases.length - failedCount} journal(s) processed, ${totalDates} date(s), ${totalCases} case(s), ${failedCount} failed.`);
  if (dryRun) console.log('(dry run — no XML files written)');
}

/**
 * Parse a generated journal XML file (see renderJournalXml() above) into
 * the first recorded <date>'s value and a Map of date value -> Set of
 * every case number recorded under that date (a "<case number="1593,1594">"
 * joint listing contributes both "1593" and "1594" individually). Each
 * <date>...</date> is now a self-contained container, so this just walks
 * one block at a time rather than tracking "current date" line by line.
 */
function parseJournalXml(xmlPath) {
  const text = readFileSync(xmlPath, 'utf8');
  const dateBlockRe = /<date value="([^"]+)"[^>]*>([\s\S]*?)<\/date>/g;
  const caseRe = /<case number="([^"]+)">/g;

  let firstDate = null;
  const casesByDate = new Map();

  for (const block of text.matchAll(dateBlockRe)) {
    const [, dateValue, body] = block;
    if (!firstDate) firstDate = dateValue;
    let set = casesByDate.get(dateValue);
    if (!set) casesByDate.set(dateValue, set = new Set());
    for (const caseMatch of body.matchAll(caseRe)) {
      for (const num of caseMatch[1].split(',')) set.add(num.trim());
    }
  }
  return { firstDate, casesByDate };
}

const CASE_DATE_PROPS = ['argument', 'reargument', 'decision'];
const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * For October Term YEAR, verify every case date (argument/reargument/
 * decision, each possibly a comma-joined list of dates for a multi-day
 * proceeding) on or after the journal XML's first recorded date actually
 * shows up there: a <case> tag whose number matches (exactly, or as one
 * comma-separated component of a joint listing) under a <date> tag for
 * that same date, with no other <date> tag in between. Read-only; prints
 * every date that can't be located and a final tally.
 */
function runVerifyCaseDates(year) {
  const xmlPath = join(XML_DIR, `${year}.xml`);
  if (!existsSync(xmlPath)) {
    console.error(`No journal XML found: ${xmlPath}`);
    process.exit(1);
  }
  const { firstDate, casesByDate } = parseJournalXml(xmlPath);
  if (!firstDate) {
    console.log(`No <date> entries found in ${xmlPath}.`);
    return;
  }

  const term = `${year}-10`;
  const casesPath = join(ROOT, 'courts/ussc/terms', term, 'cases.json');
  if (!existsSync(casesPath)) {
    console.error(`No cases.json found for term ${term}: ${casesPath}`);
    process.exit(1);
  }
  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));

  console.log(`Verifying ${term} case dates against ${year}.xml (journal starts ${firstDate})...\n`);

  let checked = 0, missing = 0;
  for (const c of cases) {
    if (!c.number) continue; // e.g. an original-proceeding "In re" case with no docket number to match against the journal
    // A consolidated case's own "number" can itself be a comma-joined list
    // (e.g. "1031,1054") — same as a journal joint listing — so a match on
    // *any* one of its component docket numbers counts, not just an exact
    // match on the whole joined string (which the journal never records
    // literally; see parseJournalXml() above).
    // "argument_consolidation" (see schema.js), when present, already lists
    // every case in the group (this one included) — a joint argument is
    // sometimes recorded in the journal under only one side's number, so any
    // one of them counts as found. Falls back to this case's own number(s)
    // when it isn't part of a consolidated-argument group at all.
    const caseNums = (c.argument_consolidation || c.number).split(';').map(s => s.trim());
    for (const prop of CASE_DATE_PROPS) {
      const raw = c[prop];
      if (!raw) continue;
      for (const date of raw.split(',').map(s => s.trim())) {
        if (!FULL_DATE_RE.test(date) || date < firstDate) continue;
        checked++;
        const nums = casesByDate.get(date);
        if (!nums || !caseNums.some(n => nums.has(n))) {
          missing++;
          console.log(`${term} No. ${c.number} — ${c.title} [${prop}: ${date}]`);
        }
      }
    }
  }

  console.log(`\nChecked ${checked} date(s); ${missing} not found in the journal.`);
}

/**
 * Walk a generated journal XML file and return every <case>...<text>...
 * </text></case> pair together with the <date> value and page it falls
 * under (cases with no nested <text> — a joint listing's non-final
 * entries, say — are skipped; there's no disposition text to inspect for
 * argument mentions). `page` is null for a <date> with none detected (see
 * PAGE_NUM_RE in parseJournalText()).
 */
function walkJournalCaseTexts(xmlPath) {
  const xml = readFileSync(xmlPath, 'utf8');
  const dateBlockRe = /<date value="([^"]+)" day="[^"]*"(?: page="(\d+)")?>([\s\S]*?)<\/date>/g;
  const caseTextRe = /<case number="([^"]+)">([^\n]*)\n\s*<text>([\s\S]*?)<\/text>\s*<\/case>/g;

  const out = [];
  for (const [, date, page, body] of xml.matchAll(dateBlockRe)) {
    for (const [, number, title, text] of body.matchAll(caseTextRe)) {
      out.push({ date, page: page ? parseInt(page, 10) : null, number, title: title.trim(), text: xmlUnescape(text) });
    }
  }
  return out;
}

// Signals disposition text describing an actual oral argument session (as
// opposed to e.g. a motion, opinion announcement, or procedural order) —
// what --verify-journal-dates uses to decide a case is worth checking.
const ARGUMENT_MENTION_RE = /\b(?:re)?argu(?:ed|ment)\b/i;

// A courtesy/professional title immediately preceding counsel's name.
// The compound government titles are tried before the bare "Mr." alternative
// so "Mr. Attorney General Miller" keeps "Mr. Attorney General" together as
// the title, leaving "Miller" as the name, rather than splitting after "Mr."
// alone and leaving "Attorney General Miller" as if it were the name.
// "Attorney General" and "Solicitor General" are unhyphenated here since
// normalizeJournalText() already unhyphenates them in the source text
// before this ever runs.
const ADVOCATE_TITLE_RE =
  '(?:Mr\\.\\s+)?(?:Assistant Attorney General|Attorney General|Solicitor General)|Gen\\.|General|Mr\\.|Mrs\\.|Miss|Messrs\\.';

// One "TITLE Name" mention, greedy enough to allow a multi-word name
// (initials, middle names) but stopping before "for"/"and"/a comma.
const ADVOCATE_NAME_RE = new RegExp(
  `(${ADVOCATE_TITLE_RE})\\.?\\s+([A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]*){0,4})`, 'g'
);

// A block of one or more comma/"and"-joined "TITLE Name" mentions sharing a
// single trailing "for ROLE" clause, e.g. "Mr. X, Mr. Y, and Mr. Z for the
// appellants". Captures the whole names block (group 1) and the role text
// (group 2); the names block is re-split with ADVOCATE_NAME_RE afterward.
// The role text stops not just at punctuation but also before a bare "and
// continued/concluded/commenced/submitted/by..." or "and Mr./Gen./etc." —
// that "and" starts a new clause of the same sentence ("...for the
// appellant and continued by Mr. X...", "...for the appellant and Mr. Y
// for...", "...for the appellant and submitted by Mr. Y..."), not more of
// the role, and without this the greedy(-ish) role capture would otherwise
// run right on into the next clause.
const ADVOCATE_GROUP_RE = new RegExp(
  `((?:(?:${ADVOCATE_TITLE_RE})\\.?\\s+[A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]*){0,4}(?:,\\s*(?:and\\s+)?|\\s+and\\s+))*` +
  `(?:${ADVOCATE_TITLE_RE})\\.?\\s+[A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]*){0,4})` +
  `,?\\s+for\\s+(?:the[\\s-]+)?([a-zA-Z][a-zA-Z\\s'-]*?)` +
  `(?=[,.;]|\\s+and\\s+(?:continued|concluded|commenced|submitted|by|${ADVOCATE_TITLE_RE})|$)`,
  'g'
);

/**
 * Drops a later mention that's really just a bare-surname callback to an
 * earlier, fuller mention of the same person in the same role — a journal
 * sentence commonly finishes "...and concluded by Mr. Phillips for
 * appellant" after already naming "Mr. W. Hallett Phillips for appellant"
 * in full moments earlier. Two mentions count as the same person when
 * their last name-token matches (case-insensitively) *and* their role
 * matches exactly; whichever was extracted first is kept.
 */
const lastName = (name) => name.trim().split(/\s+/).pop().toUpperCase();

function dedupeAdvocates(advocates) {
  const seen = [];
  return advocates.filter(a => {
    const key = { lastName: lastName(a.name), role: a.role.toLowerCase() };
    if (seen.some(s => s.lastName === key.lastName && s.role === key.role)) return false;
    seen.push(key);
    return true;
  });
}

// Verbs that signal counsel actually took part in an oral argument session
// ("argued"/"reargued"/"argument commenced/continued/concluded") versus one
// that was merely "submitted" (decided on the papers, no oral argument) —
// used by extractAdvocates() to drop submitted-only counsel from the
// extracted advocate list. Matched word-by-word rather than as full phrases
// since "argument commenced by Mr. X ... and continued by Mr. Y" only
// repeats the verb, not "argument", for each later clause.
const ADVOCATE_ACTION_VERB_RE = /\b(?:re)?argu(?:ed|ment)\b|\bcommenced\b|\bcontinued\b|\bconcluded\b|\bsubmitted\b/gi;

// Catches an argument-verb clause whose counsel never reaches ADVOCATE_GROUP_RE
// at all, e.g. "Argument commenced by Mr. Richard De Gray and continued by Mr.
// Grover Cleveland, for Peake et al." — "for Peake et al." is grammatically
// shared by both, but ADVOCATE_GROUP_RE's namesBlock only joins mentions
// directly via a comma/"and" (see its own doc comment), so a verb word
// ("continued by") between two mentions breaks that join and De Gray never
// gets a role attached to him. Used only as a fallback for names
// ADVOCATE_GROUP_RE's pass missed — see extractAdvocates() — so a name it did
// capture (with a role) is never overwritten by a roleless duplicate here.
// Note: no 'i' flag — that would also case-fold the [A-Z] name-capture
// below, letting it swallow a following lowercase word (e.g. "...Richard De
// Gray and continued by...") into the name. The verb alternatives are
// hand-cased instead, matching either a sentence-initial capital ("Argument
// commenced") or a mid-sentence lowercase one ("...and continued by...").
const ADVOCATE_VERB_BY_NAME_RE = new RegExp(
  `\\b(?:[Rr]e[Aa]rgu(?:ed|ment)|[Aa]rgu(?:ed|ment)|[Cc]ommenced|[Cc]ontinued|[Cc]oncluded)\\s+by` +
  `\\s+(${ADVOCATE_TITLE_RE})\\.?\\s+([A-Z][A-Za-z.'-]*(?:\\s+[A-Z][A-Za-z.'-]*){0,4})`,
  'g'
);

/**
 * Best-effort extraction of {title, name, role} for each advocate mentioned
 * in a disposition text — a diagnostic, not a validated parse: real-world
 * phrasing (unusual name formats, a role clause covering names from an
 * earlier sentence, etc.) can and will defeat it. That's the point of
 * --verify-journal-dates: to see, printed out, how well it's actually doing.
 *
 * Counsel introduced by "submitted" rather than an actual argument verb
 * (argued/reargued/commenced/continued/concluded) are excluded — submitting
 * a case on the papers isn't an oral argument appearance. Counsel named only
 * in an argument-verb clause that ADVOCATE_GROUP_RE couldn't attach a role
 * to (see ADVOCATE_VERB_BY_NAME_RE) are still included, with role left "".
 */
function extractAdvocates(text) {
  const results = [];
  const verbs = [...text.matchAll(ADVOCATE_ACTION_VERB_RE)];
  for (const match of text.matchAll(ADVOCATE_GROUP_RE)) {
    const [, namesBlock, role] = match;
    let verb = null;
    for (const v of verbs) {
      if (v.index > match.index) break;
      verb = v[0];
    }
    if (verb && /^submitted$/i.test(verb)) continue;
    for (const [, title, name] of namesBlock.matchAll(ADVOCATE_NAME_RE)) {
      results.push({ title: title.trim(), name: name.trim(), role: role.trim() });
    }
  }
  const found = new Set(results.map(a => lastName(a.name)));
  for (const [, title, name] of text.matchAll(ADVOCATE_VERB_BY_NAME_RE)) {
    if (found.has(lastName(name))) continue;
    found.add(lastName(name));
    results.push({ title: title.trim(), name: name.trim(), role: '' });
  }
  return dedupeAdvocates(results);
}

// Government officials the journal refers to by title + bare surname only
// ("Mr. Attorney General Miller") rather than a full name, keyed by term
// and then by that surname exactly as extracted — a title alone isn't a
// safe key since a term can have multiple simultaneous holders of one (e.g.
// 1889-10's journal names both "Assistant Attorney General Maury" and
// "Assistant Attorney General Cotton"). This lives here rather than in
// data/ussc/speakers.json: that file is a flat name-spelling alias/typo
// table with no notion of "who held which title when," and forcing this
// shape into it would need restructuring a file scripts/update_advocates.js
// already depends on, for a need only this script currently has. There's
// also no provision yet for the same surname resolving differently across
// two terms — add one if that's ever actually hit, not before.
const OFFICIAL_NAME_BY_TERM = {
  '1889-10': {
    'Miller': 'William H. H. Miller',  // Attorney General (joinConsecutiveInitials() below collapses this to "H.H." on output)
    'Taft': 'William Howard Taft',     // Solicitor General
    'Maury': 'William Arden Maury',    // Assistant Attorney General
    // "Cotton" (also "Assistant Attorney General" in 1889-10's journal) is
    // left unresolved rather than guessed at.
  },
};

function resolveAdvocateName(term, name) {
  return OFFICIAL_NAME_BY_TERM[term]?.[name] || name;
}

// Our multi-initials convention (see data/ussc/speakers.json's "alias"
// table, e.g. "A. C. EPPS" -> "A.C. EPPS"): consecutive single-letter
// initials run together with no space ("H.H."), unlike a multi-letter
// abbreviation such as "Wm." — "Wm. H. H. Miller" becomes "Wm. H.H. Miller",
// not "Wm.H.H. Miller". Applied to every advocate name regardless of
// whether it came from OFFICIAL_NAME_BY_TERM or straight from the text, so
// the two can't drift out of sync with each other on this.
function joinConsecutiveInitials(name) {
  return name.replace(/\b([A-Z]\.)(?:\s+([A-Z]\.))+/g, m => m.replace(/\s+/g, ''));
}

// Common abbreviated first names the journals use in place of the full
// name — expanded for consistency (like joinConsecutiveInitials() above,
// keyed on the already-uppercased form since that's when this runs).
const ADVOCATE_NAME_EXPANSIONS = {
  'WM.': 'WILLIAM',
  'BENJ.': 'BENJAMIN',
};
function expandAdvocateAbbreviations(name) {
  return name.replace(/\b(WM\.|BENJ\.)/g, m => ADVOCATE_NAME_EXPANSIONS[m]);
}

// Splits a captured advocate title into its printable segments: a bare
// "Mr."/"Mrs."/"Miss"/"Messrs."/"Gen."/"General" is just itself, but a
// compound "Mr. Attorney General" (etc.) becomes two segments — the
// courtesy prefix and the official title — so the formal output line (see
// formatAdvocateLine()) reads "...|MR.|ATTORNEY GENERAL|..." rather than
// cramming both into one field.
function splitAdvocateTitle(rawTitle) {
  const m = /^Mr\.\s+(.+)$/i.exec(rawTitle.trim());
  return m ? ['MR.', m[1].toUpperCase()] : [rawTitle.trim().toUpperCase()];
}

// The docket-role families this script will actually record a role for.
// A case's disposition sentence sometimes substitutes a party's own name (or
// a shorthand for it) for its procedural role — "for Peake et al.", "for the
// receiver and the bank", "for the city of New Orleans" have all shown up in
// real 1890s journal text where "for the appellee"/"for the defendant" would
// otherwise be — and that free text isn't a role, so buildAdvocateRecord()
// drops it rather than storing it as one. Folds in the same appellant/
// plaintiff abbreviations expandTitleAbbreviations() already treats as
// canonical (appt/app't/appts/app'ts, plff/pl'ff/plffs/pl'ffs), plus the "in
// error" qualifier routinely paired with plaintiff/defendant in this era.
const RECOGNIZED_ROLE_RE = new RegExp(
  "^(?:the\\s+)?(?:" +
    "appellants?|app['’]?ts?" +
    "|appellees?" +
    "|(?:plaintiffs?|pl['’]?ffs?)(?:\\s+in\\s+error)?" +
    "|defendants?(?:\\s+in\\s+error)?" +
    "|respondents?" +
    "|petitioners?" +
  ")$",
  'i'
);

// Builds the {name, title, role} record — in cases.json's own field order
// (see CLAUDE.md's case schema / schema.js's ADVOCATE_KEY_ORDER) — for one
// extracted advocate: the shared basis for both the printed preview line
// and (with --prompt) what actually gets written into an event's advocates
// array, so the two never drift apart. A compound title (see
// splitAdvocateTitle()) is comma-joined into the one title field rather
// than kept as separate segments. An advocate with no extracted role (see
// ADVOCATE_VERB_BY_NAME_RE) or an unrecognized one (see RECOGNIZED_ROLE_RE)
// gets no "role" key at all, rather than one set to "" or to free text —
// there's no existing cases.json advocate with an empty role string.
function buildAdvocateRecord(term, advocate) {
  const resolved = resolveAdvocateName(term, advocate.name);
  const name = expandAdvocateAbbreviations(joinConsecutiveInitials(resolved).toUpperCase());
  const record = {
    name,
    title: splitAdvocateTitle(advocate.title).join(','),
  };
  if (advocate.role && RECOGNIZED_ROLE_RE.test(advocate.role.trim())) record.role = advocate.role.toLowerCase();
  return reorderAdvocate(record);
}

// The formal <name>|<title>[|<role>] preview line — exactly what --prompt
// would write into cases.json, pipe-joined for easy scanning/grepping. No
// trailing "|" when there's no role to show (see buildAdvocateRecord()).
function formatAdvocateLine(term, advocate) {
  const rec = buildAdvocateRecord(term, advocate);
  return [rec.name, rec.title, rec.role].filter(Boolean).join('|');
}

// True if an event's existing advocates array (if any) already holds
// exactly the proposed records — same length, same name/title/role at each
// position (ignoring any other fields an existing entry might carry) — so
// --prompt can skip a case outright instead of asking about a no-op.
function advocatesMatch(existing, proposed) {
  if (!Array.isArray(existing) || existing.length !== proposed.length) return false;
  return existing.every((e, i) =>
    e.name === proposed[i].name && e.title === proposed[i].title && e.role === proposed[i].role);
}

// A readline "asker" whose question()-equivalent doesn't rely on the
// stream's own pause/resume dance between calls — both readline/promises'
// question() and the classic callback createInterface(...).question()
// reliably lose input after the first call when stdin is piped rather than
// a real TTY (confirmed directly: a bare 3-question loop against piped
// input hangs after question 1 with either API, no code of ours involved).
// A persistent 'line' listener feeding a small queue/waiter pair sidesteps
// whatever internal state that dance depends on, and works identically
// whether stdin is a pipe or a live terminal.
function makeAsker() {
  const rl = createInterface({ input: process.stdin });
  const queue = [];
  const waiters = [];
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  const ask = (prompt) => {
    process.stdout.write(prompt);
    return new Promise(resolve => {
      if (queue.length) resolve(queue.shift());
      else waiters.push(resolve);
    });
  };
  return { ask, close: () => rl.close() };
}

/**
 * The inverse of --verify-case-dates: for October Term YEAR, scans the
 * already-generated YYYY.xml for every case whose disposition text mentions
 * an argument or reargument, confirms that case exists in cases.json with
 * that date present in its argument/reargument field(s) and a matching
 * events[] entry, and prints a best-effort extraction of the advocates
 * named in that text — a diagnostic for gauging how well that extraction
 * is working. Read-only by default.
 *
 * With --prompt, whenever cases.json has a matching case *and* an events[]
 * entry for that date: if the proposed advocates (after dedupeAdvocates()
 * drops a bare-surname callback to someone already named in full earlier in
 * the same role — see its doc comment) already exactly match what that
 * event has, skips the case outright rather than asking about a no-op.
 * Otherwise prints that event's existing advocates (if any, so they can be
 * compared against the freshly-extracted list before deciding) and any
 * existing journal_ref that doesn't match "<journal year>.<page>" for this
 * <date>'s page (a WARNING, not auto-corrected), then asks "Add advocates
 * to case [y/N]?". On "y", writes the extracted {name, title,
 * role} records (see buildAdvocateRecord()) onto every matching event —
 * overwriting any advocates already there — filling in journal_ref too if
 * the event doesn't have one yet, and saves cases.json immediately, so
 * nothing already-confirmed is lost if the run is interrupted partway
 * through a term.
 */
async function runVerifyJournalDates(year, { promptMode = false } = {}) {
  const xmlPath = join(XML_DIR, `${year}.xml`);
  if (!existsSync(xmlPath)) {
    console.error(`No journal XML found: ${xmlPath}`);
    process.exit(1);
  }

  const term = `${year}-10`;
  const casesPath = join(ROOT, 'courts/ussc/terms', term, 'cases.json');
  if (!existsSync(casesPath)) {
    console.error(`No cases.json found for term ${term}: ${casesPath}`);
    process.exit(1);
  }
  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  const caseByNumber = new Map();
  for (const c of cases) {
    if (!c.number) continue;
    for (const n of c.number.split(';').map(s => s.trim())) caseByNumber.set(n, c);
  }
  const saveCases = () => writeFileSync(casesPath, JSON.stringify(cases, null, 2) + '\n', 'utf8');

  const asker = promptMode ? makeAsker() : null;

  const entries = walkJournalCaseTexts(xmlPath).filter(e => ARGUMENT_MENTION_RE.test(e.text));
  console.log(`Scanning ${year}.xml for argument mentions against ${term} cases.json...\n`);

  let checked = 0, problems = 0, added = 0;
  for (const e of entries) {
    checked++;
    const caseNums = e.number.split(',').map(s => s.trim());
    const c = caseNums.map(n => caseByNumber.get(n)).find(Boolean);
    let matchingEvents = [];

    console.log(`${term} No. ${e.number} — ${e.title} [${e.date}]`);

    if (!c) {
      problems++;
      console.log('  MISSING: no case in cases.json matches this docket number');
    } else {
      const argDates = new Set([...(c.argument || '').split(','), ...(c.reargument || '').split(',')].map(s => s.trim()).filter(Boolean));
      if (!argDates.has(e.date)) {
        problems++;
        console.log(`  MISMATCH: ${e.date} not in ${c.id}'s argument/reargument field(s) (argument=${JSON.stringify(c.argument || '')}, reargument=${JSON.stringify(c.reargument || '')})`);
      }
      matchingEvents = (c.events || []).filter(ev => ev.date === e.date);
      if (!matchingEvents.length) {
        problems++;
        console.log(`  MISMATCH: ${c.id} has no events[] entry dated ${e.date}`);
      }
    }

    const advocates = extractAdvocates(e.text);
    if (advocates.length) {
      for (const a of advocates) console.log(`  ${formatAdvocateLine(term, a)}`);
    } else {
      console.log('  (no advocates extracted)');
    }
    console.log(`  text: "${e.text}"`);

    if (asker && c && advocates.length && matchingEvents.length) {
      const records = advocates.map(a => buildAdvocateRecord(term, a));
      const alreadyMatches = matchingEvents.every(ev => advocatesMatch(ev.advocates, records));

      if (!alreadyMatches) {
      // Show whatever's already there first, so it's possible to compare
      // against the freshly-extracted list before deciding to overwrite it.
      for (const ev of matchingEvents) {
        if (!ev.advocates) continue;
        console.log('  existing advocates:');
        for (const a of ev.advocates) console.log(`    ${a.name}|${a.title}|${a.role}`);
      }

      // "<journal year>.<page>" — e.page is null if this <date> never got a
      // page number detected (see PAGE_NUM_RE in parseJournalText()), in
      // which case there's nothing to compare an existing ref against or
      // to fill one in with below.
      const expectedRef = e.page != null ? `${year}.${e.page}` : null;
      for (const ev of matchingEvents) {
        if (ev.journal_ref && expectedRef && ev.journal_ref !== expectedRef) {
          console.log(`  WARNING: existing journal_ref '${ev.journal_ref}' does not match expected '${expectedRef}'`);
        }
      }

      const answer = (await asker.ask('  Add advocates to case [y/N]? ')).trim().toLowerCase();
      if (answer.startsWith('y')) {
        for (const ev of matchingEvents) {
          const idx = c.events.indexOf(ev);
          const updated = { ...ev, advocates: records };
          if (!updated.journal_ref && expectedRef) updated.journal_ref = expectedRef;
          c.events[idx] = reorderEvent(updated);
        }
        saveCases();
        added++;
      }
      }
    }
    console.log();
  }

  if (asker) asker.close();
  console.log(`Checked ${checked} argument mention(s); ${problems} cases.json problem(s) found.` +
    (promptMode ? ` ${added} case(s) updated with advocates.` : ''));
}

const args = process.argv.slice(2);
const dryRun            = args.includes('--dry-run');
const verbose            = args.includes('--verbose');
const pagesMode          = args.includes('--pages');
const verifyDatesMode    = args.includes('--verify-case-dates');
const verifyJournalMode  = args.includes('--verify-journal-dates');
const promptMode         = args.includes('--prompt');
const yearFilter         = args.find(a => /^\d{4}$/.test(a));

if (verifyDatesMode || verifyJournalMode) {
  if (!yearFilter) {
    console.error(`${verifyJournalMode ? '--verify-journal-dates' : '--verify-case-dates'} requires a YEAR argument.`);
    process.exit(1);
  }
  if (verifyJournalMode) await runVerifyJournalDates(yearFilter, { promptMode });
  else runVerifyCaseDates(yearFilter);
} else {
  if (yearFilter) console.log(`Filtering to year: ${yearFilter}`);
  if (pagesMode) {
    runPagesMode({ dryRun, verbose, yearFilter });
  } else {
    runXmlMode({ dryRun, verbose, yearFilter });
  }
}
