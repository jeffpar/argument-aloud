---
layout: pane
title: "Rarest Spoken Words"
---

# Rarest Spoken Words

This is a list of some of the least-spoken words in U.S. Supreme Court oral arguments -- although until we can clean up some of the transcripts, it may be more a list of typos than anything else.

<ul id="rw-list"></ul>

<script>
(function () {
  function caseLink(c, word) {
    var url = '/courts/ussc/?term=' + c.term + '&case=' + encodeURIComponent(c.number);
    if (c.event) url += '&event=' + c.event;
    if (c.turn)  url += '&turn=' + c.turn;
    url += '&find=' + encodeURIComponent(word);
    var a = document.createElement('a');
    a.href = url;
    a.textContent = c.title + ' (No. ' + c.number + ')';
    return a;
  }

  fetch('/courts/ussc/collections/rare_words.json')
    .then(function (r) { return r.json(); })
    .then(function (groups) {
      var list = document.getElementById('rw-list');
      groups.forEach(function (g) {
        var li = document.createElement('li');
        var b = document.createElement('strong');
        b.textContent = g.name;
        li.appendChild(b);
        if (g.cases.length === 1) {
          li.appendChild(document.createTextNode(' — '));
          li.appendChild(caseLink(g.cases[0], g.name));
        } else {
          li.appendChild(document.createTextNode(':'));
          var sub = document.createElement('ul');
          g.cases.forEach(function (c) {
            var subLi = document.createElement('li');
            subLi.appendChild(caseLink(c, g.name));
            sub.appendChild(subLi);
          });
          li.appendChild(sub);
        }
        list.appendChild(li);
      });
    });
})();
</script>
