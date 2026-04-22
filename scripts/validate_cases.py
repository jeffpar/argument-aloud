#!/usr/bin/env python3
"""Validate file entries and case metadata for SCOTUS cases.

Usage:
    python3 scripts/validate_cases.py TERM [CASE] [--checkurls] [--opinions] [--verbose] [--dry-run]

Examples:
    python3 scripts/validate_cases.py 2025-10 24-1260
    python3 scripts/validate_cases.py 2025-10
    python3 scripts/validate_cases.py 2025-10 --checkurls
    python3 scripts/validate_cases.py 2025-10 24-1260 --checkurls
    python3 scripts/validate_cases.py 2025-10 --checkurls --opinions
    python3 scripts/validate_cases.py 2025-10 --verbose
    python3 scripts/validate_cases.py 2025-10 --dry-run

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

With --dry-run:
  Report discrepancies in audio dates / argument / decision fields without
  writing any changes to cases.json.
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
from schema import reorder_event

REPO_ROOT    = Path(__file__).resolve().parent.parent
SCOTUS_BASE  = 'https://www.supremecourt.gov'

_OPINIONS_CACHE: dict = {}  # year_2digit -> {docket_lower: {date, name, author, href}}
_VERBOSE: bool = False

# Wayback Machine CDX search API endpoint and a regex that strips the
# Wayback timestamp prefix from href attributes so the opinions regex below
# can match the original supremecourt.gov path unchanged.
_WAYBACK_CDX_URL   = 'https://web.archive.org/cdx/search/cdx'
_WAYBACK_PREFIX_RE = re.compile(r'/web/\d{14}/https?://www\.supremecourt\.gov')

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

def _wayback_pdf_url(pdf_url: str, max_ts: str = '') -> str:
    """Return a Wayback Machine URL for *pdf_url*, or '' if none is found.

    Queries the CDX API for any 200-status snapshot of the given URL.
    If *max_ts* is given (a 14-digit CDX timestamp string, e.g. '20161001000000'),
    only snapshots taken before that date are considered.
    """
    cdx_api = (
        f'{_WAYBACK_CDX_URL}'
        f'?url={urllib.parse.quote(pdf_url, safe="")}'
        f'&output=json&limit=1&statuscode=200&fl=timestamp'
    )
    if max_ts:
        cdx_api += f'&to={max_ts}'
    try:
        req = urllib.request.Request(cdx_api, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            rows = json.loads(resp.read().decode('utf-8', errors='replace'))
    except Exception:
        return ''
    # rows = [['timestamp'], ['20180601123456']] or just [[header]] if empty
    if len(rows) < 2:
        return ''
    ts = rows[1][0]
    return f'https://web.archive.org/web/{ts}/{pdf_url}'


def _fix_dead_opinion_pdf_hrefs(opinions: dict) -> dict:
    """For opinions whose base PDF URL returns 404, substitute a Wayback URL.

    Many opinions share the same base PDF (e.g. a preliminary-print volume);
    each unique base URL is checked only once.  The #page=N fragment (if any)
    is preserved when constructing the Wayback URL.
    """
    # Map base_url -> replacement ('' means still live, keep as-is).
    replacements: dict[str, str] = {}
    for op in opinions.values():
        href = op['href']
        base = href.split('#')[0]
        if base not in replacements:
            ok, _ = check_url(base)
            if ok:
                replacements[base] = base   # still live
            else:
                wb = _wayback_pdf_url(base)
                if wb:
                    print(f'    PDF 404 — using Wayback: {base}')
                replacements[base] = wb     # may be '' if not archived

    result: dict = {}
    for docket, op in opinions.items():
        href  = op['href']
        base  = href.split('#')[0]
        frag  = href[len(base):]            # '' or '#page=N'
        new_base = replacements.get(base, base)
        if new_base and new_base != base:
            result[docket] = dict(op, href=new_base + frag)
        else:
            result[docket] = op
    return result


def _fetch_opinions(year_2digit: str) -> dict:
    """Fetch and parse the SCOTUS slip-opinions index for a 2-digit term year.

    Returns a dict keyed by lowercase docket number, e.g.
        {'24-539': {'date': '2026-03-31', 'name': 'Chiles v. Salazar',
                    'author': 'NG', 'href': 'https://…/24-539_xxx.pdf'}}
    """
    if year_2digit in _OPINIONS_CACHE:
        return _OPINIONS_CACHE[year_2digit]

    url = f'{SCOTUS_BASE}/opinions/slipopinion/{year_2digit}'
    if _VERBOSE:
        print(f'Fetching opinions index: {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    html = ''
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode('utf-8', errors='replace')
    except Exception as exc:
        print(f'    Warning: could not fetch opinions index: {exc}')

    # Each opinion row: date | docket (white-space:nowrap) | name<a>…</a> | J.
    # The href may include a #page=N fragment (e.g. preliminaryprint PDFs).
    pattern = re.compile(
        r'<td[^>]*>(\d{1,2}/\d{1,2}/\d{2})</td>\s*'
        r'<td[^>]*white-space[^>]*>([^<]+)</td>\s*'
        r'<td[^>]*><a href=.(/opinions/[^\s\'">]+)[^>]*>([^<]+)</a>'
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

    # If the live page yielded no opinions, try the Wayback Machine as a
    # fallback.  This handles terms 2016-10 and earlier, where supremecourt.gov
    # no longer serves the slip-opinions index.
    if not opinions:
        opinions = _fetch_opinions_via_wayback(year_2digit)
    else:
        # The live page may link to PDF files that are themselves no longer
        # hosted (e.g. superseded preliminary-print volumes).  Check each
        # unique base PDF URL (fragment stripped) and swap in a Wayback
        # archive URL for any that return 404.
        opinions = _fix_dead_opinion_pdf_hrefs(opinions)

    _OPINIONS_CACHE[year_2digit] = opinions
    if _VERBOSE:
        full_year = str(2000 + int(year_2digit))
        print(f'  Found {len(opinions)} opinion(s) for term year {full_year}.')
    return opinions


def _fetch_opinions_via_wayback(year_2digit: str) -> dict:
    """Fetch the SCOTUS slip-opinions index via the Wayback Machine.

    Used as a fallback for terms where the live supremecourt.gov page is no
    longer available (2016-10 and earlier).  Queries the CDX API for the
    earliest snapshot between July 1 and September 30 of the year following
    the term start — after all opinions have been issued but before the next
    term begins.

    Opinion hrefs are returned as original supremecourt.gov URLs
    (e.g. https://www.supremecourt.gov/opinions/15pdf/…pdf).  These may or
    may not still be live; validate_cases --checkurls will flag broken ones.
    """
    year_int = 2000 + int(year_2digit)
    # Window: July 1 – September 30 of the year following the term start.
    # All opinions for a term are typically issued by late June; capping at
    # September 30 ensures we don't pick up a snapshot from the next term.
    min_date     = f'{year_int + 1}0701'
    max_date     = f'{year_int + 1}0930235959'
    opinions_url = f'{SCOTUS_BASE}/opinions/slipopinion/{year_2digit}'

    # Query the CDX API for the first available 200-status snapshot in the window.
    cdx_api = (
        f'{_WAYBACK_CDX_URL}'
        f'?url={urllib.parse.quote(opinions_url, safe="")}'
        f'&output=json&from={min_date}&to={max_date}&limit=5&statuscode=200'
    )
    if _VERBOSE:
        print(f'  Querying Wayback CDX: {cdx_api}')
    try:
        req = urllib.request.Request(cdx_api, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            cdx_rows = json.loads(resp.read().decode('utf-8', errors='replace'))
    except Exception as exc:
        print(f'    Warning: Wayback CDX query failed: {exc}')
        return {}

    # cdx_rows = [[header_cols], [row1_cols], ...]; first row is the header.
    if len(cdx_rows) < 2:
        if _VERBOSE:
            print(f'  No Wayback snapshot found for slipopinion/{year_2digit} in {min_date[:8]}–{max_date[:8]}.')
        return {}

    # Locate the 'timestamp' column (usually index 1).
    header = cdx_rows[0]
    ts_idx = header.index('timestamp') if 'timestamp' in header else 1
    snapshot_ts  = cdx_rows[1][ts_idx]
    snapshot_url = f'https://web.archive.org/web/{snapshot_ts}/{opinions_url}'

    if _VERBOSE:
        print(f'  Fetching Wayback snapshot: {snapshot_url}')
    else:
        print(f'Fetching Wayback snapshot ({snapshot_ts[:8]}) for slipopinion/{year_2digit} ...')
    try:
        req = urllib.request.Request(snapshot_url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode('utf-8', errors='replace')
    except Exception as exc:
        print(f'    Warning: could not fetch Wayback snapshot {snapshot_url}: {exc}')
        return {}

    # Wayback rewrites hrefs from "/opinions/…pdf" to
    # "/web/TIMESTAMP/https://www.supremecourt.gov/opinions/…pdf".
    # Strip the Wayback prefix so the path-extraction regex works, then
    # reconstruct hrefs as Wayback URLs so the PDFs are actually reachable
    # (the original supremecourt.gov paths for old terms return 404).
    wayback_base = f'https://web.archive.org/web/{snapshot_ts}/https://www.supremecourt.gov'
    html = _WAYBACK_PREFIX_RE.sub('', html)

    # Post-2016 SCOTUS site layout: docket cell has white-space:nowrap style
    # and the name cell may have style attributes.
    _pattern_new = re.compile(
        r'<td[^>]*>(\d{1,2}/\d{1,2}/\d{2})</td>\s*'
        r'<td[^>]*white-space[^>]*>([^<]+)</td>\s*'
        r'<td[^>]*><a href=.(/opinions/[^\s\'">]+)[^>]*>([^<]+)</a>'
        r'.*?<td[^>]*>(\w+)</td>',
        re.DOTALL,
    )
    # Pre-2017 SCOTUS site layout (2012–2016 terms): rows have 7 cells
    # (R#, Date, Docket, Name, Revised, J., Pt.).  The docket cell uses
    # text-align:center and the name cell is a bare <td> (no attributes).
    _pattern_old = re.compile(
        r'<td[^>]*>(\d{1,2}/\d{1,2}/\d{2})</td>\s*'
        r'<td[^>]*>([^<]+)</td>\s*'
        r'<td><a[^>]*href=.(/opinions/[^\s\'">]+)[^>]*>([^<]+)</a>'
        r'.*?<td[^>]*>(\w+)</td>',
        re.DOTALL,
    )

    def _parse_opinions(pattern: re.Pattern) -> dict:
        result: dict = {}
        for m in pattern.finditer(html):
            date_raw, docket, href, name, author = (g.strip() for g in m.groups())
            try:
                date_iso = datetime.datetime.strptime(date_raw, '%m/%d/%y').strftime('%Y-%m-%d')
            except ValueError:
                date_iso = date_raw
            result[docket.lower()] = {
                'date':   date_iso,
                'name':   name,
                'author': author,
                'href':   wayback_base + href,
            }
        return result

    opinions = _parse_opinions(_pattern_new)
    if not opinions:
        opinions = _parse_opinions(_pattern_old)

    print(f'Found {len(opinions)} opinion(s) via Wayback for {year_int}-10 term.')
    return opinions


def check_opinion_for_case(files_path: Path, case_number: str, term: str,
                           print_header=None) -> None:
    """If a slip opinion exists for this case, add it to files.json."""
    # Slip opinions via supremecourt.gov are available from 2018-10 onward;
    # earlier terms are handled via the Wayback Machine fallback in
    # _fetch_opinions_via_wayback().  Skip only truly ancient terms.
    try:
        if int(term.split('-')[0]) < 2012:
            return
    except (ValueError, IndexError):
        pass
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


def validate_cases_json_arguments(cases_path: Path, term: str = '', dry_run: bool = False) -> None:
    """Add/update 'source', 'type', and 'aligned' at the top of each audio object in cases.json."""
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    term_dir = cases_path.parent
    modified = False
    for case in data:
        label = case.get('number') or case.get('id', '?')
        case_dir = term_dir / 'cases' / _case_folder(case.get('number', '') or case.get('id', ''))
        case_modified = False
        for i, arg in enumerate(case.get('events', [])):
            audio_href = arg.get('audio_href', '')
            if not audio_href:
                continue

            source, inferred_type = _detect_source_type(audio_href)

            # Preserve any explicitly recorded source/type; only fall back to
            # URL-inferred values when the key is absent entirely.
            source   = arg.get('source')   or source
            type_val = arg.get('type')     or inferred_type

            text_href = arg.get('text_href', '')
            is_aligned = bool(
                text_href and _is_transcript_aligned(term_dir / 'cases' / text_href)
            )

            current_aligned = arg.get('aligned')  # True, False, or absent (None)
            desired_aligned  = True if is_aligned else None  # None → remove key

            if (arg.get('source') == source and arg.get('type') == type_val
                    and current_aligned == desired_aligned):
                continue  # already correct, leave untouched

            # Rebuild with source + type (+ aligned if set), in canonical order.
            rebuilt = dict(arg)
            rebuilt['source'] = source
            rebuilt['type']   = type_val
            if is_aligned:
                rebuilt['aligned'] = True
            else:
                rebuilt.pop('aligned', None)
            new_arg = reorder_event(rebuilt)
            case['events'][i] = new_arg
            modified = True
            case_modified = True

        if case_modified:
            print(f' NOTICE: {term}/{label}: set aligned on audio file(s)')

    if modified and not dry_run:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
    else:
        pass  # no changes needed


def normalize_audio_aligned_position(cases_path: Path) -> None:
    """Ensure 'aligned' is the last key in every audio object that has it."""
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    modified = False
    for case in data:
        for arg in case.get('events', []):
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


# ── Remove redundant transcript file entries ──────────────────────────────────

def remove_redundant_transcript_files(cases_path: Path) -> None:
    """For each case, ensure every transcript entry in files.json is represented
    as a transcript_href in a matching audio object, creating the audio object if
    necessary.  Then remove the now-redundant file entry, renumbering subsequent
    entries to close any gap; delete files.json if it becomes empty.
    """
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    term_dir = cases_path.parent
    cases_modified = False

    for case in data:
        folder_name = _case_folder(case.get('number', '') or case.get('id', ''))
        files_path = term_dir / 'cases' / folder_name / 'files.json'
        if not files_path.exists():
            continue

        files = json.loads(files_path.read_text(encoding='utf-8'))
        if not isinstance(files, list):
            continue

        # Identify transcript file entries that need to be promoted to an audio
        # object (or merged into one) before being removed from files.json.
        transcript_file_entries = [
            f for f in files if f.get('type') == 'transcript'
        ]
        if not transcript_file_entries:
            continue

        label = case.get('number') or case.get('id', '?')
        audio_list: list[dict] = case.setdefault('events', [])
        audio_modified = False

        for tf in transcript_file_entries:
            tf_href = tf.get('href', '')
            tf_date = tf.get('date', '')
            if not tf_href or not tf_date:
                continue

            # Find an existing audio object for this date.
            matched = next((a for a in audio_list if a.get('date') == tf_date), None)
            if matched is not None:
                if not matched.get('transcript_href'):
                    raw_title = tf.get('title', '')
                    arg_title = re.sub(r'^Transcript of\s+', '', raw_title).strip() or raw_title
                    # Rebuild the audio object inserting title (if missing) and
                    # transcript_href just before any trailing keys, so the key
                    # order reads naturally.
                    rebuilt: dict = {}
                    for k, v in matched.items():
                        rebuilt[k] = v
                    if not matched.get('title') and arg_title:
                        rebuilt['title'] = arg_title
                    rebuilt['transcript_href'] = tf_href
                    matched.clear()
                    matched.update(rebuilt)
                    print(f'  {label} ({tf_date}): added transcript_href to existing audio object')
                    audio_modified = True
                elif not matched.get('title'):
                    # transcript_href already present but title is missing — fill it in
                    # before files.json gets deleted so the title isn't lost.
                    raw_title = tf.get('title', '')
                    arg_title = re.sub(r'^Transcript of\s+', '', raw_title).strip() or raw_title
                    if arg_title:
                        rebuilt = {}
                        for k, v in matched.items():
                            rebuilt[k] = v
                            if k == 'date':
                                rebuilt['title'] = arg_title
                        if 'title' not in rebuilt:
                            rebuilt['title'] = arg_title
                        matched.clear()
                        matched.update(rebuilt)
                        audio_modified = True
            else:
                # Build the title by stripping the "Transcript of " prefix so
                # it reads as an argument title, e.g. "Oral Argument on …"
                raw_title = tf.get('title', '')
                arg_title = re.sub(r'^Transcript of\s+', '', raw_title).strip() or raw_title
                new_audio: dict = {}
                new_audio['source'] = 'ussc'
                new_audio['type']   = 'argument'
                new_audio['title']  = arg_title
                new_audio['date']   = tf_date
                new_audio['transcript_href'] = tf_href
                audio_list.append(new_audio)
                # Re-sort by date.
                case['events'] = sorted(audio_list, key=lambda a: a.get('date') or '')
                audio_list = case['events']
                print(f'  {label} ({tf_date}): created audio object with transcript_href')
                audio_modified = True

        if audio_modified:
            cases_modified = True

        # Now collect all (href, date) pairs covered by audio objects.
        audio_transcripts: set[tuple[str, str]] = {
            (a.get('transcript_href', ''), a.get('date', ''))
            for a in audio_list
            if a.get('transcript_href') and a.get('date')
        }

        # Find redundant entries: type='transcript' whose (href, date) matches.
        to_remove = [
            f for f in files
            if f.get('type') == 'transcript'
            and (f.get('href', ''), f.get('date', '')) in audio_transcripts
        ]

        if not to_remove:
            continue

        remove_file_ids = {f['file'] for f in to_remove if 'file' in f}

        # Build updated list: skip removed entries, renumber to close gaps.
        new_files = []
        gap = 0
        for f in files:
            fid = f.get('file')
            if fid is not None and fid in remove_file_ids:
                gap += 1
                continue
            if gap and fid is not None:
                f = dict(f)
                f['file'] = fid - gap
            new_files.append(f)

        if new_files:
            files_path.write_text(
                json.dumps(new_files, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
        else:
            files_path.unlink()
            # Remove the case folder too if it is now empty.
            case_dir = files_path.parent
            remaining = [p for p in case_dir.iterdir() if not p.name.startswith('.')]
            if not remaining:
                case_dir.rmdir()

        removed_count = len(to_remove)
        print(f'  {label}: removed {removed_count} redundant transcript file '
              f'entr{"y" if removed_count == 1 else "ies"} from files.json'
              + ('' if new_files else ' (files.json deleted)'))

        case['files'] = len(new_files)
        cases_modified = True

    if cases_modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )


# ── Speaker map cleanup ───────────────────────────────────────────────────────

_SPEAKERS_PATH = Path(__file__).resolve().parent / 'speakers.json'
_SPEAKERMAP_CONSTRAINT_RE = re.compile(r'^(.*?)\s+(>=|<)\s+(\d{4}-\d{2})$')


def _build_justice_rename_entries() -> list[tuple]:
    """Return speaker-map entries derived from justices.json for renaming
    formal/alternate justice names to their canonical form.

    Each entry has the shape expected by apply_speaker_map_to_case:
      (base_name, op, constraint_term, new_name, role_filter, new_role)
    where role_filter='justice' ensures only speakers with that role are renamed.
    """
    path = Path(__file__).resolve().parent / 'justices.json'
    if not path.exists():
        return []
    data: dict = json.loads(path.read_text(encoding='utf-8'))
    entries: list[tuple] = []
    for canonical, info in data.items():
        u = canonical.upper()
        for alt in info.get('alternates') or []:
            a = alt.upper()
            if a != u:
                entries.append((a, None, None, u, 'justice', None))
    return entries



def load_speaker_map() -> list[tuple[str, str | None, str | None, str, str | None, str | None]]:
    """Load scripts/speakers.json -> list of (base_name, op, constraint_term, new_name, role_filter, new_role).

    Emits unconditional entries from the 'typos' and 'rename' sections.
    Entries are ordered; the first matching entry for each speaker wins.
    """
    if not _SPEAKERS_PATH.exists():
        return []
    data: dict = json.loads(_SPEAKERS_PATH.read_text(encoding='utf-8'))
    result: list[tuple[str, str | None, str | None, str, str | None, str | None]] = []
    for raw, corrected in (data.get('typos') or {}).items():
        result.append((raw.upper(), None, None, corrected.upper(), None, None))
    for old, new in (data.get('rename') or {}).items():
        result.append((old.upper(), None, None, new.upper(), None, None))
    return result


def filter_speaker_map(
    entries: list[tuple[str, str | None, str | None, str, str | None, str | None]],
    term: str,
) -> list[tuple[str, str | None, str | None, str, str | None, str | None]]:
    """Return an ordered list of entries applicable to the given term string.

    Preserves entry order so that the first matching entry for each speaker wins.
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


def check_case_hrefs(cases_path: Path, term: str, opinions_only: bool = False) -> None:
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
            for entry in case.get('events') or []:
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


def backfill_untracked_files(cases_path: Path, term: str, dry_run: bool = False) -> None:
    """Add files.json entries for files in case folders not yet listed.

    Skips files.json itself, hidden files, .json transcript files, and .mp3
    files (audio is tracked exclusively via audio objects in cases.json).
    When dry_run is True, prints warnings instead of writing any changes.
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
            if fpath.suffix in ('.json', '.mp3'):
                continue
            if fpath.name in tracked:
                continue

            if dry_run:
                print(f'  WARNING: {folder_name}: untracked file {fpath.name!r} may need to be added to files.json')
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


def sync_opinion_href_from_files(cases_path: Path) -> None:
    """For each case that lacks opinion_href, check its files.json for an entry
    with type 'opinion' and, if found, insert opinion_href before 'files'."""
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    term_dir = cases_path.parent
    modified = False

    for case in data:
        if case.get('opinion_href'):
            continue  # already set

        folder_name = _case_folder(case.get('number', '') or case.get('id', ''))
        if not folder_name:
            continue
        files_path = term_dir / 'cases' / folder_name / 'files.json'
        if not files_path.exists():
            continue

        try:
            files_data = json.loads(files_path.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(files_data, list):
            continue

        opinion_entry = next((e for e in files_data if e.get('type') == 'opinion'), None)
        if not opinion_entry or not opinion_entry.get('href'):
            continue

        href = opinion_entry['href']
        # Insert opinion_href immediately before 'files' (or at end if 'files' absent).
        new_case: dict = {}
        inserted = False
        for k, v in case.items():
            if k == 'files' and not inserted:
                new_case['opinion_href'] = href
                inserted = True
            new_case[k] = v
        if not inserted:
            new_case['opinion_href'] = href

        case.clear()
        case.update(new_case)
        modified = True
        label = case.get('number') or case.get('id', '?')
        print(f'  {label}: inserted opinion_href from files.json')

    if modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )


# ── Audio date / argument / decision consistency ──────────────────────────────

def _is_current_term(term: str) -> bool:
    """Return True if today falls within the given term's period.

    A term 'YYYY-MM' covers [YYYY-MM-01, (YYYY+1)-MM-01).
    """
    try:
        year  = int(term.split('-')[0])
        month = int(term.split('-')[1])
        term_start = datetime.date(year,     month, 1)
        term_end   = datetime.date(year + 1, month, 1)
        return term_start <= datetime.date.today() < term_end
    except (ValueError, IndexError):
        return False


def _insert_key_before(case: dict, new_key: str, new_val, *, before: str) -> None:
    """Insert new_key=new_val into case immediately before `before` key (or append)."""
    new_case: dict = {}
    inserted = False
    for k, v in case.items():
        if k == before and not inserted:
            new_case[new_key] = new_val
            inserted = True
        new_case[k] = v
    if not inserted:
        new_case[new_key] = new_val
    case.clear()
    case.update(new_case)


def check_audio_dates(cases_path: Path, term: str, dry_run: bool = False) -> None:
    """Verify audio object dates are consistent with case-level argument/decision fields.

    For argument audio objects:
      - Warns if an audio object lacks a date.
      - Computes the expected 'argument' value: unique dates sorted chronologically,
        joined with ',' (no spaces).
      - Prints a notice/warning if the case's 'argument' property differs.
      - Unless dry_run, updates (or inserts) 'argument' to match.

    For reargument audio objects:
      - Same as argument, but targets the 'reargument' property, inserted after
        'argument'.

    For opinion audio objects:
      - Warns if an audio object lacks a date.
      - Prints a notice if the audio date differs from the case's 'decision'.
      - Unless dry_run, updates (or inserts) 'decision' to match the audio date.
        (check_decision_dates will then fix dateDecision on the next pass.)
    """
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    modified = False
    for case in data:
        label = case.get('number') or case.get('id', '?')
        title = case.get('title', '')

        arg_audio_dates:      list[str] = []
        rearg_audio_dates:    list[str] = []
        opinion_audio_dates:  list[str] = []

        for i, audio in enumerate(case.get('events') or []):
            atype = audio.get('type', '')
            date  = audio.get('date', '')

            if atype == 'argument':
                if not date:
                    print(f'WARNING: {term}/{label} ({title[:40]}): '
                          f'audio[{i}] (argument) missing date')
                else:
                    arg_audio_dates.append(date)

            elif atype == 'reargument':
                if not date:
                    print(f'WARNING: {term}/{label} ({title[:40]}): '
                          f'audio[{i}] (reargument) missing date')
                else:
                    rearg_audio_dates.append(date)

            elif atype == 'opinion':
                if not date:
                    print(f'WARNING: {term}/{label} ({title[:40]}): '
                          f'audio[{i}] (opinion) missing date')
                else:
                    opinion_audio_dates.append(date)

        # ── argument property ──────────────────────────────────────────────
        if arg_audio_dates:
            audio_set     = set(arg_audio_dates)
            current       = case.get('argument', '')
            current_dates = set(current.split(',')) if current else set()
            if not (audio_set <= current_dates):
                expected = ','.join(sorted(current_dates | audio_set))
                prefix = 'WARNING' if (current and not (current_dates & audio_set)) else ' NOTICE'
                print(f'{prefix}: {term}/{label} ({title[:40]}): '
                      f'argument={current!r} → should be {expected!r}')
                if not dry_run:
                    if 'argument' in case:
                        case['argument'] = expected
                    else:
                        _insert_key_before(case, 'argument', expected, before='decision')
                    modified = True

        # ── reargument property ────────────────────────────────────────────
        if rearg_audio_dates:
            audio_set     = set(rearg_audio_dates)
            current       = case.get('reargument', '')
            current_dates = set(current.split(',')) if current else set()
            if not (audio_set <= current_dates):
                expected = ','.join(sorted(current_dates | audio_set))
                prefix = 'WARNING' if (current and not (current_dates & audio_set)) else ' NOTICE'
                print(f'{prefix}: {term}/{label} ({title[:40]}): '
                      f'reargument={current!r} → should be {expected!r}')
                if not dry_run:
                    if 'reargument' in case:
                        case['reargument'] = expected
                    else:
                        if 'argument' in case:
                            # Insert immediately after 'argument'.
                            new_case: dict = {}
                            for k, v in case.items():
                                new_case[k] = v
                                if k == 'argument':
                                    new_case['reargument'] = expected
                            case.clear()
                            case.update(new_case)
                        else:
                            _insert_key_before(case, 'reargument', expected, before='decision')
                    modified = True

        # ── decision property (from opinion audio) ─────────────────────────
        if opinion_audio_dates:
            unique_opinion = sorted(set(opinion_audio_dates))
            if len(unique_opinion) > 1:
                print(f'WARNING: {term}/{label} ({title[:40]}): '
                      f'multiple distinct opinion audio dates: {unique_opinion}')
            expected = unique_opinion[0]
            current  = case.get('decision', '')
            if current != expected:
                prefix = 'WARNING' if current else ' NOTICE'
                print(f'{prefix}: {term}/{label} ({title[:40]}): '
                      f'decision={current!r} → should be {expected!r} (from opinion audio)')
                if not dry_run:
                    if 'decision' in case:
                        case['decision'] = expected
                    else:
                        _insert_key_before(case, 'decision', expected, before='volume')
                    modified = True

    if modified:
        cases_path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print('Updated cases.json: fixed argument/decision dates from audio.')


def warn_missing_opinion_href(cases_path: Path, term: str) -> None:
    """Warn about cases without opinion_href when the term is not the current term."""
    if _is_current_term(term):
        return

    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    for case in data:
        if case.get('opinion_href'):
            continue
        label = case.get('number') or case.get('id', '?')
        title = case.get('title', '')
        print(f' NOTICE: {term}/{label} ({title[:40]}): no opinion_href')


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


def deduplicate_cases(cases_path: Path) -> None:
    """Detect and merge duplicate case entries where a stub entry's number is a
    component of a more-complete entry's comma-separated number.

    Steps for each (complete, stub) pair:
      1. Clean the stub's files.json: remove any transcript file entries whose
         href is already expressed in an audio object's transcript_href (the
         virtual-file mechanism means storing them in files.json is redundant).
         Delete files.json if it becomes empty, then delete the stub's folder
         if it contains nothing else.
      2. Merge the stub's audio objects into the complete case:
           - If the complete case already has an audio entry for the same date,
             copy any missing transcript_href across.
           - If no matching audio entry exists, append the stub's entry.
      3. Merge any remaining files.json entries from the stub into the complete
         case's files.json (deduped by href).
      4. Remove the stub from cases.json.
    """
    data = json.loads(cases_path.read_text(encoding='utf-8'))
    if not isinstance(data, list):
        return

    term_dir = cases_path.parent

    def _is_stub(c: dict) -> bool:
        """True if this entry has no id/votes and only transcript-only audio."""
        if c.get('id') or c.get('votes'):
            return False
        return all(
            not a.get('audio_href') and a.get('transcript_href')
            for a in c.get('events', [])
        )

    # Map each individual number component → index of the first case containing it.
    comp_to_idx: dict[str, int] = {}
    duplicates: list[tuple[int, int]] = []  # (complete_idx, stub_idx)
    for i, case in enumerate(data):
        raw = case.get('number', '')
        if not raw:
            continue
        for part in (p.strip() for p in raw.split(',') if p.strip()):
            if part in comp_to_idx:
                other_idx = comp_to_idx[part]
                other = data[other_idx]
                if _is_stub(case) and not _is_stub(other):
                    duplicates.append((other_idx, i))
                elif _is_stub(other) and not _is_stub(case):
                    duplicates.append((i, other_idx))
                else:
                    print(f'WARNING: {raw!r} and {other.get("number")!r} share '
                          f'component {part!r} but neither is clearly a stub — skipping')
            else:
                comp_to_idx[part] = i

    if not duplicates:
        return

    processed_stubs: set[int] = set()
    to_remove: set[int] = set()
    for complete_idx, stub_idx in duplicates:
        if stub_idx in processed_stubs:
            continue
        processed_stubs.add(stub_idx)

        complete = data[complete_idx]
        stub     = data[stub_idx]
        label    = complete.get('number') or complete.get('id', '?')
        stub_num = stub.get('number') or stub.get('id', '?')

        stub_folder = _case_folder(stub.get('number', '') or stub.get('id', ''))
        stub_dir    = term_dir / 'cases' / stub_folder
        stub_files_path = stub_dir / 'files.json'

        # ── Step 1: clean stub's files.json of redundant transcript entries ──
        if stub_files_path.exists():
            stub_files = json.loads(stub_files_path.read_text(encoding='utf-8'))
            if isinstance(stub_files, list):
                audio_transcript_hrefs: set[str] = {
                    a['transcript_href']
                    for a in stub.get('events', [])
                    if a.get('transcript_href')
                }
                cleaned = [
                    f for f in stub_files
                    if not (f.get('type') == 'transcript'
                            and f.get('href') in audio_transcript_hrefs)
                ]
                if len(cleaned) < len(stub_files):
                    if cleaned:
                        stub_files_path.write_text(
                            json.dumps(cleaned, indent=2, ensure_ascii=False) + '\n',
                            encoding='utf-8',
                        )
                    else:
                        stub_files_path.unlink()
                    stub_files = cleaned
                    print(f'  {stub_num}: cleaned redundant transcript entries from files.json')

        # ── Step 2: merge stub audio into complete case ───────────────────────
        comp_audio: list[dict] = complete.setdefault('events', [])
        for stub_audio in stub.get('events', []):
            date             = stub_audio.get('date')
            transcript_href  = stub_audio.get('transcript_href')

            # Look for a matching entry in the complete case (same date).
            matched_comp = next(
                (a for a in comp_audio if a.get('date') == date),
                None,
            )
            if matched_comp is not None:
                if transcript_href and not matched_comp.get('transcript_href'):
                    matched_comp['transcript_href'] = transcript_href
                    print(f'  {label} ({date}): merged transcript_href from stub {stub_num}')
                elif (transcript_href
                      and matched_comp.get('transcript_href') != transcript_href):
                    # Same date but a different transcript — this is a distinct
                    # argument entry; append rather than overwrite.
                    entry = dict(stub_audio)
                    if not entry.get('title') and transcript_href:
                        stub_files_now = []
                        if stub_files_path.exists():
                            try:
                                stub_files_now = json.loads(stub_files_path.read_text(encoding='utf-8'))
                            except Exception:
                                pass
                        tf_match = next(
                            (f for f in stub_files_now
                             if f.get('type') == 'transcript'
                             and f.get('href') == transcript_href),
                            None,
                        )
                        if tf_match:
                            raw_t = tf_match.get('title', '')
                            entry['title'] = re.sub(r'^Transcript of\s+', '', raw_t).strip() or raw_t
                    comp_audio.append(entry)
                    print(f'  {label} ({date}): appended distinct transcript audio from stub {stub_num}')
            else:
                # Truly unique audio entry — append it to the complete case.
                # If the stub entry lacks a title, derive one from the matching
                # transcript file entry in the stub's files.json.
                entry = dict(stub_audio)
                if not entry.get('title') and transcript_href:
                    stub_files_now = []
                    if stub_files_path.exists():
                        try:
                            stub_files_now = json.loads(stub_files_path.read_text(encoding='utf-8'))
                        except Exception:
                            pass
                    tf_match = next(
                        (f for f in stub_files_now
                         if f.get('type') == 'transcript'
                         and f.get('href') == transcript_href),
                        None,
                    )
                    if tf_match:
                        raw_t = tf_match.get('title', '')
                        entry['title'] = re.sub(r'^Transcript of\s+', '', raw_t).strip() or raw_t
                comp_audio.append(entry)
                print(f'  {label} ({date}): appended unique audio entry from stub {stub_num}')

        # Re-sort audio by date after any appends.
        complete['events'] = sorted(comp_audio, key=lambda a: a.get('date') or '')

        # ── Step 3: merge remaining files.json entries ────────────────────────
        if stub_files_path.exists():
            stub_files = json.loads(stub_files_path.read_text(encoding='utf-8'))
            if isinstance(stub_files, list) and stub_files:
                comp_folder    = _case_folder(complete.get('number', '') or complete.get('id', ''))
                comp_dir       = term_dir / 'cases' / comp_folder
                comp_files_path = comp_dir / 'files.json'
                comp_dir.mkdir(parents=True, exist_ok=True)
                comp_files = (
                    json.loads(comp_files_path.read_text(encoding='utf-8'))
                    if comp_files_path.exists() else []
                )
                existing_hrefs = {f.get('href') for f in comp_files}
                next_id = max((f.get('file', 0) for f in comp_files), default=0) + 1
                added = 0
                for sf in stub_files:
                    if sf.get('href') not in existing_hrefs:
                        entry = dict(sf)
                        entry['file'] = next_id
                        next_id += 1
                        comp_files.append(entry)
                        existing_hrefs.add(sf.get('href'))
                        added += 1
                if added:
                    comp_files_path.write_text(
                        json.dumps(comp_files, indent=2, ensure_ascii=False) + '\n',
                        encoding='utf-8',
                    )
                    print(f'  {label}: merged {added} file(s) from stub {stub_num} into files.json')
                stub_files_path.unlink()

        # ── Step 4: try to remove the now-empty stub folder ──────────────────
        if stub_dir.exists():
            remaining = [p for p in stub_dir.iterdir()
                         if not p.name.startswith('.')]
            if not remaining:
                stub_dir.rmdir()
                print(f'  Removed empty stub folder {stub_folder}/')
            else:
                names = ', '.join(p.name for p in remaining)
                print(f'  WARNING: stub folder {stub_folder}/ still has files: {names}')

        to_remove.add(stub_idx)

    kept = [c for i, c in enumerate(data) if i not in to_remove]
    cases_path.write_text(
        json.dumps(kept, indent=2, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )
    print(f'  Removed {len(to_remove)} duplicate stub entry(ies) from {cases_path.name}.')


def check_duplicate_case_numbers(term_dir: Path, term: str, verbose: bool = False) -> None:
    """Warn if any case number appears more than once in cases.json."""
    cases_path = term_dir / 'cases.json'
    if not cases_path.exists():
        return
    early_term = term < '1950-10'
    cases = json.loads(cases_path.read_text(encoding='utf-8'))
    seen: dict[str, str] = {}   # lower -> original
    for case in cases:
        number = case.get('number', '')
        if not number:
            continue
        key = number.lower()
        if key in seen:
            if early_term:
                if verbose:
                    print(f' NOTICE: {term}/{number}: duplicate case number in cases.json: '
                          f'{seen[key]!r} and {number!r}')
            else:
                print(f'WARNING: {term}/{number}: duplicate case number in cases.json: '
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
        for i, entry in enumerate(case.get('events', [])):
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
                for a in (case.get('events') or [])
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
        for audio in case.get('events') or []:
            th = audio.get('text_href', '')
            if th and not th.startswith(('http://', 'https://')):
                referenced.add(Path(th).name)
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
    args = [a for a in sys.argv[1:] if a not in ('--checkurls', '--opinions', '--verbose', '--dry-run')]
    check_urls    = '--checkurls' in sys.argv
    opinions_only = '--opinions'  in sys.argv
    verbose       = '--verbose'   in sys.argv
    dry_run       = '--dry-run'   in sys.argv

    global _VERBOSE
    _VERBOSE = verbose

    if len(args) not in (1, 2):
        print(__doc__)
        sys.exit(1)

    term     = args[0]
    term_dir = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term

    if not term_dir.is_dir():
        print(f'Skipping {term}: directory not found.')
        sys.exit(0)

    check_duplicate_case_numbers(term_dir, term, verbose)
    check_duplicate_audio_hrefs(term_dir)
    check_cases_sync(term_dir, verbose)

    cases_path = term_dir / 'cases.json'
    if cases_path.exists():
        migrate_arguments_to_audio(cases_path)
        if not dry_run:
            # Promote transcript file entries to audio objects first, so that
            # deduplicate_cases sees a complete audio list when merging stubs.
            remove_redundant_transcript_files(cases_path)
        deduplicate_cases(cases_path)
        validate_cases_json_arguments(cases_path, term, dry_run)
        normalize_audio_aligned_position(cases_path)
        check_audio_dates(cases_path, term, dry_run)
        check_decision_dates(cases_path, term)
        backfill_untracked_files(cases_path, term, dry_run)
        if not dry_run:
            sync_files_count(cases_path)
        sync_opinion_href_from_files(cases_path)
        warn_missing_opinion_href(cases_path, term)
        if check_urls:
            check_case_hrefs(cases_path, term, opinions_only)

    raw_speaker_map = load_speaker_map()
    justice_entries = _build_justice_rename_entries()

    if len(args) == 2:
        validate_case(term_dir, args[1], check_urls, opinions_only)
        apply_speaker_map_to_case(term_dir / 'cases' / args[1], justice_entries + filter_speaker_map(raw_speaker_map, term))
    else:
        cases_dir = term_dir / 'cases'
        case_dirs = sorted(d for d in cases_dir.iterdir() if d.is_dir()) if cases_dir.is_dir() else []
        if not case_dirs:
            if verbose:
                print(f'NOTICE: {term}: no case directories found')
            return
        speaker_map = justice_entries + filter_speaker_map(raw_speaker_map, term)
        for d in case_dirs:
            validate_case(term_dir, d.name, check_urls, opinions_only)
            apply_speaker_map_to_case(d, speaker_map)


if __name__ == '__main__':
    main()
