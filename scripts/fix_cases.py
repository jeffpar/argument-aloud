#!/usr/bin/env python3
"""Scan and fix common issues in cases.json files across one or more terms.

Checks and fixes performed:
  - Duplicate docket numbers: cases whose comma-separated "number" fields share
    an individual docket number within the same term.
  - Key ordering: reorders keys in every case object and every event object
    within it to match the canonical order.  Unknown case keys are reported
    during --dry-run so they can be assigned a position.
  - Bare text_href filenames: rewrites each audio entry's text_href from a bare
    filename (e.g. "2006-11-08-oyez.json") to a folder-relative path
    (e.g. "05-380/2006-11-08-oyez.json").
  - Missing text_href targets: for every text_href that contains a folder
    prefix, checks that the referenced file actually exists on disk.
  - Orphaned transcript files: scans every terms/<term>/cases/<number>/*.json
    and reports files not referenced by any text_href in cases.json.
  - Duplicate text_href values: reports any text_href used by more than one
    audio entry within a term.
  - Duplicate oyez transcript_href: when a ussc audio object has a
    transcript_href that also appears on an oyez audio object in the same case,
    removes the transcript_href from the oyez object.

Usage:
    python3 scripts/fix_cases.py                      # all terms
    python3 scripts/fix_cases.py 2007-10              # single term
    python3 scripts/fix_cases.py 2000-10 2010-10      # range (inclusive)

    --dry-run      Report what would be changed without writing files.
    --duplicates   Also check for duplicate docket numbers within each term.
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from schema import CASE_KEY_ORDER, EVENT_KEY_ORDER

REPO_ROOT = Path(__file__).resolve().parent.parent
TERMS_JSON = REPO_ROOT / 'courts' / 'ussc' / 'terms.json'
TERMS_DIR  = REPO_ROOT / 'courts' / 'ussc' / 'terms'

# Files inside cases/NUMBER/ that are never transcript envelopes.
_NON_TRANSCRIPT_NAMES = {'files.json'}

# Filename substrings that indicate non-transcript working files.
_NON_TRANSCRIPT_SUFFIXES = ('--whisper',)


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
# Key ordering
# ---------------------------------------------------------------------------

def _reorder(obj: dict, order: list[str]) -> tuple[dict, set[str]]:
    """Return a copy of *obj* with keys in *order*, unknown keys appended.

    Also returns the set of unknown key names.
    """
    known = {k: obj[k] for k in order if k in obj}
    unknown_keys = set(obj) - set(order)
    extras = {k: obj[k] for k in obj if k in unknown_keys}
    return {**known, **extras}, unknown_keys


def fix_key_order(
    term: str, cases: list[dict], dry_run: bool
) -> tuple[int, int, set[str], set[str]]:
    """Reorder keys in every case object and every event object within it.

    During dry-run, reports any unknown case-level or event-level keys found.
    Returns (cases_reordered, events_reordered, unknown_case_keys, unknown_event_keys).
    """
    cases_changed = 0
    events_changed = 0
    unknown_case_keys: set[str] = set()
    unknown_event_keys: set[str] = set()

    for case in cases:
        # Reorder events first (in-place so the case dict picks them up)
        for event in case.get('events', []):
            new_event, ev_unknown = _reorder(event, EVENT_KEY_ORDER)
            unknown_event_keys |= ev_unknown
            if list(new_event.keys()) != list(event.keys()):
                events_changed += 1
                if not dry_run:
                    event.clear()
                    event.update(new_event)

        # Reorder case
        new_case, unknown = _reorder(case, CASE_KEY_ORDER)
        unknown_case_keys |= unknown
        if list(new_case.keys()) != list(case.keys()):
            cases_changed += 1
            if not dry_run:
                case.clear()
                case.update(new_case)

    if dry_run and unknown_case_keys:
        print(f'  {term}: unknown case keys: {sorted(unknown_case_keys)}')
    if dry_run and unknown_event_keys:
        print(f'  {term}: unknown event keys: {sorted(unknown_event_keys)}')

    return cases_changed, events_changed, unknown_case_keys, unknown_event_keys


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

    print(f'{term}: {len(duplicates)} duplicate docket number(s)')
    for num in sorted(duplicates):
        titles = ', '.join(f'"{c.get("title", "?")}" ({c.get("number", "?")})' for c in duplicates[num])
        print(f'  {num}  →  {titles}')

    return len(duplicates)


# ---------------------------------------------------------------------------
# text_href fixes (merged from fix_hrefs.py)
# ---------------------------------------------------------------------------

def fix_text_hrefs(
    term: str, cases: list[dict], cases_dir: Path, dry_run: bool
) -> tuple[int, int]:
    """Pass 1: migrate bare text_href filenames to folder-prefixed form.

    Returns (updated_count, warned_count).
    """
    updated = warned = 0
    for case in cases:
        number_field = case.get('number', '')
        numbers = [n.strip() for n in number_field.split(',') if n.strip()]
        for audio in case.get('events', []):
            th = audio.get('text_href', '')
            if not th or th.startswith('http') or '/' in th:
                continue
            found_num = next(
                (num for num in numbers if (cases_dir / num / th).exists()), None
            )
            if found_num is None:
                print(f'  WARNING: {term}/{number_field}: cannot find {th!r} '
                      f'under any of {numbers}')
                warned += 1
                continue
            new_href = f'{found_num}/{th}'
            if dry_run:
                print(f'  MIGRATE {term}/{number_field}: {th!r} -> {new_href!r}')
            audio['text_href'] = new_href
            updated += 1
    return updated, warned


def check_missing_text_hrefs(
    term: str, cases: list[dict], cases_dir: Path
) -> int:
    """Pass 2: report text_hrefs whose target files are missing on disk.

    Returns missing_count.
    """
    missing = 0
    for case in cases:
        number_field = case.get('number', '')
        for audio in case.get('events', []):
            th = audio.get('text_href', '')
            if not th or th.startswith('http') or '/' not in th:
                continue
            if not (cases_dir / th).exists():
                print(f'  MISSING: {term}/{number_field}: text_href {th!r} '
                      f'does not exist on disk')
                missing += 1
    return missing


def check_orphaned_transcripts(
    term: str, cases: list[dict], cases_dir: Path
) -> int:
    """Pass 3: report transcript files not referenced by any text_href.

    Returns orphaned_count.
    """
    referenced: set[str] = {
        audio.get('text_href', '')
        for case in cases
        for audio in case.get('events', [])
        if audio.get('text_href', '') and '/' in audio.get('text_href', '')
        and not audio.get('text_href', '').startswith('http')
    }
    orphaned = 0
    if cases_dir.is_dir():
        for json_file in sorted(cases_dir.glob('*/*.json')):
            if json_file.name in _NON_TRANSCRIPT_NAMES:
                continue
            if any(s in json_file.stem for s in _NON_TRANSCRIPT_SUFFIXES):
                continue
            rel = json_file.relative_to(cases_dir).as_posix()
            if rel not in referenced:
                print(f'  ORPHAN:  {term}/{rel}')
                orphaned += 1
    return orphaned


def check_duplicate_text_hrefs(term: str, cases: list[dict]) -> int:
    """Pass 4: report text_href values used by more than one audio entry.

    Returns dupe_count.
    """
    seen: dict[str, str] = {}
    dupes = 0
    for case in cases:
        number_field = case.get('number', '')
        for audio in case.get('events', []):
            th = audio.get('text_href', '')
            if not th or th.startswith('http') or '/' not in th:
                continue
            if th in seen:
                print(f'  DUPE:    {term}/{number_field}: text_href {th!r} '
                      f'already used by {seen[th]}')
                dupes += 1
            else:
                seen[th] = number_field
    return dupes


def fix_oyez_transcript_hrefs(
    term: str, cases: list[dict], dry_run: bool
) -> int:
    """Pass 5: remove transcript_href from oyez objects when the same URL is
    already on a ussc object in the same case.

    Returns stripped_count.
    """
    stripped = 0
    for case in cases:
        number_field = case.get('number', '')
        ussc_hrefs: set[str] = {
            audio['transcript_href']
            for audio in case.get('events', [])
            if audio.get('source', 'ussc') == 'ussc' and audio.get('transcript_href')
        }
        if not ussc_hrefs:
            continue
        for audio in case.get('events', []):
            if audio.get('source') != 'oyez':
                continue
            th = audio.get('transcript_href', '')
            if th and th in ussc_hrefs:
                if dry_run:
                    print(f'  STRIP transcript_href {term}/{number_field} '
                          f'[oyez {audio.get("date", "?")}]: {th!r}')
                else:
                    del audio['transcript_href']
                stripped += 1
    return stripped


def process_term(term: str, dry_run: bool, check_dups: bool = False) -> tuple[int, int, int]:
    """Process one term.  Returns counts of changes and any unknown case keys."""
    cases_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term / 'cases.json'
    if not cases_path.exists():
        return 0, 0, 0

    cases = json.loads(cases_path.read_text(encoding='utf-8'))
    if not cases:
        return 0, 0, 0

    dup_count        = check_duplicates(term, cases) if check_dups else 0
    cases_reordered, events_reordered, unknown_keys, unknown_event_keys = fix_key_order(term, cases, dry_run)

    cases_dir = TERMS_DIR / term / 'cases'
    href_updated, href_warned = fix_text_hrefs(term, cases, cases_dir, dry_run)
    href_missing  = check_missing_text_hrefs(term, cases, cases_dir)
    href_orphaned = check_orphaned_transcripts(term, cases, cases_dir)
    href_dupes    = check_duplicate_text_hrefs(term, cases) if check_dups else 0
    href_stripped = fix_oyez_transcript_hrefs(term, cases, dry_run)

    if (cases_reordered or events_reordered or href_updated or href_stripped) and not dry_run:
        cases_path.write_text(
            json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )

    return (dup_count, cases_reordered, events_reordered, unknown_keys, unknown_event_keys,
            href_updated, href_warned, href_missing,
            href_orphaned, href_dupes, href_stripped)


def main() -> None:
    raw_args = sys.argv[1:]
    dry_run    = '--dry-run'    in raw_args
    check_dups = '--duplicates' in raw_args
    args = [a for a in raw_args if a not in ('--dry-run', '--duplicates')]

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

    total_dups              = 0
    terms_with_dups         = 0
    total_cases_reordered   = 0
    total_events_reordered  = 0
    all_unknown_case_keys: set[str] = set()
    all_unknown_event_keys: set[str] = set()
    total_href_updated      = 0
    total_href_warned       = 0
    total_href_missing      = 0
    total_href_orphaned     = 0
    total_href_dupes        = 0
    total_href_stripped     = 0

    for term in terms_to_check:
        (dup_count, cases_reordered, events_reordered, unknown_keys, unknown_event_keys,
         href_updated, href_warned, href_missing,
         href_orphaned, href_dupes, href_stripped) = process_term(term, dry_run, check_dups)

        if dup_count:
            total_dups      += dup_count
            terms_with_dups += 1
        total_cases_reordered  += cases_reordered
        total_events_reordered += events_reordered
        all_unknown_case_keys  |= unknown_keys
        all_unknown_event_keys |= unknown_event_keys
        total_href_updated  += href_updated
        total_href_warned   += href_warned
        total_href_missing  += href_missing
        total_href_orphaned += href_orphaned
        total_href_dupes    += href_dupes
        total_href_stripped += href_stripped

    if check_dups:
        if total_dups == 0:
            print('No duplicate docket numbers found.')
        else:
            print(f'Duplicates: {total_dups} docket number(s) across {terms_with_dups} term(s).')

    if total_cases_reordered == 0 and total_events_reordered == 0:
        print('No key-ordering changes needed.')
    else:
        verb = 'Would reorder' if dry_run else 'Reordered'
        parts = []
        if total_cases_reordered:
            parts.append(f'{total_cases_reordered} case(s)')
        if total_events_reordered:
            parts.append(f'{total_events_reordered} event(s)')
        print(f'Key order: {verb} {" and ".join(parts)}.')
    if dry_run and all_unknown_case_keys:
        print(f'Key order: unknown case keys found: {sorted(all_unknown_case_keys)}')
    if all_unknown_event_keys:
        print(f'Key order: unknown event keys found: {sorted(all_unknown_event_keys)}')

    if total_href_updated:
        verb = 'Would migrate' if dry_run else 'Migrated'
        print(f'text_href: {verb} {total_href_updated} bare filename(s).')
    if total_href_warned:
        print(f'text_href: {total_href_warned} bare filename(s) could not be resolved.')
    if total_href_missing:
        print(f'text_href: {total_href_missing} reference(s) point to missing files.')
    if total_href_orphaned:
        print(f'text_href: {total_href_orphaned} transcript file(s) have no reference.')
    if total_href_dupes:
        print(f'text_href: {total_href_dupes} duplicate value(s) found.')
    if total_href_stripped:
        verb = 'Would strip' if dry_run else 'Stripped'
        print(f'transcript_href: {verb} duplicate from {total_href_stripped} oyez audio object(s).')

    if not any([total_dups, total_cases_reordered, total_events_reordered,
                total_href_updated, total_href_warned, total_href_missing,
                total_href_orphaned, total_href_dupes, total_href_stripped]):
        print('No issues found.')


if __name__ == '__main__':
    main()
