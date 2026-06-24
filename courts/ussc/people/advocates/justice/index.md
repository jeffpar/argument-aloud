---
layout: pane
---

# Justice Advocates

Justice advocates are U.S. Supreme Court Justices who also appeared at the Court as advocates.  In most instances, they argued *before* becoming a Justice, but a few people (eg, [Arthur Goldberg](/courts/ussc/?collection=justice_advocates&id=arthur_goldberg) and [Abe Fortas](/courts/ussc/?collection=justice_advocates&id=abe_fortas)) also argued *after* retiring from the Court.

<p id="justices-summary"></p>

<div style="display:flex;justify-content:flex-end;margin-bottom:6px">
  <div id="justices-sort" class="chart-sort"></div>
</div>
<div style="margin:1.5em 0;position:relative">
  <canvas id="justices-chart"></canvas>
</div>

<script>renderAdvocateChart('justices-chart', 'justice_advocates.json', 'justice_advocates', { summaryId: 'justices-summary', summaryLabel: 'Justices', mode: 'arguments', sortContainerId: 'justices-sort' });</script>
