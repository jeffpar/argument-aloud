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
  - Event ordering: within each case, events are sorted by date, then by source
    so that 'ussc' appears before 'oyez' on the same date.
  - Case ordering: cases within each cases.json are sorted by their 'argument'
    date (cases without an 'argument' field are placed at the end).
  - Argument/reargument dates: ensures dates in each field are unique and in
    ascending order; removes any date from 'argument' that also appears in
    'reargument'.
  - Duplicate audio_href / transcript_href: across all terms in scope, reports
    any audio_href or transcript_href value that appears in more than one event
    (showing every term/case/date/source where each duplicate occurs).
  - Refiled case merging: after processing each term, checks the next two terms
    for a case with the same title and number.  If found, moves any events
    absent from the newer case into it (including their text_href files),
    sets 'previouslyFiled' on the newer case, and removes the case from the
    older term.

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


def check_duplicate_media_hrefs(terms_to_check: list[str]) -> int:
    """Scan audio_href and transcript_href across all terms in *terms_to_check*.

    Reports any URL that appears in more than one event object, together with
    every term/case/date/source where it was found.

    Returns the total number of duplicate URLs found.
    """
    # {field_name: {url: [(term, case_number, date, source), ...]}}
    seen: dict[str, dict[str, list[tuple[str, str, str, str]]]] = {
        'audio_href': defaultdict(list),
        'transcript_href': defaultdict(list),
    }

    for term in terms_to_check:
        cases_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term / 'cases.json'
        if not cases_path.exists():
            continue
        try:
            cases = json.loads(cases_path.read_text(encoding='utf-8'))
        except Exception:
            continue
        for case in cases:
            number = case.get('number', '?')
            for event in case.get('events', []):
                date   = event.get('date', '')
                source = event.get('source', '')
                for field in ('audio_href', 'transcript_href'):
                    url = event.get(field, '')
                    if url:
                        seen[field][url].append((term, number, date, source))

    total_dupes = 0
    for field, url_map in seen.items():
        dupes = {url: locs for url, locs in url_map.items() if len(locs) > 1}
        if not dupes:
            continue
        print(f'\nDuplicate {field} ({len(dupes)} URL(s)):')
        for url in sorted(dupes):
            locs = dupes[url]
            print(f'  {url}')
            for term, number, date, source in locs:
                label = f'{source} {date}' if date else source
                print(f'    {term}/{number}  [{label}]')
            total_dupes += 1
    return total_dupes


# Source priority for same-date event sorting (lower = earlier).
_SOURCE_ORDER: dict[str, int] = {'ussc': 0, 'nara': 1, 'oyez': 2}


def _parse_date_field(value: str) -> list[str]:
    """Split a comma-separated date field into a list of non-empty date strings."""
    return [d.strip() for d in value.split(',') if d.strip()]


def _join_dates(dates: list[str]) -> str:
    """Join a list of dates back to a comma-separated string."""
    return ','.join(dates)


def fix_argument_dates(
    term: str, cases: list[dict], dry_run: bool
) -> tuple[int, int]:
    """Validate and fix 'argument' and 'reargument' date fields.

    For each case:
      1. Deduplicate and sort each date field (ascending).
      2. Remove any date from 'argument' that also appears in 'reargument'.

    Returns (fixed_count, warned_count) where:
      - fixed_count: cases where a field was actually changed.
      - warned_count: cases that were already invalid but not auto-fixable
        (currently unused — all issues are auto-fixed).
    """
    fixed = 0
    for case in cases:
        number = case.get('number', '?')
        changed = False
        for field in ('argument', 'reargument'):
            raw = case.get(field)
            if not raw:
                continue
            dates = _parse_date_field(str(raw))
            # Deduplicate preserving first occurrence, then sort.
            seen: set[str] = set()
            unique: list[str] = []
            for d in dates:
                if d not in seen:
                    seen.add(d)
                    unique.append(d)
            sorted_dates = sorted(unique)
            new_val = _join_dates(sorted_dates)
            if new_val != str(raw):
                if dry_run:
                    print(f'  FIX {field} {term}/{number}: {raw!r} -> {new_val!r}')
                else:
                    case[field] = new_val
                changed = True

        # Remove dates from 'argument' that also appear in 'reargument'.
        arg_raw   = case.get('argument')
        rearg_raw = case.get('reargument')
        if arg_raw and rearg_raw:
            rearg_dates = set(_parse_date_field(str(rearg_raw)))
            arg_dates   = _parse_date_field(str(case.get('argument', '')))
            filtered    = [d for d in arg_dates if d not in rearg_dates]
            if len(filtered) != len(arg_dates):
                removed = sorted(set(arg_dates) - set(filtered))
                if dry_run:
                    print(f'  FIX argument {term}/{number}: removing {removed} '
                          f'(also in reargument)')
                if filtered:
                    new_arg = _join_dates(filtered)
                else:
                    new_arg = ''
                if not dry_run:
                    if new_arg:
                        case['argument'] = new_arg
                    else:
                        case.pop('argument', None)
                changed = True

        if changed:
            fixed += 1
    return fixed, 0


def _event_sort_key(event: dict) -> tuple:
    """Sort key for events: (date, source_priority, source_name)."""
    date   = event.get('date') or ''
    source = event.get('source') or ''
    return (date, _SOURCE_ORDER.get(source, 99), source)


def sort_events(term: str, cases: list[dict], dry_run: bool) -> int:
    """Sort the events list of each case by date then by source priority.

    Returns the number of cases whose event list was reordered.
    """
    changed = 0
    for case in cases:
        events = case.get('events')
        if not events or len(events) < 2:
            continue
        sorted_events = sorted(events, key=_event_sort_key)
        if [id(e) for e in sorted_events] != [id(e) for e in events]:
            changed += 1
            if dry_run:
                number = case.get('number', '?')
                print(f'  SORT events {term}/{number}')
            else:
                events[:] = sorted_events
    return changed


def sort_cases(term: str, cases: list[dict], dry_run: bool) -> int:
    """Sort cases by their 'argument' date; cases without one go last.

    Returns 1 if the list was reordered, 0 otherwise.
    """
    def _case_key(case: dict) -> tuple:
        arg = case.get('argument') or ''
        return ('1' if not arg else '0', arg)

    sorted_cases = sorted(cases, key=_case_key)
    if [id(c) for c in sorted_cases] != [id(c) for c in cases]:
        if dry_run:
            print(f'  SORT cases {term}')
        else:
            cases[:] = sorted_cases
        return 1
    return 0


def merge_refiled_cases(
    term: str,
    cases: list[dict],
    all_terms: list[str],
    dry_run: bool,
) -> int:
    """Check the next two terms for cases matching each case in *term* by title
    and number.  When a match is found:

      - Events in the older case that are absent from the newer case are moved
        into the newer case (re-sorted in place).
      - Any text_href files belonging to those events are moved from the older
        term's cases directory to the newer term's cases directory.
      - 'previouslyFiled' is set on the newer case (e.g. "2024-10/24-123").
      - The older case is removed from *cases* (in-place when not dry-run).
      - The newer term's cases.json is written immediately.

    Returns the number of cases removed from *cases*.
    """
    try:
        term_idx = all_terms.index(term)
    except ValueError:
        return 0

    later_terms = all_terms[term_idx + 1 : term_idx + 3]
    if not later_terms:
        return 0

    # Load cases from the next two terms; build (title, number) -> (later_term, cases_list, case)
    later_case_map: dict[tuple[str, str], tuple[str, list[dict], dict]] = {}
    later_cases_lists: dict[str, list[dict]] = {}

    for lt in later_terms:
        lpath = TERMS_DIR / lt / 'cases.json'
        if not lpath.exists():
            continue
        try:
            lcases: list[dict] = json.loads(lpath.read_text(encoding='utf-8'))
        except Exception:
            continue
        later_cases_lists[lt] = lcases
        for lcase in lcases:
            lkey = (lcase.get('title', ''), lcase.get('number', ''))
            if lkey[0] and lkey[1] and lkey not in later_case_map:
                later_case_map[lkey] = (lt, lcases, lcase)

    if not later_case_map:
        return 0

    def _event_id(ev: dict) -> str:
        """Unique identifier: audio_href when present, else date|source|type."""
        ah = ev.get('audio_href', '')
        return ah if ah else f'{ev.get("date","")}|{ev.get("source","")}|{ev.get("type","")}'

    merged_terms_written: set[str] = set()
    cases_to_remove: list[dict] = []

    for old_case in cases:
        title  = old_case.get('title', '')
        number = old_case.get('number', '')
        if not title or not number:
            continue
        match = later_case_map.get((title, number))
        if match is None:
            continue
        later_term, later_cases_list, new_case = match

        old_events    = old_case.get('events', [])
        new_event_ids = {_event_id(e) for e in new_case.get('events', [])}
        events_to_move = [e for e in old_events if _event_id(e) not in new_event_ids]

        print(f'  MERGE {term}/{number} -> {later_term}/{number} '
              f'({len(events_to_move)} of {len(old_events)} event(s) to move)')

        if not dry_run:
            old_cases_dir = TERMS_DIR / term / 'cases'
            new_cases_dir = TERMS_DIR / later_term / 'cases'

            for ev in events_to_move:
                th = ev.get('text_href', '')
                if th and not th.startswith('http') and '/' in th:
                    src = old_cases_dir / th
                    dst = new_cases_dir / th
                    if src.exists():
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        src.rename(dst)
                        print(f'    moved file {th}')

            # Merge events into new case and re-sort
            new_events = new_case.setdefault('events', [])
            new_events.extend(events_to_move)
            new_events.sort(key=_event_sort_key)

            # Set previouslyFiled and reorder case keys
            new_case['previouslyFiled'] = f'{term}/{number}'
            reordered, _ = _reorder(new_case, CASE_KEY_ORDER)
            new_case.clear()
            new_case.update(reordered)

            # Reorder keys on every event in the merged case
            for ev in new_case.get('events', []):
                new_ev, _ = _reorder(ev, EVENT_KEY_ORDER)
                if list(new_ev.keys()) != list(ev.keys()):
                    ev.clear()
                    ev.update(new_ev)

            merged_terms_written.add(later_term)

        cases_to_remove.append(old_case)

    if not cases_to_remove:
        return 0

    if not dry_run:
        for c in cases_to_remove:
            cases.remove(c)
        for lt in merged_terms_written:
            lpath = TERMS_DIR / lt / 'cases.json'
            lpath.write_text(
                json.dumps(later_cases_lists[lt], indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )

    return len(cases_to_remove)


def process_term(
    term: str,
    dry_run: bool,
    check_dups: bool = False,
    all_terms: list[str] | None = None,
) -> tuple[int, int, int]:
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

    events_sorted = sort_events(term, cases, dry_run)
    cases_sorted  = sort_cases(term, cases, dry_run)
    arg_dates_fixed, _ = fix_argument_dates(term, cases, dry_run)
    merged_count  = merge_refiled_cases(term, cases, all_terms or [], dry_run)

    if (cases_reordered or events_reordered or href_updated or href_stripped
            or events_sorted or cases_sorted or arg_dates_fixed
            or merged_count) and not dry_run:
        cases_path.write_text(
            json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )

    return (dup_count, cases_reordered, events_reordered, unknown_keys, unknown_event_keys,
            href_updated, href_warned, href_missing,
            href_orphaned, href_dupes, href_stripped,
            events_sorted, cases_sorted, arg_dates_fixed, merged_count)


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
    total_events_sorted     = 0
    total_cases_sorted      = 0
    total_arg_dates_fixed   = 0
    total_merged            = 0

    for term in terms_to_check:
        (dup_count, cases_reordered, events_reordered, unknown_keys, unknown_event_keys,
         href_updated, href_warned, href_missing,
         href_orphaned, href_dupes, href_stripped,
         events_sorted, cases_sorted, arg_dates_fixed, merged_count) = process_term(
            term, dry_run, check_dups, all_terms)

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
        total_events_sorted += events_sorted
        total_cases_sorted  += cases_sorted
        total_arg_dates_fixed += arg_dates_fixed
        total_merged        += merged_count

    total_media_dupes = check_duplicate_media_hrefs(terms_to_check)

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

    if total_events_sorted:
        verb = 'Would sort' if dry_run else 'Sorted'
        print(f'Event order: {verb} events in {total_events_sorted} case(s).')
    if total_cases_sorted:
        verb = 'Would sort' if dry_run else 'Sorted'
        print(f'Case order: {verb} cases in {total_cases_sorted} term(s).')
    if total_arg_dates_fixed:
        verb = 'Would fix' if dry_run else 'Fixed'
        print(f'Argument dates: {verb} {total_arg_dates_fixed} case(s).')
    if total_merged:
        verb = 'Would merge' if dry_run else 'Merged'
        print(f'Refiled cases: {verb} {total_merged} case(s) into later term(s).')
    if total_media_dupes:
        print(f'Media hrefs: {total_media_dupes} duplicate URL(s) found across scope.')

    if not any([total_dups, total_cases_reordered, total_events_reordered,
                total_href_updated, total_href_warned, total_href_missing,
                total_href_orphaned, total_href_dupes, total_href_stripped,
                total_events_sorted, total_cases_sorted, total_arg_dates_fixed,
                total_merged, total_media_dupes]):
        print('No issues found.')


if __name__ == '__main__':
    main()
