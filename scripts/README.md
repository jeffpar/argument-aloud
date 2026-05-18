# Scripts

Node.js scripts for importing and maintaining SCOTUS oral argument data.

**Prerequisite:** `pdftotext` must be on your PATH (`brew install poppler`).

---

## Typical workflow

```
# 1. Run daily (or whenever new arguments are posted)
node scripts/import_ussc.js 2025-10

# 2. Run within a week of each import_ussc.js run
node scripts/import_oyez.js 2025-10

# 3. After either import adds new transcripts, rebuild advocate profiles
node scripts/update_advocates.js

# 4. Identify any data problems
node scripts/verify_cases.js 2025-10

# 5. Apply auto-fixable problems
node scripts/verify_cases.js 2025-10 --update
```

Run `import_nara.js` at least once a year to refresh the National Archives catalog.

---

## import_ussc.js

Fetches oral argument listings from supremecourt.gov for a term, updating
`courts/ussc/terms/TERM/cases.json` and generating transcript JSON files from
the official PDF transcripts.

```
node scripts/import_ussc.js TERM [CASE] [--docket] [--reparse] [--verbose]
                                        [--cases] [--checkurls] [--prompt]
```

| Argument / Flag | Description |
|---|---|
| `TERM` | Term in `YYYY-10` format (e.g. `2025-10`) |
| `CASE` | Optional docket number to process a single case |
| `--docket` | Fetch additional metadata from the SCOTUS docket API |
| `--reparse` | Re-extract text from already-downloaded PDFs |
| `--verbose` | Print extra progress detail |
| `--cases` | Allow adding new case entries to `cases.json` |
| `--checkurls` | Probe remote URLs to verify they are still live |
| `--prompt` | Interactively decide when a transcript conflict is found |

**Run frequency:** Daily, or whenever new arguments appear on supremecourt.gov.

---

## import_oyez.js

Downloads oral argument and opinion announcement audio (and aligned transcripts)
from the Oyez API for a term, adding `audio_href` and `text_href` entries to
each case's event list.

```
node scripts/import_oyez.js TERM [CASE] [--cases]
node scripts/import_oyez.js OYEZ_URL [--cases]
```

| Argument / Flag | Description |
|---|---|
| `TERM` | Term in `YYYY-10` format; `YYYY` alone is treated as `YYYY-10` |
| `CASE` | Optional docket number to process a single case |
| `OYEZ_URL` | Full Oyez case URL instead of term + case |
| `--cases` | Allow adding new case entries to `cases.json` |

**Run frequency:** Within a week of each `import_ussc.js` run, to pull in any
Oyez audio and synchronized transcripts that have been published since the last
import.

---

## import_nara.js

Refreshes the NARA catalog JSON files under `data/nara/ussc/` by querying the
National Archives catalog API. Reads `data/nara/ussc.json` as the manifest and
fetches every collection marked `collect: true`, reporting added, updated, and
deleted items.

```
node scripts/import_nara.js [--dry-run] [--id <naId>] [--csv]
```

| Flag | Description |
|---|---|
| `--dry-run` | Show report without writing any files |
| `--id <naId>` | Refresh only the collection with the given NARA accession ID |
| `--csv` | Regenerate only the synthetic entries for collection `175704063` (no API fetch) |

**Run frequency:** At least once a year to catch newly cataloged recordings.

---

## verify_cases.js

Validates case metadata and file entries across all terms (or a single term /
case). Read-only by default; writes fixes only when `--update` is given. Also
exported as a library used by `import_ussc.js` and `import_oyez.js`.

```
node scripts/verify_cases.js [TERM [CASE]] [--checkurls] [--opinions] [--roles]
                                           [--verbose] [--update]
node scripts/verify_cases.js [TERM [CASE]] --scdb [--update] [--ussc-deck]
                                           [--add] [--nocache] [--verbose]
node scripts/verify_cases.js [TERM [CASE]] --dates [--verbose]
```

| Argument / Flag | Description |
|---|---|
| `TERM` | Term to check (omit to check all terms) |
| `CASE` | Optional docket number to check a single case |
| `--update` | Apply auto-fixable problems (key reordering, sort order, etc.) |
| `--checkurls` | Probe remote URLs to verify they are still live |
| `--opinions` | Also check for missing opinion PDFs |
| `--roles` | Derive petitioner / respondent / etc. roles for each argument event |
| `--verbose` | Print extra detail |
| `--scdb` | Cross-check against the Supreme Court Database (SCDB) |
| `--ussc-deck` | Rebuild `data/aa/ussc_deck.csv` during SCDB check |
| `--add` | Add missing SCDB-derived fields to cases |
| `--nocache` | Ignore cached SCDB data |
| `--dates` | Check argument and decision dates for consistency |

**Run after:** Any `import_ussc.js` or `import_oyez.js` run. Use `--update` to
apply fixes automatically.

---

## update_advocates.js

Rebuilds the advocate profile index from all transcript files. Scans every
`text_href` transcript across all terms, extracts advocate speakers, and writes:

- `courts/ussc/people/advocates/all_advocates.json` — full index
- `courts/ussc/people/advocates/top/top_advocates.json` — top 100 by case count
- `courts/ussc/people/advocates/all/{id}.json` — per-advocate case lists

```
node scripts/update_advocates.js [--verbose|-v] [--women] [--repair]
                                 [--markdown] [--singles] [--fix]
```

| Flag | Description |
|---|---|
| `--verbose` / `-v` | List skipped names and unmatched records |
| `--women` | Cross-check against the women advocates reference CSV |
| `--repair` | Repair mode: rebuild index files from per-advocate JSON files |
| `--markdown` | Output a Markdown summary |
| `--singles` | Report single-appearance advocates |
| `--fix` | Apply name-normalization fixes |

**Run after:** Any import that downloads new transcripts.

---

## update_cases.js

Updates vote data for a specific case — result, voteMajority, voteMinority, and
votes array with proper seniority ordering. Automatically determines which
justices were serving on the decision date and validates all vote counts.

```
node scripts/update_cases.js TERM CASE --votes OUTCOME VOTE_STRING AUTHOR
                                      [--minority NAMES...] [--recused NAMES...]
                                      [--dissent NAMES...]
```

| Argument / Flag | Description |
|---|---|
| `TERM` | Term in `YYYY-10` format (e.g., `2024-10`) |
| `CASE` | Case ID or docket number (e.g., `2024-001` or `23-583`) |
| `--votes` | Begins vote specification (required) |
| `OUTCOME` | Either `win` or `loss` for the petitioning party |
| `VOTE_STRING` | Vote tally in format `N-N` (e.g., `6-3`, `9-0`) |
| `AUTHOR` | Last name of majority opinion author |
| `--minority` | Last names of justices in the minority (if any) |
| `--recused` | Last names of justices who recused (if any) |
| `--dissent` | Last names of justices who wrote dissents; adds `"dissent": true` to vote data. Dissent authors are automatically added to minority, so you don't need to list them in both flags |

**Name resolution:** Justice names can be specified by last name only (e.g.,
`kavanaugh`, `jackson`). Names are matched against justices serving on the
decision date using `data/ussc/justices.json`.

**Examples:**

```bash
# Unanimous decision, Roberts authored
node scripts/update_cases.js 2024-10 2024-001 --votes win 9-0 roberts

# 6-3 decision with liberal minority
node scripts/update_cases.js 2024-10 2024-001 --votes win 6-3 roberts \
  --minority sotomayor kagan jackson

# 6-3 decision with Kagan writing dissent
node scripts/update_cases.js 2025-10 24-109 --votes loss 6-3 alito \
  --dissent kagan --minority sotomayor jackson

# 8-0 decision with Jackson recused
node scripts/update_cases.js 2024-10 2024-022 --votes win 8-0 kavanaugh \
  --recused jackson
```

---

## download.js

Downloads and caches all external assets referenced in `cases.json` files —
opinion PDFs, audio MP3s, and transcript PDFs — into
`courts/ussc/cache/<term>/<case-number>/`. At the end, reports any URLs that
could not be reached.

`courts/ussc/cache` must exist before running (create the directory or symlink
it to your preferred storage location).

```
node scripts/download.js [TERM [CASE]] [--dry-run] [--refetch] [--verbose]
```

| Argument / Flag | Description |
|---|---|
| `TERM` | Term to download (omit to process all terms) |
| `CASE` | Optional docket number to limit to a single case |
| `--dry-run` | Show what would be downloaded without fetching |
| `--refetch` | Re-download even if the file already exists in the cache |
| `--verbose` | Print each URL as it is checked or downloaded |

The cache folder for a case is named after its primary docket number (the first
number in the `number` field). If two cases in the same term share the same
primary number, the `id` field is used instead.

---

## schema.js

Library (not run directly). Exports canonical key ordering for case and event
objects, and helper functions `reorderCase()` and `reorderEvent()` used by the
import scripts when writing JSON.
