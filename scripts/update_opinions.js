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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const HTML_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'html');
const XML_DIR = path.join(REPO_ROOT, 'courts', 'ussc', 'opinions', 'xml');

const CANONICAL_RE = /rel="canonical"\s+href="https:\/\/supreme\.justia\.com\/cases\/federal\/us\/(\d+)\/([\w-]+)\/?"/;
const OG_TITLE_RE = /property="og:title"\s+content="([^"]*)"/;

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
    return s.replace(/[\s ]+/g, ' ').trim();
}

// ── inline content rendering (text nodes + em/i/strong/b/sup/sub/a) ────────

const TRANSPARENT_TAGS = new Set(['span', 'font', 'nobr', 'small', 'big']);
const INLINE_TAGS = new Set(['em', 'i', 'strong', 'b', 'sup', 'sub', 'u']);

/**
 * Render a node's inline descendants to a string, resolving <a href> per
 * resolveHref() and rewriting in-text footnote markers to point at
 * this opinion's regenerated <footnote id> values (via footnoteMap).
 */
function renderInline(node, ctx) {
    let out = '';
    for (const child of node.childNodes) {
        if (child.nodeType === 3) {
            out += escText(child.text);
            continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = (child.rawTagName || '').toLowerCase();
        if (tag === 'br') { out += ' '; continue; }
        if (tag === 'a') {
            const inner = renderInline(child, ctx);
            if (!inner) continue; // Justia sometimes emits an empty <a href> right before the real one; drop it
            const href = child.getAttribute('href');
            const frag = href && href.startsWith('#') ? href.slice(1) : null;
            if (frag && ctx.footnoteMap.has(frag)) {
                out += `<a href="#${escAttr(ctx.footnoteMap.get(frag))}">${inner}</a>`;
            } else if (href) {
                const resolved = resolveHref(href, ctx);
                out += resolved ? `<a href="${escAttr(resolved)}">${inner}</a>` : inner;
            } else {
                out += inner;
            }
            continue;
        }
        if (INLINE_TAGS.has(tag)) {
            out += `<${tag}>${renderInline(child, ctx)}</${tag}>`;
            continue;
        }
        if (TRANSPARENT_TAGS.has(tag)) {
            out += renderInline(child, ctx);
            continue;
        }
        // Unknown inline-ish element (e.g. stray <img>): skip its own markup, keep any text.
        out += renderInline(child, ctx);
    }
    return out;
}

/** Resolve a citation href to a relative path within xml/ when the target is in our corpus. */
function resolveHref(href, ctx) {
    // Citations to U.S. Reports cases appear both as absolute (supreme.justia.com or
    // law.justia.com) and as root-relative ("/cases/federal/us/VOL/PAGE/...") URLs.
    const m = href.match(/^(?:https?:\/\/(?:supreme|law)\.justia\.com)?\/cases\/federal\/us\/(\d+)\/([\w-]+)\/?(?:#.*)?$/);
    if (m) {
        const target = ctx.citationIndex.get(`${m[1]}/${m[2]}`);
        if (target) {
            const targetXml = path.join(XML_DIR, target.volDir, target.file.replace(/\.html$/, '.xml'));
            let rel = path.relative(path.dirname(ctx.outPath), targetXml);
            if (!rel.startsWith('.')) rel = './' + rel;
            return rel;
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

/** Build {defs, footnoteMap} for one opinion pane: XML strings + fragment-id -> new-id map. */
function collectFootnotes(footnotesDiv, opinionIndex, ctx) {
    const footnoteMap = new Map();
    const entries = footnotesDiv.querySelectorAll('.opinion-footnote');
    const parsed = entries.map((entry, i) => {
        const refAnchor = entry.querySelector('.opinion-footnote-ref a');
        const textSpan = entry.querySelector('.opinion-footnote-text');
        const n = (refAnchor && collapseWs(refAnchor.text)) || String(i + 1);
        const defId = refAnchor ? refAnchor.getAttribute('id') : null;
        const newId = `fn${opinionIndex}-${n}`;
        if (defId) footnoteMap.set(defId, newId);
        return { n, newId, textSpan };
    });
    // ctx.footnoteMap must be populated before rendering footnote/paragraph text (in-text refs point here).
    for (const [k, v] of footnoteMap) ctx.footnoteMap.set(k, v);
    const defs = parsed.map(({ n, newId, textSpan }) => {
        const body = textSpan ? collapseWs(renderInline(textSpan, ctx)) : '';
        return `<footnote id="${escAttr(newId)}" n="${escAttr(n)}">${body}</footnote>`;
    });
    return defs;
}

// ── paragraph-flow walking ──────────────────────────────────────────────────

function isEmptyP(el) {
    return el.nodeType === 1 && el.rawTagName === 'p' && collapseWs(el.text) === '';
}

function hasEmptyPChild(el) {
    return el.childNodes.some(c => isEmptyP(c));
}

/** Walk a flow container's children, splitting on empty <p></p> markers, into <p>/<n>/<footnote> strings. */
function walkFlow(container, ctx, out) {
    let buffer = '';
    let skipToParaBreak = false;
    let pendingPageNumber = null; // {n} once known, else null while still scanning the citation echo for a trailing number

    const flush = () => {
        if (pendingPageNumber !== null) {
            const n = pendingPageNumber.n || (collapseWs(buffer).match(/(\d+)\s*$/) || [])[1];
            if (n) out.push(`<n>${n}</n>`);
            pendingPageNumber = null;
            buffer = '';
            return;
        }
        const text = collapseWs(buffer);
        buffer = '';
        if (text) out.push(`<p>${text}</p>`);
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
                if (n) out.push(`<n>${n}</n>`);
                continue;
            }
            // A genuinely content-wrapped <p> (defensive: not the usual idiom, but handle it).
            flush();
            const text = collapseWs(renderInline(node, ctx));
            if (text) out.push(`<p>${text}</p>`);
            continue;
        }
        if (tag === 'div' && (node.getAttribute('class') || '').includes('opinion-footnotes')) {
            flush();
            skipToParaBreak = false;
            continue; // footnotes are collected in a second pass; see convertOpinion()
        }
        if (tag === 'div') {
            flush();
            skipToParaBreak = false;
            if (hasEmptyPChild(node)) {
                walkFlow(node, ctx, out); // nested flow container
            } else {
                const text = collapseWs(renderInline(node, ctx));
                if (text) out.push(`<p>${text}</p>`); // one-off block (e.g. an indented quote)
            }
            continue;
        }
        if (/^h[1-6]$/.test(tag)) {
            flush();
            skipToParaBreak = false;
            const text = collapseWs(renderInline(node, ctx));
            if (text) out.push(`<p>${text}</p>`);
            continue;
        }
        // Inline content (em/a/span/strong/br/...): fold into the running paragraph buffer.
        if (!skipToParaBreak) buffer += renderInline(node, ctx);
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
    const label = paneLabel(root, pane.id) || { type: 'Opinion', author: null };
    const contentRoot = pane.childNodes.find(c => c.nodeType === 1 && c.rawTagName === 'div') || pane;

    // Pass 1: register footnote defs (and their fragment-id -> new-id mapping) before rendering text.
    const footnoteDivs = contentRoot.querySelectorAll('div.opinion-footnotes, .opinion-footnotes');
    const footnoteDefs = [];
    footnoteDivs.forEach((div, i) => footnoteDefs.push(...collectFootnotes(div, opinionIndex, ctx)));

    // Pass 2: render the flow (in-text footnote refs now resolve via ctx.footnoteMap).
    const body = [];
    walkFlow(contentRoot, ctx, body);

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

    const perOpCtx = (outPath) => ({ citationIndex: ctx.citationIndex, outPath, footnoteMap: new Map() });
    const outPath = path.join(XML_DIR, volDir, file.replace(/\.html$/, '.xml'));

    const opinions = panes.map((pane, i) => convertOpinion(pane, i + 1, root, perOpCtx(outPath)));

    const attrs = [`source="${escAttr(file)}"`];
    if (citation) attrs.push(`citation="${escAttr(citation)}"`);
    if (title) attrs.push(`title="${escAttr(title)}"`);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<case ${attrs.join(' ')}>\n${opinions.join('\n')}\n</case>\n`;
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
