#!/usr/bin/env python3
"""Normalize justice names across all cases.json votes and transcript files.

1. votes in cases.json  — upper-case each name, verify it exists in justices.json.
2. transcript speakers/turns — for names with title JUSTICE/CHIEF JUSTICE that are
   not a justices.json key, search all alternates arrays for a match; if found,
   replace with the canonical key.

Usage:
    python3 scripts/old/fix_justices.py [--dry-run]
"""

import json
import sys
from pathlib import Path

REPO_ROOT   = Path(__file__).resolve().parent.parent.parent
JUSTICES_PATH = REPO_ROOT / 'scripts' / 'justices.json'

# ── Load justices.json ──────────────────────────────────────────────────────

def load_justices() -> tuple[set[str], dict[str, str]]:
    """Return (keys_set, alternates_map).

    alternates_map maps every alternate name → canonical key.
    """
    data = json.loads(JUSTICES_PATH.read_text(encoding='utf-8'))
    keys = set(data.keys())
    alt_map: dict[str, str] = {}
    for canonical, obj in data.items():
        for alt in obj.get('alternates') or []:
            alt_map[alt.upper()] = canonical
    return keys, alt_map


# ── Vote normalisation ──────────────────────────────────────────────────────

def fix_votes(cases: list, justices_keys: set[str], alt_map: dict[str, str],
              path_label: str) -> int:
    """Upper-case and canonicalise justice names in votes. Returns change count."""
    changes = 0
    for case in cases:
        for vote in case.get('votes') or []:
            raw = vote.get('name', '')
            if not raw:
                continue
            upper = raw.upper()
            # Resolve via alt_map to canonical key (handles e.g. "JOHN M. HARLAN II" → "JOHN M. HARLAN, II")
            canonical = alt_map.get(upper, upper if upper in justices_keys else None)
            if canonical is None:
                if upper not in justices_keys and upper not in alt_map:
                    print(f'  WARN  votes unknown: {raw!r} in {path_label} {case.get("number","?")}')
                canonical = upper
            if raw == canonical:
                continue
            vote['name'] = canonical
            changes += 1
    return changes


# ── Transcript normalisation ────────────────────────────────────────────────

JUSTICE_TITLES = {'JUSTICE', 'CHIEF JUSTICE'}


def _resolve(name: str, justices_keys: set[str], alt_map: dict[str, str]) -> str | None:
    """Return the canonical justices.json key for *name*, or None if not a justice."""
    if name in justices_keys:
        return name
    return alt_map.get(name)


def fix_transcript(path: Path, justices_keys: set[str], alt_map: dict[str, str],
                   dry_run: bool) -> int:
    """Normalise justice names in a transcript envelope. Returns change count."""
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:
        print(f'  ERROR reading {path}: {exc}')
        return 0

    if not isinstance(data, dict):
        return 0

    changes = 0

    # ── speakers list ──────────────────────────────────────────────────────
    for sp in (data.get('media') or {}).get('speakers') or []:
        if sp.get('title') not in JUSTICE_TITLES:
            continue
        name = sp.get('name', '')
        canonical = _resolve(name, justices_keys, alt_map)
        if canonical is None:
            print(f'  WARN  transcript unknown justice: {name!r} in {path}')
            continue
        if name != canonical:
            print(f'  FIX   {name!r} -> {canonical!r}  ({path.name})')
            sp['name'] = canonical
            changes += 1

    # Build a name→canonical map for turn-level substitution based on what
    # we just resolved in the speakers list (avoids re-checking every turn
    # against the full alternates map for non-justice speakers).
    justice_rename: dict[str, str] = {}
    for sp in (data.get('media') or {}).get('speakers') or []:
        if sp.get('title') in JUSTICE_TITLES:
            canonical = _resolve(sp.get('name', ''), justices_keys, alt_map)
            if canonical:
                justice_rename[sp['name']] = canonical

    # ── turns ──────────────────────────────────────────────────────────────
    for turn in data.get('turns') or []:
        name = turn.get('name', '')
        new_name = justice_rename.get(name)
        if new_name is None:
            # Check directly — handles turns where the speaker wasn't in speakers list
            new_name = _resolve(name, justices_keys, alt_map)
            if new_name and new_name != name:
                # Only rename if definitely a justice (i.e. resolves via alt_map or is a key)
                justice_rename[name] = new_name
        if new_name and new_name != name:
            turn['name'] = new_name
            changes += 1

    if changes and not dry_run:
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

    return changes


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    dry_run = '--dry-run' in sys.argv

    if dry_run:
        print('DRY RUN — no files will be written\n')

    justices_keys, alt_map = load_justices()
    print(f'Loaded justices.json: {len(justices_keys)} canonical names, '
          f'{len(alt_map)} alternates\n')

    total_vote_changes = 0
    total_transcript_changes = 0
    total_transcript_files = 0

    for cases_path in sorted(Path(REPO_ROOT / 'courts' / 'ussc' / 'terms').glob('*/cases.json')):
        term = cases_path.parent.name
        cases = json.loads(cases_path.read_text(encoding='utf-8'))
        if not isinstance(cases, list):
            continue

        # Fix votes
        vote_changes = fix_votes(cases, justices_keys, alt_map, term)
        if vote_changes:
            total_vote_changes += vote_changes
            print(f'  {term}: {vote_changes} vote name(s) upper-cased')
            if not dry_run:
                cases_path.write_text(
                    json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
                    encoding='utf-8',
                )

        # Fix transcripts in this term's cases/ directory
        cases_dir = cases_path.parent / 'cases'
        if not cases_dir.is_dir():
            continue
        for transcript_path in sorted(cases_dir.glob('*/*.json')):
            n = fix_transcript(transcript_path, justices_keys, alt_map, dry_run)
            if n:
                total_transcript_changes += n
                total_transcript_files += 1

    print()
    print(f'Vote changes:       {total_vote_changes}')
    print(f'Transcript changes: {total_transcript_changes} across {total_transcript_files} file(s)')
    if dry_run:
        print('(dry run — nothing written)')


if __name__ == '__main__':
    main()
