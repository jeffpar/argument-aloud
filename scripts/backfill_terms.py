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
import re
import sys
from pathlib import Path

import yaml

SOURCE_DIR = Path.home() / 'Sites' / 'loners' / 'lonedissent' / '_pages' / 'cases' / 'all'
REPO_ROOT   = Path(__file__).resolve().parent.parent
TERMS_DIR   = REPO_ROOT / 'courts' / 'ussc' / 'terms'

TERM_MIN    = '1791-08'
TERM_MAX    = '1954-10'
TERM_MERGE_MAX = '2017-10'  # merge-only range: 1955-10 through 2017-10

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


def normalize_docket(raw: str) -> str:
    """Normalize docket strings: 'N Misc.' → 'N-Misc', 'N Orig.' → 'N-Orig', etc."""
    parts = raw.split(',')
    normalized = []
    for part in parts:
        part = part.strip()
        # "N Misc." / "N Orig." → "N-Misc" / "N-Orig"
        part = re.sub(r'^(\S+)\s+(Misc|Orig)\.$', r'\1-\2', part)
        # Standalone "Misc." / "Orig." → "Misc" / "Orig"
        part = re.sub(r'^(Misc|Orig)\.$', r'\1', part)
        normalized.append(part)
    return ','.join(normalized)


def build_case_obj(src: dict) -> dict:
    """Convert a source case dict to the target cases.json format."""
    obj: dict = {}

    obj['id'] = src['id']
    obj['title'] = html.unescape(src['title'])

    if 'docket' in src and src['docket'] is not None:
        obj['number'] = normalize_docket(str(src['docket']))

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


def build_merge_fields(src: dict) -> dict:
    """Build the fields to merge into an existing case object (merge-only mode).

    Includes all passthrough fields plus id, and opinion_href only when
    pdfSource is 'loc'. Title is intentionally excluded — the existing title
    is preserved.
    """
    obj: dict = {}

    obj['id'] = src['id']

    if 'docket' in src and src['docket'] is not None:
        obj['number'] = normalize_docket(str(src['docket']))

    for field in PASSTHROUGH_FIELDS:
        if field in src and src[field] is not None:
            obj[field] = src[field]

    if src.get('pdfSource') == 'loc':
        vol  = str(src.get('volume', '')).zfill(3)
        page = str(src.get('page',   ''))
        if vol and page:
            obj['opinion_href'] = LOC_BASE.format(vol=vol, page=page)

    return obj


def process_term_file(md_path: Path, dry_run: bool) -> None:
    term = md_path.stem  # e.g. "1948-10"
    if not (TERM_MIN <= term <= TERM_MERGE_MAX):
        return

    dest_dir  = TERMS_DIR / term
    dest_file = dest_dir / 'cases.json'

    fm = parse_front_matter(md_path)
    src_cases = fm.get('cases') or []
    if not src_cases:
        print(f'{term}: no cases in front matter — skipped')
        return

    # ── Create mode: terms up to TERM_MAX ────────────────────────────────────
    if term <= TERM_MAX:
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
        return

    # ── Merge mode: terms 1955-10 through TERM_MERGE_MAX ─────────────────────
    if not dest_file.exists():
        print(f'{term}: no existing cases.json — skipped (merge-only mode)')
        return

    existing = json.loads(dest_file.read_text(encoding='utf-8'))

    # Index existing cases by their (normalised) docket number.
    dest_by_number = {}
    for c in existing:
        num = c.get('number')
        if num is not None:
            dest_by_number[num] = c

    # Build a lookup of source dockets → source case.
    src_by_number = {}
    for src in src_cases:
        raw = src.get('docket')
        if raw is not None:
            src_by_number[normalize_docket(str(raw))] = src

    merged_count = 0
    for src in src_cases:
        raw = src.get('docket')
        norm = normalize_docket(str(raw)) if raw is not None else None
        dest_case = dest_by_number.get(norm) if norm else None

        if dest_case is None:
            print(f'  {term}: NOT FOUND — {src.get("title", "?")!r}  (No. {norm or "?"})')
            continue

        fields = build_merge_fields(src)
        # Determine which fields actually changed.
        new_fields = {k: v for k, v in fields.items() if dest_case.get(k) != v}
        if not new_fields:
            continue

        # Rebuild the case dict so new keys are inserted before 'audio' (if present).
        updated = {}
        inserted = False
        for k, v in dest_case.items():
            if not inserted and k == 'audio':
                for nk, nv in new_fields.items():
                    if nk not in dest_case:
                        updated[nk] = nv
                inserted = True
            updated[k] = new_fields.get(k, v)  # overwrite if changed
        if not inserted:
            # No 'audio' key — append new keys at end
            for nk, nv in new_fields.items():
                if nk not in dest_case:
                    updated[nk] = nv
        dest_case.clear()
        dest_case.update(updated)
        merged_count += 1

    if merged_count == 0:
        print(f'{term}: up to date ({len(existing)} cases)')
        return

    print(f'{term}: {"would update" if dry_run else "updating"} {merged_count} case(s)')
    if not dry_run:
        dest_file.write_text(
            json.dumps(existing, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )


def main() -> None:
    dry_run = '--dry-run' in sys.argv
    if dry_run:
        print('[DRY RUN — no files will be written]')

    md_files = sorted(SOURCE_DIR.glob('*.md'))
    if not md_files:
        sys.exit(f'Error: no .md files found in {SOURCE_DIR}')

    in_scope = [f for f in md_files if TERM_MIN <= f.stem <= TERM_MERGE_MAX]
    print(f'Processing {len(in_scope)} term file(s) in range {TERM_MIN} – {TERM_MERGE_MAX}\n')

    for md_path in in_scope:
        process_term_file(md_path, dry_run)


if __name__ == '__main__':
    main()
