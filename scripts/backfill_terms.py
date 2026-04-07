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
from datetime import datetime
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


VOTE_SIMPLIFY = {
    'voted with majority or plurality': 'majority',
    'dissent': 'minority',
}


def build_votes(justices, jname_map, vote_map, justice_order, chief_lastname=''):
    """Convert source justices array → [{"name": ..., "vote": ...}] list,
    sorted with the chief justice first, then remaining by seniority."""
    result = []
    for j in justices:
        if j.get('vote') in (0, 7):
            continue  # 0 = did not participate, 7 = jurisdictional dissent
        code     = j.get('justiceName', '')
        name     = jname_map.get(code, code)
        raw_vote = vote_map.get(str(j.get('vote', '')), str(j.get('vote', '')))
        vote_str = VOTE_SIMPLIFY.get(raw_vote, raw_vote)
        seniority = justice_order.get(code, 9999)
        # Chief justice sorts before all others (seniority key = -1).
        last_name = name.split()[-1] if name else ''
        is_chief = bool(chief_lastname and last_name.lower() == chief_lastname.lower())
        result.append({'name': name, 'vote': vote_str, '_seniority': (-1 if is_chief else seniority)})
    result.sort(key=lambda x: x.pop('_seniority'))
    return result


def apply_changes(case, changes):
    """Apply changes dict to a case dict in-place, preserving key order and
    inserting new keys at logical positions (dateArgument/dateRearg before
    'decision'; everything else before 'audio' if 'audio' exists)."""

    # Update in-place for existing keys.
    for k, v in changes.items():
        if k in case:
            case[k] = v

    # Always ensure 'id' is the first key if it exists.
    if 'id' in case:
        id_val = case.pop('id')
        rebuilt_id = {'id': id_val}
        rebuilt_id.update(case)
        case.clear()
        case.update(rebuilt_id)

    # For keys that don't exist yet, rebuild with proper ordering.
    new_keys = {k: v for k, v in changes.items() if k not in case}
    if not new_keys:
        return

    BEFORE_DECISION = {'argument', 'reargument'}
    BEFORE_AUDIO = {
        'id', 'title', 'number', 'decision', 'volume', 'page', 'usCite',
        'dateDecision', 'voteMajority', 'voteMinority', 'votes',
        'opinion_href', 'argument', 'reargument',
    }

    rebuilt = {}
    # 'id' always goes first.
    if 'id' in new_keys:
        rebuilt['id'] = new_keys.pop('id')
    for k, v in case.items():
        if k == 'decision':
            for field in ('argument', 'reargument'):
                if field in new_keys:
                    rebuilt[field] = new_keys.pop(field)
        if k == 'votes':
            rebuilt[k] = v
            if 'opinion_href' in new_keys:
                rebuilt['opinion_href'] = new_keys.pop('opinion_href')
            continue
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

def process_term(term, sorted_terms, source_cases, jname_map, vote_map, justice_order, dry_run):
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
    matched_indices = set()
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
            matched_indices.add(target_cases.index(tgt))
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
            changes['number'] = ','.join(src_dockets)

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
            new_votes = build_votes(justices, jname_map, vote_map, justice_order,
                                    chief_lastname=src.get('chief', ''))
            expected = (src.get('majVotes') or 0) + (src.get('minVotes') or 0)
            if expected and len(new_votes) != expected:
                term_print('WARN vote count mismatch for {}: got {}, expected {}'.format(
                    match.get('title', '?'), len(new_votes), expected
                ))
            if match.get('votes') != new_votes:
                changes['votes'] = new_votes

        # argument / reargument (only if non-empty in source)
        for src_field, tgt_field in (('dateArgument', 'argument'), ('dateRearg', 'reargument')):
            val = (src.get(src_field) or '').strip()
            if val and match.get(tgt_field) != val:
                changes[tgt_field] = val

        if not changes:
            continue

        title_label = match.get('title', '?')
        _docket  = src.get('docket') or '—'
        _argued  = (src.get('dateArgument') or '').strip() or '—'
        _decided = src.get('dateDecision') or '?'
        _suffix  = '(No. {}, Argued {}, Decided {})'.format(_docket, _argued, _decided)
        if dry_run:
            term_print('UPDATE: {} {}'.format(title_label, _suffix))
        else:
            apply_changes(match, changes)
            term_print('  UPDATED: {} {}'.format(title_label, _suffix))
            modified = True

    added = False
    for src in unmatched:
        title_label = ((src.get('caseTitle') or src.get('caseName') or '?')).strip()
        docket  = src.get('docket') or '—'
        argued  = (src.get('dateArgument') or '').strip()
        decided = src.get('dateDecision') or '?'

        if not argued:
            term_print('UNMATCHED: {} (No. {}, Argued —, Decided {})'.format(
                title_label, docket, decided
            ))
            continue

        # Build a new case object from source data.
        new_case = {}
        if src.get('caseId'):
            new_case['id'] = src['caseId']
        new_case['title'] = title_label
        src_dockets = normalize_dockets(src.get('docket') or '')
        if src_dockets:
            new_case['number'] = ','.join(src_dockets)
        new_case['argument'] = argued
        rearg = (src.get('dateRearg') or '').strip()
        if rearg:
            new_case['reargument'] = rearg
        new_case['decision'] = decided

        vol, page = parse_us_cite(src.get('usCite', ''))
        if vol:
            new_case['volume'] = vol
        if page:
            new_case['page'] = page
        if src.get('usCite'):
            new_case['usCite'] = src['usCite']
        if src.get('dateDecision'):
            try:
                dt = datetime.strptime(src['dateDecision'], '%Y-%m-%d')
                new_case['dateDecision'] = dt.strftime('%A, %B %-d, %Y')
            except ValueError:
                new_case['dateDecision'] = src['dateDecision']
        if src.get('majVotes') is not None:
            new_case['voteMajority'] = src['majVotes']
        if src.get('minVotes') is not None:
            new_case['voteMinority'] = src['minVotes']

        justices = src.get('justices') or []
        if justices:
            new_case['votes'] = build_votes(justices, jname_map, vote_map, justice_order,
                                            chief_lastname=src.get('chief', ''))
        if vol and page:
            new_case['opinion_href'] = loc_href(vol, page)

        term_print('    ADDED: {} (No. {}, Argued {}, Decided {})'.format(
            title_label, docket, argued, decided
        ))

        if not dry_run:
            # Insert in decision-date order.
            insert_at = len(target_cases)
            for i, tc in enumerate(target_cases):
                if tc.get('decision', '') > decided:
                    insert_at = i
                    break
            target_cases.insert(insert_at, new_case)
            added = True

    if modified or added:
        cases_path.write_text(
            json.dumps(target_cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )

    for i, tgt in enumerate(target_cases):
        if i not in matched_indices:
            _title   = tgt.get('title', '?')
            _docket  = tgt.get('number') or '—'
            _argued  = tgt.get('argument') or '—'
            _decided = tgt.get('decision') or '?'
            term_print('  UNKNOWN: {} (No. {}, Argued {}, Decided {})'.format(
                _title, _docket, _argued, _decided
            ))


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
    # justice_order: code -> int (lower = more senior)
    justice_order = {code: int(num) for num, code in vars_data.get('justice', {}).get('values', {}).items() if num.isdigit()}

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
        process_term(term, sorted_terms, source_cases, jname_map, vote_map, justice_order, dry_run)

    print('\nDone.')


if __name__ == '__main__':
    main()
