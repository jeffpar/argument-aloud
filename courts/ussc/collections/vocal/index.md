---
layout: pane
title: "Vocal Justices"
---

# Vocal Justices

Ranked by total speaking time at oral argument (across all available audio).

<style>
:root { --vc-grid:#eee; --vc-label:#666; }
@media (prefers-color-scheme: dark) { :root { --vc-grid:#2d2f38; --vc-label:#9da5b4; } }
html[data-theme="dark"]  { --vc-grid:#2d2f38; --vc-label:#9da5b4; }
html[data-theme="light"] { --vc-grid:#eee;    --vc-label:#666; }
</style>

<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
  <div id="vocal-sort" class="chart-sort"></div>
</div>
<div style="overflow-x:auto;margin-bottom:1.5em">
  <div style="min-width:300px;height:920px;position:relative">
    <canvas id="vocal-chart"></canvas>
  </div>
</div>

<script>
(function () {
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

  function _pushSortUrl(key, asc) {
    var search = '?sort=' + key + '&o=' + (asc ? 'a' : 'd');
    history.replaceState(null, '', location.pathname + search);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'ussc-update-sort', sort: key, o: asc ? 'a' : 'd' }, location.origin);
    }
  }

  var allJustices = [];
  var currentData = [];
  var maxHours    = 1;
  var sortKey     = _params.get('sort') || 'hours';
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
    chart.data.labels                       = currentData.map(function (j) { return j.name; });
    chart.data.datasets[0].data            = currentData.map(function (j) { return parseHours(j.total); });
    chart.data.datasets[0].backgroundColor = currentData.map(function (j) {
      return 'hsl(210,65%,' + Math.round(65 - (parseHours(j.total) / maxHours) * 30) + '%)';
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
    gallery.forEach(function (g) { dateMap[g.id] = g.dateStart; });
    allJustices.forEach(function (j) { j.dateStart = dateMap[j.id] || ''; });

    maxHours    = Math.max.apply(null, allJustices.map(function (j) { return parseHours(j.total); }));
    currentData = sorted();

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

    buildChartSortControl('vocal-sort', [
      { key: 'hours', label: 'Hours', defaultAsc: false },
      { key: 'name',  label: 'Name',  defaultAsc: true  },
      { key: 'date',  label: 'Date',  defaultAsc: true  },
    ], sortKey, sortAsc, function (key, asc) {
      sortKey = key; sortAsc = asc;
      _pushSortUrl(key, asc);
      applySort();
    });
  });
}());
</script>
