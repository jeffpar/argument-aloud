---
layout: pane
---

<style>
.term-stats h2 { font-size: 1.1rem; font-weight: 700; margin: 0.75rem 0 1.1rem; border-bottom: 1px solid #e0e0e0; padding-bottom: 0.5rem; }
@media (prefers-color-scheme: dark) { .term-stats h2 { border-color: #2d2f38; } }
.stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.7rem; margin-bottom: 1rem; }
.stat-card { background: #f5f6fa; border-radius: 6px; padding: 0.6rem 0.8rem; }
@media (prefers-color-scheme: dark) { .stat-card { background: #21242c; } }
.stat-value { font-size: 1.55rem; font-weight: 700; line-height: 1.1; display: block; }
.stat-label { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; color: #666; display: block; margin-top: 0.15rem; }
@media (prefers-color-scheme: dark) { .stat-label { color: #9da5b4; } }
.stats-note { font-size: 0.8rem; color: #888; margin: 0.25rem 0 0; }
@media (prefers-color-scheme: dark) { .stats-note { color: #6a7080; } }
</style>

<div class="term-stats" id="stats-container">
  <h2 id="stat-term-title"></h2>
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
    return h + 'h\u00a0' + rem + 'm';
  }

  var term = new URLSearchParams(location.search).get('term');
  if (!term) return;
  document.getElementById('stat-term-title').textContent = termTitle(term);

  fetch('/courts/ussc/terms/' + term + '/cases.json')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (cases) {
      var argEvents = [];
      cases.forEach(function (c) {
        (c.events || []).forEach(function (e) {
          if (e.type === 'argument' || e.type === 'reargument') argEvents.push(e);
        });
      });

      var arguedCases = cases.filter(function (c) { return c.argument || c.reargument; }).length;
      var argDays = new Set(argEvents.map(function (e) { return e.date; }).filter(Boolean)).size;
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
