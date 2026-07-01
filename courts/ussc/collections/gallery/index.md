---
layout: pane
title: Justice Gallery
---

<style>
.jg-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.jg-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.jg-heading {
  margin: 0;
  font-weight: 700;
  white-space: nowrap;
}
.jg-sort-bar {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.jg-filter-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.68rem;
  font-weight: 600;
  opacity: 0.65;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.jg-filter-label:hover { opacity: 0.9; }
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
@keyframes jg-jiggle {
  0%   { transform: scale(1);    }
  30%  { transform: scale(0.88); }
  65%  { transform: scale(1.12); }
  100% { transform: scale(1);    }
}
.jg-jiggle {
  animation: jg-jiggle 1.4s ease-in-out 1;
}
</style>

<div class="jg-header">
  <div class="jg-header-row">
    <h1 class="jg-heading">Justice Gallery</h1>
    <label class="jg-filter-label" id="jg-active-label">
      <input type="checkbox" id="jg-active-only"> Currently Serving
    </label>
  </div>
  <div class="jg-sort-bar" id="jg-sort-bar">
    <button class="jg-sort-btn active" data-sort="joined" data-label="Joined">Seniority</button>
    <button class="jg-sort-btn" data-sort="years" data-label="Served">Served ↓</button>
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

  function subLabel(j, sort, seniority) {
    if (sort === 'joined') {
      return _fmtDate(j.dateStart);
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
    seniority: function (a, b) {
      var ac = a.title === 'Chief Justice', bc = b.title === 'Chief Justice';
      if (ac !== bc) return ac ? -1 : 1;
      return (a.dateStart || '').localeCompare(b.dateStart || '');
    },
    joined: function (a, b) { return (a.dateStart || '').localeCompare(b.dateStart || ''); },
    years:  function (a, b) { return (a.yearsServed  != null ? a.yearsServed  : -1) - (b.yearsServed  != null ? b.yearsServed  : -1); },
    lone:   function (a, b) { return (a.loneDissents != null ? a.loneDissents : -1) - (b.loneDissents != null ? b.loneDissents : -1); },
    vocal:  function (a, b) { return (a.vocalSecs    != null ? a.vocalSecs    : -1) - (b.vocalSecs    != null ? b.vocalSecs    : -1); },
  };

  var DEFAULTS = { joined: true, years: false, lone: false, vocal: false };

  var _params   = new URLSearchParams(location.search);
  var _anchorId = _params.get('anchor') || location.hash.slice(1);
  var _anchored = false;

  // Tri-state for "joined": seniority (default, no arrow) → asc ↑ → desc ↓ → seniority
  var activeSort     = _params.get('sort') || 'joined';
  var _oParam        = _params.get('o');
  var activeSeniority = activeSort === 'joined' && (_oParam == null || _oParam === 'seniority');
  var activeAsc      = _oParam === 'a' ? true : (_oParam === 'd' ? false : DEFAULTS[activeSort]);
  var activeOnly     = _params.get('s') === '1';

  function _pushUrl() {
    var o = (activeSort === 'joined' && activeSeniority) ? '' : (activeAsc ? 'a' : 'd');
    var search = '?sort=' + activeSort + (o ? '&o=' + o : '') + (activeOnly ? '&s=1' : '');
    history.replaceState(null, '', location.pathname + search);
    if (window.parent !== window) {
      var msg = { type: 'ussc-update-sort', sort: activeSort, o: o || 'seniority' };
      if (activeOnly) msg.s = '1';
      window.parent.postMessage(msg, location.origin);
    }
  }

  function updateButtons() {
    document.querySelectorAll('.jg-sort-btn').forEach(function (b) {
      var key = b.dataset.sort;
      var on  = key === activeSort;
      b.classList.toggle('active', on);
      if (key === 'joined' && on && activeSeniority) {
        b.textContent = 'Seniority';
      } else {
        var asc = on ? activeAsc : DEFAULTS[key];
        b.textContent = b.dataset.label + ' ' + (asc ? '↑' : '↓');
      }
    });
  }

  function renderGrid() {
    var pool = activeOnly ? justices.filter(function (j) { return !j.dateStop; }) : justices;
    var sorted;
    if (activeSort === 'joined' && activeSeniority) {
      sorted = pool.slice().sort(SORTERS.seniority);
    } else {
      var dir = activeAsc ? 1 : -1;
      sorted = pool.slice().sort(function (a, b) { return SORTERS[activeSort](a, b) * dir; });
    }
    var grid = document.getElementById('jg-grid');
    grid.innerHTML = '';
    sorted.forEach(function (j) {
      var words    = j.name.trim().split(/\s+/);
      var lastName = words[words.length - 1].toUpperCase();
      var prefix   = j.title === 'Chief Justice' ? 'C.J. ' : 'J. ';

      var coll = activeSort === 'lone'  ? 'lone_dissents'  :
                 activeSort === 'vocal' ? 'vocal_justices' : 'gallery';
      var sortExtra = '';
      if (coll === 'gallery' && !(activeSort === 'joined' && activeSeniority)) {
        sortExtra += '&sort=' + activeSort + '&o=' + (activeAsc ? 'a' : 'd');
      }
      if (activeOnly) sortExtra += '&s=1';
      var el = document.createElement('a');
      el.className = 'jg-item';
      el.id = j.id;
      el.href = '/courts/ussc/?collection=' + coll + '&id=' + j.id + sortExtra;
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
      label.textContent = prefix + lastName;

      var sub = document.createElement('div');
      sub.className = 'jg-sub';
      sub.textContent = subLabel(j, activeSort, activeSeniority);

      el.appendChild(portrait);
      el.appendChild(label);
      el.appendChild(sub);
      grid.appendChild(el);
    });
    if (_anchorId && !_anchored) {
      _anchored = true;
      var _anchorEl = document.getElementById(_anchorId);
      if (_anchorEl) requestAnimationFrame(function () {
        _anchorEl.scrollIntoView({ behavior: 'instant', block: 'center' });
        _anchorEl.classList.add('jg-jiggle');
        setTimeout(function () { _anchorEl.classList.remove('jg-jiggle'); }, 1400);
      });
    }
  }

  document.getElementById('jg-sort-bar').addEventListener('click', function (e) {
    var btn = e.target.closest('.jg-sort-btn');
    if (!btn) return;
    var sort = btn.dataset.sort;
    if (sort === activeSort) {
      if (sort === 'joined') {
        if (activeSeniority)     { activeSeniority = false; activeAsc = true;  }  // → Joined ↑
        else if (activeAsc)      { activeAsc = false; }                             // → Joined ↓
        else                     { activeSeniority = true; }                        // → Seniority
      } else {
        activeAsc = !activeAsc;
      }
    } else {
      activeSort      = sort;
      activeSeniority = sort === 'joined';
      activeAsc       = DEFAULTS[sort];
    }
    _pushUrl();
    updateButtons();
    renderGrid();
  });

  document.getElementById('jg-active-only').addEventListener('change', function (e) {
    activeOnly = e.target.checked;
    _pushUrl();
    renderGrid();
  });

  fetch('/courts/ussc/people/justices/gallery.json')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var nowMs = Date.now();
      justices = data.map(function (j) {
        if (!j.dateStop && j.dateStart) {
          j.yearsServed = Math.max(0, nowMs - Date.parse(j.dateStart)) / (365.25 * 86400000);
        }
        return j;
      });
      document.getElementById('jg-active-only').checked = activeOnly;
      updateButtons();
      renderGrid();
    });
})();
</script>
