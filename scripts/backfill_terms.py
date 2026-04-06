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
    python3 scripts/backfill_terms.py --audit [--dry-run]

--audit mode:
  Cross-references every backfilled case (identified by having both 'volume'
  and 'page' fields) against ../loners/lonedissent/sources/ld/citations.csv.
  - Not in CSV, no 'audio', all-caps title: entire case object removed.
  - Otherwise:                              left unchanged.
"""

import csv
import datetime
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

CITATIONS_CSV = REPO_ROOT.parent / 'loners' / 'lonedissent' / 'sources' / 'ld' / 'citations.csv'
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


_MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
]
_DATE_DEC_RE = re.compile(
    r'^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+'
    r'(January|February|March|April|May|June|July|August|September|'
    r'October|November|December)\s+(\d{1,2}),\s+(\d{4})$'
)


def _date_decision_to_iso(date_decision: str) -> str | None:
    """Convert 'Monday, January 5, 1926' → '1926-01-05', or None."""
    m = _DATE_DEC_RE.match(date_decision.strip())
    if not m:
        return None
    month_name, day, year = m.group(1), int(m.group(2)), int(m.group(3))
    try:
        month = _MONTHS.index(month_name) + 1
        return datetime.date(year, month, day).strftime('%Y-%m-%d')
    except (ValueError, IndexError):
        return None


def _prev_terms(term: str, n: int = 2) -> list[str]:
    """Return up to n preceding term strings (same month, earlier year)."""
    year, month = term.split('-')
    return [f'{int(year) - i}-{month}' for i in range(1, n + 1)]


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

    # Load cases.json for this term and up to 2 preceding terms.
    # The dicts inside loaded[path] are the live objects we mutate in-place.
    terms_to_search = [term] + _prev_terms(term)
    loaded: dict[Path, list] = {}
    for t in terms_to_search:
        tf = TERMS_DIR / t / 'cases.json'
        if tf.exists():
            loaded[tf] = json.loads(tf.read_text(encoding='utf-8'))

    # Build cross-term index: individual number part → (path, case_dict).
    # Consolidated numbers like '1,2,4' are indexed by each comma-separated
    # part so that an incoming '1,2,4,10' can match on any single component.
    cross_idx: dict[str, tuple[Path, dict]] = {}
    for tf, cases_list in loaded.items():
        for c in cases_list:
            raw_num = c.get('number', '')
            if raw_num:
                for part in str(raw_num).split(','):
                    part = part.strip()
                    if part and part not in cross_idx:
                        cross_idx[part] = (tf, c)

    merged_count = 0
    modified_paths: set[Path] = set()

    for src in src_cases:
        raw = src.get('docket')
        norm = normalize_docket(str(raw)) if raw is not None else None
        docket_parts = [p.strip() for p in norm.split(',')] if norm else []

        # Convert incoming dateDecision to ISO for comparison with 'decision'.
        incoming_date_str = src.get('dateDecision') or ''
        incoming_iso = _date_decision_to_iso(incoming_date_str) if incoming_date_str else None

        # Find the first docket part that matches an existing case.
        # Where both sides have a date, require them to agree.
        dest_path: Path | None = None
        dest_case: dict | None = None
        for part in docket_parts:
            if part not in cross_idx:
                continue
            cpath, ccase = cross_idx[part]
            existing_decision = ccase.get('decision')
            if (incoming_iso is None or existing_decision is None
                    or existing_decision == incoming_iso):
                dest_path, dest_case = cpath, ccase
                break

        if dest_case is None:
            print(f'  {term}: NOT FOUND — {src.get("title", "?")!r}  (No. {norm or "?"})')
            continue

        fields = build_merge_fields(src)
        new_fields = {k: v for k, v in fields.items() if dest_case.get(k) != v}
        if not new_fields:
            continue

        # Rebuild the case dict so new keys are inserted before 'audio' (if present).
        # dest_case is the live dict object inside loaded[dest_path], so mutating it
        # directly updates the list that will be written back to disk.
        updated: dict = {}
        inserted = False
        for k, v in dest_case.items():
            if not inserted and k == 'audio':
                for nk, nv in new_fields.items():
                    if nk not in dest_case:
                        updated[nk] = nv
                inserted = True
            updated[k] = new_fields.get(k, v)  # overwrite if changed
        if not inserted:
            for nk, nv in new_fields.items():
                if nk not in dest_case:
                    updated[nk] = nv
        dest_case.clear()
        dest_case.update(updated)
        modified_paths.add(dest_path)
        merged_count += 1

    if merged_count == 0:
        total = sum(len(v) for v in loaded.values())
        print(f'{term}: up to date ({total} cases across {len(loaded)} file(s))')
        return

    files_label = f'{len(modified_paths)} file(s)'
    print(f'{term}: {"would update" if dry_run else "updating"} {merged_count} case(s) across {files_label}')
    if not dry_run:
        for p in modified_paths:
            p.write_text(
                json.dumps(loaded[p], indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )


def load_citations() -> set[tuple[int, int]]:
    """Load citations.csv → set of (volume, page) keys."""
    if not CITATIONS_CSV.exists():
        sys.exit(f'Error: citations.csv not found at {CITATIONS_CSV}')
    result: set[tuple[int, int]] = set()
    with open(CITATIONS_CSV, newline='', encoding='utf-8') as f:
        for row in csv.DictReader(f):
            try:
                result.add((int(row['volume']), int(row['page'])))
            except (ValueError, KeyError):
                continue
    return result


def _title_is_allcaps(title: str) -> bool:
    """Return True if the title contains no lowercase letters other than allowed
    abbreviation words: 'v.' (case separator), 'et', 'al.', 'ex', 'rel.'
    e.g. 'FOO v. BAR' → True, 'FOO et al. v. BAR' → True, 'Foo v. Bar' → False.
    """
    # Strip allowed lowercase words, then check for any remaining lowercase.
    stripped = re.sub(r'\b(?:v\.|et|al\.?|ex|rel\.)\s*', '', title)
    return stripped == stripped.upper()


def audit_term(cases_path: Path, citations: set[tuple[int, int]], dry_run: bool) -> None:
    """Audit one cases.json against citations.csv and repair in-place."""
    term = cases_path.parent.name
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    new_data: list[dict] = []
    modified = False

    for case in data:
        volume = case.get('volume')
        page   = case.get('page')

        # Not a backfilled case — leave it alone.
        if volume is None or page is None:
            new_data.append(case)
            continue

        try:
            key = (int(volume), int(page))
        except (ValueError, TypeError):
            new_data.append(case)
            continue

        has_audio   = 'audio' in case
        in_csv      = key in citations

        if not in_csv and not has_audio and _title_is_allcaps(case.get('title', '')):
            # Not in CSV, no audio, and title is all-caps — remove the entire case.
            modified = True
            label = case.get('title', '?')
            print(f'  {term}: {"would remove" if dry_run else "removing"} {label!r} (not in citations.csv)')
            if dry_run:
                new_data.append(case)  # keep in dry-run so the file is not altered
            # else: intentionally not appended
        else:
            new_data.append(case)

    if modified and not dry_run:
        cases_path.write_text(
            json.dumps(new_data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )


def main() -> None:
    dry_run = '--dry-run' in sys.argv
    if dry_run:
        print('[DRY RUN — no files will be written]')

    if '--audit' in sys.argv:
        citations = load_citations()
        print(f'Loaded {len(citations)} citation key(s) from citations.csv\n')
        for term_dir in sorted(TERMS_DIR.iterdir()):
            if not term_dir.is_dir():
                continue
            if not (TERM_MIN <= term_dir.name <= TERM_MERGE_MAX):
                continue
            cases_path = term_dir / 'cases.json'
            if cases_path.exists():
                audit_term(cases_path, citations, dry_run)
        return

    md_files = sorted(SOURCE_DIR.glob('*.md'))
    if not md_files:
        sys.exit(f'Error: no .md files found in {SOURCE_DIR}')

    in_scope = [f for f in md_files if TERM_MIN <= f.stem <= TERM_MERGE_MAX]
    print(f'Processing {len(in_scope)} term file(s) in range {TERM_MIN} – {TERM_MERGE_MAX}\n')

    for md_path in in_scope:
        process_term_file(md_path, dry_run)


if __name__ == '__main__':
    main()
