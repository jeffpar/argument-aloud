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
// True once the user explicitly closes the doc viewer (the "x" button) for the
// current transcript — suppresses further auto-open-on-turn-change until a
// different case/transcript loads (see loadAudioEntry/loadCaseAsOpinion), but
// never blocks an explicit click (a ref-mark or a file-list item).
let _docViewerAutoOpenSuppressed = false;
let docViewerOpenHeight = null;  // px height for next animated open (null = use 45vh default)
let _fileClickSeq = 0; // bumped on every file/citation click so a stale async citation
                        // lookup can't clobber a URL change made by a later click
let _currentAudioList = [];    // sorted audio entries for the active case
let _currentEvents    = [];    // unsorted events[] for the active case (URL `event` indexes into this)
let _currentBasePath  = '';    // base URL path for the active case
let _currentLoadedEntry = null; // the audio entry object currently loaded in loadAudioEntry
let _currentCaseEntry   = null; // the case object currently loaded
let _currentDecisionEntries    = []; // decision entries [{value,href,title}] for the active case (file dropdown sentinels)
let _currentTranscriptEntries  = []; // transcript PDF entries [{value,href,title}] for the active case
// Pool of persistent PDF iframes keyed by full src URL (including #page fragment).
// Switching between entries is a pure show/hide — no reload, no about:blank bounce.
// LRU eviction keeps the pool bounded.
const _pdfIframePool = new Map();   // src → <iframe>  (insertion order == LRU)
const _PDF_POOL_MAX  = 5;

// Propagates the top-level document's current dark/light theme into a same-
// origin framed document (e.g. a PDF viewer's own UI, or an embedded "pane"
// page). Cross-origin frames (e.g. an actual PDF file, as opposed to our own
// PDF-viewing chrome) throw on contentDocument access — caught and ignored.
function _applyThemeToFrame(frame) {
  try {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) frame.contentDocument.documentElement.setAttribute('data-theme', t);
    else frame.contentDocument.documentElement.removeAttribute('data-theme');
  } catch (_) {}
}

function _getOrCreatePdfIframe(src) {
  if (_pdfIframePool.has(src)) {
    // Refresh to most-recently-used position.
    const el = _pdfIframePool.get(src);
    _pdfIframePool.delete(src);
    _pdfIframePool.set(src, el);
    return el;
  }
  if (_pdfIframePool.size >= _PDF_POOL_MAX) {
    const { value: [lruSrc, lruEl] } = _pdfIframePool.entries().next();
    _pdfIframePool.delete(lruSrc);
    lruEl.remove();
  }
  const el = document.createElement('iframe');
  el.title = 'PDF document';
  el.setAttribute('allow', 'fullscreen');
  el.className = 'pdf-iframe';
  // Non-PDF "pane" documents already self-apply the theme on load (see the
  // localStorage bootstrap script in _layouts/pane.html), but nothing then
  // keeps them in sync if the user switches theme while one is open — so
  // re-apply on every load, and expose the pool to the theme switcher below.
  el.addEventListener('load', () => _applyThemeToFrame(el));
  document.getElementById('doc-viewer-pdf').insertAdjacentElement('afterend', el);
  _pdfIframePool.set(src, el);
  return el;
}

function _clearPdfIframePool() {
  for (const el of _pdfIframePool.values()) el.remove();
  _pdfIframePool.clear();
}
let _currentOyezEntries = []; // Oyez case-description entries for the active case [{value,href,title}]
let _currentVideoEntries = []; // OTD video events for the active case [{href, title}]
let _currentTranscriptPdfUrl = null; // resolved transcript_href for the active audio entry
let _currentJournalRefs = new Map(); // sentinel value -> { href, title } for journal_ref dropdown options
let _currentMinutesRefs = new Map(); // sentinel value -> { href, title } for minutes_href dropdown options
let _currentFiles       = [];        // files.json entries for the active case (used by file: dropdown options)
let _collectionsSectionLi = null; // top-level Collections <li>
let _topicsSectionLi      = null; // top-level Topics <li>
const _sectionLiById      = new Map(); // entry.id → top-level section <li>
const _sectionPageById = new Map(); // entry.id → entry.page (index.json), for <id>=all fallback
let _defaultPage = null; // page URL of the index.json node marked "default": true — the SPA's default landing page

// ── Transcript edit mode state ──────────────────────────────────────────────
let _editMode = false;
// Removing a focused element from the DOM (e.g. turnList.innerHTML = '' during
// the re-render after a Ctrl/Cmd+Enter split) fires a native blur on it — but
// at the moment that blur handler runs, the element's `isConnected` can still
// read true (the browser fires blur before actually detaching the node), so
// isConnected alone can't tell a real user blur apart from this one. This
// flag is set explicitly around that kind of programmatic teardown instead.
let _suppressTurnBlurSave = false;
// caseKey -> { title, number?, id?, eventEdits: Map<text_href, Map<turnIdx, {turnNum,name,text?}>> }
let _transcriptEdits = new Map();
let _currentTextHref = ''; // text_href of the currently loaded transcript
let _currentCaseKey  = ''; // caseKey of the currently loaded case
let _currentTerm     = ''; // term of the currently loaded case
const _caseSessionState = new Map(); // caseKey -> { eventIdx, turnNum } — session memory, cleared on reload

const _LS_EDITS_KEY     = 'aa-transcript-edits';
const _LS_FAVORITES_KEY = 'aa-favorites';
const _LS_TAGS_KEY      = 'aa-tags';

function _persistEditsToStorage() {
  if (!_transcriptEdits.size) {
    localStorage.removeItem(_LS_EDITS_KEY);
    _refreshEditsNav();
    return;
  }
  const obj = {};
  for (const [caseKey, caseData] of _transcriptEdits) {
    const eventEditsObj = {};
    for (const [textHref, turnEdits] of caseData.eventEdits) {
      const turnsObj = {};
      for (const [turnIdx, turnEdit] of turnEdits) turnsObj[turnIdx] = turnEdit;
      eventEditsObj[textHref] = turnsObj;
    }
    obj[caseKey] = {
      title: caseData.title,
      term: caseData.term,
      ...(caseData.number !== undefined ? { number: caseData.number } : {}),
      ...(caseData.id     !== undefined ? { id:     caseData.id     } : {}),
      eventEdits: eventEditsObj
    };
  }
  try { localStorage.setItem(_LS_EDITS_KEY, JSON.stringify(obj)); } catch { /* quota exceeded */ }
  _refreshEditsNav();
}

function _loadEditsFromStorage() {
  let raw;
  try { raw = localStorage.getItem(_LS_EDITS_KEY); } catch { return; }
  if (!raw) return;
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  if (!obj || typeof obj !== 'object') return;
  _transcriptEdits.clear();
  for (const [caseKey, caseData] of Object.entries(obj)) {
    if (!caseData || typeof caseData !== 'object') continue;
    const eventEditsMap = new Map();
    for (const [textHref, turnsObj] of Object.entries(caseData.eventEdits || {})) {
      if (!turnsObj || typeof turnsObj !== 'object') continue;
      const turnEditsMap = new Map();
      for (const [idxStr, edit] of Object.entries(turnsObj)) {
        const idx = parseInt(idxStr, 10);
        if (!isNaN(idx) && edit && typeof edit === 'object') turnEditsMap.set(idx, edit);
      }
      if (turnEditsMap.size) eventEditsMap.set(textHref, turnEditsMap);
    }
    if (eventEditsMap.size) {
      _transcriptEdits.set(caseKey, {
        title: caseData.title || '',
        term:  caseData.term  || '',
        ...(caseData.number !== undefined ? { number: caseData.number } : {}),
        ...(caseData.id     !== undefined ? { id:     caseData.id     } : {}),
        eventEdits: eventEditsMap
      });
    }
  }
}

// ── Favorites ─────────────────────────────────────────────────────────────────
// Storage format v2:
// { groups: [{ id, name }, ...], items: [{ court, groupId, caseRef }, ...] }
// The "unfiled" group always exists and is the default target for new favorites.

function _getFavData() {
  try {
    const raw = JSON.parse(localStorage.getItem(_LS_FAVORITES_KEY) || 'null');
    if (!raw) return { groups: [{ id: 'unfiled', name: 'Unfiled' }], items: [] };
    if (Array.isArray(raw)) {
      // Migrate v1 (plain array) → v2
      return { groups: [{ id: 'unfiled', name: 'Unfiled' }], items: raw.map(f => ({ ...f, groupId: 'unfiled' })) };
    }
    if (!raw.groups?.some(g => g.id === 'unfiled')) {
      raw.groups = [{ id: 'unfiled', name: 'Unfiled' }, ...(raw.groups || [])];
    }
    return raw;
  } catch { return { groups: [{ id: 'unfiled', name: 'Unfiled' }], items: [] }; }
}

function _setFavData(data) {
  try { localStorage.setItem(_LS_FAVORITES_KEY, JSON.stringify(data)); }
  catch { /* quota exceeded */ }
}

function _getFavorites() {
  return _getFavData().items;
}

function _favKey(fav) {
  return `${fav.court}:${fav.caseRef.term}:${fav.caseRef.number}:${fav.caseRef.event ?? 0}`;
}

// #file-select's `hidden` and its wrapper's `hidden` are kept in sync — the
// wrapper also draws the arrow indicator, which has no meaning when there's
// no dropdown to open.
function _setFileSelectHidden(hidden) {
  const sel = document.getElementById('file-select');
  if (sel) sel.hidden = hidden;
  const wrap = document.getElementById('file-select-wrap');
  if (wrap) wrap.hidden = hidden;
}

function _currentFavKey() {
  if (!_currentCaseEntry || !_currentCaseKey) return null;
  const term   = _currentCaseKey.split('/')[0];
  const number = _currentCaseEntry.number || _currentCaseEntry.id || '';
  const fileSel = document.getElementById('file-select');
  let evIdx = 0;
  if (!fileSel?.hidden) {
    const selVal   = parseInt(fileSel?.value ?? '0', 10);
    const selEntry = selVal >= 1 ? _currentAudioList[selVal - 1] : null;
    evIdx = selEntry ? Math.max(1, _currentEvents.indexOf(selEntry) + 1) : 0;
  }
  return `ussc:${term}:${number}:${evIdx}`;
}

function _updateFavoriteBtn() {
  const btn = document.getElementById('favorite-btn');
  if (!btn) return;
  if (!_currentCaseEntry || !_currentCaseKey) { btn.hidden = true; return; }
  const key   = _currentFavKey();
  const isFav = key ? _getFavorites().some(f => _favKey(f) === key) : false;
  btn.hidden = false;
  btn.classList.toggle('favorited', isFav);
  btn.title = isFav ? 'Remove from Favorites' : 'Add to Favorites';
}

function _toggleFavorite() {
  if (!_currentCaseEntry || !_currentCaseKey) return;
  const key = _currentFavKey();
  if (!key) return;
  const data = _getFavData();
  const idx  = data.items.findIndex(f => _favKey(f) === key);
  if (idx >= 0) {
    data.items.splice(idx, 1);
    // Auto-remove empty non-unfiled groups
    const used = new Set(data.items.map(f => f.groupId));
    data.groups = data.groups.filter(g => g.id === 'unfiled' || used.has(g.id));
    // Reset active group if it was removed
    if (!data.groups.some(g => g.id === _activeFavGroupId)) _activeFavGroupId = 'unfiled';
  } else {
    const term   = _currentCaseKey.split('/')[0];
    const number = _currentCaseEntry.number || _currentCaseEntry.id || '';
    const fileSel = document.getElementById('file-select');
    let evIdx = 0, selEntry = null;
    if (!fileSel?.hidden) {
      const selVal = parseInt(fileSel?.value ?? '0', 10);
      selEntry = selVal >= 1 ? _currentAudioList[selVal - 1] : null;
      evIdx = selEntry ? Math.max(1, _currentEvents.indexOf(selEntry) + 1) : 0;
    }
    const ce = _currentCaseEntry;
    const _activeTurn = (activeTurnIdx >= 0 && turns[activeTurnIdx])
      ? (turns[activeTurnIdx].turn ?? (activeTurnIdx + 1))
      : null;
    const caseRef = {
      term,
      number,
      title:    _caseDisplayTitle(ce, selEntry || _currentLoadedEntry),
      argument: ce.argument || '',
      ...(ce.reargument ? { reargument: ce.reargument } : {}),
      ...(evIdx > 0 ? { event: evIdx } : {}),
      ...(_activeTurn != null ? { turn: _activeTurn } : {}),
      files:    !!ce.files,
      ...(ce.decision ? { decision: ce.decision } : {}),
    };
    const targetGroupId = data.groups.some(g => g.id === _activeFavGroupId) ? _activeFavGroupId : 'unfiled';
    data.items.push({ court: 'ussc', groupId: targetGroupId, caseRef });
  }
  _setFavData(data);
  _updateFavoriteBtn();
  _refreshFavoritesNav();
}

// ── Tags ──────────────────────────────────────────────────────────────────────
// Storage: { "ussc:term:number": ["UserTag1", …] }
// Hard-coded case tags come from caseEntry.tags; user tags overlay them.

function _getTagData() {
  try {
    const raw = JSON.parse(localStorage.getItem(_LS_TAGS_KEY) || 'null');
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}

function _sortedTagData(data) {
  return Object.fromEntries(
    Object.keys(data).sort((a, b) => {
      const [, termA, numA = ''] = a.split(':');
      const [, termB, numB = ''] = b.split(':');
      if (termA !== termB) return termA < termB ? -1 : 1;
      const nA = parseInt(numA, 10), nB = parseInt(numB, 10);
      if (!isNaN(nA) && !isNaN(nB)) return nA - nB;
      return numA < numB ? -1 : numA > numB ? 1 : 0;
    }).map(k => [k, data[k]])
  );
}

function _setTagData(data) {
  try {
    if (!Object.keys(data).length) localStorage.removeItem(_LS_TAGS_KEY);
    else localStorage.setItem(_LS_TAGS_KEY, JSON.stringify(_sortedTagData(data)));
  } catch { /* quota exceeded */ }
}

function _currentTagKey() {
  if (!_currentCaseEntry || !_currentCaseKey) return null;
  const term   = _currentCaseKey.split('/')[0];
  const number = _currentCaseEntry.number || _currentCaseEntry.id || '';
  return `ussc:${term}:${number}`;
}

function _getBuiltinTags() {
  const t = _currentCaseEntry?.tags;
  if (!t) return [];
  return Array.isArray(t) ? t.slice() : [String(t)];
}

function _getUserTags() {
  const key = _currentTagKey();
  if (!key) return [];
  return (_getTagData()[key] || []).slice();
}

function _addUserTag(tag) {
  const key = _currentTagKey();
  if (!key) return;
  const trimmed = tag.trim();
  if (!trimmed) return;
  const data = _getTagData();
  if (!data[key]) data[key] = [];
  if (!data[key].includes(trimmed)) {
    data[key].push(trimmed);
    _setTagData(data);
    _updateTagsBtn();
    _injectLocalTagIntoLoadedGroups(trimmed);
  }
}

// Build a group-listing case ref (matching the shape update_cases.js writes
// into tag-based collection/topic files) from a full case entry.
function _buildGroupCaseRefFromEntry(caseEntry, term) {
  const ref = {
    term,
    number: caseEntry.number || caseEntry.id || '',
    title:  caseEntry.title || '',
  };
  if (caseEntry.argument)   ref.argument   = caseEntry.argument;
  if (caseEntry.reargument) ref.reargument = caseEntry.reargument;
  if (caseEntry.decision)   ref.decision   = caseEntry.decision;
  if (caseEntry.files)      ref.files      = caseEntry.files;
  const events = Array.isArray(caseEntry.events) ? caseEntry.events : [];
  if (events.some(e => e.audio_href)) ref.event      = true;
  if (events.some(e => e.text_href))  ref.transcript = true;
  return ref;
}

// Resolve the set of tags a case must carry to belong to a rendered
// collection/topic group, for the purposes of local (client-only) tag
// merging. Named (non-fan-out) groups declare their own "tags" (merged in
// from collections.json/topics.json onto the fetched group object — see
// _ensureCollectionBuilt). Fan-out ("*") sub-groups have no such declaration
// of their own: their base tags normally come from the "*" group's def in
// collEntry.groups, plus the sub-group's own name (which IS the qualifying
// tag) — UNLESS that "*" group def opts in to "allow_group_merging", in
// which case the sub-group's own name alone is sufficient (the base tag,
// e.g. "Noteworthy", is not required for a locally-added tag to merge in).
function _requiredTagsForGroup(collEntry, group) {
  if (Array.isArray(group.tags) && group.tags.length) return group.tags.slice();
  const fanoutDef = (collEntry.groups || []).find(g => (g.name ?? g.title) === '*');
  if (fanoutDef && Array.isArray(fanoutDef.tags)) {
    return fanoutDef.allow_group_merging ? [group.name] : [...fanoutDef.tags, group.name];
  }
  return [];
}

// Scan localStorage tag data for cases that now qualify for `group` (per
// _requiredTagsForGroup) but aren't in its server-generated case list — i.e.
// cases that only qualify because of a user-added tag. Only checks cases that
// have at least one *user* tag among the group's required tags, since a case
// that already qualifies from its static (builtin) tags alone would already
// be present in the generated file.
async function _localTagMatchesForGroup(collEntry, group) {
  const requiredTags = _requiredTagsForGroup(collEntry, group);
  if (!requiredTags.length) return [];
  const tagData = _getTagData();
  const matches = [];
  for (const [key, userTags] of Object.entries(tagData)) {
    if (!userTags.length || !requiredTags.some(t => userTags.includes(t))) continue;
    const [, term, number] = key.split(':');
    const cases = await fetchTermCases(term);
    const entry = cases.find(c => c.number === number
      || (c.number && c.number.split(',').map(n => n.trim()).includes(number))
      || (!c.number && c.id === number));
    if (!entry) continue;
    const builtinTags = Array.isArray(entry.tags) ? entry.tags : (entry.tags ? [String(entry.tags)] : []);
    const allTags = [...builtinTags, ...userTags];
    if (!requiredTags.every(t => allTags.includes(t))) continue;
    matches.push(_buildGroupCaseRefFromEntry(entry, term));
  }
  return matches;
}

// Check whether one specific case still qualifies for `group` (per
// _requiredTagsForGroup), using its builtin tags plus whatever localStorage
// user tags it currently carries. Shared by the group-load reconciliation
// scan (_localTagMatchesForGroup) and the single-case removal check below.
async function _caseQualifiesForGroup(collEntry, group, term, number) {
  const requiredTags = _requiredTagsForGroup(collEntry, group);
  if (!requiredTags.length) return false;
  const cases = await fetchTermCases(term);
  const entry = cases.find(c => c.number === number
    || (c.number && c.number.split(',').map(n => n.trim()).includes(number))
    || (!c.number && c.id === number));
  if (!entry) return false;
  const builtinTags = Array.isArray(entry.tags) ? entry.tags : (entry.tags ? [String(entry.tags)] : []);
  const userTags = _getTagData()[`ussc:${term}:${number}`] || [];
  const allTags = [...builtinTags, ...userTags];
  return requiredTags.every(t => allTags.includes(t));
}

// When a tag is added to the current case, check whether any already-built
// collection/topic nav has a group matching that tag, and if so inject the
// case directly into that group's listing (so it shows up without a reload).
async function _injectLocalTagIntoLoadedGroups(tag) {
  if (!_currentCaseEntry || !_currentCaseKey) return;
  const term = _currentCaseKey.split('/')[0];
  const allTags = [..._getBuiltinTags(), ..._getUserTags()];
  const target = await _resolveTagTarget(tag, allTags);
  if (!target || target.groupIdx == null) return;
  const reg = _collRegistryById.get(target.id);
  if (!reg) return;
  await reg.ensureBuilt();
  const groupLi = reg.collUl.querySelector(`:scope > .month-group[data-group-idx="${target.groupIdx}"]`);
  if (!groupLi || typeof groupLi._addLocalCase !== 'function') return;
  groupLi._addLocalCase(_buildGroupCaseRefFromEntry(_currentCaseEntry, term));
}

// Mirror image of _injectLocalTagIntoLoadedGroups: when a tag is removed,
// check whether it was the case's only qualifying link to a rendered group,
// and if so drop the case from that group's listing immediately.
async function _removeLocalTagFromLoadedGroups(tag) {
  if (!_currentCaseEntry || !_currentCaseKey) return;
  const term = _currentCaseKey.split('/')[0];
  const allTags = [..._getBuiltinTags(), ..._getUserTags()];
  const target = await _resolveTagTarget(tag, allTags);
  if (!target || target.groupIdx == null) return;
  const reg = _collRegistryById.get(target.id);
  if (!reg) return;
  const groupLi = reg.collUl.querySelector(`:scope > .month-group[data-group-idx="${target.groupIdx}"]`);
  if (!groupLi || typeof groupLi._removeLocalCaseIfUnqualified !== 'function') return;
  const number = _currentCaseEntry.number || _currentCaseEntry.id || '';
  groupLi._removeLocalCaseIfUnqualified(term, number);
}

function _removeUserTag(tag) {
  const key = _currentTagKey();
  if (!key) return;
  const data = _getTagData();
  if (!data[key]) return;
  data[key] = data[key].filter(t => t !== tag);
  if (!data[key].length) delete data[key];
  _setTagData(data);
  _updateTagsBtn();
  _removeLocalTagFromLoadedGroups(tag);
}

function _pruneRedundantUserTags() {
  const key = _currentTagKey();
  if (!key) return;
  const builtin = _getBuiltinTags();
  if (!builtin.length) return;
  const data = _getTagData();
  if (!data[key]) return;
  const pruned = data[key].filter(t => !builtin.includes(t));
  if (pruned.length === data[key].length) return;
  if (pruned.length) data[key] = pruned;
  else delete data[key];
  _setTagData(data);
}

function _updateTagsBtn() {
  // Tags sits in row2, next to the favorite button — not row3, which now
  // holds only the vote line.
  const row = document.getElementById('case-info-row2');
  const btn = document.getElementById('tags-btn');
  if (!row || !btn) return;
  if (!_currentCaseEntry || !_currentCaseKey) { btn.hidden = true; return; }
  const total = _getBuiltinTags().length + _getUserTags().length;
  btn.textContent = total ? 'Tags (' + total + ')' : 'Tags';
  btn.hidden = false;
  row.hidden = false;
}

// Cache of collection/topic JSON group-array fetches, keyed by file URL —
// used only to resolve a tag to a specific group's 1-based position.
const _collectionGroupsCache = new Map();

// Registry of built collection/topic nav entries, keyed by collId — lets tag
// mutations reach into an already-rendered nav to inject/refresh a case
// without waiting for a full page reload. Populated in buildCollectionItem().
const _collRegistryById = new Map();
function _fetchCollectionGroups(fileUrl) {
  if (_collectionGroupsCache.has(fileUrl)) return _collectionGroupsCache.get(fileUrl);
  const p = fetch(fileUrl, { cache: 'reload' }).then(r => r.ok ? r.json() : []).catch(() => []);
  _collectionGroupsCache.set(fileUrl, p);
  return p;
}

// Flatten collections.json / topics.json (including nested "collections"
// categories like Justices/Advocates) into a list of tag-bearing group defs:
// { isTopic, id, fileUrl, requiredTags, groupName, isFanout, allowMerge }.
// isFanout marks a "*" group whose real sub-groups are generated per unique
// non-required tag found on qualifying cases (see _buildTagsCollection in
// scripts/update_cases.js). allowMerge mirrors that "*" group def's own
// "allow_group_merging" flag — see _requiredTagsForGroup.
function _collectTagGroupDefs() {
  const out = [];
  function walk(entries, isTopic) {
    for (const e of entries || []) {
      if (Array.isArray(e.collections)) { walk(e.collections, isTopic); continue; }
      const fileUrl = e.file ?? e.collection;
      if (!fileUrl || !Array.isArray(e.groups)) continue;
      const id = e.id || fileUrl.split('/').pop().replace('.json', '');
      for (const g of e.groups) {
        if (!Array.isArray(g.tags) || !g.tags.length) continue;
        out.push({ isTopic, id, fileUrl, requiredTags: g.tags, groupName: g.name, groupId: g.id ?? null, isFanout: g.name === '*', allowMerge: !!g.allow_group_merging });
      }
    }
  }
  walk(COLLECTIONS, false);
  walk(TOPICS, true);
  return out;
}

// Resolve one of a case's own tags to a { isTopic, id, groupId, groupIdx }
// navigation target within collections.json/topics.json, or null when the
// tag doesn't correspond to any collection/topic. A statically-declared
// group (one with its own "id" in collections.json) resolves groupId
// directly, no fetch needed; only a group without one falls back to
// groupIdx (1-based, matching the legacy URL 'group' param), resolved by
// fetching the collection/topic's generated file and finding the matching
// group's position. Both null means "link to the collection/topic root, no
// specific group".
async function _resolveTagTarget(tag, caseTags) {
  const defs = _collectTagGroupDefs();
  // Direct match: tag is a named (non-fan-out) group's own declared tag.
  const direct = defs.find(d => !d.isFanout && d.requiredTags.includes(tag));
  if (direct) {
    if (direct.groupId != null) return { isTopic: direct.isTopic, id: direct.id, groupId: direct.groupId, groupIdx: null };
    const groups = await _fetchCollectionGroups(direct.fileUrl);
    const idx = Array.isArray(groups) ? groups.findIndex(g => g.name === direct.groupName) : -1;
    return { isTopic: direct.isTopic, id: direct.id, groupId: null, groupIdx: idx >= 0 ? idx + 1 : null };
  }
  // Fan-out root match: tag is the fan-out's own required tag — link to the
  // collection/topic root (e.g. the "Noteworthy" tag itself, as opposed to
  // one of its per-category sub-tags).
  const fanoutRoot = defs.find(d => d.isFanout && d.requiredTags.includes(tag));
  if (fanoutRoot) return { isTopic: fanoutRoot.isTopic, id: fanoutRoot.id, groupId: null, groupIdx: null };
  // Fan-out sub-group match: the case qualifies for some fan-out (carries all
  // of its required tags — or, when the fan-out opts in to
  // "allow_group_merging", just the candidate tag itself), and `tag` may be
  // one of its dynamically-generated per-category sub-group names — the only
  // way to know is to check the fan-out's generated file for a group whose
  // name equals this tag.
  for (const d of defs) {
    if (!d.isFanout) continue;
    if (!d.allowMerge && !d.requiredTags.every(rt => caseTags.includes(rt))) continue;
    const groups = await _fetchCollectionGroups(d.fileUrl);
    const idx = Array.isArray(groups) ? groups.findIndex(g => g.name === tag) : -1;
    if (idx >= 0) return { isTopic: d.isTopic, id: d.id, groupId: null, groupIdx: idx + 1 };
  }
  return null;
}

// Navigate to a resolved tag target, focusing the current case within it.
function _navigateToTagTarget(target) {
  if (!_currentCaseEntry || !_currentCaseKey) return;
  const term = _currentCaseKey.split('/')[0];
  // Reuse the URL's own 'case' value (rather than caseId(_currentCaseEntry))
  // so that a specific consolidated docket currently being viewed (e.g. "760"
  // via a Consolidations link) carries over into the target collection/topic.
  const currentCaseParam = new URLSearchParams(location.search).get('case') || caseId(_currentCaseEntry);
  const params = {
    [target.isTopic ? 'topic' : 'collection']: target.id,
    term,
    case: currentCaseParam,
  };
  if (target.groupId != null) params.id = target.groupId;
  else if (target.groupIdx != null) params.group = target.groupIdx;
  const href = buildUrlParams(
    params,
    ['highlight', 'file', 'citation', 'event', 'turn', 'find', 'group', 'id'],
  );
  navigate(href);
  restoreFromURL();
}

function _buildTagsMenu(anchorEl) {
  const existing = document.querySelector('.tags-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('ul');
  menu.className = 'term-sort-menu tags-menu';

  const addLi      = document.createElement('li');
  const addInput   = document.createElement('input');
  const addSaveBtn = document.createElement('button');
  addInput.type = 'text';
  addInput.className = 'tag-add-input';
  addInput.placeholder = 'New tag…';
  addSaveBtn.className = 'tag-add-save-btn';
  addSaveBtn.textContent = 'Add';

  function doAdd() {
    const val = addInput.value.trim();
    if (val) { _addUserTag(val); renderUserTags(); addInput.value = ''; }
    requestAnimationFrame(() => addInput.focus());
  }

  function renderUserTags() {
    menu.querySelectorAll('.tag-user').forEach(el => el.remove());
    for (const tag of _getUserTags()) {
      const item = document.createElement('li');
      item.className = 'term-sort-option tag-user';
      const span = document.createElement('span');
      span.className = 'tag-label';
      span.textContent = tag;
      const copy = document.createElement('button');
      copy.className = 'tag-copy-btn';
      copy.title = 'Copy tag to clipboard';
      copy.appendChild(makeClipboardIconSvg());
      copy.addEventListener('click', (e) => { e.stopPropagation(); _copyTagPlainText(tag); });
      const del = document.createElement('button');
      del.className = 'tag-delete-btn';
      del.title = 'Delete tag';
      del.appendChild(makeTrashIconSvg());
      del.addEventListener('click', (e) => { e.stopPropagation(); _removeUserTag(tag); renderUserTags(); });
      item.appendChild(span);
      item.appendChild(copy);
      item.appendChild(del);
      menu.insertBefore(item, addLi);
    }
  }

  const _builtinTags = _getBuiltinTags();
  for (const tag of _builtinTags) {
    const item = document.createElement('li');
    item.className = 'term-sort-option tag-builtin';
    const span = document.createElement('span');
    span.className = 'tag-label';
    span.textContent = tag;
    const copy = document.createElement('button');
    copy.className = 'tag-copy-btn';
    copy.title = 'Copy tag to clipboard';
    copy.appendChild(makeClipboardIconSvg());
    copy.addEventListener('click', (e) => { e.stopPropagation(); _copyTagPlainText(tag); });
    item.appendChild(span);
    item.appendChild(copy);
    menu.appendChild(item);
    // Upgrade to a clickable link once we know this tag maps to a
    // collection/topic (and, for fan-out sub-tags, which group within it).
    _resolveTagTarget(tag, _builtinTags).then(target => {
      if (!target || !menu.isConnected) return;
      item.classList.add('tag-linked');
      item.title = 'View in ' + (target.isTopic ? 'topic' : 'collection');
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.remove();
        _navigateToTagTarget(target);
      });
    });
  }

  addLi.className = 'term-sort-option tag-add-item';
  addLi.appendChild(addInput);
  addLi.appendChild(addSaveBtn);
  addLi.addEventListener('click', (e) => e.stopPropagation());
  addSaveBtn.addEventListener('click', (e) => { e.stopPropagation(); doAdd(); });
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.stopPropagation(); doAdd(); }
  });
  menu.appendChild(addLi);
  renderUserTags();

  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.top  = (rect.bottom + window.scrollY) + 'px';
  menu.style.left = Math.max(0, rect.right + window.scrollX - menu.offsetWidth) + 'px';
  requestAnimationFrame(() => addInput.focus());

  const close = (e) => {
    if (!menu.contains(e.target) && e.target !== anchorEl) {
      menu.remove();
      document.removeEventListener('mousedown', close, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}

// ── Edits nav (virtual collection) ───────────────────────────────────────────
let _editsLi         = null;
let _editsUl         = null;
let _editsItemsBuilt = false;

// ── Favorites collection nav ───────────────────────────────────────────────────
let _favoritesLi         = null;
let _favoritesUl         = null;
let _favoritesItemsBuilt = false;
let _activeFavGroupId    = 'unfiled';
let _favGroupEls         = new Map(); // groupId → { li, ul, countBtn, activeDot, sortMode, sortAsc }
let _favSearchRow        = null;
let _favSearchInput      = null;
let _favSearchBtn        = null;

const _FAV_SORT_OPTIONS = [
  { mode: 'cases',   label: 'Case'    },
  { mode: 'argued',  label: 'Argued'  },
  { mode: 'decided', label: 'Decided' },
];

function _favGroupCountLabel(groupId, n) {
  const g = _favGroupEls.get(groupId);
  if (g?.sortMode && g.sortMode !== 'none') return _sortModeLabel(g.sortMode, n, g.sortAsc ?? true);
  return n + ' ' + (n === 1 ? 'Case' : 'Cases');
}

function _applyFavGroupSort(groupId, mode, asc, { reversal = false } = {}) {
  const g = _favGroupEls.get(groupId);
  if (!g?.ul) return;
  g.sortMode = mode;
  g.sortAsc  = asc;
  const items = Array.from(g.ul.querySelectorAll('.case-item'));
  items.forEach(ci => {
    const lbl = ci.querySelector('.case-sort-label');
    if (!lbl) return;
    if (mode === 'argued' || mode === 'decided') {
      lbl.textContent = _fmtMonthDay(ci.dataset[mode] || '', true);
    } else {
      lbl.textContent = '';
    }
  });
  if (!reversal) {
    if (mode === 'argued' || mode === 'decided') {
      items.sort((a, b) => {
        const av = a.dataset[mode] || '', bv = b.dataset[mode] || '';
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
    } else if (mode === 'cases') {
      const keyMap = new Map(items.map(ci => [ci, ci.querySelector('.case-title-nav')?.textContent || '']));
      items.sort((a, b) => keyMap.get(a).localeCompare(keyMap.get(b)));
    }
  } else {
    items.reverse();
  }
  if (!asc) items.reverse();
  g.ul.replaceChildren(...items);
  if (g.countBtn) {
    g.countBtn.classList.toggle('sort-active', mode !== 'none');
    g.countBtn.textContent = _favGroupCountLabel(groupId, items.length);
  }
}

function _setActiveFavGroup(groupId) {
  _activeFavGroupId = groupId;
  for (const [gid, g] of _favGroupEls) {
    if (g.activeDot) g.activeDot.hidden = gid !== groupId;
  }
}

function _moveFavToGroup(key, targetGroupId) {
  const data = _getFavData();
  const item = data.items.find(f => _favKey(f) === key);
  if (!item || item.groupId === targetGroupId) return;
  item.groupId = targetGroupId;
  _setFavData(data);
  _refreshFavoritesNav();
}

function _startGroupRename(groupId, labelEl) {
  const data = _getFavData();
  const grp  = data.groups.find(g => g.id === groupId);
  if (!grp) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'fav-group-rename-input';
  input.value = grp.name;
  labelEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const newName = input.value.trim() || grp.name;
    grp.name = newName;
    _setFavData(data);
    input.replaceWith(labelEl);
    labelEl.textContent = newName;
  };
  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = grp.name; input.blur(); }
  });
}

function _buildFavGroupEl(groupId, groupName) {
  const g = { li: null, ul: null, countBtn: null, activeDot: null, sortMode: 'none', sortAsc: true };

  const li = document.createElement('li');
  li.className = 'term-group fav-group';
  li.dataset.favGroupId = groupId;

  const header = document.createElement('div');
  header.className = 'term-header';

  const tog = document.createElement('span');
  tog.className = 'term-toggle';
  tog.textContent = '▶︎';

  const label = document.createElement('span');
  label.className = 'term-label fav-group-label';
  label.textContent = groupName;
  label.title = 'Double-click to rename';
  label.addEventListener('dblclick', (e) => { e.stopPropagation(); _startGroupRename(groupId, label); });

  const activeDot = document.createElement('span');
  activeDot.className = 'fav-active-dot';
  activeDot.title = 'Active group — new favorites go here';
  activeDot.textContent = '●';
  activeDot.hidden = groupId !== _activeFavGroupId;

  const countBtn = document.createElement('button');
  countBtn.type = 'button';
  countBtn.className = 'term-case-count';
  countBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!li.classList.contains('open')) return;
    _buildSortMenu(
      countBtn,
      _FAV_SORT_OPTIONS,
      () => ({ mode: g.sortMode, asc: g.sortAsc }),
      ({ mode, asc }) => _applyFavGroupSort(groupId, mode, asc, { reversal: mode === g.sortMode }),
    );
  });

  header.appendChild(tog);
  header.appendChild(label);
  header.appendChild(activeDot);
  // The "Unfiled" group is permanent — never gets a delete button. Every
  // other group shows one only while open/selected, immediately left of the
  // count button; a MutationObserver keeps that in sync regardless of which
  // code path toggles the 'open' class (manual click, _addFavGroup, restore
  // after a rebuild, etc.) instead of having to hook every call site.
  if (groupId !== 'unfiled') {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'fav-group-delete-btn';
    delBtn.title = 'Delete group';
    delBtn.hidden = true;
    delBtn.appendChild(makeTrashIconSvg());
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _deleteFavGroup(groupId);
    });
    header.appendChild(delBtn);
    new MutationObserver(() => { delBtn.hidden = !li.classList.contains('open'); })
      .observe(li, { attributes: true, attributeFilter: ['class'] });
  }
  header.appendChild(countBtn);

  const ul = document.createElement('ul');
  ul.className = 'case-list';

  header.addEventListener('click', (e) => {
    if (countBtn.contains(e.target)) return;
    li.classList.toggle('open');
    if (li.classList.contains('open')) _setActiveFavGroup(groupId);
  });

  for (const dropTarget of [ul, header]) {
    dropTarget.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('text/fav-key')) { e.preventDefault(); dropTarget.classList.add('fav-drop-target'); }
    });
    dropTarget.addEventListener('dragleave', () => dropTarget.classList.remove('fav-drop-target'));
    dropTarget.addEventListener('drop', (e) => {
      dropTarget.classList.remove('fav-drop-target');
      const key = e.dataTransfer.getData('text/fav-key');
      if (!key) return;
      e.preventDefault();
      _moveFavToGroup(key, groupId);
    });
  }

  li.appendChild(header);
  li.appendChild(ul);

  g.li = li; g.ul = ul; g.countBtn = countBtn; g.activeDot = activeDot;
  _favGroupEls.set(groupId, g);
  return li;
}

function _uniqueGroupName(groups) {
  const names = new Set(groups.map(g => g.name));
  let n = 1;
  while (names.has('Group ' + n)) n++;
  return 'Group ' + n;
}

function _addFavGroup() {
  if (!_favoritesItemsBuilt) _favoritesLi?._ensureBuilt();
  const data = _getFavData();
  const id   = 'g_' + Date.now();
  data.groups.push({ id, name: _uniqueGroupName(data.groups) });
  _setFavData(data);
  if (_favoritesLi) { _favoritesLi.hidden = false; _favoritesLi.classList.add('open'); }
  _rebuildFavoritesItems();
  const g = _favGroupEls.get(id);
  if (g) {
    g.li.classList.add('open');
    _setActiveFavGroup(id);
    requestAnimationFrame(() => {
      const lbl = g.li.querySelector('.fav-group-label');
      if (lbl) _startGroupRename(id, lbl);
    });
  }
}

// Delete a favorites group instantly (no confirmation — low-stakes, and
// reversible by dragging cases back into a new group). Its cases move to
// Unfiled rather than being un-favorited. "Unfiled" itself is never
// deletable (see _buildFavGroupEl, which doesn't even render the button).
function _deleteFavGroup(groupId) {
  if (groupId === 'unfiled') return;
  const data = _getFavData();
  if (!data.groups.some(g => g.id === groupId)) return;
  data.groups = data.groups.filter(g => g.id !== groupId);
  for (const item of data.items) {
    if (item.groupId === groupId) item.groupId = 'unfiled';
  }
  _setFavData(data);
  if (_activeFavGroupId === groupId) _activeFavGroupId = 'unfiled';
  _rebuildFavoritesItems();
}

function _closeFavSearch() {
  if (!_favSearchRow) return;
  _favSearchRow.hidden = true;
  if (_favSearchBtn) _favSearchBtn.classList.remove('active');
  if (_favSearchInput) { _favSearchInput.value = ''; _applyFavSearch(); }
}

function _toggleFavSearch() {
  if (!_favSearchRow || !_favSearchInput) return;
  if (_favSearchRow.hidden) {
    _favSearchRow.hidden = false;
    if (_favSearchBtn) _favSearchBtn.classList.add('active');
    // Ensure Favorites is open and items are built so search has something to filter.
    if (_favoritesLi && !_favoritesLi.classList.contains('open')) _favoritesLi.classList.add('open');
    _favoritesLi?._ensureBuilt();
    _favSearchInput.focus();
  } else {
    _closeFavSearch();
  }
}

function _applyFavSearch() {
  const q = (_favSearchInput?.value || '').trim().toLowerCase();
  for (const [, g] of _favGroupEls) {
    if (!g.ul || !g.li) continue;
    let anyVisible = false;
    for (const ci of g.ul.querySelectorAll('.case-item')) {
      const title = (ci.querySelector('.case-title-nav')?.textContent || '').toLowerCase();
      const match = !q || title.includes(q);
      ci.hidden = !match;
      if (match) anyVisible = true;
    }
    g.li.hidden = !anyVisible;
  }
}

function _initFavoritesCollectionItem(sectionLi) {
  if (_favoritesLi) return;
  const sectionUl = sectionLi.querySelector('ul.terms-list-inner');
  if (!sectionUl) return;

  _favoritesLi = document.createElement('li');
  _favoritesLi.className = 'term-group';
  _favoritesLi.dataset.collectionUrl = '/courts/ussc/collections/favorites.json';
  _favoritesLi.dataset.collectionId = 'favorites';

  const header = document.createElement('div');
  header.className = 'term-header';

  const tog = document.createElement('span');
  tog.className = 'term-toggle';
  tog.textContent = '▶︎';

  const label = document.createElement('span');
  label.className = 'term-label';
  label.textContent = 'Favorites';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'fav-header-btn';
  addBtn.title = 'Add group';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', (e) => { e.stopPropagation(); _addFavGroup(); });

  _favSearchBtn = document.createElement('button');
  _favSearchBtn.type = 'button';
  _favSearchBtn.className = 'fav-header-btn';
  _favSearchBtn.title = 'Search favorites';
  _favSearchBtn.innerHTML = '&#128269;';
  _favSearchBtn.addEventListener('click', (e) => { e.stopPropagation(); _toggleFavSearch(); });

  header.appendChild(tog);
  header.appendChild(label);
  header.appendChild(addBtn);
  header.appendChild(_favSearchBtn);

  _favSearchRow = document.createElement('div');
  _favSearchRow.className = 'coll-search-row';
  _favSearchRow.hidden = true;
  _favSearchRow.addEventListener('click', e => e.stopPropagation());

  _favSearchInput = document.createElement('input');
  _favSearchInput.type = 'search';
  _favSearchInput.className = 'coll-search-input';
  _favSearchInput.placeholder = 'Search favorites…';
  _favSearchInput.autocomplete = 'off';
  _favSearchInput.spellcheck = false;
  _favSearchInput.addEventListener('input', _applyFavSearch);
  _favSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); _closeFavSearch(); } });

  const _favSearchClose = document.createElement('button');
  _favSearchClose.type = 'button';
  _favSearchClose.className = 'coll-search-clear';
  _favSearchClose.textContent = '×';
  _favSearchClose.title = 'Close search';
  _favSearchClose.setAttribute('aria-label', 'Close search');
  _favSearchClose.addEventListener('click', (e) => { e.stopPropagation(); _closeFavSearch(); });

  _favSearchRow.appendChild(_favSearchInput);
  _favSearchRow.appendChild(_favSearchClose);

  _favoritesUl = document.createElement('ul');
  _favoritesUl.className = 'fav-groups-list';

  _favoritesLi._ensureBuilt = () => {
    if (_favoritesItemsBuilt) return;
    _favoritesItemsBuilt = true;
    _rebuildFavoritesItems();
  };

  header.addEventListener('click', (e) => {
    if (addBtn.contains(e.target) || _favSearchBtn.contains(e.target)) return;
    _favoritesLi.classList.toggle('open');
    if (_favoritesLi.classList.contains('open')) _favoritesLi._ensureBuilt();
  });

  _favoritesLi.appendChild(header);
  _favoritesLi.appendChild(_favSearchRow);
  _favoritesLi.appendChild(_favoritesUl);
  sectionUl.appendChild(_favoritesLi);

  _refreshFavoritesNav();
}

function _rebuildFavoritesItems() {
  if (!_favoritesUl) return;
  // Snapshot sort states and open groups before clearing
  const prevSort = new Map();
  const prevOpen = new Set();
  for (const [gid, g] of _favGroupEls) {
    prevSort.set(gid, { mode: g.sortMode, asc: g.sortAsc });
    if (g.li?.classList.contains('open')) prevOpen.add(gid);
  }
  _favoritesUl.innerHTML = '';
  _favGroupEls.clear();
  const data = _getFavData();
  for (const grp of data.groups) {
    const groupEl = _buildFavGroupEl(grp.id, grp.name);
    _favoritesUl.appendChild(groupEl);
    const g = _favGroupEls.get(grp.id);
    const groupItems = data.items.filter(f => f.groupId === grp.id);
    for (const fav of groupItems) {
      const item = _buildCollectionCaseItem(fav.caseRef, 'favorites', 1, null, null);
      item._upgradeIcons?.();
      _makeFavItemDraggable(item, _favKey(fav));
      g?.ul?.appendChild(item);
    }
    if (g?.countBtn) g.countBtn.textContent = _favGroupCountLabel(grp.id, groupItems.length);
    if (prevOpen.has(grp.id) && g?.li) g.li.classList.add('open');
    const prev = prevSort.get(grp.id);
    if (prev && prev.mode !== 'none') _applyFavGroupSort(grp.id, prev.mode, prev.asc);
  }
  // Re-apply active group indicator after rebuild
  for (const [gid, g] of _favGroupEls) {
    if (g.activeDot) g.activeDot.hidden = gid !== _activeFavGroupId;
  }
  // Re-apply search filter if active
  if (_favSearchInput && !_favSearchRow?.hidden && _favSearchInput.value) _applyFavSearch();
}

function _makeFavItemDraggable(item, favKey) {
  item.draggable = true;
  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/fav-key', favKey);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('fav-dragging');
  });
  item.addEventListener('dragend', () => item.classList.remove('fav-dragging'));
}

function _refreshFavoritesNav() {
  if (!_favoritesLi) return;
  const data = _getFavData();
  const hasContent = data.items.length > 0 || data.groups.some(g => g.id !== 'unfiled');
  _favoritesLi.hidden = !hasContent;
  if (_favoritesItemsBuilt) _rebuildFavoritesItems();
}

function _initEditsNavItem(sectionLi) {
  if (_editsLi) return;
  const sectionUl = sectionLi.querySelector('ul.terms-list-inner');
  if (!sectionUl) return;

  _editsLi = document.createElement('li');
  _editsLi.className = 'term-group';
  _editsLi.dataset.collectionUrl = '/courts/ussc/collections/edits.json';
  _editsLi.dataset.collectionId = 'edits';

  const header = document.createElement('div');
  header.className = 'term-header';

  const tog = document.createElement('span');
  tog.className = 'term-toggle';
  tog.textContent = '▶︎';

  const label = document.createElement('span');
  label.className = 'term-label';
  label.textContent = 'Edits';

  header.appendChild(tog);
  header.appendChild(label);

  _editsUl = document.createElement('ul');
  _editsUl.className = 'edits-case-list';

  _editsLi._ensureBuilt = () => {
    if (_editsItemsBuilt) return;
    _editsItemsBuilt = true;
    _rebuildEditsItems();
  };

  header.addEventListener('click', () => {
    _editsLi.classList.toggle('open');
    if (_editsLi.classList.contains('open')) _editsLi._ensureBuilt();
  });

  _editsLi.appendChild(header);
  _editsLi.appendChild(_editsUl);
  sectionUl.appendChild(_editsLi);

  _refreshEditsNav();
}

function _refreshEditsNav() {
  if (!_editsLi) return;
  _editsLi.hidden = !_transcriptEdits.size;
  if (_editsItemsBuilt) _rebuildEditsItems();
}

function _rebuildEditsItems() {
  if (!_editsUl) return;
  _editsUl.innerHTML = '';

  // Group cases by term (ascending order).
  const byTerm = new Map();
  for (const [, caseData] of _transcriptEdits) {
    if (!byTerm.has(caseData.term)) byTerm.set(caseData.term, []);
    byTerm.get(caseData.term).push(caseData);
  }

  for (const term of [...byTerm.keys()].sort()) {
    const termLi = document.createElement('li');
    termLi.className = 'term-group open';

    const termHeader = document.createElement('div');
    termHeader.className = 'term-header';

    const termTog = document.createElement('span');
    termTog.className = 'term-toggle';
    termTog.textContent = '▶︎';

    const termLabel = document.createElement('span');
    termLabel.className = 'term-label';
    termLabel.textContent = termDisplayName(term);

    termHeader.appendChild(termTog);
    termHeader.appendChild(termLabel);
    termHeader.addEventListener('click', () => termLi.classList.toggle('open'));

    const caseUl = document.createElement('ul');
    caseUl.className = 'case-list';

    termLi.appendChild(termHeader);
    termLi.appendChild(caseUl);
    _editsUl.appendChild(termLi);

    for (const caseData of byTerm.get(term)) {
      const li = document.createElement('li');
      li.className = 'case-item';

      const header = document.createElement('div');
      header.className = 'case-header';

      const tog = document.createElement('span');
      tog.className = 'case-toggle';
      tog.style.display = 'none';

      const titleSpan = document.createElement('span');
      titleSpan.className = 'case-title-nav';
      titleSpan.style.cursor = 'pointer';
      titleSpan.textContent = caseTitle(caseData.title || '');

      header.appendChild(tog);
      header.appendChild(titleSpan);
      li.appendChild(header);
      caseUl.appendChild(li);

      // Find the event+turn of the earliest (smallest turnNum) edit across all events.
      let bestTurnNum  = Infinity;
      let bestTextHref = null;
      for (const [textHref, turnEdits] of caseData.eventEdits) {
        for (const [, edit] of turnEdits) {
          const tn = edit.turnNum ?? Infinity;
          if (tn < bestTurnNum) { bestTurnNum = tn; bestTextHref = textHref; }
        }
      }

      const caseParamId    = caseData.id || (caseData.number ? caseData.number.split(',')[0].trim() : '');
      let resolvedEventIdx = null;
      let resolvedTurnNum  = bestTurnNum < Infinity ? bestTurnNum : null;

      // data-case-key lets restoreFromURL find this item inside the Edits collection.
      li.dataset.caseKey = caseData.term + '/' + caseParamId;

      titleSpan.addEventListener('click', async (e) => {
        const fromRestore = !!e.fromRestore;
        if (!fromRestore) markCaseItemActive(li);

        const cases = await fetchTermCases(caseData.term);
        const entry = cases.find(c =>
          (caseData.id     && c.id     === caseData.id)     ||
          (caseData.number && c.number === caseData.number)
        );
        if (!entry) return;

        const audioIdx    = (fromRestore && Number.isInteger(e.audioIdx))
          ? e.audioIdx : (resolvedEventIdx || 0);
        const initialTurn = (fromRestore && Number.isInteger(e.initialTurn) && e.initialTurn > 0)
          ? e.initialTurn : resolvedTurnNum;

        if (!fromRestore) {
          const params    = { collection: 'edits', term: caseData.term, case: caseParamId };
          const deletions = ['group', 'id', 'highlight', 'file'];
          if (audioIdx)    { params.event = audioIdx;    } else { deletions.push('event'); }
          if (initialTurn) { params.turn  = initialTurn; } else { deletions.push('turn'); }
          navigate(buildUrlParams(params, deletions));
        }

        const hasPlayableAudio = (entry.events || []).some(a => a.audio_href);
        loadCase(caseData.term, entry, audioIdx || 0, { forceNoAudio: !hasPlayableAudio, initialTurn });
      });

      // Async: resolve textHref -> 1-based event index via the term's case data.
      if (bestTextHref) {
        fetchTermCases(caseData.term).then(cases => {
          const entry = cases.find(c =>
            (caseData.id     && c.id     === caseData.id)     ||
            (caseData.number && c.number === caseData.number)
          );
          if (!entry) return;
          const evIdx = (entry.events || []).findIndex(ev => ev.text_href === bestTextHref);
          resolvedEventIdx = evIdx >= 0 ? evIdx + 1 : 0;
        });
      }
    }
  }
}

const audio       = document.getElementById('audio-player');
const turnList    = document.getElementById('turn-list');
const emptyState  = document.getElementById('empty-state');
const loadingMsg  = document.getElementById('loading-msg');
const playerSection   = document.getElementById('player-section');
const audioControls   = document.getElementById('audio-controls');
const pageViewer      = document.getElementById('page-viewer');
const transcriptViewer = document.getElementById('transcript-viewer');
const playPauseBtn     = document.getElementById('play-pause-btn');
const audioSeekBar     = document.getElementById('audio-seek-bar');
const audioCurrentTime = document.getElementById('audio-current-time');

// ── Utilities ───────────────────────────────────────────────────────────────

// Update document.title plus the <meta name="description"> and <link rel="canonical">
// tags to match the view currently on screen. This SPA serves every case/term/
// collection view from one static HTML shell, and Jekyll can't see the query string
// at build time, so the server-rendered HTML deliberately omits a canonical tag
// (see _includes/head/explorer-seo.html) rather than emit one that's only ever
// correct for a single URL. This is what supplies the real one, per view, for
// crawlers that execute JS. Call this instead of assigning document.title directly
// wherever a view finishes rendering.
function setPageMeta(title, description) {
  document.title = title;
  let metaDesc = document.querySelector('meta[name="description"]');
  if (!metaDesc) {
    metaDesc = document.createElement('meta');
    metaDesc.setAttribute('name', 'description');
    document.head.appendChild(metaDesc);
  }
  metaDesc.setAttribute('content', description
    || title.replace(/ \| Argument Aloud$/, '') + ' — U.S. Supreme Court oral argument audio and transcripts, from Argument Aloud.');
  let canonical = document.querySelector('link[rel="canonical"]');
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.setAttribute('rel', 'canonical');
    document.head.appendChild(canonical);
  }
  canonical.setAttribute('href', location.origin + location.pathname + location.search);
}

// First sentence (up to the first ".\n") of a case's "questions presented" text,
// collapsed to one line — used both for the on-page summary and as a meta description.
function questionsSummary(raw) {
  const breakPos = raw.search(/\.\n/);
  const firstPart = breakPos !== -1 ? raw.slice(0, breakPos + 1) : raw;
  return firstPart.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

// A case's "questions presented" make a far more useful/unique meta description than
// the generic fallback in setPageMeta() — falls back to null (generic) when absent.
function caseMetaDescription(caseEntry) {
  if (!caseEntry?.questions) return null;
  const summary = questionsSummary(caseEntry.questions);
  return summary.length > 300 ? summary.slice(0, 297) + '…' : summary;
}

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

// ── Topbar back/forward enable/disable ───────────────────────────────────
// The whole app navigates via this file's single pushState call (above) plus
// many replaceState calls elsewhere that only ever adjust the *current* entry.
// Wrapping both lets us tag every entry with a running index (navIdx) without
// touching each replaceState call site individually, so we can tell whether
// there's really anywhere to go back/forward to.
(function () {
  const backBtn = document.getElementById('nav-back-btn');
  const forwardBtn = document.getElementById('nav-forward-btn');
  if (!backBtn || !forwardBtn) return;

  const MAX_KEY  = 'aa-nav-max-idx';
  const HAS_BACK_KEY = 'aa-nav-has-back-target';  // '1' | '0', decided once per fresh entry

  const _origPushState    = history.pushState.bind(history);
  const _origReplaceState = history.replaceState.bind(history);

  let navIdx = (history.state && Number.isInteger(history.state.navIdx)) ? history.state.navIdx : 0;

  let maxNavIdx = parseInt(sessionStorage.getItem(MAX_KEY) || '0', 10);
  if (!Number.isFinite(maxNavIdx) || maxNavIdx < navIdx) maxNavIdx = navIdx;

  // hasBackTarget: is there really anywhere one step behind navIdx 0? —
  // decided once, the first time this tab reaches this entry (not
  // re-derivable afterward, since a reload's document.referrer no longer
  // reflects it), then persisted. No referrer at all (direct URL entry,
  // bookmark, new tab) means there's nothing to go back to — history.length
  // isn't a reliable signal here (browsers can carry an extra internal entry,
  // e.g. an initial about:blank, that isn't a real "back" destination).
  let hasBackTarget = sessionStorage.getItem(HAS_BACK_KEY);
  if (hasBackTarget == null) {
    hasBackTarget = document.referrer ? '1' : '0';
    try { sessionStorage.setItem(HAS_BACK_KEY, hasBackTarget); } catch { /* ignore */ }
  }

  function updateNavButtons() {
    const canBack    = navIdx > 0 || hasBackTarget === '1';
    const canForward = navIdx < maxNavIdx;
    backBtn.disabled    = !canBack;
    forwardBtn.disabled = !canForward;
  }

  history.pushState = function (state, title, url) {
    navIdx += 1;
    if (navIdx > maxNavIdx) {
      maxNavIdx = navIdx;
      try { sessionStorage.setItem(MAX_KEY, String(maxNavIdx)); } catch { /* ignore */ }
    }
    _origPushState(Object.assign({}, state, { navIdx }), title, url);
    updateNavButtons();
  };

  history.replaceState = function (state, title, url) {
    _origReplaceState(Object.assign({}, state, { navIdx }), title, url);
    updateNavButtons();
  };

  window.addEventListener('popstate', (e) => {
    navIdx = (e.state && Number.isInteger(e.state.navIdx)) ? e.state.navIdx : 0;
    updateNavButtons();
  });

  // Tag the entry we loaded on (no navIdx yet) without adding a new one.
  if (!history.state || !Number.isInteger(history.state.navIdx)) {
    _origReplaceState(Object.assign({}, history.state, { navIdx }), '', location.href);
  }

  updateNavButtons();
})();

function parseTime(s) {
  const [h, m, sec] = s.split(':');
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(sec);
}

function formatTime(secs) {
  if (!isFinite(secs) || isNaN(secs) || secs < 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function termDisplayName(term) {
  const entry = TERMS.find(t => t.term === term);
  if (entry?.name) return entry.name.replace(/ /g, '\u00a0');
  const [year, month] = term.split('-');
  return (MONTHS[parseInt(month, 10) - 1] || month) + '\u00a0Term\u00a0' + year;
}

// Sets the topbar's term label \u2014 the full name (e.g. "October Term 1965") for
// desktop, plus a data-year attribute so mobile layout (see explorer.css) can
// swap to showing just the year via a ::after pseudo-element.
function setTopbarTerm(term) {
  const el = document.getElementById('topbar-term');
  if (!term) {
    el.textContent = '';
    delete el.dataset.year;
    return;
  }
  el.textContent = termDisplayName(term);
  el.dataset.year = term.split('-')[0];
}

function decisionTooltip(term, caseEntry, decision) {
  const parts = [];
  if (caseEntry.number) {
    const numbers = caseEntry.number.split(',').map(n => _normNum(n.trim()));
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
    const numbers = caseRef.number.split(',').map(n => _normNum(n.trim()));
    const label = numbers.length > 1 ? 'Nos.' : 'No.';
    parts.push('(' + label + '\u00a0' + numbers.join(', ') + ')');
  }
  if (caseRef.argument)   parts.push('Argued\u00a0'   + formatArgDates(caseRef.argument));
  if (caseRef.reargument) parts.push('Reargued\u00a0' + formatArgDates(caseRef.reargument));
  return parts.join(';\u00a0');
}

function toTitleCase(s) {
  return s.toLowerCase().replace(/(^|')(\S)/g, (_, pre, ch) => pre + ch.toUpperCase());
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
// Roman-numeral generational suffixes (", II", ", III", ", IV") are fully
// uppercased rather than title-cased — same convention as _justiceDisplayName
// in scripts/update_cases.js.
function formatSpeakerFull(speaker) {
  const name = typeof speaker === 'string' ? speaker : speaker.name;
  return name.split(' ').map(toTitleCase).join(' ')
    .replace(/,\s+([IVXivx]+)$/, (_, s) => ', ' + s.toUpperCase());
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
// Pass date (YYYY-MM-DD) to show the cases-for-a-day view above the stats.
function updateEmptyStateForTerm(term, date = null) {
  if (!term) return; // term collapsed — leave current view
  const statsUrl = '/courts/ussc/terms/?term=' + encodeURIComponent(term)
    + (date ? '&date=' + encodeURIComponent(date) : '');
  showPageViewer(statsUrl, { pushState: false });
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
// Old collection ids, mapped forward to their current value, so
// bookmarked/shared links built before a rename keep resolving.
// _resolveCollectionAlias() below chains through these, so an entry only
// needs to name its immediate successor. collections.json's explicit "id"
// values are kept equal to each collection's file basename (matching what's
// already published), so this table only needs actual renames, not the
// general file-basename-vs-id case.
const _COLLECTION_ALIASES = {
  loners: 'lone_dissents',
  top_advocates: 'top100_advocates',
  issues: 'audits',
};

// Repeatedly follows _COLLECTION_ALIASES until reaching a value with no
// further alias (or a cap is hit, as a guard against a misconfigured cycle).
function _resolveCollectionAlias(collId) {
  let id = collId, hops = 0;
  while (id && _COLLECTION_ALIASES[id] && hops++ < 10) id = _COLLECTION_ALIASES[id];
  return id;
}
const _termFetchPromises = new Map(); // term → inflight Promise or resolved cases[]
const _titleIndexCache   = new Map(); // first-char → inflight Promise or resolved index object
const _keywordIndexCache = new Map(); // first-char → inflight Promise or resolved index object

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

async function _fetchTitleIndex(prefix) {
  if (_titleIndexCache.has(prefix)) return _titleIndexCache.get(prefix);
  const p = fetch(window.INDEXES_BASE_URL + '/courts/ussc/indexes/cases/titles/' + prefix + '.json', { cache: 'reload' })
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}));
  _titleIndexCache.set(prefix, p);
  const data = await p;
  _titleIndexCache.set(prefix, data);
  return data;
}

async function _fetchKeywordIndex(prefix) {
  if (_keywordIndexCache.has(prefix)) return _keywordIndexCache.get(prefix);
  const p = fetch(window.INDEXES_BASE_URL + '/courts/ussc/indexes/cases/keywords/' + prefix + '.json', { cache: 'reload' })
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}));
  _keywordIndexCache.set(prefix, p);
  const data = await p;
  _keywordIndexCache.set(prefix, data);
  return data;
}

// Resolve the word-map that actually holds `token`'s entries.
// A 2-letter prefix file over ~1MB is split by scripts/update_cases.js
// (processKeywordIndex) into 3-letter sub-files; the 2-letter file then holds
// a flat array of the 3-letter sub-prefixes that exist (e.g. "co.json" → ["coa",
// "cob", ...]) instead of a word map. Every indexed word is ≥ 3 chars, so the
// token's first 3 characters always name the right sub-file when one exists.
async function _fetchKeywordIndexForToken(token) {
  const index = await _fetchKeywordIndex(token.slice(0, 2));
  if (!Array.isArray(index)) return index || {};
  const subPrefix = token.slice(0, 3);
  if (!index.includes(subPrefix)) return {};
  return await _fetchKeywordIndex(subPrefix);
}

let _numberIndex = null;
let _numberIndexPromise = null;

async function _fetchNumberIndex() {
  if (_numberIndex) return _numberIndex;
  if (_numberIndexPromise) return _numberIndexPromise;
  _numberIndexPromise = fetch(window.INDEXES_BASE_URL + '/courts/ussc/indexes/cases/numbers.json', { cache: 'reload' })
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}))
    .then(d => { _numberIndex = d; return d; });
  return _numberIndexPromise;
}

let _citationIndex = null;
let _citationIndexPromise = null;

async function _fetchCitationIndex() {
  if (_citationIndex) return _citationIndex;
  if (_citationIndexPromise) return _citationIndexPromise;
  _citationIndexPromise = fetch(window.INDEXES_BASE_URL + '/courts/ussc/indexes/cases/citations.json', { cache: 'reload' })
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}))
    .then(d => { _citationIndex = d; return d; });
  return _citationIndexPromise;
}

// Lowercase, strip periods, collapse whitespace — matches _normalizeUsCite in
// scripts/update_cases.js so "387 U.S. 397" and "387 US 397" both resolve to
// the same citations.json key ("387 us 397").
function _normalizeUsCite(s) {
  return String(s || '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

let _justiceNidData = null;
let _justiceNidPromise = null;

async function _fetchJusticeNids() {
  if (_justiceNidData) return _justiceNidData;
  if (_justiceNidPromise) return _justiceNidPromise;
  _justiceNidPromise = fetch('/data/ussc/justices.json')
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}))
    .then(raw => {
      const byLastName = new Map();
      const byFullName = new Map();
      for (const [name, j] of Object.entries(raw)) {
        if (!j.nid) continue;
        byFullName.set(name.toLowerCase(), j.nid);
        const parts = name.trim().split(/\s+/);
        byLastName.set(parts[parts.length - 1].toLowerCase(), j.nid);
        for (const alt of (j.alternates || [])) {
          byFullName.set(alt.toLowerCase(), j.nid);
          const altParts = alt.trim().split(/\s+/);
          byLastName.set(altParts[altParts.length - 1].toLowerCase(), j.nid);
        }
      }
      _justiceNidData = { byLastName, byFullName };
      return _justiceNidData;
    });
  return _justiceNidPromise;
}

// Called when nav search opens: loads all not-yet-built term case lists.
// ── URL param helper ─────────────────────────────────────────────────────────
// Rebuilds URLSearchParams so that 'collection'/'topic' is always first, and 'group' or 'id' is second.
function buildUrlParams(updates, deletes = []) {
  const url = new URL(location.href);
  url.hash = '';
  // Apply deletes first.
  deletes.forEach(k => url.searchParams.delete(k));
  // 'collection' and 'topic' are mutually exclusive nav params — deleting one removes the other.
  if (deletes.includes('collection')) url.searchParams.delete('topic');
  if (deletes.includes('topic'))      url.searchParams.delete('collection');
  // Always remove 'link' and 'find' when navigating — they are only meaningful
  // on keyword-search result URLs and are re-added explicitly by callers.
  url.searchParams.delete('link');
  url.searchParams.delete('find');
  // Remove any section-level "=all" nav params (e.g. source=all) that are not
  // being explicitly set in this call.  term/collection/topic have their own
  // handling above; all other registered section IDs are mutually exclusive with
  // term/case/collection navigation and must not bleed through.
  for (const sectionId of _sectionLiById.keys()) {
    if (sectionId === 'term' || sectionId === 'collection' || sectionId === 'topic') continue;
    if (!(sectionId in updates)) url.searchParams.delete(sectionId);
  }
  // Apply updates.
  Object.entries(updates).forEach(([k, v]) => url.searchParams.set(k, v));
  // Setting one of the mutually exclusive nav params removes the other.
  if ('collection' in updates) url.searchParams.delete('topic');
  if ('topic'      in updates) url.searchParams.delete('collection');
  // Enforce canonical parameter order: collection/topic, source, group/id, highlight, term, case, event, turn, file, then rest.
  const collection = url.searchParams.get('collection');
  const topic      = url.searchParams.get('topic');
  const source     = url.searchParams.get('source');
  const group      = url.searchParams.get('group');
  const id         = url.searchParams.get('id');
  const highlight  = url.searchParams.get('highlight');
  const term       = url.searchParams.get('term');
  const datePrm    = url.searchParams.get('date');
  const caseParam  = url.searchParams.get('case');
  const event      = url.searchParams.get('event');
  const turn       = url.searchParams.get('turn');
  const file       = url.searchParams.get('file');
  const citation   = url.searchParams.get('citation');
  const sortPrm    = url.searchParams.get('sort');
  const orderPrm   = url.searchParams.get('o');
  const orderedKeys = ['collection', 'topic', 'source', 'group', 'id', 'highlight', 'term', 'date', 'case', 'event', 'turn', 'file', 'citation', 'sort', 'o'];
  const rest = [...url.searchParams.entries()].filter(([k]) => !orderedKeys.includes(k));
  const reordered = [];
  if (collection != null) reordered.push(['collection', collection]);
  if (topic      != null) reordered.push(['topic',      topic]);
  if (source     != null) reordered.push(['source',     source]);
  if (group != null) reordered.push(['group', group]);
  if (id != null) reordered.push(['id', id]);
  if (highlight != null) reordered.push(['highlight', highlight]);
  if (term != null) reordered.push(['term', term]);
  if (datePrm != null) reordered.push(['date', datePrm]);
  if (caseParam != null) reordered.push(['case', caseParam]);
  if (event != null) reordered.push(['event', event]);
  if (turn != null) reordered.push(['turn', turn]);
  if (file != null) reordered.push(['file', file]);
  if (citation != null) reordered.push(['citation', citation]);
  if (sortPrm  != null) reordered.push(['sort', sortPrm]);
  if (orderPrm != null) reordered.push(['o',    orderPrm]);
  reordered.push(...rest);
  url.search = new URLSearchParams(reordered).toString();
  return url;
}

// Navigate to <id>=all for a top-level nav section (e.g. collection=all,
// topic=all, source=all) — the "expand and show everything" pseudo-value
// documented for these sections, mirroring what buildNav() does for Terms.
function _navigateToSectionAll(id) {
  if (!id) return;
  navigate(buildUrlParams(
    { [id]: 'all' },
    ['term', 'date', 'case', 'event', 'turn', 'file', 'collection', 'topic', 'source', 'group', 'id', 'highlight', 'link', 'sort', 'o'],
  ));
}


// Parse the ?sort= and ?o= URL params into { mode, asc }.
// sort = mode name; o = 'a' (ascending) | 'd' (descending, default when omitted is ascending).
function _parseSortParam(sortStr, orderStr) {
  if (!sortStr) return null;
  if (!['cases', 'argued', 'decided', 'votes', 'hours', 'none'].includes(sortStr)) return null;
  return { mode: sortStr, asc: orderStr !== 'd' };
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
// currentRange, if non-null, marks the specific occurrence as the active match.
// currentRange, if provided, is {start, end} — character offsets in rawText.
// Any search mark that falls entirely within [start, end) gets the 'current' class.
function renderTurnText(textEl, rawText, searchQuery, currentRange) {
  const marks = [];

  // Ref mark positions (whole-word only)
  links.forEach(link => {
    getRefTexts(link).forEach(refText => {
      findWholeWordMatches(rawText, refText).forEach(({ start, end }) => {
        marks.push({ start, end, kind: 'ref', link, refText });
      });
    });
  });

  // Search mark positions (win over refs at same start position).
  // Each whitespace-delimited token is highlighted independently so that
  // multi-word queries (e.g. "qualified immunity") mark both words wherever
  // they appear, rather than requiring them to be adjacent.
  if (searchQuery) {
    const hayLower = rawText.toLowerCase();
    for (const tok of searchQuery.trim().toLowerCase().split(/\s+/).filter(t => t)) {
      let i = 0;
      while (i < hayLower.length) {
        const pos = hayLower.indexOf(tok, i);
        if (pos === -1) break;
        marks.push({ start: pos, end: pos + tok.length, kind: 'search' });
        i = pos + tok.length;
      }
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
        _revealReferenceFileItem(link);
        if (link.file != null) {
          const url = new URL(location.href);
          url.searchParams.set('file', String(link.file));
          url.searchParams.delete('citation');
          history.replaceState(null, '', url);
        }
      });
      frag.appendChild(span);
    } else {
      const mark = document.createElement('mark');
      const isCurrent = currentRange != null && start >= currentRange.start && end <= currentRange.end;
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

// When a transcript reference (a [ref] mark, or an auto-shown match) points
// at one of the active case's own files.json "reference" entries, expand its
// References group in the sidebar and mark it active — same visual state as
// clicking it there directly. The case's file list is already built by this
// point (titleSpan's click handler awaits ensureFilesLoaded() before the
// transcript ever loads), so this is just a lookup, not a rebuild.
function _revealReferenceFileItem(link) {
  if (link.file == null) return;
  const fileEl = findFileItem(link.file);
  if (!fileEl) return;
  fileEl.closest('.file-type-group')?.classList.add('open');
  document.querySelectorAll('.file-item, .file-type-header').forEach(el => el.classList.remove('active'));
  fileEl.classList.add('active');
  requestAnimationFrame(() => fileEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
}

function checkLinksForActiveTurn(idx, autoScroll = false) {
  if (!links.length || idx < 0 || idx >= turns.length) return false;
  const turnText = turns[idx].text;
  const match = links.find(l => getRefTexts(l).some(r => matchesWholeWord(turnText, r)));
  if (match && match.href !== activeBottomLinkText && !_docViewerAutoOpenSuppressed) {
    const matchedRef = getRefTexts(match).find(r => matchesWholeWord(turnText, r)) || null;
    const page = matchedRef ? getRefPage(match, matchedRef) : null;
    showDocViewer(match, { autoScroll, matchedRef, page });
    _revealReferenceFileItem(match);
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
  const videoEl = document.getElementById('doc-viewer-video');
  const audioEl = document.getElementById('doc-viewer-audio');
  if (videoEl) { videoEl.pause(); videoEl.style.display = 'none'; }
  if (audioEl) { audioEl.pause(); audioEl.style.display = 'none'; }
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
  const isPdf  = /\.pdf(#|\?|$)/i.test(link.href);
  const isMp4  = /\.mp4(#|\?|$)/i.test(link.href);
  const isMp3  = /\.mp3(#|\?|$)/i.test(link.href);
  const inPane = isPdf || isMp4 || isMp3 || link.view === 'pane';

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

  const videoEl = document.getElementById('doc-viewer-video');
  const audioEl = document.getElementById('doc-viewer-audio');
  // Back/forward only make sense for the pooled iframe (PDF or pane HTML) —
  // not the <video>/<audio> elements or the "open externally" card.
  const showNavButtons = inPane && !isMp4 && !isMp3;
  document.getElementById('doc-viewer-back').hidden = !showNavButtons;
  document.getElementById('doc-viewer-forward').hidden = !showNavButtons;
  // Set below when displaying a PDF — the actual visible iframe comes from
  // _pdfIframePool (dynamically created, inserted after the static, always-
  // hidden #doc-viewer-pdf placeholder), not that placeholder element itself.
  let activePdfIframe = null;
  if (inPane) {
    card.style.display = 'none';
    if (isMp4) {
      for (const el of _pdfIframePool.values()) el.style.display = 'none';
      audioEl.style.display = 'none';
      if (videoEl.src !== effectiveHref) { videoEl.src = effectiveHref; videoEl.load(); }
      videoEl.style.display = 'block';
    } else if (isMp3) {
      for (const el of _pdfIframePool.values()) el.style.display = 'none';
      videoEl.style.display = 'none';
      if (audioEl.src !== effectiveHref) { audioEl.src = effectiveHref; audioEl.load(); }
      audioEl.style.display = 'block';
    } else {
      videoEl.style.display = 'none';
      audioEl.style.display = 'none';
      const src = effectiveHref.includes('#') ? effectiveHref : effectiveHref + '#pagemode=none';
      const isNew = !_pdfIframePool.has(src);
      const iframe = _getOrCreatePdfIframe(src);
      // Show only this iframe; others stay hidden but alive — no reload needed on return.
      for (const [s, el] of _pdfIframePool) el.style.display = s === src ? 'block' : 'none';
      // Non-PDF "pane" documents (e.g. an external HTML transcript) can be
      // navigated away from by the visitor clicking a link inside them —
      // since that content is cross-origin, we have no way to detect or
      // reset that short of reassigning src, so always reload these fresh
      // rather than reusing a pooled iframe that may show a different page
      // by now. True PDFs keep the "no reload needed on return" behavior,
      // since reloading them would lose the reader's scroll position for
      // no benefit (a PDF viewer doesn't navigate away like this).
      if (isNew || !isPdf) iframe.src = src;
      activePdfIframe = iframe;
    }
  } else {
    for (const el of _pdfIframePool.values()) el.style.display = 'none';
    videoEl.style.display = 'none';
    audioEl.style.display = 'none';
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
    const bottomBarEl = document.getElementById('bottom-bar');
    if (isMobile()) {
      // On mobile the doc-viewer lives in #bottom-bar which is normally
      // sticky at the *bottom* of the viewport. Animate from 0 to the
      // natural content height so it slides up above the audio controls
      // without requiring the user to scroll.
      //
      // For an opinion-only case (docViewerOpenHeight set — see
      // loadCaseAsOpinion) that isn't the right anchor: a bottom anchor
      // can't simultaneously (a) sit flush against #player-section with no
      // gap, and (b) give #main-panel enough total height to scroll
      // #doc-browser fully out of view — those two needs pull #bottom-bar's
      // height in opposite directions when it's measured from the viewport
      // bottom. So in this mode #bottom-bar switches to a *top* anchor
      // instead, pinned right at #player-section's own bottom edge:
      //   - the PDF itself is sized to exactly the space actually visible
      //     below #player-section (topbarH + playerH to viewport bottom);
      //   - the outer panel is made taller than that (by topbarH) so
      //     #main-panel has enough scrollable height overall — that extra
      //     slice trails off past the bottom of the screen, unreachable
      //     (there's nothing to scroll into it once #doc-browser is fully
      //     cleared), so nothing visible is clipped.
      if (docViewerOpenHeight) {
        const topbarH  = 44; // matches #player-section's sticky top offset
        const playerH  = document.getElementById('player-section').getBoundingClientRect().height;
        const visibleH = Math.max(0, Math.round(window.innerHeight - topbarH - playerH));
        const outerH   = Math.max(0, Math.round(window.innerHeight - playerH));
        // A sticky element can never be pushed past its own containing
        // block's bounds. #main-panel's natural height is just playerH +
        // outerH (topbarH short of what #bottom-bar needs to have room to
        // slide down to top: topbarH+playerH) — #transcript-viewer sits
        // between them and normally collapses to ~0 here (no turns to
        // show), so give it that missing sliver back.
        document.getElementById('transcript-viewer').style.minHeight = topbarH + 'px';
        bottomBarEl.style.top = (topbarH + playerH) + 'px';
        bottomBarEl.style.bottom = 'auto';
        if (activePdfIframe) activePdfIframe.style.height = visibleH + 'px';
        // Skip the slide-up animation for the full-page opinion view.
        // loadCaseAsOpinion scrollIntoView()s #player-section synchronously
        // right after this call returns — with the normal 0.3s transition
        // still in flight at that instant, the page would momentarily be
        // too short (mid-grow) and the scroll would fall short of fully
        // hiding the doc-browser nav. Jumping straight to the final height
        // keeps layout accurate the moment this function returns.
        panel.style.transition = 'none';
        panel.style.height = outerH + 'px';
        panel.offsetHeight; // commit before re-enabling transitions
        panel.style.transition = '';
      } else {
        // Normal in-context peek: reset any leftover opinion-mode override
        // from a previous case.
        document.getElementById('transcript-viewer').style.minHeight = '';
        bottomBarEl.style.top = '';
        bottomBarEl.style.bottom = '';
        if (activePdfIframe) activePdfIframe.style.height = '';
        // Use scrollHeight (measures full content even while height:0) so
        // card content and PDF iframes both size themselves correctly.
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
      }
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

// Returns a display title for use in the Edits/Favorites nav.
// When the event title contains "No. N", finds the matching '|'-split case title
// at the same index as N in the ','-split number field, then formats as
// "Sub-case Title (No. N)". Falls back to the first title with "(No. N)" if N
// isn't in the number field. Returns just the first title when no "No. N" present.
// Strip the hyphen from Orig/Misc case numbers for display (e.g. "14-Orig" → "14 Orig").
const _normNum = n => n.replace(/-(?=Orig|Misc)/i, ' ');

function _caseDisplayTitle(caseEntry, eventEntry) {
  const m = /\bNo\.\s*([\d][\d-]*)/i.exec(eventEntry?.title || '');
  if (!m) {
    const base = caseTitle(caseEntry.title);
    const num  = _normNum((caseEntry.number || '').split(',')[0].trim());
    return num ? `${base} (No. ${num})` : base;
  }
  const num     = _normNum(m[1]);
  const titles  = (caseEntry.title  || '').split('|');
  const numbers = (caseEntry.number || '').split(',').map(n => n.trim());
  const idx     = numbers.indexOf(m[1]);
  const base    = (idx !== -1 && idx < titles.length) ? titles[idx] : titles[0];
  return `${base} (No. ${num})`;
}

// For a consolidated case (multiple titles separated by '|' and numbers by ','),
// return the { title, number } sub-case whose docket number appears as "No. X" in
// optionText. Defaults to the first sub-case when no match. Returns null for
// non-consolidated cases (title/number counts differ or only one part each).
function _subCaseForOption(caseEntry, optionText) {
  const titles  = (caseEntry.title  || '').split('|');
  const numbers = (caseEntry.number || '').split(',').map(n => n.trim());
  if (titles.length < 2 || numbers.length !== titles.length) return null;
  if (optionText) {
    const m = /\bNo\.\s*(\d+)\b/.exec(optionText);
    if (m) {
      const idx = numbers.indexOf(m[1]);
      if (idx !== -1) return { title: titles[idx], number: numbers[idx] };
    }
  }
  return { title: titles[0], number: numbers[0] };
}

// For a consolidated case, return the { title, number } sub-case whose docket
// number exactly matches `number` (e.g. the specific docket a URL's 'case'
// param named). Returns null for non-consolidated cases or an unmatched number.
function _subCaseForNumber(caseEntry, number) {
  if (!number) return null;
  const titles  = (caseEntry.title  || '').split('|');
  const numbers = (caseEntry.number || '').split(',').map(n => n.trim());
  if (titles.length < 2 || numbers.length !== titles.length) return null;
  const idx = numbers.indexOf(number);
  return idx === -1 ? null : { title: titles[idx], number: numbers[idx] };
}

// Among a case's events, find the best default event whose title names docket
// `number` (e.g. "No. 11-393") — preferring an aligned entry, breaking ties by
// source (oyez > ussc > others), same preference order as loadCase's bestSource
// selection. Returns a 0-based index into `events`, or -1 if none match.
function _bestEventIndexForNumber(events, number) {
  if (!events || !number) return -1;
  const escaped = number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numRe = new RegExp('\\bNo\\.\\s*' + escaped + '\\b');
  const SOURCE_PREF = ['oyez', 'ussc', 'nara'];
  let bestIdx = -1, bestAligned = -1, bestPref = Infinity;
  events.forEach((ev, idx) => {
    if (!numRe.test(ev.title || '')) return;
    const aligned = ev.aligned ? 1 : 0;
    const pref = SOURCE_PREF.indexOf(ev.source);
    const prefScore = pref === -1 ? SOURCE_PREF.length : pref;
    if (aligned > bestAligned || (aligned === bestAligned && prefScore < bestPref)) {
      bestAligned = aligned;
      bestPref = prefScore;
      bestIdx = idx;
    }
  });
  return bestIdx;
}

// Build the text for the case‑title label above the transcript pane.
// subCase (optional): { title, number } from _subCaseForOption for consolidated cases.
// Parenthesised annotation is the docket number(s), if any — usCite is shown
// separately via #case-cite, so it's never repeated here.
function caseTitleLabel(caseEntry, subCase) {
  const title  = subCase ? subCase.title  : caseTitle(caseEntry.title);
  const number = subCase ? subCase.number : caseEntry.number;
  let suffix = '';
  if (number) {
    const isMulti = /,/.test(number);
    const displayNumber = number.replace(/,\s*/g, ', ').replace(/-(?=Orig|Misc)/g, '\u00a0');
    suffix = '\u00a0(' + (isMulti ? 'Nos.' : 'No.') + '\u00a0' + displayNumber + ')';
  }
  return title + suffix;
}

// Set the case-title-label element to a link that reveals the case in the nav pane.
// optionText: text of the currently selected file dropdown option — used to resolve
// the matching sub-case title for consolidated cases.
// numberOverride: a specific docket number (e.g. from a URL 'case' param) that takes
// priority over optionText — lets a link to one docket in a consolidated case show
// that docket's own title even before/without a matching audio entry being selected.
function setCaseTitleLabel(term, caseEntry, optionText, numberOverride) {
  const subCase = _subCaseForNumber(caseEntry, numberOverride) || _subCaseForOption(caseEntry, optionText);
  const span = document.getElementById('case-title-label');
  span.innerHTML = '';
  const urlParams = new URLSearchParams({ term, case: caseId(caseEntry) });
  const a = document.createElement('a');
  a.href = '?' + urlParams.toString();
  a.className = 'case-title-link';
  a.textContent = caseTitleLabel(caseEntry, subCase);

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

// Format an ISO date "YYYY-MM-DD", "YYYY-MM", or "YYYY" → readable string.
// Partial dates: "YYYY-MM" → "Mon YYYY", "YYYY" → "YYYY", missing → "".
function formatDecisionDate(iso) {
  if (!iso) return '';
  const parts = iso.split('-');
  const y = parts[0], m = parts[1], d = parts[2];
  if (!y) return '';
  if (!m) return y;
  const monthName = MONTHS[parseInt(m, 10) - 1] || m;
  if (!d) return monthName + '\u00a0' + y;
  return monthName + '\u00a0' + parseInt(d, 10) + ',\u00a0' + y;
}

function hasDecisionHref(c) {
  return !!(c && (c.decision_loc || c.decision_ussc || c.decision_reports));
}

// Convert a roman numeral string (e.g. "cxxv") to an integer, or NaN if the
// string contains non-roman characters. Front-matter/appendix pages in some
// early US Reports volumes are numbered with lowercase roman numerals.
function _parseRomanNumeral(s) {
  const vals = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0, prev = 0;
  for (const ch of s.toLowerCase().split('').reverse()) {
    const v = vals[ch];
    if (!v) return NaN;
    if (v < prev) total -= v; else total += v;
    prev = v;
  }
  return total > 0 ? total : NaN;
}

// Parse a pages breakpoint string ("1:19,33:34,vi:490") into [{start, pdfPage, roman?, startStr?}]
// breakpoints. Roman-numeral starts (e.g. "vi:490") are tagged with roman:true and startStr.
function _parsePnBps(pn) {
  if (!pn) return [];
  return pn.split(',').map(seg => {
    const colon = seg.indexOf(':');
    if (colon < 0) return null;
    const startStr = seg.slice(0, colon).trim();
    const pdfPage  = parseInt(seg.slice(colon + 1).trim(), 10);
    if (!isFinite(pdfPage)) return null;
    const start = parseInt(startStr, 10);
    if (isFinite(start)) return { start, pdfPage };
    const romanVal = _parseRomanNumeral(startStr);
    return isFinite(romanVal) ? { start: romanVal, pdfPage, roman: true, startStr } : null;
  }).filter(Boolean).sort((a, b) => {
    if (!!a.roman !== !!b.roman) return a.roman ? 1 : -1;
    return a.start - b.start;
  });
}

// Compute the PDF page for a given US Reports logical page using the term's
// reports[] pages mapping.  Returns null if no mapping is available.
function _reportPdfPage(usCite, termEntry) {
  const m = usCite && /^(\d+)\s+U\.S\.\s+(\d+|[ivxlcdmIVXLCDM]+)$/.exec(usCite.trim());
  if (!m) return null;
  const vol   = parseInt(m[1], 10);
  const roman = !/^\d+$/.test(m[2]);
  const page  = roman ? _parseRomanNumeral(m[2]) : parseInt(m[2], 10);
  if (!isFinite(page)) return null;
  const report = (termEntry?.reports || []).find(r => Number(r.volume) === vol);
  if (!report?.pages) return null;
  const bps = _parsePnBps(report.pages).filter(bp => !!bp.roman === roman);
  let match = null;
  for (const bp of bps) { if (bp.start <= page) match = bp; }
  if (!match) return null;
  return page + (match.pdfPage - match.start);
}

// Returns [{value, href, title}] in display order: LOC, USSC, US Reports.
// Used by the case-page document dropdown, which lists every available
// decision source with its own (LOC)/(USSC)/(usCite) suffix.
function _buildDecisionEntries(caseEntry) {
  if (!caseEntry) return [];
  const dateStr  = caseEntry.decision || '';
  const dateLabel = dateStr ? 'Decision\u00a0on\u00a0' + formatDecisionDate(dateStr) : 'Decision';
  const entries = [];
  if (caseEntry.decision_loc)
    entries.push({ value: 'decision_loc',     href: caseEntry.decision_loc,
                   title: dateLabel + '\u00a0(LOC)' });
  if (caseEntry.decision_ussc)
    entries.push({ value: 'decision_ussc',    href: caseEntry.decision_ussc,
                   title: dateLabel + '\u00a0(USSC)' });
  if (caseEntry.decision_reports) {
    let href = caseEntry.decision_reports;
    if (!href.includes('#page=')) {
      const termEntry = TERMS.find(t => t.term === _currentTerm);
      const pdfPage = _reportPdfPage(caseEntry.usCite, termEntry);
      if (pdfPage != null) href = href + '#page=' + pdfPage;
    }
    entries.push({ value: 'decision_reports', href,
                   title: dateLabel + (caseEntry.usCite ? '\u00a0(' + caseEntry.usCite + ')' : '') });
  }
  return entries;
}

// Returns the single best decision entry {value, href, title} for contexts
// that show just one decision link (case file list, scales-icon quick-open):
// prefer decision_loc, then decision_ussc, then decision_reports — same
// priority order as _buildDecisionEntries, whose href/page-anchor computation
// this reuses. Unlike the dropdown, the title always uses the usCite rather
// than a (LOC)/(USSC) source suffix.
function _buildPrimaryDecisionEntry(caseEntry) {
  const first = _buildDecisionEntries(caseEntry)[0];
  if (!first) return null;
  const dateStr   = caseEntry.decision || '';
  const dateLabel = dateStr ? 'Decision\u00a0on\u00a0' + formatDecisionDate(dateStr) : 'Decision';
  const title = dateLabel + (caseEntry.usCite ? '\u00a0(' + caseEntry.usCite + ')' : '');
  return { value: first.value, href: first.href, title };
}

// Returns [{value, href, title, view?}] for every opinion-text source this
// case has \u2014 LOC, USSC, Volume (decision_reports), and XML (decision_xml), in
// that order, each included only when the corresponding prop exists \u2014 titled
// "Decision on <full date> (XXX)". This is the shared source list behind both
// the top-right document dropdown (_currentDecisionEntries) and the
// #case-cite click menu (_buildCiteMenuEntries derives its own shorter
// "Decision (XXX)" button labels from it), so both list the same sources in
// the same order and stay in sync automatically.
function _buildOpinionEntries(caseEntry) {
  if (!caseEntry?.decision) return [];
  const dateLabel = 'Decision\u00a0on\u00a0' + formatDecisionDate(caseEntry.decision);
  const SUFFIX = { decision_loc: 'LOC', decision_ussc: 'USSC', decision_reports: 'VOL' };
  const entries = _buildDecisionEntries(caseEntry).map(e => ({ ...e, title: dateLabel + '\u00a0(' + SUFFIX[e.value] + ')' }));
  if (caseEntry.decision_xml) {
    entries.push({
      value: 'decision_xml',
      href: (window.OPINIONS_BASE_URL || '') + caseEntry.decision_xml,
      title: dateLabel + '\u00a0(XML)',
      view: 'pane',
    });
  }
  return entries;
}

// Returns _buildOpinionEntries' list with each entry's `menuLabel` set to the
// fixed, source-specific button text shown in the #case-cite click menu (see
// _setCaseInfoRow2) \u2014 "Decision (LOC)" etc., as opposed to that same list's
// own `title`, which is what the doc viewer's title bar shows once opened.
function _buildCiteMenuEntries(caseEntry) {
  const MENU_LABELS = { decision_loc: 'Decision (LOC)', decision_ussc: 'Decision (USSC)', decision_reports: 'Decision (VOL)', decision_xml: 'Decision (XML)' };
  return _buildOpinionEntries(caseEntry).map(e => ({ ...e, menuLabel: MENU_LABELS[e.value] }));
}

// Bidirectional mapping between the file-select dropdown's decision_* option
// values and the short values used for the URL 'file' param, so a selected
// decision source round-trips through the URL (?file=loc|ussc|vol|xml) and
// can be restored on load.
const DECISION_FILE_PARAMS = { decision_loc: 'loc', decision_ussc: 'ussc', decision_reports: 'vol', decision_xml: 'xml' };
const DECISION_PARAM_KEYS  = { loc: 'decision_loc', ussc: 'decision_ussc', vol: 'decision_reports', xml: 'decision_xml' };

// If `param` (a URL 'file' value) names a decision source present in the
// current case's _currentDecisionEntries, show it in the doc viewer and sync
// the file-select dropdown to match. Returns whether it was handled.
function _showDecisionFromParam(param) {
  const key = DECISION_PARAM_KEYS[param];
  const de  = key && _currentDecisionEntries.find(d => d.value === key);
  if (!de) return false;
  showDocViewer({ href: de.href, title: de.title, view: de.view }, { autoScroll: true });
  const fileSelect = document.getElementById('file-select');
  if (fileSelect && !fileSelect.hidden) fileSelect.value = key;
  return true;
}

// If `param` (a URL 'file' value) names a journal entry ("YYYY.N") present in
// _currentJournalRefs, show it in the doc viewer and sync the file-select
// dropdown to match. Returns whether it was handled.
function _showJournalFromParam(param) {
  const key   = 'journal:' + param;
  const entry = _currentJournalRefs.get(key);
  if (!entry) return false;
  showDocViewer({ href: entry.href, title: entry.title }, { autoScroll: true });
  const fileSelect = document.getElementById('file-select');
  if (fileSelect && !fileSelect.hidden) fileSelect.value = key;
  return true;
}

// If `param` (a URL 'file' value) names a minutes entry (an ISO date) present
// in _currentMinutesRefs, show it in the doc viewer and sync the file-select
// dropdown to match. Returns whether it was handled.
function _showMinutesFromParam(param) {
  const key   = 'minutes:' + param;
  const entry = _currentMinutesRefs.get(key);
  if (!entry) return false;
  showDocViewer({ href: entry.href, title: entry.title, view: entry.view }, { autoScroll: true });
  const fileSelect = document.getElementById('file-select');
  if (fileSelect && !fileSelect.hidden) fileSelect.value = key;
  return true;
}

// "Historical Article from <domain>" — the file-select label and doc-viewer
// title for a case's history_href, e.g. "https://www.supremecourt.gov/..."
// → "Historical Article from supremecourt.gov".
function _historyEntryTitle(href) {
  let host = '';
  try { host = new URL(href, location.href).hostname.replace(/^www\./, ''); } catch {}
  return 'Historical Article' + (host ? ' from ' + host : '');
}

// If `param` (a URL 'file' value) is "history" and the current case has a
// history_href, show it in the doc viewer and sync the file-select dropdown
// to match. Returns whether it was handled.
function _showHistoryFromParam(param) {
  if (param !== 'history' || !_currentCaseEntry?.history_href) return false;
  showDocViewer({ href: _currentCaseEntry.history_href, title: _historyEntryTitle(_currentCaseEntry.history_href), view: 'pane' }, { autoScroll: true });
  const fileSelect = document.getElementById('file-select');
  if (fileSelect && !fileSelect.hidden) fileSelect.value = 'history-page';
  return true;
}

// Popup menu for #case-cite: lets the user pick which opinion-text source to
// open in the doc viewer, when one or more of LOC/USSC/Volume/XML is
// available. Reuses the same generic dropdown look as the term/collection
// sort menus (see _buildSortMenu), just with plain (non-toggling) options.
function _buildCiteMenu(anchorEl, entries) {
  document.querySelectorAll('.term-sort-menu').forEach(m => m.remove());
  const menu = document.createElement('ul');
  menu.className = 'term-sort-menu cite-menu';
  for (const entry of entries) {
    const item = document.createElement('li');
    item.className = 'term-sort-option';
    item.textContent = entry.menuLabel;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.remove();
      showDocViewer({ href: entry.href, title: entry.title, view: entry.view }, { force: true });
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

// Returns [{value, href, title}] for each unique transcript_href across events, date-sorted.
function _buildTranscriptEntries(caseEntry) {
  const entries = [];
  const seen = new Set();
  const sorted = [...(caseEntry.events || [])].sort(
    (a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0
  );
  for (const a of sorted) {
    if (!a.transcript_href || seen.has(a.transcript_href)) continue;
    seen.add(a.transcript_href);
    entries.push({ value: 'transcript:' + entries.length, href: a.transcript_href,
                   title: 'Transcript\u00a0of\u00a0' + (a.title || ''),
                   ...(a.view ? { view: a.view } : {}) });
  }
  return entries;
}

// Returns [{value, href, title}] for the Oyez case-description link(s).
// oyez_href is normally a single URL string, but for a case consolidated
// from multiple Oyez case pages it's an array of URL strings instead.
function _buildOyezEntries(caseEntry) {
  const raw = caseEntry?.oyez_href;
  if (!raw) return [];
  const urls = Array.isArray(raw) ? raw : [raw];
  const label = 'Description from The Oyez Project';
  return urls.map((href, i) => {
    let title = label;
    if (urls.length > 1) {
      const m = /\/cases\/\d{4}\/([^/?#]+)/.exec(href);
      if (m) title = label + ' (No. ' + decodeURIComponent(m[1]) + ')';
    }
    return { value: 'oyez:' + i, href, title };
  });
}

// Reference-type files.json entries (the same ones grouped under "References"
// in the sidebar) get pulled out of #file-select's alphabetized file list and
// appended as their own block at the very end (after decisions/video), each
// prefixed "Reference: " so they read as a distinct group rather than mingling
// with briefs/transcripts by title alone.
function _buildReferenceOptions(rawFiles) {
  return rawFiles
    .filter(f => (f.type || '').toLowerCase() === 'reference')
    .slice()
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    .map(f => {
      const opt = document.createElement('option');
      opt.value = 'file:' + f.file;
      const t = f.title || '';
      opt.textContent = 'Reference: ' + (t.length > 40 ? t.slice(0, 40) + '…' : t);
      return opt;
    });
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
  const term = _currentTerm || (_currentCaseKey ? _currentCaseKey.split('/')[0] : '');

  // Replaces the contents of `el` with a prefix label followed by a single
  // clickable <a> spanning every date, navigating to the first one.
  // e.g. "1890-11-21,1890-11-24"  \u2192 "November 21, 24, 1890"
  //      "1890-11-30,1890-12-01"  \u2192 "November 30, December 1, 1890"
  function _setDateLinks(el, prefix, dateStr) {
    while (el.firstChild) el.removeChild(el.firstChild);
    if (!dateStr) { el.hidden = true; return; }
    const dates = dateStr.split(',').map(d => d.trim()).filter(Boolean);
    if (!dates.length) { el.hidden = true; return; }
    el.hidden = false;
    const firstIso = dates[0];

    let text;
    if (dates.length === 1) {
      text = formatDecisionDate(firstIso);
    } else {
      // Group into runs sharing the same calendar month, in order of
      // appearance (no adjacency requirement \u2014 e.g. the 21st and 24th of the
      // same month share one run), then join the runs with a single trailing
      // year, repeated only where an earlier run's year differs from the next.
      const segments = []; // [{ y, m, days: [int] }]
      for (const iso of dates) {
        const [y, m, d] = iso.split('-');
        const day = parseInt(d, 10);
        const last = segments[segments.length - 1];
        if (last && last.y === y && last.m === m) {
          last.days.push(day);
        } else {
          segments.push({ y, m, days: [day] });
        }
      }
      text = segments.map((seg, i) => {
        const month = MONTHS[parseInt(seg.m, 10) - 1] || seg.m;
        let s = month + '\u00a0' + seg.days.join(',\u00a0');
        const isLast = i === segments.length - 1;
        if (isLast || segments[i + 1].y !== seg.y) s += ',\u00a0' + seg.y;
        return s;
      }).join(',\u00a0');
    }

    el.appendChild(document.createTextNode(prefix + '\u00a0'));
    const a = document.createElement('a');
    a.href = '?term=' + encodeURIComponent(term) + '&date=' + encodeURIComponent(firstIso);
    a.className = 'date-link';
    a.textContent = text;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(buildUrlParams({ term, date: firstIso }, ['case', 'event', 'turn', 'file', 'collection', 'group', 'id', 'highlight', 'link']));
      updateEmptyStateForTerm(term, firstIso);
    });
    el.appendChild(a);
  }

  _setDateLinks(document.getElementById('case-argued'),   'Argued',   caseEntry.argument);
  _setDateLinks(document.getElementById('case-reargued'), 'Reargued', caseEntry.reargument);
  _setDateLinks(document.getElementById('case-decided'),  'Decided',  caseEntry.decision);
  // "(367 U.S. 203)" — click opens a small menu of every opinion-text source
  // this case has (LOC/USSC/Volume/XML), each opening in the doc viewer.
  const citeEl = document.getElementById('case-cite');
  const citeEntries = _buildCiteMenuEntries(caseEntry);
  if (citeEntries.length && caseEntry.usCite) {
    citeEl.href = citeEntries[0].href; // plain fallback (e.g. middle-click/open-in-new-tab)
    citeEl.textContent = '(' + caseEntry.usCite + ')';
    citeEl.hidden = false;
    citeEl.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      _buildCiteMenu(citeEl, citeEntries);
    };
  } else {
    citeEl.hidden = true;
    citeEl.onclick = null;
  }
  document.getElementById('case-info-row2').hidden =
    !(caseEntry.argument || caseEntry.reargument || caseEntry.decision);
  _setCaseNotes(caseEntry.notes || '');
  _setCaseInfoRow3(caseEntry);
  _setCaseInfoRow4(caseEntry);
}

function _voteName(allCapsName) {
  // Strip generational suffixes and extract last word, then title-case it.
  // e.g. "JOHN HARLAN, II" → "Harlan", "THURGOOD MARSHALL" → "Marshall"
  const base = allCapsName.replace(/,?\s+(II|III|IV|JR\.?|SR\.?)$/i, '').trim();
  const last = base.split(/\s+/).pop();
  return toTitleCase(last);
}

function _setCaseInfoRow3(caseEntry) {
  const row = document.getElementById('case-info-row3');
  const span = document.getElementById('case-vote');
  if (!caseEntry.voteMajority || caseEntry.voteMinority == null || !caseEntry.votes?.length) {
    span.textContent = '';
    row.hidden = true;
    return;
  }
  const majorityVotes = caseEntry.votes.filter(v => v.vote === 'majority');
  const score = caseEntry.voteMajority + '–' + caseEntry.voteMinority;
  const firstTitle = (caseEntry.title || '').split('|')[0];
  let party;
  if ((caseEntry.result || '').includes('petitioning party received a favorable disposition')) {
    party = firstTitle.split(' v. ')[0].trim();
  } else {
    const parts = firstTitle.split(' v. ');
    party = (parts[1] || parts[0]).trim();
  }

  const result = caseEntry.result || '';
  if (caseEntry.voteMinority === 0 && /^dismissed/i.test(result)) {
    span.textContent = '';
    const label = result.charAt(0).toUpperCase() + result.slice(1);
    span.appendChild(document.createTextNode(label + ' in favor of ' + party));
    row.hidden = false;
    return;
  }

  // Determine opinion author link params if a justice has opinion:true.
  const opinionVote = majorityVotes.find(v => v.opinion === true);
  const term = _currentCaseKey ? _currentCaseKey.split('/')[0] : '';
  const caseNum = new URLSearchParams(location.search).get('case') || caseId(caseEntry);
  const opinionId = (opinionVote && term && caseNum) ? _makeAdvocateId(opinionVote.name) : null;

  span.textContent = '';
  span.appendChild(document.createTextNode(score + ' ('));
  majorityVotes.forEach((v, i) => {
    if (i > 0) span.appendChild(document.createTextNode(', '));
    const displayName = _voteName(v.name);
    if (v.opinion === true && opinionId) {
      const a = document.createElement('a');
      a.href = '?' + new URLSearchParams({ collection: 'opinions', id: opinionId, term, case: caseNum });
      a.textContent = displayName;
      span.appendChild(a);
    } else {
      span.appendChild(document.createTextNode(displayName));
    }
  });
  span.appendChild(document.createTextNode(') in favor of ' + party));
  row.hidden = false;
}

function _setCaseInfoRow4(caseEntry) {
  const row       = document.getElementById('case-info-row4');
  const scdbSpan  = document.getElementById('case-scdb-message');
  const auditSpan = document.getElementById('case-audit-message');
  const sep       = document.getElementById('case-message-sep');
  const scdbMsg  = caseEntry.scdb_message  || '';
  const auditMsg = caseEntry.audit_message || '';
  scdbSpan.textContent  = scdbMsg;
  auditSpan.textContent = auditMsg;
  sep.hidden = !(scdbMsg && auditMsg);
  if (!scdbMsg && !auditMsg) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
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

// green=true → green ring, used only as a fallback when there's no opinion-audio
// signal at all (blue/orange/filled all unset) but the case has citations/references
// worth flagging — the lowest-priority ring color, deferring to the others above it.
function makeScalesRingSvg(blue, filled = false, orange = false, green = false) {
  const size = 22, cx = 11, cy = 11, r = 9;
  const color = orange ? '#E07820' : green ? '#2E8B57' : (blue ? '#3778A6' : '#9461C8');

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

// Small trash-can icon used to delete a user-added tag (tags menu).
function makeTrashIconSvg() {
  const svg = _svgEl('svg', { width: 13, height: 13, viewBox: '0 0 16 16', class: 'tag-icon' });
  const g = _svgEl('g', { stroke: 'currentColor', 'stroke-width': '1.3', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  g.appendChild(_svgEl('line', { x1: 3,   y1: 4.5, x2: 13,  y2: 4.5 }));
  g.appendChild(_svgEl('path', { d: 'M5.5,4.5 V3 a1,1 0 0 1 1,-1 h3 a1,1 0 0 1 1,1 V4.5' }));
  g.appendChild(_svgEl('path', { d: 'M4.5,4.5 L5.2,13 a1,1 0 0 0 1,0.9 h3.6 a1,1 0 0 0 1,-0.9 L11.5,4.5' }));
  g.appendChild(_svgEl('line', { x1: 6.5, y1: 7,   x2: 6.8,  y2: 11.5 }));
  g.appendChild(_svgEl('line', { x1: 9.5, y1: 7,   x2: 9.2,  y2: 11.5 }));
  svg.appendChild(g);
  return svg;
}

// Small clipboard icon used to copy a tag's plain-text value (tags menu).
function makeClipboardIconSvg() {
  const svg = _svgEl('svg', { width: 13, height: 13, viewBox: '0 0 16 16', class: 'tag-icon' });
  const g = _svgEl('g', { stroke: 'currentColor', 'stroke-width': '1.3', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  g.appendChild(_svgEl('rect',  { x: 3.5, y: 2.5,  width: 9, height: 11.5, rx: 1.2 }));
  g.appendChild(_svgEl('path',  { d: 'M6,2.5 V1.8 a1,1 0 0 1 1,-1 h2 a1,1 0 0 1 1,1 V2.5' }));
  g.appendChild(_svgEl('line',  { x1: 6, y1: 6.3,  x2: 10,  y2: 6.3  }));
  g.appendChild(_svgEl('line',  { x1: 6, y1: 8.6,  x2: 10,  y2: 8.6  }));
  g.appendChild(_svgEl('line',  { x1: 6, y1: 10.9, x2: 8.5, y2: 10.9 }));
  svg.appendChild(g);
  return svg;
}

// Copy a tag's plain-text value to the system clipboard.
function _copyTagPlainText(tag) {
  const text = String(tag);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(ta);
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
        title: 'Transcript from ' + formatDecisionDate(a.date || ''),
        date:  a.date || '',
        href:  a.transcript_href,
        ...(a.view ? { view: a.view } : {}),
      });
      existingHrefs.add(a.transcript_href);
    }
  });
}

// Build the { kind: 'group', label: 'Citations', files } entry from a case's
// opCite array (see scripts/update_cases.js --cites), or null when absent.
// Always append this after any Briefs/Media/Other groups but before
// Consolidations and References (the very last groups).
function _buildCitationsEntry(caseEntry) {
  if (!caseEntry.opCite?.length) return null;
  const files = caseEntry.opCite
    .map((entry, i) => ({
      title: entry.title,
      citationTerm: entry.term,
      citationId: entry.id,
      citationIdx: i + 1, // 1-based index into opCite, mirrored in the 'citation' URL param
    }))
    // Sorted by title, same convention as References, rather than opCite's
    // own order (most-recently-decided citation first).
    .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return { kind: 'group', label: 'Citations', files };
}

// Build the { kind: 'group', label: 'Consolidations', files } entry listing
// every title of a consolidated case — including the first/base one shown on
// the case's own row, so there's always a way back to it from a sub-case's
// page — each labelled with its docket number and linking to it so the header
// title and default event switch to it (see _subCaseForNumber and the
// numberOverride handling in restoreFromURL). Returns null when the case isn't
// consolidated (a single title, or title/number counts that don't line up).
// Appears after Citations but before References (the very last group) and
// any flat transcript/decision entries.
function _buildOtherTitlesEntry(caseEntry, term) {
  const titles  = (caseEntry.title  || '').split('|');
  const numbers = (caseEntry.number || '').split(',').map(n => n.trim());
  if (titles.length < 2 || numbers.length !== titles.length) return null;
  const files = titles.map((title, i) => ({
    title: `${title} (No. ${_normNum(numbers[i])})`,
    otherTitleTerm: term,
    otherTitleNumber: numbers[i],
  }));
  return { kind: 'group', label: 'Consolidations', files };
}

// Find a rendered citation file-item by its 1-based 'citation' URL param value.
function findCitationItem(param) {
  if (param == null) return null;
  return document.querySelector(`.file-item-citation[data-citation-idx="${CSS.escape(String(param))}"]`);
}

// Look up a cited case's own decision link (decision_loc, else decision_ussc,
// else decision_reports) by loading its term's cases.json and matching on id.
async function _resolveCitationHref(term, id) {
  const cases = await fetchTermCases(term);
  const c = Array.isArray(cases) ? cases.find(x => x?.id === id) : null;
  return c ? (c.decision_loc || c.decision_ussc || c.decision_reports || null) : null;
}

// Build a single <li class="file-item"> with the standard click handler.
function _makeCaseFileItem(f, caseEntry) {
  const fi = document.createElement('li');
  fi.className = 'file-item';
  if (f.citationTerm != null) {
    fi.classList.add('file-item-citation');
    if (f.citationIdx != null) fi.dataset.citationIdx = f.citationIdx;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'citation-title';
    titleSpan.textContent = f.title;
    titleSpan.addEventListener('click', async e => {
      e.stopPropagation();
      const mySeq = ++_fileClickSeq;
      const href = await _resolveCitationHref(f.citationTerm, f.citationId);
      if (!href) return;
      if (mySeq !== _fileClickSeq) return; // a newer file/citation click superseded this one
      document.querySelectorAll('.file-item, .file-type-header').forEach(el => el.classList.remove('active'));
      fi.classList.add('active');
      if (f.citationIdx != null) {
        // Only update the URL if this citation belongs to the currently URL-encoded case.
        const ci = fi.closest('.case-item');
        const caseKey = ci?.dataset.caseKey || '';
        const slash = caseKey.indexOf('/');
        const citeTerm = slash >= 0 ? caseKey.slice(0, slash) : '';
        const citeCase = slash >= 0 ? caseKey.slice(slash + 1) : '';
        const url = new URL(location.href);
        const urlMatches = !citeTerm || !citeCase
          || (url.searchParams.get('term') === citeTerm
              && url.searchParams.get('case') === citeCase);
        if (urlMatches) {
          url.searchParams.set('citation', f.citationIdx);
          url.searchParams.delete('file');
          history.replaceState(null, '', url);
        }
      }
      showDocViewer({ href, title: f.title }, { autoScroll: true });
    });
    fi.appendChild(titleSpan);

    const arrow = document.createElement('span');
    arrow.className = 'citation-goto-arrow';
    arrow.textContent = '→';
    arrow.title = 'Open cited case';
    arrow.addEventListener('click', e => {
      e.stopPropagation();
      const href = buildUrlParams(
        { term: f.citationTerm, case: f.citationId },
        ['collection', 'group', 'id', 'highlight', 'file', 'citation', 'event', 'turn', 'find'],
      );
      navigate(href);
      restoreFromURL();
    });
    fi.appendChild(arrow);

    return fi;
  }
  if (f.otherTitleNumber != null) {
    fi.classList.add('file-item-other-title');
    fi.textContent = f.title;
    fi.addEventListener('click', e => {
      e.stopPropagation();
      // Unlike Citations (a link to an unrelated cited case), a consolidation is
      // the same underlying case under a different docket number — so keep any
      // active collection/topic/group/id context instead of dropping it.
      const href = buildUrlParams(
        { term: f.otherTitleTerm, case: f.otherTitleNumber },
        ['file', 'citation', 'event', 'turn', 'find'],
      );
      navigate(href);
      restoreFromURL();
    });
    return fi;
  }
  if ((f.type || '').toLowerCase() === 'transcript') {
    fi.classList.add('file-item-transcript');
  }
  if (f.file != null) fi.dataset.fileId = f.file;
  if (f.href)        fi.dataset.fileHref = f.href;
  fi.textContent = f.title;
  if (f.source) fi.title = f.source;
  fi.addEventListener('click', e => {
    e.stopPropagation();
    ++_fileClickSeq; // invalidate any in-flight async citation lookup
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
          url.searchParams.delete('citation');
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
function _renderFileGroup(fileUl, label, files, makeFileItem, open = false) {
  const groupLi = document.createElement('li');
  groupLi.className = 'file-type-group' + (open ? ' open' : '');

  const typeHeader = document.createElement('div');
  typeHeader.className = 'file-type-header';

  const typeLabel = document.createElement('span');
  typeLabel.className = 'file-type-label';
  typeLabel.textContent = label;

  const typeTog = document.createElement('span');
  typeTog.className = 'file-type-toggle';
  typeTog.textContent = '▶︎';

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

  // When decision source(s) are present, drop any opinion entry from files.json
  // (use the full set of decision sources instead). When none is present,
  // normalise files.json opinion titles to "Decision on <date>".
  const _opinionEntries = _buildOpinionEntries(caseEntry);
  if (_opinionEntries.length) {
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

  // Append one "Decision on <Date> (LOC/USSC/VOL/XML)" entry per available
  // decision source \u2014 the same set the top-right document dropdown offers
  // (see _buildOpinionEntries) \u2014 rather than just the single primary one.
  _opinionEntries.forEach(oe => {
    rawFiles.push({ type: 'opinion', title: oe.title, href: oe.href, ...(oe.view ? { view: oe.view } : {}) });
  });

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
function _buildCaseItemShell({ caseKey, title, tooltip, audioDate, eventIdx, hasFiles, href }) {
  const ci = document.createElement('li');
  ci.className = 'case-item';
  ci.dataset.caseKey = caseKey;
  if (audioDate) ci.dataset.audioDate = audioDate;
  if (eventIdx != null) ci.dataset.eventIdx = String(eventIdx);

  const header = document.createElement('div');
  header.className = 'case-header';

  const toggle = document.createElement('span');
  toggle.className = 'case-toggle';
  toggle.textContent = '▶︎';
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
    icon = makeScalesRingSvg(ring.blue, ring.filled, ring.orange, ring.green);
  } else {
    icon = makeScalesSvg();
  }
  let node = icon;
  if (onClick) {
    let tooltipText;
    if (!ring) {
      tooltipText = 'Opinion issued';
    } else if (ring.green) {
      tooltipText = 'Opinion issued; citations or references available';
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

// Format a YYYY-MM-DD (or partial YYYY-MM / YYYY) string as "MMM DD".
function _fmtMonthDay(dateStr, withYear = false) {
  if (!dateStr) return '';
  const parts = String(dateStr).split('-');
  const y = parts[0];
  if (!parts[1]) return withYear ? y : '';
  const mo = parseInt(parts[1], 10) - 1;
  const monthAbbr = _SORT_MONTH_ABBR[mo] || '';
  if (!parts[2]) return withYear ? monthAbbr + '\u00a0' + y : monthAbbr;
  const dd = parseInt(parts[2], 10);
  const base = monthAbbr + '\u00a0' + dd;
  return withYear ? base + ', ' + y : base;
}

// Returns the most recent argument date across both argument and reargument fields.
function _lastArgDate(c) {
  const dates = [];
  if (c.argument)   String(c.argument).split(',').forEach(d => { if (d.trim()) dates.push(d.trim()); });
  if (c.reargument) String(c.reargument).split(',').forEach(d => { if (d.trim()) dates.push(d.trim()); });
  return dates.length ? dates.reduce((a, b) => a > b ? a : b) : '';
}

// Returns the earliest argument date across both argument and reargument
// fields — e.g. for an advocate/justice's own case entry (update_advocates.js
// scopes argument/reargument to just the dates *that person* appeared in),
// this is the first day they argued, which is what a per-case list row
// should display rather than _lastArgDate's most-recent-day sort key.
function _firstArgDate(c) {
  const dates = [];
  if (c.argument)   String(c.argument).split(',').forEach(d => { if (d.trim()) dates.push(d.trim()); });
  if (c.reargument) String(c.reargument).split(',').forEach(d => { if (d.trim()) dates.push(d.trim()); });
  return dates.length ? dates.reduce((a, b) => a < b ? a : b) : '';
}

// Build (or rebuild) a term's case list under `ul` using the given sort mode.
// Does not rebuild if mode hasn't changed (idempotent).
function buildTermCasesSorted(term, cases, ul, mode, asc = true) {
  const visible = cases.filter(c => c.events?.length || hasDecisionHref(c) || c.files);

  // Precompute URL ids for all cases in the term (not just visible) so the
  // uniqueness check is accurate and stable across sort modes.
  const _firstNumOf = (c) => c.number ? c.number.split(',')[0].trim() : '';
  const _numCount = new Map();
  for (const c of cases) { const n = _firstNumOf(c); if (n) _numCount.set(n, (_numCount.get(n) || 0) + 1); }
  const urlIdOf = (c) => { const n = _firstNumOf(c); return (n && _numCount.get(n) === 1) ? n : (c.id || n || ''); };

  let sorted;
  if (mode === 'argued') {
    sorted = [...visible].sort((a, b) => { const da = _lastArgDate(a), db = _lastArgDate(b); return da < db ? -1 : da > db ? 1 : caseTitle(a.title || '').localeCompare(caseTitle(b.title || '')); });
  } else if (mode === 'decided') {
    // Undecided cases (no decision date) always sort to the end regardless of direction.
    const decided   = visible.filter(c =>  c.decision);
    const undecided = visible.filter(c => !c.decision);
    decided.sort((a, b) => a.decision < b.decision ? -1 : a.decision > b.decision ? 1 : _lastArgDate(a).localeCompare(_lastArgDate(b)) || caseTitle(a.title || '').localeCompare(caseTitle(b.title || '')));
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
    const hasOpinion    = hasDecisionHref(caseEntry);
    const hasFiles      = !!caseEntry.files || !!caseEntry.opCite?.length || (caseEntry.title || '').includes('|');

    const { ci, header, toggle, titleSpan, fileUl } = _buildCaseItemShell({
      caseKey,
      title:    caseTitle(caseEntry.title),
      tooltip:  decisionTooltip(term, caseEntry, caseEntry.decision),
      hasFiles,
      href:     buildUrlParams(
        { term, case: urlId },
        ['collection', 'group', 'id', 'highlight', 'event', 'file', 'turn'],
      ),
    });

    if (mode === 'argued' || mode === 'decided') {
      // Replace icons with a compact date label
      // For argued: use the most recent date (including reargument); for decided: first date suffices
      const dateKey = mode === 'argued' ? _lastArgDate(caseEntry) : (caseEntry.decision ? String(caseEntry.decision).split(',')[0].trim() : '');
      const dateLbl = document.createElement('span');
      dateLbl.className = 'case-sort-label';
      dateLbl.textContent = _fmtMonthDay(dateKey);
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
      if (hasOpinion || caseEntry.events?.length || hasFiles) {
        // Green ring is the lowest-priority signal — only drawn when there's
        // no opinion-audio/video ring to show instead (see makeScalesRingSvg).
        _attachScalesIcon(ci, header, {
          ring: opinionCircleData(caseEntry) || (hasFiles ? { green: true } : null),
          onClick: hasOpinion ? (e) => {
            e.stopPropagation();
            const _firstDecision = _buildPrimaryDecisionEntry(caseEntry);
            const opinionFile = _firstDecision
              ? { href: _firstDecision.href, title: _firstDecision.title }
              : null;
            if (!opinionFile) return;
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
          const TYPE_LABELS = { petitioner:'Petitioner', respondent:'Respondent', amicus:'Amicus', briefs:'Briefs', reference:'References', media:'Media', other:'Other' };
          const ORDER = ['petitioner','respondent','amicus','briefs','reference','media','other'];
          const MERGE_AMICUS_OTHER = true;
          const _TERM_GROUP_KEYS = new Set(['petitioner','respondent','amicus','briefs','reference','media','other','transcript','opinion','statement']);
          const groups = {};
          rawFiles.forEach(f => {
            let key = (f.group || '').toLowerCase();
            if (key === 'brief') key = 'briefs';
            if (!_TERM_GROUP_KEYS.has(key)) {
              // Fallback for synthetic entries (virtual transcripts, injected opinions) that have no group.
              key = (f.type || '').toLowerCase();
              if (key === 'appellant' || key === 'appellants' || key === 'plaintiff' || key === 'plaintiffs' || key === 'complainant' || key === 'complainants') key = 'petitioner';
              else if (key === 'appellee' || key === 'appellees' || key === 'defendant' || key === 'defendants') key = 'respondent';
              if (!_TERM_GROUP_KEYS.has(key)) key = 'other';
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
          // Each transcript ("Oral Argument on ...") and decision ("Decision
          // on ..."), plus any relating-to-orders statement ("Statement in
          // ..." — see importRelatingToOrdersCases in scripts/import_ussc.js),
          // gets surfaced under its own "Records" group — arguments first
          // (chronological), decisions/statements last — appended as the very
          // last group, after Citations/Consolidations/References (see below).
          const byDate = (a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0;
          const recordsFiles = [
            ...(groups.transcript || []).slice().sort(byDate),
            ...(groups.opinion || []).slice().sort(byDate),
            ...(groups.statement || []).slice().sort(byDate),
          ];
          delete groups.statement;
          delete groups.transcript;
          delete groups.opinion;
          const referenceFiles = groups.reference || [];
          delete groups.reference;
          const effectiveOrder = (MERGE_AMICUS_OTHER ? ORDER.filter(k => k !== 'amicus') : ORDER).filter(k => k !== 'reference');
          const entries = [];
          effectiveOrder.forEach(typeKey => {
            if (!groups[typeKey]?.length) return;
            entries.push({ kind: 'group', label: TYPE_LABELS[typeKey] || typeKey, files: groups[typeKey] });
          });
          const groupEntries = entries.filter(e => e.kind === 'group');
          const _alwaysLabeled = new Set(['References', 'Media', 'Other']);
          if (groupEntries.length === 1 && !referenceFiles.length && !_alwaysLabeled.has(groupEntries[0].label)) { groupEntries[0].kind = 'flat'; delete groupEntries[0].label; }
          // Citations, Consolidations, and References come next (in that
          // order), then Records is always the very last group of all.
          const citationsEntry = _buildCitationsEntry(caseEntry);
          if (citationsEntry) entries.push(citationsEntry);
          const otherTitlesEntry = _buildOtherTitlesEntry(caseEntry, term);
          if (otherTitlesEntry) entries.push(otherTitlesEntry);
          if (referenceFiles.length) entries.push({ kind: 'group', label: TYPE_LABELS.reference, files: referenceFiles });
          if (recordsFiles.length) entries.push({ kind: 'group', label: 'Records', files: recordsFiles });
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
      const fileRestore = e.fileRestore ?? null;
      const citationRestore = e.citationRestore ?? null;
      const numberOverride = e.numberOverride ?? null;
      if (!fromRestore && ci.classList.contains('active')) {
        if (ci.classList.toggle('open')) await ensureFilesLoaded();
        return;
      }
      markCaseItemActive(ci);
      await ensureFilesLoaded();
      let audioIdx    = Number.isInteger(e.audioIdx) ? e.audioIdx : 0;
      let initialTurn = null;
      if (!fromRestore) {
        const saved = _caseSessionState.get(term + '/' + caseId(caseEntry));
        if (saved) {
          if (saved.eventIdx >= 1) audioIdx = saved.eventIdx;
          initialTurn = saved.turnNum ?? null;
        }
        const urlParams  = { term, case: urlId };
        const urlDeletes = ['collection', 'group', 'id', 'highlight', 'file', 'citation'];
        if (audioIdx >= 1) urlParams.event = audioIdx; else urlDeletes.push('event');
        if (initialTurn != null) urlParams.turn = initialTurn; else urlDeletes.push('turn');
        setPageMeta(caseTitle(caseEntry.title) + ' | Argument Aloud');
        navigate(buildUrlParams(urlParams, urlDeletes));
      } else if (!numberOverride) {
        // Normalise the URL to use the canonical urlId (the URL may have arrived
        // via an id-based param like ?case=1959-099 instead of ?case=376). Skip
        // this when numberOverride is set — the URL intentionally names one
        // specific docket within a consolidated case, not the canonical one.
        const url = new URL(location.href);
        if (url.searchParams.get('case') !== urlId) {
          url.searchParams.set('case', urlId);
          history.replaceState(null, '', url);
        }
      }
      await loadCase(term, caseEntry, audioIdx, { ...(initialTurn != null ? { initialTurn } : {}), numberOverride });
      if (fromRestore) trackPageView(location.href);
      if (!fromRestore && mode === 'decided' && caseEntry.events?.some(a => a.audio_href) && hasDecisionHref(caseEntry)) {
        const de = _buildPrimaryDecisionEntry(caseEntry);
        if (de) showDocViewer({ href: de.href, title: de.title }, { autoScroll: true });
      }
      const _hasPlayableAudio = caseEntry.events?.some(a => a.audio_href);
      if (fileRestore != null && !_hasPlayableAudio && !_showDecisionFromParam(fileRestore) && !_showJournalFromParam(fileRestore) && !_showMinutesFromParam(fileRestore) && !_showHistoryFromParam(fileRestore)) {
        const fileEl = findFileItem(fileRestore);
        if (fileEl) { fileEl.closest('.file-type-group')?.classList.add('open'); fileEl.click(); }
      }
      if (citationRestore != null && !_hasPlayableAudio) {
        const citeEl = findCitationItem(citationRestore);
        if (citeEl) { citeEl.closest('.file-type-group')?.classList.add('open'); citeEl.querySelector('.citation-title')?.click(); }
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

// Wires a collapsible sidebar row (term, collection, group, top-level section, ...)
// so a click anywhere on it — from the triangle through the end of the label —
// behaves consistently:
//   - closed  -> open it (onOpen)
//   - open, and isSelected() is true (this row IS the current selection) -> close it (onClose)
//   - open, but isSelected() is false (row was left open while browsing, something
//     else is the current selection) -> re-select it without closing (onOpen)
// The triangle always opens/closes regardless of selection, matching the label except
// that a closing triangle click never re-checks isSelected (it's closing either way).
// isSelected defaults to always-true for pure containers with no URL identity of
// their own (e.g. decade groups), where open and selected are the same thing.
function _wireAccordionHeader(header, { tog, li, isSelected = () => true, onOpen, onClose, stopPropagation = false, silentTriangleOpen = false } = {}) {
  header.addEventListener('click', async (e) => {
    if (stopPropagation) e.stopPropagation();
    if (tog && tog.contains(e.target)) {
      if (li.classList.contains('open')) {
        li.classList.remove('open');
        await onClose?.(e);
        return;
      }
      li.classList.add('open');
      if (silentTriangleOpen) return;
    } else if (li.classList.contains('open')) {
      if (isSelected()) {
        li.classList.remove('open');
        await onClose?.(e);
        return;
      }
    } else {
      li.classList.add('open');
    }
    await onOpen?.(e);
  });
}

function buildNav(title = 'Terms', id = '') {
  const termListEl = document.getElementById('term-list');

  // Wrap all decade groups in a top-level collapsible section.
  const termsLi = document.createElement('li');
  termsLi.className = 'terms-group';
  termsLi.dataset.section = 'terms';
  if (id) _sectionLiById.set(id, termsLi);
  const termsHeader = document.createElement('div');
  termsHeader.className = 'terms-header';
  const termsTog = document.createElement('span');
  termsTog.className = 'terms-toggle';
  termsTog.textContent = '▶︎';
  const termsLabel = document.createElement('span');
  termsLabel.className = 'terms-label';
  termsLabel.textContent = title;
  termsHeader.appendChild(termsTog);
  termsHeader.appendChild(termsLabel);
  const _navSearchBtn = document.getElementById('nav-search-btn');
  if (_navSearchBtn) { _navSearchBtn.removeAttribute('hidden'); termsHeader.appendChild(_navSearchBtn); }
  _wireAccordionHeader(termsHeader, {
    tog: termsTog,
    li: termsLi,
    isSelected: () => new URLSearchParams(location.search).get('term') === 'all',
    silentTriangleOpen: true,
    onOpen: () => {
      setPageMeta(title + ' | Argument Aloud');
      navigate(buildUrlParams({ term: 'all' }, ['case', 'event', 'turn', 'file', 'collection', 'group', 'id', 'highlight', 'link', 'date', 'sort', 'o']));
      restoreFromURL();
    },
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
    decTog.textContent = '▶︎';

    const decLabel = document.createElement('span');
    decLabel.className = 'decade-label';
    decLabel.textContent = decade.name;

    decHeader.appendChild(decTog);
    decHeader.appendChild(decLabel);
    _wireAccordionHeader(decHeader, {
      tog: decTog,
      li: decLi,
      onOpen: async () => {
        // Prefetch case counts for all terms in this decade, newest first.
        const termEls = [...decUl.querySelectorAll('.term-group[data-term]')];
        for (const el of termEls) {
          await el._ensureCount?.();
        }
      },
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
      termTog.textContent = '▶︎';

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
      const _defaultMode = _isCurrentTerm ? 'decided' : 'cases';
      const _defaultAsc  = !_isCurrentTerm;
      let _sortMode = _defaultMode;
      let _sortAsc  = _defaultAsc;
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
            history.replaceState(null, '', buildUrlParams({ sort: _sortMode, o: _sortAsc ? 'a' : 'd' }, []));
            const visible = _casesCache ? _casesCache.filter(c => c.events?.length || hasDecisionHref(c) || c.files) : null;
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
        const visible = cases.filter(c => c.events?.length || hasDecisionHref(c) || c.files);
        termCount.textContent = _sortModeLabel(_sortMode, visible.length, _sortAsc);
      };
      // Fetch count only (no DOM build) — used when expanding the decade.
      const ensureCount = async () => {
        if (termCount.textContent) return; // already populated
        const cases = await fetchTermCases(term);
        _casesCache = cases;
        const visible = cases.filter(c => c.events?.length || hasDecisionHref(c) || c.files);
        termCount.textContent = visible.length + '\u00a0Cases';
      };
      termLi._ensureBuilt = ensureBuilt;
      termLi._ensureCount = ensureCount;
      termLi._showSortLabel = () => {
        if (!_casesCache) return;
        const visible = _casesCache.filter(c => c.events?.length || hasDecisionHref(c) || c.files);
        termCount.textContent = _sortModeLabel(_sortMode, visible.length, _sortAsc);
        termCount.classList.add('sort-active');
      };
      termLi._applySortParam = (mode, asc) => {
        _sortMode = mode;
        _sortAsc  = asc;
        if (_casesCache) {
          buildTermCasesSorted(term, _casesCache, ul, _sortMode, _sortAsc);
          const visible = _casesCache.filter(c => c.events?.length || hasDecisionHref(c) || c.files);
          termCount.textContent = _sortModeLabel(_sortMode, visible.length, _sortAsc);
          termCount.classList.add('sort-active');
        }
      };

      _wireAccordionHeader(termHeader, {
        tog: termTog,
        li: termLi,
        isSelected: () => new URLSearchParams(location.search).get('term') === term,
        onClose: () => {
          termCount.classList.remove('sort-active');
          // Reset to plain count label when collapsed
          if (_casesCache) {
            const visible = _casesCache.filter(c => c.events?.length || hasDecisionHref(c) || c.files);
            termCount.textContent = visible.length + '\u00a0Cases';
          }
          updateEmptyStateForTerm(null);
          // Term collapsed — remove term param too.
          const url = buildUrlParams({}, ['collection', 'group', 'id', 'highlight', 'term', 'case', 'event', 'file', 'turn', 'sort', 'o']);
          navigate(url);
          setTopbarTerm('');
        },
        onOpen: async () => {
          await ensureBuilt();
          termCount.classList.add('sort-active');
          if (_casesCache) {
            const visible = _casesCache.filter(c => c.events?.length || hasDecisionHref(c) || c.files);
            termCount.textContent = _sortModeLabel(_sortMode, visible.length, _sortAsc);
          }
          updateEmptyStateForTerm(term);
          setTopbarTerm(term);
          // Update URL: set term param, clear navigation params.
          // Always reflect the term's current sort: include sort+o when non-default, delete otherwise.
          const _nonDefaultSort = _sortMode !== _defaultMode || _sortAsc !== _defaultAsc;
          const url = buildUrlParams(
            { term, ...(_nonDefaultSort ? { sort: _sortMode, o: _sortAsc ? 'a' : 'd' } : {}) },
            ['collection', 'group', 'id', 'highlight', 'date', 'case', 'event', 'file', 'turn', ...(_nonDefaultSort ? [] : ['sort', 'o'])],
          );
          setPageMeta(termDisplayName(term) + ' | Argument Aloud');
          navigate(url);
        },
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
      if (c.id === collId) return c;
      // Fall back to the legacy file-basename-derived id for entries with no
      // explicit "id" (e.g. topics.json), or as extra defense-in-depth for
      // any collId that reached here without going through
      // _resolveCollectionAlias() first.
      const fileUrl = c.file ?? c.collection;
      if (fileUrl && fileUrl.split('/').pop().replace('.json', '') === collId) return c;
    }
  }
  return null;
}

function buildCollectionsNav(title = 'Collections', data = COLLECTIONS, isTopic = false, id = '') {
  if (!data || !data.length) return null;

  const termListEl = document.getElementById('term-list');

  // Top-level section — styled like the Terms group
  const sectionLi = document.createElement('li');
  sectionLi.className = 'terms-group';
  if (id) _sectionLiById.set(id, sectionLi);

  const sectionHeader = document.createElement('div');
  sectionHeader.className = 'terms-header';

  const sectionTog = document.createElement('span');
  sectionTog.className = 'terms-toggle';
  sectionTog.textContent = '▶︎';

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
      buildCollectionItem(sectionUl, collEntry, isTopic);
    }
  }
  sectionLi._ensureBuilt = () => _doSectionBuild();

  _wireAccordionHeader(sectionHeader, {
    tog: sectionTog,
    li: sectionLi,
    isSelected: () => !!id && new URLSearchParams(location.search).get(id) === 'all',
    onOpen: () => {
      sectionLi._ensureBuilt();
      setPageMeta(title + ' | Argument Aloud');
      _navigateToSectionAll(id);
      restoreFromURL();
    },
  });

  sectionLi.appendChild(sectionHeader);
  sectionLi.appendChild(sectionUl);
  termListEl.appendChild(sectionLi);
  return sectionLi;
}

// ── Nav from index.json ───────────────────────────────────────────────────────

// index.json's "page" values document the source file backing each page (e.g.
// ".../index.md"), but the browser requests the URL Jekyll serves it at (the
// containing folder), not the source filename — strip that suffix here, once,
// rather than at every call site that reads .page. Entries without an
// index.md backing it (e.g. a blog post's date-prefixed filename) have no
// such suffix to strip and pass through unchanged. Same pass also locates
// whichever node is marked "default": true and records its (now-stripped)
// page as _defaultPage, so the SPA's default landing page is configured in
// index.json rather than hardcoded.
function _normalizePageNodes(nodes) {
  for (const node of nodes || []) {
    if (typeof node.page === 'string' && node.page.endsWith('/index.md')) {
      node.page = node.page.slice(0, -'/index.md'.length);
    }
    if (node.default && node.page) _defaultPage = node.page;
    if (Array.isArray(node.groups)) _normalizePageNodes(node.groups);
  }
}

function buildNavFromIndex(navData) {
  const termListEl = document.getElementById('term-list');
  termListEl.innerHTML = '';
  for (const entry of navData) {
    if (entry.hidden) continue;
    if (entry.id && entry.page) _sectionPageById.set(entry.id, entry.page);
    if (entry.file) {
      if (entry.file.endsWith('terms.json')) buildNav(entry.name || 'Terms', entry.id || '');
      else if (entry.file.endsWith('collections.json')) {
        _collectionsSectionLi = buildCollectionsNav(entry.name || 'Collections', COLLECTIONS, false, entry.id || '');
        if (_collectionsSectionLi) {
          const _origCollEnsure = _collectionsSectionLi._ensureBuilt;
          let _favHooked = false;
          _collectionsSectionLi._ensureBuilt = () => {
            _origCollEnsure();
            if (!_favHooked) { _favHooked = true; _initEditsNavItem(_collectionsSectionLi); _initFavoritesCollectionItem(_collectionsSectionLi); }
          };
        }
      }
      else if (entry.file.endsWith('topics.json')) _topicsSectionLi = buildCollectionsNav(entry.name || 'Topics', TOPICS, true, entry.id || '');
    } else if (entry.groups) {
      buildStaticNavSection(termListEl, entry);
    }
  }
}

function buildStaticNavSection(termListEl, entry) {
  const sectionLi = document.createElement('li');
  sectionLi.className = 'terms-group';
  if (entry.id) _sectionLiById.set(entry.id, sectionLi);

  const header = document.createElement('div');
  header.className = 'terms-header';

  const tog = document.createElement('span');
  tog.className = 'terms-toggle';
  tog.textContent = '▶︎';

  const label = document.createElement('span');
  label.className = 'terms-label';
  label.textContent = entry.name;

  header.appendChild(tog);
  header.appendChild(label);
  _wireAccordionHeader(header, {
    tog,
    li: sectionLi,
    isSelected: () => !!entry.id && new URLSearchParams(location.search).get(entry.id) === 'all',
    onOpen: () => {
      if (entry.name) setPageMeta(entry.name + ' | Argument Aloud');
      _navigateToSectionAll(entry.id);
      restoreFromURL();
    },
  });

  const ul = document.createElement('ul');
  ul.className = 'terms-list-inner';

  for (const page of entry.groups || []) {
    if (page.hidden) continue;
    buildStaticPageItem(ul, page, null, null, [entry.name]);
  }

  sectionLi.appendChild(header);
  sectionLi.appendChild(ul);
  termListEl.appendChild(sectionLi);
}

// sourceId/groupIndex are only set for items exactly one level below a
// top-level Sources entry that itself declared an "id" — see the ?source=
// scheme below. Deeper descendants (and children of id-less sources, e.g.
// National Archives) fall back to the older generic ?link= page scheme.
function buildStaticPageItem(parentUl, page, sourceId = null, groupIndex = null, ancestorNames = []) {
  if (page.hidden) return;
  const li = document.createElement('li');
  const hasSubPages = Array.isArray(page.groups) && page.groups.length > 0;
  // "page" is an internal page path (e.g. National Archives entries) shown
  // full-size in the page-viewer iframe. "link" is a true third-party URL
  // (e.g. the other Sources entries), opened in the doc-viewer pane. An entry
  // can have both (e.g. "Docket Search"): the page shows up top, and the
  // link opens alongside it in the doc-viewer pane below — same split view
  // showAdvocateDocument() uses for an advocate's bio page + source document.
  // With no "page" at all, showAdvocateDocument's "document only" branch
  // maximizes the doc-viewer to fill the right side.
  const pagePath = page.page || null;
  const linkUrl  = page.link || null;

  const isTopLevelSource = sourceId === null;
  const thisSourceId = isTopLevelSource ? (page.id || null) : sourceId;
  // A child one level below a top-level source uses its own declared "id"
  // (e.g. index.json's "audio"/"transcripts"/... under "U.S. Supreme Court")
  // for the ?id= param when present, falling back to the positional ?group=
  // index otherwise — same id-preferred/index-fallback convention already
  // used for collections.json/topics.json groups.
  const thisGroupId = (!isTopLevelSource && page.id) ? page.id : null;
  // Only a top-level source with an id, or an immediate child of one, uses
  // the ?source=/&group=|&id= scheme; everything else keeps the old ?link= scheme.
  const usesSourceScheme = isTopLevelSource ? !!thisSourceId : (!!thisSourceId && groupIndex != null);

  // Breadcrumb title, e.g. "Docket Search | U.S. Supreme Court | Sources | Argument Aloud".
  const pageTitle = [page.name, ...ancestorNames, 'Argument Aloud'].filter(Boolean).join(' | ');

  function openPage() {
    setPageMeta(pageTitle);
    if (linkUrl) showAdvocateDocument(linkUrl, pagePath, page.name || '');
    else if (pagePath) showPageViewer(pagePath);
  }

  function navUrl() {
    if (usesSourceScheme) {
      const groupOrId = isTopLevelSource ? {} : (thisGroupId != null ? { id: thisGroupId } : { group: groupIndex });
      const updates = { source: thisSourceId, ...groupOrId };
      const groupKeysToDrop = isTopLevelSource ? ['group', 'id'] : (thisGroupId != null ? ['group'] : ['id']);
      return buildUrlParams(updates, ['collection', 'topic', 'term', 'date', 'case', 'event', 'turn', 'file', 'highlight', 'sort', 'o', ...groupKeysToDrop]);
    }
    if (pagePath) {
      const u = new URL(location.href);
      u.search = '';
      u.searchParams.set('link', pagePath);
      u.search = u.search.replace(/%2F/gi, '/');
      return u;
    }
    return null;
  }

  function updateNavUrl() {
    const url = navUrl();
    if (url) navigate(url);
  }

  if (hasSubPages) {
    li.className = 'term-group';
    if (pagePath) li.dataset.link = pagePath;
    if (usesSourceScheme) {
      if (isTopLevelSource) li.dataset.sourceId = thisSourceId;
      else {
        li.dataset.groupIndex = String(groupIndex);
        if (thisGroupId != null) li.dataset.groupId = thisGroupId;
      }
    }
    li._openPage = openPage;

    const header = document.createElement('div');
    header.className = 'term-header';

    const tog = document.createElement('span');
    tog.className = 'term-toggle';
    tog.textContent = '▶︎';

    let label;
    if (usesSourceScheme || pagePath) {
      label = document.createElement('a');
      label.className = 'term-label';
      label.textContent = page.name;
      label.style.cursor = 'pointer';
      label.href = navUrl().toString();
    } else if (linkUrl) {
      label = document.createElement('a');
      label.className = 'term-label';
      label.textContent = page.name;
      label.style.cursor = 'pointer';
      label.href = linkUrl;
    } else {
      label = document.createElement('span');
      label.className = 'term-label';
      label.textContent = page.name;
    }

    header.appendChild(tog);
    header.appendChild(label);
    // Whether this item is the one currently reflected in the URL — i.e. open AND
    // selected, so a click anywhere on the row should close it rather than reselect.
    function isSelected() {
      const params = new URLSearchParams(location.search);
      if (usesSourceScheme) {
        if (params.get('source') !== thisSourceId) return false;
        if (isTopLevelSource) return !params.get('group') && !params.get('id');
        if (thisGroupId != null) return params.get('id') === thisGroupId;
        return (params.get('group') || null) === String(groupIndex);
      }
      if (pagePath) return params.get('link') === pagePath;
      return true; // no distinct URL identity — open implies selected
    }
    // Single handler: clicking the label always opens + loads (or closes if already
    // open+selected); clicking the toggle toggles. stopPropagation prevents the click
    // from bubbling up to a parent terms-header.
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      if ((pagePath || linkUrl) && label.contains(e.target)) {
        e.preventDefault(); // prevent anchor navigation; SPA handler manages routing
        if (li.classList.contains('open') && isSelected()) {
          li.classList.remove('open');
          return;
        }
        li.classList.add('open');
        updateNavUrl();
        openPage(); // openPage() also updates document.title
      } else if (tog.contains(e.target)) {
        li.classList.toggle('open');
        if (li.classList.contains('open')) setPageMeta(pageTitle);
      } else if (!li.classList.contains('open')) {
        li.classList.add('open');
        setPageMeta(pageTitle);
      } else if (isSelected()) {
        li.classList.remove('open');
      }
    });

    const ul = document.createElement('ul');
    ul.className = 'case-list';
    // Only pass sourceId one level deep — grandchildren of an id-having
    // source aren't addressable via ?group= (there's just the one slot).
    const childSourceId = isTopLevelSource ? thisSourceId : null;
    const childAncestorNames = [page.name, ...ancestorNames];
    page.groups.forEach((subPage, i) => {
      buildStaticPageItem(ul, subPage, childSourceId, i + 1, childAncestorNames);
    });

    li.appendChild(header);
    li.appendChild(ul);
  } else {
    // Leaf item (no subgroups) — use term-group/term-header/term-label so it inherits
    // the same font, weight, and muted color as collapsible section headers.
    // Also carry case-item so the .case-item[data-link] active-page selector still works.
    li.className = 'term-group case-item';
    if (pagePath) li.dataset.link = pagePath;
    if (usesSourceScheme) {
      if (isTopLevelSource) li.dataset.sourceId = thisSourceId;
      else {
        li.dataset.groupIndex = String(groupIndex);
        if (thisGroupId != null) li.dataset.groupId = thisGroupId;
      }
    }
    li._openPage = openPage;

    const header = document.createElement('div');
    header.className = 'term-header';

    let label;
    if (usesSourceScheme || pagePath || linkUrl) {
      label = document.createElement('a');
      label.className = 'term-label';
      label.textContent = page.name;
      label.href = (usesSourceScheme || pagePath) ? navUrl().toString() : linkUrl;
      label.addEventListener('click', (e) => { e.preventDefault(); updateNavUrl(); openPage(); });
    } else {
      label = document.createElement('span');
      label.className = 'term-label';
      label.textContent = page.name;
    }

    header.appendChild(label);
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
    // Show link page in the top third, document in the doc-viewer below
    // filling the bottom two-thirds.
    transcriptViewer.hidden = true;
    pageViewer.hidden = false;
    const pf = document.getElementById('page-viewer-frame');
    _frameNavigate(pf, linkUrl);
    transcriptViewer.classList.remove('no-audio');
    const target = Math.round(document.getElementById('main-panel').clientHeight * 2 / 3);
    docViewerOpenHeight = target;
    document.getElementById('doc-viewer').style.height = target + 'px';
  } else {
    // Document only: hide page-viewer, use no-audio trick so doc-viewer fills right pane.
    transcriptViewer.hidden = false;
    transcriptViewer.classList.add('no-audio');
    pageViewer.hidden = true;
    document.getElementById('page-viewer-frame').src = '';
  }

  showDocViewer({ href: documentUrl, title: groupName || '', view: 'pane' }, { autoScroll: false });
}

// Navigate the page-viewer iframe using location.replace() so that the iframe
// does not push its own entry into the joint session history.  Each logical
// navigation in the parent already owns one pushState entry; a separate iframe
// src-change entry causes the back button to show mismatched URL/content — and
// in Safari specifically, setting .src directly (rather than calling
// location.replace()) gets counted as its own joint-session-history entry even
// on the very first load, throwing off the Back button by one step for the
// rest of the session (see explorer.js history notes above navigate()).
// contentWindow is available synchronously for this iframe (present in the
// initial HTML, same-origin) even before any navigation, so location.replace()
// works from the very first call — pf.src is kept only as a last-resort
// fallback for the unexpected case where contentWindow isn't available at all.
// Directory-style permalinks (e.g. /collections/benches) get redirected by the
// server to add a trailing slash, so the iframe's post-load location never
// matches a freshly-built target href literally. Compare with trailing
// slashes stripped so re-requesting the same page is recognized as a no-op
// instead of triggering a needless (and visibly flickery) reload.
function _sameFrameLocation(a, b) {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

// ── Page-viewer iframe scroll restoration ───────────────────────────────────
// Every "pane" page rendered in the page-viewer iframe (courts/ussc/collections/*,
// blog posts, people profiles, etc.) is a fresh document load each time it's
// shown — there is no bfcache-style restore of an iframe's own scroll position,
// so navigating away and back (e.g. a benches-list row → a single bench → the
// Back button) always lands back at the top. This is a single generic fix for
// that, replacing the need for any page to carry its own sessionStorage hack
// (as courts/ussc/terms/index.md used to for its stats view).
// Keyed by the iframe's own URL (pathname+search): a URL with nothing saved
// yet (first visit this session) simply starts at the top as normal;
// returning to a URL already visited (by any means — Back, a "back to list"
// link, re-clicking the same nav item) restores wherever it was left.
//
// On a Back/Forward traversal that requires a full reload of the outer app
// (e.g. after a target="_top" link), the browser replays the iframe's own
// joint-session-history entry directly while parsing the fresh top-level
// document — often before our own script has even attached its 'load'
// listener to the (also brand new) iframe element, so that particular load
// is otherwise missed entirely. _restorePageFrameScroll is therefore also
// called eagerly, once, right after the listener is attached (see init()),
// covering the case where the iframe is already done loading by then.
const _PAGE_SCROLL_KEY_PREFIX = 'aa-page-scroll:';

function _pageScrollKey(href) {
  try {
    const u = new URL(href, location.href);
    return _PAGE_SCROLL_KEY_PREFIX + u.pathname + u.search;
  } catch { return null; }
}

function _savePageFrameScroll() {
  if (!pageViewer || pageViewer.hidden) return;
  const pf = document.getElementById('page-viewer-frame');
  try {
    const cw = pf?.contentWindow;
    if (!cw || cw.location.href === 'about:blank') return;
    const key = _pageScrollKey(cw.location.href);
    if (!key) return;
    const y = cw.scrollY || cw.document.documentElement.scrollTop || 0;
    if (y > 0) sessionStorage.setItem(key, String(y));
    else sessionStorage.removeItem(key);
  } catch { /* cross-origin or storage unavailable — ignore */ }
}

const _restoredPageFrameUrls = new Set(); // avoid re-running the retry loop for a URL already handled

function _restorePageFrameScroll(pf) {
  const cw = pf.contentWindow;
  if (!cw) return;
  let key, targetY;
  try {
    if (!cw.location.href || cw.location.href === 'about:blank') return;
    key = _pageScrollKey(cw.location.href);
    if (!key || _restoredPageFrameUrls.has(key)) return;
    targetY = parseInt(key && sessionStorage.getItem(key), 10) || 0;
  } catch { return; }
  if (targetY <= 0) return;
  _restoredPageFrameUrls.add(key);
  // Some pages (e.g. the term=all stats page, which lazily fetches and
  // renders each term's calendar as it scrolls into view) keep growing
  // taller for a bit after the iframe reports itself loaded, so the target
  // offset may not exist yet. Retry for up to ~1s, scrolling as far as
  // currently possible each time, until the document is tall enough.
  let attempts = 0;
  const tryScroll = () => {
    try {
      const doc = cw.document;
      const maxY = Math.max(0, (doc.documentElement.scrollHeight || 0) - cw.innerHeight);
      cw.scrollTo(0, Math.min(targetY, maxY));
      if (maxY >= targetY || ++attempts >= 10) return;
      setTimeout(tryScroll, 100);
    } catch { /* cross-origin or torn down — stop retrying */ }
  };
  tryScroll();
}

// Covers literal top-level navigations (e.g. a target="_top" link inside the
// iframe) — the whole app document is about to be torn down, so this is the
// only chance to persist the outgoing page's scroll position.
window.addEventListener('pagehide', _savePageFrameScroll);

function _frameNavigate(pf, url) {
  const targetHref = new URL(url, location.href).href;
  try {
    const cur = pf.contentWindow?.location.href;
    if (pf.contentWindow) {
      if (!cur || !_sameFrameLocation(cur, targetHref)) {
        if (cur && cur !== 'about:blank') _savePageFrameScroll(); // covers SPA-only navigation away (no full page reload)
        pf.contentWindow.location.replace(targetHref);
      }
      return;
    }
  } catch (e) {}
  if (!_sameFrameLocation(pf.src, targetHref)) pf.src = url;
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
  _frameNavigate(pf, url);
  // Mark the corresponding nav item active.
  document.querySelectorAll('.case-item.active').forEach(el => el.classList.remove('active', 'open'));
  document.querySelectorAll('.case-item.active-page').forEach(el => el.classList.remove('active-page'));
  const navItem = document.querySelector(`.case-item[data-link="${CSS.escape(url.split('?')[0])}"]`);
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

// Run `renderFn` (a DOM mutation, e.g. paginating a list by toggling many
// items' `hidden` state), then adjust #doc-browser's scroll position so that
// `anchorEl` — a DOM node reused across the mutation, typically the
// prev/next button just clicked — stays at the same on-screen spot.
// Hiding/revealing a page's worth of items shifts everything below/above
// them, which otherwise reads as the whole sidebar jumping (e.g. scrolling
// all the way back up to "Terms") even though only this list's layout changed.
function _preserveScrollAcrossRerender(anchorEl, renderFn) {
  const docBrowser = document.getElementById('doc-browser');
  const before = anchorEl.getBoundingClientRect().top;
  renderFn();
  if (docBrowser) {
    const after = anchorEl.getBoundingClientRect().top;
    docBrowser.scrollTop += (after - before);
  }
}

function buildCollectionItem(sectionUl, collEntry, isTopic = false) {
  // Group entry: contains sub-collections with no data file of their own.
  if (Array.isArray(collEntry.collections)) {
    const groupLi = document.createElement('li');
    groupLi.className = 'term-group';
    const groupHeader = document.createElement('div');
    groupHeader.className = 'term-header';
    const groupTog = document.createElement('span');
    groupTog.className = 'term-toggle';
    groupTog.textContent = '▶︎';
    const groupLabel = document.createElement('span');
    groupLabel.className = 'term-label';
    groupLabel.textContent = collEntry.name;
    groupHeader.appendChild(groupTog);
    groupHeader.appendChild(groupLabel);
    const groupUl = document.createElement('ul');
    groupUl.className = 'case-list';
    for (const child of collEntry.collections) {
      if (child.hidden) continue;
      buildCollectionItem(groupUl, child, isTopic);
    }
    groupHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      groupLi.classList.toggle('open');
    });
    groupLi.appendChild(groupHeader);
    groupLi.appendChild(groupUl);
    sectionUl.appendChild(groupLi);
    return;
  }

  // Link-only entry: no data file — just shows a linked page in the viewer.
  if (!collEntry.file && !collEntry.collection) {
    if (!collEntry.page) return;
    const collLi = document.createElement('li');
    collLi.className = 'term-group case-item';
    collLi.dataset.link = collEntry.page;
    const collHeader = document.createElement('div');
    collHeader.className = 'term-header';
    const collLabel = document.createElement('span');
    collLabel.className = 'term-label';
    collLabel.style.cursor = 'pointer';
    collLabel.textContent = collEntry.name;
    collHeader.appendChild(collLabel);
    collHeader.addEventListener('click', () => {
      setPageMeta(collEntry.name + ' | Argument Aloud');
      const url = buildUrlParams(
        { link: collEntry.page },
        ['collection', 'term', 'case', 'event', 'file', 'turn', 'group', 'id', 'highlight', 'sort', 'o'],
      );
      navigate(url);
      showPageViewer(collEntry.page, { pushState: false });
    });
    collLi.appendChild(collHeader);
    sectionUl.appendChild(collLi);
    return;
  }

  // Leaf entry: has a data file ('file' key; 'collection' supported for backward compat)
  const fileUrl = collEntry.file ?? collEntry.collection;
  const collId = collEntry.id || fileUrl.split('/').pop().replace('.json', '');
  const collLi = document.createElement('li');
  collLi.className = 'term-group';
  collLi.dataset.collectionUrl = fileUrl;
  collLi.dataset.collectionId = collId;

  const collHeader = document.createElement('div');
  collHeader.className = 'term-header';

  const collTog = document.createElement('span');
  collTog.className = 'term-toggle';
  collTog.textContent = '▶︎';

  const collLabel = document.createElement('span');
  collLabel.className = 'term-label';
  collLabel.textContent = collEntry.name;

  collHeader.appendChild(collTog);
  collHeader.appendChild(collLabel);
  if (collEntry.page) {
    collLabel.style.cursor = 'pointer';
    collLi.dataset.link = collEntry.page;
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
        // Merge extra properties (e.g. 'page') from collEntry.groups definitions into fetched groups.
        if (Array.isArray(collEntry.groups) && collEntry.groups.length) {
          const defs = new Map(collEntry.groups.map(g => [g.name, g]));
          groups = groups.map(g => {
            const def = defs.get(g.name);
            return def ? { ...def, ...g } : g;
          });
        }
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
        _populateCollectionGroups(collUl, groups, collEntry, collId, isTopic);
        _collAllGroups = Array.from(collUl.querySelectorAll(':scope > .month-group'));
        if (_collAllGroups.length > COLL_PAGE_SIZE) _renderCollPage();
      } catch (e) {
        console.warn('[collections] fetch failed:', fileUrl, e);
      }
    })();
    return _fetchPromise;
  }

  collLi._ensureBuilt = _ensureCollectionBuilt;
  _collRegistryById.set(collId, { collEntry, collUl, isTopic, ensureBuilt: _ensureCollectionBuilt });

  // ── Collection-level pagination ──────────────────────────────────────────
  // chunk:0 in the collection entry disables pagination (show all groups at once).
  // chunk:N uses N as the page size. Omitted or non-number defaults to 20.
  const COLL_PAGE_SIZE = (() => { const c = collEntry.chunk; return (typeof c === 'number') ? (c === 0 ? Infinity : c) : 20; })();
  const COLL_HALF_PAGE = COLL_PAGE_SIZE >> 1;
  const _collItemLabel = collEntry.scrollLabel || 'items';
  let _collPageStart = 0;
  let _collAllGroups = [];
  let _collSearchActive = false;

  const _collPrevSentinel = Object.assign(document.createElement('li'), { className: 'page-sentinel' });
  const _collPrevBtn = _collPrevSentinel.appendChild(document.createElement('button'));
  _collPrevBtn.className = 'page-sentinel-btn';
  _collPrevBtn.addEventListener('click', () => {
    _preserveScrollAcrossRerender(_collPrevBtn, () => {
      _collPageStart = Math.max(0, _collPageStart - COLL_PAGE_SIZE);
      _renderCollPage();
    });
  });

  const _collNextSentinel = Object.assign(document.createElement('li'), { className: 'page-sentinel' });
  const _collNextBtn = _collNextSentinel.appendChild(document.createElement('button'));
  _collNextBtn.className = 'page-sentinel-btn';
  _collNextBtn.addEventListener('click', () => {
    _preserveScrollAcrossRerender(_collNextBtn, () => {
      _collPageStart += COLL_PAGE_SIZE;
      _renderCollPage();
    });
  });

  function _renderCollPage() {
    if (_collAllGroups.length <= COLL_PAGE_SIZE || _collSearchActive) return;
    const pageEnd = _collPageStart + COLL_PAGE_SIZE;
    const prevCount = _collPageStart;
    const nextCount = Math.max(0, _collAllGroups.length - pageEnd);
    for (let i = 0; i < _collAllGroups.length; i++) {
      _collAllGroups[i].hidden = (i < _collPageStart || i >= pageEnd);
    }
    _collPrevSentinel.hidden = prevCount === 0;
    _collNextSentinel.hidden = nextCount === 0;
    if (prevCount > 0) {
      const show = Math.min(prevCount, COLL_PAGE_SIZE);
      _collPrevBtn.textContent = `(Previous ${show} ${_collItemLabel}...)`;
    }
    if (nextCount > 0) {
      const show = Math.min(nextCount, COLL_PAGE_SIZE);
      _collNextBtn.textContent = `(Next ${show} ${_collItemLabel}...)`;
    }
    collUl.replaceChildren(
      ...(_collPageStart > 0 ? [_collPrevSentinel] : []),
      ..._collAllGroups.slice(0, pageEnd),
      ...(nextCount > 0 ? [_collNextSentinel] : []),
      ..._collAllGroups.slice(pageEnd),
    );
  }

  collLi._centerOnGroup = (groupLi) => {
    const idx = _collAllGroups.indexOf(groupLi);
    if (idx < 0 || _collAllGroups.length <= COLL_PAGE_SIZE) return;
    _collPageStart = Math.max(0, Math.min(idx - COLL_HALF_PAGE, _collAllGroups.length - COLL_PAGE_SIZE));
    _renderCollPage();
  };

  let _onCollClose = null;
  const _navParamKey = isTopic ? 'topic' : 'collection';

  _wireAccordionHeader(collHeader, {
    tog: collTog,
    li: collLi,
    stopPropagation: true,
    isSelected: () => new URLSearchParams(location.search).get(_navParamKey) === collId,
    onClose: () => {
      _onCollClose?.();
      const url = buildUrlParams({}, ['collection', 'topic', 'term', 'case', 'event', 'file', 'turn', 'group', 'id', 'highlight', 'sort', 'o']);
      navigate(url);
    },
    onOpen: async () => {
      await _ensureCollectionBuilt();
      if (collEntry.page) showPageViewer(collEntry.page, { pushState: false });
      const url = buildUrlParams({ [_navParamKey]: collId }, ['term', 'case', 'event', 'file', 'turn', 'group', 'id', 'highlight', 'link', 'sort', 'o']);
      setPageMeta((collEntry.name || collId) + ' | Argument Aloud');
      navigate(url);
    },
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
        _collSearchActive = false;
        _groups.forEach(g => {
          g.style.display = '';
          g.classList.remove('open');
          if (_searchIsCompound) g.querySelectorAll('.case-item').forEach(ci => { ci.style.display = ''; });
        });
        _renderCollPage();
        return;
      }
      // Suspend collection-level pagination so all groups are accessible for filtering.
      if (_collAllGroups.length > COLL_PAGE_SIZE && !_collSearchActive) {
        _collSearchActive = true;
        _collAllGroups.forEach(g => { g.hidden = false; });
        _collPrevSentinel.hidden = true;
        _collNextSentinel.hidden = true;
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
        // Don't add 'open' — leave groups collapsed so one click expands them.
        _groups.forEach(g => {
          g.style.display = (g.dataset.searchText || '').includes(_ql) ? '' : 'none';
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

function _buildHighlightItem(highlight, highlightIdx, href = null, isTopic = false) {
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
      const collId  = collLi?.dataset.collectionId;
      const groupId = groupLi?.dataset.groupId ?? null;
      const groupIdx = groupLi?.dataset.groupIdx ?? null;
      const groupOrId = groupId != null ? { id: groupId } : (groupIdx != null ? { group: groupIdx } : {});
      const deleteOther = groupId != null ? ['group'] : ['id'];
      const url = buildUrlParams(
        { ...(collId ? { [isTopic ? 'topic' : 'collection']: collId } : {}), ...groupOrId, highlight: highlightIdx + 1 },
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
  _setFileSelectHidden(true);
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
  document.getElementById('case-info-row3').hidden = true;
  document.getElementById('case-info-row4').hidden = true;

  // Set title (plain text — no term link needed)
  const span = document.getElementById('case-title-label');
  span.innerHTML = '';
  const titleText = document.createElement('span');
  titleText.className = 'case-title-link';
  titleText.textContent = highlight.title;
  span.appendChild(titleText);

  setPageMeta(highlight.title + ' | Argument Aloud');
  setTopbarTerm('');

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
  _currentDecisionEntries   = [];
  _currentTranscriptEntries = [];

  await loadAudioEntry(syntheticArg, '/');

  if (isMobile()) {
    playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
    setMobileNavVisible(false);
  }
}

function _ordinal(n) {
  const mod100 = n % 100;
  const mod10  = n % 10;
  const suffix = (mod100 >= 11 && mod100 <= 13) ? 'th'
    : mod10 === 1 ? 'st'
    : mod10 === 2 ? 'nd'
    : mod10 === 3 ? 'rd'
    : 'th';
  return n + suffix;
}

function _buildCollectionCaseItem(caseRef, collId, groupNumber, groupId, isTopic = false, groupName = null, collEntry = null) {
  const caseKey = caseRef.term + '/' + caseRef.number;
  // caseRef.find, when present, names the word/phrase to highlight on arrival
  // (see rare_words.json). It's omitted from the JSON when it's just the
  // group's own name repeated on every case, so fall back to that — but only
  // for Rarest Spoken Words groups; other collections' group.name is a
  // justice/advocate name that was never actually searched for.
  const _find = caseRef.find ?? (collId === 'rare_words' ? groupName : null);

  // ── Shell: <li>, header (toggle + title), file <ul> ──
  const _ciGroupOrId = groupId != null ? { id: groupId } : { group: groupNumber };
  const _ciDeleteOther = groupId != null ? 'group' : 'id';
  const _baseTitle = caseTitle(caseRef.title);
  const { ci, header, toggle, titleSpan, fileUl } = _buildCaseItemShell({
    caseKey,
    title:     caseRef.appearance != null ? _baseTitle + ' (' + _ordinal(caseRef.appearance) + ')' : _baseTitle,
    tooltip:   argumentTooltip(caseRef.term, caseRef),
    // When a specific event index is stored, use it as the sole disambiguator
    // so the audioDate filter in loadCase doesn't block activation. Fall back
    // to the first argument/reargument date only when no event index is set.
    eventIdx:  (Number.isInteger(caseRef.event) && caseRef.event >= 1) ? caseRef.event : null,
    audioDate: (Number.isInteger(caseRef.event) && caseRef.event >= 1) ? null
      : (typeof caseRef.argument === 'string' && caseRef.argument)
        ? caseRef.argument.split(',')[0].trim()
        : (typeof caseRef.reargument === 'string' && caseRef.reargument)
          ? caseRef.reargument.split(',')[0].trim()
          : null,
    hasFiles:  !!caseRef.files,
    href:      buildUrlParams(
      { [isTopic ? 'topic' : 'collection']: collId, ..._ciGroupOrId, term: caseRef.term, case: caseRef.number },
      [_ciDeleteOther, 'highlight', 'event', 'file', 'turn'],
    ),
  });

  ci.dataset.argued  = _firstArgDate(caseRef);
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

  // ── Scales icon: shown if audio or decision; clickable iff decision ──
  let _scalesIconNode = null;
  const _scalesOnClick = caseRef.decision ? async (e) => {
    e.stopPropagation();
    // Synchronous selection feedback before any async fetch.
    if (!ci.classList.contains('active')) markCaseItemActive(ci);
    const caseEntry = await _fetchCaseEntry();
    const _firstDE = _buildPrimaryDecisionEntry(caseEntry);
    if (!_firstDE) return;
    const opinionFile = { href: _firstDE.href, title: _firstDE.title };
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
  if (caseRef.event || caseRef.decision || caseRef.files) {
    // Green ring (lowest priority — see makeScalesRingSvg) as a best-effort
    // guess from the lightweight caseRef alone; the deferred upgrade below
    // corrects it once the full caseEntry (with opCite) is fetched.
    _scalesIconNode = _attachScalesIcon(ci, header, {
      onClick: _scalesOnClick,
      ring: caseRef.files ? { green: true } : null,
    });
  }

  // Deferred icon upgrade — called the first time this item becomes visible.
  // Avoids fetching cases.json for off-screen paginated items.
  let _iconsUpgraded = false;
  ci._upgradeIcons = () => {
    if (_iconsUpgraded) return;
    _iconsUpgraded = true;
    if (caseRef.event) {
      _fetchCaseEntry().then(caseEntry => {
        if (!caseEntry) return;
        const ring    = oyezCircleData(caseEntry);
        const deficit = oyezDeficitClass(caseEntry);
        if (!ring && !deficit) return;
        const nextSibling = _audioIconNode ? _audioIconNode.nextSibling : null;
        if (_audioIconNode && _audioIconNode.parentNode === header) header.removeChild(_audioIconNode);
        _audioIconNode = _attachAudioIcon(header, {
          hasAudio:      true,
          hasTranscript: !!caseRef.transcript,
          ring,
          deficit,
        });
        if (_audioIconNode && nextSibling && nextSibling.parentNode === header) {
          header.insertBefore(_audioIconNode, nextSibling);
        }
      }).catch(() => { /* ignore */ });
    }
    if (caseRef.decision || caseRef.event || caseRef.files) {
      _fetchCaseEntry().then(caseEntry => {
        if (!caseEntry) return;
        const hasFiles = !!caseEntry.files || !!caseEntry.opCite?.length || (caseEntry.title || '').includes('|');
        // Green ring is the lowest-priority signal — only drawn when there's
        // no opinion-audio/video ring to show instead (see makeScalesRingSvg).
        const ring = opinionCircleData(caseEntry) || (hasFiles ? { green: true } : null);
        if (!ring) return;
        if (_scalesIconNode?.parentNode === header) header.removeChild(_scalesIconNode);
        _scalesIconNode = _attachScalesIcon(ci, header, { onClick: _scalesOnClick, ring });
      }).catch(() => { /* ignore */ });
    }
  };

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
        const ALL_CATS = ['Petitioner', 'Respondent', 'Amicus', 'Briefs', 'References', 'Media', 'Other'];
        const activeCats = ALL_CATS;
        const activeCatSet = new Set(activeCats);

        // Map a file to the best available active category label.
        const _COLL_SEM_KEYS = new Set(['petitioner','respondent','amicus','reference','media','other','brief','briefs']);
        function resolveCategory(f) {
          // Prefer the explicit group property when it carries a known semantic key.
          let sem = (f.group || '').toLowerCase();
          if (!_COLL_SEM_KEYS.has(sem)) {
            // Fallback for synthetic entries (virtual transcripts, injected opinions) without a group.
            sem = (f.type || '').toLowerCase();
            if (sem === 'appellant' || sem === 'appellants' || sem === 'plaintiff' || sem === 'plaintiffs' || sem === 'complainant' || sem === 'complainants') sem = 'petitioner';
            else if (sem === 'appellee' || sem === 'appellees' || sem === 'defendant' || sem === 'defendants') sem = 'respondent';
            if (!_COLL_SEM_KEYS.has(sem)) sem = 'other';
          }
          const prefs = {
            petitioner: ['Petitioner', 'Briefs', 'Other'],
            respondent: ['Respondent', 'Briefs', 'Other'],
            amicus:     ['Amicus', 'Briefs', 'Other'],
            reference:  ['References', 'Other'],
            media:      ['Media', 'Other'],
            brief:      ['Briefs', 'Other'],
            briefs:     ['Briefs', 'Other'],
            other:      ['Other'],
          };
          const candidates = prefs[sem] || ['Other'];
          for (const c of candidates) {
            if (activeCatSet.has(c)) return c;
          }
          return activeCats[0];
        }

        // Each transcript ("Oral Argument on ..."), decision ("Decision on
        // ..."), and relating-to-orders statement ("Statement in ...") gets
        // pulled out into its own "Records" group instead of being
        // categorized below — arguments first (chronological), decisions/
        // statements last — appended as the very last group of all, after
        // Citations/Consolidations/References.
        const byDate = (a, b) => (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : 0;
        const _isRecordsType = (t) => t === 'transcript' || t === 'opinion' || t === 'statement';
        const recordsFiles = [
          ...rawFiles.filter(f => (f.type || '').toLowerCase() === 'transcript').sort(byDate),
          ...rawFiles.filter(f => { const t = (f.type || '').toLowerCase(); return t === 'opinion' || t === 'statement'; }),
        ];

        const groups = {};
        let totalFiles = 0;
        rawFiles.forEach(f => {
          const fType = (f.type || '').toLowerCase();
          if (_isRecordsType(fType)) return;
          totalFiles++;
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
            groups[label].sort(byDate);
          }
        });

        const effectiveOrder = ALL_CATS.filter(c => activeCatSet.has(c));
        // Suppress the group subheading when there is only one non-empty
        // category — listing files directly avoids forcing the user to expand
        // a useless group of one.
        const nonEmptyGroupKeys = effectiveOrder.filter(k => groups[k]?.length > 0);
        const suppressHeader = totalFiles === 1 || nonEmptyGroupKeys.length === 1;

        const entries = [];
        effectiveOrder.filter(c => c !== 'References').forEach(typeKey => {
          if (!groups[typeKey] || !groups[typeKey].length) return;
          entries.push({
            kind: suppressHeader && typeKey !== 'Media' && typeKey !== 'Other' ? 'flat' : 'group',
            label: typeKey,
            files: groups[typeKey],
          });
        });
        // Citations, Consolidations, and References come next (in that
        // order), then Records is always the very last group of all.
        const citationsEntry = _buildCitationsEntry(caseEntry);
        if (citationsEntry) entries.push(citationsEntry);
        const otherTitlesEntry = _buildOtherTitlesEntry(caseEntry, caseRef.term);
        if (otherTitlesEntry) entries.push(otherTitlesEntry);
        if (groups.References?.length) {
          entries.push({ kind: 'group', label: 'References', files: groups.References });
        }
        if (recordsFiles.length) entries.push({ kind: 'group', label: 'Records', files: recordsFiles });

        return { entries };
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
    const numberOverride = e.numberOverride ?? null;
    // Gallery-style collections (e.g. Original Jurisdiction) show their cases
    // as a single hand-built page rather than the normal case viewer — clicking
    // a case here just scrolls that page to the matching "<term>--<number>" id
    // instead of loading the case. See courts/ussc/collections/orig/index.md.
    if (collEntry?.scrollToPage && collEntry.page) {
      markCaseItemActive(ci);
      if (!fromRestore) {
        const groupOrId = groupId != null ? { id: groupId } : { group: groupNumber };
        const deleteOther = groupId != null ? ['group'] : ['id'];
        const url = buildUrlParams(
          { [isTopic ? 'topic' : 'collection']: collId, ...groupOrId, term: caseRef.term, case: caseRef.number },
          [...deleteOther, 'highlight', 'event', 'file', 'turn', 'citation'],
        );
        setPageMeta(caseTitle(caseRef.title) + ' | Argument Aloud');
        navigate(url);
      }
      const anchorId = caseRef.term + '--' + caseRef.number.split(',')[0].trim();
      // Directory-style permalinks (e.g. /collections/orig) 301-redirect to add
      // a trailing slash. Without it here, every click would force the iframe
      // through a full server round-trip + reload instead of a same-document
      // fragment jump — a visible flash back to the top before landing on the
      // right anchor. Ensuring the slash up front keeps this a lightweight
      // in-page navigation, matching _sameFrameLocation's own normalization.
      const pageUrl = collEntry.page.replace(/\/?$/, '/');
      showPageViewer(pageUrl + '#' + anchorId, { pushState: false });
      return;
    }
    if (!fromRestore && ci.classList.contains('active')) {
      // Already the selected case — clicking the title just toggles its file list open/closed.
      if (ci.classList.toggle('open')) {
        const caseEntry = await _fetchCaseEntry();
        if (caseEntry) await ensureCollFileListBuilt(caseEntry);
      }
      return;
    }
    // Synchronous selection feedback before any async fetch.
    if (!fromRestore) markCaseItemActive(ci);
    const caseEntry = await _fetchCaseEntry();
    if (!caseEntry) {
      console.warn('[collections] case not found in cases.json:', caseRef);
      return;
    }
    // caseRef.event is a 1-based index into caseEntry.events (original order).
    const defaultAudioIdx = Number.isInteger(caseRef.event) && caseRef.event >= 1 ? caseRef.event : 0;
    const defaultTurn     = Number.isInteger(caseRef.turn)  && caseRef.turn  >= 1 ? caseRef.turn  : null;
    let audioIdx;
    let initialTurn;
    if (fromRestore) {
      audioIdx    = Number.isInteger(e.audioIdx) ? e.audioIdx : defaultAudioIdx;
      initialTurn = (Number.isInteger(e.initialTurn) && e.initialTurn > 0) ? e.initialTurn : defaultTurn;
    } else {
      const saved = _caseSessionState.get(caseRef.term + '/' + caseId(caseEntry));
      // A collection item with a stored event always loads that event; session
      // state only fills in when no specific event was saved in the item.
      audioIdx    = (defaultAudioIdx >= 1) ? defaultAudioIdx : (saved?.eventIdx >= 1 ? saved.eventIdx : 0);
      initialTurn = defaultTurn ?? (saved ? (saved.turnNum ?? null) : null);
    }

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
    if (!fromRestore) {
      const groupOrId = groupId != null ? { id: groupId } : { group: groupNumber };
      const deleteOther = groupId != null ? ['group'] : ['id'];
      const url = buildUrlParams(
        {
          [isTopic ? 'topic' : 'collection']: collId,
          ...groupOrId,
          term: caseRef.term,
          case: caseRef.number,
          ...(audioIdx > 0 ? { event: audioIdx } : {}),
          ...(initialTurn ? { turn: initialTurn } : {}),
          ...(_find ? { find: _find } : {}),
        },
        [...deleteOther, 'highlight', ...(audioIdx === 0 ? ['event'] : []), 'file', 'citation', ...(initialTurn ? [] : ['turn'])],
      );
      setPageMeta(caseTitle(caseEntry.title) + ' | Argument Aloud');
      navigate(url);
    }
    await loadCase(caseRef.term, caseEntry, audioIdx, { forceNoAudio: !hasPlayableAudio, initialTurn, numberOverride });
    if (fromRestore) trackPageView(location.href);
    if (!fromRestore && hasPlayableAudio && hasDecisionHref(caseEntry) &&
        ci.closest('ul')?.dataset.sortMode === 'decided') {
      const de = _buildPrimaryDecisionEntry(caseEntry);
      if (de) showDocViewer({ href: de.href, title: de.title }, { autoScroll: true });
    }
    // For no-audio cases, transcriptloaded never fires; restore file selection here.
    // Use !hasPlayableAudio rather than !events?.length so cases with transcript-only
    // events (no audio_href) are also covered.
    const fileRestore = e.fileRestore ?? null;
    if (fileRestore != null && !hasPlayableAudio && !_showDecisionFromParam(fileRestore) && !_showJournalFromParam(fileRestore) && !_showMinutesFromParam(fileRestore) && !_showHistoryFromParam(fileRestore)) {
      const fileEl = findFileItem(fileRestore);
      if (fileEl) {
        fileEl.closest('.file-type-group')?.classList.add('open');
        fileEl.click();
      }
    }
    const citationRestore = e.citationRestore ?? null;
    if (citationRestore != null && !hasPlayableAudio) {
      const citeEl = findCitationItem(citationRestore);
      if (citeEl) {
        citeEl.closest('.file-type-group')?.classList.add('open');
        citeEl.querySelector('.citation-title')?.click();
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

// A group whose "name" is itself a case (e.g. Top Cited Opinions) carries a
// "link" ("/courts/ussc/?term=...&case=...") pointing at that case. Opening
// the group shows the case itself in the main pane — same content a direct
// term/case URL would show — without changing the collection/group URL; the
// user can still click through to view the case in the context of its own
// term from there.
async function _loadCaseFromGroupLink(link) {
  const params = new URL(link, location.origin).searchParams;
  const linkTerm = params.get('term');
  const linkCase = params.get('case');
  if (!linkTerm || !linkCase) return;
  const cases = await fetchTermCases(linkTerm);
  const caseEntry = cases.find(c => c.number === linkCase ||
    (c.number && c.number.split(',').map(n => n.trim()).includes(linkCase)) ||
    (!c.number && c.id === linkCase));
  if (!caseEntry) return;
  const hasPlayableAudio = (caseEntry.events || []).some(a => a.audio_href);
  await loadCase(linkTerm, caseEntry, 0, { forceNoAudio: !hasPlayableAudio });
}

// Parse the primary (first) "key:direction" segment of a collection/topic
// "order" spec into a { mode, asc } pair for the interactive sort-mode system
// (_GROUP_SORT_OPTIONS / _applyGroupSortMode). The spec may be a compound,
// comma-separated list (e.g. "argument:ascending,titles:ascending") — see
// scripts/update_cases.js's _parseOrderSpec, which is what actually applies
// every rule when generating the file. The client only needs the primary key:
// as long as the file itself is pre-sorted with the same tie-break, ties are
// preserved automatically because Array.prototype.sort is stable. "titles"
// (plus legacy aliases "title"/"cases") maps to the built-in "cases" sort
// mode (alphabetical by title); "argument"/"decision" (the case fields
// collections.json/topics.json should name) map to the "argued"/"decided"
// sort modes, whose labels match the UI's user-facing "Argued"/"Decided"
// sort options.
function _parseOrderModeSpec(orderSpec) {
  const first = String(orderSpec || '').split(',')[0];
  const [rawKey, rawDir] = first.split(':').map(s => (s || '').trim().toLowerCase());
  let mode = rawKey || 'none';
  if (mode === 'title' || mode === 'titles') mode = 'cases';
  else if (mode === 'argument') mode = 'argued';
  else if (mode === 'decision') mode = 'decided';
  return { mode, asc: rawDir !== 'descending' };
}

function _populateCollectionGroups(collUl, groups, collEntry, collId, isTopic = false) {
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
    const { mode, asc } = _parseOrderModeSpec(collEntry.order);
    _defaultSortMode = mode;
    _defaultSortAsc  = asc;
  }

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const groupNumber = groupIdx + 1; // 1-based index within the collection
    // Each group (e.g. "Abe Fortas") — styled like a month group
    const groupLi = document.createElement('li');
    groupLi.className = 'month-group';
    groupLi.dataset.groupIdx = String(groupNumber);
    if (group.id != null) { groupLi.dataset.groupId = group.id; groupLi.id = group.id; }

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
    groupTog.textContent = '▶︎';

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
    // Link-only groups (cases explicitly empty) have nothing to expand \u2014 hide chrome.
    const _linkOnly = Array.isArray(group.cases) && group.cases.length === 0 && !hoursLabel;
    if (_linkOnly) {
      groupTog.hidden = true;
      groupCount.hidden = true;
    } else {
      groupCount.textContent = hoursLabel || (n + '\u00a0Cases');
    }

    groupHeader.appendChild(groupTog);
    groupHeader.appendChild(groupName);
    groupHeader.appendChild(groupCount);

    const groupUl = document.createElement('ul');
    groupUl.className = 'month-case-list';

    let _groupSortMode = _defaultSortMode;
    let _groupSortAsc  = _defaultSortAsc;
    if (group.order) {
      const { mode, asc } = _parseOrderModeSpec(group.order);
      _groupSortMode = mode;
      _groupSortAsc  = asc;
    }
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
    // Set by the "All cases" link; reset whenever the group is closed (see
    // onClose below) so reopening it always starts back in paginated form.
    let _showAll = false;

    const prevSentinel = Object.assign(document.createElement('li'), { className: 'page-sentinel' });
    const prevBtn = prevSentinel.appendChild(document.createElement('button'));
    prevBtn.className = 'page-sentinel-btn';
    prevBtn.addEventListener('click', () => {
      _preserveScrollAcrossRerender(prevBtn, () => {
        _pageStart = Math.max(0, _pageStart - PAGE_SIZE);
        _renderGroupPage();
      });
    });
    prevSentinel.appendChild(Object.assign(document.createElement('span'), { className: 'page-sentinel-or', textContent: 'or' }));
    const prevAllBtn = prevSentinel.appendChild(document.createElement('button'));
    prevAllBtn.className = 'page-sentinel-btn';
    prevAllBtn.textContent = 'All cases)';
    prevAllBtn.addEventListener('click', () => {
      _preserveScrollAcrossRerender(prevAllBtn, () => {
        _showAll = true;
        _renderGroupPage();
      });
    });

    const nextSentinel = Object.assign(document.createElement('li'), { className: 'page-sentinel' });
    const nextBtn = nextSentinel.appendChild(document.createElement('button'));
    nextBtn.className = 'page-sentinel-btn';
    nextBtn.addEventListener('click', () => {
      _preserveScrollAcrossRerender(nextBtn, () => {
        _pageStart += PAGE_SIZE;
        _renderGroupPage();
      });
    });
    nextSentinel.appendChild(Object.assign(document.createElement('span'), { className: 'page-sentinel-or', textContent: 'or' }));
    const nextAllBtn = nextSentinel.appendChild(document.createElement('button'));
    nextAllBtn.className = 'page-sentinel-btn';
    nextAllBtn.textContent = 'All cases)';
    nextAllBtn.addEventListener('click', () => {
      _preserveScrollAcrossRerender(nextAllBtn, () => {
        _showAll = true;
        _renderGroupPage();
      });
    });

    function _renderGroupPage() {
      if (_showAll) {
        for (const item of _sortedItems) {
          item.hidden = false;
          item._upgradeIcons?.();
        }
        prevSentinel.hidden = true;
        nextSentinel.hidden = true;
        groupUl.replaceChildren(..._highlights, ..._sortedItems);
        return;
      }
      const pageEnd = _pageStart + PAGE_SIZE;
      const prevCount = _pageStart;
      const nextCount = Math.max(0, _sortedItems.length - pageEnd);
      for (let i = 0; i < _sortedItems.length; i++) {
        const item = _sortedItems[i];
        const visible = (i >= _pageStart && i < pageEnd);
        item.hidden = !visible;
        if (visible) item._upgradeIcons?.();
      }
      prevSentinel.hidden = prevCount === 0;
      nextSentinel.hidden = nextCount === 0;
      if (prevCount > 0) {
        const show = Math.min(prevCount, PAGE_SIZE);
        prevBtn.textContent = `(Previous ${show} case${show !== 1 ? 's' : ''}`;
      }
      if (nextCount > 0) {
        const show = Math.min(nextCount, PAGE_SIZE);
        nextBtn.textContent = `(Next ${show} case${show !== 1 ? 's' : ''}`;
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
          if (av !== bv) return av < bv ? -1 : 1;
          if (mode === 'decided') return (a.dataset.argued || '').localeCompare(b.dataset.argued || '');
          return 0;
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
      groupUl.dataset.sortMode = mode;
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
          history.replaceState(null, '', buildUrlParams({ sort: _groupSortMode, o: _groupSortAsc ? 'a' : 'd' }, []));
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
    let _groupPage = group.page ?? group.details?.page ?? null;
    let _groupDocument = group.details?.web ?? null;
    groupLi._groupPage = _groupPage;
    groupLi._groupDocument = _groupDocument;
    groupLi._groupLink = group.link ?? null;
    const _ensureGroupCases = async () => {
      if (_casesLoaded) return;
      _casesLoaded = true;
      if (Array.isArray(group.cases)) {
        // Embedded format: build case items from the in-memory array.
        const seenKeys = new Set();
        for (const caseRef of group.cases) {
          seenKeys.add(caseRef.term + '/' + caseRef.number);
          groupUl.appendChild(_buildCollectionCaseItem(caseRef, collId, groupNumber, group.id, isTopic, group.name, collEntry));
        }
        // Reconcile with localStorage tags: a case that only qualifies for this
        // group because of a user-added tag won't be in the server-generated
        // file yet — add it here so it appears without a full rebuild.
        const localMatches = await _localTagMatchesForGroup(collEntry, group);
        for (const caseRef of localMatches) {
          const key = caseRef.term + '/' + caseRef.number;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          groupUl.appendChild(_buildCollectionCaseItem(caseRef, collId, groupNumber, group.id, isTopic, group.name, collEntry));
        }
        n = seenKeys.size;
        _applyGroupSortMode(_groupSortMode, _groupSortAsc);
      } else if (group.id) {
        // Split format: fetch the per-group JSON file.
        try {
          const r = await fetch(splitBase + group.id + '.json', { cache: 'reload' });
          if (r.ok) {
            const advocateData = await r.json();
            const highlights = Array.isArray(advocateData) ? [] : (advocateData.highlights || []);
            const advocateCases = Array.isArray(advocateData) ? advocateData : (advocateData.cases || []);
            _groupPage = Array.isArray(advocateData) ? null : (advocateData.details?.page ?? null);
            _groupDocument = Array.isArray(advocateData) ? null : (advocateData.details?.web ?? null);
            groupLi._groupPage = _groupPage;
            groupLi._groupDocument = _groupDocument;
            for (const [hlIdx, hl] of highlights.entries()) {
              const _hlGroupId = group.id ?? null;
              const _hlGroupOrId = _hlGroupId != null ? { id: _hlGroupId } : { group: groupNumber };
              const _hlDeleteOther = _hlGroupId != null ? 'group' : 'id';
              const hlHref = buildUrlParams(
                { [isTopic ? 'topic' : 'collection']: collId, ..._hlGroupOrId, highlight: hlIdx + 1 },
                [_hlDeleteOther, 'term', 'case', 'event', 'file', 'turn'],
              );
              groupUl.appendChild(_buildHighlightItem(hl, hlIdx, hlHref, isTopic));
            }
            // If the collection restricts to a minimum term, filter cases and
            // renumber appearances starting from 1 for the earliest qualifying argument.
            let _cases = advocateCases;
            if (collEntry.minTerm) {
              const sorted = advocateCases
                .filter(c => (c.term || '') >= collEntry.minTerm)
                .sort((a, b) => (a.argument || a.reargument || '') < (b.argument || b.reargument || '') ? -1 : 1);
              _cases = sorted.map((c, i) => ({ ...c, appearance: i + 1 }));
            }
            for (const caseRef of _cases) {
              groupUl.appendChild(_buildCollectionCaseItem(caseRef, collId, groupNumber, group.id, isTopic, group.name, collEntry));
            }
            n = _cases.length;
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
    groupLi._applySortParam = (mode, asc) => {
      _groupSortMode = mode;
      _groupSortAsc  = asc;
      groupCount.textContent = _groupSortModeLabel(_groupSortMode, _groupSortAsc);
      groupCount.classList.add('sort-active');
      _applyGroupSortMode(_groupSortMode, _groupSortAsc);
    };
    groupLi._centerOnItem = (item) => {
      const idx = _sortedItems.indexOf(item);
      if (idx < 0) return;
      _pageStart = Math.max(0, Math.min(idx - HALF_PAGE, Math.max(0, _sortedItems.length - PAGE_SIZE)));
      _renderGroupPage();
    };
    // Inject a case that newly qualifies for this group because of a
    // just-added local tag (see _injectLocalTagIntoLoadedGroups). If the
    // group hasn't been expanded yet, stash it in the in-memory cases array
    // so it's picked up normally the first time it is.
    groupLi._addLocalCase = (caseRef) => {
      const key = caseRef.term + '/' + caseRef.number;
      if (!_casesLoaded) {
        if (Array.isArray(group.cases) && !group.cases.some(c => (c.term + '/' + c.number) === key)) {
          group.cases.push(caseRef);
          n = group.cases.length;
          if (!groupCount.hidden) groupCount.textContent = hoursLabel || (n + ' Cases');
        }
        return;
      }
      if (groupUl.querySelector(`.case-item[data-case-key="${CSS.escape(key)}"]`)) return;
      groupUl.appendChild(_buildCollectionCaseItem(caseRef, collId, groupNumber, group.id, isTopic, group.name, collEntry));
      n++;
      _applyGroupSortMode(_groupSortMode, _groupSortAsc);
      groupCount.textContent = groupCount.classList.contains('sort-active')
        ? _groupSortModeLabel(_groupSortMode, _groupSortAsc)
        : (hoursLabel || (n + ' Cases'));
    };
    // Mirror of _addLocalCase: drop a case that no longer qualifies for this
    // group because a local tag it depended on was just removed (see
    // _removeLocalTagFromLoadedGroups). Re-checks qualification first so a
    // case that's genuinely in the server-generated file (or still qualifies
    // via some other remaining tag) is never incorrectly removed.
    groupLi._removeLocalCaseIfUnqualified = async (term, number) => {
      const key = term + '/' + number;
      if (!_casesLoaded) {
        if (!Array.isArray(group.cases)) return;
        const idx = group.cases.findIndex(c => (c.term + '/' + c.number) === key);
        if (idx < 0 || await _caseQualifiesForGroup(collEntry, group, term, number)) return;
        group.cases.splice(idx, 1);
        n = group.cases.length;
        if (!groupCount.hidden) groupCount.textContent = hoursLabel || (n + ' Cases');
        return;
      }
      const item = groupUl.querySelector(`.case-item[data-case-key="${CSS.escape(key)}"]`);
      if (!item || await _caseQualifiesForGroup(collEntry, group, term, number)) return;
      item.remove();
      n = Math.max(0, n - 1);
      _applyGroupSortMode(_groupSortMode, _groupSortAsc);
      groupCount.textContent = groupCount.classList.contains('sort-active')
        ? _groupSortModeLabel(_groupSortMode, _groupSortAsc)
        : (hoursLabel || (n + ' Cases'));
    };

    _wireAccordionHeader(groupHeader, {
      tog: groupTog,
      li: groupLi,
      isSelected: () => {
        const params = new URLSearchParams(location.search);
        if (params.get(isTopic ? 'topic' : 'collection') !== collId) return false;
        return group.id != null ? params.get('id') === String(group.id) : params.get('group') === String(groupNumber);
      },
      onClose: () => {
        groupCount.classList.remove('sort-active');
        groupCount.textContent = hoursLabel || (n + '\u00a0Cases');
        // Closing only hides groupUl via CSS — its contents persist until
        // re-rendered, so reset back to paginated form now (not just the
        // flag) or reopening would still show the stale "all cases" markup.
        if (_showAll) {
          _showAll = false;
          _pageStart = 0;
          _renderGroupPage();
        }
      },
      onOpen: async () => {
        groupCount.classList.add('sort-active');
        groupCount.textContent = _groupSortModeLabel(_groupSortMode, _groupSortAsc);
        const groupOrId = group.id != null ? { id: group.id } : { group: groupNumber };
        const deleteOther = group.id != null ? ['group'] : ['id'];
        // Always reflect the group's current sort in the URL: include sort+o when non-default,
        // delete them when back to default. This keeps the URL accurate even when returning to
        // a group whose closure already holds a customised sort from a previous visit.
        const _nonDefaultSort = _groupSortMode !== _defaultSortMode || _groupSortAsc !== _defaultSortAsc;
        const url = buildUrlParams(
          { [isTopic ? 'topic' : 'collection']: collId, ...groupOrId, ...(_nonDefaultSort ? { sort: _groupSortMode, o: _groupSortAsc ? 'a' : 'd' } : {}) },
          [...deleteOther, 'highlight', 'term', 'case', 'event', 'file', 'turn', ...(_nonDefaultSort ? [] : ['sort', 'o'])],
        );
        history.replaceState(null, '', url);
        await _ensureGroupCases();
        setPageMeta(formatSpeakerFull(group.name || '') + ' | Argument Aloud');
        trackPageView(location.href);
        if (_groupPage && _groupDocument) showAdvocateDocument(_groupDocument, _groupPage, group.name || '');
        else if (_groupPage) showPageViewer(_groupPage, { pushState: false });
        else if (_groupDocument) showAdvocateDocument(_groupDocument, null, group.name || '');
        else if (group.link) await _loadCaseFromGroupLink(group.link);
        // The group itself has no page/document (e.g. a single-group collection
        // like Original Jurisdiction's "Archive") — fall back to the collection's
        // own page so the page-viewer isn't left blank. For Rarest Spoken Words,
        // point it at the matching word's <li id="rare-word-..."> so the page on
        // the right scrolls to (and highlights) the word selected on the left.
        else if (collEntry.page) {
          const _pageUrl = collId === 'rare_words' && group.name
            ? collEntry.page + '#rare-word-' + encodeURIComponent(group.name)
            : collEntry.page;
          showPageViewer(_pageUrl, { pushState: false });
        }
      },
    });

    groupLi.appendChild(groupHeader);
    groupLi.appendChild(groupUl);
    collUl.appendChild(groupLi);
  }
}

// ── Load a case ─────────────────────────────────────────────────────────────

// If `arg` has no text_href, borrow one from another event in `events` that
// shares the same date and type (e.g. a NARA audio entry paired with a USSC
// transcript-only entry for the same argument date). Aligned transcripts are
// not borrowed — they are specific to their own audio source.
function withTranscriptFallback(arg, events) {
  if (arg.text_href || !events?.length) return arg;
  const donor = events.find(e => e !== arg && e.date === arg.date && e.type === arg.type && e.text_href && !e.aligned);
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
    // Check alignment before applying any offset: an unaligned transcript whose
    // event has an offset should not be mistaken for an aligned one.
    const hasRelativeTimes = turnTimes.some(t => t > 0);
    if (arg.offset) {
      const offsetSecs = parseTime(arg.offset);
      turnTimes = turnTimes.map(t => t + offsetSecs);
    }

    // Always prefer the event's audio_href; fall back to media.url in the
    // transcript envelope only when the event has no audio_href of its own.
    const resolvedAudioUrl = audioUrl || (isEnvelope && transcriptData.media?.url) || null;
    if (resolvedAudioUrl) {
      audio.src = resolvedAudioUrl;
    } else {
      audio.removeAttribute('src');
    }
    audio.load();

    // Seek to the right position after metadata is ready. A specific turn takes
    // priority over a bare offset seek since turnTimes already includes the offset.
    if (Number.isInteger(arg.turn) && arg.turn > 0 && arg.turn <= turnTimes.length) {
      // Add a tiny epsilon so audio.currentTime lands above the turn boundary
      // after the browser quantizes the seek, ensuring findCurrentTurn returns
      // the correct turn on the first timeupdate.
      seekOnly(turnTimes[arg.turn - 1] + 0.01);
      _suppressTimeupdateBeforeSeek = true;
    } else if (arg.offset) {
      seekOnly(parseTime(arg.offset));
    }

    const unalignedNote = document.getElementById('unaligned-note');
    // Only treat as time-aligned if at least one turn has a non-zero timestamp.
    // All-zero timestamps (e.g. Oyez data where alignment failed) should be
    // treated as unaligned to avoid scrolling to the last turn on timeupdate.
    hasTimes = hasRelativeTimes;
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
    _updateEditModeMenu();
    const docPanel = document.getElementById('doc-viewer');
    if (!docPanel.hidden && !docPanel.classList.contains('collapsed')) {
      collapseDocViewer();
    }
    activeBottomLinkText = null;
    _docViewerAutoOpenSuppressed = false;

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

// Resolve a "{{ indexes_base_url }}" placeholder in a terms.json href value
// against window.INDEXES_BASE_URL (self-hosted files too large for the main
// site, e.g. scanned journal PDFs). Plain absolute URLs pass through as-is.
function _resolveIndexesUrl(href) {
  return typeof href === 'string'
    ? href.replace('{{ indexes_base_url }}', window.INDEXES_BASE_URL || '')
    : href;
}

// Build the journal-ref Map and options array shared by loadCaseAsOpinion and loadCase.
// Returns { map: Map<value, {href, title}>, opts: Array<{value, title}> }.
function _buildJournalRefOptions(caseEntry, term) {
  const map  = new Map();
  const opts = [];
  const seen = new Set();
  (caseEntry.events || []).forEach((ev, i) => {
    if (!ev.journal_ref || !ev.date) return;
    // journal_ref is normalized to "YYYY.N" — YYYY is the journal volume's
    // own year (its journal is always the October Term of that year), N is
    // the page number within it, independent of which term this case lives in.
    const m = String(ev.journal_ref).trim().match(/^(\d{4})\.(\d+)$/);
    if (!m) return;
    const refValue = m[0];
    const refTerm  = m[1] + '-10';
    const page     = m[2];
    const refTermEntry = TERMS.find(t => t.term === refTerm);
    const journalHref  = _resolveIndexesUrl(refTermEntry?.journal_href);
    if (!journalHref) return;
    const pageNum  = parseInt(page, 10);
    const bps      = _parsePnBps(refTermEntry?.journal_pages).filter(bp => !bp.roman);
    let pdfPage    = null;
    for (const bp of bps) { if (bp.start <= pageNum) pdfPage = pageNum + (bp.pdfPage - bp.start); }
    const pageAnchor = (Number.isFinite(pageNum) && pdfPage != null) ? String(pdfPage) : page;
    const [y, mo, d] = ev.date.split('-');
    const dateLabel  = (MONTHS[parseInt(mo, 10) - 1] || mo) + '\u00a0' + parseInt(d, 10) + ',\u00a0' + y;
    const title      = 'Journal Entry for ' + dateLabel;
    const url        = journalHref + '#page=' + encodeURIComponent(pageAnchor);
    if (seen.has(url)) return;
    seen.add(url);
    const value = 'journal:' + refValue;
    map.set(value, { href: url, title });
    opts.push({ value, title });
  });
  return { map, opts };
}

// Build the minutes-href Map and options array shared by loadCaseAsOpinion and loadCase.
// Unlike journal_ref, minutes_href is already a direct, per-event URL — no
// term-level lookup or page-offset math needed.
// Returns { map: Map<value, {href, title}>, opts: Array<{value, title}> }.
function _buildMinutesRefOptions(caseEntry) {
  const map  = new Map();
  const opts = [];
  const seen = new Set();
  (caseEntry.events || []).forEach((ev) => {
    if (!ev.minutes_href || !ev.date) return;
    if (seen.has(ev.minutes_href)) return;
    seen.add(ev.minutes_href);
    const [y, mo, d] = ev.date.split('-');
    const dateLabel = (MONTHS[parseInt(mo, 10) - 1] || mo) + '\u00a0' + parseInt(d, 10) + ',\u00a0' + y;
    const title = 'Minutes for ' + dateLabel;
    const value = 'minutes:' + ev.date;
    map.set(value, { href: ev.minutes_href, title, view: 'pane' });
    opts.push({ value, title });
  });
  return { map, opts };
}

// Display a case in opinion-only mode: no transcript pane (i.e. no synced,
// turn-by-turn transcript), no file dropdown. Whatever opens full-height in
// the document viewer follows the same preference as a case with real audio
// defaulting to its argument: the first oral-argument transcript source, if
// any, falling back to the opinion. Used for historical cases without
// playable audio, and when a collection click forces no-audio display
// (forceNoAudio: true).
async function loadCaseAsOpinion(term, caseEntry, numberOverride = null) {
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
  _docViewerAutoOpenSuppressed = false;

  // Show case title (hide audio select since there is no audio).
  setCaseTitleLabel(term, caseEntry, null, numberOverride);
  const _opSub = _subCaseForNumber(caseEntry, numberOverride);
  setPageMeta((_opSub ? _opSub.title : caseTitle(caseEntry.title)) + ' | Argument Aloud', caseMetaDescription(caseEntry));
  const fileSelect = document.getElementById('file-select');
  const decisionLabel = document.getElementById('decision-date-label');

  // Collect any events with journal_ref so we can offer them in a dropdown
  // alongside the decision/opinion.
  const { map: _jrMap, opts: journalOpts } = _buildJournalRefOptions(caseEntry, term);
  _currentJournalRefs = _jrMap;
  const { map: _mrMap, opts: minutesOpts } = _buildMinutesRefOptions(caseEntry);
  _currentMinutesRefs = _mrMap;

  const decisionText = caseEntry.decision
    ? 'Decision on\u00a0' + formatDecisionDate(caseEntry.decision)
        + (caseEntry.usCite ? '\u00a0(' + caseEntry.usCite + ')' : '')
    : null;

  // If there are extra documents to choose from, surface a dropdown rather
  // than the standalone decision label.
  _currentDecisionEntries   = _buildOpinionEntries(caseEntry);
  _currentTranscriptEntries = _buildTranscriptEntries(caseEntry);
  _currentOyezEntries = _buildOyezEntries(caseEntry);
  _currentVideoEntries = (caseEntry.events || []).filter(e => e.source === 'otd' && e.video_href).map(e => ({ href: e.video_href, title: e.title || 'Video' }));
  const _opBasePath = '/courts/ussc/terms/' + term + '/cases/' + caseDirName(caseEntry) + '/';
  const _opRawFiles = caseEntry.files ? await loadFiles(_opBasePath + 'files.json') : [];
  _currentFiles = _opRawFiles;
  // Same filter+sort as the "file:" options built into the dropdown below —
  // reused so the transcript/decision/file fallback chain (see _defaultEntry
  // and _primaryEntry) can pick the same first file a viewer would land on.
  const _opFileEntries = _opRawFiles.slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''))
    .filter(f => {
      const t = (f.type || '').toLowerCase();
      if (t === 'opinion' && caseEntry.decision_ussc) return false;
      if (t === 'reference') return false;
      return true;
    })
    .filter(f => f.href)
    .map(f => ({ value: 'file:' + f.file, href: f.href, title: f.title || '' }));
  // Take the dropdown+doc-viewer path whenever there's anything at all to
  // show — including a lone decision entry. The plain external-link fallback
  // below is reserved for a decided case with no document source at all
  // (decisionText set but every decision_* href missing); a visitor who
  // wants a new tab already has the doc viewer's own "open in new tab" button.
  if (caseEntry.history_href || _opRawFiles.length || (journalOpts.length && (decisionText || journalOpts.length > 1)) || minutesOpts.length || _currentVideoEntries.length || _currentTranscriptEntries.length || _currentDecisionEntries.length) {
    decisionLabel.hidden = true;
    fileSelect.innerHTML = '';
    minutesOpts.forEach(mn => {
      const opt = document.createElement('option');
      opt.value = mn.value;
      opt.textContent = mn.title;
      fileSelect.appendChild(opt);
    });
    journalOpts.forEach(j => {
      const opt = document.createElement('option');
      opt.value = j.value;
      opt.textContent = j.title;
      fileSelect.appendChild(opt);
    });
    _opRawFiles.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')).forEach(f => {
      if ((f.type || '').toLowerCase() === 'opinion' && caseEntry.decision_ussc) return;
      if ((f.type || '').toLowerCase() === 'reference') return;
      const opt = document.createElement('option');
      opt.value = 'file:' + f.file;
      const t = f.title || '';
      opt.textContent = t.length > 40 ? t.slice(0, 40) + '…' : t;
      fileSelect.appendChild(opt);
    });
    _currentTranscriptEntries.forEach(te => {
      const opt = document.createElement('option');
      opt.value = te.value;
      opt.textContent = te.title;
      fileSelect.appendChild(opt);
    });
    _currentDecisionEntries.forEach(de => {
      const opt = document.createElement('option');
      opt.value = de.value;
      opt.textContent = de.title;
      fileSelect.appendChild(opt);
    });
    _currentVideoEntries.forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = 'video:' + i;
      opt.textContent = v.title;
      fileSelect.appendChild(opt);
    });
    _buildReferenceOptions(_opRawFiles).forEach(opt => fileSelect.appendChild(opt));
    // Historical Article appears last, at the bottom of the list.
    if (caseEntry.history_href) {
      const historyOpt = document.createElement('option');
      historyOpt.value = 'history-page';
      historyOpt.textContent = _historyEntryTitle(caseEntry.history_href);
      fileSelect.appendChild(historyOpt);
    }
    // Default to the first oral-argument transcript when present (matches a
    // case with real audio defaulting to its argument), else the first
    // decision entry — both open in the document viewer.
    const _defaultEntry = _currentTranscriptEntries[0] || _currentDecisionEntries[0] || _opFileEntries[0];
    if (_defaultEntry) fileSelect.value = _defaultEntry.value;
    _setFileSelectHidden(false);
  } else {
    _setFileSelectHidden(true);
    if (decisionText) {
      decisionLabel.textContent = decisionText;
      const _firstDE = _currentDecisionEntries[0];
      if (_firstDE) {
        decisionLabel.href = _firstDE.href;
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
  _pruneRedundantUserTags();
  _setCaseInfoRow2(caseEntry);
  _updateFavoriteBtn();
  _updateTagsBtn();

  const qEl = document.getElementById('case-questions');
  qEl.textContent = '';
  qEl.title = '';
  qEl.hidden = true;
  qEl.onclick = null;
  qEl.style.cursor = '';

  playerSection.hidden = false;

  // Open the first oral-argument transcript href full-height in the document
  // viewer — matching how a case with real audio defaults to showing its
  // argument — falling back to the decision when there's no transcript
  // source. Use a local override so this large height doesn't persist for
  // the next audio case.
  const _primaryEntry = _currentTranscriptEntries[0] || _currentDecisionEntries[0] || _opFileEntries[0];
  if (_primaryEntry) {
    const savedHeight = docViewerOpenHeight;
    docViewerOpenHeight = Math.round(window.innerHeight * 0.85);
    showDocViewer({ href: _primaryEntry.href, title: _primaryEntry.title, view: _primaryEntry.view }, { autoScroll: true });
    docViewerOpenHeight = savedHeight;
  }

  if (isMobile()) {
    playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
    setMobileNavVisible(false);
  }
}

async function loadCase(term, caseEntry, audioIdx = 0, { forceNoAudio = false, initialTurn = null, numberOverride = null } = {}) {
  const caseKey = term + '/' + caseId(caseEntry);
  _currentCaseKey = caseKey;
  _currentTerm    = term;
  const basePath = '/courts/ussc/terms/' + term + '/cases/' + caseDirName(caseEntry) + '/';

  // Update topbar term label
  setTopbarTerm(term);

  // Treat as no-audio when forceNoAudio is set OR when no audio entry has a
  // playable audio_href (e.g. transcript-only placeholder entries). Defer to
  // loadCaseAsOpinion which handles the simpler opinion-only display path.
  const hasPlayableAudio = !forceNoAudio && caseEntry.events?.some(a => a.audio_href);
  if (!hasPlayableAudio) {
    return loadCaseAsOpinion(term, caseEntry, numberOverride);
  }

  // Restore file-select visibility for normal audio cases.
  // Reset height so the doc viewer reopens at the default 45vh, not any
  // full-height value left over from a previous no-audio (historical) case.
  document.getElementById('transcript-viewer').classList.remove('no-audio', 'no-transcript');
  _setFileSelectHidden(false);
  document.getElementById('decision-date-label').hidden = true;
  _setCaseInfoRow2(caseEntry);
  _currentDecisionEntries   = _buildOpinionEntries(caseEntry);
  _currentTranscriptEntries = _buildTranscriptEntries(caseEntry);
  _currentOyezEntries = _buildOyezEntries(caseEntry);
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

  // Build file-select dropdown.
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
  const fileSelect = document.getElementById('file-select');
  fileSelect.innerHTML = '';
  // Docket Search appears first when available.
  if (caseEntry.docket_href) {
    const docketOpt = document.createElement('option');
    docketOpt.value = 'docket-page';
    docketOpt.textContent = 'Docket Search';
    fileSelect.appendChild(docketOpt);
  }
  // Minutes and Journal entries appear next, before audio.
  const { map: _mrMap, opts: _minutesOpts } = _buildMinutesRefOptions(caseEntry);
  _currentMinutesRefs = _mrMap;
  _minutesOpts.forEach(mn => {
    const opt = document.createElement('option');
    opt.value = mn.value;
    opt.textContent = mn.title;
    fileSelect.appendChild(opt);
  });
  const { map: _jrMap, opts: _journalOpts } = _buildJournalRefOptions(caseEntry, term);
  _currentJournalRefs = _jrMap;
  _journalOpts.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.value;
    opt.textContent = j.title;
    fileSelect.appendChild(opt);
  });
  const _appendAudioOption = (a) => {
    const opt = document.createElement('option');
    opt.value = allAudio.indexOf(a) + 1;
    const _dtKey = (a.type || 'argument') + ':' + (a.date ?? '');
    const _alwaysSuffix = a.source === 'ussc';
    const _suffix = (_alwaysSuffix || _dupTypeDate.has(_dtKey))
      ? (_sourceSuffixes[a.source] ?? (' (' + (a.source || '').toUpperCase() + ')'))
      : '';
    opt.textContent = audioEntryLabel(a, _suffix);
    fileSelect.appendChild(opt);
  };
  // Argument/reargument audio entries first, then transcript PDF sentinels,
  // then opinion audio entries — transcripts always precede any opinion
  // entry, even when an opinion's audio-only event chronologically sorts
  // before the argument's transcript-bearing event.
  sortedAudio.filter(a => a.type !== 'opinion').forEach(_appendAudioOption);
  _currentTranscriptEntries.forEach(te => {
    const opt = document.createElement('option');
    opt.value = te.value;
    opt.textContent = te.title;
    fileSelect.appendChild(opt);
  });
  sortedAudio.filter(a => a.type === 'opinion').forEach(_appendAudioOption);
  // Append sentinel options linking to decision PDFs, in order: LOC, USSC, US Reports.
  _currentDecisionEntries.forEach(de => {
    const sentinelOpt = document.createElement('option');
    sentinelOpt.value = de.value;
    sentinelOpt.textContent = de.title;
    fileSelect.appendChild(sentinelOpt);
  });
  // Append sentinel option(s) linking to the Oyez case page(s), if available.
  _currentOyezEntries.forEach(oe => {
    const oyezOpt = document.createElement('option');
    oyezOpt.value = oe.value;
    oyezOpt.textContent = oe.title;
    fileSelect.appendChild(oyezOpt);
  });
  // Append sentinel options linking to On The Docket videos, if available.
  _currentVideoEntries.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = 'video:' + i;
    opt.textContent = v.title;
    fileSelect.appendChild(opt);
  });
  // Historical Article appears last, at the bottom of the list.
  if (caseEntry.history_href) {
    const historyOpt = document.createElement('option');
    historyOpt.value = 'history-page';
    historyOpt.textContent = _historyEntryTitle(caseEntry.history_href);
    fileSelect.appendChild(historyOpt);
  }
  // Resolve audioIdx (1-based into caseEntry.events, or 0 = default) to a dropdown
  // option value. The dropdown values are 1-based positions within the
  // date-sorted `allAudio`, so translate via the underlying event reference.
  // If the requested entry was filtered out of the dropdown, fall back to the
  // first option.
  const _dropdownValues = [...fileSelect.options]
    .map(o => o.value)
    .filter(v => v !== 'docket-page' && v !== 'history-page' && !v.startsWith('decision_') && !v.startsWith('journal:') && !v.startsWith('minutes:') && !v.startsWith('transcript:') && !v.startsWith('oyez:') && !v.startsWith('video:') && !v.startsWith('file:'))
    .map(v => parseInt(v, 10));
  const _requestedEvent = (audioIdx >= 1 && caseEntry.events?.[audioIdx - 1]) || null;
  const _requestedAllAudioPos = _requestedEvent ? allAudio.indexOf(_requestedEvent) + 1 : 0;
  const resolvedOptionValue = (_requestedAllAudioPos >= 1 && _dropdownValues.includes(_requestedAllAudioPos))
    ? _requestedAllAudioPos
    : (_dropdownValues.find(v => allAudio[v - 1]?.audio_href) ?? _dropdownValues[0] ?? 1);
  fileSelect.value = String(resolvedOptionValue);

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
  // the tie using the 1-based event index stored on the element. Skip this
  // disambiguation entirely when numberOverride is set: we've deliberately
  // jumped to one specific consolidated docket (e.g. via the Consolidations
  // list), so the collection's one row for the case should highlight even
  // though the docket's own event may fall on a different date/index than
  // whatever the collection entry originally recorded.
  const _resolvedDate = allAudio[resolvedOptionValue - 1]?.date || null;
  const _resolvedEventIdx = caseEntry.events.indexOf(allAudio[resolvedOptionValue - 1]) + 1; // 1-based, 0 if not found
  // The requested event isn't always the one that ends up playing — e.g. a
  // collection recorded a transcript-only event (no audio_href), so the
  // dropdown-resolution above fell back to a different, playable one. When
  // that happens none of a key's candidates will match _resolvedDate/
  // _resolvedEventIdx exactly; activate every candidate for that key rather
  // than none, so the sidebar row doesn't silently fail to highlight/expand.
  _activeKeys.forEach(k => {
    const candidates = [...document.querySelectorAll(`.case-item[data-case-key="${CSS.escape(k)}"]`)];
    const exact = candidates.filter(el => {
      if (!numberOverride && el.dataset.audioDate !== undefined &&
          _resolvedDate !== null &&
          el.dataset.audioDate !== _resolvedDate) return false;
      if (!numberOverride && el.dataset.eventIdx !== undefined &&
          _resolvedEventIdx >= 1 &&
          parseInt(el.dataset.eventIdx, 10) !== _resolvedEventIdx) return false;
      return true;
    });
    (exact.length ? exact : candidates).forEach(el => el.classList.add('active'));
  });
  // When switching cases, collapse file lists for every non-active case.
  document.querySelectorAll('.case-item').forEach(el => {
    if (!el.classList.contains('active')) el.classList.remove('open');
  });

  // Store the full sorted list; the dropdown change handler indexes into it by 1-based value.
  _currentAudioList = allAudio;
  _currentEvents    = caseEntry.events || [];
  _currentBasePath  = basePath;
  _currentCaseEntry = caseEntry;
  _pruneRedundantUserTags();
  _updateFavoriteBtn();
  _updateTagsBtn();

  // Update case title — for consolidated cases, reflect the selected sub-case
  // (or numberOverride, e.g. from a URL 'case' param naming one specific docket).
  const _selOptText = fileSelect.options[fileSelect.selectedIndex]?.textContent || '';
  setCaseTitleLabel(term, caseEntry, _selOptText, numberOverride);
  const _selSub = _subCaseForNumber(caseEntry, numberOverride) || _subCaseForOption(caseEntry, _selOptText);
  setPageMeta((_selSub ? _selSub.title : caseTitle(caseEntry.title)) + ' | Argument Aloud', caseMetaDescription(caseEntry));

  const qEl = document.getElementById('case-questions');
  if (caseEntry.questions) {
    const raw = caseEntry.questions;
    const breakPos = raw.search(/\.\n/);
    const hasMore = breakPos !== -1;
    const firstSentence = questionsSummary(raw);

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
  _currentFiles = rawFiles;
  links = rawFiles.filter(f => f.refs);
  const _fileSel = document.getElementById('file-select');
  if (rawFiles.length) {
    const _fileFrag = document.createDocumentFragment();
    rawFiles.slice().sort((a, b) => (a.title || '').localeCompare(b.title || '')).forEach(f => {
      if ((f.type || '').toLowerCase() === 'reference') return;
      const opt = document.createElement('option');
      opt.value = 'file:' + f.file;
      const t = f.title || '';
      opt.textContent = t.length > 40 ? t.slice(0, 40) + '…' : t;
      _fileFrag.appendChild(opt);
    });
    _fileSel.insertBefore(_fileFrag, _fileSel.firstChild);
  }
  _buildReferenceOptions(rawFiles).forEach(opt => _fileSel.appendChild(opt));

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
  if (!_editMode) _pruneStaleEditsForCurrentTranscript();
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
        opt.textContent = s.name;
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
      tx.title = 'Enter: confirm  •  Shift+Enter: newline  •  Ctrl/Cmd+Enter: split into a new turn at the cursor';
      tx.addEventListener('click', e => {
        if (idx === activeTurnIdx) {
          e.stopPropagation();
          if (turn.time != null) {
            audio.paused ? audio.play().catch(() => {}) : audio.pause();
          }
        }
        // Otherwise let the click bubble to the div handler, which sets the
        // active turn, updates the URL, and seeks audio (matching non-edit behavior).
      });
      tx.addEventListener('blur', () => {
        // Programmatic teardown (e.g. turnList.innerHTML = '' during the
        // re-render after a Ctrl/Cmd+Enter split) fires a blur on the old,
        // still-focused tx too — skip saving in that case, since
        // tx.textContent is now stale (this element is being discarded, not
        // edited). isConnected can't detect this: the blur fires before the
        // node is actually detached, so it still reads true here.
        if (_suppressTurnBlurSave || !tx.isConnected) return;
        _saveEditedTurn(idx, { text: tx.textContent });
        div.classList.toggle('turn-modified', _getEditedTurn(idx) !== null);
      });
      tx.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          // Ctrl/Cmd+Enter splits this turn into two at the caret.
          e.preventDefault();
          _insertTurnAtCursor(idx, tx);
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          tx.blur(); // plain Enter = confirm
        } else if (e.key === 'Enter' && e.shiftKey) {
          // Shift+Enter inserts a literal newline at the cursor.
          e.preventDefault();
          const wSel = window.getSelection();
          if (wSel.rangeCount > 0) {
            const range = wSel.getRangeAt(0);
            range.deleteContents();
            const nl = document.createTextNode('\n');
            range.insertNode(nl);
            range.setStartAfter(nl);
            range.collapse(true);
            wSel.removeAllRanges();
            wSel.addRange(range);
          }
        }
      });

      // Confirm / revert action buttons (top-right corner, shown on focus-within).
      const actions = document.createElement('div');
      actions.className = 'turn-edit-actions';
      // Prevent mousedown from stealing focus away from the text/select.
      actions.addEventListener('mousedown', e => e.preventDefault());

      const revertBtn = document.createElement('button');
      revertBtn.type = 'button';
      revertBtn.className = 'turn-edit-btn turn-edit-btn-revert';
      revertBtn.title = 'Revert all changes to this turn';
      revertBtn.textContent = '✕';
      revertBtn.addEventListener('click', () => {
        _removeEditedTurn(idx);
        tx.textContent = turn.text;
        sel.value = turn.name;
        sel.classList.toggle('speaker-unknown', _unknownSpeakerNames.has(turn.name));
        const origSpkr = speakerMap.get(turn.name) || turn.name;
        div.className = 'turn ' + speakerClass(origSpkr);
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'turn-edit-btn turn-edit-btn-confirm';
      confirmBtn.title = 'Confirm changes (Enter)';
      confirmBtn.textContent = '✓';
      confirmBtn.addEventListener('click', () => tx.blur());

      actions.appendChild(revertBtn);
      actions.appendChild(confirmBtn);
      div.appendChild(actions);
    } else {
      // Non-edit mode: overlay any pending local edits (stale ones pruned at start of renderTranscript).
      const localEdit = _getEditedTurn(idx);
      const viewSpkr  = localEdit ? (speakerMap.get(localEdit.name) || { name: localEdit.name }) : spkr;
      const viewText  = localEdit?.text ?? turn.text;
      if (localEdit) div.className = 'turn ' + speakerClass(viewSpkr) + ' turn-modified';

      sp.textContent = formatSpeaker(viewSpkr);
      if (_unknownSpeakerNames.has(typeof viewSpkr === 'string' ? viewSpkr : viewSpkr.name)) sp.classList.add('speaker-unknown');
      renderTurnText(tx, viewText, null, null);

      // Make non-justice speaker labels clickable links to advocate profiles.
      const spkrTitle = typeof viewSpkr === 'object' ? (viewSpkr.title || 'MR.') : '';
      const spkrName  = typeof viewSpkr === 'object' ? viewSpkr.name : viewSpkr;
      const isAdvocate = spkrTitle && spkrTitle !== 'CHIEF JUSTICE' && spkrTitle !== 'JUSTICE'
                         && !_unknownSpeakerNames.has(spkrName);
      const isJustice = (spkrTitle === 'CHIEF JUSTICE' || spkrTitle === 'JUSTICE')
                        && !_unknownSpeakerNames.has(spkrName);
      if (isAdvocate) {
        sp.classList.add('speaker-link');
        sp.addEventListener('click', (e) => {
          e.stopPropagation();
          const advocateId = _makeAdvocateId(typeof viewSpkr === 'object' ? viewSpkr.name : String(viewSpkr));
          if (!advocateId) return;
          // Build URL with turn so Back returns here.
          const turnId = turn.turn ?? (idx + 1);
          const activeCI = document.querySelector('.case-item.active');
          const caseKey = activeCI?.dataset.caseKey || '';
          const slashIdx = caseKey.indexOf('/');
          const ciTerm = slashIdx >= 0 ? caseKey.slice(0, slashIdx) : '';
          const ciCase = slashIdx >= 0 ? caseKey.slice(slashIdx + 1) : '';
          // Get the current event index (1-based) from the audio selector
          const fileSelect = document.getElementById('file-select');
          const currentEvent = fileSelect && !fileSelect.hidden && fileSelect.value
            ? parseInt(fileSelect.value, 10)
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
          const fileSelect = document.getElementById('file-select');
          const currentEvent = fileSelect && !fileSelect.hidden && fileSelect.value
            ? parseInt(fileSelect.value, 10)
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
        const fileSelect = document.getElementById('file-select');
        const currentEvent = fileSelect && !fileSelect.hidden && fileSelect.value
          ? parseInt(fileSelect.value, 10)
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
      // buildUrlParams always drops 'find' (it re-adds it only when a caller
      // explicitly asks), so a ?find= highlight from a deep link no longer has
      // a URL to match it — clear it too, rather than leaving a stale mark.
      _transcriptSearchClearHighlight?.();
      if (_currentCaseKey) {
        const _fileSel  = document.getElementById('file-select');
        const _selVal    = parseInt(_fileSel?.value ?? '0', 10);
        const _selEntry  = _selVal >= 1 ? _currentAudioList[_selVal - 1] : null;
        const _evIdx     = _selEntry ? _currentEvents.indexOf(_selEntry) + 1 : 0;
        const _prevState = _caseSessionState.get(_currentCaseKey) ?? {};
        const _resolvedEvIdx = _evIdx > 0 ? _evIdx : (_prevState.eventIdx ?? 0);
        const _perEvTurn = { ...(_prevState.perEventTurn || {}) };
        if (_resolvedEvIdx >= 1) _perEvTurn[_resolvedEvIdx] = turnId;
        _caseSessionState.set(_currentCaseKey, {
          eventIdx: _resolvedEvIdx,
          turnNum: turnId,
          perEventTurn: _perEvTurn,
        });
      }
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

// Clears the 'file'/'citation' URL params for dropdown selections that have
// no short-code encoding of their own to restore on reload (docket, transcript,
// Oyez, video, journal entries) — otherwise a stale 'file=N' from a previously
// selected decision/file entry keeps pointing at a document that's no longer
// the one shown.
function _clearDocViewerUrlParams() {
  const url = new URL(location.href);
  url.searchParams.delete('file');
  url.searchParams.delete('citation');
  history.replaceState(null, '', url);
}

// ── Audio entry dropdown ──────────────────────────────────────────────────
document.getElementById('file-select').addEventListener('change', async (e) => {
  // Always reset to case-level notes first; audio entry selection below will
  // override with event-specific notes if the chosen entry has any.
  _setCaseNotes(_currentCaseEntry?.notes || '');
  if (e.target.value === 'docket-page') {
    if (_currentCaseEntry?.docket_href) {
      showDocViewer({ href: _currentCaseEntry.docket_href, title: 'Docket Search', view: 'pane' }, { force: true });
    }
    _clearDocViewerUrlParams();
    return;
  }
  if (e.target.value === 'history-page') {
    if (_currentCaseEntry?.history_href) {
      showDocViewer({ href: _currentCaseEntry.history_href, title: _historyEntryTitle(_currentCaseEntry.history_href), view: 'pane' }, { force: true });
    }
    const url = new URL(location.href);
    url.searchParams.set('file', 'history');
    url.searchParams.delete('citation');
    history.replaceState(null, '', url);
    return;
  }
  if (e.target.value.startsWith('decision_')) {
    const de = _currentDecisionEntries.find(d => d.value === e.target.value);
    if (de) showDocViewer({ href: de.href, title: de.title, view: de.view }, { force: true });
    const url = new URL(location.href);
    const fileVal = DECISION_FILE_PARAMS[e.target.value];
    if (fileVal) url.searchParams.set('file', fileVal); else url.searchParams.delete('file');
    url.searchParams.delete('citation');
    history.replaceState(null, '', url);
    return;
  }
  if (e.target.value.startsWith('transcript:')) {
    const te = _currentTranscriptEntries.find(t => t.value === e.target.value);
    if (te) showDocViewer({ href: te.href, title: te.title, view: te.view }, { force: true });
    _clearDocViewerUrlParams();
    return;
  }
  if (e.target.value.startsWith('oyez:')) {
    const oe = _currentOyezEntries.find(o => o.value === e.target.value);
    if (oe) showDocViewer({ href: oe.href, title: oe.title, view: 'pane' }, { force: true });
    _clearDocViewerUrlParams();
    return;
  }
  if (e.target.value.startsWith('video:')) {
    const idx = parseInt(e.target.value.slice(6), 10);
    const v = _currentVideoEntries[idx];
    if (v) showDocViewer({ href: toEmbedUrl(v.href), title: v.title, view: 'pane' }, { force: true });
    _clearDocViewerUrlParams();
    return;
  }
  if (typeof e.target.value === 'string' && e.target.value.startsWith('journal:')) {
    const entry = _currentJournalRefs.get(e.target.value);
    if (entry) {
      showDocViewer({ href: entry.href, title: entry.title }, { force: true });
    }
    const url = new URL(location.href);
    url.searchParams.set('file', e.target.value.slice('journal:'.length));
    url.searchParams.delete('citation');
    history.replaceState(null, '', url);
    return;
  }
  if (typeof e.target.value === 'string' && e.target.value.startsWith('minutes:')) {
    const entry = _currentMinutesRefs.get(e.target.value);
    if (entry) {
      showDocViewer({ href: entry.href, title: entry.title, view: entry.view }, { force: true });
    }
    const url = new URL(location.href);
    url.searchParams.set('file', e.target.value.slice('minutes:'.length));
    url.searchParams.delete('citation');
    history.replaceState(null, '', url);
    return;
  }
  if (e.target.value.startsWith('file:')) {
    const fileNum = parseInt(e.target.value.slice(5), 10);
    const file = _currentFiles.find(f => f.file === fileNum);
    if (file?.href) showDocViewer({ href: file.href, title: file.title || '' }, { force: true });
    if (file) _revealReferenceFileItem(file);
    const url = new URL(location.href);
    url.searchParams.set('file', String(fileNum));
    url.searchParams.delete('citation');
    history.replaceState(null, '', url);
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

    // Save the departing event's current turn before overwriting session state.
    const _leavingEvIdx  = _currentLoadedEntry ? _currentEvents.indexOf(_currentLoadedEntry) + 1 : 0;
    const _leavingTurn   = activeTurnIdx >= 0 ? (turns[activeTurnIdx]?.turn ?? (activeTurnIdx + 1)) : null;
    const _prevCaseState = _caseSessionState.get(_currentCaseKey) ?? {};
    const _perEvTurn     = { ...(_prevCaseState.perEventTurn || {}) };
    if (_leavingEvIdx >= 1 && _leavingTurn != null) _perEvTurn[_leavingEvIdx] = _leavingTurn;

    // Restore the saved turn for the incoming event, if any.
    const _restoredTurn = evIdx >= 1 ? (_perEvTurn[evIdx] ?? null) : null;

    const updates = {};
    if (evIdx >= 1) updates.event = evIdx;
    if (_restoredTurn != null) updates.turn = _restoredTurn;
    const deletes = ['file'];
    if (evIdx < 1) deletes.push('event');
    if (_restoredTurn == null) deletes.push('turn');
    const newUrl = buildUrlParams(updates, deletes);
    history.replaceState(null, '', newUrl);
    if (_currentCaseKey) {
      _caseSessionState.set(_currentCaseKey, {
        eventIdx: evIdx >= 1 ? evIdx : (_prevCaseState.eventIdx ?? 0),
        turnNum: _restoredTurn,
        perEventTurn: _perEvTurn,
      });
    }
    const _entryToLoad = _restoredTurn != null
      ? { ...withTranscriptFallback(selectedEntry, _currentEvents), turn: _restoredTurn }
      : withTranscriptFallback(selectedEntry, _currentEvents);
    await loadAudioEntry(_entryToLoad, _currentBasePath);
    _setCaseNotes(selectedEntry.notes || _currentCaseEntry?.notes || '');
    // Update title to reflect the selected sub-case for consolidated cases.
    const _chgOptText = e.target.options[e.target.selectedIndex]?.textContent || '';
    setCaseTitleLabel(_currentTerm, _currentCaseEntry, _chgOptText);
    const _chgSub = _subCaseForOption(_currentCaseEntry, _chgOptText);
    setPageMeta((_chgSub ? _chgSub.title : caseTitle(_currentCaseEntry?.title || '')) + ' | Argument Aloud', caseMetaDescription(_currentCaseEntry));
    _updateFavoriteBtn();
    if (isMobile()) {
      playerSection.scrollIntoView({ behavior: 'instant', block: 'start' });
      setMobileNavVisible(false);
    }
  }
});

document.getElementById('favorite-btn')?.addEventListener('click', _toggleFavorite);
document.getElementById('tags-btn')?.addEventListener('click', (e) => { e.stopPropagation(); _buildTagsMenu(e.currentTarget); });

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
  // A ?find= highlight names one specific turn — once the user moves to a
  // different one, drop it from the URL and clear the highlight together.
  if (_turnUrl.searchParams.has('find')) {
    _turnUrl.searchParams.delete('find');
    _transcriptSearchClearHighlight?.();
  }
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

// ── Custom audio controls ────────────────────────────────────────────────────

function _syncPlayPauseBtn() {
  const playing = !audio.paused && !audio.ended;
  playPauseBtn.textContent = playing ? '⏸︎' : '▶︎';
  playPauseBtn.title = playing ? 'Pause' : 'Play';
  playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

playPauseBtn.addEventListener('click', () => {
  audio.paused || audio.ended ? audio.play().catch(() => {}) : audio.pause();
});

let _seekBarDragging = false;
audioSeekBar.addEventListener('mousedown',  () => { _seekBarDragging = true; });
audioSeekBar.addEventListener('touchstart', () => { _seekBarDragging = true; }, { passive: true });
audioSeekBar.addEventListener('input', () => {
  const t = parseFloat(audioSeekBar.value);
  audioCurrentTime.textContent = formatTime(t);
  // Scroll the transcript to follow the drag position, without touching
  // activeTurnIdx/audio.currentTime — those only update once the drag commits
  // (on 'change'), so this is just a visual preview of where dragging will land.
  if (hasTimes) {
    const idx = findCurrentTurn(t);
    if (idx >= 0) {
      document.getElementById('turn-' + idx)?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    }
  }
});
audioSeekBar.addEventListener('change', () => {
  _seekBarDragging = false;
  audio.currentTime = parseFloat(audioSeekBar.value);
});

audio.addEventListener('play',  _syncPlayPauseBtn);
audio.addEventListener('pause', _syncPlayPauseBtn);
audio.addEventListener('ended', _syncPlayPauseBtn);

audio.addEventListener('loadedmetadata', () => {
  if (isFinite(audio.duration) && audio.duration > 0) {
    audioSeekBar.max = audio.duration;
    audioSeekBar.disabled = false;
  }
  _syncPlayPauseBtn();
});

audio.addEventListener('timeupdate', () => {
  if (_seekBarDragging) return;
  audioCurrentTime.textContent = formatTime(audio.currentTime);
  if (audio.duration > 0 && isFinite(audio.duration)) {
    audioSeekBar.value = audio.currentTime;
  }
});

audio.addEventListener('seeked', () => {
  if (_seekBarDragging) return;
  audioCurrentTime.textContent = formatTime(audio.currentTime);
  if (audio.duration > 0 && isFinite(audio.duration)) {
    audioSeekBar.value = audio.currentTime;
  }
});

audio.addEventListener('emptied', () => {
  // Enable play immediately if a new src is being loaded — don't wait for
  // loadedmetadata, which iOS Safari may not fire until after a user gesture.
  playPauseBtn.disabled = !audio.hasAttribute('src');
  audioSeekBar.disabled = true;
  audioSeekBar.value = 0;
  audioCurrentTime.textContent = '0:00';
  _syncPlayPauseBtn();
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
  _docViewerAutoOpenSuppressed = true;
  const url = new URL(location.href);
  url.searchParams.delete('file');
  url.searchParams.delete('citation');
  history.replaceState(null, '', url);
});

document.getElementById('doc-viewer-minimize').addEventListener('click', (e) => {
  e.stopPropagation();
  collapseDocViewer();
});

// Back/forward navigate the currently visible pooled iframe's own history,
// so a visitor who clicked a link inside an embedded document (e.g. an
// external HTML transcript, or one of our own opinion.xsl-rendered pages)
// can return to what was originally opened without losing their place in
// the doc viewer.
function _activeDocViewerEntry() {
  for (const [src, el] of _pdfIframePool) {
    if (el.style.display === 'block') return { src, el };
  }
  return null;
}
function _navigateDocViewer(dir) {
  const entry = _activeDocViewerEntry();
  if (!entry) return;
  const { src, el } = entry;
  let ownOrigin = null;
  try { ownOrigin = window.OPINIONS_BASE_URL ? new URL(window.OPINIONS_BASE_URL).origin : null; } catch {}
  let sameAsOwn = false;
  try { sameAsOwn = ownOrigin && new URL(src, location.href).origin === ownOrigin; } catch {}
  if (sameAsOwn) {
    // We control this content (see the postMessage listener added to
    // assets/xsl/opinion.xsl) — ask it to navigate its own (always-
    // unrestricted) history rather than calling history.back()/forward() on
    // a cross-origin contentWindow ourselves, which browsers don't
    // reliably honor even though it's spec'd as cross-origin-accessible.
    try { el.contentWindow?.postMessage({ type: 'ussc-doc-nav', dir }, ownOrigin); } catch {}
    return;
  }
  // Third-party content with no cooperating script (e.g. an external HTML
  // transcript) — best effort only.
  try { el.contentWindow?.history[dir](); } catch { /* cross-origin, ignore */ }
}
document.getElementById('doc-viewer-back').addEventListener('click', (e) => {
  e.stopPropagation();
  _navigateDocViewer('back');
});
document.getElementById('doc-viewer-forward').addEventListener('click', (e) => {
  e.stopPropagation();
  _navigateDocViewer('forward');
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

// Set by the transcript-search IIFE below; called after transcriptloaded to
// open the search overlay and run a pre-populated query.
let _transcriptSearchInit  = null;
// Set by the transcript-search IIFE; called to close the overlay from outside.
let _transcriptSearchClose = null;
// Set by the transcript-search IIFE; called (by buildUrlParams) to clear a
// silent ?find= highlight when navigation drops the 'find' param, so the
// on-page highlight never outlives the URL that produced it.
let _transcriptSearchClearHighlight = null;

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

  let matchEntries = [];   // [{turnIdx, start, end}] — one per phrase occurrence; start/end=-1 for speaker-only
  let matchCursor  = -1;   // which entry is currently highlighted

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
      const targetIdx = matchEntries[matchCursor]?.turnIdx ?? -1;
      if (targetIdx >= 0 && targetIdx !== activeTurnIdx) {
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
    // Leave the highlight marks in place — closing the box shouldn't un-highlight
    // what it found, matching a silent ?find= deep link's persistent highlight.
    // The next search (computeMatches() clears highlights before redrawing) or
    // an explicit turn navigation (_transcriptSearchClearHighlight) will clean
    // these up when they're actually no longer relevant.
    matchEntries = [];
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
      if (textEl && turns[idx]) renderTurnText(textEl, turns[idx].text, null, null);
    });
  }

  // Unified match computation: filters by selected speaker and/or text query.
  // For text queries, counts exact phrase occurrences (all tokens adjacent, in order)
  // rather than one match per turn.
  function computeMatches() {
    clearHighlights();
    matchEntries = [];
    const query   = input.value.trim();
    const speaker = speakerSelect.value;
    if (!query && !speaker) { updateStatus(); return; }
    const tokens = query ? query.toLowerCase().split(/\s+/).filter(t => t) : [];
    // Exact phrase: all tokens joined by a single space
    const phrase = tokens.join(' ');
    turns.forEach((turn, idx) => {
      if (speaker && turn.name !== speaker) return;
      if (!tokens.length) {
        // Speaker-only filter: one entry per matching turn (no char position)
        matchEntries.push({ turnIdx: idx, start: -1, end: -1 });
        return;
      }
      const textLower = turn.text.toLowerCase();
      let i = 0;
      while (i < textLower.length) {
        const pos = textLower.indexOf(phrase, i);
        if (pos === -1) break;
        matchEntries.push({ turnIdx: idx, start: pos, end: pos + phrase.length });
        i = pos + phrase.length;
      }
    });
    updateStatus();
    // Re-render matching turns with highlighted spans (no 'current' mark yet).
    if (query) {
      const matchedTurns = new Set(matchEntries.map(e => e.turnIdx));
      matchedTurns.forEach(idx => applyHighlight(idx, query, null));
    }
  }

  // Re-render a turn's text with search highlights.  currentRange, if non-null,
  // marks the specific occurrence {start, end} as the active ('current') match.
  function applyHighlight(turnIdx, query, currentRange) {
    const el = document.getElementById('turn-' + turnIdx);
    if (!el) return;
    const textEl = el.querySelector('.turn-text');
    if (!textEl) return;
    renderTurnText(textEl, turns[turnIdx].text, query, currentRange);
  }

  // Scroll to the 'current' mark inside a turn, or fall back to the turn itself.
  function scrollToCurrentMark(turnIdx) {
    const turnEl = document.getElementById('turn-' + turnIdx);
    const currentMark = turnEl?.querySelector('mark.turn-highlight.current');
    if (currentMark) currentMark.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    else if (turnEl) turnEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function updateStatus() {
    if (!matchEntries.length) {
      statusEl.textContent = (input.value.trim() || speakerSelect.value) ? 'No matches found.' : '';
    } else {
      statusEl.textContent = (matchCursor >= 0 ? (matchCursor + 1) + ' of ' : '') + matchEntries.length + ' match' + (matchEntries.length === 1 ? '' : 'es');
    }
    prevBtn.disabled = matchEntries.length === 0;
    nextBtn.disabled = matchEntries.length === 0;
  }

  function goToMatch(delta) {
    if (!matchEntries.length) return;
    const query = input.value.trim();
    const prevTurnIdx = matchCursor >= 0 ? matchEntries[matchCursor].turnIdx : -1;
    // Remove 'current' styling from previous match
    if (matchCursor >= 0) {
      applyHighlight(matchEntries[matchCursor].turnIdx, query, null);
    }
    matchCursor = (matchCursor + delta + matchEntries.length) % matchEntries.length;
    const curr = matchEntries[matchCursor];
    const currentRange = curr.start >= 0 ? { start: curr.start, end: curr.end } : null;
    applyHighlight(curr.turnIdx, query, currentRange);
    // Only move .search-current if the turn changed
    if (prevTurnIdx !== curr.turnIdx) {
      if (prevTurnIdx >= 0) document.getElementById('turn-' + prevTurnIdx)?.classList.remove('search-current');
      document.getElementById('turn-' + curr.turnIdx)?.classList.add('search-current');
    }
    scrollToCurrentMark(curr.turnIdx);
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
      if (document.activeElement?.isContentEditable) return;
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
      if (!matchEntries.length || key !== (input.dataset.lastSearchKey ?? '')) {
        computeMatches();
        input.dataset.lastSearchKey = key;
        if (matchEntries.length) { matchCursor = -1; goToMatch(e.shiftKey ? -1 : 1); }
      } else {
        if (e.shiftKey) goToMatch(-1); else goToMatch(1);
      }
    }
  });

  // Clear stale results as user edits the query (speaker selection is preserved).
  input.addEventListener('input', () => {
    refsSelect.value = '';
    if (matchEntries.length || input.dataset.lastSearchKey) {
      clearHighlights();
      matchEntries = [];
      matchCursor = -1;
      delete input.dataset.lastSearchKey;
      updateStatus();
    }
  });

  function runSearchAndGo(delta) {
    const query   = input.value.trim();
    const speaker = speakerSelect.value;
    if (!query && !speaker) return;
    if (!matchEntries.length) {
      computeMatches();
      input.dataset.lastSearchKey = query.toLowerCase() + '|' + speaker;
      if (matchEntries.length) { matchCursor = -1; goToMatch(delta > 0 ? 1 : -1); }
    } else {
      goToMatch(delta);
    }
  }

  nextBtn.addEventListener('click', () => runSearchAndGo(1));
  prevBtn.addEventListener('click', () => runSearchAndGo(-1));

  // Clear highlights whenever a new transcript is loaded
  document.addEventListener('transcriptloaded', () => {
    matchEntries = [];
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
        opt.textContent = formatSpeakerFull(speaker);
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
    refsSelect.innerHTML = `<option value="">All References</option>`;
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
      matchEntries = [];
      matchCursor = -1;
      delete input.dataset.lastSearchKey;
      updateStatus();
      input.focus();
      return;
    }
    input.value = ref;
    // Clear stale state and run search immediately
    clearHighlights();
    matchEntries = [];
    matchCursor = -1;
    delete input.dataset.lastSearchKey;
    computeMatches();
    input.dataset.lastSearchKey = ref.toLowerCase() + '|' + speakerSelect.value;
    if (matchEntries.length) { matchCursor = -1; goToMatch(1); }
    input.focus();
  });

  speakerSelect.addEventListener('change', () => {
    // Re-run search with updated speaker filter.
    clearHighlights();
    matchEntries = [];
    matchCursor = -1;
    delete input.dataset.lastSearchKey;
    const query   = input.value.trim();
    const speaker = speakerSelect.value;
    if (query || speaker) {
      computeMatches();
      input.dataset.lastSearchKey = query.toLowerCase() + '|' + speaker;
      if (matchEntries.length) { matchCursor = -1; goToMatch(1); }
    } else {
      updateStatus();
    }
  });

  // Expose an entry point for auto-running a search from the URL ?find= param.
  // Called after the transcriptloaded handler above has already reset the input and dropdown.
  // opts.silent skips opening the overlay (used for a ?find=+?turn= deep link that should
  // just highlight the quote in place — see the transcriptloaded listener below).
  // opts.targetTurnIdx, when given, is preferred over "first match in the transcript"
  // when picking which occurrence becomes the 'current' highlighted one.
  // opts.speakerName, when given, pre-selects the matching option in the speaker
  // filter dropdown (matched by full name or by last name alone).
  _transcriptSearchInit = (query, { silent = false, targetTurnIdx = null, speakerName = null } = {}) => {
    if (!silent) openSearch();
    if (speakerName) {
      const n = speakerName.trim().toLowerCase();
      const opt = [...speakerSelect.options].find(o => {
        if (!o.value) return false;
        if (o.value.toLowerCase() === n) return true;
        const parts = o.value.trim().split(/\s+/);
        return parts[parts.length - 1].toLowerCase() === n;
      });
      if (opt) speakerSelect.value = opt.value;
    }
    input.value = query;
    clearHighlights();
    matchEntries = [];
    matchCursor  = -1;
    delete input.dataset.lastSearchKey;
    computeMatches();
    input.dataset.lastSearchKey = query.trim().toLowerCase() + '|' + speakerSelect.value;
    if (matchEntries.length) {
      const preferredIdx = targetTurnIdx != null
        ? matchEntries.findIndex(m => m.turnIdx === targetTurnIdx)
        : -1;
      matchCursor = preferredIdx >= 0 ? preferredIdx - 1 : -1;
      if (silent) {
        goToMatch(1);
      } else {
        // Defer scroll one frame so input.focus() inside openSearch() doesn't
        // compete with scrollIntoView and win.
        requestAnimationFrame(() => goToMatch(1));
      }
    }
  };
  _transcriptSearchClose = closeSearch;
  _transcriptSearchClearHighlight = () => {
    clearHighlights();
    matchEntries = [];
    matchCursor  = -1;
    input.value  = '';
    delete input.dataset.lastSearchKey;
    updateStatus();
  };
})();

// When a transcript loads and the URL contains ?find=, highlight the matching
// word/phrase. If the URL also names a specific ?turn= (a deep link straight
// to one quote), highlight it in place — silently, without popping open the
// search overlay — and prefer that turn's occurrence as the 'current' match
// instead of whichever occurrence comes first in the transcript. Otherwise
// (no turn given, e.g. a plain nav-search query), fall back to opening the
// overlay as a normal in-transcript search.
// This listener is registered after the search IIFE's own transcriptloaded
// handler (which resets the input and dropdown), so it runs second.
document.addEventListener('transcriptloaded', () => {
  const params    = new URLSearchParams(location.search);
  let findParam   = params.get('find')?.trim() ?? '';
  const turnParam = params.get('turn');
  let speakerName = null;
  // Strip keyword-mode quoting — transcript search wants the bare phrase, not the '"…"' wrapper.
  // Trailing text after the closing quote (e.g. '"strict scrutiny" scalia') names a
  // speaker filter — same convention as the plain nav-search box (runNavSearch).
  if (findParam.startsWith('"')) {
    const closeIdx = findParam.indexOf('"', 1);
    if (closeIdx !== -1) {
      const afterQuote = findParam.slice(closeIdx + 1).trim();
      findParam = findParam.slice(1, closeIdx);
      if (afterQuote) speakerName = afterQuote;
    } else {
      findParam = findParam.slice(1);
    }
  }
  // A bare '?' is reserved shorthand for "open an empty search box", not a literal query.
  if (findParam === '?' && _transcriptSearchInit) { _transcriptSearchInit('', { speakerName }); return; }
  if (!findParam || !_transcriptSearchInit) return;
  const turnNum = turnParam != null ? parseInt(turnParam, 10) : null;
  const targetTurnIdx = turnNum != null
    ? turns.findIndex((t, i) => (t.turn ?? (i + 1)) === turnNum)
    : -1;
  if (targetTurnIdx >= 0) {
    _transcriptSearchInit(findParam, { silent: true, targetTurnIdx, speakerName });
  } else {
    _transcriptSearchInit(findParam, { speakerName });
  }
});

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

// Exposed by the nav search IIFE so restoreFromURL can open and run a search.
let _navSearchActivate = null;

// ── Nav case search ───────────────────────────────────────────────────────────
(function () {
  const navSearchBtn   = document.getElementById('nav-search-btn');
  const navSearchRow   = document.getElementById('nav-search-row');
  const navSearchInput = document.getElementById('nav-search-input');
  const navSearchClear = document.getElementById('nav-search-clear');

  let _resultsEl      = null;
  let _searchDebounce = null;

  // Lazily inject the results <ul> after the search row inside the terms section.
  function _ensureResultsEl() {
    if (_resultsEl) return _resultsEl;
    const termsLi = document.querySelector('[data-section="terms"]');
    if (!termsLi) return null;
    const ul = document.createElement('ul');
    ul.id = 'nav-search-results';
    ul.hidden = true;
    const row = termsLi.querySelector('#nav-search-row');
    if (row) row.after(ul); else termsLi.prepend(ul);
    _resultsEl = ul;
    return ul;
  }

  // Tokenise a raw query into search tokens.
  // Any non-alphanumeric character (including hyphens) is a word break, matching
  // the index builder.  A trailing '*' is preserved as a wildcard marker.
  // Tokens shorter than 3 chars (excluding the '*') are dropped.
  function _tokens(q) {
    // Preserve trailing '*' on each word before splitting.
    return q.toLowerCase()
      .split(/[^a-z0-9*]+/)
      .map(t => t.replace(/\*+$/, m => m ? '*' : '').replace(/\*/g, (_, i, s) => i === s.length - 1 ? '*' : ''))
      .map(t => { const bare = t.endsWith('*') ? t.slice(0, -1) : t; return bare.length >= 3 ? t : ''; })
      .filter(t => t.length >= 3 && /^[a-z1-9]/.test(t));
  }

  // Return refs for `token` from a title index (values are string arrays).
  // If `token` ends with '*' do a prefix search; otherwise require an exact match.
  function _refsForToken(index, token) {
    const out = new Set();
    if (token.endsWith('*')) {
      const prefix = token.slice(0, -1);
      for (const [k, arr] of Object.entries(index)) {
        if (k.startsWith(prefix)) for (const r of arr) out.add(r);
      }
    } else {
      const arr = index[token];
      if (arr) for (const r of arr) out.add(r);
    }
    return out;
  }

  // Return a Map<ref, locArray | null> for `token` from a keyword index.
  // Format: values are objects { ref: [e1,t1,p1,nid1, e2,t2,p2,nid2, ...] } —
  // flat 4-tuple arrays, one tuple per (event, turn) occurrence, sorted by (event, turn).
  // Legacy format (pre-location): values are arrays [ref, ...] — those refs are
  // returned with loc=null (no turn navigation) until rebuilt.
  // For prefix wildcards, collapses to [e, t, combinedCount] (earliest location, total turns).
  function _locationsForToken(index, token) {
    const out = new Map(); // ref → locArray | null
    const earlier = (a, b) => a && b && (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]));
    const countOf = (l) => !l ? 0 : (l.length % 4 === 0 ? l.length / 4 : (l[2] || 0));
    const addLocs = (val) => {
      if (!val) return;
      if (Array.isArray(val)) {
        // Legacy array format: each element is a "term/ref" string with no location.
        for (const r of val) if (!out.has(r)) out.set(r, null);
      } else {
        for (const [ref, loc] of Object.entries(val)) {
          if (!out.has(ref)) {
            out.set(ref, loc);
          } else {
            // For prefix matches: keep earliest location, accumulate counts.
            const prev = out.get(ref);
            const base = earlier(loc, prev) ? loc : (earlier(prev, loc) ? prev : (prev ?? loc));
            out.set(ref, base ? [base[0], base[1], countOf(prev) + countOf(loc)] : null);
          }
        }
      }
    };
    if (token.endsWith('*')) {
      const prefix = token.slice(0, -1);
      for (const [k, val] of Object.entries(index)) {
        if (k.startsWith(prefix)) addLocs(val);
      }
    } else {
      addLocs(index[token]);
    }
    return out;
  }

  // Returns {e, t, p, turns, turnPositions} for a given justice nid from a flat 4-tuple
  // loc array [e1,t1,p1,nid1, ...].  turns is a Set<e*1e6+t>; turnPositions is a
  // Map<e*1e6+t, Set<p>> holding every position where this justice says this word in
  // that turn — required for correct phrase-adjacency checking when the word appears
  // more than once in a turn.  Returns null if the nid is not found.
  function _justiceDataForNid(loc, nid) {
    if (!loc || loc.length < 4) return null;
    const turns = new Set();
    const turnPositions = new Map();
    let firstE, firstT, firstP;
    for (let i = 0; i < loc.length; i += 4) {
      if (loc[i + 3] === nid) {
        if (!turns.size) { firstE = loc[i]; firstT = loc[i + 1]; firstP = loc[i + 2]; }
        const key = loc[i] * 1e6 + loc[i + 1];
        turns.add(key);
        if (!turnPositions.has(key)) turnPositions.set(key, new Set());
        turnPositions.get(key).add(loc[i + 2]);
      }
    }
    return turns.size ? { e: firstE, t: firstT, p: firstP, turns, turnPositions } : null;
  }

  // Intersect two flat 4-tuple loc arrays for adjacent phrase tokens.
  // `a` holds all surviving phrase-start occurrences so far: each tuple's p is the
  //     position of the first phrase token at that occurrence.
  // `b` holds every occurrence of the current token across all turns.
  // `offset` is this token's index in the phrase (1 for second word, 2 for third, …).
  // An occurrence in `a` survives only when `b` contains a tuple in the same (e,t)
  // whose position equals a's p + offset.  Because a word can appear multiple times per
  // turn, `b` is indexed as Map<e*1e6+t, Set<p>> so every position is checked.
  // Falls back to count-based [e, t, minCount] when either side is already collapsed
  // (prefix wildcard).  Returns null when no occurrences survive — ref is excluded.
  function _phraseIntersect(a, b, offset) {
    const countOf = (l) => !l ? 0 : (l.length % 4 === 0 ? l.length / 4 : (l[2] || 0));
    if (!a || !b) return null;
    if (a.length % 4 !== 0 || b.length % 4 !== 0) {
      const earlier = (x, y) => x && y && (x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]));
      const base = earlier(a, b) ? a : (earlier(b, a) ? b : (a ?? b));
      return base ? [base[0], base[1], Math.min(countOf(a), countOf(b))] : null;
    }
    // Build Map<e*1e6+t, Set<p>> from b so every occurrence position is reachable.
    const bMap = new Map();
    for (let i = 0; i < b.length; i += 4) {
      const key = b[i] * 1e6 + b[i + 1];
      if (!bMap.has(key)) bMap.set(key, new Set());
      bMap.get(key).add(b[i + 2]);
    }
    // Keep each tuple from a whose required next position exists in b.
    const result = [];
    for (let i = 0; i < a.length; i += 4) {
      if (bMap.get(a[i] * 1e6 + a[i + 1])?.has(a[i + 2] + offset))
        result.push(a[i], a[i + 1], a[i + 2], a[i + 3]);
    }
    return result.length ? result : null;
  }

  function _showNormal() {
    const termsSectionEl = document.querySelector('[data-section="terms"]');
    if (!termsSectionEl) return;
    const inner = termsSectionEl.querySelector('.terms-list-inner');
    if (inner) inner.hidden = false;
    if (_resultsEl) { _resultsEl.hidden = true; _resultsEl.innerHTML = ''; }
    const activeCase = document.querySelector('.case-item.active');
    if (activeCase) {
      activeCase.closest('.term-group')?.classList.add('open');
      activeCase.closest('.decade-group')?.classList.add('open');
      termsSectionEl.classList.add('open');
      requestAnimationFrame(() => activeCase.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
  }

  let _verifyGen = 0;

  // Background phrase verification for keyword searches.
  // Fetches each case's transcript(s), counts exact phrase occurrences, then
  // updates the "? matches" label or removes the result if count is zero.
  // speakerFilter, when given, restricts the count to turns spoken by that
  // justice (matched by full name or last name alone) — otherwise this count
  // would include every speaker and disagree with the transcript search box,
  // which always applies the speaker filter.
  async function _verifyPhrases(phrase, tasks, gen, speakerFilter) {
    const CONCURRENCY = 3;
    const filterName = speakerFilter ? speakerFilter.trim().toLowerCase() : null;
    const queue = [...tasks];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        if (gen !== _verifyGen) return;
        const { term, c, lbl } = queue.shift();
        const casesPath = '/courts/ussc/terms/' + term + '/cases/';
        const hrefs = (c.events || []).map(e => e.text_href).filter(h => h && !/^https?:\/\//i.test(h));
        if (!hrefs.length) continue; // no local transcript — leave "? matches"
        let count = 0;
        for (const href of hrefs) {
          if (gen !== _verifyGen) return;
          try {
            const res = await fetch(casesPath + href);
            if (!res.ok) continue;
            const data = await res.json();
            const turns = Array.isArray(data) ? data : (data.turns || []);
            for (const turn of turns) {
              if (filterName) {
                const turnName = (turn.name || '').trim().toLowerCase();
                const lastName = turnName.split(/\s+/).pop();
                if (turnName !== filterName && lastName !== filterName) continue;
              }
              let i = 0;
              const text = (turn.text || '').toLowerCase();
              while (true) {
                const pos = text.indexOf(phrase, i);
                if (pos === -1) break;
                count++;
                i = pos + phrase.length;
              }
            }
          } catch (_) { /* skip unreadable transcript */ }
        }
        if (gen !== _verifyGen) return;
        if (count === 0) {
          lbl.closest('li')?.remove();
        } else {
          lbl.textContent = count + ' match' + (count === 1 ? '' : 'es');
        }
      }
    }));
  }

  async function runNavSearch(query) {
    _verifyGen++; // cancel any in-flight phrase verification
    const termsSectionEl = document.querySelector('[data-section="terms"]');
    if (!termsSectionEl) return;
    const inner    = termsSectionEl.querySelector('.terms-list-inner');
    const resultsEl = _ensureResultsEl();

    const q = query.trim();
    if (!q) { _showNormal(); return; }

    // A leading '"' switches to transcript keyword search instead of title search.
    const keywordMode = q.startsWith('"');

    // In keyword mode, text after the closing '"' is treated as a justice name filter.
    // e.g. '"due process" alito' → keywords='due process', justiceFilter='alito'
    let keywords = keywordMode ? q.slice(1) : q;
    let justiceFilter = null;
    if (keywordMode) {
      const closeIdx = keywords.indexOf('"');
      if (closeIdx !== -1) {
        const afterQuote = keywords.slice(closeIdx + 1).trim();
        keywords = keywords.slice(0, closeIdx);
        if (afterQuote) justiceFilter = afterQuote;
      }
    }

    // Renders a flat list of "term/id-or-number" (or shortened "id") ref
    // strings — shared by number mode and citation mode below, both of which
    // resolve straight to a flat ref list rather than the token-intersection
    // logic used for title/keyword search.
    async function renderRefResults(refs) {
      const activeTerm = new URLSearchParams(location.search).get('term');
      const termFilter = (activeTerm && activeTerm !== 'all') ? activeTerm : null;
      const byTerm = new Map();
      for (const ref of refs) {
        const i = ref.indexOf('/');
        const term = i === -1 ? ref.slice(0, 4) + '-10' : ref.slice(0, i);
        const id   = i === -1 ? ref                     : ref.slice(i + 1);
        if (termFilter && term !== termFilter) continue;
        if (!byTerm.has(term)) byTerm.set(term, []);
        byTerm.get(term).push(id);
      }
      const results = [];
      await Promise.all([...byTerm].map(async ([term, idData]) => {
        const cases = await fetchTermCases(term);
        const idSet = new Set(idData);
        for (const c of cases) {
          if (idSet.has(c.id) || idSet.has(c.number)) results.push({ term, c });
        }
      }));
      results.sort((a, b) =>
        b.term.localeCompare(a.term) ||
        (caseTitle(a.c.title) || '').localeCompare(caseTitle(b.c.title) || '')
      );
      if (inner) inner.hidden = true;
      if (!resultsEl) return;
      resultsEl.innerHTML = '';
      if (!results.length) {
        const li = document.createElement('li');
        li.className = 'nav-search-no-results';
        li.textContent = 'No matches found';
        resultsEl.appendChild(li);
      } else {
        const MAX_N = 200;
        for (const { term, c } of results.slice(0, MAX_N)) {
          const urlId = (c.number ? c.number.split(',')[0].trim() : '') || c.id || '';
          const href = buildUrlParams(
            { term, case: urlId },
            ['collection', 'group', 'id', 'highlight', 'file', 'event', 'turn', 'find'],
          );
          const li  = document.createElement('li');
          li.className = 'case-item';
          const div = document.createElement('div');
          div.className = 'case-header';
          const a = document.createElement('a');
          a.className = 'case-title-nav';
          const _numLabel = c.number
            ? ' (' + (c.number.includes(',') ? 'Nos. ' : 'No. ') + c.number.replace(/-(?=Orig|Misc)/gi, ' ') + ')'
            : '';
          a.textContent = (caseTitle(c.title) || urlId) + _numLabel;
          a.href = href;
          a.title = (c.number || c.id || '') + '  ·  ' + term;
          a.addEventListener('click', e => {
            e.preventDefault();
            navigate(href);
            restoreFromURL();
            closeNavSearch();
          });
          const lbl = document.createElement('span');
          lbl.className = 'nav-search-term-label';
          lbl.textContent = term;
          div.appendChild(a);
          div.appendChild(lbl);
          li.appendChild(div);
          resultsEl.appendChild(li);
        }
        if (results.length > MAX_N) {
          const li = document.createElement('li');
          li.className = 'nav-search-no-results';
          li.textContent = '… and ' + (results.length - MAX_N) + ' more';
          resultsEl.appendChild(li);
        }
      }
      resultsEl.hidden = false;
    }

    // Number mode: query starts with '#' followed by a docket number.
    // Examples: "#24-1260", "#22-Orig", "#22 orig", "#100".
    // Normalisation mirrors processNumberIndex in update_cases.js: lowercase and
    // replace a hyphen immediately before "orig"/"misc" with a space.
    const numberMode = !keywordMode && q.startsWith('#');
    if (numberMode) {
      const numIndex = await _fetchNumberIndex();
      const normQ = q.slice(1).trim().replace(/-(?=orig|misc)/i, ' ').replace(/\s+/g, ' ').toLowerCase();
      // Purely numeric queries (e.g. "#2") must match a whole docket number
      // exactly -- otherwise "#2" would substring-match "22-1260", "1972-161",
      // etc. Non-numeric patterns like "orig"/"misc" still substring-match so
      // "#orig" finds any Orig case number.
      const numericQuery = normQ !== '' && !/[a-z]/i.test(normQ);
      let refs = [];
      if (normQ) {
        const seen = new Set();
        for (const [key, val] of Object.entries(numIndex)) {
          const isMatch = numericQuery ? key === normQ : key.includes(normQ);
          if (isMatch) { for (const r of val) { if (!seen.has(r)) { seen.add(r); refs.push(r); } } }
        }
      }
      await renderRefResults(refs);
      return;
    }

    // Citation mode: query looks like a U.S. Reports citation, e.g.
    // "387 U.S. 397" or the more succinct "387 US 397". Triggers as soon as
    // the leading volume number is followed by "U.S."/"US" and at least one
    // digit or roman-numeral page character — until the page number is a
    // complete, exact match (e.g. "456 U.S. 45" fully typed), the query keeps
    // matching against the title index below instead, which is harmless
    // since it won't find anything either. Exact match only (not a prefix)
    // so "456 U.S. 4" doesn't also surface "456 U.S. 45", "456 U.S. 400", etc.
    const citationMode = !keywordMode && /^\d+\s*u\.?s\.?\s+[0-9ivxlcdm]/i.test(q);
    if (citationMode) {
      const citeIndex = await _fetchCitationIndex();
      const normQ = _normalizeUsCite(q);
      const refs = normQ && citeIndex[normQ] ? [...citeIndex[normQ]] : [];
      await renderRefResults(refs);
      return;
    }

    const toks = _tokens(keywords);
    if (!toks.length) {
      // Query has content but every token is too short to be in the index.
      if (inner) inner.hidden = true;
      if (resultsEl) { resultsEl.hidden = false; resultsEl.innerHTML = ''; }
      return;
    }

    // Fetch required index files in parallel (cached after first load).
    // Title-mode index files are keyed by the first 2 chars of each token (all
    // tokens are guaranteed ≥ 3 chars by _tokens(), so the prefix is always
    // available). Keyword-mode indexes may be split into 3-letter sub-files
    // (see _fetchKeywordIndexForToken), so those are resolved per-token instead.
    const [indexMap, nidMaps] = await Promise.all([
      keywordMode
        ? Promise.all(toks.map(async t => [t, await _fetchKeywordIndexForToken(t)])).then(Object.fromEntries)
        : Promise.all([...new Set(toks.map(t => t.slice(0, 2)))].map(async p => [p, await _fetchTitleIndex(p)])).then(Object.fromEntries),
      keywordMode && justiceFilter ? _fetchJusticeNids() : Promise.resolve(null),
    ]);

    // Resolve justice filter to a numeric nid (null if filter present but unrecognised).
    let justiceNid = undefined;
    if (justiceFilter !== null) {
      const n = justiceFilter.toLowerCase();
      justiceNid = nidMaps?.byFullName.get(n) ?? nidMaps?.byLastName.get(n) ?? null;
    }

    // Intersect across all tokens.
    // Keyword mode: phrase-aware — a turn qualifies only when each successive token
    // appears at the next word position in the same turn.  The resulting Map value is a
    // flat 4-tuple array of matching turns (or a [e, t, count] collapsed form for
    // prefix wildcards).  null locs (legacy index) are kept with no navigation.
    // Title mode: Set<"term/ref"> plain intersection.
    let combined = null; // Set or Map depending on mode
    const tokenLocs = []; // per-token Map<ref, locArray> saved for justice filter
    for (const tok of toks) {
      if (keywordMode) {
        const locs = _locationsForToken(indexMap[tok] || {}, tok);
        tokenLocs.push(locs);
        if (combined === null) {
          combined = locs;
        } else {
          const next = new Map();
          const phraseOffset = tokenLocs.length - 1;
          for (const [ref, a] of combined) {
            if (!locs.has(ref)) continue;
            const phraseResult = _phraseIntersect(a, locs.get(ref), phraseOffset);
            if (phraseResult !== null) next.set(ref, phraseResult);
          }
          combined = next;
        }
        if (!combined.size) break;
      } else {
        const refs = _refsForToken(indexMap[tok.slice(0, 2)] || {}, tok);
        combined = combined === null ? refs : new Set([...combined].filter(r => refs.has(r)));
        if (!combined.size) break;
      }
    }

    // Apply justice filter: keep only cases where the specified justice says ALL query
    // words as a phrase (adjacent positions) in at least one common turn.  The count
    // equals the number of qualifying turns; the nav loc points to the justice's first
    // occurrence of the first search token.
    if (keywordMode && justiceNid !== undefined && combined?.size) {
      if (justiceNid === null) {
        combined = new Map(); // unrecognised justice name → no results
      } else {
        const filtered = new Map();
        for (const [ref, loc] of combined) {
          let intersection = null; // Set<e*1e6+t> of turns common to all tokens
          const posByToken = [];   // per-token Map<e*1e6+t, p> for phrase checking
          let firstData = null;
          let ok = true;
          for (let ti = 0; ti < tokenLocs.length; ti++) {
            const jd = _justiceDataForNid(tokenLocs[ti].get(ref), justiceNid);
            if (!jd) { ok = false; break; }
            intersection = intersection === null
              ? jd.turns
              : new Set([...intersection].filter(x => jd.turns.has(x)));
            posByToken.push(jd.turnPositions);
            if (!firstData) firstData = jd;
          }
          // Phrase check: try every starting position of token 0; keep turns where some
          // starting position p0 has each successive token at p0 + offset.
          if (ok && intersection?.size && posByToken.length > 1) {
            const phraseMatches = new Set();
            for (const key of intersection) {
              const p0Set = posByToken[0].get(key);
              if (!p0Set) continue;
              for (const p0 of p0Set) {
                let isPhrase = true;
                for (let ti = 1; ti < posByToken.length; ti++) {
                  if (!posByToken[ti].get(key)?.has(p0 + ti)) { isPhrase = false; break; }
                }
                if (isPhrase) { phraseMatches.add(key); break; }
              }
            }
            intersection = phraseMatches;
          }
          if (ok && intersection?.size) {
            filtered.set(ref, firstData
              ? [firstData.e, firstData.t, intersection.size]
              : [loc[0], loc[1], intersection.size]);
          }
        }
        combined = filtered;
      }
    }

    // Group matched refs by term.
    // For keyword mode, values are Map<id, [ev, turn]>; for title mode, Set<id>.
    // Keyword index refs may be short ("YYYY-NNN") when the term is the matching
    // October term — infer it from the id's year prefix in that case.
    const activeTerm = new URLSearchParams(location.search).get('term');
    const termFilter = (activeTerm && activeTerm !== 'all') ? activeTerm : null;
    const byTerm = new Map();
    for (const ref of (combined?.keys?.() ?? combined ?? [])) {
      const i = ref.indexOf('/');
      const term = i === -1 ? ref.slice(0, 4) + '-10' : ref.slice(0, i);
      const id   = i === -1 ? ref                     : ref.slice(i + 1);
      if (termFilter && term !== termFilter) continue;
      if (keywordMode) {
        if (!byTerm.has(term)) byTerm.set(term, new Map());
        byTerm.get(term).set(id, combined.get(ref));
      } else {
        if (!byTerm.has(term)) byTerm.set(term, []);
        byTerm.get(term).push(id);
      }
    }

    // Fetch only the cases.json files for terms that have matches.
    const results = []; // { term, c, loc?, count? }
    await Promise.all([...byTerm].map(async ([term, idData]) => {
      const cases = await fetchTermCases(term);
      if (keywordMode) {
        for (const c of cases) {
          const loc = idData.has(c.id) ? idData.get(c.id) : idData.has(c.number) ? idData.get(c.number) : undefined;
          if (loc !== undefined) results.push({ term, c, loc, count: loc ? (loc.length % 4 === 0 ? loc.length / 4 : (loc[2] || 0)) : 0 });
        }
      } else {
        const idSet = new Set(idData);
        for (const c of cases) {
          if (idSet.has(c.id) || idSet.has(c.number)) results.push({ term, c });
        }
      }
    }));

    // Keyword mode: sort by total occurrence count descending, then by most-recent term.
    // Title mode: sort by most-recent term first, then alphabetically within a term.
    results.sort((a, b) =>
      (keywordMode ? ((b.count || 0) - (a.count || 0)) : 0) ||
      b.term.localeCompare(a.term) ||
      (caseTitle(a.c.title) || '').localeCompare(caseTitle(b.c.title) || '')
    );

    // Switch the display from the normal terms tree to the flat results list.
    if (inner) inner.hidden = true;
    if (!resultsEl) return;
    resultsEl.innerHTML = '';

    const MAX = 200;
    if (!results.length) {
      const li = document.createElement('li');
      li.className = 'nav-search-no-results';
      li.textContent = 'No matches found';
      resultsEl.appendChild(li);
    } else {
      const verifyTasks = []; // { term, c, lbl } for background phrase check
      for (const { term, c, loc, count } of results.slice(0, MAX)) {
        const urlId = (c.number ? c.number.split(',')[0].trim() : '') || c.id || '';
        const updates = { term, case: urlId };
        const deletes = ['collection', 'group', 'id', 'highlight', 'file'];
        if (loc) { updates.event = loc[0]; updates.turn = loc[1]; }
        else deletes.push('event', 'turn');
        // A trailing justice-name filter (e.g. '"strict scrutiny" scalia') travels as
        // part of the find= value itself — see the transcriptloaded listener below,
        // which parses it back out to pre-select the transcript search's speaker filter.
        const findValue = '"' + keywords.trim() + '"' + (justiceFilter ? ' ' + justiceFilter : '');
        if (keywordMode) {
          updates.find = findValue;
        } else deletes.push('find');
        const href = buildUrlParams(updates, deletes);
        const li  = document.createElement('li');
        li.className = 'case-item';
        const div = document.createElement('div');
        div.className = 'case-header';
        const a = document.createElement('a');
        a.className = 'case-title-nav';
        const title = caseTitle(c.title) || urlId;
        if (keywordMode) {
          const year = (c.decided || c.argued || '').slice(0, 4) || term.slice(0, 4);
          a.textContent = title + ' (' + year + ')';
        } else {
          a.textContent = title;
        }
        a.href = href;
        a.title = (c.number || c.id || '') + '  ·  ' + term;
        a.addEventListener('click', e => {
          e.preventDefault();
          if (keywordMode) {
            const cur = new URL(location.href);
            cur.searchParams.set('find', findValue);
            history.replaceState(null, '', cur.pathname + '?' + cur.searchParams.toString());
          }
          navigate(href);
          restoreFromURL();
          closeNavSearch();
        });
        const lbl = document.createElement('span');
        lbl.className = 'nav-search-term-label';
        if (keywordMode) {
          lbl.textContent = '? matches';
          verifyTasks.push({ term, c, lbl });
        } else {
          lbl.textContent = term;
        }
        div.appendChild(a);
        div.appendChild(lbl);
        li.appendChild(div);
        resultsEl.appendChild(li);
      }
      if (results.length > MAX) {
        const li = document.createElement('li');
        li.className = 'nav-search-no-results';
        li.textContent = '… and ' + (results.length - MAX) + ' more';
        resultsEl.appendChild(li);
      }
      if (keywordMode && verifyTasks.length) {
        const phrase = toks.join(' ');
        const gen = _verifyGen;
        _verifyPhrases(phrase, verifyTasks, gen, justiceFilter); // fire-and-forget
      }
    }

    resultsEl.hidden = false;
  }

  function openNavSearch() {
    navSearchRow.hidden = false;
    navSearchBtn.classList.add('active');
    navSearchInput.focus();
    navSearchInput.select();
  }

  function closeNavSearch() {
    navSearchRow.hidden = true;
    navSearchBtn.classList.remove('active');
    navSearchInput.value = '';
    _showNormal();
  }

  navSearchBtn.addEventListener('click', () => {
    if (navSearchRow.hidden) openNavSearch(); else closeNavSearch();
  });

  navSearchClear.addEventListener('click', () => closeNavSearch());

  navSearchInput.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => runNavSearch(navSearchInput.value), 150);
  });

  navSearchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeNavSearch(); return; }
    if (e.key === 'Enter') {
      const val = navSearchInput.value.trim();
      // Save search state for all modes: keyword ("), number (#), or plain title.
      // Bare '"' or '#' with nothing after are not valid queries.
      if (val.length > 0 && val !== '"' && val !== '#') {
        const url = new URL(location.href);
        url.searchParams.set('find', val);
        ['case', 'event', 'turn', 'file', 'collection', 'group', 'id', 'highlight', 'link', 'date'].forEach(k => url.searchParams.delete(k));
        history.replaceState(null, '', url.pathname + '?' + url.searchParams.toString());
      }
    }
  });

  _navSearchActivate = (findQuery) => {
    // A bare '?' is a reserved shorthand for "open an empty search box" —
    // e.g. from a shared link like ?find=%3F — so don't search for it literally.
    if (findQuery === '?') { openNavSearch(); return; }
    openNavSearch();
    navSearchInput.value = findQuery;
    runNavSearch(findQuery);
  };
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
    // Read start/stop from the button's own href (see _includes/topbar.html)
    // rather than hardcoding a second copy here — otherwise the two drift
    // apart, as they had (href said start=1955-10; this used to say 1950-10).
    const hrefParams = btn ? new URL(btn.href, location.origin).searchParams : null;
    const startTerm  = hrefParams?.get('start') || null;
    const stopTerm   = hrefParams?.get('stop')  || null;
    await _randomizeThenRestore(startTerm, stopTerm);
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
  _normalizePageNodes(navData);
  await Promise.all(navData.map(async entry => {
    if (!entry.file) return;
    try {
      const res = await fetch(entry.file, { cache: 'reload' });
      if (!res.ok) return;
      const data = await res.json();
      if (entry.file.endsWith('terms.json')) {
        TERMS_GROUPED = [...data].filter(d => !d.hidden).reverse().map(d => ({ ...d, groups: [...(d.groups || [])].reverse() }));
        // Build flat TERMS array for lookups (term derived from cases URL).
        TERMS = data.flatMap(decade => {
          if (decade.hidden) return [];
          return (decade.groups || []).map(page => {
            const m = /\/terms\/([^/]+)\/cases\.json$/.exec(page.file || (typeof page.cases === 'string' ? page.cases : '') || '');
            return { ...page, term: m ? m[1] : '' };
          });
        });
      } else if (entry.file.endsWith('collections.json')) {
        COLLECTIONS = data;
      } else if (entry.file.endsWith('topics.json')) {
        TOPICS = data;
      } else if (entry.file.endsWith('blog/posts.json')) {
        // Jekyll-generated from each post's own front matter (see
        // courts/ussc/blog/posts.json) — no hand-maintained list to keep in
        // sync. Swap in as a plain static groups section (buildStaticNavSection)
        // by clearing .file, same shape the old hardcoded array used.
        entry.groups = data;
        delete entry.file;
        _normalizePageNodes(entry.groups);
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
    // Re-attach on every iframe navigation (content changes).
    pageFrame.addEventListener('load', function () {
      try { _attachRandomizeHoverListeners(this.contentDocument); } catch (_) {}
      _applyThemeToFrame(this);
      _restorePageFrameScroll(this);
    });
    // The browser can replay a framed page's own joint-session-history entry
    // while parsing a freshly (re)loaded top-level document (e.g. after a
    // target="_top" link's Back navigation) — often before the listener
    // above even gets attached, so that particular 'load' event is otherwise
    // missed entirely. Catch that case here (see "Page-viewer iframe scroll
    // restoration" above _frameNavigate for the full explanation).
    try {
      if (pageFrame.contentDocument?.readyState === 'complete') _restorePageFrameScroll(pageFrame);
    } catch (_) {}
    // Safety net: stop spinning whenever the mouse leaves the iframe entirely.
    pageFrame.addEventListener('mouseleave', () => {
      document.getElementById('random-case-btn')?.classList.remove('spinning');
    });
  }
  // Re-export for topbar.js theme switcher — syncs both the main page-viewer
  // iframe (if present) and any pooled doc-viewer iframes currently showing
  // a non-PDF "pane" document (see _getOrCreatePdfIframe).
  window._applyThemeToPageFrame = () => {
    if (pageFrame) _applyThemeToFrame(pageFrame);
    for (const el of _pdfIframePool.values()) _applyThemeToFrame(el);
  };

  await restoreFromURL();
}

// Returns the section <li> that contains the given collection, opened and built.
// Checks _collectionsSectionLi then _topicsSectionLi so both sources are routable.
async function _openCollectionSection(collId) {
  for (const sLi of [_collectionsSectionLi, _topicsSectionLi]) {
    if (!sLi) continue;
    sLi.classList.add('open');
    await sLi._ensureBuilt();
    if (sLi.querySelector(`.term-group[data-collection-id="${CSS.escape(collId)}"]`)) return sLi;
  }
  return null;
}

// Scroll a collection's sidebar so a specific group (e.g. one bench) is in
// view, without navigating/reloading the page-viewer iframe itself — used by
// embedded pages (e.g. the benches list) that want to keep the sidebar synced
// with whichever item they consider "first" under their own sort order.
async function _scrollSidebarToCollectionItem(collId, itemId) {
  const sLi = await _openCollectionSection(collId);
  const collLi = sLi?.querySelector(`.term-group[data-collection-id="${CSS.escape(collId)}"]`);
  if (!collLi) return;
  let ancestor = collLi.parentElement?.closest('.term-group');
  while (ancestor && sLi.contains(ancestor)) { ancestor.classList.add('open'); ancestor = ancestor.parentElement?.closest('.term-group'); }
  collLi.classList.add('open');
  await collLi._ensureBuilt?.();
  const groupLi = collLi.querySelector(`.month-group[data-group-id="${CSS.escape(itemId)}"]`);
  if (!groupLi) return;
  collLi._centerOnGroup?.(groupLi);
  // 'nearest' (not 'start') so this is a no-op when the item is already visible,
  // and only a minimal scroll otherwise — avoids yanking the pane to align the
  // item at the very top, which is jarring when it's the last item in the list.
  requestAnimationFrame(() => groupLi.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
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

  // ── ?find= without a case → open nav keyword search ─────────────────────────
  // Run the search but do NOT return — let the rest of restoreFromURL continue
  // so that other params (e.g. term=all) are still handled normally.
  const findParam  = params.get('find');
  const caseParam    = params.get('case');
  if (!caseParam) _transcriptSearchClose?.();
  if (findParam && !caseParam && _navSearchActivate) {
    _navSearchActivate(findParam);
  }

  const linkParam       = params.get('link');
  let termParam         = params.get('term');
  if (termParam === 'current') termParam = TERMS[0]?.term ?? termParam;
  const dateParam       = params.get('date') ?? null;
  let collectionParam = params.get('collection') ?? params.get('topic');
  if (collectionParam && _COLLECTION_ALIASES[collectionParam]) {
    collectionParam = _resolveCollectionAlias(collectionParam);
    params.set('collection', collectionParam);
    history.replaceState(null, '', '?' + params.toString());
  }

  // General <id>=all: expand the matching top-level nav section.
  // term=all is excluded here because it has dedicated stats-page handling below.
  for (const [sectionId, sLi] of _sectionLiById) {
    if (sectionId !== 'term' && params.get(sectionId) === 'all') {
      sLi.classList.add('open');
      sLi._ensureBuilt?.();
      const _sectionName = sLi.querySelector('.terms-label')?.textContent;
      if (_sectionName) setPageMeta(_sectionName + ' | Argument Aloud');
      requestAnimationFrame(() => sLi.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
      // Unlike term=all (which has its own stats page), most of these sections have
      // no dedicated landing page of their own — index.json's entry.page names one
      // where it exists (e.g. collection=all → the collections card page); anything
      // else falls back to the same default page shown for the bare URL (the
      // index.json node marked "default": true).
      showPageViewer(_sectionPageById.get(sectionId) || _defaultPage, { pushState: false });
      trackPageView(location.href);
      return;
    }
  }

  // ?source=<id>[&group=<1-based index>] — expand a Sources entry (built by
  // buildStaticPageItem) and show its page/link, or a specific child group's.
  {
    const sourceParam = params.get('source');
    if (sourceParam) {
      const sourcesLi = _sectionLiById.get('source');
      if (sourcesLi) {
        sourcesLi.classList.add('open');
        sourcesLi._ensureBuilt?.();
        const srcLi = sourcesLi.querySelector(`[data-source-id="${CSS.escape(sourceParam)}"]`);
        if (srcLi) {
          srcLi.classList.add('open');
          const srcIdParam    = params.get('id');
          const srcGroupParam = params.get('group');
          let targetLi = srcLi;
          if (srcIdParam != null) {
            const grpLi = srcLi.querySelector(`:scope > ul > [data-group-id="${CSS.escape(srcIdParam)}"]`);
            if (grpLi) targetLi = grpLi;
          } else if (srcGroupParam != null) {
            const grpLi = srcLi.querySelector(`:scope > ul > [data-group-index="${CSS.escape(srcGroupParam)}"]`);
            if (grpLi) targetLi = grpLi;
          }
          targetLi._openPage?.();
          requestAnimationFrame(() => targetLi.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
        }
      }
      trackPageView(location.href);
      return;
    }
  }

  const groupParam      = params.get('group') != null ? parseInt(params.get('group'), 10) : null;
  const idParam         = params.get('id') ?? null;
  const highlightParam  = params.get('highlight') != null ? parseInt(params.get('highlight'), 10) - 1 : null;
  const audioParam = params.get('event') != null ? Math.max(1, parseInt(params.get('event'), 10)) : null; // 1-based index into caseEntry.events (original on-disk order)
  const fileParam  = params.get('file') ?? null;  // string: numeric id or href filename
  const citationParam = params.get('citation') != null ? parseInt(params.get('citation'), 10) : null; // 1-based index into caseEntry.opCite
  const turnParam  = params.get('turn') != null ? parseInt(params.get('turn'), 10) : null;
  const _parsedSort = _parseSortParam(params.get('sort'), params.get('o'));

  // ── Collection restore ───────────────────────────────────────────────────

  function _findAnyCollectionEntry(collId) {
    return _findCollectionEntry(COLLECTIONS, collId) ?? _findCollectionEntry(TOPICS, collId);
  }

  // Collection-only: just open/expand the collection in the nav.
  const _anySectionLi = _collectionsSectionLi || _topicsSectionLi;
  if (collectionParam && !groupParam && !idParam && highlightParam == null && !termParam && !caseParam && _anySectionLi) {
    const _sLi = await _openCollectionSection(collectionParam);
    const collLi = _sLi?.querySelector(
      `.term-group[data-collection-id="${CSS.escape(collectionParam)}"]`
    );
    const _hash = location.hash.slice(1);
    if (collLi) {
      let _ag = collLi.parentElement?.closest('.term-group');
      while (_ag && _sLi.contains(_ag)) { _ag.classList.add('open'); _ag = _ag.parentElement?.closest('.term-group'); }
      collLi.classList.add('open');
      await collLi._ensureBuilt?.();
      // A collection with only one nested group (e.g. Original Jurisdiction's
      // sole "Archive" group) has nothing else to browse, so expand it too —
      // otherwise landing here always requires one more click for no reason.
      const _soleGroups = collLi.querySelectorAll(':scope > .case-list > .month-group');
      if (_soleGroups.length === 1) {
        const _soleGroup = _soleGroups[0];
        _soleGroup.classList.add('open');
        await _soleGroup._ensureCases?.();
        _soleGroup._activateCount?.();
      }
      const _hashEl = _hash ? document.getElementById(_hash) : null;
      if (_hashEl) {
        collLi._centerOnGroup?.(_hashEl);
        requestAnimationFrame(() => _hashEl.scrollIntoView({ behavior: 'instant', block: 'start' }));
      } else requestAnimationFrame(() => collLi.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
    }
    const collEntry = _findAnyCollectionEntry(collectionParam);
    const resolvedLink = linkParam || collEntry?.page || null;
    if (resolvedLink) {
      const _sortV = params.get('sort');
      const _sV    = params.get('s');
      let _linkWithSort = resolvedLink;
      const _extra = [];
      if (_sortV) { _extra.push('sort=' + encodeURIComponent(_sortV), 'o=' + encodeURIComponent(params.get('o') || 'd')); }
      if (_sV)    { _extra.push('s=' + encodeURIComponent(_sV)); }
      if (_hash)  { _extra.push('anchor=' + encodeURIComponent(_hash)); }
      if (_extra.length) _linkWithSort += '?' + _extra.join('&');
      showPageViewer(_linkWithSort, { pushState: false });
    }
    if (collEntry?.name) setPageMeta(collEntry.name + ' | Argument Aloud');
    trackPageView(location.href);
    return;
  }

  // Highlight: collection + id + highlight index
  if (collectionParam && idParam && highlightParam != null && !termParam && !caseParam && _anySectionLi) {
    const _sLi = await _openCollectionSection(collectionParam);
    const collLi = _sLi?.querySelector(
      `.term-group[data-collection-id="${CSS.escape(collectionParam)}"]`
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
        if (_parsedSort) groupLi._applySortParam?.(_parsedSort.mode, _parsedSort.asc);
        const hlEl = groupLi.querySelector(`.highlight-item[data-highlight-idx="${highlightParam}"]`);
        if (hlEl) {
          if (!isMobile()) requestAnimationFrame(() => hlEl.scrollIntoView({ behavior: 'instant', block: 'center' }));
          hlEl.querySelector('.case-title-nav')?.dispatchEvent(Object.assign(new MouseEvent('click', { cancelable: true }), { fromRestore: true }));
        }
      }
    }
    return;
  }

  // Group-only: collection + group/id but no specific case selected.
  if (collectionParam && (groupParam || idParam) && !termParam && !caseParam && _anySectionLi) {
    const _sLi = await _openCollectionSection(collectionParam);
    const collLi = _sLi?.querySelector(
      `.term-group[data-collection-id="${CSS.escape(collectionParam)}"]`
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
        if (_parsedSort) groupLi._applySortParam?.(_parsedSort.mode, _parsedSort.asc);
        const _groupNameText = groupLi.querySelector('.month-name')?.textContent;
        if (_groupNameText) setPageMeta(formatSpeakerFull(_groupNameText) + ' | Argument Aloud');
        trackPageView(location.href);
        if (linkParam) showPageViewer(linkParam, { pushState: false });
        else if (groupLi._groupPage && groupLi._groupDocument) showAdvocateDocument(groupLi._groupDocument, groupLi._groupPage, '');
        else if (groupLi._groupPage) showPageViewer(groupLi._groupPage, { pushState: false });
        else if (groupLi._groupDocument) showAdvocateDocument(groupLi._groupDocument, null, '');
        else if (groupLi._groupLink) await _loadCaseFromGroupLink(groupLi._groupLink);
        else {
          // The group itself has no page/document (e.g. a single-group collection
          // like Original Jurisdiction's "Archive") — fall back to the collection's
          // own page so the page-viewer isn't left blank. For Rarest Spoken Words,
          // point it at the matching word's <li id="rare-word-..."> so the page on
          // the right scrolls to (and highlights) the word selected on the left.
          const collEntry = _findAnyCollectionEntry(collectionParam);
          if (collEntry?.page) {
            const _pageUrl = collectionParam === 'rare_words' && _groupNameText
              ? collEntry.page + '#rare-word-' + encodeURIComponent(_groupNameText)
              : collEntry.page;
            showPageViewer(_pageUrl, { pushState: false });
          }
        }
        collLi._centerOnGroup?.(groupLi);
        requestAnimationFrame(() => groupLi.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
      }
    }
    return;
  }

  if (collectionParam && termParam && caseParam && _anySectionLi) {
    const _sLi = await _openCollectionSection(collectionParam);
    const collLi = _sLi?.querySelector(
      `.term-group[data-collection-id="${CSS.escape(collectionParam)}"]`
    );
    let _collCaseFocused = false;
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
          collLi._centerOnGroup?.(groupLi);
          groupLi.classList.add('open');
          await groupLi._ensureCases?.();
          groupLi._activateCount?.();
          if (_parsedSort) groupLi._applySortParam?.(_parsedSort.mode, _parsedSort.asc);
          _caseSearchRoot = groupLi;
        }
      } else if (groupParam) {
        const groupLi = collLi.querySelector(`.month-group[data-group-idx="${groupParam}"]`);
        if (groupLi) {
          collLi._centerOnGroup?.(groupLi);
          groupLi.classList.add('open');
          await groupLi._ensureCases?.();
          groupLi._activateCount?.();
          if (_parsedSort) groupLi._applySortParam?.(_parsedSort.mode, _parsedSort.asc);
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

      // Fetch the term's full case data — needed below regardless of whether a
      // DOM match was found yet, since a collection entry is only keyed by one
      // case's primary docket number (see _primaryCaseNumber in update_cases.js).
      const termCases = await fetchTermCases(termParam);
      const matchedCase = termCases.find(c => {
        if (c.id && c.id === caseParam) return true;
        if (!c.number) return false;
        return c.number === caseParam
          || c.number.split(',').map(n => n.trim()).includes(caseParam);
      });

      // Sibling-docket fallback: caseParam may name a *different* docket number
      // of a consolidated case whose own row in this collection is keyed by its
      // primary number instead (e.g. a "Consolidations" link to "No. 760" while
      // this collection only lists the case as "No. 759"). Re-resolve the DOM
      // match via the primary number and remember the requested one as an
      // override so the title/event still reflect it.
      let numberOverride = null;
      if (candidates.length === 0 && matchedCase?.number) {
        const _numbers = matchedCase.number.split(',').map(n => n.trim());
        if (_numbers.length > 1 && _numbers.includes(caseParam)) {
          numberOverride = caseParam;
          const primaryKey = CSS.escape(termParam + '/' + _numbers[0]);
          candidates = Array.from(_caseSearchRoot.querySelectorAll(`.case-item[data-case-key="${primaryKey}"]`));
        }
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
      let _defaultAudioIdx = audioParam;
      if (_defaultAudioIdx == null && numberOverride) {
        const _evIdx = _bestEventIndexForNumber(matchedCase.events, numberOverride);
        if (_evIdx >= 0) _defaultAudioIdx = _evIdx + 1;
      }
      if (ci) {
        _collCaseFocused = true;
        ci.closest('.month-group')?._centerOnItem?.(ci);
        markCaseItemActive(ci);
        ci.closest('.month-group')?.classList.add('open');
        if (!isMobile()) requestAnimationFrame(() => ci.scrollIntoView({ behavior: 'instant', block: 'center' }));
        const _hasAudio = matchedCase?.events?.some(a => a.audio_href);
        if ((fileParam != null || citationParam != null || turnParam != null) && _hasAudio) {
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
            if (fileParam != null && !_showDecisionFromParam(fileParam) && !_showJournalFromParam(fileParam) && !_showMinutesFromParam(fileParam) && !_showHistoryFromParam(fileParam)) {
              const fileEl = findFileItem(fileParam);
              if (fileEl) {
                fileEl.closest('.file-type-group')?.classList.add('open');
                requestAnimationFrame(() => fileEl.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
                fileEl.click();
              }
            }
            if (citationParam != null) {
              const citeEl = findCitationItem(citationParam);
              if (citeEl) {
                citeEl.closest('.file-type-group')?.classList.add('open');
                requestAnimationFrame(() => citeEl.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
                citeEl.querySelector('.citation-title')?.click();
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
          ...(_defaultAudioIdx != null ? { audioIdx: _defaultAudioIdx } : {}),
          ...(turnParam != null ? { initialTurn: turnParam } : {}),
          numberOverride,
          // Pass fileRestore/citationRestore so the title click handler can open
          // the file/citation directly for no-audio cases (where transcriptloaded never fires).
          fileRestore: (fileParam != null && !_hasAudio) ? String(fileParam) : null,
          citationRestore: (citationParam != null && !_hasAudio) ? citationParam : null,
        }));
      }
    }
    // For favorites/edits: if the case wasn't found, fall through to the plain
    // term+case handler so the case still loads.
    if (_collCaseFocused || (collectionParam !== 'favorites' && collectionParam !== 'edits')) return;
    // For favorites only: strip collection/group from the URL before falling through.
    if (collectionParam === 'favorites') {
      const _fbUrl = new URL(location.href);
      _fbUrl.searchParams.delete('collection');
      _fbUrl.searchParams.delete('group');
      history.replaceState(null, '', _fbUrl);
    }
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
      if (_parsedSort) termLi._applySortParam?.(_parsedSort.mode, _parsedSort.asc);
      else termLi._showSortLabel?.();
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
        const _hasAudio = matchedCase?.events?.some(a => a.audio_href);

        // When 'case' named one specific *secondary* docket number within a
        // consolidated case (not its primary/first number, which needs no
        // override), show that docket's own title, and — if a matching "No. N"
        // event exists — default to its best (aligned) event instead of the
        // first event overall.
        const _numbers = (matchedCase?.number || '').split(',').map(n => n.trim());
        const numberOverride = (_numbers.length > 1 && caseParam !== _numbers[0] && _numbers.includes(caseParam)) ? caseParam : null;
        let _defaultAudioIdx = audioParam;
        if (_defaultAudioIdx == null && numberOverride) {
          const _evIdx = _bestEventIndexForNumber(matchedCase.events, numberOverride);
          if (_evIdx >= 0) _defaultAudioIdx = _evIdx + 1;
        }
        if ((fileParam != null || citationParam != null || turnParam != null) && _hasAudio) {
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
            if (fileParam != null && !_showDecisionFromParam(fileParam) && !_showJournalFromParam(fileParam) && !_showMinutesFromParam(fileParam) && !_showHistoryFromParam(fileParam)) {
              const fileEl = findFileItem(fileParam);
              if (fileEl) {
                fileEl.closest('.file-type-group')?.classList.add('open');
                requestAnimationFrame(() => fileEl.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
                fileEl.click();
              }
            }
            if (citationParam != null) {
              const citeEl = findCitationItem(citationParam);
              if (citeEl) {
                citeEl.closest('.file-type-group')?.classList.add('open');
                requestAnimationFrame(() => citeEl.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
                citeEl.querySelector('.citation-title')?.click();
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
          audioIdx: _defaultAudioIdx ?? 0,
          fileRestore: (fileParam != null && !_hasAudio) ? String(fileParam) : null,
          citationRestore: (citationParam != null && !_hasAudio) ? citationParam : null,
          numberOverride,
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
    // Strip any sort params from the link before matching the nav item.
    const linkBase = linkParam.split('?')[0];
    const navItem = document.querySelector(`.case-item[data-link="${CSS.escape(linkBase)}"], .term-group[data-link="${CSS.escape(linkBase)}"]`);
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
      const _navItemName = navItem.querySelector('.term-label, .terms-label')?.textContent;
      if (_navItemName) setPageMeta(_navItemName + ' | Argument Aloud');
    }
    const _sortV = params.get('sort');
    const _sV    = params.get('s');
    const _extra = [];
    if (_sortV) { _extra.push('sort=' + encodeURIComponent(_sortV), 'o=' + encodeURIComponent(params.get('o') || 'd')); }
    if (_sV)    { _extra.push('s=' + encodeURIComponent(_sV)); }
    let _linkWithSort = _extra.length ? linkBase + '?' + _extra.join('&') : linkBase;
    // Forward the outer page's own #hash (e.g. #2018-04-23) onto the linked
    // page's URL so the iframe's native browser scroll-to-anchor lands on the
    // matching id inside it — the linked page itself has no use for the hash,
    // it's purely a pointer into content that lives inside the iframe.
    if (location.hash) _linkWithSort += location.hash;
    showPageViewer(_linkWithSort, { pushState: false });
  } else if (termParam === 'all') {
    const _termsSectionLi = _sectionLiById.get('term');
    if (_termsSectionLi) {
      _termsSectionLi.classList.add('open');
      requestAnimationFrame(() => _termsSectionLi.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
      const _termsName = _termsSectionLi.querySelector('.terms-label')?.textContent;
      if (_termsName) setPageMeta(_termsName + ' | Argument Aloud');
    }
    showPageViewer('/courts/ussc/terms/?term=all', { pushState: false });
  } else if (termParam) {
    // term-only URL: expand the term and load its case list, but don't select a case.
    const termLi = document.querySelector(`.term-group[data-term="${CSS.escape(termParam)}"]`);
    if (termLi) {
      const decLi = termLi.closest('.decade-group');
      decLi?.classList.add('open');
      termLi.closest('.terms-group')?.classList.add('open');
      termLi.classList.add('open');
      await termLi._ensureBuilt?.();
      if (_parsedSort) termLi._applySortParam?.(_parsedSort.mode, _parsedSort.asc);
      else termLi._showSortLabel?.();
      // Prefetch counts for sibling terms in the decade.
      if (decLi) {
        (async () => {
          const termEls = [...decLi.querySelectorAll('.term-group[data-term]')];
          for (const el of termEls) {
            await el._ensureCount?.();
          }
        })();
      }
      updateEmptyStateForTerm(termParam, dateParam);
      setTopbarTerm(termParam);
      setPageMeta(termDisplayName(termParam) + ' | Argument Aloud');
      trackPageView(location.href);
      requestAnimationFrame(() => termLi.scrollIntoView({ behavior: 'instant', block: 'nearest' }));
    }
  } else {
    // No URL params — show the page marked "default": true in index.json.
    showPageViewer(_defaultPage, { pushState: false });
  }
}

window.addEventListener('popstate', () => restoreFromURL());

// Handle navigation messages posted from pages running inside the page-viewer
// iframe (e.g., the stats page linking to a specific case).
window.addEventListener('message', async (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.type === 'ussc-navigate' && e.data.search) {
    const url = new URL(location.pathname + e.data.search, location.href);
    navigate(url);
    await restoreFromURL();
  } else if (e.data?.type === 'ussc-open-doc' && e.data.href) {
    showDocViewer({ href: e.data.href, title: e.data.title || '', view: e.data.view });
  } else if (e.data?.type === 'ussc-update-sort' && e.data.sort) {
    const newUrl = new URL(location.href);
    newUrl.hash = '';
    newUrl.searchParams.set('sort', e.data.sort);
    newUrl.searchParams.set('o', e.data.o || 'd');
    if (e.data.s) newUrl.searchParams.set('s', e.data.s);
    else          newUrl.searchParams.delete('s');
    history.replaceState(null, '', newUrl.toString());
  } else if (e.data?.type === 'ussc-scroll-collection-item' && e.data.collection && e.data.id) {
    _scrollSidebarToCollectionItem(e.data.collection, e.data.id);
  }
});

// ── Transcript edit mode ────────────────────────────────────────────────────

function _getEditedTurn(turnIdx) {
  return _transcriptEdits.get(_currentCaseKey)?.eventEdits.get(_currentTextHref)?.get(turnIdx) ?? null;
}

// Return (creating as needed) the Map<turnIdx, edit> for the transcript currently
// being viewed. Shared by _saveEditedTurn and _insertTurnAtCursor.
function _ensureEventEdits() {
  if (!_currentCaseKey || !_currentTextHref) return null;
  if (!_transcriptEdits.has(_currentCaseKey)) {
    _transcriptEdits.set(_currentCaseKey, {
      title: _caseDisplayTitle(_currentCaseEntry, _currentLoadedEntry),
      term: _currentCaseKey.split('/')[0],
      number: _currentCaseEntry?.number,
      id: _currentCaseEntry?.id,
      eventEdits: new Map()
    });
  }
  const caseData = _transcriptEdits.get(_currentCaseKey);
  if (!caseData.eventEdits.has(_currentTextHref)) {
    caseData.eventEdits.set(_currentTextHref, new Map());
  }
  return caseData.eventEdits.get(_currentTextHref);
}

function _saveEditedTurn(turnIdx, changes) {
  const eventEdits = _ensureEventEdits();
  if (!eventEdits) return;
  const caseData = _transcriptEdits.get(_currentCaseKey);

  const origTurn = turns[turnIdx];
  const existing = eventEdits.get(turnIdx) || {};
  const newName = changes.name !== undefined ? changes.name : (existing.name ?? origTurn.name);
  const newText = changes.text !== undefined ? changes.text : existing.text;

  const nameChanged = newName !== origTurn.name;
  const textChanged = newText !== undefined && newText !== origTurn.text;

  // A split-derived entry (see _insertTurnAtCursor) must survive even when
  // nothing further has changed: turns[] was deliberately mutated to already
  // match it, so "no change from turns[]" here just means the user hasn't
  // additionally edited this turn on top of the split, not that there's
  // nothing left to track (the insert/truncate/renumber itself still is).
  const isSplitDerived = !!(existing.isNewTurn || existing.splitTruncated || existing.renumbered);

  if (!nameChanged && !textChanged && !isSplitDerived) {
    eventEdits.delete(turnIdx);
  } else {
    eventEdits.set(turnIdx, {
      ...existing,
      turnNum: origTurn.turn ?? (turnIdx + 1),
      name: newName,
      text: newText,
      // A renumbered turn only needs prev/turn exported (bareRenumber) until
      // the user genuinely overrides its name/text beyond what the split
      // already carried forward.
      ...(existing.renumbered ? { bareRenumber: !nameChanged && !textChanged } : {}),
    });
  }

  if (!eventEdits.size) caseData.eventEdits.delete(_currentTextHref);
  if (!caseData.eventEdits.size) _transcriptEdits.delete(_currentCaseKey);
  _persistEditsToStorage();
}

function _removeEditedTurn(turnIdx) {
  if (!_currentCaseKey || !_currentTextHref) return;
  const caseData = _transcriptEdits.get(_currentCaseKey);
  if (!caseData) return;
  const eventEdits = caseData.eventEdits.get(_currentTextHref);
  if (!eventEdits) return;
  eventEdits.delete(turnIdx);
  if (!eventEdits.size) caseData.eventEdits.delete(_currentTextHref);
  if (!caseData.eventEdits.size) _transcriptEdits.delete(_currentCaseKey);
  _persistEditsToStorage();
}

// Split `el`'s text content at the caret and return { before, after }. Used by
// _insertTurnAtCursor. Falls back to "no selection" (whole text, nothing after)
// if the caret position can't be determined.
function _splitTextAtCursor(el) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return { before: el.textContent, after: '' };
  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.startContainer, range.startOffset);
  const before = preRange.toString();
  const after = el.textContent.slice(before.length);
  return { before, after };
}

// Split turn `idx` at the caret inside its contenteditable text element `tx`:
// the text before the caret stays on turn idx, and a brand-new turn — with
// speaker UNKNOWN SPEAKER — is inserted immediately after it holding the text
// from the caret onward. Every turn from idx+1 to the end of the transcript
// has its 1-based `turn` number bumped by one to stay sequential.
// All of it — the truncated turn, the new turn, and every renumbered turn
// after it — is marked modified, since all of it differs from the server's
// current transcript (even turns whose text/speaker didn't change now sit at
// a different turn number). A renumbered-only entry records both its new
// number (turnNum) and its true original number (prevTurnNum) — needed so
// update_transcripts.js can find the right turn in the untouched server
// transcript and renumber it there. If this same turn was already shifted by
// an earlier split in this session, prevTurnNum is carried forward from that
// entry rather than recomputed, so a chain of splits still traces back to the
// real original instead of an intermediate, locally-shifted number.
function _insertTurnAtCursor(idx, tx) {
  const { before, after } = _splitTextAtCursor(tx);
  const origTurn = turns[idx];
  const origTurnNum = origTurn.turn ?? (idx + 1);
  const effectiveName = _getEditedTurn(idx)?.name ?? origTurn.name;
  const eventEdits = _ensureEventEdits();

  // Snapshot each subsequent turn's "true original number" (old, pre-splice
  // indices) before any mutation below.
  const oldPrevNums = [];
  for (let i = idx + 1; i < turns.length; i++) {
    const existing = eventEdits?.get(i);
    oldPrevNums[i] = existing?.prevTurnNum ?? (turns[i].turn ?? (i + 1));
  }

  // Bump every subsequent turn's number by one. Walking backward lets this
  // happen in place, before the splice below shifts everyone's array index.
  for (let i = turns.length - 1; i > idx; i--) {
    turns[i].turn = (turns[i].turn ?? (i + 1)) + 1;
  }
  const newTurnNum = origTurnNum + 1;
  turns[idx].text = before;
  turns.splice(idx + 1, 0, { turn: newTurnNum, name: 'UNKNOWN SPEAKER', text: after, time: origTurn.time });
  if (Array.isArray(turnTimes)) turnTimes.splice(idx + 1, 0, turnTimes[idx]);

  // The speaker dropdown only lists names already present in this transcript —
  // add the sentinel so the new turn's dropdown can actually show it selected.
  if (!caseSpeakers.some(s => s.name === 'UNKNOWN SPEAKER')) {
    caseSpeakers.push({ name: 'UNKNOWN SPEAKER' });
  }

  if (eventEdits) {
    // Re-key existing local edits (Map<arrayIndex, edit>) so they stay attached
    // to the same turn object now that every index after idx moved up by one.
    const rekeyed = new Map();
    for (const [key, val] of eventEdits) rekeyed.set(key > idx ? key + 1 : key, val);
    eventEdits.clear();
    for (const [key, val] of rekeyed) eventEdits.set(key, val);

    // splitTruncated (like renumbered/isNewTurn below) marks an entry that
    // trivially matches the local, already-mutated turns[] array by
    // construction — it must not be pruned just because it "matches" here;
    // only downloadTranscriptEdits()'s round-trip check against the real
    // server transcript can tell whether it's actually been applied yet.
    eventEdits.set(idx, { turnNum: origTurnNum, name: effectiveName, text: before, splitTruncated: true });
    eventEdits.set(idx + 1, { turnNum: newTurnNum, name: 'UNKNOWN SPEAKER', text: after, time: origTurn.time, isNewTurn: true });
    // Everything from here on was at (new index - 1) before the splice, which
    // is how oldPrevNums (snapshotted pre-splice) is indexed.
    for (let i = idx + 2; i < turns.length; i++) {
      const existing = rekeyed.get(i);
      // name/text always reflect this turn's real current content (its
      // override if one exists, otherwise its untouched original content) —
      // needed so downloadTranscriptEdits() can confirm against the server
      // whether the shift has actually landed. bareRenumber records whether
      // that content is a genuine user override or just carried along for
      // that comparison, so _generateEditsJson() knows whether to actually
      // export name/text or leave them out per the "prev"/"turn"-only spec.
      eventEdits.set(i, {
        turnNum: turns[i].turn,
        prevTurnNum: oldPrevNums[i - 1],
        name: turns[i].name,
        text: turns[i].text,
        bareRenumber: existing?.name === undefined && existing?.text === undefined,
        renumbered: true,
      });
    }
    _persistEditsToStorage();
  }

  // The old tx is still focused at this point; clearing turnList fires a
  // native blur on it that must not be allowed to re-save stale full text
  // over the truncation above (see the blur handler and _suppressTurnBlurSave).
  _suppressTurnBlurSave = true;
  turnList.innerHTML = '';
  renderTranscript();
  _suppressTurnBlurSave = false;

  // Move focus to the start of the new turn's text.
  requestAnimationFrame(() => {
    const newTx = document.querySelector('#turn-' + (idx + 1) + ' .turn-text');
    if (!newTx) return;
    newTx.focus();
    const r = document.createRange();
    r.selectNodeContents(newTx);
    r.collapse(true);
    const wSel = window.getSelection();
    wSel.removeAllRanges();
    wSel.addRange(r);
    newTx.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// Remove stored edits for the current transcript that already match the server data.
function _pruneStaleEditsForCurrentTranscript() {
  if (!_currentCaseKey || !_currentTextHref) return;
  const caseData = _transcriptEdits.get(_currentCaseKey);
  if (!caseData) return;
  const eventEdits = caseData.eventEdits.get(_currentTextHref);
  if (!eventEdits) return;
  let changed = false;
  for (const [turnIdx, edit] of eventEdits) {
    const turn = turns[turnIdx];
    if (!turn) { eventEdits.delete(turnIdx); changed = true; continue; }
    // A renumbered, brand-new-turn, or split-truncated entry (see
    // _insertTurnAtCursor) always "matches" the in-memory turn it's attached
    // to, by construction — that's just how these entries get built, not a
    // sign they're stale. Never auto-prune them here; downloadTranscriptEdits()
    // does its own check against the real server transcript and will drop
    // them once actually applied.
    if (edit.renumbered || edit.isNewTurn || edit.splitTruncated) continue;
    const nameApplied = edit.name === turn.name;
    const textApplied = edit.text === undefined || edit.text === turn.text;
    if (nameApplied && textApplied) { eventEdits.delete(turnIdx); changed = true; }
  }
  if (!eventEdits.size) caseData.eventEdits.delete(_currentTextHref);
  if (!caseData.eventEdits.size) _transcriptEdits.delete(_currentCaseKey);
  if (changed) _persistEditsToStorage();
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
          .map(e => ({
            ...(e.prevTurnNum !== undefined ? { prev: e.prevTurnNum } : {}),
            turn: e.turnNum,
            // A bare renumber (no genuine name/text override) only needs
            // prev/turn — the shifted turn's content hasn't actually changed.
            ...(e.bareRenumber ? {} : {
              ...(e.name !== undefined ? { name: e.name } : {}),
              ...(e.text !== undefined ? { text: e.text } : {}),
            }),
            ...(e.time !== undefined ? { time: e.time } : {}),
          }))
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
  const endBtn    = document.getElementById('end-editing-btn');
  if (editBtn) { editBtn.hidden = _editMode; editBtn.disabled = turns.length === 0; }
  if (endBtn)  endBtn.hidden  = !_editMode;
}

let _editAlertShown = false;

function startEditTranscripts() {
  if (!_editAlertShown) {
    alert('Your edits are saved in your browser. Use "Download Edits" from the menu when you\'re ready to submit them.\n\nNote: You can use Shift+Enter to insert blank lines and Cmd+Enter to insert new turns.');
    _editAlertShown = true;
  }
  _editMode = true;
  _updateEditModeMenu();
  transcriptViewer.classList.add('edit-mode');
  turnList.innerHTML = '';
  renderTranscript();
}

function endEditTranscripts() {
  _editMode = false;
  _updateEditModeMenu();
  transcriptViewer.classList.remove('edit-mode');
  turnList.innerHTML = '';
  renderTranscript();
}

async function downloadTranscriptEdits() {
  if (_editMode) {
    _editMode = false;
    _updateEditModeMenu();
    transcriptViewer.classList.remove('edit-mode');
  }

  // Validate each stored edit against the current server transcript.
  // Remove any that have already been applied on the server.
  for (const [caseKey, caseData] of _transcriptEdits) {
    const term = caseData.term;
    for (const [textHref, turnEdits] of caseData.eventEdits) {
      let serverTurns;
      try {
        const resp = await fetch(`/courts/ussc/terms/${term}/cases/${textHref}`);
        if (!resp.ok) continue;
        const data = await resp.json();
        serverTurns = Array.isArray(data) ? data : (data.turns ?? []);
      } catch { continue; }

      for (const [turnIdx, edit] of turnEdits) {
        // edit.name/edit.text always reflect this turn's real expected
        // content (see _insertTurnAtCursor), even for a bare renumber with
        // nothing exported for those fields — so comparing them against the
        // server's actual turn content reliably detects whether the shift
        // has landed, without risking a false match against an unrelated,
        // still-unshifted turn that happens to share the new number.
        const serverTurn = serverTurns.find((t, i) => (t.turn ?? (i + 1)) === edit.turnNum);
        if (!serverTurn) continue;
        const nameApplied = edit.name === undefined || edit.name === serverTurn.name;
        const textApplied = edit.text === undefined || edit.text === serverTurn.text;
        if (nameApplied && textApplied) turnEdits.delete(turnIdx);
      }
      if (!turnEdits.size) caseData.eventEdits.delete(textHref);
    }
    if (!caseData.eventEdits.size) _transcriptEdits.delete(caseKey);
  }
  _persistEditsToStorage();

  // Re-render in case we just pruned edits for the currently visible transcript.
  turnList.innerHTML = '';
  renderTranscript();

  const edits = _generateEditsJson();
  if (!edits.length) {
    alert('All transcript edits have already been applied to the server.');
    return;
  }

  const blob = new Blob([JSON.stringify(edits, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'ussc-edits.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  // Edits remain in local storage — they persist until applied on the server.
  alert('Note: Send the downloaded edits to admin@argumentaloud.org for processing. Thank you for taking the time to make these corrections.');
}

async function _filterBuiltinTagsForExport(tagData) {
  // Group case keys by term so we fetch each cases.json once.
  const byTerm = {};
  for (const key of Object.keys(tagData)) {
    const [, term, number] = key.split(':');
    if (!byTerm[term]) byTerm[term] = [];
    byTerm[term].push({ key, number });
  }

  // Fetch all relevant cases.json files in parallel.
  const builtinMap = {};
  await Promise.all(Object.entries(byTerm).map(async ([term, entries]) => {
    try {
      const resp = await fetch(`/courts/ussc/terms/${term}/cases.json`);
      if (!resp.ok) return;
      const cases = await resp.json();
      for (const { key, number } of entries) {
        const c = cases.find(c => (c.number || c.id || '') === number);
        if (c?.tags) builtinMap[key] = Array.isArray(c.tags) ? c.tags : [String(c.tags)];
      }
    } catch { /* ignore network errors — keep all user tags for that term */ }
  }));

  // Strip any user tag that already exists as a built-in tag on the server.
  const filtered = {};
  for (const [key, userTags] of Object.entries(tagData)) {
    const builtin = builtinMap[key] || [];
    const toExport = userTags.filter(t => !builtin.includes(t));
    if (toExport.length) filtered[key] = toExport;
  }
  return _sortedTagData(filtered);
}

async function saveFavorites() {
  const favData = _getFavData();
  const tagData = await _filterBuiltinTagsForExport(_getTagData());
  const hasItems  = favData.items.length > 0;
  const hasGroups = favData.groups.some(g => g.id !== 'unfiled');
  const hasTags   = Object.keys(tagData).length > 0;
  if (!hasItems && !hasGroups && !hasTags) {
    alert('No favorites or tags to save.');
    return;
  }
  const bundle = { favorites: favData, tags: tagData };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'ussc-favorites.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function restoreFavorites() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        let favData, tagData;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.favorites) {
          // Bundled format: { favorites: {...}, tags: {...} }
          favData = parsed.favorites;
          tagData = (parsed.tags && typeof parsed.tags === 'object' && !Array.isArray(parsed.tags))
            ? parsed.tags : {};
        } else if (Array.isArray(parsed)) {
          // Accept v1 plain array
          favData = { groups: [{ id: 'unfiled', name: 'Unfiled' }], items: parsed.map(f => ({ ...f, groupId: 'unfiled' })) };
          tagData = {};
        } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
          favData = parsed;
          tagData = {};
        } else {
          alert('Invalid favorites file.');
          return;
        }
        if (!favData.groups?.some(g => g.id === 'unfiled')) {
          favData.groups = [{ id: 'unfiled', name: 'Unfiled' }, ...(favData.groups || [])];
        }
        _setFavData(favData);
        _setTagData(tagData);
        _activeFavGroupId = 'unfiled';
        _favoritesItemsBuilt = false;
        _refreshFavoritesNav();
        _updateFavoriteBtn();
        _updateTagsBtn();
      } catch {
        alert('Could not read favorites file.');
      }
    };
    reader.readAsText(file);
  });
  document.body.appendChild(input); input.click(); document.body.removeChild(input);
}

function clearFavorites() {
  if (!confirm('This will erase all your local favorites (including any custom tags). Are you sure?')) return;
  localStorage.removeItem(_LS_FAVORITES_KEY);
  localStorage.removeItem(_LS_TAGS_KEY);
  window.location.href = '/';
}

function clearTranscriptEdits() {
  if (!confirm('This will erase all your local transcript edits. Are you sure?')) return;
  localStorage.removeItem(_LS_EDITS_KEY);
  window.location.href = '/';
}

window._startEditTranscripts    = startEditTranscripts;
window._endEditTranscripts      = endEditTranscripts;
window._downloadTranscriptEdits = downloadTranscriptEdits;
window._clearTranscriptEdits    = clearTranscriptEdits;
window._saveFavorites           = saveFavorites;
window._restoreFavorites        = restoreFavorites;
window._clearFavorites          = clearFavorites;

_loadEditsFromStorage();
_updateEditModeMenu();
init();
