---
layout: pane
title: Gallery of Justices
---

<style>
.jg-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.jg-heading {
  margin: 0;
  font-weight: 700;
  white-space: nowrap;
}
.jg-sort-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.jg-sort-btn {
  padding: 2px 8px;
  font-size: 0.68rem;
  font-weight: 600;
  border-radius: 12px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  opacity: 0.45;
  cursor: pointer;
  white-space: nowrap;
  line-height: 1.6;
  transition: opacity 0.15s;
}
.jg-sort-btn:hover  { opacity: 0.75; }
.jg-sort-btn.active { opacity: 1; }
.jg-grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 16px 8px;
  padding-bottom: 24px;
}
@media (max-width: 600px) {
  .jg-grid { grid-template-columns: repeat(4, 1fr); }
}
.jg-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-decoration: none;
  color: inherit;
  cursor: default;
}
a.jg-item { cursor: pointer; }
a.jg-item:hover .jg-portrait { opacity: 0.82; }
.jg-portrait {
  width: 100%;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: 6px;
  background: #ccc;
}
html[data-theme="dark"] .jg-portrait { background: #3a3c45; }
.jg-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;
  display: block;
}
.jg-name {
  font-size: 0.54rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  margin-top: 5px;
  text-align: center;
  word-break: break-word;
  line-height: 1.2;
}
.jg-sub {
  font-size: 0.48rem;
  opacity: 0.65;
  text-align: center;
  margin-top: 2px;
  line-height: 1.2;
  word-break: break-word;
}
</style>

<div class="jg-header">
  <h1 class="jg-heading">Gallery</h1>
  <div class="jg-sort-bar" id="jg-sort-bar">
    <button class="jg-sort-btn active" data-sort="joined" data-label="Joined">Joined ↑</button>
    <button class="jg-sort-btn" data-sort="years" data-label="Years Served">Years Served ↓</button>
    <button class="jg-sort-btn" data-sort="lone" data-label="Lone Dissents">Lone Dissents ↓</button>
    <button class="jg-sort-btn" data-sort="vocal" data-label="Vocal">Vocal ↓</button>
  </div>
</div>
<div id="jg-grid" class="jg-grid"></div>

<script>
(function () {
  var PORTRAIT_BASE = '/courts/ussc/people/justices/all/';
  var OP_URL        = '/courts/ussc/?collection=opinions&id=';

  var MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

  function _fmtDate(iso) {
    if (!iso) return '';
    var p = iso.split('-');
    return MONTHS[+p[1] - 1] + ' ' + (+p[2]) + ', ' + p[0];
  }

  function subLabel(j, sort) {
    if (sort === 'joined') {
      return _fmtDate(j.dateFirst);
    } else if (sort === 'years') {
      return j.yearsServed != null ? (+j.yearsServed).toFixed(1) + ' years' : '';
    } else if (sort === 'lone') {
      var n = j.loneDissents != null ? j.loneDissents : 0;
      return n + ' dissent' + (n === 1 ? '' : 's');
    } else if (sort === 'vocal') {
      return j.vocalSecs != null ? (j.vocalSecs / 3600).toFixed(1) + ' hours' : '';
    }
    return '';
  }

  var SORTERS = {
    joined: function (a, b) { return (a.dateFirst || '').localeCompare(b.dateFirst || ''); },
    years:  function (a, b) { return (a.yearsServed  != null ? a.yearsServed  : -1) - (b.yearsServed  != null ? b.yearsServed  : -1); },
    lone:   function (a, b) { return (a.loneDissents != null ? a.loneDissents : -1) - (b.loneDissents != null ? b.loneDissents : -1); },
    vocal:  function (a, b) { return (a.vocalSecs    != null ? a.vocalSecs    : -1) - (b.vocalSecs    != null ? b.vocalSecs    : -1); },
  };

  var DEFAULTS = { joined: true, years: false, lone: false, vocal: false };

  var _params   = new URLSearchParams(location.search);

  function _pushSortUrl(key, asc) {
    var search = '?sort=' + key + '&o=' + (asc ? 'a' : 'd');
    history.replaceState(null, '', location.pathname + search);
    if (window.parent !== window) {
      window.parent.postMessage({ type: 'ussc-update-sort', sort: key, o: asc ? 'a' : 'd' }, location.origin);
    }
  }

  var justices   = [];
  var activeSort = _params.get('sort') || 'joined';
  var activeAsc  = _params.has('o') ? _params.get('o') === 'a' : DEFAULTS[activeSort];

  function updateButtons() {
    document.querySelectorAll('.jg-sort-btn').forEach(function (b) {
      var key = b.dataset.sort;
      var on  = key === activeSort;
      var asc = on ? activeAsc : DEFAULTS[key];
      b.classList.toggle('active', on);
      b.textContent = b.dataset.label + ' ' + (asc ? '↑' : '↓');
    });
  }

  function renderGrid() {
    var dir    = activeAsc ? 1 : -1;
    var sorted = justices.slice().sort(function (a, b) { return SORTERS[activeSort](a, b) * dir; });
    var grid = document.getElementById('jg-grid');
    grid.innerHTML = '';
    sorted.forEach(function (j) {
      var words = j.name.trim().split(/\s+/);
      var lastName = words[words.length - 1].toUpperCase();

      var el = document.createElement('a');
      el.className = 'jg-item';
      el.href = '/courts/ussc/?collection=gallery&id=' + j.id;
      el.target = '_top';

      var portrait = document.createElement('div');
      portrait.className = 'jg-portrait';

      var img = document.createElement('img');
      img.src = PORTRAIT_BASE + j.id + '/portrait.jpg';
      img.alt = j.name;
      img.loading = 'lazy';
      img.onerror = function () { el.style.display = 'none'; };
      portrait.appendChild(img);

      var label = document.createElement('div');
      label.className = 'jg-name';
      label.textContent = lastName;

      var sub = document.createElement('div');
      sub.className = 'jg-sub';
      sub.textContent = subLabel(j, activeSort);

      el.appendChild(portrait);
      el.appendChild(label);
      el.appendChild(sub);
      grid.appendChild(el);
    });
  }

  document.getElementById('jg-sort-bar').addEventListener('click', function (e) {
    var btn = e.target.closest('.jg-sort-btn');
    if (!btn) return;
    var sort = btn.dataset.sort;
    if (sort === activeSort) {
      activeAsc = !activeAsc;
    } else {
      activeSort = sort;
      activeAsc  = DEFAULTS[sort];
    }
    _pushSortUrl(activeSort, activeAsc);
    updateButtons();
    renderGrid();
  });

  fetch('/courts/ussc/people/justices/gallery.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      justices = data;
      updateButtons();
      renderGrid();
    });
})();
</script>
