---
layout: pane
title: Lone Dissents
---

# Lone Dissents

Justices ranked by number of lone dissents (cases where they were the sole dissenter).

<style>
:root { --ld-grid:#eee; --ld-label:#666; }
@media (prefers-color-scheme: dark) { :root { --ld-grid:#2d2f38; --ld-label:#9da5b4; } }
html[data-theme="dark"]  { --ld-grid:#2d2f38; --ld-label:#9da5b4; }
html[data-theme="light"] { --ld-grid:#eee;    --ld-label:#666; }
</style>

<div style="overflow-x:auto;margin:1.5em 0">
  <div style="min-width:300px;height:1960px;position:relative">
    <canvas id="lone-chart"></canvas>
  </div>
</div>

<script>
(function () {
  var style = getComputedStyle(document.documentElement);
  var gridColor  = style.getPropertyValue('--ld-grid').trim()  || '#eee';
  var labelColor = style.getPropertyValue('--ld-label').trim() || '#666';

  fetch('/courts/ussc/people/justices/lone_dissents.json')
    .then(function (r) { return r.json(); })
    .then(function (justices) {
      var maxCases = justices[0].cases;

      new Chart(document.getElementById('lone-chart'), {
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
                  return j.cases + ' lone dissent' + (j.cases === 1 ? '' : 's') + '  ·  ' + range;
                },
              },
            },
          },
        },
      });
    });
}());
</script>
