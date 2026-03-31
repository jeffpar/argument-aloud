#!/usr/bin/env python3
"""Validate file entries for SCOTUS cases.

Usage:
    python3 scripts/validate_cases.py TERM [CASE] [--checkurls]

Examples:
    python3 scripts/validate_cases.py 2025-10 24-1260
    python3 scripts/validate_cases.py 2025-10
    python3 scripts/validate_cases.py 2025-10 --checkurls
    python3 scripts/validate_cases.py 2025-10 24-1260 --checkurls

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
    print(f'  Fetching opinions index: {url}')
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
    print(f'    Found {len(opinions)} opinion(s) for term year {year_2digit}.')
    return opinions


def check_opinion_for_case(files_path: Path, case_number: str, term: str) -> None:
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
        print(f'    Opinion: already present — skipped.')
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
    print(f'    Opinion: added "{new_entry["title"]}" ({opinion["date"]}, J. {opinion["author"]})')


# ── Core validation ───────────────────────────────────────────────────────────

def validate_files_json(files_path: Path, case_dir: Path, check_urls: bool = False) -> None:
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
            print(f'  [{file_num}] already localized — skipped.')
            continue

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
    files_path = term_dir / case_number / 'files.json'
    if not files_path.exists():
        print(f'{case_number}: no files.json — skipped.')
        return
    print(f'{case_number}:')
    validate_files_json(files_path, files_path.parent, check_urls)
    check_opinion_for_case(files_path, case_number, term_dir.name)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    args = [a for a in sys.argv[1:] if a != '--checkurls']
    check_urls = '--checkurls' in sys.argv

    if len(args) not in (1, 2):
        print(__doc__)
        sys.exit(1)

    term     = args[0]
    term_dir = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term

    if not term_dir.is_dir():
        sys.exit(f'Error: directory not found: {term_dir}')

    if len(args) == 2:
        validate_case(term_dir, args[1], check_urls)
    else:
        case_dirs = sorted(d for d in term_dir.iterdir() if d.is_dir())
        if not case_dirs:
            print('No case directories found.')
            return
        for d in case_dirs:
            validate_case(term_dir, d.name, check_urls)


if __name__ == '__main__':
    main()
