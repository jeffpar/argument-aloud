#!/usr/bin/env python3
"""Validate and fix mis-filed cases in courts/ussc/terms/.

For each term YYYY-MM, the expected range is:
  decision >= YYYY-MM-01  (start of the term's month)
  decision <  NEXT-MM-01  (start of the next term's month, if one exists)

Cases whose 'decision' falls outside that range are moved to the correct term.
When a folder conflict exists in the target term, merging is attempted if:
  - The dest case has an 'id' and the source does not.
  - Both have the same 'number'.
On a successful merge:
  - dest title ← source title
  - source 'decision' inserted after dest 'number'
  - Source audio entries appended to dest audio (no duplicate audio_href)
  - Local text_href files moved from source to dest case folder
  - Source files.json entries added to dest files.json; dest 'files' count updated
  - Source case object removed, its files.json removed, its empty folder removed
On a plain move (no conflict):
  - 'previouslyFiled' inserted before 'decision' in the moved case object

Usage:
    python3 scripts/validate_terms.py [TERM] [--dry-run]
"""

import json
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TERMS_DIR = REPO_ROOT / 'courts' / 'ussc' / 'terms'


def term_start(term: str) -> str:
    """Return the first day of the term's month as a YYYY-MM-DD string."""
    year, month = term.split('-')
    return f'{year}-{month}-01'


def case_folder_name(case: dict) -> str:
    """Return the disk folder name for a case (mirrors JS caseDirName)."""
    number = case.get('number', '')
    if number:
        return str(number).split(',')[0].strip()
    return case.get('id', '')


def find_target_term(decision: str, terms: list[str]) -> str | None:
    """Return the term whose range contains decision, or None."""
    target = None
    for t in terms:
        if term_start(t) <= decision:
            target = t
        else:
            break
    return target


def insert_previously_filed(case: dict, original_term: str) -> dict:
    """Return a new case dict with 'previouslyFiled' inserted before 'decision'."""
    new_case: dict = {}
    inserted = False
    for k, v in case.items():
        if k == 'decision' and not inserted:
            new_case['previouslyFiled'] = original_term
            inserted = True
        new_case[k] = v
    if not inserted:
        new_case['previouslyFiled'] = original_term
    return new_case


def can_merge(src_case: dict, dst_case: dict) -> bool:
    """Return True if src can be merged into dst.

    Merging is allowed when src lacks an id, both share the same number, and
    either:
      - dest has an id (it's the authoritative record), OR
      - dest has neither an id nor a decision (it's an incomplete stub).
    """
    if 'id' in src_case:
        return False
    if not src_case.get('number'):
        return False
    if src_case.get('number') != dst_case.get('number'):
        return False
    return 'id' in dst_case or ('id' not in dst_case and 'decision' not in dst_case)


def do_merge(
    src_case: dict,
    dst_case: dict,
    src_folder: Path | None,
    dst_folder: Path | None,
    src_term: str,
    dry_run: bool,
) -> None:
    """Merge src_case into dst_case in-place, moving files as needed."""

    # 1. Replace dest title with source title.
    dst_case['title'] = src_case['title']

    # 2. Rebuild the dest dict to insert 'previouslyFiled' before 'decision'.
    #    If dest already has a decision, insert previouslyFiled just before it.
    #    If not, insert previouslyFiled + decision (+ dateDecision) after 'number'.
    rebuilt: dict = {}
    pf_inserted = False
    for k, v in dst_case.items():
        if k == 'decision' and not pf_inserted:
            rebuilt['previouslyFiled'] = src_term
            pf_inserted = True
        rebuilt[k] = v
        if k == 'number' and 'decision' not in dst_case and not pf_inserted:
            rebuilt['previouslyFiled'] = src_term
            if 'decision' in src_case:
                rebuilt['decision'] = src_case['decision']
                if 'dateDecision' in src_case and 'dateDecision' not in dst_case:
                    rebuilt['dateDecision'] = src_case['dateDecision']
            pf_inserted = True
    if not pf_inserted:
        rebuilt['previouslyFiled'] = src_term
        if 'decision' in src_case and 'decision' not in rebuilt:
            rebuilt['decision'] = src_case['decision']
            if 'dateDecision' in src_case and 'dateDecision' not in rebuilt:
                rebuilt['dateDecision'] = src_case['dateDecision']
    dst_case.clear()
    dst_case.update(rebuilt)

    # 3. Append source audio entries (no duplicate audio_href).
    existing_hrefs: set[str] = {
        a.get('audio_href', '') for a in dst_case.get('audio', [])
    }
    for audio in src_case.get('audio', []):
        href = audio.get('audio_href', '')
        if href and href in existing_hrefs:
            continue
        dst_case.setdefault('audio', []).append(audio)
        if href:
            existing_hrefs.add(href)

    # 3b. Collapse ussc-only transcript stubs into matching audio objects.
    #     A stub is a ussc/argument audio entry whose only keys are
    #     source, type, date, and transcript_href (nothing else).
    _stub_keys = {'source', 'type', 'date', 'transcript_href'}
    audio_list: list[dict] = dst_case.get('audio', [])
    stubs = [
        a for a in audio_list
        if (a.get('source') == 'ussc'
            and a.get('type') == 'argument'
            and set(a.keys()) == _stub_keys)
    ]
    for stub in stubs:
        match = next(
            (a for a in audio_list
             if a is not stub and a.get('date') == stub['date']),
            None,
        )
        if match is not None:
            if 'transcript_href' not in match:
                match['transcript_href'] = stub['transcript_href']
            audio_list.remove(stub)

    if dry_run or src_folder is None or dst_folder is None:
        return

    # 4. Move local text_href files from source to dest folder.
    for audio in src_case.get('audio', []):
        text_href = audio.get('text_href', '')
        if text_href and not text_href.startswith(('http://', 'https://')):
            src_file = src_folder / text_href
            if src_file.exists():
                dst_folder.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src_file), str(dst_folder / text_href))

    # 5. Move source files.json entries into dest files.json.
    src_files_path = src_folder / 'files.json'
    if src_files_path.exists():
        src_files: list[dict] = json.loads(src_files_path.read_text(encoding='utf-8'))
        dst_files_path = dst_folder / 'files.json'
        dst_files: list[dict] = (
            json.loads(dst_files_path.read_text(encoding='utf-8'))
            if dst_files_path.exists() else []
        )
        max_id = max((f.get('file', 0) for f in dst_files), default=0)
        for f in src_files:
            new_entry = dict(f)
            # Move physical file if href is local.
            href = f.get('href', '')
            if href and not href.startswith(('http://', 'https://')):
                fname = Path(href).name
                src_file = src_folder / fname
                if src_file.exists():
                    dst_folder.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(src_file), str(dst_folder / fname))
                # Update the href path to reflect the new term.
                new_entry['href'] = href.replace(
                    f'/terms/{src_term}/', f'/terms/{dst_folder.parent.parent.name}/'
                )
            max_id += 1
            new_entry['file'] = max_id
            dst_files.append(new_entry)

        dst_files_path.write_text(
            json.dumps(dst_files, indent=2, ensure_ascii=False) + '\n',
            encoding='utf-8',
        )
        dst_case['files'] = len(dst_files)

        # Remove source files.json.
        src_files_path.unlink()

    # 6. Remove source folder if now empty.
    if src_folder.is_dir() and not any(src_folder.iterdir()):
        src_folder.rmdir()


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    dry_run = '--dry-run' in sys.argv
    filter_term = args[0] if args else None

    if dry_run:
        print('[DRY RUN — no files will be written]\n')

    term_dirs = sorted(d for d in TERMS_DIR.iterdir() if d.is_dir())
    terms = [d.name for d in term_dirs]

    # Load all cases.json files into memory so cross-term edits stay consistent.
    loaded: dict[str, list[dict]] = {}
    for term in terms:
        cases_path = TERMS_DIR / term / 'cases.json'
        if cases_path.exists():
            try:
                loaded[term] = json.loads(cases_path.read_text(encoding='utf-8'))
            except Exception as e:
                print(f'ERROR: {term}/cases.json: {e}')

    modified: set[str] = set()
    moved = merged = skipped = fixed_orig = 0

    for i, term in enumerate(terms):
        if filter_term and term != filter_term:
            continue
        if term not in loaded:
            continue

        # --- Pass 1: fix "Orig. " bogus cases created by import_cases.py ---
        # A bogus case has title starting with "Orig. " and number N where
        # a real case with number N-Orig exists in the same term.
        cases = loaded[term]
        keep: list[dict] = []
        for case in cases:
            title = case.get('title', '')
            number = case.get('number', '')
            if not title.startswith('Orig. '):
                keep.append(case)
                continue

            real_number = f'{number}-Orig'
            real_case = next(
                (c for c in cases if c.get('number') == real_number),
                None,
            )
            if real_case is None:
                # No matching N-Orig case — leave it alone.
                keep.append(case)
                continue

            print(f'FIX-ORIG: {term} | removing bogus {number!r} → merging into {real_number!r}')

            # Copy transcript_href from bogus audio into matching real audio by date.
            for bog_audio in case.get('audio', []):
                bog_date = bog_audio.get('date')
                bog_href = bog_audio.get('transcript_href')
                if not bog_date or not bog_href:
                    continue
                real_audio = next(
                    (a for a in real_case.get('audio', []) if a.get('date') == bog_date),
                    None,
                )
                if real_audio is not None and 'transcript_href' not in real_audio:
                    real_audio['transcript_href'] = bog_href

            if not dry_run:
                # Merge bogus files.json entries into the real case folder.
                bog_folder = TERMS_DIR / term / 'cases' / str(number)
                real_folder = TERMS_DIR / term / 'cases' / real_number
                bog_files_path = bog_folder / 'files.json'
                if bog_files_path.exists():
                    bog_files = json.loads(bog_files_path.read_text(encoding='utf-8'))
                    real_files_path = real_folder / 'files.json'
                    real_files: list[dict] = (
                        json.loads(real_files_path.read_text(encoding='utf-8'))
                        if real_files_path.exists() else []
                    )
                    max_id = max((f.get('file', 0) for f in real_files), default=0)
                    for f in bog_files:
                        max_id += 1
                        real_files.append({**f, 'file': max_id})
                    real_folder.mkdir(parents=True, exist_ok=True)
                    real_files_path.write_text(
                        json.dumps(real_files, indent=2, ensure_ascii=False) + '\n',
                        encoding='utf-8',
                    )
                    real_case['files'] = len(real_files)
                    bog_files_path.unlink()

                # Remove bogus folder if now empty.
                if bog_folder.is_dir() and not any(bog_folder.iterdir()):
                    bog_folder.rmdir()

                modified.add(term)

            # Drop bogus case from keep (real_case stays — it's already in cases).
            fixed_orig += 1

        if not dry_run:
            loaded[term] = keep

        # Refresh cases list for pass 2 (bogus Orig. cases excluded).
        bogus_numbers = {
            c.get('number') for c in loaded[term]
            if c.get('title', '').startswith('Orig. ')
        }
        cases = [c for c in loaded[term] if c.get('number') not in bogus_numbers
                 or not c.get('title', '').startswith('Orig. ')]
        keep = []

        # --- Pass 2: move/merge cases filed in the wrong term by decision date ---
        start = term_start(term)
        end = term_start(terms[i + 1]) if i + 1 < len(terms) else None

        for case in cases:
            decision = case.get('decision')
            if not decision:
                keep.append(case)
                continue

            in_range = (decision >= start) and (end is None or decision < end)
            if in_range:
                keep.append(case)
                continue

            title = case.get('title') or case.get('id') or '?'
            target_term = find_target_term(decision, terms)

            if target_term is None or target_term == term:
                print(f'WARNING: {term} | {title!r} | decision {decision!r} — cannot determine target term')
                keep.append(case)
                skipped += 1
                continue

            if target_term not in loaded:
                print(f'WARNING: {term} | {title!r} | decision {decision!r} — target term {target_term!r} has no cases.json')
                keep.append(case)
                skipped += 1
                continue

            folder = case_folder_name(case)
            src_folder  = TERMS_DIR / term        / 'cases' / folder if folder else None
            dest_folder = TERMS_DIR / target_term / 'cases' / folder if folder else None

            if dest_folder and dest_folder.exists():
                # Find the conflicting dest case.
                dst_case = next(
                    (c for c in loaded[target_term] if case_folder_name(c) == folder),
                    None,
                )
                if dst_case is not None and can_merge(case, dst_case):
                    print(f'MERGE: {term} → {target_term} | {title!r} | decision {decision!r}')
                    do_merge(case, dst_case, src_folder, dest_folder, term, dry_run)
                    if not dry_run:
                        modified.add(target_term)
                        modified.add(term)
                        # src case dropped (not appended to keep)
                    else:
                        keep.append(case)
                    merged += 1
                else:
                    print(f'WARNING: {term} | {title!r} | folder conflict in {target_term}/cases/{folder}/ — skipping')
                    keep.append(case)
                    skipped += 1
                continue

            # No conflict — plain move.
            print(f'MOVE: {term} → {target_term} | {title!r} | decision {decision!r}')

            if not dry_run:
                if src_folder and src_folder.is_dir():
                    dest_cases_dir = TERMS_DIR / target_term / 'cases'
                    dest_cases_dir.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(src_folder), str(dest_folder))

                updated_case = insert_previously_filed(case, term)
                loaded[target_term].append(updated_case)
                modified.add(target_term)
                modified.add(term)
                # src case dropped
            else:
                keep.append(case)

            moved += 1

        if not dry_run:
            loaded[term] = keep

    # Write all modified files.
    if not dry_run:
        for term in modified:
            cases_path = TERMS_DIR / term / 'cases.json'
            cases_path.write_text(
                json.dumps(loaded[term], indent=2, ensure_ascii=False) + '\n',
                encoding='utf-8',
            )

    parts = []
    if fixed_orig:
        parts.append(f'{fixed_orig} orig-fixed')
    if moved:
        parts.append(f'{moved} moved')
    if merged:
        parts.append(f'{merged} merged')
    if skipped:
        parts.append(f'{skipped} skipped')
    suffix = ' (dry run)' if dry_run else ''
    print(f'\n{", ".join(parts) or "0 changes"}{suffix}.')


if __name__ == '__main__':
    main()
