#!/usr/bin/env python3
"""Convert bare text_href filenames in cases.json to folder-relative paths.

Walks every courts/ussc/terms/*/cases.json and rewrites each audio entry's
text_href from a bare filename (e.g. "2006-11-08-oyez.json") to a path
relative to the term's "cases/" directory (e.g. "05-380/2006-11-08-oyez.json").

The target folder is determined by looking for the file under each case number
in the case's "number" field (comma-separated), starting with the first.  If
the file cannot be found under any of them, a warning is printed and the entry
is left unchanged.

Entries whose text_href already contains "/" or starts with "http" are skipped.

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


def main() -> None:
    dry_run = '--dry-run' in sys.argv

    if dry_run:
        print('DRY RUN — no files will be written.\n')

    total_updated = 0
    total_warned  = 0
    files_written = 0

    for cases_path in sorted(TERMS_DIR.glob('*/cases.json')):
        term       = cases_path.parent.name
        cases_dir  = cases_path.parent / 'cases'
        cases      = json.loads(cases_path.read_text(encoding='utf-8'))

        term_updated = 0
        term_warned  = 0

        for case in cases:
            number_field = case.get('number', '')
            numbers = [n.strip() for n in number_field.split(',') if n.strip()]

            for audio in case.get('audio', []):
                th = audio.get('text_href', '')
                if not th:
                    continue
                if th.startswith('http') or '/' in th:
                    continue  # already absolute URL or already has a folder prefix

                # Find which case folder contains this file.
                found_num = None
                for num in numbers:
                    if (cases_dir / num / th).exists():
                        found_num = num
                        break

                if found_num is None:
                    print(f'WARNING: {term}/{number_field}: cannot find {th!r} '
                          f'under any of {numbers}')
                    total_warned  += 1
                    term_warned   += 1
                    continue

                new_href = f'{found_num}/{th}'
                if dry_run:
                    print(f'  {term}/{number_field}: {th!r} -> {new_href!r}')
                audio['text_href'] = new_href
                term_updated += 1

        if term_updated and not dry_run:
            cases_path.write_text(
                json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            files_written += 1

        if term_updated or term_warned:
            status = f'updated {term_updated}'
            if term_warned:
                status += f', {term_warned} warnings'
            print(f'{term}: {status}')

        total_updated += term_updated

    print()
    if dry_run:
        print(f'Would update {total_updated} text_href(s) across {files_written or "N"} file(s).')
    else:
        print(f'Updated {total_updated} text_href(s) in {files_written} cases.json file(s).')
    if total_warned:
        print(f'{total_warned} text_href(s) could not be resolved and were left unchanged.')


if __name__ == '__main__':
    main()
