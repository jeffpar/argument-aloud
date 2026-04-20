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

Usage:
    python3 scripts/scdb/verify_cases.py
"""

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

MODERN_RE = re.compile(r'^(\d{4})_(\d+)\.csv$')
LEGACY_RE = re.compile(r'^Legacy_(\d+)\.csv$')

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


def load_scdb(csv_path: Path, table: dict) -> int:
    """Load CSV into table keyed by caseId; skip caseIds already present. Returns rows added."""
    added = 0
    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            cid = row.get('caseId', '').strip()
            if cid and cid not in table:
                table[cid] = {
                    'dateDecision': row.get('dateDecision', '').strip(),
                    'usCite': row.get('usCite', '').strip(),
                }
                added += 1
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
    modern_csv, legacy_csv = find_csvs()
    print(f"Modern SCDB: {modern_csv.name}")
    print(f"Legacy SCDB: {legacy_csv.name}")

    scdb: dict = {}
    m_added = load_scdb(modern_csv, scdb)
    l_added = load_scdb(legacy_csv, scdb)
    print(f"Loaded {m_added:,} cases from modern, {l_added:,} unique cases from legacy "
          f"({len(scdb):,} total).\n")

    verify_terms(scdb)


if __name__ == "__main__":
    main()
