---
layout: pane
title: Majority Opinions
styles:
- /assets/css/pages.css
scripts:
- /assets/js/collections/opinions.js
---
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
