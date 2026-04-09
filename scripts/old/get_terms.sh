#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
    echo "Usage: $0 START_YEAR END_YEAR [INTERVAL]"
    echo "  Runs import_cases.py and import_oyez.py for each term from START_YEAR down to END_YEAR."
    echo "  INTERVAL is the decrement step (default: 1)."
    echo "  Example: $0 2022 2010"
    echo "  Example: $0 2022 2010 2"
    exit 1
fi

START=$1
END=$2
INTERVAL=${3:-1}

if [[ $START -lt $END ]]; then
    echo "Error: START_YEAR ($START) must be >= END_YEAR ($END)" >&2
    exit 1
fi

if [[ $INTERVAL -lt 1 ]]; then
    echo "Error: INTERVAL ($INTERVAL) must be >= 1" >&2
    exit 1
fi

cd "$(dirname "$0")/../.."

LOG="scripts/get_terms.log"

for (( year = START; year >= END; year -= INTERVAL )); do
    term="${year}-10"
    echo "========================================"
    echo "Term $term"
    echo "========================================"

#   echo "--- import_cases.py $term ---"
#   python3 scripts/import_cases.py "$term" 2>&1 | tee -a "$LOG"

    echo ""
    echo "--- import_oyez.py $term ---"
    python3 scripts/import_oyez.py "$term" 2>&1 | tee -a "$LOG"

    echo ""
done

echo "Done."
