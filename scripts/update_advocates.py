#!/usr/bin/env python3
"""Builds/updates courts/ussc/people/advocates.json from transcript files.

For every case in every cases.json under courts/ussc/terms/, follows each
audio entry's text_href to its transcript file, extracts speakers whose role
is "advocate", and records which case/date they appeared in.

Audio entries may also include an "advocates" array of name strings to
explicitly credit advocates when no transcript is available:

    { "date": "1972-10-11", "advocates": ["JOHN DOE", "JANE ROE"] }

These are processed identically to transcript speakers and are subject to
the same 7-day deduplication window. If a transcript is later added for
the same audio, duplicate entries will be suppressed automatically.

The output is an array of people objects:
  {
    "name":  "JOHN DOE",
    "cases": [                  # sorted chronologically by argument date
      {
        "title":    "Roe v. Wade",
        "term":     "1971-10",
        "number":   "70-18",
        "argument": "1971-12-13",  # date of the audio object argued
        "decision": "1973-01-22",  # omitted if no decision date yet
        "audio":    1              # 1-based index in date-sorted audio list
      },
      ...
    ]
  }

If advocates.json already exists, existing IDs are preserved and new
advocates/cases are merged in.

Usage:
    python3 scripts/update_advocates.py
"""

import json
import os
import re
import sys
from datetime import date as Date, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
TERMS_DIR = REPO_ROOT / "courts" / "ussc" / "terms"
OUTPUT_FILE = REPO_ROOT / "courts" / "ussc" / "people" / "advocates.json"

ID_PREFIX = "P"  # retained for migration compatibility, no longer written

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
    """Load existing advocates.json, keyed by normalised name (upper-case)."""
    if not OUTPUT_FILE.exists():
        return {}
    with OUTPUT_FILE.open(encoding="utf-8") as fh:
        data = json.load(fh)
    # Migrate legacy "date" field to "argument" in-place; normalise name suffixes.
    for entry in data:
        for case in entry.get("cases", []):
            if "date" in case and "argument" not in case:
                case["argument"] = case.pop("date")
        normalised = normalize_name_suffix(entry["name"])
        if normalised != entry["name"]:
            print(f"  Normalised existing name: {entry['name']!r} -> {normalised!r}")
            entry["name"] = normalised
    return {entry["name"].upper(): entry for entry in data}


def next_id(existing: dict[str, dict]) -> int:
    """Return the next available NNNN integer after all existing IDs."""
    if not existing:
        return 1
    nums = []
    for entry in existing.values():
        try:
            nums.append(int(entry["id"].split("-")[1]))
        except (IndexError, ValueError, KeyError):
            pass
    return max(nums, default=0) + 1


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

    # advocates[name_upper] = {"id": ..., "name": ..., "cases": [...]}
    advocates: dict[str, dict] = load_existing()
    counter = next_id(advocates)  # retained for migration only, not written

    # Track recorded dates per (name, title, term, number) so we can skip
    # any new date that falls within 7 days of an already-recorded date for
    # the same advocate+case (multi-day arguments treated as one appearance).
    recorded_dates: dict[tuple[str, str, str, str], list[Date]] = {}
    for entry in advocates.values():
        for case in entry["cases"]:
            key = (entry["name"].upper(), case["title"], case["term"], case["number"])
            arg_date = case.get("argument") or case.get("date", "")
            if arg_date:
                recorded_dates.setdefault(key, []).append(Date.fromisoformat(arg_date))

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

            for orig_idx, audio in enumerate(audio_entries):
                audio_date = audio.get("date") or case.get("argument", "")

                def _record_advocate(raw_name: str) -> None:
                    """Add a case entry for raw_name under this audio object."""
                    name = raw_name.strip()
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
                        advocates[name_key] = {"name": name, "cases": []}
                    advocates[name_key]["cases"].append({
                        "title":    title,
                        "term":     term,
                        "number":   number,
                        "argument": audio_date,
                        **({"decision": decision} if decision else {}),
                        "audio":    audio_sorted_pos[orig_idx],
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

                for speaker in speakers:
                    if speaker.get("role") != "advocate":
                        continue
                    _record_advocate(speaker.get("name", ""))

    # Sort each advocate's cases chronologically by argument date
    for entry in advocates.values():
        entry["cases"].sort(key=lambda c: c.get("argument", c.get("date", "")))

    # Build output list sorted by name
    output = sorted(advocates.values(), key=lambda e: e["name"])

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_FILE.open("w", encoding="utf-8") as fh:
        json.dump(output, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(
        f"Wrote {len(output)} advocates "
        f"to {OUTPUT_FILE.relative_to(REPO_ROOT)}"
    )


if __name__ == "__main__":
    main()
