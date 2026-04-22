#!/usr/bin/env python3
"""
Verify our cases.json data against SCDB CSV files.

Loads the latest "modern" SCDB CSV (highest 4-digit year, e.g. 2025_01.csv)
and the latest "legacy" SCDB CSV (highest revision number after "Legacy_",
e.g. Legacy_07.csv) from data/scdb/, merges them into an indexed table by
caseId, then walks every courts/ussc/terms/*/cases.json file and checks:

  1. Any case with an "id" field has a matching caseId in the SCDB table.
  2. The case's decision (YYYY-MM-DD) matches the SCDB dateDecision.
  3. The case's usCite matches the SCDB usCite.

With --ussc_deck:
  Reads data/ld/ussc_deck.csv and verifies that every row containing an
  "scdb" value has a matching caseId in the combined SCDB table.

With --case <caseId>:
  Prints the fully-parsed case object (including justices array) for
  inspection, without running any other checks.

Usage:
    python3 scripts/scdb/verify_cases.py
    python3 scripts/scdb/verify_cases.py --ussc_deck
    python3 scripts/scdb/verify_cases.py --case 1965-001
"""

import argparse
import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
REPO_DIR = SCRIPT_DIR.parent.parent
DATA_DIR = REPO_DIR / "data" / "scdb"
TERMS_DIR = REPO_DIR / "courts" / "ussc" / "terms"
USCC_DECK_PATH = REPO_DIR / "data" / "ld" / "ussc_deck.csv"
VARS_PATH = DATA_DIR / "vars.json"

MODERN_RE = re.compile(r'^(\d{4})_(\d+)\.csv$')
LEGACY_RE = re.compile(r'^Legacy_(\d+)\.csv$')

MONTH_MAP = {
    'january': '01', 'february': '02', 'march': '03', 'april': '04',
    'may': '05', 'june': '06', 'july': '07', 'august': '08',
    'september': '09', 'october': '10', 'november': '11', 'december': '12',
}


def term_str_to_yyyymm(term_str: str) -> str | None:
    """Convert e.g. 'October Term 1965' or 'July Special Term 1942' → 'YYYY-MM'."""
    m = re.match(r'^(\w+)\s+(?:special\s+)?term\s+(\d{4})$', term_str.strip(), re.IGNORECASE)
    if not m:
        return None
    month = MONTH_MAP.get(m.group(1).lower())
    return f"{m.group(2)}-{month}" if month else None

# SCDB dateDecision format after post_download: "1965-12-20"
SCDB_DATE_FMT = "%Y-%m-%d"


def find_csvs() -> tuple[Path, Path]:
    """Return (latest_modern_csv, latest_legacy_csv)."""
    modern_candidates: list[tuple[tuple[int, int], Path]] = []
    legacy_candidates: list[tuple[int, Path]] = []

    for f in DATA_DIR.glob("*.csv"):
        m = MODERN_RE.match(f.name)
        if m:
            modern_candidates.append(((int(m.group(1)), int(m.group(2))), f))
            continue
        m = LEGACY_RE.match(f.name)
        if m:
            legacy_candidates.append((int(m.group(1)), f))

    if not modern_candidates:
        sys.exit(f"ERROR: No modern SCDB CSV found in {DATA_DIR}")
    if not legacy_candidates:
        sys.exit(f"ERROR: No legacy SCDB CSV found in {DATA_DIR}")

    modern_path = max(modern_candidates, key=lambda x: x[0])[1]
    legacy_path = max(legacy_candidates, key=lambda x: x[0])[1]
    return modern_path, legacy_path


def load_vars() -> dict[str, dict[str, str]]:
    """Load vars.json and return a mapping of column name → {code: label} for columns
    that have a dict 'values' mapping (code→label). String references are resolved
    to the referenced column's mapping. List values and missing/non-dict values are
    skipped (no normalization possible)."""
    if not VARS_PATH.exists():
        return {}
    with open(VARS_PATH, encoding='utf-8') as f:
        raw = json.load(f)

    # First pass: collect dict-based mappings
    result: dict[str, dict[str, str]] = {}
    for col, spec in raw.items():
        v = spec.get('values')
        if isinstance(v, dict):
            result[col] = v

    # Second pass: resolve string references (e.g. "respondent" → "petitioner")
    for col, spec in raw.items():
        v = spec.get('values')
        if isinstance(v, str) and v in result:
            result[col] = result[v]

    return result


# Columns that are per-justice (one row per justice per case in the CSV).
# Everything from 'justice' onward is justice-level; all columns before it
# are case-level and are identical across all rows for the same caseId.
JUSTICE_COLS = [
    'justice', 'justiceName', 'vote', 'opinion', 'direction',
    'majority', 'firstAgreement', 'secondAgreement',
]


def normalize_row(row: dict, vars_maps: dict, norm_issues: set) -> dict:
    """Return a new dict with all column values normalized via vars_maps.
    Unknown codes are added to norm_issues and kept as-is."""
    normalized: dict[str, str] = {}
    for col, raw in row.items():
        val = raw.strip()
        if col in vars_maps and val and val.upper() != 'NULL':
            label = vars_maps[col].get(val)
            if label is None:
                norm_issues.add((col, val))
                normalized[col] = val  # keep raw code
            else:
                normalized[col] = label
        else:
            normalized[col] = val
    return normalized


def load_scdb(csv_path: Path, table: dict, vars_maps: dict,
              norm_issues: set) -> int:
    """Load CSV into table keyed by caseId.

    Each entry in table is a case-level dict (columns caseId…minVotes) with an
    added 'justices' key containing a list of per-justice dicts (columns
    justice…secondAgreement).  Rows for a caseId already in table have their
    justice entry appended but the case-level fields are not overwritten.

    Normalizes all columns via vars_maps.  Any (column, raw_value) pair that
    cannot be normalized is added to norm_issues for reporting.

    Returns the number of new caseIds added.
    """
    added = 0
    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            cid = row.get('caseId', '').strip()
            if not cid:
                continue

            norm = normalize_row(row, vars_maps, norm_issues)

            justice_obj = {col: norm[col] for col in JUSTICE_COLS if col in norm}

            if cid not in table:
                case_obj = {col: val for col, val in norm.items()
                            if col not in JUSTICE_COLS}
                case_obj['justices'] = []
                table[cid] = case_obj
                added += 1

            table[cid]['justices'].append(justice_obj)

    return added


def parse_scdb_date(s: str) -> datetime | None:
    """Parse '1965-12-20' → datetime. Returns None on failure."""
    try:
        return datetime.strptime(s.strip(), SCDB_DATE_FMT)
    except ValueError:
        return None


def normalize_cite(s: str) -> str:
    """Normalize whitespace in a citation string."""
    return ' '.join(s.split())


def verify_ussc_deck(scdb: dict) -> None:
    """Check that every row in ussc_deck.csv with an 'scdb' value:
      1. Has a matching caseId in the combined SCDB table.
      2. Exists in our courts/ussc/terms/<YYYY>-*/cases.json (matched by 'id').
         The year is taken from the SCDB case's 'term' field (a plain 4-digit
         year), and all term directories matching that year are searched.
    Comma-separated scdb values are treated as multiple caseIds, each verified
    independently."""
    if not USCC_DECK_PATH.exists():
        sys.exit(f"ERROR: ussc_deck.csv not found at {USCC_DECK_PATH}")

    # Cache: year string → set of all case 'id' values across YYYY-* and (YYYY+1)-* term dirs
    year_cache: dict[str, set[str]] = {}

    def get_case_ids_for_year(year: str) -> set[str]:
        if year not in year_cache:
            ids: set[str] = set()
            y = int(year)
            for pattern in (f"{y-1}-*", f"{y}-*", f"{y+1}-*"):
                for cases_path in sorted(TERMS_DIR.glob(f"{pattern}/cases.json")):
                    try:
                        cases = json.loads(cases_path.read_text(encoding='utf-8'))
                        ids.update(c['id'] for c in cases if c.get('id'))
                    except Exception:
                        pass
            year_cache[year] = ids
        return year_cache[year]

    checked = 0
    not_in_scdb: list[str] = []
    not_in_cases: list[str] = []

    with open(USCC_DECK_PATH, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            raw_scdb = row.get('scdb', '').strip()
            if not raw_scdb:
                continue
            term_str = row.get('term', '').strip()

            scdb_ids = [s.strip() for s in raw_scdb.split(',') if s.strip()]
            for scdb_id in scdb_ids:
                checked += 1
                if scdb_id not in scdb:
                    not_in_scdb.append(f"  {scdb_id}: {term_str}")
                    continue

                # Use the SCDB case's term year (plain integer) for the glob
                s = scdb[scdb_id]
                year = s.get('term', '').strip()
                if not year or not re.fullmatch(r'\d{4}', year):
                    not_in_cases.append(
                        f"  {scdb_id}: unrecognized SCDB term value {year!r}"
                    )
                    continue

                case_ids = get_case_ids_for_year(year)
                next_year = str(int(year) + 1)
                prev_year = str(int(year) - 1)
                if not case_ids:
                    not_in_cases.append(
                        f"  {scdb_id}: no cases.json found for {prev_year}-*, {year}-*, or {next_year}-*"
                    )
                    continue

                if scdb_id not in case_ids:
                    summary = (
                        f"{year} | {s.get('caseName','')} | "
                        f"docket={s.get('docket','')} | decided={s.get('dateDecision','')}"
                    )
                    not_in_cases.append(f"  {scdb_id}: {summary}")

    print(f"Checked {checked} SCDB id(s) across ussc_deck rows.")

    if not_in_scdb:
        print(f"\n{len(not_in_scdb)} caseId(s) not found in SCDB:")
        for m in not_in_scdb:
            print(m)
    else:
        print("All SCDB ids found in SCDB data.")

    if not_in_cases:
        print(f"\n{len(not_in_cases)} caseId(s) not found in our cases.json:")
        for m in not_in_cases:
            print(m)
    else:
        print("All SCDB ids found in cases.json.")


def print_case(scdb: dict, case_id: str) -> None:
    """Pretty-print the parsed case object for --case inspection."""
    case = scdb.get(case_id)
    if case is None:
        print(f"caseId {case_id!r} not found in loaded SCDB data.")
        return
    print(json.dumps(case, indent=2))


def verify_terms(scdb: dict) -> None:
    cases_files = sorted(TERMS_DIR.glob("*/cases.json"))
    if not cases_files:
        print(f"WARNING: No cases.json files found under {TERMS_DIR}")
        return

    total = 0
    skipped = 0  # cases without an id
    errors: list[str] = []

    for cases_file in cases_files:
        term = cases_file.parent.name
        try:
            cases = json.loads(cases_file.read_text(encoding='utf-8'))
        except Exception as e:
            errors.append(f"[{term}] Could not parse {cases_file}: {e}")
            continue

        for case in cases:
            cid = case.get('id')
            if not cid:
                skipped += 1
                continue

            total += 1
            title = case.get('title', cid)
            prefix = f"[{term}] {cid} ({title})"

            # 1. caseId must exist in SCDB
            if cid not in scdb:
                errors.append(f"{prefix}: caseId not found in SCDB")
                continue

            row = scdb[cid]

            # 2. decision vs SCDB dateDecision comparison
            our_raw = case.get('decision', '')
            scdb_raw = row['dateDecision']
            if our_raw and scdb_raw:
                our_dt = parse_scdb_date(our_raw)
                scdb_dt = parse_scdb_date(scdb_raw)
                if our_dt is None:
                    errors.append(f"{prefix}: could not parse our decision: {our_raw!r}")
                elif scdb_dt is None:
                    errors.append(f"{prefix}: could not parse SCDB dateDecision: {scdb_raw!r}")
                elif our_dt.date() != scdb_dt.date():
                    errors.append(
                        f"{prefix}: decision mismatch: ours={our_raw!r} scdb={scdb_raw!r}"
                    )

            # 3. usCite comparison
            our_cite = normalize_cite(case.get('usCite', ''))
            scdb_cite = normalize_cite(row['usCite'])
            if our_cite and scdb_cite and our_cite != scdb_cite:
                errors.append(
                    f"{prefix}: usCite mismatch: ours={our_cite!r} scdb={scdb_cite!r}"
                )

    print(f"Checked {total} cases with SCDB ids ({skipped} cases skipped — no id).")
    if errors:
        print(f"\n{len(errors)} issue(s) found:\n")
        for e in errors:
            print(f"  {e}")
    else:
        print("All checks passed.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify cases.json data and/or ussc_deck.csv against SCDB."
    )
    parser.add_argument(
        "--ussc_deck",
        action="store_true",
        help="Verify every scdb-tagged row in data/ld/ussc_deck.csv exists in SCDB.",
    )
    parser.add_argument(
        "--case",
        metavar="CASEID",
        help="Print the parsed SCDB case object for CASEID and exit.",
    )
    args = parser.parse_args()

    modern_csv, legacy_csv = find_csvs()
    print(f"Modern SCDB: {modern_csv.name}")
    print(f"Legacy SCDB: {legacy_csv.name}")

    vars_maps = load_vars()
    if vars_maps:
        print(f"Loaded vars.json ({len(vars_maps)} column mappings).")
    else:
        print("WARNING: vars.json not found or empty — no normalization applied.")

    scdb: dict = {}
    norm_issues: set[tuple[str, str]] = set()
    m_added = load_scdb(modern_csv, scdb, vars_maps, norm_issues)
    l_added = load_scdb(legacy_csv, scdb, vars_maps, norm_issues)
    print(f"Loaded {m_added:,} cases from modern, {l_added:,} unique cases from legacy "
          f"({len(scdb):,} total).")

    if norm_issues:
        print(f"\n{len(norm_issues)} normalization issue(s) — unknown codes in mapped columns:")
        for col, val in sorted(norm_issues):
            print(f"  {col}: {val!r}")
    print()

    if args.case:
        print_case(scdb, args.case)
    elif args.ussc_deck:
        verify_ussc_deck(scdb)
    else:
        verify_terms(scdb)


if __name__ == "__main__":
    main()
