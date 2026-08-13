---
layout: pane
title: Vocal Justices
styles:
- /assets/css/pages.css
scripts:
- /assets/js/collections/vocal.js
---
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
