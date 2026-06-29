---
layout: pane
title: Benches
---

<style>
.jb-separator {
  border: none;
  border-top: 1px solid currentColor;
  opacity: 0.2;
  margin: 18px 0;
}
.jb-heading {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  margin: 0 0 4px;
  text-decoration: none;
  color: inherit;
  display: block;
  opacity: 0.8;
}
.jb-heading:hover { opacity: 1; }
.jb-meta {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 0.68rem;
  opacity: 0.6;
  margin: 0 0 10px;
}
.jb-row {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 16px 8px;
  margin-bottom: 4px;
}
@media (max-width: 600px) {
  .jb-row { grid-template-columns: repeat(4, 1fr); }
}
.jb-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-decoration: none;
  color: inherit;
}
.jb-item:hover .jb-portrait { opacity: 0.82; }
.jb-portrait {
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: 6px;
  background: #ccc;
}
html[data-theme="dark"] .jb-portrait { background: #3a3c45; }
.jb-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
  display: block;
}
.jb-name {
  font-size: 0.54rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  margin-top: 4px;
  text-align: center;
  word-break: break-word;
  line-height: 1.2;
}
/* detail view */
.jb-detail-title {
  font-size: 1.3rem;
  font-weight: 700;
  margin: 0 0 6px;
}
.jb-detail-dates {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 0.8rem;
  opacity: 0.7;
  margin: 0 0 16px;
}
</style>

<div id="jb-container"></div>

<script>
(function () {
  var PORTRAIT_BASE = '/courts/ussc/people/justices/all/';
  var MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

  function fmtDate(iso) {
    if (!iso) return 'present';
    var p = iso.split('-');
    return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + ', ' + p[0];
  }

  function renderRow(bench, justiceMap) {
    var row = document.createElement('div');
    row.className = 'jb-row';
    bench.justices.forEach(function (jid) {
      var j = justiceMap[jid];
      var el = document.createElement('a');
      el.className = 'jb-item';
      el.href = '/courts/ussc/?collection=gallery&id=' + jid;
      el.target = '_top';

      var portrait = document.createElement('div');
      portrait.className = 'jb-portrait';

      var img = document.createElement('img');
      img.src = PORTRAIT_BASE + jid + '/portrait.jpg';
      img.alt = j ? j.name : jid;
      img.loading = 'lazy';
      img.onerror = function () { portrait.style.background = 'transparent'; this.style.display = 'none'; };
      portrait.appendChild(img);

      var label = document.createElement('div');
      label.className = 'jb-name';
      var displayName = j ? j.name : jid;
      var words = displayName.trim().split(/\s+/);
      label.textContent = words[words.length - 1].toUpperCase();

      el.appendChild(portrait);
      el.appendChild(label);
      row.appendChild(el);
    });
    return row;
  }

  var activeId = new URLSearchParams(location.search).get('id');

  Promise.all([
    fetch('/courts/ussc/people/justices/benches.json').then(function (r) { return r.json(); }),
    fetch('/courts/ussc/people/justices/gallery.json').then(function (r) { return r.json(); })
  ]).then(function (results) {
    var benches    = results[0];
    var gallery    = results[1];
    var justiceMap = {};
    gallery.forEach(function (j) { justiceMap[j.id] = j; });

    var container = document.getElementById('jb-container');

    if (activeId) {
      var bench = benches.find(function (b) { return b.id === activeId; });
      if (!bench) return;

      var title = document.createElement('h1');
      title.className = 'jb-detail-title';
      title.textContent = bench.name;

      var meta = document.createElement('p');
      meta.className = 'jb-detail-dates';
      var dateSpan = document.createElement('span');
      dateSpan.textContent = fmtDate(bench.dateStart) + ' to ' + fmtDate(bench.dateStop);
      var countSpan = document.createElement('span');
      var n = bench.cases || 0;
      countSpan.textContent = n.toLocaleString() + ' case' + (n === 1 ? '' : 's');
      meta.appendChild(dateSpan);
      meta.appendChild(countSpan);

      container.appendChild(title);
      container.appendChild(meta);
      container.appendChild(renderRow(bench, justiceMap));
    } else {
      var grandTotal = 0;
      benches.forEach(function (bench, i) {
        if (i > 0) {
          var sep = document.createElement('hr');
          sep.className = 'jb-separator';
          container.appendChild(sep);
        }

        var heading = document.createElement('a');
        heading.className = 'jb-heading';
        heading.textContent = bench.name;
        heading.href = '/courts/ussc/?collection=benches&id=' + bench.id;
        heading.target = '_top';
        container.appendChild(heading);

        var n = bench.cases || 0;
        grandTotal += n;
        var meta = document.createElement('div');
        meta.className = 'jb-meta';
        var dateSpan = document.createElement('span');
        dateSpan.textContent = fmtDate(bench.dateStart) + ' to ' + fmtDate(bench.dateStop);
        var countSpan = document.createElement('span');
        countSpan.textContent = n.toLocaleString() + ' case' + (n === 1 ? '' : 's');
        meta.appendChild(dateSpan);
        meta.appendChild(countSpan);
        container.appendChild(meta);

        container.appendChild(renderRow(bench, justiceMap));
      });

      var sep = document.createElement('hr');
      sep.className = 'jb-separator';
      container.appendChild(sep);
      var total = document.createElement('p');
      total.style.cssText = 'text-align:right;font-size:0.75rem;font-weight:700;margin:0';
      total.textContent = grandTotal.toLocaleString() + ' cases total';
      container.appendChild(total);
    }
  });
})();
</script>
