(function () {
  function termTitle(term) {
    var parts = term.split('-'), year = parts[0], mon = parseInt(parts[1], 10);
    var names = ['January','February','March','April','May','June',
                 'July','August','September','October','November','December'];
    return (names[mon - 1] || parts[1]) + ' Term ' + year;
  }
  function parseLen(s) {
    if (!s) return 0;
    var p = s.split(':');
    return parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60 + parseFloat(p[2]);
  }
  function fmtHours(sec) {
    return Math.round(sec / 3600) + 'h';
  }
  function fmtMins(sec) {
    var m = Math.round(sec / 60);
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60), rem = m % 60;
    return h + 'h ' + rem + 'm';
  }
  // Resolve a "{{ indexes_base_url }}" placeholder in a terms.json href value
  // against window.INDEXES_BASE_URL (self-hosted files too large for the main
  // site, e.g. scanned journal PDFs). Plain absolute URLs pass through as-is.
  function resolveIndexesUrl(href) {
    return typeof href === 'string'
      ? href.replace('{{ indexes_base_url }}', window.INDEXES_BASE_URL || '')
      : href;
  }
  // Mirrors explorer.js's _FILTER_OPTIONS (keys already snake_case here, as
  // they appear in the URL's own filter= param — see _filterKeyToUrl there)
  // — kept in sync by hand since this page runs in its own iframe/script.
  var FILTER_DESCRIPTIONS = {
    digs:         'DIGs (cases dismissed as improvidently granted)',
    partial_digs: 'Partial DIGs (cases partially dismissed as improvidently granted)',
    dismissals:   'Dismissals (cases dismissed for any reason, improvident or otherwise)',
    orders:       'Orders (cases summarily decided)',
  };
  // Current filter= value — seeded from this page's own URL below (see
  // `_currentFilterParam = params.get('filter')`), then kept live as the
  // Terms nav's Filter panel checkboxes are toggled in the parent frame (see
  // the message listener below, and explorer.js's _applyActiveFilters, which
  // posts the update). Read by both renderFilterNote and _drawCaseListing so
  // the note and the Court Cases table always agree on the active filter.
  var _currentFilterParam = null;
  // Populates the italicized note now shown under the Court Cases heading
  // (#stat-filter-note) from _currentFilterParam — call only once that
  // heading/table are themselves about to be shown (see _drawCaseListing).
  function renderFilterNote() {
    var noteEl = document.getElementById('stat-filter-note');
    if (!noteEl) return;
    // Split on whitespace/comma (a URL's filter= param, once decoded by
    // URLSearchParams.get, has a literal "+" join turned into a space) as
    // well as a literal "+" itself (the raw, not-yet-URL-encoded string
    // posted live by explorer.js's _applyActiveFilters).
    var descs = (_currentFilterParam || '').split(/[\s,+]+/).filter(Boolean)
      .map(function (k) { return FILTER_DESCRIPTIONS[k]; }).filter(Boolean);
    if (!descs.length) { noteEl.hidden = true; return; }
    noteEl.textContent = 'Cases filters in effect: ' + descs.join(', ');
    noteEl.hidden = false;
  }
  // Keeps the note and the Court Cases table current as the Terms nav's
  // Filter panel checkboxes are toggled, without reloading this iframe — see
  // the postMessage call in explorer.js's _applyActiveFilters.
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    if (e.data && e.data.type === 'ussc-filter-update') {
      _currentFilterParam = e.data.filter || '';
      _drawCaseListing();
    }
  });
  function fmtDate(iso) {
    var MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var p = iso.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    if (isNaN(d)) return iso;
    return DAYS[d.getUTCDay()] + ', ' + MONTHS[+p[1] - 1] + ' ' + d.getUTCDate() + ', ' + p[0];
  }
  function caseDisplayTitle(c) {
    return (c.title || c.number || c.id || '(unknown)').split(';')[0].trim();
  }
  // "No. 5" / "Nos. 5, 6-Orig" — mirrors decisionTooltip/argumentTooltip's
  // own number formatting in assets/js/explorer.js (duplicated here since
  // this script runs on its own page, not alongside explorer.js).
  function caseNumberLabel(c) {
    if (!c.number) return '';
    var numbers = c.number.split(',').map(function (n) { return n.trim().replace(/-(?=Orig|Misc)/i, ' '); });
    return (numbers.length > 1 ? 'Nos. ' : 'No. ') + numbers.join(', ');
  }
  // Preferred `case=` URL value for a case — its first docket number when
  // that's unique among siblingCases, else its own id (matching
  // explorer.js's own _caseUrlId()). siblingCases should be the cases.json
  // array for c's own term. A cross-term case-detail pointer object (c.term
  // set — see fillGroup below) doesn't belong to any siblingCases passed in
  // here (that'd be a different term's cases.json), so there's no reliable
  // way to check leading-number uniqueness for it — always use its id,
  // which such an object is always given (see syncCrossTermCaseDates).
  function caseUrlId(c, siblingCases) {
    var num = (c.number || '').split(',')[0].trim();
    if (!c.term && num && siblingCases) {
      var count = 0;
      for (var i = 0; i < siblingCases.length; i++) {
        if ((siblingCases[i].number || '').split(',')[0].trim() === num) count++;
      }
      if (count === 1) return num;
    }
    return c.id || num;
  }

  var MONTHS_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function dayOf(iso) {
    var p = iso.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDate();
  }

  // "2000-11-28" -> "Nov 28, 2000" (no weekday — used by the case listing
  // table; fmtDate() above is a separate weekday-prefixed, full-month-name
  // format used elsewhere for the single selected-date heading).
  function fmtMonthDayYear(iso) {
    var p = iso.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    if (isNaN(d)) return iso;
    return MONTHS_ABBR[+p[1] - 1] + ' ' + d.getUTCDate() + ', ' + p[0];
  }

  function dateTokens(fieldVal) {
    if (!fieldVal) return [];
    return fieldVal.split(',').map(function (d) { return d.trim(); }).filter(Boolean);
  }

  // Same-origin postMessage-to-parent-when-framed / direct-navigate-when-
  // standalone pattern already used by the term-nav and date-section links
  // in this file. `a.href` is set to the real top-level SPA URL (not a
  // page-relative query string against this iframe-only page) so that a
  // crawler, or a user opening the link in a new tab, lands on the actual
  // canonical page instead of minting a duplicate under /courts/ussc/terms/.
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

  // window.open()'s third argument (windowFeatures) — even just
  // 'noopener,noreferrer', with no size/position of its own — is enough to
  // make some browsers treat the result as a popup window rather than a
  // normal tab. Omitting it and stripping .opener off the returned reference
  // instead gets the same noopener protection (blocking the new tab from
  // reaching back into this page via window.opener) without that.
  function _openInNewTab(href) {
    var w = window.open(href, '_blank');
    if (w) w.opener = null;
  }

  // Wires a term-page cover thumbnail (journal/U.S. Reports/minutes) to open
  // its document in the SPA's doc viewer by default — postMessage when
  // framed, a new tab when standalone — or always in a new tab on
  // Shift-click, matching wireDocLink's shift-to-new-tab convention below.
  function wireCoverClick(btn, href, title, view) {
    btn.addEventListener('click', function (e) {
      if (e.shiftKey) { _openInNewTab(href); return; }
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'ussc-open-doc', href: href, title: title, view: view }, location.origin);
      } else {
        _openInNewTab(href);
      }
    });
  }

  // Same postMessage pattern already used by the journal/report cover
  // buttons in this file to open a document in the SPA's doc viewer.
  // `view` is forwarded as-is to showDocViewer's own `link.view` — pass
  // 'pane' to force the embedded-iframe view instead of the default
  // external-link card (showDocViewer only auto-picks the pane for
  // .pdf/.mp4/.mp3 hrefs, and a catalog.archives.gov URL matches none of those).
  // `altHref` (optional) opens in a new tab on a Shift-click, instead of
  // `href`'s normal doc-viewer behavior (see the Minutes page links below).
  // `images`/`index` (optional, both or neither) let a caller open `href` as
  // one page of a multi-image gallery in the doc viewer's own image viewer
  // instead of a single static image — see the Minutes page links below,
  // whose whole date's worth of pages are passed this way so the doc
  // viewer's own Left/Right arrow keys can page through them without
  // reopening it. `src` (optional) is the actual image shown when `href`
  // itself is a catalog page rather than the image directly — same src/href
  // split showDocViewer's own `link.src`/`link.href` use, so the doc
  // viewer's "open in new tab" icon links to the catalog page instead of the
  // raw image. `hrefs` (optional) is `images`' own per-page catalog-href
  // counterpart, so that icon keeps tracking the right page as the visitor
  // pages Left/Right through the gallery (see explorer.js's
  // _activeGalleryHrefs).
  function wireDocLink(a, href, title, view, altHref, images, index, src, hrefs) {
    a.href = href;
    a.addEventListener('click', function (e) {
      e.preventDefault();
      if (altHref && e.shiftKey) {
        _openInNewTab(altHref);
        return;
      }
      if (window.parent !== window) {
        var msg = { type: 'ussc-open-doc', href: href, title: title, view: view };
        if (src) msg.src = src;
        if (Array.isArray(images) && images.length > 1) {
          msg.images = images;
          msg.index = index;
          if (Array.isArray(hrefs) && hrefs.length > 1) msg.hrefs = hrefs;
        }
        window.parent.postMessage(msg, location.origin);
      } else {
        _openInNewTab(href);
      }
    });
  }

  // Renders one or more ISO dates into a table cell, linked to the earliest
  // date shown: a single date is "Mon D, Year"; multiple dates within the
  // same month collapse to a "Mon D1-D2, Year" range rather than listing
  // each one out; dates spanning more than one month (e.g. an argument and
  // a reargument months apart) are too much to enumerate — show a single
  // "…" instead.
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

  // "531 U.S. 57" -> a number that sorts citations chronologically (by
  // volume, then page) rather than alphabetically.
  function opinionSortKey(citation) {
    var m = /^(\d+)\s+U\.S\.\s+(\d+)$/.exec(citation || '');
    return m ? parseInt(m[1], 10) * 100000 + parseInt(m[2], 10) : null;
  }

  // Undecided/missing values (null) always sort last, regardless of
  // direction — checked before the asc/desc flip so reversing the sort
  // never brings them back to the front.
  function compareRows(a, b, key, asc) {
    var av = a.sortValues[key], bv = b.sortValues[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    var cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return asc ? cmp : -cmp;
  }

  function buildCaseListingRow(row) {
    var tr = document.createElement('tr');

    var tdTitle = document.createElement('td');
    var aTitle = document.createElement('a');
    aTitle.textContent = row.title;
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

  // Builds one Case Listing row from a full case record. caseTerm is what
  // the title link (and the Decided cell, since a decision date isn't
  // cross-term-tracked anywhere — see collectCrossTermRows below — so its
  // own filing term is the best link target available) navigates to;
  // argTerm is what the Argued cell links to — normally the same term, but
  // for a cross-term row (see collectCrossTermRows) argTerm is instead
  // wherever that specific argued/reargued date actually falls on a
  // calendar (this page's own term), since the case's real home term
  // (caseTerm) wouldn't have that date in its own range at all.
  // argIsoOverride, if given, replaces the normal "this case's own argument/
  // reargument dates, dropping anything before caseTerm" computation
  // (which assumes c belongs to caseTerm) with an explicit list — used by
  // collectCrossTermRows to show only the one date that's actually relevant
  // to *this* page, not every argument/reargument date on the record.
  // siblingCases should be c's own home term's cases.json array, passed
  // through to caseUrlId() for its leading-number-uniqueness check.
  function buildCaseRow(c, caseTerm, argTerm, siblingCases, argIsoOverride) {
    // A case reargued in a later term than it was first argued in still
    // carries both dates on the same case record — comparing by
    // year-month (both "argument"/"reargument" and caseTerm share the same
    // "YYYY-MM" prefix) drops any date that belongs to an earlier term, so
    // e.g. a reargument in this term takes over from an original argument
    // that predates it.
    var argIso = argIsoOverride || Array.from(new Set(dateTokens(c.argument).concat(dateTokens(c.reargument))))
      .filter(function (d) { return d.slice(0, 7) >= caseTerm; });
    var decIso = dateTokens(c.decision);
    var scoreM = /^(\d+)-(\d+)$/.exec(c.score || '');
    var voteM = scoreM ? parseInt(scoreM[1], 10) : null, voteN = scoreM ? parseInt(scoreM[2], 10) : null;
    var opinionText = c.citation || '';
    var decDates = decIso.slice().sort();
    return {
      title: caseDisplayTitle(c),
      caseId: caseUrlId(c, siblingCases),
      caseTerm: caseTerm,
      argTerm: argTerm,
      argIso: argIso,
      decIso: decIso,
      voteText: c.score || '',
      opinionText: opinionText,
      // Kept off the display but read by _FILTER_CASE_TEST (see below) so the
      // Court Cases table can be filtered by the same Terms nav Filter panel
      // state as the sidebar case list, without needing the raw case record
      // again — a cross-term row (see collectCrossTermRows) has no other way
      // to reach it once built.
      result: c.result || '',
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

  // Finds every cross-term case-detail pointer object (see update_cases.js's
  // syncCrossTermCaseDates) across ALL of this term's own dates.json dates —
  // a case filed under a *later* term whose argument/reargument date
  // actually falls within this term's own calendar window, e.g. Davis v.
  // Gaines (filed under 1881-10) argued Jan 27 1881, which is within
  // 1880-10's own range. These already show up in the single-date
  // arguments list (see fillGroup above) but were missing from the Case
  // Listing table entirely, which only ever looked at this term's own
  // cases.json. A pointer only carries {type, id, term, number, title,
  // citation} — not enough to build a full row (no votes/decision/etc.) — so
  // each one is resolved against its own home term's cases.json (grouped by
  // term first so a term with several cross-term entries is only fetched
  // once), deduped by case id (rare, but the same case could have e.g. both
  // an argument and reargument pointer landing on different dates within
  // this same term — merged into one row with both dates). Returns a
  // Promise resolving to an array of rows in buildCaseRow's own shape;
  // resolves to [] (never rejects) if datesData is empty or every fetch
  // fails, so a lookup failure just means the table falls back to native
  // cases only rather than never rendering.
  function collectCrossTermRows(datesData, term) {
    if (!datesData) return Promise.resolve([]);
    var byId = new Map(); // case id/number -> { pointer, isos: [iso, ...] }
    Object.keys(datesData).forEach(function (iso) {
      (datesData[iso] || []).forEach(function (g) {
        if (g.type !== 'argument' && g.type !== 'reargument') return;
        var key = g.id || g.number;
        if (!key) return;
        if (!byId.has(key)) byId.set(key, { pointer: g, isos: [] });
        byId.get(key).isos.push(iso);
      });
    });
    if (!byId.size) return Promise.resolve([]);

    var byTerm = new Map(); // pointer's own home term -> [{ pointer, isos }, ...]
    byId.forEach(function (entry) {
      var t = entry.pointer.term;
      if (!t) return;
      if (!byTerm.has(t)) byTerm.set(t, []);
      byTerm.get(t).push(entry);
    });

    return Promise.all(Array.from(byTerm.keys()).map(function (t) {
      return fetch('/courts/ussc/terms/' + t + '/cases.json')
        .then(function (r) { return r.ok ? r.json() : []; })
        .catch(function () { return []; })
        .then(function (termCases) {
          return byTerm.get(t).map(function (entry) {
            var key = entry.pointer.id || entry.pointer.number;
            var full = Array.isArray(termCases) && termCases.find(function (c) { return c.id === key || c.number === key; });
            if (!full) return null;
            return buildCaseRow(full, t, term, termCases, entry.isos.slice().sort());
          }).filter(Boolean);
        });
    })).then(function (perTerm) { return [].concat.apply([], perTerm); });
  }

  // True if breakpoint bp (see _parseArabicPnBps) marks the start of an
  // "orders mapping" section of a U.S. Reports volume — mirrors
  // isOrdersBreakpoint in scripts/update_cases.js / _isOrdersBreakpoint in
  // explorer.js (kept in sync by hand; no shared module between the three
  // runtimes).
  function _isOrdersBreakpoint(bp) {
    return !!bp.marked || (bp.start > 800 && bp.start % 100 === 1);
  }
  // Parses a reports[].pages breakpoint string ("1:85,801:717") into
  // {start, pdfPage, marked?} objects, arabic (non-roman) breakpoints only —
  // all _isOrdersCase needs. Mirrors _parsePages in scripts/update_cases.js /
  // _parsePnBps in explorer.js (kept in sync by hand).
  function _parseArabicPnBps(pn) {
    if (!pn) return [];
    return pn.split(',').map(function (seg) {
      var colon = seg.indexOf(':');
      if (colon < 0) return null;
      var startStr = seg.slice(0, colon).trim();
      var pdfPageStr = seg.slice(colon + 1).trim();
      var marked = pdfPageStr.charAt(pdfPageStr.length - 1) === '*';
      if (marked) pdfPageStr = pdfPageStr.slice(0, -1).trim();
      var start = parseInt(startStr, 10);
      if (!isFinite(start)) return null; // roman or garbage
      return { start: start, marked: marked };
    }).filter(Boolean).sort(function (a, b) { return a.start - b.start; });
  }
  // True if citation lands in an "orders mapping" section of its volume —
  // mirrors _isOrdersCase in scripts/update_cases.js / explorer.js (kept in
  // sync by hand). termEntry is the citing term's own terms.json group entry
  // (carries reports[]) — see termEntryPromise below.
  function _isOrdersCase(citation, termEntry) {
    var m = /^(\d+)\s+U\.S\.\s+(\d+|[ivxlcdmIVXLCDM]+)$/.exec((citation || '').trim());
    if (!m) return false;
    if (!/^\d+$/.test(m[2])) return true; // roman-numeral page
    var vol = parseInt(m[1], 10), page = parseInt(m[2], 10);
    var reports = (termEntry && termEntry.reports) || [];
    var report = null;
    for (var i = 0; i < reports.length; i++) { if (Number(reports[i].volume) === vol) { report = reports[i]; break; } }
    if (!report || !report.pages) return false;
    var bps = _parseArabicPnBps(report.pages);
    var match = null;
    for (var j = 0; j < bps.length; j++) { if (bps[j].start <= page) match = bps[j]; else break; }
    return !!match && _isOrdersBreakpoint(match);
  }
  // Mirrors explorer.js's _FILTER_CASE_TEST — "digs" is a subset of
  // "dismissals", "partial_digs" is not (see that file's own comment).
  // Operates on a buildCaseRow row (result/opinionText), not a raw case
  // record, so it works uniformly for native and cross-term rows alike.
  var _FILTER_CASE_TEST = {
    orders:       function (row, termEntry) { return _isOrdersCase(row.opinionText, termEntry); },
    partial_digs: function (row) { return /partially improvidently granted/i.test(row.result || ''); },
    dismissals:   function (row) { return /dismissed/i.test(row.result || ''); },
    digs:         function (row) { return /dismissed as improvidently granted/i.test(row.result || ''); },
  };
  // Returns just the rows matching at least one active filter key (OR, not
  // AND — see explorer.js's own _caseMatchesActiveFilters), or every row
  // unchanged when filterParam names no recognized filter.
  function _rowsMatchingFilters(rows, filterParam, termEntry) {
    var keys = (filterParam || '').split(/[\s,+]+/).filter(function (k) {
      return Object.prototype.hasOwnProperty.call(_FILTER_CASE_TEST, k);
    });
    if (!keys.length) return rows;
    return rows.filter(function (row) {
      return keys.some(function (k) { return _FILTER_CASE_TEST[k](row, termEntry); });
    });
  }

  // Persistent Case Listing state, set by renderCaseListing and read by
  // _drawCaseListing — split out so a live filter change (see the message
  // listener above) can redraw the table from cache, without re-fetching or
  // losing the visitor's current sort.
  var _caseListingRows = null;       // every row for the current term, unfiltered
  var _caseListingTermEntry = null;  // this term's own terms.json group entry (reports[]) — see _isOrdersCase
  var _caseListingSort = { key: 'title', asc: true };
  var _caseListingSortWired = false;

  function _drawCaseListing() {
    var heading = document.getElementById('case-listing-heading');
    var table   = document.getElementById('case-listing-table');
    var tbody   = document.getElementById('case-listing-tbody');
    var noteEl  = document.getElementById('stat-filter-note');
    if (!_caseListingRows) { heading.hidden = true; table.hidden = true; if (noteEl) noteEl.hidden = true; return; }
    var visible = _rowsMatchingFilters(_caseListingRows, _currentFilterParam, _caseListingTermEntry);
    if (!visible.length) { heading.hidden = true; table.hidden = true; if (noteEl) noteEl.hidden = true; return; }
    heading.hidden = false;
    table.hidden = false;
    renderFilterNote();

    var sorted = visible.slice().sort(function (a, b) { return compareRows(a, b, _caseListingSort.key, _caseListingSort.asc); });
    tbody.innerHTML = '';
    sorted.forEach(function (row) { tbody.appendChild(buildCaseListingRow(row)); });
    table.querySelectorAll('th[data-sort-key]').forEach(function (th) {
      var active = th.dataset.sortKey === _caseListingSort.key;
      th.setAttribute('aria-sort', active ? (_caseListingSort.asc ? 'ascending' : 'descending') : 'none');
    });
    if (!_caseListingSortWired) {
      _caseListingSortWired = true;
      table.querySelectorAll('th[data-sort-key]').forEach(function (th) {
        th.querySelector('button').addEventListener('click', function () {
          var key = th.dataset.sortKey;
          if (_caseListingSort.key === key) _caseListingSort.asc = !_caseListingSort.asc;
          else { _caseListingSort.key = key; _caseListingSort.asc = true; }
          _drawCaseListing();
        });
      });
    }
  }

  function renderCaseListing(term, cases, extraRows, termEntry) {
    var rows = cases.map(function (c) { return buildCaseRow(c, term, term, cases); });
    if (extraRows && extraRows.length) rows = rows.concat(extraRows);
    _caseListingRows = rows;
    _caseListingTermEntry = termEntry || null;
    _drawCaseListing();
  }

  function renderHistoryChart(container, data) {
    var NS = 'http://www.w3.org/2000/svg';
    var W = 760, H = 300;
    var P = { t: 10, r: 16, b: 36, l: 40 };
    var cW = W - P.l - P.r, cH = H - P.t - P.b;
    var n = data.length;
    var maxRaw = 0;
    for (var i = 0; i < n; i++) maxRaw = Math.max(maxRaw, data[i].d, data[i].ad, data[i].un || 0);
    var step = maxRaw > 200 ? 50 : maxRaw > 100 ? 25 : 10;
    var maxY = Math.ceil(maxRaw * 1.1 / step) * step;
    function xOf(i) { return P.l + i / (n - 1) * cW; }
    function yOf(v) { return P.t + cH * (1 - v / maxY); }
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', '100%');
    svg.style.cssText = 'display:block;overflow:visible';
    function svgEl(tag, attrs, style) {
      var e = document.createElementNS(NS, tag);
      for (var k in (attrs || {})) e.setAttribute(k, attrs[k]);
      if (style) e.style.cssText = style;
      return e;
    }
    for (var yv = 0; yv <= maxY; yv += step) {
      var yp = yOf(yv);
      svg.appendChild(svgEl('line', { x1:P.l, x2:P.l+cW, y1:yp, y2:yp }, 'stroke:var(--chart-grid);stroke-width:1'));
      var yt = svgEl('text', { x:P.l-4, y:yp+4, 'text-anchor':'end' }, 'fill:var(--chart-label);font-size:10px;font-family:inherit');
      yt.textContent = yv; svg.appendChild(yt);
    }
    svg.appendChild(svgEl('line', { x1:P.l, x2:P.l+cW, y1:P.t+cH, y2:P.t+cH }, 'stroke:var(--chart-axis);stroke-width:1'));
    svg.appendChild(svgEl('line', { x1:P.l, x2:P.l, y1:P.t, y2:P.t+cH }, 'stroke:var(--chart-axis);stroke-width:1'));
    var lastYr = -1;
    for (var i = 0; i < n; i++) {
      var yr = parseInt(data[i].t, 10);
      if (yr % 20 === 0 && yr !== lastYr) {
        lastYr = yr;
        var xt = svgEl('text', { x:xOf(i).toFixed(1), y:P.t+cH+13, 'text-anchor':'middle' }, 'fill:var(--chart-label);font-size:10px;font-family:inherit');
        xt.textContent = yr; svg.appendChild(xt);
      }
    }
    function makePath(field, color) {
      var d = '';
      for (var i = 0; i < n; i++) d += (i ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(data[i][field] || 0).toFixed(1);
      return svgEl('path', { d:d, fill:'none', stroke:color, 'stroke-width':'1.5', 'stroke-linejoin':'round' });
    }
    svg.appendChild(makePath('ad', '#ff9f40'));
    svg.appendChild(makePath('d',  '#4a9eff'));
    svg.appendChild(makePath('un', '#2ecc71'));
    var cursor = svgEl('line', { x1:P.l, x2:P.l, y1:P.t, y2:P.t+cH }, 'stroke:var(--chart-label);stroke-width:1;opacity:0;pointer-events:none');
    svg.appendChild(cursor);
    var tip = svgEl('g', {}, 'opacity:0;pointer-events:none');
    tip.appendChild(svgEl('rect', { rx:'3', width:'106', height:'59' }, 'fill:var(--chart-tip-bg);stroke:var(--chart-axis);stroke-width:1'));
    var tipT = [svgEl('text',{},null), svgEl('text',{},null), svgEl('text',{},null), svgEl('text',{},null)];
    tipT.forEach(function(t) { t.style.cssText = 'fill:var(--chart-label);font-size:10px;font-family:inherit'; tip.appendChild(t); });
    svg.appendChild(tip);
    var hit = svgEl('rect', { x:P.l, y:P.t, width:cW, height:cH, fill:'transparent' }, 'cursor:crosshair');
    svg.appendChild(hit);
    var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    function onHover(clientX) {
      var r = svg.getBoundingClientRect();
      var idx = Math.max(0, Math.min(n - 1, Math.round(((clientX - r.left) / r.width * W - P.l) * (n - 1) / cW)));
      var row = data[idx], cx = xOf(idx).toFixed(1);
      cursor.setAttribute('x1', cx); cursor.setAttribute('x2', cx); cursor.style.opacity = '0.4';
      var parts = row.t.split('-');
      tipT[0].textContent = (MON[parseInt(parts[1],10)-1]||'') + ' ' + parts[0];
      tipT[1].textContent = 'Decided: ' + row.d;
      var unCount = row.un || 0;
      var unPct = row.d ? Math.round(unCount / row.d * 100) : 0;
      tipT[2].textContent = 'Unanimous: ' + unCount + ' (' + unPct + '%)';
      tipT[3].textContent = 'Arg. days: ' + row.ad;
      tipT.forEach(function(t, i) { t.setAttribute('x', 6); t.setAttribute('y', 12 + i * 13); });
      var tx = +cx + 6;
      if (tx + 106 > P.l + cW) tx = +cx - 112;
      tip.setAttribute('transform', 'translate(' + tx + ',' + (P.t + 4) + ')');
      tip.style.opacity = '1';
    }
    hit.addEventListener('mousemove', function(e) { onHover(e.clientX); });
    hit.addEventListener('touchmove', function(e) { e.preventDefault(); onHover(e.touches[0].clientX); }, { passive: false });
    hit.addEventListener('mouseleave', function() { cursor.style.opacity='0'; tip.style.opacity='0'; });
    container.appendChild(svg);
    var leg = document.createElement('div');
    leg.style.cssText = 'display:flex;gap:16px;justify-content:center;margin-top:6px;font-size:0.72rem;';
    [['Decisions','#4a9eff'],['Unanimous Decisions','#2ecc71'],['Argument Days','#ff9f40']].forEach(function(item) {
      var s = document.createElement('span');
      s.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
      var sw = document.createElement('span');
      sw.style.cssText = 'width:18px;height:2px;background:'+item[1]+';display:inline-block;border-radius:1px;flex-shrink:0';
      var lb = document.createElement('span');
      lb.textContent = item[0]; lb.style.color = 'var(--chart-label)';
      s.appendChild(sw); s.appendChild(lb); leg.appendChild(s);
    });
    container.appendChild(leg);
  }

  // Wires a calendar day cell to navigate to term=<termId>&date=<iso> — shared
  // by argument/decision days (wired at initial render, below) and
  // minutes-only days (wired later, once dates.json resolves and
  // applyMinutesTooltipToDay knows cal-minutes applies). Idempotent (a day
  // that's already wired — e.g. an argument day that also has minutes —
  // isn't wired twice) via the .cal-clickable marker class. The handler is
  // stashed on the element so unwireCalDayNav (below) can later remove this
  // exact listener if a minutes-only day loses its only minutes entry.
  // A "page" URL param (this date's first Minutes page — see
  // applyMinutesTooltipToDay's own dayEl.dataset.minutesPage) is read fresh
  // at click time, not baked in here, since an argument/decision day is
  // wired up front (before dates.json has even loaded) and would otherwise
  // never pick up a page number that only becomes known afterward. It's
  // only ever added, though, if the *current* URL already has one — i.e.
  // the visitor is already viewing a Minutes page (first set by clicking an
  // actual page link in the Pages list — see renderMinutesPagesList's own
  // click handler and updateUrlPageParam) — so a plain first click into a
  // term's calendar lands on the date's own argued/reargued/decided cases
  // like any other day, not straight into the Minutes viewer. Once that
  // page param is present, though, every later day click keeps carrying it
  // (and #minutes) through, re-pointed at the new day's own first page, so
  // browsing stays inside the Minutes viewer for as long as the visitor
  // does. location.search is re-read live (not the module-scope `params`
  // parsed once at load) since updateUrlPageParam sets it via
  // history.replaceState — no reload — so `params` would otherwise still
  // reflect this page's stale pre-click state. The #minutes fragment itself
  // is what explorer.js's restoreFromURL forwards through to the stats
  // page's own iframe src so a fresh load of it lands with the "Minutes"
  // heading (#minutes — see courts/ussc/terms/index.md) scrolled to the top.
  function wireCalDayNav(dayEl, termId, iso) {
    if (dayEl.classList.contains('cal-clickable')) return;
    dayEl.classList.add('cal-clickable');
    var handler = function () {
      var s = '?term=' + encodeURIComponent(termId) + '&date=' + encodeURIComponent(iso);
      if (dayEl.dataset.minutesPage && new URLSearchParams(location.search).has('page')) {
        s += '&page=' + encodeURIComponent(dayEl.dataset.minutesPage) + '#minutes';
      }
      if (window.parent !== window) { window.parent.postMessage({ type: 'ussc-navigate', search: s }, location.origin); }
      else { location.href = '/courts/ussc/' + s; }
    };
    dayEl._calNavHandler = handler;
    dayEl.addEventListener('click', handler);
  }

  // Reverses wireCalDayNav — used only when a minutes-only day (no argument/
  // decision of its own) loses its last minutes entry via the drag-and-drop
  // editing below, so it stops behaving like a link.
  function unwireCalDayNav(dayEl) {
    if (!dayEl.classList.contains('cal-clickable')) return;
    if (dayEl._calNavHandler) { dayEl.removeEventListener('click', dayEl._calNavHandler); delete dayEl._calNavHandler; }
    dayEl.classList.remove('cal-clickable');
  }

  // Makes a calendar day cell a drop target for a Minutes-page-list drag (see
  // renderMinutesPagesList below): onDrop(sourceIso, sourcePage, targetIso,
  // keepSource) is called with this day's own iso as targetIso, and
  // keepSource true if Shift was held at drop time (see handleMinutesDrop).
  // Wrapped in its own function (rather than wired inline in
  // renderTermCalendar's loop) so each call gets its own `iso` binding — the
  // loop variable itself is shared across every iteration and would
  // otherwise have moved on by drop time.
  function wireCalDayDropTarget(dayEl, iso, onDrop) {
    dayEl.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.shiftKey ? 'copy' : 'move';
    });
    dayEl.addEventListener('dragenter', function () { dayEl.classList.add('cal-drop-target'); });
    dayEl.addEventListener('dragleave', function () { dayEl.classList.remove('cal-drop-target'); });
    dayEl.addEventListener('drop', function (e) {
      e.preventDefault();
      dayEl.classList.remove('cal-drop-target');
      var raw = e.dataTransfer.getData('text/plain');
      if (!raw) return;
      var payload;
      try { payload = JSON.parse(raw); } catch (err) { return; }
      if (payload && payload.iso && payload.page != null) onDrop(payload.iso, payload.page, iso, e.shiftKey);
    });
  }

  // monthCount defaults to a full 12-month term; the all-terms progressive
  // calendar passes a smaller value for a term crowded by the next one
  // (e.g. a short special term), so its grid stops the month before the
  // next term's calendar begins instead of overlapping it. onMinutesDrop,
  // if given, makes every real day cell (not the empty leading padding
  // cells) a drop target for the Minutes-page drag-and-drop editing below —
  // omitted by the all-terms progressive calendar, which has no per-date
  // Minutes page list for a drag to originate from. startOverride
  // ({year, month} — month 0-based), if given, replaces termId's own start
  // month/year as where the grid begins — used by the single-term page's own
  // Court Calendar (see below) to jump straight to the quarter nearest a
  // ?date= param instead of always starting from the term's actual first day.
  function renderTermCalendar(container, termId, argDays, decDays, selectedDate, monthCount, onMinutesDrop, startOverride) {
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    var MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var DOW = ['S','M','T','W','T','F','S'];
    var parts = termId.split('-');
    var startYear = startOverride ? startOverride.year : parseInt(parts[0], 10);
    var startMonth = startOverride ? startOverride.month : parseInt(parts[1], 10) - 1; // 0-based
    var calEl = document.createElement('div');
    calEl.className = 'term-calendar';
    for (var mi = 0; mi < (monthCount || 12); mi++) {
      var mo = (startMonth + mi) % 12;
      var yr = startYear + Math.floor((startMonth + mi) / 12);
      var mEl = document.createElement('div');
      mEl.className = 'cal-month';
      var hdr = document.createElement('div');
      hdr.className = 'cal-month-hdr';
      hdr.textContent = MONTHS[mo].toUpperCase() + ' ' + yr;
      mEl.appendChild(hdr);
      var dowRow = document.createElement('div');
      dowRow.className = 'cal-dow';
      DOW.forEach(function(n) { var s = document.createElement('span'); s.textContent = n; dowRow.appendChild(s); });
      mEl.appendChild(dowRow);
      var grid = document.createElement('div');
      grid.className = 'cal-days';
      var firstDow = new Date(Date.UTC(yr, mo, 1)).getUTCDay();
      var daysInMo = new Date(Date.UTC(yr, mo + 1, 0)).getUTCDate();
      for (var i = 0; i < firstDow; i++) { var em = document.createElement('span'); em.className = 'cal-day'; grid.appendChild(em); }
      for (var d = 1; d <= daysInMo; d++) {
        var iso = yr + '-' + pad2(mo + 1) + '-' + pad2(d);
        var isArg = argDays.has(iso);
        var isDec = decDays.has(iso);
        var isSel = (iso === selectedDate);
        var dayEl = document.createElement('span');
        var cls = 'cal-day';
        if (isArg && isDec) cls += ' cal-arg-dec';
        else if (isArg) cls += ' cal-arg';
        else if (isDec) cls += ' cal-dec';
        if (isSel) cls += ' cal-sel';
        dayEl.className = cls;
        dayEl.textContent = d;
        dayEl.dataset.iso = iso; // looked up later to apply .cal-minutes, once dates.json (a separate, optional fetch) resolves
        if (isArg || isDec) wireCalDayNav(dayEl, termId, iso);
        if (onMinutesDrop) wireCalDayDropTarget(dayEl, iso, onMinutesDrop);
        grid.appendChild(dayEl);
      }
      mEl.appendChild(grid);
      calEl.appendChild(mEl);
    }
    container.appendChild(calEl);
  }

  // A date's own groups array isn't necessarily stored in the record's
  // actual physical/chronological order (e.g. a later drag-and-drop edit can
  // append a newly created group after an older one) — src embeds the roll
  // number directly (".../M215-013/M215-013-$page:4.jpg") in a reliably,
  // lexicographically-sortable form, unlike href's opaque catalog naId, so
  // sorting by it is what actually recovers record-group order. Shared by
  // every place that combines more than one group's pages for display, and
  // by handleMinutesDrop below so a date's groups are written back in this
  // same order — otherwise a wrong in-memory order could get baked in
  // permanently once scripts/parse_minutes.js applies it and marks the
  // group "modified" (never resorted again after that).
  function sortGroupsBySrc(groups) {
    return groups.slice().sort(function (a, b) {
      return (a.src || '').localeCompare(b.src || '');
    });
  }

  // "Minutes Pages: 522-528, 601, 603-609" — collapses each run of consecutive
  // page numbers into an "A-D" range, listing separate runs (or a lone page)
  // comma-separated. Kept per-group (not one flat sort across every page in
  // datesData[iso]) since a date occasionally spans two physical minutes
  // volumes (see 1889-05-13) whose page numbers restart and would otherwise
  // interleave in a single numeric sort — sortGroupsBySrc above puts them in
  // the record's own physical order first.
  function formatMinutesTooltip(groups) {
    if (!Array.isArray(groups)) return '';
    var parts = [];
    sortGroupsBySrc(groups).filter(function (g) { return g.type === 'minutes'; }).forEach(function (g) {
      var pages = Array.from(new Set(g.pages || [])).sort(function (a, b) { return a - b; });
      if (!pages.length) return;
      var ranges = [];
      var start = pages[0], prev = pages[0];
      for (var i = 1; i <= pages.length; i++) {
        var cur = pages[i];
        if (cur === prev + 1) { prev = cur; continue; }
        ranges.push(start === prev ? String(start) : start + '-' + prev);
        start = cur; prev = cur;
      }
      parts.push(ranges.join(', '));
    });
    return parts.length ? 'Minutes Pages: ' + parts.join(', ') : '';
  }

  // The first page number a date's Minutes would show — same group-then-page
  // ordering as sortGroupsBySrc/renderMinutesPagesList's own flatPages, so
  // this always matches whichever page ends up first in that list. Used to
  // deep-link a calendar day straight to it (see wireCalDayNav's "page" URL
  // param and applyMinutesTooltipToDay below). Null if none.
  function firstMinutesPage(groups) {
    if (!Array.isArray(groups)) return null;
    var sorted = sortGroupsBySrc(groups);
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i].type !== 'minutes') continue;
      var pages = sorted[i].pages;
      if (Array.isArray(pages) && pages.length) return Math.min.apply(null, pages);
    }
    return null;
  }

  // Applies (or clears) the .cal-minutes green digit color + tooltip + nav
  // link (plus its "page" deep-link — see wireCalDayNav) for one already-
  // rendered calendar day cell, given its final "Minutes Pages: …" tooltip
  // text (or '' if it has none) and first page number. Shared by the initial
  // per-term render below, the all-terms progressive calendar, and the
  // drag-and-drop Minutes editing's live refresh of a single day.
  function applyMinutesTooltipToDay(dayEl, tooltip, termId, iso, page) {
    if (!dayEl) return;
    if (tooltip) {
      dayEl.classList.add('cal-minutes');
      dayEl.title = tooltip;
      if (page != null) dayEl.dataset.minutesPage = String(page);
      else delete dayEl.dataset.minutesPage;
      wireCalDayNav(dayEl, termId, iso); // no-op if already wired (e.g. an argument/decision day)
    } else {
      dayEl.classList.remove('cal-minutes');
      dayEl.removeAttribute('title');
      delete dayEl.dataset.minutesPage;
      // Only a minutes-only day's own nav link should ever be torn down —
      // an argument/decision day keeps its link regardless of minutes.
      var hasEventFill = dayEl.classList.contains('cal-arg') || dayEl.classList.contains('cal-dec') || dayEl.classList.contains('cal-arg-dec');
      if (!hasEventFill) unwireCalDayNav(dayEl);
    }
  }

  // Colors in the day digits (see .cal-minutes in pages.css) for every date
  // in a term's dates.json that has at least one non-empty type:"minutes"
  // group's own pages — applied as a post-render pass (via each day's
  // data-iso, set in renderTermCalendar above) rather than a
  // renderTermCalendar parameter, since dates.json is a separate, optional
  // per-term fetch and most terms don't have one at all.
  function applyMinutesHighlight(calEl, datesData, termId) {
    if (!datesData || !calEl) return;
    Object.keys(datesData).forEach(function (iso) {
      var dayEl = calEl.querySelector('[data-iso="' + iso + '"]');
      applyMinutesTooltipToDay(dayEl, formatMinutesTooltip(datesData[iso]), termId, iso, firstMinutesPage(datesData[iso]));
    });
  }

  // Selects one Minutes Pages link (see renderMinutesPagesList below),
  // clearing any previously-selected one — shared by the click handler there
  // and by the 'ussc-minutes-index' message listener further down, which
  // keeps this in sync with Left/Right arrow navigation inside the doc
  // viewer's own image gallery once it's open.
  function selectMinutesPage(el) {
    if (selectedMinutesPageEl && selectedMinutesPageEl !== el) selectedMinutesPageEl.classList.remove('minutes-page-selected');
    if (el) el.classList.add('minutes-page-selected');
    selectedMinutesPageEl = el;
  }

  // Keeps the "page" URL param in sync with whatever Minutes page is
  // actually being shown in the doc viewer — both this iframe's own URL
  // (replaceState, so this doesn't spam browser history — one entry per
  // Minutes Pages list visited, not per page flipped through within it; also
  // means a plain refresh lands back on the page last viewed) and, via
  // postMessage, the top-level SPA URL the visitor actually sees in their
  // address bar. Called on a genuine (non-Shift) page click and by the
  // 'ussc-minutes-index' listener below (Left/Right arrow nav).
  function updateUrlPageParam(page) {
    var url = new URL(location.href);
    url.searchParams.set('page', String(page));
    history.replaceState(null, '', url.toString());
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'ussc-update-page', page: String(page) }, location.origin);
    }
  }

  // Reverses updateUrlPageParam — strips the "page" URL param (both this
  // iframe's own and, via postMessage, the top-level SPA's) and reverts the
  // doc viewer to its minimized/unshown state, same as its own close
  // button. Called when the currently-selected Minutes page number is
  // clicked again (see renderMinutesPagesList below) — a toggle-off, since
  // there's otherwise no way to leave the Minutes viewer without picking a
  // different day/case.
  function clearUrlPageParam() {
    var url = new URL(location.href);
    url.searchParams.delete('page');
    // #minutes (see wireCalDayNav above) only ever exists to scroll the
    // Minutes heading into view while actively showing a page — meaningless,
    // and left dangling in the address bar, once there's no page shown.
    if (url.hash === '#minutes') url.hash = '';
    history.replaceState(null, '', url.toString());
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'ussc-close-minutes-page' }, location.origin);
    }
  }

  // Renders (or re-renders) the Minutes Pages list for the currently viewed
  // ?date= from termDatesData[date] (shared state declared further below,
  // populated once termDatesPromise resolves) — called once then, and again
  // after any drag-and-drop edit (see handleMinutesDrop below) that touches
  // this date. Every page's own direct image URL (src, literal "$page:4"
  // placeholder zero-padded to 4 digits) and its own NARA catalog-page URL
  // (href, "$page" substituted) are precomputed into the parallel
  // minutesPageSrcs/minutesPageHrefs arrays below and passed as a whole to
  // wireDocLink's images/hrefs params, so clicking any one page opens the
  // doc viewer's image gallery there (showing src), with Left/Right able to
  // page through this entire date's Minutes without reopening it, and the
  // doc viewer's own "open in new tab" icon tracking each page's own href —
  // Shift-click instead opens just that one page's href in a new tab
  // directly (wireDocLink's usual convention).
  function renderMinutesPagesList() {
    var container = document.getElementById('date-minutes-list');
    var section = document.getElementById('minutes');
    container.innerHTML = '';
    selectedMinutesPageEl = null;
    minutesPageEls = [];
    var groups = termDatesData && termDatesData[date];
    if (!Array.isArray(groups) || !groups.length) { section.hidden = true; return; }
    // Flatten in the groups' own record order (sortGroupsBySrc above), not a
    // single global page-number sort — a date's proceedings occasionally
    // roll from one physical minutes volume into the next (see 1889-05-13,
    // ending v.17 then starting v.18), and v.18's low page numbers would
    // otherwise sort ahead of v.17's high ones. Pages within each group are
    // still sorted ascending (should already be in that order in
    // dates.json, but sorted here defensively).
    var flatPages = [];
    sortGroupsBySrc(groups).filter(function (g) { return g.type === 'minutes'; }).forEach(function (g) {
      // Deduplicated defensively — a page should only ever be listed once
      // for a given date (handleMinutesDrop below guards against creating a
      // duplicate in the first place, but this keeps a stray one, from
      // before that guard existed or a hand-edited dates.json, from ever
      // rendering twice).
      var pages = Array.from(new Set(g.pages || [])).sort(function (a, b) { return a - b; });
      pages.forEach(function (page) {
        flatPages.push({ page: page, href: g.href, src: g.src });
      });
    });
    if (!flatPages.length) { section.hidden = true; return; }
    // Kept as two parallel arrays (rather than collapsed into one, src
    // preferred) so the doc viewer can display the image (src) while its
    // "open in new tab" icon still links to the NARA catalog page (href) —
    // see wireDocLink's own src/hrefs params.
    var minutesPageSrcs = flatPages.map(function (fp) {
      var page4 = String(fp.page).padStart(4, '0');
      return fp.src ? fp.src.replace('$page:4', page4) : null;
    });
    var minutesPageHrefs = flatPages.map(function (fp) {
      return fp.href ? fp.href.replace('$page', fp.page) : null;
    });
    // "Page N" for a single page; "Pages N1, N2, N3" for several — saves
    // repeating "Page" once per link when there's more than one.
    container.appendChild(document.createTextNode(flatPages.length === 1 ? 'Page ' : 'Pages '));
    flatPages.forEach(function (fp, i) {
      if (i > 0) container.appendChild(document.createTextNode(', '));
      var page = fp.page;
      var a = document.createElement('a');
      a.textContent = String(page);
      // Draggable onto a calendar day — see handleMinutesDrop below — to
      // move this page (and every later page in the same source group) to
      // that date; click still opens the page (in the doc viewer's image
      // gallery, positioned at this page — see wireDocLink above) and
      // additionally highlights it (see .minutes-page-selected in
      // pages.css), clearing any previously-selected page in this same
      // list — unless it's already the selected one, in which case the
      // click instead toggles it off (see the listener registered just
      // below, ahead of wireDocLink's own).
      a.draggable = true;
      a.dataset.page = String(page);
      a.title = 'Click to view this page (click again to close) or Shift+Click to view in a new tab. '
        + 'Drag onto a calendar day (anywhere in this term) to move the page to that date, '
        + 'or onto the « / » term nav buttons to continue it into the adjacent term’s own last/first Minutes date; '
        + 'Shift+Drag to also leave this page behind at its own date. '
        + 'Later pages move along too if the target is later, earlier pages if the target is earlier.';
      var src  = minutesPageSrcs[i];
      var href = minutesPageHrefs[i] || src;
      // Toggle off: clicking the already-selected page again reverts to the
      // unshown state (clears ?page=, unhighlights, hides the doc viewer)
      // instead of reopening it. Registered ahead of wireDocLink's own click
      // listener (added next) so stopImmediatePropagation here pre-empts
      // both it and the plain-select listener below.
      a.addEventListener('click', function (e) {
        if (e.shiftKey || !a.classList.contains('minutes-page-selected')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        selectMinutesPage(null);
        clearUrlPageParam();
      });
      wireDocLink(a, href, termTitle(term) + ' Minutes, p. ' + page, 'pane', href, minutesPageSrcs, i, src, minutesPageHrefs);
      a.addEventListener('click', function (e) {
        selectMinutesPage(a);
        // Shift-click opens in a new tab (wireDocLink above) rather than this
        // page's own doc viewer, so it doesn't change what's actually shown
        // here — the URL shouldn't follow it.
        if (!e.shiftKey) updateUrlPageParam(page);
      });
      a.addEventListener('dragstart', function (e) {
        // 'move' alone would make the drop target's own dropEffect = 'copy'
        // (set on dragover when Shift is held — see wireCalDayDropTarget)
        // invalid per the HTML5 DnD spec, which some browsers then enforce
        // by silently refusing the drop altogether — 'copyMove' allows both,
        // since a plain drag and a Shift+drag both need to work here.
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', JSON.stringify({ iso: date, page: page }));
      });
      minutesPageEls.push(a);
      container.appendChild(a);
    });
    section.hidden = false;
  }

  // Opens the doc viewer straight to a ?page=N URL param, exactly as if the
  // visitor had clicked that page's own link in the just-rendered Minutes
  // Pages list — used both for a plain link to this date/page and for a
  // calendar day's own deep link (see wireCalDayNav's "page" param, set from
  // applyMinutesTooltipToDay's dayEl.dataset.minutesPage). A synthetic
  // .click() (rather than re-deriving the gallery images/index here) reuses
  // wireDocLink's own click handler as-is, so this can never drift from what
  // a real click does. No-op if there's no ?page= param or it doesn't match
  // any page actually rendered for this date.
  function openMinutesPageFromUrl() {
    var pageParam = params.get('page');
    if (!pageParam) return;
    for (var i = 0; i < minutesPageEls.length; i++) {
      if (minutesPageEls[i].dataset.page === pageParam) { minutesPageEls[i].click(); return; }
    }
  }

  // Keeps the Minutes Pages list's own highlighted page (and the "page" URL
  // param — see updateUrlPageParam above) in sync with Left/Right arrow (or
  // the prev/next buttons) inside the doc viewer's image gallery, once
  // wireDocLink above has opened one from a page click — explorer.js relays
  // the gallery's own current index down to this iframe as this message
  // whenever it changes (see assets/img-viewer.html and the 'ussc-open-doc'
  // handler in explorer.js). Ignored if this date's list has since been
  // re-rendered for some other date (minutesPageEls swapped out from under
  // it) or the index is out of range for it.
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin) return;
    if (e.data && e.data.type === 'ussc-minutes-index' && typeof e.data.index === 'number') {
      var el = minutesPageEls[e.data.index];
      if (el) {
        selectMinutesPage(el);
        updateUrlPageParam(el.dataset.page);
      }
    }
  });

  // Refreshes one calendar day's .cal-minutes highlighting/tooltip from the
  // current (possibly just-edited) termDatesData — used after a drag-and-
  // drop Minutes edit below.
  function refreshMinutesCalendarDay(iso) {
    if (!calContainer) return;
    var dayEl = calContainer.querySelector('[data-iso="' + iso + '"]');
    applyMinutesTooltipToDay(dayEl, formatMinutesTooltip(termDatesData[iso]), term, iso, firstMinutesPage(termDatesData[iso]));
  }

  // Drag-and-drop Minutes editing: dropping a page link from the Minutes
  // Pages list (see renderMinutesPagesList above) onto a calendar day moves
  // that page and every later page in its own source group over to the
  // target date (see splitMovingPages below for the exact Shift-key/
  // direction semantics). The moved page(s) are prepended to the target
  // date's matching group if the target date is later than the source
  // (continuing right where the source's later pages left off), or appended
  // if the target is earlier (coming right before the source's own
  // remaining pages). A group is matched across dates by its own href (the
  // same physical volume); one is created — with the same type/href/src as
  // the source, starting empty — if the target date has no matching group
  // yet. Drops are allowed anywhere within the term, not just onto a
  // chronologically adjacent date — some terms have real discontinuities in
  // their own page numbering (a volume's pages resuming several dates later
  // than where they left off), so restricting to neighboring dates only
  // made those unreachable by drag-and-drop. If a move empties the source
  // group, it's kept in place with an empty pages rather than removed — a
  // tombstone, so
  // scripts/parse_minutes.js's own applyDateOverrides (which tags every
  // group an override touches with "modified": true) can still record that
  // this date+volume was deliberately cleared, and its own OCR-driven Pass 3
  // will then never silently repopulate it on a later re-run
  // (renderMinutesCoverThumbnails below skips a tombstone's empty pages when
  // picking a cover's earliest real date). Every touched date's full new
  // value is written to localStorage as a standing override — see
  // LS_DATES_KEY above and window._downloadDateOverrides in
  // storage-actions.js. See handleAdjacentTermMinutesDrop further down for
  // the analogous cross-term-boundary version of this drop, dropped onto the
  // stat-prev-term/stat-next-term nav buttons instead of a calendar day.
  //
  // Splits a source Minutes group's sorted pages into the pages that move to
  // the target and the pages that stay behind, given whether Shift was held
  // (keepSource) and whether the drop target precedes the source
  // chronologically (targetEarlier). Shared by handleMinutesDrop and
  // handleAdjacentTermMinutesDrop below so both apply the exact same
  // direction/Shift semantics, which are fully orthogonal: direction alone
  // decides *which* pages besides the dragged one are swept along (later
  // target → the dragged page and everything after it, continuing the
  // sequence forward; earlier target → the dragged page and everything
  // before it, the mirror image — the boundary between the two days' own
  // proceedings sits right at the dragged page either way); Shift alone
  // decides whether the dragged page *itself* additionally stays behind at
  // the source too (copied — its proceedings genuinely belong to both days)
  // or leaves entirely (a plain move) — the rest of the swept set always
  // leaves regardless of Shift, same in both directions.
  function splitMovingPages(pages, sourcePage, keepSource, targetEarlier) {
    var splitIdx = pages.indexOf(sourcePage);
    if (targetEarlier) {
      return {
        moving: pages.slice(0, splitIdx + 1),
        staying: keepSource ? pages.slice(splitIdx) : pages.slice(splitIdx + 1),
      };
    }
    return {
      moving: pages.slice(splitIdx),
      staying: keepSource ? pages.slice(0, splitIdx + 1) : pages.slice(0, splitIdx),
    };
  }

  function handleMinutesDrop(sourceIso, sourcePage, targetIso, keepSource) {
    if (!termDatesData || sourceIso === targetIso) return;
    var groups = termDatesData[sourceIso];
    if (!Array.isArray(groups)) return;
    var srcIdx = groups.findIndex(function (g) {
      return g.type === 'minutes' && Array.isArray(g.pages) && g.pages.indexOf(sourcePage) !== -1;
    });
    if (srcIdx === -1) return;
    var srcGroup = groups[srcIdx];

    var pages = srcGroup.pages.slice().sort(function (a, b) { return a - b; });
    var split = splitMovingPages(pages, sourcePage, keepSource, targetIso < sourceIso);
    var moving = split.moving, staying = split.staying;
    var newSourceGroups = groups.slice();
    newSourceGroups[srcIdx] = Object.assign({}, srcGroup, { pages: staying });
    termDatesData[sourceIso] = sortGroupsBySrc(newSourceGroups);

    // Matched by href AND src together — the same physical volume/record
    // group, never just one or the other.
    var targetGroups = Array.isArray(termDatesData[targetIso]) ? termDatesData[targetIso].slice() : [];
    var tgtIdx = targetGroups.findIndex(function (g) {
      return g.type === 'minutes' && g.href === srcGroup.href && g.src === srcGroup.src;
    });
    var tgtGroup;
    if (tgtIdx === -1) {
      tgtGroup = { type: 'minutes', href: srcGroup.href, src: srcGroup.src };
      tgtGroup.pages = [];
      targetGroups.push(tgtGroup);
      tgtIdx = targetGroups.length - 1;
    } else {
      tgtGroup = Object.assign({}, targetGroups[tgtIdx], { pages: (targetGroups[tgtIdx].pages || []).slice() });
    }

    // A page should only ever be listed once for a given date — drop any
    // page(s) the target already has (e.g. re-doing the same drag a second
    // time) rather than duplicating them. Nothing new to add there is still
    // a complete, valid drop — the source-side change above stands either way.
    var toAdd = moving.filter(function (p) { return tgtGroup.pages.indexOf(p) === -1; });
    tgtGroup.pages = (targetIso > sourceIso)
      ? toAdd.concat(tgtGroup.pages)
      : tgtGroup.pages.concat(toAdd);
    targetGroups[tgtIdx] = tgtGroup;
    termDatesData[targetIso] = sortGroupsBySrc(targetGroups);

    var overrides = loadDateOverrides();
    overrides[sourceIso] = termDatesData[sourceIso]; // always a real (possibly tombstoned) array now — see above
    overrides[targetIso] = termDatesData[targetIso];
    saveDateOverrides(overrides);

    refreshMinutesCalendarDay(sourceIso);
    refreshMinutesCalendarDay(targetIso);
    if (date === sourceIso) renderMinutesPagesList();
    renderMinutesCoverThumbnails();
  }

  // Wires the stat-prev-term/stat-next-term nav button (see the term-nav
  // fetch further down) as a drop target for a Minutes page drag, same
  // gesture as wireCalDayDropTarget above but calling
  // handleAdjacentTermMinutesDrop below instead — continuing a page sequence
  // into whichever date at the far edge of the adjacent term already carries
  // a matching src, rather than a date within this term.
  function wireAdjacentTermDropTarget(btnEl, direction) {
    btnEl.addEventListener('dragover', function (e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.shiftKey ? 'copy' : 'move';
    });
    btnEl.addEventListener('dragenter', function () { btnEl.classList.add('cal-drop-target'); });
    btnEl.addEventListener('dragleave', function () { btnEl.classList.remove('cal-drop-target'); });
    btnEl.addEventListener('drop', function (e) {
      e.preventDefault();
      btnEl.classList.remove('cal-drop-target');
      var raw = e.dataTransfer.getData('text/plain');
      if (!raw) return;
      var payload;
      try { payload = JSON.parse(raw); } catch (err) { return; }
      if (payload && payload.iso && payload.page != null) {
        handleAdjacentTermMinutesDrop(payload.iso, payload.page, direction, e.shiftKey);
      }
    });
  }

  // Cross-term-boundary counterpart to handleMinutesDrop above: dropping a
  // page onto stat-prev-term continues its own volume onto the *last* date
  // with Minutes in the previous term (appending, same as dropping on an
  // earlier date within this term would); dropping onto stat-next-term
  // continues it onto the *first* date with Minutes in the next term
  // (prepending, same as dropping on a later date would) — see
  // splitMovingPages above for the exact moving/staying split this reuses.
  // Unlike handleMinutesDrop, this never invents a new group on the far side
  // of a term boundary: if that edge date's own Minutes aren't the same
  // volume (matched by src alone — a term boundary is exactly the kind of
  // place a volume is expected to end, so requiring an existing matching
  // group here, rather than href+src together like within a term, keeps the
  // bar for "same volume" no stricter than necessary), the drop fails
  // outright with an alert rather than silently starting an unrelated
  // volume there.
  function handleAdjacentTermMinutesDrop(sourceIso, sourcePage, direction, keepSource) {
    if (!termDatesData) return;
    var groups = termDatesData[sourceIso];
    if (!Array.isArray(groups)) return;
    var srcIdx = groups.findIndex(function (g) {
      return g.type === 'minutes' && Array.isArray(g.pages) && g.pages.indexOf(sourcePage) !== -1;
    });
    if (srcIdx === -1) return;
    var srcGroup = groups[srcIdx];
    var directionLabel = direction === 'prev' ? 'previous' : 'next';

    (direction === 'prev' ? prevTermIdPromise : nextTermIdPromise).then(function (adjTermId) {
      if (!adjTermId) {
        alert('There’s no ' + directionLabel + ' term to move this page into.');
        return;
      }
      fetch('/courts/ussc/terms/' + adjTermId + '/dates.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (raw) {
          // adjTermId here, NOT the source term (see applyDateOverrides'
          // own termId/termStarts doc comment) — this is the one call site
          // that merges local overrides onto a term other than whichever
          // one the visitor is actually viewing, so without this guard a
          // still-pending override for some *other* date the visitor was
          // mid-editing elsewhere (in this same term or a third one) could
          // get mistaken for a genuinely new date within adjTermId, sorting
          // in ahead of its real first/last Minutes date below and quietly
          // stealing the dragged page(s) into the wrong term entirely.
          var adjData = applyDateOverrides(raw, adjTermId, termStarts);
          var minutesIsos = Object.keys(adjData).filter(function (iso) {
            var g = adjData[iso];
            return Array.isArray(g) && g.some(function (x) { return x.type === 'minutes' && Array.isArray(x.pages) && x.pages.length; });
          }).sort();
          if (!minutesIsos.length) {
            alert('Can’t move this page — the ' + directionLabel + ' term (' + termTitle(adjTermId) + ') has no Minutes.');
            return;
          }
          var targetIso = direction === 'prev' ? minutesIsos[minutesIsos.length - 1] : minutesIsos[0];
          var targetGroups = adjData[targetIso].slice();
          var tgtIdx = targetGroups.findIndex(function (g) { return g.type === 'minutes' && g.src === srcGroup.src; });
          if (tgtIdx === -1) {
            alert('Can’t move this page — the ' + directionLabel + ' term’s ' + (direction === 'prev' ? 'last' : 'first')
              + ' Minutes date (' + targetIso + ') isn’t the same volume.');
            return;
          }

          var pages = srcGroup.pages.slice().sort(function (a, b) { return a - b; });
          var split = splitMovingPages(pages, sourcePage, keepSource, direction === 'prev');
          var newSourceGroups = groups.slice();
          newSourceGroups[srcIdx] = Object.assign({}, srcGroup, { pages: split.staying });
          termDatesData[sourceIso] = sortGroupsBySrc(newSourceGroups);

          var tgtGroup = Object.assign({}, targetGroups[tgtIdx], { pages: (targetGroups[tgtIdx].pages || []).slice() });
          var toAdd = split.moving.filter(function (p) { return tgtGroup.pages.indexOf(p) === -1; });
          tgtGroup.pages = direction === 'prev'
            ? tgtGroup.pages.concat(toAdd)
            : toAdd.concat(tgtGroup.pages);
          targetGroups[tgtIdx] = tgtGroup;
          adjData[targetIso] = sortGroupsBySrc(targetGroups);

          var overrides = loadDateOverrides();
          overrides[sourceIso] = termDatesData[sourceIso]; // always a real (possibly tombstoned) array now — see above
          overrides[targetIso] = adjData[targetIso];
          saveDateOverrides(overrides);

          refreshMinutesCalendarDay(sourceIso); // targetIso belongs to the adjacent term's own (unrendered here) calendar
          if (date === sourceIso) renderMinutesPagesList();
          renderMinutesCoverThumbnails();
        });
    });
  }

  // localStorage key for this browser's own local edits to any term's
  // dates.json — see the Minutes drag-and-drop editing further down, and
  // window._downloadDateOverrides in storage-actions.js. Value is a flat map
  // of ISO date -> full replacement array-of-groups (the same shape a
  // dates.json entry itself uses — an emptied-out group is kept as a
  // zero-page tombstone rather than removed, see handleMinutesDrop below),
  // or null for a date whose entry should be removed entirely (not produced
  // by the drag-and-drop editing itself, but still honored here). Kept as
  // one flat map, not one per term, since a given ISO date can only ever
  // belong to a single term.
  var LS_DATES_KEY = 'aa-dates-overrides';

  function loadDateOverrides() {
    try { return JSON.parse(localStorage.getItem(LS_DATES_KEY) || '{}'); } catch (e) { return {}; }
  }

  function saveDateOverrides(overrides) {
    try {
      if (Object.keys(overrides).length) localStorage.setItem(LS_DATES_KEY, JSON.stringify(overrides));
      else localStorage.removeItem(LS_DATES_KEY);
    } catch (e) { /* storage full/unavailable — the edit stays in memory for this page view only */ }
  }

  // Normalizes a group array purely for equality comparison (never written
  // back anywhere) — sorted by src (sortGroupsBySrc above), each group's own
  // pages deduplicated, sorted, and split into one entry per gap-free
  // consecutive run (mirrors scripts/parse_minutes.js's own
  // normalizeOverrideGroups, kept in sync by hand — see its doc comment for
  // why a merged group's pages aren't guaranteed contiguous, and why
  // comparing them unsplit against the server's own always-split-on-write
  // groups would never converge), and any "modified": true flag dropped
  // (scripts/parse_minutes.js's own applyDateOverrides stamps that onto
  // every group it writes; this browser's own copy never has it). Without
  // this, an override that's otherwise identical to what the server now has
  // — just, say, a stray duplicate page number left over from before
  // handleMinutesDrop's own dedup guard existed — would never be recognized
  // as "already applied" and would keep showing up in "Download Dates" forever.
  function canonicalizeGroups(groups) {
    if (!Array.isArray(groups)) return null;
    var expanded = [];
    groups.forEach(function (g) {
      // A case-detail object (see update_cases.js's syncCrossTermCaseDates) —
      // nothing here applies to it, so it passes through untouched.
      if (g.type !== 'minutes') { expanded.push(g); return; }
      var pages = Array.from(new Set(g.pages || [])).sort(function (a, b) { return a - b; });
      var flushRun = function (first, last) {
        var runPages = [];
        for (var p = first; p <= last; p++) runPages.push(p);
        var copy = Object.assign({}, g);
        delete copy.modified;
        copy.pages = runPages;
        expanded.push(copy);
      };
      if (!pages.length) { flushRun(0, -1); return; } // empty tombstone — one zero-page run
      var runStart = pages[0], prev = pages[0];
      for (var i = 1; i < pages.length; i++) {
        if (pages[i] === prev + 1) { prev = pages[i]; continue; }
        flushRun(runStart, prev);
        runStart = pages[i]; prev = pages[i];
      }
      flushRun(runStart, prev);
    });
    return sortGroupsBySrc(expanded);
  }

  // On disk, a Minutes-scan group's own "pages" is a "<first>-<last>" range
  // string (see scripts/parse_minutes.js's own parsePagesRange/
  // formatPagesRange doc comment for why) — every array-based site in this
  // file (formatMinutesTooltip, handleMinutesDrop, splitMovingPages, etc.)
  // works with the expanded array form instead, same as it always has, so a
  // freshly-fetched dates.json payload is normalized through this
  // immediately below, before anything else touches it. This browser
  // session's own local overrides/download (see LS_DATES_KEY) stay in array
  // form throughout — only the on-disk file itself uses the string. Every
  // dates.json object is identified by its own "type" prop — "minutes" for
  // a Minutes-scan group, "argument"/"reargument" for a cross-term
  // case-detail pointer (see update_cases.js's syncCrossTermCaseDates) —
  // never by which props happen to be present.
  function parsePagesRange(v) {
    if (Array.isArray(v)) return v.slice(); // tolerate not-yet-migrated data
    if (typeof v !== 'string' || !v) return [];
    var m = /^(\d+)-(\d+)$/.exec(v);
    if (!m) return [];
    var first = parseInt(m[1], 10), last = parseInt(m[2], 10);
    if (last < first) return [];
    var out = [];
    for (var p = first; p <= last; p++) out.push(p);
    return out;
  }
  function expandDatesPages(raw) {
    if (!raw) return raw;
    Object.keys(raw).forEach(function (iso) {
      var groups = raw[iso];
      if (!Array.isArray(groups)) return;
      groups.forEach(function (g) {
        if (!g || typeof g !== 'object') return;
        // Self-heals an old-shape Minutes group (minutes_url/minutes_src/
        // minutes_pages, no "type") into the current shape.
        if (g.type == null && ('minutes_href' in g || 'minutes_src' in g || 'minutes_pages' in g)) {
          g.type = 'minutes';
          if ('minutes_href' in g) { g.href = g.minutes_href; delete g.minutes_href; }
          if ('minutes_src' in g) { g.src = g.minutes_src; delete g.minutes_src; }
          if ('minutes_pages' in g) { g.pages = g.minutes_pages; delete g.minutes_pages; }
        }
        if (g.type === 'minutes') g.pages = parsePagesRange(g.pages);
      });
    });
    return raw;
  }

  // Layers this browser's own local date overrides on top of a term's
  // server-fetched dates.json (raw is null if the term has none), and prunes
  // any override that now matches — or is no longer meaningfully different
  // from — the server's own current data, e.g. once scripts/parse_minutes.js
  // has applied a downloaded override upstream, it's no longer a real
  // customization and shouldn't keep showing up in "Download Dates".
  //
  // An override only ever represents a Minutes edit (see handleMinutesDrop —
  // dragging a Minutes page is the only thing that ever writes one), never a
  // case-detail object (update_cases.js's syncCrossTermCaseDates) — those
  // are entirely server-managed. So for a date with an override, this always
  // takes that override's own Minutes groups but the *server's current*
  // case-detail objects, not whatever the override's own snapshot happened
  // to capture at edit time — otherwise an override from before a case was
  // added there (or after one was later removed) would silently hide it.
  //
  // overrides is a single FLAT map spanning every term the visitor has ever
  // edited in this browser, not just `raw`'s own term — so an override whose
  // ISO date isn't already a key in `raw` is ambiguous on its own; it might
  // genuinely be a brand-new date within this term, or it might belong to a
  // completely different term the visitor is also mid-edit on elsewhere
  // (handleAdjacentTermMinutesDrop below merges onto a *different* term's own
  // freshly-fetched data for exactly this reason). termId/termStarts, when
  // given, resolve that ambiguity via termForDate above — the same rule
  // scripts/parse_minutes.js's own applyDateOverrides uses server-side — and
  // any such foreign-term override is skipped rather than injected as a
  // fabricated new date. Both optional so every other call site (which only
  // ever merges onto its own current term, where any "not yet in raw" key
  // clearly belongs there) keeps working unchanged.
  function applyDateOverrides(raw, termId, starts) {
    raw = expandDatesPages(raw);
    var overrides = loadDateOverrides();
    var keys = Object.keys(overrides);
    if (!keys.length) return raw || {};
    var merged = Object.assign({}, raw || {});
    var pruned = false;
    keys.forEach(function (iso) {
      var val = overrides[iso];
      var serverVal = (raw && raw[iso]) || null;
      if (serverVal == null && termId && starts && termForDate(iso, starts) !== termId) return;
      if (JSON.stringify(canonicalizeGroups(val)) === JSON.stringify(canonicalizeGroups(serverVal))) {
        delete overrides[iso];
        pruned = true;
        return;
      }
      // null means "remove this date's own Minutes entirely" (a downloaded-
      // overrides-file thing, not something drag-and-drop itself ever
      // produces — see loadDateOverrides above) — server case-detail objects
      // still survive that, same as a real override's own minutes groups
      // below, since neither kind of override was ever about them.
      var serverCaseObjs = (serverVal || []).filter(function (g) { return g.type !== 'minutes'; });
      var minutesGroups = val === null ? [] : val.filter(function (g) { return g.type === 'minutes'; });
      var combined = minutesGroups.concat(serverCaseObjs);
      if (combined.length) merged[iso] = combined; else delete merged[iso];
    });
    if (pruned) saveDateOverrides(overrides);
    return merged;
  }

  var params = new URLSearchParams(location.search);
  var term = params.get('term');
  var date = params.get('date');
  if (!term) return;
  // The note itself is only ever shown alongside the Court Cases table (see
  // _drawCaseListing) — this just seeds the shared value from this page's
  // own initial load; term === 'all' has no such table, so it stays unused
  // there (renderCaseListing is never reached in that branch below).
  _currentFilterParam = params.get('filter');

  if (term === 'all') {
    // Journal covers and the argued/reargued/decided date lists below only ever
    // apply to a single term or a specific date — neither ever populates in the
    // all-terms view, so its otherwise-empty border-bottom separator is just
    // dead space here.
    document.getElementById('date-section').hidden = true;
    document.getElementById('stat-term-title').textContent = 'All Terms';
    fetch('/courts/ussc/terms/terms.json')
      .then(function(r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function(data) {
        // Fill stat boxes from the hidden {name:'All'} container's summary group.
        var summary = null;
        for (var i = data.length - 1; i >= 0; i--) {
          if (data[i].hidden && data[i].groups && data[i].groups[0] && data[i].groups[0].id === 'all') {
            summary = data[i].groups[0]; break;
          }
        }
        if (summary) {
          document.getElementById('stat-decided').textContent      = summary.decided.toLocaleString();
          document.getElementById('stat-argued-cases').textContent  = summary.argued.toLocaleString();
          document.getElementById('stat-argument-days').textContent = summary.argDays.toLocaleString();
          document.getElementById('stat-with-audio').textContent    = summary.audio.toLocaleString();
          revealAudioStat('stat-with-audio', summary.audio > 0);
        }
        // Build per-term chart data from non-hidden group entries. Special terms
        // (e.g. "July Special Term 1942") decide only a handful of cases and
        // create sharp, misleading spikes next to normal full-length terms, so
        // they're excluded from the chart entirely.
        var chartData = [];
        data.forEach(function(decade) {
          if (decade.hidden) return;
          (decade.groups || []).forEach(function(g) {
            if (g.name && /special/i.test(g.name)) return;
            if (g.id && g.decided != null) chartData.push({ t: g.id, d: g.decided, ad: g.argDays, un: g.unanimous });
          });
        });
        if (chartData.length) {
          var histView = document.getElementById('history-view');
          histView.hidden = false;
          renderHistoryChart(histView, chartData);
        }
        var termCount = 0;
        data.forEach(function(d) { termCount += (d.groups || []).length; });
        document.getElementById('stats-note').textContent = 'Totals across all ' + termCount + ' terms';

        // ── Progressive per-term Court Calendar, oldest → newest ───────────
        // One fetch + render per term, deferred until that term's slot is
        // about to scroll into view, so opening term=all doesn't fire ~240
        // cases.json requests up front.
        var allCalTerms = [];
        data.forEach(function(decade) {
          if (decade.hidden) return;
          (decade.groups || []).forEach(function(g) {
            var m = g.file && /\/terms\/([^/]+)\//.exec(g.file);
            if (m) allCalTerms.push({ id: m[1], name: g.name || termTitle(m[1]), dates: g.dates });
          });
        });

        if (allCalTerms.length) {
          document.getElementById('all-terms-calendar-heading').hidden = false;
          var calSection = document.getElementById('all-terms-calendars');
          var slots = {};

          // Clicking a calendar day navigates away to that term's own page
          // (a full reload of this iframe document), so returning via the
          // browser Back button re-loads this page from scratch — a fresh
          // JS context with no memory of what was already fetched/rendered.
          // sessionStorage survives that reload (unlike a plain JS variable)
          // and is shared across same-origin frames in this tab, so it's used
          // here to cache each rendered term's date lists (tiny — ISO date
          // strings plus each minutes day's pre-formatted tooltip text, not
          // full case data) so a Back navigation can redraw everything
          // already seen without re-fetching any cases.json.
          // (Scroll-position restore on Back is handled generically by the
          // page-viewer iframe in explorer.js — no per-page code needed.)
          var SS_CACHE_KEY = 'aa-stats-all-cal-cache';
          var calCache;
          try { calCache = JSON.parse(sessionStorage.getItem(SS_CACHE_KEY) || '{}'); } catch (e) { calCache = {}; }
          function cacheTermDates(termId, argArr, decArr, minArr) {
            calCache[termId] = { arg: argArr, dec: decArr, min: minArr };
            try { sessionStorage.setItem(SS_CACHE_KEY, JSON.stringify(calCache)); } catch (e) { /* storage full/unavailable — caching just won't help this run */ }
          }

          allCalTerms.forEach(function(t, i) {
            // Cap this term's grid at the number of months before the next
            // term starts, so a short special term's calendar doesn't run
            // into (and duplicate) months the next term's grid also covers.
            var monthCount = 12;
            if (i < allCalTerms.length - 1) {
              var a = t.id.split('-'), b = allCalTerms[i + 1].id.split('-');
              var diff = (parseInt(b[0], 10) - parseInt(a[0], 10)) * 12 + (parseInt(b[1], 10) - parseInt(a[1], 10));
              monthCount = Math.max(1, Math.min(12, diff));
            }
            var slot = document.createElement('div');
            slot.className = 'all-cal-term';
            slot.id = t.id;
            slot.dataset.term = t.id;
            var h = document.createElement('h3');
            h.className = 'all-cal-term-heading';
            var hLink = document.createElement('a');
            hLink.textContent = t.name;
            wireSearchLink(hLink, '?term=' + encodeURIComponent(t.id));
            h.appendChild(hLink);
            slot.appendChild(h);
            var body = document.createElement('div');
            slot.appendChild(body);
            calSection.appendChild(slot);
            slots[t.id] = { slot: slot, body: body, monthCount: monthCount, loaded: false, dates: t.dates };
          });

          // Paints one term's calendar from its (already-known) date lists —
          // called either straight from calCache or after a fresh fetch.
          // Assumes the caller has already claimed slots[termId].loaded.
          function paintTermCalendar(termId, argArr, decArr, minArr) {
            var s = slots[termId];
            var argDaySet = new Set(argArr);
            var decDaySet = new Set(decArr);
            if (argDaySet.size || decDaySet.size) {
              renderTermCalendar(s.body, termId, argDaySet, decDaySet, null, s.monthCount);
              (minArr || []).forEach(function (m) {
                applyMinutesTooltipToDay(s.body.querySelector('[data-iso="' + m.iso + '"]'), m.title, termId, m.iso, m.page);
              });
            } else {
              s.slot.hidden = true;
            }
          }

          function loadTermCalendar(termId) {
            var s = slots[termId];
            if (!s || s.loaded) return;
            s.loaded = true; // claim it before any async work so re-intersection can't double-fire
            if (calCache[termId]) {
              var c = calCache[termId];
              paintTermCalendar(termId, c.arg, c.dec, c.min);
              return;
            }
            Promise.all([
              fetch('/courts/ussc/terms/' + termId + '/cases.json')
                .then(function(r) { return r.ok ? r.json() : Promise.reject(r.status); }),
              // dates.json is a separate, optional per-term file — most terms
              // don't have one, so a missing/failed fetch resolves to null
              // rather than rejecting the whole Promise.all. Skipped entirely
              // when terms.json's own "dates" boolean says there's none for
              // this term (see update_cases.js's syncTermsJson).
              (s.dates ? fetch('/courts/ussc/terms/' + termId + '/dates.json')
                .then(function(r) { return r.ok ? r.json() : null; })
                .catch(function() { return null; }) : Promise.resolve(null))
                .then(function (raw) { return applyDateOverrides(raw, termId, termStarts); }),
            ])
              .then(function(results) {
                var cases = results[0], datesData = results[1];
                var argDaySet = new Set();
                var decDaySet = new Set();
                cases.forEach(function(c) {
                  ['argument', 'reargument'].forEach(function(field) {
                    if (c[field]) c[field].split(',').forEach(function(d) { var t = d.trim(); if (t) argDaySet.add(t); });
                  });
                  if (c.decision) c.decision.split(',').forEach(function(d) { var t = d.trim(); if (t) decDaySet.add(t); });
                });
                var minArr = [];
                if (datesData) {
                  Object.keys(datesData).forEach(function (iso) {
                    var tooltip = formatMinutesTooltip(datesData[iso]);
                    if (tooltip) minArr.push({ iso: iso, title: tooltip, page: firstMinutesPage(datesData[iso]) });
                  });
                }
                var argArr = Array.from(argDaySet), decArr = Array.from(decDaySet);
                cacheTermDates(termId, argArr, decArr, minArr);
                paintTermCalendar(termId, argArr, decArr, minArr);
              })
              .catch(function() { s.body.textContent = 'Could not load.'; });
          }

          // Synchronously redraw every term already cached from an earlier
          // visit in this session, before wiring the observer below, so a
          // Back navigation reaches roughly its previous page height (and
          // therefore an accurate scroll target) with zero network requests.
          allCalTerms.forEach(function(t) {
            if (calCache[t.id]) loadTermCalendar(t.id);
          });

          if ('IntersectionObserver' in window) {
            var calObserver = new IntersectionObserver(function(entries) {
              entries.forEach(function(entry) {
                if (!entry.isIntersecting) return;
                loadTermCalendar(entry.target.dataset.term);
                calObserver.unobserve(entry.target);
              });
            }, { rootMargin: '1000px 0px 1000px 0px' });
            allCalTerms.forEach(function(t) {
              if (!slots[t.id].loaded) calObserver.observe(slots[t.id].slot);
            });
          } else {
            // No IntersectionObserver support — fall back to loading everything.
            allCalTerms.forEach(function(t) { loadTermCalendar(t.id); });
          }
        }
      })
      .catch(function() {
        document.getElementById('stats-note').textContent = 'Could not load data.';
      });
    return;
  }
  // Clickable, but deliberately not styled like a link (see .stat-term-title-link
  // in pages.css — plain text color, underline only on hover) — jumps back to
  // this same term's own plain page (no date/page/etc.), e.g. from a ?date=
  // and/or ?page= deep link. Text is refined below (allTerms[idx].name, once
  // terms.json resolves — may differ slightly from termTitle()'s own guess);
  // that later assignment updates titleLink's own textContent, not this
  // element's, so the link itself is only ever created once, here.
  var titleLink = document.createElement('a');
  titleLink.className = 'stat-term-title-link';
  titleLink.textContent = termTitle(term);
  wireSearchLink(titleLink, '?term=' + encodeURIComponent(term));
  var titleEl = document.getElementById('stat-term-title');
  titleEl.textContent = '';
  titleEl.appendChild(titleLink);
  if (date) {
    // The term-wide stat cards (and the audio-availability note below them)
    // don't apply to a single selected date — the date-section above already
    // shows what's relevant for it (arguments/decisions/minutes) — nor to
    // date=all (see below), which trades them for the full 12-month Court
    // Calendar instead of a specific date's own info.
    document.getElementById('stats-grid').hidden = true;
    document.getElementById('stats-note').hidden = true;
    if (date !== 'all') {
      var _dtEl = document.getElementById('stat-date-title'); _dtEl.textContent = fmtDate(date); _dtEl.hidden = false;
    }
  }

  // Shared, mutable state for this term's dates.json (server data + this
  // browser's own local overrides), read and written by the Minutes cover
  // thumbnails, the Minutes Pages list, the calendar's green-digit
  // highlighting, and the drag-and-drop editing between them further below —
  // all three need to agree on the same in-memory object so an edit in one
  // is reflected in the others without a page reload. Fetched once here
  // rather than separately by each of them.
  var termDatesData = null;
  var calContainer = null;
  var selectedMinutesPageEl = null;
  // The Minutes Pages <a> elements currently rendered by renderMinutesPagesList,
  // in the same order as the images array passed to the doc viewer's gallery
  // — so the 'ussc-minutes-index' listener below (Left/Right arrow nav inside
  // that gallery) can look up which link to re-highlight by index alone.
  var minutesPageEls = [];
  // terms.json's own per-term "minutes" array — [{ cover: "m001-cover.jpg" }, ...],
  // in first-appearance (chronological) order — set once the terms.json
  // fetch below resolves; used by renderMinutesCoverThumbnails further down.
  var termMinutesCovers = [];
  // Resolved below, once terms.json's own per-term "dates" boolean is known
  // (see update_cases.js's syncTermsJson) — skips ever fetching dates.json
  // when that's explicitly false (most terms don't have one). Falls back to
  // fetching/probing when it's undefined — terms.json itself failed to load
  // (the .catch below) or this term's own entry wasn't found in it.
  var _resolveTermDatesPromise;
  var termDatesPromise = new Promise(function (resolve) { _resolveTermDatesPromise = resolve; });

  // Resolves to the next chronological term's own id (e.g. "1881-10"), or
  // null if this is the latest term (or terms.json couldn't be loaded at
  // all) — resolved once the terms.json fetch below finds this term's own
  // entry (see nextEntry there). Used by the Court Calendar section further
  // down to stop the grid the month before the next term begins, rather than
  // always showing a flat 12 months that could run into it.
  var _resolveNextTermIdPromise;
  var nextTermIdPromise = new Promise(function (resolve) { _resolveNextTermIdPromise = resolve; });

  // Same as nextTermIdPromise but for the previous chronological term — used
  // by the stat-prev-term/stat-next-term Minutes drag-and-drop targets below
  // (see wireAdjacentTermDropTarget/handleAdjacentTermMinutesDrop) to know
  // which term's own dates.json to fetch and continue a page sequence into.
  var _resolvePrevTermIdPromise;
  var prevTermIdPromise = new Promise(function (resolve) { _resolvePrevTermIdPromise = resolve; });

  // Resolves to this term's own terms.json group entry (carries reports[],
  // needed by _isOrdersCase for the Court Cases table's "orders" filter — see
  // renderCaseListing below), or null if terms.json failed or this term
  // wasn't found in it. Resolved once the terms.json fetch below finds
  // (or fails to find) `entry`.
  var _resolveTermEntryPromise;
  var termEntryPromise = new Promise(function (resolve) { _resolveTermEntryPromise = resolve; });

  // Every known term's own id + start date ("<YYYY>-<MM>-01"), sorted
  // chronologically ascending — filled in once the terms.json fetch below
  // builds allTerms, stays null until then (every consumer already tolerates
  // that — see applyDateOverrides' own termId/termStarts guard). Lets
  // applyDateOverrides (and termForDate just below) tell whether a given ISO
  // date genuinely belongs to the term whose data it's being merged onto,
  // the same "latest term starting on/before this date" rule
  // scripts/parse_minutes.js's own termForDate uses server-side.
  var termStarts = null;

  // Mirrors scripts/parse_minutes.js's own termForDate exactly, so a date is
  // never attributed to a different term client-side than the script would
  // resolve it to once a downloaded override actually gets applied.
  function termForDate(dateStr, starts) {
    var found = null;
    for (var i = 0; i < starts.length; i++) {
      if (starts[i].start <= dateStr) found = starts[i].term; else break;
    }
    return found;
  }

  function _resolveTermDates(hasDates) {
    if (hasDates === false) {
      termDatesData = applyDateOverrides(null, term, termStarts);
      _resolveTermDatesPromise(termDatesData);
      return;
    }
    fetch('/courts/ussc/terms/' + term + '/dates.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (raw) {
        termDatesData = applyDateOverrides(raw, term, termStarts);
        _resolveTermDatesPromise(termDatesData);
      });
  }

  // Oral argument audio only exists starting with October Term 1955 — still
  // used below to decide whether a blank argument-length card gets an
  // explanatory note (a real gap within the audio era) or just stays quietly
  // hidden (expected, pre-era). The six .audio-stat cards themselves default
  // to `hidden` in the markup, one-way revealed below (see revealAudioStat)
  // only once each card's own real, non-zero count is actually in hand —
  // rather than all six toggled together off this one era cutoff, which
  // can't tell "no data yet for this specific card" (e.g. opinion audio
  // recording starting later than argument audio within the same era) from
  // "genuinely nothing to show". Defaulting hidden (instead of shown-by-
  // default, hidden-off) also means a slow-loading terms.js can never flash
  // an inapplicable card visible before hiding it again.
  var hasAudioEra = term >= '1955-10';

  // Reveals one .audio-stat card by its stat-value id, once (never re-hides
  // — every card starts `hidden` in the markup and this is the only thing
  // that ever clears it).
  function revealAudioStat(valueId, hasData) {
    if (!hasData) return;
    var card = document.getElementById(valueId).closest('.stat-card');
    if (card) card.hidden = false;
  }

  // Load journal cover if available for this term.
  fetch('/courts/ussc/terms/terms.json')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (decades) {
      var entry = null;
      var allTerms = [];
      decades.forEach(function (d) {
        (d.groups || []).forEach(function (g) {
          var m = g.file && /\/terms\/([^/]+)\//.exec(g.file);
          if (m) allTerms.push({ id: m[1], name: g.name || termTitle(m[1]) });
          if (g.file && g.file.indexOf('/terms/' + term + '/') >= 0) entry = g;
        });
      });
      termStarts = allTerms.map(function (t) { return { term: t.id, start: t.id.slice(0, 4) + '-' + t.id.slice(5, 7) + '-01' }; });
      var idx = allTerms.findIndex(function (t) { return t.id === term; });
      // Refines the title text set above (termTitle(term)'s own guess) —
      // updates the link's own textContent, not #stat-term-title's, so the
      // click-to-this-term link created there survives this.
      if (idx >= 0) document.querySelector('#stat-term-title .stat-term-title-link').textContent = allTerms[idx].name;
      var prevEntry = idx > 0 ? allTerms[idx - 1] : null;
      var nextEntry = idx < allTerms.length - 1 ? allTerms[idx + 1] : null;
      _resolvePrevTermIdPromise(prevEntry ? prevEntry.id : null);
      _resolveNextTermIdPromise(nextEntry ? nextEntry.id : null);
      if (prevEntry || nextEntry) {
        document.getElementById('stats-term-nav').hidden = false;
        if (prevEntry) {
          var prevBtn = document.getElementById('stat-prev-term');
          prevBtn.textContent = '« ' + prevEntry.id.split('-')[0];
          prevBtn.hidden = false;
          prevBtn.addEventListener('click', function () {
            var s = '?term=' + encodeURIComponent(prevEntry.id);
            if (window.parent !== window) { window.parent.postMessage({ type: 'ussc-navigate', search: s }, location.origin); }
            else { location.href = '/courts/ussc/' + s; }
          });
          wireAdjacentTermDropTarget(prevBtn, 'prev');
        }
        if (nextEntry) {
          var nextBtn = document.getElementById('stat-next-term');
          nextBtn.textContent = nextEntry.id.split('-')[0] + ' »';
          nextBtn.hidden = false;
          nextBtn.addEventListener('click', function () {
            var s = '?term=' + encodeURIComponent(nextEntry.id);
            if (window.parent !== window) { window.parent.postMessage({ type: 'ussc-navigate', search: s }, location.origin); }
            else { location.href = '/courts/ussc/' + s; }
          });
          wireAdjacentTermDropTarget(nextBtn, 'next');
        }
      }
      _resolveTermDates(entry ? entry.dates : undefined);
      _resolveTermEntryPromise(entry || null);
      if (!entry) return;
      // argued/argDays/audio here are cross-term-aware (see update_cases.js's
      // syncTermsJson/_computeTermArgAudioStats) — an argument/reargument
      // date only counts toward the term whose own calendar window actually
      // contains it, not necessarily the term the case is filed under. The
      // stat cards were already given a locally-computed (cases-only, not
      // cross-term-aware) approximation above so there's no flash of "—"
      // before this fetch resolves; overwrite with the authoritative values
      // once they're in hand.
      if (entry.argued  != null) document.getElementById('stat-argued-cases').textContent  = entry.argued  || '—';
      if (entry.argDays != null) document.getElementById('stat-argument-days').textContent = entry.argDays || '—';
      if (entry.audio   != null) { document.getElementById('stat-with-audio').textContent = entry.audio || '—'; revealAudioStat('stat-with-audio', entry.audio > 0); }
      termMinutesCovers = entry.minutes || [];
      if (entry.journal_cover && entry.journal_url) {
        var coverUrl = '/courts/ussc/terms/' + term + '/' + entry.journal_cover;
        var journalUrl = resolveIndexesUrl(entry.journal_url);
        var btn = document.getElementById('journal-cover-btn');
        var img = document.getElementById('journal-cover-img');
        img.src = coverUrl;
        btn.title = 'Open ' + term.split('-')[0] + ' Journal';
        btn.hidden = false;
        wireCoverClick(btn, journalUrl, termTitle(term) + ' Journal');
      }
      var coversRow = document.getElementById('covers-row');
      (entry.reports || []).forEach(function (report) {
        if (!report.cover || !report.href) return;
        var rBtn = document.createElement('button');
        rBtn.className = 'report-cover-btn';
        rBtn.title = 'Open U.S. Reports vol. ' + (report.volume || '');
        var rImg = document.createElement('img');
        rImg.className = 'report-cover-img';
        rImg.src = '/courts/ussc/terms/' + term + '/' + report.cover;
        rImg.alt = 'Vol. ' + (report.volume || '');
        var rLabel = document.createElement('span');
        rLabel.className = 'report-cover-label';
        rLabel.textContent = (report.volume || '') + ' U.S.';
        rBtn.appendChild(rImg);
        rBtn.appendChild(rLabel);
        wireCoverClick(rBtn, report.href, termTitle(term) + ' U.S. Reports, Vol. ' + (report.volume || ''));
        coversRow.appendChild(rBtn);
      });
    })
    .catch(function () {
      _resolveTermDates(undefined); // couldn't determine the "dates" flag at all — fall back to probing
      _resolveNextTermIdPromise(null); // couldn't determine the next term either — Court Calendar falls back to a flat 12 months
    });

  // Minutes-book cover thumbnails: terms.json's own per-term "minutes" array
  // (termMinutesCovers, set above once the terms.json fetch resolves) lists
  // one { cover } per physical NARA volume this term's dates.json touches,
  // already in first-appearance (chronological) order — a term's minutes can
  // span more than one physical volume, so one thumbnail is shown per
  // volume, to the left of the journal/U.S. Reports covers above. Each
  // volume's own roll number is parsed back out of its cover filename
  // ("mXXX-cover.jpg") and matched against dates.json's own type:"minutes"
  // src templates (which embed the same roll number) to find that volume's
  // earliest real (non-tombstoned) date/page, which the thumbnail links to.
  // Re-run (not just rendered once) after a drag-and-drop Minutes edit
  // below, since moving pages around can shift which date is first to
  // reference a given volume — existing buttons are removed by class first
  // so a re-run doesn't just pile up duplicates alongside them.
  function firstMinutesOccurrenceForRoll(xxx) {
    if (!termDatesData) return null;
    var isos = Object.keys(termDatesData).sort();
    for (var i = 0; i < isos.length; i++) {
      var groups = termDatesData[isos[i]] || [];
      for (var j = 0; j < groups.length; j++) {
        var g = groups[j];
        if (g.type !== 'minutes') continue;
        var m = /M215-(\d{3})/.exec(g.src || '');
        // A tombstone left by handleMinutesDrop above (pages emptied out
        // entirely) never counts as this volume's "first occurrence" — that
        // date no longer actually shows anything for it.
        if (!m || m[1] !== xxx || !(g.pages && g.pages.length)) continue;
        return { iso: isos[i], page: g.pages[0], href: g.href };
      }
    }
    return null;
  }
  function renderMinutesCoverThumbnails() {
    var coversRowEl = document.getElementById('covers-row');
    coversRowEl.querySelectorAll('.minutes-cover-btn').forEach(function (el) { el.remove(); });
    if (!termDatesData || !termMinutesCovers.length) return;
    var frag = document.createDocumentFragment();
    termMinutesCovers.forEach(function (cover) {
      var rollMatch = /^m(\d{3})-cover\.jpg$/.exec((cover && cover.cover) || '');
      if (!rollMatch) return;
      var occ = firstMinutesOccurrenceForRoll(rollMatch[1]);
      if (!occ) return;
      var dateLabel = fmtMonthDayYear(occ.iso);
      var mBtn = document.createElement('button');
      mBtn.className = 'minutes-cover-btn';
      mBtn.title = 'Open Minutes for ' + dateLabel;
      var mImg = document.createElement('img');
      mImg.className = 'minutes-cover-img';
      mImg.src = '/courts/ussc/terms/' + term + '/' + cover.cover;
      mImg.alt = 'Minutes cover';
      var mLabel = document.createElement('span');
      mLabel.className = 'minutes-cover-label';
      mLabel.textContent = dateLabel;
      mBtn.appendChild(mImg);
      mBtn.appendChild(mLabel);
      if (occ.href != null) {
        var href = occ.href.replace('$page', occ.page);
        wireCoverClick(mBtn, href, termTitle(term) + ' Minutes, p. ' + occ.page, 'pane');
      }
      frag.appendChild(mBtn);
    });
    if (frag.childNodes.length) coversRowEl.insertBefore(frag, coversRowEl.firstChild);
  }
  termDatesPromise.then(renderMinutesCoverThumbnails);

  fetch('/courts/ussc/terms/' + term + '/cases.json')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (cases) {

      // ── Date section ────────────────────────────────────────────────────────
      if (!date || date === 'all') {
        // No ?date= yet (or the special date=all full-calendar view — see
        // below) — the covers row (journal/report/minutes covers) may still
        // be showing something, but there's nothing day-specific here yet;
        // point the visitor at the Court Calendar below instead of leaving
        // this whole area blank.
        document.getElementById('date-empty-message').hidden = false;
      } else {
        function casesOnDate(field) {
          return cases.filter(function (c) {
            if (!c[field]) return false;
            return c[field].split(',').map(function (d) { return d.trim(); }).indexOf(date) >= 0;
          });
        }

        // c.term (only ever set on a cross-term case-detail object — see
        // below) links to that case's own term instead of this page's, since
        // it isn't actually part of this term's own docket.
        // Preference order matches explorer.js's own _buildDecisionEntries/
        // DECISION_FILE_PARAMS — the case's default decision doc source.
        function decisionFileParam(c) {
          if (c.decision_loc) return 'loc';
          if (c.decision_gov) return 'gov';
          if (c.decision_vol) return 'vol';
          return null;
        }

        // isDecision (Decisions group only) makes the link open straight to
        // the case's own decision doc — via explorer.js's ?file= restore —
        // instead of its default oral-argument audio, since that's what
        // brought this case to this date's attention in the first place.
        function fillGroup(sectionId, listId, group, isDecision) {
          if (!group.length) return;
          var ul = document.getElementById(listId);
          var sorted = group.slice().sort(function (a, b) {
            var ta = caseDisplayTitle(a).toLowerCase(), tb = caseDisplayTitle(b).toLowerCase();
            return ta < tb ? -1 : ta > tb ? 1 : 0;
          });
          var items = sorted.map(function (c) {
            var li = document.createElement('li');
            var a = document.createElement('a');
            var id = caseUrlId(c, cases);
            var linkTerm = c.term || term;
            var numberLabel = caseNumberLabel(c);
            var fileParam = isDecision ? decisionFileParam(c) : null;
            var search = '?term=' + encodeURIComponent(linkTerm) + '&case=' + encodeURIComponent(id) +
              (fileParam ? '&file=' + fileParam : '');
            a.textContent = caseDisplayTitle(c) + (numberLabel ? ' (' + numberLabel + ')' : '');
            a.href = '/courts/ussc/' + search;
            a.addEventListener('click', function (e) {
              e.preventDefault();
              if (window.parent !== window) {
                window.parent.postMessage({
                  type: 'ussc-navigate',
                  search: search
                }, location.origin);
              } else {
                location.href = a.href;
              }
            });
            li.appendChild(a);
            ul.appendChild(li);
            return li;
          });
          // More than two entries would otherwise push this section well past
          // its siblings' own height — collapse to the first two, with a
          // third "…" line that reveals the rest in place on click (never
          // re-collapses; there's no need to hide them again once seen).
          if (items.length > 2) {
            items.slice(2).forEach(function (li) { li.hidden = true; });
            var moreLi = document.createElement('li');
            var moreLink = document.createElement('a');
            moreLink.href = '#';
            moreLink.textContent = '…';
            moreLink.title = 'Show ' + (items.length - 2) + ' more';
            moreLink.addEventListener('click', function (e) {
              e.preventDefault();
              items.forEach(function (li) { li.hidden = false; });
              moreLi.remove();
            });
            moreLi.appendChild(moreLink);
            ul.insertBefore(moreLi, items[2]);
          }
          document.getElementById(sectionId).hidden = false;
        }

        // Justice service-date entries (type "justice" — see update_cases.js's
        // syncJusticeDates) for this date: one row per justice whose service
        // started or ended this day, linking straight to their own gallery
        // page via the entry's own title/href — no case lookup involved, so
        // this doesn't share fillGroup's own case-row plumbing above.
        function fillJusticesGroup(items) {
          if (!items.length) return;
          var ul = document.getElementById('date-justices-list');
          var sorted = items.slice().sort(function (a, b) {
            var ta = (a.title || '').toLowerCase(), tb = (b.title || '').toLowerCase();
            return ta < tb ? -1 : ta > tb ? 1 : 0;
          });
          var items2 = sorted.map(function (g) {
            var li = document.createElement('li');
            var a = document.createElement('a');
            a.textContent = g.title || '';
            a.href = g.href || '#';
            a.addEventListener('click', function (e) {
              e.preventDefault();
              var s = '?' + (g.href || '').split('?')[1];
              if (window.parent !== window) {
                window.parent.postMessage({ type: 'ussc-navigate', search: s }, location.origin);
              } else {
                location.href = g.href;
              }
            });
            li.appendChild(a);
            ul.appendChild(li);
            return li;
          });
          if (items2.length > 2) {
            items2.slice(2).forEach(function (li) { li.hidden = true; });
            var moreLi = document.createElement('li');
            var moreLink = document.createElement('a');
            moreLink.href = '#';
            moreLink.textContent = '…';
            moreLink.title = 'Show ' + (items2.length - 2) + ' more';
            moreLink.addEventListener('click', function (e) {
              e.preventDefault();
              items2.forEach(function (li) { li.hidden = false; });
              moreLi.remove();
            });
            moreLi.appendChild(moreLink);
            ul.insertBefore(moreLi, items2[2]);
          }
          document.getElementById('date-justices-section').hidden = false;
        }

        // Minutes: courts/ussc/terms/<term>/dates.json is a separate, optional
        // per-term file (most terms don't have one) built by
        // scripts/parse_minutes.js from NARA's own OCR'd minutes books — see
        // renderMinutesPagesList below. It can also hold a case-detail object
        // (see update_cases.js's syncCrossTermCaseDates) — a later term's own
        // case actually argued/reargued on this earlier term's own date —
        // which joins the arguments list below alongside this term's own
        // cases, same as any of them (their own "term" field, not this
        // page's, is what fillGroup's link above uses). A ?page= param (see
        // openMinutesPageFromUrl's own doc comment) then opens straight to
        // that Minutes page once the list exists for it to find.
        termDatesPromise.then(function (datesData) {
          var crossTermCases = (datesData && datesData[date]) || [];
          var crossArg = crossTermCases.filter(function (g) { return g.type === 'argument' || g.type === 'reargument'; });
          var justiceDates = crossTermCases.filter(function (g) { return g.type === 'justice'; });

          // Arguments and reargument dates share a single section/list now —
          // a case argued and reargued on the very same date (never actually
          // happens, but cheap to guard) would otherwise appear twice.
          var argued = casesOnDate('argument').concat(casesOnDate('reargument'));
          argued = argued.filter(function (c, i) { return argued.indexOf(c) === i; });

          fillJusticesGroup(justiceDates);
          fillGroup('date-argued-section',  'date-argued-list',  argued.concat(crossArg));
          fillGroup('date-decided-section', 'date-decided-list', casesOnDate('decision'), true);

          renderMinutesPagesList();
          openMinutesPageFromUrl();

          // A calendar day link with minutes (see wireCalDayNav) lands here
          // with a #minutes fragment — scroll the (now-unhidden, if this
          // date actually has any) Minutes heading to the top, same as any
          // other same-page anchor link, rather than relying on the
          // browser's own native hash-scroll-on-load (which can't find an
          // element that started out `hidden` and was only just unhidden
          // above).
          if (location.hash === '#minutes') {
            var minutesSection = document.getElementById('minutes');
            if (minutesSection && !minutesSection.hidden) {
              requestAnimationFrame(function () { minutesSection.scrollIntoView({ behavior: 'instant', block: 'start' }); });
            }
          }
        });
      }

      // ── Term stats ──────────────────────────────────────────────────────────
      // arguedCases/argDays/withAudio computed below are a fast local
      // approximation from this term's own cases.json alone — not
      // cross-term-aware (a case's argument/reargument date can chronologically
      // belong to an *earlier* term than the one it's filed under; see
      // update_cases.js's syncCrossTermCaseDates). They're shown immediately
      // so the stat cards never sit on "—", then overwritten with the
      // authoritative cross-term-aware terms.json values in the
      // fetch('/courts/ussc/terms/terms.json') handler above once it resolves.
      var argEvents = [];
      cases.forEach(function (c) {
        (c.events || []).forEach(function (e) {
          if (e.type === 'argument' || e.type === 'reargument') argEvents.push(e);
        });
      });

      var arguedCases = cases.filter(function (c) { return c.argument || c.reargument; }).length;
      // Count unique argument days from both event records and the argument/reargument
      // date fields, since older terms may have date fields but no event records.
      var argDaySet = new Set(argEvents.map(function (e) { return e.date; }).filter(Boolean));
      cases.forEach(function (c) {
        ['argument', 'reargument'].forEach(function (field) {
          if (c[field]) c[field].split(',').forEach(function (d) { var t = d.trim(); if (t) argDaySet.add(t); });
        });
      });
      var argDays = argDaySet.size;

      var decDaySet = new Set();
      cases.forEach(function (c) {
        if (c.decision) c.decision.split(',').forEach(function (d) { var t = d.trim(); if (t) decDaySet.add(t); });
      });

      calContainer = document.getElementById('term-calendar'); // module-scope — see handleMinutesDrop above
      if (calContainer) {
        Promise.all([nextTermIdPromise, termDatesPromise]).then(function (results) {
          var nextTermId = results[0], datesData = results[1];

          // Cross-term case-detail entries (see update_cases.js's
          // syncCrossTermCaseDates) in this term's own dates.json — a later
          // term's own case actually argued/reargued during this earlier
          // term's own date range — get the same calendar coloring as this
          // term's own argument/reargument days. Built as a copy rather than
          // mutating argDaySet itself, since argDays (the stat card above,
          // already rendered from argDaySet.size before this promise even
          // resolves) should only ever count this term's own docket.
          var calArgDaySet = new Set(argDaySet);
          if (datesData) {
            Object.keys(datesData).forEach(function (iso) {
              (datesData[iso] || []).forEach(function (g) {
                if (g.type === 'argument' || g.type === 'reargument') calArgDaySet.add(iso);
              });
            });
          }
          if (!calArgDaySet.size && !decDaySet.size) return;

          // The special date=all value (see the Court Calendar heading link
          // below) means "show the full calendar, not scoped to any single
          // date" — treated the same as no ?date= at all for the grid itself,
          // it just additionally suppresses the stat cards above (see the
          // `if (date)` block earlier) since there's no specific date's own
          // info to show alongside them either.
          var singleDate = (date && date !== 'all') ? date : null;

          var termParts = term.split('-');
          var termStart = { year: parseInt(termParts[0], 10), month: parseInt(termParts[1], 10) - 1 }; // 0-based
          // A single selected ?date= jumps the grid's own start to the month
          // before the selected date's own month, so that month always lands
          // in the middle of the 3-month row — never earlier than the term's
          // own actual first month, though, since there's nothing to show
          // before the term itself begins.
          var calStart = termStart;
          if (singleDate) {
            var d = singleDate.split('-');
            var selIdx = parseInt(d[0], 10) * 12 + (parseInt(d[1], 10) - 1) - 1; // previous month, 0-based total months
            var prevStart = { year: Math.floor(selIdx / 12), month: ((selIdx % 12) + 12) % 12 };
            if (prevStart.year * 12 + prevStart.month >= termStart.year * 12 + termStart.month) calStart = prevStart;
          }
          // Stops the month before the next term begins, however many months
          // that actually is (no 12-month cap) — falls back to a flat 12 when
          // there's no known next term (the latest term, or terms.json failed).
          var monthCount = 12;
          if (nextTermId) {
            var n = nextTermId.split('-');
            var nextStartIdx = parseInt(n[0], 10) * 12 + (parseInt(n[1], 10) - 1);
            var diff = nextStartIdx - (calStart.year * 12 + calStart.month);
            if (diff > 0) monthCount = diff;
          }
          // A single selected ?date= means calStart is already the quarter
          // (3-month row) containing it (see above) — cap the grid to just
          // that row instead of running all the way to the next term, so the
          // view stays consistently scoped to the date the visitor clicked
          // into. date=all keeps the full, uncapped count instead.
          if (singleDate) monthCount = Math.min(monthCount, 3);
          renderTermCalendar(calContainer, term, calArgDaySet, decDaySet, singleDate, monthCount, handleMinutesDrop, calStart);
          calContainer.hidden = false;
          var calHdr = document.getElementById('term-calendar-heading');
          if (calHdr) {
            calHdr.hidden = false;
            // When scoped to a single date, make the heading a link to
            // date=all — the full 12-month calendar with the stat cards
            // suppressed (same wireSearchLink/<a>-wrapping pattern as
            // #stat-term-title's titleLink above).
            if (singleDate) {
              var calHdrLink = document.createElement('a');
              calHdrLink.className = 'calendar-heading-link';
              calHdrLink.textContent = calHdr.textContent;
              wireSearchLink(calHdrLink, '?term=' + encodeURIComponent(term) + '&date=all');
              calHdr.textContent = '';
              calHdr.appendChild(calHdrLink);
            }
          }

          applyMinutesHighlight(calContainer, datesData, term);
        });
      }

      termDatesPromise
        .then(function (datesData) { return collectCrossTermRows(datesData, term); })
        .catch(function () { return []; })
        .then(function (extraRows) {
          return termEntryPromise.then(function (termEntry) {
            renderCaseListing(term, cases, extraRows, termEntry);
          });
        });

      // Only counts cases that were actually argued (see the "decided" note
      // below) — a case with no argument shouldn't count here even if it
      // somehow carried an audio_url (e.g. a decision-announcement recording).
      var withAudio   = cases.filter(function (c) { return (c.argument || c.reargument) && (c.events || []).some(function (e) { return e.audio_url; }); }).length;
      // "Fully aligned" = cases with oyez events that have audio, text_file, and aligned:true
      // (only oyez provides aligned transcripts; ussc never does)
      var withTx = cases.filter(function (c) {
        var oyezArgEvs = (c.events || []).filter(function (e) {
          return e.source === 'oyez' && e.audio_url && (e.type === 'argument' || e.type === 'reargument');
        });
        return oyezArgEvs.length > 0 && oyezArgEvs.every(function (e) { return e.text_file && e.aligned; });
      }).length;
      // Only counts cases that were actually argued — a case resolved
      // without argument (cert denial, GVR, summary disposition) still
      // carries a decision date but shouldn't inflate this stat, matching
      // update_cases.js's own syncTermsJson computation.
      var decided     = cases.filter(function (c) { return (c.argument || c.reargument) && (c.decision || c.dateDecision); }).length;
      var advSet = new Set();
      cases.forEach(function (c) {
        (c.events || []).forEach(function (e) {
          (e.advocates || []).forEach(function (a) { if (a.name) advSet.add(a.name); });
        });
      });

      // De-duplicate events per-case (not globally) to avoid counting
      // both ussc and oyez sources for the same event within a case,
      // but still count separate cases argued on the same day.
      var totalSec = 0;
      var eventCount = 0;
      cases.forEach(function (c) {
        var caseArgEvents = (c.events || []).filter(function (e) {
          return (e.type === 'argument' || e.type === 'reargument') && e.length;
        });
        var seenTitles = new Set();
        caseArgEvents.forEach(function (e) {
          var key = e.title || e.date || ('event-' + caseArgEvents.indexOf(e));
          if (!seenTitles.has(key)) {
            seenTitles.add(key);
            totalSec += parseLen(e.length);
            eventCount++;
          }
        });
      });

      // De-duplicate opinion events per-case
      var opTotalSec = 0;
      var opEventCount = 0;
      cases.forEach(function (c) {
        var caseOpEvents = (c.events || []).filter(function (e) {
          return e.type === 'decision' && e.audio_url && e.length;
        });
        var seenOpTitles = new Set();
        caseOpEvents.forEach(function (e) {
          var key = e.title || e.date || ('event-' + caseOpEvents.indexOf(e));
          if (!seenOpTitles.has(key)) {
            seenOpTitles.add(key);
            opTotalSec += parseLen(e.length);
            opEventCount++;
          }
        });
      });

      document.getElementById('stat-argument-days').textContent  = argDays     || '—';
      document.getElementById('stat-argued-cases').textContent    = arguedCases || '—';
      document.getElementById('stat-with-audio').textContent        = withAudio    || '—';
      revealAudioStat('stat-with-audio', withAudio > 0);
      document.getElementById('stat-with-transcript').textContent   = withTx       || '—';
      revealAudioStat('stat-with-transcript', withTx > 0);
      document.getElementById('stat-opinion-hours').textContent = opEventCount > 0 ? fmtHours(opTotalSec) : '—';
      document.getElementById('stat-avg-opinion').textContent   = opEventCount > 0 ? fmtMins(opTotalSec / opEventCount) : '—';
      revealAudioStat('stat-opinion-hours', opEventCount > 0);
      revealAudioStat('stat-avg-opinion', opEventCount > 0);
      document.getElementById('stat-decided').textContent       = decided      || '—';
      document.getElementById('stat-advocates').textContent         = advSet.size  || '—';

      if (eventCount > 0) {
        document.getElementById('stat-argued-hours').textContent = fmtHours(totalSec);
        document.getElementById('stat-avg-length').textContent   = fmtMins(totalSec / eventCount);
        revealAudioStat('stat-argued-hours', true);
        revealAudioStat('stat-avg-length', true);
      } else if (hasAudioEra) {
        // Pre-1955 terms have no note here — their audio-stat cards are
        // already hidden entirely, so there's nothing to explain.
        document.getElementById('stats-note').textContent = 'Audio length data not yet available for this term.';
      }
    })
    .catch(function (err) {
      document.getElementById('stats-note').textContent = 'Could not load case data.';
      console.warn('[stats] fetch failed:', err);
    });
}());
