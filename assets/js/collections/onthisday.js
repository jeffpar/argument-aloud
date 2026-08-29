// Backs courts/ussc/collections/historical/onthisday/index.md — the "On
// This Day" landing page. Three jobs:
//
// 1. Apology message for a failed action=onthisday redirect (see
//    _showOnThisDayNotFound in explorer.js) when no case can be found
//    argued or decided on the requested month+day — either the day has no
//    recorded cases at all, or (for seed=noteworthy) none of them are in
//    the curated Noteworthy topic set. Only shown when the URL carries the
//    explicit notfound=1 flag that redirect sets — a bare visit to this
//    page (e.g. from the home page card) gets no apology.
//
// 2. Year/Month/Day + "Argued only" controls. A specific year searches that
//    one exact date (unlike action=onthisday's any-year month+day search).
//    "Any" instead first figures out every year for which the chosen
//    month+day actually has a qualifying case — via the same onthisday.json
//    index action=onthisday itself uses (see explorer.js's
//    _fetchOnThisDayIndex/_onThisDayThenRestore) — then picks one of those
//    years at random, so a miss is only reported when truly no year
//    qualifies, never as a side effect of an unlucky random guess.
//
// 3. Keeps the controls' own pending selection (not yet a Go click, just
//    what's showing) mirrored in the *top-level* window's own address bar
//    as a "date" query param riding alongside its "link" one (both plain
//    top-level siblings — link=<this page's bare path>&date=... — restored
//    by explorer.js's restoreFromURL, which forwards "date" back onto this
//    page's own query the same way it already does for sort/s/order/view;
//    see also _showOnThisDayNotFound) — "YYYY-MM-DD" for a specific year,
//    "MM-DD" when Year is "Any" — so the page loads with one even when none
//    was given, and every control change pushes a new top-level history
//    entry with the updated value. That's what makes a specific pending
//    selection bookmarkable/shareable — and, since a colored calendar day
//    or a specific-year Go click also replaces that same entry to be fully
//    up to date right before navigating away to a case, what makes Back
//    from that case return to the exact date last acted on, not a stale
//    one. A Year-"Any" Go click deliberately leaves the entry alone even
//    though it resolves to one specific year internally — that year was a
//    random pick, not a selection, so the address bar keeps reading
//    "MM-DD" rather than claiming a year the visitor never chose. Only the
//    top-level history is ever touched (never this iframe's own), so a
//    plain control change never causes a reload; Back/Forward instead
//    always cold-loads this page fresh from the new "date" it restores —
//    same as every other pane page in this SPA.
(function () {
  'use strict';
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Days in `month` (1-12) of `year`, leap-year aware.
  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  // Parses a "date" URL param into { year, month, day } — year is 'any' for
  // a bare "MM-DD" value (or when absent/malformed, alongside defaulting
  // month/day to today, UTC), or a number for a full "YYYY-MM-DD" value.
  function parseDateParam(dateStr) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) {
      var full = dateStr.split('-');
      return { year: parseInt(full[0], 10), month: parseInt(full[1], 10), day: parseInt(full[2], 10) };
    }
    if (/^\d{2}-\d{2}$/.test(dateStr || '')) {
      var mmdd = dateStr.split('-');
      return { year: 'any', month: parseInt(mmdd[0], 10), day: parseInt(mmdd[1], 10) };
    }
    var now = new Date();
    return { year: 'any', month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  }

  var params = new URLSearchParams(location.search);
  var dateParam = params.get('date');
  var hadValidDateParam = /^\d{4}-\d{2}-\d{2}$/.test(dateParam || '') || /^\d{2}-\d{2}$/.test(dateParam || '');
  var initDate = parseDateParam(dateParam);

  // ── Apology message (redirected here via action=onthisday) ──────────────
  var msgEl = document.getElementById('onthisday-message');
  if (params.get('notfound') === '1' && msgEl) {
    msgEl.textContent = "We're sorry, but we are unable to find a case that was argued or decided on "
      + MONTHS[initDate.month - 1] + ' ' + initDate.day + '. Try picking a specific date below instead.';
  }

  // ── Controls ──────────────────────────────────────────────────────────
  var yearSel   = document.getElementById('otd-year');
  var monthSel  = document.getElementById('otd-month');
  var daySel    = document.getElementById('otd-day');
  var arguedChk = document.getElementById('otd-argued');
  var goBtn     = document.getElementById('otd-go');
  var resultEl  = document.getElementById('otd-result');
  var calSection = document.getElementById('otd-calendar-section');
  var calContainer = document.getElementById('otd-calendar');
  var calPrevLink = document.getElementById('otd-cal-prev');
  var calNextLink = document.getElementById('otd-cal-next');
  var calTitleLink = document.getElementById('otd-cal-title');
  if (!yearSel || !monthSel || !daySel || !arguedChk || !goBtn || !resultEl
    || !calSection || !calContainer || !calPrevLink || !calNextLink || !calTitleLink) return;

  MONTHS.forEach(function (name, i) {
    var opt = document.createElement('option');
    opt.value = String(i + 1);
    opt.textContent = name;
    if (i + 1 === initDate.month) opt.selected = true;
    monthSel.appendChild(opt);
  });

  // Day options assume a leap year (so Feb always offers up to 29) — the
  // actual chosen year's own max is enforced at Go-click time instead.
  function populateDays(month, preferredDay) {
    var maxDay = daysInMonth(2024, month);
    var keepDay = Math.min(preferredDay || initDate.day, maxDay);
    daySel.innerHTML = '';
    for (var d = 1; d <= maxDay; d++) {
      var opt = document.createElement('option');
      opt.value = String(d);
      opt.textContent = String(d);
      if (d === keepDay) opt.selected = true;
      daySel.appendChild(opt);
    }
  }
  populateDays(initDate.month, initDate.day);

  function showResult(text) {
    resultEl.textContent = text;
    resultEl.hidden = !text;
  }

  // Builds this page's own path+query for the controls' current selection
  // ("YYYY-MM-DD" for a specific year, "MM-DD" for "Any") and pushes (or
  // replaces, for the initial page-load fill) it into the *top-level*
  // window's own "link" param — see the file-header comment above for why
  // that (not this iframe's own history) is what needs updating. A no-op
  // when run standalone (pane.html always redirects into the iframe first,
  // so window.parent should never actually equal window here in practice).
  function syncUrlDate(push) {
    if (window.parent === window) return;
    var month = pad2(parseInt(monthSel.value, 10));
    var day = pad2(parseInt(daySel.value, 10));
    var value = yearSel.value === 'any' ? (month + '-' + day) : (yearSel.value + '-' + month + '-' + day);
    var parentUrl = new URL(window.parent.location.href);
    parentUrl.search = '';
    // link= stays the bare path — date rides alongside it as a plain
    // top-level sibling (restoreFromURL forwards it back onto this page's
    // own query when reloading — see explorer.js) rather than URL-encoded
    // inside link='s own value, so the address bar reads .../onthisday/
    // &date=... instead of .../onthisday%2F%3Fdate%3D....
    parentUrl.searchParams.set('link', location.pathname);
    parentUrl.searchParams.set('date', value);
    parentUrl.search = parentUrl.search.replace(/%2F/gi, '/');
    if (push) window.parent.history.pushState(null, '', parentUrl);
    else window.parent.history.replaceState(null, '', parentUrl);
  }

  // Page loaded with no (or malformed) "date" param of its own — give it
  // the one implied by the controls' own defaults, without adding a history
  // entry (a real param is left as-is; it's already bookmarkable).
  if (!hadValidDateParam) syncUrlDate(false);

  // Reassigned below, once terms.json resolves and termForDate/fetchTermCases
  // (which the calendar needs) exist — a no-op until then, since Year stays
  // disabled (so a specific year, the only thing that shows the calendar,
  // can't be picked yet) and the controls' own listeners are wired up front.
  var refreshCalendar = function () {};

  monthSel.addEventListener('change', function () {
    populateDays(parseInt(monthSel.value, 10), parseInt(daySel.value, 10));
    syncUrlDate(true);
    refreshCalendar();
  });
  daySel.addEventListener('change', function () { syncUrlDate(true); refreshCalendar(); });
  yearSel.addEventListener('change', function () { syncUrlDate(true); refreshCalendar(); });
  // Not part of the URL's "date" param — just re-colors/re-wires the
  // calendar (see buildCalendarMonth) to match the new Argued-only filter.
  arguedChk.addEventListener('change', function () { refreshCalendar(); });

  // terms.json stores decades/terms oldest-first (each decade's own groups
  // are too) — already chronological order, same convention terms.js relies
  // on for its own prev/next lookup, so no reversal needed here.
  fetch('/courts/ussc/terms/terms.json')
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (decades) {
      var flat = [];
      (decades || []).forEach(function (d) {
        (d.groups || []).forEach(function (g) {
          var m = g.file && /\/terms\/([^/]+)\//.exec(g.file);
          if (m) flat.push(m[1]);
        });
      });
      return flat;
    })
    .catch(function () { return []; })
    .then(function (termIds) {
      if (!termIds.length) {
        showResult("We're sorry, we couldn't load the Court's term data — please try again later.");
        return;
      }

      var firstYear = parseInt(termIds[0].slice(0, 4), 10);
      var lastYear = Math.max(parseInt(termIds[termIds.length - 1].slice(0, 4), 10), new Date().getUTCFullYear());

      var anyOpt = document.createElement('option');
      anyOpt.value = 'any';
      anyOpt.textContent = 'Any';
      anyOpt.selected = true;
      yearSel.innerHTML = '';
      yearSel.appendChild(anyOpt);
      for (var y = lastYear; y >= firstYear; y--) {
        var opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        yearSel.appendChild(opt);
      }
      // A specific-year date param (from the URL, or restored via Back/
      // Forward before this fetch resolved — unlikely, but cheap to cover)
      // couldn't be applied to Year until its own options existed.
      if (initDate.year !== 'any' && yearSel.querySelector('option[value="' + initDate.year + '"]')) {
        yearSel.value = String(initDate.year);
      }
      yearSel.disabled = false;
      goBtn.disabled = false;

      // Last chronological term whose own start ("YYYY-MM-01") is on or
      // before dateStr — same-length zero-padded strings compare correctly
      // as dates, so a plain lexical scan suffices.
      function termForDate(dateStr) {
        var found = termIds[0];
        for (var i = 0; i < termIds.length; i++) {
          if (termIds[i] + '-01' <= dateStr) found = termIds[i]; else break;
        }
        return found;
      }

      // Mirrors explorer.js's _caseUrlId: prefer a docket number when it's
      // unique across the term, else fall back to the case's own id.
      function caseUrlId(caseEntry, allCases) {
        if (caseEntry.number) {
          var firstNum = caseEntry.number.split(',')[0].trim();
          var uniqueCount = allCases.filter(function (c) {
            return c.number && c.number.split(',')[0].trim() === firstNum;
          }).length;
          if (uniqueCount === 1) return firstNum;
        }
        return caseEntry.id || (caseEntry.number ? caseEntry.number.split(',')[0].trim() : '');
      }

      function dateMatches(raw, dateStr) {
        if (!raw) return false;
        return raw.split(',').map(function (s) { return s.trim(); }).indexOf(dateStr) !== -1;
      }

      // ── Court Cases table (selected day) ────────────────────────────────
      // Mirrors terms.js's own Court Cases table (courts/ussc/terms/
      // index.md's #case-listing-heading/#case-listing-table markup, reused
      // verbatim here — see the matching elements in this page's own
      // index.md) — duplicated rather than shared since this script runs on
      // its own page, not alongside terms.js (same reasoning as caseUrlId
      // above). Kept in sync by hand.
      var MONTHS_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

      function dayOf(iso) {
        var p = iso.split('-');
        return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDate();
      }

      // "2000-11-28" -> "Nov 28, 2000"
      function fmtMonthDayYear(iso) {
        var p = iso.split('-');
        var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
        if (isNaN(d)) return iso;
        return MONTHS_ABBR[+p[1] - 1] + ' ' + d.getUTCDate() + ', ' + p[0];
      }

      function caseDisplayTitle(c) {
        return (c.title || c.number || c.id || '(unknown)').split(';')[0].trim();
      }

      // Formats a case's docket number(s) as a parenthesized " (No. 12-345)" /
      // " (Nos. 12-345, 12-346)" annotation, ready to append straight onto a
      // title string — mirrors terms.js's own caseNumberAnnotation, which in
      // turn mirrors explorer.js's caseTitleLabel (kept in sync by hand; no
      // shared module between the three runtimes). Four or more numbers
      // collapse `text` to "first, …, last"; `full` then carries the
      // untruncated annotation for use as a tooltip, else null. Returns null
      // (no annotation at all) when the case has no docket number.
      function caseNumberAnnotation(number) {
        if (!number) return null;
        var numbers = number.split(',').map(function (n) { return n.trim(); });
        var label = numbers.length > 1 ? 'Nos.' : 'No.';
        function fmt(ns) { return ns.join(', ').replace(/-(?=Orig|Misc)/g, ' '); }
        var shown = numbers.length >= 4 ? [numbers[0], '…', numbers[numbers.length - 1]] : numbers;
        var text = ' (' + label + ' ' + fmt(shown) + ')';
        var full = numbers.length >= 4 ? ' (' + label + ' ' + fmt(numbers) + ')' : null;
        return { text: text, full: full };
      }

      // "531 U.S. 57" -> a number that sorts citations chronologically (by
      // volume, then page) rather than alphabetically.
      function opinionSortKey(citation) {
        var m = /^(\d+)\s+U\.S\.\s+(\d+)$/.exec(citation || '');
        return m ? parseInt(m[1], 10) * 100000 + parseInt(m[2], 10) : null;
      }

      // Undecided/missing values (null) always sort last, regardless of
      // direction.
      function compareRows(a, b, key, asc) {
        var av = a.sortValues[key], bv = b.sortValues[key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        var cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return asc ? cmp : -cmp;
      }

      // Same postMessage-when-framed / direct-navigate-when-standalone
      // pattern as this file's own goTo (see the Go button handler below),
      // but as a plain <a> click handler for the case-listing table's links,
      // which — unlike a Go/day-cell pick — should feel like following a
      // link (no history entry of its own to leave behind) rather than
      // committing to leave the page.
      function wireSearchLink(a, search) {
        var target = '/courts/ussc/' + search;
        a.href = target;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          if (window.parent !== window) {
            window.parent.postMessage({ type: 'ussc-navigate', search: search }, location.origin);
          } else {
            location.href = target;
          }
        });
      }

      function _openInNewTab(href) {
        var w = window.open(href, '_blank');
        if (w) w.opener = null;
      }

      function wireDocLink(a, href, title) {
        a.href = href;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          if (window.parent !== window) {
            window.parent.postMessage({ type: 'ussc-open-doc', href: href, title: title }, location.origin);
          } else {
            _openInNewTab(href);
          }
        });
      }

      // Renders one or more ISO dates into a table cell, linked to the
      // earliest date shown — see terms.js's own renderDateCell, which this
      // mirrors exactly.
      function renderDateCell(td, term, isoDates) {
        if (!isoDates.length) { td.textContent = '—'; return; }
        var sorted = isoDates.slice().sort();
        var months = new Set(sorted.map(function (d) { return d.slice(0, 7); }));
        var a = document.createElement('a');
        if (months.size > 1) {
          a.textContent = '…';
        } else if (sorted.length > 1) {
          var p = sorted[0].split('-');
          a.textContent = MONTHS_ABBR[+p[1] - 1] + ' ' + dayOf(sorted[0]) + '-' + dayOf(sorted[sorted.length - 1]) + ', ' + p[0];
        } else {
          a.textContent = fmtMonthDayYear(sorted[0]);
        }
        wireSearchLink(a, '?term=' + encodeURIComponent(term) + '&date=' + encodeURIComponent(sorted[0]));
        td.appendChild(a);
      }

      function dateTokens(fieldVal) {
        if (!fieldVal) return [];
        return fieldVal.split(',').map(function (d) { return d.trim(); }).filter(Boolean);
      }

      // Builds one Case Listing row from a full case record — see terms.js's
      // own buildCaseRow, which this mirrors (minus the cross-term
      // argIsoOverride param, not needed here: every case shown already
      // belongs to `term`, the term the selected day itself falls in).
      function buildCaseRow(c, term, allCases) {
        var argIso = Array.from(new Set(dateTokens(c.argument).concat(dateTokens(c.reargument))));
        var decIso = dateTokens(c.decision);
        var scoreM = /^(\d+)-(\d+)$/.exec(c.score || '');
        var voteM = scoreM ? parseInt(scoreM[1], 10) : null;
        var opinionText = c.citation || '';
        var decDates = decIso.slice().sort();
        return {
          title: caseDisplayTitle(c),
          number: c.number || '',
          caseId: caseUrlId(c, allCases),
          caseTerm: term,
          argTerm: term,
          argIso: argIso,
          decIso: decIso,
          voteText: c.score || '',
          opinionText: opinionText,
          decisionHref: opinionText ? (c.decision_loc || c.decision_gov || c.decision_vol || '') : '',
          decisionTitle: 'Decision' + (decDates.length ? ' on ' + fmtMonthDayYear(decDates[0]) : '')
            + (opinionText ? ' (' + opinionText + ')' : ''),
          sortValues: {
            title: caseDisplayTitle(c).toLowerCase(),
            argued: argIso.slice().sort()[0] || null,
            decided: decDates[0] || null,
            vote: (voteM != null) ? voteM : null,
            opinion: opinionSortKey(opinionText),
          },
        };
      }

      function buildCaseListingRow(row) {
        var tr = document.createElement('tr');

        var tdTitle = document.createElement('td');
        var aTitle = document.createElement('a');
        var numAnno = caseNumberAnnotation(row.number);
        aTitle.textContent = row.title + (numAnno ? numAnno.text : '');
        if (numAnno && numAnno.full) aTitle.title = row.title + numAnno.full;
        wireSearchLink(aTitle, '?term=' + encodeURIComponent(row.caseTerm) + '&case=' + encodeURIComponent(row.caseId));
        tdTitle.appendChild(aTitle);
        tr.appendChild(tdTitle);

        var tdArgued = document.createElement('td');
        tdArgued.className = 'col-date';
        renderDateCell(tdArgued, row.argTerm, row.argIso);
        tr.appendChild(tdArgued);

        var tdDecided = document.createElement('td');
        tdDecided.className = 'col-date';
        renderDateCell(tdDecided, row.caseTerm, row.decIso);
        tr.appendChild(tdDecided);

        var tdVote = document.createElement('td');
        tdVote.className = 'col-vote';
        tdVote.textContent = row.voteText || '—';
        tr.appendChild(tdVote);

        var tdOpinion = document.createElement('td');
        tdOpinion.className = 'col-opinion';
        if (row.opinionText && row.decisionHref) {
          var aOp = document.createElement('a');
          aOp.textContent = row.opinionText;
          wireDocLink(aOp, row.decisionHref, row.decisionTitle);
          tdOpinion.appendChild(aOp);
        } else {
          tdOpinion.textContent = row.opinionText || '—';
        }
        tr.appendChild(tdOpinion);

        return tr;
      }

      // Persistent sort state across repeated redraws (a new day/month/year
      // pick redraws in place — see refreshCalendar below) — same pattern as
      // terms.js's own _caseListingSort.
      var caseListingSort = { key: 'title', asc: true };
      var caseListingSortWired = false;
      var clHeading = document.getElementById('case-listing-heading');
      var clTable   = document.getElementById('case-listing-table');
      var clTbody   = document.getElementById('case-listing-tbody');

      // Shows (or hides, if `rows` is empty/null) the Court Cases table for
      // the currently selected day's own argued-or-decided cases — always
      // both, regardless of the "Argued only" checkbox, which only ever
      // scopes the calendar's own day coloring/click targets.
      function drawCaseListing(rows) {
        if (!clHeading || !clTable || !clTbody) return;
        if (!rows || !rows.length) { clHeading.hidden = true; clTable.hidden = true; return; }
        clHeading.hidden = false;
        clTable.hidden = false;
        var sorted = rows.slice().sort(function (a, b) { return compareRows(a, b, caseListingSort.key, caseListingSort.asc); });
        clTbody.innerHTML = '';
        sorted.forEach(function (row) { clTbody.appendChild(buildCaseListingRow(row)); });
        clTable.querySelectorAll('th[data-sort-key]').forEach(function (th) {
          var active = th.dataset.sortKey === caseListingSort.key;
          th.setAttribute('aria-sort', active ? (caseListingSort.asc ? 'ascending' : 'descending') : 'none');
        });
        if (!caseListingSortWired) {
          caseListingSortWired = true;
          clTable.querySelectorAll('th[data-sort-key]').forEach(function (th) {
            th.querySelector('button').addEventListener('click', function () {
              var key = th.dataset.sortKey;
              if (caseListingSort.key === key) caseListingSort.asc = !caseListingSort.asc;
              else { caseListingSort.key = key; caseListingSort.asc = true; }
              drawCaseListing(rows);
            });
          });
        }
      }

      // ── NARA recordings (selected day) ──────────────────────────────────
      // Mirrors the per-date entries collection.html renders for
      // sources/nara/audio/{red,gold,black}/index.md (each backed by one of
      // NARA_COLLECTION_IDS' own data/nara/ussc/<id>.json — see that
      // include), scoped here to just the selected day instead of a whole
      // series. Duplicated rather than shared since collection.html is a
      // Liquid include (server-side), not JS this page could call into.
      // Ids (and their sources/nara/audio/<slug>/ page — see the date-link
      // built in drawNaraList below): 77820785/black (Oct 1955 – Dec 1972),
      // 105447/red (Dec 1972 – Jun 2005), 175704063/gold (Oct 2005 –
      // present).
      var NARA_COLLECTIONS = [
        { id: '77820785',  slug: 'black' },
        { id: '105447',    slug: 'red' },
        { id: '175704063', slug: 'gold' },
      ];
      // NARA's own audio collections don't begin until October 1955 — skip
      // ever fetching ~3.5MB of JSON for a selection that predates all three.
      var NARA_FIRST_YEAR = 1955;
      var naraDataPromise = null;
      function fetchNaraData() {
        if (!naraDataPromise) {
          naraDataPromise = Promise.all(NARA_COLLECTIONS.map(function (coll) {
            return fetch('/data/nara/ussc/' + coll.id + '.json')
              .then(function (r) { return r.ok ? r.json() : []; })
              .then(function (list) { return Array.isArray(list) ? list : []; })
              .catch(function () { return []; })
              // Tags each object with its own series slug, needed by
              // drawNaraList's own date link (a date's matches only ever
              // come from one series, but this way it never has to guess).
              .then(function (list) { return list.map(function (o) { o._naraSlug = coll.slug; return o; }); });
          })).then(function (lists) { return [].concat.apply([], lists); });
        }
        return naraDataPromise;
      }

      var naraHeading       = document.getElementById('nara-heading');
      var naraEventsSection = document.getElementById('nara-events-section');
      var naraEventsList    = document.getElementById('nara-events-list');
      var naraAudioSection  = document.getElementById('nara-audio-section');
      var naraAudioList     = document.getElementById('nara-audio-list');
      // audio -> its own toggle span, so the shared 'play' listener below can
      // reset any other still-playing icon back to ▶️ — same as
      // collection.html's own audio.nextElementSibling lookup, just an
      // explicit map since this list is rebuilt (old elements discarded)
      // every time a new day is picked.
      var naraAudioSpans = new Map();

      function toggleNaraAudio(audio, span, src, errorMsg) {
        if (!audio.src) audio.src = src;
        if (audio.paused) { errorMsg.hidden = true; audio.play(); span.textContent = '⏸'; }
        else { audio.pause(); span.textContent = '▶️'; span.blur(); }
      }
      document.addEventListener('play', function (e) {
        naraAudioSpans.forEach(function (span, audio) {
          if (audio !== e.target && audio.duration > 0 && !audio.paused) {
            audio.pause();
            span.textContent = '▶️';
          }
        });
      }, true);

      var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      // "2013-02-25" -> "Monday February 25, 2013" (no comma after the
      // weekday) — just this heading's own format, distinct from fmtDate
      // elsewhere in this codebase.
      function fmtFullDate(iso) {
        var p = iso.split('-');
        var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
        if (isNaN(d)) return iso;
        return WEEKDAYS[d.getUTCDay()] + ' ' + MONTHS[+p[1] - 1] + ' ' + d.getUTCDate() + ', ' + p[0];
      }

      // Shows (or hides, if `objects` is empty/null) the NARA Holdings list
      // for the currently selected day's own matching sessions — two flat
      // sub-lists, Events then Audio Files (each pooling every matching
      // session's own entries, in the data's own order) rather than
      // collection.html's own per-session nested list, since every entry
      // shown here already belongs to the one selected day.
      function drawNaraList(objects, iso) {
        if (!naraHeading || !naraEventsSection || !naraEventsList || !naraAudioSection || !naraAudioList) return;
        naraAudioSpans.clear();
        naraEventsList.innerHTML = '';
        naraAudioList.innerHTML = '';
        if (!objects || !objects.length) {
          naraHeading.hidden = true;
          naraEventsSection.hidden = true;
          naraAudioSection.hidden = true;
          return;
        }
        naraHeading.hidden = false;

        // All of a single day's matches always come from the same series
        // (the three collections' own date ranges don't overlap) — the
        // first match's own _naraSlug (see fetchNaraData) is enough.
        var target = '/courts/ussc/?link=' + encodeURIComponent('/sources/nara/audio/' + objects[0]._naraSlug) + '#' + iso;
        naraHeading.textContent = '';
        var headingLink = document.createElement('a');
        headingLink.textContent = 'NARA Holdings for ' + fmtFullDate(iso);
        headingLink.href = target;
        // Real top-level navigation (not the SPA's in-place "ussc-navigate"
        // message, which only ever forwards a plain search string, never a
        // #hash) — same postMessage-when-framed / direct-navigate-when-
        // standalone split as this file's own goTo.
        headingLink.addEventListener('click', function (e) {
          e.preventDefault();
          if (window.parent !== window) window.parent.location.href = target;
          else window.location.href = target;
        });
        naraHeading.appendChild(headingLink);

        var hasEvents = false, hasAudio = false;
        objects.forEach(function (obj) {
          (obj.events || []).forEach(function (ev) {
            hasEvents = true;
            var evLi = document.createElement('li');
            evLi.textContent = ev;
            naraEventsList.appendChild(evLi);
          });
          (obj.destinations || []).forEach(function (dest, i) {
            var src = obj.sources && obj.sources[i];
            if (!src) return;
            hasAudio = true;
            var srcLi = document.createElement('li');
            var a = document.createElement('a');
            a.href = src;
            a.textContent = dest;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            srcLi.appendChild(a);
            var audio = document.createElement('audio');
            audio.preload = 'none';
            srcLi.appendChild(audio);
            var span = document.createElement('span');
            span.className = 'clickable';
            span.textContent = '▶️';
            srcLi.appendChild(span);
            var errorMsg = document.createElement('span');
            errorMsg.className = 'nara-audio-error';
            errorMsg.textContent = '(Resource not available)';
            errorMsg.hidden = true;
            srcLi.appendChild(errorMsg);
            span.addEventListener('click', function () { toggleNaraAudio(audio, span, src, errorMsg); });
            // A failed load (e.g. the S3 object itself returning 403/404)
            // fires here rather than rejecting toggleNaraAudio's own
            // audio.play() call — revert the play button to its original
            // icon and surface the failure next to it, since play()
            // otherwise just silently no-ops with nothing but a console
            // error to show for it.
            audio.addEventListener('error', function () {
              span.textContent = '▶️';
              errorMsg.hidden = false;
            });
            naraAudioSpans.set(audio, span);
            naraAudioList.appendChild(srcLi);
          });
        });
        naraEventsSection.hidden = !hasEvents;
        naraAudioSection.hidden = !hasAudio;
      }

      // Cached across repeated Go clicks within the same page load — a term's
      // cases.json rarely changes mid-visit, and Any-year mode especially can
      // revisit the same term across different candidates.
      var termCasesCache = {};
      function fetchTermCases(term) {
        if (!termCasesCache[term]) {
          termCasesCache[term] = fetch('/courts/ussc/terms/' + term + '/cases.json')
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (cases) { return Array.isArray(cases) ? cases : []; })
            .catch(function () { return []; });
        }
        return termCasesCache[term];
      }

      // ── Single-month calendar, shown once a specific Year is picked ─────
      // Reuses the term page's own .cal-dow/.cal-days/.cal-day (+ .cal-arg/
      // .cal-dec/.cal-arg-dec/.cal-sel) markup and CSS classes — see
      // terms.js's renderTermCalendar, which this mirrors — so it looks
      // identical, just scaled up (see .otd-calendar-large in pages.css)
      // since it's the only month shown rather than one of a dozen packed
      // into a 3-column grid. Coloring follows the same "Argued only" filter
      // as the Go button: checked shows only argued (red) days, unchecked
      // shows both argued and decided (red/blue/gradient). Every day cell —
      // colored or not — just updates the controls (Day, and the address
      // bar's own pending "date") and redraws the calendar/Court Cases table
      // in place; jumping straight to a specific case is the Go button's own
      // job now, not a day click's (see wireCalDayPick below and the goBtn
      // handler further down). The month title (below) is the only link left
      // to the bare term calendar page.
      function matchesForDate(cases, fields, iso) {
        return cases.filter(function (c) { return fields.some(function (f) { return dateMatches(c[f], iso); }); });
      }

      function wireCalDayPick(dayEl, day) {
        dayEl.addEventListener('click', function () {
          daySel.value = String(day);
          syncUrlDate(true);
          refreshCalendar();
        });
      }

      function buildCalendarMonth(year, month, cases, fields, selectedIso) {
        calContainer.innerHTML = '';
        var mEl = document.createElement('div');
        mEl.className = 'cal-month';
        var dowRow = document.createElement('div');
        dowRow.className = 'cal-dow';
        ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (n) {
          var s = document.createElement('span');
          s.textContent = n;
          dowRow.appendChild(s);
        });
        mEl.appendChild(dowRow);
        var grid = document.createElement('div');
        grid.className = 'cal-days';
        var firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
        var totalDays = daysInMonth(year, month);
        for (var i = 0; i < firstDow; i++) {
          grid.appendChild(document.createElement('span')).className = 'cal-day';
        }
        for (var d = 1; d <= totalDays; d++) {
          var iso = year + '-' + pad2(month) + '-' + pad2(d);
          var matches = matchesForDate(cases, fields, iso);
          var isArg = matches.some(function (c) { return dateMatches(c.argument, iso) || dateMatches(c.reargument, iso); });
          // Guarded by fields (not just re-checking matches) so a case whose
          // decision happens to land on the same date as its own argument
          // can never sneak blue/gradient in while Argued-only is checked.
          var isDec = fields.indexOf('decision') !== -1 && matches.some(function (c) { return dateMatches(c.decision, iso); });
          var dayEl = document.createElement('span');
          var cls = 'cal-day cal-clickable';
          if (isArg && isDec) cls += ' cal-arg-dec';
          else if (isArg) cls += ' cal-arg';
          else if (isDec) cls += ' cal-dec';
          if (iso === selectedIso) cls += ' cal-sel';
          dayEl.className = cls;
          dayEl.textContent = String(d);
          wireCalDayPick(dayEl, d);
          grid.appendChild(dayEl);
        }
        mEl.appendChild(grid);
        calContainer.appendChild(mEl);
      }

      // { year, month } (1-based month) shifted by `delta` months, rolling
      // over into the previous/next year as needed.
      function shiftMonth(year, month, delta) {
        var m = month - 1 + delta;
        var y = year + Math.floor(m / 12);
        m = ((m % 12) + 12) % 12;
        return { year: y, month: m + 1 };
      }

      function goToCalendarMonth(year, month) {
        yearSel.value = String(year);
        monthSel.value = String(month);
        populateDays(month, parseInt(daySel.value, 10));
        syncUrlDate(true);
        refreshCalendar();
      }

      [calPrevLink, calNextLink].forEach(function (link) {
        link.addEventListener('click', function (e) {
          e.preventDefault();
          if (!link.dataset.year || link.classList.contains('otd-cal-nav-disabled')) return;
          goToCalendarMonth(parseInt(link.dataset.year, 10), parseInt(link.dataset.month, 10));
        });
      });

      // The month title itself is the only link left to the bare term
      // calendar page — every day cell now either jumps straight to a case
      // or just updates the controls (see buildCalendarMonth above).
      calTitleLink.addEventListener('click', function (e) {
        e.preventDefault();
        if (!calTitleLink.dataset.term || !calTitleLink.dataset.date) return;
        var target = '/courts/ussc/?term=' + encodeURIComponent(calTitleLink.dataset.term)
          + '&date=' + encodeURIComponent(calTitleLink.dataset.date);
        if (window.parent !== window) window.parent.location.href = target;
        else window.location.href = target;
      });

      refreshCalendar = function () {
        if (yearSel.value === 'any') {
          calSection.hidden = true;
          drawCaseListing(null);
          drawNaraList(null);
          return;
        }
        calSection.hidden = false;

        var year = parseInt(yearSel.value, 10);
        var month = parseInt(monthSel.value, 10);
        var day = parseInt(daySel.value, 10);
        var selectedIso = year + '-' + pad2(month) + '-' + pad2(day);
        var term = termForDate(selectedIso);
        var fields = arguedChk.checked ? ['argument', 'reargument'] : ['argument', 'reargument', 'decision'];

        calTitleLink.textContent = MONTHS[month - 1] + ' ' + year;
        calTitleLink.dataset.term = term;
        calTitleLink.dataset.date = selectedIso;

        var prev = shiftMonth(year, month, -1);
        var next = shiftMonth(year, month, 1);
        var prevInRange = prev.year >= firstYear && prev.year <= lastYear;
        var nextInRange = next.year >= firstYear && next.year <= lastYear;
        calPrevLink.classList.toggle('otd-cal-nav-disabled', !prevInRange);
        calNextLink.classList.toggle('otd-cal-nav-disabled', !nextInRange);
        calPrevLink.dataset.year = prev.year; calPrevLink.dataset.month = prev.month;
        calNextLink.dataset.year = next.year; calNextLink.dataset.month = next.month;

        fetchTermCases(term).then(function (cases) {
          // Stale by the time this resolves (e.g. the visitor already picked
          // a different month, year, or the Argued-only checkbox) — a newer
          // call's own fetchTermCases (cached) will resolve immediately
          // after and repaint correctly.
          if (yearSel.value !== String(year) || parseInt(monthSel.value, 10) !== month) return;
          buildCalendarMonth(year, month, cases, fields, selectedIso);
          // Always both argued and decided, regardless of the "Argued only"
          // checkbox — that only ever scopes the calendar's own day
          // coloring/click targets (see `fields` above), not this listing.
          var dayMatches = matchesForDate(cases, ['argument', 'reargument', 'decision'], selectedIso);
          drawCaseListing(dayMatches.map(function (c) { return buildCaseRow(c, term, cases); }));
        });

        if (year < NARA_FIRST_YEAR) {
          drawNaraList(null);
        } else {
          fetchNaraData().then(function (all) {
            // Stale by the time this resolves — a newer call's own
            // fetchNaraData (cached after the first real fetch) will resolve
            // right after and repaint correctly. Day-precise (unlike the
            // year/month-only check above), since a NARA match depends on
            // the exact selected day, not just the month.
            if (yearSel.value !== String(year) || parseInt(monthSel.value, 10) !== month || parseInt(daySel.value, 10) !== day) return;
            drawNaraList(all.filter(function (o) { return o.date === selectedIso; }), selectedIso);
          });
        }
      };
      refreshCalendar();

      var onThisDayIndexPromise = null;
      function fetchOnThisDayIndex() {
        if (!onThisDayIndexPromise) {
          onThisDayIndexPromise = fetch((window.INDEXES_BASE_URL || '') + '/courts/ussc/indexes/cases/onthisday.json', { cache: 'reload' })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; });
        }
        return onThisDayIndexPromise;
      }

      // Same shortened-ref convention as explorer.js's _onThisDayThenRestore:
      // a bare id (an October Term case whose id starts with its own term's
      // year) or "term/id-or-number".
      function parseRef(ref) {
        var i = ref.indexOf('/');
        return {
          term: i === -1 ? ref.slice(0, 4) + '-10' : ref.slice(0, i),
          id:   i === -1 ? ref                     : ref.slice(i + 1),
        };
      }

      // Every year for which mmdd ("MM-DD") actually has a qualifying case,
      // as a Map<year, [{term, case, date}]> — built from onthisday.json's
      // own ref list for mmdd (candidates from *any* event type, across
      // every year), refined here against each candidate's own real case
      // data so only occurrences matching `fields` survive, keyed by the
      // occurrence's own actual year (not the ref's term year, which can
      // differ — see CLAUDE.md on cross-term case dates).
      function yearsForMmdd(mmdd, fields) {
        return fetchOnThisDayIndex().then(function (index) {
          var refs = index[mmdd] || [];
          var parsed = refs.map(parseRef);
          var terms = [];
          parsed.forEach(function (p) { if (terms.indexOf(p.term) === -1) terms.push(p.term); });
          return Promise.all(terms.map(fetchTermCases)).then(function (casesByTerm) {
            var byYear = new Map();
            parsed.forEach(function (p, i) {
              var termIdx = terms.indexOf(p.term);
              var cases = casesByTerm[termIdx];
              var c = cases.find(function (cc) { return cc.id === p.id || cc.number === p.id; });
              if (!c) return;
              fields.forEach(function (f) {
                var raw = c[f];
                if (!raw) return;
                raw.split(',').map(function (s) { return s.trim(); }).forEach(function (d) {
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d.slice(5, 10) !== mmdd) return;
                  var year = d.slice(0, 4);
                  if (!byYear.has(year)) byYear.set(year, []);
                  byYear.get(year).push({ term: p.term, case: c, cases: cases, date: d });
                });
              });
            });
            return byYear;
          });
        });
      }

      goBtn.addEventListener('click', function () {
        goBtn.disabled = true;
        showResult('');

        var month = parseInt(monthSel.value, 10);
        var day = parseInt(daySel.value, 10);
        var yearVal = yearSel.value;
        var fields = arguedChk.checked ? ['argument', 'reargument'] : ['argument', 'reargument', 'decision'];
        var niceMonthDay = MONTHS[month - 1] + ' ' + day;
        var failMessage = arguedChk.checked
          ? 'No case was ever argued on ' + niceMonthDay + '. Try a different date, or uncheck “Argued only” to include decisions too.'
          : 'No case was ever argued or decided on ' + niceMonthDay + '. Try a different date.';

        function goTo(term, caseEntry, cases) {
          var target = '/courts/ussc/?term=' + encodeURIComponent(term)
            + '&case=' + encodeURIComponent(caseUrlId(caseEntry, cases));
          if (window.parent !== window) window.parent.location.href = target;
          else window.location.href = target;
        }

        if (yearVal === 'any') {
          var mmdd = pad2(month) + '-' + pad2(day);
          yearsForMmdd(mmdd, fields)
            .then(function (byYear) {
              goBtn.disabled = false;
              if (!byYear.size) { showResult(failMessage); return; }
              var years = [...byYear.keys()];
              var yearOccs = byYear.get(years[Math.floor(Math.random() * years.length)]);
              var pick = yearOccs[Math.floor(Math.random() * yearOccs.length)];
              // Leave Year on "Any" and the URL on "MM-DD" — the resolved year
              // was random, not something the visitor picked, so the address
              // bar shouldn't claim otherwise. The month/day change handlers
              // already kept the URL in sync, so there's nothing to update
              // here before leaving.
              goTo(pick.term, pick.case, pick.cases);
            })
            .catch(function () {
              goBtn.disabled = false;
              showResult("We're sorry, something went wrong looking up that date. Please try again.");
            });
          return;
        }

        var year = parseInt(yearVal, 10);
        day = Math.min(day, daysInMonth(year, month));
        daySel.value = String(day); // e.g. Feb 29 clamped for a non-leap year
        var dateStr = year + '-' + pad2(month) + '-' + pad2(day);
        var term = termForDate(dateStr);

        fetchTermCases(term)
          .then(function (cases) {
            var matches = cases.filter(function (c) {
              return fields.some(function (f) { return dateMatches(c[f], dateStr); });
            });
            goBtn.disabled = false;
            if (!matches.length) {
              showResult(arguedChk.checked
                ? 'No case was argued on ' + niceMonthDay + ', ' + year + '. Try a different date, or uncheck “Argued only” to include decisions too.'
                : 'No case was argued or decided on ' + niceMonthDay + ', ' + year + '. Try a different date.');
              return;
            }
            var pick = matches[Math.floor(Math.random() * matches.length)];
            // Replace (not push) right before leaving, same reasoning as the
            // "Any" path above — belt-and-suspenders here since Day/Year
            // were already in sync from the controls themselves; this just
            // guards the Feb-29 clamp above ever landing on a stale entry.
            syncUrlDate(false);
            goTo(term, pick, cases);
          })
          .catch(function () {
            goBtn.disabled = false;
            showResult("We're sorry, something went wrong looking up that date. Please try again.");
          });
      });
    });
}());
