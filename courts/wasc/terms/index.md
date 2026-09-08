---
layout: pane
title: WA Supreme Court Term
styles:
- /assets/css/pages.css
---
<div class="term-stats" id="stats-container">
  <p class="term-eyebrow">Washington State Supreme Court</p>
  <div class="stats-title-row">
    <h1 id="stat-term-title"></h1>
  </div>

  <div class="stats-grid" id="stats-grid" hidden>
    <div class="stat-card">
      <span class="stat-value" id="stat-argued-cases">—</span>
      <span class="stat-label">Cases argued</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-argument-days">—</span>
      <span class="stat-label">Argument days</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-decided">—</span>
      <span class="stat-label">Cases decided</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" id="stat-opinions-online">—</span>
      <span class="stat-label">Opinions online</span>
    </div>
  </div>
  <p class="stats-note" id="stats-note" hidden>Cases are listed under the year they were decided.</p>

  <div class="calendar-heading-row">
    <h2 id="term-calendar-heading" hidden>Court Calendar</h2>
  </div>
  <p id="term-calendar-legend" class="cal-legend" hidden><span class="sw sw-arg"></span>argued<span class="sw sw-dec"></span>decided</p>
  <div id="term-calendar" hidden></div>

  <h2 id="case-listing-heading" hidden>Court Cases</h2>
  <p id="stat-filter-note" class="stat-filter-note" hidden></p>
  <div class="table-scroll">
    <table id="case-listing-table" hidden>
      <thead>
        <tr>
          <th data-sort-key="title" aria-sort="ascending"><button type="button">Title</button></th>
          <th class="col-date" data-sort-key="argued"><button type="button">Argued</button></th>
          <th class="col-date" data-sort-key="decided"><button type="button">Decided</button></th>
          <th data-sort-key="vote"><button type="button">Vote</button></th>
          <th class="col-opinion" data-sort-key="opinion"><button type="button">Opinion</button></th>
        </tr>
      </thead>
      <tbody id="case-listing-tbody"></tbody>
    </table>
  </div>
  <p id="term-load-msg">Loading…</p>
</div>

<!-- This court's terms.js lives in the wasc repo and is served from that
     origin (site.wasc_base_url), alongside the cases.json / dates.json it
     fetches — distinct from ussc's own /assets/js/terms.js on this origin.
     window.WASC_BASE_URL is injected by _layouts/pane.html. Loaded last so the
     DOM above already exists (the script runs immediately, no DOMContentLoaded). -->
<script src="{{ site.wasc_base_url }}/assets/js/terms.js?v=1"></script>
