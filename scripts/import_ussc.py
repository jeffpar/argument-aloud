#!/usr/bin/env python3
"""Fetches oral argument listings from supremecourt.gov for an entire term,
producing a cases.json, and generating transcript JSON files from the PDF
transcripts.

Usage:
    python3 scripts/import_cases.py TERM [CASE] [--docket]

Examples:
    python3 scripts/import_cases.py 2025-10
    python3 scripts/import_cases.py 2024-10 --docket
    python3 scripts/import_cases.py 2010-10 09-5801

Flags:
    --docket   Fetch docket pages from supremecourt.gov to populate
               questions_href and files.json proceedings entries.

The term must be in YYYY-10 format. The optional CASE argument restricts
processing to a single case number (e.g. 09-5801); in that mode network
scraping is skipped and the existing transcript JSON is re-generated.

The corresponding supremecourt.gov listing page
(https://www.supremecourt.gov/oral_arguments/argument_audio/YYYY) is
fetched automatically when running without a CASE filter.

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
from collections import Counter
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

# Import opinion helpers from validate_cases (same scripts/ directory).
sys.path.insert(0, str(Path(__file__).parent))
from validate_cases import _fetch_opinions, _wayback_pdf_url, check_opinion_for_case, sync_files_count, sync_opinion_href_from_files
from validate_cases import check_url as _check_url
from schema import reorder_event, reorder_case


CASE_RE  = re.compile(r'^(\d+(?:-\d+|-Orig|A\d+))\s+(.+)$', re.IGNORECASE)
DATE_RE  = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{2})$')
ORIG_RE  = re.compile(r'^(\d+)[\s-]Orig\.?$', re.IGNORECASE)

# Like CASE_RE but also matches '130Orig' (no hyphen) and bare numbers (e.g. '163') as
# seen on archived transcript listing pages for pre-2000 terms.
_TRANSCRIPT_CASE_RE = re.compile(r'^(\d+(?:-\d+|[\s-]?Orig\.?|A\d+)?)\.?\s+(.+)$', re.IGNORECASE)
_ORIG_NORM_RE       = re.compile(r'[\s-]*Orig\.?$', re.IGNORECASE)

REPO_ROOT        = Path(__file__).resolve().parent.parent
_SPEAKERS_PATH   = Path(__file__).parent / 'speakers.json'
_JUSTICES_PATH   = Path(__file__).parent / 'justices.json'

# Set to True by --verbose; controls whether "nothing to do" messages appear.
VERBOSE: bool = False
# Set to True by --cases; gates creation of new case objects.  Without this
# flag the scripts may only add new event objects to existing cases.
ADD_CASES: bool = False
# Set to True by --checkurls; enables live URL checks for opinion_href values.
CHECK_URLS: bool = False
# Set to True whenever a step function actually writes changes; used to
# suppress the final "Nothing added/updated." summary line.
_any_changes: bool = False


def vprint(*args, **kwargs) -> None:
    """Print only when VERBOSE mode is active."""
    if VERBOSE:
        print(*args, **kwargs)


def _report_change(*args, **kwargs) -> None:
    """Print a change message and mark that changes occurred."""
    global _any_changes
    _any_changes = True
    print(*args, **kwargs)

BASE_URL         = 'https://www.supremecourt.gov'
_WAYBACK_CDX_URL = 'https://web.archive.org/cdx/search/cdx'
# Strips the Wayback timestamp rewrite prefix from href/src attributes so
# that relative URL resolution works against the original supremecourt.gov base.
_WAYBACK_REWRITE_RE = re.compile(r'https?://web\.archive\.org/web/\d{14}/')

# ── Docket number map ─────────────────────────────────────────────────────────

def _load_docket_map() -> dict[tuple[str, str], str]:
    """Load scripts/import_uscc.txt and return {(term_year, case_number): docket_number}."""
    path = Path(__file__).parent / 'import_uscc.txt'
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
    where YY is the 2-digit term year, but import_uscc.txt can override this.
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


def _fetch_html_via_wayback(original_url: str, year_str: str) -> str:
    """Fetch *original_url* via a Wayback Machine snapshot.

    Looks for the earliest snapshot on or after September 1 of the year
    following the term (i.e. (YYYY+1)-09-01).  That month falls after the
    term's June recess — so all case data is present — but before October
    when the page is overwritten with the new term's content.

    Returns HTML with the Wayback timestamp-rewrite prefix stripped so that
    the ListingParser / TranscriptListingParser can resolve relative hrefs
    against the original supremecourt.gov base URL.  Raises on failure.
    """
    year_int = int(year_str)
    min_date = f'{year_int + 1}0901'   # September 1 of the following year

    cdx_api = (
        f'{_WAYBACK_CDX_URL}'
        f'?url={urllib.parse.quote(original_url, safe="")}'
        f'&output=json&from={min_date}&limit=5&statuscode=200'
    )
    req = urllib.request.Request(cdx_api, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        cdx_rows = json.loads(resp.read().decode('utf-8', errors='replace'))

    if len(cdx_rows) < 2:
        raise ValueError(f'No Wayback snapshot found for {original_url!r} after {min_date}')

    header   = cdx_rows[0]
    ts_idx   = header.index('timestamp') if 'timestamp' in header else 1
    snapshot_ts  = cdx_rows[1][ts_idx]
    snapshot_url = f'https://web.archive.org/web/{snapshot_ts}/{original_url}'

    print(f'Fetching Wayback snapshot ({snapshot_ts[:8]}) for {original_url} ...')
    html = fetch_html(snapshot_url)
    return _WAYBACK_REWRITE_RE.sub('', html)


def download_file(url: str, dest: Path) -> None:
    req = urllib.request.Request(_safe_url(url), headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())


# ── Date conversion ───────────────────────────────────────────────────────────

def parse_date(date_str: str) -> str | None:
    """Convert M/D/YY or MM/DD/YY to YYYY-MM-DD (assumes 2000s)."""
    m = DATE_RE.match(date_str.strip())
    if not m:
        return None
    month, day, year2 = m.group(1), m.group(2), m.group(3)
    return f'20{year2}-{int(month):02d}-{int(day):02d}'


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


def _case_folder(number: str) -> str:
    """Return the case folder name for a number field.

    For consolidated cases (e.g. '00-832,00-843') the folder uses the first
    (lead) number only, matching the convention in validate_cases.py.
    """
    return number.split(',')[0].strip()


# Matches the case number embedded in a SCOTUS transcript PDF URL.
# e.g. .../argument_transcripts/2006/05-380.pdf  or  .../pdfs/transcripts/2006/141orig.pdf
_USSC_HREF_NUM_RE = re.compile(
    r'/(?:argument_transcripts|transcripts)/\d+/([^/]+)\.pdf', re.IGNORECASE
)


def _ussc_case_num_from_href(transcript_href: str = '', text_href: str = '') -> str:
    """Extract the component case-folder number from a USSC transcript_href URL
    or a folder-prefixed text_href.

    For a text_href like '05-380/2006-11-08.json', returns '05-380'.
    Falls back to extracting the case number from a supremecourt.gov transcript
    URL (.../argument_transcripts/YYYY/05-380.pdf → '05-380').
    Returns '' if undetermined.
    """
    if text_href and '/' in text_href:
        return text_href.split('/')[0]
    if transcript_href:
        m = _USSC_HREF_NUM_RE.search(transcript_href)
        if m:
            raw = m.group(1)
            # Strip the random 4-char alphanumeric suffix SCOTUS appends to PDF
            # filenames (e.g. '13-212_d1o2' → '13-212'; '05-380' unchanged).
            raw = re.sub(r'_[a-z0-9]{4}$', '', raw, flags=re.IGNORECASE)
            return _normalize_number(raw)
    return ''


def _ussc_audio_title(type_val: str, date_str: str, case_num: str = '') -> str:
    """Build a human-readable title for a USSC oral-argument audio entry."""
    try:
        dt         = datetime.fromisoformat(date_str)
        date_label = f'{dt.strftime("%B")} {dt.day}, {dt.year}'
    except (ValueError, TypeError):
        date_label = date_str or '?'
    case_str = f' in No. {case_num}' if case_num else ''
    if type_val == 'reargument':
        return f'Oral Reargument{case_str} on {date_label}'
    return f'Oral Argument{case_str} on {date_label}'


# ── Speaker name resolution ───────────────────────────────────────────────────

# Matches each content line produced by pdftotext -layout (re-used below).
_APPEARANCES_NAME_RE = re.compile(
    r'^([A-Z][A-Za-z\'\.\-]+(?:\s+[A-Z][A-Za-z\'\.\-]+){1,}'  # FIRST [MIDDLE] LAST (allows McX)
    r'(?:,\s*(?:JR|SR|II|III|IV)\.?)?)[\s,]',                   # optional , JR.
)
_SUFFIX_WORDS = frozenset({'JR', 'SR', 'II', 'III', 'IV'})

# Matches a trailing suffix that is not yet preceded by ", " (needs normalisation).
# Covers: "JOHN DOE JR." / "JOHN DOE JR" / "JOHN DOE, JR" / "JOHN DOE II" etc.
_SUFFIX_NORM_RE = re.compile(
    r'^(.+?)(?:,\s*|\s+)(JR\.|SR\.|JR|SR|II|III|IV)\s*$',
    re.IGNORECASE,
)


def _normalize_name_suffix(name: str) -> str:
    """Ensure generation suffixes are separated by ", " and consistently cased.

    Examples
    --------
    'JOHN DOE JR'    -> 'JOHN DOE, JR.'
    'JOHN DOE JR.'   -> 'JOHN DOE, JR.'
    'JOHN DOE, JR'   -> 'JOHN DOE, JR.'
    'JOHN DOE, SR.'  -> 'JOHN DOE, SR.'  (unchanged)
    'JOHN DOE II'    -> 'JOHN DOE, II'
    'JOHN DOE, III'  -> 'JOHN DOE, III'  (unchanged)
    """
    m = _SUFFIX_NORM_RE.match(name)
    if not m:
        return name
    base   = m.group(1).strip()
    suffix = m.group(2).upper().rstrip('.')
    # JR and SR get a trailing period; Roman numerals do not.
    if suffix in ('JR', 'SR'):
        suffix += '.'
    return f'{base}, {suffix}'


def _build_justice_last_name_map() -> dict[str, str]:
    """Return {LAST_NAME_UPPER: canonical_name_upper} from justices.json.

    Indexes last-name tokens from both canonical names and their alternates so
    that typo'd forms (e.g. 'GORUSCH') resolve to the correct canonical name.
    """
    if not _JUSTICES_PATH.exists():
        return {}
    data: dict = json.loads(_JUSTICES_PATH.read_text(encoding='utf-8'))
    result: dict[str, str] = {}
    for canonical, entry in data.items():
        u = canonical.upper()
        words = u.split()
        last = words[-1]
        if last in _SUFFIX_WORDS and len(words) > 1:
            last = words[-2]
        result.setdefault(last, u)
        # Also index the last-name token of each alternate so typo'd last names
        # (e.g. 'GORUSCH', 'GINSBERG') resolve without a separate TYPO: entry.
        for alt in entry.get('alternates') or []:
            a = alt.upper()
            aw = a.split()
            al = aw[-1]
            if al in _SUFFIX_WORDS and len(aw) > 1:
                al = aw[-2]
            result.setdefault(al, u)
    return result


def _build_justice_canonical_set() -> frozenset[str]:
    """Return a frozenset of all canonical justice names (upper-case) from justices.json."""
    if not _JUSTICES_PATH.exists():
        return frozenset()
    data: dict = json.loads(_JUSTICES_PATH.read_text(encoding='utf-8'))
    return frozenset(c.upper() for c in data)


_JUSTICE_LAST_NAME_MAP: dict[str, str] = _build_justice_last_name_map()
_JUSTICE_CANONICAL_SET: frozenset[str] = _build_justice_canonical_set()


def _load_speakers_section(section: str) -> dict[str, str]:
    """Return {KEY_UPPER: VALUE_UPPER} for one section of speakers.json."""
    if not _SPEAKERS_PATH.exists():
        return {}
    data: dict = json.loads(_SPEAKERS_PATH.read_text(encoding='utf-8'))
    return {k.upper(): v.upper() for k, v in (data.get(section) or {}).items()}


_TYPO_SPEAKER_MAP:   dict[str, str] = _load_speakers_section('typos')
_RENAME_SPEAKER_MAP: dict[str, str] = _load_speakers_section('rename')


# Matches an advocate title prefix that may appear at the start of a name
# (either in the transcript token or in the APPEARANCES section).
_ADVOCATE_TITLE_PREFIX_RE = re.compile(
    r'^(MR\.|MS\.|MRS\.|MISS|GENERAL|GEN\.)\s+(.+)$',
)


def _strip_title_prefix(name: str) -> tuple[str, str]:
    """Strip a leading advocate-title prefix from a name.

    Returns (stripped_name, normalised_title) where the title is empty if
    no recognised prefix was found.  'GEN.' is normalised to 'GENERAL'.
    """
    m = _ADVOCATE_TITLE_PREFIX_RE.match(name)
    if not m:
        return name, ''
    t = m.group(1)
    if t == 'GEN.':
        t = 'GENERAL'
    return m.group(2), t


_APPEARANCES_ESQ_RE = re.compile(r'^(.+?)(?:,\s*|\s+)(?:ESQUIRE|ESQ\.)', re.IGNORECASE)

# Strip argument-header prefixes that sometimes appear in the APPEARANCES section
# of old transcripts (e.g. "ORAL ARGUMENT OF JOHN DOE" → "JOHN DOE").
_APPEARANCES_HEADER_PREFIX_RE = re.compile(
    r'^(?:ORAL\s+)?(?:ARGUMENT|REBUTTAL\s+ARGUMENT)\s+(?:OF|BY)\s+',
    re.IGNORECASE,
)

# First names that are overwhelmingly female — used to disambiguate advocates
# who share a last name when the transcript token has MR. vs MS./MRS./MISS.
_FEMALE_FIRST_NAMES = frozenset({
    'ABIGAIL', 'ADRIENNE', 'AILEEN', 'AIMEE', 'ALEXIS', 'ALICE', 'ALICIA',
    'ALISON', 'ALLISON', 'ALYSSA', 'AMANDA', 'AMBER', 'AMY', 'ANDREA',
    'ANGELA', 'ANN', 'ANNA', 'ANNE', 'ANNETTE', 'ARIEL', 'ASHLEY',
    'AUDREY', 'AUTUMN', 'BARBARA', 'BETTY', 'BEVERLY', 'BRENDA', 'BRIANNA',
    'BRITTANY', 'BROOKE', 'CANDICE', 'CAROL', 'CARLY', 'CAROL', 'CAROLYN',
    'CASSANDRA', 'CECILIA', 'CHARLOTTE', 'CHELSEA', 'CHERYL', 'CHRISTY',
    'CINDY', 'CLAIRE', 'CLAUDIA', 'COLLEEN', 'CONSTANCE', 'COURTNEY',
    'CRYSTAL', 'CYNTHIA', 'DANA', 'DAWN', 'DEBORAH', 'DEBRA', 'DENISE',
    'DIANA', 'DIANE', 'DONNA', 'DOROTHY', 'ELENA', 'ELEANOR', 'ELIZABETH',
    'EMILY', 'EMMA', 'ERIN', 'EVA', 'FAITH', 'FELICIA', 'FLORENCE',
    'FRANCES', 'GLORIA', 'GRACE', 'HANNAH', 'HEATHER', 'HELEN', 'HOLLY',
    'HOPE', 'IRENE', 'IVY', 'JACKIE', 'JACQUELINE', 'JADE', 'JANET',
    'JASMINE', 'JEAN', 'JENNIFER', 'JESSICA', 'JOANNA', 'JOANNE', 'JOY',
    'JOYCE', 'JUDITH', 'JULIA', 'JULIE', 'JUNE', 'JUSTINE', 'KAREN',
    'KATHERINE', 'KATHLEEN', 'KATHRYN', 'KATRINA', 'KELLY', 'KIMBERLY',
    'KRISTIN', 'LACEY', 'LAURA', 'LAURIE', 'LEAH', 'LEILA', 'LENA',
    'LESLIE', 'LILY', 'LINDA', 'LISA', 'LORENA', 'LORI', 'LORRAINE',
    'LUCY', 'LYDIA', 'MACKENZIE', 'MADELINE', 'MARGARET', 'MARIA', 'MARIE',
    'MARTHA', 'MARY', 'MAYA', 'MEGAN', 'MELISSA', 'MICHELLE', 'MILA',
    'MIRANDA', 'MOLLY', 'MONIQUE', 'NAOMI', 'NATALIE', 'NANCY', 'NINA',
    'NORA', 'NORMA', 'OLIVIA', 'PAIGE', 'PAMELA', 'PATRICIA', 'PEGGY',
    'PHYLLIS', 'RACHEL', 'REBECCA', 'REBEKAH', 'RENEE', 'RHONDA', 'ROBIN',
    'ROSA', 'ROSE', 'ROSEMARY', 'RUTH', 'SAMANTHA', 'SANDRA', 'SARA',
    'SARAH', 'SHARON', 'SHEILA', 'SHELLEY', 'SIERRA', 'SONYA', 'SOPHIA',
    'STACEY', 'STACY', 'STELLA', 'STEPHANIE', 'SUMMER', 'SUSAN', 'SYLVIA',
    'TAMARA', 'TAMMY', 'TANYA', 'TARA', 'TERESA', 'THERESA', 'TIFFANY',
    'TINA', 'TRACY', 'VANESSA', 'VERONICA', 'VIOLET', 'VIRGINIA', 'VIVIAN',
    'WANDA', 'WENDY', 'WHITNEY', 'YVONNE', 'ZOE',
})


def _pick_candidate(candidates: list[str], title: str) -> str:
    """Pick the best name from a list of candidates sharing the same last name.

    Uses the transcript title token (MS./MRS./MISS → female; MR. → male) and
    the first word of each candidate's name to disambiguate.  Falls back to
    the first candidate (i.e., the first-listed in APPEARANCES) when no
    confident match is found.
    """
    if len(candidates) == 1:
        return candidates[0]
    is_female = title in ('MS.', 'MRS.', 'MISS')
    is_male   = title == 'MR.'
    for cand in candidates:
        # Strip any leading title prefix (e.g. 'GENERAL') to reach the first name.
        stripped, _ = _strip_title_prefix(cand)
        first = stripped.split()[0]
        if is_female and first in _FEMALE_FIRST_NAMES:
            return cand
        if is_male and first not in _FEMALE_FIRST_NAMES:
            return cand
    return candidates[0]

_APPEARANCES_LINE_RE = re.compile(r'^\s*\d{1,2}\s{2,}(.+)')

def parse_appearances(raw_text: str) -> dict[str, list[str]]:
    """Parse the APPEARANCES section of a pdftotext transcript.

    Returns {LAST_NAME_UPPER: [FULL_NAME_UPPER, ...]} for each listed advocate.
    Multiple advocates sharing a last name are stored as a list in appearance
    order so ``_pick_candidate`` can disambiguate by title.

    Uses a permissive line regex (any leading whitespace before the line
    number) because some transcript pages have 4+ spaces of indentation
    that the main CONTENT_LINE_RE (0–3 spaces) would not match.
    """
    in_appearances = False
    names: list[str] = []

    for line in raw_text.split('\n'):
        m = _APPEARANCES_LINE_RE.match(line)
        if not m:
            continue
        content = m.group(1).strip()
        if re.match(r'^APPEARANCES:?$', content):
            in_appearances = True
            continue
        if not in_appearances:
            continue
        # Stop at CONTENTS or PROCEEDINGS (may appear with or without spaces
        # between letters depending on pdftotext layout mode).
        if content.replace(' ', '').startswith(('CONTENTS', 'PROCEEDINGS')):
            break
        # Preferred: extract name as everything before ", ESQ." — handles
        # mixed-case prefixes like "McALLISTER" that trip up the regex.
        esq = _APPEARANCES_ESQ_RE.match(content)
        if esq:
            names.append(esq.group(1).strip())
            continue
        nm = _APPEARANCES_NAME_RE.match(content)
        if nm:
            names.append(nm.group(1).strip())

    result: dict[str, list[str]] = {}
    for name in names:
        name_upper = name.upper()
        # Strip argument-header prefixes (e.g. "ORAL ARGUMENT OF JOHN DOE" → "JOHN DOE").
        name_upper = _APPEARANCES_HEADER_PREFIX_RE.sub('', name_upper).strip()
        if not name_upper:
            continue
        parts = [p.strip('.,') for p in name_upper.split()]
        last = parts[-1]
        if last in _SUFFIX_WORDS and len(parts) > 1:
            last = parts[-2]
        result.setdefault(last, []).append(name_upper)
    return result


def _resolve_speaker(raw_name: str,
                     appearances: dict[str, list[str]]) -> tuple[str, str]:
    """Map a raw transcript speaker token to (canonical_full_name, title).

    Justice names (CHIEF JUSTICE X / JUSTICE X) are looked up via
    _JUSTICE_LAST_NAME_MAP (built from justices.json canonical names and
    alternates).  Advocate names (MR. X / MS. X / etc.) are resolved via the
    APPEARANCES section map using the last name.
    Falls back to the raw name and empty title when no match is found.
    """
    raw_upper = raw_name.upper().strip()
    # Anonymous justice token used in pre-2004 USSC transcripts
    if raw_upper in ('QUESTION', 'Q'):
        return 'UNKNOWN JUSTICE', 'JUSTICE'
    # Bare canonical justice name (no title prefix) — return as-is with JUSTICE title.
    if raw_upper in _JUSTICE_CANONICAL_SET:
        return raw_upper, 'JUSTICE'
    # Advocates: extract title prefix + remainder of name
    m = re.match(
        r'^(CHIEF JUSTICE|JUSTICE|MR\.|MS\.|MRS\.|MISS|GENERAL|GEN\.)\s+(.+)',
        raw_upper,
    )
    if m:
        title = m.group(1)
        if title == 'GEN.':
            title = 'GENERAL'
        rest  = m.group(2).strip()
        words = rest.split()
        last  = words[-1].rstrip('.,') 
        if last in _SUFFIX_WORDS and len(words) > 1:
            last = words[-2].rstrip('.,') 
        if title in ('CHIEF JUSTICE', 'JUSTICE'):
            # Only treat as a justice if the last name is in justices.json.
            if last in _JUSTICE_LAST_NAME_MAP:
                return _JUSTICE_LAST_NAME_MAP[last], title
            # Check typos from speakers.json (e.g. 'JUSTICE GORUSCH').
            corrected = _TYPO_SPEAKER_MAP.get(raw_upper)
            if corrected:
                cm = re.match(r'^(CHIEF JUSTICE|JUSTICE)\s+(.+)', corrected)
                c_title = cm.group(1) if cm else title
                c_name  = cm.group(2) if cm else corrected
                c_words = c_name.split()
                c_last  = c_words[-1].rstrip('.,')
                if c_last in _SUFFIX_WORDS and len(c_words) > 1:
                    c_last = c_words[-2].rstrip('.,')
                if c_last in _JUSTICE_LAST_NAME_MAP:
                    return _JUSTICE_LAST_NAME_MAP[c_last], c_title
                return c_name, c_title
            # Not a real justice — fall back to advocate resolution.
            title = ''
        # Advocate: look up full name via appearances section.
        candidates = appearances.get(last)
        full = _pick_candidate(candidates, title) if candidates else rest
        # Appearances may contain a title prefix (e.g. 'GENERAL ELIZABETH B. PRELOGAR').
        # Strip it and merge into title.
        stripped, extra = _strip_title_prefix(full)
        if extra:
            full = stripped
            if title and extra != title:
                title = f'{title},{extra}'
            elif not title:
                title = extra
        return full, title
    # No title prefix — if it's a bare last name, look it up in appearances.
    bare = raw_upper.rstrip('.,')  
    if ' ' not in bare:
        candidates = appearances.get(bare)
        full = candidates[0] if candidates else None
        if full:
            stripped, extra = _strip_title_prefix(full)
            if extra:
                full = stripped
            return full, extra
    return raw_name, ''


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
    r'^((?:CHIEF JUSTICE|JUSTICE|MR\.|MS\.|MRS\.|MISS|GENERAL|GEN\.)'
    r"\s+[A-Z][A-Za-z'\.]+(?:\s+[A-Z][A-Za-z'\.]+)*"
    r'|QUESTION|Q):\s*(.*)',
    re.DOTALL,
)


def _build_transcript_envelope(turns: list, audio_href: str = '',
                                speakers: list | None = None) -> dict:
    """Wrap a list of turn dicts in the transcript envelope format.

    If *speakers* is provided it should be a list of ``{"name": ..., "title": ...}``
    dicts already resolved to canonical form.  Otherwise the speaker list is
    derived from the turn names with no title information (legacy path used by
    migrate_transcripts).
    """
    if speakers is None:
        speaker_names = list(dict.fromkeys(t['name'] for t in turns))  # stable-unique
        speakers = [{'name': n} for n in speaker_names]
    return {
        'media': {
            'url':      audio_href,
            'speakers': speakers,
        },
        'turns': turns,
    }


# Path under which pre-computed pdftotext output is cached.
# Layout: courts/ussc/transcripts/text/{YEAR}/{CASE}_{DATE}.txt
_TEXT_CACHE_DIR = REPO_ROOT / 'courts' / 'ussc' / 'transcripts' / 'text'


def _cached_text_path(case_number: str, date: str, term: str) -> Path:
    """Return the cached pdftotext .txt path for a given case/date/term."""
    year = term.split('-')[0]  # '2010-10' → '2010'
    filename = f'{_case_folder(case_number)}_{date}.txt'
    return _TEXT_CACHE_DIR / year / filename


def _merge_speaker_titles(new_speakers: list,
                           existing_speakers: list,
                           label: str = '') -> list:
    """Carry over manually corrected titles from an existing speakers list.

    For each speaker in *new_speakers* whose name also appears in
    *existing_speakers* with a different title, the existing title wins.
    Warns about any existing speaker whose title contains 'MS.' but whose
    name cannot be matched in *new_speakers*, so gender corrections are
    never silently dropped.
    """
    existing_by_name = {s['name']: s.get('title', '') for s in existing_speakers}
    result = []
    for sp in new_speakers:
        ex_title = existing_by_name.get(sp['name'])
        if ex_title is not None and ex_title != sp.get('title', ''):
            result.append({'name': sp['name'], 'title': ex_title})
        else:
            result.append(sp)
    new_names = {s['name'] for s in new_speakers}
    for sp in existing_speakers:
        if 'MS.' in sp.get('title', '') and sp['name'] not in new_names:
            prefix = f'{label}: ' if label else ''
            print(f'WARNING: {prefix}existing MS. speaker '
                  f'"{sp["name"]}" (title: "{sp["title"]}") '
                  f'not found in reparsed transcript')
    return result


def _non_justice_speakers(transcript_path: Path) -> frozenset[tuple[str, str]]:
    """Return frozenset of (name, title) for non-justice speakers in a transcript file.

    Justice speakers (title in JUSTICE / CHIEF JUSTICE / UNKNOWN JUSTICE) are
    excluded since those are the same in every transcript for a given argument.
    """
    if not transcript_path.exists():
        return frozenset()
    try:
        data = json.loads(transcript_path.read_text(encoding='utf-8'))
    except Exception:
        return frozenset()
    _JUSTICE_TITLES = frozenset({'JUSTICE', 'CHIEF JUSTICE', 'UNKNOWN JUSTICE'})
    return frozenset(
        (sp.get('name', ''), sp.get('title', ''))
        for sp in data.get('media', {}).get('speakers', [])
        if sp.get('title', '') not in _JUSTICE_TITLES
    )


def _title_is_female(title: str) -> bool:
    """Return True when the title signals a female advocate (MS./MRS./MISS)."""
    return 'MS.' in title or 'MRS.' in title or 'MISS' in title


def _speakers_subset(
        ussc_spk: frozenset[tuple[str, str]],
        oyez_spk: frozenset[tuple[str, str]],
) -> bool:
    """Return True when every ussc speaker has a gender-compatible match in oyez.

    Two entries for the same name are gender-compatible when they agree on
    whether the speaker is female (title contains MS./MRS./MISS).  MR. and
    no title are both treated as male/neutral and therefore match each other.
    """
    oyez_by_name: dict[str, list[str]] = {}
    for name, title in oyez_spk:
        oyez_by_name.setdefault(name, []).append(title)
    for name, title in ussc_spk:
        candidates = oyez_by_name.get(name)
        if not candidates:
            return False
        ussc_female = _title_is_female(title)
        if not any(_title_is_female(t) == ussc_female for t in candidates):
            return False
    return True


def _pdf_to_text(pdf_path: Path) -> str:
    """Run pdftotext -layout on *pdf_path* and return the raw text."""
    result = subprocess.run(
        ['pdftotext', '-layout', str(pdf_path), '-'],
        capture_output=True, text=True, check=True,
    )
    return result.stdout


def _parse_raw_text(raw_text: str, output_path: Path,
                    audio_href: str = '', term: str = '',
                    existing_speakers: list | None = None) -> list:
    """Parse the raw pdftotext output, write output_path as JSON, return turns.

    Returns an empty list if the transcript produced no turns (and no speakers),
    and does NOT write output_path in that case (caller should handle cleanup).
    """
    # Pre-pass: build name-resolution tables.
    appearances  = parse_appearances(raw_text)

    tokens = []

    for line in raw_text.split('\n'):
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

    # Resolve each raw speaker token to a canonical (full_name, title) pair.
    raw_to_resolved: dict[str, tuple[str, str]] = {}
    for turn in turns:
        raw = turn['name']
        if raw not in raw_to_resolved:
            name, title = _resolve_speaker(raw, appearances)
            name = ' '.join(name.upper().split())
            raw_to_resolved[raw] = (name, title)

    # Rename turn names to canonical full names.
    for turn in turns:
        turn['name'] = raw_to_resolved[turn['name']][0]

    # Apply rename corrections from speakers.json (e.g. COLLEEN SINZDAK → COLLEEN R. SINZDAK).
    if _RENAME_SPEAKER_MAP:
        for turn in turns:
            turn['name'] = _RENAME_SPEAKER_MAP.get(turn['name'], turn['name'])

    # Normalise generation suffixes ("JR" → ", JR.", "II" → ", II", etc.).
    for turn in turns:
        turn['name'] = _normalize_name_suffix(turn['name'])
    raw_to_resolved = {
        raw: (_normalize_name_suffix(full), title)
        for raw, (full, title) in raw_to_resolved.items()
    }

    # Assign 1-based "turn" IDs (key placed first for readability).
    turns = [{'turn': i + 1, **turn} for i, turn in enumerate(turns)]

    # Build speakers list in first-appearance order, de-duplicated by full name.
    seen_full: dict[str, str] = {}  # full_name → title, insertion-ordered
    for raw_name, (full_name, title) in raw_to_resolved.items():
        renamed = _RENAME_SPEAKER_MAP.get(full_name, full_name)
        if renamed not in seen_full:
            seen_full[renamed] = title
    speakers = [{'name': n, 'title': t} for n, t in seen_full.items()]

    if existing_speakers:
        speakers = _merge_speaker_titles(
            speakers, existing_speakers, output_path.name)

    # If both turns and speakers are empty, there is nothing useful to write.
    # Return an empty list without creating the file.
    if not turns and not speakers:
        return []

    envelope = _build_transcript_envelope(turns, audio_href, speakers)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(envelope, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )
    return turns


def extract_transcript_pdf(pdf_path: Path, output_path: Path,
                            audio_href: str = '', term: str = '') -> list:
    """Run pdftotext on pdf_path, parse speaker turns, write output_path as JSON.

    Speaker names are resolved to canonical form:
    - Justices → full name from justices.json (e.g. ``JOHN G. ROBERTS, JR.``)
      with title ``CHIEF JUSTICE`` or ``JUSTICE``.
    - Advocates → full name from the APPEARANCES section of the transcript
      (e.g. ``STEVEN F. HUBACHEK``) with title from the in-text prefix
      (``MR.``, ``MS.``, ``GENERAL``, etc.).
    """
    return _parse_raw_text(_pdf_to_text(pdf_path), output_path, audio_href, term)


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
                    number = _normalize_number(m.group(1))
                    # Detect original-jurisdiction cases misidentified by the listing
                    # page as "YY-NNN" when the PDF URL basename contains "orig"
                    # (e.g. url .../06-134orig.pdf but text says "06-134").
                    # The canonical form strips the year prefix: "134-Orig".
                    if re.search(r'orig', pdf_url, re.IGNORECASE):
                        yy_nn = re.match(r'^\d{2}-(\d+)$', number)
                        if yy_nn:
                            number = f'{yy_nn.group(1)}-Orig'
                    self.transcripts.append({
                        'number':  number,
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

def fetch_cases_from_url(url: str, year_str: str = '') -> list[dict]:
    """Return a list of {number, title, date, detail_url} dicts scraped from the listing page.

    Falls back to a Wayback Machine snapshot (from around September of the
    following year) when *year_str* is supplied and the live page is unavailable.
    """
    print(f'Fetching {url} ...')
    try:
        html = fetch_html(url)
    except Exception as exc:
        if not year_str:
            raise
        print(f'Live page unavailable ({exc}); trying Wayback Machine ...')
        html = _fetch_html_via_wayback(url, year_str)
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
        print(f'Warning: could not fetch detail page {detail_url}: {exc}')
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


def fetch_transcripts_from_url(url: str, year_str: str = '') -> list[dict]:
    """Return [{number, title, date, pdf_url}] scraped from a transcript listing page.

    Falls back to a Wayback Machine snapshot (from around September of the
    following year) when *year_str* is supplied and the live page is unavailable.
    """
    print(f'Fetching transcript listing from {url} ...')
    try:
        html = fetch_html(url)
    except Exception as exc:
        if not year_str:
            print(f'Warning: could not fetch transcript listing: {exc}')
            return []
        print(f'Live page unavailable ({exc}); trying Wayback Machine ...')
        try:
            html = _fetch_html_via_wayback(url, year_str)
        except Exception as wb_exc:
            print(f'Warning: Wayback fallback also failed: {wb_exc}')
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
        print(f'Warning: could not fetch docket for {number}: {exc}')
        return {}
    return {
        'questions_href': parser.questions_href,
        'proceedings':    parser.proceedings,
    }


# ── Update cases.json ─────────────────────────────────────────────────────────

def _load_term_numbers(cases_path: Path) -> set[str]:
    """Return the set of all individual case numbers (expanded from consolidated)
    recorded in *cases_path*, or an empty set if the file does not exist."""
    if not cases_path.exists():
        return set()
    try:
        data = json.loads(cases_path.read_text(encoding='utf-8'))
    except Exception:
        return set()
    numbers: set[str] = set()
    for c in data:
        for part in c.get('number', '').split(','):
            n = part.strip()
            if n:
                numbers.add(n)
    return numbers


def _load_later_term_numbers(terms_root: Path, year_str: str,
                              lookahead: int = 2) -> dict[str, str]:
    """Return a mapping of case_number → term string for cases already present
    in any of the *lookahead* terms following YYYY-10.

    Used to avoid adding a new case to the current term when it has already been
    moved to a later term (e.g. due to a reargument or a delayed decision).
    """
    result: dict[str, str] = {}
    year = int(year_str)
    for offset in range(1, lookahead + 1):
        later_term = f'{year + offset}-10'
        later_path = terms_root / later_term / 'cases.json'
        for num in _load_term_numbers(later_path):
            if num not in result:   # first (nearest) later term wins
                result[num] = later_term
    return result


# Module-level cache for later-term cases.json data (avoids re-reading the
# same file when multiple cases from the same later term are encountered).
_later_term_data_cache: dict[str, list] = {}


def _check_previously_filed(current_term: str, case_number: str,
                            later_term: str, terms_root: Path) -> None:
    """Verify and fix the 'previouslyFiled' field on a case refiled in a later term.

    Loads *later_term*'s cases.json, finds the entry whose number (or one of
    its comma-separated components) equals *case_number*, then:
      - Warns if 'previouslyFiled' is absent.
      - Fixes 'previouslyFiled' if it is set but lacks the '/<number>' suffix,
        appending the case_number so it becomes '<term>/<number>'.
    """
    later_path = terms_root / later_term / 'cases.json'
    if later_term not in _later_term_data_cache:
        if not later_path.exists():
            return
        try:
            _later_term_data_cache[later_term] = json.loads(
                later_path.read_text(encoding='utf-8'))
        except Exception:
            return
    data = _later_term_data_cache[later_term]
    for case in data:
        nums = [n.strip() for n in case.get('number', '').split(',')]
        if case_number not in nums:
            continue
        pf = case.get('previouslyFiled')
        if not pf:
            print(f'  WARNING: {case_number} appears in {later_term} '
                  f'but previouslyFiled is not set on that entry')
            return
        if '/' not in str(pf):
            fixed = f'{pf}/{case_number}'
            case['previouslyFiled'] = fixed
            print(f'  Fixed previouslyFiled for {case_number} in {later_term}: '
                  f'{pf!r} -> {fixed!r}')
            later_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
        return


def update_cases_json(cases_path: Path, new_cases: list[dict], year: str,
                      later_term_numbers: dict[str, str] | None = None) -> None:
    if cases_path.exists():
        existing = json.loads(cases_path.read_text(encoding='utf-8'))
    else:
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        existing = []

    # Build a lookup from case number → scraped case (with detail_url).
    scraped_by_num = {c['number']: c for c in new_cases}
    # Expand consolidated numbers so "10-238,10-239" covers both "10-238" and "10-239".
    existing_numbers: set[str] = set()
    for c in existing:
        for part in c['number'].split(','):
            existing_numbers.add(part.strip())

    modified = False
    added = []
    terms_root = cases_path.parent.parent
    for case in new_cases:
        if case['number'] in existing_numbers:
            continue
        if later_term_numbers and case['number'] in later_term_numbers:
            found_term = later_term_numbers[case['number']]
            print(f'Skipping {case["number"]} (already in {found_term})')
            _check_previously_filed(year, case['number'], found_term, terms_root)
            continue
        if not ADD_CASES:
            print(f'  WARNING: {case["number"]} ({case.get("date", "?")}) is a new case '
                  f'not in cases.json; pass --cases to add it')
            continue

        print(f'Adding {case["number"]} ({case["date"]}) ...', end=' ', flush=True)
        arg_urls = fetch_argument_urls(case['detail_url'])
        time.sleep(0.3)   # be polite

        title    = _ussc_audio_title('argument', case['date'])
        argument = {'source': 'ussc', 'type': 'argument', 'date': case['date'], 'title': title}
        argument.update(arg_urls)

        if arg_urls:
            status = 'audio+transcript' if 'transcript_href' in arg_urls else 'audio only'
        else:
            status = 'no media URLs found'
        print(status)

        existing.append({
            'title':     case['title'],
            'number':    case['number'],
            'events': [argument],
        })
        added.append(case['number'])

    # Backfill audio_href / transcript_href for existing cases whose arguments
    # are missing them (e.g. the detail URL had a suffix like _2 on first import).
    for case in existing:
        scraped = scraped_by_num.get(case['number'])
        if not scraped or not scraped.get('detail_url'):
            # For consolidated cases, also try to backfill missing audio_href
            # by looking up each component number in the scraped data.
            if ',' in case.get('number', ''):
                for arg in case.get('events', []):
                    if arg.get('source', 'ussc') != 'ussc':
                        continue
                    if arg.get('audio_href') or not arg.get('transcript_href'):
                        continue
                    cn = _ussc_case_num_from_href(arg['transcript_href'])
                    comp_scraped = scraped_by_num.get(cn) if cn else None
                    if not comp_scraped or not comp_scraped.get('detail_url'):
                        continue
                    print(f'Backfilling audio for {case["number"]} ({cn}, {arg.get("date", "?")}) ...', end=' ', flush=True)
                    arg_urls = fetch_argument_urls(comp_scraped['detail_url'])
                    time.sleep(0.3)
                    if arg_urls.get('audio_href'):
                        new_arg: dict = {}
                        for k, v in arg.items():
                            new_arg[k] = v
                            if k == 'title':
                                new_arg['audio_href'] = arg_urls['audio_href']
                        if 'audio_href' not in new_arg:
                            new_arg['audio_href'] = arg_urls['audio_href']
                        arg.clear()
                        arg.update(new_arg)
                        modified = True
                        print('audio_href set')
                    else:
                        print('no audio found')
            continue
        for arg in case.get('events', []):
            if arg.get('source', 'ussc') != 'ussc':
                continue   # only backfill USSC arguments
            if arg.get('transcript_href'):
                continue   # already have supremecourt.gov URLs
            print(f'Backfilling URLs for {case["number"]} ({arg.get("date", "?")}) ...', end=' ', flush=True)
            arg_urls = fetch_argument_urls(scraped['detail_url'])
            time.sleep(0.3)
            if arg_urls:
                # Insert new keys after 'title' rather than appending.
                new_arg = {}
                for k, v in arg.items():
                    new_arg[k] = v
                    if k == 'title':
                        for uk, uv in arg_urls.items():
                            if uk not in new_arg:
                                new_arg[uk] = uv
                for uk, uv in arg_urls.items():
                    if uk not in new_arg:
                        new_arg[uk] = uv
                arg.clear()
                arg.update(new_arg)
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
            _report_change(f'\nAdded {len(added)} case(s) to {cases_path}.')
            if int(year) >= 2001:
                print('Fetching docket info for newly added case(s) ...')
                update_docket_info(cases_path, year, case_numbers=set(added))
    else:
        vprint(f'No new cases to add to {cases_path}')


# ── Step 4: Fetch docket info ────────────────────────────────────────────────────────

def update_docket_info(cases_path: Path, term_year: str = '',
                       case_numbers: set[str] | None = None) -> None:
    """For each case without questions_href, or whose files.json has no petitioner
    entry, fetch the SCOTUS docket page and:
      - Set questions_href in cases.json
      - Append new Proceedings entries to files.json (deduped by href),
        including Petition links marked with type='petitioner'

    If *case_numbers* is provided, only cases whose number appears in that set
    are processed (useful when called immediately after adding new cases).
    """
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    cases_modified = False

    for case in existing:
        number     = case['number']
        if case_numbers is not None and number not in case_numbers:
            continue
        files_path = cases_path.parent / 'cases' / _case_folder(number) / 'files.json'

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

        print(f'Fetching docket for {number} ...', end=' ', flush=True)
        info = fetch_docket_info(number, term_year)
        time.sleep(0.3)

        if not info:
            print('skipped')
            continue

        changed = []

        if info.get('questions_href') and not case.get('questions_href'):
            reordered = reorder_case(dict(case) | {'questions_href': info['questions_href']})
            case.clear()
            case.update(reordered)
            cases_modified = True
            changed.append('questions_href')
            cases_modified = True
            changed.append('questions_href')

        proceedings = info.get('proceedings', [])
        if proceedings:
            case_dir   = cases_path.parent / 'cases' / _case_folder(number)
            files_path = case_dir / 'files.json'
            case_dir.mkdir(parents=True, exist_ok=True)

            if files_path.exists():
                files = json.loads(files_path.read_text(encoding='utf-8'))
            else:
                files = []

            existing_hrefs = {f['href'] for f in files if 'href' in f}
            # transcript_href values are already on audio objects; don't duplicate them.
            audio_transcript_hrefs = {
                a.get('transcript_href')
                for a in case.get('events', [])
                if a.get('transcript_href')
            }
            next_file_id = max((f.get('file', 0) for f in files), default=0) + 1
            added = 0
            for p in proceedings:
                if p['href'] in audio_transcript_hrefs:
                    continue   # already recorded as transcript_href on an audio object
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
        _report_change('Updated cases.json with questions_href entries.')


# ── Step 3: Generate missing transcripts ─────────────────────────────────────


def generate_missing_transcripts(cases_path: Path,
                                  case_filter: str | None = None,
                                  force: bool = False) -> None:
    """For each argument with a transcript_href and no YYYY-MM-DD.json yet,
    download the PDF, extract turns, write the JSON, and update text_href.

    If *case_filter* is set (a case number string), only that case is processed
    and any existing transcript JSON for it is overwritten (useful for testing).
    If *force* is True, all transcripts are reparsed even if they already exist.
    """
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    term     = cases_path.parent.name  # e.g. "2010-10"
    modified = False

    # ── Collision pre-pass ──────────────────────────────────────────────────
    # When two or more ussc argument events on the same date exist within one
    # case and would map to the same output file, either:
    #   (a) assign numbered suffixes (-1.json, -2.json, …) when both transcripts
    #       share the same component case folder, OR
    #   (b) route each transcript to its own component folder without any suffix
    #       when each transcript_href encodes a distinct, valid component number
    #       (e.g. 13-1074_k4m8.pdf vs 13-1075_ap6c.pdf → 13-1074/ vs 13-1075/).
    for case in existing:
        if 'number' not in case:
            continue
        if case_filter and case_filter not in [n.strip() for n in case['number'].split(',')]:
            continue
        folder = _case_folder(case['number'])
        _case_norms = [_normalize_number(n.strip()) for n in case['number'].split(',')]
        by_date: dict[str, list] = {}
        for arg in case.get('events', []):
            if arg.get('source', 'ussc') != 'ussc':
                continue
            if arg.get('type') not in (None, 'argument', 'reargument'):
                continue
            if not arg.get('transcript_href') or not arg.get('date'):
                continue
            by_date.setdefault(arg['date'], []).append(arg)
        for date_key, args in by_date.items():
            if len(args) < 2:
                continue
            # Determine whether each arg maps to a distinct component folder.
            comp_nums = [
                _ussc_case_num_from_href(arg.get('transcript_href', ''))
                for arg in args
            ]
            all_distinct = (
                all(cn and cn in _case_norms for cn in comp_nums)
                and len(set(comp_nums)) == len(comp_nums)
            )
            _deleted: set[Path] = set()
            if all_distinct:
                # Each transcript belongs to a different component case folder —
                # no suffix needed; files naturally avoid collisions.
                for arg, cn in zip(args, comp_nums):
                    new_th = f'{cn}/{date_key}.json'
                    if arg.get('text_href') != new_th:
                        old_th = arg.get('text_href', '')
                        if old_th:
                            old_file = cases_path.parent / 'cases' / old_th
                            # Remove any old -N suffixed file so the main loop
                            # re-extracts into the correct unsuffixed path.
                            if (old_file not in _deleted
                                    and old_file.exists()):
                                old_file.unlink()
                                _deleted.add(old_file)
                        arg['text_href'] = new_th
                        modified = True
            else:
                # Fallback: same component folder — use numbered suffixes.
                for i, arg in enumerate(args, start=1):
                    new_th = f'{folder}/{date_key}-{i}.json'
                    if arg.get('text_href') != new_th:
                        old_th = arg.get('text_href', '')
                        if old_th:
                            old_file = cases_path.parent / 'cases' / old_th
                            # Remove the old generic (non-numbered) file so the
                            # main loop is forced to re-extract into the numbered file.
                            if (old_file not in _deleted
                                    and old_file.exists()
                                    and old_file.name == f'{date_key}.json'):
                                old_file.unlink()
                                _deleted.add(old_file)
                        arg['text_href'] = new_th
                        modified = True

        if 'number' not in case:
            continue   # skip cases without a docket number (e.g. Oyez-only entries)
        if case_filter and case_filter not in [n.strip() for n in case['number'].split(',')]:
            continue

        for arg in case.get('events', []):
            if arg.get('source', 'ussc') != 'ussc':
                continue   # only extract from USSC transcripts
            if arg.get('redundant'):
                continue   # previously found identical to oyez — do not recreate
            pdf_url = arg.get('transcript_href')
            date    = arg.get('date')
            if not pdf_url or not date:
                continue

            # Determine which component folder this transcript belongs to.
            # Use the folder prefix from an existing text_href if present;
            # otherwise extract the case number from the transcript PDF URL.
            _existing_th  = arg.get('text_href', '')
            component_num = _ussc_case_num_from_href(pdf_url, _existing_th)
            _case_norms   = [_normalize_number(n.strip()) for n in case['number'].split(',')]
            if not component_num or component_num not in _case_norms:
                component_num = _case_folder(case['number'])

            # Skip archived-format transcripts only when no cached text exists;
            # if a cached .txt file is present we can parse without downloading.
            if '/pdfs/transcripts/' in pdf_url:
                if not _cached_text_path(component_num, date, term).exists():
                    continue

            case_dir       = cases_path.parent / 'cases' / component_num
            transcript_out = case_dir / f'{date}.json'
            # Also check whether the file the existing text_href points to exists
            # (the user may have renamed it from the default date.json name).
            _th_file = (cases_path.parent / 'cases' / _existing_th) if _existing_th else None
            # If text_href records a specific (possibly numbered) output path,
            # write there instead of the default date.json.
            if _th_file is not None:
                transcript_out = _th_file

            # Skip if already generated and text_href is recorded, unless overwrite is requested.
            if _existing_th and not case_filter and not force:
                if transcript_out.exists() or (_th_file and _th_file.exists()):
                    continue

            print(f'Extracting {case["number"]} ({date})', end='', flush=True)

            # Preserve any manually corrected titles from an existing transcript.
            _existing_speakers: list | None = None
            if transcript_out.exists():
                try:
                    _ex = json.loads(transcript_out.read_text(encoding='utf-8'))
                    _existing_speakers = _ex.get('media', {}).get('speakers') or None
                except Exception:
                    pass

            # Use cached pdftotext output when available to avoid re-downloading.
            cached_txt = _cached_text_path(component_num, date, term)
            audio_href = arg.get('audio_href', '')
            tmp_path   = None
            cache_tag  = ''
            try:
                if cached_txt.exists():
                    cache_tag = ' (cached)'
                    raw_text  = cached_txt.read_text(encoding='utf-8', errors='replace')
                    turns     = _parse_raw_text(raw_text, transcript_out,
                                                audio_href, term, _existing_speakers)
                else:
                    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
                        tmp_path = Path(tmp.name)
                    download_file(pdf_url, tmp_path)
                    raw_text = _pdf_to_text(tmp_path)
                    # Save to cache so future runs skip the download.
                    cached_txt.parent.mkdir(parents=True, exist_ok=True)
                    cached_txt.write_text(raw_text, encoding='utf-8')
                    turns = _parse_raw_text(raw_text, transcript_out,
                                            audio_href, term, _existing_speakers)
                    time.sleep(0.3)

                print(f'{cache_tag}: {len(turns)} turns -> {transcript_out.relative_to(REPO_ROOT)}')

                if not turns:
                    # Empty transcript — remove any stale file and clear text_href.
                    if transcript_out.exists():
                        transcript_out.unlink()
                        print(f'Deleted empty transcript: {transcript_out.relative_to(REPO_ROOT)}')
                    if arg.get('text_href'):
                        del arg['text_href']
                        modified = True
                    continue

                new_text_href = f'{component_num}/{date}.json'
                if not arg.get('text_href'):
                    arg['text_href'] = new_text_href
                    modified = True

            except subprocess.CalledProcessError as exc:
                print(f'ERROR (pdftotext): {exc.stderr.strip()}')
            except Exception as exc:
                print(f'ERROR: {exc}')
            finally:
                if tmp_path and tmp_path.exists():
                    tmp_path.unlink()

    # ── Supplementary pass: backfill/strip "in No. N" for consolidated cases ──
    # Only add the case number to the title when multiple component numbers each
    # have a USSC transcript (so the titles are actually ambiguous without it).
    for case in existing:
        if 'number' not in case:
            continue   # skip cases without a docket number (e.g. Oyez-only entries)
        if case_filter and case_filter not in [n.strip() for n in case['number'].split(',')]:
            continue
        if ',' not in case.get('number', ''):
            continue
        comps = [_normalize_number(n.strip()) for n in case['number'].split(',')]
        # Use case numbers in titles when multiple USSC argument events share the
        # same date — they must each be for a different component, so the titles
        # would be ambiguous without the case number.  Counting by date is more
        # reliable than inspecting href paths (text_href folders may be shared).
        _date_counts: dict[str, int] = {}
        for a in case.get('events', []):
            if a.get('source', 'ussc') != 'ussc':
                continue
            if a.get('type') not in (None, 'argument', 'reargument'):
                continue
            d = a.get('date', '')
            _date_counts[d] = _date_counts.get(d, 0) + 1
        use_case_nums = any(v > 1 for v in _date_counts.values())
        for a in case.get('events', []):
            if a.get('source', 'ussc') != 'ussc':
                continue
            if a.get('type') not in (None, 'argument', 'reargument'):
                continue
            title = a.get('title') or ''
            # Prefer transcript_href for component-number extraction; text_href
            # folders may be shared across components of a consolidated case.
            cn = _ussc_case_num_from_href(a.get('transcript_href', ''))
            if not (cn and cn in comps):
                cn = _ussc_case_num_from_href('', a.get('text_href', ''))
            if not (cn and cn in comps):
                continue
            type_v = a.get('type') or 'argument'
            date_v = a.get('date', '')
            # Only rewrite titles that are auto-generated (match our standard pattern).
            # Preserve any title the user has customised.
            auto_with    = _ussc_audio_title(type_v, date_v, cn)
            auto_without = _ussc_audio_title(type_v, date_v, '')
            # Also treat as auto-generated any title that uses a *different* component
            # number from this consolidated case (i.e. was auto-generated but wrong).
            is_auto = (title in (auto_with, auto_without)
                       or any(title == _ussc_audio_title(type_v, date_v, other_cn)
                              for other_cn in comps if other_cn != cn))
            if not is_auto:
                continue
            if use_case_nums and a.get('title') != auto_with:
                a['title'] = auto_with
                modified = True
            elif not use_case_nums and a.get('title') != auto_without:
                a['title'] = auto_without
                modified = True

    if modified:
        cases_path.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        _report_change('Updated cases.json with new text_href entries.')


def _ensure_event_transcript(cases_path: Path, case: dict, arg: dict, term: str) -> bool:
    """Ensure the transcript JSON file and text_href exist for a single ussc event.

    Modifies *arg* in place (sets text_href) but does NOT save cases.json —
    the caller must save after all events have been processed.
    Returns True when text_href is set and the corresponding file exists.
    """
    if not arg.get('transcript_href') or not arg.get('date'):
        return False
    existing_th = arg.get('text_href', '')
    if existing_th:
        th_file = cases_path.parent / 'cases' / existing_th
        if th_file.exists():
            return True
    pdf_url       = arg['transcript_href']
    date          = arg['date']
    case_norms    = [_normalize_number(n.strip()) for n in case['number'].split(',')]
    component_num = _ussc_case_num_from_href(pdf_url, existing_th)
    if not component_num or component_num not in case_norms:
        component_num = _case_folder(case['number'])
    # Archived transcripts without a cached text file cannot be extracted here.
    if '/pdfs/transcripts/' in pdf_url:
        if not _cached_text_path(component_num, date, term).exists():
            return False
    transcript_out = (
        (cases_path.parent / 'cases' / existing_th)
        if existing_th
        else (cases_path.parent / 'cases' / component_num / f'{date}.json')
    )
    print(f'  Extracting {case["number"]} ({date})', end='', flush=True)
    existing_speakers: list | None = None
    if transcript_out.exists():
        try:
            ex = json.loads(transcript_out.read_text(encoding='utf-8'))
            existing_speakers = ex.get('media', {}).get('speakers') or None
        except Exception:
            pass
    cached_txt = _cached_text_path(component_num, date, term)
    audio_href  = arg.get('audio_href', '')
    tmp_path: Path | None = None
    try:
        if cached_txt.exists():
            raw_text = cached_txt.read_text(encoding='utf-8', errors='replace')
            turns    = _parse_raw_text(raw_text, transcript_out, audio_href, term,
                                       existing_speakers)
        else:
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
                tmp_path = Path(tmp.name)
            download_file(pdf_url, tmp_path)
            raw_text = _pdf_to_text(tmp_path)
            cached_txt.parent.mkdir(parents=True, exist_ok=True)
            cached_txt.write_text(raw_text, encoding='utf-8')
            turns = _parse_raw_text(raw_text, transcript_out, audio_href, term,
                                    existing_speakers)
            time.sleep(0.3)
        if not turns:
            if transcript_out.exists():
                transcript_out.unlink()
            if arg.get('text_href'):
                del arg['text_href']
            print(' (empty — skipped)')
            return False
        print(f': {len(turns)} turns -> {transcript_out.relative_to(REPO_ROOT)}')
        if not arg.get('text_href'):
            arg['text_href'] = f'{component_num}/{date}.json'
        return True
    except subprocess.CalledProcessError as exc:
        print(f' ERROR (pdftotext): {exc.stderr.strip()}')
        return False
    except Exception as exc:
        print(f' ERROR: {exc}')
        return False
    finally:
        if tmp_path and tmp_path.exists():
            tmp_path.unlink()


# ── Step 3b: Migrate old-format transcripts ──────────────────────────────────


def migrate_transcripts(cases_path: Path) -> None:
    """Convert any transcript JSON that is a bare array (old format) to the
    new envelope format {media: {url, speakers}, turns: […]}."""
    existing = json.loads(cases_path.read_text(encoding='utf-8'))

    # Build a lookup of audio_href by (number, date) so we can populate media.url.
    audio_map: dict[tuple, str] = {}
    for case in existing:
        if 'number' not in case:
            continue
        for arg in case.get('events', []):
            key = (case['number'], arg.get('date', ''))
            audio_map[key] = arg.get('audio_href', '')

    total = 0
    for case in existing:
        if 'number' not in case:
            continue
        number = case['number']
        case_dir = cases_path.parent / 'cases' / _case_folder(number)
        for arg in case.get('events', []):
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
                print(f'Migrated {rel}')
                total += 1

    if not total:
        vprint('All transcripts already in new format.')
    else:
        _report_change(f'  Migrated {total} transcript(s).')


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
            _report_change(f'  Cleaned {files_path.relative_to(REPO_ROOT)}')

    if not total_changed:
        vprint('Nothing to clean.')


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
        print(f'Extracting questions for {number} ...', end=' ', flush=True)

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
                reordered = reorder_case(dict(case) | {'questions': questions})
                case.clear()
                case.update(reordered)
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
        _report_change('Updated cases.json with questions.')
    else:
        vprint('Nothing to extract.')


# ── Step 2b: Import transcript PDFs from supremecourt.gov listing ─────────────


def _find_case_in_later_terms(
        terms_root: Path,
        current_year: str,
        row_norm: str,
        row_date: str,
        lookahead: int = 2,
) -> 'tuple[str, dict, list, Path] | None':
    """Search up to *lookahead* subsequent terms for a case matching both
    *row_norm* (docket number) and *row_date* (in argument/reargument fields,
    or in existing event dates when those fields are not yet set).

    Returns ``(term_str, case_obj, all_cases, cases_path)`` or ``None``.
    """
    year = int(current_year)
    for offset in range(1, lookahead + 1):
        check_term = f'{year + offset}-10'
        cp = terms_root / check_term / 'cases.json'
        if not cp.exists():
            continue
        try:
            cases = json.loads(cp.read_text(encoding='utf-8'))
        except Exception:
            continue
        for case in cases:
            if 'number' not in case:
                continue
            case_norms = [_normalize_number(n.strip()) for n in case['number'].split(',')]
            if row_norm not in case_norms:
                continue
            # Collect all known argument/reargument dates.
            arg_dates: set[str] = set()
            for field in ('argument', 'reargument'):
                v = case.get(field)
                if isinstance(v, str):
                    arg_dates.add(v)
                elif isinstance(v, list):
                    arg_dates.update(v)
            # Fallback to event dates when top-level fields are not yet populated.
            if not arg_dates:
                for ev in case.get('events', []):
                    if ev.get('type') in (None, 'argument', 'reargument') and ev.get('date'):
                        arg_dates.add(ev['date'])
            if row_date in arg_dates:
                return check_term, case, cases, cp
    return None


def _compare_single_ussc_event(
        cases_path: Path,
        all_cases: list,
        case: dict,
        arg: dict,
        term: str,
) -> bool:
    """Compare non-justice speakers in a ussc transcript with the matching oyez
    transcript for the same date.

    * Same speaker set → ussc file is redundant: deleted, text_href removed.
    * Different speaker set → oyez then ussc speakers are printed, user prompted
      whether to retain the ussc transcript (default: retain).

    Modifies *arg* in place but does NOT save cases.json — caller is responsible.
    Returns True if *arg* was modified (text_href removed).
    """
    ussc_th = arg.get('text_href', '')
    date    = arg.get('date', '')
    if not ussc_th or not date:
        return False
    # Find a matching oyez event for the same date that also has a transcript.
    oyez_ev = next(
        (ev for ev in case.get('events', [])
         if ev.get('source') == 'oyez'
         and ev.get('date') == date
         and ev.get('text_href')),
        None,
    )
    if not oyez_ev:
        return False
    ussc_path = cases_path.parent / 'cases' / ussc_th
    oyez_path = cases_path.parent / 'cases' / oyez_ev['text_href']
    ussc_spk  = _non_justice_speakers(ussc_path)
    oyez_spk  = _non_justice_speakers(oyez_path)
    if not ussc_spk and not oyez_spk:
        return False
    if _speakers_subset(ussc_spk, oyez_spk):
        if ussc_path.exists():
            ussc_path.unlink()
        del arg['text_href']
        arg['redundant'] = True
        print(f'{case["number"]} ({date}): ussc transcript deleted (redundant with oyez)')
        return True
    # Speakers differ — show both sets and ask the user.
    print(f'\n{case["number"]} ({date}): ussc and oyez non-justice speakers differ:')
    print('  oyez:')
    for name, title in sorted(oyez_spk):
        print(f'    [{title}] {name}' if title else f'    {name}')
    print('  ussc:')
    for name, title in sorted(ussc_spk):
        # Check whether this speaker has a gender-compatible match in oyez.
        candidates = [t for (n, t) in oyez_spk if n == name]
        matched = any(_title_is_female(t) == _title_is_female(title) for t in candidates)
        suffix = ' (matched)' if matched else ''
        print(f'    [{title}] {name}{suffix}' if title else f'    {name}{suffix}')
    ans = input('Retain ussc transcript? [Y/n] ').strip().lower()
    if ans in ('n', 'no'):
        if ussc_path.exists():
            ussc_path.unlink()
        del arg['text_href']
        arg['redundant'] = True
        print('  ussc transcript deleted.')
        return True
    return False


def import_transcript_pdfs(cases_path: Path, year_str: str,
                            later_term_numbers: dict[str, str] | None = None) -> None:
    """Match PDF transcripts from the supremecourt.gov listing page to cases in
    cases.json.  For each ussc audio entry lacking transcript_href, set it from
    the listing.
    Cases present on the listing but missing from cases.json are created,
    unless they already appear in the next term."""

    url = _transcript_listing_url(year_str)
    transcripts = fetch_transcripts_from_url(url, year_str)
    if not transcripts:
        print('No transcripts found on listing page.')
        return
    print(f'Found {len(transcripts)} transcript(s).')

    # Build lookup: normalized number -> list of {date, title, pdf_url}
    by_number: dict[str, list[dict]] = {}
    for t in transcripts:
        by_number.setdefault(t['number'], []).append(t)

    if not cases_path.exists():
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        cases_path.write_text('[]\n', encoding='utf-8')
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    cases_modified = False
    current_term   = cases_path.parent.name  # e.g. '2025-10'
    # (cases_path, all_cases, case, arg, term) for each newly matched/created event
    _newly_matched: list[tuple[Path, list, dict, dict, str]] = []
    # later-term cases.json files modified this run: Path → (term_str, cases_list)
    later_modified: dict[Path, tuple[str, list]] = {}

    # Pass 1: match existing cases
    matched_rows: set[tuple[str, str]] = set()  # (number, date) pairs handled
    for case in existing:
        if 'number' not in case:
            continue   # skip cases without a docket number (e.g. Oyez-only entries)
        # For consolidated cases (e.g. "00-832,00-843") check each component.
        case_norms = [_normalize_number(n) for n in case['number'].split(',')]
        seen_row_keys: set[tuple] = set()
        rows = []
        for cn in case_norms:
            for r in by_number.get(cn, []):
                k = (r['number'], r['date'])
                if k not in seen_row_keys:
                    seen_row_keys.add(k)
                    rows.append(r)
        if not rows:
            continue
        for row in rows:
            key = (row['number'], row['date'])
            matched_rows.add(key)
            # Assign transcript_href to any ussc audio entry with a matching date.
            assigned = False
            row_comp = _normalize_number(row['number'])
            for arg in case.get('events', []):
                if arg.get('source', 'ussc') != 'ussc':
                    continue   # never modify oyez/nara objects
                if arg.get('type') not in (None, 'argument', 'reargument'):
                    continue
                arg_date = arg.get('date', '')
                if not (arg_date == row['date'] or (not arg_date and len(rows) == 1)):
                    continue
                # For consolidated cases, also verify component number alignment:
                # an existing audio object whose transcript_href (or text_href)
                # belongs to a *different* component should not absorb this row.
                if len(case_norms) > 1:
                    existing_comp = _ussc_case_num_from_href(
                        arg.get('transcript_href', ''), arg.get('text_href', ''))
                    if existing_comp and existing_comp != row_comp:
                        continue  # this entry belongs to a different component
                # A ussc audio object for this date+component already exists.
                assigned = True
                if arg.get('transcript_href'):
                    break   # already has a transcript_href — nothing to do
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
                _newly_matched.append((cases_path, existing, case, arg, current_term))
                cases_modified = True
                print(f'{case["number"]} ({row["date"]}): transcript_href added')
                break

            # No ussc audio object existed for this date — create one without audio_href.
            if not assigned:
                audio_list: list = case.setdefault('events', [])
                # Guard against duplicates (e.g. from a previous partial run).
                already = any(
                    a.get('source', 'ussc') == 'ussc'
                    and a.get('date') == row['date']
                    and a.get('transcript_href') == row['pdf_url']
                    for a in audio_list
                )
                if not already:
                    # Use "in No. N" only when multiple components have transcripts.
                    _ussc_comps_with_transcripts = {
                        cn for cn in case_norms if by_number.get(cn)
                    }
                    _case_num_for_title = (
                        row['number'] if len(_ussc_comps_with_transcripts) > 1 else ''
                    )
                    title = _ussc_audio_title('argument', row['date'], _case_num_for_title)
                    new_audio = reorder_event({'source': 'ussc', 'type': 'argument',
                                               'date': row['date'], 'title': title,
                                               'transcript_href': row['pdf_url']})
                    audio_list.append(new_audio)
                    case['events'] = sorted(audio_list, key=lambda a: a.get('date') or '')
                    _newly_matched.append((cases_path, existing, case, new_audio, current_term))
                    cases_modified = True
                    print(f'{case["number"]} ({row["date"]}): created transcript-only audio object')

    # Pass 2: create new cases for unmatched transcripts
    # Include all components of multi-number cases so e.g. "00-832" is recognised
    # as already present when "00-832,00-843" exists.
    existing_numbers: set[str] = set()
    for c in existing:
        if 'number' not in c:
            continue
        for n in c['number'].split(','):
            existing_numbers.add(_normalize_number(n.strip()))
    new_by_num: dict[str, list[dict]] = {}
    terms_root = cases_path.parent.parent
    for row in transcripts:
        key = (row['number'], row['date'])
        if key not in matched_rows and row['number'] not in existing_numbers:
            row_norm = _normalize_number(row['number'])
            # Search subsequent terms for a case matching both number and argument date.
            later_match = _find_case_in_later_terms(
                terms_root, year_str, row_norm, row['date'])
            if later_match:
                lt_str, lt_case, lt_cases, lt_cp = later_match
                lt_assigned = False
                for lt_arg in lt_case.get('events', []):
                    if lt_arg.get('source', 'ussc') != 'ussc':
                        continue
                    if lt_arg.get('type') not in (None, 'argument', 'reargument'):
                        continue
                    if lt_arg.get('date') != row['date']:
                        continue
                    lt_assigned = True
                    if not lt_arg.get('transcript_href'):
                        lt_insert = 'audio_href' if 'audio_href' in lt_arg else 'date'
                        new_lt: dict = {}
                        _ins = False
                        for k, v in lt_arg.items():
                            new_lt[k] = v
                            if not _ins and k == lt_insert:
                                new_lt['transcript_href'] = row['pdf_url']
                                _ins = True
                        if not _ins:
                            new_lt['transcript_href'] = row['pdf_url']
                        lt_arg.clear()
                        lt_arg.update(new_lt)
                        later_modified[lt_cp] = (lt_str, lt_cases)
                        _newly_matched.append((lt_cp, lt_cases, lt_case, lt_arg, lt_str))
                        print(f'{lt_case["number"]} ({row["date"]}): '
                              f'transcript_href added in {lt_str}')
                    break
                if not lt_assigned:
                    lt_title = _ussc_audio_title('argument', row['date'])
                    lt_ev = reorder_event({'source': 'ussc', 'type': 'argument',
                                           'date': row['date'], 'title': lt_title,
                                           'transcript_href': row['pdf_url']})
                    lt_case.setdefault('events', []).append(lt_ev)
                    lt_case['events'] = sorted(lt_case['events'],
                                               key=lambda a: a.get('date') or '')
                    later_modified[lt_cp] = (lt_str, lt_cases)
                    _newly_matched.append((lt_cp, lt_cases, lt_case, lt_ev, lt_str))
                    print(f'{lt_case["number"]} ({row["date"]}): '
                          f'transcript event created in {lt_str}')
                matched_rows.add(key)
                continue
            if later_term_numbers and row['number'] in later_term_numbers:
                found_term = later_term_numbers[row['number']]
                print(f'Skipping {row["number"]} (already in {found_term})')
                _check_previously_filed(year_str, row['number'], found_term, terms_root)
                continue
            if not ADD_CASES:
                print(f'  WARNING: {row["number"]} is a new case '
                      f'not in cases.json; pass --cases to add it')
                continue
            new_by_num.setdefault(row['number'], []).append(row)

    for norm, rows in sorted(new_by_num.items()):
        title = rows[0]['title']
        audio_entries = [
            reorder_event({'source': 'ussc', 'type': 'argument',
                           'date': r['date'],
                           'title': _ussc_audio_title('argument', r['date']),
                           'transcript_href': r['pdf_url']})
            for r in rows
        ]
        new_case = {'title': title, 'number': norm, 'events': audio_entries}
        existing.append(new_case)
        existing_numbers.add(norm)
        for _new_ev in audio_entries:
            _newly_matched.append((cases_path, existing, new_case, _new_ev, current_term))
        cases_modified = True
        _report_change(f'  {norm}: new case added with {len(audio_entries)} audio entry(ies)')

    if cases_modified:
        cases_path.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        _report_change('  Updated cases.json.')
        new_numbers = set(new_by_num.keys())
        if new_numbers:
            year_str_int = int(cases_path.parent.name.split('-')[0])
            if year_str_int >= 2001:
                print('Fetching docket info for newly added case(s) ...')
                update_docket_info(cases_path, str(year_str_int), case_numbers=new_numbers)
    else:
        vprint('No changes needed.')

    # Save any later-term cases.json files that were modified.
    for lt_cp, (lt_str, lt_cases) in later_modified.items():
        lt_cp.write_text(
            json.dumps(lt_cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        _report_change(f'  Updated {lt_str}/cases.json.')
        lt_year_int  = int(lt_str.split('-')[0])
        lt_new_nums  = {c['number'] for (xcp, _, c, _, _) in _newly_matched
                        if xcp == lt_cp and 'number' in c}
        if lt_year_int >= 2001 and lt_new_nums:
            print(f'Fetching docket info for newly added {lt_str} case(s) ...')
            update_docket_info(lt_cp, str(lt_year_int), case_numbers=lt_new_nums)

    if not _newly_matched:
        return

    # ── Ensure text_href + compare ussc vs oyez speakers ─────────────────────
    # For each newly matched or created event ensure the transcript JSON file
    # exists, then compare non-justice speakers with any oyez transcript for
    # the same date.  Redundant ussc transcripts are deleted automatically;
    # differing ones prompt the user.
    _unique_cps: dict[Path, tuple[list, str]] = {}
    for (cp, cl, _c, _a, t) in _newly_matched:
        _unique_cps.setdefault(cp, (cl, t))

    _ensure_changed: set[Path] = set()
    for (cp, cl, c, a, t) in _newly_matched:
        if _ensure_event_transcript(cp, c, a, t):
            _ensure_changed.add(cp)
    for cp in _ensure_changed:
        cl, _t = _unique_cps[cp]
        cp.write_text(json.dumps(cl, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        _report_change(f'  Updated {cp.parent.name}/cases.json with text_href.')

    _compare_changed: set[Path] = set()
    for (cp, cl, c, a, t) in _newly_matched:
        if a.get('text_href') and _compare_single_ussc_event(cp, cl, c, a, t):
            _compare_changed.add(cp)
    for cp in _compare_changed:
        cl, _t = _unique_cps[cp]
        cp.write_text(json.dumps(cl, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        _report_change(f'  Updated {cp.parent.name}/cases.json after speaker comparison.')


# ── Step 3c: Compare ussc vs oyez speakers ───────────────────────────────────


def compare_ussc_oyez_speakers(cases_path: Path,
                                case_filter: str | None = None) -> None:
    """For every ussc event that has a text_href (and is not already marked
    redundant), compare non-justice speakers with any same-date oyez transcript.

    Identical speaker sets → ussc file deleted, event marked ``redundant: true``.
    Differing speaker sets → both sets printed; user prompted to retain or delete.

    If *case_filter* is set, only that case (or consolidated case containing that
    number) is processed.
    """
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    term     = cases_path.parent.name
    modified = False

    for case in existing:
        if 'number' not in case:
            continue
        if case_filter:
            case_norms = [_normalize_number(n.strip()) for n in case['number'].split(',')]
            if _normalize_number(case_filter) not in case_norms:
                continue
        for arg in case.get('events', []):
            if arg.get('source', 'ussc') != 'ussc':
                continue
            if arg.get('redundant'):
                continue   # already handled in a previous run
            if not arg.get('text_href'):
                continue
            if _compare_single_ussc_event(cases_path, existing, case, arg, term):
                modified = True

    if modified:
        cases_path.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        _report_change('Updated cases.json after ussc/oyez speaker comparison.')
    else:
        vprint('No redundant ussc transcripts found.')


# ── Step 7: Add / update opinion_href ───────────────────────────────────────


def upgrade_dead_opinion_hrefs(cases_path: Path) -> None:
    """Check every existing opinion_href in cases.json; replace any that return
    404 with a working Wayback Machine URL.

    The #page=N fragment (if present) is preserved in the replacement URL.
    Each unique base PDF URL is probed only once to keep network calls minimal.
    """
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    cases_modified = False

    # Cap Wayback snapshots to the end of the term (Sept 30 of the following year).
    # Opinions for a YYYY-10 term run through roughly June of YYYY+1; a snapshot
    # from after September YYYY+1 may capture a revised or superseded document.
    try:
        term_year = int(cases_path.parent.name.split('-')[0])
        wayback_max_ts = f'{term_year + 1}0930235959'
    except (ValueError, IndexError):
        wayback_max_ts = ''

    # Collect all unique base URLs that need checking.
    # loc.gov URLs are not archived on Wayback; handle them separately below.
    base_urls: set[str] = set()
    for case in data:
        href = case.get('opinion_href', '')
        if href and not href.startswith('https://web.archive.org/') and 'loc.gov' not in href:
            base_urls.add(href.split('#')[0])

    if not base_urls:
        vprint('No live opinion_href values to verify.')
    else:
        # Probe each base URL once.
        replacements: dict[str, str] = {}  # base_url -> wayback_url or '' (still live)
        for base in sorted(base_urls):
            ok, _ = _check_url(base)
            if ok:
                replacements[base] = ''   # still live — nothing to do
            else:
                wb = _wayback_pdf_url(base, wayback_max_ts)
                if wb:
                    print(f'PDF 404 — upgrading to Wayback: {base}')
                else:
                    print(f'PDF 404 — no Wayback snapshot found: {base}')
                replacements[base] = wb

        # Apply replacements to cases.json.
        for case in data:
            href = case.get('opinion_href', '')
            if not href or href.startswith('https://web.archive.org/'):
                continue
            if 'loc.gov' in href:
                continue
            base = href.split('#')[0]
            frag = href[len(base):]   # '' or '#page=N'
            wb = replacements.get(base, '')
            if wb:
                case['opinion_href'] = wb + frag
                cases_modified = True

    # For loc.gov opinion_hrefs, check liveness; if dead rename to opinion_href_bad.
    for case in data:
        href = case.get('opinion_href', '')
        if not href or 'loc.gov' not in href:
            continue
        ok, _ = _check_url(href.split('#')[0])
        if not ok:
            print(f'loc.gov URL invalid — marking as opinion_href_bad: {href}')
            del case['opinion_href']
            case['opinion_href_bad'] = href
            cases_modified = True

    if cases_modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        _report_change('Updated cases.json: replaced dead opinion_href values.')
    else:
        vprint('All opinion_href values are reachable.')



def backfill_opinion_hrefs(cases_path: Path, term: str) -> None:
    """Set or update opinion_href in cases.json for each case with a matching
    slip opinion.

    For terms 2017-10 onward, opinions are fetched directly from
    supremecourt.gov.  For earlier terms (down to 2012-10), the Wayback
    Machine is used as a fallback via _fetch_opinions_via_wayback() —
    using only snapshots dated at least 12 months after the term start.

    Also updates the corresponding files.json entry (type='opinion') for
    any case that already has a files.json.
    """
    year_2 = term.split('-')[0][-2:]  # '2015-10' → '15'
    opinions = _fetch_opinions(year_2)
    if not opinions:
        print('No slip opinions found.')
        return

    data = json.loads(cases_path.read_text(encoding='utf-8'))
    cases_modified = False

    for case in data:
        number = case.get('number', '')
        if not number:
            continue

        # For consolidated cases (e.g. '00-832,00-843') check each component.
        opinion = None
        for part in number.split(','):
            opinion = opinions.get(part.strip().lower())
            if opinion:
                break
        if not opinion:
            continue

        href = opinion['href']
        existing_href = case.get('opinion_href', '')
        # Don't overwrite an existing Wayback URL — it was chosen deliberately
        # (either by the user or by upgrade_dead_opinion_hrefs) and is likely a
        # better snapshot than the one extracted from the index page.
        if existing_href.startswith('https://web.archive.org/'):
            continue
        # Don't overwrite a case that has been marked as having a bad opinion_href.
        if case.get('opinion_href_bad'):
            continue
        if existing_href != href:
            # Insert opinion_href immediately before 'files', replacing any
            # existing value so the key stays in the canonical position.
            new_case: dict = {}
            inserted = False
            for k, v in case.items():
                if k == 'files' and not inserted:
                    new_case['opinion_href'] = href
                    inserted = True
                if k != 'opinion_href':
                    new_case[k] = v
            if not inserted:
                new_case['opinion_href'] = href
            case.clear()
            case.update(new_case)
            cases_modified = True
            print(f'  {number}: opinion_href → {href}')

        # Also add/update the files.json opinion entry if the file exists.
        files_path = cases_path.parent / 'cases' / _case_folder(number) / 'files.json'
        if files_path.exists():
            check_opinion_for_case(files_path, number, term)

    if cases_modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        _report_change('Updated cases.json with opinion_href entries.')
    else:
        vprint('opinion_href values already up to date.')


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    global VERBOSE, _any_changes, ADD_CASES, CHECK_URLS
    _any_changes  = False
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    fetch_docket  = '--docket'    in sys.argv
    force_reparse = '--reparse'   in sys.argv
    VERBOSE       = '--verbose'   in sys.argv
    ADD_CASES     = '--cases'     in sys.argv
    CHECK_URLS    = '--checkurls' in sys.argv

    if len(args) < 1 or len(args) > 2:
        print(__doc__)
        sys.exit(1)

    term        = args[0].strip()
    case_filter = args[1].strip() if len(args) > 1 else None

    m = re.fullmatch(r'(\d{4})-10', term)
    if not m:
        print(f'Error: expected a term in YYYY-10 format (e.g. 2025-10), got {term!r}')
        sys.exit(1)

    year_str   = m.group(1)
    cases_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term / 'cases.json'

    # ── Single-case mode ─────────────────────────────────────────────────────
    if case_filter:
        print(f'Single-case mode: {term} / {case_filter}')
        if not cases_path.exists():
            print(f'Error: {cases_path} does not exist. Run without a case filter first.')
            sys.exit(1)
        print()
        print(f'Re-generating transcript for {case_filter} ...')
        generate_missing_transcripts(cases_path, case_filter=case_filter)
        compare_ussc_oyez_speakers(cases_path, case_filter=case_filter)
        return

    # ── Full-term mode ───────────────────────────────────────────────────────
    url = f'https://www.supremecourt.gov/oral_arguments/argument_audio/{year_str}'

    # Load case numbers from the next two terms to avoid duplicating cases that
    # were moved forward (e.g. due to reargument or delayed decision).
    terms_root = REPO_ROOT / 'courts' / 'ussc' / 'terms'
    later_term_numbers = _load_later_term_numbers(terms_root, year_str)
    if later_term_numbers:
        by_term: dict[str, int] = {}
        for num, t in later_term_numbers.items():
            by_term[t] = by_term.get(t, 0) + 1
        summary = ', '.join(f'{c} in {t}' for t, c in sorted(by_term.items()))
        vprint(f'Loaded later-term cases for cross-term dedup: {summary}.')

    try:
        scraped = fetch_cases_from_url(url, year_str)
    except Exception as exc:
        print(f'Audio listing page not available ({exc}); will rely on transcript listing.')
        scraped = []

    if scraped:
        print(f'Found {len(scraped)} case(s).')
        update_cases_json(cases_path, scraped, year_str, later_term_numbers)
    else:
        print('No audio cases found.')
        if not cases_path.exists():
            cases_path.parent.mkdir(parents=True, exist_ok=True)
            cases_path.write_text('[]\n', encoding='utf-8')

    # Step 2b: import transcript PDFs from supremecourt.gov listing page
    # Transcripts are not available before October Term 1968.
    if year_str >= '1968-10':
        vprint('Importing transcript PDFs from supremecourt.gov listing ...')
        import_transcript_pdfs(cases_path, year_str, later_term_numbers)

    # Step 3: generate missing transcript JSON files
    if force_reparse:
        print('Reparsing all transcripts (--reparse) ...')
    else:
        vprint('Checking for missing transcripts ...')
    generate_missing_transcripts(cases_path, force=force_reparse)

    # Step 3b: migrate old-format transcripts to envelope format
    vprint('Migrating old-format transcripts ...')
    migrate_transcripts(cases_path)

    # Step 3c: compare ussc vs oyez speakers; remove redundant ussc transcripts
    vprint('Comparing ussc vs oyez speakers ...')
    compare_ussc_oyez_speakers(cases_path)

    # Step 4: fetch docket info (questions_href + files.json proceedings)
    # supremecourt.gov docket only has data from the 2001 term onward.
    # Requires --docket flag to run (network-heavy; run separately as needed).
    if not fetch_docket:
        print('Skipping docket check (pass --docket to enable).')
    elif int(year_str) >= 2001:
        print('Fetching docket info for cases without questions_href ...')
        update_docket_info(cases_path, year_str)
    else:
        vprint('Skipping docket check (not available before 2001 term).')

    # Step 5: clean up files.json titles and infer missing types
    vprint('Cleaning up files.json entries ...')
    clean_files_json(cases_path)

    # Step 6: extract questions presented from PDF
    vprint('Extracting questions presented ...')
    extract_questions(cases_path)

    # Step 7: add/update opinion_href from slip opinions index
    # Both functions require network access (Wayback CDX for old terms).
    if CHECK_URLS:
        print('Checking opinion references ...')
        upgrade_dead_opinion_hrefs(cases_path)
        backfill_opinion_hrefs(cases_path, term)
    else:
        vprint('Skipping opinion references (pass --checkurls to enable).')

    # Sync files counts now that all files.json mutations are done
    sync_files_count(cases_path)
    if not _any_changes:
        print('Nothing added/updated.')


if __name__ == '__main__':
    main()
