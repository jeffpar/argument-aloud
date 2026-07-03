---
layout: pane
title: Justice Benches
---

<style>
.jb-page-title {
  margin: 0;
  font-weight: 700;
}
.jb-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 14px;
}
.jb-sort-btn {
  padding: 2px 8px;
  font-size: 0.68rem;
  font-weight: 600;
  border-radius: 12px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  opacity: 0.6;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.6;
  transition: opacity 0.15s;
}
.jb-sort-btn:hover { opacity: 1; }
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
.jb-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 6px;
}
.jb-title-row .jb-detail-title { flex: 1; margin: 0; }
.jb-bench-nav {
  display: flex;
  gap: 0.6rem;
  font-size: 0.72rem;
  flex-shrink: 0;
}
.jb-bench-nav-btn {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font-size: inherit;
  opacity: 0.6;
  white-space: nowrap;
}
.jb-bench-nav-btn:hover { opacity: 1; color: #4a9eff; text-decoration: underline; }
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
.jb-photo-frame {
  max-width: 480px;
  margin: 24px auto 16px;
  padding: 8px;
  background: linear-gradient(145deg,#c8a44e 0%,#7c560e 25%,#b8900a 50%,#7c560e 75%,#c8a44e 100%);
  border: 1px solid rgba(0,0,0,0.45);
  box-shadow: inset 0 0 0 1px rgba(255,218,100,0.55), inset 0 0 8px rgba(0,0,0,0.25), 4px 6px 18px rgba(0,0,0,0.45);
}
.jb-photo-frame img {
  width: 100%;
  height: auto;
  display: block;
}
.jb-name-list {
  text-align: center;
  font-size: 0.75rem;
  opacity: 0.7;
  margin: 0 0 20px;
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

  // bench.justices stores full capitalized names (e.g. "WARREN BURGER"), not
  // ids — mirrors _justiceSlug in scripts/update_cases.js (itself mirroring
  // makeAdvocateId in update_advocates.js) to derive the id used elsewhere
  // (portrait paths, gallery/justiceMap lookups).
  function justiceSlug(name) {
    var ascii = String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    var noPunct = ascii.replace(/[^\w\s-]/g, '');
    return noPunct.replace(/[\s\-_]+/g, '_').replace(/^_+|_+$/g, '');
  }

  // Title-case a full-caps name (e.g. "WARREN BURGER" -> "Warren Burger"),
  // used as a display fallback when a justice isn't found in justiceMap.
  function titleCaseName(name) {
    return String(name || '').toLowerCase().replace(/\b([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  // "Burger 1 (1969–1970)" -> "Burger 1", for compact prev/next nav labels.
  function benchShortLabel(name) {
    return String(name || '').replace(/\s*\([^)]*\)\s*$/, '');
  }

  function renderBenchPhoto(bench) {
    if (!bench.image) return null;
    var wrap = document.createElement('div');
    wrap.className = 'jb-photo-frame';
    var img = document.createElement('img');
    img.src = bench.image;
    img.alt = bench.name;
    img.loading = 'lazy';
    img.onerror = function () { wrap.remove(); };
    wrap.appendChild(img);
    return wrap;
  }

  function renderNameList(bench, justiceMap) {
    var p = document.createElement('p');
    p.className = 'jb-name-list';
    var names = bench.justices.map(function (name) {
      var j = justiceMap[justiceSlug(name)];
      return j ? j.name : titleCaseName(name);
    }).join(', ');
    p.textContent = 'In seniority order: ' + names;
    return p;
  }

  function renderRow(bench, justiceMap) {
    var row = document.createElement('div');
    row.className = 'jb-row';
    bench.justices.forEach(function (name) {
      var jid = justiceSlug(name);
      var j = justiceMap[jid];
      var el = document.createElement('a');
      el.className = 'jb-item';
      el.href = '/courts/ussc/?collection=gallery&id=' + jid;
      el.target = '_top';

      var portrait = document.createElement('div');
      portrait.className = 'jb-portrait';

      var img = document.createElement('img');
      img.src = PORTRAIT_BASE + jid + '/portrait.jpg';
      img.alt = j ? j.name : titleCaseName(name);
      img.loading = 'lazy';
      img.onerror = function () { portrait.style.background = 'transparent'; this.style.display = 'none'; };
      portrait.appendChild(img);

      var label = document.createElement('div');
      label.className = 'jb-name';
      var displayName = j ? j.name : titleCaseName(name);
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

      var titleRow = document.createElement('div');
      titleRow.className = 'jb-title-row';

      var title = document.createElement('h1');
      title.className = 'jb-detail-title';
      title.textContent = bench.name;
      titleRow.appendChild(title);

      var nav = document.createElement('div');
      nav.className = 'jb-bench-nav';
      var chronological = benches.slice().sort(function (a, b) {
        return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0;
      });
      var benchIdx = chronological.findIndex(function (b) { return b.id === bench.id; });
      var prevBench = benchIdx > 0 ? chronological[benchIdx - 1] : null;
      var nextBench = (benchIdx >= 0 && benchIdx < chronological.length - 1) ? chronological[benchIdx + 1] : null;
      function navTo(id) {
        var s = '?collection=benches&id=' + encodeURIComponent(id);
        if (window.parent !== window) { window.parent.postMessage({ type: 'ussc-navigate', search: s }, location.origin); }
        else { location.href = s; }
      }
      if (prevBench) {
        var prevBtn = document.createElement('button');
        prevBtn.className = 'jb-bench-nav-btn';
        prevBtn.textContent = '« ' + benchShortLabel(prevBench.name);
        prevBtn.addEventListener('click', function () { navTo(prevBench.id); });
        nav.appendChild(prevBtn);
      }
      if (nextBench) {
        var nextBtn = document.createElement('button');
        nextBtn.className = 'jb-bench-nav-btn';
        nextBtn.textContent = benchShortLabel(nextBench.name) + ' »';
        nextBtn.addEventListener('click', function () { navTo(nextBench.id); });
        nav.appendChild(nextBtn);
      }
      titleRow.appendChild(nav);

      var meta = document.createElement('p');
      meta.className = 'jb-detail-dates';
      var dateSpan = document.createElement('span');
      dateSpan.textContent = fmtDate(bench.dateStart) + ' to ' + fmtDate(bench.dateStop);
      var countSpan = document.createElement('span');
      var n = bench.cases || 0;
      countSpan.textContent = n.toLocaleString() + ' case' + (n === 1 ? '' : 's');
      meta.appendChild(dateSpan);
      meta.appendChild(countSpan);

      container.appendChild(titleRow);
      container.appendChild(meta);
      container.appendChild(renderRow(bench, justiceMap));
      var photo = renderBenchPhoto(bench);
      if (photo) container.appendChild(photo);
      container.appendChild(renderNameList(bench, justiceMap));
    } else {
      var pageHeader = document.createElement('div');
      pageHeader.className = 'jb-list-header';

      var pageTitle = document.createElement('h1');
      pageTitle.className = 'jb-page-title';
      pageTitle.textContent = 'Justice Benches';

      var sortBtn = document.createElement('button');
      sortBtn.className = 'jb-sort-btn';

      pageHeader.appendChild(pageTitle);
      pageHeader.appendChild(sortBtn);
      container.appendChild(pageHeader);

      var listEl = document.createElement('div');
      container.appendChild(listEl);

      var _bParams    = new URLSearchParams(location.search);
      var activeOrder = _bParams.get('order') === 'oldest' ? 'oldest' : 'newest';

      function renderList() {
        listEl.innerHTML = '';
        sortBtn.textContent = activeOrder === 'newest' ? 'Newest' : 'Oldest';

        var ordered = benches.slice().sort(function (a, b) {
          return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0;
        });
        if (activeOrder === 'newest') ordered.reverse();

        var grandTotal = 0;
        ordered.forEach(function (bench, i) {
          if (i > 0) {
            var sep = document.createElement('hr');
            sep.className = 'jb-separator';
            listEl.appendChild(sep);
          }

          var heading = document.createElement('a');
          heading.className = 'jb-heading';
          heading.textContent = bench.name;
          heading.href = '/courts/ussc/?collection=benches&id=' + bench.id;
          heading.target = '_top';
          listEl.appendChild(heading);

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
          listEl.appendChild(meta);

          listEl.appendChild(renderRow(bench, justiceMap));
        });

        var sep = document.createElement('hr');
        sep.className = 'jb-separator';
        listEl.appendChild(sep);
        var total = document.createElement('p');
        total.style.cssText = 'text-align:right;font-size:0.75rem;font-weight:700;margin:0';
        total.textContent = grandTotal.toLocaleString() + ' cases total';
        listEl.appendChild(total);

        // Keep the sidebar in sync: whichever bench is first under the
        // current sort should stay in view there too.
        if (ordered.length && window.parent !== window) {
          window.parent.postMessage({ type: 'ussc-scroll-collection-item', collection: 'benches', id: ordered[0].id }, location.origin);
        }
      }

      sortBtn.addEventListener('click', function () {
        activeOrder = activeOrder === 'newest' ? 'oldest' : 'newest';
        var url = new URL(location.href);
        if (activeOrder === 'oldest') url.searchParams.set('order', 'oldest');
        else url.searchParams.delete('order');
        history.replaceState(null, '', url);
        renderList();
      });

      renderList();
    }
  });
})();
</script>
