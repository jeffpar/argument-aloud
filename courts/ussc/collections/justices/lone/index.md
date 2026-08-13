---
layout: pane
title: Lone Dissents
styles:
- /assets/css/pages.css
scripts:
- /assets/js/collections/lone.js
---
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
