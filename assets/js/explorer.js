// ── State ───────────────────────────────────────────────────────────────────
let turns = [];
let turnTimes = [];   // each turn's start time in seconds
let hasTimes = false; // whether current transcript has real time values
let activeTurnIdx = -1;
let _suppressTimeupdateBeforeSeek = false; // true while waiting for a deferred seek to complete
let _pendingSeekListener = null;           // seeked listener waiting to re-affirm the initial turn
let links = [];        // annotation links for the current case
let caseSpeakers = []; // ordered speaker list for the current transcript
let activeBottomLinkText = null; // text key of the currently shown bottom link
let docViewerOpenHeight = null;  // px height for next animated open (null = use 45vh default)
let _currentAudioList = [];    // sorted audio entries for the active case
let _currentEvents    = [];    // unsorted events[] for the active case (URL `event` indexes into this)
let _currentBasePath  = '';    // base URL path for the active case
let _currentLoadedEntry = null; // the audio entry object currently loaded in loadAudioEntry
let _currentCaseEntry   = null; // the case object currently loaded
let _currentOpinionHref = null; // opinion_href for the active case (used by audio dropdown sentinel)
let _currentOyezHref    = null; // oyez URL for the active case (used by audio dropdown sentinel)
let _currentVideoEntries = []; // OTD video events for the active case [{href, title}]
let _currentTranscriptPdfUrl = null; // resolved transcript_href for the active audio entry
let _currentJournalRefs = new Map(); // sentinel value -> { href, title } for journal_ref dropdown options
let _collectionsSectionLi = null; // top-level Collections <li>
let _topicsSectionLi      = null; // top-level Topics <li>

// ── Transcript edit mode state ──────────────────────────────────────────────
let _editMode = false;
// caseKey -> { title, number?, id?, eventEdits: Map<text_href, Map<turnIdx, {turnNum,name,text?}>> }
let _transcriptEdits = new Map();
let _currentTextHref = ''; // text_href of the currently loaded transcript
let _currentCaseKey  = ''; // caseKey of the currently loaded case

const audio       = document.getElementById('audio-player');
const turnList    = document.getElementById('turn-list');
const emptyState  = document.getElementById('empty-state');
const loadingMsg  = document.getElementById('loading-msg');
const playerSection   = document.getElementById('player-section');
const audioControls   = document.getElementById('audio-controls');
const pageViewer      = document.getElementById('page-viewer');
const transcriptViewer = document.getElementById('transcript-viewer');

// ── Utilities ───────────────────────────────────────────────────────────────

// Track page views in Google Analytics for SPA navigation
function trackPageView(url) {
  if (typeof gtag === 'function') {
    const fullUrl = new URL(url, location.origin);
    gtag('config', 'G-F4VGXJWVZL', {
      'page_path': fullUrl.pathname + fullUrl.search,
      'page_title': document.title
    });
  }
}

function navigate(url) {
  history.pushState(null, '', url);
  trackPageView(url);
}

function parseTime(s) {
  const [h, m, sec] = s.split(':');
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(sec);
}

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function termDisplayName(term) {
  const entry = TERMS.find(t => t.term === term);
  if (entry?.name) return entry.name.replace(/ /g, '\u00a0');
  const [year, month] = term.split('-');
  return (MONTHS[parseInt(month, 10) - 1] || month) + '\u00a0Term\u00a0' + year;
}

function decisionTooltip(term, caseEntry, decision) {
  const parts = [];
  if (caseEntry.number) {
    const numbers = caseEntry.number.split(',').map(n => n.trim());
    const label = numbers.length > 1 ? 'Nos.' : 'No.';
    parts.push('(' + label + '\u00a0' + numbers.join(', ') + ')');
  }
  if (caseEntry.argument)   parts.push('Argued\u00a0'   + formatArgDates(caseEntry.argument));
  if (caseEntry.reargument) parts.push('Reargued\u00a0' + formatArgDates(caseEntry.reargument));
  if (decision)             parts.push('Decided\u00a0'  + formatDecisionDate(decision));
  return parts.join(';\u00a0');
}

function argumentTooltip(term, caseRef) {
  const parts = [];
  if (caseRef.number) {
    const numbers = caseRef.number.split(',').map(n => n.trim());
    const label = numbers.length > 1 ? 'Nos.' : 'No.';
    parts.push('(' + label + '\u00a0' + numbers.join(', ') + ')');
  }
  if (caseRef.argument)   parts.push('Argued\u00a0'   + formatArgDates(caseRef.argument));
  if (caseRef.reargument) parts.push('Reargued\u00a0' + formatArgDates(caseRef.reargument));
  return parts.join(';\u00a0');
}

function toTitleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function lastName(name) {
  const stripped = name.replace(/,\s*(JR\.|SR\.|[IV]+)\s*$/i, '').trim();
  return stripped.split(/\s+/).pop() || name;
}

// Mirrors makeAdvocateId() from scripts/update_advocates.js.
// Converts a full name like "ALAN E. POPKIN" → "alan_e_popkin".
function _makeAdvocateId(name) {
  const ascii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const noPunct = ascii.replace(/[^\w\s-]/g, '');
  return noPunct.replace(/[\s\-_]+/g, '_').replace(/^_+|_+$/g, '');
}

// Accepts a speaker object {name, title} (new format) or a plain name string
// (old format, derived from display names like "CHIEF JUSTICE ROBERTS").
function formatSpeaker(speaker) {
  const name  = typeof speaker === 'string' ? speaker : speaker.name;
  let title = typeof speaker === 'object' ? speaker.title : undefined;
  if (name === 'UNKNOWN JUSTICE') return 'UNKNOWN';
  if (name === 'UNKNOWN SPEAKER') return 'UNKNOWN';
  if (title !== undefined) {
    // Default empty title to "MR."
    if (!title) title = 'MR.';
    if (title === 'CHIEF JUSTICE') return 'C.J.\u00a0' + lastName(name);
    if (title === 'JUSTICE')       return 'J.\u00a0'   + lastName(name);
    // Support compound titles like "MS.,GENERAL" — use the last part for display.
    const parts = title.split(',').map(t => t.trim()).filter(Boolean);
    const last  = parts[parts.length - 1];
    if (last === 'GENERAL') return 'G.\u00a0' + lastName(name);
    return last + '\u00a0' + lastName(name);
  }
  // Old format: derive from name prefix
  if (name.startsWith('CHIEF JUSTICE ')) return 'C.J.\u00a0' + toTitleCase(name.split(' ').pop());
  if (name.startsWith('JUSTICE '))       return 'J.\u00a0'   + toTitleCase(name.split(' ').pop());
  return name.split(' ').map(toTitleCase).join(' ').replace('General ', 'Gen. ');
}

// Full name for use where abbreviations are unwanted (e.g. edit-mode dropdowns).
function formatSpeakerFull(speaker) {
  const name = typeof speaker === 'string' ? speaker : speaker.name;
  return name.split(' ').map(toTitleCase).join(' ');
}

function speakerClass(speaker) {
  const title = typeof speaker === 'object' ? speaker.title : undefined;
  const name  = typeof speaker === 'string' ? speaker : speaker.name;
  if (title === 'CHIEF JUSTICE') return 'chief-justice';
  if (title === 'JUSTICE')       return 'justice';
  if (title !== undefined)       return 'counsel';
  // Old format fallback
  if (name.startsWith('CHIEF JUSTICE')) return 'chief-justice';
  if (name.startsWith('JUSTICE'))       return 'justice';
  return 'counsel';
}

// Show the stats page when a term is opened and no other content is displayed.
// Also updates the stats page if it's already shown (switching between terms).
// Pass null when a term is collapsed (no-op; leave whatever is currently shown).
function updateEmptyStateForTerm(term) {
  if (!term) return; // term collapsed — leave current view
  showPageViewer('/courts/ussc/pages/stats/?term=' + encodeURIComponent(term), { pushState: false });
}

function audioEntryLabel(a, suffix) {
  let label;
  if (a.title) { label = a.title; }
  else {
    const dateFormatted = a.date
      ? new Date(a.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : '';
    const type = a.type || 'argument';
    if (type === 'reargument') label = 'Oral Reargument on ' + dateFormatted;
    else if (type === 'opinion') label = 'Opinion Announcement on ' + dateFormatted;
    else label = 'Oral Argument on ' + dateFormatted;
  }
  return suffix ? label + suffix : label;
}

// Seek to a time without playing (used for URL-based turn restore).
function seekOnly(time) {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    audio.currentTime = time;
  } else {
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = time; }, { once: true });
  }
}

// Seek to time and play; waits for seek to complete before calling play()
// to prevent browsers from resetting currentTime on a rejected play() call.
function seekAndPlay(time) {
  const doSeek = () => {
    audio.currentTime = time;
    audio.addEventListener('seeked', () => { audio.play().catch(() => {}); }, { once: true });
  };
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
    doSeek();
  } else {
    audio.addEventListener('loadedmetadata', doSeek, { once: true });
  }
}

// Binary search: index of last turn whose time <= t; -1 if none
function findCurrentTurn(t) {
  let lo = 0, hi = turnTimes.length - 1, result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turnTimes[mid] <= t) { result = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  return result;
}

// ── Links helpers ──────────────────────────────────────────────────────────

async function loadFiles(url) {
  try {
    const res = await fetch(url, { cache: 'reload' });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.warn('[files] fetch failed:', e);
    return [];
  }
}

// ── Lazy term loading ────────────────────────────────────────────────────────
let TERMS = [];         // flat array {name, file, cases(count), term(derived), journal_*} built from terms.json in init()
let TERMS_GROUPED = []; // decade-grouped [{name, groups:[...]}] from terms.json
let COLLECTIONS = []; // populated from collections.json in init()
let TOPICS      = []; // populated from topics.json in init()
const _termFetchPromises = new Map(); // term → inflight Promise or resolved cases[]

async function fetchTermCases(term) {
  if (_termFetchPromises.has(term)) return _termFetchPromises.get(term);
  const entry = TERMS.find(t => t.term === term);
  const casesUrl = entry ? (entry.file || entry.cases) : '/courts/ussc/terms/' + term + '/cases.json';
  const p = fetch(casesUrl, { cache: 'reload' })
    .then(r => r.ok ? r.json() : [])
    .catch(e => { console.warn('[cases] fetch failed for term', term, e); return []; });
  _termFetchPromises.set(term, p);
  const cases = await p;
  _termFetchPromises.set(term, cases);
  return cases;
}

// Called when nav search opens: loads all not-yet-built term case lists.
// ── URL param helper ─────────────────────────────────────────────────────────
// Rebuilds URLSearchParams so that 'collection' is always first, and 'group' or 'id' is second.
function buildUrlParams(updates, deletes = []) {
  const url = new URL(location.href);
  // Apply deletes first.
  deletes.forEach(k => url.searchParams.delete(k));
  // Always remove 'link' when navigating to a case/collection.
  url.searchParams.delete('link');
  // Apply updates.
  Object.entries(updates).forEach(([k, v]) => url.searchParams.set(k, v));
  // Enforce canonical parameter order: collection, group/id, highlight, term, case, event, turn, file, then rest.
  const collection = url.searchParams.get('collection');
  const group      = url.searchParams.get('group');
  const id         = url.searchParams.get('id');
  const highlight  = url.searchParams.get('highlight');
  const term       = url.searchParams.get('term');
  const caseParam  = url.searchParams.get('case');
  const event      = url.searchParams.get('event');
  const turn       = url.searchParams.get('turn');
  const file       = url.searchParams.get('file');
  const orderedKeys = ['collection', 'group', 'id', 'highlight', 'term', 'case', 'event', 'turn', 'file'];
  const rest = [...url.searchParams.entries()].filter(([k]) => !orderedKeys.includes(k));
  const reordered = [];
  if (collection != null) reordered.push(['collection', collection]);
  if (group != null) reordered.push(['group', group]);
  if (id != null) reordered.push(['id', id]);
  if (highlight != null) reordered.push(['highlight', highlight]);
  if (term != null) reordered.push(['term', term]);
  if (caseParam != null) reordered.push(['case', caseParam]);
  if (event != null) reordered.push(['event', event]);
  if (turn != null) reordered.push(['turn', turn]);
  if (file != null) reordered.push(['file', file]);
  reordered.push(...rest);
  url.search = new URLSearchParams(reordered).toString();
  return url;
}

async function loadAllTermsForSearch() {
  const termEls = document.querySelectorAll('.term-group[data-term]');
  await Promise.all([...termEls].map(el => el._ensureBuilt?.()));
  // Re-run any active query now that all cases are in the DOM.
  const navSearchInput = document.getElementById('nav-search-input');
  if (navSearchInput?.value.trim()) {
    navSearchInput.dispatchEvent(new Event('input'));
  }
}

// Normalise link.refs (string or array) to an array of strings.
function getRefs(link) {
  if (!link.refs) return [];
  return Array.isArray(link.refs) ? link.refs : [link.refs];
}

// Parse a ref string: "Text:123" → { text: "Text", page: 123 }
// "Text" (no colon+digits) → { text: "Text", page: null }
function parseRef(refStr) {
  const m = refStr.match(/^(.+?):(\d+)$/);
  return m ? { text: m[1], page: parseInt(m[2], 10) } : { text: refStr, page: null };
}

// Return the ref text strings (stripped of any :page suffix) for a link.
function getRefTexts(link) {
  return getRefs(link).map(r => parseRef(r).text);
}

// Return the page number for a matched ref text on a link, or null.
function getRefPage(link, matchedText) {
  const raw = getRefs(link).find(r => parseRef(r).text.toLowerCase() === matchedText.toLowerCase());
  return raw ? parseRef(raw).page : null;
}

// True if `needle` occurs at a word boundary inside `haystack` (both lowercase).
function matchesWholeWord(haystack, needle) {
  try {
    return new RegExp('\\b' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(haystack);
  } catch { return haystack.includes(needle); }
}

// Return all whole-word match positions of `needle` in `rawText`.
function findWholeWordMatches(rawText, needle) {
  const positions = [];
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re;
  try { re = new RegExp('\\b' + escaped + '\\b', 'gi'); }
  catch { re = new RegExp(escaped, 'gi'); }
  let m;
  while ((m = re.exec(rawText)) !== null) {
    positions.push({ start: m.index, end: m.index + m[0].length });
  }
  return positions;
}

// Render a turn's text into textEl, applying ref-mark annotations from `links`
// and optionally overlaying search marks for `searchQuery`.
// When isCurrent is true, the search match gets the 'current' highlight class.
function renderTurnText(textEl, rawText, searchQuery, isCurrent) {
  const marks = [];

  // Ref mark positions (whole-word only)
  links.forEach(link => {
    getRefTexts(link).forEach(refText => {
      findWholeWordMatches(rawText, refText).forEach(({ start, end }) => {
        marks.push({ start, end, kind: 'ref', link, refText });
      });
    });
  });

  // Search mark positions (win over refs at same start position)
  if (searchQuery) {
    const qLower = searchQuery.toLowerCase();
    const hayLower = rawText.toLowerCase();
    let i = 0;
    while (i < hayLower.length) {
      const pos = hayLower.indexOf(qLower, i);
      if (pos === -1) break;
      marks.push({ start: pos, end: pos + searchQuery.length, kind: 'search' });
      i = pos + searchQuery.length;
    }
  }

  // Sort by start; search beats ref on ties so it renders on top
  marks.sort((a, b) => a.start - b.start || (a.kind === 'search' ? -1 : 1));

  const frag = document.createDocumentFragment();
  let cursor = 0;
  marks.forEach(({ start, end, kind, link, refText }) => {
    if (start < cursor) return; // skip overlapping
    if (start > cursor) frag.appendChild(document.createTextNode(rawText.slice(cursor, start)));
    if (kind === 'ref') {
      const span = document.createElement('span');
      span.className = 'ref-mark';
      span.textContent = rawText.slice(start, end);
      span.addEventListener('click', e => {
        e.stopPropagation();
        const page = getRefPage(link, refText);
        showDocViewer(link, { autoScroll: true, matchedRef: refText, page });
      });
      frag.appendChild(span);
    } else {
      const mark = document.createElement('mark');
      mark.className = 'turn-highlight' + (isCurrent ? ' current' : '');
      mark.textContent = rawText.slice(start, end);
      frag.appendChild(mark);
    }
    cursor = end;
  });
  if (cursor < rawText.length) frag.appendChild(document.createTextNode(rawText.slice(cursor)));
  textEl.innerHTML = '';
  textEl.appendChild(frag);
}

// When a turn becomes active, show any bottom-view linked content whose
// text appears anywhere in that turn's text. Leave panel visible if no
// match — only update it when a new match is found.
function isMobile() {
  return window.innerWidth <= 768;
}

function checkLinksForActiveTurn(idx, autoScroll = false) {
  if (!links.length || idx < 0 || idx >= turns.length) return false;
  const turnText = turns[idx].text;
  const match = links.find(l => getRefTexts(l).some(r => matchesWholeWord(turnText, r)));
  if (match && match.href !== activeBottomLinkText) {
    const matchedRef = getRefTexts(match).find(r => matchesWholeWord(turnText, r)) || null;
    const page = matchedRef ? getRefPage(match, matchedRef) : null;
    showDocViewer(match, { autoScroll, matchedRef, page });
  }
  return !!match;
}

function collapseDocViewer() {
  const panel = document.getElementById('doc-viewer');
  if (panel.hidden || panel.classList.contains('collapsed')) return;
  // On mobile the open animation releases to style.height='auto'.
  // CSS can't transition from 'auto' to a pixel value, so pin it first.
  if (!panel.style.height || panel.style.height === 'auto') {
    panel.style.height = panel.offsetHeight + 'px';
    panel.offsetHeight; // commit so the next change starts a transition
  }
  docViewerOpenHeight = panel.offsetHeight;
  panel.classList.add('collapsed');
  panel.offsetHeight; // force reflow
  panel.style.height = '30px';
  panel.addEventListener('transitionend', function onCollapseEnd(e) {
    if (e.target !== panel || e.propertyName !== 'height') return;
    panel.removeEventListener('transitionend', onCollapseEnd);
    panel.style.height = '';
  });
  activeBottomLinkText = null;
}

function hideDocViewerFully() {
  const panel = document.getElementById('doc-viewer');
  if (panel.hidden) return;
  if (panel.classList.contains('collapsed')) {
    // Already at header height — just hide instantly
    panel.classList.remove('collapsed');
    panel.style.height = '';
    panel.hidden = true;
  } else {
    docViewerOpenHeight = panel.offsetHeight;
    panel.style.height = panel.offsetHeight + 'px';
    panel.offsetHeight; // force reflow
    panel.style.height = '0px';
    panel.addEventListener('transitionend', function onHideEnd(e) {
      if (e.target !== panel || e.propertyName !== 'height') return;
      panel.removeEventListener('transitionend', onHideEnd);
      panel.hidden = true;
      panel.style.height = '';
    });
  }
  activeBottomLinkText = null;
}

function expandDocViewer() {
  const panel = document.getElementById('doc-viewer');
  if (!panel.classList.contains('collapsed')) return;
  const h = docViewerOpenHeight ?? Math.round(window.innerHeight * 0.45);
  panel.style.height = '30px'; // match CSS class value so transition starts from here
  panel.classList.remove('collapsed');
  panel.offsetHeight; // force reflow
  panel.style.height = h + 'px';
}

// Smoothly scroll the transcript pane so the active turn sits at its top.
function scrollActiveTurnToTranscriptTop() {
  if (activeTurnIdx < 0) return;
  const transcriptViewer = document.getElementById('transcript-viewer');
  const turnEl = document.getElementById('turn-' + activeTurnIdx);
  if (!turnEl || !transcriptViewer) return;
  const targetScrollTop = transcriptViewer.scrollTop +
    (turnEl.getBoundingClientRect().top - transcriptViewer.getBoundingClientRect().top);
  transcriptViewer.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
}

// autoScroll: when true, scrolls the document viewer into view on mobile
// (used for explicit user clicks; omitted for auto-sync during playback).
// Convert a YouTube watch/playlist/short URL into an embeddable form suitable
// for an <iframe>. Returns the input unchanged for non-YouTube URLs (or if the
// pattern isn't recognized).
function toEmbedUrl(href) {
  if (!href) return href;
  let u;
  try { u = new URL(href, location.href); } catch { return href; }
  const host = u.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '').split('/')[0];
    if (!id) return href;
    const params = new URLSearchParams(u.search);
    params.delete('v');
    const qs = params.toString();
    return 'https://www.youtube.com/embed/' + id + (qs ? '?' + qs : '');
  }
  if (host === 'youtube.com' || host === 'm.youtube.com') {
    const params = new URLSearchParams(u.search);
    if (u.pathname === '/playlist') {
      const list = params.get('list');
      if (!list) return href;
      const out = new URLSearchParams();
      out.set('list', list);
      for (const k of ['si', 'index']) if (params.has(k)) out.set(k, params.get(k));
      return 'https://www.youtube.com/embed/videoseries?' + out.toString();
    }
    if (u.pathname === '/watch') {
      const v = params.get('v');
      if (!v) return href;
      params.delete('v');
      const qs = params.toString();
      return 'https://www.youtube.com/embed/' + v + (qs ? '?' + qs : '');
    }
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/);
    if (m) {
      params.delete('v');
      const qs = params.toString();
      return 'https://www.youtube.com/embed/' + m[1] + (qs ? '?' + qs : '');
    }
  }
  return href;
}

function showDocViewer(link, { autoScroll = false, matchedRef = null, page = null, force = false } = {}) {  const panel  = document.getElementById('doc-viewer');
  const card   = document.getElementById('doc-viewer-card');
  const pdfEl  = document.getElementById('doc-viewer-pdf');
  const isPdf  = /\.pdf(#|\?|$)/i.test(link.href);
  const inPane = isPdf || link.view === 'pane';

  // Build the effective href, appending #page=N if applicable
  const effectiveHref = (() => {
    if (page == null || link.href.includes('#')) return link.href;
    return isPdf ? link.href + '#page=' + page + '&pagemode=none'
                 : link.href + '#page=' + page;
  })();

  const refEl = document.getElementById('doc-viewer-ref');
  if (matchedRef) {
    refEl.replaceChildren(
      document.createTextNode('In reference to: '),
      Object.assign(document.createElement('strong'), { textContent: matchedRef })
    );
  } else {
    refEl.textContent = '';
  }

  const urlEl = document.getElementById('doc-viewer-url');
  const absHref = new URL(effectiveHref, location.href).href;
  urlEl.href = absHref;
  urlEl.title = absHref;
  urlEl.replaceChildren(
    Object.assign(document.createElement('img'), {
      src: '/assets/img/open-external-link-icon.webp',
      alt: 'Open in new tab',
      width: 13,
      height: 13,
    })
  );
  activeBottomLinkText = link.href || null;

  if (inPane) {
    card.style.display = 'none';
    pdfEl.style.display = 'block';
    const src = effectiveHref.includes('#') ? effectiveHref : effectiveHref + '#pagemode=none';
    if (force || pdfEl.src !== src) {
      // Browsers won't navigate an iframe when only the fragment changes (same-PDF, different page).
      // Force a real reload by going to about:blank first, then setting the real src only
      // after the blank navigation has fully committed (load event).
      if (pdfEl.src.split('#')[0] === src.split('#')[0] || force) {
        const targetSrc = src;
        pdfEl.addEventListener('load', function onBlankLoad() {
          pdfEl.removeEventListener('load', onBlankLoad);
          pdfEl.src = targetSrc;
        }, { once: true });
        pdfEl.src = 'about:blank';
      } else {
        pdfEl.src = src;
      }
    }
  } else {
    pdfEl.style.display = 'none';
    pdfEl.src = '';
    card.style.display = '';
    document.getElementById('doc-viewer-card-title').textContent = link.title || getRefTexts(link)[0] || '';
    document.getElementById('doc-viewer-card-desc').textContent = link.description || '';
    const anchor = document.getElementById('doc-viewer-card-link');
    anchor.href = effectiveHref;
  }

  if (panel.hidden) {
    panel.style.height = '0px';
    panel.hidden = false;
    panel.offsetHeight; // force reflow so transition plays
    if (isMobile()) {
      // On mobile the doc-viewer lives in #bottom-bar which is sticky at the
      // bottom. Animate from 0 to the natural content height so it slides up
      // above the audio controls without requiring the user to scroll.
      // Use scrollHeight (measures full content even while height:0) so card
      // content and PDF iframes both size themselves correctly.
      const naturalH = panel.scrollHeight;
      const maxH = Math.round(window.innerHeight * 0.50);
      const targetH = Math.min(naturalH, maxH);
      panel.style.height = targetH + 'px';
      // After the animation, release to auto height so the panel fits its
      // content rather than leaving dead space (important for card content).
      panel.addEventListener('transitionend', function onMobileOpen(e) {
        if (e.target !== panel || e.propertyName !== 'height') return;
        panel.removeEventListener('transitionend', onMobileOpen);
        panel.style.height = 'auto';
      }, { once: true });
    } else {
      const h = docViewerOpenHeight ?? Math.round(window.innerHeight * 0.45);
      panel.style.height = h + 'px';
      // When opened automatically (not by a user click), scroll the active turn
      // to the top of the transcript pane so the doc viewer doesn't obscure it.
      if (!autoScroll) requestAnimationFrame(scrollActiveTurnToTranscriptTop);
    }
  } else if (panel.classList.contains('collapsed')) {
    expandDocViewer();
    // Same scroll when un-minimized automatically during playback (desktop only).
    if (!isMobile() && !autoScroll) requestAnimationFrame(scrollActiveTurnToTranscriptTop);
  }
}

// ── Build nav ───────────────────────────────────────────────────────────────

// Populate the case list for a term — called the first time a term is expanded.
// Return the date string to use for sorting/grouping a case within a term.
// Picks the first argument/reargument audio entry whose date falls within the
// term's year window [YYYY-MM-01, (YYYY+1)-MM-01).  Falls back to audio[0].date.
// Canonical identifier for the URL 'case' param and nav data-case-key.
// Prefers 'id' (always unique) over 'number' (may collide when a docket
// number appears more than once in a term, e.g. 9-Orig in 1968-10).
// The URL restore path handles old ?case=NUMBER links via the number fallback.
function caseId(caseEntry) {
  return caseEntry.id || caseEntry.number || '';
}

// Preferred URL 'case' param for a case entry given its sibling cases.
// Uses the first docket number (split on ',') when it is unique across all
// cases in the term; falls back to caseEntry.id so the param stays stable.
function _caseUrlId(caseEntry, allCases) {
  if (caseEntry.number) {
    const firstNum = caseEntry.number.split(',')[0].trim();
    const unique = allCases.filter(c => c.number && c.number.split(',')[0].trim() === firstNum).length === 1;
    if (unique) return firstNum;
  }
  return caseEntry.id || (caseEntry.number ? caseEntry.number.split(',')[0].trim() : '');
}

// Directory name for the case on the filesystem — uses number first since
// case directories are named by docket number, not the lonedissent id.
function caseDirName(caseEntry) {
  const name = caseEntry.number || caseEntry.id || '';
  return name.split(',')[0].trim();
}

// Return the primary (display) title from a raw case title string.
// Multiple consolidated case titles may be stored as pipe-delimited values;
// only the first element is used for display.
function caseTitle(raw) {
  if (!raw) return raw;
  const idx = raw.indexOf('|');
  return idx === -1 ? raw : raw.slice(0, idx);
}

// Build the text for the case‑title label above the transcript pane.
// Priority for parenthesised annotation: docket number → usCite → nothing.
function caseTitleLabel(caseEntry) {
  let suffix = '';
  if (caseEntry.number) {
    const isMulti = /,/.test(caseEntry.number);
    const displayNumber = caseEntry.number.replace(/,\s*/g, ', ').replace(/-(?=Orig|Misc)/g, '\u00a0');
    suffix = '\u00a0(' + (isMulti ? 'Nos.' : 'No.') + '\u00a0' + displayNumber + ')';
  } else if (caseEntry.usCite) {
    suffix = '\u00a0(' + caseEntry.usCite + ')';
  }
  return caseTitle(caseEntry.title) + suffix;
}

// Set the case-title-label element to a link that reveals the case in the nav pane.
function setCaseTitleLabel(term, caseEntry) {
  const span = document.getElementById('case-title-label');
  span.innerHTML = '';
  const urlParams = new URLSearchParams({ term, case: caseId(caseEntry) });
  const a = document.createElement('a');
  a.href = '?' + urlParams.toString();
  a.className = 'case-title-link';
  a.textContent = caseTitleLabel(caseEntry);

  a.addEventListener('click', e => {
    e.preventDefault();
    const url = buildUrlParams(
      { term, case: caseId(caseEntry) },
      ['collection', 'group', 'id', 'highlight', 'event', 'file', 'link'],
    );
    navigate(url);
    restoreFromURL();
  });
  span.appendChild(a);
}

// Format an ISO date "YYYY-MM-DD" → "Month\u00a0D,\u00a0YYYY" for display.
function formatDecisionDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return (MONTHS[parseInt(m, 10) - 1] || m) + '\u00a0' + parseInt(d, 10) + ',\u00a0' + y;
}

// Show or hide the case/event notes line below the dates row.
function _setCaseNotes(text) {
  const el = document.getElementById('case-notes');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

// Populate and show/hide the argued/decided date row below the case title.
function _setCaseInfoRow2(caseEntry) {
  // When there are no audio/transcript events but a decision link is already
  // shown on the right, the decided date is redundant — omit it.
  const omitDecided = !caseEntry.events?.length && !!caseEntry.opinion_href;
  document.getElementById('case-argued').textContent =
    caseEntry.argument   ? 'Argued\u00a0'   + formatArgDates(caseEntry.argument)   : '';
  document.getElementById('case-reargued').textContent =
    caseEntry.reargument ? 'Reargued\u00a0' + formatArgDates(caseEntry.reargument) : '';
  document.getElementById('case-decided').textContent =
    !omitDecided && caseEntry.decision
      ? 'Decided\u00a0' + formatDecisionDate(caseEntry.decision)
          + (caseEntry.usCite ? '\u00a0(' + caseEntry.usCite + ')' : '')
      : '';
  document.getElementById('case-info-row2').hidden =
    !(caseEntry.argument || caseEntry.reargument || caseEntry.decision);
  _setCaseNotes(caseEntry.notes || '');
}

// Format a comma-separated list of ISO argument dates for display.
// Dates in the same month/year are collapsed to a day range: "April 1–2, 1979".
// Dates across different months are joined with "; ": "April 30, 1979; May 1, 1979".
function formatArgDates(dateStr) {
  if (!dateStr) return '';
  const dates = dateStr.split(',').map(d => d.trim()).filter(Boolean);
  // Group by year-month, preserving insertion order
  const groups = new Map(); // "YYYY-MM" -> { y, m, days[] }
  for (const iso of dates) {
    const [y, m, d] = iso.split('-');
    const key = y + '-' + m;
    if (!groups.has(key)) groups.set(key, { y, m, days: [] });
    groups.get(key).days.push(parseInt(d, 10));
  }
  const parts = [];
  for (const { y, m, days } of groups.values()) {
    const month = MONTHS[parseInt(m, 10) - 1] || m;
    days.sort((a, b) => a - b);
    const dayStr = days.length > 1
      ? days[0] + '\u2013' + days[days.length - 1]  // en-dash range
      : String(days[0]);
    parts.push(month + '\u00a0' + dayStr + ',\u00a0' + y);
  }
  return parts.join(';\u00a0');
}

function caseTermDate(caseEntry, term) {
  const [yearStr, monthStr] = term.split('-');
  const termStart = `${yearStr}-${monthStr}-01`;
  const nextYear  = String(parseInt(yearStr, 10) + 1);
  const termEnd   = `${nextYear}-${monthStr}-01`;
  const audio = caseEntry.events ?? [];
  const inTerm = audio.find(a =>
    a.type !== 'opinion' && a.date && a.date >= termStart && a.date < termEnd
  );
  return inTerm?.date ?? audio[0]?.date ?? caseEntry.decision ?? '';
}

// Returns 'missing' if the case has an oyez link but no oyez audio events at
// all, 'partial' if oyez audio is present but at least one argument/reargument
// date is not covered by an oyez audio event, or null otherwise. Used to draw
// a red/beige ring around the audio icon to flag oyez data gaps.
function oyezDeficitClass(caseEntry) {
  if (!caseEntry?.oyez) return null;
  // No argument/reargument dates → case wasn't argued; no audio is expected.
  const dates = [caseEntry.argument, caseEntry.reargument].filter(Boolean);
  if (!dates.length) return null;
  const oyezAudio = (caseEntry.events || []).filter(
    e => e.source === 'oyez' && e.audio_href &&
         (e.type === 'argument' || e.type === 'reargument'),
  );
  if (!oyezAudio.length) return 'missing';
  const missingDate = dates.some(d => !oyezAudio.some(e => e.date === d));
  return missingDate ? 'partial' : null;
}

// Returns {fraction, orange} if the case's argument/reargument dates are fully
// covered by oyez events (qualifying it for a ring around the audio icon), or
// null if not. fraction = fraction of those events that have audio_href (0–1);
// orange = true if any audio event is missing an aligned transcript.
function oyezCircleData(caseEntry) {
  const dates = [caseEntry.argument, caseEntry.reargument]
    .filter(Boolean)
    .flatMap(d => d.split(',').map(s => s.trim()));
  if (!dates.length) return null;

  const oyezEvents = (caseEntry.events || []).filter(
    e => e.source === 'oyez' && (e.type === 'argument' || e.type === 'reargument'),
  );

  // Every listed argument/reargument date must be covered by an oyez event.
  const allCovered = dates.every(d => oyezEvents.some(e => e.date === d));
  if (!allCovered) return null;

  const relevant = oyezEvents.filter(e => dates.includes(e.date));
  if (!relevant.length) return null;

  const withAudio = relevant.filter(e => e.audio_href);
  const fraction = withAudio.length / relevant.length;
  // Orange when any audio event date lacks a human-aligned transcript.
  // usscOnly = true when the orange events all have a ussc (generated) aligned
  // transcript — distinguishes "generated" from "completely missing".
  const allEvents = caseEntry.events || [];
  const orange = withAudio.some(e => {
    const humanAligned = allEvents.some(ev => ev.date === e.date && ev.aligned && ev.source !== 'ussc');
    return !humanAligned;
  });
  const usscOnly = orange && withAudio
    .filter(e => !allEvents.some(ev => ev.date === e.date && ev.aligned && ev.source !== 'ussc'))
    .every(e => allEvents.some(ev => ev.date === e.date && ev.aligned && ev.source === 'ussc'));
  return { fraction, orange, usscOnly };
}

// Returns {blue, orange, filled, hasOpinionAudio} if the case has opinion audio
// or OTD video events, else null.
// blue=true   → all opinion events titled "Opinion…" (blue ring)
// orange=true → any opinion audio event lacks an aligned transcript (orange ring)
// filled=true → case has ≥1 OTD video event (purple filled circle)
function opinionCircleData(caseEntry) {
  const opinionEvents = (caseEntry.events || []).filter(
    e => e.type === 'opinion' && e.audio_href,
  );
  const hasOtd = (caseEntry.events || []).some(e => e.source === 'otd' && e.type === 'opinion' && e.video_href);
  if (!opinionEvents.length && !hasOtd) return null;
  const hasOpinionAudio = opinionEvents.length > 0;
  const blue   = hasOpinionAudio && opinionEvents.every(e => (e.title || '').startsWith('Opinion'));
  const orange = hasOpinionAudio && opinionEvents.some(e => !e.aligned);
  return { blue, orange, filled: hasOtd, hasOpinionAudio };
}

// Builds the SVG ring icon used when oyezCircleData returns a result.
function makeAudioRingSvg(fraction, orange) {
  const size = 22, cx = 11, cy = 11, r = 9;
  const circ = 2 * Math.PI * r;
  const dash = fraction * circ;
  const color = orange ? '#E07820' : '#3778A6';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('class', 'case-decided-icon case-audio-icon case-audio-ring');

  const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  arc.setAttribute('cx', cx);
  arc.setAttribute('cy', cy);
  arc.setAttribute('r', r);
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke', color);
  arc.setAttribute('stroke-width', '1.5');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', `${dash} ${circ - dash}`);
  arc.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);

  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', cx);
  label.setAttribute('y', cy + 0.5);
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('dominant-baseline', 'middle');
  label.setAttribute('fill', 'currentColor');
  label.setAttribute('font-size', '12');
  label.textContent = '\u266b';

  svg.appendChild(arc);
  svg.appendChild(label);
  return svg;
}

// Builds the SVG ring icon used around the scales icon when opinion audio exists.
// blue=true → blue ring (all opinion events titled "Opinion…"); false → purple.

function _svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Appends scales paths to `g` (a <g> element). Drawn within a 22×22 viewBox
// centered at (11,11). Pass a CSS transform on the group to resize/reposition.
function _appendScalesPaths(g) {
  g.appendChild(_svgEl('line',   { x1: 11,   y1: 5.5,  x2: 11,   y2: 17   })); // pole
  g.appendChild(_svgEl('line',   { x1: 4,    y1: 7.5,  x2: 18,   y2: 7.5  })); // beam
  g.appendChild(_svgEl('circle', { cx: 11,   cy: 7.5,  r: 1, fill: 'currentColor', stroke: 'none' })); // knob
  g.appendChild(_svgEl('line',   { x1: 4,    y1: 7.5,  x2: 2.5,  y2: 13.5 })); // left suspension
  g.appendChild(_svgEl('line',   { x1: 4,    y1: 7.5,  x2: 5.5,  y2: 13.5 }));
  g.appendChild(_svgEl('path',   { d: 'M2.5,13.5 Q4,16 5.5,13.5' }));            // left pan
  g.appendChild(_svgEl('line',   { x1: 18,   y1: 7.5,  x2: 16.5, y2: 13.5 })); // right suspension
  g.appendChild(_svgEl('line',   { x1: 18,   y1: 7.5,  x2: 19.5, y2: 13.5 }));
  g.appendChild(_svgEl('path',   { d: 'M16.5,13.5 Q18,16 19.5,13.5' }));         // right pan
  g.appendChild(_svgEl('line',   { x1: 8.5,  y1: 17,   x2: 13.5, y2: 17   })); // base
}

// Builds a standalone scales SVG (no ring) for the "decided" indicator.
function makeScalesSvg() {
  const svg = _svgEl('svg', { width: 22, height: 22, viewBox: '0 0 22 22' });
  svg.setAttribute('class', 'case-decided-icon case-scales-icon');
  const g = _svgEl('g', { stroke: 'currentColor', 'stroke-width': '1.15', fill: 'none', 'stroke-linecap': 'round' });
  _appendScalesPaths(g);
  svg.appendChild(g);
  return svg;
}

function makeScalesRingSvg(blue, filled = false, orange = false) {
  const size = 22, cx = 11, cy = 11, r = 9;
  const color = orange ? '#E07820' : (blue ? '#3778A6' : '#9461C8');

  const svg = _svgEl('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
  svg.setAttribute('class', 'case-decided-icon case-scales-ring');
  const arc = _svgEl('circle', { cx, cy, r, fill: filled ? '#9461C8' : 'none', stroke: color, 'stroke-width': '1.5' });

  // Scale the icon to ~76% so it sits comfortably inside the ring.
  // Use white stroke when filled for contrast against the purple background.
  const g = _svgEl('g', {
    stroke: filled ? '#ffffff' : 'currentColor', 'stroke-width': '1.5', fill: 'none', 'stroke-linecap': 'round',
    transform: `translate(${cx},${cy}) scale(0.76) translate(-${cx},-${cy})`,
  });
  _appendScalesPaths(g);

  svg.appendChild(arc);
  svg.appendChild(g);
  return svg;
}

// Synchronously mark a case-item as the active selection in the nav. Provides
// immediate visual feedback before any async work (cases.json fetch, transcript
// load) happens. `loadCase` re-applies a more detailed selection later (e.g.
// matching cross-pane aliases or filtering by audio index).
function markCaseItemActive(ci) {
  document.querySelectorAll('.case-item').forEach(el => {
    if (el === ci) return;
    el.classList.remove('active');
    el.classList.remove('open');
  });
  document.querySelectorAll('.case-item.active-page').forEach(el => el.classList.remove('active-page'));
  ci.classList.add('active');
  ci.classList.add('open');
}

// ── Shared file-list helpers (used by both term and collection case builders) ──

// Copy any per-event `view` hint onto the matching file entry by href.
function _applyTranscriptViews(rawFiles, caseEntry) {
  const transcriptViewByHref = new Map();
  (caseEntry.events || []).forEach(a => {
    if (a?.transcript_href && a?.view) {
      transcriptViewByHref.set(a.transcript_href, a.view);
    }
  });
  rawFiles.forEach(f => {
    const v = f?.href ? transcriptViewByHref.get(f.href) : null;
    if (v) f.view = v;
  });
}

// For each event whose transcript_href has no corresponding file entry, inject a
// virtual transcript file at the end of rawFiles. When `argumentDates` is non-null
// (collection mode), restrict injection to events whose date is in that list.
function _injectVirtualTranscripts(rawFiles, caseEntry, argumentDates = null) {
  const existingHrefs = new Set(rawFiles.map(f => f.href).filter(Boolean));
  const audioByDate = [...(caseEntry.events || [])]
    .sort((a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0);
  audioByDate.forEach(a => {
    if (argumentDates && !a.transcript_href && a.date && !argumentDates.includes(a.date)) return;
    if (a.transcript_href && !existingHrefs.has(a.transcript_href)) {
      rawFiles.push({
        type:  'transcript',
        title: 'Transcript of ' + (a.title || ''),
        date:  a.date || '',
        href:  a.transcript_href,
        ...(a.view ? { view: a.view } : {}),
      });
      existingHrefs.add(a.transcript_href);
    }
  });
}

// Build a single <li class="file-item"> with the standard click handler.
function _makeCaseFileItem(f, caseEntry) {
  const fi = document.createElement('li');
  fi.className = 'file-item';
  if ((f.title || '').startsWith('Transcript of ')) {
    fi.classList.add('file-item-transcript');
  }
  if (f.file != null) fi.dataset.fileId = f.file;
  if (f.href)        fi.dataset.fileHref = f.href;
  fi.textContent = f.title;
  fi.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.file-item, .file-type-header').forEach(el => el.classList.remove('active'));
    fi.classList.add('active');
    {
      const fileKey = f.file != null ? String(f.file)
        : f.href ? f.href.split('/').pop() : null;
      if (fileKey) {
        // Only update the URL if this file belongs to the currently URL-encoded case.
        const ci = fi.closest('.case-item');
        const caseKey = ci?.dataset.caseKey || '';
        const slash = caseKey.indexOf('/');
        const fileTerm = slash >= 0 ? caseKey.slice(0, slash) : '';
        const fileCase = slash >= 0 ? caseKey.slice(slash + 1) : '';
        const url = new URL(location.href);
        const urlMatches = !fileTerm || !fileCase
          || (url.searchParams.get('term') === fileTerm
              && url.searchParams.get('case') === fileCase);
        if (urlMatches) {
          url.searchParams.set('file', fileKey);
          history.replaceState(null, '', url);
        }
      }
    }
    // No-audio cases have no transcript pane, so expand the doc viewer full-height.
    const savedHeight = docViewerOpenHeight;
    if (!caseEntry.events?.length) {
      docViewerOpenHeight = Math.round(window.innerHeight * 0.85);
    }
    showDocViewer(f, { autoScroll: true });
    if (!caseEntry.events?.length) {
      docViewerOpenHeight = savedHeight;
    }
  });
  return fi;
}

// Append a collapsible group <li> containing the given file items under fileUl.
function _renderFileGroup(fileUl, label, files, makeFileItem) {
  const groupLi = document.createElement('li');
  groupLi.className = 'file-type-group';

  const typeHeader = document.createElement('div');
  typeHeader.className = 'file-type-header';

  const typeLabel = document.createElement('span');
  typeLabel.className = 'file-type-label';
  typeLabel.textContent = label;

  const typeTog = document.createElement('span');
  typeTog.className = 'file-type-toggle';
  typeTog.textContent = '▶';

  typeHeader.appendChild(typeTog);
  typeHeader.appendChild(typeLabel);
  typeHeader.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.file-type-header').forEach(el => el.classList.remove('active'));
    typeHeader.classList.add('active');
    groupLi.classList.toggle('open');
  });

  const itemsUl = document.createElement('ul');
  itemsUl.className = 'file-type-items';
  files.forEach(f => itemsUl.appendChild(makeFileItem(f)));

  groupLi.appendChild(typeHeader);
  groupLi.appendChild(itemsUl);
  fileUl.appendChild(groupLi);
}

// Unified file-list builder. Handles the bits shared by both term and
// collection case panes (fetch raw files, copy per-event view hints, inject
// virtual transcript entries, then iterate the entries the categorizer
// produced). Categorization itself is caller-supplied because term and
// collection panes apply different presentation rules.
//
// opts:
//   basePath          string  — directory containing files.json
//   argumentDates     string[]|null — restrict virtual transcript injection
//                                     to events on these dates (collection only)
//   computeEntries    (rawFiles) => { entries, hideToggle? }
//                     entries: array of { kind: 'group'|'flat', label?, files }
//
// Returns { isEmpty, hideToggle }.
async function _buildCaseFileList(fileUl, caseEntry, opts) {
  const rawFiles = caseEntry.files
    ? await loadFiles(opts.basePath + 'files.json')
    : [];

  _applyTranscriptViews(rawFiles, caseEntry);
  _injectVirtualTranscripts(rawFiles, caseEntry, opts.argumentDates ?? null);

  // When opinion_href is set, drop any opinion entries from files.json (prefer opinion_href).
  // When no opinion_href, normalise files.json opinion titles to "Decision on <date>".
  if (caseEntry.opinion_href) {
    const idx = rawFiles.findIndex(f => (f.type || '').toLowerCase() === 'opinion');
    if (idx !== -1) rawFiles.splice(idx, 1);
  } else {
    rawFiles.forEach(f => {
      if ((f.type || '').toLowerCase() === 'opinion') {
        const dateStr = f.date || caseEntry.decision || '';
        f.title = (dateStr ? 'Decision\u00a0on\u00a0' + formatDecisionDate(dateStr) : 'Decision')
          + (caseEntry.usCite ? '\u00a0(' + caseEntry.usCite + ')' : '');
      }
    });
  }

  // When opinion_href is set, append a "Decision on <Date>" entry after any transcripts.
  if (caseEntry.opinion_href) {
    const title = (caseEntry.decision
      ? 'Decision\u00a0on\u00a0' + formatDecisionDate(caseEntry.decision)
      : 'Decision')
      + (caseEntry.usCite ? '\u00a0(' + caseEntry.usCite + ')' : '');
    rawFiles.push({ type: 'opinion', title, href: caseEntry.opinion_href });
  }

  const { entries, hideToggle = false } = opts.computeEntries(rawFiles);
  const makeFileItem = (f) => _makeCaseFileItem(f, caseEntry);

  entries.forEach(e => {
    if (!e.files || !e.files.length) return;
    if (e.kind === 'flat') {
      e.files.forEach(f => fileUl.appendChild(makeFileItem(f)));
    } else {
      _renderFileGroup(fileUl, e.label, e.files, makeFileItem);
    }
  });

  return {
    isEmpty: fileUl.children.length === 0,
    hideToggle,
  };
}

// Build the empty case <li> with its header row (toggle + title) and an
// empty file <ul>. Returns the wired-up DOM nodes for the caller to extend
// with icons and click handlers.
//
// opts:
//   caseKey    string  — value for ci.dataset.caseKey
//   title      string  — title text
//   tooltip    string  — title attribute on the title span
//   audioDate  string? — collection-only: argument date (YYYY-MM-DD) of this
//                       entry, used to disambiguate sibling collection items
//                       for the same case (e.g. argument vs. reargument).
//                       loadCase highlights only the sibling whose audioDate
//                       matches the currently-resolved event.
//   hasFiles   boolean — when false, the toggle (▶) is hidden by default
function _buildCaseItemShell({ caseKey, title, tooltip, audioDate, eventIdx, hasFiles, caseNumber, href }) {
  const ci = document.createElement('li');
  ci.className = 'case-item';
  ci.dataset.caseKey = caseKey;
  if (audioDate) ci.dataset.audioDate = audioDate;
  if (eventIdx != null) ci.dataset.eventIdx = String(eventIdx);
  if (caseNumber) ci.dataset.caseNumber = caseNumber;

  const header = document.createElement('div');
  header.className = 'case-header';

  const toggle = document.createElement('span');
  toggle.className = 'case-toggle';
  toggle.textContent = '▶';
  if (!hasFiles) toggle.style.display = 'none';

  const titleSpan = href ? document.createElement('a') : document.createElement('span');
  titleSpan.className = 'case-title-nav';
  titleSpan.textContent = title;
  titleSpan.title = tooltip;
  if (href) {
    titleSpan.href = href;
    // Sync guard must be registered first so it fires before any async listener,
    // reliably preventing anchor navigation while still allowing SPA handlers to run.
    titleSpan.addEventListener('click', (e) => e.preventDefault());
  }

  header.appendChild(toggle);
  header.appendChild(titleSpan);

  const fileUl = document.createElement('ul');
  fileUl.className = 'file-list';

  ci.appendChild(header);
  ci.appendChild(fileUl);

  return { ci, header, toggle, titleSpan, fileUl };
}

// Append the audio (or transcript) status icon to the header.
//   hasAudio       boolean — case has playable audio (♫ or oyez ring)
//   hasTranscript  boolean — case has printed transcript only (✏)
//   ring           {fraction, orange}? — render an oyez progress ring instead of ♫
//   deficit        'missing' | 'partial' | null — wrap icon in a colored circle
//                  to flag missing/incomplete oyez audio
function _attachAudioIcon(header, { hasAudio, hasTranscript, ring, deficit }) {
  let icon = null;
  const audioTooltip = (ring ? ring.orange : !hasTranscript)
    ? (ring?.usscOnly ? 'Argument audio available with generated transcript' : 'Argument audio available without aligned transcript')
    : 'Argument audio available';
  if (hasAudio) {
    if (ring) {
      icon = makeAudioRingSvg(ring.fraction, ring.orange);
      icon.setAttribute('title', audioTooltip);
    } else {
      icon = document.createElement('span');
      icon.className = 'case-decided-icon case-audio-icon';
      icon.textContent = '\u266b';
      icon.title = audioTooltip;
    }
  } else if (hasTranscript) {
    icon = document.createElement('span');
    icon.className = 'case-decided-icon case-transcript-icon';
    icon.textContent = '\u270f';
    icon.title = 'Printed transcript available';
  }
  if (!icon && !deficit) return null;
  if (!icon) {
    // No icon but still want a deficit marker — use an empty placeholder.
    icon = document.createElement('span');
    icon.className = 'case-decided-icon case-audio-icon';
  }
  let node = icon;
  if (deficit) {
    const wrap = document.createElement('span');
    wrap.className = `case-audio-deficit case-audio-deficit-${deficit}`;
    wrap.title = deficit === 'missing'
      ? 'No Oyez audio for this case'
      : 'Oyez audio incomplete for this case';
    wrap.appendChild(icon);
    node = wrap;
  } else if (icon?.tagName?.toLowerCase() === 'svg') {
    // Chrome doesn't show title tooltips on SVG elements; wrap in a layout-transparent HTML span.
    const tip = document.createElement('span');
    tip.title = icon.getAttribute('title') || '';
    tip.style.display = 'contents';
    tip.appendChild(icon);
    node = tip;
  }
  header.appendChild(node);
  node.dataset.audioIcon = '1';
  return node;
}

// Append the scales icon to the header. When `onClick` is supplied the icon
// is rendered active and clickable (tooltip + cursor + 'decided' class on ci);
// otherwise it is rendered as an invisible placeholder so the row layout
// stays consistent across cases with and without an opinion link.
// When `ring` is supplied (from opinionCircleData), the icon is drawn as an
// SVG with a colored circle. Returns the created icon node.
function _attachScalesIcon(ci, header, { onClick, ring = null }) {
  let icon;
  if (ring) {
    icon = makeScalesRingSvg(ring.blue, ring.filled, ring.orange);
  } else {
    icon = makeScalesSvg();
  }
  let node = icon;
  if (onClick) {
    let tooltipText;
    if (!ring) {
      tooltipText = 'Opinion issued';
    } else if (ring.filled && !ring.hasOpinionAudio) {
      tooltipText = 'Video from On The Docket';
    } else if (ring.filled) {
      const audioLabel = ring.orange ? 'Opinion audio available without aligned transcript'
        : (ring.blue ? 'Opinion audio available' : 'Opinion audio available with dissent(s)');
      tooltipText = audioLabel + '; video from On The Docket';
    } else {
      tooltipText = ring.orange ? 'Opinion audio available without aligned transcript'
        : (ring.blue ? 'Opinion audio available' : 'Opinion audio available with dissent(s)');
    }
    // Chrome doesn't show title tooltips on SVG elements; wrap in a layout-transparent HTML span.
    const tip = document.createElement('span');
    tip.title = tooltipText;
    tip.style.display = 'contents';
    tip.appendChild(icon);
    node = tip;
    icon.style.cursor = 'pointer';
    ci.classList.add('decided');
    icon.addEventListener('click', onClick);
  } else if (!ring) {
    icon.style.opacity = '0';
    icon.style.pointerEvents = 'none';
  }
  header.appendChild(node);
  return node;
}

// ── Sort modes for the term case list ────────────────────────────────────────
// modes: 'cases' (default alpha) | 'argued' | 'decided' | 'votes'

const _SORT_MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _sortModeLabel(mode, count, asc = true) {
  const arrow = asc ? '\u00a0\u2191' : '\u00a0\u2193'; // ↑ / ↓
  if (mode === 'cases') return count + '\u00a0Cases' + arrow;
  if (mode === 'argued')  return 'Argued' + arrow;
  if (mode === 'decided') return 'Decided' + arrow;
  if (mode === 'votes')   return 'Votes' + arrow;
  return '';
}

// Format a YYYY-MM-DD string as "MMM DD".
function _fmtMonthDay(dateStr, withYear = false) {
  if (!dateStr) return '';
  const parts = String(dateStr).split('-');
  const mo = parseInt(parts[1], 10) - 1;
  const dd = parseInt(parts[2], 10);
  const base = (_SORT_MONTH_ABBR[mo] || '') + '\u00a0' + dd;
  return withYear ? base + ', ' + parts[0] : base;
}

// Build (or rebuild) a term's case list under `ul` using the given sort mode.
// Does not rebuild if mode hasn't changed (idempotent).
function buildTermCasesSorted(term, cases, ul, mode, asc = true) {
  const visible = cases.filter(c => c.events?.length || c.opinion_href || c.files > 0);

  // Precompute URL ids for all cases in the term (not just visible) so the
  // uniqueness check is accurate and stable across sort modes.
  const _firstNumOf = (c) => c.number ? c.number.split(',')[0].trim() : '';
  const _numCount = new Map();
  for (const c of cases) { const n = _firstNumOf(c); if (n) _numCount.set(n, (_numCount.get(n) || 0) + 1); }
  const urlIdOf = (c) => { const n = _firstNumOf(c); return (n && _numCount.get(n) === 1) ? n : (c.id || n || ''); };

  let sorted;
  if (mode === 'argued') {
    sorted = [...visible].sort((a, b) => (a.argument || '') < (b.argument || '') ? -1 : (a.argument || '') > (b.argument || '') ? 1 : caseTitle(a.title || '').localeCompare(caseTitle(b.title || '')));
  } else if (mode === 'decided') {
    // Undecided cases (no decision date) always sort to the end regardless of direction.
    const decided   = visible.filter(c =>  c.decision);
    const undecided = visible.filter(c => !c.decision);
    decided.sort((a, b) => a.decision < b.decision ? -1 : a.decision > b.decision ? 1 : caseTitle(a.title || '').localeCompare(caseTitle(b.title || '')));
    undecided.sort((a, b) => caseTitle(a.title || '').localeCompare(caseTitle(b.title || '')));
    if (!asc) decided.reverse();
    sorted = [...decided, ...undecided];
  } else if (mode === 'votes') {
    sorted = [...visible].sort((a, b) => {
      const am = a.voteMajority ?? 0, an_ = a.voteMinority ?? 0;
      const bm = b.voteMajority ?? 0, bn_ = b.voteMinority ?? 0;
      // Sort descending by majority, then ascending minority
      if (bm !== am) return bm - am;
      if (an_ !== bn_) return an_ - bn_;
      return caseTitle(a.title || '').localeCompare(caseTitle(b.title || ''));
    });
  } else {
    sorted = [...visible].sort((a, b) => caseTitle(a.title || '').localeCompare(caseTitle(b.title || '')));
  }
  if (mode !== 'decided' && !asc) sorted.reverse();

  ul.innerHTML = '';

  sorted.forEach(caseEntry => {
    const urlId = urlIdOf(caseEntry);
    const caseKey = term + '/' + urlId;
    const basePath = '/courts/ussc/terms/' + term + '/cases/' + caseDirName(caseEntry) + '/';
    const hasAudio      = !!caseEntry.events?.some(a => a.audio_href      && a.type !== 'opinion');
    const hasTranscript = !!caseEntry.events?.some(a => a.transcript_href && a.type !== 'opinion');
    const hasOpinion    = !!caseEntry.opinion_href;

    const { ci, header, toggle, titleSpan, fileUl } = _buildCaseItemShell({
      caseKey,
      title:    caseTitle(caseEntry.title),
      tooltip:  decisionTooltip(term, caseEntry, caseEntry.decision),
      hasFiles: !!caseEntry.files,
      caseNumber: caseEntry.number || '',
      href:     buildUrlParams(
        { term, case: urlId },
        ['collection', 'group', 'id', 'highlight', 'event', 'file', 'turn'],
      ),
    });

    if (mode === 'argued' || mode === 'decided') {
      // Replace icons with a compact date label
      const dateStr = mode === 'argued' ? caseEntry.argument : caseEntry.decision;
      // argument/decision can be multi-date (comma-separated); use the first
      const firstDate = dateStr ? String(dateStr).split(',')[0].trim() : '';
      const dateLbl = document.createElement('span');
      dateLbl.className = 'case-sort-label';
      dateLbl.textContent = _fmtMonthDay(firstDate);
      header.appendChild(dateLbl);
    } else if (mode === 'votes') {
      const maj = caseEntry.voteMajority, min = caseEntry.voteMinority;
      const voteLbl = document.createElement('span');
      voteLbl.className = 'case-sort-label';
      voteLbl.textContent = (maj != null && min != null) ? maj + '\u2013' + min : '';
      header.appendChild(voteLbl);
    } else {
      // Default mode: normal icons
      _attachAudioIcon(header, {
        hasAudio, hasTranscript,
        ring: hasAudio ? oyezCircleData(caseEntry) : null,
        deficit: oyezDeficitClass(caseEntry),
      });
      if (hasOpinion || caseEntry.events?.length) {
        _attachScalesIcon(ci, header, {
          ring: opinionCircleData(caseEntry),
          onClick: hasOpinion ? (e) => {
            e.stopPropagation();
            const opinionFile = { href: caseEntry.opinion_href, title: 'Opinion in ' + caseTitle(caseEntry.title || '') };
            if (caseEntry.events?.length) {
              document.querySelectorAll('.file-item, .file-type-header').forEach(el => el.classList.remove('active'));
              showDocViewer(opinionFile, { autoScroll: true });
            } else {
              markCaseItemActive(ci);
              const url = buildUrlParams(
                { term, case: urlId },
                ['collection', 'event', 'file', 'turn'],
              );
              navigate(url);
              loadCase(term, caseEntry, 0);
            }
          } : null,
        });
      }
    }

    let filesLoaded = false;
    async function ensureFilesLoaded() {
      if (filesLoaded) return;
      filesLoaded = true;
      const { isEmpty } = await _buildCaseFileList(fileUl, caseEntry, {
        basePath,
        argumentDates: null,
        computeEntries: (rawFiles) => {
          const TYPE_LABELS = { petitioner:'Petitioner', respondent:'Respondent', amicus:'Amicus', other:'Other', reference:'References' };
          const ORDER = ['petitioner','respondent','amicus','other','reference'];
          const MERGE_AMICUS_OTHER = true;
          const groups = {};
          rawFiles.forEach(f => {
            let key = (f.type || '').toLowerCase();
            if (key === 'appellant' || key === 'appellants') key = 'petitioner';
            else if (key === 'appellee' || key === 'appellees') key = 'respondent';
            else if (key === 'brief' || key === 'briefs') key = '';
            if (!key) {
              const t = (f.title || '').toLowerCase();
              if (/\bappellants?\b|\bpetitioners?\b/.test(t)) key = 'petitioner';
              else if (/\bappellees?\b|\brespondents?\b/.test(t)) key = 'respondent';
              else if (/\bamici?\s+curiae\b|\bamicus\b|\bamici\b/.test(t)) key = 'amicus';
              else key = 'other';
            }
            if (!groups[key]) groups[key] = [];
            groups[key].push(f);
          });
          ORDER.forEach(k => {
            if (!groups[k]) return;
            if (k === 'reference') groups[k].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
            else groups[k].sort((a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0);
          });
          if (MERGE_AMICUS_OTHER && (groups.amicus?.length || groups.other?.length)) {
            groups.other = [...(groups.amicus || []), ...(groups.other || [])];
            delete groups.amicus;
          }
          const transcriptFiles = groups.transcript || [];
          delete groups.transcript;
          const opinionFiles = groups.opinion || [];
          delete groups.opinion;
          const effectiveOrder = MERGE_AMICUS_OTHER ? ORDER.filter(k => k !== 'amicus') : ORDER;
          const entries = [];
          effectiveOrder.forEach(typeKey => {
            if (!groups[typeKey]?.length) return;
            const isSoloOther = typeKey === 'other' && groups[typeKey].length === 1;
            entries.push({ kind: isSoloOther ? 'flat' : 'group', label: TYPE_LABELS[typeKey] || typeKey, files: groups[typeKey] });
          });
          if (transcriptFiles.length) entries.push({ kind: 'flat', files: transcriptFiles });
          if (opinionFiles.length) entries.push({ kind: 'flat', files: opinionFiles });
          const groupEntries = entries.filter(e => e.kind === 'group');
          if (groupEntries.length === 1) { groupEntries[0].kind = 'flat'; delete groupEntries[0].label; }
          return { entries };
        },
      });
      if (isEmpty) toggle.style.display = 'none';
    }
    ci._ensureFilesLoaded = ensureFilesLoaded;

    toggle.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (ci.classList.toggle('open')) await ensureFilesLoaded();
    });

    titleSpan.addEventListener('click', async (e) => {
      const fromRestore = !!e.fromRestore;
      const audioIdx    = Number.isInteger(e.audioIdx) ? e.audioIdx : 0;
      const fileRestore = e.fileRestore ?? null;
      if (!fromRestore && ci.classList.contains('active')) {
        if (ci.classList.toggle('open')) await ensureFilesLoaded();
        return;
      }
      markCaseItemActive(ci);
      await ensureFilesLoaded();
      if (!fromRestore) {
        const url = buildUrlParams(
          { term, case: urlId },
          ['collection', 'group', 'id', 'highlight', 'event', 'file', 'turn'],
        );
        navigate(url);
      } else {
        // Normalise the URL to use the canonical urlId (the URL may have arrived
        // via an id-based param like ?case=1959-099 instead of ?case=376).
        const url = new URL(location.href);
        if (url.searchParams.get('case') !== urlId) {
          url.searchParams.set('case', urlId);
          history.replaceState(null, '', url);
        }
      }
      loadCase(term, caseEntry, audioIdx);
      if (fileRestore != null && !caseEntry.events?.length) {
        const fileEl = findFileItem(fileRestore);
        if (fileEl) { fileEl.closest('.file-type-group')?.classList.add('open'); fileEl.click(); }
      }
    });

    ul.appendChild(ci);
  });
}

function buildTermCases(term, cases, ul) {
  buildTermCasesSorted(term, cases, ul, 'cases');
}

// Shared sort-menu builder used by both term and collection-group sort buttons.
// anchorEl  — the <button> to position the menu below
// options   — array of { mode, label }
// getState  — () => { mode, asc } for the current sort state
// onPick    — ({ mode, asc }) => void; updates state variables and refreshes the UI
function _buildSortMenu(anchorEl, options, getState, onPick) {
  document.querySelectorAll('.term-sort-menu').forEach(m => m.remove());
  const menu = document.createElement('ul');
  menu.className = 'term-sort-menu';
  const { mode: curMode, asc: curAsc } = getState();
  for (const opt of options) {
    const isActive = opt.mode === curMode;
    const item = document.createElement('li');
    item.className = 'term-sort-option' + (isActive ? ' active' : '');
    item.textContent = opt.label + (isActive ? (curAsc ? ' \u2191' : ' \u2193') : '');
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      const { mode, asc } = getState();
      onPick({ mode: opt.mode === mode ? mode : opt.mode, asc: opt.mode === mode ? !asc : true });
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top  = (rect.bottom + window.scrollY) + 'px';
  menu.style.left = (rect.left   + window.scrollX) + 'px';
  const close = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close, true); }
  };
  // Small delay so the mousedown that opened the menu doesn't immediately close it.
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

function buildNav(title = 'Terms') {
  const termListEl = document.getElementById('term-list');

  // Wrap all decade groups in a top-level collapsible section.
  const termsLi = document.createElement('li');
  termsLi.className = 'terms-group';
  termsLi.dataset.section = 'terms';
  const termsHeader = document.createElement('div');
  termsHeader.className = 'terms-header';
  const termsTog = document.createElement('span');
  termsTog.className = 'terms-toggle';
  termsTog.textContent = '▶';
  const termsLabel = document.createElement('span');
  termsLabel.className = 'terms-label';
  termsLabel.textContent = title;
  termsHeader.appendChild(termsTog);
  termsHeader.appendChild(termsLabel);
  const _navSearchBtn = document.getElementById('nav-search-btn');
  if (_navSearchBtn) { _navSearchBtn.removeAttribute('hidden'); termsHeader.appendChild(_navSearchBtn); }
  termsHeader.addEventListener('click', (e) => {
    if (termsTog.contains(e.target)) termsLi.classList.toggle('open');
    else if (!termsLi.classList.contains('open')) termsLi.classList.add('open');
  });
  termsLi.appendChild(termsHeader);
  const _navSearchRow = document.getElementById('nav-search-row');
  const termsUl = document.createElement('ul');
  termsUl.className = 'terms-list-inner';
  if (_navSearchRow) termsLi.appendChild(_navSearchRow);
  termsLi.appendChild(termsUl);
  termListEl.appendChild(termsLi);

  for (const decade of TERMS_GROUPED) {
    const decLi = document.createElement('li');
    decLi.className = 'decade-group';

    const decHeader = document.createElement('div');
    decHeader.className = 'decade-header';

    const decTog = document.createElement('span');
    decTog.className = 'decade-toggle';
    decTog.textContent = '▶';

    const decLabel = document.createElement('span');
    decLabel.className = 'decade-label';
    decLabel.textContent = decade.name;

    decHeader.appendChild(decTog);
    decHeader.appendChild(decLabel);
    decHeader.addEventListener('click', (e) => {
      if (decTog.contains(e.target)) {
        decLi.classList.toggle('open');
      } else if (!decLi.classList.contains('open')) {
        decLi.classList.add('open');
      } else {
        return;
      }
      if (decLi.classList.contains('open')) {
        // Prefetch case counts for all terms in this decade, newest first.
        (async () => {
          const termEls = [...decUl.querySelectorAll('.term-group[data-term]')];
          for (const el of termEls) {
            await el._ensureCount?.();
          }
        })();
      }
    });
    decLi.appendChild(decHeader);

    const decUl = document.createElement('ul');
    decUl.className = 'term-list-inner';

    for (const page of decade.groups || []) {
      // Derive the term identifier from the cases URL.
      const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
      const term = m ? m[1] : (page.file || page.cases);

      const termLi = document.createElement('li');
      termLi.className = 'term-group';
      termLi.dataset.term = term;

      const termHeader = document.createElement('div');
      termHeader.className = 'term-header';

      const termTog = document.createElement('span');
      termTog.className = 'term-toggle';
      termTog.textContent = '▶';

      const label = document.createElement('span');
      label.className = 'term-label';
      label.textContent = page.name;

      termHeader.appendChild(termTog);
      termHeader.appendChild(label);

      const termCount = document.createElement('button');
      termCount.className = 'term-case-count';
      termCount.type = 'button';
      if (typeof page.cases === 'number') {
        termCount.textContent = page.cases + '\u00a0Cases';
      }
      termHeader.appendChild(termCount);

      termLi.appendChild(termHeader);

      const ul = document.createElement('ul');
      ul.className = 'case-list';

      // Current sort mode for this term's case list.
      // The "current term" is YYYY-10 where YYYY = this year if month >= Oct, else last year.
      const _now = new Date();
      const _currentTerm = (_now.getMonth() >= 9 ? _now.getFullYear() : _now.getFullYear() - 1) + '-10';
      const _isCurrentTerm = term === _currentTerm;
      let _sortMode = _isCurrentTerm ? 'decided' : 'cases';
      let _sortAsc  = !_isCurrentTerm;
      let _casesCache = null; // cached after first fetch

      const _SORT_OPTIONS = [
        { mode: 'cases',   label: 'Cases'   },
        { mode: 'argued',  label: 'Argued'  },
        { mode: 'decided', label: 'Decided' },
        { mode: 'votes',   label: 'Votes'   },
      ];

      // Show/hide a small sort dropdown anchored to termCount.
      function _showSortMenu() {
        _buildSortMenu(
          termCount,
          _SORT_OPTIONS,
          () => ({ mode: _sortMode, asc: _sortAsc }),
          ({ mode, asc }) => {
            _sortMode = mode;
            _sortAsc  = asc;
            const visible = _casesCache ? _casesCache.filter(c => c.events?.length || c.opinion_href || c.files > 0) : null;
            const count = visible ? visible.length : null;
            termCount.textContent = _sortModeLabel(_sortMode, count, _sortAsc);
            termCount.classList.add('sort-active');
            if (_casesCache && termLi.classList.contains('open')) {
              const activeKey = document.querySelector('.case-item.active')?.dataset?.caseKey ?? null;
              buildTermCasesSorted(term, _casesCache, ul, _sortMode, _sortAsc);
              if (activeKey) {
                const reactivated = ul.querySelector(`.case-item[data-case-key="${CSS.escape(activeKey)}"]`);
                if (reactivated) {
                  markCaseItemActive(reactivated);
                  reactivated._ensureFilesLoaded?.();
                }
              }
            }
          },
        );
      }

      // Clicking the sort button opens the menu; stop propagation so the
      // term header's expand/collapse click doesn't also fire.
      termCount.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_casesCache === null || !termLi.classList.contains('open')) return;
        _showSortMenu();
      });

      let built = false;
      const ensureBuilt = async () => {
        if (built) return;
        built = true;
        const cases = await fetchTermCases(term);
        _casesCache = cases;
        buildTermCasesSorted(term, cases, ul, _sortMode, _sortAsc);
        const visible = cases.filter(c => c.events?.length || c.opinion_href || c.files > 0);
        termCount.textContent = _sortModeLabel(_sortMode, visible.length, _sortAsc);
      };
      // Fetch count only (no DOM build) — used when expanding the decade.
      const ensureCount = async () => {
        if (termCount.textContent) return; // already populated
        const cases = await fetchTermCases(term);
        _casesCache = cases;
        const visible = cases.filter(c => c.events?.length || c.opinion_href || c.files > 0);
        termCount.textContent = visible.length + '\u00a0Cases';
      };
      termLi._ensureBuilt = ensureBuilt;
      termLi._ensureCount = ensureCount;
      termLi._showSortLabel = () => {
        if (!_casesCache) return;
        const visible = _casesCache.filter(c => c.events?.length || c.opinion_href || c.files > 0);
        termCount.textContent = _sortModeLabel(_sortMode, visible.length, _sortAsc);
        termCount.classList.add('sort-active');
      };

      termHeader.addEventListener('click', async (e) => {
        if (termTog.contains(e.target)) {
          if (!termLi.classList.toggle('open')) {
            termCount.classList.remove('sort-active');
            // Reset to plain count label when collapsed
            if (_casesCache) {
              const visible = _casesCache.filter(c => c.events?.length || c.opinion_href || c.files > 0);
              termCount.textContent = visible.length + '\u00a0Cases';
            }
            updateEmptyStateForTerm(null);
            // Term collapsed — remove term param too.
            const url = buildUrlParams({}, ['collection', 'group', 'id', 'highlight', 'term', 'case', 'event', 'file', 'turn']);
            navigate(url);
            document.getElementById('topbar-term').textContent = '';
            return;
          }
        } else if (termLi.classList.contains('open')) {
          // Already open — still show stats and reset URL to term-only.
          updateEmptyStateForTerm(term);
          document.getElementById('topbar-term').textContent = termDisplayName(term);
          const url = buildUrlParams({ term }, ['collection', 'group', 'id', 'highlight', 'case', 'event', 'file', 'turn']);
          navigate(url);
          return;
        } else {
          termLi.classList.add('open');
        }
        await ensureBuilt();
        termCount.classList.add('sort-active');
        if (_casesCache) {
          const visible = _casesCache.filter(c => c.events?.length || c.opinion_href || c.files > 0);
          termCount.textContent = _sortModeLabel(_sortMode, visible.length, _sortAsc);
        }
        updateEmptyStateForTerm(term);
        document.getElementById('topbar-term').textContent = termDisplayName(term);
        // Update URL: set term param, clear case/audio/file/turn params.
        const url = buildUrlParams({ term }, ['collection', 'group', 'id', 'highlight', 'case', 'event', 'file', 'turn']);
        navigate(url);
      });

      termLi.appendChild(ul);
      decUl.appendChild(termLi);
    }

    decLi.appendChild(decUl);
    termsUl.appendChild(decLi);
  }
}

// ── Collections nav ──────────────────────────────────────────────────────────

function _findCollectionEntry(entries, collId) {
  for (const c of entries) {
    if (Array.isArray(c.collections)) {
      const found = _findCollectionEntry(c.collections, collId);
      if (found) return found;
    } else {
      const fileUrl = c.file ?? c.collection;
      if (fileUrl && fileUrl.split('/').pop().replace('.json', '') === collId) return c;
    }
  }
  return null;
}

function buildCollectionsNav(title = 'Collections', data = COLLECTIONS) {
  if (!data || !data.length) return null;

  const termListEl = document.getElementById('term-list');

  // Top-level section — styled like the Terms group
  const sectionLi = document.createElement('li');
  sectionLi.className = 'terms-group';

  const sectionHeader = document.createElement('div');
  sectionHeader.className = 'terms-header';

  const sectionTog = document.createElement('span');
  sectionTog.className = 'terms-toggle';
  sectionTog.textContent = '▶';

  const sectionLabel = document.createElement('span');
  sectionLabel.className = 'terms-label';
  sectionLabel.textContent = title;

  sectionHeader.appendChild(sectionTog);
  sectionHeader.appendChild(sectionLabel);

  const sectionUl = document.createElement('ul');
  sectionUl.className = 'terms-list-inner';

  let _sectionBuilt = false;
  function _doSectionBuild() {
    if (_sectionBuilt) return;
    _sectionBuilt = true;
    for (const collEntry of data) {
      if (collEntry.hidden) continue;
      buildCollectionItem(sectionUl, collEntry);
    }
  }
  sectionLi._ensureBuilt = () => _doSectionBuild();

  sectionHeader.addEventListener('click', (e) => {
    if (sectionTog.contains(e.target)) sectionLi.classList.toggle('open');
    else if (!sectionLi.classList.contains('open')) sectionLi.classList.add('open');
    if (sectionLi.classList.contains('open')) {
      sectionLi._ensureBuilt();
    }
  });

  sectionLi.appendChild(sectionHeader);
  sectionLi.appendChild(sectionUl);
  termListEl.appendChild(sectionLi);
  return sectionLi;
}

// ── Nav from index.json ───────────────────────────────────────────────────────

function buildNavFromIndex(navData) {
  const termListEl = document.getElementById('term-list');
  termListEl.innerHTML = '';
  for (const entry of navData) {
    if (entry.hidden) continue;
    if (entry.file) {
      if (entry.file.endsWith('terms.json')) buildNav(entry.name || 'Terms');
      else if (entry.file.endsWith('collections.json')) _collectionsSectionLi = buildCollectionsNav(entry.name || 'Collections', COLLECTIONS);
      else if (entry.file.endsWith('topics.json')) _topicsSectionLi = buildCollectionsNav(entry.name || 'Topics', TOPICS);
    } else if (entry.groups) {
      buildStaticNavSection(termListEl, entry);
    }
  }
}

function buildStaticNavSection(termListEl, entry) {
  const sectionLi = document.createElement('li');
  sectionLi.className = 'terms-group';

  const header = document.createElement('div');
  header.className = 'terms-header';

  const tog = document.createElement('span');
  tog.className = 'terms-toggle';
  tog.textContent = '▶';

  const label = document.createElement('span');
  label.className = 'terms-label';
  label.textContent = entry.name;

  header.appendChild(tog);
  header.appendChild(label);
  header.addEventListener('click', (e) => {
    if (tog.contains(e.target)) sectionLi.classList.toggle('open');
    else if (!sectionLi.classList.contains('open')) sectionLi.classList.add('open');
  });

  const ul = document.createElement('ul');
  ul.className = 'terms-list-inner';

  for (const page of entry.groups || []) {
    if (page.hidden) continue;
    buildStaticPageItem(ul, page);
  }

  sectionLi.appendChild(header);
  sectionLi.appendChild(ul);
  termListEl.appendChild(sectionLi);
}

function buildStaticPageItem(parentUl, page) {
  if (page.hidden) return;
  const li = document.createElement('li');
  const hasSubPages = Array.isArray(page.groups) && page.groups.length > 0;

  if (hasSubPages) {
    li.className = 'term-group';
    if (page.link) li.dataset.link = page.link;

    const header = document.createElement('div');
    header.className = 'term-header';

    const tog = document.createElement('span');
    tog.className = 'term-toggle';
    tog.textContent = '▶';

    let label;
    if (page.link) {
      label = document.createElement('a');
      label.className = 'term-label';
      label.textContent = page.name;
      label.style.cursor = 'pointer';
      const _lu = new URL(location.href);
      _lu.search = '';
      _lu.searchParams.set('link', page.link);
      _lu.search = _lu.search.replace(/%2F/gi, '/');
      label.href = _lu.toString();
    } else {
      label = document.createElement('span');
      label.className = 'term-label';
      label.textContent = page.name;
    }

    header.appendChild(tog);
    header.appendChild(label);
    // Single handler: clicking the label always opens + loads; clicking the toggle toggles.
    // stopPropagation prevents the click from bubbling up to a parent terms-header.
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      if (page.link && label.contains(e.target)) {
        e.preventDefault(); // prevent anchor navigation; SPA handler manages routing
        li.classList.add('open');
        showPageViewer(page.link);
      } else if (tog.contains(e.target)) {
        li.classList.toggle('open');
      } else if (!li.classList.contains('open')) {
        li.classList.add('open');
      }
    });

    const ul = document.createElement('ul');
    ul.className = 'case-list';
    for (const subPage of page.groups) {
      buildStaticPageItem(ul, subPage);
    }

    li.appendChild(header);
    li.appendChild(ul);
  } else {
    li.className = 'case-item';
    if (page.link) li.dataset.link = page.link;

    const header = document.createElement('div');
    header.className = 'case-header';

    let titleSpan;
    if (page.link) {
      titleSpan = document.createElement('a');
      titleSpan.className = 'case-title-nav';
      titleSpan.textContent = page.name;
      titleSpan.style.cursor = 'pointer';
      const _pu = new URL(location.href);
      _pu.search = '';
      _pu.searchParams.set('link', page.link);
      _pu.search = _pu.search.replace(/%2F/gi, '/');
      titleSpan.href = _pu.toString();
      titleSpan.addEventListener('click', (e) => { e.preventDefault(); showPageViewer(page.link); });
    } else {
      titleSpan = document.createElement('span');
      titleSpan.className = 'case-title-nav';
      titleSpan.textContent = page.name;
    }

    header.appendChild(titleSpan);
    li.appendChild(header);
  }

  parentUl.appendChild(li);
}

// Show an advocate's document (details.document) in the doc-viewer, optionally
// alongside a link page in the page-viewer above it.
// documentUrl  — the PDF/iframe URL (details.document)
// linkUrl      — if set, show this in the page-viewer above; if null, doc-viewer
//                expands to fill the whole right pane (no-audio CSS trick).
function showAdvocateDocument(documentUrl, linkUrl, groupName) {
  playerSection.hidden = true;
  audioControls.hidden = true;
  document.querySelectorAll('.case-item.active').forEach(el => el.classList.remove('active', 'open'));
  document.querySelectorAll('.case-item.active-page').forEach(el => el.classList.remove('active-page'));

  if (linkUrl) {
    // Show link page in top half, document in doc-viewer below.
    transcriptViewer.hidden = true;
    pageViewer.hidden = false;
    const pf = document.getElementById('page-viewer-frame');
    if (pf.src !== new URL(linkUrl, location.href).href) pf.src = linkUrl;
    transcriptViewer.classList.remove('no-audio');
  } else {
    // Document only: hide page-viewer, use no-audio trick so doc-viewer fills right pane.
    transcriptViewer.hidden = false;
    transcriptViewer.classList.add('no-audio');
    pageViewer.hidden = true;
    document.getElementById('page-viewer-frame').src = '';
  }

  showDocViewer({ href: documentUrl, title: groupName || '', view: 'pane' }, { autoScroll: false });
}

// Reset the view to its initial state: collapse all terms/collections, clear
// the main panel, show the home page, and reset the URL to the base path.
function resetToHome() {
  // Collapse all open terms, decades, and collections in the nav tree.
  document.querySelectorAll('#term-list .open').forEach(el => el.classList.remove('open'));
  // Clear all active case selections.
  document.querySelectorAll('.case-item.active').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.case-item.active-page').forEach(el => el.classList.remove('active-page'));
  // Clear the topbar term label.
  document.getElementById('topbar-term').textContent = '';
  // Show the home page in the page viewer (right pane).
  showPageViewer('/courts/ussc/pages/home', { pushState: false });
  // Reset the URL to the base path without any query parameters.
  navigate(location.pathname);
  // Close mobile nav if open.
  if (isMobile()) setMobileNavVisible(false);
}

function showPageViewer(url, { pushState = true } = {}) {
  playerSection.hidden = true;
  audioControls.hidden = true;
  transcriptViewer.hidden = true;
  // Force-close doc-viewer immediately (no animation needed).
  const docPanel = document.getElementById('doc-viewer');
  docPanel.classList.remove('collapsed');
  docPanel.style.height = '';
  docPanel.hidden = true;
  pageViewer.hidden = false;
  const pf = document.getElementById('page-viewer-frame');
  if (pf.src !== new URL(url, location.href).href) pf.src = url;
  // Mark the corresponding nav item active.
  document.querySelectorAll('.case-item.active').forEach(el => el.classList.remove('active', 'open'));
  document.querySelectorAll('.case-item.active-page').forEach(el => el.classList.remove('active-page'));
  const navItem = document.querySelector(`.case-item[data-link="${CSS.escape(url)}"]`);
  if (navItem) navItem.classList.add('active-page');
  // Push ?link= URL, clearing all other params.
  // Replace %2F back to / so the URL stays readable (slashes are valid in query values).
  if (pushState) {
    const newUrl = new URL(location.href);
    newUrl.search = '';
    newUrl.searchParams.set('link', url);
    newUrl.search = newUrl.search.replace(/%2F/gi, '/');
    navigate(newUrl);
  }
  if (isMobile()) setMobileNavVisible(false);
}

function buildCollectionItem(sectionUl, collEntry) {
  // Group entry: contains sub-collections with no data file of their own.
  if (Array.isArray(collEntry.collections)) {
    const groupLi = document.createElement('li');
    groupLi.className = 'term-group';
    const groupHeader = document.createElement('div');
    groupHeader.className = 'term-header';
    const groupTog = document.createElement('span');
    groupTog.className = 'term-toggle';
    groupTog.textContent = '▶';
    const groupLabel = document.createElement('span');
    groupLabel.className = 'term-label';
    groupLabel.textContent = collEntry.name;
    groupHeader.appendChild(groupTog);
    groupHeader.appendChild(groupLabel);
    const groupUl = document.createElement('ul');
    groupUl.className = 'case-list';
    for (const child of collEntry.collections) {
      if (child.hidden) continue;
      buildCollectionItem(groupUl, child);
    }
    groupHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      if (groupTog.contains(e.target)) groupLi.classList.toggle('open');
      else if (!groupLi.classList.contains('open')) groupLi.classList.add('open');
    });
    groupLi.appendChild(groupHeader);
    groupLi.appendChild(groupUl);
    sectionUl.appendChild(groupLi);
    return;
  }

  // Leaf entry: has a data file ('file' key; 'collection' supported for backward compat)
  const fileUrl = collEntry.file ?? collEntry.collection;
  const collId = fileUrl.split('/').pop().replace('.json', '');
  const collLi = document.createElement('li');
  collLi.className = 'term-group';
  collLi.dataset.collectionUrl = fileUrl;

  const collHeader = document.createElement('div');
  collHeader.className = 'term-header';

  const collTog = document.createElement('span');
  collTog.className = 'term-toggle';
  collTog.textContent = '▶';

  const collLabel = document.createElement('span');
  collLabel.className = 'term-label';
  collLabel.textContent = collEntry.name;

  collHeader.appendChild(collTog);
  collHeader.appendChild(collLabel);
  if (collEntry.link) {
    collLabel.style.cursor = 'pointer';
    collLi.dataset.link = collEntry.link;
  }

  const collUl = document.createElement('ul');
  collUl.className = 'case-list';

  // Fetch and render groups only the first time this collection is expanded.
  let _fetchPromise = null;
  async function _ensureCollectionBuilt() {
    if (_fetchPromise) return _fetchPromise;
    _fetchPromise = (async () => {
      try {
        const res = await fetch(fileUrl, { cache: 'reload' });
        if (!res.ok) return;
        let groups = await res.json();
        // Detect split-advocate format: {id, name, cases: <number>} (no embedded cases array).
        // Embedded format has cases as an array; split format has cases as a number count.
        const isSplitFormat = groups.length > 0 && groups[0].id !== undefined
          && typeof groups[0].cases === 'number';
        if (collEntry.sort) {
          const sortKeys = collEntry.sort.split(',').map(spec => {
            const [keyPath, order] = spec.trim().split(':');
            // For split format, 'cases.length' maps to the pre-computed numeric 'cases' field.
            const resolved = (isSplitFormat && keyPath.trim() === 'cases.length') ? 'cases' : keyPath.trim();
            return { keyPath: resolved, descending: order === 'descending' };
          });
          const getVal = (obj, keyPath) => keyPath.split('.').reduce((v, k) => (v != null ? v[k] : undefined), obj);
          // Keys like "cases[].argument" sort the nested cases array on each group.
          // Skip for split format (cases are not yet loaded).
          const groupKeys = sortKeys.filter(k => !k.keyPath.startsWith('cases[].'));
          const caseKeys  = isSplitFormat ? [] : sortKeys.filter(k => k.keyPath.startsWith('cases[].'));
          if (caseKeys.length) {
            const caseGetVal = (obj, keyPath) => getVal(obj, keyPath.slice('cases[].'.length));
            for (const group of groups) {
              if (Array.isArray(group.cases)) {
                group.cases = [...group.cases].sort((a, b) => {
                  for (const { keyPath, descending } of caseKeys) {
                    const av = caseGetVal(a, keyPath), bv = caseGetVal(b, keyPath);
                    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                    if (cmp !== 0) return descending ? -cmp : cmp;
                  }
                  return 0;
                });
              }
            }
          }
          if (groupKeys.length) {
            groups = [...groups].sort((a, b) => {
              for (const { keyPath, descending } of groupKeys) {
                const av = getVal(a, keyPath), bv = getVal(b, keyPath);
                const cmp = av < bv ? -1 : av > bv ? 1 : 0;
                if (cmp !== 0) return descending ? -cmp : cmp;
              }
              return 0;
            });
          }
        }
        _populateCollectionGroups(collUl, groups, collEntry, collId);
      } catch (e) {
        console.warn('[collections] fetch failed:', fileUrl, e);
      }
    })();
    return _fetchPromise;
  }

  collLi._ensureBuilt = _ensureCollectionBuilt;

  let _onCollClose = null;

  collHeader.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (collTog.contains(e.target)) {
      // Toggle click: can open or close.
      collLi.classList.toggle('open');
      if (!collLi.classList.contains('open')) {
        _onCollClose?.();
        const url = buildUrlParams({}, ['collection', 'term', 'case', 'event', 'file', 'turn', 'group', 'id', 'highlight']);
        navigate(url);
        return;
      }
    } else if (!collLi.classList.contains('open')) {
      collLi.classList.add('open');
    }
    // Open (or already open): build, navigate, show page.
    await _ensureCollectionBuilt();
    if (collEntry.link) showPageViewer(collEntry.link, { pushState: false });
    const url = buildUrlParams({ collection: collId }, ['term', 'case', 'event', 'file', 'turn', 'group', 'id', 'highlight', 'link']);
    navigate(url);
  });

  // ── Collection inline search ─────────────────────────────────────────────
  let _collSearchRow = null;
  if (collEntry.search) {
    const _collSearchBtn = document.createElement('button');
    _collSearchBtn.type = 'button';
    _collSearchBtn.className = 'coll-search-btn';
    _collSearchBtn.textContent = '\u{1F50D}';
    _collSearchBtn.title = 'Search ' + collEntry.name;
    _collSearchBtn.setAttribute('aria-label', 'Search ' + collEntry.name);
    collHeader.appendChild(_collSearchBtn);

    _collSearchRow = document.createElement('div');
    _collSearchRow.className = 'coll-search-row';
    _collSearchRow.hidden = true;
    _collSearchRow.addEventListener('click', e => e.stopPropagation());

    const _collSearchInput = document.createElement('input');
    _collSearchInput.type = 'search';
    _collSearchInput.className = 'coll-search-input';
    _collSearchInput.placeholder = 'Search\u2026';
    _collSearchInput.setAttribute('autocomplete', 'off');
    _collSearchInput.setAttribute('spellcheck', 'false');

    const _collSearchClear = document.createElement('button');
    _collSearchClear.type = 'button';
    _collSearchClear.className = 'coll-search-clear';
    _collSearchClear.textContent = '\u00d7';
    _collSearchClear.title = 'Close search';
    _collSearchClear.setAttribute('aria-label', 'Close search');

    _collSearchRow.appendChild(_collSearchInput);
    _collSearchRow.appendChild(_collSearchClear);

    const _searchIsCompound = collEntry.search && collEntry.search.includes(':');

    function _runCollSearch(q) {
      const _groups = collUl.querySelectorAll('.month-group');
      if (!q) {
        // Collapse all groups and restore all items — clean slate.
        _groups.forEach(g => {
          g.style.display = '';
          g.classList.remove('open');
          if (_searchIsCompound) g.querySelectorAll('.case-item').forEach(ci => { ci.style.display = ''; });
        });
        return;
      }
      const _ql = q.toLowerCase();
      if (_searchIsCompound) {
        // Filter individual case items within each group; show the group only if any matched.
        _groups.forEach(g => {
          let anyMatch = false;
          g.querySelectorAll('.case-item').forEach(ci => {
            const text = (ci.querySelector('.case-title-nav')?.textContent || '').toLowerCase();
            const matches = text.includes(_ql);
            ci.style.display = matches ? '' : 'none';
            if (matches) anyMatch = true;
          });
          g.style.display = anyMatch ? '' : 'none';
          if (anyMatch) g.classList.add('open');
        });
      } else {
        // Filter at the group level using the precomputed search text.
        _groups.forEach(g => {
          const _matches = (g.dataset.searchText || '').includes(_ql);
          g.style.display = _matches ? '' : 'none';
          if (_matches) g.classList.add('open');
        });
      }
    }

    function _closeCollSearch() {
      _collSearchRow.hidden = true;
      _collSearchBtn.classList.remove('active');
      _collSearchInput.value = '';
      _runCollSearch('');
    }
    _onCollClose = _closeCollSearch;

    _collSearchBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!_collSearchRow.hidden) { _closeCollSearch(); return; }
      _collSearchRow.hidden = false;
      _collSearchBtn.classList.add('active');
      if (!collLi.classList.contains('open')) collLi.classList.add('open');
      await _ensureCollectionBuilt();
      _runCollSearch('');
      _collSearchInput.focus();
    });

    _collSearchClear.addEventListener('click', (e) => {
      e.stopPropagation();
      _closeCollSearch();
    });

    _collSearchInput.addEventListener('input', async () => {
      const q = _collSearchInput.value;
      if (_searchIsCompound && q) {
        const _propName = collEntry.search.slice(collEntry.search.indexOf(':') + 1);
        const _ql = q.toLowerCase();
        // For each unbuilt group, pre-check raw embedded data; only build DOM for groups
        // that have at least one matching case. Split-format groups (no _rawCases) are
        // skipped here — they have no case items in DOM so _runCollSearch hides them.
        await Promise.all(Array.from(collUl.querySelectorAll('.month-group')).map(async g => {
          if (g.querySelector('.case-item')) return; // already built
          const rawCases = g._rawCases;
          if (!rawCases) return; // split format — skip
          if (rawCases.some(c => String(c[_propName] || '').toLowerCase().includes(_ql))) {
            await g._ensureCases?.();
          }
        }));
      }
      _runCollSearch(q);
    });

    _collSearchInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') _closeCollSearch();
    });
  }

  collLi.appendChild(collHeader);
  if (_collSearchRow) collLi.appendChild(_collSearchRow);
  collLi.appendChild(collUl);
  sectionUl.appendChild(collLi);
}

function _buildHighlightItem(highlight, highlightIdx, href = null) {
  const ci = document.createElement('li');
  ci.className = 'case-item highlight-item';
  ci.dataset.highlightIdx = String(highlightIdx);

  const header = document.createElement('div');
  header.className = 'case-header';

  const titleSpan = href ? document.createElement('a') : document.createElement('span');
  titleSpan.className = 'case-title-nav';
  titleSpan.textContent = highlight.title;
  if (highlight.date) titleSpan.title = highlight.date;
  if (href) {
    titleSpan.href = href;
    titleSpan.addEventListener('click', (e) => e.preventDefault()); // sync guard
  }
  header.appendChild(titleSpan);

  // Star icon to distinguish highlights from normal cases
  const starIcon = document.createElement('span');
  starIcon.className = 'case-decided-icon case-highlight-icon';
  starIcon.textContent = '\u2605';
  starIcon.title = 'Highlight';
  header.appendChild(starIcon);

  titleSpan.addEventListener('click', async (e) => {
    const fromRestore = !!e.fromRestore;
    document.querySelectorAll('.case-item').forEach(el => el.classList.remove('active'));
    ci.classList.add('active');
    if (!fromRestore) {
      const groupLi = ci.closest('.month-group');
      const collLi  = ci.closest('.term-group[data-collection-url]');
      const collId  = collLi?.dataset.collectionUrl?.split('/').pop().replace('.json', '');
      const groupId = groupLi?.dataset.groupId ?? null;
      const groupIdx = groupLi?.dataset.groupIdx ?? null;
      const groupOrId = groupId != null ? { id: groupId } : (groupIdx != null ? { group: groupIdx } : {});
      const deleteOther = groupId != null ? ['group'] : ['id'];
      const url = buildUrlParams(
        { ...(collId ? { collection: collId } : {}), ...groupOrId, highlight: highlightIdx + 1 },
        [...deleteOther, 'term', 'case', 'event', 'file', 'turn'],
      );
      navigate(url);
    }
    await loadHighlight(highlight);
  });

  ci.appendChild(header);
  return ci;
}

async function loadHighlight(highlight) {
  // Reset UI to a minimal "case" view
  document.getElementById('transcript-viewer').classList.remove('no-audio', 'no-transcript');
  document.getElementById('transcript-viewer').classList.add('no-transcript');
  document.getElementById('audio-select').hidden = true;
  const decisionLabel = document.getElementById('decision-date-label');
  if (highlight.date) {
    decisionLabel.textContent = new Date(highlight.date + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
    decisionLabel.removeAttribute('href');
    decisionLabel.removeAttribute('target');
    decisionLabel.removeAttribute('rel');
    decisionLabel.hidden = false;
  } else {
    decisionLabel.hidden = true;
  }
  document.getElementById('case-questions').hidden = true;
  document.getElementById('case-questions').textContent = '';
  document.getElementById('case-questions').title = '';
  document.getElementById('case-info-row2').hidden = true;

  // Set title (plain text — no term link needed)
  const span = document.getElementById('case-title-label');
  span.innerHTML = '';
  const titleText = document.createElement('span');
  titleText.className = 'case-title-link';
  titleText.textContent = highlight.title;
  span.appendChild(titleText);

  document.title = highlight.title + ' | Argument Aloud';
  document.getElementById('topbar-term').textContent = '';

  playerSection.hidden = true;
  audioControls.hidden = true;
  emptyState.style.display = 'none';
  pageViewer.hidden = true;
  transcriptViewer.hidden = false;
  activeTurnIdx = -1;

  // Build a synthetic audio entry reusing loadAudioEntry machinery.
  // Set text_href if the highlight has one; set noTranscriptProbe to suppress
  // the automatic oyez fallback fetch when there is no designated transcript.
  const syntheticArg = {
    audio_href: highlight.audio_href,
    date: highlight.date || null,
    ...(highlight.text_href ? { text_href: highlight.text_href } : { noTranscriptProbe: true }),
  };

  playerSection.hidden = false;
  audioControls.hidden = false;

  _currentAudioList = [syntheticArg];
  _currentBasePath  = '/';
  _currentOpinionHref = null;

  await loadAudioEntry(syntheticArg, '/');

  if (isMobile()) {
    playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
    setMobileNavVisible(false);
  }
}

function _buildCollectionCaseItem(caseRef, collId, groupNumber, groupId, categories) {
  const caseKey = caseRef.term + '/' + caseRef.number;

  // ── Shell: <li>, header (toggle + title), file <ul> ──
  const _ciGroupOrId = groupId != null ? { id: groupId } : { group: groupNumber };
  const _ciDeleteOther = groupId != null ? 'group' : 'id';
  const { ci, header, toggle, titleSpan, fileUl } = _buildCaseItemShell({
    caseKey,
    title:     caseTitle(caseRef.title),
    tooltip:   argumentTooltip(caseRef.term, caseRef),
    // First date in caseRef.argument (or reargument) is the event this
    // collection entry represents — used by loadCase to highlight the correct
    // sibling when the same case has multiple collection items.
    audioDate: (typeof caseRef.argument === 'string' && caseRef.argument)
      ? caseRef.argument.split(',')[0].trim()
      : (typeof caseRef.reargument === 'string' && caseRef.reargument)
        ? caseRef.reargument.split(',')[0].trim()
        : null,
    eventIdx:  (Number.isInteger(caseRef.event) && caseRef.event >= 1) ? caseRef.event : null,
    hasFiles:  !!caseRef.files,
    caseNumber: caseRef.number || '',
    href:      buildUrlParams(
      { collection: collId, ..._ciGroupOrId, term: caseRef.term, case: caseRef.number },
      [_ciDeleteOther, 'highlight', 'event', 'file', 'turn'],
    ),
  });

  ci.dataset.argued  = (typeof caseRef.argument === 'string' ? caseRef.argument.split(',')[0].trim() : '') || (typeof caseRef.reargument === 'string' ? caseRef.reargument.split(',')[0].trim() : '') || '';
  ci.dataset.decided = caseRef.decision || '';
  if (caseRef.vocal) ci.dataset.vocal = caseRef.vocal;
  const _sortLabel = document.createElement('span');
  _sortLabel.className = 'case-sort-label';
  header.appendChild(_sortLabel);

  // Cache the fetched caseEntry so all click handlers share one fetch per case.
  let _caseEntryCache = null;
  async function _fetchCaseEntry() {
    if (_caseEntryCache) return _caseEntryCache;
    const cases = await fetchTermCases(caseRef.term);
    _caseEntryCache = cases.find(c => c.number === caseRef.number ||
      (c.number && c.number.split(',').map(n => n.trim()).includes(caseRef.number)) ||
      (!c.number && c.id === caseRef.number)) ?? null;
    return _caseEntryCache;
  }

  // ── Speaker / transcript icon ──────────────────────────
  let _audioIconNode = _attachAudioIcon(header, {
    hasAudio:      !!caseRef.event,
    hasTranscript: !!caseRef.transcript,
    ring:          null,
  });

  // Asynchronously upgrade the audio icon with oyez ring/deficit data once
  // the full case entry is available — keeps collection UI in sync with the
  // term-list rendering.
  if (caseRef.event) {
    _fetchCaseEntry().then(caseEntry => {
      if (!caseEntry) return;
      const ring    = oyezCircleData(caseEntry);
      const deficit = oyezDeficitClass(caseEntry);
      if (!ring && !deficit) return;
      const nextSibling = _audioIconNode ? _audioIconNode.nextSibling : null;
      if (_audioIconNode && _audioIconNode.parentNode === header) {
        header.removeChild(_audioIconNode);
      }
      _audioIconNode = _attachAudioIcon(header, {
        hasAudio:      true,
        hasTranscript: !!caseRef.transcript,
        ring,
        deficit,
      });
      // Preserve original position relative to other header icons (e.g. scales).
      if (_audioIconNode && nextSibling && nextSibling.parentNode === header) {
        header.insertBefore(_audioIconNode, nextSibling);
      }
    }).catch(() => { /* ignore */ });
  }

  // ── Scales icon: shown if audio or decision; clickable iff decision ──
  let _scalesIconNode = null;
  const _scalesOnClick = caseRef.decision ? async (e) => {
    e.stopPropagation();
    // Synchronous selection feedback before any async fetch.
    if (!ci.classList.contains('active')) markCaseItemActive(ci);
    const caseEntry = await _fetchCaseEntry();
    if (!caseEntry?.opinion_href) return;
    const opinionFile = { href: caseEntry.opinion_href, title: 'Opinion in ' + caseTitle(caseRef.title) };
    if (caseRef.event) {
      // Case has audio: if not yet loaded, load the case first, then open opinion in doc viewer.
      if (!ci.classList.contains('active')) {
        const defaultAudioIdx = Number.isInteger(caseRef.event) && caseRef.event >= 1 ? caseRef.event : 0;
        await loadCase(caseRef.term, caseEntry, defaultAudioIdx);
      }
      document.querySelectorAll('.file-item, .file-type-header').forEach(el => el.classList.remove('active'));
      showDocViewer(opinionFile, { autoScroll: true });
    } else {
      // No audio: load case in no-audio mode so opinion opens full-height.
      loadCase(caseRef.term, caseEntry, 0, { forceNoAudio: true });
    }
  } : null;
  if (caseRef.event || caseRef.decision) {
    _scalesIconNode = _attachScalesIcon(ci, header, { onClick: _scalesOnClick });
  }

  // Asynchronously upgrade the scales icon with a ring once the full case entry
  // is available — shows opinion audio (blue/purple stroke) or OTD video (filled).
  if (caseRef.decision || caseRef.event) {
    _fetchCaseEntry().then(caseEntry => {
      if (!caseEntry) return;
      const ring = opinionCircleData(caseEntry);
      if (!ring) return;
      if (_scalesIconNode?.parentNode === header) header.removeChild(_scalesIconNode);
      _scalesIconNode = _attachScalesIcon(ci, header, { onClick: _scalesOnClick, ring });
    }).catch(() => { /* ignore */ });
  }

  let fileListBuilt = false;

  async function ensureCollFileListBuilt(caseEntry) {
    if (fileListBuilt) return;
    fileListBuilt = true;
    const basePath = '/courts/ussc/terms/' + caseRef.term + '/cases/' + caseDirName(caseEntry) + '/';

    // When the collection case entry specifies a particular argument date, only inject the
    // transcript for that date — not all transcripts for the case (e.g. a reargument).
    const argumentDates = caseRef.argument ? caseRef.argument.split(',') : null;

    const { isEmpty, hideToggle } = await _buildCaseFileList(fileUl, caseEntry, {
      basePath,
      argumentDates,
      computeEntries: (rawFiles) => {
        // Allowed category labels and their render order.
        const ALL_CATS = ['Petitioner', 'Respondent', 'Amicus', 'Briefs', 'Transcripts', 'Other', 'References'];
        // Default categories when the collection doesn't specify any.
        const DEFAULT_CATS = ['Petitioner', 'Respondent', 'Other'];
        const activeCats = (Array.isArray(categories) && categories.length)
          ? categories : DEFAULT_CATS;
        const activeCatSet = new Set(activeCats);

        // Map a file to the best available active category label.
        function resolveCategory(f) {
          let sem = (f.type || '').toLowerCase();
          if (sem === 'appellant' || sem === 'appellants') sem = 'petitioner';
          else if (sem === 'appellee' || sem === 'appellees') sem = 'respondent';
          if (!sem) {
            // Infer from title when type is absent.
            const t = (f.title || '').toLowerCase();
            if (/\bappellants?\b|\bpetitioners?\b/.test(t)) sem = 'petitioner';
            else if (/\bappellees?\b|\brespondents?\b|\bfor the (united states|government|solicitor general)\b/.test(t)) sem = 'respondent';
            else if (/\bamici?\s+curiae\b|\bamicus\b|\bamici\b/.test(t)) sem = 'amicus';
            else if ((f.title || '').startsWith('Transcript of ')) sem = 'transcript';
            else sem = 'other';
          }
          // Preference order per semantic type → category label.
          const prefs = {
            petitioner: ['Petitioner', 'Briefs', 'Other'],
            respondent: ['Respondent', 'Briefs', 'Other'],
            amicus:     ['Amicus', 'Briefs', 'Other'],
            brief:      ['Briefs', 'Other'],
            transcript: ['Transcripts', 'Other'],
            other:      ['Other'],
          };
          const candidates = prefs[sem] || ['Other'];
          for (const c of candidates) {
            if (activeCatSet.has(c)) return c;
          }
          return activeCats[0];
        }

        const opinionFiles = rawFiles.filter(f => (f.type || '').toLowerCase() === 'opinion');
        const transcriptFiles = rawFiles.filter(f => (f.type || '').toLowerCase() === 'transcript');
        const groups = {};
        rawFiles.forEach(f => {
          const fType = (f.type || '').toLowerCase();
          if (fType === 'opinion' || fType === 'transcript') return;
          const key = resolveCategory(f);
          if (!groups[key]) groups[key] = [];
          groups[key].push(f);
        });

        // Sort within each group.
        activeCats.forEach(label => {
          if (!groups[label]) return;
          if (label === 'References') {
            groups[label].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
          } else {
            groups[label].sort((a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0);
          }
        });

        const totalFiles = rawFiles.length;
        const effectiveOrder = ALL_CATS.filter(c => activeCatSet.has(c));
        // Suppress the group subheading when there is only one non-empty
        // category — listing files directly avoids forcing the user to expand
        // a useless group of one.
        const nonEmptyGroupKeys = effectiveOrder.filter(k => groups[k]?.length > 0);
        const suppressHeader = totalFiles === 1 || nonEmptyGroupKeys.length === 1;

        const entries = [];
        effectiveOrder.forEach(typeKey => {
          if (!groups[typeKey] || !groups[typeKey].length) return;
          entries.push({
            kind: suppressHeader ? 'flat' : 'group',
            label: typeKey,
            files: groups[typeKey],
          });
        });
        if (transcriptFiles.length) entries.push({ kind: 'flat', files: transcriptFiles });
        if (opinionFiles.length) entries.push({ kind: 'flat', files: opinionFiles });

        // Also hide the toggle when the only available files are transcript entries —
        // transcript-only cases are not considered "browsable" via the toggle.
        const hasNonTranscriptFiles = rawFiles.some(f => (f.type || '').toLowerCase() !== 'transcript');
        return { entries, hideToggle: !hasNonTranscriptFiles };
      },
    });

    if (isEmpty || hideToggle) toggle.style.display = 'none';
  }

  toggle.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (ci.classList.toggle('open')) {
      const caseEntry = await _fetchCaseEntry();
      if (caseEntry) await ensureCollFileListBuilt(caseEntry);
    }
  });

  titleSpan.addEventListener('click', async (e) => {
    const fromRestore = !!e.fromRestore;
    // Synchronous selection feedback before any async fetch.
    if (!fromRestore) markCaseItemActive(ci);
    const caseEntry = await _fetchCaseEntry();
    if (!caseEntry) {
      console.warn('[collections] case not found in cases.json:', caseRef);
      return;
    }
    // caseRef.event is a 1-based index into caseEntry.events (original order).
    const defaultAudioIdx = Number.isInteger(caseRef.event) && caseRef.event >= 1 ? caseRef.event : 0;
    const audioIdx = fromRestore
      ? (Number.isInteger(e.audioIdx) ? e.audioIdx : defaultAudioIdx)
      : defaultAudioIdx;

    // Sort the case's audio entries by date (same order as the 1-based index).
    const sortedAudio = [...(caseEntry.events || [])].sort(
      (a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0,
    );

    ci.classList.add('open');
    await ensureCollFileListBuilt(caseEntry);

    // Determine whether the case has any playable audio. Audio/transcript is
    // preferred over the opinion whenever the case exposes an audio_href on
    // any event — even if the specifically-indexed entry is a transcript-only
    // placeholder (loadCase will pick the audio-bearing sibling and update
    // the dropdown selection accordingly).
    const hasPlayableAudio = sortedAudio.some(a => a.audio_href);

    const initialTurn = (fromRestore && Number.isInteger(e.initialTurn) && e.initialTurn > 0)
      ? e.initialTurn
      : (Number.isInteger(caseRef.turn) && caseRef.turn > 0 ? caseRef.turn : null);
    if (!fromRestore) {
      const groupOrId = groupId != null ? { id: groupId } : { group: groupNumber };
      const deleteOther = groupId != null ? ['group'] : ['id'];
      const url = buildUrlParams(
        {
          collection: collId,
          ...groupOrId,
          term: caseRef.term,
          case: caseRef.number,
          ...(audioIdx > 0 ? { event: audioIdx } : {}),
          ...(initialTurn ? { turn: initialTurn } : {}),
        },
        [...deleteOther, 'highlight', ...(audioIdx === 0 ? ['event'] : []), 'file', ...(initialTurn ? [] : ['turn'])],
      );
      navigate(url);
    }
    loadCase(caseRef.term, caseEntry, audioIdx, { forceNoAudio: !hasPlayableAudio, initialTurn });
    // For no-audio cases, transcriptloaded never fires; restore file selection here.
    // Use !hasPlayableAudio rather than !events?.length so cases with transcript-only
    // events (no audio_href) are also covered.
    const fileRestore = e.fileRestore ?? null;
    if (fileRestore != null && !hasPlayableAudio) {
      const fileEl = findFileItem(fileRestore);
      if (fileEl) {
        fileEl.closest('.file-type-group')?.classList.add('open');
        fileEl.click();
      }
    }
  });

  return ci;
}

function _parseVocalSecs(s) {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(s).trim());
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

function _populateCollectionGroups(collUl, groups, collEntry, collId) {
  // Base path for per-advocate JSON files (split format): collectionDir/folder/
  // Uses collEntry.folder if specified, otherwise falls back to collId.
  // An absolute folder path (starts with '/') is used directly; relative paths
  // are resolved relative to the collection file's directory.
  const collFileUrl = collEntry.file ?? collEntry.collection;
  const collBase = collFileUrl.slice(0, collFileUrl.lastIndexOf('/'));
  const folderVal = collEntry.folder || collId;
  const splitBase = folderVal.startsWith('/') ? (folderVal + '/') : (collBase + '/' + folderVal + '/');

  // Parse the collection-level default sort order, e.g. "argued:descending".
  // When no order is specified, preserve the JSON file order ('none').
  let _defaultSortMode = 'none';
  let _defaultSortAsc  = true;
  if (collEntry.order) {
    const [om, od] = collEntry.order.split(':');
    if (om) _defaultSortMode = om.trim().toLowerCase();
    if (od) _defaultSortAsc  = od.trim().toLowerCase() !== 'descending';
  }

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const groupNumber = groupIdx + 1; // 1-based index within the collection
    // Each group (e.g. "Abe Fortas") — styled like a month group
    const groupLi = document.createElement('li');
    groupLi.className = 'month-group';
    groupLi.dataset.groupIdx = String(groupNumber);
    if (group.id != null) groupLi.dataset.groupId = group.id;

    // Precompute search text for collection filtering (used by inline search).
    {
      const _s = collEntry.search || '';
      const _ci = _s.indexOf(':');
      const _an = _ci >= 0 ? _s.slice(0, _ci) : null;
      const _pn = _ci >= 0 ? _s.slice(_ci + 1) : _s;
      let _st;
      if (!_pn) {
        _st = String(group.name || '');
      } else if (!_an) {
        _st = String(group[_pn] || '');
      } else {
        const _a = group[_an];
        _st = Array.isArray(_a) ? _a.map(item => String(item[_pn] || '')).join(' ') : String(group.name || '');
      }
      groupLi.dataset.searchText = _st.toLowerCase();
    }

    const groupHeader = document.createElement('div');
    groupHeader.className = 'month-header';

    const groupTog = document.createElement('span');
    groupTog.className = 'month-toggle';
    groupTog.textContent = '▶';

    const groupName = document.createElement('span');
    groupName.className = 'month-name';
    groupName.textContent = group.name;

    const groupCount = document.createElement('button');
    groupCount.type = 'button';
    groupCount.className = 'term-case-count';
    // Split format: cases is a number (precomputed count). Embedded format: cases is an array.
    // Using `let` so _ensureGroupCases can correct it after loading when the index lacks a count.
    let n = typeof group.cases === 'number' ? group.cases : (Array.isArray(group.cases) ? group.cases.length : 0);
    // Vocal-style groups have a `total` (HH:MM:SS.NN) instead of a case count.
    const hoursLabel = (() => {
      if (typeof group.total !== 'string' || !group.total) return null;
      const m = /^(\d+):\d{2}:\d{2}/.exec(group.total);
      if (!m) return null; const h = parseInt(m[1], 10); return h + '\u00a0' + (h === 1 ? 'hr' : 'hrs');
    })();
    const _groupSortModeLabel = (mode, asc) => {
      if (mode === 'none') return hoursLabel || (n + '\u00a0Cases');
      const arrow = asc ? '\u00a0\u2191' : '\u00a0\u2193';
      if (mode === 'hours') return (hoursLabel || 'Hours') + arrow;
      if (mode === 'cases') return (n + '\u00a0Cases') + arrow;
      return _sortModeLabel(mode, n, asc);
    };
    groupCount.textContent = hoursLabel || (n + '\u00a0Cases');

    groupHeader.appendChild(groupTog);
    groupHeader.appendChild(groupName);
    groupHeader.appendChild(groupCount);

    const groupUl = document.createElement('ul');
    groupUl.className = 'month-case-list';

    let _groupSortMode = _defaultSortMode;
    let _groupSortAsc  = _defaultSortAsc;
    const _GROUP_SORT_OPTIONS = [
      ...(_defaultSortMode === 'hours' ? [{ mode: 'hours', label: 'Hours' }] : []),
      { mode: 'cases',   label: 'Cases'   },
      { mode: 'argued',  label: 'Argued'  },
      { mode: 'decided', label: 'Decided' },
    ];

    const PAGE_SIZE = 20;
    const HALF_PAGE = PAGE_SIZE >> 1;
    let _pageStart = 0;
    let _highlights = [];
    let _sortedItems = [];

    const prevSentinel = Object.assign(document.createElement('li'), { className: 'page-sentinel' });
    const prevBtn = prevSentinel.appendChild(document.createElement('button'));
    prevBtn.className = 'page-sentinel-btn';
    prevBtn.addEventListener('click', () => {
      _pageStart = Math.max(0, _pageStart - PAGE_SIZE);
      _renderGroupPage();
      requestAnimationFrame(() => nextSentinel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    });

    const nextSentinel = Object.assign(document.createElement('li'), { className: 'page-sentinel' });
    const nextBtn = nextSentinel.appendChild(document.createElement('button'));
    nextBtn.className = 'page-sentinel-btn';
    nextBtn.addEventListener('click', () => {
      _pageStart += PAGE_SIZE;
      _renderGroupPage();
      requestAnimationFrame(() => prevSentinel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    });

    function _renderGroupPage() {
      const pageEnd = _pageStart + PAGE_SIZE;
      const prevCount = _pageStart;
      const nextCount = Math.max(0, _sortedItems.length - pageEnd);
      for (let i = 0; i < _sortedItems.length; i++) {
        _sortedItems[i].hidden = (i < _pageStart || i >= pageEnd);
      }
      prevSentinel.hidden = prevCount === 0;
      nextSentinel.hidden = nextCount === 0;
      if (prevCount > 0) {
        const show = Math.min(prevCount, PAGE_SIZE);
        prevBtn.textContent = `(Previous ${show} case${show !== 1 ? 's' : ''}...)`;
      }
      if (nextCount > 0) {
        const show = Math.min(nextCount, PAGE_SIZE);
        nextBtn.textContent = `(Next ${show} case${show !== 1 ? 's' : ''}...)`;
      }
      groupUl.replaceChildren(
        ..._highlights,
        ...(prevCount > 0 ? [prevSentinel] : []),
        ..._sortedItems.slice(0, pageEnd),
        ...(nextCount > 0 ? [nextSentinel] : []),
        ..._sortedItems.slice(pageEnd),
      );
    }

    function _applyGroupSortMode(mode, asc, { reversal = false } = {}) {
      const allItems = Array.from(groupUl.querySelectorAll('.case-item'));
      _highlights = allItems.filter(ci => ci.classList.contains('highlight-item'));
      _sortedItems = allItems.filter(ci => !ci.classList.contains('highlight-item'));
      _pageStart = 0;
      if (reversal) {
        // Only direction changed: items are already sorted, just flip them.
        _sortedItems.reverse();
        _renderGroupPage();
        return;
      }
      _sortedItems.forEach(ci => {
        const lbl = ci.querySelector('.case-sort-label');
        if (!lbl) return;
        if (mode === 'argued' || mode === 'decided') {
          const raw = mode === 'argued' ? (ci.dataset.argued || '') : (ci.dataset.decided || '');
          lbl.textContent = raw ? _fmtMonthDay(raw, true) : '';
        } else if (mode === 'hours') {
          const secs = _parseVocalSecs(ci.dataset.vocal || '');
          const mins = Math.round(secs / 60);
          if (mins > 0) {
            lbl.textContent = mins + '\u00a0min';
          } else {
            const s = Math.round(secs);
            lbl.textContent = s + '\u00a0sec';
          }
        } else {
          lbl.textContent = '';
        }
      });
      // Re-sort non-highlight items; highlights always stay first.
      if (mode === 'argued' || mode === 'decided') {
        const key = mode === 'argued' ? 'argued' : 'decided';
        _sortedItems.sort((a, b) => {
          const av = a.dataset[key] || '';
          const bv = b.dataset[key] || '';
          return av < bv ? -1 : av > bv ? 1 : 0;
        });
        groupUl.classList.add('coll-sort-date');
      } else if (mode === 'hours') {
        _sortedItems.sort((a, b) => _parseVocalSecs(a.dataset.vocal || '') - _parseVocalSecs(b.dataset.vocal || ''));
        groupUl.classList.add('coll-sort-date');
      } else if (mode === 'cases') {
        // Pre-compute keys once (O(n)) to avoid O(n log n) querySelector calls in the comparator.
        const keyMap = new Map(_sortedItems.map(ci => [ci, ci.querySelector('.case-title-nav')?.textContent || '']));
        _sortedItems.sort((a, b) => keyMap.get(a).localeCompare(keyMap.get(b)));
        groupUl.classList.remove('coll-sort-date');
      } else {
        // 'none': preserve original insertion order (no-op on items array).
        groupUl.classList.remove('coll-sort-date');
      }
      if (!asc) _sortedItems.reverse();
      _renderGroupPage();
    }

    function _showGroupSortMenu() {
      _buildSortMenu(
        groupCount,
        _GROUP_SORT_OPTIONS,
        () => ({ mode: _groupSortMode, asc: _groupSortAsc }),
        ({ mode, asc }) => {
          const reversal = mode === _groupSortMode;
          _groupSortMode = mode;
          _groupSortAsc  = asc;
          groupCount.textContent = _groupSortModeLabel(_groupSortMode, _groupSortAsc);
          _applyGroupSortMode(_groupSortMode, _groupSortAsc, { reversal });
        },
      );
    }

    groupCount.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!groupLi.classList.contains('open')) return;
      _showGroupSortMenu();
    });

    // Lazy-load case items the first time the group is expanded.
    // For embedded format (cases is an array): build items from the in-memory array.
    // For split format (cases is a count, id is set): fetch the per-group JSON file.
    let _casesLoaded = false;
    let _groupLink = null;
    let _groupDocument = null;
    const _ensureGroupCases = async () => {
      if (_casesLoaded) return;
      _casesLoaded = true;
      if (Array.isArray(group.cases)) {
        // Embedded format: build case items from the in-memory array.
        for (const caseRef of group.cases) {
          groupUl.appendChild(_buildCollectionCaseItem(caseRef, collId, groupNumber, group.id, collEntry.categories));
        }
        n = group.cases.length;
        _applyGroupSortMode(_groupSortMode, _groupSortAsc);
      } else if (group.id) {
        // Split format: fetch the per-group JSON file.
        try {
          const r = await fetch(splitBase + group.id + '.json', { cache: 'reload' });
          if (r.ok) {
            const advocateData = await r.json();
            const highlights = Array.isArray(advocateData) ? [] : (advocateData.highlights || []);
            const advocateCases = Array.isArray(advocateData) ? advocateData : (advocateData.cases || []);
            _groupLink = Array.isArray(advocateData) ? null : (advocateData.details?.page ?? null);
            _groupDocument = Array.isArray(advocateData) ? null : (advocateData.details?.web ?? null);
            groupLi._groupLink = _groupLink;
            groupLi._groupDocument = _groupDocument;
            for (const [hlIdx, hl] of highlights.entries()) {
              const _hlGroupId = group.id ?? null;
              const _hlGroupOrId = _hlGroupId != null ? { id: _hlGroupId } : { group: groupNumber };
              const _hlDeleteOther = _hlGroupId != null ? 'group' : 'id';
              const hlHref = buildUrlParams(
                { collection: collId, ..._hlGroupOrId, highlight: hlIdx + 1 },
                [_hlDeleteOther, 'term', 'case', 'event', 'file', 'turn'],
              );
              groupUl.appendChild(_buildHighlightItem(hl, hlIdx, hlHref));
            }
            for (const caseRef of advocateCases) {
              groupUl.appendChild(_buildCollectionCaseItem(caseRef, collId, groupNumber, group.id, collEntry.categories));
            }
            n = advocateCases.length;
            _applyGroupSortMode(_groupSortMode, _groupSortAsc);
            // Refresh the count button now that we know the actual case count.
            if (groupCount.classList.contains('sort-active')) {
              groupCount.textContent = _groupSortModeLabel(_groupSortMode, _groupSortAsc);
            }
          }
        } catch (err) {
          console.warn('[collections] advocate cases fetch failed:', group.id, err);
        }
      }
    };
    groupLi._ensureCases = _ensureGroupCases;
    groupLi._rawCases = Array.isArray(group.cases) ? group.cases : null;
    groupLi._activateCount = () => { groupCount.classList.add('sort-active'); groupCount.textContent = _groupSortModeLabel(_groupSortMode, _groupSortAsc); };
    groupLi._centerOnItem = (item) => {
      const idx = _sortedItems.indexOf(item);
      if (idx < 0) return;
      _pageStart = Math.max(0, Math.min(idx - HALF_PAGE, Math.max(0, _sortedItems.length - PAGE_SIZE)));
      _renderGroupPage();
    };

    groupHeader.addEventListener('click', async (e) => {
      if (groupTog.contains(e.target)) {
        groupLi.classList.toggle('open');
        if (!groupLi.classList.contains('open')) {
          groupCount.classList.remove('sort-active');
          groupCount.textContent = hoursLabel || (n + '\u00a0Cases');
          return;
        }
      } else if (!groupLi.classList.contains('open')) {
        groupLi.classList.add('open');
      }
      // Open (or already open): update URL, load cases, show page.
      groupCount.classList.add('sort-active');
      groupCount.textContent = _groupSortModeLabel(_groupSortMode, _groupSortAsc);
      const groupOrId = group.id != null ? { id: group.id } : { group: groupNumber };
      const deleteOther = group.id != null ? ['group'] : ['id'];
      const url = buildUrlParams(
        { collection: collId, ...groupOrId },
        [...deleteOther, 'highlight', 'term', 'case', 'event', 'file', 'turn'],
      );
      history.replaceState(null, '', url);
      await _ensureGroupCases();
      if (_groupLink && _groupDocument) showAdvocateDocument(_groupDocument, _groupLink, group.name || '');
      else if (_groupLink) showPageViewer(_groupLink, { pushState: false });
      else if (_groupDocument) showAdvocateDocument(_groupDocument, null, group.name || '');
    });

    groupLi.appendChild(groupHeader);
    groupLi.appendChild(groupUl);
    collUl.appendChild(groupLi);
  }
}

// ── Load a case ─────────────────────────────────────────────────────────────

// If `arg` has no text_href, borrow one from another event in `events` that
// shares the same date and type (e.g. a NARA audio entry paired with a USSC
// transcript-only entry for the same argument date).
function withTranscriptFallback(arg, events) {
  if (arg.text_href || !events?.length) return arg;
  const donor = events.find(e => e !== arg && e.date === arg.date && e.type === arg.type && e.text_href);
  if (!donor) return arg;
  const result = Object.assign({}, arg);
  result.text_href = donor.text_href;
  if (!result.transcript_href && donor.transcript_href) result.transcript_href = donor.transcript_href;
  return result;
}

// Load (or switch to) a specific audio entry within the already-set-up case.
async function loadAudioEntry(arg, basePath) {
  // text_href values are relative to the term's cases/ directory (one level up
  // from basePath, which points to the individual case folder).
  const casesPath = basePath.replace(/[^/]+\/$/, '');
  const transcriptUrl = arg.text_href
    ? (/^https?:\/\//i.test(arg.text_href) ? arg.text_href : (casesPath + arg.text_href))
    : null;
  const audioUrl = arg.audio_href
    ? (/^https?:\/\//i.test(arg.audio_href) || arg.audio_href.startsWith('/') ? arg.audio_href : (basePath + arg.audio_href))
    : (arg.audio != null ? (basePath + arg.audio) : null);
  _currentTranscriptPdfUrl = arg.transcript_href
    ? (/^https?:\/\//i.test(arg.transcript_href) ? arg.transcript_href : (basePath + arg.transcript_href))
    : null;

  // Reset transcript area.
  // Pin the current height as a minimum before clearing content so that the
  // transcript pane doesn't collapse during the async fetch — which would
  // cause a layout shift that briefly exposes the nav pane on mobile.
  const _prevHeight = transcriptViewer.offsetHeight;
  if (_prevHeight > 0) transcriptViewer.style.minHeight = _prevHeight + 'px';
  _currentLoadedEntry = null;
  turnList.style.display = 'none';
  turnList.innerHTML = '';
  loadingMsg.textContent = 'Loading\u2026';
  loadingMsg.style.display = 'block';
  activeTurnIdx = -1;

  try {
    let transcriptData = [];
    let isEnvelope = false;

    if (transcriptUrl) {
      const res = await fetch(transcriptUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      transcriptData = await res.json();
      isEnvelope = !Array.isArray(transcriptData);
    }

    turns = isEnvelope ? (transcriptData.turns ?? []) : transcriptData;

    turnTimes = turns.map(t => parseTime(t.time ?? '00:00:00.00'));

    // Always prefer the event's audio_href; fall back to media.url in the
    // transcript envelope only when the event has no audio_href of its own.
    const resolvedAudioUrl = audioUrl || (isEnvelope && transcriptData.media?.url) || null;
    if (resolvedAudioUrl) {
      audio.src = resolvedAudioUrl;
    } else {
      audio.removeAttribute('src');
    }
    audio.load();

    // If the entry has an offset (e.g. NARA files covering multiple cases),
    // seek to that position after metadata is ready.
    if (arg.offset) {
      seekOnly(parseTime(arg.offset));
    } else if (Number.isInteger(arg.turn) && arg.turn > 0 && arg.turn <= turnTimes.length) {
      // `turn` is a 1-based index into the aligned transcript; used when
      // multiple arguments share a single audio file. Seek to that turn's time.
      // Add a tiny epsilon so audio.currentTime lands above the turn boundary
      // after the browser quantizes the seek, ensuring findCurrentTurn returns
      // the correct turn on the first timeupdate.
      seekOnly(turnTimes[arg.turn - 1] + 0.01);
      _suppressTimeupdateBeforeSeek = true;
    }

    const unalignedNote = document.getElementById('unaligned-note');
    // Only treat as time-aligned if at least one turn has a non-zero timestamp.
    // All-zero timestamps (e.g. Oyez data where alignment failed) should be
    // treated as unaligned to avoid scrolling to the last turn on timeupdate.
    hasTimes = turnTimes.some(t => t > 0);
    unalignedNote.hidden = hasTimes;
    document.getElementById('prev-speaker-btn').disabled = !turns.length;
    document.getElementById('prev-turn-btn').disabled = !turns.length;
    document.getElementById('next-turn-btn').disabled = !turns.length;
    document.getElementById('next-speaker-btn').disabled = !turns.length;

    _currentTextHref = arg.text_href || '';
    caseSpeakers = (isEnvelope && transcriptData.media?.speakers?.length)
      ? transcriptData.media.speakers
      : [...new Map(turns.map(t => [t.name, { name: t.name }])).values()];

    renderTranscript();
    document.getElementById('transcript-viewer')
      .classList.toggle('no-transcript', turns.length === 0);
    const docPanel = document.getElementById('doc-viewer');
    if (!docPanel.hidden && !docPanel.classList.contains('collapsed')) {
      collapseDocViewer();
    }
    activeBottomLinkText = null;

    // When a specific turn is requested (arg.turn), highlight it immediately
    // after rendering so the correct turn is shown even before timeupdate fires.
    // (Relying solely on timeupdate is unreliable: audio.currentTime after a
    // seek can differ from turnTimes[n] by a tiny floating-point epsilon, which
    // causes findCurrentTurn to land on the preceding turn.)
    if (Number.isInteger(arg.turn) && arg.turn > 0 && arg.turn <= turns.length) {
      const initialIdx = arg.turn - 1;
      const el = document.getElementById('turn-' + initialIdx);
      if (el) {
        el.classList.add('active');
        activeTurnIdx = initialIdx;
        requestAnimationFrame(() => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
      }
      // Re-affirm the correct highlight once the pending seek actually lands.
      // timeupdate may fire at t=0 before the deferred seek takes effect (the
      // browser fires timeupdate when audio.load() resets currentTime) and
      // browsers don't reliably fire timeupdate after a paused seek. Using
      // 'seeked' avoids both races.
      // Store a reference so jumpToTurn() can cancel this if the user navigates
      // away before the initial seek completes (otherwise the listener fires for
      // the user-triggered seek and incorrectly reverts activeTurnIdx).
      if (_pendingSeekListener) {
        audio.removeEventListener('seeked', _pendingSeekListener);
      }
      _pendingSeekListener = () => {
        _pendingSeekListener = null;
        _suppressTimeupdateBeforeSeek = false;
        if (activeTurnIdx !== initialIdx) {
          document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
          const el2 = document.getElementById('turn-' + initialIdx);
          if (el2) {
            el2.classList.add('active');
            activeTurnIdx = initialIdx;
          }
        }
      };
      audio.addEventListener('seeked', _pendingSeekListener, { once: true });
    }

    _currentLoadedEntry = arg;
    loadingMsg.style.display = 'none';
    turnList.style.display = 'block';
    transcriptViewer.style.minHeight = '';
    document.dispatchEvent(new Event('transcriptloaded'));
  } catch (err) {
    transcriptViewer.style.minHeight = '';
    loadingMsg.textContent = 'Error loading transcript.';
    console.error(err);
  }
}

// Build the journal-ref Map and options array shared by loadCaseAsOpinion and loadCase.
// Returns { map: Map<value, {href, title}>, opts: Array<{value, title}> }.
function _buildJournalRefOptions(caseEntry, term) {
  const map  = new Map();
  const opts = [];
  const seen = new Set();
  (caseEntry.events || []).forEach((ev, i) => {
    if (!ev.journal_ref || !ev.date) return;
    const m = String(ev.journal_ref).match(/^(?:(\d{4}-\d{2}):)?(.+)$/);
    if (!m) return;
    const refTerm = m[1] || term;
    const page    = m[2].trim();
    if (!page) return;
    const refTermEntry = TERMS.find(t => t.term === refTerm);
    const journalHref  = refTermEntry?.journal_href;
    if (!journalHref) return;
    const pageNum  = parseInt(page, 10);
    const offset   = parseInt(refTermEntry?.journal_page_offset, 10);
    const pageAnchor = (Number.isFinite(pageNum) && Number.isFinite(offset))
      ? String(pageNum + offset)
      : page;
    const [y, mo, d] = ev.date.split('-');
    const dateLabel  = (MONTHS[parseInt(mo, 10) - 1] || mo) + '\u00a0' + parseInt(d, 10) + ',\u00a0' + y;
    const title      = 'Journal Entry for ' + dateLabel;
    const url        = journalHref + '#page=' + encodeURIComponent(pageAnchor);
    if (seen.has(url)) return;
    seen.add(url);
    const value = 'journal:' + (i + 1);
    map.set(value, { href: url, title });
    opts.push({ value, title });
  });
  return { map, opts };
}

// Display a case in opinion-only mode: no transcript pane, no audio dropdown,
// the opinion PDF (if any) opens full-height in the document viewer. Used for
// historical cases without playable audio, and when a collection click forces
// no-audio display (forceNoAudio: true).
function loadCaseAsOpinion(term, caseEntry) {
  const caseKey = term + '/' + caseId(caseEntry);
  _currentCaseKey = caseKey;

  // Update nav highlight (no audio-index disambiguation needed in this path).
  document.querySelectorAll('.case-item').forEach(el => el.classList.remove('active'));
  const _navKeys = [caseKey];
  if (caseEntry.number && caseEntry.id && caseEntry.id !== caseEntry.number)
    _navKeys.push(term + '/' + caseEntry.number);
  if (caseEntry.number) {
    caseEntry.number.split(',').forEach(n => {
      const numKey = term + '/' + n.trim();
      if (!_navKeys.includes(numKey)) _navKeys.push(numKey);
    });
  }
  _navKeys.forEach(k => document.querySelectorAll(`.case-item[data-case-key="${CSS.escape(k)}"]`)
    .forEach(el => el.classList.add('active')));
  // When switching cases, collapse file lists for every non-active case.
  document.querySelectorAll('.case-item').forEach(el => {
    if (!el.classList.contains('active')) el.classList.remove('open');
  });

  // Clear transcript state.
  playerSection.hidden = true;
  audioControls.hidden = true;
  emptyState.style.display = 'none';
  pageViewer.hidden = true;
  transcriptViewer.hidden = false;
  activeTurnIdx = -1;
  turnList.style.display = 'none';
  turnList.innerHTML = '';
  loadingMsg.style.display = 'none';
  document.getElementById('transcript-viewer').classList.add('no-audio');

  // Reset doc viewer to hidden so showDocViewer opens it at the new height.
  const docPanel = document.getElementById('doc-viewer');
  docPanel.classList.remove('collapsed');
  docPanel.style.height = '';
  docPanel.hidden = true;
  activeBottomLinkText = null;

  // Show case title (hide audio select since there is no audio).
  setCaseTitleLabel(term, caseEntry);
  document.title = caseTitle(caseEntry.title) + ' | Argument Aloud';
  const audioSelect = document.getElementById('audio-select');
  const decisionLabel = document.getElementById('decision-date-label');

  // Collect any events with journal_ref so we can offer them in a dropdown
  // alongside the decision/opinion.
  const { map: _jrMap, opts: journalOpts } = _buildJournalRefOptions(caseEntry, term);
  _currentJournalRefs = _jrMap;

  const decisionText = caseEntry.decision
    ? 'Decision on\u00a0' + formatDecisionDate(caseEntry.decision)
        + (caseEntry.usCite ? '\u00a0(' + caseEntry.usCite + ')' : '')
    : null;

  // If there are extra documents to choose from, surface a dropdown rather
  // than the standalone decision label.
  _currentOpinionHref = caseEntry.opinion_href || null;
  _currentOyezHref    = caseEntry.oyez_href || null;
  _currentVideoEntries = (caseEntry.events || []).filter(e => e.source === 'otd' && e.video_href).map(e => ({ href: e.video_href, title: e.title || 'Video' }));
  if (journalOpts.length && (decisionText || journalOpts.length > 1) || _currentVideoEntries.length) {
    decisionLabel.hidden = true;
    audioSelect.innerHTML = '';
    journalOpts.forEach(j => {
      const opt = document.createElement('option');
      opt.value = j.value;
      opt.textContent = j.title;
      audioSelect.appendChild(opt);
    });
    if (decisionText && caseEntry.opinion_href) {
      const opt = document.createElement('option');
      opt.value = 'opinion';
      opt.textContent = decisionText;
      audioSelect.appendChild(opt);
    }
    _currentVideoEntries.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = 'video:' + i;
      opt.textContent = v.title;
      audioSelect.appendChild(opt);
    });
    // Default to the opinion entry when it exists, since that is what is
    // displayed initially in the document viewer.
    if (caseEntry.opinion_href) audioSelect.value = 'opinion';
    audioSelect.hidden = false;
  } else {
    audioSelect.hidden = true;
    if (decisionText) {
      decisionLabel.textContent = decisionText;
      if (caseEntry.opinion_href) {
        decisionLabel.href = caseEntry.opinion_href;
        decisionLabel.target = '_blank';
        decisionLabel.rel = 'noopener noreferrer';
      } else {
        decisionLabel.removeAttribute('href');
        decisionLabel.removeAttribute('target');
        decisionLabel.removeAttribute('rel');
      }
      decisionLabel.hidden = false;
    } else {
      decisionLabel.hidden = true;
    }
  }

  _currentCaseEntry = caseEntry;
  _setCaseInfoRow2(caseEntry);

  const qEl = document.getElementById('case-questions');
  qEl.textContent = '';
  qEl.title = '';
  qEl.hidden = true;
  qEl.onclick = null;
  qEl.style.cursor = '';

  playerSection.hidden = false;

  // Open opinion full-height in the document viewer. Use a local override so
  // this large height doesn't persist for the next audio case.
  if (caseEntry.opinion_href) {
    const savedHeight = docViewerOpenHeight;
    docViewerOpenHeight = Math.round(window.innerHeight * 0.85);
    showDocViewer(
      { href: caseEntry.opinion_href, title: 'Opinion in ' + caseTitle(caseEntry.title) },
      { autoScroll: true }
    );
    docViewerOpenHeight = savedHeight;
  }

  if (isMobile()) {
    playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
    setMobileNavVisible(false);
  }
}

async function loadCase(term, caseEntry, audioIdx = 0, { forceNoAudio = false, initialTurn = null } = {}) {
  const caseKey = term + '/' + caseId(caseEntry);
  _currentCaseKey = caseKey;
  const basePath = '/courts/ussc/terms/' + term + '/cases/' + caseDirName(caseEntry) + '/';

  // Update topbar term label
  document.getElementById('topbar-term').textContent = termDisplayName(term);

  // Treat as no-audio when forceNoAudio is set OR when no audio entry has a
  // playable audio_href (e.g. transcript-only placeholder entries). Defer to
  // loadCaseAsOpinion which handles the simpler opinion-only display path.
  const hasPlayableAudio = !forceNoAudio && caseEntry.events?.some(a => a.audio_href);
  if (!hasPlayableAudio) {
    return loadCaseAsOpinion(term, caseEntry);
  }

  // Restore audio-select visibility for normal audio cases.
  // Reset height so the doc viewer reopens at the default 45vh, not any
  // full-height value left over from a previous no-audio (historical) case.
  document.getElementById('transcript-viewer').classList.remove('no-audio', 'no-transcript');
  document.getElementById('audio-select').hidden = false;
  document.getElementById('decision-date-label').hidden = true;
  _setCaseInfoRow2(caseEntry);
  _currentOpinionHref = caseEntry.opinion_href || null;
  _currentOyezHref    = caseEntry.oyez_href || null;
  _currentVideoEntries = (caseEntry.events || []).filter(e => e.source === 'otd' && e.video_href).map(e => ({ href: e.video_href, title: e.title || 'Video' }));
  docViewerOpenHeight = null;

  // Pick the best single source: prefer the source with the most aligned entries,
  // breaking ties by preferring 'oyez' > 'ussc' > others.
  const SOURCE_PREF = ['oyez', 'ussc', 'nara'];
  const sourceGroups = new Map(); // source -> {alignedCount, entries[]}
  for (const a of caseEntry.events) {
    if (!a.audio_href) continue; // transcript-only entries don't belong in the dropdown
    const src = a.source || 'unknown';
    if (!sourceGroups.has(src)) sourceGroups.set(src, { alignedCount: 0, entries: [] });
    const g = sourceGroups.get(src);
    g.entries.push(a);
    if (a.aligned) g.alignedCount++;
  }
  // Choose the source with the highest aligned count; use SOURCE_PREF to break ties.
  let bestSource = null, bestAligned = -1;
  for (const [src, { alignedCount }] of sourceGroups) {
    const pref = SOURCE_PREF.indexOf(src);
    const prefScore = pref === -1 ? SOURCE_PREF.length : pref;
    if (alignedCount > bestAligned ||
        (alignedCount === bestAligned && prefScore < SOURCE_PREF.indexOf(bestSource))) {
      bestAligned = alignedCount;
      bestSource  = src;
    }
  }
  const sortedAudio = (() => {
    const best = (sourceGroups.get(bestSource)?.entries ?? []).slice();

    // Supplement with entries from other sources whose (date, type, offset) tuple
    // is not already covered by the best source (e.g. a NARA opinion announcement
    // on a date where the best source only has an argument entry, or a NARA event
    // with a non-zero offset covering a distinct audio segment of the same date).
    const keyOf = a => `${a.date ?? ''}|${a.type ?? ''}|${a.offset ?? ''}`;
    const covered = new Set(best.map(keyOf));
    const coveredEntryByKey = new Map(best.map(a => [keyOf(a), a]));
    for (const [src, { entries }] of sourceGroups) {
      if (src === bestSource) continue;
      for (const a of entries) {
        const k = keyOf(a);
        if (!covered.has(k)) {
          best.push(a);
          covered.add(k);
          coveredEntryByKey.set(k, a);
          continue;
        }

        // If the existing covered entry for this (date,type) is transcript-only,
        // prefer a playable replacement from another source (e.g. NARA).
        const existing = coveredEntryByKey.get(k);
        const existingHasAudio = !!existing?.audio_href;
        const candidateHasAudio = !!a.audio_href;
        if (!existingHasAudio && candidateHasAudio) {
          const idx = best.indexOf(existing);
          if (idx !== -1) best[idx] = a;
          coveredEntryByKey.set(k, a);
        }

        // If the candidate is aligned but the existing covered entry is not,
        // replace the existing entry with the aligned candidate.
        else if (!existing?.aligned && a.aligned) {
          const idx = best.indexOf(existing);
          if (idx !== -1) best[idx] = a;
          coveredEntryByKey.set(k, a);
        }

        // If both the already-covered entry and this candidate are aligned,
        // include the candidate alongside so the dropdown can show both with
        // distinct source suffixes (e.g. "(Oyez)" vs "(USSC)").
        else if (existing?.aligned && a.aligned && !best.includes(a)) {
          best.push(a);
        }
      }
    }
    // If the URL specified a particular event, ensure it survives the source-
    // preference filter — otherwise the user's explicit choice would be hidden
    // from the dropdown. Only force-include if it actually has audio.
    const _requestedEv = (audioIdx >= 1 && caseEntry.events?.[audioIdx - 1]) || null;
    if (_requestedEv && _requestedEv.audio_href && !best.includes(_requestedEv)) best.push(_requestedEv);

    // Group by date. For each date group that contains at least one aligned
    // entry, keep only the aligned ones; otherwise keep all entries for that
    // date. When the caller requested a specific event via `audioIdx`, also
    // retain that entry even if it would otherwise be filtered out, so the URL
    // can override the aligned-preference heuristic.
    const dateGroups = new Map();
    for (const a of best) {
      const dk = a.date ?? '';
      if (!dateGroups.has(dk)) dateGroups.set(dk, []);
      dateGroups.get(dk).push(a);
    }
    const filtered = [];
    for (const group of dateGroups.values()) {
      // Entries with a non-empty offset that is unique within this date-group
      // cover a distinct audio segment (e.g. a NARA file shared across cases);
      // keep them unconditionally alongside the aligned-preference filtering
      // applied to the remaining entries.
      const offsetCounts = new Map();
      for (const a of group) offsetCounts.set(a.offset ?? '', (offsetCounts.get(a.offset ?? '') ?? 0) + 1);
      const distinct  = group.filter(a => (a.offset ?? '') && offsetCounts.get(a.offset) === 1);
      const remainder = group.filter(a => !distinct.includes(a));
      const alignedOnly = remainder.filter(a => a.aligned === true);
      let kept = alignedOnly.length ? alignedOnly : remainder;
      if (_requestedEv && group.includes(_requestedEv) && !kept.includes(_requestedEv)) {
        kept = [...kept, _requestedEv];
      }
      filtered.push(...group.filter(a => kept.includes(a) || distinct.includes(a)));
    }
    // Re-sort by original JSON position so the dropdown reflects the order in cases.json.
    const _jsonOrder = caseEntry.events;
    filtered.sort((a, b) => _jsonOrder.indexOf(a) - _jsonOrder.indexOf(b));
    return filtered;
  })();

  // Build the full date-sorted audio list; sortedAudio entries are references to
  // the same objects, so indexOf comparisons work for 1-based position lookups.
  const allAudio = (caseEntry.events || []).filter(e => e.source !== 'otd');

  // Build audio select dropdown.
  // Each option's value = 1-based position of the entry in allAudio (the full list).
  // USSC audio was aligned by us (machine alignment), so always append " (USSC)"
  // as a signal that timing may not be optimal. When multiple entries for the same
  // type+date come from *different* sources (e.g. oyez and ussc), also suffix the
  // non-USSC source so the two can be distinguished. If all entries for a given
  // type+date share the same source (e.g. two oyez parts), no suffix is shown.
  const _sourceSuffixes = { oyez: ' (Oyez)', ussc: ' (USSC)', nara: ' (NARA)' };
  const _dupTypeDate = new Set();
  {
    const _seen = new Map(); // type:date → Set of distinct sources
    for (const a of sortedAudio) {
      if (a.type === 'opinion') continue;
      const k = (a.type || 'argument') + ':' + (a.date ?? '');
      if (!_seen.has(k)) _seen.set(k, new Set());
      _seen.get(k).add(a.source);
    }
    for (const [k, sources] of _seen) if (sources.size > 1) _dupTypeDate.add(k);
  }
  const audioSelect = document.getElementById('audio-select');
  audioSelect.innerHTML = '';
  sortedAudio.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = allAudio.indexOf(a) + 1;
    const _dtKey = (a.type || 'argument') + ':' + (a.date ?? '');
    const _alwaysSuffix = a.source === 'ussc';
    const _suffix = (_alwaysSuffix || _dupTypeDate.has(_dtKey))
      ? (_sourceSuffixes[a.source] ?? (' (' + (a.source || '').toUpperCase() + ')'))
      : '';
    opt.textContent = audioEntryLabel(a, _suffix);
    audioSelect.appendChild(opt);
  });
  // Append a sentinel option for each event with a `journal_ref`. The ref is
  // either "PAGE" (use the case's term journal) or "TERM:PAGE" (use a different
  // term's journal). The linked URL is `<journal_href>#page=<PAGE>`.
  // Journal entries appear before the decision sentinel so the decision is
  // always last.
  const { map: _jrMap, opts: _journalOpts } = _buildJournalRefOptions(caseEntry, term);
  _currentJournalRefs = _jrMap;
  _journalOpts.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.value;
    opt.textContent = j.title;
    audioSelect.appendChild(opt);
  });
  // Append sentinel option linking to the opinion, if available. (Always last.)
  if (caseEntry.opinion_href && caseEntry.decision) {
    const sentinelOpt = document.createElement('option');
    sentinelOpt.value = 'opinion';
    sentinelOpt.textContent = 'Decision on\u00a0' + formatDecisionDate(caseEntry.decision) + (caseEntry.usCite ? ' (' + caseEntry.usCite + ')' : '');
    audioSelect.appendChild(sentinelOpt);
  }
  // Append sentinel option linking to the Oyez case page, if available.
  if (caseEntry.oyez_href) {
    const oyezOpt = document.createElement('option');
    oyezOpt.value = 'oyez-page';
    oyezOpt.textContent = 'Description from The Oyez Project';
    audioSelect.appendChild(oyezOpt);
  }
  // Append sentinel options linking to On The Docket videos, if available.
  _currentVideoEntries.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = 'video:' + i;
    opt.textContent = v.title;
    audioSelect.appendChild(opt);
  });
  // Resolve audioIdx (1-based into caseEntry.events, or 0 = default) to a dropdown
  // option value. The dropdown values are 1-based positions within the
  // date-sorted `allAudio`, so translate via the underlying event reference.
  // If the requested entry was filtered out of the dropdown, fall back to the
  // first option.
  const _dropdownValues = [...audioSelect.options]
    .map(o => o.value)
    .filter(v => v !== 'opinion' && v !== 'oyez-page' && !v.startsWith('journal:') && !v.startsWith('video:'))
    .map(v => parseInt(v, 10));
  const _requestedEvent = (audioIdx >= 1 && caseEntry.events?.[audioIdx - 1]) || null;
  const _requestedAllAudioPos = _requestedEvent ? allAudio.indexOf(_requestedEvent) + 1 : 0;
  const resolvedOptionValue = (_requestedAllAudioPos >= 1 && _dropdownValues.includes(_requestedAllAudioPos))
    ? _requestedAllAudioPos
    : (_dropdownValues.find(v => allAudio[v - 1]?.audio_href) ?? _dropdownValues[0] ?? 1);
  audioSelect.value = String(resolvedOptionValue);

  // Update nav highlight now that resolvedOptionValue is known.
  document.querySelectorAll('.case-item').forEach(el => el.classList.remove('active'));
  const _activeKeys = [caseKey];
  if (caseEntry.number && caseEntry.id && caseEntry.id !== caseEntry.number)
    _activeKeys.push(term + '/' + caseEntry.number);
  if (caseEntry.number) {
    caseEntry.number.split(',').forEach(n => {
      const numKey = term + '/' + n.trim();
      if (!_activeKeys.includes(numKey)) _activeKeys.push(numKey);
    });
  }
  // The active sibling among collection items for this case is the one whose
  // audioDate matches the resolved event's date. When multiple siblings share
  // the same date (e.g. two consolidated dockets argued the same day), break
  // the tie using the 1-based event index stored on the element.
  const _resolvedDate = allAudio[resolvedOptionValue - 1]?.date || null;
  const _resolvedEventIdx = caseEntry.events.indexOf(allAudio[resolvedOptionValue - 1]) + 1; // 1-based, 0 if not found
  _activeKeys.forEach(k => document.querySelectorAll(`.case-item[data-case-key="${CSS.escape(k)}"]`)
    .forEach(el => {
      if (el.dataset.audioDate !== undefined &&
          _resolvedDate !== null &&
          el.dataset.audioDate !== _resolvedDate) return;
      if (el.dataset.eventIdx !== undefined &&
          _resolvedEventIdx >= 1 &&
          parseInt(el.dataset.eventIdx, 10) !== _resolvedEventIdx) return;
      el.classList.add('active');
    }));
  // When switching cases, collapse file lists for every non-active case.
  document.querySelectorAll('.case-item').forEach(el => {
    if (!el.classList.contains('active')) el.classList.remove('open');
  });

  // Store the full sorted list; the dropdown change handler indexes into it by 1-based value.
  _currentAudioList = allAudio;
  _currentEvents    = caseEntry.events || [];
  _currentBasePath  = basePath;
  _currentCaseEntry = caseEntry;

  // Update case title
  setCaseTitleLabel(term, caseEntry);
  document.title = caseTitle(caseEntry.title) + ' | Argument Aloud';

  const qEl = document.getElementById('case-questions');
  if (caseEntry.questions) {
    const raw = caseEntry.questions;
    const breakPos = raw.search(/\.\n/);
    const hasMore = breakPos !== -1;
    const firstPart = hasMore ? raw.slice(0, breakPos + 1) : raw;
    const firstSentence = firstPart.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

    qEl.title = raw;
    qEl.hidden = false;
    qEl.dataset.expanded = 'false';

    const showSummary = () => {
      qEl.innerHTML = '';
      qEl.dataset.expanded = 'false';

      const textEl = document.createElement('div');
      textEl.className = 'questions-text clamped';
      textEl.textContent = firstSentence;
      qEl.appendChild(textEl);

      // [More] is a sibling outside the clamped div so it isn't hidden by overflow.
      requestAnimationFrame(() => {
        const isClamped = textEl.scrollHeight > textEl.clientHeight;
        if (isClamped || hasMore) {
          const more = document.createElement('span');
          more.className = 'questions-more';
          more.textContent = '[More]';
          qEl.appendChild(more);
          qEl.style.cursor = 'pointer';
          qEl.onclick = expandFn;
        }
      });
    };

    const expandFn = () => {
      if (qEl.dataset.expanded === 'true') {
        showSummary();
      } else {
        qEl.innerHTML = '';
        qEl.classList.remove('clamped');
        raw.split(/\n(?=[ \t])/).forEach(chunk => {
          const p = document.createElement('p');
          p.textContent = chunk.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
          qEl.appendChild(p);
        });
        qEl.dataset.expanded = 'true';
      }
    };

    showSummary();

    // cursor/onclick for hasMore is set via rAF inside showSummary;
    // for no-more single-sentence cases, clear them here (rAF will re-add if actually clamped).
    if (!hasMore) {
      qEl.style.cursor = '';
      qEl.onclick = null;
    }
  } else {
    qEl.textContent = '';
    qEl.title = '';
    qEl.hidden = true;
    qEl.onclick = null;
    qEl.style.cursor = '';
  }

  const rawFiles = caseEntry.files ? await loadFiles(basePath + 'files.json') : [];
  links = rawFiles.filter(f => f.refs);

  playerSection.hidden = false;
  audioControls.hidden = false;
  pageViewer.hidden = true;
  transcriptViewer.hidden = false;
  emptyState.style.display = 'none';
  const _initialEntry = allAudio[resolvedOptionValue - 1];
  const _entryForLoad = (Number.isInteger(initialTurn) && initialTurn > 0)
    ? { ...withTranscriptFallback(_initialEntry, _currentEvents), turn: initialTurn }
    : withTranscriptFallback(_initialEntry, _currentEvents);
  await loadAudioEntry(_entryForLoad, basePath);
  _setCaseNotes(_initialEntry?.notes || caseEntry.notes || '');

  if (isMobile()) {
    playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
    setMobileNavVisible(false);
  }
}

// ── Render transcript ───────────────────────────────────────────────────────

function renderTranscript() {
  const frag = document.createDocumentFragment();
  const speakerMap = new Map(caseSpeakers.map(s => [s.name, s]));
  turns.forEach((turn, idx) => {
    const div = document.createElement('div');
    const spkr = speakerMap.get(turn.name) || turn.name;
    div.className = 'turn ' + speakerClass(spkr);
    div.id = 'turn-' + idx;
    div.setAttribute('role', 'listitem');

    const sp = document.createElement('span');
    sp.className = 'speaker';

    const tx = document.createElement('span');
    tx.className = 'turn-text';

    if (_editMode) {
      // Speaker: dropdown of all speakers in this transcript
      const editedTurn = _getEditedTurn(idx);
      if (editedTurn) div.classList.add('turn-modified');
      const currentName = editedTurn?.name ?? turn.name;
      const sel = document.createElement('select');
      sel.className = 'speaker-edit-select';
      if (_unknownSpeakerNames.has(currentName)) sel.classList.add('speaker-unknown');
      caseSpeakers.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = formatSpeakerFull(s);
        if (s.name === currentName) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('click', e => e.stopPropagation());
      sel.addEventListener('change', () => {
        const newName = sel.value;
        sel.classList.toggle('speaker-unknown', _unknownSpeakerNames.has(newName));
        _saveEditedTurn(idx, { name: newName });
        const newSpkr = new Map(caseSpeakers.map(s => [s.name, s])).get(newName) || { name: newName };
        div.className = 'turn ' + speakerClass(newSpkr) + (_getEditedTurn(idx) ? ' turn-modified' : '');
      });
      sp.appendChild(sel);

      // Turn text: contenteditable
      tx.textContent = editedTurn?.text ?? turn.text;
      tx.contentEditable = 'true';
      tx.spellcheck = false;
      tx.addEventListener('click', e => {
        e.stopPropagation();
        if (turn.time != null) audio.currentTime = turnTimes[idx];
      });
      tx.addEventListener('blur', () => {
        _saveEditedTurn(idx, { text: tx.textContent });
        div.classList.toggle('turn-modified', _getEditedTurn(idx) !== null);
      });
      tx.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); tx.blur(); }
      });
    } else {
      // Normal mode: static speaker label
      sp.textContent = formatSpeaker(spkr);
      if (_unknownSpeakerNames.has(typeof spkr === 'string' ? spkr : spkr.name)) sp.classList.add('speaker-unknown');
      renderTurnText(tx, turn.text, null, false);

      // Make non-justice speaker labels clickable links to advocate profiles.
      const spkrTitle = typeof spkr === 'object' ? (spkr.title || 'MR.') : '';
      const spkrName  = typeof spkr === 'object' ? spkr.name : spkr;
      const isAdvocate = spkrTitle && spkrTitle !== 'CHIEF JUSTICE' && spkrTitle !== 'JUSTICE'
                         && !_unknownSpeakerNames.has(spkrName);
      const isJustice = (spkrTitle === 'CHIEF JUSTICE' || spkrTitle === 'JUSTICE')
                        && !_unknownSpeakerNames.has(spkrName);
      if (isAdvocate) {
        sp.classList.add('speaker-link');
        sp.addEventListener('click', (e) => {
          e.stopPropagation();
          const advocateId = _makeAdvocateId(typeof spkr === 'object' ? spkr.name : String(spkr));
          if (!advocateId) return;
          // Build URL with turn so Back returns here.
          const turnId = turn.turn ?? (idx + 1);
          const activeCI = document.querySelector('.case-item.active');
          const caseKey = activeCI?.dataset.caseKey || '';
          const slashIdx = caseKey.indexOf('/');
          const ciTerm = slashIdx >= 0 ? caseKey.slice(0, slashIdx) : '';
          const ciCase = slashIdx >= 0 ? caseKey.slice(slashIdx + 1) : '';
          // Get the current event index (1-based) from the audio selector
          const audioSelect = document.getElementById('audio-select');
          const currentEvent = audioSelect && !audioSelect.hidden && audioSelect.value
            ? parseInt(audioSelect.value, 10)
            : 0;
          const turnUrl = (ciTerm && ciCase)
            ? buildUrlParams(
                { term: ciTerm, case: ciCase, turn: turnId, ...(currentEvent > 0 ? { event: currentEvent } : {}) },
                ['collection', 'group', 'id', 'highlight', 'file', 'link']
              )
            : buildUrlParams({ turn: turnId });
          history.replaceState(null, '', turnUrl);
          const collectionId = spkrTitle.split(',').map(t => t.trim())
            .some(t => t === 'MS.' || t === 'MRS.' || t === 'MISS') ? 'women_advocates' : 'all_advocates';
          const advocateUrlParams = { collection: collectionId, id: advocateId };
          if (ciTerm && ciCase) {
            advocateUrlParams.term = ciTerm;
            advocateUrlParams.case = ciCase;
            advocateUrlParams.turn = turnId;
            if (currentEvent > 0) advocateUrlParams.event = currentEvent;
          }
          const advocateUrl = buildUrlParams(
            advocateUrlParams,
            ['file', 'highlight', 'group', 'link'],
          );
          navigate(advocateUrl);
          // On mobile, after the transcript loads scroll the doc-browser so the
          // selected case in the advocate's list is at the top.
          if (isMobile()) {
            document.addEventListener('transcriptloaded', () => {
              const activeCase = document.querySelector('.case-item.active');
              const docBrowser = document.getElementById('doc-browser');
              if (activeCase && docBrowser) {
                const caseTop = activeCase.getBoundingClientRect().top - docBrowser.getBoundingClientRect().top;
                docBrowser.scrollTop = Math.max(0, docBrowser.scrollTop + caseTop - 8);
              }
            }, { once: true });
          }
          restoreFromURL();
        });
      } else if (isJustice) {
        sp.classList.add('speaker-link');
        sp.addEventListener('click', (e) => {
          e.stopPropagation();
          const justiceId = _makeAdvocateId(spkrName);
          if (!justiceId) return;
          const turnId = turn.turn ?? (idx + 1);
          const activeCI = document.querySelector('.case-item.active');
          const caseKey = activeCI?.dataset.caseKey || '';
          const slashIdx = caseKey.indexOf('/');
          const ciTerm = slashIdx >= 0 ? caseKey.slice(0, slashIdx) : '';
          const ciCase = slashIdx >= 0 ? caseKey.slice(slashIdx + 1) : '';
          const audioSelect = document.getElementById('audio-select');
          const currentEvent = audioSelect && !audioSelect.hidden && audioSelect.value
            ? parseInt(audioSelect.value, 10)
            : 0;
          const turnUrl = (ciTerm && ciCase)
            ? buildUrlParams(
                { term: ciTerm, case: ciCase, turn: turnId, ...(currentEvent > 0 ? { event: currentEvent } : {}) },
                ['collection', 'group', 'id', 'highlight', 'file', 'link']
              )
            : buildUrlParams({ turn: turnId });
          history.replaceState(null, '', turnUrl);
          const justiceUrlParams = { collection: 'vocal_justices', id: justiceId };
          if (ciTerm && ciCase) {
            justiceUrlParams.term = ciTerm;
            justiceUrlParams.case = ciCase;
            justiceUrlParams.turn = turnId;
            if (currentEvent > 0) justiceUrlParams.event = currentEvent;
          }
          const justiceUrl = buildUrlParams(
            justiceUrlParams,
            ['file', 'highlight', 'group', 'link'],
          );
          navigate(justiceUrl);
          if (isMobile()) {
            document.addEventListener('transcriptloaded', () => {
              const activeCase = document.querySelector('.case-item.active');
              const docBrowser = document.getElementById('doc-browser');
              if (activeCase && docBrowser) {
                const caseTop = activeCase.getBoundingClientRect().top - docBrowser.getBoundingClientRect().top;
                docBrowser.scrollTop = Math.max(0, docBrowser.scrollTop + caseTop - 8);
              }
            }, { once: true });
          }
          restoreFromURL();
        });
      }
    }

    div.appendChild(sp);
    div.appendChild(tx);
    div.addEventListener('click', () => {
      const alreadyActive = idx === activeTurnIdx;
      if (alreadyActive) {
        // Re-clicking the active turn toggles play/pause
        if (turn.time != null) {
          audio.paused ? audio.play().catch(() => {}) : audio.pause();
        }
        return;
      }
      const wasPlaying = !audio.paused;
      if (activeTurnIdx >= 0) {
        document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
      }
      div.classList.add('active');
      activeTurnIdx = idx;
      const hadRef = checkLinksForActiveTurn(idx, true);
      if (!hadRef) collapseDocViewer();
      // Seek to the new turn; only play if audio was already playing
      if (turn.time != null) {
        audio.currentTime = turnTimes[idx];
        if (wasPlaying) audio.play().catch(() => {});
      } else {
        div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      // Update URL with turn number, re-anchoring to the case that owns this transcript
      // (the URL term/case may have drifted if the user expanded a different term).
      const turnId = turn.turn ?? (idx + 1);
      const activeCI = document.querySelector('.case-item.active');
      const caseKey = activeCI?.dataset.caseKey || '';
      const slashIdx = caseKey.indexOf('/');
      const ciTerm = slashIdx >= 0 ? caseKey.slice(0, slashIdx) : '';
      const ciCase = slashIdx >= 0 ? caseKey.slice(slashIdx + 1) : '';
      let url;
      if (ciTerm && ciCase) {
        // Get the current event index from the audio selector
        const audioSelect = document.getElementById('audio-select');
        const currentEvent = audioSelect && !audioSelect.hidden && audioSelect.value
          ? parseInt(audioSelect.value, 10)
          : 0;
        // If we're already viewing within a collection, preserve collection/id/group/event
        // so the advocate context stays in the URL. The user can click the case title
        // link to return to the plain term view.
        const inCollection = !!new URLSearchParams(location.search).get('collection');
        url = buildUrlParams(
          { term: ciTerm, case: ciCase, ...(currentEvent > 0 ? { event: currentEvent } : {}), turn: turnId },
          inCollection
            ? ['highlight', 'file', 'link']
            : ['collection', 'group', 'id', 'highlight', 'file', 'link']);
        // Desktop only: keep the active case visible in the sidebar. On mobile,
        // tapping a turn should not shift the viewport or reveal the explorer pane.
        // Skip when in a collection view — the collection item is already visible.
        if (activeCI && !isMobile() && !inCollection) {
          activeCI.closest('.term-group')?.classList.add('open');
          activeCI.closest('.decade-group')?.classList.add('open');
          activeCI.closest('[data-section="terms"]')?.classList.add('open');
          requestAnimationFrame(() => activeCI.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
        }
      } else {
        url = buildUrlParams({ turn: turnId });
      }
      history.replaceState(null, '', url);
    });
    frag.appendChild(div);
  });
  turnList.appendChild(frag);
}

// ── Sync highlight on playback ──────────────────────────────────────────────

audio.addEventListener('timeupdate', () => {
  if (!hasTimes) return;
  if (_suppressTimeupdateBeforeSeek) return;
  const idx = findCurrentTurn(audio.currentTime);
  if (idx === activeTurnIdx) return;

  if (activeTurnIdx >= 0) {
    document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
  }
  if (idx >= 0) {
    const el = document.getElementById('turn-' + idx);
    if (el) {
      el.classList.add('active');
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  activeTurnIdx = idx;
  checkLinksForActiveTurn(idx);
});

// ── Audio entry dropdown ──────────────────────────────────────────────────
document.getElementById('audio-select').addEventListener('change', async (e) => {
  // Always reset to case-level notes first; audio entry selection below will
  // override with event-specific notes if the chosen entry has any.
  _setCaseNotes(_currentCaseEntry?.notes || '');
  if (e.target.value === 'opinion') {
    if (_currentOpinionHref) {
      showDocViewer({ href: _currentOpinionHref, title: document.getElementById('case-title-label')?.textContent || 'Opinion' }, { force: true });
    }
    return;
  }
  if (e.target.value === 'oyez-page') {
    if (_currentOyezHref) {
      showDocViewer({ href: _currentOyezHref, title: 'Description from The Oyez Project', view: 'pane' }, { force: true });
    }
    return;
  }
  if (e.target.value.startsWith('video:')) {
    const idx = parseInt(e.target.value.slice(6), 10);
    const v = _currentVideoEntries[idx];
    if (v) showDocViewer({ href: toEmbedUrl(v.href), title: v.title, view: 'pane' }, { force: true });
    return;
  }
  if (typeof e.target.value === 'string' && e.target.value.startsWith('journal:')) {
    const entry = _currentJournalRefs.get(e.target.value);
    if (entry) {
      showDocViewer({ href: entry.href, title: entry.title }, { force: true });
    }
    return;
  }
  const val = parseInt(e.target.value, 10); // 1-based index into the date-sorted audio list
  if (_currentAudioList[val - 1] && _currentBasePath) {
    const selectedEntry = _currentAudioList[val - 1];
    // If the user is switching back to the already-loaded entry (e.g. after
    // opening a document-only option like "Decision..."), just dismiss the
    // doc viewer without reloading — this preserves activeTurnIdx and audio state.
    if (selectedEntry === _currentLoadedEntry) {
      const docPanel = document.getElementById('doc-viewer');
      if (!docPanel.hidden && !docPanel.classList.contains('collapsed')) {
        collapseDocViewer();
      }
      return;
    }
    const url = new URL(location.href);
    // Translate the allAudio position back to a 1-based events[] index so the
    // URL `event` param is stable across re-sorts and matches the on-disk schema.
    const evIdx = _currentEvents.indexOf(selectedEntry) + 1;
    const updates = {};
    if (evIdx >= 1) updates.event = evIdx;
    const deletes = ['turn', 'file'];
    if (evIdx < 1) deletes.push('event');
    const newUrl = buildUrlParams(updates, deletes);
    history.replaceState(null, '', newUrl);
    await loadAudioEntry(withTranscriptFallback(selectedEntry, _currentEvents), _currentBasePath);
    _setCaseNotes(selectedEntry.notes || _currentCaseEntry?.notes || '');
    if (isMobile()) {
      playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
      setMobileNavVisible(false);
    }
  }
});

// ── Prev / Next turn buttons ──────────────────────────────────────────────
function jumpToTurn(target) {
  // Cancel any pending initial-seek re-affirmation: the user has explicitly
  // navigated, so the seeked listener must not revert activeTurnIdx afterward.
  if (_pendingSeekListener) {
    audio.removeEventListener('seeked', _pendingSeekListener);
    _pendingSeekListener = null;
    _suppressTimeupdateBeforeSeek = false;
  }
  if (activeTurnIdx >= 0) {
    document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
  }
  const el = document.getElementById('turn-' + target);
  if (el) {
    el.classList.add('active');
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  activeTurnIdx = target;
  checkLinksForActiveTurn(target);
  const _turnNum = turns[target]?.turn ?? (target + 1);
  const _turnUrl = new URL(location.href);
  _turnUrl.searchParams.set('turn', _turnNum);
  history.replaceState(null, '', _turnUrl);
  if (turns[target]?.time != null) {
    const wasPlaying = !audio.paused;
    audio.currentTime = turnTimes[target];
    if (wasPlaying) audio.play();
  }
}

document.getElementById('prev-turn-btn').addEventListener('click', () => {
  if (!turns.length) return;
  const current = activeTurnIdx >= 0 ? activeTurnIdx : (hasTimes ? findCurrentTurn(audio.currentTime) : 0);
  jumpToTurn(Math.max(0, current > 0 ? current - 1 : 0));
});

document.getElementById('next-turn-btn').addEventListener('click', () => {
  if (!turns.length) return;
  const current = activeTurnIdx >= 0 ? activeTurnIdx : (hasTimes ? findCurrentTurn(audio.currentTime) : -1);
  jumpToTurn(Math.min(turns.length - 1, current + 1));
});

// ── Prev / Next speaker buttons ───────────────────────────────────────────
document.getElementById('prev-speaker-btn').addEventListener('click', () => {
  const current = activeTurnIdx >= 0 ? activeTurnIdx : (hasTimes ? findCurrentTurn(audio.currentTime) : -1);
  if (current < 0) return;
  const speaker = turns[current]?.name;
  if (!speaker) return;
  for (let i = current - 1; i >= 0; i--) {
    if (turns[i]?.name === speaker) { jumpToTurn(i); return; }
  }
});

document.getElementById('next-speaker-btn').addEventListener('click', () => {
  const current = activeTurnIdx >= 0 ? activeTurnIdx : (hasTimes ? findCurrentTurn(audio.currentTime) : -1);
  if (current < 0) return;
  const speaker = turns[current]?.name;
  if (!speaker) return;
  for (let i = current + 1; i < turns.length; i++) {
    if (turns[i]?.name === speaker) { jumpToTurn(i); return; }
  }
});

// ── Case info: tap to scroll back to document browser on mobile ──────────
const mobileBackBtn = document.getElementById('mobile-back-btn');
let _mobileNavVisible = false;

function setMobileNavVisible(visible) {
  _mobileNavVisible = visible;
  mobileBackBtn.textContent = visible ? '\u25b2' : '\u25bc';
  mobileBackBtn.title = visible ? 'Back to transcript' : 'Back to case list';
  mobileBackBtn.setAttribute('aria-label', visible ? 'Back to transcript' : 'Back to case list');
}

mobileBackBtn.addEventListener('click', () => {
  if (_mobileNavVisible) {
    playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
    setMobileNavVisible(false);
  } else {
    window.scrollTo({ top: 0, behavior: 'instant' });
    setMobileNavVisible(true);
  }
});

// ── Document Viewer close button ──────────────────────────────────────────
document.getElementById('doc-viewer-close').addEventListener('click', (e) => {
  e.stopPropagation();
  hideDocViewerFully();
  const url = new URL(location.href);
  url.searchParams.delete('file');
  history.replaceState(null, '', url);
});

document.getElementById('doc-viewer-minimize').addEventListener('click', (e) => {
  e.stopPropagation();
  collapseDocViewer();
});

document.getElementById('doc-viewer-expand').addEventListener('click', (e) => {
  e.stopPropagation();
  expandDocViewer();
});

document.getElementById('doc-viewer-header').addEventListener('click', () => {
  const panel = document.getElementById('doc-viewer');
  if (panel.classList.contains('collapsed')) expandDocViewer();
});

// ── Resize handles ────────────────────────────────────────────────────────────
(function() {
  // Vertical: document browser ↔ main panel (desktop)
  const vHandle         = document.getElementById('v-resize');
  const docBrowserPanel = document.getElementById('doc-browser');
  let vDragging = false, vStartX = 0, vStartW = 0;

  // Transparent overlay placed over iframes during drag to prevent them
  // from swallowing mouse events when the cursor moves over them quickly.
  const dragShield = document.createElement('div');
  dragShield.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none';
  document.body.appendChild(dragShield);

  vHandle.addEventListener('mousedown', e => {
    vDragging = true;
    vStartX = e.clientX;
    vStartW = docBrowserPanel.offsetWidth;
    vHandle.classList.add('dragging');
    dragShield.style.cursor = 'col-resize';
    dragShield.style.display = 'block';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  const browser = document.getElementById('browser');
  const MIN_RIGHT_PANE = 200; // px — minimum space to leave for the right pane

  function clampSidebarWidth() {
    // In mobile layout the CSS handles sizing; writing an inline px value here
    // would then persist as a wrong fixed width when the window grows back above
    // the breakpoint and the media-query override is removed.
    if (window.innerWidth <= 768) {
      docBrowserPanel.style.width = '';
      return;
    }
    const max = browser.offsetWidth - MIN_RIGHT_PANE;
    const cur = docBrowserPanel.offsetWidth;
    if (cur > max) docBrowserPanel.style.width = Math.max(140, max) + 'px';
  }
  window.addEventListener('resize', clampSidebarWidth);

  document.addEventListener('mousemove', e => {
    if (!vDragging) return;
    const max = browser.offsetWidth - MIN_RIGHT_PANE;
    const w = Math.max(140, Math.min(max, vStartW + (e.clientX - vStartX)));
    docBrowserPanel.style.width = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!vDragging) return;
    vDragging = false;
    vHandle.classList.remove('dragging');
    dragShield.style.display = 'none';
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Touch events for vertical resize (iPad / touch screens)
  vHandle.addEventListener('touchstart', e => {
    if (window.innerWidth <= 768) return; // mobile layout: handle hidden
    vDragging = true;
    vStartX = e.touches[0].clientX;
    vStartW = docBrowserPanel.offsetWidth;
    vHandle.classList.add('dragging');
    document.body.style.userSelect = 'none';
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!vDragging) return;
    const max = browser.offsetWidth - MIN_RIGHT_PANE;
    const w = Math.max(140, Math.min(max, vStartW + (e.touches[0].clientX - vStartX)));
    docBrowserPanel.style.width = w + 'px';
  }, { passive: false });

  document.addEventListener('touchend', () => {
    if (!vDragging) return;
    vDragging = false;
    vHandle.classList.remove('dragging');
    document.body.style.userSelect = '';
  });

  // Horizontal: transcript viewer ↔ document viewer
  const hHandle        = document.getElementById('h-resize');
  const docViewerPanel = document.getElementById('doc-viewer');
  let hDragging = false, hStartY = 0, hStartH = 0;

  hHandle.addEventListener('mousedown', e => {
    hDragging = true;
    hStartY = e.clientY;
    hStartH = docViewerPanel.offsetHeight;
    hHandle.classList.add('dragging');
    docViewerPanel.style.transition = 'none'; // disable animation while dragging
    dragShield.style.cursor = 'row-resize';
    dragShield.style.display = 'block';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!hDragging) return;
    // Dragging up (negative delta) grows the panel
    const h = Math.max(60, Math.min(window.innerHeight * 0.85, hStartH - (e.clientY - hStartY)));
    docViewerPanel.style.height = h + 'px';
    docViewerOpenHeight = h;
  });

  document.addEventListener('mouseup', () => {
    if (!hDragging) return;
    hDragging = false;
    hHandle.classList.remove('dragging');
    docViewerPanel.style.transition = ''; // restore CSS transition
    dragShield.style.display = 'none';
    document.body.style.userSelect = '';
  });
})();

// ── Mobile horizontal resize: doc-browser ↔ main-panel ───────────────────────
(function() {
  const handle    = document.getElementById('h-mobile-resize');
  const navPanel  = document.getElementById('doc-browser');
  let dragging = false, startY = 0, startH = 0;

  function onStart(clientY) {
    if (!isMobile()) return;
    dragging = true;
    startY = clientY;
    startH = navPanel.offsetHeight;
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
  }

  function onMove(clientY) {
    if (!dragging) return;
    // Dragging down increases the nav panel height; cap between 80px and 80vh.
    const maxH = Math.round(window.innerHeight * 0.80);
    const h = Math.max(80, Math.min(maxH, startH + (clientY - startY)));
    navPanel.style.maxHeight = h + 'px';
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';
  }

  // Mouse events (desktop/emulated)
  handle.addEventListener('mousedown', e => { onStart(e.clientY); e.preventDefault(); });
  document.addEventListener('mousemove', e => { if (dragging) onMove(e.clientY); });
  document.addEventListener('mouseup', onEnd);

  // Touch events
  handle.addEventListener('touchstart', e => { onStart(e.touches[0].clientY); }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (dragging) { onMove(e.touches[0].clientY); e.preventDefault(); }
  }, { passive: false });
  document.addEventListener('touchend', onEnd);
})();

// ── Transcript search ────────────────────────────────────────────────────────
(function () {
  const overlay     = document.getElementById('search-overlay');
  const input       = document.getElementById('search-input');
  const prevBtn     = document.getElementById('search-prev');
  const nextBtn     = document.getElementById('search-next');
  const closeBtn    = document.getElementById('search-close');
  const statusEl    = document.getElementById('search-status');
  const searchTrigger = document.getElementById('search-btn');
  const refsRow     = document.getElementById('search-refs-row');
  const refsSelect  = document.getElementById('search-refs');
  const speakersRow   = document.getElementById('search-speakers-row');
  const speakerSelect = document.getElementById('search-speakers');

  let matchIndices = [];   // indices into turns[] that contain the query
  let matchCursor  = -1;   // which match is currently highlighted

  function openSearch() {
    overlay.classList.add('open');
    input.focus();
    input.select();
  }

  function closeSearch() {
    overlay.classList.remove('open');
    // If a search match was navigated to, make it the selected (active) turn
    // without changing play/pause state.
    if (matchCursor >= 0) {
      const targetIdx = matchIndices[matchCursor];
      if (targetIdx !== activeTurnIdx) {
        if (activeTurnIdx >= 0) {
          document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
        }
        document.getElementById('turn-' + targetIdx)?.classList.add('active');
        activeTurnIdx = targetIdx;
        checkLinksForActiveTurn(targetIdx);
        if (turns[targetIdx]?.time != null) {
          const wasPlaying = !audio.paused;
          audio.currentTime = turnTimes[targetIdx];
          if (wasPlaying) audio.play().catch(() => {});
        }
      }
    }
    clearHighlights();
    matchIndices = [];
    matchCursor  = -1;
    statusEl.textContent = '';
  }

  function clearHighlights() {
    document.querySelectorAll('.search-current').forEach(el => el.classList.remove('search-current'));
    const visited = new Set();
    document.querySelectorAll('.turn-highlight').forEach(el => {
      const turnEl = el.closest('[id^="turn-"]');
      if (!turnEl || visited.has(turnEl.id)) return;
      visited.add(turnEl.id);
      const idx = parseInt(turnEl.id.slice(5), 10);
      const textEl = turnEl.querySelector('.turn-text');
      if (textEl && turns[idx]) renderTurnText(textEl, turns[idx].text, null, false);
    });
  }

  // Unified match computation: filters by selected speaker and/or text query.
  function computeMatches() {
    clearHighlights();
    matchIndices = [];
    const query   = input.value.trim();
    const speaker = speakerSelect.value;
    if (!query && !speaker) { updateStatus(); return; }
    const queryLower = query ? query.toLowerCase() : null;
    turns.forEach((turn, idx) => {
      if (speaker && turn.name !== speaker) return;
      if (queryLower && !turn.text.toLowerCase().includes(queryLower)) return;
      matchIndices.push(idx);
    });
    updateStatus();
    // Re-render matching turns with highlighted spans only when text is entered.
    if (query) matchIndices.forEach(idx => applyHighlight(idx, query, false));
  }

  function applyHighlight(turnIdx, query, isCurrent) {
    const el = document.getElementById('turn-' + turnIdx);
    if (!el) return;
    const textEl = el.querySelector('.turn-text');
    if (!textEl) return;
    renderTurnText(textEl, turns[turnIdx].text, query, isCurrent);
  }

  function scrollToMatch(idx) {
    const el = document.getElementById('turn-' + idx);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function updateStatus() {
    if (!matchIndices.length) {
      statusEl.textContent = (input.value.trim() || speakerSelect.value) ? 'No matches found.' : '';
    } else {
      statusEl.textContent = (matchCursor >= 0 ? (matchCursor + 1) + ' of ' : '') + matchIndices.length + ' match' + (matchIndices.length === 1 ? '' : 'es');
    }
    prevBtn.disabled = matchIndices.length === 0;
    nextBtn.disabled = matchIndices.length === 0;
  }

  function goToMatch(delta) {
    if (!matchIndices.length) return;
    const query = input.value.trim();
    // Remove 'current' styling from previous match
    if (matchCursor >= 0) {
      applyHighlight(matchIndices[matchCursor], query, false);
      document.getElementById('turn-' + matchIndices[matchCursor])?.classList.remove('search-current');
    }
    matchCursor = (matchCursor + delta + matchIndices.length) % matchIndices.length;
    applyHighlight(matchIndices[matchCursor], query, true);
    document.getElementById('turn-' + matchIndices[matchCursor])?.classList.add('search-current');
    scrollToMatch(matchIndices[matchCursor]);
    updateStatus();
  }

  // Open
  searchTrigger.addEventListener('click', openSearch);

  // Close on overlay backdrop click
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSearch(); });

  // Close button
  closeBtn.addEventListener('click', closeSearch);

  // Escape closes; Space toggles play/pause
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeSearch();
    if (e.key === ' ' && !overlay.classList.contains('open')) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;
      if (audio.src && !playerSection.hidden) {
        e.preventDefault();
        audio.paused ? audio.play().catch(() => {}) : audio.pause();
      }
    }
  });

  // Search on Enter; Shift+Enter goes backwards
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query   = input.value.trim();
      const speaker = speakerSelect.value;
      if (!query && !speaker) return;
      const key = query.toLowerCase() + '|' + speaker;
      if (!matchIndices.length || key !== (input.dataset.lastSearchKey ?? '')) {
        computeMatches();
        input.dataset.lastSearchKey = key;
        if (matchIndices.length) { matchCursor = -1; goToMatch(e.shiftKey ? -1 : 1); }
      } else {
        if (e.shiftKey) goToMatch(-1); else goToMatch(1);
      }
    }
  });

  // Clear stale results as user edits the query (speaker selection is preserved).
  input.addEventListener('input', () => {
    refsSelect.value = '';
    if (matchIndices.length || input.dataset.lastSearchKey) {
      clearHighlights();
      matchIndices = [];
      matchCursor = -1;
      delete input.dataset.lastSearchKey;
      updateStatus();
    }
  });

  function runSearchAndGo(delta) {
    const query   = input.value.trim();
    const speaker = speakerSelect.value;
    if (!query && !speaker) return;
    if (!matchIndices.length) {
      computeMatches();
      input.dataset.lastSearchKey = query.toLowerCase() + '|' + speaker;
      if (matchIndices.length) { matchCursor = -1; goToMatch(delta > 0 ? 1 : -1); }
    } else {
      goToMatch(delta);
    }
  }

  nextBtn.addEventListener('click', () => runSearchAndGo(1));
  prevBtn.addEventListener('click', () => runSearchAndGo(-1));

  // Clear highlights whenever a new transcript is loaded
  document.addEventListener('transcriptloaded', () => {
    matchIndices = [];
    matchCursor  = -1;
    input.value  = '';
    statusEl.textContent = '';
    delete input.dataset.lastSearchKey;
    // Populate speaker dropdown
    speakerSelect.innerHTML = '<option value="">All Speakers</option>';
    if (caseSpeakers.length) {
      const titleOrder = t => (t === 'JUSTICE' || t === 'CHIEF JUSTICE') ? 0 : 1;
      [...caseSpeakers]
        .sort((a, b) => {
          const aTitle = a.title ?? (a.role === 'justice' ? 'JUSTICE' : '');
          const bTitle = b.title ?? (b.role === 'justice' ? 'JUSTICE' : '');
          return titleOrder(aTitle) - titleOrder(bTitle)
            || formatSpeaker(a).localeCompare(formatSpeaker(b));
        })
        .forEach(speaker => {
        const opt = document.createElement('option');
        opt.value = speaker.name;
        opt.textContent = formatSpeaker(speaker);
        opt.title = speaker.name;
        speakerSelect.appendChild(opt);
      });
      speakersRow.classList.add('has-speakers');
    } else {
      speakersRow.classList.remove('has-speakers');
    }
    // Populate refs dropdown from current links
    const refTexts = links.flatMap(l => getRefTexts(l));
    const unique = [...new Set(refTexts)].sort((a, b) => a.localeCompare(b));
    refsSelect.innerHTML = `<option value=""></option>`;
    if (unique.length) {
      unique.forEach(ref => {
        const opt = document.createElement('option');
        opt.value = ref;
        opt.textContent = ref;
        refsSelect.appendChild(opt);
      });
      refsRow.classList.add('has-refs');
    } else {
      refsRow.classList.remove('has-refs');
    }
  });

  refsSelect.addEventListener('change', () => {
    const ref = refsSelect.value;
    if (!ref) {
      input.value = '';
      clearHighlights();
      matchIndices = [];
      matchCursor = -1;
      delete input.dataset.lastSearchKey;
      updateStatus();
      input.focus();
      return;
    }
    input.value = ref;
    // Clear stale state and run search immediately
    clearHighlights();
    matchIndices = [];
    matchCursor = -1;
    delete input.dataset.lastSearchKey;
    computeMatches();
    input.dataset.lastSearchKey = ref.toLowerCase() + '|' + speakerSelect.value;
    if (matchIndices.length) { matchCursor = -1; goToMatch(1); }
    input.focus();
  });

  speakerSelect.addEventListener('change', () => {
    // Re-run search with updated speaker filter.
    clearHighlights();
    matchIndices = [];
    matchCursor = -1;
    delete input.dataset.lastSearchKey;
    const query   = input.value.trim();
    const speaker = speakerSelect.value;
    if (query || speaker) {
      computeMatches();
      input.dataset.lastSearchKey = query.toLowerCase() + '|' + speaker;
      if (matchIndices.length) { matchCursor = -1; goToMatch(1); }
    } else {
      updateStatus();
    }
  });
})();

// Find a rendered file-item element by the URL 'file' param value.
// Supports both numeric IDs (data-file-id) and href-basename strings (data-file-href).
function findFileItem(param) {
  if (param == null) return null;
  const s = String(param);
  // Numeric ID — existing files.json entries
  if (/^\d+$/.test(s)) return document.querySelector(`.file-item[data-file-id="${CSS.escape(s)}"]`);
  // Href filename — virtual/injected files: match data-file-href ending with the param
  return document.querySelector(`.file-item[data-file-href$="${CSS.escape('/' + s)}"]`)
      || document.querySelector(`.file-item[data-file-href="${CSS.escape(s)}"]`);
}

// ── Nav case search ───────────────────────────────────────────────────────────
(function () {
  const navSearchBtn   = document.getElementById('nav-search-btn');
  const navSearchRow   = document.getElementById('nav-search-row');
  const navSearchInput = document.getElementById('nav-search-input');
  const navSearchClear = document.getElementById('nav-search-clear');

  function openNavSearch() {
    navSearchRow.hidden = false;
    navSearchBtn.classList.add('active');
    navSearchInput.focus();
    navSearchInput.select();
    loadAllTermsForSearch();
  }

  function closeNavSearch() {
    navSearchRow.hidden = true;
    navSearchBtn.classList.remove('active');
    navSearchInput.value = '';
    runNavSearch('');
  }

  function runNavSearch(query) {
    const q = query.trim().toLowerCase();
    const termsSectionEl = document.querySelector('[data-section="terms"]');
    if (!termsSectionEl) return;

    if (!q) {
      termsSectionEl.querySelectorAll('.case-item').forEach(ci => {
        ci.classList.remove('nav-search-match');
        ci.style.display = '';
      });
      termsSectionEl.querySelectorAll('.term-group, .decade-group').forEach(g => {
        g.style.display = '';
        g.classList.remove('open');
      });
      termsSectionEl.style.display = '';
      termsSectionEl.classList.remove('open');
      // Expand only the groups containing the currently active case
      const activeCase = document.querySelector('.case-item.active');
      if (activeCase) {
        activeCase.closest('.term-group')?.classList.add('open');
        activeCase.closest('.decade-group')?.classList.add('open');
        activeCase.closest('[data-section="terms"]')?.classList.add('open');
        requestAnimationFrame(() => activeCase.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }
      return;
    }

    termsSectionEl.querySelectorAll('.case-item').forEach(ci => {
      const title      = ci.querySelector('.case-title-nav')?.textContent.toLowerCase() || '';
      const caseKeyTail = (ci.dataset.caseKey || '').split('/').pop().toLowerCase();
      const caseNumber = (ci.dataset.caseNumber || '').toLowerCase();
      const matches    = title.includes(q) || caseKeyTail.includes(q) || caseNumber.includes(q);

      ci.classList.toggle('nav-search-match', matches);
      ci.style.display = matches ? '' : 'none';
      if (matches) {
        ci.closest('.term-group')?.classList.add('open');
        ci.closest('.decade-group')?.classList.add('open');
        termsSectionEl.classList.add('open');
      }
    });

    // Hide term-groups with no matching cases
    termsSectionEl.querySelectorAll('.term-group').forEach(tg => {
      tg.style.display = tg.querySelector('.nav-search-match') ? '' : 'none';
    });

    // Hide decade-groups whose term-groups all got filtered out
    termsSectionEl.querySelectorAll('.decade-group').forEach(dg => {
      dg.style.display = dg.querySelector('.nav-search-match') ? '' : 'none';
    });

    // Keep the Terms section (including the search UI) visible even when
    // there are no matches; only inner groups/cases are filtered.
    termsSectionEl.style.display = '';

    // Scroll first match into view
    const firstMatch = document.querySelector('.nav-search-match');
    if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  navSearchBtn.addEventListener('click', () => {
    if (navSearchRow.hidden) openNavSearch(); else closeNavSearch();
  });

  navSearchClear.addEventListener('click', () => closeNavSearch());

  navSearchInput.addEventListener('input', () => runNavSearch(navSearchInput.value));

  navSearchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeNavSearch();
  });
})();

// ── Random case picker ───────────────────────────────────────────────────────
// Pick a random case within a term range and navigate to it.
// startTerm / stopTerm are optional YYYY-MM strings (inclusive, lexicographic).
async function _randomizeThenRestore(startTerm, stopTerm) {
  // Filter the flat TERMS list to eligible pages in the requested range.
  const eligible = TERMS.filter(p => {
    if (!p.term || typeof p.cases !== 'number' || p.cases <= 0) return false;
    if (!p.file && !(typeof p.cases === 'string')) return false;
    if (startTerm && p.term < startTerm) return false;
    if (stopTerm  && p.term > stopTerm)  return false;
    return true;
  });
  if (!eligible.length) return;

  // Pick a uniformly random page, then a uniformly random case within it.
  const page    = eligible[Math.floor(Math.random() * eligible.length)];
  const caseIdx = Math.floor(Math.random() * page.cases);
  const term    = page.term;

  const cases = await fetchTermCases(term);
  if (!cases?.length) return;
  const caseEntry = cases[Math.min(caseIdx, cases.length - 1)];
  if (!caseEntry) return;

  // Replace the current URL (so the action= URL is not in history) with the
  // resolved case URL, then restore normally.
  const caseId = _caseUrlId(caseEntry, cases);
  const url = buildUrlParams(
    { term, case: caseId },
    ['action', 'start', 'stop', 'collection', 'group', 'id', 'highlight', 'event', 'file', 'turn'],
  );
  history.replaceState(null, '', url);

  // Collapse all open decade/term groups so only the target path is expanded.
  document.querySelectorAll('#term-list .decade-group.open, #term-list .term-group.open, #term-list .month-group.open')
    .forEach(el => el.classList.remove('open'));

  // On mobile, after the transcript loads scroll the doc-browser so the
  // selected case sits at the top — visible when the user swipes up.
  if (isMobile()) {
    document.addEventListener('transcriptloaded', () => {
      const activeCase = document.querySelector('.case-item.active');
      const docBrowser = document.getElementById('doc-browser');
      if (activeCase && docBrowser) {
        const caseTop = activeCase.getBoundingClientRect().top - docBrowser.getBoundingClientRect().top;
        docBrowser.scrollTop = Math.max(0, docBrowser.scrollTop + caseTop - 8);
      }
    }, { once: true });
  }

  await restoreFromURL();
}

async function pickRandomCase() {
  const btn = document.getElementById('random-case-btn');
  if (btn) btn.disabled = true;
  try {
    await _randomizeThenRestore('1950-10', null);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  // Load nav structure from index.json, then pre-fetch any referenced data files in parallel.
  let navData = [];
  try {
    const res = await fetch('/courts/ussc/index.json', { cache: 'reload' });
    if (res.ok) navData = await res.json();
  } catch (e) {
    console.warn('[nav] index.json fetch failed:', e);
  }
  await Promise.all(navData.map(async entry => {
    if (!entry.file) return;
    try {
      const res = await fetch(entry.file, { cache: 'reload' });
      if (!res.ok) return;
      const data = await res.json();
      if (entry.file.endsWith('terms.json')) {
        TERMS_GROUPED = [...data].reverse().map(d => ({ ...d, groups: [...(d.groups || [])].reverse() }));
        // Build flat TERMS array for lookups (term derived from cases URL).
        TERMS = data.flatMap(decade =>
          (decade.groups || []).map(page => {
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return { ...page, term: m ? m[1] : '' };
          })
        );
      } else if (entry.file.endsWith('collections.json')) {
        COLLECTIONS = data;
      } else if (entry.file.endsWith('topics.json')) {
        TOPICS = data;
      }
    } catch (e) {
      console.warn('[nav] failed to load', entry.file, e);
    }
  }));
  buildNavFromIndex(navData);

  document.getElementById('random-case-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    pickRandomCase();
  });

  // Navigate to home page when clicking the site link.
  document.getElementById('site-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/';
  });

  // Spin the dice button whenever the user hovers over any action=randomize link.
  // Must be attached to both the main document and the page-viewer-frame iframe
  // (home content and other pages are rendered inside that iframe).
  function _attachRandomizeHoverListeners(doc) {
    doc.addEventListener('mouseover', (e) => {
      if (!e.target.closest('a[href*="action=randomize"]')) return;
      document.getElementById('random-case-btn')?.classList.add('spinning');
    });
    doc.addEventListener('mouseout', (e) => {
      if (!e.target.closest('a[href*="action=randomize"]')) return;
      if (e.relatedTarget?.closest('a[href*="action=randomize"]')) return;
      document.getElementById('random-case-btn')?.classList.remove('spinning');
    });
  }
  _attachRandomizeHoverListeners(document);
  const pageFrame = document.getElementById('page-viewer-frame');
  if (pageFrame) {
    function _applyThemeToFrame(frame) {
      try {
        const t = document.documentElement.getAttribute('data-theme');
        if (t) frame.contentDocument.documentElement.setAttribute('data-theme', t);
        else frame.contentDocument.documentElement.removeAttribute('data-theme');
      } catch (_) {}
    }
    // Re-attach on every iframe navigation (content changes).
    pageFrame.addEventListener('load', function () {
      try { _attachRandomizeHoverListeners(this.contentDocument); } catch (_) {}
      _applyThemeToFrame(this);
    });
    // Safety net: stop spinning whenever the mouse leaves the iframe entirely.
    pageFrame.addEventListener('mouseleave', () => {
      document.getElementById('random-case-btn')?.classList.remove('spinning');
    });
    // Re-export for topbar.js theme switcher.
    window._applyThemeToPageFrame = () => _applyThemeToFrame(pageFrame);
  }

  await restoreFromURL();
}

async function restoreFromURL() {
  const params = new URLSearchParams(location.search);

  // ── action=randomize ─────────────────────────────────────────────────────
  // Redirect to a random case in the given term range before doing anything else.
  if (params.get('action') === 'randomize') {
    const startParam = params.get('start') || null;
    const stopParam  = params.get('stop')  || null;
    await _randomizeThenRestore(startParam, stopParam);
    return;
  }

  const linkParam       = params.get('link');
  let termParam         = params.get('term');
  if (termParam === 'current') termParam = TERMS[TERMS.length - 1]?.term ?? termParam;
  const caseParam       = params.get('case');
  const collectionParam = params.get('collection');
  const groupParam      = params.get('group') != null ? parseInt(params.get('group'), 10) : null;
  const idParam         = params.get('id') ?? null;
  const highlightParam  = params.get('highlight') != null ? parseInt(params.get('highlight'), 10) - 1 : null;
  const audioParam = params.get('event') != null ? Math.max(1, parseInt(params.get('event'), 10)) : null; // 1-based index into caseEntry.events (original on-disk order)
  const fileParam  = params.get('file') ?? null;  // string: numeric id or href filename
  const turnParam  = params.get('turn') != null ? parseInt(params.get('turn'), 10) : null;

  // ── Collection restore ───────────────────────────────────────────────────

  // Returns the section <li> that contains the given collection, opened and built.
  // Checks _collectionsSectionLi then _topicsSectionLi so both sources are routable.
  async function _openCollectionSection(collId) {
    for (const sLi of [_collectionsSectionLi, _topicsSectionLi]) {
      if (!sLi) continue;
      sLi.classList.add('open');
      await sLi._ensureBuilt();
      if (sLi.querySelector(`.term-group[data-collection-url$="/${CSS.escape(collId)}.json"]`)) return sLi;
    }
    return null;
  }
  function _findAnyCollectionEntry(collId) {
    return _findCollectionEntry(COLLECTIONS, collId) ?? _findCollectionEntry(TOPICS, collId);
  }

  // Collection-only: just open/expand the collection in the nav.
  const _anySectionLi = _collectionsSectionLi || _topicsSectionLi;
  if (collectionParam && !groupParam && !idParam && highlightParam == null && !termParam && !caseParam && _anySectionLi) {
    const _sLi = await _openCollectionSection(collectionParam);
    const collLi = _sLi?.querySelector(
      `.term-group[data-collection-url$="/${CSS.escape(collectionParam)}.json"]`
    );
    if (collLi) {
      let _ag = collLi.parentElement?.closest('.term-group');
      while (_ag && _sLi.contains(_ag)) { _ag.classList.add('open'); _ag = _ag.parentElement?.closest('.term-group'); }
      collLi.classList.add('open');
      await collLi._ensureBuilt?.();
      requestAnimationFrame(() => collLi.scrollIntoView({ behavior: 'instant', block: 'start' }));
    }
    const collEntry = _findAnyCollectionEntry(collectionParam);
    const resolvedLink = linkParam || collEntry?.link || null;
    if (resolvedLink) showPageViewer(resolvedLink, { pushState: false });
    return;
  }

  // Highlight: collection + id + highlight index
  if (collectionParam && idParam && highlightParam != null && !termParam && !caseParam && _anySectionLi) {
    const _sLi = await _openCollectionSection(collectionParam);
    const collLi = _sLi?.querySelector(
      `.term-group[data-collection-url$="/${CSS.escape(collectionParam)}.json"]`
    );
    if (collLi) {
      let _ag = collLi.parentElement?.closest('.term-group');
      while (_ag && _sLi.contains(_ag)) { _ag.classList.add('open'); _ag = _ag.parentElement?.closest('.term-group'); }
      collLi.classList.add('open');
      await collLi._ensureBuilt?.();
      const groupLi = collLi.querySelector(`.month-group[data-group-id="${CSS.escape(idParam)}"]`);
      if (groupLi) {
        groupLi.classList.add('open');
        await groupLi._ensureCases?.();
        groupLi._activateCount?.();
        const hlEl = groupLi.querySelector(`.highlight-item[data-highlight-idx="${highlightParam}"]`);
        if (hlEl) {
          if (!isMobile()) requestAnimationFrame(() => hlEl.scrollIntoView({ behavior: 'instant', block: 'center' }));
          hlEl.querySelector('.case-title-nav')?.dispatchEvent(Object.assign(new MouseEvent('click'), { fromRestore: true }));
        }
      }
    }
    return;
  }

  // Group-only: collection + group/id but no specific case selected.
  if (collectionParam && (groupParam || idParam) && !termParam && !caseParam && _anySectionLi) {
    const _sLi = await _openCollectionSection(collectionParam);
    const collLi = _sLi?.querySelector(
      `.term-group[data-collection-url$="/${CSS.escape(collectionParam)}.json"]`
    );
    if (collLi) {
      let _ag = collLi.parentElement?.closest('.term-group');
      while (_ag && _sLi.contains(_ag)) { _ag.classList.add('open'); _ag = _ag.parentElement?.closest('.term-group'); }
      collLi.classList.add('open');
      await collLi._ensureBuilt?.();
      const groupLi = idParam
        ? collLi.querySelector(`.month-group[data-group-id="${CSS.escape(idParam)}"]`)
        : collLi.querySelector(`.month-group[data-group-idx="${groupParam}"]`);
      if (groupLi) {
        groupLi.classList.add('open');
        await groupLi._ensureCases?.();
        groupLi._activateCount?.();
        if (groupLi._groupLink && groupLi._groupDocument) showAdvocateDocument(groupLi._groupDocument, groupLi._groupLink, '');
        else if (groupLi._groupLink) showPageViewer(groupLi._groupLink, { pushState: false });
        else if (groupLi._groupDocument) showAdvocateDocument(groupLi._groupDocument, null, '');
        requestAnimationFrame(() => groupLi.scrollIntoView({ behavior: 'instant', block: 'start' }));
      }
    }
    return;
  }

  if (collectionParam && termParam && caseParam && _anySectionLi) {
    const _sLi = await _openCollectionSection(collectionParam);
    const collLi = _sLi?.querySelector(
      `.term-group[data-collection-url$="/${CSS.escape(collectionParam)}.json"]`
    );
    if (collLi) {
      let _ag = collLi.parentElement?.closest('.term-group');
      while (_ag && _sLi.contains(_ag)) { _ag.classList.add('open'); _ag = _ag.parentElement?.closest('.term-group'); }
      collLi.classList.add('open');
      await collLi._ensureBuilt?.();
      // Ensure group cases are built before looking up the case item (both split and embedded format).
      // When idParam is set, scope the case search to that advocate's group so we don't accidentally
      // select the same case under a different advocate who argued the same term/case.
      let _caseSearchRoot = collLi;
      if (idParam) {
        const groupLi = collLi.querySelector(`.month-group[data-group-id="${CSS.escape(idParam)}"]`);
        if (groupLi) {
          groupLi.classList.add('open');
          await groupLi._ensureCases?.();
          groupLi._activateCount?.();
          _caseSearchRoot = groupLi;
        }
      } else if (groupParam) {
        const groupLi = collLi.querySelector(`.month-group[data-group-idx="${groupParam}"]`);
        if (groupLi) {
          groupLi.classList.add('open');
          await groupLi._ensureCases?.();
          groupLi._activateCount?.();
          _caseSearchRoot = groupLi;
        }
      }
      // Collection case items use `caseRef.number` (the docket number) as
      // their data-case-key, and the URL `case` param is set to caseRef.number
      // by the click handler. Use caseParam directly so the key always matches,
      // even when the term's full case entry has a separate `id` field.
      const caseKey = CSS.escape(termParam + '/' + caseParam);
      let candidates = Array.from(_caseSearchRoot.querySelectorAll(`.case-item[data-case-key="${caseKey}"]`));

      // Fallback: caseParam may be just the first docket number of a consolidated
      // case (e.g. "77-874" when the full number is "77-874,77-1463").
      if (candidates.length === 0) {
        const termPrefix = CSS.escape(termParam + '/');
        candidates = Array.from(_caseSearchRoot.querySelectorAll(`.case-item[data-case-key^="${termPrefix}"]`))
          .filter(el => {
            const keyNum = (el.dataset.caseKey || '').split('/').pop();
            return keyNum === caseParam
              || keyNum.split(',').map(n => n.trim()).includes(caseParam);
          });
      }

      // If audioParam is specified and multiple case items exist for this case
      // (e.g., an advocate argued the same case twice), filter by data-event-idx
      // to select the correct one.
      let ci = candidates[0] || null;
      if (candidates.length > 1 && audioParam != null) {
        const eventMatch = candidates.find(el =>
          el.dataset.eventIdx && parseInt(el.dataset.eventIdx, 10) === audioParam
        );
        if (eventMatch) ci = eventMatch;
      }
      // Still fetch term cases so fileRestore can check events length below.
      const termCases = ci ? await fetchTermCases(termParam) : [];
      const matchedCase = termCases.find(c => {
        if (c.id && c.id === caseParam) return true;
        if (!c.number) return false;
        return c.number === caseParam
          || c.number.split(',').map(n => n.trim()).includes(caseParam);
      });
      if (ci) {
        ci.closest('.month-group')?._centerOnItem?.(ci);
        markCaseItemActive(ci);
        ci.closest('.month-group')?.classList.add('open');
        if (!isMobile()) requestAnimationFrame(() => ci.scrollIntoView({ behavior: 'instant', block: 'center' }));
        if (fileParam != null || turnParam != null) {
          document.addEventListener('transcriptloaded', () => {
            if (turnParam != null) {
              const turnIdx = turns.findIndex((t, i) => (t.turn ?? (i + 1)) === turnParam);
              if (turnIdx >= 0 && activeTurnIdx !== turnIdx) {
                if (activeTurnIdx >= 0) document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
                const el = document.getElementById('turn-' + turnIdx);
                if (el) {
                  el.classList.add('active');
                  activeTurnIdx = turnIdx;
                  // Cancel loadAudioEntry's pending seeked re-affirmation so it
                  // cannot revert activeTurnIdx back to caseRef.turn after we
                  // seek to the URL's turn param below.
                  if (_pendingSeekListener) {
                    audio.removeEventListener('seeked', _pendingSeekListener);
                    _pendingSeekListener = null;
                    _suppressTimeupdateBeforeSeek = false;
                  }
                  if (turns[turnIdx].time != null) seekOnly(turnTimes[turnIdx] + 0.01);
                  requestAnimationFrame(() => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
                  const url = new URL(location.href);
                  url.searchParams.set('turn', turnParam);
                  history.replaceState(null, '', url);
                }
              }
            }
            if (fileParam != null) {
              const fileEl = findFileItem(fileParam);
              if (fileEl) {
                fileEl.closest('.file-type-group')?.classList.add('open');
                requestAnimationFrame(() => fileEl.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
                fileEl.click();
              }
            }
          }, { once: true });
        }
        if (isMobile()) {
          document.addEventListener('transcriptloaded', () => {
            playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
            setMobileNavVisible(false);
          }, { once: true });
        }
        const titleEl = ci.querySelector('.case-title-nav');
        if (titleEl) titleEl.dispatchEvent(Object.assign(new MouseEvent('click', { cancelable: true }), {
          fromRestore: true,
          ...(audioParam != null ? { audioIdx: audioParam } : {}),
          ...(turnParam != null ? { initialTurn: turnParam } : {}),
          // Pass fileRestore so the title click handler can open the file directly
          // for no-audio cases (where transcriptloaded never fires).
          fileRestore: (fileParam != null && matchedCase && !matchedCase.events?.some(a => a.audio_href)) ? String(fileParam) : null,
        }));
      }
    }
    return;
  }

  if (termParam && caseParam) {
    // Expand the decade and term shells, then wait for the term's cases to load.
    const termLi = document.querySelector(`.term-group[data-term="${CSS.escape(termParam)}"]`);
    if (termLi) {
      const decLi = termLi.closest('.decade-group');
      decLi?.classList.add('open');
      termLi.closest('.terms-group')?.classList.add('open');
      termLi.classList.add('open');
      await termLi._ensureBuilt?.();
      termLi._showSortLabel?.();
      // Prefetch counts for remaining terms in the decade (same as clicking the decade header).
      if (decLi) {
        (async () => {
          const termEls = [...decLi.querySelectorAll('.term-group[data-term]')];
          for (const el of termEls) {
            await el._ensureCount?.();
          }
        })();
      }

      // Match the case param against id first, then number (for old URLs).
      // After _ensureBuilt the cases are already cached in _termFetchPromises.
      const termCases = await fetchTermCases(termParam);
      const matchedCase = termCases.find(c => {
        if (c.id && c.id === caseParam) return true;
        if (!c.number) return false;
        // Match against full number or any individual number in a consolidated list ("81-298,81-799").
        return c.number === caseParam
          || c.number.split(',').map(n => n.trim()).includes(caseParam);
      });
      const resolvedKey = matchedCase
        ? termParam + '/' + _caseUrlId(matchedCase, termCases)
        : termParam + '/' + caseParam;
      const caseEl = document.querySelector(`.case-item[data-case-key="${CSS.escape(resolvedKey)}"]`);
      if (caseEl) {
        if (fileParam != null || turnParam != null) {
          document.addEventListener('transcriptloaded', () => {
            if (turnParam != null) {
              const turnIdx = turns.findIndex((t, i) => (t.turn ?? (i + 1)) === turnParam);
              if (turnIdx >= 0 && activeTurnIdx !== turnIdx) {
                if (activeTurnIdx >= 0) document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
                const el = document.getElementById('turn-' + turnIdx);
                if (el) {
                  el.classList.add('active');
                  activeTurnIdx = turnIdx;
                  // Cancel loadAudioEntry's pending seeked re-affirmation so it
                  // cannot revert activeTurnIdx back to caseRef.turn after we
                  // seek to the URL's turn param below.
                  if (_pendingSeekListener) {
                    audio.removeEventListener('seeked', _pendingSeekListener);
                    _pendingSeekListener = null;
                    _suppressTimeupdateBeforeSeek = false;
                  }
                  if (turns[turnIdx].time != null) seekOnly(turnTimes[turnIdx] + 0.01);
                  requestAnimationFrame(() => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
                  const url = new URL(location.href);
                  url.searchParams.set('turn', turnParam);
                  history.replaceState(null, '', url);
                }
              }
            }
            if (fileParam != null) {
              const fileEl = findFileItem(fileParam);
              if (fileEl) {
                fileEl.closest('.file-type-group')?.classList.add('open');
                requestAnimationFrame(() => fileEl.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
                fileEl.click();
              }
            }
          }, { once: true });
        }
        // On mobile, scroll to playerSection once the transcript is loaded.
        if (isMobile()) {
          document.addEventListener('transcriptloaded', () => {
            playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
            setMobileNavVisible(false);
          }, { once: true });
        }
        // Use dispatchEvent so the fromRestore flag is passed to the title click handler.
        const titleEl = caseEl.querySelector('.case-title-nav');
        if (titleEl) titleEl.dispatchEvent(Object.assign(new MouseEvent('click', { cancelable: true }), {
          fromRestore: true,
          audioIdx: audioParam ?? 0,
          fileRestore: (fileParam != null && matchedCase && !matchedCase.events?.length) ? String(fileParam) : null,
        }));
        // For no-audio cases, file restore is handled inside the title click handler
        // (after ensureFilesLoaded). For audio cases it fires on transcriptloaded above.
        if (!isMobile()) {
          requestAnimationFrame(() => caseEl.scrollIntoView({ behavior: 'instant', block: 'center' }));
        }
      }
    }
  } else if (linkParam) {
    // link URL: show the page viewer for the linked page.
    const navItem = document.querySelector(`.case-item[data-link="${CSS.escape(linkParam)}"], .term-group[data-link="${CSS.escape(linkParam)}"]`);
    if (navItem) {
      // Expand all ancestor collapsible sections.
      navItem.classList.add('open');
      let ancestor = navItem.parentElement;
      while (ancestor) {
        if (ancestor.classList.contains('terms-group') || ancestor.classList.contains('term-group') ||
            ancestor.classList.contains('decade-group')) {
          ancestor.classList.add('open');
        }
        ancestor = ancestor.parentElement;
      }
      requestAnimationFrame(() => navItem.scrollIntoView({ behavior: 'instant', block: 'center' }));
    }
    showPageViewer(linkParam, { pushState: false });
  } else if (termParam) {
    // term-only URL: expand the term and load its case list, but don't select a case.
    const termLi = document.querySelector(`.term-group[data-term="${CSS.escape(termParam)}"]`);
    if (termLi) {
      const decLi = termLi.closest('.decade-group');
      decLi?.classList.add('open');
      termLi.closest('.terms-group')?.classList.add('open');
      termLi.classList.add('open');
      await termLi._ensureBuilt?.();
      termLi._showSortLabel?.();
      // Prefetch counts for sibling terms in the decade.
      if (decLi) {
        (async () => {
          const termEls = [...decLi.querySelectorAll('.term-group[data-term]')];
          for (const el of termEls) {
            await el._ensureCount?.();
          }
        })();
      }
      updateEmptyStateForTerm(termParam);
      document.getElementById('topbar-term').textContent = termDisplayName(termParam);
      requestAnimationFrame(() => termLi.scrollIntoView({ behavior: 'instant', block: 'start' }));
    }
  } else {
    // No URL params — show the default home page.
    showPageViewer('/courts/ussc/pages/home', { pushState: false });
  }
}

window.addEventListener('popstate', () => restoreFromURL());

// ── Transcript edit mode ────────────────────────────────────────────────────

function _getEditedTurn(turnIdx) {
  return _transcriptEdits.get(_currentCaseKey)?.eventEdits.get(_currentTextHref)?.get(turnIdx) ?? null;
}

function _saveEditedTurn(turnIdx, changes) {
  if (!_currentCaseKey || !_currentTextHref) return;
  const caseKey = _currentCaseKey;

  if (!_transcriptEdits.has(caseKey)) {
    _transcriptEdits.set(caseKey, {
      title: _currentCaseEntry?.title || '',
      term: _currentCaseKey.split('/')[0],
      number: _currentCaseEntry?.number,
      id: _currentCaseEntry?.id,
      eventEdits: new Map()
    });
  }
  const caseData = _transcriptEdits.get(caseKey);
  if (!caseData.eventEdits.has(_currentTextHref)) {
    caseData.eventEdits.set(_currentTextHref, new Map());
  }
  const eventEdits = caseData.eventEdits.get(_currentTextHref);

  const origTurn = turns[turnIdx];
  const existing = eventEdits.get(turnIdx) || {};
  const newName = changes.name !== undefined ? changes.name : (existing.name ?? origTurn.name);
  const newText = changes.text !== undefined ? changes.text : existing.text;

  const nameChanged = newName !== origTurn.name;
  const textChanged = newText !== undefined && newText !== origTurn.text;

  if (!nameChanged && !textChanged) {
    eventEdits.delete(turnIdx);
  } else {
    eventEdits.set(turnIdx, {
      turnNum: origTurn.turn ?? (turnIdx + 1),
      name: newName,
      ...(textChanged ? { text: newText } : {})
    });
  }

  if (!eventEdits.size) caseData.eventEdits.delete(_currentTextHref);
  if (!caseData.eventEdits.size) _transcriptEdits.delete(caseKey);
}

function _generateEditsJson() {
  const result = [];
  for (const [, caseData] of _transcriptEdits) {
    if (!caseData.eventEdits.size) continue;
    const events = [];
    for (const [textHref, turnEdits] of caseData.eventEdits) {
      if (!turnEdits.size) continue;
      events.push({
        text_href: textHref,
        turns: [...turnEdits.values()]
          .map(e => ({ turn: e.turnNum, name: e.name, ...(e.text !== undefined ? { text: e.text } : {}) }))
          .sort((a, b) => a.turn - b.turn)
      });
    }
    if (!events.length) continue;
    const obj = { title: caseData.title };
    if (caseData.term)   obj.term   = caseData.term;
    if (caseData.number) obj.number = caseData.number;
    else if (caseData.id) obj.id = caseData.id;
    obj.events = events;
    result.push(obj);
  }
  return result;
}

const _unknownSpeakerNames = new Set(['UNKNOWN JUSTICE', 'UNKNOWN SPEAKER']);

function _updateEditModeMenu() {
  const editBtn   = document.getElementById('edit-transcripts-btn');
  const finishBtn = document.getElementById('finish-editing-btn');
  if (editBtn)   editBtn.hidden   = _editMode;
  if (finishBtn) finishBtn.hidden = !_editMode;
}

function startEditTranscripts() {
  alert('Note: all edits will be recorded in your web browser until you have selected “Editing Finished”, and then your edits will be downloaded. If you close your browser before you have finished, your edits will be lost.');
  _editMode = true;
  _updateEditModeMenu();
  transcriptViewer.classList.add('edit-mode');
  turnList.innerHTML = '';
  renderTranscript();
}

function finishEditTranscripts() {
  const edits = _generateEditsJson();
  _editMode = false;
  _transcriptEdits.clear();
  _updateEditModeMenu();
  transcriptViewer.classList.remove('edit-mode');
  if (edits.length) {
    const blob = new Blob([JSON.stringify(edits, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'transcript-edits.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  turnList.innerHTML = '';
  renderTranscript();
  alert('Note: Send the downloaded edits to clerk@lonedissent.org for processing. Thank you for taking the time to make these corrections.');
}

window._startEditTranscripts  = startEditTranscripts;
window._finishEditTranscripts = finishEditTranscripts;

init();
