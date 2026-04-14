#!/usr/bin/env python3
"""
audit_women.py

Audit "Women Advocates Through October Term 2024.csv" against case transcripts.

For each women argument entry whose date matches a case audio entry, determine
if the case name matches, and if so, verify the advocate appears in the
transcript's speakers array.

Prints:
  MATCH:    <date> | <CSV case name>
              Case: <term>/<case number>
              Advocate: <advocate name>
  NO MATCH: <date> | <CSV case name>
              Advocate: <advocate name>
"""

import csv
import json
import os
import re
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

    # 3. Fuzzy title match on each extracted case title
    for title in extract_titles(csv_name):
        if names_similar(title, case_title):
            return True

    return False


def normalize_advocate(name):
    """
    Normalize an advocate name for comparison with transcript speaker names:
      - Replace smart/curly apostrophes with straight apostrophe.
      - Strip trailing "(N)" argument-count suffix.
      - Strip role qualifier after a comma (e.g., ", Ass't Attorney General").
      - Uppercase and strip whitespace.
    """
    name = name.replace('\u2018', "'").replace('\u2019', "'")
    name = re.sub(r'\s*\(\d+\)\s*$', '', name)
    name = re.sub(r',.*$', '', name)
    return name.strip().upper()


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


def main():
    # Load and sort CSV rows by first parsed date
    with open(CSV_PATH, newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))

    def first_date(row):
        dates = parse_date_range(row['Argument Date'])
        return dates[0] if dates else '0000-00-00'

    rows.sort(key=first_date)

    # Build date -> [entry, ...] lookup (handles date ranges)
    by_date: dict[str, list] = {}
    for row in rows:
        for d in parse_date_range(row['Argument Date']):
            by_date.setdefault(d, []).append(row)

    # Walk all terms
    for term in sorted(os.listdir(TERMS_DIR)):
        cases_path = os.path.join(TERMS_DIR, term, 'cases.json')
        if not os.path.isfile(cases_path):
            continue

        try:
            with open(cases_path, encoding='utf-8') as f:
                cases = json.load(f)
        except Exception:
            continue

        for case in cases:
            case_num = case.get('number', '')
            case_title = case.get('title', '')
            us_cite = case.get('usCite', '')
            decision = case.get('decision', '')
            decision_year = decision[:4] if decision else ''

            for audio in case.get('audio', []):
                audio_date = audio.get('date', '')
                text_href = audio.get('text_href', '')

                if not audio_date or audio_date not in by_date:
                    continue

                for entry in by_date[audio_date]:
                    csv_name = entry['Case Name']

                    if not is_case_match(
                        csv_name, case_title, case_num, us_cite, decision_year
                    ):
                        continue

                    # Case matched — check advocate in transcript speakers
                    advocate = entry['Advocate Name']
                    norm_advocate = normalize_advocate(advocate)

                    speakers = get_speakers(term, case_num, text_href)

                    if speakers is None:
                        print(f"NO MATCH: {audio_date} | {csv_name}")
                        print(f"  (no transcript)  Advocate: {advocate}")
                        continue

                    found = any(
                        sp.get('name', '').upper().strip() == norm_advocate
                        for sp in speakers
                    )

                    if found:
                        print(f"MATCH: {audio_date} | {csv_name}")
                        print(f"  Case: {term}/{case_num}")
                        print(f"  Advocate: {advocate}")
                    else:
                        print(f"NO MATCH: {audio_date} | {csv_name}")
                        print(f"  Advocate: {advocate}")


if __name__ == '__main__':
    main()
