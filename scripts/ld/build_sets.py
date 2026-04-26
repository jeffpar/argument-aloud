#!/usr/bin/env python3
"""Build transcripts.json from Lone Dissent transcript listings.

Usage:
    python3 scripts/build_sets.py

Output:
    courts/ussc/sets/transcripts.json
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from difflib import SequenceMatcher
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parents[2]
TERMS_DIR = ROOT / "courts" / "ussc" / "terms"
OUT_PATH = ROOT / "courts" / "ussc" / "sets" / "transcripts.json"
SOURCE_URLS = [
    "https://lonedissent.org/transcripts/pre-1955",
    "https://lonedissent.org/transcripts/pre-1968",
]
SET_NAME = "Transcripts (1924-1967)"

MONTH_TO_NUM = {
    "october": "10",
    "july": "07",
}

TERM_RE = re.compile(r"^(October|July)\s+(Special\s+)?Term\s+(\d{4})$", re.IGNORECASE)
SCDB_ID_RE = re.compile(r"#(\d{4}-\d{3})$")
PDF_HREF_RE = re.compile(r'href=["\']([^"\']+\.pdf)["\']', re.IGNORECASE)


@dataclass(frozen=True)
class SourceCase:
    term: str
    title: str
    scdb_id: str = ""
    transcript_href: str = ""


class LDTranscriptParser(HTMLParser):
    """Parse term headings and case list entries from a Lone Dissent transcript listing page."""

    def __init__(self, base_url: str = "") -> None:
        super().__init__()
        self.base_url = base_url
        self.current_term = ""
        self.in_h2 = False
        self.h2_parts: list[str] = []

        self.in_li = False
        self.li_links: list[tuple[str, str]] = []
        self.in_a = False
        self.a_href = ""
        self.a_parts: list[str] = []

        self.items: list[SourceCase] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)

        if tag == "h2":
            self.in_h2 = True
            self.h2_parts = []
            return

        if tag == "li":
            self.in_li = True
            self.li_links = []
            return

        if self.in_li and tag == "a":
            self.in_a = True
            self.a_parts = []
            self.a_href = attrs_dict.get("href") or ""

    def handle_endtag(self, tag: str) -> None:
        if tag == "h2" and self.in_h2:
            self.in_h2 = False
            heading = " ".join("".join(self.h2_parts).split())
            parsed_term = parse_term_heading(heading)
            if parsed_term:
                self.current_term = parsed_term
            return

        if tag == "a" and self.in_a:
            self.in_a = False
            text = clean_link_text("".join(self.a_parts))
            self.li_links.append((text, self.a_href))
            self.a_href = ""
            self.a_parts = []
            return

        if tag == "li" and self.in_li:
            self.in_li = False
            if not self.current_term:
                return
            item = pick_case_from_links(self.current_term, self.li_links, self.base_url)
            if item:
                self.items.append(item)

    def handle_data(self, data: str) -> None:
        if self.in_h2:
            self.h2_parts.append(data)
        if self.in_a:
            self.a_parts.append(data)


def parse_term_heading(text: str) -> str:
    m = TERM_RE.match(text.strip())
    if not m:
        return ""
    month_name = m.group(1).lower()
    year = m.group(3)
    month = MONTH_TO_NUM.get(month_name)
    if not month:
        return ""
    return f"{year}-{month}"


def clean_link_text(text: str) -> str:
    s = unescape(text).replace("\xa0", " ").strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*\[PDF\]\s*$", "", s, flags=re.IGNORECASE)
    return s.strip()


def pick_case_from_links(term: str, links: list[tuple[str, str]], base_url: str = "") -> SourceCase | None:
    title = ""
    scdb_id = ""
    title_href = ""
    pdf_href = ""

    for text, href in links:
        href = (href or "").strip()

        if href.lower().endswith(".pdf") and not pdf_href:
            pdf_href = href

        if not text or text.upper() == "PDF":
            continue
        if not title and text.upper() != "LONE DISSENT":
            title = text
            title_href = href
        m = SCDB_ID_RE.search(href or "")
        if m:
            scdb_id = m.group(1)

    if not title:
        return None

    preferred_href = pdf_href or title_href
    transcript_href = urljoin(base_url, preferred_href) if preferred_href else ""

    return SourceCase(term=term, title=title, scdb_id=scdb_id, transcript_href=transcript_href)


def normalize_title(s: str) -> str:
    s = unescape(s or "").lower().strip()
    s = s.replace("&", " and ")
    s = re.sub(r"\(i+\)", "", s)
    s = re.sub(r"\bco\.\b", "co", s)
    s = re.sub(r"\bu\.s\.\b", "us", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def fetch_source_cases_from(url: str) -> list[SourceCase]:
    with urllib.request.urlopen(url) as r:
        html = r.read().decode("utf-8", errors="replace")

    parser = LDTranscriptParser(url)
    parser.feed(html)

    deduped: list[SourceCase] = []
    seen: set[tuple[str, str]] = set()
    for item in parser.items:
        transcript_href = item.transcript_href
        if transcript_href and "#" in transcript_href:
            resolved_pdf = resolve_internal_pdf_href(html, transcript_href, url)
            if resolved_pdf:
                item = SourceCase(
                    term=item.term,
                    title=item.title,
                    scdb_id=item.scdb_id,
                    transcript_href=resolved_pdf,
                )
        key = (item.term, normalize_title(item.title))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)

    return deduped


def fetch_source_cases() -> list[SourceCase]:
    all_cases: list[SourceCase] = []
    seen: set[tuple[str, str]] = set()
    for url in SOURCE_URLS:
        for item in fetch_source_cases_from(url):
            key = (item.term, normalize_title(item.title))
            if key not in seen:
                seen.add(key)
                all_cases.append(item)
    return all_cases


def load_term_cases() -> tuple[dict[str, list[dict]], dict[str, Path]]:
    out: dict[str, list[dict]] = {}
    term_paths: dict[str, Path] = {}
    for cases_path in sorted(TERMS_DIR.glob("*/cases.json")):
        term = cases_path.parent.name
        try:
            cases = json.loads(cases_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        out[term] = cases
        term_paths[term] = cases_path
    return out, term_paths


def find_case(source: SourceCase, term_cases: dict[str, list[dict]]) -> dict | None:
    cases = term_cases.get(source.term, [])
    if not cases:
        return None

    # First try SCDB case id when present in source links.
    if source.scdb_id:
        for case in cases:
            if (case.get("id") or "").strip() == source.scdb_id:
                return case

    target = normalize_title(source.title)

    exact = [c for c in cases if normalize_title(c.get("title", "")) == target]
    if len(exact) == 1:
        return exact[0]

    if len(exact) > 1:
        return exact[0]

    # Fuzzy fallback for punctuation/abbreviation differences.
    scored: list[tuple[float, dict]] = []
    for c in cases:
        cand = normalize_title(c.get("title", ""))
        if not cand:
            continue
        ratio = SequenceMatcher(None, target, cand).ratio()
        scored.append((ratio, c))

    if not scored:
        return None

    scored.sort(key=lambda t: t[0], reverse=True)
    best_ratio, best_case = scored[0]
    second_ratio = scored[1][0] if len(scored) > 1 else 0.0

    if best_ratio >= 0.72 and (best_ratio - second_ratio >= 0.08 or best_ratio >= 0.9):
        return best_case

    return None


def build_output(cases: list[dict]) -> list[dict]:
    return [
        {
            "name": SET_NAME,
            "cases": cases,
        }
    ]


def resolve_internal_pdf_href(html: str, href: str, base_url: str = "") -> str:
    """If href points to a hash target on the source page, try to resolve it
    to a neighboring PDF link from that detailed block."""
    if "#" not in href:
        return ""

    frag = href.split("#", 1)[1].strip()
    if not frag:
        return ""

    # Try id="..." first.
    id_pat = re.compile(rf'id=["\']{re.escape(frag)}["\']', re.IGNORECASE)
    m = id_pat.search(html)

    # Some pages may use anchor links without explicit id attributes.
    if not m:
        anchor_pat = re.compile(rf'href=["\']#{re.escape(frag)}["\']', re.IGNORECASE)
        m = anchor_pat.search(html)

    if not m:
        return ""

    start = m.start()
    # Search a reasonably local neighborhood after the anchor for PDF links.
    neighborhood = html[start:start + 20000]
    pdf_m = PDF_HREF_RE.search(neighborhood)
    if not pdf_m:
        return ""

    return urljoin(base_url, pdf_m.group(1).strip())


def first_date(s: str) -> str:
    if not s:
        return ""
    return s.split(",")[0].strip()


def oral_argument_title(date_str: str) -> str:
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return f"Oral Argument on {dt.strftime('%B')} {dt.day}, {dt.year}"


def has_event_on_date(events: list, date_str: str) -> bool:
    for ev in events:
        if not isinstance(ev, dict):
            continue
        if date_str and (ev.get("date") or "").strip() == date_str:
            return True
    return False


def ensure_events_array(case: dict) -> list:
    """Ensure case has an events list.

    If creating events for the first time and opinion_href exists, insert
    events before opinion_href to preserve preferred key ordering.
    """
    events = case.get("events")
    if isinstance(events, list):
        return events

    if "events" in case and not isinstance(case.get("events"), list):
        # Normalize malformed events values.
        case["events"] = []
        return case["events"]

    if "events" not in case:
        if "opinion_href" in case:
            new_case: dict = {}
            inserted = False
            for k, v in case.items():
                if not inserted and k == "opinion_href":
                    new_case["events"] = []
                    inserted = True
                new_case[k] = v
            if not inserted:
                new_case["events"] = []
            case.clear()
            case.update(new_case)
            return case["events"]

        case["events"] = []

    return case["events"]


PDF_DATE_RE = re.compile(r'/(\d+)_(\d{4}-\d{2}-\d{2})_')


def extract_date_from_href(href: str) -> str:
    """Try to extract YYYY-MM-DD from a Lone Dissent PDF filename like /NNN_YYYY-MM-DD_Title.pdf."""
    m = PDF_DATE_RE.search(href)
    return m.group(2) if m else ""


def has_transcript_href(events: list, href: str) -> bool:
    for ev in events:
        if isinstance(ev, dict) and (ev.get("transcript_href") or "").strip() == href:
            return True
    return False


def maybe_add_ld_event(case: dict, src: SourceCase) -> bool:
    transcript_href = (src.transcript_href or "").strip()
    if not transcript_href:
        return False

    # Only inject direct PDF links; sub-page URLs are not usable as transcript sources.
    if not transcript_href.lower().endswith(".pdf"):
        return False

    # Prefer a date embedded in the PDF filename; fall back to first argument date.
    arg_date = extract_date_from_href(transcript_href) or first_date(case.get("argument", ""))
    if not arg_date:
        return False

    events = ensure_events_array(case)

    # Do not add if this exact transcript is already present in any event.
    if has_transcript_href(events, transcript_href):
        return False

    event = {
        "source": "ld",
        "type": "argument",
        "date": arg_date,
        "title": oral_argument_title(arg_date),
        "transcript_href": transcript_href,
    }
    events.append(event)
    return True


# ============================================================
# Brief Archive (https://lonedissent.org/briefs/featured/)
# ============================================================

BRIEFS_SOURCE_URL = "https://lonedissent.org/briefs/featured/"
BRIEF_SET_NAME = "Briefs (1857-1996)"
BRIEF_OUT_PATH = ROOT / "courts" / "ussc" / "sets" / "briefs.json"

TERM_FROM_URL_RE = re.compile(r"/cases/all/(\d{4}-\d{2})\b")
YEAR_IN_PARENS_RE = re.compile(r"\((\d{4})\)")
BRIEF_HOST_RE = re.compile(r"https?://briefs\d*\.lonedissent\.org/", re.IGNORECASE)


@dataclass(frozen=True)
class BriefSourceCase:
    name: str
    detail_url: str
    us_cite: str
    term_hint: str
    year: str


class LDBriefListParser(HTMLParser):
    """Parse the Lone Dissent featured briefs listing page."""

    def __init__(self, base_url: str = "") -> None:
        super().__init__()
        self.base_url = base_url
        self.items: list[BriefSourceCase] = []
        self.in_li = False
        self.li_links: list[tuple[str, str]] = []
        self.li_text_parts: list[str] = []
        self.in_a = False
        self.a_href = ""
        self.a_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)
        if tag == "li":
            self.in_li = True
            self.li_links = []
            self.li_text_parts = []
            return
        if self.in_li and tag == "a":
            self.in_a = True
            self.a_parts = []
            self.a_href = attrs_dict.get("href") or ""

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.in_a:
            self.in_a = False
            text = clean_link_text("".join(self.a_parts))
            self.li_links.append((text, self.a_href))
            self.a_href = ""
            self.a_parts = []
            return
        if tag == "li" and self.in_li:
            self.in_li = False
            item = self._build_item()
            if item:
                self.items.append(item)

    def handle_data(self, data: str) -> None:
        if self.in_a:
            self.a_parts.append(data)
        elif self.in_li:
            self.li_text_parts.append(data)

    def _build_item(self) -> "BriefSourceCase | None":
        if len(self.li_links) < 2:
            return None
        name_text, detail_href = self.li_links[0]
        us_cite_text, cite_href = self.li_links[1]
        if not name_text or not us_cite_text:
            return None
        # Require detail link to point at a brief page.
        detail_href_str = detail_href or ""
        if "/briefs/featured/" not in detail_href_str:
            return None
        term_hint = ""
        m = TERM_FROM_URL_RE.search(cite_href or "")
        if m:
            term_hint = m.group(1)
        full_text = "".join(self.li_text_parts)
        year = ""
        ym = YEAR_IN_PARENS_RE.search(full_text)
        if ym:
            year = ym.group(1)
        detail_url = urljoin(self.base_url, detail_href_str) if detail_href_str else ""
        return BriefSourceCase(
            name=name_text,
            detail_url=detail_url,
            us_cite=us_cite_text,
            term_hint=term_hint,
            year=year,
        )


class LDBriefDetailParser(HTMLParser):
    """Parse a Lone Dissent brief detail page to extract the file list."""

    def __init__(self) -> None:
        super().__init__()
        self.files: list[dict] = []
        self.in_li = False
        self.in_a = False
        self.a_href = ""
        self.a_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)
        if tag == "li":
            self.in_li = True
            return
        if self.in_li and tag == "a":
            self.in_a = True
            self.a_parts = []
            self.a_href = attrs_dict.get("href") or ""

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.in_a:
            self.in_a = False
            text = clean_link_text("".join(self.a_parts))
            href = (self.a_href or "").strip()
            if text and href and BRIEF_HOST_RE.match(href):
                self.files.append({"file": len(self.files) + 1, "title": text, "href": href, "type": "brief"})
            self.a_href = ""
            self.a_parts = []
            return
        if tag == "li" and self.in_li:
            self.in_li = False

    def handle_data(self, data: str) -> None:
        if self.in_a:
            self.a_parts.append(data)


def fetch_brief_files(url: str) -> list[dict]:
    """Fetch a brief detail page and return the list of file objects."""
    with urllib.request.urlopen(url) as r:
        html = r.read().decode("utf-8", errors="replace")
    parser = LDBriefDetailParser()
    parser.feed(html)
    return parser.files


def fetch_brief_source_cases() -> list[BriefSourceCase]:
    """Fetch and deduplicate the featured briefs listing page."""
    with urllib.request.urlopen(BRIEFS_SOURCE_URL) as r:
        html = r.read().decode("utf-8", errors="replace")
    parser = LDBriefListParser(BRIEFS_SOURCE_URL)
    parser.feed(html)
    seen: set[tuple[str, str]] = set()
    result: list[BriefSourceCase] = []
    for item in parser.items:
        key = (normalize_title(item.name), item.us_cite)
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result


def find_case_in_term_by_us_cite(
    us_cite: str,
    term: str,
    term_cases: dict[str, list[dict]],
) -> "dict | None":
    """Search a specific term's cases.json for a case with a matching usCite."""
    for case in term_cases.get(term, []):
        if (case.get("usCite") or "").strip() == us_cite:
            return case
    return None


def case_folder_name(case: dict) -> str:
    """Return the subfolder name to use for a case's files directory."""
    base = (case.get("number") or case.get("id") or "").strip()
    return base.split(",", 1)[0].strip()


def audio_index(case: dict) -> int | None:
    """Return the 1-based index of the first audio entry whose date matches
    the case's argument or reargument date, or None if no match is found."""
    dates = {d for d in (case.get("argument"), case.get("reargument")) if d}
    for i, ev in enumerate(case.get("audio") or [], start=1):
        if ev.get("date") in dates:
            return i
    return None


def build_brief_archive(
    term_cases: dict[str, list[dict]],
    term_paths: dict[str, Path],
    dry_run: bool = False,
) -> tuple[int, int, int, set[str], list[str]]:
    """Build brief_archive.json, create files.json files, and update cases.

    Existing entries in briefs.json are preserved unchanged.
    Existing files.json files are not overwritten.
    """
    source_cases = fetch_brief_source_cases()

    # Load existing set entries so we don't overwrite them.
    existing_titles: set[str] = set()
    existing_set_cases: list[dict] = []
    if BRIEF_OUT_PATH.exists():
        try:
            existing_data = json.loads(BRIEF_OUT_PATH.read_text(encoding="utf-8"))
            if isinstance(existing_data, list) and existing_data:
                existing_set_cases = existing_data[0].get("cases", [])
                existing_titles = {c.get("title", "") for c in existing_set_cases}
        except Exception:
            pass

    new_set_cases: list[dict] = []
    files_written = 0
    cases_matched = 0
    skipped_count = 0
    changed_terms: set[str] = set()
    unmatched_cases: list[str] = []

    for src in source_cases:
        title = f"{src.name} ({src.year})" if src.year else src.name

        # Look in the term identified by the Lone Dissent URL (the term that
        # encompasses the case's decision year).
        term = src.term_hint
        if not term:
            print(f"  [briefs] No term hint for {src.name} ({src.us_cite})")
            skipped_count += 1
            unmatched_cases.append(f"{src.name} ({src.us_cite}) [no term hint]")
            continue

        case = find_case_in_term_by_us_cite(src.us_cite, term, term_cases)
        if not case:
            print(f"  [briefs] No match for {src.name} ({src.us_cite}) in term {term}")
            skipped_count += 1
            unmatched_cases.append(f"{term}: {src.name} ({src.us_cite})")
            continue

        cases_matched += 1

        # Only add new entries; preserve existing ones exactly as-is.
        if title not in existing_titles:
            set_case: dict = {"title": title, "term": term}
            number_val = case.get("number") or case.get("id") or ""
            if number_val:
                set_case["number"] = number_val
            if "argument" in case:
                set_case["argument"] = case["argument"]
            if case.get("reargument"):
                set_case["reargument"] = case["reargument"]
            if "decision" in case:
                set_case["decision"] = case["decision"]
            if case.get("files"):
                set_case["files"] = case["files"]
            audio_idx = audio_index(case)
            if audio_idx is not None:
                set_case["audio"] = audio_idx
            new_set_cases.append(set_case)

        folder = case_folder_name(case)
        if folder and src.detail_url:
            cases_dir = TERMS_DIR / term / "cases" / folder
            files_path = cases_dir / "files.json"
            # Don't overwrite an existing files.json.
            if not files_path.exists():
                try:
                    files = fetch_brief_files(src.detail_url)
                except Exception as exc:
                    print(f"  [briefs] Failed to fetch {src.detail_url}: {exc}")
                    files = []
                if files:
                    if not dry_run:
                        cases_dir.mkdir(parents=True, exist_ok=True)
                        files_path.write_text(
                            json.dumps(files, indent=2, ensure_ascii=False) + "\n",
                            encoding="utf-8",
                        )
                    files_written += 1
                    case["files"] = len(files)
                    changed_terms.add(term)
            elif case.get("files") is None:
                # files.json already exists from a prior run; sync the count.
                try:
                    existing_files = json.loads(files_path.read_text(encoding="utf-8"))
                    case["files"] = len(existing_files)
                    changed_terms.add(term)
                except Exception:
                    pass

    # Merge existing entries with new ones and write.
    all_set_cases = existing_set_cases + new_set_cases
    output = [{"name": BRIEF_SET_NAME, "cases": all_set_cases}]
    if not dry_run:
        BRIEF_OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        BRIEF_OUT_PATH.write_text(
            json.dumps(output, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    return cases_matched, files_written, skipped_count, changed_terms, unmatched_cases


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build USSC transcript and brief set archives")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute and report changes without writing any files",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    dry_run = args.dry_run

    source_cases = fetch_source_cases()
    term_cases, term_paths = load_term_cases()

    matched: list[dict] = []
    skipped: list[SourceCase] = []
    events_added = 0
    events_skipped_no_arg = 0
    changed_terms: set[str] = set()

    for src in source_cases:
        case = find_case(src, term_cases)
        if not case:
            skipped.append(src)
            continue

        entry: dict = {
            "title": case.get("title", ""),
            "term": src.term,
            "number": case.get("number") or case.get("id") or "",
            "argument": case.get("argument", ""),
        }
        if case.get("reargument"):
            entry["reargument"] = case["reargument"]
        entry["decision"] = case.get("decision", "")
        if case.get("files"):
            entry["files"] = case["files"]
        audio_idx = audio_index(case)
        if audio_idx is not None:
            entry["audio"] = audio_idx
        matched.append(entry)

        if maybe_add_ld_event(case, src):
            events_added += 1
            changed_terms.add(src.term)
        elif src.transcript_href and not first_date(case.get("argument", "")):
            events_skipped_no_arg += 1

    # Keep chronological order by term then argument/decision/title.
    matched.sort(
        key=lambda c: (
            c.get("term", ""),
            c.get("argument", ""),
            c.get("decision", ""),
            c.get("title", ""),
        )
    )

    if not dry_run:
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(json.dumps(build_output(matched), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # Build brief archive.
    brief_matched, brief_files, brief_skipped, brief_changed, brief_unmatched = build_brief_archive(
        term_cases,
        term_paths,
        dry_run=dry_run,
    )
    changed_terms |= brief_changed

    if not dry_run:
        for term in sorted(changed_terms):
            path = term_paths.get(term)
            if not path:
                continue
            path.write_text(json.dumps(term_cases[term], indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Fetched {len(source_cases)} case listing(s) from {len(SOURCE_URLS)} source page(s)")
    print(f"Matched {len(matched)} case(s)")
    if dry_run:
        print(f"[dry-run] Would write {OUT_PATH.relative_to(ROOT)}")
        print(f"[dry-run] Would add {events_added} ld transcript event(s) across {len(changed_terms)} term file(s)")
    else:
        print(f"Wrote {OUT_PATH.relative_to(ROOT)}")
        print(f"Added {events_added} ld transcript event(s) across {len(changed_terms)} term file(s)")
    if events_skipped_no_arg:
        print(f"Skipped {events_skipped_no_arg} event(s) with no local argument date")

    if dry_run:
        print(f"\nBrief archive: matched {brief_matched} case(s), would write {brief_files} files.json file(s)")
        print(f"[dry-run] Would write {BRIEF_OUT_PATH.relative_to(ROOT)}")
    else:
        print(f"\nBrief archive: matched {brief_matched} case(s), wrote {brief_files} files.json file(s)")
        print(f"Wrote {BRIEF_OUT_PATH.relative_to(ROOT)}")
    if brief_skipped:
        print(f"Skipped {brief_skipped} brief source case(s) with no local match")
    if brief_unmatched:
        print("Unmatched brief source case(s):")
        for detail in brief_unmatched:
            print("  " + detail)

    if skipped:
        print(f"\nSkipped {len(skipped)} transcript source case(s):")
        for src in skipped:
            detail = f"{src.term}: {src.title}"
            if src.scdb_id:
                detail += f" (id={src.scdb_id})"
            print("  " + detail)


if __name__ == "__main__":
    main()
