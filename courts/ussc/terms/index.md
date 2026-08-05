---
layout: pane
styles:
- /assets/css/pages.css
scripts:
- /assets/js/terms.js
---
<div class="term-stats" id="stats-container">
  <div class="stats-title-row">
    <h1 id="stat-term-title"></h1>
  </div>

  <div class="date-section" id="date-section">
    <div id="date-header-row">
      <div id="date-header-text">
        <h2 id="stat-date-title" hidden></h2>
        <p id="date-empty-message" class="date-empty-message" hidden><span class="date-empty-message-nowrap">Click any day below</span> to see a list of cases <span class="date-empty-message-red">argued</span> and <span class="date-empty-message-blue">decided</span> on that date. If the day is also <span class="date-empty-message-green">green</span>, view the minutes for that date.</p>
      </div>
      <div id="covers-row">
        <button id="journal-cover-btn" hidden title="Open journal">
          <img id="journal-cover-img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Journal cover">
          <span id="journal-cover-label">Journal</span>
        </button>
      </div>
    </div>
    <div id="date-argued-section" hidden>
      <h3>Arguments</h3>
      <ul id="date-argued-list" class="date-case-list"></ul>
    </div>
    <div id="date-reargued-section" hidden>
      <h3>Reargued</h3>
      <ul id="date-reargued-list" class="date-case-list"></ul>
    </div>
    <div id="date-decided-section" hidden>
      <h3>Decisions</h3>
      <ul id="date-decided-list" class="date-case-list"></ul>
    </div>
    <div id="minutes" hidden>
      <h3>Minutes</h3>
      <p id="date-minutes-list" class="date-minutes-list"></p>
    </div>
  </div>

  <div class="stats-grid" id="stats-grid">
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
      <span class="stat-value" id="stat-advocates">—</span>
      <span class="stat-label">Advocates</span>
    </div>
    <div class="stat-card audio-stat" hidden>
      <span class="stat-value" id="stat-with-audio">—</span>
      <span class="stat-label">Cases with audio</span>
    </div>
    <div class="stat-card audio-stat" hidden>
      <span class="stat-value" id="stat-with-transcript">—</span>
      <span class="stat-label">Fully aligned</span>
    </div>
    <div class="stat-card audio-stat" hidden>
      <span class="stat-value" id="stat-argued-hours">—</span>
      <span class="stat-label">Argument audio</span>
    </div>
    <div class="stat-card audio-stat" hidden>
      <span class="stat-value" id="stat-avg-length">—</span>
      <span class="stat-label">Average argument</span>
    </div>
    <div class="stat-card audio-stat" hidden>
      <span class="stat-value" id="stat-opinion-hours">—</span>
      <span class="stat-label">Opinion audio</span>
    </div>
    <div class="stat-card audio-stat" hidden>
      <span class="stat-value" id="stat-avg-opinion">—</span>
      <span class="stat-label">Average opinion</span>
    </div>
  </div>
  <p class="stats-note" id="stats-note"></p>
  <div class="calendar-heading-row">
    <h2 id="term-calendar-heading" hidden>Court Calendar</h2>
    <div class="stats-term-nav" id="stats-term-nav" hidden>
      <button class="stats-term-nav-btn" id="stat-prev-term" hidden></button>
      <button class="stats-term-nav-btn" id="stat-next-term" hidden></button>
    </div>
  </div>
  <div id="term-calendar" hidden></div>

  <h2 id="case-listing-heading" hidden>Court Case Listing</h2>
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
  <div id="history-view" hidden></div>

  <h2 id="all-terms-calendar-heading" hidden>Court Calendar</h2>
  <div id="all-terms-calendars"></div>
</div>
