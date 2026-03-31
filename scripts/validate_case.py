#!/usr/bin/env python3
"""Validate files.json entries for SCOTUS cases.

Usage:
    python3 scripts/validate_case.py TERM [CASE]

Examples:
    python3 scripts/validate_case.py 2025-10 24-1260
    python3 scripts/validate_case.py 2025-10

For each file entry in files.json:
  1. Checks that the href URL is reachable (HTTP HEAD request, with GET fallback).
  2. Checks whether the URL can be embedded in an iframe by inspecting
     Content-Security-Policy (frame-ancestors) and X-Frame-Options response headers.
     If framing is blocked, downloads the file to the case directory,
     saves the original URL as "source", and updates "href" to the local filename.
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


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


# ── Core validation ───────────────────────────────────────────────────────────

def validate_files_json(files_path: Path, case_dir: Path) -> None:
    data = json.loads(files_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
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
                entry['href'] = dest.name
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


def validate_case(term_dir: Path, case_number: str) -> None:
    files_path = term_dir / case_number / 'files.json'
    if not files_path.exists():
        print(f'{case_number}: no files.json — skipped.')
        return
    print(f'{case_number}:')
    validate_files_json(files_path, files_path.parent)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    if len(sys.argv) not in (2, 3):
        print(__doc__)
        sys.exit(1)

    term     = sys.argv[1]
    term_dir = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term

    if not term_dir.is_dir():
        sys.exit(f'Error: directory not found: {term_dir}')

    if len(sys.argv) == 3:
        validate_case(term_dir, sys.argv[2])
    else:
        case_dirs = sorted(d for d in term_dir.iterdir() if d.is_dir())
        if not case_dirs:
            print('No case directories found.')
            return
        for d in case_dirs:
            validate_case(term_dir, d.name)


if __name__ == '__main__':
    main()
