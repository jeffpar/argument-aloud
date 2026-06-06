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

  document.addEventListener('DOMContentLoaded', function () {
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

    var editBtn   = document.getElementById('edit-transcripts-btn');
    var finishBtn = document.getElementById('finish-editing-btn');
    if (editBtn) {
      editBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._startEditTranscripts === 'function') window._startEditTranscripts();
      });
    }
    if (finishBtn) {
      finishBtn.addEventListener('click', function () {
        closeMenu();
        if (typeof window._finishEditTranscripts === 'function') window._finishEditTranscripts();
      });
    }
  });
}());
