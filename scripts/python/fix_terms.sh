#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

TERMS_DIR="courts/ussc/terms"
LOG="scripts/fix_terms.log"

usage() {
    echo "Usage: $0 all"
    echo "       $0 START_YEAR [END_YEAR]"
    echo ""
    echo "  all              — process every term folder found under courts/ussc/terms/,"
    echo "                     sorted newest first."
    echo "  START_YEAR       — process terms from START_YEAR-10 down to END_YEAR-10."
    echo "  END_YEAR         — defaults to START_YEAR (single term) when omitted."
    echo ""
    echo "Examples:"
    echo "  $0 all"
    echo "  $0 2025 2010"
    echo "  $0 2025"
}

if [[ $# -eq 0 || $# -gt 2 ]]; then
    usage; exit 1
fi

run_term() {
    local term="$1"
    echo "========================================"
    echo "Term $term"
    echo "========================================"
    echo ""
    python3 scripts/validate_cases.py "$term" 2>&1 | tee -a "$LOG"
    echo ""
}

if [[ $1 == "all" ]]; then
    # Discover every term folder, sort newest first.
    mapfile -t TERMS < <(ls -1 "$TERMS_DIR" | sort -r)
    if [[ ${#TERMS[@]} -eq 0 ]]; then
        echo "Error: no term folders found in $TERMS_DIR" >&2; exit 1
    fi
    echo "Processing ${#TERMS[@]} term(s) found in courts/ussc/terms/ (newest first)"
    echo ""
    for term in "${TERMS[@]}"; do
        run_term "$term"
    done
else
    START=$1
    END=${2:-$1}

    if [[ $START -lt $END ]]; then
        echo "Error: START_YEAR ($START) must be >= END_YEAR ($END)" >&2; exit 1
    fi

    for (( year = START; year >= END; year-- )); do
        run_term "${year}-10"
    done
fi

echo "Done."
