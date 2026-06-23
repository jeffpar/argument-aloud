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

<div style="overflow-x:auto;margin:1.5em 0">
  <div style="min-width:300px;height:2220px;position:relative">
    <canvas id="op-chart"></canvas>
  </div>
</div>

<script>
(function () {
  var style = getComputedStyle(document.documentElement);
  var gridColor  = style.getPropertyValue('--op-grid').trim()  || '#eee';
  var labelColor = style.getPropertyValue('--op-label').trim() || '#666';

  fetch('/courts/ussc/people/justices/opinions.json')
    .then(function (r) { return r.json(); })
    .then(function (justices) {
      var maxCases = justices[0].cases;

      new Chart(document.getElementById('op-chart'), {
        type: 'bar',
        data: {
          labels: justices.map(function (j) { return j.name; }),
          datasets: [{
            data: justices.map(function (j) { return j.cases; }),
            backgroundColor: justices.map(function (j) {
              var ratio = j.cases / maxCases;
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
              ticks: {
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
                  var first = j.dateFirst.slice(0, 4);
                  var last  = j.dateLast.slice(0, 4);
                  var range = first === last ? first : first + '–' + last;
                  return j.cases + ' opinion' + (j.cases === 1 ? '' : 's') + '  ·  ' + range;
                },
              },
            },
          },
        },
      });
    });
}());
</script>
