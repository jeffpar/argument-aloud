#!/usr/bin/env python3
"""Fix speaker metadata in transcript JSON files.

For every transcript referenced by a text_href in cases.json:

  - Justice speakers (role == "justice"):
      • Reverse-lookup the display name (e.g. "CHIEF JUSTICE BURGER") in
        speakermap.txt to find the full name ("WARREN E. BURGER").
      • Set "name" to the full name.
      • Remove "role"; add "title" ("JUSTICE" or "CHIEF JUSTICE").

  - Advocate speakers (role == "advocate"):
      • Set "title" to "MS." if the name appears in women.csv
        (exact full-name match, case-insensitive; fallback: first + last
        name both match).  Otherwise "MR.".
      • For the 2025 term (CSV not yet current), always set "title" to "".
      • Remove "role".
      • Move to the end of the speakers array (after all justices).

Usage:
    python3 scripts/old/fix_speakers.py [--dry-run]
"""

import csv
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TERMS_DIR = REPO_ROOT / "courts" / "ussc" / "terms"
SPEAKERMAP = Path(__file__).resolve().parent / "speakermap.txt"
WOMEN_CSV = REPO_ROOT / "courts" / "ussc" / "people" / "women.csv"

# Terms whose advocates get an empty title (CSV not yet current)
NO_TITLE_TERMS = {"2025-10"}


# ---------------------------------------------------------------------------
# Speakermap
# ---------------------------------------------------------------------------

def parse_speakermap(path: Path) -> dict[str, dict]:
    """Build a reverse lookup: display_name_upper → {full, title}.

    speakermap.txt lines look like:
        JUSTICE:ABE FORTAS -> JUSTICE FORTAS
        JUSTICE:WILLIAM H. REHNQUIST < 1986-10  -> JUSTICE REHNQUIST
        JUSTICE:WILLIAM H. REHNQUIST >= 1986-10 -> CHIEF JUSTICE REHNQUIST

    The display names on the right are already distinct (e.g. "JUSTICE REHNQUIST"
    vs "CHIEF JUSTICE REHNQUIST"), so the reverse lookup is unambiguous.
    """
    lookup: dict[str, dict] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or not line.startswith("JUSTICE:"):
            continue
        left, _, right = line.partition(" -> ")
        if not right:
            continue
        # Strip "JUSTICE:" prefix and any trailing condition clause
        full_raw = left[len("JUSTICE:"):]
        full_name = re.sub(r'\s+[<>]=?\s+\d{4}-\d{2}\s*$', '', full_raw).strip()

        display = right.strip().upper()
        if display.startswith("CHIEF JUSTICE "):
            title = "CHIEF JUSTICE"
        else:
            title = "JUSTICE"

        lookup[display] = {"full": full_name, "title": title}
    return lookup


def parse_typomap(path: Path) -> dict[str, str]:
    """Build typo lookup: normalised_bad_name_upper → corrected_name.

    speakermap.txt lines look like:
        TYPO:CHIEF JUSTICE ROBERT -> CHIEF JUSTICE ROBERTS
        TYPO:JUSTICE GINSBERG     -> RUTH BADER GINSBURG

    The corrected name may be a display name (which will then be resolved
    via the JUSTICE lookup) or a full name (which is used directly).
    """
    lookup: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or not line.startswith("TYPO:"):
            continue
        left, _, right = line.partition(" -> ")
        if not right:
            continue
        bad_name = left[len("TYPO:"):]
        key = re.sub(r'\s+', ' ', bad_name).rstrip(':').upper()
        lookup[key] = right.strip()
    return lookup


def parse_titlemap(path: Path) -> dict[str, str]:
    """Build title-override lookup: normalised_name_upper → title_value.

    speakermap.txt lines look like:
        TITLE:CARTER G. PHILLIPS  -> MR.
        TITLE:ELIZABETH B. PRELOGAR -> MS.

    The right side is a title string: "MR.", "MS.", "JUSTICE", or
    "CHIEF JUSTICE".  When only a "role" field is present on the speaker
    (i.e. not yet processed), the role is updated to match: "advocate" for
    MR./MS., "justice" for JUSTICE/CHIEF JUSTICE.
    """
    lookup: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or not line.startswith("TITLE:"):
            continue
        left, _, right = line.partition(" -> ")
        if not right:
            continue
        name = left[len("TITLE:"):]
        key = re.sub(r'\s+', ' ', name).rstrip(':').upper()
        lookup[key] = right.strip()
    return lookup


# ---------------------------------------------------------------------------
# Women CSV
# ---------------------------------------------------------------------------

def parse_women_advocates(path: Path) -> tuple[set, set]:
    """Return (exact_upper, first_last_upper) for MS. detection."""
    exact: set[str] = set()
    first_last: set[tuple[str, str]] = set()
    if not path.exists():
        return exact, first_last
    with path.open(encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = row.get("nameAdvocate", "").strip()
            if not name:
                continue
            exact.add(name.upper())
            parts = name.split()
            if len(parts) >= 2:
                first_last.add((parts[0].upper(), parts[-1].upper()))
    return exact, first_last


def is_woman(name: str, exact: set, first_last: set) -> bool:
    upper = name.upper()
    if upper in exact:
        return True
    parts = upper.split()
    return len(parts) >= 2 and (parts[0], parts[-1]) in first_last


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def case_folder_number(number_str: str) -> str:
    return number_str.split(",")[0].strip()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(dry_run: bool = False, verbose: bool = False, show_women: bool = False) -> None:
    if not SPEAKERMAP.exists():
        print(f"ERROR: speakermap not found: {SPEAKERMAP}", file=sys.stderr)
        sys.exit(1)

    speakermap = parse_speakermap(SPEAKERMAP)
    typomap = parse_typomap(SPEAKERMAP)
    titlemap = parse_titlemap(SPEAKERMAP)
    # Also allow lookup by full name (for TYPO entries that resolve directly
    # to a full name rather than a display name).
    full_name_lookup = {v["full"].upper(): v for v in speakermap.values()}
    women_exact, women_first_last = parse_women_advocates(WOMEN_CSV)

    term_dirs = sorted(
        p for p in TERMS_DIR.iterdir()
        if p.is_dir() and p.name[:4] >= "1968"
    )

    updated = 0
    already_done = 0
    warn_count = 0
    justice_names: set[str] = set()
    men_names: set[str] = set()
    women_names: set[str] = set()

    for term_dir in term_dirs:
        term = term_dir.name
        no_advocate_title = term in NO_TITLE_TERMS

        cases_file = term_dir / "cases.json"
        if not cases_file.exists():
            continue

        try:
            cases = json.loads(cases_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"WARNING: could not parse {cases_file}: {exc}", file=sys.stderr)
            continue

        for case in cases:
            folder_num = case_folder_number(case.get("number", ""))
            for audio in case.get("audio", []):
                text_href = audio.get("text_href")
                if not text_href:
                    continue

                transcript_path = term_dir / "cases" / folder_num / text_href
                if not transcript_path.exists():
                    continue

                try:
                    transcript = json.loads(
                        transcript_path.read_text(encoding="utf-8")
                    )
                except json.JSONDecodeError as exc:
                    print(
                        f"WARNING: could not parse {transcript_path}: {exc}",
                        file=sys.stderr,
                    )
                    continue

                media = transcript.get("media")
                if not isinstance(media, dict):
                    continue

                speakers = media.get("speakers", [])
                if not speakers:
                    continue

                def _norm_key(s: dict) -> str:
                    return re.sub(r'\s+', ' ', s.get("name", "")).rstrip(':').upper()

                # Skip if already processed: no "role" fields remain AND
                # no TYPO/TITLE correction applies to any current speaker name.
                def _needs_work(s: dict) -> bool:
                    if "role" in s:
                        return True
                    k = _norm_key(s)
                    if s.get("title") in {"JUSTICE", "CHIEF JUSTICE"}:
                        corrected = typomap.get(k, s.get("name", ""))
                        corrected_key = re.sub(r'\s+', ' ', corrected).rstrip(':').upper()
                        if typomap.get(k) is not None or titlemap.get(corrected_key) is not None:
                            return True
                    return False

                if not any(_needs_work(s) for s in speakers):
                    already_done += 1
                    continue

                justice_out = []
                advocate_out = []
                other_out = []
                changed = False

                for speaker in speakers:
                    role = speaker.get("role")
                    s_title = speaker.get("title")
                    name = speaker.get("name", "")

                    # Apply TYPO substitution before anything else.
                    typo_key = re.sub(r'\s+', ' ', name).rstrip(':').upper()
                    typo_match = typomap.get(typo_key)
                    if typo_match is not None:
                        name = typo_match

                    # Apply TITLE override: when only "role" is present (not
                    # yet processed), correct the role based on the mapping.
                    title_key = re.sub(r'\s+', ' ', name).rstrip(':').upper()
                    title_override = titlemap.get(title_key)
                    if title_override is not None and role is not None and s_title is None:
                        if title_override in {"MR.", "MS."}:
                            role = "advocate"
                        elif title_override in {"JUSTICE", "CHIEF JUSTICE"}:
                            role = "justice"

                    is_justice = role == "justice" or (
                        role is None and s_title in {"JUSTICE", "CHIEF JUSTICE"}
                    )

                    if is_justice:
                        # Normalise OCR artefacts: collapse runs of spaces, strip
                        # stray trailing punctuation before lookup.
                        display_key = re.sub(r'\s+', ' ', name).rstrip(':').upper()
                        info = (
                            speakermap.get(display_key)
                            or full_name_lookup.get(display_key)
                        )
                        if info:
                            new_speaker = {
                                "name": info["full"],
                                "title": info["title"],
                            }
                        else:
                            # Only warn when there was active work to do.
                            # Already-processed speakers that need no change
                            # are silently preserved.
                            if role == "justice" or typo_match is not None:
                                print(
                                    f"  WARN: unknown justice {name} in "
                                    f"{transcript_path.relative_to(REPO_ROOT)}",
                                    file=sys.stderr,
                                )
                                warn_count += 1
                            inferred_title = (
                                "CHIEF JUSTICE"
                                if name.upper().startswith("CHIEF JUSTICE")
                                else "JUSTICE"
                            )
                            new_speaker = {"name": name, "title": inferred_title}

                        # Only mark changed if the speaker dict actually differs.
                        if new_speaker != {
                            "name": speaker["name"],
                            "title": speaker.get("title"),
                        }:
                            changed = True
                        justice_out.append(new_speaker)
                        justice_names.add(new_speaker["name"])

                    elif role == "advocate":
                        if no_advocate_title:
                            title = ""
                        elif title_override in {"MR.", "MS."}:
                            title = title_override
                        elif is_woman(name, women_exact, women_first_last):
                            title = "MS."
                        else:
                            title = "MR."
                        if show_women and title == "MS.":
                            print(
                                f"  MS. {name} in "
                                f"{transcript_path.relative_to(REPO_ROOT)}"
                            )
                        advocate_out.append({"name": name, "title": title})
                        changed = True
                        if title == "MS.":
                            women_names.add(name)
                        elif title == "MR.":
                            men_names.add(name)

                    else:
                        # Already processed or unknown — preserve as-is
                        other_out.append(speaker)

                if not changed:
                    already_done += 1
                    continue

                # Justices first, then any already-processed, then advocates
                new_speakers = justice_out + other_out + advocate_out
                media["speakers"] = new_speakers

                # Build a rename map: old display name (upper) → new full name.
                # Also build the set of valid new names for turn-name validation.
                rename_map: dict[str, str] = {}
                valid_new_names: set[str] = set()
                for orig, new_sp in zip(speakers, new_speakers):
                    old_name = orig.get("name", "")
                    new_name = new_sp["name"]
                    if old_name != new_name:
                        rename_map[old_name.upper()] = new_name
                    valid_new_names.add(new_name)

                # Update turn names and warn on any that don't match a speaker.
                turns = transcript.get("turns", [])
                for turn in turns:
                    tname = turn.get("name", "")
                    if not tname:
                        continue
                    tname_key = tname.upper()
                    if tname_key in rename_map:
                        turn["name"] = rename_map[tname_key]
                    elif turn["name"] not in valid_new_names:
                        print(
                            f"  WARN: turn name {turn['name']} not in speakers "
                            f"in {transcript_path.relative_to(REPO_ROOT)}",
                            file=sys.stderr,
                        )
                        warn_count += 1

                if not dry_run:
                    transcript_path.write_text(
                        json.dumps(transcript, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8",
                    )
                updated += 1
                if verbose:
                    print(
                        f"  {'(dry) ' if dry_run else ''}updated  "
                        f"{transcript_path.relative_to(REPO_ROOT)}"
                    )

    summary = f"\n{updated} transcripts updated, {already_done} already processed"
    if warn_count:
        summary += f", {warn_count} unrecognised justice names"
    summary += f"\n{len(justice_names)} unique justices, {len(men_names)} unique men, {len(women_names)} unique women"
    print(summary)


if __name__ == "__main__":
    main(dry_run="--dry-run" in sys.argv, verbose="--verbose" in sys.argv, show_women="--women" in sys.argv)
