#!/usr/bin/env python3
"""Ensure audio arrays in all cases.json files are sorted by date ascending.

Usage:
    python3 scripts/old/sort_audio.py [--dry-run]

Iterates every courts/ussc/terms/*/cases.json, checks each case's audio
array, and re-sorts any that are out of order. Prints a warning for each
case that needed fixing. Rewrites the file in-place (preserving formatting)
when any case in the file was fixed.

Options:
    --dry-run   Report issues without writing any changes.
"""

import json
import sys
from pathlib import Path

REPO_ROOT  = Path(__file__).resolve().parent.parent.parent
TERMS_DIR  = REPO_ROOT / 'courts' / 'ussc' / 'terms'

def main() -> None:
    dry_run = '--dry-run' in sys.argv

    cases_files = sorted(TERMS_DIR.glob('*/cases.json'))
    if not cases_files:
        sys.exit('No cases.json files found under {}'.format(TERMS_DIR))

    total_fixed = 0

    for cases_file in cases_files:
        term = cases_file.parent.name
        try:
            cases = json.loads(cases_file.read_text(encoding='utf-8'))
        except Exception as e:
            print('ERROR reading {}: {}'.format(cases_file, e))
            continue

        file_dirty = False
        for case in cases:
            audio = case.get('audio')
            if not audio or len(audio) < 2:
                continue
            sorted_audio = sorted(audio, key=lambda a: (a.get('date') or ''))
            if sorted_audio != audio:
                dates = [a.get('date', '(none)') for a in audio]
                print('WARNING: {}/{} audio out of order: {}'.format(
                    term, case.get('number', '?'), dates))
                case['audio'] = sorted_audio
                file_dirty = True
                total_fixed += 1

        if file_dirty:
            if dry_run:
                print('  (dry-run: would rewrite {})'.format(cases_file))
            else:
                cases_file.write_text(
                    json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
                    encoding='utf-8',
                )
                print('  Fixed: {}'.format(cases_file))

    if total_fixed == 0:
        print('All audio arrays are already in date order.')
    else:
        action = 'would fix' if dry_run else 'fixed'
        print('\n{} {} case{}.'.format(action, total_fixed, 's' if total_fixed != 1 else ''))


if __name__ == '__main__':
    main()
