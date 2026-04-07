#!/usr/bin/env python3
"""Update courts/ussc/terms/ case data from decisions-prev.json.

For each term folder in courts/ussc/terms, finds source cases (from
decisions-prev.json) whose dateDecision falls within that term's date range,
matches them to existing target cases by decision date + docket numbers, and
updates the target cases with verified/corrected fields.

Fields updated when differing:
  id, title (if all-caps + source has caseTitle), number (expanded to full
  source docket list), volume, page, usCite, voteMajority, voteMinority,
  votes (fully rewritten), opinion_href, dateArgument, dateRearg.

Source cases with no matching target case are printed at the end.

Usage:
    python3 scripts/backfill_terms.py [--dry-run] [<term-folder>]

    <term-folder>  Optional: restrict to one term folder (e.g. "1955-10").
    --dry-run      Show what would change without writing any files.
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT   = Path(__file__).resolve().parent.parent
TERMS_DIR   = REPO_ROOT / 'courts' / 'ussc' / 'terms'
SOURCE_FILE = REPO_ROOT.parent / 'loners' / 'lonedissent' / 'sources' / 'ld' / 'archive' / 'decisions-prev.json'
VARS_FILE   = REPO_ROOT.parent / 'loners' / 'lonedissent' / 'sources' / 'scdb' / 'vars.json'

LOC_BASE = (
    'https://tile.loc.gov/storage-services/service/ll/usrep/'
    'usrep{vol}/usrep{vol}{page}/usrep{vol}{page}.pdf'
)


# ── Helpers ──────────────────────────────────────────────────────────────────

def normalize_dockets(raw) -> list:
    """Split and normalize a source docket string → list of our-format strings.

    "5 Orig."     → ["5-Orig"]
    "294 Misc."   → ["294-Misc"]
    "429, 523"    → ["429", "523"]
    ""            → []
    """
    raw = str(raw or '').strip()
    if not raw:
        return []
    result = []
    for part in (p.strip() for p in raw.split(',')):
        m = re.match(r'^(\S+)\s+(Orig|Misc)\.$', part)
        result.append('{}-{}'.format(m.group(1), m.group(2)) if m else part)
    return result


def parse_us_cite(us_cite):
    """Parse "350 U.S. 497" → ("350", "497"), zero-padding both to >= 3 digits."""
    m = re.match(r'^(\d+)\s+U\.S\.\s+(\d+)', us_cite or '')
    if not m:
        return None, None
    vol  = m.group(1).zfill(3)
    page_raw = m.group(2)
    page = page_raw.zfill(3) if len(page_raw) < 3 else page_raw
    return vol, page


def loc_href(vol, page):
    return LOC_BASE.format(vol=vol, page=page)


def title_is_allcaps(title):
    """True when title has no intentional lowercase (ignoring 'v.', 'et', etc.)."""
    stripped = re.sub(r'\b(?:v\.|et|al\.?|ex|rel\.)\s*', '', title or '')
    return bool(stripped) and stripped == stripped.upper()


def build_votes(justices, jname_map, vote_map):
    """Convert source justices array → [{"name": ..., "vote": ...}] list."""
    result = []
    for j in justices:
        code     = j.get('justiceName', '')
        name     = jname_map.get(code, code)
        vote_str = vote_map.get(str(j.get('vote', '')), str(j.get('vote', '')))
        result.append({'name': name, 'vote': vote_str})
    return result


def apply_changes(case, changes):
    """Apply changes dict to a case dict in-place, preserving key order and
    inserting new keys at logical positions (dateArgument/dateRearg before
    'decision'; everything else before 'audio' if 'audio' exists)."""

    # Update in-place for existing keys.
    for k, v in changes.items():
        if k in case:
            case[k] = v

    # For keys that don't exist yet, rebuild with proper ordering.
    new_keys = {k: v for k, v in changes.items() if k not in case}
    if not new_keys:
        return

    BEFORE_DECISION = {'dateArgument', 'dateRearg'}
    BEFORE_AUDIO = {
        'id', 'title', 'number', 'decision', 'volume', 'page', 'usCite',
        'dateDecision', 'voteMajority', 'voteMinority', 'votes',
        'opinion_href', 'dateArgument', 'dateRearg',
    }

    rebuilt = {}
    for k, v in case.items():
        if k == 'decision':
            for field in ('dateArgument', 'dateRearg'):
                if field in new_keys:
                    rebuilt[field] = new_keys.pop(field)
        if k == 'audio':
            for nk in list(new_keys):
                if nk in BEFORE_AUDIO:
                    rebuilt[nk] = new_keys.pop(nk)
        rebuilt[k] = v

    for nk, nv in new_keys.items():
        rebuilt[nk] = nv

    case.clear()
    case.update(rebuilt)


# ── Core processing ───────────────────────────────────────────────────────────

def process_term(term, sorted_terms, source_cases, jname_map, vote_map, dry_run):
    cases_path = TERMS_DIR / term / 'cases.json'
    if not cases_path.exists():
        return

    # Date range: [term, next_term)
    idx = sorted_terms.index(term)
    next_term = sorted_terms[idx + 1] if idx + 1 < len(sorted_terms) else None

    in_range = [
        c for c in source_cases
        if c.get('dateDecision', '') >= term
        and (next_term is None or c.get('dateDecision', '') < next_term)
    ]
    if not in_range:
        return

    target_cases = json.loads(cases_path.read_text(encoding='utf-8'))
    modified = False
    unmatched = []
    printed_term = False

    def term_print(msg):
        nonlocal printed_term
        if not printed_term:
            print('{}:'.format(term))
            printed_term = True
        print('  {}'.format(msg))

    for src in in_range:
        src_dockets = normalize_dockets(src.get('docket') or '')
        src_date    = src.get('dateDecision', '')
        src_caseId  = src.get('caseId', '')

        # ── Find matching target case ────────────────────────────────────────
        # Criteria: (1) decision date matches, (2) target numbers <= source dockets
        # (or date-only match when source has no dockets), (3) if target already
        # has an 'id', it must equal the source's caseId.
        match = None
        for tgt in target_cases:
            if tgt.get('decision', '') != src_date:
                continue
            raw_num = str(tgt.get('number') or '').strip()
            tgt_numbers = [p.strip() for p in raw_num.split(',') if p.strip()] if raw_num else []
            if src_dockets:
                if not tgt_numbers:
                    continue
                if not set(tgt_numbers) <= set(src_dockets):
                    continue
            # If target has an id set, it must agree with source caseId.
            tgt_id = tgt.get('id')
            if tgt_id and src_caseId and tgt_id != src_caseId:
                continue
            match = tgt
            break

        if match is None:
            unmatched.append(src)
            continue

        existing_id = match.get('id')

        # ── Compute desired field values ─────────────────────────────────────
        vol, page = parse_us_cite(src.get('usCite', ''))

        changes = {}

        # id
        if not existing_id and src_caseId:
            changes['id'] = src_caseId

        # title: update if target is all-caps and source has caseTitle
        src_title = (src.get('caseTitle') or '').strip()
        if src_title and title_is_allcaps(match.get('title', '')):
            changes['title'] = src_title

        # number: expand if target number is a strict subset of source dockets
        raw_num = str(match.get('number') or '').strip()
        tgt_numbers = [p.strip() for p in raw_num.split(',') if p.strip()] if raw_num else []
        if src_dockets and set(tgt_numbers) < set(src_dockets):
            changes['number'] = ', '.join(src_dockets)

        # volume / page
        if vol is not None:
            if match.get('volume') != vol:
                changes['volume'] = vol
            if match.get('page') != page:
                changes['page'] = page

        # usCite
        src_usCite = src.get('usCite', '')
        if src_usCite and match.get('usCite') != src_usCite:
            changes['usCite'] = src_usCite

        # voteMajority / voteMinority
        maj = src.get('majVotes')
        if maj is not None and match.get('voteMajority') != maj:
            changes['voteMajority'] = maj
        mn = src.get('minVotes')
        if mn is not None and match.get('voteMinority') != mn:
            changes['voteMinority'] = mn

        # opinion_href
        if vol and page:
            desired_href = loc_href(vol, page)
            if match.get('opinion_href') != desired_href:
                changes['opinion_href'] = desired_href

        # votes: rewrite from source justices
        justices = src.get('justices') or []
        if justices:
            new_votes = build_votes(justices, jname_map, vote_map)
            if match.get('votes') != new_votes:
                changes['votes'] = new_votes

        # dateArgument / dateRearg (only if non-empty in source)
        for field in ('dateArgument', 'dateRearg'):
            val = (src.get(field) or '').strip()
            if val and match.get(field) != val:
                changes[field] = val

        if not changes:
            continue

        title_label = match.get('title', '?')
        if dry_run:
            term_print('WOULD UPDATE {!r} — {}'.format(title_label, ', '.join(changes)))
        else:
            apply_changes(match, changes)
            term_print('UPDATED {!r} — {}'.format(title_label, ', '.join(changes)))
            modified = True

    if modified:
        cases_path.write_text(
            json.dumps(target_cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )

    for src in unmatched:
        title_label = ((src.get('caseTitle') or src.get('caseName') or '?')).strip()
        term_print('UNMATCHED: {!r} ({})'.format(title_label, src.get('dateDecision', '?')))


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    dry_run = '--dry-run' in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    term_filter = args[0] if args else None

    if not SOURCE_FILE.exists():
        sys.exit('Error: source file not found:\n  {}'.format(SOURCE_FILE))
    if not VARS_FILE.exists():
        sys.exit('Error: vars file not found:\n  {}'.format(VARS_FILE))

    print('Loading source data...')
    source_cases = json.loads(SOURCE_FILE.read_text(encoding='utf-8'))
    vars_data    = json.loads(VARS_FILE.read_text(encoding='utf-8'))

    jname_map = vars_data.get('justiceName', {}).get('values', {})  # code -> "John Jay"
    vote_map  = vars_data.get('vote',        {}).get('values', {})  # "1" -> "voted with..."

    sorted_terms = sorted(d.name for d in TERMS_DIR.iterdir() if d.is_dir())

    if term_filter:
        if term_filter not in sorted_terms:
            sys.exit('Error: term folder {!r} not found.'.format(term_filter))
        terms_to_process = [term_filter]
    else:
        terms_to_process = sorted_terms

    if dry_run:
        print('[DRY RUN — no files will be written]\n')

    for term in terms_to_process:
        process_term(term, sorted_terms, source_cases, jname_map, vote_map, dry_run)

    print('\nDone.')


if __name__ == '__main__':
    main()
