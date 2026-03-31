#!/usr/bin/env python3
"""Aligns SCOTUS oral argument transcript(s) with their audio, adding a
"time" field (hh:mm:ss.nn) to each speaker turn.

Dependencies:
    pip install faster-whisper rapidfuzz
    brew install ffmpeg          # required by faster-whisper for MP3 input

Usage:
    python3 align_transcript.py TERM CASE [--model MODEL] [--purge]

Example:
    python3 align_transcript.py 2025-10 24-1238

The script reads courts/ussc/terms/TERM/cases.json, finds the matching
case, then for each argument that has a transcript (text_href) and audio
(audio_href), downloads the audio to a temporary file and runs alignment.

The Whisper word-level transcription is cached in the case directory as
    <case-dir>/<audio-stem>--whisper-<model>.json
so re-runs skip re-transcription (which can take several minutes).

An argument is skipped when every turn already has a "time" value.
Use --purge to clear all existing timestamps before aligning.
"""

import argparse
import json
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

try:
    from faster_whisper import WhisperModel
except ImportError:
    sys.exit("Missing dependency — install with:  pip install faster-whisper")

try:
    from rapidfuzz import fuzz
except ImportError:
    sys.exit("Missing dependency — install with:  pip install rapidfuzz")


# ── Helpers ───────────────────────────────────────────────────────────────────

def normalise(text: str) -> str:
    """Lowercase, strip punctuation (keep apostrophes), collapse whitespace."""
    text = text.lower()
    text = re.sub(r"[^\w\s']", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def first_n_words(text: str, n: int) -> str:
    return " ".join(normalise(text).split()[:n])


def format_time(seconds: float) -> str:
    """Format seconds as hh:mm:ss.nn (hundredths of a second)."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:05.2f}"


def parse_time(time_str: str) -> float:
    """Parse hh:mm:ss.nn → seconds."""
    h, m, s = time_str.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


# ── Whisper transcription / cache ─────────────────────────────────────────────

def transcribe(audio_path: Path, model_name: str,
               cache_path: Path | None = None) -> list[dict]:
    """Return word dicts: [{"word": str, "start": float, "end": float}, ...]
    Uses *cache_path* when provided; otherwise caches alongside the audio."""
    safe_model = model_name.replace("/", "-")
    cache = cache_path or audio_path.with_name(
        f"{audio_path.stem}--whisper-{safe_model}.json"
    )

    if cache.exists():
        print(f"[align] Loading cached transcription: {cache}", file=sys.stderr)
        with cache.open(encoding="utf-8") as f:
            return json.load(f)

    print(f"[align] Transcribing with Whisper model '{model_name}' …", file=sys.stderr)
    print(f"[align] This may take several minutes for a long audio file.", file=sys.stderr)

    model = WhisperModel(model_name, compute_type="int8")
    segments, info = model.transcribe(
        str(audio_path),
        word_timestamps=True,
        language="en",
        vad_filter=True,
    )

    words = []
    for seg in segments:
        for w in seg.words or []:
            words.append({"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3)})

    cache.parent.mkdir(parents=True, exist_ok=True)
    with cache.open("w", encoding="utf-8") as f:
        json.dump(words, f, indent=2)

    print(f"[align] Saved transcription cache → {cache}", file=sys.stderr)
    print(f"[align] Audio duration: {info.duration:.1f}s, words: {len(words)}", file=sys.stderr)
    return words


# ── Alignment ─────────────────────────────────────────────────────────────────

def build_word_norms(words: list[dict]) -> list[str]:
    """Normalised token for each word, parallel to `words`."""
    return [re.sub(r"[^\w']", "", w["word"].lower()) for w in words]


def timestamp_to_word_idx(ts_seconds: float, words: list[dict]) -> int:
    """Binary search: return index of first word whose start >= ts_seconds."""
    lo, hi = 0, len(words)
    while lo < hi:
        mid = (lo + hi) // 2
        if words[mid]["start"] < ts_seconds:
            lo = mid + 1
        else:
            hi = mid
    return lo


def search_window(
    text: str,
    word_norms: list[str],
    words: list[dict],
    w_start: int,
    w_end: int,
    n_words: int = 8,
    threshold: float = 50.0,
) -> tuple[float | None, int]:
    """Fuzzy-match `text` against word_norms[w_start:w_end].

    Short turns (<4 words) are skipped — they will receive interpolated
    timestamps instead.

    Returns (start_seconds, matched_word_index) or (None, -1).
    """
    query_tokens = normalise(text).split()[:n_words]
    if len(query_tokens) < 4:
        return None, -1
    query_str = " ".join(query_tokens)
    n = len(query_tokens)

    end = min(w_end, len(word_norms) - n)
    if end <= w_start:
        return None, -1

    best_score = -1.0
    best_idx = -1
    for i in range(w_start, end):
        candidate = " ".join(word_norms[i : i + n])
        score = fuzz.ratio(query_str, candidate)
        if score > best_score:
            best_score = score
            best_idx = i

    if best_score >= threshold and best_idx >= 0:
        return words[best_idx]["start"], best_idx

    return None, -1


def find_turn_start(
    text: str,
    word_norms: list[str],
    words: list[dict],
    search_from: int,
    n_words: int = 8,
    look_ahead: int = 600,
    base_threshold: float = 58.0,
    near_window: int = 200,
    far_threshold: float = 85.0,
) -> tuple[float | None, int]:
    """Fuzzy-match the first `n_words` of `text` against a sliding window.

    Matches within `near_window` words of search_from need only `base_threshold`.
    Matches further ahead need the stricter `far_threshold` to prevent a single
    ambiguous phrase (e.g. "Mr. Chief Justice, and may it please the Court")
    from causing a multi-minute false-positive leap.

    Short turns (<4 words) are skipped.

    Returns (start_seconds, matched_word_index) or (None, search_from).
    """
    # Find the best match anywhere in the full window.
    ts, idx = search_window(text, word_norms, words,
                            search_from, search_from + look_ahead,
                            n_words, base_threshold)
    if ts is None:
        return None, search_from

    # If the match is far away, confirm it clears the stricter threshold.
    if idx - search_from > near_window:
        ts2, idx2 = search_window(text, word_norms, words,
                                  search_from, search_from + look_ahead,
                                  n_words, far_threshold)
        if ts2 is None:
            return None, search_from
        return ts2, idx2

    return ts, idx


# ── Per-argument alignment ────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent


def _fetch_words(audio_href: str, cache_path: Path, model_name: str) -> list[dict]:
    """Return Whisper words, loading from cache or downloading + transcribing."""
    if cache_path.exists():
        return transcribe(cache_path, model_name, cache_path=cache_path)  # cache hit

    suffix = Path(audio_href.split("?")[0]).suffix or ".mp3"
    print(f"[align] Downloading audio: {audio_href}", file=sys.stderr)
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        urllib.request.urlretrieve(audio_href, tmp_path)
        return transcribe(tmp_path, model_name, cache_path=cache_path)
    finally:
        tmp_path.unlink(missing_ok=True)


def _align_argument(arg: dict, case_dir: Path, model_name: str, purge: bool) -> None:
    """Align a single argument's transcript file in-place."""
    text_href  = arg.get("text_href")
    audio_href = arg.get("audio_href")
    date_label = arg.get("date", "?")

    if not text_href or not audio_href:
        print(f"[align] {date_label}: missing text_href or audio_href — skipped.",
              file=sys.stderr)
        return

    transcript_path = case_dir / text_href
    if not transcript_path.exists():
        print(f"[align] {transcript_path} not found — skipped.", file=sys.stderr)
        return

    turns = json.loads(transcript_path.read_text(encoding="utf-8"))

    if purge:
        removed = sum(1 for t in turns if t.pop("time", None) is not None)
        print(f"[align] {transcript_path.name}: purged {removed} existing timestamps.",
              file=sys.stderr)

    unaligned = [i for i, t in enumerate(turns) if not t.get("time")]
    if not unaligned:
        print(f"[align] {transcript_path.name}: all turns already have timestamps — skipped.",
              file=sys.stderr)
        return

    print(f"[align] {transcript_path.name}: "
          f"{len(unaligned)} of {len(turns)} turns need alignment.", file=sys.stderr)

    # Cache whisper output in the case dir, keyed by audio stem + model.
    audio_stem = Path(audio_href.split("?")[0]).stem
    safe_model = model_name.replace("/", "-")
    cache_path = case_dir / f"{audio_stem}--whisper-{safe_model}.json"

    words      = _fetch_words(audio_href, cache_path, model_name)
    word_norms = build_word_norms(words)
    total_words = len(words)

    # ── Pass 1: forward scan ──────────────────────────────────────────────────
    search_from = 0
    p1_direct = 0

    for i, turn in enumerate(turns):
        if turn.get("time"):
            search_from = max(search_from, timestamp_to_word_idx(parse_time(turn["time"]), words))
            continue

        ts, matched_idx = find_turn_start(turn["text"], word_norms, words, search_from)

        if ts is not None:
            turn["time"] = format_time(ts)
            search_from = matched_idx
            p1_direct += 1

    print(f"[align] Pass 1 (forward scan):  {p1_direct} turns matched.", file=sys.stderr)

    # ── Pass 2: anchor-bounded search ────────────────────────────────────────
    # For each still-unmatched turn that has >= 4 words, search only within
    # the word-index range determined by its surrounding anchored turns.
    # This gives every part of the audio a fair chance to be searched.
    p2_direct = 0
    nturn = len(turns)

    for i in range(nturn):
        if turns[i].get("time"):
            continue

        # Find bounding anchors.
        prev_w, prev_t = 0, 0.0
        for j in range(i - 1, -1, -1):
            if turns[j].get("time"):
                prev_t = parse_time(turns[j]["time"])
                prev_w = timestamp_to_word_idx(prev_t, words)
                break

        next_w = total_words
        for j in range(i + 1, nturn):
            if turns[j].get("time"):
                next_w = timestamp_to_word_idx(parse_time(turns[j]["time"]), words)
                break

        ts, matched_idx = search_window(turns[i]["text"], word_norms, words, prev_w, next_w)
        if ts is not None:
            turns[i]["time"] = format_time(ts)
            p2_direct += 1

    print(f"[align] Pass 2 (anchor-bounded): {p2_direct} turns matched.", file=sys.stderr)

    # ── Pass 3: interpolation ─────────────────────────────────────────────────
    # Anything still unmatched (too short, or no fuzzy match above threshold)
    # gets a timestamp by linear interpolation between its anchor neighbours.
    interpolated = 0
    for i in range(nturn):
        if turns[i].get("time"):
            continue

        prev_t, prev_i = None, None
        for j in range(i - 1, -1, -1):
            if turns[j].get("time"):
                prev_t, prev_i = parse_time(turns[j]["time"]), j
                break

        next_t, next_i = None, None
        for j in range(i + 1, nturn):
            if turns[j].get("time"):
                next_t, next_i = parse_time(turns[j]["time"]), j
                break

        if prev_t is not None and next_t is not None:
            frac = (i - prev_i) / (next_i - prev_i)
            ts = prev_t + frac * (next_t - prev_t)
        elif prev_t is not None:
            ts = prev_t
        elif next_t is not None:
            ts = next_t
        else:
            continue

        turns[i]["time"] = format_time(ts)
        interpolated += 1

    total_direct = p1_direct + p2_direct
    with transcript_path.open("w", encoding="utf-8") as f:
        json.dump(turns, f, indent=2, ensure_ascii=False)

    print(
        f"[align] Pass 3 (interpolation):  {interpolated} turns estimated.",
        file=sys.stderr,
    )
    print(
        f"[align] Total: {total_direct} directly matched + {interpolated} interpolated "
        f"= {total_direct + interpolated}/{nturn} → {transcript_path}",
        file=sys.stderr,
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("term", help="Term identifier, e.g. 2025-10")
    ap.add_argument("case", help="Case number, e.g. 24-1238")
    ap.add_argument("--model", default="medium.en",
                    help="Whisper model size (default: medium.en). "
                         "Options: tiny.en small.en medium.en large-v2 large-v3")
    ap.add_argument("--purge", action="store_true",
                    help="Remove all existing 'time' values before aligning.")
    args = ap.parse_args()

    term_dir   = REPO_ROOT / "courts" / "ussc" / "terms" / args.term
    cases_json = term_dir / "cases.json"

    if not cases_json.exists():
        sys.exit(f"Error: {cases_json} not found")

    cases = json.loads(cases_json.read_text(encoding="utf-8"))
    case  = next((c for c in cases if c.get("number") == args.case), None)
    if case is None:
        sys.exit(f"Error: case {args.case!r} not found in {cases_json}")

    arguments = case.get("arguments", [])
    if not arguments:
        sys.exit(f"Error: case {args.case!r} has no arguments listed.")

    case_dir = term_dir / args.case
    if not case_dir.is_dir():
        sys.exit(f"Error: case directory not found: {case_dir}")

    for arg in arguments:
        _align_argument(arg, case_dir, args.model, args.purge)


if __name__ == "__main__":
    main()
