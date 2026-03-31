#!/usr/bin/env python3
"""Extract spoken text from a SCOTUS oral argument PDF into JSON.

Usage:
    python3 extract_transcript.py input.pdf [output.json]

If output.json is omitted, it is written alongside the PDF with the same
base name but a .json extension.

Output format:
    [
      { "name": "CHIEF JUSTICE ROBERTS", "text": "We will hear argument..." },
      { "name": "MR. STEWART", "text": "Mr. Chief Justice, and may it..." },
      ...
    ]
"""

import re
import json
import subprocess
import sys
from pathlib import Path


# ── Skip patterns ─────────────────────────────────────────────────────────────
# These match numbered content lines that are section labels, not spoken text.

SKIP_PATTERNS = [
    re.compile(r'^ORAL (?:ARGUMENT|REBUTTAL) OF\b'),   # "ORAL ARGUMENT OF PAUL D. CLEMENT"
    re.compile(r'^ON BEHALF OF\b'),                     # "ON BEHALF OF THE RESPONDENTS"
    re.compile(r'^FOR THE UNITED\b'),                   # "FOR THE UNITED STATES..."
    re.compile(r'^REBUTTAL ARGUMENT OF\b'),
    re.compile(r'^P R O C E E D I N G S$'),
    re.compile(r'^C O N T E N T S$'),
    re.compile(r'^APPEARANCES:?$'),
    re.compile(r'^\(.*\)$'),                            # stage directions: (10:04 a.m.)
    re.compile(r'^[\s\-]+$'),                           # blank or dashed separator lines
]

# When any of these patterns appears in a content line, stop processing entirely.
# (Handles end-of-argument stage directions and the word index appended by the
# court reporter, both of which follow the final "The case is submitted." line.)
TERMINATOR_PATTERNS = [
    re.compile(r'^\(Whereupon\b'),                      # closing stage direction
    re.compile(r'\[\d+\]\s+\d+:\d+'),                   # word-index entries: "word [3] 12:4 45:9"
]

# ── Line-parsing patterns ─────────────────────────────────────────────────────

# A transcript content line in pdftotext -layout output:
#   optional 0–3 leading spaces, 1–2 digit line number, 2+ spaces, content
CONTENT_LINE_RE = re.compile(r'^\s{0,3}(\d{1,2})\s{2,}(.+)')

# A speaker attribution at the start of a (cleaned) content string.
# Matches names like:
#   CHIEF JUSTICE ROBERTS  /  JUSTICE THOMAS  /  MR. STEWART  /  GENERAL SAUER
SPEAKER_RE = re.compile(
    r'^((?:CHIEF JUSTICE|JUSTICE|MR\.|MS\.|MRS\.|GENERAL|GEN\.)'
    r'\s+[A-Z][A-Z\.]+(?:\s+[A-Z][A-Z\.]+)*):\s*(.*)',
    re.DOTALL,
)


# ── Main extraction ───────────────────────────────────────────────────────────

def extract_transcript(pdf_path: str, output_path: str) -> list[dict]:
    result = subprocess.run(
        ['pdftotext', '-layout', pdf_path, '-'],
        capture_output=True, text=True, check=True,
    )

    tokens: list[tuple] = []   # ('SPEAKER', name, first_text) | ('TEXT', text)

    for line in result.stdout.split('\n'):
        m = CONTENT_LINE_RE.match(line)
        if not m:
            continue

        content = m.group(2).strip()
        if not content:
            continue

        # Stop entirely when the closing stage direction or index section appears.
        if any(pat.search(content) for pat in TERMINATOR_PATTERNS):
            break

        if any(pat.match(content) for pat in SKIP_PATTERNS):
            continue

        sm = SPEAKER_RE.match(content)
        if sm:
            tokens.append(('SPEAKER', sm.group(1).strip(), sm.group(2).strip()))
        else:
            tokens.append(('TEXT', content))

    # Build speaker turns from token stream.
    # Text before the first speaker token is discarded (cover page, appearances, etc.)
    turns: list[dict] = []
    current_speaker: str | None = None
    current_parts: list[str] = []

    for token in tokens:
        if token[0] == 'SPEAKER':
            if current_speaker is not None:
                text = re.sub(r'\s+', ' ', ' '.join(current_parts)).strip()
                if text:
                    turns.append({'name': current_speaker, 'text': text})
            current_speaker = token[1]
            current_parts = [token[2]] if token[2] else []
        else:
            if current_speaker is not None:
                current_parts.append(token[1])

    # Flush the last speaker.
    if current_speaker is not None:
        text = re.sub(r'\s+', ' ', ' '.join(current_parts)).strip()
        if text:
            turns.append({'name': current_speaker, 'text': text})

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(turns, f, indent=2, ensure_ascii=False)

    print(f'Extracted {len(turns)} speaker turns → {output_path}', file=sys.stderr)
    return turns


if __name__ == '__main__':
    if len(sys.argv) not in (2, 3):
        print(f'Usage: {sys.argv[0]} input.pdf [output.json]', file=sys.stderr)
        sys.exit(1)

    pdf = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) == 3 else str(Path(pdf).with_suffix('.json'))
    extract_transcript(pdf, out)
