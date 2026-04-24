"""Canonical key ordering for cases.json case and event objects.

Import CASE_KEY_ORDER / EVENT_KEY_ORDER when constructing new objects, and
call reorder_case() / reorder_event() after building any dict that will be
written to a cases.json file, so the serialised JSON stays consistently ordered.

Unknown keys are appended at the end in their original relative order.
"""

# Canonical property order for a case object.
CASE_KEY_ORDER: list[str] = [
    'id', 'title', 'number', 'oyez', 'previouslyFiled',
    'questions', 'questions_href',
    'argument', 'reargument', 'decision',
    'volume', 'page', 'usCite', 'dateDecision',
    'voteMajority', 'voteMinority', 'votes',
    'events', 'opinion_href', 'opinion_href_bad', 'history_href', 'files',
]

# Canonical property order for an event object inside a case.
EVENT_KEY_ORDER: list[str] = [
    'source', 'type', 'date', 'title', 'time', 'timezone', 'location',
    'journal_href', 'audio_href', 'offset', 'transcript_href', 'text_href',
    'advocates', 'aligned', 'unique', 'note',
]


def reorder_case(case: dict) -> dict:
    """Return a copy of *case* with keys in CASE_KEY_ORDER; unknown keys appended."""
    known   = {k: case[k] for k in CASE_KEY_ORDER if k in case}
    unknown = {k: case[k] for k in case if k not in known}
    return {**known, **unknown}


def reorder_event(event: dict) -> dict:
    """Return a copy of *event* with keys in EVENT_KEY_ORDER; unknown keys appended."""
    known   = {k: event[k] for k in EVENT_KEY_ORDER if k in event}
    unknown = {k: event[k] for k in event if k not in known}
    return {**known, **unknown}
