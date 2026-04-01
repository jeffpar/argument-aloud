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

- [Importing Cases](#importing-cases)
- [Aligning Transcripts](#aligning-transcripts)
- [Validating Cases](#validating-cases)

### Importing Cases

[import_cases](import_cases.py) has the following usage:

```
Fetches oral argument listings from supremecourt.gov for an entire term,
producing a cases.json, and generating transcript JSON files from the PDF
transcripts.

Usage:
    python3 scripts/import_cases.py TERM

Examples:
    python3 scripts/import_cases.py 2025-10
    python3 scripts/import_cases.py 2024-10

The term must be in YYYY-10 format. The corresponding supremecourt.gov listing
page (https://www.supremecourt.gov/oral_arguments/argument_audio/YYYY) is
fetched automatically.

Output:
    courts/ussc/terms/YYYY-10/cases.json

Steps performed:
  1. Scrape the listing page for all case numbers, titles, and argument dates.
  2. For each case not already in cases.json, fetch its detail page to get the
     audio (MP3) and transcript (PDF) URLs, then append it to cases.json.
  3. For every case in cases.json whose argument has a transcript_href but no
     YYYY-MM-DD.json file yet in courts/ussc/terms/TERM/NUMBER/, download the
     PDF, extract speaker turns with pdftotext, and write the JSON file in the
     new transcript-envelope format (see below).
     If text_href was absent it is also added to the argument entry in cases.json.
  3b.Migrate any existing transcript JSON files that are in the old bare-array
     format to the new envelope format:
       {
         "media": { "url": "<audio_href>", "speakers": [{"name": "…"}, …] },
         "turns": [ … ]
       }
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
    python3 scripts/validate_cases.py TERM [CASE] [--checkurls]

Examples:
    python3 scripts/validate_cases.py 2025-10 24-1260
    python3 scripts/validate_cases.py 2025-10
    python3 scripts/validate_cases.py 2025-10 --checkurls
    python3 scripts/validate_cases.py 2025-10 24-1260 --checkurls

For each case's files.json:
  1. Checks supremecourt.gov for a slip opinion matching the case's docket number;
     if found and not already recorded, adds it to files.json as type "opinion".
  2. With --checkurls: also verifies that every href URL is reachable (HTTP HEAD
     request with GET fallback) and checks whether it can be embedded in an iframe
     by inspecting Content-Security-Policy and X-Frame-Options response headers.
     If framing is blocked, the file is downloaded locally, the original URL is saved
     as "source", and "href" is updated to the local path.
```

### Sample Runs

```
python3 scripts/import_cases.py 2023-10
Fetching https://www.supremecourt.gov/oral_arguments/argument_audio/2023 ...
Found 60 case(s) on page.

  Adding 23-108 (2024-04-15) ... audio+transcript
  Adding 23-50 (2024-04-15) ... audio+transcript
  Adding 23-5572 (2024-04-16) ... audio+transcript
  Adding 22-982 (2024-04-17) ... audio+transcript
  Adding 23-175 (2024-04-22) ... audio+transcript
  Adding 22-1218 (2024-04-22) ... audio+transcript
  Adding 23-334 (2024-04-23) ... audio+transcript
  Adding 23-367 (2024-04-23) ... audio+transcript
  Adding 23-726 (2024-04-24) ... audio+transcript
  Adding 23-939 (2024-04-25) ... audio+transcript
  Adding 23-411 (2024-03-18) ... audio+transcript
  Adding 22-842 (2024-03-18) ... audio+transcript
  Adding 23-14 (2024-03-19) ... audio+transcript
  Adding 22-1079 (2024-03-19) ... audio+transcript
  Adding 22-1025 (2024-03-20) ... audio+transcript
  Adding 23-250 (2024-03-25) ... audio+transcript
  Adding 23-21 (2024-03-25) ... audio+transcript
  Adding 23-235 (2024-03-26) ... audio+transcript
  Adding 23-370 (2024-03-27) ... audio+transcript
  Adding 23-146 (2024-03-27) ... audio+transcript
  Adding 23-719 (2024-02-08) ... audio+transcript
  Adding 22-1008 (2024-02-20) ... audio+transcript
  Adding 23-51 (2024-02-20) ... audio+transcript
  Adding 23A349 (2024-02-21) ... audio+transcript
  Adding 22-1078 (2024-02-21) ... audio+transcript
  Adding 22-277 (2024-02-26) ... audio+transcript
  Adding 22-555 (2024-02-26) ... audio+transcript
  Adding 22-7386 (2024-02-27) ... audio+transcript
  Adding 22-529 (2024-02-27) ... audio+transcript
  Adding 22-976 (2024-02-28) ... audio+transcript
  Adding 23-3 (2024-02-28) ... audio+transcript
  Adding 22-674 (2024-01-08) ... audio+transcript
  Adding 22-1178 (2024-01-08) ... audio+transcript
  Adding 22-1074 (2024-01-09) ... audio+transcript
  Adding 22-1238 (2024-01-09) ... audio+transcript
  Adding 22-899 (2024-01-10) ... audio+transcript
  Adding 22-1165 (2024-01-16) ... audio+transcript
  Adding 22-913 (2024-01-16) ... audio+transcript
  Adding 22-451 (2024-01-17) ... audio+transcript
  Adding 22-1219 (2024-01-17) ... audio+transcript
  Adding 22-6389 (2023-11-27) ... audio+transcript
  Adding 22-721 (2023-11-28) ... audio+transcript
  Adding 22-666 (2023-11-28) ... audio+transcript
  Adding 22-859 (2023-11-29) ... audio+transcript
  Adding 23-124 (2023-12-04) ... audio+transcript
  Adding 22-800 (2023-12-05) ... audio+transcript
  Adding 22-193 (2023-12-06) ... audio+transcript
  Adding 22-585 (2023-10-30) ... audio+transcript
  Adding 22-324 (2023-10-31) ... audio+transcript
  Adding 22-611 (2023-10-31) ... audio+transcript
  Adding 22-704 (2023-11-01) ... audio+transcript
  Adding 22-846 (2023-11-06) ... audio+transcript
  Adding 22-915 (2023-11-07) ... audio+transcript
  Adding 22-888 (2023-11-08) ... audio+transcript
  Adding 22-340 (2023-10-02) ... audio+transcript
  Adding 22-448 (2023-10-03) ... audio+transcript
  Adding 22-429 (2023-10-04) ... audio+transcript
  Adding 22-660 (2023-10-10) ... audio+transcript
  Adding 22-500 (2023-10-10) ... audio+transcript
  Adding 22-807 (2023-10-11) ... audio+transcript

Added 60 case(s) to /Users/jeff/Sites/argument-aloud/courts/ussc/terms/2023-10/cases.json.

Checking for missing transcripts ...
  Extracting 23-108 (2024-04-15) ... 619 turns -> courts/ussc/terms/2023-10/23-108/2024-04-15.json
  Extracting 23-50 (2024-04-15) ... 263 turns -> courts/ussc/terms/2023-10/23-50/2024-04-15.json
  Extracting 23-5572 (2024-04-16) ... 375 turns -> courts/ussc/terms/2023-10/23-5572/2024-04-16.json
  Extracting 22-982 (2024-04-17) ... 285 turns -> courts/ussc/terms/2023-10/22-982/2024-04-17.json
  Extracting 23-175 (2024-04-22) ... 853 turns -> courts/ussc/terms/2023-10/23-175/2024-04-22.json
  Extracting 22-1218 (2024-04-22) ... 102 turns -> courts/ussc/terms/2023-10/22-1218/2024-04-22.json
  Extracting 23-334 (2024-04-23) ... 436 turns -> courts/ussc/terms/2023-10/23-334/2024-04-23.json
  Extracting 23-367 (2024-04-23) ... 284 turns -> courts/ussc/terms/2023-10/23-367/2024-04-23.json
  Extracting 23-726 (2024-04-24) ... 532 turns -> courts/ussc/terms/2023-10/23-726/2024-04-24.json
  Extracting 23-939 (2024-04-25) ... 788 turns -> courts/ussc/terms/2023-10/23-939/2024-04-25.json
  Extracting 23-411 (2024-03-18) ... 344 turns -> courts/ussc/terms/2023-10/23-411/2024-03-18.json
  Extracting 22-842 (2024-03-18) ... 237 turns -> courts/ussc/terms/2023-10/22-842/2024-03-18.json
  Extracting 23-14 (2024-03-19) ... 464 turns -> courts/ussc/terms/2023-10/23-14/2024-03-19.json
  Extracting 22-1079 (2024-03-19) ... 362 turns -> courts/ussc/terms/2023-10/22-1079/2024-03-19.json
  Extracting 22-1025 (2024-03-20) ... 353 turns -> courts/ussc/terms/2023-10/22-1025/2024-03-20.json
  Extracting 23-250 (2024-03-25) ... 482 turns -> courts/ussc/terms/2023-10/23-250/2024-03-25.json
  Extracting 23-21 (2024-03-25) ... 167 turns -> courts/ussc/terms/2023-10/23-21/2024-03-25.json
  Extracting 23-235 (2024-03-26) ... 329 turns -> courts/ussc/terms/2023-10/23-235/2024-03-26.json
  Extracting 23-370 (2024-03-27) ... 364 turns -> courts/ussc/terms/2023-10/23-370/2024-03-27.json
  Extracting 23-146 (2024-03-27) ... 150 turns -> courts/ussc/terms/2023-10/23-146/2024-03-27.json
  Extracting 23-719 (2024-02-08) ... 710 turns -> courts/ussc/terms/2023-10/23-719/2024-02-08.json
  Extracting 22-1008 (2024-02-20) ... 306 turns -> courts/ussc/terms/2023-10/22-1008/2024-02-20.json
  Extracting 23-51 (2024-02-20) ... 202 turns -> courts/ussc/terms/2023-10/23-51/2024-02-20.json
  Extracting 23A349 (2024-02-21) ... 371 turns -> courts/ussc/terms/2023-10/23A349/2024-02-21.json
  Extracting 22-1078 (2024-02-21) ... 184 turns -> courts/ussc/terms/2023-10/22-1078/2024-02-21.json
  Extracting 22-277 (2024-02-26) ... 501 turns -> courts/ussc/terms/2023-10/22-277/2024-02-26.json
  Extracting 22-555 (2024-02-26) ... 265 turns -> courts/ussc/terms/2023-10/22-555/2024-02-26.json
  Extracting 22-7386 (2024-02-27) ... 131 turns -> courts/ussc/terms/2023-10/22-7386/2024-02-27.json
  Extracting 22-529 (2024-02-27) ... 462 turns -> courts/ussc/terms/2023-10/22-529/2024-02-27.json
  Extracting 22-976 (2024-02-28) ... 554 turns -> courts/ussc/terms/2023-10/22-976/2024-02-28.json
  Extracting 23-3 (2024-02-28) ... 181 turns -> courts/ussc/terms/2023-10/23-3/2024-02-28.json
  Extracting 22-674 (2024-01-08) ... 337 turns -> courts/ussc/terms/2023-10/22-674/2024-01-08.json
  Extracting 22-1178 (2024-01-08) ... 281 turns -> courts/ussc/terms/2023-10/22-1178/2024-01-08.json
  Extracting 22-1074 (2024-01-09) ... 294 turns -> courts/ussc/terms/2023-10/22-1074/2024-01-09.json
  Extracting 22-1238 (2024-01-09) ... 198 turns -> courts/ussc/terms/2023-10/22-1238/2024-01-09.json
  Extracting 22-899 (2024-01-10) ... 377 turns -> courts/ussc/terms/2023-10/22-899/2024-01-10.json
  Extracting 22-1165 (2024-01-16) ... 198 turns -> courts/ussc/terms/2023-10/22-1165/2024-01-16.json
  Extracting 22-913 (2024-01-16) ... 371 turns -> courts/ussc/terms/2023-10/22-913/2024-01-16.json
  Extracting 22-451 (2024-01-17) ... 210 turns -> courts/ussc/terms/2023-10/22-451/2024-01-17.json
  Extracting 22-1219 (2024-01-17) ... 553 turns -> courts/ussc/terms/2023-10/22-1219/2024-01-17.json
  Extracting 22-6389 (2023-11-27) ... 377 turns -> courts/ussc/terms/2023-10/22-6389/2023-11-27.json
  Extracting 22-721 (2023-11-28) ... 281 turns -> courts/ussc/terms/2023-10/22-721/2023-11-28.json
  Extracting 22-666 (2023-11-28) ... 391 turns -> courts/ussc/terms/2023-10/22-666/2023-11-28.json
  Extracting 22-859 (2023-11-29) ... 533 turns -> courts/ussc/terms/2023-10/22-859/2023-11-29.json
  Extracting 23-124 (2023-12-04) ... 505 turns -> courts/ussc/terms/2023-10/23-124/2023-12-04.json
  Extracting 22-800 (2023-12-05) ... 506 turns -> courts/ussc/terms/2023-10/22-800/2023-12-05.json
  Extracting 22-193 (2023-12-06) ... 433 turns -> courts/ussc/terms/2023-10/22-193/2023-12-06.json
  Extracting 22-585 (2023-10-30) ... 318 turns -> courts/ussc/terms/2023-10/22-585/2023-10-30.json
  Extracting 22-324 (2023-10-31) ... 515 turns -> courts/ussc/terms/2023-10/22-324/2023-10-31.json
  Extracting 22-611 (2023-10-31) ... 287 turns -> courts/ussc/terms/2023-10/22-611/2023-10-31.json
  Extracting 22-704 (2023-11-01) ... 226 turns -> courts/ussc/terms/2023-10/22-704/2023-11-01.json
  Extracting 22-846 (2023-11-06) ... 405 turns -> courts/ussc/terms/2023-10/22-846/2023-11-06.json
  Extracting 22-915 (2023-11-07) ... 301 turns -> courts/ussc/terms/2023-10/22-915/2023-11-07.json
  Extracting 22-888 (2023-11-08) ... 376 turns -> courts/ussc/terms/2023-10/22-888/2023-11-08.json
  Extracting 22-340 (2023-10-02) ... 463 turns -> courts/ussc/terms/2023-10/22-340/2023-10-02.json
  Extracting 22-448 (2023-10-03) ... 411 turns -> courts/ussc/terms/2023-10/22-448/2023-10-03.json
  Extracting 22-429 (2023-10-04) ... 421 turns -> courts/ussc/terms/2023-10/22-429/2023-10-04.json
  Extracting 22-660 (2023-10-10) ... 417 turns -> courts/ussc/terms/2023-10/22-660/2023-10-10.json
  Extracting 22-500 (2023-10-10) ... 233 turns -> courts/ussc/terms/2023-10/22-500/2023-10-10.json
  Extracting 22-807 (2023-10-11) ... 509 turns -> courts/ussc/terms/2023-10/22-807/2023-10-11.json
Updated cases.json with new text_href entries.

Migrating old-format transcripts ...
  All transcripts already in new format.

Fetching docket info for cases without questions_href ...
  Fetching docket for 23-108 ... questions_href, 22 filings -> files.json
  Fetching docket for 23-50 ... questions_href, 22 filings -> files.json
  Fetching docket for 23-5572 ... questions_href, 22 filings -> files.json
  Fetching docket for 22-982 ... questions_href, 18 filings -> files.json
  Fetching docket for 23-175 ... questions_href, 120 filings -> files.json
  Fetching docket for 22-1218 ... questions_href, 14 filings -> files.json
  Fetching docket for 23-334 ... questions_href, 24 filings -> files.json
  Fetching docket for 23-367 ... questions_href, 25 filings -> files.json
  Fetching docket for 23-726 ... questions_href, 56 filings -> files.json
  Fetching docket for 23-939 ... questions_href, 51 filings -> files.json
  Fetching docket for 23-411 ... questions_href, 68 filings -> files.json
  Fetching docket for 22-842 ... questions_href, 51 filings -> files.json
  Fetching docket for 23-14 ... questions_href, 15 filings -> files.json
  Fetching docket for 22-1079 ... questions_href, 24 filings -> files.json
  Fetching docket for 22-1025 ... questions_href, 37 filings -> files.json
  Fetching docket for 23-250 ... questions_href, 18 filings -> files.json
  Fetching docket for 23-21 ... questions_href, 15 filings -> files.json
  Fetching docket for 23-235 ... questions_href, 110 filings -> files.json
  Fetching docket for 23-370 ... questions_href, 15 filings -> files.json
  Fetching docket for 23-146 ... questions_href, 13 filings -> files.json
  Fetching docket for 23-719 ... questions_href, 94 filings -> files.json
  Fetching docket for 22-1008 ... questions_href, 26 filings -> files.json
  Fetching docket for 23-51 ... questions_href, 23 filings -> files.json
  Fetching docket for 23A349 ... 9 filings -> files.json
  Fetching docket for 22-1078 ... questions_href, 25 filings -> files.json
  Fetching docket for 22-277 ... questions_href, 94 filings -> files.json
  Fetching docket for 22-555 ... questions_href, 94 filings -> files.json
  Fetching docket for 22-7386 ... questions_href, 12 filings -> files.json
  Fetching docket for 22-529 ... questions_href, 26 filings -> files.json
  Fetching docket for 22-976 ... questions_href, 31 filings -> files.json
  Fetching docket for 23-3 ... questions_href, 20 filings -> files.json
  Fetching docket for 22-674 ... questions_href, 15 filings -> files.json
  Fetching docket for 22-1178 ... questions_href, 21 filings -> files.json
  Fetching docket for 22-1074 ... questions_href, 37 filings -> files.json
  Fetching docket for 22-1238 ... questions_href, 14 filings -> files.json
  Fetching docket for 22-899 ... questions_href, 22 filings -> files.json
  Fetching docket for 22-1165 ... questions_href, 26 filings -> files.json
  Fetching docket for 22-913 ... questions_href, 25 filings -> files.json
  Fetching docket for 22-451 ... questions_href, 88 filings -> files.json
  Fetching docket for 22-1219 ... questions_href, 23 filings -> files.json
  Fetching docket for 22-6389 ... questions_href, 21 filings -> files.json
  Fetching docket for 22-721 ... questions_href, 15 filings -> files.json
  Fetching docket for 22-666 ... questions_href, 9 filings -> files.json
  Fetching docket for 22-859 ... questions_href, 50 filings -> files.json
  Fetching docket for 23-124 ... questions_href, 51 filings -> files.json
  Fetching docket for 22-800 ... questions_href, 62 filings -> files.json
  Fetching docket for 22-193 ... questions_href, 30 filings -> files.json
  Fetching docket for 22-585 ... questions_href, 31 filings -> files.json
  Fetching docket for 22-324 ... questions_href, 28 filings -> files.json
  Fetching docket for 22-611 ... questions_href, 23 filings -> files.json
  Fetching docket for 22-704 ... questions_href, 22 filings -> files.json
  Fetching docket for 22-846 ... questions_href, 13 filings -> files.json
  Fetching docket for 22-915 ... questions_href, 83 filings -> files.json
  Fetching docket for 22-888 ... questions_href, 24 filings -> files.json
  Fetching docket for 22-340 ... questions_href, 17 filings -> files.json
  Fetching docket for 22-448 ... questions_href, 45 filings -> files.json
  Fetching docket for 22-429 ... questions_href, 39 filings -> files.json
  Fetching docket for 22-660 ... questions_href, 26 filings -> files.json
  Fetching docket for 22-500 ... questions_href, 17 filings -> files.json
  Fetching docket for 22-807 ... questions_href, 29 filings -> files.json
Updated cases.json with questions_href entries.

Cleaning up files.json entries ...
  Cleaned courts/ussc/terms/2023-10/22-1008/files.json
  Cleaned courts/ussc/terms/2023-10/22-1025/files.json
  Cleaned courts/ussc/terms/2023-10/22-1074/files.json
  Cleaned courts/ussc/terms/2023-10/22-1078/files.json
  Cleaned courts/ussc/terms/2023-10/22-1079/files.json
  Cleaned courts/ussc/terms/2023-10/22-1165/files.json
  Cleaned courts/ussc/terms/2023-10/22-1178/files.json
  Cleaned courts/ussc/terms/2023-10/22-1218/files.json
  Cleaned courts/ussc/terms/2023-10/22-1219/files.json
  Cleaned courts/ussc/terms/2023-10/22-1238/files.json
  Cleaned courts/ussc/terms/2023-10/22-193/files.json
  Cleaned courts/ussc/terms/2023-10/22-277/files.json
  Cleaned courts/ussc/terms/2023-10/22-324/files.json
  Cleaned courts/ussc/terms/2023-10/22-340/files.json
  Cleaned courts/ussc/terms/2023-10/22-429/files.json
  Cleaned courts/ussc/terms/2023-10/22-448/files.json
  Cleaned courts/ussc/terms/2023-10/22-451/files.json
  Cleaned courts/ussc/terms/2023-10/22-500/files.json
  Cleaned courts/ussc/terms/2023-10/22-529/files.json
  Cleaned courts/ussc/terms/2023-10/22-555/files.json
  Cleaned courts/ussc/terms/2023-10/22-585/files.json
  Cleaned courts/ussc/terms/2023-10/22-611/files.json
  Cleaned courts/ussc/terms/2023-10/22-6389/files.json
  Cleaned courts/ussc/terms/2023-10/22-660/files.json
  Cleaned courts/ussc/terms/2023-10/22-666/files.json
  Cleaned courts/ussc/terms/2023-10/22-674/files.json
  Cleaned courts/ussc/terms/2023-10/22-704/files.json
  Cleaned courts/ussc/terms/2023-10/22-721/files.json
  Cleaned courts/ussc/terms/2023-10/22-7386/files.json
  Cleaned courts/ussc/terms/2023-10/22-800/files.json
  Cleaned courts/ussc/terms/2023-10/22-807/files.json
  Cleaned courts/ussc/terms/2023-10/22-842/files.json
  Cleaned courts/ussc/terms/2023-10/22-846/files.json
  Cleaned courts/ussc/terms/2023-10/22-859/files.json
  Cleaned courts/ussc/terms/2023-10/22-888/files.json
  Cleaned courts/ussc/terms/2023-10/22-899/files.json
  Cleaned courts/ussc/terms/2023-10/22-913/files.json
  Cleaned courts/ussc/terms/2023-10/22-915/files.json
  Cleaned courts/ussc/terms/2023-10/22-976/files.json
  Cleaned courts/ussc/terms/2023-10/22-982/files.json
  Cleaned courts/ussc/terms/2023-10/23-108/files.json
  Cleaned courts/ussc/terms/2023-10/23-124/files.json
  Cleaned courts/ussc/terms/2023-10/23-14/files.json
  Cleaned courts/ussc/terms/2023-10/23-146/files.json
  Cleaned courts/ussc/terms/2023-10/23-175/files.json
  Cleaned courts/ussc/terms/2023-10/23-21/files.json
  Cleaned courts/ussc/terms/2023-10/23-235/files.json
  Cleaned courts/ussc/terms/2023-10/23-250/files.json
  Cleaned courts/ussc/terms/2023-10/23-3/files.json
  Cleaned courts/ussc/terms/2023-10/23-334/files.json
  Cleaned courts/ussc/terms/2023-10/23-367/files.json
  Cleaned courts/ussc/terms/2023-10/23-370/files.json
  Cleaned courts/ussc/terms/2023-10/23-411/files.json
  Cleaned courts/ussc/terms/2023-10/23-50/files.json
  Cleaned courts/ussc/terms/2023-10/23-51/files.json
  Cleaned courts/ussc/terms/2023-10/23-5572/files.json
  Cleaned courts/ussc/terms/2023-10/23-719/files.json
  Cleaned courts/ussc/terms/2023-10/23-726/files.json
  Cleaned courts/ussc/terms/2023-10/23-939/files.json
  Cleaned courts/ussc/terms/2023-10/23A349/files.json

Adding transcript entries to files.json ...
  Added transcript entries to 60 files.json file(s).

Extracting questions presented ...
  Extracting questions for 23-108 ... 564 chars
  Extracting questions for 23-50 ... 822 chars
  Extracting questions for 23-5572 ... 236 chars
  Extracting questions for 22-982 ... 904 chars
  Extracting questions for 23-175 ... 973 chars
  Extracting questions for 22-1218 ... 1470 chars
  Extracting questions for 23-334 ... 1255 chars
  Extracting questions for 23-367 ... 721 chars
  Extracting questions for 23-726 ... 116 chars
  Extracting questions for 23-939 ... 359 chars
  Extracting questions for 23-411 ... 1000 chars
  Extracting questions for 22-842 ... 1704 chars
  Extracting questions for 23-14 ... 685 chars
  Extracting questions for 22-1079 ... 1364 chars
  Extracting questions for 22-1025 ... 1443 chars
  Extracting questions for 23-250 ... 1333 chars
  Extracting questions for 23-21 ... 707 chars
  Extracting questions for 23-235 ... 870 chars
  Extracting questions for 23-370 ... 292 chars
  Extracting questions for 23-146 ... 650 chars
  Extracting questions for 23-719 ... 729 chars
  Extracting questions for 22-1008 ... 1546 chars
  Extracting questions for 23-51 ... 826 chars
  Extracting questions for 22-1078 ... 526 chars
  Extracting questions for 22-277 ... 875 chars
  Extracting questions for 22-555 ... 2043 chars
  Extracting questions for 22-7386 ... 2214 chars
  Extracting questions for 22-529 ... 462 chars
  Extracting questions for 22-976 ... 1543 chars
  Extracting questions for 23-3 ... 230 chars
  Extracting questions for 22-674 ... 1340 chars
  Extracting questions for 22-1178 ... 787 chars
  Extracting questions for 22-1074 ... 1507 chars
  Extracting questions for 22-1238 ... 1299 chars
  Extracting questions for 22-899 ... 467 chars
  Extracting questions for 22-1165 ... 1162 chars
  Extracting questions for 22-913 ... 935 chars
  Extracting questions for 22-451 ... 1989 chars
  Extracting questions for 22-1219 ... 2006 chars
  Extracting questions for 22-6389 ... 1313 chars
  Extracting questions for 22-721 ... 519 chars
  Extracting questions for 22-666 ... 1293 chars
  Extracting questions for 22-859 ... 587 chars
  Extracting questions for 23-124 ... 254 chars
  Extracting questions for 22-800 ... 1054 chars
  Extracting questions for 22-193 ... 1113 chars
  Extracting questions for 22-585 ... 577 chars
  Extracting questions for 22-324 ... 339 chars
  Extracting questions for 22-611 ... 766 chars
  Extracting questions for 22-704 ... 473 chars
  Extracting questions for 22-846 ... 179 chars
  Extracting questions for 22-915 ... 174 chars
  Extracting questions for 22-888 ... 400 chars
  Extracting questions for 22-340 ... 1523 chars
  Extracting questions for 22-448 ... 308 chars
  Extracting questions for 22-429 ... 287 chars
  Extracting questions for 22-660 ... 1180 chars
  Extracting questions for 22-500 ... 418 chars
  Extracting questions for 22-807 ... 2290 chars
Updated cases.json with questions.
```

```
python3 scripts/import_oyez.py 2023-10
Fetching Oyez case list for 2023 term ...
  62 case(s) from Oyez
  60 case(s) in local cases.json
  In both: 60
  Oyez only (2): 22-425, 22O141

  22-1008 (2024-02-20) ... 303 turns -> courts/ussc/terms/2023-10/22-1008/2024-02-20-oyez.json
  22-1025 (2024-03-20) ... 349 turns -> courts/ussc/terms/2023-10/22-1025/2024-03-20-oyez.json
  22-1074 (2024-01-09) ... 339 turns -> courts/ussc/terms/2023-10/22-1074/2024-01-09-oyez.json
  22-1078 (2024-02-21) ... 181 turns -> courts/ussc/terms/2023-10/22-1078/2024-02-21-oyez.json
  22-1079 (2024-03-19) ... 353 turns -> courts/ussc/terms/2023-10/22-1079/2024-03-19-oyez.json
  22-1165 (2024-01-16) ... 237 turns -> courts/ussc/terms/2023-10/22-1165/2024-01-16-oyez.json
  22-1178 (2024-01-08) ... 279 turns -> courts/ussc/terms/2023-10/22-1178/2024-01-08-oyez.json
  22-1218 (2024-04-22) ... 102 turns -> courts/ussc/terms/2023-10/22-1218/2024-04-22-oyez.json
  22-1219 (2024-01-17) ... 541 turns -> courts/ussc/terms/2023-10/22-1219/2024-01-17-oyez.json
  22-1238 (2024-01-09) ... 198 turns -> courts/ussc/terms/2023-10/22-1238/2024-01-09-oyez.json
  22-193 (2023-12-06) ... 431 turns -> courts/ussc/terms/2023-10/22-193/2023-12-06-oyez.json
  22-277 (2024-02-26) ... 499 turns -> courts/ussc/terms/2023-10/22-277/2024-02-26-oyez.json
  22-324 (2023-10-31) ... 513 turns -> courts/ussc/terms/2023-10/22-324/2023-10-31-oyez.json
  22-340 (2023-10-02) ... 462 turns -> courts/ussc/terms/2023-10/22-340/2023-10-02-oyez.json
  22-429 (2023-10-04) ... 423 turns -> courts/ussc/terms/2023-10/22-429/2023-10-04-oyez.json
  22-448 (2023-10-03) ... 408 turns -> courts/ussc/terms/2023-10/22-448/2023-10-03-oyez.json
  22-451 (2024-01-17) ... 210 turns -> courts/ussc/terms/2023-10/22-451/2024-01-17-oyez.json
  22-500 (2023-10-10) ... 233 turns -> courts/ussc/terms/2023-10/22-500/2023-10-10-oyez.json
  22-529 (2024-02-27) ... 458 turns -> courts/ussc/terms/2023-10/22-529/2024-02-27-oyez.json
  22-555 (2024-02-26) ... 259 turns -> courts/ussc/terms/2023-10/22-555/2024-02-26-oyez.json
  22-585 (2023-10-30) ... 376 turns -> courts/ussc/terms/2023-10/22-585/2023-10-30-oyez.json
  22-611 (2023-10-31) ... 287 turns -> courts/ussc/terms/2023-10/22-611/2023-10-31-oyez.json
  22-6389 (2023-11-27) ... 377 turns -> courts/ussc/terms/2023-10/22-6389/2023-11-27-oyez.json
  22-660 (2023-10-10) ... 414 turns -> courts/ussc/terms/2023-10/22-660/2023-10-10-oyez.json
  22-666 (2023-11-28) ... 387 turns -> courts/ussc/terms/2023-10/22-666/2023-11-28-oyez.json
  22-674 (2024-01-08) ... 437 turns -> courts/ussc/terms/2023-10/22-674/2024-01-08-oyez.json
  22-704 (2023-11-01) ... 225 turns -> courts/ussc/terms/2023-10/22-704/2023-11-01-oyez.json
  22-721 (2023-11-28) ... 277 turns -> courts/ussc/terms/2023-10/22-721/2023-11-28-oyez.json
  22-7386 (2024-02-27) ... 129 turns -> courts/ussc/terms/2023-10/22-7386/2024-02-27-oyez.json
  22-800 (2023-12-05) ... 503 turns -> courts/ussc/terms/2023-10/22-800/2023-12-05-oyez.json
  22-807 (2023-10-11) ... 438 turns -> courts/ussc/terms/2023-10/22-807/2023-10-11-oyez.json
  22-842 (2024-03-18) ... 259 turns -> courts/ussc/terms/2023-10/22-842/2024-03-18-oyez.json
  22-846 (2023-11-06) ... 388 turns -> courts/ussc/terms/2023-10/22-846/2023-11-06-oyez.json
  22-859 (2023-11-29) ... 648 turns -> courts/ussc/terms/2023-10/22-859/2023-11-29-oyez.json
  22-888 (2023-11-08) ... 370 turns -> courts/ussc/terms/2023-10/22-888/2023-11-08-oyez.json
  22-899 (2024-01-10) ... 371 turns -> courts/ussc/terms/2023-10/22-899/2024-01-10-oyez.json
  22-913 (2024-01-16) ... 420 turns -> courts/ussc/terms/2023-10/22-913/2024-01-16-oyez.json
  22-915 (2023-11-07) ... 301 turns -> courts/ussc/terms/2023-10/22-915/2023-11-07-oyez.json
  22-976 (2024-02-28) ... 542 turns -> courts/ussc/terms/2023-10/22-976/2024-02-28-oyez.json
  22-982 (2024-04-17) ... 281 turns -> courts/ussc/terms/2023-10/22-982/2024-04-17-oyez.json
  22O141 (2024-03-20) ... 306 turns -> courts/ussc/terms/2023-10/22O141/2024-03-20-oyez.json
  23-108 (2024-04-15) ... 602 turns -> courts/ussc/terms/2023-10/23-108/2024-04-15-oyez.json
  23-124 (2023-12-04) ... 499 turns -> courts/ussc/terms/2023-10/23-124/2023-12-04-oyez.json
  23-14 (2024-03-19) ... 456 turns -> courts/ussc/terms/2023-10/23-14/2024-03-19-oyez.json
  23-146 (2024-03-27) ... 149 turns -> courts/ussc/terms/2023-10/23-146/2024-03-27-oyez.json
  23-175 (2024-04-22) ... 829 turns -> courts/ussc/terms/2023-10/23-175/2024-04-22-oyez.json
  23-21 (2024-03-25) ... 166 turns -> courts/ussc/terms/2023-10/23-21/2024-03-25-oyez.json
  23-235 (2024-03-26) ... 328 turns -> courts/ussc/terms/2023-10/23-235/2024-03-26-oyez.json
  23-250 (2024-03-25) ... 475 turns -> courts/ussc/terms/2023-10/23-250/2024-03-25-oyez.json
  23-3 (2024-02-28) ... 180 turns -> courts/ussc/terms/2023-10/23-3/2024-02-28-oyez.json
  23-334 (2024-04-23) ... 433 turns -> courts/ussc/terms/2023-10/23-334/2024-04-23-oyez.json
  23-367 (2024-04-23) ... 282 turns -> courts/ussc/terms/2023-10/23-367/2024-04-23-oyez.json
  23-370 (2024-03-27) ... 362 turns -> courts/ussc/terms/2023-10/23-370/2024-03-27-oyez.json
  23-411 (2024-03-18) ... 418 turns -> courts/ussc/terms/2023-10/23-411/2024-03-18-oyez.json
  23-50 (2024-04-15) ... 255 turns -> courts/ussc/terms/2023-10/23-50/2024-04-15-oyez.json
  23-51 (2024-02-20) ... 197 turns -> courts/ussc/terms/2023-10/23-51/2024-02-20-oyez.json
  23-5572 (2024-04-16) ... 372 turns -> courts/ussc/terms/2023-10/23-5572/2024-04-16-oyez.json
  23-719 (2024-02-08) ... 689 turns -> courts/ussc/terms/2023-10/23-719/2024-02-08-oyez.json
  23-726 (2024-04-24) ... 515 turns -> courts/ussc/terms/2023-10/23-726/2024-04-24-oyez.json
  23-939 (2024-04-25) ... 775 turns -> courts/ussc/terms/2023-10/23-939/2024-04-25-oyez.json
  23A349 (2024-02-21) ... 360 turns -> courts/ussc/terms/2023-10/23A349/2024-02-21-oyez.json
Updated courts/ussc/terms/2023-10/cases.json

Done.  Downloaded: 61  |  Already existed: 0  |  Errors: 0
```
