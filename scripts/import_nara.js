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
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const NARA_DIR = resolve(ROOT, 'data/nara/ussc');

const API_BASE = 'https://catalog.archives.gov/proxy/records/search';
const ROWS_PER_PAGE = 100;
const DELAY_MS = 300; // polite delay between requests

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
 * Corrections are flat arrays interpreted as pairs: [find1, replace1, find2, replace2, ...].
 * Special cases:
 *   - Odd-length (single string): remove that string (equivalent to replace with '')
 *   - First element is "^": replace the entire title with the second element
 *   - "*" key: global corrections applied to ALL items
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

    // Single string: remove it
    if (rules.length === 1) {
      title = title.split(rules[0]).join('');
      continue;
    }

    // "^" prefix: full title replacement
    if (rules[0] === '^') {
      title = rules[1];
      continue;
    }

    // Odd-length with more than 1 element: process pairs, then handle trailing single
    const pairs = [];
    for (let i = 0; i < rules.length - 1; i += 2) {
      pairs.push([rules[i], rules[i + 1]]);
    }
    // If odd-length, the last element is a standalone removal
    if (rules.length % 2 === 1) {
      pairs.push([rules[rules.length - 1], '']);
    }

    for (const [find, replace] of pairs) {
      title = title.split(find).join(replace);
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

  // Build a lookup of existing items by NAID
  const existingByNaId = new Map();
  for (const item of existing) {
    const naidEntry = item.ids.find(s => s.startsWith('NAID: '));
    if (naidEntry) {
      const naId = parseInt(naidEntry.replace('NAID: ', ''), 10);
      existingByNaId.set(naId, item);
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

  return { report, newItems };
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
const dryRun = args.includes('--dry-run');
const idFilter = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;

const scotus = JSON.parse(readFileSync(resolve(ROOT, 'data/nara/ussc.json'), 'utf8'));
const collections = scotus.filter(e => e.collect && (!idFilter || e.id === idFilter));

if (collections.length === 0) {
  console.error(idFilter ? `No collection found with id=${idFilter}` : 'No collections to process');
  process.exit(1);
}

if (dryRun) console.log('[DRY RUN] No files will be written.\n');

for (const entry of collections) {
  console.log(`\nProcessing collection ${entry.id}: ${entry.title}`);

  try {
    const { report, newItems } = await refreshCollection(entry);
    printReport(entry.id, entry.title, report);

    if (!dryRun && (report.added.length || report.updated.length || report.deleted.length)) {
      const filePath = resolve(NARA_DIR, `${entry.id}.json`);
      writeFileSync(filePath, JSON.stringify(newItems, null, 2) + '\n');
      console.log(`  Wrote ${filePath}`);
    } else if (dryRun && (report.added.length || report.updated.length || report.deleted.length)) {
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
