#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 START_YEAR END_YEAR"
    echo "  Runs import_cases.py and import_oyez.py for each term from START_YEAR down to END_YEAR."
    echo "  Example: $0 2022 2010"
    exit 1
fi

START=$1
END=$2

if [[ $START -lt $END ]]; then
    echo "Error: START_YEAR ($START) must be >= END_YEAR ($END)" >&2
    exit 1
fi

cd "$(dirname "$0")/.."

LOG="scripts/get_terms.log"

for (( year = START; year >= END; year-- )); do
    term="${year}-10"
    echo "========================================"
    echo "  Term: $term"
    echo "========================================"

#   echo "--- import_cases.py $term ---"
#   python3 scripts/import_cases.py "$term" 2>&1 | tee -a "$LOG"

    echo ""
    echo "--- import_oyez.py $term ---"
    python3 scripts/import_oyez.py "$term" 2>&1 | tee -a "$LOG"

    echo ""
done

echo "Done."
