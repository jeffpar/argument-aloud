/**
 * update_opinions.js — Distill raw Justia opinion HTML (courts/ussc/opinions/html)
 * into simple XML (courts/ussc/opinions/xml), stripping page chrome/navigation/ads
 * and keeping just the opinion text: paragraphs, page numbers, footnotes, and
 * relative links (self-citations and citations to other cases in this corpus).
 *
 * Every Justia case page duplicates its opinion text: a "Syllabus" block (a
 * distinct official summary in modern cases; a truncated copy in old ones) and
 * a "#opinions" block containing the real, complete text — one <div id="tab-
 * opinion-NNNN"> pane per opinion (majority/concurrence/dissent/etc. each have
 * their own pane and their own tab in Justia's UI). We always take the panes
 * inside #opinions and ignore the syllabus entirely.
 *
 * Within a pane, Justia does not wrap paragraphs in <p>text</p> — instead
 * loose inline content flows freely and an empty <p></p> marks the end of each
 * paragraph. Page breaks appear as <a class="page-number"> anchors (either
 * loose, followed by a citation echo and a <p></p>, or already p-wrapped).
 * Footnotes are collected in a single <div class="opinion-footnotes"> at the
 * end of each pane, with a matching in-text [<a href="#F1">1</a>] marker.
 *
 * Usage:
 *   node scripts/update_opinions.js --survey              # validate structural assumptions; no writes
 *   node scripts/update_opinions.js                       # convert every case in the corpus
 *   node scripts/update_opinions.js us002                 # convert one volume
 *   node scripts/update_opinions.js us002 us002-0001       # convert one case (bare "0001" / "13-1339" also OK)
 *   node scripts/update_opinions.js --link-cases           # write decision_xml into every matching cases.json entry
 *   ... --force                                            # reconvert even if the .xml is already newer
 *   ... --dry-run                                          # report what would happen; no writes
 *   ... --verbose                                          # extra per-file logging
 *
 * © 2026 by Jeff Parsons
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseHtml } from 'node-html-parser';
import { reorderCase } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HTML_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'html');
const XML_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'xml');
const REPORTS_JSON = path.join(REPO_ROOT, 'data', 'ussc', 'reports.json');
const TERMS_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'terms');

const CANONICAL_RE = /rel="canonical"\s+href="https:\/\/supreme\.justia\.com\/cases\/federal\/us\/(\d+)\/([\w-]+)\/?"/;
const OG_TITLE_RE = /property="og:title"\s+content="([^"]*)"/;

// The nominative-reporter surname (data/ussc/reports.json's "alt_citation", e.g.
// "13 Wallace" for volume 80) as actually abbreviated in Justia's citation text —
// only the volumes before official U.S. Reports numbering began (1875) carry one.
const REPORTER_ABBREV = {
    Dallas: 'Dall', Cranch: 'Cranch', Wheaton: 'Wheat', Peters: 'Pet', Howard: 'How', Black: 'Black', Wallace: 'Wall',
};

let _reportsJson = null;
function _loadReports() {
    if (_reportsJson) return _reportsJson;
    try { _reportsJson = JSON.parse(fs.readFileSync(REPORTS_JSON, 'utf8')); }
    catch { _reportsJson = {}; }
    return _reportsJson;
}

/**
 * Build a regex that strips a case's own redundant nominative-reporter citation
 * (e.g. "13 Wall. 1" in "Bethell v. Mathews, 80 U.S. 13 Wall. 1 1 (1871)") out of
 * a citation-echo heading, given its U.S. Reports volume number. Old and new page
 * numbers are always identical (same physical book, just two volume-naming
 * conventions), so this is "<newVol> U.S. <oldVol> <reporter>[.] <page> "
 * immediately before the (now-redundant) repeated page number, collapsed down to
 * plain "<newVol> U.S. ". When the old volume number happens to look like a
 * valid page (e.g. case's own page 1, old volume "1 Cranch"), Justia sometimes
 * auto-links "<newVol> U.S. <oldVol>" as a self-citation — matched (via the
 * optional <a>/</a> below) and discarded along with the rest, rather than left
 * with a dangling unclosed tag; the replacement is always plain, unlinked text
 * (see the .replace() call site), since a link to the case's own opening page is
 * redundant with the synthesized <n id="p..."> anchor elsewhere in the heading
 * anyway. Returns null when the volume predates official numbering but isn't in
 * reports.json, or postdates it (no alt_citation at all).
 */
function _oldCitationRe(vol) {
    const entry = _loadReports()[`v${String(vol).padStart(3, '0')}`];
    const m = (entry?.alt_citation || '').match(/^(\d+)\s+(\w+)$/);
    if (!m) return null;
    const [, oldVol, reporter] = m;
    const stem = REPORTER_ABBREV[reporter];
    if (!stem) return null;
    return new RegExp(`(?:<a[^>]*>)?(\\d+)\\s+U\\.S\\.\\s+${oldVol}(?:<\\/a>)?\\s+${stem}[a-z]*\\.?\\s+\\d+\\s+(?=\\d+\\s*\\()`);
}

// ── file discovery ──────────────────────────────────────────────────────────

const VOLUME_NAME_RE = /^us\d+\.html$/;
const CASE_NAME_RE = /^us\d+-[\w-]+\.html$/;

function listVolumeDirs() {
    return fs.readdirSync(HTML_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
}

/** List case (non-volume-index) html files under one volume dir, as {volDir, file}. */
function listCaseFiles(volDir) {
    return fs.readdirSync(path.join(HTML_DIR, volDir))
        .filter(f => CASE_NAME_RE.test(f) && !VOLUME_NAME_RE.test(f))
        .sort()
        .map(file => ({ volDir, file }));
}

function listAllCaseFiles() {
    const out = [];
    for (const volDir of listVolumeDirs()) out.push(...listCaseFiles(volDir));
    return out;
}

// ── citation index (for resolving cross-case links to relative xml paths) ──

/**
 * Scan every case file's canonical link to build "vol/page" -> {volDir, file}.
 * "page" is whatever Justia put in that URL slot — a real page number for
 * paginated cases, or a docket number (e.g. "15-274") for recent slip opinions.
 */
function buildCitationIndex(verbose) {
    const index = new Map();
    const files = listAllCaseFiles();
    let unresolved = 0;
    for (const { volDir, file } of files) {
        const full = path.join(HTML_DIR, volDir, file);
        const canon = readCanonical(full);
        if (!canon) { unresolved++; continue; }
        index.set(`${canon.vol}/${canon.page}`, { volDir, file });
    }
    if (verbose) console.log(`  citation index: ${index.size} entries, ${unresolved} files unresolved`);
    return index;
}

/** Read a file's canonical vol/page, trying a small prefix read before falling back to the whole file. */
function readCanonical(fullPath) {
    const fd = fs.openSync(fullPath, 'r');
    try {
        const buf = Buffer.alloc(16384);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        let m = buf.toString('utf8', 0, n).match(CANONICAL_RE);
        if (m) return { vol: m[1], page: m[2] };
        const stat = fs.fstatSync(fd);
        if (stat.size <= buf.length) return null;
        const html = fs.readFileSync(fullPath, 'utf8');
        m = html.match(CANONICAL_RE);
        return m ? { vol: m[1], page: m[2] } : null;
    } finally {
        fs.closeSync(fd);
    }
}

// ── XML helpers ──────────────────────────────────────────────────────────

function escText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
    return escText(s).replace(/"/g, '&quot;');
}

function collapseWs(s) {
    return s.replace(/[\s ]+/g, ' ').replace(/\s+,/g, ',').trim();
}

// ── inline content rendering (text nodes + a; em/strong/span/etc. are stylistic) ──

// Footnote def/ref ids are just "fn{n}"/"nf{n}" — the mirrored pair reads as
// "footnote N" / "note-for-N", and neither can be mistaken for a hex color by
// an editor the way a bare "f{n}" (e.g. "f0f", "faa") could — opinion-scoped
// to "fn{opIdx}-{n}"/"nf{opIdx}-{n}" only when ctx.multiOpinion (the case has
// more than one <opinion>), since each opinion numbers its own footnotes from
// 1 and would otherwise collide. Single-opinion cases (the large majority)
// get the short form.
function _footnoteDefId(ctx, n) { return ctx.multiOpinion ? `fn${ctx.opinionIndex}-${n}` : `fn${n}`; }
function _footnoteRefId(ctx, n) { return ctx.multiOpinion ? `nf${ctx.opinionIndex}-${n}` : `nf${n}`; }

// Justia uses class names like "headertext" and "heading-4"/"heading-5" to mark
// caption/heading content (case name, docket number, argued/decided dates, party
// captions, "Syllabus", etc.) — regardless of which tag (span/strong/em/...)
// happens to carry it. That's structural, so it becomes <hN> rather than being
// stripped like ordinary decorative <em>/<strong> formatting.
function _hasHeadingClass(el) {
    return /\bhead(?:ing|ertext)/i.test(el.getAttribute('class') || '');
}

const _YEAR_RE = /\b1[6-9]\d{2}\b|\b20\d{2}\b/;

// A heading that's nothing but a repeat of the case's own citation (the h1
// already carries it) — e.g. "2 U.S. 1 (Dall.)" or a bare "397 U.S. 1" — adds
// no information, so it's dropped entirely rather than kept as another
// heading. Checked against the citation as plain text (tags stripped) since
// the citation is usually itself a self-citation <a>; only a citation alone,
// optionally with one trailing/leading old-reporter parenthetical, qualifies —
// the h1 (which always also carries the case title) never matches this.
function _isRedundantCitationHeading(html, ctx) {
    if (!ctx.citation) return false;
    const plain = html.replace(/<[^>]+>/g, '');
    if (!plain.includes(ctx.citation)) return false;
    const stripped = plain.split(ctx.citation).join('').trim();
    return stripped === '' || /^\([^()]*\)$/.test(stripped);
}

// h1: the one heading that names the case AND cites it (both the title and the
// citation, not just one) — the "main" heading. h4: anything else mentioning a
// year (argued/decided dates, court term). h2: everything else (the eyebrow
// "U.S. Supreme Court" label, a bare repeated case name, "Syllabus", etc.) —
// deliberately no h3, per the requested scheme.
function _headingLevel(text, ctx) {
    if (ctx.title && ctx.citation && text.includes(ctx.title) && text.includes(ctx.citation)) return 1;
    if (_YEAR_RE.test(text)) return 4;
    return 2;
}

/** Render a single node (text or element) — see renderInline() below for the full contract. */
function renderInlineNode(child, ctx) {
    if (child.nodeType === 3) return escText(child.text);
    if (child.nodeType !== 1) return '';
    const tag = (child.rawTagName || '').toLowerCase();
    if (tag === 'br') return ' ';
    if (tag === 'a') {
        const inner = renderInline(child, ctx);
        if (!inner) return ''; // Justia sometimes emits an empty <a href> right before the real one; drop it
        const href = child.getAttribute('href');
        const frag = href && href.startsWith('#') ? href.slice(1) : null;
        // Footnotes always come in T/F id pairs, regardless of which of the two
        // source layouts (a div.opinion-footnotes cluster, or loose "[<a
        // href=#F1 id=T1>...] ... [<a href=#T1 id=F1>...]" bracket markers) this
        // document uses: the in-text marker has href="#F{n}" (jumps down to the
        // definition); the definition's own marker has href="#T{n}" (jumps back
        // up to the in-text marker). Renamed here to be self-explanatory and
        // symmetric: "nf{n}" for the in-text marker, "fn{n}" for the definition
        // — each pointing at the other's new id (see _footnoteDefId/_footnoteRefId).
        let fm;
        if (frag && (fm = frag.match(/^F(\d+)$/))) {
            const n = fm[1];
            return `<a id="${_footnoteRefId(ctx, n)}" href="#${_footnoteDefId(ctx, n)}">${inner}</a>`;
        }
        if (frag && (fm = frag.match(/^T(\d+)$/))) {
            const n = fm[1];
            return `<a id="${_footnoteDefId(ctx, n)}" href="#${_footnoteRefId(ctx, n)}">${inner}</a>`;
        }
        if (href) {
            const resolved = resolveHref(href, ctx);
            return resolved ? `<a href="${escAttr(resolved)}">${inner}</a>` : inner;
        }
        return inner;
    }
    if (!ctx.insideHeading && _hasHeadingClass(child)) {
        let headingText = renderInline(child, { ...ctx, insideHeading: true });
        if (ctx.oldCitationRe) headingText = headingText.replace(ctx.oldCitationRe, (_, newVol) => `${newVol} U.S. `);
        headingText = collapseWs(headingText); // trims e.g. a leading &nbsp; left over from a stripped lead-in
        if (_isRedundantCitationHeading(headingText, ctx)) return '';
        const level = _headingLevel(headingText, ctx);
        return `<h${level}>${headingText}</h${level}>`;
    }
    // Everything else (em/i/strong/b/sup/sub/u/span/font/nobr/..., and any
    // unknown inline-ish element like a stray <img>) is stripped to plain text.
    return renderInline(child, ctx);
}

/**
 * Render a node's inline descendants to a string, resolving <a href> per
 * resolveHref() and renaming footnote markers per ctx.opinionIndex (see the
 * F/T handling in renderInlineNode). All stylistic tags (em/i/strong/b/sup/
 * sub/u/span/font/...) are stripped to plain text; an element carrying a
 * heading-suggestive class becomes <hN>...</hN> instead (ctx.insideHeading
 * avoids nesting <hN> when both an outer and inner element are heading-classed,
 * e.g. <strong class="heading-5"><span class="headertext">).
 */
function renderInline(node, ctx) {
    let out = '';
    for (const child of node.childNodes) out += renderInlineNode(child, ctx);
    return out;
}

/**
 * Resolve a citation href to a relative path within xml/ when the target is in our
 * corpus, with a "#p<page>" fragment when the pinpointed page is known. Justia's own
 * citation links already carry a pinpoint-page fragment when one applies (e.g.
 * href="/cases/federal/us/397/1/#6", the case's canonical vol/page plus the specific
 * page cited); when it doesn't (a plain citation to the whole case), the case's own
 * canonical page is used instead, since every converted file's first opinion carries
 * a synthesized <n id="p<page>"> anchor at that exact page (see convertOpinion) even
 * when the source has no page-break marker there (page 1 never has one).
 */
function resolveHref(href, ctx) {
    // Citations to U.S. Reports cases appear both as absolute (supreme.justia.com or
    // law.justia.com) and as root-relative ("/cases/federal/us/VOL/PAGE/...") URLs.
    const m = href.match(/^(?:https?:\/\/(?:supreme|law)\.justia\.com)?\/cases\/federal\/us\/(\d+)\/([\w-]+)\/?(?:#(\w+))?$/);
    if (m) {
        const [, vol, page, pinpoint] = m;
        const target = ctx.citationIndex.get(`${vol}/${page}`);
        if (target) {
            const targetXml = path.join(XML_DIR, target.volDir, target.file.replace(/\.html$/, '.xml'));
            let rel = path.relative(path.dirname(ctx.outPath), targetXml);
            if (!rel.startsWith('.')) rel = './' + rel;
            const effectivePage = pinpoint || (/^\d+$/.test(page) ? page : null);
            return effectivePage ? `${rel}#p${effectivePage}` : rel;
        }
        return href.startsWith('/') ? 'https://law.justia.com' + href : href; // known case we don't have locally
    }
    if (href.startsWith('/')) return 'https://law.justia.com' + href;
    if (/^https?:\/\//.test(href)) return href;
    return null; // in-page fragment or unrecognized scheme; not worth preserving
}

// ── page-number extraction ──────────────────────────────────────────────────

function isPageNumberAnchor(el) {
    return el.nodeType === 1 && el.rawTagName === 'a' &&
        (el.getAttribute('class') || '').split(/\s+/).includes('page-number');
}

function pageNumberOf(el) {
    const name = el.getAttribute('name');
    if (name && /^\d+$/.test(name)) return name;
    const m = el.text.match(/(\d+)\s*$/);
    return m ? m[1] : null;
}

// ── footnotes ────────────────────────────────────────────────────────────
//
// Two source layouts carry footnotes, and both are handled here:
//  - modern: every footnote collected in one <div class="opinion-footnotes">
//    at the end of the pane, each as <div class="opinion-footnote"><span
//    class="opinion-footnote-ref"><a href="#T{n}" id="F{n}">{n}</a></span>
//    <span class="opinion-footnote-text">{body}</span></div> — handled by
//    collectFootnotes() below, called once per pane before walkFlow runs.
//  - older: no wrapping div at all — a footnote is just an isolated paragraph
//    "[<a href="#T{n}" id="F{n}">Footnote {n}</a>]" (the definition's own
//    marker, right where its body would print on the source page) followed by
//    one or more ordinary paragraphs of body text, repeated for each
//    footnote, usually clustered at the end of the pane. There's no separate
//    block to pre-scan here — walkFlow recognizes the isolated marker
// 	  paragraph (after renderInlineNode has already renamed it to
//    <a id="f{opIdx}-{n}" href="#ref{opIdx}-{n}">) and redirects subsequent
//    paragraphs into that footnote's body until the next marker or the pane
//    ends (see the footnote collector in walkFlow / finishFootnote below).
//
// Either way, in-text markers and definition markers are just renamed
// symmetrically wherever they occur (see the F/T handling in
// renderInlineNode) — no pre-scan or id map is needed for that part.

/** Collect modern-format footnotes from one <div class="opinion-footnotes">, as XML strings. */
function collectFootnotes(footnotesDiv, ctx) {
    const entries = footnotesDiv.querySelectorAll('.opinion-footnote');
    return entries.map((entry, i) => {
        const refAnchor = entry.querySelector('.opinion-footnote-ref a');
        const textSpan = entry.querySelector('.opinion-footnote-text');
        const idMatch = (refAnchor?.getAttribute('id') || '').match(/^F(\d+)$/);
        const n = idMatch ? idMatch[1] : String(i + 1);
        const defAnchor = refAnchor ? renderInlineNode(refAnchor, ctx)
            : `<a id="${_footnoteDefId(ctx, n)}">${escText(n)}</a>`;
        const body = textSpan ? collapseWs(renderInline(textSpan, ctx)) : '';
        return `<f n="${escAttr(n)}">${defAnchor} ${body}</f>`;
    });
}

/** Finish the old-style footnote currently being collected (see walkFlow), if any, pushing it to out. */
function finishFootnote(ctx, out) {
    const fc = ctx.footnoteCollector;
    if (!fc) return;
    ctx.footnoteCollector = null;
    const body = fc.body.join('\n      ');
    out.push(`<f n="${escAttr(fc.n)}">${fc.defAnchor}${body ? '\n      ' + body + '\n    ' : ''}</f>`);
}

// ── paragraph-flow walking ──────────────────────────────────────────────────

function isEmptyP(el) {
    return el.nodeType === 1 && el.rawTagName === 'p' && collapseWs(el.text) === '';
}

function hasEmptyPChild(el) {
    return el.childNodes.some(c => isEmptyP(c));
}

// A rendered paragraph never nests <hN> inside <p> — a heading-classed element
// gets its own top-level <hN> sibling, splitting out any surrounding plain text
// (rare — Justia normally isolates these already) into its own <p>(s). Genuine
// single headings never contain a nested <hN> (renderInlineNode suppresses that
// via ctx.insideHeading), so this only ever splits on real <hN> boundaries.
const _HEADING_SPLIT_RE = /<h(\d)>[\s\S]*?<\/h\1>/g;
// Underscore-only "paragraphs" are decorative dividers (around the case header)
// or blank-fill lines (in reproduced forms) — pure noise either way, so drop them.
const _SEPARATOR_PARA_RE = /^_+$/;
function emitParagraph(push, text) {
    if (!text || _SEPARATOR_PARA_RE.test(text.trim())) return;
    _HEADING_SPLIT_RE.lastIndex = 0;
    let last = 0, m, any = false;
    while ((m = _HEADING_SPLIT_RE.exec(text))) {
        any = true;
        const before = text.slice(last, m.index).trim();
        if (before) push(`<p>${before}</p>`);
        push(m[0]);
        last = _HEADING_SPLIT_RE.lastIndex;
    }
    if (!any) { push(`<p>${text}</p>`); return; }
    const after = text.slice(last).trim();
    if (after) push(`<p>${after}</p>`);
}

// Recognizes "[<a id="f{opIdx}-{n}" href="#ref{opIdx}-{n}">...</a>]" (brackets
// optional, and the whole thing optionally <hN>...</hN>-wrapped — some documents
// give the marker itself a heading-suggestive class) anywhere in a flushed
// paragraph — the renamed form of an older-style footnote definition's own
// marker (see the "── footnotes ──" section above) — once renderInlineNode has
// already renamed it (and, if applicable, already <hN>-wrapped it). Not
// anchored to the start: besides the marker alone in its own paragraph (the
// common case) and the marker immediately followed by its body text in the
// same paragraph (no brackets, a rarer variant), a heading with no trailing
// <p></p> in the source (e.g. a "Footnotes" label right before the first
// marker) can merge into the same flushed text ahead of the marker — any such
// leading content is flushed on its own first. The optional <hN>/</hN> must be
// matched as part of the marker (rather than left for emitParagraph's own
// heading handling) so the before/after split below can never cut through a
// still-open <hN> tag (the opening/closing level numbers aren't required to
// match each other here — this is a strip-it-out search, not a validator).
// Scoped to ctx.opinionIndex so it can't match a marker belonging to a
// different opinion in the same case file.
function _footnoteMarkerRe(ctx) {
    const fPrefix = ctx.multiOpinion ? `fn${ctx.opinionIndex}-` : 'fn';
    const refPrefix = ctx.multiOpinion ? `nf${ctx.opinionIndex}-` : 'nf';
    return new RegExp(`(?:<h\\d>)?\\[?<a id="${fPrefix}(\\d+)" href="#${refPrefix}\\d+">([^<]*)<\\/a>\\]?(?:<\\/h\\d>)?\\s*`);
}

/** Walk a flow container's children, splitting on empty <p></p> markers, into <p>/<hN>/<n>/<f> strings. */
function walkFlow(container, ctx, out) {
    let buffer = '';
    let skipToParaBreak = false;
    let pendingPageNumber = null; // {n} once known, else null while still scanning the citation echo for a trailing number
    const footnoteMarkerRe = _footnoteMarkerRe(ctx);

    // Redirects into the older-style footnote currently being collected (see
    // finishFootnote), if any — shared via ctx so this also applies to content
    // reached through a nested walkFlow() call (e.g. a footnote body containing
    // an indented quote block).
    const emit = (item) => (ctx.footnoteCollector ? ctx.footnoteCollector.body : out).push(item);

    const flush = () => {
        if (pendingPageNumber !== null) {
            const n = pendingPageNumber.n || (collapseWs(buffer).match(/(\d+)\s*$/) || [])[1];
            if (n) emit(`<n id="p${n}">${n}</n>`);
            pendingPageNumber = null;
            buffer = '';
            return;
        }
        const text = collapseWs(buffer);
        buffer = '';
        if (!text) return;
        const m = text.match(footnoteMarkerRe);
        if (m) {
            const before = text.slice(0, m.index).trim();
            if (before) emitParagraph(emit, before); // e.g. a "Footnotes" heading merged in ahead of the marker
            finishFootnote(ctx, out); // close out whichever older-style footnote was being collected, if any
            ctx.footnoteCollector = { n: m[1], defAnchor: `<a id="${_footnoteDefId(ctx, m[1])}" href="#${_footnoteRefId(ctx, m[1])}">${m[2]}</a>`, body: [] };
            const rest = text.slice(m.index + m[0].length).trim();
            if (rest) emitParagraph(emit, rest); // bracket-less variant: body text starts in the same paragraph
            return;
        }
        emitParagraph(emit, text);
    };

    for (const node of container.childNodes) {
        if (node.nodeType === 3) {
            if (!skipToParaBreak) buffer += escText(node.text);
            continue;
        }
        if (node.nodeType !== 1) continue;
        const tag = (node.rawTagName || '').toLowerCase();

        if (isPageNumberAnchor(node)) {
            flush();
            pendingPageNumber = { n: pageNumberOf(node) };
            skipToParaBreak = false; // keep buffering the trailing citation echo ("2 U.S. 1, 3") as a number-recovery fallback
            continue;
        }
        if (tag === 'p') {
            if (isEmptyP(node)) {
                flush();
                skipToParaBreak = false;
                continue;
            }
            // A page-number anchor wrapped in its own <p> (modern-format pagination).
            const kids = node.childNodes.filter(c => c.nodeType === 1);
            if (kids.length === 1 && isPageNumberAnchor(kids[0])) {
                flush();
                const n = pageNumberOf(kids[0]);
                if (n) emit(`<n id="p${n}">${n}</n>`);
                continue;
            }
            // A genuinely content-wrapped <p> (defensive: not the usual idiom, but handle it).
            flush();
            emitParagraph(emit, collapseWs(renderInline(node, ctx)));
            continue;
        }
        if (tag === 'div' && (node.getAttribute('class') || '').includes('opinion-footnotes')) {
            flush();
            skipToParaBreak = false;
            continue; // modern-format footnotes are collected in a separate pass; see convertOpinion()
        }
        if (tag === 'div') {
            flush();
            skipToParaBreak = false;
            if (hasEmptyPChild(node)) {
                walkFlow(node, ctx, out); // nested flow container
            } else {
                emitParagraph(emit, collapseWs(renderInline(node, ctx))); // one-off block (e.g. an indented quote)
            }
            continue;
        }
        if (/^h[1-6]$/.test(tag)) {
            flush();
            skipToParaBreak = false;
            emitParagraph(emit, collapseWs(renderInline(node, ctx)));
            continue;
        }
        // Inline content (em/a/span/strong/br/...): fold into the running paragraph buffer.
        if (!skipToParaBreak) buffer += renderInlineNode(node, ctx);
    }
    flush();
}

// ── per-opinion / per-case conversion ───────────────────────────────────────

function paneLabel(root, paneId) {
    const link = root.querySelector(`#list-${paneId.replace(/^tab-/, '')}`);
    if (!link) return null;
    const raw = collapseWs(link.text);
    const m = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    const author = m && m[2].trim() ? m[2].trim() : null;
    return { type: (m ? m[1] : raw).trim(), author };
}

function convertOpinion(pane, opinionIndex, root, ctx) {
    ctx.opinionIndex = opinionIndex;
    ctx.footnoteCollector = null;
    const label = paneLabel(root, pane.id) || { type: 'Opinion', author: null };
    const contentRoot = pane.childNodes.find(c => c.nodeType === 1 && c.rawTagName === 'div') || pane;

    // Modern-format footnotes are collected in one pass before the flow renders
    // (older-style ones are found and collected inline; see walkFlow).
    const footnoteDivs = contentRoot.querySelectorAll('div.opinion-footnotes, .opinion-footnotes');
    const footnoteDefs = [];
    footnoteDivs.forEach(div => footnoteDefs.push(...collectFootnotes(div, ctx)));

    const body = [];
    // Page 1 of a case never has its own page-break marker in the source (there's
    // nothing to break *from*), so a self-citation to it would otherwise have
    // nowhere to point — synthesize the opening anchor here so it does.
    if (ctx.openingPage) body.push(`<n id="p${ctx.openingPage}">${ctx.openingPage}</n>`);
    walkFlow(contentRoot, ctx, body);
    finishFootnote(ctx, body); // close out a trailing older-style footnote, if the pane ended mid-collection

    const attrs = [`type="${escAttr(label.type)}"`];
    if (label.author) attrs.push(`author="${escAttr(label.author)}"`);
    const inner = [...body, ...footnoteDefs].join('\n    ');
    return `  <opinion ${attrs.join(' ')}>\n    ${inner}\n  </opinion>`;
}

/** Convert one case's html to xml text, or return null if it has no usable #opinions content. */
function convertCase(volDir, file, ctx) {
    const srcPath = path.join(HTML_DIR, volDir, file);
    const html = fs.readFileSync(srcPath, 'utf8');
    const root = parseHtml(html, { comment: false });

    const opinionsDiv = root.querySelector('#opinions');
    if (!opinionsDiv) return { error: 'no #opinions element' };
    const panes = opinionsDiv.querySelectorAll('div[id^="tab-opinion-"]');
    if (panes.length === 0) return { error: 'no opinion panes found' };

    const canonMatch = html.match(CANONICAL_RE);
    const citation = canonMatch ? `${canonMatch[1]} U.S. ${canonMatch[2]}` : null;
    const ogTitleMatch = html.match(OG_TITLE_RE);
    const title = ogTitleMatch ? ogTitleMatch[1].replace(/,\s*\d+\s*U\.\s*S\.\s*.*$/, '').trim() : null;
    // Only the first (and typically only) opinion actually starts on the case's own
    // canonical page — later opinions (concurrence/dissent) start wherever they fall,
    // which we don't know in advance, so no synthesized anchor for those.
    const openingPage = canonMatch && /^\d+$/.test(canonMatch[2]) ? canonMatch[2] : null;
    // Every opinion's own citation-echo heading repeats the case's nominative-reporter
    // citation (e.g. "13 Wall."), not just the first opinion's, so this is shared.
    const oldCitationRe = canonMatch ? _oldCitationRe(canonMatch[1]) : null;

    const perOpCtx = (outPath, isFirst) => ({
        citationIndex: ctx.citationIndex, outPath, openingPage: isFirst ? openingPage : null,
        multiOpinion: panes.length > 1, oldCitationRe, title, citation,
    });
    const outPath = path.join(XML_DIR, volDir, file.replace(/\.html$/, '.xml'));

    const opinions = panes.map((pane, i) => convertOpinion(pane, i + 1, root, perOpCtx(outPath, i === 0)));

    const attrs = [`source="${escAttr(file)}"`];
    if (citation) attrs.push(`citation="${escAttr(citation)}"`);
    if (title) attrs.push(`title="${escAttr(title)}"`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" href="/assets/xsl/opinion.xsl"?>\n<case ${attrs.join(' ')}>\n${opinions.join('\n')}\n</case>\n`;
    return { xml, outPath };
}

// ── survey mode ──────────────────────────────────────────────────────────

function runSurvey() {
    const files = listAllCaseFiles();
    console.log(`Surveying ${files.length} case files across ${listVolumeDirs().length} volumes...\n`);

    const stats = {
        errorPages: [],
        noOpinionsDiv: [],
        noPanes: [],
        noCanonical: [],
        noPaneLabel: [],
        footnoteRefMismatch: [],
        badPageNumber: [],
        unknownOpinionType: [],
    };
    const paneCountHist = new Map();
    const typeHist = new Map();
    let selfLinks = 0, crossLinksResolved = 0, crossLinksExternal = 0;

    const citationIndex = buildCitationIndex(true);
    const KNOWN_TYPES = new Set(['Opinion', 'Opinions & Dissents', 'Concurrence', 'Dissent',
        'Per Curiam', 'Concurrence & Dissent In Part', 'Concurrence/Dissent', 'Concdiss', 'Statement', 'Dissent (Revised)']);

    let n = 0;
    for (const { volDir, file } of files) {
        n++;
        if (n % 5000 === 0) console.log(`  ...${n}/${files.length}`);
        const full = path.join(HTML_DIR, volDir, file);
        const html = fs.readFileSync(full, 'utf8');
        if (/class="neterror"/.test(html)) { stats.errorPages.push(`${volDir}/${file}`); continue; }

        let root;
        try { root = parseHtml(html, { comment: false }); } catch (e) {
            stats.errorPages.push(`${volDir}/${file} (parse error: ${e.message})`);
            continue;
        }

        if (!CANONICAL_RE.test(html)) stats.noCanonical.push(`${volDir}/${file}`);

        const opinionsDiv = root.querySelector('#opinions');
        if (!opinionsDiv) { stats.noOpinionsDiv.push(`${volDir}/${file}`); continue; }
        const panes = opinionsDiv.querySelectorAll('div[id^="tab-opinion-"]');
        if (panes.length === 0) { stats.noPanes.push(`${volDir}/${file}`); continue; }
        paneCountHist.set(panes.length, (paneCountHist.get(panes.length) || 0) + 1);

        for (const pane of panes) {
            const label = paneLabel(root, pane.id);
            if (!label) { stats.noPaneLabel.push(`${volDir}/${file}#${pane.id}`); continue; }
            typeHist.set(label.type, (typeHist.get(label.type) || 0) + 1);
            if (!KNOWN_TYPES.has(label.type)) stats.unknownOpinionType.push(`${volDir}/${file}: "${label.type}"`);

            // footnote ref/def balance
            const defIds = new Set(pane.querySelectorAll('.opinion-footnote-ref a').map(a => a.getAttribute('id')).filter(Boolean));
            const refHrefs = pane.querySelectorAll('a[href^="#"]')
                .map(a => a.getAttribute('href').slice(1))
                .filter(h => defIds.has(h) || /^[TF]\d+$/.test(h));
            const usedDefIds = new Set(refHrefs.filter(h => defIds.has(h)));
            if (usedDefIds.size !== defIds.size) {
                stats.footnoteRefMismatch.push(`${volDir}/${file}#${pane.id}: ${defIds.size} defs, ${usedDefIds.size} referenced`);
            }

            // page-number sanity
            for (const a of pane.querySelectorAll('a.page-number')) {
                if (!pageNumberOf(a)) stats.badPageNumber.push(`${volDir}/${file}: page-number anchor with no number ("${a.text}")`);
            }

            // link classification
            for (const a of pane.querySelectorAll('a.related-case, a[class="related-case"]')) {
                const href = a.getAttribute('href');
                if (!href) continue;
                const m = href.match(/^(?:https?:\/\/(?:supreme|law)\.justia\.com)?\/cases\/federal\/us\/(\d+)\/([\w-]+)\/?(?:#.*)?$/);
                if (m) {
                    const target = citationIndex.get(`${m[1]}/${m[2]}`);
                    if (target && target.volDir === volDir && target.file === file) selfLinks++;
                    else if (target) crossLinksResolved++;
                    else crossLinksExternal++;
                } else {
                    crossLinksExternal++;
                }
            }
        }
    }

    console.log('\n=== Survey results ===\n');
    console.log(`Error / unfetched pages: ${stats.errorPages.length}`);
    stats.errorPages.slice(0, 10).forEach(f => console.log(`  ${f}`));
    console.log(`\nMissing canonical citation link: ${stats.noCanonical.length}`);
    stats.noCanonical.slice(0, 10).forEach(f => console.log(`  ${f}`));
    console.log(`\nMissing #opinions block: ${stats.noOpinionsDiv.length}`);
    stats.noOpinionsDiv.slice(0, 10).forEach(f => console.log(`  ${f}`));
    console.log(`\n#opinions present but no opinion panes found: ${stats.noPanes.length}`);
    stats.noPanes.slice(0, 10).forEach(f => console.log(`  ${f}`));
    console.log(`\nOpinion panes with no matching tab-nav label: ${stats.noPaneLabel.length}`);
    stats.noPaneLabel.slice(0, 10).forEach(f => console.log(`  ${f}`));
    console.log(`\nUnrecognized opinion-type labels: ${stats.unknownOpinionType.length}`);
    stats.unknownOpinionType.slice(0, 20).forEach(f => console.log(`  ${f}`));
    console.log(`\nFootnote ref/def mismatches: ${stats.footnoteRefMismatch.length}`);
    stats.footnoteRefMismatch.slice(0, 10).forEach(f => console.log(`  ${f}`));
    console.log(`\nPage-number anchors with no extractable number: ${stats.badPageNumber.length}`);
    stats.badPageNumber.slice(0, 10).forEach(f => console.log(`  ${f}`));

    console.log('\nOpinion panes per case (histogram):');
    [...paneCountHist.entries()].sort((a, b) => a[0] - b[0]).forEach(([k, v]) => console.log(`  ${k} pane(s): ${v} cases`));

    console.log('\nOpinion type labels seen:');
    [...typeHist.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v.toString().padStart(6)}  ${k}`));

    console.log('\nrelated-case link classification (sample-scale, full corpus):');
    console.log(`  self-citations:            ${selfLinks}`);
    console.log(`  cross-refs resolved in-corpus: ${crossLinksResolved}`);
    console.log(`  external (state/lower courts, etc.): ${crossLinksExternal}`);

    console.log(`\nDone. ${files.length} files surveyed.`);
}

// ── conversion driver ────────────────────────────────────────────────────

function isUpToDate(srcPath, outPath) {
    if (!fs.existsSync(outPath)) return false;
    return fs.statSync(outPath).mtimeMs >= fs.statSync(srcPath).mtimeMs;
}

function runConvert({ volume, caseArg, force, dryRun, verbose }) {
    let targets;
    if (volume) {
        if (!fs.existsSync(path.join(HTML_DIR, volume))) {
            console.error(`ERROR: volume directory not found: ${volume}`);
            process.exit(1);
        }
        if (caseArg) {
            const file = caseArg.endsWith('.html') ? caseArg
                : (caseArg.startsWith(volume) ? `${caseArg}.html` : `${volume}-${caseArg}.html`);
            if (!fs.existsSync(path.join(HTML_DIR, volume, file))) {
                console.error(`ERROR: case file not found: ${volume}/${file}`);
                process.exit(1);
            }
            targets = [{ volDir: volume, file }];
        } else {
            targets = listCaseFiles(volume);
        }
    } else {
        targets = listAllCaseFiles();
    }

    console.log(`Converting ${targets.length} case file(s)${dryRun ? ' (dry run)' : ''}...`);
    const citationIndex = buildCitationIndex(verbose);
    const ctx = { citationIndex };

    let converted = 0, skipped = 0, failed = 0;
    for (const { volDir, file } of targets) {
        const srcPath = path.join(HTML_DIR, volDir, file);
        const outPath = path.join(XML_DIR, volDir, file.replace(/\.html$/, '.xml'));
        if (!force && isUpToDate(srcPath, outPath)) { skipped++; continue; }

        let result;
        try {
            result = convertCase(volDir, file, ctx);
        } catch (e) {
            console.error(`  FAILED ${volDir}/${file}: ${e.message}`);
            failed++;
            continue;
        }
        if (result.error) {
            if (verbose) console.log(`  SKIP ${volDir}/${file}: ${result.error}`);
            failed++;
            continue;
        }
        if (!dryRun) {
            fs.mkdirSync(path.dirname(result.outPath), { recursive: true });
            fs.writeFileSync(result.outPath, result.xml, 'utf8');
        }
        if (verbose) console.log(`  ${dryRun ? 'would write' : 'wrote'} ${path.relative(REPO_ROOT, result.outPath)}`);
        converted++;
    }

    console.log(`\nDone. Converted ${converted}, skipped (up-to-date) ${skipped}, failed ${failed}.`);
}

// ── link cases.json to the generated xml ────────────────────────────────

const XML_CITATION_RE = /<case\s[^>]*\bcitation="([^"]*)"/;

/** Scan every generated xml file's citation="..." attribute -> its site-absolute path. */
function buildXmlCitationIndex(verbose) {
    const index = new Map();
    let scanned = 0, noCitation = 0;
    for (const volDir of listVolumeDirs()) {
        const dir = path.join(XML_DIR, volDir);
        if (!fs.existsSync(dir)) continue;
        for (const file of fs.readdirSync(dir)) {
            if (!file.endsWith('.xml')) continue;
            scanned++;
            const head = fs.readFileSync(path.join(dir, file), { encoding: 'utf8' }).slice(0, 512);
            const m = head.match(XML_CITATION_RE);
            if (!m || !m[1]) { noCitation++; continue; }
            index.set(m[1], `/courts/ussc/opinions/xml/${volDir}/${file}`);
        }
    }
    if (verbose) console.log(`  xml citation index: ${index.size} entries from ${scanned} files (${noCitation} without a citation)`);
    return index;
}

function runLinkCases({ dryRun, verbose }) {
    const xmlByCitation = buildXmlCitationIndex(verbose);

    const termDirs = fs.readdirSync(TERMS_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
    let linked = 0, alreadyLinked = 0, termsChanged = 0;
    for (const term of termDirs) {
        const casesPath = path.join(TERMS_DIR, term, 'cases.json');
        if (!fs.existsSync(casesPath)) continue;
        let cases;
        try { cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')); } catch { continue; }
        if (!Array.isArray(cases)) continue;

        let modified = false;
        for (let i = 0; i < cases.length; i++) {
            const c = cases[i];
            const xmlPath = c.usCite ? xmlByCitation.get(c.usCite) : null;
            if (!xmlPath) continue;
            if (c.decision_xml === xmlPath) { alreadyLinked++; continue; }
            cases[i] = reorderCase({ ...c, decision_xml: xmlPath });
            linked++;
            modified = true;
            if (verbose) console.log(`  ${term}/${c.number || c.id}: decision_xml = ${xmlPath}`);
        }
        if (modified) {
            termsChanged++;
            if (!dryRun) fs.writeFileSync(casesPath, JSON.stringify(cases, null, 2) + '\n', 'utf8');
        }
    }

    console.log(`\nDone. Linked ${linked} case(s) across ${termsChanged} term file(s) (${alreadyLinked} already up to date)${dryRun ? ' (dry run)' : ''}.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────

function main() {
    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter(a => a.startsWith('--')));
    const positional = argv.filter(a => !a.startsWith('--'));

    {
        const scriptName = path.basename(process.argv[1] || 'update_opinions.js');
        console.log(`$ ${scriptName}${argv.length ? ' ' + argv.join(' ') : ''}`);
    }

    if (flags.has('--survey')) {
        runSurvey();
        return;
    }

    if (flags.has('--link-cases')) {
        runLinkCases({
            dryRun: flags.has('--dry-run') || flags.has('--dry_run'),
            verbose: flags.has('--verbose'),
        });
        return;
    }

    runConvert({
        volume: positional[0] || null,
        caseArg: positional[1] || null,
        force: flags.has('--force'),
        dryRun: flags.has('--dry-run') || flags.has('--dry_run'),
        verbose: flags.has('--verbose'),
    });
}

function isMain() {
    try { return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); }
    catch { return false; }
}

if (isMain()) main();

export { convertCase, buildCitationIndex, listAllCaseFiles, listCaseFiles };
