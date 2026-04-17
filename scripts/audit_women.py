#!/usr/bin/env python3
"""
audit_women.py [term]

Audit "Women Advocates Through October Term 2024.csv" against case transcripts.

For each women argument entry whose date matches a case audio entry, determine
if the case name matches, and if so, verify the advocate appears in the
transcript's speakers array.

Prints:
  Matched: <term>/<case number> <date> <advocate name> <CSV case name>
  UNKNOWN: <term>/<case number> <date> <advocate name> <CSV case name>

When run without a term filter, also prints an argument-count summary showing
any advocates for whom not all expected arguments were found.

Usage:
    python3 scripts/old/audit_women.py            # all terms
    python3 scripts/old/audit_women.py 2024-10    # single term (no count check)
"""

import argparse
import csv
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date, timedelta
from difflib import SequenceMatcher

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(
    BASE_DIR, 'data', 'misc',
    'Women Advocates Through October Term 2024.csv'
)
TERMS_DIR = os.path.join(BASE_DIR, 'courts', 'ussc', 'terms')
_SPEAKERS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'speakers.json')
_DATES_CSV_PATH = os.path.join(BASE_DIR, 'data', 'misc', 'dates.csv')


def _load_name_aliases(path):
    """Load the 'alias' section of speakers.json and return {old_upper: new_upper}."""
    aliases = {}
    if not os.path.exists(path):
        return aliases
    with open(path, encoding='utf-8') as fh:
        data = json.load(fh)
    for old, new in (data.get('alias') or {}).items():
        aliases[old.strip().upper()] = new.strip().upper()
    return aliases


NAME_ALIASES = _load_name_aliases(_SPEAKERS_FILE)


def _load_dates_csv(path):
    """Load dates.csv into a dict keyed by usCite -> list of row dicts."""
    rows_by_cite: dict[str, list] = {}
    if not os.path.exists(path):
        return rows_by_cite
    with open(path, newline='', encoding='utf-8') as fh:
        for row in csv.DictReader(fh):
            cite = row.get('usCite', '').strip()
            if cite:
                rows_by_cite.setdefault(cite, []).append(row)
    return rows_by_cite


DATES_BY_CITE = _load_dates_csv(_DATES_CSV_PATH)

MONTHS = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
    'oc': 10,  # typo in CSV: "Oc. 11, 1995"
}


def parse_date_range(date_str):
    """
    Parse a CSV Argument Date string into a list of YYYY-MM-DD strings.

    Handles:
      - Single: "November 30, 1880" / "Jan. 5, 1923" / "Feb.3, 1955"
      - Same-month hyphen range: "Jan. 17-18, 1906"
      - Same-month comma/ampersand list: "Feb. 4,7, 1955" / "Nov. 10 & 15, 1965"
      - Cross-month hyphen range: "Feb. 29-Mar.1, 1956"
      - "reargued" prefix: "reargued Apr. 29, 1970" / "rearguedApr. 23, 1985"
    """
    date_str = date_str.strip()

    # Strip optional "reargued" prefix (with or without trailing space).
    date_str = re.sub(r'^reargued\s*', '', date_str, flags=re.I)

    # Cross-month range: "Feb. 29-Mar.1, 1956"
    m = re.match(
        r'([A-Za-z]+)\.?\s*(\d+)\s*-\s*([A-Za-z]+)\.?\s*(\d+),\s*(\d{4})',
        date_str,
    )
    if m:
        mon1, d1, mon2, d2, yr = m.groups()
        mo1 = MONTHS.get(mon1[:3].lower())
        mo2 = MONTHS.get(mon2[:3].lower())
        if mo1 and mo2:
            results = []
            # Enumerate from (yr, mo1, d1) to (yr, mo2, d2) inclusive.
            cur = date(int(yr), mo1, int(d1))
            end = date(int(yr), mo2, int(d2))
            while cur <= end:
                results.append(cur.isoformat())
                cur += timedelta(days=1)
            return results

    # Same-month hyphen range: "Jan. 17-18, 1906"
    m = re.match(r'([A-Za-z]+)\.?\s*(\d+)-(\d+),\s*(\d{4})', date_str)
    if m:
        mon, d1, d2, yr = m.groups()
        mo = MONTHS.get(mon[:3].lower())
        if mo:
            return [f"{yr}-{mo:02d}-{int(d):02d}" for d in range(int(d1), int(d2) + 1)]

    # Same-month comma/ampersand list: "Feb. 4,7, 1955" / "Nov. 10 & 15, 1965"
    m = re.match(
        r'([A-Za-z]+)\.?\s*(\d+(?:\s*[,&]\s*\d+)+),\s*(\d{4})',
        date_str,
    )
    if m:
        mon, days_str, yr = m.groups()
        mo = MONTHS.get(mon[:3].lower())
        if mo:
            days = [int(d) for d in re.split(r'\s*[,&]\s*', days_str) if d.strip().isdigit()]
            return [f"{yr}-{mo:02d}-{d:02d}" for d in days]

    # Single: "November 30, 1880" / "Jan. 5, 1923" / "Feb.3, 1955"
    m = re.match(r'([A-Za-z]+)\.?\s*(\d+),\s*(\d{4})', date_str)
    if m:
        mon, day, yr = m.groups()
        mo = MONTHS.get(mon[:3].lower())
        if mo:
            return [f"{yr}-{mo:02d}-{int(day):02d}"]

    return []


def parse_advocate_name(raw):
    """
    Split an advocate name from the CSV into (base_name, arg_number).

    The optional trailing "(N)" suffix indicates this is the advocate's Nth
    argument before the Court.  The first argument has no suffix (N=1).
    Role qualifiers after a comma (e.g. ", Ass't Attorney General") are stripped.
    Smart/curly apostrophes are normalised to straight ones.

    Returns (base_name_upper, n) where base_name_upper is uppercase.

    Examples:
        "Beatrice Rosenberg (10)"             → ("BEATRICE ROSENBERG", 10)
        "Belva Ann Lockwood"                  → ("BELVA ANN LOCKWOOD", 1)
        "Annette Abbott Adams, Ass't AG"      → ("ANNETTE ABBOTT ADAMS", 1)
        "Mabel Walker Willebrandt (2)"        → ("MABEL WALKER WILLEBRANDT", 2)
    """
    name = raw.replace('\u2018', "'").replace('\u2019', "'")
    # Strip "(formerly <name>)" annotation before any other parsing.
    name = re.sub(r'\s*\(formerly\s+[^)]+\)', '', name, flags=re.IGNORECASE)
    m = re.search(r'\s*\((\d+)\)\s*$', name)
    if m:
        n = int(m.group(1))
        name = name[:m.start()]
    else:
        n = 1
    name = re.sub(r',.*$', '', name)
    return name.strip().upper(), n


def ascii_fold(s: str) -> str:
    """Strip diacritics: 'Méndez' -> 'Mendez'."""
    return ''.join(
        c for c in unicodedata.normalize('NFD', s)
        if unicodedata.category(c) != 'Mn'
    )


def normalize_advocate(raw):
    """
    Return the uppercase base name for speaker-list lookup.
    (Delegates to parse_advocate_name, discards the arg number.)
    """
    base, _ = parse_advocate_name(raw)
    return ascii_fold(base)


def extract_case_numbers(csv_name):
    """
    Extract parenthesized case numbers from a CSV Case Name field.

    Examples:
      "(No. 90)"            -> ["90"]
      "(No.77)"             -> ["77"]
      "(Nos. 726 & 727)"    -> ["726", "727"]
      "(No. 24-316)"        -> ["24-316"]
    """
    nums = []
    for m in re.finditer(
        r'\(No[s]?\.?\s*([\d\-]+(?:\s*[&,]\s*[\d\-]+)*)\)', csv_name, re.I
    ):
        for n in re.split(r'\s*[&,]\s*', m.group(1)):
            stripped = n.strip()
            if stripped:
                nums.append(stripped)
    return nums


def extract_us_citations(csv_name):
    """
    Extract U.S. Reports citations from a CSV Case Name field.

    Matches patterns like "102 U.S. 176 (1880)".
    Returns list of (citation_str, year_str) tuples.
    """
    return [
        (f"{vol} U.S. {page}", year)
        for vol, page, year in re.findall(
            r'(\d+)\s+U\.S\.?\s+(\d+)\s*\((\d{4})\)', csv_name
        )
    ]


def extract_bare_us_citations(csv_name):
    """
    Extract bare U.S. Reports citations (no year) from a CSV Case Name field.

    Matches patterns like "555 U.S. 379" that lack a parenthesised year.
    Returns list of citation strings, e.g. ["555 U.S. 379"].
    """
    # Match "NNN U.S. NNN" not followed by a space+digit (which would be a
    # page reference) and not already captured with a year by extract_us_citations.
    results = []
    for vol, page in re.findall(r'(\d+)\s+U\.S\.?\s+(\d+)(?!\d)(?!\s*\(\d{4}\))', csv_name):
        results.append(f"{vol} U.S. {page}")
    return results


def extract_titles(csv_name):
    """
    Extract all individual case titles from a CSV Case Name field.

    Handles multi-case entries like:
      "Brooks v. United States (No. 197), United States v. Remus (No. 403),
       and United States v. Stafoff (No. 26)"

    Returns a list of title strings (e.g. ["Brooks v. United States",
    "United States v. Remus", "United States v. Stafoff"]).
    """
    # Find all "X v. Y" segments, stopping before "(No. ...)" or ","
    matches = re.findall(
        r"([A-Z'\u2018\u2019][^,]+?\sv\.\s[A-Z][^,()\n]+?)(?=\s*[\(,]|\s+and\s|\s*$)",
        csv_name,
        re.I,
    )
    titles = [t.strip() for t in matches if t.strip()]

    # Fallback: just strip case numbers and citations from the whole string
    if not titles:
        fallback = re.sub(r'\s*\(No[s]?\..*', '', csv_name, flags=re.I)
        fallback = re.sub(r',?\s*\d+\s+U\.S\..*$', '', fallback)
        fallback = re.sub(r',?\s*reported as.*$', '', fallback, flags=re.I)
        fallback = fallback.strip()
        if fallback:
            titles = [fallback]

    return titles


def names_similar(a, b, threshold=0.6):
    """Return True if two strings are similar enough (SequenceMatcher ratio)."""
    a, b = a.lower().strip(), b.lower().strip()
    if not a or not b:
        return False
    return SequenceMatcher(None, a, b).ratio() >= threshold


def strip_role(party: str) -> str:
    """
    Strip role/title qualifiers that follow a comma within a party name.

    e.g. "Garland, Att'y Gen." -> "Garland"
         "Smith, Secretary of Labor" -> "Smith"
         "United States" -> "United States"
    """
    return party.split(',')[0].strip()


_US_ABBREV_RE = re.compile(r'\bU\.?\s*S\.(?=\s|,|\)|$)', re.I)


def normalize_title_text(s: str) -> str:
    """Expand common abbreviations before title comparison."""
    return _US_ABBREV_RE.sub('United States', s)


# Government role indicators: when a respondent contains one of these, the CSV
# may substitute the department/agency name instead of the official's name.
_GOV_ROLE_RE = re.compile(
    r'\b(sec\.|secretary|att\'y|attorney|gen\.|general|commissioner|comm\.|'
    r'director|administrator|supt\.|superintendent|governor|president|minister)\b',
    re.I,
)


def titles_match(csv_title, case_title, threshold=0.6):
    """
    Compare two case titles. For 'X v. Y' titles, both the petitioner and
    respondent must independently meet the similarity threshold — preventing
    a shared respondent like 'United States' from producing a false match.
    Role qualifiers after a comma within a party name are stripped before
    comparison so "Garland v. VanDerStok" matches
    "Garland, Att'y Gen. v. VanDerStok".

    When either respondent contains a government-role indicator (Sec., Att'y,
    Gen., etc.) the respondent match is relaxed — only the petitioner must
    match. This handles cases where the CSV uses the department name
    ("Dept of Commerce") while the case file names the official
    ("Raimondo, Sec. of Comm.").

    Falls back to whole-string similarity for non-'v.' titles.
    """
    a = normalize_title_text(csv_title).lower().strip()
    b = normalize_title_text(case_title).lower().strip()
    a_parts = re.split(r'\s+v\.\s+', a, maxsplit=1)
    b_parts = re.split(r'\s+v\.\s+', b, maxsplit=1)
    if len(a_parts) == 2 and len(b_parts) == 2:
        a_pet = strip_role(a_parts[0])
        b_pet = strip_role(b_parts[0])
        a_res = strip_role(a_parts[1])
        b_res = strip_role(b_parts[1])
        pet = SequenceMatcher(None, a_pet, b_pet).ratio() >= threshold
        res = SequenceMatcher(None, a_res, b_res).ratio() >= threshold
        if res:
            return pet and res
        # Relax respondent check when either side is a named government official
        if _GOV_ROLE_RE.search(a_parts[1]) or _GOV_ROLE_RE.search(b_parts[1]):
            return pet
        return False
    if not a or not b:
        return False
    return SequenceMatcher(None, a, b).ratio() >= threshold


def speaker_name_matches(speaker_name: str, norm_advocate: str) -> bool:
    """
    Return True if speaker_name matches norm_advocate.

    Tries exact match first, then falls back to first+last name only so that
    a middle name or initial difference (e.g. "AMANDA RICE" vs
    "AMANDA K. RICE") is still considered a match.
    Also resolves the transcript speaker name through NAME_ALIASES so that an
    old name in a transcript (e.g. "ANN O'CONNELL ADAMS") matches the CSV's
    canonical name (e.g. "ANN O'CONNELL").
    """
    sp = ascii_fold(speaker_name.upper().strip())
    adv = ascii_fold(norm_advocate)
    if sp == adv:
        return True
    # Resolve old transcript name via alias table.
    canonical = NAME_ALIASES.get(sp)
    if canonical and ascii_fold(canonical) == adv:
        return True
    # Space-collapsed comparison: "DE ANGELIS" == "DEANGELIS"
    sp_parts = sp.split()
    adv_parts = adv.split()
    if ''.join(sp_parts) == ''.join(adv_parts):
        return True

    # First + last token comparison (ignores middle names/initials)
    if len(sp_parts) >= 2 and len(adv_parts) >= 2:
        if sp_parts[0] == adv_parts[0] and sp_parts[-1] == adv_parts[-1]:
            return True
    return False


def titles_word_overlap(csv_title, case_title, min_overlap=2):
    """
    Return True if the titles share enough significant unabbreviated words.

    Two modes:
      1. Either the petitioner OR respondent side shares >= min_overlap words.
      2. BOTH the petitioner AND respondent sides each share >= 1 word.
         This handles consolidated/related cases where the CSV names a
         co-petitioner not in the case title (e.g. "American Athletic
         Conference v. Alston" vs "National Collegiate Athletic Assn. v.
         Alston" — pet shares "athletic", res shares "alston").

    Unabbreviated = does not end with '.'.  Stop words and short tokens
    are excluded.
    """
    STOP = {'of', 'the', 'in', 'and', 'or', 'for', 'a', 'an', 'v', 'et', 'al',
            'united', 'states'}  # "United States" is too common to discriminate

    def sig_words(s):
        return {w.lower() for w in re.split(r'[\s,]+', s)
                if len(w) > 2 and not w.endswith('.') and w.lower() not in STOP}

    a_norm = normalize_title_text(csv_title)
    b_norm = normalize_title_text(case_title)
    a_parts = re.split(r'\s+v\.\s+', a_norm.strip(), maxsplit=1)
    b_parts = re.split(r'\s+v\.\s+', b_norm.strip(), maxsplit=1)
    if len(a_parts) == 2 and len(b_parts) == 2:
        pet_overlap = len(sig_words(a_parts[0]) & sig_words(b_parts[0]))
        res_overlap = len(sig_words(a_parts[1]) & sig_words(b_parts[1]))
        if pet_overlap >= min_overlap or res_overlap >= min_overlap:
            return True
        if pet_overlap >= 1 and res_overlap >= 1:
            return True
        return False
    # Fallback: whole-string word overlap
    return len(sig_words(csv_title) & sig_words(case_title)) >= min_overlap


def is_case_match(csv_name, case_title, case_num, us_cite, decision_year):
    """
    Return True if the CSV case name matches a case entry using any of:
      1. Parenthesized case number matches the case's 'number' field.
      2. U.S. Reports citation matches the case's 'usCite' + decision year.
      3. Fuzzy match of any extracted title against the case title.
    """
    # 1. Case number match
    csv_nums = extract_case_numbers(csv_name)
    if csv_nums and case_num:
        if case_num in csv_nums:
            return True

    # 2. U.S. citation match (with year)
    if us_cite and decision_year:
        for cite, yr in extract_us_citations(csv_name):
            if cite == us_cite and yr == decision_year:
                return True

    # 2b. Bare U.S. citation match (no year in CSV, compare directly to usCite)
    if us_cite:
        for cite in extract_bare_us_citations(csv_name):
            if cite == us_cite:
                return True

    # 3. Fuzzy title match on each extracted case title, plus the full CSV
    #    name stripped of case numbers/citations as a fallback candidate.
    #    The fallback handles cases like "TikTok, Inc. v. Garland" where the
    #    comma in the petitioner name trips up the extraction regex.
    stripped = re.sub(r'\s*\(No[s]?\..*', '', csv_name, flags=re.I)
    stripped = re.sub(r',?\s*\d+\s+U\.S\..*$', '', stripped)
    stripped = stripped.strip()
    candidates = extract_titles(csv_name)
    if stripped and stripped not in candidates:
        candidates.append(stripped)
    for title in candidates:
        if titles_match(title, case_title):
            return True

    # 4. Word-overlap match: 2+ significant unabbreviated words on either
    #    side of the "v." in common.  Uses the same cleaned candidates (no
    #    citation text) to avoid "585 U.S." expanding to "United States" and
    #    falsely matching any "v. United States" case.
    for title in candidates:
        if titles_word_overlap(title, case_title):
            return True

    return False


def get_speakers(term, case_num, text_href):
    """
    Return the speakers list from a transcript file, or None if unavailable.
    text_href is relative to the term's cases/ directory (e.g. "05-908/2006-12-04-oyez.json").
    """
    if not text_href:
        return None
    path = os.path.join(TERMS_DIR, term, 'cases', text_href)
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data.get('media', {}).get('speakers', [])
    except Exception:
        pass
    return None


_MONTHS_LONG = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]


def _format_argument_title(date_str: str) -> str:
    """Return 'Oral Argument on Month Day, Year' for a YYYY-MM-DD date string."""
    try:
        dt = date.fromisoformat(date_str)
        return f'Oral Argument on {_MONTHS_LONG[dt.month - 1]} {dt.day}, {dt.year}'
    except (ValueError, AttributeError):
        return f'Oral Argument on {date_str}'


def _add_advocate_to_case(
    term: str,
    case: dict,
    abd: dict,
    audio_date: str,
    advocate_name: str,
    audio_exists: bool,
    all_misc: bool = False,
) -> bool:
    """Add advocate_name to the audio object for audio_date in case.

    Creates the audio object (source='misc') if audio_exists is False.
    If all_misc is True, adds advocate to every source='misc' audio entry
    (used when multiple argument dates exist and we don't know which day
    the advocate spoke).
    Updates cases.json on disk and the in-memory case/abd dicts.
    Returns True if a modification was made.
    """
    case_num = case.get('number') or case.get('id', '?')
    cases_path = os.path.join(TERMS_DIR, term, 'cases.json')

    # Read current disk state.
    try:
        with open(cases_path, encoding='utf-8') as fh:
            data = json.load(fh)
    except Exception as exc:
        print(f'  WRITE FAILED ({term}/{case_num}): cannot read cases.json: {exc}')
        return False

    # Locate the case on disk (match by number or id).
    disk_case = None
    for c in data:
        if c.get('number') == case.get('number') or c.get('id') == case.get('id'):
            disk_case = c
            break
    if disk_case is None:
        print(f'  WRITE FAILED ({term}/{case_num}): case not found in cases.json')
        return False

    disk_audio_list: list = disk_case.setdefault('audio', [])
    new_audio: dict | None = None

    if audio_exists:
        if all_misc:
            misc_entries = [a for a in disk_audio_list if a.get('source') == 'misc']
            if not misc_entries:
                audio_exists = False  # fall through to create
            else:
                modified = False
                for entry in misc_entries:
                    advs = entry.setdefault('advocates', [])
                    if not any(_adv_name(a) == advocate_name for a in advs):
                        advs.append(_adv_obj(advocate_name))
                        modified = True
                if not modified:
                    return False
        else:
            matched = next((a for a in disk_audio_list if a.get('date') == audio_date), None)
            if matched is None:
                audio_exists = False  # unexpected — fall through to create
            else:
                advocates = matched.setdefault('advocates', [])
                if any(_adv_name(a) == advocate_name for a in advocates):
                    return False  # already present
                advocates.append(_adv_obj(advocate_name))

    if not audio_exists:
        new_audio = {
            'source': 'misc',
            'type': 'argument',
            'title': _format_argument_title(audio_date),
            'date': audio_date,
            'advocates': [_adv_obj(advocate_name)],
        }
        disk_audio_list.append(new_audio)
        disk_case['audio'] = sorted(disk_audio_list, key=lambda a: a.get('date', ''))

    # Write updated cases.json.
    try:
        with open(cases_path, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write('\n')
    except Exception as exc:
        print(f'  WRITE FAILED ({term}/{case_num}): {exc}')
        return False

    # Sync in-memory case dict and abd.
    if audio_exists:
        if all_misc:
            for mem_audio in case.get('audio', []):
                if mem_audio.get('source') == 'misc':
                    mem_adv = mem_audio.setdefault('advocates', [])
                    if not any(_adv_name(a) == advocate_name for a in mem_adv):
                        mem_adv.append(_adv_obj(advocate_name))
        else:
            for mem_audio in case.get('audio', []):
                if mem_audio.get('date') == audio_date:
                    mem_adv = mem_audio.setdefault('advocates', [])
                    if not any(_adv_name(a) == advocate_name for a in mem_adv):
                        mem_adv.append(_adv_obj(advocate_name))
                    break
    else:
        assert new_audio is not None
        mem_new = dict(new_audio)
        case.setdefault('audio', []).append(mem_new)
        case['audio'] = sorted(case['audio'], key=lambda a: a.get('date', ''))
        abd.setdefault(audio_date, []).append(mem_new)

    print(f'  WROTE: {term}/{case_num} {audio_date}: added advocate {advocate_name!r}')
    return True


def _adv_obj(name: str) -> dict:
    """Return a new advocate object with name and title=MS. (all CSV entries are women)."""
    return {'name': name, 'title': 'MS.'}


def _adv_name(entry) -> str:
    """Return the name string from either a plain string or a {name, title} dict."""
    if isinstance(entry, dict):
        return entry.get('name', '')
    return str(entry)



    """Build the LOC opinion PDF URL from a U.S. cite like '343 U.S. 922'."""
    m = re.match(r'(\d+)\s+U\.S\.\s+(\d+)', us_cite)
    if not m:
        return ''
    vol, page = int(m.group(1)), int(m.group(2))
    v, p = f"{vol:03d}", f"{page:03d}"
    return (
        f"https://tile.loc.gov/storage-services/service/ll/usrep/"
        f"usrep{v}/usrep{v}{p}/usrep{v}{p}.pdf"
    )


def _find_dates_csv_row(csv_name: str, arg_dates: list) -> dict | None:
    """
    Return the first dates.csv row whose usCite appears in csv_name and whose
    dateArgument overlaps with any of arg_dates.  Returns None if not found.
    """
    cite_candidates: set[str] = set()
    for cite, _ in extract_us_citations(csv_name):
        cite_candidates.add(cite)
    for cite in extract_bare_us_citations(csv_name):
        cite_candidates.add(cite)

    arg_dates_set = set(arg_dates)
    for cite in cite_candidates:
        for row in DATES_BY_CITE.get(cite, []):
            raw = row.get('dateArgument', '0').strip()
            if raw == '0':
                continue
            row_dates = {d.strip() for d in raw.split(',')}
            if row_dates & arg_dates_set:
                return row
    return None


def _create_case_from_dates_csv(
    term: str,
    dates_row: dict,
    term_case_data: dict,
) -> dict | None:
    """
    Insert a new case entry into cases.json from a dates.csv row.

    If the case already exists (matched by id or number) the existing dict is
    returned without modification.  On success the in-memory term_case_data is
    updated and the new case dict is returned; on failure, None.
    """
    us_cite = dates_row.get('usCite', '').strip()
    m = re.match(r'(\d+)\s+U\.S\.\s+(\d+)', us_cite)
    if not m:
        return None
    vol_str, page_str = m.group(1), m.group(2)

    docket = dates_row.get('docket', '').strip()
    case_id = dates_row.get('caseId', '').strip()
    arg_raw = dates_row.get('dateArgument', '').strip()
    arg_dates = [d.strip() for d in arg_raw.split(',') if d.strip() and d.strip() != '0'] if arg_raw and arg_raw != '0' else []

    cases_path = os.path.join(TERMS_DIR, term, 'cases.json')
    try:
        with open(cases_path, encoding='utf-8') as fh:
            data = json.load(fh)
    except Exception as exc:
        print(f'  CREATE FAILED ({term}): cannot read cases.json: {exc}')
        return None

    # Return existing case if already present.
    for c in data:
        if (case_id and c.get('id') == case_id) or (docket and docket != '0' and c.get('number') == docket):
            # Ensure the in-memory entry exists too.
            if not any(c2 is c or (c2.get('id') == case_id)
                       for c2, _ in term_case_data.get(term, [])):
                term_case_data.setdefault(term, []).append((c, {}))
            return c

    new_case: dict = {}
    if case_id:
        new_case['id'] = case_id
    new_case['title'] = dates_row.get('caseTitle', '').strip()
    if docket and docket != '0':
        new_case['number'] = docket
    if arg_dates:
        new_case['argument'] = ','.join(arg_dates)
    dec = dates_row.get('dateDecision', '').strip()
    if dec and dec != '0':
        new_case['decision'] = dec
    new_case['volume'] = vol_str
    new_case['page'] = page_str
    new_case['usCite'] = us_cite
    href = _build_opinion_href(us_cite)
    if href:
        new_case['opinion_href'] = href
    if arg_dates:
        new_case['audio'] = [
            {
                'source': 'misc',
                'type': 'argument',
                'title': _format_argument_title(d),
                'date': d,
                'advocates': [],
            }
            for d in arg_dates
        ]

    data.append(new_case)

    try:
        with open(cases_path, 'w', encoding='utf-8') as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
            fh.write('\n')
    except Exception as exc:
        print(f'  CREATE FAILED ({term}): {exc}')
        return None

    term_case_data.setdefault(term, []).append((new_case, {}))
    num_display = new_case.get('number') or new_case.get('id', '?')
    print(f'  CREATED: {term}/{num_display}: {new_case["title"]}')
    return new_case


def term_for_date(date_str, sorted_terms):
    """
    Return the term whose date range [YYYY-MM-01, (YYYY+1)-MM-01) contains
    date_str, or None if no term covers that date.
    """
    for term in reversed(sorted_terms):
        m = re.match(r'^(\d{4})-(\d{2})$', term)
        if not m:
            continue
        yr, mo = int(m.group(1)), int(m.group(2))
        start = f"{yr}-{mo:02d}-01"
        end = f"{yr + 1}-{mo:02d}-01"
        if start <= date_str < end:
            return term
    return None


def next_term_after(term, sorted_terms):
    """Return the term immediately after `term` in sorted_terms, or None."""
    try:
        idx = sorted_terms.index(term)
        return sorted_terms[idx + 1] if idx + 1 < len(sorted_terms) else None
    except ValueError:
        return None


def main():
    parser = argparse.ArgumentParser(
        description='Audit women advocates CSV against case transcript data.'
    )
    parser.add_argument(
        'term', nargs='?', default=None,
        help='Limit to a single term (e.g. 2024-10). Omit to scan all terms.',
    )
    parser.add_argument(
        '--fix', action='store_true',
        help='When a non-feminine honorific warning is triggered, prepend MS. to '
             'the speaker title in the transcript file.',
    )
    parser.add_argument(
        '--verbose', action='store_true',
        help='Print Matched: lines in addition to UNKNOWN: and WARNING: lines.',
    )
    args = parser.parse_args()
    single_term = args.term
    do_fix = args.fix
    verbose = args.verbose

    # Load and sort CSV rows by first parsed date
    with open(CSV_PATH, newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))

    def first_date(row):
        dates = parse_date_range(row['Argument Date'])
        return dates[0] if dates else '0000-00-00'

    rows.sort(key=first_date)

    # Per-advocate case-found tracking: (base_name, arg_num) -> bool
    # Used at the end to verify all N arguments were found (all-terms mode only).
    case_found: dict[tuple[str, int], bool] = {}
    for row in rows:
        if str(row.get('Advocate No.', '')).strip() == '-1':
            continue
        key = parse_advocate_name(row['Advocate Name'])  # (base, n)
        case_found.setdefault(key, False)

    # Load all term/case data upfront; precompute audios_by_date per case.
    all_terms = sorted(
        t for t in os.listdir(TERMS_DIR)
        if os.path.isfile(os.path.join(TERMS_DIR, t, 'cases.json'))
    )
    # term_case_data: term -> [(case_dict, audios_by_date), ...]
    term_case_data: dict[str, list] = {}
    for term in all_terms:
        cases_path = os.path.join(TERMS_DIR, term, 'cases.json')
        try:
            with open(cases_path, encoding='utf-8') as f:
                cases = json.load(f)
        except Exception:
            continue
        entries = []
        for case in cases:
            abd: dict[str, list] = {}
            for audio in case.get('audio', []):
                if audio.get('type', 'argument') not in ('argument', 'reargument'):
                    continue
                d = audio.get('date', '')
                if d:
                    abd.setdefault(d, []).append(audio)
            entries.append((case, abd))
        term_case_data[term] = entries

    FEMININE_TITLES = {'MS.', 'MRS.', 'MISS'}

    # Process each CSV row: exhaust all candidate terms before deciding
    # Matched vs UNKNOWN so no row is reported prematurely.
    for entry in rows:
        if str(entry.get('Advocate No.', '')).strip() == '-1':
            continue
        dates = parse_date_range(entry['Argument Date'])
        if not dates:
            continue

        primary_date = dates[0]
        advocate = entry['Advocate Name']
        csv_name = entry['Case Name']
        norm_advocate = normalize_advocate(advocate)
        adv_key = parse_advocate_name(advocate)

        # Determine which terms to search for this row's argument date.
        # Always try the natural term + next term (cases can be filed a term
        # later than expected).
        natural = term_for_date(primary_date, all_terms)
        if single_term:
            # In single-term mode only process rows whose date falls in that term,
            # and only search that term — never a neighbouring term.
            if natural != single_term:
                continue
            terms_to_search = [single_term] if single_term in term_case_data else []
            next_t = next_term_after(single_term, all_terms)
            next_next_t = next_term_after(next_t, all_terms) if next_t else None
        else:
            if not natural:
                continue
            next_t = next_term_after(natural, all_terms)
            next_next_t = next_term_after(next_t, all_terms) if next_t else None
            terms_to_search = [
                t for t in [natural, next_t] if t and t in term_case_data
            ]

        # Search candidate terms for a case that matches on both date and title.
        # Allow ±1 day tolerance to handle off-by-one errors between the CSV
        # and the audio date (e.g. CSV says Nov 4, audio is dated Nov 5).
        #
        # Priority: prefer a case where the advocate IS found in speakers
        # (speaker_match). If a title matches but the advocate isn't in any
        # transcript, keep it as title_only_match and keep searching — a
        # title-only match is only used as a last resort.
        def adjacent_dates(d: str):
            """Yield dates within ±7 days, closest first."""
            dt = date.fromisoformat(d)
            for delta in (0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7):
                yield (dt + timedelta(days=delta)).isoformat()

        # Slots: (term, case_num, csv_date, audio_date, matched_sp, text_href,
        #         has_transcript, audio_exists)
        speaker_citation_match = None  # found advocate + strong id (num/cite)
        audio_citation_match = None    # no advocate found + strong id + has audio
        citation_match = None          # strong id + no audio
        # Note: fuzzy-title-only slots (speaker_match, title_only_match) have
        # been removed.  Title similarity is used only as a filter inside
        # is_case_match; it is never sufficient to accept a match on its own.

        for search_date in dates:
            if speaker_citation_match:
                break
            for term in terms_to_search:
                if speaker_citation_match:
                    break
                for case, abd in term_case_data.get(term, []):
                    # Find any audio date within ±7 days of search_date.
                    audio_date_hit = next(
                        (d for d in adjacent_dates(search_date) if d in abd), None
                    )
                    # Skip cases that have argument audio but not near this date;
                    # allow cases with no argument audio at all to fall through,
                    # but only if the case's own argument date (when set) is
                    # within ±7 days of the search date — prevents false matches
                    # on cases that share a common petitioner word like "United States".
                    if audio_date_hit is None:
                        if abd:
                            continue
                        case_arg = ','.join(filter(None, [
                            case.get('argument', ''),
                            case.get('reargument', ''),
                        ]))
                        if case_arg:
                            adj = set(adjacent_dates(search_date))
                            if not any(d.strip() in adj for d in case_arg.split(',')):
                                continue
                    case_num = case.get('number', '')
                    case_title = case.get('title', '')
                    us_cite = case.get('usCite', '')
                    decision = case.get('decision', '')
                    decision_year = decision[:4] if decision else ''

                    if not is_case_match(
                        csv_name, case_title, case_num, us_cite, decision_year
                    ):
                        continue

                    if audio_date_hit is None:
                        # Case matches but has no argument audio at all.
                        # Use the CSV date as the audio date.
                        slot = (term, case_num, search_date, search_date,
                                None, None, False, False)
                        # Case-number or direct-citation match is stronger than
                        # a fuzzy word-overlap match and must take priority.
                        # When the CSV carries a U.S. citation, that citation is
                        # the primary identifier: a case-number match alone is
                        # not "strong" if the citation points to a different case.
                        _csv_nums = extract_case_numbers(csv_name)
                        _csv_cites = extract_us_citations(csv_name)
                        _csv_bare  = extract_bare_us_citations(csv_name)
                        _csv_has_cite = bool(_csv_cites or _csv_bare)
                        _cite_matches = us_cite and (
                            any(c == us_cite for c, _yr in _csv_cites)
                            or any(c == us_cite for c in _csv_bare)
                        )
                        _is_strong = bool(_cite_matches) or (
                            bool(_csv_nums) and case_num in _csv_nums
                            and not _csv_has_cite
                        )
                        if _is_strong and citation_match is None:
                            citation_match = slot
                        # fuzzy-title-only: skip — no strong id, no match
                        continue

                    # Title matched — check advocate in transcript speakers or
                    # the explicit advocates list on the audio object.
                    audio_date_match = audio_date_hit
                    audios = abd[audio_date_match]
                    has_transcript = any(a.get('text_href') for a in audios)

                    found_sp = False
                    matched_sp = None
                    matched_text_href = None
                    for audio in audios:
                        # Check explicit advocates list first (works even without
                        # a transcript file).
                        for raw_adv in audio.get('advocates', []):
                            if speaker_name_matches(_adv_name(raw_adv).strip(), norm_advocate):
                                found_sp = True
                                matched_sp = {'name': _adv_name(raw_adv).strip(), 'title': 'MS.'}
                                matched_text_href = audio.get('text_href', '')
                                break
                        if found_sp:
                            break
                        # Fall back to transcript speakers array.
                        text_href = audio.get('text_href', '')
                        speakers = get_speakers(
                            term, case_num, text_href
                        )
                        if speakers is not None:
                            for sp in speakers:
                                if speaker_name_matches(sp.get('name', ''), norm_advocate):
                                    found_sp = True
                                    matched_sp = sp
                                    matched_text_href = text_href
                                    break
                        if found_sp:
                            break

                    slot = (term, case_num, search_date, audio_date_match,
                            matched_sp, matched_text_href, has_transcript, True)
                    # Compute strength for this match regardless of speaker presence.
                    # When the CSV carries a U.S. citation, that citation is the
                    # primary identifier: a case-number match alone is not "strong"
                    # if the citation points to a different case.
                    _csv_nums  = extract_case_numbers(csv_name)
                    _csv_cites = extract_us_citations(csv_name)
                    _csv_bare  = extract_bare_us_citations(csv_name)
                    _csv_has_cite = bool(_csv_cites or _csv_bare)
                    _cite_matches = us_cite and (
                        any(cc == us_cite for cc, _yr in _csv_cites)
                        or any(cc == us_cite for cc in _csv_bare)
                    )
                    _is_strong = bool(_cite_matches) or (
                        bool(_csv_nums) and case_num in _csv_nums
                        and not _csv_has_cite
                    )
                    if found_sp:
                        if _is_strong:
                            speaker_citation_match = slot
                            case_found[adv_key] = True
                            break  # definitive: strong id + confirmed advocate
                        # fuzzy-title-only speaker match: skip — no strong id
                    else:
                        # No speaker found — classify by match strength.
                        if _is_strong and audio_citation_match is None:
                            audio_citation_match = slot
                        # fuzzy-title-only: skip

        # Priority order — strong identifiers (citation/case number) always win.
        # Fuzzy title is used only as a candidate filter, never as a match reason.
        #   1. speaker_citation_match — strong id + confirmed advocate (definitive)
        #   2. audio_citation_match   — strong id + has audio near date
        #   3. citation_match         — strong id + no audio
        match_result = (speaker_citation_match
                        or audio_citation_match
                        or citation_match)
        found_sp = match_result is not None and match_result is speaker_citation_match

        if match_result:
            term_r, case_num_r, csv_date_r, audio_date_r, matched_sp, matched_text_href, has_transcript, audio_exists = match_result
            # Check for U.S. citation mismatch: if CSV has a citation with both
            # volume and page numbers, it should match the case's usCite field.
            # If the CSV citation is followed by a year in parentheses, that
            # year should also match the year of the case's decision date.
            _matched_case = next(
                (_c for _c, _ in term_case_data.get(term_r, [])
                 if _c.get('number') == case_num_r),
                None,
            )
            if _matched_case is not None:
                _case_us_cite    = _matched_case.get('usCite', '') or ''
                _case_decision   = _matched_case.get('decision', '') or ''
                _case_dec_year   = _case_decision[:4] if _case_decision else ''
                # Collect all citation/year mismatches and emit as one warning.
                _cite_issues: list[str] = []
                for _cite, _yr in extract_us_citations(csv_name):
                    if _case_us_cite and _cite != _case_us_cite:
                        _cite_issues.append(
                            f"CSV citation {_cite!r} does not match case usCite {_case_us_cite!r}"
                        )
                    if _case_dec_year and _yr != _case_dec_year:
                        _cite_issues.append(
                            f"CSV citation year {_yr!r} does not match case decision year {_case_dec_year!r}"
                        )
                for _cite in extract_bare_us_citations(csv_name):
                    if _case_us_cite and _cite != _case_us_cite:
                        _issue = f"CSV citation {_cite!r} does not match case usCite {_case_us_cite!r}"
                        if _issue not in _cite_issues:
                            _cite_issues.append(_issue)
                if _cite_issues:
                    print(f"WARNING: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name}"
                          f" — {'; '.join(_cite_issues)}")
            if found_sp:
                if verbose:
                    print(f"Matched: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name}")
                if audio_date_r != csv_date_r:
                    print(f"WARNING: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name} — date mismatch: CSV has {csv_date_r}, audio dated {audio_date_r}")
                title_raw = (matched_sp.get('title') or '').upper()
                title_parts = {t.strip() for t in title_raw.split(',')}
                if not title_parts & FEMININE_TITLES:
                    print(f"WARNING: {term_r}/{case_num_r} {audio_date_r} {advocate} — title is {title_raw.strip()!r}, not a feminine honorific")
                    if do_fix and matched_text_href:
                        path = os.path.join(TERMS_DIR, term_r, 'cases', matched_text_href)
                        try:
                            with open(path, encoding='utf-8') as f:
                                data = json.load(f)
                            parts = [t.strip() for t in title_raw.strip().split(',')]
                            if 'MR.' in parts:
                                parts = ['MS.' if t == 'MR.' else t for t in parts]
                            else:
                                parts = ['MS.'] + parts
                            new_title = ','.join(p for p in parts if p)
                            for sp in data.get('media', {}).get('speakers', []):
                                if speaker_name_matches(sp.get('name', ''), norm_advocate):
                                    sp['title'] = new_title
                                    break
                            with open(path, 'w', encoding='utf-8') as f:
                                json.dump(data, f, indent=2, ensure_ascii=False)
                                f.write('\n')
                            print(f"  FIXED: set title to {new_title!r} in {path}")
                        except Exception as e:
                            print(f"  FIX FAILED: {e}")
            else:
                if not has_transcript:
                    # No transcript to verify against — write the advocate into
                    # the audio object's 'advocates' array (creating the object
                    # if the case has no argument audio at all).
                    adv_name = parse_advocate_name(advocate)[0]
                    mem_case, mem_abd = next(
                        ((c, a) for c, a in term_case_data.get(term_r, [])
                         if c.get('number') == case_num_r or c.get('id') == case_num_r),
                        (None, None),
                    )
                    if mem_case is not None:
                        wrote = _add_advocate_to_case(
                            term_r, mem_case, mem_abd, audio_date_r,
                            adv_name, audio_exists,
                        )
                        if wrote:
                            case_found[adv_key] = True
                    if verbose:
                        print(f"Matched: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name}")
                else:
                    print(f"UNKNOWN: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name}")
                if audio_date_r != csv_date_r:
                    print(f"WARNING: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name} — date mismatch: CSV has {csv_date_r}, audio dated {audio_date_r}")
        elif terms_to_search:
            # No matching case found after exhausting all candidate terms.
            # Before trying dates.csv, check up to 2 terms ahead (reargument / late filing).
            for _lookahead_t in [next_t, next_next_t]:
                if match_result is not None:
                    break
                if not (_lookahead_t and _lookahead_t in term_case_data
                        and _lookahead_t not in terms_to_search):
                    continue
                for case, abd in term_case_data.get(_lookahead_t, []):
                    audio_date_hit = next(
                        (d for d in adjacent_dates(primary_date) if d in abd), None
                    )
                    if audio_date_hit is None:
                        if abd:
                            continue
                        case_arg = ','.join(filter(None, [
                            case.get('argument', ''),
                            case.get('reargument', ''),
                        ]))
                        if case_arg:
                            adj = set(adjacent_dates(primary_date))
                            if not any(d.strip() in adj for d in case_arg.split(',')):
                                continue
                    if not is_case_match(
                        csv_name, case.get('title', ''), case.get('number', ''),
                        case.get('usCite', ''), (case.get('decision', '') or '')[:4]
                    ):
                        continue
                    _csv_nums  = extract_case_numbers(csv_name)
                    _csv_cites = extract_us_citations(csv_name)
                    _csv_bare  = extract_bare_us_citations(csv_name)
                    _csv_has_cite = bool(_csv_cites or _csv_bare)
                    _cite_ok = case.get('usCite', '') and (
                        any(c == case.get('usCite') for c, _ in _csv_cites)
                        or any(c == case.get('usCite') for c in _csv_bare)
                    )
                    _is_strong = bool(_cite_ok) or (
                        bool(_csv_nums) and case.get('number', '') in _csv_nums
                        and not _csv_has_cite
                    )
                    _ad = audio_date_hit or primary_date
                    _audio_ex = audio_date_hit is not None
                    if _is_strong:
                        match_result = (_lookahead_t, case.get('number', ''), primary_date,
                                        _ad, None, None,
                                        any(a.get('text_href') for a in abd.get(_ad, [])),
                                        _audio_ex)
                        break
            # If next-term search found something, write it and move on.
            if match_result is not None:
                term_r, case_num_r, csv_date_r, audio_date_r, _sp, _th, has_transcript, audio_exists = match_result
                if not has_transcript:
                    adv_name = parse_advocate_name(advocate)[0]
                    mem_case, mem_abd = next(
                        ((c, a) for c, a in term_case_data.get(term_r, [])
                         if c.get('number') == case_num_r or c.get('id') == case_num_r),
                        (None, None),
                    )
                    if mem_case is not None:
                        wrote = _add_advocate_to_case(
                            term_r, mem_case, mem_abd, audio_date_r,
                            adv_name, audio_exists,
                        )
                        if wrote:
                            case_found[adv_key] = True
                if verbose:
                    print(f"Matched: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name}")
                continue
            # Try to resolve via dates.csv using the usCite + argument date.
            working_term = single_term if single_term else natural
            dates_row = _find_dates_csv_row(csv_name, dates)
            resolved = False
            if dates_row is not None:
                dec_date = dates_row.get('dateDecision', '').strip()
                # Check that the decision date falls within the working term's
                # own date range directly, rather than using term_for_date —
                # overlapping non-October terms can cause term_for_date to
                # return a different term for a date that is still within the
                # working term's span.
                _wt_m = re.match(r'^(\d{4})-(\d{2})$', working_term)
                _in_term = False
                if _wt_m and dec_date and dec_date != '0':
                    _yr, _mo = int(_wt_m.group(1)), int(_wt_m.group(2))
                    _term_start = f"{_yr}-{_mo:02d}-01"
                    _term_end = f"{_yr + 1}-{_mo:02d}-01"
                    _in_term = _term_start <= dec_date < _term_end
                if _in_term:
                    new_case = _create_case_from_dates_csv(working_term, dates_row, term_case_data)
                    if new_case is not None:
                        adv_name = parse_advocate_name(advocate)[0]
                        new_id = new_case.get('id')
                        new_num = new_case.get('number')
                        mem_case, mem_abd = next(
                            ((c, a) for c, a in term_case_data.get(working_term, [])
                             if (new_id and c.get('id') == new_id)
                             or (new_num and c.get('number') == new_num)),
                            (None, None),
                        )
                        if mem_case is not None:
                            arg_raw = dates_row.get('dateArgument', '').strip()
                            multi_day = len([d for d in arg_raw.split(',') if d.strip() and d.strip() != '0']) > 1
                            wrote = _add_advocate_to_case(
                                working_term, mem_case, mem_abd,
                                primary_date, adv_name, True,
                                all_misc=multi_day,
                            )
                            if wrote:
                                case_found[adv_key] = True
                        resolved = True
                        if verbose:
                            num_d = new_case.get('number') or new_case.get('id', '?')
                            print(f"Matched: {working_term}/{num_d} {primary_date} {advocate}; {csv_name}")
            if not resolved:
                print(f"UNKNOWN: {natural}/? {primary_date} {advocate}; {csv_name}")

    # ── Argument-count summary (all-terms mode only) ──────────────────────
    if single_term:
        return

    # Group by base_name, collect {arg_num: found} mapping
    by_advocate: dict[str, dict[int, bool]] = defaultdict(dict)
    for (base, n), found in case_found.items():
        by_advocate[base][n] = found

    issues: list[str] = []
    for base in sorted(by_advocate):
        args_map = by_advocate[base]
        max_n = max(args_map)
        missing = [n for n in range(1, max_n + 1) if not args_map.get(n, False)]
        if missing:
            issues.append(f"  {base}: missing arg(s) {missing} of {max_n}")

    print()
    print("=== Argument Count Summary ===")
    if issues:
        for line in issues:
            print(line)
    else:
        print("  All advocates: argument counts verified OK.")


if __name__ == '__main__':
    main()
