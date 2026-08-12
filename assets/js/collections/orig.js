(function () {
  function caseId(c) { return c.number.split(',')[0].trim(); }

  // Grid cells are a fixed 230:400 box. Images at least that wide (relative
  // to height) are cropped to fill it (object-fit: cover — no distortion).
  // Thinner images would lose top/bottom content if cropped to cover, so
  // they're stretched to fill the box instead (object-fit: fill).
  var TARGET_RATIO = 230 / 400;
  function fitThumbnail(img) {
    var ratio = img.naturalWidth / img.naturalHeight;
    img.style.objectFit = ratio < TARGET_RATIO ? 'fill' : 'cover';
  }
  function watchThumbnailFit(img) {
    if (img.complete && img.naturalWidth) fitThumbnail(img);
    else img.addEventListener('load', function () { fitThumbnail(img); });
  }

  // Each "gallery" entry is "<file number>|<href>|<title>" — the title is
  // everything after the second '|', so it may safely contain '|' itself.
  function parsePdf(s) {
    var i1 = s.indexOf('|');
    var i2 = s.indexOf('|', i1 + 1);
    return { file: s.slice(0, i1), href: s.slice(i1 + 1, i2), title: s.slice(i2 + 1) };
  }

  var preview        = document.getElementById('og-preview');
  var previewImg     = document.getElementById('og-preview-img');
  var previewCaption = document.getElementById('og-preview-caption');
  var previewFor     = null;

  function positionPreview(a) {
    preview.style.visibility = 'hidden';
    preview.style.display = 'block';
    // Lock the box to the image's own rendered width so the caption wraps
    // to match it instead of stretching the box wide to fit on one line.
    preview.style.width = previewImg.offsetWidth + 'px';
    var rect = a.getBoundingClientRect();
    var pw = preview.offsetWidth, ph = preview.offsetHeight;
    var left = rect.left + rect.width / 2 - pw / 2;
    var top = rect.top - ph - 12;
    if (top < 8) top = rect.bottom + 12;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - ph - 8));
    preview.style.left = left + 'px';
    preview.style.top = top + 'px';
    preview.style.visibility = 'visible';
  }

  function showPreview(a, src, title) {
    previewFor = a;
    previewCaption.textContent = title || '';
    previewImg.onload = function () {
      if (previewFor === a) positionPreview(a);
    };
    previewImg.src = src;
    if (previewImg.complete) positionPreview(a);
  }

  function hidePreview() {
    previewFor = null;
    preview.style.display = 'none';
  }

  // Touch devices have no hover, so mouseenter never fires there. On such
  // devices the first tap on a thumbnail shows the preview (like a hover
  // would), and a second tap on the same thumbnail opens it — mirrors the
  // desktop "hover to preview, click to open" flow in two taps instead of one.
  var HAS_HOVER = !window.matchMedia || matchMedia('(hover: hover)').matches;

  // Tapping anywhere outside the current item (or outside the preview itself)
  // dismisses the preview, since there's no mouseleave to do it for us.
  document.addEventListener('touchstart', function (e) {
    if (!previewFor) return;
    if (e.target.closest('.og-item') === previewFor) return;
    if (e.target.closest('#og-preview')) return;
    hidePreview();
  }, { passive: true });

  function openInDocViewer(href, title) {
    var top = window.parent;
    if (top && typeof top.showDocViewer === 'function') {
      top.showDocViewer({ href: href, title: title });
    } else {
      window.open(href, '_blank', 'noopener');
    }
  }

  // The gallery is built asynchronously below (after the orig.json fetch
  // resolves), so the browser's native "scroll to #hash on load" happens too
  // early — the target .og-case section doesn't exist in the DOM yet. Redo it
  // manually once the gallery is populated, and again on hashchange (parent
  // frame re-navigating this same iframe to a different case's anchor).
  function scrollToHashTarget() {
    if (!location.hash) return;
    var el = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
  window.addEventListener('hashchange', scrollToHashTarget);

  fetch('/courts/ussc/collections/orig/orig.json')
    .then(function (r) { return r.json(); })
    .then(function (groups) {
      var container = document.getElementById('og-gallery');

      groups.forEach(function (group) {
        (group.cases || []).forEach(function (c) {
          if (!c.gallery || !c.gallery.length) return;

          var id = caseId(c);
          var section = document.createElement('div');
          section.className = 'og-case';
          section.id = c.term + '--' + id;

          var heading = document.createElement('a');
          heading.className = 'og-case-title';
          heading.href = '/courts/ussc/?term=' + c.term + '&case=' + encodeURIComponent(id);
          heading.target = '_top';
          heading.textContent = c.title;
          section.appendChild(heading);

          var grid = document.createElement('div');
          grid.className = 'og-grid';
          c.gallery.forEach(function (s) {
            var pdf = parsePdf(s);
            var docTitle = pdf.title || c.title;
            var a = document.createElement('a');
            a.className = 'og-item';
            a.href = pdf.href;

            var img = document.createElement('img');
            img.loading = 'lazy';
            img.src = '/courts/ussc/collections/orig/' + c.term + '/' + encodeURIComponent(id) + '/' + pdf.file + '.jpg';
            img.alt = docTitle;
            watchThumbnailFit(img);

            a.appendChild(img);
            // Only listen for real hover on devices that have one — touch
            // devices fire compatibility mouse events (including mouseleave)
            // right after a tap's click, which would immediately re-hide
            // the preview the click handler just showed.
            if (HAS_HOVER) {
              a.addEventListener('mouseenter', function () { showPreview(a, img.src, docTitle); });
              a.addEventListener('mouseleave', hidePreview);
            }
            a.addEventListener('click', function (e) {
              e.preventDefault();
              // No-hover (touch) devices: first tap previews instead of opening
              // immediately, since the user never got a hover preview first.
              if (!HAS_HOVER && previewFor !== a) {
                showPreview(a, img.src, docTitle);
                return;
              }
              hidePreview();
              openInDocViewer(pdf.href, docTitle);
            });
            grid.appendChild(a);
          });

          section.appendChild(grid);
          container.appendChild(section);
        });
      });

      scrollToHashTarget();
    });
})();
