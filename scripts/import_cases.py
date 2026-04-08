#!/usr/bin/env python3
"""Fetches oral argument listings from supremecourt.gov for an entire term,
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
"""

import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

# Import opinion helpers from validate_cases (same scripts/ directory).
sys.path.insert(0, str(Path(__file__).parent))
from validate_cases import _fetch_opinions, check_opinion_for_case, sync_files_count


CASE_RE  = re.compile(r'^(\d+(?:-\d+|-Orig|A\d+))\s+(.+)$', re.IGNORECASE)
DATE_RE  = re.compile(r'^(\d{2})/(\d{2})/(\d{2})$')
ORIG_RE  = re.compile(r'^(\d+)[\s-]Orig\.?$', re.IGNORECASE)

# Like CASE_RE but also matches '130Orig' (no hyphen) and bare numbers (e.g. '163') as
# seen on archived transcript listing pages for pre-2000 terms.
_TRANSCRIPT_CASE_RE = re.compile(r'^(\d+(?:-\d+|-?Orig\.?|A\d+)?)\s+(.+)$', re.IGNORECASE)
_ORIG_NORM_RE       = re.compile(r'[\s-]*Orig\.?$', re.IGNORECASE)

REPO_ROOT = Path(__file__).resolve().parent.parent
BASE_URL  = 'https://www.supremecourt.gov'

# ── Docket number map ─────────────────────────────────────────────────────────

def _load_docket_map() -> dict[tuple[str, str], str]:
    """Load scripts/docketmap.txt and return {(term_year, case_number): docket_number}."""
    path = Path(__file__).parent / 'docketmap.txt'
    result: dict[tuple[str, str], str] = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        try:
            left, docket = line.split('->', 1)
            term, case = left.split(':', 1)
            result[(term.strip(), case.strip())] = docket.strip()
        except ValueError:
            continue
    return result


_DOCKET_MAP = _load_docket_map()


def _docket_number(case_number: str, term_year: str) -> str:
    """Return the internal SCOTUS docket number for a given case number and term.

    For standard cases (24-123, 24A884) this is just the case number itself.
    For original-jurisdiction cases (141-Orig) the default rule is YYOxxx
    where YY is the 2-digit term year, but docketmap.txt can override this.
    """
    m = ORIG_RE.match(case_number)
    if m:
        override = _DOCKET_MAP.get((term_year, case_number))
        if override:
            return override
        yy = term_year[-2:]
        return f'{yy}O{m.group(1)}'
    return case_number


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _safe_url(url: str) -> str:
    """Percent-encode any characters in a URL that are not valid, while
    leaving already-encoded %XX sequences untouched."""
    return urllib.parse.quote(url, safe=':/?#[]@!$&\'()*+,;=%')


def fetch_html(url: str) -> str:
    req = urllib.request.Request(_safe_url(url), headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode('utf-8', errors='replace')


def download_file(url: str, dest: Path) -> None:
    req = urllib.request.Request(_safe_url(url), headers={'User-Agent': 'Mozilla/5.0'})
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


DOCKET_DATE_RE = re.compile(r'^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$')

MONTH_MAP = {
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
    'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
    'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12',
}


def parse_docket_date(s: str) -> str | None:
    """Convert 'Jun 06 2025' to '2025-06-06'."""
    m = DOCKET_DATE_RE.match(s.strip())
    if not m:
        return None
    month = MONTH_MAP.get(m.group(1).capitalize())
    if not month:
        return None
    return f'{m.group(3)}-{month}-{m.group(2).zfill(2)}'


ARCHIVED_DATE_RE = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{4})$')


def parse_archived_date(date_str: str) -> str | None:
    """Convert M/D/YYYY (archived transcript listing pages) to YYYY-MM-DD."""
    m = ARCHIVED_DATE_RE.match(date_str.strip())
    if not m:
        return None
    month, day, year = m.group(1), m.group(2), m.group(3)
    return f'{year}-{int(month):02d}-{int(day):02d}'


def parse_any_date(date_str: str) -> str | None:
    """Try MM/DD/YY (audio listing) then M/D/YYYY (archived transcript listing)."""
    return parse_date(date_str) or parse_archived_date(date_str)


def _normalize_number(num: str) -> str:
    """Normalize a case number to canonical form (e.g. '130Orig' → '130-Orig')."""
    num = num.strip().rstrip('.')
    num = _ORIG_NORM_RE.sub('-Orig', num)
    return num


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


def _build_transcript_envelope(turns: list, audio_href: str = '') -> dict:
    """Wrap a list of turn dicts in the transcript envelope format."""
    speaker_names = list(dict.fromkeys(t['name'] for t in turns))  # stable-unique
    return {
        'media': {
            'url':      audio_href,
            'speakers': [{'name': n} for n in speaker_names],
        },
        'turns': turns,
    }


def extract_transcript_pdf(pdf_path: Path, output_path: Path, audio_href: str = '') -> list:
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

    # Assign 1-based "turn" IDs (key placed first for readability)
    turns = [{'turn': i + 1, **turn} for i, turn in enumerate(turns)]

    envelope = _build_transcript_envelope(turns, audio_href)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(envelope, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )
    return turns


# ── Listing page parser ───────────────────────────────────────────────────────

class ListingParser(HTMLParser):
    """Parse the argument_audio listing page into a list of case dicts.

    Each dict has: number, title, date (ISO), detail_url.
    Only rows with a docket-number cell AND a parseable date cell are kept.
    """

    def __init__(self, base_url: str = ''):
        super().__init__(convert_charrefs=True)
        self._base_url  = base_url
        self._td_depth  = 0
        self._td_buf    = []
        self._row_cells = []   # accumulated text values for current <tr>
        self._row_hrefs = []   # first href seen in each <td>
        self._cur_href  = None
        self.cases      = []

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self._row_cells = []
            self._row_hrefs = []
        elif tag == 'td':
            if self._td_depth == 0:
                self._td_buf  = []
                self._cur_href = None
            self._td_depth += 1
        elif tag == 'a' and self._td_depth == 1 and self._cur_href is None:
            href = dict(attrs).get('href', '')
            if href:
                # Resolve relative hrefs against the listing page URL.
                import urllib.parse as _up
                self._cur_href = _up.urljoin(self._base_url, href)

    def handle_endtag(self, tag):
        if tag == 'td' and self._td_depth > 0:
            self._td_depth -= 1
            if self._td_depth == 0:
                text = ' '.join(''.join(self._td_buf).split())
                self._row_cells.append(text)
                self._row_hrefs.append(self._cur_href)
        elif tag == 'tr':
            if len(self._row_cells) == 2:
                case_text, date_text = self._row_cells
                m        = CASE_RE.match(case_text)
                date_iso = parse_date(date_text)
                if m and date_iso:
                    self.cases.append({
                        'number':     m.group(1),
                        'title':      m.group(2).strip(),
                        'date':       date_iso,
                        'detail_url': self._row_hrefs[0] if self._row_hrefs else None,
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


# ── Transcript listing page parser ───────────────────────────────────────────

class TranscriptListingParser(HTMLParser):
    """Parse argument_transcript or archived_transcripts listing pages.

    Each row has the case number+title (with an <a> href to a PDF) in the first
    <td> and the argued date in the second.  Returns a list of dicts:
        {number, title, date, pdf_url}
    """

    def __init__(self, base_url: str = ''):
        super().__init__(convert_charrefs=True)
        self._base_url   = base_url
        self._td_depth   = 0
        self._td_buf     = []
        self._row_cells  = []
        self._row_hrefs  = []
        self._cur_href   = None
        self.transcripts = []   # [{number, title, date, pdf_url}]

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self._row_cells = []
            self._row_hrefs = []
        elif tag == 'td':
            if self._td_depth == 0:
                self._td_buf   = []
                self._cur_href = None
            self._td_depth += 1
        elif tag == 'a' and self._td_depth == 1 and self._cur_href is None:
            href = dict(attrs).get('href', '')
            if href and href.lower().endswith('.pdf'):
                self._cur_href = urllib.parse.urljoin(self._base_url, href)

    def handle_endtag(self, tag):
        if tag == 'td' and self._td_depth > 0:
            self._td_depth -= 1
            if self._td_depth == 0:
                text = ' '.join(''.join(self._td_buf).split())
                self._row_cells.append(text)
                self._row_hrefs.append(self._cur_href)
        elif tag == 'tr':
            if len(self._row_cells) == 2:
                case_text, date_text = self._row_cells
                m        = _TRANSCRIPT_CASE_RE.match(case_text)
                date_iso = parse_any_date(date_text)
                pdf_url  = self._row_hrefs[0] if self._row_hrefs else None
                if m and date_iso and pdf_url:
                    self.transcripts.append({
                        'number':  _normalize_number(m.group(1)),
                        'title':   m.group(2).strip(),
                        'date':    date_iso,
                        'pdf_url': pdf_url,
                    })

    def handle_data(self, data):
        if self._td_depth > 0:
            self._td_buf.append(data)


# ── Docket page parser ─────────────────────────────────────────────────────

class DocketParser(HTMLParser):
    """Parse a SCOTUS docket HTML page.

    Extracts:
      questions_href: URL of the Questions Presented PDF (if present)
      proceedings:    list of {date, title, href[, type]} for entries that have a
                      'Main Document' and/or 'Petition' link in Proceedings and
                      Orders.  Rows with a 'Petition' link produce an extra entry
                      with type='petitioner'.
    """

    def __init__(self, page_url: str = ''):
        super().__init__(convert_charrefs=True)
        self._page_url      = page_url
        self.questions_href = None
        self.proceedings    = []

        self._td_depth  = 0
        self._td_count  = 0   # 0-based cell index within current row
        self._body_text = ''  # non-link text accumulated for current td
        self._in_link   = False
        self._link_text = ''
        self._link_href = ''
        self._row_date  = None
        self._row_title = ''
        self._row_links = {}  # link_text -> href accumulated across the row

    def handle_starttag(self, tag, attrs):
        if tag == 'tr':
            self._td_count  = 0
            self._row_date  = None
            self._row_title = ''
            self._row_links = {}
        elif tag == 'td':
            if self._td_depth == 0:
                self._body_text = ''
            self._td_depth += 1
        elif tag == 'a':
            self._in_link   = True
            self._link_text = ''
            self._link_href = dict(attrs).get('href', '')

    def handle_endtag(self, tag):
        if tag == 'a' and self._in_link:
            self._in_link = False
            text = self._link_text.strip()
            href = self._link_href
            if href and not href.startswith('http'):
                href = urllib.parse.urljoin(self._page_url, href)
            if text == 'Questions Presented' and self.questions_href is None:
                self.questions_href = href
            if text:
                self._row_links[text] = href
        elif tag == 'td' and self._td_depth > 0:
            self._td_depth -= 1
            if self._td_depth == 0:
                cell_text = ' '.join(self._body_text.split())
                if self._td_count == 0:
                    self._row_date = parse_docket_date(cell_text)
                elif self._td_count == 1:
                    self._row_title = cell_text
                self._td_count += 1
        elif tag == 'tr':
            if self._row_date and self._row_title:
                if 'Main Document' in self._row_links:
                    self.proceedings.append({
                        'date':  self._row_date,
                        'title': self._row_title,
                        'href':  self._row_links['Main Document'],
                    })
                if 'Petition' in self._row_links:
                    self.proceedings.append({
                        'date':  self._row_date,
                        'title': self._row_title,
                        'href':  self._row_links['Petition'],
                        'type':  'petitioner',
                    })

    def handle_data(self, data):
        if self._in_link:
            self._link_text += data
        elif self._td_depth > 0:
            self._body_text += data


# ── Scrape listing page ───────────────────────────────────────────────────────

def fetch_cases_from_url(url: str) -> list[dict]:
    """Return a list of {number, title, date, detail_url} dicts scraped from the listing page."""
    print(f'Fetching {url} ...')
    html   = fetch_html(url)
    parser = ListingParser(base_url=url)
    parser.feed(html)
    return parser.cases


# ── Scrape case detail page ───────────────────────────────────────────────────

def fetch_argument_urls(detail_url: str) -> dict:
    """Fetch the case detail page and return audio_href / transcript_href if found."""
    if not detail_url:
        return {}
    try:
        html   = fetch_html(detail_url)
        parser = DetailParser()
        parser.feed(html)
    except Exception as exc:
        print(f'    Warning: could not fetch detail page {detail_url}: {exc}')
        return {}

    result = {}
    if parser.mp3_url:
        result['audio_href'] = parser.mp3_url
    if parser.pdf_url:
        result['transcript_href'] = parser.pdf_url
    return result


def _transcript_listing_url(year_str: str) -> str:
    """Return the supremecourt.gov transcript listing URL for the given term year."""
    year = int(year_str)
    if year < 2000:
        return f'{BASE_URL}/oral_arguments/archived_transcripts/{year_str}'
    return f'{BASE_URL}/oral_arguments/argument_transcript/{year_str}'


def fetch_transcripts_from_url(url: str) -> list[dict]:
    """Return [{number, title, date, pdf_url}] scraped from a transcript listing page."""
    print(f'Fetching transcript listing from {url} ...')
    try:
        html = fetch_html(url)
    except Exception as exc:
        print(f'  Warning: could not fetch transcript listing: {exc}')
        return []
    parser = TranscriptListingParser(base_url=url)
    parser.feed(html)
    return parser.transcripts


def fetch_docket_info(number: str, term_year: str = '') -> dict:
    """Fetch the docket page and return {questions_href, proceedings}."""
    internal = _docket_number(number, term_year)
    # The /docket/docketfiles/html/public/ path only exists from the 2017 term
    # onward.  Earlier cases are served via the search.aspx wrapper with a .htm
    # extension (the file lives at /docketfiles/{number}.htm on the server).
    year_int = int(term_year) if term_year.isdigit() else 0
    if year_int >= 2017:
        url = f'{BASE_URL}/docket/docketfiles/html/public/{internal}.html'
    else:
        url = f'{BASE_URL}/search.aspx?filename=/docketfiles/{internal}.htm'
    try:
        html   = fetch_html(url)
        parser = DocketParser(page_url=url)
        parser.feed(html)
    except Exception as exc:
        print(f'    Warning: could not fetch docket for {number}: {exc}')
        return {}
    return {
        'questions_href': parser.questions_href,
        'proceedings':    parser.proceedings,
    }


# ── Update cases.json ─────────────────────────────────────────────────────────

def update_cases_json(cases_path: Path, new_cases: list[dict], year: str) -> None:
    if cases_path.exists():
        existing = json.loads(cases_path.read_text(encoding='utf-8'))
    else:
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        existing = []

    # Build a lookup from case number → scraped case (with detail_url).
    scraped_by_num = {c['number']: c for c in new_cases}
    existing_numbers = {c['number'] for c in existing}

    modified = False
    added = []
    for case in new_cases:
        if case['number'] in existing_numbers:
            continue

        print(f'  Adding {case["number"]} ({case["date"]}) ...', end=' ', flush=True)
        arg_urls = fetch_argument_urls(case['detail_url'])
        time.sleep(0.3)   # be polite

        argument = {'source': 'ussc', 'type': 'argument', 'date': case['date']}
        argument.update(arg_urls)

        if arg_urls:
            status = 'audio+transcript' if 'transcript_href' in arg_urls else 'audio only'
        else:
            status = 'no media URLs found'
        print(status)

        existing.append({
            'title':     case['title'],
            'number':    case['number'],
            'audio': [argument],
        })
        added.append(case['number'])

    # Backfill audio_href / transcript_href for existing cases whose arguments
    # are missing them (e.g. the detail URL had a suffix like _2 on first import).
    for case in existing:
        scraped = scraped_by_num.get(case['number'])
        if not scraped or not scraped.get('detail_url'):
            continue
        for arg in case.get('audio', []):
            if arg.get('source', 'ussc') != 'ussc':
                continue   # only backfill USSC arguments
            if arg.get('transcript_href'):
                continue   # already have supremecourt.gov URLs
            print(f'  Backfilling URLs for {case["number"]} ({arg.get("date", "?")}) ...', end=' ', flush=True)
            arg_urls = fetch_argument_urls(scraped['detail_url'])
            time.sleep(0.3)
            if arg_urls:
                arg.update(arg_urls)   # overwrites audio_href with SCOTUS copy if present
                modified = True
                status = 'audio+transcript' if 'transcript_href' in arg_urls else 'audio only'
            else:
                status = 'no media URLs found'
            print(status)

    if added or modified:
        cases_path.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        if added:
            print(f'\nAdded {len(added)} case(s) to {cases_path}.')
    else:
        print(f'No new cases to add to {cases_path}')


# ── Step 4: Fetch docket info ────────────────────────────────────────────────────────

def update_docket_info(cases_path: Path, term_year: str = '') -> None:
    """For each case without questions_href, or whose files.json has no petitioner
    entry, fetch the SCOTUS docket page and:
      - Set questions_href in cases.json
      - Append new Proceedings entries to files.json (deduped by href),
        including Petition links marked with type='petitioner'
    """
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    cases_modified = False

    for case in existing:
        number     = case['number']
        files_path = cases_path.parent / 'cases' / number / 'files.json'

        if case.get('questions_href'):
            # Docket was already fetched (questions_href proves it). Only re-fetch
            # if files.json exists but has no petitioner entry yet — meaning the
            # docket was fetched before petitioner detection was added.
            has_petitioner = False
            if files_path.exists():
                try:
                    fdata = json.loads(files_path.read_text(encoding='utf-8'))
                    has_petitioner = any(f.get('type') == 'petitioner' for f in fdata)
                except Exception:
                    pass
            if has_petitioner or not files_path.exists():
                continue   # already fully processed

        print(f'  Fetching docket for {number} ...', end=' ', flush=True)
        info = fetch_docket_info(number, term_year)
        time.sleep(0.3)

        if not info:
            print('skipped')
            continue

        changed = []

        if info.get('questions_href') and not case.get('questions_href'):
            case['questions_href'] = info['questions_href']
            cases_modified = True
            changed.append('questions_href')

        proceedings = info.get('proceedings', [])
        if proceedings:
            case_dir   = cases_path.parent / 'cases' / number
            files_path = case_dir / 'files.json'
            case_dir.mkdir(parents=True, exist_ok=True)

            if files_path.exists():
                files = json.loads(files_path.read_text(encoding='utf-8'))
            else:
                files = []

            existing_hrefs = {f['href'] for f in files if 'href' in f}
            next_file_id = max((f.get('file', 0) for f in files), default=0) + 1
            added = 0
            for p in proceedings:
                if p['href'] not in existing_hrefs:
                    entry = {'file': next_file_id, 'title': p['title'], 'date': p['date'], 'href': p['href']}
                    if p.get('type'):
                        entry['type'] = p['type']
                    files.append(entry)
                    existing_hrefs.add(p['href'])
                    next_file_id += 1
                    added += 1

            if added:
                files_path.write_text(
                    json.dumps(files, indent=2, ensure_ascii=False) + '\n',
                    encoding='utf-8',
                )
                changed.append(f'{added} filings -> files.json')

        print(', '.join(changed) if changed else 'nothing new')

    if cases_modified:
        cases_path.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('Updated cases.json with questions_href entries.')


# ── Step 3: Generate missing transcripts ─────────────────────────────────────


def generate_missing_transcripts(cases_path: Path) -> None:
    """For each argument with a transcript_href and no YYYY-MM-DD.json yet,
    download the PDF, extract turns, write the JSON, and update text_href."""
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    modified = False

    for case in existing:
        for arg in case.get('audio', []):
            pdf_url = arg.get('transcript_href')
            date    = arg.get('date')
            if not pdf_url or not date:
                continue

            # Skip archived (pre-2000) transcripts — OCR quality is too poor.
            if '/pdfs/transcripts/' in pdf_url:
                continue

            case_dir       = cases_path.parent / 'cases' / case['number']
            transcript_out = case_dir / f'{date}.json'

            if transcript_out.exists():
                continue

            print(f'  Extracting {case["number"]} ({date}) ...', end=' ', flush=True)

            tmp_path = None
            try:
                with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
                    tmp_path = Path(tmp.name)

                download_file(pdf_url, tmp_path)
                audio_href = arg.get('audio_href', '')
                turns = extract_transcript_pdf(tmp_path, transcript_out, audio_href)
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


# ── Step 3b: Migrate old-format transcripts ──────────────────────────────────


def migrate_transcripts(cases_path: Path) -> None:
    """Convert any transcript JSON that is a bare array (old format) to the
    new envelope format {media: {url, speakers}, turns: […]}."""
    existing = json.loads(cases_path.read_text(encoding='utf-8'))

    # Build a lookup of audio_href by (number, date) so we can populate media.url.
    audio_map: dict[tuple, str] = {}
    for case in existing:
        for arg in case.get('audio', []):
            key = (case['number'], arg.get('date', ''))
            audio_map[key] = arg.get('audio_href', '')

    total = 0
    for case in existing:
        number = case['number']
        case_dir = cases_path.parent / 'cases' / number
        for arg in case.get('audio', []):
            date = arg.get('date', '')
            transcript_path = case_dir / f'{date}.json'
            if not transcript_path.exists():
                continue
            data = json.loads(transcript_path.read_text(encoding='utf-8'))
            if isinstance(data, list):
                # Old format — wrap it.
                audio_href = audio_map.get((number, date), '')
                envelope = _build_transcript_envelope(data, audio_href)
                transcript_path.write_text(
                    json.dumps(envelope, indent=2, ensure_ascii=False) + '\n',
                    encoding='utf-8',
                )
                try:
                    rel = transcript_path.relative_to(REPO_ROOT)
                except ValueError:
                    rel = transcript_path
                print(f'  Migrated {rel}')
                total += 1

    if not total:
        print('  All transcripts already in new format.')
    else:
        print(f'  Migrated {total} transcript(s).')


# ── Step 5: Clean up files.json ───────────────────────────────────────────────

_FILED_RE = re.compile(r'\s+filed\..*$', re.IGNORECASE | re.DOTALL)

_TYPE_PREFIXES = [
    ('amicus',     ('Brief amicus ', 'Brief amici ')),
    ('respondent', ('Brief of respondent', 'Reply of respondent')),
    ('petitioner', ('Brief of petitioner', 'Reply of petitioner')),
]


def _clean_title(title: str) -> str:
    return _FILED_RE.sub('', title).strip()


def _infer_type(title: str) -> str | None:
    lower = title.lower()
    for type_val, prefixes in _TYPE_PREFIXES:
        if any(lower.startswith(p.lower()) for p in prefixes):
            return type_val
    return None


def clean_files_json(cases_path: Path) -> None:
    """Clean titles and infer types in every files.json under the term directory."""
    term_dir = cases_path.parent
    total_changed = 0

    for files_path in sorted(term_dir.glob('cases/*/files.json')):
        files = json.loads(files_path.read_text(encoding='utf-8'))
        changed = False

        for entry in files:
            title = entry.get('title', '')

            # Strip " filed." and trailing text; skip trailing-period removal for opinions.
            clean = _clean_title(title)
            if entry.get('type') != 'opinion':
                clean = clean.rstrip('.')
            if clean != title:
                entry['title'] = clean
                title = clean
                changed = True

            # Infer type if not already set
            if not entry.get('type'):
                inferred = _infer_type(title)
                if inferred:
                    entry['type'] = inferred
                    changed = True

        if changed:
            files_path.write_text(
                json.dumps(files, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            total_changed += 1
            print(f'  Cleaned {files_path.relative_to(REPO_ROOT)}')

    if not total_changed:
        print('  Nothing to clean.')


# ── Step 5b: Add transcript PDF entries to files.json ───────────────────────


def add_transcript_entries(cases_path: Path) -> None:
    """For each argument that has a transcript_href, ensure files.json contains
    an entry with type='transcript' linking to the PDF transcript."""
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    total_added = 0

    for case in existing:
        number = case['number']
        for arg in case.get('audio', []):
            pdf_url = arg.get('transcript_href')
            date    = arg.get('date')
            if not pdf_url or not date:
                continue

            case_dir   = cases_path.parent / 'cases' / number
            files_path = case_dir / 'files.json'
            case_dir.mkdir(parents=True, exist_ok=True)

            files = []
            if files_path.exists():
                files = json.loads(files_path.read_text(encoding='utf-8'))

            # Skip if a transcript entry for this PDF already exists.
            if any(f.get('type') == 'transcript' and f.get('href') == pdf_url for f in files):
                continue

            dt = datetime.fromisoformat(date)
            title = f'Transcript of Oral Argument on {dt.strftime("%B")} {dt.day}, {dt.year}'
            next_file_id = max((f.get('file', 0) for f in files), default=0) + 1
            files.append({
                'file':  next_file_id,
                'type':  'transcript',
                'title': title,
                'date':  date,
                'href':  pdf_url,
            })
            files_path.write_text(
                json.dumps(files, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            total_added += 1

    if total_added:
        print(f'  Added transcript entries to {total_added} files.json file(s).')
    else:
        print('  All transcript entries already present.')


# ── Step 6: Extract questions presented ──────────────────────────────────────

# Marks the start of the questions block.
_QP_START_RE = re.compile(
    r'(?:QUESTIONS?\s+PRESENTED\s*:?|[Tt]he\s+questions?\s+presented\s+(?:is|are)\s*:?)',
    re.IGNORECASE,
)

# Trailing boilerplate to strip (CERT. GRANTED … or ORDER OF …).
_QP_END_RE = re.compile(
    r'\n\s*(?:CERT\.\s+GRANTED|ORDER\s+OF\s+\w).*$',
    re.IGNORECASE | re.DOTALL,
)


def _extract_questions_from_text(text: str) -> str | None:
    """Return the questions-presented block from pdftotext output, or None."""
    m = _QP_START_RE.search(text)
    if not m:
        return None

    # Everything after the header marker.
    body = text[m.end():]

    # Strip trailing cert-granted / order lines.
    body = _QP_END_RE.sub('', body)

    # Normalise whitespace: collapse runs of spaces/tabs; keep paragraph breaks
    # (two+ newlines) as single newlines; trim.
    body = re.sub(r'[ \t]+', ' ', body)
    body = re.sub(r'\n{2,}', '\n', body)
    return body.strip() or None


def extract_questions(cases_path: Path) -> None:
    """For each case with questions_href but no questions, download the PDF and
    extract the questions presented text, saving it to cases.json."""
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    modified = False

    for case in existing:
        if case.get('questions') or not case.get('questions_href'):
            continue

        number = case['number']
        pdf_url = case['questions_href']
        print(f'  Extracting questions for {number} ...', end=' ', flush=True)

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
                tmp_path = Path(tmp.name)
            download_file(pdf_url, tmp_path)
            result = subprocess.run(
                ['pdftotext', '-layout', str(tmp_path), '-'],
                capture_output=True, text=True, check=True,
            )
            questions = _extract_questions_from_text(result.stdout)
            if questions:
                case['questions'] = questions
                modified = True
                print(f'{len(questions)} chars')
            else:
                print('not found')
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
        print('Updated cases.json with questions.')
    else:
        print('  Nothing to extract.')


# ── Step 2b: Import transcript PDFs from supremecourt.gov listing ─────────────

def import_transcript_pdfs(cases_path: Path, year_str: str) -> None:
    """Match PDF transcripts from the supremecourt.gov listing page to cases in
    cases.json.  For each ussc audio entry lacking transcript_href, set it from
    the listing; also add a type='transcript' entry to files.json.
    Cases present on the listing but missing from cases.json are created."""

    url = _transcript_listing_url(year_str)
    transcripts = fetch_transcripts_from_url(url)
    if not transcripts:
        print('  No transcripts found on listing page.')
        return
    print(f'  Found {len(transcripts)} transcript(s) on listing page.')

    # Build lookup: normalized number -> list of {date, title, pdf_url}
    by_number: dict[str, list[dict]] = {}
    for t in transcripts:
        by_number.setdefault(t['number'], []).append(t)

    if not cases_path.exists():
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        cases_path.write_text('[]\n', encoding='utf-8')
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    cases_modified = False

    def _add_to_files(case: dict, row: dict) -> None:
        """Add a type='transcript' entry to this case's files.json if not present."""
        pdf_url    = row['pdf_url']
        dt_str     = row['date']
        case_dir   = cases_path.parent / 'cases' / case['number']
        files_path = case_dir / 'files.json'
        case_dir.mkdir(parents=True, exist_ok=True)
        files = json.loads(files_path.read_text(encoding='utf-8')) if files_path.exists() else []
        if any(f.get('href') == pdf_url for f in files):
            return  # already present
        try:
            dt    = datetime.fromisoformat(dt_str)
            title = f'Transcript of Oral Argument on {dt.strftime("%B")} {dt.day}, {dt.year}'
        except ValueError:
            title = f'Transcript of Oral Argument on {dt_str}'
        next_id = max((f.get('file', 0) for f in files), default=0) + 1
        files.append({'file': next_id, 'type': 'transcript',
                      'title': title, 'date': dt_str, 'href': pdf_url})
        files_path.write_text(
            json.dumps(files, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )

    # Pass 1: match existing cases
    matched_rows: set[tuple[str, str]] = set()  # (number, date) pairs handled
    for case in existing:
        norm = _normalize_number(case['number'])
        rows = by_number.get(norm, [])
        if not rows:
            continue
        for row in rows:
            key = (norm, row['date'])
            matched_rows.add(key)
            _add_to_files(case, row)
            # Assign transcript_href to any audio entry with a matching date
            for arg in case.get('audio', []):
                if arg.get('type') not in (None, 'argument', 'reargument'):
                    continue
                if arg.get('transcript_href'):
                    continue
                arg_date = arg.get('date', '')
                if arg_date == row['date'] or (not arg_date and len(rows) == 1):
                    # Insert transcript_href after audio_href, or after date if absent.
                    insert_after = 'audio_href' if 'audio_href' in arg else 'date'
                    new_arg: dict = {}
                    inserted = False
                    for k, v in arg.items():
                        new_arg[k] = v
                        if not inserted and k == insert_after:
                            new_arg['transcript_href'] = row['pdf_url']
                            inserted = True
                    if not inserted:
                        new_arg['transcript_href'] = row['pdf_url']
                    arg.clear()
                    arg.update(new_arg)
                    cases_modified = True
                    print(f'  {case["number"]} ({row["date"]}): transcript_href added')
                    break  # assign to first matching USSC entry only

    # Pass 2: create new cases for unmatched transcripts
    existing_numbers = {_normalize_number(c['number']) for c in existing}
    new_by_num: dict[str, list[dict]] = {}
    for row in transcripts:
        key = (row['number'], row['date'])
        if key not in matched_rows and row['number'] not in existing_numbers:
            new_by_num.setdefault(row['number'], []).append(row)

    for norm, rows in sorted(new_by_num.items()):
        title = rows[0]['title']
        audio_entries = [
            {'source': 'ussc', 'type': 'argument',
             'date': r['date'], 'transcript_href': r['pdf_url']}
            for r in rows
        ]
        new_case = {'title': title, 'number': norm, 'audio': audio_entries}
        existing.append(new_case)
        existing_numbers.add(norm)
        cases_modified = True
        print(f'  {norm}: new case added with {len(audio_entries)} audio entry(ies)')
        for row in rows:
            _add_to_files(new_case, row)

    if cases_modified:
        cases_path.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('  Updated cases.json.')
    else:
        print('  No changes needed.')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    term = sys.argv[1].strip()
    m = re.fullmatch(r'(\d{4})-10', term)
    if not m:
        print(f'Error: expected a term in YYYY-10 format (e.g. 2025-10), got {term!r}')
        sys.exit(1)

    year_str   = m.group(1)
    url        = f'https://www.supremecourt.gov/oral_arguments/argument_audio/{year_str}'
    cases_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term / 'cases.json'

    try:
        scraped = fetch_cases_from_url(url)
    except Exception as exc:
        print(f'Audio listing page not available ({exc}); will rely on transcript listing.')
        scraped = []

    if scraped:
        print(f'Found {len(scraped)} case(s) on audio listing page.\n')
        update_cases_json(cases_path, scraped, year_str)
    else:
        print('No audio cases found.')
        if not cases_path.exists():
            cases_path.parent.mkdir(parents=True, exist_ok=True)
            cases_path.write_text('[]\n', encoding='utf-8')

    # Step 2b: import transcript PDFs from supremecourt.gov listing page
    print()
    print('Importing transcript PDFs from supremecourt.gov listing ...')
    import_transcript_pdfs(cases_path, year_str)

    # Step 3: generate missing transcript JSON files
    print()
    print('Checking for missing transcripts ...')
    generate_missing_transcripts(cases_path)

    # Step 3b: migrate old-format transcripts to envelope format
    print()
    print('Migrating old-format transcripts ...')
    migrate_transcripts(cases_path)

    # Step 4: fetch docket info (questions_href + files.json proceedings)
    # supremecourt.gov docket only has data from the 2001 term onward.
    print()
    if int(year_str) >= 2001:
        print('Fetching docket info for cases without questions_href ...')
        update_docket_info(cases_path, year_str)
    else:
        print('Skipping docket info (not available before 2001 term).')

    # Step 5: clean up files.json titles and infer missing types
    print()
    print('Cleaning up files.json entries ...')
    clean_files_json(cases_path)

    # Step 5b: add transcript PDF entries to files.json
    print()
    print('Adding transcript entries to files.json ...')
    add_transcript_entries(cases_path)

    # Step 6: extract questions presented from PDF
    print()
    print('Extracting questions presented ...')
    extract_questions(cases_path)

    # Step 7: add slip opinions to files.json
    print()
    print('Checking for slip opinions ...')
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    for case in existing:
        files_path = cases_path.parent / 'cases' / case['number'] / 'files.json'
        if files_path.exists():
            check_opinion_for_case(files_path, case['number'], term)

    # Sync files counts now that all files.json mutations are done
    sync_files_count(cases_path)


if __name__ == '__main__':
    main()
