(function () {
  function parseHours(s) {
    var p = s.split(':');
    return parseInt(p[0], 10) + parseInt(p[1], 10) / 60 + parseFloat(p[2]) / 3600;
  }

  function fmtTime(s) {
    var p = s.split(':');
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  renderJusticeBarChart({
    idPrefix:   'vocal',
    dataUrl:    '/courts/ussc/people/justices/vocal_justices.json',
    collection: 'vocal_justices',
    rowPx:      26,
    sortOptions: [
      { key: 'hours', label: 'Hours', defaultAsc: false },
      { key: 'name',  label: 'Name',  defaultAsc: true  },
      { key: 'date',  label: 'Date',  defaultAsc: true  },
    ],
    valueOf: function (j) { return parseHours(j.total); },
    tooltipLabel: function (j) {
      return fmtTime(j.total) + '  ·  ' + j.cases.toLocaleString() + ' cases';
    },
    xTickFormat: function (v) { return v + 'h'; },
    // vocal_justices.json has no dateStart of its own, so copy it in from gallery.json.
    mergeGallery: function (allJustices, gallery) {
      var dateMap    = {};
      var servingIds = new Set();
      gallery.forEach(function (g) {
        dateMap[g.id] = g.dateStart;
        if (!g.dateStop) servingIds.add(g.id);
      });
      allJustices.forEach(function (j) { j.dateStart = dateMap[j.id] || ''; });
      return servingIds;
    },
  });
}());
