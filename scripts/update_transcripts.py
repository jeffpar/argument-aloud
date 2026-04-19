#!/usr/bin/env python3
"""Check transcript_href entries against the set of PDF files.

For every case in every term from 1968 onward, checks that each audio
entry's transcript_href corresponds to an actual PDF file under:

    courts/ussc/transcripts/pdfs/YYYY/

URL basenames use date format MM-DD-YYYY; the target location uses
YYYY-MM-DD.  Secondary consolidated case numbers (e.g. the "83-1373" in
"83-1013_83-1373_11-06-1984.pdf") are stripped; non-numeric qualifiers
(e.g. "Orig") are retained and joined with hyphens.

Usage:
    python3 scripts/update_transcripts.py [--verbose] [--download] [--extract]
"""

import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO_ROOT       = Path(__file__).resolve().parent.parent
TERMS_DIR       = REPO_ROOT / "courts" / "ussc" / "terms"
PDFS_DIR        = REPO_ROOT / "courts" / "ussc" / "transcripts" / "pdfs"
TEXT_DIR        = REPO_ROOT / "courts" / "ussc" / "transcripts" / "text"

# Matches the trailing _MM-DD-YYYY.pdf in a URL basename
_DATE_RE = re.compile(r'_(\d{2})-(\d{2})-(\d{4})\.pdf$', re.IGNORECASE)
# Matches _MM-DD-YYYY_A.pdf / _MM-DD-YYYY_B.pdf (part-letter variants)
_DATE_LETTER_RE = re.compile(r'_(\d{2})-(\d{2})-(\d{4})_([A-Z])\.pdf$', re.IGNORECASE)
# Matches the trailing opaque hash suffix, e.g. _o7jp.pdf, _2co3.pdf, or -8fe5.pdf
# Requires at least one letter so pure numeric suffixes like -4160 are not confused for hashes.
# Excludes 'orig' so that bare filenames like '137-Orig.pdf' are not mistaken for hashes.
_HASH_RE = re.compile(r'[_-](?!orig\.pdf$)(?=[a-z0-9]*[a-z])[a-z0-9]{4}\.pdf$', re.IGNORECASE)
# Matches the year segment in the URL path  (/YYYY/)
_YEAR_RE = re.compile(r'/(\d{4})/')
# Merges N_Orig pairs (e.g. "43_Orig") into a single token "43-ORIG"
_ORIG_MERGE_RE = re.compile(r'([^_]+)_(Orig)', re.IGNORECASE)
# Matches inline orig suffix with no separator, e.g. "105orig" -> "105-ORIG"
_ORIG_INLINE_RE = re.compile(r'^(\d+)(orig)$', re.IGNORECASE)
# Strips trailing alpha suffix directly attached to a digit, e.g. "99-1257REV" -> "99-1257"
# Does NOT affect "-ORIG" because the O follows a hyphen, not a digit.
_TRAILING_ALPHA_RE = re.compile(r'(?<=\d)[A-Z]+$')
# Matches leading "No_N" prefix, e.g. "No_67" -> "67"
_NO_PREFIX_RE = re.compile(r'^No_(\d+)', re.IGNORECASE)


def _normalise_prefix(prefix: str) -> str:
    """Normalise Orig variants, then keep only the first case-number token.

    Handles, in order:
      "No_67_Orig"      -> "67-ORIG"
      "105orig"         -> "105-ORIG"
      "43_Orig_44_Orig" -> "43-ORIG"
      "83-1013_83-1373" -> "83-1013"
      "35_Orig"         -> "35-ORIG"
      "99-1257rev"      -> "99-1257"
    """
    # Normalise comma separators (e.g. "126, orig") to underscores
    prefix = re.sub(r',\s*', '_', prefix)
    # Strip leading "No_" and merge with following "_Orig" via normal path
    prefix = _NO_PREFIX_RE.sub(lambda m: m.group(1), prefix)
    # Merge N_Orig pairs into N-ORIG tokens
    prefix = _ORIG_MERGE_RE.sub(lambda m: m.group(1) + '-ORIG', prefix)
    # Keep only first token then fix inline "105orig" style
    first = prefix.split('_')[0].upper()
    first = _ORIG_INLINE_RE.sub(lambda m: m.group(1) + '-ORIG', first)
    # Strip trailing alpha revision suffixes attached directly to a digit
    first = _TRAILING_ALPHA_RE.sub('', first)
    return first


# Years where SCOTUS prepended a YY- term-year prefix to case numbers
_YY_PREFIX_YEARS = {"1968", "1969", "1970"}


def _strip_year_prefix(prefix: str, url_year: str) -> str:
    """For 1968–1970 URLs, strip any two-digit year prefix in the 68–70 range.

    Covers cross-year cases like "69-5161" appearing under the 1970 folder.
    e.g. url_year="1970", prefix="69-5161" -> "5161"
         url_year="1968", prefix="68-10"   -> "10"
    """
    if url_year not in _YY_PREFIX_YEARS:
        return prefix
    for yy in ("68", "69", "70"):
        leading = f"{yy}-"
        if prefix.startswith(leading):
            return prefix[len(leading):]
    return prefix


def url_to_expected(
    url: str,
    audio_date: str | None = None,
) -> tuple[str | None, str | None]:
    """Return (year, expected_filename) for a SCOTUS transcript URL.

    Returns (year, None) when the URL year is found but no date can be
    determined (no date in URL and no audio_date supplied).
    Returns (None, None) when the year cannot be determined.

    Conversion rules
    ----------------
    Classic URL basename : 83-1013_83-1373_11-06-1984.pdf
    Expected file        : 83-1013_1984-11-06.pdf

    Hash URL basename    : 23-108_o7jp.pdf  (with audio_date='2023-10-03')
    Expected file        : 23-108_2023-10-03.pdf
    """
    year_m = _YEAR_RE.search(url)
    if not year_m:
        return None, None
    year = year_m.group(1)

    basename = url.rsplit("/", 1)[-1]

    # Part-letter variant: _MM-DD-YYYY_A.pdf
    # Canonical form: PREFIX_YYYY-MM-DD-A.pdf; fall back to PREFIX_YYYY-MM-DD.pdf.
    dl_m = _DATE_LETTER_RE.search(basename)
    if dl_m:
        mm, dd, yyyy, letter = dl_m.group(1), dl_m.group(2), dl_m.group(3), dl_m.group(4).upper()
        iso_date = f"{yyyy}-{mm}-{dd}"
        prefix = _normalise_prefix(basename[: dl_m.start()])
        prefix = _strip_year_prefix(prefix, year)
        return year, [f"{prefix}_{iso_date}-{letter}.pdf", f"{prefix}_{iso_date}.pdf"]

    # Classic format: _MM-DD-YYYY.pdf
    date_m = _DATE_RE.search(basename)
    if date_m:
        mm, dd, yyyy = date_m.group(1), date_m.group(2), date_m.group(3)
        iso_date = f"{yyyy}-{mm}-{dd}"
        prefix = _normalise_prefix(basename[: date_m.start()])
        prefix = _strip_year_prefix(prefix, year)
        return year, f"{prefix}_{iso_date}.pdf"

    # Hash format: _XXXX.pdf — use audio_date if available
    hash_m = _HASH_RE.search(basename)
    if hash_m and audio_date:
        prefix = _normalise_prefix(basename[: hash_m.start()])
        prefix = _strip_year_prefix(prefix, year)
        return year, f"{prefix}_{audio_date}.pdf"

    # Bare format: CASE-NUMBER.pdf (no suffix) — use audio_date if available
    if basename.lower().endswith(".pdf") and audio_date:
        prefix = _normalise_prefix(basename[:-4])
        prefix = _strip_year_prefix(prefix, year)
        return year, f"{prefix}_{audio_date}.pdf"

    return year, None


def main(verbose: bool = False, download: bool = False) -> None:
    if not PDFS_DIR.is_dir():
        print(f"ERROR: PDFs directory not found: {PDFS_DIR}", file=sys.stderr)
        sys.exit(1)

    term_dirs = sorted(
        p for p in TERMS_DIR.iterdir()
        if p.is_dir() and p.name[:4] >= "1968"
    )

    if not term_dirs:
        print(f"No term directories >= 1968 found under {TERMS_DIR}", file=sys.stderr)
        sys.exit(1)

    found = 0
    missing = 0
    downloaded = 0
    failed = 0
    unrecognised = 0

    for term_dir in term_dirs:
        term = term_dir.name
        cases_file = term_dir / "cases.json"
        if not cases_file.exists():
            continue

        try:
            cases = json.loads(cases_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            print(f"WARNING: could not parse {cases_file}: {exc}", file=sys.stderr)
            continue

        for case in cases:
            number = case.get("number", "?")
            for audio in case.get("events", []):
                href = audio.get("transcript_href")
                if not href:
                    continue

                audio_date = audio.get("date") or case.get("argument") or None
                year, result = url_to_expected(href, audio_date)

                if year is None:
                    unrecognised += 1
                    print(f"UNRECOGNISED  [{term}  {number}]  {href}")
                    continue

                if result is None:
                    unrecognised += 1
                    print(f"NO DATE       [{term}  {number}]  {href}")
                    continue

                candidates = result if isinstance(result, list) else [result]
                matched = next(
                    (f for f in candidates if (PDFS_DIR / year / f).exists()),
                    None,
                )
                if matched is not None:
                    found += 1
                    if verbose:
                        print(f"OK            [{term}  {number}]  {matched}")
                else:
                    missing += 1
                    dest = PDFS_DIR / year / candidates[0]
                    if download:
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        print(f"DOWNLOADING   [{term}  {number}]  {candidates[0]}")
                        try:
                            req = urllib.request.Request(
                                href,
                                headers={"User-Agent": "Mozilla/5.0 update_transcripts.py"},
                            )
                            with urllib.request.urlopen(req) as resp:
                                dest.write_bytes(resp.read())
                            downloaded += 1
                            if verbose:
                                print(f"              saved: {dest}")
                        except Exception as exc:
                            failed += 1
                            print(f"  ERROR: {exc}", file=sys.stderr)
                    else:
                        print(f"MISSING       [{term}  {number}]  {href}")
                        if verbose:
                            print(f"              expected: {dest}")

    summary = f"\n{found} found, {missing} missing"
    if download:
        summary += f" ({downloaded} downloaded, {failed} failed)"
    if unrecognised:
        summary += f", {unrecognised} unrecognised URL format"
    print(summary)


def extract() -> None:
    """Extract text from every PDF in the pdfs tree via pdftotext.

    For each YYYY/ subdirectory in PDFS_DIR, creates a matching
    directory under courts/ussc/transcripts/text/YYYY/ and runs:
        pdftotext -layout <src>.pdf <dest>.txt
    Skips PDFs whose .txt counterpart already exists.
    """
    if not PDFS_DIR.is_dir():
        print(f"ERROR: PDFs directory not found: {PDFS_DIR}", file=sys.stderr)
        sys.exit(1)

    year_dirs = sorted(p for p in PDFS_DIR.iterdir() if p.is_dir())
    if not year_dirs:
        print("No year directories found.", file=sys.stderr)
        sys.exit(1)

    total = skipped = errors = 0
    for year_dir in year_dirs:
        pdfs = sorted(year_dir.glob("*.pdf"))
        if not pdfs:
            continue
        out_dir = TEXT_DIR / year_dir.name
        out_dir.mkdir(parents=True, exist_ok=True)
        for pdf in pdfs:
            txt = out_dir / (pdf.stem + ".txt")
            if txt.exists():
                skipped += 1
                continue
            try:
                subprocess.run(
                    ["pdftotext", "-layout", str(pdf), str(txt)],
                    check=True,
                    capture_output=True,
                )
                total += 1
                print(f"  extracted  {year_dir.name}/{pdf.name}")
            except subprocess.CalledProcessError as exc:
                errors += 1
                print(
                    f"  ERROR [{pdf.name}]: {exc.stderr.decode().strip()}",
                    file=sys.stderr,
                )
            except FileNotFoundError:
                print("ERROR: pdftotext not found — install poppler-utils (brew install poppler)",
                      file=sys.stderr)
                sys.exit(1)

    print(f"\n{total} extracted, {skipped} already existed, {errors} errors")


if __name__ == "__main__":
    if "--extract" in sys.argv:
        extract()
    else:
        main(verbose="--verbose" in sys.argv, download="--download" in sys.argv)
