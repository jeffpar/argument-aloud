---
layout: pane
---

<style>
.stats-title-row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; margin: 0.75rem 0 1.1rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.5rem; }
.stats-term-nav { width: 100%; display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.72rem; }
.stats-term-nav-btn { background: none; border: none; padding: 0; cursor: pointer; color: inherit; font-size: inherit; opacity: 0.6; }
.stats-term-nav-btn:hover { opacity: 1; color: #4a9eff; text-decoration: underline; }
@media (prefers-color-scheme: dark) { .stats-title-row { border-color: #2d2f38; } }
html[data-theme="dark"]  .stats-title-row { border-color: #2d2f38; }
html[data-theme="light"] .stats-title-row { border-color: #e0e0e0; }
.term-stats h2 { font-size: 1.1rem; font-weight: 700; margin: 0; border: none; padding: 0; }
#covers-row { display: flex; gap: 8px; align-items: flex-start; flex-shrink: 0; margin-left: 8px; }
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

/* Date-specific case list */
.date-section { margin-bottom: 1.25rem; }
.date-section h3 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; margin: 1.1rem 0 0.35rem; }
.date-case-list { list-style: none; margin: 0; padding: 0; }
.date-case-list li { font-size: 0.85rem; margin-bottom: 0.2rem; }
.date-case-list a { color: inherit; text-decoration: none; }
.date-case-list a:hover { text-decoration: underline; color: #4a9eff; }
@media (prefers-color-scheme: dark) { .date-section h3 { color: #6a7080; } }
html[data-theme="dark"]  .date-section h3 { color: #6a7080; }
html[data-theme="light"] .date-section h3 { color: #888; }
</style>

<div class="term-stats" id="stats-container">
  <div class="stats-title-row">
    <h2 id="stat-term-title"></h2>
    <div id="covers-row">
      <button id="journal-cover-btn" hidden title="Open journal">
        <img id="journal-cover-img" alt="Journal cover">
        <span id="journal-cover-label">Journal</span>
      </button>
    </div>
    <div class="stats-term-nav" id="stats-term-nav" hidden>
      <button class="stats-term-nav-btn" id="stat-prev-term" hidden></button>
      <button class="stats-term-nav-btn" id="stat-next-term" hidden></button>
    </div>
  </div>

  <div class="date-section" id="date-section" hidden>
    <h2 id="stat-date-title"></h2>
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

  var params = new URLSearchParams(location.search);
  var term = params.get('term');
  var date = params.get('date');
  if (!term) return;
  document.getElementById('stat-term-title').textContent = termTitle(term);
  if (date) document.getElementById('stat-date-title').textContent = fmtDate(date);

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
      var idx = allTerms.findIndex(function (t) { return t.id === term; });
      if (idx >= 0) document.getElementById('stat-term-title').textContent = allTerms[idx].name;
      var prevEntry = idx > 0 ? allTerms[idx - 1] : null;
      var nextEntry = idx < allTerms.length - 1 ? allTerms[idx + 1] : null;
      if (prevEntry || nextEntry) {
        document.getElementById('stats-term-nav').hidden = false;
        if (prevEntry) {
          var prevBtn = document.getElementById('stat-prev-term');
          prevBtn.textContent = '« ' + prevEntry.name;
          prevBtn.hidden = false;
          prevBtn.addEventListener('click', function () {
            var s = '?term=' + encodeURIComponent(prevEntry.id);
            if (window.parent !== window) { window.parent.postMessage({ type: 'ussc-navigate', search: s }, location.origin); }
            else { location.href = s; }
          });
        }
        if (nextEntry) {
          var nextBtn = document.getElementById('stat-next-term');
          nextBtn.textContent = nextEntry.name + ' »';
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
        var dateSection = document.getElementById('date-section');
        dateSection.hidden = false;

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
