#!/usr/bin/env python3
"""Builds/updates courts/ussc/people/advocates.json from transcript files.

For every case in every cases.json under courts/ussc/terms/, follows each
audio entry's text_href to its transcript file, extracts speakers whose role
is "advocate", and records which case/date they appeared in.

The output is an array of people objects:
  {
    "id":    "1-0001",          # T-NNNN; T=1, NNNN incremented from 1
    "name":  "JOHN DOE",
    "cases": [                  # sorted chronologically by date
      {
        "title":  "Roe v. Wade",
        "term":   "1971-10",
        "number": "70-18",
        "date":   "1971-12-13"
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
import sys
from datetime import date as Date, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
TERMS_DIR = REPO_ROOT / "courts" / "ussc" / "terms"
OUTPUT_FILE = REPO_ROOT / "courts" / "ussc" / "people" / "advocates.json"

ID_PREFIX = "P"


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
    return {entry["name"].upper(): entry for entry in data}


def next_id(existing: dict[str, dict]) -> int:
    """Return the next available NNNN integer after all existing IDs."""
    if not existing:
        return 1
    nums = []
    for entry in existing.values():
        try:
            nums.append(int(entry["id"].split("-")[1]))
        except (IndexError, ValueError):
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
    counter = next_id(advocates)

    # Track recorded dates per (name, title, term, number) so we can skip
    # any new date that falls within 7 days of an already-recorded date for
    # the same advocate+case (multi-day arguments treated as one appearance).
    recorded_dates: dict[tuple[str, str, str, str], list[Date]] = {}
    for entry in advocates.values():
        for case in entry["cases"]:
            key = (entry["name"].upper(), case["title"], case["term"], case["number"])
            recorded_dates.setdefault(key, []).append(Date.fromisoformat(case["date"]))

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

            for audio in audio_entries:
                text_href = audio.get("text_href")
                date = audio.get("date", "")
                if not text_href or not date:
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

                media = transcript.get("media", {})
                speakers = media.get("speakers", [])

                for speaker in speakers:
                    if speaker.get("role") != "advocate":
                        continue
                    raw_name = speaker.get("name", "").strip()
                    if not raw_name:
                        continue
                    name_key = raw_name.upper()

                    # Skip if this date is within 7 days of any already-
                    # recorded date for this advocate+case (multi-day argument).
                    case_key = (name_key, title, term, number)
                    try:
                        new_dt = Date.fromisoformat(date)
                    except ValueError:
                        continue
                    prior = recorded_dates.get(case_key, [])
                    if any(abs((new_dt - d).days) <= 7 for d in prior):
                        continue
                    recorded_dates.setdefault(case_key, []).append(new_dt)

                    # Ensure advocate record exists
                    if name_key not in advocates:
                        advocates[name_key] = {
                            "id": make_id(counter),
                            "name": raw_name,
                            "cases": [],
                        }
                        counter += 1

                    advocates[name_key]["cases"].append({
                        "title": title,
                        "term": term,
                        "number": number,
                        "date": date,
                    })

    # Sort each advocate's cases chronologically
    for entry in advocates.values():
        entry["cases"].sort(key=lambda c: c["date"])

    # Build output list sorted by ID
    output = sorted(advocates.values(), key=lambda e: e["id"])

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
