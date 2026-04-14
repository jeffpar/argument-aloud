#!/usr/bin/env python3
"""Builds/updates courts/ussc/people/advocates.json (index) and
courts/ussc/people/advocates/{id}.json (per-advocate case lists) from
transcript files.

For every case in every cases.json under courts/ussc/terms/, follows each
audio entry's text_href to its transcript file, extracts speakers whose role
is "advocate", and records which case/date they appeared in.

Audio entries may also include an "advocates" array of name strings to
explicitly credit advocates when no transcript is available:

    { "date": "1972-10-11", "advocates": ["JOHN DOE", "JANE ROE"] }

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

import json
import os
import re
import sys
import unicodedata
from datetime import date as Date, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
TERMS_DIR = REPO_ROOT / "courts" / "ussc" / "terms"
OUTPUT_FILE = REPO_ROOT / "courts" / "ussc" / "people" / "advocates.json"
ADVOCATES_DIR = REPO_ROOT / "courts" / "ussc" / "people" / "advocates"

ID_PREFIX = "P"  # retained for migration compatibility, no longer written

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

        adv_id = entry.get("id") or make_advocate_id(name)
        # Collapse internal whitespace (guards against previously mis-stored names).
        name = ' '.join(name.split())
        result[name.upper()] = {"id": adv_id, "name": name, "cases": []}
    return result


def next_id(existing: dict[str, dict]) -> int:
    """Return the next available NNNN integer after all existing IDs."""
    return 0  # no longer used; kept for migration compatibility


def make_id(n: int) -> str:
    return f"{ID_PREFIX}-{n:04d}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
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
            audio_entries = case.get("audio", [])
            decision = case.get("decision") or None

            # Pre-compute 1-based sorted position for each audio entry.
            audio_sorted = sorted(
                enumerate(audio_entries),
                key=lambda x: (x[1].get("date") or ""),
            )
            audio_sorted_pos = {orig_i: sorted_i + 1
                                for sorted_i, (orig_i, _) in enumerate(audio_sorted)}

            # Pre-load advocate names per audio entry so that when multiple
            # entries on the same date all contain the same advocate, we can
            # record the best entry's position (aligned preferred).
            _JUSTICE_TITLES_PRE = {"JUSTICE", "CHIEF JUSTICE"}
            _audio_entry_advocates: dict[int, set[str]] = {}
            for _pre_idx, _pre_audio in enumerate(audio_entries):
                _names: set[str] = set()
                for _raw in _pre_audio.get("advocates", []):
                    _n = ' '.join(normalize_name_suffix(_raw.strip()).split())
                    if _n:
                        _names.add(_n.upper())
                _pre_text = _pre_audio.get("text_href")
                if _pre_text:
                    _pre_path = term_dir / "cases" / folder_num / _pre_text
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

                def _record_advocate(raw_name: str) -> None:
                    """Add a case entry for raw_name under this audio object."""
                    # Collapse internal whitespace so "CARTER G.   PHILLIPS" == "CARTER G. PHILLIPS".
                    name = ' '.join(raw_name.split())
                    if not name or not audio_date:
                        return
                    name_key = name.upper()
                    case_key = (name_key, title, term, number)
                    try:
                        new_dt = Date.fromisoformat(audio_date)
                    except ValueError:
                        return
                    prior = recorded_dates.get(case_key, [])
                    if any(abs((new_dt - d).days) <= 7 for d in prior):
                        return
                    recorded_dates.setdefault(case_key, []).append(new_dt)
                    if name_key not in advocates:
                        adv_id = make_advocate_id(name)
                        advocates[name_key] = {"id": adv_id, "name": name, "cases": []}
                    advocates[name_key]["cases"].append({
                        "title":    title,
                        "term":     term,
                        "number":   number,
                        "argument": audio_date,
                        **({"decision": decision} if decision else {}),
                        "audio":    preferred_audio_pos.get(
                            (audio_date, name_key), audio_sorted_pos[orig_idx]),
                    })

                # --- Explicit advocates list (no transcript required) ---
                for raw_name in audio.get("advocates", []):
                    _record_advocate(normalize_name_suffix(raw_name.strip()))

                # --- Transcript-based speakers ---
                text_href = audio.get("text_href")
                if not text_href or not audio_date:
                    continue

                transcript_path = (
                    term_dir / "cases" / folder_num / text_href
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
                    _record_advocate(speaker.get("name", ""))

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
        print(f"\nSkipped {len(skipped)} one-word advocate name(s) (likely incomplete matches):")
        for entry in skipped:
            adv_id = entry.get("id") or make_advocate_id(entry["name"])
            stale = ADVOCATES_DIR / f"{adv_id}.json"
            if stale.exists():
                stale.unlink()
                print(f"  {entry['name']}  [{adv_id}.json removed]  —  {len(entry['cases'])} case(s)")
            else:
                print(f"  {entry['name']}  —  {len(entry['cases'])} case(s)")
        print()

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
        envelope = {
            "details": existing_details,
            "highlights": existing_highlights,
            "cases": entry["cases"],
        }
        case_file.write_text(
            json.dumps(envelope, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    # Write the index (name + id + total_cases only — no cases array).
    index = [
        {"id": e.get("id") or make_advocate_id(e["name"]),
         "name": e["name"],
         "total_cases": len(e["cases"])}
        for e in output
    ]
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_FILE.open("w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(
        f"Wrote {len(output)} advocates to "
        f"{OUTPUT_FILE.relative_to(REPO_ROOT)} "
        f"and {ADVOCATES_DIR.relative_to(REPO_ROOT)}/"
    )


if __name__ == "__main__":
    main()
