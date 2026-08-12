(function () {
  function termTitle(term) {
    var parts = term.split('-'), year = parts[0], mon = parseInt(parts[1], 10);
    var names = ['January', 'February', 'March', 'April', 'May', 'June',
                 'July', 'August', 'September', 'October', 'November', 'December'];
    return (names[mon - 1] || parts[1]) + ' Term ' + year;
  }

  function caseLink(c) {
    var url = '/courts/ussc/?term=' + encodeURIComponent(c.term) + '&case=' + encodeURIComponent(c.number || '');
    var a = document.createElement('a');
    a.href = url;
    a.textContent = c.title;
    return a;
  }

  // Messages are semicolon-joined when built from multiple flagged sub-issues
  // (see _scdbBuildMessage in update_cases.js) — split them back apart so
  // each one gets its own line (and so each counts as its own warning).
  function messageParts(text) {
    if (!text) return [];
    return text.split('; ').map(function (p) { return p.trim(); }).filter(Boolean);
  }

  function caseWarningCount(c) {
    return messageParts(c.scdb_message).length + messageParts(c.audit_message).length;
  }

  function appendMessageParts(msgs, text, className) {
    messageParts(text).forEach(function (part) {
      var li = document.createElement('li');
      li.className = className;
      li.textContent = part;
      msgs.appendChild(li);
    });
  }

  function renderCase(c) {
    var li = document.createElement('li');
    li.appendChild(caseLink(c));
    var msgs = document.createElement('ul');
    msgs.className = 'corr-message-list';
    appendMessageParts(msgs, c.scdb_message, 'corr-scdb-message');
    appendMessageParts(msgs, c.audit_message, 'corr-audit-message');
    if (msgs.childNodes.length) li.appendChild(msgs);
    return li;
  }

  fetch('/courts/ussc/collections/audits/audits.json')
    .then(function (r) { return r.json(); })
    .then(function (groups) {
      var group = null;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].id === 'warnings') { group = groups[i]; break; }
      }
      var cases = (group && group.cases) || [];

      // audits.json is sorted decision:ascending — group into per-term
      // sections in that same order (first-seen order == chronological).
      var termsOrder = [];
      var byTerm = {};
      cases.forEach(function (c) {
        if (!byTerm[c.term]) { byTerm[c.term] = []; termsOrder.push(c.term); }
        byTerm[c.term].push(c);
      });

      var container = document.getElementById('corr-list');
      termsOrder.forEach(function (term) {
        // <details> starts collapsed by default (no "open" attribute) — a
        // term's cases only render once the visitor expands it.
        var section = document.createElement('details');
        section.className = 'date-section corr-term-section';
        var summary = document.createElement('summary');
        summary.className = 'corr-term-summary';
        var toggle = document.createElement('span');
        toggle.className = 'corr-term-toggle';
        toggle.setAttribute('aria-hidden', 'true');
        toggle.textContent = '▶';
        var name = document.createElement('span');
        name.className = 'corr-term-name';
        name.textContent = termTitle(term);
        var count = byTerm[term].reduce(function (n, c) { return n + caseWarningCount(c); }, 0);
        var countEl = document.createElement('span');
        countEl.className = 'corr-term-count';
        countEl.textContent = count + (count === 1 ? ' warning' : ' warnings');
        summary.appendChild(toggle);
        summary.appendChild(name);
        summary.appendChild(countEl);
        section.appendChild(summary);
        var ul = document.createElement('ul');
        ul.className = 'date-case-list corr-case-list';
        byTerm[term].forEach(function (c) { ul.appendChild(renderCase(c)); });
        section.appendChild(ul);
        container.appendChild(section);
      });
    });
})();
