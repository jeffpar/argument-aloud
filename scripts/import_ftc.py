#!/usr/bin/env python3
"""
import_ftc.py - Import Fix the Court OT24 opinion audio into cases.json

Reads the FTC page listing OT24 SCOTUS opinion announcement audio and,
for each case with audio, adds an "nara" opinion audio entry to cases.json
if one does not already exist.
"""

import json
import re
import sys
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
import urllib.request

FTC_URL = (
    "https://fixthecourt.com/2026/02/"
    "the-up-until-now-missing-audio-of-scotus-opinion-announcements-from-ot24/"
)
CASES_FILE = (
    Path(__file__).parent.parent / "courts" / "ussc" / "terms" / "2024-10" / "cases.json"
)

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


# ---------------------------------------------------------------------------
# HTML → text converter (stdlib only, no third-party deps)
# ---------------------------------------------------------------------------

class _TextExtractor(HTMLParser):
    """Convert HTML to plain text, rendering <a href="…"> as [text](href)."""

    SKIP_TAGS = frozenset({"script", "style", "noscript"})
    BLOCK_TAGS = frozenset({"p", "li", "br", "tr", "h1", "h2", "h3", "h4", "div"})

    def __init__(self):
        super().__init__()
        self._buf = []           # output buffer
        self._skip_depth = 0     # depth inside SKIP_TAGS
        self._link_href = None   # href of current <a>
        self._link_buf = []      # text collected inside <a>

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth:
            return
        if tag == "a":
            href = dict(attrs).get("href", "")
            self._link_href = href
            self._link_buf = []
        elif tag in self.BLOCK_TAGS:
            self._buf.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth:
            return
        if tag == "a" and self._link_href is not None:
            link_text = "".join(self._link_buf)
            href = self._link_href
            # Keep links that point to mp3s or contain "starts at"
            if href.lower().endswith(".mp3") or "starts at" in link_text.lower():
                self._buf.append(f"[{link_text}]({href})")
            else:
                self._buf.append(link_text)
            self._link_href = None
            self._link_buf = []

    def handle_data(self, data):
        if self._skip_depth:
            return
        if self._link_href is not None:
            self._link_buf.append(data)
        else:
            self._buf.append(data)

    def get_text(self):
        return "".join(self._buf)


def _fetch_text(url):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (compatible; import_ftc/1.0)"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    parser = _TextExtractor()
    parser.feed(html)
    return parser.get_text()


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

# Matches numbered entries: "N." immediately followed by the case number.
# Space after the period is optional (some entries have none, e.g. "65.24-316").
ENTRY_RE = re.compile(r"^\s*(\d+)\.\s*", re.MULTILINE)

# [starts at M:SS](url) – optional whitespace inside brackets
LINK_RE = re.compile(
    r"\[starts at\s+([\d:]+)\s*\]\((https://[^)]+\.mp3)\)",
    re.IGNORECASE,
)

# Parenthetical dates like (11/22/24) or (1/15/25)
DATE_RE = re.compile(r"\((\d{1,2}/\d{1,2}/\d{2,4})\)")


def _parse_offset(time_str):
    """Convert 'M:SS', 'MM:SS', or 'H:MM:SS' to 'HH:MM:SS.00'."""
    parts = time_str.strip().split(":")
    if len(parts) == 2:
        h, m, s = 0, int(parts[0]), int(parts[1])
    elif len(parts) == 3:
        h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
    else:
        raise ValueError(f"Unexpected time format: {time_str!r}")
    return f"{h:02d}:{m:02d}:{s:02d}.00"


def _parse_date(text):
    """Return YYYY-MM-DD from the *last* parenthetical date in text.

    Taking the last date handles an anomaly on the FTC page where one entry
    has two parenthetical dates (e.g. "(6/27/25)(6/18/25)").
    """
    dates = DATE_RE.findall(text)
    if not dates:
        raise ValueError(f"No date found in: {text[:80]!r}")
    month_s, day_s, year_s = dates[-1].split("/")
    month, day, year = int(month_s), int(day_s), int(year_s)
    if year < 100:
        year += 2000
    return f"{year:04d}-{month:02d}-{day:02d}"


def _date_to_title(date_str):
    """'YYYY-MM-DD' → 'Opinion Announcement on Month Day, Year'."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return f"Opinion Announcement on {MONTH_NAMES[dt.month - 1]} {dt.day}, {dt.year}"


# ---------------------------------------------------------------------------
# Entry collection: group page text into per-case blocks
# ---------------------------------------------------------------------------

def _collect_entries(text):
    """Return list of dicts {'num': int, 'text': str} for entries 1–67."""
    lines = text.splitlines()
    entries = []
    current = None

    for line in lines:
        m = ENTRY_RE.match(line)
        if m:
            num = int(m.group(1))
            if 1 <= num <= 67:
                if current:
                    entries.append(current)
                current = {"num": num, "text": line}
            else:
                # Outside the 1-67 range; flush current and stop collecting
                if current:
                    entries.append(current)
                current = None
        elif current is not None and line.strip():
            current["text"] += " " + line.strip()

    if current is not None:
        entries.append(current)

    return entries


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    with open(CASES_FILE, "r") as fh:
        cases = json.load(fh)

    # Build case-number → list-index lookup
    case_lookup = {c["number"]: i for i, c in enumerate(cases)}

    print(f"Fetching {FTC_URL} …")
    page_text = _fetch_text(FTC_URL)

    entries = _collect_entries(page_text)
    print(f"Collected {len(entries)} entries (expected 67)\n")

    modified = False

    for entry in entries:
        num = entry["num"]
        text = entry["text"]

        # Strip the leading "N." to get the rest of the entry
        after_num = ENTRY_RE.sub("", text, count=1).strip()

        # Case number is the first token before the first comma
        cn_match = re.match(r"^(\S+),", after_num)
        if not cn_match:
            print(f"WARNING [{num}]: could not parse case number from: {after_num[:60]!r}")
            continue

        case_number = cn_match.group(1)

        # Skip entries explicitly marked as having no opinion announcement
        if "no opinion announcement" in text.lower():
            continue

        # Locate "starts at" audio links
        links = LINK_RE.findall(text)
        if not links:
            print(
                f"WARNING [{num}] {case_number}: "
                f"no 'starts at' link found – {after_num[:80]!r}"
            )
            continue

        # Use the first link (main opinion, not a dissent summary)
        time_str, audio_href = links[0]

        try:
            date_str = _parse_date(text)
        except ValueError as exc:
            print(f"WARNING [{num}] {case_number}: {exc}")
            continue

        try:
            offset = _parse_offset(time_str)
        except ValueError as exc:
            print(f"WARNING [{num}] {case_number}: {exc}")
            continue

        # Locate case in cases.json
        if case_number not in case_lookup:
            print(f"WARNING [{num}]: case {case_number!r} not found in cases.json")
            continue

        case = cases[case_lookup[case_number]]

        # Skip if an opinion audio entry already exists (any source)
        if any(a.get("type") == "opinion" for a in case.get("audio", [])):
            print(f"INFO    [{num}] {case_number}: already has opinion audio – skipping")
            continue

        # Append new audio entry
        new_audio = {
            "source": "nara",
            "type": "opinion",
            "date": date_str,
            "audio_href": audio_href,
            "title": _date_to_title(date_str),
            "offset": offset,
        }
        case.setdefault("audio", []).append(new_audio)

        print(f"ADDED   [{num}] {case_number}: {date_str}, offset={offset}")
        modified = True

    if modified:
        with open(CASES_FILE, "w") as fh:
            json.dump(cases, fh, indent=2)
            fh.write("\n")
        print("\ncases.json written.")
    else:
        print("\nNo changes made.")


if __name__ == "__main__":
    main()
