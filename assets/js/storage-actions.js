/* Favorites/tags/transcript-edits menu actions (Save/Restore/Clear Favorites,
 * Download/Clear Edits) — self-contained versions that work on any page,
 * reading and writing the same localStorage keys explorer.js uses.
 *
 * On the ussc SPA page, explorer.js defines richer, state-integrated
 * versions of these same window._x functions *after* this script runs, so
 * its assignments simply win there. Elsewhere (e.g. the home page, where
 * explorer.js isn't loaded), these are the only implementations available.
 */
(function () {
  'use strict';

  var LS_EDITS_KEY     = 'aa-transcript-edits';
  var LS_FAVORITES_KEY = 'aa-favorites';
  var LS_TAGS_KEY       = 'aa-tags';

  function getFavData() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_FAVORITES_KEY) || 'null');
      if (!raw) return { groups: [{ id: 'unfiled', name: 'Unfiled' }], items: [] };
      if (Array.isArray(raw)) {
        return {
          groups: [{ id: 'unfiled', name: 'Unfiled' }],
          items: raw.map(function (f) { return Object.assign({}, f, { groupId: 'unfiled' }); })
        };
      }
      if (!raw.groups || !raw.groups.some(function (g) { return g.id === 'unfiled'; })) {
        raw.groups = [{ id: 'unfiled', name: 'Unfiled' }].concat(raw.groups || []);
      }
      return raw;
    } catch (e) { return { groups: [{ id: 'unfiled', name: 'Unfiled' }], items: [] }; }
  }

  function setFavData(data) {
    try { localStorage.setItem(LS_FAVORITES_KEY, JSON.stringify(data)); } catch (e) { /* quota exceeded */ }
  }

  function getTagData() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_TAGS_KEY) || 'null');
      return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } catch (e) { return {}; }
  }

  function sortedTagData(data) {
    var out = {};
    Object.keys(data).sort(function (a, b) {
      var pa = a.split(':'), pb = b.split(':');
      var termA = pa[1], numA = pa[2] || '';
      var termB = pb[1], numB = pb[2] || '';
      if (termA !== termB) return termA < termB ? -1 : 1;
      var nA = parseInt(numA, 10), nB = parseInt(numB, 10);
      if (!isNaN(nA) && !isNaN(nB)) return nA - nB;
      return numA < numB ? -1 : numA > numB ? 1 : 0;
    }).forEach(function (k) { out[k] = data[k]; });
    return out;
  }

  function setTagData(data) {
    try {
      if (!Object.keys(data).length) localStorage.removeItem(LS_TAGS_KEY);
      else localStorage.setItem(LS_TAGS_KEY, JSON.stringify(sortedTagData(data)));
    } catch (e) { /* quota exceeded */ }
  }

  // Strips any user tag that's already a built-in tag on the server, so
  // saved bundles only carry genuine user additions.
  function filterBuiltinTagsForExport(tagData) {
    var byTerm = {};
    Object.keys(tagData).forEach(function (key) {
      var parts = key.split(':');
      var term = parts[1], number = parts[2];
      if (!byTerm[term]) byTerm[term] = [];
      byTerm[term].push({ key: key, number: number });
    });

    var builtinMap = {};
    return Promise.all(Object.keys(byTerm).map(function (term) {
      return fetch('/courts/ussc/terms/' + term + '/cases.json')
        .then(function (resp) { return resp.ok ? resp.json() : null; })
        .then(function (cases) {
          if (!cases) return;
          byTerm[term].forEach(function (entry) {
            var c = cases.find(function (c) { return (c.number || c.id || '') === entry.number; });
            if (c && c.tags) builtinMap[entry.key] = Array.isArray(c.tags) ? c.tags : [String(c.tags)];
          });
        })
        .catch(function () { /* ignore network errors — keep all user tags for that term */ });
    })).then(function () {
      var filtered = {};
      Object.keys(tagData).forEach(function (key) {
        var builtin = builtinMap[key] || [];
        var toExport = tagData[key].filter(function (t) { return builtin.indexOf(t) === -1; });
        if (toExport.length) filtered[key] = toExport;
      });
      return sortedTagData(filtered);
    });
  }

  function downloadJson(filename, data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function saveFavorites() {
    var favData = getFavData();
    return filterBuiltinTagsForExport(getTagData()).then(function (tagData) {
      var hasItems  = favData.items.length > 0;
      var hasGroups = favData.groups.some(function (g) { return g.id !== 'unfiled'; });
      var hasTags   = Object.keys(tagData).length > 0;
      if (!hasItems && !hasGroups && !hasTags) { alert('No favorites or tags to save.'); return; }
      downloadJson('ussc-favorites.json', { favorites: favData, tags: tagData });
    });
  }

  // onDone, if given, runs after data is restored — explorer.js passes one
  // to refresh its nav tree/buttons; elsewhere there's nothing to refresh.
  function restoreFavorites(onDone) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var parsed = JSON.parse(ev.target.result);
          var favData, tagData;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.favorites) {
            favData = parsed.favorites;
            tagData = (parsed.tags && typeof parsed.tags === 'object' && !Array.isArray(parsed.tags)) ? parsed.tags : {};
          } else if (Array.isArray(parsed)) {
            favData = {
              groups: [{ id: 'unfiled', name: 'Unfiled' }],
              items: parsed.map(function (f) { return Object.assign({}, f, { groupId: 'unfiled' }); })
            };
            tagData = {};
          } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
            favData = parsed;
            tagData = {};
          } else {
            alert('Invalid favorites file.');
            return;
          }
          if (!favData.groups || !favData.groups.some(function (g) { return g.id === 'unfiled'; })) {
            favData.groups = [{ id: 'unfiled', name: 'Unfiled' }].concat(favData.groups || []);
          }
          setFavData(favData);
          setTagData(tagData);
          if (typeof onDone === 'function') onDone();
        } catch (e) {
          alert('Could not read favorites file.');
        }
      };
      reader.readAsText(file);
    });
    document.body.appendChild(input); input.click(); document.body.removeChild(input);
  }

  function clearFavorites() {
    if (!confirm('This will erase all your local favorites (including any custom tags). Are you sure?')) return;
    localStorage.removeItem(LS_FAVORITES_KEY);
    localStorage.removeItem(LS_TAGS_KEY);
    window.location.href = '/';
  }

  // Mirrors explorer.js's _generateEditsJson(), operating on the plain
  // object shape _persistEditsToStorage() writes to localStorage instead of
  // the in-memory Map<caseKey, ...> the SPA keeps while editing.
  function generateEditsJson(store) {
    var result = [];
    Object.keys(store).forEach(function (caseKey) {
      var caseData = store[caseKey];
      var events = [];
      Object.keys(caseData.eventEdits || {}).forEach(function (textHref) {
        var turnsObj = caseData.eventEdits[textHref];
        var turnEntries = Object.keys(turnsObj).map(function (idx) { return turnsObj[idx]; });
        if (!turnEntries.length) return;
        var turnsOut = turnEntries.map(function (e) {
          var out = {};
          if (e.prevTurnNum !== undefined) out.prev = e.prevTurnNum;
          out.turn = e.turnNum;
          if (!e.bareRenumber) {
            if (e.name !== undefined) out.name = e.name;
            if (e.text !== undefined) out.text = e.text;
          }
          if (e.time !== undefined) out.time = e.time;
          return out;
        }).sort(function (a, b) { return a.turn - b.turn; });
        events.push({ text_href: textHref, turns: turnsOut });
      });
      if (!events.length) return;
      var obj = { title: caseData.title };
      if (caseData.term) obj.term = caseData.term;
      if (caseData.number !== undefined) obj.number = caseData.number;
      else if (caseData.id !== undefined) obj.id = caseData.id;
      obj.events = events;
      result.push(obj);
    });
    return result;
  }

  async function downloadTranscriptEdits() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(LS_EDITS_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) {
      alert('No transcript edits to download.');
      return;
    }

    // Validate each stored edit against the current server transcript, and
    // drop any that have already landed there.
    for (var caseKey in raw) {
      var caseData = raw[caseKey];
      var term = caseData.term;
      var eventEdits = caseData.eventEdits || {};
      for (var textHref in eventEdits) {
        var turnsObj = eventEdits[textHref];
        var serverTurns;
        try {
          var resp = await fetch('/courts/ussc/terms/' + term + '/cases/' + textHref);
          if (!resp.ok) continue;
          var data = await resp.json();
          serverTurns = Array.isArray(data) ? data : (data.turns || []);
        } catch (e) { continue; }

        for (var idxStr in turnsObj) {
          var edit = turnsObj[idxStr];
          var serverTurn = serverTurns.find(function (t, i) {
            return (t.turn != null ? t.turn : (i + 1)) === edit.turnNum;
          });
          if (!serverTurn) continue;
          var nameApplied = edit.name === undefined || edit.name === serverTurn.name;
          var textApplied = edit.text === undefined || edit.text === serverTurn.text;
          if (nameApplied && textApplied) delete turnsObj[idxStr];
        }
        if (!Object.keys(turnsObj).length) delete eventEdits[textHref];
      }
      if (!Object.keys(eventEdits).length) delete raw[caseKey];
    }

    if (Object.keys(raw).length) localStorage.setItem(LS_EDITS_KEY, JSON.stringify(raw));
    else localStorage.removeItem(LS_EDITS_KEY);

    var edits = generateEditsJson(raw);
    if (!edits.length) {
      alert('All transcript edits have already been applied to the server.');
      return;
    }

    downloadJson('ussc-edits.json', edits);
    // Edits remain in local storage — they persist until applied on the server.
    alert('Note: Send the downloaded edits to admin@argumentaloud.org for processing. Thank you for taking the time to make these corrections.');
  }

  function clearTranscriptEdits() {
    if (!confirm('This will erase all your local transcript edits. Are you sure?')) return;
    localStorage.removeItem(LS_EDITS_KEY);
    window.location.href = '/';
  }

  window._saveFavorites           = saveFavorites;
  window._restoreFavorites        = restoreFavorites;
  window._clearFavorites          = clearFavorites;
  window._downloadTranscriptEdits = downloadTranscriptEdits;
  window._clearTranscriptEdits    = clearTranscriptEdits;
}());
