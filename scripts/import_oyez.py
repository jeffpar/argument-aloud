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
from datetime import datetime, timezone
from pathlib import Path
from validate_cases import sync_files_count
from schema import reorder_event

REPO_ROOT      = Path(__file__).resolve().parent.parent
OYEZ_API       = 'https://api.oyez.org'
_SPEAKERS_PATH = Path(__file__).resolve().parent / 'speakers.json'

# Set to True by --cases; gates creation of new case objects.  Without this
# flag the script may only add new event objects to existing cases.
ADD_CASES: bool = False


def fetch_json(url: str) -> object:
    req = urllib.request.Request(url, headers={'User-Agent': 'import_oyez/1.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


_SPEAKERMAP_CONSTRAINT_RE = re.compile(r'^(.*?)\s+(>=|<)\s+(\d{4}-\d{2})$')


def load_speaker_map() -> list[tuple[str, str | None, str | None, str, str | None]]:
    """Load scripts/speakers.json → list of (base_name, op, constraint_term, new_name, role_filter).

    Only the 'typos' and 'rename' sections are emitted as unconditional entries.
    """
    if not _SPEAKERS_PATH.exists():
        return []
    data: dict = json.loads(_SPEAKERS_PATH.read_text(encoding='utf-8'))
    result: list[tuple[str, str | None, str | None, str, str | None]] = []
    for raw, corrected in (data.get('typos') or {}).items():
        result.append((raw.upper(), None, None, corrected.upper(), None))
    for old, new in (data.get('rename') or {}).items():
        result.append((old.upper(), None, None, new.upper(), None))
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


def load_title_map() -> dict[str, str]:
    """Load the 'title' section from speakers.json.

    Returns a dict mapping uppercased full name to title string (e.g. 'MR.', 'MS.', 'GENERAL').
    """
    if not _SPEAKERS_PATH.exists():
        return {}
    data: dict = json.loads(_SPEAKERS_PATH.read_text(encoding='utf-8'))
    return {k.upper(): v.upper() for k, v in (data.get('title') or {}).items()}


def load_justices() -> dict[str, str]:
    """Load scripts/justices.json and return a mapping from any known name variant
    (upper-cased) to the canonical name.

    Both the canonical name and all alternates map to the canonical name.
    """
    path = Path(__file__).resolve().parent / 'justices.json'
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding='utf-8'))
    result: dict[str, str] = {}
    for canonical, info in data.items():
        result[canonical.upper()] = canonical
        for alt in (info.get('alternates') or []):
            result[alt.upper()] = canonical
    return result


def apply_speaker_map(envelope: dict, speaker_map: dict[str, tuple[str, str | None]],
                      title_map: dict[str, str] | None = None) -> None:
    """Apply advocate title lookups from title_map to the speakers list."""
    if not title_map:
        return
    for sp in (envelope.get('media') or {}).get('speakers') or []:
        if not sp.get('title'):
            title = title_map.get(sp.get('name', ''))
            if title:
                sp['title'] = title


KNOWN_TITLES = frozenset({'MR.', 'MS.', 'MRS.', 'MISS', 'GENERAL'})
_TITLE_MENTION_RE = re.compile(r'\b(General|Mr\.|Ms\.|Mrs\.|Miss)\s+([A-Z][a-z]+)')


def _detect_titles_from_turns(turns: list[dict], speakers: list[dict]) -> None:
    """Scan turn texts to infer titles for speakers that don't yet have one.

    Recognises: MR., MS., MRS., MISS, GENERAL.
    Updates speakers in-place; only fills in missing (empty) titles.
    """
    last_to_title: dict[str, str] = {}
    for turn in turns:
        for m in _TITLE_MENTION_RE.finditer(turn.get('text', '')):
            title = m.group(1).upper()   # "General"→"GENERAL", "Mr."→"MR.", etc.
            last = m.group(2).upper()
            last_to_title.setdefault(last, title)
    for sp in speakers:
        if sp.get('title'):
            continue  # already has a title — leave it alone
        name = (sp.get('name') or '').upper()
        if not name:
            continue
        last = name.split()[-1]
        if last in last_to_title:
            sp['title'] = last_to_title[last]


def _title_contains(existing: str, detected: str) -> bool:
    """Return True if *detected* already appears in a comma-separated title string."""
    return detected.upper() in {p.strip().upper() for p in existing.split(',')}


def _merge_speakers(existing: list[dict], fresh: list[dict]) -> list[dict]:
    """Merge a freshly-built speakers list into an existing one.

    - Existing speakers keep their position.
    - An existing speaker's non-empty title is preserved; an empty title is
      replaced by the fresh title (e.g. from turn-text detection).
    - Speakers absent from *fresh* (no longer in the transcript) are dropped.
    - Speakers present in *fresh* but absent from *existing* are appended.
    """
    fresh_by_name = {sp['name']: sp for sp in fresh}
    seen: set[str] = set()
    result: list[dict] = []
    for sp in existing:
        name = sp['name']
        if name not in fresh_by_name:
            continue  # no longer in this transcript — drop it
        merged = dict(sp)
        if not merged.get('title') and fresh_by_name[name].get('title'):
            merged['title'] = fresh_by_name[name]['title']
        result.append(merged)
        seen.add(name)
    for sp in fresh:
        if sp['name'] not in seen:
            result.append(sp)
    return result


def _merge_envelope_speakers(out_path: Path, envelope: dict) -> None:
    """If *out_path* already exists, merge its speakers into *envelope* in-place.

    Preserves existing speaker order and non-empty titles; appends any new
    speakers at the end.
    """
    if not out_path.exists():
        return
    try:
        old_data = json.loads(out_path.read_text(encoding='utf-8'))
        old_speakers = (old_data.get('media') or {}).get('speakers') or []
    except Exception:
        return
    if old_speakers:
        envelope['media']['speakers'] = _merge_speakers(
            old_speakers, envelope['media']['speakers'])


def _load_term_numbers(cases_path: Path) -> set[str]:
    """Return all individual case numbers (incl. consolidated components) from
    a cases.json file.  Returns an empty set if the file does not exist."""
    if not cases_path.exists():
        return set()
    try:
        data = json.loads(cases_path.read_text(encoding='utf-8'))
    except Exception:
        return set()
    numbers: set[str] = set()
    for c in data:
        for part in c.get('number', '').split(','):
            n = part.strip()
            if n:
                numbers.add(n)
    return numbers


def _load_later_term_numbers(terms_root: Path, year_str: str,
                              lookahead: int = 2) -> dict[str, str]:
    """Return a mapping of case_number → term string for cases already present
    in any of the *lookahead* terms following YYYY-10.

    Used to avoid adding a new case to the current term when it has already been
    moved to a later term (e.g. due to a reargument or a delayed decision).
    """
    result: dict[str, str] = {}
    year = int(year_str)
    for offset in range(1, lookahead + 1):
        later_term = f'{year + offset}-10'
        later_path = terms_root / later_term / 'cases.json'
        for num in _load_term_numbers(later_path):
            if num not in result:   # first (nearest) later term wins
                result[num] = later_term
    return result


# Module-level cache for later-term cases.json data (avoids re-reading the
# same file when multiple cases from the same later term are encountered).
_later_term_data_cache: dict[str, list] = {}


def _check_previously_filed(current_term: str, case_number: str,
                             later_term: str, terms_root: Path) -> None:
    """Verify and fix the 'previouslyFiled' field on a case refiled in a later term.

    Loads *later_term*'s cases.json, finds the entry whose number (or one of
    its comma-separated components) equals *case_number*, then:
      - Warns if 'previouslyFiled' is absent.
      - Fixes 'previouslyFiled' if it is set but lacks the '/<number>' suffix,
        appending case_number so it becomes '<term>/<number>'.
    """
    later_path = terms_root / later_term / 'cases.json'
    if later_term not in _later_term_data_cache:
        if not later_path.exists():
            return
        try:
            _later_term_data_cache[later_term] = json.loads(
                later_path.read_text(encoding='utf-8'))
        except Exception:
            return
    data = _later_term_data_cache[later_term]
    for case in data:
        nums = [n.strip() for n in case.get('number', '').split(',')]
        if case_number not in nums:
            continue
        pf = case.get('previouslyFiled')
        if not pf:
            print(f'  WARNING: {case_number} appears in {later_term} '
                  f'but previouslyFiled is not set on that entry')
            return
        if '/' not in str(pf):
            fixed = f'{pf}/{case_number}'
            case['previouslyFiled'] = fixed
            print(f'  Fixed previouslyFiled for {case_number} in {later_term}: '
                  f'{pf!r} -> {fixed!r}')
            later_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
        return


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


def speaker_name(speaker: dict, justices: dict[str, str] | None = None) -> str:
    """Convert an Oyez speaker object to our all-caps full-name format.

    Returns 'UNKNOWN JUSTICE' or 'UNKNOWN SPEAKER' for speakers with no name.
    If *justices* is provided (from load_justices()), the raw Oyez name is
    normalised to the canonical name defined in justices.json.
    """
    name_raw = speaker.get('name') or speaker.get('last_name') or ''
    if not name_raw:
        return 'UNKNOWN JUSTICE' if _is_justice(speaker) else 'UNKNOWN SPEAKER'
    name = name_raw.upper()
    if justices:
        name = justices.get(name, name)
    return name


def _is_justice(speaker: dict) -> bool:
    """Return True if the Oyez speaker object has a scotus_justice role."""
    for role in speaker.get('roles') or []:
        if role and role.get('type') == 'scotus_justice':
            return True
    return False


def _oyez_justice_title(speaker: dict) -> str | None:
    """Return 'CHIEF JUSTICE' or 'JUSTICE' if speaker was ever a SCOTUS justice, else None.

    Unlike speaker_name(), this checks all roles (including past/retired justices).
    """
    for role in speaker.get('roles') or []:
        if not role:
            continue
        if role.get('type') == 'scotus_justice':
            if 'Chief Justice' in role.get('role_title', ''):
                return 'CHIEF JUSTICE'
            return 'JUSTICE'
    return None


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


def _needs_format_refresh(path: Path) -> bool:
    """Return True if the file uses the old speaker format (role= instead of title=).

    Used to trigger a re-download for transcripts imported before the
    full-name + title speaker format was adopted.
    """
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        speakers = (data.get('media') or {}).get('speakers') or []
        return any(s.get('role') for s in speakers)
    except Exception:
        return False


def _turns_are_aligned(data: dict | list) -> bool:
    """Return True if any turn in the transcript data has a 'time' value."""
    turns = data if isinstance(data, list) else (data.get('turns') or [])
    return any(t.get('time') for t in turns)


def _audio_title(type_val: str, date_str: str, part: int = 0, case_num: str = '') -> str:
    """Return a display title for an audio entry.

    When part > 0, inserts 'Part N' before 'on'.
    When case_num is set (consolidated cases), inserts 'in No. N' before 'on'.

    Examples:
        'Oral Argument on January 12, 2025'
        'Oral Argument Part 1 on January 12, 2025'
        'Oral Argument in No. 05-380 on November 8, 2006'
        'Opinion Announcement in No. 05-1382 on April 18, 2007'
    """
    try:
        dt = datetime.strptime(date_str, '%Y-%m-%d')
        date_label = f'{dt.strftime("%B")} {dt.day}, {dt.year}'
    except (ValueError, TypeError):
        date_label = date_str or '?'
    part_str    = f' Part {part}'      if part     else ''
    case_str    = f' in No. {case_num}' if case_num else ''
    if type_val == 'reargument':
        return f'Oral Reargument{case_str}{part_str} on {date_label}'
    if type_val == 'opinion':
        return f'Opinion Announcement{part_str} on {date_label}'  # no case_str for opinions
    return f'Oral Argument{case_str}{part_str} on {date_label}'


def _case_num_from_href(text_href: str, audio_href: str = '') -> str:
    """Extract the case-folder number from a folder-prefixed text_href.

    For a text_href like '05-1382/2006-11-08-oyez.json', returns '05-1382'.
    Falls back to extracting the case number from an Oyez audio_href URL
    (e.g. '.../case_data/2006/05-1382/...' → '05-1382').
    Returns '' if the number cannot be determined.
    """
    if text_href and '/' in text_href:
        return text_href.split('/')[0]
    if audio_href:
        m = re.search(r'/case_data/\d+/([^/]+)/', audio_href)
        if m:
            return m.group(1)
    return ''


def _parse_unix_date(ts) -> str | None:
    """Convert a Unix timestamp (int/float) to 'YYYY-MM-DD', or None."""
    if not ts:
        return None
    try:
        return datetime.fromtimestamp(int(ts), timezone.utc).strftime('%Y-%m-%d')
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


def _set_oyez_url(case: dict, url: str) -> bool:
    """Set case['oyez'] to url, inserting it immediately after 'number'.

    Does nothing if 'oyez' is already present.  Returns True when newly added.
    """
    if 'oyez' in case:
        return False
    new: dict = {}
    for k, v in case.items():
        new[k] = v
        if k == 'number':
            new['oyez'] = url
    if 'oyez' not in new:
        new['oyez'] = url
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


def fetch_oyez_transcript(arg_href: str, justices: dict[str, str] | None = None) -> tuple[dict | None, str]:
    """Fetch an Oyez oral argument detail and convert to our envelope format.

    Returns (envelope, mp3_url). envelope is None if no transcript data is available.
    mp3_url may be non-empty even when envelope is None.

    If *justices* is provided (from load_justices()), speaker names are
    normalised to the canonical names defined in justices.json.
    """
    detail = fetch_json(arg_href)

    # MP3 URL
    media_files = [f for f in (detail.get('media_file') or []) if f is not None]
    mp3_url = next(
        (f['href'] for f in media_files if f.get('mime') == 'audio/mpeg'),
        '',
    )

    transcript = detail.get('transcript')
    if not transcript:
        return None, mp3_url

    sections = transcript.get('sections') or []
    speaker_cache: dict[int, str] = {}       # Oyez ID → full uppercase name
    justice_title_cache: dict[int, str | None] = {}  # Oyez ID → 'CHIEF JUSTICE'/'JUSTICE'/None
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
                speaker_cache[sp_id] = speaker_name(sp, justices)
                justice_title_cache[sp_id] = _oyez_justice_title(sp)
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

    # Ordered speaker list by first appearance.
    # Build name→title from speaker_cache so the canonical name is used as key.
    # When multiple Oyez IDs normalise to the same canonical name, the title from
    # the first such ID is kept (order of speaker_cache iteration is insertion order).
    name_to_title: dict[str, str] = {}
    for sp_id, name in speaker_cache.items():
        if name not in name_to_title:
            name_to_title[name] = justice_title_cache.get(sp_id) or ''
    seen_names: set[str] = set()
    speakers: list[dict] = []
    for t in turns_out:
        if t['name'] not in seen_names:
            seen_names.add(t['name'])
            # Update name in the turns entry to canonical form (already done via
            # speaker_name), then build the speakers entry in first-appearance order
            # without removing / re-inserting existing entries.
            speakers.append({'name': t['name'], 'title': name_to_title.get(t['name'], '')})

    # Fill in titles for non-justice speakers by scanning the turn text.
    _detect_titles_from_turns(turns_out, speakers)

    return {
        'media': {
            'url': mp3_url,
            'speakers': speakers,
        },
        'turns': turns_out,
    }, mp3_url


def main():
    global ADD_CASES
    flags    = [a for a in sys.argv[1:] if a.startswith('--')]
    pos_args = [a for a in sys.argv[1:] if not a.startswith('--')]
    ADD_CASES = '--cases' in flags

    if len(pos_args) not in (1, 2):
        print(__doc__)
        sys.exit(1)

    arg = pos_args[0].strip()
    case_filter = pos_args[1].strip() if len(pos_args) == 2 else None
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

    # Inclusive start / exclusive end of this term's date range.
    # e.g. 1956-10 → [1956-10-01, 1957-10-01)
    _term_month     = term.split('-')[1]
    term_start      = f'{year_str}-{_term_month}-01'
    next_term_start = f'{int(year_str) + 1}-{_term_month}-01'

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

    our_by_num = {_normalize_case_num(c['number']): c for c in our_cases if 'number' in c}
    # Also index consolidated cases (comma-separated numbers) by each component
    # number, but only when that component has no separate case entry of its own.
    for _c in our_cases:
        if 'number' not in _c:
            continue
        _parts = _c['number'].split(',')
        if len(_parts) > 1:
            for _n in _parts:
                _nn = _normalize_case_num(_n.strip())
                if _nn not in our_by_num:
                    our_by_num[_nn] = _c

    # Load case numbers from the next two terms to avoid duplicating cases that
    # were moved forward (e.g. due to reargument or a delayed decision).
    terms_root = cases_path.parent.parent
    later_term_numbers = _load_later_term_numbers(terms_root, year_str)

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
    # Later-term cases.json files loaded on demand when we redirect a case.
    _redir_files: dict[Path, list[dict]] = {}
    # Snapshot list: (later_cases_path, case_ref, json_snapshot) for each redirect.
    _redirect_snapshots: list[tuple[Path, dict, str]] = []
    raw_speaker_map = load_speaker_map()
    speaker_map = resolve_speaker_map(raw_speaker_map, term)
    title_map = load_title_map()
    justices = load_justices()

    for number in sorted(oyez_by_num):
        if case_filter and number != case_filter:
            continue
        oyez_case = oyez_by_num[number]
        case_dir  = cases_path.parent / 'cases' / number

        # For cases already in our local data, build the set of oyez text_hrefs
        # already tracked in cases.json, and backfill any on-disk files that
        # aren't yet recorded.
        local_case = our_by_num.get(number)
        # Detect consolidated cases (number is a component of a multi-number entry).
        _local_number      = (local_case.get('number', '') if local_case is not None else '')
        is_consolidated    = ',' in _local_number
        if is_consolidated:
            _comps = [_normalize_case_num(n.strip()) for n in _local_number.split(',')]
            _oyez_comps = [cn for cn in _comps if cn in oyez_by_num]
            case_num_for_title = number if len(_oyez_comps) > 1 else ''
        else:
            case_num_for_title = ''
        if local_case is not None:
            existing_oyez_filenames: set[str] = set()
            for a in local_case.get('events', []):
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
                        _cn = _case_num_from_href(a.get('text_href', ''), a.get('audio_href', ''))
                        a['title'] = _audio_title(
                            a.get('type', 'argument'), a.get('date', ''),
                            case_num=_cn if is_consolidated else '',
                        )
                        cases_modified = True

            # Backfill any *-oyez.json files on disk not yet tracked in cases.json.
            if case_dir.is_dir():
                for oyez_path in sorted(case_dir.glob('*-oyez.json')):
                    _oyez_href = number + '/' + oyez_path.name
                    if _oyez_href in existing_oyez_filenames:
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
                    new_arg = reorder_event({
                        'source':     'oyez',
                        'type':       type_val,
                        'date':       date_str,
                        'title':      _audio_title(type_val, date_str, case_num=case_num_for_title),
                        'audio_href': audio_href,
                        'text_href':  _oyez_href,
                        'aligned':    True if _turns_are_aligned(data) else None,
                    })
                    if new_arg.get('aligned') is None:
                        del new_arg['aligned']
                    local_case.setdefault('events', []).append(new_arg)
                    existing_oyez_filenames.add(_oyez_href)
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
            if number in later_term_numbers:
                found_term = later_term_numbers[number]
                _check_previously_filed(term, number, found_term, terms_root)
                later_cases_path = terms_root / found_term / 'cases.json'
                if later_cases_path not in _redir_files and later_cases_path.exists():
                    _redir_files[later_cases_path] = json.loads(
                        later_cases_path.read_text(encoding='utf-8')
                    )
                _later_data = _redir_files.get(later_cases_path, [])
                _later_local = next(
                    (c for c in _later_data
                     if _normalize_case_num(c.get('number', '')) == number),
                    None,
                )
                if _later_local is None:
                    print(f'  {number}: found in {found_term} — no matching case, skipping')
                    continue
                print(f'  {number}: redirecting Oyez events to {found_term}')
                local_case = _later_local
                case_dir   = later_cases_path.parent / 'cases' / number
                _redirect_snapshots.append(
                    (later_cases_path, _later_local,
                     json.dumps(_later_local, sort_keys=True))
                )
                # Populate existing_oyez_filenames from the later-term case's
                # events (normally done in the `if local_case is not None:` block
                # above, which was skipped because local_case was None then).
                for _ra in local_case.get('events', []):
                    _rsrc = _ra.get('source')
                    if not _rsrc:
                        _rah = _ra.get('audio_href', '').lower()
                        if 'supremecourt.gov' in _rah:  _rsrc = 'ussc'
                        elif 'nara' in _rah:            _rsrc = 'nara'
                        elif 'oyez' in _rah:            _rsrc = 'oyez'
                    if _rsrc == 'oyez':
                        _rth = _ra.get('text_href')
                        if _rth:
                            existing_oyez_filenames.add(_rth)
                        elif _ra.get('audio_href'):
                            existing_oyez_filenames.add(_ra['audio_href'])
                # Also backfill from disk files in the later term's cases dir.
                if case_dir.is_dir():
                    for _rp in sorted(case_dir.glob('*-oyez.json')):
                        _rh = number + '/' + _rp.name
                        if _rh in existing_oyez_filenames:
                            continue
                        _rm = re.match(r'^(\d{4}-\d{2}-\d{2})-oyez\.json$', _rp.name)
                        if not _rm:
                            continue
                        _rd = _rm.group(1)
                        try:
                            _rdata = json.loads(_rp.read_text(encoding='utf-8'))
                            _rurl  = (_rdata.get('media') or {}).get('url', '')
                        except Exception:
                            _rdata, _rurl = {}, ''
                        _rtype = ('opinion'    if 'opinion'    in _rurl.lower()
                                  else 'reargument' if 'reargument' in _rurl.lower()
                                  else 'argument')
                        _rnew = reorder_event({
                            'source': 'oyez', 'type': _rtype, 'date': _rd,
                            'title':  _audio_title(_rtype, _rd),
                            'audio_href': _rurl, 'text_href': _rh,
                            'aligned': True if _turns_are_aligned(_rdata) else None,
                        })
                        if _rnew.get('aligned') is None:
                            del _rnew['aligned']
                        local_case.setdefault('events', []).append(_rnew)
                        existing_oyez_filenames.add(_rh)
                        cases_modified = True
                # Fall through to process events against the later-term case.
            elif not ADD_CASES:
                print(f'  WARNING: {number} ({oyez_case.get("name", "")}) is a new case '
                      f'not in cases.json; pass --cases to add it')
                continue
            else:
                local_case = {
                    'title':     oyez_case['name'],
                    'number':    number,
                    'audio': [],
                }
                our_cases.append(local_case)
                our_by_num[number] = local_case
                cases_modified = True

        # ── Oyez www URL ──────────────────────────────────────────────────────
        # Derive the public oyez.org URL from the API href by swapping the host.
        # e.g. https://api.oyez.org/cases/2025/24-1063 → https://www.oyez.org/cases/2025/24-1063
        _oyez_www = oyez_case.get('href', '').replace('api.oyez.org', 'www.oyez.org', 1)
        if _oyez_www and _set_oyez_url(local_case, _oyez_www):
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
        # If the case has a decision date, ignore any audio events that fall
        # after it — these are arguments from a subsequent term that were
        # manually split into a separate case entry.
        _decision_date = local_case.get('decision', '') if local_case is not None else ''

        args_by_date: dict[str, list] = {}
        for oyez_arg in args_list:
            if oyez_arg.get('unavailable'):
                continue
            date_str = parse_oyez_date(oyez_arg.get('title', ''))
            if not date_str:
                print(f'  {number}: cannot parse date from {oyez_arg.get("title")!r} — skipped')
                continue
            if _decision_date and date_str > _decision_date:
                print(f'  {number}: skipping audio on {date_str} (after decision {_decision_date})')
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
                    for a in local_case.get('events', []):
                        if (a.get('source') == 'oyez' and a.get('date') == date_str
                                and a.get('text_href') == number + '/' + unnumbered.name):
                            a['text_href'] = number + '/' + part1_path.name
                            a['title'] = _audio_title(a.get('type', 'argument'), date_str, 1,
                                                       case_num_for_title)
                            existing_oyez_filenames.discard(number + '/' + unnumbered.name)
                            existing_oyez_filenames.add(number + '/' + part1_path.name)
                            cases_modified = True
                            break

            for part_idx, oyez_arg in enumerate(parts, start=1):
                part_num  = part_idx if use_parts else 0
                out_fname = _oyez_filename(date_str, part_num)
                out_path  = case_dir / out_fname
                out_href  = number + '/' + out_fname

                if out_href in existing_oyez_filenames and not _needs_format_refresh(out_path):
                    skipped += 1
                    continue

                label = f'Part {part_num} ' if use_parts else ''
                print(f'  {number} ({date_str}) {label}...', end=' ', flush=True)
                try:
                    envelope, mp3_url = fetch_oyez_transcript(oyez_arg['href'], justices)
                    if envelope is None:
                        # No transcript, but still record the audio entry if it's new.
                        if mp3_url and mp3_url not in existing_oyez_filenames and out_href not in existing_oyez_filenames:
                            type_val = _oyez_arg_type(oyez_arg.get('title', ''))
                            new_arg = reorder_event({
                                'source':     'oyez',
                                'type':       type_val,
                                'date':       date_str,
                                'title':      _audio_title(type_val, date_str, part_num, case_num_for_title),
                                'audio_href': mp3_url,
                            })
                            local_case.setdefault('events', []).append(new_arg)
                            existing_oyez_filenames.add(mp3_url)
                            cases_modified = True
                            print('no transcript \u2014 audio entry added')
                        else:
                            print('no transcript data')
                        continue

                    apply_speaker_map(envelope, speaker_map, title_map)
                    _merge_envelope_speakers(out_path, envelope)
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

                    if out_href not in existing_oyez_filenames:
                        audio_href = (envelope.get('media') or {}).get('url', '')
                        type_val = _oyez_arg_type(oyez_arg.get('title', ''))
                        new_arg = reorder_event({
                            'source':     'oyez',
                            'type':       type_val,
                            'date':       date_str,
                            'title':      _audio_title(type_val, date_str, part_num, case_num_for_title),
                            'audio_href': audio_href,
                            'text_href':  out_href,
                            'aligned':    True if _turns_are_aligned(envelope) else None,
                        })
                        if new_arg.get('aligned') is None:
                            del new_arg['aligned']
                        local_case.setdefault('events', []).append(new_arg)
                        existing_oyez_filenames.add(out_href)
                        cases_modified = True

                    time.sleep(0.3)
                except Exception as exc:
                    print(f'ERROR: {exc}')
                    errors += 1

        # ── Opinion announcements ─────────────────────────────────────────────
        if local_case is not None:
            _has_unique = any(a.get('unique') for a in local_case.get('events', []))
            # For consolidated cases, track which opinion dates are already covered
            # by any component so secondary components don't add duplicate entries.
            _is_secondary = (is_consolidated
                             and number != _normalize_case_num(
                                 _local_number.split(',')[0].strip()))
            _existing_opinion_dates: set[str] = set()
            if _is_secondary:
                for _a in local_case.get('events', []):
                    if _a.get('type') == 'opinion' and _a.get('date'):
                        _existing_opinion_dates.add(_a['date'])
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

                if _has_unique:
                    skipped += len(parts)
                    continue
                # Secondary component of a consolidated case: skip if the lead
                # (or any other component) already has an opinion for this date.
                if _is_secondary and date_str in _existing_opinion_dates:
                    skipped += len(parts)
                    continue
                if use_parts:
                    unnumbered = case_dir / _oyez_filename(date_str)
                    part1_path = case_dir / _oyez_filename(date_str, 1)
                    if unnumbered.exists() and not part1_path.exists():
                        unnumbered.rename(part1_path)
                        print(f'  {number}: renamed {unnumbered.name} → {part1_path.name}')
                        for a in local_case.get('events', []):
                            if (a.get('source') == 'oyez' and a.get('date') == date_str
                                    and a.get('text_href') == number + '/' + unnumbered.name):
                                a['text_href'] = number + '/' + part1_path.name
                                a['title'] = _audio_title('opinion', date_str, 1,
                                                           case_num_for_title)
                                existing_oyez_filenames.discard(number + '/' + unnumbered.name)
                                existing_oyez_filenames.add(number + '/' + part1_path.name)
                                cases_modified = True
                                break

                for part_idx, oyez_opinion in enumerate(parts, start=1):
                    part_num  = part_idx if use_parts else 0
                    out_fname = _oyez_filename(date_str, part_num)
                    out_path  = case_dir / out_fname
                    out_href  = number + '/' + out_fname

                    if out_href in existing_oyez_filenames and not _needs_format_refresh(out_path):
                        skipped += 1
                        continue
                    if out_path.exists() and not _needs_format_refresh(out_path):
                        skipped += 1
                        continue

                    label = f'Part {part_num} ' if use_parts else ''
                    print(f'  {number} opinion ({date_str}) {label}...', end=' ', flush=True)
                    try:
                        envelope, mp3_url = fetch_oyez_transcript(oyez_opinion['href'], justices)
                        if envelope is None:
                            # No transcript, but still record the audio entry if it's new.
                            if mp3_url and mp3_url not in existing_oyez_filenames and out_href not in existing_oyez_filenames:
                                new_entry = reorder_event({
                                    'source':     'oyez',
                                    'type':       'opinion',
                                    'date':       date_str,
                                    'title':      _audio_title('opinion', date_str, part_num, case_num_for_title),
                                    'audio_href': mp3_url,
                                })
                                local_case.setdefault('events', []).append(new_entry)
                                existing_oyez_filenames.add(mp3_url)
                                cases_modified = True
                                print('no transcript \u2014 audio entry added')
                            else:
                                print('no transcript data')
                            continue

                        apply_speaker_map(envelope, speaker_map, title_map)
                        _merge_envelope_speakers(out_path, envelope)
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

                        if out_href not in existing_oyez_filenames:
                            audio_href = (envelope.get('media') or {}).get('url', '')
                            new_entry = reorder_event({
                                'source':     'oyez',
                                'type':       'opinion',
                                'date':       date_str,
                                'title':      _audio_title('opinion', date_str, part_num, case_num_for_title),
                                'audio_href': audio_href,
                                'text_href':  out_href,
                                'aligned':    True if _turns_are_aligned(envelope) else None,
                            })
                            if new_entry.get('aligned') is None:
                                del new_entry['aligned']
                            local_case.setdefault('events', []).append(new_entry)
                            existing_oyez_filenames.add(out_href)
                            cases_modified = True

                        time.sleep(0.3)
                    except Exception as exc:
                        print(f'ERROR: {exc}')
                        errors += 1

    # ── Supplementary pass: consolidated cases ────────────────────────────────
    # For cases that combine multiple docket numbers, ensure audio from ALL
    # component numbers is present in the consolidated case entry.  The main
    # loop only maps a component number to the consolidated case when that
    # component has no separate case entry of its own; this pass handles the
    # remaining components (those that do have their own entries) and also
    # backfills " in No. N" titles on all existing audio entries.
    for local_case in our_cases:
        local_number = local_case.get('number', '')
        if ',' not in local_number:
            continue
        component_nums = [_normalize_case_num(n.strip()) for n in local_number.split(',')]
        # Only disambiguate with " in No. N" when multiple components have Oyez data.
        oyez_component_nums = [cn for cn in component_nums if cn in oyez_by_num]
        use_case_nums = len(oyez_component_nums) > 1

        # ── Fix text_href folder vs audio_href case number mismatches ──────────
        # If audio_href implies case number B but text_href is stored under folder
        # A, move the file from A/ to B/ and update text_href.
        _cases_dir = cases_path.parent / 'cases'
        for a in local_case.get('events', []):
            if a.get('source') != 'oyez':
                continue
            th = a.get('text_href', '')
            if not th or '/' not in th:
                continue
            folder_num, fname = th.split('/', 1)
            cn_audio = _case_num_from_href('', a.get('audio_href', ''))
            if cn_audio and cn_audio != folder_num and cn_audio in component_nums:
                src_path = _cases_dir / folder_num / fname
                dest_dir = _cases_dir / cn_audio
                dest_path = dest_dir / fname
                # Validate: the file's media.url must match the stored audio_href
                # before we move it.  If they differ, the file belongs to a
                # different component and should stay where it is.
                audio_href_val = a.get('audio_href', '')
                if src_path.exists() and audio_href_val:
                    try:
                        _fd = json.loads(src_path.read_text(encoding='utf-8'))
                        file_url = (_fd.get('media') or {}).get('url', '')
                    except Exception:
                        file_url = ''
                    if file_url and file_url != audio_href_val:
                        print(f'  WARNING: {th} media.url ≠ audio_href — skipping refile')
                        continue
                if src_path.exists():
                    dest_dir.mkdir(parents=True, exist_ok=True)
                    src_path.rename(dest_path)
                    print(f'  {local_number}: moved {folder_num}/{fname} → {cn_audio}/{fname}')
                    # Remove source folder if now empty
                    src_folder = _cases_dir / folder_num
                    try:
                        if src_folder.is_dir() and not any(src_folder.iterdir()):
                            src_folder.rmdir()
                    except Exception:
                        pass
                a['text_href'] = cn_audio + '/' + fname
                cases_modified = True

        # ── Backfill " in No. N" on every existing non-opinion audio entry ──────
        # Only when multiple components have Oyez data (otherwise titles are unambiguous).
        for a in local_case.get('events', []):
            if a.get('type') == 'opinion':
                continue  # opinions don't get a case number in the title
            has_case_num = ' in No.' in (a.get('title') or '')
            cn = _case_num_from_href(a.get('text_href', ''), a.get('audio_href', ''))
            if not (cn and cn in component_nums):
                continue
            type_v = a.get('type', 'argument')
            date_v = a.get('date', '')
            part_m = re.search(r'Part (\d+)', a.get('title') or '')
            part_n = int(part_m.group(1)) if part_m else 0
            if use_case_nums and not has_case_num:
                a['title'] = _audio_title(type_v, date_v, part_n, cn)
                cases_modified = True
            elif not use_case_nums and has_case_num:
                # Strip previously added " in No. N"
                a['title'] = _audio_title(type_v, date_v, part_n, '')
                cases_modified = True

        # ── Add missing audio from each component number ───────────────────────
        for comp_num in component_nums:
            oyez_case = oyez_by_num.get(comp_num)
            if not oyez_case:
                continue
            if case_filter and comp_num != case_filter and local_number != case_filter:
                continue

            comp_dir = cases_path.parent / 'cases' / comp_num

            # Decision date for this component: use the consolidated case's
            # decision, which already reflects the earliest decision for the group.
            _comp_decision = local_case.get('decision', '')

            # Existing oyez hrefs already recorded for this component number
            # (by text_href folder OR by audio_href containing the case number).
            existing_comp: set[str] = {
                a['text_href']
                for a in local_case.get('events', [])
                if a.get('source') == 'oyez' and a.get('text_href', '').startswith(comp_num + '/')
            }
            # All existing oyez audio_hrefs (for dedup when we know the mp3 URL).
            existing_oyez_audio_hrefs: set[str] = {
                a.get('audio_href', '')
                for a in local_case.get('events', [])
                if a.get('source') == 'oyez' and a.get('audio_href')
            }
            existing_comp_mp3s: set[str] = {
                a.get('audio_href', '')
                for a in local_case.get('events', [])
                if a.get('source') == 'oyez' and not a.get('text_href')
                and a.get('audio_href')
            }

            try:
                detail = fetch_json(oyez_case['href'])
                time.sleep(0.2)
            except Exception as exc:
                print(f'  {local_number} / {comp_num}: ERROR fetching: {exc}')
                errors += 1
                continue

            # Skip this component if the Oyez data contains any audio date
            # outside the current term's range — it has been refiled into a
            # later term and will be processed when that term is imported.
            _comp_dates = [
                parse_oyez_date(_oa.get('title', ''))
                for section in ('oral_argument_audio', 'opinion_announcement')
                for _oa in (detail.get(section) or [])
                if not _oa.get('unavailable')
            ]
            if any(d and (d < term_start or d >= next_term_start) for d in _comp_dates):
                print(f'  {local_number} / {comp_num}: has audio outside term range '
                      f'({term_start} – {next_term_start}) — skipping component')
                continue

            for section_key, base_type in [
                ('oral_argument_audio', 'argument'),
                ('opinion_announcement', 'opinion'),
            ]:
                arg_list = detail.get(section_key) or []
                comp_by_date: dict[str, list] = {}
                for oyez_arg in arg_list:
                    if not oyez_arg or oyez_arg.get('unavailable'):
                        continue
                    date_str = parse_oyez_date(oyez_arg.get('title', ''))
                    if not date_str:
                        continue
                    if _comp_decision and date_str > _comp_decision:
                        print(f'  {local_number} / {comp_num}: skipping audio on '
                              f'{date_str} (after decision {_comp_decision})')
                        continue
                    comp_by_date.setdefault(date_str, []).append(oyez_arg)

                for date_str, parts in comp_by_date.items():
                    use_parts = len(parts) > 1
                    for part_idx, oyez_arg in enumerate(parts, start=1):
                        part_num  = part_idx if use_parts else 0
                        out_fname = _oyez_filename(date_str, part_num)
                        out_href  = comp_num + '/' + out_fname
                        out_path  = comp_dir / out_fname
                        type_val  = (base_type if base_type == 'opinion'
                                     else _oyez_arg_type(oyez_arg.get('title', '')))

                        if type_val == 'opinion' and any(
                                a.get('unique') for a in local_case.get('events', [])):
                            skipped += 1
                            continue

                        if (out_href in existing_comp and out_path.exists()
                                and not _needs_format_refresh(out_path)):
                            skipped += 1
                            continue

                        label = f'Part {part_num} ' if use_parts else ''
                        print(f'  {local_number} / {comp_num} ({date_str}) {label}...',
                              end=' ', flush=True)
                        try:
                            if out_path.exists() and not _needs_format_refresh(out_path):
                                # Already on disk (processed for the separate case) —
                                # just add a reference without re-downloading.
                                try:
                                    _d    = json.loads(out_path.read_text(encoding='utf-8'))
                                    mp3   = (_d.get('media') or {}).get('url', '')
                                    algnd = _turns_are_aligned(_d)
                                except Exception:
                                    mp3 = algnd = ''
                                # Skip if the same mp3 is already tracked under a
                                # different entry (e.g. the other component number).
                                if mp3 and mp3 in existing_oyez_audio_hrefs:
                                    skipped += 1
                                    print('already tracked \u2014 skipped')
                                    continue
                                print('already on disk \u2014 adding reference')
                            else:
                                envelope, mp3 = fetch_oyez_transcript(oyez_arg['href'], justices)
                                if envelope is None:
                                    if mp3 and mp3 not in existing_comp_mp3s:
                                        new_entry = reorder_event({
                                            'source':     'oyez',
                                            'type':       type_val,
                                            'date':       date_str,
                                            'title':      _audio_title(type_val, date_str, part_num, comp_num if use_case_nums else ''),
                                            'audio_href': mp3,
                                        })
                                        local_case.setdefault('events', []).append(new_entry)
                                        existing_comp_mp3s.add(mp3)
                                        cases_modified = True
                                        print('no transcript \u2014 audio entry added')
                                    else:
                                        print('no transcript data')
                                    continue
                                apply_speaker_map(envelope, speaker_map, title_map)
                                _merge_envelope_speakers(out_path, envelope)
                                comp_dir.mkdir(parents=True, exist_ok=True)
                                out_path.write_text(
                                    json.dumps(envelope, indent=2, ensure_ascii=False) + '\n',
                                    encoding='utf-8',
                                )
                                mp3   = (envelope.get('media') or {}).get('url', '')
                                algnd = _turns_are_aligned(envelope)
                                try:
                                    rel = out_path.relative_to(REPO_ROOT)
                                except ValueError:
                                    rel = out_path
                                print(f'{len(envelope["turns"])} turns -> {rel}')
                                downloaded += 1
                                time.sleep(0.3)
                                # After downloading: skip if this mp3 is already
                                # tracked under a different entry.
                                if mp3 and mp3 in existing_oyez_audio_hrefs:
                                    skipped += 1
                                    print('already tracked — skipped')
                                    continue

                            new_entry = reorder_event({
                                'source':     'oyez',
                                'type':       type_val,
                                'date':       date_str,
                                'title':      _audio_title(type_val, date_str, part_num, comp_num if use_case_nums else ''),
                                'audio_href': mp3,
                                'text_href':  out_href,
                                'aligned':    True if algnd else None,
                            })
                            if new_entry.get('aligned') is None:
                                del new_entry['aligned']
                            local_case.setdefault('events', []).append(new_entry)
                            existing_comp.add(out_href)
                            if mp3:
                                existing_oyez_audio_hrefs.add(mp3)
                            cases_modified = True
                        except Exception as exc:
                            print(f'ERROR: {exc}')
                            errors += 1

    if cases_modified:
        cases_path.write_text(
            json.dumps(our_cases, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print(f'Updated {cases_path.relative_to(REPO_ROOT)}')

    # Write any later-term cases.json files modified during redirect processing.
    for _rpath, _lcase, _snap in _redirect_snapshots:
        if json.dumps(_lcase, sort_keys=True) != _snap:
            _rpath.write_text(
                json.dumps(_redir_files[_rpath], indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )
            print(f'Updated {_rpath.relative_to(REPO_ROOT)} (via redirect)')

    sync_files_count(cases_path)

    print()
    print(f'Done.  Downloaded: {downloaded}  |  Already existed: {skipped}  |  Errors: {errors}')


if __name__ == '__main__':
    main()
