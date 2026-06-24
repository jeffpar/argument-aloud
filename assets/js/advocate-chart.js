/**
 * Renders a horizontal bar chart of advocates over time.
 *
 * @param {string} canvasId   - ID of the <canvas> element to render into
 * @param {string} dataUrl    - URL of the advocates JSON file to fetch
 * @param {string} collection - Collection ID used when building nav links (e.g. 'top_advocates')
 * @param {object} options    - Optional: { limit, afterYear, summaryId, summaryLabel, mode, sortContainerId }
 */
/**
 * Renders sort-toggle buttons into the element identified by `containerId`.
 *
 * @param {string}   containerId - ID of the .chart-sort <div>
 * @param {Array}    defs        - [{ key, label, defaultAsc? }] — button definitions
 * @param {string}   activeKey   - initially active sort key
 * @param {boolean}  activeAsc   - initial direction (true = ascending)
 * @param {Function} onChange    - called with (key, asc) whenever sort changes
 */
function buildChartSortControl(containerId, defs, activeKey, activeAsc, onChange) {
  var wrap = document.getElementById(containerId);
  if (!wrap) return;
  var curKey = activeKey, curAsc = activeAsc;

  function refresh() {
    wrap.querySelectorAll('.chart-sort-btn').forEach(function (btn) {
      var def = defs.find(function (d) { return d.key === btn.dataset.key; });
      var on  = btn.dataset.key === curKey;
      var asc = on ? curAsc : (def.defaultAsc !== undefined ? def.defaultAsc : false);
      btn.classList.toggle('active', on);
      btn.textContent = def.label + ' ' + (asc ? '↑' : '↓');
    });
  }

  defs.forEach(function (def) {
    var btn = document.createElement('button');
    btn.className   = 'chart-sort-btn';
    btn.dataset.key = def.key;
    btn.addEventListener('click', function () {
      if (curKey === def.key) {
        curAsc = !curAsc;
      } else {
        curKey = def.key;
        curAsc = def.defaultAsc !== undefined ? def.defaultAsc : false;
      }
      refresh();
      onChange(curKey, curAsc);
    });
    wrap.appendChild(btn);
  });

  refresh();
}

function _getChartColors() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    || (window.matchMedia?.('(prefers-color-scheme: dark)').matches
        && document.documentElement.getAttribute('data-theme') !== 'light');
  return { grid: isDark ? '#2d2f38' : '#eee', label: isDark ? '#9da5b4' : '#666' };
}

async function renderAdvocateChart(canvasId, dataUrl, collection, { limit = null, afterYear = null, summaryId = null, summaryLabel = 'advocates', mode = 'timespan', sortContainerId = null } = {}) {
  const res = await fetch(dataUrl);
  let advocates = await res.json();

  // Normalize advocates whose `cases` is an array of case objects (e.g. justice_advocates.json)
  // into the flat { cases, dateFirst, dateLast } shape the chart expects.
  advocates = advocates.map(a => {
    if (!Array.isArray(a.cases)) return a;
    const dates = a.cases
      .flatMap(c => (c.argument || c.reargument || '').split(','))
      .filter(Boolean)
      .sort();
    return { ...a, dateFirst: dates[0], dateLast: dates[dates.length - 1], cases: a.cases.length };
  });

  if (summaryId) {
    function formatDate(dateStr) {
      const [y, m, d] = dateStr.split('-').map(Number);
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      return `${months[m - 1]} ${d}, ${y}`;
    }
    const earliest = advocates.reduce((min, a) => a.dateFirst < min ? a.dateFirst : min, advocates[0].dateFirst);
    const latest   = advocates.reduce((max, a) => a.dateLast  > max ? a.dateLast  : max, advocates[0].dateLast);
    document.getElementById(summaryId).textContent =
      `From ${formatDate(earliest)} to ${formatDate(latest)}, ${advocates.length.toLocaleString()} ${summaryLabel} have argued at the U.S. Supreme Court.`;
  }

  // Filter to advocates whose last argument falls within the requested window.
  if (afterYear != null) advocates = advocates.filter(a => parseInt(a.dateLast) >= afterYear);

  // Sort by cases descending so the most-argued advocates appear at the top (also determines which
  // advocates survive a limit cut).
  advocates = [...advocates].sort((a, b) => b.cases - a.cases);
  if (limit != null) advocates = advocates.slice(0, limit);

  function toDecimalYear(dateStr) {
    const [y, m] = dateStr.split('-').map(Number);
    return y + (m - 1) / 12;
  }

  function titleCase(s) {
    return s.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase());
  }

  function lastName(name) {
    const cleaned = name.trim().replace(/,\s*(II|III|IV|JR\.|SR\.)$/i, '');
    const parts = cleaned.trim().split(/\s+/);
    return parts[parts.length - 1];
  }

  const canvas = document.getElementById(canvasId);

  // ── Arguments mode: simple bar chart by argument count with sort controls ─

  if (mode === 'arguments') {
    const _urlParams  = new URLSearchParams(location.search);
    let sortKey = _urlParams.get('sort') || 'arguments';
    let sortAsc  = _urlParams.has('o') ? _urlParams.get('o') === 'a' : false;
    const maxCases = Math.max(...advocates.map(a => a.cases));

    function _pushSortUrl(key, asc) {
      const search = '?sort=' + key + '&o=' + (asc ? 'a' : 'd');
      history.replaceState(null, '', location.pathname + search);
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'ussc-update-sort', sort: key, o: asc ? 'a' : 'd' }, location.origin);
      }
    }

    function _sortedData() {
      const arr = advocates.slice();
      if (sortKey === 'name') {
        arr.sort((a, b) => {
          const la = lastName(a.name), lb = lastName(b.name);
          return sortAsc ? la.localeCompare(lb) : lb.localeCompare(la);
        });
      } else if (sortKey === 'date') {
        arr.sort((a, b) => {
          const da = a.dateFirst || '', db = b.dateFirst || '';
          return sortAsc ? da.localeCompare(db) : db.localeCompare(da);
        });
      } else {
        arr.sort((a, b) => sortAsc ? a.cases - b.cases : b.cases - a.cases);
      }
      return arr;
    }

    function _barLabel(a) {
      const ln = lastName(a.name);
      return sortKey === 'date' ? `${ln} (${(a.dateFirst || '').slice(0, 4)})` : ln;
    }

    let currentData = _sortedData();

    const rowPx = 14;
    const axisH = 50;
    canvas.parentElement.style.height = (advocates.length * rowPx + axisH) + 'px';

    const { grid: gridColor, label: labelColor } = _getChartColors();

    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: currentData.map(_barLabel),
        datasets: [{
          data: currentData.map(a => a.cases),
          backgroundColor: currentData.map(a =>
            `hsl(210,65%,${Math.round(65 - (a.cases / maxCases) * 30)}%)`
          ),
          borderWidth: 0,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick(event, elements) {
          if (elements.length > 0)
            window.top.location.href = `/courts/ussc/?collection=${collection}&id=${currentData[elements[0].index].id}`;
        },
        onHover(event, elements) {
          event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
        },
        scales: {
          x: {
            position: 'top',
            ticks: { color: labelColor, font: { size: 10 } },
            grid:  { color: gridColor },
          },
          y: {
            ticks: { color: labelColor, font: { size: 9 } },
            grid:  { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: items => titleCase(currentData[items[0].dataIndex].name),
              label: item => {
                const a = currentData[item.dataIndex];
                const first = (a.dateFirst || '').slice(0, 4);
                const last  = (a.dateLast  || '').slice(0, 4);
                const range = first === last ? first : `${first}–${last}`;
                return `${a.cases} argument${a.cases === 1 ? '' : 's'}  ·  ${range}`;
              },
            },
          },
        },
      },
    });

    if (sortContainerId) {
      buildChartSortControl(sortContainerId, [
        { key: 'arguments', label: 'Arguments', defaultAsc: false },
        { key: 'name',      label: 'Name',      defaultAsc: true  },
        { key: 'date',      label: 'Start Date', defaultAsc: true  },
      ], sortKey, sortAsc, (key, asc) => {
        sortKey = key; sortAsc = asc;
        _pushSortUrl(key, asc);
        currentData = _sortedData();
        chart.data.labels                       = currentData.map(_barLabel);
        chart.data.datasets[0].data            = currentData.map(a => a.cases);
        chart.data.datasets[0].backgroundColor = currentData.map(a =>
          `hsl(210,65%,${Math.round(65 - (a.cases / maxCases) * 30)}%)`
        );
        chart.update('none');
      });
    }

    return;
  }

  // ── Time-span mode: floating bar chart showing career duration ─────────────

  const allFirsts = advocates.map(a => toDecimalYear(a.dateFirst));
  const allLasts  = advocates.map(a => toDecimalYear(a.dateLast));
  const dataMin   = Math.floor(Math.min(...allFirsts) / 10) * 10;
  const minYear   = afterYear != null ? Math.max(dataMin, afterYear) : dataMin;
  const maxYear   = Math.ceil(Math.max(...allLasts)   / 10) * 10;
  const maxCases  = Math.max(...advocates.map(a => a.cases));

  // Size the container to fit all rows at a comfortable height
  const rowPx = 14;
  const axisH = 50;
  canvas.parentElement.style.height = (advocates.length * rowPx + axisH) + 'px';

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: advocates.map(a => lastName(a.name)),
      datasets: [{
        data: advocates.map(a => [toDecimalYear(a.dateFirst), toDecimalYear(a.dateLast)]),
        backgroundColor: advocates.map(a => {
          const ratio = a.cases / maxCases;
          return `hsl(210,65%,${Math.round(65 - ratio * 30)}%)`;
        }),
        borderWidth: 0,
        borderSkipped: false,
        barThickness: 10,
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      onClick(event, elements) {
        if (elements.length > 0)
          window.top.location.href = `/courts/ussc/?collection=${collection}&id=${advocates[elements[0].index].id}`;
      },
      onHover(event, elements) {
        event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
      },
      scales: {
        x: {
          min: minYear,
          max: maxYear,
          position: 'top',
          ticks: { stepSize: 10, callback: v => String(Math.round(v)), color: '#555' },
          grid: { color: 'rgba(0,0,0,0.08)' },
        },
        y: {
          ticks: { font: { size: 9 }, color: '#555' },
          grid: { display: false },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => titleCase(advocates[items[0].dataIndex].name),
            label: item => {
              const a = advocates[item.dataIndex];
              return `${a.dateFirst.slice(0, 4)}–${a.dateLast.slice(0, 4)}  ·  ${a.cases} arguments`;
            },
          },
        },
      },
    },
  });
}
