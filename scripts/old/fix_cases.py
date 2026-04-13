#!/usr/bin/env python3
"""Scan and fix common issues in cases.json files across one or more terms.

Checks performed:
  - Duplicate case numbers (cases whose comma-separated "number" fields share
    an individual docket number within the same term).
  - Old-format vote objects:  {"id": "…", "name": "…", "majority": true/false}
    are migrated to                  {"name": "…", "vote": "majority"/"minority"}.

  - Cases whose "id" field exists but is not the first key have it moved to
    the front of the object.

Usage:
    python3 scripts/old/fix_cases.py                      # all terms
    python3 scripts/old/fix_cases.py 2007-10              # single term
    python3 scripts/old/fix_cases.py 2000-10 2010-10      # range (inclusive)

    --dry-run   Report what would be changed without writing files.
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TERMS_JSON = REPO_ROOT / 'courts' / 'ussc' / 'terms.json'


def _parse_term_arg(s: str) -> str:
    """Accept YYYY or YYYY-MM, normalising YYYY → YYYY-10."""
    s = s.strip()
    if re.fullmatch(r'\d{4}', s):
        return f'{s}-10'
    if re.fullmatch(r'\d{4}-\d{2}', s):
        return s
    raise ValueError(f'Expected YYYY or YYYY-MM, got {s!r}')


def split_numbers(raw: str) -> list[str]:
    """Return individual docket numbers from a comma-separated string."""
    return [n.strip() for n in raw.split(',') if n.strip()]


# ---------------------------------------------------------------------------
# Vote migration
# ---------------------------------------------------------------------------

def _migrate_vote(vote: dict) -> tuple[dict, bool]:
    """Convert an old-format vote object to the new format if needed.

    Old:  {"id": "jgroberts", "name": "JOHN ROBERTS", "majority": true}
    New:  {"name": "JOHN ROBERTS", "vote": "majority"}

    Returns (possibly_updated_vote, was_changed).
    """
    if 'majority' not in vote:
        return vote, False
    new = {'name': vote['name'], 'vote': 'majority' if vote['majority'] else 'minority'}
    return new, True


def fix_votes(term: str, cases: list[dict], dry_run: bool) -> int:
    """Migrate old-format vote objects in *cases*.  Returns number of cases changed."""
    changed = 0
    for case in cases:
        new_votes = []
        case_changed = False
        for v in case.get('votes') or []:
            new_v, did_change = _migrate_vote(v)
            new_votes.append(new_v)
            if did_change:
                case_changed = True
        if case_changed:
            changed += 1
            label = f'  {term} {case.get("number", "?")} "{case.get("title", "?")}"'
            print(f'{label}: migrated {sum(1 for v in new_votes if "vote" in v)} vote(s)')
            if not dry_run:
                case['votes'] = new_votes
    return changed


def fix_id_position(term: str, cases: list[dict], dry_run: bool) -> int:
    """Move 'id' to be the first key in each case object where it isn't already.

    Returns number of cases changed.
    """
    changed = 0
    for case in cases:
        if 'id' not in case:
            continue
        keys = list(case.keys())
        if keys[0] == 'id':
            continue
        changed += 1
        print(f'  {term} {case.get("number", "?")} "{case.get("title", "?")}": moved "id" to front')
        if not dry_run:
            reordered = {'id': case['id']}
            reordered.update({k: v for k, v in case.items() if k != 'id'})
            case.clear()
            case.update(reordered)
    return changed


def check_duplicates(term: str, cases: list[dict]) -> int:
    """Check for duplicate case numbers.  Returns number of duplicates found."""
    number_to_cases: dict[str, list[dict]] = defaultdict(list)
    for case in cases:
        raw = case.get('number') or ''
        for num in split_numbers(raw):
            number_to_cases[num].append(case)

    duplicates = {num: entries for num, entries in number_to_cases.items() if len(entries) > 1}
    if not duplicates:
        return 0

    print(f'\n{term}: {len(duplicates)} duplicate docket number(s)')
    for num in sorted(duplicates):
        titles = ', '.join(f'"{c.get("title", "?")}" ({c.get("number", "?")})' for c in duplicates[num])
        print(f'  {num}  →  {titles}')

    return len(duplicates)


def process_term(term: str, dry_run: bool) -> tuple[int, int, int]:
    """Process one term.  Returns (duplicate_count, cases_with_votes_fixed, cases_with_id_moved)."""
    cases_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term / 'cases.json'
    if not cases_path.exists():
        return 0, 0, 0

    cases = json.loads(cases_path.read_text(encoding='utf-8'))
    if not cases:
        return 0, 0, 0

    dup_count   = check_duplicates(term, cases)
    votes_fixed = fix_votes(term, cases, dry_run)
    id_moved    = fix_id_position(term, cases, dry_run)

    if (votes_fixed or id_moved) and not dry_run:
        cases_path.write_text(
            json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )

    return dup_count, votes_fixed, id_moved


def main() -> None:
    raw_args = sys.argv[1:]
    dry_run = '--dry-run' in raw_args
    args = [a for a in raw_args if a != '--dry-run']

    if len(args) > 2:
        print(__doc__)
        sys.exit(1)

    all_terms = [entry['term'] for entry in json.loads(TERMS_JSON.read_text(encoding='utf-8'))]

    if len(args) == 0:
        terms_to_check = all_terms
    elif len(args) == 1:
        t = _parse_term_arg(args[0])
        terms_to_check = [t]
    else:
        start = _parse_term_arg(args[0])
        end   = _parse_term_arg(args[1])
        terms_to_check = [t for t in all_terms if start <= t <= end]

    if dry_run:
        print('(dry run — no files will be written)\n')

    total_dups = 0
    terms_with_dups = 0
    total_votes_fixed = 0
    terms_with_votes_fixed = 0
    total_id_moved = 0
    terms_with_id_moved = 0

    for term in terms_to_check:
        dup_count, votes_fixed, id_moved = process_term(term, dry_run)
        if dup_count:
            total_dups += dup_count
            terms_with_dups += 1
        if votes_fixed:
            total_votes_fixed += votes_fixed
            terms_with_votes_fixed += 1
        if id_moved:
            total_id_moved += id_moved
            terms_with_id_moved += 1

    print()
    if total_dups == 0:
        print('No duplicate docket numbers found.')
    else:
        print(f'Duplicates: {total_dups} docket number(s) across {terms_with_dups} term(s).')

    if total_votes_fixed == 0:
        print('No old-format votes found.')
    else:
        verb = 'Would fix' if dry_run else 'Fixed'
        print(f'Votes: {verb} {total_votes_fixed} case(s) across {terms_with_votes_fixed} term(s).')

    if total_id_moved == 0:
        print('No misplaced "id" fields found.')
    else:
        verb = 'Would move' if dry_run else 'Moved'
        print(f'ID position: {verb} "id" in {total_id_moved} case(s) across {terms_with_id_moved} term(s).')


if __name__ == '__main__':
    main()
