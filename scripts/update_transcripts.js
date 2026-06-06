#!/usr/bin/env node
/**
 * update_transcripts.js - Align transcript turns with audio using Whisper, and/or
 * split multi-sentence turns into individual turns.
 *
 * Usage:
 *   node scripts/update_transcripts.js TERM CASE SOURCE TYPE [--realign] [--split] [--model MODEL]
 *
 * Arguments:
 *   TERM    Term in YYYY-MM format (e.g., 2014-10)
 *   CASE    Case number (e.g., 14-378), or - to process all eligible cases in the term
 *   SOURCE  Event source: ussc | oyez | nara
 *   TYPE    Event type:   argument | opinion | reargument
 *
 * Batch mode (CASE = -):
 *   Processes every case in the term that has a SOURCE/TYPE event with a text_href
 *   that is not yet aligned and not redundant, provided no oyez event of the same
 *   type is already aligned for that case.
 *
 * Options:
 *   --realign          Align even if time properties are already present
 *   --split            Split multi-sentence turns before aligning
 *   --model MODEL      Whisper model size (default: base; try small or medium for better accuracy)
 *   --beam-size N      Whisper beam size (default: 5; higher = slower but more accurate, e.g. 10)
 *   --no-vad           Disable Whisper VAD filter (use when VAD cuts off audio early, e.g. at ~60 min)
 *   --dry-run          Print what would change without writing files
 *
 * Examples:
 *   node scripts/update_transcripts.js 2014-10 14-378 ussc argument
 *   node scripts/update_transcripts.js 2014-10 14-378 ussc argument --realign
 *   node scripts/update_transcripts.js 2014-10 14-378 ussc argument --split
 *   node scripts/update_transcripts.js 2014-10 14-378 ussc argument --split --realign
 *   node scripts/update_transcripts.js 2014-10 14-378 ussc argument --realign --no-vad
 *   node scripts/update_transcripts.js 2014-10 14-378 oyez opinion --model small
 *
 * Requires: python3 with faster-whisper and rapidfuzz installed.
 *   pip install faster-whisper rapidfuzz
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── fs helpers ─────────────────────────────────────────────────────────────

const exists    = (p) => fs.existsSync(p);
const readText  = (p) => fs.readFileSync(p, 'utf8');
const writeText = (p, s) => fs.writeFileSync(p, s, 'utf8');
const readJson  = (p) => JSON.parse(readText(p));
const writeJson = (p, d) => writeText(p, JSON.stringify(d, null, 2) + '\n');

// ── Sentence splitting ─────────────────────────────────────────────────────

/**
 * Abbreviations that should NOT cause a sentence split.
 * All lowercase, without the trailing period.
 */
const ABBREVS = new Set([
    // Titles
    'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'gen', 'gov', 'sen', 'rep',
    'lt', 'cpl', 'sgt', 'pvt', 'maj', 'col', 'capt', 'cmdr', 'adm',
    'amb', 'pres', 'rev', 'hon', 'atty', 'asst', 'supt',
    // Legal
    'v', 'vs', 'cf', 'ibid', 'id', 'al', 'seq', 'no', 'nos',
    'vol', 'vols', 'pp', 'p', 'para', 'sec', 'art', 'ch', 'pg',
    'fig', 'op', 'cit', 'supra', 'infra', 'et', 'aff', 'rev', 'cert',
    // Organizations / business suffixes
    'inc', 'ltd', 'corp', 'co', 'llc', 'llp', 'lp', 'pc', 'plc',
    'assn', 'assoc', 'mfg', 'bros', 'dept', 'div', 'mgmt',
    // Geo / address
    'u', 'us', 'usa', 'dc', 'ave', 'st', 'blvd', 'rd', 'ct', 'pl',
    'hwy', 'pkwy', 'sq', 'cir',
    // US states (commonly abbreviated in legal citations)
    'ala', 'ariz', 'ark', 'cal', 'colo', 'conn', 'del', 'fla',
    'ga', 'ida', 'ill', 'ind', 'kan', 'ky', 'la', 'md', 'mass',
    'mich', 'minn', 'miss', 'mo', 'mont', 'neb', 'nev', 'nh',
    'nj', 'nm', 'ny', 'nc', 'nd', 'ohio', 'okla', 'ore', 'pa',
    'ri', 'sc', 'sd', 'tenn', 'tex', 'utah', 'vt', 'va', 'wash',
    'wis', 'wyo', 'wv',
    // Months
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct',
    'nov', 'dec',
    // Suffixes
    'jr', 'sr', 'ii', 'iii', 'iv',
    // Misc
    'etc', 'eg', 'ie', 'approx', 'est', 'dept', 'govt', 'intl',
    'natl', 'tech', 'univ', 'inst', 'acad', 'ctr',
]);

/**
 * Splits text into sentences, avoiding splits after known abbreviations,
 * single letters (initials), and numerals.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
    const result = [];
    let start = 0;

    // Match a terminal punctuation mark followed by whitespace + uppercase letter.
    // Handles standard sentence-ending patterns. We'll check context for '.' below.
    const re = /([.?!])\s+(?=[A-Z"'])/g;
    let m;

    while ((m = re.exec(text)) !== null) {
        if (m[1] === '.') {
            // Inspect the word immediately before the period.
            const before = text.slice(0, m.index);
            const wordMatch = before.match(/(\w+)$/);
            if (wordMatch) {
                const word = wordMatch[1];
                // Skip if it's a known abbreviation (case-insensitive).
                if (ABBREVS.has(word.toLowerCase())) continue;
                // Skip single uppercase letter (initial like "J. Thomas" → "J.").
                if (/^[A-Z]$/.test(word)) continue;
                // Skip if the token before the period looks like a number or
                // case-number fragment (e.g., "14-378").
                if (/^\d/.test(word)) continue;
            }
        }
        result.push(text.slice(start, m.index + 1).trim());
        start = m.index + m[0].length;
    }

    const tail = text.slice(start).trim();
    if (tail.length > 0) result.push(tail);

    return result.filter(s => s.length > 0);
}

/**
 * Applies sentence splitting to an array of turns. Returns a new array of
 * turns with bumped turn numbers where splits occurred. The `time` property
 * is preserved on the first sub-turn and omitted on the rest (they'll get
 * assigned during alignment).
 *
 * @param {Array<{turn: number, name: string, text: string, time?: string}>} turns
 * @returns {Array<{turn: number, name: string, text: string, time?: string}>}
 */
function applySplit(turns) {
    const result = [];
    let offset = 0;     // cumulative extra turns from previous splits

    for (const turn of turns) {
        const sentences = splitSentences(turn.text);
        if (sentences.length <= 1) {
            result.push({ ...turn, turn: turn.turn + offset });
        } else {
            for (let i = 0; i < sentences.length; i++) {
                const newTurn = {
                    turn: turn.turn + offset + i,
                    name: turn.name,
                    text: sentences[i],
                };
                // Carry over existing time only for first sub-turn.
                if (i === 0 && turn.time !== undefined) {
                    newTurn.time = turn.time;
                }
                result.push(newTurn);
            }
            offset += sentences.length - 1;
        }
    }

    return result;
}

// ── Text scrubbing ─────────────────────────────────────────────────────────

/**
 * Scrubs problematic invisible/control Unicode characters from turn text.
 *
 * Characters replaced/removed:
 *   U+00AD  SOFT HYPHEN           – one or more → U+2014 EM DASH (—)
 *   U+200B  ZERO WIDTH SPACE      – removed
 *   U+200C  ZERO WIDTH NON-JOINER – removed
 *   U+200D  ZERO WIDTH JOINER     – removed
 *   U+200E  LEFT-TO-RIGHT MARK    – removed
 *   U+200F  RIGHT-TO-LEFT MARK    – removed
 *   U+FEFF  BOM / ZERO WIDTH NO-BREAK SPACE – removed
 *
 * After removal, runs of multiple spaces are collapsed to one and the result
 * is trimmed.
 *
 * @param {string} text
 * @returns {string}
 */
function scrubText(text) {
    return text
        // One or more consecutive soft hyphens → em-dash.
        .replace(/\u00AD+/g, '\u2014')
        .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF]/g, '')
        .replace(/ {2,}/g, ' ')
        .trim();
}

/**
 * Applies scrubText to every turn in an array. Returns a new array; turns
 * whose text does not change are returned as-is (same object reference).
 *
 * @param {Array<{turn: number, name: string, text: string, time?: string}>} turns
 * @returns {{ turns: Array, count: number }}  count = number of turns changed
 */
function scrubTurns(turns) {
    let count = 0;
    const result = turns.map(t => {
        const clean = scrubText(t.text);
        if (clean === t.text) return t;
        count++;
        return { ...t, text: clean };
    });
    return { turns: result, count };
}

// ── Time formatting ────────────────────────────────────────────────────────

/**
 * Converts seconds (float) to "HH:MM:SS.NN" where NN is hundredths.
 * The .NN portion is treated as decimal seconds by the JS player
 * (i.e., .98 → 0.98 s), so we emit hundredths-of-a-second directly.
 *
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) {
        seconds = 0;
    }
    const h  = Math.floor(seconds / 3600);
    const m  = Math.floor((seconds % 3600) / 60);
    const s  = seconds % 60;
    const ss = Math.floor(s);
    const nn = Math.round((s - ss) * 100);
    return [
        String(h).padStart(2, '0'),
        String(m).padStart(2, '0'),
        String(ss).padStart(2, '0'),
    ].join(':') + '.' + String(nn).padStart(2, '0');
}

// ── Whisper alignment via Python subprocess ────────────────────────────────

/**
 * Embedded Python script for Whisper-based turn alignment.
 * Written to a temp file and executed as a subprocess.
 */
const ALIGN_PY = `
import sys, json, bisect

def main():
    input_data = json.loads(sys.argv[1])
    audio_path = input_data['audio_path']
    turns = input_data['turns']
    model_size = input_data.get('model_size', 'base')
    offset_secs = float(input_data.get('offset_secs', 0))
    beam_size = int(input_data.get('beam_size', 5))
    vad_filter = bool(input_data.get('vad_filter', True))

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("ERROR: faster_whisper not installed. Run: pip install faster-whisper")

    try:
        from rapidfuzz import fuzz
    except ImportError:
        sys.exit("ERROR: rapidfuzz not installed. Run: pip install rapidfuzz")

    model = WhisperModel(model_size, device='cpu', compute_type='int8')

    segments_gen, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=vad_filter,
        beam_size=beam_size,
    )
    segments = list(segments_gen)

    # info.duration is the actual audio file length in seconds, regardless of
    # VAD. This is our ground truth for proportional estimation.
    total_duration = info.duration

    # Collect word-level timestamps.
    all_words = []
    for seg in segments:
        for w in (seg.words or []):
            word = w.word.strip()
            if word:
                all_words.append({'word': word, 'start': w.start + offset_secs, 'end': w.end + offset_secs})

    # Fall back to segment-level if no word timestamps returned.
    if not all_words:
        for seg in segments:
            text = seg.text.strip()
            if text:
                all_words.append({'word': text, 'start': seg.start + offset_secs, 'end': seg.end + offset_secs})

    if not all_words:
        # No speech detected; assign proportional times based on text alone.
        total_chars = sum(len(t['text']) for t in turns)
        cum = 0
        result = []
        for t in turns:
            frac = cum / total_chars if total_chars > 0 else 0
            result.append({'turn': t['turn'], 'time': frac * total_duration, 'matched': False})
            cum += len(t['text'])
        print(json.dumps(result))
        return

    n_words = len(all_words)

    # Build a sorted list of word start-times for fast bisect lookups.
    word_starts = [w['start'] for w in all_words]

    # Pre-compute the cumulative character offset before each turn. This lets
    # us estimate the proportional position in the audio where each turn should
    # begin, using the assumption that text and audio are roughly proportional.
    total_chars = sum(len(t['text']) for t in turns)
    cum_chars = []
    acc = 0
    for t in turns:
        cum_chars.append(acc)
        acc += len(t['text'])

    def prop_time(turn_idx):
        """Expected start time of turn_idx based on text proportion."""
        frac = cum_chars[turn_idx] / total_chars if total_chars > 0 else 0
        return frac * total_duration

    def time_to_word_pos(t):
        """Word index nearest to time t (via bisect on word_starts)."""
        pos = bisect.bisect_left(word_starts, t)
        return min(pos, n_words - 1)

    # Minimum fuzzy-match score to treat a match as a reliable timing anchor.
    # Turns scoring below this threshold are marked as non-anchors and will have
    # their timestamps filled in by interpolation between surrounding anchors in
    # the second pass below.
    HIGH_CONF = 70

    timestamps = []
    search_start = 0

    for idx, turn in enumerate(turns):
        text = turn['text']
        query_words = text.split()[:15]
        query = ' '.join(query_words).lower()
        n_q = len(query_words)

        # Proportional estimate: where in the audio should this turn begin.
        expected_time = prop_time(idx)
        expected_pos  = time_to_word_pos(expected_time)

        # Hard upper bound: never let search_start race more than one tolerance
        # step ahead of where proportional math says we should be.  This prevents
        # a run of high-confidence (but wrong) matches from consuming words that
        # belong to later turns.
        tolerance = max(50, int(0.10 * n_words))
        search_start = min(search_start, expected_pos + tolerance)

        # Exhaustion: all audio words consumed.
        if search_start >= n_words - 1:
            remaining = turns[idx:]
            rem_chars = [max(1, len(t['text'])) for t in remaining]
            total_rem  = sum(rem_chars)
            last_time  = timestamps[-1]['time'] if timestamps else 0.0
            span       = max(0.0, total_duration - last_time)
            cum = 0
            for i, rt in enumerate(remaining):
                frac = cum / total_rem
                timestamps.append({'turn': rt['turn'], 'time': last_time + frac * span, 'matched': False})
                cum += rem_chars[i]
            break

        # Search window: centred on expected_pos, but never starting before the
        # monotonic floor (search_start) so turn order is preserved.
        look_back = min(5, search_start)
        window_lo = max(search_start - look_back, expected_pos - tolerance)
        window_hi = min(n_words, expected_pos + tolerance)
        # Ensure there is always some window even if expected_pos is behind
        # search_start (e.g. first few turns whose proportion is near 0).
        if window_hi <= window_lo:
            window_hi = min(n_words, window_lo + tolerance)

        best_score = -1
        best_pos   = window_lo  # default: first position in window

        for i in range(window_lo, window_hi):
            window_text = ' '.join(w['word'] for w in all_words[i:i + n_q]).lower()
            score = fuzz.token_set_ratio(query, window_text)
            if score > best_score:
                best_score = score
                best_pos   = i
            if score >= 95 and i >= search_start:
                break

        if best_score >= HIGH_CONF:
            # High-confidence match: trust the Whisper timestamp and advance
            # search_start so the next turn searches from here onward.
            start_time = all_words[best_pos]['start']
            timestamps.append({'turn': turn['turn'], 'time': start_time, 'matched': True})
            search_start = max(search_start, best_pos + max(n_q, 1))
            if search_start >= n_words:
                search_start = n_words - 1
        else:
            # Low-confidence: store a proportional placeholder and mark as
            # non-anchor.  Do NOT advance search_start based on best_pos (which
            # may be wrong); instead advance only to expected_pos so the window
            # for the next turn stays centred on proportional time.
            timestamps.append({'turn': turn['turn'], 'time': expected_time, 'matched': False})
            search_start = max(search_start, expected_pos)

    # ── Pass 2: fill non-anchor gaps by interpolation between anchors ─────────
    #
    # For each run of non-anchor turns sandwiched between two anchor turns,
    # replace the placeholder proportional times with times that are linearly
    # interpolated between the two anchor timestamps, weighted by character count.
    # This is much more accurate than the global proportional estimate because it
    # is anchored to real timestamps on both sides.
    #
    # The anchor turn's own character count is included in the denominator so
    # that the first non-anchor turn after an anchor starts proportionally after
    # the anchor's own text, rather than colliding with the anchor's timestamp.

    n = len(timestamps)
    anchor_indices = [i for i, t in enumerate(timestamps) if t.get('matched')]

    if anchor_indices:
        # ── Before first anchor: distribute [0, t_first_anchor) ──────────────
        first_a = anchor_indices[0]
        if first_a > 0:
            t1 = timestamps[first_a]['time']
            seg_chars = [max(1, len(turns[i]['text'])) for i in range(first_a)]
            total_c = sum(seg_chars) or 1
            cum = 0
            for j, i in enumerate(range(first_a)):
                timestamps[i]['time'] = cum / total_c * t1
                cum += seg_chars[j]

        # ── Between consecutive anchors ───────────────────────────────────────
        for k in range(len(anchor_indices) - 1):
            a0 = anchor_indices[k]
            a1 = anchor_indices[k + 1]
            if a1 - a0 <= 1:
                continue  # no gap to fill
            t0 = timestamps[a0]['time']
            t1 = timestamps[a1]['time']
            if t1 <= t0:
                continue  # non-monotonic anchor pair; skip (safety net handles it)
            # Include a0's chars so turn a0+1 starts after a0's proportional span.
            seg_chars = [max(1, len(turns[i]['text'])) for i in range(a0, a1)]
            total_c = sum(seg_chars) or 1
            cum = seg_chars[0]  # start after a0's own text
            for j in range(1, len(seg_chars)):  # j=1 → turn a0+1
                timestamps[a0 + j]['time'] = t0 + cum / total_c * (t1 - t0)
                cum += seg_chars[j]

        # ── After last anchor: distribute [t_last_anchor, total_duration) ────
        last_a = anchor_indices[-1]
        if last_a < n - 1:
            t0 = timestamps[last_a]['time']
            seg_chars = [max(1, len(turns[i]['text'])) for i in range(last_a, n)]
            total_c = sum(seg_chars) or 1
            cum = seg_chars[0]  # start after last_a's own text
            for j in range(1, len(seg_chars)):
                timestamps[last_a + j]['time'] = t0 + cum / total_c * (total_duration - t0)
                cum += seg_chars[j]

    # ── Safety net: enforce monotonically non-decreasing timestamps ───────────
    for i in range(1, n):
        if timestamps[i]['time'] < timestamps[i - 1]['time']:
            timestamps[i]['time'] = timestamps[i - 1]['time']

    print(json.dumps(timestamps))

main()
`.trim();

/**
 * Downloads a URL to a local file path.
 *
 * @param {string} url
 * @param {string} destPath
 */
async function downloadFile(url, destPath) {
    const resp = await fetch(url, {
        headers: { 'User-Agent': 'update_transcripts/1.0' },
    });
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${url}`);
    }
    const buf = await resp.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(buf));
}

/**
 * Runs the Whisper alignment Python script against an audio file.
 *
 * @param {string} audioPath   Path to a local audio file
 * @param {Array}  turns       Array of {turn, text} objects
 * @param {object} opts        { modelSize, offsetSecs, vadFilter }
 * @returns {Array<{turn: number, time: number}>}
 */
function runAlignment(audioPath, turns, { modelSize = 'base', beamSize = 5, offsetSecs = 0, vadFilter = true } = {}) {
    // Write the Python script to a temp file.
    const pyPath = path.join(os.tmpdir(), `update_transcripts_align_${process.pid}.py`);
    writeText(pyPath, ALIGN_PY);

    const inputJson = JSON.stringify({
        audio_path: audioPath,
        turns: turns.map(t => ({ turn: t.turn, text: t.text })),
        model_size: modelSize,
        beam_size: beamSize,
        offset_secs: offsetSecs,
        vad_filter: vadFilter,
    });

    let output;
    try {
        output = execFileSync('python3', [pyPath, inputJson], {
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
        });
    } finally {
        try { fs.unlinkSync(pyPath); } catch {}
    }

    // The Python script prints a single JSON line on stdout.
    const lastLine = output.trim().split('\n').filter(l => l.startsWith('[')).pop();
    if (!lastLine) {
        throw new Error(`Alignment script produced no JSON output.\n${output}`);
    }
    return JSON.parse(lastLine);
}

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * Processes a single case: scrub, split (if --split), and align (if needed).
 * Mutates the event's `aligned` flag in-place and writes cases.json on success.
 * Returns true on success, false on non-fatal error (used in batch mode).
 */
async function processCase(term, caseObj, source, type, cases, casesPath, opts) {
    const { doRealign, doSplit, dryRun, noVad, modelSize, beamSize } = opts;

    // ── Find the event ─────────────────────────────────────────────────────
    const event = (caseObj.events || []).find(
        e => e.source === source && e.type === type
    );
    if (!event) {
        console.error(`No ${source}/${type} event found for case ${caseObj.number}`);
        return false;
    }
    if (!event.text_href) {
        console.error(`Event ${source}/${type} has no text_href for case ${caseObj.number}`);
        return false;
    }
    if (!event.audio_href) {
        console.error(`Event ${source}/${type} has no audio_href for case ${caseObj.number}`);
        return false;
    }

    // ── Load transcript ────────────────────────────────────────────────────
    const casesDir = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases');
    const transcriptPath = path.join(casesDir, event.text_href);
    if (!exists(transcriptPath)) {
        console.error(`Transcript not found: ${transcriptPath}`);
        return false;
    }
    const transcript = readJson(transcriptPath);
    const turns = transcript.turns || [];

    // ── Check alignment status ─────────────────────────────────────────────
    const isAligned = turns.some(t => t.time !== undefined);
    if (isAligned && !doRealign && !doSplit) {
        // Still run a scrub pass in case the source had invisible characters.
        const { turns: scrubbed, count } = scrubTurns(turns);
        if (count > 0) {
            console.log(`Scrubbed invisible/control characters from ${count} turn(s).`);
            if (!dryRun) {
                writeJson(transcriptPath, { ...transcript, turns: scrubbed });
                console.log(`Wrote: ${path.relative(REPO_ROOT, transcriptPath)}`);
            } else {
                console.log('[dry-run] Would write scrubbed transcript.');
            }
        } else {
            console.log(`Transcript is already aligned and clean. Use --realign to re-align.`);
        }
        return true;
    }

    // If only --split (no realign, already aligned), we can still split.
    const needsAlign = !isAligned || doRealign;

    // ── Text scrubbing ─────────────────────────────────────────────────────
    let workingTurns = turns;
    {
        const { turns: scrubbed, count } = scrubTurns(workingTurns);
        workingTurns = scrubbed;
        if (count > 0) {
            console.log(`Scrubbed invisible/control characters from ${count} turn(s).`);
        }
    }

    // ── Sentence splitting ─────────────────────────────────────────────────
    if (doSplit) {
        const before = workingTurns.length;
        workingTurns = applySplit(workingTurns);
        const added = workingTurns.length - before;
        if (added > 0) {
            console.log(`Split: ${before} turns → ${workingTurns.length} turns (+${added})`);
        } else {
            console.log('Split: no multi-sentence turns found.');
        }
    }

    // ── Alignment ─────────────────────────────────────────────────────────
    if (needsAlign) {
        // Remove existing time properties if realigning.
        if (doRealign) {
            workingTurns = workingTurns.map(t => {
                const { time: _t, ...rest } = t;
                return rest;
            });
        }

        // Download audio to a temp file.
        const audioExt  = path.extname(new URL(event.audio_href).pathname) || '.mp3';
        const audioPath = path.join(os.tmpdir(), `update_transcripts_audio_${process.pid}${audioExt}`);

        console.log(`Downloading audio: ${event.audio_href}`);
        try {
            await downloadFile(event.audio_href, audioPath);
        } catch (err) {
            console.error(`Failed to download audio: ${err.message}`);
            return false;
        }
        console.log(`Audio saved to: ${audioPath}`);

        const offsetSecs = event.offset || 0;
        console.log(`Running Whisper alignment (model=${modelSize}, beam_size=${beamSize}, vad=${!noVad ? 'off' : 'on'})…`);

        let alignedTimes;
        try {
            alignedTimes = runAlignment(audioPath, workingTurns, { modelSize, beamSize, offsetSecs, vadFilter: !noVad });
        } finally {
            try { fs.unlinkSync(audioPath); } catch {}
        }

        // Build a lookup by turn number.
        const timeByTurn = new Map(alignedTimes.map(r => [r.turn, r.time]));

        // Apply timestamps to turns.
        workingTurns = workingTurns.map(t => {
            const secs = timeByTurn.get(t.turn);
            if (secs !== undefined && secs !== null) {
                return { ...t, time: formatTime(secs) };
            }
            return t;
        });

        // JS-side monotonicity guard: the Python code already enforces this,
        // but clamp again here in case of any floating-point edge cases.
        for (let i = 1; i < workingTurns.length; i++) {
            if (workingTurns[i].time !== undefined && workingTurns[i - 1].time !== undefined) {
                if (workingTurns[i].time < workingTurns[i - 1].time) {
                    workingTurns[i] = { ...workingTurns[i], time: workingTurns[i - 1].time };
                }
            }
        }

        // Every turn now gets a time (Whisper anchor or interpolated estimate).
        const matched   = alignedTimes.filter(r => r.matched).length;
        const total     = workingTurns.length;
        console.log(`Aligned ${total} turns (${matched} high-confidence, ${total - matched} interpolated).`);
    }

    // ── Write transcript ───────────────────────────────────────────────────
    const updatedTranscript = { ...transcript, turns: workingTurns };

    if (dryRun) {
        console.log('[dry-run] Would write transcript:', transcriptPath);
        console.log('[dry-run] First few turns:');
        workingTurns.slice(0, 3).forEach(t => {
            console.log(`  Turn ${t.turn} (${t.name}): time=${t.time ?? '(none)'} text=${t.text.slice(0, 60)}…`);
        });
    } else {
        writeJson(transcriptPath, updatedTranscript);
        console.log(`Wrote: ${path.relative(REPO_ROOT, transcriptPath)}`);
    }

    // ── Update aligned flag in cases.json ─────────────────────────────────
    if (needsAlign) {
        const timedCount = workingTurns.filter(t => t.time !== undefined).length;
        if (timedCount > 0 && !event.aligned) {
            if (dryRun) {
                console.log(`[dry-run] Would set aligned: true in cases.json`);
            } else {
                event.aligned = true;
                writeJson(casesPath, cases);
                console.log(`Updated aligned: true in ${path.relative(REPO_ROOT, casesPath)}`);
            }
        }
    }

    return true;
}

// ── Apply speaker/text edits from a transcript-edits JSON file ─────────────

function _formatTimestamp(date) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        month: 'long', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const tzf = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', timeZoneName: 'short',
    });
    const parts = dtf.formatToParts(date);
    const tz    = tzf.formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? 'PT';
    const get = (t) => parts.find(p => p.type === t)?.value ?? '';
    return `${get('month')} ${get('day')}, ${get('year')} at ${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase()} ${tz}`;
}

async function applyEditsFromFile(filePath) {
    const absPath = path.resolve(filePath);
    if (!exists(absPath)) {
        console.error(`File not found: ${absPath}`);
        process.exit(1);
    }

    let edits;
    try { edits = readJson(absPath); } catch (e) {
        console.error(`Failed to parse JSON: ${e.message}`);
        process.exit(1);
    }
    if (!Array.isArray(edits)) {
        console.error('Expected a JSON array of case objects');
        process.exit(1);
    }

    const TERMS_DIR  = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');
    const INDEX_PATH = path.join(REPO_ROOT, 'courts', 'ussc', 'transcripts', 'updates', 'index.md');
    const timestamp  = _formatTimestamp(new Date());
    const logLines   = [];

    for (const caseEdit of edits) {
        const { title = '', term, events: eventEdits } = caseEdit;
        const caseRef = caseEdit.number || caseEdit.id || '';

        if (!term) {
            console.warn(`Skipping case with no "term": ${title}`);
            continue;
        }
        if (!Array.isArray(eventEdits) || !eventEdits.length) continue;

        // Load cases.json once per case (for event-index lookup).
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        let termCases = null;
        if (exists(casesPath)) {
            try { termCases = readJson(casesPath); } catch { /* leave null */ }
        }

        for (const eventEdit of eventEdits) {
            const { text_href, turns: turnEdits } = eventEdit;
            if (!text_href || !Array.isArray(turnEdits) || !turnEdits.length) continue;

            const transcriptPath = path.join(TERMS_DIR, term, 'cases', text_href);
            if (!exists(transcriptPath)) {
                console.warn(`Transcript not found: ${path.relative(REPO_ROOT, transcriptPath)}`);
                continue;
            }

            let transcript;
            try { transcript = readJson(transcriptPath); } catch (e) {
                console.warn(`Failed to parse transcript: ${e.message}`);
                continue;
            }

            // Support both envelope format ({ turns: [...] }) and flat array.
            const isEnvelope = !Array.isArray(transcript);
            const turns = isEnvelope ? (transcript.turns ?? []) : transcript;

            let changesApplied = 0;
            for (const edit of turnEdits) {
                const turnNum = edit.turn;
                // Find turn by its 1-based "turn" field (falling back to positional index+1).
                const t = turns.find((t, i) => (t.turn ?? (i + 1)) === turnNum);
                if (!t) {
                    console.warn(`  Turn ${turnNum} not found in ${text_href}`);
                    continue;
                }
                let changed = false;
                if (edit.name !== undefined && t.name !== edit.name) {
                    t.name = edit.name;
                    changed = true;
                }
                if (edit.text !== undefined && t.text !== edit.text) {
                    t.text = edit.text;
                    changed = true;
                }
                if (changed) { t.modified = true; changesApplied++; }
            }

            if (changesApplied === 0) {
                console.log(`No new changes in ${path.relative(REPO_ROOT, transcriptPath)}`);
                continue;
            }

            const transcriptJson = JSON.stringify(transcript, null, 2).replace(/[“”]/g, '\\"') + '\n';
            writeText(transcriptPath, transcriptJson);
            console.log(`Applied ${changesApplied} change(s) → ${path.relative(REPO_ROOT, transcriptPath)}`);

            // Find 1-based event index for the URL.
            let eventIdx = null;
            if (termCases) {
                const caseEntry = termCases.find(c =>
                    c.number === caseRef ||
                    c.id     === caseRef ||
                    (c.number && c.number.split(',').map(n => n.trim()).includes(caseRef))
                );
                if (caseEntry?.events) {
                    const idx = caseEntry.events.findIndex(e => e.text_href === text_href);
                    if (idx >= 0) eventIdx = idx + 1;
                }
            }

            // Build display title: strip decision year, append docket number.
            const bareTitle = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
            const displayTitle = caseRef ? `${bareTitle} (No. ${caseRef})` : bareTitle;
            const url = `/courts/ussc/?term=${term}&case=${caseRef}${eventIdx != null ? `&event=${eventIdx}` : ''}`;
            const noun = changesApplied === 1 ? 'correction' : 'corrections';
            logLines.push(`  - [${displayTitle}](${url}): ${changesApplied} ${noun} applied on ${timestamp}`);
        }
    }

    if (logLines.length === 0) {
        console.log('No new changes to record.');
        return;
    }

    // Append log lines to index.md.
    let md = exists(INDEX_PATH) ? readText(INDEX_PATH) : '';
    // Ensure single trailing newline before appending.
    if (!md.endsWith('\n')) md += '\n';
    md += logLines.join('\n') + '\n';
    writeText(INDEX_PATH, md);
    console.log(`\nRecorded ${logLines.length} update(s) in ${path.relative(REPO_ROOT, INDEX_PATH)}`);
}

async function main() {
    // ── Parse arguments ────────────────────────────────────────────────────
    const args = process.argv.slice(2);
    const flags = new Set(args.filter(a => a.startsWith('--')));
    const positional = args.filter(a => !a.startsWith('--'));

    const doRealign = flags.has('--realign');
    const doSplit   = flags.has('--split');
    const dryRun    = flags.has('--dry-run');
    const noVad     = flags.has('--no-vad');

    // --model MODEL
    let modelSize = 'base';
    const modelIdx = args.indexOf('--model');
    if (modelIdx !== -1 && args[modelIdx + 1] && !args[modelIdx + 1].startsWith('--')) {
        modelSize = args[modelIdx + 1];
    }

    // --beam-size N
    let beamSize = 5;
    const beamIdx = args.indexOf('--beam-size');
    if (beamIdx !== -1 && args[beamIdx + 1] && !args[beamIdx + 1].startsWith('--')) {
        beamSize = parseInt(args[beamIdx + 1], 10) || 5;
    }

    // ── JSON edits mode ────────────────────────────────────────────────────
    if (positional.length === 1 && positional[0].endsWith('.json')) {
        await applyEditsFromFile(positional[0]);
        return;
    }

    if (positional.length < 4) {
        console.error('Usage: node scripts/update_transcriptss.js TERM CASE SOURCE TYPE [--realign] [--split] [--model MODEL] [--beam-size N] [--dry-run]');
        console.error('       node scripts/update_transcriptss.js transcript-edits.json');
        process.exit(1);
    }

    const [term, caseNumber, source, type] = positional;

    // ── Locate cases.json ──────────────────────────────────────────────────
    const casesPath = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases.json');
    if (!exists(casesPath)) {
        console.error(`cases.json not found: ${casesPath}`);
        process.exit(1);
    }
    const cases = readJson(casesPath);

    const opts = { doRealign, doSplit, dryRun, noVad, modelSize, beamSize };

    if (caseNumber === '-') {
        // ── Batch mode ─────────────────────────────────────────────────────
        // Process every case in the term that has a matching SOURCE/TYPE event
        // with a text_href that is not yet aligned and not redundant, provided
        // no oyez event of the same type is already aligned for that case.
        const eligible = cases.filter(c => {
            const ev = (c.events || []).find(e => e.source === source && e.type === type);
            if (!ev || !ev.text_href || ev.redundant || ev.aligned || !ev.audio_href) return false;
            const hasAlignedOyez = (c.events || []).some(
                e => e.source === 'oyez' && e.type === type && e.aligned
            );
            return !hasAlignedOyez;
        });

        if (eligible.length === 0) {
            console.log(`No eligible cases found for ${source}/${type} in term ${term}.`);
            process.exit(0);
        }

        console.log(`Found ${eligible.length} eligible case(s) for ${source}/${type} in term ${term}.`);

        let processed = 0, failed = 0;
        for (const caseObj of eligible) {
            console.log(`\n── Case ${caseObj.number}: ${caseObj.title} ──`);
            const ok = await processCase(term, caseObj, source, type, cases, casesPath, opts);
            if (ok) processed++; else failed++;
        }

        console.log(`\nBatch complete: ${processed} processed, ${failed} failed.`);
    } else {
        // ── Single case mode ───────────────────────────────────────────────
        // Match by docket number (case.number) or by case id suffix.
        const caseObj = cases.find(c =>
            c.number === caseNumber ||
            (c.number && c.number.split(',').map(n => n.trim()).includes(caseNumber))
        );
        if (!caseObj) {
            console.error(`Case ${caseNumber} not found in ${term} cases.json`);
            process.exit(1);
        }

        const ok = await processCase(term, caseObj, source, type, cases, casesPath, opts);
        if (!ok) process.exit(1);
    }

    console.log('Done.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
