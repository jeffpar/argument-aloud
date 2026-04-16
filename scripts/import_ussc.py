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
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path

# Import opinion helpers from validate_cases (same scripts/ directory).
sys.path.insert(0, str(Path(__file__).parent))
from validate_cases import _fetch_opinions, check_opinion_for_case, sync_files_count


CASE_RE  = re.compile(r'^(\d+(?:-\d+|-Orig|A\d+))\s+(.+)$', re.IGNORECASE)
DATE_RE  = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{2})$')
ORIG_RE  = re.compile(r'^(\d+)[\s-]Orig\.?$', re.IGNORECASE)

# Like CASE_RE but also matches '130Orig' (no hyphen) and bare numbers (e.g. '163') as
# seen on archived transcript listing pages for pre-2000 terms.
_TRANSCRIPT_CASE_RE = re.compile(r'^(\d+(?:-\d+|[\s-]?Orig\.?|A\d+)?)\.?\s+(.+)$', re.IGNORECASE)
_ORIG_NORM_RE       = re.compile(r'[\s-]*Orig\.?$', re.IGNORECASE)

REPO_ROOT        = Path(__file__).resolve().parent.parent
SPEAKERMAP_PATH  = Path(__file__).parent / 'old' / 'speakermap.txt'
_JUSTICES_PATH   = Path(__file__).parent / 'justices.json'
BASE_URL         = 'https://www.supremecourt.gov'

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
            return _normalize_number(m.group(1))
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


def _build_justice_last_name_map() -> dict[str, str]:
    """Return {LAST_NAME_UPPER: canonical_name_upper} from justices.json."""
    if not _JUSTICES_PATH.exists():
        return {}
    data: dict = json.loads(_JUSTICES_PATH.read_text(encoding='utf-8'))
    result: dict[str, str] = {}
    for canonical in data:
        u = canonical.upper()
        words = u.split()
        last = words[-1]
        if last in _SUFFIX_WORDS and len(words) > 1:
            last = words[-2]
        result.setdefault(last, u)
    return result


_JUSTICE_LAST_NAME_MAP: dict[str, str] = _build_justice_last_name_map()


def _load_typo_speaker_map() -> dict[str, str]:
    """Return {RAW_TOKEN_UPPER: CORRECTED_NAME_UPPER} from TYPO: lines in speakermap.txt."""
    result: dict[str, str] = {}
    if not SPEAKERMAP_PATH.exists():
        return result
    for line in SPEAKERMAP_PATH.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line.upper().startswith('TYPO:') or '->' not in line:
            continue
        raw_tok, corrected = line[5:].rsplit('->', 1)
        result[raw_tok.strip().upper()] = corrected.strip().upper()
    return result


_TYPO_SPEAKER_MAP: dict[str, str] = _load_typo_speaker_map()


def _load_rename_speaker_map() -> dict[str, str]:
    """Return {OLD_NAME_UPPER: NEW_NAME_UPPER} from RENAME: lines in speakermap.txt."""
    result: dict[str, str] = {}
    if not SPEAKERMAP_PATH.exists():
        return result
    for line in SPEAKERMAP_PATH.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line.upper().startswith('RENAME:') or '->' not in line:
            continue
        old_name, new_name = line[7:].rsplit('->', 1)
        result[old_name.strip().upper()] = new_name.strip().upper()
    return result


_RENAME_SPEAKER_MAP: dict[str, str] = _load_rename_speaker_map()


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


def _load_justice_map(term: str = '') -> dict[str, tuple[str, str]]:
    """Return {DISPLAY_NAME_UPPER: (canonical_full_name, title)}.

    Built from the JUSTICE: lines in speakermap.txt.  Handles the term-based
    conditional entries for Rehnquist (< 1986-10 / >= 1986-10).
    """
    result: dict[str, tuple[str, str]] = {}
    if not SPEAKERMAP_PATH.exists():
        return result
    cond_re = re.compile(r'^(.+?)\s*(<|>=)\s*(\d{4}-\d{2})\s*$')
    for line in SPEAKERMAP_PATH.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or ':' not in line or '->' not in line:
            continue
        kind_full, display = line.rsplit('->', 1)
        kind, full_raw = kind_full.split(':', 1)
        if kind.strip().upper() != 'JUSTICE':
            continue
        full_raw = full_raw.strip()
        display  = display.strip()
        # Handle term-conditional entries
        cond_m = cond_re.match(full_raw)
        if cond_m:
            full_name = cond_m.group(1).strip()
            op        = cond_m.group(2)
            cond_term = cond_m.group(3)
            if term:
                if op == '<'  and not (term < cond_term):
                    continue
                if op == '>=' and not (term >= cond_term):
                    continue
        else:
            full_name = full_raw
        title = 'CHIEF JUSTICE' if display.startswith('CHIEF JUSTICE') else 'JUSTICE'
        result[display.upper()] = (full_name, title)
    return result


_APPEARANCES_ESQ_RE = re.compile(r'^(.+?)(?:,\s*|\s+)(?:ESQUIRE|ESQ\.)', re.IGNORECASE)

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
        parts = [p.strip('.,') for p in name_upper.split()]
        last = parts[-1]
        if last in _SUFFIX_WORDS and len(parts) > 1:
            last = parts[-2]
        result.setdefault(last, []).append(name_upper)
    return result


def _resolve_speaker(raw_name: str,
                     appearances: dict[str, list[str]],
                     justice_map: dict[str, tuple[str, str]]) -> tuple[str, str]:
    """Map a raw transcript speaker token to (canonical_full_name, title).

    Justice names (CHIEF JUSTICE X / JUSTICE X) are looked up in justice_map
    to get the full canonical name.  Advocate names (MR. X / MS. X / etc.) are
    resolved via the APPEARANCES section map using the last name.
    Falls back to the raw name and empty title when no match is found.
    """
    raw_upper = raw_name.upper().strip()
    # Anonymous justice token used in pre-2004 USSC transcripts
    if raw_upper in ('QUESTION', 'Q'):
        return 'UNKNOWN JUSTICE', 'JUSTICE'
    # Justices first
    if raw_upper in justice_map:
        return justice_map[raw_upper]
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
            # Check TYPO: entries from speakermap.txt (e.g. 'JUSTICE GORUSCH').
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
            print(f'    WARNING: {prefix}existing MS. speaker '
                  f'"{sp["name"]}" (title: "{sp["title"]}") '
                  f'not found in reparsed transcript')
    return result


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
    justice_map  = _load_justice_map(term)

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
            name, title = _resolve_speaker(raw, appearances, justice_map)
            name = ' '.join(name.upper().split())
            raw_to_resolved[raw] = (name, title)

    # Rename turn names to canonical full names.
    for turn in turns:
        turn['name'] = raw_to_resolved[turn['name']][0]

    # Apply RENAME: corrections from speakermap.txt (e.g. COLLEEN SINZDAK → COLLEEN R. SINZDAK).
    if _RENAME_SPEAKER_MAP:
        for turn in turns:
            turn['name'] = _RENAME_SPEAKER_MAP.get(turn['name'], turn['name'])

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
    - Justices → full name from speakermap.txt (e.g. ``JOHN G. ROBERTS, JR.``)
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


def update_cases_json(cases_path: Path, new_cases: list[dict], year: str,
                      next_term_numbers: set[str] | None = None) -> None:
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
    for case in new_cases:
        if case['number'] in existing_numbers:
            continue
        if next_term_numbers and case['number'] in next_term_numbers:
            print(f'  Skipping {case["number"]} (already in next term)')
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
                for a in case.get('audio', [])
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
        print('Updated cases.json with questions_href entries.')


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

    for case in existing:
        if 'number' not in case:
            continue   # skip cases without a docket number (e.g. Oyez-only entries)
        if case_filter and case_filter not in [n.strip() for n in case['number'].split(',')]:
            continue

        for arg in case.get('audio', []):
            if arg.get('source', 'ussc') != 'ussc':
                continue   # only extract from USSC transcripts
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

            # Skip if already generated and text_href is recorded, unless overwrite is requested.
            if transcript_out.exists() and _existing_th and not case_filter and not force:
                continue

            print(f'  Extracting {case["number"]} ({date})', end='', flush=True)

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
                        print(f'  Deleted empty transcript: {transcript_out.relative_to(REPO_ROOT)}')
                    if arg.get('text_href'):
                        del arg['text_href']
                        modified = True
                    continue

                new_text_href = f'{component_num}/{date}.json'
                if arg.get('text_href') != new_text_href:
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
        # Count distinct component numbers that have USSC argument transcripts.
        ussc_comp_nums: set[str] = set()
        for a in case.get('audio', []):
            if a.get('source', 'ussc') != 'ussc':
                continue
            if a.get('type') not in (None, 'argument', 'reargument'):
                continue
            cn = _ussc_case_num_from_href(a.get('transcript_href', ''), a.get('text_href', ''))
            if cn and cn in comps:
                ussc_comp_nums.add(cn)
        use_case_nums = len(ussc_comp_nums) > 1
        for a in case.get('audio', []):
            if a.get('source', 'ussc') != 'ussc':
                continue
            if a.get('type') not in (None, 'argument', 'reargument'):
                continue
            title = a.get('title') or ''
            has_case_num = ' in No.' in title
            cn = _ussc_case_num_from_href(a.get('transcript_href', ''), a.get('text_href', ''))
            if not (cn and cn in comps):
                continue
            type_v = a.get('type') or 'argument'
            date_v = a.get('date', '')
            if use_case_nums and not has_case_num:
                a['title'] = _ussc_audio_title(type_v, date_v, cn)
                modified = True
            elif not use_case_nums and has_case_num:
                a['title'] = _ussc_audio_title(type_v, date_v, '')
                modified = True

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
        if 'number' not in case:
            continue
        for arg in case.get('audio', []):
            key = (case['number'], arg.get('date', ''))
            audio_map[key] = arg.get('audio_href', '')

    total = 0
    for case in existing:
        if 'number' not in case:
            continue
        number = case['number']
        case_dir = cases_path.parent / 'cases' / _case_folder(number)
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

def import_transcript_pdfs(cases_path: Path, year_str: str,
                            next_term_numbers: set[str] | None = None) -> None:
    """Match PDF transcripts from the supremecourt.gov listing page to cases in
    cases.json.  For each ussc audio entry lacking transcript_href, set it from
    the listing.
    Cases present on the listing but missing from cases.json are created,
    unless they already appear in the next term."""

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
            for arg in case.get('audio', []):
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
                cases_modified = True
                print(f'  {case["number"]} ({row["date"]}): transcript_href added')
                break

            # No ussc audio object existed for this date — create one without audio_href.
            if not assigned:
                audio_list: list = case.setdefault('audio', [])
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
                    new_audio: dict = {'source': 'ussc', 'type': 'argument',
                                       'title': title, 'date': row['date'],
                                       'transcript_href': row['pdf_url']}
                    audio_list.append(new_audio)
                    case['audio'] = sorted(audio_list, key=lambda a: a.get('date') or '')
                    cases_modified = True
                    print(f'  {case["number"]} ({row["date"]}): created transcript-only audio object')

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
    for row in transcripts:
        key = (row['number'], row['date'])
        if key not in matched_rows and row['number'] not in existing_numbers:
            if next_term_numbers and row['number'] in next_term_numbers:
                print(f'  Skipping {row["number"]} (already in next term)')
                continue
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
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    fetch_docket = '--docket' in sys.argv
    force_reparse = '--reparse' in sys.argv

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
        return

    # ── Full-term mode ───────────────────────────────────────────────────────
    url = f'https://www.supremecourt.gov/oral_arguments/argument_audio/{year_str}'

    # Load next term's case numbers so we don't duplicate cases argued late.
    next_year      = str(int(year_str) + 1)
    next_term_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / f'{next_year}-10' / 'cases.json'
    next_term_numbers = _load_term_numbers(next_term_path)
    if next_term_numbers:
        print(f'Loaded {len(next_term_numbers)} case number(s) from {next_year}-10 for cross-term dedup.')

    try:
        scraped = fetch_cases_from_url(url)
    except Exception as exc:
        print(f'Audio listing page not available ({exc}); will rely on transcript listing.')
        scraped = []

    if scraped:
        print(f'Found {len(scraped)} case(s) on audio listing page.\n')
        update_cases_json(cases_path, scraped, year_str, next_term_numbers)
    else:
        print('No audio cases found.')
        if not cases_path.exists():
            cases_path.parent.mkdir(parents=True, exist_ok=True)
            cases_path.write_text('[]\n', encoding='utf-8')

    # Step 2b: import transcript PDFs from supremecourt.gov listing page
    print()
    print('Importing transcript PDFs from supremecourt.gov listing ...')
    import_transcript_pdfs(cases_path, year_str, next_term_numbers)

    # Step 3: generate missing transcript JSON files
    print()
    if force_reparse:
        print('Reparsing all transcripts (--reparse) ...')
    else:
        print('Checking for missing transcripts ...')
    generate_missing_transcripts(cases_path, force=force_reparse)
    # Step 3b: migrate old-format transcripts to envelope format
    print()
    print('Migrating old-format transcripts ...')
    migrate_transcripts(cases_path)

    # Step 4: fetch docket info (questions_href + files.json proceedings)
    # supremecourt.gov docket only has data from the 2001 term onward.
    # Requires --docket flag to run (network-heavy; run separately as needed).
    print()
    if not fetch_docket:
        print('Skipping docket info (pass --docket to enable).')
    elif int(year_str) >= 2001:
        print('Fetching docket info for cases without questions_href ...')
        update_docket_info(cases_path, year_str)
    else:
        print('Skipping docket info (not available before 2001 term).')

    # Step 5: clean up files.json titles and infer missing types
    print()
    print('Cleaning up files.json entries ...')
    clean_files_json(cases_path)

    # Step 6: extract questions presented from PDF
    print()
    print('Extracting questions presented ...')
    extract_questions(cases_path)

    # Step 7: add slip opinions to files.json
    print()
    print('Checking for slip opinions ...')
    existing = json.loads(cases_path.read_text(encoding='utf-8'))
    for case in existing:
        if 'number' not in case:
            continue
        files_path = cases_path.parent / 'cases' / _case_folder(case['number']) / 'files.json'
        if files_path.exists():
            check_opinion_for_case(files_path, case['number'], term)

    # Sync files counts now that all files.json mutations are done
    sync_files_count(cases_path)


if __name__ == '__main__':
    main()
