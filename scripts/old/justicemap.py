#!/usr/bin/env python3
"""Fix transcripts for justices who argued before the Court before being appointed.

Reads scripts/justicemap.md, extracts each justice's name and their oyez.org
case URLs, then for each case finds transcript JSON files and:
  - Replaces the justice's formal name (e.g. "JUSTICE KAGAN") with their full
    name (e.g. "ELENA KAGAN")
  - Changes the speaker's role from "justice" to "advocate"

Also syncs courts/ussc/collections/1.json with all cases listed in
justicemap.md, resolving pre-Oyez cases (LOC, Justia, Oyez multi-year URLs)
via US Reports volume+page lookup across all local cases.json files.

Warnings are printed when:
  1. No transcript folder or files exist for a case.
  2. Transcripts were found but the justice's name was already corrected.
  3. Transcripts were found but the justice's formal name did not appear in any.

Usage:
    python3 scripts/justicemap.py [--dry-run]
"""

import html
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

REPO_ROOT       = Path(__file__).resolve().parent.parent.parent
TERMS_DIR       = REPO_ROOT / 'courts' / 'ussc' / 'terms'
JUSTICEMAP      = Path(__file__).resolve().parent / 'justicemap.md'
COLLECTION_PATH = REPO_ROOT / 'courts' / 'ussc' / 'collections' / '1.json'

_HEADING_RE    = re.compile(r'^## ((?:CHIEF )?JUSTICE .+)$')
_OYEZ_URL_RE   = re.compile(r'https://www\.oyez\.org/cases/(\d{4})/([^\s\)]+)')
_SUFFIX_RE     = re.compile(r',?\s+(?:JR|SR|II|III|IV)\.?$', re.IGNORECASE)
# URL patterns for pre-Oyez cases (LOC tile, Oyez multi-year span, Justia)
_LOC_USREP_RE  = re.compile(
    r'https://tile\.loc\.gov/[^)]+/usrep(\d+)/usrep\d+(\d{3})/[^)]+\.pdf')
_OYEZ_MULTI_RE = re.compile(
    r'https://www\.oyez\.org/cases/\d{4}-\d{4}/(\d+)us(\d+)')
_JUSTIA_US_RE  = re.compile(
    r'https://supreme\.justia\.com/cases/federal/us/(\d+)/(\d+)/')
_CASE_LINK_RE  = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')
_DATE_JSON_RE = re.compile(r'^\d{4}-\d{2}-\d{2}.*\.json$')
_MONTHS_PAT   = (r'January|February|March|April|May|June|July|August|September|'
                 r'October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec')
_ARGUED_DATE_RE = re.compile(
    r'(?:[Aa]rgued\s+)?((?:' + _MONTHS_PAT + r')\s+\d+'
    r'(?:\s*[-\u2013]\s*(?:\d+|(?:' + _MONTHS_PAT + r')\s+\d+))?'
    r'(?:\s+and\s+\d+)?'
    r',\s*\d{4})',
    re.IGNORECASE,
)


def _parse_heading(heading: str) -> tuple[str, str, str]:
    """Parse a ## heading like 'CHIEF JUSTICE WILLIAM H. REHNQUIST'.

    Returns (prefix, full_name, formal_name):
      prefix      = 'CHIEF JUSTICE' or 'JUSTICE'
      full_name   = 'WILLIAM H. REHNQUIST'   (name to replace with)
      formal_name = 'CHIEF JUSTICE REHNQUIST' (name as it appears in transcripts)
    """
    if heading.startswith('CHIEF JUSTICE '):
        prefix    = 'CHIEF JUSTICE'
        full_name = heading[len('CHIEF JUSTICE '):]
    else:
        prefix    = 'JUSTICE'
        full_name = heading[len('JUSTICE '):]
    full_name = full_name.strip()

    # Strip generational suffixes before extracting the last name
    last_name = _SUFFIX_RE.sub('', full_name).strip().split()[-1]
    formal_name = f'{prefix} {last_name}'
    return prefix, full_name, formal_name


def load_justicemap() -> list[tuple[str, str, str, list[tuple[str, str]]]]:
    """Parse justicemap.md.

    Returns a list of (prefix, full_name, formal_name, cases) where cases is
    a list of (term, case_number) pairs derived from oyez.org URLs.  Only
    URLs with a plain 4-digit year are included (multi-year spans like
    '1940-1955' are skipped).
    """
    text    = JUSTICEMAP.read_text(encoding='utf-8')
    results = []

    current_heading:  str | None       = None
    in_cases_argued:  bool             = False
    current_cases:    list[tuple[str, str]] = []

    for line in text.splitlines():
        h_match = _HEADING_RE.match(line)
        if h_match:
            if current_heading is not None:
                results.append((*_parse_heading(current_heading), current_cases))
            current_heading = h_match.group(1).strip()
            in_cases_argued = False
            current_cases   = []
        elif line.strip() == '### Cases Argued':
            in_cases_argued = True
        elif in_cases_argued:
            for m in _OYEZ_URL_RE.finditer(line):
                year, case = m.group(1), m.group(2)
                # Normalise "N_misc" → "N-Misc" to match folder convention.
                case = re.sub(r'_([a-z])', lambda mm: '-' + mm.group(1).upper(), case)
                current_cases.append((f'{year}-10', case))

    if current_heading is not None:
        results.append((*_parse_heading(current_heading), current_cases))

    return results


def _names_in_transcript(data: dict) -> set[str]:
    names: set[str] = set()
    for sp in (data.get('media') or {}).get('speakers') or []:
        names.add(sp.get('name', ''))
    for turn in data.get('turns') or []:
        names.add(turn.get('name', ''))
    return names


def _apply_fix(data: dict, formal_name: str, full_name: str) -> bool:
    """Update speakers + turns in-place. Returns True if any change was made."""
    modified = False
    for sp in (data.get('media') or {}).get('speakers') or []:
        if sp.get('name') == formal_name:
            sp['name'] = full_name
            sp['role'] = 'advocate'
            modified   = True
    for turn in data.get('turns') or []:
        if turn.get('name') == formal_name:
            turn['name'] = full_name
            modified      = True
    return modified


def process_justice(
    prefix: str,
    full_name:   str,
    formal_name: str,
    cases:       list[tuple[str, str]],
    dry_run:     bool,
) -> None:
    print(f'\n{prefix} {full_name}')
    if not cases:
        print('  No Oyez cases to process.')
        return

    for term, case_number in cases:
        case_dir = TERMS_DIR / term / 'cases' / case_number
        label    = f'  {term}/{case_number}:'

        if not case_dir.is_dir():
            print(f'{label} WARNING: no transcript folder at '
                  f'courts/ussc/terms/{term}/cases/{case_number}/')
            continue

        transcripts = sorted(
            f for f in case_dir.iterdir()
            if f.is_file() and _DATE_JSON_RE.match(f.name)
        )
        if not transcripts:
            print(f'{label} WARNING: folder exists but contains no transcript files')
            continue

        # Categorise each transcript file before deciding what to do.
        needs_fix:        list[tuple[Path, dict]] = []
        already_corrected: list[Path]              = []
        name_missing:      list[Path]              = []

        for t in transcripts:
            try:
                data = json.loads(t.read_text(encoding='utf-8'))
            except Exception as exc:
                print(f'{label} ERROR reading {t.name}: {exc}')
                continue
            if not isinstance(data, dict):
                continue

            found = _names_in_transcript(data)
            if formal_name in found:
                needs_fix.append((t, data))
            elif full_name in found:
                already_corrected.append(t)
            else:
                name_missing.append(t)

        if needs_fix:
            fixed_names = []
            for t, data in needs_fix:
                changed = _apply_fix(data, formal_name, full_name)
                if changed and not dry_run:
                    t.write_text(
                        json.dumps(data, indent=2, ensure_ascii=False) + '\n',
                        encoding='utf-8',
                    )
                fixed_names.append(t.name)
            verb = 'would fix' if dry_run else 'fixed'
            print(f'{label} {verb}: {", ".join(fixed_names)}')
        else:
            if already_corrected:
                files = ', '.join(f.name for f in already_corrected)
                print(f'{label} WARNING: already corrected ({full_name!r} found in {files})')
            else:
                files = ', '.join(f.name for f in name_missing) or '(none)'
                print(f'{label} WARNING: {formal_name!r} not found in any transcript '
                      f'({files})')


# ── Collection sync helpers ─────────────────────────────────────────────────

def _vol_page_from_url(url: str) -> tuple[str, str] | None:
    """Extract (volume, page) as normalized strings from LOC/Oyez-multi/Justia URLs."""
    for pat in (_LOC_USREP_RE, _OYEZ_MULTI_RE, _JUSTIA_US_RE):
        m = pat.search(url)
        if m:
            return str(int(m.group(1))), str(int(m.group(2)))
    return None


def _normalize_case_number(raw: str) -> str:
    """Take the first docket from a comma-separated list and normalize Misc/Orig format.

    Examples:
      '50,265-Misc,...' → '50'
      '1-Misc'          → '1-Misc'
      '1-Misc.'         → '1-Misc'
      '1 Misc.'         → '1-Misc'
      '120-Orig.'       → '120-Orig'
    """
    first = raw.split(',')[0].strip()
    m = re.match(r'^(\d+)\s*[-\u2013]?\s*(Misc|Orig)\.?$', first, re.IGNORECASE)
    if m:
        return f'{m.group(1)}-{m.group(2).capitalize()}'
    return first


def _oyez_term_case(url: str) -> tuple[str, str] | None:
    """Extract (term, case_number) from a 4-digit-year Oyez URL."""
    m = _OYEZ_URL_RE.search(url)
    if not m:
        return None
    year, case = m.group(1), m.group(2)
    case = re.sub(r'_([a-z])', lambda mm: '-' + mm.group(1).upper(), case)
    return f'{year}-10', case


def _display_name(full_name_upper: str) -> str:
    """'SAMUEL A. ALITO, JR.' → 'Samuel A. Alito, Jr.'"""
    return ' '.join(w.capitalize() for w in full_name_upper.split())


def _parse_first_arg_date_iso(note: str) -> str | None:
    """Extract the first argued date from a parenthetical note as 'YYYY-MM-DD'.

    Handles formats like 'Argued March 24, 2009', 'Argued January 9-10, 1951',
    'Argued February 28-March 2, 1966', 'November 9, 1965' (no Argued prefix).
    """
    if not note:
        return None
    m = _ARGUED_DATE_RE.search(note)
    if not m:
        return None
    raw = m.group(1)  # e.g. 'March 24, 2009' or 'January 9-10, 1951'
    # Normalise: strip any trailing day range before the comma+year
    # 'January 9-10, 1951' → 'January 9, 1951'
    raw = re.sub(r'(\d+)\s*[-\u2013]\s*(?:\d+|(?:' + _MONTHS_PAT + r')\s+\d+)', r'\1', raw, flags=re.IGNORECASE)
    # 'November 10 and 12, 1943' → 'November 10, 1943'
    raw = re.sub(r'(\d+)\s+and\s+\d+', r'\1', raw)
    raw = raw.strip().lstrip(',')
    for fmt in ('%B %d, %Y', '%b %d, %Y'):
        try:
            return datetime.strptime(raw.strip(), fmt).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return None


def audio_index_for_date(audio_list: list, iso_date: str | None) -> int:
    """Return 1-based index of the audio entry whose date matches iso_date.

    The list is sorted by date ascending before indexing. Returns 1 if no
    match is found or no date is given.
    """
    if not audio_list:
        return 1
    sorted_audio = sorted(audio_list, key=lambda a: (a.get('date') or ''))
    if iso_date:
        for i, entry in enumerate(sorted_audio):
            if entry.get('date') == iso_date:
                return i + 1
    return 1


def build_cases_index() -> dict[tuple[str, str], dict]:
    """Return {(term, number): case_obj} from all local cases.json files."""
    index: dict[tuple[str, str], dict] = {}
    for cases_file in sorted(TERMS_DIR.glob('*/cases.json')):
        term = cases_file.parent.name
        try:
            cases = json.loads(cases_file.read_text(encoding='utf-8'))
        except Exception:
            continue
        for c in cases:
            raw = str(c.get('number') or '').strip()
            number = raw.split(',')[0].strip()
            index[(term, number)] = c
    return index


def build_vol_page_index() -> dict[tuple[str, str], tuple[str, str]]:
    """Return {(volume, page): (term, number)} from all local cases.json files."""
    index: dict[tuple[str, str], tuple[str, str]] = {}
    for cases_file in sorted(TERMS_DIR.glob('*/cases.json')):
        term = cases_file.parent.name
        try:
            cases = json.loads(cases_file.read_text(encoding='utf-8'))
        except Exception:
            continue
        for c in cases:
            vol  = c.get('volume', '')
            page = c.get('page', '')
            if vol and page:
                try:
                    key = (str(int(vol)), str(int(page)))
                except ValueError:
                    continue
                index[key] = (term, str(c.get('number', '')))
    return index


def load_all_justice_cases() -> list[dict]:
    """Parse justicemap.md, returning all justice groups with all cases (all URL types).

    Each entry is a dict with keys: display_name, prefix, full_name, formal_name,
    and cases (a list of {name, url} dicts in markdown order).
    """
    text    = JUSTICEMAP.read_text(encoding='utf-8')
    results: list[dict] = []
    current: dict | None  = None
    in_cases_argued: bool = False

    for line in text.splitlines():
        h_match = _HEADING_RE.match(line)
        if h_match:
            if current is not None:
                results.append(current)
            prefix, full_name, formal_name = _parse_heading(h_match.group(1).strip())
            current = {
                'display_name': _display_name(full_name),
                'prefix':       prefix,
                'full_name':    full_name,
                'formal_name':  formal_name,
                'cases':        [],
            }
            in_cases_argued = False
        elif current is not None:
            if line.strip() == '### Cases Argued':
                in_cases_argued = True
            elif in_cases_argued:
                lm = _CASE_LINK_RE.search(line)
                if lm:
                    note = line[lm.end():].strip()
                    current['cases'].append({
                        'name': html.unescape(lm.group(1).strip()),
                        'url':  lm.group(2).strip(),
                        'note': note,
                    })

    if current is not None:
        results.append(current)
    return results


def sync_collection(dry_run: bool) -> None:
    """Update COLLECTION_PATH with any cases from justicemap.md not yet listed."""
    print('\n── Syncing collection ──')
    vol_page_index = build_vol_page_index()
    cases_index    = build_cases_index()
    justices       = load_all_justice_cases()

    try:
        coll = json.loads(COLLECTION_PATH.read_text(encoding='utf-8'))
    except Exception as exc:
        print(f'  ERROR: cannot read {COLLECTION_PATH}: {exc}')
        return

    groups_by_name: dict[str, dict] = {g['name']: g for g in coll}
    total_added = 0

    for justice in justices:
        disp = justice['display_name']

        # Resolve each markdown case to (name, term, number).
        md_cases: list[dict] = []
        for case in justice['cases']:
            url, name, note = case['url'], case['name'], case.get('note', '')
            tc = _oyez_term_case(url)
            if tc:
                term, number = tc
                number = _normalize_case_number(number)
            else:
                vp = _vol_page_from_url(url)
                if not vp:
                    continue  # unrecognised URL type, skip
                result = vol_page_index.get(vp)
                if not result:
                    print(f'  [{disp}] WARN: no local case for '
                          f'vol={vp[0]} page={vp[1]} ({name})')
                    continue
                term, raw_number = result
                number = _normalize_case_number(raw_number)

            # 'argued and reargued' without specific dates → two entries
            is_dual = bool(re.search(r'\bargued\s+and\s+reargued\b', note, re.IGNORECASE))
            if is_dual:
                md_cases.append({'name': name, 'term': term, 'number': str(number), 'forced_audio': 1})
                md_cases.append({'name': name, 'term': term, 'number': str(number), 'forced_audio': 2})
            else:
                arg_date_iso = _parse_first_arg_date_iso(note)
                md_cases.append({'name': name, 'term': term, 'number': str(number), 'arg_date_iso': arg_date_iso})

        if not md_cases:
            continue

        # Get or create the collection group.
        group = groups_by_name.get(disp)
        if group is None:
            group = {'name': disp, 'cases': []}
            coll.append(group)
            groups_by_name[disp] = group

        existing: list[dict] = group.get('cases', [])

        # How many times each (term, number) is wanted (from the markdown).
        md_counts: Counter = Counter((mc['term'], mc['number']) for mc in md_cases)

        # How many times each (term, number) already exists in the collection.
        # Normalize stored numbers to guard against legacy format mismatches.
        existing_counts: Counter = Counter(
            (e.get('term', ''), _normalize_case_number(str(e.get('number', ''))))
            for e in existing
        )

        # Add only the deficit: entries present in md_cases but not yet in the
        # collection (or present fewer times than the markdown requires, e.g.
        # a case argued and reargued needs two entries).
        seen: Counter = Counter()
        to_add: list[dict] = []
        for mc in md_cases:
            k = (mc['term'], mc['number'])
            need = md_counts[k]
            have = existing_counts.get(k, 0)
            if seen[k] < need - have:
                to_add.append(mc)
            seen[k] += 1

        # Insert new entries in term order, preserving existing entries.
        new_existing = list(existing)
        for new_case in to_add:
            insert_pos = len(new_existing)
            for i, e in enumerate(new_existing):
                if e.get('term', '') > new_case['term']:
                    insert_pos = i
                    break
            new_existing.insert(insert_pos, {
                'title':  new_case['name'],
                'term':   new_case['term'],
                'number': new_case['number'],
            })

        # Build audio plan: (term, number) → ordered list of assignments from md_cases.
        audio_plan: dict[tuple[str, str], list[dict]] = {}
        for mc in md_cases:
            k = (mc['term'], mc['number'])
            audio_plan.setdefault(k, []).append({
                'forced_audio': mc.get('forced_audio'),
                'arg_date_iso': mc.get('arg_date_iso'),
            })

        # Annotate all entries (new and existing): strip year suffix from title,
        # add decision, set audio, verify then omit opinion_href.
        _year_suffix_re = re.compile(r'\s+\((\d{4})\)$')
        before = json.dumps(new_existing, ensure_ascii=False)
        seen_by_key: Counter = Counter()
        for entry in new_existing:
            k = (entry.get('term', ''), str(entry.get('number', '')))
            live = cases_index.get(k)
            if not live:
                print(f'  [{disp}] WARNING: case not found in cases.json: {k[0]}/{k[1]}')
                entry.pop('decision', None)
                entry.pop('audio', None)
                entry.pop('opinion_href', None)
                seen_by_key[k] += 1
                continue

            # Strip " (<year>)" from title; verify it matches the decision YYYY.
            raw_title = entry.get('title', '')
            ym = _year_suffix_re.search(raw_title)
            title_year = ym.group(1) if ym else None
            clean_title = raw_title[:ym.start()] if ym else raw_title
            decision = live.get('decision')
            if title_year and decision and title_year != decision[:4]:
                print(f'  WARNING: year mismatch for {k[0]}/{k[1]}: '
                      f'title year={title_year}, decision={decision}')

            # Verify opinion_href matches if both present, then omit it.
            live_opinion = live.get('opinion_href')
            entry_opinion = entry.get('opinion_href')
            if live_opinion and entry_opinion and live_opinion != entry_opinion:
                print(f'  WARNING: opinion_href mismatch for {k[0]}/{k[1]}')

            # Audio: forced index for reargued cases, otherwise 1.
            audio_val: int | None = None
            if live.get('audio'):
                plan = audio_plan.get(k, [])
                plan_entry = plan[seen_by_key[k]] if seen_by_key[k] < len(plan) else {}
                forced = plan_entry.get('forced_audio')
                audio_val = forced if forced is not None else 1

            # Rebuild entry in correct field order (opinion_href omitted).
            entry.clear()
            entry['title'] = clean_title
            entry['term'] = k[0]
            entry['number'] = k[1]
            if decision:
                entry['decision'] = decision
            if audio_val is not None:
                entry['audio'] = audio_val
            seen_by_key[k] += 1
        after = json.dumps(new_existing, ensure_ascii=False)
        annotations_changed = (before != after)

        if not to_add and not annotations_changed:
            continue

        group['cases'] = new_existing
        total_added += len(to_add)
        if to_add:
            verb = 'Would add' if dry_run else 'Added'
            names_str = ', '.join(c['name'] for c in to_add[:4])
            if len(to_add) > 4:
                names_str += f', \u2026 (+{len(to_add) - 4} more)'
            print(f'  [{disp}] {verb} {len(to_add)}: {names_str}')

    # Sort groups by last name (stripping generational suffixes like ", Jr.").
    def _last_name_key(group: dict) -> str:
        name = re.sub(r',?\s+(?:Jr|Sr|II|III|IV)\.?$', '', group.get('name', ''), flags=re.IGNORECASE).strip()
        return name.split()[-1] if name else ''

    coll.sort(key=_last_name_key)

    coll_changed = json.dumps(coll, indent=2, ensure_ascii=False) + '\n' != COLLECTION_PATH.read_text(encoding='utf-8')

    if coll_changed and not dry_run:
        COLLECTION_PATH.write_text(
            json.dumps(coll, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        print(f'Wrote {COLLECTION_PATH.relative_to(REPO_ROOT)} (+{total_added} cases, annotations updated)')
    elif coll_changed:
        print(f'[dry-run] would write +{total_added} cases, annotations updated')
    else:
        print('Collection is already up to date.')


def main() -> None:
    dry_run = '--dry-run' in sys.argv
    if dry_run:
        print('[DRY RUN — no files will be modified]')

    justices = load_justicemap()
    for prefix, full_name, formal_name, cases in justices:
        process_justice(prefix, full_name, formal_name, cases, dry_run)

    sync_collection(dry_run)


if __name__ == '__main__':
    main()
