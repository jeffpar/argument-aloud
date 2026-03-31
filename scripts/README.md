## Scripts

The following command-line scripts help us build out the website, creating JSON files
that describe the contents and locations of all the media files for a set of cases, without
actually storing any of those media files ourselves (a burden we don't really want and
can't really afford).  Therefore, whenever possible, all audio files, document files, etc,
are simply referenced from their original locations.

The downside, of course, is that this site will break whenever any of those locations change,
and they almost certainly will, because it is unclear whether even an entity like SCOTUS,
which relies so heavily on legal citations, also appreciates the importance of permanent,
citable *online* links.

Here's what we have so far:

- [Adding/Updating Cases](#addingupdating-cases)
- [Aligning Transcripts](#aligning-transcripts)
- [Validating Cases](#validating-cases)

### Adding/Updating Cases

[import_cases](import_cases.py) has the following usage:

```
Fetches oral argument listings from supremecourt.gov for an entire term,
producing a cases.json, and generating transcript JSON files from the PDF
transcripts.

Usage:
    python3 scripts/import_cases.py https://www.supremecourt.gov/oral_arguments/argument_audio/2025

The year in the URL maps to the October term folder:

    courts/ussc/terms/2025-10/cases.json

Steps performed:
  1. Scrape the listing page for all case numbers, titles, and argument dates.
  2. For each case not already in cases.json, fetch its detail page to get the
     audio (MP3) and transcript (PDF) URLs, then append it to cases.json.
  3. For every case in cases.json whose argument has a transcript_href but no
     YYYY-MM-DD.json file yet in courts/ussc/terms/TERM/NUMBER/, download the
     PDF, extract speaker turns with pdftotext, and write the JSON file.
     If text_href was absent it is also added to the argument entry in cases.json.
  6. For every case in cases.json that has questions_href but no questions property,
     download the PDF, extract the question(s) presented as a plain-text string,
     and save it as questions in cases.json.
  6. For every case in cases.json that has questions_href but no questions property,
     download the PDF, extract the question(s) presented as a plain-text string,
     and save it as questions in cases.json.

Requires pdftotext (poppler-utils) to be installed.
```

### Aligning Transcripts

[align_transcript](align_transcript.py) has the following usage:

```
Aligns SCOTUS oral argument transcript(s) with their audio, adding a
"time" field (hh:mm:ss.nn) to each speaker turn.

Dependencies:
    pip install faster-whisper rapidfuzz
    brew install ffmpeg          # required by faster-whisper for MP3 input

Usage:
    python3 align_transcript.py TERM CASE [--model MODEL] [--purge]

Example:
    python3 align_transcript.py 2025-10 24-1238

The script reads courts/ussc/terms/TERM/cases.json, finds the matching
case, then for each argument that has a transcript (text_href) and audio
(audio_href), downloads the audio to a temporary file and runs alignment.

The Whisper word-level transcription is cached in the case directory as
    <case-dir>/<audio-stem>--whisper-<model>.json
so re-runs skip re-transcription (which can take several minutes).

An argument is skipped when every turn already has a "time" value.
Use --purge to clear all existing timestamps before aligning.
```

### Validating Cases

[validate_cases](validate_cases.py) has the following usage:

```
Validate file entries for SCOTUS cases.

Usage:
    python3 scripts/validate_cases.py TERM [CASE]

Examples:
    python3 scripts/validate_cases.py 2025-10 24-1260
    python3 scripts/validate_cases.py 2025-10

For each file entry in files.json:
  1. Checks that the href URL is reachable (HTTP HEAD request, with GET fallback).
  2. Checks whether the URL can be embedded in an iframe by inspecting
     Content-Security-Policy (frame-ancestors) and X-Frame-Options response headers.
     If framing is blocked, downloads the file to the case directory,
     saves the original URL as "source", and updates "href" to the local filename.
```
