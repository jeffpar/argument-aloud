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

<div style="overflow-x:auto;margin:1.5em 0">
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

  var style = getComputedStyle(document.documentElement);
  var gridColor  = style.getPropertyValue('--vc-grid').trim()  || '#eee';
  var labelColor = style.getPropertyValue('--vc-label').trim() || '#666';

  fetch('/courts/ussc/people/justices/vocal_justices.json')
    .then(function (r) { return r.json(); })
    .then(function (justices) {
      var maxHours = parseHours(justices[0].total);

      new Chart(document.getElementById('vocal-chart'), {
        type: 'bar',
        data: {
          labels: justices.map(function (j) { return j.name; }),
          datasets: [{
            data: justices.map(function (j) { return parseHours(j.total); }),
            backgroundColor: justices.map(function (j) {
              var ratio = parseHours(j.total) / maxHours;
              return 'hsl(210,65%,' + Math.round(65 - ratio * 30) + '%)';
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
            var id = justices[elements[0].index].id;
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
              ticks: {
                callback: function (v) { return v + 'h'; },
                color: labelColor,
                font: { size: 10 },
              },
              grid: { color: gridColor },
            },
            y: {
              ticks: { color: labelColor, font: { size: 11 } },
              grid: { display: false },
            },
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: function (items) { return justices[items[0].dataIndex].name; },
                label: function (item) {
                  var j = justices[item.dataIndex];
                  return fmtTime(j.total) + '  ·  ' + j.cases.toLocaleString() + ' cases';
                },
              },
            },
          },
        },
      });
    });
}());
</script>
