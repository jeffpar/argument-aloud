/**
 * Canonical key ordering for cases.json case/event/advocate objects.
 *
 * Import CASE_KEY_ORDER / EVENT_KEY_ORDER / ADVOCATE_KEY_ORDER when constructing
 * new objects, and call reorderCase() / reorderEvent() / reorderAdvocate()
 * after building any object that will be written to a cases.json file, so the
 * serialised JSON stays consistently ordered.
 *
 * Unknown keys are appended at the end in their original relative order.
 */

export const CASE_KEY_ORDER = [
    'id', 'title', 'number', 'oyez_href', 'otd_href', 'oyez_alt', 'previouslyFiled',
    'questions', 'questions_href',
    'argument', 'reargument', 'decision',
    'volume', 'page', 'usCite', 'dateDecision',
    'voteMajority', 'voteMinority', 'votes',
    'events', 'opinion_href', 'opinion_href_bad', 'history_href', 'files',
    'notes',
];

export const EVENT_KEY_ORDER = [
    'source', 'type', 'date', 'title', 'time', 'timezone', 'location',
    'audio_href', 'offset', 'transcript_href', 'text_href',
    'journal_ref',
    'advocates', 'aligned', 'turn', 'redundant', 'unique', 'note', 'view',
    'notes',
];

export const ADVOCATE_KEY_ORDER = [
    'name', 'title', 'role',
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

export const reorderCase     = (obj) => _reorder(obj, CASE_KEY_ORDER);
export const reorderEvent    = (obj) => _reorder(obj, EVENT_KEY_ORDER);
export const reorderAdvocate = (obj) => _reorder(obj, ADVOCATE_KEY_ORDER);
