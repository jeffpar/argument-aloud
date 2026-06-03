#!/usr/bin/env node
/**
 * update_transcript.js - Align transcript turns with audio using Whisper, and/or
 * split multi-sentence turns into individual turns.
 *
 * Usage:
 *   node scripts/update_transcript.js TERM CASE SOURCE TYPE [--realign] [--split] [--model MODEL]
 *
 * Arguments:
 *   TERM    Term in YYYY-MM format (e.g., 2014-10)
 *   CASE    Case number (e.g., 14-378)
 *   SOURCE  Event source: ussc | oyez | nara
 *   TYPE    Event type:   argument | opinion | reargument
 *
 * Options:
 *   --realign          Align even if time properties are already present
 *   --split            Split multi-sentence turns before aligning
 *   --model MODEL      Whisper model size (default: base; try small or medium for better accuracy)
 *   --beam-size N      Whisper beam size (default: 5; higher = slower but more accurate, e.g. 10)
 *   --dry-run          Print what would change without writing files
 *
 * Examples:
 *   node scripts/update_transcript.js 2014-10 14-378 ussc argument
 *   node scripts/update_transcript.js 2014-10 14-378 ussc argument --realign
 *   node scripts/update_transcript.js 2014-10 14-378 ussc argument --split
 *   node scripts/update_transcript.js 2014-10 14-378 ussc argument --split --realign
 *   node scripts/update_transcript.js 2014-10 14-378 oyez opinion --model small
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
import sys, json, os, math

def main():
    input_data = json.loads(sys.argv[1])
    audio_path = input_data['audio_path']
    turns = input_data['turns']
    model_size = input_data.get('model_size', 'base')
    offset_secs = float(input_data.get('offset_secs', 0))
    beam_size = int(input_data.get('beam_size', 5))

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("ERROR: faster_whisper not installed. Run: pip install faster-whisper")

    try:
        from rapidfuzz import fuzz
    except ImportError:
        sys.exit("ERROR: rapidfuzz not installed. Run: pip install rapidfuzz")

    # Use int8 on CPU for speed; upgrade to float16 on CUDA.
    model = WhisperModel(model_size, device='cpu', compute_type='int8')

    segments_gen, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=True,
        beam_size=beam_size,
    )
    segments = list(segments_gen)

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
        # No speech detected at all; return zero times.
        print(json.dumps([{'turn': t['turn'], 'time': 0.0} for t in turns]))
        return

    timestamps = []
    search_start = 0
    n_words = len(all_words)

    for turn in turns:
        text = turn['text']
        # Use up to 15 words for matching. The transcript may not exactly match
        # the audio (different phrasing, transcription errors), so token_set_ratio
        # is used: it handles extra/missing words and mild reordering gracefully.
        query_words = text.split()[:15]
        query = ' '.join(query_words).lower()
        n_q = len(query_words)

        best_score = -1
        best_pos = search_start

        # Search window: allow a small look-back (in case the previous match was
        # slightly ahead of the true start) and a generous look-ahead. The cap of
        # 300 words covers ~2 min of speech at typical speaking rates, which is
        # more than enough between consecutive turns.
        look_back = min(5, search_start)
        search_from = search_start - look_back
        search_end = min(n_words, search_start + 300)
        # If we're near the end, open the window fully.
        if search_end >= n_words - n_q:
            search_end = n_words

        for i in range(search_from, search_end):
            window = ' '.join(w['word'] for w in all_words[i:i + n_q]).lower()
            score = fuzz.token_set_ratio(query, window)
            if score > best_score:
                best_score = score
                best_pos = i
            if score >= 70:
                break   # good enough match found

        start_time = all_words[best_pos]['start']
        timestamps.append({'turn': turn['turn'], 'time': start_time})
        # Advance past the matched position. Use best_pos (not search_start) so
        # that a look-back hit doesn't cause the window to regress on the next turn.
        search_start = max(search_start, best_pos + max(n_q, 1))
        if search_start >= n_words:
            search_start = n_words - 1

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
        headers: { 'User-Agent': 'update_transcript/1.0' },
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
 * @param {object} opts        { modelSize, offsetSecs }
 * @returns {Array<{turn: number, time: number}>}
 */
function runAlignment(audioPath, turns, { modelSize = 'base', beamSize = 5, offsetSecs = 0 } = {}) {
    // Write the Python script to a temp file.
    const pyPath = path.join(os.tmpdir(), `update_transcript_align_${process.pid}.py`);
    writeText(pyPath, ALIGN_PY);

    const inputJson = JSON.stringify({
        audio_path: audioPath,
        turns: turns.map(t => ({ turn: t.turn, text: t.text })),
        model_size: modelSize,
        beam_size: beamSize,
        offset_secs: offsetSecs,
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

async function main() {
    // ── Parse arguments ────────────────────────────────────────────────────
    const args = process.argv.slice(2);
    const flags = new Set(args.filter(a => a.startsWith('--')));
    const positional = args.filter(a => !a.startsWith('--'));

    const doRealign = flags.has('--realign');
    const doSplit   = flags.has('--split');
    const dryRun    = flags.has('--dry-run');

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

    if (positional.length < 4) {
        console.error('Usage: node scripts/update_transcript.js TERM CASE SOURCE TYPE [--realign] [--split] [--model MODEL] [--beam-size N] [--dry-run]');
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

    // ── Find the case ──────────────────────────────────────────────────────
    // Match by docket number (case.number) or by case id suffix.
    const caseObj = cases.find(c =>
        c.number === caseNumber ||
        (c.number && c.number.split(',').map(n => n.trim()).includes(caseNumber))
    );
    if (!caseObj) {
        console.error(`Case ${caseNumber} not found in ${term} cases.json`);
        process.exit(1);
    }

    // ── Find the event ─────────────────────────────────────────────────────
    const event = (caseObj.events || []).find(
        e => e.source === source && e.type === type
    );
    if (!event) {
        console.error(`No ${source}/${type} event found for case ${caseNumber} in term ${term}`);
        process.exit(1);
    }
    if (!event.text_href) {
        console.error(`Event ${source}/${type} has no text_href`);
        process.exit(1);
    }
    if (!event.audio_href) {
        console.error(`Event ${source}/${type} has no audio_href`);
        process.exit(1);
    }

    // ── Load transcript ────────────────────────────────────────────────────
    const casesDir = path.join(REPO_ROOT, 'courts', 'ussc', 'terms', term, 'cases');
    const transcriptPath = path.join(casesDir, event.text_href);
    if (!exists(transcriptPath)) {
        console.error(`Transcript not found: ${transcriptPath}`);
        process.exit(1);
    }
    const transcript = readJson(transcriptPath);
    const turns = transcript.turns || [];

    // ── Check alignment status ─────────────────────────────────────────────
    const isAligned = turns.some(t => t.time !== undefined);
    if (isAligned && !doRealign && !doSplit) {
        console.log(`Transcript is already aligned. Use --realign to overwrite.`);
        process.exit(0);
    }

    // If only --split (no realign, already aligned), we can still split.
    const needsAlign = !isAligned || doRealign;

    // ── Sentence splitting ─────────────────────────────────────────────────
    let workingTurns = turns;
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
        const audioPath = path.join(os.tmpdir(), `update_transcript_audio_${process.pid}${audioExt}`);

        console.log(`Downloading audio: ${event.audio_href}`);
        try {
            await downloadFile(event.audio_href, audioPath);
        } catch (err) {
            console.error(`Failed to download audio: ${err.message}`);
            process.exit(1);
        }
        console.log(`Audio saved to: ${audioPath}`);

        const offsetSecs = event.offset || 0;
        console.log(`Running Whisper alignment (model=${modelSize}, beam_size=${beamSize})…`);

        let alignedTimes;
        try {
            alignedTimes = runAlignment(audioPath, workingTurns, { modelSize, beamSize, offsetSecs });
        } finally {
            try { fs.unlinkSync(audioPath); } catch {}
        }

        // Build a lookup by turn number.
        const timeByTurn = new Map(alignedTimes.map(r => [r.turn, r.time]));

        // Apply timestamps to turns.
        workingTurns = workingTurns.map(t => {
            const secs = timeByTurn.get(t.turn);
            if (secs !== undefined) {
                return { ...t, time: formatTime(secs) };
            }
            return t;
        });

        console.log(`Aligned ${alignedTimes.length} turns.`);
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
        const allAligned = workingTurns.every(t => t.time !== undefined);
        if (allAligned && !event.aligned) {
            if (dryRun) {
                console.log('[dry-run] Would set aligned: true in cases.json');
            } else {
                event.aligned = true;
                writeJson(casesPath, cases);
                console.log(`Updated aligned: true in ${path.relative(REPO_ROOT, casesPath)}`);
            }
        }
    }

    console.log('Done.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
