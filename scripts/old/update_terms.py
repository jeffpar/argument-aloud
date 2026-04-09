#!/usr/bin/env python3
"""Generate courts/ussc/terms.json from the file system.

Scrapes the two SCOTUS journal pages to build a year → URL map, then
walks courts/ussc/terms/ to produce a sorted list of term objects.

Each term object contains:
  term          – folder name, e.g. "1955-10"
  title         – human-readable label, e.g. "October Term 1955"
  journal_cover – "journal-cover.jpg" (only when that file exists in the folder)
  journal_href  – URL to the journal PDF (only when one is listed on the SCOTUS site)

Usage:
    python3 scripts/update_terms.py
"""

import json
import re
import sys
import urllib.request
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TERMS_DIR = REPO_ROOT / 'courts' / 'ussc' / 'terms'
OUTPUT    = REPO_ROOT / 'courts' / 'ussc' / 'terms.json'

JOURNAL_PAGE   = 'https://www.supremecourt.gov/orders/journal.aspx'
SCANNED_PAGE   = 'https://www.supremecourt.gov/orders/scannedjournals.aspx'
SCOTUS_ROOT    = 'https://www.supremecourt.gov'

MONTH_NAMES = {
    '01': 'January',
    '02': 'February',
    '06': 'June',
    '07': 'July',
    '08': 'August',
    '10': 'October',
    '12': 'December',
}


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read().decode('utf-8', errors='replace')


def fetch_journal_urls() -> dict:
    """Return {year_str: url} for every SCOTUS journal PDF listed on the site."""
    urls = {}

    # 1993-present: journal.aspx lists links labelled "October YYYY"
    try:
        html = fetch(JOURNAL_PAGE)
        for m in re.finditer(
            r'href=["\']([^"\']+\.pdf)["\'][^>]*>\s*October\s+(\d{4})',
            html,
            re.IGNORECASE,
        ):
            url, year = m.group(1), m.group(2)
            url = urllib.parse.urljoin(JOURNAL_PAGE, url)
            urls[year] = url
        print(f'  journal.aspx: {len(urls)} URLs')
    except Exception as exc:
        print(f'Warning: could not fetch {JOURNAL_PAGE} — {exc}', file=sys.stderr)

    # 1889-1992: scannedjournals.aspx lists links with path …/YYYY_journal.pdf
    try:
        html = fetch(SCANNED_PAGE)
        before = len(urls)
        for m in re.finditer(
            r'href=["\']([^"\']*scannedjournals/(\d{4})_journal\.pdf)["\']',
            html,
            re.IGNORECASE,
        ):
            url, year = m.group(1), m.group(2)
            url = urllib.parse.urljoin(SCANNED_PAGE, url)
            urls[year] = url
        print(f'  scannedjournals.aspx: {len(urls) - before} URLs')
    except Exception as exc:
        print(f'Warning: could not fetch {SCANNED_PAGE} — {exc}', file=sys.stderr)

    return urls


def build_title(year_str: str, month_str: str, october_years: set) -> str:
    """Return the human-readable title for a term."""
    month_name = MONTH_NAMES.get(month_str, f'Month-{month_str}')
    if month_str == '10':
        return f'October Term {year_str}'
    # Any non-October term in a year that also has an October term is a special term.
    if year_str in october_years:
        return f'Special Term, {month_name} {year_str}'
    return f'{month_name} Term {year_str}'


def main() -> None:
    if not TERMS_DIR.is_dir():
        sys.exit(f'Terms directory not found: {TERMS_DIR}')

    term_folders = sorted(d.name for d in TERMS_DIR.iterdir() if d.is_dir())
    if not term_folders:
        sys.exit('No term folders found.')

    october_years = {f.split('-')[0] for f in term_folders if f.endswith('-10')}

    print('Fetching journal URLs…')
    journal_urls = fetch_journal_urls()
    print(f'  Total: {len(journal_urls)} journal URLs found.')

    terms = []
    for folder in term_folders:
        parts = folder.split('-', 1)
        if len(parts) != 2:
            continue
        year_str, month_str = parts

        entry = {
            'term':  folder,
            'title': build_title(year_str, month_str, october_years),
        }

        term_path = TERMS_DIR / folder
        if (term_path / 'journal-cover.jpg').exists():
            entry['journal_cover'] = 'journal-cover.jpg'

        if year_str in journal_urls:
            entry['journal_href'] = journal_urls[year_str]

        terms.append(entry)

    OUTPUT.write_text(json.dumps(terms, indent=2) + '\n')
    print(f'Wrote {len(terms)} terms → {OUTPUT.relative_to(REPO_ROOT)}')


if __name__ == '__main__':
    main()
