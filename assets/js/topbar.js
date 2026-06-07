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

  function isUsscPage() {
    return window.location.pathname.startsWith('/courts/ussc');
  }

  function syncEditTranscriptsBtn() {
    var onUssc = isUsscPage();
    var editBtn     = document.getElementById('edit-transcripts-btn');
    var downloadBtn = document.getElementById('download-edits-btn');
    if (editBtn)     editBtn.disabled     = !onUssc;
    if (downloadBtn) downloadBtn.disabled = !onUssc;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var menuBtn = document.getElementById('menu-btn');
    var menu    = document.getElementById('topbar-menu');
    if (!menuBtn || !menu) return;

    menuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      syncEditTranscriptsBtn();
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

    window.addEventListener('popstate', syncEditTranscriptsBtn);

    document.querySelectorAll('[data-theme-value]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setTheme(btn.dataset.themeValue);
        updateThemeMenu();
        closeMenu();
        if (typeof window._applyThemeToPageFrame === 'function') window._applyThemeToPageFrame();
      });
    });

    updateThemeMenu();
    syncEditTranscriptsBtn();

    var editBtn        = document.getElementById('edit-transcripts-btn');
    var endEditBtn     = document.getElementById('end-editing-btn');
    var downloadBtn    = document.getElementById('download-edits-btn');

    if (editBtn) {
      editBtn.addEventListener('click', function () {
        if (editBtn.disabled) return;
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
  });
}());
