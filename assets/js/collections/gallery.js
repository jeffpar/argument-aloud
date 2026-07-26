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
      portrait.className = 'portrait-photo';

      var img = document.createElement('img');
      img.src = PORTRAIT_BASE + j.id + '/portrait.jpg';
      img.alt = j.name;
      img.loading = 'lazy';
      img.onerror = function () { el.style.display = 'none'; };
      portrait.appendChild(img);

      var label = document.createElement('div');
      label.className = 'portrait-name jg-name';
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
          // Inclusive of both the start day and today.
          j.yearsServed = (Math.max(0, nowMs - Date.parse(j.dateStart)) + 86400000) / (365.25 * 86400000);
        }
        return j;
      });
      document.getElementById('jg-active-only').checked = activeOnly;
      updateButtons();
      renderGrid();
    });
})();
