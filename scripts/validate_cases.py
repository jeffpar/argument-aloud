#!/usr/bin/env python3
"""Validate file entries and case metadata for SCOTUS cases.

Usage:
    python3 scripts/validate_cases.py TERM [CASE] [--checkurls] [--opinions] [--verbose]

Examples:
    python3 scripts/validate_cases.py 2025-10 24-1260
    python3 scripts/validate_cases.py 2025-10
    python3 scripts/validate_cases.py 2025-10 --checkurls
    python3 scripts/validate_cases.py 2025-10 24-1260 --checkurls
    python3 scripts/validate_cases.py 2025-10 --checkurls --opinions
    python3 scripts/validate_cases.py 2025-10 --verbose

Per-run checks (always):
  1. Checks supremecourt.gov for a slip opinion matching the case's docket number;
     if found and not already recorded, adds it to files.json as type "opinion".
  2. Checks consistency of 'decision' vs 'dateDecision' in cases.json; prints any
     discrepancy and inserts a missing 'dateDecision' derived from 'decision'.
  3. Detects files in case folders not yet listed in files.json, adds an entry for
     each one (inferring type from the filename, building a title from the stem),
     and increments the 'files' count in cases.json.

With --checkurls:
  4. Verifies every href URL in files.json is reachable (HTTP HEAD with GET fallback)
     and checks iframe-embeddability via CSP / X-Frame-Options; downloads framing-
     blocked documents locally and replaces href accordingly.
  5. Probes every opinion_href, audio_href, and transcript_href in cases.json;
     renames unreachable keys to *_bad.

With --checkurls --opinions:
  Same as --checkurls but restricts URL probing to opinion_href only (skips
  audio_href, transcript_href, and files.json hrefs).
"""

import datetime
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT    = Path(__file__).resolve().parent.parent
SCOTUS_BASE  = 'https://www.supremecourt.gov'

_OPINIONS_CACHE: dict = {}  # year_2digit -> {docket_lower: {date, name, author, href}}

_DATE_DEC_PARSE_RE  = re.compile(
    r'^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+'
    r'(January|February|March|April|May|June|July|August|September|'
    r'October|November|December)\s+(\d{1,2}),\s+(\d{4})$'
)

_MONTHS = ['January','February','March','April','May','June',
           'July','August','September','October','November','December']
_DAYS   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']


# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _request(url: str, method: str = 'HEAD') -> tuple[bool, dict]:
    req = urllib.request.Request(
        url, method=method, headers={'User-Agent': 'Mozilla/5.0'}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return True, dict(resp.headers)
    except urllib.error.HTTPError as exc:
        return False, {'_status': exc.code}
    except Exception as exc:
        return False, {'_error': str(exc)}


def check_url(url: str) -> tuple[bool, dict]:
    """Return (reachable, headers). Tries HEAD; falls back to GET if HEAD is refused."""
    ok, headers = _request(url, 'HEAD')
    if not ok and headers.get('_status', 0) in (405, 501):
        ok, headers = _request(url, 'GET')
    return ok, headers


_DELAYS: list[tuple[str, float]] = [
    ('supremecourt.gov', 2.0),
]
_DEFAULT_DELAY = 0.5


def _polite_delay(url: str) -> None:
    host = urllib.parse.urlparse(url).hostname or ''
    for domain, delay in _DELAYS:
        if host == domain or host.endswith('.' + domain):
            time.sleep(delay)
            return
    time.sleep(_DEFAULT_DELAY)


# ── Iframe-safety check ───────────────────────────────────────────────────────

def is_framing_blocked(headers: dict) -> bool:
    """Return True if response headers indicate the URL cannot be iframed."""
    xfo = headers.get('X-Frame-Options', '').strip().upper()
    if xfo in ('DENY', 'SAMEORIGIN'):
        return True

    csp = headers.get('Content-Security-Policy', '')
    for directive in csp.split(';'):
        directive = directive.strip()
        if directive.lower().startswith('frame-ancestors'):
            sources = directive.split()[1:]
            if '*' not in sources:
                return True

    return False


# ── Download helper ───────────────────────────────────────────────────────────

def _local_filename(url: str) -> str:
    """Derive a safe local filename from a URL."""
    path = urllib.parse.urlparse(url).path
    name = urllib.parse.unquote(Path(path).name)
    safe = ''.join(c if c.isalnum() or c in '._-' else '_' for c in name)
    return safe or 'download.pdf'


def _unique_dest(case_dir: Path, name: str) -> Path:
    dest = case_dir / name
    if not dest.exists():
        return dest
    stem, suffix = Path(name).stem, Path(name).suffix
    i = 1
    while dest.exists():
        dest = case_dir / f'{stem}-{i}{suffix}'
        i += 1
    return dest


def download_file(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as resp:
        dest.write_bytes(resp.read())


# ── Opinions index ────────────────────────────────────────────────────────────

def _fetch_opinions(year_2digit: str) -> dict:
    """Fetch and parse the SCOTUS slip-opinions index for a 2-digit term year.

    Returns a dict keyed by lowercase docket number, e.g.
        {'24-539': {'date': '2026-03-31', 'name': 'Chiles v. Salazar',
                    'author': 'NG', 'href': 'https://…/24-539_xxx.pdf'}}
    """
    if year_2digit in _OPINIONS_CACHE:
        return _OPINIONS_CACHE[year_2digit]

    url = f'{SCOTUS_BASE}/opinions/slipopinion/{year_2digit}'
    print(f'Fetching opinions index: {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode('utf-8', errors='replace')
    except Exception as exc:
        print(f'    Warning: could not fetch opinions index: {exc}')
        _OPINIONS_CACHE[year_2digit] = {}
        return {}

    # Each opinion row: date | docket (white-space:nowrap) | name<a>…</a> | J.
    pattern = re.compile(
        r'<td[^>]*>(\d{1,2}/\d{1,2}/\d{2})</td>\s*'
        r'<td[^>]*white-space[^>]*>([^<]+)</td>\s*'
        r'<td[^>]*><a href=.(/opinions/\S+?\.pdf)[^>]*>([^<]+)</a>'
        r'.*?<td[^>]*>(\w+)</td>',
        re.DOTALL,
    )

    opinions: dict = {}
    for m in pattern.finditer(html):
        date_raw, docket, href, name, author = (g.strip() for g in m.groups())
        try:
            date_iso = datetime.datetime.strptime(date_raw, '%m/%d/%y').strftime('%Y-%m-%d')
        except ValueError:
            date_iso = date_raw
        opinions[docket.lower()] = {
            'date':   date_iso,
            'name':   name,
            'author': author,
            'href':   SCOTUS_BASE + href,
        }

    _OPINIONS_CACHE[year_2digit] = opinions
    full_year = str(2000 + int(year_2digit))
    print(f'  Found {len(opinions)} opinion(s) for term year {full_year}.')
    return opinions


def check_opinion_for_case(files_path: Path, case_number: str, term: str,
                           print_header=None) -> None:
    """If a slip opinion exists for this case, add it to files.json."""
    year_2 = term.split('-')[0][-2:]  # '2025-10' -> '25'
    opinions = _fetch_opinions(year_2)
    opinion = opinions.get(case_number.lower())
    if not opinion:
        return

    data: list = json.loads(files_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    if any(e.get('type') == 'opinion' for e in data):
        return

    max_id = max(
        (e['file'] for e in data if isinstance(e.get('file'), int)),
        default=0,
    )
    new_entry = {
        'file':   max_id + 1,
        'type':   'opinion',
        'title':  'Opinion in ' + opinion['name'],
        'date':   opinion['date'],
        'author': opinion['author'],
        'href':   opinion['href'],
    }
    data.append(new_entry)
    files_path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )
    if print_header: print_header()
    print(f'    Opinion: added "{new_entry["title"]}" ({opinion["date"]}, J. {opinion["author"]})')


# ── Source/type detection ─────────────────────────────────────────────────────

def _detect_source_type(audio_href: str) -> tuple[str, str]:
    """Return (source, type) derived from an audio_href URL.

    source:
      'ussc'  — hosted on supremecourt.gov
      'nara'  — hosted on NARA infrastructure (NARAprodstorage, archives.gov, …)
      'oyez'  — hosted on Oyez S3 bucket
    type:
      'reargument' — Oyez URL explicitly contains 'reargument'
      'argument'   — everything else (default)
    """
    href_lower = audio_href.lower()
    if 'supremecourt.gov' in href_lower:
        source = 'ussc'
    elif 'nara' in href_lower:
        source = 'nara'
    elif 'oyez' in href_lower:
        source = 'oyez'
    else:
        source = 'unknown'

    if source == 'oyez' and 'opinion' in href_lower:
        type_val = 'opinion'
    elif source == 'oyez' and 'reargument' in href_lower:
        type_val = 'reargument'
    else:
        type_val = 'argument'
    return source, type_val


def migrate_arguments_to_audio(cases_path: Path) -> None:
    """One-time migration: rename the 'arguments' key to 'audio' in cases.json."""
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    modified = False
    for case in data:
        if 'arguments' in case and 'audio' not in case:
            case['audio'] = case.pop('arguments')
            modified = True

    if modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('Migrated cases.json: renamed "arguments" → "audio".')


def _is_transcript_aligned(transcript_path: Path) -> bool:
    """Return True if the transcript file exists and has at least one turn with a 'time' value."""
    if not transcript_path.exists():
        return False
    try:
        data = json.loads(transcript_path.read_text(encoding='utf-8'))
        turns = data if isinstance(data, list) else data.get('turns', [])
        return any(t.get('time') for t in turns)
    except Exception:
        return False


def validate_cases_json_arguments(cases_path: Path) -> None:
    """Add/update 'source', 'type', and 'aligned' at the top of each audio object in cases.json."""
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    term_dir = cases_path.parent
    modified = False
    for case in data:
        case_dir = term_dir / 'cases' / _case_folder(case.get('number', '') or case.get('id', ''))
        for i, arg in enumerate(case.get('audio', [])):
            audio_href = arg.get('audio_href', '')
            if not audio_href:
                continue

            source, inferred_type = _detect_source_type(audio_href)

            # Preserve any explicitly recorded type; only fall back to the
            # URL-inferred type when the key is absent entirely.
            type_val = arg.get('type') or inferred_type

            text_href = arg.get('text_href', '')
            is_aligned = bool(
                text_href and _is_transcript_aligned(case_dir / text_href)
            )

            current_aligned = arg.get('aligned')  # True, False, or absent (None)
            desired_aligned  = True if is_aligned else None  # None → remove key

            if (arg.get('source') == source and arg.get('type') == type_val
                    and current_aligned == desired_aligned):
                continue  # already correct, leave untouched

            # Rebuild with source + type (+ aligned) first, preserving all other keys.
            new_arg: dict = {'source': source, 'type': type_val}
            if is_aligned:
                new_arg['aligned'] = True
            new_arg.update({k: v for k, v in arg.items()
                            if k not in ('source', 'type', 'aligned')})
            case['audio'][i] = new_arg
            modified = True

    if modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('Updated cases.json: set source/type/aligned on audio objects.')
    else:
        pass  # no changes needed


def normalize_audio_aligned_position(cases_path: Path) -> None:
    """Ensure 'aligned' is the last key in every audio object that has it."""
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    modified = False
    for case in data:
        for arg in case.get('audio', []):
            if 'aligned' not in arg:
                continue
            keys = list(arg.keys())
            if keys[-1] == 'aligned':
                continue  # already last
            aligned_val = arg.pop('aligned')
            arg['aligned'] = aligned_val
            modified = True

    if modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('Updated cases.json: moved "aligned" to last position in audio objects.')


def sync_files_count(cases_path: Path) -> None:
    """Set a 'files' count at the end of each case object in cases.json,
    reflecting the current number of entries in that case's files.json
    (or 0 if the file does not exist yet)."""
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    term_dir = cases_path.parent
    modified = False
    for case in data:
        folder_name = _case_folder(case.get('number', '') or case.get('id', ''))
        files_path = term_dir / 'cases' / folder_name / 'files.json'
        count = 0
        if files_path.exists():
            try:
                files = json.loads(files_path.read_text(encoding='utf-8'))
                count = len(files) if isinstance(files, list) else 0
            except Exception:
                pass

        keys = list(case.keys())
        if keys[-1] == 'files' and case['files'] == count:
            continue  # already correct and already last

        case.pop('files', None)
        case['files'] = count
        modified = True

    if modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('Updated cases.json: synced "files" counts.')


# ── Speaker map cleanup ───────────────────────────────────────────────────────

_SPEAKERMAP_CONSTRAINT_RE = re.compile(r'^(.*?)\s+(>=|<)\s+(\d{4}-\d{2})$')


def load_speaker_map() -> list[tuple[str, str | None, str | None, str, str | None, str | None]]:
    """Load scripts/speakermap.txt -> list of (base_name, op, constraint_term, new_name, role_filter, new_role).

    LHS entries may carry a role prefix:
      JUSTICE:NAME -> NEW        (applies only when speaker role == 'justice')
    LHS entries may also carry a term constraint:
      NAME < YYYY-MM -> NEW      (applies only when term < YYYY-MM)
      NAME >= YYYY-MM -> NEW     (applies only when term >= YYYY-MM)
    Unconstrained entries always apply.

    RHS entries may carry a role prefix:
      ADVOCATE:NAME              (changes the matched speaker's role to 'advocate'
                                  and their name to NAME)
    Entries are ordered; the first matching entry for each speaker wins.
    """
    path = Path(__file__).resolve().parent / 'speakermap.txt'
    if not path.exists():
        return []
    result: list[tuple[str, str | None, str | None, str, str | None, str | None]] = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('->', 1)
        if len(parts) == 2:
            lhs, rhs = parts[0].strip(), parts[1].strip()
            if not lhs or not rhs:
                continue
            if lhs.upper().startswith('JUSTICE:'):
                role_filter: str | None = 'justice'
                lhs = lhs[len('JUSTICE:'):].strip()
            else:
                role_filter = None
            if rhs.upper().startswith('ADVOCATE:'):
                new_role: str | None = 'advocate'
                new_name = rhs[len('ADVOCATE:'):].strip()
            else:
                new_role = None
                new_name = rhs
            m = _SPEAKERMAP_CONSTRAINT_RE.match(lhs)
            if m:
                result.append((m.group(1), m.group(2), m.group(3), new_name, role_filter, new_role))
            else:
                result.append((lhs, None, None, new_name, role_filter, new_role))
    return result


def filter_speaker_map(
    entries: list[tuple[str, str | None, str | None, str, str | None, str | None]],
    term: str,
) -> list[tuple[str, str | None, str | None, str, str | None, str | None]]:
    """Return an ordered list of entries applicable to the given term string.

    Preserves the order from speakermap.txt so that the first matching entry
    for each speaker wins when mappings are applied.
    """
    result = []
    for entry in entries:
        base_name, op, constraint_term, new_name, role_filter, new_role = entry
        if op is None:
            result.append(entry)
        elif op == '<' and term < constraint_term:  # type: ignore[operator]
            result.append(entry)
        elif op == '>=' and term >= constraint_term:  # type: ignore[operator]
            result.append(entry)
    return result


def check_unmapped_justices(case_dir: Path) -> None:
    """Warn about speakers with role 'justice' whose name does not contain 'JUSTICE'."""
    if not case_dir.is_dir():
        return
    for json_path in sorted(case_dir.glob('*.json')):
        if json_path.name == 'files.json':
            continue
        try:
            data = json.loads(json_path.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        for sp in (data.get('media') or {}).get('speakers') or []:
            name, role = sp.get('name', ''), sp.get('role', '')
            if role == 'justice' and 'JUSTICE' not in name.upper():
                print(f'  {case_dir.name}/{json_path.name}: justice without JUSTICE in name: {name!r}')
            elif role != 'justice' and 'JUSTICE' in name.upper():
                print(f'  {case_dir.name}/{json_path.name}: non-justice with JUSTICE in name: {name!r} (role={role!r})')


def apply_speaker_map_to_case(case_dir: Path, entries: list[tuple]) -> None:
    """Apply speaker name mappings (ordered, first-match-wins) to all transcript JSON files in a case directory."""
    if not case_dir.is_dir():
        return
    for json_path in sorted(case_dir.glob('*.json')):
        if json_path.name == 'files.json':
            continue
        try:
            data = json.loads(json_path.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        modified = False
        speakers = (data.get('media') or {}).get('speakers') or []

        # Pass 1: auto-assign 'justice' role to speakers whose name contains
        # JUSTICE but whose role field is absent.
        for sp in speakers:
            if not sp.get('role') and 'JUSTICE' in sp.get('name', '').upper():
                sp['role'] = 'justice'
                modified = True

        # Build a name→role snapshot (pre-mapping) so that turn processing can
        # honour role_filter constraints using the speaker's original role.
        speaker_roles: dict[str, str] = {
            sp.get('name', ''): sp.get('role', '') for sp in speakers
        }

        # Pass 2: apply ordered, first-match-wins name/role mappings to speakers.
        for sp in speakers:
            name = sp.get('name', '')
            role = sp.get('role', '')
            for base_name, op, constraint_term, new_name, role_filter, new_role in entries:
                if name != base_name:
                    continue
                if role_filter is not None and role != role_filter:
                    continue
                sp['name'] = new_name
                if new_role is not None:
                    sp['role'] = new_role
                modified = True
                break  # first match wins; skip remaining entries for this speaker

        # Apply ordered, first-match-wins name mappings to turns, using the
        # pre-mapping speaker_roles snapshot to evaluate role_filter constraints.
        for turn in data.get('turns') or []:
            name = turn.get('name', '')
            role = speaker_roles.get(name, '')
            for base_name, op, constraint_term, new_name, role_filter, new_role in entries:
                if name != base_name:
                    continue
                if role_filter is not None and role != role_filter:
                    continue
                turn['name'] = new_name
                modified = True
                break  # first match wins

        if modified:
            json_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            print(f'  {case_dir.name}: applied speaker map to {json_path.name}')
    check_unmapped_justices(case_dir)


# ── Decision date consistency ─────────────────────────────────────────────────

def _iso_to_date_decision(iso: str) -> str | None:
    """Convert 'YYYY-MM-DD' → 'Monday, January 5, 2026', or None."""
    try:
        dt = datetime.date(
            int(iso[0:4]), int(iso[5:7]), int(iso[8:10])
        )
        return f'{_DAYS[dt.weekday()]}, {_MONTHS[dt.month - 1]} {dt.day}, {dt.year}'
    except (ValueError, IndexError):
        return None


def _date_decision_to_iso(date_decision: str) -> str | None:
    """Convert 'Monday, January 5, 2026' → '2026-01-05', or None."""
    m = _DATE_DEC_PARSE_RE.match(date_decision.strip())
    if not m:
        return None
    month_name, day, year = m.group(1), int(m.group(2)), int(m.group(3))
    month = _MONTHS.index(month_name) + 1
    try:
        return datetime.date(year, month, day).strftime('%Y-%m-%d')
    except ValueError:
        return None


def check_decision_dates(cases_path: Path, term: str) -> None:
    """Check 'decision' vs 'dateDecision' consistency; insert missing dateDecision."""
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    modified = False
    for case in data:
        decision = case.get('decision', '')
        date_dec = case.get('dateDecision', '')
        label    = case.get('number') or case.get('id', '?')
        title    = case.get('title', '')

        if not decision:
            continue

        generated = _iso_to_date_decision(decision)
        if generated is None:
            print(f'WARNING: {term}/{label} ({title[:40]}): '
                  f'cannot parse decision={decision!r}')
            continue

        if not date_dec:
            # Insert dateDecision immediately after decision.
            new_case: dict = {}
            for k, v in case.items():
                new_case[k] = v
                if k == 'decision':
                    new_case['dateDecision'] = generated
            case.clear()
            case.update(new_case)
            modified = True
            print(f'  {term}/{label}: inserted dateDecision={generated!r}')
        else:
            parsed_back = _date_decision_to_iso(date_dec)
            if parsed_back != decision:
                print(f'WARNING: {term}/{label} ({title[:40]}): '
                      f'decision={decision!r} but dateDecision parses to '
                      f'{parsed_back!r} (stored: {date_dec!r})')

    if modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('Updated cases.json: inserted missing dateDecision values.')


# ── Opinion href probing ──────────────────────────────────────────────────────

def _rename_key(obj: dict, old_key: str, new_key: str) -> None:
    """Rename a key in a dict in-place, preserving insertion order."""
    items = list(obj.items())
    idx = next(i for i, (k, _) in enumerate(items) if k == old_key)
    items[idx] = (new_key, items[idx][1])
    obj.clear()
    obj.update(items)


def _case_folder(number_or_id: str) -> str:
    """Return the case folder name for a number field.

    For consolidated cases the number field is comma-separated (e.g. '22,43').
    The folder on disk is named after the first number only.
    """
    return number_or_id.split(',')[0].strip()


def check_case_hrefs(cases_path: Path, term: str) -> None:
    """Probe opinion_href, audio_href, and text_href URLs in cases.json.

    Unreachable URLs have '_bad' appended to their key name so they stop
    being used, and cases.json is rewritten if anything changed.
    """
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    dirty = False
    for case in data:
        case_label = case.get('number') or case.get('id', '?')
        _header_printed = False

        def _print_case_header():
            nonlocal _header_printed
            if not _header_printed:
                print(f'{case_label}:')
                _header_printed = True

        # opinion_href
        href = case.get('opinion_href', '')
        if href and href.startswith(('http://', 'https://')):
            _print_case_header()
            label = href if len(href) <= 80 else href[:77] + '…'
            print(f'  [o] {label}', end=' ', flush=True)
            ok, headers = check_url(href)
            _polite_delay(href)
            if not ok:
                status = headers.get('_status') or headers.get('_error', 'unknown')
                print(f'✗ UNREACHABLE ({status}) — renaming to opinion_href_bad')
                _rename_key(case, 'opinion_href', 'opinion_href_bad')
                dirty = True
            else:
                print('✓')

        # audio entries: audio_href and transcript_href
        if not opinions_only:
            _tag = {'audio_href': 'a', 'transcript_href': 't'}
            for entry in case.get('audio') or []:
                for key in ('audio_href', 'transcript_href'):
                    href = entry.get(key, '')
                    if not href or not href.startswith(('http://', 'https://')):
                        continue
                    _print_case_header()
                    tag = _tag[key]
                    label = href if len(href) <= 80 else href[:77] + '…'
                    print(f'  [{tag}] {label}', end=' ', flush=True)
                    ok, headers = check_url(href)
                    _polite_delay(href)
                    if not ok:
                        status = headers.get('_status') or headers.get('_error', 'unknown')
                        bad_key = key + '_bad'
                        print(f'✗ UNREACHABLE ({status}) — renaming to {bad_key}')
                        _rename_key(entry, key, bad_key)
                        dirty = True
                    else:
                        print('✓')

    if dirty:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )


# ── Untracked files backfill ──────────────────────────────────────────────────

def _file_type_from_name(name: str) -> str | None:
    """Infer a files.json 'type' value from a filename."""
    lower = name.lower()
    if any(kw in lower for kw in ('amicus', 'amici')):
        return 'amicus'
    if any(kw in lower for kw in ('petitioner', 'appellant')):
        return 'petitioner'
    if any(kw in lower for kw in ('respondent', 'appellee')):
        return 'respondent'
    return None


def _title_from_filename(name: str) -> str:
    """Build a user-friendly title from a filename (without extension)."""
    stem = re.sub(r'[-_]+', ' ', Path(name).stem)
    return stem.title()


def backfill_untracked_files(cases_path: Path, term: str) -> None:
    """Add files.json entries for files in case folders not yet listed.

    Skips files.json itself, hidden files, and .json transcript files.
    Does not touch cases.json directly; call sync_files_count() afterward
    to update the 'files' counts.
    """
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    term_dir = cases_path.parent

    for case in data:
        folder_name = _case_folder(case.get('number') or case.get('id', ''))
        if not folder_name:
            continue
        case_dir = term_dir / 'cases' / folder_name
        if not case_dir.is_dir():
            continue

        files_path = case_dir / 'files.json'
        if files_path.exists():
            try:
                files_data = json.loads(files_path.read_text(encoding='utf-8'))
            except Exception:
                continue
            if not isinstance(files_data, list):
                continue
        else:
            files_data = []

        rel_case = 'cases/' + folder_name

        # Build set of basenames already referenced in files.json (local hrefs only).
        tracked: set[str] = set()
        for entry in files_data:
            href = entry.get('href', '')
            if not href.startswith(('http://', 'https://')):
                tracked.add(Path(href).name)

        files_modified = False
        for fpath in sorted(case_dir.iterdir()):
            if fpath.is_dir() or fpath.name.startswith('.'):
                continue
            if fpath.suffix == '.json':
                continue
            if fpath.name in tracked:
                continue

            max_id = max(
                (e['file'] for e in files_data if isinstance(e.get('file'), int)),
                default=0,
            )
            local_href = f'/courts/ussc/terms/{term}/{rel_case}/{fpath.name}'
            new_entry: dict = {
                'file':  max_id + 1,
                'title': _title_from_filename(fpath.name),
            }
            ftype = _file_type_from_name(fpath.name)
            if ftype:
                new_entry['type'] = ftype
            new_entry['href'] = local_href
            files_data.append(new_entry)
            tracked.add(fpath.name)
            files_modified = True
            print(f'  {folder_name}: added untracked file {fpath.name!r}')

        if files_modified:
            files_path.write_text(
                json.dumps(files_data, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )


# ── Core validation ───────────────────────────────────────────────────────────

def validate_files_json(files_path: Path, case_dir: Path, check_urls: bool = False,
                        print_header=None, opinions_only: bool = False) -> None:
    data = json.loads(files_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    if not check_urls or opinions_only:
        return

    modified = False

    for entry in data:
        href = entry.get('href', '')
        file_num = entry.get('file', '?')

        # Only validate absolute HTTP(S) URLs that haven't already been localized.
        if not href.startswith(('http://', 'https://')):
            continue
        if entry.get('source'):
            if print_header: print_header()
            print(f'  [{file_num}] already localized — skipped.')
            continue

        if print_header: print_header()
        label = href if len(href) <= 80 else href[:77] + '…'
        print(f'  [{file_num}] {label}', end=' ', flush=True)

        ok, headers = check_url(href)
        _polite_delay(href)
        if not ok:
            status = headers.get('_status') or headers.get('_error', 'unknown')
            print(f'✗ UNREACHABLE ({status}) — renaming to href_bad')
            _rename_key(entry, 'href', 'href_bad')
            modified = True
            continue

        if is_framing_blocked(headers):
            local_name = _local_filename(href)
            dest = _unique_dest(case_dir, local_name)
            print(f'⚠ framing blocked → {dest.name} ...', end=' ', flush=True)
            try:
                download_file(href, dest)
                entry['source'] = entry['href']
                entry['href'] = '/' + dest.relative_to(REPO_ROOT).as_posix()
                modified = True
                print('✓ downloaded')
            except Exception as exc:
                print(f'ERROR: {exc}')
            time.sleep(0.3)
        else:
            print('✓')

    if modified:
        files_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )


def validate_case(term_dir: Path, case_number: str, check_urls: bool = False,
                  opinions_only: bool = False) -> None:
    files_path = term_dir / 'cases' / case_number / 'files.json'
    if not files_path.exists():
        return
    _printed = [False]
    def _print_header():
        if not _printed[0]:
            print(f'{case_number}:')
            _printed[0] = True
    validate_files_json(files_path, files_path.parent, check_urls, _print_header, opinions_only)
    check_opinion_for_case(files_path, case_number, term_dir.name, _print_header)


def check_duplicate_case_numbers(term_dir: Path) -> None:
    """Warn if any case number appears more than once in cases.json."""
    cases_path = term_dir / 'cases.json'
    if not cases_path.exists():
        return
    cases = json.loads(cases_path.read_text(encoding='utf-8'))
    seen: dict[str, str] = {}   # lower -> original
    for case in cases:
        number = case.get('number', '')
        if not number:
            continue
        key = number.lower()
        if key in seen:
            print(f'WARNING: duplicate case number in cases.json: '
                  f'{seen[key]!r} and {number!r}')
        else:
            seen[key] = number


def check_duplicate_audio_hrefs(term_dir: Path) -> None:
    """Warn if any case has duplicate audio_href values across its audio entries."""
    cases_path = term_dir / 'cases.json'
    if not cases_path.exists():
        return
    cases = json.loads(cases_path.read_text(encoding='utf-8'))
    for case in cases:
        number = case.get('number', '?')
        seen: dict[str, int] = {}   # href -> first index
        for i, entry in enumerate(case.get('audio', [])):
            href = entry.get('audio_href', '')
            if not href:
                continue
            if href in seen:
                print(f'WARNING: {number}: duplicate audio_href at audio[{seen[href]}] '
                      f'and audio[{i}]: {href!r}')
            else:
                seen[href] = i


def check_cases_sync(term_dir: Path, verbose: bool = False) -> None:
    """Cross-check cases.json entries against case folders and transcript files on disk."""
    cases_path = term_dir / 'cases.json'
    cases_dir  = term_dir / 'cases'
    if not cases_path.exists():
        return

    cases = json.loads(cases_path.read_text(encoding='utf-8'))
    # Map from folder name → case for fast lookup.
    # For consolidated cases (comma-separated numbers) the folder uses the first number.
    json_numbers = {}
    for c in cases:
        raw = c.get('number', '')
        if not raw:
            continue
        json_numbers[raw] = c  # keyed by full number string for duplicate checks
    json_folders = {_case_folder(num): case for num, case in json_numbers.items()}

    # Folders present on disk.
    disk_folders: set[str] = (
        {d.name for d in cases_dir.iterdir() if d.is_dir()}
        if cases_dir.is_dir() else set()
    )

    # 1. Cases in cases.json with no matching folder.
    for number, case in sorted(json_numbers.items()):
        folder = _case_folder(number)
        if folder not in disk_folders:
            # A folder is only needed when there are local files (files > 0) or
            # an audio entry has a local text_href (not an external URL).
            has_local_text = any(
                a.get('text_href') and not a['text_href'].startswith('http')
                for a in (case.get('audio') or [])
            )
            has_content = bool(case.get('files')) or has_local_text
            if has_content or verbose:
                print(f'WARNING: {number} in cases.json but no folder at cases/{folder}/')

    # 2. Folders on disk with no matching case in cases.json.
    for folder in sorted(disk_folders):
        if folder not in json_folders:
            print(f'WARNING: cases/{folder}/ exists on disk but not in cases.json')

    # 3 & 4. Per-case transcript file cross-check.
    _DATE_JSON_RE  = re.compile(r'^\d{4}-\d{2}-\d{2}.*\.json$')
    _PART_TITLE_RE = re.compile(r'\bPart\s+(\d+)\b', re.IGNORECASE)
    _PART_FILE_RE  = re.compile(r'-(\d+)\.json$')
    for number, case in sorted(json_numbers.items()):
        folder = _case_folder(number)
        if folder not in disk_folders:
            continue  # already warned above
        case_dir = cases_dir / folder

        # text_hrefs referenced in audio objects (local files only, not URLs).
        referenced: set[str] = set()
        for audio in case.get('audio') or []:
            th = audio.get('text_href', '')
            if th and not th.startswith(('http://', 'https://')):
                referenced.add(th)
            # Check that "Part N" in title matches "-N" suffix in filename.
            title_m = _PART_TITLE_RE.search(audio.get('title', ''))
            if title_m and th and not th.startswith(('http://', 'https://')):
                expected_n = title_m.group(1)
                file_m = _PART_FILE_RE.search(th)
                actual_n = file_m.group(1) if file_m else None
                if actual_n != expected_n:
                    print(f'WARNING: {number}: title says Part {expected_n} '
                          f'but text_href {th!r} has suffix -{actual_n or "none"}')

        # Date-stamped JSON files actually present on disk.
        on_disk: set[str] = {
            f.name for f in case_dir.iterdir()
            if f.is_file() and _DATE_JSON_RE.match(f.name)
        } if case_dir.is_dir() else set()

        for fname in sorted(referenced - on_disk):
            print(f'WARNING: {number}: audio text_href {fname!r} not found on disk')
        for fname in sorted(on_disk - referenced):
            print(f'WARNING: {number}: {fname} on disk but not referenced in audio')


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args = [a for a in sys.argv[1:] if a not in ('--checkurls', '--opinions', '--verbose')]
    check_urls   = '--checkurls' in sys.argv
    opinions_only = '--opinions' in sys.argv
    verbose      = '--verbose'   in sys.argv

    if len(args) not in (1, 2):
        print(__doc__)
        sys.exit(1)

    term     = args[0]
    term_dir = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term

    if not term_dir.is_dir():
        print(f'Skipping {term}: directory not found.')
        sys.exit(0)

    check_duplicate_case_numbers(term_dir)
    check_duplicate_audio_hrefs(term_dir)
    check_cases_sync(term_dir, verbose)

    cases_path = term_dir / 'cases.json'
    if cases_path.exists():
        migrate_arguments_to_audio(cases_path)
        validate_cases_json_arguments(cases_path)
        normalize_audio_aligned_position(cases_path)
        check_decision_dates(cases_path, term)
        backfill_untracked_files(cases_path, term)
        sync_files_count(cases_path)
        if check_urls:
            check_case_hrefs(cases_path, term, opinions_only)

    raw_speaker_map = load_speaker_map()

    if len(args) == 2:
        validate_case(term_dir, args[1], check_urls, opinions_only)
        apply_speaker_map_to_case(term_dir / 'cases' / args[1], filter_speaker_map(raw_speaker_map, term))
    else:
        cases_dir = term_dir / 'cases'
        case_dirs = sorted(d for d in cases_dir.iterdir() if d.is_dir()) if cases_dir.is_dir() else []
        if not case_dirs:
            print('No case directories found.')
            return
        speaker_map = filter_speaker_map(raw_speaker_map, term)
        for d in case_dirs:
            validate_case(term_dir, d.name, check_urls, opinions_only)
            apply_speaker_map_to_case(d, speaker_map)


if __name__ == '__main__':
    main()
