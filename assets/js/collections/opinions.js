renderJusticeBarChart({
  idPrefix:   'op',
  dataUrl:    '/courts/ussc/people/justices/opinions.json',
  collection: 'opinions',
  rowPx:      20,
  sortOptions: [
    { key: 'opinions', label: 'Opinions', defaultAsc: false },
    { key: 'name',     label: 'Name',     defaultAsc: true  },
    { key: 'date',     label: 'Date',     defaultAsc: true  },
  ],
  valueOf: function (j) { return j.cases; },
  tooltipLabel: function (j) {
    var first = j.dateStart.slice(0, 4);
    var last  = j.dateStop.slice(0, 4);
    var range = first === last ? first : first + '–' + last;
    return j.cases + ' opinion' + (j.cases === 1 ? '' : 's') + '  ·  ' + range;
  },
  mergeGallery: function (allJustices, gallery) {
    return new Set(gallery.filter(function (g) { return !g.dateStop; }).map(function (g) { return g.id; }));
  },
});
