#!/usr/bin/env python3
"""Validate file entries for SCOTUS cases.

Usage:
    python3 scripts/validate_cases.py TERM [CASE] [--checkurls] [--verbose]

Examples:
    python3 scripts/validate_cases.py 2025-10 24-1260
    python3 scripts/validate_cases.py 2025-10
    python3 scripts/validate_cases.py 2025-10 --checkurls
    python3 scripts/validate_cases.py 2025-10 24-1260 --checkurls
    python3 scripts/validate_cases.py 2025-10 --verbose

For each case's files.json:
  1. Checks supremecourt.gov for a slip opinion matching the case's docket number;
     if found and not already recorded, adds it to files.json as type "opinion".
  2. With --checkurls: also verifies that every href URL is reachable (HTTP HEAD
     request with GET fallback) and checks whether it can be embedded in an iframe
     by inspecting Content-Security-Policy and X-Frame-Options response headers.
     If framing is blocked, the file is downloaded locally, the original URL is saved
     as "source", and "href" is updated to the local path.
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
        case_dir = term_dir / 'cases' / case.get('number', '')
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
        files_path = term_dir / 'cases' / case.get('number', '') / 'files.json'
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


def load_speaker_map() -> list[tuple[str, str | None, str | None, str, str | None]]:
    """Load scripts/speakermap.txt -> list of (base_name, op, constraint_term, new_name, role_filter).

    LHS entries may carry a role prefix:
      JUSTICE:NAME -> NEW        (applies only when speaker role == 'justice')
    LHS entries may also carry a term constraint:
      NAME < YYYY-MM -> NEW      (applies only when term < YYYY-MM)
      NAME >= YYYY-MM -> NEW     (applies only when term >= YYYY-MM)
    Unconstrained entries always apply.
    """
    path = Path(__file__).resolve().parent / 'speakermap.txt'
    if not path.exists():
        return []
    result: list[tuple[str, str | None, str | None, str, str | None]] = []
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split('->', 1)
        if len(parts) == 2:
            lhs, new = parts[0].strip(), parts[1].strip()
            if not lhs or not new:
                continue
            if lhs.upper().startswith('JUSTICE:'):
                role_filter: str | None = 'justice'
                lhs = lhs[len('JUSTICE:'):].strip()
            else:
                role_filter = None
            m = _SPEAKERMAP_CONSTRAINT_RE.match(lhs)
            if m:
                result.append((m.group(1), m.group(2), m.group(3), new, role_filter))
            else:
                result.append((lhs, None, None, new, role_filter))
    return result


def resolve_speaker_map(entries: list[tuple[str, str | None, str | None, str, str | None]], term: str) -> dict[str, tuple[str, str | None]]:
    """Return a {base_name: (new_name, role_filter)} dict for entries applicable to the given term string."""
    result: dict[str, tuple[str, str | None]] = {}
    for base_name, op, constraint_term, new_name, role_filter in entries:
        if op is None:
            result[base_name] = (new_name, role_filter)
        elif op == '<' and term < constraint_term:  # type: ignore[operator]
            result[base_name] = (new_name, role_filter)
        elif op == '>=' and term >= constraint_term:  # type: ignore[operator]
            result[base_name] = (new_name, role_filter)
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


def apply_speaker_map_to_case(case_dir: Path, speaker_map: dict[str, str]) -> None:
    """Apply speaker name mappings to all transcript JSON files in a case directory."""
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
        for sp in (data.get('media') or {}).get('speakers') or []:
            name, role = sp.get('name', ''), sp.get('role', '')
            if not role and 'JUSTICE' in name.upper():
                sp['role'] = 'justice'
                modified = True
                continue
            entry = speaker_map.get(name)
            if entry is not None:
                new_name, role_filter = entry
                if role_filter is None or role == role_filter:
                    sp['name'] = new_name
                    modified = True
        for turn in data.get('turns') or []:
            entry = speaker_map.get(turn.get('name', ''))
            if entry is not None:
                turn['name'] = entry[0]
                modified = True
        if modified:
            json_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            print(f'  {case_dir.name}: applied speaker map to {json_path.name}')
    check_unmapped_justices(case_dir)


# ── Core validation ───────────────────────────────────────────────────────────

def validate_files_json(files_path: Path, case_dir: Path, check_urls: bool = False,
                        print_header=None) -> None:
    data = json.loads(files_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    if not check_urls:
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
            print(f'✗ UNREACHABLE ({status})')
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


def validate_case(term_dir: Path, case_number: str, check_urls: bool = False) -> None:
    files_path = term_dir / 'cases' / case_number / 'files.json'
    if not files_path.exists():
        return
    _printed = [False]
    def _print_header():
        if not _printed[0]:
            print(f'{case_number}:')
            _printed[0] = True
    validate_files_json(files_path, files_path.parent, check_urls, _print_header)
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
        key = number.lower()
        if key in seen:
            print(f'WARNING: duplicate case number in cases.json: '
                  f'{seen[key]!r} and {number!r}')
        else:
            seen[key] = number


def check_cases_sync(term_dir: Path, verbose: bool = False) -> None:
    """Cross-check cases.json entries against case folders and transcript files on disk."""
    cases_path = term_dir / 'cases.json'
    cases_dir  = term_dir / 'cases'
    if not cases_path.exists():
        return

    cases = json.loads(cases_path.read_text(encoding='utf-8'))
    json_numbers = {c.get('number', ''): c for c in cases if c.get('number')}

    # Folders present on disk.
    disk_folders: set[str] = (
        {d.name for d in cases_dir.iterdir() if d.is_dir()}
        if cases_dir.is_dir() else set()
    )

    # 1. Cases in cases.json with no matching folder.
    for number in sorted(json_numbers):
        if number not in disk_folders:
            case = json_numbers[number]
            has_content = bool(case.get('audio')) or bool(case.get('files'))
            if has_content or verbose:
                print(f'WARNING: {number} in cases.json but no folder at cases/{number}/')

    # 2. Folders on disk with no matching case in cases.json.
    for folder in sorted(disk_folders):
        if folder not in json_numbers:
            print(f'WARNING: cases/{folder}/ exists on disk but not in cases.json')

    # 3 & 4. Per-case transcript file cross-check.
    _DATE_JSON_RE = re.compile(r'^\d{4}-\d{2}-\d{2}.*\.json$')
    for number, case in sorted(json_numbers.items()):
        if number not in disk_folders:
            continue  # already warned above
        case_dir = cases_dir / number

        # text_hrefs referenced in audio objects (local files only, not URLs).
        referenced: set[str] = set()
        for audio in case.get('audio') or []:
            th = audio.get('text_href', '')
            if th and not th.startswith(('http://', 'https://')):
                referenced.add(th)

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
    args = [a for a in sys.argv[1:] if a not in ('--checkurls', '--verbose')]
    check_urls = '--checkurls' in sys.argv
    verbose    = '--verbose'    in sys.argv

    if len(args) not in (1, 2):
        print(__doc__)
        sys.exit(1)

    term     = args[0]
    term_dir = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term

    if not term_dir.is_dir():
        sys.exit(f'Error: directory not found: {term_dir}')

    check_duplicate_case_numbers(term_dir)
    check_cases_sync(term_dir, verbose)

    cases_path = term_dir / 'cases.json'
    if cases_path.exists():
        migrate_arguments_to_audio(cases_path)
        validate_cases_json_arguments(cases_path)
        normalize_audio_aligned_position(cases_path)
        sync_files_count(cases_path)

    raw_speaker_map = load_speaker_map()

    if len(args) == 2:
        validate_case(term_dir, args[1], check_urls)
        apply_speaker_map_to_case(term_dir / 'cases' / args[1], resolve_speaker_map(raw_speaker_map, term))
    else:
        cases_dir = term_dir / 'cases'
        case_dirs = sorted(d for d in cases_dir.iterdir() if d.is_dir()) if cases_dir.is_dir() else []
        if not case_dirs:
            print('No case directories found.')
            return
        speaker_map = resolve_speaker_map(raw_speaker_map, term)
        for d in case_dirs:
            validate_case(term_dir, d.name, check_urls)
            apply_speaker_map_to_case(d, speaker_map)


if __name__ == '__main__':
    main()
