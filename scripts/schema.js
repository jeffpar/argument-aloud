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

export const CASE_KEY_ORDER = [
    'id', 'title', 'tags', 'number', 'files', 'backfill', 'oyez_href', 'oyez_alt', 'previouslyFiled',
    'docket_href', 'questions', 'questions_href',
    'argument', 'argument_days', 'reargument', 'reargument_days', 'decision', 'decision_days',
    'usCite', 'opCite',
    'decision_xml', 'decision_loc', 'decision_loc_bad', 'decision_ussc', 'decision_ussc_bad', 'decision_reports',
    'result', 'disposition',
    'voteMajority', 'voteMinority', 'votes',
    'events', 'history_href', 'scdb_check', 'scdb_message',
    'note',
];

export const EVENT_KEY_ORDER = [
    'source', 'type', 'date', 'title', 'time', 'timezone', 'location',
    'audio_href', 'bad_audio_href', 'video_href', 'length', 'size', 'bitrate', 'offset', 'transcript_href', 'text_href',
    'journal_ref',
    'advocates', 'aligned', 'turn', 'redundant', 'unique', 'note', 'view'
];

export const ADVOCATE_KEY_ORDER = [
    'name', 'title', 'role',
];

export const VOTE_KEY_ORDER = [
    'name', 'vote', 'action', 'opinion', 'dissent',
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

const _DECISION_HREF_KEYS = ['decision_xml', 'decision_loc', 'decision_loc_bad', 'decision_ussc', 'decision_ussc_bad', 'decision_reports'];

// When usCite is absent, decision href keys belong right after decision_days (or decision).
export function caseKeyOrder(obj) {
    if (!obj.usCite && _DECISION_HREF_KEYS.some(k => k in obj)) {
        const order = CASE_KEY_ORDER.filter(k => !_DECISION_HREF_KEYS.includes(k));
        const anchorIdx = order.indexOf('decision_days');
        const insertAt = anchorIdx !== -1 ? anchorIdx + 1 : order.indexOf('decision') + 1;
        order.splice(insertAt, 0, ..._DECISION_HREF_KEYS);
        return order;
    }
    return CASE_KEY_ORDER;
}

export const reorderCase     = (obj) => _reorder(obj, caseKeyOrder(obj));
export const reorderEvent    = (obj) => _reorder(obj, EVENT_KEY_ORDER);
export const reorderAdvocate = (obj) => _reorder(obj, ADVOCATE_KEY_ORDER);
export const reorderVote     = (obj) => _reorder(obj, VOTE_KEY_ORDER);
