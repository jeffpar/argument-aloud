---
layout: pane
title: Justice Gallery
styles:
- /assets/css/pages.css
scripts:
- /assets/js/collections/gallery.js
---
<div class="jg-header">
  <div class="jg-header-row">
    <h1 class="jg-heading">Justice Gallery</h1>
    <label class="filter-label" id="jg-active-label">
      <input type="checkbox" id="jg-active-only"> Currently Serving
    </label>
  </div>
  <div class="jg-sort-bar" id="jg-sort-bar">
    <button class="grid-sort-btn jg-sort-btn active" data-sort="joined" data-label="Joined">Seniority</button>
    <button class="grid-sort-btn jg-sort-btn" data-sort="years" data-label="Served">Served ↓</button>
    <button class="grid-sort-btn jg-sort-btn" data-sort="lone" data-label="Lone Dissents">Lone Dissents ↓</button>
    <button class="grid-sort-btn jg-sort-btn" data-sort="vocal" data-label="Vocal">Vocal ↓</button>
  </div>
</div>
<div id="jg-grid" class="jg-grid"></div>
