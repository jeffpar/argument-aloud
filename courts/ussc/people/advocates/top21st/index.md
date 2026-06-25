---
layout: pane
---

# Top 21st Century Advocates

This list of top advocates is based solely on all arguments from the October 2000 Term onward.

<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
  <div id="top-sort" class="chart-sort"></div>
</div>
<div style="margin:1.5em 0;position:relative">
  <canvas id="top-chart"></canvas>
</div>

<script>renderAdvocateChart('top-chart', 'top21st_advocates.json', 'top21st_advocates', { limit: 100, mode: 'arguments', sortContainerId: 'top-sort' });</script>
