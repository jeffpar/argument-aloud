---
layout: pane
title: "Topics"
---

# Topics

<div class="card-grid" id="topics-card-grid"></div>

<script>
(function () {
  fetch('/courts/ussc/topics.json')
    .then(function (r) { return r.json(); })
    .then(function (topics) {
      var grid = document.getElementById('topics-card-grid');
      topics.forEach(function (t) {
        if (t.hidden || !t.file) return;
        var id = t.file.split('/').pop().replace('.json', '');
        var a = document.createElement('a');
        a.className = 'card';
        a.href = '/courts/ussc/?topic=' + encodeURIComponent(id);
        var h3 = document.createElement('h3');
        h3.className = 'card-title';
        h3.textContent = t.name;
        a.appendChild(h3);
        grid.appendChild(a);
      });
    });
})();
</script>
