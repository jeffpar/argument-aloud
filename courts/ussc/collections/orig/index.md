---
layout: pane
title: "Original Jurisdiction Records & Briefs"
---

# Original Jurisdiction Records & Briefs

As the U.S. Supreme Court's [website](https://www.supremecourt.gov/casedocuments/original_jurisdiction_cases.aspx) explains:

> The Supreme Court Library is in the process of digitizing its collection of Records & Briefs within the Court's original jurisdiction. Original jurisdiction cases are those that are filed in the Supreme Court in the first instance, without being resolved by another state or federal court. The Court's original jurisdiction is established in Article III, Section 2, Clause 2 of the Constitution, and in Section 1251 of Title 28 of the United States Code.

> The first group of original case briefs that have been digitized and made available here - numbered 1 through 147 - are those that were active on the Court's docket at some point between 1962 and implementation of the Court's electronic filing system in November 2017. Prior to the 1962 Term, the Clerk's Office regularly renumbered original cases, which meant that many original cases from this time period had different case numbers over the course of their existence. There were eleven cases on the Court's original docket in 1962 when the Clerk's Office began the practice of giving each original case a unique and permanent case number. Those eleven cases were then given permanent numbers (No. 1 through No. 11), and each subsequently filed case was given a higher number. Original cases 148 and higher were all filed since implementation of the Court's electronic filing system, so filings in those cases are available on the Court's regular docket and are not included in this collection.

> The collection here is a digitized version of the physical collection in the Supreme Court's Library and may not contain all records and briefs that were filed in a given case. This collection will be updated in the future with cases that were filed and resolved prior to 1961.

Note that, unlike the Court's website, any files associated with these cases are always listed *with* the case, regardless of any other collection(s) in which they may also appear.  So, even when browsing a term like [October Term 1944](/courts/ussc/?term=1944-10), an Original Jurisdiction case such as [Nebraska v. Wyoming (No. 6 Orig)](/courts/ussc/?term=1944-10&case=6-Orig) will always list any related files.

As an aside, here's a handy table from the Court's [website](https://www.supremecourt.gov/filingandrules/rules_guidance.aspx) that explains the cover colors you'll see below:

[![Booklet Format Chart](/courts/ussc/collections/orig/booklets.jpg)](https://www.supremecourt.gov/casehand/BookletFormatSpecificChart2026.pdf)

<style>
.og-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 28px 0 14px;
}
.og-heading h2 {
  margin: 0;
  font-weight: 700;
}
.og-case {
  margin-bottom: 22px;
}
.og-case-title {
  display: block;
  font-size: 0.85rem;
  font-weight: 700;
  text-decoration: none;
  color: inherit;
  margin-bottom: 6px;
}
.og-case-title:hover { text-decoration: underline; }
.og-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(85px, 1fr));
  gap: 8px;
}
.og-item {
  display: block;
  aspect-ratio: 230 / 400;
  overflow: hidden;
  border-radius: 4px;
  background: #ccc;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
html[data-theme="dark"] .og-item { background: #3a3c45; }
.og-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: opacity 0.15s;
}
.og-item:hover img { opacity: 0.8; }
#og-preview {
  position: fixed;
  display: none;
  max-width: 70vw;
  border-radius: 6px;
  overflow: hidden;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  z-index: 1000;
  background: #fff;
  border: 1px solid transparent;
}
#og-preview-img {
  display: block;
  max-height: 70vh;
  max-width: 70vw;
  width: auto;
  height: auto;
  /* Override the layout's html[data-theme="dark"] img { opacity: 0.9 } —
     at full size over page text, even 10% translucency reads as "see-through". */
  opacity: 1 !important;
}
#og-preview-caption {
  padding: 6px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  text-align: center;
  background: #fff;
  color: #222;
  border-top: 1px solid #ddd;
  overflow-wrap: break-word;
}
html[data-theme="dark"] #og-preview       { border-color: #fff; }
html[data-theme="dark"] #og-preview-caption {
  background: #1e2028;
  color: #d0d3dc;
  border-top-color: #fff;
}
</style>

<div class="og-heading">
  <h2>Case Gallery</h2>
</div>
<div id="og-gallery"></div>
<div id="og-preview">
  <img id="og-preview-img" alt="">
  <div id="og-preview-caption"></div>
</div>

<script>
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

  fetch('/courts/ussc/collections/orig.json')
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
</script>
