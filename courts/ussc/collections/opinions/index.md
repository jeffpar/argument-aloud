---
layout: pane
title: Majority Opinions
---

<style>
:root { --op-grid:#eee; --op-label:#666; }
@media (prefers-color-scheme: dark) { :root { --op-grid:#2d2f38; --op-label:#9da5b4; } }
html[data-theme="dark"]  { --op-grid:#2d2f38; --op-label:#9da5b4; }
html[data-theme="light"] { --op-grid:#eee;    --op-label:#666; }
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
  <h1 style="margin:0;font-weight:700">Majority Opinions</h1>
  <label class="filter-label">
    <input type="checkbox" id="op-active-only"> Currently Serving
  </label>
</div>
<p>Justices ranked by number of written majority opinions.</p>

<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
  <div id="op-sort" class="chart-sort"></div>
</div>
<div style="overflow-x:auto;margin-bottom:1.5em">
  <div id="op-chart-wrap" style="min-width:300px;height:2220px;position:relative">
    <canvas id="op-chart"></canvas>
  </div>
</div>

<script>
(function () {
  var ROW_PX = 20;

  var style      = getComputedStyle(document.documentElement);
  var gridColor  = style.getPropertyValue('--op-grid').trim()  || '#eee';
  var labelColor = style.getPropertyValue('--op-label').trim() || '#666';

  var _params = new URLSearchParams(location.search);

  var allJustices = [];
  var currentData = [];
  var sortKey     = _params.get('sort') || 'opinions';
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
        return sortAsc
          ? a.dateStart.localeCompare(b.dateStart)
          : b.dateStart.localeCompare(a.dateStart);
      });
    } else {
      arr.sort(function (a, b) { return sortAsc ? a.cases - b.cases : b.cases - a.cases; });
    }
    return arr;
  }

  function applySort() {
    currentData = sorted();
    var max = currentData.length ? Math.max.apply(null, currentData.map(function (j) { return j.cases; })) : 1;
    document.getElementById('op-chart-wrap').style.height = Math.max(200, currentData.length * ROW_PX) + 'px';
    chart.data.labels                       = currentData.map(function (j) { return j.name; });
    chart.data.datasets[0].data            = currentData.map(function (j) { return j.cases; });
    chart.data.datasets[0].backgroundColor = currentData.map(function (j) {
      return 'hsl(210,65%,' + Math.round(65 - (j.cases / max) * 30) + '%)';
    });
    chart.update('none');
  }

  Promise.all([
    fetch('/courts/ussc/people/justices/opinions.json').then(function (r) { return r.json(); }),
    fetch('/courts/ussc/people/justices/gallery.json').then(function (r) { return r.json(); }),
  ]).then(function (results) {
    allJustices = results[0];
    var gallery = results[1];
    servingIds  = new Set(gallery.filter(function (g) { return !g.dateStop; }).map(function (g) { return g.id; }));

    var maxCases = Math.max.apply(null, allJustices.map(function (j) { return j.cases; }));
    currentData  = sorted();

    var checkbox = document.getElementById('op-active-only');
    checkbox.checked = activeOnly;

    chart = new Chart(document.getElementById('op-chart'), {
      type: 'bar',
      data: {
        labels: currentData.map(function (j) { return j.name; }),
        datasets: [{
          data: currentData.map(function (j) { return j.cases; }),
          backgroundColor: currentData.map(function (j) {
            return 'hsl(210,65%,' + Math.round(65 - (j.cases / maxCases) * 30) + '%)';
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
          var search = '?collection=opinions&id=' + id;
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
            ticks: { color: labelColor, font: { size: 10 } },
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
                var j     = currentData[item.dataIndex];
                var first = j.dateStart.slice(0, 4);
                var last  = j.dateStop.slice(0, 4);
                var range = first === last ? first : first + '–' + last;
                return j.cases + ' opinion' + (j.cases === 1 ? '' : 's') + '  ·  ' + range;
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

    buildChartSortControl('op-sort', [
      { key: 'opinions', label: 'Opinions', defaultAsc: false },
      { key: 'name',     label: 'Name',     defaultAsc: true  },
      { key: 'date',     label: 'Date',     defaultAsc: true  },
    ], sortKey, sortAsc, function (key, asc) {
      sortKey = key; sortAsc = asc;
      _pushUrl();
      applySort();
    });
  });
}());
</script>
