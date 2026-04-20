#!/usr/bin/env python3
"""
Post-download processing for SCDB CSV files.

Reads every SCDB_<category>_<release>_justiceCentered_Citation.csv file in
data/scdb/, converts date values from MM/DD/YYYY to YYYY-MM-DD, removes the
sctCite / ledCite / lexisCite columns, saves the result as
<category>_<release>.csv, and deletes the original file.

Usage:
    python3 scripts/scdb/post_download.py
"""

import csv
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent.parent / "data" / "scdb"

# Matches the full SCDB download filename; captures the middle portion that
# becomes the output filename (e.g. "2025_01" or "Legacy_07").
FILE_PATTERN = re.compile(r'^SCDB_(.+)_justiceCentered_Citation\.csv$')

# Date value pattern: M/D/YYYY or MM/DD/YYYY
DATE_RE = re.compile(r'^(\d{1,2})/(\d{1,2})/(\d{4})$')

COLS_TO_DELETE = {'sctCite', 'ledCite', 'lexisCite', 'docketId', 'caseIssuesId', 'voteId'}

# Characters that require a field to be quoted
NEEDS_QUOTE_RE = re.compile(r'[-,"]')


def quote_field(value: str) -> str:
    """Quote a field only when it contains a hyphen, comma, or double-quote."""
    if NEEDS_QUOTE_RE.search(value):
        return '"' + value.replace('"', '""') + '"'
    return value


def convert_date(value: str) -> str:
    """Return YYYY-MM-DD if value matches MM/DD/YYYY, otherwise return as-is."""
    m = DATE_RE.match(value)
    if m:
        month, day, year = m.groups()
        return f"{year}-{int(month):02d}-{int(day):02d}"
    return value


def process_file(csv_path: Path) -> None:
    m = FILE_PATTERN.match(csv_path.name)
    if not m:
        print(f"  Skipping (unexpected filename): {csv_path.name}")
        return

    middle = m.group(1)          # e.g. "2025_01" or "Legacy_07"
    out_path = csv_path.parent / f"{middle}.csv"

    print(f"Processing: {csv_path.name}")

    with open(csv_path, newline='', encoding='latin-1') as infile:
        reader = csv.DictReader(infile)
        if reader.fieldnames is None:
            print(f"  ERROR: Could not read header from {csv_path.name}")
            return

        fieldnames = [f for f in reader.fieldnames if f not in COLS_TO_DELETE]

        rows = []
        for row in reader:
            new_row = {f: convert_date(row[f]) if row[f] else row[f]
                       for f in fieldnames}
            rows.append(new_row)

    with open(out_path, 'w', encoding='utf-8') as outfile:
        outfile.write(','.join(quote_field(f) for f in fieldnames) + '\n')
        for row in rows:
            outfile.write(','.join(quote_field(row[f]) for f in fieldnames) + '\n')

    csv_path.unlink()
    print(f"  -> Saved {out_path.name} ({len(rows):,} rows), deleted original.")


def main() -> None:
    files = sorted(DATA_DIR.glob("SCDB_*_justiceCentered_Citation.csv"))
    if not files:
        print(f"No matching files found in {DATA_DIR}")
        sys.exit(0)

    for f in files:
        process_file(f)

    print("Done.")


if __name__ == "__main__":
    main()
