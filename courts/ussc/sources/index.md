---
layout: pane
title: "Sources"
---

# Sources

<div class="card-grid" id="sources-card-grid"></div>

<script>
(function () {
  fetch('/courts/ussc/index.json')
    .then(function (r) { return r.json(); })
    .then(function (nav) {
      var sourceEntry = nav.find(function (e) { return e.id === 'source'; });
      if (!sourceEntry) return;
      var grid = document.getElementById('sources-card-grid');
      (sourceEntry.groups || []).forEach(function (g) {
        if (g.hidden || !g.id) return;
        var a = document.createElement('a');
        a.className = 'card';
        a.href = '/courts/ussc/?source=' + encodeURIComponent(g.id);
        var h3 = document.createElement('h3');
        h3.className = 'card-title';
        h3.textContent = g.name;
        a.appendChild(h3);
        grid.appendChild(a);
      });
    });
})();
</script>
