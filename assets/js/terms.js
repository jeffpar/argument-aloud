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
    return (c.title || c.number || c.id || '(unknown)').split('|')[0].trim();
  }
  function caseUrlId(c) {
    return c.id || (c.number || '').split(',')[0].trim() || '';
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

  // Same postMessage pattern already used by the journal/report cover
  // buttons in this file to open a document in the SPA's doc viewer.
  // `view` is forwarded as-is to showDocViewer's own `link.view` — pass
  // 'pane' to force the embedded-iframe view instead of the default
  // external-link card (showDocViewer only auto-picks the pane for
  // .pdf/.mp4/.mp3 hrefs, and a catalog.archives.gov URL matches none of those).
  // `altHref` (optional) opens in a plain new tab — bypassing the doc-viewer
  // postMessage entirely, even when framed — on a Shift-click, instead of
  // `href`'s normal doc-viewer behavior (see the Minutes page links below).
  // Shift, not Cmd/Ctrl: a Cmd/Ctrl-click's new tab didn't reliably get
  // focus (browsers can special-case that combination as a background-tab
  // hint even past preventDefault()), whereas a plain window.open() call
  // triggered by Shift does.
  function wireDocLink(a, href, title, view, altHref) {
    a.href = href;
    a.addEventListener('click', function (e) {
      e.preventDefault();
      if (altHref && e.shiftKey) {
        window.open(altHref, '_blank', 'noopener,noreferrer');
        return;
      }
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'ussc-open-doc', href: href, title: title, view: view }, location.origin);
      } else {
        window.open(href, '_blank', 'noopener,noreferrer');
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
  function opinionSortKey(usCite) {
    var m = /^(\d+)\s+U\.S\.\s+(\d+)$/.exec(usCite || '');
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

  function buildCaseListingRow(term, row) {
    var tr = document.createElement('tr');

    var tdTitle = document.createElement('td');
    var aTitle = document.createElement('a');
    aTitle.textContent = row.title;
    wireSearchLink(aTitle, '?term=' + encodeURIComponent(term) + '&case=' + encodeURIComponent(row.caseId));
    tdTitle.appendChild(aTitle);
    tr.appendChild(tdTitle);

    var tdArgued = document.createElement('td');
    tdArgued.className = 'col-date';
    renderDateCell(tdArgued, term, row.argIso);
    tr.appendChild(tdArgued);

    var tdDecided = document.createElement('td');
    tdDecided.className = 'col-date';
    renderDateCell(tdDecided, term, row.decIso);
    tr.appendChild(tdDecided);

    var tdVote = document.createElement('td');
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

  function renderCaseListing(term, cases) {
    var rows = cases.map(function (c) {
      // A case reargued in a later term than it was first argued in still
      // carries both dates on the same case record — comparing by
      // year-month (both "argument"/"reargument" and "term" share the same
      // "YYYY-MM" prefix) drops any date that belongs to an earlier term, so
      // e.g. a reargument in this term takes over from an original argument
      // that predates it.
      var argIso = Array.from(new Set(dateTokens(c.argument).concat(dateTokens(c.reargument))))
        .filter(function (d) { return d.slice(0, 7) >= term; });
      var decIso = dateTokens(c.decision);
      var voteM = c.voteMajority, voteN = c.voteMinority;
      var opinionText = c.usCite || '';
      var decDates = decIso.slice().sort();
      return {
        title: caseDisplayTitle(c),
        caseId: caseUrlId(c),
        argIso: argIso,
        decIso: decIso,
        voteText: (voteM != null && voteN != null) ? (voteM + '-' + voteN) : '',
        opinionText: opinionText,
        decisionHref: opinionText ? (c.decision_loc || c.decision_ussc || c.decision_rep || '') : '',
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
    });
    if (!rows.length) return;

    var heading = document.getElementById('case-listing-heading');
    var table   = document.getElementById('case-listing-table');
    var tbody   = document.getElementById('case-listing-tbody');
    heading.hidden = false;
    table.hidden = false;

    var state = { key: 'title', asc: true };
    function render() {
      var sorted = rows.slice().sort(function (a, b) { return compareRows(a, b, state.key, state.asc); });
      tbody.innerHTML = '';
      sorted.forEach(function (row) { tbody.appendChild(buildCaseListingRow(term, row)); });
      table.querySelectorAll('th[data-sort-key]').forEach(function (th) {
        var active = th.dataset.sortKey === state.key;
        th.setAttribute('aria-sort', active ? (state.asc ? 'ascending' : 'descending') : 'none');
      });
    }
    table.querySelectorAll('th[data-sort-key]').forEach(function (th) {
      function activate() {
        var key = th.dataset.sortKey;
        if (state.key === key) state.asc = !state.asc;
        else { state.key = key; state.asc = true; }
        render();
      }
      th.querySelector('button').addEventListener('click', activate);
    });
    render();
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

  // monthCount defaults to a full 12-month term; the all-terms progressive
  // calendar passes a smaller value for a term crowded by the next one
  // (e.g. a short special term), so its grid stops the month before the
  // next term's calendar begins instead of overlapping it.
  function renderTermCalendar(container, termId, argDays, decDays, selectedDate, monthCount) {
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    var MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var DOW = ['S','M','T','W','T','F','S'];
    var parts = termId.split('-');
    var startYear = parseInt(parts[0], 10);
    var startMonth = parseInt(parts[1], 10) - 1; // 0-based
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
        if (isArg || isDec) {
          (function(isoDate) {
            dayEl.addEventListener('click', function() {
              var s = '?term=' + encodeURIComponent(termId) + '&date=' + encodeURIComponent(isoDate);
              if (window.parent !== window) { window.parent.postMessage({ type: 'ussc-navigate', search: s }, location.origin); }
              else { location.href = '/courts/ussc/' + s; }
            });
          })(iso);
        }
        grid.appendChild(dayEl);
      }
      mEl.appendChild(grid);
      calEl.appendChild(mEl);
    }
    container.appendChild(calEl);
  }

  var params = new URLSearchParams(location.search);
  var term = params.get('term');
  var date = params.get('date');
  if (!term) return;
  if (term === 'all') {
    // Journal covers and the argued/reargued/decided date lists below only ever
    // apply to a single term or a specific date — neither ever populates in the
    // all-terms view, so its otherwise-empty border-bottom separator is just
    // dead space here.
    document.getElementById('date-section').hidden = true;
    document.getElementById('stat-term-title').textContent = 'All Terms';
    fetch('/courts/ussc/terms.json')
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
        // terms.json stores decades/terms newest-first; the chart should always
        // read oldest-to-newest left-to-right regardless of storage order.
        chartData.reverse();
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
            if (m) allCalTerms.push({ id: m[1], name: g.name || termTitle(m[1]) });
          });
        });
        // terms.json stores decades/terms newest-first; the calendar list
        // reads oldest-to-newest top-to-bottom, like the chart.
        allCalTerms.reverse();

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
          // here to cache each rendered term's date lists (tiny — just ISO
          // date strings, not full case data) so a Back navigation can redraw
          // everything already seen without re-fetching any cases.json.
          // (Scroll-position restore on Back is handled generically by the
          // page-viewer iframe in explorer.js — no per-page code needed.)
          var SS_CACHE_KEY = 'aa-stats-all-cal-cache';
          var calCache;
          try { calCache = JSON.parse(sessionStorage.getItem(SS_CACHE_KEY) || '{}'); } catch (e) { calCache = {}; }
          function cacheTermDates(termId, argArr, decArr) {
            calCache[termId] = { arg: argArr, dec: decArr };
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
            slots[t.id] = { slot: slot, body: body, monthCount: monthCount, loaded: false };
          });

          // Paints one term's calendar from its (already-known) date lists —
          // called either straight from calCache or after a fresh fetch.
          // Assumes the caller has already claimed slots[termId].loaded.
          function paintTermCalendar(termId, argArr, decArr) {
            var s = slots[termId];
            var argDaySet = new Set(argArr);
            var decDaySet = new Set(decArr);
            if (argDaySet.size || decDaySet.size) {
              renderTermCalendar(s.body, termId, argDaySet, decDaySet, null, s.monthCount);
            } else {
              s.slot.hidden = true;
            }
          }

          function loadTermCalendar(termId) {
            var s = slots[termId];
            if (!s || s.loaded) return;
            s.loaded = true; // claim it before any async work so re-intersection can't double-fire
            if (calCache[termId]) { paintTermCalendar(termId, calCache[termId].arg, calCache[termId].dec); return; }
            fetch('/courts/ussc/terms/' + termId + '/cases.json')
              .then(function(r) { return r.ok ? r.json() : Promise.reject(r.status); })
              .then(function(cases) {
                var argDaySet = new Set();
                var decDaySet = new Set();
                cases.forEach(function(c) {
                  ['argument', 'reargument'].forEach(function(field) {
                    if (c[field]) c[field].split(',').forEach(function(d) { var t = d.trim(); if (t) argDaySet.add(t); });
                  });
                  if (c.decision) c.decision.split(',').forEach(function(d) { var t = d.trim(); if (t) decDaySet.add(t); });
                });
                var argArr = Array.from(argDaySet), decArr = Array.from(decDaySet);
                cacheTermDates(termId, argArr, decArr);
                paintTermCalendar(termId, argArr, decArr);
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
  document.getElementById('stat-term-title').textContent = termTitle(term);
  if (date) { var _dtEl = document.getElementById('stat-date-title'); _dtEl.textContent = fmtDate(date); _dtEl.hidden = false; }

  // Oral argument audio only exists starting with October Term 1955 — omit
  // these stat cards entirely for earlier terms rather than showing six
  // straight "—" placeholders every time.
  var hasAudioEra = term >= '1955-10';
  document.querySelectorAll('.audio-stat').forEach(function (el) { el.hidden = !hasAudioEra; });

  // Load journal cover if available for this term.
  fetch('/courts/ussc/terms.json')
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
      // terms.json stores decades/terms newest-first; reverse so "prev"/"next"
      // below mean chronologically older/newer regardless of storage order.
      allTerms.reverse();
      var idx = allTerms.findIndex(function (t) { return t.id === term; });
      if (idx >= 0) document.getElementById('stat-term-title').textContent = allTerms[idx].name;
      var prevEntry = idx > 0 ? allTerms[idx - 1] : null;
      var nextEntry = idx < allTerms.length - 1 ? allTerms[idx + 1] : null;
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
        }
      }
      if (!entry) return;
      if (entry.journal_cover && entry.journal_href) {
        var coverUrl = '/courts/ussc/terms/' + term + '/' + entry.journal_cover;
        var journalHref = resolveIndexesUrl(entry.journal_href);
        var btn = document.getElementById('journal-cover-btn');
        var img = document.getElementById('journal-cover-img');
        img.src = coverUrl;
        btn.hidden = false;
        btn.addEventListener('click', function () {
          if (window.parent !== window) {
            window.parent.postMessage({
              type: 'ussc-open-doc',
              href: journalHref,
              title: termTitle(term) + ' Journal'
            }, location.origin);
          } else {
            window.open(journalHref, '_blank', 'noopener,noreferrer');
          }
        });
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
        rBtn.addEventListener('click', function () {
          if (window.parent !== window) {
            window.parent.postMessage({
              type: 'ussc-open-doc',
              href: report.href,
              title: termTitle(term) + ' U.S. Reports, Vol. ' + (report.volume || '')
            }, location.origin);
          } else {
            window.open(report.href, '_blank', 'noopener,noreferrer');
          }
        });
        coversRow.appendChild(rBtn);
      });
    })
    .catch(function () {});

  fetch('/courts/ussc/terms/' + term + '/cases.json')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (cases) {

      // ── Date section ────────────────────────────────────────────────────────
      if (date) {
        function casesOnDate(field) {
          return cases.filter(function (c) {
            if (!c[field]) return false;
            return c[field].split(',').map(function (d) { return d.trim(); }).indexOf(date) >= 0;
          });
        }

        function fillGroup(sectionId, listId, group) {
          if (!group.length) return;
          var ul = document.getElementById(listId);
          var sorted = group.slice().sort(function (a, b) {
            var ta = caseDisplayTitle(a).toLowerCase(), tb = caseDisplayTitle(b).toLowerCase();
            return ta < tb ? -1 : ta > tb ? 1 : 0;
          });
          sorted.forEach(function (c) {
            var li = document.createElement('li');
            var a = document.createElement('a');
            var id = caseUrlId(c);
            a.textContent = caseDisplayTitle(c) + (c.usCite ? ' (' + c.usCite + ')' : '');
            a.href = '/courts/ussc/?term=' + encodeURIComponent(term) + '&case=' + encodeURIComponent(id);
            a.addEventListener('click', function (e) {
              e.preventDefault();
              if (window.parent !== window) {
                window.parent.postMessage({
                  type: 'ussc-navigate',
                  search: '?term=' + encodeURIComponent(term) + '&case=' + encodeURIComponent(id)
                }, location.origin);
              } else {
                location.href = a.href;
              }
            });
            li.appendChild(a);
            ul.appendChild(li);
          });
          document.getElementById(sectionId).hidden = false;
        }

        fillGroup('date-argued-section',   'date-argued-list',   casesOnDate('argument'));
        fillGroup('date-reargued-section', 'date-reargued-list', casesOnDate('reargument'));
        fillGroup('date-decided-section',  'date-decided-list',  casesOnDate('decision'));

        // Minutes: courts/ussc/terms/<term>/dates.json is a separate, optional
        // per-term file (most terms don't have one) built by
        // tests/extract_minutes_text.js from NARA's own OCR'd minutes books —
        // keyed by ISO date, each entry a {minutes_href, minutes_src,
        // minutes_pages} triple. minutes_href (the catalog page URL, literal
        // "$page" placeholder) is what opens by default; minutes_src (a
        // direct image URL, literal "$page:4" placeholder zero-padded to 4
        // digits) is kept one Shift-click away, opening in a plain new
        // tab (not the doc viewer) for a quicker, chrome-free look at the
        // page image itself.
        fetch('/courts/ussc/terms/' + term + '/dates.json')
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (datesData) {
            var entry = datesData && datesData[date];
            if (!entry || !Array.isArray(entry.minutes_pages) || !entry.minutes_pages.length) return;
            var ul = document.getElementById('date-minutes-list');
            entry.minutes_pages.slice().sort(function (a, b) { return a - b; }).forEach(function (page) {
              var li = document.createElement('li');
              var a = document.createElement('a');
              a.textContent = 'Page ' + page;
              var page4 = String(page).padStart(4, '0');
              var srcHref  = entry.minutes_src  ? entry.minutes_src.replace('$page:4', page4) : null;
              var hrefHref = entry.minutes_href ? entry.minutes_href.replace('$page', page) : null;
              var title = termTitle(term) + ' Minutes, p. ' + page;
              var altHref = hrefHref ? srcHref : null;
              if (altHref) a.title = 'Use Shift+Click to open this page in a new window';
              wireDocLink(a, hrefHref || srcHref, title, 'pane', altHref);
              li.appendChild(a);
              ul.appendChild(li);
            });
            document.getElementById('date-minutes-section').hidden = false;
          })
          .catch(function () {});
      }

      // ── Term stats ──────────────────────────────────────────────────────────
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

      var calContainer = document.getElementById('term-calendar');
      if (calContainer && (argDaySet.size || decDaySet.size)) {
        renderTermCalendar(calContainer, term, argDaySet, decDaySet, date || null);
        calContainer.hidden = false;
        var calHdr = document.getElementById('term-calendar-heading');
        if (calHdr) calHdr.hidden = false;
      }

      renderCaseListing(term, cases);

      var withAudio   = cases.filter(function (c) { return (c.events || []).some(function (e) { return e.audio_href; }); }).length;
      // "Fully aligned" = cases with oyez events that have audio, text_href, and aligned:true
      // (only oyez provides aligned transcripts; ussc never does)
      var withTx = cases.filter(function (c) {
        var oyezArgEvs = (c.events || []).filter(function (e) {
          return e.source === 'oyez' && e.audio_href && (e.type === 'argument' || e.type === 'reargument');
        });
        return oyezArgEvs.length > 0 && oyezArgEvs.every(function (e) { return e.text_href && e.aligned; });
      }).length;
      var decided     = cases.filter(function (c) { return c.decision || c.dateDecision; }).length;
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
          return e.type === 'decision' && e.audio_href && e.length;
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
      document.getElementById('stat-with-transcript').textContent   = withTx       || '—';
      document.getElementById('stat-opinion-hours').textContent = opEventCount > 0 ? fmtHours(opTotalSec) : '—';
      document.getElementById('stat-avg-opinion').textContent   = opEventCount > 0 ? fmtMins(opTotalSec / opEventCount) : '—';
      document.getElementById('stat-decided').textContent       = decided      || '—';
      document.getElementById('stat-advocates').textContent         = advSet.size  || '—';

      if (eventCount > 0) {
        document.getElementById('stat-argued-hours').textContent = fmtHours(totalSec);
        document.getElementById('stat-avg-length').textContent   = fmtMins(totalSec / eventCount);
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
