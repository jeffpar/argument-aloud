---
layout: pane
---

<style>
.stats-title-row { display: flex; align-items: baseline; gap: 8px; margin: 0.75rem 0 0.6rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.5rem; }
.stats-title-row h1, .stats-title-row h2 { flex: 1; }
.stats-term-nav { display: flex; gap: 0.6rem; font-size: 0.72rem; flex-shrink: 0; }
.stats-term-nav-btn { background: none; border: none; padding: 0; cursor: pointer; color: inherit; font-size: inherit; opacity: 0.6; white-space: nowrap; }
.stats-term-nav-btn:hover { opacity: 1; color: #4a9eff; text-decoration: underline; }
@media (prefers-color-scheme: dark) { .stats-title-row { border-color: #2d2f38; } }
html[data-theme="dark"]  .stats-title-row { border-color: #2d2f38; }
html[data-theme="light"] .stats-title-row { border-color: #e0e0e0; }
.term-stats h1 { font-size: 1.4rem; font-weight: 700; margin: 0; border: none; padding: 0; }
.term-stats h2 { font-size: 1.1rem; font-weight: 700; margin: 0; border: none; padding: 0; }
#covers-row { float: right; display: flex; gap: 8px; align-items: flex-start; margin-left: 1rem; }
#journal-cover-btn { background: none; border: none; padding: 0; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; }
#journal-cover-btn[hidden] { display: none; }
#journal-cover-img { height: 76px; width: auto; display: block; border-radius: 2px; box-shadow: 0 1px 4px rgba(0,0,0,0.25); transition: opacity 0.15s; }
#journal-cover-btn:hover #journal-cover-img { opacity: 0.8; }
#journal-cover-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; }
.report-cover-btn { background: none; border: none; padding: 0; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; }
.report-cover-img { height: 76px; width: auto; display: block; border-radius: 2px; box-shadow: 0 1px 4px rgba(0,0,0,0.25); transition: opacity 0.15s; }
.report-cover-btn:hover .report-cover-img { opacity: 0.8; }
.report-cover-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; }
.stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem; margin-bottom: 1rem; }
.stat-card { background: #f5f6fa; border-radius: 6px; padding: 0.6rem 0.8rem; }
@media (prefers-color-scheme: dark) { .stat-card { background: #21242c; } }
html[data-theme="dark"]  .stat-card { background: #21242c; }
html[data-theme="light"] .stat-card { background: #f5f6fa; }
.stat-value { font-size: 1.55rem; font-weight: 700; line-height: 1.1; display: block; }
.stat-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; display: block; margin-top: 0.15rem; }
@media (prefers-color-scheme: dark) { .stat-label { color: #9da5b4; } }
html[data-theme="dark"]  .stat-label { color: #9da5b4; }
html[data-theme="light"] .stat-label { color: #666; }
.stats-note { font-size: 0.8rem; color: #888; margin: 0.25rem 0 0; }
@media (prefers-color-scheme: dark) { .stats-note { color: #6a7080; } }
html[data-theme="dark"]  .stats-note { color: #6a7080; }
html[data-theme="light"] .stats-note { color: #888; }

/* ── Term calendar ──────────────────────────────────────────────────────── */
#term-calendar { margin: 1.25rem 0 0.75rem; }
.term-calendar { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.25rem 2rem; }
.cal-month-hdr {
  font-size: 0.68rem; font-weight: 700; text-align: center;
  text-transform: uppercase; letter-spacing: 0.06em;
  padding-bottom: 0.25rem; margin-bottom: 0.25rem;
  border-bottom: 1px solid #ccc;
}
@media (prefers-color-scheme: dark) { .cal-month-hdr { border-color: #3a3d47; } }
html[data-theme="dark"]  .cal-month-hdr { border-color: #3a3d47; }
html[data-theme="light"] .cal-month-hdr { border-color: #ccc; }
.cal-dow { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; font-size: 0.6rem; opacity: 0.45; margin-bottom: 0.1rem; }
.cal-days { display: grid; grid-template-columns: repeat(7, 1fr); }
.cal-day { text-align: center; font-size: 0.7rem; line-height: 1.75; border-radius: 2px; min-width: 0; }
.cal-arg     { background: #d97070; color: #fff; cursor: pointer; font-weight: 600; border-radius: 3px; }
.cal-dec     { background: #6090cc; color: #fff; cursor: pointer; font-weight: 600; border-radius: 3px; }
.cal-arg-dec { background: linear-gradient(135deg, #d97070 50%, #6090cc 50%); color: #fff; cursor: pointer; font-weight: 600; border-radius: 3px; }
.cal-arg:hover     { background: #c85c5c; }
.cal-dec:hover     { background: #4e7db8; }
.cal-arg-dec:hover { background: linear-gradient(135deg, #c85c5c 50%, #4e7db8 50%); }
.cal-sel { box-shadow: inset 0 0 0 2px #fbbf24; }
@media (max-width: 600px) {
  .term-calendar { grid-template-columns: repeat(2, 1fr); gap: 1rem 1rem; }
}

@media (max-width: 600px) {
  body { padding-top: 6px; }
  .stats-title-row { margin-top: 0.2rem; }
}

/* Chart CSS variables */
:root { --chart-grid:#eee; --chart-axis:#ccc; --chart-label:#666; --chart-tip-bg:#f5f6fa; }
@media (prefers-color-scheme: dark) { :root { --chart-grid:#2d2f38; --chart-axis:#3a3d47; --chart-label:#9da5b4; --chart-tip-bg:#21242c; } }
html[data-theme="dark"]  { --chart-grid:#2d2f38; --chart-axis:#3a3d47; --chart-label:#9da5b4; --chart-tip-bg:#21242c; }
html[data-theme="light"] { --chart-grid:#eee; --chart-axis:#ccc; --chart-label:#666; --chart-tip-bg:#f5f6fa; }
#history-view { padding: 0.5rem 0 0.25rem; }

/* Date-specific case list */
.date-section { display: flow-root; margin-bottom: 0.5rem; padding-bottom: 0.75rem; border-bottom: 1px solid #e0e0e0; }
@media (prefers-color-scheme: dark) { .date-section { border-color: #2d2f38; } }
html[data-theme="dark"]  .date-section { border-color: #2d2f38; }
html[data-theme="light"] .date-section { border-color: #e0e0e0; }
.date-section h3 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin: 1.1rem 0 0.35rem; }
.date-case-list { list-style: none; margin: 0; padding: 0 0 0 1rem; }
.date-case-list li { font-size: 0.85rem; margin-bottom: 0.2rem; }
.date-case-list a { color: #2672b4; text-decoration: none; }
.date-case-list a:hover { text-decoration: underline; color: #4a9eff; }
@media (prefers-color-scheme: dark) {
  .date-section h3 { color: #6a7080; }
  .date-case-list a { color: #5eaee0; }
}
html[data-theme="dark"]  .date-section h3 { color: #6a7080; }
html[data-theme="light"] .date-section h3 { color: #888; }
html[data-theme="dark"]  .date-case-list a { color: #5eaee0; }
html[data-theme="light"] .date-case-list a { color: #2672b4; }
</style>

<div class="term-stats" id="stats-container">
  <div class="stats-title-row">
    <h1 id="stat-term-title"></h1>
    <div class="stats-term-nav" id="stats-term-nav" hidden>
      <button class="stats-term-nav-btn" id="stat-prev-term" hidden></button>
      <button class="stats-term-nav-btn" id="stat-next-term" hidden></button>
    </div>
  </div>

  <div class="date-section" id="date-section">
    <div id="covers-row">
      <button id="journal-cover-btn" hidden title="Open journal">
        <img id="journal-cover-img" alt="Journal cover">
        <span id="journal-cover-label">Journal</span>
      </button>
    </div>
    <h2 id="stat-date-title" hidden></h2>
    <div id="date-argued-section" hidden>
      <h3>Argued</h3>
      <ul id="date-argued-list" class="date-case-list"></ul>
    </div>
    <div id="date-reargued-section" hidden>
      <h3>Reargued</h3>
      <ul id="date-reargued-list" class="date-case-list"></ul>
    </div>
    <div id="date-decided-section" hidden>
      <h3>Decided</h3>
      <ul id="date-decided-list" class="date-case-list"></ul>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <span class="stat-value" id="stat-argued-cases">—</span>
      <span class="stat-label">Cases argued</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-argument-days">—</span>
      <span class="stat-label">Argument days</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-decided">—</span>
      <span class="stat-label">Cases decided</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-advocates">—</span>
      <span class="stat-label">Advocates</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-with-audio">—</span>
      <span class="stat-label">Cases with audio</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-with-transcript">—</span>
      <span class="stat-label">Fully aligned</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-argued-hours">—</span>
      <span class="stat-label">Argument audio</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-avg-length">—</span>
      <span class="stat-label">Average argument</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-opinion-hours">—</span>
      <span class="stat-label">Opinion audio</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-avg-opinion">—</span>
      <span class="stat-label">Average opinion</span>
    </div>
  </div>
  <p class="stats-note" id="stats-note"></p>
  <h2 id="term-calendar-heading" hidden>U.S. Supreme Court Calendar</h2>
  <div id="term-calendar" hidden></div>
  <div id="history-view" hidden></div>
</div>

<script>
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

  function renderTermCalendar(container, termId, argDays, decDays, selectedDate) {
    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    var MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var DOW = ['S','M','T','W','T','F','S'];
    var parts = termId.split('-');
    var startYear = parseInt(parts[0], 10);
    var startMonth = parseInt(parts[1], 10) - 1; // 0-based
    var calEl = document.createElement('div');
    calEl.className = 'term-calendar';
    for (var mi = 0; mi < 12; mi++) {
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
              else { location.href = s; }
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
      })
      .catch(function() {
        document.getElementById('stats-note').textContent = 'Could not load data.';
      });
    return;
  }
  document.getElementById('stat-term-title').textContent = termTitle(term);
  if (date) { var _dtEl = document.getElementById('stat-date-title'); _dtEl.textContent = fmtDate(date); _dtEl.hidden = false; }

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
            else { location.href = s; }
          });
        }
        if (nextEntry) {
          var nextBtn = document.getElementById('stat-next-term');
          nextBtn.textContent = nextEntry.id.split('-')[0] + ' »';
          nextBtn.hidden = false;
          nextBtn.addEventListener('click', function () {
            var s = '?term=' + encodeURIComponent(nextEntry.id);
            if (window.parent !== window) { window.parent.postMessage({ type: 'ussc-navigate', search: s }, location.origin); }
            else { location.href = s; }
          });
        }
      }
      if (!entry) return;
      if (entry.journal_cover && entry.journal_href) {
        var coverUrl = '/courts/ussc/terms/' + term + '/' + entry.journal_cover;
        var btn = document.getElementById('journal-cover-btn');
        var img = document.getElementById('journal-cover-img');
        img.src = coverUrl;
        btn.hidden = false;
        btn.addEventListener('click', function () {
          if (window.parent !== window) {
            window.parent.postMessage({
              type: 'ussc-open-doc',
              href: entry.journal_href,
              title: termTitle(term) + ' Journal'
            }, location.origin);
          } else {
            window.open(entry.journal_href, '_blank', 'noopener,noreferrer');
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
          return e.type === 'opinion' && e.audio_href && e.length;
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
      } else {
        document.getElementById('stats-note').textContent = 'Audio length data not yet available for this term.';
      }
    })
    .catch(function (err) {
      document.getElementById('stats-note').textContent = 'Could not load case data.';
      console.warn('[stats] fetch failed:', err);
    });
}());
</script>
