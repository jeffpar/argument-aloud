# Argument Aloud – Claude Instructions

## Overview

**Argument Aloud** is a Jekyll-based static website for browsing U.S. Supreme Court oral arguments — audio playback, synchronized transcripts, case metadata, and advocate/justice profiles. Hosted on GitHub Pages.

## Build & Dev

```bash
# Serve locally (auto-runs on folder open via VS Code task)
bundle exec jekyll serve --host 0.0.0.0 --port 4008
# → http://localhost:4008
```

`_site/` is the build output — never edit files there directly.

## Architecture

```
_config.yml          Jekyll config (remote minimal theme, data_dir: data)
_layouts/            Page templates (argument, default, document, post)
_includes/           Partials (arguments.html audit widget, collection.html)
assets/js/           explorer.js – large vanilla JS SPA (~7000+ lines)
assets/css/          explorer.css (SPA), document.css, style.scss
courts/ussc/         Case/term data + HTML entry points
data/                Jekyll data directory (site.data.*)
scripts/             Import/update/alignment scripts (Node.js)
```

## Data Conventions

### Terms
- Format: `YYYY-MM` (e.g., `2025-10` = October Term 2025, `1793-02` = February Term 1793)
- `courts/ussc/terms/terms.json` — master list of all terms. Each term object's own `dates` boolean says whether `courts/ussc/terms/YYYY-MM/dates.json` exists (set by `update_cases.js`'s `syncTermsJson`) — the front end (`assets/js/terms.js`, `explorer.js`) checks this before ever fetching it, since most terms don't have one. `minutes` (an array of `{cover}` cover-thumbnail filenames) is independent of this — a term's `dates.json` can exist purely for cross-term case entries (see below) with no Minutes-scan data at all.
- `courts/ussc/terms/YYYY-MM/cases.json` — cases for a term

### dates.json (optional, per term)
`courts/ussc/terms/YYYY-MM/dates.json` maps an ISO date to an array of entries, built/maintained by two different scripts. Every entry starts with a `type` prop identifying its own kind — **the only thing any code should ever check** to tell the two kinds apart, never which other props happen to be present:
- **Minutes-scan groups** — `{type: "minutes", href, src, pages, modified?}`, built by `scripts/parse_minutes.js` from NARA's OCR'd Minutes books. `pages` is a `"<first>-<last>"` range string (every group's own pages are always a gap-free consecutive run), or `""` for an empty/tombstone group. See that script's own top-of-file doc comment for the full format.
- **Cross-term case-detail objects** — `{type, id, term, number, title, usCite}`, added by `update_cases.js`'s `syncCrossTermCaseDates` for a case whose `argument`/`reargument` date falls within an *earlier* term's own date range than the term it's filed under (e.g. a case reargued in the term after the one it was first argued in — `term` here is the case's own term, `type` is `"argument"` or `"reargument"`). The front end adds these to that earlier term's own date-argued/reargued lists and Court Calendar coloring when viewing its page, linking to the case via its own `term`.

### Case schema (in `cases.json`)
Canonical key order is defined in `scripts/schema.js` (`CASE_KEY_ORDER` / `EVENT_KEY_ORDER`). Always call `reorderCase()` / `reorderEvent()` when writing new objects.

`volume` and `page` are **not written** to new cases — they are derived from `usCite` at read time. Existing cases that still carry them are cleaned up by `update_cases.js`.

`oyez_href` is normally a single URL string, but for a case consolidated from multiple Oyez case pages (e.g. `1971-176`) it's an array of URL strings instead — both forms are handled by `explorer.js` and `import_oyez.js`.

`argument_consolidation` (optional) is a comma-separated docket number(s) of every case (this one included) — each a separately tracked case object (own `id`/`title`/`decision`) — heard in the same argument session, distinct from a joint `number` (one case filed under several dockets). Every case in the group carries the exact same value.

```json
{
  "id": "2024-123",
  "title": "Case Name v. Other Party",
  "number": "24-1260",
  "oyez_href": "https://www.oyez.org/cases/2024/24-1260",
  "questions": "Plain-text questions presented",
  "questions_href": "https://…/pdf",
  "argument_consolidation": "24-1260,24-1261",
  "argument": "YYYY-MM-DD",
  "decision": "YYYY-MM-DD",
  "usCite": "601 U.S. 1",
  "result": "affirmed|reversed|vacated|…",
  "voteMajority": 6,
  "voteMinority": 3,
  "votes": [{"name": "JOHN ROBERTS", "vote": "majority"}],
  "events": [
    {
      "source": "ussc|oyez|nara",
      "type": "argument|decision|reargument",
      "date": "YYYY-MM-DD",
      "title": "Oral Argument on Month D, YYYY",
      "audio_href": "https://…/mp3",
      "offset": 0,
      "transcript_href": "https://…/pdf",
      "text_href": "YYYY-MM-DD.json",
      "advocates": [{"name": "LAST NAME", "title": "MR.", "role": "Petitioner"}],
      "aligned": true
    }
  ],
  "files": 0
}
```

### reports.json (`data/ussc/reports.json`)
Object keyed by `"vNNN"` (or `"vNNN-P"` for a not-yet-bound volume split into parts, e.g. `"v592-2"`), one entry per U.S. Reports volume, matching `courts/ussc/opinions/{pdfs,text}/vNNN.{pdf,txt}`. Each entry:
```json
{
  "href": "https://www.supremecourt.gov/pdfs/USReports/USREPORTS-126_PDFA.pdf",
  "pages": "1:13,",
  "alt_citation": "2 Dallas",
  "ephemera": [
    { "text": "THE TELEPHONE CASES", "page": "1", "note": "This is the only volume of U.S. Reports dedicated to a single opinion." }
  ]
}
```
- `pages` — comma-separated `<reportPage>:<pdfPage>` breakpoints (optionally roman, e.g. `vi:490`; optionally `*`-marked as an "orders mapping" section start, see `isOrdersBreakpoint` in `scripts/update_cases.js`) mapping a printed U.S. Reports page to its PDF page. `_pdfPageFor`/`_parsePages` (`scripts/update_cases.js`) and `_reportPdfPage`/`_parsePnBps` (`assets/js/explorer.js`, kept in sync by hand) walk these breakpoints to resolve a case's `usCite` to a `#page=N` PDF link (`decision_vol`).
- `alt_citation` (optional) — the volume's nominative-reporter name (e.g. early volumes cited as `"2 Dallas"` before the `"N U.S."` convention).
- `ephemera` (optional) — array flagging notable non-opinion content in the volume (dedications, addresses, in-memoriam notices, patent diagrams, unbound inserts, etc.). Each entry carries `page` (the U.S. Reports page, as a string, may include a letter suffix) plus exactly one of:
  - `text` — a short all-caps label describing referenced text (e.g. `"THE TELEPHONE CASES"`)
  - `image` — a short description of a referenced picture/diagram/plate
  - `insert` — a short description of an unnumbered insert; `page` here is the page the insert *follows*, not the insert's own page (it has none)

  plus an optional `note` freeform aside on any of the three.

### Transcript envelope format (`courts/ussc/terms/YYYY-MM/cases/CASE/YYYY-MM-DD.json`)
```json
{
  "media": { "url": "https://…/mp3", "speakers": [{ "name": "JOHN ROBERTS", "title": "CHIEF JUSTICE" }] },
  "turns": [
    { "turn": 1, "name": "JOHN ROBERTS", "text": "…", "time": "00:00:05.12" }
  ]
}
```
- `time` is `HH:MM:SS.FF` (frame-based; `.FF` treated as decimal seconds in JS)
- Speaker `name` is ALL CAPS last name (or full name); `title` is role: `CHIEF JUSTICE`, `JUSTICE`, `GENERAL` (AG), `MR.`, `MS.`
- `turn` is 1-based

### Collections (`courts/ussc/collections/collections.json`)
Array of `{ title, collection (absolute path to JSON), folder?, focus?, sort?, categories? }` — pre-built advocate/justice and curated collections.

### Podcast feeds (`courts/ussc/feeds/`)
Generated by `node scripts/update_cases.js --feeds` — never edit by hand.
- `feeds/terms/YYYY-MM.json` — every audio-bearing event for one term (oldest first): `{ guid, title, date, type, case, caseId, link, audio_href, size, duration, durationSecs, source, advocates?, description }`.
- `feeds/terms/YYYY-MM.xml` — standalone RSS 2.0 + iTunes-namespace feed for that term (newest-first, the RSS convention).
- `feeds/podcast.xml` — master feed combining every term as an iTunes "season" (season 1 = earliest term with audio), so one subscribe URL surfaces the whole archive.
- `feeds/index.json` — manifest of every per-term feed (`term`, `name`, `season`, `count`, `firstDate`, `lastDate`, `json`, `xml`).
- Episode de-duplication: an event is skipped if `redundant: true`; when the same `(type, date, title)` still has more than one source (rare), `oyez` wins over `ussc` over `nara`.
- No network calls — byte size (`event.size`) and duration (`event.length`) already come from cases.json.
- `assets/xsl/podcast.xsl` renders any of these XML files as a readable episode list/subscribe page in-browser (same `<?xml-stylesheet?>` pattern as `assets/xsl/opinion.xsl`).
- `FEED_IMAGE_URL` in `update_cases.js` points at `/assets/img/podcast-cover.jpg` — a 1909×1909 square crop of `assets/img/aa_exterior1.jpg` (meets Apple/Spotify's 1400×1400 minimum).

### Sitemap (`courts/ussc/sitemap.xml`)
Generated by `node scripts/update_cases.js --sitemap` — never edit by hand. Every case/term/collection view in `explorer.js` is really the same static HTML shell (`courts/ussc/index.html`) with content resolved client-side from URL query params, so this is the only way search engines can discover the ~29,000 individual case URLs.
- One `<url>` per case (`?term=X&case=Y`, using the case's own unique `id` — falling back to its docket `number` for the rare case lacking one — to avoid collisions across consolidated cases), per term (`?term=X`), and per collection/topic (`?collection=X` / `?topic=X`), plus the site root and the SPA entry point.
- `<lastmod>` is the build date for every entry, not each case's own `decision`/`argument` date — Google's sitemap validator rejects a large fraction of this archive's real dates (partial `YYYY-MM` dates from early terms, and apparently anything before 1970).
- Referenced from `robots.txt` at the repo root.
- No network calls — fully derived from `cases.json`/`collections.json`/`topics.json`.

## Key Scripts

| Script | Purpose | Usage |
|---|---|---|
| `import_ussc.js` | Scrape SCOTUS listing, extract PDF transcripts | `node scripts/import_ussc.js 2025-10` |
| `import_ussc.js --orig` | Fetch original-jurisdiction documents for every `"Original Jurisdiction Archive"`-tagged case still missing them | `node scripts/import_ussc.js --orig` |
| `import_oyez.js` | Fetch audio + aligned transcripts from Oyez API | `node scripts/import_oyez.js 2025-10` |
| `import_nara.js` | Refresh NARA catalog JSON | `node scripts/import_nara.js` |
| `update_cases.js` | Verify/fix metadata; apply vote/decision data | `node scripts/update_cases.js [TERM [CASE]] [--checkurls] [--opinions] [--dry-run]` |
| `update_cases.js --feeds` | Rebuild podcast RSS feeds under `courts/ussc/feeds/` | `node scripts/update_cases.js --feeds` |
| `update_cases.js --sitemap` | Rebuild `courts/ussc/sitemap.xml` (one `<url>` per case/term/collection/topic) | `node scripts/update_cases.js --sitemap` |
| `update_cases.js --collections` | Rebuild tag-based collections (`courts/ussc/collections/*.json`, `courts/ussc/topics/*.json`), incl. `orig.json`'s `gallery` thumbnail lists | `node scripts/update_cases.js --collections` |
| `update_cases.js --scdb` (full run, no `TERM`) | Also regenerates `courts/ussc/collections/audits/scdb/index.md` — every SCDB case (argued or not) with no matching entry anywhere in `courts/ussc/terms/*/cases.json`. Always read-only and comprehensive for this page regardless of `--update`/`--dry-run`/`--all`; these cases are deliberately excluded from `audits.json` since they don't exist in our data (see the "Cases Not Included from SCDB" `collections.json` group, which just links to the page) | `node scripts/update_cases.js --scdb` |
| `update_advocates.js` | Rebuild advocate profiles from all transcripts | `node scripts/update_advocates.js` |
| `download.js` | Cache PDFs, MP3s, and opinion HTML locally | `node scripts/download.js [TERM [CASE]] [--justia] [--refetch]` |
| `download.js --files` | Cache every `files.json` document href locally | `node scripts/download.js [TERM [CASE]] --files` |
| `download.js --thumbs` | Generate Original Jurisdiction Archive cover thumbnails (page 1 of each PDF, via `pdftoppm`) under `courts/ussc/collections/historical/orig/`; downloads/caches the source PDF on demand if not already cached | `node scripts/download.js [TERM [CASE]] --thumbs` |
| `schema.js` | Canonical key ordering helpers (library, not run directly) | `import { reorderCase, reorderEvent } from './schema.js'` |

**Dependencies:** `pdftotext` (poppler via `brew install poppler`), `pip install faster-whisper rapidfuzz`, `brew install ffmpeg`

## Typical Workflow

```bash
# 1. Pull new argument listings and transcripts (run daily or when new args appear)
node scripts/import_ussc.js 2025-10

# 2. Pull Oyez audio + aligned transcripts (run within a week of import_ussc.js)
node scripts/import_oyez.js 2025-10

# 3. Verify and auto-fix metadata (key ordering, sort, etc.)
node scripts/update_cases.js 2025-10

# 4. Rebuild advocate profiles whenever new transcripts were added
node scripts/update_advocates.js
```

## Updating Decisions (Votes)

Use a single `update_cases.js` command to record the outcome, vote tally, opinion author, and individual justice votes:

```bash
# 5-4 win for petitioner; Barrett wrote majority; Alito dissented; Thomas/Gorsuch/Kavanaugh also in minority
node scripts/update_cases.js 2025-10 24-1260 --votes win 5-4 barrett \
  --dissent alito --minority thomas gorsuch kavanaugh

# Unanimous win, Roberts authored
node scripts/update_cases.js 2024-10 2024-001 --votes win 9-0 roberts

# 6-3 loss; Kagan wrote dissent; Sotomayor and Jackson also in minority
node scripts/update_cases.js 2025-10 24-109 --votes loss 6-3 alito \
  --dissent kagan --minority sotomayor jackson

# Jackson recused; otherwise unanimous
node scripts/update_cases.js 2024-10 2024-022 --votes win 8-0 kavanaugh \
  --recused jackson
```

- `--dissent` authors are automatically counted in the minority — no need to repeat them in `--minority`
- Justice names are matched by last name against `data/ussc/justices.json` for the decision date

## Front-End (explorer.js SPA)

The main interactive page is a large vanilla JS single-page app in `assets/js/explorer.js`.

**Key patterns:**
- `init()` — entry point; loads `index.json`, `terms.json`, `collections.json`, builds nav tree
- `restoreFromURL()` — reads URL params and restores UI state on load/navigation
- `parseTime(s)` — `"HH:MM:SS.FF"` → seconds (float)
- `formatSpeaker(name)` — `"JUSTICE THOMAS"` → `"J. Thomas"`, `"GENERAL X"` → `"Gen. X"`
- `renderTurnText(el, rawText, query, isCurrent)` — renders transcript with `[ref]` marks and search highlights
- `seekAndPlay(time)` — seek audio to time and resume playback
- `findCurrentTurn(t)` — binary search over `turnTimes[]` to find active turn

**State globals:** `turns[]`, `turnTimes[]`, `activeTurnIdx`, `TERMS[]`, `COLLECTIONS[]`, `caseSpeakers[]`

**URL params:** `term=`, `case=`, `event=`, `turn=`, `collection=`, `topic=`, `source=`, `find=`. The pseudo-value `=all` on any top-level nav section ID (e.g. `term=all`, `collection=all`, `topic=all`, `source=all`) expands that section in the sidebar.

## CSS Layout

`explorer.css` drives the SPA layout:
- `#topbar` — 44px dark nav bar (`background: #1a1a2e`)
- `#browser` — flex-row: 30% sidebar (term/case tree) + 70% main panel
- `.turn` — transcript turn blocks; `.ref-mark`, `.search-match`, `.search-match.current` for highlights
- `#search-overlay` — modal search dialog
- Responsive breakpoint at `768px`

## Pitfalls

- **Never edit `_site/`** — it's Jekyll build output, overwritten on every build.
- **`_config.yml` excludes `scripts/` and `sources/`** — changes there won't affect the built site.
- **`data/` is Jekyll's data dir** — eg, files in `data/ussc/` are accessible as `site.data.ussc.*` in templates.
- **Audio timing uses frames** — `HH:MM:SS.FF` where `.FF` is frame number treated as decimal; `parseTime()` handles this correctly.
- **`courts/ussc/index.html` is the SPA entry point**, not `index.md` — it uses `layout: argument`.
- **`volume` and `page` are derived internally from `usCite`** — they are no longer written to case objects.
