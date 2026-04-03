// ── State ───────────────────────────────────────────────────────────────────
let turns = [];
let turnTimes = [];   // each turn's start time in seconds
let activeTurnIdx = -1;
let links = [];        // annotation links for the current case
let caseSpeakers = []; // ordered speaker list for the current transcript
let activeBottomLinkText = null; // text key of the currently shown bottom link
let docViewerOpenHeight = null;  // px height for next animated open (null = use 45vh default)
let _currentAudioList = [];    // sorted audio entries for the active case
let _currentBasePath  = '';    // base URL path for the active case

const audio       = document.getElementById('audio-player');
const turnList    = document.getElementById('turn-list');
const emptyState  = document.getElementById('empty-state');
const loadingMsg  = document.getElementById('loading-msg');
const playerSection = document.getElementById('player-section');

// ── Utilities ───────────────────────────────────────────────────────────────

function parseTime(s) {
  const [h, m, sec] = s.split(':');
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(sec);
}

function termDisplayName(term) {
  const [year, month] = term.split('-');
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return (months[parseInt(month, 10) - 1] || month) + '\u00a0Term\u00a0' + year;
}

function formatSpeaker(name) {
  if (name.startsWith('CHIEF JUSTICE ')) {
    return 'C.J.\u00a0' + toTitleCase(name.split(' ').pop());
  }
  if (name.startsWith('JUSTICE ')) {
    return 'J.\u00a0' + toTitleCase(name.split(' ').pop());
  }
  return name.split(' ').map(toTitleCase).join(' ').replace('General ', 'Gen. ');
}

function toTitleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function speakerClass(name) {
  if (name.startsWith('CHIEF JUSTICE')) return 'chief-justice';
  if (name.startsWith('JUSTICE'))       return 'justice';
  return 'counsel';
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function audioEntryLabel(a) {
  if (a.title) return a.title;
  const dateFormatted = a.date
    ? new Date(a.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const type = a.type || 'argument';
  if (type === 'reargument') return 'Oral Reargument on ' + dateFormatted;
  if (type === 'opinion')    return 'Opinion Announcement on ' + dateFormatted;
  return 'Oral Argument on ' + dateFormatted;
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
const _termFetchPromises = new Map(); // term → inflight Promise or resolved cases[]

async function fetchTermCases(term) {
  if (_termFetchPromises.has(term)) return _termFetchPromises.get(term);
  const entry = TERMS.find(t => t.term === term);
  if (!entry) return [];
  const p = fetch(entry.casesUrl, { cache: 'reload' })
    .then(r => r.ok ? r.json() : [])
    .catch(e => { console.warn('[cases] fetch failed for term', term, e); return []; });
  _termFetchPromises.set(term, p);
  const cases = await p;
  _termFetchPromises.set(term, cases);
  return cases;
}

// Called when nav search opens: loads all not-yet-built term case lists.
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
  docViewerOpenHeight = panel.offsetHeight;
  panel.classList.add('collapsed');
  panel.offsetHeight; // force reflow
  panel.style.height = '30px';
  panel.addEventListener('transitionend', () => {
    panel.style.height = '';
  }, { once: true });
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
    panel.addEventListener('transitionend', () => {
      panel.hidden = true;
      panel.style.height = '';
    }, { once: true });
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
function showDocViewer(link, { autoScroll = false, matchedRef = null, page = null } = {}) {
  const panel  = document.getElementById('doc-viewer');
  const card   = document.getElementById('doc-viewer-card');
  const pdfEl  = document.getElementById('doc-viewer-pdf');
  const isPdf  = /\.pdf(\?|$)/i.test(link.href);
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
    if (pdfEl.src !== src) pdfEl.src = src;
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
    const h = docViewerOpenHeight ?? Math.round(window.innerHeight * 0.45);
    panel.style.height = '0px';
    panel.hidden = false;
    panel.offsetHeight; // force reflow so transition plays
    panel.style.height = h + 'px';
    // When opened automatically (not by a user click), scroll the active turn
    // to the top of the transcript pane so the doc viewer doesn't obscure it.
    if (!autoScroll) requestAnimationFrame(scrollActiveTurnToTranscriptTop);
  } else if (panel.classList.contains('collapsed')) {
    expandDocViewer();
    // Same scroll when un-minimized automatically during playback.
    if (!autoScroll) requestAnimationFrame(scrollActiveTurnToTranscriptTop);
  }
  if (autoScroll && isMobile()) {
    panel.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
}

// ── Build nav ───────────────────────────────────────────────────────────────

// Populate the case list for a term — called the first time a term is expanded.
function buildTermCases(term, cases, ul) {
  const sortedCases = [...cases].sort((a, b) => {
    const da = a.audio?.[0]?.date ?? '';
    const db = b.audio?.[0]?.date ?? '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  // Group cases by argument month
  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
  const monthMap = new Map();
  sortedCases.forEach(caseEntry => {
    const argDate = caseEntry.audio?.[0]?.date;
    const mk = argDate ? argDate.slice(0, 7) : 'unknown';
    const ml = argDate ? MONTH_NAMES[parseInt(argDate.slice(5, 7), 10) - 1] : 'Unknown';
    if (!monthMap.has(mk)) monthMap.set(mk, { label: ml, cases: [] });
    monthMap.get(mk).cases.push(caseEntry);
  });

  monthMap.forEach(({ label: monthLabel, cases: mCases }) => {
    const monthLi = document.createElement('li');
    monthLi.className = 'month-group';

    const monthHeader = document.createElement('div');
    monthHeader.className = 'month-header';

      const monthTog = document.createElement('span');
      monthTog.className = 'month-toggle';
      monthTog.textContent = '\u25b6';

      const monthName = document.createElement('span');
      monthName.className = 'month-name';
      monthName.textContent = monthLabel;

      monthHeader.appendChild(monthTog);
      monthHeader.appendChild(monthName);
      monthHeader.addEventListener('click', () => monthLi.classList.toggle('open'));

      const monthUl = document.createElement('ul');
      monthUl.className = 'month-case-list';

      mCases.forEach(caseEntry => {
        const caseKey = term + '/' + caseEntry.number;
        const basePath = '/courts/ussc/terms/' + term + '/cases/' + caseEntry.number + '/';

        const ci = document.createElement('li');
        ci.className = 'case-item';
        ci.dataset.caseKey = caseKey;

        // ── Header row (toggle + title) ────────────────────────
        const header = document.createElement('div');
        header.className = 'case-header';

        const toggle = document.createElement('span');
        toggle.className = 'case-toggle';
        toggle.textContent = '\u25b6'; // ▶

        const titleSpan = document.createElement('span');
        titleSpan.className = 'case-title-nav';
        titleSpan.textContent = caseEntry.title;

        header.appendChild(toggle);
        header.appendChild(titleSpan);

        // ── Gavel icon: shown if this case has an opinion (background check) ──
        fetch(basePath + 'files.json')
          .then(r => r.ok ? r.json() : [])
          .then(files => {
            if (Array.isArray(files) && files.some(f => f.type === 'opinion')) {
              const icon = document.createElement('span');
              icon.className = 'case-decided-icon';
              icon.textContent = '\u2696';
              icon.title = 'Opinion issued';
              header.appendChild(icon);
              ci.classList.add('decided');
            }
          })
          .catch(() => {});

        // ── File sub-list (populated lazily) ──────────────────
        const fileUl = document.createElement('ul');
        fileUl.className = 'file-list';
        let filesLoaded = false;

        // Lazily populate the file sub-list; shared by both click handlers below.
        async function ensureFilesLoaded() {
          if (filesLoaded) return;
          filesLoaded = true;
          const rawFiles = await loadFiles(basePath + 'files.json');

          const TYPE_LABELS = {
            petitioner: 'Petitioner',
            respondent: 'Respondent',
            amicus:     'Amicus',
            other:      'Other',
            reference:  'References',
            opinion:    'Opinion',
          };
          const ORDER = ['petitioner', 'respondent', 'amicus', 'other', 'reference', 'opinion'];

          // When true, amicus + other are merged into a single "Other" group
          // (amicus entries first, then other, each sub-sorted by date).
          // Set to false to restore separate Amicus / Other headings.
          const MERGE_AMICUS_OTHER = true;

          // Group files by type, then sort each group by date ascending
          const groups = {};
          rawFiles.forEach(f => {
            const key = (f.type || 'other').toLowerCase();
            if (!groups[key]) groups[key] = [];
            groups[key].push(f);
          });
          ORDER.forEach(k => {
            if (!groups[k]) return;
            if (k === 'reference') {
              groups[k].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
            } else {
              groups[k].sort((a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0);
            }
          });

          // Merge amicus into other (amicus first) when the flag is set
          if (MERGE_AMICUS_OTHER && (groups.amicus?.length || groups.other?.length)) {
            groups.other = [...(groups.amicus || []), ...(groups.other || [])];
            delete groups.amicus;
          }

          // Always append transcript entries at the end of Other.
          if (groups.transcript?.length) {
            groups.other = [...(groups.other || []), ...groups.transcript];
            delete groups.transcript;
          }

          const effectiveOrder = MERGE_AMICUS_OTHER
            ? ORDER.filter(k => k !== 'amicus')
            : ORDER;

          effectiveOrder.forEach(typeKey => {
            if (!groups[typeKey] || !groups[typeKey].length) return;

            const groupLi = document.createElement('li');
            groupLi.className = 'file-type-group';

            const typeHeader = document.createElement('div');
            typeHeader.className = 'file-type-header';

            const typeTog = document.createElement('span');
            typeTog.className = 'file-type-toggle';
            typeTog.textContent = '\u25b6';

            const typeLabel = document.createElement('span');
            typeLabel.textContent = TYPE_LABELS[typeKey] || typeKey;

            typeHeader.appendChild(typeTog);
            typeHeader.appendChild(typeLabel);
            typeHeader.addEventListener('click', e => {
              e.stopPropagation();
              groupLi.classList.toggle('open');
            });

            const itemsUl = document.createElement('ul');
            itemsUl.className = 'file-type-items';

            groups[typeKey].forEach(f => {
              const fi = document.createElement('li');
              fi.className = 'file-item';
              if (f.file != null) fi.dataset.fileId = f.file;
              fi.textContent = f.title;
              fi.addEventListener('click', e => {
                e.stopPropagation();
                document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
                fi.classList.add('active');
                if (f.file != null) {
                  const url = new URL(location.href);
                  url.searchParams.set('file', f.file);
                  history.replaceState(null, '', url);
                }
                showDocViewer(f, { autoScroll: true });
              });
              itemsUl.appendChild(fi);
            });

            groupLi.appendChild(typeHeader);
            groupLi.appendChild(itemsUl);
            fileUl.appendChild(groupLi);
          });
        }

        // Toggle (▶): expand or collapse the case — no selection, no transcript load.
        toggle.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (ci.classList.toggle('open')) {
            await ensureFilesLoaded();
          }
        });

        // Title: select the case, open it, and load the transcript.
        titleSpan.addEventListener('click', async (e) => {
          const fromRestore = !!e.fromRestore;
          ci.classList.add('open');
          await ensureFilesLoaded();
          if (!fromRestore) {
            const url = new URL(location.href);
            url.searchParams.set('term', term);
            url.searchParams.set('case', caseEntry.number);
            url.searchParams.delete('file');
            url.searchParams.delete('turn');
            history.replaceState(null, '', url);
          }
          loadCase(term, caseEntry);
        });

        ci.appendChild(header);
        ci.appendChild(fileUl);
        monthUl.appendChild(ci);
      });

      monthLi.appendChild(monthHeader);
      monthLi.appendChild(monthUl);
      ul.appendChild(monthLi);
    });
}

function buildNav() {
  const termListEl = document.getElementById('term-list');
  termListEl.innerHTML = '';

  // Sort terms oldest first, then group by decade.
  const sortedTerms = [...TERMS].sort((a, b) => (a.term < b.term ? -1 : 1));
  const decadeMap = new Map();
  sortedTerms.forEach(({ term }) => {
    const year = parseInt(term.slice(0, 4), 10);
    const decade = Math.floor(year / 10) * 10;
    if (!decadeMap.has(decade)) decadeMap.set(decade, []);
    decadeMap.get(decade).push(term);
  });

  const currentYear = new Date().getFullYear();
  decadeMap.forEach((termList, decade) => {
    const decLi = document.createElement('li');
    decLi.className = 'decade-group';

    const decHeader = document.createElement('div');
    decHeader.className = 'decade-header';

    const decTog = document.createElement('span');
    decTog.className = 'decade-toggle';
    decTog.textContent = '\u25b6';

    const decLabel = document.createElement('span');
    decLabel.className = 'decade-label';
    const endYear = decade + 9;
    decLabel.textContent = endYear < currentYear
      ? `${decade}\u2013${endYear}`
      : `${decade}\u2013Present`;

    decHeader.appendChild(decTog);
    decHeader.appendChild(decLabel);
    decHeader.addEventListener('click', () => decLi.classList.toggle('open'));
    decLi.appendChild(decHeader);

    const decUl = document.createElement('ul');
    decUl.className = 'term-list-inner';

    termList.forEach(term => {
      const termLi = document.createElement('li');
      termLi.className = 'term-group';
      termLi.dataset.term = term;

      const termHeader = document.createElement('div');
      termHeader.className = 'term-header';

      const termTog = document.createElement('span');
      termTog.className = 'term-toggle';
      termTog.textContent = '\u25b6';

      const label = document.createElement('span');
      label.className = 'term-label';
      label.textContent = termDisplayName(term);

      termHeader.appendChild(termTog);
      termHeader.appendChild(label);
      termLi.appendChild(termHeader);

      const ul = document.createElement('ul');
      ul.className = 'case-list';

      let built = false;
      const ensureBuilt = async () => {
        if (built) return;
        built = true;
        const cases = await fetchTermCases(term);
        buildTermCases(term, cases, ul);
      };
      termLi._ensureBuilt = ensureBuilt;

      termHeader.addEventListener('click', async () => {
        if (termLi.classList.toggle('open')) {
          await ensureBuilt();
        }
      });

      termLi.appendChild(ul);
      decUl.appendChild(termLi);
    });

    decLi.appendChild(decUl);
    termListEl.appendChild(decLi);
  });
}

// ── Load a case ─────────────────────────────────────────────────────────────

// Load (or switch to) a specific audio entry within the already-set-up case.
async function loadAudioEntry(arg, basePath) {
  const transcriptUrl = /^https?:\/\//i.test(arg.text_href) ? arg.text_href : (basePath + arg.text_href);
  const audioUrl      = arg.audio_href || (basePath + arg.audio);

  // Reset transcript area
  turnList.style.display = 'none';
  turnList.innerHTML = '';
  loadingMsg.textContent = 'Loading\u2026';
  loadingMsg.style.display = 'block';
  activeTurnIdx = -1;

  try {
    const res = await fetch(transcriptUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let transcriptData = await res.json();

    let isEnvelope = !Array.isArray(transcriptData);
    turns = isEnvelope ? (transcriptData.turns ?? []) : transcriptData;

    // If the primary transcript has no time-aligned turns, try the Oyez fallback file.
    if (!turns.some(t => t.time != null) && arg.date) {
      const oyezUrl = basePath + arg.date + '-oyez.json';
      try {
        const oyezRes = await fetch(oyezUrl);
        if (oyezRes.ok) {
          const oyezData = await oyezRes.json();
          const oyezIsEnvelope = !Array.isArray(oyezData);
          const oyezTurns = oyezIsEnvelope ? (oyezData.turns ?? []) : oyezData;
          if (oyezTurns.length) {
            transcriptData = oyezData;
            isEnvelope = oyezIsEnvelope;
            turns = oyezTurns;
          }
        }
      } catch (_) { /* ignore — fall through with empty turns */ }
    }

    turnTimes = turns.map(t => parseTime(t.time ?? '00:00:00.00'));

    const resolvedAudioUrl = (isEnvelope && transcriptData.media?.url) || audioUrl;
    audio.src = resolvedAudioUrl;
    audio.load();

    // If the entry has an offset (e.g. NARA files covering multiple cases),
    // seek to that position after metadata is ready.
    if (arg.offset) {
      seekOnly(parseTime(arg.offset));
    }

    const unalignedNote = document.getElementById('unaligned-note');
    unalignedNote.hidden = turns.some(t => t.time != null);

    caseSpeakers = (isEnvelope && transcriptData.media?.speakers?.length)
      ? transcriptData.media.speakers
      : [...new Map(turns.map(t => [t.name, { name: t.name }])).values()];

    renderTranscript();
    const docPanel = document.getElementById('doc-viewer');
    docPanel.classList.remove('collapsed');
    docPanel.style.height = '';
    docPanel.hidden = true;
    activeBottomLinkText = null;

    loadingMsg.style.display = 'none';
    turnList.style.display = 'block';
    document.dispatchEvent(new Event('transcriptloaded'));
  } catch (err) {
    loadingMsg.textContent = 'Error loading transcript.';
    console.error(err);
  }
}

async function loadCase(term, caseEntry) {
  if (!caseEntry.audio || !caseEntry.audio.length) return;
  const caseKey = term + '/' + caseEntry.number;
  const basePath = '/courts/ussc/terms/' + term + '/cases/' + caseEntry.number + '/';

  // Pick the best single source: prefer the source with the most aligned entries,
  // breaking ties by preferring 'oyez' > 'ussc' > others.
  const SOURCE_PREF = ['oyez', 'ussc', 'nara'];
  const sourceGroups = new Map(); // source -> {alignedCount, entries[]}
  for (const a of caseEntry.audio) {
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
  const sortedAudio = (sourceGroups.get(bestSource)?.entries ?? [])
    .sort((a, b) => (a.date ?? '') < (b.date ?? '') ? -1 : 1);

  // Update nav
  document.querySelectorAll('.case-item').forEach(el => el.classList.remove('active'));
  const nav = document.querySelector(`.case-item[data-case-key="${CSS.escape(caseKey)}"]`);
  if (nav) nav.classList.add('active');

  // Reset transcript area
  playerSection.hidden = true;
  emptyState.style.display = 'none';
  activeTurnIdx = -1;

  // Build audio select dropdown
  const audioSelect = document.getElementById('audio-select');
  audioSelect.innerHTML = '';
  sortedAudio.forEach((a, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = audioEntryLabel(a);
    audioSelect.appendChild(opt);
  });
  audioSelect.value = '0';

  // Store context for dropdown change events
  _currentAudioList = sortedAudio;
  _currentBasePath  = basePath;

  // Update case title
  document.getElementById('case-title-label').textContent =
    caseEntry.title + '\u00a0(No.\u00a0' + caseEntry.number + ')';

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
      qEl.textContent = firstSentence + (hasMore ? '\u00a0' : '');
      if (hasMore) {
        const more = document.createElement('span');
        more.className = 'questions-more';
        more.textContent = '[More]';
        qEl.appendChild(more);
      }
      qEl.dataset.expanded = 'false';
    };

    showSummary();

    if (hasMore) {
      qEl.style.cursor = 'pointer';
      qEl.onclick = () => {
        if (qEl.dataset.expanded === 'true') {
          showSummary();
        } else {
          qEl.innerHTML = '';
          raw.split(/\n(?=[ \t])/).forEach(chunk => {
            const p = document.createElement('p');
            p.textContent = chunk.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            qEl.appendChild(p);
          });
          qEl.dataset.expanded = 'true';
        }
      };
    } else {
      qEl.style.cursor = '';
      qEl.onclick = null;
    }
  } else {
    qEl.textContent = '';
    qEl.hidden = true;
    qEl.onclick = null;
    qEl.style.cursor = '';
  }

  const rawFiles = await loadFiles(basePath + 'files.json');
  links = rawFiles.filter(f => f.refs);

  playerSection.hidden = false;
  await loadAudioEntry(sortedAudio[0], basePath);

  if (isMobile()) {
    playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
}

// ── Render transcript ───────────────────────────────────────────────────────

function renderTranscript() {
  const frag = document.createDocumentFragment();
  turns.forEach((turn, idx) => {
    const div = document.createElement('div');
    div.className = 'turn ' + speakerClass(turn.name);
    div.id = 'turn-' + idx;
    div.setAttribute('role', 'listitem');

    const sp = document.createElement('span');
    sp.className = 'speaker';
    sp.textContent = formatSpeaker(turn.name);

    const tx = document.createElement('span');
    tx.className = 'turn-text';
    renderTurnText(tx, turn.text, null, false);

    div.appendChild(sp);
    div.appendChild(tx);
    div.addEventListener('click', () => {
      const alreadyActive = idx === activeTurnIdx;
      if (alreadyActive && !audio.paused) {
        audio.pause();
        return;
      }
      if (activeTurnIdx >= 0) {
        document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
      }
      div.classList.add('active');
      activeTurnIdx = idx;
      const hadRef = checkLinksForActiveTurn(idx, true);
      if (!hadRef) collapseDocViewer();
      // Only seek/play if this turn has a real timestamp
      if (turn.time != null) {
        seekAndPlay(turnTimes[idx]);
      } else {
        div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      // Update URL with turn number
      const turnId = turn.turn ?? (idx + 1);
      const url = new URL(location.href);
      url.searchParams.set('turn', turnId);
      history.replaceState(null, '', url);
    });
    frag.appendChild(div);
  });
  turnList.appendChild(frag);
}

// ── Sync highlight on playback ──────────────────────────────────────────────

audio.addEventListener('timeupdate', () => {
  if (!turns.some(t => t.time != null)) return;
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
  const idx = parseInt(e.target.value, 10);
  if (_currentAudioList[idx] && _currentBasePath) {
    await loadAudioEntry(_currentAudioList[idx], _currentBasePath);
  }
});

// ── Case info: tap to scroll back to document browser on mobile ──────────
document.getElementById('case-info').addEventListener('click', () => {
  if (isMobile()) {
    document.getElementById('doc-browser').scrollIntoView({ behavior: 'instant', block: 'start' });
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
  // Vertical: document browser ↔ main panel
  const vHandle         = document.getElementById('v-resize');
  const docBrowserPanel = document.getElementById('doc-browser');
  let vDragging = false, vStartX = 0, vStartW = 0;

  vHandle.addEventListener('mousedown', e => {
    vDragging = true;
    vStartX = e.clientX;
    vStartW = docBrowserPanel.offsetWidth;
    vHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!vDragging) return;
    const w = Math.max(140, Math.min(520, vStartW + (e.clientX - vStartX)));
    docBrowserPanel.style.width = w + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!vDragging) return;
    vDragging = false;
    vHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Horizontal: transcript viewer ↔ document viewer
  const hHandle        = document.getElementById('h-resize');
  const docViewerPanel = document.getElementById('doc-viewer');
  let hDragging = false, hStartY = 0, hStartH = 0;

  // Transparent overlay placed over iframes during drag to prevent them
  // from swallowing mouse events when the cursor moves over them quickly.
  const dragShield = document.createElement('div');
  dragShield.style.cssText = 'position:fixed;inset:0;z-index:9999;display:none;cursor:row-resize';
  document.body.appendChild(dragShield);

  hHandle.addEventListener('mousedown', e => {
    hDragging = true;
    hStartY = e.clientY;
    hStartH = docViewerPanel.offsetHeight;
    hHandle.classList.add('dragging');
    docViewerPanel.style.transition = 'none'; // disable animation while dragging
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

  // Escape closes
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeSearch();
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
      const roleOrder = r => r === 'justice' ? 0 : 1;
      [...caseSpeakers]
        .sort((a, b) => roleOrder(a.role) - roleOrder(b.role) || a.name.localeCompare(b.name))
        .forEach(({ name }) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = formatSpeaker(name);
        opt.title = name;
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
    if (!ref) return;
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

// ── Nav case search ───────────────────────────────────────────────────────────
(function () {
  const navSearchBtn   = document.getElementById('nav-search-btn');
  const navSearchRow   = document.getElementById('nav-search-row');
  const navSearchInput = document.getElementById('nav-search-input');

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

    if (!q) {
      document.querySelectorAll('.case-item').forEach(ci => {
        ci.classList.remove('nav-search-match');
        ci.style.display = '';
      });
      document.querySelectorAll('.month-group, .term-group, .decade-group').forEach(g => {
        g.style.display = '';
        g.classList.remove('open');
      });
      // Expand only the groups containing the currently active case
      const activeCase = document.querySelector('.case-item.active');
      if (activeCase) {
        activeCase.closest('.month-group')?.classList.add('open');
        activeCase.closest('.term-group')?.classList.add('open');
        activeCase.closest('.decade-group')?.classList.add('open');
        requestAnimationFrame(() => activeCase.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }
      return;
    }

    document.querySelectorAll('.case-item').forEach(ci => {
      const title      = ci.querySelector('.case-title-nav')?.textContent.toLowerCase() || '';
      const caseNumber = (ci.dataset.caseKey || '').split('/').pop().toLowerCase();
      const matches    = title.includes(q) || caseNumber.includes(q);

      ci.classList.toggle('nav-search-match', matches);
      ci.style.display = matches ? '' : 'none';
      if (matches) {
        ci.closest('.month-group')?.classList.add('open');
        ci.closest('.term-group')?.classList.add('open');
        ci.closest('.decade-group')?.classList.add('open');
      }
    });

    // Hide month-groups whose cases all got filtered out
    document.querySelectorAll('.month-group').forEach(mg => {
      mg.style.display = mg.querySelector('.nav-search-match') ? '' : 'none';
    });

    // Hide term-groups whose month-groups all got filtered out
    document.querySelectorAll('.term-group').forEach(tg => {
      tg.style.display = tg.querySelector('.nav-search-match') ? '' : 'none';
    });

    // Hide decade-groups whose term-groups all got filtered out
    document.querySelectorAll('.decade-group').forEach(dg => {
      dg.style.display = dg.querySelector('.nav-search-match') ? '' : 'none';
    });

    // Scroll first match into view
    const firstMatch = document.querySelector('.nav-search-match');
    if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  navSearchBtn.addEventListener('click', () => {
    if (navSearchRow.hidden) openNavSearch(); else closeNavSearch();
  });

  navSearchInput.addEventListener('input', () => runNavSearch(navSearchInput.value));

  navSearchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeNavSearch();
  });
})();

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  buildNav();

  // Restore state from URL params
  const params = new URLSearchParams(location.search);
  const termParam = params.get('term');
  const caseParam = params.get('case');
  const fileParam = params.get('file') != null ? parseInt(params.get('file'), 10) : null;
  const turnParam = params.get('turn') != null ? parseInt(params.get('turn'), 10) : null;
  if (termParam && caseParam) {
    // Expand the decade and term shells, then wait for the term's cases to load.
    const termLi = document.querySelector(`.term-group[data-term="${CSS.escape(termParam)}"]`);
    if (termLi) {
      termLi.closest('.decade-group')?.classList.add('open');
      termLi.classList.add('open');
      await termLi._ensureBuilt?.();

      const key = termParam + '/' + caseParam;
      const caseEl = document.querySelector(`.case-item[data-case-key="${CSS.escape(key)}"]`);
      if (caseEl) {
        caseEl.closest('.month-group')?.classList.add('open');

        if (fileParam != null || turnParam != null) {
          document.addEventListener('transcriptloaded', () => {
            if (turnParam != null) {
              const turnIdx = turns.findIndex((t, i) => (t.turn ?? (i + 1)) === turnParam);
              if (turnIdx >= 0) {
                if (activeTurnIdx >= 0) document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
                const el = document.getElementById('turn-' + turnIdx);
                if (el) {
                  el.classList.add('active');
                  activeTurnIdx = turnIdx;
                  if (turns[turnIdx].time != null) seekOnly(turnTimes[turnIdx]);
                  requestAnimationFrame(() => el.scrollIntoView({ behavior: 'instant', block: 'center' }));
                  const url = new URL(location.href);
                  url.searchParams.set('turn', turnParam);
                  history.replaceState(null, '', url);
                }
              }
            }
            if (fileParam != null) {
              const fileEl = document.querySelector(`.file-item[data-file-id="${fileParam}"]`);
              if (fileEl) {
                fileEl.closest('.file-type-group')?.classList.add('open');
                requestAnimationFrame(() => fileEl.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
                fileEl.click();
              }
            }
          }, { once: true });
        }
        // Use dispatchEvent so the fromRestore flag is passed to the title click handler.
        const titleEl = caseEl.querySelector('.case-title-nav');
        if (titleEl) titleEl.dispatchEvent(Object.assign(new MouseEvent('click'), { fromRestore: true }));
        requestAnimationFrame(() => caseEl.scrollIntoView({ behavior: 'instant', block: 'center' }));
      }
    }
  }
}
init();
