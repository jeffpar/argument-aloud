// ── State ───────────────────────────────────────────────────────────────────
let turns = [];
let turnTimes = [];   // each turn's start time in seconds
let activeTurnIdx = -1;
let links = [];        // annotation links for the current case
let activeBottomLinkText = null; // text key of the currently shown bottom link

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

// Normalise link.refs (string or array) to an array of strings.
function getRefs(link) {
  if (!link.refs) return [];
  return Array.isArray(link.refs) ? link.refs : [link.refs];
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
    getRefs(link).forEach(ref => {
      findWholeWordMatches(rawText, ref).forEach(({ start, end }) => {
        marks.push({ start, end, kind: 'ref', link });
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
  marks.forEach(({ start, end, kind, link }) => {
    if (start < cursor) return; // skip overlapping
    if (start > cursor) frag.appendChild(document.createTextNode(rawText.slice(cursor, start)));
    if (kind === 'ref') {
      const span = document.createElement('span');
      span.className = 'ref-mark';
      span.textContent = rawText.slice(start, end);
      span.addEventListener('click', e => {
        e.stopPropagation();
        showDocViewer(link, { autoScroll: true });
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

function checkLinksForActiveTurn(idx) {
  if (!links.length || idx < 0 || idx >= turns.length) return;
  const turnText = turns[idx].text;
  const match = links.find(l => l.view === 'bottom' && getRefs(l).some(r => matchesWholeWord(turnText, r)));
  if (match && match.href !== activeBottomLinkText) {
    showDocViewer(match);
  }
}

// autoScroll: when true, scrolls the document viewer into view on mobile
// (used for explicit user clicks; omitted for auto-sync during playback).
function showDocViewer(link, { autoScroll = false } = {}) {
  const panel  = document.getElementById('doc-viewer');
  const card   = document.getElementById('doc-viewer-card');
  const pdfEl  = document.getElementById('doc-viewer-pdf');
  const isPdf  = /\.pdf(\?|$)/i.test(link.href);

  document.getElementById('doc-viewer-url').textContent = link.href;
  activeBottomLinkText = link.href || null;

  if (isPdf) {
    card.style.display = 'none';
    pdfEl.style.display = 'block';
    const pdfSrc = link.href.includes('#') ? link.href : link.href + '#pagemode=none';
    if (pdfEl.src !== pdfSrc) pdfEl.src = pdfSrc;
  } else {
    pdfEl.style.display = 'none';
    pdfEl.src = '';
    card.style.display = '';
    document.getElementById('doc-viewer-card-title').textContent = link.title || getRefs(link)[0] || '';
    document.getElementById('doc-viewer-card-desc').textContent = link.description || '';
    const anchor = document.getElementById('doc-viewer-card-link');
    anchor.href = link.href;
  }

  panel.hidden = false;
  if (autoScroll && isMobile()) {
    panel.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
}

// ── Build nav ───────────────────────────────────────────────────────────────

function buildNav(termData) {
  const termListEl = document.getElementById('term-list');
  termListEl.innerHTML = '';

  termData.sort((a, b) => (a.term < b.term ? 1 : -1)); // newest term first

  termData.forEach(({ term, cases }) => {
    const li = document.createElement('li');
    li.className = 'term-group';

    const label = document.createElement('span');
    label.className = 'term-label';
    label.textContent = termDisplayName(term);
    li.appendChild(label);

    const ul = document.createElement('ul');
    ul.className = 'case-list';

    const sortedCases = [...cases].sort((a, b) => {
      const da = a.arguments?.[0]?.date ?? '';
      const db = b.arguments?.[0]?.date ?? '';
      return da < db ? -1 : da > db ? 1 : 0;
    });

    sortedCases.forEach(caseEntry => {
      const caseKey = term + '/' + caseEntry.number;
      const basePath = '/courts/ussc/terms/' + term + '/' + caseEntry.number + '/';

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
      const argDate = caseEntry.arguments?.[0]?.date;
      const dateSuffix = argDate
        ? ' (' + new Date(argDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ')'
        : '';
      titleSpan.textContent = caseEntry.title + dateSuffix;

      header.appendChild(toggle);
      header.appendChild(titleSpan);

      // ── File sub-list (populated lazily) ──────────────────
      const fileUl = document.createElement('ul');
      fileUl.className = 'file-list';
      let filesLoaded = false;

      header.addEventListener('click', async () => {
        const isOpen = ci.classList.toggle('open');
        if (isOpen && !filesLoaded) {
          filesLoaded = true;
          const rawFiles = await loadFiles(basePath + 'files.json');

          const TYPE_LABELS = {
            petitioner: 'Petitioner',
            respondent: 'Respondent',
            reference:  'References',
            other:      'Other',
          };
          const ORDER = ['petitioner', 'respondent', 'reference', 'other'];

          // Group files by type
          const groups = {};
          rawFiles.forEach(f => {
            const key = (f.type || 'other').toLowerCase();
            if (!groups[key]) groups[key] = [];
            groups[key].push(f);
          });

          ORDER.forEach(typeKey => {
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
              fi.textContent = f.title;
              fi.addEventListener('click', e => {
                e.stopPropagation();
                document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
                fi.classList.add('active');
                showDocViewer(f, { autoScroll: true });
              });
              itemsUl.appendChild(fi);
            });

            groupLi.appendChild(typeHeader);
            groupLi.appendChild(itemsUl);
            fileUl.appendChild(groupLi);
          });
        }
        // Also load the transcript when opening
        if (isOpen) loadCase(term, caseEntry);
      });

      ci.appendChild(header);
      ci.appendChild(fileUl);
      ul.appendChild(ci);
    });

    li.appendChild(ul);
    termListEl.appendChild(li);
  });
}

// ── Load a case ─────────────────────────────────────────────────────────────

async function loadCase(term, caseEntry) {
  if (!caseEntry.arguments || !caseEntry.arguments.length) return;
  const arg = caseEntry.arguments[0];
  const caseKey = term + '/' + caseEntry.number;
  const basePath = '/courts/ussc/terms/' + term + '/' + caseEntry.number + '/';
  const transcriptUrl = /^https?:\/\//i.test(arg.text_href) ? arg.text_href : (basePath + arg.text_href);
  const audioUrl      = arg.audio_href || (basePath + arg.audio);
  const filesUrl      = basePath + 'files.json';

  // Update nav
  document.querySelectorAll('.case-item').forEach(el => el.classList.remove('active'));
  const nav = document.querySelector(`.case-item[data-case-key="${CSS.escape(caseKey)}"]`);
  if (nav) nav.classList.add('active');

  // Reset transcript area
  playerSection.hidden = true;
  emptyState.style.display = 'none';
  turnList.style.display = 'none';
  turnList.innerHTML = '';
  loadingMsg.style.display = 'block';
  activeTurnIdx = -1;

  try {
    const res = await fetch(transcriptUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    turns = await res.json();
    turnTimes = turns.map(t => parseTime(t.time ?? '00:00:00.00'));

    document.getElementById('case-num-label').textContent = 'No.\u00a0' + caseEntry.number;
    document.getElementById('case-title-label').textContent = caseEntry.title;

    audio.src = audioUrl;
    audio.load();

    const rawFiles = await loadFiles(filesUrl);
    links = rawFiles.filter(f => f.refs);

    renderTranscript();
    document.getElementById('doc-viewer').hidden = true;
    activeBottomLinkText = null;

    loadingMsg.style.display = 'none';
    playerSection.hidden = false;
    turnList.style.display = 'block';
    document.dispatchEvent(new Event('transcriptloaded'));
    if (isMobile()) {
      playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
    }
  } catch (err) {
    loadingMsg.textContent = 'Error loading transcript.';
    console.error(err);
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
      // Seek and play from this turn's position
      seekAndPlay(turnTimes[idx]);
      // Update the active highlight manually
      if (activeTurnIdx >= 0) {
        document.getElementById('turn-' + activeTurnIdx)?.classList.remove('active');
      }
      div.classList.add('active');
      activeTurnIdx = idx;
      checkLinksForActiveTurn(idx);
    });
    frag.appendChild(div);
  });
  turnList.appendChild(frag);
}

// ── Sync highlight on playback ──────────────────────────────────────────────

audio.addEventListener('timeupdate', () => {
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

// ── Case info: tap to scroll back to document browser on mobile ──────────
document.getElementById('case-info').addEventListener('click', () => {
  if (isMobile()) {
    document.getElementById('doc-browser').scrollIntoView({ behavior: 'instant', block: 'start' });
  }
});

// ── Document Viewer close button ──────────────────────────────────────────
document.getElementById('doc-viewer-close').addEventListener('click', () => {
  document.getElementById('doc-viewer').hidden = true;
  activeBottomLinkText = null;
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

  hHandle.addEventListener('mousedown', e => {
    hDragging = true;
    hStartY = e.clientY;
    hStartH = docViewerPanel.offsetHeight;
    hHandle.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!hDragging) return;
    // Dragging up (negative delta) grows the panel
    const h = Math.max(60, Math.min(window.innerHeight * 0.85, hStartH - (e.clientY - hStartY)));
    docViewerPanel.style.height = h + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!hDragging) return;
    hDragging = false;
    hHandle.classList.remove('dragging');
    document.body.style.cursor = '';
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

  function highlightMatches(query) {
    clearHighlights();
    matchIndices = [];
    if (!query) { updateStatus(); return; }

    const queryLower = query.toLowerCase();
    turns.forEach((turn, idx) => {
      if (turn.text.toLowerCase().includes(queryLower)) matchIndices.push(idx);
    });
    updateStatus();
    // Re-render all matching turns with highlighted spans
    matchIndices.forEach(idx => {
      applyHighlight(idx, query, false);
    });
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
      statusEl.textContent = input.value ? 'No matches found.' : '';
    } else {
      statusEl.textContent = (matchCursor >= 0 ? (matchCursor + 1) + ' of ' : '') + matchIndices.length + ' match' + (matchIndices.length === 1 ? '' : 'es');
    }
    prevBtn.disabled = matchIndices.length === 0;
    nextBtn.disabled = matchIndices.length === 0;
  }

  function goToMatch(delta) {
    if (!matchIndices.length) return;
    const query = input.value;
    // Remove 'current' from previous
    if (matchCursor >= 0) applyHighlight(matchIndices[matchCursor], query, false);
    matchCursor = (matchCursor + delta + matchIndices.length) % matchIndices.length;
    applyHighlight(matchIndices[matchCursor], query, true);
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

  // Live search as user types; pressing Enter advances to next match
  input.addEventListener('input', () => {
    matchCursor = -1;
    highlightMatches(input.value.trim());
    if (matchIndices.length) goToMatch(0);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goToMatch(-1); else goToMatch(1);
    }
  });

  nextBtn.addEventListener('click', () => goToMatch(1));
  prevBtn.addEventListener('click', () => goToMatch(-1));

  // Clear highlights whenever a new transcript is loaded
  document.addEventListener('transcriptloaded', () => {
    matchIndices = [];
    matchCursor  = -1;
    input.value  = '';
    statusEl.textContent = '';
  });
})();

// ── Init ────────────────────────────────────────────────────────────────────
async function init() {
  const termResults = await Promise.all(
    TERMS.map(async ({ term, casesUrl }) => {
      try {
        const res = await fetch(casesUrl, { cache: 'reload' });
        if (!res.ok) return null;
        const cases = await res.json();
        return { term, cases };
      } catch (e) {
        console.warn('[cases] fetch failed for term', term, e);
        return null;
      }
    })
  );
  buildNav(termResults.filter(Boolean));
}
init();
