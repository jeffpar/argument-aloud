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
    var divider = document.getElementById('customizations-divider');
    var label   = document.getElementById('customizations-label');
    var dlBtn   = document.getElementById('download-dates-btn');
    if (divider) divider.hidden = !has;
    if (label)   label.hidden   = !has;
    if (dlBtn)   dlBtn.hidden   = !has;
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

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); }
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

    var downloadDatesBtn = document.getElementById('download-dates-btn');
    if (downloadDatesBtn) {
      downloadDatesBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._downloadDateOverrides === 'function') window._downloadDateOverrides();
      });
    }
    updateCustomizationsMenu();
  });
}());
