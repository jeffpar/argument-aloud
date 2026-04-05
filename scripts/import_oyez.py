#!/usr/bin/env python3
"""Downloads Oyez oral argument and opinion announcement audio for a SCOTUS term.

Usage:
    python3 scripts/import_oyez.py TERM

Examples:
    python3 scripts/import_oyez.py 2025-10
    python3 scripts/import_oyez.py 2025          # same as 2025-10

For each case that exists in both Oyez and the local term folder, the script
fetches the Oyez oral argument and opinion announcement transcripts and saves
them as YYYY-MM-DD-oyez.json in the case directory.

An entry with source='oyez' is added to the audio array in cases.json for each
new file.  Opinion entries additionally carry type='opinion'.

Output files use the same envelope format as the PDF-derived transcripts:
  {
    "media": {"url": "<mp3 url>", "speakers": [{"name": "…"}, …]},
    "turns": [{"turn": N, "name": "…", "text": "…", "time": "HH:MM:SS.ss"}]
  }
"""

import json
import re
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from validate_cases import sync_files_count

REPO_ROOT = Path(__file__).resolve().parent.parent
OYEZ_API  = 'https://api.oyez.org'


def fetch_json(url: str) -> object:
    req = urllib.request.Request(url, headers={'User-Agent': 'import_oyez/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


_SPEAKERMAP_CONSTRAINT_RE = re.compile(r'^(.*?)\s+(>=|<)\s+(\d{4}-\d{2})$')


def load_speaker_map() -> list[tuple[str, str | None, str | None, str, str | None]]:
    """Load scripts/speakermap.txt → list of (base_name, op, constraint_term, new_name, role_filter).

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


def apply_speaker_map(envelope: dict, speaker_map: dict[str, tuple[str, str | None]]) -> None:
    """Apply speaker name remappings in-place to a transcript envelope."""
    for sp in (envelope.get('media') or {}).get('speakers') or []:
        name, role = sp.get('name', ''), sp.get('role', '')
        if not role and 'JUSTICE' in name.upper():
            sp['role'] = 'justice'
            continue
        entry = speaker_map.get(name)
        if entry is not None:
            new_name, role_filter = entry
            if role_filter is None or role == role_filter:
                sp['name'] = new_name
    for turn in envelope.get('turns') or []:
        entry = speaker_map.get(turn.get('name', ''))
        if entry is not None:
            turn['name'] = entry[0]


def fetch_oyez_cases(year: str) -> list[dict]:
    """Fetch all cases for the given term year from Oyez, handling pagination."""
    cases = []
    page = 0
    per_page = 300
    while True:
        url = f'{OYEZ_API}/cases?filter=term:{year}&page={page}&per_page={per_page}'
        batch = fetch_json(url)
        if not batch:
            break
        cases.extend(batch)
        if len(batch) < per_page:
            break
        page += 1
    return cases


def speaker_name(speaker: dict) -> str:
    """Convert an Oyez speaker object to our all-caps name format."""
    last = (speaker.get('last_name') or '').upper()
    roles = speaker.get('roles') or []
    for role in roles:
        if not role:
            continue
        if role.get('date_end') != 0:
            continue  # no longer serving
        title = role.get('role_title', '')
        if 'Chief Justice' in title:
            return f'CHIEF JUSTICE {last}'
        if 'Justice' in title or role.get('type') == 'scotus_justice':
            return f'JUSTICE {last}'
    # Non-justice (advocate, etc.): uppercase full name
    return (speaker.get('name') or last or 'UNKNOWN').upper()


def _is_justice(speaker: dict) -> bool:
    """Return True if the Oyez speaker object has a scotus_justice role."""
    for role in speaker.get('roles') or []:
        if role and role.get('type') == 'scotus_justice':
            return True
    return False


def format_time(seconds: float) -> str:
    """Format seconds as HH:MM:SS.ss (hundredths of a second)."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f'{h:02d}:{m:02d}:{s:05.2f}'


def parse_oyez_date(title: str) -> str | None:
    """Parse 'Oral Argument - Month D, YYYY' → 'YYYY-MM-DD', or None."""
    m = re.search(r'([A-Z][a-z]+ \d{1,2},\s+\d{4})', title)
    if not m:
        return None
    try:
        dt = datetime.strptime(m.group(1).strip(), '%B %d, %Y')
        return dt.strftime('%Y-%m-%d')
    except ValueError:
        return None


def _oyez_arg_type(title: str) -> str:
    """Return 'reargument' or 'argument' from an Oyez oral_argument_audio title."""
    if 'reargument' in title.lower():
        return 'reargument'
    return 'argument'


def _needs_role_refresh(path: Path) -> bool:
    """Return True if the file has no speakers with a 'role' attribute.

    Used to trigger a re-download for transcripts imported before role
    tagging was added.
    """
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        speakers = (data.get('media') or {}).get('speakers') or []
        return not any(s.get('role') for s in speakers)
    except Exception:
        return False


def _turns_are_aligned(data: dict | list) -> bool:
    """Return True if any turn in the transcript data has a 'time' value."""
    turns = data if isinstance(data, list) else (data.get('turns') or [])
    return any(t.get('time') for t in turns)


def _audio_title(type_val: str, date_str: str, part: int = 0) -> str:
    """Return a display title for an audio entry.

    When part > 0, inserts 'Part N' before 'on'.

    Examples:
        'Oral Argument on January 12, 2025'
        'Oral Argument Part 1 on January 12, 2025'
        'Opinion Announcement Part 2 on June 27, 2025'
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        date_label = f'{dt.strftime("%B")} {dt.day}, {dt.year}'
    except (ValueError, TypeError):
        date_label = date_str or '?'
    part_str = f' Part {part}' if part else ''
    if type_val == 'reargument':
        return f'Oral Reargument{part_str} on {date_label}'
    if type_val == 'opinion':
        return f'Opinion Announcement{part_str} on {date_label}'
    return f'Oral Argument{part_str} on {date_label}'


def _parse_unix_date(ts) -> str | None:
    """Convert a Unix timestamp (int/float) to 'YYYY-MM-DD', or None."""
    if not ts:
        return None
    try:
        return datetime.utcfromtimestamp(int(ts)).strftime('%Y-%m-%d')
    except (ValueError, OSError, OverflowError):
        return None


def _timeline_decision_date(timeline) -> str | None:
    """Extract the 'Decided' date from an Oyez timeline list.

    The timeline is a list of {event, dates: [unix_ts, ...]} objects.
    Returns the first date of the 'Decided' event as 'YYYY-MM-DD', or None.
    """
    for entry in (timeline or []):
        if (entry or {}).get('event') == 'Decided':
            dates = entry.get('dates') or []
            if dates:
                return _parse_unix_date(dates[0])
    return None


def _set_decision(case: dict, decision_date: str) -> bool:
    """Set case['decision'] to decision_date, inserting after 'number' if absent.

    If 'decision' is already present (even if different), we leave it alone on
    the assumption that it was manually corrected.  Returns True only when the
    key is newly added.
    """
    if 'decision' in case:
        return False  # preserve existing value regardless of content
    # Rebuild dict to place 'decision' immediately after 'number'.
    new: dict = {}
    for k, v in case.items():
        new[k] = v
        if k == 'number':
            new['decision'] = decision_date
    if 'decision' not in new:
        new['decision'] = decision_date
    case.clear()
    case.update(new)
    return True


def _oyez_filename(date_str: str, part: int = 0) -> str:
    """Return the transcript filename for an Oyez audio entry.

    Single-part: 'YYYY-MM-DD-oyez.json'
    Multi-part:  'YYYY-MM-DD-oyez-N.json'
    """
    suffix = f'-{part}' if part else ''
    return f'{date_str}-oyez{suffix}.json'


def fetch_oyez_transcript(arg_href: str) -> tuple[dict | None, str]:
    """Fetch an Oyez oral argument detail and convert to our envelope format.

    Returns (envelope, mp3_url). envelope is None if no transcript data is available.
    mp3_url may be non-empty even when envelope is None.
    """
    detail = fetch_json(arg_href)

    # MP3 URL
    media_files = detail.get('media_file') or []
    mp3_url = next(
        (f['href'] for f in media_files if f.get('mime') == 'audio/mpeg'),
        '',
    )

    transcript = detail.get('transcript')
    if not transcript:
        return None, mp3_url

    sections = transcript.get('sections') or []
    speaker_cache: dict[int, str] = {}  # Oyez ID → formatted name
    justice_cache: dict[int, bool] = {}  # Oyez ID → is scotus_justice
    turns_out: list[dict] = []
    turn_num = 0

    for section in sections:
        if not section:
            continue
        for turn in section.get('turns') or []:
            if not turn:
                continue
            sp = turn.get('speaker') or {}
            sp_id = sp.get('ID', 0)
            if sp_id not in speaker_cache:
                speaker_cache[sp_id] = speaker_name(sp)
                justice_cache[sp_id] = _is_justice(sp)
            name = speaker_cache[sp_id]

            blocks = turn.get('text_blocks') or []
            text = ' '.join(b['text'].strip() for b in blocks if b and b.get('text'))
            if not text:
                continue

            turn_num += 1
            turns_out.append({
                'turn': turn_num,
                'name': name,
                'text': text,
                'time': format_time(turn.get('start', 0.0)),
            })

    if not turns_out:
        return None

    # Ordered speaker list by first appearance
    # Build a reverse map from name → sp_id for role lookup
    name_to_id: dict[str, int] = {v: k for k, v in speaker_cache.items()}
    seen_names: set[str] = set()
    speakers: list[dict] = []
    for t in turns_out:
        if t['name'] not in seen_names:
            seen_names.add(t['name'])
            sp_id = name_to_id.get(t['name'])
            entry: dict = {'name': t['name']}
            if sp_id is not None and justice_cache.get(sp_id):
                entry['role'] = 'justice'
            else:
                entry['role'] = 'advocate'
            speakers.append(entry)

    return {
        'media': {
            'url': mp3_url,
            'speakers': speakers,
        },
        'turns': turns_out,
    }, mp3_url


def main():
    if len(sys.argv) not in (2, 3):
        print(__doc__)
        sys.exit(1)

    arg = sys.argv[1].strip()
    case_filter = sys.argv[2].strip() if len(sys.argv) == 3 else None
    if re.fullmatch(r'\d{4}', arg):
        year_str = arg
        term = f'{arg}-10'
    elif mo := re.fullmatch(r'(\d{4})-(\d{2})', arg):
        year_str = mo.group(1)
        term = arg
    else:
        print(f'Error: expected YYYY or YYYY-MM (e.g. 2025 or 2025-10), got {arg!r}')
        sys.exit(1)

    cases_path = REPO_ROOT / 'courts' / 'ussc' / 'terms' / term / 'cases.json'

    if cases_path.exists():
        our_cases = json.loads(cases_path.read_text(encoding='utf-8'))
    else:
        cases_path.parent.mkdir(parents=True, exist_ok=True)
        our_cases = []
        print(f'Creating new {cases_path.relative_to(REPO_ROOT)}')

    def _normalize_case_num(raw: str) -> str:
        """Normalise a docket number to canonical form.

        Handles Oyez quirks:
          1. Compact original-jurisdiction format: '22O141' → '141-Orig'
          2. Loose original-jurisdiction suffixes:
             '156-orig', '156-original', '156 orig', '156 Original' → '156-Orig'
          3. Misc suffixes:
             '1 MISC', '1-misc', '1 Miscellaneous' → '1-Misc'
        """
        s = raw.strip()
        # Oyez compact form: digits + 'O' + digits (e.g. '22O141')
        m = re.fullmatch(r'\d+O(\d+)', s)
        if m:
            return f'{m.group(1)}-Orig'
        # Loose suffix form: anything followed by optional separator + orig[inal]
        m = re.fullmatch(r'(.+?)[\s-]+(orig(?:inal)?)', s, re.IGNORECASE)
        if m:
            return f'{m.group(1)}-Orig'
        # Misc suffix form: e.g. '1 MISC', '1-misc', '1 Miscellaneous' → '1-Misc'
        m = re.fullmatch(r'(.+?)[\s-]+(misc(?:ellaneous)?)', s, re.IGNORECASE)
        if m:
            return f'{m.group(1)}-Misc'
        return s

    our_by_num = {_normalize_case_num(c['number']): c for c in our_cases}

    print(f'Fetching Oyez case list for {year_str} term ...')
    oyez_cases = fetch_oyez_cases(year_str)
    print(f'  {len(oyez_cases)} case(s) from Oyez')
    print(f'  {len(our_by_num)} case(s) in local cases.json')

    oyez_by_num = {_normalize_case_num(c['docket_number']): c for c in oyez_cases}

    # Compute comparison against the initial local state for the report.
    in_both   = [n for n in our_by_num if n in oyez_by_num]
    oyez_only = [n for n in oyez_by_num if n not in our_by_num]
    our_only  = [n for n in our_by_num if n not in oyez_by_num]

    print(f'  In both: {len(in_both)}')
    if oyez_only:
        print(f'  Oyez only ({len(oyez_only)}): {", ".join(sorted(oyez_only))}')
    if our_only:
        print(f'  Local only ({len(our_only)}): {", ".join(sorted(our_only))}')

    print()
    downloaded = skipped = errors = 0
    cases_modified = False
    raw_speaker_map = load_speaker_map()
    speaker_map = resolve_speaker_map(raw_speaker_map, term)

    for number in sorted(oyez_by_num):
        if case_filter and number != case_filter:
            continue
        oyez_case = oyez_by_num[number]
        case_dir  = cases_path.parent / 'cases' / number

        # For cases already in our local data, build the set of oyez text_hrefs
        # already tracked in cases.json, and backfill any on-disk files that
        # aren't yet recorded.
        local_case = our_by_num.get(number)
        if local_case is not None:
            existing_oyez_filenames: set[str] = set()
            for a in local_case.get('audio', []):
                src = a.get('source')
                if not src:
                    href = a.get('audio_href', '').lower()
                    if 'supremecourt.gov' in href:
                        src = 'ussc'
                    elif 'nara' in href:
                        src = 'nara'
                    elif 'oyez' in href:
                        src = 'oyez'
                if src == 'oyez':
                    th = a.get('text_href')
                    if th:
                        existing_oyez_filenames.add(th)
                    elif a.get('audio_href'):
                        existing_oyez_filenames.add(a['audio_href'])
                    # Backfill title on oyez entries that lack one.
                    if not a.get('title'):
                        a['title'] = _audio_title(a.get('type', 'argument'), a.get('date', ''))
                        cases_modified = True

            # Backfill any *-oyez.json files on disk not yet tracked in cases.json.
            if case_dir.is_dir():
                for oyez_path in sorted(case_dir.glob('*-oyez.json')):
                    if oyez_path.name in existing_oyez_filenames:
                        continue
                    m = re.match(r'^(\d{4}-\d{2}-\d{2})-oyez\.json$', oyez_path.name)
                    if not m:
                        continue
                    date_str = m.group(1)
                    try:
                        data = json.loads(oyez_path.read_text(encoding='utf-8'))
                        audio_href = (data.get('media') or {}).get('url', '')
                    except Exception:
                        audio_href = ''
                        data = {}
                    type_val = ('opinion'    if 'opinion'    in audio_href.lower()
                                else 'reargument' if 'reargument' in audio_href.lower()
                                else 'argument')
                    new_arg = {
                        'source':     'oyez',
                        'type':       type_val,
                        'title':      _audio_title(type_val, date_str),
                        'date':       date_str,
                        'audio_href': audio_href,
                        'text_href':  oyez_path.name,
                    }
                    if _turns_are_aligned(data):
                        new_arg['aligned'] = True
                    local_case.setdefault('audio', []).append(new_arg)
                    existing_oyez_filenames.add(oyez_path.name)
                    cases_modified = True
        else:
            existing_oyez_filenames = set()

        # Fetch case detail to get oral_argument_audio and opinion_announcement lists.
        # (We always fetch — we need the list to know if multi-part audio exists.)
        try:
            detail = fetch_json(oyez_case['href'])
            time.sleep(0.2)
        except Exception as exc:
            print(f'  {number}: ERROR fetching case detail: {exc}')
            errors += 1
            continue

        args_list = detail.get('oral_argument_audio') or []

        # Skip entirely if no arguments and no local case to add opinions to.
        if not args_list and local_case is None:
            continue

        # Ensure a local case entry for cases with arguments.
        if local_case is None:
            local_case = {
                'title':     oyez_case['name'],
                'number':    number,
                'audio': [],
            }
            our_cases.append(local_case)
            our_by_num[number] = local_case
            cases_modified = True

        # ── Decision date ─────────────────────────────────────────────────────
        # The decision date lives in the timeline under the 'Decided' event.
        # Try the detail timeline first, fall back to the list-level timeline.
        decision_date = (
            _timeline_decision_date(detail.get('timeline'))
            or _timeline_decision_date(oyez_case.get('timeline'))
        )
        if decision_date and _set_decision(local_case, decision_date):
            cases_modified = True

        # ── Oral arguments ────────────────────────────────────────────────────
        # Group by date to detect multi-part arguments on the same day.
        args_by_date: dict[str, list] = {}
        for oyez_arg in args_list:
            if oyez_arg.get('unavailable'):
                continue
            date_str = parse_oyez_date(oyez_arg.get('title', ''))
            if not date_str:
                print(f'  {number}: cannot parse date from {oyez_arg.get("title")!r} — skipped')
                continue
            args_by_date.setdefault(date_str, []).append(oyez_arg)

        # Sort each date's parts by the part number in the Oyez title so that
        # Part 1 is always processed before Part 2, regardless of API order.
        _part_num_re = re.compile(r'Part\s+(\d+)', re.IGNORECASE)
        for date_str in args_by_date:
            args_by_date[date_str].sort(
                key=lambda a: int(m.group(1)) if (m := _part_num_re.search(a.get('title', ''))) else 0
            )

        for date_str, parts in args_by_date.items():
            use_parts = len(parts) > 1

            # If this date now has multiple parts, rename any existing unnumbered
            # file to the '-1' variant and update cases.json accordingly.
            if use_parts:
                unnumbered = case_dir / _oyez_filename(date_str)
                part1_path = case_dir / _oyez_filename(date_str, 1)
                if unnumbered.exists() and not part1_path.exists():
                    unnumbered.rename(part1_path)
                    print(f'  {number}: renamed {unnumbered.name} → {part1_path.name}')
                    for a in local_case.get('audio', []):
                        if (a.get('source') == 'oyez' and a.get('date') == date_str
                                and a.get('text_href') == unnumbered.name):
                            a['text_href'] = part1_path.name
                            a['title'] = _audio_title(a.get('type', 'argument'), date_str, 1)
                            existing_oyez_filenames.discard(unnumbered.name)
                            existing_oyez_filenames.add(part1_path.name)
                            cases_modified = True
                            break

            for part_idx, oyez_arg in enumerate(parts, start=1):
                part_num = part_idx if use_parts else 0
                out_name = _oyez_filename(date_str, part_num)
                out_path = case_dir / out_name

                if out_name in existing_oyez_filenames and not _needs_role_refresh(out_path):
                    skipped += 1
                    continue

                label = f'Part {part_num} ' if use_parts else ''
                print(f'  {number} ({date_str}) {label}...', end=' ', flush=True)
                try:
                    envelope, mp3_url = fetch_oyez_transcript(oyez_arg['href'])
                    if envelope is None:
                        # No transcript, but still record the audio entry if it's new.
                        if mp3_url and mp3_url not in existing_oyez_filenames and out_name not in existing_oyez_filenames:
                            type_val = _oyez_arg_type(oyez_arg.get('title', ''))
                            new_arg = {
                                'source':     'oyez',
                                'type':       type_val,
                                'title':      _audio_title(type_val, date_str, part_num),
                                'date':       date_str,
                                'audio_href': mp3_url,
                            }
                            local_case.setdefault('audio', []).append(new_arg)
                            existing_oyez_filenames.add(mp3_url)
                            cases_modified = True
                            print('no transcript \u2014 audio entry added')
                        else:
                            print('no transcript data')
                        continue

                    apply_speaker_map(envelope, speaker_map)
                    case_dir.mkdir(parents=True, exist_ok=True)
                    out_path.write_text(
                        json.dumps(envelope, indent=2, ensure_ascii=False) + '\n',
                        encoding='utf-8',
                    )
                    try:
                        rel = out_path.relative_to(REPO_ROOT)
                    except ValueError:
                        rel = out_path
                    print(f'{len(envelope["turns"])} turns -> {rel}')
                    downloaded += 1

                    if out_name not in existing_oyez_filenames:
                        audio_href = (envelope.get('media') or {}).get('url', '')
                        type_val = _oyez_arg_type(oyez_arg.get('title', ''))
                        new_arg = {
                            'source':     'oyez',
                            'type':       type_val,
                            'title':      _audio_title(type_val, date_str, part_num),
                            'date':       date_str,
                            'audio_href': audio_href,
                            'text_href':  out_name,
                        }
                        if _turns_are_aligned(envelope):
                            new_arg['aligned'] = True
                        local_case.setdefault('audio', []).append(new_arg)
                        existing_oyez_filenames.add(out_name)
                        cases_modified = True

                    time.sleep(0.3)
                except Exception as exc:
                    print(f'ERROR: {exc}')
                    errors += 1

        # ── Opinion announcements ─────────────────────────────────────────────
        if local_case is not None:
            # Group by date to detect multi-part opinions on the same day.
            opinions_by_date: dict[str, list] = {}
            for oyez_opinion in (detail.get('opinion_announcement') or []):
                if not oyez_opinion or oyez_opinion.get('unavailable'):
                    continue
                date_str = parse_oyez_date(oyez_opinion.get('title', ''))
                if not date_str:
                    print(f'  {number}: cannot parse opinion date from '
                          f'{oyez_opinion.get("title")!r} — skipped')
                    continue
                opinions_by_date.setdefault(date_str, []).append(oyez_opinion)

            # Sort each date's parts by part number so Part 1 is processed first.
            for date_str in opinions_by_date:
                opinions_by_date[date_str].sort(
                    key=lambda a: int(m.group(1)) if (m := _part_num_re.search(a.get('title', ''))) else 0
                )

            for date_str, parts in opinions_by_date.items():
                use_parts = len(parts) > 1

                # Rename existing unnumbered file to '-1' when multi-part detected.
                if use_parts:
                    unnumbered = case_dir / _oyez_filename(date_str)
                    part1_path = case_dir / _oyez_filename(date_str, 1)
                    if unnumbered.exists() and not part1_path.exists():
                        unnumbered.rename(part1_path)
                        print(f'  {number}: renamed {unnumbered.name} → {part1_path.name}')
                        for a in local_case.get('audio', []):
                            if (a.get('source') == 'oyez' and a.get('date') == date_str
                                    and a.get('text_href') == unnumbered.name):
                                a['text_href'] = part1_path.name
                                a['title'] = _audio_title('opinion', date_str, 1)
                                existing_oyez_filenames.discard(unnumbered.name)
                                existing_oyez_filenames.add(part1_path.name)
                                cases_modified = True
                                break

                for part_idx, oyez_opinion in enumerate(parts, start=1):
                    part_num = part_idx if use_parts else 0
                    out_name = _oyez_filename(date_str, part_num)
                    out_path = case_dir / out_name

                    if out_name in existing_oyez_filenames and not _needs_role_refresh(out_path):
                        skipped += 1
                        continue
                    if out_path.exists() and not _needs_role_refresh(out_path):
                        skipped += 1
                        continue

                    label = f'Part {part_num} ' if use_parts else ''
                    print(f'  {number} opinion ({date_str}) {label}...', end=' ', flush=True)
                    try:
                        envelope, mp3_url = fetch_oyez_transcript(oyez_opinion['href'])
                        if envelope is None:
                            # No transcript, but still record the audio entry if it's new.
                            if mp3_url and mp3_url not in existing_oyez_filenames and out_name not in existing_oyez_filenames:
                                new_entry = {
                                    'source':     'oyez',
                                    'type':       'opinion',
                                    'title':      _audio_title('opinion', date_str, part_num),
                                    'date':       date_str,
                                    'audio_href': mp3_url,
                                }
                                local_case.setdefault('audio', []).append(new_entry)
                                existing_oyez_filenames.add(mp3_url)
                                cases_modified = True
                                print('no transcript \u2014 audio entry added')
                            else:
                                print('no transcript data')
                            continue

                        apply_speaker_map(envelope, speaker_map)
                        case_dir.mkdir(parents=True, exist_ok=True)
                        out_path.write_text(
                            json.dumps(envelope, indent=2, ensure_ascii=False) + '\n',
                            encoding='utf-8',
                        )
                        try:
                            rel = out_path.relative_to(REPO_ROOT)
                        except ValueError:
                            rel = out_path
                        print(f'{len(envelope["turns"])} turns -> {rel}')
                        downloaded += 1

                        if out_name not in existing_oyez_filenames:
                            audio_href = (envelope.get('media') or {}).get('url', '')
                            new_entry = {
                                'source':     'oyez',
                                'type':       'opinion',
                                'title':      _audio_title('opinion', date_str, part_num),
                                'date':       date_str,
                                'audio_href': audio_href,
                                'text_href':  out_name,
                            }
                            if _turns_are_aligned(envelope):
                                new_entry['aligned'] = True
                            local_case.setdefault('audio', []).append(new_entry)
                            existing_oyez_filenames.add(out_name)
                            cases_modified = True

                        time.sleep(0.3)
                    except Exception as exc:
                        print(f'ERROR: {exc}')
                        errors += 1

    if cases_modified:
        cases_path.write_text(
            json.dumps(our_cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print(f'Updated {cases_path.relative_to(REPO_ROOT)}')

    sync_files_count(cases_path)

    print()
    print(f'Done.  Downloaded: {downloaded}  |  Already existed: {skipped}  |  Errors: {errors}')


if __name__ == '__main__':
    main()
