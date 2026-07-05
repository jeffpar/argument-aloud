---
layout: pane
title: "Rarest Spoken Words"
---

# Rarest Spoken Words

This is a list of some of the least-spoken words in U.S. Supreme Court oral arguments, followed by a list of "mystery" words that didn't appear in our dictionary and which may be more a list of typos and transcription artifacts than anything else.

## Rare Words

<ul id="rw-list"></ul>

## Potential Typos or Oddities

<ul id="rw-list-nondict"></ul>

<style>
#rw-list, #rw-list-nondict, #rw-list ul, #rw-list-nondict ul {
  list-style: none;
  padding-left: 1.5em;
}
#rw-list ul, #rw-list-nondict ul {
  padding-left: 3em;
}
/* Word text: plain, not a link color. */
.rw-word {
  color: #212529;
}
@media (prefers-color-scheme: dark) {
  .rw-word { color: #fff; }
}
html[data-theme="dark"] .rw-word { color: #fff; }
html[data-theme="light"] .rw-word { color: #212529; }

/* Scrolled-to word — same colors as the transcript search highlight. */
.rw-highlight {
  background: #fff3cd;
  border-radius: 3px;
}
@media (prefers-color-scheme: dark) {
  .rw-highlight { background: #3a2e00; }
}
html[data-theme="dark"] .rw-highlight { background: #3a2e00; }
html[data-theme="light"] .rw-highlight { background: #fff3cd; }
</style>

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

  function renderList(listEl, groups) {
    groups.forEach(function (g) {
      var li = document.createElement('li');
      li.id = 'rare-word-' + g.name;
      var b = document.createElement('span');
      b.className = 'rw-word';
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
      listEl.appendChild(li);
    });
  }

  // Highlight and scroll to the word named by the current URL hash (e.g.
  // arriving with #rare-word-abaction from the sidebar). Driven explicitly by
  // JS rather than the CSS :target pseudo-class, which only re-evaluates at
  // hashchange time — since the list is built asynchronously after the page
  // loads, the target element wouldn't exist yet at that moment and would
  // never get styled. Also handles switching between words while this page
  // stays loaded (same-document hash changes fire 'hashchange').
  function applyHashHighlight() {
    var prev = document.querySelector('.rw-highlight');
    if (prev) prev.classList.remove('rw-highlight');
    if (!location.hash) return;
    var target = document.getElementById(location.hash.slice(1));
    if (!target) return;
    target.classList.add('rw-highlight');
    target.scrollIntoView({ block: 'center' });
  }
  window.addEventListener('hashchange', applyHashHighlight);

  fetch('/courts/ussc/collections/rare_words.json')
    .then(function (r) { return r.json(); })
    .then(function (groups) {
      renderList(document.getElementById('rw-list'), groups.filter(function (g) { return g.dictionary !== false; }));
      renderList(document.getElementById('rw-list-nondict'), groups.filter(function (g) { return g.dictionary === false; }));
      applyHashHighlight();
    });
})();
</script>
