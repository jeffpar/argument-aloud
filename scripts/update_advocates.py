#!/usr/bin/env python3
"""Builds/updates courts/ussc/people/advocates.json (index) and
courts/ussc/people/advocates/{id}.json (per-advocate case lists) from
transcript files.

For every case in every cases.json under courts/ussc/terms/, follows each
audio entry's text_href to its transcript file, extracts speakers whose role
is "advocate", and records which case/date they appeared in.

Audio entries may also include an "advocates" array of {name, title} objects
to explicitly credit advocates when no transcript is available:

    { "date": "1972-10-11", "advocates": [{"name": "JOHN DOE", "title": "MR."}, ...] }

These are processed identically to transcript speakers and are subject to
the same 7-day deduplication window. If a transcript is later added for
the same audio, duplicate entries will be suppressed automatically.

Output structure
----------------
courts/ussc/people/advocates.json  — index array:
  [
    { "id": "john_doe", "name": "JOHN DOE", "total_cases": 3 },
    ...
  ]

courts/ussc/people/advocates/{id}.json  — per-advocate cases array:
  [
    {
      "title":    "Roe v. Wade",
      "term":     "1971-10",
      "number":   "70-18",
      "argument": "1971-12-13",
      "decision": "1973-01-22",  # omitted if no decision date yet
      "audio":    1              # 1-based index in date-sorted audio list
    },
    ...
  ]

If the output files already exist, new advocates/cases are merged in.

Usage:
    python3 scripts/update_advocates.py
"""

import csv
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import date as Date, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
TERMS_DIR = REPO_ROOT / "courts" / "ussc" / "terms"
OUTPUT_FILE = REPO_ROOT / "courts" / "ussc" / "people" / "all_advocates.json"
WOMEN_OUTPUT_FILE = REPO_ROOT / "courts" / "ussc" / "people" / "women_advocates.json"
WOMEN_CSV_FILE = REPO_ROOT / "data" / "misc" / "ussc_women_advocates.csv"
ADVOCATES_DIR = REPO_ROOT / "courts" / "ussc" / "people" / "advocates"

ID_PREFIX = "P"  # retained for migration compatibility, no longer written

# ---------------------------------------------------------------------------
# Feminine-title detection (for women_advocates.json)
# ---------------------------------------------------------------------------
_FEMININE_TITLE_PARTS = ("MS.", "MRS.", "MISS")


def is_feminine_title(title: str) -> bool:
    """Return True if *title* contains a feminine honorific (MS., MRS., MISS)."""
    upper = title.upper()
    return any(part in upper for part in _FEMININE_TITLE_PARTS)

# ---------------------------------------------------------------------------
# Name aliases: loaded from scripts/speakers.json ('alias' section).
# Maps every previously-used name (upper-case) to the canonical current name
# (upper-case).  Entries are merged under the canonical name and the old
# name(s) are stored in a "previously" list on the advocate record.
# ---------------------------------------------------------------------------
_SPEAKERS_FILE = Path(__file__).resolve().parent / "speakers.json"


def _load_name_aliases(path: Path) -> dict[str, str]:
    """Load the 'alias' section of speakers.json and return {old_upper: new_upper}."""
    aliases: dict[str, str] = {}
    if not path.exists():
        return aliases
    data: dict = json.loads(path.read_text(encoding="utf-8"))
    for old, new in (data.get("alias") or {}).items():
        aliases[old.strip().upper()] = new.strip().upper()
    return aliases


NAME_ALIASES: dict[str, str] = _load_name_aliases(_SPEAKERS_FILE)

# ---------------------------------------------------------------------------
# Advocate ID
# ---------------------------------------------------------------------------

_PUNCT_RE = re.compile(r"[^\w\s]")


def make_advocate_id(name: str) -> str:
    """Derive a stable file-system-safe ID from an advocate's name.

    Steps: normalise Unicode (NFD → strip combining marks), lower-case,
    strip punctuation (keep letters/digits/spaces/underscores), collapse
    whitespace, replace spaces with underscores.

    Examples
    --------
    'JOHN DOE'              -> 'john_doe'
    'A. ANNE-MARIE CÔTÉ'    -> 'a_anne-marie_cote'  (hyphens kept as words)
    'JOHN DOE, JR.'         -> 'john_doe_jr'
    """
    # Decompose accented letters and drop the combining diacritical marks.
    nfd = unicodedata.normalize('NFD', name)
    ascii_name = ''.join(ch for ch in nfd if unicodedata.category(ch) != 'Mn')
    lower = ascii_name.lower()
    # Remove punctuation except hyphens (they separate name parts).
    no_punct = re.sub(r"[^\w\s-]", "", lower)
    # Collapse whitespace / hyphens / underscores into single underscores.
    slug = re.sub(r"[\s\-_]+", "_", no_punct).strip('_')
    return slug


# ---------------------------------------------------------------------------
# Suffix normalisation patterns
_SUFFIX_JR_SR_RE = re.compile(r',?\s+(JR|SR)\.?\s*$', re.IGNORECASE)
_SUFFIX_ROMAN_RE = re.compile(r',?\s+(II|III|IV)\s*$', re.IGNORECASE)


# ---------------------------------------------------------------------------
# Name normalisation
# ---------------------------------------------------------------------------

def normalize_name_suffix(name: str) -> str:
    """Normalise JR/SR and Roman-numeral generation suffixes.

    Examples
    --------
    'JOHN DOE JR'   -> 'JOHN DOE, JR.'
    'JOHN DOE, SR'  -> 'JOHN DOE, SR.'
    'JOHN DOE II'   -> 'JOHN DOE, II'
    'JOHN DOE, III' -> 'JOHN DOE, III'  (already canonical, unchanged)
    """
    m = _SUFFIX_JR_SR_RE.search(name)
    if m:
        base = name[:m.start()]
        suffix = m.group(1).upper()
        normalised = f"{base}, {suffix}."
        if normalised != name:
            return normalised
        return name
    m = _SUFFIX_ROMAN_RE.search(name)
    if m:
        base = name[:m.start()]
        suffix = m.group(1).upper()
        normalised = f"{base}, {suffix}"
        if normalised != name:
            return normalised
    return name


def normalize_transcript(transcript: dict) -> tuple[dict, dict[str, str]]:
    """Normalise speaker-name suffixes throughout a transcript dict.

    Updates ``media.speakers[].name`` and ``turns[].name`` in-place.
    Returns ``(transcript, rename_map)`` where ``rename_map`` maps each
    old name to its normalised replacement (empty dict if nothing changed).
    """
    rename: dict[str, str] = {}

    for speaker in transcript.get("media", {}).get("speakers", []):
        old = speaker.get("name", "")
        new = normalize_name_suffix(old)
        if new != old:
            rename[old] = new

    for turn in transcript.get("turns", []):
        old = turn.get("name", "")
        if old not in rename:
            new = normalize_name_suffix(old)
            if new != old:
                rename[old] = new

    if not rename:
        return transcript, {}

    for speaker in transcript.get("media", {}).get("speakers", []):
        old = speaker.get("name", "")
        if old in rename:
            speaker["name"] = rename[old]

    for turn in transcript.get("turns", []):
        old = turn.get("name", "")
        if old in rename:
            turn["name"] = rename[old]

    return transcript, rename


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def case_folder_number(number_str: str) -> str:
    """Return the folder name for a case number.

    Cases with consolidated numbers like "18,53" use only the first value.
    """
    return number_str.split(",")[0].strip()


def load_existing() -> dict[str, dict]:
    """Load existing advocate ids/names, keyed by normalised name (upper-case).

    Only id and name are loaded — cases are always rebuilt from the term
    directories so that additions, updates, and removals in cases.json are
    reflected accurately.  Details and highlights are preserved separately
    at write time by reading the existing per-advocate file.
    """
    if not OUTPUT_FILE.exists():
        return {}
    with OUTPUT_FILE.open(encoding="utf-8") as fh:
        index = json.load(fh)

    result: dict[str, dict] = {}
    for entry in index:
        name = entry["name"]
        # Normalise name suffixes.
        normalised = normalize_name_suffix(name)
        if normalised != name:
            print(f"  Normalised existing name: {name!r} -> {normalised!r}")
            name = normalised

        adv_id = make_advocate_id(name)
        # Collapse internal whitespace (guards against previously mis-stored names).
        name = ' '.join(name.split())
        entry_data = {"id": adv_id, "name": name, "cases": []}
        if entry.get("previously"):
            entry_data["previously"] = entry["previously"]
        result[name.upper()] = entry_data
    return result


def next_id(existing: dict[str, dict]) -> int:
    """Return the next available NNNN integer after all existing IDs."""
    return 0  # no longer used; kept for migration compatibility


def make_id(n: int) -> str:
    return f"{ID_PREFIX}-{n:04d}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def _repair_rename_in_transcripts(renames: dict[str, str]) -> int:
    """Rename advocate names in all transcript JSON files.

    *renames* maps old_name_upper -> new_name (display case).
    Returns the number of files modified.
    """
    modified = 0
    for transcript_path in sorted(TERMS_DIR.rglob("cases/*/*.json")):
        try:
            data = json.loads(transcript_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not isinstance(data, dict):
            continue
        changed = False
        # media.speakers
        for sp in data.get("media", {}).get("speakers", []):
            old = sp.get("name", "")
            new = renames.get(old.upper())
            if new and old != new:
                sp["name"] = new
                changed = True
        # turns
        for turn in data.get("turns", []):
            old = turn.get("name", "")
            new = renames.get(old.upper())
            if new and old != new:
                turn["name"] = new
                changed = True
        if changed:
            transcript_path.write_text(
                json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            modified += 1
    return modified


def _repair_update_speakers_json(renames: dict[str, str]) -> None:
    """Add rename mappings (old_upper -> new_upper) to speakers.json aliases."""
    if not _SPEAKERS_FILE.exists():
        return
    data: dict = json.loads(_SPEAKERS_FILE.read_text(encoding="utf-8"))
    aliases: dict = data.setdefault("alias", {})
    for old_upper, new_name in renames.items():
        new_upper = new_name.upper()
        if old_upper != new_upper:
            aliases[old_upper] = new_upper
    _SPEAKERS_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    verbose = '--verbose' in sys.argv or '-v' in sys.argv
    show_women = '--women' in sys.argv
    repair_mode = '--repair' in sys.argv
    markdown_mode = '--markdown' in sys.argv
    singles_mode = '--singles' in sys.argv
    fix_mode = '--fix' in sys.argv

    # Collect all terms (subdirectories of TERMS_DIR)
    term_dirs = sorted(
        p for p in TERMS_DIR.iterdir() if p.is_dir()
    )

    if not term_dirs:
        print(f"No term directories found under {TERMS_DIR}", file=sys.stderr)
        sys.exit(1)

    # advocates[name_upper] = {"id": ..., "name": ..., "cases": []}
    # Cases are rebuilt from scratch each run; details/highlights are preserved at write time.
    advocates: dict[str, dict] = load_existing()
    counter = next_id(advocates)  # retained for migration only, not written

    # Ensure the per-advocate output directory exists.
    ADVOCATES_DIR.mkdir(parents=True, exist_ok=True)

    # Track argument dates per (name, title, term, number) to skip duplicate
    # appearances within 7 days (multi-day arguments treated as one entry).
    recorded_dates: dict[tuple[str, str, str, str], list[Date]] = {}

    # Track ALL appearance dates (including deduped ones) for CSV multi-date output.
    all_appearance_dates: dict[tuple[str, str, str, str], set[Date]] = {}

    # Track which advocates appeared with a feminine title (MS., MRS., MISS).
    # case_feminine_seen: (name_key, case_title, term, number) -> True if any
    #   appearance used a feminine title (updated even for deduplicated entries).
    # name_feminine: name_key -> True if the advocate ever used a feminine title.
    case_feminine_seen: dict[tuple, bool] = {}
    name_feminine: dict[str, bool] = {}

    # Citation string keyed by (title, term, number) for CSV generation.
    case_citation: dict[tuple, str] = {}

    # Track which transcript file(s) produced each single-word speaker name.
    # Used by --fix to locate and repair offending transcripts.
    single_name_paths: dict[str, set[Path]] = defaultdict(set)

    for term_dir in term_dirs:
        term = term_dir.name
        cases_file = term_dir / "cases.json"
        if not cases_file.exists():
            continue

        try:
            cases = json.loads(cases_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"  WARNING: could not parse {cases_file}: {exc}", file=sys.stderr)
            continue

        for case in cases:
            title = case.get("title", "")
            number_raw = case.get("number", "")
            number = number_raw  # keep original (e.g. "18,53") for output
            folder_num = case_folder_number(number_raw)
            audio_entries = case.get("events", [])
            decision = case.get("decision") or None

            us_cite = case.get("usCite", "")
            cite_year = (decision or "")[:4]
            if us_cite and cite_year:
                _citation = f"{us_cite} ({cite_year})"
            elif us_cite:
                _citation = us_cite
            else:
                _citation = ""
            case_citation[(title, term, number)] = _citation

            # Pre-compute 1-based sorted position for each audio entry.
            audio_sorted = sorted(
                enumerate(audio_entries),
                key=lambda x: (x[1].get("date") or ""),
            )
            audio_sorted_pos = {orig_i: sorted_i + 1
                                for sorted_i, (orig_i, _) in enumerate(audio_sorted)}
            # Reverse map: 1-based sorted position -> audio entry (for audio_href check).
            sorted_pos_to_audio = {sorted_i + 1: audio_entries[orig_i]
                                   for sorted_i, (orig_i, _) in enumerate(audio_sorted)}

            # For terms <= 1999-10 the ussc transcripts come from scanned
            # documents with potentially inferior OCR; prefer oyez transcripts
            # when both sources cover the same argument date.
            is_early_term = (term <= "1999-10")
            oyez_dates: set[str] = set()
            if is_early_term:
                for _a in audio_entries:
                    if _a.get("source") == "oyez" and _a.get("text_href"):
                        _d = _a.get("date") or case.get("argument", "")
                        if _d:
                            oyez_dates.add(_d)

            # Pre-load advocate names per audio entry so that when multiple
            # entries on the same date all contain the same advocate, we can
            # record the best entry's position (aligned preferred).
            _JUSTICE_TITLES_PRE = {"JUSTICE", "CHIEF JUSTICE"}
            _audio_entry_advocates: dict[int, set[str]] = {}
            for _pre_idx, _pre_audio in enumerate(audio_entries):
                _names: set[str] = set()
                for _raw in _pre_audio.get("advocates", []):
                    _raw_name = _raw['name'] if isinstance(_raw, dict) else _raw
                    _n = ' '.join(normalize_name_suffix(_raw_name.strip()).split())
                    if _n:
                        _names.add(_n.upper())
                _pre_text = _pre_audio.get("text_href")
                _pre_date = _pre_audio.get("date") or case.get("argument", "")
                _skip_ussc_pre = (
                    is_early_term
                    and _pre_audio.get("source") == "ussc"
                    and _pre_date in oyez_dates
                )
                if _pre_text and not _skip_ussc_pre:
                    _pre_path = term_dir / "cases" / _pre_text
                    if _pre_path.exists():
                        try:
                            _pre_t = json.loads(
                                _pre_path.read_text(encoding="utf-8")
                            )
                            for _sp in _pre_t.get("media", {}).get("speakers", []):
                                if _sp.get("title", "") not in _JUSTICE_TITLES_PRE:
                                    _n = ' '.join(normalize_name_suffix(
                                        _sp.get("name", "")).split())
                                    if _n:
                                        _names.add(_n.upper())
                        except Exception:
                            pass
                if _names:
                    _audio_entry_advocates[_pre_idx] = _names

            # For each (date, advocate) that appears in more than one audio
            # entry on the same date, pick the best position: aligned first.
            preferred_audio_pos: dict[tuple[str, str], int] = {}
            _date_to_idxs: dict[str, list[int]] = {}
            for _i, _a in enumerate(audio_entries):
                _d = _a.get("date") or case.get("argument", "")
                _date_to_idxs.setdefault(_d, []).append(_i)
            # For dates with multiple entries, compute the best entry overall
            # (audio_href > aligned > first). Used as fallback when an advocate
            # only appears in one entry but a better sibling entry exists.
            _best_pos_for_date: dict[str, int] = {}
            for _d, _idxs in _date_to_idxs.items():
                if len(_idxs) <= 1:
                    continue
                _with_audio = [_i for _i in _idxs if audio_entries[_i].get("audio_href")]
                _aligned = [_i for _i in _idxs if audio_entries[_i].get("aligned")]
                _best_i = (_with_audio + _aligned + _idxs)[0]
                _best_pos_for_date[_d] = audio_sorted_pos[_best_i]
            for _d, _idxs in _date_to_idxs.items():
                if len(_idxs) <= 1:
                    continue
                _all_advocates: set[str] = set()
                for _i in _idxs:
                    _all_advocates |= _audio_entry_advocates.get(_i, set())
                for _adv in _all_advocates:
                    _cands = [_i for _i in _idxs
                              if _adv in _audio_entry_advocates.get(_i, set())]
                    if len(_cands) <= 1:
                        continue
                    _aligned = [_i for _i in _cands
                                if audio_entries[_i].get("aligned")]
                    _best = _aligned[0] if _aligned else _cands[0]
                    preferred_audio_pos[(_d, _adv)] = audio_sorted_pos[_best]

            for orig_idx, audio in enumerate(audio_entries):
                audio_date = audio.get("date") or case.get("argument", "")

                def _record_advocate(raw_name: str, advocate_title: str = "") -> None:
                    """Add a case entry for raw_name under this audio object."""
                    # Collapse internal whitespace so "CARTER G.   PHILLIPS" == "CARTER G. PHILLIPS".
                    name = ' '.join(raw_name.split())
                    if not name or not audio_date:
                        return
                    name_key = name.upper()
                    # Remap alias to canonical name.
                    canonical_key = NAME_ALIASES.get(name_key)
                    if canonical_key:
                        old_display = name
                        name = ' '.join(canonical_key.split())  # canonical display name
                        name_key = canonical_key
                        if name_key not in advocates:
                            adv_id = make_advocate_id(name)
                            advocates[name_key] = {"id": adv_id, "name": name, "cases": [], "previously": []}
                        prev_list = advocates[name_key].setdefault("previously", [])
                        old_upper = old_display.upper()
                        if old_upper not in [p.upper() for p in prev_list]:
                            prev_list.append(old_display.upper())
                    case_key = (name_key, title, term, number)
                    # Track feminine title status even for deduplicated appearances
                    # so a later feminine-titled appearance can qualify a case.
                    _is_fem = is_feminine_title(advocate_title)
                    if _is_fem:
                        case_feminine_seen[case_key] = True
                        name_feminine[name_key] = True
                    else:
                        case_feminine_seen.setdefault(case_key, False)
                        name_feminine.setdefault(name_key, False)
                    try:
                        new_dt = Date.fromisoformat(audio_date)
                    except ValueError:
                        return
                    # Always record in all_appearance_dates, even if deduped.
                    all_appearance_dates.setdefault(case_key, set()).add(new_dt)
                    prior = recorded_dates.get(case_key, [])
                    if any(abs((new_dt - d).days) <= 7 for d in prior):
                        return
                    recorded_dates.setdefault(case_key, []).append(new_dt)
                    if name_key not in advocates:
                        adv_id = make_advocate_id(name)
                        advocates[name_key] = {"id": adv_id, "name": name, "cases": []}
                    _resolved_pos = preferred_audio_pos.get(
                        (audio_date, name_key),
                        _best_pos_for_date.get(audio_date, audio_sorted_pos[orig_idx]))
                    _resolved_audio = sorted_pos_to_audio.get(_resolved_pos, audio)
                    _case_entry: dict = {
                        "title":    title,
                        "term":     term,
                        "number":   number,
                        "argument": audio_date,
                    }
                    if decision:
                        _case_entry["decision"] = decision
                    _same_date_entries = [audio_entries[i] for i in _date_to_idxs.get(audio_date, [])]
                    if any(e.get("transcript_href") for e in _same_date_entries):
                        _case_entry["transcript"] = True
                    if _resolved_audio.get("audio_href") or _resolved_audio.get("transcript_href"):
                        _case_entry["audio"] = _resolved_pos
                    _file_count = case.get("files", 0)
                    if _file_count:
                        _case_entry["files"] = _file_count
                    advocates[name_key]["cases"].append(_case_entry)

                # --- Explicit advocates list (no transcript required) ---
                for raw_entry in audio.get("advocates", []):
                    raw_name = raw_entry['name'] if isinstance(raw_entry, dict) else raw_entry
                    raw_title = raw_entry.get('title', '') if isinstance(raw_entry, dict) else ''
                    _record_advocate(normalize_name_suffix(raw_name.strip()), raw_title)

                # --- Transcript-based speakers ---
                text_href = audio.get("text_href")
                skip_ussc_transcript = (
                    is_early_term
                    and audio.get("source") == "ussc"
                    and audio_date in oyez_dates
                )
                if not text_href or not audio_date or skip_ussc_transcript:
                    continue

                transcript_path = (
                    term_dir / "cases" / text_href
                )
                if not transcript_path.exists():
                    continue

                try:
                    transcript = json.loads(
                        transcript_path.read_text(encoding="utf-8")
                    )
                except json.JSONDecodeError as exc:
                    print(
                        f"  WARNING: could not parse {transcript_path}: {exc}",
                        file=sys.stderr,
                    )
                    continue

                transcript, rename_map = normalize_transcript(transcript)
                if rename_map:
                    for old, new in rename_map.items():
                        print(f"  Normalised name in {transcript_path.relative_to(REPO_ROOT)}: "
                              f"{old!r} -> {new!r}")
                    transcript_path.write_text(
                        json.dumps(transcript, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8",
                    )

                media = transcript.get("media", {})
                speakers = media.get("speakers", [])

                _JUSTICE_TITLES = {"JUSTICE", "CHIEF JUSTICE"}
                for speaker in speakers:
                    speaker_title = speaker.get("title", "")
                    if not speaker_title or speaker_title in _JUSTICE_TITLES:
                        continue
                    _sp_raw = speaker.get("name", "").strip()
                    _record_advocate(_sp_raw, speaker_title)
                    if _sp_raw and len(_sp_raw.split()) == 1:
                        single_name_paths[_sp_raw.upper()].add(transcript_path)

    # Sort each advocate's cases by argument date, most recent first
    for entry in advocates.values():
        entry["cases"].sort(key=lambda c: c.get("argument", c.get("date", "")), reverse=True)

    # Drop advocates that have no cases in the current scan (removed/renamed).
    removed = [e for e in advocates.values() if not e["cases"]]
    for entry in removed:
        adv_id = entry.get("id") or make_advocate_id(entry["name"])
        orphan = ADVOCATES_DIR / f"{adv_id}.json"
        if orphan.exists():
            orphan.unlink()
            print(f"  Removed orphaned advocate file: {orphan.relative_to(REPO_ROOT)}")

    # Build output list sorted by name
    output = sorted(
        (e for e in advocates.values() if e["cases"]),
        key=lambda e: e["name"],
    )

    # Skip one-word names (e.g. "PHILLIPS") — they are almost always incomplete
    # matches from transcripts that only recorded a bare last name.  Remove any
    # previously generated files and print a report so they can be investigated.
    skipped = [e for e in output if len(e["name"].split()) == 1]
    output  = [e for e in output if len(e["name"].split()) > 1]
    if skipped:
        # Build a (last_name_upper, argument_date) set from multi-word women
        # advocates (already in `output`) so we can suppress one-word names
        # that are just transcript-only partial matches for a known woman.
        multi_word_women_dates: set[tuple[str, str]] = set()
        for _e in output:
            if name_feminine.get(_e["name"].upper(), False):
                _last = _e["name"].upper().split()[-1]
                for _c in _e["cases"]:
                    multi_word_women_dates.add((_last, _c.get("argument", "")))

        def _is_shadow_woman(entry: dict) -> bool:
            """True if this one-word feminine name is covered by a known multi-word woman advocate."""
            name_up = entry["name"].upper()
            return any(
                (name_up, c.get("argument", "")) in multi_word_women_dates
                for c in entry["cases"]
            )

        skipped_women = [
            e for e in skipped
            if name_feminine.get(e["name"].upper(), False) and not _is_shadow_woman(e)
        ]
        women_suffix = f", {len(skipped_women)} possibly women" if skipped_women else ""
        if fix_mode:
            _JT_FIX = {"JUSTICE", "CHIEF JUSTICE"}
            for _fix_entry in skipped:
                _fix_name_upper = _fix_entry["name"].upper()
                for _tpath in sorted(single_name_paths.get(_fix_name_upper, set())):
                    _case_folder = _tpath.parent
                    _siblings = [p for p in sorted(_case_folder.glob("*.json")) if p != _tpath]
                    _candidates: dict[str, str] = {}  # upper -> display-case
                    for _sib in _siblings:
                        try:
                            _sib_data = json.loads(_sib.read_text(encoding="utf-8"))
                            for _s in _sib_data.get("media", {}).get("speakers", []):
                                if _s.get("title", "") in _JT_FIX:
                                    continue
                                _sname = _s.get("name", "").strip()
                                if not _sname:
                                    continue
                                _sup = _sname.upper()
                                _words = _sup.split()
                                if len(_words) > 1 and _words[-1] == _fix_name_upper:
                                    _candidates[_sup] = _sname
                        except Exception:
                            pass
                    if len(_candidates) == 1:
                        _full_upper, _full_display = next(iter(_candidates.items()))
                        try:
                            _t = json.loads(_tpath.read_text(encoding="utf-8"))
                            _changed = False
                            for _s in _t.get("media", {}).get("speakers", []):
                                if _s.get("name", "").strip().upper() == _fix_name_upper:
                                    _s["name"] = _full_display
                                    _changed = True
                            for _turn in _t.get("turns", []):
                                if _turn.get("name", "").strip().upper() == _fix_name_upper:
                                    _turn["name"] = _full_display
                                    _changed = True
                            if _changed:
                                _tpath.write_text(
                                    json.dumps(_t, indent=2, ensure_ascii=False) + "\n",
                                    encoding="utf-8",
                                )
                                print(f"    Fixed {_tpath.relative_to(REPO_ROOT)}: "
                                      f"{_fix_entry['name']} \u2192 {_full_display}")
                        except Exception as _exc:
                            print(f"    ERROR fixing {_tpath}: {_exc}", file=sys.stderr)

        if verbose or singles_mode:
            print(f"\nSkipped {len(skipped)} one-word advocate name(s) (likely incomplete matches{women_suffix}):")
            for entry in skipped:
                adv_id = entry.get("id") or make_advocate_id(entry["name"])
                stale = ADVOCATES_DIR / f"{adv_id}.json"
                is_fem = name_feminine.get(entry["name"].upper(), False) and not _is_shadow_woman(entry)
                fem_tag = "  [possibly woman]" if is_fem else ""
                cases_str = "; ".join(
                    f"{c['term']}/{c['number']}"
                    for c in sorted(entry["cases"], key=lambda c: c.get("argument", ""))
                )
                if verbose and stale.exists():
                    stale.unlink()
                    print(f"  {entry['name']} [{adv_id}.json removed]{fem_tag}: {cases_str}")
                else:
                    print(f"  {entry['name']}{fem_tag}: {cases_str}")
            print()
        else:
            # Still remove stale files; just don't print each one.
            for entry in skipped:
                adv_id = entry.get("id") or make_advocate_id(entry["name"])
                stale = ADVOCATES_DIR / f"{adv_id}.json"
                if stale.exists():
                    stale.unlink()
            print(f"Skipped {len(skipped)} one-word advocate name(s){women_suffix} (use --verbose to list them)")

    # In --singles mode, output is complete; skip all file writes.
    if singles_mode:
        return

    # Write per-advocate case files.
    for entry in output:
        adv_id = entry.get("id") or make_advocate_id(entry["name"])
        case_file = ADVOCATES_DIR / f"{adv_id}.json"
        # Preserve existing details/highlights if the file already exists.
        existing_details = {}
        existing_highlights = []
        if case_file.exists():
            try:
                raw = json.loads(case_file.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    existing_details = raw.get("details", {})
                    existing_highlights = raw.get("highlights", [])
            except json.JSONDecodeError:
                pass
        envelope: dict = {
            "details": existing_details,
            "highlights": existing_highlights,
        }
        if entry.get("previously"):
            envelope["previously"] = sorted(set(entry["previously"]))
        envelope["cases"] = entry["cases"]
        case_file.write_text(
            json.dumps(envelope, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    # Remove any advocate files not referenced by the current output (handles
    # files orphaned when a name variant is removed from transcripts but the
    # stale file was never cleaned up by a previous run).
    known_ids = {e.get("id") or make_advocate_id(e["name"]) for e in output}
    for orphan in sorted(ADVOCATES_DIR.glob("*.json")):
        if orphan.stem not in known_ids:
            orphan.unlink()
            print(f"  Removed stale advocate file: {orphan.relative_to(REPO_ROOT)}")

    # Write the index (name + id + total_cases only — no cases array).
    index = []
    for e in output:
        entry: dict = {
            "id":          e.get("id") or make_advocate_id(e["name"]),
            "name":        e["name"],
            "total_cases": len(e["cases"]),
        }
        if e.get("previously"):
            entry["previously"] = sorted(set(e["previously"]))
        index.append(entry)
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_FILE.open("w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(
        f"Wrote {len(output)} advocates to "
        f"{OUTPUT_FILE.relative_to(REPO_ROOT)} "
        f"and {ADVOCATES_DIR.relative_to(REPO_ROOT)}/"
    )

    # -----------------------------------------------------------------------
    # Write women_advocates.json — same format/sort as advocates.json but
    # restricted to advocates who appeared with a feminine title (MS., MRS.,
    # MISS) in at least one case.  All cases are counted regardless of title.
    # -----------------------------------------------------------------------
    women_index = [
        entry for entry in index
        if name_feminine.get(entry["name"].upper(), False)
    ]
    with WOMEN_OUTPUT_FILE.open("w", encoding="utf-8") as fh:
        json.dump(women_index, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(
        f"Wrote {len(women_index)} women advocates to "
        f"{WOMEN_OUTPUT_FILE.relative_to(REPO_ROOT)}"
    )

    # -----------------------------------------------------------------------
    # Write ussc_women_advocates.csv — one row per argument per woman advocate.
    # -----------------------------------------------------------------------
    women_rows: list[tuple] = []
    for name_upper, entry in advocates.items():
        if not name_feminine.get(name_upper, False):
            continue
        if len(entry["name"].split()) <= 1:
            continue
        adv_name = entry["name"]
        # Sort ascending by argument date to assign 1-based argument numbers.
        sorted_cases = sorted(entry["cases"], key=lambda c: c.get("argument", ""))
        for arg_num, c in enumerate(sorted_cases, start=1):
            citation = case_citation.get((c["title"], c["term"], c["number"]), "")
            audio_idx = c.get("audio")
            url = f"https://argumentaloud.org/courts/ussc/?term={c['term']}&case={c['number'].replace(',', '%2C')}"
            if audio_idx:
                url += f"&event={audio_idx}"
            # Collect all argument dates for this advocate+case that are within
            # 7 days of this entry's anchor date (same cluster only).
            case_key = (name_upper, c["title"], c["term"], c["number"])
            try:
                anchor_dt = Date.fromisoformat(c.get("argument", ""))
                all_dates = sorted(
                    d.isoformat()
                    for d in all_appearance_dates.get(case_key, set())
                    if abs((d - anchor_dt).days) <= 7
                )
            except ValueError:
                all_dates = []
            arg_date = ",".join(all_dates) if all_dates else c.get("argument", "")
            women_rows.append((
                adv_name,
                arg_num,
                arg_date,
                c["term"],
                c["number"],
                c["title"],
                citation,
                url,
            ))
    # Sort by advocate name, then argument date.
    women_rows.sort(key=lambda r: (r[0], r[2]))

    # -----------------------------------------------------------------------
    # Cross-check against reference CSV "Women Advocates Through October Term 2024.csv"
    # -----------------------------------------------------------------------
    REF_CSV = REPO_ROOT / "data" / "misc" / "Women Advocates Through October Term 2024.csv"
    _ORDINAL_RE = re.compile(r'\s*\(\d+\)\s*$')
    _FORMERLY_RE = re.compile(r'\s*\(formerly\s+[^)]+\)', re.I)
    _MONTH_ABBR_MAP = {
        'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
        'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
        'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12',
    }

    def _month_num(token: str) -> str:
        """Return 2-digit month number from a full or abbreviated month name, or ''."""
        key = token.lower().rstrip('.').strip()[:3]
        return _MONTH_ABBR_MAP.get(key, '')

    def _ref_dates_to_iso_set(date_str: str) -> set[str]:
        """Parse a reference CSV 'Argument Date' into a set of ISO 'YYYY-MM-DD' strings.

        Handles:
          - Simple:           "April 16, 2008"  / "Apr. 16, 2008"
          - Same-month range: "Apr. 17-18, 1963"
          - Comma days:       "Feb. 4,7, 1955"
          - Cross-month:      "Feb. 29-Mar.1, 1956"  / "Apr. 9-10, 1947"
        """
        date_str = date_str.strip()
        if not date_str:
            return set()

        # Strip optional "reargued" prefix (with or without trailing space).
        date_str = re.sub(r'^reargued\s*', '', date_str, flags=re.I)

        # Extract the 4-digit year (always at the end after the last comma/space).
        year_m = re.search(r'\b(\d{4})\s*$', date_str)
        if not year_m:
            return set()
        year = year_m.group(1)
        # Work on the part before the year.
        body = date_str[:year_m.start()].strip().rstrip(',').strip()

        results: set[str] = set()

        # Cross-month range: "Feb. 29-Mar.1"  or  "Feb 29 - Mar 1"
        cross = re.match(
            r'([A-Za-z]+\.?)\s*(\d+)\s*-\s*([A-Za-z]+\.?)\s*(\d+)$', body)
        if cross:
            m1 = _month_num(cross.group(1))
            d1 = cross.group(2).zfill(2)
            m2 = _month_num(cross.group(3))
            d2 = cross.group(4).zfill(2)
            if m1:
                results.add(f"{year}-{m1}-{d1}")
            if m2:
                results.add(f"{year}-{m2}-{d2}")
            return results

        # Same-month prefix: extract month token then remaining day specs.
        month_m = re.match(r'([A-Za-z]+\.?)\s+([\d,\s-]+)$', body)
        if month_m:
            month = _month_num(month_m.group(1))
            if month:
                days_str = month_m.group(2)
                # Split on commas and hyphens to get individual day numbers.
                for tok in re.split(r'[,\-]+', days_str):
                    tok = tok.strip()
                    if tok.isdigit():
                        results.add(f"{year}-{month}-{tok.zfill(2)}")
                if results:
                    return results

        # Fallback: try plain "Month D" or "Month DD".
        plain = re.match(r'([A-Za-z]+\.?)\s+(\d+)$', body)
        if plain:
            month = _month_num(plain.group(1))
            if month:
                results.add(f"{year}-{month}-{plain.group(2).zfill(2)}")

        return results

    def _normalize_name(name: str) -> str:
        """Normalize a name for comparison: unaccent and standardize apostrophes."""
        # Normalize curly/typographic apostrophes to straight apostrophe.
        name = name.replace('\u2019', "'").replace('\u2018', "'")
        # Strip diacritics by NFD decomposition + remove combining marks.
        nfd = unicodedata.normalize('NFD', name)
        return ''.join(ch for ch in nfd if unicodedata.category(ch) != 'Mn')

    def _name_parts(name: str) -> tuple[str, str]:
        """Return (first_upper, last_upper) from a display name.

        Strips ordinal suffixes '(2)', '(3)', etc., '(formerly X)' annotations,
        and comma qualifiers like ', MI Ass't Attorney General' before splitting.
        Normalizes accents and apostrophes for consistent comparison.
        """
        name = _ORDINAL_RE.sub('', name).strip()
        # Strip "(formerly Name)" annotations before any further processing.
        name = _FORMERLY_RE.sub('', name).strip()
        # Drop anything after the first comma (qualifier text).
        name = name.split(',')[0].strip()
        name = _normalize_name(name)
        words = name.split()
        if not words:
            return ('', '')
        return (words[0].upper(), words[-1].upper())

    if REF_CSV.exists():
        # Build lookup: (first_upper, last_upper) -> list of (iso_dates_set, row)
        ref_rows: list[dict] = []
        with REF_CSV.open(encoding='utf-8-sig', newline='') as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                # Skip invalid/disputed records (Advocate No. == -1).
                if row.get('Advocate No.', '').strip() == '-1':
                    continue
                iso_set = _ref_dates_to_iso_set(row.get('Argument Date', ''))
                first, last = _name_parts(row.get('Advocate Name', ''))
                ref_rows.append({**row, '_iso_set': iso_set, '_first': first, '_last': last})

        # name_lookup: (first_upper, last_upper) -> list of ref rows.
        # Each row is indexed under its parsed name AND under any alias-resolved
        # canonical name (e.g. "Morgan Goodspeed" -> "Morgan L. Ratner"), so that
        # our data can find reference rows that predate a name change.
        ref_name_lookup: dict[tuple, list] = defaultdict(list)
        for r in ref_rows:
            if not r['_iso_set']:
                continue
            ref_name_lookup[(r['_first'], r['_last'])].append(r)
            # Also register under the alias-resolved canonical name if different.
            # Try both "FIRST LAST" and the full normalized name as alias keys,
            # since some aliases span multi-word names (e.g. "ELIZABETH WATKINS
            # HULEN GRAYSON" -> "ELIZABETH WATKINS HULEN").
            _ref_full_upper = _normalize_name(r.get('Advocate Name', '')).upper()
            alias_upper = NAME_ALIASES.get(f"{r['_first']} {r['_last']}") \
                       or NAME_ALIASES.get(_ref_full_upper)
            if alias_upper:
                af, al = _name_parts(alias_upper)
                if (af, al) != (r['_first'], r['_last']):
                    if r not in ref_name_lookup[(af, al)]:
                        ref_name_lookup[(af, al)].append(r)

        ref_matched: set[int] = set()  # indices into ref_rows

        # Match and replace advocate names in women_rows.
        updated_rows = []
        our_unmatched: list[tuple] = []
        for row in women_rows:
            adv_name, arg_num, arg_date, term, case_num, title, citation, url = row
            first, last = _name_parts(adv_name)
            candidates = ref_name_lookup.get((first, last), [])
            our_dates = set(arg_date.split(','))
            # All reference rows for this advocate whose date set intersects ours.
            date_matches = [r for r in candidates if any(d in r['_iso_set'] for d in our_dates)]
            matched_ref = date_matches[0] if date_matches else None
            if matched_ref:
                # Mark every matching reference row (consolidated case variants) as matched.
                for r in date_matches:
                    ref_matched.add(id(r))
                # Replace with mixed-case name from reference (strip ordinal/formerly suffixes).
                canonical = _FORMERLY_RE.sub('', _ORDINAL_RE.sub('', matched_ref['Advocate Name'])).split(',')[0].strip()
                updated_rows.append((canonical, arg_num, arg_date, term, case_num, title, citation, url))
            else:
                updated_rows.append(row)
                our_unmatched.append(row)
        women_rows = updated_rows

        ref_unmatched = [r for r in ref_rows if id(r) not in ref_matched and r['_iso_set']
                         and _normalize_name(_ORDINAL_RE.sub('', r.get('Advocate Name', ''))).upper()
                             not in NAME_ALIASES]

        if our_unmatched:
            if show_women and markdown_mode:
                print(f"\n### Our records not matched in reference CSV ({len(our_unmatched)})\n")
                for row in sorted(our_unmatched, key=lambda r: (r[2], r[0])):
                    adv_name, _arg_num, arg_date, term, case_num, title, _citation, _url = row
                    adv_id = make_advocate_id(adv_name)
                    adv_url = (f"https://argumentaloud.org/courts/ussc/"
                               f"?collection=women_advocates&id={adv_id}")
                    case_num_url = case_num.replace(',', '%2C')
                    case_url = (f"https://argumentaloud.org/courts/ussc/"
                                f"?term={term}&case={case_num_url}")
                    first_iso = arg_date.split(',')[0]
                    try:
                        d = Date.fromisoformat(first_iso)
                        date_str = f"{d.strftime('%B')} {d.day}, {d.year}"
                    except ValueError:
                        date_str = first_iso
                    print(f"- [{adv_name}]({adv_url}) argued on {date_str} in "
                          f"[{title} (No. {case_num})]({case_url})")
            elif show_women:
                print(f"\nOur records not matched in reference CSV ({len(our_unmatched)}):")
                for row in sorted(our_unmatched, key=lambda r: (r[0], r[2])):
                    print(f"  {row[0]}  {row[2]}  {row[4]}  {row[5]}")
            else:
                print(f"Found {len(our_unmatched)} records not matched in reference CSV (use --women to list)")

        if ref_unmatched:
            if verbose:
                print(f"\nReference CSV records not matched in our data ({len(ref_unmatched)}):")
                for r in ref_unmatched:
                    print(f"  {r['Advocate Name']}  {r.get('Argument Date', '')}  {r.get('Case Name', '')}")
            else:
                print(f"Reference CSV records not matched in our data: {len(ref_unmatched)} (use --verbose to list)")
    else:
        print(f"  NOTE: Reference CSV not found, skipping cross-check: {REF_CSV.relative_to(REPO_ROOT)}")

    WOMEN_CSV_FILE.parent.mkdir(parents=True, exist_ok=True)
    with WOMEN_CSV_FILE.open("w", encoding="utf-8", newline="") as fh:
        # QUOTE_NONNUMERIC quotes every string field, ensuring Term and Case
        # Number are always quoted and not misread as numeric expressions.
        writer = csv.writer(fh, quoting=csv.QUOTE_NONNUMERIC)
        writer.writerow(["Advocate Name", "Advocate Argument Number",
                         "Argument Date", "Term", "Case Number", "Case Title", "Citation", "URL"])
        writer.writerows(women_rows)
    print(
        f"Wrote {len(women_rows)} rows to "
        f"{WOMEN_CSV_FILE.relative_to(REPO_ROOT)}"
    )

    # -----------------------------------------------------------------------
    # Report: women advocates whose individual cases never had a feminine title.
    # These are cases counted for a qualifying advocate where neither the
    # transcript speakers nor the audio advocates array showed MS./MRS./MISS.
    # -----------------------------------------------------------------------
    failed: dict[str, list] = {}
    for name_upper, entry in advocates.items():
        if not name_feminine.get(name_upper, False):
            continue  # not a woman advocate
        if len(entry["name"].split()) <= 1:
            continue  # skipped as one-word name
        bad_cases = [
            c for c in entry["cases"]
            if not case_feminine_seen.get((name_upper, c["title"], c["term"], c["number"]), False)
        ]
        if bad_cases:
            failed[entry["name"]] = bad_cases
    if failed:
        print(
            f"\nWomen advocates with cases not meeting feminine-title criteria "
            f"({len(failed)} advocate(s)):"
        )
        for adv_name in sorted(failed):
            print(f"  {adv_name}:")
            for c in failed[adv_name]:
                print(f"    {c['term']}  {c['title']}  [{c['argument']}]")

    # -----------------------------------------------------------------------
    # Anomaly report: similar advocate names and bare middle initials
    # -----------------------------------------------------------------------
    _suffix_strip_re = re.compile(r',.*$')

    def _adv_tokens(name: str) -> list[str]:
        """Split a display name into tokens, stripping comma-separated suffixes."""
        return _suffix_strip_re.sub('', name).strip().split()

    # Bare middle initial: a middle token that is a single letter with no period.
    bare_initial: list[str] = []
    for entry in advocates.values():
        tokens = _adv_tokens(entry["name"])
        if len(tokens) < 3:
            continue
        for tok in tokens[1:-1]:
            if len(tok) == 1 and tok.isalpha():
                bare_initial.append(entry["name"])
                break

    # Similar names: advocates sharing the same first name, last name, and
    # first letter of the first middle token (different full middle names).
    # Also catches two-token names (FIRST LAST) paired against three-token
    # names with the same first+last (e.g. AIMEE BROWN vs AIMEE W. BROWN).
    _sim: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    # Track two-token names by (first, last) so they can be paired later.
    _two_token: dict[tuple[str, str], list[str]] = defaultdict(list)
    for entry in advocates.values():
        tokens = _adv_tokens(entry["name"])
        if len(tokens) == 2:
            first = tokens[0].upper()
            last = tokens[1].upper()
            _two_token[(first, last)].append(entry["name"])
        elif len(tokens) >= 3:
            first = tokens[0].upper()
            last = tokens[-1].upper()
            mid_ch = tokens[1][0].upper()
            if mid_ch.isalpha():
                _sim[(first, last, mid_ch)].append(entry["name"])

    # Merge two-token names into any sim group that shares their first+last.
    for (first, last), two_names in _two_token.items():
        matched_keys = [k for k in _sim if k[0] == first and k[1] == last]
        if matched_keys:
            for key in matched_keys:
                _sim[key].extend(two_names)
        else:
            # No three-token group yet — check if there are multiple two-token
            # entries for the same first+last (unlikely but possible).
            if len(two_names) > 1:
                _sim[(first, last, '')].extend(two_names)

    similar = {k: sorted(v) for k, v in _sim.items() if len(v) > 1}

    # Drop groups that are already fully resolved by speakers.json aliases:
    # a group is resolved if every name except exactly one is an alias key
    # pointing to (or matching) the remaining name.
    def _group_resolved(names: list[str]) -> bool:
        for candidate in names:
            canonical = candidate.upper()
            others = [n for n in names if n != candidate]
            if all(NAME_ALIASES.get(n.upper()) == canonical for n in others):
                return True
        return False

    similar = {k: v for k, v in similar.items() if not _group_resolved(v)}

    if bare_initial or similar:
        if verbose:
            print("\n── Advocate name anomalies ──────────────────────────────────────────────")
            if bare_initial:
                print(f"\nAdvocates with bare middle initial (no period) ({len(bare_initial)}):")
                for name in sorted(bare_initial):
                    print(f"  {name}")
            if similar:
                print(f"\nAdvocates similar by first/last/middle-initial ({len(similar)} group(s)):")
                for (first, last, mid_ch), names in sorted(similar.items()):
                    label = f"{first} {mid_ch}. {last}" if mid_ch else f"{first} {last}"
                    print(f"  {label}:")
                    for name in names:
                        print(f"    {name}")
        else:
            parts = []
            if bare_initial:
                parts.append(f"{len(bare_initial)} bare-initial")
            if similar:
                parts.append(f"{len(similar)} similar-name group(s)")
            print(f"Advocate name anomalies: {', '.join(parts)} (use --verbose to list)")

    # ── Interactive repair ────────────────────────────────────────────────
    if repair_mode and similar:
        all_renames: dict[str, str] = {}  # old_upper -> preferred display name
        groups_sorted = sorted(similar.items())
        print(f"\n── Repair mode: {len(groups_sorted)} group(s) to review ─────────────────────")
        for (first, last, mid_ch), names in groups_sorted:
            names_sorted = sorted(names)
            # Prepend the abbreviated form (FIRST M. LAST) as option 1 if it
            # isn't already one of the existing variants in the group.
            # For two-token-only groups (mid_ch==''), there is no abbrev to add.
            if mid_ch:
                abbrev = f"{first} {mid_ch}. {last}"
                abbrev_upper = abbrev.upper()
                if not any(n.upper() == abbrev_upper for n in names_sorted):
                    options = [abbrev] + names_sorted
                else:
                    options = names_sorted
            else:
                abbrev = f"{first} {last}"
                options = names_sorted
            print(f"\n  {abbrev}:")
            for i, name in enumerate(options, 1):
                print(f"    {i}. {name}")
            while True:
                try:
                    raw = input(f"  Preferred name [1-{len(options)}, 0=skip]: ").strip()
                except EOFError:
                    raw = "0"
                if raw == "0":
                    break
                if raw.isdigit() and 1 <= int(raw) <= len(options):
                    preferred = options[int(raw) - 1]
                    renamed = [name for name in options if name != preferred]
                    for name in renamed:
                        all_renames[name.upper()] = preferred
                    print(f"    → will rename {len(renamed)} name(s) to: {preferred}")
                    break
                print(f"    Please enter a number between 0 and {len(options)}.")

        if all_renames:
            print(f"\nApplying {len(all_renames)} rename(s) to transcript files…")
            n_files = _repair_rename_in_transcripts(all_renames)
            print(f"  Modified {n_files} transcript file(s).")
            _repair_update_speakers_json(all_renames)
            print(f"  Updated {_SPEAKERS_FILE.relative_to(REPO_ROOT)} with new aliases.")
            print("  Re-run update_advocates.py (without --repair) to rebuild the index.")
        else:
            print("\nNo renames selected; nothing changed.")


if __name__ == "__main__":
    main()
