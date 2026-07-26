/**
 * Renders a sortable horizontal bar chart of justices (e.g. lone dissents, opinions
 * authored, hours spoken), with a "Currently Serving" filter checkbox and sort state
 * persisted in the URL. Shared by the lone-dissents, opinions, and vocal-justices
 * collection pages, which differ only in data source, chart value, and tooltip text.
 *
 * @param {object}   config
 * @param {string}   config.idPrefix       - element id prefix, e.g. 'lone', 'op', 'vocal'
 * @param {string}   config.dataUrl        - URL of the per-justice JSON file to fetch
 * @param {string}   config.collection     - collection id used when navigating to a justice
 * @param {number}   config.rowPx          - pixel height per chart row
 * @param {Array}    config.sortOptions    - [{key, label, defaultAsc}] for buildChartSortControl
 * @param {Function} config.valueOf        - (justice) => number, the chart/sort value
 * @param {Function} config.tooltipLabel   - (justice) => string, the tooltip body text
 * @param {Function} config.mergeGallery   - (allJustices, gallery) => Set of serving ids;
 *                                           may mutate allJustices (e.g. add placeholder
 *                                           entries, copy in a dateStart field)
 * @param {Function} [config.xTickFormat]  - (value) => string, Chart.js x-axis tick formatter
 */
function renderJusticeBarChart(config) {
  var idPrefix = config.idPrefix;
  var rowPx    = config.rowPx;
  var valueOf  = config.valueOf;

  var { grid: gridColor, label: labelColor } = _getChartColors();

  var _params = new URLSearchParams(location.search);

  var allJustices = [];
  var currentData = [];
  var sortKey     = _params.get('sort') || config.sortOptions[0].key;
  var sortAsc     = _params.has('o') ? _params.get('o') === 'a' : false;
  var activeOnly  = _params.get('s') === '1';
  var servingIds  = new Set();
  var chart       = null;

  function _pushUrl() {
    var p = new URLSearchParams();
    p.set('sort', sortKey);
    p.set('o', sortAsc ? 'a' : 'd');
    if (activeOnly) p.set('s', '1');
    var search = '?' + p.toString();
    history.replaceState(null, '', location.pathname + search);
    if (window.parent !== window) {
      var msg = { type: 'ussc-update-sort', sort: sortKey, o: sortAsc ? 'a' : 'd' };
      if (activeOnly) msg.s = '1';
      window.parent.postMessage(msg, location.origin);
    }
  }

  function pool() {
    return activeOnly ? allJustices.filter(function (j) { return servingIds.has(j.id); }) : allJustices;
  }

  function sorted() {
    var arr = pool().slice();
    if (sortKey === 'name') {
      arr.sort(function (a, b) {
        return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
      });
    } else if (sortKey === 'date') {
      arr.sort(function (a, b) {
        var da = a.dateStart || '', db = b.dateStart || '';
        return sortAsc ? da.localeCompare(db) : db.localeCompare(da);
      });
    } else {
      arr.sort(function (a, b) { return sortAsc ? valueOf(a) - valueOf(b) : valueOf(b) - valueOf(a); });
    }
    return arr;
  }

  function barColor(value, max) {
    return 'hsl(210,65%,' + Math.round(65 - (value / max) * 30) + '%)';
  }

  function applySort() {
    currentData = sorted();
    var max = currentData.length ? Math.max.apply(null, currentData.map(valueOf)) : 1;
    document.getElementById(idPrefix + '-chart-wrap').style.height = Math.max(200, currentData.length * rowPx) + 'px';
    chart.data.labels                       = currentData.map(function (j) { return j.name; });
    chart.data.datasets[0].data            = currentData.map(valueOf);
    chart.data.datasets[0].backgroundColor = currentData.map(function (j) { return barColor(valueOf(j), max); });
    chart.update('none');
  }

  Promise.all([
    fetch(config.dataUrl).then(function (r) { return r.json(); }),
    fetch('/courts/ussc/people/justices/gallery.json').then(function (r) { return r.json(); }),
  ]).then(function (results) {
    allJustices = results[0];
    var gallery = results[1];
    servingIds  = config.mergeGallery(allJustices, gallery);

    var maxValue = Math.max.apply(null, allJustices.map(valueOf));
    currentData  = sorted();

    var checkbox = document.getElementById(idPrefix + '-active-only');
    checkbox.checked = activeOnly;

    var xTicks = { color: labelColor, font: { size: 10 } };
    if (config.xTickFormat) xTicks.callback = config.xTickFormat;

    chart = new Chart(document.getElementById(idPrefix + '-chart'), {
      type: 'bar',
      data: {
        labels: currentData.map(function (j) { return j.name; }),
        datasets: [{
          data: currentData.map(valueOf),
          backgroundColor: currentData.map(function (j) { return barColor(valueOf(j), maxValue); }),
          borderWidth: 0,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        onClick: function (event, elements) {
          if (!elements.length) return;
          var id     = currentData[elements[0].index].id;
          var search = '?collection=' + config.collection + '&id=' + id;
          if (window.parent !== window) {
            window.parent.postMessage({ type: 'ussc-navigate', search: search }, location.origin);
          } else {
            window.top.location.href = '/courts/ussc/' + search;
          }
        },
        onHover: function (event, elements) {
          event.native.target.style.cursor = elements.length ? 'pointer' : 'default';
        },
        scales: {
          x: {
            ticks: xTicks,
            grid:  { color: gridColor },
          },
          y: {
            ticks: { color: labelColor, font: { size: 11 } },
            grid:  { display: false },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: function (items) { return currentData[items[0].dataIndex].name; },
              label: function (item)  { return config.tooltipLabel(currentData[item.dataIndex]); },
            },
          },
        },
      },
    });

    if (activeOnly) applySort();

    checkbox.addEventListener('change', function (e) {
      activeOnly = e.target.checked;
      _pushUrl();
      applySort();
    });

    buildChartSortControl(idPrefix + '-sort', config.sortOptions, sortKey, sortAsc, function (key, asc) {
      sortKey = key; sortAsc = asc;
      _pushUrl();
      applySort();
    });
  });
}
