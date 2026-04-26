#!/usr/bin/env python3
"""Create sets in courts/ussc/sets/ from data/ld/ussc_deck.csv.

Usage:
    python3 scripts/ld/create_sets.py

Outputs:
    courts/ussc/sets/highlights.json  — cases grouped by legalBasis
"""

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "data" / "ld" / "ussc_deck.csv"
TERMS_DIR = ROOT / "courts" / "ussc" / "terms"
SETS_DIR = ROOT / "courts" / "ussc" / "sets"

def extract_year(term_str):
    """Extract the 4-digit year from e.g. 'October Term 1963' → '1963'."""
    m = re.search(r'\b(\d{4})\b', term_str.strip())
    return m.group(1) if m else None


def normalize_docket(d):
    """Normalize a docket string for output: take first if comma-separated,
    convert 'N ORIG' style to 'N-Orig'."""
    if not d:
        return ""
    d = d.split(",")[0].strip()
    d = re.sub(r'^(\d+)\s+ORIG$', r'\1-Orig', d, flags=re.IGNORECASE)
    return d


def normalize_for_compare(d):
    """Normalize a docket for case-insensitive comparison."""
    return normalize_docket(d).lower()


def load_cases_for_year(year, cache):
    """Load all cases from {YYYY-1}-*, {YYYY}-*, {YYYY+1}-* term dirs.
    Returns list of (term_yyyymm, cases_list) tuples. Cached by year."""
    if year in cache:
        return cache[year]
    result = []
    y = int(year)
    for y_check in (y - 1, y, y + 1):
        for cases_path in sorted(TERMS_DIR.glob(f"{y_check}-*/cases.json")):
            term_yyyymm = cases_path.parent.name
            try:
                cases = json.loads(cases_path.read_text(encoding='utf-8'))
                result.append((term_yyyymm, cases))
            except Exception:
                pass
    cache[year] = result
    return result


def find_case_in_term(cases, csv_row):
    """Return the first matching case dict from cases, or None."""
    csv_docket_norm = normalize_for_compare(csv_row.get("docket", ""))
    csv_scdb_ids = {s.strip() for s in csv_row.get("scdb", "").split(",") if s.strip()}

    for case in cases:
        # Match by docket number
        case_num = case.get("number", "")
        if csv_docket_norm and case_num and normalize_for_compare(case_num) == csv_docket_norm:
            return case
        # Match by SCDB id
        case_id = case.get("id", "")
        if csv_scdb_ids and case_id and case_id in csv_scdb_ids:
            return case

    return None


def first_date(value):
    """Return the first date from a possibly comma-separated list of dates."""
    if not value:
        return ""
    return value.split(",")[0].strip()


def main():
    SETS_DIR.mkdir(parents=True, exist_ok=True)

    cases_cache = {}  # year str → list of (term_yyyymm, cases_list) tuples
    rows = list(csv.DictReader(open(CSV_PATH)))

    skipped = []
    groups = defaultdict(list)  # legalBasis → [case_obj, ...]

    for row in rows:
        legal_basis = row.get("legalBasis", "").strip()
        if not legal_basis:
            skipped.append(
                f"  Row {row['index']}: {row.get('petitioner','')} v. {row.get('respondent','')} "
                f"— no legalBasis"
            )
            continue

        term_str = row.get("term", "").strip()
        year = extract_year(term_str)
        if not year:
            skipped.append(
                f"  Row {row['index']}: {row.get('petitioner','')} v. {row.get('respondent','')} "
                f"— unrecognized term format '{term_str}'"
            )
            continue

        term_cases = load_cases_for_year(year, cases_cache)
        if not term_cases:
            skipped.append(
                f"  Row {row['index']}: {row.get('petitioner','')} v. {row.get('respondent','')} "
                f"({year}) — no cases.json found in {int(year)-1}-* through {int(year)+1}-*"
            )
            continue

        matched = None
        matched_term = None
        for term_yyyymm, cases in term_cases:
            m = find_case_in_term(cases, row)
            if m:
                matched = m
                matched_term = term_yyyymm
                break

        if not matched:
            skipped.append(
                f"  Row {row['index']}: {row.get('petitioner','')} v. {row.get('respondent','')} "
                f"({year}, docket={row.get('docket','')!r}, scdb={row.get('scdb','')!r}) "
                f"— not found in cases.json"
            )
            continue

        # Build case object
        alt_title = row.get("altTitle", "").strip()
        if alt_title:
            title = alt_title
        else:
            petitioner = row.get("petitioner", "").strip()
            respondent = row.get("respondent", "").strip()
            title = f"{petitioner} v. {respondent}"
        title = title.replace("\\\\", " ")

        case_obj = {
            "title": title,
            "term": matched_term,
        }

        docket_norm = normalize_docket(row.get("docket", "").strip())
        if docket_norm:
            case_obj["number"] = docket_norm

        argued = first_date(row.get("argued", ""))
        if argued:
            case_obj["argument"] = argued

        decided = first_date(row.get("decided", ""))
        if decided:
            case_obj["decision"] = decided

        groups[legal_basis].append(case_obj)

    # Build sorted output
    output = [
        {"name": basis, "cases": cases_list}
        for basis, cases_list in sorted(groups.items())
    ]

    out_path = SETS_DIR / "highlights.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
        f.write("\n")

    total_cases = sum(len(g["cases"]) for g in output)
    print(f"Wrote {len(output)} groups with {total_cases} cases → {out_path.relative_to(ROOT)}")

    if skipped:
        print(f"\nSkipped {len(skipped)} row(s):")
        for s in skipped:
            print(s)


if __name__ == "__main__":
    main()
