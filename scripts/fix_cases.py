#!/usr/bin/env python3
"""Scan and fix common issues in cases.json files across one or more terms.

Checks and fixes performed:
  - Duplicate docket numbers: cases whose comma-separated "number" fields share
    an individual docket number within the same term.
  - Old-format vote objects:  {"id": "…", "name": "…", "majority": true/false}
    are migrated to                  {"name": "…", "vote": "majority"/"minority"}.
  - "id" field position: cases whose "id" field exists but is not the first key
    have it moved to the front of the object.
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
  - Flat advocates arrays: migrates each audio object's "advocates" array from
    plain strings to {"name": …, "title": "MR."/"MS."} objects, inferring the
    title from the first name.

Usage:
    python3 scripts/fix_cases.py                      # all terms
    python3 scripts/fix_cases.py 2007-10              # single term
    python3 scripts/fix_cases.py 2000-10 2010-10      # range (inclusive)

    --dry-run   Report what would be changed without writing files.
"""

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

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


# ---------------------------------------------------------------------------
# Advocates migration
# ---------------------------------------------------------------------------

_MASC_FIRST_NAMES = {
    'PAUL', 'MICHAEL', 'DONALD', 'LAWRENCE', 'EDWIN', 'CHRISTOPHER',
    'MARK', 'WILLIAM', 'JACK', 'CHARLES', 'MILTON',
}


def _advocate_default_title(name: str) -> str:
    """Return 'MR.' if the first name is in the masculine list, else 'MS.'."""
    first = name.strip().split()[0].upper() if name.strip() else ''
    return 'MR.' if first in _MASC_FIRST_NAMES else 'MS.'


def fix_advocates(term: str, cases: list[dict], dry_run: bool) -> int:
    """Migrate flat advocates string arrays to [{name, title}] objects.

    Skips entries that are already dicts.  Returns number of audio objects changed.
    """
    changed = 0
    for case in cases:
        number_field = case.get('number', case.get('id', '?'))
        for audio in case.get('events', []):
            raw = audio.get('advocates')
            if not isinstance(raw, list) or not raw:
                continue
            # Check if any entry is still a plain string.
            if not any(isinstance(a, str) for a in raw):
                continue
            new_advs = []
            for entry in raw:
                if isinstance(entry, str):
                    new_advs.append({
                        'name': entry,
                        'title': _advocate_default_title(entry),
                    })
                else:
                    new_advs.append(entry)
            if dry_run:
                print(f'  MIGRATE advocates {term}/{number_field} '
                      f'[{audio.get("date", "?")}]: '
                      f'{len([a for a in raw if isinstance(a, str)])} string(s)')
            else:
                audio['advocates'] = new_advs
            changed += 1
    return changed


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


def rename_audio_to_events(term: str, cases: list[dict], dry_run: bool) -> int:
    """Rename the top-level 'audio' key to 'events' in every case object.

    Returns the number of cases updated.
    """
    changed = 0
    for case in cases:
        if 'audio' in case:
            if not dry_run:
                case['events'] = case.pop('audio')
            changed += 1
    return changed


def process_term(term: str, dry_run: bool) -> tuple[int, int, int]:
    """Process one term.  Returns (duplicate_count, cases_with_votes_fixed, cases_with_id_moved)."""
    cases_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term / 'cases.json'
    if not cases_path.exists():
        return 0, 0, 0

    cases = json.loads(cases_path.read_text(encoding='utf-8'))
    if not cases:
        return 0, 0, 0

    dup_count        = check_duplicates(term, cases)
    audio_renamed    = rename_audio_to_events(term, cases, dry_run)
    votes_fixed      = fix_votes(term, cases, dry_run)
    id_moved         = fix_id_position(term, cases, dry_run)
    advocates_fixed  = fix_advocates(term, cases, dry_run)

    cases_dir = TERMS_DIR / term / 'cases'
    href_updated, href_warned = fix_text_hrefs(term, cases, cases_dir, dry_run)
    href_missing  = check_missing_text_hrefs(term, cases, cases_dir)
    href_orphaned = check_orphaned_transcripts(term, cases, cases_dir)
    href_dupes    = check_duplicate_text_hrefs(term, cases)
    href_stripped = fix_oyez_transcript_hrefs(term, cases, dry_run)

    if (audio_renamed or votes_fixed or id_moved or advocates_fixed or href_updated or href_stripped) and not dry_run:
        cases_path.write_text(
            json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )

    return (dup_count, audio_renamed, votes_fixed, id_moved, advocates_fixed,
            href_updated, href_warned, href_missing,
            href_orphaned, href_dupes, href_stripped)


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

    total_dups              = 0
    terms_with_dups         = 0
    total_audio_renamed     = 0
    terms_with_renamed      = 0
    total_votes_fixed       = 0
    terms_with_votes        = 0
    total_id_moved          = 0
    terms_with_id           = 0
    total_advocates_fixed   = 0
    terms_with_advocates    = 0
    total_href_updated      = 0
    total_href_warned       = 0
    total_href_missing      = 0
    total_href_orphaned     = 0
    total_href_dupes        = 0
    total_href_stripped     = 0
    terms_with_href_fixes   = 0

    for term in terms_to_check:
        (dup_count, audio_renamed, votes_fixed, id_moved, advocates_fixed,
         href_updated, href_warned, href_missing,
         href_orphaned, href_dupes, href_stripped) = process_term(term, dry_run)

        if dup_count:
            total_dups      += dup_count
            terms_with_dups += 1
        if audio_renamed:
            total_audio_renamed += audio_renamed
            terms_with_renamed  += 1
        if votes_fixed:
            total_votes_fixed += votes_fixed
            terms_with_votes  += 1
        if id_moved:
            total_id_moved += id_moved
            terms_with_id  += 1
        if advocates_fixed:
            total_advocates_fixed += advocates_fixed
            terms_with_advocates  += 1

        href_any = href_updated + href_warned + href_missing + href_orphaned + href_dupes + href_stripped
        if href_any:
            total_href_updated  += href_updated
            total_href_warned   += href_warned
            total_href_missing  += href_missing
            total_href_orphaned += href_orphaned
            total_href_dupes    += href_dupes
            total_href_stripped += href_stripped
            terms_with_href_fixes += 1

    print()
    if total_dups == 0:
        print('No duplicate docket numbers found.')
    else:
        print(f'Duplicates: {total_dups} docket number(s) across {terms_with_dups} term(s).')

    if total_audio_renamed == 0:
        print('No "audio" keys to rename (already "events" or absent).')
    else:
        verb = 'Would rename' if dry_run else 'Renamed'
        print(f'audio→events: {verb} {total_audio_renamed} case(s) across {terms_with_renamed} term(s).')

    if total_votes_fixed == 0:
        print('No old-format votes found.')
    else:
        verb = 'Would fix' if dry_run else 'Fixed'
        print(f'Votes: {verb} {total_votes_fixed} case(s) across {terms_with_votes} term(s).')

    if total_id_moved == 0:
        print('No misplaced "id" fields found.')
    else:
        verb = 'Would move' if dry_run else 'Moved'
        print(f'ID position: {verb} "id" in {total_id_moved} case(s) across {terms_with_id} term(s).')

    if total_advocates_fixed == 0:
        print('No flat advocates arrays found.')
    else:
        verb = 'Would migrate' if dry_run else 'Migrated'
        print(f'Advocates: {verb} {total_advocates_fixed} audio object(s) across {terms_with_advocates} term(s).')

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

    if not any([total_dups, total_audio_renamed, total_votes_fixed, total_id_moved,
                total_advocates_fixed, total_href_updated, total_href_warned,
                total_href_missing, total_href_orphaned, total_href_dupes,
                total_href_stripped]):
        print('No issues found.')


if __name__ == '__main__':
    main()
