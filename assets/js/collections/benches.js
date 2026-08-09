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

  // Last name for a portrait label — "John Harlan, II" -> "HARLAN", not "II"
  // (mirrors lastName() in assets/js/explorer.js; duplicated here since this
  // script runs in its own page, not alongside explorer.js).
  function lastName(name) {
    var stripped = String(name || '').replace(/,\s*(JR\.|SR\.|[IV]+)\s*$/i, '').trim();
    return stripped.split(/\s+/).pop() || name;
  }

  // Default caption for any bench photo (see scripts/update_cases.js's
  // _benchImages) that has no .txt of its own.
  function benchSeniorityText(bench, justiceMap) {
    var names = bench.justices.map(function (name) {
      var j = justiceMap[justiceSlug(name)];
      var display = j ? j.name : titleCaseName(name);
      // "John Harlan, II" -> "John Harlan II" -- the embedded comma reads as
      // part of the seniority list's own ", "-separated punctuation.
      return display.replace(/,\s*(Jr|Sr|II|III|IV)\.?$/i, ' $1');
    }).join(', ');
    return 'In seniority order: ' + names;
  }

  // Appends `text` to `el` as separate text nodes joined by <br>, so line
  // breaks written into a bench photo's .txt caption (see scripts/
  // update_cases.js's _benchImages) survive onto the page — plain
  // textContent would collapse them to a single line like any other HTML
  // whitespace.
  function appendTextWithBreaks(el, text) {
    String(text || '').split(/\r\n|\r|\n/).forEach(function (line, i) {
      if (i > 0) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(line));
    });
  }

  function renderNameList(bench, justiceMap) {
    var p = document.createElement('p');
    p.className = 'jb-name-list';
    p.textContent = benchSeniorityText(bench, justiceMap);
    return p;
  }

  // Every photo in bench.images: the first gets the ornate primary-photo
  // frame, any additional ones are shown plain — the same fashion as
  // _includes/generic-image.html, photo then caption underneath. Each
  // photo's own desc is used when present, else the generic seniority-order
  // description (see benchSeniorityText) shared by every uncaptioned photo.
  function renderBenchImages(bench, justiceMap) {
    if (!bench.images || !bench.images.length) return null;
    var frag = document.createDocumentFragment();
    bench.images.forEach(function (image, i) {
      var desc = image.desc || benchSeniorityText(bench, justiceMap);
      if (i === 0) {
        var wrap = document.createElement('div');
        wrap.className = 'jb-photo-frame';
        var img = document.createElement('img');
        img.src = image.path;
        img.alt = bench.name;
        img.loading = 'lazy';
        img.onerror = function () { wrap.remove(); };
        wrap.appendChild(img);
        frag.appendChild(wrap);
        var p = document.createElement('p');
        p.className = 'jb-name-list';
        appendTextWithBreaks(p, desc);
        frag.appendChild(p);
      } else {
        var extraP = document.createElement('p');
        extraP.className = 'jb-extra-photo';
        var extraImg = document.createElement('img');
        extraImg.src = image.path;
        extraImg.alt = desc;
        extraImg.loading = 'lazy';
        extraImg.onerror = function () { extraP.remove(); };
        extraP.appendChild(extraImg);
        extraP.appendChild(document.createElement('br'));
        var span = document.createElement('span');
        span.className = 'jb-extra-photo-desc';
        appendTextWithBreaks(span, desc);
        extraP.appendChild(span);
        frag.appendChild(extraP);
      }
    });
    return frag;
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
      label.textContent = lastName(displayName).toUpperCase();

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
      var images = renderBenchImages(bench, justiceMap);
      if (images) container.appendChild(images);
      else container.appendChild(renderNameList(bench, justiceMap));
    } else {
      var pageHeader = document.createElement('div');
      pageHeader.className = 'jb-list-header';

      var pageTitle = document.createElement('h1');
      pageTitle.className = 'jb-page-title';
      pageTitle.textContent = 'Justice Benches';

      var headerRight = document.createElement('div');
      headerRight.className = 'jb-header-right';

      // Overview (one bench photo per bench, gallery-page fashion) vs.
      // Detail (one row of justice portraits per bench, as before).
      var viewToggle = document.createElement('div');
      viewToggle.className = 'jb-view-toggle';
      var overviewBtn = document.createElement('button');
      overviewBtn.className = 'grid-sort-btn jb-view-btn';
      overviewBtn.dataset.view = 'overview';
      overviewBtn.textContent = 'Overview';
      var detailBtn = document.createElement('button');
      detailBtn.className = 'grid-sort-btn jb-view-btn';
      detailBtn.dataset.view = 'detail';
      detailBtn.textContent = 'Detail';
      viewToggle.appendChild(overviewBtn);
      viewToggle.appendChild(detailBtn);

      var sortBtn = document.createElement('button');
      sortBtn.className = 'grid-sort-btn jb-sort-btn';

      headerRight.appendChild(viewToggle);
      headerRight.appendChild(sortBtn);
      pageHeader.appendChild(pageTitle);
      pageHeader.appendChild(headerRight);
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
      var activeView  = _bParams.get('view') === 'detail' ? 'detail' : 'overview';

      function updateViewButtons() {
        detailBtn.classList.toggle('active', activeView === 'detail');
        overviewBtn.classList.toggle('active', activeView === 'overview');
      }

      // One bench photo per bench (its images[0] — see scripts/update_cases.js's
      // _benchImages), same grid/caption fashion as the Justice Gallery
      // (.jg-grid/.jg-item) — 2-line caption: bench short name (e.g. "STONE 1"),
      // then its year range, both already embedded in bench.name. A bench with
      // no photo is left out rather than shown as a broken image.
      function renderOverviewGrid(ordered) {
        var grid = document.createElement('div');
        grid.className = 'jg-grid';
        ordered.forEach(function (bench) {
          if (!bench.images || !bench.images.length) return;
          var el = document.createElement('a');
          el.className = 'jg-item';
          el.href = '/courts/ussc/?collection=benches&id=' + bench.id;
          el.target = '_top';

          var photo = document.createElement('div');
          photo.className = 'jb-grid-photo';
          var img = document.createElement('img');
          img.src = bench.images[0].path;
          img.alt = bench.name;
          img.loading = 'lazy';
          img.onerror = function () { el.style.display = 'none'; };
          photo.appendChild(img);

          var nameEl = document.createElement('div');
          nameEl.className = 'portrait-name jg-name';
          nameEl.textContent = benchShortLabel(bench.name).toUpperCase();

          var yearsEl = document.createElement('div');
          yearsEl.className = 'jg-sub';
          var yearMatch = bench.name.match(/\(([^)]*)\)\s*$/);
          yearsEl.textContent = yearMatch ? yearMatch[1] : '';

          el.appendChild(photo);
          el.appendChild(nameEl);
          el.appendChild(yearsEl);
          grid.appendChild(el);
        });
        listEl.appendChild(grid);
      }

      function renderList() {
        listEl.innerHTML = '';
        sortBtn.textContent = activeOrder === 'newest' ? 'Newest' : 'Oldest';

        var ordered = benches.slice().sort(function (a, b) {
          return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0;
        });
        if (activeOrder === 'newest') ordered.reverse();

        if (activeView === 'overview') {
          renderOverviewGrid(ordered);
          return;
        }

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

      viewToggle.addEventListener('click', function (e) {
        var btn = e.target.closest('.jb-view-btn');
        if (!btn || btn.dataset.view === activeView) return;
        activeView = btn.dataset.view;
        var url = new URL(location.href);
        if (activeView === 'detail') url.searchParams.set('view', 'detail');
        else url.searchParams.delete('view');
        history.replaceState(null, '', url);
        updateViewButtons();
        renderList();
      });

      updateViewButtons();
      renderList();
    }
  });
})();
