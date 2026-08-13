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

  fetch('/courts/ussc/collections/historical/rare/rare_words.json')
    .then(function (r) { return r.json(); })
    .then(function (groups) {
      renderList(document.getElementById('rw-list'), groups.filter(function (g) { return g.dictionary !== false; }));
      renderList(document.getElementById('rw-list-nondict'), groups.filter(function (g) { return g.dictionary === false; }));
      applyHashHighlight();
    });
})();
