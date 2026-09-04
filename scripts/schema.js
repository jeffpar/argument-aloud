/**
 * Canonical key ordering for cases.json case/event/advocate objects.
 *
 * Import CASE_KEY_ORDER / EVENT_KEY_ORDER / ADVOCATE_KEY_ORDER when constructing
 * new objects, and call reorderCase() / reorderEvent() / reorderAdvocate()
 * after building any object that will be written to a cases.json file, so the
 * serialised JSON stays consistently ordered.
 *
 * Unknown keys are appended at the end in their original relative order.
 *
 * © 2026 by Jeff Parsons
 */

// A case's `number` (and `argument_consolidation`) holds one or more docket
// numbers joined by ';'. A ',' is never a delimiter — it's a literal character
// within a single docket number (e.g. a thousands separator in some courts'
// numbering, such as WA Supreme Court's "200,262-5"). Always split docket
// fields with splitDockets(); take the case's canonical/primary docket with
// primaryDocket(); render a docket field for humans with formatDockets()
// (which joins with ", "). Mirrored verbatim in assets/js/explorer.js.
export function splitDockets(s) {
    return String(s == null ? '' : s).split(';').map(t => t.trim()).filter(Boolean);
}
export function primaryDocket(s) {
    return splitDockets(s)[0] || '';
}
export function formatDockets(s) {
    return splitDockets(s).join(', ');
}

export const CASE_KEY_ORDER = [
    'id', 'title', 'tags', 'number',
    'files', 'references', 'oyez_alt', 'previouslyFiled',
    'docket_url',
    // A case whose synopsis is written as "Facts: ... Question(s): ...
    // Conclusion: ..." (rather than a single free-form paragraph) splits
    // across these three instead of cramming it all into questions.
    'facts', 'questions', 'questions_url', 'conclusions',
    // Semicolon-separated docket number(s) of every case (this one included)
    // heard in the same argument session — distinct from a joint "number"
    // (one case filed under several dockets); this is for separately
    // tracked cases (their own id/title/decision) argued together. By
    // convention every case in the group carries the exact same value, e.g.
    // cases 880 and 1441 both carry "880;1441". Split with splitDockets().
    'argument_consolidation',
    'argument', 'argument_day', 'reargument', 'reargument_day', 'decision', 'decision_day',
    // Case-level fallback for the decision's own journal entry, for a case
    // with no decision-type event to hang a per-event journal_ref off of.
    'journal_ref',
    'citation', 'volume', 'page', 'cites',
    // oyez_url always sits right before the decision-document link group
    // (see _DECISION_LINK_KEYS) — including when that group relocates to
    // right after decision_day for a case with no citation yet.
    'oyez_url', 'decision_xml', 'decision_loc', 'decision_loc_bad', 'decision_gov', 'decision_gov_bad', 'decision_vol',
    'result',
    // The id (see processBenches in update_cases.js) of the Court composition
    // seated on this case's decision date — lets the case page's vote-score
    // link straight to that bench's page without walking benches.json.
    'bench',
    // "N-M" (majority-minority), e.g. "5-3" — replaces the old separate
    // voteMajority/voteMinority integer fields.
    'score', 'votes',
    'events', 'history_url', 'scdb_check', 'scdb_message',
    'note', 'audit_message',
];

export const EVENT_KEY_ORDER = [
    'source', 'type', 'date', 'title', 'time', 'timezone', 'location',
    // page_url is the human-facing source page (e.g. a TVW watch page) for
    // whichever of audio_url/video_url below is the actual playable file --
    // they're often on different hosts and page_url need not match either.
    'page_url',
    'audio_url', 'bad_audio_url',
    // video_url and audio_url are mutually exclusive for a given source: a
    // recording is one or the other, not both (video wins when both exist
    // upstream). hls_url is an adaptive-bitrate alternative to video_url,
    // when the source offers one, for players that prefer it.
    'video_url', 'hls_url',
    'length', 'size', 'bitrate', 'offset',
    // transcript_url is a document meant to be read (e.g. a PDF); captions_url
    // is a timed subtitle file (e.g. WebVTT) meant to be played back alongside
    // the media, not read on its own.
    'transcript_url', 'captions_url', 'text_file',
    'journal_ref', 'minutes_ref', 'minutes_url', 'minutes_src',
    'advocates', 'aligned', 'turn', 'redundant', 'unique', 'note', 'view'
];

export const ADVOCATE_KEY_ORDER = [
    'name', 'title', 'role',
];

export const VOTE_KEY_ORDER = [
    'name', 'side',
    // Base name of this justice's own opinion document (e.g. a concurrence or
    // dissent they authored/joined separately from the majority), when one
    // exists and is known — even if we don't have the actual file on hand.
    'file',
    'action', 'opinion', 'dissent',
];

export const CITES_KEY_ORDER = [
    'id', 'title', 'term', 'decision', 'count',
];

function _reorder(obj, order) {
    const out = {};
    for (const k of order) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    for (const k of Object.keys(obj)) {
        if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = obj[k];
    }
    return out;
}

const _DECISION_DOC_KEYS = ['decision_xml', 'decision_loc', 'decision_loc_bad', 'decision_gov', 'decision_gov_bad', 'decision_vol'];
// oyez_url travels with the decision-document link group so it always sits
// right before it, even when the group relocates (see below) — but its own
// near-universal presence must not itself be what triggers a relocation.
const _DECISION_LINK_KEYS = ['oyez_url', ..._DECISION_DOC_KEYS];

// When citation is absent, decision doc keys belong right after decision_day (or decision).
export function caseKeyOrder(obj) {
    if (!obj.citation && _DECISION_DOC_KEYS.some(k => k in obj)) {
        const order = CASE_KEY_ORDER.filter(k => !_DECISION_LINK_KEYS.includes(k));
        const anchorIdx = order.indexOf('decision_day');
        const insertAt = anchorIdx !== -1 ? anchorIdx + 1 : order.indexOf('decision') + 1;
        order.splice(insertAt, 0, ..._DECISION_LINK_KEYS);
        return order;
    }
    return CASE_KEY_ORDER;
}

export const reorderCase     = (obj) => _reorder(obj, caseKeyOrder(obj));
export const reorderEvent    = (obj) => _reorder(obj, EVENT_KEY_ORDER);
export const reorderAdvocate = (obj) => _reorder(obj, ADVOCATE_KEY_ORDER);
export const reorderVote     = (obj) => _reorder(obj, VOTE_KEY_ORDER);
export const reorderCites    = (obj) => _reorder(obj, CITES_KEY_ORDER);
