---
layout: pane
title: "Vocal Justices"
---

<style>
:root { --vc-grid:#eee; --vc-label:#666; }
@media (prefers-color-scheme: dark) { :root { --vc-grid:#2d2f38; --vc-label:#9da5b4; } }
html[data-theme="dark"]  { --vc-grid:#2d2f38; --vc-label:#9da5b4; }
html[data-theme="light"] { --vc-grid:#eee;    --vc-label:#666; }
.filter-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.68rem;
  font-weight: 600;
  opacity: 0.65;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.filter-label:hover { opacity: 0.9; }
</style>

<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px">
  <h1 style="margin:0;font-weight:700">Vocal Justices</h1>
  <label class="filter-label">
    <input type="checkbox" id="vocal-active-only"> Currently Serving
  </label>
</div>
<p>Ranked by total speaking time at oral argument (across all available audio).</p>

<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
  <div id="vocal-sort" class="chart-sort"></div>
</div>
<div style="overflow-x:auto;margin-bottom:1.5em">
  <div id="vocal-chart-wrap" style="min-width:300px;height:920px;position:relative">
    <canvas id="vocal-chart"></canvas>
  </div>
</div>

<script>
(function () {
  var ROW_PX = 26;

  function parseHours(s) {
    var p = s.split(':');
    return parseInt(p[0], 10) + parseInt(p[1], 10) / 60 + parseFloat(p[2]) / 3600;
  }

  function fmtTime(s) {
    var p = s.split(':');
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  var style      = getComputedStyle(document.documentElement);
  var gridColor  = style.getPropertyValue('--vc-grid').trim()  || '#eee';
  var labelColor = style.getPropertyValue('--vc-label').trim() || '#666';

  var _params = new URLSearchParams(location.search);

  var allJustices = [];
  var currentData = [];
  var sortKey     = _params.get('sort') || 'hours';
  var sortAsc     = _params.has('o') ? _params.get('o') === 'a' : false;
  var activeOnly  = _params.get('s') === '1';
  var servingIds  = new Set();
  var chart       = null;

  function _pushUrl() {
    var p = new URLSearchParams();
    p.set('sort', sortKey);
    p.set('o', sortAsc ? 'a' : 'd');
    if (activeOnly) p.set('s', '1');
    var search = '?' + p.toString();
    history.replaceState(null, '', location.pathname + search);
    if (window.parent !== window) {
      var msg = { type: 'ussc-update-sort', sort: sortKey, o: sortAsc ? 'a' : 'd' };
      if (activeOnly) msg.s = '1';
      window.parent.postMessage(msg, location.origin);
    }
  }

  function pool() {
    return activeOnly ? allJustices.filter(function (j) { return servingIds.has(j.id); }) : allJustices;
  }

  function sorted() {
    var arr = pool().slice();
    if (sortKey === 'name') {
      arr.sort(function (a, b) {
        return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      });
    } else if (sortKey === 'date') {
      arr.sort(function (a, b) {
        var da = a.dateStart || '', db = b.dateStart || '';
        return sortAsc ? da.localeCompare(db) : db.localeCompare(da);
      });
    } else {
      arr.sort(function (a, b) {
        var ha = parseHours(a.total), hb = parseHours(b.total);
        return sortAsc ? ha - hb : hb - ha;
      });
    }
    return arr;
  }

  function applySort() {
    currentData = sorted();
    var maxH = currentData.length ? Math.max.apply(null, currentData.map(function (j) { return parseHours(j.total); })) : 1;
    document.getElementById('vocal-chart-wrap').style.height = Math.max(200, currentData.length * ROW_PX) + 'px';
    chart.data.labels                       = currentData.map(function (j) { return j.name; });
    chart.data.datasets[0].data            = currentData.map(function (j) { return parseHours(j.total); });
    chart.data.datasets[0].backgroundColor = currentData.map(function (j) {
      return 'hsl(210,65%,' + Math.round(65 - (parseHours(j.total) / maxH) * 30) + '%)';
    });
    chart.update('none');
  }

  Promise.all([
    fetch('/courts/ussc/people/justices/vocal_justices.json').then(function (r) { return r.json(); }),
    fetch('/courts/ussc/people/justices/gallery.json').then(function (r) { return r.json(); }),
  ]).then(function (results) {
    allJustices = results[0];
    var gallery = results[1];
    var dateMap = {};
    gallery.forEach(function (g) {
      dateMap[g.id] = g.dateStart;
      if (!g.dateStop) servingIds.add(g.id);
    });
    allJustices.forEach(function (j) { j.dateStart = dateMap[j.id] || ''; });

    var maxHours = Math.max.apply(null, allJustices.map(function (j) { return parseHours(j.total); }));
    currentData  = sorted();

    var checkbox = document.getElementById('vocal-active-only');
    checkbox.checked = activeOnly;

    chart = new Chart(document.getElementById('vocal-chart'), {
      type: 'bar',
      data: {
        labels: currentData.map(function (j) { return j.name; }),
        datasets: [{
          data: currentData.map(function (j) { return parseHours(j.total); }),
          backgroundColor: currentData.map(function (j) {
            return 'hsl(210,65%,' + Math.round(65 - (parseHours(j.total) / maxHours) * 30) + '%)';
          }),
          borderWidth: 0,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: function (event, elements) {
          if (!elements.length) return;
          var id     = currentData[elements[0].index].id;
          var search = '?collection=vocal_justices&id=' + id;
          if (window.parent !== window) {
            window.parent.postMessage({ type: 'ussc-navigate', search: search }, location.origin);
          } else {
            window.top.location.href = '/courts/ussc/' + search;
          }
        },
        onHover: function (event, elements) {
          event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
        },
        scales: {
          x: {
            ticks: { callback: function (v) { return v + 'h'; }, color: labelColor, font: { size: 10 } },
            grid:  { color: gridColor },
          },
          y: {
            ticks: { color: labelColor, font: { size: 11 } },
            grid:  { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return currentData[items[0].dataIndex].name; },
              label: function (item)  {
                var j = currentData[item.dataIndex];
                return fmtTime(j.total) + '  ·  ' + j.cases.toLocaleString() + ' cases';
              },
            },
          },
        },
      },
    });

    if (activeOnly) applySort();

    checkbox.addEventListener('change', function (e) {
      activeOnly = e.target.checked;
      _pushUrl();
      applySort();
    });

    buildChartSortControl('vocal-sort', [
      { key: 'hours', label: 'Hours', defaultAsc: false },
      { key: 'name',  label: 'Name',  defaultAsc: true  },
      { key: 'date',  label: 'Date',  defaultAsc: true  },
    ], sortKey, sortAsc, function (key, asc) {
      sortKey = key; sortAsc = asc;
      _pushUrl();
      applySort();
    });
  });
}());
</script>
