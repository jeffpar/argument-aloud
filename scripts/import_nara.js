/**
 * import_nara.js
 *
 * Refreshes JSON files in data/nara/ussc/ by fetching from the NARA catalog API.
 * Reads data/nara/ussc.json as the manifest, then for each collection with
 * collect:true, fetches all items and compares against the existing JSON file.
 *
 * At the end, reports added, updated, and deleted items per collection.
 *
 * Usage:
 *   node scripts/import_nara.js [--dry-run] [--id <naId>]
 *
 * Options:
 *   --dry-run    Show report without writing files
 *   --id <naId>  Only refresh the collection with this naId
 *   --csv        Regenerate only the synthetic entries for 175704063 (no API fetch)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const NARA_DIR = resolve(ROOT, 'data/nara/ussc');

/** Return the first semicolon-delimited component of a case title for display. */
const firstTitle = (s) => { if (!s) return s; const i = s.indexOf(';'); return i === -1 ? s : s.slice(0, i); };

const API_BASE = 'https://catalog.archives.gov/proxy/records/search';
const ROWS_PER_PAGE = 100;
const DELAY_MS = 300; // polite delay between requests

const MONTHS_LONG  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Parse a date from the end of a NARA title string (", Month D, YYYY" suffix).
 * Returns a Date object or null.
 */
function parseTitleDate(titles) {
  const m = titles.match(/,\s*([A-Za-z]+)\s+(\d+),?\s*(\d{4})\s*$/);
  if (!m) return null;
  const month = MONTHS_LONG.indexOf(m[1]);
  if (month < 0) return null;
  return new Date(parseInt(m[3], 10), month, parseInt(m[2], 10));
}

/**
 * Return true if any item in the array has a title date in [startYear-startMonth .. endYear-endMonth].
 * Months are 1-based.
 */
function itemsHaveDateInRange(items, startYear, startMonth, endYear, endMonth) {
  const start = new Date(startYear, startMonth - 1, 1);
  const end   = new Date(endYear, endMonth, 0); // last day of endMonth
  for (const item of items) {
    const d = parseTitleDate(item.titles);
    if (d && d >= start && d <= end) return true;
  }
  return false;
}

/**
 * Parse a CSV date field from 2024-10.csv into an ISO date and a formatted label.
 * Handles two formats:
 *   "NNNN - Month D, YYYY.mp3"  (quoted, may have trailing space before .mp3)
 *   "DD-MMM-YY"
 * Returns { isoDate: "YYYY-MM-DD", label: "Month D, YYYY" } or null.
 */
function parseCsvDate(dateField) {
  const m1 = dateField.match(/^\d+\s*-\s*([A-Za-z]+)\s+(\d+),\s*(\d{4})/);
  if (m1) {
    const month = MONTHS_LONG.indexOf(m1[1]);
    if (month >= 0) {
      const y = parseInt(m1[3], 10), mo = month + 1, d = parseInt(m1[2], 10);
      return {
        isoDate: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        label: `${m1[1]} ${m1[2]}, ${m1[3]}`,
      };
    }
  }
  const m2 = dateField.match(/^(\d+)-([A-Za-z]{3})-(\d{2})$/);
  if (m2) {
    const month = MONTHS_SHORT.indexOf(m2[2]);
    if (month >= 0) {
      const y = 2000 + parseInt(m2[3], 10), mo = month + 1, d = parseInt(m2[1], 10);
      return {
        isoDate: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        label: `${MONTHS_LONG[month]} ${d}, ${y}`,
      };
    }
  }
  return null;
}

/**
 * Infer term, date, and events from a Gold Series titles string.
 * Date suffix format: ", Month D, YYYY" or year-only ", YYYY"
 * Term: month >= 10 → same year; month < 10 → year - 1
 *   For year-only titles, term is derived from the sources URL (e.g. "2023_term/")
 *   or falls back to year - 1 (assuming a spring argument).
 * Events: title parts split on " / " with "[Case X]" or "[X]" → "(No. X)"
 * Returns { term, date, events } or {} if the date cannot be parsed.
 * @param {string} titles
 * @param {string[]} [sources] — item sources array, used for year-only term fallback
 */
function inferGoldSeriesDerivedFields(titles, sources = []) {
  const m = titles.match(/,\s*([A-Za-z]+)\s+(\d+),?\s*(\d{4})\s*$/);
  if (m) {
    const monthIdx = MONTHS_LONG.indexOf(m[1]);
    if (monthIdx >= 0) {
      const year = parseInt(m[3], 10), month = monthIdx + 1, day = parseInt(m[2], 10);
      const date  = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const term  = month >= 10 ? year : year - 1;
      const casesPart = titles.slice(0, titles.length - m[0].length).trim();
      const events = casesPart.split(' / ').map(part =>
        part.replace(/\s*\[(?:Case\s+)?([^\]]+)\]\s*$/, ' (No. $1)').trim()
      );
      return { term, date, events };
    }
  }
  // Year-only fallback: title ends with ", YYYY"
  const mYear = titles.match(/,\s*(\d{4})\s*$/);
  if (mYear) {
    const year = parseInt(mYear[1], 10);
    // Derive term from sources URL (e.g. ".../2023_term/..."), fall back to year - 1
    let term = year - 1;
    for (const src of sources) {
      const mTerm = String(src).match(/(\d{4})_term\//);
      if (mTerm) { term = parseInt(mTerm[1], 10); break; }
    }
    const casesPart = titles.slice(0, titles.length - mYear[0].length).trim();
    const events = casesPart.split(' / ').map(part =>
      part.replace(/\s*\[(?:Case\s+)?([^\]]+)\]\s*$/, ' (No. $1)').trim()
    );
    return { term, date: String(year), events };
  }
  return {};
}

/**
 * Fill in missing term/date/events and destinations for Gold Series items that lack them.
 * - term/date/events: only set when term is undefined
 * - destinations: only set when destinations is undefined AND item has a full ISO date (YYYY-MM-DD)
 *   One destination per MP3 source URL: "<term>/<date>/<filename>.mp3"
 * Returns the number of items that were updated (either field set).
 */
function backfillGoldSeriesDerivedFields(items) {
  let changed = 0;
  for (const item of items) {
    let itemChanged = false;

    // Backfill term/date/events
    if (item.term === undefined) {
      const derived = inferGoldSeriesDerivedFields(item.titles, item.sources || []);
      if (derived.date !== undefined) {
        item.term   = derived.term;
        item.date   = derived.date;
        item.events = derived.events;
        itemChanged = true;
      }
    }

    // Backfill destinations (requires a full YYYY-MM-DD date and at least one MP3 source)
    if (item.destinations === undefined && item.term !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(item.date)) {
      const dests = (item.sources || [])
        .filter(src => /\.mp3$/i.test(src))
        .map(src => `${item.term}/${item.date}/${src.split('/').pop().toLowerCase()}`);
      if (dests.length) {
        item.destinations = dests;
        itemChanged = true;
      }
    }

    if (itemChanged) changed++;
  }
  return changed;
}

/**
 * Build synthetic item objects for the Gold Series (175704063) from 2024-10.csv,
 * supplemented by case titles from courts/ussc/terms/2024-10/cases.json.
 * Returns { items: [...], report: { added, updated, unchanged } }.
 */
function buildSyntheticItemsForGoldSeries(existingSynthetics) {
  const csvPath   = resolve(NARA_DIR, '2024-10.csv');
  const casesPath = resolve(ROOT, 'courts/ussc/terms/2024-10/cases.json');

  // Load CSV (skip header)
  const csvRows = readFileSync(csvPath, 'utf8').trim().split('\n').slice(1);

  // Load cases and group by argument/reargument date and by decision date
  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  const argsByDate = new Map();
  const decsByDate = new Map();
  for (const c of cases) {
    const dates = new Set();
    if (c.argument)   dates.add(c.argument);
    if (c.reargument) dates.add(c.reargument);
    for (const e of (c.events || [])) {
      if (e.type === 'argument' || e.type === 'reargument') dates.add(e.date);
    }
    for (const d of dates) {
      if (!argsByDate.has(d)) argsByDate.set(d, []);
      argsByDate.get(d).push(`${firstTitle(c.title)} [Case ${c.number}]`);
    }
    if (c.decision) {
      if (!decsByDate.has(c.decision)) decsByDate.set(c.decision, []);
      decsByDate.get(c.decision).push(`${firstTitle(c.title)} [Case ${c.number}]`);
    }
  }

  // Build lookup of existing synthetics by Local ID for change detection
  const existingByLocalId = new Map();
  for (const item of existingSynthetics) {
    const localEntry = item.ids.find(s => s.startsWith('Local ID: '));
    if (localEntry) existingByLocalId.set(localEntry.replace('Local ID: ', ''), item);
  }

  const items = [];
  const report = { added: 0, updated: 0, unchanged: 0 };

  for (const row of csvRows) {
    // Split on first comma; date field may be quoted (contains a comma)
    const commaIdx = row.indexOf(',');
    if (commaIdx < 0) continue;
    const url       = row.slice(0, commaIdx).trim();
    const dateField = row.slice(commaIdx + 1).trim().replace(/^"|"$/g, '').trim();

    // Extract Local ID from URL: ".../267-2386.mp3" → "267.2386"
    const urlMatch = url.match(/\/(267-\d+)\.mp3/);
    if (!urlMatch) continue;
    const localId = urlMatch[1].replace('-', '.');

    // Parse date
    const parsed = parseCsvDate(dateField);
    if (!parsed) {
      process.stderr.write(`  warning: could not parse CSV date: ${dateField}\n`);
      continue;
    }

    // Build title: argument cases → plain join; opinion cases → "OPINIONS: ..."; neither → "Unknown Recording"
    const argsForDate = argsByDate.get(parsed.isoDate) || [];
    const decsForDate = decsByDate.get(parsed.isoDate) || [];
    let titles;
    if (argsForDate.length > 0) {
      titles = `${argsForDate.join(' / ')}, ${parsed.label}`;
    } else if (decsForDate.length > 0) {
      titles = `OPINIONS: ${decsForDate.join(' / ')}, ${parsed.label}`;
    } else {
      titles = `Unknown Recording, ${parsed.label}`;
    }

    const item = {
      titles,
      ids: [
        'NAID: unknown',
        `Local ID: ${localId}`,
        'Creator: Supreme Court of the United States. Office of the Marshal. 1867-',
      ],
      link:    '',
      sources: [url],
    };

    // Preserve existing derived fields so backfill doesn't re-fire unnecessarily
    const existing = existingByLocalId.get(localId);
    if (existing && existing.term !== undefined) {
      item.term   = existing.term;
      item.date   = existing.date;
      item.events = existing.events;
    }
    if (existing && existing.destinations !== undefined) {
      item.destinations = existing.destinations;
    }

    if (!existing) {
      report.added++;
    } else if (
      existing.titles === item.titles &&
      JSON.stringify(existing.ids) === JSON.stringify(item.ids) &&
      existing.link === item.link &&
      JSON.stringify(existing.sources) === JSON.stringify(item.sources)
    ) {
      report.unchanged++;
    } else {
      report.updated++;
    }

    items.push(item);
  }

  return { items, report };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Apply corrections from ussc.json to a title string.
 *
 * Corrections are flat arrays interpreted as pairs: [find1, replace1, find2, replace2, ...]
 * Special cases:
 *   - Odd trailing element: append that string if not already at the end of the title
 *     (e.g. [", March 20, 1974"] appends a date suffix)
 *   - Pair ["^", prefix]: prepend prefix + " / " to the title if not already starting with prefix
 *   - Regular pair [find, replace]: replace first occurrence in title
 *   - "*" key: global corrections applied to ALL items before per-item corrections
 */
function applyCorrections(title, naId, corrections) {
  if (!corrections) return title;

  // Apply global corrections first, then per-item corrections
  const rulesets = [];
  if (corrections['*']) rulesets.push(corrections['*']);
  const perItem = corrections[String(naId)];
  if (perItem) rulesets.push(perItem);

  for (const rules of rulesets) {
    if (!rules || !rules.length) continue;

    for (let i = 0; i < rules.length; i += 2) {
      if (i + 1 >= rules.length) {
        // Odd trailing element: append if not already at end of title
        if (!title.endsWith(rules[i])) {
          title += rules[i];
        }
      } else if (rules[i] === '^') {
        // "^" prefix: prepend second element + " / " if title doesn't already start with it
        if (!title.startsWith(rules[i + 1])) {
          title = rules[i + 1] + ' / ' + title;
        }
      } else if (title.includes(rules[i])) {
        // Replace first occurrence in title
        title = title.replace(rules[i], rules[i + 1]);
      }
      // (if not found in title, no-op — source file corrections in the same array are ignored here)
    }
  }

  return title;
}

/**
 * Fetch all items in a collection via paginated API using ancestorNaId parameter.
 * Uses rows + page for pagination (offset/from are not supported by this API).
 * Returns array of raw API record objects.
 */
async function fetchAllItems(collectionNaId, extraParams = {}) {
  const items = [];
  let page = 1;
  let total = null;

  while (true) {
    const url = `${API_BASE}?${new URLSearchParams({
      q: '*',
      rows: ROWS_PER_PAGE,
      sort: 'naId:asc',
      ancestorNaId: String(collectionNaId),
      page: String(page),
      ...extraParams,
    }).toString()}`;

    const data = await fetchJson(url);
    const hits = data.body.hits;

    if (total === null) {
      total = hits.total.value;
      process.stderr.write(`  Fetching ${total} items...\n`);
    }

    for (const hit of hits.hits) {
      items.push(hit._source.record);
    }

    if (items.length >= total || hits.hits.length === 0) break;
    page++;

    await sleep(DELAY_MS);
  }

  return items;
}

/**
 * Fetch a single record by naId.
 */
async function fetchRecord(naId) {
  const url = `${API_BASE}?naId=${naId}`;
  const data = await fetchJson(url);
  const hits = data.body.hits.hits;
  return hits.length ? hits[0]._source.record : null;
}

/**
 * Build a stored item object from an API record, applying corrections.
 * Format varies by collection type:
 *   - series (594): { ids, titles, link }
 *   - audio/files: { titles, ids, link, sources, term?, date?, events?, destinations? }
 *
 * NOTE: This script only updates fields that come directly from the NARA API:
 *   titles, ids, link, sources
 * Fields derived from local processing (term, date, events, destinations) are
 * preserved from the existing record when updating, or left absent for new items.
 */
/**
 * Normalize a creator heading string from API format to stored format.
 * API: "Org Name. (MM/DD/YYYY - )" → stored: "Org Name. M/D/YYYY-"
 * API: "Org Name. (YYYY - )"       → stored: "Org Name. YYYY-"
 * API: "Org Name. (YYYY - YYYY)"   → stored: "Org Name. YYYY-YYYY"
 */
function normalizeCreatorHeading(heading) {
  return heading
    // Month/Day/Year range: (MM/DD/YYYY - MM/DD/YYYY)
    .replace(/\.\s*\((\d+)\/(\d+)\/(\d+)\s*-\s*(\d+)\/(\d+)\/(\d+)\)$/, (_, m1, d1, y1, m2, d2, y2) =>
      `. ${parseInt(m1, 10)}/${parseInt(d1, 10)}/${y1}-${parseInt(m2, 10)}/${parseInt(d2, 10)}/${y2}`)
    // Month/Day/Year open end: (MM/DD/YYYY - )
    .replace(/\.\s*\((\d+)\/(\d+)\/(\d+)\s*-\s*\)$/, (_, m, d, y) =>
      `. ${parseInt(m, 10)}/${parseInt(d, 10)}/${y}-`)
    // Year range: (YYYY - YYYY)
    .replace(/\.\s*\((\d{4})\s*-\s*(\d{4})\)$/, '. $1-$2')
    // Year open end: (YYYY - )
    .replace(/\.\s*\((\d{4})\s*-\s*\)$/, '. $1-');
}

function buildItemFromRecord(record, collectionType, corrections, existingItem) {
  const naId = record.naId;
  const rawTitle = record.title || '';
  const correctedTitle = applyCorrections(rawTitle, naId, corrections);

  // Build ids array
  const ids = [];

  // For series-level children (type=series), format matches 594.json:
  //   Creator: ..., [Local ID: ... | HMS/MLR: ...], NAID: ...
  if (collectionType === 'series') {
    const creator = (record.creators || [])[0];
    if (creator) {
      ids.push(`Creator: ${normalizeCreatorHeading(creator.heading)}`);
    }

    if (record.localIdentifier) {
      ids.push(`Local ID: ${record.localIdentifier}`);
    } else {
      const hmsEntries = (record.variantControlNumbers || [])
        .filter(v => v.type === 'HMS/MLR Entry Number')
        .map(v => v.number)
        .sort();
      if (hmsEntries.length === 1) {
        ids.push(`HMS/MLR: ${hmsEntries[0]}`);
      } else if (hmsEntries.length > 1) {
        const shown = hmsEntries.slice(0, 2).join(',  ');
        const moreCount = hmsEntries.length - 2;
        ids.push(moreCount > 0 ? `HMS/MLRs: ${shown}, ${moreCount} more...` : `HMS/MLRs: ${shown}`);
      }
    }
    ids.push(`NAID: ${naId}`);

    // Build title: raw API title + coverage date range if available
    let seriesTitle = correctedTitle;
    if (record.coverageStartDate?.year && record.coverageEndDate?.year) {
      seriesTitle += `, ${record.coverageStartDate.year}-${record.coverageEndDate.year}`;
    } else if (record.coverageStartDate?.year) {
      seriesTitle += `, ${record.coverageStartDate.year}-`;
    } else if (existingItem && existingItem.titles.startsWith(correctedTitle)) {
      // No coverage dates from API — preserve existing title which may have a date range appended
      seriesTitle = existingItem.titles;
    }

    return {
      ids,
      titles: seriesTitle,
      link: `https://catalog.archives.gov/id/${naId}`,
    };
  }

  // For audio/files collections (items under the collection):
  // ids: NAID, [Container ID], [Local ID], Creator (from nearest ancestor with creators)
  ids.push(`NAID: ${naId}`);

  // Container ID from physicalOccurrences
  const containerId = record.physicalOccurrences?.[0]?.mediaOccurrences?.[0]?.containerId;
  if (containerId) ids.push(`Container ID: ${containerId}`);

  if (record.localIdentifier) {
    ids.push(`Local ID: ${record.localIdentifier}`);
  }

  // Creator from nearest ancestor that has creators (walk up by distance)
  const sortedAncestors = (record.ancestors || []).slice().sort((a, b) => a.distance - b.distance);
  for (const ancestor of sortedAncestors) {
    const creator = (ancestor.creators || [])[0];
    if (creator) {
      ids.push(`Creator: ${normalizeCreatorHeading(creator.heading)}`);
      break;
    }
  }

  // Sources: digital object URLs when available; preserve existing fallback URL when none
  const digitalUrls = (record.digitalObjects || []).map(o => o.objectUrl);
  const sources = digitalUrls.length > 0
    ? digitalUrls
    : (existingItem ? existingItem.sources : []);

  // Build the date-annotated title (stored format adds ", Month DD, YYYY" or ", YYYY")
  // We use the existing titles if present to preserve date annotation;
  // otherwise fall back to just the corrected title
  let titles = correctedTitle;
  if (existingItem) {
    // Strip trailing date suffix (various formats) to get the base title
    const existingBase = existingItem.titles
      .replace(/,\s+\w+ \d+, \d{4}$/, '') // "Month D, YYYY"
      .replace(/,\s+\w+ \d{4}$/, '')       // "Month YYYY"
      .replace(/,\s+\d{4}$/, '')           // just "YYYY"
      .trim();
    if (existingBase === correctedTitle) {
      titles = existingItem.titles; // preserve date annotation
    } else {
      // Title changed — use corrected title, preserving date suffix if not already present
      const dateSuffix = existingItem.titles.match(/,\s+(?:\w+ \d+, |\w+ )?\d{4}$/);
      if (dateSuffix && !correctedTitle.endsWith(dateSuffix[0])) {
        titles = correctedTitle + dateSuffix[0];
      } else {
        titles = correctedTitle;
      }
    }
  } else {
    // New item: build titles with date from productionDates if available
    const pd = (record.productionDates || [])[0];
    if (pd && pd.logicalDate) {
      const d = new Date(pd.logicalDate + 'T12:00:00Z');
      const monthName = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
      titles = `${correctedTitle}, ${monthName} ${pd.day}, ${pd.year}`;
    }
  }

  const item = {
    titles,
    ids,
    link: `https://catalog.archives.gov/id/${naId}`,
    sources,
  };

  // Preserve existing derived fields that come from local processing
  if (existingItem) {
    if (existingItem.term !== undefined) item.term = existingItem.term;
    if (existingItem.date !== undefined) item.date = existingItem.date;
    if (existingItem.events !== undefined) item.events = existingItem.events;
    if (existingItem.destinations !== undefined) item.destinations = existingItem.destinations;
  }

  return item;
}

/**
 * Compare two items and return whether they differ on API-sourced fields.
 */
function itemsMatch(a, b) {
  // Compare only the fields that come from the NARA API
  return (
    a.titles === b.titles &&
    JSON.stringify(a.ids) === JSON.stringify(b.ids) &&
    a.link === b.link &&
    JSON.stringify(a.sources) === JSON.stringify(b.sources)
  );
}

/**
 * Refresh a single collection.
 * Returns { added, updated, deleted, unchanged } counts and the new items array.
 */
async function refreshCollection(entry) {
  const { id, type, level, corrections } = entry;
  const filePath = resolve(NARA_DIR, `${id}.json`);

  // Load existing data
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    // File doesn't exist yet
  }

  // Separate synthetic items (NAID: unknown) from real API-sourced items.
  // Synthetics are handled outside the normal add/update/delete cycle.
  const existingSynthetics = existing.filter(item => {
    const naidEntry = item.ids && item.ids.find(s => s.startsWith('NAID: '));
    return naidEntry && isNaN(parseInt(naidEntry.replace('NAID: ', ''), 10));
  });

  // Build a lookup of existing real items by NAID (skip synthetics)
  const existingByNaId = new Map();
  for (const item of existing) {
    const naidEntry = item.ids.find(s => s.startsWith('NAID: '));
    if (naidEntry) {
      const naId = parseInt(naidEntry.replace('NAID: ', ''), 10);
      if (!isNaN(naId)) existingByNaId.set(naId, item);
    }
  }

  // Fetch fresh items from the API
  let freshRecords;
  if (level === 'series') {
    // For the series-level (594), fetch only direct series/fileUnit children using
    // levelOfDescription=series filter (much more efficient than fetching all descendants)
    freshRecords = await fetchAllItems(id, { levelOfDescription: 'series' });
  } else {
    // For audio/files collections, fetch all items
    freshRecords = await fetchAllItems(id);
  }

  process.stderr.write(`  Got ${freshRecords.length} items from API\n`);

  const newItems = [];
  const report = { added: [], updated: [], deleted: [], unchanged: 0 };
  const freshNaIds = new Set();

  for (const record of freshRecords) {
    const naId = record.naId;
    freshNaIds.add(naId);

    const existingItem = existingByNaId.get(naId) || null;
    const newItem = buildItemFromRecord(record, level || type, corrections, existingItem);

    if (!existingItem) {
      report.added.push({ naId, title: newItem.titles });
    } else if (!itemsMatch(existingItem, newItem)) {
      report.updated.push({
        naId,
        title: newItem.titles,
        changes: describeChanges(existingItem, newItem),
      });
    } else {
      report.unchanged++;
    }

    newItems.push(newItem);
  }

  // Find deleted items
  for (const [naId, item] of existingByNaId) {
    if (!freshNaIds.has(naId)) {
      report.deleted.push({ naId, title: item.titles });
    }
  }

  return { report, newItems, existingSynthetics };
}

function describeChanges(oldItem, newItem) {
  const changes = [];
  if (oldItem.titles !== newItem.titles) changes.push(`title: "${oldItem.titles}" → "${newItem.titles}"`);
  if (JSON.stringify(oldItem.ids) !== JSON.stringify(newItem.ids)) changes.push('ids changed');
  if (JSON.stringify(oldItem.sources) !== JSON.stringify(newItem.sources)) changes.push('sources changed');
  return changes;
}

function printReport(id, title, report) {
  const total = report.added.length + report.updated.length + report.deleted.length + report.unchanged;
  console.log(`\n=== Collection ${id}: ${title} ===`);
  console.log(`  Total: ${total} | Added: ${report.added.length} | Updated: ${report.updated.length} | Deleted: ${report.deleted.length} | Unchanged: ${report.unchanged}`);

  if (report.added.length) {
    console.log(`  ADDED (${report.added.length}):`);
    for (const item of report.added) {
      console.log(`    + [${item.naId}] ${item.title}`);
    }
  }

  if (report.updated.length) {
    console.log(`  UPDATED (${report.updated.length}):`);
    for (const item of report.updated) {
      console.log(`    ~ [${item.naId}] ${item.title}`);
      for (const change of item.changes) {
        console.log(`      ${change}`);
      }
    }
  }

  if (report.deleted.length) {
    console.log(`  DELETED (${report.deleted.length}):`);
    for (const item of report.deleted) {
      console.log(`    - [${item.naId}] ${item.title}`);
    }
  }
}

// ---- Main ----

const args = process.argv.slice(2);
const dryRun   = args.includes('--dry-run');
const csvOnly  = args.includes('--csv');
const idFilter = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;

if (dryRun) console.log('[DRY RUN] No files will be written.\n');

// --csv: regenerate only the synthetic entries for the Gold Series
if (csvOnly) {
  const filePath = resolve(NARA_DIR, '175704063.json');
  let existing = [];
  try { existing = JSON.parse(readFileSync(filePath, 'utf8')); } catch (e) { /* no file */ }

  const existingSynthetics = existing.filter(item => {
    const naidEntry = item.ids && item.ids.find(s => s.startsWith('NAID: '));
    return naidEntry && isNaN(parseInt(naidEntry.replace('NAID: ', ''), 10));
  });
  const realItems = existing.filter(item => {
    const naidEntry = item.ids && item.ids.find(s => s.startsWith('NAID: '));
    return !naidEntry || !isNaN(parseInt(naidEntry.replace('NAID: ', ''), 10));
  });

  const { items: synthetics, report } = buildSyntheticItemsForGoldSeries(existingSynthetics);
  console.log(`Synthetic (catalog gap): ${synthetics.length} total | Added: ${report.added} | Updated: ${report.updated} | Unchanged: ${report.unchanged}`);

  const allItems = [...realItems, ...synthetics];
  const backfilled = backfillGoldSeriesDerivedFields(allItems);
  if (backfilled) console.log(`  Backfilled derived fields for ${backfilled} items`);

  if (!dryRun && (report.added + report.updated + backfilled > 0)) {
    writeFileSync(filePath, JSON.stringify(allItems, null, 2) + '\n');
    console.log(`  Wrote ${filePath}`);
  } else if (dryRun) {
    if (report.added + report.updated + backfilled > 0) console.log('  [dry-run] Would write updated file');
    else console.log('  No changes detected');
  } else {
    console.log('  No changes detected');
  }
  console.log('\nDone.');
  process.exit(0);
}

const scotus = JSON.parse(readFileSync(resolve(ROOT, 'data/nara/ussc.json'), 'utf8'));
const collections = scotus.filter(e => e.collect && (!idFilter || e.id === idFilter));

if (collections.length === 0) {
  console.error(idFilter ? `No collection found with id=${idFilter}` : 'No collections to process');
  process.exit(1);
}

for (const entry of collections) {
  console.log(`\nProcessing collection ${entry.id}: ${entry.title}`);

  try {
    const { report, newItems, existingSynthetics } = await refreshCollection(entry);
    printReport(entry.id, entry.title, report);

    // For the Gold Series, append synthetic entries when catalog still lacks 2024-10 data
    if (entry.id === '175704063' && !itemsHaveDateInRange(newItems, 2024, 10, 2025, 9)) {
      const { items: synthetics, report: synthReport } = buildSyntheticItemsForGoldSeries(existingSynthetics);
      if (synthetics.length) {
        newItems.push(...synthetics);
        console.log(`  Synthetic (catalog gap): ${synthetics.length} total | Added: ${synthReport.added} | Updated: ${synthReport.updated} | Unchanged: ${synthReport.unchanged}`);
        report._syntheticChanged = (report._syntheticChanged || false) || (synthReport.added + synthReport.updated > 0);
      }
    }

    // Backfill term/date/events for any Gold Series items that are missing them
    if (entry.id === '175704063') {
      const backfilled = backfillGoldSeriesDerivedFields(newItems);
      if (backfilled) {
        console.log(`  Backfilled derived fields for ${backfilled} items`);
        report._backfillChanged = true;
      }
    }

    if (!dryRun && (report.added.length || report.updated.length || report.deleted.length || report._syntheticChanged || report._backfillChanged)) {
      const filePath = resolve(NARA_DIR, `${entry.id}.json`);
      writeFileSync(filePath, JSON.stringify(newItems, null, 2) + '\n');
      console.log(`  Wrote ${filePath}`);
    } else if (dryRun && (report.added.length || report.updated.length || report.deleted.length || report._syntheticChanged || report._backfillChanged)) {
      console.log('  [dry-run] Would write updated file');
    } else {
      console.log('  No changes detected');
    }
  } catch (err) {
    console.error(`  ERROR processing ${entry.id}:`, err.message);
  }

  await sleep(DELAY_MS);
}

console.log('\nDone.');
