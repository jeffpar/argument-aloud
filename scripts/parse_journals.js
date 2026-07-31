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
 * Usage:
 *   node scripts/parse_journals.js [--dry-run] [--verbose] [YEAR]
 *   node scripts/parse_journals.js --pages [--dry-run] [--verbose] [YEAR]
 *
 *   --pages     Run the journal_pages offset-detection pass instead of
 *               generating XML (see above)
 *   --dry-run   Report changes without writing terms.json / XML files
 *   --verbose   Also print unchanged terms / per-file XML stats
 *   YEAR        Only process that journal year (e.g. 1971)
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TERMS_PATH = join(ROOT, 'courts/ussc/terms.json');
const PDF_DIR = join(ROOT, 'courts/ussc/journals/pdfs');
const TEXT_DIR = join(ROOT, 'courts/ussc/journals/text');
const XML_DIR = join(ROOT, 'courts/ussc/journals/xml');

const DAYS = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract the journal year from a journal_href URL. */
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
 * (offset === 0), inserted right after the journal_href key. Any additional
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
    if (k === 'journal_href') {
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
const DATE_HEADING_RE = new RegExp(
  `\\b(${DAY_NAMES_UPPER.join('|')}),?\\s+([A-Za-z]+)\\.?\\s+(\\d{1,2})(?:ST|ND|RD|TH)?,?\\s+(\\d{4})\\b`
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
// Original" / "1070 Misc" / "648, Misc" — normalized onto the number as
// "9-Orig" / "45-Orig" / "1070-Misc" / "648-Misc".
const CASE_SUFFIX_RE = /^,?\s*(Original|Orig\.?|Misc\.?)\b/i;

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

  // "Nos. X and Y.—Title" / "Nos. X, Y, and Z.—Title" — up to two further
  // numbers sharing this one entry, folded into the number attribute
  // ("X,Y" / "X,Y,Z"). Every joint entry actually seen in these journals
  // tops out at 3 numbers total, while a day-call schedule line that
  // happens to start the same way ("Nos. 252 and 1537, 1224, 253, 256,
  // ...") runs on far longer — so finding a 4th number (checked right
  // after the loop, below) is itself the signal that this is a list, not a
  // case, and this line should be given up on as a case-start entirely.
  const MORE_NUMBER_RE = /^(?:,\s*|\s+)(?:and\s+)?(\d+)\b/i;
  let extraNumbers = 0;
  for (; extraNumbers < 2; extraNumbers++) {
    const more = MORE_NUMBER_RE.exec(rest);
    if (!more) break;
    number += ',' + more[1];
    rest = rest.slice(more[0].length);
  }
  if (MORE_NUMBER_RE.test(rest)) return null;

  const suffixMatch = CASE_SUFFIX_RE.exec(rest);
  if (suffixMatch) {
    number += /orig/i.test(suffixMatch[1]) ? '-Orig' : '-Misc';
    rest = rest.slice(suffixMatch[0].length);
    // A day-call schedule line can itself start "Nos. 2 original, 253,
    // 256, ..." — the suffix matches, but a comma right after means this
    // is really that list, not a title.
    if (/^,/.test(rest)) return null;
  } else if (hadTrailingComma && extraNumbers === 0) {
    // The comma was consumed as part of the greedy number match, but
    // nothing recognizable followed it (no further joint-case number, no
    // Original/Orig/Misc suffix) — so it wasn't part of this entry at all.
    // This is a mid-sentence cross-reference to an already-open case (e.g.
    // "...for the appellant in\nNo. 70-161, and the appellee in No.
    // 70-5211...") that just happens to land at the start of a wrapped
    // line, not a new case-start; treating it as one would wrongly cut off
    // the sentence it's actually part of.
    return null;
  }

  // Drop a trailing period and/or dash(es) before the title text begins
  // (OCR sometimes renders the em dash after the period as one or more
  // hyphens, e.g. "No. 1195.-Title" or "No. 294.--Title").
  rest = rest.replace(/^\.?\s*[-–—]*\s*/, '');
  // A genuine case entry's title always starts right on this same line —
  // nothing left (e.g. a bare "Nos. 520 and 521." that's actually a
  // mid-sentence cross-reference to an already-open case, not a new one)
  // means this wasn't really a case-start line at all.
  if (!rest.trim()) return null;
  return { number, rest };
}

// Lines that are pure pagination/printing noise and never real case content.
const NOISE_LINE_RE = /^(?:\d+|[\d-]{6,}|SUPREME COURT OF THE UNITED STATES\.?|\(JOURNAL\)|JOURNAL)$/;

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
  ].join('|') + ')\\b',
  'i'
);

function xmlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
// Solicitor-General Taft announced to the court that an order had
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

function splitCaseEntry(raw) {
  const cleaned = raw.replace(/\s+/g, ' ').trim();

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
    return { title: stripTitleTrailer(cleaned, { stripPeriod: true }), text: null };
  }

  // The disposition trigger is always introduced by a comma/semicolon (or
  // starts a new sentence right after one) — strip only that separator (and
  // a trailing "; and"), not a period, since a period right at the split
  // point usually belongs to an abbreviation in the title itself (e.g.
  // "...et al." before ", in error to...") rather than a mark to discard.
  const title = stripTitleTrailer(cleaned.slice(0, splitIndex));
  const text = cleaned.slice(splitIndex).trim();
  return { title, text: text || null };
}

/**
 * Parse one journal's full text into an ordered list of
 * {type:'date',...} / {type:'case', number, title, text} entries.
 */
function parseJournalText(text) {
  const lines = text.split('\n');
  const entries = [];

  let lastDate = null;       // Date of the currently-open date section
  let openCase = null;       // {number, raw} currently accumulating text
  let pendingGroup = [];     // case entries since the last flushed <text>

  const closeOpenCase = () => {
    if (!openCase) return;
    const { title, text: caseText } = splitCaseEntry(openCase.raw);
    const entry = { type: 'case', number: openCase.number, title };
    entries.push(entry);
    pendingGroup.push(entry);
    if (caseText) {
      entries.push({ type: 'text', text: caseText });
      pendingGroup = [];
    }
    openCase = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (NOISE_LINE_RE.test(line)) continue;

    const dateMatch = DATE_HEADING_RE.exec(line);
    if (dateMatch) {
      const resolved = resolveHeadingDate(dateMatch, lastDate);
      if (resolved) {
        const isRepeat = lastDate && daysBetween(lastDate, resolved) === 0;
        if (!isRepeat) {
          closeOpenCase();
          entries.push({ type: 'date', value: formatDateISO(resolved), display: formatDateDisplay(resolved) });
          lastDate = resolved;
        }
        continue; // heading line itself never contributes to case text
      }
      // Unresolvable heading-shaped line (garbled OCR, or a genuine backward
      // date we can't correct) — fall through and treat it as ordinary text
      // below, same as any other line.
    }

    const caseMatch = parseCaseStart(line);
    if (caseMatch) {
      closeOpenCase();
      openCase = { number: caseMatch.number, raw: caseMatch.rest };
      continue;
    }

    if (openCase) {
      // Rejoin a word hyphenated across the original print layout's line
      // break (e.g. "Missis-" / "sippi") instead of leaving a stray "- ".
      // Gated on the continuation starting lowercase: that's the signal a
      // wrap broke mid-word, as opposed to a genuine hyphenated compound
      // that happens to fall at a line boundary and continues with a new
      // capitalized word (e.g. "Aerojet-" / "General"), where the hyphen is
      // meaningful and should stay — but even then, join directly with no
      // extra space, since the hyphen itself is already the separator.
      if (/[A-Za-z]-$/.test(openCase.raw)) {
        openCase.raw = /^[a-z]/.test(line)
          ? openCase.raw.replace(/-$/, '') + line
          : openCase.raw + line;
      } else {
        openCase.raw += ' ' + line;
      }
    }
    // else: content before the first case of a date section (roll call,
    // admissions to the bar, etc.) or before the very first date — discard.
  }
  closeOpenCase();

  return entries;
}

/** Render parsed entries as the journal's XML document text. */
function renderJournalXml(year, entries) {
  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<journal year="${year}">`];
  for (const e of entries) {
    if (e.type === 'date') {
      lines.push(`<date value="${e.value}">${xmlEscape(e.display)}</date>`);
    } else if (e.type === 'case') {
      lines.push(`<case number="${xmlEscape(e.number)}">${xmlEscape(e.title)}</case>`);
    } else if (e.type === 'text') {
      lines.push(`<text>${xmlEscape(e.text)}</text>`);
    }
  }
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
      if (!term.journal_href) continue;
      const year = yearFromHref(term.journal_href);
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

const args = process.argv.slice(2);
const dryRun     = args.includes('--dry-run');
const verbose     = args.includes('--verbose');
const pagesMode   = args.includes('--pages');
const yearFilter  = args.find(a => /^\d{4}$/.test(a));
if (yearFilter) console.log(`Filtering to year: ${yearFilter}`);

if (pagesMode) {
  runPagesMode({ dryRun, verbose, yearFilter });
} else {
  runXmlMode({ dryRun, verbose, yearFilter });
}
