# Argument Aloud – Workspace Instructions

## Overview

**Argument Aloud** is a Jekyll-based static website for browsing U.S. Supreme Court oral arguments — audio playback, synchronized transcripts, case metadata, and advocate/justice profiles. Hosted on GitHub Pages.

## Build & Dev

```bash
# Serve locally (auto-runs on folder open via VS Code task)
bundle exec jekyll serve --host 0.0.0.0 --port 4008
# → http://localhost:4008

# Python scripts use .venv
source .venv/bin/activate
```

`_site/` is the build output — never edit files there directly.

## Architecture

```
_config.yml          Jekyll config (remote minimal theme, data_dir: data)
_layouts/            Page templates (argument, default, document, post)
_includes/           Partials (arguments.html audit widget, collection.html)
assets/js/           argument.js – ~2600-line vanilla JS SPA
assets/css/          argument.css (SPA), document.css, style.scss
courts/ussc/         Case/term data + HTML entry points
data/                Jekyll data directory (site.data.*)
scripts/             Python import/validation/alignment scripts
```

## Data Conventions

### Terms
- Format: `YYYY-MM` (e.g., `2025-10` = October Term 2025, `1793-02` = February Term 1793)
- `courts/ussc/terms.json` — master list of all terms
- `courts/ussc/terms/YYYY-MM/cases.json` — cases for a term

### Case schema (in `cases.json`)
Canonical key order is defined in `scripts/schema.py` (`CASE_KEY_ORDER` / `EVENT_KEY_ORDER`). Use `reorder_case()` / `reorder_event()` when writing new objects.
```json
{
  "id": "2024-123",
  "title": "Case Name v. Other Party",
  "number": "24-1260",
  "oyez": "https://www.oyez.org/cases/2024/24-1260",
  "questions": "Plain-text questions presented",
  "questions_href": "https://…/pdf",
  "argument": "YYYY-MM-DD",
  "reargument": "YYYY-MM-DD",
  "decision": "YYYY-MM-DD",
  "volume": "601",
  "page": "1",
  "usCite": "601 U.S. 1",
  "dateDecision": "Weekday, Month D, YYYY",
  "voteMajority": 6,
  "voteMinority": 3,
  "votes": [{"name": "JOHN ROBERTS", "vote": "majority"}],
  "events": [
    {
      "source": "ussc|oyez|nara",
      "type": "argument|opinion|reargument",
      "date": "YYYY-MM-DD",
      "title": "Oral Argument on Month D, YYYY",
      "audio_href": "https://…/mp3",
      "offset": 0,
      "transcript_href": "https://…/pdf",
      "text_href": "YYYY-MM-DD.json",
      "advocates": [{"name": "LAST NAME", "title": "MR.", "role": "Petitioner"}],
      "aligned": true,
      "redundant": true
    }
  ],
  "opinion_href": "https://…",
  "files": 0
}
```

### Transcript envelope format (`courts/ussc/terms/YYYY-MM/cases/CASE/YYYY-MM-DD.json`)
```json
{
  "media": { "url": "https://…/mp3", "speakers": [{ "name": "JOHN ROBERTS", "title": "CHIEF JUSTICE" }] },
  "turns": [
    { "turn": 1, "name": "JOHN ROBERTS", "text": "…", "time": "00:00:05.12" }
  ]
}
```
- `time` is `HH:MM:SS.FF` (frame-based, `.FF` treated as decimal seconds in JS)
- Speaker `name` is ALL CAPS last name (or full name); `title` is role: `CHIEF JUSTICE`, `JUSTICE`, `GENERAL` (AG), `MR.`, `MS.`
- `turn` is 1-based

### Collections (`courts/ussc/collections.json`)
Array of `{ title, collection (absolute path to JSON), folder?, focus?, sort?, categories? }` — pre-built advocate/justice and curated collections.

## Key Scripts

| Script | Purpose | Usage |
|---|---|---|
| `import_ussc.py` | Scrape SCOTUS listing, extract PDF transcripts | `python3 scripts/import_ussc.py 2025-10` |
| `validate_cases.py` | Validate URLs, sync metadata, detect new opinions | `python3 scripts/validate_cases.py 2025-10 [CASE] [--checkurls]` |
| `align_transcript.py` | Sync transcript text with audio timing via Whisper | `python3 scripts/align_transcript.py 2025-10 24-1238` |
| `update_advocates.py` | Rebuild advocate profiles from all terms | `python3 scripts/update_advocates.py` |
| `update_transcripts.py` | Reprocess/reformat existing transcript JSON files | `python3 scripts/update_transcripts.py 2025-10` |
| `import_oyez.py` | Fetch historical data from Oyez API | `python3 scripts/import_oyez.py` |
| `schema.py` | Canonical key ordering helpers; import and call `reorder_case()` / `reorder_event()` | (library, not run directly) |

**Dependencies:** `pdftotext` (poppler-utils via Homebrew), `pip install faster-whisper rapidfuzz`, `brew install ffmpeg`

## Front-End (argument.js SPA)

The main interactive page is a single-page app built with ~3200 lines of vanilla JS.

**Key patterns:**
- `init()` — entry point; loads `terms.json` and `collections.json`, builds nav tree
- `parseTime(s)` — `"HH:MM:SS.FF"` → seconds (float)
- `formatSpeaker(name)` — `"JUSTICE THOMAS"` → `"J. Thomas"`, `"GENERAL X"` → `"Gen. X"`
- `renderTurnText(el, rawText, query, isCurrent)` — renders transcript with `[ref]` marks and search highlights
- `seekAndPlay(time)` — seek audio to time and resume playback
- `findCurrentTurn(t)` — binary search over `turnTimes[]` to find active turn

**State globals:** `turns[]`, `turnTimes[]`, `activeTurnIdx`, `TERMS[]`, `COLLECTIONS[]`, `caseSpeakers[]`

## CSS Layout

`argument.css` drives the SPA layout:
- `#topbar` — 44px dark nav bar (`background: #1a1a2e`)
- `#browser` — flex-row: 30% sidebar (term/case tree) + 70% main panel
- `.turn` — transcript turn blocks; `.ref-mark`, `.search-match`, `.search-match.current` for highlights
- `#search-overlay` — modal search dialog
- Responsive breakpoint at `768px`

## Pitfalls

- **Never edit `_site/`** — it's Jekyll build output, overwritten on every build.
- **`_config.yml` excludes `scripts/` and `sources/`** — changes there won't affect the built site.
- **`data/` is Jekyll's data dir** — files in `data/courts/ussc/` are accessible as `site.data.courts.ussc.*` in templates.
- **Old vs. new transcript format** — some older transcript files are bare arrays; `import_cases.py` migrates them to the envelope format. Always use envelope format for new files.
- **Audio timing uses frames** — `HH:MM:SS.FF` where `.FF` is frame number treated as decimal; `parseTime()` handles this correctly.
- **`courts/ussc/index.html` is the SPA entry point**, not `index.md` — it uses `layout: argument`.

## Related Docs

- [scripts/README.md](../scripts/README.md) — detailed script usage and step-by-step descriptions
- [scripts/old/README.md](../scripts/old/README.md) — archive of superseded scripts
