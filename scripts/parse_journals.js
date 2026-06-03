#!/usr/bin/env node
/**
 * scripts/parse_journals.js
 *
 * Scans local journal PDFs to detect how many front-matter pages precede
 * the journal's actual "Page 1", then stores that count as `journal_page_offset`
 * in terms.json for any term where the offset is > 0.
 *
 * Detection strategy:
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
 *
 *   --dry-run   Report changes without writing terms.json
 *   --verbose   Also print unchanged terms
 *   YEAR        Only process that journal year (e.g. 1971)
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TERMS_PATH = join(ROOT, 'courts/ussc/terms.json');
const PDF_DIR = join(ROOT, 'courts/ussc/journals/pdfs');

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
 * Find the journal_page_offset for one term inside the extracted page array.
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
  // Pre-compute which pages contain a day-of-week word
  const hasDay = pages.map(p => DAYS.some(d => p.toUpperCase().includes(d)));

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
  // Check only the first 10 lines of the candidate page — the date header
  // where "MONDAY, OCTOBER 6, 1958" appears — not the full body text, which
  // may contain cross-references to other terms (e.g. "August Special Term").
  let filtered = candidates;
  if (monthKeywords && monthKeywords.size > 0) {
    const headerOf = (idx) =>
      pages[idx].split('\n').slice(0, 10).join(' ').toUpperCase();
    const withMonth = candidates.filter(({ idx }) =>
      [...monthKeywords].some(m => headerOf(idx).includes(m))
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
 * Return a new term object with journal_page_offset set (offset > 0) or
 * removed (offset === 0), inserted right after the journal_href key.
 */
function applyOffset(term, offset) {
  const result = {};
  let placed = false;
  for (const [k, v] of Object.entries(term)) {
    if (k === 'journal_page_offset') continue; // drop old value
    result[k] = v;
    if (k === 'journal_href') {
      if (offset > 0) {
        result.journal_page_offset = offset;
        placed = true;
      }
    }
  }
  if (!placed && offset > 0) result.journal_page_offset = offset;
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun   = args.includes('--dry-run');
const verbose  = args.includes('--verbose');
const yearFilter = args.find(a => /^\d{4}$/.test(a));
if (yearFilter) console.log(`Filtering to year: ${yearFilter}`);

const data = JSON.parse(readFileSync(TERMS_PATH, 'utf8'));

// Group term entries by journal year so we only extract each PDF once
const termsByYear = new Map();
for (const group of data) {
  for (const term of (group.pages || [])) {
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
      for (const t of terms) console.log(`[SKIP] No local PDF for: ${t.title}`);
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
      console.log(`[WARN] Could not detect page 1 for: ${term.title}`);
      continue;
    }

    const prev = term.journal_page_offset ?? null;
    const want = offset > 0 ? offset : null;

    if (prev === want) {
      unchanged++;
      if (verbose) console.log(`[OK]   ${term.title}: offset=${offset}`);
      continue;
    }

    if (offset > 0) {
      console.log(`[SET]  ${term.title}: offset=${offset}${prev !== null ? ` (was ${prev})` : ''}`);
    } else {
      console.log(`[CLR]  ${term.title}: offset removed (was ${prev})`);
    }
    updated++;

    if (!dryRun) {
      const updated = applyOffset(term, offset);
      for (const k of Object.keys(term)) delete term[k];
      Object.assign(term, updated);
    }
  }
}

if (!dryRun && updated > 0) {
  writeFileSync(TERMS_PATH, JSON.stringify(data, null, 2) + '\n');
}

console.log(`\nDone: ${updated} updated, ${unchanged} unchanged, ${noPdf} no local PDF, ${failed} failed.`);
if (dryRun && updated > 0) console.log('(dry run — no changes written)');
