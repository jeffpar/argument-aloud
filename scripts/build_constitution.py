#!/usr/bin/env python3
"""
Build a single-file HTML copy of the U.S. Constitution with stable fragment ids.

Source material:
- National Archives Constitution transcript
- National Archives Bill of Rights transcript
- National Archives Amendments 11-27 page

Output ids are deterministic and nested by document structure:

    #preamble
    #preamble-clause-1
    #article-1
    #article-1-section-8
    #article-1-section-8-clause-3
    #article-5-clause-1
    #amendment-14
    #amendment-14-section-1
    #amendment-14-section-1-clause-1

Usage:
    python3 scripts/build_constitution.py [output_path] [--no-cache]
"""

from __future__ import annotations

import html
import json
import re
import sys
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path


CONSTITUTION_URL = "https://www.archives.gov/founding-docs/constitution-transcript"
BOR_URL = "https://www.archives.gov/founding-docs/bill-of-rights-transcript"
AMENDMENTS_URL = "https://www.archives.gov/founding-docs/amendments-11-27"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE_PATH = ROOT / "sources" / ".constitution-cache.json"
DEFAULT_OUTPUT = ROOT / "nara" / "constitution" / "index.md"
DELAY_SECONDS = 0.2

ROMAN_MAP = {
    "I": 1,
    "II": 2,
    "III": 3,
    "IV": 4,
    "V": 5,
    "VI": 6,
    "VII": 7,
    "VIII": 8,
    "IX": 9,
    "X": 10,
    "XI": 11,
    "XII": 12,
    "XIII": 13,
    "XIV": 14,
    "XV": 15,
    "XVI": 16,
    "XVII": 17,
    "XVIII": 18,
    "XIX": 19,
    "XX": 20,
    "XXI": 21,
    "XXII": 22,
    "XXIII": 23,
    "XXIV": 24,
    "XXV": 25,
    "XXVI": 26,
    "XXVII": 27,
}

INT_TO_ROMAN = {value: key for key, value in ROMAN_MAP.items()}


class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag: str, attrs=()):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children: list[Node] = []
        self.parent: Node | None = None

    def text(self) -> str:
        if self.tag == "#text":
            return self.attrs.get("value", "")
        return "".join(child.text() for child in self.children)

    def stext(self) -> str:
        return normalize_text(self.text())

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()

    def find(self, tag: str | None = None, **attrs) -> Node | None:
        for node in self.walk():
            if node is self:
                continue
            if tag is not None and node.tag != tag:
                continue
            if any(node.attrs.get(key) != value for key, value in attrs.items()):
                continue
            return node
        return None


VOID_TAGS = {
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
}


class DomParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#document")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag.lower(), attrs)
        node.parent = self.stack[-1]
        self.stack[-1].children.append(node)
        if node.tag not in VOID_TAGS:
            self.stack.append(node)

    def handle_endtag(self, tag):
        tag = tag.lower()
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack = self.stack[:index]
                return

    def handle_data(self, data):
        if not data:
            return
        node = Node("#text")
        node.attrs["value"] = data
        node.parent = self.stack[-1]
        self.stack[-1].children.append(node)


def normalize_text(text: str) -> str:
    text = text.replace("\u00a0", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def parse_dom(markup: str) -> Node:
    parser = DomParser()
    parser.feed(markup)
    return parser.root


def main_content(dom: Node) -> Node:
    return dom.find("main") or dom.find("div", id="main-col") or dom


def iter_blocks(dom: Node):
    for node in main_content(dom).walk():
        if node.tag in {"h1", "h2", "h3", "p"}:
            text = node.stext()
            if text:
                yield node.tag, text


def roman_to_int(value: str) -> int:
    return ROMAN_MAP[value.upper()]


def int_to_roman(value: int) -> str:
    return INT_TO_ROMAN[value]


def skip_text(text: str) -> bool:
    prefixes = (
        "Note:",
        "Passed by Congress",
        "Ratified ",
        "Originally proposed",
        "Back to ",
        "The following text is a transcription",
        "Constitutional Amendments 1-10",
        "Amendments 11-27",
    )
    return text.startswith(prefixes)


def append_clause(target: dict, text: str) -> None:
    target.setdefault("clauses", []).append(text)


def extract_constitution() -> tuple[list[str], list[dict]]:
    dom = parse_dom(fetch(CONSTITUTION_URL))
    preamble: list[str] = []
    articles: list[dict] = []
    current_article: dict | None = None
    current_section: dict | None = None
    in_text = False

    for tag, text in iter_blocks(dom):
        if text == "The Constitution of the United States: A Transcription":
            continue
        if not in_text:
            if text.startswith("We the People"):
                preamble.append(text)
                in_text = True
            continue

        if tag == "h2":
            match = re.fullmatch(r"Article\.\s+([IVX]+)\.", text, re.IGNORECASE)
            if not match:
                if current_article and current_article["number"] == 7:
                    break
                continue
            current_article = {
                "number": roman_to_int(match.group(1)),
                "sections": [],
                "clauses": [],
            }
            articles.append(current_article)
            current_section = None
            continue

        if current_article is None:
            continue

        if tag == "h3":
            match = re.fullmatch(r"Section\.\s+(\d+)\.", text, re.IGNORECASE)
            if match:
                current_section = {
                    "number": int(match.group(1)),
                    "clauses": [],
                }
                current_article["sections"].append(current_section)
                continue
            if current_article["number"] == 7:
                break
            continue

        if tag == "p" and not skip_text(text):
            if current_section is not None:
                append_clause(current_section, text)
            else:
                append_clause(current_article, text)

    return preamble, articles


def extract_bill_of_rights() -> list[dict]:
    dom = parse_dom(fetch(BOR_URL))
    amendments: list[dict] = []
    current_amendment: dict | None = None
    started = False

    for tag, text in iter_blocks(dom):
        if tag == "h2" and text == "The U.S. Bill of Rights":
            started = True
            current_amendment = None
            continue
        if not started:
            continue

        if tag == "h3":
            match = re.fullmatch(r"Amendment\s+([IVX]+)", text, re.IGNORECASE)
            if match:
                current_amendment = {
                    "number": roman_to_int(match.group(1)),
                    "sections": [],
                    "clauses": [],
                }
                amendments.append(current_amendment)
                continue

        if current_amendment and tag == "p" and not skip_text(text):
            append_clause(current_amendment, text)

    return amendments


def extract_later_amendments() -> list[dict]:
    dom = parse_dom(fetch(AMENDMENTS_URL))
    amendments: list[dict] = []
    current_amendment: dict | None = None
    current_section: dict | None = None

    for tag, text in iter_blocks(dom):
        if tag in {"h2", "h3"}:
            match = re.fullmatch(r"AMENDMENT\s+([IVX]+)", text, re.IGNORECASE)
            if match:
                current_amendment = {
                    "number": roman_to_int(match.group(1)),
                    "sections": [],
                    "clauses": [],
                }
                amendments.append(current_amendment)
                current_section = None
                continue

        if current_amendment is None:
            continue

        if tag == "h3":
            match = re.fullmatch(r"Section\s+(\d+)\.", text, re.IGNORECASE)
            if match:
                current_section = {
                    "number": int(match.group(1)),
                    "clauses": [],
                }
                current_amendment["sections"].append(current_section)
                continue

        if tag == "p":
            if skip_text(text) or text.startswith("*"):
                continue
            if current_section is not None:
                append_clause(current_section, text)
            else:
                append_clause(current_amendment, text)

    return amendments


def fetch(url: str) -> str:
    cache = load_cache()
    if url in cache:
        return cache[url]

    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        markup = response.read().decode(charset, errors="replace")
    cache[url] = markup
    save_cache(cache)
    time.sleep(DELAY_SECONDS)
    return markup


def load_cache() -> dict[str, str]:
    if not CACHE_PATH.exists():
        return {}
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_cache(cache: dict[str, str]) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache), encoding="utf-8")


def render_clause(clause_id: str, text: str) -> str:
    return f'<p id="{clause_id}" class="clause">{html.escape(text)}</p>'


def render_preamble(preamble: list[str]) -> list[str]:
    parts = ['<section id="preamble" class="preamble">', '<h2>Preamble</h2>']
    for index, text in enumerate(preamble, start=1):
        parts.append(render_clause(f"preamble-clause-{index}", text))
    parts.append("</section>")
    return parts


def render_articles(articles: list[dict]) -> list[str]:
    parts: list[str] = []
    for article in articles:
        article_id = f'article-{article["number"]}'
        parts.append(f'<section id="{article_id}" class="article">')
        parts.append(f'<h2>Article {int_to_roman(article["number"])}</h2>')
        if article["sections"]:
            for section in article["sections"]:
                section_id = f'{article_id}-section-{section["number"]}'
                parts.append(f'<section id="{section_id}" class="section">')
                parts.append(f'<h3>Section {section["number"]}</h3>')
                for index, text in enumerate(section["clauses"], start=1):
                    parts.append(render_clause(f"{section_id}-clause-{index}", text))
                parts.append("</section>")
        else:
            for index, text in enumerate(article["clauses"], start=1):
                parts.append(render_clause(f"{article_id}-clause-{index}", text))
        parts.append("</section>")
    return parts


def render_amendments(amendments: list[dict]) -> list[str]:
    parts = ['<section id="amendments">', '<h2>Amendments</h2>']
    for amendment in amendments:
        amendment_id = f'amendment-{amendment["number"]}'
        parts.append(f'<section id="{amendment_id}" class="amendment">')
        parts.append(f'<h2>Amendment {int_to_roman(amendment["number"])}</h2>')
        if amendment["sections"]:
            for section in amendment["sections"]:
                section_id = f'{amendment_id}-section-{section["number"]}'
                parts.append(f'<section id="{section_id}" class="section">')
                parts.append(f'<h3>Section {section["number"]}</h3>')
                for index, text in enumerate(section["clauses"], start=1):
                    parts.append(render_clause(f"{section_id}-clause-{index}", text))
                parts.append("</section>")
        else:
            for index, text in enumerate(amendment["clauses"], start=1):
                parts.append(render_clause(f"{amendment_id}-clause-{index}", text))
        parts.append("</section>")
    parts.append("</section>")
    return parts


def render_toc(articles: list[dict], amendments: list[dict]) -> list[str]:
    parts = ['<nav class="toc" aria-label="Table of contents">', '<strong>Contents</strong>', '<ul>']
    parts.append('<li><a href="#preamble">Preamble</a></li>')
    for article in articles:
        parts.append(
            f'<li><a href="#article-{article["number"]}">Article {int_to_roman(article["number"])}</a></li>'
        )
    parts.append('<li><a href="#amendments">Amendments</a></li>')
    for amendment in amendments:
        parts.append(
            f'<li><a href="#amendment-{amendment["number"]}">Amendment {int_to_roman(amendment["number"])}</a></li>'
        )
    parts.append("</ul></nav>")
    return parts


TOC_SCROLL_JS = """
<script>
(function () {
  var content = document.querySelector('.doc-content');
  document.querySelector('.toc').addEventListener('click', function (e) {
    var a = e.target.closest('a[href^="#"]');
    if (!a) return;
    var target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target || !content.contains(target)) return;
    e.preventDefault();
    content.scrollTo({ top: target.offsetTop - 16, behavior: 'smooth' });
  });
})();
</script>
""".strip()


def render_document(preamble: list[str], articles: list[dict], amendments: list[dict]) -> str:
    parts = [
        "---",
        "layout: document",
        "---",
        "",
        '<div class="doc-page">',
        '<div class="doc-banner">',
        "<h1>United States Constitution</h1>",
        '<p class="lede">Single-file HTML transcription with stable ids for the preamble, articles, sections, clauses, and amendments.</p>',
        '<p class="source-note">Source text is derived from the <a href="https://www.archives.gov/founding-docs/constitution-transcript" target="_blank">U.S. National Archives transcription pages</a> for the Constitution, the Bill of Rights, and Amendments 11-27.</p>',
        "</div>",
        '<div class="doc-body">',
        *render_toc(articles, amendments),
        '<div class="doc-content">',
        *render_preamble(preamble),
        *render_articles(articles),
        *render_amendments(amendments),
        "</div>",
        "</div>",
        "</div>",
        TOC_SCROLL_JS,
    ]
    return "\n".join(parts)


def build(output_path: Path) -> None:
    preamble, articles = extract_constitution()
    amendments = extract_bill_of_rights() + extract_later_amendments()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        render_document(preamble, articles, amendments),
        encoding="utf-8",
    )


def main() -> int:
    args = [arg for arg in sys.argv[1:] if not arg.startswith("-")]
    if "--no-cache" in sys.argv and CACHE_PATH.exists():
        CACHE_PATH.unlink()
    output_path = Path(args[0]) if args else DEFAULT_OUTPUT
    build(output_path)
    print(f"Wrote {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
