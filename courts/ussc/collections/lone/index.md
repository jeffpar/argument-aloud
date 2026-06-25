---
layout: pane
title: Lone Dissents
---

<style>
:root { --ld-grid:#eee; --ld-label:#666; }
@media (prefers-color-scheme: dark) { :root { --ld-grid:#2d2f38; --ld-label:#9da5b4; } }
html[data-theme="dark"]  { --ld-grid:#2d2f38; --ld-label:#9da5b4; }
html[data-theme="light"] { --ld-grid:#eee;    --ld-label:#666; }
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
  <h1 style="margin:0;font-weight:700">Lone Dissents</h1>
  <label class="filter-label">
    <input type="checkbox" id="lone-active-only"> Currently Serving
  </label>
</div>
<p>Justices ranked by number of lone dissents.</p>

<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
  <div id="lone-sort" class="chart-sort"></div>
</div>
<div style="overflow-x:auto;margin-bottom:1.5em">
  <div id="lone-chart-wrap" style="min-width:300px;height:1960px;position:relative">
    <canvas id="lone-chart"></canvas>
  </div>
</div>

<script>
(function () {
  var ROW_PX = 21;

  var style      = getComputedStyle(document.documentElement);
  var gridColor  = style.getPropertyValue('--ld-grid').trim()  || '#eee';
  var labelColor = style.getPropertyValue('--ld-label').trim() || '#666';

  var _params = new URLSearchParams(location.search);

  var allJustices = [];
  var currentData = [];
  var sortKey     = _params.get('sort') || 'dissents';
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
    document.getElementById('lone-chart-wrap').style.height = Math.max(200, currentData.length * ROW_PX) + 'px';
    chart.data.labels                       = currentData.map(function (j) { return j.name; });
    chart.data.datasets[0].data            = currentData.map(function (j) { return j.cases; });
    chart.data.datasets[0].backgroundColor = currentData.map(function (j) {
      return 'hsl(210,65%,' + Math.round(65 - (j.cases / max) * 30) + '%)';
    });
    chart.update('none');
  }

  Promise.all([
    fetch('/courts/ussc/people/justices/lone_dissents.json').then(function (r) { return r.json(); }),
    fetch('/courts/ussc/people/justices/gallery.json').then(function (r) { return r.json(); }),
  ]).then(function (results) {
    allJustices = results[0];
    var gallery = results[1];
    var serving = gallery.filter(function (g) { return !g.dateStop; });
    servingIds  = new Set(serving.map(function (g) { return g.id; }));
    var knownIds = new Set(allJustices.map(function (j) { return j.id; }));
    serving.forEach(function (g) {
      if (!knownIds.has(g.id)) {
        allJustices.push({ id: g.id, name: g.name, cases: 0, dateStart: '', dateStop: '' });
      }
    });

    var maxCases = Math.max.apply(null, allJustices.map(function (j) { return j.cases; }));
    currentData  = sorted();

    var checkbox = document.getElementById('lone-active-only');
    checkbox.checked = activeOnly;

    chart = new Chart(document.getElementById('lone-chart'), {
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
          var search = '?collection=lone_dissents&id=' + id;
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
                var j    = currentData[item.dataIndex];
                var text = j.cases + ' lone dissent' + (j.cases === 1 ? '' : 's');
                if (j.dateStart) {
                  var first = j.dateStart.slice(0, 4);
                  var last  = j.dateStop.slice(0, 4);
                  text += '  ·  ' + (first === last ? first : first + '–' + last);
                }
                return text;
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

    buildChartSortControl('lone-sort', [
      { key: 'dissents', label: 'Dissents', defaultAsc: false },
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
