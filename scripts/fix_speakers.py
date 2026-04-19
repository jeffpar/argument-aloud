#!/usr/bin/env python3
"""
fix_speakers.py — normalise legacy justice names in transcript JSON files.

Renames:
  "JUSTICE BLACK"          → name="HUGO BLACK",       title="JUSTICE"
  "JUSTICE BRENNAN"        → name="WILLIAM BRENNAN",  title="JUSTICE"
  "JUSTICE DOUGLAS"        → name="WILLIAM DOUGLAS",  title="JUSTICE"
  "JUSTICE MARSHALL"       → name="THURGOOD MARSHALL",title="JUSTICE"
  "CHIEF JUSTICE MARSHALL" → name="THURGOOD MARSHALL",title="JUSTICE"
  "JUSTICE WHITE"          → name="BYRON WHITE",      title="JUSTICE"
  "JUSTICE STEWART"        → name="POTTER STEWART",   title="JUSTICE"
  "CHIEF JUSTICE BURGER"   → name="WARREN BURGER",    title="CHIEF JUSTICE"
  "CHIEF JU TICE BURGER"   → name="WARREN BURGER",    title="CHIEF JUSTICE"
  "CHIEFJUSTICE BURGER"    → name="WARREN BURGER",    title="CHIEF JUSTICE"

Both `media.speakers[].name` and `turns[].name` are updated.
Files are only rewritten when a change is made.
"""

import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Mapping: old name pattern (uppercase, stripped of title prefix) → (new_name, new_title)
# Keys are the full "TITLE NAME" strings as they appear in the JSON.
# ---------------------------------------------------------------------------
RENAMES: dict[str, tuple[str, str]] = {
    "JUSTICE BLACK":          ("HUGO BLACK",       "JUSTICE"),
    "JUSTICE BRENNAN":        ("WILLIAM BRENNAN",  "JUSTICE"),
    "JUSTICE DOUGLAS":        ("WILLIAM DOUGLAS",  "JUSTICE"),
    "JUSTICE MARSHALL":       ("THURGOOD MARSHALL","JUSTICE"),
    "CHIEF JUSTICE MARSHALL": ("THURGOOD MARSHALL","JUSTICE"),
    "JUSTICE WHITE":          ("BYRON WHITE",      "JUSTICE"),
    "JUSTICE STEWART":        ("POTTER STEWART",   "JUSTICE"),
    "CHIEF JUSTICE BURGER":   ("WARREN BURGER",    "CHIEF JUSTICE"),
    "CHIEF JU TICE BURGER":   ("WARREN BURGER",    "CHIEF JUSTICE"),
    "CHIEFJUSTICE BURGER":    ("WARREN BURGER",    "CHIEF JUSTICE"),
}

# Pre-compile a regex that matches any of the old names (longest first to
# avoid partial matches, e.g. "CHIEF JUSTICE" before "JUSTICE").
_SORTED_KEYS = sorted(RENAMES.keys(), key=len, reverse=True)
_PATTERN = re.compile(
    r'\b(?:' + '|'.join(re.escape(k) for k in _SORTED_KEYS) + r')\b',
    re.IGNORECASE,
)


def _canonical_key(raw: str) -> str:
    """Normalise whitespace and uppercase for lookup."""
    return ' '.join(raw.upper().split())


def fix_transcript(data: dict) -> bool:
    """Mutate *data* in-place, return True if anything changed."""
    changed = False

    # --- media.speakers ---
    for sp in data.get("media", {}).get("speakers", []):
        raw_name = sp.get("name", "")
        raw_title = sp.get("title", "")
        full = f"{raw_title} {raw_name}".strip() if raw_title else raw_name
        key = _canonical_key(full)
        if key in RENAMES:
            new_name, new_title = RENAMES[key]
            if sp.get("name") != new_name or sp.get("title") != new_title:
                sp["name"] = new_name
                sp["title"] = new_title
                changed = True
        else:
            # Also check the name alone (some files store title separately)
            key2 = _canonical_key(raw_name)
            if key2 in RENAMES:
                new_name, new_title = RENAMES[key2]
                if sp.get("name") != new_name or sp.get("title") != new_title:
                    sp["name"] = new_name
                    sp["title"] = new_title
                    changed = True

    # --- de-duplicate speakers (same name+title) ---
    media = data.get("media", {})
    speakers = media.get("speakers", [])
    seen_speakers: set[tuple] = set()
    deduped: list = []
    for sp in speakers:
        key = (_canonical_key(sp.get("name", "")), _canonical_key(sp.get("title", "")))
        if key not in seen_speakers:
            seen_speakers.add(key)
            deduped.append(sp)
    if len(deduped) != len(speakers):
        media["speakers"] = deduped
        changed = True

    # --- turns[].name ---
    for turn in data.get("turns", []):
        raw = turn.get("name", "")
        key = _canonical_key(raw)
        if key in RENAMES:
            new_name, _ = RENAMES[key]
            if turn["name"] != new_name:
                turn["name"] = new_name
                changed = True
        else:
            # Some turns may include the title prefix inline, e.g. "JUSTICE BLACK"
            m = _PATTERN.match(raw)
            if m:
                matched_key = _canonical_key(m.group(0))
                if matched_key in RENAMES:
                    new_name, _ = RENAMES[matched_key]
                    # Replace only the matched prefix, keep any trailing text.
                    turn["name"] = new_name + raw[m.end():]
                    changed = True

    return changed


def main() -> None:
    base = Path(__file__).parent.parent / "courts" / "ussc" / "terms"
    files_checked = 0
    files_changed = 0

    for path in sorted(base.rglob("*.json")):
        if "/cases/" not in str(path):
            continue
        files_checked += 1
        try:
            text = path.read_text(encoding="utf-8")
            data = json.loads(text)
        except Exception as e:
            print(f"  SKIP {path.relative_to(base.parent.parent)}: {e}", file=sys.stderr)
            continue

        if not isinstance(data, dict):
            continue  # bare-array legacy format — skip

        if fix_transcript(data):
            new_text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
            path.write_text(new_text, encoding="utf-8")
            files_changed += 1
            print(f"  fixed: {path.relative_to(base.parent.parent)}")

    print(f"\nChecked {files_checked} transcript files, updated {files_changed}.")


if __name__ == "__main__":
    main()
