#!/usr/bin/env python3
"""Backfill courts/ussc/terms/ from lonedissent case .md files.

For each .md file in the source directory whose term falls within
1791-08 through 1954-10 (inclusive), create:

    courts/ussc/terms/<term>/cases.json

Each case object contains:
  id             — from id
  title          — from title
  number         — from docket (omitted if absent)
  volume         — as-is
  page           — as-is
  usCite         — as-is
  dateDecision   — as-is
  voteMajority   — as-is
  voteMinority   — as-is
  votes          — as-is
  opinion_href   — derived LOC tile URL (tile.loc.gov)

Usage:
    python3 scripts/backfill_terms.py [--dry-run]
"""

import html
import json
import sys
from pathlib import Path

import yaml

SOURCE_DIR = Path.home() / 'Sites' / 'loners' / 'lonedissent' / '_pages' / 'cases' / 'all'
REPO_ROOT   = Path(__file__).resolve().parent.parent
TERMS_DIR   = REPO_ROOT / 'courts' / 'ussc' / 'terms'

TERM_MIN = '1791-08'
TERM_MAX = '1954-10'

LOC_BASE = 'https://tile.loc.gov/storage-services/service/ll/usrep/usrep{vol}/usrep{vol}{page}/usrep{vol}{page}.pdf'

# Fields carried over unchanged from the source case object.
PASSTHROUGH_FIELDS = [
    'volume', 'page', 'usCite', 'dateDecision',
    'voteMajority', 'voteMinority', 'votes',
]


def parse_front_matter(md_path: Path) -> dict:
    """Extract and parse the YAML front matter from a Jekyll .md file."""
    text = md_path.read_text(encoding='utf-8')
    if not text.startswith('---'):
        return {}
    # Find the closing ---
    end = text.find('\n---', 3)
    if end == -1:
        return {}
    fm_text = text[3:end]
    return yaml.safe_load(fm_text) or {}


def build_case_obj(src: dict) -> dict:
    """Convert a source case dict to the target cases.json format."""
    obj: dict = {}

    obj['id'] = src['id']
    obj['title'] = html.unescape(src['title'])

    if 'docket' in src and src['docket'] is not None:
        obj['number'] = str(src['docket'])

    for field in PASSTHROUGH_FIELDS:
        if field in src and src[field] is not None:
            obj[field] = src[field]

    # Build opinion_href from volume + page (both must be present).
    # volume is zero-padded to 3 digits; page is used as-is (no padding).
    vol  = str(src.get('volume', '')).zfill(3)
    page = str(src.get('page',   ''))
    if vol and page:
        obj['opinion_href'] = LOC_BASE.format(vol=vol, page=page)

    return obj


def process_term_file(md_path: Path, dry_run: bool) -> None:
    term = md_path.stem  # e.g. "1948-10"
    if not (TERM_MIN <= term <= TERM_MAX):
        return

    dest_dir  = TERMS_DIR / term
    dest_file = dest_dir / 'cases.json'

    fm = parse_front_matter(md_path)
    src_cases = fm.get('cases') or []
    if not src_cases:
        print(f'{term}: no cases in front matter — skipped')
        return

    cases = [build_case_obj(c) for c in src_cases]

    if dest_file.exists():
        existing = json.loads(dest_file.read_text(encoding='utf-8'))
        if existing == cases:
            print(f'{term}: up to date ({len(cases)} cases)')
            return
        print(f'{term}: {"would update" if dry_run else "updating"} ({len(cases)} cases)')
    else:
        print(f'{term}: {"would create" if dry_run else "creating"} ({len(cases)} cases)')

    if not dry_run:
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_file.write_text(
            json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )


def main() -> None:
    dry_run = '--dry-run' in sys.argv
    if dry_run:
        print('[DRY RUN — no files will be written]')

    md_files = sorted(SOURCE_DIR.glob('*.md'))
    if not md_files:
        sys.exit(f'Error: no .md files found in {SOURCE_DIR}')

    in_scope = [f for f in md_files if TERM_MIN <= f.stem <= TERM_MAX]
    print(f'Processing {len(in_scope)} term file(s) in range {TERM_MIN} – {TERM_MAX}\n')

    for md_path in in_scope:
        process_term_file(md_path, dry_run)


if __name__ == '__main__':
    main()
