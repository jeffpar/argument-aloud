/* Topbar: appearance menu toggle and theme switching */
(function () {
  'use strict';

  function setTheme(val) {
    if (val === 'default') {
      localStorage.removeItem('aa-theme');
      document.documentElement.removeAttribute('data-theme');
    } else {
      localStorage.setItem('aa-theme', val);
      document.documentElement.setAttribute('data-theme', val);
    }
  }

  function updateThemeMenu() {
    var current = localStorage.getItem('aa-theme') || 'default';
    document.querySelectorAll('[data-theme-value]').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.themeValue === current);
    });
  }

  function closeMenu() {
    var menu = document.getElementById('topbar-menu');
    var btn  = document.getElementById('menu-btn');
    if (!menu || !btn) return;
    menu.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    menu.setAttribute('aria-hidden', 'true');
  }

  // Search tips live in the welcome blog post — shown alongside the search
  // box (see window._showSearchTipsPage in explorer.js) so a visitor who
  // reaches for search also sees how to use it. Kept here too since the
  // home-page redirect below needs the same target as a plain ?link= param.
  var SEARCH_TIPS_LINK = '/courts/ussc/blog/2026/welcome-to-argument-aloud/#search-tips';

  // The Terms search box only exists on the explorer page (courts/ussc/) —
  // window._openTermsSearch is set there by explorer.js. Anywhere else (e.g.
  // the home page), there's no search box to open in place, so send the
  // visitor to the explorer page instead: "?find=?" is the existing shared-
  // link shorthand explorer.js already recognizes as "open an empty search
  // box" (see restoreFromURL's ?find= handling), rather than a literal query.
  function activateTermsSearch() {
    if (typeof window._openTermsSearch === 'function') {
      window._openTermsSearch();
      if (typeof window._showSearchTipsPage === 'function') window._showSearchTipsPage();
    } else {
      location.href = '/courts/ussc/?find=%3F&link=' + encodeURIComponent(SEARCH_TIPS_LINK);
    }
  }

  // Kept in sync with terms.js's own LS_DATES_KEY constant (the term stats
  // page, where Minutes drag-and-drop edits are made, lives in a same-origin
  // iframe under this topbar rather than sharing this script directly).
  var LS_DATES_KEY = 'aa-dates-overrides';

  // The Customizations section only ever shows up for a visitor who has
  // actually made a local Minutes date edit — unlike Appearance/Favorites/
  // Transcripts above, most visitors never populate it at all. This topbar
  // only loads once per full page load, but the iframe holding the term
  // stats page (where an edit happens) is a *different* browsing context, so
  // its localStorage writes fire a 'storage' event here that this listens
  // for, instead of only checking once at DOMContentLoaded.
  function updateCustomizationsMenu() {
    var has = !!localStorage.getItem(LS_DATES_KEY);
    var divider   = document.getElementById('customizations-divider');
    var label     = document.getElementById('customizations-label');
    var dlBtn     = document.getElementById('download-dates-btn');
    var clearBtn  = document.getElementById('clear-dates-btn');
    if (divider)  divider.hidden  = !has;
    if (label)    label.hidden    = !has;
    if (dlBtn)    dlBtn.hidden    = !has;
    if (clearBtn) clearBtn.hidden = !has;
  }

  // Auto-prunes any local Minutes date edit that scripts/parse_minutes.js
  // has already applied server-side — run once per page load, not just when
  // the visitor happens to revisit the affected term's own stats page (where
  // terms.js's own applyDateOverrides does the same pruning as a side effect
  // of loading that term's dates.json, see its doc comment). Without this, a
  // batch of edits spanning several terms would leave "Download Dates"
  // showing indefinitely for any term the visitor never specifically
  // revisits after the batch was applied upstream — this topbar loads on
  // every page, so it's the one place that can catch all of them regardless
  // of which page the visitor actually lands on next.
  //
  // Mirrors terms.js's own termForDate/canonicalizeGroups/parsePagesRange/
  // expandDatesPages by hand (see the LS_DATES_KEY comment above for why
  // this script doesn't share code with the term-stats iframe directly) —
  // just the "already matches the server" half of applyDateOverrides there;
  // the merge-onto-server-data half doesn't apply here since nothing is ever
  // displayed from this pruning pass, only localStorage itself is trimmed.
  function termForDate(dateStr, starts) {
    var found = null;
    for (var i = 0; i < starts.length; i++) {
      if (starts[i].start <= dateStr) found = starts[i].term; else break;
    }
    return found;
  }

  function parsePagesRange(v) {
    if (Array.isArray(v)) return v.slice();
    if (typeof v !== 'string' || !v) return [];
    var m = /^(\d+)-(\d+)$/.exec(v);
    if (!m) return [];
    var first = parseInt(m[1], 10), last = parseInt(m[2], 10);
    if (last < first) return [];
    var out = [];
    for (var p = first; p <= last; p++) out.push(p);
    return out;
  }

  function expandDatesPages(raw) {
    if (!raw) return raw;
    Object.keys(raw).forEach(function (iso) {
      var groups = raw[iso];
      if (!Array.isArray(groups)) return;
      groups.forEach(function (g) {
        if (!g || typeof g !== 'object') return;
        if (g.type == null && ('minutes_href' in g || 'minutes_src' in g || 'minutes_pages' in g)) {
          g.type = 'minutes';
          if ('minutes_href' in g) { g.href = g.minutes_href; delete g.minutes_href; }
          if ('minutes_src' in g) { g.src = g.minutes_src; delete g.minutes_src; }
          if ('minutes_pages' in g) { g.pages = g.minutes_pages; delete g.minutes_pages; }
        }
        if (g.type === 'minutes') g.pages = parsePagesRange(g.pages);
      });
    });
    return raw;
  }

  function sortGroupsBySrc(groups) {
    return groups.slice().sort(function (a, b) {
      return (a.src || '').localeCompare(b.src || '');
    });
  }

  // Splits each minutes group's own pages into one entry per gap-free
  // consecutive run before comparing — a merged group's pages aren't
  // guaranteed contiguous (see scripts/parse_minutes.js's own
  // normalizeOverrideGroups doc comment), and the server always writes one
  // range string per contiguous run, so comparing unsplit would never match.
  function canonicalizeGroups(groups) {
    if (!Array.isArray(groups)) return null;
    var expanded = [];
    groups.forEach(function (g) {
      if (g.type !== 'minutes') { expanded.push(g); return; }
      var pages = Array.from(new Set(g.pages || [])).sort(function (a, b) { return a - b; });
      var flushRun = function (first, last) {
        var runPages = [];
        for (var p = first; p <= last; p++) runPages.push(p);
        var copy = Object.assign({}, g);
        delete copy.modified;
        copy.pages = runPages;
        expanded.push(copy);
      };
      if (!pages.length) { flushRun(0, -1); return; }
      var runStart = pages[0], prev = pages[0];
      for (var i = 1; i < pages.length; i++) {
        if (pages[i] === prev + 1) { prev = pages[i]; continue; }
        flushRun(runStart, prev);
        runStart = pages[i]; prev = pages[i];
      }
      flushRun(runStart, prev);
    });
    return sortGroupsBySrc(expanded);
  }

  function pruneDateOverrides() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(LS_DATES_KEY) || 'null'); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) return;

    fetch('/courts/ussc/terms/terms.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (decades) {
        if (!decades) return;
        var termStarts = [];
        decades.forEach(function (d) {
          (d.groups || []).forEach(function (g) {
            var m = g.file && /\/terms\/([^/]+)\//.exec(g.file);
            if (m) termStarts.push({ term: m[1], start: m[1].slice(0, 4) + '-' + m[1].slice(5, 7) + '-01' });
          });
        });
        termStarts.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });

        // Group the overrides' own ISO dates by resolved term, so each
        // implicated term's dates.json is fetched exactly once.
        var byTerm = {};
        Object.keys(raw).forEach(function (iso) {
          var term = termForDate(iso, termStarts);
          if (term) (byTerm[term] = byTerm[term] || []).push(iso);
        });
        var termIds = Object.keys(byTerm);
        if (!termIds.length) return;

        Promise.all(termIds.map(function (term) {
          return fetch('/courts/ussc/terms/' + term + '/dates.json')
            .then(function (r) { return r.ok ? r.json() : {}; })
            .catch(function () { return {}; })
            .then(function (dates) { return { term: term, dates: expandDatesPages(dates || {}) }; });
        })).then(function (results) {
          // Re-read rather than reuse the earlier `raw` — the iframe could
          // have written a newer value while these fetches were in flight.
          var current;
          try { current = JSON.parse(localStorage.getItem(LS_DATES_KEY) || 'null'); } catch (e) { current = null; }
          if (!current) return;
          var pruned = false;
          results.forEach(function (result) {
            (byTerm[result.term] || []).forEach(function (iso) {
              if (!(iso in current)) return;
              var serverVal = result.dates[iso] || null;
              if (JSON.stringify(canonicalizeGroups(current[iso])) === JSON.stringify(canonicalizeGroups(serverVal))) {
                delete current[iso];
                pruned = true;
              }
            });
          });
          if (!pruned) return;
          if (Object.keys(current).length) localStorage.setItem(LS_DATES_KEY, JSON.stringify(current));
          else localStorage.removeItem(LS_DATES_KEY);
          updateCustomizationsMenu();
        });
      })
      .catch(function () { /* offline/blocked — next page load retries */ });
  }

  window.addEventListener('storage', function (e) {
    if (e.key === LS_DATES_KEY) updateCustomizationsMenu();
  });

  document.addEventListener('DOMContentLoaded', function () {
    // Standalone/installed web-app mode hides the browser's own back/forward
    // controls, so provide equivalents here.
    var backBtn    = document.getElementById('nav-back-btn');
    var forwardBtn = document.getElementById('nav-forward-btn');
    if (backBtn)    backBtn.addEventListener('click', function () { history.back(); });
    if (forwardBtn) forwardBtn.addEventListener('click', function () { history.forward(); });

    var menuBtn = document.getElementById('menu-btn');
    var menu    = document.getElementById('topbar-menu');
    if (!menuBtn || !menu) return;

    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-hidden', String(!open));
    });

    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target) && e.target !== menuBtn) closeMenu();
    });

    // The document/page viewer on the right renders its content in an
    // <iframe> (PDF, image, or pane HTML) — a click inside it fires no
    // 'click' event on this outer document at all, since it's a separate
    // browsing context, so the listener above never sees it. Clicking into
    // an iframe does shift focus there, though, which blurs this window;
    // catch that instead so the menu still closes.
    window.addEventListener('blur', function () {
      if (menu.classList.contains('open') && document.activeElement && document.activeElement.tagName === 'IFRAME') {
        closeMenu();
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); }
    });

    // Ctrl+F (Windows/Linux) / Cmd+F (Mac) always jumps to the terms/case
    // search box instead of the browser's native find-in-page — on every
    // page this topbar appears on (home page included), not just the
    // explorer page itself.
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        activateTermsSearch();
      }
    });

    document.querySelectorAll('[data-theme-value]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setTheme(btn.dataset.themeValue);
        updateThemeMenu();
        closeMenu();
        if (typeof window._applyThemeToPageFrame === 'function') window._applyThemeToPageFrame();
      });
    });

    updateThemeMenu();

    var editBtn        = document.getElementById('edit-transcripts-btn');
    var endEditBtn     = document.getElementById('end-editing-btn');
    var downloadBtn    = document.getElementById('download-edits-btn');

    if (editBtn) {
      editBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._startEditTranscripts === 'function') window._startEditTranscripts();
      });
    }
    if (endEditBtn) {
      endEditBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._endEditTranscripts === 'function') window._endEditTranscripts();
      });
    }
    if (downloadBtn) {
      downloadBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._downloadTranscriptEdits === 'function') window._downloadTranscriptEdits();
      });
    }
    var clearEditsBtn = document.getElementById('clear-edits-btn');
    if (clearEditsBtn) {
      clearEditsBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._clearTranscriptEdits === 'function') window._clearTranscriptEdits();
      });
    }

    var saveFavBtn    = document.getElementById('save-favorites-btn');
    var restoreFavBtn = document.getElementById('restore-favorites-btn');
    var clearFavBtn   = document.getElementById('clear-favorites-btn');
    if (saveFavBtn) {
      saveFavBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._saveFavorites === 'function') window._saveFavorites();
      });
    }
    if (restoreFavBtn) {
      restoreFavBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._restoreFavorites === 'function') window._restoreFavorites();
      });
    }
    if (clearFavBtn) {
      clearFavBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._clearFavorites === 'function') window._clearFavorites();
      });
    }

    var searchTermsBtn = document.getElementById('search-terms-btn');
    if (searchTermsBtn) {
      searchTermsBtn.addEventListener('click', function () {
        closeMenu();
        activateTermsSearch();
      });
    }

    var downloadDatesBtn = document.getElementById('download-dates-btn');
    if (downloadDatesBtn) {
      downloadDatesBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._downloadDateOverrides === 'function') window._downloadDateOverrides();
      });
    }
    var clearDatesBtn = document.getElementById('clear-dates-btn');
    if (clearDatesBtn) {
      clearDatesBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._clearDateOverrides === 'function') window._clearDateOverrides();
      });
    }
    updateCustomizationsMenu();
    pruneDateOverrides();
  });
}());
