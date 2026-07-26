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
      portrait.className = 'portrait-photo';

      var img = document.createElement('img');
      img.src = PORTRAIT_BASE + jid + '/portrait.jpg';
      img.alt = j ? j.name : titleCaseName(name);
      img.loading = 'lazy';
      img.onerror = function () { portrait.style.background = 'transparent'; this.style.display = 'none'; };
      portrait.appendChild(img);

      var label = document.createElement('div');
      label.className = 'portrait-name jb-name';
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
      sortBtn.className = 'grid-sort-btn jb-sort-btn';

      pageHeader.appendChild(pageTitle);
      pageHeader.appendChild(sortBtn);
      container.appendChild(pageHeader);

      var intro = document.getElementById('jb-intro');
      if (intro) {
        intro.style.display = 'block';
        container.appendChild(intro);
      }

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
