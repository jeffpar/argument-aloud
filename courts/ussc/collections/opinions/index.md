---
layout: pane
title: Majority Opinions
---

# Majority Opinions

Justices ranked by number of written majority opinions.

<style>
:root { --op-grid:#eee; --op-label:#666; }
@media (prefers-color-scheme: dark) { :root { --op-grid:#2d2f38; --op-label:#9da5b4; } }
html[data-theme="dark"]  { --op-grid:#2d2f38; --op-label:#9da5b4; }
html[data-theme="light"] { --op-grid:#eee;    --op-label:#666; }
</style>

<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
  <div id="op-sort" class="chart-sort"></div>
</div>
<div style="overflow-x:auto;margin-bottom:1.5em">
  <div style="min-width:300px;height:2220px;position:relative">
    <canvas id="op-chart"></canvas>
  </div>
</div>

<script>
(function () {
  var style      = getComputedStyle(document.documentElement);
  var gridColor  = style.getPropertyValue('--op-grid').trim()  || '#eee';
  var labelColor = style.getPropertyValue('--op-label').trim() || '#666';

  var _params = new URLSearchParams(location.search);

  function _pushSortUrl(key, asc) {
    var search = '?sort=' + key + '&o=' + (asc ? 'a' : 'd');
    history.replaceState(null, '', location.pathname + search);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'ussc-update-sort', sort: key, o: asc ? 'a' : 'd' }, location.origin);
    }
  }

  var allJustices = [];
  var currentData = [];
  var maxCases    = 1;
  var sortKey     = _params.get('sort') || 'opinions';
  var sortAsc     = _params.has('o') ? _params.get('o') === 'a' : false;
  var chart       = null;

  function sorted() {
    var arr = allJustices.slice();
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
    chart.data.labels                       = currentData.map(function (j) { return j.name; });
    chart.data.datasets[0].data            = currentData.map(function (j) { return j.cases; });
    chart.data.datasets[0].backgroundColor = currentData.map(function (j) {
      return 'hsl(210,65%,' + Math.round(65 - (j.cases / maxCases) * 30) + '%)';
    });
    chart.update('none');
  }

  fetch('/courts/ussc/people/justices/opinions.json')
    .then(function (r) { return r.json(); })
    .then(function (justices) {
      allJustices = justices;
      maxCases    = Math.max.apply(null, allJustices.map(function (j) { return j.cases; }));
      currentData = sorted();

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

      buildChartSortControl('op-sort', [
        { key: 'opinions', label: 'Opinions', defaultAsc: false },
        { key: 'name',     label: 'Name',     defaultAsc: true  },
        { key: 'date',     label: 'Date',     defaultAsc: true  },
      ], sortKey, sortAsc, function (key, asc) {
        sortKey = key; sortAsc = asc;
        _pushSortUrl(key, asc);
        applySort();
      });
    });
}());
</script>
