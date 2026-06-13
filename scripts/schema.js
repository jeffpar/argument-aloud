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
    'id', 'title', 'tags', 'number', 'files', 'oyez_href', 'oyez_alt', 'previouslyFiled',
    'questions', 'questions_href',
    'argument', 'argument_days', 'reargument', 'reargument_days', 'decision', 'decision_days',
    'volume', 'page', 'usCite', 'opinion_href', 'opinion_href_bad', 'result', 'disposition',
    'voteMajority', 'voteMinority', 'votes',
    'events', 'history_href', 'scdb_errors',
    'notes',
];

export const EVENT_KEY_ORDER = [
    'source', 'type', 'date', 'title', 'time', 'timezone', 'location',
    'audio_href', 'audio_href_bad', 'bad_audio_href', 'video_href', 'length', 'size', 'bitrate', 'offset', 'transcript_href', 'text_href',
    'journal_ref',
    'advocates', 'aligned', 'turn', 'redundant', 'unique', 'note', 'view',
    'notes',
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

// When usCite is absent, opinion_href/opinion_href_bad belong right after decision.
export function caseKeyOrder(obj) {
    if (!obj.usCite && ('opinion_href' in obj || 'opinion_href_bad' in obj)) {
        const order = CASE_KEY_ORDER.filter(k => k !== 'opinion_href' && k !== 'opinion_href_bad');
        const decIdx = order.indexOf('decision');
        order.splice(decIdx + 1, 0, 'opinion_href', 'opinion_href_bad');
        return order;
    }
    return CASE_KEY_ORDER;
}

export const reorderCase     = (obj) => _reorder(obj, caseKeyOrder(obj));
export const reorderEvent    = (obj) => _reorder(obj, EVENT_KEY_ORDER);
export const reorderAdvocate = (obj) => _reorder(obj, ADVOCATE_KEY_ORDER);
export const reorderVote     = (obj) => _reorder(obj, VOTE_KEY_ORDER);
