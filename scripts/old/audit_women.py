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
from collections import defaultdict
from datetime import date, timedelta
from difflib import SequenceMatcher

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CSV_PATH = os.path.join(
    BASE_DIR, 'data', 'courts', 'ussc',
    'Women Advocates Through October Term 2024.csv'
)
TERMS_DIR = os.path.join(BASE_DIR, 'courts', 'ussc', 'terms')

MONTHS = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}


def parse_date_range(date_str):
    """
    Parse a CSV Argument Date string into a list of YYYY-MM-DD strings.

    Handles single dates ("November 30, 1880") and ranges ("Jan. 17-18, 1906").
    """
    date_str = date_str.strip()

    # Range: "Jan. 17-18, 1906" or "Oct. 12-13, 1927"
    m = re.match(r'([A-Za-z]+)\.?\s+(\d+)-(\d+),\s*(\d{4})', date_str)
    if m:
        mon, d1, d2, yr = m.groups()
        mo = MONTHS.get(mon[:3].lower())
        if mo:
            return [f"{yr}-{mo:02d}-{int(d):02d}" for d in range(int(d1), int(d2) + 1)]

    # Single: "November 30, 1880" or "Jan. 5, 1923"
    m = re.match(r'([A-Za-z]+)\.?\s+(\d+),\s*(\d{4})', date_str)
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
    m = re.search(r'\s*\((\d+)\)\s*$', name)
    if m:
        n = int(m.group(1))
        name = name[:m.start()]
    else:
        n = 1
    name = re.sub(r',.*$', '', name)
    return name.strip().upper(), n


def normalize_advocate(raw):
    """
    Return the uppercase base name for speaker-list lookup.
    (Delegates to parse_advocate_name, discards the arg number.)
    """
    base, _ = parse_advocate_name(raw)
    return base


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


def titles_match(csv_title, case_title, threshold=0.6):
    """
    Compare two case titles. For 'X v. Y' titles, both the petitioner and
    respondent must independently meet the similarity threshold — preventing
    a shared respondent like 'United States' from producing a false match.
    Role qualifiers after a comma within a party name are stripped before
    comparison so "Garland v. VanDerStok" matches
    "Garland, Att'y Gen. v. VanDerStok".
    Falls back to whole-string similarity for non-'v.' titles.
    """
    a = csv_title.lower().strip()
    b = case_title.lower().strip()
    a_parts = re.split(r'\s+v\.\s+', a, maxsplit=1)
    b_parts = re.split(r'\s+v\.\s+', b, maxsplit=1)
    if len(a_parts) == 2 and len(b_parts) == 2:
        a_pet = strip_role(a_parts[0])
        b_pet = strip_role(b_parts[0])
        a_res = strip_role(a_parts[1])
        b_res = strip_role(b_parts[1])
        pet = SequenceMatcher(None, a_pet, b_pet).ratio() >= threshold
        res = SequenceMatcher(None, a_res, b_res).ratio() >= threshold
        return pet and res
    if not a or not b:
        return False
    return SequenceMatcher(None, a, b).ratio() >= threshold


def speaker_name_matches(speaker_name: str, norm_advocate: str) -> bool:
    """
    Return True if speaker_name matches norm_advocate.

    Tries exact match first, then falls back to first+last name only so that
    a middle name or initial difference (e.g. "AMANDA RICE" vs
    "AMANDA K. RICE") is still considered a match.
    """
    sp = speaker_name.upper().strip()
    if sp == norm_advocate:
        return True
    # First + last token comparison (ignores middle names/initials)
    sp_parts = sp.split()
    adv_parts = norm_advocate.split()
    if len(sp_parts) >= 2 and len(adv_parts) >= 2:
        if sp_parts[0] == adv_parts[0] and sp_parts[-1] == adv_parts[-1]:
            return True
    return False


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

    # 2. U.S. citation match
    if us_cite and decision_year:
        for cite, yr in extract_us_citations(csv_name):
            if cite == us_cite and yr == decision_year:
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

    return False


def get_speakers(term, case_num, text_href):
    """
    Return the speakers list from a transcript file, or None if unavailable.
    """
    if not text_href:
        return None
    path = os.path.join(TERMS_DIR, term, 'cases', case_num, text_href)
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
    args = parser.parse_args()
    single_term = args.term
    do_fix = args.fix

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
                d = audio.get('date', '')
                if d:
                    abd.setdefault(d, []).append(audio)
            entries.append((case, abd))
        term_case_data[term] = entries

    FEMININE_TITLES = {'MS.', 'MRS.', 'MISS'}

    # Process each CSV row: exhaust all candidate terms before deciding
    # Matched vs UNKNOWN so no row is reported prematurely.
    for entry in rows:
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
            # In single-term mode only process rows whose date falls in that term.
            if natural != single_term:
                continue
            own_next = next_term_after(single_term, all_terms)
            terms_to_search = [
                t for t in [single_term, own_next] if t and t in term_case_data
            ]
        else:
            if not natural:
                continue
            next_t = next_term_after(natural, all_terms)
            terms_to_search = [
                t for t in [natural, next_t] if t and t in term_case_data
            ]

        # Search candidate terms for a case that matches on both date and title.
        # Allow ±1 day tolerance to handle off-by-one errors between the CSV
        # and the audio date (e.g. CSV says Nov 4, audio is dated Nov 5).
        def adjacent_dates(d: str):
            """Yield d-1, d, d+1 as YYYY-MM-DD strings."""
            dt = date.fromisoformat(d)
            for delta in (-1, 0, 1):
                yield (dt + timedelta(days=delta)).isoformat()

        match_result = None  # (term, case_num, audio_date, found_sp, matched_sp)

        for search_date in dates:
            if match_result:
                break
            for term in terms_to_search:
                if match_result:
                    break
                for case, abd in term_case_data.get(term, []):
                    # Find any audio date within ±1 day of search_date
                    audio_date_hit = next(
                        (d for d in adjacent_dates(search_date) if d in abd), None
                    )
                    if audio_date_hit is None:
                        continue
                    audio_date_match = audio_date_hit
                    case_num = case.get('number', '')
                    case_title = case.get('title', '')
                    us_cite = case.get('usCite', '')
                    decision = case.get('decision', '')
                    decision_year = decision[:4] if decision else ''

                    if not is_case_match(
                        csv_name, case_title, case_num, us_cite, decision_year
                    ):
                        continue

                    # Case matched — check advocate in transcript speakers.
                    case_found[adv_key] = True
                    audios = abd[audio_date_match]

                    found_sp = False
                    matched_sp = None
                    matched_text_href = None
                    for audio in audios:
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

                    match_result = (term, case_num, search_date, audio_date_match, found_sp, matched_sp, matched_text_href)
                    break  # stop after first matching case

        if match_result:
            term_r, case_num_r, csv_date_r, audio_date_r, found_sp, matched_sp, matched_text_href = match_result
            if found_sp:
                print(f"Matched: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name}")
                if audio_date_r != csv_date_r:
                    print(f"WARNING: {term_r}/{case_num_r} {audio_date_r} {advocate} — date mismatch: CSV has {csv_date_r}, audio dated {audio_date_r}")
                title_raw = (matched_sp.get('title') or '').upper()
                title_parts = {t.strip() for t in title_raw.split(',')}
                if not title_parts & FEMININE_TITLES:
                    print(f"WARNING: {term_r}/{case_num_r} {audio_date_r} {advocate} — title is {title_raw.strip()!r}, not a feminine honorific")
                    if do_fix and matched_text_href:
                        path = os.path.join(TERMS_DIR, term_r, 'cases', case_num_r, matched_text_href)
                        try:
                            with open(path, encoding='utf-8') as f:
                                data = json.load(f)
                            new_title = ('MS.,' + title_raw.strip()).strip(',')
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
                print(f"UNKNOWN: {term_r}/{case_num_r} {audio_date_r} {advocate}; {csv_name}")
                if audio_date_r != csv_date_r:
                    print(f"WARNING: {term_r}/{case_num_r} {audio_date_r} {advocate} — date mismatch: CSV has {csv_date_r}, audio dated {audio_date_r}")
        elif terms_to_search:
            # No matching case found after exhausting all candidate terms.
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
