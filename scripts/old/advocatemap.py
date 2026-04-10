#!/usr/bin/env python3
"""Build courts/ussc/collections/2.json from advocate markdown files.

Usage:
    python3 scripts/advocatemap.py

Reads all .md files (except README.md) from:
    ../loners/lonedissent/_pages/advocates/top100/

Writes:
    courts/ussc/collections/2.json
"""

import html
import json
import re
import sys
from datetime import datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit('Error: PyYAML is required. Install with: pip install pyyaml')

REPO_ROOT   = Path(__file__).resolve().parent.parent.parent
TERMS_DIR   = REPO_ROOT / 'courts' / 'ussc' / 'terms'
SOURCE_DIR  = REPO_ROOT.parent / 'loners' / 'lonedissent' / '_pages' / 'advocates' / 'top100'
OUTPUT_FILE = REPO_ROOT / 'courts' / 'ussc' / 'collections' / '2.json'

_YEAR_RE = re.compile(r'\b(\d{4})\s*$')

# ── Cases.json index ──────────────────────────────────────────────────────────

def build_cases_index() -> dict[tuple[str, str], dict]:
    """Return {(term, number): case_obj} from all local cases.json files."""
    index: dict[tuple[str, str], dict] = {}
    for cases_file in sorted(TERMS_DIR.glob('*/cases.json')):
        term = cases_file.parent.name
        try:
            cases = json.loads(cases_file.read_text(encoding='utf-8'))
        except Exception:
            continue
        for c in cases:
            raw = str(c.get('number') or '').strip()
            if not raw:
                continue
            # Index by first component of consolidated numbers.
            number = raw.split(',')[0].strip()
            index[(term, number)] = c
    return index

# ── Docket normalization ──────────────────────────────────────────────────────

def normalize_first_docket(raw: str) -> str:
    """Return the normalized first docket from a (possibly comma-separated) string.

    "80-6680"       → "80-6680"
    "05-5224,05-5705" → "05-5224"
    "132 Orig."     → "132-Orig"
    "2 Misc."       → "2-Misc"
    "1 Misc.,1"     → "1-Misc"   (first token before comma)
    """
    raw = raw.strip()

    # Split on comma; take first token.
    first = raw.split(',')[0].strip()

    # Normalize "N Orig." → "N-Orig" and "N Misc." → "N-Misc"
    m = re.match(r'^(\d+)\s+(Orig|Misc)\.?$', first, re.IGNORECASE)
    if m:
        return '{}-{}'.format(m.group(1), m.group(2).capitalize())

    return first


# ── Front matter parsing ──────────────────────────────────────────────────────

def parse_front_matter(path: Path) -> dict:
    """Extract and parse the YAML front matter from a Jekyll markdown file."""
    text = path.read_text(encoding='utf-8')
    if not text.startswith('---'):
        return {}
    end = text.index('---', 3)
    return yaml.safe_load(text[3:end]) or {}


# ── Year extraction ───────────────────────────────────────────────────────────

def year_from_date(date_str: str) -> str | None:
    """Extract the 4-digit year from a dateDecision string like 'Tuesday, March 23, 1982'."""
    if not date_str:
        return None
    m = _YEAR_RE.search(str(date_str))
    return m.group(1) if m else None


def date_arg_to_iso(date_str: str) -> str | None:
    """Convert 'Tuesday, March 9, 1965' → '1965-03-09', or return None on failure."""
    if not date_str:
        return None
    # Strip leading weekday if present (e.g. 'Tuesday, March 9, 1965')
    s = re.sub(r'^\w+,\s*', '', date_str.strip())
    for fmt in ('%B %d, %Y', '%b %d, %Y'):
        try:
            return datetime.strptime(s, fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return None


def audio_index_for_date(audio_list: list, iso_date: str | None) -> int:
    """Return 1-based index of the audio entry whose date matches iso_date.

    The list is sorted by date ascending before indexing (matching how the
    player resolves sortedAudio). Returns 1 if no match or no date given.
    """
    if not audio_list:
        return 1
    sorted_audio = sorted(audio_list, key=lambda a: (a.get('date') or ''))
    if iso_date:
        for i, entry in enumerate(sorted_audio):
            if entry.get('date') == iso_date:
                return i + 1
    return 1


def audio_date_for_index(audio_list: list, idx: int) -> str | None:
    """Return the date of the audio entry at 1-based idx in date-sorted order."""
    if not audio_list or idx < 1:
        return None
    sorted_audio = sorted(audio_list, key=lambda a: (a.get('date') or ''))
    if idx <= len(sorted_audio):
        return sorted_audio[idx - 1].get('date') or None
    return None


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if not SOURCE_DIR.is_dir():
        sys.exit('Error: source directory not found:\n  {}'.format(SOURCE_DIR))

    md_files = sorted(
        p for p in SOURCE_DIR.glob('*.md')
        if p.name != 'README.md'
    )

    cases_index = build_cases_index()

    groups = []
    for path in md_files:
        fm = parse_front_matter(path)
        raw_title = html.unescape((fm.get('title') or '').strip())

        # Extract advocate name: "Cases Argued by <Name>"
        prefix = 'Cases Argued by '
        if raw_title.startswith(prefix):
            advocate_name = raw_title[len(prefix):]
        else:
            advocate_name = raw_title  # fallback

        source_cases = fm.get('cases') or []
        cases = []
        for sc in source_cases:
            title = html.unescape((sc.get('title') or '').strip())

            term   = sc.get('termId') or ''
            docket = sc.get('docket') or ''
            number = normalize_first_docket(docket) if docket else ''

            # Verify case exists in cases.json.
            if term and number and (term, number) not in cases_index:
                print('  WARNING: case not found in cases.json: {}/{}'.format(term, number))

            # Build case object in output field order.
            case_obj: dict = {'title': title, 'term': term}
            if number:
                case_obj['number'] = number

            # Decision date from source dateDecision.
            iso_decision = date_arg_to_iso(sc.get('dateDecision', ''))
            # Verify: the year previously appended to titles must match the
            # YYYY portion of the decision date (both derived from dateDecision).
            year = year_from_date(sc.get('dateDecision', ''))
            if year and iso_decision and year != iso_decision[:4]:
                print('  WARNING: year mismatch for {}/{}: year_from_date={} iso_decision={}'.format(
                    term, number, year, iso_decision))

            # Audio from live cases.json.
            live = cases_index.get((term, number)) if term and number else None
            audio_idx: int | None = None
            audio_date: str | None = None
            if live:
                live_audio = live.get('audio')
                if live_audio:
                    iso_date = date_arg_to_iso(sc.get('dateArgument', ''))
                    audio_idx = audio_index_for_date(live_audio, iso_date)
                    audio_date = audio_date_for_index(live_audio, audio_idx)
                if not audio_date:
                    audio_date = live.get('argument') or None

            if audio_date:
                case_obj['argument'] = audio_date
            if iso_decision:
                case_obj['decision'] = iso_decision
            if audio_idx is not None:
                case_obj['audio'] = audio_idx

            cases.append(case_obj)

        groups.append({'name': advocate_name, 'cases': cases})

    # Sort groups by number of cases descending (most argued first), then name.
    groups.sort(key=lambda g: (-len(g['cases']), g['name']))

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(groups, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )
    print('Wrote {} groups to {}'.format(len(groups), OUTPUT_FILE))


if __name__ == '__main__':
    main()
