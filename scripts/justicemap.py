#!/usr/bin/env python3
"""Fix transcripts for justices who argued before the Court before being appointed.

Reads scripts/justicemap.md, extracts each justice's name and their oyez.org
case URLs, then for each case finds transcript JSON files and:
  - Replaces the justice's formal name (e.g. "JUSTICE KAGAN") with their full
    name (e.g. "ELENA KAGAN")
  - Changes the speaker's role from "justice" to "advocate"

Warnings are printed when:
  1. No transcript folder or files exist for a case.
  2. Transcripts were found but the justice's name was already corrected.
  3. Transcripts were found but the justice's formal name did not appear in any.

Usage:
    python3 scripts/justicemap.py [--dry-run]
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT  = Path(__file__).resolve().parent.parent
TERMS_DIR  = REPO_ROOT / 'courts' / 'ussc' / 'terms'
JUSTICEMAP = Path(__file__).resolve().parent / 'justicemap.md'

_HEADING_RE   = re.compile(r'^## ((?:CHIEF )?JUSTICE .+)$')
_OYEZ_URL_RE  = re.compile(r'https://www\.oyez\.org/cases/(\d{4})/([^\s\)]+)')
_SUFFIX_RE    = re.compile(r',?\s+(?:JR|SR|II|III|IV)\.?$', re.IGNORECASE)
_DATE_JSON_RE = re.compile(r'^\d{4}-\d{2}-\d{2}.*\.json$')


def _parse_heading(heading: str) -> tuple[str, str, str]:
    """Parse a ## heading like 'CHIEF JUSTICE WILLIAM H. REHNQUIST'.

    Returns (prefix, full_name, formal_name):
      prefix      = 'CHIEF JUSTICE' or 'JUSTICE'
      full_name   = 'WILLIAM H. REHNQUIST'   (name to replace with)
      formal_name = 'CHIEF JUSTICE REHNQUIST' (name as it appears in transcripts)
    """
    if heading.startswith('CHIEF JUSTICE '):
        prefix    = 'CHIEF JUSTICE'
        full_name = heading[len('CHIEF JUSTICE '):]
    else:
        prefix    = 'JUSTICE'
        full_name = heading[len('JUSTICE '):]
    full_name = full_name.strip()

    # Strip generational suffixes before extracting the last name
    last_name = _SUFFIX_RE.sub('', full_name).strip().split()[-1]
    formal_name = f'{prefix} {last_name}'
    return prefix, full_name, formal_name


def load_justicemap() -> list[tuple[str, str, str, list[tuple[str, str]]]]:
    """Parse justicemap.md.

    Returns a list of (prefix, full_name, formal_name, cases) where cases is
    a list of (term, case_number) pairs derived from oyez.org URLs.  Only
    URLs with a plain 4-digit year are included (multi-year spans like
    '1940-1955' are skipped).
    """
    text    = JUSTICEMAP.read_text(encoding='utf-8')
    results = []

    current_heading:  str | None       = None
    in_cases_argued:  bool             = False
    current_cases:    list[tuple[str, str]] = []

    for line in text.splitlines():
        h_match = _HEADING_RE.match(line)
        if h_match:
            if current_heading is not None:
                results.append((*_parse_heading(current_heading), current_cases))
            current_heading = h_match.group(1).strip()
            in_cases_argued = False
            current_cases   = []
        elif line.strip() == '### Cases Argued':
            in_cases_argued = True
        elif in_cases_argued:
            for m in _OYEZ_URL_RE.finditer(line):
                year, case = m.group(1), m.group(2)
                # Normalise "N_misc" → "N-Misc" to match folder convention.
                case = re.sub(r'_([a-z])', lambda mm: '-' + mm.group(1).upper(), case)
                current_cases.append((f'{year}-10', case))

    if current_heading is not None:
        results.append((*_parse_heading(current_heading), current_cases))

    return results


def _names_in_transcript(data: dict) -> set[str]:
    names: set[str] = set()
    for sp in (data.get('media') or {}).get('speakers') or []:
        names.add(sp.get('name', ''))
    for turn in data.get('turns') or []:
        names.add(turn.get('name', ''))
    return names


def _apply_fix(data: dict, formal_name: str, full_name: str) -> bool:
    """Update speakers + turns in-place. Returns True if any change was made."""
    modified = False
    for sp in (data.get('media') or {}).get('speakers') or []:
        if sp.get('name') == formal_name:
            sp['name'] = full_name
            sp['role'] = 'advocate'
            modified   = True
    for turn in data.get('turns') or []:
        if turn.get('name') == formal_name:
            turn['name'] = full_name
            modified      = True
    return modified


def process_justice(
    prefix: str,
    full_name:   str,
    formal_name: str,
    cases:       list[tuple[str, str]],
    dry_run:     bool,
) -> None:
    print(f'\n{prefix} {full_name}')
    if not cases:
        print('  No Oyez cases to process.')
        return

    for term, case_number in cases:
        case_dir = TERMS_DIR / term / 'cases' / case_number
        label    = f'  {term}/{case_number}:'

        if not case_dir.is_dir():
            print(f'{label} WARNING: no transcript folder at '
                  f'courts/ussc/terms/{term}/cases/{case_number}/')
            continue

        transcripts = sorted(
            f for f in case_dir.iterdir()
            if f.is_file() and _DATE_JSON_RE.match(f.name)
        )
        if not transcripts:
            print(f'{label} WARNING: folder exists but contains no transcript files')
            continue

        # Categorise each transcript file before deciding what to do.
        needs_fix:        list[tuple[Path, dict]] = []
        already_corrected: list[Path]              = []
        name_missing:      list[Path]              = []

        for t in transcripts:
            try:
                data = json.loads(t.read_text(encoding='utf-8'))
            except Exception as exc:
                print(f'{label} ERROR reading {t.name}: {exc}')
                continue
            if not isinstance(data, dict):
                continue

            found = _names_in_transcript(data)
            if formal_name in found:
                needs_fix.append((t, data))
            elif full_name in found:
                already_corrected.append(t)
            else:
                name_missing.append(t)

        if needs_fix:
            fixed_names = []
            for t, data in needs_fix:
                changed = _apply_fix(data, formal_name, full_name)
                if changed and not dry_run:
                    t.write_text(
                        json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                        encoding='utf-8',
                    )
                fixed_names.append(t.name)
            verb = 'would fix' if dry_run else 'fixed'
            print(f'{label} {verb}: {", ".join(fixed_names)}')
        else:
            if already_corrected:
                files = ', '.join(f.name for f in already_corrected)
                print(f'{label} WARNING: already corrected ({full_name!r} found in {files})')
            else:
                files = ', '.join(f.name for f in name_missing) or '(none)'
                print(f'{label} WARNING: {formal_name!r} not found in any transcript '
                      f'({files})')


def main() -> None:
    dry_run = '--dry-run' in sys.argv
    if dry_run:
        print('[DRY RUN — no files will be modified]')

    justices = load_justicemap()
    for prefix, full_name, formal_name, cases in justices:
        process_justice(prefix, full_name, formal_name, cases, dry_run)


if __name__ == '__main__':
    main()
