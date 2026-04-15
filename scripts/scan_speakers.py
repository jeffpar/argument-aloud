#!/usr/bin/env python3
"""Scan transcript text files for a speaker by first and last name.

For every audio entry across all terms that has a transcript_href, locates
the corresponding plain-text dump in courts/ussc/transcripts/text/ and
searches it for the given name.  Prints matching term + case numbers.

Usage:
    python3 scripts/scan_speakers.py <first_name> <last_name> [--term TERM]

Examples:
    python3 scripts/scan_speakers.py Barbara Jarrett
    python3 scripts/scan_speakers.py Barbara Jarrett --term 1990-10
"""

import argparse
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT   = Path(__file__).resolve().parent.parent
TERMS_DIR   = REPO_ROOT / "courts" / "ussc" / "terms"
TEXT_DIR    = REPO_ROOT / "courts" / "ussc" / "transcripts" / "text"


def case_folder_number(number_str: str) -> str:
    """Return the first (leading) case number from a comma-separated string."""
    return number_str.split(",")[0].strip()


def text_path_for(transcript_href: str, audio_date: str) -> Path | None:
    """Derive the transcript text file path from a PDF URL and audio date.

    Handles two URL patterns:
      New: .../oral_arguments/argument_transcripts/YYYY/<case>_<hash>.pdf
      Old: .../pdfs/transcripts/YYYY/<case>_<date>.pdf

    The text file is stored as:
        courts/ussc/transcripts/text/YYYY/<case-number>_<audio-date>.txt

    The year folder is taken from the URL; the case number is the portion of
    the PDF filename before the first underscore.
    Falls back to the audio date's year when the URL year can't be found.
    """
    m = re.search(
        r'/(?:argument_transcripts|transcripts)/(\d{4})/([^/]+)\.pdf$',
        transcript_href,
    )
    if m:
        year     = m.group(1)
        pdf_stem = m.group(2)
    else:
        # Last-resort: use the year from audio_date
        year     = audio_date[:4] if audio_date else ""
        url_stem = transcript_href.rstrip('/').rsplit('/', 1)[-1]
        pdf_stem = url_stem.removesuffix('.pdf')

    if not year:
        return None
    case_num = pdf_stem.split("_")[0]
    filename = f"{case_num}_{audio_date}.txt"
    return TEXT_DIR / year / filename


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Scan transcript texts for occurrences of a speaker name."
    )
    ap.add_argument("first_name", help="Speaker's first name (case-insensitive)")
    ap.add_argument("last_name",  help="Speaker's last name (case-insensitive)")
    ap.add_argument("--term", default=None, metavar="TERM",
                    help="Limit search to a single term (e.g. 1990-10)")
    ap.add_argument("--official", action="store_true",
                    help="Search official speaker/advocate metadata only; "
                         "print term, case, and date for each appearance "
                         "not within 7 days of a previous one")
    args = ap.parse_args()

    first = args.first_name.strip()
    last  = args.last_name.strip()

    # Build a pattern that matches "First Last" or "Last, First".
    pattern = re.compile(
        rf'\b{re.escape(first)}\s+{re.escape(last)}\b'
        rf'|'
        rf'\b{re.escape(last)},\s*{re.escape(first)}\b',
        re.IGNORECASE,
    )

    term_dirs = sorted(
        p for p in TERMS_DIR.iterdir()
        if p.is_dir() and (args.term is None or p.name == args.term)
    )

    if not term_dirs:
        print(f"No term directories found (filter: {args.term!r})", file=sys.stderr)
        sys.exit(1)

    if args.official:
        last_up   = last.upper()
        first_up  = first.upper()
        last_date_by_case: dict[str, date] = {}
        hits = 0
        for term_dir in term_dirs:
            cases_file = term_dir / "cases.json"
            if not cases_file.exists():
                continue
            try:
                cases = json.loads(cases_file.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                print(f"WARNING: could not parse {cases_file}: {exc}", file=sys.stderr)
                continue
            for case in cases:
                number     = case.get("number") or case.get("id") or ""
                case_label = case_folder_number(number) if number else "(unknown)"
                case_dir   = term_dir / "cases" / case_label
                case_key   = f"{term_dir.name}/{case_label}"
                for audio in case.get("audio", []):
                    audio_date_str = audio.get("date", "")
                    # Check advocates list on the audio object
                    advocates = [a.upper() for a in audio.get("advocates", [])]
                    found = any(
                        re.search(rf'\b{re.escape(last_up)}\b', a) and
                        re.search(rf'\b{re.escape(first_up)}\b', a)
                        for a in advocates
                    )
                    # Check speakers array inside an existing transcript JSON
                    if not found:
                        text_href = audio.get("text_href")
                        if text_href:
                            jp = term_dir / "cases" / text_href
                            if jp.exists():
                                try:
                                    tdata = json.loads(jp.read_text(encoding="utf-8"))
                                    existing = [
                                        s.get("name", "").upper()
                                        for s in tdata.get("media", {}).get("speakers", [])
                                    ]
                                    found = any(
                                        re.search(rf'\b{re.escape(last_up)}\b', n) and
                                        re.search(rf'\b{re.escape(first_up)}\b', n)
                                        for n in existing
                                    )
                                except (json.JSONDecodeError, OSError):
                                    pass
                    if not found:
                        continue
                    # Deduplicate: skip if same case and within 7 days of a
                    # previous match for that case.
                    try:
                        adate = date.fromisoformat(audio_date_str)
                    except ValueError:
                        adate = None
                    prev = last_date_by_case.get(case_key)
                    if adate and prev and abs((adate - prev).days) <= 7:
                        continue
                    if adate:
                        last_date_by_case[case_key] = adate
                    print(f"{term_dir.name}  {case_label}  {audio_date_str}")
                    hits += 1
        print(f"\n{hits} appearance{'s' if hits != 1 else ''} for '{first} {last}'")
        return


    hits = 0
    for term_dir in term_dirs:
        cases_file = term_dir / "cases.json"
        if not cases_file.exists():
            continue
        try:
            cases = json.loads(cases_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"WARNING: could not parse {cases_file}: {exc}", file=sys.stderr)
            continue

        last_up = last.upper()

        for case in cases:
            number     = case.get("number") or case.get("id") or ""
            case_label = case_folder_number(number) if number else "(unknown)"

            # If the speaker's last name already appears in any transcript JSON
            # speakers array, or in any audio entry's "advocates" list, skip
            # the entire case.
            case_dir = term_dir / "cases" / case_label
            already_known = False
            for audio in case.get("audio", []):
                # Check advocates list on the audio object itself
                advocates = [a.upper() for a in audio.get("advocates", [])]
                if any(re.search(rf'\b{re.escape(last_up)}\b', a) for a in advocates):
                    already_known = True
                    break
                # Check speakers array inside an existing transcript JSON
                text_href = audio.get("text_href")
                if not text_href:
                    continue
                jp = term_dir / "cases" / text_href
                if not jp.exists():
                    continue
                try:
                    tdata = json.loads(jp.read_text(encoding="utf-8"))
                    existing = [
                        s.get("name", "").upper()
                        for s in tdata.get("media", {}).get("speakers", [])
                    ]
                    if any(re.search(rf'\b{re.escape(last_up)}\b', name) for name in existing):
                        already_known = True
                        break
                except (json.JSONDecodeError, OSError):
                    pass
            if already_known:
                continue

            for audio in case.get("audio", []):
                transcript_href = audio.get("transcript_href")
                if not transcript_href:
                    continue
                audio_date = audio.get("date", "")
                txt = text_path_for(transcript_href, audio_date)
                if txt is None or not txt.exists():
                    continue

                try:
                    content = txt.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue

                if pattern.search(content):
                    text_href = audio.get("text_href")
                    json_path = (
                        term_dir / "cases" / text_href
                        if text_href else None
                    )

                    if json_path:
                        print(json_path.relative_to(REPO_ROOT))
                    else:
                        print(f"courts/ussc/terms/{term_dir.name}/cases/{case_label}/  (no text_href)")
                    pdf = TEXT_DIR.parent / "pdfs" / txt.parent.name / (txt.stem + ".pdf")
                    print(f"  (refer to: {pdf.relative_to(REPO_ROOT)})")
                    hits += 1

    print(f"\n{hits} match{'es' if hits != 1 else ''} for '{first} {last}'")


if __name__ == "__main__":
    main()
