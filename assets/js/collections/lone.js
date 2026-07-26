renderJusticeBarChart({
  idPrefix:   'lone',
  dataUrl:    '/courts/ussc/people/justices/lone_dissents.json',
  collection: 'lone_dissents',
  rowPx:      21,
  sortOptions: [
    { key: 'dissents', label: 'Dissents', defaultAsc: false },
    { key: 'name',     label: 'Name',     defaultAsc: true  },
    { key: 'date',     label: 'Date',     defaultAsc: true  },
  ],
  valueOf: function (j) { return j.cases; },
  tooltipLabel: function (j) {
    var text = j.cases + ' lone dissent' + (j.cases === 1 ? '' : 's');
    if (j.dateStart) {
      var first = j.dateStart.slice(0, 4);
      var last  = j.dateStop.slice(0, 4);
      text += '  ·  ' + (first === last ? first : first + '–' + last);
    }
    return text;
  },
  // Justices currently serving but with zero lone dissents don't appear in
  // lone_dissents.json at all, so add a zero-entry placeholder for them —
  // otherwise they'd vanish entirely under the "Currently Serving" filter.
  mergeGallery: function (allJustices, gallery) {
    var serving    = gallery.filter(function (g) { return !g.dateStop; });
    var servingIds = new Set(serving.map(function (g) { return g.id; }));
    var knownIds   = new Set(allJustices.map(function (j) { return j.id; }));
    serving.forEach(function (g) {
      if (!knownIds.has(g.id)) {
        allJustices.push({ id: g.id, name: g.name, cases: 0, dateStart: '', dateStop: '' });
      }
    });
    return servingIds;
  },
});
