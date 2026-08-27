---
layout: pane
title: "On This Day"
styles:
- /assets/css/pages.css
scripts:
- /assets/js/collections/onthisday.js
---

<h1 id="onthisday-title">On This Day</h1>

<p>Pick a year, month, and day below, and we'll take you to a case that was argued or decided on that date. Or leave the year set to "Any" and we'll pick one for you.</p>

<p id="onthisday-message"></p>

<div id="otd-controls" class="otd-controls">
  <div class="otd-field">
    <select id="otd-year" aria-label="Year" disabled><option value="any">Loading&hellip;</option></select>
  </div>
  <div class="otd-field">
    <select id="otd-month" aria-label="Month"></select>
  </div>
  <div class="otd-field">
    <select id="otd-day" aria-label="Day"></select>
  </div>
  <div class="otd-field otd-field-checkbox">
    <label for="otd-argued"><input type="checkbox" id="otd-argued" checked> Argued only</label>
  </div>
  <div class="otd-field">
    <button type="button" id="otd-go" disabled>Go</button>
  </div>
</div>

<div id="otd-calendar-section" class="otd-calendar-section" hidden>
  <div class="otd-cal-nav">
    <a href="#" id="otd-cal-prev" class="otd-cal-nav-arrow" aria-label="Previous month">&lsaquo;</a>
    <a href="#" id="otd-cal-title" class="otd-cal-title"></a>
    <a href="#" id="otd-cal-next" class="otd-cal-nav-arrow" aria-label="Next month">&rsaquo;</a>
  </div>
  <div id="otd-calendar" class="otd-calendar-large"></div>
</div>

<h2 id="case-listing-heading" hidden>Court Cases</h2>
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

<h2 id="nara-heading" hidden>NARA Recordings</h2>
<ul id="nara-list" hidden></ul>

<p id="otd-result" class="otd-result" hidden></p>
