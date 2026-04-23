#!/usr/bin/env python3
"""Search journal text files for full advocate names from one-word entries.

Reads from stdin the verbose output of update_advocates.py:

    python3 scripts/update_advocates.py --verbose | python3 scripts/scrape_journals.py

For each one-word advocate name and its term/case pairs, searches
courts/ussc/journals/text/{YYYY}.txt for the case block and extracts
full advocate names from argument attribution text near the case number.

The one-word name in our data may be wrong; this script prints ALL names
found near the case number so the correct attribution can be determined.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JOURNALS_DIR = ROOT / "courts" / "ussc" / "journals" / "text"

# Any hyphen/dash variant used in case numbers (hyphen, figure, en, em dash)
_DASH = r'[-\u2012\u2013\u2014]'

# Title prefixes that introduce advocate names in journal text
_TITLE = r'(?:Mr\.|Ms\.|Mrs\.|Miss)\s+(?:(?:Solicitor|Deputy)\s+(?:General|Solicitor)\s+)?'

# Name pattern: 1–5 title-case words, last word without a trailing period
# Handles "Josef Diamond", "Kenneth R. Carr", "A. William Lucas", etc.
_NAME_RE = re.compile(
    r'(?:Mr\.|Ms\.|Mrs\.|Miss)\s+(?:(?:Solicitor|Deputy)\s+(?:General|Solicitor)\s+)?'
    r'((?:[A-Z][A-Za-z.\-]*\s+){0,4}[A-Z][A-Za-z\-]+)'
    r'(?=\s+(?:for\b|and\b)|\s*[,.)\n]|\s*$)',
    re.MULTILINE,
)


# ---------------------------------------------------------------------------
# Stdin parsing
# ---------------------------------------------------------------------------

def parse_stdin() -> list[tuple[str, list[str]]]:
    """Parse update_advocates.py --verbose stdout.

    Returns list of (ONE_WORD_NAME, ['YYYY-MM/case-num', ...]) tuples.
    """
    entries: list[tuple[str, list[str]]] = []
    in_block = False
    for raw in sys.stdin:
        line = raw.rstrip('\n')
        # Section header line
        if re.search(r'one-word advocate name', line):
            in_block = True
            continue
        if not in_block:
            continue
        # Non-indented line or blank ends the block
        if not line.startswith('  '):
            in_block = False
            continue
        # Format: "  NAME [optional tags]: term/case; term/case; ..."
        m = re.match(r'  ([A-Z]+)(?:\s+\[[^\]]*\])*:\s+(.+)$', line)
        if not m:
            continue
        name = m.group(1)
        cases = [c.strip() for c in m.group(2).split(';') if c.strip()]
        entries.append((name, cases))
    return entries


# ---------------------------------------------------------------------------
# Journal searching
# ---------------------------------------------------------------------------

def _case_num_regex(num: str) -> re.Pattern:
    """Return a pattern matching 'No(s). ... NUM' with any dash variant."""
    # Normalise the case number's own hyphen so we can search for any dash variant
    parts = re.split(r'-', num, maxsplit=1)
    if len(parts) == 2:
        pat = rf'{re.escape(parts[0])}{_DASH}{re.escape(parts[1])}'
    else:
        pat = re.escape(num)
    # Require "No." at the start of a line (case entry), allow other numbers
    # before ours (e.g. "Nos. 73-100, 73-235").  \b on both sides ensures
    # "53" doesn't match "153" or "532".  Negative lookahead excludes
    # misc-docket entries like "No. 53, Misc."
    return re.compile(
        rf'^No[s]?\.(?:[^\n]{{0,80}}?)\b{pat}\b(?!,\s*Misc)',
        re.IGNORECASE | re.MULTILINE,
    )


def find_case_blocks(text: str, case_num: str, window: int = 800) -> list[str]:
    """Return all journal text blocks for case_num (may appear many times)."""
    pat = _case_num_regex(case_num)
    blocks: list[str] = []
    for m in pat.finditer(text):
        start = m.start()
        tail = text[start + 5:]  # skip past current "No."
        # End at the first of: next case entry, blank line, session boundary, or window
        nxt = re.search(r'\nNo[s]?\.\s|\n\n|\nAdjourned|\nPresent:', tail)
        end = start + 5 + (nxt.start() if nxt else window)
        block = text[start:end]
        # Normalize soft line-wraps:
        #   "word-\nnext"  →  "word-next"  (hyphenated breaks)
        block = re.sub(r'-\n', '-', block)
        #   line starting with lowercase/comma is a continuation
        block = re.sub(r'\n(?=[a-z,])', ' ', block)
        blocks.append(block)
    return blocks


def extract_names(block: str) -> list[str]:
    """Return ALL-CAPS advocate names extracted from a journal case block.

    Filters out justice names (Chief Justice X, Justice X) which appear in
    opinion-announcement text within the same case entry.
    """
    names: list[str] = []
    for m in _NAME_RE.finditer(block):
        name = m.group(1).strip()
        words = name.upper().split()
        # Require at least two words
        if len(words) < 2:
            continue
        # Skip "Chief Justice X", "Justice X", "Associate Justice X"
        if words[0] in ('JUSTICE', 'CHIEF', 'ASSOCIATE'):
            continue
        if len(words) >= 2 and words[1] == 'JUSTICE':
            continue
        names.append(name.upper())
    return list(dict.fromkeys(names))  # deduplicate, preserve order


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    entries = parse_stdin()
    if not entries:
        print(
            "No one-word advocate entries found in stdin.\n"
            "Usage: python3 scripts/update_advocates.py --verbose "
            "| python3 scripts/scrape_journals.py",
            file=sys.stderr,
        )
        sys.exit(1)

    journal_cache: dict[str, str] = {}

    for name, cases in sorted(entries):
        print(f"\n{name}:")
        for term_case in sorted(cases):
            if '/' not in term_case:
                print(f"  {term_case}: (unrecognised format)")
                continue
            term, case_num = term_case.split('/', 1)
            year = term.split('-')[0]

            if year not in journal_cache:
                path = JOURNALS_DIR / f"{year}.txt"
                journal_cache[year] = (
                    path.read_text(encoding='utf-8', errors='replace')
                    if path.exists() else ''
                )

            text = journal_cache[year]
            if not text:
                print(f"  {term_case}: no journal file for {year}")
                continue

            blocks = find_case_blocks(text, case_num)
            if not blocks:
                print(f"  {term_case}: case not found in {year}.txt")
                continue

            # Collect names from all blocks (case may appear multiple times)
            all_names: list[str] = []
            for block in blocks:
                all_names.extend(extract_names(block))
            found = list(dict.fromkeys(all_names))  # deduplicate, preserve order

            if found:
                print(f"  {term_case}: {', '.join(found)}")
            else:
                # Print a snippet from each block for manual inspection
                snippets = ' | '.join(b[:150].replace('\n', ' ') for b in blocks)
                print(f"  {term_case}: no names found — {snippets!r}")


if __name__ == '__main__':
    main()
