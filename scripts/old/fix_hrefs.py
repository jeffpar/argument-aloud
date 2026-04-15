#!/usr/bin/env python3
"""Audit and fix text_href values in cases.json files.

Three passes are performed for every courts/ussc/terms/*/cases.json:

  Pass 1 – Migrate bare filenames
    Rewrites each audio entry's text_href from a bare filename
    (e.g. "2006-11-08-oyez.json") to a folder-relative path
    (e.g. "05-380/2006-11-08-oyez.json").

  Pass 2 – Verify existing text_href values
    For every text_href that already contains a folder prefix, checks that the
    referenced file actually exists on disk.  Missing files are reported as
    warnings.

  Pass 3 – Detect orphaned transcript files
    Scans every terms/<term>/cases/<number>/*.json file and reports any that
    are not referenced by any text_href in cases.json.

Usage:
    python3 scripts/old/fix_hrefs.py [--dry-run]

Flags:
    --dry-run   Print what would change without writing any files.
"""

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TERMS_DIR = REPO_ROOT / 'courts' / 'ussc' / 'terms'

# Files inside cases/NUMBER/ that are never transcript envelopes.
_NON_TRANSCRIPT_NAMES = {'files.json'}

# Filename substrings that indicate non-transcript working files.
_NON_TRANSCRIPT_SUFFIXES = ('--whisper',)


def main() -> None:
    dry_run = '--dry-run' in sys.argv

    if dry_run:
        print('DRY RUN — no files will be written.\n')

    total_updated   = 0
    total_missing   = 0
    total_orphaned  = 0
    total_warned    = 0
    total_dupes     = 0
    files_written   = 0

    for cases_path in sorted(TERMS_DIR.glob('*/cases.json')):
        term      = cases_path.parent.name
        cases_dir = cases_path.parent / 'cases'
        cases     = json.loads(cases_path.read_text(encoding='utf-8'))

        term_updated  = 0
        term_missing  = 0
        term_orphaned = 0
        term_warned   = 0
        term_dupes    = 0

        # ── Pass 1: migrate bare filenames ────────────────────────────────────
        for case in cases:
            number_field = case.get('number', '')
            numbers = [n.strip() for n in number_field.split(',') if n.strip()]

            for audio in case.get('audio', []):
                th = audio.get('text_href', '')
                if not th:
                    continue
                if th.startswith('http') or '/' in th:
                    continue  # already absolute URL or already has a folder prefix

                found_num = None
                for num in numbers:
                    if (cases_dir / num / th).exists():
                        found_num = num
                        break

                if found_num is None:
                    print(f'  WARNING: {term}/{number_field}: cannot find {th!r} '
                          f'under any of {numbers}')
                    total_warned += 1
                    term_warned  += 1
                    continue

                new_href = f'{found_num}/{th}'
                if dry_run:
                    print(f'  MIGRATE {term}/{number_field}: {th!r} -> {new_href!r}')
                audio['text_href'] = new_href
                term_updated += 1

        # ── Pass 2: verify existing folder-prefixed text_hrefs ────────────────
        for case in cases:
            number_field = case.get('number', '')
            for audio in case.get('audio', []):
                th = audio.get('text_href', '')
                if not th or th.startswith('http') or '/' not in th:
                    continue
                target = cases_dir / th
                if not target.exists():
                    print(f'  MISSING: {term}/{number_field}: text_href {th!r} '
                          f'does not exist on disk')
                    total_missing += 1
                    term_missing  += 1

        # ── Pass 3: detect orphaned transcript files ───────────────────────────
        # Build the set of all text_href values (folder-prefixed) in this term.
        referenced: set[str] = set()
        for case in cases:
            for audio in case.get('audio', []):
                th = audio.get('text_href', '')
                if th and '/' in th and not th.startswith('http'):
                    referenced.add(th)

        if cases_dir.is_dir():
            for json_file in sorted(cases_dir.glob('*/*.json')):
                if json_file.name in _NON_TRANSCRIPT_NAMES:
                    continue
                if any(s in json_file.stem for s in _NON_TRANSCRIPT_SUFFIXES):
                    continue
                # Relative path from cases_dir: "NUMBER/YYYY-MM-DD.json"
                rel = json_file.relative_to(cases_dir).as_posix()
                if rel not in referenced:
                    print(f'  ORPHAN:  {term}/{rel}')
                    total_orphaned += 1
                    term_orphaned  += 1

        # ── Pass 4: detect duplicate text_href values ──────────────────────────
        seen: dict[str, str] = {}  # text_href -> first case number that used it
        for case in cases:
            number_field = case.get('number', '')
            for audio in case.get('audio', []):
                th = audio.get('text_href', '')
                if not th or th.startswith('http') or '/' not in th:
                    continue
                if th in seen:
                    print(f'  DUPE:    {term}/{number_field}: text_href {th!r} '
                          f'already used by {seen[th]}')
                    total_dupes += 1
                    term_dupes  += 1
                else:
                    seen[th] = number_field

        # ── Write updated cases.json ───────────────────────────────────────────
        if term_updated and not dry_run:
            cases_path.write_text(
                json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            files_written += 1

        if term_updated or term_warned or term_missing or term_orphaned or term_dupes:
            parts = []
            if term_updated:
                parts.append(f'migrated {term_updated}')
            if term_missing:
                parts.append(f'{term_missing} missing')
            if term_orphaned:
                parts.append(f'{term_orphaned} orphaned')
            if term_dupes:
                parts.append(f'{term_dupes} duplicate(s)')
            if term_warned:
                parts.append(f'{term_warned} unresolvable')
            print(f'{term}: {", ".join(parts)}')

        total_updated += term_updated

    print()
    if dry_run:
        print(f'Would migrate {total_updated} text_href(s).')
    else:
        print(f'Migrated {total_updated} text_href(s) in {files_written} cases.json file(s).')
    if total_missing:
        print(f'{total_missing} text_href(s) point to missing files.')
    if total_orphaned:
        print(f'{total_orphaned} transcript file(s) have no text_href reference.')
    if total_dupes:
        print(f'{total_dupes} duplicate text_href value(s) found.')
    if total_warned:
        print(f'{total_warned} bare text_href(s) could not be resolved and were left unchanged.')


if __name__ == '__main__':
    main()
