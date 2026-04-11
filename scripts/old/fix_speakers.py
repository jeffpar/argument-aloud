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
WOMEN_CSV = REPO_ROOT / "courts" / "ussc" / "people" / "advocates" / "women.csv"

# Terms whose advocates get an empty title (CSV not yet current)
NO_TITLE_TERMS = {"2025-10"}

# Matches title prefixes that appear in turn names but not as processed speaker titles.
# e.g. "MR. BIBAS", "MS. SAHARSKY", "GENERAL VERRILLI"
TITLE_PREFIX_RE = re.compile(
    r'^(MR\.|MRS\.|MISS|MS\.|GENERAL)\s+(.+)$',
    re.IGNORECASE,
)


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


_TITLE_INFER_RE = re.compile(
    r'\b(Mr\.|Mrs\.|Miss|Ms\.|General)\s+(?P<last>[A-Z][A-Za-z\'\-]+)',
    re.IGNORECASE,
)


def infer_title_from_turns(last_name: str, turns: list) -> str | None:
    """Scan turn text fields for 'Mr./Ms./General <last_name>' and return the
    canonical title ("MR.", "MS.", or "GENERAL"), or None if not found."""
    upper_last = last_name.upper()
    for turn in turns:
        for m in _TITLE_INFER_RE.finditer(turn.get('text', '')):
            if m.group('last').upper() == upper_last:
                prefix = m.group(1).upper()
                if prefix in {'MRS.', 'MISS', 'MS.'}:
                    return 'MS.'
                if prefix == 'GENERAL':
                    return 'GENERAL'
                return 'MR.'
    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def case_folder_number(number_str: str, term_dir: Path | None = None) -> str:
    """Return the case folder name for a (possibly comma-separated) case number.

    When a term_dir is supplied, tries each comma-separated part in order and
    returns the first one whose cases/ subdirectory actually exists on disk.
    Falls back to the first part when no folder is found.
    """
    parts = [p.strip() for p in number_str.split(",")]
    if term_dir is not None:
        for part in parts:
            if (term_dir / "cases" / part).exists():
                return part
    return parts[0]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(
    dry_run: bool = False,
    verbose: bool = False,
    show_women: bool = False,
    filter_term: str | None = None,
    filter_case: str | None = None,
) -> None:
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
        if p.is_dir()
        and (filter_term is None or p.name == filter_term)
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
            folder_num = case_folder_number(case.get("number", ""), term_dir)
            if filter_case is not None and folder_num != filter_case:
                continue
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
                # no TYPO/TITLE/UNKNOWN correction applies to any current speaker.
                def _needs_work(s: dict) -> bool:
                    if "role" in s:
                        return True
                    k = _norm_key(s)
                    # Canonical UNKNOWN names are fully normalised — no work needed.
                    if k in {"UNKNOWN JUSTICE", "UNKNOWN SPEAKER"}:
                        return False
                    # Any other UNKNOWN name needs normalisation.
                    if "UNKNOWN" in k:
                        return True
                    # Speaker name still has a title prefix (e.g. "MR. BIBAS").
                    if "title" not in s and TITLE_PREFIX_RE.match(s.get("name", "")):
                        return True
                    if s.get("title") in {"JUSTICE", "CHIEF JUSTICE"}:
                        corrected = typomap.get(k, s.get("name", ""))
                        corrected_key = re.sub(r'\s+', ' ', corrected).rstrip(':').upper()
                        if typomap.get(k) is not None or titlemap.get(corrected_key) is not None:
                            return True
                    return False

                def _has_prefixed_turns() -> bool:
                    current_names = {s.get("name", "") for s in speakers}
                    for turn in transcript.get("turns", []):
                        tname = turn.get("name", "")
                        if TITLE_PREFIX_RE.match(tname) and tname not in current_names:
                            return True
                    return False

                if not any(_needs_work(s) for s in speakers) and not _has_prefixed_turns():
                    already_done += 1
                    continue

                justice_out = []
                advocate_out = []
                other_out = []
                changed = False
                rename_map: dict[str, str] = {}
                valid_new_names: set[str] = set()

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
                        # Normalise "UNKNOWN JUSTICE" to canonical "UNKNOWN".
                        # Normalise any UNKNOWN variant to the canonical name
                        # used in the speakers array.  The context-detection pass
                        # below may later rename this to "UNKNOWN JUSTICE" if the
                        # turn is sandwiched between non-justice turns.
                        name_upper = re.sub(r'\s+', ' ', name).upper()
                        if "UNKNOWN" in name_upper:
                            name = "UNKNOWN JUSTICE"
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
                            # are silently preserved.  UNKNOWN JUSTICE is expected.
                            if (role == "justice" or typo_match is not None) \
                                    and "UNKNOWN" not in name.upper():
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
                        if speaker["name"] != new_speaker["name"]:
                            rename_map[speaker["name"].upper()] = new_speaker["name"]
                        valid_new_names.add(new_speaker["name"])
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
                        if speaker["name"] != name:
                            rename_map[speaker["name"].upper()] = name
                        valid_new_names.add(name)
                        if title == "MS.":
                            women_names.add(name)
                        elif title == "MR.":
                            men_names.add(name)

                    else:
                        # Already processed or unknown — preserve as-is
                        other_out.append(speaker)
                        valid_new_names.add(speaker.get("name", ""))

                # Justices first, then any already-processed, then advocates
                new_speakers = justice_out + other_out + advocate_out
                media["speakers"] = new_speakers

                # Strip title prefixes from speaker names that landed in
                # other_out without a title key (e.g. from a prior partial run
                # that wrote {"name": "MR. BIBAS"} without splitting it).
                for spk in new_speakers:
                    if "title" in spk:
                        continue
                    m = TITLE_PREFIX_RE.match(spk.get("name", ""))
                    if not m:
                        continue
                    raw_prefix = m.group(1).upper()
                    prefix = "MS." if raw_prefix in {"MRS.", "MISS"} else raw_prefix
                    rest = m.group(2).strip()
                    old_spk_name = spk["name"]
                    spk["name"] = rest
                    spk["title"] = "" if no_advocate_title else prefix
                    rename_map[old_spk_name.upper()] = rest
                    valid_new_names.discard(old_spk_name)
                    valid_new_names.add(rest)
                    if spk["title"] == "MS.":
                        women_names.add(rest)
                    elif spk["title"] == "MR.":
                        men_names.add(rest)
                    changed = True

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

                # Context detection: an UNKNOWN non-justice turn sandwiched
                # between two non-justice turns is likely an unknown justice
                # (advocates and justices typically alternate).
                JUSTICE_TITLES = {"JUSTICE", "CHIEF JUSTICE"}
                title_lookup = {s["name"]: s.get("title", "") for s in new_speakers}

                def _neighbor_is_non_justice(turns, start, step):
                    for j in range(start, len(turns) if step > 0 else -1, step):
                        nb = turns[j].get("name", "")
                        if nb and "UNKNOWN" not in nb.upper():
                            return title_lookup.get(nb, "") not in JUSTICE_TITLES
                    return False

                for i, turn in enumerate(turns):
                    tname = turn.get("name", "")
                    if not tname or "UNKNOWN" not in tname.upper():
                        continue
                    if title_lookup.get(tname, "") in JUSTICE_TITLES:
                        continue  # already a justice
                    if _neighbor_is_non_justice(turns, i - 1, -1) \
                            and _neighbor_is_non_justice(turns, i + 1, 1):
                        for s in new_speakers:
                            if s["name"] == tname:
                                old_name = s["name"]
                                s["name"] = "UNKNOWN JUSTICE"
                                s["title"] = "JUSTICE"
                                title_lookup["UNKNOWN JUSTICE"] = "JUSTICE"
                                title_lookup.pop(old_name, None)
                                valid_new_names.add("UNKNOWN JUSTICE")
                                justice_names.add("UNKNOWN JUSTICE")
                                changed = True
                                break
                        # Rename the affected turn immediately so subsequent
                        # neighbor checks use the updated name.
                        turn["name"] = "UNKNOWN JUSTICE"

                # Normalise any remaining UNKNOWN speakers (not promoted to
                # UNKNOWN JUSTICE above) to "UNKNOWN SPEAKER" with no title.
                for s in new_speakers:
                    if "UNKNOWN" in s.get("name", "").upper() \
                            and s["name"] != "UNKNOWN JUSTICE":
                        old_name = s["name"]
                        s["name"] = "UNKNOWN SPEAKER"
                        s["title"] = ""
                        title_lookup.pop(old_name, None)
                        title_lookup["UNKNOWN SPEAKER"] = ""
                        if old_name.upper() != "UNKNOWN SPEAKER":
                            rename_map[old_name.upper()] = "UNKNOWN SPEAKER"
                        valid_new_names.add("UNKNOWN SPEAKER")
                        changed = True

                # Apply the updated rename_map to any turns not yet renamed,
                # and do a final sweep to catch any residual UNKNOWN turn names.
                needs_unknown_speaker = False
                for turn in turns:
                    tname = turn.get("name", "")
                    if not tname:
                        continue
                    # Apply rename_map for non-UNKNOWN renames (UNKNOWN turns
                    # are handled separately below to avoid clobbering the
                    # UNKNOWN JUSTICE promotions done above).
                    tname_key = tname.upper()
                    if tname_key in rename_map and "UNKNOWN" not in tname_key \
                            and turn["name"] != rename_map[tname_key]:
                        turn["name"] = rename_map[tname_key]
                    # Any turn still containing "UNKNOWN" that was not promoted
                    # to "UNKNOWN JUSTICE" above becomes "UNKNOWN SPEAKER".
                    if "UNKNOWN" in turn.get("name", "").upper() \
                            and turn["name"] != "UNKNOWN JUSTICE":
                        turn["name"] = "UNKNOWN SPEAKER"
                        needs_unknown_speaker = True
                        changed = True

                # Ensure "UNKNOWN SPEAKER" exists in the speakers array if any
                # turns now reference it.
                if needs_unknown_speaker and not any(
                    s.get("name") == "UNKNOWN SPEAKER" for s in new_speakers
                ):
                    new_speakers.append({"name": "UNKNOWN SPEAKER", "title": ""})
                    valid_new_names.add("UNKNOWN SPEAKER")
                    changed = True

                # Strip title prefixes from turn names not already in the
                # speakers array: e.g. "MR. BIBAS" → name="BIBAS", title="MR."
                # MRS./MISS are normalised to MS.
                prefixed_rename: dict[str, str] = {}
                for turn in turns:
                    tname = turn.get("name", "")
                    if not tname or tname in valid_new_names:
                        continue
                    m = TITLE_PREFIX_RE.match(tname)
                    if not m:
                        continue
                    raw_prefix = m.group(1).upper()
                    prefix = "MS." if raw_prefix in {"MRS.", "MISS"} else raw_prefix
                    rest = m.group(2).strip()
                    prefixed_rename[tname.upper()] = rest
                    if rest not in valid_new_names:
                        title = "" if no_advocate_title else prefix
                        new_sp: dict = {"name": rest, "title": title}
                        new_speakers.append(new_sp)
                        valid_new_names.add(rest)
                        if title == "MS.":
                            women_names.add(rest)
                        elif title == "MR.":
                            men_names.add(rest)
                        changed = True

                for turn in turns:
                    tname = turn.get("name", "")
                    new_tname = prefixed_rename.get(tname.upper())
                    if new_tname is not None and turn["name"] != new_tname:
                        turn["name"] = new_tname
                        changed = True

                # For NO_TITLE_TERMS: infer title from turn text for non-justice
                # speakers whose title is still blank, by scanning for patterns
                # like "Mr. Stewart", "Ms. Prelogar", "General Verrilli".
                if no_advocate_title:
                    JUSTICE_TITLES_SET = {"JUSTICE", "CHIEF JUSTICE"}
                    for spk in new_speakers:
                        if spk.get("title") != "":
                            continue
                        if spk.get("title") in JUSTICE_TITLES_SET:
                            continue
                        spk_last = spk["name"].split()[-1] if spk.get("name") else ""
                        if not spk_last:
                            continue
                        inferred = infer_title_from_turns(spk_last, turns)
                        if inferred:
                            spk["title"] = inferred
                            changed = True
                            if show_women and inferred == "MS.":
                                print(
                                    f"  MS. {spk['name']} (inferred) in "
                                    f"{transcript_path.relative_to(REPO_ROOT)}"
                                )
                            if inferred == "MS.":
                                women_names.add(spk["name"])
                            elif inferred == "MR.":
                                men_names.add(spk["name"])

                if not changed:
                    already_done += 1
                    continue

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
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("term", nargs="?", default=None, metavar="TERM",
                    help="Limit to this term (e.g. 2012-10)")
    ap.add_argument("case", nargs="?", default=None, metavar="CASE",
                    help="Limit to this case number (e.g. 12-126)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--women", action="store_true")
    args = ap.parse_args()
    main(
        dry_run=args.dry_run,
        verbose=args.verbose,
        show_women=args.women,
        filter_term=args.term,
        filter_case=args.case,
    )
