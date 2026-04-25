#!/usr/bin/env python3
"""
Verify our cases.json data against SCDB CSV files.

Loads the latest "modern" SCDB CSV (highest 4-digit year, e.g. 2025_01.csv)
and the latest "legacy" SCDB CSV (highest revision number after "Legacy_",
e.g. Legacy_07.csv) from data/scdb/, merges them into an indexed table by
caseId, then checks one or more courts/ussc/terms/*/cases.json files.

Default verification behavior for every case object with an "id":
  1. id matches a SCDB caseId.
  2. SCDB dateArgument is contained by our argument field.
  3. SCDB dateRearg is contained by our reargument field.
  4. SCDB dateDecision matches our decision.
  5. If opinion metadata appears to have been imported already, verify
     voteMajority/voteMinority and the votes subset (name+vote) still match
     SCDB. Differences may indicate SCDB corrections.

With --update:
  For cases that do NOT already contain imported opinion metadata, populate
  these fields from SCDB when available:
    volume, page, usCite, voteMajority, voteMinority, votes, opinion_href
  using canonical case key order from scripts/schema.py.

With --term YYYY:
  Restrict checks (and optional updates) to:
    courts/ussc/terms/YYYY-10/cases.json

With --ussc_deck:
  Reads data/ld/ussc_deck.csv and verifies that every row containing an
  "scdb" value has a matching caseId in the combined SCDB table.

With --case <caseId>:
  Prints the fully-parsed case object (including justices array) for
  inspection, without running any other checks.

Usage:
    python3 scripts/scdb/verify_cases.py
    python3 scripts/scdb/verify_cases.py --term 2003
    python3 scripts/scdb/verify_cases.py --term 2003 --update
    python3 scripts/scdb/verify_cases.py --ussc_deck
    python3 scripts/scdb/verify_cases.py --case 1965-001
"""

import argparse
import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
REPO_DIR = SCRIPT_DIR.parent.parent
sys.path.insert(0, str(SCRIPT_DIR.parent))

from schema import reorder_case

DATA_DIR = REPO_DIR / "data" / "scdb"
TERMS_DIR = REPO_DIR / "courts" / "ussc" / "terms"
USCC_DECK_PATH = REPO_DIR / "data" / "ld" / "ussc_deck.csv"
VARS_PATH = DATA_DIR / "vars.json"
JUSTICES_JSON_PATH = REPO_DIR / "scripts" / "justices.json"

MODERN_RE = re.compile(r'^(\d{4})_(\d+)\.csv$')
LEGACY_RE = re.compile(r'^Legacy_(\d+)\.csv$')
US_CITE_RE = re.compile(r'^(\d+)\s+U\.S\.\s+(\d+)$', re.IGNORECASE)
SCDB_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')

MONTH_MAP = {
    'january': '01', 'february': '02', 'march': '03', 'april': '04',
    'may': '05', 'june': '06', 'july': '07', 'august': '08',
    'september': '09', 'october': '10', 'november': '11', 'december': '12',
}


# Columns that are per-justice (one row per justice per case in the CSV).
# Everything from 'justice' onward is justice-level; all columns before it
# are case-level and are identical across all rows for the same caseId.
JUSTICE_COLS = [
    'justice', 'justiceName', 'vote', 'opinion', 'direction',
    'majority', 'firstAgreement', 'secondAgreement',
]


def term_str_to_yyyymm(term_str: str) -> str | None:
    """Convert e.g. 'October Term 1965' or 'July Special Term 1942' → 'YYYY-MM'."""
    m = re.match(r'^(\w+)\s+(?:special\s+)?term\s+(\d{4})$', term_str.strip(), re.IGNORECASE)
    if not m:
        return None
    month = MONTH_MAP.get(m.group(1).lower())
    return f"{m.group(2)}-{month}" if month else None


def find_csvs() -> tuple[Path, Path]:
    """Return (latest_modern_csv, latest_legacy_csv)."""
    modern_candidates: list[tuple[tuple[int, int], Path]] = []
    legacy_candidates: list[tuple[int, Path]] = []

    for f in DATA_DIR.glob("*.csv"):
        m = MODERN_RE.match(f.name)
        if m:
            modern_candidates.append(((int(m.group(1)), int(m.group(2))), f))
            continue
        m = LEGACY_RE.match(f.name)
        if m:
            legacy_candidates.append((int(m.group(1)), f))

    if not modern_candidates:
        sys.exit(f"ERROR: No modern SCDB CSV found in {DATA_DIR}")
    if not legacy_candidates:
        sys.exit(f"ERROR: No legacy SCDB CSV found in {DATA_DIR}")

    modern_path = max(modern_candidates, key=lambda x: x[0])[1]
    legacy_path = max(legacy_candidates, key=lambda x: x[0])[1]
    return modern_path, legacy_path


def load_justices_map() -> dict[str, str]:
    """Return a mapping from uppercase name variants -> canonical uppercase name
    as defined in scripts/justices.json."""
    if not JUSTICES_JSON_PATH.exists():
        return {}
    with open(JUSTICES_JSON_PATH, encoding='utf-8') as f:
        data = json.load(f)
    reverse: dict[str, str] = {}
    for canonical, spec in data.items():
        reverse[canonical.upper()] = canonical.upper()
        for alt in spec.get('alternates', []):
            reverse[alt.upper()] = canonical.upper()
    return reverse


def load_vars() -> dict[str, dict[str, str]]:
    """Load vars.json and return mapping of column name -> {code: label}."""
    if not VARS_PATH.exists():
        return {}
    with open(VARS_PATH, encoding='utf-8') as f:
        raw = json.load(f)

    result: dict[str, dict[str, str]] = {}
    for col, spec in raw.items():
        v = spec.get('values')
        if isinstance(v, dict):
            result[col] = v

    for col, spec in raw.items():
        v = spec.get('values')
        if isinstance(v, str) and v in result:
            result[col] = result[v]

    return result


def normalize_row(row: dict, vars_maps: dict, norm_issues: set) -> dict:
    """Return a dict with all values normalized via vars_maps where possible."""
    normalized: dict[str, str] = {}
    for col, raw in row.items():
        val = raw.strip()
        if col in vars_maps and val and val.upper() != 'NULL':
            label = vars_maps[col].get(val)
            if label is None:
                norm_issues.add((col, val))
                normalized[col] = val
            else:
                normalized[col] = label
        else:
            normalized[col] = val
    return normalized


def load_scdb(csv_path: Path, table: dict, vars_maps: dict, norm_issues: set) -> int:
    """Load CSV into table keyed by caseId. Returns number of new caseIds added."""
    added = 0
    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            cid = row.get('caseId', '').strip()
            if not cid:
                continue

            norm = normalize_row(row, vars_maps, norm_issues)
            justice_obj = {col: norm[col] for col in JUSTICE_COLS if col in norm}

            if cid not in table:
                case_obj = {col: val for col, val in norm.items() if col not in JUSTICE_COLS}
                case_obj['justices'] = []
                table[cid] = case_obj
                added += 1

            table[cid]['justices'].append(justice_obj)

    return added


def parse_scdb_date(s: str) -> datetime | None:
    """Parse a SCDB YYYY-MM-DD date; return None on failure."""
    if not s:
        return None
    try:
        return datetime.strptime(s.strip(), "%Y-%m-%d")
    except ValueError:
        return None


def normalize_cite(s: str) -> str:
    return ' '.join((s or '').split())


def normalize_date_str(s: str) -> str:
    s = (s or '').strip()
    if not s:
        return ''
    if SCDB_DATE_RE.fullmatch(s):
        return s
    dt = parse_scdb_date(s)
    return dt.strftime('%Y-%m-%d') if dt else s


def date_list(val) -> list[str]:
    if isinstance(val, list):
        return [normalize_date_str(str(v)) for v in val if str(v).strip()]
    if isinstance(val, str) and val.strip():
        return [normalize_date_str(val)]
    return []


def contains_date(our_value, scdb_date: str) -> bool:
    target = normalize_date_str(scdb_date)
    if not target:
        return True
    return target in date_list(our_value)


def loc_opinion_href(volume: str, page: str) -> str:
    v = re.sub(r'\D+', '', volume or '')
    p = re.sub(r'\D+', '', page or '')
    if not v or not p:
        return ''
    v3 = v.zfill(3)
    p3 = p.zfill(3)
    vp = f"{v3}{p3}"
    return (
        "https://tile.loc.gov/storage-services/service/ll/usrep/"
        f"usrep{v3}/usrep{vp}/usrep{vp}.pdf"
    )


def parse_us_cite(us_cite: str) -> tuple[str, str]:
    m = US_CITE_RE.match(normalize_cite(us_cite))
    if not m:
        return '', ''
    return m.group(1), m.group(2)


def scdb_vote_to_our(v: str) -> str:
    """Map a SCDB majority-column value (raw or normalized) → 'majority'/'minority'."""
    t = (v or '').strip().lower()
    if t in ('majority', '2'):
        return 'majority'
    if t in ('dissent', 'minority', '1'):
        return 'minority'
    return t


# SCDB `vote` column labels (after vars.json normalization) that mean the
# justice sided with the majority outcome.
_MAJORITY_VOTE_TYPES: frozenset[str] = frozenset([
    'voted with majority or plurality',
    'majority opinion',
    'majority',
    'regular concurrence',
    'special concurrence',
    'judgment of the court',
    'justice participated in an equally divided vote',
])

# SCDB `vote` column labels that mean the justice sided with the minority.
_MINORITY_VOTE_TYPES: frozenset[str] = frozenset([
    'dissent',
    'minority',
    'dissent from a denial or dismissal of certiorari , or dissent from summary affirmation of an appeal',
    'jurisdictional dissent',
])


def vote_type_to_majority(v: str) -> str:
    """Map a vote-type string (SCDB vote column or stored cases.json value) →
    'majority', 'minority', or '' (not participating / unknown)."""
    t = (v or '').strip().lower()
    if t in _MAJORITY_VOTE_TYPES:
        return 'majority'
    if t in _MINORITY_VOTE_TYPES:
        return 'minority'
    return ''


_JUSTICES_MAP: dict[str, str] = {}


def scdb_votes_subset(row: dict) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for j in row.get('justices', []):
        name = (j.get('justiceName') or '').strip().upper()
        # Normalize to site's preferred name via justices.json
        name = _JUSTICES_MAP.get(name, name)
        maj = scdb_vote_to_our(j.get('majority', ''))
        if not name or maj not in ('majority', 'minority'):
            continue
        out.append({'name': name, 'vote': maj})
    # Normalize ordering for deterministic compare/write.
    out.sort(key=lambda x: (x['name'], x['vote']))
    return out


def our_votes_subset(case: dict) -> list[dict[str, str]]:
    raw = case.get('votes')
    if not isinstance(raw, list):
        return []
    out: list[dict[str, str]] = []
    for v in raw:
        if not isinstance(v, dict):
            continue
        name = (v.get('name') or '').strip().upper()
        vote_raw = (v.get('vote') or '').strip().lower()
        # Accept both plain "majority"/"minority" and full SCDB vote-type labels.
        vote = vote_type_to_majority(vote_raw) or scdb_vote_to_our(vote_raw)
        if not name or vote not in ('majority', 'minority'):
            continue
        out.append({'name': name, 'vote': vote})
    out.sort(key=lambda x: (x['name'], x['vote']))
    return out


def has_imported_opinion_data(case: dict) -> bool:
    """Heuristic: any SCDB-imported opinion metadata field present."""
    keys = ['volume', 'page', 'usCite', 'voteMajority', 'voteMinority', 'votes', 'opinion_href']
    for k in keys:
        if k not in case:
            continue
        v = case.get(k)
        if isinstance(v, str) and v.strip():
            return True
        if isinstance(v, list) and v:
            return True
        if isinstance(v, (int, float)):
            return True
    return False


def scdb_majority_counts(row: dict) -> tuple[int | None, int | None]:
    maj_raw = (row.get('majVotes') or '').strip()
    min_raw = (row.get('minVotes') or '').strip()
    try:
        maj = int(float(maj_raw)) if maj_raw else None
    except ValueError:
        maj = None
    try:
        minv = int(float(min_raw)) if min_raw else None
    except ValueError:
        minv = None
    return maj, minv


def _field_present(case: dict, key: str) -> bool:
    """Return True if key exists in case with a non-empty value."""
    if key not in case:
        return False
    v = case[key]
    if isinstance(v, str):
        return bool(v.strip())
    if isinstance(v, list):
        return bool(v)
    if isinstance(v, (int, float)):
        return True
    return False


def apply_scdb_opinion_update(case: dict, row: dict) -> bool:
    """Populate missing opinion metadata fields from SCDB.

    Only fills fields that are absent or empty — never overwrites existing
    values, since those may reflect manual corrections.

    Returns True if any field was added.
    """
    us_cite = normalize_cite(row.get('usCite', ''))
    volume, page = parse_us_cite(us_cite)
    maj_votes, min_votes = scdb_majority_counts(row)
    votes = scdb_votes_subset(row)
    opinion_href = loc_opinion_href(volume, page)

    # Nothing usable from SCDB to add.
    if not any([volume, page, us_cite, maj_votes is not None, min_votes is not None, votes, opinion_href]):
        return False

    new_case = dict(case)
    if volume and not _field_present(case, 'volume'):
        new_case['volume'] = volume
    if page and not _field_present(case, 'page'):
        new_case['page'] = page
    if us_cite and not _field_present(case, 'usCite'):
        new_case['usCite'] = us_cite
    if maj_votes is not None and not _field_present(case, 'voteMajority'):
        new_case['voteMajority'] = maj_votes
    if min_votes is not None and not _field_present(case, 'voteMinority'):
        new_case['voteMinority'] = min_votes
    if votes and not _field_present(case, 'votes'):
        new_case['votes'] = votes
    if opinion_href and not _field_present(case, 'opinion_href'):
        new_case['opinion_href'] = opinion_href

    new_case = reorder_case(new_case)
    if new_case != case:
        case.clear()
        case.update(new_case)
        return True
    return False


def verify_ussc_deck(scdb: dict) -> None:
    """Verify ussc_deck scdb ids exist in SCDB and our cases.json IDs."""
    if not USCC_DECK_PATH.exists():
        sys.exit(f"ERROR: ussc_deck.csv not found at {USCC_DECK_PATH}")

    year_cache: dict[str, set[str]] = {}

    def get_case_ids_for_year(year: str) -> set[str]:
        if year not in year_cache:
            ids: set[str] = set()
            y = int(year)
            for pattern in (f"{y-1}-*", f"{y}-*", f"{y+1}-*"):
                for cases_path in sorted(TERMS_DIR.glob(f"{pattern}/cases.json")):
                    try:
                        cases = json.loads(cases_path.read_text(encoding='utf-8'))
                        ids.update(c['id'] for c in cases if c.get('id'))
                    except Exception:
                        pass
            year_cache[year] = ids
        return year_cache[year]

    checked = 0
    not_in_scdb: list[str] = []
    not_in_cases: list[str] = []

    with open(USCC_DECK_PATH, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            raw_scdb = row.get('scdb', '').strip()
            if not raw_scdb:
                continue
            term_str = row.get('term', '').strip()

            scdb_ids = [s.strip() for s in raw_scdb.split(',') if s.strip()]
            for scdb_id in scdb_ids:
                checked += 1
                if scdb_id not in scdb:
                    not_in_scdb.append(f"  {scdb_id}: {term_str}")
                    continue

                s = scdb[scdb_id]
                year = s.get('term', '').strip()
                if not year or not re.fullmatch(r'\d{4}', year):
                    not_in_cases.append(
                        f"  {scdb_id}: unrecognized SCDB term value {year!r}"
                    )
                    continue

                case_ids = get_case_ids_for_year(year)
                next_year = str(int(year) + 1)
                prev_year = str(int(year) - 1)
                if not case_ids:
                    not_in_cases.append(
                        f"  {scdb_id}: no cases.json found for {prev_year}-*, {year}-*, or {next_year}-*"
                    )
                    continue

                if scdb_id not in case_ids:
                    summary = (
                        f"{year} | {s.get('caseName','')} | "
                        f"docket={s.get('docket','')} | decided={s.get('dateDecision','')}"
                    )
                    not_in_cases.append(f"  {scdb_id}: {summary}")

    print(f"Checked {checked} SCDB id(s) across ussc_deck rows.")

    if not_in_scdb:
        print(f"\n{len(not_in_scdb)} caseId(s) not found in SCDB:")
        for m in not_in_scdb:
            print(m)
    else:
        print("All SCDB ids found in SCDB data.")

    if not_in_cases:
        print(f"\n{len(not_in_cases)} caseId(s) not found in our cases.json:")
        for m in not_in_cases:
            print(m)
    else:
        print("All SCDB ids found in cases.json.")


def print_case(scdb: dict, case_id: str) -> None:
    case = scdb.get(case_id)
    if case is None:
        print(f"caseId {case_id!r} not found in loaded SCDB data.")
        return
    print(json.dumps(case, indent=2))


def target_cases_files(term_year: str | None) -> list[Path]:
    if term_year:
        if not re.fullmatch(r'\d{4}', term_year):
            sys.exit(f"ERROR: --term expects YYYY, got {term_year!r}")
        p = TERMS_DIR / f"{term_year}-10" / "cases.json"
        if not p.exists():
            sys.exit(f"ERROR: term cases file not found: {p}")
        return [p]

    cases_files = sorted(TERMS_DIR.glob('*/cases.json'))
    if not cases_files:
        print(f"WARNING: No cases.json files found under {TERMS_DIR}")
    return cases_files


def verify_terms(scdb: dict, term_year: str | None = None, update: bool = False, verbose: bool = False) -> None:
    cases_files = target_cases_files(term_year)
    total = 0
    skipped = 0
    errors: list[str] = []
    updates = 0

    for cases_file in cases_files:
        term = cases_file.parent.name
        try:
            cases = json.loads(cases_file.read_text(encoding='utf-8'))
        except Exception as e:
            errors.append(f"[{term}] Could not parse {cases_file}: {e}")
            continue

        term_changed = False

        for case in cases:
            cid = case.get('id')
            if not cid:
                skipped += 1
                continue

            total += 1
            title = case.get('title', cid)
            prefix = f"[{term}] {cid} ({title})"

            if cid not in scdb:
                errors.append(f"{prefix}: caseId not found in SCDB")
                continue

            row = scdb[cid]

            # 1) dateArgument must be contained by our argument
            scdb_arg = normalize_date_str(row.get('dateArgument', ''))
            if scdb_arg and not contains_date(case.get('argument'), scdb_arg):
                errors.append(
                    f"{prefix}: dateArgument not contained by argument: "
                    f"scdb={scdb_arg!r} ours={case.get('argument')!r}"
                )

            # 2) dateRearg (or datreRearg, if present) must be contained by our reargument
            scdb_rearg = normalize_date_str(row.get('dateRearg') or row.get('datreRearg', ''))
            if scdb_rearg and not contains_date(case.get('reargument'), scdb_rearg):
                errors.append(
                    f"{prefix}: dateRearg not contained by reargument: "
                    f"scdb={scdb_rearg!r} ours={case.get('reargument')!r}"
                )

            # 3) dateDecision must match our decision
            scdb_decision = normalize_date_str(row.get('dateDecision', ''))
            our_decision = normalize_date_str(case.get('decision', ''))
            if scdb_decision and our_decision and scdb_decision != our_decision:
                errors.append(
                    f"{prefix}: decision mismatch: ours={our_decision!r} scdb={scdb_decision!r}"
                )

            imported = has_imported_opinion_data(case)

            if imported:
                # If we already imported opinion data, verify it still matches SCDB.
                scdb_maj, scdb_min = scdb_majority_counts(row)

                if scdb_maj is not None:
                    our_maj = case.get('voteMajority')
                    if our_maj != scdb_maj:
                        errors.append(
                            f"{prefix}: voteMajority mismatch: ours={our_maj!r} scdb={scdb_maj!r}"
                        )

                if scdb_min is not None:
                    our_min = case.get('voteMinority')
                    if our_min != scdb_min:
                        errors.append(
                            f"{prefix}: voteMinority mismatch: ours={our_min!r} scdb={scdb_min!r}"
                        )

                scdb_votes = scdb_votes_subset(row)
                our_votes = our_votes_subset(case)
                if scdb_votes and our_votes != scdb_votes:
                    msg = f"{prefix}: votes subset mismatch (name+vote)."
                    if verbose:
                        scdb_set = {(v['name'], v['vote']) for v in scdb_votes}
                        our_set  = {(v['name'], v['vote']) for v in our_votes}
                        only_scdb = sorted(scdb_set - our_set)
                        only_ours = sorted(our_set  - scdb_set)
                        lines = [msg]
                        for name, vote in only_scdb:
                            lines.append(f"      scdb only:  {name} / {vote}")
                        for name, vote in only_ours:
                            lines.append(f"      ours only:  {name} / {vote}")
                        msg = '\n'.join(lines)
                    errors.append(msg)
            if update:
                if apply_scdb_opinion_update(case, row):
                    updates += 1
                    term_changed = True

        if term_changed:
            cases_file.write_text(
                json.dumps(cases, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            print(f"Updated {cases_file.relative_to(REPO_DIR)}")

    print(f"Checked {total} cases with SCDB ids ({skipped} cases skipped — no id).")
    if update:
        print(f"Applied SCDB opinion metadata updates to {updates} case(s).")

    if errors:
        print(f"\n{len(errors)} issue(s) found:\n")
        for e in errors:
            print(f"  {e}")
    else:
        print("All checks passed.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verify cases.json data and/or ussc_deck.csv against SCDB."
    )
    parser.add_argument(
        "--ussc_deck",
        action="store_true",
        help="Verify every scdb-tagged row in data/ld/ussc_deck.csv exists in SCDB.",
    )
    parser.add_argument(
        "--case",
        metavar="CASEID",
        help="Print the parsed SCDB case object for CASEID and exit.",
    )
    parser.add_argument(
        "--term",
        metavar="YYYY",
        help="Restrict checks/updates to courts/ussc/terms/YYYY-10/cases.json.",
    )
    parser.add_argument(
        "--update",
        action="store_true",
        help="For cases lacking imported opinion metadata, import SCDB opinion metadata.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print per-justice details for votes subset mismatches.",
    )
    args = parser.parse_args()

    modern_csv, legacy_csv = find_csvs()
    print(f"Modern SCDB: {modern_csv.name}")
    print(f"Legacy SCDB: {legacy_csv.name}")

    vars_maps = load_vars()
    if vars_maps:
        print(f"Loaded vars.json ({len(vars_maps)} column mappings).")
    else:
        print("WARNING: vars.json not found or empty — no normalization applied.")

    global _JUSTICES_MAP
    _JUSTICES_MAP = load_justices_map()
    if _JUSTICES_MAP:
        print(f"Loaded justices.json ({len(_JUSTICES_MAP)} name entries).")
    else:
        print("WARNING: justices.json not found — justice names not normalized.")

    scdb: dict = {}
    norm_issues: set[tuple[str, str]] = set()
    m_added = load_scdb(modern_csv, scdb, vars_maps, norm_issues)
    l_added = load_scdb(legacy_csv, scdb, vars_maps, norm_issues)
    print(
        f"Loaded {m_added:,} cases from modern, {l_added:,} unique cases from legacy "
        f"({len(scdb):,} total)."
    )

    if norm_issues and args.verbose:
        print(f"\n{len(norm_issues)} normalization issue(s) — unknown codes in mapped columns:")
        for col, val in sorted(norm_issues):
            print(f"  {col}: {val!r}")
    print()

    if args.case:
        print_case(scdb, args.case)
    elif args.ussc_deck:
        verify_ussc_deck(scdb)
    else:
        verify_terms(scdb, term_year=args.term, update=args.update, verbose=args.verbose)


if __name__ == "__main__":
    main()
