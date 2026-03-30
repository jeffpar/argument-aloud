#!/usr/bin/env python3
"""Fetch oral argument listings from supremecourt.gov, update cases.json, and
generate missing transcript JSON files from the PDF transcripts.

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

Requires pdftotext (poppler-utils) to be installed.
"""

import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path


CASE_RE  = re.compile(r'^(\d+-\d+)\s+(.+)$')
DATE_RE  = re.compile(r'^(\d{2})/(\d{2})/(\d{2})$')

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_URL  = 'https://www.supremecourt.gov'


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def fetch_html(url: str) -> str:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode('utf-8', errors='replace')


def download_file(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())


# ── Date conversion ───────────────────────────────────────────────────────────

def parse_date(date_str: str) -> str | None:
    """Convert MM/DD/YY to YYYY-MM-DD (assumes 2000s)."""
    m = DATE_RE.match(date_str.strip())
    if not m:
        return None
    month, day, year2 = m.group(1), m.group(2), m.group(3)
    return f'20{year2}-{month}-{day}'


# ── Transcript extraction ────────────────────────────────────────────────────

SKIP_PATTERNS = [
    re.compile(r'^ORAL (?:ARGUMENT|REBUTTAL) OF\b'),
    re.compile(r'^ON BEHALF OF\b'),
    re.compile(r'^FOR THE UNITED\b'),
    re.compile(r'^REBUTTAL ARGUMENT OF\b'),
    re.compile(r'^P R O C E E D I N G S$'),
    re.compile(r'^C O N T E N T S$'),
    re.compile(r'^APPEARANCES:?$'),
    re.compile(r'^\(.*\)$'),
    re.compile(r'^[\s\-]+$'),
]

TERMINATOR_PATTERNS = [
    re.compile(r'^\(Whereupon\b'),
    re.compile(r'\[\d+\]\s+\d+:\d+'),
]

CONTENT_LINE_RE = re.compile(r'^\s{0,3}(\d{1,2})\s{2,}(.+)')

SPEAKER_RE = re.compile(
    r'^((?:CHIEF JUSTICE|JUSTICE|MR\.|MS\.|MRS\.|GENERAL|GEN\.)'
    r'\s+[A-Z][A-Z\.]+(?:\s+[A-Z][A-Z\.]+)*):\s*(.*)',
    re.DOTALL,
)


def extract_transcript_pdf(pdf_path: Path, output_path: Path) -> list:
    """Run pdftotext on pdf_path, parse speaker turns, write output_path as JSON."""
    result = subprocess.run(
        ['pdftotext', '-layout', str(pdf_path), '-'],
        capture_output=True, text=True, check=True,
    )

    tokens = []

    for line in result.stdout.split('\n'):
        m = CONTENT_LINE_RE.match(line)
        if not m:
            continue
        content = m.group(2).strip()
        if not content:
            continue
        if any(pat.search(content) for pat in TERMINATOR_PATTERNS):
            break
        if any(pat.match(content) for pat in SKIP_PATTERNS):
            continue
        sm = SPEAKER_RE.match(content)
        if sm:
            tokens.append(('SPEAKER', sm.group(1).strip(), sm.group(2).strip()))
        else:
            tokens.append(('TEXT', content))

    turns = []
    current_speaker = None
    current_parts   = []

    for token in tokens:
        if token[0] == 'SPEAKER':
            if current_speaker is not None:
                text = re.sub(r'\s+', ' ', ' '.join(current_parts)).strip()
                if text:
                    turns.append({'name': current_speaker, 'text': text})
            current_speaker = token[1]
            current_parts   = [token[2]] if token[2] else []
        else:
            if current_speaker is not None:
                current_parts.append(token[1])

    if current_speaker is not None:
        text = re.sub(r'\s+', ' ', ' '.join(current_parts)).strip()
        if text:
            turns.append({'name': current_speaker, 'text': text})

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(turns, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )
    return turns


# ── Listing page parser ───────────────────────────────────────────────────────

class ListingParser(HTMLParser):
    """Parse the argument_audio listing page into a list of case dicts.

    Each dict has: number, title, date (ISO).
    Only rows with a docket-number cell AND a parseable date cell are kept.
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._td_depth  = 0
        self._td_buf    = []
        self._row_cells = []   # accumulated text values for current <tr>
        self.cases      = []

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self._row_cells = []
        elif tag == 'td':
            if self._td_depth == 0:
                self._td_buf = []
            self._td_depth += 1

    def handle_endtag(self, tag):
        if tag == 'td' and self._td_depth > 0:
            self._td_depth -= 1
            if self._td_depth == 0:
                text = ' '.join(''.join(self._td_buf).split())
                self._row_cells.append(text)
        elif tag == 'tr':
            if len(self._row_cells) == 2:
                case_text, date_text = self._row_cells
                m        = CASE_RE.match(case_text)
                date_iso = parse_date(date_text)
                if m and date_iso:
                    self.cases.append({
                        'number': m.group(1),
                        'title':  m.group(2).strip(),
                        'date':   date_iso,
                    })

    def handle_data(self, data):
        if self._td_depth > 0:
            self._td_buf.append(data)


# ── Detail page parser ────────────────────────────────────────────────────────

class DetailParser(HTMLParser):
    """Parse a case detail page and extract the MP3 and PDF transcript URLs."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.mp3_url = None
        self.pdf_url = None

    def handle_starttag(self, tag, attrs):
        if tag != 'a':
            return
        href = dict(attrs).get('href', '')
        if not href:
            return
        lower = href.lower()
        if self.mp3_url is None and 'mp3files' in lower and lower.endswith('.mp3'):
            self.mp3_url = href if href.startswith('http') else BASE_URL + href
        elif self.pdf_url is None and '/oral_arguments/argument_transcripts/' in lower and lower.endswith('.pdf'):
            self.pdf_url = href if href.startswith('http') else BASE_URL + href


# ── Scrape listing page ───────────────────────────────────────────────────────

def fetch_cases_from_url(url: str) -> list[dict]:
    """Return a list of {number, title, date} dicts scraped from the listing page."""
    print(f'Fetching {url} ...')
    html   = fetch_html(url)
    parser = ListingParser()
    parser.feed(html)
    return parser.cases


# ── Scrape case detail page ───────────────────────────────────────────────────

def fetch_argument_urls(year: str, number: str) -> dict:
    """Fetch the case detail page and return audio_href / transcript_href if found."""
    detail_url = f'{BASE_URL}/oral_arguments/audio/{year}/{number}'
    try:
        html   = fetch_html(detail_url)
        parser = DetailParser()
        parser.feed(html)
    except Exception as exc:
        print(f'    Warning: could not fetch detail page for {number}: {exc}')
        return {}

    result = {}
    if parser.mp3_url:
        result['audio_href'] = parser.mp3_url
    if parser.pdf_url:
        result['transcript_href'] = parser.pdf_url
    return result


# ── Update cases.json ─────────────────────────────────────────────────────────

def update_cases_json(cases_path: Path, new_cases: list[dict], year: str) -> None:
    if cases_path.exists():
        existing = json.loads(cases_path.read_text(encoding='utf-8'))
    else:
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        existing = []

    existing_numbers = {c['number'] for c in existing}

    added = []
    for case in new_cases:
        if case['number'] in existing_numbers:
            continue

        print(f'  Adding {case["number"]} ({case["date"]}) ...', end=' ', flush=True)
        arg_urls = fetch_argument_urls(year, case['number'])
        time.sleep(0.3)   # be polite

        argument = {'date': case['date']}
        argument.update(arg_urls)

        if arg_urls:
            status = 'audio+transcript' if 'transcript_href' in arg_urls else 'audio only'
        else:
            status = 'no media URLs found'
        print(status)

        existing.append({
            'title':     case['title'],
            'number':    case['number'],
            'arguments': [argument],
        })
        added.append(case['number'])

    if added:
        cases_path.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print(f'\nAdded {len(added)} case(s) to {cases_path}.')
    else:
        print(f'No new cases to add to {cases_path}')


# ── Step 3: Generate missing transcripts ─────────────────────────────────────

def generate_missing_transcripts(cases_path: Path) -> None:
    """For each argument with a transcript_href and no YYYY-MM-DD.json yet,
    download the PDF, extract turns, write the JSON, and update text_href."""
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    modified = False

    for case in existing:
        for arg in case.get('arguments', []):
            pdf_url = arg.get('transcript_href')
            date    = arg.get('date')
            if not pdf_url or not date:
                continue

            case_dir       = cases_path.parent / case['number']
            transcript_out = case_dir / f'{date}.json'

            if transcript_out.exists():
                continue

            print(f'  Extracting {case["number"]} ({date}) ...', end=' ', flush=True)

            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
                    tmp_path = Path(tmp.name)

                download_file(pdf_url, tmp_path)
                turns = extract_transcript_pdf(tmp_path, transcript_out)
                print(f'{len(turns)} turns -> {transcript_out.relative_to(REPO_ROOT)}')

                if not arg.get('text_href'):
                    arg['text_href'] = f'{date}.json'
                    modified = True

                time.sleep(0.3)
            except subprocess.CalledProcessError as exc:
                print(f'ERROR (pdftotext): {exc.stderr.strip()}')
            except Exception as exc:
                print(f'ERROR: {exc}')
            finally:
                if tmp_path and tmp_path.exists():
                    tmp_path.unlink()

    if modified:
        cases_path.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('Updated cases.json with new text_href entries.')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    url = sys.argv[1].rstrip('/')

    year_str = url.split('/')[-1]
    if not re.fullmatch(r'\d{4}', year_str):
        print(f'Error: expected a 4-digit year at the end of the URL, got {year_str!r}')
        sys.exit(1)

    term       = f'{year_str}-10'
    cases_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term / 'cases.json'

    scraped = fetch_cases_from_url(url)
    if not scraped:
        print('No cases found on the page. Check the URL or page structure.')
        sys.exit(1)

    print(f'Found {len(scraped)} case(s) on page.\n')
    update_cases_json(cases_path, scraped, year_str)

    # Step 3: generate missing transcript JSON files
    print()
    print('Checking for missing transcripts ...')
    generate_missing_transcripts(cases_path)


if __name__ == '__main__':
    main()
