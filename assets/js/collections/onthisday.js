// Fallback page for action=onthisday (see _onThisDayThenRestore /
// _showOnThisDayNotFound in explorer.js) when no case can be found argued or
// decided on the requested month+day — either the day has no recorded cases
// at all, or (for seed=noteworthy) none of them are in the curated
// Noteworthy topic set. ?date=YYYY-MM-DD carries through whatever date the
// visitor actually asked for; defaults to today (UTC) if absent, matching
// _onThisDayThenRestore's own default.
(function () {
  'use strict';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

  var dateParam = new URLSearchParams(location.search).get('date');
  var month, day;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam || '')) {
    var parts = dateParam.split('-');
    month = MONTHS[parseInt(parts[1], 10) - 1];
    day = parseInt(parts[2], 10);
  } else {
    var today = new Date();
    month = MONTHS[today.getUTCMonth()];
    day = today.getUTCDate();
  }

  var msgEl = document.getElementById('onthisday-message');
  if (msgEl) {
    msgEl.textContent = "We're sorry, but we are unable to find a case that was argued or decided on " + month + ' ' + day + '.';
  }
}());
