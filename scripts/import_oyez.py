#!/usr/bin/env python3
"""Downloads Oyez oral argument and opinion announcement audio for a SCOTUS term.

Usage:
    python3 scripts/import_oyez.py TERM

Examples:
    python3 scripts/import_oyez.py 2025-10
    python3 scripts/import_oyez.py 2025          # same as 2025-10

For each case that exists in both Oyez and the local term folder, the script
fetches the Oyez oral argument and opinion announcement transcripts and saves
them as YYYY-MM-DD-oyez.json in the case directory.  If a date collision occurs
(argument and opinion share the same date), the opinion file gets the suffix
YYYY-MM-DD-opinion-oyez.json instead.

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

REPO_ROOT = Path(__file__).resolve().parent.parent
OYEZ_API  = 'https://api.oyez.org'


def fetch_json(url: str) -> object:
    req = urllib.request.Request(url, headers={'User-Agent': 'import_oyez/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


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


def _turns_are_aligned(data: dict | list) -> bool:
    """Return True if any turn in the transcript data has a 'time' value."""
    turns = data if isinstance(data, list) else (data.get('turns') or [])
    return any(t.get('time') for t in turns)


def _audio_title(type_val: str, date_str: str) -> str:
    """Return a display title for an audio entry.

    Examples:
        'Oral Argument on January 12, 2025'
        'Oral Reargument on March 5, 2025'
        'Opinion Announcement on June 27, 2025'
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        date_label = f'{dt.strftime("%B")} {dt.day}, {dt.year}'
    except (ValueError, TypeError):
        date_label = date_str or '?'
    if type_val == 'reargument':
        return f'Oral Reargument on {date_label}'
    if type_val == 'opinion':
        return f'Opinion Announcement on {date_label}'
    return f'Oral Argument on {date_label}'


def fetch_oyez_transcript(arg_href: str) -> dict | None:
    """Fetch an Oyez oral argument detail and convert to our envelope format.

    Returns None if no transcript data is available.
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
        return None

    sections = transcript.get('sections') or []
    speaker_cache: dict[int, str] = {}  # Oyez ID → formatted name
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
    seen_names: set[str] = set()
    speakers: list[dict] = []
    for t in turns_out:
        if t['name'] not in seen_names:
            seen_names.add(t['name'])
            speakers.append({'name': t['name']})

    return {
        'media': {
            'url': mp3_url,
            'speakers': speakers,
        },
        'turns': turns_out,
    }


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    arg = sys.argv[1].strip()
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

        Handles two Oyez quirks:
          1. Compact original-jurisdiction format: '22O141' → '141-Orig'
          2. Loose original-jurisdiction suffixes:
             '156-orig', '156-original', '156 orig', '156 Original' → '156-Orig'
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

    for number in sorted(oyez_by_num):
        oyez_case = oyez_by_num[number]
        case_dir  = cases_path.parent / 'cases' / number

        # For cases already in our local data, backfill from any existing
        # -oyez.json files (cheap local reads — no API call needed).
        local_case = our_by_num.get(number)
        if local_case is not None:
            # Track all oyez audio dates already in cases.json (any type).
            existing_oyez_dates: set[str] = set()
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
                    date = a.get('date')
                    if date:
                        existing_oyez_dates.add(date)
                    # Backfill title on oyez entries that lack one.
                    if not a.get('title'):
                        a['title'] = _audio_title(a.get('type', 'argument'), a.get('date', ''))
                        cases_modified = True

            # Backfill any *-oyez.json files on disk not yet tracked in cases.json.
            if case_dir.is_dir():
                for oyez_path in sorted(case_dir.glob('*-oyez.json')):
                    date_str = oyez_path.stem[:-5]   # strip '-oyez'
                    if date_str in existing_oyez_dates:
                        continue
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
                    existing_oyez_dates.add(date_str)
                    cases_modified = True
        else:
            existing_oyez_dates = set()

        # Skip the API call if argument and opinion audio are both already present.
        if local_case is not None:
            arg_entries      = [a for a in local_case.get('audio', [])
                                if a.get('source') == 'oyez'
                                and a.get('type') in ('argument', 'reargument')]
            has_arg_oyez     = bool(arg_entries)
            # More oyez dates than argument entries implies opinions are also present.
            has_opinion_oyez = len(existing_oyez_dates) > len(arg_entries)
        else:
            has_arg_oyez     = case_dir.is_dir() and any(case_dir.glob('*-oyez.json'))
            has_opinion_oyez = False
        if has_arg_oyez and has_opinion_oyez:
            skipped += 1
            continue

        # Fetch case detail to get oral_argument_audio list.
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

        for oyez_arg in args_list:
            if oyez_arg.get('unavailable'):
                continue

            date_str = parse_oyez_date(oyez_arg.get('title', ''))
            if not date_str:
                print(f'  {number}: cannot parse date from {oyez_arg.get("title")!r} — skipped')
                continue

            out_path = case_dir / f'{date_str}-oyez.json'
            if date_str in existing_oyez_dates or out_path.exists():
                skipped += 1
                continue

            print(f'  {number} ({date_str}) ...', end=' ', flush=True)
            try:
                envelope = fetch_oyez_transcript(oyez_arg['href'])
                if envelope is None:
                    print('no transcript data')
                    continue

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

                # Update cases.json with source, type, audio_href and text_href.
                audio_href = (envelope.get('media') or {}).get('url', '')
                text_href  = out_path.name
                if date_str not in existing_oyez_dates:
                    type_val = _oyez_arg_type(oyez_arg.get('title', ''))
                    new_arg = {
                        'source':     'oyez',
                        'type':       type_val,
                        'title':      _audio_title(type_val, date_str),
                        'date':       date_str,
                        'audio_href': audio_href,
                        'text_href':  text_href,
                    }
                    if _turns_are_aligned(envelope):
                        new_arg['aligned'] = True
                    local_case.setdefault('audio', []).append(new_arg)
                    existing_oyez_dates.add(date_str)
                    cases_modified = True

                time.sleep(0.3)
            except Exception as exc:
                print(f'ERROR: {exc}')
                errors += 1

        # ── Opinion announcements ─────────────────────────────────────────────
        if local_case is not None:
            for oyez_opinion in detail.get('opinion_announcement') or []:
                if not oyez_opinion or oyez_opinion.get('unavailable'):
                    continue

                date_str = parse_oyez_date(oyez_opinion.get('title', ''))
                if not date_str:
                    print(f'  {number}: cannot parse opinion date from '
                          f'{oyez_opinion.get("title")!r} — skipped')
                    continue

                # Default filename is YYYY-MM-DD-oyez.json.
                # Skip if already tracked (any type) — covers renamed opinion files.
                # Fall back to YYYY-MM-DD-opinion-oyez.json only on a date collision
                # with a different audio file that already occupies the default name.
                out_path = case_dir / f'{date_str}-oyez.json'
                if date_str in existing_oyez_dates:
                    skipped += 1
                    continue
                if out_path.exists():
                    # Collision: YYYY-MM-DD-oyez.json is an argument file — use opinion suffix.
                    out_path = case_dir / f'{date_str}-opinion-oyez.json'
                if out_path.exists():
                    skipped += 1
                    continue

                print(f'  {number} opinion ({date_str}) ...', end=' ', flush=True)
                try:
                    envelope = fetch_oyez_transcript(oyez_opinion['href'])
                    if envelope is None:
                        print('no transcript data')
                        continue

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

                    if date_str not in existing_oyez_dates:
                        audio_href = (envelope.get('media') or {}).get('url', '')
                        new_entry = {
                            'source':     'oyez',
                            'type':       'opinion',
                            'title':      _audio_title('opinion', date_str),
                            'date':       date_str,
                            'audio_href': audio_href,
                            'text_href':  out_path.name,
                        }
                        if _turns_are_aligned(envelope):
                            new_entry['aligned'] = True
                        local_case.setdefault('audio', []).append(new_entry)
                        existing_oyez_dates.add(date_str)
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

    print()
    print(f'Done.  Downloaded: {downloaded}  |  Already existed: {skipped}  |  Errors: {errors}')


if __name__ == '__main__':
    main()
