#!/usr/bin/env python3
"""Backfill unique IDs in case JSON files for a given SCOTUS term.

Usage:
    python3 scripts/fix_json.py 2025-10

For each case directory under courts/ussc/terms/TERM/:

  files.json
    Adds a "file" property (integer) to every entry that is missing it.
    Numbering starts at 1, or at max(existing "file" values) + 1 so no
    existing IDs are ever reused.  The "file" key is placed first in each
    object for readability.

  YYYY-MM-DD.json  (transcript files)
    Adds a "turn" property (1-based integer) to every turn that is missing
    it.  The number reflects the turn's position in the array, so turn 1 is
    always the first turn.  The "turn" key is placed first.
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT     = Path(__file__).resolve().parent.parent
DATE_JSON_RE  = re.compile(r'^\d{4}-\d{2}-\d{2}\.json$')


# ── Helpers ───────────────────────────────────────────────────────────────────

def _reorder(obj: dict, first_key: str) -> dict:
    """Return a copy of *obj* with *first_key* as the first entry."""
    return {first_key: obj[first_key], **{k: v for k, v in obj.items() if k != first_key}}


# ── Fix files.json ────────────────────────────────────────────────────────────

def fix_files_json(path: Path) -> bool:
    """Add missing "file" IDs; return True if the file was modified."""
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return False

    # Next ID = one past the highest existing "file" value (floor 0).
    next_id = max((e.get('file', 0) for e in data), default=0) + 1
    changed = False

    for i, entry in enumerate(data):
        if 'file' not in entry:
            entry['file'] = next_id
            data[i] = _reorder(entry, 'file')
            next_id += 1
            changed = True

    if changed:
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
    return changed


# ── Fix transcript JSON ───────────────────────────────────────────────────────

def fix_transcript_json(path: Path) -> bool:
    """Add missing "turn" IDs (1-based position); return True if modified."""
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return False

    changed = False
    for i, turn in enumerate(data):
        if 'turn' not in turn:
            turn['turn'] = i + 1
            data[i] = _reorder(turn, 'turn')
            changed = True

    if changed:
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
    return changed


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    term     = sys.argv[1]
    term_dir = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term

    if not term_dir.is_dir():
        print(f'Error: directory not found: {term_dir}')
        sys.exit(1)

    files_updated       = 0
    transcripts_updated = 0

    for case_dir in sorted(d for d in term_dir.iterdir() if d.is_dir()):
        files_json = case_dir / 'files.json'
        if files_json.exists():
            if fix_files_json(files_json):
                print(f'  [files]      {files_json.relative_to(REPO_ROOT)}')
                files_updated += 1

        for transcript in sorted(case_dir.glob('*.json')):
            if DATE_JSON_RE.match(transcript.name):
                if fix_transcript_json(transcript):
                    print(f'  [transcript] {transcript.relative_to(REPO_ROOT)}')
                    transcripts_updated += 1

    print(
        f'\nDone — {files_updated} files.json file(s) updated, '
        f'{transcripts_updated} transcript file(s) updated.'
    )


if __name__ == '__main__':
    main()
